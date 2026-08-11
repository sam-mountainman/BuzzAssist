#!/usr/bin/env node
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { readEpisodeManifest } from "../lib/mangaVideoPipeline.mjs";
import { writeJsonAtomic } from "../lib/canvasScene.mjs";

const manifestPath = resolve(
  process.argv[2] || "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json",
);
const { manifest } = await readEpisodeManifest({ manifestPath });
const canvasDir = resolve(dirname(manifestPath), "../..");
const asset = (cutId, angle) => resolve(
  canvasDir,
  "assets",
  `${manifest.id}-v7-${cutId}${angle === "base" ? "" : `-${angle}`}.png`,
);
const shot = (cutId, utteranceIds, angle, reason, camera, motion = "slow-push") => ({
  id: `${cutId}-${(Array.isArray(utteranceIds) ? utteranceIds : [utteranceIds]).join("+")}-${angle}`,
  utteranceIds: Array.isArray(utteranceIds) ? utteranceIds : [utteranceIds],
  imagePath: asset(cutId, angle),
  angle,
  reason,
  transition: "cut",
  motion,
  camera: {
    saturation: 1.06,
    contrast: 1.02,
    brightness: 0.018,
    ...camera,
  },
});

const sequences = {
  "cut-01": [
    shot("cut-01", ["cut-01-u01", "cut-01-u02"], "wide", "hold the rainy photo-shop establishment across the two opening narration beats", { zoomStart: 1.1, zoomEnd: 1.04, focusX: 0.5, focusY: 0.44 }, "slow-pull"),
    shot("cut-01", "cut-01-u03", "left", "Ren becomes the active speaker", { zoomStart: 1.1, zoomEnd: 1.16, focusX: 0.3, focusY: 0.3 }),
  ],
  "cut-02": [
    shot("cut-02", "cut-02-u01", "top-wide", "explain the restoration bench and work context", { zoomStart: 1.03, zoomEnd: 1.08, focusX: 0.5, focusY: 0.52 }),
    shot("cut-02", "cut-02-u02", "top", "push toward Ren's hands and the restored photograph", { zoomStart: 1.08, zoomEnd: 1.16, focusX: 0.53, focusY: 0.5 }),
  ],
  "cut-03": [
    shot("cut-03", "cut-03-u01", "right", "Mio's entrance and first line", { zoomStart: 1.08, zoomEnd: 1.14, focusX: 0.72, focusY: 0.28 }),
    shot("cut-03", "cut-03-u02", "left", "speaker switch to Ren's internal reaction", { zoomStart: 1.08, zoomEnd: 1.12, focusX: 0.29, focusY: 0.24 }),
    shot("cut-03", "cut-03-u03", "right-wide", "return to Mio while retaining the shared emotional geography", { zoomStart: 1.08, zoomEnd: 1.14, focusX: 0.68, focusY: 0.34 }),
  ],
  "cut-04": [
    shot("cut-04", "cut-04-u01", "right", "Mio reveals the stolen work", { zoomStart: 1.1, zoomEnd: 1.18, focusX: 0.7, focusY: 0.28 }),
    shot("cut-04", "cut-04-u02", "left", "shot-reverse-shot to Ren's practical question", { zoomStart: 1.1, zoomEnd: 1.16, focusX: 0.3, focusY: 0.28 }),
    shot("cut-04", "cut-04-u03", "right-wide", "Mio's regret returns with enough room for the relationship and evidence", { zoomStart: 1.08, zoomEnd: 1.15, focusX: 0.68, focusY: 0.32 }),
  ],
  "cut-05": [
    shot("cut-05", "cut-05-u01", "right", "Reiji enters and takes visual control", { zoomStart: 1.08, zoomEnd: 1.15, focusX: 0.7, focusY: 0.3 }),
    shot("cut-05", "cut-05-u02", "left", "speaker switch and counter-question from Ren", { zoomStart: 1.1, zoomEnd: 1.17, focusX: 0.3, focusY: 0.3 }),
    shot("cut-05", "cut-05-u03", "right-wide", "return to Reiji while holding the three-person confrontation geography", { zoomStart: 1.08, zoomEnd: 1.16, focusX: 0.68, focusY: 0.32 }),
  ],
  "cut-06": [
    shot("cut-06", "cut-06-u01", "left", "Mio states her decision", { zoomStart: 1.1, zoomEnd: 1.18, focusX: 0.31, focusY: 0.3 }),
    shot("cut-06", "cut-06-u02", "right", "reverse to Reiji's threat", { zoomStart: 1.1, zoomEnd: 1.2, focusX: 0.69, focusY: 0.28 }),
  ],
  "cut-07": [
    shot("cut-07", ["cut-07-u01", "cut-07-u02"], "top", "hold on the negative and records across Ren's complete evidence explanation", { zoomStart: 1.04, zoomEnd: 1.13, focusX: 0.5, focusY: 0.52 }),
    shot("cut-07", "cut-07-u03", "right", "Reiji's reaction ends the confrontation beat", { zoomStart: 1.1, zoomEnd: 1.19, focusX: 0.69, focusY: 0.29 }),
  ],
  "cut-08": [
    shot("cut-08", "cut-08-u01", "top-wide", "overview of sending the proof", { zoomStart: 1.05, zoomEnd: 1.11, focusX: 0.5, focusY: 0.5 }),
    shot("cut-08", ["cut-08-u02", "cut-08-u03"], "wide", "hold the time jump and public consequence as one continuous outcome beat", { zoomStart: 1.04, zoomEnd: 1.09, focusX: 0.5, focusY: 0.44 }),
  ],
  "cut-09": [
    shot("cut-09", "cut-09-u01", "right", "child Mio makes the promise", { zoomStart: 1.08, zoomEnd: 1.14, focusX: 0.68, focusY: 0.32 }),
    shot("cut-09", "cut-09-u02", "left", "reverse to child Ren's answer", { zoomStart: 1.08, zoomEnd: 1.14, focusX: 0.32, focusY: 0.32 }),
    shot("cut-09", "cut-09-u03", "top-wide", "pull the memory into narrative perspective", { zoomStart: 1.08, zoomEnd: 1.02, focusX: 0.5, focusY: 0.46 }, "slow-pull"),
  ],
  "cut-10": [
    shot("cut-10", ["cut-10-u01", "cut-10-u02"], "right", "hold Mio's side across the complete intimate proposal", { zoomStart: 1.08, zoomEnd: 1.15, focusX: 0.69, focusY: 0.29 }),
    shot("cut-10", "cut-10-u03", "left", "reverse to Ren's welcome", { zoomStart: 1.1, zoomEnd: 1.18, focusX: 0.31, focusY: 0.29 }),
    shot("cut-10", "cut-10-u04", "wide", "end by withdrawing into the renewed shop and street", { zoomStart: 1.12, zoomEnd: 1.03, focusX: 0.5, focusY: 0.42 }, "slow-pull"),
  ],
};

