#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas/manga-videos/manga-photo-homecoming-001");
const manifestPath = join(episodeDir, "episode-manifest.json");
const bubbleAuditPath = join(episodeDir, "v24-bubble-master-audit.json");
const frameAuditPath = join(episodeDir, "v24-bubble-frame-audit/bubble-frame-audit.json");
const transitionAuditPath = join(episodeDir, "v24-bubble-transition-audit/bubble-transition-audit.json");
const qualityAuditPath = join(episodeDir, "v24-video-quality-audit.json");
const evidencePath = join(episodeDir, "v24-final-evidence.json");
const reviewVideoPath = join(projectDir, "canvas/assets/videos/manga-photo-homecoming-001-review.mp4");
const approvedSourceVideoPath = join(projectDir, "canvas/assets/videos/manga-photo-homecoming-001-v23-semantic-camera-r1.mp4");
const finalVideoPath = join(projectDir, "canvas/assets/videos/manga-photo-homecoming-001-v24-exclusive-bubbles-r1.mp4");

const [manifestText, bubbleAuditText, frameAuditText, transitionAuditText, qualityAuditText] = await Promise.all([
  readFile(manifestPath, "utf8"),
  readFile(bubbleAuditPath, "utf8"),
  readFile(frameAuditPath, "utf8"),
  readFile(transitionAuditPath, "utf8"),
  readFile(qualityAuditPath, "utf8"),
]);
const manifest = JSON.parse(manifestText);
const bubbleAudit = JSON.parse(bubbleAuditText);
const frameAudit = JSON.parse(frameAuditText);
const transitionAudit = JSON.parse(transitionAuditText);
const qualityAudit = JSON.parse(qualityAuditText);

const requiredZeroGates = [
  "simultaneousOverlapCount",
  "shotBoundaryBleedCount",
  "terminalFullStopCount",
  "invalidColumnCount",
  "overflowCount",
  "textLossCount",
  "tooSmallCount",
  "activeFaceCollisionCount",
  "importantPropCollisionCount",
];
for (const gate of requiredZeroGates) {
  if (bubbleAudit[gate] !== 0) throw new Error(`V24 bubble gate ${gate}=${bubbleAudit[gate]}`);
}
if (
  bubbleAudit.utteranceCount !== 29
  || bubbleAudit.renderedBubbleAssetCount !== 35
  || bubbleAudit.cameraHashPreserved !== true
  || bubbleAudit.audioMetadataHashPreserved !== true
) throw new Error("V24 bubble audit is incomplete or changed locked camera/audio metadata");
if (frameAudit.frameCount !== 35) throw new Error(`Expected 35 reviewed bubble frames, found ${frameAudit.frameCount}`);
if (
  transitionAudit.intervalCount !== 35
  || transitionAudit.transitionCount !== 34
  || transitionAudit.imageBoundaryTransitionCount !== 9
  || transitionAudit.transitionFailureCount !== 0
  || transitionAudit.everyTransitionHasEncodedClearFrame !== true
) throw new Error("V24 encoded transition audit failed");
if (!qualityAudit.pass || Object.values(qualityAudit.gates || {}).some((value) => value !== true)) {
  throw new Error("V24 general video quality audit failed");
}

const usedOverlayPaths = [...new Set(manifest.utterances.flatMap((utterance) => (
  Array.isArray(utterance.bubbleSegments) && utterance.bubbleSegments.length > 0
    ? utterance.bubbleSegments.map((segment) => segment.overlayPath)
    : [utterance.overlayPath]
)))];
if (usedOverlayPaths.length !== 35) throw new Error(`Expected 35 used SVG overlays, found ${usedOverlayPaths.length}`);
let punctuationGlyphCount = 0;
for (const overlayPath of usedOverlayPaths) {
  const svg = await readFile(overlayPath, "utf8");
  const weights = [...svg.matchAll(/font-weight="([^"]+)"/gu)].map((match) => match[1]);
  const displayText = svg.match(/data-text="([^"]*)"/u)?.[1] || "";
  if (!svg.includes('data-layout="explicit-vertical-glyph"')) throw new Error(`Missing explicit vertical layout: ${overlayPath}`);
  if (!svg.includes("font-synthesis:none") || !svg.includes('xml:lang="ja"')) {
    throw new Error(`Missing Japanese deterministic font controls: ${overlayPath}`);
  }
  if (weights.length === 0 || weights.some((weight) => weight !== "500")) {
    throw new Error(`Non-500 or missing font weight: ${overlayPath}`);
  }
  if (/[。．]$/u.test(displayText)) throw new Error(`Terminal full stop remains in ${overlayPath}`);
  punctuationGlyphCount += [...svg.matchAll(/data-glyph-kind="punctuation"/gu)].length;
}

