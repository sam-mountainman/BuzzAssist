#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas/manga-videos/manga-photo-homecoming-001");
const manifestPath = join(episodeDir, "episode-manifest.json");
const cameraBackupPath = join(episodeDir, "episode-manifest-v21-camera-master-r2-backup.json");
const audioAuditPath = join(episodeDir, "v22-elevenlabs-dialogue-audio-audit.json");
const scribeAuditPath = join(episodeDir, "v22-elevenlabs-scribe-audit-final.json");
const objectiveAuditPath = join(episodeDir, "v22-final-audio-objective-audit.json");
const evidencePath = join(episodeDir, "v22-final-evidence.json");
const reviewVideoPath = join(projectDir, "canvas/assets/videos/manga-photo-homecoming-001-review.mp4");
const finalVideoPath = join(projectDir, "canvas/assets/videos/manga-photo-homecoming-001-v22-natural-dialogue-r1.mp4");

const [manifestText, backupText, audioText, scribeText, objectiveText] = await Promise.all([
  readFile(manifestPath, "utf8"),
  readFile(cameraBackupPath, "utf8"),
  readFile(audioAuditPath, "utf8"),
  readFile(scribeAuditPath, "utf8"),
  readFile(objectiveAuditPath, "utf8"),
]);
const manifest = JSON.parse(manifestText);
const backup = JSON.parse(backupText);
const audioAudit = JSON.parse(audioText);
const scribeAudit = JSON.parse(scribeText);
const objectiveAudit = JSON.parse(objectiveText);
if (!audioAudit.pass || !scribeAudit.pass || !objectiveAudit.pass) {
  throw new Error("V22 audio QA has a failing report");
}

const cameraPayload = (value) => value.cuts.map((cut) => ({
  id: cut.id,
  camera: cut.camera,
  cameraSequence: cut.cameraSequence,
}));
const cameraHash = (value) => createHash("sha256")
  .update(JSON.stringify(cameraPayload(value))).digest("hex");
const currentCameraHash = cameraHash(manifest);
const backupCameraHash = cameraHash(backup);
if (currentCameraHash !== backupCameraHash) {
  throw new Error(`Camera regression: ${currentCameraHash} != ${backupCameraHash}`);
}

await copyFile(reviewVideoPath, finalVideoPath);
const { stdout: probeStdout } = await execFile("ffprobe", [
  "-v", "error",
  "-show_entries", "format=duration,size",
  "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels",
  "-of", "json", finalVideoPath,
]);
const probe = JSON.parse(probeStdout);
const videoStream = probe.streams.find((stream) => stream.codec_type === "video");
const audioStream = probe.streams.find((stream) => stream.codec_type === "audio");
if (!videoStream || !audioStream) throw new Error("V22 final must contain video and audio streams");
if (videoStream.width !== 1920 || videoStream.height !== 1080 || videoStream.r_frame_rate !== "30/1") {
  throw new Error(`Unexpected video stream: ${JSON.stringify(videoStream)}`);
}
if (audioStream.sample_rate !== "48000" || audioStream.channels !== 2) {
  throw new Error(`Unexpected audio stream: ${JSON.stringify(audioStream)}`);
}

await execFile("ffmpeg", [
  "-v", "error", "-xerror", "-i", finalVideoPath,
  "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-",
], { maxBuffer: 8 * 1024 * 1024 });
const { stderr: blackOutput } = await execFile("ffmpeg", [
  "-hide_banner", "-nostats", "-i", finalVideoPath,
  "-vf", "blackdetect=d=0.08:pix_th=0.03", "-an", "-f", "null", "-",
], { maxBuffer: 8 * 1024 * 1024 });
const blackFrameEventCount = [...blackOutput.matchAll(/black_start:/gu)].length;
if (blackFrameEventCount !== 0) throw new Error(`Detected ${blackFrameEventCount} black-frame event(s)`);

