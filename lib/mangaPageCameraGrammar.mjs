export const MANGA_PAGE_CAMERA_GRAMMAR_VERSION = "manga-page-camera-v2";

export const MANGA_SOURCE_VIEWPOINTS = Object.freeze(["left", "right", "top", "wide"]);
export const MANGA_WIDE_VIEWS = Object.freeze(["left-wide", "right-wide", "top-wide", "wide"]);
export const MANGA_CAMERA_MODES = Object.freeze([
  "pullout-only",
  "left-only",
  "right-only",
  "top-only",
  "left-then-pullout",
  "right-then-pullout",
  "top-then-pullout",
  "none",
]);

const EPSILON = 1e-7;
const finite = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const bounded = (value, minimum, maximum, fallback) => (
  Math.min(maximum, Math.max(minimum, finite(value, fallback)))
);
const rounded = (value) => Number(finite(value, 0).toFixed(6));

export function normalizeMangaSourceViewpoint(value, fallback = "wide") {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (MANGA_SOURCE_VIEWPOINTS.includes(normalized)) return normalized;
  if (/\b(left|left-side|left-profile)\b/u.test(normalized)) return "left";
  if (/\b(right|right-side|right-profile|reverse)\b/u.test(normalized)) return "right";
  if (/\b(top|top-view|overhead|bird.?s-eye)\b/u.test(normalized)) return "top";
  if (/\b(wide|establishing|long-shot)\b/u.test(normalized)) return "wide";
  return MANGA_SOURCE_VIEWPOINTS.includes(fallback) ? fallback : "wide";
}

export function mangaWideViewFor(viewpoint) {
  const source = normalizeMangaSourceViewpoint(viewpoint);
  return source === "wide" ? "wide" : `${source}-wide`;
}

export function normalizeMangaCameraMode(value, fallback = "pullout-only") {
  const normalized = String(value ?? "").trim().toLowerCase().replaceAll("_", "-");
  if (MANGA_CAMERA_MODES.includes(normalized)) return normalized;
  if (["pull-out", "pullout", "zoom-out", "wide"].includes(normalized)) return "pullout-only";
  const oldCombined = normalized.match(/^pullout-plus-(left|right|top)$/u);
  if (oldCombined) return `${oldCombined[1]}-then-pullout`;
  const newCombined = normalized.match(/^(left|right|top)-(?:then|plus)-(?:pull-?out|pullout)$/u);
  if (newCombined) return `${newCombined[1]}-then-pullout`;
  const directional = normalized.match(/^(left|right|top)(?:-only)?$/u);
  if (directional) return `${directional[1]}-only`;
  return MANGA_CAMERA_MODES.includes(fallback) ? fallback : "pullout-only";
}

export function mangaCameraModeFamily(mode) {
  const normalized = normalizeMangaCameraMode(mode);
  if (normalized === "none") return "static";
  if (normalized === "pullout-only") return "pullout";
  if (normalized.endsWith("-only")) return "directional";
  return "combined";
}

export function mangaCameraModeDirection(mode) {
  const normalized = normalizeMangaCameraMode(mode);
  return ["left", "right", "top"].find((direction) => normalized.startsWith(direction)) || "";
}

export function mangaCameraSafeRange(zoom, padding = 0.006) {
  const safeZoom = bounded(zoom, 1.000001, 2.2, 1.5);
  const edge = Math.min(0.5, 1 / (2 * safeZoom) + Math.max(0, finite(padding, 0)));
  return [edge, 1 - edge];
}

export function mangaCameraFocusIsSafe(value, zoom, padding = 0) {
  const [minimum, maximum] = mangaCameraSafeRange(zoom, padding);
  const numeric = finite(value, 0.5);
  return numeric >= minimum - EPSILON && numeric <= maximum + EPSILON;
}

function safeFocus(value, zoom, padding = 0.006) {
  const [minimum, maximum] = mangaCameraSafeRange(zoom, padding);
  return bounded(value, minimum, maximum, 0.5);
}

function intensityTravel(direction, intensity = "strong") {
  const level = String(intensity || "strong").toLowerCase();
  const horizontal = level === "subtle" ? 0.14 : level === "standard" ? 0.18 : 0.22;
  const vertical = level === "subtle" ? 0.12 : level === "standard" ? 0.16 : 0.19;
  return direction === "top" ? vertical : horizontal;
}

