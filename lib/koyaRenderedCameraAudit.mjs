import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { writeJsonAtomic } from "./canvasScene.mjs";
import {
  mangaCameraModeFamily,
  normalizeMangaCameraMode,
} from "./mangaPageCameraGrammar.mjs";
import { normalizeCameraShotSequence } from "./mangaVideoPipeline.mjs";

const execFile = promisify(execFileCallback);

function cameraDelta(camera = {}) {
  const keyframes = Array.isArray(camera.keyframes) && camera.keyframes.length >= 2
    ? camera.keyframes
    : [
        { zoom: camera.zoomStart, focusX: camera.focusX, focusY: camera.focusY },
        { zoom: camera.zoomEnd, focusX: camera.focusXEnd, focusY: camera.focusYEnd },
      ];
  const first = keyframes[0] || {};
  const last = keyframes.at(-1) || {};
  return {
    zoom: Number(last.zoom || 0) - Number(first.zoom || 0),
    x: Number(last.focusX || 0) - Number(first.focusX || 0),
    y: Number(last.focusY || 0) - Number(first.focusY || 0),
  };
}

function cameraEndpoints(camera = {}) {
  const keyframes = Array.isArray(camera.keyframes) && camera.keyframes.length >= 2
    ? camera.keyframes
    : [
        { zoom: camera.zoomStart, focusX: camera.focusX, focusY: camera.focusY },
        { zoom: camera.zoomEnd, focusX: camera.focusXEnd, focusY: camera.focusYEnd },
      ];
  const first = keyframes[0] || {};
  const last = keyframes.at(-1) || {};
  return {
    start: { zoom: Number(first.zoom), focusX: Number(first.focusX), focusY: Number(first.focusY) },
    end: { zoom: Number(last.zoom), focusX: Number(last.focusX), focusY: Number(last.focusY) },
  };
}

function sameCameraPoint(left, right, epsilon = 1e-6) {
  return ["zoom", "focusX", "focusY"].every((key) => Math.abs(Number(left?.[key]) - Number(right?.[key])) <= epsilon);
}

function combinedHasNoPhaseReset(camera = {}) {
  const keyframes = camera.keyframes || [];
  if (keyframes.length !== 3) return false;
  return Number(keyframes[1].focusX) === Number(keyframes[2].focusX)
    && Number(keyframes[1].focusY) === Number(keyframes[2].focusY)
    && Number(keyframes[0].zoom) === Number(keyframes[1].zoom)
    && Number(keyframes[2].zoom) < Number(keyframes[1].zoom);
}