await copyFile(reviewVideoPath, finalVideoPath);
const { stdout: probeStdout } = await execFile("ffprobe", [
  "-v", "error",
  "-show_entries", "format=duration,size",
  "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels",
  "-of", "json",
  finalVideoPath,
]);
const probe = JSON.parse(probeStdout);
const videoStream = probe.streams.find((stream) => stream.codec_type === "video");
const audioStream = probe.streams.find((stream) => stream.codec_type === "audio");
if (!videoStream || !audioStream) throw new Error("V24 final must contain video and audio streams");
if (videoStream.width !== 1920 || videoStream.height !== 1080 || videoStream.r_frame_rate !== "30/1") {
  throw new Error(`Unexpected V24 video stream: ${JSON.stringify(videoStream)}`);
}
if (audioStream.sample_rate !== "48000" || audioStream.channels !== 2) {
  throw new Error(`Unexpected V24 audio stream: ${JSON.stringify(audioStream)}`);
}
await execFile("ffmpeg", [
  "-v", "error", "-xerror", "-i", finalVideoPath,
  "-map", "0:v:0", "-f", "null", "-",
], { maxBuffer: 8 * 1024 * 1024 });
const { stderr: blackDetectOutput } = await execFile("ffmpeg", [
  "-hide_banner", "-nostats", "-i", finalVideoPath,
  "-vf", "blackdetect=d=0.1:pix_th=0.02", "-an", "-f", "null", "-",
], { maxBuffer: 8 * 1024 * 1024 });
const blackFrameEventCount = [...blackDetectOutput.matchAll(/black_start:/gu)].length;
if (blackFrameEventCount !== 0) throw new Error(`Detected ${blackFrameEventCount} black-frame event(s)`);

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
  throw new Error(`V24 changed approved audio PCM: ${approvedAudioPcmMd5} != ${finalAudioPcmMd5}`);
}

const [videoBytes, fileStats] = await Promise.all([readFile(finalVideoPath), stat(finalVideoPath)]);
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
const typographyQa = {
  usedOverlayCount: usedOverlayPaths.length,
  explicitVerticalLayoutCount: usedOverlayPaths.length,
  fixedFontWeight: 500,
  syntheticBold: false,
  terminalFullStopCount: 0,
  punctuationGlyphCount,
  semanticColumnFailureCount: 0,
};
const transitionQa = {
  intervalCount: transitionAudit.intervalCount,
  transitionCount: transitionAudit.transitionCount,
  imageBoundaryTransitionCount: transitionAudit.imageBoundaryTransitionCount,
  simultaneousOverlapCount: bubbleAudit.simultaneousOverlapCount,
  shotBoundaryBleedCount: bubbleAudit.shotBoundaryBleedCount,
  encodedClearFrameFailureCount: transitionAudit.transitionFailureCount,
  everyTransitionHasEncodedClearFrame: transitionAudit.everyTransitionHasEncodedClearFrame,
};
const audioPreservationQa = {
  approvedSourceVersion: "v23-semantic-camera-r1",
  approvedAudioPcmMd5,
  finalAudioPcmMd5,
  pcmIdentical: true,
};
manifest.status = "final-v24-exclusive-bubbles-r1";
manifest.video = {
  ...(manifest.video || {}),
  fileName: finalVideo.fileName,
  statusAfterRender: manifest.status,
};
manifest.outputs = { ...(manifest.outputs || {}), finalVideo };
manifest.production = {
  ...(manifest.production || {}),
  version: "v24-exclusive-bubbles-r1",
  bubbleTypographyQa: typographyQa,
  bubbleTransitionQa: transitionQa,
  videoQa: {
    pass: true,
    fullDecodePassed: true,
    blackFrameEventCount,
    integratedLufs: qualityAudit.loudness.integratedLufs,
    truePeakDbfs: qualityAudit.loudness.truePeakDbfs,
  },
  audioPreservationQa,
};
manifest.updatedAt = createdAt;

const evidence = {
  version: "v24-exclusive-bubbles-r1",
  referenceVideoIds: ["awAbZyTeE4g", "2ycRncs4CKY"],
  finalVideo,
  bubbleMasterQa: Object.fromEntries(requiredZeroGates.map((gate) => [gate, bubbleAudit[gate]])),
  typographyQa,
  transitionQa,
  audioPreservationQa,
  videoQa: manifest.production.videoQa,
  artifacts: {
    bubbleMasterAuditPath: bubbleAuditPath,
    bubbleFrameAuditPath: frameAuditPath,
    bubbleFrameContactPath: join(episodeDir, "v24-bubble-frame-audit/contact-35.jpg"),
    transitionAuditPath,
    allTransitionContactPath: join(episodeDir, "v24-bubble-transition-audit/contact-all-transitions-ordered.jpg"),
    imageBoundaryContactPath: join(episodeDir, "v24-bubble-transition-audit/contact-image-boundaries-ordered.jpg"),
    videoQualityAuditPath: qualityAuditPath,
  },
  createdAt,
};
await Promise.all([
  writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8"),
]);
process.stdout.write(`${JSON.stringify({
  manifestPath,
  evidencePath,
  finalVideo,
  bubbleMasterQa: evidence.bubbleMasterQa,
  typographyQa,
  transitionQa,
  audioPreservationQa,
  videoQa: evidence.videoQa,
}, null, 2)}\n`);
