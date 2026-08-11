#!/usr/bin/env node
import { copyFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";
import { auditMangaCompositionSequence } from "../lib/mangaSceneComposition.mjs";
import { applyMangaCameraGrammarToShot } from "../lib/mangaPageCameraGrammar.mjs";
import { refreshEpisodeBubbleOverlays } from "../lib/mangaVideoPipeline.mjs";
import { REFERENCE_SEQUENCE_PLACEMENT_POLICY } from "../lib/speechBubbleRenderer.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas/manga-videos/manga-photo-homecoming-001");
const manifestPath = join(episodeDir, "episode-manifest.json");
const backupPath = join(episodeDir, "episode-manifest-v30-editorial-plates-splits-r1-backup.json");
const dagPath = join(episodeDir, "production-dag-v31.json");
const referencePath = join(projectDir, "canvas/reference-media/love-manga/analysis/v31-composition-grammar/reference-composition-grammar-v31.json");
const generationPath = join(episodeDir, "v31-composition-asset-generation.json");
const asset = (name) => join(projectDir, "canvas/assets", name);

const [manifest, dag, reference, generation] = await Promise.all([
  readFile(manifestPath, "utf8").then(JSON.parse),
  readFile(dagPath, "utf8").then(JSON.parse),
  readFile(referencePath, "utf8").then(JSON.parse),
  readFile(generationPath, "utf8").then(JSON.parse),
]);
const compositionAudit = auditMangaCompositionSequence(dag.compositionPlan);
if (!compositionAudit.ok || dag.compositionPlan?.diagnostics?.minimumObservedChangedAxes < 3) {
  throw new Error("V31 semantic composition plan failed its adjacent-camera gate.");
}
if (generation.summary?.failed !== 0 || generation.summary?.requested !== 14) {
  throw new Error("V31 generated composition asset set is incomplete.");
}
if (reference.videos?.length !== 2 || reference.videos.some((video) => video.sampleCount < 3000)) {
  throw new Error("V31 full-reference composition analysis is incomplete.");
}
if (manifest.production?.version === "v30-editorial-plates-splits-r1") {
  await copyFile(manifestPath, backupPath);
}

const cutById = new Map(manifest.cuts.map((cut) => [cut.id, cut]));
const currentShot = (cutId, utteranceId) => cutById.get(cutId)?.cameraSequence?.find((shot) => shot.utteranceIds?.includes(utteranceId));
const viewpointByShotId = {
  "cut-01-v31-counter-macro-ren": "left",
  "cut-02-v31-overhead-restoration": "top",
  "cut-02-v31-ren-photo-reply": "right",
  "cut-03-v31-ren-ots-mio-entry": "right",
  "cut-03-v31-mio-ots-ren-thought": "left",
  "cut-03-v31-mio-rain-reflection": "right",
  "cut-04-v31-photo-foreground-theft": "left",
  "cut-04-v31-ren-evidence-question": "top",
  "cut-04-v31-mio-high-vulnerable": "right",
  "cut-05-v31-low-doorway-intrusion": "right",
  "cut-05-v31-ren-wide-challenge": "wide",
  "cut-05-v31-reiji-low-dominant": "left",
  "cut-07-v31-negative-proof-macro": "left",
  "cut-07-v31-overhead-proof-set": "top",
  "cut-07-v31-reiji-shock-reaction": "right",
  "cut-08-v31-phone-send-ots": "top",
  "cut-10-v31-staircase-studio": "top",
  "cut-10-v31-intimate-side-confession": "left",
};
const linearCamera = ({ zoomStart = 1.08, zoomEnd = 1.02, focusX = 0.5, focusY = 0.45 }) => ({
  zoomStart: Math.max(zoomStart, zoomEnd),
  zoomEnd: Math.min(zoomStart, zoomEnd),
  focusX,
  focusY,
  focusXEnd: focusX,
  focusYEnd: focusY,
  easing: "linear",
  motionLeadRatio: 0,
  motionTailRatio: 0,
  saturation: 1,
  contrast: 1,
  brightness: 0,
  keyframes: [
    { at: 0, zoom: Math.max(zoomStart, zoomEnd), focusX, focusY },
    { at: 1, zoom: Math.min(zoomStart, zoomEnd), focusX, focusY },
  ],
});
const shot = ({ id, utteranceIds, file, setup, purpose, camera, screenFaceBoundsBySpeakerId }) => applyMangaCameraGrammarToShot({
  id,
  utteranceIds,
  imagePath: file,
  cameraSetup: setup,
  transition: "cut",
  motion: "pull-out",
  camera: linearCamera(camera || {}),
  motionStrength: "subtle",
  ...(screenFaceBoundsBySpeakerId ? { screenFaceBoundsBySpeakerId } : {}),
  editorialBeat: purpose,
  editorialPurpose: purpose,
  semanticStartSubject: purpose,
  semanticEndSubject: purpose,
  isSpatialWideShot: /wide|doorway|staircase/.test(setup),
  wideShotSource: /wide|doorway|staircase/.test(setup) ? "semantic-generated-source" : null,
  compositionVersion: "v31-semantic-camera-r1",
}, viewpointByShotId[id]);

