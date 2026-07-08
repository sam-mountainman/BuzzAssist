import {
  CaptureUpdateAction,
  Excalidraw,
  convertToExcalidrawElements
} from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { generateKeyBetween } from 'fractional-indexing'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IMAGE_MODEL_FAMILIES,
  MEDIA_ROUTES,
  VIDEO_MODEL_FAMILIES,
  concreteModelFor,
  defaultRouteIdFor,
  generationModelFor,
  imageFamilyForModel,
  routeIdForModel,
  videoFamilyForModel
} from '../lib/modelCatalog.mjs'
import { estimateCreditsForJob } from '../lib/mediaCredits.mjs'
import { providerIconDataUri } from './providerIcons.js'

const CANVAS_ENDPOINT = '/api/canvas'
const CANVAS_EVENTS_ENDPOINT = '/api/canvas-events'
const GENERATE_IMAGE_ENDPOINT = '/api/generate/image'
const GENERATE_VIDEO_ENDPOINT = '/api/generate/video'
const GENERATE_SUBTITLES_ENDPOINT = '/api/generate/subtitles'
const SILENCE_CUT_ENDPOINT = '/api/video/silence-cut'
const GENERATION_CAPABILITIES_ENDPOINT = '/api/generation-capabilities'
const ASSET_UPLOAD_ENDPOINT = '/api/assets/upload'
const SELECTION_ENDPOINT = '/api/selection'
const VIEW_STATE_ENDPOINT = '/api/view-state'
const AI_HOLDER_KEY = 'codexAiImageHolder'
const GENERATOR_FRAME_TAG = 'buzzassist.imageGenerator.frame'
const VIDEO_GENERATOR_FRAME_TAG = 'buzzassist.videoGenerator.frame'
const SUBTITLE_GENERATOR_FRAME_TAG = 'buzzassist.subtitleGenerator.frame'
const SILENCE_CUT_GENERATOR_FRAME_TAG = 'buzzassist.silenceCutGenerator.frame'
const LOVART_GENERATOR_FRAME_TAG = 'buzzassist.lovartGenerator.frame'
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
const OVERLAY_RENDER_MARGIN = 320
const FRAME_OVERLAY_MAX_ITEMS = 320
const MEDIA_HEADER_OVERLAY_MAX_ITEMS = 320
const VIDEO_PLAYBACK_OVERLAY_MAX_ITEMS = 120
const SUBTITLE_PREVIEW_OVERLAY_MAX_ITEMS = 120
const ATTACHMENT_CARD_WIDTH = 320
const ATTACHMENT_CARD_HEIGHT = 180
// BuzzAssist subtitle-card footprint (matches lib/canvasScene.mjs).
const SUBTITLE_CARD_WIDTH = 205
const SUBTITLE_CARD_HEIGHT = 364
const COLLAPSED_FREEDRAW_MAX_DIMENSION = 1
const TEXT_ATTACHMENT_EXTENSIONS = new Set(['txt', 'md', 'markdown'])
const VIDEO_POSTER_FALLBACK_DATA_URL =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjgwIDcyMCI+PHJlY3Qgd2lkdGg9IjEyODAiIGhlaWdodD0iNzIwIiBmaWxsPSIjMTExODI3Ii8+PHBhdGggZD0iTTU2MCAyNTB2MjIwbDE5MC0xMTB6IiBmaWxsPSIjZmZmIiBvcGFjaXR5PSIuOSIvPjwvc3ZnPg=='
const VIDEO_POSTER_CAPTURE_MAX_WIDTH = 960
const VIDEO_POSTER_SCORE_SAMPLE_SIZE = 48
const VIDEO_POSTER_GOOD_SCORE = 42

function currentTunnelAccessToken() {
  if (typeof window === 'undefined') return ''
  try {
    const params = new URLSearchParams(window.location.search)
    return params.get('t') || params.get('token') || ''
  } catch {
    return ''
  }
}

function isLocalCanvasHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]'
}

function isTunnelCanvasRuntime() {
  if (typeof window === 'undefined') return false
  return !isLocalCanvasHostname(window.location.hostname)
}

function canvasRequestInfo(input) {
  if (typeof window === 'undefined' || (typeof input !== 'string' && !(input instanceof URL))) {
    return { url: input, sameOrigin: false }
  }

  const raw = String(input)
  try {
    const url = new URL(raw, window.location.href)
    const sameOrigin = url.origin === window.location.origin
    const localCanvasUrl =
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      isLocalCanvasHostname(url.hostname) &&
      (url.pathname.startsWith('/api/') || url.pathname.startsWith(CANVAS_ASSETS_ROUTE))

    if (!sameOrigin && !localCanvasUrl) return { url: input, sameOrigin: false }

    if (localCanvasUrl && !isLocalCanvasHostname(window.location.hostname)) {
      url.protocol = window.location.protocol
      url.host = window.location.host
    }

    const token = currentTunnelAccessToken()
    if (token && !url.searchParams.has('t') && !url.searchParams.has('token')) {
      url.searchParams.set('t', token)
    }

    const nextUrl = url.origin === window.location.origin
      ? `${url.pathname}${url.search}${url.hash}`
      : url.href
    return { url: nextUrl, sameOrigin: url.origin === window.location.origin }
  } catch {
    return { url: input, sameOrigin: false }
  }
}

function canvasFetch(input, init) {
  const request = canvasRequestInfo(input)
  if (!request.sameOrigin) return window.fetch(request.url, init)
  return window.fetch(request.url, {
    ...(init ?? {}),
    credentials: init?.credentials ?? 'include'
  })
}

function createCanvasEventSource(url) {
  const request = canvasRequestInfo(url)
  return request.sameOrigin
    ? new EventSource(request.url, { withCredentials: true })
    : new EventSource(request.url)
}

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
  imageSize: '1K',
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
  videoMode: 'pro',
  subtitleMode: 'scripted',
  subtitlePrompt: '',
  subtitleLineCount: 2,
  subtitleMaxChars: 30,
  subtitleHoldSeconds: 0,
  subtitlePunctuationMode: 'auto',
  subtitleFillerMode: 'keep',
  subtitleScriptText: '',
  subtitleScriptName: '',
  subtitleGlossary: '',
  subtitleAudio: null,
  silenceCutModel: 'elevenlabs-scribe-v2',
  silenceCutInstruction: '',
  silenceCutFillerRemoval: 40,
  silenceCutCoughRemoval: 0,
  silenceCutRetakeRemoval: 0,
  silenceCutVideo: null,
  silenceCutOutput: null,
  silenceCutDetectSeconds: 0.6,
  silenceCutKeepSeconds: 0.25,
  silenceCutThresholdDb: -34,
  silenceCutThresholdAuto: true,
  silenceCutPreMarginSeconds: 0.08,
  silenceCutPostMarginSeconds: 0.12,
  lovartKind: 'image',
  lovartModel: 'lovart-midjourney',
  lovartVideoModel: 'lovart-veo-3-1',
  lovartAspectRatio: '1:1',
  lovartVideoAspectRatio: '16:9',
  lovartReferences: [],
}

const SUBTITLE_MODE_OPTIONS = [
  ['scripted', '台本あり'],
  ['scriptless', '台本なし']
]

const SUBTITLE_PUNCTUATION_OPTIONS = [
  ['auto', '自動で付ける'],
  ['none', '付けない']
]

const SUBTITLE_FILLER_OPTIONS = [
  ['keep', '残す'],
  ['safe', '控えめに消す'],
  ['contextual', 'しっかり消す']
]

// Youtube-AGI SILENCE_CUT_MODEL_OPTIONS
const SILENCE_CUT_MODEL_OPTIONS = [
  ['elevenlabs-scribe-v2', 'ElevenLabs Scribe v2'],
  ['ffmpeg-local', 'FFmpeg Local']
]
// AI cleanup intensity presets (オフ/弱/中/強), matching Youtube-AGI
// ワンタップの強さプリセット（検出長さ・残す間・前後余白）
const SILENCE_CUT_PRESETS = [
  ['テンポ重視', { detect: 0.45, keep: 0.12, pre: 0.06, post: 0.08 }],
  ['標準', { detect: 0.6, keep: 0.25, pre: 0.08, post: 0.12 }],
  ['ゆったり', { detect: 0.8, keep: 0.45, pre: 0.1, post: 0.18 }]
]

const SILENCE_CUT_INTENSITY_OPTIONS = [
  [0, 'オフ'],
  [30, '弱'],
  [60, '中'],
  [90, '強']
]

// Same level mapping as the BuzzAssist desktop app: stored intensities from
// older sessions still highlight the nearest level.
function silenceCutAiLevelLabel(value) {
  const parsed = Number(value) || 0
  if (parsed <= 0) return 'オフ'
  if (parsed < 45) return '弱'
  if (parsed < 75) return '中'
  return '強'
}

function formatSilenceCutSecondsLabel(value) {
  return `${Math.round(Number(value) * 100) / 100}秒`
}

function defaultSubtitleMaxCharsFor(lineCount) {
  return lineCount === 1 ? 20 : 30
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

// Lovart-routed models: only what the API actually controls gets a
// settings UI. Shared families reuse their BuzzAssist/local variant's
// gating; Lovart-only models fall back to the generic baseline (aspect +
// duration) because Lovart's OpenAPI takes tool selection + prompt text
// only — model-specific knobs beyond that are not API-controllable.
function resolveGatingImageModel(model) {
  if (!String(model || '').startsWith('lovart-')) return model
  const family = imageFamilyForModel(model)
  return family?.routes?.buzzassist ?? family?.routes?.codex ?? family?.routes?.hermes ?? model
}

function resolveGatingVideoModel(model) {
  if (!String(model || '').startsWith('lovart-')) return model
  const family = videoFamilyForModel(model)
  return family?.routes?.buzzassist ?? family?.routes?.hermes ?? model
}

// Models with a fixed duration menu (buttons) instead of the free slider.
const VIDEO_DURATION_CHOICES = {
  'kling-v2-6': ['5', '10']
}

function getVideoDurationChoices(model) {
  return VIDEO_DURATION_CHOICES[resolveGatingVideoModel(model)] ?? null
}

function isGrokVideoModel(model) {
  model = resolveGatingVideoModel(model)
  return model === 'grok-imagine-video-hermes' || model === 'grok-imagine-video-api'
}

// --- Per-model settings gating, ported from Youtube-AGI App.tsx ---
const VIDEO_ASPECT_RATIO_OPTIONS = ['16:9', '9:16', '1:1']
const SEEDANCE_VIDEO_ASPECT_RATIO_OPTIONS = ['auto', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9']
const GROK_VIDEO_ASPECT_RATIO_OPTIONS = ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3']
const KLING_2_6_VIDEO_DURATIONS = ['5', '10']
const VIDEO_MODE_OPTIONS = [
  ['standard', 'Std'],
  ['pro', 'Pro']
]
const GROK_IMAGE_ASPECT_RATIO_OPTIONS = {
  '1:1': { baseWidth: 1024, baseHeight: 1024 },
  '16:9': { baseWidth: 1456, baseHeight: 816 },
  '9:16': { baseWidth: 816, baseHeight: 1456 },
  '4:3': { baseWidth: 1232, baseHeight: 928 },
  '3:4': { baseWidth: 928, baseHeight: 1232 },
  '3:2': { baseWidth: 1344, baseHeight: 896 },
  '2:3': { baseWidth: 896, baseHeight: 1344 },
  '2:1': { baseWidth: 1440, baseHeight: 720 },
  '1:2': { baseWidth: 720, baseHeight: 1440 },
  '19.5:9': { baseWidth: 1560, baseHeight: 720 },
  '9:19.5': { baseWidth: 720, baseHeight: 1560 },
  '20:9': { baseWidth: 1600, baseHeight: 720 },
  '9:20': { baseWidth: 720, baseHeight: 1600 }
}
const IMAGE_MODEL_SIZES = {
  'gpt-image-2-codex': ['1K'],
  'gpt-image-2': ['1K'],
  'grok-imagine-image-hermes': ['1K', '2K'],
  'grok-imagine-image-api': ['1K', '2K'],
  'nano-banana-2': ['0.5K', '1K', '2K', '4K'],
  'seedream-v5-lite': ['1K', '2K', '4K']
}
const GROK_IMAGE_QUALITY_OPTIONS = [
  ['auto', 'Auto'],
  ['standard', 'Standard'],
  ['quality', 'Quality']
]

function isSeedanceModel(model) {
  model = resolveGatingVideoModel(model)
  return model === 'seedance-2' || model === 'seedance-2-fast'
}

function isGrokImageModel(model) {
  model = resolveGatingImageModel(model)
  return model === 'grok-imagine-image-hermes' || model === 'grok-imagine-image-api'
}

function isGptStyleImageModel(model) {
  model = resolveGatingImageModel(model)
  return model === 'gpt-image-2' || model === 'gpt-image-2-codex'
}

function usesImageQualitySelection(model) {
  return isGptStyleImageModel(model) || isGrokImageModel(model)
}

function getImageQualityOptions(model) {
  return isGrokImageModel(model) ? GROK_IMAGE_QUALITY_OPTIONS : IMAGE_QUALITY_OPTIONS
}

function getAvailableImageSizes(model) {
  // Lovart's API cannot set an output size — the picker only shows on
  // routes where size is a real parameter.
  if (String(model || '').startsWith('lovart-')) return ['1K']
  return IMAGE_MODEL_SIZES[resolveGatingImageModel(model)] ?? ['1K']
}

const MIDJOURNEY_ASPECT_RATIO_OPTIONS = ['16:9', '4:3', '1:1', '3:4', '9:16', '2:3', '3:2']

function getAvailableImageAspectRatios(model) {
  if (resolveGatingImageModel(model) === 'lovart-midjourney') return MIDJOURNEY_ASPECT_RATIO_OPTIONS
  return isGrokImageModel(model) ? Object.keys(GROK_IMAGE_ASPECT_RATIO_OPTIONS) : Object.keys(IMAGE_ASPECTS)
}

function supportsResolutionSelection(model) {
  if (String(model || '').startsWith('lovart-')) return false
  return isSeedanceModel(model) || isGrokVideoModel(model)
}

function supportsGenerateAudio(model) {
  if (String(model || '').startsWith('lovart-')) return false
  return isSeedanceModel(model)
}

function getVideoAspectRatioOptions(model) {
  if (isSeedanceModel(model)) return SEEDANCE_VIDEO_ASPECT_RATIO_OPTIONS
  if (isGrokVideoModel(model)) return GROK_VIDEO_ASPECT_RATIO_OPTIONS
  return VIDEO_ASPECT_RATIO_OPTIONS
}

function getAvailableVideoModes(model, tab) {
  // Std/Pro is a structured parameter only on the BuzzAssist route.
  if (String(model || '').startsWith('lovart-')) return []
  switch (resolveGatingVideoModel(model)) {
    case 'kling-v3':
    case 'kling-o3':
      return ['standard', 'pro']
    case 'kling-v2-6':
      return tab === 'motion' ? ['standard', 'pro'] : ['pro']
    default:
      return []
  }
}

function getVideoDurationRange(model) {
  model = resolveGatingVideoModel(model)
  if (isSeedanceModel(model)) return { min: 4, max: 15, step: 1 }
  if (isGrokVideoModel(model)) return { min: 1, max: 15, step: 1 }
  if (model === 'kling-v2-6') return { min: 5, max: 10, step: 5 }
  return { min: 3, max: 15, step: 1 }
}

function getAvailableVideoTabs(model) {
  model = resolveGatingVideoModel(model)
  return ['keyframe', model === 'kling-v2-6' || model === 'kling-v3' ? 'motion' : 'reference']
}

function isVideoTabDisabledForModel(model, tab) {
  model = resolveGatingVideoModel(model)
  return model === 'kling-v3' && tab === 'motion'
}

function normalizeVideoTabForModel(model, value) {
  const tabs = getAvailableVideoTabs(model)
  return tabs.includes(value) && !isVideoTabDisabledForModel(model, value) ? value : 'keyframe'
}

function normalizeVideoDurationForModel(model, value) {
  const choices = getVideoDurationChoices(model)
  if (choices) {
    const raw = String(value ?? '')
    if (choices.includes(raw)) return raw
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed)) return choices[0]
    let best = choices[0]
    for (const choice of choices) {
      if (Math.abs(Number(choice) - parsed) < Math.abs(Number(best) - parsed)) best = choice
    }
    return best
  }
  const { min, max } = getVideoDurationRange(model)
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return '5'
  return String(Math.min(max, Math.max(min, parsed)))
}

function normalizeVideoModeForContext(model, tab, value) {
  const allowed = getAvailableVideoModes(model, tab)
  if (allowed.length === 0) return 'standard'
  return allowed.includes(value) ? value : allowed[0]
}

function normalizeVideoAspectRatioForModel(model, value) {
  const allowed = getVideoAspectRatioOptions(model)
  return allowed.includes(value) ? value : '16:9'
}

function supportsAudioReference(model) {
  return model === 'seedance-2' || model === 'seedance-2-fast'
}

function getVideoFrameSlotMediaKind(tab, target) {
  if (tab === 'motion') return target === 'start' ? 'image' : 'video'
  if (tab === 'reference') return target === 'start' ? 'video' : 'image'
  return 'image'
}

function canUseVideoFrameTarget(model, tab, target) {
  if (!isGrokVideoModel(model)) return true
  if (tab === 'keyframe' && target === 'end') return false
  if (tab === 'reference' && target === 'start') return false
  return true
}

function getVideoFrameSlotLabel(tab, target) {
  if (tab === 'motion') return target === 'start' ? '画像' : '動画'
  if (tab === 'reference') return target === 'start' ? '動画' : '画像'
  return target === 'start' ? '開始\nフレーム' : '終了\nフレーム'
}

function getVideoFrameUploadLabel(tab, target) {
  if (target === 'audio') return '音声をアップロード'
  return getVideoFrameSlotMediaKind(tab, target) === 'video' ? '動画をアップロード' : '画像をアップロード'
}

function getUploadTargetKind(target) {
  if (target === 'videoReferenceVideos' || target === 'silenceCutVideo') return 'video'
  if (target === 'videoReferenceAudios' || target === 'subtitleAudio') return 'audio'
  return 'image'
}

function fileExtensionFromName(name) {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)
  return match?.[1] || ''
}

function getFileAssetKind(file) {
  const mimeType = String(file?.type || '').toLowerCase()
  const ext = fileExtensionFromName(file?.name)
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (ext === 'xml' || mimeType === 'application/xml' || mimeType === 'text/xml') return 'xml'
  if (ext === 'srt' || mimeType === 'application/x-subrip') return 'srt'
  if (TEXT_ATTACHMENT_EXTENSIONS.has(ext) || mimeType === 'text/plain' || mimeType === 'text/markdown') return 'script'
  return ''
}

function isAttachableCanvasFile(file) {
  return Boolean(getFileAssetKind(file))
}

function getUploadTargetAccept(target) {
  // Subtitle sources accept video too: ffmpeg extracts the audio track
  // server-side before transcription (desktop-app behavior).
  if (target === 'subtitleAudio') return 'audio/*,video/*'
  // Silence cut takes a Premiere XML (preferred) or a video file.
  if (target === 'silenceCutVideo') return '.xml,application/xml,text/xml,video/*'
  const kind = getUploadTargetKind(target)
  if (kind === 'video') return 'video/*'
  if (kind === 'audio') return 'audio/*'
  return 'image/*'
}

function downloadUrlWithAttachment(url) {
  if (!url) return ''
  return `${url}${url.includes('?') ? '&' : '?'}download=1`
}

function triggerDownloadUrl(url, fileName = '') {
  if (!url || typeof document === 'undefined') return
  const anchor = document.createElement('a')
  anchor.href = url
  if (fileName) anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

function triggerAssetDownload(assetUrl, fileName = '') {
  triggerDownloadUrl(downloadUrlWithAttachment(assetUrl), fileName)
}

function filePickerTypesForName(fileName) {
  const rawName = String(fileName || '')
  const dot = rawName.lastIndexOf('.')
  const ext = dot >= 0 ? rawName.slice(dot).toLowerCase() : ''
  // No recognizable extension → don't constrain the picker (returning a
  // ".bin"/octet-stream type made every such download save as .bin).
  if (!ext) return []
  const mime =
    ext === '.zip' ? 'application/zip' :
      ext === '.srt' ? 'application/x-subrip' :
        ext === '.xml' ? 'application/xml' :
          ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext) ? `image/${ext === '.jpg' ? 'jpeg' : ext.slice(1)}` :
            ['.mp4', '.m4v'].includes(ext) ? 'video/mp4' :
              ext === '.mov' ? 'video/quicktime' :
                ext === '.webm' ? 'video/webm' :
                  'application/octet-stream'
  return [{ description: 'Download', accept: { [mime]: [ext] } }]
}

async function saveUrlWithPicker(url, fileName = 'download', fallbackUrl = url) {
  if (!url || typeof window === 'undefined') return false
  const suggestedName = fileName || assetFileNameFromUrl(url) || 'download'
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: filePickerTypesForName(suggestedName)
      })
      const response = await canvasFetch(url)
      if (!response.ok) throw new Error(`Download failed: ${response.status}`)
      const writable = await handle.createWritable()
      if (response.body?.pipeTo) {
        await response.body.pipeTo(writable)
      } else {
        await writable.write(await response.blob())
        await writable.close()
      }
      return true
    } catch (error) {
      if (error?.name === 'AbortError') return false
      console.warn(error)
    }
  }
  triggerDownloadUrl(fallbackUrl, suggestedName)
  return false
}

function saveAssetWithPicker(assetUrl, fileName = '') {
  const suggestedName = fileName || assetFileNameFromUrl(assetUrl) || 'download'
  return saveUrlWithPicker(assetUrl, suggestedName, downloadUrlWithAttachment(assetUrl))
}

function assetFileNameFromUrl(assetUrl) {
  if (!assetUrl) return ''
  try {
    const url = new URL(assetUrl, window.location.origin)
    if (!url.pathname.startsWith(CANVAS_ASSETS_ROUTE)) return ''
    return decodeURIComponent(url.pathname.slice(CANVAS_ASSETS_ROUTE.length))
  } catch {
    const clean = String(assetUrl).split('?')[0]
    if (!clean.startsWith(CANVAS_ASSETS_ROUTE)) return ''
    return decodeURIComponent(clean.slice(CANVAS_ASSETS_ROUTE.length))
  }
}

function canvasLeafFileName(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return ''
  const withoutQuery = trimmed.split('?')[0].split('#')[0]
  const normalized = withoutQuery.replace(/\\/g, '/')
  const leaf = normalized.split('/').filter(Boolean).pop() || ''
  if (!leaf) return ''
  try {
    return decodeURIComponent(leaf)
  } catch {
    return leaf
  }
}

function canvasLeafFileNameFromAssetUrl(value) {
  return canvasLeafFileName(assetFileNameFromUrl(value))
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

function SrtGeneratorToolIcon() {
  // Tabler Icons "movie" (MIT) — 35mm film strip, same as the BuzzAssist desktop app.
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 4v16" />
      <path d="M16 4v16" />
      <path d="M4 8h4" />
      <path d="M4 16h4" />
      <path d="M4 12h16" />
      <path d="M16 8h4" />
      <path d="M16 16h4" />
    </svg>
  )
}

function SilenceCutGeneratorToolIcon() {
  // Tabler Icons "activity" (waveform) + "scissors" (MIT), same as the BuzzAssist desktop app.
  return (
    <span
      aria-hidden="true"
      style={{
        position: 'relative',
        width: 22,
        height: 22,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: 0, top: 1 }}>
        <path d="M3 12h4l3 8l4 -16l3 8h4" />
      </svg>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', right: -1, bottom: -1 }}>
        <path d="M3 7a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />
        <path d="M3 17a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />
        <path d="M8.6 8.6l10.4 10.4" />
        <path d="M8.6 15.4l10.4 -10.4" />
      </svg>
    </span>
  )
}

function LovartGeneratorToolIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22C6.47717 22 2 17.5228 2 12C2 6.47716 6.47716 2.00001 12 2ZM10.0685 16.9556H13.8904V15.615H11.5607V10.804H10.0685V16.9556ZM16.2078 8.25793C14.6578 8.25793 13.4015 9.51735 13.4015 11.0689C13.4015 12.6205 14.6578 13.8799 16.2078 13.8799C17.7577 13.8799 19.0155 12.622 19.0155 11.0689C19.0155 9.51579 17.7593 8.25794 16.2078 8.25793ZM15.2077 10.0673C15.7608 9.51263 16.6578 9.51263 17.2109 10.0673C17.764 10.622 17.764 11.5173 17.2109 12.072C16.6578 12.6267 15.7624 12.6267 15.2077 12.072C14.6546 11.5189 14.6546 10.6204 15.2077 10.0673ZM5.29681 12.2361H8.65466V10.6688H5.29681V12.2361Z"
        fill="currentColor"
      />
    </svg>
  )
}

// Robust file picker for embedded browsers (the in-app preview): a hidden
// <input> inside a <label> opens the native dialog when the label is clicked,
// with NO programmatic input.click() — which some webviews block, making
// "アップロード" appear to do nothing. onOpen runs on pointer-down (before the
// dialog) to remember the target frame; onChange gets the file input event.
function FileUploadLabel({ accept, multiple = false, className = '', title, onOpen, onChange, children }) {
  return (
    <label
      className={className}
      title={title}
      // border-box: <label> defaults to content-box (buttons are border-box),
      // so width:100% + padding would overflow the menu without this.
      style={{ position: 'relative', boxSizing: 'border-box', overflow: 'hidden' }}
      onPointerDown={(event) => { event.stopPropagation(); onOpen?.() }}
    >
      {/* The input overlays the label, so a tap IS a native file-input click —
          no programmatic .click() that embedded webviews may block. */}
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', margin: 0, padding: 0, opacity: 0, cursor: 'pointer' }}
        onClick={(event) => { event.stopPropagation(); onOpen?.() }}
        onChange={onChange}
      />
      {children}
    </label>
  )
}

function ModelProviderIcon({ provider, size = 16 }) {
  // Real brand icon embedded at build time (src/providerIcons.js) → it paints
  // instantly on the first frame, no network, no glyph placeholder. Only
  // providers without an embedded icon fall back to the inline glyph.
  const dataUri = providerIconDataUri(provider)
  if (!dataUri) {
    return <ModelProviderGlyph provider={provider} size={size} />
  }
  return (
    <img
      src={dataUri}
      width={size}
      height={size}
      alt=""
      draggable={false}
      style={{ borderRadius: 4, display: 'block' }}
    />
  )
}

