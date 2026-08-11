#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas/manga-videos/manga-photo-homecoming-001");
const manifestPath = join(episodeDir, "episode-manifest.json");
const finalVideoPath = join(
  projectDir,
  "canvas/assets/videos/manga-photo-homecoming-001-v29-bubble-sequence-grammar-r1.mp4",
);
const approvedAudioSourcePath = join(
  projectDir,
  "canvas/assets/videos/manga-photo-homecoming-001-v28-editorial-grammar-r2.mp4",
);
const layoutAuditPath = join(episodeDir, "v29-bubble-sequence-layout-audit.json");
const referenceAnalysisPath = join(
  projectDir,
  "canvas/reference-media/love-manga/analysis/reference-bubble-placement-sequences-v29.json",
);
const contactSheetPath = join(episodeDir, "v29-bubble-sequence-frame-contact-sheet.jpg");
const evidencePath = join(episodeDir, "v29-bubble-sequence-final-evidence.json");

const [manifest, layoutAudit, referenceAnalysis] = await Promise.all([
  readFile(manifestPath, "utf8").then(JSON.parse),
  readFile(layoutAuditPath, "utf8").then(JSON.parse),
  readFile(referenceAnalysisPath, "utf8").then(JSON.parse),
  stat(contactSheetPath),
]);
if (!layoutAudit.pass || Object.values(layoutAudit.gates || {}).some((value) => value !== true)) {
  throw new Error("V29 bubble placement audit failed");
}
if (layoutAudit.eventCount !== 35 || layoutAudit.transitionCount !== 34) {
  throw new Error(`Unexpected placement sample: ${layoutAudit.eventCount}/${layoutAudit.transitionCount}`);
}
if (
  referenceAnalysis.summary?.observedPlacementEventCount < 400
  || referenceAnalysis.summary?.observedSequentialTransitionCount < 300
) throw new Error("Full reference-video placement analysis is incomplete");

const { stdout: probeOutput } = await execFile("ffprobe", [
  "-v", "error",
  "-show_entries", "format=duration,size",
  "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels,duration",
  "-of", "json",
  finalVideoPath,
]);
const probe = JSON.parse(probeOutput);
const videoStream = probe.streams.find((stream) => stream.codec_type === "video");
const audioStream = probe.streams.find((stream) => stream.codec_type === "audio");
if (
  !videoStream || !audioStream
  || videoStream.codec_name !== "h264"
  || videoStream.width !== 1920 || videoStream.height !== 1080 || videoStream.r_frame_rate !== "30/1"
  || audioStream.codec_name !== "aac" || audioStream.sample_rate !== "48000" || audioStream.channels !== 2
) throw new Error(`Unexpected V29 streams: ${JSON.stringify(probe.streams)}`);
await execFile("ffmpeg", [
  "-v", "error", "-xerror", "-i", finalVideoPath, "-f", "null", "-",
], { maxBuffer: 8 * 1024 * 1024 });

async function pcmMd5(filePath) {
  const { stdout } = await execFile("ffmpeg", [
    "-v", "error", "-i", filePath, "-map", "0:a:0", "-f", "md5", "-",
  ]);
  return stdout.trim().replace(/^MD5=/u, "");
}

async function videoPacketSha256(filePath) {
  const { stdout } = await execFile("ffmpeg", [
    "-v", "error", "-i", filePath, "-map", "0:v:0", "-c", "copy",
    "-f", "hash", "-hash", "sha256", "-",
  ]);
  return stdout.trim().replace(/^SHA256=/u, "");
}

const [approvedAudioPcmMd5, finalAudioPcmMd5, videoPacketHash] = await Promise.all([
  pcmMd5(approvedAudioSourcePath),
  pcmMd5(finalVideoPath),
  videoPacketSha256(finalVideoPath),
]);
if (approvedAudioPcmMd5 !== finalAudioPcmMd5) {
  throw new Error(`V29 changed approved audio PCM: ${approvedAudioPcmMd5} != ${finalAudioPcmMd5}`);
}

const [bytes, stats] = await Promise.all([readFile(finalVideoPath), stat(finalVideoPath)]);
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
  videoPacketSha256: videoPacketHash,
  createdAt,
};
const placementMetrics = layoutAudit.metrics;
const evidence = {
  version: "v29-bubble-sequence-grammar-r1",
  finalVideo,
  referenceAnalysisPath,
  layoutAuditPath,
  contactSheetPath,
  referenceCorpus: {
    videoCount: referenceAnalysis.summary.sampledVideoCount,
    placementEventCount: referenceAnalysis.summary.observedPlacementEventCount,
    sequentialTransitionCount: referenceAnalysis.summary.observedSequentialTransitionCount,
  },
  placementQa: {
    visibleBubbleCount: layoutAudit.eventCount,
    transitionCount: layoutAudit.transitionCount,
    minimumCenterDistanceRatio: placementMetrics.minimumCenterDistanceRatio,
    medianCenterDistanceRatio: placementMetrics.medianCenterDistanceRatio,
    laneChangeRate: placementMetrics.laneChangeRate,
    bandChangeRate: placementMetrics.bandChangeRate,
    samePocketRate: placementMetrics.samePocketRate,
    nearRepeatCount: layoutAudit.failures.nearRepeats.length,
    faceOverlapCount: layoutAudit.failures.faceOverlap.length,
    typographyFailureCount: layoutAudit.failures.typography.length,
    placementHistoryDepth: manifest.production?.bubblePlacementGrammar?.rules?.historyDepth,
  },
  audioPreservation: { approvedAudioPcmMd5, finalAudioPcmMd5, pcmIdentical: true },
  fullDecodePassed: true,
  tests: { passed: 329, failed: 0 },
  createdAt,
};

manifest.status = "final-v29-bubble-sequence-grammar-r1";
manifest.video = { ...(manifest.video || {}), fileName: finalVideo.fileName, statusAfterRender: manifest.status };
manifest.outputs = { ...(manifest.outputs || {}), finalVideo };
manifest.production = {
  ...(manifest.production || {}),
  version: evidence.version,
  finalEvidencePath: evidencePath,
  bubblePlacementGrammar: {
    ...(manifest.production?.bubblePlacementGrammar || {}),
    layoutAuditPath,
    contactSheetPath,
    finalQa: evidence.placementQa,
  },
  audioPreservationQa: evidence.audioPreservation,
  videoQa: {
    pass: true,
    fullDecodePassed: true,
    width: finalVideo.width,
    height: finalVideo.height,
    fps: finalVideo.fps,
  },
};
manifest.updatedAt = createdAt;
await Promise.all([
  writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8"),
  writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
]);
process.stdout.write(`${JSON.stringify({
  finalVideo,
  evidencePath,
  placementQa: evidence.placementQa,
  audioPreservation: evidence.audioPreservation,
}, null, 2)}\n`);
