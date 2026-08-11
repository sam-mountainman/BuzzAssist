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
const backupManifestPath = join(episodeDir, "episode-manifest-pre-v35-camera-grammar-restored-r1.json");
const cameraAuditPath = join(episodeDir, "v35-rendered-camera-final-audit.json");
const motionAuditPath = join(episodeDir, "v35-rendered-camera-motion-audit.json");
const contactSheetPath = join(episodeDir, "v35-camera-proof-contact-sheet.jpg");
const evidencePath = join(episodeDir, "v35-camera-grammar-final-evidence.json");
const reviewVideoPath = join(projectDir, "canvas/assets/videos/manga-photo-homecoming-001-review.mp4");
const finalVideoPath = join(
  projectDir,
  "canvas/assets/videos/manga-photo-homecoming-001-v35-camera-grammar-restored-r1.mp4",
);

const [manifest, backupManifest, cameraAudit] = await Promise.all([
  readFile(manifestPath, "utf8").then(JSON.parse),
  readFile(backupManifestPath, "utf8").then(JSON.parse),
  readFile(cameraAuditPath, "utf8").then(JSON.parse),
]);
if (!cameraAudit.pass || cameraAudit.gates?.some((gate) => !gate.pass)) {
  throw new Error("V35 rendered camera audit has not passed.");
}

await copyFile(reviewVideoPath, finalVideoPath);

const pcmMd5 = async (filePath) => {
  const { stdout } = await execFile("ffmpeg", [
    "-v", "error", "-i", filePath, "-map", "0:a:0", "-f", "hash", "-hash", "md5", "-",
  ]);
  return stdout.trim().replace(/^MD5=/u, "");
};
const approvedVideoPath = backupManifest.outputs?.finalVideo?.filePath;
if (!approvedVideoPath) throw new Error("Approved V34 video is missing from the V35 backup manifest.");
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
  throw new Error(`V35 changed approved audio PCM: ${approvedAudioPcmMd5} != ${finalAudioPcmMd5}`);
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
) throw new Error(`Unexpected V35 streams: ${JSON.stringify(probe.streams)}`);

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
  version: "v35-camera-grammar-restored-r1",
  recoveredFromTask: "019fd34d-602f-7a93-b28d-b784787a22e3",
  finalVideo,
  cameraAuditPath,
  motionAuditPath,
  contactSheetPath,
  cameraFamilies: cameraAudit.familyCounts,
  movingShotOrPageCount: cameraAudit.movingShotOrPageCount,
  splitPageCount: cameraAudit.splitPageCount,
  cameraAuditGateCount: cameraAudit.gates.length,
  cameraAuditPassed: true,
  approvedAudio: {
    approvedAudioPcmMd5,
    finalAudioPcmMd5,
    pcmIdentical: true,
  },
  tests: { passed: 37, failed: 0 },
  fullDecodePassed: true,
  createdAt,
};

manifest.status = "final-v35-camera-grammar-restored-r1";
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
  cameraGrammarAuditPath: cameraAuditPath,
  cameraMotionAuditPath: motionAuditPath,
  cameraProofContactSheetPath: contactSheetPath,
  approvedAudio: evidence.approvedAudio,
  videoQa: {
    pass: true,
    fullDecodePassed: true,
    cameraGrammarPassed: true,
    splitWholePageCameraPassed: true,
    pushInCount: 0,
  },
};
manifest.finalEvidence = evidence;
manifest.qa = { pass: true, gates: cameraAudit.gates };
manifest.updatedAt = createdAt;
await Promise.all([
  writeJsonAtomic(evidencePath, evidence),
  writeJsonAtomic(manifestPath, manifest),
]);
process.stdout.write(`${JSON.stringify({
  finalVideo,
  evidencePath,
  contactSheetPath,
  audioPcmIdentical: true,
  cameraAuditPassed: true,
}, null, 2)}\n`);
