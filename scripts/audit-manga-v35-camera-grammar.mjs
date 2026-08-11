#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";
import {
  auditCameraSequencePolicy,
  normalizeCameraShotSequence,
  normalizePanelLayout,
} from "../lib/mangaVideoPipeline.mjs";
import {
  auditMangaPanelPageCameraGrammar,
  auditMangaShotCameraGrammar,
  mangaCameraModeDirection,
  mangaCameraModeFamily,
  normalizeMangaCameraMode,
} from "../lib/mangaPageCameraGrammar.mjs";

const execFile = promisify(execFileCallback);
const projectDir = resolve(process.argv[2] || process.cwd());
const manifestPath = resolve(process.argv[3] || join(
  projectDir,
  "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json",
));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const episodeDir = dirname(manifestPath);
const videoPath = resolve(
  process.argv[4]
    || manifest.outputs?.reviewVideo?.filePath
    || manifest.outputs?.finalVideo?.filePath
    || "",
);
if (!videoPath) throw new Error("Rendered video path is required.");

const planPath = join(episodeDir, "v35-rendered-camera-plan.json");
const motionAuditPath = join(episodeDir, "v35-rendered-camera-motion-audit.json");
const finalAuditPath = join(episodeDir, "v35-rendered-camera-final-audit.json");
const contactSheetPath = join(episodeDir, "v35-camera-proof-contact-sheet.jpg");
const utterancesByCut = new Map();
for (const utterance of manifest.utterances || []) {
  const rows = utterancesByCut.get(utterance.cutId) || [];
  rows.push(utterance);
  utterancesByCut.set(utterance.cutId, rows);
}

const cameraDelta = (camera = {}) => {
  const keyframes = Array.isArray(camera.keyframes) && camera.keyframes.length >= 2
    ? camera.keyframes
    : [
        { zoom: camera.zoomStart, focusX: camera.focusX, focusY: camera.focusY },
        { zoom: camera.zoomEnd, focusX: camera.focusXEnd, focusY: camera.focusYEnd },
      ];
  const first = keyframes[0];
  const last = keyframes.at(-1);
  return {
    zoom: Number(last.zoom) - Number(first.zoom),
    focusX: Number(last.focusX) - Number(first.focusX),
    focusY: Number(last.focusY) - Number(first.focusY),
  };
};

const planRows = [];
const semanticViolations = [];
const policyAudits = [];
for (const cut of manifest.cuts || []) {
  const durationSeconds = Number(cut.timing?.durationSeconds || 0);
  const layout = normalizePanelLayout(cut.panelLayout, 1920, 1080, cut.imagePath);
  if (layout) {
    const mode = normalizeMangaCameraMode(layout.pageCameraMode ?? layout.pageMotion);
    const family = mangaCameraModeFamily(mode);
    const direction = mangaCameraModeDirection(mode);
    const delta = cameraDelta(layout.pageCamera);
    semanticViolations.push(...auditMangaPanelPageCameraGrammar(cut.panelLayout, cut.id));
    policyAudits.push(auditCameraSequencePolicy(manifest, cut, []));
    planRows.push({
      cutId: cut.id,
      shotId: `${cut.id}-flattened-page`,
      angle: `${layout.pageViewpoint}->${layout.pageEndView}`,
      mode,
      family,
      direction,
      splitPage: true,
      durationSeconds,
      directionPhase: Number(layout.pageCamera?.directionPhase
        ?? (Array.isArray(layout.pageCamera?.keyframes) && layout.pageCamera.keyframes.length === 3
          ? layout.pageCamera.keyframes[1].at
          : NaN)) || undefined,
      authoredZoomPercentPerSecond: delta.zoom * 100 / durationSeconds,
      authoredTranslationPercentPerSecond: Math.hypot(delta.focusX, delta.focusY) * 100 / durationSeconds,
    });
    continue;
  }
  const shots = normalizeCameraShotSequence(
    cut,
    utterancesByCut.get(cut.id) || [],
    durationSeconds,
  );
  policyAudits.push(auditCameraSequencePolicy(manifest, cut, shots));
  for (const shot of shots) {
    const staticGraphic = shot.motion === "none";
    const mode = staticGraphic ? "none" : normalizeMangaCameraMode(shot.motion);
    const family = staticGraphic ? "static" : mangaCameraModeFamily(mode);
    const direction = staticGraphic ? "" : mangaCameraModeDirection(mode);
    const delta = cameraDelta(shot.camera);
    semanticViolations.push(...auditMangaShotCameraGrammar(shot));
    planRows.push({
      cutId: cut.id,
      shotId: shot.id,
      angle: `${shot.viewpoint}->${shot.endView}`,
      mode,
      family,
      direction,
      splitPage: false,
      durationSeconds: shot.durationSeconds,
      directionPhase: Number(shot.camera?.directionPhase
        ?? (Array.isArray(shot.camera?.keyframes) && shot.camera.keyframes.length === 3
          ? shot.camera.keyframes[1].at
          : NaN)) || undefined,
      authoredZoomPercentPerSecond: delta.zoom * 100 / Math.max(0.001, shot.durationSeconds),
      authoredTranslationPercentPerSecond: Math.hypot(delta.focusX, delta.focusY) * 100 / Math.max(0.001, shot.durationSeconds),
    });
  }
}