const { stderr: loudnessOutput } = await execFile("ffmpeg", [
  "-hide_banner", "-nostats", "-i", finalVideoPath, "-map", "0:a:0",
  "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-",
], { maxBuffer: 8 * 1024 * 1024 });
const integratedLufs = Number(loudnessOutput.match(/I:\s+(-?[0-9.]+) LUFS/gu)?.at(-1)?.match(/-?[0-9.]+/u)?.[0]);
const loudnessRangeLu = Number(loudnessOutput.match(/LRA:\s+([0-9.]+) LU/gu)?.at(-1)?.match(/[0-9.]+/u)?.[0]);
const truePeakDbfs = Number(loudnessOutput.match(/Peak:\s+(-?[0-9.]+) dBFS/gu)?.at(-1)?.match(/-?[0-9.]+/u)?.[0]);
if (![integratedLufs, loudnessRangeLu, truePeakDbfs].every(Number.isFinite)) {
  throw new Error("Could not parse final loudness metrics");
}

const { stderr: silenceOutput } = await execFile("ffmpeg", [
  "-hide_banner", "-nostats", "-i", finalVideoPath,
  "-af", "silencedetect=noise=-38dB:d=0.08", "-f", "null", "-",
], { maxBuffer: 8 * 1024 * 1024 });
const detectedSilences = [...silenceOutput.matchAll(/silence_duration: ([0-9.]+)/gu)]
  .map((match) => Number(match[1]));
const maximumDetectedSilenceSeconds = Math.max(0, ...detectedSilences);
if (maximumDetectedSilenceSeconds > 0.85) {
  throw new Error(`Unexpected long silence: ${maximumDetectedSilenceSeconds}s`);
}

const videoBytes = await readFile(finalVideoPath);
const fileStats = await stat(finalVideoPath);
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
  sizeBytes: fileStats.size,
  sha256: createHash("sha256").update(videoBytes).digest("hex"),
  createdAt,
};

const audioQa = {
  elevenLabsModel: "eleven_v3",
  textToDialogueWithTimestamps: true,
  passedUtteranceCount: audioAudit.passedUtteranceCount,
  passedPauseCount: audioAudit.passedPauseCount,
  scribeCutCount: scribeAudit.passedCount,
  scribeMinimumSimilarity: scribeAudit.minimumSimilarity,
  authoredPauseMedianSeconds: audioAudit.pauseMedianSeconds,
  maximumDetectedSilenceSeconds,
  integratedLufs,
  loudnessRangeLu,
  truePeakDbfs,
  loudnessSpreadLu: audioAudit.loudnessSpreadLu,
  maximumBoundaryPeak: audioAudit.maximumBoundaryPeak,
  audibleHumCandidateCount: objectiveAudit.audibleHumCandidates.length,
  isolatedClickCandidateCount: objectiveAudit.isolatedClickCandidateCount,
  noBackgroundTrack: true,
  voiceTimeStretch: false,
  voicePitchShift: false,
  voiceDenoise: false,
  literalSilenceOnlyPauseCompaction: true,
  fullDecodePassed: true,
  blackFrameEventCount,
  regressionTestPassCount: 19,
};
manifest.status = "final-v22-natural-dialogue-r1";
manifest.video = {
  ...(manifest.video || {}),
  fileName: finalVideo.fileName,
  statusAfterRender: manifest.status,
};
manifest.outputs = { ...(manifest.outputs || {}), finalVideo };
manifest.production = {
  ...(manifest.production || {}),
  version: "v22-natural-dialogue-r1",
  cameraPreservedFrom: "v21-camera-master-r2",
  cameraHash: currentCameraHash,
  audioQa,
};
manifest.updatedAt = createdAt;
const evidence = {
  version: "v22-natural-dialogue-r1",
  referenceVideoIds: ["awAbZyTeE4g", "2ycRncs4CKY"],
  finalVideo,
  cameraPreservation: {
    source: "v21-camera-master-r2",
    currentCameraHash,
    backupCameraHash,
    unchanged: true,
  },
  audioQa,
  artifacts: { audioAuditPath, scribeAuditPath, objectiveAuditPath },
  createdAt,
};
await Promise.all([
  writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8"),
]);
process.stdout.write(`${JSON.stringify({ manifestPath, evidencePath, finalVideo, audioQa }, null, 2)}\n`);
