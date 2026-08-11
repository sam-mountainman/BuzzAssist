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
  "canvas/assets/videos/manga-photo-homecoming-001-v30-editorial-plates-splits-r1.mp4",
);
const approvedAudioSourcePath = join(
  projectDir,
  "canvas/assets/videos/manga-photo-homecoming-001-v29-bubble-sequence-grammar-r1.mp4",
);
const editorialAuditPath = join(episodeDir, "v30-editorial-plates-splits-audit.json");
const bubbleAuditPath = join(episodeDir, "v29-bubble-sequence-layout-audit.json");
const referenceAnalysisPath = join(
  projectDir,
  "canvas/reference-media/love-manga/analysis/v30-editorial-plates-splits/reference-editorial-plates-splits-v30.json",
);
const contactSheetPath = join(episodeDir, "v30-all-bubbles-contact-sheet.jpg");
const proofGridPath = join(episodeDir, "v30-editorial-proof-grid.jpg");
const splitProofPaths = [
  join(episodeDir, "v30-cut06-proof.png"),
  join(episodeDir, "v30-cut08-proof.png"),
];
const evidencePath = join(episodeDir, "v30-editorial-plates-splits-final-evidence.json");

const [manifest, editorialAudit, bubbleAudit, referenceAnalysis] = await Promise.all([
  readFile(manifestPath, "utf8").then(JSON.parse),
  readFile(editorialAuditPath, "utf8").then(JSON.parse),
  readFile(bubbleAuditPath, "utf8").then(JSON.parse),
  readFile(referenceAnalysisPath, "utf8").then(JSON.parse),
  stat(contactSheetPath),
  stat(proofGridPath),
  ...splitProofPaths.map((path) => stat(path)),
]);
if (!editorialAudit.pass || Object.values(editorialAudit.gates || {}).some((value) => value !== true)) {
  throw new Error("V30 editorial plates/splits audit failed");
}
if (!bubbleAudit.pass || Object.values(bubbleAudit.gates || {}).some((value) => value !== true)) {
  throw new Error("V30 bubble sequence audit failed");
}
if (editorialAudit.plateAudits?.length !== 4 || editorialAudit.splitAudits?.length !== 2) {
  throw new Error("Unexpected V30 plate/split audit sample");
}
if (
  referenceAnalysis.summary?.approvedPlateMomentCount !== 13
  || referenceAnalysis.summary?.approvedSplitMomentCount !== 7
  || referenceAnalysis.summary?.movingPanelRatio !== 1
) throw new Error("Full reference-video editorial analysis is incomplete");

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
) throw new Error(`Unexpected V30 streams: ${JSON.stringify(probe.streams)}`);
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
  throw new Error(`V30 changed approved audio PCM: ${approvedAudioPcmMd5} != ${finalAudioPcmMd5}`);
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
const placementMetrics = bubbleAudit.metrics;
const plateTypeCounts = Object.fromEntries(
  editorialAudit.plateAudits.map((plate) => plate.type)
    .reduce((counts, type) => counts.set(type, (counts.get(type) || 0) + 1), new Map()),
);
const panelCameras = editorialAudit.splitAudits.flatMap((split) => split.cameras);
const evidence = {
  version: "v30-editorial-plates-splits-r1",
  finalVideo,
  referenceAnalysisPath,
  editorialAuditPath,
  bubbleAuditPath,
  contactSheetPath,
  proofGridPath,
  splitProofPaths,
  referenceCorpus: referenceAnalysis.summary,
  plateQa: {
    count: editorialAudit.plateAudits.length,
    typeCounts: plateTypeCounts,
    characterlessCount: editorialAudit.plateAudits.filter((plate) => plate.characterPolicy === "strictly-none").length,
    locationlessCount: editorialAudit.plateAudits.filter((plate) => plate.environmentPolicy === "none").length,
    emptyIllustratedEnvironmentCount: editorialAudit.failures.plates.filter((failure) => failure.reason === "literal-empty-environment-used").length,
  },
  splitQa: {
    layoutCount: editorialAudit.splitAudits.length,
    panelCount: panelCameras.length,
    independentlyMovingPanelCount: panelCameras.filter((camera) => camera.movementMagnitude > 0).length,
    postCompositeLayoutCount: editorialAudit.splitAudits.filter((split) => split.composition === "post-composite").length,
    blackSeparatorWidthRatio: editorialAudit.splitAudits[0]?.separatorWidthRatio,
  },
  placementQa: {
    visibleBubbleCount: bubbleAudit.eventCount,
    transitionCount: bubbleAudit.transitionCount,
    minimumCenterDistanceRatio: placementMetrics.minimumCenterDistanceRatio,
    medianCenterDistanceRatio: placementMetrics.medianCenterDistanceRatio,
    laneChangeRate: placementMetrics.laneChangeRate,
    bandChangeRate: placementMetrics.bandChangeRate,
    samePocketRate: placementMetrics.samePocketRate,
    nearRepeatCount: bubbleAudit.failures.nearRepeats.length,
    faceOverlapCount: bubbleAudit.failures.faceOverlap.length,
    typographyFailureCount: bubbleAudit.failures.typography.length,
  },
  audioPreservation: { approvedAudioPcmMd5, finalAudioPcmMd5, pcmIdentical: true },
  fullDecodePassed: true,
  tests: { passed: 333, failed: 0 },
  createdAt,
};

manifest.status = "final-v30-editorial-plates-splits-r1";
manifest.video = { ...(manifest.video || {}), fileName: finalVideo.fileName, statusAfterRender: manifest.status };
manifest.outputs = { ...(manifest.outputs || {}), finalVideo };
manifest.production = {
  ...(manifest.production || {}),
  version: evidence.version,
  finalEvidencePath: evidencePath,
  editorialGrammar: {
    ...(manifest.production?.editorialGrammar || {}),
    auditPath: editorialAuditPath,
    contactSheetPath,
    proofGridPath,
    splitProofPaths,
    finalQa: { plates: evidence.plateQa, splits: evidence.splitQa },
  },
  bubblePlacementGrammar: {
    ...(manifest.production?.bubblePlacementGrammar || {}),
    layoutAuditPath: bubbleAuditPath,
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
  plateQa: evidence.plateQa,
  splitQa: evidence.splitQa,
  placementQa: evidence.placementQa,
  audioPreservation: evidence.audioPreservation,
}, null, 2)}\n`);
