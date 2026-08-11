#!/usr/bin/env node
import { dirname, resolve } from "node:path";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";
import { createMangaProductionDag } from "../lib/mangaProductionDag.mjs";
import { readEpisodeManifest } from "../lib/mangaVideoPipeline.mjs";

const args = {};
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith("--")) continue;
  const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) args[key] = true;
  else {
    args[key] = value;
    index += 1;
  }
}
if (!args.manifestPath) {
  throw new Error("Usage: node scripts/prepare-manga-production-dag.mjs --manifest-path <episode-manifest.json> [--output-path <production-dag.json>]");
}
const manifestPath = resolve(args.manifestPath);
const { manifest } = await readEpisodeManifest({ manifestPath });
const dag = createMangaProductionDag({
  manifest,
  imageModel: args.imageModel || "gpt-image-2",
  profileId: args.profileId || "manga-channel-reference-video-v1",
  sameSpeakerGapSeconds: manifest.video?.sameSpeakerGapSeconds,
  speakerChangeGapSeconds: manifest.video?.speakerChangeGapSeconds,
  emphasisGapSeconds: manifest.video?.emphasisGapSeconds,
});
const outputPath = resolve(args.outputPath || resolve(dirname(manifestPath), "production-dag-v8.json"));
await writeJsonAtomic(outputPath, dag);
const countsByKind = Object.fromEntries([...new Set(dag.nodes.map((node) => node.kind))]
  .sort()
  .map((kind) => [kind, dag.nodes.filter((node) => node.kind === kind).length]));
process.stdout.write(`${JSON.stringify({
  outputPath,
  episodeId: dag.episodeId,
  nodeCount: dag.nodes.length,
  pools: dag.pools,
  paths: dag.paths,
  countsByKind,
}, null, 2)}\n`);