function ModelProviderGlyph({ provider, size = 16 }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
  switch (provider) {
    case 'midjourney':
      return (
        <svg {...common}>
          <path d="M3 18c5-1 13-1 18 0" />
          <path d="M5 15c4-8 9-9 13-9-2 3-3 6-3 9" />
          <path d="M10 6v9" />
        </svg>
      )
    case 'nano-banana':
      return (
        <svg {...common}>
          <path d="M4 14c2 4 8 6 13 3 3-2 4-5 4-8-1 5-6 8-10 7-3-1-5-3-5-6z" fill="currentColor" stroke="none" />
          <path d="M20 6l1-2" />
        </svg>
      )
    case 'openai':
      return (
        <svg {...common} strokeWidth={1.5}>
          <path d="M12 3l6.5 3.75v7.5L12 18l-6.5-3.75v-7.5z" />
          <path d="M12 8.2l3.3 1.9v3.8L12 15.8l-3.3-1.9v-3.8z" />
        </svg>
      )
    case 'luma':
      return (
        <svg {...common}>
          <path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'flux':
      return (
        <svg {...common}>
          <path d="M12 4l8 14H4z" />
          <path d="M8.5 13.5h7" />
        </svg>
      )
    case 'seedream':
    case 'seedance':
      return (
        <svg {...common}>
          <path d="M12 4c4 3 5 7 3 11-1.6 3-6 4-9 2 4 0 6-2 6.5-5C13 9 12.5 6.5 12 4z" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'kling':
      return (
        <svg {...common}>
          <path d="M5 5v14" />
          <path d="M18 5l-9 7 9 7" />
        </svg>
      )
    case 'ideogram':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'veo':
    case 'gemini':
      return (
        <svg {...common}>
          <path d="M12 3c1 5 4 8 9 9-5 1-8 4-9 9-1-5-4-8-9-9 5-1 8-4 9-9z" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'hailuo':
      return (
        <svg {...common}>
          <path d="M4 12a8 8 0 0116 0" />
          <path d="M4 12c2.5 2 5.5 2 8 0s5.5-2 8 0" />
        </svg>
      )
    case 'wan':
      return (
        <svg {...common}>
          <path d="M3 8l3.5 8L12 8l5.5 8L21 8" />
        </svg>
      )
    case 'vidu':
      return (
        <svg {...common}>
          <path d="M4 6l8 12L20 6" />
          <path d="M8.5 6L12 11.5 15.5 6" />
        </svg>
      )
    case 'grok':
      return (
        <svg {...common}>
          <path d="M5 5l14 14" />
          <path d="M19 5L5 19" />
        </svg>
      )
    case 'codex':
      return (
        <svg {...common}>
          <path d="M9 6L4 12l5 6" />
          <path d="M15 6l5 6-5 6" />
        </svg>
      )
    case 'lovart':
      return <LovartGeneratorToolIcon />
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="7" />
        </svg>
      )
  }
}

function DownloadIcon({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v11" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 20h14" />
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

function SrtCenterIcon({ size = 52 }) {
  // SRT file icon (document with folded corner + SRT label band), same as the
  // BuzzAssist desktop app.
  const height = Math.max(6, Math.round(size * (60 / 84)))
  const strokeMain = Math.max(1.2, Math.round(size * 0.072 * 10) / 10)
  const textSize = Math.max(8, Math.round(size * 0.2))
  return (
    <svg width={size} height={height} viewBox="0 0 84 60" fill="none" aria-hidden="true">
      <path d="M19 4h32l14 14v38H19z" stroke="currentColor" strokeWidth={strokeMain} strokeLinejoin="round" />
      <path d="M51 4v14h14" stroke="currentColor" strokeWidth={strokeMain} strokeLinejoin="round" />
      <path d="M8 25h68v22H8z" fill="currentColor" opacity="0.18" />
      <text x="42" y="40.5" textAnchor="middle" fontSize={textSize} fontWeight="700" fill="currentColor" fontFamily="Arial, Helvetica, sans-serif">SRT</text>
    </svg>
  )
}

function SilenceCutCenterIcon({ size = 52 }) {
  // Audio waveform with an empty center gap — the silent stretch removed —
  // same as the BuzzAssist desktop app.
  const height = Math.max(6, Math.round(size * (60 / 84)))
  const strokeMain = Math.max(1.2, Math.round(size * 0.072 * 10) / 10)
  return (
    <svg width={size} height={height} viewBox="0 0 84 60" fill="none" aria-hidden="true">
      <path d="M8 26v8" stroke="currentColor" strokeWidth={strokeMain} strokeLinecap="round" />
      <path d="M16 20v20" stroke="currentColor" strokeWidth={strokeMain} strokeLinecap="round" />
      <path d="M24 10v40" stroke="currentColor" strokeWidth={strokeMain} strokeLinecap="round" />
      <path d="M32 22v16" stroke="currentColor" strokeWidth={strokeMain} strokeLinecap="round" />
      <path d="M52 22v16" stroke="currentColor" strokeWidth={strokeMain} strokeLinecap="round" />
      <path d="M60 10v40" stroke="currentColor" strokeWidth={strokeMain} strokeLinecap="round" />
      <path d="M68 20v20" stroke="currentColor" strokeWidth={strokeMain} strokeLinecap="round" />
      <path d="M76 26v8" stroke="currentColor" strokeWidth={strokeMain} strokeLinecap="round" />
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

// Tabler Icons "file-text" (MIT) — same universal manuscript icon the desktop
// app uses for any attached 台本 file (.md and .txt alike).
function ScriptFileIcon({ size = 24, color = '#333' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" />
      <path d="M9 9h1" />
      <path d="M9 13h6" />
      <path d="M9 17h6" />
    </svg>
  )
}

function sliderTrackStyle(value, min, max) {
  const ratio = Math.max(0, Math.min(1, (Number(value) - min) / (max - min || 1)))
  const percent = ratio * 100
  return {
    background: `linear-gradient(to right, #7c3aed 0%, #7c3aed ${percent}%, #e0e0e0 ${percent}%, #e0e0e0 100%)`
  }
}

function formatSecondsValue(value) {
  return `${Math.round(Number(value) * 100) / 100}s`
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

  const files = normalizeExcalidrawFiles(scene.files)
  return {
    type: scene.type ?? 'excalidraw',
    version: scene.version ?? 2,
    source: scene.source ?? 'codex-excalidraw-canvas',
    elements: restoreAssetBackedImageStatuses(scene.elements, files).map(sanitizeElementForScene),
    appState: scene.appState && typeof scene.appState === 'object' ? scene.appState : {},
    files
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
  return (
    (typeof file?.dataURL === 'string' && file.dataURL.startsWith(CANVAS_ASSETS_ROUTE)) ||
    (file?.codexAssetBacked === true &&
      typeof file?.codexAssetUrl === 'string' &&
      file.codexAssetUrl.startsWith(CANVAS_ASSETS_ROUTE))
  )
}

function runtimeCanvasAssetUrl(value) {
  if (typeof value !== 'string') return value
  if (value.startsWith(CANVAS_ASSETS_ROUTE)) return canvasRequestInfo(value).url
  try {
    const url = new URL(value, window.location.href)
    if (url.pathname.startsWith(CANVAS_ASSETS_ROUTE)) return canvasRequestInfo(value).url
  } catch {
    // Leave non-URL values unchanged.
  }
  return value
}

function persistedCanvasAssetUrl(value) {
  if (typeof value !== 'string') return value
  try {
    const url = new URL(value, window.location.href)
    if (!url.pathname.startsWith(CANVAS_ASSETS_ROUTE)) return value
    url.searchParams.delete('t')
    url.searchParams.delete('token')
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return value
  }
}

function withRuntimeAssetBackedFiles(files) {
  if (!files || typeof files !== 'object') return files
  let changed = false
  const next = {}
  for (const [id, file] of Object.entries(files)) {
    if (!isAssetBackedFileRecord(file)) {
      next[id] = file
      continue
    }
    const runtimeUrl = runtimeCanvasAssetUrl(file.dataURL || file.codexAssetUrl)
    if (runtimeUrl && runtimeUrl !== file.dataURL) {
      next[id] = { ...file, dataURL: runtimeUrl }
      changed = true
    } else {
      next[id] = file
    }
  }
  return changed ? next : files
}

function withRuntimeAssetBackedScene(scene) {
  return { ...scene, files: withRuntimeAssetBackedFiles(scene.files) }
}

function assetBackedFileIds(files) {
  return new Set(
    Object.entries(files ?? {})
      .filter(([, file]) => isAssetBackedFileRecord(file))
      .map(([id]) => id)
  )
}

function restoreAssetBackedImageStatuses(elements, files) {
  const fileIds = files instanceof Set ? files : assetBackedFileIds(files)
  if (!Array.isArray(elements) || fileIds.size === 0) return elements
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

const assetDataURLCache = new Map()

function readBlobAsDataURL(blob, url) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error(`Failed to read asset ${url}`))
    reader.onload = () => resolve(String(reader.result || ''))
    reader.readAsDataURL(blob)
  })
}

function fetchAssetDataURL(url) {
  const assetUrl = canvasRequestInfo(url).url
  let pending = assetDataURLCache.get(assetUrl)
  if (pending) return pending
  pending = (async () => {
    const response = await canvasFetch(assetUrl)
    if (!response.ok) throw new Error(`Failed to load asset ${assetUrl}: ${response.status}`)
    const blob = await response.blob()
    return readBlobAsDataURL(blob, assetUrl)
  })()
  pending.catch(() => {
    if (assetDataURLCache.get(assetUrl) === pending) assetDataURLCache.delete(assetUrl)
  })
  assetDataURLCache.set(assetUrl, pending)
  return pending
}

// Fetch asset-backed file records (concurrency-limited) and hand each hydrated
// record to `onHydrated` as it resolves, so the scene renders immediately and
// images pop in as their assets load.
async function hydrateAssetBackedFiles(files, onHydrated, options = {}) {
  const onlyFileIds = options.onlyFileIds instanceof Set ? options.onlyFileIds : null
  const pending = Object.values(files ?? {}).filter((file) => {
    if (!isAssetBackedFileRecord(file)) return false
    return !onlyFileIds || onlyFileIds.has(file.id)
  })
  if (pending.length === 0) return
  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || ASSET_HYDRATION_CONCURRENCY, ASSET_HYDRATION_CONCURRENCY))
  let cursor = 0
  const worker = async () => {
    while (cursor < pending.length) {
      const file = pending[cursor]
      cursor += 1
      const url =
        typeof file.codexAssetUrl === 'string' && file.codexAssetUrl.startsWith(CANVAS_ASSETS_ROUTE)
          ? file.codexAssetUrl
          : file.dataURL
      // Over the tunnel, multi-MB originals overwhelm phone bandwidth/memory —
      // request a downscaled preview; the server falls back to the original
      // for small files and non-bitmap types. Local sessions keep full-res.
      const fetchUrl = isTunnelCanvasRuntime() && /\.(png|jpe?g|webp)$/i.test(url.split('?')[0])
        ? `${url}${url.includes('?') ? '&' : '?'}w=1600`
        : url
      try {
        const dataURL = await fetchAssetDataURL(fetchUrl)
        onHydrated({ ...file, dataURL, codexAssetBacked: true, codexAssetUrl: persistedCanvasAssetUrl(url) })
      } catch (error) {
        console.error(error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker))
}

function visibleAssetBackedImageFileIds(scene, padding = 900) {
  const files = scene?.files ?? {}
  const appState = scene?.appState ?? {}
  const { width, height } = viewportSize(appState)
  const visible = new Set()
  for (const element of scene?.elements ?? []) {
    if (
      element?.type !== 'image' ||
      element.isDeleted ||
      element.customData?.codexMediaKind === 'video' ||
      !isAssetBackedFileRecord(files[element.fileId])
    ) {
      continue
    }
    const placement = getFrameViewportPlacement(element, appState)
    if (
      placement.left <= width + padding &&
      placement.left + placement.width >= -padding &&
      placement.top <= height + padding &&
      placement.top + placement.height >= -padding
    ) {
      visible.add(element.fileId)
    }
  }
  return visible
}

async function hydrateSceneAssetBackedFiles(scene, options = {}) {
  const files = { ...(scene.files ?? {}) }
  const onlyFileIds = options.onlyVisible === true ? visibleAssetBackedImageFileIds(scene) : options.onlyFileIds
  await hydrateAssetBackedFiles(files, (file) => {
    files[file.id] = file
  }, { onlyFileIds })
  return { ...scene, files }
}

// Inverse of hydration for the save path: swap hydrated base64 back to the
// asset URL so PUT /api/canvas payloads stay small over the wire. Only records
// verifiably asset-backed are stripped (marked codexAssetBacked during
// hydration, or their element customData points at a canvas asset). Video
// posters and non-image attachment preview cards keep their inline base64.
function stripAssetBackedFilesForSave(elements, files) {
  if (!files || typeof files !== 'object') return files
  const videoFileIds = new Set()
  const previewFileIds = new Set()
  const assetUrlByFileId = new Map()
  for (const element of elements ?? []) {
    if (!element?.fileId) continue
    const customData = element.customData ?? {}
    if (customData.codexMediaKind === 'video') {
      videoFileIds.add(element.fileId)
      continue
    }
    if (customData.codexMediaKind && customData.codexMediaKind !== 'image') {
      previewFileIds.add(element.fileId)
      continue
    }
    if (
      typeof customData.codexAssetPath === 'string' && customData.codexAssetPath &&
      typeof customData.codexAssetUrl === 'string' && customData.codexAssetUrl.startsWith(CANVAS_ASSETS_ROUTE) &&
      !assetUrlByFileId.has(element.fileId)
    ) {
      assetUrlByFileId.set(element.fileId, persistedCanvasAssetUrl(customData.codexAssetUrl))
    }
  }
  let changed = false
  const next = {}
  for (const [id, file] of Object.entries(files)) {
    const inline = typeof file?.dataURL === 'string' && file.dataURL.startsWith('data:')
    const markedUrl =
      file?.codexAssetBacked === true &&
      typeof file.codexAssetUrl === 'string' &&
      file.codexAssetUrl.startsWith(CANVAS_ASSETS_ROUTE)
        ? persistedCanvasAssetUrl(file.codexAssetUrl)
        : null
    const dataAssetUrl =
      typeof file?.dataURL === 'string' && file.dataURL.startsWith(CANVAS_ASSETS_ROUTE)
        ? persistedCanvasAssetUrl(file.dataURL)
        : null
    if ((!inline && !markedUrl && !dataAssetUrl) || videoFileIds.has(id) || previewFileIds.has(id)) {
      next[id] = file
      continue
    }
    const assetUrl = markedUrl || assetUrlByFileId.get(id) || dataAssetUrl || null
    if (!assetUrl) {
      next[id] = file
      continue
    }
    next[id] = { ...file, dataURL: assetUrl, codexAssetUrl: assetUrl, codexAssetBacked: true }
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
  const normalizedFiles = normalizeExcalidrawFiles(files)
  return {
    type: 'excalidraw',
    version: 2,
    source: 'codex-excalidraw-canvas',
    elements: restoreAssetBackedImageStatuses(elements, normalizedFiles).map(sanitizeElementForScene),
    appState: serializableAppState(appState),
    files: normalizedFiles
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
  const files = Object.entries(scene.files ?? {})
    .map(([id, file]) => `${id}:${(file?.dataURL ?? '').length}`)
    .sort()
    .join(',')
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

function isCollapsedFreeDrawElement(element) {
  if (element?.type !== 'freedraw' || element.isDeleted) return false
  const width = Math.abs(Number(element.width) || 0)
  const height = Math.abs(Number(element.height) || 0)
  return Math.max(width, height) < COLLAPSED_FREEDRAW_MAX_DIMENSION
}

function sanitizeElementForScene(element) {
  if (!element || typeof element !== 'object') return element
  let next = element
  if (isCollapsedFreeDrawElement(next)) {
    next = { ...next, isDeleted: true }
  }
  if (!next.customData || !isGeneratorFrame(next)) return next
  const sanitized = sanitizeGeneratorCustomData(next.customData)
  return sanitized === next.customData ? next : { ...next, customData: sanitized }
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
  setValue('subtitleAudioAsset', sanitizeAsset(next.subtitleAudioAsset))
  setValue('silenceCutVideoAsset', sanitizeAsset(next.silenceCutVideoAsset))
  setValue('silenceCutOutputAsset', sanitizeAsset(next.silenceCutOutputAsset))
  return changed ? next : customData
}

function finiteNumberOr(value, fallback) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
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

function shouldBuildViewportOverlay(placement, appState, selectedIds, id, margin = OVERLAY_RENDER_MARGIN) {
  return selectedIds.has(id) || isViewportPlacementNearViewport(placement, appState, margin)
}

function overlayDistanceFromViewportCenter(overlay, appState) {
  const { width, height } = viewportSize(appState)
  const dx = (Number(overlay.left) || 0) + (Number(overlay.width) || 0) / 2 - width / 2
  const dy = (Number(overlay.top) || 0) + (Number(overlay.height) || 0) / 2 - height / 2
  return dx * dx + dy * dy
}

function limitViewportOverlays(overlays, appState, maxItems) {
  if (!Number.isFinite(maxItems) || overlays.length <= maxItems) return overlays
  const selected = []
  const rest = []
  for (const overlay of overlays) {
    if (overlay?.isSelected) selected.push(overlay)
    else rest.push(overlay)
  }
  if (selected.length >= maxItems) return selected
  rest.sort((a, b) => overlayDistanceFromViewportCenter(a, appState) - overlayDistanceFromViewportCenter(b, appState))
  return selected.concat(rest.slice(0, maxItems - selected.length))
}

function getPanelPlacementFromViewportTarget(target, kind = 'image') {
  const isVideo = kind === true || kind === 'video'
  const frameViewportWidth = Math.max(1, Number(target?.width) || 1)
  const frameViewportHeight = Math.max(1, Number(target?.height) || 1)
  const desiredWidth = isVideo
    ? GENERATOR_PANEL_VIDEO_WIDTH
    : kind === 'subtitle' || kind === 'silenceCut'
      // The portrait SRT frame fits at a small zoom, so 0.9x its viewport
      // width would collapse the bar pills; keep the desktop's max width.
      ? 560
      : clamp(Math.round(frameViewportWidth * 0.9), GENERATOR_PANEL_IMAGE_MIN_WIDTH, GENERATOR_PANEL_IMAGE_MAX_WIDTH)
  // Phones only: the frame is wider than the screen, so cap the panel width and
  // keep it fully on-screen instead of anchoring to the (off-screen) frame
  // center. Desktop keeps the panel glued to its frame even past the edge.
  const viewportWidth = typeof window !== 'undefined' ? (window.innerWidth || 0) : 0
  const margin = 8
  const clampToViewport = viewportWidth > 0 && viewportWidth <= 900
  const panelWidth = clampToViewport ? Math.min(desiredWidth, viewportWidth - margin * 2) : desiredWidth
  let rawLeft = Math.round((Number(target?.left) || 0) + frameViewportWidth / 2 - panelWidth / 2)
  if (clampToViewport) {
    rawLeft = clamp(rawLeft, margin, Math.max(margin, viewportWidth - panelWidth - margin))
  }
  const targetTop = Number(target?.top) || 0
  const rawTop = Math.round(targetTop + frameViewportHeight + 4)

  return {
    left: rawLeft,
    top: rawTop,
    width: panelWidth
  }
}

function getMediaHeaderMetrics(width) {
  const headerFontSize = Math.max(5, Math.min(14, Math.round((Number(width) || 0) * 0.055)))
  const headerOffset = Math.max(6, Math.min(18, headerFontSize + 3))
  return { headerFontSize, headerOffset }
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

function isSubtitleGeneratorFrame(element) {
  return element?.customData?.[SUBTITLE_GENERATOR_FRAME_TAG] === true
}

function isSilenceCutGeneratorFrame(element) {
  return element?.customData?.[SILENCE_CUT_GENERATOR_FRAME_TAG] === true
}

function isLovartGeneratorFrame(element) {
  return element?.customData?.[LOVART_GENERATOR_FRAME_TAG] === true
}

function isGeneratorFrame(element) {
  return (
    !element?.isDeleted &&
    (isImageGeneratorFrame(element) ||
      isVideoGeneratorFrame(element) ||
      isSubtitleGeneratorFrame(element) ||
      isSilenceCutGeneratorFrame(element) ||
      isLovartGeneratorFrame(element))
  )
}

function generatorFrameTagFor(kind) {
  if (kind === 'video') return VIDEO_GENERATOR_FRAME_TAG
  if (kind === 'subtitle') return SUBTITLE_GENERATOR_FRAME_TAG
  if (kind === 'silenceCut') return SILENCE_CUT_GENERATOR_FRAME_TAG
  if (kind === 'lovart') return LOVART_GENERATOR_FRAME_TAG
  return GENERATOR_FRAME_TAG
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

function isCanvasFileAttachmentElement(element) {
  const kind = element?.customData?.codexMediaKind
  return !element?.isDeleted && ['audio', 'xml', 'srt', 'script'].includes(kind)
}

function canvasAssetKindFromElement(element) {
  const customKind = element?.customData?.codexMediaKind
  if (['image', 'video', 'audio', 'xml', 'srt', 'script'].includes(customKind)) return customKind
  if (isGeneratedSubtitleResult(element)) return 'srt'
  if (isGeneratedVideoResult(element)) return 'video'
  if (isCanvasImageElement(element)) return 'image'
  return ''
}

function isCanvasAttachableElement(element) {
  return Boolean(
    !element?.isDeleted &&
      (isCanvasImageElement(element) || isCanvasVideoElement(element) || isCanvasFileAttachmentElement(element) || isGeneratedSubtitleResult(element))
  )
}

function isPanelMediaTargetElement(element) {
  return Boolean(!element?.isDeleted && isGeneratedResult(element))
}

function panelMediaKindFromElement(element) {
  return canvasAssetKindFromElement(element) === 'video' ? 'video' : getGeneratedResultKind(element)
}

function getGeneratorKind(element) {
  if (isVideoGeneratorFrame(element)) return 'video'
  if (isSubtitleGeneratorFrame(element)) return 'subtitle'
  if (isSilenceCutGeneratorFrame(element)) return 'silenceCut'
  if (isLovartGeneratorFrame(element)) return 'lovart'
  return 'image'
}

function isGeneratedSubtitleResult(element) {
  return !element?.isDeleted && element?.customData?.codexGeneratedSubtitle === true
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

function isCanvasAssetUrl(value) {
  if (typeof value !== 'string' || !value) return false
  try {
    const origin = typeof window === 'undefined' ? 'http://127.0.0.1' : window.location.origin
    const url = new URL(value, origin)
    return url.pathname.startsWith(CANVAS_ASSETS_ROUTE)
  } catch {
    return value.startsWith(CANVAS_ASSETS_ROUTE)
  }
}

function normalizeCanvasAssetUrl(value) {
  if (!isCanvasAssetUrl(value)) return ''
  try {
    const origin = typeof window === 'undefined' ? 'http://127.0.0.1' : window.location.origin
    const url = new URL(value, origin)
    return `${url.pathname}${url.search || ''}`
  } catch {
    return String(value)
  }
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
      const rawThumbnail = typeof item.thumbnail === 'string' ? item.thumbnail : ''
      const thumbnail = rawThumbnail.startsWith('data:image/')
        ? displayURL || rawThumbnail
        : rawThumbnail && !rawThumbnail.startsWith('data:')
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

function escapeSvgText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function truncateMiddle(value, maxLength = 34) {
  const text = String(value || '')
  if (text.length <= maxLength) return text
  const keep = Math.max(6, Math.floor((maxLength - 1) / 2))
  return `${text.slice(0, keep)}…${text.slice(-keep)}`
}

function svgToDataURL(svg) {
  const encoded = typeof window !== 'undefined' && typeof window.btoa === 'function'
    ? window.btoa(unescape(encodeURIComponent(svg)))
    : ''
  return encoded ? `data:image/svg+xml;base64,${encoded}` : `data:image/svg+xml,${encodeURIComponent(svg)}`
}

function attachmentKindTitle(kind) {
  if (kind === 'audio') return '音声'
  if (kind === 'xml') return 'Premiere XML'
  if (kind === 'srt') return 'SRT字幕'
  if (kind === 'script') return '台本'
  return 'ファイル'
}

function createAudioAttachmentPreviewDataURL(asset) {
  const title = escapeSvgText(attachmentKindTitle('audio'))
  const name = escapeSvgText(truncateMiddle(asset?.name || 'audio', 38))
  const detail = Number(asset?.duration) > 0
    ? formatAssetDuration(asset.duration)
    : String(asset?.mimeType || '').split(';')[0] || 'audio'
  const subline = escapeSvgText(detail)
  const color = '#2563eb'
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${ATTACHMENT_CARD_WIDTH}" height="${ATTACHMENT_CARD_HEIGHT}" viewBox="0 0 ${ATTACHMENT_CARD_WIDTH} ${ATTACHMENT_CARD_HEIGHT}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <rect x="22" y="24" width="74" height="74" rx="18" fill="${color}" opacity="0.12"/>
  <text x="59" y="69" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="14" font-weight="800" fill="${color}">AUDIO</text>
  <text x="116" y="52" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="700" fill="#1f2937">${title}</text>
  <text x="116" y="82" font-family="Inter, Arial, sans-serif" font-size="13" fill="#6b7280">${name}</text>
  <text x="116" y="112" font-family="Inter, Arial, sans-serif" font-size="13" fill="#8a94a6">${subline}</text>
  <path d="M24 ${ATTACHMENT_CARD_HEIGHT - 32}H${ATTACHMENT_CARD_WIDTH - 24}" stroke="#edf0f5" stroke-width="2"/>
</svg>`
  return svgToDataURL(svg)
}

function attachmentKindIconMarkup(kind, color) {
  if (kind === 'audio') {
    return `
  <g fill="${color}">
    <rect x="42" y="50" width="4" height="24" rx="2"/>
    <rect x="50" y="42" width="4" height="40" rx="2"/>
    <rect x="58" y="56" width="4" height="12" rx="2"/>
    <rect x="66" y="36" width="4" height="52" rx="2"/>
    <rect x="74" y="48" width="4" height="28" rx="2"/>
  </g>`
  }
  if (kind === 'xml') {
    return `
  <g fill="none" stroke="${color}" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M54 48l-14 13 14 13"/>
    <path d="M72 48l14 13-14 13"/>
    <path d="M66 43l-8 38"/>
  </g>`
  }
  return `
  <g fill="none" stroke="${color}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M44 32h29l13 13v43H44z"/>
    <path d="M73 32v13h13"/>
    <path d="M54 56h20"/>
    <path d="M54 67h26"/>
    <path d="M54 78h18"/>
  </g>`
}

function createAttachmentPreviewDataURL(asset) {
  const kind = asset?.kind || 'file'
  if (kind === 'audio') return createAudioAttachmentPreviewDataURL(asset)
  const title = escapeSvgText(truncateMiddle(asset?.name || attachmentKindTitle(kind), 42))
  const detail = String(asset?.mimeType || '').split(';')[0] || attachmentKindTitle(kind)
  const subline = escapeSvgText(detail)
  const color = kind === 'audio'
    ? '#2563eb'
    : kind === 'xml'
      ? '#7c3aed'
      : kind === 'srt'
        ? '#059669'
        : '#374151'
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${ATTACHMENT_CARD_WIDTH}" height="${ATTACHMENT_CARD_HEIGHT}" viewBox="0 0 ${ATTACHMENT_CARD_WIDTH} ${ATTACHMENT_CARD_HEIGHT}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <rect x="22" y="24" width="74" height="74" rx="18" fill="${color}" opacity="0.12"/>
  ${attachmentKindIconMarkup(kind, color)}
  <text x="116" y="62" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="700" fill="#1f2937">${title}</text>
  <text x="116" y="94" font-family="Inter, Arial, sans-serif" font-size="13" fill="#8a94a6">${subline}</text>
  <path d="M24 ${ATTACHMENT_CARD_HEIGHT - 32}H${ATTACHMENT_CARD_WIDTH - 24}" stroke="#edf0f5" stroke-width="2"/>
</svg>`
  return svgToDataURL(svg)
}

function waitForMediaEvent(element, eventName, timeoutMs = 700) {
  return new Promise((resolve) => {
    let settled = false
    const cleanup = () => {
      element.removeEventListener(eventName, onDone)
      element.removeEventListener('error', onDone)
      window.clearTimeout(timer)
    }
    const onDone = (event) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(event?.type === eventName)
    }
    const timer = window.setTimeout(onDone, timeoutMs)
    element.addEventListener(eventName, onDone, { once: true })
    element.addEventListener('error', onDone, { once: true })
  })
}

function videoPosterCandidateTimes(duration) {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0
  if (!safeDuration) return [0]
  const maxTime = Math.max(0, safeDuration - 0.05)
  const raw = [
    0.12,
    0.5,
    1.2,
    safeDuration * 0.18,
    safeDuration * 0.38,
    safeDuration * 0.62
  ]
  const seen = new Set()
  return raw
    .map((time) => Math.max(0, Math.min(maxTime, Number(time) || 0)))
    .map((time) => Math.round(time * 100) / 100)
    .filter((time) => {
      const key = time.toFixed(2)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function videoFrameScore(video) {
  const sourceWidth = Math.max(1, video.videoWidth || 1)
  const sourceHeight = Math.max(1, video.videoHeight || 1)
  const width = Math.max(1, Math.min(VIDEO_POSTER_SCORE_SAMPLE_SIZE, sourceWidth))
  const height = Math.max(1, Math.round(width * (sourceHeight / sourceWidth)))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return 0
  context.drawImage(video, 0, 0, width, height)
  const { data } = context.getImageData(0, 0, width, height)
  let lumaTotal = 0
  let lumaSquaredTotal = 0
  let saturationTotal = 0
  let sampleCount = 0
  for (let index = 0; index < data.length; index += 4) {
    const red = data[index]
    const green = data[index + 1]
    const blue = data[index + 2]
    const max = Math.max(red, green, blue)
    const min = Math.min(red, green, blue)
    const luma = red * 0.2126 + green * 0.7152 + blue * 0.0722
    lumaTotal += luma
    lumaSquaredTotal += luma * luma
    saturationTotal += max - min
    sampleCount += 1
  }
  if (sampleCount === 0) return 0
  const mean = lumaTotal / sampleCount
  const variance = Math.max(0, lumaSquaredTotal / sampleCount - mean * mean)
  const contrast = Math.sqrt(variance)
  const saturation = saturationTotal / sampleCount
  return mean + contrast * 1.8 + saturation * 0.7
}

function captureVideoPosterDataURL(video) {
  const sourceWidth = Math.max(1, video.videoWidth || 1280)
  const sourceHeight = Math.max(1, video.videoHeight || 720)
  const scale = Math.min(1, VIDEO_POSTER_CAPTURE_MAX_WIDTH / sourceWidth)
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return { posterDataURL: '', width: sourceWidth, height: sourceHeight }
  context.drawImage(video, 0, 0, width, height)
  return {
    posterDataURL: canvas.toDataURL('image/jpeg', 0.82),
    width: sourceWidth,
    height: sourceHeight
  }
}

async function seekVideoForPoster(video, time) {
  if (!Number.isFinite(time) || time <= 0) return true
  try {
    if (Math.abs((Number(video.currentTime) || 0) - time) < 0.03 && video.readyState >= 2) return true
    video.currentTime = time
    return await waitForMediaEvent(video, 'seeked', 800)
  } catch {
    return false
  }
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
      window.clearTimeout(timeout)
      video.removeAttribute('src')
      video.load()
      resolve(result)
    }
    const fallback = () => finish({ objectURL, posterDataURL: '', width: 1280, height: 720, duration: 0 })
    const timeout = window.setTimeout(fallback, 4200)
    const choosePoster = async () => {
      try {
        const metadataReady = await waitForMediaEvent(video, 'loadedmetadata', 1200)
        if (!metadataReady && video.readyState < 1) {
          fallback()
          return
        }
        const duration = Number.isFinite(video.duration) ? video.duration : 0
        let bestTime = 0
        let bestScore = -1
        for (const time of videoPosterCandidateTimes(duration)) {
          const seeked = await seekVideoForPoster(video, time)
          if (!seeked && video.readyState < 2) continue
          if (video.readyState < 2) await waitForMediaEvent(video, 'loadeddata', 500)
          const score = videoFrameScore(video)
          if (score > bestScore) {
            bestScore = score
            bestTime = time
          }
          if (score >= VIDEO_POSTER_GOOD_SCORE && time >= 0.5) break
        }
        await seekVideoForPoster(video, bestTime)
        const captured = captureVideoPosterDataURL(video)
        finish({
          objectURL,
          posterDataURL: captured.posterDataURL,
          width: captured.width,
          height: captured.height,
          duration
        })
      } catch {
        fallback()
      }
    }
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.addEventListener('error', fallback, { once: true })
    video.src = objectURL
    void choosePoster()
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
  const url = normalizeCanvasAssetUrl(assetUrlFromElement(element) || file?.codexAssetUrl || file?.dataURL)
  const dataURL = file?.dataURL || ''
  if (!path && !url && !dataURL) return null
  const customData = element.customData ?? {}
  const kind = canvasAssetKindFromElement(element) || 'image'
  const pixelSize = getCanvasMediaPixelSize(element, files)
  const previewDataURL = typeof dataURL === 'string' && dataURL.startsWith('data:image/') ? dataURL : ''
  return {
    id: crypto.randomUUID(),
    name: getCanvasMediaDisplayName(element, files) || `canvas-${kind}`,
    kind,
    mimeType:
      customData.codexAssetMimeType ||
      (kind === 'video' ? customData.codexVideoMimeType : '') ||
      file?.mimeType ||
      (kind === 'audio' ? 'audio/mpeg' : kind === 'xml' ? 'application/xml' : kind === 'srt' ? 'application/x-subrip' : kind === 'script' ? 'text/plain' : 'image/png'),
    path,
    url,
    dataURL: kind === 'image' ? dataURL : '',
    thumbnail: previewDataURL || url,
    duration: kind === 'video' ? Number(customData.codexVideoDuration) || 0 : Number(customData.codexAssetDuration) || undefined,
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
      element.strokeStyle === 'solid' &&
      element.roundness == null
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
      roundness: null,
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
  // Lovart frames store their prompt under lovartPrompt only — without this
  // branch the prompt silently resets every time the frame is re-selected.
  const prompt = isLovartGeneratorFrame(element) && typeof customData.lovartPrompt === 'string'
    ? customData.lovartPrompt
    : isVideoElement
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
    videoGenerateAudio: customData.videoGenerateAudio !== undefined ? customData.videoGenerateAudio !== false : DEFAULT_FRAME_FORM.videoGenerateAudio,
    videoMode: customData.videoMode === 'standard' ? 'standard' : DEFAULT_FRAME_FORM.videoMode,
    subtitleMode: customData.subtitleMode === 'scripted' || customData.subtitleMode === 'scriptless'
      ? customData.subtitleMode
      : DEFAULT_FRAME_FORM.subtitleMode,
    subtitleLineCount: finiteNumberOr(customData.subtitleLineCount, DEFAULT_FRAME_FORM.subtitleLineCount) === 1 ? 1 : 2,
    subtitleMaxChars: clamp(Math.round(finiteNumberOr(customData.subtitleMaxChars, DEFAULT_FRAME_FORM.subtitleMaxChars)), 3, 40),
    subtitleHoldSeconds: clamp(finiteNumberOr(customData.subtitleHoldSeconds, DEFAULT_FRAME_FORM.subtitleHoldSeconds), 0, 3),
    subtitlePunctuationMode: customData.subtitlePunctuationMode === 'none' ? 'none' : DEFAULT_FRAME_FORM.subtitlePunctuationMode,
    subtitleFillerMode: ['keep', 'safe', 'contextual'].includes(customData.subtitleFillerMode)
      ? customData.subtitleFillerMode
      : DEFAULT_FRAME_FORM.subtitleFillerMode,
    subtitlePrompt: typeof customData.subtitlePrompt === 'string' ? customData.subtitlePrompt : '',
    subtitleScriptText: typeof customData.subtitleScriptText === 'string' ? customData.subtitleScriptText : '',
    subtitleScriptName: typeof customData.subtitleScriptName === 'string' ? customData.subtitleScriptName : '',
    subtitleGlossary: typeof customData.subtitleGlossary === 'string' ? customData.subtitleGlossary : '',
    subtitleAudio: customData.subtitleAudioAsset && typeof customData.subtitleAudioAsset === 'object'
      ? customData.subtitleAudioAsset
      : null,
    silenceCutModel: customData.silenceCutModel === 'ffmpeg-local' ? 'ffmpeg-local' : DEFAULT_FRAME_FORM.silenceCutModel,
    silenceCutInstruction: typeof customData.silenceCutInstruction === 'string' ? customData.silenceCutInstruction : '',
    silenceCutFillerRemoval: clamp(finiteNumberOr(customData.silenceCutFillerRemoval, DEFAULT_FRAME_FORM.silenceCutFillerRemoval), 0, 100),
    silenceCutCoughRemoval: clamp(finiteNumberOr(customData.silenceCutCoughRemoval, DEFAULT_FRAME_FORM.silenceCutCoughRemoval), 0, 100),
    silenceCutRetakeRemoval: clamp(finiteNumberOr(customData.silenceCutRetakeRemoval, DEFAULT_FRAME_FORM.silenceCutRetakeRemoval), 0, 100),
    silenceCutVideo: customData.silenceCutVideoAsset && typeof customData.silenceCutVideoAsset === 'object'
      ? customData.silenceCutVideoAsset
      : null,
    silenceCutOutput: customData.silenceCutOutputAsset && typeof customData.silenceCutOutputAsset === 'object'
      ? customData.silenceCutOutputAsset
      : null,
    silenceCutDetectSeconds: clamp(finiteNumberOr(customData.silenceCutDetectSeconds, DEFAULT_FRAME_FORM.silenceCutDetectSeconds), 0.3, 2),
    silenceCutKeepSeconds: clamp(finiteNumberOr(customData.silenceCutKeepSeconds, DEFAULT_FRAME_FORM.silenceCutKeepSeconds), 0, 1),
    silenceCutThresholdDb: clamp(finiteNumberOr(customData.silenceCutThresholdDb, DEFAULT_FRAME_FORM.silenceCutThresholdDb), -60, -20),
    silenceCutPreMarginSeconds: clamp(finiteNumberOr(customData.silenceCutPreMarginSeconds, DEFAULT_FRAME_FORM.silenceCutPreMarginSeconds), 0.05, 0.3),
    silenceCutPostMarginSeconds: clamp(finiteNumberOr(customData.silenceCutPostMarginSeconds, DEFAULT_FRAME_FORM.silenceCutPostMarginSeconds), 0.05, 0.3),
    silenceCutThresholdAuto: customData.silenceCutThresholdAuto !== false,
    lovartKind: customData.lovartKind === 'video' ? 'video' : DEFAULT_FRAME_FORM.lovartKind,
    lovartModel: typeof customData.lovartModel === 'string' && customData.lovartModel ? customData.lovartModel : DEFAULT_FRAME_FORM.lovartModel,
    lovartVideoModel: typeof customData.lovartVideoModel === 'string' && customData.lovartVideoModel ? customData.lovartVideoModel : DEFAULT_FRAME_FORM.lovartVideoModel,
    lovartAspectRatio: IMAGE_ASPECTS[customData.lovartAspectRatio] ? customData.lovartAspectRatio : DEFAULT_FRAME_FORM.lovartAspectRatio,
    lovartVideoAspectRatio: VIDEO_ASPECTS[customData.lovartVideoAspectRatio] ? customData.lovartVideoAspectRatio : DEFAULT_FRAME_FORM.lovartVideoAspectRatio,
    lovartReferences: normalizeAssetList(customData.lovartReferences)
  }
}

function frameCustomDataFromForm(kind, form) {
  if (kind === 'subtitle') {
    return {
      subtitleMode: form.subtitleMode,
      subtitlePrompt: form.subtitlePrompt,
      subtitleLineCount: form.subtitleLineCount,
      subtitleMaxChars: form.subtitleMaxChars,
      subtitleHoldSeconds: form.subtitleHoldSeconds,
      subtitlePunctuationMode: form.subtitlePunctuationMode,
      subtitleFillerMode: form.subtitleFillerMode,
      subtitleScriptText: form.subtitleScriptText,
      subtitleScriptName: form.subtitleScriptName,
      subtitleGlossary: form.subtitleGlossary,
      subtitleAudioAsset: normalizeAssetList(form.subtitleAudio ? [form.subtitleAudio] : [])[0] ?? null
    }
  }
  if (kind === 'silenceCut') {
    return {
      silenceCutModel: form.silenceCutModel,
      silenceCutInstruction: form.silenceCutInstruction,
      silenceCutFillerRemoval: form.silenceCutFillerRemoval,
      silenceCutCoughRemoval: form.silenceCutCoughRemoval,
      silenceCutRetakeRemoval: form.silenceCutRetakeRemoval,
      silenceCutDetectSeconds: form.silenceCutDetectSeconds,
      silenceCutKeepSeconds: form.silenceCutKeepSeconds,
      silenceCutThresholdDb: form.silenceCutThresholdDb,
      silenceCutThresholdAuto: form.silenceCutThresholdAuto,
      silenceCutPreMarginSeconds: form.silenceCutPreMarginSeconds,
      silenceCutPostMarginSeconds: form.silenceCutPostMarginSeconds,
      silenceCutVideoAsset: normalizeAssetList(form.silenceCutVideo ? [form.silenceCutVideo] : [])[0] ?? null,
      silenceCutOutputAsset: normalizeAssetList(form.silenceCutOutput ? [form.silenceCutOutput] : [])[0] ?? null
    }
  }
  if (kind === 'lovart') {
    return {
      lovartPrompt: form.prompt,
      lovartKind: form.lovartKind === 'video' ? 'video' : 'image',
      lovartModel: form.lovartModel,
      lovartVideoModel: form.lovartVideoModel,
      lovartAspectRatio: form.lovartAspectRatio,
      lovartVideoAspectRatio: form.lovartVideoAspectRatio,
      lovartReferences: normalizeAssetList(form.lovartReferences)
    }
  }
  return kind === 'video'
    ? {
        videoPrompt: form.prompt,
        videoModel: form.videoModel,
        videoAspectRatio: form.videoAspectRatio,
        videoDuration: form.duration,
        videoResolution: form.resolution,
        videoTab: form.videoTab,
        videoStartFrameAsset: normalizeAssetList(form.videoStartFrame ? [form.videoStartFrame] : [])[0] ?? null,
        videoEndFrameAsset: normalizeAssetList(form.videoEndFrame ? [form.videoEndFrame] : [])[0] ?? null,
        videoReferenceImages: normalizeAssetList(form.videoReferenceImages),
        videoReferenceVideos: normalizeAssetList(form.videoReferenceVideos),
        videoReferenceAudios: normalizeAssetList(form.videoReferenceAudios),
        videoGenerateAudio: form.videoGenerateAudio !== false,
        videoMode: form.videoMode === 'standard' ? 'standard' : 'pro'
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

function mergeAssetIntoForm(form, target, asset) {
  if (target === 'imageReferences') return { ...form, imageReferences: [...normalizeAssetList(form.imageReferences), asset].slice(-3) }
  if (target === 'videoStartFrame') return { ...form, videoStartFrame: asset }
  if (target === 'videoEndFrame') return { ...form, videoEndFrame: asset }
  if (target === 'videoReferenceVideos') return { ...form, videoReferenceVideos: [...normalizeAssetList(form.videoReferenceVideos), asset].slice(-3) }
  if (target === 'videoReferenceAudios') return { ...form, videoReferenceAudios: [...normalizeAssetList(form.videoReferenceAudios), asset].slice(-3) }
  if (target === 'subtitleAudio') return { ...form, subtitleAudio: asset }
  if (target === 'subtitleScript') return { ...form, subtitleScriptText: String(asset?.text || '').trim(), subtitleScriptName: asset?.name || 'script.txt' }
  if (target === 'silenceCutVideo') return { ...form, silenceCutVideo: asset }
  return { ...form, videoReferenceImages: [...normalizeAssetList(form.videoReferenceImages), asset].slice(-3) }
}

function snapshotSelectedGeneratedResult(result) {
  return result?.elementId ? { ...result } : null
}

function buildPanelTargetFromScene(scene, activeFrameId, selectedGeneratedResult) {
  if (!scene || !Array.isArray(scene.elements)) return null
  const appState = scene.appState ?? {}
  const { width: viewportWidth, height: viewportHeight } = viewportSize(appState)
  const elementsById = new Map(scene.elements.map((element) => [element.id, element]))

  if (selectedGeneratedResult?.elementId) {
    const element = elementsById.get(selectedGeneratedResult.elementId)
    if (isPanelMediaTargetElement(element)) {
      const geometry = getElementGeometry(element)
      const placement = getFrameViewportPlacement(geometry, appState)
      return {
        id: selectedGeneratedResult.id || `result:${element.id}`,
        elementId: element.id,
        kind: panelMediaKindFromElement(element),
        viewportWidth,
        viewportHeight,
        ...geometry,
        ...placement
      }
    }
  }

  if (activeFrameId) {
    const element = elementsById.get(activeFrameId)
    if (!isGeneratorFrame(element)) return null
    const geometry = getElementGeometry(element)
    const placement = getFrameViewportPlacement(geometry, appState)
    return {
      id: element.id,
      kind: getGeneratorKind(element),
      viewportWidth,
      viewportHeight,
      ...geometry,
      ...placement
    }
  }

  return null
}

function buildFrameOverlays(scene) {
  const appState = scene.appState ?? {}
  const selectedIds = new Set(getSelectedIds(appState))
  const overlays = []

  for (const element of scene.elements) {
    if (!isGeneratorFrame(element)) continue
    const placement = getFrameViewportPlacement(getElementGeometry(element), appState)
    if (!shouldBuildViewportOverlay(placement, appState, selectedIds, element.id)) continue
    const kind = getGeneratorKind(element)
    const customData = element.customData ?? {}
    const pixelWidth = Number(element.customData?.pixelWidth) || Math.round(element.width * 4)
    const pixelHeight = Number(element.customData?.pixelHeight) || Math.round(element.height * 4)
    overlays.push({
      id: element.id,
      kind,
      isSelected: selectedIds.has(element.id),
      outputAsset: kind === 'silenceCut' ? (customData.silenceCutOutputAsset || null) : null,
      // MCP/batch jobs mark their placeholder frames so the browser shows
      // the Generating... overlay for work it did not start itself.
      remoteGenerating: element.customData?.codexGenerating === true,
      left: placement.left,
      top: placement.top,
      width: placement.width,
      height: placement.height,
      pixelWidth,
      pixelHeight
    })
  }

  return limitViewportOverlays(overlays, appState, FRAME_OVERLAY_MAX_ITEMS)
}

function getCanvasMediaDisplayName(element, files = {}) {
  const customData = element?.customData ?? {}
  const file = element?.fileId ? files[element.fileId] : null
  const kind = canvasAssetKindFromElement(element)
  const fileName =
    canvasLeafFileName(customData.codexFileName) ||
    canvasLeafFileName(customData.generatorFileName) ||
    canvasLeafFileName(file?.name) ||
    canvasLeafFileNameFromAssetUrl(customData.codexAssetUrl) ||
    canvasLeafFileNameFromAssetUrl(customData.generatorAssetUrl) ||
    canvasLeafFileNameFromAssetUrl(file?.codexAssetUrl) ||
    canvasLeafFileNameFromAssetUrl(file?.dataURL) ||
    canvasLeafFileName(customData.codexAssetPath) ||
    canvasLeafFileName(customData.generatorAssetPath)
  if (fileName) return fileName
  return kind === 'video'
    ? 'Video'
    : kind === 'audio'
      ? 'Audio'
      : kind === 'xml'
        ? 'Premiere XML'
        : kind === 'srt'
          ? 'Subtitles'
          : kind === 'script'
            ? 'Script'
            : 'Image'
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
  // Youtube-AGI shows media headers for every media element near the
  // viewport, not only the selected one.
  const overlays = []

  for (const element of scene.elements) {
    if (!isCanvasAttachableElement(element)) continue
    const placement = getFrameViewportPlacement(getElementGeometry(element), appState)
    if (!shouldBuildViewportOverlay(placement, appState, selectedIds, element.id)) continue
    const pixelSize = getCanvasMediaPixelSize(element, scene.files)
    const file = element.fileId ? scene.files?.[element.fileId] : null
    const assetUrl = normalizeCanvasAssetUrl(
      assetUrlFromElement(element) ||
      (isCanvasAssetUrl(file?.codexAssetUrl) ? file.codexAssetUrl : '') ||
      (isCanvasAssetUrl(file?.dataURL) ? file.dataURL : '')
    )
    const assetType = canvasAssetKindFromElement(element)
    overlays.push({
      id: element.id,
      assetType,
      fileName: getCanvasMediaDisplayName(element, scene.files),
      assetPath: assetPathFromElement(element),
      assetUrl,
      isSelected: selectedIds.has(element.id),
      left: placement.left,
      top: placement.top,
      width: placement.width,
      height: placement.height,
      angle: Number(element.angle) || 0,
      pixelWidth: pixelSize.width,
      pixelHeight: pixelSize.height
    })
  }

  return limitViewportOverlays(overlays, appState, MEDIA_HEADER_OVERLAY_MAX_ITEMS)
}

function buildVideoPlaybackOverlays(scene) {
  const appState = scene.appState ?? {}
  const selectedIds = new Set(getSelectedIds(appState))
  const overlays = []

  for (const element of scene.elements) {
    if (!isCanvasVideoElement(element)) continue
    const sourceURL = assetUrlFromElement(element)
    if (!sourceURL) continue
    const placement = getFrameViewportPlacement(getElementGeometry(element), appState)
    if (!shouldBuildViewportOverlay(placement, appState, selectedIds, element.id)) continue
    const file = element.fileId ? scene.files?.[element.fileId] : null
    overlays.push({
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
    })
  }

  return limitViewportOverlays(overlays, appState, VIDEO_PLAYBACK_OVERLAY_MAX_ITEMS)
}

function buildSubtitlePreviewOverlays(scene) {
  const appState = scene.appState ?? {}
  const selectedIds = new Set(getSelectedIds(appState))
  const zoom = Number(appState.zoom?.value) || 1
  const overlays = []

  for (const element of scene.elements) {
    if (!isGeneratedSubtitleResult(element)) continue
    const assetUrl = element.customData?.codexAssetUrl || ''
    if (!assetUrl) continue
    const placement = getFrameViewportPlacement(getElementGeometry(element), appState)
    if (!shouldBuildViewportOverlay(placement, appState, selectedIds, element.id)) continue
    overlays.push({
      id: element.id,
      assetUrl,
      fileName: getCanvasMediaDisplayName(element, scene.files),
      cueCount: Number(element.customData?.subtitleCueCount) || 0,
      left: placement.left,
      top: placement.top,
      width: placement.width,
      height: placement.height,
      angle: Number(element.angle) || 0,
      zoom,
      isSelected: selectedIds.has(element.id)
    })
  }

  return limitViewportOverlays(overlays, appState, SUBTITLE_PREVIEW_OVERLAY_MAX_ITEMS)
}

// Fetched SRT text, split into raw lines, cached per asset URL. The lines map
// is also read synchronously by the canvas wheel handler to clamp scrolling.
const srtTextCache = new Map()
const srtLinesCache = new Map()

function splitSrtLines(text) {
  const source = String(text || '').replace(/\r\n?/g, '\n').trimEnd()
  return source ? source.split('\n') : ['']
}

function fetchSrtLines(url) {
  let pending = srtTextCache.get(url)
  if (pending) return pending
  pending = (async () => {
    const response = await canvasFetch(url)
    if (!response.ok) throw new Error(`Failed to load subtitles ${url}: ${response.status}`)
    const lines = splitSrtLines(await response.text())
    srtLinesCache.set(url, lines)
    return lines
  })()
  pending.catch(() => {
    if (srtTextCache.get(url) === pending) srtTextCache.delete(url)
  })
  srtTextCache.set(url, pending)
  return pending
}

function classifySrtLine(line) {
  if (!line.trim()) return 'blank'
  if (/^\d+$/.test(line.trim())) return 'index'
  if (/^\s*\d{1,2}:\d{2}:\d{2}[,.　]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.　]\d{1,3}/.test(line)) {
    return 'timestamp'
  }
  return 'text'
}

function renderHighlightedSrtLine(line, kind) {
  if (kind === 'timestamp') {
    const match = line.match(/^(\s*)(\d{1,2}:\d{2}:\d{2}[,.　]\d{1,3})(\s*-->\s*)(\d{1,2}:\d{2}:\d{2}[,.　]\d{1,3})(.*)$/)
    if (match) {
      const [, lead, start, arrow, end, tail] = match
      return (
        <>
          {lead}
          <span style={{ color: '#0a8754' }}>{start}</span>
          <span style={{ color: '#7d7d7d' }}>{arrow}</span>
          <span style={{ color: '#0a8754' }}>{end}</span>
          <span style={{ color: '#2d2d2d' }}>{tail}</span>
        </>
      )
    }
  }
  if (kind === 'index') {
    return <span style={{ color: '#0451a5', fontWeight: 600 }}>{line}</span>
  }
  return line
}

function getSubtitlePreviewBaseFontSize(canvasViewportWidth) {
  const baseFontSize = 13
  const minFontSize = 7
  const compactWidth = 360
  if (canvasViewportWidth >= compactWidth) {
    return baseFontSize
  }
  return Math.max(minFontSize, Math.min(baseFontSize, canvasViewportWidth / 28))
}

function getSubtitlePreviewLayout(lineCount, overlayWidth, overlayHeight, zoom, isSelected) {
  const selectedPreviewInset = isSelected ? 5 : 0
  const viewportWidth = Math.max(1, overlayWidth - selectedPreviewInset * 2)
  const viewportHeight = Math.max(1, overlayHeight - selectedPreviewInset * 2)
  const safeZoom = Math.max(0.01, zoom || 1)
  const canvasViewportWidth = viewportWidth / safeZoom
  const fontSize = getSubtitlePreviewBaseFontSize(canvasViewportWidth) * safeZoom
  const lineHeight = 1.5
  const rowHeight = Math.max(1, fontSize * lineHeight)
  const topPadding = Math.round(fontSize * 0.5)
  const bottomPadding = Math.round(fontSize * 1.4)
  const contentHeight = lineCount * rowHeight + topPadding + bottomPadding
  return {
    selectedPreviewInset,
    viewportWidth,
    viewportHeight,
    fontSize,
    lineHeight,
    rowHeight,
    topPadding,
    contentHeight,
    maxScroll: Math.max(0, contentHeight - viewportHeight)
  }
}

// Verbatim port of Youtube-AGI's SubtitleScrollablePreviewOverlay: a white
// editor-style card with a line-number gutter and syntax-highlighted raw SRT
// lines. Fully pointer-events none — scrolling is driven externally via the
// scrollOffset prop (canvas wheel handler), so click/drag/select pass through
// to Excalidraw untouched.
function SubtitleCanvasOverlay({ overlay, scrollOffset }) {
  const [lines, setLines] = useState(() => srtLinesCache.get(overlay.assetUrl) ?? [''])

  useEffect(() => {
    let cancelled = false
    fetchSrtLines(overlay.assetUrl)
      .then((nextLines) => {
        if (!cancelled) setLines(nextLines)
      })
      .catch(() => {
        if (!cancelled) setLines(['字幕を読み込めませんでした。'])
      })
    return () => {
      cancelled = true
    }
  }, [overlay.assetUrl])

  const layout = getSubtitlePreviewLayout(lines.length, overlay.width, overlay.height, overlay.zoom, overlay.isSelected)
  const { selectedPreviewInset, viewportHeight, fontSize, lineHeight, rowHeight, topPadding, contentHeight } = layout
  const safeScrollOffset = Math.max(0, Math.min(scrollOffset || 0, layout.maxScroll))
  const gutterDigits = Math.max(2, String(lines.length).length)
  const gutterWidth = Math.max(Math.round(fontSize * 1.8), Math.round(fontSize * 0.62 * (gutterDigits + 1.5)))
  const { headerFontSize, headerOffset } = getMediaHeaderMetrics(overlay.width)
  const lineCountLabel = `${lines.length} 行`
  const overscan = 12
  const firstVisibleLine = Math.max(0, Math.floor((safeScrollOffset - topPadding) / rowHeight) - overscan)
  const visibleLineCount = Math.ceil(viewportHeight / rowHeight) + overscan * 2
  const lastVisibleLine = Math.min(lines.length, firstVisibleLine + visibleLineCount)
  const visibleLines = lines.slice(firstVisibleLine, lastVisibleLine)

  return (
    <div
      className="lovart-subtitle-preview-overlay"
      style={{
        left: `${overlay.left}px`,
        top: `${overlay.top}px`,
        width: `${overlay.width}px`,
        height: `${overlay.height}px`,
        transform: overlay.angle ? `rotate(${overlay.angle}rad)` : undefined
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: `${selectedPreviewInset}px`,
          overflow: 'hidden',
          background: '#ffffff',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        <div
          ref={(el) => {
            if (el && el.scrollTop !== safeScrollOffset) {
              el.scrollTop = safeScrollOffset
            }
          }}
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'scroll',
            overflowX: 'hidden',
            background: '#ffffff',
            fontFamily: '"SF Mono", Menlo, Monaco, Consolas, "Courier New", monospace',
            fontSize: `${fontSize}px`,
            lineHeight,
            tabSize: 4,
            pointerEvents: 'none'
          }}
        >
          <div
            style={{
              position: 'relative',
              minHeight: '100%',
              height: `${Math.max(contentHeight, viewportHeight)}px`,
              background: '#ffffff'
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: `${gutterWidth}px`,
                height: '100%',
                background: '#ffffff',
                borderRight: '1px solid #f0f0f0',
                boxSizing: 'border-box'
              }}
            />
            {visibleLines.map((line, localIndex) => {
              const index = firstVisibleLine + localIndex
              const top = topPadding + index * rowHeight
              const kind = classifySrtLine(line)
              return (
                <div
                  key={index}
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: `${top}px`,
                    height: `${rowHeight}px`,
                    display: 'grid',
                    gridTemplateColumns: `${gutterWidth}px minmax(0, 1fr)`,
                    alignItems: 'start'
                  }}
                >
                  <div
                    style={{
                      height: `${rowHeight}px`,
                      paddingRight: `${Math.round(fontSize * 0.5)}px`,
                      textAlign: 'right',
                      color: '#858585',
                      userSelect: 'none',
                      boxSizing: 'border-box',
                      whiteSpace: 'pre'
                    }}
                  >
                    {index + 1}
                  </div>
                  <div
                    style={{
                      height: `${rowHeight}px`,
                      paddingLeft: `${Math.round(fontSize * 0.7)}px`,
                      paddingRight: `${Math.round(fontSize * 0.9)}px`,
                      color: kind === 'text' ? '#2d2d2d' : undefined,
                      whiteSpace: 'pre',
                      boxSizing: 'border-box',
                      overflow: 'hidden'
                    }}
                  >
                    {line ? renderHighlightedSrtLine(line, kind) : '​'}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
      {overlay.width >= 28 ? (
        <div
          className="lovart-image-header"
          style={{
            top: `-${headerOffset}px`,
            fontSize: `${headerFontSize}px`
          }}
        >
          <div className="lovart-image-header-name">
            <span className="lovart-image-header-name-text">{overlay.fileName}</span>
          </div>
          {overlay.width >= 90 ? <div className="lovart-image-header-size">{lineCountLabel}</div> : null}
        </div>
      ) : null}
    </div>
  )
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
    // Hover previews play with audio like Youtube-AGI. Browsers may reject
    // unmuted autoplay, so fall back to muted playback and unmute right after
    // play succeeds.
    const enableAudio = () => {
      element.defaultMuted = false
      element.muted = false
      element.volume = 1
    }
    enableAudio()
    void element.play().then(enableAudio).catch(() => {
      element.muted = true
      element.defaultMuted = true
      void element.play()
        .then(() => {
          window.setTimeout(enableAudio, 0)
        })
        .catch(() => {})
    })
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
  const placementStyle = {
    left: `${video.left}px`,
    top: `${video.top}px`,
    width: `${video.width}px`,
    height: `${video.height}px`,
    transform: video.angle ? `rotate(${video.angle}rad)` : undefined
  }

  // Media (poster + hover video) paints at z-index 1 so the Excalidraw
  // selection layer (interactive canvas, z 2) can draw the selection border
  // over it; the interactive controls live in a separate sibling at z 3,
  // mirroring Youtube-AGI's videoLayer (z1) / overlay portal (z3) split.
  return (
    <>
    <div className="lovart-video-playback-overlay" style={placementStyle}>
      {isRenderableVideoPosterDataURL(video.posterDataURL) ? (
        <img className="lovart-video-playback-media" src={video.posterDataURL} draggable={false} alt="" />
      ) : null}
      {isHovered ? (
        <video
          ref={hoverVideoRef}
          className="lovart-video-playback-media"
          src={video.sourceURL}
          loop
          playsInline
          preload="auto"
          onLoadedData={() => setIsHoverVideoReady(true)}
          onCanPlay={() => setIsHoverVideoReady(true)}
          style={{ opacity: isHoverVideoReady ? 1 : 0 }}
        />
      ) : null}
    </div>
    <div className="lovart-video-playback-ui" style={placementStyle}>
      {isHovered && showOverlayUI && !video.isSelected ? <div className="lovart-video-hover-gradient" /> : null}
      {!isHovered && showOverlayUI ? (
        <button
          type="button"
          className="lovart-video-play-icon"
          style={{
            width: `${Math.round(48 * iconScale)}px`,
            height: `${Math.round(48 * iconScale)}px`
          }}
          onPointerDown={(event) => {
            // Touch devices never hover, so this button is the only playback
            // entry point on phones: open the modal player straight from the
            // tap gesture. On mouse, hovering unmounts the icon before a click
            // can land, so desktop selection behavior is unchanged.
            event.preventDefault()
            event.stopPropagation()
            onExpand(video)
          }}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onExpand(video)
          }}
          aria-label="動画を再生"
        >
          <svg width={Math.round(18 * iconScale)} height={Math.round(18 * iconScale)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M8 5.14v13.72a1 1 0 001.5.86l11.04-6.86a1 1 0 000-1.72L9.5 4.28A1 1 0 008 5.14z" fill="#fff" />
          </svg>
        </button>
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
          onPointerDown={(event) => {
            // Fire on pointerdown: the button unmounts when the hover state is
            // cleared mid-click, so waiting for the click event can lose the
            // interaction entirely.
            event.preventDefault()
            event.stopPropagation()
            onExpand(video)
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
    </>
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
        onLoadedMetadata={(event) => {
          // iOS may reject unmuted autoplay outside the tap's call stack; start
          // muted instead of silently not playing (controls allow unmuting).
          const element = event.currentTarget
          void element.play().catch(() => {
            element.muted = true
            void element.play().catch(() => {})
          })
        }}
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

// Target zoom when the canvas zooms toward a freshly inserted generator frame.
// Youtube-AGI uses 1.25 for the tall subtitle/silence-cut generators
// (SUBTITLE_GENERATOR_CREATE_ZOOM) and 2 for image/video.
function generatorCreateZoomFor(kind) {
  // fittedGeneratorZoom caps these so frame + panel always fit the
  // viewport. The tall SRT card targets ~150% (a full 2x would push the
  // panel off-screen on shorter displays).
  return kind === 'subtitle' ? 1.5 : 2
}

// Vertical viewport space to reserve for the input panel below the frame.
function generatorPanelReserveFor(kind) {
  if (kind === 'image') return 195
  if (kind === 'video') return 280
  // Utility panels are tall and must leave room above the bottom toolbar.
  if (kind === 'subtitle') return 300
  return 300
}

// Largest zoom (capped at desiredZoom) at which the frame plus its panel and
// the top toolbar reserve fit fully inside the viewport.
function fittedGeneratorZoom(kind, size, viewportWidth, viewportHeight, desiredZoom) {
  const availableHeight = Math.max(80, viewportHeight - GENERATOR_FRAME_TOP_RESERVE - generatorPanelReserveFor(kind) - 16)
  const availableWidth = Math.max(120, viewportWidth - GENERATOR_FRAME_EDGE_MARGIN * 2)
  const fit = Math.min(availableHeight / size.height, availableWidth / size.width)
  return Math.max(0.2, Math.min(desiredZoom, fit))
}

function frameSizeFor(kind, form) {
  if (kind === 'video') return VIDEO_ASPECTS[form.videoAspectRatio] ?? VIDEO_ASPECTS['16:9']
  if (kind === 'subtitle') return { width: 205, height: 364 }
  if (kind === 'silenceCut') return { width: 364, height: 205 }
  if (kind === 'lovart') {
    if (form.lovartKind === 'video') return VIDEO_ASPECTS[form.lovartVideoAspectRatio] ?? VIDEO_ASPECTS['16:9']
    const lovartOption = IMAGE_ASPECTS[form.lovartAspectRatio] ?? IMAGE_ASPECTS['1:1']
    return {
      width: Math.max(140, Math.min(980, Math.round(lovartOption.baseWidth * 0.25))),
      height: Math.max(140, Math.min(980, Math.round(lovartOption.baseHeight * 0.25))),
      pixelWidth: lovartOption.baseWidth,
      pixelHeight: lovartOption.baseHeight
    }
  }
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
  useEffect(() => {
    if (import.meta.env.DEV) window.__excalidrawApi = api
  }, [api])
  const [activeFrameId, setActiveFrameId] = useState('')
  const [activeFrameKind, setActiveFrameKind] = useState('image')
  const [frameForm, setFrameForm] = useState(DEFAULT_FRAME_FORM)
  const [frameOverlays, setFrameOverlays] = useState([])
  const [selectedImageOverlays, setSelectedImageOverlays] = useState([])
  const [videoPlaybackOverlays, setVideoPlaybackOverlays] = useState([])
  const [subtitlePreviewOverlays, setSubtitlePreviewOverlays] = useState([])
  const [subtitleScrollOffsets, setSubtitleScrollOffsets] = useState({})
  const [managedSelectionActive, setManagedSelectionActive] = useState(false)
  const [lovartAuth, setLovartAuth] = useState(null)
  const [lovartKeySaving, setLovartKeySaving] = useState(false)
  const [lovartKeyEditing, setLovartKeyEditing] = useState(false)
  const [hermesStatus, setHermesStatus] = useState(null)
  const [chatSendStatus, setChatSendStatus] = useState('')

  // Bridge to the local Claude Code / Codex app. Files attach natively via
  // `open -a` (same route as drag & drop — no macOS permissions); text
  // prompts ride the same channel as a small request file. The message is
  // also written to the user-session clipboard from the browser so a manual
  // ⌘V always works (Codex can't accept media files via open).
  const sendToChatApp = useCallback(async ({ app, text, assetUrls, assetItems, autoSend = false }) => {
    setChatSendStatus('sending')
    try {
      // Step 1: resolve asset URLs to absolute paths server-side.
      const resolveResponse = await canvasFetch('/api/chat/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: '', text, assetUrls, assetItems })
      })
      const resolved = await resolveResponse.json().catch(() => ({}))
      if (!resolveResponse.ok) throw new Error(resolved.error || `送信に失敗しました (${resolveResponse.status})`)
      const message = resolved.message || text
      // Step 2: put the message on the user-session clipboard from the page.
      try {
        await navigator.clipboard.writeText(message)
      } catch {
        // Clipboard unavailable — the attach route may still succeed.
      }
      if (!app) {
        setChatSendStatus('copied')
        window.setTimeout(() => setChatSendStatus(''), 2600)
        return
      }
      // Step 3: attach into the chat app (open -a) / activate it.
      const response = await canvasFetch('/api/chat/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app, text, assetUrls, assetItems, autoSend })
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || `送信に失敗しました (${response.status})`)
      if (payload.sent) {
        setChatSendStatus('sent')
      } else if (payload.attached) {
        setChatSendStatus('attached')
      } else if (payload.copied) {
        setChatSendStatus(payload.error ? 'copied-fallback' : 'copied')
      } else {
        setChatSendStatus('error')
      }
      if (payload.error) console.warn('chat send fallback:', payload.error)
    } catch (error) {
      console.warn('chat send failed:', error)
      setChatSendStatus('error')
    }
    window.setTimeout(() => setChatSendStatus(''), 3200)
  }, [])
  const [silenceCutNotice, setSilenceCutNotice] = useState('')
  // Project-common 用語辞書 (canvas/subtitle-glossary.json), edited from the
  // SRT panel's 用語 pill and merged server-side into every transcription.
  const [glossaryTerms, setGlossaryTerms] = useState([])
  const [glossarySaving, setGlossarySaving] = useState(false)
  const [glossaryStatus, setGlossaryStatus] = useState('')
  const mutateGlossaryTerms = (terms) => {
    setGlossaryTerms(terms)
    setGlossaryStatus('')
  }
  const updateGlossaryTerm = (id, key, value) =>
    mutateGlossaryTerms((glossaryTerms ?? []).map((term) => (term.id === id ? { ...term, [key]: value } : term)))
  const removeGlossaryTerm = (id) => mutateGlossaryTerms((glossaryTerms ?? []).filter((term) => term.id !== id))
  const addGlossaryTerm = () => mutateGlossaryTerms([...(glossaryTerms ?? []), { id: crypto.randomUUID(), from: '', to: '' }])
  const saveGlossaryTerms = async () => {
    setGlossarySaving(true)
    try {
      const response = await canvasFetch('/api/subtitle-glossary', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ terms: glossaryTerms ?? [] })
      })
      setGlossaryStatus(response.ok ? '保存しました' : '保存に失敗しました')
    } catch {
      setGlossaryStatus('保存に失敗しました')
    } finally {
      setGlossarySaving(false)
    }
  }
  const glossaryActiveCount = (glossaryTerms ?? []).filter((term) => term.from?.trim()).length
  const lovartAccessKeyInputRef = useRef(null)
  const lovartSecretKeyInputRef = useRef(null)
  const subtitlePreviewOverlaysRef = useRef([])
  const [silenceCutAdvancedOpen, setSilenceCutAdvancedOpen] = useState(false)
  const [hoveredVideoPlaybackId, setHoveredVideoPlaybackId] = useState('')
  const [expandedVideoPlayback, setExpandedVideoPlayback] = useState(null)
  const [pendingPanelFrame, setPendingPanelFrame] = useState(null)
  const [selectedGeneratedResult, setSelectedGeneratedResult] = useState(null)

  useEffect(() => {
    canvasFetch('/api/subtitle-glossary')
      .then((response) => response.json())
      .then((payload) => setGlossaryTerms(Array.isArray(payload.terms) ? payload.terms : []))
      .catch(() => setGlossaryTerms([]))
    canvasFetch('/api/lovart/auth-status')
      .then((response) => response.json())
      .then(setLovartAuth)
      .catch(() => setLovartAuth({ configured: false }))
  }, [])
  const [openMenu, setOpenMenu] = useState(null)
  const [videoFrameBtnsHovered, setVideoFrameBtnsHovered] = useState(false)
  const [utilityTrayHovered, setUtilityTrayHovered] = useState(false)
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
  const toolbarMediaInputRef = useRef(null)
  const toolbarMediaPickerActiveRef = useRef(false)
  const hoverOverlayRef = useRef(null)
  const menuBackdropRef = useRef(null)
  const videoFrameUploadTargetRef = useRef('start')
  const pendingGeneratorUploadFrameIdRef = useRef('')
  const pendingGeneratorUploadResultRef = useRef(null)
  const videoFrameLeaveTimerRef = useRef(0)
  const lastGeneratorPasteRef = useRef({ time: 0, sourceId: '', frameId: '' })
  const saveTimerRef = useRef(null)
  const selectionTimerRef = useRef(null)
  const lastSelectionRef = useRef('')
  const applyingRemoteRef = useRef(false)
  const hasLocalChangesRef = useRef(false)
  const localChangeVersionRef = useRef(0)
  const lastSyncedFingerprintRef = useRef('')
  const pendingOverlaySceneRef = useRef(null)
  const overlayRefreshFrameRef = useRef(0)
  const assetHydrationTimerRef = useRef(0)
  const hydratedFileBufferRef = useRef(new Map())
  const hydratedFlushTimerRef = useRef(0)

  useEffect(() => {
    const controller = new AbortController()

    async function loadCanvas() {
      try {
        const response = await canvasFetch(CANVAS_ENDPOINT, { signal: controller.signal })
        if (!response.ok) throw new Error(`Failed to load canvas: ${response.status}`)
        const payload = await response.json()
        const diskScene = normalizeScene(payload.scene)
        const scene = withRuntimeAssetBackedScene(diskScene)
        lastSyncedFingerprintRef.current = sceneFingerprint(diskScene)
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
        const response = await canvasFetch(GENERATION_CAPABILITIES_ENDPOINT, { signal: controller.signal })
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
      await canvasFetch(SELECTION_ENDPOINT, {
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

  const saveCanvas = useCallback(async (scene, options = {}) => {
    window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = null
    const saveVersion = Number.isFinite(options.changeVersion)
      ? options.changeVersion
      : localChangeVersionRef.current
    // Persist viewport only (never selection) so the round-tripped scene can't
    // re-impose a stale selection on the live editor. Asset-backed file records
    // are stripped back to their asset URL so we never re-embed hydrated base64
    // into the persisted scene (the server applies the same rule as a backstop).
    const persisted = {
      ...scene,
      appState: persistableAppState(scene.appState),
      files: stripAssetBackedFilesForSave(scene.elements, scene.files)
    }
    const persistedFingerprint = sceneFingerprint(persisted)
    try {
      if (persistedFingerprint !== lastSyncedFingerprintRef.current) {
        const canvasResponse = await canvasFetch(CANVAS_ENDPOINT, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(persisted)
        })
        if (!canvasResponse.ok) throw new Error(`Failed to save canvas: ${canvasResponse.status}`)
        // Remember what we just saved so the SSE echo of this exact content is
        // ignored instead of clobbering newer local edits.
        lastSyncedFingerprintRef.current = persistedFingerprint
      }
      const viewResponse = await canvasFetch(VIEW_STATE_ENDPOINT, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(getViewState(scene.appState))
      })
      if (!viewResponse.ok) throw new Error(`Failed to save view state: ${viewResponse.status}`)
      if (localChangeVersionRef.current === saveVersion) {
        hasLocalChangesRef.current = false
      }
    } catch (error) {
      console.error(error)
    }
  }, [])

  const scheduleCanvasSave = useCallback(
    (scene) => {
      const changeVersion = localChangeVersionRef.current + 1
      localChangeVersionRef.current = changeVersion
      hasLocalChangesRef.current = true
      window.clearTimeout(saveTimerRef.current)
      // Save the freshest scene at fire time: a debounced frame-form write can
      // land between scheduling and firing, and saving the stale snapshot
      // would drop it from disk.
      saveTimerRef.current = window.setTimeout(() => {
        saveCanvas(latestSceneRef.current ?? scene, { changeVersion })
      }, SAVE_DELAY_MS)
    },
    [saveCanvas]
  )

  const refreshOverlayStates = useCallback((scene) => {
    setFrameOverlays(buildFrameOverlays(scene))
    setSelectedImageOverlays(buildSelectedImageOverlays(scene))
    setVideoPlaybackOverlays(buildVideoPlaybackOverlays(scene))
    const subtitleOverlays = buildSubtitlePreviewOverlays(scene)
    subtitlePreviewOverlaysRef.current = subtitleOverlays
    setSubtitlePreviewOverlays(subtitleOverlays)
    // Hide Excalidraw's shape-properties panel while only app-managed
    // elements (generator frames, SRT cards, generated media) are selected —
    // their UI lives in our overlays/panels, like Youtube-AGI.
    const elementsById = new Map(scene.elements.map((element) => [element.id, element]))
    const selectedIds = getSelectedIds(scene.appState)
    setManagedSelectionActive(
      selectedIds.length > 0 &&
        selectedIds.every((id) => {
          const element = elementsById.get(id)
          return (
            element &&
            (isGeneratorFrame(element) ||
              isGeneratedSubtitleResult(element) ||
              isCanvasVideoElement(element) ||
              isCanvasImageElement(element))
          )
        })
    )
  }, [])

  const scheduleOverlayRefresh = useCallback((scene) => {
    pendingOverlaySceneRef.current = scene
    if (overlayRefreshFrameRef.current) return
    overlayRefreshFrameRef.current = window.requestAnimationFrame(() => {
      overlayRefreshFrameRef.current = 0
      const pendingScene = pendingOverlaySceneRef.current
      pendingOverlaySceneRef.current = null
      if (pendingScene) refreshOverlayStates(pendingScene)
    })
  }, [refreshOverlayStates])

  useEffect(() => () => {
    if (overlayRefreshFrameRef.current) {
      window.cancelAnimationFrame(overlayRefreshFrameRef.current)
      overlayRefreshFrameRef.current = 0
    }
    window.clearTimeout(assetHydrationTimerRef.current)
    pendingOverlaySceneRef.current = null
  }, [])

  // Writing the panel form into the frame's customData on every keystroke made
  // Excalidraw fire onChange mid-IME-composition; the unconditional
  // setFrameForm below then reset the textarea to a stale value, duplicating
  // composed text. Writes are debounced and only flushed when leaving a frame,
  // and the form is only re-read from the element when the selection changes.
  const pendingFrameFormWriteRef = useRef(null)
  const updateActiveFrameElementRef = useRef(null)
  const updateGeneratedResultElementRef = useRef(null)

  const flushPendingFrameFormWrite = useCallback(() => {
    const pending = pendingFrameFormWriteRef.current
    if (!pending) return
    pendingFrameFormWriteRef.current = null
    window.clearTimeout(pending.timer)
    if (pending.frameId) {
      updateActiveFrameElementRef.current?.(pending.form, pending.frameId)
    } else if (pending.result) {
      updateGeneratedResultElementRef.current?.(pending.form, pending.result)
    }
  }, [])

  const scheduleFrameFormWrite = useCallback((form) => {
    const frameId = activeFrameIdRef.current
    const result = frameId ? null : snapshotSelectedGeneratedResult(selectedGeneratedResultRef.current)
    if (!frameId && !result?.elementId) return
    const pending = pendingFrameFormWriteRef.current
    if (pending) window.clearTimeout(pending.timer)
    const timer = window.setTimeout(() => {
      if (pendingFrameFormWriteRef.current?.timer === timer) pendingFrameFormWriteRef.current = null
      if (frameId) updateActiveFrameElementRef.current?.(form, frameId)
      else updateGeneratedResultElementRef.current?.(form, result)
    }, 300)
    pendingFrameFormWriteRef.current = { timer, form, frameId, result }
  }, [])

  const syncGeneratorUi = useCallback((scene, options = {}) => {
    if (options.deferOverlays) scheduleOverlayRefresh(scene)
    else refreshOverlayStates(scene)
    const elementsById = new Map(scene.elements.map((element) => [element.id, element]))
    const selectedIds = getSelectedIds(scene.appState)
    const selectedResultId =
      selectedIds.find((id) => isPanelMediaTargetElement(elementsById.get(id))) ??
      selectedIds
        .map((id) => elementsById.get(id)?.customData?.codexVideoLabelFor)
        .find((id) => isPanelMediaTargetElement(elementsById.get(id))) ??
      ''
    const selectedFrameId = selectedResultId
      ? ''
      : selectedIds.find((id) => isGeneratorFrame(elementsById.get(id))) ?? ''
    const pendingWrite = pendingFrameFormWriteRef.current
    if (pendingWrite) {
      const pendingTargetId = pendingWrite.frameId || pendingWrite.result?.elementId || ''
      const selectedTargetId = selectedFrameId || selectedResultId || ''
      if (pendingTargetId !== selectedTargetId) flushPendingFrameFormWrite()
    }

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
        setActiveFrameKind(getGeneratorKind(selectedFrame))
        setFrameForm(frameFormFromElement(selectedFrame))
      }
      return
    }

    if (selectedResultId) {
      const selectedResult = elementsById.get(selectedResultId)
      const resultChanged = selectedGeneratedResultRef.current?.elementId !== selectedResultId
      const kind = panelMediaKindFromElement(selectedResult)
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
        setActiveFrameKind(kind)
        setFrameForm(frameFormFromElement(selectedResult))
      }
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
  }, [refreshOverlayStates, scheduleOverlayRefresh, flushPendingFrameFormWrite])

  useEffect(() => {
    if (initialScene) syncGeneratorUi(initialScene)
  }, [initialScene, syncGeneratorUi])

  // Apply a batch of freshly hydrated files in ONE scene update. Hydrating a
  // large canvas over the tunnel streams dozens of files; rebuilding and
  // re-rendering the whole scene per file pins a phone CPU, so buffered files
  // are flushed together (throttled) into a single updateScene.
  const flushHydratedFiles = useCallback(() => {
    hydratedFlushTimerRef.current = 0
    const buffer = hydratedFileBufferRef.current
    if (!api || buffer.size === 0) return
    const bufferedFiles = [...buffer.values()]
    hydratedFileBufferRef.current = new Map()

    api.addFiles(bufferedFiles)
    const fileIds = new Set(bufferedFiles.map((file) => file.id))
    const currentElements = api.getSceneElementsIncludingDeleted?.() ?? latestSceneRef.current.elements
    let touchedImage = false
    let restoredStatus = false
    const now = Date.now()
    const restoredElements = currentElements.map((element) => {
      if (
        element?.type !== 'image' ||
        !fileIds.has(element.fileId) ||
        element.customData?.codexMediaKind === 'video'
      ) {
        return element
      }
      touchedImage = true
      if (element.status === 'error') restoredStatus = true
      return {
        ...element,
        status: 'saved',
        version: (Number(element.version) || 1) + 1,
        versionNonce: Math.floor(Math.random() * 2 ** 31),
        updated: now
      }
    })
    if (!touchedImage) return

    const currentAppState = api.getAppState?.() ?? latestSceneRef.current.appState
    const currentFiles = { ...(api.getFiles?.() ?? latestSceneRef.current.files ?? {}) }
    for (const file of bufferedFiles) currentFiles[file.id] = file
    const nextScene = createScene(restoredElements, currentAppState, currentFiles)
    latestSceneRef.current = nextScene
    suppressNextChangeRef.current = true
    api.updateScene({
      elements: restoredElements,
      files: currentFiles,
      captureUpdate: CaptureUpdateAction.NEVER
    })
    refreshOverlayStates(nextScene)
    if (restoredStatus) scheduleCanvasSave(nextScene)
  }, [api, refreshOverlayStates, scheduleCanvasSave])

  const addHydratedAssetFile = useCallback((file) => {
    if (!api || !file?.id) return
    hydratedFileBufferRef.current.set(file.id, file)
    // Flush large backlogs immediately, otherwise coalesce a short burst.
    if (hydratedFileBufferRef.current.size >= 12) {
      window.clearTimeout(hydratedFlushTimerRef.current)
      flushHydratedFiles()
      return
    }
    if (!hydratedFlushTimerRef.current) {
      hydratedFlushTimerRef.current = window.setTimeout(flushHydratedFiles, 140)
    }
  }, [api, flushHydratedFiles])

  const scheduleVisibleAssetHydration = useCallback((scene) => {
    if (!api || !scene || !isTunnelCanvasRuntime()) return
    window.clearTimeout(assetHydrationTimerRef.current)
    assetHydrationTimerRef.current = window.setTimeout(() => {
      const visibleFileIds = visibleAssetBackedImageFileIds(scene, 240)
      if (visibleFileIds.size === 0) return
      hydrateAssetBackedFiles(scene.files, addHydratedAssetFile, { onlyFileIds: visibleFileIds })
    }, 250)
  }, [api, addHydratedAssetFile])

  // Hydrate disk-backed file records once the Excalidraw API is ready.
  // Viewport-first: what is on screen hydrates immediately at full speed, then
  // the rest trickles in behind interactions (brief yield + low concurrency) so
  // the whole canvas still fills without janking pan/zoom on phones. Whatever
  // the user pans to is prioritized live by scheduleVisibleAssetHydration.
  useEffect(() => {
    if (!api || !initialScene) return
    let cancelled = false
    const addIfLive = (file) => {
      if (!cancelled) addHydratedAssetFile(file)
    }
    const run = async () => {
      const visibleFileIds = visibleAssetBackedImageFileIds(initialScene, 200)
      if (visibleFileIds.size > 0) {
        await hydrateAssetBackedFiles(initialScene.files, addIfLive, { onlyFileIds: visibleFileIds })
        if (cancelled) return
      }
      const restIds = new Set(
        Object.values(initialScene.files ?? {})
          .filter((file) => isAssetBackedFileRecord(file) && !visibleFileIds.has(file.id))
          .map((file) => file.id)
      )
      if (restIds.size === 0) return
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
      if (cancelled) return
      await hydrateAssetBackedFiles(initialScene.files, addIfLive, { onlyFileIds: restIds, concurrency: 2 })
    }
    run()
    return () => {
      cancelled = true
    }
  }, [api, initialScene, addHydratedAssetFile])

  // Over the tunnel, a service worker keeps a persistent asset cache so repeat
  // visits paint instantly (even after the HTTP cache is evicted) and offscreen
  // images can be prefetched. Local sessions skip it so freshly generated
  // images are never served stale.
  useEffect(() => {
    if (!isTunnelCanvasRuntime() || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    navigator.serviceWorker.register('/canvas-sw.js', { updateViaCache: 'none' }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!isTunnelCanvasRuntime() || !initialScene || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const previewUrl = (file) => {
      const base =
        typeof file.codexAssetUrl === 'string' && file.codexAssetUrl.startsWith(CANVAS_ASSETS_ROUTE)
          ? file.codexAssetUrl
          : file.dataURL
      if (typeof base !== 'string' || !base.startsWith(CANVAS_ASSETS_ROUTE)) return ''
      return /\.(png|jpe?g|webp)$/i.test(base.split('?')[0]) ? `${base}?w=1600` : base
    }
    const urls = [...new Set(
      Object.values(initialScene.files ?? {})
        .filter((file) => isAssetBackedFileRecord(file))
        .map(previewUrl)
        .filter(Boolean)
    )]
    if (urls.length === 0) return
    let cancelled = false
    navigator.serviceWorker.ready
      .then((registration) => {
        if (!cancelled) registration.active?.postMessage({ type: 'prefetch', urls })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [initialScene])

  const handleChange = useCallback(
    (elements, appState, files) => {
      const shouldSkipChangeEffects = suppressNextChangeRef.current
      if (suppressNextChangeRef.current) suppressNextChangeRef.current = false
      let workingElements = [...elements]

      if (!shouldSkipChangeEffects && api) {
        const normalizedElements = normalizeGeneratorFrameVisuals(workingElements)
        if (normalizedElements) {
          window.setTimeout(() => {
            suppressNextChangeRef.current = true
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
                [generatorFrameTagFor(getGeneratorKind(sourceForData))]: true,
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
          activeFrameIdRef.current = selectedFrameId
          lastFocusedFrameIdRef.current = selectedFrameId
          setActiveFrameId(selectedFrameId)
          setActiveFrameKind(selectedKind)
          setFrameForm(frameFormFromElement(selectedFrame))
          setPendingPanelFrame(null)
          setSelectedGeneratedResult(null)
          setOpenMenu(null)
          refreshOverlayStates(nextScene)
          scheduleVisibleAssetHydration(nextScene)
          scheduleSelectionSave(nextScene)
          scheduleCanvasSave(nextScene)
          window.setTimeout(() => {
            suppressNextChangeRef.current = true
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
      scheduleVisibleAssetHydration(scene)
      if (shouldSkipChangeEffects) {
        scheduleOverlayRefresh(scene)
        scheduleSelectionSave(scene)
        if (!applyingRemoteRef.current) scheduleCanvasSave(scene)
        return
      }
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
            const reselected = { ...appState, selectedElementIds: { [hit.id]: true } }
            const nextScene = createScene(workingElements, reselected, files)
            latestSceneRef.current = nextScene
            syncGeneratorUi(nextScene)
            window.setTimeout(() => {
              suppressNextChangeRef.current = true
              api.updateScene({
                appState: { selectedElementIds: { [hit.id]: true } },
                captureUpdate: CaptureUpdateAction.NEVER
              })
            }, 0)
            return
          }
        }
      }

      syncGeneratorUi(scene, { deferOverlays: true })
      scheduleSelectionSave(scene)

      if (!applyingRemoteRef.current && !shouldSkipChangeEffects) {
        scheduleCanvasSave(scene)
      }
    },
    [api, refreshOverlayStates, scheduleCanvasSave, scheduleOverlayRefresh, scheduleSelectionSave, scheduleVisibleAssetHydration, syncGeneratorUi]
  )

  const applyRemoteScene = useCallback(
    (scene, options = {}) => {
      if (!api || (hasLocalChangesRef.current && !options.force)) return

      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      hasLocalChangesRef.current = false
      const diskNormalized = normalizeScene(scene)
      const normalized = withRuntimeAssetBackedScene(diskNormalized)
      const remoteApplyVersion = localChangeVersionRef.current
      lastSyncedFingerprintRef.current = sceneFingerprint(diskNormalized)
      latestSceneRef.current = normalized
      previousGeneratorFrameIdsRef.current = new Set(normalized.elements.filter(isGeneratorFrame).map((element) => element.id))
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
      if (isTunnelCanvasRuntime()) {
        const visibleFileIds = visibleAssetBackedImageFileIds(nextScene, 240)
        if (visibleFileIds.size > 0) {
          hydrateAssetBackedFiles(normalized.files, addHydratedAssetFile, { onlyFileIds: visibleFileIds })
        }
      } else {
        hydrateAssetBackedFiles(normalized.files, addHydratedAssetFile)
      }
      window.setTimeout(() => {
        if (localChangeVersionRef.current !== remoteApplyVersion && !options.force) return
        applyingRemoteRef.current = true
        suppressNextChangeRef.current = true
        api.updateScene({
          elements: normalized.elements,
          appState: nextAppState,
          captureUpdate: CaptureUpdateAction.NEVER
        })
        window.setTimeout(() => {
          applyingRemoteRef.current = false
        }, 3000)
      }, 0)
    },
    [api, addHydratedAssetFile, syncGeneratorUi]
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
        const response = await canvasFetch(CANVAS_ENDPOINT)
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

    const events = createCanvasEventSource(CANVAS_EVENTS_ENDPOINT)
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
      // No job targets the new id — inheriting codexGenerating would leave the
      // pasted frame stuck on the Generating... overlay forever.
      const pastedCustomData = { ...(copiedFrame.customData ?? {}) }
      delete pastedCustomData.codexGenerating
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
        customData: pastedCustomData
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
        refreshOverlayStates(nextScene)
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
  }, [api, frameForm, openToolbarMediaPicker, refreshOverlayStates, scheduleCanvasSave, scheduleSelectionSave])

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
    let hoverClearTimer = 0

    // Clearing the video hover is debounced: crossing an element boundary
    // (or an overlapping element) for a few frames used to unmount the
    // playback controls mid-approach, making the expand button flicker.
    const setVideoHover = (id) => {
      if (id) {
        window.clearTimeout(hoverClearTimer)
        hoverClearTimer = 0
        setHoveredVideoPlaybackId(id)
      } else if (!hoverClearTimer) {
        hoverClearTimer = window.setTimeout(() => {
          hoverClearTimer = 0
          setHoveredVideoPlaybackId('')
        }, 160)
      }
    }

    const hideHover = () => {
      hover.style.display = 'none'
      setVideoHover('')
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
        if (!(isCanvasAttachableElement(element) || isGeneratorFrame(element))) return false
        return scenePointInElement(scenePoint, element)
      })

      if (!target) {
        hideHover()
        return
      }

      setVideoHover(isCanvasVideoElement(target) ? target.id : '')
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
    const onPointerLeave = (event) => {
      // The playback controls (expand button etc.) are siblings of the
      // Excalidraw root, so moving onto them fires pointerleave here. Keeping
      // the hover alive prevents the unmount/remount loop that made the
      // expand button flicker under the cursor.
      const related = event?.relatedTarget
      if (
        related instanceof Element &&
        related.closest('.lovart-video-playback-ui, .lovart-image-header, .lovart-video-modal')
      ) {
        return
      }
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
      window.clearTimeout(hoverClearTimer)
    }
  }, [api])

  useEffect(() => {
    return () => {
      window.clearTimeout(saveTimerRef.current)
      window.clearTimeout(selectionTimerRef.current)
      window.clearTimeout(videoFrameLeaveTimerRef.current)
      if (pendingFrameFormWriteRef.current) window.clearTimeout(pendingFrameFormWriteRef.current.timer)
    }
  }, [])

  const updateActiveFrameElement = useCallback(
    (nextForm, frameIdOverride) => {
      const frameId = frameIdOverride || activeFrameIdRef.current
      if (!api || !frameId) return
      const pendingWrite = pendingFrameFormWriteRef.current
      if (pendingWrite && pendingWrite.frameId === frameId) {
        // This write derives from newer state than the queued one — drop the
        // queued write so it can't fire later and revert this one.
        pendingFrameFormWriteRef.current = null
        window.clearTimeout(pendingWrite.timer)
      }
      const elements = api.getSceneElementsIncludingDeleted()
      const frame = elements.find((element) => element.id === frameId)
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
      window.setTimeout(() => {
        suppressNextChangeRef.current = true
        api.updateScene({
          elements: nextElements,
          captureUpdate: CaptureUpdateAction.NEVER
        })
      }, 0)
      const nextScene = createScene(nextElements, api.getAppState(), api.getFiles())
      latestSceneRef.current = nextScene
      refreshOverlayStates(nextScene)
      scheduleCanvasSave(nextScene)
    },
    [api, refreshOverlayStates, scheduleCanvasSave]
  )

  useEffect(() => {
    updateActiveFrameElementRef.current = updateActiveFrameElement
  }, [updateActiveFrameElement])

  const updateGeneratedResultElement = useCallback(
    (nextForm, resultOverride) => {
      const result = resultOverride || selectedGeneratedResultRef.current
      if (!api || !result?.elementId) return
      const elements = api.getSceneElementsIncludingDeleted()
      const resultElement = elements.find((element) => element.id === result.elementId)
      if (!isGeneratedResult(resultElement)) return

      const kind = result.kind || panelMediaKindFromElement(resultElement)
      const customData = {
        ...(resultElement.customData ?? {}),
        ...frameCustomDataFromForm(kind, nextForm)
      }
      const nextElements = elements.map((element) =>
        element.id === resultElement.id
          ? {
              ...element,
              customData,
              version: (Number(element.version) || 1) + 1,
              versionNonce: Math.floor(Math.random() * 2 ** 31),
              updated: Date.now()
            }
          : element
      )
      const selectedElementIds = { [resultElement.id]: true }
      const nextAppState = { ...(api.getAppState?.() ?? latestSceneRef.current.appState), selectedElementIds }
      const nextScene = createScene(nextElements, nextAppState, api.getFiles())
      latestSceneRef.current = nextScene
      activeFrameIdRef.current = ''
      selectedGeneratedResultRef.current = { ...result, kind, elementId: resultElement.id }
      setActiveFrameId('')
      setSelectedGeneratedResult(selectedGeneratedResultRef.current)
      setActiveFrameKind(kind)
      window.setTimeout(() => {
        suppressNextChangeRef.current = true
        api.updateScene({
          elements: nextElements,
          appState: { selectedElementIds },
          captureUpdate: CaptureUpdateAction.NEVER
        })
      }, 0)
      refreshOverlayStates(nextScene)
      scheduleSelectionSave(nextScene)
      scheduleCanvasSave(nextScene)
    },
    [api, refreshOverlayStates, scheduleCanvasSave, scheduleSelectionSave]
  )

  useEffect(() => {
    updateGeneratedResultElementRef.current = updateGeneratedResultElement
  }, [updateGeneratedResultElement])

  const updateFrameForm = useCallback(
    (key, value) => {
      let nextForm = null
      setFrameForm((current) => {
        const next = { ...current, [key]: value }
        nextForm = next
        return next
      })
      window.setTimeout(() => {
        if (nextForm) scheduleFrameFormWrite(nextForm)
      }, 0)
      setGenerationError('')
    },
    [scheduleFrameFormWrite]
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
        if (nextForm) scheduleFrameFormWrite(nextForm)
      }, 0)
      setGenerationError('')
    },
    [scheduleFrameFormWrite]
  )

    // Stream the file straight to disk with constant memory and no size cap —
    // large/long media (podcast videos, long audio) attach without buffering
    // the whole file in RAM or base64-encoding it. When the webview exposes
    // the picked file's local path (Electron), skip the HTTP transfer
    // entirely: the server clones the file on disk (APFS copy-on-write), so
    // even multi-GB podcasts attach instantly.
    const streamUpload = async (uploadFile) => {
      const localPath = typeof uploadFile.path === 'string' && uploadFile.path ? uploadFile.path : ''
      if (localPath) {
        const response = await canvasFetch(ASSET_UPLOAD_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sourcePath: localPath, fileName: uploadFile.name })
        })
        const payload = await response.json().catch(() => ({}))
        if (response.ok && !payload.error) return payload
        // Fall through to the streaming path (e.g. path outside this session).
      }
      const response = await canvasFetch(ASSET_UPLOAD_ENDPOINT, {
        method: 'POST',
        headers: {
          'x-upload-filename': encodeURIComponent(uploadFile.name || `asset-${Date.now()}`),
          'content-type': uploadFile.type || 'application/octet-stream'
        },
        body: uploadFile
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.error) {
        throw new Error(payload.error || `Upload failed: ${response.status}`)
      }
      return payload
    }

  const uploadAssetFile = useCallback(async (file, options = {}) => {
    const fileKind = getFileAssetKind(file)
    if (fileKind === 'xml' || fileKind === 'srt' || fileKind === 'script') {
      const payload = await streamUpload(file)
      return {
        id: crypto.randomUUID(),
        name: file.name,
        kind: fileKind,
        mimeType:
          payload.mimeType ||
          file.type ||
          (fileKind === 'xml' ? 'application/xml' : fileKind === 'srt' ? 'application/x-subrip' : 'text/plain'),
        path: payload.path,
        url: payload.url,
        dataURL: '',
        thumbnail: '',
        duration: 0
      }
    }

    if (fileKind === 'audio') {
      // Probe duration and stream the bytes concurrently so long audio attaches fast.
      const [metadata, payload] = await Promise.all([readAudioMetadata(file), streamUpload(file)])
      if (metadata.objectURL && typeof URL !== 'undefined') URL.revokeObjectURL(metadata.objectURL)
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

    if (fileKind === 'video') {
      // Poster extraction and the byte upload run in parallel.
      const posterPromise = options.poster && typeof options.poster === 'object'
        ? Promise.resolve(options.poster)
        : readVideoPoster(file)
      const [poster, payload] = await Promise.all([posterPromise, streamUpload(file)])
      if (!options.poster && poster.objectURL && typeof URL !== 'undefined') URL.revokeObjectURL(poster.objectURL)
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

    if (fileKind !== 'image') {
      throw new Error('このファイル形式は添付できません。')
    }

    const dataURL = await fileToDataURL(file)
    const response = await canvasFetch(ASSET_UPLOAD_ENDPOINT, {
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
    const response = await canvasFetch(ASSET_UPLOAD_ENDPOINT, {
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

  const readTextAsset = useCallback(async (asset) => {
    const url = asset?.url || ''
    if (!url) throw new Error('台本ファイルを読み込めません。')
    const response = await canvasFetch(url)
    if (!response.ok) throw new Error(`台本ファイルを読み込めません: ${response.status}`)
    const text = await response.text()
    return { ...asset, text }
  }, [])

  const getAttachmentDestinationFrameId = useCallback(() => {
    if (activeFrameIdRef.current) return activeFrameIdRef.current
    // When editing a generated result, there is intentionally no backing
    // generator frame yet. Keep attachments on the visible form instead of
    // writing them into whichever frame was focused previously.
    if (selectedGeneratedResultRef.current) return ''
    return lastFocusedFrameIdRef.current || ''
  }, [])

  const addAssetToFrame = useCallback(
    (target, assetOrAssets, frameIdOverride, options = {}) => {
      const assets = (Array.isArray(assetOrAssets) ? assetOrAssets : [assetOrAssets]).filter(Boolean)
      if (assets.length === 0) return
      const frameId = frameIdOverride || activeFrameIdRef.current
      const selectedResult = !frameId
        ? (options.selectedGeneratedResult || selectedGeneratedResultRef.current)
        : null
      if (selectedResult?.elementId) {
        activeFrameIdRef.current = ''
        selectedGeneratedResultRef.current = selectedResult
        setActiveFrameId('')
        setSelectedGeneratedResult(selectedResult)
        setActiveFrameKind(selectedResult.kind)
      }
      if (!frameId || frameId === activeFrameIdRef.current) {
        let nextForm = null
        setFrameForm((current) => {
          nextForm = assets.reduce((form, asset) => mergeAssetIntoForm(form, target, asset), current)
          return nextForm
        })
        window.setTimeout(() => {
          if (!nextForm) return
          if (selectedResult?.elementId && !frameId) {
            updateGeneratedResultElement(nextForm, selectedResult)
          } else {
            updateActiveFrameElement(nextForm, frameId || undefined)
          }
        }, 0)
        return
      }
      // The upload outlived the user's attention — they switched frames while
      // it ran. Attach to the frame that requested it, straight on its
      // element, without touching the live panel form.
      const element = api?.getSceneElementsIncludingDeleted?.().find((el) => el.id === frameId)
      if (!element || !isGeneratorFrame(element)) return
      const merged = assets.reduce((form, asset) => mergeAssetIntoForm(form, target, asset), frameFormFromElement(element))
      updateActiveFrameElement(merged, frameId)
    },
    [api, updateActiveFrameElement, updateGeneratedResultElement]
  )

  const openCanvasPicker = useCallback((target) => {
    const frameId = getAttachmentDestinationFrameId()
    const selectedGeneratedResult = frameId ? null : snapshotSelectedGeneratedResult(selectedGeneratedResultRef.current)
    canvasPickerFrameIdRef.current = frameId
    canvasPickerRef.current = { target, frameId, selectedGeneratedResult }
    setCanvasPicker({ target, frameId, selectedGeneratedResult })
    setOpenMenu(null)
  }, [getAttachmentDestinationFrameId])

  const rememberGeneratorUploadFrame = useCallback(() => {
    const frameId = getAttachmentDestinationFrameId()
    pendingGeneratorUploadFrameIdRef.current = frameId
    pendingGeneratorUploadResultRef.current = frameId ? null : snapshotSelectedGeneratedResult(selectedGeneratedResultRef.current)
  }, [getAttachmentDestinationFrameId])

  const restoreGeneratorUploadFrame = useCallback(() => {
    const frameId = pendingGeneratorUploadFrameIdRef.current
    if (frameId) {
      activeFrameIdRef.current = frameId
      lastFocusedFrameIdRef.current = frameId
    } else if (pendingGeneratorUploadResultRef.current?.elementId) {
      const selectedResult = pendingGeneratorUploadResultRef.current
      activeFrameIdRef.current = ''
      selectedGeneratedResultRef.current = selectedResult
      setActiveFrameId('')
      setSelectedGeneratedResult(selectedResult)
      setActiveFrameKind(selectedResult.kind)
    }
    return frameId
  }, [])

  const closeCanvasPicker = useCallback(() => {
    canvasPickerRef.current = null
    canvasPickerFrameIdRef.current = ''
    setCanvasPicker(null)
    setOpenMenu(null)
  }, [])

  useEffect(() => {
    if (!canvasPicker) return undefined
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeCanvasPicker()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [canvasPicker, closeCanvasPicker])

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
        isCanvasAttachableElement(element)
      )
      if (!selected) return false
      const asset = assetReferenceFromElement(selected, scene.files)
      if (!asset) return false
      if (['videoStartFrame', 'videoEndFrame', 'videoReferenceImages'].includes(picker.target) && asset.kind !== 'image') return false
      if (picker.target === 'imageReferences' && asset.kind !== 'image') return false
      if (picker.target === 'videoReferenceVideos' && asset.kind !== 'video') return false
      if (picker.target === 'videoReferenceAudios' && asset.kind !== 'audio') return false
      if (picker.target === 'subtitleScript' && asset.kind !== 'script') return false
      // SRT audio accepts audio files or videos (audio extraction happens server-side).
      if (picker.target === 'subtitleAudio' && asset.kind !== 'audio' && asset.kind !== 'video') return false
      if (picker.target === 'silenceCutVideo' && asset.kind !== 'video' && asset.kind !== 'xml') return false
      const restoreFrameId = picker.frameId || canvasPickerFrameIdRef.current || ''
      const applyPickedAsset = (pickedAsset) => {
        if (restoreFrameId) activeFrameIdRef.current = restoreFrameId
        addAssetToFrame(picker.target, pickedAsset, restoreFrameId || undefined, {
          selectedGeneratedResult: picker.selectedGeneratedResult || null
        })
        closeCanvasPicker()
        if (api && restoreFrameId) {
          window.setTimeout(() => {
            suppressNextChangeRef.current = true
            api.updateScene({
              appState: { selectedElementIds: { [restoreFrameId]: true } },
              captureUpdate: CaptureUpdateAction.NEVER
            })
          }, 0)
        }
      }
      if (picker.target === 'subtitleScript') {
        readTextAsset(asset)
          .then(applyPickedAsset)
          .catch((error) => {
            setGenerationError(error.message || '台本ファイルを読み込めません。')
            closeCanvasPicker()
          })
        return true
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
  }, [addAssetToFrame, api, closeCanvasPicker, readTextAsset, uploadAssetDataURL])

  const onImageUploadChange = useCallback(async (event) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (files.length === 0) return
    const uploadSelectedResult = pendingGeneratorUploadResultRef.current
    const uploadFrameId = restoreGeneratorUploadFrame() || activeFrameIdRef.current
    try {
      const assets = await Promise.all(
        files
          .filter((file) => file.type.startsWith('image/'))
          .map(uploadAssetFile)
      )
      addAssetToFrame('imageReferences', assets, uploadFrameId, {
        selectedGeneratedResult: uploadFrameId ? null : uploadSelectedResult
      })
    } catch (error) {
      setGenerationError(error.message)
    }
  }, [addAssetToFrame, restoreGeneratorUploadFrame, uploadAssetFile])

  const onVideoFrameUploadChange = useCallback(async (event) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (files.length === 0) return
    const target = videoFrameUploadTargetRef.current
    const expectedKind = getUploadTargetKind(target)
    // Pin the destination now: large files upload for a long time and the
    // user may click other frames meanwhile — the asset must still land here.
    const uploadSelectedResult = pendingGeneratorUploadResultRef.current
    const uploadFrameId = restoreGeneratorUploadFrame() || activeFrameIdRef.current
    setGenerationError('')
    try {
      const uploaded = await Promise.all(files.map(uploadAssetFile))
      const assets = uploaded.filter(
        (asset) =>
          asset.kind === expectedKind ||
          (target === 'subtitleAudio' && asset.kind === 'video') ||
          (target === 'silenceCutVideo' && /\.xml$/i.test(asset.name || asset.path || ''))
      )
      if (assets.length === 0) {
        // Files uploaded but none matched this slot — surface it instead of
        // silently doing nothing.
        const need = expectedKind === 'video' ? '動画' : expectedKind === 'audio' ? '音声' : '画像'
        setGenerationError(`この枠には${need}ファイルを追加してください。`)
        return
      }
      addAssetToFrame(target, assets, uploadFrameId, {
        selectedGeneratedResult: uploadFrameId ? null : uploadSelectedResult
      })
    } catch (error) {
      setGenerationError(error.message || 'アップロードに失敗しました。')
    }
  }, [addAssetToFrame, restoreGeneratorUploadFrame, uploadAssetFile])

  // Shared media inserter for both the toolbar media tool (#9) and drag-and-drop.
  // `atPoint` (scene coords) sets where placement starts; defaults to viewport center.
  const insertMediaFiles = useCallback(async (rawFiles, options = {}) => {
    const files = (rawFiles || []).filter((file) => file && isAttachableCanvasFile(file))
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
        const fileKind = getFileAssetKind(file)
        if (fileKind === 'image') {
          const dataURL = await fileToDataURL(file)
          const dimensions = await readImageDimensions(dataURL)
          const uploaded = await uploadAssetFile(file)
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
              codexAssetPath: uploaded.path,
              codexAssetUrl: uploaded.url,
              codexAssetMimeType: uploaded.mimeType || file.type || 'image/png',
              codexPixelWidth: dimensions.width,
              codexPixelHeight: dimensions.height
            }
          })
          nextElements.push(imageElement)
          insertedIds[imageElement.id] = true
          cursorX = bounds.x + bounds.width + 24
          cursorY = bounds.y
        } else if (fileKind === 'video') {
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
        } else if (fileKind === 'srt') {
          // Desktop parity: uploaded .srt files become real subtitle cards
          // (rendered by the SRT preview overlay), not generic attachments.
          const asset = await uploadAssetFile(file)
          const srtText = await file.text()
          const cueCount = srtText.split(/\r?\n\s*\r?\n/).filter((block) => /-->/.test(block)).length
          const bounds = findNonOverlappingPlacement(nextElements, {
            x: cursorX,
            y: cursorY,
            width: SUBTITLE_CARD_WIDTH,
            height: SUBTITLE_CARD_HEIGHT
          })
          const [rawCard] = convertToExcalidrawElements(
            [
              {
                type: 'rectangle',
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height,
                strokeColor: '#d9d9d9',
                backgroundColor: '#faf8ff',
                fillStyle: 'solid',
                strokeStyle: 'solid',
                strokeWidth: 1,
                roughness: 1,
                customData: {
                  codexGeneratedSubtitle: true,
                  codexMediaKind: 'subtitle',
                  codexFileName: asset.name,
                  codexAssetPath: asset.path,
                  codexAssetUrl: asset.url,
                  subtitleCueCount: cueCount
                }
              }
            ],
            { regenerateIds: true }
          )
          const cardElement = { ...rawCard, roundness: { type: 3 }, index: chooseElementIndex(nextElements) }
          nextElements.push(cardElement)
          insertedIds[cardElement.id] = true
          cursorX = bounds.x + bounds.width + 24
          cursorY = bounds.y
        } else {
          const asset = await uploadAssetFile(file)
          const previewDataURL = createAttachmentPreviewDataURL(asset)
          const bounds = findNonOverlappingPlacement(nextElements, {
            x: cursorX,
            y: cursorY,
            width: ATTACHMENT_CARD_WIDTH,
            height: ATTACHMENT_CARD_HEIGHT
          })
          const fileId = crypto.randomUUID()
          const fileRecord = {
            id: fileId,
            mimeType: 'image/svg+xml',
            dataURL: previewDataURL,
            created: Date.now(),
            lastRetrieved: Date.now()
          }
          filesForScene[fileId] = fileRecord
          liveFiles.push(fileRecord)
          const cardElement = createImageElementRecord({
            fileId,
            bounds,
            index: chooseElementIndex(nextElements),
            customData: {
              codexInsertedAttachment: true,
              codexMediaKind: asset.kind,
              codexFileName: asset.name,
              codexAssetPath: asset.path,
              codexAssetUrl: asset.url,
              codexAssetMimeType: asset.mimeType,
              codexAssetDuration: Number(asset.duration) || 0,
              codexPixelWidth: ATTACHMENT_CARD_WIDTH,
              codexPixelHeight: ATTACHMENT_CARD_HEIGHT
            }
          })
          nextElements.push(cardElement)
          insertedIds[cardElement.id] = true
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
            scheduleCanvasSave(uploadedScene)
          })
          .catch((error) => {
            console.error(error)
            if (task.objectURL && typeof URL !== 'undefined') URL.revokeObjectURL(task.objectURL)
          })
      }
    } catch (error) {
      setGenerationError(error.message)
    }
  }, [api, scheduleCanvasSave, scheduleSelectionSave, syncGeneratorUi, uploadAssetFile])

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
        return Array.from(items).some((it) => {
          if (it.kind !== 'file') return false
          const type = String(it.type || '').toLowerCase()
          return /^(image|video|audio)\//.test(type) || type === 'application/xml' || type === 'text/xml' || type === 'application/x-subrip' || type === 'text/plain' || type === 'text/markdown'
        })
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
      const files = Array.from(event.dataTransfer?.files || []).filter(isAttachableCanvasFile)
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
      // Always resolve collisions — repeated rail clicks used to stack frames
      // straight onto existing media because the check only ran after the
      // viewport moved.
      const placement = findNonOverlappingPlacement(elements, { x: frameX, y: frameY, width: size.width, height: size.height })
      frameX = placement.x
      frameY = placement.y
      const wasOverlapping = frameX !== originalFrameX || frameY !== originalFrameY

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
              [generatorFrameTagFor(kind)]: true,
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
      const targetScreenRatio = kind === 'video' || kind === 'silenceCut' ? 0.36 : kind === 'subtitle' ? 0.4 : 0.44
      const panelReserve = generatorPanelReserveFor(kind)
      const frameScreenYFor = (zoom) => {
        const displayHalf = (size.height * zoom) / 2
        return Math.max(
          GENERATOR_FRAME_TOP_RESERVE + displayHalf + 8,
          Math.min(viewportHeight * targetScreenRatio, Math.max(120, viewportHeight - panelReserve - displayHalf - 8))
        )
      }
      let nextScrollX = curScrollX
      let nextScrollY = curScrollY
      let nextZoom = curZoom
      let shouldAnimate = false
      let targetScrollX = curScrollX
      let targetScrollY = curScrollY
      let targetZoom = curZoom

      if (viewportWidth > 0 && viewportHeight > 0) {
        const frameCenterX = frameX + size.width / 2
        const frameCenterY = frameY + size.height / 2
        const targetScreenX = viewportWidth / 2
        if (viewportMoved) {
          // BuzzAssist behavior: after the user pans/zooms elsewhere, create
          // the frame in that current viewport and do not pull the camera back
          // onto it. Only a collision-driven relocation gets focus treatment.
          if (wasOverlapping) {
            targetZoom = fittedGeneratorZoom(
              kind,
              size,
              viewportWidth,
              viewportHeight,
              generatorCreateZoomFor(kind)
            )
            shouldAnimate = true
            const targetScreenY = frameScreenYFor(targetZoom)
            targetScrollX = targetScreenX / targetZoom - frameCenterX
            targetScrollY = targetScreenY / targetZoom - frameCenterY
          }
        } else {
          const frameTopScreen = (frameY + curScrollY) * curZoom
          const frameBottomScreen = (frameY + size.height + curScrollY) * curZoom
          if (frameBottomScreen + panelReserve > viewportHeight || frameTopScreen < GENERATOR_FRAME_TOP_RESERVE) {
            shouldAnimate = true
            targetZoom = fittedGeneratorZoom(kind, size, viewportWidth, viewportHeight, generatorCreateZoomFor(kind))
            const targetScreenY = frameScreenYFor(targetZoom)
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
          refreshOverlayStates(animatedScene)
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
      refreshOverlayStates(nextScene)
      scheduleCanvasSave(nextScene)
      scheduleSelectionSave(nextScene)
      return { frame: nextFrame, scene: nextScene }
    },
    [api, refreshOverlayStates, scheduleCanvasSave, scheduleSelectionSave]
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

  // BuzzAssist-billed generations require a login. The login endpoint opens
  // the browser auth window and blocks until sign-in completes, so pressing
  // generate while logged out flows straight into the auth screen and the
  // generation continues automatically after sign-in (BuzzAssist behavior).
  const ensureBuzzAssistLoggedIn = useCallback(async () => {
    try {
      const status = await (await canvasFetch('/api/buzzassist/auth-status')).json()
      if (status?.loggedIn) return true
    } catch {
      // status probe failed — fall through to the login flow
    }
    setGenerationError('BuzzAssistのログイン画面を開きました。ブラウザでサインインすると自動で続行します…')
    try {
      const response = await canvasFetch('/api/buzzassist/login', { method: 'POST' })
      const payload = await response.json().catch(() => ({}))
      if (response.ok && payload.ok) {
        setGenerationError('')
        return true
      }
      setGenerationError(payload.error || 'BuzzAssistのログインに失敗しました。')
    } catch (error) {
      setGenerationError(`BuzzAssistのログインに失敗しました: ${error.message}`)
    }
    return false
  }, [])

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
    const generationModel = kind === 'video' ? savedForm.videoModel : savedForm.imageModel
    const requiresBuzzAssist =
      [...(capabilities?.imageModels ?? []), ...(capabilities?.videoModels ?? [])].find(
        (entry) => entry.id === generationModel
      )?.requiresBuzzAssist === true
    if (requiresBuzzAssist && !(await ensureBuzzAssistLoggedIn())) return

    // Regenerating from a selected result works like the desktop app: keep the
    // original untouched and spawn a fresh generator frame (viewport center,
    // or stacked under the previous frame) that receives the new result.
    let generationAnchorId = anchorElementId
    let generationAnchorElement = anchorElement
    let retryFrameId = ''
    if (isRegeneratingResult) {
      const created = insertGeneratorFrame(kind, savedForm, { selectFrame: false, openPanel: false })
      if (!created?.frame) return
      retryFrameId = created.frame.id
      generationAnchorId = retryFrameId
      generationAnchorElement = created.frame
    }

    if (!isRegeneratingResult) updateActiveFrameElement(savedForm)
    setOpenMenu(null)
    setGenerationError('')
    setGeneratingFrameIds((current) => new Set(current).add(generationAnchorId))
    setPendingPanelFrame(null)
    setSelectedGeneratedResult(null)
    activeFrameIdRef.current = ''
    setActiveFrameId('')
    if (api) {
      window.setTimeout(() => {
        suppressNextChangeRef.current = true
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
              mode: normalizeVideoModeForContext(savedForm.videoModel, savedForm.videoTab, savedForm.videoMode),
              useReference: savedForm.videoTab === 'reference',
              useMotion: savedForm.videoTab === 'motion',
              startFramePath: savedForm.videoTab === 'reference' ? undefined : savedForm.videoStartFrame?.path || undefined,
              imageUrl: savedForm.videoTab === 'reference' || savedForm.videoStartFrame?.path ? undefined : savedForm.videoStartFrame?.dataURL || undefined,
              endFramePath: savedForm.videoTab === 'keyframe' ? savedForm.videoEndFrame?.path || undefined : undefined,
              endFrameDataURL: savedForm.videoTab === 'keyframe' && !savedForm.videoEndFrame?.path ? savedForm.videoEndFrame?.dataURL || undefined : undefined,
              referenceAudioPaths: savedForm.videoTab === 'reference' ? normalizeAssetList(savedForm.videoReferenceAudios).map((asset) => asset.path).filter(Boolean) : [],
              referenceImagePaths: savedForm.videoTab === 'reference' ? savedVideoReferenceImages.map((asset) => asset.path).filter(Boolean) : [],
              referenceImages: savedForm.videoTab === 'reference' ? savedVideoReferenceImages.map((asset) => asset.dataURL || asset.url).filter(Boolean) : [],
              referenceVideoPaths:
                savedForm.videoTab === 'reference'
                  ? savedVideoReferenceVideos.map((asset) => asset.path).filter(Boolean)
                  : savedForm.videoTab === 'motion' && savedForm.videoEndFrame?.path
                    ? [savedForm.videoEndFrame.path]
                    : [],
              referenceVideos: savedForm.videoTab === 'reference' ? savedVideoReferenceVideos.map((asset) => asset.dataURL || asset.url).filter(Boolean) : [],
              motionOrientation: savedForm.videoTab === 'motion' ? 'image' : undefined,
              generateAudio: savedForm.videoGenerateAudio !== false,
              selectCreated: true,
              anchorElementId: generationAnchorId,
              placement: 'replace',
              replaceAnchor: true,
              matchAnchor: true,
              displayWidth: generationAnchorElement.width,
              displayHeight: generationAnchorElement.height,
              customData: frameCustomDataFromForm(kind, savedForm)
            }
          : {
              prompt,
              // Lovart bills GPT Image 2 quality tiers as separate tools;
              // the quality setting picks the tier at submit time.
              model: generationModelFor(imageFamilyForModel(savedForm.imageModel), savedForm.imageModel, savedForm.quality),
              aspectRatio: savedForm.aspectRatio,
              quality: savedForm.quality,
              imageSize: savedForm.imageSize,
              referenceImagePaths: normalizeAssetList(savedForm.imageReferences)
                .filter((asset) => asset.kind === 'image')
                .map((asset) => asset.path)
                .filter(Boolean),
              referenceImages: normalizeAssetList(savedForm.imageReferences)
                .filter((asset) => asset.kind === 'image')
                .map((asset) => asset.dataURL || asset.url)
                .filter(Boolean),
              selectCreated: true,
              anchorElementId: generationAnchorId,
              placement: 'replace',
              replaceAnchor: true,
              matchAnchor: true,
              displayWidth: generationAnchorElement.width,
              displayHeight: generationAnchorElement.height,
              customData: frameCustomDataFromForm(kind, savedForm)
            }

      const response = await canvasFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.error) {
        throw new Error(payload.error || `Generation failed: ${response.status}`)
      }
      const canvasResponse = await canvasFetch(CANVAS_ENDPOINT)
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
          // Desktop parity: a failed retry removes the freshly created frame
          // and re-selects the original result.
          if (retryFrameId) {
            nextElements = currentElements.map((element) =>
              element.id === retryFrameId ? { ...element, isDeleted: true } : element
            )
          }
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
        window.setTimeout(() => {
          suppressNextChangeRef.current = true
          api.updateScene({
            elements: nextElements,
            appState: { selectedElementIds },
            captureUpdate: CaptureUpdateAction.NEVER
          })
        }, 0)
        const errorScene = createScene(nextElements, { ...api.getAppState(), selectedElementIds }, api.getFiles())
        latestSceneRef.current = errorScene
        refreshOverlayStates(errorScene)
        scheduleCanvasSave(errorScene)
        scheduleSelectionSave(errorScene)
      }
    } finally {
      setGeneratingFrameIds((current) => {
        const next = new Set(current)
        next.delete(generationAnchorId)
        return next
      })
    }
  }, [api, applyRemoteScene, capabilities, ensureBuzzAssistLoggedIn, frameForm, generatingFrameIds, insertGeneratorFrame, refreshOverlayStates, saveCanvas, scheduleCanvasSave, scheduleSelectionSave, selectedGeneratedResult, updateActiveFrameElement])

  // Generation for utility frames. SRT replaces the frame with an SRT card;
  // silence cut keeps the frame selected and downloads a Premiere XML.
  const runUtilityGeneration = useCallback(async () => {
    if (!api) return
    const anchorElementId = activeFrameIdRef.current
    if (!anchorElementId || generatingFrameIds.has(anchorElementId)) return
    const scene = latestSceneRef.current
    const anchorElement = scene.elements.find((element) => element.id === anchorElementId)
    if (!anchorElement || !isGeneratorFrame(anchorElement)) return
    const kind = getGeneratorKind(anchorElement)
    if (kind !== 'subtitle' && kind !== 'silenceCut') return

    const savedForm = { ...frameForm }
    if (kind === 'subtitle') {
      if (!savedForm.subtitleAudio?.path) {
        setGenerationError('音声を添付してください。')
        return
      }
      if (savedForm.subtitleMode === 'scripted' && !savedForm.subtitleScriptText.trim()) {
        setGenerationError('台本ファイルを添付してください。')
        return
      }
    } else if (!savedForm.silenceCutVideo?.path) {
      setGenerationError('Premiere XMLまたは動画を添付してください。')
      return
    }

    const needsCloud = kind === 'subtitle' || savedForm.silenceCutModel === 'elevenlabs-scribe-v2'
    if (needsCloud && !(await ensureBuzzAssistLoggedIn())) return

    updateActiveFrameElement(savedForm)
    setOpenMenu(null)
    setGenerationError('')
    setSilenceCutNotice('')
    setGeneratingFrameIds((current) => new Set(current).add(anchorElementId))
    setPendingPanelFrame(null)
    setSelectedGeneratedResult(null)
    activeFrameIdRef.current = anchorElementId
    lastFocusedFrameIdRef.current = anchorElementId
    setActiveFrameId(anchorElementId)
    setActiveFrameKind(kind)

    try {
      await saveCanvas(latestSceneRef.current)
      const endpoint = kind === 'subtitle' ? GENERATE_SUBTITLES_ENDPOINT : SILENCE_CUT_ENDPOINT
      const body =
        kind === 'subtitle'
          ? {
              audioPath: savedForm.subtitleAudio.path,
              scriptText: savedForm.subtitleMode === 'scripted' ? savedForm.subtitleScriptText : '',
              instructionPrompt: savedForm.subtitlePrompt.trim() || undefined,
              mode: savedForm.subtitleMode,
              lineCount: savedForm.subtitleLineCount,
              maxCharsPerLine: savedForm.subtitleMaxChars,
              holdSeconds: savedForm.subtitleHoldSeconds,
              punctuationMode: savedForm.subtitlePunctuationMode,
              fillerMode: savedForm.subtitleFillerMode,
              durationSeconds: Number(savedForm.subtitleAudio.duration) || undefined,
              anchorElementId,
              placement: 'replace',
              replaceAnchor: true
            }
          : {
              videoPath: savedForm.silenceCutVideo.path,
              model: savedForm.silenceCutModel,
              instructionPrompt: savedForm.silenceCutInstruction.trim() || undefined,
              fillerRemoval: savedForm.silenceCutModel === 'elevenlabs-scribe-v2' ? savedForm.silenceCutFillerRemoval : 0,
              coughRemoval: savedForm.silenceCutModel === 'elevenlabs-scribe-v2' ? savedForm.silenceCutCoughRemoval : 0,
              retakeRemoval: savedForm.silenceCutModel === 'elevenlabs-scribe-v2' ? savedForm.silenceCutRetakeRemoval : 0,
              detectSeconds: savedForm.silenceCutDetectSeconds,
              thresholdDb: savedForm.silenceCutThresholdAuto ? 'auto' : savedForm.silenceCutThresholdDb,
              keepSeconds: savedForm.silenceCutKeepSeconds,
              preMarginSeconds: savedForm.silenceCutPreMarginSeconds,
              postMarginSeconds: savedForm.silenceCutPostMarginSeconds
            }

      const response = await canvasFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.error) {
        throw new Error(payload.error || `Generation failed: ${response.status}`)
      }
      if (kind === 'silenceCut') {
        // The jet-cut Premiere XML is saved under canvas/assets — no canvas
        // element. Keep the generator frame (settings survive for re-runs),
        // surface the stats, and hand the file to the browser.
        const formatClock = (seconds) => {
          const total = Math.max(0, Math.round(Number(seconds) || 0))
          return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
        }
        const outputAsset = {
          id: crypto.randomUUID(),
          name: payload.fileName || 'jetcut.xml',
          kind: 'xml',
          mimeType: 'application/xml',
          path: payload.assetPath || '',
          url: payload.assetUrl || '',
          dataURL: '',
          thumbnail: '',
          duration: 0
        }
        const nextForm = { ...savedForm, silenceCutOutput: outputAsset }
        const currentElements = api.getSceneElementsIncludingDeleted()
        const nextElements = currentElements.map((element) =>
          element.id === anchorElementId
            ? {
                ...element,
                customData: {
                  ...(element.customData ?? {}),
                  ...frameCustomDataFromForm(kind, nextForm)
                },
                version: (Number(element.version) || 1) + 1,
                versionNonce: Math.floor(Math.random() * 2 ** 31),
                updated: Date.now()
              }
            : element
        )
        const appState = {
          ...(api.getAppState?.() ?? latestSceneRef.current.appState),
          selectedElementIds: { [anchorElementId]: true }
        }
        const nextScene = createScene(nextElements, appState, api.getFiles())
        latestSceneRef.current = nextScene
        suppressNextChangeRef.current = true
        api.updateScene({
          elements: nextElements,
          appState: { selectedElementIds: { [anchorElementId]: true } },
          captureUpdate: CaptureUpdateAction.IMMEDIATELY
        })
        refreshOverlayStates(nextScene)
        scheduleCanvasSave(nextScene)
        scheduleSelectionSave(nextScene)
        setSilenceCutNotice(
          `${formatClock(payload.inputDuration)} → ${formatClock(payload.outputDuration)}（−${formatClock(payload.cutDuration)}・${payload.cutCount}箇所）${payload.fileName} を書き出しました`
        )
        triggerAssetDownload(payload.assetUrl, payload.fileName || 'jetcut.xml')
        activeFrameIdRef.current = anchorElementId
        lastFocusedFrameIdRef.current = anchorElementId
        setActiveFrameId(anchorElementId)
        setActiveFrameKind(kind)
        setFrameForm(nextForm)
        return
      }
      const canvasResponse = await canvasFetch(CANVAS_ENDPOINT)
      if (canvasResponse.ok) {
        const canvasPayload = await canvasResponse.json()
        let nextScene = normalizeScene(canvasPayload.scene)
        // The subtitle/silence-cut endpoints do not forward replaceAnchor, so
        // the generator frame survives underneath the result. Delete it here
        // and persist, completing the frame → result replacement.
        if (!payload.replacedAnchor && nextScene.elements.some((element) => element.id === anchorElementId && isGeneratorFrame(element))) {
          nextScene = {
            ...nextScene,
            elements: nextScene.elements.map((element) =>
              element.id === anchorElementId
                ? {
                    ...element,
                    isDeleted: true,
                    version: (Number(element.version) || 1) + 1,
                    versionNonce: Math.floor(Math.random() * 2 ** 31),
                    updated: Date.now()
                  }
                : element
            )
          }
          applyRemoteScene(nextScene, { force: true, applySelection: true })
          await saveCanvas(latestSceneRef.current)
        } else {
          applyRemoteScene(nextScene, { force: true, applySelection: true })
        }
      }
    } catch (error) {
      setGenerationError(error.message)
      const selectedElementIds = { [anchorElementId]: true }
      activeFrameIdRef.current = anchorElementId
      lastFocusedFrameIdRef.current = anchorElementId
      setActiveFrameId(anchorElementId)
      setActiveFrameKind(kind)
      setSelectedGeneratedResult(null)
      setFrameForm(savedForm)
      window.setTimeout(() => {
        suppressNextChangeRef.current = true
        api.updateScene({
          appState: { selectedElementIds },
          captureUpdate: CaptureUpdateAction.NEVER
        })
      }, 0)
      const errorScene = createScene(
        api.getSceneElementsIncludingDeleted(),
        { ...api.getAppState(), selectedElementIds },
        api.getFiles()
      )
      latestSceneRef.current = errorScene
      refreshOverlayStates(errorScene)
      scheduleCanvasSave(errorScene)
      scheduleSelectionSave(errorScene)
    } finally {
      setGeneratingFrameIds((current) => {
        const next = new Set(current)
        next.delete(anchorElementId)
        return next
      })
    }
  }, [api, applyRemoteScene, ensureBuzzAssistLoggedIn, frameForm, generatingFrameIds, refreshOverlayStates, saveCanvas, scheduleCanvasSave, scheduleSelectionSave, updateActiveFrameElement])

  // Wheel over a subtitle result card scrolls its SRT preview instead of
  // panning the canvas (Youtube-AGI parity). The overlay itself is
  // pointer-events none, so the wheel lands on the Excalidraw canvas and is
  // intercepted here by viewport-rect hit test.
  useEffect(() => {
    if (!api) return undefined
    const root = document.querySelector('.excalidraw')
    if (!root) return undefined
    const onWheel = (event) => {
      if (event.ctrlKey || event.metaKey) return
      const overlays = subtitlePreviewOverlaysRef.current
      if (!overlays || overlays.length === 0) return
      const rootRect = root.getBoundingClientRect()
      const pointX = event.clientX - rootRect.left
      const pointY = event.clientY - rootRect.top
      const hit = [...overlays].reverse().find((overlay) =>
        pointX >= overlay.left && pointX <= overlay.left + overlay.width &&
        pointY >= overlay.top && pointY <= overlay.top + overlay.height
      )
      if (!hit) return
      const lines = srtLinesCache.get(hit.assetUrl)
      if (!lines) return
      const layout = getSubtitlePreviewLayout(lines.length, hit.width, hit.height, hit.zoom, hit.isSelected)
      if (layout.maxScroll <= 0) return
      event.preventDefault()
      event.stopPropagation()
      if (typeof event.stopImmediatePropagation === 'function') {
        event.stopImmediatePropagation()
      }
      const deltaUnit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? hit.height * 0.85 : 1
      const delta = (event.deltaY || event.deltaX) * deltaUnit
      if (!Number.isFinite(delta) || delta === 0) return
      setSubtitleScrollOffsets((prev) => {
        const current = Number(prev[hit.id]) || 0
        const nextValue = Math.max(0, Math.min(layout.maxScroll, current + delta))
        if (Math.abs(nextValue - current) < 0.5) return prev
        return { ...prev, [hit.id]: nextValue }
      })
    }
    root.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => {
      root.removeEventListener('wheel', onWheel, { capture: true })
    }
  }, [api])

  if (!initialScene) {
    return <main className="codex-excalidraw-status">Loading canvas...</main>
  }

  if (loadError) {
    return <main className="codex-excalidraw-status">Canvas file could not be loaded.</main>
  }

  const livePanelTarget = buildPanelTargetFromScene(latestSceneRef.current, activeFrameId, selectedGeneratedResult)
  const activeOverlay = frameOverlays.find((overlay) => overlay.id === activeFrameId)
  const isCurrentFrameGenerating = activeFrameId ? generatingFrameIds.has(activeFrameId) : false
  const activePanelTarget = livePanelTarget ?? activeOverlay ?? selectedGeneratedResult
  const showPromptPanel = Boolean(activePanelTarget && !isCurrentFrameGenerating)
  // One canonical entry per model; the execution route (Codex / Hermes /
  // BuzzAssist / Lovart) is chosen per model in the settings row and mapped
  // to the concrete backend id stored in frameForm.
  const activeImageFamily = imageFamilyForModel(frameForm.imageModel) ?? IMAGE_MODEL_FAMILIES[0]
  const activeVideoFamily = videoFamilyForModel(frameForm.videoModel) ?? VIDEO_MODEL_FAMILIES[0]
  const activeMediaFamily = activeFrameKind === 'video' ? activeVideoFamily : activeImageFamily
  const activeMediaRouteId = activeFrameKind === 'video'
    ? routeIdForModel(activeVideoFamily, frameForm.videoModel) ?? defaultRouteIdFor(activeVideoFamily)
    : routeIdForModel(activeImageFamily, frameForm.imageModel) ?? defaultRouteIdFor(activeImageFamily)
  const imageModelLabel = activeImageFamily?.label ?? frameForm.imageModel
  const videoModelLabel = activeVideoFamily?.label ?? frameForm.videoModel

  const applyMediaModelSelection = (kind, concreteId) => {
    if (!concreteId) return
    if (kind === 'video') {
      // Youtube-AGI normalizes every dependent setting when the model changes.
      const nextTab = normalizeVideoTabForModel(concreteId, frameForm.videoTab)
      patchFrameForm({
        videoModel: concreteId,
        videoTab: nextTab,
        videoMode: normalizeVideoModeForContext(concreteId, nextTab, frameForm.videoMode),
        duration: normalizeVideoDurationForModel(concreteId, frameForm.duration),
        videoAspectRatio: normalizeVideoAspectRatioForModel(concreteId, frameForm.videoAspectRatio)
      })
    } else {
      patchFrameForm({
        imageModel: concreteId,
        aspectRatio: getAvailableImageAspectRatios(concreteId).includes(frameForm.aspectRatio) ? frameForm.aspectRatio : '1:1',
        quality: getImageQualityOptions(concreteId).some(([value]) => value === frameForm.quality) ? frameForm.quality : 'auto',
        imageSize: getAvailableImageSizes(concreteId).includes(frameForm.imageSize) ? frameForm.imageSize : getAvailableImageSizes(concreteId)[0]
      })
    }
  }
  // Pre-generation credit estimate for the ⚡ button (BuzzAssist rate card).
  // Local routes cost 0; Lovart rates are unknown → null hides the number.
  const activePanelCreditEstimate = (() => {
    try {
      if (activeFrameKind === 'image') {
        const model = frameForm.imageModel
        // Lovart consumes Lovart-side credits, not BuzzAssist credits → 0 here.
        if (String(model).startsWith('lovart-')) return 0
        if (model === 'gpt-image-2-codex') return 0
        return estimateCreditsForJob({
          kind: 'image',
          model,
          prompt: frameForm.prompt,
          imageSize: frameForm.imageSize,
          aspectRatio: frameForm.aspectRatio,
          quality: frameForm.quality,
          referenceImageCount: normalizeAssetList(frameForm.imageReferences).length
        }).credits
      }
      if (activeFrameKind === 'video') {
        const model = frameForm.videoModel
        if (String(model).startsWith('lovart-')) return 0
        if (model === 'grok-imagine-video-hermes') return 0
        return estimateCreditsForJob({
          kind: 'video',
          model,
          mode: normalizeVideoModeForContext(model, frameForm.videoTab, frameForm.videoMode),
          tab: frameForm.videoTab,
          duration: Number(frameForm.duration) || 5,
          aspectRatio: frameForm.videoAspectRatio,
          resolution: frameForm.resolution,
          hasStartImage: Boolean(frameForm.videoStartFrame),
          referenceImageCount: normalizeAssetList(frameForm.videoReferenceImages).length,
          hasReferenceVideo: normalizeAssetList(frameForm.videoReferenceVideos).length > 0 || Boolean(frameForm.videoEndFrame),
          generateAudio: supportsGenerateAudio(model) ? frameForm.videoGenerateAudio : false
        }).credits
      }
      if (activeFrameKind === 'subtitle') {
        const seconds = Number(frameForm.subtitleAudio?.duration) || 0
        if (!seconds) return null
        return estimateCreditsForJob({ kind: 'subtitle', model: 'elevenlabs-scribe-v2', durationSeconds: seconds }).credits
      }
      if (activeFrameKind === 'silenceCut') {
        if (frameForm.silenceCutModel !== 'elevenlabs-scribe-v2') return 0
        const seconds = Number(frameForm.silenceCutVideo?.duration) || 0
        if (!seconds) return null
        return estimateCreditsForJob({ kind: 'subtitle', model: 'elevenlabs-scribe-v2', durationSeconds: seconds }).credits
      }
    } catch {
      return null
    }
    return null
  })()
  const lovartReferences = normalizeAssetList(frameForm.lovartReferences)
  const imageReferences = normalizeAssetList(frameForm.imageReferences)
  const videoReferenceImages = normalizeAssetList(frameForm.videoReferenceImages)
  const videoReferenceVideos = normalizeAssetList(frameForm.videoReferenceVideos)
  const videoReferenceAudios = normalizeAssetList(frameForm.videoReferenceAudios)
  const videoFrameMenuOpen = openMenu && (
    openMenu === 'videoStartFrame' ||
    openMenu === 'videoEndFrame' ||
    openMenu === 'videoReferenceImages' ||
    openMenu === 'videoReferenceVideos'
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
  const isUtilityPanelKind = activeFrameKind === 'subtitle' || activeFrameKind === 'silenceCut'
  const panelPlacement = showPromptPanel
    ? getPanelPlacementFromViewportTarget(activePanelTarget, activeFrameKind)
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
      className={`codex-excalidraw-shell lovart-ai-root${showPromptPanel || managedSelectionActive ? ' hide-generator-props' : ''}`}
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
          <button
            type="button"
            className="lovart-ai-button"
            aria-label="無音カットジェネレーター"
            data-lovart-tooltip="無音カットジェネレーター"
            data-lovart-generator-kind="silenceCut"
            onPointerDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              createGeneratorFrame('silenceCut')
            }}
          >
            <SilenceCutGeneratorToolIcon />
          </button>
          <button
            type="button"
            className="lovart-ai-button"
            aria-label="SRTジェネレーター"
            data-lovart-tooltip="SRTジェネレーター"
            data-lovart-generator-kind="subtitle"
            onPointerDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              createGeneratorFrame('subtitle')
            }}
          >
            <SrtGeneratorToolIcon />
          </button>
        </div>
      ) : null}

      {frameOverlays.map((overlay) => {
        const isGenerating = generatingFrameIds.has(overlay.id) || overlay.remoteGenerating
        const isVideo = overlay.kind === 'video'
        const isUtilityFrame = overlay.kind === 'subtitle' || overlay.kind === 'silenceCut'
        const overlayTitle =
          overlay.kind === 'video'
            ? 'Video Generator'
            : overlay.kind === 'subtitle'
              ? 'SRT Generator'
              : overlay.kind === 'silenceCut'
                ? 'Silence Cut Generator'
                : overlay.kind === 'lovart'
                  ? 'Lovart Generator'
                  : 'Image Generator'
        const overlayMetrics = getFrameOverlayMetrics(overlay.width, overlay.height)
        const showFrameHeader = overlayMetrics.showHeader
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
            {showFrameHeader ? (
              <div
                className="lovart-frame-header"
                style={{ top: `-${overlayMetrics.headerOffset}px`, fontSize: `${overlayMetrics.headerFontSize}px` }}
              >
                <div className="lovart-frame-title">
                  {overlayMetrics.showTitleIcon ? <span>▣</span> : null}
                  <span className="lovart-frame-title-text">{overlayTitle}</span>
                </div>
                {overlayMetrics.showSize && !isUtilityFrame ? <div className="lovart-frame-size">{overlay.pixelWidth} x {overlay.pixelHeight}</div> : null}
              </div>
            ) : null}
            <div className="lovart-frame-inner">
              {isGenerating ? <div className={`lovart-frame-generating-bg${isVideo ? ' video' : ''}`} /> : null}
              <div className="lovart-frame-center">
                {overlay.kind === 'subtitle' ? (
                  <SrtCenterIcon size={overlayMetrics.iconSize} />
                ) : overlay.kind === 'silenceCut' ? (
                  <SilenceCutCenterIcon size={overlayMetrics.iconSize} />
                ) : overlay.kind === 'lovart' ? (
                  <span style={{ width: overlayMetrics.iconSize, height: overlayMetrics.iconSize, display: 'inline-flex', color: '#b89de0' }}>
                    <LovartGeneratorToolIcon />
                  </span>
                ) : isVideo ? (
                  <VideoCenterIcon size={overlayMetrics.iconSize} />
                ) : (
                  <FrameCenterIcon size={overlayMetrics.iconSize} />
                )}
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

      {subtitlePreviewOverlays.map((overlay) => (
        <SubtitleCanvasOverlay key={overlay.id} overlay={overlay} scrollOffset={subtitleScrollOffsets[overlay.id] || 0} />
      ))}

      {selectedImageOverlays.map((img) => {
        const { headerFontSize, headerOffset } = getMediaHeaderMetrics(img.width)
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

      {showPromptPanel && !isUtilityPanelKind ? (
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
          onPointerDown={(event) => {
            event.stopPropagation()
            // Clicking anywhere in the panel outside a pill/menu (prompt
            // textarea, slots, tabs) closes the open settings menu.
            if (event.target instanceof Element && !event.target.closest('.lovart-menu-wrap')) setOpenMenu(null)
          }}
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
                      <FileUploadLabel
                        className="lovart-upload-label"
                        accept={getUploadTargetAccept(target)}
                        multiple={frameForm.videoTab === 'reference'}
                        onOpen={() => {
                          rememberGeneratorUploadFrame()
                          videoFrameUploadTargetRef.current = target
                        }}
                        onChange={(event) => { setOpenMenu(null); onVideoFrameUploadChange(event) }}
                      >
                        <UploadIcon />
                        <span>{getVideoFrameUploadLabel(frameForm.videoTab, slotTarget)}</span>
                      </FileUploadLabel>
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
                        <FileUploadLabel
                          className="lovart-add-frame-btn audio"
                          title="音声"
                          accept={getUploadTargetAccept('videoReferenceAudios')}
                          multiple
                          onOpen={() => {
                            setVideoFrameBtnsHovered(true)
                            rememberGeneratorUploadFrame()
                            videoFrameUploadTargetRef.current = 'videoReferenceAudios'
                          }}
                          onChange={(event) => { setOpenMenu(null); onVideoFrameUploadChange(event) }}
                        >
                          <span className="lovart-add-plus">+</span>
                          <span className="lovart-add-label">音声</span>
                        </FileUploadLabel>
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
                  {getAvailableVideoTabs(frameForm.videoModel).map((tab) => {
                    const tabDisabled = isVideoTabDisabledForModel(frameForm.videoModel, tab)
                    return (
                      <button
                        type="button"
                        key={tab}
                        disabled={tabDisabled}
                        className={[
                          frameForm.videoTab === tab && !tabDisabled ? 'is-selected' : '',
                          tabDisabled ? 'is-disabled' : ''
                        ].filter(Boolean).join(' ')}
                        onClick={() => {
                          if (tabDisabled) return
                          setOpenMenu(null)
                          patchFrameForm({
                            videoTab: tab,
                            videoMode: normalizeVideoModeForContext(frameForm.videoModel, tab, frameForm.videoMode)
                          })
                        }}
                      >
                        {tab === 'keyframe' ? 'キーフレーム' : tab === 'motion' ? 'モーション' : 'リファレンス'}
                      </button>
                    )
                  })}
                </div>
              ) : null}
              <div className="lovart-menu-wrap">
                <button
                  type="button"
                  className={`lovart-pill${openMenu === 'model' ? ' tooltip-hidden' : ''}`}
                  onClick={() => setOpenMenu((current) => (current === 'model' ? null : 'model'))}
                >
                  {activeMediaFamily ? (
                    <span className="lovart-model-icon"><ModelProviderIcon provider={activeMediaFamily.provider} /></span>
                  ) : null}
                  <span>{activeFrameKind === 'video' ? videoModelLabel : imageModelLabel}</span>
                  <ChevronIcon />
                </button>
                {openMenu === 'model' ? (
                  <div className="lovart-menu lovart-model-menu" data-lovart-menu="model">
                    <div className="lovart-menu-header">モデル</div>
                    {(activeFrameKind === 'video' ? VIDEO_MODEL_FAMILIES : IMAGE_MODEL_FAMILIES).map((family) => (
                      <button
                        type="button"
                        key={family.id}
                        onClick={() => {
                          // Keep the current route when the target family
                          // supports it; otherwise fall back to its default.
                          applyMediaModelSelection(activeFrameKind, concreteModelFor(family, activeMediaRouteId))
                          setOpenMenu(null)
                        }}
                      >
                        <span className="lovart-model-icon"><ModelProviderIcon provider={family.provider} /></span>
                        <span>{family.label}</span>
                        {activeMediaFamily?.id === family.id ? <span className="menu-check">✓</span> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="lovart-menu-wrap">
                <button
                  type="button"
                  className={`lovart-pill${openMenu === 'route' ? ' tooltip-hidden' : ''}`}
                  data-lovart-tooltip="実行先"
                  onClick={() => {
                    setOpenMenu((current) => (current === 'route' ? null : 'route'))
                    setLovartKeyEditing(false)
                    canvasFetch('/api/lovart/auth-status')
                      .then((response) => response.json())
                      .then(setLovartAuth)
                      .catch(() => {})
                    canvasFetch('/api/hermes/status')
                      .then((response) => response.json())
                      .then(setHermesStatus)
                      .catch(() => {})
                  }}
                >
                  <span className="lovart-model-icon">
                    <ModelProviderIcon provider={MEDIA_ROUTES.find((route) => route.id === activeMediaRouteId)?.icon ?? 'codex'} />
                  </span>
                  <span>{MEDIA_ROUTES.find((route) => route.id === activeMediaRouteId)?.label ?? activeMediaRouteId}</span>
                  <ChevronIcon />
                </button>
                {openMenu === 'route' ? (
                  <div className="lovart-menu" data-lovart-menu="route">
                    <div className="lovart-menu-header">実行先</div>
                    {MEDIA_ROUTES.filter((route) => activeMediaFamily?.routes?.[route.id]).map((route) => (
                      <button
                        type="button"
                        key={route.id}
                        onClick={() => {
                          applyMediaModelSelection(activeFrameKind, activeMediaFamily.routes[route.id])
                          setOpenMenu(null)
                        }}
                      >
                        <span className="lovart-model-icon"><ModelProviderIcon provider={route.icon} /></span>
                        <span>{route.label}</span>
                        <span className="lovart-route-note">{route.note}</span>
                        <span className="menu-check lovart-route-check">{activeMediaRouteId === route.id ? '✓' : ''}</span>
                      </button>
                    ))}
                    {/* Lovart keys are account-level config — always reachable
                        from the route menu, whatever model is selected. */}
                    <div className="lovart-key-form">
                        <div className="lovart-key-head">
                          <span className="lovart-key-title">Lovart APIキー</span>
                          {lovartAuth?.configured ? (
                            <button
                              type="button"
                              className="lovart-key-edit"
                              onClick={() => setLovartKeyEditing((current) => !current)}
                            >
                              {lovartKeyEditing ? '閉じる' : '変更'}
                            </button>
                          ) : null}
                        </div>
                        <div className="lovart-key-substatus">
                          {lovartAuth === null
                            ? '確認中...'
                            : lovartAuth?.configured
                            ? `接続済み: ${lovartAuth.accessKeyPreview ?? ''}`
                            : '未設定（OpenClaw の ak_/sk_ を入力）'}
                        </div>
                        {lovartAuth !== null && (!lovartAuth?.configured || lovartKeyEditing) ? (
                          <>
                            <input ref={lovartAccessKeyInputRef} type="password" placeholder="ak_..." autoComplete="off" />
                            <input ref={lovartSecretKeyInputRef} type="password" placeholder="sk_..." autoComplete="off" />
                            <button
                              type="button"
                              className="lovart-key-save"
                              disabled={lovartKeySaving}
                              onClick={async () => {
                                const accessKey = lovartAccessKeyInputRef.current?.value?.trim()
                                const secretKey = lovartSecretKeyInputRef.current?.value?.trim()
                                if (!accessKey || !secretKey) {
                                  setGenerationError('Lovart の Access Key と Secret Key を両方入力してください。')
                                  return
                                }
                                setLovartKeySaving(true)
                                try {
                                  const response = await canvasFetch('/api/lovart/credentials', {
                                    method: 'POST',
                                    headers: { 'content-type': 'application/json' },
                                    body: JSON.stringify({ accessKey, secretKey })
                                  })
                                  const payload = await response.json()
                                  if (!response.ok) throw new Error(payload.error || '保存に失敗しました')
                                  setLovartAuth(payload)
                                  setGenerationError('')
                                  setLovartKeyEditing(false)
                                  if (lovartAccessKeyInputRef.current) lovartAccessKeyInputRef.current.value = ''
                                  if (lovartSecretKeyInputRef.current) lovartSecretKeyInputRef.current.value = ''
                                } catch (error) {
                                  setGenerationError(error.message)
                                } finally {
                                  setLovartKeySaving(false)
                                }
                              }}
                            >
                              {lovartKeySaving ? '保存中…' : '保存'}
                            </button>
                          </>
                        ) : null}
                    </div>
                    {(activeMediaFamily?.routes?.hermes && hermesStatus && (!hermesStatus.installed || hermesStatus.session === 'logged-out')) ? (
                      <div className="lovart-key-form">
                        <div className="lovart-key-status">
                          {hermesStatus.installed
                            ? 'Hermes は未ログインです（X の OAuth が必要）'
                            : 'Hermes Agent が未インストールです'}
                        </div>
                        <div className="lovart-key-send-row">
                          {[['claude', 'Claude Code に依頼'], ['codex', 'Codex に依頼']].map(([app, label]) => (
                            <button
                              type="button"
                              key={app}
                              className="lovart-key-save"
                              onClick={() => {
                                sendToChatApp({
                                  app,
                                  autoSend: true,
                                  text: 'Hermes Agent で Grok Imagine を使えるようにセットアップして。excalidraw MCP の setup_hermes_grok ツールを実行して、必要なら hermes auth add xai-oauth のブラウザOAuthを完了させて。'
                                })
                              }}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <div className="lovart-key-hint">
                          {chatSendStatus === 'sent'
                            ? '送信しました — チャット側でセットアップが始まります'
                            : chatSendStatus === 'attached'
                              ? 'チャットに依頼を添付しました — Enterで送信してください'
                              : chatSendStatus === 'copied' || chatSendStatus === 'copied-fallback'
                                ? '依頼文をコピーしました — チャットに⌘Vで貼り付けて送信してください'
                                : chatSendStatus === 'sending'
                                  ? '送信中…'
                                  : 'ワンクリックでチャットに依頼を送って setup_hermes_grok を実行させます'}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {activeFrameKind !== 'video' ? (
                <div className="lovart-menu-wrap">
                  <button
                    type="button"
                    data-lovart-trigger="asset"
                    className={`lovart-pill${openMenu === 'asset' ? ' tooltip-hidden' : ''}`}
                    data-lovart-tooltip="画像参照"
                    onClick={() => setOpenMenu((current) => (current === 'asset' ? null : 'asset'))}
                  >
                      <PhotoIcon />
                  </button>
                  {openMenu === 'asset' ? (
                    <div className="lovart-menu" data-lovart-menu="asset">
                      <FileUploadLabel
                        className="lovart-upload-label"
                        accept="image/*"
                        multiple
                        onOpen={rememberGeneratorUploadFrame}
                        onChange={(event) => { setOpenMenu(null); onImageUploadChange(event) }}
                      >
                        <UploadIcon />
                        <span>画像をアップロード</span>
                      </FileUploadLabel>
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
                  {usesImageQualitySelection(frameForm.imageModel) || getAvailableImageSizes(frameForm.imageModel).length > 1 ? (
                  <div className="lovart-menu-wrap">
                    <button
                      type="button"
                      className="lovart-pill"
                      onClick={() => setOpenMenu((current) => (current === 'quality' ? null : 'quality'))}
                    >
                      <span>
                        {usesImageQualitySelection(frameForm.imageModel)
                          ? getImageQualityOptions(frameForm.imageModel).find(([value]) => value === frameForm.quality)?.[1] ?? 'Auto'
                          : frameForm.imageSize ?? '1K'}
                        {isGrokImageModel(frameForm.imageModel) ? `・${frameForm.imageSize ?? '1K'}` : ''}
                      </span>
                      <ChevronIcon />
                    </button>
                    {openMenu === 'quality' ? (
                      <div className="lovart-menu" data-lovart-menu="quality">
                        {usesImageQualitySelection(frameForm.imageModel) ? (
                          <>
                            <div className="lovart-menu-header">品質</div>
                            {getImageQualityOptions(frameForm.imageModel).map(([value, label]) => (
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
                          </>
                        ) : null}
                        {getAvailableImageSizes(frameForm.imageModel).length > 1 ? (
                          <>
                            <div className="lovart-menu-header">サイズ</div>
                            {getAvailableImageSizes(frameForm.imageModel).map((size) => (
                              <button
                                type="button"
                                key={size}
                                onClick={() => {
                                  updateFrameForm('imageSize', size)
                                  setOpenMenu(null)
                                }}
                              >
                                <span>{size}</span>
                                {(frameForm.imageSize ?? '1K') === size ? <span className="menu-check">✓</span> : null}
                              </button>
                            ))}
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  ) : null}
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
                        {getAvailableImageAspectRatios(frameForm.imageModel)
                          .map((ratio) => [ratio, IMAGE_ASPECTS[ratio] ?? GROK_IMAGE_ASPECT_RATIO_OPTIONS[ratio]])
                          .map(([ratio, size]) => (
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
              ) : activeFrameKind === 'video' ? (
                <div className="lovart-menu-wrap">
                  <button
                    type="button"
                    className="lovart-pill"
                    data-lovart-trigger="video-settings"
                    onClick={() => setOpenMenu((current) => (current === 'video-settings' ? null : 'video-settings'))}
                  >
                    <span>
                      {(() => {
                        const modes = getAvailableVideoModes(frameForm.videoModel, frameForm.videoTab)
                        const activeMode = normalizeVideoModeForContext(frameForm.videoModel, frameForm.videoTab, frameForm.videoMode)
                        const modePrefix = modes.length > 0
                          ? `${VIDEO_MODE_OPTIONS.find(([value]) => value === activeMode)?.[1] ?? ''}・`
                          : ''
                        const aspect = frameForm.videoAspectRatio === 'auto' ? 'Auto' : frameForm.videoAspectRatio
                        const resolution = supportsResolutionSelection(frameForm.videoModel) ? `・${frameForm.resolution}` : ''
                        return `${modePrefix}${aspect}・${frameForm.duration}s${resolution}`
                      })()}
                    </span>
                    <ChevronIcon />
                  </button>
                  {openMenu === 'video-settings' ? (
                    <div className="lovart-menu wide lovart-video-settings" data-lovart-menu="video-settings">
                      {getAvailableVideoModes(frameForm.videoModel, frameForm.videoTab).length > 0 ? (
                        <>
                          <div className="lovart-menu-header">Mode</div>
                          <div className="lovart-menu-grid compact mode">
                            {getAvailableVideoModes(frameForm.videoModel, frameForm.videoTab).map((mode) => (
                              <button
                                type="button"
                                key={mode}
                                className={normalizeVideoModeForContext(frameForm.videoModel, frameForm.videoTab, frameForm.videoMode) === mode ? 'is-selected' : ''}
                                onClick={() => patchFrameForm({ videoMode: mode })}
                              >
                                <span>{VIDEO_MODE_OPTIONS.find(([value]) => value === mode)?.[1] ?? mode}</span>
                              </button>
                            ))}
                          </div>
                        </>
                      ) : null}
                      <div className="lovart-menu-header">Size</div>
                      <div className="lovart-menu-grid">
                        {getVideoAspectRatioOptions(frameForm.videoModel).map((ratio) => (
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
                        {getVideoDurationChoices(frameForm.videoModel) ? null : <span>{frameForm.duration}s</span>}
                      </div>
                      {getVideoDurationChoices(frameForm.videoModel) ? (
                        <div className="lovart-menu-grid compact">
                          {getVideoDurationChoices(frameForm.videoModel).map((duration) => (
                            <button
                              type="button"
                              key={duration}
                              onClick={() => updateFrameForm('duration', duration)}
                              className={String(frameForm.duration) === duration ? 'is-selected' : ''}
                            >
                              <span>{duration}s</span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <input
                          type="range"
                          min={getVideoDurationRange(frameForm.videoModel).min}
                          max={getVideoDurationRange(frameForm.videoModel).max}
                          step={getVideoDurationRange(frameForm.videoModel).step}
                          className="lovart-duration-slider"
                          value={frameForm.duration}
                          style={{
                            background: (() => {
                              const { min, max } = getVideoDurationRange(frameForm.videoModel)
                              const pct = ((Number(frameForm.duration) - min) / Math.max(1, max - min)) * 100
                              return `linear-gradient(to right, #7c3aed 0%, #7c3aed ${pct}%, #e0e0e0 ${pct}%, #e0e0e0 100%)`
                            })()
                          }}
                          onChange={(event) => updateFrameForm('duration', event.target.value)}
                        />
                      )}
                      {supportsResolutionSelection(frameForm.videoModel) ? (
                        <>
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
                        </>
                      ) : null}
                      {supportsGenerateAudio(frameForm.videoModel) ? (
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
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <button
                type="button"
                className={`lovart-generate${isCurrentFrameGenerating ? ' is-generating' : ''}`}
                disabled={!frameForm.prompt.trim() || isCurrentFrameGenerating}
                onClick={runFrameGeneration}
              >
                <LightningIcon />
                {isCurrentFrameGenerating ? (
                  <span>Generating...</span>
                ) : (
                  <span>{typeof activePanelCreditEstimate === 'number' ? activePanelCreditEstimate.toLocaleString('ja-JP') : '—'}</span>
                )}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {showPromptPanel && (activeFrameKind === 'subtitle' || activeFrameKind === 'silenceCut') ? (() => {
        const isSilencePanel = activeFrameKind === 'silenceCut'
        const primaryAsset = isSilencePanel ? frameForm.silenceCutVideo : frameForm.subtitleAudio
        const primaryIsXml = isSilencePanel && /\.xml$/i.test(primaryAsset?.name || primaryAsset?.path || '')
        const hasScriptFile = Boolean(frameForm.subtitleScriptText.trim())
        const scriptSlotDisabled = frameForm.subtitleMode !== 'scripted'
        const utilitySlotMenuOpen = isSilencePanel
          ? openMenu === 'silence-video-source'
          : openMenu === 'subtitle-audio-source' || openMenu === 'subtitle-script-source'
        const trayOpen =
          utilityTrayHovered ||
          Boolean(primaryAsset) ||
          utilitySlotMenuOpen ||
          (!isSilencePanel && !scriptSlotDisabled && hasScriptFile)
        const primaryTarget = isSilencePanel ? 'silenceCutVideo' : 'subtitleAudio'
        // Silence cut takes ONE source but shows two slots (動画 / XML) for
        // clarity — attaching to either replaces the source.
        const silenceVideoAsset = isSilencePanel && primaryAsset && !primaryIsXml ? primaryAsset : null
        const silenceXmlAsset = isSilencePanel && primaryIsXml ? primaryAsset : null
        const handleScriptFileChange = (event) => {
          setOpenMenu(null)
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          file.text().then((text) =>
            patchFrameForm({ subtitleScriptText: text.trim(), subtitleScriptName: file.name })
          )
        }
        const canGenerate = isSilencePanel
          ? Boolean(frameForm.silenceCutVideo)
          : Boolean(frameForm.subtitleAudio) && (frameForm.subtitleMode !== 'scripted' || hasScriptFile)
        const renderSilenceStepper = (label, field, min, max, step) => {
          const value = Number(frameForm[field])
          const canDecrease = value > min + 1e-9
          const canIncrease = value < max - 1e-9
          const adjust = (direction) => {
            const next = Math.min(max, Math.max(min, Number((value + direction * step).toFixed(2))))
            updateFrameForm(field, next)
          }
          return (
            <div className="lovart-setting-row lovart-stepper-row">
              <div className="lovart-menu-header">{label}</div>
              <div className="lovart-stepper">
                <button type="button" disabled={!canDecrease} onClick={() => adjust(-1)}>−</button>
                <span>{formatSilenceCutSecondsLabel(value)}</span>
                <button type="button" disabled={!canIncrease} onClick={() => adjust(1)}>＋</button>
              </div>
            </div>
          )
        }
        return (
        <section
          className={`lovart-ai-panel lovart-utility-panel${openMenuBlocksPrompt ? ' has-open-menu' : ''}${['utility-model', 'utility-settings', 'glossary'].includes(openMenu) ? ' menu-over-tray' : ''}`}
          style={panelStyle}
          aria-label={isSilencePanel ? 'Silence Cut Generator' : 'SRT Generator'}
          onPointerDown={(event) => {
            event.stopPropagation()
            if (event.target instanceof Element && !event.target.closest('.lovart-menu-wrap')) setOpenMenu(null)
          }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <div
            className={`lovart-utility-tray-wrap${trayOpen ? ' is-open' : ''}`}
            onMouseLeave={() => setUtilityTrayHovered(false)}
          >
            <textarea
              className="lovart-ai-prompt"
              placeholder="今日は何をしますか？"
              value={isSilencePanel ? frameForm.silenceCutInstruction : frameForm.subtitlePrompt}
              onChange={(event) =>
                updateFrameForm(isSilencePanel ? 'silenceCutInstruction' : 'subtitlePrompt', event.target.value)
              }
              onFocus={() => setOpenMenu(null)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  runUtilityGeneration()
                }
              }}
            />
            <div
              className="lovart-utility-asset-tray"
              onMouseEnter={() => setUtilityTrayHovered(true)}
              onMouseLeave={() => setUtilityTrayHovered(false)}
            >
              {isSilencePanel ? (
                <>
                  {/* 動画スロット（アップロード / キャンバスから選択） */}
                  <div className="lovart-utility-slot primary lovart-menu-wrap">
                    {silenceVideoAsset ? (
                      <div className="lovart-utility-card-wrap">
                        <button
                          type="button"
                          data-lovart-trigger="silence-cut-video"
                          className="lovart-utility-asset-card video"
                          title={silenceVideoAsset.name || '動画を添付'}
                          onClick={() => setOpenMenu((c) => (c === 'silence-video-source' ? null : 'silence-video-source'))}
                        >
                          {isRenderableVideoPosterDataURL(silenceVideoAsset.thumbnail) ? (
                            <img className="lovart-utility-card-thumb" src={silenceVideoAsset.thumbnail} alt={silenceVideoAsset.name || 'video'} />
                          ) : (
                            <span className="lovart-utility-card-thumb placeholder" />
                          )}
                          <span className="lovart-utility-card-play"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M8 5.14v13.72a1 1 0 001.5.86l11.04-6.86a1 1 0 000-1.72L9.5 4.28a1 1 0 00-1.5.86z" fill="#fff" /></svg></span>
                        </button>
                        <button
                          type="button"
                          className="lovart-frame-del"
                          onClick={(event) => { event.stopPropagation(); patchFrameForm({ silenceCutVideo: null }) }}
                        >
                          <CloseIcon />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        data-lovart-trigger="silence-cut-video"
                        className="lovart-utility-tilt-card primary"
                        title="動画を添付"
                        onClick={() => setOpenMenu((c) => (c === 'silence-video-source' ? null : 'silence-video-source'))}
                      >
                        <span className="lovart-add-plus">+</span>
                        {trayOpen ? <span className="lovart-utility-card-hint">動画</span> : null}
                      </button>
                    )}
                    {openMenu === 'silence-video-source' ? (
                      <div className="lovart-menu lovart-slot-menu" data-lovart-menu="silence-video-source">
                        <FileUploadLabel
                          className="lovart-upload-label"
                          accept="video/*"
                          onOpen={() => { rememberGeneratorUploadFrame(); videoFrameUploadTargetRef.current = primaryTarget }}
                          onChange={(event) => { setOpenMenu(null); onVideoFrameUploadChange(event) }}
                        >
                          <UploadIcon />
                          <span>動画をアップロード</span>
                        </FileUploadLabel>
                        <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpenMenu(null); openCanvasPicker('silenceCutVideo') }}>
                          <CanvasPickIcon />
                          <span>キャンバスから選択</span>
                        </button>
                      </div>
                    ) : null}
                  </div>
                  {/* XMLスロット（Premiere Pro） */}
                  <div className="lovart-utility-slot script">
                    {silenceXmlAsset ? (
                      <div className="lovart-utility-card-wrap">
                        <FileUploadLabel
                          className="lovart-utility-asset-card script"
                          title={silenceXmlAsset.name || 'Premiere XMLを添付'}
                          accept=".xml,application/xml,text/xml"
                          onOpen={() => { rememberGeneratorUploadFrame(); videoFrameUploadTargetRef.current = primaryTarget }}
                          onChange={(event) => { setOpenMenu(null); onVideoFrameUploadChange(event) }}
                        >
                          <ScriptFileIcon size={24} />
                          <span className="lovart-utility-card-label">{truncateMiddle(silenceXmlAsset.name || 'Premiere XML', 12)}</span>
                        </FileUploadLabel>
                        <button
                          type="button"
                          className="lovart-frame-del"
                          onClick={(event) => { event.stopPropagation(); patchFrameForm({ silenceCutVideo: null }) }}
                        >
                          <CloseIcon />
                        </button>
                      </div>
                    ) : (
                      <FileUploadLabel
                        className="lovart-utility-tilt-card script"
                        title="Premiere XMLを添付"
                        accept=".xml,application/xml,text/xml"
                        onOpen={() => { rememberGeneratorUploadFrame(); videoFrameUploadTargetRef.current = primaryTarget }}
                        onChange={(event) => { setOpenMenu(null); onVideoFrameUploadChange(event) }}
                      >
                        <span className="lovart-add-plus">+</span>
                        {trayOpen ? <span className="lovart-utility-card-hint">XML</span> : null}
                      </FileUploadLabel>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="lovart-utility-slot primary lovart-menu-wrap">
                    {primaryAsset ? (
                      <div className="lovart-utility-card-wrap">
                        <button
                          type="button"
                          data-lovart-trigger="subtitle-audio"
                          className="lovart-utility-asset-card audio"
                          title={primaryAsset.name || '音声・動画を添付'}
                          onClick={() => setOpenMenu((c) => (c === 'subtitle-audio-source' ? null : 'subtitle-audio-source'))}
                        >
                          <AudioWaveIcon size={18} />
                          <span className="lovart-utility-card-label">音声</span>
                        </button>
                        <button
                          type="button"
                          className="lovart-frame-del"
                          onClick={(event) => { event.stopPropagation(); patchFrameForm({ subtitleAudio: null }) }}
                        >
                          <CloseIcon />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        data-lovart-trigger="subtitle-audio"
                        className="lovart-utility-tilt-card primary audio-empty"
                        title="音声・動画を添付"
                        onClick={() => setOpenMenu((c) => (c === 'subtitle-audio-source' ? null : 'subtitle-audio-source'))}
                      >
                        <span className="lovart-add-plus">+</span>
                        {trayOpen ? <span className="lovart-utility-card-hint">音声</span> : null}
                      </button>
                    )}
                    {openMenu === 'subtitle-audio-source' ? (
                      <div className="lovart-menu lovart-slot-menu" data-lovart-menu="subtitle-audio-source">
                        <FileUploadLabel
                          className="lovart-upload-label"
                          accept={getUploadTargetAccept('subtitleAudio')}
                          onOpen={() => { rememberGeneratorUploadFrame(); videoFrameUploadTargetRef.current = primaryTarget }}
                          onChange={(event) => { setOpenMenu(null); onVideoFrameUploadChange(event) }}
                        >
                          <UploadIcon />
                          <span>音声・動画をアップロード</span>
                        </FileUploadLabel>
                        <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpenMenu(null); openCanvasPicker('subtitleAudio') }}>
                          <CanvasPickIcon />
                          <span>キャンバスから選択</span>
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <div className="lovart-utility-slot script lovart-menu-wrap">
                    {scriptSlotDisabled ? (
                      <button
                        type="button"
                        className="lovart-utility-tilt-card script is-disabled"
                        disabled
                        title="台本なしでは台本を使いません"
                      >
                        <span className="lovart-add-plus">+</span>
                        {trayOpen ? <span className="lovart-utility-card-hint">台本</span> : null}
                      </button>
                    ) : hasScriptFile ? (
                      <div className="lovart-utility-card-wrap">
                        <button
                          type="button"
                          className="lovart-utility-asset-card script"
                          title={frameForm.subtitleScriptName || '台本を添付'}
                          onClick={() => setOpenMenu((c) => (c === 'subtitle-script-source' ? null : 'subtitle-script-source'))}
                        >
                          <ScriptFileIcon size={24} />
                          <span className="lovart-utility-card-label">{truncateMiddle(frameForm.subtitleScriptName || '台本', 12)}</span>
                        </button>
                        <button
                          type="button"
                          className="lovart-frame-del"
                          onClick={(event) => { event.stopPropagation(); patchFrameForm({ subtitleScriptText: '', subtitleScriptName: '' }) }}
                        >
                          <CloseIcon />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="lovart-utility-tilt-card script"
                        title="台本を添付"
                        onClick={() => setOpenMenu((c) => (c === 'subtitle-script-source' ? null : 'subtitle-script-source'))}
                      >
                        <span className="lovart-add-plus">+</span>
                        {trayOpen ? <span className="lovart-utility-card-hint">台本</span> : null}
                      </button>
                    )}
                    {openMenu === 'subtitle-script-source' ? (
                      <div className="lovart-menu lovart-slot-menu" data-lovart-menu="subtitle-script-source">
                        <FileUploadLabel
                          className="lovart-upload-label"
                          accept=".txt,.md,.markdown,text/plain,text/markdown"
                          onChange={handleScriptFileChange}
                        >
                          <UploadIcon />
                          <span>台本をアップロード</span>
                        </FileUploadLabel>
                        <button
                          type="button"
                          data-lovart-canvas-pick-target="subtitleScript"
                          onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            openCanvasPicker('subtitleScript')
                          }}
                        >
                          <CanvasPickIcon />
                          <span>キャンバスから選択</span>
                        </button>
                      </div>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          </div>
          {generationError ? <div className="lovart-error">{generationError}</div> : null}
          {isSilencePanel && silenceCutNotice && !generationError ? (
            <div className="lovart-notice">
              <span>{silenceCutNotice}</span>
              {frameForm.silenceCutOutput?.url ? (
                <button
                  type="button"
                  className="lovart-notice-download"
                  onClick={() => saveAssetWithPicker(frameForm.silenceCutOutput.url, frameForm.silenceCutOutput.name || 'jetcut.xml')}
                >
                  <DownloadIcon size={13} />
                  <span>XML</span>
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="lovart-ai-bottom">
            <div className="lovart-ai-left">
              {!isSilencePanel ? (
                <div className="lovart-mode-switch">
                  {SUBTITLE_MODE_OPTIONS.map(([mode, label]) => (
                    <button
                      type="button"
                      key={mode}
                      className={frameForm.subtitleMode === mode ? 'is-selected' : ''}
                      onClick={() => {
                        setOpenMenu(null)
                        updateFrameForm('subtitleMode', mode)
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : null}
              {!isSilencePanel ? (
                <div className="lovart-menu-wrap lovart-glossary-wrap">
                  <button
                    type="button"
                    className={`lovart-pill${openMenu === 'glossary' ? ' tooltip-hidden' : ''}`}
                    data-lovart-trigger="subtitle-glossary"
                    onClick={() => {
                      const opening = openMenu !== 'glossary'
                      setOpenMenu(opening ? 'glossary' : null)
                      if (opening) {
                        setGlossaryStatus('')
                        // Refresh in the background but never clear what's
                        // already shown — the terms load once at startup, so
                        // opening must not flash to empty on a slow/failed fetch.
                        canvasFetch('/api/subtitle-glossary')
                          .then((response) => response.json())
                          .then((payload) => {
                            if (Array.isArray(payload.terms)) setGlossaryTerms(payload.terms)
                          })
                          .catch(() => {})
                      }
                    }}
                  >
                    <span>{glossaryActiveCount > 0 ? `用語 ${glossaryActiveCount}` : '用語'}</span>
                    <ChevronIcon />
                  </button>
                  {openMenu === 'glossary' ? (
                    <div className="lovart-menu wide lovart-glossary-menu" data-lovart-menu="subtitle-glossary">
                      <div className="lovart-glossary-head">
                        <div className="lovart-menu-header">用語辞書</div>
                        <span className="lovart-glossary-scope">プロジェクト共通</span>
                      </div>
                      <div className="lovart-glossary-desc">音声認識の表記ゆれを、SRT生成時に統一します。</div>
                      <div className="lovart-glossary-rows">
                        {glossaryTerms.length === 0 ? (
                          <div className="lovart-glossary-empty">まだ用語はありません。</div>
                        ) : (
                          glossaryTerms.map((term) => (
                            <div key={term.id} className="lovart-glossary-row">
                              <input
                                value={term.from}
                                placeholder="変換元"
                                onChange={(event) => updateGlossaryTerm(term.id, 'from', event.target.value)}
                              />
                              <input
                                value={term.to}
                                placeholder="表示"
                                onChange={(event) => updateGlossaryTerm(term.id, 'to', event.target.value)}
                              />
                              <button type="button" title="削除" onClick={() => removeGlossaryTerm(term.id)}>×</button>
                            </div>
                          ))
                        )}
                      </div>
                      <div className="lovart-glossary-foot">
                        <button type="button" className="lovart-glossary-add" onClick={addGlossaryTerm}>
                          + 用語を追加
                        </button>
                        <span className={`lovart-glossary-status${glossaryStatus === '保存しました' ? '' : ' is-error'}`}>
                          {glossaryStatus}
                        </span>
                        <button
                          type="button"
                          className="lovart-glossary-save"
                          disabled={glossarySaving}
                          onClick={saveGlossaryTerms}
                        >
                          {glossarySaving ? '保存中...' : '保存'}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="lovart-menu-wrap">
                <button
                  type="button"
                  className="lovart-pill"
                  data-lovart-trigger="subtitle-model"
                  onClick={() => setOpenMenu((current) => (current === 'utility-model' ? null : 'utility-model'))}
                >
                  <span>
                    {isSilencePanel
                      ? SILENCE_CUT_MODEL_OPTIONS.find(([value]) => value === frameForm.silenceCutModel)?.[1] ?? 'ElevenLabs Scribe v2'
                      : frameForm.subtitleMode === 'scripted' ? 'ElevenLabs Forced Alignment' : 'ElevenLabs Scribe v2'}
                  </span>
                  <ChevronIcon />
                </button>
                {openMenu === 'utility-model' ? (
                  <div className="lovart-menu" data-lovart-menu="utility-model">
                    <div className="lovart-menu-header">モデル</div>
                    {isSilencePanel ? (
                      SILENCE_CUT_MODEL_OPTIONS.map(([value, label]) => (
                        <button
                          type="button"
                          key={value}
                          onClick={() => {
                            updateFrameForm('silenceCutModel', value)
                            setOpenMenu(null)
                          }}
                        >
                          <span>{label}</span>
                          {frameForm.silenceCutModel === value ? <span className="menu-check">✓</span> : null}
                        </button>
                      ))
                    ) : (
                      <button type="button" onClick={() => setOpenMenu(null)}>
                        <span>{frameForm.subtitleMode === 'scripted' ? 'ElevenLabs Forced Alignment' : 'ElevenLabs Scribe v2'}</span>
                        <span className="menu-check">✓</span>
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="lovart-ai-right">
              <div className="lovart-menu-wrap lovart-utility-settings-anchor">
                <button
                  type="button"
                  className="lovart-pill"
                  data-lovart-trigger={isSilencePanel ? 'silence-cut-settings' : 'subtitle-settings'}
                  onClick={() => setOpenMenu((current) => (current === 'utility-settings' ? null : 'utility-settings'))}
                >
                  <span>
                    {isSilencePanel
                      ? `無音 ${formatSilenceCutSecondsLabel(frameForm.silenceCutDetectSeconds)}以上・間 ${formatSilenceCutSecondsLabel(frameForm.silenceCutKeepSeconds)}`
                      : `${frameForm.subtitleMaxChars}字・${frameForm.subtitleLineCount}行`}
                  </span>
                  <ChevronIcon />
                </button>
                {openMenu === 'utility-settings' && !isSilencePanel ? (
                  <div className="lovart-menu wide lovart-video-settings lovart-utility-settings lovart-utility-pop" data-lovart-menu="subtitle-settings">
                    <div className="lovart-setting-row">
                      <div className="lovart-setting-label">
                        <div className="lovart-menu-header">字幕1枚の文字数</div>
                        <span className="lovart-info-icon" data-lovart-tooltip="字幕1枚に表示する文字数の上限です（2行のときは2行の合計）。超える場合は次の字幕に分割されます。">i</span>
                      </div>
                      <span>
                        {frameForm.subtitleMaxChars}字
                        {frameForm.subtitleLineCount === 2 ? `（約${Math.ceil(frameForm.subtitleMaxChars / 2)}字×2行）` : ''}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="3"
                      max="40"
                      step="1"
                      className="lovart-duration-slider"
                      value={frameForm.subtitleMaxChars}
                      style={sliderTrackStyle(frameForm.subtitleMaxChars, 3, 40)}
                      onChange={(event) => updateFrameForm('subtitleMaxChars', Number(event.target.value))}
                    />
                    <div className="lovart-setting-row">
                      <div className="lovart-menu-header">最大行数</div>
                    </div>
                    <div className="lovart-choice-row lines">
                      {[1, 2].map((count) => (
                        <button
                          type="button"
                          key={count}
                          className={frameForm.subtitleLineCount === count ? 'is-selected' : ''}
                          onClick={() =>
                            patchFrameForm({
                              subtitleLineCount: count,
                              subtitleMaxChars: defaultSubtitleMaxCharsFor(count)
                            })
                          }
                        >
                          {count}行
                        </button>
                      ))}
                    </div>
                    <div className="lovart-setting-row">
                      <div className="lovart-setting-label">
                        <div className="lovart-menu-header">余韻（表示を残す時間）</div>
                        <span className="lovart-info-icon" data-lovart-tooltip="話し終わったあとも字幕を画面に残す時間です。例: 0.5秒なら話し終わりから0.5秒残ります。次の字幕が来る場合はそちらを優先します。">i</span>
                      </div>
                      <span>{Number(frameForm.subtitleHoldSeconds) > 0 ? `${Number(frameForm.subtitleHoldSeconds).toFixed(2)}秒` : 'なし'}</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="3"
                      step="0.05"
                      className="lovart-duration-slider"
                      value={frameForm.subtitleHoldSeconds}
                      style={sliderTrackStyle(frameForm.subtitleHoldSeconds, 0, 3)}
                      onChange={(event) => updateFrameForm('subtitleHoldSeconds', Number(event.target.value))}
                    />
                    <div className="lovart-setting-row">
                      <div className="lovart-setting-label">
                        <div className="lovart-menu-header">字幕末尾の句読点</div>
                        <span className="lovart-info-icon" data-lovart-tooltip="文末に「。」や「？」を自動で付けます（疑問文には？）。テロップらしく句読点なしにしたい場合は「付けない」。">i</span>
                      </div>
                    </div>
                    <div className="lovart-choice-row punct">
                      {SUBTITLE_PUNCTUATION_OPTIONS.map(([value, label]) => (
                        <button
                          type="button"
                          key={value}
                          className={frameForm.subtitlePunctuationMode === value ? 'is-selected' : ''}
                          onClick={() => updateFrameForm('subtitlePunctuationMode', value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <div className="lovart-setting-row">
                      <div className="lovart-setting-label">
                        <div className="lovart-menu-header">フィラー（えー・あのー）</div>
                        <span className="lovart-info-icon" data-lovart-tooltip="つなぎ言葉の扱いです。控えめ=明確なフィラーだけ削除（「えー、今日は」→「今日は」）。しっかり=あの・その・まあも削除。こう・ちょっと・ね等の文脈語は常に残します。">i</span>
                      </div>
                    </div>
                    <div className="lovart-choice-row filler">
                      {SUBTITLE_FILLER_OPTIONS.map(([value, label]) => (
                        <button
                          type="button"
                          key={value}
                          className={frameForm.subtitleFillerMode === value ? 'is-selected' : ''}
                          onClick={() => updateFrameForm('subtitleFillerMode', value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {openMenu === 'utility-settings' && isSilencePanel ? (
                  <div className="lovart-menu wide lovart-video-settings lovart-utility-settings lovart-utility-pop" data-lovart-menu="silence-cut-settings">
                    <div className="lovart-menu-section-title">プリセット</div>
                    <div className="lovart-choice-row silence-presets">
                      {SILENCE_CUT_PRESETS.map(([label, preset]) => {
                        const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.001
                        const isActive =
                          near(frameForm.silenceCutDetectSeconds, preset.detect) &&
                          near(frameForm.silenceCutKeepSeconds, preset.keep) &&
                          near(frameForm.silenceCutPreMarginSeconds, preset.pre) &&
                          near(frameForm.silenceCutPostMarginSeconds, preset.post)
                        return (
                          <button
                            type="button"
                            key={label}
                            className={isActive ? 'is-selected' : ''}
                            onClick={() =>
                              patchFrameForm({
                                silenceCutDetectSeconds: preset.detect,
                                silenceCutKeepSeconds: preset.keep,
                                silenceCutPreMarginSeconds: preset.pre,
                                silenceCutPostMarginSeconds: preset.post,
                                silenceCutThresholdAuto: true
                              })
                            }
                          >
                            {label}
                          </button>
                        )
                      })}
                    </div>
                    <div className="lovart-menu-section-title">カットの強さ</div>
                    <div className="lovart-setting-row">
                      <div className="lovart-setting-label">
                        <div className="lovart-menu-header">無音と判定する長さ</div>
                        <span className="lovart-info-icon" data-lovart-tooltip="この長さ以上続く無音をカット対象にします。短くするほどテンポよく詰まります。">i</span>
                      </div>
                      <span>{formatSilenceCutSecondsLabel(frameForm.silenceCutDetectSeconds)}以上</span>
                    </div>
                    <input
                      type="range"
                      min="0.3"
                      max="2"
                      step="0.05"
                      className="lovart-duration-slider"
                      value={frameForm.silenceCutDetectSeconds}
                      style={sliderTrackStyle(frameForm.silenceCutDetectSeconds, 0.3, 2)}
                      onChange={(event) => updateFrameForm('silenceCutDetectSeconds', Number(event.target.value))}
                    />
                    <div className="lovart-setting-row">
                      <div className="lovart-setting-label">
                        <div className="lovart-menu-header">カット後に残す間</div>
                        <span className="lovart-info-icon" data-lovart-tooltip="カットした箇所に残す間の長さです。長いほどゆったりした仕上がりになります。">i</span>
                      </div>
                      <span>{formatSilenceCutSecondsLabel(frameForm.silenceCutKeepSeconds)}</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      className="lovart-duration-slider"
                      value={frameForm.silenceCutKeepSeconds}
                      style={sliderTrackStyle(frameForm.silenceCutKeepSeconds, 0, 1)}
                      onChange={(event) => updateFrameForm('silenceCutKeepSeconds', Number(event.target.value))}
                    />
                    <div className="lovart-menu-section">
                      <div className="lovart-menu-section-title">AIクリーンアップ（Scribe v2のみ）</div>
                      {frameForm.silenceCutModel !== 'elevenlabs-scribe-v2' ? (
                        <div className="lovart-disabled-hint">モデルをElevenLabs Scribe v2にすると使えます。</div>
                      ) : null}
                      {[
                        ['silenceCutFillerRemoval', 'フィラー削除', '「えー」「あの」などのつなぎ言葉をAIが検出して削除します。'],
                        ['silenceCutCoughRemoval', '咳などの不要音', '咳払いやリップノイズなどの不要音をAIが検出して削除します。'],
                        ['silenceCutRetakeRemoval', '言い直し削除', '言い直した箇所の、最初の言い間違い部分をAIが検出して削除します。']
                      ].map(([field, label, tooltip]) => {
                        const aiDisabled = frameForm.silenceCutModel !== 'elevenlabs-scribe-v2'
                        return (
                          <div className={`lovart-setting-row lovart-intensity-row${aiDisabled ? ' is-disabled' : ''}`} key={field}>
                            <div className="lovart-setting-label">
                              <span className="lovart-intensity-label">{label}</span>
                              <span className="lovart-info-icon" data-lovart-tooltip={tooltip}>i</span>
                            </div>
                            <div className="lovart-ai-level">
                              {SILENCE_CUT_INTENSITY_OPTIONS.map(([value, optionLabel]) => (
                                <button
                                  type="button"
                                  key={value}
                                  disabled={aiDisabled}
                                  className={silenceCutAiLevelLabel(frameForm[field]) === optionLabel ? 'is-selected' : ''}
                                  onClick={() => updateFrameForm(field, value)}
                                >
                                  {optionLabel}
                                </button>
                              ))}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    <div className="lovart-menu-section">
                      <button
                        type="button"
                        className="lovart-advanced-toggle"
                        onClick={() => setSilenceCutAdvancedOpen((current) => !current)}
                      >
                        <span>詳細設定</span>
                        <span className={`lovart-advanced-chevron${silenceCutAdvancedOpen ? ' is-open' : ''}`}><ChevronIcon /></span>
                      </button>
                      {silenceCutAdvancedOpen ? (
                        <>
                          <div className="lovart-setting-row">
                            <div className="lovart-setting-label">
                              <div className="lovart-menu-header">無音とみなす音量</div>
                              <span className="lovart-info-icon" data-lovart-tooltip="この音量より静かな部分を「無音」と判断します。自動＝動画のノイズに合わせて最適な値をアプリが決めます。手動＝喋りの途中で切れるなら小さく、無音が残るなら大きく。">i</span>
                            </div>
                            <div className="lovart-video-tabs lovart-threshold-mode">
                              <button
                                type="button"
                                className={frameForm.silenceCutThresholdAuto ? 'is-selected' : ''}
                                onClick={() => updateFrameForm('silenceCutThresholdAuto', true)}
                              >
                                自動
                              </button>
                              <button
                                type="button"
                                className={!frameForm.silenceCutThresholdAuto ? 'is-selected' : ''}
                                onClick={() => updateFrameForm('silenceCutThresholdAuto', false)}
                              >
                                手動
                              </button>
                            </div>
                          </div>
                          {frameForm.silenceCutThresholdAuto ? (
                            <div className="lovart-threshold-auto-hint">動画のノイズに合わせて自動で調整します。</div>
                          ) : (
                            <>
                              <div className="lovart-threshold-value-line">{Math.round(frameForm.silenceCutThresholdDb)}dB</div>
                              <input
                                type="range"
                                min="-60"
                                max="-20"
                                step="1"
                                className="lovart-duration-slider"
                                value={frameForm.silenceCutThresholdDb}
                                style={sliderTrackStyle(frameForm.silenceCutThresholdDb, -60, -20)}
                                onChange={(event) => updateFrameForm('silenceCutThresholdDb', Number(event.target.value))}
                              />
                            </>
                          )}
                          {renderSilenceStepper('カット前の余白', 'silenceCutPreMarginSeconds', 0.05, 0.3, 0.01)}
                          {renderSilenceStepper('カット後の余白', 'silenceCutPostMarginSeconds', 0.05, 0.3, 0.01)}
                        </>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className={`lovart-generate${isCurrentFrameGenerating ? ' is-generating' : ''}`}
                disabled={!canGenerate || isCurrentFrameGenerating}
                onClick={runUtilityGeneration}
              >
                <LightningIcon />
                {isCurrentFrameGenerating ? (
                  <span>Generating...</span>
                ) : (
                  <span>{(typeof activePanelCreditEstimate === 'number' ? activePanelCreditEstimate : 0).toLocaleString('ja-JP')}</span>
                )}
              </button>
            </div>
          </div>
        </section>
        )
      })() : null}
      {canvasPicker ? (
        <div className="lovart-canvas-picker-bar">
          <span>キャンバスから選択</span>
          <button
            type="button"
            onPointerDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              closeCanvasPicker()
            }}
          >
            終了
          </button>
        </div>
      ) : null}
      <input
        ref={toolbarMediaInputRef}
        data-lovart-upload-input="toolbar-media"
        type="file"
        accept="image/*,video/*,audio/*,.xml,.srt,.txt,.md,text/plain,text/markdown,application/xml,text/xml,application/x-subrip"
        multiple
        hidden
        onChange={onToolbarMediaInputChange}
      />
    </main>
  )
}
