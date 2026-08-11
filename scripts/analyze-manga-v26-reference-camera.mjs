#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectDir = resolve(process.argv[2] || process.cwd());
const inputPath = resolve(
  projectDir,
  "canvas/reference-media/love-manga/analysis/v23-reference-camera-grammar/reference-camera-grammar.json",
);
const outputPath = resolve(
  projectDir,
  "canvas/reference-media/love-manga/analysis/v26-reference-camera-continuity.json",
);
const source = JSON.parse(await readFile(inputPath, "utf8"));
const scenes = source.videos.flatMap((video) => video.scenes || []);
const paired = scenes.filter((scene) => scene.firstHalfMotion?.valid && scene.lastHalfMotion?.valid);

const magnitude = (motion) => Math.hypot(
  Number(motion?.contentTranslateX || 0),
  Number(motion?.contentTranslateY || 0),
);
const speedRatio = (last, first) => last / Math.max(first, 1e-6);
const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const percentile = (values, ratio) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))];
};

const movingPairs = paired.filter((scene) => {
  const firstScale = Math.abs(Number(scene.firstHalfMotion.contentScaleDelta || 0));
  const firstTranslation = magnitude(scene.firstHalfMotion);
  return firstScale >= 0.003 || firstTranslation >= 0.003;
});
const scaleRatios = movingPairs
  .filter((scene) => Math.abs(Number(scene.firstHalfMotion.contentScaleDelta || 0)) >= 0.003)
  .map((scene) => speedRatio(
    Math.abs(Number(scene.lastHalfMotion.contentScaleDelta || 0)),
    Math.abs(Number(scene.firstHalfMotion.contentScaleDelta || 0)),
  ));
const translationRatios = movingPairs
  .filter((scene) => magnitude(scene.firstHalfMotion) >= 0.003)
  .map((scene) => speedRatio(magnitude(scene.lastHalfMotion), magnitude(scene.firstHalfMotion)));
const terminalStops = movingPairs.filter((scene) => {
  const first = Math.max(
    Math.abs(Number(scene.firstHalfMotion.contentScaleDelta || 0)),
    magnitude(scene.firstHalfMotion),
  );
  const last = Math.max(
    Math.abs(Number(scene.lastHalfMotion.contentScaleDelta || 0)),
    magnitude(scene.lastHalfMotion),
  );
  return last < first * 0.2;
});
const directionReversals = movingPairs.filter((scene) => {
  const first = scene.firstHalfMotion;
  const last = scene.lastHalfMotion;
  const scaleReverse = Number(first.contentScaleDelta || 0) * Number(last.contentScaleDelta || 0) < -1e-5;
  const xReverse = Number(first.contentTranslateX || 0) * Number(last.contentTranslateX || 0) < -1e-5;
  const yReverse = Number(first.contentTranslateY || 0) * Number(last.contentTranslateY || 0) < -1e-5;
  return scaleReverse || xReverse || yReverse;
});

const report = {
  version: "v26-reference-camera-continuity",
  sourcePath: inputPath,
  referenceVideoIds: source.referenceVideoIds,
  analyzedSceneCount: scenes.length,
  validFirstAndLastHalfCount: paired.length,
  movingFirstHalfCount: movingPairs.length,
  multiCaptionSceneRatio: source.aggregate.multiCaptionSceneRatio,
  classificationCounts: source.aggregate.classificationCounts,
  continuity: {
    scaleLastToFirstSpeedRatio: {
      count: scaleRatios.length,
      median: median(scaleRatios),
      p10: percentile(scaleRatios, 0.1),
      p90: percentile(scaleRatios, 0.9),
    },
    translationLastToFirstSpeedRatio: {
      count: translationRatios.length,
      median: median(translationRatios),
      p10: percentile(translationRatios, 0.1),
      p90: percentile(translationRatios, 0.9),
    },
    terminalStopCount: terminalStops.length,
    terminalStopRatio: terminalStops.length / Math.max(1, movingPairs.length),
    directionReversalCandidateCount: directionReversals.length,
  },
  productionRules: [
    "Use linear parameter progress from the first through the final frame.",
    "Do not author lead or tail holds for a moving still.",
    "A compound side/top then pull-out move must share one image and one continuous keyframe path.",
    "The pull-out segment inherits the exact zoom/focus endpoint of the preceding side/top segment.",
    "Never reinsert the same still as a second shot within one cut.",
    "Reject down angles and positive focus-Y travel.",
  ],
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
