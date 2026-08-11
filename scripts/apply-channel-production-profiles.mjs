#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const projectDir = path.resolve(process.cwd());
const imageReportPath = path.join(
  projectDir,
  "canvas/reference-media/love-manga/image-analysis/reference-image-measurements.json",
);
const imageAnnotationsPath = path.join(
  projectDir,
  "canvas/reference-media/love-manga/image-analysis/reference-image-human-annotations.json",
);
const videoReportPath = path.join(
  projectDir,
  "canvas/reference-media/love-manga/analysis/reference-video-measurements.json",
);
const manifestPath = path.join(
  projectDir,
  "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json",
);
const finalQualityReportPath = path.join(
  projectDir,
  "canvas/manga-videos/manga-photo-homecoming-001/v9-final-r1-quality-report.json",
);
const outputPath = path.join(projectDir, "canvas/channel-production-profiles.json");

const readJson = async (filePath) => JSON.parse(await fs.readFile(filePath, "utf8"));

function quantile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function summarize(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return null;
  const round = (value) => Number(value.toFixed(5));
  return {
    count: finite.length,
    mean: round(finite.reduce((sum, value) => sum + value, 0) / finite.length),
    median: round(quantile(finite, 0.5)),
    p10: round(quantile(finite, 0.1)),
    p90: round(quantile(finite, 0.9)),
  };
}

const [imageReport, annotations, videoReport, manifest, qualityReport] = await Promise.all([
  readJson(imageReportPath),
  readJson(imageAnnotationsPath),
  readJson(videoReportPath),
  readJson(manifestPath),
  readJson(finalQualityReportPath),
]);

if (imageReport.images?.length !== 20 || annotations.images?.length !== 20) {
  throw new Error("The channel image profile requires exactly 20 measured and human-reviewed references.");
}
if (videoReport.sourceIds?.length !== 2 || videoReport.sampleCount !== 80) {
  throw new Error("The channel video profile requires the two exact sources and 80 measured frames.");
}

const acceptedThoughtReferences = annotations.images.filter(
  (image) => image.index >= 2 && image.index <= 10 && image.thoughtEffect,
);
const humanBubbles = annotations.images.flatMap((image) => image.bubbles ?? []);
const panelCounts = annotations.images.reduce((groups, image) => {
  const key = String(image.panelCount);
  groups[key] ??= [];
  groups[key].push(image);
  return groups;
}, {});
const voiceProfiles = Object.values(
  Object.fromEntries(
    manifest.utterances.map((utterance) => [
      utterance.voiceProfileId,
      {
        voiceProfileId: utterance.voiceProfileId,
        speakerId: utterance.speakerId,
        provider: utterance.audio?.provider,
        model: utterance.model,
        voiceId: utterance.voiceId,
        voiceName: utterance.voiceName,
        settings: utterance.voiceSettings,
      },
    ]),
  ),
);