const requiredAngles = ["left", "right", "top", "wide", "left-wide", "right-wide", "top-wide"];
const editorialOrders = {
  "cut-01": ["wide", "top-wide", "top", "left-wide", "right-wide", "left", "right"],
  "cut-02": ["top-wide", "wide", "top", "left-wide", "left", "right-wide", "right"],
  "cut-03": ["wide", "right", "top-wide", "left", "left-wide", "right-wide", "top"],
  "cut-04": ["wide", "right-wide", "right", "left-wide", "left", "top-wide", "top"],
  "cut-05": ["wide", "right-wide", "right", "left-wide", "left", "top-wide", "top"],
  "cut-06": ["wide", "left-wide", "left", "top", "right-wide", "right", "top-wide"],
  "cut-07": ["top", "top-wide", "wide", "left", "left-wide", "right", "right-wide"],
  "cut-08": ["top", "top-wide", "wide", "left-wide", "left", "right-wide", "right"],
  "cut-09": ["wide", "right", "top-wide", "left", "left-wide", "top", "right-wide"],
  "cut-10": ["right-wide", "right", "top", "top-wide", "left", "left-wide", "wide"],
};
const anglePurpose = {
  wide: "establish or reset the shared story geography",
  "top-wide": "show spatial relationships and story evidence together",
  top: "direct attention to the story-critical prop or action",
  "left-wide": "retain context around the left-side speaker or reaction",
  left: "favor the left-side speaker or reaction",
  "right-wide": "retain context around the right-side speaker or reaction",
  right: "favor the right-side speaker or reaction",
};
const fallbackCamera = (angle) => ({
  zoomStart: angle === "wide" ? 1.08 : 1.07,
  zoomEnd: angle === "wide" ? 1.03 : 1.12,
  focusX: angle.startsWith("left") ? 0.32 : angle.startsWith("right") ? 0.68 : 0.5,
  focusY: angle.startsWith("top") ? 0.5 : 0.38,
  saturation: 1.06,
  contrast: 1.02,
  brightness: 0.018,
});

const cameraAssetInventory = Object.fromEntries((manifest.cuts || []).map((cut) => {
  const order = editorialOrders[cut.id];
  if (!order || order.length !== 7 || new Set(order).size !== 7) {
    throw new Error(`${cut.id} is missing a seven-angle asset inventory.`);
  }
  const selectedByAngle = new Map((sequences[cut.id] || []).map((entry) => [entry.angle, entry]));
  return [cut.id, order.map((angle, index) => ({
    id: `${cut.id}-asset-${String(index + 1).padStart(2, "0")}-${angle}`,
    imagePath: asset(cut.id, angle),
    angle,
    purpose: anglePurpose[angle],
    selectedShotId: selectedByAngle.get(angle)?.id || null,
  }))];
}));

