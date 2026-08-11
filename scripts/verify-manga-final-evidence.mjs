#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeCameraShotSequence } from "../lib/mangaVideoPipeline.mjs";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const episodeDir = path.join(projectDir, "canvas/manga-videos/manga-photo-homecoming-001");
const paths = {
  profile: path.join(projectDir, "canvas/channel-production-profiles.json"),
  manifest: path.join(episodeDir, "episode-manifest.json"),
  dag: path.join(episodeDir, "production-dag-v8.json"),
  modelDecision: path.join(episodeDir, "model-ab-decision-v8.json"),
  quality: path.join(episodeDir, "v11-final-r1-quality-report.json"),
  finalAnalysis: path.join(episodeDir, "v11-final-analysis/reference-video-measurements.json"),
  speechAudit: path.join(episodeDir, "speech-audit-v11-final-r2.json"),
  mastering: path.join(episodeDir, "v11-audio-mastering-report.json"),
  bubbleFrameAudit: path.join(episodeDir, "v11-bubble-frame-audit-final/bubble-frame-audit.json"),
  bubbleFrameContact: path.join(episodeDir, "v11-bubble-frame-audit-final/bubble-frame-contact-29.jpg"),
  output: path.join(episodeDir, "v11-final-evidence.json"),
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));
const exists = (filePath) => typeof filePath === "string" && fs.existsSync(filePath);
const rounded = (value, digits = 4) => Number(Number(value).toFixed(digits));
const inRange = (value, range) =>
  Number.isFinite(value) && value >= range.min - 1e-9 && value <= range.max + 1e-9;

const profile = readJson(paths.profile);
const manifest = readJson(paths.manifest);
const dag = readJson(paths.dag);
const modelDecision = readJson(paths.modelDecision);
const quality = readJson(paths.quality);
const finalAnalysis = readJson(paths.finalAnalysis);
const speechAudit = readJson(paths.speechAudit);
const mastering = readJson(paths.mastering);
const bubbleFrameAudit = readJson(paths.bubbleFrameAudit);

const checks = [];
function check(id, pass, evidence, expected = undefined) {
  checks.push({ id, pass: Boolean(pass), expected, evidence });
}

const expectedUrls = [
  "https://www.youtube.com/watch?v=awAbZyTeE4g",
  "https://www.youtube.com/watch?v=2ycRncs4CKY",
];
const exactVideos = profile.sources?.exactVideos ?? [];
const exactImages = profile.sources?.exactImages ?? [];
check(
  "reference.exact-videos",
  expectedUrls.every((url) => exactVideos.some((video) => video.url === url)) &&
    exactVideos.length === 2 &&
    exactVideos.reduce((sum, video) => sum + video.measuredFrames, 0) === 80,
  exactVideos.map(({ id, url, measuredFrames }) => ({ id, url, measuredFrames })),
  { urls: expectedUrls, measuredFrames: 80 },
);
check(
  "reference.exact-images",
  exactImages.length === 20 && exactImages.every(exists),
  { count: exactImages.length, existingCount: exactImages.filter(exists).length },
  { count: 20, existingCount: 20 },
);
check(
  "reference.profile-coverage",
  profile.imageProfile?.sampleCount === 20 &&
    profile.videoProfile?.measuredFrameCount === 80 &&
    profile.audioProfile?.referenceMixedTracks?.length === 2,
  {
    imageSamples: profile.imageProfile?.sampleCount,
    videoSamples: profile.videoProfile?.measuredFrameCount,
    audioSources: profile.audioProfile?.referenceMixedTracks?.length,
  },
  { imageSamples: 20, videoSamples: 80, audioSources: 2 },
);