await writeJsonAtomic(planPath, {
  version: "v35-rendered-camera-plan-r1",
  videoPath,
  rows: planRows,
});

await execFile("python3", [
  join(projectDir, "scripts/analyze-manga-shot-motion.py"),
  "--video", videoPath,
  "--manifest", manifestPath,
  "--plan", planPath,
  "--output", motionAuditPath,
], { cwd: projectDir, maxBuffer: 32 * 1024 * 1024 });

await execFile("ffmpeg", ["-v", "error", "-xerror", "-i", videoPath, "-f", "null", "-"], {
  maxBuffer: 16 * 1024 * 1024,
});

const motionAudit = JSON.parse(await readFile(motionAuditPath, "utf8"));
const measuredById = new Map((motionAudit.rows || []).map((row) => [row.shotId, row]));
const movingRows = planRows.filter((row) => row.family !== "static");
const resultRows = movingRows.map((row) => ({ ...row, measured: measuredById.get(row.shotId)?.measured }));
const invalidRows = resultRows.filter((row) => row.measured?.valid !== true);
// Affine estimates are supporting evidence only when the inlier population is large
// enough. Speech bubbles, thought dimming and character foregrounds legitimately make
// low-inlier optical flow report false scale/sign. The deterministic render plan remains
// the source of truth for exact direction and zero-zoom directional moves.
const trustedFlowRows = resultRows.filter((row) => row.measured?.valid === true
  && row.measured.inlierRatio >= 0.08);
const unexpectedPushRows = trustedFlowRows.filter((row) => row.measured?.valid === true
  && row.measured.zoomPercentPerSecond > 0.2);
// Long multi-utterance holds legitimately pan slower; the reference's own
// split/pan moments measure 0.7-1.9 %/s. 1.2 %/s still guarantees visible,
// continuous travel while allowing reference-style holds.
const weakDirectionalRows = resultRows.filter((row) => row.family === "directional"
  && (row.measured?.valid !== true
    || row.measured.meanAbsolutePixelDifference < 5
    || row.authoredTranslationPercentPerSecond < 1.2));
const directionalZoomLeakRows = trustedFlowRows.filter((row) => row.family === "directional"
  && row.measured?.valid === true && Math.abs(row.measured.zoomPercentPerSecond) > 0.35);
const weakPulloutRows = resultRows.filter((row) => row.family === "pullout"
  && (row.measured?.valid !== true || row.measured.zoomPercentPerSecond > -0.12));
const weakCombinedRows = resultRows.filter((row) => row.family === "combined"
  && (row.measured?.valid !== true
    || row.measured.zoomPercentPerSecond > -0.08
    || row.measured.translationPercentPerSecond < 0.2));
const wrongDirectionalSignRows = trustedFlowRows.filter((row) => {
  if (!row.direction || row.measured?.valid !== true) return false;
  if (row.direction === "left") return row.measured.translationXPercentPerSecond < 0.03;
  if (row.direction === "right") return row.measured.translationXPercentPerSecond > -0.03;
  return row.measured.translationYPercentPerSecond < 0.03;
});

const splitRows = resultRows.filter((row) => row.splitPage);
const splitPolicyPass = splitRows.every((row) => row.family === "combined")
  && (manifest.cuts || []).filter((cut) => cut.panelLayout?.enabled).every((cut) => (
    cut.panelLayout.motionPolicy === "whole-page"
    && cut.panelLayout.flattenBeforeCamera === true
    && cut.panelLayout.panelCamera === "static"
    && (cut.panelLayout.panels || []).every((panel) => panel.motion === "none")
  ));
