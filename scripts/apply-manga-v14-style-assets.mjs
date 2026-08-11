#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const projectDir = "/Users/higataiyu/Documents/Excalidraw";
const manifestPath = path.join(
  projectDir,
  "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json",
);
const assetsDir = path.join(projectDir, "canvas/assets");

const shotAssets = {
  "cut-01-v12-shot-01-left": "manga-photo-homecoming-001-v14-cut-01-left-r4.png",
  "cut-01-v12-shot-02-left-wide": "manga-photo-homecoming-001-v14-cut-01-left-wide.png",
  "cut-02-v12-shot-01-top": "manga-photo-homecoming-001-v14-cut-02-top.png",
  "cut-02-v12-shot-02-top-wide": "manga-photo-homecoming-001-v14-cut-02-top-wide.png",
  "cut-03-v12-shot-01-right": "manga-photo-homecoming-001-v14-cut-03-right-r3.png",
  "cut-03-v12-shot-02-right-wide": "manga-photo-homecoming-001-v14-cut-03-right-wide.png",
  "cut-03-v12-shot-03-left": "manga-photo-homecoming-001-v14-cut-03-left.png",
  "cut-04-v12-shot-01-left": "manga-photo-homecoming-001-v14-cut-04-left.png",
  "cut-04-v12-shot-02-top": "manga-photo-homecoming-001-v14-cut-04-top.png",
  "cut-04-v12-shot-03-right": "manga-photo-homecoming-001-v14-cut-04-right-r2.png",
  "cut-05-v12-shot-01-right": "manga-photo-homecoming-001-v14-cut-05-right-r3.png",
  "cut-05-v12-shot-02-right-wide": "manga-photo-homecoming-001-v14-cut-05-right-wide-r2.png",
  "cut-05-v12-shot-03-left": "manga-photo-homecoming-001-v14-cut-05-left-r2.png",
  "cut-06-v12-shot-01-left": "manga-photo-homecoming-001-v14-cut-06-left-r2.png",
  "cut-06-v12-shot-02-right-wide": "manga-photo-homecoming-001-v14-cut-06-right-wide-r2.png",
  "cut-07-v12-shot-01-top": "manga-photo-homecoming-001-v14-cut-07-top-r2.png",
  "cut-07-v12-shot-02-right": "manga-photo-homecoming-001-v14-cut-07-right-r2.png",
  "cut-08-v12-shot-01-top-wide": "manga-photo-homecoming-001-v14-cut-08-top-wide-r2.png",
  "cut-08-v12-shot-02-wide": "manga-photo-homecoming-001-v14-cut-08-wide-r2.png",
  "cut-09-v12-shot-01-right": "manga-photo-homecoming-001-v14-cut-09-right-r2.png",
  "cut-09-v12-shot-02-left": "manga-photo-homecoming-001-v14-cut-09-left-r2.png",
  "cut-09-v12-shot-03-top-wide": "manga-photo-homecoming-001-v14-cut-09-top-wide-r2.png",
  "cut-10-v12-shot-01-right": "manga-photo-homecoming-001-v14-cut-10-right-r2.png",
  "cut-10-v12-shot-02-left": "manga-photo-homecoming-001-v14-cut-10-left-r2.png",
  "cut-10-v12-shot-03-wide": "manga-photo-homecoming-001-v14-cut-10-wide-r2.png",
};

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const auditRows = [];
const seenShotIds = new Set();

for (const cut of manifest.cuts) {
  const sequence = cut.cameraSequence ?? [];
  for (const shot of sequence) {
    const fileName = shotAssets[shot.id];
    if (!fileName) {
      throw new Error(`No V14 asset mapping for ${shot.id}`);
    }
    const imagePath = path.join(assetsDir, fileName);
    const stat = fs.statSync(imagePath);
    if (stat.size < 100_000) {
      throw new Error(`V14 asset is unexpectedly small: ${imagePath}`);
    }
    auditRows.push({
      cutId: cut.id,
      shotId: shot.id,
      angle: shot.angle,
      shotType: shot.shotType,
      utteranceIds: shot.utteranceIds,
      oldImagePath: shot.imagePath,
      newImagePath: imagePath,
      camera: shot.camera,
    });
    shot.imagePath = imagePath;
    seenShotIds.add(shot.id);
  }

  if (sequence[0]) {
    cut.imagePath = sequence[0].imagePath;
  }
  cut.imageGeneration = {
    status: "approved-v14-reference-style",
    route: "gpt-image-2-codex+built-in-imagegen",
    visualProfileId: "koutani-reference-video-v1",
    adoptedAt: new Date().toISOString(),
  };
}

if (seenShotIds.size !== 25 || Object.keys(shotAssets).length !== 25) {
  throw new Error(
    `Expected exactly 25 mapped shots, got manifest=${seenShotIds.size}, map=${Object.keys(shotAssets).length}`,
  );
}

manifest.status = "v14-reference-style-ready";
manifest.updatedAt = new Date().toISOString();
manifest.video = {
  ...manifest.video,
  fileName: "manga-photo-homecoming-001-v14-final-r1.mp4",
  statusAfterRender: "v14-reference-style-final",
  reuseRenderedCuts: false,
  force: true,
};
manifest.production = {
  ...manifest.production,
  version: "v14-reference-style-camera-final-r1",
  visualUpgrade: {
    stylePackPath: path.join(
      projectDir,
      "canvas/visual-profiles/benchmark-manga-style-pack.json",
    ),
    locationLockId: "manga-photo-homecoming-001-location-photo-shop-v14",
    contactSheetPath: path.join(
      projectDir,
      "canvas/manga-videos/manga-photo-homecoming-001/v14-style-qa/contact-sheet-selected-25.png",
    ),
    shotCount: 25,
    backgroundPriorities: [
      "bright readable architecture",
      "layered foreground/midground/background",
      "rainy-blue exterior balanced by warm cream/wood interior",
      "speech-bubble-safe negative space away from the active speaker",
    ],
    compositionTargets: {
      referenceWideRatio: 0.325,
      authoredSpatialWideRatio: 0.36,
      mediumSubjectHeightRange: [0.68, 0.82],
      wideSubjectHeightRange: [0.4, 0.62],
    },
    preservedFromV13: [
      "camera motion",
      "utterance timing",
      "audio files",
      "speech-bubble overlays",
    ],
  },
};

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const auditPath = path.join(
  projectDir,
  "canvas/manga-videos/manga-photo-homecoming-001/v14-style-asset-plan.json",
);
fs.writeFileSync(
  auditPath,
  `${JSON.stringify(
    {
      version: "v14-reference-style-camera-final-r1",
      createdAt: new Date().toISOString(),
      manifestPath,
      shotCount: auditRows.length,
      rows: auditRows,
    },
    null,
    2,
  )}\n`,
);

console.log(`updated=${manifestPath}`);
console.log(`audit=${auditPath}`);
console.log(`shots=${auditRows.length}`);