const cuts = manifest.cuts ?? [];
const utterances = manifest.utterances ?? [];
const selectedCameraShots = cuts.flatMap((cut) =>
  (cut.cameraSequence ?? []).map((asset) => ({ cutId: cut.id, ...asset })),
);
const cameraInventory = cuts.flatMap((cut) =>
  (cut.cameraAssetInventory ?? []).map((asset) => ({ cutId: cut.id, ...asset })),
);
const selectedCameraPaths = selectedCameraShots.map((asset) => asset.imagePath);
const inventoryPaths = cameraInventory.map((asset) => asset.imagePath);
const normalizedShots = cuts.flatMap((cut) =>
  normalizeCameraShotSequence(cut, utterances, cut.timing?.durationSeconds).map((shot) => ({
    cutId: cut.id,
    ...shot,
  })),
);
const holdDurations = normalizedShots.map((shot) => shot.durationSeconds).sort((a, b) => a - b);
const meanHoldSeconds = holdDurations.reduce((sum, value) => sum + value, 0) / holdDurations.length;
const medianHoldSeconds = holdDurations[Math.floor(holdDurations.length / 2)];
check(
  "episode.structure",
  cuts.length === 10 && utterances.length === 29,
  { cuts: cuts.length, utterances: utterances.length },
  { cuts: 10, utterances: 29 },
);
check(
  "episode.camera-asset-inventory",
  cameraInventory.length === 70 &&
    new Set(cameraInventory.map((asset) => asset.id)).size === 70 &&
    new Set(inventoryPaths).size === 70 &&
    inventoryPaths.every(exists) &&
    cuts.every((cut) => cut.cameraAssetInventory?.length === 7) &&
    cuts.every((cut) => new Set(cut.cameraAssetInventory.map((asset) => asset.angle)).size === 7),
  {
    count: cameraInventory.length,
    uniqueIds: new Set(cameraInventory.map((asset) => asset.id)).size,
    uniquePaths: new Set(inventoryPaths).size,
    existingPaths: inventoryPaths.filter(exists).length,
    perCut: Object.fromEntries(cuts.map((cut) => [cut.id, cut.cameraAssetInventory?.length ?? 0])),
  },
  { count: 70, uniqueIds: 70, uniquePaths: 70, existingPaths: 70, perCut: 7 },
);
check(
  "episode.reference-paced-master-selection",
  manifest.editorialPlan?.version === "v9-reference-hold-cadence" &&
    manifest.editorialPlan?.alternateAssetCount === 70 &&
    manifest.editorialPlan?.selectedShotCount === 25 &&
    selectedCameraShots.length === 25 &&
    new Set(selectedCameraShots.map((asset) => asset.id)).size === 25 &&
    selectedCameraPaths.every(exists) &&
    selectedCameraShots.every((shot) =>
      cameraInventory.some((asset) => asset.cutId === shot.cutId && asset.imagePath === shot.imagePath),
    ) &&
    cameraInventory.filter((asset) => asset.selectedShotId).length === 25 &&
    cuts.every((cut) => cut.cameraSequence?.length >= 2 && cut.cameraSequence?.length <= 3) &&
    normalizedShots.length === 25 &&
    Math.min(...holdDurations) >= 2.79 &&
    meanHoldSeconds >= 5 &&
    meanHoldSeconds <= 7.2 &&
    profile.videoProfile?.assetPolicy?.selectedMasterShots === 25,
  {
    editorialPlan: manifest.editorialPlan,
    selectedShotCount: selectedCameraShots.length,
    existingSelectedPaths: selectedCameraPaths.filter(exists).length,
    inventorySelections: cameraInventory.filter((asset) => asset.selectedShotId).length,
    perCut: Object.fromEntries(cuts.map((cut) => [cut.id, cut.cameraSequence?.length ?? 0])),
    holds: {
      minSeconds: rounded(Math.min(...holdDurations), 3),
      medianSeconds: rounded(medianHoldSeconds, 3),
      meanSeconds: rounded(meanHoldSeconds, 3),
    },
  },
  { selectedShotCount: 25, perCut: "2-3", minHoldSeconds: 2.79, meanHoldSeconds: "5-7.2" },
);
check(
  "episode.image-model-route",
  cuts.every((cut) => cut.imageGeneration?.route === "gpt-image-2-codex") &&
    modelDecision.status === "gate-not-passed" &&
    modelDecision.grokAdopted === false &&
    modelDecision.evidence?.finalGrokBaseCutCount === 0,
  {
    gptImage2Cuts: cuts.filter((cut) => cut.imageGeneration?.route === "gpt-image-2-codex").length,
    grokCuts: cuts.filter((cut) => cut.imageGeneration?.route?.includes("grok")).length,
    decision: modelDecision.decision,
    gateStatus: modelDecision.status,
  },
  { gptImage2Cuts: 10, grokCuts: 0, gateStatus: "gate-not-passed" },
);

