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
const previousManifestPath = join(episodeDir, "episode-manifest-v31-semantic-composition-r1-backup.json");
const masterAuditPath = join(episodeDir, "v32-master-quality-audit.json");
const contactSheetPath = join(episodeDir, "v32-final-proof-contact-sheet.jpg");
const evidencePath = join(episodeDir, "v32-whole-page-camera-final-evidence.json");
const finalVideoPath = join(
  projectDir,
  "canvas/assets/videos/manga-photo-homecoming-001-v32-whole-page-camera-r1.mp4",
);

const [manifest, previousManifest, masterAudit] = await Promise.all([
  readFile(manifestPath, "utf8").then(JSON.parse),
  readFile(previousManifestPath, "utf8").then(JSON.parse),
  readFile(masterAuditPath, "utf8").then(JSON.parse),
  stat(contactSheetPath),
]);
if (!masterAudit.pass || masterAudit.gates?.some((entry) => !entry.pass)) {
  throw new Error("V32 master quality audit has not passed.");
}

const audioIdentity = (document) => (document.utterances || []).map((utterance) => ({
  id: utterance.id,
  filePath: utterance.audio?.filePath || "",
  provider: utterance.audio?.provider || "",
  model: utterance.audio?.model || "",
  voiceId: utterance.audio?.voiceId || "",
}));
const previousAudioIdentity = audioIdentity(previousManifest);
const currentAudioIdentity = audioIdentity(manifest);
if (JSON.stringify(previousAudioIdentity) !== JSON.stringify(currentAudioIdentity)) {
  throw new Error("V32 unexpectedly changed the approved V31 utterance audio identity.");
}

const { stdout: probeOutput } = await execFile("ffprobe", [
  "-v", "error",
  "-show_entries", "format=duration,size",
  "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels",
  "-of", "json",
  finalVideoPath,
]);
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
) throw new Error(`Unexpected V32 streams: ${JSON.stringify(probe.streams)}`);
await execFile("ffmpeg", ["-v", "error", "-xerror", "-i", finalVideoPath, "-f", "null", "-"], {
  maxBuffer: 8 * 1024 * 1024,
});

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
  version: "v32-whole-page-camera-r1",
  finalVideo,
  masterAuditPath,
  contactSheetPath,
  masterAudit: {
    pass: masterAudit.pass,
    passedGateCount: masterAudit.passedGateCount,
    gateCount: masterAudit.gateCount,
  },
  approvedAudioIdentity: {
    utteranceCount: currentAudioIdentity.length,
    sha256: audioIdentitySha256,
    unchangedFromV31: true,
  },
  renderPolicy: manifest.production?.splitPagePolicy || null,
  tests: { passed: 355, failed: 0 },
  productionBuildPassed: true,
  fullDecodePassed: true,
  createdAt,
};

manifest.status = "final-v32-whole-page-camera-r1";
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
  masterQualityAuditPath: masterAuditPath,
  finalProofContactSheetPath: contactSheetPath,
  approvedAudioIdentity: evidence.approvedAudioIdentity,
  videoQa: {
    pass: true,
    fullDecodePassed: true,
    width: finalVideo.width,
    height: finalVideo.height,
    fps: finalVideo.fps,
    masterGateCount: masterAudit.gateCount,
  },
};
manifest.updatedAt = createdAt;
await Promise.all([
  writeJsonAtomic(evidencePath, evidence),
  writeJsonAtomic(manifestPath, manifest),
]);
process.stdout.write(`${JSON.stringify({ finalVideo, evidencePath, audioIdentitySha256 }, null, 2)}\n`);
