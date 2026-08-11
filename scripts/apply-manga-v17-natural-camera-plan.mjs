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

// The reference videos contain 40 measured pull-outs, 24 near-static samples,
// and only seven pushes. Preserve five emotional holds and make the remaining
// 20 shots pull out while retaining their authored left/right/top viewpoint.
const holdShotIds = new Set([
  "cut-03-v16-mio-confession",
  "cut-04-v16-mio-close",
  "cut-05-v16-reiji-close",
  "cut-07-v16-reiji",
  "cut-10-v16-mio-close",
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

function targetRate(shot) {
  if (shot.shotType === "close-up") return 0.72;
  if (shot.angle.startsWith("top")) return 0.96;
  if (shot.shotType === "wide" || shot.angle.endsWith("-wide")) return 0.90;
  return 0.82;
}

const rows = [];
for (const cut of manifest.cuts) {
  const cutUtterances = cut.utteranceIds.map((id) => utterances.get(id)).filter(Boolean);
  const normalized = normalizeCameraShotSequence(cut, cutUtterances, cut.timing?.durationSeconds);
  const durationById = new Map(normalized.map((entry) => [entry.id, entry.durationSeconds]));

  for (const shot of cut.cameraSequence) {
    const durationSeconds = durationById.get(shot.id) || 4;
    const hold = holdShotIds.has(shot.id);
    const base = shot.camera || {};
    if (hold) {
      shot.motion = "none";
      shot.camera = {
        ...base,
        zoomStart: 1,
        zoomEnd: 1,
        focusXEnd: base.focusX,
        focusYEnd: base.focusY,
        motionLeadRatio: 0,
        motionTailRatio: 0,
        saturation: 1,
        contrast: 1,
        brightness: 0,
      };
    } else {
      const ratePercentPerSecond = targetRate(shot);
      const totalFraction = clamp(ratePercentPerSecond * durationSeconds / 100, 0.025, 0.08);
      const zoomEnd = 1;
      const zoomStart = Number(clamp(zoomEnd / (1 - totalFraction), 1.025, 1.087).toFixed(5));
      const panDistance = clamp(durationSeconds * 0.004, 0.01, 0.035);
      const focusX = Number(base.focusX ?? 0.5);
      const focusY = Number(base.focusY ?? 0.44);
      const side = viewpoint(shot.angle);
      const panX = side === "left"
        ? panDistance
        : side === "right"
          ? -panDistance
          : (0.5 - focusX) * 0.25;
      const panY = side === "top" ? clamp(0.5 - focusY, -panDistance, panDistance) : 0;
      shot.motion = "pull-out";
      shot.camera = {
        ...base,
        zoomStart,
        zoomEnd,
        focusX,
        focusY,
        focusXEnd: Number(clamp(focusX + panX, 0, 1).toFixed(5)),
        focusYEnd: Number(clamp(focusY + panY, 0, 1).toFixed(5)),
        motionLeadRatio: 0.08,
        motionTailRatio: 0.12,
        easing: "smoothstep",
        saturation: 1,
        contrast: 1,
        brightness: 0,
      };
      shot.viewpoint = side;
      shot.endView = endView(shot.angle);
      shot.reason = `${shot.reason || shot.angle}; retain ${side} viewpoint while pulling out to ${shot.endView}`;
    }

    const authoredRate = hold
      ? 0
      : ((shot.camera.zoomStart - shot.camera.zoomEnd) / shot.camera.zoomStart) * 100 / durationSeconds;
    const panRate = hold
      ? 0
      : Math.hypot(
        shot.camera.focusXEnd - shot.camera.focusX,
        shot.camera.focusYEnd - shot.camera.focusY,
      ) * 100 / durationSeconds;
    rows.push({
      cutId: cut.id,
      shotId: shot.id,
      angle: shot.angle,
      viewpoint: viewpoint(shot.angle),
      endView: hold ? shot.angle : endView(shot.angle),
      durationSeconds: Number(durationSeconds.toFixed(4)),
      motion: shot.motion,
      zoomStart: shot.camera.zoomStart,
      zoomEnd: shot.camera.zoomEnd,
      authoredZoomPercentPerSecond: Number(authoredRate.toFixed(4)),
      authoredTranslationPercentPerSecond: Number(panRate.toFixed(4)),
      motionLeadRatio: shot.camera.motionLeadRatio,
      motionTailRatio: shot.camera.motionTailRatio,
      sourceImagePath: shot.imagePath,
    });
  }

  cut.imagePath = cut.cameraSequence[0].imagePath;
  cut.motion = cut.cameraSequence[0].motion;
  cut.camera = cut.cameraSequence[0].camera;
}

manifest.video = {
  ...(manifest.video || {}),
  fileName: "manga-photo-homecoming-001-v17-natural-left-right-top-pullout-r1.mp4",
  statusAfterRender: "final-review-candidate-v17-natural-camera-r1",
  bgmPath: "",
  bgmVolume: 0,
};
manifest.status = "v17-natural-camera-plan-ready";
manifest.production = {
  ...(manifest.production || {}),
  cameraPolicy: {
    ...(manifest.production?.cameraPolicy || {}),
    version: "v17-reference-motion-lock",
    semanticAngles: ["left", "right", "top", "left-wide", "right-wide", "top-wide", "wide"],
    pullOutPreservesViewpoint: true,
    emotionalHolds: [...holdShotIds],
    motionLeadRatio: 0.08,
    motionTailRatio: 0.12,
    referenceMeasuredCounts: { pullOut: 40, nearStatic: 24, pushIn: 7, valid: 71 },
    referencePullOutMedianZoomPercentPerSecond: 1.0289,
    referencePullOutMedianTranslationPercentPerSecond: 0.6989,
  },
  ossStack: [
    ...(manifest.production?.ossStack || []).filter((entry) => !["FFmpeg", "OpenCV", "NumPy"].includes(entry.name)),
    { name: "FFmpeg", role: "keyframed left/right/top pull-outs, hold-settle easing, bubble compositing and final H.264/AAC render" },
    { name: "OpenCV", role: "RANSAC optical-flow measurement of signed zoom and translation against both reference videos" },
    { name: "NumPy", role: "signed motion distribution and percentile comparison" },
  ],
};
if (manifest.outputs?.finalVideo) delete manifest.outputs.finalVideo;
manifest.updatedAt = new Date().toISOString();

const auditPath = join(rootDir, "v17-natural-camera-plan.json");
const movingRows = rows.filter((row) => row.motion === "pull-out");
const audit = {
  version: "v17-reference-motion-lock",
  shotCount: rows.length,
  pullOutCount: movingRows.length,
  holdCount: rows.filter((row) => row.motion === "none").length,
  pushInCount: rows.filter((row) => row.zoomEnd > row.zoomStart).length,
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
    pullOutCount: 40,
    nearStaticCount: 24,
    pushInCount: 7,
    pullOutMedianZoomPercentPerSecond: 1.0289,
    pullOutMedianTranslationPercentPerSecond: 0.6989,
  },
  rows,
};
await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ manifestPath, auditPath, ...Object.fromEntries(
  ["shotCount", "pullOutCount", "holdCount", "pushInCount"].map((key) => [key, audit[key]]),
) }, null, 2)}\n`);