const cut01 = cutById.get("cut-01");
cut01.cameraSequence = [
  currentShot("cut-01", "cut-01-u01"),
  currentShot("cut-01", "cut-01-u02"),
  shot({
    id: "cut-01-v31-counter-macro-ren",
    utteranceIds: ["cut-01-u03"],
    file: asset("manga-photo-homecoming-001-v31-cut-01-u03-counter-macro-ren.png"),
    setup: "counter-level-object-three-plane",
    purpose: "enlarger and negative lead into Ren's closing-time work",
    camera: { zoomStart: 1.02, zoomEnd: 1.08, focusX: 0.31, focusY: 0.45, focusXEnd: 0.27, focusYEnd: 0.43 },
  }),
];
cut01.imagePath = cut01.cameraSequence[2].imagePath;

const cut02 = cutById.get("cut-02");
cut02.cameraSequence = [
  shot({
    id: "cut-02-v31-overhead-restoration",
    utteranceIds: ["cut-02-u01"],
    file: asset("manga-photo-homecoming-001-v16-cut-02-top-ren-evidence.png"),
    setup: "overhead-workbench",
    purpose: "the restoration task and family photograph carry narration",
    camera: { zoomStart: 1.2, zoomEnd: 1.08, focusX: 0.5, focusY: 0.54, focusXEnd: 0.5, focusYEnd: 0.48 },
  }),
  shot({
    id: "cut-02-v31-ren-photo-reply",
    utteranceIds: ["cut-02-u02"],
    file: asset("manga-photo-homecoming-001-v16-proof-closeup-ren.png"),
    setup: "profile-close-object-reply",
    purpose: "Ren and the restored photograph share the reply without repeating the overhead view",
    camera: { zoomStart: 1.12, zoomEnd: 1.2, focusX: 0.38, focusY: 0.36, focusXEnd: 0.4, focusYEnd: 0.34 },
  }),
];

const cut03 = cutById.get("cut-03");
cut03.cameraSequence = [
  shot({ id: "cut-03-v31-ren-ots-mio-entry", utteranceIds: ["cut-03-u01"], file: asset("manga-photo-homecoming-001-v31-cut-03-u01-ren-ots-mio-door.png"), setup: "reverse-ots-entry-depth", purpose: "Mio is discovered through Ren's foreground point of view", camera: { zoomStart: 1.01, zoomEnd: 1.07, focusX: 0.57, focusY: 0.44 } }),
  shot({
    id: "cut-03-v31-mio-ots-ren-thought",
    utteranceIds: ["cut-03-u02"],
    file: asset("manga-photo-homecoming-001-v31-cut-03-u02-mio-ots-ren-reaction.png"),
    setup: "listener-reaction-ots",
    purpose: "Ren's stopped hand and startled face carry his private thought",
    camera: { zoomStart: 1.04, zoomEnd: 1.12, focusX: 0.3, focusY: 0.34 },
    screenFaceBoundsBySpeakerId: {
      "manga-photo-homecoming-001-character-1": { x: 0.12, y: 0.07, width: 0.13, height: 0.23 },
    },
  }),
  shot({ id: "cut-03-v31-mio-rain-reflection", utteranceIds: ["cut-03-u03"], file: asset("manga-photo-homecoming-001-v31-cut-03-u03-mio-rain-reflection.png"), setup: "window-reflection-profile", purpose: "Mio's uncertain homecoming appears as a profile and rain reflection", camera: { zoomStart: 1.04, zoomEnd: 1.11, focusX: 0.68, focusY: 0.35, focusXEnd: 0.7, focusYEnd: 0.34 } }),
];
cut03.imagePath = cut03.cameraSequence[0].imagePath;

