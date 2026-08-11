#!/usr/bin/env node
// v36: camera-aware speaker-safe bubble placement.
//
// Root cause fixed here: many camera-sequence shots swapped in a new source
// illustration (v31 composition variety) while the overlay specs kept face /
// avoid annotations measured on the older image. Placement then protected
// phantom geometry and either collided with the real speaker's face or found
// no pocket at all (cut-05-u03). This script writes per-shot annotations that
// were measured against the actual shot images, so the reflow protects the
// people who are really on screen for the exact interval each bubble is
// visible.
import { copyFile, readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";
import { refreshEpisodeBubbleOverlays } from "../lib/mangaVideoPipeline.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas/manga-videos/manga-photo-homecoming-001");
const manifestPath = join(episodeDir, "episode-manifest.json");
const backupPath = join(episodeDir, "episode-manifest-pre-v36-camera-aware-bubbles-r1.json");

const P = "manga-photo-homecoming-001-character-";
const C1 = `${P}1`; // 高瀬 蓮 (also 少年の蓮)
const C2 = `${P}2`; // 水野 澪 (also 少女の澪)
const C3 = `${P}3`; // 神谷 玲司

function face(id, x, y, width, height) {
  return { id, kind: "face", x, y, width, height, weight: 1600 };
}
function body(id, x, y, width, height) {
  return { id, kind: "body", x, y, width, height, weight: 300 };
}
function prop(id, x, y, width, height, weight = 400) {
  return { id, kind: "prop", x, y, width, height, weight };
}
function evidence(id, x, y, width, height) {
  return { id, kind: "evidence", x, y, width, height, weight: 700 };
}
function hand(id, x, y, width, height) {
  return { id, kind: "hand", x, y, width, height, weight: 700 };
}