const overlayRecords = utterances.map((utterance) => {
  const spec = exists(utterance.overlaySpecPath) ? readJson(utterance.overlaySpecPath) : null;
  const qualities = spec?.quality ?? [];
  const svg = exists(utterance.overlayPath) ? fs.readFileSync(utterance.overlayPath, "utf8") : "";
  return {
    id: utterance.id,
    specExists: Boolean(spec),
    svgExists: Boolean(svg),
    explicitGlyphLayout: svg.includes('data-layout="explicit-vertical-glyph"'),
    cameraShotId: spec?.cameraShotId,
    version: spec?.version,
    speakerFaceRegionCount: (spec?.avoidRegions ?? []).filter((region) => region.kind === "face").length,
    listenerRegionCount: (spec?.avoidRegions ?? []).filter((region) => region.kind === "listener").length,
    qualities,
  };
});
const qualityRows = overlayRecords.flatMap((record) => record.qualities);
check(
  "bubbles.japanese-layout-gates",
  overlayRecords.length === 29 &&
    overlayRecords.every((record) =>
      record.specExists &&
      record.svgExists &&
      record.explicitGlyphLayout &&
      record.version === "v10-reference-safe" &&
      record.cameraShotId &&
      record.speakerFaceRegionCount >= 1
    ) &&
    qualityRows.length === 29 &&
    qualityRows.every(
      (row) =>
        row.textLoss === false &&
        row.overflow === false &&
        row.tooSmall === false &&
        row.columns >= 1 &&
        row.columns <= 3 &&
        row.faceOverlapRatio === 0 &&
        row.importantOverlapRatio === 0,
    ),
  {
    overlayCount: overlayRecords.length,
    explicitGlyphLayoutCount: overlayRecords.filter((record) => record.explicitGlyphLayout).length,
    cameraBoundOverlayCount: overlayRecords.filter((record) => record.cameraShotId).length,
    speakerAnnotatedOverlayCount: overlayRecords.filter((record) => record.speakerFaceRegionCount >= 1).length,
    listenerAnnotatedOverlayCount: overlayRecords.filter((record) => record.listenerRegionCount >= 1).length,
    qualityRowCount: qualityRows.length,
    textLossCount: qualityRows.filter((row) => row.textLoss).length,
    overflowCount: qualityRows.filter((row) => row.overflow).length,
    tooSmallCount: qualityRows.filter((row) => row.tooSmall).length,
    maxColumns: Math.max(...qualityRows.map((row) => row.columns)),
    faceOverlapCount: qualityRows.filter((row) => row.faceOverlapRatio > 0).length,
    importantOverlapCount: qualityRows.filter((row) => row.importantOverlapRatio > 0).length,
  },
  {
    overlayCount: 29,
    explicitGlyphLayoutCount: 29,
    cameraBoundOverlayCount: 29,
    speakerAnnotatedOverlayCount: 29,
    textLossCount: 0,
    overflowCount: 0,
    tooSmallCount: 0,
    maxColumns: 3,
    faceOverlapCount: 0,
    importantOverlapCount: 0,
  },
);