const policyViolations = policyAudits.flatMap((audit) => audit.violations || []);
const familyCounts = planRows.reduce((counts, row) => {
  counts[row.family] = (counts[row.family] || 0) + 1;
  return counts;
}, {});
// The taught grammar requires all three moving families to coexist; exact
// per-family counts are an episode-plan choice (the v35 restoration proved
// specific counts, later plans may differ).
const familyDistributionPass = (familyCounts.directional || 0) >= 1
  && (familyCounts.pullout || 0) >= 1
  && (familyCounts.combined || 0) >= 1;

const gates = [
  { id: "semantic-camera-v2", pass: semanticViolations.length === 0, violations: semanticViolations.length },
  { id: "renderer-policy", pass: policyViolations.length === 0, violations: policyViolations.length },
  { id: "three-family-distribution", pass: familyDistributionPass, familyCounts },
  { id: "all-moving-shots-track", pass: invalidRows.length === 0, failures: invalidRows.map((row) => row.shotId) },
  { id: "trusted-optical-flow-sample-coverage", pass: trustedFlowRows.length >= 10, trustedSamples: trustedFlowRows.length },
  { id: "no-rendered-push-in", pass: unexpectedPushRows.length === 0, failures: unexpectedPushRows.map((row) => row.shotId) },
  { id: "directional-travel-visible", pass: weakDirectionalRows.length === 0, failures: weakDirectionalRows.map((row) => row.shotId) },
  { id: "directional-has-no-hidden-zoom", pass: directionalZoomLeakRows.length === 0, failures: directionalZoomLeakRows.map((row) => row.shotId) },
  { id: "directional-sign-matches-left-right-top", pass: wrongDirectionalSignRows.length === 0, failures: wrongDirectionalSignRows.map((row) => row.shotId) },
  { id: "pullout-visible", pass: weakPulloutRows.length === 0, failures: weakPulloutRows.map((row) => row.shotId) },
  { id: "combined-direction-and-pullout-visible", pass: weakCombinedRows.length === 0, failures: weakCombinedRows.map((row) => row.shotId) },
  { id: "split-pages-move-as-one-completed-page", pass: splitPolicyPass, splitPages: splitRows.map((row) => row.cutId) },
  { id: "full-video-decode", pass: true },
];

// Six examples, each shown at 10%, 50%, and 90% of its own interval. This proves
// left, right, top, pull-out, and both whole-page split combinations.
const proofIds = [
  "cut-01-v31-counter-macro-ren",
  "cut-03-v38-shared-ots-mio-entry",
  "cut-02-v38-shared-closeup",
  "cut-04-v31-mio-high-vulnerable",
  "cut-06-flattened-page",
  "cut-08-flattened-page",
];
const cutById = new Map((manifest.cuts || []).map((cut) => [cut.id, cut]));
const elapsedWithinCut = new Map();
const proofTimes = [];
for (const row of planRows) {
  const localStart = elapsedWithinCut.get(row.cutId) || 0;
  if (proofIds.includes(row.shotId)) {
    const absoluteStart = Number(cutById.get(row.cutId)?.timing?.startSeconds || 0) + localStart;
    for (const ratio of [0.1, 0.5, 0.9]) proofTimes.push(absoluteStart + row.durationSeconds * ratio);
  }
  elapsedWithinCut.set(row.cutId, localStart + row.durationSeconds);
}
if (proofTimes.length !== 18) throw new Error(`Expected 18 camera proof frames, got ${proofTimes.length}.`);
const selectedFrames = proofTimes.map((seconds) => `eq(n\\,${Math.round(seconds * 30)})`).join("+");
await execFile("ffmpeg", [
  "-y", "-v", "error", "-i", videoPath,
  "-vf", `select='${selectedFrames}',scale=480:270:flags=lanczos,tile=3x6:padding=6:margin=6:color=black`,
  "-frames:v", "1", contactSheetPath,
], { maxBuffer: 16 * 1024 * 1024 });

const audit = {
  version: "v35-rendered-camera-final-audit-r1",
  videoPath,
  manifestPath,
  planPath,
  motionAuditPath,
  contactSheetPath,
  recoveredFromTask: "019fd34d-602f-7a93-b28d-b784787a22e3",
  familyCounts,
  movingShotOrPageCount: movingRows.length,
  trustedOpticalFlowSampleCount: trustedFlowRows.length,
  splitPageCount: splitRows.length,
  semanticViolations,
  policyViolations,
  resultRows,
  gates,
  pass: gates.every((gate) => gate.pass),
  createdAt: new Date().toISOString(),
};
await writeJsonAtomic(finalAuditPath, audit);
console.log(JSON.stringify({
  finalAuditPath,
  contactSheetPath,
  familyCounts,
  gates,
  pass: audit.pass,
}, null, 2));
if (!audit.pass) process.exitCode = 1;
