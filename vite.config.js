import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createReadStream, createWriteStream, constants as fsConstants, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import {
  DEFAULT_MEDIA_BATCH_CHUNK_SIZE,
  chunkMediaBatchJobs,
  generateImageMedia,
  generateVideoMedia,
  getGenerationCapabilities,
  getHermesStatus,
  normalizeMediaBatchColumns,
  normalizeMediaBatchConcurrency,
  runWithConcurrency
} from './lib/mediaGeneration.mjs'
import { getBuzzAssistAuthStatus, loginBuzzAssistViaBrowser, resolveAuthFilePath } from './lib/buzzassistApi.mjs'
import { FOCUS_REQUEST_FILE_NAME, OFFICIAL_EXCALIDRAW_README, createExcalidrawView, insertExcalidrawImage, insertExcalidrawSilenceCutResult, insertExcalidrawSubtitle, insertExcalidrawVideo, insertExcalidrawMediaBatch, performCanvasMaintenance, stripAssetBackedFileDataURLs, syncDeletedCanvasAssets, syncMissingCanvasAssets } from './lib/canvasScene.mjs'
import { streamZipStore } from './lib/zipStore.mjs'
import { generateSubtitleSrt, refineSubtitleFromPlan, writeSubtitleWordsSidecar } from './lib/subtitleGeneration.mjs'
import { silenceCutVideo } from './lib/tempoCut.mjs'
import {
  getLovartAuthStatus,
  getLovartModelCosts,
  queryLovartGenerationMode,
  saveLovartCredentials,
  setLovartGenerationPreference
} from './lib/lovartMediaGeneration.mjs'
import { bridgeWorkerAlive, canDriveGui, runOsascript, runPowershell, sendChatMessage } from './lib/chatBridge.mjs'
import { CANVAS_SERVER_PROTOCOL_VERSION, getOrCreateMcpToken, rejectDisallowedOrigin, rejectRemoteOperator, rejectMissingBearer, setLocalCorsHeaders, writeServerDiscovery } from './lib/canvasServerRuntime.mjs'
import { canvasAttachmentBundleToMcpResult, createCanvasAttachmentBundle, listCanvasAttachmentBundles, readCanvasAttachmentBundle } from './lib/canvasAttachmentBundle.mjs'
import { openLocalFolder } from './lib/openLocalFolder.mjs'
import { mergeLocalCanvasScenes } from './lib/localCanvasSceneMerge.mjs'
import { homedir, tmpdir } from 'node:os'

const projectDir = resolve(process.env.EXCALIDRAW_PROJECT_DIR ?? process.cwd())
const canvasDir = resolve(process.env.EXCALIDRAW_CANVAS_DIR ?? join(projectDir, 'canvas'))
const canvasFile = join(canvasDir, 'excalidraw-canvas.json')
const selectionFile = join(canvasDir, 'excalidraw-selection.json')
const focusRequestFile = join(canvasDir, FOCUS_REQUEST_FILE_NAME)
const viewStateFile = join(canvasDir, 'excalidraw-view-state.json')
const canvasAssetsDir = join(canvasDir, 'assets')
const canvasAssetsRoute = '/excalidraw-assets/'
const defaultPort = Number(process.env.PORT ?? process.env.EXCALIDRAW_PORT ?? 43219)
const defaultHost = process.env.EXCALIDRAW_HOST || '127.0.0.1'
const mcpToken = getOrCreateMcpToken()
const widgetBuild = /^(1|true|yes)$/i.test(String(process.env.BUZZASSIST_WIDGET_BUILD || ''))

const mimeTypes = new Map([
  ['.apng', 'image/apng'],
  ['.avif', 'image/avif'],
  ['.gif', 'image/gif'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.m4v', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.aac', 'audio/aac'],
  ['.flac', 'audio/flac'],
  ['.m4a', 'audio/mp4'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
  ['.opus', 'audio/opus'],
  ['.wav', 'audio/wav'],
  ['.xml', 'application/xml'],
  ['.srt', 'application/x-subrip'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.markdown', 'text/markdown; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8']
])

const canvasEventClients = new Set()
let canvasEventVersion = 0
const jsonWriteQueues = new Map()

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(payload))
}

function wantsAsyncGeneration(req, body = {}) {
  const prefer = String(req.headers.prefer || '').toLowerCase()
  return prefer.includes('respond-async') || body.async === true || body.respondAsync === true
}

function createGenerationJobId(kind) {
  return `${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function runBackgroundGeneration(jobId, task) {
  Promise.resolve()
    .then(task)
    .catch((error) => {
      console.error(`[canvas generation job ${jobId}] ${error?.stack || error?.message || error}`)
    })
}

function readRequestBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 200 * 1024 * 1024) {
        rejectBody(new Error('Excalidraw payload is too large.'))
        req.destroy()
      }
    })
    req.on('end', () => resolveBody(body))
    req.on('error', rejectBody)
  })
}

function isSafeChildPath(parent, child) {
  const pathToChild = relative(parent, child)
  return pathToChild && !pathToChild.startsWith('..') && !pathToChild.includes(`..${sep}`)
}

function sanitizeAssetFileName(name, fallbackName = 'asset.bin') {
  const fallback = basename(String(fallbackName || 'asset.bin')) || 'asset.bin'
  const rawName = basename(String(name || fallback))
    .normalize('NFC')
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  if (!rawName || rawName === '.' || rawName === '..') return fallback
  return rawName
}

async function resolveAvailableCanvasAssetPath(requestedName, options = {}) {
  const safeName = sanitizeAssetFileName(requestedName)
  const sourcePath = options.sourcePath ? resolve(String(options.sourcePath)) : ''
  const directPath = resolve(canvasAssetsDir, safeName)
  if (sourcePath && directPath === sourcePath && isSafeChildPath(canvasAssetsDir, directPath)) {
    return { fileName: safeName, filePath: directPath }
  }

  const ext = extname(safeName)
  const base = safeName.slice(0, safeName.length - ext.length)
  let candidate = safeName
  let counter = 1
  while (true) {
    const filePath = resolve(canvasAssetsDir, candidate)
    if (!isSafeChildPath(canvasAssetsDir, filePath)) {
      throw new Error(`Unsafe asset filename: ${candidate}`)
    }
    try {
      await stat(filePath)
      candidate = `${base} (${counter})${ext}`
      counter += 1
    } catch (error) {
      if (error?.code === 'ENOENT') return { fileName: candidate, filePath }
      throw error
    }
  }
}

function isScene(value) {
  return value && typeof value === 'object' && Array.isArray(value.elements)
}

function isAssetBackedFileRecord(file) {
  return (
    (typeof file?.dataURL === 'string' && file.dataURL.startsWith(canvasAssetsRoute)) ||
    (file?.codexAssetBacked === true &&
      typeof file?.codexAssetUrl === 'string' &&
      file.codexAssetUrl.startsWith(canvasAssetsRoute))
  )
}

function restoreAssetBackedImageStatuses(elements, files) {
  if (!Array.isArray(elements) || !files || typeof files !== 'object') return elements
  const fileIds = new Set(
    Object.entries(files)
      .filter(([, file]) => isAssetBackedFileRecord(file))
      .map(([id]) => id)
  )
  if (fileIds.size === 0) return elements
  let changed = false
  const next = elements.map((element) => {
    if (
      element?.type !== 'image' ||
      element.status !== 'error' ||
      !fileIds.has(element.fileId) ||
      element.customData?.codexMediaKind === 'video'
    ) {
      return element
    }
    changed = true
    return { ...element, status: 'saved' }
  })
  return changed ? next : elements
}

function compactCanvasAssetValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  let changed = false
  const next = { ...value }
  const url = typeof next.url === 'string' ? next.url : ''
  const path = typeof next.path === 'string' ? next.path : ''
  const fallback = url || path || ''
  if (typeof next.dataURL === 'string' && next.dataURL.startsWith('data:') && fallback) {
    next.dataURL = ''
    changed = true
  }
  if (typeof next.thumbnail === 'string' && next.thumbnail.startsWith('data:') && fallback) {
    next.thumbnail = fallback
    changed = true
  }
  return changed ? next : value
}

function compactCanvasCustomData(value) {
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item) => {
      const compacted = compactCanvasCustomData(item)
      if (compacted !== item) changed = true
      return compacted
    })
    return changed ? next : value
  }
  if (!value || typeof value !== 'object') return value

  const compactedAsset = compactCanvasAssetValue(value)
  if (compactedAsset !== value) return compactedAsset

  let changed = false
  const next = { ...value }
  for (const [key, item] of Object.entries(value)) {
    const compacted = compactCanvasCustomData(item)
    if (compacted !== item) {
      next[key] = compacted
      changed = true
    }
  }
  return changed ? next : value
}

function compactSceneElements(elements) {
  if (!Array.isArray(elements)) return elements
  let changed = false
  const next = elements.map((element) => {
    if (!element?.customData || typeof element.customData !== 'object') return element
    const customData = compactCanvasCustomData(element.customData)
    if (customData === element.customData) return element
    changed = true
    return { ...element, customData }
  })
  return changed ? next : elements
}

function normalizeScene(value) {
  if (!isScene(value)) {
    return {
      type: 'excalidraw',
      version: 2,
      source: 'codex-excalidraw-canvas',
      elements: [],
      appState: {
        viewBackgroundColor: '#ffffff'
      },
      files: {}
    }
  }

  const files = value.files && typeof value.files === 'object' ? value.files : {}
  return {
    type: value.type ?? 'excalidraw',
    version: value.version ?? 2,
    source: value.source ?? 'codex-excalidraw-canvas',
    elements: compactSceneElements(restoreAssetBackedImageStatuses(value.elements, files)),
    appState: value.appState && typeof value.appState === 'object' ? value.appState : {},
    files
  }
}

function isSelectionState(value) {
  return value && typeof value === 'object' && Array.isArray(value.selectedElements)
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function isViewState(value) {
  return (
    value &&
    typeof value === 'object' &&
    value.version === 1 &&
    isFiniteNumber(value.scrollX) &&
    isFiniteNumber(value.scrollY) &&
    value.zoom &&
    typeof value.zoom === 'object' &&
    isFiniteNumber(value.zoom.value)
  )
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function writeJsonAtomic(filePath, payload) {
  const previous = jsonWriteQueues.get(filePath) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(async () => {
      await mkdir(dirname(filePath), { recursive: true })
      const tempFile = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
      await writeFile(tempFile, `${JSON.stringify(payload, null, 2)}\n`)
      await rename(tempFile, filePath)
    })
  jsonWriteQueues.set(filePath, next)
  try {
    await next
  } finally {
    if (jsonWriteQueues.get(filePath) === next) {
      jsonWriteQueues.delete(filePath)
    }
  }
}

// Mirror of the client's sceneFingerprint (src/App.jsx): broadcasting it with
// canvas-changed lets a client recognize the echo of its own save WITHOUT
// re-downloading and re-parsing the whole scene JSON.
function sceneContentFingerprint(scene) {
  if (!scene || !Array.isArray(scene.elements)) return ''
  const els = scene.elements
    .map((e) => `${e.id}:${e.version ?? 0}:${e.versionNonce ?? 0}:${e.isDeleted ? 1 : 0}`)
    .sort()
    .join('|')
  const files = Object.entries(scene.files ?? {})
    .map(([id, file]) => `${id}:${(file?.dataURL ?? '').length}`)
    .sort()
    .join(',')
  return `${els}#${files}`
}

function broadcastCanvasChanged(paths, options = {}) {
  const payload = {
    version: ++canvasEventVersion,
    updatedAt: new Date().toISOString(),
    paths,
    ...(typeof options.fingerprint === 'string' && options.fingerprint ? { fingerprint: options.fingerprint } : {}),
    ...(Array.isArray(options.focusElementIds) && options.focusElementIds.length > 0
      ? { focusElementIds: options.focusElementIds }
      : {}),
    ...(options.applySelection === true ? { applySelection: true } : {}),
    ...(options.applyViewport === true ? { applyViewport: true } : {})
  }

  for (const client of canvasEventClients) {
    if (client.destroyed) {
      canvasEventClients.delete(client)
      continue
    }

    try {
      client.write('event: canvas-changed\n')
      client.write(`id: ${payload.version}\n`)
      client.write(`data: ${JSON.stringify(payload)}\n\n`)
    } catch {
      canvasEventClients.delete(client)
    }
  }
}