function cameraBase(source = {}) {
  return {
    saturation: bounded(source.saturation, 0.5, 1.8, 1),
    contrast: bounded(source.contrast, 0.7, 1.5, 1),
    brightness: bounded(source.brightness, -0.25, 0.25, 0),
    easing: "linear",
    motionLeadRatio: 0,
    motionTailRatio: 0,
  };
}

function pulloutCamera(source, options) {
  const defaultEnd = bounded(options.zoomEnd, 1.04, 1.24, 1.08);
  const zoomEnd = bounded(source.zoomEnd ?? source.zoom_end, 1.02, 1.3, defaultEnd);
  const minimumReveal = bounded(options.minimumReveal, 0.18, 0.4, 0.24);
  const defaultReveal = bounded(options.reveal, minimumReveal, 0.42, 0.3);
  const requestedStart = bounded(source.zoomStart ?? source.zoom_start, 1.08, 2.2, zoomEnd / (1 - defaultReveal));
  const zoomStart = Math.max(requestedStart, zoomEnd / (1 - minimumReveal));
  const focusX = safeFocus(source.focusX ?? source.focus_x, zoomEnd);
  const focusY = safeFocus(source.focusY ?? source.focus_y, zoomEnd);
  return {
    ...source,
    ...cameraBase(source),
    zoomStart: rounded(zoomStart),
    zoomEnd: rounded(zoomEnd),
    focusX: rounded(focusX),
    focusY: rounded(focusY),
    focusXEnd: rounded(focusX),
    focusYEnd: rounded(focusY),
    keyframes: [
      { at: 0, zoom: rounded(zoomStart), focusX: rounded(focusX), focusY: rounded(focusY) },
      { at: 1, zoom: rounded(zoomEnd), focusX: rounded(focusX), focusY: rounded(focusY) },
    ],
  };
}

function directionalEndpoints(direction, zoom, source, options) {
  const intensity = options.intensity ?? source.cameraIntensity ?? source.camera_intensity ?? "strong";
  const minimumTravel = bounded(options.minimumDirectionalTravel, 0.1, 0.3, direction === "top" ? 0.14 : 0.16);
  const travel = Math.max(minimumTravel, intensityTravel(direction, intensity));
  const [minimum, maximum] = mangaCameraSafeRange(zoom);
  let focusX = safeFocus(source.focusX ?? source.focus_x, zoom);
  let focusY = safeFocus(source.focusY ?? source.focus_y, zoom);
  let focusXEnd = safeFocus(source.focusXEnd ?? source.focus_x_end, zoom);
  let focusYEnd = safeFocus(source.focusYEnd ?? source.focus_y_end, zoom);
  const validRequested = direction === "left"
    ? focusX - focusXEnd >= minimumTravel
    : direction === "right"
      ? focusXEnd - focusX >= minimumTravel
      : focusY - focusYEnd >= minimumTravel;
  if (!validRequested) {
    const usableTravel = Math.min(travel, Math.max(0.1, maximum - minimum - 0.01));
    if (direction === "left") {
      focusX = Math.min(maximum, 0.5 + usableTravel / 2);
      focusXEnd = Math.max(minimum, focusX - usableTravel);
      focusYEnd = focusY;
    } else if (direction === "right") {
      focusX = Math.max(minimum, 0.5 - usableTravel / 2);
      focusXEnd = Math.min(maximum, focusX + usableTravel);
      focusYEnd = focusY;
    } else {
      focusY = Math.min(maximum, 0.5 + usableTravel / 2);
      focusYEnd = Math.max(minimum, focusY - usableTravel);
      focusXEnd = focusX;
    }
  } else if (direction !== "top") {
    focusYEnd = focusY;
  } else {
    focusXEnd = focusX;
  }
  return { focusX, focusY, focusXEnd, focusYEnd };
}

