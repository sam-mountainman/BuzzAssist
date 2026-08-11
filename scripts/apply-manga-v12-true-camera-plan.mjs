#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const projectDir = resolve(process.argv[2] || process.cwd());
const manifestPath = resolve(
  process.argv[3]
    || join(projectDir, "canvas", "manga-videos", "manga-photo-homecoming-001", "episode-manifest.json"),
);
const rootDir = dirname(manifestPath);

// Each row is a real source image. A *-wide row is never synthesized by
// zooming or panning another row; it resolves to that cut's dedicated asset.
// Grouped utterances intentionally hold one visual beat, matching the long
// still-image holds measured in the two user-supplied reference videos.
const cameraPlan = {
  "cut-01": [
    { angle: "left", utteranceIds: ["cut-01-u01", "cut-01-u02"], reason: "hold the left viewpoint through the opening narration" },
    { angle: "left-wide", utteranceIds: ["cut-01-u03"], reason: "spatial left-view pullback for Ren's closing-hours line" },
  ],
  "cut-02": [
    { angle: "top", utteranceIds: ["cut-02-u01"], reason: "top view establishes the restoration work" },
    { angle: "top-wide", utteranceIds: ["cut-02-u02"], reason: "same top viewpoint with wider worktable geography" },
  ],
  "cut-03": [
    { angle: "right", utteranceIds: ["cut-03-u01"], reason: "right-side reunion reaction" },
    { angle: "right-wide", utteranceIds: ["cut-03-u02"], reason: "same right viewpoint widened for the recognition beat" },
    { angle: "left", utteranceIds: ["cut-03-u03"], reason: "reverse viewpoint for Mio's longer confession" },
  ],
  "cut-04": [
    { angle: "left", utteranceIds: ["cut-04-u01"], reason: "left viewpoint favors Mio's testimony" },
    { angle: "top", utteranceIds: ["cut-04-u02"], reason: "top view connects the speakers to the photographic evidence" },
    { angle: "right", utteranceIds: ["cut-04-u03"], reason: "right-side return for Mio's admission" },
  ],
  "cut-05": [
    { angle: "right", utteranceIds: ["cut-05-u01"], reason: "right viewpoint introduces Reiji's intrusion" },
    { angle: "right-wide", utteranceIds: ["cut-05-u02"], reason: "same right viewpoint widened for Ren's challenge" },
    { angle: "left", utteranceIds: ["cut-05-u03"], reason: "left reverse for Reiji's answer" },
  ],
  "cut-06": [
    { angle: "left", utteranceIds: ["cut-06-u01"], reason: "left viewpoint holds Mio's decision" },
    { angle: "right-wide", utteranceIds: ["cut-06-u02"], reason: "true right-side wide shot for Reiji's threat" },
  ],
  "cut-07": [
    { angle: "top", utteranceIds: ["cut-07-u01", "cut-07-u02"], reason: "hold the evidence top view across Ren's proof" },
    { angle: "right", utteranceIds: ["cut-07-u03"], reason: "right close reaction for Reiji" },
  ],
  "cut-08": [
    { angle: "top-wide", utteranceIds: ["cut-08-u01"], reason: "top-wide view keeps Mio and the verification workflow together" },
    { angle: "wide", utteranceIds: ["cut-08-u02", "cut-08-u03"], reason: "neutral wide shot holds the consequence narration" },
  ],
  "cut-09": [
    { angle: "right", utteranceIds: ["cut-09-u01"], reason: "right viewpoint for young Mio's promise" },
    { angle: "left", utteranceIds: ["cut-09-u02"], reason: "left reverse for young Ren's answer" },
    { angle: "top-wide", utteranceIds: ["cut-09-u03"], reason: "top-wide memory tableau for the narration" },
  ],
  "cut-10": [
    { angle: "right", utteranceIds: ["cut-10-u01"], reason: "right viewpoint for Mio's proposal" },
    { angle: "left", utteranceIds: ["cut-10-u02"], reason: "left reverse for the intimate admission" },
    { angle: "wide", utteranceIds: ["cut-10-u03", "cut-10-u04"], reason: "wide closing geography for the shared future and final narration" },
  ],
};

function viewpointForAngle(angle) {
  if (angle.startsWith("left")) return "left";
  if (angle.startsWith("right")) return "right";
  if (angle.startsWith("top")) return "top";
  return "neutral";
}

