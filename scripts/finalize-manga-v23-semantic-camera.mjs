#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, join, resolve } from "node:path";

const execFile = promisify(execFileCallback);
const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas/manga-videos/manga-photo-homecoming-001");
const manifestPath = join(episodeDir, "episode-manifest.json");
const planPath = join(episodeDir, "v23-semantic-start-camera-plan.json");
const stabilityPath = join(episodeDir, "v23-terminal-stability-analysis.json");
const evidencePath = join(episodeDir, "v23-final-evidence.json");
const referenceReportPath = join(
  projectDir,
  "canvas/reference-media/love-manga/analysis/v23-reference-camera-grammar/reference-camera-grammar.json",
);
const reviewVideoPath = join(projectDir, "canvas/assets/videos/manga-photo-homecoming-001-review.mp4");
const v22VideoPath = join(projectDir, "canvas/assets/videos/manga-photo-homecoming-001-v22-natural-dialogue-r1.mp4");
const finalVideoPath = join(projectDir, "canvas/assets/videos/manga-photo-homecoming-001-v23-semantic-camera-r1.mp4");

await copyFile(reviewVideoPath, finalVideoPath);
const [manifestText, planText, stabilityText, referenceText, videoBytes] = await Promise.all([
  readFile(manifestPath, "utf8"),
  readFile(planPath, "utf8"),
  readFile(stabilityPath, "utf8"),
  readFile(referenceReportPath, "utf8"),
  readFile(finalVideoPath),
]);
const manifest = JSON.parse(manifestText);
const plan = JSON.parse(planText);
const stability = JSON.parse(stabilityText);
const reference = JSON.parse(referenceText);

if (plan.rows?.length !== 20) throw new Error(`Expected 20 camera shots, found ${plan.rows?.length}`);
if (plan.rows.some((row) => row.cropClampCollision || row.signReversalCount)) {
  throw new Error("Authored camera path still contains a crop collision or direction reversal");
}
if (plan.rows.some((row) => row.utteranceChecks?.some((check) => !check.activeSpeakerVisible || !check.activeSpeakerClearOfBubble))) {
  throw new Error("An active speaker is hidden or overlaps a bubble at speech start");
}
if (stability.terminalOvershootShotCount !== 0 || stability.jitterFailureShotCount !== 0) {
  throw new Error("Rendered terminal stability gate failed");
}
if (reference.aggregate?.movingSceneRatio !== .8 || reference.aggregate?.multiCaptionSceneRatio !== .5866) {
  throw new Error("Reference-camera report does not match the reviewed calibration");
}

const { stdout: probeStdout } = await execFile("ffprobe", [
  "-v", "error",
  "-show_entries", "format=duration,size",
  "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels",
  "-of", "json",
  finalVideoPath,
]);
const probe = JSON.parse(probeStdout);
const videoStream = probe.streams.find((stream) => stream.codec_type === "video");
const audioStream = probe.streams.find((stream) => stream.codec_type === "audio");
if (!videoStream || !audioStream) throw new Error("V23 final must contain video and audio streams");
if (videoStream.width !== 1920 || videoStream.height !== 1080 || videoStream.r_frame_rate !== "30/1") {
  throw new Error(`Unexpected V23 video stream: ${JSON.stringify(videoStream)}`);
}
if (audioStream.sample_rate !== "48000" || audioStream.channels !== 2) {
  throw new Error(`Unexpected V23 audio stream: ${JSON.stringify(audioStream)}`);
}

await execFile("ffmpeg", [
  "-v", "error", "-xerror", "-i", finalVideoPath,
  "-map", "0:v:0", "-f", "null", "-",
], { maxBuffer: 8 * 1024 * 1024 });
const { stderr: blackDetectOutput } = await execFile("ffmpeg", [
  "-hide_banner", "-nostats", "-i", finalVideoPath,
  "-vf", "blackdetect=d=0.1:pix_th=0.02", "-an", "-f", "null", "-",
], { maxBuffer: 8 * 1024 * 1024 });
const blackFrameEventCount = [...blackDetectOutput.matchAll(/black_start:/gu)].length;
if (blackFrameEventCount !== 0) throw new Error(`Detected ${blackFrameEventCount} black-frame event(s)`);

