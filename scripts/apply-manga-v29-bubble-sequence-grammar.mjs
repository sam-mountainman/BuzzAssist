#!/usr/bin/env node
import { copyFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";
import { refreshEpisodeBubbleOverlays } from "../lib/mangaVideoPipeline.mjs";
import { REFERENCE_SEQUENCE_PLACEMENT_POLICY } from "../lib/speechBubbleRenderer.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas/manga-videos/manga-photo-homecoming-001");
const manifestPath = join(episodeDir, "episode-manifest.json");
const backupPath = join(episodeDir, "episode-manifest-v28-editorial-grammar-r2-backup.json");
const referenceAnalysisPath = join(
  projectDir,
  "canvas/reference-media/love-manga/analysis/reference-bubble-placement-sequences-v29.json",
);

const [manifest, referenceAnalysis] = await Promise.all([
  readFile(manifestPath, "utf8").then(JSON.parse),
  readFile(referenceAnalysisPath, "utf8").then(JSON.parse),
]);
if (!referenceAnalysis?.summary || referenceAnalysis.summary.observedSequentialTransitionCount < 300) {
  throw new Error("Full reference-video placement analysis is missing or incomplete.");
}
if (manifest.production?.version === "v28-editorial-grammar-r2") {
  await copyFile(manifestPath, backupPath);
}

manifest.video = {
  ...(manifest.video || {}),
  fileName: "manga-photo-homecoming-001-v29-bubble-sequence-grammar-r1.mp4",
  statusAfterRender: "final-v29-bubble-sequence-grammar-r1",
  cutIds: "",
  bubbleRendererRevision: "v29-reference-sequence-placement-r1",
};
manifest.status = "v29-bubble-sequence-ready";
manifest.production = {
  ...(manifest.production || {}),
  version: "v29-bubble-sequence-grammar-r1",
  bubblePlacementGrammar: {
    version: REFERENCE_SEQUENCE_PLACEMENT_POLICY.id,
    referenceAnalysisPath,
    method: referenceAnalysis.method,
    measured: referenceAnalysis.summary,
    rules: {
      historyDepth: REFERENCE_SEQUENCE_PLACEMENT_POLICY.historyDepth,
      immediateNearRepeatDistanceRatio: REFERENCE_SEQUENCE_PLACEMENT_POLICY.nearRepeatDistanceRatio,
      preferredImmediateMovementRatio: REFERENCE_SEQUENCE_PLACEMENT_POLICY.preferredMovementDistanceRatio,
      consecutiveSamePocket: "strong penalty; choose another left/center/right × upper/middle/lower pocket when safe",
      narrationCards: "stronger same-pocket penalty when two narration cards are consecutive",
      speakerRelationship: "first prefer negative space opposite the speaker, then a clean actor gap; sequence movement can change the pocket",
      safetyPriority: "face, mouth, text, hand, prop, and evidence collisions outrank variation",
      lowerThird: "last resort unless it is the safe movement pocket",
      persistence: "the two previous utterance placements remain in history across cut boundaries",
    },
  },
};
manifest.updatedAt = new Date().toISOString();
if (manifest.outputs?.reviewVideo) delete manifest.outputs.reviewVideo;
await writeJsonAtomic(manifestPath, manifest);

const refreshed = await refreshEpisodeBubbleOverlays({
  projectDir,
  manifestPath,
  refreshAll: true,
  reflowPlacement: true,
  sequenceAware: true,
  placementHistoryDepth: REFERENCE_SEQUENCE_PLACEMENT_POLICY.historyDepth,
  status: "v29-bubble-sequence-ready",
});

const finalManifest = refreshed.manifest;
finalManifest.status = "v29-bubble-sequence-ready";
finalManifest.production.version = "v29-bubble-sequence-grammar-r1";
finalManifest.production.bubblePlacementGrammar.refreshAudit = {
  refreshedOverlayCount: refreshed.refreshed.length,
  sequenceAwareOverlayCount: refreshed.refreshed.filter((entry) => (
    entry.sequencePlacement?.historyDepth > 0
  )).length,
  nearRepeatCount: refreshed.refreshed.filter((entry) => entry.sequencePlacement?.nearRepeat).length,
  samePocketCount: refreshed.refreshed.filter((entry) => entry.sequencePlacement?.immediate?.samePocket).length,
};
finalManifest.updatedAt = new Date().toISOString();
await writeJsonAtomic(manifestPath, finalManifest);

process.stdout.write(`${JSON.stringify({
  manifestPath,
  backupPath,
  status: finalManifest.status,
  outputFileName: finalManifest.video.fileName,
  referenceSummary: referenceAnalysis.summary,
  refreshAudit: finalManifest.production.bubblePlacementGrammar.refreshAudit,
}, null, 2)}\n`);
