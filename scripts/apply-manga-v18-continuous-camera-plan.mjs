#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { normalizeCameraShotSequence } from "../lib/mangaVideoPipeline.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const manifestPath = resolve(process.argv[3] || join(
  projectDir,
  "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json",
));
const rootDir = dirname(manifestPath);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const utterances = new Map(manifest.utterances.map((utterance) => [utterance.id, utterance]));

// These five emotional cuts used to be hard holds in V17.  They now receive a
// continuous micro pull-out; every other shot receives the reference-strength
// pull-out.  No shot has a flat lead or settle tail.
const microPullOutRates = new Map([
  ["cut-03-v16-mio-confession", 0.18],
  ["cut-04-v16-mio-close", 0.20],
  ["cut-05-v16-reiji-close", 0.22],
  ["cut-07-v16-reiji", 0.24],
  ["cut-10-v16-mio-close", 0.25],
]);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function viewpoint(angle) {
  if (angle.startsWith("left")) return "left";
  if (angle.startsWith("right")) return "right";
  if (angle.startsWith("top")) return "top";
  return "neutral";
}

function endView(angle) {
  if (angle.endsWith("-wide") || angle === "wide") return angle;
  if (["left", "right", "top"].includes(angle)) return `${angle}-wide`;
  return "wide";
}

function regularZoomRate(shot) {
  if (shot.shotType === "close-up") return 0.72;
  if (shot.angle.startsWith("top")) return 0.96;
  if (shot.shotType === "wide" || shot.angle.endsWith("-wide")) return 0.90;
  return 0.82;
}

function translationRate(shot, microRate) {
  if (microRate != null) return clamp(microRate * 0.7, 0.13, 0.18);
  if (shot.angle.startsWith("top")) return 0.66;
  if (shot.angle.endsWith("-wide") || shot.angle === "wide") return 0.58;
  return 0.46;
}

const rows = [];
for (const cut of manifest.cuts) {
  const cutUtterances = cut.utteranceIds.map((id) => utterances.get(id)).filter(Boolean);
  const normalized = normalizeCameraShotSequence(cut, cutUtterances, cut.timing?.durationSeconds);
  const durationById = new Map(normalized.map((entry) => [entry.id, entry.durationSeconds]));

  for (const shot of cut.cameraSequence) {
    const durationSeconds = durationById.get(shot.id) || 4;
    const microRate = microPullOutRates.get(shot.id);
    const zoomRatePercentPerSecond = microRate ?? regularZoomRate(shot);
    const translationPercentPerSecond = translationRate(shot, microRate);
    const totalZoomFraction = clamp(zoomRatePercentPerSecond * durationSeconds / 100, 0.002, 0.08);
    const panDistance = clamp(translationPercentPerSecond * durationSeconds / 100, 0.0015, 0.04);
    const zoomEnd = 1;
    const zoomStart = Number((zoomEnd / (1 - totalZoomFraction)).toFixed(6));
    const base = shot.camera || {};
    const focusX = Number(base.focusX ?? 0.5);
    const focusY = Number(base.focusY ?? 0.44);
    const side = viewpoint(shot.angle);
    let panX = 0;
    let panY = 0;
    if (side === "left") {
      panX = panDistance;
      panY = -panDistance * 0.16;
    } else if (side === "right") {
      panX = -panDistance;
      panY = panDistance * 0.16;
    } else if (side === "top") {
      panX = panDistance * 0.14;
      panY = panDistance;
    } else {
      panX = panDistance * 0.7;
      panY = panDistance * 0.35;
    }

    shot.motion = "pull-out";
    shot.camera = {
      ...base,
      zoomStart,
      zoomEnd,
      focusX,
      focusY,
      focusXEnd: Number(clamp(focusX + panX, 0, 1).toFixed(6)),
      focusYEnd: Number(clamp(focusY + panY, 0, 1).toFixed(6)),
      motionLeadRatio: 0,
      motionTailRatio: 0,
      easing: "smoothstep",
      saturation: 1,
      contrast: 1,
      brightness: 0,
    };
    shot.viewpoint = side;
    shot.endView = endView(shot.angle);
    shot.reason = `${shot.reason || shot.angle}; continuous ${microRate != null ? "micro " : ""}pull-out preserving ${side} viewpoint to ${shot.endView}`;

    const authoredRate = ((zoomStart - zoomEnd) / zoomStart) * 100 / durationSeconds;
    const panRate = Math.hypot(
      shot.camera.focusXEnd - shot.camera.focusX,
      shot.camera.focusYEnd - shot.camera.focusY,
    ) * 100 / durationSeconds;
    rows.push({
      cutId: cut.id,
      shotId: shot.id,
      angle: shot.angle,
      viewpoint: side,
      endView: shot.endView,
      durationSeconds: Number(durationSeconds.toFixed(4)),
      motion: shot.motion,
      motionClass: microRate != null ? "micro-pull-out" : "reference-pull-out",
      zoomStart,
      zoomEnd,
      authoredZoomPercentPerSecond: Number(authoredRate.toFixed(4)),
      authoredTranslationPercentPerSecond: Number(panRate.toFixed(4)),
      motionLeadRatio: 0,
      motionTailRatio: 0,
      sourceImagePath: shot.imagePath,
    });
  }

  cut.imagePath = cut.cameraSequence[0].imagePath;
  cut.motion = cut.cameraSequence[0].motion;
  cut.camera = cut.cameraSequence[0].camera;
}

