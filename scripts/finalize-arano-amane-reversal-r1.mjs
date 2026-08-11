#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { copyFile, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";

const execFile = promisify(execFileCallback);
const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas/manga-videos/manga-arano-amane-reversal-001");
const manifestPath = join(episodeDir, "episode-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const reviewVideoPath = resolve(process.argv[3] || manifest.outputs?.reviewVideo?.filePath || "");
if (!reviewVideoPath) throw new Error("Review video path is required.");
const finalVideoPath = join(projectDir, "canvas/assets/videos/manga-arano-amane-reversal-001-r1-final.mp4");
const evidencePath = join(episodeDir, "final-evidence-r1.json");
const checkpointPath = join(episodeDir, "checkpoint.json");

const auditPaths = {
  sourceCoverage: join(episodeDir, "audits/source-coverage-audit-r2.json"),
  speechSource: join(episodeDir, "audits/speech-source-audit-r2.json"),
  bubbleLayout: join(episodeDir, "audits/bubble-layout-audit-r1.json"),
  cameraPreRender: join(episodeDir, "audits/camera-prerender-audit-r1.json"),
  finalMedia: join(episodeDir, "audits/final-media-audit-r1.json"),
  finalAudio: join(episodeDir, "audits/final-audio-objective-r1.json"),
  finalSttSignal: join(episodeDir, "audits/final-stt-signal-r1.json"),
  bubbleFrames: join(episodeDir, "audits/final-bubble-frames-r1/bubble-frame-audit.json"),
  bubbleTransitions: join(episodeDir, "audits/final-bubble-transitions-r1/bubble-transition-audit.json"),
  renderedCamera: join(episodeDir, "audits/rendered-camera-audit-r1.json"),
  manualInspection: join(episodeDir, "audits/manual-rendered-inspection-r1.json"),
};
const audits = Object.fromEntries(await Promise.all(Object.entries(auditPaths).map(async ([key, path]) => (
  [key, JSON.parse(await readFile(path, "utf8"))]
))));
const strictPassKeys = [
  "sourceCoverage", "speechSource", "bubbleLayout", "cameraPreRender", "finalMedia",
  "finalAudio", "finalSttSignal", "renderedCamera", "manualInspection",
];
const failedAudits = strictPassKeys.filter((key) => audits[key]?.pass !== true);
if (failedAudits.length > 0) throw new Error(`Final audits have not all passed: ${failedAudits.join(", ")}`);
if (audits.bubbleFrames?.frameCount !== manifest.utterances.length) {
  throw new Error(`Bubble midpoint coverage is incomplete: ${audits.bubbleFrames?.frameCount}/${manifest.utterances.length}`);
}
if (audits.bubbleTransitions?.everyTransitionHasEncodedClearFrame !== true) {
  throw new Error("Encoded bubble transitions did not all include a clear frame.");
}
if (manifest.production?.qualityHarness?.finalReport?.pass !== true) {
  throw new Error("The pipeline final quality harness has not passed.");
}
if ((audits.manualInspection?.knownRemainingIssues || []).length > 0) {
  throw new Error("Manual inspection still contains known remaining issues.");
}

await copyFile(reviewVideoPath, finalVideoPath, constants.COPYFILE_EXCL);
await execFile("ffmpeg", ["-v", "error", "-xerror", "-i", finalVideoPath, "-f", "null", "-"], {
  maxBuffer: 32 * 1024 * 1024,
});
const { stdout: probeOutput } = await execFile("ffprobe", [
  "-v", "error",
  "-show_entries", "format=duration,size,bit_rate",
  "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,sample_rate,channels",
  "-of", "json", finalVideoPath,
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
) throw new Error(`Unexpected final streams: ${JSON.stringify(probe.streams)}`);

const hashFile = async (path, algorithm) => {
  const digest = createHash(algorithm);
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
};
const [{ stdout: pcmHashOutput }, stats, sha256] = await Promise.all([
  execFile("ffmpeg", ["-v", "error", "-i", finalVideoPath, "-map", "0:a:0", "-f", "hash", "-hash", "md5", "-"]),
  stat(finalVideoPath),
  hashFile(finalVideoPath, "sha256"),
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
  bitRate: Number(probe.format.bit_rate),
  sha256,
  audioPcmMd5: pcmHashOutput.trim().replace(/^MD5=/u, ""),
  createdAt,
};
const evidence = {
  version: "manga-arano-amane-reversal-001-r1-final",
  pass: true,
  finalVideo,
  auditPaths,
  auditSummary: {
    sourceCharacters: audits.sourceCoverage?.sourceCharacters,
    productionCharacters: audits.sourceCoverage?.productionCharacters,
    utterances: manifest.utterances.length,
    bubbleMidpointFrames: audits.bubbleFrames.frameCount,
    bubbleTransitions: audits.bubbleTransitions.transitionCount,
    renderedCameraShots: audits.renderedCamera.shotCount,
    sttSimilarity: audits.finalSttSignal.global?.similarity,
    sttOrderedCoverage: audits.finalSttSignal.global?.orderedCoverage,
    integratedLufs: audits.finalMedia.loudness?.integratedLufs,
    truePeakDbfs: audits.finalMedia.loudness?.truePeakDbfs,
    isolatedClickCandidates: audits.finalAudio.isolatedClickCandidateCount,
    audibleHumCandidates: audits.finalAudio.audibleHumCandidates?.length,
  },
  fullDecodePassed: true,
  automaticQualityHarnessPassed: true,
  knownRemainingIssues: [],
  createdAt,
};

manifest.status = "final-r1-audited";
manifest.video = { ...(manifest.video || {}), fileName: finalVideo.fileName, statusAfterRender: manifest.status };
manifest.outputs = { ...(manifest.outputs || {}), finalVideo };
manifest.production = {
  ...(manifest.production || {}),
  version: evidence.version,
  finalEvidence: { filePath: evidencePath, pass: true, version: evidence.version },
};
manifest.metrics = { ...(manifest.metrics || {}), videoDurationSeconds: finalVideo.durationSeconds, finalSizeBytes: finalVideo.sizeBytes };
manifest.updatedAt = createdAt;
let checkpoint = {};
try { checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")); } catch { checkpoint = {}; }
checkpoint = {
  ...checkpoint,
  episodeId: manifest.id,
  status: "complete",
  nextStage: "complete",
  finalVideoPath,
  fullDecodePassed: true,
  knownRemainingIssues: [],
  updatedAt: createdAt,
};
await Promise.all([
  writeJsonAtomic(manifestPath, manifest),
  writeJsonAtomic(evidencePath, evidence),
  writeJsonAtomic(checkpointPath, checkpoint),
]);
process.stdout.write(`${JSON.stringify({ finalVideo, evidencePath, auditSummary: evidence.auditSummary }, null, 2)}\n`);