function directionalCamera(source, direction, options) {
  const zoom = bounded(source.zoomStart ?? source.zoom_start, 1.4, 1.9, direction === "top" ? 1.58 : 1.52);
  const points = directionalEndpoints(direction, zoom, source, options);
  return {
    ...source,
    ...cameraBase(source),
    zoomStart: rounded(zoom),
    zoomEnd: rounded(zoom),
    focusX: rounded(points.focusX),
    focusY: rounded(points.focusY),
    focusXEnd: rounded(points.focusXEnd),
    focusYEnd: rounded(points.focusYEnd),
    keyframes: [
      { at: 0, zoom: rounded(zoom), focusX: rounded(points.focusX), focusY: rounded(points.focusY) },
      { at: 1, zoom: rounded(zoom), focusX: rounded(points.focusXEnd), focusY: rounded(points.focusYEnd) },
    ],
  };
}

function combinedCamera(source, direction, options) {
  const phase = bounded(options.directionPhase ?? source.directionPhase ?? source.direction_phase, 0.42, 0.7, 0.56);
  const zoomStart = bounded(source.zoomStart ?? source.zoom_start, 1.48, 2.1, direction === "top" ? 1.68 : 1.64);
  const zoomEnd = bounded(source.zoomEnd ?? source.zoom_end, 1.04, 1.24, 1.12);
  const finalRange = mangaCameraSafeRange(zoomEnd);
  const intensity = options.intensity ?? source.cameraIntensity ?? source.camera_intensity ?? "strong";
  const requestedTravel = intensityTravel(direction, intensity);
  const minimumTravel = bounded(options.minimumCombinedTravel, 0.1, 0.26, direction === "top" ? 0.14 : 0.16);
  const travel = Math.max(requestedTravel, minimumTravel);
  let focusX = safeFocus(source.focusX ?? source.focus_x, zoomStart);
  let focusY = safeFocus(source.focusY ?? source.focus_y, zoomStart);
  let destinationX = safeFocus(source.focusXEnd ?? source.focus_x_end, zoomEnd);
  let destinationY = safeFocus(source.focusYEnd ?? source.focus_y_end, zoomEnd);
  if (direction === "left") {
    destinationX = Math.max(finalRange[0], Math.min(finalRange[1], 0.46));
    focusX = safeFocus(destinationX + travel, zoomStart);
    focusY = destinationY;
  } else if (direction === "right") {
    destinationX = Math.max(finalRange[0], Math.min(finalRange[1], 0.54));
    focusX = safeFocus(destinationX - travel, zoomStart);
    focusY = destinationY;
  } else {
    destinationY = Math.max(finalRange[0], Math.min(finalRange[1], 0.46));
    focusY = safeFocus(destinationY + travel, zoomStart);
    focusX = destinationX;
  }
  // The last phase must begin exactly where the directional phase ended.
  // No reset to the opening crop is allowed before the pull-out.
  const start = { at: 0, zoom: rounded(zoomStart), focusX: rounded(focusX), focusY: rounded(focusY) };
  const reached = { at: rounded(phase), zoom: rounded(zoomStart), focusX: rounded(destinationX), focusY: rounded(destinationY) };
  const end = { at: 1, zoom: rounded(zoomEnd), focusX: rounded(destinationX), focusY: rounded(destinationY) };
  return {
    ...source,
    ...cameraBase(source),
    zoomStart: start.zoom,
    zoomEnd: end.zoom,
    focusX: start.focusX,
    focusY: start.focusY,
    focusXEnd: end.focusX,
    focusYEnd: end.focusY,
    directionPhase: reached.at,
    keyframes: [start, reached, end],
  };
}

export function normalizeMangaCameraTransform(value = {}, mode = "pullout-only", options = {}) {
  const source = value && typeof value === "object" ? value : {};
  const normalizedMode = normalizeMangaCameraMode(mode ?? source.cameraMode ?? source.camera_mode);
  const family = mangaCameraModeFamily(normalizedMode);
  if (family === "static") {
    const zoom = bounded(source.zoomStart ?? source.zoom_start, 1, 2.2, 1);
    const focusX = safeFocus(source.focusX ?? source.focus_x, zoom, 0);
    const focusY = safeFocus(source.focusY ?? source.focus_y, zoom, 0);
    return {
      ...source,
      ...cameraBase(source),
      zoomStart: zoom,
      zoomEnd: zoom,
      focusX,
      focusY,
      focusXEnd: focusX,
      focusYEnd: focusY,
      keyframes: [],
    };
  }
  if (family === "pullout") return pulloutCamera(source, options);
  const direction = mangaCameraModeDirection(normalizedMode);
  if (family === "directional") return directionalCamera(source, direction, options);
  return combinedCamera(source, direction, options);
}