manifest.video = {
  ...(manifest.video || {}),
  fileName: "manga-photo-homecoming-001-v18-continuous-left-right-top-pullout-r1.mp4",
  statusAfterRender: "final-review-candidate-v18-continuous-camera-r1",
  bgmPath: "",
  bgmVolume: 0,
};
manifest.status = "v18-continuous-camera-plan-ready";
manifest.production = {
  ...(manifest.production || {}),
  cameraPolicy: {
    ...(manifest.production?.cameraPolicy || {}),
    version: "v18-continuous-reference-motion-lock",
    semanticAngles: ["left", "right", "top", "left-wide", "right-wide", "top-wide", "wide"],
    pullOutPreservesViewpoint: true,
    emotionalHolds: [],
    emotionalMicroPullOuts: [...microPullOutRates.keys()],
    hardStaticShotCount: 0,
    continuousMotionShotCount: rows.length,
    microPullOutShotIds: [...microPullOutRates.keys()],
    motionLeadRatio: 0,
    motionTailRatio: 0,
    referenceNearStaticInterpretation: "motion below the 0.08%/s classifier threshold, not literal hard-static footage",
    referencePullOutMedianZoomPercentPerSecond: 1.0289,
    referencePullOutMedianTranslationPercentPerSecond: 0.6989,
  },
  ossStack: [
    ...(manifest.production?.ossStack || []).filter((entry) => !["FFmpeg", "OpenCV", "NumPy"].includes(entry.name)),
    { name: "FFmpeg", role: "continuous keyframed left/right/top pull-outs, speech-bubble compositing and H.264/AAC render" },
    { name: "OpenCV", role: "RANSAC optical-flow verification of signed zoom and translation against both reference videos" },
    { name: "NumPy", role: "motion distribution and percentile comparison" },
  ],
};
if (manifest.outputs?.finalVideo) delete manifest.outputs.finalVideo;
if (manifest.outputs?.reviewVideo) delete manifest.outputs.reviewVideo;
manifest.updatedAt = new Date().toISOString();

const movingRows = rows.filter((row) => row.motion === "pull-out" && row.zoomStart > row.zoomEnd);
const auditPath = join(rootDir, "v18-continuous-camera-plan.json");
const audit = {
  version: "v18-continuous-reference-motion-lock",
  shotCount: rows.length,
  pullOutCount: movingRows.length,
  microPullOutCount: rows.filter((row) => row.motionClass === "micro-pull-out").length,
  hardStaticCount: rows.filter((row) => row.motion === "none" || row.zoomStart === row.zoomEnd).length,
  pushInCount: rows.filter((row) => row.zoomEnd > row.zoomStart).length,
  hardLeadOrTailCount: rows.filter((row) => row.motionLeadRatio > 0 || row.motionTailRatio > 0).length,
  angleCounts: Object.fromEntries([...new Set(rows.map((row) => row.angle))].map((angle) => [
    angle,
    rows.filter((row) => row.angle === angle).length,
  ])),
  authoredZoomPercentPerSecond: {
    min: Number(Math.min(...movingRows.map((row) => row.authoredZoomPercentPerSecond)).toFixed(4)),
    mean: Number((movingRows.reduce((sum, row) => sum + row.authoredZoomPercentPerSecond, 0) / movingRows.length).toFixed(4)),
    max: Number(Math.max(...movingRows.map((row) => row.authoredZoomPercentPerSecond)).toFixed(4)),
  },
  authoredTranslationPercentPerSecond: {
    min: Number(Math.min(...movingRows.map((row) => row.authoredTranslationPercentPerSecond)).toFixed(4)),
    mean: Number((movingRows.reduce((sum, row) => sum + row.authoredTranslationPercentPerSecond, 0) / movingRows.length).toFixed(4)),
    max: Number(Math.max(...movingRows.map((row) => row.authoredTranslationPercentPerSecond)).toFixed(4)),
  },
  reference: {
    pullOutMedianZoomPercentPerSecond: 1.0289,
    pullOutMedianTranslationPercentPerSecond: 0.6989,
    classifierThresholdPercentPerSecond: 0.08,
    note: "Below-threshold samples still contain subtle motion and are not treated as hard-static shots.",
  },
  rows,
};
await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  manifestPath,
  auditPath,
  shotCount: audit.shotCount,
  pullOutCount: audit.pullOutCount,
  microPullOutCount: audit.microPullOutCount,
  hardStaticCount: audit.hardStaticCount,
  pushInCount: audit.pushInCount,
  hardLeadOrTailCount: audit.hardLeadOrTailCount,
}, null, 2)}\n`);
