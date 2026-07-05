// Bridge between the browser canvas and local AI chat apps (Claude Code
// desktop "Claude" / "Codex"). Pasting into those apps needs osascript in the
// user's GUI session with automation consent. The vite dev server often runs
// inside the in-app preview jail where Apple Events silently hang, so sends
// are queued as files under canvas/.chat-bridge and executed by whichever
// long-lived process CAN drive the GUI — normally the MCP stdio server that
// Claude Code / Codex spawn in the user session (see startChatBridgeWorker).
import { mkdir, readFile, writeFile, rename, unlink, readdir, stat } from 'node:fs/promises'
import { watch } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const BRIDGE_DIRNAME = '.chat-bridge'
const HEARTBEAT_FILE = 'heartbeat'
const HEARTBEAT_INTERVAL_MS = 20_000
const HEARTBEAT_FRESH_MS = 60_000
const REQUEST_STALE_MS = 120_000
const RESULT_WAIT_MS = 6_000

const APP_NAMES = { claude: 'Claude', codex: 'Codex' }

function bridgeDir(canvasDir) {
  return join(canvasDir, BRIDGE_DIRNAME)
}

function quoteAppleScriptString(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n')
}

function appleScriptFileList(filePaths) {
  const files = filePaths
    .map((filePath) => String(filePath || '').trim())
    .filter(Boolean)
    .map((filePath) => `(POSIX file "${quoteAppleScriptString(filePath)}")`)
  return files.length === 1 ? files[0] : `{${files.join(', ')}}`
}