// Backward-compatible export retained for old scripts.
export function normalizeMangaPullOutCamera(value = {}, options = {}) {
  return normalizeMangaCameraTransform(value, "pullout-only", options);
}

export function applyMangaCameraGrammarToShot(shot = {}, viewpoint, requestedMode) {
  const sourceViewpoint = normalizeMangaSourceViewpoint(viewpoint ?? shot.viewpoint ?? shot.angle);
  const staticEditorialPlate = shot.motion === "none"
    && shot.editorialPlate?.characterPolicy === "strictly-none"
    && shot.editorialPlate?.environmentPolicy === "none";
  if (staticEditorialPlate) {
    return {
      ...shot,
      angle: "editorial-plate",
      viewpoint: "graphic",
      endView: "graphic",
      viewFamily: "graphic",
      shotType: "editorial-plate",
      cameraMode: "none",
    };
  }
  const fallbackMode = sourceViewpoint === "wide" ? "pullout-only" : `${sourceViewpoint}-only`;
  const cameraMode = normalizeMangaCameraMode(requestedMode ?? shot.cameraMode ?? shot.camera_mode ?? shot.motion, fallbackMode);
  const family = mangaCameraModeFamily(cameraMode);
  const endView = family === "pullout" || family === "combined"
    ? mangaWideViewFor(sourceViewpoint)
    : sourceViewpoint;
  return {
    ...shot,
    angle: sourceViewpoint,
    viewpoint: sourceViewpoint,
    endView,
    viewFamily: sourceViewpoint,
    shotType: endView,
    motion: cameraMode,
    cameraMode,
    camera: normalizeMangaCameraTransform(shot.camera, cameraMode, {
      intensity: shot.cameraIntensity ?? shot.camera_intensity ?? "strong",
    }),
    cameraGrammarVersion: MANGA_PAGE_CAMERA_GRAMMAR_VERSION,
  };
}

export function applyMangaCameraGrammarToPanelLayout(layout = {}, viewpoint = "wide", requestedMode) {
  const sourceViewpoint = normalizeMangaSourceViewpoint(viewpoint ?? layout.pageViewpoint);
  const fallbackMode = sourceViewpoint === "wide" ? "pullout-only" : `${sourceViewpoint}-only`;
  const pageCameraMode = normalizeMangaCameraMode(
    requestedMode ?? layout.pageCameraMode ?? layout.page_camera_mode ?? layout.pageMotion,
    fallbackMode,
  );
  const family = mangaCameraModeFamily(pageCameraMode);
  return {
    ...layout,
    composition: "post-composite-then-flatten",
    motionPolicy: "whole-page",
    flattenBeforeCamera: true,
    panelCamera: "static",
    pageViewpoint: sourceViewpoint,
    pageEndView: family === "pullout" || family === "combined" ? mangaWideViewFor(sourceViewpoint) : sourceViewpoint,
    pageMotion: pageCameraMode,
    pageCameraMode,
    pageCamera: normalizeMangaCameraTransform(layout.pageCamera ?? layout.page_camera, pageCameraMode, {
      intensity: layout.cameraIntensity ?? layout.camera_intensity ?? "strong",
    }),
    cameraGrammarVersion: MANGA_PAGE_CAMERA_GRAMMAR_VERSION,
    panels: Array.isArray(layout.panels)
      ? layout.panels.map((panel) => {
          const camera = panel?.camera && typeof panel.camera === "object" ? panel.camera : {};
          return { ...panel, motion: "none", camera: normalizeMangaCameraTransform(camera, "none") };
        })
      : [],
  };
}

export function cameraHasPushIn(camera = {}) {
  const keyframes = Array.isArray(camera.keyframes) && camera.keyframes.length >= 2
    ? camera.keyframes
    : [
        { zoom: finite(camera.zoomStart, 1) },
        { zoom: finite(camera.zoomEnd, finite(camera.zoomStart, 1)) },
      ];
  return keyframes.some((entry, index) => index > 0 && finite(entry.zoom, 1) > finite(keyframes[index - 1].zoom, 1) + EPSILON);
}