export function createKoyaRenderedCameraPlan(manifest = {}) {
  const utterances = Array.isArray(manifest.utterances) ? manifest.utterances : [];
  const utterancesByCut = new Map();
  for (const utterance of utterances) {
    if (!utterancesByCut.has(utterance.cutId)) utterancesByCut.set(utterance.cutId, []);
    utterancesByCut.get(utterance.cutId).push(utterance);
  }
  const rows = [];
  const staticRows = [];
  for (const cut of manifest.cuts || []) {
    if (cut.panelLayout?.enabled) {
      const layout = cut.panelLayout;
      const mode = normalizeMangaCameraMode(layout.pageCameraMode || layout.pageMotion, "pullout-only");
      const family = mangaCameraModeFamily(mode);
      const durationSeconds = Number(cut.timing?.durationSeconds || 0);
      const delta = cameraDelta(layout.pageCamera);
      rows.push({
        cutId: cut.id,
        shotId: `${cut.id}-flattened-page`,
        imagePath: cut.flattenedSplitPage?.sourcePagePath || cut.imagePath,
        angle: `${layout.pageViewpoint || "wide"}->${layout.pageEndView || "wide"}`,
        mode,
        family,
        durationSeconds,
        startSecondsInCut: 0,
        directionPhase: Number(layout.pageCamera?.directionPhase) || undefined,
        authoredZoomPercentPerSecond: delta.zoom * 100 / Math.max(0.001, durationSeconds),
        authoredTranslationPercentPerSecond: Math.hypot(delta.x, delta.y) * 100 / Math.max(0.001, durationSeconds),
        flattenedSplitPage: cut.flattenedSplitPage || {
          enabled: true, flattenBeforeCamera: layout.flattenBeforeCamera,
          panelCamera: layout.panelCamera, motionPolicy: layout.motionPolicy,
        },
        editorialPlate: null,
        combinedPhaseContinuous: family !== "combined" || combinedHasNoPhaseReset(layout.pageCamera),
      });
      for (const [index, panel] of (layout.panels || []).entries()) {
        staticRows.push({ cutId: cut.id, shotId: `${cut.id}-panel-${index + 1}`, family: "static", imagePath: panel.imagePath });
      }
      continue;
    }
    const rawById = new Map((cut.cameraSequence || []).map((shot) => [shot.id, shot]));
    const sequence = normalizeCameraShotSequence(
      cut,
      utterancesByCut.get(cut.id) || [],
      Number(cut.timing?.durationSeconds || 0),
    );
    for (const shot of sequence) {
      const raw = rawById.get(shot.id) || {};
      const mode = normalizeMangaCameraMode(raw.cameraMode || shot.motion || raw.motion, "pullout-only");
      const family = mangaCameraModeFamily(mode);
      const delta = cameraDelta(shot.camera);
      const row = {
        cutId: cut.id,
        shotId: shot.id,
        imagePath: shot.imagePath,
        angle: `${shot.viewpoint || raw.viewpoint || "wide"}->${shot.endView || raw.endView || "wide"}`,
        mode,
        family,
        durationSeconds: shot.durationSeconds,
        startSecondsInCut: shot.startSeconds,
        directionPhase: Number(shot.camera?.directionPhase) || undefined,
        authoredZoomPercentPerSecond: delta.zoom * 100 / Math.max(0.001, shot.durationSeconds),
        authoredTranslationPercentPerSecond: Math.hypot(delta.x, delta.y) * 100 / Math.max(0.001, shot.durationSeconds),
        flattenedSplitPage: raw.flattenedSplitPage || null,
        editorialPlate: raw.editorialPlate || shot.editorialPlate || null,
        combinedPhaseContinuous: family !== "combined" || combinedHasNoPhaseReset(shot.camera),
        authoredCamera: cameraEndpoints(shot.camera),
      };
      if (family === "static") staticRows.push(row);
      else rows.push(row);
    }
  }
  return { version: "koya-rendered-camera-plan-v1", rows, staticRows };
}