check(
  "bubbles.reference-video-editorial-policy",
  manifest.production?.version === "v10-reference-safe" &&
    manifest.production?.bubblePolicy?.activeSpeakerFaceOverlapAllowed === false &&
    manifest.production?.bubblePolicy?.listenerOverlapAllowedWhenNeeded === true &&
    manifest.production?.bubblePolicy?.artificialBackgroundDarkening === false &&
    manifest.production?.cameraPolicy?.singleContinuousFrameRequired === true &&
    manifest.production?.cameraPolicy?.wideMeansSpatiallyWiderShotNotDigitalCrop === true,
  {
    bubblePolicy: manifest.production?.bubblePolicy,
    cameraPolicy: manifest.production?.cameraPolicy,
    dialogueEditorialPolicy: manifest.production?.dialogueEditorialPolicy,
  },
  {
    activeSpeakerFaceOverlapAllowed: false,
    listenerOverlapAllowedWhenNeeded: true,
    artificialBackgroundDarkening: false,
    singleContinuousFrameRequired: true,
    wideMeansSpatiallyWiderShotNotDigitalCrop: true,
  },
);

const thoughtCuts = cuts.filter((cut) => cut.thoughtFocus);
const thought = thoughtCuts[0]?.thoughtFocus;
const thoughtUtteranceId = utterances.find((utterance) => utterance.preset === "thought")?.id;
const thoughtCameraAssets = selectedCameraShots.filter((asset) => asset.utteranceIds?.includes(thoughtUtteranceId));
const thoughtPushes = thoughtCameraAssets.map((asset) =>
  rounded(((asset.camera.zoomEnd - asset.camera.zoomStart) / asset.camera.zoomStart) * 100),
);
check(
  "thought-focus.artificial-darkening-disabled",
  thoughtCuts.length === 1 &&
    thought?.enabled === false &&
    thought?.opacity === 0 &&
    thought?.faceBrightness === 0 &&
    manifest.production?.bubblePolicy?.artificialBackgroundDarkening === false &&
    thoughtPushes.length > 0 &&
    thoughtPushes.every((push) => push >= 2 && push <= 5),
  {
    cutId: thoughtCuts[0]?.id,
    enabled: thought?.enabled,
    surroundingOpacity: thought?.opacity,
    faceBrightness: thought?.faceBrightness,
    artificialBackgroundDarkening: manifest.production?.bubblePolicy?.artificialBackgroundDarkening,
    pushPercent: thoughtPushes,
  },
  { enabled: false, opacity: 0, faceBrightness: 0, artificialBackgroundDarkening: false, pushPercent: "2-5" },
);

const pauseRanges = manifest.audioQuality?.pauseRanges ?? profile.audioProfile?.pauseSeconds;
const pauseEvidence = [];
let pausesPass = true;
for (const cut of cuts) {
  const cutUtterances = cut.utteranceIds.map((id) => utterances.find((utterance) => utterance.id === id));
  cutUtterances.forEach((utterance, index) => {
    const gap = utterance.timing.gapBeforeSeconds;
    let pauseType = "cut-start";
    let pass = gap === 0;
    if (index > 0) {
      const previous = cutUtterances[index - 1];
      if (utterance.pauseClass === "emphasis") {
        pauseType = "emphasis";
        pass = inRange(gap, pauseRanges.emphasis);
      } else if (utterance.speakerId === previous.speakerId) {
        pauseType = "sameSpeaker";
        pass = inRange(gap, pauseRanges.sameSpeaker);
      } else {
        pauseType = "speakerSwitch";
        pass = inRange(gap, pauseRanges.speakerSwitch);
      }
    }
    pauseEvidence.push({ id: utterance.id, pauseType, seconds: gap, pass });
    pausesPass &&= pass;
  });
  const tail = cutUtterances.at(-1).timing.gapAfterSeconds;
  const tailPass = inRange(tail, pauseRanges.cutTail);
  pauseEvidence.push({ id: `${cut.id}:tail`, pauseType: "cutTail", seconds: tail, pass: tailPass });
  pausesPass &&= tailPass;
}
check(
  "audio.pause-rules",
  pausesPass,
  {
    ranges: pauseRanges,
    observedByType: Object.fromEntries(
      ["cut-start", "sameSpeaker", "speakerSwitch", "emphasis", "cutTail"].map((type) => [
        type,
        [...new Set(pauseEvidence.filter((row) => row.pauseType === type).map((row) => row.seconds))].sort(),
      ]),
    ),
    failures: pauseEvidence.filter((row) => !row.pass),
  },
  { failures: [] },
);

