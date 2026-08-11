#!/usr/bin/env node

import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas", "manga-videos", "manga-photo-homecoming-001");
const paths = {
  manifest: join(episodeDir, "episode-manifest.json"),
  cameraPlan: join(episodeDir, "v13-camera-motion-plan.json"),
  cameraEvidence: join(episodeDir, "v13-camera-motion-evidence.json"),
  quality: join(episodeDir, "v13-final-r1-quality-report.json"),
  bubbles: join(episodeDir, "v12-bubble-layout-audit.json"),
  dialogue: join(episodeDir, "v10-dialogue-editorial-audit.json"),
  output: join(episodeDir, "v13-final-evidence.json"),
};

const readJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));
const [manifest, cameraPlan, cameraEvidence, quality, bubbles, dialogue] = await Promise.all([
  readJson(paths.manifest),
  readJson(paths.cameraPlan),
  readJson(paths.cameraEvidence),
  readJson(paths.quality),
  readJson(paths.bubbles),
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
const missingAngles = requiredAngles.filter((angle) => !cameraPlan.angleCounts?.[angle]);
const thoughtFocusDisabled = (manifest.cuts || []).every((cut) => !cut.thoughtFocus?.enabled);
const checks = [
  { id: "final-video-exists", pass: videoExists, value: videoPath },
  { id: "v13-file-name", pass: videoPath.endsWith("manga-photo-homecoming-001-v13-final-r1.mp4"), value: videoPath },
  { id: "quality-report-pass", pass: quality.pass === true, value: quality.gates },
  { id: "format-resolution-duration-pass", pass: quality.gates?.format && quality.gates?.resolution && quality.gates?.duration, value: quality.media },
  { id: "audio-quality-pass", pass: quality.gates?.cutAudioCoverage && quality.gates?.longSilence && quality.gates?.integratedLoudness && quality.gates?.truePeak, value: quality.loudness },
  { id: "all-required-angles", pass: missingAngles.length === 0, value: { requiredAngles, missingAngles, angleCounts: cameraPlan.angleCounts } },
  { id: "all-shots-authored-pull-out", pass: cameraPlan.shotCount === 25 && cameraPlan.animatedPullOutCount === 25, value: cameraPlan.animatedPullOutCount },
  { id: "all-rendered-shots-measured-pull-out", pass: cameraEvidence.pass && cameraEvidence.passCount === 25, value: { passCount: cameraEvidence.passCount, failedCount: cameraEvidence.failedCount } },
  { id: "visible-rendered-motion", pass: cameraEvidence.renderedMeasuredPullPercent?.minimumMagnitude >= 3, value: cameraEvidence.renderedMeasuredPullPercent },
  { id: "dedicated-spatial-wide-sources", pass: cameraPlan.spatialWideSourceCount === 9, value: cameraPlan.spatialWideSourceCount },
  { id: "bubble-count-preserved", pass: bubbles.overlayCount === 29, value: bubbles.overlayCount },
  { id: "bubble-base-layout-face-safe", pass: bubbles.zeroFaceOverlapCount === 29 && bubbles.zeroImportantOverlapCount === 29, value: { faceSafe: bubbles.zeroFaceOverlapCount, importantSafe: bubbles.zeroImportantOverlapCount } },
  { id: "dialogue-source-preserved", pass: dialogue.sourceExactCount === 29 && dialogue.finalFullStopPreservedCount === 29, value: { sourceExactCount: dialogue.sourceExactCount, finalFullStopPreservedCount: dialogue.finalFullStopPreservedCount } },
  { id: "no-artificial-darkening", pass: manifest.production?.bubblePolicy?.artificialBackgroundDarkening === false && thoughtFocusDisabled, value: { artificialBackgroundDarkening: manifest.production?.bubblePolicy?.artificialBackgroundDarkening, thoughtFocusDisabled } },
  { id: "oss-camera-stack-recorded", pass: ["FFmpeg", "OpenCV", "NumPy"].every((name) => manifest.production?.ossStack?.some((entry) => entry.name === name)), value: manifest.production?.ossStack },
];

const passCount = checks.filter((check) => check.pass).length;
const report = {
  version: "v13-final-camera-evidence",
  episodeId: manifest.id,
  videoPath,
  generatedAt: new Date().toISOString(),
  pass: passCount === checks.length,
  summary: { passCount, totalCount: checks.length, failedCount: checks.length - passCount },
  checks,
  artifacts: paths,
};
if (!report.pass) {
  await writeFile(paths.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stderr.write(`${JSON.stringify(report.summary, null, 2)}\n`);
  process.exit(2);
}

manifest.status = "final-review-candidate-v13-r1";
manifest.production = {
  ...(manifest.production || {}),
  version: "v13-animated-reference-camera-final-r1",
  finalEvidencePath: paths.output,
};
manifest.updatedAt = new Date().toISOString();
await writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await writeFile(paths.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");

process.stdout.write(`${JSON.stringify({ outputPath: paths.output, ...report.summary, pass: report.pass, status: manifest.status }, null, 2)}\n`);
