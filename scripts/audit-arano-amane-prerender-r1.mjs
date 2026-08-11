#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const episodeId = "manga-arano-amane-reversal-001";
const episodeDir = join(projectDir, "canvas/manga-videos", episodeId);
const manifestPath = join(episodeDir, "episode-manifest.json");
const sourceScriptPath = join(episodeDir, "script.txt");
const productionScriptPath = join(episodeDir, "script-production-r1.txt");
const auditsDir = join(episodeDir, "audits");

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const dialogueText = (script) => script.split("\n").flatMap((line) => {
  if (line.startsWith("【カット") || line.startsWith("タイトル")) return [];
  const match = line.match(/^([^：:]{1,80})[：:]\s*(.+)$/u);
  return match ? [match[2]] : [];
});

const manifest = await readJson(manifestPath);
const sourceScript = await readFile(sourceScriptPath, "utf8");
const productionScript = await readFile(productionScriptPath, "utf8");
const sourceText = dialogueText(sourceScript).join("");
const productionText = dialogueText(productionScript).join("");
const manifestText = manifest.utterances.map((entry) => entry.text).join("");

const sourceCoverage = {
  version: "r2-after-editorial-deduplication",
  pass: sourceText === productionText && productionText === manifestText,
  sourceScriptPath,
  productionScriptPath,
  sourceUtteranceCount: dialogueText(sourceScript).length,
  productionUtteranceCount: dialogueText(productionScript).length,
  manifestUtteranceCount: manifest.utterances.length,
  sourceTextLength: [...sourceText].length,
  productionTextLength: [...productionText].length,
  manifestTextLength: [...manifestText].length,
  sourceToProductionExactConcatenatedTextMatch: sourceText === productionText,
  productionToManifestExactConcatenatedTextMatch: productionText === manifestText,
  editorialAdaptation: {
    cutId: "cut-20",
    reason: "The boyfriend's quoted line is performed once by the boyfriend; the following narration says そう振られ to avoid an audible duplicate while preserving every source fact and quoted word.",
  },
  knownRemainingIssues: [],
};

const speechRows = [];
for (const utterance of manifest.utterances) {
  const alignment = await readJson(utterance.audio.alignmentPath);
  const alignedText = (alignment.alignment?.characters || []).join("");
  speechRows.push({
    utteranceId: utterance.id,
    speakerId: utterance.speakerId,
    model: alignment.model,
    displayTextMatch: utterance.text === alignment.displayText,
    providerAlignmentExactMatch: alignedText === alignment.providerText,
    durationSeconds: alignment.durationSeconds,
    durationInRange: alignment.durationSeconds >= 0.5 && alignment.durationSeconds <= 12,
    speechStartsAtFileHead: alignment.speechStartSeconds === 0,
    speechEndsAtFileTail: alignment.speechEndSeconds === alignment.durationSeconds,
    audioPath: utterance.audio.filePath,
    alignmentPath: utterance.audio.alignmentPath,
  });
}
const speechFailures = speechRows.filter((row) => row.model !== "eleven_v3"
  || !row.displayTextMatch
  || !row.providerAlignmentExactMatch
  || !row.durationInRange);
const speechAudit = {
  version: "r2-eleven-v3-source-alignment",
  pass: speechRows.length === 138 && speechFailures.length === 0,
  utteranceCount: speechRows.length,
  speakerCount: new Set(manifest.utterances.map((entry) => entry.speakerId)).size,
  modelCounts: Object.fromEntries([...new Set(speechRows.map((row) => row.model))]
    .map((model) => [model, speechRows.filter((row) => row.model === model).length])),
  totalAudioDurationSeconds: speechRows.reduce((sum, row) => sum + row.durationSeconds, 0),
  shortestDurationSeconds: Math.min(...speechRows.map((row) => row.durationSeconds)),
  longestDurationSeconds: Math.max(...speechRows.map((row) => row.durationSeconds)),
  exactProviderAlignmentCount: speechRows.filter((row) => row.providerAlignmentExactMatch).length,
  displayTextMatchCount: speechRows.filter((row) => row.displayTextMatch).length,
  failures: speechFailures,
  rows: speechRows,
  knownRemainingIssues: [],
};

const bubbleRows = [];
for (const utterance of manifest.utterances) {
  const spec = await readJson(utterance.overlaySpecPath);
  const quality = spec.quality?.[0] || {};
  bubbleRows.push({
    utteranceId: utterance.id,
    exactTextMatch: quality.exactTextMatch === true,
    textLoss: quality.textLoss === true,
    overflow: quality.overflow === true,
    tooSmall: quality.tooSmall === true,
    faceOverlapRatio: quality.faceOverlapRatio || 0,
    hardProtectedOverlapRatio: quality.hardProtectedOverlapRatio || 0,
    sequenceNearRepeat: quality.sequenceNearRepeat === true,
    fontSize: quality.fontSize,
    edgeClearance: quality.edgeClearance,
    overlayPath: utterance.overlayPath,
    overlaySpecPath: utterance.overlaySpecPath,
  });
}
const bubbleFailures = bubbleRows.filter((row) => !row.exactTextMatch
  || row.textLoss
  || row.overflow
  || row.tooSmall
  || row.faceOverlapRatio > 0
  || row.hardProtectedOverlapRatio > 0
  || row.sequenceNearRepeat);
