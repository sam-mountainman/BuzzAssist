import {
  CaptureUpdateAction,
  Excalidraw,
  convertToExcalidrawElements
} from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { generateKeyBetween } from 'fractional-indexing'
import { useCallback, useEffect, useRef, useState } from 'react'

const CANVAS_ENDPOINT = '/api/canvas'
const CANVAS_EVENTS_ENDPOINT = '/api/canvas-events'
const GENERATE_IMAGE_ENDPOINT = '/api/generate/image'
const GENERATE_VIDEO_ENDPOINT = '/api/generate/video'
const GENERATION_CAPABILITIES_ENDPOINT = '/api/generation-capabilities'
const ASSET_UPLOAD_ENDPOINT = '/api/assets/upload'
const SELECTION_ENDPOINT = '/api/selection'
const VIEW_STATE_ENDPOINT = '/api/view-state'
const AI_HOLDER_KEY = 'codexAiImageHolder'
const GENERATOR_FRAME_TAG = 'buzzassist.imageGenerator.frame'
const VIDEO_GENERATOR_FRAME_TAG = 'buzzassist.videoGenerator.frame'
const GENERATOR_FRAME_BORDER_COLOR = '#c4a5f7'
const GENERATOR_FRAME_FILL_COLOR = '#e8ddf5'
const GENERATOR_FRAME_STROKE_WIDTH = 1
const GENERATOR_PANEL_ESTIMATED_HEIGHT = 190
const GENERATOR_FRAME_TOP_RESERVE = 70
const GENERATOR_FRAME_EDGE_MARGIN = 28
const GENERATOR_FRAME_MIN_SCENE_SIZE = 140
const GENERATOR_PANEL_IMAGE_MIN_WIDTH = 420
const GENERATOR_PANEL_IMAGE_MAX_WIDTH = 560
const GENERATOR_PANEL_VIDEO_WIDTH = 580
const GENERATOR_SCROLL_ANIMATION_MS = 600
const SAVE_DELAY_MS = 450
const SELECTION_DELAY_MS = 180
const CANVAS_ASSETS_ROUTE = '/excalidraw-assets/'
const ASSET_HYDRATION_CONCURRENCY = 6
const VIDEO_POSTER_FALLBACK_DATA_URL =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjgwIDcyMCI+PHJlY3Qgd2lkdGg9IjEyODAiIGhlaWdodD0iNzIwIiBmaWxsPSIjMTExODI3Ii8+PHBhdGggZD0iTTU2MCAyNTB2MjIwbDE5MC0xMTB6IiBmaWxsPSIjZmZmIiBvcGFjaXR5PSIuOSIvPjwvc3ZnPg=='

if (typeof window !== 'undefined' && !window.__lovartClipboardShortcutInstalled) {
  window.__lovartClipboardShortcutInstalled = true
  const onEarlyClipboardEvent = (event) => {
    if (typeof window.__lovartHandleClipboardShortcut !== 'function') return
    if (window.__lovartHandleClipboardShortcut(event) !== true) return
    event.preventDefault()
    event.stopPropagation()
    if (typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation()
    }
  }
  window.addEventListener('keydown', onEarlyClipboardEvent, true)
  window.addEventListener('copy', onEarlyClipboardEvent, true)
  window.addEventListener('paste', onEarlyClipboardEvent, true)
}

const DEFAULT_SCENE = {
  type: 'excalidraw',
  version: 2,
  source: 'codex-excalidraw-canvas',
  elements: [],
  appState: {
    viewBackgroundColor: '#ffffff'
  },
  files: {}
}

const DEFAULT_FRAME_FORM = {
  prompt: '',
  imageModel: 'gpt-image-2-codex',
  videoModel: 'grok-imagine-video-hermes',
  aspectRatio: '1:1',
  videoAspectRatio: '16:9',
  quality: 'auto',
  duration: '5',
  resolution: '720p',
  imageReferences: [],
  videoTab: 'keyframe',
  videoStartFrame: null,
  videoEndFrame: null,
  videoReferenceImages: [],
  videoReferenceVideos: [],
  videoReferenceAudios: [],
  videoGenerateAudio: true,
}

const IMAGE_ASPECTS = {
  '21:9': { baseWidth: 1568, baseHeight: 672 },
  '16:9': { baseWidth: 1456, baseHeight: 816 },
  '4:3': { baseWidth: 1232, baseHeight: 928 },
  '3:2': { baseWidth: 1344, baseHeight: 896 },
  '1:1': { baseWidth: 1024, baseHeight: 1024 },
  '9:16': { baseWidth: 816, baseHeight: 1456 },
  '3:4': { baseWidth: 928, baseHeight: 1232 },
  '2:3': { baseWidth: 896, baseHeight: 1344 },
  '5:4': { baseWidth: 1280, baseHeight: 1024 },
  '4:5': { baseWidth: 1024, baseHeight: 1280 }
}

const VIDEO_ASPECTS = {
  '16:9': { width: 364, height: 205 },
  '9:16': { width: 205, height: 364 },
  '1:1': { width: 256, height: 256 },
  '4:3': { width: 340, height: 255 },
  '3:4': { width: 255, height: 340 },
  '3:2': { width: 340, height: 227 },
  '2:3': { width: 227, height: 340 },
  '21:9': { width: 378, height: 162 }
}

function isGrokVideoModel(model) {
  return model === 'grok-imagine-video-hermes'
}

// Audio reference is only meaningful for models that consume an audio track
// (Seedance family in the reference). For the default Grok model it is hidden,
// matching Youtube-AGI and keeping the panel to image+video references.
function supportsAudioReference(model) {
  return /seedance/i.test(String(model || ''))
}

function getVideoFrameSlotMediaKind(tab, target) {
  if (tab === 'reference') return target === 'start' ? 'video' : 'image'
  return 'image'
}

function canUseVideoFrameTarget(model, tab, target) {
  if (!isGrokVideoModel(model)) return true
  if (tab === 'keyframe' && target === 'end') return false
  // Note: the reference restricts Grok reference to image-only, but the user
  // wants both image and video attachable on the video generator, so the video
  // (start) slot stays enabled here.
  return true
}

function getVideoFrameSlotLabel(tab, target) {
  if (tab === 'reference') return target === 'start' ? '動画' : '画像'
  return target === 'start' ? '開始\nフレーム' : '終了\nフレーム'
}

function getVideoFrameUploadLabel(tab, target) {
  if (target === 'audio') return '音声をアップロード'
  return getVideoFrameSlotMediaKind(tab, target) === 'video' ? '動画をアップロード' : '画像をアップロード'
}

function getUploadTargetKind(target) {
  if (target === 'videoReferenceVideos') return 'video'
  if (target === 'videoReferenceAudios') return 'audio'
  return 'image'
}

function getUploadTargetAccept(target) {
  const kind = getUploadTargetKind(target)
  if (kind === 'video') return 'video/*'
  if (kind === 'audio') return 'audio/*'
  return 'image/*'
}

function getCanvasPickTargetFromEventTarget(target) {
  let node = target
  while (node) {
    if (typeof node.getAttribute === 'function') {
      const value = node.getAttribute('data-lovart-canvas-pick-target')
      if (value) return value
    }
    node = node.parentElement || node.parentNode || null
  }
  return ''
}

function getCanvasPickTargetFromPointerEvent(event) {
  const directTarget = getCanvasPickTargetFromEventTarget(event?.target)
  if (directTarget) return directTarget
  if (typeof document === 'undefined') return ''
  const clientX = Number(event?.clientX)
  const clientY = Number(event?.clientY)
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return ''
  const buttons = Array.from(document.querySelectorAll('[data-lovart-canvas-pick-target]'))
  for (const button of buttons) {
    const rect = button.getBoundingClientRect()
    if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
      return button.getAttribute('data-lovart-canvas-pick-target') || ''
    }
  }
  return ''
}

const IMAGE_QUALITY_OPTIONS = [
  ['auto', 'Auto'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High']
]

function ImageGeneratorToolIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 8h.01" />
      <path d="M12.5 21H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v6.5" />
      <path d="M3 16l5-5c.928-.893 2.072-.893 3 0l3.5 3.5" />
      <path d="M14 14l1-1c.31-.298.644-.497.987-.596" />
      <path d="M16 19h6" />
      <path d="M19 16v6" />
    </svg>
  )
}

function VideoGeneratorToolIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 10l4.553-2.276a1 1 0 0 1 1.447.894v6.764a1 1 0 0 1-1.447.894L15 14z" />
      <rect x="3" y="6" width="12" height="12" rx="2" />
      <path d="M7 12h4" />
      <path d="M9 10v4" />
    </svg>
  )
}

function LightningIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" fill="currentColor" />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M5 7.5l5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PhotoIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M8 10l-5 7h18l-4-5-3.5 3z" fill="currentColor" />
      <circle cx="15.5" cy="9.5" r="1.5" fill="currentColor" />
    </svg>
  )
}

function UploadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 16V4m0 0L8 8m4-4l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function CanvasPickIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M9 3v18M3 9h18" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}

function swapVideoKeyframes(form) {
  return {
    ...form,
    videoStartFrame: form.videoEndFrame || null,
    videoEndFrame: form.videoStartFrame || null
  }
}

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  )
}

function FrameCenterIcon({ size = 52 }) {
  const height = Math.max(6, Math.round(size * (60 / 84)))
  const strokeMain = Math.max(1.2, Math.round(size * 0.072 * 10) / 10)
  const strokeSub = Math.max(1.1, Math.round(size * 0.066 * 10) / 10)
  const dotRadius = Math.max(1, Math.round(size * 0.048 * 10) / 10)
  return (
    <svg width={size} height={height} viewBox="0 0 84 60" fill="none" aria-hidden="true">
      <path d="M10 50L35 18L58 50" stroke="currentColor" strokeWidth={strokeMain} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M35 50L49 33L61 50" stroke="currentColor" strokeWidth={strokeSub} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="55" cy="20" r={dotRadius} fill="currentColor" />
    </svg>
  )
}

function VideoCenterIcon({ size = 52 }) {
  const height = Math.max(6, Math.round(size * (60 / 84)))
  const strokeMain = Math.max(1.2, Math.round(size * 0.072 * 10) / 10)
  return (
    <svg width={size} height={height} viewBox="0 0 84 60" fill="none" aria-hidden="true">
      <rect x="8" y="4" width="68" height="52" rx="6" stroke="currentColor" strokeWidth={strokeMain} />
      <path d="M34 18v24l20-12z" stroke="currentColor" strokeWidth={strokeMain} strokeLinejoin="round" />
    </svg>
  )
}

function AudioWaveIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="7" width="2" height="10" rx="1" fill="currentColor" />
      <rect x="8" y="4" width="2" height="16" rx="1" fill="currentColor" />
      <rect x="12" y="8" width="2" height="8" rx="1" fill="currentColor" />
      <rect x="16" y="3" width="2" height="18" rx="1" fill="currentColor" />
      <rect x="20" y="7" width="2" height="10" rx="1" fill="currentColor" />
    </svg>
  )
}