const actualVoices = new Map();
for (const utterance of utterances) {
  const identity = `${utterance.model}|${utterance.voiceId}|${utterance.voiceName}`;
  if (!actualVoices.has(utterance.speakerId)) actualVoices.set(utterance.speakerId, new Set());
  actualVoices.get(utterance.speakerId).add(identity);
}
check(
  "audio.stable-voices",
  actualVoices.size === 4 &&
    [...actualVoices.values()].every((identities) => identities.size === 1) &&
    utterances.every((utterance) => exists(utterance.audio?.filePath)),
  {
    profiles: [...actualVoices.entries()].map(([speakerId, identities]) => ({ speakerId, identities: [...identities] })),
    mappedUtterances: utterances.filter((utterance) => actualVoices.has(utterance.speakerId)).length,
    existingAudioFiles: utterances.filter((utterance) => exists(utterance.audio?.filePath)).length,
  },
  { profiles: 4, mappedUtterances: 29, existingAudioFiles: 29 },
);
check(
  "audio.reading-and-boundary-audits",
  speechAudit.utteranceCount === 29 &&
    speechAudit.passedCount === 29 &&
    speechAudit.flaggedCount === 0 &&
    mastering.utteranceCount === 29 &&
    mastering.passedCount === 29 &&
    mastering.failedCount === 0 &&
    mastering.pass === true &&
    mastering.loudnessSpreadLu <= 2.5 &&
    mastering.maximumBoundaryPeak <= 0.001,
  {
    speech: {
      utteranceCount: speechAudit.utteranceCount,
      passedCount: speechAudit.passedCount,
      flaggedCount: speechAudit.flaggedCount,
    },
    mastering: {
      utteranceCount: mastering.utteranceCount,
      passedCount: mastering.passedCount,
      failedCount: mastering.failedCount,
      loudnessSpreadLu: mastering.loudnessSpreadLu,
      maximumBoundaryPeak: mastering.maximumBoundaryPeak,
    },
  },
  { speechPassed: "29/29", masteringPassed: "29/29", loudnessSpreadLu: "<=2.5", maximumBoundaryPeak: "<=0.001" },
);
check(
  "audio.master-and-ducking",
  profile.audioProfile?.bgm?.dialogueDuckDb?.min === 8 &&
    profile.audioProfile?.bgm?.dialogueDuckDb?.max === 12 &&
    quality.pass === true &&
    quality.gates?.integratedLoudness === true &&
    quality.gates?.truePeak === true,
  {
    dialogueDuckDb: profile.audioProfile?.bgm?.dialogueDuckDb,
    measuredFinal: quality.loudness,
    noLongSilence: quality.gates?.longSilence,
  },
  { dialogueDuckDb: "8-12", qualityPass: true },
);

