#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";

const projectDir = resolve(process.cwd());
const profilePath = resolve(projectDir, "canvas/channel-visual-profiles.json");
const reportPath = resolve(
  projectDir,
  "canvas/reference-media/love-manga/analysis/reference-video-measurements.json",
);
const profileId = "manga-channel-reference-video-v1";
const sourceIds = ["awAbZyTeE4g", "2ycRncs4CKY"];
const establishingSamples = {
  awAbZyTeE4g: [1, 6, 7, 14, 15, 16, 18, 19, 20, 24, 25, 29, 30, 34, 37, 38, 40],
  "2ycRncs4CKY": [2, 15, 16, 18, 27, 32, 33, 35, 37],
};
const closeUpSamples = {
  awAbZyTeE4g: [2, 4, 9, 21, 23, 26, 27, 28, 31, 33, 35, 36],
  "2ycRncs4CKY": [1, 4, 9, 17, 20, 22, 24, 25, 28, 39],
};

function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const quantile = (ratio) => {
    const position = (sorted.length - 1) * ratio;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const value = sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
    return Number(value.toFixed(4));
  };
  return {
    count: sorted.length,
    mean: Number((sorted.reduce((total, value) => total + value, 0) / sorted.length).toFixed(4)),
    median: quantile(0.5),
    p10: quantile(0.1),
    p90: quantile(0.9),
  };
}

const [store, report] = await Promise.all([
  readFile(profilePath, "utf8").then(JSON.parse),
  readFile(reportPath, "utf8").then(JSON.parse),
]);
if (report.sampleCount !== 80 || JSON.stringify(report.sourceIds) !== JSON.stringify(sourceIds)) {
  throw new Error(`Unexpected reference measurement source set in ${reportPath}`);
}
const profile = store.profiles?.find((entry) => entry.id === profileId);
if (!profile) throw new Error(`Profile not found: ${profileId}`);

const bubbleCandidates = report.reports.flatMap((video) =>
  video.samples.flatMap((sample) => sample.bubbleCandidates),
);
const bubbleGeometry = {
  caveat: "White-region CV candidates, not OCR or human bubble approval.",
  samplesWithCandidates: report.reports.reduce(
    (total, video) => total + video.samples.filter((sample) => sample.bubbleCandidates.length > 0).length,
    0,
  ),
  candidateCount: bubbleCandidates.length,
  widthRatio: distribution(bubbleCandidates.map((candidate) => candidate.widthRatio)),
  heightRatio: distribution(bubbleCandidates.map((candidate) => candidate.heightRatio)),
  areaRatio: distribution(bubbleCandidates.map((candidate) => candidate.areaRatio)),
};
const establishingCount = Object.values(establishingSamples).flat().length;
const closeUpCount = Object.values(closeUpSamples).flat().length;
const mediumCount = report.sampleCount - establishingCount - closeUpCount;