const bubbleAudit = {
  version: "r1-camera-aware-sequence",
  pass: bubbleRows.length === 138 && bubbleFailures.length === 0,
  bubbleCount: bubbleRows.length,
  exactTextCount: bubbleRows.filter((row) => row.exactTextMatch).length,
  minimumFontSize: Math.min(...bubbleRows.map((row) => row.fontSize)),
  minimumEdgeClearance: Math.min(...bubbleRows.map((row) => row.edgeClearance)),
  failures: bubbleFailures,
  rows: bubbleRows,
  knownRemainingIssues: [],
};

const family = (mode) => mode.includes("then-pullout")
  ? "combined"
  : mode === "pullout-only"
    ? "pullout"
    : "directional";
const cameraRows = manifest.cuts.map((cut) => ({
  cutId: cut.id,
  cameraMode: cut.cameraMode,
  family: family(cut.cameraMode),
  linear: cut.camera?.easing === "linear",
  splitPage: cut.flattenedSplitPage?.enabled === true,
  panelCount: cut.flattenedSplitPage?.panelCount || 0,
  panelsStatic: !cut.flattenedSplitPage?.enabled || cut.flattenedSplitPage?.panelCamera === "static",
  wholePageCamera: !cut.flattenedSplitPage?.enabled || cut.flattenedSplitPage?.motionPolicy === "whole-page",
  imagePath: cut.imagePath,
}));
const expectedSplits = ["cut-08", "cut-15", "cut-20", "cut-21"];
const actualSplits = cameraRows.filter((row) => row.splitPage).map((row) => row.cutId);
const cameraFailures = cameraRows.filter((row) => !row.linear || !row.panelsStatic || !row.wholePageCamera);
const cameraAudit = {
  version: "manga-page-camera-v2-r1",
  pass: cameraRows.length === 21
    && cameraFailures.length === 0
    && JSON.stringify(actualSplits) === JSON.stringify(expectedSplits)
    && new Set(cameraRows.map((row) => row.imagePath)).size === cameraRows.length,
  cutCount: cameraRows.length,
  movingCutCount: cameraRows.length,
  cameraFamilyCounts: Object.fromEntries(["pullout", "directional", "combined"]
    .map((key) => [key, cameraRows.filter((row) => row.family === key).length])),
  expectedSplitCutIds: expectedSplits,
  actualSplitCutIds: actualSplits,
  uniqueImageCount: new Set(cameraRows.map((row) => row.imagePath)).size,
  failures: cameraFailures,
  rows: cameraRows,
  knownRemainingIssues: [],
};

for (const audit of [sourceCoverage, speechAudit, bubbleAudit, cameraAudit]) {
  if (!audit.pass) throw new Error(`Pre-render audit failed: ${audit.version}`);
}

manifest.scriptText = productionScript;
manifest.production = {
  ...(manifest.production || {}),
  sourceCoverageAuditPath: join(auditsDir, "source-coverage-audit-r2.json"),
  speechSourceAuditPath: join(auditsDir, "speech-source-audit-r2.json"),
  bubbleLayoutAuditPath: join(auditsDir, "bubble-layout-audit-r1.json"),
  cameraPreRenderAuditPath: join(auditsDir, "camera-prerender-audit-r1.json"),
};
manifest.updatedAt = new Date().toISOString();

const checkpoint = await readJson(join(episodeDir, "checkpoint.json"));
checkpoint.status = "prerender-audits-passed";
checkpoint.completedStages = [...new Set([
  ...(checkpoint.completedStages || []),
  "manifest-created",
  "speech-generated-eleven-v3",
  "speech-source-alignment-audit-passed",
  "bubble-layout-audit-passed",
  "camera-prerender-audit-passed",
])];
checkpoint.nextStage = "render-review-mp4";
checkpoint.knownRemainingIssues = ["video not rendered", "final MP4 audits not run"];
checkpoint.updatedAt = new Date().toISOString();

await Promise.all([
  writeJsonAtomic(manifestPath, manifest),
  writeJsonAtomic(join(auditsDir, "source-coverage-audit-r2.json"), sourceCoverage),
  writeJsonAtomic(join(auditsDir, "speech-source-audit-r2.json"), speechAudit),
  writeJsonAtomic(join(auditsDir, "bubble-layout-audit-r1.json"), bubbleAudit),
  writeJsonAtomic(join(auditsDir, "camera-prerender-audit-r1.json"), cameraAudit),
  writeJsonAtomic(join(episodeDir, "checkpoint.json"), checkpoint),
]);

process.stdout.write(`${JSON.stringify({
  pass: true,
  episodeId,
  sourceCharacters: sourceCoverage.sourceTextLength,
  utterances: speechAudit.utteranceCount,
  speakers: speechAudit.speakerCount,
  bubbles: bubbleAudit.bubbleCount,
  cameraFamilyCounts: cameraAudit.cameraFamilyCounts,
  splitCutIds: cameraAudit.actualSplitCutIds,
  durationSeconds: manifest.metrics.videoDurationSeconds,
  manifestPath,
  auditFiles: [
    "source-coverage-audit-r2.json",
    "speech-source-audit-r2.json",
    "bubble-layout-audit-r1.json",
    "camera-prerender-audit-r1.json",
  ].map((name) => join(auditsDir, name)),
  manifestFile: basename(manifestPath),
}, null, 2)}\n`);
