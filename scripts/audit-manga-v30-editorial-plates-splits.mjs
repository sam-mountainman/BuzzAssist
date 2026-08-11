#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { normalizePanelLayout } from "../lib/mangaVideoPipeline.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas/manga-videos/manga-photo-homecoming-001");
const manifestPath = join(episodeDir, "episode-manifest.json");
const referenceAnalysisPath = join(
  projectDir,
  "canvas/reference-media/love-manga/analysis/v30-editorial-plates-splits/reference-editorial-plates-splits-v30.json",
);
const bubbleAuditPath = join(episodeDir, "v29-bubble-sequence-layout-audit.json");
const outputPath = join(episodeDir, "v30-editorial-plates-splits-audit.json");
const [manifest, reference, bubbleAudit] = await Promise.all([
  readFile(manifestPath, "utf8").then(JSON.parse),
  readFile(referenceAnalysisPath, "utf8").then(JSON.parse),
  readFile(bubbleAuditPath, "utf8").then(JSON.parse),
]);

const cuts = new Map(manifest.cuts.map((cut) => [cut.id, cut]));
const expectedPlateTypes = new Map([
  ["cut-01-u01", "white-solid"],
  ["cut-01-u02", "black-solid"],
  ["cut-09-u03", "pastel-sky"],
  ["cut-10-u04", "pastel-sky"],
]);
const plateShots = manifest.cuts.flatMap((cut) => (cut.cameraSequence || []).map((shot) => ({ ...shot, cutId: cut.id })))
  .filter((shot) => shot.editorialPlate);
const plateByUtterance = new Map(plateShots.flatMap((shot) => (
  (shot.utteranceIds || []).map((id) => [id, shot])
)));
const plateFailures = [];
for (const [utteranceId, expectedType] of expectedPlateTypes) {
  const shot = plateByUtterance.get(utteranceId);
  if (!shot) plateFailures.push({ utteranceId, reason: "missing-plate-shot" });
  else if (shot.editorialPlate.type !== expectedType) plateFailures.push({ utteranceId, reason: "wrong-type", actual: shot.editorialPlate.type });
  else if (shot.motion !== "none") plateFailures.push({ utteranceId, reason: "plate-must-remain-static" });
  else if (shot.editorialPlate.characterPolicy !== "strictly-none" || shot.editorialPlate.environmentPolicy !== "none") {
    plateFailures.push({ utteranceId, reason: "plate-is-not-locationless" });
  }
}
for (const shot of plateShots) {
  if (/background-empty|photo-shop|empty-gallery/iu.test(shot.imagePath)) {
    plateFailures.push({ utteranceId: shot.utteranceIds?.[0], reason: "literal-empty-environment-used", imagePath: shot.imagePath });
  }
}

const expectedLayouts = new Map([["cut-06", "vertical-2"], ["cut-08", "story-3"]]);
const splitFailures = [];
const splitAudits = [];
for (const [cutId, expectedType] of expectedLayouts) {
  const cut = cuts.get(cutId);
  const layout = normalizePanelLayout(cut?.panelLayout, manifest.video.width, manifest.video.height, cut?.imagePath);
  if (!layout || layout.type !== expectedType) {
    splitFailures.push({ cutId, reason: "wrong-or-missing-layout", actual: layout?.type });
    continue;
  }
  const cameras = layout.panels.map((panel, index) => {
    const camera = panel.camera;
    const delta = {
      zoom: camera.zoomEnd - camera.zoomStart,
      focusX: camera.focusXEnd - camera.focusX,
      focusY: camera.focusYEnd - camera.focusY,
    };
    const magnitude = Math.max(Math.abs(delta.zoom), Math.abs(delta.focusX), Math.abs(delta.focusY));
    if (magnitude < 1e-5) splitFailures.push({ cutId, panel: index + 1, reason: "static-panel-camera" });
    return { panel: index + 1, role: panel.role, ...camera, delta, movementMagnitude: magnitude };
  });
  const signatures = new Set(cameras.map((camera) => JSON.stringify([
    camera.zoomStart, camera.zoomEnd, camera.focusX, camera.focusY, camera.focusXEnd, camera.focusYEnd,
  ])));
  if (signatures.size !== cameras.length) splitFailures.push({ cutId, reason: "duplicated-panel-camera" });
  if (layout.composition !== "post-composite" || layout.separatorColor !== "black") {
    splitFailures.push({ cutId, reason: "separator-not-post-composited-black" });
  }
  if (Math.abs(layout.separatorWidthRatio - 0.0145) > 0.0002) {
    splitFailures.push({ cutId, reason: "separator-ratio-mismatch", actual: layout.separatorWidthRatio });
  }
  splitAudits.push({ cutId, type: layout.type, composition: layout.composition, gutter: layout.gutter, separatorWidthRatio: layout.separatorWidthRatio, cameras });
}

const gates = {
  referencePlateSample: reference.summary?.approvedPlateMomentCount === 13,
  referenceSplitSample: reference.summary?.approvedSplitMomentCount === 7,
  referenceLayoutCounts: reference.summary?.splitClassCounts?.["vertical-2"] === 6 && reference.summary?.splitClassCounts?.["story-3"] === 1,
  referenceAllPanelsMoved: reference.summary?.movingPanelRatio === 1,
  plateCount: plateShots.length === expectedPlateTypes.size,
  plateSemantics: plateFailures.length === 0,
  splitSemantics: splitFailures.length === 0,
  bubbleSequence: bubbleAudit.pass === true,
  typography: bubbleAudit.gates?.typography === true,
  noNearRepeat: bubbleAudit.gates?.nearRepeats === true && bubbleAudit.gates?.sameNearPocket === true,
};
const audit = {
  version: "v30-editorial-plates-splits-audit-r1",
  manifestPath,
  referenceAnalysisPath,
  bubbleAuditPath,
  referenceSummary: reference.summary,
  plateAudits: plateShots.map((shot) => ({
    cutId: shot.cutId,
    utteranceId: shot.utteranceIds?.[0],
    type: shot.editorialPlate.type,
    imagePath: shot.imagePath,
    motion: shot.motion,
    characterPolicy: shot.editorialPlate.characterPolicy,
    environmentPolicy: shot.editorialPlate.environmentPolicy,
  })),
  splitAudits,
  failures: { plates: plateFailures, splits: splitFailures },
  bubblePlacementMetrics: bubbleAudit.metrics,
  gates,
  pass: Object.values(gates).every(Boolean),
  createdAt: new Date().toISOString(),
};
await writeFile(outputPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
if (!audit.pass) throw new Error(`V30 editorial audit failed: ${JSON.stringify(audit.failures)}`);
process.stdout.write(`${JSON.stringify({ outputPath, pass: audit.pass, gates, plateAudits: audit.plateAudits, splitAudits }, null, 2)}\n`);
