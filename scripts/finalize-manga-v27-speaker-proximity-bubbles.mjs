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
const bubbleAuditPath = join(episodeDir, "v27-camera-aware-bubble-audit.json");
const sweepAuditPath = join(episodeDir, "v27-speaker-proximity-sweep-audit-r2/bubble-camera-sweep-audit.json");
const transitionAuditPath = join(episodeDir, "v27-bubble-transition-audit-r2/bubble-transition-audit.json");
const qualityAuditPath = join(episodeDir, "v27-video-quality-audit-r2.json");
const evidencePath = join(episodeDir, "v27-speaker-proximity-final-evidence.json");
const reviewVideoPath = join(projectDir, "canvas/assets/videos/manga-photo-homecoming-001-review.mp4");
const approvedSourceVideoPath = join(projectDir, "canvas/assets/videos/manga-photo-homecoming-001-v26-continuous-linear-camera-r1.mp4");
const finalVideoPath = join(projectDir, "canvas/assets/videos/manga-photo-homecoming-001-v27-speaker-proximity-bubbles-r1.mp4");

const [manifest, bubbleAudit, sweepAudit, transitionAudit, qualityAudit] = await Promise.all([
  readFile(manifestPath, "utf8").then(JSON.parse),
  readFile(bubbleAuditPath, "utf8").then(JSON.parse),
  readFile(sweepAuditPath, "utf8").then(JSON.parse),
  readFile(transitionAuditPath, "utf8").then(JSON.parse),
  readFile(qualityAuditPath, "utf8").then(JSON.parse),
]);

const zeroGates = [
  "simultaneousOverlapCount",
  "shotBoundaryBleedCount",
  "terminalFullStopCount",
  "invalidColumnCount",
  "placementSideViolationCount",
  "regularWeightViolationCount",
  "dialogueShapeViolationCount",
  "narrationShapeViolationCount",
  "syntheticBoldViolationCount",
  "overflowCount",
  "textLossCount",
  "tooSmallCount",
  "activeFaceCollisionCount",
  "importantPropCollisionCount",
];
for (const gate of zeroGates) {
  if (bubbleAudit[gate] !== 0) throw new Error(`V27 bubble gate ${gate}=${bubbleAudit[gate]}`);
}
if (
  bubbleAudit.renderedBubbleAssetCount !== 35
  || bubbleAudit.speakerProximityDialogueAssetCount !== 20
  || !(bubbleAudit.speakerProximityMeanRatio < 0.30)
  || bubbleAudit.distinctPlacementAnchorCount < 15
  || bubbleAudit.cameraHashPreserved !== true
  || bubbleAudit.audioMetadataHashPreserved !== true
  || bubbleAudit.audioTimingHashPreserved !== true
) throw new Error("V27 speaker-proximity, variation, camera, or audio metadata gate failed");
if (sweepAudit.utteranceCount !== 16 || sweepAudit.frameCount !== 48) {
  throw new Error("V27 start/middle/end camera-sweep frame audit is incomplete");
}
if (
  transitionAudit.intervalCount !== 35
  || transitionAudit.transitionCount !== 34
  || transitionAudit.transitionFailureCount !== 0
  || transitionAudit.everyTransitionHasEncodedClearFrame !== true
) throw new Error("V27 encoded bubble-transition audit failed");
if (!qualityAudit.pass || Object.values(qualityAudit.gates || {}).some((value) => value !== true)) {
  throw new Error("V27 video quality audit failed");
}

const usedOverlayPaths = [...new Set(manifest.utterances.flatMap((utterance) => (
  Array.isArray(utterance.bubbleSegments) && utterance.bubbleSegments.length > 0
    ? utterance.bubbleSegments.map((segment) => segment.overlayPath)
    : [utterance.overlayPath]
)))];
if (usedOverlayPaths.length !== 35) throw new Error(`Expected 35 SVG overlays, found ${usedOverlayPaths.length}`);
for (const overlayPath of usedOverlayPaths) {
  const svg = await readFile(overlayPath, "utf8");
  const weights = [...svg.matchAll(/font-weight="(\d+)"/gu)].map((match) => Number(match[1]));
  if (weights.length === 0 || weights.some((weight) => weight !== 400)) {
    throw new Error(`Non-regular Japanese text in ${overlayPath}`);
  }
  if (!svg.includes("font-synthesis:none") || /font-weight="(?:[5-9]\d\d)"/u.test(svg)) {
    throw new Error(`Synthetic bold remains in ${overlayPath}`);
  }
}

// The bubble-only render may re-encode the otherwise unchanged AAC track. Keep
// the newly rendered video stream, but remux the approved V26 audio stream
// byte-for-byte so a bubble revision can never alter dialogue, pauses, or AAC
// encoder padding.
await execFile("ffmpeg", [
  "-v", "error", "-xerror", "-y",
  "-i", reviewVideoPath,
  "-i", approvedSourceVideoPath,
  "-map", "0:v:0",
  "-map", "1:a:0",
  "-c", "copy",
  "-map_metadata", "0",
  "-movflags", "+faststart",
  finalVideoPath,
], { maxBuffer: 8 * 1024 * 1024 });
const { stdout: probeOutput } = await execFile("ffprobe", [
  "-v", "error", "-show_entries", "format=duration,size",
  "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels",
  "-of", "json", finalVideoPath,
]);
const probe = JSON.parse(probeOutput);
const videoStream = probe.streams.find((stream) => stream.codec_type === "video");
const audioStream = probe.streams.find((stream) => stream.codec_type === "audio");
if (
  !videoStream || !audioStream
  || videoStream.width !== 1920 || videoStream.height !== 1080 || videoStream.r_frame_rate !== "30/1"
  || audioStream.sample_rate !== "48000" || audioStream.channels !== 2
) throw new Error(`Unexpected V27 media streams: ${JSON.stringify(probe.streams)}`);
await execFile("ffmpeg", [
  "-v", "error", "-xerror", "-i", finalVideoPath,
  "-map", "0:v:0", "-f", "null", "-",
], { maxBuffer: 8 * 1024 * 1024 });