async function consumeCanvasFocusRequest() {
  try {
    const request = await readJsonFile(focusRequestFile)
    await rm(focusRequestFile, { force: true })
    const elementIds = [...new Set((Array.isArray(request?.elementIds) ? request.elementIds : [])
      .filter((id) => typeof id === 'string' && id))]
    if (elementIds.length === 0) return null
    if (!Number.isFinite(request?.createdAt) || Date.now() - request.createdAt > 30000) return null
    return {
      focusElementIds: elementIds,
      applySelection: request.applySelection !== false,
      applyViewport: request.applyViewport !== false
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    console.warn('[canvas-focus] Failed to consume focus request:', error?.message || error)
    return null
  }
}

function localAssetFilePathFromUrl(pathname) {
  if (!pathname.startsWith(canvasAssetsRoute)) return null
  const requestedPath = decodeURIComponent(pathname.slice(canvasAssetsRoute.length))
  const filePath = resolve(canvasAssetsDir, requestedPath)
  return isSafeChildPath(canvasAssetsDir, filePath) ? filePath : null
}

function resolveClientAssetPath(item) {
  if (item && typeof item === 'object' && typeof item.path === 'string' && item.path) {
    const directPath = resolve(item.path)
    if (isSafeChildPath(canvasAssetsDir, directPath)) return directPath
  }
  const rawUrl = item && typeof item === 'object' ? (item.url || item.assetUrl) : item
  if (!rawUrl) return null
  try {
    return localAssetFilePathFromUrl(new URL(String(rawUrl), 'http://127.0.0.1').pathname)
  } catch {
    return null
  }
}

async function resolveClientAssetPaths(items = []) {
  const seen = new Set()
  const paths = []
  for (const item of items) {
    const filePath = resolveClientAssetPath(item)
    if (!filePath || seen.has(filePath)) continue
    seen.add(filePath)
    await stat(filePath)
    paths.push(filePath)
  }
  return paths
}

function appleScriptString(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function runJxa(script, timeoutMs = 10_000, env = {}) {
  return new Promise((resolveJxa) => {
    const child = spawn('osascript', ['-l', 'JavaScript'], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveJxa(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, stdout, error: 'macOSクリップボード操作が応答しません。' })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => finish({ ok: false, stdout, error: error.message }))
    child.on('close', (code) => finish(code === 0 ? { ok: true, stdout: stdout.trim() } : { ok: false, stdout, error: stderr.trim() }))
    child.stdin.end(script)
  })
}

async function copyTextToSystemClipboard(text = '') {
  const value = String(text ?? '')
  if (!value) throw new Error('コピーするテキストがありません。')
  if (process.platform === 'darwin') {
    const encodedText = Buffer.from(value, 'utf8').toString('base64')
    const jxaScript = `
ObjC.import('AppKit')
ObjC.import('Foundation')
const env = $.NSProcessInfo.processInfo.environment
const encoded = ObjC.unwrap(env.objectForKey('BUZZASSIST_CLIPBOARD_TEXT_B64')) || ''
const data = $.NSData.alloc.initWithBase64EncodedStringOptions(encoded, 0)
if (!data) throw new Error('Invalid clipboard text payload.')
const text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)
const pasteboard = $.NSPasteboard.generalPasteboard
pasteboard.clearContents
const ok = pasteboard.setStringForType(text, $.NSPasteboardTypeString)
if (!ok) throw new Error('NSPasteboard.setStringForType returned false.')
'ok'
`
    const jxa = await runJxa(jxaScript, 8000, { BUZZASSIST_CLIPBOARD_TEXT_B64: encodedText })
    if (jxa.ok) return { platform: 'darwin', mode: 'nspasteboard' }
    const fallback = await runOsascript(`set the clipboard to ${appleScriptString(value)}`, 5000)
    if (!fallback.ok) throw new Error(jxa.error || fallback.error || 'macOSクリップボードへテキストをコピーできませんでした。')
    return { platform: 'darwin', mode: 'osascript' }
  }
  if (process.platform === 'win32') {
    const encodedText = Buffer.from(value, 'utf8').toString('base64')
    const script = `
$ErrorActionPreference = 'Stop'
$message = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:BUZZASSIST_CLIPBOARD_TEXT_B64))
Set-Clipboard -Value $message
`
    const result = await runPowershell(script, 8000, { BUZZASSIST_CLIPBOARD_TEXT_B64: encodedText })
    if (!result.ok) throw new Error(result.error || 'Windowsクリップボードへテキストをコピーできませんでした。')
    return { platform: 'win32', mode: 'set-clipboard' }
  }
  throw new Error('このOSではテキストのOSクリップボードコピーに未対応です。')
}

async function copyFilesToSystemClipboard(filePaths = []) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new Error('コピーできるファイルがありません。')
  }
  if (process.platform === 'darwin') {
    const encodedPaths = Buffer.from(JSON.stringify(filePaths), 'utf8').toString('base64')
    const jxaScript = `
ObjC.import('AppKit')
ObjC.import('Foundation')
const env = $.NSProcessInfo.processInfo.environment
const encoded = ObjC.unwrap(env.objectForKey('BUZZASSIST_CLIPBOARD_FILES_B64')) || ''
const data = $.NSData.alloc.initWithBase64EncodedStringOptions(encoded, 0)
if (!data) throw new Error('Invalid clipboard file payload.')
const json = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)
const paths = JSON.parse(ObjC.unwrap(json))
const urls = $.NSMutableArray.array
for (const path of paths) urls.addObject($.NSURL.fileURLWithPath(path))
const pasteboard = $.NSPasteboard.generalPasteboard
pasteboard.clearContents
const ok = pasteboard.writeObjects(urls)
pasteboard.setPropertyListForType(paths, 'NSFilenamesPboardType')
if (!ok) throw new Error('NSPasteboard.writeObjects returned false.')
'ok'
`
    const jxa = await runJxa(jxaScript, 10_000, { BUZZASSIST_CLIPBOARD_FILES_B64: encodedPaths })
    if (jxa.ok) return { platform: 'darwin', mode: 'nspasteboard' }

    // Fallback for older/macOS-restricted hosts. This writes aliases, which is
    // enough for Finder-like targets but less reliable in Electron chat inputs.
    const script = [
      'set theItems to {}',
      ...filePaths.map((filePath) => `set end of theItems to (POSIX file ${appleScriptString(filePath)} as alias)`),
      'set the clipboard to theItems'
    ].join('\n')
    const result = await runOsascript(script, 8000)
    if (!result.ok) throw new Error(jxa.error || result.error || 'macOSクリップボードへファイルをコピーできませんでした。')
    return { platform: 'darwin', mode: 'alias-fallback' }
  }
  if (process.platform === 'win32') {
    const encodedPaths = Buffer.from(JSON.stringify(filePaths), 'utf8').toString('base64')
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:BUZZASSIST_CLIPBOARD_FILES_B64))
$paths = ConvertFrom-Json $json
$list = New-Object System.Collections.Specialized.StringCollection
foreach ($path in $paths) {
  [void]$list.Add([string]$path)
}
[System.Windows.Forms.Clipboard]::SetFileDropList($list)
`
    const result = await runPowershell(script, 8000, { BUZZASSIST_CLIPBOARD_FILES_B64: encodedPaths })
    if (!result.ok) throw new Error(result.error || 'Windowsクリップボードへファイルをコピーできませんでした。')
    return { platform: 'win32' }
  }
  throw new Error('このOSではファイルの実体コピーに未対応です。')
}

// runPowershell in lib/chatBridge.mjs discards stdout; the save dialog below
// needs the chosen path back, so this local variant captures it.
function runPowershellCapture(script, timeoutMs = 10_000, env = {}) {
  return new Promise((resolvePs) => {
    const child = spawn('powershell.exe', ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      env: { ...process.env, ...env }
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePs(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, stdout, error: 'Windowsのダイアログが応答しません。' })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => finish({ ok: false, stdout, error: error.message }))
    child.on('close', (code) => finish(code === 0 ? { ok: true, stdout: stdout.trim() } : { ok: false, stdout, error: stderr.trim() }))
  })
}

let saveDialogOpen = false

// Cached server-verified BuzzAssist auth status (see /api/buzzassist/auth-status).
let buzzAssistStatusCacheRef = { key: '', at: 0, status: null }

// Native OS save panel with the Downloads folder as the default location.
// The in-app browser's showSaveFilePicker ignores the web startIn hint, so
// the dev server owns the dialog instead. Returns the chosen destination
// path, or null when the user cancels. OSes without a panel save straight
// into Downloads.
async function chooseSaveDestination(fileName) {
  const defaultDir = join(homedir(), 'Downloads')
  await mkdir(defaultDir, { recursive: true })
  if (process.platform === 'darwin') {
    // NSSavePanel directly (not chooseFileName): extensionHidden=false keeps
    // the full "name.png" visible in the Save As field regardless of the
    // Finder "hide extensions" preference.
    const jxaScript = `
ObjC.import('Foundation')
ObjC.import('AppKit')
const env = $.NSProcessInfo.processInfo.environment
const defaultDir = ObjC.unwrap(env.objectForKey('BUZZASSIST_SAVE_DEFAULT_DIR')) || ''
const defaultName = ObjC.unwrap(env.objectForKey('BUZZASSIST_SAVE_DEFAULT_NAME')) || 'download'
const app = Application.currentApplication()
app.includeStandardAdditions = true
app.activate()
const panel = $.NSSavePanel.savePanel
panel.title = '保存'
panel.nameFieldStringValue = $(defaultName)
panel.directoryURL = $.NSURL.fileURLWithPath($(defaultDir))
panel.extensionHidden = false
panel.canCreateDirectories = true
const response = panel.runModal
response == 1 ? ObjC.unwrap(panel.URL.path) : '__CANCELLED__'
`
    const result = await runJxa(jxaScript, 300_000, {
      BUZZASSIST_SAVE_DEFAULT_DIR: defaultDir,
      BUZZASSIST_SAVE_DEFAULT_NAME: fileName
    })
    if (result.ok) {
      const chosen = String(result.stdout || '').trim()
      if (!chosen || chosen === '__CANCELLED__') return null
      return chosen
    }
    if (/user cancell?ed|-128/i.test(String(result.error || ''))) return null
    throw new Error(result.error || '保存ダイアログの表示に失敗しました。')
  }
  if (process.platform === 'win32') {
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.InitialDirectory = $env:BUZZASSIST_SAVE_DEFAULT_DIR
$dialog.FileName = $env:BUZZASSIST_SAVE_DEFAULT_NAME
$dialog.DefaultExt = $env:BUZZASSIST_SAVE_DEFAULT_EXT
$dialog.AddExtension = $true
$dialog.OverwritePrompt = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.WriteLine($dialog.FileName)
} else {
  [Console]::Out.WriteLine('__CANCELLED__')
}
`
    const result = await runPowershellCapture(script, 300_000, {
      BUZZASSIST_SAVE_DEFAULT_DIR: defaultDir,
      BUZZASSIST_SAVE_DEFAULT_NAME: fileName,
      BUZZASSIST_SAVE_DEFAULT_EXT: extname(fileName).replace(/^\./, '')
    })
    if (!result.ok) throw new Error(result.error || '保存ダイアログの表示に失敗しました。')
    const chosen = result.stdout.trim()
    if (!chosen || chosen === '__CANCELLED__') return null
    return chosen
  }
  return join(defaultDir, fileName)
}

// Downscalable canvas bitmaps: multi-MB originals are fine on localhost but
// choke phones over the tunnel, so ?w=<px> serves an ffmpeg-scaled preview
// cached under canvas/.asset-previews (keyed by name+width+mtime).
const PREVIEWABLE_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const assetPreviewJobs = new Map()

function parsePreviewWidth(url) {
  const raw = Number(url.searchParams.get('w'))
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return Math.max(320, Math.min(3200, Math.round(raw)))
}

async function resolveAssetPreview(filePath, fileStat, width) {
  if (!PREVIEWABLE_IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase())) return null
  // Tiny files gain nothing from rescaling.
  if (fileStat.size <= 256 * 1024) return null
  const previewsDir = join(canvasDir, '.asset-previews')
  // WebP: ~10x smaller than PNG for photographic content, keeps alpha.
  const key = `${basename(filePath)}.${width}.${Math.round(fileStat.mtimeMs)}.webp`
  const previewPath = join(previewsDir, key)
  const useIfSmaller = async (candidatePath) => {
    try {
      const previewStat = await stat(candidatePath)
      if (previewStat.isFile() && previewStat.size > 0 && previewStat.size < fileStat.size) return candidatePath
    } catch {}
    return null
  }
  const cached = await useIfSmaller(previewPath)
  if (cached) return cached
  // Deduplicate concurrent generation of the same preview.
  const jobKey = previewPath
  if (!assetPreviewJobs.has(jobKey)) {
    assetPreviewJobs.set(jobKey, (async () => {
      await mkdir(previewsDir, { recursive: true })
      const tmpPath = `${previewPath}.tmp.webp`
      await new Promise((resolvePreview, rejectPreview) => {
        const child = spawn('ffmpeg', [
          '-y', '-v', 'error',
          '-i', filePath,
          '-vf', `scale='min(${width},iw)':-2`,
          '-c:v', 'libwebp', '-quality', '82',
          tmpPath,
        ])
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          rejectPreview(new Error('preview generation timed out'))
        }, 20_000)
        child.on('error', (error) => { clearTimeout(timer); rejectPreview(error) })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (code === 0) resolvePreview()
          else rejectPreview(new Error(`ffmpeg exited with ${code}`))
        })
      })
      await rename(tmpPath, previewPath)
      return previewPath
    })().finally(() => assetPreviewJobs.delete(jobKey)))
  }
  try {
    await assetPreviewJobs.get(jobKey)
    // Serve the preview only when it actually beats the original.
    return await useIfSmaller(previewPath)
  } catch {
    return null // fall back to the original on any generation failure
  }
}

