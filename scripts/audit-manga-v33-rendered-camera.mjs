#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";
import {
  normalizeCameraShotSequence,
  normalizePanelLayout,
} from "../lib/mangaVideoPipeline.mjs";
import {
  auditMangaPanelPageCameraGrammar,
  auditMangaShotCameraGrammar,
} from "../lib/mangaPageCameraGrammar.mjs";

const execFile = promisify(execFileCallback);
const projectDir = resolve(process.argv[2] || process.cwd());
const manifestPath = resolve(
  process.argv[3]
    || join(projectDir, "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json"),
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const episodeDir = dirname(manifestPath);
const videoPath = resolve(
  process.argv[4]
    || manifest.outputs?.reviewVideo?.filePath
    || manifest.outputs?.finalVideo?.filePath
    || "",
);
if (!videoPath) throw new Error("Rendered video path is required.");

const utterancesByCut = new Map();
for (const utterance of manifest.utterances || []) {
  const rows = utterancesByCut.get(utterance.cutId) || [];
  rows.push(utterance);
  utterancesByCut.set(utterance.cutId, rows);
}

const planRows = [];
const semanticViolations = [];
const splitRows = [];
for (const cut of manifest.cuts || []) {
  const durationSeconds = Number(cut.timing?.durationSeconds || 0);
  const layout = normalizePanelLayout(cut.panelLayout, 1920, 1080, cut.imagePath);
  if (layout) {
    const violations = auditMangaPanelPageCameraGrammar(cut.panelLayout, cut.id);
    semanticViolations.push(...violations);
    const camera = layout.pageCamera;
    planRows.push({
      cutId: cut.id,
      shotId: `${cut.id}-whole-page`,
      angle: `${layout.pageViewpoint}->${layout.pageEndView}`,
      durationSeconds,
      motionClass: "whole-page-pull-out",
      authoredZoomPercentPerSecond: (camera.zoomEnd - camera.zoomStart) * 100 / durationSeconds,
      authoredTranslationPercentPerSecond: 0,
    });
    splitRows.push({
      cutId: cut.id,
      panelCount: layout.panels.length,
      panelCamera: layout.panelCamera,
      pageMotion: layout.pageMotion,
      pageViewpoint: layout.pageViewpoint,
      pageEndView: layout.pageEndView,
      pageZoomStart: camera.zoomStart,
      pageZoomEnd: camera.zoomEnd,
      panelMotionPass: layout.panelCamera === "static",
      wholePagePullOutPass: camera.zoomEnd < camera.zoomStart,
      semanticPass: violations.length === 0,
    });
    continue;
  }
  const shots = normalizeCameraShotSequence(
    cut,
    utterancesByCut.get(cut.id) || [],
    durationSeconds,
  );
  for (const shot of shots) {
    const violations = auditMangaShotCameraGrammar(shot);
    semanticViolations.push(...violations);
    const camera = shot.camera;
    planRows.push({
      cutId: cut.id,
      shotId: shot.id,
      angle: `${shot.viewpoint}->${shot.endView}`,
      durationSeconds: shot.durationSeconds,
      motionClass: shot.motion === "none" ? "static-graphic" : "view-preserving-pull-out",
      authoredZoomPercentPerSecond: (camera.zoomEnd - camera.zoomStart) * 100 / shot.durationSeconds,
      authoredTranslationPercentPerSecond: 0,
    });
  }
}

const planPath = join(episodeDir, "v33-rendered-camera-plan.json");
const motionAuditPath = join(episodeDir, "v33-rendered-camera-motion-audit.json");
const finalAuditPath = join(episodeDir, "v33-rendered-camera-final-audit.json");
await writeJsonAtomic(planPath, {
  version: "v33-rendered-camera-plan-r1",
  rows: planRows,
});

await execFile("python3", [
  join(projectDir, "scripts/analyze-manga-shot-motion.py"),
  "--video", videoPath,
  "--manifest", manifestPath,
  "--plan", planPath,
  "--output", motionAuditPath,
], { cwd: projectDir, maxBuffer: 32 * 1024 * 1024 });

const motionAudit = JSON.parse(await readFile(motionAuditPath, "utf8"));
const motionRows = motionAudit.rows || [];
const movingRows = motionRows.filter((row) => row.motionClass !== "static-graphic");
const invalidMovingRows = movingRows.filter((row) => row.measured?.valid !== true);
const wrongDirectionRows = movingRows.filter((row) => (
  row.measured?.valid === true && row.measured.zoomPercentPerSecond >= -0.015
));
const staticGraphicRows = motionRows.filter((row) => row.motionClass === "static-graphic");
const splitMotionRows = motionRows.filter((row) => row.motionClass === "whole-page-pull-out");
const splitMeasuredPass = splitMotionRows.every((row) => (
  row.measured?.valid === true && row.measured.zoomPercentPerSecond < -0.015
));
const splitPolicyPass = splitRows.every((row) => (
  row.panelMotionPass && row.wholePagePullOutPass && row.semanticPass
));
const gates = [
  { id: "semantic-camera-grammar", pass: semanticViolations.length === 0, violationCount: semanticViolations.length },
  { id: "moving-shots-decode-and-track", pass: invalidMovingRows.length === 0, failureCount: invalidMovingRows.length },
  { id: "moving-shots-are-pull-outs", pass: wrongDirectionRows.length === 0, failureCount: wrongDirectionRows.length },
  { id: "split-panels-are-static", pass: splitPolicyPass, splitPageCount: splitRows.length },
  { id: "split-page-is-measured-pull-out", pass: splitMeasuredPass, splitPageCount: splitMotionRows.length },
];
const audit = {
  version: "v33-rendered-camera-final-audit-r1",
  videoPath,
  manifestPath,
  planPath,
  motionAuditPath,
  shotCount: motionRows.length,
  movingShotCount: movingRows.length,
  staticGraphicShotCount: staticGraphicRows.length,
  splitPages: splitRows,
  semanticViolations,
  invalidMovingRows: invalidMovingRows.map((row) => row.shotId),
  wrongDirectionRows: wrongDirectionRows.map((row) => ({
    shotId: row.shotId,
    measuredZoomPercentPerSecond: row.measured.zoomPercentPerSecond,
  })),
  gates,
  pass: gates.every((gate) => gate.pass),
  createdAt: new Date().toISOString(),
};
await writeJsonAtomic(finalAuditPath, audit);
process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
if (!audit.pass) process.exitCode = 1;