const cut04 = cutById.get("cut-04");
cut04.cameraSequence = [
  shot({ id: "cut-04-v31-photo-foreground-theft", utteranceIds: ["cut-04-u01"], file: asset("manga-photo-homecoming-001-v31-cut-04-u01-photo-foreground-theft.png"), setup: "counter-level-photo-foreground", purpose: "the stolen photograph physically leads Mio's accusation", camera: { zoomStart: 1.02, zoomEnd: 1.08, focusX: 0.31, focusY: 0.43, focusXEnd: 0.28, focusYEnd: 0.4 } }),
  shot({ id: "cut-04-v31-ren-evidence-question", utteranceIds: ["cut-04-u02"], file: asset("manga-photo-homecoming-001-v16-cut-04-top-evidence.png"), setup: "overhead-evidence-question", purpose: "Ren's concrete evidence question cuts to the photo and work surface", camera: { zoomStart: 1.16, zoomEnd: 1.06, focusX: 0.5, focusY: 0.55, focusYEnd: 0.49 } }),
  shot({ id: "cut-04-v31-mio-high-vulnerable", utteranceIds: ["cut-04-u03"], file: asset("manga-photo-homecoming-001-v31-cut-04-u03-mio-high-vulnerable.png"), setup: "high-vulnerable-single", purpose: "the high angle and empty shop make Mio's misplaced trust visible", camera: { zoomStart: 1.02, zoomEnd: 1.09, focusX: 0.72, focusY: 0.58, focusXEnd: 0.74, focusYEnd: 0.55 } }),
];
cut04.imagePath = cut04.cameraSequence[0].imagePath;

const cut05 = cutById.get("cut-05");
cut05.cameraSequence = [
  shot({ id: "cut-05-v31-low-doorway-intrusion", utteranceIds: ["cut-05-u01"], file: asset("manga-photo-homecoming-001-v31-cut-05-u01-low-doorway-intrusion.png"), setup: "low-doorway-triangle", purpose: "Reiji invades the room through a cold, low doorway composition", camera: { zoomStart: 1.01, zoomEnd: 1.07, focusX: 0.78, focusY: 0.35, focusXEnd: 0.75, focusYEnd: 0.34 } }),
  shot({ id: "cut-05-v31-ren-wide-challenge", utteranceIds: ["cut-05-u02"], file: asset("manga-photo-homecoming-001-v16-cut-05-wide-confrontation.png"), setup: "triangular-wide-reverse", purpose: "Ren's challenge restores all three positions in a wide triangle", camera: { zoomStart: 1.08, zoomEnd: 1.14, focusX: 0.42, focusY: 0.43, focusXEnd: 0.38, focusYEnd: 0.42 } }),
  shot({ id: "cut-05-v31-reiji-low-dominant", utteranceIds: ["cut-05-u03"], file: asset("manga-photo-homecoming-001-v31-cut-05-u03-reiji-low-dominant.png"), setup: "low-dominant-close", purpose: "Reiji's sales claim becomes a compressed low close-up across Ren's shoulder", camera: { zoomStart: 1.04, zoomEnd: 1.12, focusX: 0.78, focusY: 0.34, focusXEnd: 0.8, focusYEnd: 0.33 } }),
];
cut05.imagePath = cut05.cameraSequence[0].imagePath;