// osascript can hang forever when macOS parks the Apple Events request on a
// consent prompt it cannot display — every call races an explicit timeout.
export function runOsascript(script, timeoutMs = 8000) {
  return new Promise((resolveOsa) => {
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
}

// Put the message on the user-session clipboard, bring the app forward, and
// paste. autoSend additionally presses Enter (used for "run this setup"
// requests); plain attach leaves the message in the input box.
export async function pasteIntoChatApp({ app, message, autoSend = false }) {
  const appName = APP_NAMES[app] || String(app || '')
  if (!appName) return { ok: false, error: '送信先アプリが指定されていません。' }
  const quoted = quoteAppleScriptString(message)
  const clip = await runOsascript(`set the clipboard to "${quoted}"`, 4000)
  if (!clip.ok) return clip
  const script = [
    `tell application "${appName}" to activate`,
    'delay 0.5',
    'tell application "System Events" to keystroke "v" using command down',
    ...(autoSend ? ['delay 0.3', 'tell application "System Events" to key code 36'] : [])
  ].join('\n')
  return runOsascript(script, 10_000)
}

export async function pasteFilesIntoChatApp({ app, filePaths, message = '', autoSend = false }) {
  const appName = APP_NAMES[app] || String(app || '')
  if (!appName) return { ok: false, error: '送信先アプリが指定されていません。' }
  const paths = Array.isArray(filePaths) ? filePaths.map((item) => String(item || '').trim()).filter(Boolean) : []
  if (paths.length === 0) return pasteIntoChatApp({ app, message, autoSend })
  const script = [
    `set the clipboard to ${appleScriptFileList(paths)}`,
    `tell application "${appName}" to activate`,
    'delay 0.6',
    'tell application "System Events" to keystroke "v" using command down'
  ]
  if (String(message || '').trim()) {
    script.push(
      'delay 0.4',
      `set the clipboard to "${quoteAppleScriptString(message)}"`,
      'delay 0.1',
      'tell application "System Events" to keystroke "v" using command down'
    )
  }
  if (autoSend) {
    script.push('delay 0.4', 'tell application "System Events" to key code 36')
  }
  return runOsascript(script.join('\n'), 12_000)
}

let guiProbe = null
export async function canDriveGui() {
  if (guiProbe === null) {
    const probe = await runOsascript('tell application "System Events" to count processes', 2500)
    guiProbe = probe.ok
  }
  return guiProbe
}

export async function bridgeWorkerAlive(canvasDir) {
  try {
    const info = await stat(join(bridgeDir(canvasDir), HEARTBEAT_FILE))
    return Date.now() - info.mtimeMs < HEARTBEAT_FRESH_MS
  } catch {
    return false
  }
}

// Deliver a message to a chat app: directly when this process can drive the
// GUI, otherwise queued for a bridge worker. Resolves with
// { sent, via } | { sent:false, queued, bridgeAlive, error? }.
export async function sendChatMessage({ canvasDir, app, message, autoSend = false, filePaths = [] }) {
  const paths = Array.isArray(filePaths) ? filePaths.map((item) => String(item || '').trim()).filter(Boolean) : []
  if (await canDriveGui()) {
    const direct = paths.length > 0
      ? await pasteFilesIntoChatApp({ app, filePaths: paths, message, autoSend })
      : await pasteIntoChatApp({ app, message, autoSend })
    if (direct.ok) return { sent: true, via: 'direct' }
  }
  const dir = bridgeDir(canvasDir)
  await mkdir(dir, { recursive: true })
  const alive = await bridgeWorkerAlive(canvasDir)
  const id = randomUUID()
  await writeFile(join(dir, `req-${id}.json`), JSON.stringify({ id, app, message, filePaths: paths, autoSend: autoSend === true, created: Date.now() }))
  if (!alive) return { sent: false, queued: true, bridgeAlive: false }
  const resultFile = join(dir, `res-${id}.json`)
  const deadline = Date.now() + RESULT_WAIT_MS
  while (Date.now() < deadline) {
    try {
      const payload = JSON.parse(await readFile(resultFile, 'utf8'))
      unlink(resultFile).catch(() => {})
      return payload
    } catch {
      await new Promise((wait) => setTimeout(wait, 150))
    }
  }
  return { sent: false, queued: true, bridgeAlive: true }
}

// Run inside a user-session process (the MCP stdio server): heartbeat so
// enqueuers know a worker exists, and execute queued paste requests. Claim
// via atomic rename so concurrent workers (Claude Code + Codex sessions)
// never double-paste. Returns a stop function.
export function startChatBridgeWorker({ canvasDir }) {
  const dir = bridgeDir(canvasDir)
  let watcher = null
  let processing = false

  const beat = async () => {
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, HEARTBEAT_FILE), String(Date.now()))
    } catch {}
  }

  const processRequests = async () => {
    if (processing) return
    processing = true
    try {
      let entries = []
      try {
        entries = await readdir(dir)
      } catch {
        return
      }
      for (const name of entries) {
        if (!name.startsWith('req-') || !name.endsWith('.json')) continue
        const claimed = join(dir, `${name}.claimed-${process.pid}`)
        try {
          await rename(join(dir, name), claimed)
        } catch {
          continue // another worker claimed it first
        }
        try {
          const request = JSON.parse(await readFile(claimed, 'utf8'))
          if (Date.now() - (Number(request.created) || 0) > REQUEST_STALE_MS) continue
          const result = Array.isArray(request.filePaths) && request.filePaths.length > 0
            ? await pasteFilesIntoChatApp(request)
            : await pasteIntoChatApp(request)
          await writeFile(
            join(dir, `res-${request.id}.json`),
            JSON.stringify(result.ok ? { sent: true, via: 'bridge' } : { sent: false, queued: false, error: result.error })
          )
        } catch {} finally {
          unlink(claimed).catch(() => {})
        }
      }
    } finally {
      processing = false
    }
  }

  beat().then(processRequests)
  const heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS)
  const pollTimer = setInterval(processRequests, 1500)
  heartbeatTimer.unref?.()
  pollTimer.unref?.()
  try {
    watcher = watch(dir, () => { processRequests() })
    watcher.unref?.()
  } catch {}
  return () => {
    clearInterval(heartbeatTimer)
    clearInterval(pollTimer)
    watcher?.close()
  }
}