function formatAssetDuration(seconds) {
  const totalSeconds = Math.max(0, Math.round(Number(seconds) || 0))
  const minutes = Math.floor(totalSeconds / 60)
  const rest = totalSeconds % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

function normalizeScene(scene) {
  if (!scene || typeof scene !== 'object' || !Array.isArray(scene.elements)) {
    return DEFAULT_SCENE
  }

  return {
    type: scene.type ?? 'excalidraw',
    version: scene.version ?? 2,
    source: scene.source ?? 'codex-excalidraw-canvas',
    elements: scene.elements,
    appState: scene.appState && typeof scene.appState === 'object' ? scene.appState : {},
    files: normalizeExcalidrawFiles(scene.files)
  }
}

function normalizeDataURL(dataURL) {
  if (typeof dataURL !== 'string' || !dataURL.startsWith('data:')) return dataURL
  const commaIndex = dataURL.indexOf(',')
  if (commaIndex < 0) return dataURL
  const meta = dataURL.slice(0, commaIndex)
  const body = dataURL.slice(commaIndex + 1)
  if (/;base64/i.test(meta)) return dataURL
  if (!meta.toLowerCase().startsWith('data:image/svg+xml')) return dataURL
  try {
    const decoded = decodeURIComponent(body)
    const base64 = window.btoa(unescape(encodeURIComponent(decoded)))
    return 'data:image/svg+xml;base64,' + base64
  } catch {
    return dataURL
  }
}

function normalizeExcalidrawFiles(files) {
  if (!files || typeof files !== 'object') return {}
  let changed = false
  const next = {}
  for (const [id, file] of Object.entries(files)) {
    if (!file || typeof file !== 'object') continue
    const dataURL = normalizeDataURL(file.dataURL)
    next[id] = dataURL === file.dataURL ? file : { ...file, dataURL }
    if (next[id] !== file) changed = true
  }
  return changed ? next : files
}

// Disk-backed file records store their asset URL ('/excalidraw-assets/...') in
// dataURL instead of inline base64 so the scene JSON stays small. They are
// hydrated back to base64 client-side before being handed to Excalidraw.
function isAssetBackedFileRecord(file) {
  return typeof file?.dataURL === 'string' && file.dataURL.startsWith(CANVAS_ASSETS_ROUTE)
}

const assetDataURLCache = new Map()

function fetchAssetDataURL(url) {
  let pending = assetDataURLCache.get(url)
  if (pending) return pending
  pending = (async () => {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to load asset ${url}: ${response.status}`)
    const blob = await response.blob()
    return await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(reader.error || new Error(`Failed to read asset ${url}`))
      reader.onload = () => resolve(String(reader.result || ''))
      reader.readAsDataURL(blob)
    })
  })()
  pending.catch(() => {
    if (assetDataURLCache.get(url) === pending) assetDataURLCache.delete(url)
  })
  assetDataURLCache.set(url, pending)
  return pending
}

// Fetch asset-backed file records (concurrency-limited) and hand each hydrated
// record to `onHydrated` as it resolves, so the scene renders immediately and
// images pop in as their assets load.
async function hydrateAssetBackedFiles(files, onHydrated) {
  const pending = Object.values(files ?? {}).filter(isAssetBackedFileRecord)
  if (pending.length === 0) return
  let cursor = 0
  const worker = async () => {
    while (cursor < pending.length) {
      const file = pending[cursor]
      cursor += 1
      const url = file.dataURL
      try {
        const dataURL = await fetchAssetDataURL(url)
        onHydrated({ ...file, dataURL, codexAssetBacked: true, codexAssetUrl: url })
      } catch (error) {
        console.error(error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(ASSET_HYDRATION_CONCURRENCY, pending.length) }, worker))
}

// Inverse of hydration for the save path: swap hydrated base64 back to the
// asset URL so PUT /api/canvas payloads stay small over the wire. Only records
// verifiably asset-backed are stripped (marked codexAssetBacked during
// hydration, or their element customData points at a canvas asset). Video
// posters and drag-dropped inline images keep their inline base64.
function stripAssetBackedFilesForSave(elements, files) {
  if (!files || typeof files !== 'object') return files
  const videoFileIds = new Set()
  const assetUrlByFileId = new Map()
  for (const element of elements ?? []) {
    if (!element?.fileId) continue
    const customData = element.customData ?? {}
    if (customData.codexMediaKind === 'video') {
      videoFileIds.add(element.fileId)
      continue
    }
    if (
      typeof customData.codexAssetPath === 'string' && customData.codexAssetPath &&
      typeof customData.codexAssetUrl === 'string' && customData.codexAssetUrl.startsWith(CANVAS_ASSETS_ROUTE) &&
      !assetUrlByFileId.has(element.fileId)
    ) {
      assetUrlByFileId.set(element.fileId, customData.codexAssetUrl)
    }
  }
  let changed = false
  const next = {}
  for (const [id, file] of Object.entries(files)) {
    const inline = typeof file?.dataURL === 'string' && file.dataURL.startsWith('data:')
    if (!inline || videoFileIds.has(id)) {
      next[id] = file
      continue
    }
    const markedUrl =
      file.codexAssetBacked === true &&
      typeof file.codexAssetUrl === 'string' &&
      file.codexAssetUrl.startsWith(CANVAS_ASSETS_ROUTE)
        ? file.codexAssetUrl
        : null
    const assetUrl = markedUrl || assetUrlByFileId.get(id) || null
    if (!assetUrl) {
      next[id] = file
      continue
    }
    next[id] = { ...file, dataURL: assetUrl, codexAssetBacked: true }
    changed = true
  }
  return changed ? next : files
}

function serializableAppState(appState = {}) {
  const next = {}
  const keys = [
    'viewBackgroundColor',
    'gridSize',
    'gridStep',
    'scrollX',
    'scrollY',
    'zoom',
    'theme',
    'name',
    'frameRendering',
    'objectsSnapModeEnabled',
    'selectedElementIds'
  ]

  for (const key of keys) {
    if (appState[key] !== undefined) next[key] = appState[key]
  }

  return next
}

function createScene(elements, appState, files) {
  return {
    type: 'excalidraw',
    version: 2,
    source: 'codex-excalidraw-canvas',
    elements: elements.map(sanitizeElementForScene),
    appState: serializableAppState(appState),
    files: normalizeExcalidrawFiles(files)
  }
}

// Stable fingerprint of a scene's content (elements + files), independent of
// selection/scroll/zoom. Used to detect when an SSE "canvas-changed" event is
// merely the echo of our own save so we don't clobber in-flight local edits.
function sceneFingerprint(scene) {
  if (!scene || !Array.isArray(scene.elements)) return ''
  const els = scene.elements
    .map((e) => `${e.id}:${e.version ?? 0}:${e.versionNonce ?? 0}:${e.isDeleted ? 1 : 0}`)
    .sort()
    .join('|')
  const files = Object.keys(scene.files ?? {}).sort().join(',')
  return `${els}#${files}`
}

// AppState persisted to disk: viewport only, never selection. Persisting
// selectedElementIds makes selection shared global state that the SSE echo (and
// MCP writers) re-impose on the live editor, causing selection loss.
function persistableAppState(appState = {}) {
  const next = serializableAppState(appState)
  delete next.selectedElementIds
  return next
}

function sanitizeElementForScene(element) {
  if (!element?.customData || !isGeneratorFrame(element)) return element
  const sanitized = sanitizeGeneratorCustomData(element.customData)
  return sanitized === element.customData ? element : { ...element, customData: sanitized }
}

function sanitizeGeneratorCustomData(customData) {
  let changed = false
  const next = { ...customData }
  const setValue = (key, value) => {
    if (next[key] === value) return
    next[key] = value
    changed = true
  }
  const sanitizeAsset = (value) => normalizeAssetList(value ? [value] : [])[0] ?? null
  setValue('generatorReferenceImages', normalizeAssetList(next.generatorReferenceImages))
  setValue('referenceImages', normalizeAssetList(next.referenceImages))
  setValue('referenceImageAssets', normalizeAssetList(next.referenceImageAssets))
  setValue('referenceVideos', normalizeAssetList(next.referenceVideos))
  setValue('referenceVideoAssets', normalizeAssetList(next.referenceVideoAssets))
  setValue('videoReferenceImages', normalizeAssetList(next.videoReferenceImages))
  setValue('videoReferenceVideos', normalizeAssetList(next.videoReferenceVideos))
  setValue('videoReferenceAudios', normalizeAssetList(next.videoReferenceAudios))
  setValue('videoStartFrameAsset', sanitizeAsset(next.videoStartFrameAsset))
  setValue('videoEndFrameAsset', sanitizeAsset(next.videoEndFrameAsset))
  return changed ? next : customData
}

function getSelectedIds(appState = {}) {
  return Object.entries(appState.selectedElementIds ?? {})
    .filter(([, selected]) => selected)
    .map(([id]) => id)
}

function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) return false
  const tagName = target.tagName.toLowerCase()
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target.isContentEditable
}

function summarizeElement(element, files = {}) {
  const file = element.fileId ? files[element.fileId] : null
  return {
    id: element.id,
    type: element.type,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    angle: element.angle,
    index: element.index,
    frameId: element.frameId ?? null,
    customData: element.customData ?? null,
    isAiImageHolder: element.customData?.[AI_HOLDER_KEY] === true,
    file: file
      ? {
          id: file.id,
          mimeType: file.mimeType,
          created: file.created,
          lastRetrieved: file.lastRetrieved ?? null
        }
      : null
  }
}

function getSelectionSnapshot(scene) {
  const elementsById = new Map(scene.elements.map((element) => [element.id, element]))
  const selectedElementIds = getSelectedIds(scene.appState)
  return {
    selectedElementIds,
    selectedElements: selectedElementIds
      .map((id) => elementsById.get(id))
      .filter(Boolean)
      .map((element) => summarizeElement(element, scene.files)),
    updatedAt: new Date().toISOString()
  }
}

function getViewState(appState = {}) {
  return {
    version: 1,
    scrollX: Number.isFinite(appState.scrollX) ? appState.scrollX : 0,
    scrollY: Number.isFinite(appState.scrollY) ? appState.scrollY : 0,
    zoom:
      appState.zoom && Number.isFinite(appState.zoom.value)
        ? { value: appState.zoom.value }
        : { value: 1 },
    updatedAt: new Date().toISOString()
  }
}

function chooseIndex(elements) {
  const indexes = elements
    .filter((element) => element && !element.isDeleted)
    .map((element) => element.index)
    .filter((index) => typeof index === 'string')
    .sort()

  while (indexes.length) {
    const index = indexes.at(-1)
    try {
      return generateKeyBetween(index, null)
    } catch {
      indexes.pop()
    }
  }
  return generateKeyBetween(null, null)
}

function viewportSize(appState) {
  return {
    width: appState.width || window.innerWidth,
    height: appState.height || window.innerHeight
  }
}

function viewportCenter(appState) {
  const zoom = appState.zoom?.value || 1
  const { width, height } = viewportSize(appState)
  return {
    x: width / (2 * zoom) - (appState.scrollX ?? 0),
    y: height / (2 * zoom) - (appState.scrollY ?? 0)
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function getViewportDimension(value, fallback) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback
}

function getAdaptiveGeneratorFrameSize(size, appState = {}) {
  const { width: fallbackWidth, height: fallbackHeight } = viewportSize(appState)
  const viewportWidth = getViewportDimension(appState.width, fallbackWidth)
  const viewportHeight = getViewportDimension(appState.height, fallbackHeight)
  const zoom = Math.max(0.1, Number(appState.zoom?.value) || 1)
  const maxDisplayWidth = Math.max(GENERATOR_FRAME_MIN_SCENE_SIZE, viewportWidth - GENERATOR_FRAME_EDGE_MARGIN * 2)
  const maxDisplayHeight = Math.max(
    GENERATOR_FRAME_MIN_SCENE_SIZE,
    viewportHeight - GENERATOR_PANEL_ESTIMATED_HEIGHT - GENERATOR_FRAME_TOP_RESERVE
  )
  const scale = Math.min(1, maxDisplayWidth / zoom / size.width, maxDisplayHeight / zoom / size.height)
  if (!Number.isFinite(scale) || scale >= 1) return { width: Math.round(size.width), height: Math.round(size.height) }
  return {
    width: Math.max(GENERATOR_FRAME_MIN_SCENE_SIZE, Math.round(size.width * scale)),
    height: Math.max(GENERATOR_FRAME_MIN_SCENE_SIZE, Math.round(size.height * scale))
  }
}

function getFrameViewportPlacement(frame, appState = {}) {
  const zoom = appState.zoom?.value || 1
  const scrollX = appState.scrollX || 0
  const scrollY = appState.scrollY || 0
  const left = Math.floor((frame.x + scrollX) * zoom)
  const top = Math.floor((frame.y + scrollY) * zoom)
  const right = Math.ceil((frame.x + frame.width + scrollX) * zoom)
  const bottom = Math.ceil((frame.y + frame.height + scrollY) * zoom)
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  }
}

function isViewportPlacementNearViewport(placement, appState = {}, margin = 128) {
  const { width, height } = viewportSize(appState)
  return (
    placement.left <= width + margin &&
    placement.left + placement.width >= -margin &&
    placement.top <= height + margin &&
    placement.top + placement.height >= -margin
  )
}

function getPanelPlacementFromViewportTarget(target, isVideo = false) {
  const frameViewportWidth = Math.max(1, Number(target?.width) || 1)
  const frameViewportHeight = Math.max(1, Number(target?.height) || 1)
  const viewportWidth = typeof window === 'undefined' ? 1280 : Math.max(1, window.innerWidth || 1280)
  const maxPanelWidth = Math.max(GENERATOR_PANEL_IMAGE_MIN_WIDTH, viewportWidth - GENERATOR_FRAME_EDGE_MARGIN * 2)
  const panelWidth = isVideo
    ? Math.min(GENERATOR_PANEL_VIDEO_WIDTH, maxPanelWidth)
    : Math.min(clamp(Math.round(frameViewportWidth * 0.9), GENERATOR_PANEL_IMAGE_MIN_WIDTH, GENERATOR_PANEL_IMAGE_MAX_WIDTH), maxPanelWidth)
  const rawLeft = Math.round((Number(target?.left) || 0) + frameViewportWidth / 2 - panelWidth / 2)
  const rawTop = Math.round((Number(target?.top) || 0) + frameViewportHeight + 4)

  return {
    left: rawLeft,
    top: rawTop,
    width: panelWidth
  }
}

function getFrameOverlayMetrics(width, height) {
  const safeWidth = Math.max(1, Number(width) || 1)
  const safeHeight = Math.max(1, Number(height) || 1)
  const minSide = Math.min(safeWidth, safeHeight)
  const headerFontSize = clamp(Math.round(safeWidth * 0.055), 5, 14)
  const headerOffset = clamp(Math.round(headerFontSize + 3), 6, 18)
  const iconSize = clamp(Math.round(minSide * 0.24), 6, 84)
  return {
    headerFontSize,
    headerOffset,
    iconSize,
    showHeader: safeWidth >= 28 && safeHeight >= 18,
    showTitleIcon: safeWidth >= 42,
    showSize: safeWidth >= 90,
    showLoading: safeWidth >= 44 && safeHeight >= 38
  }
}

function centerScrollForFrame(appState, frame, targetScreenRatio = 0.44) {
  const zoom = appState.zoom?.value || 1
  const { width, height } = viewportSize(appState)
  const frameCenterX = frame.x + frame.width / 2
  const frameCenterY = frame.y + frame.height / 2
  const targetScreenX = width / 2
  const targetScreenY = Math.min(height * targetScreenRatio, Math.max(120, height - 195))
  return {
    scrollX: targetScreenX / zoom - frameCenterX,
    scrollY: targetScreenY / zoom - frameCenterY
  }
}

function animateScrollTo(api, targetAppState, duration = 420) {
  const start = api.getAppState()
  const startScrollX = Number(start.scrollX) || 0
  const startScrollY = Number(start.scrollY) || 0
  const targetScrollX = Number(targetAppState.scrollX) || 0
  const targetScrollY = Number(targetAppState.scrollY) || 0
  const startTime = performance.now()
  const easeOutCubic = (t) => 1 - (1 - t) ** 3
  const step = (now) => {
    const progress = Math.min(1, (now - startTime) / duration)
    const eased = easeOutCubic(progress)
    api.updateScene({
      appState: {
        scrollX: startScrollX + (targetScrollX - startScrollX) * eased,
        scrollY: startScrollY + (targetScrollY - startScrollY) * eased
      },
      captureUpdate: CaptureUpdateAction.NEVER
    })
    if (progress < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

function isImageGeneratorFrame(element) {
  return element?.customData?.[GENERATOR_FRAME_TAG] === true
}

function isVideoGeneratorFrame(element) {
  return element?.customData?.[VIDEO_GENERATOR_FRAME_TAG] === true
}

function isGeneratorFrame(element) {
  return !element?.isDeleted && (isImageGeneratorFrame(element) || isVideoGeneratorFrame(element))
}

function isGeneratedImageResult(element) {
  return !element?.isDeleted && element?.customData?.codexGeneratedImage === true
}

function isGeneratedVideoResult(element) {
  return !element?.isDeleted && element?.customData?.codexGeneratedVideo === true
}

function isGeneratedResult(element) {
  return isGeneratedImageResult(element) || isGeneratedVideoResult(element)
}

function isCanvasImageElement(element) {
  return !element?.isDeleted && element?.type === 'image'
}

function isCanvasVideoElement(element) {
  return !element?.isDeleted && (isGeneratedVideoResult(element) || element?.customData?.codexMediaKind === 'video')
}

function getGeneratorKind(element) {
  return isVideoGeneratorFrame(element) ? 'video' : 'image'
}

function getGeneratedResultKind(element) {
  return isGeneratedVideoResult(element) ? 'video' : 'image'
}

function getElementGeometry(element) {
  return {
    x: Number(element?.x) || 0,
    y: Number(element?.y) || 0,
    width: Math.max(1, Math.abs(Number(element?.width) || 1)),
    height: Math.max(1, Math.abs(Number(element?.height) || 1))
  }
}

function rectsOverlap(a, b, padding = 0) {
  return !(
    a.x + a.width + padding <= b.x ||
    b.x + b.width + padding <= a.x ||
    a.y + a.height + padding <= b.y ||
    b.y + b.height + padding <= a.y
  )
}

function findNonOverlappingPlacement(elements, initial) {
  const obstacles = elements.filter((element) => !element.isDeleted).map(getElementGeometry)
  if (!obstacles.some((bounds) => rectsOverlap(initial, bounds, 8))) return initial

  const verticalStep = Math.max(16, Math.round(initial.height + 14))
  const horizontalStep = Math.max(16, Math.round(initial.width + 14))
  for (let row = 1; row <= 120; row += 1) {
    const candidate = { ...initial, y: initial.y + row * verticalStep }
    if (!obstacles.some((bounds) => rectsOverlap(candidate, bounds, 8))) return candidate
  }
  for (let col = 1; col <= 24; col += 1) {
    for (let row = 0; row <= 24; row += 1) {
      const candidate = {
        ...initial,
        x: initial.x + col * horizontalStep,
        y: initial.y + row * verticalStep
      }
      if (!obstacles.some((bounds) => rectsOverlap(candidate, bounds, 8))) return candidate
    }
  }
  return initial
}

function normalizeAssetList(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const path = typeof item.path === 'string' ? item.path : ''
      const url = typeof item.url === 'string' ? item.url : ''
      const displayURL = url || path || ''
      const thumbnail = typeof item.thumbnail === 'string' && !item.thumbnail.startsWith('data:')
        ? item.thumbnail
        : displayURL
      return {
        ...item,
        dataURL: '',
        thumbnail
      }
    })
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error('Failed to read file.'))
    reader.onload = () => resolve(String(reader.result || ''))
    reader.readAsDataURL(file)
  })
}

function readImageDimensions(dataURL) {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth || 1024, height: image.naturalHeight || 1024 })
    image.onerror = () => resolve({ width: 1024, height: 1024 })
    image.src = dataURL
  })
}

function readVideoPoster(file) {
  return new Promise((resolve) => {
    const objectURL = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : ''
    if (!objectURL) {
      resolve({ objectURL: '', posterDataURL: '', width: 1280, height: 720, duration: 0 })
      return
    }
    const video = document.createElement('video')
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      video.removeAttribute('src')
      video.load()
      resolve(result)
    }
    const fallback = () => finish({ objectURL, posterDataURL: '', width: 1280, height: 720, duration: 0 })
    const capture = () => {
      try {
        const width = Math.max(1, video.videoWidth || 1280)
        const height = Math.max(1, video.videoHeight || 720)
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d')
        if (context) context.drawImage(video, 0, 0, width, height)
        finish({
          objectURL,
          posterDataURL: context ? canvas.toDataURL('image/jpeg', 0.78) : '',
          width,
          height,
          duration: Number(video.duration) || 0
        })
      } catch {
        fallback()
      }
    }
    const onLoadedMetadata = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = Math.min(0.1, Math.max(0, video.duration / 20))
      } else {
        capture()
      }
    }
    video.muted = true
    video.playsInline = true
    video.preload = 'metadata'
    video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true })
    video.addEventListener('seeked', capture, { once: true })
    video.addEventListener('loadeddata', capture, { once: true })
    video.addEventListener('error', fallback, { once: true })
    window.setTimeout(fallback, 1600)
    video.src = objectURL
  })
}

function readAudioMetadata(file) {
  return new Promise((resolve) => {
    const objectURL = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : ''
    if (!objectURL || typeof Audio === 'undefined') {
      resolve({ duration: 0, objectURL })
      return
    }
    const audio = new Audio()
    const cleanup = () => {
      audio.removeAttribute('src')
      audio.load()
    }
    audio.onloadedmetadata = () => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0
      cleanup()
      resolve({ duration, objectURL })
    }
    audio.onerror = () => {
      cleanup()
      resolve({ duration: 0, objectURL })
    }
    audio.src = objectURL
  })
}

function inferMimeTypeFromDataURL(dataURL, fallback = 'application/octet-stream') {
  const match = /^data:([^;,]+)[;,]/.exec(String(dataURL || ''))
  return match?.[1] || fallback
}

function assetPathFromElement(element) {
  const customData = element?.customData ?? {}
  return customData.codexAssetPath || customData.generatorAssetPath || ''
}

function assetUrlFromElement(element) {
  const customData = element?.customData ?? {}
  return customData.codexAssetUrl || element?.link || ''
}

function isRenderableVideoPosterDataURL(dataURL) {
  return typeof dataURL === 'string' && dataURL.startsWith('data:image/')
}

function formatPlaybackDuration(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value <= 0) return ''
  const total = Math.max(0, Math.round(value))
  const minutes = Math.floor(total / 60)
  const secs = total % 60
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

function assetReferenceFromElement(element, files = {}) {
  if (!element) return null
  const file = element.fileId ? files[element.fileId] : null
  const path = assetPathFromElement(element)
  const url = assetUrlFromElement(element)
  const dataURL = file?.dataURL || ''
  if (!path && !url && !dataURL) return null
  const isVideo = isCanvasVideoElement(element)
  const customData = element.customData ?? {}
  const pixelSize = getCanvasMediaPixelSize(element, files)
  return {
    id: crypto.randomUUID(),
    name: getCanvasMediaDisplayName(element, files) || (isVideo ? 'canvas-video' : 'canvas-image'),
    kind: isVideo ? 'video' : 'image',
    mimeType: isVideo ? (customData.codexVideoMimeType || file?.mimeType || 'video/mp4') : (file?.mimeType || 'image/png'),
    path,
    url,
    dataURL,
    thumbnail: dataURL || url,
    duration: isVideo ? Number(customData.codexVideoDuration) || 0 : undefined,
    pixelWidth: pixelSize.width,
    pixelHeight: pixelSize.height
  }
}

function normalizeGeneratorFrameVisuals(elements) {
  let changed = false
  const now = Date.now()
  const normalized = elements.map((element) => {
    const isFrame = isGeneratorFrame(element)
    const isResult = isGeneratedImageResult(element)
    if (!isFrame && !isResult) return element
    const spec = isFrame
      ? {
          strokeColor: GENERATOR_FRAME_BORDER_COLOR,
          backgroundColor: GENERATOR_FRAME_FILL_COLOR,
          strokeWidth: GENERATOR_FRAME_STROKE_WIDTH
        }
      : {
          strokeColor: 'transparent',
          backgroundColor: 'transparent',
          strokeWidth: 1
        }
    if (
      element.strokeColor === spec.strokeColor &&
      element.backgroundColor === spec.backgroundColor &&
      element.fillStyle === 'solid' &&
      Number(element.strokeWidth || 1) === spec.strokeWidth &&
      element.strokeStyle === 'solid'
    ) {
      return element
    }
    changed = true
    return {
      ...element,
      strokeColor: spec.strokeColor,
      backgroundColor: spec.backgroundColor,
      fillStyle: 'solid',
      strokeWidth: spec.strokeWidth,
      strokeStyle: 'solid',
      version: (Number(element.version) || 1) + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: now
    }
  })
  return changed ? normalized : null
}

function frameFormFromElement(element) {
  const customData = element?.customData ?? {}
  const isVideoElement =
    isVideoGeneratorFrame(element) ||
    isGeneratedVideoResult(element) ||
    customData.codexMediaKind === 'video'
  const prompt = isVideoElement
    ? (
        typeof customData.videoPrompt === 'string'
          ? customData.videoPrompt
          : typeof customData.codexGenerationPrompt === 'string'
            ? customData.codexGenerationPrompt
            : typeof customData.generatorPrompt === 'string'
              ? customData.generatorPrompt
              : ''
      )
    : (
        typeof customData.generatorPrompt === 'string'
          ? customData.generatorPrompt
          : typeof customData.codexGenerationPrompt === 'string'
            ? customData.codexGenerationPrompt
            : typeof customData.videoPrompt === 'string'
              ? customData.videoPrompt
              : ''
      )
  const imageReferences = normalizeAssetList(
    customData.generatorReferenceImages ??
      customData.referenceImages ??
      customData.referenceImageAssets ??
      []
  )
  const videoReferenceImages = normalizeAssetList(
    customData.videoReferenceImages ??
      customData.referenceImages ??
      customData.referenceImageAssets ??
      []
  )
  const videoReferenceVideos = normalizeAssetList(
    customData.videoReferenceVideos ??
      customData.referenceVideos ??
      customData.referenceVideoAssets ??
      []
  )
  const videoReferenceAudios = normalizeAssetList(
    customData.videoReferenceAudios ??
      customData.referenceAudios ??
      customData.referenceAudioAssets ??
      []
  )
  return {
    ...DEFAULT_FRAME_FORM,
    prompt,
    imageModel: customData.generatorModel || customData.codexGenerationModel || DEFAULT_FRAME_FORM.imageModel,
    videoModel: customData.videoModel || customData.codexGenerationModel || DEFAULT_FRAME_FORM.videoModel,
    aspectRatio: customData.generatorAspectRatio || customData.codexGenerationAspectRatio || DEFAULT_FRAME_FORM.aspectRatio,
    videoAspectRatio: customData.videoAspectRatio || customData.codexGenerationAspectRatio || DEFAULT_FRAME_FORM.videoAspectRatio,
    quality: customData.generatorImageQuality || customData.codexGenerationQuality || DEFAULT_FRAME_FORM.quality,
    duration: customData.videoDuration || customData.codexGenerationDuration || DEFAULT_FRAME_FORM.duration,
    resolution: customData.videoResolution || customData.codexGenerationResolution || DEFAULT_FRAME_FORM.resolution,
    imageReferences,
    videoTab: customData.videoTab || DEFAULT_FRAME_FORM.videoTab,
    videoStartFrame: customData.videoStartFrameAsset || null,
    videoEndFrame: customData.videoEndFrameAsset || null,
    videoReferenceImages,
    videoReferenceVideos,
    videoReferenceAudios,
    videoGenerateAudio: customData.videoGenerateAudio !== undefined ? customData.videoGenerateAudio !== false : DEFAULT_FRAME_FORM.videoGenerateAudio
  }
}

function frameCustomDataFromForm(kind, form) {
  return kind === 'video'
    ? {
        videoPrompt: form.prompt,
        videoModel: form.videoModel,
        videoAspectRatio: form.videoAspectRatio,
        videoDuration: form.duration,
        videoResolution: form.resolution,
        videoTab: form.videoTab,
        videoStartFrameAsset: form.videoStartFrame || null,
        videoEndFrameAsset: form.videoEndFrame || null,
        videoReferenceImages: normalizeAssetList(form.videoReferenceImages),
        videoReferenceVideos: normalizeAssetList(form.videoReferenceVideos),
        videoReferenceAudios: normalizeAssetList(form.videoReferenceAudios),
        videoGenerateAudio: form.videoGenerateAudio !== false
      }
    : {
        generatorPrompt: form.prompt,
        generatorModel: form.imageModel,
        generatorAspectRatio: form.aspectRatio,
        generatorImageQuality: form.quality,
        generatorImageSize: '1K',
        generatorReferenceImages: normalizeAssetList(form.imageReferences)
      }
}

