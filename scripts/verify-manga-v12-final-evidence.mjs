#!/usr/bin/env node

import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas", "manga-videos", "manga-photo-homecoming-001");
const paths = {
  manifest: join(episodeDir, "episode-manifest.json"),
  camera: join(episodeDir, "v12-camera-plan-audit.json"),
  bubbles: join(episodeDir, "v12-bubble-layout-audit.json"),
  quality: join(episodeDir, "v12-final-r1-quality-report.json"),
  analysis: join(episodeDir, "v12-final-analysis", "reference-video-measurements.json"),
  speech: join(episodeDir, "speech-audit-v11-final-r2.json"),
  dialogue: join(episodeDir, "v10-dialogue-editorial-audit.json"),
  output: join(episodeDir, "v12-final-evidence.json"),
};

const readJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));
const [manifest, camera, bubbles, quality, analysis, speech, dialogue] = await Promise.all([
  readJson(paths.manifest),
  readJson(paths.camera),
  readJson(paths.bubbles),
  readJson(paths.quality),
  readJson(paths.analysis),
  readJson(paths.speech),
  readJson(paths.dialogue),
]);

const videoPath = resolve(manifest.outputs?.reviewVideo?.filePath || "");
let videoExists = true;
try {
  await access(videoPath);
} catch {
  videoExists = false;
}

const requiredAngles = ["left", "right", "top", "wide", "left-wide", "right-wide", "top-wide"];
const missingAngles = requiredAngles.filter((angle) => !camera.angleCounts?.[angle]);
const motionMedian = analysis.cameraMotion?.zoomPercentPerSecond?.median;
const wideRows = (camera.rows || []).filter((row) => row.isSpatialWideShot);
const thoughtFocusDisabled = (manifest.cuts || []).every((cut) => !cut.thoughtFocus?.enabled);

const checks = [
  { id: "final-video-exists", pass: videoExists, value: videoPath },
  { id: "manifest-final-status", pass: manifest.status === "final-review-candidate-v12-r1", value: manifest.status },
  { id: "quality-report-pass", pass: quality.pass === true, value: quality.pass },
  { id: "format-pass", pass: quality.gates?.format === true, value: quality.gates?.format },
  { id: "resolution-pass", pass: quality.gates?.resolution === true, value: quality.media?.video },
  { id: "duration-pass", pass: quality.gates?.duration === true, value: quality.media?.durationDeltaSeconds },
  { id: "audio-coverage-pass", pass: quality.gates?.cutAudioCoverage === true, value: quality.cuts?.length },
  { id: "long-silence-pass", pass: quality.gates?.longSilence === true, value: quality.silence?.longSilences?.length },
  { id: "loudness-pass", pass: quality.gates?.integratedLoudness === true, value: quality.loudness },
  { id: "true-peak-pass", pass: quality.gates?.truePeak === true, value: quality.loudness?.truePeakDbfs },
  { id: "all-camera-angles-used", pass: missingAngles.length === 0, value: { requiredAngles, missingAngles, angleCounts: camera.angleCounts } },
  { id: "dedicated-spatial-wide-assets", pass: wideRows.length === camera.wideShotCount && wideRows.every((row) => row.imagePath && !row.digitalZoomOutUsed), value: wideRows.length },
  { id: "no-digital-zoom-out", pass: camera.digitalZoomOutCount === 0, value: camera.digitalZoomOutCount },
  { id: "reference-wide-ratio", pass: Math.abs(camera.wideShotRatio - 0.325) <= 0.05, value: { reference: 0.325, v12: camera.wideShotRatio } },
  { id: "reference-range-camera-motion", pass: Number.isFinite(motionMedian) && motionMedian > 0 && motionMedian <= 1.7509, value: { referenceMedian: 0.3121, referenceP90: 1.7509, v12Median: motionMedian } },
  { id: "bubble-count", pass: bubbles.overlayCount === 29, value: bubbles.overlayCount },
  { id: "active-face-overlap-zero", pass: bubbles.zeroFaceOverlapCount === 29, value: bubbles.zeroFaceOverlapCount },
  { id: "important-overlap-zero", pass: bubbles.zeroImportantOverlapCount === 29, value: bubbles.zeroImportantOverlapCount },
  { id: "dialogue-source-exact", pass: dialogue.sourceExactCount === 29 && dialogue.finalFullStopPreservedCount === 29, value: { sourceExactCount: dialogue.sourceExactCount, finalFullStopPreservedCount: dialogue.finalFullStopPreservedCount } },
  { id: "speech-reading-pass", pass: speech.passedCount === 29 && speech.flaggedCount === 0, value: { passedCount: speech.passedCount, flaggedCount: speech.flaggedCount } },
  { id: "no-artificial-darkening", pass: manifest.production?.bubblePolicy?.artificialBackgroundDarkening === false && thoughtFocusDisabled, value: { artificialBackgroundDarkening: manifest.production?.bubblePolicy?.artificialBackgroundDarkening, thoughtFocusDisabled } },
];

const passCount = checks.filter((check) => check.pass).length;
const report = {
  version: "v12-final-evidence",
  episodeId: manifest.id,
  videoPath,
  referenceSources: manifest.production?.referenceCameraAudit?.sources || [],
  generatedAt: new Date().toISOString(),
  pass: passCount === checks.length,
  summary: { passCount, totalCount: checks.length, failedCount: checks.length - passCount },
  checks,
  artifacts: paths,
};

await writeFile(paths.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputPath: paths.output, ...report.summary, pass: report.pass }, null, 2)}\n`);
if (!report.pass) process.exitCode = 2;