export function evaluateKoyaRenderedCamera({ manifest, plan, motion, fullDecodePass = true }) {
  const measuredById = new Map((motion?.rows || []).map((row) => [row.shotId, row.measured]));
  const rows = plan.rows.map((row) => ({ ...row, measured: measuredById.get(row.shotId) }));
  const valid = rows.filter((row) => row.measured?.valid === true);
  const trusted = valid.filter((row) => Number(row.measured.inlierRatio) >= 0.06);
  const weak = valid.filter((row) => Number(row.measured.meanAbsolutePixelDifference) < 3);
  const pushIns = trusted.filter((row) => Number(row.measured.zoomPercentPerSecond) > 0.25);
  const pulloutFailures = trusted.filter((row) => (
    ["pullout", "combined"].includes(row.family)
    && Number(row.measured.zoomPercentPerSecond) > -0.045
  ));
  const directionalFailures = valid.filter((row) => (
    ["directional", "combined"].includes(row.family)
    && Number(row.measured.translationPercentPerSecond) < 0.07
  ));
  const splitRows = [...plan.rows, ...plan.staticRows].filter((row) => row.flattenedSplitPage?.enabled === true);
  const splitFailures = splitRows.filter((row) => !(
    row.flattenedSplitPage.flattenBeforeCamera === true
    && row.flattenedSplitPage.panelCamera === "static"
    && row.flattenedSplitPage.motionPolicy === "whole-page"
  ));
  const familyCounts = plan.rows.reduce((counts, row) => {
    counts[row.family] = (counts[row.family] || 0) + 1;
    return counts;
  }, {});
  const repeatedImageGroups = [...new Map(plan.rows.map((row) => [
    row.imagePath,
    plan.rows.filter((candidate) => candidate.imagePath === row.imagePath),
  ])).entries()].filter(([, group]) => group.length > 1);
  const repeatedImages = repeatedImageGroups.filter(([, group]) => group.some((row, index) => {
    if (index === 0) return false;
    const previous = group[index - 1];
    const previousIndex = plan.rows.findIndex((candidate) => candidate.shotId === previous.shotId);
    const currentIndex = plan.rows.findIndex((candidate) => candidate.shotId === row.shotId);
    return row.cutId !== previous.cutId
      || currentIndex !== previousIndex + 1
      || !sameCameraPoint(previous.authoredCamera?.end, row.authoredCamera?.start);
  })).map(([imagePath, group]) => [imagePath, group.map((row) => row.shotId)]);
  const phaseResets = plan.rows.filter((row) => row.combinedPhaseContinuous === false);
  const failures = (source) => source.map((row) => row.shotId);
  const gates = [
    { id: "moving-shots-exist", pass: rows.length > 0, count: rows.length },
    { id: "all-moving-shots-measured", pass: valid.length === rows.length, valid: valid.length, planned: rows.length },
    { id: "rendered-motion-visible", pass: weak.length === 0, failures: failures(weak) },
    { id: "no-rendered-push-in", pass: pushIns.length === 0, failures: failures(pushIns) },
    { id: "pullouts-render-as-pullouts", pass: pulloutFailures.length === 0, failures: failures(pulloutFailures) },
    { id: "directional-travel-visible", pass: directionalFailures.length === 0, failures: failures(directionalFailures) },
    {
      id: "three-camera-families-present",
      pass: ["directional", "pullout", "combined"].every((family) => (familyCounts[family] || 0) > 0),
      familyCounts,
    },
    { id: "no-repeated-camera-images", pass: repeatedImages.length === 0, failures: repeatedImages },
    { id: "combined-phase-continuity", pass: phaseResets.length === 0, failures: failures(phaseResets) },
    { id: "flattened-split-pages-use-whole-page-camera", pass: splitFailures.length === 0, checked: splitRows.length, failures: failures(splitFailures) },
    { id: "full-video-decode", pass: fullDecodePass },
  ];
  return {
    version: "koya-rendered-camera-audit-v1",
    familyCounts,
    rows,
    staticRows: plan.staticRows,
    gates,
    pass: gates.every((gate) => gate.pass),
    knownRemainingIssues: gates.filter((gate) => !gate.pass).map((gate) => ({ id: gate.id, detail: gate })),
  };
}

export async function auditKoyaRenderedCamera(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  const manifestPath = resolve(options.manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const videoPath = resolve(options.videoPath || manifest.outputs?.reviewVideo?.filePath || manifest.outputs?.finalVideo?.filePath || "");
  if (!videoPath) throw new Error("Rendered video path is required.");
  const outputDir = resolve(options.outputDir || join(dirname(manifestPath), "audits/koya-rendered-camera"));
  await mkdir(outputDir, { recursive: true });
  const planPath = join(outputDir, "plan.json");
  const motionPath = join(outputDir, "motion.json");
  const outputPath = join(outputDir, "audit.json");
  const plan = { ...createKoyaRenderedCameraPlan(manifest), videoPath, manifestPath };
  await writeJsonAtomic(planPath, plan);
  if (options.dryRun) return { planPath, motionPath, outputPath, plan, dryRun: true };
  await execFile("python3", [
    join(projectDir, "scripts/analyze-manga-shot-motion.py"),
    "--video", videoPath,
    "--manifest", manifestPath,
    "--plan", planPath,
    "--output", motionPath,
  ], { cwd: projectDir, maxBuffer: 64 * 1024 * 1024 });
  let fullDecodePass = true;
  try {
    await execFile("ffmpeg", ["-v", "error", "-xerror", "-i", videoPath, "-f", "null", "-"], {
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    fullDecodePass = false;
  }
  const motion = JSON.parse(await readFile(motionPath, "utf8"));
  const audit = {
    ...evaluateKoyaRenderedCamera({ manifest, plan, motion, fullDecodePass }),
    videoPath,
    manifestPath,
    planPath,
    motionPath,
    createdAt: new Date().toISOString(),
  };
  await writeJsonAtomic(outputPath, audit);
  return { outputPath, audit, planPath, motionPath };
}