async function pcmMd5(filePath) {
  const { stdout } = await execFile("ffmpeg", [
    "-v", "error", "-i", filePath, "-map", "0:a:0", "-f", "md5", "-",
  ]);
  return stdout.trim().replace(/^MD5=/u, "");
}
const [approvedAudioPcmMd5, finalAudioPcmMd5] = await Promise.all([
  pcmMd5(approvedSourceVideoPath),
  pcmMd5(finalVideoPath),
]);
if (approvedAudioPcmMd5 !== finalAudioPcmMd5) {
  throw new Error(`V27 changed approved V26 audio PCM: ${approvedAudioPcmMd5} != ${finalAudioPcmMd5}`);
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
  createdAt,
};
const evidence = {
  version: "v27-speaker-proximity-bubbles-r1",
  finalVideo,
  referenceAuditPath: join(episodeDir, "../../reference-media/love-manga/analysis/reference-bubble-speaker-proximity-audit.md"),
  bubbleAuditPath,
  sweepAuditPath,
  transitionAuditPath,
  qualityAuditPath,
  speakerProximity: {
    reviewedReferenceFrames: 8,
    dialogueAssetCount: bubbleAudit.speakerProximityDialogueAssetCount,
    meanDistanceRatio: bubbleAudit.speakerProximityMeanRatio,
    maximumDistanceRatio: bubbleAudit.speakerProximityMaxRatio,
    distinctPlacementAnchorCount: bubbleAudit.distinctPlacementAnchorCount,
    activeSpeakerFaceCollisionCount: bubbleAudit.activeFaceCollisionCount,
    sweepFramesReviewed: sweepAudit.frameCount,
    rule: "nearest clean active-speaker-adjacent outer or central pocket across the whole camera move",
  },
  transitions: {
    transitionCount: transitionAudit.transitionCount,
    failureCount: transitionAudit.transitionFailureCount,
    everyTransitionHasEncodedClearFrame: transitionAudit.everyTransitionHasEncodedClearFrame,
  },
  typography: { fontWeight: 400, syntheticBold: false, overlayCount: usedOverlayPaths.length },
  audioPreservation: { approvedAudioPcmMd5, finalAudioPcmMd5, pcmIdentical: true },
  qualityGates: qualityAudit.gates,
  createdAt,
};
manifest.status = "final-v27-speaker-proximity-bubbles-r1";
manifest.video = { ...(manifest.video || {}), fileName: finalVideo.fileName, statusAfterRender: manifest.status };
manifest.outputs = { ...(manifest.outputs || {}), finalVideo };
manifest.production = {
  ...(manifest.production || {}),
  version: "v27-speaker-proximity-bubbles-r1",
  finalEvidencePath: evidencePath,
};
manifest.production.bubbleTypographyQa = {
  ...(manifest.production.bubbleTypographyQa || {}),
  usedOverlayCount: usedOverlayPaths.length,
  explicitVerticalLayoutCount: usedOverlayPaths.length,
  fixedFontWeight: 400,
  syntheticBold: false,
  terminalFullStopCount: bubbleAudit.terminalFullStopCount,
  semanticColumnFailureCount: bubbleAudit.invalidColumnCount,
};
manifest.production.bubbleTransitionQa = {
  ...(manifest.production.bubbleTransitionQa || {}),
  intervalCount: transitionAudit.intervalCount,
  transitionCount: transitionAudit.transitionCount,
  simultaneousOverlapCount: bubbleAudit.simultaneousOverlapCount,
  shotBoundaryBleedCount: bubbleAudit.shotBoundaryBleedCount,
  encodedClearFrameFailureCount: transitionAudit.transitionFailureCount,
  everyTransitionHasEncodedClearFrame: transitionAudit.everyTransitionHasEncodedClearFrame,
};
manifest.production.audioPreservationQa = {
  approvedSourceVersion: "v26-continuous-linear-camera-r1",
  approvedAudioPcmMd5,
  finalAudioPcmMd5,
  pcmIdentical: true,
};
manifest.production.videoQa = {
  ...(manifest.production.videoQa || {}),
  pass: qualityAudit.pass,
  fullDecodePassed: true,
  integratedLufs: qualityAudit.loudness.integratedLufs,
  loudnessRangeLu: qualityAudit.loudness.loudnessRangeLu,
  truePeakDbfs: qualityAudit.loudness.truePeakDbfs,
};
manifest.updatedAt = createdAt;
await Promise.all([
  writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8"),
  writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
]);
process.stdout.write(`${JSON.stringify({ finalVideo, evidencePath, approvedAudioPcmMd5, finalAudioPcmMd5 }, null, 2)}\n`);