profile.name = "運営者｜参考動画2本・全尺80点実測固定 v6";
profile.generationRecipe = {
  ...(profile.generationRecipe || {}),
  method: "two frozen full-length video sources + 80 uniform midpoint samples + human contact-sheet audit + native-size comparison",
  firstPass: "Match the direct frames as a two-layer look. Keep the crisp flat-colored character as the primary focal layer. Keep the location recognizable with near/mid/far planes and only 2-4 story-relevant props in the focal zone; reduce background edge density, saturation and contrast below the character instead of filling every surface with equally sharp objects.",
  calibrationPass: "Preserve identity, pose and composition. Compare at matched face size: restore missing eye and hair information, keep skin cel-flat, and simplify or soften any background object that competes with the face, hands, evidence or bubble-safe negative space. Reject both empty generic rooms and crowded high-contrast prop walls.",
};
profile.shotRhythmPrompt = "For a sequence, use the two exact reference videos' human-audited shot mix as the starting distribution: approximately 33% establishing/environment, 40% medium or two-person dialogue, and 27% reaction close-up. Default to one full-bleed 16:9 illustration; split panels are exceptional and only allowed when the script explicitly requests them. Alternate left/right shot-reverse-shot, restrained elevated/top angles and reaction framing; never repeat the same camera distance or side more than twice. Each still carries one clear action, emotion or reveal, with restrained acting except at the scripted climax.";
profile.referenceMeasurements = {
  version: 1,
  measuredAt: "2026-08-06",
  reportPath: "reference-media/love-manga/analysis/reference-video-measurements.json",
  sampling: {
    method: "40 uniform midpoint frames from each complete source; optical flow compares each frame with +1 second",
    sourceIds,
    sourceCount: report.videoCount,
    sampleCount: report.sampleCount,
  },
  visual: report.visual,
  cameraMotion: report.cameraMotion,
  bubbleGeometry,
  audio: report.reports.map((video) => ({
    id: video.id,
    integratedLufs: video.audio.integratedLufs,
    loudnessRangeLu: video.audio.loudnessRangeLu,
    truePeakDbfs: video.audio.truePeakDbfs,
    silenceDurationSeconds: video.audio.silenceDurationSeconds,
    caveat: video.audio.mixedTrackCaveat,
  })),
  humanShotAudit: {
    method: "Manual classification of both 40-frame contact sheets.",
    establishingEnvironment: { count: establishingCount, ratio: establishingCount / report.sampleCount, sampleNumbers: establishingSamples },
    mediumOrTwoShot: { count: mediumCount, ratio: mediumCount / report.sampleCount },
    reactionCloseUp: { count: closeUpCount, ratio: closeUpCount / report.sampleCount, sampleNumbers: closeUpSamples },
  },
  humanPanelAudit: {
    method: "Manual inspection of all 80 sampled frames.",
    fullBleedSinglePanel: { count: 80, ratio: 1 },
    splitPanel: { count: 0, ratio: 0 },
    automaticFalsePositives: 3,
  },
};

profile.visualQualityGate = {
  ...(profile.visualQualityGate || {}),
  required: [
    ...(profile.visualQualityGate?.required || []).filter((entry) => (
      !entry.startsWith("background contains")
      && !entry.startsWith("background identifies")
      && !entry.startsWith("face, hands and story evidence")
    )),
    "background identifies the location with 2-4 story-relevant focal props, near/mid/far depth and practical light while staying lower in contrast, saturation and edge density than the character",
    "face, hands and story evidence remain the first read; an outer upper zone stays quiet enough for the deterministic bubble",
  ],
  reject: [
    ...(profile.visualQualityGate?.reject || []).filter((entry) => (
      !entry.startsWith("crowded background")
      && !entry.startsWith("high-saturation or high-frequency background")
    )),
    "crowded background with many equally sharp, equally contrasted props competing with the cast",
    "high-saturation or high-frequency background detail crossing a face silhouette or bubble-safe zone",
  ],
};
profile.stylePrompt = "STYLE-ONLY LOCK. Match the supplied benchmark frames as a two-layer Japanese YouTube manga look. CHARACTER LAYER: clean charcoal contours with selective stronger outer accents; mature tapered faces; readable irises and small catchlights; upper-lash and expression detail; minimal nose; clearly shaped mouth; layered bangs and side locks; one irregular two-tone flat hair-highlight patch; pale cel-flat skin with one restrained hard shadow; clothing with broad fills and a few readable seams and folds. The person is the primary focal layer. BACKGROUND LAYER: a softer painted location plate that identifies the place through architecture, depth, practical/window light and 2-4 story-relevant focal props. Keep background saturation, contrast and edge density below the character; simplify peripheral objects and leave a clean outer upper zone opposite the speaker for a later vertical balloon. Avoid both empty generic rooms and crowded prop walls. Use warm cream and wood, muted blue-green, lavender, dusty pink and charcoal accents. People in style references are style only: never copy identity, pose, clothes, text, balloons or exact composition.";
const quieterBackgroundNegatives = "crowded prop wall, many equally sharp background objects, background higher contrast than face, saturated signage behind face, busy texture in speech-bubble safe zone";
profile.negativePrompt = `${String(profile.negativePrompt || "").replace(new RegExp(`, ${quieterBackgroundNegatives}$`), "")}, ${quieterBackgroundNegatives}`;

await writeJsonAtomic(profilePath, store);
process.stdout.write(`${JSON.stringify({ profilePath, reportPath, profileId, referenceMeasurements: profile.referenceMeasurements }, null, 2)}\n`);
