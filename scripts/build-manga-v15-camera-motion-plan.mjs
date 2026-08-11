#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { normalizeCameraShotSequence } from "../lib/mangaVideoPipeline.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas", "manga-videos", "manga-photo-homecoming-001");
const manifestPath = join(episodeDir, "episode-manifest.json");
const outputPath = join(episodeDir, "v15-camera-motion-plan.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const utterancesById = new Map((manifest.utterances || []).map((utterance) => [utterance.id, utterance]));
const rows = [];

for (const cut of manifest.cuts || []) {
  const utterances = (cut.utteranceIds || []).map((id) => utterancesById.get(id)).filter(Boolean);
  const shots = normalizeCameraShotSequence(cut, utterances, cut.timing?.durationSeconds);
  for (const shot of shots) {
    const angle = shot.angle || "unspecified";
    const zoomStart = Number(shot.camera?.zoomStart ?? 1);
    const zoomEnd = Number(shot.camera?.zoomEnd ?? 1);
    rows.push({
      cutId: cut.id,
      shotId: shot.id,
      angle,
      viewpoint: angle.includes("left") ? "left" : angle.includes("right") ? "right" : angle.includes("top") ? "top" : "front",
      durationSeconds: shot.durationSeconds,
      imagePath: shot.imagePath,
      zoomStart,
      zoomEnd,
      totalPullPercent: Number(((zoomStart - zoomEnd) * 100).toFixed(4)),
      averagePullPercentPerSecond: Number((((zoomStart - zoomEnd) * 100) / shot.durationSeconds).toFixed(4)),
      easing: shot.camera?.easing,
      isSpatialWideShot: angle === "wide" || angle.endsWith("-wide"),
    });
  }
}
const angleCounts = rows.reduce((counts, row) => {
  counts[row.angle] = (counts[row.angle] || 0) + 1;
  return counts;
}, {});
const plan = {
  version: "v15-current-timing-camera-motion-plan",
  manifestPath,
  videoPath: manifest.outputs?.reviewVideo?.filePath,
  shotCount: rows.length,
  animatedPullOutCount: rows.filter((row) => row.zoomStart > row.zoomEnd).length,
  spatialWideSourceCount: rows.filter((row) => row.isSpatialWideShot).length,
  angleCounts,
  rows,
  createdAt: new Date().toISOString(),
};
await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  outputPath,
  shotCount: plan.shotCount,
  animatedPullOutCount: plan.animatedPullOutCount,
  spatialWideSourceCount: plan.spatialWideSourceCount,
  angleCounts,
}, null, 2)}\n`);
