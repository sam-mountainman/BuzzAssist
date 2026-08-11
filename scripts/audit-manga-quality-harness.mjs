#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";
import {
  auditMangaPreflight,
  createMangaQualityContract,
  createMangaQualityLoopState,
} from "../lib/mangaQualityHarness.mjs";

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
  throw new Error([
    "Usage: node scripts/audit-manga-quality-harness.mjs",
    "--manifest-path <episode-manifest.json>",
    "[--stage planning|final] [--output-dir <dir>]",
    "[--channel-directives <json>] [--overrides <json>] [--generator-id <id>]",
  ].join(" "));
}

async function readJson(filePath, fallback = {}) {
  if (!filePath) return fallback;
  return JSON.parse(await readFile(resolve(filePath), "utf8"));
}

const manifestPath = resolve(args.manifestPath);
const manifest = await readJson(manifestPath);
const channelDirectives = await readJson(args.channelDirectives, manifest.production?.channelDirectives || {});
const overrides = await readJson(args.overrides, manifest.production?.qualityHarness || {});
const contract = createMangaQualityContract({ manifest, channelDirectives, overrides });
const report = auditMangaPreflight({ manifest, contract, stage: args.stage || "planning" });
const state = createMangaQualityLoopState({
  contract,
  episodeId: manifest.id,
  generatorId: args.generatorId || "production-generator",
});
const outputDir = resolve(args.outputDir || join(dirname(manifestPath), "quality-harness"));
await mkdir(outputDir, { recursive: true });
const paths = {
  contract: join(outputDir, "quality-contract.json"),
  preflight: join(outputDir, `preflight-${report.stage}.json`),
  state: join(outputDir, "quality-loop-state.json"),
};
await Promise.all([
  writeJsonAtomic(paths.contract, contract),
  writeJsonAtomic(paths.preflight, report),
  writeJsonAtomic(paths.state, state),
]);

process.stdout.write(`${JSON.stringify({
  episodeId: manifest.id,
  pass: report.pass,
  contractDigest: contract.digest,
  failedGateIds: report.failedGateIds,
  paths,
}, null, 2)}\n`);
if (!report.pass) process.exitCode = 2;