function buildFrameOverlays(scene) {
  const appState = scene.appState ?? {}
  const selectedIds = new Set(getSelectedIds(appState))

  return scene.elements
    .filter(isGeneratorFrame)
    .map((element) => {
      const kind = getGeneratorKind(element)
      const pixelWidth = Number(element.customData?.pixelWidth) || Math.round(element.width * 4)
      const pixelHeight = Number(element.customData?.pixelHeight) || Math.round(element.height * 4)
      const placement = getFrameViewportPlacement(getElementGeometry(element), appState)
      return {
        id: element.id,
        kind,
        isSelected: selectedIds.has(element.id),
        left: placement.left,
        top: placement.top,
        width: placement.width,
        height: placement.height,
        pixelWidth,
        pixelHeight
      }
    })
    .filter((overlay) => overlay.isSelected || isViewportPlacementNearViewport(overlay, appState))
}

function getCanvasMediaDisplayName(element, files = {}) {
  const customData = element?.customData ?? {}
  const file = element?.fileId ? files[element.fileId] : null
  return (
    customData.codexFileName ||
    customData.generatorFileName ||
    customData.codexGenerationPrompt ||
    file?.name ||
    (isCanvasVideoElement(element) ? 'Video' : 'Image')
  )
}

function getCanvasMediaPixelSize(element, files = {}) {
  const customData = element?.customData ?? {}
  const file = element?.fileId ? files[element.fileId] : null
  return {
    width:
      Number(customData.pixelWidth) ||
      Number(customData.codexPixelWidth) ||
      Number(customData.generatorPixelWidth) ||
      Number(file?.width) ||
      Math.round((Number(element?.width) || 1) * 4),
    height:
      Number(customData.pixelHeight) ||
      Number(customData.codexPixelHeight) ||
      Number(customData.generatorPixelHeight) ||
      Number(file?.height) ||
      Math.round((Number(element?.height) || 1) * 4)
  }
}

function buildSelectedImageOverlays(scene) {
  const appState = scene.appState ?? {}
  const selectedIds = new Set(getSelectedIds(appState))
  if (selectedIds.size === 0) return []
  return scene.elements
    .filter((element) => selectedIds.has(element.id) && (isCanvasImageElement(element) || isCanvasVideoElement(element)))
    .map((element) => {
      const placement = getFrameViewportPlacement(getElementGeometry(element), appState)
      const pixelSize = getCanvasMediaPixelSize(element, scene.files)
      return {
        id: element.id,
        assetType: isCanvasVideoElement(element) ? 'video' : 'image',
        fileName: getCanvasMediaDisplayName(element, scene.files),
        left: placement.left,
        top: placement.top,
        width: placement.width,
        height: placement.height,
        angle: Number(element.angle) || 0,
        pixelWidth: pixelSize.width,
        pixelHeight: pixelSize.height
      }
    })
}

function buildVideoPlaybackOverlays(scene) {
  const appState = scene.appState ?? {}
  const selectedIds = new Set(getSelectedIds(appState))
  return scene.elements
    .filter(isCanvasVideoElement)
    .map((element) => {
      const sourceURL = assetUrlFromElement(element)
      if (!sourceURL) return null
      const placement = getFrameViewportPlacement(getElementGeometry(element), appState)
      const file = element.fileId ? scene.files?.[element.fileId] : null
      return {
        id: element.id,
        sourceURL,
        posterDataURL: isRenderableVideoPosterDataURL(file?.dataURL) ? file.dataURL : '',
        left: placement.left,
        top: placement.top,
        width: placement.width,
        height: placement.height,
        angle: Number(element.angle) || 0,
        isSelected: selectedIds.has(element.id),
        duration: Number(element.customData?.codexVideoDuration) || 0
      }
    })
    .filter((overlay) => overlay && (overlay.isSelected || isViewportPlacementNearViewport(overlay, appState)))
}

function VideoCanvasOverlay({ video, isHovered, onExpand }) {
  const hoverVideoRef = useRef(null)
  const [isHoverVideoReady, setIsHoverVideoReady] = useState(false)

  useEffect(() => {
    setIsHoverVideoReady(false)
  }, [isHovered, video.sourceURL])

  useEffect(() => {
    if (!isHovered) return undefined
    const element = hoverVideoRef.current
    if (!element) return undefined
    element.muted = true
    element.defaultMuted = true
    void element.play().catch(() => {})
    return () => {
      try {
        element.pause()
        element.removeAttribute('src')
        element.load()
      } catch {
        // Ignore media reset failures.
      }
    }
  }, [isHovered, video.sourceURL])

  const minDim = Math.min(video.width, video.height)
  const showOverlayUI = minDim >= 60
  const iconScale = Math.max(0.5, Math.min(1, minDim / 200))
  const durationLabel = formatPlaybackDuration(video.duration)

  return (
    <div
      className="lovart-video-playback-overlay"
      style={{
        left: `${video.left}px`,
        top: `${video.top}px`,
        width: `${video.width}px`,
        height: `${video.height}px`,
        transform: video.angle ? `rotate(${video.angle}rad)` : undefined
      }}
    >
      {isRenderableVideoPosterDataURL(video.posterDataURL) ? (
        <img className="lovart-video-playback-media" src={video.posterDataURL} draggable={false} alt="" />
      ) : null}
      {isHovered ? (
        <video
          ref={hoverVideoRef}
          className="lovart-video-playback-media"
          src={video.sourceURL}
          loop
          muted
          defaultMuted
          playsInline
          preload="auto"
          onLoadedData={() => setIsHoverVideoReady(true)}
          onCanPlay={() => setIsHoverVideoReady(true)}
          style={{ opacity: isHoverVideoReady ? 1 : 0 }}
        />
      ) : null}
      {isHovered && showOverlayUI && !video.isSelected ? <div className="lovart-video-hover-gradient" /> : null}
      {!isHovered && showOverlayUI ? (
        <div
          className="lovart-video-play-icon"
          style={{
            width: `${Math.round(48 * iconScale)}px`,
            height: `${Math.round(48 * iconScale)}px`
          }}
        >
          <svg width={Math.round(18 * iconScale)} height={Math.round(18 * iconScale)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M8 5.14v13.72a1 1 0 001.5.86l11.04-6.86a1 1 0 000-1.72L9.5 4.28A1 1 0 008 5.14z" fill="#fff" />
          </svg>
        </div>
      ) : null}
      {durationLabel && showOverlayUI ? (
        <div
          className="lovart-video-duration"
          style={{
            left: `${Math.round(10 * iconScale)}px`,
            bottom: `${Math.round(10 * iconScale)}px`,
            fontSize: `${Math.round(11 * iconScale)}px`
          }}
        >
          {durationLabel}
        </div>
      ) : null}
      {isHovered && showOverlayUI ? (
        <button
          type="button"
          className="lovart-video-expand"
          style={{
            right: `${Math.round(10 * iconScale)}px`,
            bottom: `${Math.round(10 * iconScale)}px`,
            width: `${Math.round(30 * iconScale)}px`,
            height: `${Math.round(30 * iconScale)}px`
          }}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onExpand(video)
          }}
          aria-label="動画を拡大"
          title="拡大"
        >
          <svg width={Math.round(14 * iconScale)} height={Math.round(14 * iconScale)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M21 16v5h-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : null}
    </div>
  )
}

function ExpandedVideoPlayer({ video, onClose }) {
  return (
    <div className="lovart-video-modal" onClick={onClose}>
      <button type="button" className="lovart-video-modal-close" onClick={onClose} aria-label="閉じる">
        <CloseIcon />
      </button>
      <video
        src={video.sourceURL}
        poster={isRenderableVideoPosterDataURL(video.posterDataURL) ? video.posterDataURL : undefined}
        controls
        autoPlay
        playsInline
        className="lovart-video-modal-player"
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  )
}

function scenePointInElement(point, element) {
  const geometry = getElementGeometry(element)
  const centerX = geometry.x + geometry.width / 2
  const centerY = geometry.y + geometry.height / 2
  const angle = Number(element.angle) || 0
  const cos = Math.cos(-angle)
  const sin = Math.sin(-angle)
  const dx = point.x - centerX
  const dy = point.y - centerY
  const localX = dx * cos - dy * sin
  const localY = dx * sin + dy * cos
  return Math.abs(localX) <= geometry.width / 2 && Math.abs(localY) <= geometry.height / 2
}

function chooseElementIndex(elements) {
  const indexes = elements
    .map((element) => element.index)
    .filter((index) => typeof index === 'string')
    .sort()
  return generateKeyBetween(indexes.at(-1) ?? null, null)
}

function chooseElementIndexAfter(elements, previousIndex) {
  const indexes = elements
    .map((element) => element.index)
    .filter((index) => typeof index === 'string')
    .sort()
  const nextIndex = indexes.find((index) => previousIndex && index > previousIndex) ?? null
  return generateKeyBetween(previousIndex ?? indexes.at(-1) ?? null, nextIndex)
}

function createImageElementRecord({ fileId, bounds, index, customData }) {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    type: 'image',
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    angle: 0,
    strokeColor: 'transparent',
    backgroundColor: 'transparent',
    fillStyle: 'hachure',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: Math.floor(Math.random() * 2 ** 31),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    isDeleted: false,
    boundElements: null,
    updated: now,
    link: null,
    locked: false,
    index,
    fileId,
    status: 'saved',
    scale: [1, 1],
    crop: null,
    customData
  }
}

function frameSizeFor(kind, form) {
  if (kind === 'video') return VIDEO_ASPECTS[form.videoAspectRatio] ?? VIDEO_ASPECTS['16:9']
  const option = IMAGE_ASPECTS[form.aspectRatio] ?? IMAGE_ASPECTS['1:1']
  return {
    width: Math.max(140, Math.min(980, Math.round(option.baseWidth * 0.25))),
    height: Math.max(140, Math.min(980, Math.round(option.baseHeight * 0.25))),
    pixelWidth: option.baseWidth,
    pixelHeight: option.baseHeight
  }
}