function cameraKeyframes(camera = {}) {
  return Array.isArray(camera.keyframes) && camera.keyframes.length >= 2
    ? camera.keyframes
    : [
        { at: 0, zoom: finite(camera.zoomStart, 1), focusX: finite(camera.focusX, 0.5), focusY: finite(camera.focusY, 0.45) },
        { at: 1, zoom: finite(camera.zoomEnd, finite(camera.zoomStart, 1)), focusX: finite(camera.focusXEnd, finite(camera.focusX, 0.5)), focusY: finite(camera.focusYEnd, finite(camera.focusY, 0.45)) },
      ];
}

function auditCameraForMode(camera = {}, mode, context = {}) {
  const violations = [];
  const normalizedMode = normalizeMangaCameraMode(mode);
  const family = mangaCameraModeFamily(normalizedMode);
  const direction = mangaCameraModeDirection(normalizedMode);
  const keyframes = cameraKeyframes(camera);
  const prefix = context.prefix || "";
  const withContext = (type, extra = {}) => violations.push({ type: `${prefix}${type}`, ...context.data, ...extra });
  if (cameraHasPushIn(camera)) withContext("push-in-zoom");
  if (camera.easing !== "linear") withContext("non-linear-easing", { value: camera.easing });
  if (finite(camera.motionLeadRatio, 0) > EPSILON || finite(camera.motionTailRatio, 0) > EPSILON) {
    withContext("lead-or-tail-hold");
  }
  for (let index = 0; index < keyframes.length; index += 1) {
    const keyframe = keyframes[index];
    if (!mangaCameraFocusIsSafe(keyframe.focusX, keyframe.zoom)
      || !mangaCameraFocusIsSafe(keyframe.focusY, keyframe.zoom)) {
      withContext("crop-boundary-collision", { keyframeIndex: index, keyframe });
    }
    if (index === 0) continue;
    const previous = keyframes[index - 1];
    if (finite(keyframe.focusY, 0) > finite(previous.focusY, 0) + EPSILON) {
      withContext("downward-focus-travel", { segmentIndex: index - 1 });
    }
  }
  const first = keyframes[0];
  const last = keyframes.at(-1);
  const dx = finite(last.focusX, 0.5) - finite(first.focusX, 0.5);
  const dy = finite(last.focusY, 0.45) - finite(first.focusY, 0.45);
  const zoomDelta = finite(last.zoom, 1) - finite(first.zoom, 1);
  if (family === "pullout") {
    if (!(zoomDelta < -0.12)) withContext("pullout-too-weak", { zoomDelta });
    if (Math.hypot(dx, dy) > EPSILON) withContext("pullout-has-hidden-direction", { dx, dy });
  }
  if (family === "directional") {
    if (Math.abs(zoomDelta) > EPSILON) withContext("directional-has-hidden-zoom", { zoomDelta });
    const signedTravel = direction === "left" ? -dx : direction === "right" ? dx : -dy;
    const minimum = direction === "top" ? 0.12 : 0.14;
    if (signedTravel < minimum - EPSILON) withContext("directional-travel-too-weak-or-wrong", { direction, signedTravel });
    if (direction !== "top" && Math.abs(dy) > EPSILON) withContext("directional-cross-axis-drift", { dy });
    if (direction === "top" && Math.abs(dx) > EPSILON) withContext("directional-cross-axis-drift", { dx });
  }
  if (family === "combined") {
    if (keyframes.length !== 3) withContext("combined-needs-three-keyframes", { count: keyframes.length });
    if (keyframes.length >= 3) {
      const reached = keyframes[1];
      const end = keyframes[2];
      const firstDirectionalTravel = direction === "left"
        ? first.focusX - reached.focusX
        : direction === "right"
          ? reached.focusX - first.focusX
          : first.focusY - reached.focusY;
      if (firstDirectionalTravel < (direction === "top" ? 0.12 : 0.14) - EPSILON) {
        withContext("combined-direction-too-weak-or-wrong", { direction, firstDirectionalTravel });
      }
      if (Math.abs(reached.zoom - first.zoom) > EPSILON) withContext("combined-first-phase-must-be-direction-only");
      if (Math.abs(end.focusX - reached.focusX) > EPSILON || Math.abs(end.focusY - reached.focusY) > EPSILON) {
        withContext("combined-reset-before-pullout");
      }
      if (!(end.zoom < reached.zoom - 0.12)) withContext("combined-pullout-too-weak");
      if (reached.at < 0.42 || reached.at > 0.7) withContext("combined-invalid-phase-boundary", { at: reached.at });
    }
  }
  return violations;
}

