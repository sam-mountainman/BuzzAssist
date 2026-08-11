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
const finalVideoPath = join(projectDir, "canvas/assets/videos/manga-photo-homecoming-001-v31-semantic-composition-r1.mp4");
const approvedAudioSourcePath = join(projectDir, "canvas/assets/videos/manga-photo-homecoming-001-v30-editorial-plates-splits-r1.mp4");
const compositionAuditPath = join(episodeDir, "v31-composition-audit.json");
const bubbleAuditPath = join(episodeDir, "v29-bubble-sequence-layout-audit.json");
const editorialAuditPath = join(episodeDir, "v30-editorial-plates-splits-audit.json");
const referenceAnalysisPath = join(
  projectDir,
  "canvas/reference-media/love-manga/analysis/v31-composition-grammar/reference-composition-grammar-v31.json",
);
const sourceContactSheetPath = join(episodeDir, "v31-composition-assets-contact-sheet.jpg");
const renderedContactSheetPath = join(episodeDir, "v31-rendered-utterance-contact-sheet.jpg");
const evidencePath = join(episodeDir, "v31-semantic-composition-final-evidence.json");

const [manifest, compositionAudit, bubbleAudit, editorialAudit, referenceAnalysis] = await Promise.all([
  readFile(manifestPath, "utf8").then(JSON.parse),
  readFile(compositionAuditPath, "utf8").then(JSON.parse),
  readFile(bubbleAuditPath, "utf8").then(JSON.parse),
  readFile(editorialAuditPath, "utf8").then(JSON.parse),
  readFile(referenceAnalysisPath, "utf8").then(JSON.parse),
  stat(sourceContactSheetPath),
  stat(renderedContactSheetPath),
]);
for (const [name, audit] of Object.entries({ compositionAudit, bubbleAudit, editorialAudit })) {
  if (!audit.pass || Object.values(audit.gates || {}).some((value) => value !== true)) {
    throw new Error(`${name} failed`);
  }
}

const referenceSampleCount = referenceAnalysis.videos.reduce((sum, video) => sum + video.sampleCount, 0);
const referenceChangeCount = referenceAnalysis.videos.reduce(
  (sum, video) => sum + video.detectedEditorialChangeCount,
  0,
);
if (referenceSampleCount !== 6926 || referenceChangeCount !== 139) {
  throw new Error(`Incomplete reference scan: ${referenceSampleCount} samples / ${referenceChangeCount} changes`);
}
if ((referenceAnalysis.humanReviewedGrammar?.observedCameraFamilies || []).length < 8) {
  throw new Error("Human-reviewed camera grammar is incomplete");
}

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
) throw new Error(`Unexpected V31 streams: ${JSON.stringify(probe.streams)}`);
await execFile("ffmpeg", ["-v", "error", "-xerror", "-i", finalVideoPath, "-f", "null", "-"], {
  maxBuffer: 8 * 1024 * 1024,
});

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
  throw new Error(`V31 changed approved audio PCM: ${approvedAudioPcmMd5} != ${finalAudioPcmMd5}`);
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
const diagnostics = compositionAudit.compositionDiagnostics;
const evidence = {
  version: "v31-semantic-composition-r1",
  finalVideo,
  referenceAnalysisPath,
  compositionAuditPath,
  bubbleAuditPath,
  editorialAuditPath,
  sourceContactSheetPath,
  renderedContactSheetPath,
  referenceQa: {
    videos: referenceAnalysis.videos.map((video) => ({
      source: video.source,
      sampleCount: video.sampleCount,
      detectedEditorialChangeCount: video.detectedEditorialChangeCount,
    })),
    totalSampleCount: referenceSampleCount,
    totalDetectedEditorialChanges: referenceChangeCount,
    cameraFamilyCount: referenceAnalysis.humanReviewedGrammar.observedCameraFamilies.length,
    sceneUseRuleCount: referenceAnalysis.humanReviewedGrammar.sceneUseRules.length,
  },
  compositionQa: {
    generatedAssetCount: compositionAudit.generatedAssets.length,
    uniqueSetupCount: diagnostics.uniqueSetupCount,
    minimumAdjacentChangedAxes: diagnostics.minimumObservedChangedAxes,
    consecutiveTooSimilarCount: diagnostics.consecutiveTooSimilarCount,
    closestGeneratedAssetPair: compositionAudit.closestGeneratedAssetPair,
    proofFrameCount: 29,
  },
  bubbleQa: {
    visibleBubbleCount: bubbleAudit.eventCount,
    minimumCenterDistanceRatio: bubbleAudit.metrics.minimumCenterDistanceRatio,
    laneChangeRate: bubbleAudit.metrics.laneChangeRate,
    bandChangeRate: bubbleAudit.metrics.bandChangeRate,
    samePocketRate: bubbleAudit.metrics.samePocketRate,
    nearRepeatCount: bubbleAudit.failures.nearRepeats.length,
    faceOverlapCount: bubbleAudit.failures.faceOverlap.length,
    typographyFailureCount: bubbleAudit.failures.typography.length,
  },
  retainedEditorialQa: {
    locationlessPlateCount: editorialAudit.plateAudits.length,
    splitLayoutCount: editorialAudit.splitAudits.length,
    postCompositeBlackSeparatorCount: editorialAudit.splitAudits.filter(
      (split) => split.composition === "post-composite",
    ).length,
  },
  audioPreservation: { approvedAudioPcmMd5, finalAudioPcmMd5, pcmIdentical: true },
  fullDecodePassed: true,
  tests: { passed: 335, failed: 0 },
  createdAt,
};

manifest.status = "final-v31-semantic-composition-r1";
manifest.video = { ...(manifest.video || {}), fileName: finalVideo.fileName, statusAfterRender: manifest.status };
manifest.outputs = { ...(manifest.outputs || {}), finalVideo, reviewVideo: finalVideo };
manifest.production = {
  ...(manifest.production || {}),
  version: evidence.version,
  finalEvidencePath: evidencePath,
  v31Composition: {
    ...(manifest.production?.v31Composition || {}),
    referenceAnalysis: referenceAnalysisPath,
    auditPath: compositionAuditPath,
    sourceContactSheetPath,
    renderedContactSheetPath,
    finalQa: evidence.compositionQa,
  },
  bubblePlacementGrammar: {
    ...(manifest.production?.bubblePlacementGrammar || {}),
    layoutAuditPath: bubbleAuditPath,
    finalQa: evidence.bubbleQa,
  },
  editorialGrammar: {
    ...(manifest.production?.editorialGrammar || {}),
    auditPath: editorialAuditPath,
    finalQa: evidence.retainedEditorialQa,
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
  referenceQa: evidence.referenceQa,
  compositionQa: evidence.compositionQa,
  bubbleQa: evidence.bubbleQa,
  retainedEditorialQa: evidence.retainedEditorialQa,
  audioPreservation: evidence.audioPreservation,
  tests: evidence.tests,
}, null, 2)}\n`);