async function serveCanvasAsset(req, res, next) {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (!url.pathname.startsWith(canvasAssetsRoute)) {
    next()
    return
  }

  const filePath = localAssetFilePathFromUrl(url.pathname)
  if (!filePath) {
    res.statusCode = 403
    res.end('Forbidden')
    return
  }

  try {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) {
      res.statusCode = 404
      res.end('Not found')
      return
    }
    const previewWidth = parsePreviewWidth(url)
    let servePath = filePath
    let serveStat = fileStat
    let servedPreview = false
    if (previewWidth && !url.searchParams.get('download')) {
      const previewPath = await resolveAssetPreview(filePath, fileStat, previewWidth)
      if (previewPath) {
        servePath = previewPath
        serveStat = await stat(previewPath)
        servedPreview = true
      }
    }
    const contentType = mimeTypes.get(extname(servePath).toLowerCase()) ?? 'application/octet-stream'
    res.setHeader('content-type', contentType)
    // Range support is required for iOS Safari to play <video> at all, and lets
    // browsers seek/stream instead of downloading the whole file up front.
    res.setHeader('accept-ranges', 'bytes')
    // Previews are content-stable for a given (name, width, mtime); let the
    // phone cache them so a reload does not re-download the whole canvas.
    res.setHeader('cache-control', servedPreview ? 'private, max-age=86400' : 'no-cache')
    // Hash the name: raw filenames with non-Latin-1 characters (Japanese
    // asset names) are invalid in HTTP headers and crash setHeader.
    const etagName = createHash('sha1').update(basename(servePath)).digest('hex').slice(0, 16)
    res.setHeader('etag', `"${etagName}-${serveStat.size}-${Math.round(serveStat.mtimeMs)}"`)
    if (url.searchParams.get('download')) {
      res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(basename(filePath))}`)
    }

    const rangeHeader = req.headers.range
    const rangeMatch = typeof rangeHeader === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null
    if (rangeMatch && (rangeMatch[1] || rangeMatch[2])) {
      let start = rangeMatch[1] ? Number.parseInt(rangeMatch[1], 10) : 0
      let end = rangeMatch[2] ? Number.parseInt(rangeMatch[2], 10) : serveStat.size - 1
      end = Math.min(end, serveStat.size - 1)
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= serveStat.size) {
        res.statusCode = 416
        res.setHeader('content-range', `bytes */${serveStat.size}`)
        res.end()
        return
      }
      res.statusCode = 206
      res.setHeader('content-range', `bytes ${start}-${end}/${serveStat.size}`)
      res.setHeader('content-length', String(end - start + 1))
      createReadStream(servePath, { start, end }).pipe(res)
      return
    }

    if (req.headers['if-none-match'] === res.getHeader('etag')) {
      res.statusCode = 304
      res.end()
      return
    }
    res.statusCode = 200
    res.setHeader('content-length', String(serveStat.size))
    createReadStream(servePath).pipe(res)
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.statusCode = 404
      res.end('Not found')
      return
    }
    next(error)
  }
}

const MCP_SERVER_NAME = 'Codex Excalidraw Local Canvas MCP'
const MCP_SERVER_VERSION = '0.1.0'
const TOOL_READ_ME = 'read_me'
const TOOL_CREATE_VIEW = 'create_view'
const TOOL_GET_SELECTION = 'get_excalidraw_selection'
const TOOL_INSERT_IMAGE = 'insert_excalidraw_image'
const TOOL_INSERT_VIDEO = 'insert_excalidraw_video'
const TOOL_GENERATE_IMAGE = 'generate_excalidraw_image'
const TOOL_GENERATE_VIDEO = 'generate_excalidraw_video'
const TOOL_PREPARE_CANVAS_ATTACHMENTS = 'prepare_canvas_attachments'
const TOOL_READ_CANVAS_ATTACHMENT_BUNDLE = 'read_canvas_attachment_bundle'
const TOOL_LIST_CANVAS_ATTACHMENT_BUNDLES = 'list_canvas_attachment_bundles'

function mcpToolDefinitions() {
  return [
    {
      name: TOOL_READ_ME,
      title: 'Read Excalidraw MCP Format',
      description: 'Return the official-compatible Excalidraw element format for create_view.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    {
      name: TOOL_CREATE_VIEW,
      title: 'Create Excalidraw View',
      description: 'Official-compatible create_view tool. Writes Excalidraw-like elements into the live local browser canvas.',
      inputSchema: {
        type: 'object',
        properties: {
          elements: { type: 'string', description: 'JSON array string of Excalidraw-like elements.' },
          append: { type: 'boolean', description: 'Append instead of replacing the previous official-compatible MCP view.' },
          clearCanvas: { type: 'boolean', description: 'Mark all existing elements deleted before adding this view.' },
          dryRun: { type: 'boolean', description: 'Parse and plan without saving.' }
        },
        required: ['elements'],
        additionalProperties: false
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    {
      name: TOOL_GET_SELECTION,
      title: 'Get Excalidraw Selection',
      description: 'Return selected elements from the live local Excalidraw browser canvas.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    {
      name: TOOL_PREPARE_CANVAS_ATTACHMENTS,
      title: 'Attach Selected Canvas Media',
      description: 'Create a BuzzAssist attachment bundle from the current canvas selection and return images/resources/text into this current chat.',
      inputSchema: {
        type: 'object',
        properties: {
          note: { type: 'string' },
          maxInlineImageBytes: { type: 'number' },
          maxInlineTextBytes: { type: 'number' }
        },
        additionalProperties: false
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    {
      name: TOOL_READ_CANVAS_ATTACHMENT_BUNDLE,
      title: 'Read Canvas Attachment Bundle',
      description: "Read a BuzzAssist attachment bundle created from the canvas UI. Use bundleId='latest' for the most recent bundle.",
      inputSchema: {
        type: 'object',
        properties: {
          bundleId: { type: 'string' },
          maxInlineImageBytes: { type: 'number' },
          maxInlineTextBytes: { type: 'number' }
        },
        additionalProperties: false
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    {
      name: TOOL_LIST_CANVAS_ATTACHMENT_BUNDLES,
      title: 'List Canvas Attachment Bundles',
      description: 'List recent BuzzAssist canvas attachment bundles.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number' }
        },
        additionalProperties: false
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    {
      name: TOOL_INSERT_IMAGE,
      title: 'Insert Excalidraw Image',
      description: 'Copy a local bitmap into canvas/assets, create an Excalidraw image file and element, and update the live browser canvas.',
      inputSchema: {
        type: 'object',
        properties: {
          imagePath: { type: 'string' },
          anchorElementId: { type: 'string' },
          sourceElementId: { type: 'string' },
          fileName: { type: 'string' },
          placement: { type: 'string', enum: ['right', 'left', 'below', 'replace', 'inside'] },
          margin: { type: 'number' },
          matchAnchor: { type: 'boolean' },
          replaceAnchor: { type: 'boolean' },
          displayWidth: { type: 'number' },
          displayHeight: { type: 'number' },
          customData: { type: 'object' },
          confirmedSettings: { type: 'boolean', description: 'True only after the user has confirmed generation settings.' },
          dryRun: { type: 'boolean' }
        },
        required: ['imagePath'],
        additionalProperties: false
      }
    },
    {
      name: TOOL_INSERT_VIDEO,
      title: 'Insert Excalidraw Video',
      description: 'Copy a local video into canvas/assets, create a Youtube-AGI-style video media element, and update the live browser canvas.',
      inputSchema: {
        type: 'object',
        properties: {
          videoPath: { type: 'string' },
          anchorElementId: { type: 'string' },
          sourceElementId: { type: 'string' },
          fileName: { type: 'string' },
          placement: { type: 'string', enum: ['right', 'left', 'below', 'replace', 'inside'] },
          margin: { type: 'number' },
          matchAnchor: { type: 'boolean' },
          replaceAnchor: { type: 'boolean' },
          displayWidth: { type: 'number' },
          displayHeight: { type: 'number' },
          aspectRatio: { type: 'string' },
          prompt: { type: 'string' },
          model: { type: 'string' },
          customData: { type: 'object' },
          dryRun: { type: 'boolean' }
        },
        required: ['videoPath'],
        additionalProperties: false
      }
    },
    {
      name: TOOL_GENERATE_IMAGE,
      title: 'Generate Excalidraw Image',
      description: 'Generate an image with GPT-Image-2.0(Codex) or Grok Imagine(Hermes), insert it, and update the live browser canvas.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          model: { type: 'string', enum: ['gpt-image-2-codex', 'grok-imagine-image-hermes'] },
          anchorElementId: { type: 'string' },
          sourceElementId: { type: 'string' },
          fileName: { type: 'string' },
          imageName: { type: 'string' },
          aspectRatio: { type: 'string' },
          aspect_ratio: { type: 'string' },
          imageSize: { type: 'string' },
          quality: { type: 'string' },
          referenceImagePaths: { type: 'array', items: { type: 'string' } },
          reference_image_paths: { type: 'array', items: { type: 'string' } },
          placement: { type: 'string', enum: ['right', 'left', 'below', 'replace', 'inside'] },
          margin: { type: 'number' },
          matchAnchor: { type: 'boolean' },
          replaceAnchor: { type: 'boolean' },
          displayWidth: { type: 'number' },
          displayHeight: { type: 'number' },
          customData: { type: 'object' },
          confirmedSettings: { type: 'boolean', description: 'True only after the user has confirmed generation settings.' },
          dryRun: { type: 'boolean' }
        },
        required: ['prompt'],
        additionalProperties: false
      }
    },
    {
      name: TOOL_GENERATE_VIDEO,
      title: 'Generate Excalidraw Video',
      description: 'Generate a video with Grok Imagine(Hermes), insert a Youtube-AGI-style video media element, and update the live browser canvas.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          model: { type: 'string', enum: ['grok-imagine-video-hermes'] },
          anchorElementId: { type: 'string' },
          sourceElementId: { type: 'string' },
          fileName: { type: 'string' },
          videoName: { type: 'string' },
          aspectRatio: { type: 'string' },
          aspect_ratio: { type: 'string' },
          duration: { type: 'string' },
          resolution: { type: 'string' },
          generateAudio: { type: 'boolean' },
          generate_audio: { type: 'boolean' },
          startFramePath: { type: 'string' },
          start_frame_path: { type: 'string' },
          referenceImagePaths: { type: 'array', items: { type: 'string' } },
          reference_image_paths: { type: 'array', items: { type: 'string' } },
          referenceVideoPaths: { type: 'array', items: { type: 'string' } },
          reference_video_paths: { type: 'array', items: { type: 'string' } },
          referenceVideos: { type: 'array', items: { type: 'string' } },
          reference_videos: { type: 'array', items: { type: 'string' } },
          placement: { type: 'string', enum: ['right', 'left', 'below', 'replace', 'inside'] },
          margin: { type: 'number' },
          matchAnchor: { type: 'boolean' },
          replaceAnchor: { type: 'boolean' },
          displayWidth: { type: 'number' },
          displayHeight: { type: 'number' },
          customData: { type: 'object' },
          dryRun: { type: 'boolean' }
        },
        required: ['prompt'],
        additionalProperties: false
      }
    }
  ]
}

function mcpResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function mcpError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function mcpToolResponse(text, structuredContent) {
  return {
    content: [{ type: 'text', text }],
    structuredContent
  }
}

async function callLocalMcpTool(name, args = {}) {
  const localArgs = { ...(args && typeof args === 'object' ? args : {}), canvasDir }
  if ((name === TOOL_GENERATE_IMAGE || name === TOOL_GENERATE_VIDEO) && localArgs.confirmedSettings !== true) {
    throw new Error('Settings not confirmed. Confirm model, route, aspect ratio, and quality/duration/resolution before calling this generation tool with confirmedSettings=true.')
  }
  delete localArgs.confirmedSettings

  if (name === TOOL_READ_ME) {
    return mcpToolResponse(OFFICIAL_EXCALIDRAW_README, { ok: true })
  }

  if (name === TOOL_CREATE_VIEW) {
    const result = await createExcalidrawView(localArgs)
    if (!result.dryRun) broadcastCanvasChanged([canvasFile])
    return mcpToolResponse(`${result.dryRun ? 'Planned' : 'Created'} Excalidraw view with ${result.addedElementCount} element(s).`, result)
  }

  if (name === TOOL_GET_SELECTION) {
    const selection = await readJsonFile(selectionFile).catch((error) => {
      if (error.code === 'ENOENT') return { selectedElements: [], selectedElementIds: [], updatedAt: null }
      throw error
    })
    const scene = await readJsonFile(canvasFile).then(normalizeScene).catch((error) => {
      if (error.code === 'ENOENT') return normalizeScene(null)
      throw error
    })
    return mcpToolResponse(
      selection.selectedElements?.length ? `${selection.selectedElements.length} selected element(s).` : 'No Excalidraw elements are currently selected.',
      { selection, selectionFile, sceneFile: canvasFile, sceneElementCount: scene.elements.length }
    )
  }

  if (name === TOOL_PREPARE_CANVAS_ATTACHMENTS) {
    const bundle = await createCanvasAttachmentBundle({ ...localArgs, source: 'http-mcp-selection' })
    return canvasAttachmentBundleToMcpResult({ ...localArgs, bundleId: bundle.id })
  }

  if (name === TOOL_READ_CANVAS_ATTACHMENT_BUNDLE) {
    return canvasAttachmentBundleToMcpResult(localArgs)
  }

  if (name === TOOL_LIST_CANVAS_ATTACHMENT_BUNDLES) {
    const bundles = await listCanvasAttachmentBundles(localArgs)
    return mcpToolResponse(
      bundles.length
        ? bundles.map((bundle) => `${bundle.id} — ${bundle.assets.length} asset(s) — ${bundle.createdAt}`).join('\n')
        : 'No BuzzAssist canvas attachment bundles found.',
      { bundles }
    )
  }

  if (name === TOOL_INSERT_IMAGE) {
    const result = await insertExcalidrawImage(localArgs)
    if (!result.dryRun) broadcastCanvasChanged([canvasFile, result.assetFile])
    return mcpToolResponse(`${result.dryRun ? 'Planned' : 'Inserted'} image ${result.elementId}.`, result)
  }

  if (name === TOOL_INSERT_VIDEO) {
    const result = await insertExcalidrawVideo(localArgs)
    if (!result.dryRun) broadcastCanvasChanged([canvasFile, result.assetFile])
    return mcpToolResponse(`${result.dryRun ? 'Planned' : 'Inserted'} video media element ${result.elementId}.`, result)
  }

  if (name === TOOL_GENERATE_IMAGE) {
    const media = await generateImageMedia(localArgs)
    const result = await insertExcalidrawImage({
      ...localArgs,
      mediaBuffer: media.buffer,
      mimeType: media.mimeType,
      fileName: localArgs.fileName || localArgs.imageName || localArgs.image_name,
      customData: {
        codexGeneratedImage: true,
        codexGenerationModel: media.model,
        codexGenerationPrompt: localArgs.prompt,
        codexGenerationAspectRatio: localArgs.aspectRatio ?? localArgs.aspect_ratio,
        codexGenerationQuality: localArgs.quality,
        generatorPrompt: localArgs.prompt,
        generatorModel: localArgs.model,
        generatorAspectRatio: localArgs.aspectRatio ?? localArgs.aspect_ratio,
        generatorImageQuality: localArgs.quality,
        generatorImageSize: localArgs.imageSize ?? localArgs.size ?? '1K',
        codexGenerationSource: media.source,
        ...(localArgs.customData && typeof localArgs.customData === 'object' ? localArgs.customData : {})
      }
    })
    if (!result.dryRun) broadcastCanvasChanged([canvasFile, result.assetFile])
    return mcpToolResponse(`${result.dryRun ? 'Planned' : 'Generated'} image ${result.elementId}.`, { kind: 'image', model: media.model, ...result })
  }

  if (name === TOOL_GENERATE_VIDEO) {
    const media = await generateVideoMedia(localArgs)
    const result = await insertExcalidrawVideo({
      ...localArgs,
      mediaBuffer: media.buffer,
      mimeType: media.mimeType,
      fileName: localArgs.fileName || localArgs.videoName || localArgs.video_name,
      aspectRatio: localArgs.aspectRatio ?? localArgs.aspect_ratio,
      duration: localArgs.duration,
      prompt: localArgs.prompt,
      model: media.model,
      customData: {
        codexGeneratedVideo: true,
        codexGenerationModel: media.model,
        codexGenerationPrompt: localArgs.prompt,
        codexGenerationAspectRatio: localArgs.aspectRatio ?? localArgs.aspect_ratio,
        codexGenerationDuration: localArgs.duration,
        codexGenerationResolution: localArgs.resolution,
        videoPrompt: localArgs.prompt,
        videoModel: localArgs.model,
        videoAspectRatio: localArgs.aspectRatio ?? localArgs.aspect_ratio,
        videoDuration: localArgs.duration,
        videoResolution: localArgs.resolution,
        videoGenerateAudio: localArgs.generateAudio ?? localArgs.generate_audio,
        codexGenerationSource: media.source,
        ...(localArgs.customData && typeof localArgs.customData === 'object' ? localArgs.customData : {})
      }
    })
    if (!result.dryRun) broadcastCanvasChanged([canvasFile, result.assetFile])
    return mcpToolResponse(`${result.dryRun ? 'Planned' : 'Generated'} video media element ${result.elementId}.`, { kind: 'video', model: media.model, ...result })
  }

  throw new Error(`Unknown tool: ${name}`)
}

async function handleMcpMessage(message) {
  if (!message || typeof message !== 'object') return mcpError(null, -32600, 'Invalid JSON-RPC request.')
  const { id, method, params } = message

  if (method === 'initialize') {
    return mcpResult(id, {
      protocolVersion: params?.protocolVersion ?? '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      instructions:
        'This MCP endpoint controls the local Excalidraw browser canvas at the same origin. Use read_me/create_view for official-compatible Excalidraw MCP drawing into the live canvas, and use the media tools for image/video generation.'
    })
  }

  if (method === 'ping') return mcpResult(id, {})
  if (method === 'tools/list') return mcpResult(id, { tools: mcpToolDefinitions() })
  if (method === 'tools/call') {
    try {
      const result = await callLocalMcpTool(params?.name, params?.arguments ?? {})
      return mcpResult(id, result)
    } catch (error) {
      return mcpError(id, -32602, error instanceof Error ? error.message : String(error))
    }
  }

  if (id === undefined) return null
  return mcpError(id, -32601, `Method not found: ${method}`)
}

async function serveMcp(req, res, options = {}) {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname !== '/mcp') return false
  const originPort = options.port ?? defaultPort

  if (rejectDisallowedOrigin(req, res, { port: originPort })) return true
  setLocalCorsHeaders(req, res, { port: originPort })

  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  if (req.method === 'GET') {
    sendJson(res, 200, {
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
      endpoint: '/mcp',
      canvasUrl: `http://127.0.0.1:${originPort}/`,
      auth: { type: 'bearer', env: 'EXCALIDRAW_MCP_TOKEN', discovery: `${canvasDir}/.server.json` },
      tools: mcpToolDefinitions().map((tool) => tool.name)
    })
    return
  }

  if (rejectMissingBearer(req, res, mcpToken)) return true

  if (req.method === 'DELETE') {
    sendJson(res, 200, { ok: true })
    return
  }

  if (req.method !== 'POST') {
    res.statusCode = 405
    res.setHeader('allow', 'GET, POST, DELETE, OPTIONS')
    res.end()
    return
  }

  try {
    const body = JSON.parse(await readRequestBody(req))
    const response = Array.isArray(body)
      ? (await Promise.all(body.map((message) => handleMcpMessage(message)))).filter(Boolean)
      : await handleMcpMessage(body)

    if (!response) {
      res.statusCode = 202
      res.end()
      return
    }

    sendJson(res, 200, response)
  } catch (error) {
    sendJson(res, 400, mcpError(null, -32700, error instanceof Error ? error.message : String(error)))
  }

  return true
}