export function auditMangaShotCameraGrammar(shot = {}) {
  const staticEditorialPlate = shot.motion === "none"
    && shot.editorialPlate?.characterPolicy === "strictly-none"
    && shot.editorialPlate?.environmentPolicy === "none";
  if (staticEditorialPlate) return [];
  const violations = [];
  if (!MANGA_SOURCE_VIEWPOINTS.includes(shot.viewpoint)) {
    violations.push({ type: "non-semantic-source-viewpoint", shotId: shot.id, value: shot.viewpoint });
  }
  const mode = normalizeMangaCameraMode(shot.cameraMode ?? shot.camera_mode ?? shot.motion);
  const direction = mangaCameraModeDirection(mode);
  if (direction && shot.viewpoint !== direction) {
    violations.push({ type: "camera-mode-viewpoint-mismatch", shotId: shot.id, viewpoint: shot.viewpoint, mode });
  }
  const family = mangaCameraModeFamily(mode);
  const expectedEndView = family === "pullout" || family === "combined" ? mangaWideViewFor(shot.viewpoint) : shot.viewpoint;
  if (shot.endView !== expectedEndView) {
    violations.push({ type: "camera-end-view-mismatch", shotId: shot.id, expectedEndView, endView: shot.endView });
  }
  violations.push(...auditCameraForMode(shot.camera || {}, mode, { data: { shotId: shot.id, mode } }));
  return violations;
}

export function auditMangaPanelPageCameraGrammar(layout = {}, cutId = "") {
  if (!layout?.enabled) return [];
  const violations = [];
  if (layout.composition !== "post-composite-then-flatten"
    || layout.motionPolicy !== "whole-page"
    || layout.flattenBeforeCamera !== true
    || layout.panelCamera !== "static") {
    violations.push({ type: "split-page-not-flattened-before-camera", cutId });
  }
  const mode = normalizeMangaCameraMode(layout.pageCameraMode ?? layout.page_camera_mode ?? layout.pageMotion);
  const direction = mangaCameraModeDirection(mode);
  if (!MANGA_SOURCE_VIEWPOINTS.includes(layout.pageViewpoint)) {
    violations.push({ type: "split-page-non-semantic-viewpoint", cutId, value: layout.pageViewpoint });
  }
  if (direction && layout.pageViewpoint !== direction) {
    violations.push({ type: "split-page-mode-viewpoint-mismatch", cutId, viewpoint: layout.pageViewpoint, mode });
  }
  const family = mangaCameraModeFamily(mode);
  const expectedEndView = family === "pullout" || family === "combined"
    ? mangaWideViewFor(layout.pageViewpoint)
    : layout.pageViewpoint;
  if (layout.pageEndView !== expectedEndView) {
    violations.push({ type: "split-page-end-view-mismatch", cutId, expectedEndView, value: layout.pageEndView });
  }
  violations.push(...auditCameraForMode(layout.pageCamera ?? layout.page_camera, mode, {
    prefix: "split-page-",
    data: { cutId, mode },
  }));
  if ((layout.panels || []).some((panel) => panel.motion !== "none"
    || finite(panel.camera?.zoomStart, 1) !== finite(panel.camera?.zoomEnd, 1)
    || finite(panel.camera?.focusX, 0.5) !== finite(panel.camera?.focusXEnd, 0.5)
    || finite(panel.camera?.focusY, 0.45) !== finite(panel.camera?.focusYEnd, 0.45))) {
    violations.push({ type: "split-panel-camera-not-static", cutId });
  }
  return violations;
}
