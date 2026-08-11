#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { normalizeCameraShotSequence } from "../lib/mangaVideoPipeline.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const manifestPath = resolve(
  process.argv[3]
    || join(projectDir, "canvas", "manga-videos", "manga-photo-homecoming-001", "episode-manifest.json"),
);
const rootDir = dirname(manifestPath);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function viewpoint(angle = "") {
  if (angle.startsWith("left")) return "left";
  if (angle.startsWith("right")) return "right";
  if (angle.startsWith("top")) return "top";
  return "neutral";
}

function focusForAngle(angle) {
  const view = viewpoint(angle);
  if (view === "left") return { focusX: 0.34, focusY: 0.40 };
  if (view === "right") return { focusX: 0.66, focusY: 0.40 };
  if (view === "top") return { focusX: 0.50, focusY: 0.50 };
  return { focusX: 0.50, focusY: 0.44 };
}

const utteranceById = new Map((manifest.utterances || []).map((utterance) => [utterance.id, utterance]));
const rows = [];

for (const cut of manifest.cuts || []) {
  const utterances = (cut.utteranceIds || []).map((id) => utteranceById.get(id)).filter(Boolean);
  const normalized = normalizeCameraShotSequence(cut, utterances, cut.timing?.durationSeconds || 0);
  const durationByShotId = new Map(normalized.map((shot) => [shot.id, shot.durationSeconds]));

  cut.cameraSequence = (cut.cameraSequence || []).map((shot) => {
    const durationSeconds = durationByShotId.get(shot.id) || 5;
    const isSpatialWideShot = shot.angle === "wide" || shot.angle?.endsWith("-wide");
    // The references contain visible pull-outs around 0.7-1.8% per second.
    // Scale the total reveal by the held-shot duration, while keeping short
    // reaction shots readable and long holds below a 19% crop.
    const pullRatio = clamp(
      durationSeconds * (isSpatialWideShot ? 0.0125 : 0.0145),
      0.04,
      isSpatialWideShot ? 0.16 : 0.19,
    );
    const zoomStart = Number((1 + pullRatio).toFixed(4));
    const focus = focusForAngle(shot.angle);
    const camera = {
      ...(shot.camera || {}),
      zoomStart,
      zoomEnd: 1,
      easing: "smoothstep",
      ...focus,
      focusXEnd: focus.focusX,
      focusYEnd: focus.focusY,
    };
    const baseReason = (shot.reason || shot.angle).replace(/; animated pull-out retains the [^;]+ viewpoint$/u, "");
    const result = {
      ...shot,
      motion: "pull-out",
      camera,
      reason: `${baseReason}; animated pull-out retains the ${viewpoint(shot.angle)} viewpoint`,
    };
    rows.push({
      cutId: cut.id,
      shotId: shot.id,
      angle: shot.angle,
      viewpoint: viewpoint(shot.angle),
      durationSeconds: Number(durationSeconds.toFixed(4)),
      imagePath: shot.imagePath,
      zoomStart,
      zoomEnd: 1,
      totalPullPercent: Number((pullRatio * 100).toFixed(2)),
      averagePullPercentPerSecond: Number((pullRatio * 100 / durationSeconds).toFixed(3)),
      easing: "smoothstep",
      isSpatialWideShot,
    });
    return result;
  });
  cut.motion = "pull-out";
  cut.camera = {
    ...(cut.camera || {}),
    zoomStart: 1.16,
    zoomEnd: 1,
    easing: "smoothstep",
  };
}

const requiredAngles = ["left", "right", "top", "wide", "left-wide", "right-wide", "top-wide"];
const angleCounts = Object.fromEntries(requiredAngles.map((angle) => [angle, rows.filter((row) => row.angle === angle).length]));
const missingAngles = requiredAngles.filter((angle) => angleCounts[angle] === 0);
if (missingAngles.length > 0) throw new Error(`V13 is missing required angles: ${missingAngles.join(", ")}`);
if (rows.some((row) => row.zoomStart <= row.zoomEnd)) throw new Error("Every V13 camera shot must visibly pull out.");

const pullRates = rows.map((row) => row.averagePullPercentPerSecond);
const audit = {
  version: "v13-animated-reference-camera",
  referenceSources: [
    "https://www.youtube.com/watch?v=awAbZyTeE4g",
    "https://www.youtube.com/watch?v=2ycRncs4CKY",
  ],
  correction: "V12 used 1.000 -> 1.018 slow pushes. V13 uses descending zoom while retaining each left/right/top viewpoint.",
  shotCount: rows.length,
  animatedPullOutCount: rows.filter((row) => row.zoomStart > row.zoomEnd).length,
  spatialWideSourceCount: rows.filter((row) => row.isSpatialWideShot).length,
  angleCounts,
  referenceMeasuredPullOutRangePercentPerSecond: [0.7, 1.8],
  authoredPullRatePercentPerSecond: {
    minimum: Number(Math.min(...pullRates).toFixed(3)),
    maximum: Number(Math.max(...pullRates).toFixed(3)),
    average: Number((pullRates.reduce((total, value) => total + value, 0) / pullRates.length).toFixed(3)),
  },
  rows,
};

manifest.status = "v13-animated-camera-ready";
manifest.production = {
  ...(manifest.production || {}),
  version: "v13-animated-reference-camera",
  cameraPolicy: {
    ...(manifest.production?.cameraPolicy || {}),
    angles: requiredAngles,
    animatedPullOutRequired: true,
    animatedPullOutShotCount: audit.animatedPullOutCount,
    spatialWideSourceCount: audit.spatialWideSourceCount,
    sameViewpointThroughPullOut: true,
    digitalZoomOutShotCount: audit.animatedPullOutCount,
    wideSemantics: "Use a dedicated wide source, then animate from a closer crop to its full spatial coverage.",
    leftWideSemantics: "Retain the left viewpoint while revealing the full left-wide source.",
    rightWideSemantics: "Retain the right viewpoint while revealing the full right-wide source.",
    topWideSemantics: "Retain the overhead viewpoint while revealing the full top-wide source.",
  },
  referenceCameraAudit: {
    ...(manifest.production?.referenceCameraAudit || {}),
    measuredReferencePullOutRangePercentPerSecond: [0.7, 1.8],
    v13AuthoredPullRatePercentPerSecond: audit.authoredPullRatePercentPerSecond,
  },
  ossStack: [
    { name: "FFmpeg", role: "Lanczos-scaled, 30fps smoothstep pull-out animation and H.264/AAC assembly" },
    { name: "OpenCV", role: "RANSAC optical-flow measurement of reference and rendered camera motion" },
    { name: "NumPy", role: "motion-rate distributions and start/middle/end verification" },
  ],
};
if (manifest.outputs?.reviewVideo) delete manifest.outputs.reviewVideo;
manifest.updatedAt = new Date().toISOString();

await writeFile(join(rootDir, "v13-camera-motion-plan.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

process.stdout.write(`${JSON.stringify({
  manifestPath,
  status: manifest.status,
  shotCount: audit.shotCount,
  animatedPullOutCount: audit.animatedPullOutCount,
  spatialWideSourceCount: audit.spatialWideSourceCount,
  authoredPullRatePercentPerSecond: audit.authoredPullRatePercentPerSecond,
  angleCounts,
}, null, 2)}\n`);