async function readProjectGlossary() {
  try {
    const parsed = JSON.parse(await readFile(join(canvasDir, 'subtitle-glossary.json'), 'utf8'))
    const terms = Array.isArray(parsed?.terms) ? parsed.terms : []
    return { terms: terms.filter((term) => term && typeof term === 'object') }
  } catch {
    return { terms: [] }
  }
}

async function writeCurrentServerDiscovery(server) {
  const address = server.httpServer?.address?.()
  const port = typeof address === 'object' && address ? address.port : defaultPort
  await writeServerDiscovery({
    canvasDir,
    projectDir,
    host: defaultHost,
    port,
    token: mcpToken
  })
}

function configureCanvasServer(server) {
  let activePort = defaultPort
  const currentOriginPort = () => {
    const address = server.httpServer?.address?.()
    if (typeof address === 'object' && address?.port) {
      activePort = address.port
    }
    return activePort
  }
  server.httpServer?.once?.('listening', () => {
    currentOriginPort()
    writeCurrentServerDiscovery(server).catch((error) => console.warn('[server-discovery] failed:', error.message))
  })
  // safeOnly: never move subtitle cards or trash assets on startup — only
  // the invisible health tasks (which are no-ops in a healthy scene).
  performCanvasMaintenance({ canvasDir, safeOnly: true })
    .then((results) => {
      const { migration, tmpCleanup, orphans } = results
      if (migration?.migrated || migration?.dropped || tmpCleanup?.removed || orphans?.trashed) {
        console.log(
          `[canvas-maintenance] migrated=${migration?.migrated ?? 0} (${Math.round((migration?.migratedBytes ?? 0) / 1024)}KB) ` +
            `droppedRecords=${migration?.dropped ?? 0} tmpRemoved=${tmpCleanup?.removed ?? 0} ` +
            `orphansTrashed=${orphans?.trashed ?? 0} (${Math.round((orphans?.trashedBytes ?? 0) / 1024 / 1024)}MB)`
        )
      }
    })
    .catch((error) => console.warn('[canvas-maintenance] failed:', error.message))
  server.middlewares.use((req, res, next) => {
    const method = String(req.method || '').toUpperCase()
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname
    const shouldCheckOrigin = pathname === '/mcp' || pathname.startsWith('/api/') || ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
    if (shouldCheckOrigin) {
      const originPort = currentOriginPort()
      if (rejectDisallowedOrigin(req, res, { port: originPort })) return
      setLocalCorsHeaders(req, res, { port: originPort })
      if (method === 'OPTIONS') {
        res.statusCode = 204
        res.end()
        return
      }
    }
    next()
  })
  server.middlewares.use(async (req, res, next) => {
    try {
      if (await serveMcp(req, res, { port: currentOriginPort() })) return
      next()
    } catch (error) {
      sendJson(res, 500, { error: error.message })
    }
  })
  server.middlewares.use(serveCanvasAsset)
  mkdirSync(canvasAssetsDir, { recursive: true })
  server.watcher.add([canvasFile, focusRequestFile, canvasAssetsDir])
  let canvasWatchTimer = null
  const scheduleCanvasWatchBroadcast = (changedPath) => {
    const resolvedPath = resolve(changedPath)
    if (resolvedPath !== canvasFile && resolvedPath !== focusRequestFile) return
    clearTimeout(canvasWatchTimer)
    canvasWatchTimer = setTimeout(async () => {
      const focusRequest = await consumeCanvasFocusRequest()
      // Fingerprint from the file itself (not a stash) so a coalesced
      // API-write + MCP-write window can never advertise stale content.
      const fingerprint = await readJsonFile(canvasFile)
        .then((scene) => sceneContentFingerprint(scene))
        .catch(() => '')
      broadcastCanvasChanged([canvasFile], { ...(focusRequest || {}), fingerprint })
    }, 120)
  }
  server.watcher.on('add', scheduleCanvasWatchBroadcast)
  server.watcher.on('change', scheduleCanvasWatchBroadcast)
  let assetDeletionTimer = null
  const scheduleMissingAssetSync = (changedPath) => {
    const resolvedPath = resolve(changedPath)
    const isWholeAssetsDirectory = resolvedPath === canvasAssetsDir
    if (!isWholeAssetsDirectory && !isSafeChildPath(canvasAssetsDir, resolvedPath)) return
    clearTimeout(assetDeletionTimer)
    assetDeletionTimer = setTimeout(async () => {
      try {
        const assetFileName = isWholeAssetsDirectory ? undefined : basename(resolvedPath)
        if (assetFileName && (await stat(resolvedPath).catch(() => null))?.isFile()) return
        const result = await syncMissingCanvasAssets({
          canvasDir,
          assetFileName,
          restoreFromTrash: false
        })
        if (result.deleted > 0) {
          const scene = normalizeScene(await readJsonFile(canvasFile))
          broadcastCanvasChanged([canvasFile], { fingerprint: sceneContentFingerprint(scene) })
        }
      } catch (error) {
        console.warn('[asset-delete-sync] failed:', error.message)
      }
    }, 180)
  }
  server.watcher.on('unlink', scheduleMissingAssetSync)
  server.watcher.on('change', (changedPath) => {
    if (resolve(changedPath) === canvasAssetsDir) scheduleMissingAssetSync(changedPath)
  })

      // Reveal the current project's canonical media folder. Local operator
      // only: a tunnel/phone page must never be able to open host OS windows.
      server.middlewares.use('/api/assets/open-folder', async (req, res) => {
        if (rejectRemoteOperator(req, res)) return
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('allow', 'POST')
          res.end()
          return
        }
        try {
          const result = await openLocalFolder(canvasAssetsDir)
          sendJson(res, 200, result)
        } catch (error) {
          sendJson(res, 500, { ok: false, error: `assetsフォルダーを開けませんでした: ${error.message}` })
        }
      })

      // Bulk download: zips requested canvas assets as a streaming STORE
      // archive. GET supports direct browser downloads; POST is kept for
      // programmatic callers. Names are validated through the same path guard
      // as single-asset serving.
      server.middlewares.use('/api/assets/archive', async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }
        try {
          const url = new URL(req.url || '/', 'http://localhost')
          const body = req.method === 'POST' ? JSON.parse((await readRequestBody(req)) || '{}') : {}
          const names = req.method === 'GET'
            ? url.searchParams.getAll('file').slice(0, 500)
            : (Array.isArray(body.files) ? body.files.slice(0, 500) : [])
          const entries = []
          for (const rawName of names) {
            const filePath = localAssetFilePathFromUrl(`${canvasAssetsRoute}${encodeURIComponent(String(rawName))}`)
            if (!filePath) continue
            try {
              const info = await stat(filePath)
              if (!info.isFile()) continue
              entries.push({ name: basename(filePath), path: filePath, size: info.size, mtime: info.mtime })
            } catch {
              // skip missing files; the rest still download
            }
          }
          if (entries.length === 0) {
            sendJson(res, 400, { error: 'ダウンロード可能なアセットがありません。' })
            return
          }
          const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
          res.statusCode = 200
          res.setHeader('content-type', 'application/zip')
          res.setHeader('content-disposition', `attachment; filename="excalidraw-assets-${stamp}.zip"`)
          res.setHeader('cache-control', 'no-cache')
          await streamZipStore(entries, res)
        } catch (error) {
          if (res.headersSent) {
            res.destroy(error)
            return
          }
          sendJson(res, 500, { error: error.message })
        }
      })

      // Native save panel (default location: Downloads) driven by the dev
      // server, because the in-app browser ignores showSaveFilePicker's
      // startIn hint. Single asset saves directly; multi-selection saves a
      // STORE zip. Local operators only — tunnel/phone clients get the 403
      // and fall back to a plain browser download.
      server.middlewares.use('/api/assets/save-dialog', async (req, res) => {
        if (rejectRemoteOperator(req, res)) return
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }
          const body = JSON.parse((await readRequestBody(req)) || '{}')
          const assetItems = Array.isArray(body.assets) ? body.assets : []
          const assetPaths = await resolveClientAssetPaths(assetItems)
          if (assetPaths.length === 0) {
            sendJson(res, 400, { ok: false, error: '保存できるファイルがありません。' })
            return
          }
          // One dialog at a time — a duplicate click while the panel is open
          // resolves as cancelled instead of stacking dialogs.
          if (saveDialogOpen) {
            sendJson(res, 200, { ok: false, cancelled: true, busy: true })
            return
          }
          const single = assetPaths.length === 1
          const suggestedName = single
            ? basename(assetPaths[0])
            : `excalidraw-assets-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`
          saveDialogOpen = true
          let destination = null
          try {
            destination = await chooseSaveDestination(suggestedName)
          } finally {
            saveDialogOpen = false
          }
          if (!destination) {
            sendJson(res, 200, { ok: false, cancelled: true })
            return
          }
          // Belt and braces: if the panel returned a name with no extension
          // (hidden-extension quirks), append the suggested one.
          const suggestedExt = extname(suggestedName)
          if (suggestedExt && !extname(basename(destination))) {
            destination += suggestedExt
          }
          if (single) {
            await copyFile(assetPaths[0], destination)
          } else {
            const entries = []
            for (const filePath of assetPaths) {
              const info = await stat(filePath)
              entries.push({ name: basename(filePath), path: filePath, size: info.size, mtime: info.mtime })
            }
            await new Promise((resolveZip, rejectZip) => {
              const out = createWriteStream(destination)
              out.on('error', rejectZip)
              out.on('finish', resolveZip)
              streamZipStore(entries, out).catch(rejectZip)
            })
          }
          sendJson(res, 200, { ok: true, path: destination, files: assetPaths.map((filePath) => basename(filePath)) })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error.message })
        }
      })

      server.middlewares.use('/api/canvas-events', (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.setHeader('allow', 'GET')
          res.end()
          return
        }

        res.statusCode = 200
        res.setHeader('content-type', 'text/event-stream')
        res.setHeader('cache-control', 'no-cache, no-transform')
        res.setHeader('connection', 'keep-alive')
        res.setHeader('x-accel-buffering', 'no')
        res.write(': connected\n\n')

        canvasEventClients.add(res)
        const heartbeat = setInterval(() => {
          res.write(`: heartbeat ${Date.now()}\n\n`)
        }, 25000)

        req.on('close', () => {
          clearInterval(heartbeat)
          canvasEventClients.delete(res)
        })
      })

      server.middlewares.use('/api/selection', async (req, res) => {
        try {
          if (req.method === 'GET') {
            try {
              sendJson(res, 200, {
                selection: await readJsonFile(selectionFile),
                path: selectionFile
              })
            } catch (error) {
              if (error.code === 'ENOENT') {
                sendJson(res, 200, {
                  selection: { selectedElements: [], selectedElementIds: [], updatedAt: null },
                  path: selectionFile
                })
                return
              }
              throw error
            }
            return
          }

          if (req.method === 'PUT') {
            const body = await readRequestBody(req)
            const selection = JSON.parse(body)
            if (!isSelectionState(selection)) {
              sendJson(res, 400, { error: 'Expected an Excalidraw selection state.' })
              return
            }

            await writeJsonAtomic(selectionFile, selection)
            sendJson(res, 200, { ok: true, path: selectionFile })
            return
          }

          res.statusCode = 405
          res.setHeader('allow', 'GET, PUT')
          res.end()
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })

      server.middlewares.use('/api/view-state', async (req, res) => {
        try {
          if (req.method === 'GET') {
            try {
              sendJson(res, 200, {
                viewState: await readJsonFile(viewStateFile),
                path: viewStateFile
              })
            } catch (error) {
              if (error.code === 'ENOENT') {
                sendJson(res, 200, {
                  viewState: {
                    version: 1,
                    scrollX: 0,
                    scrollY: 0,
                    zoom: { value: 1 },
                    updatedAt: null
                  },
                  path: viewStateFile
                })
                return
              }
              throw error
            }
            return
          }

          if (req.method === 'PUT') {
            const body = await readRequestBody(req)
            const viewState = JSON.parse(body)
            if (!isViewState(viewState)) {
              sendJson(res, 400, { error: 'Expected an Excalidraw view state.' })
              return
            }

            await writeJsonAtomic(viewStateFile, viewState)
            sendJson(res, 200, { ok: true, path: viewStateFile })
            return
          }

          res.statusCode = 405
          res.setHeader('allow', 'GET, PUT')
          res.end()
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })

      server.middlewares.use('/api/canvas', async (req, res) => {
        try {
          if (req.method === 'GET') {
            try {
              sendJson(res, 200, {
                scene: normalizeScene(await readJsonFile(canvasFile)),
                path: canvasFile,
                storage: 'single-file',
                assetsDir: canvasAssetsDir,
                assetsRoute: canvasAssetsRoute
              })
            } catch (error) {
              if (error.code === 'ENOENT') {
                sendJson(res, 200, {
                  scene: normalizeScene(null),
                  path: canvasFile,
                  storage: 'empty',
                  assetsDir: canvasAssetsDir,
                  assetsRoute: canvasAssetsRoute
                })
                return
              }
              throw error
            }
            return
          }

          if (req.method === 'PUT') {
            const body = await readRequestBody(req)
            const payload = JSON.parse(body)
            const incomingScene = normalizeScene(payload)
            let existingScene = normalizeScene(null)
            try {
              existingScene = normalizeScene(await readJsonFile(canvasFile))
            } catch (error) {
              if (error.code !== 'ENOENT') throw error
            }
            if (!isScene(incomingScene)) {
              sendJson(res, 400, { error: 'Expected an Excalidraw scene.' })
              return
            }
            if (incomingScene.elements.length === 0 && payload?.allowClearCanvas !== true) {
              if (existingScene.elements.length > 0) {
                sendJson(res, 409, {
                  error: 'Refusing to replace a non-empty Excalidraw canvas with an empty scene.',
                  existingElementCount: existingScene.elements.length
                })
                return
              }
            }
            const scene = payload?.allowClearCanvas === true
              ? incomingScene
              : normalizeScene(mergeLocalCanvasScenes(existingScene, incomingScene))

            // Strip inline base64 for file records verifiably backed by an
            // on-disk asset (keeps drag-dropped images and video posters inline).
            await stripAssetBackedFileDataURLs(scene)
            await writeJsonAtomic(canvasFile, scene)
            const assetSync = await syncDeletedCanvasAssets({ canvasDir }, scene)
            // A stale browser tab may try to resurrect an element after its
            // backing file was deliberately removed in Finder/Explorer. Run
            // the missing-file invariant on every save, not only on unlink.
            const missingAssetSync = await syncMissingCanvasAssets({ canvasDir, restoreFromTrash: false })
            const persistedScene = missingAssetSync.deleted > 0
              ? normalizeScene(await readJsonFile(canvasFile))
              : scene
            sendJson(res, 200, {
              ok: true,
              path: canvasFile,
              storage: 'single-file',
              assetSync,
              missingAssetSync
            })
            broadcastCanvasChanged([canvasFile], { fingerprint: sceneContentFingerprint(persistedScene) })
            return
          }

          res.statusCode = 405
          res.setHeader('allow', 'GET, PUT')
          res.end()
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })

      server.middlewares.use('/api/generation-capabilities', async (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.setHeader('allow', 'GET')
          res.end()
          return
        }

        sendJson(res, 200, getGenerationCapabilities())
      })

      server.middlewares.use('/api/buzzassist/auth-status', async (req, res) => {
        try {
          if (req.method !== 'GET') {
            res.statusCode = 405
            res.setHeader('allow', 'GET')
            res.end()
            return
          }
          // Server verification costs a buzzassist.ai round trip (~0.3-1.5s)
          // and the generation gate hits this on every click — cache the
          // verified status, keyed by the auth file's mtime so any local
          // login/logout (even from another process) busts it instantly.
          const cacheKey = await stat(resolveAuthFilePath())
            .then((info) => `${Math.round(info.mtimeMs)}`)
            .catch(() => 'no-auth-file')
          const cached = buzzAssistStatusCacheRef
          if (cached.status && cached.key === cacheKey && Date.now() - cached.at < 5 * 60_000) {
            sendJson(res, 200, cached.status)
            return
          }
          const status = await getBuzzAssistAuthStatus({ verifyServer: true })
          buzzAssistStatusCacheRef = { key: cacheKey, at: Date.now(), status }
          sendJson(res, 200, status)
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })

      server.middlewares.use('/api/buzzassist/login', async (req, res) => {
        // Opens the OAuth browser flow on the host Mac and blocks — a remote
        // client cannot complete it and would only spawn a desktop window.
        if (rejectRemoteOperator(req, res)) return
        try {
          if (req.method !== 'GET' && req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'GET, POST')
            res.end()
            return
          }
          let authUrl = null
          const result = await loginBuzzAssistViaBrowser({
            openBrowser: true,
            timeoutMs: 5 * 60 * 1000,
            onAuthUrl: (url) => {
              authUrl = url
            }
          })
          sendJson(res, 200, { ok: true, userId: result.userId, expiresAt: result.expiresAt, authUrl })
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })

      server.middlewares.use('/api/generate/image', async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }

          const body = JSON.parse(await readRequestBody(req))
          const runImageGeneration = async () => {
            const media = await generateImageMedia(body)
            const result = await insertExcalidrawImage({
              canvasDir,
              mediaBuffer: media.buffer,
              mimeType: media.mimeType,
              fileName: body.fileName,
              anchorElementId: body.anchorElementId,
              sourceElementId: body.sourceElementId,
              placement: body.placement,
              margin: body.margin,
              matchAnchor: body.matchAnchor,
              replaceAnchor: body.replaceAnchor,
              selectCreated: body.selectCreated,
              displayWidth: body.displayWidth,
              displayHeight: body.displayHeight,
              customData: {
                codexGeneratedImage: true,
                codexGenerationModel: media.model,
                codexGenerationPrompt: body.prompt,
                codexGenerationAspectRatio: body.aspectRatio ?? body.aspect_ratio,
                codexGenerationQuality: body.quality,
                generatorPrompt: body.prompt,
                generatorModel: body.model,
                generatorAspectRatio: body.aspectRatio ?? body.aspect_ratio,
                generatorImageQuality: body.quality,
                generatorImageSize: body.imageSize ?? body.size ?? '1K',
                codexGenerationSource: media.source,
                ...(body.customData && typeof body.customData === 'object' ? body.customData : {})
              }
            })
            // Multi-image runs (Lovart native outputs or repeated ChatGPT
            // generations): each extra replaces one of the placeholder
            // frames the client laid out in its 2 × 5 grid. Without
            // placeholders they chain to the right of the previous result.
            const extraAnchors = Array.isArray(body.extraAnchorElementIds)
              ? body.extraAnchorElementIds.filter((id) => typeof id === 'string' && id)
              : []
            const changedAssets = [result.assetFile]
            const extras = []
            let extraAnchorId = result.elementId
            for (const [extraIndex, extra] of (Array.isArray(media.extraMedia) ? media.extraMedia : []).entries()) {
              try {
                const placeholderId = extraAnchors[extraIndex]
                const extraResult = await insertExcalidrawImage({
                  canvasDir,
                  mediaBuffer: extra.buffer,
                  mimeType: extra.mimeType,
                  // No explicit name: fall through to the desktop-app-style
                  // sequential ImageN naming in canvasScene.
                  fileName: body.fileName ? extra.fileName : undefined,
                  anchorElementId: placeholderId ?? extraAnchorId,
                  placement: placeholderId ? 'replace' : 'right',
                  replaceAnchor: Boolean(placeholderId),
                  matchAnchor: true,
                  displayWidth: body.displayWidth,
                  displayHeight: body.displayHeight,
                  customData: {
                    codexGeneratedImage: true,
                    codexGenerationModel: media.model,
                    codexGenerationPrompt: body.prompt,
                    generatorPrompt: body.prompt,
                    generatorModel: body.model,
                    generatorAspectRatio: body.aspectRatio ?? body.aspect_ratio,
                    generatorImageCount: body.imageCount ?? body.image_count ?? 1,
                    codexGenerationSource: extra.source,
                    ...(body.customData && typeof body.customData === 'object' ? body.customData : {})
                  }
                })
                changedAssets.push(extraResult.assetFile)
                extraAnchorId = extraResult.elementId
                extras.push({ elementId: extraResult.elementId, fileId: extraResult.fileId, assetUrl: extraResult.assetUrl })
              } catch (extraError) {
                console.warn('[generate/image] extra image insert failed:', extraError.message)
              }
            }
            broadcastCanvasChanged([canvasFile, ...changedAssets])
            return { media, result: { ...result, extras } }
          }

          if (wantsAsyncGeneration(req, body)) {
            const jobId = createGenerationJobId('image')
            sendJson(res, 202, { ok: true, async: true, jobId, kind: 'image' })
            runBackgroundGeneration(jobId, runImageGeneration)
            return
          }

          const { media, result } = await runImageGeneration()
          sendJson(res, 200, {
            ok: true,
            kind: 'image',
            model: media.model,
            generationErrors: media.generationErrors ?? [],
            ...result
          })
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })

      server.middlewares.use('/api/generate/video', async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }

          const body = JSON.parse(await readRequestBody(req))
          const runVideoGeneration = async () => {
            const media = await generateVideoMedia(body)
            const result = await insertExcalidrawVideo({
              canvasDir,
              mediaBuffer: media.buffer,
              mimeType: media.mimeType,
              fileName: body.fileName || body.videoName,
              anchorElementId: body.anchorElementId,
              sourceElementId: body.sourceElementId,
              placement: body.placement,
              margin: body.margin,
              matchAnchor: body.matchAnchor,
              replaceAnchor: body.replaceAnchor,
              selectCreated: body.selectCreated,
              displayWidth: body.displayWidth,
              displayHeight: body.displayHeight,
              aspectRatio: body.aspectRatio,
              duration: body.duration,
              prompt: body.prompt,
              model: media.model,
              customData: {
                codexGeneratedVideo: true,
                codexGenerationModel: media.model,
                codexGenerationPrompt: body.prompt,
                codexGenerationAspectRatio: body.aspectRatio ?? body.aspect_ratio,
                codexGenerationDuration: body.duration,
                codexGenerationResolution: body.resolution,
                videoPrompt: body.prompt,
                videoModel: body.model,
                videoAspectRatio: body.aspectRatio ?? body.aspect_ratio,
                videoDuration: body.duration,
                videoResolution: body.resolution,
                generatorVideoCount: body.videoCount ?? body.video_count ?? 1,
                videoGenerateAudio: body.generateAudio ?? body.generate_audio,
                codexGenerationSource: media.source,
                ...(body.customData && typeof body.customData === 'object' ? body.customData : {})
              }
            })
            // Grok multi-video uses independent requests. Each extra result
            // replaces the corresponding Generating... placeholder in the
            // same 2 × 5 layout used by multi-image generation.
            const extraAnchors = Array.isArray(body.extraAnchorElementIds)
              ? body.extraAnchorElementIds.filter((id) => typeof id === 'string' && id)
              : []
            const changedAssets = [result.assetFile]
            const extras = []
            let extraAnchorId = result.elementId
            for (const [extraIndex, extra] of (Array.isArray(media.extraMedia) ? media.extraMedia : []).entries()) {
              try {
                const placeholderId = extraAnchors[extraIndex]
                const extraResult = await insertExcalidrawVideo({
                  canvasDir,
                  mediaBuffer: extra.buffer,
                  mimeType: extra.mimeType,
                  fileName: body.fileName || body.videoName ? extra.fileName : undefined,
                  anchorElementId: placeholderId ?? extraAnchorId,
                  placement: placeholderId ? 'replace' : 'right',
                  replaceAnchor: Boolean(placeholderId),
                  matchAnchor: true,
                  displayWidth: body.displayWidth,
                  displayHeight: body.displayHeight,
                  aspectRatio: body.aspectRatio,
                  duration: body.duration,
                  prompt: body.prompt,
                  model: media.model,
                  customData: {
                    codexGeneratedVideo: true,
                    codexGenerationModel: media.model,
                    codexGenerationPrompt: body.prompt,
                    codexGenerationAspectRatio: body.aspectRatio ?? body.aspect_ratio,
                    codexGenerationDuration: body.duration,
                    codexGenerationResolution: body.resolution,
                    videoPrompt: body.prompt,
                    videoModel: body.model,
                    videoAspectRatio: body.aspectRatio ?? body.aspect_ratio,
                    videoDuration: body.duration,
                    videoResolution: body.resolution,
                    generatorVideoCount: body.videoCount ?? body.video_count ?? 1,
                    videoGenerateAudio: body.generateAudio ?? body.generate_audio,
                    codexGenerationSource: extra.source,
                    ...(body.customData && typeof body.customData === 'object' ? body.customData : {})
                  }
                })
                changedAssets.push(extraResult.assetFile)
                extraAnchorId = extraResult.elementId
                extras.push({ elementId: extraResult.elementId, fileId: extraResult.fileId, assetUrl: extraResult.assetUrl })
              } catch (extraError) {
                console.warn('[generate/video] extra video insert failed:', extraError.message)
              }
            }
            broadcastCanvasChanged([canvasFile, ...changedAssets])
            return { media, result: { ...result, extras } }
          }

          if (wantsAsyncGeneration(req, body)) {
            const jobId = createGenerationJobId('video')
            sendJson(res, 202, { ok: true, async: true, jobId, kind: 'video' })
            runBackgroundGeneration(jobId, runVideoGeneration)
            return
          }

          const { media, result } = await runVideoGeneration()
          sendJson(res, 200, {
            ok: true,
            kind: 'video',
            model: media.model,
            generationErrors: media.generationErrors ?? [],
            ...result
          })
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })

      server.middlewares.use('/api/generate/images/batch', async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }

          const body = JSON.parse(await readRequestBody(req))
          const jobs = Array.isArray(body.jobs) ? body.jobs : []
          if (jobs.length === 0) {
            sendJson(res, 400, { error: 'jobs must be a non-empty array' })
            return
          }
          if (jobs.some((job) => typeof job?.prompt !== 'string' || job.prompt.trim().length === 0)) {
            sendJson(res, 400, { error: 'each job requires a prompt' })
            return
          }

          const columns = normalizeMediaBatchColumns(body.columns)
          const gap = Number.isFinite(Number(body.gap)) ? Number(body.gap) : 24
          const concurrency = normalizeMediaBatchConcurrency(body.concurrency)
          const results = new Array(jobs.length)
          const chunks = []

          for (const [chunkIndex, chunk] of chunkMediaBatchJobs(jobs, DEFAULT_MEDIA_BATCH_CHUNK_SIZE).entries()) {
            const generated = await runWithConcurrency(chunk.jobs, concurrency, (job) => generateImageMedia(job))
            const items = []
            const itemJobIndexes = []
            chunk.jobs.forEach((job, i) => {
              const outcome = generated[i]
              if (!outcome.ok) return
              const media = outcome.value
              items.push({
                kind: 'image',
                mediaBuffer: media.buffer,
                mimeType: media.mimeType,
                fileName: job.fileName,
                customData: {
                  codexGeneratedImage: true,
                  codexGenerationModel: media.model,
                  codexGenerationPrompt: job.prompt,
                  codexGenerationAspectRatio: job.aspectRatio ?? job.aspect_ratio,
                  codexGenerationQuality: job.quality,
                  generatorPrompt: job.prompt,
                  generatorModel: job.model,
                  generatorAspectRatio: job.aspectRatio ?? job.aspect_ratio,
                  generatorImageQuality: job.quality,
                  generatorImageSize: job.imageSize ?? job.size ?? '1K',
                  codexGenerationSource: media.source,
                  ...(job.customData && typeof job.customData === 'object' ? job.customData : {})
                }
              })
              itemJobIndexes.push(chunk.start + i)
            })

            let chunkInserted = []
            if (items.length > 0) {
              chunkInserted = await insertExcalidrawMediaBatch({
                canvasDir,
                items,
                columns,
                gap,
                selectCreated: body.selectCreated
              })
              broadcastCanvasChanged([canvasFile, ...chunkInserted.map((placement) => placement.assetFile)])
            }

            chunk.jobs.forEach((job, i) => {
              const outcome = generated[i]
              const jobIndex = chunk.start + i
              if (!outcome.ok) {
                results[jobIndex] = { prompt: job.prompt, error: outcome.error }
                return
              }
              const placement = chunkInserted[itemJobIndexes.indexOf(jobIndex)]
              results[jobIndex] = {
                prompt: job.prompt,
                model: outcome.value.model,
                elementId: placement?.elementId,
                fileId: placement?.fileId,
                bounds: placement?.bounds,
                assetFile: placement?.assetFile,
                assetUrl: placement?.assetUrl
              }
            })

            const chunkSucceeded = chunk.jobs.filter((_, i) => generated[i]?.ok).length
            chunks.push({
              index: chunkIndex + 1,
              start: chunk.start,
              total: chunk.jobs.length,
              succeeded: chunkSucceeded,
              failed: chunk.jobs.length - chunkSucceeded,
              columns,
              concurrency
            })
          }
          const succeeded = results.filter((result) => !result.error).length

          sendJson(res, 200, {
            ok: true,
            kind: 'image',
            total: jobs.length,
            succeeded,
            failed: jobs.length - succeeded,
            columns,
            concurrency,
            chunkSize: DEFAULT_MEDIA_BATCH_CHUNK_SIZE,
            chunks,
            results
          })
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })

      server.middlewares.use('/api/generate/videos/batch', async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }

          const body = JSON.parse(await readRequestBody(req))
          const jobs = Array.isArray(body.jobs) ? body.jobs : []
          if (jobs.length === 0) {
            sendJson(res, 400, { error: 'jobs must be a non-empty array' })
            return
          }
          if (jobs.some((job) => typeof job?.prompt !== 'string' || job.prompt.trim().length === 0)) {
            sendJson(res, 400, { error: 'each job requires a prompt' })
            return
          }

          const columns = normalizeMediaBatchColumns(body.columns)
          const gap = Number.isFinite(Number(body.gap)) ? Number(body.gap) : 24
          const concurrency = normalizeMediaBatchConcurrency(body.concurrency)
          const results = new Array(jobs.length)
          const chunks = []

          for (const [chunkIndex, chunk] of chunkMediaBatchJobs(jobs, DEFAULT_MEDIA_BATCH_CHUNK_SIZE).entries()) {
            const generated = await runWithConcurrency(chunk.jobs, concurrency, (job) => generateVideoMedia(job))
            const items = []
            const itemJobIndexes = []
            chunk.jobs.forEach((job, i) => {
              const outcome = generated[i]
              if (!outcome.ok) return
              const media = outcome.value
              items.push({
                kind: 'video',
                mediaBuffer: media.buffer,
                mimeType: media.mimeType,
                fileName: job.fileName || job.videoName,
                aspectRatio: job.aspectRatio ?? job.aspect_ratio,
                duration: job.duration,
                customData: {
                  codexGeneratedVideo: true,
                  codexGenerationModel: media.model,
                  codexGenerationPrompt: job.prompt,
                  codexGenerationAspectRatio: job.aspectRatio ?? job.aspect_ratio,
                  codexGenerationDuration: job.duration,
                  codexGenerationResolution: job.resolution,
                  videoPrompt: job.prompt,
                  videoModel: job.model,
                  videoAspectRatio: job.aspectRatio ?? job.aspect_ratio,
                  videoDuration: job.duration,
                  videoResolution: job.resolution,
                  videoGenerateAudio: job.generateAudio ?? job.generate_audio,
                  codexGenerationSource: media.source,
                  ...(job.customData && typeof job.customData === 'object' ? job.customData : {})
                }
              })
              itemJobIndexes.push(chunk.start + i)
            })

            let chunkInserted = []
            if (items.length > 0) {
              chunkInserted = await insertExcalidrawMediaBatch({
                canvasDir,
                items,
                columns,
                gap,
                selectCreated: body.selectCreated
              })
              broadcastCanvasChanged([canvasFile, ...chunkInserted.map((placement) => placement.assetFile)])
            }

            chunk.jobs.forEach((job, i) => {
              const outcome = generated[i]
              const jobIndex = chunk.start + i
              if (!outcome.ok) {
                results[jobIndex] = { prompt: job.prompt, error: outcome.error }
                return
              }
              const placement = chunkInserted[itemJobIndexes.indexOf(jobIndex)]
              results[jobIndex] = {
                prompt: job.prompt,
                model: outcome.value.model,
                elementId: placement?.elementId,
                fileId: placement?.fileId,
                bounds: placement?.bounds,
                assetFile: placement?.assetFile,
                assetUrl: placement?.assetUrl
              }
            })

            const chunkSucceeded = chunk.jobs.filter((_, i) => generated[i]?.ok).length
            chunks.push({
              index: chunkIndex + 1,
              start: chunk.start,
              total: chunk.jobs.length,
              succeeded: chunkSucceeded,
              failed: chunk.jobs.length - chunkSucceeded,
              columns,
              concurrency
            })
          }
          const succeeded = results.filter((result) => !result.error).length

          sendJson(res, 200, {
            ok: true,
            kind: 'video',
            total: jobs.length,
            succeeded,
            failed: jobs.length - succeeded,
            columns,
            concurrency,
            chunkSize: DEFAULT_MEDIA_BATCH_CHUNK_SIZE,
            chunks,
            results
          })
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })

      // Lets the MCP server decide whether to open a browser tab (auto-open
      // when no canvas tab is connected).
      server.middlewares.use('/api/canvas-clients', (req, res) => {
        sendJson(res, 200, {
          clients: canvasEventClients.size,
          protocolVersion: CANVAS_SERVER_PROTOCOL_VERSION,
          projectDir,
          canvasDir,
          capabilities: { openAssetsFolder: true, syncDeletedAssets: true }
        })
      })

      // Project-common 用語辞書 (same model as the BuzzAssist desktop app):
      // one list per project, merged into every SRT generation.
      server.middlewares.use('/api/subtitle-glossary', async (req, res) => {
        try {
          const glossaryFile = join(canvasDir, 'subtitle-glossary.json')
          if (req.method === 'GET') {
            sendJson(res, 200, await readProjectGlossary())
            return
          }
          if (req.method === 'PUT' || req.method === 'POST') {
            const body = JSON.parse((await readRequestBody(req)) || '{}')
            const terms = (Array.isArray(body.terms) ? body.terms : [])
              .map((term) => ({
                id: String(term?.id || Math.random().toString(36).slice(2)),
                from: String(term?.from ?? ''),
                to: String(term?.to ?? '')
              }))
              .slice(0, 200)
            await mkdir(canvasDir, { recursive: true })
            await writeFile(glossaryFile, `${JSON.stringify({ terms }, null, 2)}\n`)
            sendJson(res, 200, { terms })
            return
          }
          res.statusCode = 405
          res.setHeader('allow', 'GET, PUT')
          res.end()
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })

      // TEMP diagnostic: verify this server process can reach fal storage.
      server.middlewares.use('/api/debug/outbound', async (req, res) => {
        if (rejectRemoteOperator(req, res)) return
        try {
          const { uploadBufferToFalStorage } = await import('./lib/buzzassistApi.mjs')
          const url = new URL(req.url, 'http://127.0.0.1')
          const mb = Math.max(0.25, Math.min(64, Number(url.searchParams.get('mb')) || 0.25))
          const uploaded = await uploadBufferToFalStorage(Buffer.alloc(Math.round(mb * 1024 * 1024), 7), { mimeType: 'application/octet-stream', fileName: 'probe.bin' })
          sendJson(res, 200, { ok: true, mb, url: uploaded.slice(0, 60) })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error.message, cause: error.cause?.message || String(error.cause || '') })
        }
      })

      server.middlewares.use('/api/hermes/status', async (req, res) => {
        try {
          sendJson(res, 200, await getHermesStatus())
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })

      // Send a message to a local AI chat app (Claude Code desktop / Codex).
      // The browser canvas cannot reach those apps, so the dev server bridges:
      server.middlewares.use('/api/agent-attachments', async (req, res) => {
        try {
          if (req.method === 'GET') {
            const bundle = await readCanvasAttachmentBundle({ canvasDir, bundleId: 'latest' }).catch((error) => {
              if (error?.code === 'ENOENT') return null
              if (/no such file or directory/i.test(String(error?.message || ''))) return null
              throw error
            })
            if (!bundle) {
              sendJson(res, 200, { bundleId: null, assetCount: 0, assets: [], prompt: '' })
              return
            }
            sendJson(res, 200, {
              bundleId: bundle.id,
              createdAt: bundle.createdAt,
              assetCount: bundle.assets.length,
              assets: bundle.assets.map((asset) => ({
                name: asset.name,
                kind: asset.kind,
                mimeType: asset.mimeType,
                size: asset.size
              })),
              prompt: bundle.usage?.tool ? `BuzzAssistのキャンバス添付 ${bundle.id} を読んで。` : ''
            })
            return
          }
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'GET, POST')
            res.end()
            return
          }
          const body = JSON.parse((await readRequestBody(req)) || '{}')
          const bundle = await createCanvasAttachmentBundle({
            canvasDir,
            projectDir,
            assets: Array.isArray(body.assets) ? body.assets : [],
            note: typeof body.note === 'string' ? body.note : '',
            source: 'canvas-ui'
          })
          const prompt = `BuzzAssistのキャンバス添付 ${bundle.id} を読んで。`
          sendJson(res, 200, {
            bundleId: bundle.id,
            createdAt: bundle.createdAt,
            assetCount: bundle.assets.length,
            assets: bundle.assets.map((asset) => ({
              name: asset.name,
              kind: asset.kind,
              mimeType: asset.mimeType,
              size: asset.size
            })),
            prompt
          })
        } catch (error) {
          sendJson(res, 400, { error: error.message })
        }
      })

      // copy the text to the clipboard, activate the app, then paste + Enter
      // via System Events. If keystrokes are blocked (no Accessibility
      // permission) the text is still on the clipboard for a manual paste.
      server.middlewares.use('/api/chat/send', async (req, res) => {
        // Desktop keystroke injection is a local-operator action: never allow a
        // remote/tunnel browser (or a cross-site page) to drive the Mac's chat
        // apps, even behind Basic Auth.
        if (rejectRemoteOperator(req, res)) return
        // osascript can hang forever from this context while macOS waits on a
        // consent dialog that never shows — always race against a timeout.
        const runOsascript = (script, timeoutMs = 8000) => new Promise((resolveOsa) => {
          const child = spawn('osascript', ['-e', script])
          let stderr = ''
          let settled = false
          const finish = (result) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolveOsa(result)
          }
          const timer = setTimeout(() => {
            child.kill('SIGKILL')
            finish({ ok: false, error: 'オートメーションが応答しません（権限未許可の可能性）' })
          }, timeoutMs)
          child.stderr.on('data', (chunk) => { stderr += chunk })
          child.on('error', (error) => finish({ ok: false, error: error.message }))
          child.on('close', (code) => finish(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() }))
        })
        try {
          if (req.method === 'GET') {
            // Bridge health: can this server drive the user's GUI session
            // directly, and is an MCP-side bridge worker alive as fallback?
            const probe = await runOsascript('tell application "System Events" to count processes', 3000)
            sendJson(res, 200, {
              automation: probe.ok,
              bridgeWorker: await bridgeWorkerAlive(canvasDir),
              error: probe.ok ? undefined : probe.error
            })
            return
          }
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'GET, POST')
            res.end()
            return
          }
          const body = JSON.parse(await readRequestBody(req))
          const appName = body.app === 'codex' ? 'Codex' : body.app === 'claude' ? 'Claude' : ''
          const note = typeof body.text === 'string' ? body.text.trim() : ''
          const assetUrls = Array.isArray(body.assetUrls) ? body.assetUrls : []
          const assetItems = Array.isArray(body.assetItems) ? body.assetItems : []
          const resolveClientAssetPath = (item) => {
            if (item && typeof item === 'object' && typeof item.path === 'string' && item.path) {
              const directPath = resolve(item.path)
              if (isSafeChildPath(canvasAssetsDir, directPath)) return directPath
            }
            const rawUrl = item && typeof item === 'object' ? (item.url || item.assetUrl) : item
            if (!rawUrl) return null
            try {
              return localAssetFilePathFromUrl(new URL(String(rawUrl), 'http://127.0.0.1').pathname)
            } catch {
              return null
            }
          }
          const seenAssetPaths = new Set()
          const assetPaths = [...assetItems, ...assetUrls]
            .map(resolveClientAssetPath)
            .filter((filePath) => {
              if (!filePath || seenAssetPaths.has(filePath)) return false
              seenAssetPaths.add(filePath)
              return true
            })
          const message = [note, ...assetPaths].filter(Boolean).join('\n')
          if (!message) {
            sendJson(res, 400, { error: '送る内容がありません。' })
            return
          }
          if (!appName) {
            // Copy-only: the browser already wrote the user-session clipboard
            // (this process may live outside that pasteboard session).
            sendJson(res, 200, { copied: true, sent: false, message })
            return
          }

          const runOpen = (args) => new Promise((resolveOpen) => {
            const command = process.platform === 'darwin'
              ? 'open'
              : process.platform === 'win32'
                ? 'powershell.exe'
                : 'xdg-open'
            const commandArgs = process.platform === 'win32'
              ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', args]
              : args
            const child = spawn(command, commandArgs)
            let stderr = ''
            let settled = false
            const finish = (result) => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              resolveOpen(result)
            }
            const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, error: 'open timed out' }) }, 8000)
            child.stderr.on('data', (chunk) => { stderr += chunk })
            child.on('error', (error) => finish({ ok: false, error: error.message }))
            child.on('close', (code) => finish(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() }))
          })
          const powershellLiteral = (value) => `'${String(value ?? '').replace(/'/g, "''")}'`
          const openAppArgs = (appName, files = []) => {
            if (process.platform === 'darwin') return ['-a', appName, ...files]
            if (process.platform === 'win32') {
              const fileList = files.map(powershellLiteral).join(', ')
              const quotedApp = powershellLiteral(appName)
              return files.length
                ? `$ErrorActionPreference = 'Stop'; Start-Process -FilePath ${quotedApp} -ArgumentList @(${fileList})`
                : `$ErrorActionPreference = 'Stop'; Start-Process -FilePath ${quotedApp}`
            }
            return files.length ? [files[0]] : [appName]
          }

          // Text-only auto-send (e.g. Hermes setup requests): paste + Enter
          // via keystrokes — directly when this process can drive the GUI, or
          // through the MCP-side bridge worker (lib/chatBridge.mjs), which
          // runs in the user session where the preview jail cannot.
          const bridgeApp = body.app === 'codex' ? 'codex' : 'claude'
          if (body.autoSend === true && assetPaths.length === 0) {
            const result = await sendChatMessage({ canvasDir, app: bridgeApp, message, autoSend: true })
            if (result.sent) {
              sendJson(res, 200, { copied: true, sent: true, via: result.via, app: appName, message })
              return
            }
          }

          // Claude and current Codex desktop composers accept files via the
          // OS open-file event — the same route as drag & drop, no GUI
          // keystrokes needed. Text prompts become a small .md request file so
          // they ride the same channel when files are being attached.
          const attachViaOpen = appName === 'Claude' || appName === 'Codex'
          let attachFiles = [...assetPaths]
          if (attachViaOpen && note) {
            const requestsDir = join(canvasAssetsDir, 'chat-requests')
            await mkdir(requestsDir, { recursive: true })
            const requestPath = join(requestsDir, `request-${Date.now()}.md`)
            await writeFile(requestPath, `${note}\n`, 'utf8')
            attachFiles = [...attachFiles, requestPath]
          }

          if (attachViaOpen && attachFiles.length > 0) {
            const opened = await runOpen(openAppArgs(appName, attachFiles))
            if (!opened.ok) {
              sendJson(res, 200, { copied: true, sent: false, message, error: `添付できませんでした: ${opened.error}` })
              return
            }
            // Auto-send (Enter) is best-effort: it needs Accessibility and an
            // unsandboxed context; when unavailable the files are attached and
            // the user just presses Enter.
            let sent = false
            if (body.autoSend === true) {
              const pressed = await runOsascript(
                [`tell application "${appName}" to activate`, 'delay 0.6', 'tell application "System Events" to key code 36'].join('\n'),
                5000
              )
              sent = pressed.ok
            }
            sendJson(res, 200, { copied: true, attached: true, sent, app: appName, message })
            return
          }

          // Fallback: paste the message into the input box (no Enter unless
          // autoSend) via keystrokes — direct or through the bridge worker.
          const pasted = await sendChatMessage({ canvasDir, app: bridgeApp, message, autoSend: body.autoSend === true })
          if (pasted.sent) {
            sendJson(res, 200, { copied: true, attached: true, sent: body.autoSend === true, via: pasted.via, app: appName, message })
            return
          }
          // Nothing can type for us: bring the app forward; the message is on
          // the clipboard for a ⌘V.
          await runOpen(openAppArgs(appName))
          sendJson(res, 200, { copied: true, attached: false, sent: false, needsPaste: true, app: appName, message, error: pasted.error })
        } catch (error) {
          sendJson(res, 400, { error: error.message })
        }
      })

      // Learned per-model credit costs (from Lovart's confirmation quotes).
      server.middlewares.use('/api/lovart/model-costs', async (req, res) => {
        try {
          sendJson(res, 200, await getLovartModelCosts())
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })

      server.middlewares.use('/api/lovart/auth-status', async (req, res) => {
        try {
          if (req.method !== 'GET') {
            res.statusCode = 405
            res.setHeader('allow', 'GET')
            res.end()
            return
          }
          sendJson(res, 200, await getLovartAuthStatus())
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })

      server.middlewares.use('/api/lovart/generation-mode', async (req, res) => {
        try {
          if (req.method === 'GET') {
            sendJson(res, 200, await queryLovartGenerationMode())
            return
          }
          if (req.method === 'PUT') {
            const body = JSON.parse(await readRequestBody(req))
            sendJson(res, 200, await setLovartGenerationPreference(body.preference))
            return
          }
          res.statusCode = 405
          res.setHeader('allow', 'GET, PUT')
          res.end()
        } catch (error) {
          sendJson(res, 400, { error: error.message })
        }
      })

      server.middlewares.use('/api/lovart/credentials', async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }
          const body = JSON.parse(await readRequestBody(req))
          sendJson(res, 200, await saveLovartCredentials(body))
        } catch (error) {
          sendJson(res, 400, { error: error.message })
        }
      })

      server.middlewares.use('/api/generate/subtitles', async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }
          const body = JSON.parse(await readRequestBody(req))
          body.glossary = [
            ...(await readProjectGlossary()).terms.filter((term) => term.from),
            ...(Array.isArray(body.glossary) ? body.glossary : [])
          ]
          const generated = await generateSubtitleSrt(body)
          const placement = await insertExcalidrawSubtitle({
            canvasDir,
            srtText: generated.srtText,
            subtitleLines: generated.subtitleLines,
            fileName: body.fileName,
            model: generated.model,
            mode: generated.mode,
            anchorElementId: body.anchorElementId,
            placement: body.placement,
            margin: body.margin,
            customData: body.customData
          })
          // Words sidecar: lets a host agent refine cue boundaries / line
          // breaks / kanji later via /api/subtitles/refine with word-anchored
          // timing (no audio desync possible).
          const wordsFile = await writeSubtitleWordsSidecar(canvasDir, basename(placement.assetFile), {
            words: generated.words,
            lineCount: generated.lineCount,
            maxChars: generated.maxChars,
            model: generated.model,
            mode: generated.mode,
            audioPath: body.audioPath || '',
            durationSeconds: generated.durationSeconds,
            elementId: placement.elementId
          }).catch(() => '')
          sendJson(res, 200, {
            ok: true,
            kind: 'subtitle',
            model: generated.model,
            mode: generated.mode,
            cueCount: generated.subtitleLines.length,
            credits: generated.credits,
            wordsFile,
            ...placement
          })
          broadcastCanvasChanged([canvasFile, placement.assetFile])
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })

      // Host-agent subtitle refinement: rebuilds an existing SRT card from a
      // word-index cue plan (semantic boundaries / line breaks / kanji fixes
      // decided by the agent). Timing comes from the stored word anchors +
      // energy snap, so refined text can never desync from the audio.
      server.middlewares.use('/api/subtitles/refine', async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }
          const body = JSON.parse(await readRequestBody(req))
          const srtFileName = basename(String(body.srtFileName || body.fileName || '').trim())
          if (!srtFileName) {
            sendJson(res, 400, { error: 'srtFileName is required (the existing .srt asset name).' })
            return
          }
          const refined = await refineSubtitleFromPlan({ canvasDir, srtFileName, plan: body.plan })
          const placement = await insertExcalidrawSubtitle({
            canvasDir,
            srtText: refined.srtText,
            subtitleLines: refined.subtitleLines,
            fileName: srtFileName.replace(/\.srt$/i, ''),
            model: refined.sidecar.model,
            mode: 'refined',
            anchorElementId: body.anchorElementId || refined.sidecar.elementId,
            replaceAnchor: true,
            matchAnchor: true,
            customData: body.customData
          })
          // Carry the sidecar forward so the refined card can be refined again.
          const { sidecarPath, ...sidecarPayload } = refined.sidecar
          const wordsFile = await writeSubtitleWordsSidecar(canvasDir, basename(placement.assetFile), {
            ...sidecarPayload,
            elementId: placement.elementId
          }).catch(() => '')
          sendJson(res, 200, {
            ok: true,
            kind: 'subtitle',
            mode: 'refined',
            cueCount: refined.subtitleLines.length,
            wordsFile,
            ...placement
          })
          broadcastCanvasChanged([canvasFile, placement.assetFile])
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })

      server.middlewares.use('/api/video/silence-cut', async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }
          const body = JSON.parse(await readRequestBody(req))
          const cut = await silenceCutVideo({
            inputPath: body.videoPath,
            outputDir: canvasAssetsDir,
            fileName: body.fileName,
            model: body.model || 'elevenlabs-scribe-v2',
            fillerRemoval: body.fillerRemoval,
            coughRemoval: body.coughRemoval,
            retakeRemoval: body.retakeRemoval,
            instructionPrompt: body.instructionPrompt,
            glossary: [
              ...(await readProjectGlossary()).terms.filter((term) => term.from),
              ...(Array.isArray(body.glossary) ? body.glossary : [])
            ],
            detectSeconds: body.detectSeconds,
            thresholdDb: body.thresholdDb,
            keepSeconds: body.keepSeconds,
            preMarginSeconds: body.preMarginSeconds,
            postMarginSeconds: body.postMarginSeconds
          })
          const inputExtension = extname(body.videoPath || '').toLowerCase()
          const inputAsset = body.inputAsset && typeof body.inputAsset === 'object'
            ? body.inputAsset
            : {
                id: `input-${Date.now().toString(36)}`,
                name: basename(body.videoPath || 'input-video'),
                kind: inputExtension === '.xml' ? 'xml' : 'video',
                mimeType: inputExtension === '.xml' ? 'application/xml' : 'video/mp4',
                path: resolve(body.videoPath || ''),
                url: '',
                dataURL: '',
                thumbnail: '',
                duration: cut.inputDuration
              }
          const placement = await insertExcalidrawSilenceCutResult({
            canvasDir,
            assetPath: cut.outputPath,
            fileName: cut.fileName,
            assetUrl: `/excalidraw-assets/${encodeURIComponent(cut.fileName)}`,
            model: cut.model,
            inputDuration: cut.inputDuration,
            outputDuration: cut.outputDuration,
            cutDuration: cut.cutDuration,
            cutCount: cut.cutCount,
            clipCount: cut.clipCount,
            thresholdAuto: cut.thresholdAuto,
            thresholdDbUsed: cut.thresholdDbUsed,
            inputAsset,
            anchorElementId: body.anchorElementId,
            placement: body.placement,
            replaceAnchor: body.replaceAnchor === true,
            matchAnchor: body.matchAnchor === true
          })
          sendJson(res, 200, {
            ok: true,
            kind: 'premiere-xml',
            inputDuration: cut.inputDuration,
            outputDuration: cut.outputDuration,
            cutDuration: cut.cutDuration,
            cutCount: cut.cutCount,
            clipCount: cut.clipCount,
            thresholdAuto: cut.thresholdAuto,
            thresholdDbUsed: cut.thresholdDbUsed,
            fileName: cut.fileName,
            assetPath: cut.outputPath,
            assetUrl: placement.assetUrl,
            elementId: placement.elementId,
            bounds: placement.bounds,
            replacedAnchor: placement.replacedAnchor
          })
          broadcastCanvasChanged([canvasFile, cut.outputPath])
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })

      server.middlewares.use('/api/assets/clipboard', async (req, res) => {
        if (rejectRemoteOperator(req, res)) return
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }
          const body = JSON.parse((await readRequestBody(req)) || '{}')
          const assetItems = Array.isArray(body.assets) ? body.assets : []
          const assetPaths = await resolveClientAssetPaths(assetItems)
          if (assetPaths.length === 0) {
            sendJson(res, 400, { copied: false, error: 'コピーできるファイルがありません。' })
            return
          }
          const copied = await copyFilesToSystemClipboard(assetPaths)
          sendJson(res, 200, {
            copied: true,
            platform: copied.platform,
            mode: copied.mode,
            fileCount: assetPaths.length,
            files: assetPaths.map((filePath) => basename(filePath))
          })
        } catch (error) {
          sendJson(res, 400, { copied: false, error: error.message })
        }
      })

      server.middlewares.use('/api/text/clipboard', async (req, res) => {
        if (rejectRemoteOperator(req, res)) return
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }
          const body = JSON.parse((await readRequestBody(req)) || '{}')
          const text = typeof body.text === 'string' ? body.text : ''
          const copied = await copyTextToSystemClipboard(text)
          sendJson(res, 200, {
            copied: true,
            platform: copied.platform,
            mode: copied.mode
          })
        } catch (error) {
          sendJson(res, 400, { copied: false, error: error.message })
        }
      })

      server.middlewares.use('/api/assets/copy', async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }

          const body = JSON.parse(await readRequestBody(req))
          const sourcePath = resolve(String(body.sourcePath ?? ''))
          const requestedName = basename(String(body.fileName || basename(sourcePath) || 'asset'))
          const { fileName, filePath: destinationPath } = await resolveAvailableCanvasAssetPath(requestedName, { sourcePath })

          await mkdir(canvasAssetsDir, { recursive: true })
          if (destinationPath !== sourcePath) {
            await copyFile(sourcePath, destinationPath)
          }
          sendJson(res, 200, {
            ok: true,
            path: destinationPath,
            url: `${canvasAssetsRoute}${encodeURIComponent(fileName)}`
          })
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })

      server.middlewares.use('/api/assets/upload', async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }

          // Streaming raw-body upload (x-upload-filename header): pipe the
          // request straight to disk with constant memory and no size cap —
          // this is how large/long media (podcast videos, long audio) attach
          // without buffering the whole file in RAM.
          const streamFilenameHeader = req.headers['x-upload-filename']
          if (streamFilenameHeader) {
            const requestedName = basename(decodeURIComponent(String(streamFilenameHeader)))
            const { fileName, filePath: destinationPath } = await resolveAvailableCanvasAssetPath(requestedName || `asset-${Date.now()}`)
            await mkdir(canvasAssetsDir, { recursive: true })
            await new Promise((resolveWrite, rejectWrite) => {
              const out = createWriteStream(destinationPath)
              req.on('error', rejectWrite)
              out.on('error', rejectWrite)
              out.on('finish', resolveWrite)
              req.pipe(out)
            })
            sendJson(res, 200, {
              ok: true,
              path: destinationPath,
              url: `${canvasAssetsRoute}${encodeURIComponent(fileName)}`,
              mimeType: req.headers['content-type'] || mimeTypes.get(extname(fileName).toLowerCase()) || 'application/octet-stream'
            })
            return
          }

          const contentType = String(req.headers['content-type'] || '').toLowerCase()
          if (contentType.includes('multipart/form-data')) {
            const request = new Request('http://127.0.0.1/api/assets/upload', {
              method: 'POST',
              headers: req.headers,
              body: Readable.toWeb(req),
              duplex: 'half'
            })
            const formData = await request.formData()
            const file = formData.get('file')
            if (!(file instanceof File)) {
              sendJson(res, 400, { error: 'Expected multipart file field.' })
              return
            }

            const requestedName = basename(String(formData.get('fileName') || file.name || `asset-${Date.now()}`))
            const { fileName, filePath: destinationPath } = await resolveAvailableCanvasAssetPath(requestedName)

            await mkdir(canvasAssetsDir, { recursive: true })
            await writeFile(destinationPath, Buffer.from(await file.arrayBuffer()))
            sendJson(res, 200, {
              ok: true,
              path: destinationPath,
              url: `${canvasAssetsRoute}${encodeURIComponent(fileName)}`,
              mimeType: file.type || mimeTypes.get(extname(fileName).toLowerCase()) || 'application/octet-stream'
            })
            return
          }

          const body = JSON.parse(await readRequestBody(req))

          // Local-path import: when the webview exposes the picked file's
          // path (Electron), skip the HTTP transfer entirely and clone the
          // file on disk — APFS copy-on-write makes multi-GB attach instant.
          if (typeof body.sourcePath === 'string' && body.sourcePath) {
            const sourcePath = resolve(String(body.sourcePath))
            const sourceStat = await stat(sourcePath).catch(() => null)
            if (!sourceStat?.isFile()) {
              sendJson(res, 400, { error: 'ソースファイルが見つかりません。' })
              return
            }
            const requestedName = basename(String(body.fileName || sourcePath))
            const { fileName, filePath: destinationPath } = await resolveAvailableCanvasAssetPath(requestedName || `asset-${Date.now()}`, { sourcePath })
            await mkdir(canvasAssetsDir, { recursive: true })
            if (destinationPath !== sourcePath) {
              // FICLONE clones instantly on APFS; falls back to a real copy on
              // other filesystems (still no HTTP round-trip).
              await copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_FICLONE)
            }
            sendJson(res, 200, {
              ok: true,
              path: destinationPath,
              url: `${canvasAssetsRoute}${encodeURIComponent(fileName)}`,
              mimeType: mimeTypes.get(extname(fileName).toLowerCase()) || 'application/octet-stream'
            })
            return
          }

          const dataUrl = String(body.dataURL ?? '')
          const match = dataUrl.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/s)
          if (!match) {
            sendJson(res, 400, { error: 'Expected a base64 dataURL.' })
            return
          }

          const requestedName = basename(String(body.fileName || `asset-${Date.now()}`))
          const { fileName, filePath: destinationPath } = await resolveAvailableCanvasAssetPath(requestedName)

          await mkdir(canvasAssetsDir, { recursive: true })
          const buffer = Buffer.from(match[2], 'base64')
          await writeFile(destinationPath, buffer)
          sendJson(res, 200, {
            ok: true,
            path: destinationPath,
            url: `${canvasAssetsRoute}${encodeURIComponent(fileName)}`,
            mimeType: match[1] || 'application/octet-stream'
          })
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })
}

export function canvasStoragePlugin() {
  return {
    name: 'codex-excalidraw-storage',
    configureServer: configureCanvasServer,
    configurePreviewServer: configureCanvasServer
  }
}

export default defineConfig({
  plugins: [react(), canvasStoragePlugin()],
  resolve: {
    alias: {
      'roughjs/bin/rough': resolve('node_modules/roughjs/bin/rough.js')
    }
  },
  server: {
    host: '127.0.0.1',
    port: defaultPort
  },
  build: widgetBuild
    ? {
        outDir: process.env.BUZZASSIST_WIDGET_OUT_DIR || 'dist-widget',
        emptyOutDir: true,
        assetsInlineLimit: Number.MAX_SAFE_INTEGER,
        cssCodeSplit: false,
        rollupOptions: {
          output: {
            inlineDynamicImports: true,
            entryFileNames: 'assets/index.js',
            assetFileNames: 'assets/[name][extname]'
          }
        }
      }
    : undefined
})