// All rectangles are fractions of the source illustration, measured on the
// actual per-shot images (heads include hair so the hard envelope covers the
// whole silhouette).
const SHOT_ANNOTATIONS = {
  "cut-01-v31-counter-macro-ren": {
    faces: { [C1]: { x: 0.195, y: 0.03, width: 0.125, height: 0.25 } },
    regions: [
      face(`${C1}-face`, 0.195, 0.03, 0.125, 0.25),
      body(`${C1}-body`, 0.19, 0.03, 0.24, 0.75),
      prop("film-strip-foreground", 0.0, 0.68, 1.0, 0.32),
    ],
  },
  "cut-02-v31-ren-photo-reply": {
    faces: { [C1]: { x: 0.28, y: 0.14, width: 0.2, height: 0.41 } },
    regions: [
      face(`${C1}-face`, 0.28, 0.14, 0.2, 0.41),
      body(`${C1}-head-hair`, 0.21, 0.0, 0.32, 0.56),
      body(`${C1}-body`, 0.0, 0.45, 0.55, 0.55),
      evidence("held-photo", 0.42, 0.7, 0.22, 0.3),
    ],
  },
  "cut-03-v31-ren-ots-mio-entry": {
    faces: { [C2]: { x: 0.365, y: 0.195, width: 0.075, height: 0.13 } },
    regions: [
      face(`${C2}-face`, 0.365, 0.195, 0.075, 0.13),
      body(`${C2}-body`, 0.335, 0.195, 0.13, 0.65),
      face(`${C1}-head-foreground`, 0.0, 0.0, 0.3, 0.6),
      body(`${C1}-body`, 0.0, 0.0, 0.42, 1.0),
    ],
  },
  "cut-03-v31-mio-ots-ren-thought": {
    // C1's facial rect stays the OpenCV-measured v34 value already stored on
    // the shot (the thought spotlight is locked to it); do not replace it.
    keepExistingFaces: true,
    faces: { [C1]: { x: 0.18612637362637363, y: 0.1482843137254902, width: 0.10782967032967034, height: 0.19240196078431374 } },
    regions: [
      face(`${C1}-face`, 0.15, 0.08, 0.155, 0.32),
      body(`${C1}-body`, 0.12, 0.08, 0.3, 0.92),
      face(`${C2}-head-foreground`, 0.62, 0.0, 0.38, 0.88),
      body(`${C2}-body`, 0.6, 0.0, 0.4, 1.0),
      prop("darkroom-prints", 0.5, 0.1, 0.16, 0.35),
    ],
  },
  "cut-03-v31-mio-rain-reflection": {
    faces: { [C2]: { x: 0.55, y: 0.24, width: 0.2, height: 0.31 } },
    regions: [
      face(`${C2}-face`, 0.55, 0.24, 0.2, 0.31),
      body(`${C2}-head-hair`, 0.46, 0.02, 0.33, 0.56),
      body(`${C2}-body`, 0.42, 0.02, 0.4, 0.98),
      face(`${C1}-face-background`, 0.3, 0.39, 0.06, 0.11),
      body(`${C1}-body-background`, 0.29, 0.39, 0.09, 0.58),
      prop("window-reflection", 0.82, 0.13, 0.18, 0.75),
    ],
  },
  "cut-04-v31-photo-foreground-theft": {
    faces: { [C2]: { x: 0.24, y: 0.12, width: 0.18, height: 0.32 } },
    regions: [
      face(`${C2}-face`, 0.24, 0.12, 0.18, 0.32),
      body(`${C2}-head-hair`, 0.17, 0.03, 0.28, 0.44),
      body(`${C2}-body`, 0.1, 0.03, 0.4, 0.72),
      face(`${C1}-face-background`, 0.655, 0.295, 0.1, 0.18),
      body(`${C1}-body-background`, 0.615, 0.295, 0.19, 0.4),
      evidence("photo-album-foreground", 0.0, 0.6, 0.55, 0.4),
    ],
  },
  "cut-04-v31-ren-evidence-question": {
    faces: { [C1]: { x: 0.0, y: 0.42, width: 0.21, height: 0.52 } },
    regions: [
      face(`${C1}-face`, 0.0, 0.42, 0.21, 0.52),
      body(`${C1}-arm`, 0.0, 0.42, 0.36, 0.58),
      face(`${C2}-face`, 0.79, 0.45, 0.21, 0.5),
      body(`${C2}-arm`, 0.62, 0.45, 0.38, 0.55),
      evidence("table-evidence", 0.33, 0.33, 0.35, 0.38),
    ],
  },
  "cut-04-v31-mio-high-vulnerable": {
    faces: { [C2]: { x: 0.695, y: 0.44, width: 0.14, height: 0.21 } },
    regions: [
      face(`${C2}-face`, 0.695, 0.44, 0.14, 0.21),
      body(`${C2}-body`, 0.63, 0.44, 0.23, 0.56),
    ],
  },
  "cut-05-v31-low-doorway-intrusion": {
    faces: { [C3]: { x: 0.595, y: 0.015, width: 0.075, height: 0.13 } },
    regions: [
      face(`${C3}-face`, 0.595, 0.015, 0.075, 0.13),
      body(`${C3}-body`, 0.575, 0.015, 0.145, 0.82),
      face(`${C1}-head-foreground`, 0.02, 0.2, 0.26, 0.55),
      body(`${C1}-body`, 0.0, 0.2, 0.3, 0.8),
      face(`${C2}-head-foreground`, 0.755, 0.19, 0.245, 0.68),
      body(`${C2}-body`, 0.74, 0.19, 0.26, 0.81),
    ],
  },
  "cut-05-v31-ren-wide-challenge": {
    faces: { [C1]: { x: 0.21, y: 0.085, width: 0.09, height: 0.16 } },
    regions: [
      face(`${C1}-face`, 0.21, 0.085, 0.09, 0.16),
      body(`${C1}-body`, 0.195, 0.085, 0.12, 0.87),
      face(`${C2}-face`, 0.57, 0.125, 0.085, 0.16),
      body(`${C2}-body`, 0.555, 0.125, 0.12, 0.83),
      face(`${C3}-face`, 0.81, 0.03, 0.085, 0.165),
      body(`${C3}-body`, 0.79, 0.03, 0.145, 0.93),
    ],
  },
  "cut-05-v31-reiji-low-dominant": {
    faces: { [C3]: { x: 0.555, y: 0.0, width: 0.14, height: 0.27 } },
    regions: [
      face(`${C3}-face`, 0.555, 0.0, 0.14, 0.27),
      body(`${C3}-body`, 0.5, 0.0, 0.3, 0.92),
      body(`${C1}-shoulder-foreground`, 0.0, 0.0, 0.3, 1.0),
    ],
  },
  "cut-06-v26-continuous-right-then-pullout": {
    faces: {
      [C2]: { x: 0.375, y: 0.165, width: 0.07, height: 0.15 },
      [C3]: { x: 0.705, y: 0.04, width: 0.075, height: 0.155 },
    },
    regions: [
      face(`${C2}-face`, 0.375, 0.165, 0.07, 0.15),
      body(`${C2}-body`, 0.34, 0.165, 0.125, 0.78),
      face(`${C3}-face`, 0.705, 0.04, 0.075, 0.155),
      body(`${C3}-body`, 0.585, 0.04, 0.26, 0.96),
      face(`${C1}-face`, 0.19, 0.18, 0.055, 0.125),
      body(`${C1}-body`, 0.17, 0.18, 0.1, 0.72),
    ],
  },
  "cut-07-v31-negative-proof-macro": {
    // POV shot: the speaker (蓮) is behind the camera. His hand holding the
    // negative is the on-screen anchor for the bubble.
    faces: {},
    offscreenSpeakerIds: [C1],
    anchors: { [C1]: { x: 0.24, y: 0.3 } },
    regions: [
      face(`${C3}-face`, 0.585, 0.25, 0.21, 0.6),
      body(`${C3}-body`, 0.55, 0.25, 0.3, 0.75),
      face(`${C2}-face`, 0.815, 0.12, 0.135, 0.31),
      body(`${C2}-body`, 0.76, 0.12, 0.24, 0.88),
      hand(`${C1}-hand-foreground`, 0.0, 0.0, 0.42, 0.8),
      evidence("negative-film-strip", 0.3, 0.0, 0.27, 0.98),
    ],
  },
  "cut-07-v31-overhead-proof-set": {
    faces: { [C1]: { x: 0.13, y: 0.235, width: 0.17, height: 0.28 } },
    regions: [
      face(`${C1}-face`, 0.13, 0.235, 0.17, 0.28),
      body(`${C1}-body`, 0.06, 0.235, 0.36, 0.765),
      face(`${C3}-face`, 0.555, 0.0, 0.115, 0.21),
      body(`${C3}-body`, 0.49, 0.0, 0.29, 0.44),
      face(`${C2}-face`, 0.815, 0.385, 0.17, 0.28),
      body(`${C2}-body`, 0.8, 0.385, 0.2, 0.615),
      evidence("table-evidence", 0.35, 0.4, 0.48, 0.55),
    ],
  },
  "cut-07-v31-reiji-shock-reaction": {
    faces: { [C3]: { x: 0.6, y: 0.28, width: 0.16, height: 0.5 } },
    regions: [
      face(`${C3}-face`, 0.6, 0.28, 0.16, 0.5),
      body(`${C3}-head-hair`, 0.52, 0.02, 0.4, 0.78),
      body(`${C3}-body`, 0.5, 0.55, 0.5, 0.45),
    ],
  },
  "cut-08-v31-phone-send-ots": {
    faces: { [C2]: { x: 0.19, y: 0.36, width: 0.24, height: 0.5 } },
    regions: [
      face(`${C2}-face`, 0.19, 0.36, 0.24, 0.5),
      body(`${C2}-head-hair`, 0.17, 0.34, 0.28, 0.55),
      body(`${C2}-body`, 0.1, 0.34, 0.6, 0.66),
      evidence("phone-screen", 0.6, 0.49, 0.14, 0.35),
      face(`${C1}-face`, 0.495, 0.035, 0.105, 0.17),
      body(`${C1}-body`, 0.45, 0.035, 0.17, 0.63),
      face(`${C3}-face`, 0.72, 0.04, 0.06, 0.115),
      body(`${C3}-body`, 0.705, 0.04, 0.095, 0.56),
    ],
  },
  "cut-09-v26-continuous-right-young-mio": {
    faces: { [C2]: { x: 0.6, y: 0.05, width: 0.22, height: 0.45 } },
    regions: [
      face(`${C2}-face`, 0.6, 0.05, 0.22, 0.45),
      body(`${C2}-head-hair`, 0.555, 0.0, 0.335, 0.55),
      body(`${C2}-body`, 0.52, 0.0, 0.4, 1.0),
      prop("camera-in-hands", 0.66, 0.7, 0.2, 0.27, 600),
      face(`${C1}-face`, 0.115, 0.37, 0.13, 0.27),
      body(`${C1}-body`, 0.1, 0.37, 0.16, 0.63),
    ],
  },
  "cut-09-v26-continuous-left-young-ren": {
    faces: { [C1]: { x: 0.32, y: 0.1, width: 0.2, height: 0.34 } },
    regions: [
      face(`${C1}-face`, 0.32, 0.1, 0.2, 0.34),
      body(`${C1}-head-hair`, 0.255, 0.0, 0.315, 0.45),
      body(`${C1}-body`, 0.14, 0.0, 0.43, 1.0),
      face(`${C2}-face`, 0.87, 0.46, 0.12, 0.21),
      body(`${C2}-body`, 0.85, 0.46, 0.15, 0.54),
      prop("camera-neck", 0.895, 0.775, 0.075, 0.135),
    ],
  },
  "cut-10-v31-staircase-studio": {
    faces: { [C2]: { x: 0.065, y: 0.115, width: 0.115, height: 0.185 } },
    regions: [
      face(`${C2}-face`, 0.065, 0.115, 0.115, 0.185),
      body(`${C2}-body`, 0.05, 0.115, 0.28, 0.885),
      face(`${C1}-face`, 0.29, 0.5, 0.075, 0.135),
      body(`${C1}-body`, 0.255, 0.5, 0.135, 0.5),
    ],
  },
  "cut-10-v31-intimate-side-confession": {
    faces: { [C2]: { x: 0.65, y: 0.24, width: 0.16, height: 0.31 } },
    regions: [
      face(`${C2}-face`, 0.65, 0.24, 0.16, 0.31),
      body(`${C2}-head-hair`, 0.63, 0.03, 0.33, 0.55),
      body(`${C2}-body`, 0.6, 0.03, 0.4, 0.97),
      face(`${C1}-face`, 0.175, 0.1, 0.14, 0.27),
      body(`${C1}-body`, 0.16, 0.1, 0.25, 0.9),
    ],
  },
  "cut-10-v31-ren-answer": {
    faces: { [C1]: { x: 0.345, y: 0.185, width: 0.075, height: 0.145 } },
    regions: [
      face(`${C1}-face`, 0.345, 0.185, 0.075, 0.145),
      body(`${C1}-body`, 0.31, 0.185, 0.14, 0.79),
      face(`${C2}-face`, 0.49, 0.26, 0.075, 0.135),
      body(`${C2}-body`, 0.465, 0.26, 0.125, 0.71),
      prop("counter-camera", 0.12, 0.68, 0.06, 0.09),
    ],
  },
};

