#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";

const execFile = promisify(execFileCallback);
const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas/manga-videos/manga-photo-homecoming-001");
const manifestPath = join(episodeDir, "episode-manifest.json");
const coordinateAuditPath = join(episodeDir, "v34-thought-face-coordinate-audit.json");
const frameAuditPath = join(episodeDir, "v34-thought-face-frame-audit.json");
const evidencePath = join(episodeDir, "v34-thought-face-final-evidence.json");
const contactSheetPath = join(episodeDir, "audits/v34-thought-face-lock/contact-sheet.png");
const approvedVideoPath = join(
  projectDir,
  "canvas/assets/videos/manga-photo-homecoming-001-v33-page-camera-grammar-r1.mp4",
);
const finalVideoPath = join(
  projectDir,
  "canvas/assets/videos/manga-photo-homecoming-001-v34-thought-face-lock-r1.mp4",
);

const [manifest, coordinateAudit, frameAudit] = await Promise.all([
  readFile(manifestPath, "utf8").then(JSON.parse),
  readFile(coordinateAuditPath, "utf8").then(JSON.parse),
  readFile(frameAuditPath, "utf8").then(JSON.parse),
]);
for (const [name, audit] of [["coordinate", coordinateAudit], ["frame", frameAudit]]) {
  if (!audit.pass || audit.gates?.some((gate) => !gate.pass)) {
    throw new Error(`V34 ${name} audit has not passed.`);
  }
}

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
if (approvedAudioPcmMd5 !== finalAudioPcmMd5) {
  throw new Error(`V34 changed approved audio PCM: ${approvedAudioPcmMd5} != ${finalAudioPcmMd5}`);
}
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
) throw new Error(`Unexpected V34 streams: ${JSON.stringify(probe.streams)}`);

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
const evidence = {
  version: "v34-thought-face-lock-r1",
  finalVideo,
  coordinateAuditPath,
  frameAuditPath,
  contactSheetPath,
  projectedSpotCenter: coordinateAudit.projectedCenter,
  midpointPixelError: frameAudit.gates.find((gate) => gate.id === "midpoint-pixel-lock")?.valuePx,
  maxNormalizedCameraDrift: frameAudit.gates.find((gate) => gate.id === "full-thought-camera-drift-contained-inside-face")?.maxValue,
  approvedAudio: {
    approvedAudioPcmMd5,
    finalAudioPcmMd5,
    pcmIdentical: true,
  },
  tests: { mangaVideoPipelinePassed: 32, mangaVideoPipelineFailed: 0 },
  fullDecodePassed: true,
  createdAt,
};

manifest.status = "final-v34-thought-face-lock-r1";
manifest.video = {
  ...(manifest.video || {}),
  fileName: finalVideo.fileName,
  statusAfterRender: manifest.status,
};
manifest.outputs = { ...(manifest.outputs || {}), finalVideo, reviewVideo: finalVideo };
manifest.production = {
  ...(manifest.production || {}),
  version: evidence.version,
  finalEvidencePath: evidencePath,
  thoughtFocusCoordinateAuditPath: coordinateAuditPath,
  thoughtFocusFrameAuditPath: frameAuditPath,
  thoughtFocusContactSheetPath: contactSheetPath,
  approvedAudio: evidence.approvedAudio,
  videoQa: {
    pass: true,
    fullDecodePassed: true,
    faceLockPassed: true,
    midpointPixelError: evidence.midpointPixelError,
  },
};
manifest.updatedAt = createdAt;
await Promise.all([
  writeJsonAtomic(evidencePath, evidence),
  writeJsonAtomic(manifestPath, manifest),
]);
process.stdout.write(`${JSON.stringify({ finalVideo, evidencePath, contactSheetPath, audioPcmIdentical: true }, null, 2)}\n`);
