import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createReadStream, createWriteStream, constants as fsConstants } from 'node:fs'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
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
import { getBuzzAssistAuthStatus, loginBuzzAssistViaBrowser } from './lib/buzzassistApi.mjs'
import { OFFICIAL_EXCALIDRAW_README, createExcalidrawView, insertExcalidrawImage, insertExcalidrawSubtitle, insertExcalidrawVideo, insertExcalidrawMediaBatch, performCanvasMaintenance, stripAssetBackedFileDataURLs } from './lib/canvasScene.mjs'
import { streamZipStore } from './lib/zipStore.mjs'
import { generateSubtitleSrt } from './lib/subtitleGeneration.mjs'
import { silenceCutVideo } from './lib/tempoCut.mjs'
import { getLovartAuthStatus, getLovartModelCosts, saveLovartCredentials } from './lib/lovartMediaGeneration.mjs'
import { bridgeWorkerAlive, canDriveGui, pasteIntoChatApp, sendChatMessage } from './lib/chatBridge.mjs'
import { getOrCreateMcpToken, rejectDisallowedOrigin, rejectMissingBearer, setLocalCorsHeaders, writeServerDiscovery } from './lib/canvasServerRuntime.mjs'
import { tmpdir } from 'node:os'

const projectDir = resolve(process.env.EXCALIDRAW_PROJECT_DIR ?? process.cwd())
const canvasDir = resolve(process.env.EXCALIDRAW_CANVAS_DIR ?? join(projectDir, 'canvas'))
const canvasFile = join(canvasDir, 'excalidraw-canvas.json')
const selectionFile = join(canvasDir, 'excalidraw-selection.json')
const viewStateFile = join(canvasDir, 'excalidraw-view-state.json')
const canvasAssetsDir = join(canvasDir, 'assets')
const canvasAssetsRoute = '/excalidraw-assets/'
const defaultPort = Number(process.env.EXCALIDRAW_PORT ?? 43219)
const defaultHost = process.env.EXCALIDRAW_HOST || '127.0.0.1'
const mcpToken = getOrCreateMcpToken()

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
    elements: restoreAssetBackedImageStatuses(value.elements, files),
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

function broadcastCanvasChanged(paths) {
  const payload = {
    version: ++canvasEventVersion,
    updatedAt: new Date().toISOString(),
    paths
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

function localAssetFilePathFromUrl(pathname) {
  if (!pathname.startsWith(canvasAssetsRoute)) return null
  const requestedPath = decodeURIComponent(pathname.slice(canvasAssetsRoute.length))
  const filePath = resolve(canvasAssetsDir, requestedPath)
  return isSafeChildPath(canvasAssetsDir, filePath) ? filePath : null
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
    res.statusCode = 200
    res.setHeader('content-type', mimeTypes.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream')
    res.setHeader('content-length', String(fileStat.size))
    res.setHeader('cache-control', 'no-cache')
    if (url.searchParams.get('download')) {
      res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(basename(filePath))}`)
    }
    createReadStream(filePath).pipe(res)
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
  server.watcher.add(canvasFile)
  let canvasWatchTimer = null
  server.watcher.on('change', (changedPath) => {
    if (resolve(changedPath) !== canvasFile) return
    clearTimeout(canvasWatchTimer)
    canvasWatchTimer = setTimeout(() => {
      broadcastCanvasChanged([canvasFile])
    }, 120)
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
            const scene = normalizeScene(payload)
            if (!isScene(scene)) {
              sendJson(res, 400, { error: 'Expected an Excalidraw scene.' })
              return
            }
            if (scene.elements.length === 0 && payload?.allowClearCanvas !== true) {
              try {
                const existingScene = normalizeScene(await readJsonFile(canvasFile))
                if (existingScene.elements.length > 0) {
                  sendJson(res, 409, {
                    error: 'Refusing to replace a non-empty Excalidraw canvas with an empty scene.',
                    existingElementCount: existingScene.elements.length
                  })
                  return
                }
              } catch (error) {
                if (error.code !== 'ENOENT') throw error
              }
            }

            // Strip inline base64 for file records verifiably backed by an
            // on-disk asset (keeps drag-dropped images and video posters inline).
            await stripAssetBackedFileDataURLs(scene)
            await writeJsonAtomic(canvasFile, scene)
            sendJson(res, 200, { ok: true, path: canvasFile, storage: 'single-file' })
            broadcastCanvasChanged([canvasFile])
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
          sendJson(res, 200, await getBuzzAssistAuthStatus())
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })

      server.middlewares.use('/api/buzzassist/login', async (req, res) => {
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

          sendJson(res, 200, {
            ok: true,
            kind: 'image',
            model: media.model,
            ...result
          })
          broadcastCanvasChanged([canvasFile, result.assetFile])
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
              videoGenerateAudio: body.generateAudio ?? body.generate_audio,
              codexGenerationSource: media.source,
              ...(body.customData && typeof body.customData === 'object' ? body.customData : {})
            }
          })

          sendJson(res, 200, {
            ok: true,
            kind: 'video',
            model: media.model,
            ...result
          })
          broadcastCanvasChanged([canvasFile, result.assetFile])
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
        sendJson(res, 200, { clients: canvasEventClients.size })
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
      // copy the text to the clipboard, activate the app, then paste + Enter
      // via System Events. If keystrokes are blocked (no Accessibility
      // permission) the text is still on the clipboard for a manual paste.
      server.middlewares.use('/api/chat/send', async (req, res) => {
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
            const child = spawn('open', args)
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

          // Claude's composer accepts any file (public.data Viewer) via the
          // open-file event — the same route as drag & drop, no permissions
          // needed. Text prompts become a small .md request file so they ride
          // the same channel.
          const attachViaOpen = appName === 'Claude'
          let attachFiles = [...assetPaths]
          if (attachViaOpen && note && assetPaths.length === 0) {
            const requestsDir = join(canvasAssetsDir, 'chat-requests')
            await mkdir(requestsDir, { recursive: true })
            const requestPath = join(requestsDir, `request-${Date.now()}.md`)
            await writeFile(requestPath, `${note}\n`, 'utf8')
            attachFiles = [requestPath]
          }

          if (attachViaOpen && attachFiles.length > 0) {
            const opened = await runOpen(['-a', appName, ...attachFiles])
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

          // Codex: no open-file route into the composer, so paste the message
          // into the input box (no Enter unless autoSend) via keystrokes —
          // direct or through the bridge worker.
          const pasted = await sendChatMessage({ canvasDir, app: bridgeApp, message, autoSend: body.autoSend === true })
          if (pasted.sent) {
            sendJson(res, 200, { copied: true, attached: true, sent: body.autoSend === true, via: pasted.via, app: appName, message })
            return
          }
          // Nothing can type for us: bring the app forward; the message is on
          // the clipboard for a ⌘V.
          await runOpen(['-a', appName])
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
          sendJson(res, 200, {
            ok: true,
            kind: 'subtitle',
            model: generated.model,
            mode: generated.mode,
            cueCount: generated.subtitleLines.length,
            credits: generated.credits,
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
          // Output is a non-destructive Premiere XML written into
          // canvas/assets (downloadable) — no canvas element is created.
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
            assetUrl: `/excalidraw-assets/${cut.fileName}`
          })
        } catch (error) {
          sendJson(res, 500, { error: error.message })
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
  }
})
