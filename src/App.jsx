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
  silenceCutModel: 'ffmpeg-local',
  silenceCutInstruction: '',
  silenceCutFillerRemoval: 40,
  silenceCutCoughRemoval: 0,
  silenceCutRetakeRemoval: 0,
  silenceCutVideo: null,
  silenceCutDetectSeconds: 0.6,
  silenceCutKeepSeconds: 0.25,
  silenceCutThresholdDb: -34,
  silenceCutPreMarginSeconds: 0.08,
  silenceCutPostMarginSeconds: 0.12,
  silenceCutAudioFadeSeconds: 0.03,
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
  ['auto', '付ける'],
  ['none', 'なし']
]

const SUBTITLE_FILLER_OPTIONS = [
  ['keep', 'そのまま'],
  ['safe', '明確だけ'],
  ['contextual', 'AI判断']
]

// Youtube-AGI SILENCE_CUT_MODEL_OPTIONS
const SILENCE_CUT_MODEL_OPTIONS = [
  ['ffmpeg-local', 'FFmpeg Local'],
  ['elevenlabs-scribe-v2', 'ElevenLabs Scribe v2']
]
// AI cleanup intensity presets (オフ/弱/中/強), matching Youtube-AGI
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
  if (model === 'kling-v2-6') return ['keyframe', 'motion']
  if (model === 'kling-v3') return ['keyframe']
  return ['keyframe', 'reference']
}

