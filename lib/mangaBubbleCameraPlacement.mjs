import { createHash } from "node:crypto";

const HARD_FACE_KINDS = new Set([
  "face",
  "mouth",
  "head",
  "speaker-face",
  "speaker-head",
  "active-speaker",
  "active-speaker-face",
  "active-speaker-head",
]);

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, finiteNumber(value, minimum)));
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function cameraAtProgress(camera = {}, rawProgress = 0) {
  const progress = clamp(rawProgress);
  const fallbackStart = {
    at: 0,
    zoom: Math.max(1e-6, finiteNumber(camera.zoomStart, 1)),
    focusX: clamp(finiteNumber(camera.focusX, 0.5), 0, 1),
    focusY: clamp(finiteNumber(camera.focusY, 0.5), 0, 1),
  };
  const fallbackEnd = {
    at: 1,
    zoom: Math.max(1e-6, finiteNumber(camera.zoomEnd, fallbackStart.zoom)),
    focusX: clamp(camera.focusXEnd, 0, 1),
    focusY: clamp(camera.focusYEnd, 0, 1),
  };
  if (!Number.isFinite(Number(camera.focusXEnd))) fallbackEnd.focusX = fallbackStart.focusX;
  if (!Number.isFinite(Number(camera.focusYEnd))) fallbackEnd.focusY = fallbackStart.focusY;
  const authored = Array.isArray(camera.keyframes) && camera.keyframes.length >= 2
    ? camera.keyframes
      .map((entry, index) => ({
        at: clamp(entry?.at, 0, 1),
        zoom: Math.max(1e-6, finiteNumber(entry?.zoom, index === 0 ? fallbackStart.zoom : fallbackEnd.zoom)),
        focusX: clamp(finiteNumber(entry?.focusX, index === 0 ? fallbackStart.focusX : fallbackEnd.focusX), 0, 1),
        focusY: clamp(finiteNumber(entry?.focusY, index === 0 ? fallbackStart.focusY : fallbackEnd.focusY), 0, 1),
      }))
      .sort((a, b) => a.at - b.at)
    : [fallbackStart, fallbackEnd];
  let left = authored[0];
  let right = authored.at(-1);
  for (let index = 0; index < authored.length - 1; index += 1) {
    if (progress <= authored[index + 1].at + 1e-9) {
      left = authored[index];
      right = authored[index + 1];
      break;
    }
  }
  const span = Math.max(1e-9, right.at - left.at);
  const local = clamp((progress - left.at) / span);
  return {
    zoom: left.zoom * Math.pow(right.zoom / left.zoom, local),
    focusX: left.focusX + (right.focusX - left.focusX) * local,
    focusY: left.focusY + (right.focusY - left.focusY) * local,
  };
}

export function normalizeSourceRect(region, width, height) {
  if (!region || typeof region !== "object") return null;
  const rawWidth = finiteNumber(region.width, 0);
  const rawHeight = finiteNumber(region.height, 0);
  if (!(rawWidth > 0) || !(rawHeight > 0)) return null;
  const rawX = finiteNumber(region.x, 0);
  const rawY = finiteNumber(region.y, 0);
  const normalized = Math.abs(rawX) <= 1 && Math.abs(rawY) <= 1 && rawWidth <= 1 && rawHeight <= 1;
  return {
    x: normalized ? rawX : rawX / Math.max(1, width),
    y: normalized ? rawY : rawY / Math.max(1, height),
    width: normalized ? rawWidth : rawWidth / Math.max(1, width),
    height: normalized ? rawHeight : rawHeight / Math.max(1, height),
    id: nonEmptyString(region.id),
    kind: nonEmptyString(region.kind) || "unknown",
    weight: Number.isFinite(Number(region.weight)) ? Number(region.weight) : undefined,
    hardProtection: region.hardProtection === true || region.hard === true,
  };
}

