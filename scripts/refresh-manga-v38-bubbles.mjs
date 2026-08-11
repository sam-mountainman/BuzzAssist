#!/usr/bin/env node
// v38 bubble reflow after the structural changes (R51-R56). Same contract as
// the v36 refresh: camera-aware speaker protection, per-segment page-camera
// visibility windows on split pages, and the speaker-aware panel-page
// overrides (non-speaker faces soft per the user's rule).
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { refreshEpisodeBubbleOverlays } from "../lib/mangaVideoPipeline.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const manifestPath = join(projectDir, "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json");

// R59 invariant: panel-page bubble regions are regenerated from current
// panel geometry on every refresh (see generate-manga-panel-bubble-overrides
// .mjs). Hand-copied coordinates are forbidden — they went stale twice.
const overridesPath = join(projectDir, "canvas/manga-videos/manga-photo-homecoming-001/v39-panel-bubble-overrides.json");
const bubbleOverrides = JSON.parse(await readFile(overridesPath, "utf8")).overrides;

const refreshed = await refreshEpisodeBubbleOverlays({
  projectDir,
  manifestPath,
  refreshAll: true,
  reflowPlacement: true,
  sequenceAware: true,
  placementHistoryDepth: 2,
  bubbleOverrides,
  status: "v38-viewing-feedback-ready",
});
const summary = {
  refreshedOverlayCount: refreshed.refreshed.length,
  faceOverlaps: refreshed.refreshed.filter((entry) => (entry.quality?.faceOverlapRatio ?? 0) > 0).length,
  nearRepeats: refreshed.refreshed.filter((entry) => entry.sequencePlacement?.nearRepeat).length,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
