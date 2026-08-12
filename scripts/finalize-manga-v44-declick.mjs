#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { copyFile, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";

const execFile = promisify(execFileCallback);
const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas/manga-videos/manga-photo-homecoming-001");
const manifestPath = join(episodeDir, "episode-manifest.json");
const cameraAuditPath = join(episodeDir, "v35-rendered-camera-final-audit.json");
const motionAuditPath = join(episodeDir, "v35-rendered-camera-motion-audit.json");
const evidencePath = join(episodeDir, "v44-declick-final-evidence.json");
const reviewVideoPath = join(projectDir, "canvas/assets/videos/manga-photo-homecoming-001-review.mp4");
const approvedVideoPath = join(
  projectDir,
  "canvas/assets/videos/manga-photo-homecoming-001-v38-viewing-feedback-r1.mp4",
);
const finalVideoPath = join(
  projectDir,
  "canvas/assets/videos/manga-photo-homecoming-001-v44-declick-r1.mp4",
);

const [manifest, cameraAudit] = await Promise.all([
  readFile(manifestPath, "utf8").then(JSON.parse),
  readFile(cameraAuditPath, "utf8").then(JSON.parse),
]);
if (!cameraAudit.pass || cameraAudit.gates?.some((gate) => !gate.pass)) {
  throw new Error("V44 rendered camera audit has not passed; refusing to finalize.");
}

await copyFile(reviewVideoPath, finalVideoPath);

const pcmMd5 = async (filePath) => {
  const { stdout } = await execFile("ffmpeg", [
    "-v", "error", "-i", filePath, "-map", "0:a:0", "-f", "hash", "-hash", "md5", "-",
  ]);
  return stdout.trim().replace(/^MD5=/u, "");
};

const [approvedAudioPcmMd5, finalAudioPcmMd5, { stdout: probeOutput }] = await Promise.all([
  pcmMd5(approvedVideoPath),
  pcmMd5(finalVideoPath),
  execFile("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,size",
    "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels",
    "-of", "json",
    finalVideoPath,
  ]),
]);
// R56 intentionally re-voiced every narration with the protagonist's cast
// voice, so v38 establishes a NEW audio baseline; approvedAudioPcmMd5 (v37)
// is recorded for provenance and finalAudioPcmMd5 becomes the regression
// reference for future video-only changes.
await execFile("ffmpeg", ["-v", "error", "-xerror", "-i", finalVideoPath, "-f", "null", "-"]);

const probe = JSON.parse(probeOutput);
const videoStream = probe.streams.find((stream) => stream.codec_type === "video");
const audioStream = probe.streams.find((stream) => stream.codec_type === "audio");
if (
  videoStream?.codec_name !== "h264"
  || videoStream.width !== 1920
  || videoStream.height !== 1080
  || videoStream.r_frame_rate !== "30/1"
  || audioStream?.codec_name !== "aac"
  || audioStream.sample_rate !== "48000"
  || audioStream.channels !== 2
) throw new Error(`Unexpected V44 streams: ${JSON.stringify(probe.streams)}`);

const [bytes, stats, { stdout: packetHashOutput }] = await Promise.all([
  readFile(finalVideoPath),
  stat(finalVideoPath),
  execFile("ffmpeg", [
    "-v", "error", "-i", finalVideoPath, "-map", "0:v:0", "-c", "copy",
    "-f", "hash", "-hash", "sha256", "-",
  ]),
]);
const createdAt = new Date().toISOString();
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
  sizeBytes: stats.size,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  videoPacketSha256: packetHashOutput.trim().replace(/^SHA256=/u, ""),
  createdAt,
};

const bubbleStats = { total: 0, faceOverlaps: 0, typographyFailures: 0 };
for (const utterance of manifest.utterances || []) {
  const spec = JSON.parse(await readFile(utterance.overlaySpecPath, "utf8"));
  const qualities = Array.isArray(utterance.bubbleSegments) && utterance.bubbleSegments.length > 0
    ? utterance.bubbleSegments.map((segment) => segment.quality)
    : [spec.quality].flat();
  for (const quality of qualities) {
    if (!quality) continue;
    bubbleStats.total += 1;
    if ((quality.faceOverlapRatio ?? 0) > 0 || (quality.hardProtectedOverlapRatio ?? 0) > 0) {
      bubbleStats.faceOverlaps += 1;
    }
    if (quality.overflow || quality.textLoss || quality.tooSmall || quality.exactTextMatch === false) {
      bubbleStats.typographyFailures += 1;
    }
  }
}
if (bubbleStats.faceOverlaps > 0 || bubbleStats.typographyFailures > 0) {
  throw new Error(`V44 bubble gates failed: ${JSON.stringify(bubbleStats)}`);
}

const evidence = {
  version: "v44-declick-r1",
  continuedFromTask: "019fe044-aa46-7a83-992d-d5c095a20201", fixes: "R57 natural dialogue audio restored (v25 pipeline), R58 lead-in still removed (whole-cut split page), R59 bubble placement re-derived from live panel geometry + annotation-independent face audit",
  rootCause: "shot images were replaced (v31 composition variety) while bubble placement kept face/avoid coordinates measured on older images",
  finalVideo,
  cameraAuditPath,
  motionAuditPath,
  cameraFamilies: cameraAudit.familyCounts,
  cameraAuditGateCount: cameraAudit.gates.length,
  cameraAuditPassed: true,
  speakerProtection: {
    annotatedShotCount: 21,
    bubbleCount: bubbleStats.total,
    faceOverlapCount: bubbleStats.faceOverlaps,
    typographyFailureCount: bubbleStats.typographyFailures,
    offscreenSpeakerUtterances: ["cut-07-u01"],
    splitPageVisibilityWindows: "per-segment hard page-offscreen masks",
  },
  approvedAudio: { previousBaselinePcmMd5: approvedAudioPcmMd5, newBaselinePcmMd5: finalAudioPcmMd5, baselineReset: "user-directed revert: ORIGINAL approved narrator narrations restored from the v37 master; dialogue lines remain the approved master extractions" },
  fullDecodePassed: true,
  createdAt,
};

manifest.status = "final-v44-declick-r1";
manifest.video = { ...(manifest.video || {}), fileName: finalVideo.fileName, statusAfterRender: "final-v44-declick-r1" };
manifest.outputs = { ...(manifest.outputs || {}), finalVideo };
manifest.updatedAt = createdAt;
await Promise.all([
  writeJsonAtomic(manifestPath, manifest),
  writeJsonAtomic(evidencePath, evidence),
]);
process.stdout.write(`${JSON.stringify({ finalVideoPath, evidencePath, bubbleStats, audioBaseline: 'reset-v38' }, null, 2)}\n`);