function focusForAngle(angle) {
  const viewpoint = viewpointForAngle(angle);
  if (viewpoint === "left") return { focusX: 0.35, focusY: 0.38 };
  if (viewpoint === "right") return { focusX: 0.65, focusY: 0.38 };
  if (viewpoint === "top") return { focusX: 0.50, focusY: 0.50 };
  return { focusX: 0.50, focusY: 0.44 };
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const allUtteranceIds = new Set((manifest.utterances || []).map((utterance) => utterance.id));
const assignedUtteranceIds = [];
const auditRows = [];

for (const cut of manifest.cuts || []) {
  const rows = cameraPlan[cut.id];
  if (!rows) throw new Error(`No V12 camera plan for ${cut.id}.`);
  const inventory = cut.cameraAssetInventory || [];
  for (const asset of inventory) asset.selectedShotId = null;

  cut.cameraSequence = rows.map((row, index) => {
    const asset = inventory.find((candidate) => candidate.angle === row.angle);
    if (!asset?.imagePath) throw new Error(`No ${row.angle} asset for ${cut.id}.`);
    const id = `${cut.id}-v12-shot-${String(index + 1).padStart(2, "0")}-${row.angle}`;
    asset.selectedShotId = id;
    assignedUtteranceIds.push(...row.utteranceIds);
    const viewpoint = viewpointForAngle(row.angle);
    const isSpatialWideShot = row.angle === "wide" || row.angle.endsWith("-wide");
    const focus = focusForAngle(row.angle);
    const shot = {
      id,
      utteranceIds: row.utteranceIds,
      imagePath: asset.imagePath,
      angle: row.angle,
      viewpoint,
      shotType: isSpatialWideShot ? "wide" : "medium",
      isSpatialWideShot,
      wideShotSource: isSpatialWideShot ? "dedicated-camera-asset" : null,
      reason: row.reason,
      transition: "cut",
      motion: "slow-push",
      camera: {
        saturation: 1.06,
        contrast: 1.02,
        brightness: 0.018,
        // Reference median is ~0.31%/s. This slight push is atmosphere only;
        // no shot uses a decreasing zoom to pretend that it is a wide shot.
        zoomStart: 1.0,
        zoomEnd: 1.018,
        ...focus,
        focusXEnd: focus.focusX,
        focusYEnd: focus.focusY,
      },
    };
    auditRows.push({
      cutId: cut.id,
      shotId: id,
      utteranceIds: row.utteranceIds,
      angle: row.angle,
      viewpoint,
      shotType: shot.shotType,
      isSpatialWideShot,
      imagePath: asset.imagePath,
      zoomStart: shot.camera.zoomStart,
      zoomEnd: shot.camera.zoomEnd,
      digitalZoomOutUsed: shot.camera.zoomEnd < shot.camera.zoomStart,
    });
    return shot;
  });

  cut.motion = "slow-push";
  cut.camera = {
    ...(cut.camera || {}),
    saturation: 1.06,
    contrast: 1.02,
    brightness: 0.018,
    zoomStart: 1.0,
    zoomEnd: 1.018,
  };
}

const duplicateAssignments = assignedUtteranceIds.filter((id, index, rows) => rows.indexOf(id) !== index);
const missingAssignments = [...allUtteranceIds].filter((id) => !assignedUtteranceIds.includes(id));
const unknownAssignments = assignedUtteranceIds.filter((id) => !allUtteranceIds.has(id));
if (duplicateAssignments.length || missingAssignments.length || unknownAssignments.length) {
  throw new Error(`Invalid V12 utterance assignment: ${JSON.stringify({ duplicateAssignments, missingAssignments, unknownAssignments })}`);
}

const angleCounts = Object.fromEntries(
  [...new Set(auditRows.map((row) => row.angle))]
    .sort()
    .map((angle) => [angle, auditRows.filter((row) => row.angle === angle).length]),
);
const wideShotCount = auditRows.filter((row) => row.isSpatialWideShot).length;
const digitalZoomOutCount = auditRows.filter((row) => row.digitalZoomOutUsed).length;
const requiredAngles = ["left", "right", "top", "wide", "left-wide", "right-wide", "top-wide"];
const missingAngles = requiredAngles.filter((angle) => !angleCounts[angle]);
if (missingAngles.length) throw new Error(`V12 is missing required camera angles: ${missingAngles.join(", ")}`);
if (wideShotCount !== 9) throw new Error(`Expected 9 spatial wide shots, received ${wideShotCount}.`);
if (digitalZoomOutCount !== 0) throw new Error(`V12 contains ${digitalZoomOutCount} digital zoom-out shot(s).`);

manifest.status = "v12-true-camera-plan-ready";
manifest.production = {
  ...(manifest.production || {}),
  version: "v12-true-camera-reference-match",
  cameraPolicy: {
    angles: requiredAngles,
    viewpointSemantics: {
      left: "true left-side camera viewpoint",
      right: "true right-side camera viewpoint",
      top: "true overhead/top camera viewpoint",
    },
    wideSemantics: "A wide shot must use a dedicated spatially wider source image. Digital zoom-out is not accepted as a wide shot.",
    leftWideSemantics: "Retain the left viewpoint while increasing spatial coverage.",
    rightWideSemantics: "Retain the right viewpoint while increasing spatial coverage.",
    topWideSemantics: "Retain the top viewpoint while increasing spatial coverage.",
    singleContinuousFrameRequired: true,
    wideMeansSpatiallyWiderShotNotDigitalCrop: true,
    digitalZoomOutShotCount: digitalZoomOutCount,
    spatialWideShotCount: wideShotCount,
    totalShotCount: auditRows.length,
    spatialWideShotRatio: Number((wideShotCount / auditRows.length).toFixed(4)),
  },
  referenceCameraAudit: {
    sources: [
      "https://www.youtube.com/watch?v=awAbZyTeE4g",
      "https://www.youtube.com/watch?v=2ycRncs4CKY",
    ],
    browserReviewedSamplesSeconds: {
      awAbZyTeE4g: [273, 777, 1281],
      "2ycRncs4CKY": [405, 601, 900, 1470],
    },
    measuredReferenceShotDistribution: { wide: 0.325, medium: 0.4, close: 0.275 },
    v12SpatialWideRatio: Number((wideShotCount / auditRows.length).toFixed(4)),
    referenceMedianZoomPercentPerSecond: 0.3121,
  },
  ossStack: [
    { name: "FFmpeg", role: "shot assembly, subtle reference-rate camera motion, compositing, and H.264/AAC output" },
    { name: "OpenCV", role: "full-video frame, edge, panel, and camera-motion analysis" },
    { name: "NumPy", role: "reference percentile and shot-distribution measurement" },
    { name: "Chromium/rsvg/ImageMagick", role: "deterministic SVG speech-balloon rasterization fallback chain" },
  ],
};
if (manifest.outputs?.reviewVideo) delete manifest.outputs.reviewVideo;
manifest.updatedAt = new Date().toISOString();

const cameraAudit = {
  version: "v12-true-camera-reference-match",
  referenceSources: manifest.production.referenceCameraAudit.sources,
  shotCount: auditRows.length,
  wideShotCount,
  wideShotRatio: Number((wideShotCount / auditRows.length).toFixed(4)),
  digitalZoomOutCount,
  requiredAngles,
  missingAngles,
  angleCounts,
  utteranceAssignmentCount: assignedUtteranceIds.length,
  rows: auditRows,
};
await writeFile(join(rootDir, "v12-camera-plan-audit.json"), `${JSON.stringify(cameraAudit, null, 2)}\n`, "utf8");

// On the second pass (after speech bubbles were regenerated), promote their
// camera-specific QA into a V12-named audit only if every shot mapping matches.
const overlayRows = [];
for (const utterance of manifest.utterances || []) {
  const cut = (manifest.cuts || []).find((candidate) => candidate.id === utterance.cutId);
  const shot = (cut?.cameraSequence || []).find((candidate) => candidate.utteranceIds?.includes(utterance.id));
  if (!shot || !utterance.overlaySpecPath) continue;
  try {
    const spec = JSON.parse(await readFile(utterance.overlaySpecPath, "utf8"));
    if (spec.cameraShotId !== shot.id) continue;
    const quality = spec.quality?.[0] || {};
    overlayRows.push({
      utteranceId: utterance.id,
      cameraShotId: shot.id,
      cameraAngle: shot.angle,
      imagePath: shot.imagePath,
      faceOverlapRatio: quality.faceOverlapRatio,
      importantOverlapRatio: quality.importantOverlapRatio,
      overflow: quality.overflow,
      textLoss: quality.textLoss,
      tooSmall: quality.tooSmall,
      bounds: spec.plan?.bubbles?.[0]?.bounds,
    });
  } catch {
    // First pass can legitimately precede the overlay refresh.
  }
}
if (overlayRows.length === (manifest.utterances || []).length) {
  await writeFile(join(rootDir, "v12-bubble-layout-audit.json"), `${JSON.stringify({
    version: "v12-true-camera-reference-match",
    overlayCount: overlayRows.length,
    zeroFaceOverlapCount: overlayRows.filter((row) => row.faceOverlapRatio === 0).length,
    zeroImportantOverlapCount: overlayRows.filter((row) => row.importantOverlapRatio === 0).length,
    rows: overlayRows,
  }, null, 2)}\n`, "utf8");
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ manifestPath, status: manifest.status, ...cameraAudit, rows: undefined }, null, 2)}\n`);
