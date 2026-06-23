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
  resolution: '720p'
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
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M7 15l3.2-3.2a1.4 1.4 0 0 1 2 0L16 15.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16.5" cy="9.5" r="1.5" fill="currentColor" />
    </svg>
  )
}

function FrameCenterIcon({ size = 52 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <rect x="15" y="18" width="34" height="28" rx="5" stroke="currentColor" strokeWidth="3" />
      <path d="M19 41l11-11 8 8 5-5 6 6" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="41" cy="27" r="3" fill="currentColor" />
    </svg>
  )
}

function VideoCenterIcon({ size = 52 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <rect x="14" y="20" width="28" height="24" rx="5" stroke="currentColor" strokeWidth="3" />
      <path d="M42 28l9-5v18l-9-5V28z" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
      <path d="M25 27v10l8-5-8-5z" fill="currentColor" />
    </svg>
  )
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
    files: scene.files && typeof scene.files === 'object' ? scene.files : {}
  }
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
    elements: [...elements],
    appState: serializableAppState(appState),
    files: files && typeof files === 'object' ? files : {}
  }
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
    .map((element) => element.index)
    .filter((index) => typeof index === 'string')
    .sort()
  return generateKeyBetween(indexes.at(-1) ?? null, null)
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

function getPanelPlacementFromViewportTarget(target, isVideo = false) {
  const frameViewportWidth = Math.max(1, Number(target?.width) || 1)
  const frameViewportHeight = Math.max(1, Number(target?.height) || 1)
  const panelWidth = isVideo
    ? GENERATOR_PANEL_VIDEO_WIDTH
    : clamp(Math.round(frameViewportWidth * 0.9), GENERATOR_PANEL_IMAGE_MIN_WIDTH, GENERATOR_PANEL_IMAGE_MAX_WIDTH)

  return {
    left: Math.round((Number(target?.left) || 0) + frameViewportWidth / 2 - panelWidth / 2),
    top: Math.round((Number(target?.top) || 0) + frameViewportHeight + 4),
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
    showLoading: safeWidth >= 86 && safeHeight >= 86
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
  return {
    ...DEFAULT_FRAME_FORM,
    prompt:
      typeof customData.generatorPrompt === 'string'
        ? customData.generatorPrompt
        : typeof customData.videoPrompt === 'string'
          ? customData.videoPrompt
          : '',
    imageModel: customData.generatorModel || customData.codexGenerationModel || DEFAULT_FRAME_FORM.imageModel,
    videoModel: customData.videoModel || customData.codexGenerationModel || DEFAULT_FRAME_FORM.videoModel,
    aspectRatio: customData.generatorAspectRatio || customData.codexGenerationAspectRatio || DEFAULT_FRAME_FORM.aspectRatio,
    videoAspectRatio: customData.videoAspectRatio || customData.codexGenerationAspectRatio || DEFAULT_FRAME_FORM.videoAspectRatio,
    quality: customData.generatorImageQuality || customData.codexGenerationQuality || DEFAULT_FRAME_FORM.quality,
    duration: customData.videoDuration || customData.codexGenerationDuration || DEFAULT_FRAME_FORM.duration,
    resolution: customData.videoResolution || customData.codexGenerationResolution || DEFAULT_FRAME_FORM.resolution
  }
}

function frameCustomDataFromForm(kind, form) {
  return kind === 'video'
    ? {
        videoPrompt: form.prompt,
        videoModel: form.videoModel,
        videoAspectRatio: form.videoAspectRatio,
        videoDuration: form.duration,
        videoResolution: form.resolution
      }
    : {
        generatorPrompt: form.prompt,
        generatorModel: form.imageModel,
        generatorAspectRatio: form.aspectRatio,
        generatorImageQuality: form.quality,
        generatorImageSize: '1K'
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
  const [pendingPanelFrame, setPendingPanelFrame] = useState(null)
  const [selectedGeneratedResult, setSelectedGeneratedResult] = useState(null)
  const [openMenu, setOpenMenu] = useState(null)
  const [generationError, setGenerationError] = useState('')
  const [generatingFrameIds, setGeneratingFrameIds] = useState(() => new Set())
  const [capabilities, setCapabilities] = useState(null)
  const latestSceneRef = useRef(DEFAULT_SCENE)
  const activeFrameIdRef = useRef('')
  const pendingPanelFrameRef = useRef(null)
  const selectedGeneratedResultRef = useRef(null)
  const previousGeneratorFrameIdsRef = useRef(new Set())
  const justCreatedFrameIdRef = useRef('')
  const copiedGeneratorFrameRef = useRef(null)
  const lastCreatedFrameGeoRef = useRef(null)
  const lastCreatedViewRef = useRef(null)
  const isAnimatingScrollRef = useRef(false)
  const scrollAnimGenerationRef = useRef(0)
  const isDraggingGeneratorRef = useRef(false)
  const suppressNextChangeRef = useRef(false)
  const saveTimerRef = useRef(null)
  const selectionTimerRef = useRef(null)
  const lastSelectionRef = useRef('')
  const applyingRemoteRef = useRef(false)
  const hasLocalChangesRef = useRef(false)

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
    try {
      await fetch(CANVAS_ENDPOINT, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(scene)
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
      activeFrameIdRef.current = selectedFrameId
      setActiveFrameId(selectedFrameId)
      setPendingPanelFrame(null)
      setSelectedGeneratedResult(null)
      setOpenMenu(null)
      setGenerationError('')
      setActiveFrameKind(getGeneratorKind(selectedFrame))
      setFrameForm(frameFormFromElement(selectedFrame))
      return
    }

    if (selectedResultId) {
      const selectedResult = elementsById.get(selectedResultId)
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
      setOpenMenu(null)
      setGenerationError('')
      setActiveFrameKind(kind)
      setFrameForm(frameFormFromElement(selectedResult))
      return
    }

    const pending = pendingPanelFrameRef.current
    if (pending && isGeneratorFrame(elementsById.get(pending.id))) {
      activeFrameIdRef.current = pending.id
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

  const handleChange = useCallback(
    (elements, appState, files) => {
      const shouldSkipChangeEffects = suppressNextChangeRef.current
      if (suppressNextChangeRef.current) suppressNextChangeRef.current = false
      let workingElements = [...elements]

      if (!shouldSkipChangeEffects && api) {
        const normalizedElements = normalizeGeneratorFrameVisuals(workingElements)
        if (normalizedElements) {
          suppressNextChangeRef.current = true
          api.updateScene({
            elements: normalizedElements,
            captureUpdate: CaptureUpdateAction.NEVER
          })
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
          let sourceFrame = null

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
          const selectedSourceId = sourceFrame?.id ?? ''
          const selectedSourceFrame = selectedSourceId
            ? workingElements.find((element) => element.id === selectedSourceId)
            : null
          const selectedFrameId = selectedSourceId || firstAdded.id
          const selectedFrame = selectedSourceFrame || workingElements.find((element) => element.id === firstAdded.id)
          const selectedKind = getGeneratorKind(selectedFrame)
          const selectedAppState = { ...appState, selectedElementIds: selectedFrameId ? { [selectedFrameId]: true } : {} }
          const nextScene = createScene(workingElements, selectedAppState, files)
          latestSceneRef.current = nextScene
          suppressNextChangeRef.current = true
          activeFrameIdRef.current = selectedFrameId
          setActiveFrameId(selectedFrameId)
          setActiveFrameKind(selectedKind)
          setFrameForm(frameFormFromElement(selectedFrame))
          setPendingPanelFrame(null)
          setSelectedGeneratedResult(null)
          setOpenMenu(null)
          setFrameOverlays(buildFrameOverlays(nextScene))
          scheduleSelectionSave(nextScene)
          scheduleCanvasSave(nextScene)
          api.updateScene({
            elements: workingElements,
            appState: { selectedElementIds: selectedAppState.selectedElementIds },
            captureUpdate: CaptureUpdateAction.IMMEDIATELY
          })
          return
        }
      }

      const scene = createScene(workingElements, appState, files)
      latestSceneRef.current = scene
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
      latestSceneRef.current = normalized
      previousGeneratorFrameIdsRef.current = new Set(normalized.elements.filter(isGeneratorFrame).map((element) => element.id))
      syncGeneratorUi(normalized)
      applyingRemoteRef.current = true
      suppressNextChangeRef.current = true
      try {
        api.addFiles(Object.values(normalized.files))
        api.updateScene({
          elements: normalized.elements,
          appState: normalized.appState,
          captureUpdate: CaptureUpdateAction.NEVER
        })
      } finally {
        window.setTimeout(() => {
          applyingRemoteRef.current = false
        }, 3000)
      }
    },
    [api]
  )

  useEffect(() => {
    if (!api || !('EventSource' in window)) return undefined

    async function loadRemoteCanvas() {
      try {
        const response = await fetch(CANVAS_ENDPOINT)
        if (!response.ok) throw new Error(`Failed to refresh canvas: ${response.status}`)
        const payload = await response.json()
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
    const onKeyDown = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return
      const key = event.key.toLowerCase()
      const appState = api.getAppState?.() ?? {}
      if (key === 'c') {
        const selectedIds = new Set(getSelectedIds(appState))
        const selectedFrame = api.getSceneElementsIncludingDeleted()
          .find((element) => selectedIds.has(element.id) && isGeneratorFrame(element))
        copiedGeneratorFrameRef.current = selectedFrame ? { ...selectedFrame, customData: { ...(selectedFrame.customData ?? {}) } } : null
        return
      }
      if (key !== 'v' || isEditableTarget(document.activeElement)) return
      const copiedFrame = copiedGeneratorFrameRef.current
      if (!copiedFrame) return
      event.preventDefault()
      event.stopPropagation()
      const now = Date.now()
      const newFrame = {
        ...copiedFrame,
        id: crypto.randomUUID(),
        x: (Number(copiedFrame.x) || 0) + 20,
        y: (Number(copiedFrame.y) || 0) + 20,
        version: 1,
        versionNonce: Math.floor(Math.random() * 2 ** 31),
        seed: Math.floor(Math.random() * 2 ** 31),
        updated: now,
        customData: { ...(copiedFrame.customData ?? {}) }
      }
      api.updateScene({
        elements: [...api.getSceneElementsIncludingDeleted(), newFrame],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY
      })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [api])

  useEffect(() => {
    return () => {
      window.clearTimeout(saveTimerRef.current)
      window.clearTimeout(selectionTimerRef.current)
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
      api.updateScene({
        elements: nextElements,
        captureUpdate: CaptureUpdateAction.NEVER
      })
      const nextScene = createScene(nextElements, api.getAppState(), api.getFiles())
      latestSceneRef.current = nextScene
      setFrameOverlays(buildFrameOverlays(nextScene))
      scheduleCanvasSave(nextScene)
    },
    [api, scheduleCanvasSave]
  )

  const updateFrameForm = useCallback(
    (key, value) => {
      setFrameForm((current) => {
        const next = { ...current, [key]: value }
        updateActiveFrameElement(next)
        return next
      })
      setGenerationError('')
    },
    [updateActiveFrameElement]
  )

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
          const targetScreenY = Math.min(viewportHeight * targetScreenRatio, Math.max(120, viewportHeight - 195))
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
            const targetScreenY = Math.min(viewportHeight * targetScreenRatio, Math.max(120, viewportHeight - 195))
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
          if (rawProgress < 1) {
            requestAnimationFrame(animateStep)
          } else {
            isAnimatingScrollRef.current = false
            lastCreatedViewRef.current = { scrollX, scrollY, zoom }
          }
        }
        requestAnimationFrame(animateStep)
      } else if (!isAnimatingScrollRef.current) {
        lastCreatedViewRef.current = { scrollX: nextScrollX, scrollY: nextScrollY, zoom: nextZoom }
      }

      if (openPanel) {
        activeFrameIdRef.current = nextFrame.id
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
    let frameId = activeFrameIdRef.current
    let retryFrame = null
    if (!frameId && selectedGeneratedResult) {
      const kind = selectedGeneratedResult.kind
      const form = { ...frameForm, prompt: frameForm.prompt.trim() }
      const inserted = insertGeneratorFrame(kind, form, { selectFrame: false, openPanel: false })
      retryFrame = inserted?.frame ?? null
      frameId = retryFrame?.id ?? ''
      if (inserted?.scene) await saveCanvas(inserted.scene)
    }
    if (!frameId || generatingFrameIds.has(frameId)) return
    const scene = latestSceneRef.current
    const frame = retryFrame || scene.elements.find((element) => element.id === frameId)
    if (!frame || !isGeneratorFrame(frame)) return

    const kind = getGeneratorKind(frame)
    const prompt = frameForm.prompt.trim()
    if (!prompt) {
      setGenerationError('プロンプトを入力してください。')
      return
    }

    const savedForm = { ...frameForm, prompt }
    updateActiveFrameElement(savedForm)
    setOpenMenu(null)
    setGenerationError('')
    setGeneratingFrameIds((current) => new Set(current).add(frameId))
    setPendingPanelFrame(null)
    setSelectedGeneratedResult(null)
    activeFrameIdRef.current = ''
    setActiveFrameId('')
    if (api) {
      suppressNextChangeRef.current = true
      api.updateScene({
        appState: { selectedElementIds: {} },
        captureUpdate: CaptureUpdateAction.NEVER
      })
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
              anchorElementId: frameId,
              placement: 'replace',
              replaceAnchor: true,
              matchAnchor: true,
              displayWidth: frame.width,
              displayHeight: frame.height
            }
          : {
              prompt,
              model: savedForm.imageModel,
              aspectRatio: savedForm.aspectRatio,
              quality: savedForm.quality,
              anchorElementId: frameId,
              placement: 'replace',
              replaceAnchor: true,
              matchAnchor: true,
              displayWidth: frame.width,
              displayHeight: frame.height
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
        applyRemoteScene(canvasPayload.scene, { force: true })
      }
    } catch (error) {
      setGenerationError(error.message)
    } finally {
      setGeneratingFrameIds((current) => {
        const next = new Set(current)
        next.delete(frameId)
        return next
      })
    }
  }, [api, applyRemoteScene, frameForm, generatingFrameIds, insertGeneratorFrame, saveCanvas, selectedGeneratedResult, updateActiveFrameElement])

  if (!initialScene) {
    return <main className="codex-excalidraw-status">Loading canvas...</main>
  }

  if (loadError) {
    return <main className="codex-excalidraw-status">Canvas file could not be loaded.</main>
  }

  const activeOverlay = frameOverlays.find((overlay) => overlay.id === activeFrameId)
  const isCurrentFrameGenerating = activeFrameId ? generatingFrameIds.has(activeFrameId) : false
  const activePanelTarget = activeOverlay ?? selectedGeneratedResult
  const showPromptPanel = Boolean(activePanelTarget && !isCurrentFrameGenerating)
  const imageModels = capabilities?.imageModels ?? [
    { id: 'gpt-image-2-codex', label: 'GPT-Image-2.0(Codex)' },
    { id: 'grok-imagine-image-hermes', label: 'Grok Imagine(Hermes)' }
  ]
  const videoModels = capabilities?.videoModels ?? [{ id: 'grok-imagine-video-hermes', label: 'Grok Imagine(Hermes)' }]
  const imageModelLabel = imageModels.find((model) => model.id === frameForm.imageModel)?.label ?? frameForm.imageModel
  const videoModelLabel = videoModels.find((model) => model.id === frameForm.videoModel)?.label ?? frameForm.videoModel
  const panelPlacement = activePanelTarget
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

  return (
    <main className={`codex-excalidraw-shell lovart-ai-root${showPromptPanel ? ' hide-generator-props' : ''}`} aria-label="Codex Excalidraw canvas">
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
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => createGeneratorFrame('image')}
          >
            <ImageGeneratorToolIcon />
          </button>
          <button
            type="button"
            className="lovart-ai-button"
            aria-label="動画ジェネレーター"
            data-lovart-tooltip="動画ジェネレーター"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => createGeneratorFrame('video')}
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

      {showPromptPanel ? (
        <section className="lovart-ai-panel" style={panelStyle} aria-label={activeFrameKind === 'video' ? 'Video Generator' : 'Image Generator'}>
          <div className={activeFrameKind === 'video' ? 'lovart-prompt-wrap has-video-slots' : 'lovart-prompt-wrap'}>
            <textarea
              className="lovart-ai-prompt"
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
            {activeFrameKind === 'video' ? (
              <div className="lovart-video-frame-tray">
                {['start', 'end'].map((slot, index) => (
                  <button
                    type="button"
                    key={slot}
                    className={`lovart-add-frame-btn ${slot}`}
                    title={slot === 'start' ? '開始フレーム' : '終了フレーム'}
                    onClick={() => setOpenMenu(null)}
                  >
                    <span className="lovart-add-plus">+</span>
                    <span className="lovart-add-label">{slot === 'start' ? '開始' : '終了'}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {generationError ? <div className="lovart-error">{generationError}</div> : null}
          <div className="lovart-ai-bottom">
            <div className="lovart-ai-left">
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
                    data-lovart-tooltip="画像参照"
                    onClick={() => setOpenMenu((current) => (current === 'asset' ? null : 'asset'))}
                  >
                    <PhotoIcon />
                  </button>
                  {openMenu === 'asset' ? (
                    <div className="lovart-menu" data-lovart-menu="asset">
                      <button type="button" onClick={() => setOpenMenu(null)}>
                        <span>画像をアップロード</span>
                      </button>
                      <button type="button" onClick={() => setOpenMenu(null)}>
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
                            <span>{ratio}</span>
                          </button>
                        ))}
                      </div>
                      <div className="lovart-menu-header">Duration</div>
                      <input
                        type="range"
                        min="1"
                        max="15"
                        step="1"
                        className="lovart-duration-slider"
                        value={frameForm.duration}
                        onChange={(event) => updateFrameForm('duration', event.target.value)}
                      />
                      <div className="lovart-menu-header">Quality</div>
                      <div className="lovart-menu-grid">
                        {['720p', '1080p'].map((resolution) => (
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
                {isCurrentFrameGenerating ? <span>...</span> : <span>0</span>}
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </main>
  )
}
