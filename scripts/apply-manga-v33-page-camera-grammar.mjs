#!/usr/bin/env node
import { copyFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";
import {
  MANGA_PAGE_CAMERA_GRAMMAR_VERSION,
  applyMangaCameraGrammarToPanelLayout,
  applyMangaCameraGrammarToShot,
  auditMangaPanelPageCameraGrammar,
  auditMangaShotCameraGrammar,
} from "../lib/mangaPageCameraGrammar.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const manifestPath = resolve(process.argv[3] || join(
  projectDir,
  "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json",
));
const episodeDir = dirname(manifestPath);
const backupPath = join(episodeDir, "episode-manifest-pre-v33-page-camera-grammar-r1.json");
const auditPath = join(episodeDir, "camera-grammar-v33-audit.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

if (!Array.isArray(manifest.cuts)) throw new Error("Episode manifest has no cuts.");
if (manifest.production?.version !== "v33-page-camera-grammar-r1") {
  await copyFile(manifestPath, backupPath);
}

// These are source-image viewpoints, not pan directions.  The descriptive
// composition remains available in cameraSetup/editorialPurpose; this map is
// the renderer contract that determines left/right/top/wide and its pull-out.
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
  "cut-06-v26-continuous-right-then-pullout": "right",
  "cut-07-v31-negative-proof-macro": "left",
  "cut-07-v31-overhead-proof-set": "top",
  "cut-07-v31-reiji-shock-reaction": "right",
  "cut-08-v31-phone-send-ots": "top",
  "cut-08-v26-continuous-consequence-pullout": "wide",
  "cut-09-v26-continuous-right-young-mio": "right",
  "cut-09-v26-continuous-left-young-ren": "left",
  "cut-10-v31-staircase-studio": "top",
  "cut-10-v31-intimate-side-confession": "left",
  "cut-10-v31-ren-answer": "wide",
};
const pageViewpointByCutId = { "cut-06": "right", "cut-08": "top" };

for (const cut of manifest.cuts) {
  cut.cameraSequence = (cut.cameraSequence || []).map((entry) => {
    const descriptiveSetup = entry.cameraSetup || (
      ["left", "right", "top", "wide", "editorial-plate"].includes(entry.angle) ? null : entry.angle
    );
    return applyMangaCameraGrammarToShot({
      ...entry,
      ...(descriptiveSetup ? { cameraSetup: descriptiveSetup } : {}),
    }, viewpointByShotId[entry.id]);
  });
  if (cut.panelLayout?.enabled) {
    cut.panelLayout = applyMangaCameraGrammarToPanelLayout(
      cut.panelLayout,
      pageViewpointByCutId[cut.id] || "wide",
    );
    cut.motion = cut.panelLayout.pageMotion;
    cut.camera = cut.panelLayout.pageCamera;
    cut.cameraSequence = cut.cameraSequence.map((entry) => ({
      ...entry,
      metadataOnlyUnderWholePageCamera: true,
    }));
  } else {
    const firstMovingShot = cut.cameraSequence.find((entry) => entry.motion !== "none");
    if (firstMovingShot) {
      cut.motion = firstMovingShot.motion;
      cut.camera = firstMovingShot.camera;
    }
  }
}

manifest.video = {
  ...(manifest.video || {}),
  motion: "pull-out",
  fileName: "manga-photo-homecoming-001-v33-page-camera-grammar-r1.mp4",
  statusAfterRender: "final-v33-page-camera-grammar-r1",
  cameraRendererRevision: "v33-source-viewpoint-pullout-whole-page-r1",
  cameraGrammarVersion: MANGA_PAGE_CAMERA_GRAMMAR_VERSION,
  requireSemanticCameraViews: true,
  forbidPushInCameraMotion: true,
  requireWholePageSplitCamera: true,
};
manifest.status = "v33-page-camera-grammar-ready";
manifest.production = {
  ...(manifest.production || {}),
  version: "v33-page-camera-grammar-r1",
  cameraPolicy: {
    version: MANGA_PAGE_CAMERA_GRAMMAR_VERSION,
    sourceViewpoints: ["left", "right", "top", "wide"],
    sourceViewpointMeaning: "left/right/top select the authored source-image viewpoint; they never mean pan direction",
    permittedMotion: ["pull-out", "none-for-strict-editorial-plate"],
    forbiddenMotion: ["push-in", "zoom-in", "viewpoint-as-pan", "independent-panel-camera"],
    pullOutMapping: {
      left: "left-wide",
      right: "right-wide",
      top: "top-wide",
      wide: "wide",
    },
    zoomInvariant: "zoomStart > zoomEnd for every non-editorial shot",
    focusInvariant: "focusXEnd == focusX and focusYEnd == focusY; reveal context without changing the source viewpoint",
    splitPageInvariant: "freeze panels -> add black gutters and bubbles -> flatten -> apply one page-level viewpoint-preserving pull-out",
    skill: "$manga-page-camera",
  },
  splitPagePolicy: {
    ...(manifest.production?.splitPagePolicy || {}),
    camera: "single viewpoint-preserving pull-out on the completed page",
    renderOrder: [
      "freeze each authored panel crop",
      "assemble panels with deterministic black separators",
      "composite exact SVG speech graphics and overlays",
      "flatten the completed manga page",
      "apply one page-level left/right/top/wide pull-out camera",
    ],
  },
};

const violations = [];
for (const cut of manifest.cuts) {
  if (cut.panelLayout?.enabled) {
    violations.push(...auditMangaPanelPageCameraGrammar(cut.panelLayout, cut.id));
    continue;
  }
  for (const shot of cut.cameraSequence || []) {
    violations.push(...auditMangaShotCameraGrammar(shot));
  }
}
const audit = {
  version: "camera-grammar-v33-audit-r1",
  manifestPath,
  grammarVersion: MANGA_PAGE_CAMERA_GRAMMAR_VERSION,
  cutCount: manifest.cuts.length,
  splitCutIds: manifest.cuts.filter((cut) => cut.panelLayout?.enabled).map((cut) => cut.id),
  shotCount: manifest.cuts.reduce((sum, cut) => sum + (cut.cameraSequence?.length || 0), 0),
  violations,
  pass: violations.length === 0,
};
if (!audit.pass) throw new Error(`V33 camera grammar failed: ${JSON.stringify(violations)}`);

await Promise.all([
  writeJsonAtomic(manifestPath, manifest),
  writeJsonAtomic(auditPath, audit),
]);

console.log(JSON.stringify({ manifestPath, auditPath, pass: true, version: manifest.production.version }, null, 2));