const cut06 = cutById.get("cut-06");
cut06.panelLayout = {
  ...(cut06.panelLayout || {}),
  enabled: true,
  type: "vertical-2",
  composition: "post-composite",
  separatorColor: "black",
  gutter: 28,
  ratios: [0.42, 0.58],
  editorialReason: "Mio's memory-led refusal and Reiji's coercive counter-pressure use independent, unequal viewpoints",
  panels: [
    { imagePath: asset("manga-photo-homecoming-001-v31-cut-06-u01-mio-memory-photo.png"), role: "Mio protects the grandmother photograph", motion: "independent-continuous", camera: { zoomStart: 1.04, zoomEnd: 1.1, focusX: 0.34, focusY: 0.42, focusXEnd: 0.3, focusYEnd: 0.4, easing: "linear" } },
    { imagePath: asset("manga-photo-homecoming-001-v31-cut-06-u02-reiji-pressure-profile.png"), role: "Reiji applies cold pressure through reflected glass", motion: "independent-continuous", camera: { zoomStart: 1.03, zoomEnd: 1.11, focusX: 0.7, focusY: 0.34, focusXEnd: 0.73, focusYEnd: 0.33, easing: "linear" } },
  ],
};

const cut07 = cutById.get("cut-07");
cut07.cameraSequence = [
  shot({ id: "cut-07-v31-negative-proof-macro", utteranceIds: ["cut-07-u01"], file: asset("manga-photo-homecoming-001-v31-cut-07-u01-negative-proof-macro.png"), setup: "macro-negative-evidence", purpose: "the actual negative enters before anyone's reaction", camera: { zoomStart: 1.02, zoomEnd: 1.1, focusX: 0.42, focusY: 0.39, focusXEnd: 0.38, focusYEnd: 0.37 } }),
  shot({ id: "cut-07-v31-overhead-proof-set", utteranceIds: ["cut-07-u02"], file: asset("manga-photo-homecoming-001-v16-cut-07-top-evidence-proof.png"), setup: "overhead-record-set", purpose: "data, dates, and receipt expand from one negative to the complete proof set", camera: { zoomStart: 1.16, zoomEnd: 1.05, focusX: 0.5, focusY: 0.56, focusYEnd: 0.48 } }),
  shot({ id: "cut-07-v31-reiji-shock-reaction", utteranceIds: ["cut-07-u03"], file: asset("manga-photo-homecoming-001-v16-cut-07-close-reiji-shock.png"), setup: "single-reaction-close", purpose: "Reiji's denial cuts away from the objects to an isolated reaction", camera: { zoomStart: 1.1, zoomEnd: 1.18, focusX: 0.44, focusY: 0.31 } }),
];
cut07.imagePath = cut07.cameraSequence[0].imagePath;

const cut08 = cutById.get("cut-08");
cut08.cameraSequence = [
  shot({ id: "cut-08-v31-phone-send-ots", utteranceIds: ["cut-08-u01"], file: asset("manga-photo-homecoming-001-v31-cut-08-u01-phone-send-ots.png"), setup: "phone-action-ots-depth", purpose: "Mio's thumb, Ren's support, and Reiji's isolation share three depth planes", camera: { zoomStart: 1.02, zoomEnd: 1.08, focusX: 0.73, focusY: 0.58, focusXEnd: 0.7, focusYEnd: 0.55 } }),
  ...cut08.cameraSequence.filter((entry) => !entry.utteranceIds?.includes("cut-08-u01")),
];
cut08.panelLayout.panels[0].imagePath = cut08.cameraSequence[0].imagePath;
cut08.panelLayout.panels[0].role = "Mio sends proof from an over-phone viewpoint";

