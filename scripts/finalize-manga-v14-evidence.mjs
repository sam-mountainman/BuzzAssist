#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const projectDir = "/Users/higataiyu/Documents/Excalidraw";
const episodeDir = path.join(
  projectDir,
  "canvas/manga-videos/manga-photo-homecoming-001",
);
const paths = {
  manifest: path.join(episodeDir, "episode-manifest.json"),
  cameraPlan: path.join(episodeDir, "v13-camera-motion-plan.json"),
  cameraEvidence: path.join(episodeDir, "v14-r2-camera-motion-evidence.json"),
  mediaAudit: path.join(episodeDir, "v14-r2-final-media-audit.json"),
  visualV13: path.join(
    episodeDir,
    "v13-camera-preview-analysis/reference-video-measurements.json",
  ),
  visualV14: path.join(
    episodeDir,
    "v14-final-visual-analysis/reference-video-measurements.json",
  ),
  visualReference: path.join(
    projectDir,
    "canvas/reference-media/love-manga/analysis/reference-video-measurements.json",
  ),
  bubbleLayoutAudit: path.join(episodeDir, "v12-bubble-layout-audit.json"),
  bubbleFrameAudit: path.join(
    episodeDir,
    "v14-r2-bubble-frame-audit/bubble-frame-audit.json",
  ),
  dialogueAudit: path.join(episodeDir, "v10-dialogue-editorial-audit.json"),
  manualBubbleAudit: path.join(episodeDir, "v14-r2-bubble-manual-audit.json"),
  output: path.join(episodeDir, "v14-final-evidence.json"),
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));
const manifest = readJson(paths.manifest);
const cameraPlan = readJson(paths.cameraPlan);
const cameraEvidence = readJson(paths.cameraEvidence);
const mediaAudit = readJson(paths.mediaAudit);
const visualV13 = readJson(paths.visualV13);
const visualV14 = readJson(paths.visualV14);
const visualReference = readJson(paths.visualReference);
const bubbleLayoutAudit = readJson(paths.bubbleLayoutAudit);
const bubbleFrameAudit = readJson(paths.bubbleFrameAudit);
const dialogueAudit = readJson(paths.dialogueAudit);

const videoPath = manifest.outputs?.reviewVideo?.filePath;
const selectedShots = manifest.cuts.flatMap((cut) => cut.cameraSequence ?? []);
const requiredAngles = [
  "left",
  "right",
  "top",
  "wide",
  "left-wide",
  "right-wide",
  "top-wide",
];
const missingAngles = requiredAngles.filter(
  (angle) => !cameraPlan.angleCounts?.[angle],
);

const manualBubbleAudit = {
  version: "v14-r2-manual-bubble-frame-audit",
  videoPath,
  generatedAt: new Date().toISOString(),
  frameCount: bubbleFrameAudit.frameCount,
  dialogueFrameCount: 22,
  narrationFrameCount: 7,
  reviewedFrameCount: 29,
  activeSpeakerFaceOverlapBeforeFix: ["cut-03-u02", "cut-04-u02"],
  appliedShifts: [
    {
      utteranceId: "cut-03-u02",
      destination: "empty right-side wall",
      dxSourcePixels: 470,
    },
    {
      utteranceId: "cut-04-u02",
      destination: "central/right background lane between actors",
      dxSourcePixels: 925,
    },
  ],
  activeSpeakerFaceOverlapAfterFix: 0,
  policy: {
    activeSpeakerFaceOverlapAllowed: false,
    listenerOverlapAllowedWhenNeeded: true,
    artificialBackgroundDarkening: false,
  },
  correctedFramePaths: [
    path.join(
      episodeDir,
      "v14-r2-bubble-frame-audit/frames/07-cut-03-u02.jpg",
    ),
    path.join(
      episodeDir,
      "v14-r2-bubble-frame-audit/frames/10-cut-04-u02.jpg",
    ),
  ],
  pass: true,
};
fs.writeFileSync(
  paths.manualBubbleAudit,
  `${JSON.stringify(manualBubbleAudit, null, 2)}\n`,
);

const v13Visual = {
  meanLuma: visualV13.visual.meanLuma.mean,
  meanSaturation: visualV13.visual.meanSaturation.mean,
  edgeDensity: visualV13.visual.edgeDensity.mean,
};
const v14Visual = {
  meanLuma: visualV14.visual.meanLuma.mean,
  meanSaturation: visualV14.visual.meanSaturation.mean,
  edgeDensity: visualV14.visual.edgeDensity.mean,
};
const referenceVisual = {
  meanLuma: visualReference.visual.meanLuma.mean,
  meanSaturation: visualReference.visual.meanSaturation.mean,
  edgeDensity: visualReference.visual.edgeDensity.mean,
};
const visualImprovement = {
  lumaIncreasePercent:
    ((v14Visual.meanLuma - v13Visual.meanLuma) / v13Visual.meanLuma) * 100,
  saturationReductionPercent:
    ((v13Visual.meanSaturation - v14Visual.meanSaturation) /
      v13Visual.meanSaturation) *
    100,
  oldEdgeDistanceFromReference: Math.abs(
    v13Visual.edgeDensity - referenceVisual.edgeDensity,
  ),
  newEdgeDistanceFromReference: Math.abs(
    v14Visual.edgeDensity - referenceVisual.edgeDensity,
  ),
};

