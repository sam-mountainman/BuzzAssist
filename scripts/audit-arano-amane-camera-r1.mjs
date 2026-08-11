#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";

const execFile = promisify(execFileCallback);
const projectDir = resolve(process.argv[2] || process.cwd());
const manifestPath = resolve(process.argv[3] || join(
  projectDir, "canvas/manga-videos/manga-arano-amane-reversal-001/episode-manifest.json",
));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const episodeDir = dirname(manifestPath);
const videoPath = resolve(process.argv[4] || manifest.outputs?.reviewVideo?.filePath || "");
if (!videoPath) throw new Error("Rendered video path is required.");
const authoredPath = join(episodeDir, "camera-plan-r1.json");
const authored = JSON.parse(await readFile(authoredPath, "utf8"));
const planPath = join(episodeDir, "audits/rendered-camera-plan-r1.json");
const motionPath = join(episodeDir, "audits/rendered-camera-motion-r1.json");
const outputPath = join(episodeDir, "audits/rendered-camera-audit-r1.json");
const cuts = new Map(manifest.cuts.map((cut) => [cut.id, cut]));

const cameraDelta = (camera) => {
  const frames = Array.isArray(camera?.keyframes) && camera.keyframes.length >= 2
    ? camera.keyframes
    : [
        { zoom: camera?.zoomStart, focusX: camera?.focusX, focusY: camera?.focusY },
        { zoom: camera?.zoomEnd, focusX: camera?.focusXEnd, focusY: camera?.focusYEnd },
      ];
  const first = frames[0];
  const last = frames.at(-1);
  return {
    zoom: Number(last.zoom) - Number(first.zoom),
    x: Number(last.focusX) - Number(first.focusX),
    y: Number(last.focusY) - Number(first.focusY),
  };
};
const familyFor = (mode) => {
  if (mode.endsWith("-then-pullout")) return "combined";
  if (mode === "pullout-only") return "pullout";
  return "directional";
};
const rows = authored.shots.map((shot) => {
  const cut = cuts.get(shot.cutId);
  const durationSeconds = Number(cut?.timing?.durationSeconds || 0);
  const delta = cameraDelta(shot.camera);
  return {
    cutId: shot.cutId,
    shotId: `${shot.cutId}-full-cut`,
    mode: shot.cameraMode,
    family: familyFor(shot.cameraMode),
    splitPage: shot.splitPage === true,
    durationSeconds,
    directionPhase: Number(shot.camera?.directionPhase) || undefined,
    authoredZoomPercentPerSecond: delta.zoom * 100 / Math.max(0.001, durationSeconds),
    authoredTranslationPercentPerSecond: Math.hypot(delta.x, delta.y) * 100 / Math.max(0.001, durationSeconds),
  };
});
await writeJsonAtomic(planPath, { version: "arano-amane-rendered-camera-plan-r1", videoPath, rows });
await execFile("python3", [
  join(projectDir, "scripts/analyze-manga-shot-motion.py"),
  "--video", videoPath,
  "--manifest", manifestPath,
  "--plan", planPath,
  "--output", motionPath,
], { cwd: projectDir, maxBuffer: 64 * 1024 * 1024 });
await execFile("ffmpeg", ["-v", "error", "-xerror", "-i", videoPath, "-f", "null", "-"], {
  maxBuffer: 32 * 1024 * 1024,
});

const motion = JSON.parse(await readFile(motionPath, "utf8"));
const measuredById = new Map((motion.rows || []).map((row) => [row.shotId, row.measured]));
const resultRows = rows.map((row) => ({ ...row, measured: measuredById.get(row.shotId) }));
const validRows = resultRows.filter((row) => row.measured?.valid === true);
const trustedRows = validRows.filter((row) => Number(row.measured.inlierRatio) >= 0.06);
const weakMotion = validRows.filter((row) => Number(row.measured.meanAbsolutePixelDifference) < 3.0);
const pushIns = trustedRows.filter((row) => Number(row.measured.zoomPercentPerSecond) > 0.25);
const pulloutFailures = trustedRows.filter((row) => (
  (row.family === "pullout" || row.family === "combined")
  && Number(row.measured.zoomPercentPerSecond) > -0.045
));
const directionalFailures = validRows.filter((row) => (
  (row.family === "directional" || row.family === "combined")
  && Number(row.measured.translationPercentPerSecond) < 0.07
));
const splitCuts = manifest.cuts.filter((cut) => cut.flattenedSplitPage?.enabled === true);
const splitPolicyFailures = splitCuts.filter((cut) => !(
  cut.flattenedSplitPage.flattenBeforeCamera === true
  && cut.flattenedSplitPage.panelCamera === "static"
  && cut.flattenedSplitPage.motionPolicy === "whole-page"
  && Number(cut.flattenedSplitPage.panelCount) >= 2
));
const familyCounts = rows.reduce((counts, row) => {
  counts[row.family] = (counts[row.family] || 0) + 1;
  return counts;
}, {});
const gates = [
  { id: "all-21-cuts-planned", pass: rows.length === 21, count: rows.length },
  { id: "all-cuts-rendered-motion-detected", pass: validRows.length === rows.length, valid: validRows.length },
  { id: "rendered-motion-visible", pass: weakMotion.length === 0, failures: weakMotion.map((row) => row.cutId) },
  { id: "no-rendered-push-in", pass: pushIns.length === 0, failures: pushIns.map((row) => row.cutId) },
  { id: "pullouts-render-as-pullouts", pass: pulloutFailures.length === 0, failures: pulloutFailures.map((row) => row.cutId) },
  { id: "directional-travel-visible", pass: directionalFailures.length === 0, failures: directionalFailures.map((row) => row.cutId) },
  {
    id: "three-camera-families-present",
    pass: (familyCounts.directional || 0) > 0 && (familyCounts.pullout || 0) > 0 && (familyCounts.combined || 0) > 0,
    familyCounts,
  },
  {
    id: "flattened-split-pages-keep-static-panels",
    pass: splitCuts.length === 4 && splitPolicyFailures.length === 0,
    splitCuts: splitCuts.map((cut) => cut.id),
    failures: splitPolicyFailures.map((cut) => cut.id),
  },
  { id: "full-video-decode", pass: true },
];
const audit = {
  version: "arano-amane-rendered-camera-audit-r1",
  videoPath,
  manifestPath,
  authoredPath,
  planPath,
  motionPath,
  shotCount: rows.length,
  validMotionCount: validRows.length,
  trustedOpticalFlowCount: trustedRows.length,
  familyCounts,
  rows: resultRows,
  gates,
  pass: gates.every((gate) => gate.pass),
  knownRemainingIssues: [],
  createdAt: new Date().toISOString(),
};
await writeJsonAtomic(outputPath, audit);
process.stdout.write(`${JSON.stringify({ outputPath, gates, pass: audit.pass }, null, 2)}\n`);
if (!audit.pass) process.exitCode = 1;