// Long single-bubble lines that cannot fit inside a page-camera visibility
// window are split at the sentence boundary into sequential reference-style
// bubbles, exactly like the six utterances segmented in v24/v25. The
// boundary comes from the measured pause in the final utterance audio
// (silencedetect: 0.99s pause 1.556-2.542s after 「戻らない。」), with the
// v25 offsets: first starts -0.08, ±0.04s clearance at the boundary, last
// ends at duration+0.18.
const SEGMENT_SPLITS = {
  "cut-06-u01": {
    boundarySeconds: 2.049,
    segments: [
      { text: "私は戻らない" },
      { text: "あの写真は、祖母の最後の夏を撮った大切な記録なの" },
    ],
  },
};

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

let backupExists = false;
try {
  await access(backupPath);
  backupExists = true;
} catch {}
if (!backupExists) await copyFile(manifestPath, backupPath);

let annotatedShotCount = 0;
const missing = new Set(Object.keys(SHOT_ANNOTATIONS));
for (const cut of manifest.cuts || []) {
  for (const shot of cut.cameraSequence || []) {
    const annotation = SHOT_ANNOTATIONS[shot.id];
    if (!annotation) continue;
    missing.delete(shot.id);
    const existingFaces = annotation.keepExistingFaces && shot.sourceFaceBoundsBySpeakerId
      ? shot.sourceFaceBoundsBySpeakerId
      : {};
    shot.sourceFaceBoundsBySpeakerId = { ...annotation.faces, ...existingFaces };
    shot.sourceAvoidRegions = annotation.regions;
    if (Array.isArray(annotation.offscreenSpeakerIds)) {
      shot.speakerOffscreenSpeakerIds = annotation.offscreenSpeakerIds;
    }
    if (annotation.anchors) shot.speakerAnchorPointBySpeakerId = annotation.anchors;
    annotatedShotCount += 1;
  }
}
if (missing.size > 0) {
  throw new Error(`Shots not found in manifest: ${[...missing].join(", ")}`);
}

