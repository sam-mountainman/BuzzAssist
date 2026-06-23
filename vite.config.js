import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { generateImageMedia, generateVideoMedia, getGenerationCapabilities } from './lib/mediaGeneration.mjs'
import { insertExcalidrawImage, insertExcalidrawVideo } from './lib/canvasScene.mjs'

const projectDir = resolve(process.env.EXCALIDRAW_PROJECT_DIR ?? process.cwd())
const canvasDir = resolve(process.env.EXCALIDRAW_CANVAS_DIR ?? join(projectDir, 'canvas'))
const canvasFile = join(canvasDir, 'excalidraw-canvas.json')
const selectionFile = join(canvasDir, 'excalidraw-selection.json')
const viewStateFile = join(canvasDir, 'excalidraw-view-state.json')
const canvasAssetsDir = join(canvasDir, 'assets')
const canvasAssetsRoute = '/excalidraw-assets/'
const defaultPort = Number(process.env.EXCALIDRAW_PORT ?? 43219)

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
  ['.webm', 'video/webm']
])

const canvasEventClients = new Set()
let canvasEventVersion = 0

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
      if (body.length > 50 * 1024 * 1024) {
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

function isScene(value) {
  return value && typeof value === 'object' && Array.isArray(value.elements)
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

  return {
    type: value.type ?? 'excalidraw',
    version: value.version ?? 2,
    source: value.source ?? 'codex-excalidraw-canvas',
    elements: value.elements,
    appState: value.appState && typeof value.appState === 'object' ? value.appState : {},
    files: value.files && typeof value.files === 'object' ? value.files : {}
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
  await mkdir(dirname(filePath), { recursive: true })
  const tempFile = `${filePath}.${process.pid}.tmp`
  await writeFile(tempFile, `${JSON.stringify(payload, null, 2)}\n`)
  await rename(tempFile, filePath)
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

function canvasStoragePlugin() {
  return {
    name: 'codex-excalidraw-storage',
    configureServer(server) {
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
            const scene = normalizeScene(JSON.parse(body))
            if (!isScene(scene)) {
              sendJson(res, 400, { error: 'Expected an Excalidraw scene.' })
              return
            }

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
            fileName: body.fileName || media.fileName,
            anchorElementId: body.anchorElementId,
            sourceElementId: body.sourceElementId,
            placement: body.placement,
            margin: body.margin,
            matchAnchor: body.matchAnchor,
            replaceAnchor: body.replaceAnchor,
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
            fileName: body.fileName || media.fileName,
            anchorElementId: body.anchorElementId,
            sourceElementId: body.sourceElementId,
            placement: body.placement,
            margin: body.margin,
            matchAnchor: body.matchAnchor,
            replaceAnchor: body.replaceAnchor,
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
          const safeName = requestedName.replace(/[^a-zA-Z0-9._-]+/g, '-')
          const destinationPath = resolve(canvasAssetsDir, safeName)
          if (!isSafeChildPath(canvasAssetsDir, destinationPath)) {
            sendJson(res, 403, { error: 'Unsafe destination path.' })
            return
          }

          await mkdir(canvasAssetsDir, { recursive: true })
          await copyFile(sourcePath, destinationPath)
          sendJson(res, 200, {
            ok: true,
            path: destinationPath,
            url: `${canvasAssetsRoute}${encodeURIComponent(safeName)}`
          })
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })
    }
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
