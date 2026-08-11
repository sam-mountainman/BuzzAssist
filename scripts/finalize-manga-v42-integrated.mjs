#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";

const execFile = promisify(execFileCallback);
const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas/manga-videos/manga-photo-homecoming-001");
const manifestPath = join(episodeDir, "episode-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const reviewVideoPath = resolve(
  process.argv[3]
    || manifest.outputs?.reviewVideo?.filePath
    || join(projectDir, "canvas/assets/videos/manga-photo-homecoming-001-v42-audio-rhythm-review.mp4"),
);
const finalVideoPath = join(
  projectDir,
  "canvas/assets/videos/manga-photo-homecoming-001-v42-integrated-final-r1.mp4",
);
const evidencePath = join(episodeDir, "v42-integrated-final-evidence.json");

const auditPaths = {
  masterAssembly: join(episodeDir, "v42-master-assembly-audit.json"),
  finalAudio: join(episodeDir, "v42-final-audio-audit.json"),
  onset: join(episodeDir, "audio-onset-integrity-audit.json"),
  narrationProsody: join(episodeDir, "narration-prosody-audit.json"),
  stt: join(episodeDir, "v42-stt-verification-audit.json"),
  sequence: join(episodeDir, "v29-bubble-sequence-layout-audit.json"),
  independentFaces: join(episodeDir, "bubble-faces-independent-audit.json"),
  typography: join(episodeDir, "bubble-typography-audit.json"),
  bubbleFrames: join(episodeDir, "v42-bubble-frames/bubble-frame-audit.json"),
  transitions: join(episodeDir, "v42-bubble-transitions/bubble-transition-audit.json"),
  camera: join(episodeDir, "v35-rendered-camera-final-audit.json"),
  spotlight: join(episodeDir, "thought-spotlight-audit.json"),
  splitPanels: join(episodeDir, "split-panel-readability-audit.json"),
  structure: join(episodeDir, "v38-structure-audit.json"),
  manualInspection: join(episodeDir, "v42-manual-inspection.json"),
  sharedAppServer: join(episodeDir, "r62-shared-app-server-benchmark.json"),
};
const audits = Object.fromEntries(await Promise.all(Object.entries(auditPaths).map(async ([key, path]) => (
  [key, JSON.parse(await readFile(path, "utf8"))]
))));

const strictPassKeys = [
  "masterAssembly", "finalAudio", "onset", "narrationProsody", "stt", "sequence",
  "independentFaces", "typography", "camera", "spotlight", "splitPanels", "structure",
  "manualInspection",
];
const failedAudits = strictPassKeys.filter((key) => audits[key]?.pass !== true);
if (failedAudits.length > 0) {
  throw new Error(`V42 audits have not all passed: ${failedAudits.join(", ")}`);
}
if (audits.bubbleFrames?.frameCount < 37) throw new Error("V42 bubble frame coverage is incomplete.");
if (audits.transitions?.everyTransitionHasEncodedClearFrame !== true) {
  throw new Error("V42 encoded bubble transitions have not passed.");
}
if (manifest.production?.qualityHarness?.finalReport?.pass !== true) {
  throw new Error("Automatic final quality-harness gate did not pass inside renderEpisodeVideo.");
}

await copyFile(reviewVideoPath, finalVideoPath);
await execFile("ffmpeg", ["-v", "error", "-xerror", "-i", finalVideoPath, "-f", "null", "-"], {
  maxBuffer: 16 * 1024 * 1024,
});
const { stdout: probeOutput } = await execFile("ffprobe", [
  "-v", "error", "-show_entries", "format=duration,size,bit_rate",
  "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels",
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
) throw new Error(`Unexpected V42 streams: ${JSON.stringify(probe.streams)}`);

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
  version: "v42-integrated-final-r1",
  pass: true,
  fixes: [
    "37-balloon recent-two placement diversity and camera-swept active-speaker exclusion, including cut-05",
    "cut-05 and cut-10 audible-gap correction using silent padding only; approved WAV PCM retained",
    "two-pass peak-safe constant-gain master normalization",
    "plain narration provider input synchronized across ElevenLabs source metadata, sidecar, and manifest",
    "shared Codex app-server production bridge with adaptive generation pool and bounded benchmark watchdog",
    "automatic fail-closed planning/final quality harness and atomic render lock",
  ],
  finalVideo,
  auditPaths,
  auditSummary: {
    utterances: audits.masterAssembly.utteranceCount,
    minimumWaveformSimilarity: audits.masterAssembly.minimumOverallSimilarity,
    speechOnsetGainSpreadRatio: audits.masterAssembly.speechOnsetGainSpreadRatio,
    audibleGapFailures: audits.masterAssembly.audibleGaps.filter((entry) => !entry.pass).length,
    bubbleEvents: audits.sequence.eventCount,
    nearRepeatFailures: Object.values(audits.sequence.failures || {}).flat().length,
    independentFaceFrames: audits.independentFaces.rows?.length,
    typographyEntries: audits.typography.rows?.length,
    bubbleMidpointFrames: audits.bubbleFrames.frameCount,
    transitionCount: audits.transitions.transitionCount,
    cameraGateCount: audits.camera.gates?.length,
    spotlightSamples: audits.spotlight.rows?.reduce((sum, row) => sum + (row.samples?.length || 0), 0),
    sttUtterances: audits.stt.rows?.length,
  },
  fullDecodePassed: true,
  automaticQualityHarnessPassed: true,
  manualInspection: audits.manualInspection,
  knownRemainingIssues: [],
  createdAt,
};

manifest.status = "final-v42-integrated-r1";
manifest.video = {
  ...(manifest.video || {}),
  fileName: finalVideo.fileName,
  statusAfterRender: manifest.status,
  masterNormalizationMode: "two-pass-peak-safe-constant-gain",
};
manifest.outputs = { ...(manifest.outputs || {}), finalVideo };
manifest.production = {
  ...(manifest.production || {}),
  version: "v42-integrated-r1",
  finalEvidence: { version: evidence.version, filePath: evidencePath, pass: true },
};
manifest.metrics = {
  ...(manifest.metrics || {}),
  videoDurationSeconds: finalVideo.durationSeconds,
  finalSizeBytes: finalVideo.sizeBytes,
};
manifest.updatedAt = createdAt;
await Promise.all([
  writeJsonAtomic(manifestPath, manifest),
  writeJsonAtomic(evidencePath, evidence),
]);
process.stdout.write(`${JSON.stringify({ finalVideo, evidencePath, auditSummary: evidence.auditSummary }, null, 2)}\n`);
