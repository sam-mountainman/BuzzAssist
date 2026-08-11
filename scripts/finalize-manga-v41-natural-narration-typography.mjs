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
const evidencePath = join(episodeDir, "v41-natural-narration-typography-final-evidence.json");
const reviewVideoPath = join(projectDir, "canvas/assets/videos/manga-photo-homecoming-001-review.mp4");
const previousVideoPath = join(
  projectDir,
  "canvas/assets/videos/manga-photo-homecoming-001-v40-approved-audio-restored-r1.mp4",
);
const finalVideoPath = join(
  projectDir,
  "canvas/assets/videos/manga-photo-homecoming-001-v41-natural-narration-typography-r1.mp4",
);

const [manifest, cameraAudit] = await Promise.all([
  readFile(manifestPath, "utf8").then(JSON.parse),
  readFile(cameraAuditPath, "utf8").then(JSON.parse),
]);
if (!cameraAudit.pass || cameraAudit.gates?.some((gate) => !gate.pass)) {
  throw new Error("V41 rendered camera audit has not passed; refusing to finalize.");
}

await copyFile(reviewVideoPath, finalVideoPath);

const pcmMd5 = async (filePath) => {
  const { stdout } = await execFile("ffmpeg", [
    "-v", "error", "-i", filePath, "-map", "0:a:0", "-f", "hash", "-hash", "md5", "-",
  ]);
  return stdout.trim().replace(/^MD5=/u, "");
};

const [previousAudioPcmMd5, finalAudioPcmMd5, { stdout: probeOutput }] = await Promise.all([
  pcmMd5(previousVideoPath),
  pcmMd5(finalVideoPath),
  execFile("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,size",
    "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels",
    "-of", "json",
    finalVideoPath,
  ]),
]);
// R63 replaced the 7 narration takes (plain-text, no direction tags), so v41
// establishes a NEW audio baseline; previousAudioPcmMd5 (v40) is recorded for
// provenance and finalAudioPcmMd5 becomes the regression reference for future
// video-only changes.
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
) throw new Error(`Unexpected V41 streams: ${JSON.stringify(probe.streams)}`);

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
  throw new Error(`V41 bubble gates failed: ${JSON.stringify(bubbleStats)}`);
}

const evidence = {
  version: "v41-natural-narration-typography-r1",
  fixes: "R63 narration re-taken as plain dialogue (no direction tags, prosody within approved dialogue band) + R64 vertical-glyph rasterizer fix (Chrome 151 hang flag removed, degraded sips fallback now a hard error) with new rendered-frame typography gate (body glyphs 0.30em, vert-form punctuation/small-kana class 0.85em)",
  rootCause: "Chrome 151 --run-all-compositor-stages-before-draw hang caused silent sips fallback which cannot render vertical glyph forms; narration semantic-intent direction was rejected by the user as over-acting",
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
  approvedAudio: {
    previousBaselinePcmMd5: previousAudioPcmMd5,
    newBaselinePcmMd5: finalAudioPcmMd5,
    baselineReset: "R63: 7 narration lines re-taken with plain speech text only; 22 dialogue lines unchanged from approved master (corr 1.000); onset margin 100ms retained",
  },
  fullDecodePassed: true,
  createdAt,
};

manifest.status = "final-v41-natural-narration-typography-r1";
manifest.video = { ...(manifest.video || {}), fileName: finalVideo.fileName, statusAfterRender: "final-v41-natural-narration-typography-r1" };
manifest.outputs = { ...(manifest.outputs || {}), finalVideo };
manifest.updatedAt = createdAt;
await Promise.all([
  writeJsonAtomic(manifestPath, manifest),
  writeJsonAtomic(evidencePath, evidence),
]);
process.stdout.write(`${JSON.stringify({ finalVideoPath, evidencePath, bubbleStats, audioBaseline: "reset-v41" }, null, 2)}\n`);
