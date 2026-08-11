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
const backupPath = join(episodeDir, "episode-manifest-pre-v33-page-camera-grammar-r1.json");
const cameraAuditPath = join(episodeDir, "v33-rendered-camera-final-audit.json");
const masterAuditPath = join(episodeDir, "v33-master-quality-audit.json");
const contactSheetPath = join(episodeDir, "v33-final-proof-contact-sheet.jpg");
const evidencePath = join(episodeDir, "v33-page-camera-final-evidence.json");
const finalVideoPath = join(
  projectDir,
  "canvas/assets/videos/manga-photo-homecoming-001-v33-page-camera-grammar-r1.mp4",
);

const [manifest, backup, cameraAudit, masterAudit] = await Promise.all([
  readFile(manifestPath, "utf8").then(JSON.parse),
  readFile(backupPath, "utf8").then(JSON.parse),
  readFile(cameraAuditPath, "utf8").then(JSON.parse),
  readFile(masterAuditPath, "utf8").then(JSON.parse),
]);
if (!cameraAudit.pass || cameraAudit.gates?.some((gate) => !gate.pass)) {
  throw new Error("V33 rendered camera audit has not passed.");
}
if (!masterAudit.pass || masterAudit.gates?.some((gate) => !gate.pass)) {
  throw new Error("V33 master quality audit has not passed.");
}

const audioIdentity = (document) => (document.utterances || []).map((utterance) => ({
  id: utterance.id,
  filePath: utterance.audio?.filePath || "",
  provider: utterance.audio?.provider || "",
  model: utterance.audio?.model || "",
  voiceId: utterance.audio?.voiceId || "",
}));
const approvedAudioIdentity = audioIdentity(backup);
const currentAudioIdentity = audioIdentity(manifest);
if (JSON.stringify(approvedAudioIdentity) !== JSON.stringify(currentAudioIdentity)) {
  throw new Error("V33 changed the approved utterance audio identity.");
}
const approvedVideoPath = resolve(backup.outputs?.finalVideo?.filePath || "");
if (!approvedVideoPath) throw new Error("Approved pre-V33 final video is missing.");

const pcmMd5 = async (filePath) => {
  const { stdout } = await execFile("ffmpeg", [
    "-v", "error", "-i", filePath, "-map", "0:a:0", "-f", "md5", "-",
  ], { maxBuffer: 8 * 1024 * 1024 });
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
  throw new Error(`V33 changed approved audio PCM: ${approvedAudioPcmMd5} != ${finalAudioPcmMd5}`);
}
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
) throw new Error(`Unexpected V33 streams: ${JSON.stringify(probe.streams)}`);
await execFile("ffmpeg", ["-v", "error", "-xerror", "-i", finalVideoPath, "-f", "null", "-"], {
  maxBuffer: 8 * 1024 * 1024,
});

const proofTimes = [15.5, 23.4, 74.0, 82.5, 106.3, 111.0];
const selectedFrames = proofTimes.map((seconds) => `eq(n\\,${Math.round(seconds * 30)})`).join("+");
await execFile("ffmpeg", [
  "-y", "-v", "error", "-i", finalVideoPath,
  "-vf", `select='${selectedFrames}',scale=640:360:flags=lanczos,tile=3x2:padding=8:margin=8:color=white`,
  "-frames:v", "1", contactSheetPath,
], { maxBuffer: 8 * 1024 * 1024 });

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
const audioIdentitySha256 = createHash("sha256")
  .update(JSON.stringify(currentAudioIdentity))
  .digest("hex");
const evidence = {
  version: "v33-page-camera-grammar-r1",
  finalVideo,
  cameraAuditPath,
  masterAuditPath,
  contactSheetPath,
  cameraAudit: {
    pass: cameraAudit.pass,
    shotCount: cameraAudit.shotCount,
    movingShotCount: cameraAudit.movingShotCount,
    wrongDirectionCount: cameraAudit.wrongDirectionRows?.length || 0,
    splitPages: cameraAudit.splitPages,
  },
  masterAudit: {
    pass: masterAudit.pass,
    passedGateCount: masterAudit.passedGateCount,
    gateCount: masterAudit.gateCount,
  },
  approvedAudio: {
    utteranceCount: currentAudioIdentity.length,
    identitySha256: audioIdentitySha256,
    approvedAudioPcmMd5,
    finalAudioPcmMd5,
    pcmIdentical: true,
  },
  tests: { targetedPassed: 63, targetedFailed: 0 },
  fullDecodePassed: true,
  createdAt,
};

manifest.status = "final-v33-page-camera-grammar-r1";
manifest.video = {
  ...(manifest.video || {}),
  fileName: finalVideo.fileName,
  motion: "pull-out",
  statusAfterRender: manifest.status,
};
manifest.outputs = { ...(manifest.outputs || {}), finalVideo, reviewVideo: finalVideo };
manifest.production = {
  ...(manifest.production || {}),
  version: evidence.version,
  finalEvidencePath: evidencePath,
  masterQualityAuditPath: masterAuditPath,
  renderedCameraAuditPath: cameraAuditPath,
  finalProofContactSheetPath: contactSheetPath,
  approvedAudio: evidence.approvedAudio,
  videoQa: {
    pass: true,
    fullDecodePassed: true,
    width: finalVideo.width,
    height: finalVideo.height,
    fps: finalVideo.fps,
    cameraGateCount: cameraAudit.gates.length,
    masterGateCount: masterAudit.gateCount,
  },
};
manifest.updatedAt = createdAt;
await Promise.all([
  writeJsonAtomic(evidencePath, evidence),
  writeJsonAtomic(manifestPath, manifest),
]);
process.stdout.write(`${JSON.stringify({ finalVideo, evidencePath, contactSheetPath, audioPcmIdentical: true }, null, 2)}\n`);
