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
  mangaCameraModeFamily,
} from "../lib/mangaPageCameraGrammar.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const manifestPath = resolve(process.argv[3] || join(
  projectDir,
  "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json",
));
const episodeDir = dirname(manifestPath);
const backupPath = join(episodeDir, "episode-manifest-pre-v35-camera-grammar-restored-r1.json");
const planPath = join(episodeDir, "camera-grammar-v35-plan.json");
const auditPath = join(episodeDir, "camera-grammar-v35-audit.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

if (!Array.isArray(manifest.cuts)) throw new Error("Episode manifest has no cuts.");
if (manifest.production?.version !== "v35-camera-grammar-restored-r1") {
  await copyFile(manifestPath, backupPath);
}

// Recovered from task 019fd34d-602f-7a93-b28d-b784787a22e3.
// This is deliberately not an all-pull-out plan.  The three camera families
// must remain visually distinct and must be selected from the scene purpose.
const modeByShotId = Object.freeze({
  "cut-01-v31-counter-macro-ren": "left-only",
  "cut-02-v31-overhead-restoration": "top-only",
  "cut-02-v31-ren-photo-reply": "right-only",
  "cut-03-v31-ren-ots-mio-entry": "right-only",
  "cut-03-v31-mio-ots-ren-thought": "left-only",
  "cut-03-v31-mio-rain-reflection": "right-only",
  "cut-04-v31-photo-foreground-theft": "left-only",
  "cut-04-v31-ren-evidence-question": "top-then-pullout",
  "cut-04-v31-mio-high-vulnerable": "pullout-only",
  "cut-05-v31-low-doorway-intrusion": "right-only",
  "cut-05-v31-ren-wide-challenge": "pullout-only",
  "cut-05-v31-reiji-low-dominant": "left-only",
  "cut-07-v31-negative-proof-macro": "left-only",
  "cut-07-v31-overhead-proof-set": "top-then-pullout",
  "cut-07-v31-reiji-shock-reaction": "pullout-only",
  "cut-09-v26-continuous-right-young-mio": "right-only",
  "cut-09-v26-continuous-left-young-ren": "left-only",
  "cut-10-v31-staircase-studio": "top-only",
  "cut-10-v31-intimate-side-confession": "left-then-pullout",
  "cut-10-v31-ren-answer": "pullout-only",
});

const pagePlanByCutId = Object.freeze({
  "cut-06": { viewpoint: "right", mode: "right-then-pullout" },
  "cut-08": { viewpoint: "top", mode: "top-then-pullout" },
});

const rows = [];
const unknownMovingShots = [];
for (const cut of manifest.cuts) {
  cut.cameraSequence = (cut.cameraSequence || []).map((entry) => {
    const staticEditorialPlate = entry.motion === "none"
      && entry.editorialPlate?.characterPolicy === "strictly-none"
      && entry.editorialPlate?.environmentPolicy === "none";
    if (staticEditorialPlate) {
      const normalized = applyMangaCameraGrammarToShot(entry, entry.viewpoint, "none");
      rows.push({ cutId: cut.id, targetId: entry.id, scope: "shot", viewpoint: "graphic", mode: "none", family: "static" });
      return normalized;
    }
    if (cut.panelLayout?.enabled) {
      const normalized = applyMangaCameraGrammarToShot(entry, entry.viewpoint || entry.angle, "none");
      return {
        ...normalized,
        motion: "none",
        cameraMode: "none",
        metadataOnlyUnderWholePageCamera: true,
      };
    }
    const mode = modeByShotId[entry.id];
    if (!mode) {
      unknownMovingShots.push({ cutId: cut.id, shotId: entry.id });
      return entry;
    }
    const normalized = applyMangaCameraGrammarToShot(entry, entry.viewpoint || entry.angle, mode);
    rows.push({
      cutId: cut.id,
      targetId: entry.id,
      scope: "shot",
      viewpoint: normalized.viewpoint,
      endView: normalized.endView,
      mode,
      family: mangaCameraModeFamily(mode),
      keyframes: normalized.camera?.keyframes,
    });
    return normalized;
  });

  if (cut.panelLayout?.enabled) {
    const pagePlan = pagePlanByCutId[cut.id];
    if (!pagePlan) throw new Error(`Missing whole-page camera plan for ${cut.id}.`);
    cut.panelLayout = applyMangaCameraGrammarToPanelLayout(
      cut.panelLayout,
      pagePlan.viewpoint,
      pagePlan.mode,
    );
    cut.motion = cut.panelLayout.pageMotion;
    cut.camera = cut.panelLayout.pageCamera;
    rows.push({
      cutId: cut.id,
      targetId: `${cut.id}-flattened-page`,
      scope: "flattened-page",
      viewpoint: cut.panelLayout.pageViewpoint,
      endView: cut.panelLayout.pageEndView,
      mode: cut.panelLayout.pageMotion,
      family: mangaCameraModeFamily(cut.panelLayout.pageMotion),
      keyframes: cut.panelLayout.pageCamera?.keyframes,
      invariant: "static panel crops -> black gutters + overlays -> flatten -> one page-level camera",
    });
  } else {
    const firstMovingShot = cut.cameraSequence.find((entry) => entry.motion !== "none");
    if (firstMovingShot) {
      cut.motion = firstMovingShot.motion;
      cut.camera = firstMovingShot.camera;
    }
  }
}

if (unknownMovingShots.length > 0) {
  throw new Error(`Unplanned moving shots: ${JSON.stringify(unknownMovingShots)}`);
}

manifest.video = {
  ...(manifest.video || {}),
  motion: "pull-out",
  fileName: "manga-photo-homecoming-001-v35-camera-grammar-restored-r1.mp4",
  statusAfterRender: "final-v35-camera-grammar-restored-r1",
  cameraRendererRevision: "v35-three-family-sequential-camera-r1",
  cameraGrammarVersion: MANGA_PAGE_CAMERA_GRAMMAR_VERSION,
  requireSemanticCameraViews: true,
  forbidPushInCameraMotion: true,
  requireWholePageSplitCamera: true,
  requireConstantCameraSpeed: true,
  forbidDownwardCameraMotion: true,
  forbidRepeatedCameraImages: true,
  forbidCameraStops: true,
  cameraOversample: 3,
  renderConcurrency: 1,
};
delete manifest.video.cutIds;

manifest.status = "v35-camera-grammar-restored-ready";
manifest.production = {
  ...(manifest.production || {}),
  version: "v35-camera-grammar-restored-r1",
  cameraPolicy: {
    version: MANGA_PAGE_CAMERA_GRAMMAR_VERSION,
    recoveredFromTask: "019fd34d-602f-7a93-b28d-b784787a22e3",
    movingFamiliesRequired: ["directional", "pullout", "combined"],
    modes: [
      "left-only", "right-only", "top-only",
      "pullout-only",
      "left-then-pullout", "right-then-pullout", "top-then-pullout",
    ],
    standardTravel: { horizontalFrameRatio: 0.22, topFrameRatio: 0.19 },
    pulloutReveal: { minimumFrameAreaRatio: 0.24, preferredFrameAreaRatio: 0.3 },
    combinedInvariant: "direction first; pull-out starts at the reached focus with no reset",
    constantSpeedInvariant: "linear progress, zero lead hold, zero tail hold, no segment stop",
    forbidden: ["push-in", "zoom-in", "down", "weak-directional-drift", "reset-before-pullout", "crop-wall-collision"],
    skill: "$manga-page-camera",
  },
  splitPagePolicy: {
    ...(manifest.production?.splitPagePolicy || {}),
    camera: "the completed split page is one ordinary frame under the same v2 camera grammar",
    renderOrder: [
      "freeze each authored panel crop",
      "assemble panels with deterministic black separators",
      "composite exact speech graphics and overlays",
      "flatten the completed page",
      "move the single completed page with directional, pull-out, or combined camera grammar",
    ],
    forbidden: ["independent-panel-pan", "independent-panel-zoom", "moving-gutter", "bubble-detached-from-page"],
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

const countedRows = rows.filter((row) => row.scope !== "panel-source-metadata");
const familyCounts = countedRows.reduce((counts, row) => {
  counts[row.family] = (counts[row.family] || 0) + 1;
  return counts;
}, {});
const expectedCounts = { directional: 13, pullout: 4, combined: 5, static: 4 };
for (const [family, expected] of Object.entries(expectedCounts)) {
  if ((familyCounts[family] || 0) !== expected) {
    violations.push({ type: "camera-family-count-mismatch", family, expected, actual: familyCounts[family] || 0 });
  }
}

const audit = {
  version: "camera-grammar-v35-audit-r1",
  grammarVersion: MANGA_PAGE_CAMERA_GRAMMAR_VERSION,
  manifestPath,
  recoveredFromTask: "019fd34d-602f-7a93-b28d-b784787a22e3",
  expectedCounts,
  familyCounts,
  movingPageOrShotCount: (familyCounts.directional || 0) + (familyCounts.pullout || 0) + (familyCounts.combined || 0),
  splitPageCount: countedRows.filter((row) => row.scope === "flattened-page").length,
  violations,
  pass: violations.length === 0,
};
if (!audit.pass) throw new Error(`V35 camera grammar failed: ${JSON.stringify(violations)}`);

const plan = {
  version: "camera-grammar-v35-plan-r1",
  grammarVersion: MANGA_PAGE_CAMERA_GRAMMAR_VERSION,
  recoveredFromTask: "019fd34d-602f-7a93-b28d-b784787a22e3",
  summary: {
    ...familyCounts,
    splitPages: audit.splitPageCount,
    totalMovingPagesOrShots: audit.movingPageOrShotCount,
  },
  rows: countedRows,
};

await Promise.all([
  writeJsonAtomic(manifestPath, manifest),
  writeJsonAtomic(planPath, plan),
  writeJsonAtomic(auditPath, audit),
]);

console.log(JSON.stringify({
  manifestPath,
  backupPath,
  planPath,
  auditPath,
  version: manifest.production.version,
  familyCounts,
  pass: true,
}, null, 2));