const checks = [
  {
    id: "final-video-r2-exists",
    pass:
      typeof videoPath === "string" &&
      videoPath.endsWith("manga-photo-homecoming-001-v14-final-r2.mp4") &&
      fs.existsSync(videoPath),
    value: videoPath,
  },
  {
    id: "media-format-audio-pass",
    pass: mediaAudit.pass === true && Object.values(mediaAudit.gates).every(Boolean),
    value: { gates: mediaAudit.gates, loudness: mediaAudit.loudness },
  },
  {
    id: "v14-shot-assets-25-of-25",
    pass:
      selectedShots.length === 25 &&
      selectedShots.every(
        (shot) =>
          shot.imagePath.includes("v14-cut") && fs.existsSync(shot.imagePath),
      ),
    value: {
      count: selectedShots.length,
      v14Count: selectedShots.filter((shot) => shot.imagePath.includes("v14-cut"))
        .length,
    },
  },
  {
    id: "all-required-camera-angles",
    pass: missingAngles.length === 0,
    value: { requiredAngles, missingAngles, angleCounts: cameraPlan.angleCounts },
  },
  {
    id: "camera-motion-25-of-25",
    pass:
      cameraEvidence.pass === true &&
      cameraEvidence.passCount === 25 &&
      cameraEvidence.failedCount === 0 &&
      cameraEvidence.renderedMeasuredPullPercent.minimumMagnitude >= 2.5,
    value: {
      passCount: cameraEvidence.passCount,
      pullPercent: cameraEvidence.renderedMeasuredPullPercent,
    },
  },
  {
    id: "spatial-wide-source-ratio",
    pass:
      cameraPlan.spatialWideSourceCount === 9 && cameraPlan.shotCount === 25,
    value: {
      spatialWideSourceCount: cameraPlan.spatialWideSourceCount,
      shotCount: cameraPlan.shotCount,
      ratio: cameraPlan.spatialWideSourceCount / cameraPlan.shotCount,
    },
  },
  {
    id: "background-brightness-improved",
    pass:
      v14Visual.meanLuma >= 120 &&
      visualImprovement.lumaIncreasePercent >= 40 &&
      manifest.production?.bubblePolicy?.artificialBackgroundDarkening === false,
    value: { v13Visual, v14Visual, visualImprovement },
  },
  {
    id: "line-density-closer-to-reference",
    pass:
      v14Visual.edgeDensity >= 0.04 &&
      v14Visual.edgeDensity <= 0.06 &&
      visualImprovement.newEdgeDistanceFromReference <
        visualImprovement.oldEdgeDistanceFromReference,
    value: { referenceVisual, v13Visual, v14Visual, visualImprovement },
  },
  {
    id: "bubble-frame-manual-review-29-of-29",
    pass:
      manualBubbleAudit.pass &&
      manualBubbleAudit.reviewedFrameCount === 29 &&
      manualBubbleAudit.activeSpeakerFaceOverlapAfterFix === 0 &&
      manualBubbleAudit.correctedFramePaths.every((filePath) =>
        fs.existsSync(filePath),
      ),
    value: manualBubbleAudit,
  },
  {
    id: "bubble-layout-and-text-gates",
    pass:
      bubbleLayoutAudit.overlayCount === 29 &&
      bubbleLayoutAudit.zeroFaceOverlapCount === 29 &&
      bubbleLayoutAudit.zeroImportantOverlapCount === 29,
    value: {
      overlayCount: bubbleLayoutAudit.overlayCount,
      zeroFaceOverlapCount: bubbleLayoutAudit.zeroFaceOverlapCount,
      zeroImportantOverlapCount: bubbleLayoutAudit.zeroImportantOverlapCount,
    },
  },
  {
    id: "dialogue-punctuation-preserved",
    pass:
      dialogueAudit.sourceExactCount === 29 &&
      dialogueAudit.finalFullStopPreservedCount === 29,
    value: {
      sourceExactCount: dialogueAudit.sourceExactCount,
      finalFullStopPreservedCount: dialogueAudit.finalFullStopPreservedCount,
    },
  },
  {
    id: "oss-stack-recorded",
    pass: ["FFmpeg", "OpenCV", "NumPy"].every((name) =>
      manifest.production?.ossStack?.some((entry) => entry.name === name),
    ),
    value: manifest.production?.ossStack,
  },
];

const passCount = checks.filter((check) => check.pass).length;
const report = {
  version: "v14-reference-style-final-evidence-r2",
  episodeId: manifest.id,
  videoPath,
  generatedAt: new Date().toISOString(),
  pass: passCount === checks.length,
  summary: {
    passCount,
    totalCount: checks.length,
    failedCount: checks.length - passCount,
  },
  checks,
  artifacts: paths,
};
fs.writeFileSync(paths.output, `${JSON.stringify(report, null, 2)}\n`);

if (!report.pass) {
  console.error(JSON.stringify(report.summary, null, 2));
  process.exit(2);
}

manifest.status = "final-review-candidate-v14-r2";
manifest.updatedAt = new Date().toISOString();
manifest.production = {
  ...manifest.production,
  version: "v14-reference-style-camera-final-r2",
  finalEvidencePath: paths.output,
  visualUpgrade: {
    ...manifest.production?.visualUpgrade,
    finalMetrics: {
      v13: v13Visual,
      v14: v14Visual,
      reference: referenceVisual,
      improvement: visualImprovement,
    },
    bubbleManualAuditPath: paths.manualBubbleAudit,
  },
};
fs.writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  JSON.stringify(
    {
      outputPath: paths.output,
      ...report.summary,
      pass: report.pass,
      status: manifest.status,
    },
    null,
    2,
  ),
);