const profile = {
  version: 1,
  generatedAt: new Date().toISOString(),
  id: "love-manga-reference-production-v9",
  sources: {
    exactVideos: videoReport.reports.map((report) => ({
      id: report.id,
      url: report.sourceUrl,
      durationSeconds: report.durationSeconds,
      measuredFrames: report.sampleCount,
    })),
    exactImages: imageReport.images.map((image) => image.filePath),
    measurementReports: {
      images: imageReportPath,
      imageHumanAnnotations: imageAnnotationsPath,
      videos: videoReportPath,
      finalMediaQuality: finalQualityReportPath,
    },
  },
  imageProfile: {
    sampleCount: imageReport.images.length,
    subjectOccupancy: {
      subjectHeightRatio: imageReport.aggregate.subjectHeightRatio,
      faceHeightRatio: imageReport.aggregate.faceHeightRatio,
      rule: "People lead the frame; widen only when the place, relationship, or evidence advances the story.",
    },
    characterBackgroundSeparation: {
      absoluteLumaDelta: imageReport.aggregate.characterBackgroundLumaDelta,
      rule: "Preserve readable subject/background value separation without crushing the environment.",
    },
    background: {
      storyPropCount: imageReport.aggregate.storyPropCount,
      requiredStoryPropsPerScene: { min: 2, max: 4 },
      edgeDensity: imageReport.aggregate.edgeDensity,
      quantizedColorCount: imageReport.aggregate.quantizedColorCount,
      meanSaturation: imageReport.aggregate.meanSaturation,
      rule: "Use location-specific props and leave intentional negative space for text.",
    },
    panels: {
      measuredHumanCounts: Object.fromEntries(
        Object.entries(panelCounts).map(([count, images]) => [count, images.length]),
      ),
      defaultMax: 2,
      threePanelAllowedFor: [
        "three-stage evidence",
        "simultaneous reaction",
        "time progression",
        "escalation",
      ],
      verticalThreePanel: "limited exception",
      strongEmotionalLine: "single full-bleed panel",
      fourOrMorePanels: "forbidden",
    },
    bubbles: {
      measuredHumanBubbleCount: humanBubbles.length,
      widthRatio: summarize(humanBubbles.map((bubble) => bubble.widthRatio)),
      heightRatio: summarize(humanBubbles.map((bubble) => bubble.heightRatio)),
      columns: summarize(humanBubbles.map((bubble) => bubble.columns)),
      fontHeightRatio: summarize(humanBubbles.map((bubble) => bubble.fontHeightRatio)),
      innerMarginXRatio: summarize(humanBubbles.map((bubble) => bubble.innerMarginXRatio)),
      innerMarginYRatio: summarize(humanBubbles.map((bubble) => bubble.innerMarginYRatio)),
      negativeSpaceRule: "Avoid faces, hands, named story props, and high-salience evidence.",
      japaneseGates: [
        "explicit vertical glyph positions survive SVG rasterization",
        "no text loss or overflow",
        "readable native-size font",
        "natural columns and punctuation",
        "speaker-tail direction remains unambiguous",
      ],
    },
    thoughtFocus: {
      acceptedReferenceIndices: acceptedThoughtReferences.map((image) => image.index),
      rejectedReferenceIndices: [1],
      surroundingDarknessOpacity: summarize(
        acceptedThoughtReferences.map((image) => image.thoughtEffect.surroundingDarknessOpacity),
      ),
      faceSpotWidthRatio: summarize(
        acceptedThoughtReferences.map((image) => image.thoughtEffect.faceSpotWidthRatio),
      ),
      faceSpotHeightRatio: summarize(
        acceptedThoughtReferences.map((image) => image.thoughtEffect.faceSpotHeightRatio),
      ),
      featherRatio: summarize(
        acceptedThoughtReferences.map((image) => image.thoughtEffect.featherRatio),
      ),
      faceBrightnessLift: { min: 0.06, max: 0.12, default: 0.1 },
      pushPercent: { min: 2, max: 5, default: 3 },
      rule: "Resolve the active speaker from per-speaker faceBounds; lightly darken surroundings, brighten the face, feather the spot, and use the reference thought bubble.",
    },
  },
  videoProfile: {
    sourceCount: videoReport.videoCount,
    measuredFrameCount: videoReport.sampleCount,
    visual: videoReport.visual,
    cameraMotion: videoReport.cameraMotion,
    editorialMotionDurationSeconds: { min: 2, max: 6 },
    humanShotMix: {
      environmentPercent: 32.5,
      mediumPercent: 40,
      closePercent: 27.5,
      evidence: "reference-video-human-audit.md, all 80 sampled frames",
    },
    assetPolicy: {
      fastPreviewCuts: 10,
      authoredCameraAssets: 70,
      authoredAssetsPerCut: 7,
      selectedMasterShots: manifest.editorialPlan?.selectedShotCount,
      selectedShotsPerCut: { min: 2, max: 3 },
      rule: "Preview is independently runnable. Keep all seven authored angles available per cut, but select only script-motivated views for the master; never cut to satisfy an asset quota.",
    },
    cadencePolicy: {
      version: manifest.editorialPlan?.version,
      referenceWeakChangeMeanHoldSeconds:
        manifest.editorialPlan?.referenceCadence?.weakChangeMeanHoldSeconds,
      rejectedMasterWeakChangeMeanHoldSeconds:
        manifest.editorialPlan?.referenceCadence?.currentR7WeakChangeMeanHoldSeconds,
      rule: manifest.editorialPlan?.policy,
    },
  },
  audioProfile: {
    referenceMixedTracks: videoReport.reports.map((report) => ({
      id: report.id,
      ...report.audio,
    })),
    pauseSeconds: {
      sameSpeaker: { min: 0.12, max: 0.22, default: 0.17 },
      speakerSwitch: { min: 0.22, max: 0.38, default: 0.3 },
      emphasis: { min: 0.4, max: 0.65, default: 0.5 },
      cutTail: { min: 0.25, max: 0.4, default: 0.32 },
      note: "Mixed-source silence measurements are a lower bound because BGM masks dialogue gaps.",
    },
    voices: voiceProfiles,
    bgm: {
      path: manifest.video.bgmPath,
      dialogueDuckDb: { min: 8, max: 12, target: 10 },
    },
    master: {
      targetIntegratedLufs: -14,
      targetLoudnessRangeLu: 7,
      targetTruePeakDbfs: -1.5,
      measuredFinal: qualityReport.loudness,
    },
  },
};

await fs.writeFile(outputPath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, imageSamples: 20, videoSamples: 80, voiceProfiles: voiceProfiles.length }, null, 2));