const kindCounts = Object.fromEntries(
  [...new Set(dag.nodes.map((node) => node.kind))].map((kind) => [
    kind,
    dag.nodes.filter((node) => node.kind === kind).length,
  ]),
);
const expectedPools = { planning: 8, image: 10, tts: 4, svg: 8, render: 4, audit: 6 };
check(
  "dag.bounded-concurrent-graph",
  dag.nodes.length === 240 &&
    JSON.stringify(dag.pools) === JSON.stringify(expectedPools) &&
    dag.nodes.every((node) => node.id && /^[a-f0-9]{64}$/.test(node.inputHash)) &&
    new Set(dag.nodes.map((node) => node.id)).size === dag.nodes.length &&
    kindCounts["character-candidate"] === 9 &&
    kindCounts["identity-sheet"] === 6 &&
    kindCounts["base-image"] === 10 &&
    kindCounts.tts === 29 &&
    kindCounts["bubble-prelayout"] === 29 &&
    kindCounts["camera-asset"] === 70 &&
    kindCounts["bubble-final"] === 29 &&
    kindCounts["render-cut"] === 10 &&
    dag.paths?.preview?.waitsForCameraAssets === false &&
    dag.paths?.final?.cameraAssetCount === 70,
  {
    nodeCount: dag.nodes.length,
    uniqueNodeIds: new Set(dag.nodes.map((node) => node.id)).size,
    hashedNodes: dag.nodes.filter((node) => /^[a-f0-9]{64}$/.test(node.inputHash)).length,
    pools: dag.pools,
    kindCounts,
    paths: dag.paths,
  },
  { nodeCount: 240, pools: expectedPools, previewWaitsForCameraAssets: false, finalCameraAssetCount: 70 },
);

const finalVideoPath = quality.videoPath;
const finalBytes = exists(finalVideoPath) ? fs.readFileSync(finalVideoPath) : null;
const finalSha256 = finalBytes ? crypto.createHash("sha256").update(finalBytes).digest("hex") : null;
const analysisReport = finalAnalysis.reports?.[0];
check(
  "final.media-quality",
  quality.pass === true &&
    exists(finalVideoPath) &&
    manifest.outputs?.reviewVideo?.filePath === finalVideoPath &&
    quality.media?.video?.codec_name === "h264" &&
    quality.media?.video?.width === 1920 &&
    quality.media?.video?.height === 1080 &&
    quality.media?.video?.r_frame_rate === "30/1" &&
    quality.media?.audio?.codec_name === "aac" &&
    quality.media?.audio?.sample_rate === "48000" &&
    quality.media?.audio?.channels === 2 &&
    analysisReport?.sampleCount === 70 &&
    exists(analysisReport?.contactSheetPath) &&
    bubbleFrameAudit.frameCount === 29 &&
    exists(paths.bubbleFrameContact),
  {
    path: finalVideoPath,
    sha256: finalSha256,
    bytes: quality.media?.sizeBytes,
    durationSeconds: quality.media?.durationSeconds,
    video: quality.media?.video,
    audio: quality.media?.audio,
    qualityPass: quality.pass,
    fullLengthSampleCount: analysisReport?.sampleCount,
    contactSheetPath: analysisReport?.contactSheetPath,
    bubbleFrameCount: bubbleFrameAudit.frameCount,
    bubbleFrameContactPath: paths.bubbleFrameContact,
  },
  { qualityPass: true, video: "H.264 1920x1080 30fps", audio: "AAC 48kHz stereo", fullLengthSampleCount: 70, bubbleFrameCount: 29 },
);

const failedChecks = checks.filter((item) => !item.pass);
const report = {
  version: 1,
  episodeId: manifest.id,
  generatedAt: new Date().toISOString(),
  pass: failedChecks.length === 0,
  finalVideo: {
    path: finalVideoPath,
    sha256: finalSha256,
    sizeBytes: quality.media?.sizeBytes,
    durationSeconds: quality.media?.durationSeconds,
  },
  summary: {
    checkCount: checks.length,
    passedCount: checks.length - failedChecks.length,
    failedCount: failedChecks.length,
    failedCheckIds: failedChecks.map((item) => item.id),
  },
  checks,
};

fs.writeFileSync(paths.output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath: paths.output, ...report.summary, pass: report.pass }, null, 2));
if (!report.pass) process.exitCode = 1;