function normalizeVideoTabForModel(model, value) {
  const tabs = getAvailableVideoTabs(model)
  return tabs.includes(value) ? value : 'keyframe'
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

// Audio reference is only meaningful for models that consume an audio track
// (Seedance family in the reference). For the default Grok model it is hidden,
// matching Youtube-AGI and keeping the panel to image+video references.
function supportsAudioReference(model) {
  return /seedance/i.test(String(model || ''))
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

// Real provider logos, fetched as favicons from each vendor's domain (like
// Lovart's model list). Falls back to the local glyphs offline / on error.
const PROVIDER_FAVICON_DOMAINS = {
  midjourney: 'midjourney.com',
  'nano-banana': 'deepmind.google',
  openai: 'openai.com',
  luma: 'lumalabs.ai',
  flux: 'bfl.ai',
  seedream: 'seed.bytedance.com',
  seedance: 'seed.bytedance.com',
  kling: 'klingai.com',
  ideogram: 'ideogram.ai',
  veo: 'deepmind.google',
  gemini: 'gemini.google.com',
  hailuo: 'hailuoai.video',
  wan: 'wan.video',
  vidu: 'vidu.com',
  grok: 'x.ai',
  codex: 'openai.com',
  lovart: 'lovart.ai',
  buzzassist: 'buzzassist.ai'
}

function ModelProviderIcon({ provider, size = 16 }) {
  const [faviconFailed, setFaviconFailed] = useState(false)
  const domain = PROVIDER_FAVICON_DOMAINS[provider]
  if (domain && !faviconFailed) {
    return (
      <img
        src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`}
        width={size}
        height={size}
        alt=""
        loading="lazy"
        draggable={false}
        style={{ borderRadius: 4, display: 'block' }}
        onError={() => setFaviconFailed(true)}
      />
    )
  }
  return <ModelProviderGlyph provider={provider} size={size} />
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
  setValue('subtitleAudioAsset', sanitizeAsset(next.subtitleAudioAsset))
  setValue('silenceCutVideoAsset', sanitizeAsset(next.silenceCutVideoAsset))
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

function getPanelPlacementFromViewportTarget(target, kind = 'image') {
  const isVideo = kind === true || kind === 'video'
  const frameViewportWidth = Math.max(1, Number(target?.width) || 1)
  const frameViewportHeight = Math.max(1, Number(target?.height) || 1)
  const viewportWidth = typeof window === 'undefined' ? 1280 : Math.max(1, window.innerWidth || 1280)
  const maxPanelWidth = Math.max(GENERATOR_PANEL_IMAGE_MIN_WIDTH, viewportWidth - GENERATOR_FRAME_EDGE_MARGIN * 2)
  const panelWidth = isVideo
    ? Math.min(GENERATOR_PANEL_VIDEO_WIDTH, maxPanelWidth)
    : kind === 'subtitle' || kind === 'silenceCut'
      ? Math.min(500, maxPanelWidth)
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
    silenceCutModel: customData.silenceCutModel === 'elevenlabs-scribe-v2' ? 'elevenlabs-scribe-v2' : 'ffmpeg-local',
    silenceCutInstruction: typeof customData.silenceCutInstruction === 'string' ? customData.silenceCutInstruction : '',
    silenceCutFillerRemoval: clamp(finiteNumberOr(customData.silenceCutFillerRemoval, DEFAULT_FRAME_FORM.silenceCutFillerRemoval), 0, 100),
    silenceCutCoughRemoval: clamp(finiteNumberOr(customData.silenceCutCoughRemoval, DEFAULT_FRAME_FORM.silenceCutCoughRemoval), 0, 100),
    silenceCutRetakeRemoval: clamp(finiteNumberOr(customData.silenceCutRetakeRemoval, DEFAULT_FRAME_FORM.silenceCutRetakeRemoval), 0, 100),
    silenceCutVideo: customData.silenceCutVideoAsset && typeof customData.silenceCutVideoAsset === 'object'
      ? customData.silenceCutVideoAsset
      : null,
    silenceCutDetectSeconds: clamp(finiteNumberOr(customData.silenceCutDetectSeconds, DEFAULT_FRAME_FORM.silenceCutDetectSeconds), 0.3, 2),
    silenceCutKeepSeconds: clamp(finiteNumberOr(customData.silenceCutKeepSeconds, DEFAULT_FRAME_FORM.silenceCutKeepSeconds), 0, 1),
    silenceCutThresholdDb: clamp(finiteNumberOr(customData.silenceCutThresholdDb, DEFAULT_FRAME_FORM.silenceCutThresholdDb), -60, -20),
    silenceCutPreMarginSeconds: clamp(finiteNumberOr(customData.silenceCutPreMarginSeconds, DEFAULT_FRAME_FORM.silenceCutPreMarginSeconds), 0.05, 0.3),
    silenceCutPostMarginSeconds: clamp(finiteNumberOr(customData.silenceCutPostMarginSeconds, DEFAULT_FRAME_FORM.silenceCutPostMarginSeconds), 0.05, 0.3),
    silenceCutAudioFadeSeconds: clamp(finiteNumberOr(customData.silenceCutAudioFadeSeconds, DEFAULT_FRAME_FORM.silenceCutAudioFadeSeconds), 0, 0.1),
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
      subtitleAudioAsset: form.subtitleAudio || null
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
      silenceCutPreMarginSeconds: form.silenceCutPreMarginSeconds,
      silenceCutPostMarginSeconds: form.silenceCutPostMarginSeconds,
      silenceCutAudioFadeSeconds: form.silenceCutAudioFadeSeconds,
      silenceCutVideoAsset: form.silenceCutVideo || null
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
        videoStartFrameAsset: form.videoStartFrame || null,
        videoEndFrameAsset: form.videoEndFrame || null,
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
        // MCP/batch jobs mark their placeholder frames so the browser shows
        // the Generating... overlay for work it did not start itself.
        remoteGenerating: element.customData?.codexGenerating === true,
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
  // Youtube-AGI shows media headers for every media element near the
  // viewport, not only the selected one.
  return scene.elements
    .filter((element) => !element.isDeleted && (isCanvasImageElement(element) || isCanvasVideoElement(element)))
    .map((element) => {
      const placement = getFrameViewportPlacement(getElementGeometry(element), appState)
      const pixelSize = getCanvasMediaPixelSize(element, scene.files)
      const file = element.fileId ? scene.files?.[element.fileId] : null
      const assetUrl =
        assetUrlFromElement(element) ||
        (typeof file?.codexAssetUrl === 'string' && file.codexAssetUrl.startsWith(CANVAS_ASSETS_ROUTE) ? file.codexAssetUrl : '') ||
        (typeof file?.dataURL === 'string' && file.dataURL.startsWith(CANVAS_ASSETS_ROUTE) ? file.dataURL : '')
      return {
        id: element.id,
        assetType: isCanvasVideoElement(element) ? 'video' : 'image',
        fileName: getCanvasMediaDisplayName(element, scene.files),
        assetUrl,
        isSelected: selectedIds.has(element.id),
        left: placement.left,
        top: placement.top,
        width: placement.width,
        height: placement.height,
        angle: Number(element.angle) || 0,
        pixelWidth: pixelSize.width,
        pixelHeight: pixelSize.height
      }
    })
    .filter((overlay) => overlay.isSelected || isViewportPlacementNearViewport(overlay, appState))
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

function buildSubtitlePreviewOverlays(scene) {
  const appState = scene.appState ?? {}
  const selectedIds = new Set(getSelectedIds(appState))
  const zoom = Number(appState.zoom?.value) || 1
  return scene.elements
    .filter(isGeneratedSubtitleResult)
    .map((element) => {
      const assetUrl = element.customData?.codexAssetUrl || ''
      if (!assetUrl) return null
      const placement = getFrameViewportPlacement(getElementGeometry(element), appState)
      return {
        id: element.id,
        assetUrl,
        fileName: element.customData?.codexFileName || 'subtitles.srt',
        cueCount: Number(element.customData?.subtitleCueCount) || 0,
        left: placement.left,
        top: placement.top,
        width: placement.width,
        height: placement.height,
        angle: Number(element.angle) || 0,
        zoom,
        isSelected: selectedIds.has(element.id)
      }
    })
    .filter((overlay) => overlay && (overlay.isSelected || isViewportPlacementNearViewport(overlay, appState)))
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
    const response = await fetch(url)
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
  const selectedPreviewInset = isSelected ? 3 : 0
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
  const headerFontSize = Math.max(5, Math.min(14, Math.round(overlay.width * 0.055)))
  const headerOffset = Math.max(6, Math.min(18, headerFontSize + 3))
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
            <span style={{ fontSize: '0.9em' }}>📝</span>
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
  // The SRT panel is shorter than the video one; a 300px reserve kept the
  // tall SRT card from reaching its 150% target zoom.
  if (kind === 'subtitle') return 235
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
  const [bulkDownloading, setBulkDownloading] = useState(false)
  // Project-common 用語辞書 (canvas/subtitle-glossary.json), edited from the
  // SRT panel's 用語 pill and merged server-side into every transcription.
  const [glossaryTerms, setGlossaryTerms] = useState(null)
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
      const response = await fetch('/api/subtitle-glossary', {
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
      // Save the freshest scene at fire time: a debounced frame-form write can
      // land between scheduling and firing, and saving the stale snapshot
      // would drop it from disk.
      saveTimerRef.current = window.setTimeout(() => saveCanvas(latestSceneRef.current ?? scene), SAVE_DELAY_MS)
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

  // Writing the panel form into the frame's customData on every keystroke made
  // Excalidraw fire onChange mid-IME-composition; the unconditional
  // setFrameForm below then reset the textarea to a stale value, duplicating
  // composed text. Writes are debounced and only flushed when leaving a frame,
  // and the form is only re-read from the element when the selection changes.
  const pendingFrameFormWriteRef = useRef(null)
  const updateActiveFrameElementRef = useRef(null)

  const flushPendingFrameFormWrite = useCallback(() => {
    const pending = pendingFrameFormWriteRef.current
    if (!pending) return
    pendingFrameFormWriteRef.current = null
    window.clearTimeout(pending.timer)
    updateActiveFrameElementRef.current?.(pending.form, pending.frameId)
  }, [])

  const scheduleFrameFormWrite = useCallback((form) => {
    const frameId = activeFrameIdRef.current
    if (!frameId) return
    const pending = pendingFrameFormWriteRef.current
    if (pending) window.clearTimeout(pending.timer)
    const timer = window.setTimeout(() => {
      if (pendingFrameFormWriteRef.current?.timer === timer) pendingFrameFormWriteRef.current = null
      updateActiveFrameElementRef.current?.(form, frameId)
    }, 300)
    pendingFrameFormWriteRef.current = { timer, form, frameId }
  }, [])

  const syncGeneratorUi = useCallback((scene) => {
    refreshOverlayStates(scene)
    const elementsById = new Map(scene.elements.map((element) => [element.id, element]))
    const selectedIds = getSelectedIds(scene.appState)
    const selectedFrameId = selectedIds.find((id) => isGeneratorFrame(elementsById.get(id))) ?? ''
    const pendingWrite = pendingFrameFormWriteRef.current
    if (pendingWrite && pendingWrite.frameId !== selectedFrameId) flushPendingFrameFormWrite()
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
        setActiveFrameKind(getGeneratorKind(selectedFrame))
        setFrameForm(frameFormFromElement(selectedFrame))
      }
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
  }, [refreshOverlayStates, flushPendingFrameFormWrite])

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
          suppressNextChangeRef.current = true
          activeFrameIdRef.current = selectedFrameId
          lastFocusedFrameIdRef.current = selectedFrameId
          setActiveFrameId(selectedFrameId)
          setActiveFrameKind(selectedKind)
          setFrameForm(frameFormFromElement(selectedFrame))
          setPendingPanelFrame(null)
          setSelectedGeneratedResult(null)
          setOpenMenu(null)
          refreshOverlayStates(nextScene)
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
    [api, refreshOverlayStates, scheduleCanvasSave, scheduleSelectionSave, syncGeneratorUi]
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
        if (!(isCanvasImageElement(element) || isCanvasVideoElement(element) || isGeneratorFrame(element))) return false
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
      suppressNextChangeRef.current = true
      window.setTimeout(() => {
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
        } else if (target === 'subtitleAudio') {
          next = { ...current, subtitleAudio: asset }
        } else if (target === 'silenceCutVideo') {
          next = { ...current, silenceCutVideo: asset }
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
      if (picker.target === 'imageReferences' && asset.kind !== 'image') return false
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
          .filter((file) => file.type.startsWith('image/'))
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
      // Screen Y for the frame center: prefer the kind's ratio, but clamp so
      // the frame clears the top toolbar and leaves room for the panel below.
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
          // Creating a frame always lands at the kind's target zoom (capped
          // so frame + panel fit the viewport) — zooming in from a far view
          // as well as out from a too-close one.
          const fitZoom = fittedGeneratorZoom(
            kind,
            size,
            viewportWidth,
            viewportHeight,
            generatorCreateZoomFor(kind)
          )
          if (wasOverlapping || Math.abs(curZoom - fitZoom) > 0.01) {
            targetZoom = fitZoom
            shouldAnimate = true
          }
          const useZoom = shouldAnimate ? targetZoom : curZoom
          const targetScreenY = frameScreenYFor(useZoom)
          if (shouldAnimate) {
            targetScrollX = targetScreenX / useZoom - frameCenterX
            targetScrollY = targetScreenY / useZoom - frameCenterY
          } else {
            nextScrollX = targetScreenX / useZoom - frameCenterX
            nextScrollY = targetScreenY / useZoom - frameCenterY
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
      const status = await (await fetch('/api/buzzassist/auth-status')).json()
      if (status?.loggedIn) return true
    } catch {
      // status probe failed — fall through to the login flow
    }
    setGenerationError('BuzzAssistのログイン画面を開きました。ブラウザでサインインすると自動で続行します…')
    try {
      const response = await fetch('/api/buzzassist/login', { method: 'POST' })
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
              // Lovart bills GPT Image 2 quality tiers as separate tools;
              // the quality setting picks the tier at submit time.
              model: generationModelFor(imageFamilyForModel(savedForm.imageModel), savedForm.imageModel, savedForm.quality),
              aspectRatio: savedForm.aspectRatio,
              quality: savedForm.quality,
              imageSize: savedForm.imageSize,
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
        refreshOverlayStates(errorScene)
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
  }, [api, applyRemoteScene, capabilities, ensureBuzzAssistLoggedIn, frameForm, generatingFrameIds, insertGeneratorFrame, refreshOverlayStates, saveCanvas, scheduleCanvasSave, scheduleSelectionSave, selectedGeneratedResult, updateActiveFrameElement])

  // Generation for the utility frames (SRT subtitles / silence cut). The server
  // replaces the anchor frame with the result card/video and broadcasts the new
  // canvas, mirroring the image/video generation flow.
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
      setGenerationError('無音カットする動画を添付してください。')
      return
    }

    const needsCloud = kind === 'subtitle' || savedForm.silenceCutModel === 'elevenlabs-scribe-v2'
    if (needsCloud && !(await ensureBuzzAssistLoggedIn())) return

    updateActiveFrameElement(savedForm)
    setOpenMenu(null)
    setGenerationError('')
    setGeneratingFrameIds((current) => new Set(current).add(anchorElementId))
    setPendingPanelFrame(null)
    setSelectedGeneratedResult(null)
    activeFrameIdRef.current = ''
    setActiveFrameId('')
    suppressNextChangeRef.current = true
    window.setTimeout(() => {
      api.updateScene({
        appState: { selectedElementIds: {} },
        captureUpdate: CaptureUpdateAction.NEVER
      })
    }, 0)

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
              replaceAnchor: true,
              fileName: `${(savedForm.subtitleAudio.name || 'subtitles').replace(/\.[^.]+$/, '')}.srt`
            }
          : {
              videoPath: savedForm.silenceCutVideo.path,
              model: savedForm.silenceCutModel,
              instructionPrompt: savedForm.silenceCutInstruction.trim() || undefined,
              fillerRemoval: savedForm.silenceCutModel === 'elevenlabs-scribe-v2' ? savedForm.silenceCutFillerRemoval : 0,
              coughRemoval: savedForm.silenceCutModel === 'elevenlabs-scribe-v2' ? savedForm.silenceCutCoughRemoval : 0,
              retakeRemoval: savedForm.silenceCutModel === 'elevenlabs-scribe-v2' ? savedForm.silenceCutRetakeRemoval : 0,
              detectSeconds: savedForm.silenceCutDetectSeconds,
              thresholdDb: savedForm.silenceCutThresholdDb,
              keepSeconds: savedForm.silenceCutKeepSeconds,
              preMarginSeconds: savedForm.silenceCutPreMarginSeconds,
              postMarginSeconds: savedForm.silenceCutPostMarginSeconds,
              audioFadeSeconds: savedForm.silenceCutAudioFadeSeconds,
              anchorElementId,
              placement: 'replace',
              replaceAnchor: true,
              displayWidth: anchorElement.width,
              displayHeight: anchorElement.height,
              fileName: `${(savedForm.silenceCutVideo.name || 'video').replace(/\.[^.]+$/, '')}-cut.mp4`
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
      suppressNextChangeRef.current = true
      window.setTimeout(() => {
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

  const activeOverlay = frameOverlays.find((overlay) => overlay.id === activeFrameId)
  const isCurrentFrameGenerating = activeFrameId ? generatingFrameIds.has(activeFrameId) : false
  const activePanelTarget = activeOverlay ?? selectedGeneratedResult
  const panelAppState = latestSceneRef.current?.appState ?? {}
  const activePanelTargetIsVisible = activePanelTarget
    ? isViewportPlacementNearViewport(activePanelTarget, panelAppState, 24)
    : false
  const showPromptPanel = Boolean(activePanelTarget && activePanelTargetIsVisible && !isCurrentFrameGenerating)
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
      {(() => {
        // Lovart-style selection toolbar: click or marquee-select any media
        // (image / video / SRT card) and a floating toolbar appears above the
        // selection bounds with a download button — single item downloads
        // directly, multiple items download as one ZIP.
        const selectedMedia = [
          ...selectedImageOverlays.filter((overlay) => overlay.isSelected && overlay.assetUrl),
          ...subtitlePreviewOverlays.filter((overlay) => overlay.isSelected && overlay.assetUrl)
        ]
        if (selectedMedia.length === 0) return null
        const boundsLeft = Math.min(...selectedMedia.map((overlay) => overlay.left))
        const boundsRight = Math.max(...selectedMedia.map((overlay) => overlay.left + overlay.width))
        const boundsTop = Math.min(...selectedMedia.map((overlay) => overlay.top))
        const single = selectedMedia.length === 1
        const downloadZip = async () => {
          const files = selectedMedia
            .map((overlay) => overlay.assetUrl.split('/').pop().split('?')[0])
            .filter(Boolean)
          if (files.length === 0) return
          setBulkDownloading(true)
          try {
            const response = await fetch('/api/assets/archive', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ files })
            })
            if (!response.ok) {
              const payload = await response.json().catch(() => ({}))
              throw new Error(payload.error || `Download failed: ${response.status}`)
            }
            const blob = await response.blob()
            const url = URL.createObjectURL(blob)
            const anchor = document.createElement('a')
            anchor.href = url
            anchor.download = `excalidraw-assets-${new Date().toISOString().slice(0, 10)}.zip`
            document.body.appendChild(anchor)
            anchor.click()
            anchor.remove()
            window.setTimeout(() => URL.revokeObjectURL(url), 10000)
          } catch (error) {
            setGenerationError(error.message)
          } finally {
            setBulkDownloading(false)
          }
        }
        return (
          <div
            className="lovart-selection-toolbar"
            style={{ left: `${Math.round((boundsLeft + boundsRight) / 2)}px`, top: `${Math.max(12, Math.round(boundsTop - 48))}px` }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {single ? (
              <a
                className="lovart-selection-toolbar-btn"
                href={`${selectedMedia[0].assetUrl}?download=1`}
                download
                title="ダウンロード"
                onClick={(event) => event.stopPropagation()}
              >
                <DownloadIcon size={15} />
              </a>
            ) : (
              <button
                type="button"
                className="lovart-selection-toolbar-btn"
                disabled={bulkDownloading}
                title={bulkDownloading ? '準備中…' : `${selectedMedia.length}件をZIPでダウンロード`}
                onClick={downloadZip}
              >
                <DownloadIcon size={15} />
                <span className="lovart-selection-toolbar-count">{bulkDownloading ? '…' : selectedMedia.length}</span>
              </button>
            )}
          </div>
        )
      })()}
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
                  {getAvailableVideoTabs(frameForm.videoModel).map((tab) => (
                    <button
                      type="button"
                      key={tab}
                      className={frameForm.videoTab === tab ? 'is-selected' : ''}
                      onClick={() => {
                        setOpenMenu(null)
                        patchFrameForm({
                          videoTab: tab,
                          videoMode: normalizeVideoModeForContext(frameForm.videoModel, tab, frameForm.videoMode)
                        })
                      }}
                    >
                      {tab === 'keyframe' ? 'キーフレーム' : tab === 'motion' ? 'モーション' : 'リファレンス'}
                    </button>
                  ))}
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
                    fetch('/api/lovart/auth-status')
                      .then((response) => response.json())
                      .then(setLovartAuth)
                      .catch(() => {})
                    fetch('/api/hermes/status')
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
                          {lovartAuth?.configured
                            ? `接続済み: ${lovartAuth.accessKeyPreview ?? ''}`
                            : '未設定（OpenClaw の ak_/sk_ を入力）'}
                        </div>
                        {!lovartAuth?.configured || lovartKeyEditing ? (
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
                                  const response = await fetch('/api/lovart/credentials', {
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
                        <button
                          type="button"
                          className="lovart-key-save"
                          onClick={() => {
                            navigator.clipboard?.writeText(
                              'Hermes Agent で Grok Imagine を使えるようにセットアップして。excalidraw MCP の setup_hermes_grok ツールを実行して、必要なら hermes auth add xai-oauth のブラウザOAuthを完了させて。'
                            ).catch(() => {})
                          }}
                        >
                          AIエージェント用セットアッププロンプトをコピー
                        </button>
                        <div className="lovart-key-hint">Claude Code / Codex に貼り付けると setup_hermes_grok が自動でセットアップします</div>
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
                      <button
                        type="button"
                        onClick={() => {
                          rememberGeneratorUploadFrame()
                          imageUploadInputRef.current?.click()
                          setOpenMenu(null)
                        }}
                      >
                        <UploadIcon />
                        <span>画像をアップロード</span>
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
        const hasScriptFile = Boolean(frameForm.subtitleScriptText.trim())
        const scriptSlotDisabled = frameForm.subtitleMode !== 'scripted'
        const trayOpen =
          utilityTrayHovered ||
          Boolean(primaryAsset) ||
          (!isSilencePanel && frameForm.subtitleMode === 'scripted' && hasScriptFile)
        const primaryTarget = isSilencePanel ? 'silenceCutVideo' : 'subtitleAudio'
        const openPrimaryPicker = () => {
          setOpenMenu(null)
          rememberGeneratorUploadFrame()
          videoFrameUploadTargetRef.current = primaryTarget
          if (videoFrameUploadInputRef.current) {
            videoFrameUploadInputRef.current.accept = getUploadTargetAccept(primaryTarget)
            videoFrameUploadInputRef.current.multiple = false
            videoFrameUploadInputRef.current.click()
          }
        }
        const openScriptPicker = () => {
          if (scriptSlotDisabled) return
          setOpenMenu(null)
          const input = document.createElement('input')
          input.type = 'file'
          input.accept = '.txt,.md,.markdown,text/plain,text/markdown'
          input.onchange = () => {
            const file = input.files?.[0]
            if (!file) return
            file.text().then((text) =>
              patchFrameForm({ subtitleScriptText: text.trim(), subtitleScriptName: file.name })
            )
          }
          input.click()
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
          className={`lovart-ai-panel lovart-utility-panel${openMenuBlocksPrompt ? ' has-open-menu' : ''}`}
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
              <div className="lovart-utility-slot primary">
                {primaryAsset ? (
                  <div className="lovart-utility-card-wrap">
                    <button
                      type="button"
                      data-lovart-trigger={isSilencePanel ? 'silence-cut-video' : 'subtitle-audio'}
                      className={`lovart-utility-asset-card${isSilencePanel ? ' video' : ' audio'}`}
                      title={primaryAsset.name || (isSilencePanel ? '動画を添付' : '音声を添付')}
                      onClick={openPrimaryPicker}
                    >
                      {isSilencePanel ? (
                        <>
                          {isRenderableVideoPosterDataURL(primaryAsset.thumbnail) ? (
                            <img className="lovart-utility-card-thumb" src={primaryAsset.thumbnail} alt={primaryAsset.name || 'video'} />
                          ) : (
                            <span className="lovart-utility-card-thumb placeholder" />
                          )}
                          <span className="lovart-utility-card-play">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M8 5.14v13.72a1 1 0 001.5.86l11.04-6.86a1 1 0 000-1.72L9.5 4.28a1 1 0 00-1.5.86z" fill="#fff" /></svg>
                          </span>
                        </>
                      ) : (
                        <>
                          <AudioWaveIcon size={18} />
                          <span className="lovart-utility-card-label">音声</span>
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      className="lovart-frame-del"
                      onClick={(event) => {
                        event.stopPropagation()
                        patchFrameForm(isSilencePanel ? { silenceCutVideo: null } : { subtitleAudio: null })
                      }}
                    >
                      <CloseIcon />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    data-lovart-trigger={isSilencePanel ? 'silence-cut-video' : 'subtitle-audio'}
                    className="lovart-utility-tilt-card primary"
                    title={isSilencePanel ? '動画を添付' : '音声を添付'}
                    onClick={openPrimaryPicker}
                  >
                    <span className="lovart-add-plus">+</span>
                    {trayOpen ? <span className="lovart-utility-card-hint">{isSilencePanel ? '動画' : '音声'}</span> : null}
                  </button>
                )}
              </div>
              {!isSilencePanel ? (
                <div className="lovart-utility-slot script">
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
                        onClick={openScriptPicker}
                      >
                        <ScriptFileIcon size={24} />
                        <span className="lovart-utility-card-label">台本</span>
                      </button>
                      <button
                        type="button"
                        className="lovart-frame-del"
                        onClick={(event) => {
                          event.stopPropagation()
                          patchFrameForm({ subtitleScriptText: '', subtitleScriptName: '' })
                        }}
                      >
                        <CloseIcon />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="lovart-utility-tilt-card script"
                      title="台本を添付"
                      onClick={openScriptPicker}
                    >
                      <span className="lovart-add-plus">+</span>
                      {trayOpen ? <span className="lovart-utility-card-hint">台本</span> : null}
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          </div>
          {generationError ? <div className="lovart-error">{generationError}</div> : null}
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
                <div className="lovart-menu-wrap">
                  <button
                    type="button"
                    className={`lovart-pill${openMenu === 'glossary' ? ' tooltip-hidden' : ''}`}
                    data-lovart-trigger="subtitle-glossary"
                    onClick={() => {
                      const opening = openMenu !== 'glossary'
                      setOpenMenu(opening ? 'glossary' : null)
                      if (opening) {
                        setGlossaryStatus('')
                        fetch('/api/subtitle-glossary')
                          .then((response) => response.json())
                          .then((payload) => setGlossaryTerms(Array.isArray(payload.terms) ? payload.terms : []))
                          .catch(() => setGlossaryTerms([]))
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
                        {glossaryTerms === null ? (
                          <div className="lovart-glossary-empty">読み込み中...</div>
                        ) : glossaryTerms.length === 0 ? (
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
                          disabled={glossarySaving || glossaryTerms === null}
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
                      ? SILENCE_CUT_MODEL_OPTIONS.find(([value]) => value === frameForm.silenceCutModel)?.[1] ?? 'FFmpeg Local'
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
                      ? `無音 ${formatSilenceCutSecondsLabel(frameForm.silenceCutDetectSeconds)}以上・残す ${formatSilenceCutSecondsLabel(frameForm.silenceCutKeepSeconds)}`
                      : `${frameForm.subtitleMaxChars}字合計・${frameForm.subtitleLineCount}行`}
                  </span>
                  <ChevronIcon />
                </button>
                {openMenu === 'utility-settings' && !isSilencePanel ? (
                  <div className="lovart-menu wide lovart-video-settings lovart-utility-settings lovart-utility-pop" data-lovart-menu="subtitle-settings">
                    <div className="lovart-setting-row">
                      <div className="lovart-setting-label">
                        <div className="lovart-menu-header">最大文字数</div>
                        <span className="lovart-info-icon" data-lovart-tooltip="1つの字幕に表示する文字数の上限です。これを超える場合は字幕が分割されます。">i</span>
                      </div>
                      <span>{frameForm.subtitleMaxChars}字 合計</span>
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
                      <div className="lovart-menu-header">行数</div>
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
                        <div className="lovart-menu-header">最大表示時間</div>
                        <span className="lovart-info-icon" data-lovart-tooltip="音声が終わった後も、その字幕を画面に残しておく最大の時間です。次の字幕が来る場合は、次の字幕を優先します。">i</span>
                      </div>
                      <span>{Number(frameForm.subtitleHoldSeconds).toFixed(2)}秒</span>
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
                      <div className="lovart-menu-header">字幕末尾の句読点</div>
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
                        <div className="lovart-menu-header">フィラー処理</div>
                        <span className="lovart-info-icon" data-lovart-tooltip="えー・えっとなど明確なフィラーだけを処理します。こう・ちょっと・ねは文脈語として残します。">i</span>
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
                        <div className="lovart-menu-header">残す間</div>
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
                      <div className="lovart-menu-section-title">AIクリーンアップ</div>
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
                              <div className="lovart-menu-header">無音判定の音量</div>
                              <span className="lovart-info-icon" data-lovart-tooltip="マイクや部屋に合わせる校正値です。喋りの途中で切れるときは下げ、無音が残るときは上げてください。">i</span>
                            </div>
                            <span>{Math.round(frameForm.silenceCutThresholdDb)}dB</span>
                          </div>
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
                          {renderSilenceStepper('カット前の余白', 'silenceCutPreMarginSeconds', 0.05, 0.3, 0.01)}
                          {renderSilenceStepper('カット後の余白', 'silenceCutPostMarginSeconds', 0.05, 0.3, 0.01)}
                          {renderSilenceStepper('音声のつなぎ', 'silenceCutAudioFadeSeconds', 0, 0.1, 0.01)}
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
          <button type="button" onClick={closeCanvasPicker}>終了</button>
        </div>
      ) : null}
      <input
        ref={imageUploadInputRef}
        type="file"
        accept="image/*"
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