const knownUtteranceIds = new Set((manifest.utterances || []).map((utterance) => utterance.id));
const allShots = Object.values(sequences).flat();
const allInventoryAssets = Object.values(cameraAssetInventory).flat();
if ((manifest.cuts || []).length !== 10 || allShots.length !== 25 || allInventoryAssets.length !== 70) {
  throw new Error(`Expected ten cuts, 25 selected shots and 70 inventory assets; found ${manifest.cuts?.length || 0} cuts, ${allShots.length} shots and ${allInventoryAssets.length} assets.`);
}
for (const cut of manifest.cuts || []) {
  const inventory = cameraAssetInventory[cut.id] || [];
  const angles = new Set(inventory.map((entry) => entry.angle));
  if (inventory.length !== 7 || requiredAngles.some((angle) => !angles.has(angle))) {
    throw new Error(`${cut.id} must retain each of the seven angle assets in its inventory.`);
  }
}
for (const entry of allShots) {
  if (entry.utteranceIds.some((id) => !knownUtteranceIds.has(id))) throw new Error(`Unknown utterance in shot ${entry.id}.`);
  await access(entry.imagePath);
}
for (const entry of allInventoryAssets) await access(entry.imagePath);

manifest.video = {
  ...(manifest.video || {}),
  interUtteranceGapSeconds: 0.17,
  sameSpeakerGapSeconds: 0.17,
  speakerChangeGapSeconds: 0.3,
  emphasisGapSeconds: 0.5,
  cutTailSeconds: 0.32,
};
manifest.editorialPlan = {
  version: "v9-reference-hold-cadence",
  sourceIds: ["awAbZyTeE4g", "2ycRncs4CKY"],
  policy: "reference-paced shot holds: change the artwork only on a visual beat, keep bubble changes within a held camera view",
  alternateAssetCount: 70,
  selectedShotCount: 25,
  selectionRule: "all seven angles remain available per cut; the master selects only script-motivated views instead of enforcing a 70-shot quota",
  referenceCadence: {
    weakChangeMeanHoldSeconds: { awAbZyTeE4g: 6.36, "2ycRncs4CKY": 7.13 },
    currentR7WeakChangeMeanHoldSeconds: 1.25,
  },
  appliedAt: new Date().toISOString(),
};
for (const cut of manifest.cuts || []) {
  cut.cameraSequence = sequences[cut.id] || [];
  cut.cameraAssetInventory = cameraAssetInventory[cut.id] || [];
  if (cut.id === "cut-03") {
    cut.thoughtFocus = {
      speakerId: "manga-photo-homecoming-001-character-1",
      faceBounds: { x: 0.19, y: 0.08, width: 0.21, height: 0.3 },
      opacity: 0.31,
      faceBrightness: 0.1,
    };
  }
}
const utteranceById = new Map((manifest.utterances || []).map((utterance) => [utterance.id, utterance]));
const pauses = {
  "cut-03-u02": { pauseBeforeSeconds: 0.42, pauseClass: "emphasis" },
  "cut-03-u03": { pauseBeforeSeconds: 0.35 },
  "cut-07-u03": { pauseBeforeSeconds: 0.32 },
  "cut-08-u02": { pauseBeforeSeconds: 0.42, pauseClass: "emphasis" },
  "cut-08-u03": { pauseBeforeSeconds: 0.22 },
  "cut-09-u02": { pauseBeforeSeconds: 0.32 },
  "cut-09-u03": { pauseBeforeSeconds: 0.38 },
  "cut-10-u02": { pauseBeforeSeconds: 0.22 },
  "cut-10-u03": { pauseBeforeSeconds: 0.38 },
  "cut-10-u04": { pauseBeforeSeconds: 0.42, pauseClass: "emphasis" },
};
for (const [utteranceId, pause] of Object.entries(pauses)) {
  const utterance = utteranceById.get(utteranceId);
  if (!utterance) throw new Error(`Unknown pause target ${utteranceId}.`);
  Object.assign(utterance, pause);
}
manifest.status = "editorial-plan-v8-ready";
manifest.updatedAt = new Date().toISOString();
await writeJsonAtomic(manifestPath, manifest);
process.stdout.write(`${JSON.stringify({
  manifestPath,
  cutCount: manifest.cuts.length,
  selectedShotCount: manifest.cuts.reduce((total, cut) => total + (cut.cameraSequence?.length || 0), 0),
  inventoryAssetCount: manifest.cuts.reduce((total, cut) => total + (cut.cameraAssetInventory?.length || 0), 0),
  selectedUniqueAssetCount: new Set(manifest.cuts.flatMap((cut) => cut.cameraSequence?.map((entry) => entry.imagePath) || [])).size,
  inventoryUniqueAssetCount: new Set(manifest.cuts.flatMap((cut) => cut.cameraAssetInventory?.map((entry) => entry.imagePath) || [])).size,
  angles: [...new Set(manifest.cuts.flatMap((cut) => cut.cameraAssetInventory?.map((entry) => entry.angle) || []))],
  pauses,
}, null, 2)}\n`);