export default function App() {
  const [initialScene, setInitialScene] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [api, setApi] = useState(null)
  const [activeFrameId, setActiveFrameId] = useState('')
  const [activeFrameKind, setActiveFrameKind] = useState('image')
  const [frameForm, setFrameForm] = useState(DEFAULT_FRAME_FORM)
  const [frameOverlays, setFrameOverlays] = useState([])
  const [selectedImageOverlays, setSelectedImageOverlays] = useState([])
  const [videoPlaybackOverlays, setVideoPlaybackOverlays] = useState([])
  const [hoveredVideoPlaybackId, setHoveredVideoPlaybackId] = useState('')
  const [expandedVideoPlayback, setExpandedVideoPlayback] = useState(null)
  const [pendingPanelFrame, setPendingPanelFrame] = useState(null)
  const [selectedGeneratedResult, setSelectedGeneratedResult] = useState(null)
  const [openMenu, setOpenMenu] = useState(null)
  const [videoFrameBtnsHovered, setVideoFrameBtnsHovered] = useState(false)
  const [generationError, setGenerationError] = useState('')
  const [generatingFrameIds, setGeneratingFrameIds] = useState(() => new Set())
  const [capabilities, setCapabilities] = useState(null)
  const [canvasPicker, setCanvasPicker] = useState(null)
  const latestSceneRef = useRef(DEFAULT_SCENE)
  const activeFrameIdRef = useRef('')
  const pendingPanelFrameRef = useRef(null)
  const selectedGeneratedResultRef = useRef(null)
  const previousGeneratorFrameIdsRef = useRef(new Set())
  const justCreatedFrameIdRef = useRef('')
  const copiedGeneratorFrameRef = useRef(null)
  const lastFocusedFrameIdRef = useRef('')
  const lastCreatedFrameGeoRef = useRef(null)
  const lastCreatedViewRef = useRef(null)
  const isAnimatingScrollRef = useRef(false)
  const scrollAnimGenerationRef = useRef(0)
  const isDraggingGeneratorRef = useRef(false)
  const lastPointerDownCanvasRef = useRef(null)
  const suppressNextChangeRef = useRef(false)
  const canvasPickerRef = useRef(null)
  const canvasPickerFrameIdRef = useRef('')
  const consumeCanvasPickerSelectionRef = useRef(null)
  const imageUploadInputRef = useRef(null)
  const toolbarMediaInputRef = useRef(null)
  const toolbarMediaPickerActiveRef = useRef(false)
  const hoverOverlayRef = useRef(null)
  const menuBackdropRef = useRef(null)
  const videoFrameUploadInputRef = useRef(null)
  const videoFrameUploadTargetRef = useRef('start')
  const pendingGeneratorUploadFrameIdRef = useRef('')
  const videoFrameLeaveTimerRef = useRef(0)
  const lastGeneratorPasteRef = useRef({ time: 0, sourceId: '', frameId: '' })
  const saveTimerRef = useRef(null)
  const selectionTimerRef = useRef(null)
  const lastSelectionRef = useRef('')
  const applyingRemoteRef = useRef(false)
  const hasLocalChangesRef = useRef(false)
  const lastSyncedFingerprintRef = useRef('')

  useEffect(() => {
    const controller = new AbortController()

    async function loadCanvas() {
      try {
        const response = await fetch(CANVAS_ENDPOINT, { signal: controller.signal })
        if (!response.ok) throw new Error(`Failed to load canvas: ${response.status}`)
        const payload = await response.json()
        const scene = normalizeScene(payload.scene)
        latestSceneRef.current = scene
        previousGeneratorFrameIdsRef.current = new Set(scene.elements.filter(isGeneratorFrame).map((element) => element.id))
        setInitialScene(scene)
      } catch (error) {
        if (error.name === 'AbortError') return
        setLoadError(error)
        setInitialScene(DEFAULT_SCENE)
      }
    }

    loadCanvas()
    return () => controller.abort()
  }, [])

  useEffect(() => {
    pendingPanelFrameRef.current = pendingPanelFrame
  }, [pendingPanelFrame])

  useEffect(() => {
    selectedGeneratedResultRef.current = selectedGeneratedResult
  }, [selectedGeneratedResult])

  useEffect(() => {
    const controller = new AbortController()

    async function loadCapabilities() {
      try {
        const response = await fetch(GENERATION_CAPABILITIES_ENDPOINT, { signal: controller.signal })
        if (response.ok) setCapabilities(await response.json())
      } catch (error) {
        if (error.name !== 'AbortError') console.error(error)
      }
    }

    loadCapabilities()
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!openMenu) return undefined

    const closeMenuOnOutsidePointer = (event) => {
      const target = event.target
      if (target instanceof Element) {
        const isInsideGeneratorUi = target.closest(
          '.lovart-ai-panel, .lovart-menu, .lovart-canvas-picker-bar'
        )
        if (isInsideGeneratorUi) return
      }
      setOpenMenu(null)
    }

    document.addEventListener('pointerdown', closeMenuOnOutsidePointer, true)
    document.addEventListener('mousedown', closeMenuOnOutsidePointer, true)
    document.addEventListener('click', closeMenuOnOutsidePointer, true)
    return () => {
      document.removeEventListener('pointerdown', closeMenuOnOutsidePointer, true)
      document.removeEventListener('mousedown', closeMenuOnOutsidePointer, true)
      document.removeEventListener('click', closeMenuOnOutsidePointer, true)
    }
  }, [openMenu])

  useEffect(() => {
    const backdrop = menuBackdropRef.current
    if (!openMenu || !backdrop) return undefined

    const closeFromBackdrop = (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (openMenu === 'video-settings') {
        const trigger = document.querySelector('[data-lovart-trigger="video-settings"]')
        if (trigger instanceof HTMLElement) trigger.click()
      }
      setOpenMenu(null)
    }

    backdrop.addEventListener('pointerdown', closeFromBackdrop)
    backdrop.addEventListener('mousedown', closeFromBackdrop)
    backdrop.addEventListener('mouseup', closeFromBackdrop)
    backdrop.addEventListener('click', closeFromBackdrop)
    return () => {
      backdrop.removeEventListener('pointerdown', closeFromBackdrop)
      backdrop.removeEventListener('mousedown', closeFromBackdrop)
      backdrop.removeEventListener('mouseup', closeFromBackdrop)
      backdrop.removeEventListener('click', closeFromBackdrop)
    }
  }, [openMenu])

  const writeSelection = useCallback(async (scene) => {
    const selection = getSelectionSnapshot(scene)
    const serialized = JSON.stringify(selection)
    if (serialized === lastSelectionRef.current) return
    lastSelectionRef.current = serialized

    try {
      await fetch(SELECTION_ENDPOINT, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: serialized
      })
    } catch (error) {
      console.error(error)
    }
  }, [])

  const scheduleSelectionSave = useCallback(
    (scene) => {
      window.clearTimeout(selectionTimerRef.current)
      selectionTimerRef.current = window.setTimeout(() => writeSelection(scene), SELECTION_DELAY_MS)
    },
    [writeSelection]
  )

  const saveCanvas = useCallback(async (scene) => {
    window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = null
    // Persist viewport only (never selection) so the round-tripped scene can't
    // re-impose a stale selection on the live editor. Asset-backed file records
    // are stripped back to their asset URL so we never re-embed hydrated base64
    // into the persisted scene (the server applies the same rule as a backstop).
    const persisted = {
      ...scene,
      appState: persistableAppState(scene.appState),
      files: stripAssetBackedFilesForSave(scene.elements, scene.files)
    }
    // Remember what we just saved so the SSE echo of this exact content is
    // ignored instead of clobbering newer local edits.
    lastSyncedFingerprintRef.current = sceneFingerprint(persisted)
    try {
      await fetch(CANVAS_ENDPOINT, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(persisted)
      })
      await fetch(VIEW_STATE_ENDPOINT, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(getViewState(scene.appState))
      })
      hasLocalChangesRef.current = false
    } catch (error) {
      console.error(error)
    }
  }, [])

  const scheduleCanvasSave = useCallback(
    (scene) => {
      hasLocalChangesRef.current = true
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = window.setTimeout(() => saveCanvas(scene), SAVE_DELAY_MS)
    },
    [saveCanvas]
  )

  const syncGeneratorUi = useCallback((scene) => {
    setFrameOverlays(buildFrameOverlays(scene))
    setSelectedImageOverlays(buildSelectedImageOverlays(scene))
    setVideoPlaybackOverlays(buildVideoPlaybackOverlays(scene))
    const elementsById = new Map(scene.elements.map((element) => [element.id, element]))
    const selectedIds = getSelectedIds(scene.appState)
    const selectedFrameId = selectedIds.find((id) => isGeneratorFrame(elementsById.get(id))) ?? ''
    const selectedResultId = !selectedFrameId
      ? (selectedIds.find((id) => isGeneratedResult(elementsById.get(id))) ??
          selectedIds
            .map((id) => elementsById.get(id)?.customData?.codexVideoLabelFor)
            .find((id) => isGeneratedResult(elementsById.get(id))) ??
          '')
      : ''

    if (selectedFrameId) {
      const selectedFrame = elementsById.get(selectedFrameId)
      const frameChanged = activeFrameIdRef.current !== selectedFrameId
      activeFrameIdRef.current = selectedFrameId
      lastFocusedFrameIdRef.current = selectedFrameId
      setActiveFrameId(selectedFrameId)
      setPendingPanelFrame(null)
      setSelectedGeneratedResult(null)
      if (frameChanged) {
        setOpenMenu(null)
        setGenerationError('')
      }
      setActiveFrameKind(getGeneratorKind(selectedFrame))
      setFrameForm(frameFormFromElement(selectedFrame))
      return
    }

    if (selectedResultId) {
      const selectedResult = elementsById.get(selectedResultId)
      const resultChanged = selectedGeneratedResultRef.current?.elementId !== selectedResultId
      const kind = getGeneratedResultKind(selectedResult)
      const geometry = getElementGeometry(selectedResult)
      const placement = getFrameViewportPlacement(geometry, scene.appState)
      activeFrameIdRef.current = ''
      setActiveFrameId('')
      setPendingPanelFrame(null)
      setSelectedGeneratedResult({
        id: `result:${selectedResultId}`,
        elementId: selectedResultId,
        kind,
        ...geometry,
        ...placement
      })
      if (resultChanged) {
        setOpenMenu(null)
        setGenerationError('')
      }
      setActiveFrameKind(kind)
      setFrameForm(frameFormFromElement(selectedResult))
      return
    }

    const pending = pendingPanelFrameRef.current
    if (pending && isGeneratorFrame(elementsById.get(pending.id))) {
      activeFrameIdRef.current = pending.id
      lastFocusedFrameIdRef.current = pending.id
      setActiveFrameId(pending.id)
      setActiveFrameKind(pending.kind)
      setSelectedGeneratedResult(null)
      return
    }

    if (activeFrameIdRef.current || selectedGeneratedResultRef.current) {
      activeFrameIdRef.current = ''
      setActiveFrameId('')
      setSelectedGeneratedResult(null)
      setOpenMenu(null)
    }
  }, [])

  useEffect(() => {
    if (initialScene) syncGeneratorUi(initialScene)
  }, [initialScene, syncGeneratorUi])

  // Hydrate disk-backed file records once the Excalidraw API is ready. The
  // scene renders immediately; images pop in as each asset finishes loading.
  useEffect(() => {
    if (!api || !initialScene) return
    hydrateAssetBackedFiles(initialScene.files, (file) => api.addFiles([file]))
  }, [api, initialScene])

  const handleChange = useCallback(
    (elements, appState, files) => {
      const shouldSkipChangeEffects = suppressNextChangeRef.current
      if (suppressNextChangeRef.current) suppressNextChangeRef.current = false
      let workingElements = [...elements]

      if (!shouldSkipChangeEffects && api) {
        const normalizedElements = normalizeGeneratorFrameVisuals(workingElements)
        if (normalizedElements) {
          suppressNextChangeRef.current = true
          window.setTimeout(() => {
            api.updateScene({
              elements: normalizedElements,
              captureUpdate: CaptureUpdateAction.NEVER
            })
          }, 0)
          return
        }

        const generatorFrames = workingElements.filter(isGeneratorFrame)
        const nextIds = new Set(generatorFrames.map((frame) => frame.id))
        const previousIds = previousGeneratorFrameIdsRef.current
        const addedFrames = generatorFrames.filter((frame) => !previousIds.has(frame.id))
        previousGeneratorFrameIdsRef.current = nextIds

        const addedByProgram = addedFrames.some((frame) => frame.id === justCreatedFrameIdRef.current)
        if (addedFrames.length > 0 && !addedByProgram) {
          const addedIdSet = new Set(addedFrames.map((frame) => frame.id))
          const stableFrames = generatorFrames.filter((frame) => !addedIdSet.has(frame.id))
          const firstAdded = addedFrames[0]
          const firstAddedGeometry = getElementGeometry(firstAdded)
          const copiedFrame = copiedGeneratorFrameRef.current
          let sourceFrame = copiedFrame && !copiedFrame.isDeleted ? copiedFrame : null

          if (!sourceFrame) {
            const addedCenterX = firstAddedGeometry.x + firstAddedGeometry.width / 2
            const addedCenterY = firstAddedGeometry.y + firstAddedGeometry.height / 2
            let minDistance = Infinity
            for (const stableFrame of stableFrames) {
              const geometry = getElementGeometry(stableFrame)
              const distance = Math.abs(geometry.x + geometry.width / 2 - addedCenterX) + Math.abs(geometry.y + geometry.height / 2 - addedCenterY)
              if (distance < minDistance) {
                minDistance = distance
                sourceFrame = stableFrame
              }
            }
          }

          const sourceForData = sourceFrame ?? copiedFrame
          const sourceGeometry = sourceFrame ? getElementGeometry(sourceFrame) : copiedFrame ? getElementGeometry(copiedFrame) : firstAddedGeometry
          const sourceY = sourceGeometry.y
          const rowFrames = stableFrames.filter((frame) => Math.abs(getElementGeometry(frame).y - sourceY) < sourceGeometry.height * 0.5)
          const maxRowRight = rowFrames.length > 0
            ? Math.max(...rowFrames.map((frame) => {
                const geometry = getElementGeometry(frame)
                return geometry.x + geometry.width
              }))
            : sourceGeometry.x + sourceGeometry.width
          const targetX = Math.round(maxRowRight + 14)
          const minAddedX = Math.min(...addedFrames.map((frame) => getElementGeometry(frame).x))
          const minAddedY = Math.min(...addedFrames.map((frame) => getElementGeometry(frame).y))
          const shiftX = targetX - minAddedX
          const shiftY = sourceY - minAddedY
          const now = Date.now()
          workingElements = workingElements.map((element) => {
            if (!addedIdSet.has(element.id)) return element
            const sourceCustomData = sourceForData?.customData ?? element.customData ?? {}
            return {
              ...element,
              x: Math.round((Number(element.x) || 0) + shiftX),
              y: Math.round((Number(element.y) || 0) + shiftY),
              width: sourceGeometry.width,
              height: sourceGeometry.height,
              strokeColor: GENERATOR_FRAME_BORDER_COLOR,
              backgroundColor: GENERATOR_FRAME_FILL_COLOR,
              fillStyle: 'solid',
              strokeWidth: GENERATOR_FRAME_STROKE_WIDTH,
              strokeStyle: 'solid',
              customData: {
                ...(element.customData ?? {}),
                ...sourceCustomData,
                ...(isVideoGeneratorFrame(sourceForData) ? { [VIDEO_GENERATOR_FRAME_TAG]: true } : { [GENERATOR_FRAME_TAG]: true }),
                role: 'frame'
              },
              version: (Number(element.version) || 1) + 1,
              versionNonce: Math.floor(Math.random() * 2 ** 31),
              updated: now
            }
          })
          const selectedFrameId = firstAdded.id || sourceFrame?.id || ''
          const selectedFrame = selectedFrameId
            ? workingElements.find((element) => element.id === selectedFrameId)
            : null
          const selectedKind = getGeneratorKind(selectedFrame)
          const selectedAppState = { ...appState, selectedElementIds: selectedFrameId ? { [selectedFrameId]: true } : {} }
          const nextScene = createScene(workingElements, selectedAppState, files)
          latestSceneRef.current = nextScene
          suppressNextChangeRef.current = true
          activeFrameIdRef.current = selectedFrameId
          lastFocusedFrameIdRef.current = selectedFrameId
          setActiveFrameId(selectedFrameId)
          setActiveFrameKind(selectedKind)
          setFrameForm(frameFormFromElement(selectedFrame))
          setPendingPanelFrame(null)
          setSelectedGeneratedResult(null)
          setOpenMenu(null)
          setFrameOverlays(buildFrameOverlays(nextScene))
          setSelectedImageOverlays(buildSelectedImageOverlays(nextScene))
          setVideoPlaybackOverlays(buildVideoPlaybackOverlays(nextScene))
          scheduleSelectionSave(nextScene)
          scheduleCanvasSave(nextScene)
          window.setTimeout(() => {
            api.updateScene({
              elements: workingElements,
              appState: { selectedElementIds: selectedAppState.selectedElementIds },
              captureUpdate: CaptureUpdateAction.IMMEDIATELY
            })
          }, 0)
          return
        }
      }

      const scene = createScene(workingElements, appState, files)
      latestSceneRef.current = scene
      const didConsumeCanvasPick = consumeCanvasPickerSelectionRef.current?.(scene) === true
      if (didConsumeCanvasPick) {
        return
      }

      // Click-to-select robustness: generator frames are large translucent
      // rectangles, so a click inside one often lands on empty interior and
      // Excalidraw selects nothing (or a child). If nothing relevant is
      // selected but the click point falls inside a generator frame, re-select
      // that frame so its panel opens.
      if (api && !shouldSkipChangeEffects && !applyingRemoteRef.current && !canvasPickerRef.current) {
        const selectedIds = getSelectedIds(appState)
        const elementsById = new Map(workingElements.map((el) => [el.id, el]))
        const hasRelevantSelection = selectedIds.some((id) => {
          const el = elementsById.get(id)
          return isGeneratorFrame(el) || isGeneratedResult(el) || isCanvasImageElement(el) || isCanvasVideoElement(el)
        })
        const point = lastPointerDownCanvasRef.current
        if (!hasRelevantSelection && point && Date.now() - point.time < 1200) {
          const hit = workingElements
            .filter((el) => isGeneratorFrame(el) && !el.isDeleted)
            .reverse()
            .find((el) => scenePointInElement(point, el))
          if (hit && hit.id !== activeFrameIdRef.current) {
            lastPointerDownCanvasRef.current = null
            suppressNextChangeRef.current = true
            const reselected = { ...appState, selectedElementIds: { [hit.id]: true } }
            const nextScene = createScene(workingElements, reselected, files)
            latestSceneRef.current = nextScene
            syncGeneratorUi(nextScene)
            window.setTimeout(() => {
              api.updateScene({
                appState: { selectedElementIds: { [hit.id]: true } },
                captureUpdate: CaptureUpdateAction.NEVER
              })
            }, 0)
            return
          }
        }
      }

      syncGeneratorUi(scene)
      scheduleSelectionSave(scene)

      if (!applyingRemoteRef.current && !shouldSkipChangeEffects) {
        scheduleCanvasSave(scene)
      }
    },
    [api, scheduleCanvasSave, scheduleSelectionSave, syncGeneratorUi]
  )

  const applyRemoteScene = useCallback(
    (scene, options = {}) => {
      if (!api || (hasLocalChangesRef.current && !options.force)) return

      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      hasLocalChangesRef.current = false
      const normalized = normalizeScene(scene)
      lastSyncedFingerprintRef.current = sceneFingerprint(normalized)
      latestSceneRef.current = normalized
      previousGeneratorFrameIdsRef.current = new Set(normalized.elements.filter(isGeneratorFrame).map((element) => element.id))
      syncGeneratorUi(normalized)
      applyingRemoteRef.current = true
      suppressNextChangeRef.current = true
      try {
        const currentAppState = api.getAppState?.() ?? {}
        const shouldApplyViewport = options.applyViewport === true
        const nextAppState = {
          ...normalized.appState,
          // Never apply the remote selection — keep the user's live selection so
          // a refresh can't deselect the frame they're working in.
          selectedElementIds: options.applySelection
            ? normalized.appState.selectedElementIds ?? {}
            : currentAppState.selectedElementIds ?? {},
          ...(!shouldApplyViewport
            ? {
                scrollX: currentAppState.scrollX,
                scrollY: currentAppState.scrollY,
                zoom: currentAppState.zoom
              }
            : {})
        }
        const nextScene = { ...normalized, appState: nextAppState }
        latestSceneRef.current = nextScene
        syncGeneratorUi(nextScene)
        const fileRecords = Object.values(normalized.files)
        const readyFiles = fileRecords.filter((file) => !isAssetBackedFileRecord(file))
        if (readyFiles.length > 0) api.addFiles(readyFiles)
        // Disk-backed records hydrate asynchronously after the scene applies;
        // images pop in as each asset resolves instead of blocking the update.
        hydrateAssetBackedFiles(normalized.files, (file) => api.addFiles([file]))
        window.setTimeout(() => {
          api.updateScene({
            elements: normalized.elements,
            appState: nextAppState,
            captureUpdate: CaptureUpdateAction.NEVER
          })
        }, 0)
      } finally {
        window.setTimeout(() => {
          applyingRemoteRef.current = false
        }, 3000)
      }
    },
    [api]
  )

  const openToolbarMediaPicker = useCallback(() => {
    if (!toolbarMediaInputRef.current || toolbarMediaPickerActiveRef.current) return
    toolbarMediaPickerActiveRef.current = true
    setOpenMenu(null)
    toolbarMediaInputRef.current.click()
    window.setTimeout(() => {
      toolbarMediaPickerActiveRef.current = false
    }, 1500)
  }, [])

  useEffect(() => {
    const releaseToolbarMediaPicker = () => {
      window.setTimeout(() => {
        toolbarMediaPickerActiveRef.current = false
      }, 0)
    }
    window.addEventListener('focus', releaseToolbarMediaPicker)
    return () => window.removeEventListener('focus', releaseToolbarMediaPicker)
  }, [])

  useEffect(() => {
    if (!api || !('EventSource' in window)) return undefined

    async function loadRemoteCanvas() {
      try {
        const response = await fetch(CANVAS_ENDPOINT)
        if (!response.ok) throw new Error(`Failed to refresh canvas: ${response.status}`)
        const payload = await response.json()
        // Ignore the echo of our own save (and the duplicate file-watcher
        // broadcast): if the content matches what we last synced, do nothing.
        const fingerprint = sceneFingerprint(normalizeScene(payload.scene))
        if (fingerprint === lastSyncedFingerprintRef.current) return
        applyRemoteScene(payload.scene)
      } catch (error) {
        console.error(error)
      }
    }

    const events = new EventSource(CANVAS_EVENTS_ENDPOINT)
    events.addEventListener('canvas-changed', loadRemoteCanvas)
    events.onerror = (error) => {
      console.warn('Codex Excalidraw live refresh disconnected.', error)
    }
    return () => events.close()
  }, [api, applyRemoteScene])

  useEffect(() => {
    if (!api) return undefined
    const getClipboardSourceFrame = () => {
      const appState = api.getAppState?.() ?? {}
      const latestScene = latestSceneRef.current
      const selectedIds = new Set([
        ...getSelectedIds(appState),
        ...getSelectedIds(latestScene?.appState ?? {})
      ])
      const fallbackIds = [activeFrameIdRef.current, lastFocusedFrameIdRef.current].filter(Boolean)
      const elementsById = new Map()
      for (const element of latestScene?.elements ?? []) elementsById.set(element.id, element)
      for (const element of api.getSceneElementsIncludingDeleted()) elementsById.set(element.id, element)
      const frames = [...elementsById.values()]
        .filter((element) => isGeneratorFrame(element) && !element.isDeleted)
      const explicitFrame = frames
        .find((element) =>
          (selectedIds.has(element.id) || fallbackIds.includes(element.id))
        )
      if (explicitFrame) return explicitFrame
      return frames
        .sort((a, b) => (Number(b.updated) || 0) - (Number(a.updated) || 0))[0] ?? null
    }
    const storeClipboardSourceFrame = () => {
      const selectedFrame = getClipboardSourceFrame()
      if (!selectedFrame) {
        copiedGeneratorFrameRef.current = null
        return copiedGeneratorFrameRef.current
      }
      const selectedKind = getGeneratorKind(selectedFrame)
      const liveForm = selectedFrame.id === activeFrameIdRef.current ? frameForm : frameFormFromElement(selectedFrame)
      copiedGeneratorFrameRef.current = {
        ...selectedFrame,
        customData: {
          ...(selectedFrame.customData ?? {}),
          ...frameCustomDataFromForm(selectedKind, liveForm)
        }
      }
      return copiedGeneratorFrameRef.current
    }
    const handleClipboardShortcut = (event) => {
      if (event.type === 'copy') {
        if (isEditableTarget(document.activeElement)) return false
        return Boolean(storeClipboardSourceFrame())
      }
      if (event.type === 'paste') {
        if (isEditableTarget(document.activeElement)) return false
        if (!copiedGeneratorFrameRef.current) storeClipboardSourceFrame()
        if (!copiedGeneratorFrameRef.current) return false
        return pasteCopiedFrame()
      }
      if (event.type !== 'keydown') return false
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return false
      const key = event.key.toLowerCase()
      if (key === 'c') return Boolean(storeClipboardSourceFrame())
      if (key === 'v' && !isEditableTarget(document.activeElement)) {
        if (!copiedGeneratorFrameRef.current) storeClipboardSourceFrame()
        if (!copiedGeneratorFrameRef.current) return false
        return pasteCopiedFrame()
      }
      return false
    }
    const pasteCopiedFrame = () => {
      const copiedFrame = copiedGeneratorFrameRef.current || storeClipboardSourceFrame()
      if (!copiedFrame) return false
      const pasteTime = Date.now()
      const lastPaste = lastGeneratorPasteRef.current
      if (lastPaste.sourceId === copiedFrame.id && pasteTime - lastPaste.time < 250) {
        return true
      }
      const currentElements = api.getSceneElementsIncludingDeleted()
      const copiedX = Number(copiedFrame.x) || 0
      const copiedY = Number(copiedFrame.y) || 0
      const copiedWidth = Math.max(1, Number(copiedFrame.width) || 1)
      const copiedHeight = Math.max(1, Number(copiedFrame.height) || 1)
      const sameRowTolerance = copiedHeight * 0.5
      const sameRowElements = currentElements.filter((element) => {
        if (!element || element.isDeleted) return false
        const y = Number(element.y) || 0
        return Math.abs(y - copiedY) < sameRowTolerance
      })
      const rowRight = sameRowElements.length > 0
        ? Math.max(...sameRowElements.map((element) => (Number(element.x) || 0) + Math.max(1, Number(element.width) || 1)))
        : copiedX + copiedWidth
      const newX = Math.round(rowRight + 14)
      const newY = Math.round(copiedY)
      const copiedKind = getGeneratorKind(copiedFrame)
      const copiedForm = frameFormFromElement(copiedFrame)
      const newFrame = {
        ...copiedFrame,
        id: crypto.randomUUID(),
        x: newX,
        y: newY,
        index: chooseIndex(currentElements),
        version: 1,
        versionNonce: Math.floor(Math.random() * 2 ** 31),
        seed: Math.floor(Math.random() * 2 ** 31),
        updated: pasteTime,
        customData: { ...(copiedFrame.customData ?? {}) }
      }
      lastGeneratorPasteRef.current = { time: pasteTime, sourceId: copiedFrame.id, frameId: newFrame.id }
      activeFrameIdRef.current = newFrame.id
      lastFocusedFrameIdRef.current = newFrame.id
      setActiveFrameId(newFrame.id)
      setActiveFrameKind(copiedKind)
      setFrameForm(copiedForm)
      setPendingPanelFrame(null)
      setSelectedGeneratedResult(null)
      setOpenMenu(null)
      const applyPastedFrame = () => {
        const liveElements = api.getSceneElementsIncludingDeleted()
        const liveWithoutDuplicate = liveElements.filter((element) => element.id !== newFrame.id)
        const nextElements = [...liveWithoutDuplicate, newFrame]
        const nextAppState = { ...api.getAppState(), selectedElementIds: { [newFrame.id]: true } }
        api.updateScene({
          elements: nextElements,
          appState: { selectedElementIds: { [newFrame.id]: true } },
          captureUpdate: CaptureUpdateAction.IMMEDIATELY
        })
        const nextScene = createScene(nextElements, nextAppState, api.getFiles())
        latestSceneRef.current = nextScene
        setFrameOverlays(buildFrameOverlays(nextScene))
        setSelectedImageOverlays(buildSelectedImageOverlays(nextScene))
        setVideoPlaybackOverlays(buildVideoPlaybackOverlays(nextScene))
        scheduleCanvasSave(nextScene)
        scheduleSelectionSave(nextScene)
      }
      applyPastedFrame()
      window.setTimeout(applyPastedFrame, 0)
      window.setTimeout(applyPastedFrame, 80)
      return true
    }
    const onKeyDown = (event) => {
      if (
        event.key === '9' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        !isEditableTarget(document.activeElement)
      ) {
        event.preventDefault()
        event.stopPropagation()
        if (typeof event.stopImmediatePropagation === 'function') {
          event.stopImmediatePropagation()
        }
        openToolbarMediaPicker()
        return
      }
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return
      if (!handleClipboardShortcut(event)) return
      event.preventDefault()
      event.stopPropagation()
      if (typeof event.stopImmediatePropagation === 'function') {
        event.stopImmediatePropagation()
      }
    }
    const onCopy = (event) => {
      if (!handleClipboardShortcut(event)) return
      event.preventDefault()
      event.stopPropagation()
      if (typeof event.stopImmediatePropagation === 'function') {
        event.stopImmediatePropagation()
      }
    }
    const onPaste = (event) => {
      if (!handleClipboardShortcut(event)) return
      event.preventDefault()
      event.stopPropagation()
      if (typeof event.stopImmediatePropagation === 'function') {
        event.stopImmediatePropagation()
      }
    }
    window.__lovartHandleClipboardShortcut = handleClipboardShortcut
    window.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('copy', onCopy, true)
    document.addEventListener('copy', onCopy, true)
    window.addEventListener('paste', onPaste, true)
    document.addEventListener('paste', onPaste, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('copy', onCopy, true)
      document.removeEventListener('copy', onCopy, true)
      window.removeEventListener('paste', onPaste, true)
      document.removeEventListener('paste', onPaste, true)
      if (window.__lovartHandleClipboardShortcut === handleClipboardShortcut) {
        delete window.__lovartHandleClipboardShortcut
      }
    }
  }, [api, frameForm, openToolbarMediaPicker, scheduleCanvasSave, scheduleSelectionSave])

  useEffect(() => {
    if (!api) return undefined

    const resolveToolbarInsertImageControl = (target) => {
      if (!(target instanceof Element)) return null
      const control = target.closest([
        '.App-toolbar label',
        '.App-toolbar button',
        '.App-toolbar [role="button"]',
        '.App-toolbar input',
        '.Island label',
        '.Island button',
        '.Island [role="button"]',
        '.Island input'
      ].join(', '))
      if (!(control instanceof HTMLElement)) return null
      const nestedInput = control instanceof HTMLInputElement
        ? control
        : control.querySelector('input')
      const controlMeta = `${control.getAttribute('title') || ''} ${control.getAttribute('aria-label') || ''}`.toLowerCase()
      const nestedMeta = nestedInput instanceof HTMLElement
        ? `${nestedInput.getAttribute('title') || ''} ${nestedInput.getAttribute('aria-label') || ''}`.toLowerCase()
        : ''
      const acceptMeta = nestedInput instanceof HTMLInputElement ? String(nestedInput.accept || '').toLowerCase() : ''
      const shortcutMeta = [
        control.getAttribute('aria-keyshortcuts') || '',
        nestedInput instanceof HTMLElement ? nestedInput.getAttribute('aria-keyshortcuts') || '' : ''
      ].join(' ').toLowerCase()
      const combinedMeta = `${controlMeta} ${nestedMeta}`
      const looksLikeImageTool =
        combinedMeta.includes('insert image') ||
        combinedMeta.includes('image') ||
        combinedMeta.includes('画像') ||
        combinedMeta.includes('media') ||
        combinedMeta.includes('メディア') ||
        (acceptMeta.includes('image') && (nestedInput instanceof HTMLInputElement))
      if (!looksLikeImageTool && !shortcutMeta.split(/\s+/).includes('9')) {
        return null
      }
      return control
    }

    const intercept = (event) => {
      if (!resolveToolbarInsertImageControl(event.target)) return
      event.preventDefault()
      event.stopPropagation()
      if (typeof event.stopImmediatePropagation === 'function') {
        event.stopImmediatePropagation()
      }
      if (event.type === 'click') openToolbarMediaPicker()
    }

    document.addEventListener('pointerdown', intercept, true)
    document.addEventListener('mousedown', intercept, true)
    document.addEventListener('click', intercept, true)
    return () => {
      document.removeEventListener('pointerdown', intercept, true)
      document.removeEventListener('mousedown', intercept, true)
      document.removeEventListener('click', intercept, true)
    }
  }, [api, openToolbarMediaPicker])

  useEffect(() => {
    if (!api) return undefined
    const root = document.querySelector('.excalidraw')
    const hover = hoverOverlayRef.current
    if (!root || !hover) return undefined

    let pointerIsDown = false
    let lastPointer = null
    let rafId = 0
    let wheelTrailFrames = 0

    const hideHover = () => {
      hover.style.display = 'none'
      setHoveredVideoPlaybackId('')
    }

    const updateHover = (event) => {
      lastPointer = event ? { clientX: event.clientX, clientY: event.clientY } : lastPointer
      if (!lastPointer || pointerIsDown || canvasPickerRef.current) {
        hideHover()
        return
      }

      const appState = api.getAppState?.() ?? {}
      const zoomValue = Number(appState.zoom?.value)
      const zoom = Number.isFinite(zoomValue) && zoomValue > 0 ? zoomValue : 1
      const rootRect = root.getBoundingClientRect()
      const scenePoint = {
        x: (lastPointer.clientX - rootRect.left) / zoom - (Number(appState.scrollX) || 0),
        y: (lastPointer.clientY - rootRect.top) / zoom - (Number(appState.scrollY) || 0)
      }
      const selectedIds = new Set(getSelectedIds(appState))
      const elements = (api.getSceneElementsIncludingDeleted?.() ?? api.getSceneElements?.() ?? [])
        .filter((element) => !element.isDeleted)
        .slice()
        .reverse()
      const target = elements.find((element) => {
        if (!(isCanvasImageElement(element) || isCanvasVideoElement(element) || isGeneratorFrame(element))) return false
        return scenePointInElement(scenePoint, element)
      })

      if (!target) {
        hideHover()
        return
      }

      setHoveredVideoPlaybackId(isCanvasVideoElement(target) ? target.id : '')
      if (selectedIds.has(target.id)) {
        hover.style.display = 'none'
        return
      }

      const placement = getFrameViewportPlacement(getElementGeometry(target), appState)
      hover.style.display = 'block'
      hover.style.left = `${placement.left + placement.width / 2}px`
      hover.style.top = `${placement.top + placement.height / 2}px`
      hover.style.width = `${placement.width}px`
      hover.style.height = `${placement.height}px`
      hover.style.transform = `translate(-50%, -50%)${Number(target.angle) ? ` rotate(${Number(target.angle)}rad)` : ''}`
    }

    const scheduleHoverUpdate = (event) => {
      if (event) lastPointer = { clientX: event.clientX, clientY: event.clientY }
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        rafId = 0
        updateHover()
      })
    }
    const trailHoverUpdate = () => {
      updateHover()
      wheelTrailFrames -= 1
      if (wheelTrailFrames > 0) rafId = requestAnimationFrame(trailHoverUpdate)
      else rafId = 0
    }
    const onPointerMove = (event) => scheduleHoverUpdate(event)
    const onPointerDown = (event) => {
      pointerIsDown = true
      // Remember the scene-space point of this click so handleChange can
      // re-select a generator frame if Excalidraw lands the selection on empty
      // interior or a child element ("click doesn't register" fix).
      if (event) {
        const appState = api.getAppState?.() ?? {}
        const zoom = Math.max(0.1, Number(appState.zoom?.value) || 1)
        const rootRect = root.getBoundingClientRect()
        lastPointerDownCanvasRef.current = {
          x: (event.clientX - rootRect.left) / zoom - (Number(appState.scrollX) || 0),
          y: (event.clientY - rootRect.top) / zoom - (Number(appState.scrollY) || 0),
          time: Date.now()
        }
      }
      if (rafId) cancelAnimationFrame(rafId)
      rafId = 0
      hideHover()
    }
    const onPointerUp = () => {
      pointerIsDown = false
      wheelTrailFrames = 4
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(trailHoverUpdate)
    }
    const onPointerLeave = () => {
      lastPointer = null
      if (rafId) cancelAnimationFrame(rafId)
      rafId = 0
      hideHover()
    }
    const onWheel = () => {
      if (!lastPointer) return
      wheelTrailFrames = 8
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(trailHoverUpdate)
    }

    root.addEventListener('pointermove', onPointerMove, true)
    root.addEventListener('pointerdown', onPointerDown, true)
    root.addEventListener('pointerleave', onPointerLeave, true)
    window.addEventListener('pointerup', onPointerUp, true)
    root.addEventListener('wheel', onWheel, true)
    return () => {
      root.removeEventListener('pointermove', onPointerMove, true)
      root.removeEventListener('pointerdown', onPointerDown, true)
      root.removeEventListener('pointerleave', onPointerLeave, true)
      window.removeEventListener('pointerup', onPointerUp, true)
      root.removeEventListener('wheel', onWheel, true)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [api])

  useEffect(() => {
    return () => {
      window.clearTimeout(saveTimerRef.current)
      window.clearTimeout(selectionTimerRef.current)
      window.clearTimeout(videoFrameLeaveTimerRef.current)
    }
  }, [])

  const updateActiveFrameElement = useCallback(
    (nextForm) => {
      if (!api || !activeFrameIdRef.current) return
      const elements = api.getSceneElementsIncludingDeleted()
      const frame = elements.find((element) => element.id === activeFrameIdRef.current)
      if (!frame || !isGeneratorFrame(frame)) return

      const kind = getGeneratorKind(frame)
      const size = frameSizeFor(kind, nextForm)
      const customData = {
        ...(frame.customData ?? {}),
        ...frameCustomDataFromForm(kind, nextForm),
        ...(kind === 'image'
          ? {
              pixelWidth: size.pixelWidth,
              pixelHeight: size.pixelHeight
            }
          : {})
      }
      const nextElements = elements.map((element) =>
        element.id === frame.id
          ? {
              ...element,
              width: size.width,
              height: size.height,
              customData,
              version: (element.version ?? 1) + 1,
              versionNonce: Math.floor(Math.random() * 2 ** 31),
              updated: Date.now()
            }
          : element
      )
      suppressNextChangeRef.current = true
      window.setTimeout(() => {
        api.updateScene({
          elements: nextElements,
          captureUpdate: CaptureUpdateAction.NEVER
        })
      }, 0)
      const nextScene = createScene(nextElements, api.getAppState(), api.getFiles())
      latestSceneRef.current = nextScene
      setFrameOverlays(buildFrameOverlays(nextScene))
      setSelectedImageOverlays(buildSelectedImageOverlays(nextScene))
      setVideoPlaybackOverlays(buildVideoPlaybackOverlays(nextScene))
      scheduleCanvasSave(nextScene)
    },
    [api, scheduleCanvasSave]
  )

  const updateFrameForm = useCallback(
    (key, value) => {
      let nextForm = null
      setFrameForm((current) => {
        const next = { ...current, [key]: value }
        nextForm = next
        return next
      })
      window.setTimeout(() => {
        if (nextForm) updateActiveFrameElement(nextForm)
      }, 0)
      setGenerationError('')
    },
    [updateActiveFrameElement]
  )

  const patchFrameForm = useCallback(
    (patch) => {
      let nextForm = null
      setFrameForm((current) => {
        const next = { ...current, ...patch }
        nextForm = next
        return next
      })
      window.setTimeout(() => {
        if (nextForm) updateActiveFrameElement(nextForm)
      }, 0)
      setGenerationError('')
    },
    [updateActiveFrameElement]
  )

  const uploadAssetFile = useCallback(async (file, options = {}) => {
    if (file.type.startsWith('audio/')) {
      const metadata = await readAudioMetadata(file)
      const formData = new FormData()
      formData.append('file', file, file.name)
      formData.append('fileName', file.name)
      const response = await fetch(ASSET_UPLOAD_ENDPOINT, {
        method: 'POST',
        body: formData
      })
      const payload = await response.json().catch(() => ({}))
      if (metadata.objectURL && typeof URL !== 'undefined') URL.revokeObjectURL(metadata.objectURL)
      if (!response.ok || payload.error) {
        throw new Error(payload.error || `Upload failed: ${response.status}`)
      }
      return {
        id: crypto.randomUUID(),
        name: file.name,
        kind: 'audio',
        mimeType: payload.mimeType || file.type || 'audio/mpeg',
        path: payload.path,
        url: payload.url,
        dataURL: '',
        thumbnail: '',
        duration: metadata.duration
      }
    }

    if (file.type.startsWith('video/')) {
      const poster = options.poster && typeof options.poster === 'object' ? options.poster : await readVideoPoster(file)
      const formData = new FormData()
      formData.append('file', file, file.name)
      formData.append('fileName', file.name)
      const response = await fetch(ASSET_UPLOAD_ENDPOINT, {
        method: 'POST',
        body: formData
      })
      const payload = await response.json().catch(() => ({}))
      if (!options.poster && poster.objectURL && typeof URL !== 'undefined') URL.revokeObjectURL(poster.objectURL)
      if (!response.ok || payload.error) {
        throw new Error(payload.error || `Upload failed: ${response.status}`)
      }
      return {
        id: crypto.randomUUID(),
        name: file.name,
        kind: 'video',
        mimeType: payload.mimeType || file.type || 'video/mp4',
        path: payload.path,
        url: payload.url,
        dataURL: '',
        thumbnail: poster.posterDataURL,
        duration: poster.duration,
        pixelWidth: poster.width,
        pixelHeight: poster.height
      }
    }

    const dataURL = await fileToDataURL(file)
    const response = await fetch(ASSET_UPLOAD_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, dataURL })
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || payload.error) {
      throw new Error(payload.error || `Upload failed: ${response.status}`)
    }
    return {
      id: crypto.randomUUID(),
      name: file.name,
      kind: file.type.startsWith('video/') ? 'video' : 'image',
      mimeType: file.type || inferMimeTypeFromDataURL(dataURL),
      path: payload.path,
      url: payload.url,
      dataURL: file.type.startsWith('video/') ? '' : dataURL,
      thumbnail: dataURL
    }
  }, [])

  const uploadAssetDataURL = useCallback(async (asset) => {
    const dataURL = typeof asset?.dataURL === 'string' ? asset.dataURL : ''
    if (!dataURL) return asset
    const fileName = asset.name || (asset.kind === 'video' ? 'canvas-video.mp4' : 'canvas-image.png')
    const response = await fetch(ASSET_UPLOAD_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName, dataURL })
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || payload.error) {
      throw new Error(payload.error || `Upload failed: ${response.status}`)
    }
    return {
      ...asset,
      path: payload.path || asset.path || '',
      url: payload.url || asset.url || '',
      dataURL: '',
      thumbnail: asset.kind === 'video' ? (asset.thumbnail || payload.url || '') : (asset.thumbnail || payload.url || '')
    }
  }, [])

  const addAssetToFrame = useCallback(
    (target, asset) => {
      if (!asset) return
      let nextForm = null
      setFrameForm((current) => {
        let next = current
        if (target === 'imageReferences') {
          next = { ...current, imageReferences: [...normalizeAssetList(current.imageReferences), asset].slice(-3) }
        } else if (target === 'videoStartFrame') {
          next = { ...current, videoStartFrame: asset }
        } else if (target === 'videoEndFrame') {
          next = { ...current, videoEndFrame: asset }
        } else if (target === 'videoReferenceVideos') {
          next = { ...current, videoReferenceVideos: [...normalizeAssetList(current.videoReferenceVideos), asset].slice(-3) }
        } else if (target === 'videoReferenceAudios') {
          next = { ...current, videoReferenceAudios: [...normalizeAssetList(current.videoReferenceAudios), asset].slice(-3) }
        } else {
          next = { ...current, videoReferenceImages: [...normalizeAssetList(current.videoReferenceImages), asset].slice(-3) }
        }
        nextForm = next
        return next
      })
      window.setTimeout(() => {
        if (nextForm) updateActiveFrameElement(nextForm)
      }, 0)
    },
    [updateActiveFrameElement]
  )

  const openCanvasPicker = useCallback((target) => {
    const frameId = activeFrameIdRef.current || selectedGeneratedResultRef.current?.elementId || ''
    canvasPickerFrameIdRef.current = frameId
    canvasPickerRef.current = { target, frameId }
    setCanvasPicker({ target, frameId })
    setOpenMenu(null)
    if (api && frameId) {
      suppressNextChangeRef.current = true
      window.setTimeout(() => {
        api.updateScene({
          appState: { selectedElementIds: { [frameId]: true } },
          captureUpdate: CaptureUpdateAction.NEVER
        })
      }, 0)
    }
    window.setTimeout(() => {
      canvasPickerFrameIdRef.current = frameId
      canvasPickerRef.current = { target, frameId }
      setCanvasPicker({ target, frameId })
    }, 0)
  }, [api])

  const rememberGeneratorUploadFrame = useCallback(() => {
    pendingGeneratorUploadFrameIdRef.current = activeFrameIdRef.current || selectedGeneratedResultRef.current?.elementId || ''
  }, [])

  const restoreGeneratorUploadFrame = useCallback(() => {
    const frameId = pendingGeneratorUploadFrameIdRef.current
    if (frameId) {
      activeFrameIdRef.current = frameId
      lastFocusedFrameIdRef.current = frameId
    }
    return frameId
  }, [])

  const closeCanvasPicker = useCallback(() => {
    canvasPickerRef.current = null
    canvasPickerFrameIdRef.current = ''
    setCanvasPicker(null)
  }, [])

  useEffect(() => {
    const onCanvasPickPointer = (event) => {
      if (event.type !== 'click') return
      const target = getCanvasPickTargetFromPointerEvent(event)
      if (!target) return
      event.preventDefault()
      event.stopPropagation()
      if (typeof event.stopImmediatePropagation === 'function') {
        event.stopImmediatePropagation()
      }
      openCanvasPicker(target)
    }
    document.addEventListener('click', onCanvasPickPointer, true)
    return () => {
      document.removeEventListener('click', onCanvasPickPointer, true)
    }
  }, [openCanvasPicker])

  useEffect(() => {
    canvasPickerRef.current = canvasPicker
  }, [canvasPicker])

  useEffect(() => {
    consumeCanvasPickerSelectionRef.current = (scene) => {
      const picker = canvasPickerRef.current
      if (!picker) return false
      const selectedIds = new Set(getSelectedIds(scene.appState))
      const selected = scene.elements.find((element) =>
        selectedIds.has(element.id) &&
        !isGeneratorFrame(element) &&
        (isCanvasImageElement(element) || isCanvasVideoElement(element))
      )
      if (!selected) return false
      const asset = assetReferenceFromElement(selected, scene.files)
      if (!asset) return false
      if (['videoStartFrame', 'videoEndFrame', 'videoReferenceImages'].includes(picker.target) && asset.kind !== 'image') return false
      if (picker.target === 'imageReferences' && asset.kind !== 'image' && asset.kind !== 'video') return false
      if (picker.target === 'videoReferenceVideos' && asset.kind !== 'video') return false
      if (picker.target === 'videoReferenceAudios' && asset.kind !== 'audio') return false
      const restoreFrameId = picker.frameId || canvasPickerFrameIdRef.current || ''
      const applyPickedAsset = (pickedAsset) => {
        if (restoreFrameId) activeFrameIdRef.current = restoreFrameId
        addAssetToFrame(picker.target, pickedAsset)
        closeCanvasPicker()
        if (api && restoreFrameId) {
          suppressNextChangeRef.current = true
          window.setTimeout(() => {
            api.updateScene({
              appState: { selectedElementIds: { [restoreFrameId]: true } },
              captureUpdate: CaptureUpdateAction.NEVER
            })
          }, 0)
        }
      }
      if (asset.dataURL && !asset.path && !asset.url) {
        uploadAssetDataURL(asset)
          .then(applyPickedAsset)
          .catch((error) => {
            setGenerationError(error.message)
            closeCanvasPicker()
          })
      } else {
        applyPickedAsset(asset)
      }
      return true
    }
    return () => {
      consumeCanvasPickerSelectionRef.current = null
    }
  }, [addAssetToFrame, api, closeCanvasPicker, uploadAssetDataURL])

  const onImageUploadChange = useCallback(async (event) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (files.length === 0) return
    restoreGeneratorUploadFrame()
    try {
      const assets = await Promise.all(
        files
          .filter((file) => file.type.startsWith('image/') || file.type.startsWith('video/'))
          .map(uploadAssetFile)
      )
      let nextForm = null
      setFrameForm((current) => {
        const next = { ...current, imageReferences: [...normalizeAssetList(current.imageReferences), ...assets].slice(-3) }
        nextForm = next
        return next
      })
      window.setTimeout(() => {
        if (nextForm) updateActiveFrameElement(nextForm)
      }, 0)
    } catch (error) {
      setGenerationError(error.message)
    }
  }, [restoreGeneratorUploadFrame, updateActiveFrameElement, uploadAssetFile])

  const onVideoFrameUploadChange = useCallback(async (event) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (files.length === 0) return
    const target = videoFrameUploadTargetRef.current
    const expectedKind = getUploadTargetKind(target)
    restoreGeneratorUploadFrame()
    try {
      const assets = (await Promise.all(files.map(uploadAssetFile))).filter((asset) => asset.kind === expectedKind)
      for (const asset of assets) {
        addAssetToFrame(target, asset)
      }
    } catch (error) {
      setGenerationError(error.message)
    }
  }, [addAssetToFrame, restoreGeneratorUploadFrame, uploadAssetFile])

  // Shared media inserter for both the toolbar media tool (#9) and drag-and-drop.
  // `atPoint` (scene coords) sets where placement starts; defaults to viewport center.
  const insertMediaFiles = useCallback(async (rawFiles, options = {}) => {
    const files = (rawFiles || []).filter((file) => file && (file.type.startsWith('image/') || file.type.startsWith('video/')))
    if (!api || files.length === 0) return

    try {
      const appState = api.getAppState()
      const currentElements = api.getSceneElementsIncludingDeleted()
      const filesForScene = { ...(api.getFiles?.() ?? {}) }
      const center = viewportCenter(appState)
      const liveFiles = []
      const videoUploadTasks = []
      const insertedIds = {}
      let nextElements = [...currentElements]
      let cursorX = options.point ? Math.round(options.point.x - 260) : Math.round(center.x - 260)
      let cursorY = options.point ? Math.round(options.point.y - 150) : Math.round(center.y - 150)

      for (const file of files) {
        if (file.type.startsWith('image/')) {
          const dataURL = await fileToDataURL(file)
          const dimensions = await readImageDimensions(dataURL)
          const displayWidth = Math.min(560, Math.max(160, dimensions.width))
          const displayHeight = Math.max(90, Math.round(displayWidth * (dimensions.height / dimensions.width)))
          const bounds = findNonOverlappingPlacement(nextElements, {
            x: cursorX,
            y: cursorY,
            width: displayWidth,
            height: displayHeight
          })
          const fileId = crypto.randomUUID()
          const fileRecord = {
            id: fileId,
            mimeType: file.type || inferMimeTypeFromDataURL(dataURL, 'image/png'),
            dataURL,
            created: Date.now(),
            lastRetrieved: Date.now()
          }
          filesForScene[fileId] = fileRecord
          liveFiles.push(fileRecord)
          const imageElement = createImageElementRecord({
            fileId,
            bounds,
            index: chooseElementIndex(nextElements),
            customData: {
              codexInsertedImage: true,
              codexMediaKind: 'image',
              codexFileName: file.name,
              codexPixelWidth: dimensions.width,
              codexPixelHeight: dimensions.height
            }
          })
          nextElements.push(imageElement)
          insertedIds[imageElement.id] = true
          cursorX = bounds.x + bounds.width + 24
          cursorY = bounds.y
        } else if (file.type.startsWith('video/')) {
          const poster = await readVideoPoster(file)
          const aspect = poster.width > 0 && poster.height > 0 ? poster.width / poster.height : 16 / 9
          const displayWidth = Math.min(560, Math.max(220, poster.width || 560))
          const displayHeight = Math.max(124, Math.round(displayWidth / aspect))
          const bounds = findNonOverlappingPlacement(nextElements, {
            x: cursorX,
            y: cursorY,
            width: displayWidth,
            height: displayHeight
          })
          const fileId = crypto.randomUUID()
          const posterDataURL = poster.posterDataURL || VIDEO_POSTER_FALLBACK_DATA_URL
          const fileRecord = {
            id: fileId,
            mimeType: inferMimeTypeFromDataURL(posterDataURL, 'image/jpeg'),
            dataURL: posterDataURL,
            created: Date.now(),
            lastRetrieved: Date.now()
          }
          filesForScene[fileId] = fileRecord
          liveFiles.push(fileRecord)
          const videoElement = createImageElementRecord({
            fileId,
            bounds,
            index: chooseElementIndex(nextElements),
            customData: {
              codexInsertedVideo: true,
              codexMediaKind: 'video',
              codexFileName: file.name,
              codexAssetPath: '',
              codexAssetUrl: poster.objectURL,
              codexVideoMimeType: file.type || 'video/mp4',
              codexPixelWidth: poster.width,
              codexPixelHeight: poster.height,
              codexVideoDuration: poster.duration
            }
          })
          nextElements.push(videoElement)
          insertedIds[videoElement.id] = true
          videoUploadTasks.push({ file, elementId: videoElement.id, objectURL: poster.objectURL, poster })
          cursorX = bounds.x + bounds.width + 24
          cursorY = bounds.y
        }
      }

      if (Object.keys(insertedIds).length === 0) return
      if (liveFiles.length > 0) api.addFiles(liveFiles)
      const nextAppState = { ...appState, selectedElementIds: insertedIds }
      const nextScene = createScene(nextElements, nextAppState, filesForScene)
      latestSceneRef.current = nextScene
      api.updateScene({
        elements: nextElements,
        appState: { selectedElementIds: insertedIds },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY
      })
      syncGeneratorUi(nextScene)
      scheduleSelectionSave(nextScene)
      scheduleCanvasSave(nextScene)
      for (const task of videoUploadTasks) {
        uploadAssetFile(task.file, { poster: task.poster })
          .then((uploaded) => {
            if (task.objectURL && typeof URL !== 'undefined') URL.revokeObjectURL(task.objectURL)
            const currentElementsForUpload = api.getSceneElementsIncludingDeleted()
            const updatedElements = currentElementsForUpload.map((element) => {
              if (element.id !== task.elementId) return element
              return {
                ...element,
                link: uploaded.url || element.link,
                customData: {
                  ...(element.customData ?? {}),
                  codexAssetPath: uploaded.path,
                  codexAssetUrl: uploaded.url,
                  codexVideoMimeType: uploaded.mimeType || element.customData?.codexVideoMimeType,
                  codexVideoDuration: Number(uploaded.duration) || Number(element.customData?.codexVideoDuration) || 0,
                  codexPixelWidth: Number(uploaded.pixelWidth) || Number(element.customData?.codexPixelWidth) || 0,
                  codexPixelHeight: Number(uploaded.pixelHeight) || Number(element.customData?.codexPixelHeight) || 0
                },
                version: (Number(element.version) || 1) + 1,
                versionNonce: Math.floor(Math.random() * 2 ** 31),
                updated: Date.now()
              }
            })
            api.updateScene({ elements: updatedElements, captureUpdate: CaptureUpdateAction.NEVER })
            const uploadedScene = createScene(updatedElements, api.getAppState(), api.getFiles())
            latestSceneRef.current = uploadedScene
            syncGeneratorUi(uploadedScene)
            scheduleSelectionSave(uploadedScene)
            saveCanvas(uploadedScene)
          })
          .catch((error) => {
            console.error(error)
            if (task.objectURL && typeof URL !== 'undefined') URL.revokeObjectURL(task.objectURL)
          })
      }
    } catch (error) {
      setGenerationError(error.message)
    }
  }, [api, saveCanvas, scheduleCanvasSave, scheduleSelectionSave, syncGeneratorUi, uploadAssetFile])

  const onToolbarMediaInputChange = useCallback(async (event) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    toolbarMediaPickerActiveRef.current = false
    await insertMediaFiles(files)
  }, [insertMediaFiles])

  // Drag-and-drop image/video files onto the canvas → inserted at the drop point
  // (videos become poster cards), matching the Youtube-AGI behavior.
  useEffect(() => {
    if (!api) return undefined
    const root = document.querySelector('.excalidraw')
    if (!root) return undefined

    const hasMediaFiles = (event) => {
      const items = event.dataTransfer?.items
      if (items && items.length) {
        return Array.from(items).some((it) => it.kind === 'file' && /^(image|video)\//.test(it.type || ''))
      }
      const types = event.dataTransfer?.types
      return Boolean(types && Array.prototype.includes.call(types, 'Files'))
    }

    const onDragOver = (event) => {
      if (!hasMediaFiles(event)) return
      // Suppress Excalidraw's native image-drop so videos get our card treatment.
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }

    const onDrop = (event) => {
      const files = Array.from(event.dataTransfer?.files || []).filter(
        (file) => file.type.startsWith('image/') || file.type.startsWith('video/')
      )
      if (files.length === 0) return
      event.preventDefault()
      event.stopPropagation()
      const appState = api.getAppState?.() ?? {}
      const zoomValue = Number(appState.zoom?.value)
      const zoom = Number.isFinite(zoomValue) && zoomValue > 0 ? zoomValue : 1
      const rootRect = root.getBoundingClientRect()
      const point = {
        x: (event.clientX - rootRect.left) / zoom - (Number(appState.scrollX) || 0),
        y: (event.clientY - rootRect.top) / zoom - (Number(appState.scrollY) || 0)
      }
      insertMediaFiles(files, { point })
    }

    root.addEventListener('dragover', onDragOver, true)
    root.addEventListener('drop', onDrop, true)
    return () => {
      root.removeEventListener('dragover', onDragOver, true)
      root.removeEventListener('drop', onDrop, true)
    }
  }, [api, insertMediaFiles])

  const insertGeneratorFrame = useCallback(
    (kind, form, options = {}) => {
      if (!api) return null

      const selectFrame = options.selectFrame !== false
      const openPanel = options.openPanel !== false
      const appState = api.getAppState()
      const elements = api.getSceneElementsIncludingDeleted()
      const baseSize = frameSizeFor(kind, form)
      const size = { width: baseSize.width, height: baseSize.height }
      const curScrollX = Number(appState.scrollX) || 0
      const curScrollY = Number(appState.scrollY) || 0
      const curZoom = Number(appState.zoom?.value) || 1
      const lastView = lastCreatedViewRef.current
      const viewportMoved = isAnimatingScrollRef.current
        ? false
        : !lastView ||
          Math.abs(lastView.scrollX - curScrollX) > 1 ||
          Math.abs(lastView.scrollY - curScrollY) > 1 ||
          Math.abs(lastView.zoom - curZoom) > 0.01
      const lastGeo = !viewportMoved ? lastCreatedFrameGeoRef.current : null
      const center = viewportCenter(appState)
      let frameX = lastGeo
        ? Math.round(lastGeo.x + lastGeo.width / 2 - size.width / 2)
        : Math.round(center.x - size.width / 2)
      let frameY = lastGeo
        ? Math.round(lastGeo.y + lastGeo.height + 14)
        : Math.round(center.y - size.height / 2 + (kind === 'video' ? -90 : -10))
      const originalFrameX = frameX
      const originalFrameY = frameY
      let wasOverlapping = false

      if (viewportMoved) {
        const placement = findNonOverlappingPlacement(elements, { x: frameX, y: frameY, width: size.width, height: size.height })
        frameX = placement.x
        frameY = placement.y
        wasOverlapping = frameX !== originalFrameX || frameY !== originalFrameY
      }

      const [frame] = convertToExcalidrawElements(
        [
          {
            type: 'rectangle',
            x: frameX,
            y: frameY,
            width: size.width,
            height: size.height,
            strokeColor: GENERATOR_FRAME_BORDER_COLOR,
            backgroundColor: GENERATOR_FRAME_FILL_COLOR,
            fillStyle: 'solid',
            strokeStyle: 'solid',
            strokeWidth: GENERATOR_FRAME_STROKE_WIDTH,
            roughness: 0,
            customData: {
              ...(kind === 'video' ? { [VIDEO_GENERATOR_FRAME_TAG]: true } : { [GENERATOR_FRAME_TAG]: true }),
              role: 'frame',
              ...(kind === 'image'
                ? {
                    pixelWidth: baseSize.pixelWidth,
                    pixelHeight: baseSize.pixelHeight
                  }
                : {}),
              ...frameCustomDataFromForm(kind, form)
            }
          }
        ],
        { regenerateIds: true }
      )
      const nextFrame = {
        ...frame,
        index: chooseIndex(elements)
      }
      const nextElements = [...elements, nextFrame]
      const viewportWidth = Number(appState.width) || 0
      const viewportHeight = Number(appState.height) || 0
      const targetScreenRatio = kind === 'video' ? 0.36 : 0.44
      let nextScrollX = curScrollX
      let nextScrollY = curScrollY
      let nextZoom = curZoom
      let shouldAnimate = false
      let targetScrollX = curScrollX
      let targetScrollY = curScrollY
      let targetZoom = curZoom

      if (viewportWidth > 0 && viewportHeight > 0) {
        if (viewportMoved) {
          const useZoom = wasOverlapping ? 2 : curZoom
          if (wasOverlapping) {
            targetZoom = 2
            shouldAnimate = true
          }
          const frameCenterX = frameX + size.width / 2
          const frameCenterY = frameY + size.height / 2
          const targetScreenX = viewportWidth / 2
          const targetScreenY = Math.min(
            viewportHeight * targetScreenRatio,
            Math.max(120, viewportHeight - (kind === 'video' ? 280 : 195))
          )
          if (shouldAnimate) {
            targetScrollX = targetScreenX / useZoom - frameCenterX
            targetScrollY = targetScreenY / useZoom - frameCenterY
          } else {
            nextScrollX = targetScreenX / useZoom - frameCenterX
            nextScrollY = targetScreenY / useZoom - frameCenterY
          }
        } else {
          const frameBottomScreen = (frameY + size.height + curScrollY) * curZoom
          if (frameBottomScreen + 200 > viewportHeight) {
            shouldAnimate = true
            targetZoom = 2
            const frameCenterX = frameX + size.width / 2
            const frameCenterY = frameY + size.height / 2
            const targetScreenX = viewportWidth / 2
            const targetScreenY = Math.min(
              viewportHeight * targetScreenRatio,
              Math.max(120, viewportHeight - (kind === 'video' ? 280 : 195))
            )
            targetScrollX = targetScreenX / targetZoom - frameCenterX
            targetScrollY = targetScreenY / targetZoom - frameCenterY
          }
        }
      }

      const selectedElementIds = selectFrame ? { [nextFrame.id]: true } : {}
      const nextAppState = {
        ...appState,
        selectedElementIds,
        scrollX: shouldAnimate ? targetScrollX : nextScrollX,
        scrollY: nextScrollY
      }

      suppressNextChangeRef.current = true
      justCreatedFrameIdRef.current = nextFrame.id
      previousGeneratorFrameIdsRef.current = new Set(nextElements.filter(isGeneratorFrame).map((element) => element.id))
      lastCreatedFrameGeoRef.current = getElementGeometry(nextFrame)
      api.updateScene({
        elements: nextElements,
        appState: {
          selectedElementIds,
          scrollX: shouldAnimate ? targetScrollX : nextScrollX,
          scrollY: nextScrollY
        },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY
      })

      if (shouldAnimate) {
        lastCreatedViewRef.current = { scrollX: targetScrollX, scrollY: targetScrollY, zoom: targetZoom }
        isAnimatingScrollRef.current = true
        const generation = ++scrollAnimGenerationRef.current
        const startTime = performance.now()
        const startScrollY = nextScrollY
        const startZoom = curZoom
        const easeOutCubic = (t) => 1 - (1 - t) ** 3
        const animateStep = (now) => {
          if (generation !== scrollAnimGenerationRef.current) return
          const rawProgress = Math.min((now - startTime) / GENERATOR_SCROLL_ANIMATION_MS, 1)
          const progress = easeOutCubic(rawProgress)
          const zoom = startZoom + (targetZoom - startZoom) * progress
          const frameCenterX = frameX + size.width / 2
          const scrollX = viewportWidth / (2 * zoom) - frameCenterX
          const scrollY = startScrollY + (targetScrollY - startScrollY) * progress
              api.updateScene({
                appState: {
                  zoom: { value: zoom },
                  scrollX,
                  scrollY
                },
                captureUpdate: CaptureUpdateAction.NEVER
              })
              const animatedScene = createScene(
                nextElements,
                {
                  ...appState,
                  selectedElementIds,
                  zoom: { value: zoom },
                  scrollX,
                  scrollY
                },
                api.getFiles()
              )
              latestSceneRef.current = animatedScene
              setFrameOverlays(buildFrameOverlays(animatedScene))
              setSelectedImageOverlays(buildSelectedImageOverlays(animatedScene))
              setVideoPlaybackOverlays(buildVideoPlaybackOverlays(animatedScene))
              if (rawProgress < 1) {
                requestAnimationFrame(animateStep)
              } else {
                isAnimatingScrollRef.current = false
                lastCreatedViewRef.current = { scrollX, scrollY, zoom }
            const finalScene = createScene(api.getSceneElementsIncludingDeleted(), api.getAppState(), api.getFiles())
            latestSceneRef.current = finalScene
            scheduleCanvasSave(finalScene)
          }
        }
        requestAnimationFrame(animateStep)
      } else if (!isAnimatingScrollRef.current) {
        lastCreatedViewRef.current = { scrollX: nextScrollX, scrollY: nextScrollY, zoom: nextZoom }
      }

      if (openPanel) {
        activeFrameIdRef.current = nextFrame.id
        lastFocusedFrameIdRef.current = nextFrame.id
        setActiveFrameId(nextFrame.id)
        setActiveFrameKind(kind)
        setFrameForm(form)
        setPendingPanelFrame({ id: nextFrame.id, kind })
        setSelectedGeneratedResult(null)
        setOpenMenu(null)
        setGenerationError('')
        requestAnimationFrame(() => {
          const excalidrawElement = document.querySelector('.excalidraw')
          if (excalidrawElement instanceof HTMLElement) excalidrawElement.focus()
          const currentState = api.getAppState?.() ?? {}
          if (selectFrame && !currentState.selectedElementIds?.[nextFrame.id]) {
            suppressNextChangeRef.current = true
            api.updateScene({
              appState: { selectedElementIds: { [nextFrame.id]: true } },
              captureUpdate: CaptureUpdateAction.NEVER
            })
          }
        })
        window.setTimeout(() => {
          if (pendingPanelFrameRef.current?.id === nextFrame.id) setPendingPanelFrame(null)
        }, 3000)
      }

      const nextScene = createScene(nextElements, nextAppState, api.getFiles())
      latestSceneRef.current = nextScene
      setFrameOverlays(buildFrameOverlays(nextScene))
      setSelectedImageOverlays(buildSelectedImageOverlays(nextScene))
      setVideoPlaybackOverlays(buildVideoPlaybackOverlays(nextScene))
      scheduleCanvasSave(nextScene)
      scheduleSelectionSave(nextScene)
      return { frame: nextFrame, scene: nextScene }
    },
    [api, scheduleCanvasSave, scheduleSelectionSave]
  )

  const createGeneratorFrame = useCallback(
    (kind) => {
      const form = {
        ...DEFAULT_FRAME_FORM,
        ...(kind === 'video' ? { prompt: '', videoAspectRatio: '16:9' } : { prompt: '', aspectRatio: '1:1' })
      }
      insertGeneratorFrame(kind, form, { selectFrame: true, openPanel: true })
    },
    [insertGeneratorFrame]
  )

  const runFrameGeneration = useCallback(async () => {
    if (!api) return
    const selectedResult = selectedGeneratedResultRef.current
    const activeFrameIdForGeneration = activeFrameIdRef.current
    const anchorElementId = activeFrameIdForGeneration || selectedResult?.elementId || ''
    if (!anchorElementId || generatingFrameIds.has(anchorElementId)) return
    const scene = latestSceneRef.current
    const anchorElement = scene.elements.find((element) => element.id === anchorElementId)
    if (!anchorElement) return
    const isRegeneratingResult = !activeFrameIdForGeneration && selectedResult && isGeneratedResult(anchorElement)
    if (!isRegeneratingResult && !isGeneratorFrame(anchorElement)) return

    const kind = isRegeneratingResult ? selectedResult.kind : getGeneratorKind(anchorElement)
    const prompt = frameForm.prompt.trim()
    if (!prompt) {
      setGenerationError('プロンプトを入力してください。')
      return
    }

    const savedForm = { ...frameForm, prompt }
    const savedVideoReferenceImages = normalizeAssetList(savedForm.videoReferenceImages)
    const savedVideoReferenceVideos = normalizeAssetList(savedForm.videoReferenceVideos)
    if (kind === 'video' && savedForm.videoModel === 'grok-imagine-video-hermes') {
      if (savedForm.videoTab === 'keyframe') {
        if (savedForm.videoEndFrame) {
          setGenerationError('Grok Imagine(Hermes) は終了フレーム指定に未対応です。開始画像のみ指定できます。')
          return
        }
        if (savedForm.videoStartFrame?.kind === 'video') {
          setGenerationError('Grok Imagine(Hermes) の開始フレームには画像を指定してください。')
          return
        }
      }
      if (savedForm.videoTab === 'reference') {
        if (savedVideoReferenceImages.length > 7) {
          setGenerationError('Grok Imagine(Hermes) のリファレンス画像は最大7枚までです。')
          return
        }
        if ((Number.parseInt(savedForm.duration, 10) || 0) > 10) {
          setGenerationError('Grok Imagine(Hermes) のリファレンス動画生成は最大10秒までです。')
          return
        }
        if (savedVideoReferenceImages.length === 0 && savedVideoReferenceVideos.length === 0) {
          setGenerationError('リファレンスでは画像または動画を指定してください。')
          return
        }
      }
    }
    if (!isRegeneratingResult) updateActiveFrameElement(savedForm)
    setOpenMenu(null)
    setGenerationError('')
    setGeneratingFrameIds((current) => new Set(current).add(anchorElementId))
    setPendingPanelFrame(null)
    setSelectedGeneratedResult(null)
    activeFrameIdRef.current = ''
    setActiveFrameId('')
    if (api) {
      suppressNextChangeRef.current = true
      window.setTimeout(() => {
        api.updateScene({
          appState: { selectedElementIds: {} },
          captureUpdate: CaptureUpdateAction.NEVER
        })
      }, 0)
    }

    try {
      await saveCanvas(latestSceneRef.current)
      const endpoint = kind === 'video' ? GENERATE_VIDEO_ENDPOINT : GENERATE_IMAGE_ENDPOINT
      const body =
        kind === 'video'
          ? {
              prompt,
              model: savedForm.videoModel,
              aspectRatio: savedForm.videoAspectRatio,
              duration: savedForm.duration,
              resolution: savedForm.resolution,
              useReference: savedForm.videoTab === 'reference',
              startFramePath: savedForm.videoTab === 'reference' ? undefined : savedForm.videoStartFrame?.path || undefined,
              imageUrl: savedForm.videoTab === 'reference' || savedForm.videoStartFrame?.path ? undefined : savedForm.videoStartFrame?.dataURL || undefined,
              endFramePath: savedForm.videoTab === 'keyframe' ? savedForm.videoEndFrame?.path || undefined : undefined,
              endFrameDataURL: savedForm.videoTab === 'keyframe' && !savedForm.videoEndFrame?.path ? savedForm.videoEndFrame?.dataURL || undefined : undefined,
              referenceAudioPaths: savedForm.videoTab === 'reference' ? normalizeAssetList(savedForm.videoReferenceAudios).map((asset) => asset.path).filter(Boolean) : [],
              referenceImagePaths: savedForm.videoTab === 'reference' ? savedVideoReferenceImages.map((asset) => asset.path).filter(Boolean) : [],
              referenceImages: savedForm.videoTab === 'reference' ? savedVideoReferenceImages.map((asset) => asset.dataURL || asset.url).filter(Boolean) : [],
              referenceVideoPaths: savedForm.videoTab === 'reference' ? savedVideoReferenceVideos.map((asset) => asset.path).filter(Boolean) : [],
              referenceVideos: savedForm.videoTab === 'reference' ? savedVideoReferenceVideos.map((asset) => asset.dataURL || asset.url).filter(Boolean) : [],
              generateAudio: savedForm.videoGenerateAudio !== false,
              selectCreated: true,
              anchorElementId,
              placement: 'replace',
              replaceAnchor: true,
              matchAnchor: true,
              displayWidth: anchorElement.width,
              displayHeight: anchorElement.height,
              customData: frameCustomDataFromForm(kind, savedForm)
            }
          : {
              prompt,
              model: savedForm.imageModel,
              aspectRatio: savedForm.aspectRatio,
              quality: savedForm.quality,
              referenceImagePaths: normalizeAssetList(savedForm.imageReferences)
                .filter((asset) => asset.kind !== 'video')
                .map((asset) => asset.path)
                .filter(Boolean),
              referenceImages: normalizeAssetList(savedForm.imageReferences)
                .filter((asset) => asset.kind !== 'video')
                .map((asset) => asset.dataURL || asset.url)
                .filter(Boolean),
              referenceVideoPaths: normalizeAssetList(savedForm.imageReferences)
                .filter((asset) => asset.kind === 'video')
                .map((asset) => asset.path)
                .filter(Boolean),
              referenceVideos: normalizeAssetList(savedForm.imageReferences)
                .filter((asset) => asset.kind === 'video')
                .map((asset) => asset.url || asset.dataURL)
                .filter(Boolean),
              selectCreated: true,
              anchorElementId,
              placement: 'replace',
              replaceAnchor: true,
              matchAnchor: true,
              displayWidth: anchorElement.width,
              displayHeight: anchorElement.height,
              customData: frameCustomDataFromForm(kind, savedForm)
            }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.error) {
        throw new Error(payload.error || `Generation failed: ${response.status}`)
      }
      const canvasResponse = await fetch(CANVAS_ENDPOINT)
      if (canvasResponse.ok) {
        const canvasPayload = await canvasResponse.json()
        // After generation the server replaces the frame with the result and
        // selects it; apply that selection so the result's panel opens.
        applyRemoteScene(canvasPayload.scene, { force: true, applySelection: true })
      }
    } catch (error) {
      setGenerationError(error.message)
      if (api) {
        const currentElements = api.getSceneElementsIncludingDeleted()
        let nextElements = currentElements
        let selectedElementIds = {}
        if (isRegeneratingResult && selectedResult?.elementId) {
          selectedElementIds = { [selectedResult.elementId]: true }
          activeFrameIdRef.current = ''
          selectedGeneratedResultRef.current = selectedResult
          setActiveFrameId('')
          setSelectedGeneratedResult(selectedResult)
          setActiveFrameKind(selectedResult.kind)
        } else {
          selectedElementIds = { [anchorElementId]: true }
          activeFrameIdRef.current = anchorElementId
          lastFocusedFrameIdRef.current = anchorElementId
          setActiveFrameId(anchorElementId)
          setActiveFrameKind(kind)
          setSelectedGeneratedResult(null)
        }
        setFrameForm(savedForm)
        suppressNextChangeRef.current = true
        window.setTimeout(() => {
          api.updateScene({
            elements: nextElements,
            appState: { selectedElementIds },
            captureUpdate: CaptureUpdateAction.NEVER
          })
        }, 0)
        const errorScene = createScene(nextElements, { ...api.getAppState(), selectedElementIds }, api.getFiles())
        latestSceneRef.current = errorScene
        setFrameOverlays(buildFrameOverlays(errorScene))
        setSelectedImageOverlays(buildSelectedImageOverlays(errorScene))
        setVideoPlaybackOverlays(buildVideoPlaybackOverlays(errorScene))
        scheduleCanvasSave(errorScene)
        scheduleSelectionSave(errorScene)
      }
    } finally {
      setGeneratingFrameIds((current) => {
        const next = new Set(current)
        next.delete(anchorElementId)
        return next
      })
    }
  }, [api, applyRemoteScene, frameForm, generatingFrameIds, insertGeneratorFrame, saveCanvas, scheduleCanvasSave, scheduleSelectionSave, selectedGeneratedResult, updateActiveFrameElement])

  if (!initialScene) {
    return <main className="codex-excalidraw-status">Loading canvas...</main>
  }

  if (loadError) {
    return <main className="codex-excalidraw-status">Canvas file could not be loaded.</main>
  }

  const activeOverlay = frameOverlays.find((overlay) => overlay.id === activeFrameId)
  const isCurrentFrameGenerating = activeFrameId ? generatingFrameIds.has(activeFrameId) : false
  const activePanelTarget = activeOverlay ?? selectedGeneratedResult
  const panelAppState = latestSceneRef.current?.appState ?? {}
  const activePanelTargetIsVisible = activePanelTarget
    ? isViewportPlacementNearViewport(activePanelTarget, panelAppState, 24)
    : false
  const showPromptPanel = Boolean(activePanelTarget && activePanelTargetIsVisible && !isCurrentFrameGenerating)
  const imageModels = capabilities?.imageModels ?? [
    { id: 'gpt-image-2-codex', label: 'GPT-Image-2.0(Codex)' },
    { id: 'grok-imagine-image-hermes', label: 'Grok Imagine(Hermes)' }
  ]
  const videoModels = capabilities?.videoModels ?? [{ id: 'grok-imagine-video-hermes', label: 'Grok Imagine(Hermes)' }]
  const imageModelLabel = imageModels.find((model) => model.id === frameForm.imageModel)?.label ?? frameForm.imageModel
  const videoModelLabel = videoModels.find((model) => model.id === frameForm.videoModel)?.label ?? frameForm.videoModel
  const imageReferences = normalizeAssetList(frameForm.imageReferences)
  const videoReferenceImages = normalizeAssetList(frameForm.videoReferenceImages)
  const videoReferenceVideos = normalizeAssetList(frameForm.videoReferenceVideos)
  const videoReferenceAudios = normalizeAssetList(frameForm.videoReferenceAudios)
  const videoFrameMenuOpen = openMenu && (
    openMenu === 'videoStartFrame' ||
    openMenu === 'videoEndFrame' ||
    openMenu === 'videoReferenceImages' ||
    openMenu === 'videoReferenceVideos' ||
    openMenu === 'videoReferenceAudios'
  )
  const openMenuBlocksPrompt = Boolean(openMenu && !videoFrameMenuOpen)
  const hasAnyVideoReferenceAsset = Boolean(videoReferenceImages.length || videoReferenceVideos.length || videoReferenceAudios.length)
  const hasVisibleVideoFrame = Boolean(frameForm.videoStartFrame || frameForm.videoEndFrame || videoFrameBtnsHovered || videoFrameMenuOpen || (frameForm.videoTab === 'reference' && hasAnyVideoReferenceAsset))
  const hasVideoAssetTray = hasVisibleVideoFrame
  const canSwapVideoKeyframes = Boolean(
    activeFrameKind === 'video' &&
      frameForm.videoTab === 'keyframe' &&
      canUseVideoFrameTarget(frameForm.videoModel, frameForm.videoTab, 'end') &&
      (frameForm.videoStartFrame || frameForm.videoEndFrame)
  )
  const panelPlacement = showPromptPanel
    ? getPanelPlacementFromViewportTarget(activePanelTarget, activeFrameKind === 'video')
    : null
  const panelStyle = panelPlacement
    ? {
        left: `${panelPlacement.left}px`,
        top: `${panelPlacement.top}px`,
        bottom: 'auto',
        width: `${panelPlacement.width}px`,
        transform: 'none'
      }
    : undefined
  const closeOpenMenuIfOutsideGeneratorUi = (event) => {
    if (!openMenu) return
    const target = event.target
    if (target instanceof Element) {
      const isInsideGeneratorUi = target.closest(
        '.lovart-ai-panel, .lovart-menu, .lovart-canvas-picker-bar'
      )
      if (isInsideGeneratorUi) return
    }
    setOpenMenu(null)
  }

  return (
    <main
      className={`codex-excalidraw-shell lovart-ai-root${showPromptPanel ? ' hide-generator-props' : ''}`}
      aria-label="Codex Excalidraw canvas"
      onPointerDownCapture={closeOpenMenuIfOutsideGeneratorUi}
      onMouseDownCapture={closeOpenMenuIfOutsideGeneratorUi}
      onClickCapture={closeOpenMenuIfOutsideGeneratorUi}
    >
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={{
          elements: initialScene.elements,
          appState: initialScene.appState,
          files: initialScene.files
        }}
        onChange={handleChange}
      />
      {api ? (
        <div className="lovart-ai-rail">
          <button
            type="button"
            className="lovart-ai-button"
            aria-label="画像ジェネレーター"
            data-lovart-tooltip="画像ジェネレーター"
            data-lovart-generator-kind="image"
            onPointerDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              createGeneratorFrame('image')
            }}
          >
            <ImageGeneratorToolIcon />
          </button>
          <button
            type="button"
            className="lovart-ai-button"
            aria-label="動画ジェネレーター"
            data-lovart-tooltip="動画ジェネレーター"
            data-lovart-generator-kind="video"
            onPointerDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              createGeneratorFrame('video')
            }}
          >
            <VideoGeneratorToolIcon />
          </button>
        </div>
      ) : null}

      {frameOverlays.map((overlay) => {
        const isGenerating = generatingFrameIds.has(overlay.id)
        const isVideo = overlay.kind === 'video'
        const overlayMetrics = getFrameOverlayMetrics(overlay.width, overlay.height)
        return (
          <div
            key={overlay.id}
            className={`lovart-frame-overlay${overlay.isSelected ? ' is-selected' : ''}`}
            style={{
              left: `${overlay.left}px`,
              top: `${overlay.top}px`,
              width: `${overlay.width}px`,
              height: `${overlay.height}px`,
              pointerEvents: isGenerating ? 'auto' : undefined,
              cursor: isGenerating ? 'grab' : undefined
            }}
            onWheel={isGenerating ? (event) => {
              const canvas = document.querySelector('.excalidraw canvas')
              if (canvas) {
                canvas.dispatchEvent(new WheelEvent('wheel', {
                  deltaX: event.deltaX,
                  deltaY: event.deltaY,
                  deltaMode: event.deltaMode,
                  clientX: event.clientX,
                  clientY: event.clientY,
                  ctrlKey: event.ctrlKey,
                  metaKey: event.metaKey,
                  shiftKey: event.shiftKey,
                  bubbles: true,
                  cancelable: true
                }))
              }
            } : undefined}
            onPointerDown={isGenerating ? (event) => {
              event.preventDefault()
              event.stopPropagation()
              if (!api) return
              let lastX = event.clientX
              let lastY = event.clientY
              let pendingDx = 0
              let pendingDy = 0
              let rafId = 0
              const overlayElement = event.currentTarget
              overlayElement.style.cursor = 'grabbing'
              isDraggingGeneratorRef.current = true
              const flushMove = () => {
                rafId = 0
                if (pendingDx === 0 && pendingDy === 0) return
                const dx = pendingDx
                const dy = pendingDy
                pendingDx = 0
                pendingDy = 0
                const movedElements = api.getSceneElementsIncludingDeleted().map((element) =>
                  element.id === overlay.id && !element.isDeleted
                    ? {
                        ...element,
                        x: (Number(element.x) || 0) + dx,
                        y: (Number(element.y) || 0) + dy,
                        version: (Number(element.version) || 1) + 1,
                        versionNonce: Math.floor(Math.random() * 2 ** 31),
                        updated: Date.now()
                      }
                    : element
                )
                api.updateScene({
                  elements: movedElements,
                  captureUpdate: CaptureUpdateAction.NEVER
                })
              }
              const onMove = (moveEvent) => {
                const appState = api.getAppState?.() ?? {}
                const zoom = Number(appState.zoom?.value) || 1
                pendingDx += (moveEvent.clientX - lastX) / zoom
                pendingDy += (moveEvent.clientY - lastY) / zoom
                lastX = moveEvent.clientX
                lastY = moveEvent.clientY
                if (!rafId) rafId = requestAnimationFrame(flushMove)
              }
              const onUp = () => {
                isDraggingGeneratorRef.current = false
                overlayElement.style.cursor = ''
                window.removeEventListener('pointermove', onMove)
                window.removeEventListener('pointerup', onUp)
                if (rafId) {
                  cancelAnimationFrame(rafId)
                  rafId = 0
                }
                flushMove()
              }
              window.addEventListener('pointermove', onMove)
              window.addEventListener('pointerup', onUp)
            } : undefined}
          >
            {overlayMetrics.showHeader ? (
              <div
                className="lovart-frame-header"
                style={{ top: `-${overlayMetrics.headerOffset}px`, fontSize: `${overlayMetrics.headerFontSize}px` }}
              >
                <div className="lovart-frame-title">
                  {overlayMetrics.showTitleIcon ? <span>▣</span> : null}
                  <span className="lovart-frame-title-text">{isVideo ? 'Video Generator' : 'Image Generator'}</span>
                </div>
                {overlayMetrics.showSize ? <div className="lovart-frame-size">{overlay.pixelWidth} x {overlay.pixelHeight}</div> : null}
              </div>
            ) : null}
            <div className="lovart-frame-inner">
              {isGenerating ? <div className={`lovart-frame-generating-bg${isVideo ? ' video' : ''}`} /> : null}
              <div className="lovart-frame-center">
                {isVideo ? <VideoCenterIcon size={overlayMetrics.iconSize} /> : <FrameCenterIcon size={overlayMetrics.iconSize} />}
              </div>
              {isGenerating && overlayMetrics.showLoading ? (
                <div
                  className="lovart-frame-loading"
                  style={{
                    fontSize: `${Math.max(8, Math.min(16, Math.round(overlay.width * 0.06)))}px`,
                    padding: `${Math.max(4, Math.min(10, Math.round(overlay.height * 0.03)))}px ${Math.max(8, Math.min(18, Math.round(overlay.width * 0.06)))}px`,
                    borderRadius: `${Math.max(4, Math.min(12, Math.round(overlay.width * 0.04)))}px`,
                    bottom: `${Math.max(4, Math.min(20, Math.round(overlay.height * 0.06)))}px`
                  }}
            >
              Generating...
            </div>
          ) : null}
        </div>
      </div>
    )
  })}

      {videoPlaybackOverlays.map((video) => (
        <VideoCanvasOverlay
          key={video.id}
          video={video}
          isHovered={hoveredVideoPlaybackId === video.id}
          onExpand={setExpandedVideoPlayback}
        />
      ))}

      {selectedImageOverlays.map((img) => {
        const headerFontSize = Math.max(5, Math.min(14, Math.round(img.width * 0.055)))
        const headerOffset = Math.max(6, Math.min(18, headerFontSize + 3))
        if (img.width < 28) return null
        return (
          <div
            key={img.id}
            style={{
              position: 'absolute',
              left: `${img.left}px`,
              top: `${img.top}px`,
              width: `${img.width}px`,
              height: `${img.height}px`,
              pointerEvents: 'none',
              transform: img.angle ? `rotate(${img.angle}rad)` : undefined,
              transformOrigin: 'center center'
            }}
          >
            <div className="lovart-image-header" style={{ top: `-${headerOffset}px`, fontSize: `${headerFontSize}px` }}>
              <div className="lovart-image-header-name">
                <span style={{ fontSize: '0.9em' }}>{img.assetType === 'video' ? '🎬' : '🖼'}</span>
                <span className="lovart-image-header-name-text">{img.fileName}</span>
              </div>
              {img.pixelWidth > 0 && img.pixelHeight > 0 && img.width >= 90 ? (
                <div className="lovart-image-header-size">{img.pixelWidth} × {img.pixelHeight}</div>
              ) : null}
            </div>
          </div>
        )
      })}
      <div ref={hoverOverlayRef} className="lovart-hover-border" style={{ display: 'none' }} />

      {expandedVideoPlayback ? (
        <ExpandedVideoPlayer video={expandedVideoPlayback} onClose={() => setExpandedVideoPlayback(null)} />
      ) : null}

      {openMenu ? (
        <button
          type="button"
          aria-label="設定を閉じる"
          ref={menuBackdropRef}
          className="lovart-menu-backdrop"
          onPointerDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setOpenMenu(null)
          }}
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setOpenMenu(null)
          }}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setOpenMenu(null)
          }}
          onMouseUp={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setOpenMenu(null)
          }}
        />
      ) : null}

      {showPromptPanel ? (
        <section
          className={`lovart-ai-panel${openMenuBlocksPrompt ? ' has-open-menu' : ''}`}
          style={panelStyle}
          aria-label={activeFrameKind === 'video' ? 'Video Generator' : 'Image Generator'}
          onPointerDownCapture={(event) => {
            const target = getCanvasPickTargetFromPointerEvent(event)
            if (!target) return
            event.preventDefault()
            event.stopPropagation()
            openCanvasPicker(target)
          }}
          onMouseDownCapture={(event) => {
            const target = getCanvasPickTargetFromPointerEvent(event)
            if (!target) return
            event.preventDefault()
            event.stopPropagation()
            openCanvasPicker(target)
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            if (event.target !== event.currentTarget) return
            const menuButton = Array.from(event.currentTarget.querySelectorAll('.lovart-menu button')).find((button) => {
              const rect = button.getBoundingClientRect()
              return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
            })
            menuButton?.click()
          }}
        >
          <div
            className={[
              'lovart-prompt-wrap',
              activeFrameKind === 'video' ? 'has-video-slots' : '',
              videoFrameMenuOpen ? 'has-video-menu' : ''
            ].filter(Boolean).join(' ')}
            style={activeFrameKind === 'image' && imageReferences.length > 0 ? { height: '104px' } : activeFrameKind === 'video' && hasVideoAssetTray ? { height: '140px' } : undefined}
            onMouseEnter={activeFrameKind === 'video' ? () => {
              window.clearTimeout(videoFrameLeaveTimerRef.current)
              setVideoFrameBtnsHovered(true)
            } : undefined}
            onMouseLeave={activeFrameKind === 'video' ? () => {
              if (!videoFrameMenuOpen) {
                videoFrameLeaveTimerRef.current = window.setTimeout(() => setVideoFrameBtnsHovered(false), 120)
              }
            } : undefined}
          >
            <textarea
              className="lovart-ai-prompt"
              style={
                activeFrameKind === 'image' && imageReferences.length > 0
                  ? { height: '48px', minHeight: '48px', overflowY: 'auto' }
                  : activeFrameKind === 'video' && hasVideoAssetTray
                    ? { height: '48px', minHeight: '48px', overflowY: 'auto', paddingBottom: 0, resize: 'none' }
                    : undefined
              }
              placeholder="今日は何をしますか？"
              value={frameForm.prompt}
              onChange={(event) => updateFrameForm('prompt', event.target.value)}
              onFocus={() => setOpenMenu(null)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  runFrameGeneration()
                }
              }}
            />
            {activeFrameKind === 'image' && imageReferences.length > 0 ? (
              <div className="lovart-ref-row">
                {imageReferences.map((item) => (
                  <div key={item.id} className="lovart-ref-thumb">
                    <img src={item.thumbnail || item.dataURL || item.url} alt={item.name || 'reference'} />
                    {item.kind === 'video' ? <span className="lovart-ref-play" aria-hidden="true">▶</span> : null}
                    <button
                      type="button"
                      className="lovart-ref-delete"
                      onClick={() => patchFrameForm({ imageReferences: imageReferences.filter((ref) => ref.id !== item.id) })}
                    >
                      <CloseIcon />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {activeFrameKind === 'video' ? (
              <div
                className={`lovart-video-frame-tray${hasVideoAssetTray ? ' is-open' : ''}`}
                onMouseEnter={() => {
                  window.clearTimeout(videoFrameLeaveTimerRef.current)
                  setVideoFrameBtnsHovered(true)
                }}
                onMouseLeave={() => {
                  if (!videoFrameMenuOpen) {
                    videoFrameLeaveTimerRef.current = window.setTimeout(() => setVideoFrameBtnsHovered(false), 120)
                  }
                }}
              >
                {['start', 'end'].map((slot) => {
                  const asset = slot === 'start' ? frameForm.videoStartFrame : frameForm.videoEndFrame
                  const target =
                    frameForm.videoTab === 'reference'
                      ? (slot === 'start' ? 'videoReferenceVideos' : 'videoReferenceImages')
                      : (slot === 'start' ? 'videoStartFrame' : 'videoEndFrame')
                  const slotTarget = slot === 'start' ? 'start' : 'end'
                  const slotDisabled = !canUseVideoFrameTarget(frameForm.videoModel, frameForm.videoTab, slotTarget)
                  const slotAsset =
                    frameForm.videoTab === 'reference'
                      ? null
                      : asset
                  return (
                  <div key={slot} className={`lovart-video-slot ${slot}`}>
                  <button
                    type="button"
                    data-lovart-trigger={`video-frame-${slot}`}
                    className={`lovart-add-frame-btn ${slot}${slotAsset ? ' has-asset' : ''}${slotDisabled ? ' is-disabled' : ''}`}
                    disabled={slotDisabled}
                    title={slot === 'start' ? '開始フレーム' : '終了フレーム'}
                    onClick={() => {
                      if (slotDisabled) return
                      setVideoFrameBtnsHovered(true)
                      setOpenMenu((current) => (current === target ? null : target))
                    }}
                  >
                    {slotAsset ? (
                      <>
                        <img className="lovart-slot-thumb" src={slotAsset.thumbnail || slotAsset.dataURL || slotAsset.url} alt={slotAsset.name || slot} />
                        {slotAsset.kind === 'video' ? <span className="lovart-slot-play">▶</span> : null}
                      </>
                    ) : (
                      <>
                        <span className="lovart-add-plus">+</span>
                        <span className="lovart-add-label">{getVideoFrameSlotLabel(frameForm.videoTab, slotTarget)}</span>
                      </>
                    )}
                  </button>
                  {slotAsset ? (
                    <button type="button" className="lovart-frame-del" onClick={() => patchFrameForm({ [target]: null })}>
                      <CloseIcon />
                    </button>
                  ) : null}
                  {openMenu === target ? (
                    <div className="lovart-menu lovart-slot-menu" data-lovart-menu={`video-frame-${slot}`}>
                      <button
                        type="button"
                        onClick={() => {
                          rememberGeneratorUploadFrame()
                          videoFrameUploadTargetRef.current = target
                          if (videoFrameUploadInputRef.current) {
                            videoFrameUploadInputRef.current.accept = getUploadTargetAccept(target)
                            videoFrameUploadInputRef.current.multiple = frameForm.videoTab === 'reference'
                            videoFrameUploadInputRef.current.click()
                          }
                          setOpenMenu(null)
                        }}
                      >
                        <UploadIcon />
                        <span>{getVideoFrameUploadLabel(frameForm.videoTab, slotTarget)}</span>
                      </button>
                      <button
                        type="button"
                        data-lovart-canvas-pick-target={target}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          openCanvasPicker(target)
                        }}
                      >
                        <CanvasPickIcon />
                        <span>キャンバスから選択</span>
                      </button>
                    </div>
                  ) : null}
                  </div>
                )})}
                {canSwapVideoKeyframes ? (
                  <button
                    type="button"
                    className="lovart-frame-swap"
                    title="入れ替え"
                    onClick={(event) => {
                      event.stopPropagation()
                      let nextForm = null
                      setFrameForm((current) => {
                        const next = swapVideoKeyframes(current)
                        nextForm = next
                        return next
                      })
                      window.setTimeout(() => {
                        if (nextForm) updateActiveFrameElement(nextForm)
                      }, 0)
                      setOpenMenu(null)
                    }}
                  >
                    ⇄
                  </button>
                ) : null}
                {frameForm.videoTab === 'reference' ? (
                  <>
                    {supportsAudioReference(frameForm.videoModel) ? (
                    <div className="lovart-video-slot audio">
                      <button
                        type="button"
                        data-lovart-trigger="video-frame-audio"
                        className="lovart-add-frame-btn audio"
                        title="音声"
                        onClick={() => {
                          setVideoFrameBtnsHovered(true)
                          rememberGeneratorUploadFrame()
                          videoFrameUploadTargetRef.current = 'videoReferenceAudios'
                          if (videoFrameUploadInputRef.current) {
                            videoFrameUploadInputRef.current.accept = getUploadTargetAccept('videoReferenceAudios')
                            videoFrameUploadInputRef.current.multiple = true
                            videoFrameUploadInputRef.current.click()
                          }
                          setOpenMenu(null)
                        }}
                      >
                        <span className="lovart-add-plus">+</span>
                        <span className="lovart-add-label">音声</span>
                      </button>
                    </div>
                    ) : null}
                    {[...videoReferenceVideos, ...videoReferenceImages].map((asset) => (
                      <div key={asset.id} className={`lovart-ref-card ${asset.kind}`}>
                        <img src={asset.thumbnail || asset.dataURL || asset.url} alt={asset.name || 'reference'} />
                        {asset.kind === 'video' ? <span className="lovart-slot-play">▶</span> : null}
                        <button
                          type="button"
                          className="lovart-frame-del"
                          onClick={() => {
                            patchFrameForm({
                              videoReferenceImages: videoReferenceImages.filter((ref) => ref.id !== asset.id),
                              videoReferenceVideos: videoReferenceVideos.filter((ref) => ref.id !== asset.id)
                            })
                          }}
                        >
                          <CloseIcon />
                        </button>
                      </div>
                    ))}
                    {supportsAudioReference(frameForm.videoModel)
                      ? videoReferenceAudios.map((asset) => (
                      <div key={asset.id} className="lovart-ref-card audio">
                        <AudioWaveIcon />
                        <span>{formatAssetDuration(asset.duration)}</span>
                        <button
                          type="button"
                          className="lovart-frame-del"
                          onClick={() => {
                            patchFrameForm({
                              videoReferenceAudios: videoReferenceAudios.filter((ref) => ref.id !== asset.id)
                            })
                          }}
                        >
                          <CloseIcon />
                        </button>
                      </div>
                        ))
                      : null}
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
          {generationError ? <div className="lovart-error">{generationError}</div> : null}
          <div className="lovart-ai-bottom">
            <div className="lovart-ai-left">
              {activeFrameKind === 'video' ? (
                <div className="lovart-video-tabs">
                  <button
                    type="button"
                    className={frameForm.videoTab === 'keyframe' ? 'is-selected' : ''}
                    onClick={() => {
                      setOpenMenu(null)
                      patchFrameForm({ videoTab: 'keyframe' })
                    }}
                  >
                    キーフレーム
                  </button>
                  <button
                    type="button"
                    className={frameForm.videoTab === 'reference' ? 'is-selected' : ''}
                    onClick={() => {
                      setOpenMenu(null)
                      patchFrameForm({ videoTab: 'reference' })
                    }}
                  >
                    リファレンス
                  </button>
                </div>
              ) : null}
              <div className="lovart-menu-wrap">
                <button
                  type="button"
                  className={`lovart-pill${openMenu === 'model' ? ' tooltip-hidden' : ''}`}
                  onClick={() => setOpenMenu((current) => (current === 'model' ? null : 'model'))}
                >
                  <span>{activeFrameKind === 'video' ? videoModelLabel : imageModelLabel}</span>
                  <ChevronIcon />
                </button>
                {openMenu === 'model' ? (
                  <div className="lovart-menu" data-lovart-menu="model">
                    <div className="lovart-menu-header">モデル</div>
                    {(activeFrameKind === 'video' ? videoModels : imageModels).map((model) => (
                      <button
                        type="button"
                        key={model.id}
                        onClick={() => {
                          updateFrameForm(activeFrameKind === 'video' ? 'videoModel' : 'imageModel', model.id)
                          setOpenMenu(null)
                        }}
                      >
                        <span>{model.label}</span>
                        {(activeFrameKind === 'video' ? frameForm.videoModel : frameForm.imageModel) === model.id ? (
                          <span className="menu-check">✓</span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              {activeFrameKind === 'image' ? (
                <div className="lovart-menu-wrap">
                  <button
                    type="button"
                    data-lovart-trigger="asset"
                    className={`lovart-pill${openMenu === 'asset' ? ' tooltip-hidden' : ''}`}
                    data-lovart-tooltip="参照"
                    onClick={() => setOpenMenu((current) => (current === 'asset' ? null : 'asset'))}
                  >
                      <PhotoIcon />
                  </button>
                  {openMenu === 'asset' ? (
                    <div className="lovart-menu" data-lovart-menu="asset">
                      <button
                        type="button"
                        onClick={() => {
                          rememberGeneratorUploadFrame()
                          imageUploadInputRef.current?.click()
                          setOpenMenu(null)
                        }}
                      >
                        <UploadIcon />
                        <span>画像・動画をアップロード</span>
                      </button>
                      <button
                        type="button"
                        data-lovart-canvas-pick-target="imageReferences"
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          openCanvasPicker('imageReferences')
                        }}
                      >
                        <CanvasPickIcon />
                        <span>キャンバスから選択</span>
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="lovart-ai-right">
              {activeFrameKind === 'image' ? (
                <>
                  <div className="lovart-menu-wrap">
                    <button
                      type="button"
                      className="lovart-pill"
                      onClick={() => setOpenMenu((current) => (current === 'quality' ? null : 'quality'))}
                    >
                      <span>{IMAGE_QUALITY_OPTIONS.find(([value]) => value === frameForm.quality)?.[1] ?? 'Auto'}</span>
                      <ChevronIcon />
                    </button>
                    {openMenu === 'quality' ? (
                      <div className="lovart-menu" data-lovart-menu="quality">
                        <div className="lovart-menu-header">品質</div>
                        {IMAGE_QUALITY_OPTIONS.map(([value, label]) => (
                          <button
                            type="button"
                            key={value}
                            onClick={() => {
                              updateFrameForm('quality', value)
                              setOpenMenu(null)
                            }}
                          >
                            <span>{label}</span>
                            {frameForm.quality === value ? <span className="menu-check">✓</span> : null}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="lovart-menu-wrap">
                    <button
                      type="button"
                      className="lovart-pill"
                      data-lovart-tooltip="サイズ"
                      onClick={() => setOpenMenu((current) => (current === 'ratio' ? null : 'ratio'))}
                    >
                      <span>{frameForm.aspectRatio}</span>
                      <ChevronIcon />
                    </button>
                    {openMenu === 'ratio' ? (
                      <div className="lovart-menu wide" data-lovart-menu="ratio">
                        <div className="lovart-menu-header">形式</div>
                        {Object.entries(IMAGE_ASPECTS).map(([ratio, size]) => (
                          <button
                            type="button"
                            key={ratio}
                            onClick={() => {
                              updateFrameForm('aspectRatio', ratio)
                              setOpenMenu(null)
                            }}
                          >
                            <span className="lovart-ratio-icon">
                              <span
                                className="lovart-ratio-shape"
                                style={{
                                  width: ratio === '16:9' ? 16 : ratio === '9:16' ? 8 : 12,
                                  height: ratio === '9:16' ? 16 : ratio === '16:9' ? 8 : 12
                                }}
                              />
                            </span>
                            <span>{ratio}</span>
                            <span className="menu-right">{size.baseWidth}*{size.baseHeight}</span>
                            {frameForm.aspectRatio === ratio ? <span className="menu-check">✓</span> : null}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </>
              ) : (
                <div className="lovart-menu-wrap">
                  <button
                    type="button"
                    className="lovart-pill"
                    data-lovart-trigger="video-settings"
                    onClick={() => setOpenMenu((current) => (current === 'video-settings' ? null : 'video-settings'))}
                  >
                    <span>{`${frameForm.videoAspectRatio}・${frameForm.duration}s・${frameForm.resolution}`}</span>
                    <ChevronIcon />
                  </button>
                  {openMenu === 'video-settings' ? (
                    <div className="lovart-menu wide lovart-video-settings" data-lovart-menu="video-settings">
                      <div className="lovart-menu-header">Size</div>
                      <div className="lovart-menu-grid">
                        {Object.keys(VIDEO_ASPECTS).map((ratio) => (
                          <button
                            type="button"
                            key={ratio}
                            onClick={() => updateFrameForm('videoAspectRatio', ratio)}
                            className={frameForm.videoAspectRatio === ratio ? 'is-selected' : ''}
                          >
                            <span
                              className="lovart-video-ratio-shape"
                              style={{
                                width: ratio === '16:9' ? 24 : ratio === '9:16' ? 14 : ratio === '1:1' ? 20 : ratio === '4:3' ? 22 : ratio === '3:4' ? 16 : ratio === '21:9' ? 28 : 20,
                                height: ratio === '16:9' ? 14 : ratio === '9:16' ? 24 : ratio === '1:1' ? 20 : ratio === '4:3' ? 16 : ratio === '3:4' ? 22 : ratio === '21:9' ? 12 : 20
                              }}
                            />
                            <span className="lovart-video-ratio-label">{ratio}</span>
                          </button>
                        ))}
                      </div>
                      <div className="lovart-setting-row">
                        <div className="lovart-menu-header">Duration</div>
                        <span>{frameForm.duration}s</span>
                      </div>
                      <input
                        type="range"
                        min="1"
                        max="15"
                        step="1"
                        className="lovart-duration-slider"
                        value={frameForm.duration}
                        style={{ background: `linear-gradient(to right, #7c3aed 0%, #7c3aed ${(Number(frameForm.duration) - 1) / 14 * 100}%, #e0e0e0 ${(Number(frameForm.duration) - 1) / 14 * 100}%, #e0e0e0 100%)` }}
                        onChange={(event) => updateFrameForm('duration', event.target.value)}
                      />
                      <div className="lovart-menu-header">Quality</div>
                      <div className="lovart-menu-grid compact">
                        {['480p', '720p'].map((resolution) => (
                          <button
                            type="button"
                            key={resolution}
                            onClick={() => updateFrameForm('resolution', resolution)}
                            className={frameForm.resolution === resolution ? 'is-selected' : ''}
                          >
                            <span>{resolution}</span>
                          </button>
                        ))}
                      </div>
                      <div className="lovart-audio-row">
                        <div className="lovart-menu-header">オーディオ</div>
                        <button
                          type="button"
                          className={`lovart-audio-toggle${frameForm.videoGenerateAudio ? ' is-on' : ''}`}
                          onClick={() => updateFrameForm('videoGenerateAudio', !frameForm.videoGenerateAudio)}
                          aria-pressed={frameForm.videoGenerateAudio}
                          aria-label="オーディオ"
                        >
                          <span />
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
              <button
                type="button"
                className={`lovart-generate${isCurrentFrameGenerating ? ' is-generating' : ''}`}
                disabled={!frameForm.prompt.trim() || isCurrentFrameGenerating}
                onClick={runFrameGeneration}
              >
                <LightningIcon />
                {isCurrentFrameGenerating ? <span>Generating...</span> : <span>0</span>}
              </button>
            </div>
          </div>
        </section>
      ) : null}
      {canvasPicker ? (
        <div className="lovart-canvas-picker-bar">
          <span>キャンバスから選択</span>
          <button type="button" onClick={closeCanvasPicker}>終了</button>
        </div>
      ) : null}
      <input
        ref={imageUploadInputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        hidden
        onChange={onImageUploadChange}
      />
      <input
        ref={toolbarMediaInputRef}
        data-lovart-upload-input="toolbar-media"
        type="file"
        accept="image/*,video/*"
        multiple
        hidden
        onChange={onToolbarMediaInputChange}
      />
      <input
        ref={videoFrameUploadInputRef}
        data-lovart-upload-input="video-frame"
        type="file"
        accept="image/*,video/*"
        multiple={videoFrameUploadTargetRef.current === 'videoReferenceImages' || videoFrameUploadTargetRef.current === 'videoReferenceVideos' || videoFrameUploadTargetRef.current === 'videoReferenceAudios'}
        hidden
        onChange={onVideoFrameUploadChange}
      />
    </main>
  )
}
