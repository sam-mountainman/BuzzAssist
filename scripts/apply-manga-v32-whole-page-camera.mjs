#!/usr/bin/env node
import { copyFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";
import { MANGA_EDITORIAL_GRAMMAR_VERSION } from "../lib/mangaEditorialGrammar.mjs";
import { applyMangaCameraGrammarToPanelLayout } from "../lib/mangaPageCameraGrammar.mjs";
import { refreshEpisodeBubbleOverlays } from "../lib/mangaVideoPipeline.mjs";
import { REFERENCE_SEQUENCE_PLACEMENT_POLICY } from "../lib/speechBubbleRenderer.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas/manga-videos/manga-photo-homecoming-001");
const manifestPath = join(episodeDir, "episode-manifest.json");
const backupPath = join(episodeDir, "episode-manifest-v31-semantic-composition-r1-backup.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

if (!Array.isArray(manifest.cuts) || !Array.isArray(manifest.utterances)) {
  throw new Error("Episode manifest is incomplete.");
}
if (manifest.production?.version !== "v32-whole-page-camera-r1") {
  await copyFile(manifestPath, backupPath);
}

const cutById = new Map(manifest.cuts.map((cut) => [cut.id, cut]));
const pageCameras = {
  "cut-06": {
    zoomStart: 1.075,
    zoomEnd: 1.015,
    focusX: 0.5,
    focusY: 0.51,
    focusXEnd: 0.5,
    focusYEnd: 0.51,
    easing: "linear",
    saturation: 1.08,
    contrast: 1.035,
    brightness: 0.012,
  },
  "cut-08": {
    zoomStart: 1.065,
    zoomEnd: 1.012,
    focusX: 0.5,
    focusY: 0.515,
    focusXEnd: 0.5,
    focusYEnd: 0.515,
    easing: "linear",
    saturation: 1.08,
    contrast: 1.035,
    brightness: 0.012,
  },
};

const pageViewpointByCutId = { "cut-06": "right", "cut-08": "top" };
for (const [cutId, pageCamera] of Object.entries(pageCameras)) {
  const cut = cutById.get(cutId);
  if (!cut?.panelLayout?.enabled) throw new Error(`Required split layout is missing: ${cutId}`);
  cut.panelLayout = applyMangaCameraGrammarToPanelLayout({
    ...cut.panelLayout,
    composition: "post-composite-then-flatten",
    motionPolicy: "whole-page",
    flattenBeforeCamera: true,
    panelCamera: "static",
    pageMotion: "pull-out",
    pageCamera,
    referenceRule: cut.panelLayout.type === "story-3"
      ? "story-3; one full-height panel plus two diagonal story panels; freeze all panel crops, flatten separators and bubbles, then move one completed page"
      : "vertical-2; measured separator median 1.45% of frame width; freeze both panel crops, flatten separators and bubbles, then move one completed page",
    panels: cut.panelLayout.panels.map((panel) => {
      const zoom = panel.camera?.zoomStart ?? panel.zoom ?? 1.05;
      const focusX = panel.camera?.focusX ?? panel.focusX ?? 0.5;
      const focusY = panel.camera?.focusY ?? panel.focusY ?? 0.45;
      return {
        ...panel,
        motion: "none",
        camera: {
          ...(panel.camera || {}),
          zoomStart: zoom,
          zoomEnd: zoom,
          focusX,
          focusY,
          focusXEnd: focusX,
          focusYEnd: focusY,
          easing: "linear",
          motionLeadRatio: 0,
          motionTailRatio: 0,
        },
      };
    }),
  }, pageViewpointByCutId[cutId]);
}

manifest.video = {
  ...(manifest.video || {}),
  fileName: "manga-photo-homecoming-001-v32-whole-page-camera-r1.mp4",
  statusAfterRender: "final-v32-whole-page-camera-r1",
  cutIds: "",
  cameraRendererRevision: "v32-flatten-overlays-and-panels-before-single-page-camera-r1",
};
manifest.status = "v32-whole-page-camera-ready";
manifest.production = {
  ...(manifest.production || {}),
  version: "v32-whole-page-camera-r1",
  typographyPolicy: {
    ...(manifest.production?.typographyPolicy || {}),
    renderer: "deterministic SVG with explicit upright Japanese glyphs",
    exactTextMatchRequired: true,
    approvedPhraseColumnsPreserved: true,
    overflowForbidden: true,
    textLossForbidden: true,
    minimumEdgeClearanceFontRatio: 0.9,
  },
  splitPagePolicy: {
    version: MANGA_EDITORIAL_GRAMMAR_VERSION,
    generation: "generate clean borderless panel illustrations; add deterministic black separators in post",
    renderOrder: [
      "freeze each authored panel crop",
      "assemble panels and deterministic black gutters",
      "apply timed bubbles and thought-focus graphics",
      "flatten the entire page",
      "apply one continuous camera to the completed page",
    ],
    panelCamera: "static",
    pageCamera: "single-continuous",
    separatorWidthRatio: 0.0145,
    imageModelDrawnSeparatorsForbidden: true,
    individualPanelMotionForbidden: true,
    downwardCameraTravelForbidden: true,
    appliedCutIds: Object.keys(pageCameras),
  },
};
if (manifest.production.editorialGrammar) {
  manifest.production.editorialGrammar = {
    ...manifest.production.editorialGrammar,
    version: MANGA_EDITORIAL_GRAMMAR_VERSION,
    splitPolicy: {
      ...(manifest.production.editorialGrammar.splitPolicy || {}),
      generation: "generate borderless illustrations; draw separators deterministically; flatten the full page before motion",
      panelCamera: "static",
      pageCamera: "single continuous camera on the completed page",
      renderOrder: "panels -> gutters -> bubbles -> flatten -> page camera",
    },
  };
}
if (manifest.outputs?.reviewVideo) delete manifest.outputs.reviewVideo;
manifest.updatedAt = new Date().toISOString();
await writeJsonAtomic(manifestPath, manifest);

const refreshed = await refreshEpisodeBubbleOverlays({
  projectDir,
  manifestPath,
  refreshAll: true,
  reflowPlacement: true,
  sequenceAware: true,
  placementHistoryDepth: REFERENCE_SEQUENCE_PLACEMENT_POLICY.historyDepth,
  status: "v32-whole-page-camera-ready",
});
const finalManifest = refreshed.manifest;
const invalidTypography = refreshed.refreshed.filter((entry) => (
  entry.quality?.overflow
  || entry.quality?.textLoss
  || entry.quality?.tooSmall
  || entry.quality?.exactTextMatch === false
));
if (invalidTypography.length > 0) {
  throw new Error(`V32 typography QA failed for ${invalidTypography.map((entry) => entry.utteranceId).join(", ")}`);
}
finalManifest.status = "v32-whole-page-camera-ready";
finalManifest.production.version = "v32-whole-page-camera-r1";
finalManifest.production.typographyPolicy.refreshAudit = {
  refreshedOverlayCount: refreshed.refreshed.length,
  exactTextMatchCount: refreshed.refreshed.filter((entry) => entry.quality?.exactTextMatch).length,
  nearRepeatCount: refreshed.refreshed.filter((entry) => entry.sequencePlacement?.nearRepeat).length,
  samePocketCount: refreshed.refreshed.filter((entry) => entry.sequencePlacement?.immediate?.samePocket).length,
};
finalManifest.updatedAt = new Date().toISOString();
await writeJsonAtomic(manifestPath, finalManifest);

process.stdout.write(`${JSON.stringify({
  manifestPath,
  backupPath,
  status: finalManifest.status,
  outputFileName: finalManifest.video.fileName,
  splitCuts: Object.keys(pageCameras),
  typographyAudit: finalManifest.production.typographyPolicy.refreshAudit,
}, null, 2)}\n`);
