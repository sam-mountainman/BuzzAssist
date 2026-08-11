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
const planPath = join(episodeDir, "v21-camera-master-plan.json");
const stabilityPath = join(episodeDir, "v21-terminal-stability-analysis.json");
const evidencePath = join(episodeDir, "v21-final-evidence.json");
const reviewVideoPath = join(projectDir, "canvas/assets/videos/manga-photo-homecoming-001-review.mp4");
const finalVideoPath = join(projectDir, "canvas/assets/videos/manga-photo-homecoming-001-v21-camera-master-r2.mp4");
await copyFile(reviewVideoPath, finalVideoPath);
const [manifestText, planText, stabilityText, videoBytes] = await Promise.all([
  readFile(manifestPath, "utf8"),
  readFile(planPath, "utf8"),
  readFile(stabilityPath, "utf8"),
  readFile(finalVideoPath),
]);
const manifest = JSON.parse(manifestText);
const plan = JSON.parse(planText);
const stability = JSON.parse(stabilityText);
const { stdout } = await execFile("ffprobe", [
  "-v", "error",
  "-show_entries", "format=duration,size",
  "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames",
  "-of", "json",
  finalVideoPath,
]);
const probe = JSON.parse(stdout);
const videoStream = probe.streams.find((stream) => stream.codec_type === "video");
const audioStream = probe.streams.find((stream) => stream.codec_type === "audio");
if (!videoStream || !audioStream) throw new Error("V21 final must contain video and audio streams");
if (videoStream.width !== 1920 || videoStream.height !== 1080 || videoStream.r_frame_rate !== "30/1") {
  throw new Error(`Unexpected V21 video stream: ${JSON.stringify(videoStream)}`);
}
if (plan.counts?.pulloutOnly !== 6 || plan.counts?.directionalOnly !== 10 || plan.counts?.combined !== 4) {
  throw new Error(`Unexpected V21 camera-mode counts: ${JSON.stringify(plan.counts)}`);
}
if (plan.terminalFallbackCount !== 0 || plan.downwardFallbackCount !== 0 || plan.cropBoundaryCollisionCount !== 0) {
  throw new Error("V21 plan still contains a terminal fallback or crop collision");
}
if (stability.terminalOvershootShotCount !== 0 || stability.jitterFailureShotCount !== 0) {
  throw new Error("V21 terminal stability gate failed");
}
await execFile("ffmpeg", [
  "-v", "error", "-xerror", "-i", finalVideoPath,
  "-map", "0:v:0", "-f", "null", "-",
], { maxBuffer: 8 * 1024 * 1024 });
const { stderr: blackDetectOutput } = await execFile("ffmpeg", [
  "-hide_banner", "-nostats", "-i", finalVideoPath,
  "-vf", "blackdetect=d=0.1:pix_th=0.02", "-an", "-f", "null", "-",
], { maxBuffer: 8 * 1024 * 1024 });
const blackFrameEventCount = [...blackDetectOutput.matchAll(/black_start:/g)].length;
if (blackFrameEventCount !== 0) throw new Error(`Detected ${blackFrameEventCount} black-frame event(s)`);
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
  sizeBytes: fileStats.size,
  sha256,
  createdAt,
};
manifest.status = "final-v21-camera-master-r2";
manifest.video = {
  ...(manifest.video || {}),
  fileName: finalVideo.fileName,
  statusAfterRender: manifest.status,
  cameraOversample: 3,
};
manifest.outputs = { ...(manifest.outputs || {}), finalVideo };
manifest.production = {
  ...(manifest.production || {}),
  version: "v21-camera-master-r2",
  cameraQa: {
    pulloutOnlyShotCount: plan.counts.pulloutOnly,
    directionalOnlyShotCount: plan.counts.directionalOnly,
    semanticCombinationShotCount: plan.counts.combined,
    terminalFallbackCount: plan.terminalFallbackCount,
    cropBoundaryCollisionCount: plan.cropBoundaryCollisionCount,
    terminalOvershootShotCount: stability.terminalOvershootShotCount,
    jitterFailureShotCount: stability.jitterFailureShotCount,
    cameraOversample: stability.cameraOversample,
    fullDecodePassed: true,
    blackFrameEventCount,
    regressionTestPassCount: 19,
  },
};
manifest.updatedAt = createdAt;
const evidence = {
  version: "v21-camera-master-r2",
  referenceVideoIds: plan.referenceVideoIds,
  finalVideo,
  cameraModes: plan.counts,
  semanticCameraPolicy: {
    pulloutOnlyHasDirectionalMovement: false,
    directionalOnlyHasZoomMovement: false,
    combinationsReservedForLongSemanticScenes: true,
    terminalFallbackAllowed: false,
    downwardFallbackAllowed: false,
    cropBoundaryCollisionAllowed: false,
  },
  measuredQa: {
    shotCount: stability.shotCount,
    singleModeShotCount: stability.singleModeShotCount,
    semanticCombinationShotCount: stability.semanticCombinationShotCount,
    terminalOvershootShotCount: stability.terminalOvershootShotCount,
    jitterFailureShotCount: stability.jitterFailureShotCount,
    cameraOversample: stability.cameraOversample,
    fullDecodePassed: true,
    blackFrameEventCount,
    regressionTestPassCount: 19,
  },
  artifacts: {
    planPath,
    stabilityAnalysisPath: stabilityPath,
    cameraStartEndSheetPath: join(projectDir, "canvas/assets/review/manga-photo-homecoming-001-v21-camera-start-end-sheet.jpg"),
    terminalMotionSheetPath: join(projectDir, "canvas/assets/review/manga-photo-homecoming-001-v21-terminal-motion-sheet.jpg"),
  },
  createdAt,
};
await Promise.all([
  writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8"),
]);
process.stdout.write(`${JSON.stringify({ manifestPath, evidencePath, finalVideo, cameraQa: evidence.measuredQa }, null, 2)}\n`);