const cut10 = cutById.get("cut-10");
const cut10Answer = currentShot("cut-10", "cut-10-u03");
const cut10Closing = currentShot("cut-10", "cut-10-u04");
cut10.cameraSequence = [
  shot({ id: "cut-10-v31-staircase-studio", utteranceIds: ["cut-10-u01"], file: asset("manga-photo-homecoming-001-v31-cut-10-u01-staircase-studio.png"), setup: "high-staircase-diagonal-wide", purpose: "the proposed studio is shown through the actual upstairs architecture", camera: { zoomStart: 1.01, zoomEnd: 1.07, focusX: 0.38, focusY: 0.46, focusXEnd: 0.42, focusYEnd: 0.43 } }),
  shot({ id: "cut-10-v31-intimate-side-confession", utteranceIds: ["cut-10-u02"], file: asset("manga-photo-homecoming-001-v31-cut-10-u02-intimate-side-confession.png"), setup: "layered-profile-two-shot", purpose: "Mio's intimate confession changes from architecture to unequal side profiles", camera: { zoomStart: 1.04, zoomEnd: 1.12, focusX: 0.72, focusY: 0.35, focusXEnd: 0.74, focusYEnd: 0.34 } }),
  { ...cut10Answer, id: "cut-10-v31-ren-answer", utteranceIds: ["cut-10-u03"] },
  cut10Closing,
];
cut10.imagePath = cut10.cameraSequence[0].imagePath;

const bubbleOverrides = {
  "cut-01-u03": { avoidRegions: [
    { id: "ren", kind: "face", x: 0.04, y: 0.12, width: 0.28, height: 0.48, weight: 1600 },
    { id: "film", kind: "evidence", x: 0, y: 0.48, width: 0.62, height: 0.5, weight: 900 },
  ] },
  "cut-03-u01": { avoidRegions: [
    { id: "ren-foreground", kind: "body", x: 0.03, y: 0.05, width: 0.43, height: 0.95, weight: 500 },
    { id: "mio", kind: "face", x: 0.48, y: 0.12, width: 0.17, height: 0.29, weight: 1600 },
  ] },
  "cut-03-u02": { avoidRegions: [
    { id: "ren", kind: "face", x: 0.16, y: 0.1, width: 0.27, height: 0.43, weight: 1600 },
    { id: "mio-foreground", kind: "body", x: 0.62, y: 0, width: 0.38, height: 1, weight: 500 },
  ] },
  "cut-03-u03": { avoidRegions: [
    { id: "mio", kind: "face", x: 0.57, y: 0.05, width: 0.35, height: 0.55, weight: 1600 },
    { id: "reflection", kind: "face", x: 0.82, y: 0.05, width: 0.18, height: 0.55, weight: 1000 },
  ] },
  "cut-04-u01": { avoidRegions: [
    { id: "mio", kind: "face", x: 0.12, y: 0.05, width: 0.25, height: 0.38, weight: 1600 },
    { id: "photo", kind: "evidence", x: 0, y: 0.47, width: 0.5, height: 0.53, weight: 900 },
  ] },
  "cut-04-u03": { avoidRegions: [
    { id: "mio", kind: "face", x: 0.66, y: 0.32, width: 0.19, height: 0.3, weight: 1600 },
    { id: "mio-body", kind: "body", x: 0.57, y: 0.3, width: 0.35, height: 0.7, weight: 400 },
  ] },
  "cut-05-u01": { avoidRegions: [
    { id: "ren-mio-foreground", kind: "body", x: 0.28, y: 0.37, width: 0.52, height: 0.63, weight: 500 },
    { id: "reiji", kind: "face", x: 0.75, y: 0.03, width: 0.14, height: 0.24, weight: 1600 },
  ] },
  "cut-05-u03": { avoidRegions: [
    { id: "ren-foreground", kind: "body", x: 0, y: 0, width: 0.26, height: 1, weight: 500 },
    { id: "reiji", kind: "face", x: 0.69, y: 0.03, width: 0.2, height: 0.34, weight: 1600 },
  ] },
  "cut-07-u01": { avoidRegions: [
    { id: "negative", kind: "evidence", x: 0.2, y: 0, width: 0.42, height: 1, weight: 1000 },
    { id: "reiji", kind: "face", x: 0.55, y: 0.23, width: 0.2, height: 0.32, weight: 1600 },
    { id: "mio", kind: "face", x: 0.76, y: 0.22, width: 0.13, height: 0.24, weight: 1200 },
  ] },
  "cut-08-u01": { avoidRegions: [
    { id: "ren", kind: "face", x: 0.38, y: 0.08, width: 0.13, height: 0.24, weight: 1400 },
    { id: "reiji", kind: "face", x: 0.82, y: 0.06, width: 0.12, height: 0.24, weight: 1400 },
    { id: "mio-phone", kind: "evidence", x: 0.5, y: 0.25, width: 0.5, height: 0.75, weight: 1000 },
  ] },
  "cut-10-u01": { avoidRegions: [
    { id: "mio", kind: "face", x: 0.12, y: 0.18, width: 0.17, height: 0.3, weight: 1600 },
    { id: "ren", kind: "face", x: 0.44, y: 0.43, width: 0.13, height: 0.24, weight: 1600 },
  ] },
  "cut-10-u02": { avoidRegions: [
    { id: "ren", kind: "face", x: 0.3, y: 0.1, width: 0.16, height: 0.3, weight: 1600 },
    { id: "mio", kind: "face", x: 0.62, y: 0.04, width: 0.25, height: 0.46, weight: 1600 },
  ] },
};

