#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas/manga-videos/manga-photo-homecoming-001");
const manifestPath = join(episodeDir, "episode-manifest.json");
const outputPath = join(episodeDir, "v29-bubble-sequence-layout-audit.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

function pocket(center) {
  const lane = center.x < 0.38 ? "left" : center.x > 0.62 ? "right" : "center";
  const band = center.y < 0.38 ? "upper" : center.y > 0.68 ? "lower" : "middle";
  return { lane, band, key: `${lane}-${band}` };
}

const events = [];
for (const utterance of manifest.utterances || []) {
  const spec = JSON.parse(await readFile(utterance.overlaySpecPath, "utf8"));
  const width = Number(spec.imageSize?.width || spec.plan?.width || manifest.video?.width || 1920);
  const height = Number(spec.imageSize?.height || spec.plan?.height || manifest.video?.height || 1080);
  const entries = Array.isArray(utterance.bubbleSegments) && utterance.bubbleSegments.length > 0
    ? utterance.bubbleSegments
    : [{
        id: utterance.id,
        bounds: spec.plan?.bubbles?.[0]?.bounds,
        quality: spec.quality?.[0],
        sequencePlacement: spec.plan?.bubbles?.[0]?.sequencePlacement,
      }];
  for (const [segmentIndex, entry] of entries.entries()) {
    const bounds = entry.bounds;
    if (!bounds) throw new Error(`Missing V29 bounds for ${entry.id || utterance.id}`);
    const center = {
      x: (Number(bounds.x) + Number(bounds.width) / 2) / width,
      y: (Number(bounds.y) + Number(bounds.height) / 2) / height,
    };
    events.push({
      index: events.length + 1,
      id: entry.id || utterance.id,
      utteranceId: utterance.id,
      segmentIndex: entries.length > 1 ? segmentIndex + 1 : null,
      cutId: utterance.cutId,
      preset: utterance.preset,
      bounds,
      normalizedCenter: center,
      pocket: pocket(center),
      quality: entry.quality || spec.quality?.[segmentIndex] || null,
      sequencePlacement: entry.sequencePlacement || spec.plan?.bubbles?.[0]?.sequencePlacement || null,
    });
  }
}

const transitions = events.slice(1).map((event, index) => {
  const previous = events[index];
  const centerDistanceRatio = Math.hypot(
    event.normalizedCenter.x - previous.normalizedCenter.x,
    event.normalizedCenter.y - previous.normalizedCenter.y,
  );
  return {
    from: previous.id,
    to: event.id,
    centerDistanceRatio,
    laneChanged: previous.pocket.lane !== event.pocket.lane,
    bandChanged: previous.pocket.band !== event.pocket.band,
    samePocket: previous.pocket.key === event.pocket.key,
    fromPreset: previous.preset,
    toPreset: event.preset,
  };
});

const failures = {
  nearRepeats: transitions.filter((entry) => entry.centerDistanceRatio < 0.12),
  sameNearPocket: transitions.filter((entry) => entry.samePocket && entry.centerDistanceRatio < 0.20),
  narrationSameNearPocket: transitions.filter((entry) => (
    entry.samePocket
    && entry.centerDistanceRatio < 0.20
    && (entry.fromPreset === "narration" || entry.toPreset === "narration")
  )),
  typography: events.filter((entry) => (
    !entry.quality
    || entry.quality.overflow
    || entry.quality.textLoss
    || entry.quality.tooSmall
    || Number(entry.quality.edgeClearanceRatio) < 0.9
  )),
  faceOverlap: events.filter((entry) => Number(entry.quality?.faceOverlapRatio || 0) > 0.005),
  // The references routinely place vertical balloons over clothing/shoulders while
  // preserving faces, mouths, text and evidence props. Treat body overlap as a
  // soft composition cost; only fail when most of the balloon loses clean space.
  importantOverlap: events.filter((entry) => Number(entry.quality?.importantOverlapRatio || 0) > 0.65),
  missingSequenceHistory: events.slice(1).filter((entry) => (
    Number(entry.sequencePlacement?.historyDepth || 0) < 1
  )),
};
const ratio = (count, total) => total > 0 ? count / total : 0;
const distances = transitions.map((entry) => entry.centerDistanceRatio).sort((a, b) => a - b);
const audit = {
  version: "v29-bubble-sequence-layout-audit-r1",
  manifestPath,
  referenceAnalysisPath: manifest.production?.bubblePlacementGrammar?.referenceAnalysisPath,
  policy: manifest.production?.bubblePlacementGrammar?.rules,
  collisionPolicy: {
    faceOverlapMaximumRatio: 0.005,
    importantRegionOverlapMaximumRatio: 0.65,
    bodyOverlapTreatment: "soft composition cost, matching reference-video shoulder/clothing overlays",
  },
  eventCount: events.length,
  transitionCount: transitions.length,
  events,
  transitions,
  metrics: {
    minimumCenterDistanceRatio: distances[0] ?? null,
    medianCenterDistanceRatio: distances.length ? distances[Math.floor(distances.length / 2)] : null,
    laneChangeRate: ratio(transitions.filter((entry) => entry.laneChanged).length, transitions.length),
    bandChangeRate: ratio(transitions.filter((entry) => entry.bandChanged).length, transitions.length),
    samePocketRate: ratio(transitions.filter((entry) => entry.samePocket).length, transitions.length),
    laneCounts: Object.fromEntries(["left", "center", "right"].map((name) => [
      name,
      events.filter((entry) => entry.pocket.lane === name).length,
    ])),
    bandCounts: Object.fromEntries(["upper", "middle", "lower"].map((name) => [
      name,
      events.filter((entry) => entry.pocket.band === name).length,
    ])),
  },
  failures,
  gates: Object.fromEntries(Object.entries(failures).map(([key, rows]) => [key, rows.length === 0])),
};
audit.pass = Object.values(audit.gates).every(Boolean) && events.length >= 35;
await writeFile(outputPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
if (!audit.pass) throw new Error(`V29 placement audit failed: ${JSON.stringify(audit.failures)}`);
process.stdout.write(`${JSON.stringify({
  outputPath,
  pass: audit.pass,
  eventCount: audit.eventCount,
  transitionCount: audit.transitionCount,
  metrics: audit.metrics,
  gates: audit.gates,
}, null, 2)}\n`);