export function projectSourceRect(region, camera) {
  if (!region) return null;
  const zoom = Math.max(1e-6, finiteNumber(camera?.zoom, 1));
  const cropWidth = 1 / zoom;
  const cropHeight = 1 / zoom;
  const originX = clamp(finiteNumber(camera?.focusX, 0.5) - cropWidth / 2, 0, Math.max(0, 1 - cropWidth));
  const originY = clamp(finiteNumber(camera?.focusY, 0.5) - cropHeight / 2, 0, Math.max(0, 1 - cropHeight));
  const left = clamp((region.x - originX) * zoom);
  const top = clamp((region.y - originY) * zoom);
  const right = clamp((region.x + region.width - originX) * zoom);
  const bottom = clamp((region.y + region.height - originY) * zoom);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function sampleCameraProgresses(shot, intervalStart, intervalEnd, sampleCount = 33) {
  const count = Math.max(3, Math.round(finiteNumber(sampleCount, 33)));
  const shotStart = finiteNumber(shot?.startSeconds, 0);
  const shotDuration = Math.max(1e-9, finiteNumber(shot?.durationSeconds, 0));
  const start = clamp((finiteNumber(intervalStart, shotStart) - shotStart) / shotDuration);
  const end = clamp((finiteNumber(intervalEnd, shotStart + shotDuration) - shotStart) / shotDuration);
  const minimum = Math.min(start, end);
  const maximum = Math.max(start, end);
  const values = Array.from({ length: count }, (_, index) => (
    minimum + (maximum - minimum) * index / Math.max(1, count - 1)
  ));
  for (const keyframe of shot?.camera?.keyframes || []) {
    const at = finiteNumber(keyframe?.at, NaN);
    if (Number.isFinite(at) && at >= minimum - 1e-9 && at <= maximum + 1e-9) values.push(at);
  }
  return [...new Set(values.map((value) => clamp(value).toFixed(9)))]
    .map(Number)
    .sort((a, b) => a - b);
}

function rectCenter(region) {
  return { x: region.x + region.width / 2, y: region.y + region.height * 0.58 };
}

function sameSourceRegion(left, right) {
  if (!left || !right) return false;
  if (left.id && right.id) return left.id === right.id;
  return Math.abs(left.x - right.x) < 1e-6
    && Math.abs(left.y - right.y) < 1e-6
    && Math.abs(left.width - right.width) < 1e-6
    && Math.abs(left.height - right.height) < 1e-6;
}

function expandHeadEnvelope(rect) {
  const horizontal = rect.width * 0.16;
  const top = rect.height * 0.14;
  const bottom = rect.height * 0.18;
  const left = clamp(rect.x - horizontal);
  const upper = clamp(rect.y - top);
  const right = clamp(rect.x + rect.width + horizontal);
  const lower = clamp(rect.y + rect.height + bottom);
  return { x: left, y: upper, width: right - left, height: lower - upper };
}

function utteranceInterval(utterance, shot) {
  const shotStart = finiteNumber(shot?.startSeconds, 0);
  const shotEnd = finiteNumber(shot?.endSeconds, shotStart + finiteNumber(shot?.durationSeconds, 0));
  const timing = utterance?.timing || {};
  const start = finiteNumber(timing.bubbleStartInCutSeconds, finiteNumber(timing.audioStartInCutSeconds, shotStart));
  const end = finiteNumber(timing.bubbleEndInCutSeconds, finiteNumber(timing.audioEndInCutSeconds, shotEnd));
  return {
    start: Math.max(shotStart, Math.min(shotEnd, start)),
    end: Math.max(shotStart, Math.min(shotEnd, end)),
  };
}

export function buildCameraAwareBubblePlacement({
  shot,
  utterance,
  overlaySpec,
  width,
  height,
  sampleCount = 33,
  proximitySampleCount = 9,
  speakerOffscreen = false,
  sourceSpeakerAnchor = null,
} = {}) {
  if (!shot || !utterance || !overlaySpec) throw new Error("shot, utterance, and overlaySpec are required.");
  const isNarration = utterance.preset === "narration";
  const placement = overlaySpec.cameraAwarePlacement || {};
  const sourceRegions = (
    Array.isArray(placement.sourceAvoidRegions) ? placement.sourceAvoidRegions
      : Array.isArray(overlaySpec.sourceAvoidRegions) ? overlaySpec.sourceAvoidRegions
        : Array.isArray(overlaySpec.avoidRegions) ? overlaySpec.avoidRegions
          : []
  ).map((region) => normalizeSourceRect(region, width, height)).filter(Boolean);
  const sourceSpeakerFace = normalizeSourceRect(
    placement.sourceSpeakerFace
      || overlaySpec.sourceSpeakerFace
      || overlaySpec.bubble?.speakerHint?.faceBounds,
    width,
    height,
  );
  if (!isNarration && !sourceSpeakerFace && !speakerOffscreen) {
    throw new Error(`${utterance.id} has no sourceSpeakerFace; dialogue placement cannot protect its speaker.`);
  }
  const interval = utteranceInterval(utterance, shot);
  const progresses = sampleCameraProgresses(shot, interval.start, interval.end, sampleCount);
  const avoidRegions = [];
  for (const [sourceIndex, sourceRegion] of sourceRegions.entries()) {
    const isFace = HARD_FACE_KINDS.has(sourceRegion.kind);
    const isSpeaker = sourceSpeakerFace && sameSourceRegion(sourceRegion, sourceSpeakerFace);
    const hardSecondary = sourceRegion.hardProtection === true;
    for (const [sampleIndex, progress] of progresses.entries()) {
      const projected = projectSourceRect(sourceRegion, cameraAtProgress(shot.camera, progress));
      if (!projected) continue;
      const protectedRect = isFace ? expandHeadEnvelope(projected) : projected;
      avoidRegions.push({
        ...protectedRect,
        id: `${sourceRegion.id || `region-${sourceIndex + 1}`}-camera-sample-${sampleIndex + 1}`,
        // Active speakers are always hard. A measured secondary head can opt
        // into the same zero-pixel contract; legacy/marginal secondary boxes
        // remain soft because several OTS compositions otherwise have no
        // mathematically valid pocket at all.
        kind: isFace
          ? (isSpeaker ? "active-speaker-head" : hardSecondary ? "head" : "secondary-head")
          : hardSecondary && ["hand", "prop", "evidence", "text"].includes(sourceRegion.kind)
            ? `protected-${sourceRegion.kind}`
            : sourceRegion.kind,
        weight: isFace ? (isSpeaker || hardSecondary ? 1600 : 720) : sourceRegion.weight,
        cameraProgress: progress,
      });
    }
  }
  // Some older specs did not duplicate the active face in sourceAvoidRegions.
  // Add it explicitly so every dialogue has a hard speaker envelope.
  if (sourceSpeakerFace && !sourceRegions.some((region) => sameSourceRegion(region, sourceSpeakerFace))) {
    for (const [sampleIndex, progress] of progresses.entries()) {
      const projected = projectSourceRect(sourceSpeakerFace, cameraAtProgress(shot.camera, progress));
      if (!projected) continue;
      avoidRegions.push({
        ...expandHeadEnvelope(projected),
        id: `${sourceSpeakerFace.id || "speaker"}-camera-sample-${sampleIndex + 1}`,
        kind: "active-speaker-head",
        weight: 1600,
        cameraProgress: progress,
      });
    }
  }
  const requestedProximity = Math.max(9, Math.round(finiteNumber(proximitySampleCount, 9)));
  const proximityProgresses = Array.from({ length: requestedProximity }, (_, index) => (
    progresses[0] + (progresses.at(-1) - progresses[0]) * index / Math.max(1, requestedProximity - 1)
  ));
  const speakerProximityTargets = isNarration || speakerOffscreen ? [] : proximityProgresses
    .map((progress) => projectSourceRect(sourceSpeakerFace, cameraAtProgress(shot.camera, progress)))
    .filter(Boolean)
    .map(rectCenter);
  if (!isNarration && !speakerOffscreen && speakerProximityTargets.length < 9) {
    throw new Error(`${utterance.id} has fewer than 9 visible speaker samples across its camera interval.`);
  }
  const midpointProgress = (progresses[0] + progresses.at(-1)) / 2;
  const projectedSpeakerFace = sourceSpeakerFace
    ? projectSourceRect(sourceSpeakerFace, cameraAtProgress(shot.camera, midpointProgress))
    : null;
  // An off-panel speaker (POV shot, voice from outside the frame) has no face
  // to protect; the bubble instead aims at the authored anchor (for example
  // the speaker's visible hand) projected through the same camera.
  const normalizedAnchor = speakerOffscreen && sourceSpeakerAnchor && typeof sourceSpeakerAnchor === "object"
    ? {
        x: clamp(finiteNumber(sourceSpeakerAnchor.x, 0.5), 0, 1),
        y: clamp(finiteNumber(sourceSpeakerAnchor.y, 0.5), 0, 1),
      }
    : null;
  const projectedAnchor = normalizedAnchor
    ? projectSourceRect(
        { x: normalizedAnchor.x - 0.005, y: normalizedAnchor.y - 0.005, width: 0.01, height: 0.01 },
        cameraAtProgress(shot.camera, midpointProgress),
      )
    : null;
  const cameraHash = createHash("sha256").update(JSON.stringify(shot.camera || {})).digest("hex");
  return {
    version: "camera-interval-speaker-protection-v1",
    coordinateMode: "post-camera-screen-space",
    speakerOffscreen: speakerOffscreen === true,
    shotId: shot.id,
    shotAngle: shot.angle || "base",
    intervalStart: interval.start,
    intervalEnd: interval.end,
    cameraHash,
    sampledCameraPositions: progresses.length,
    sourceAvoidRegions: sourceRegions,
    cameraAwareAvoidRegions: avoidRegions,
    sourceSpeakerFace,
    projectedSpeakerFace,
    target: projectedSpeakerFace
      ? rectCenter(projectedSpeakerFace)
      : projectedAnchor
        ? { x: projectedAnchor.x + projectedAnchor.width / 2, y: projectedAnchor.y + projectedAnchor.height / 2 }
        : null,
    speakerProximityTargets,
    speakerProximitySampleCount: speakerProximityTargets.length,
    hardProtectedKinds: [...HARD_FACE_KINDS, "active-speaker-head"],
    hardOverlapTolerancePixels: 0,
  };
}