manifest.video = {
  ...(manifest.video || {}),
  fileName: "manga-photo-homecoming-001-v31-semantic-composition-r1.mp4",
  statusAfterRender: "final-v31-semantic-composition-r1",
  cameraRendererRevision: "v31-semantic-composition-independent-sources-r1",
  cutIds: "",
};
manifest.status = "v31-semantic-composition-ready";
manifest.production = {
  ...(manifest.production || {}),
  version: "v31-semantic-composition-r1",
  sceneComposition: {
    plannerVersion: dag.compositionPlan.version,
    productionDagPath: dagPath,
    referenceAnalysisPath: referencePath,
    generationManifestPath: generationPath,
    referenceSources: reference.videos.map((video) => ({ source: video.source, sampleCount: video.sampleCount, detectedEditorialChangeCount: video.detectedEditorialChangeCount })),
    rules: dag.compositionPlan.policy,
    diagnostics: dag.compositionPlan.diagnostics,
    audit: compositionAudit,
    generatedAssetCount: generation.summary.requested,
    appliedGeneratedShots: 14,
    retainedDistinctShots: ["cut-02 overhead/close", "cut-04 overhead evidence", "cut-05 triangular wide", "cut-07 overhead/reaction", "cut-09 childhood cameras"],
  },
};
manifest.updatedAt = new Date().toISOString();
if (manifest.outputs?.reviewVideo) delete manifest.outputs.reviewVideo;
await writeJsonAtomic(manifestPath, manifest);

const refreshed = await refreshEpisodeBubbleOverlays({
  projectDir,
  manifestPath,
  bubbleOverrides,
  refreshAll: true,
  reflowPlacement: true,
  sequenceAware: true,
  placementHistoryDepth: REFERENCE_SEQUENCE_PLACEMENT_POLICY.historyDepth,
  status: "v31-semantic-composition-ready",
});
const finalManifest = refreshed.manifest;
finalManifest.status = "v31-semantic-composition-ready";
finalManifest.production.version = "v31-semantic-composition-r1";
finalManifest.production.sceneComposition.bubbleRefreshAudit = {
  refreshedOverlayCount: refreshed.refreshed.length,
  nearRepeatCount: refreshed.refreshed.filter((entry) => entry.sequencePlacement?.nearRepeat).length,
  samePocketCount: refreshed.refreshed.filter((entry) => entry.sequencePlacement?.immediate?.samePocket).length,
};
finalManifest.updatedAt = new Date().toISOString();
await writeJsonAtomic(manifestPath, finalManifest);

process.stdout.write(`${JSON.stringify({
  manifestPath,
  backupPath,
  outputFileName: finalManifest.video.fileName,
  compositionDiagnostics: finalManifest.production.sceneComposition.diagnostics,
  compositionAudit,
  bubbleRefreshAudit: finalManifest.production.sceneComposition.bubbleRefreshAudit,
  generatedAssetCount: finalManifest.production.sceneComposition.generatedAssetCount,
}, null, 2)}\n`);