for (const [utteranceId, plan] of Object.entries(SEGMENT_SPLITS)) {
  const utterance = (manifest.utterances || []).find((entry) => entry.id === utteranceId);
  if (!utterance) throw new Error(`Utterance not found for segment split: ${utteranceId}`);
  const duration = Number(utterance.audio?.durationSeconds) || 0;
  const clearHalfGapSeconds = 0.04;
  utterance.bubbleSegments = plan.segments.map((segment, index) => ({
    id: `${utteranceId}-bubble-s${index + 1}`,
    text: segment.text,
    overlayPath: join(episodeDir, "overlays", `${utteranceId}-s${index + 1}.svg`),
    startOffsetSeconds: index === 0
      ? -0.08
      : Number((plan.boundarySeconds + clearHalfGapSeconds).toFixed(4)),
    endOffsetSeconds: index === plan.segments.length - 1
      ? Number((duration + 0.18).toFixed(4))
      : Number((plan.boundarySeconds - clearHalfGapSeconds).toFixed(4)),
  }));
  if (utterance.audio) utterance.audio.bubbleSegmentBoundarySeconds = plan.boundarySeconds;
}

manifest.video = {
  ...(manifest.video || {}),
  fileName: "manga-photo-homecoming-001-v36-camera-aware-bubbles-r1.mp4",
  statusAfterRender: "final-v36-camera-aware-bubbles-r1",
  cutIds: "",
};
manifest.status = "v36-camera-aware-bubbles-ready";
manifest.production = {
  ...(manifest.production || {}),
  version: "v36-camera-aware-bubbles-r1",
  speakerProtection: {
    version: "camera-interval-speaker-protection-v1",
    annotationSource: "per-shot face/body/prop rectangles measured on the actual shot images",
    speakerFacePolicy: "0px overlap across every sampled camera position of the bubble's visible interval",
    secondaryFacePolicy: "strong soft avoidance; may yield only when no pocket exists",
    offscreenSpeakerPolicy: "POV shots declare speakerOffscreenSpeakerIds and an on-screen anchor",
  },
};
manifest.updatedAt = new Date().toISOString();
if (manifest.outputs?.reviewVideo) delete manifest.outputs.reviewVideo;
await writeJsonAtomic(manifestPath, manifest);