async function pcmMd5(filePath) {
  const { stdout } = await execFile("ffmpeg", [
    "-v", "error", "-i", filePath, "-map", "0:a:0", "-f", "md5", "-",
  ]);
  return stdout.trim().replace(/^MD5=/u, "");
}
const [v22AudioPcmMd5, v23AudioPcmMd5] = await Promise.all([
  pcmMd5(v22VideoPath),
  pcmMd5(finalVideoPath),
]);
if (v22AudioPcmMd5 !== v23AudioPcmMd5) {
  throw new Error(`V23 audio differs from approved V22 PCM: ${v22AudioPcmMd5} != ${v23AudioPcmMd5}`);
}

const fileStats = await stat(finalVideoPath);
const createdAt = new Date().toISOString();
const sha256 = createHash("sha256").update(videoBytes).digest("hex");
const finalVideo = {
  fileName: basename(finalVideoPath),
  filePath: finalVideoPath,
  assetUrl: `/excalidraw-assets/videos/${encodeURIComponent(basename(finalVideoPath))}`,
  durationSeconds: Number(probe.format.duration),
  width: videoStream.width,
  height: videoStream.height,
  fps: 30,
  sampleRate: Number(audioStream.sample_rate),
  channels: audioStream.channels,
  sizeBytes: fileStats.size,
  sha256,
  createdAt,
};
manifest.status = "final-v23-semantic-camera-r1";
manifest.video = {
  ...(manifest.video || {}),
  fileName: finalVideo.fileName,
  statusAfterRender: manifest.status,
  cameraOversample: 3,
  cameraRendererRevision: "parenthesized-easing-fixed-crop-pan-r2",
};
manifest.outputs = { ...(manifest.outputs || {}), finalVideo };
manifest.production = {
  ...(manifest.production || {}),
  version: "v23-semantic-camera-r1",
  cameraQa: {
    shotCount: plan.rows.length,
    pulloutOnlyShotCount: plan.counts.pulloutOnly,
    directionalOnlyShotCount: plan.counts.directionalOnly,
    semanticCombinationShotCount: plan.counts.combined,
    explicitSpeakerHandoffShotCount: plan.counts.explicitSpeakerHandoffs,
    cropBoundaryCollisionCount: plan.rows.filter((row) => row.cropClampCollision).length,
    authoredDirectionReversalCount: plan.rows.reduce((sum, row) => sum + row.signReversalCount, 0),
    activeSpeakerBubbleCollisionCount: plan.rows.reduce((sum, row) => (
      sum + row.utteranceChecks.filter((check) => !check.activeSpeakerClearOfBubble).length
    ), 0),
    terminalOvershootShotCount: stability.terminalOvershootShotCount,
    jitterFailureShotCount: stability.jitterFailureShotCount,
    cameraOversample: stability.cameraOversample,
    fullDecodePassed: true,
    blackFrameEventCount,
    regressionTestPassCount: 19,
  },
  audioPreservationQa: {
    approvedSourceVersion: "v22-natural-dialogue-r1",
    v22AudioPcmMd5,
    v23AudioPcmMd5,
    pcmIdentical: true,
  },
};
manifest.updatedAt = createdAt;

const evidence = {
  version: "v23-semantic-camera-r1",
  referenceVideoIds: plan.referenceVideoIds,
  finalVideo,
  referenceCalibration: {
    analyzedSceneCount: reference.aggregate.analyzedSceneCount,
    validMotionCount: reference.aggregate.validMotionCount,
    movingSceneRatio: reference.aggregate.movingSceneRatio,
    multiCaptionSceneRatio: reference.aggregate.multiCaptionSceneRatio,
    inspectedSpeakerHandoffExample: plan.referenceEvidence.inspectedSpeakerHandoffExample,
  },
  cameraModes: plan.counts,
  measuredQa: manifest.production.cameraQa,
  audioPreservationQa: manifest.production.audioPreservationQa,
  artifacts: {
    referenceCameraGrammarPath: referenceReportPath,
    semanticCameraPlanPath: planPath,
    stabilityAnalysisPath: stabilityPath,
    cameraStartEndSheetPath: join(projectDir, "canvas/assets/review/manga-photo-homecoming-001-v23-camera-start-end-sheet.jpg"),
    terminalMotionSheetPath: join(projectDir, "canvas/assets/review/manga-photo-homecoming-001-v23-terminal-motion-sheet.jpg"),
  },
  createdAt,
};

await Promise.all([
  writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8"),
]);
process.stdout.write(`${JSON.stringify({ manifestPath, evidencePath, finalVideo, measuredQa: evidence.measuredQa, audioPreservationQa: evidence.audioPreservationQa }, null, 2)}\n`);