// Split pages compose the balloon into the page before the page camera, so
// the balloon must stay inside its interval's visible window. Within that
// window, the reference rule applies: the ACTIVE speaker's face is hard, but
// a non-speaker's face is only strong soft avoidance ("そのシーンで話して
// ない人の上に吹き出し作っても大丈夫"). These overrides restate the panel
// pages' authored regions with per-utterance speaker awareness (page
// coordinates, 1672x941): cut-06 u01 speaker is 澪 (her hand panel — Reiji's
// face is secondary), u02 speaker is Reiji (his face stays hard); cut-08 u01
// speaker is 澪 seen from behind, so 蓮/玲司 faces are secondary and her
// phone evidence stays protected.
const bubbleOverrides = {
  "cut-06-u01": {
    avoidRegions: [
      { id: "mio-hand", kind: "hand", x: 0, y: 100.1224, width: 202.4976, height: 216.0536, weight: 700 },
      { id: "reiji-face-nonspeaker", kind: "secondary-head", x: 434.4505, y: 57.9656, width: 501.0519, height: 254.07, weight: 720 },
      { id: "right-panel-body", kind: "body", x: 1194.8761, y: 0, width: 477.1239, height: 192.7168, weight: 300 },
    ],
  },
  "cut-06-u02": {
    avoidRegions: [
      { id: "mio-hand", kind: "hand", x: 0, y: 100.1224, width: 202.4976, height: 216.0536, weight: 700 },
      { id: "reiji-face-speaker", kind: "face", x: 434.4505, y: 57.9656, width: 501.0519, height: 254.07, weight: 1600 },
      { id: "right-panel-body", kind: "body", x: 1194.8761, y: 0, width: 477.1239, height: 192.7168, weight: 300 },
    ],
  },
  "cut-08-u01": {
    avoidRegions: [
      { id: "ren-face-nonspeaker", kind: "secondary-head", x: 0.38, y: 0.08, width: 0.13, height: 0.24, weight: 720 },
      { id: "reiji-face-nonspeaker", kind: "secondary-head", x: 0.82, y: 0.06, width: 0.12, height: 0.24, weight: 720 },
      { id: "mio-phone", kind: "evidence", x: 0.5, y: 0.25, width: 0.5, height: 0.75, weight: 1000 },
    ],
  },
};

const refreshed = await refreshEpisodeBubbleOverlays({
  projectDir,
  manifestPath,
  refreshAll: true,
  reflowPlacement: true,
  sequenceAware: true,
  placementHistoryDepth: 2,
  bubbleOverrides,
  status: "v36-camera-aware-bubbles-ready",
});

const summary = {
  annotatedShotCount,
  refreshedOverlayCount: refreshed.refreshed.length,
  faceOverlaps: refreshed.refreshed.filter((entry) => (entry.quality?.faceOverlapRatio ?? 0) > 0).length,
  proximityBelow9: refreshed.refreshed.filter((entry) => (
    entry.preset !== "narration" && (entry.quality?.speakerProximitySampleCount ?? 0) < 9
  )).length,
  nearRepeats: refreshed.refreshed.filter((entry) => entry.sequencePlacement?.nearRepeat).length,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
