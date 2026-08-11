#!/usr/bin/env node
import { resolve } from "node:path";

import { auditMangaVideoQuality } from "../lib/mangaVideoQuality.mjs";

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

if (!args.videoPath || !args.manifestPath) {
  throw new Error("Usage: node scripts/audit-manga-video.mjs --video-path <video.mp4> --manifest-path <episode-manifest.json> [--output-path <report.json>]");
}

const numericKeys = [
  "silenceThresholdDb",
  "minimumSilenceSeconds",
  "maxAllowedSilenceSeconds",
  "durationToleranceSeconds",
  "minimumIntegratedLufs",
  "maximumIntegratedLufs",
  "maximumTruePeakDbfs",
];
for (const key of numericKeys) {
  if (args[key] !== undefined) args[key] = Number(args[key]);
}

const report = await auditMangaVideoQuality({
  ...args,
  videoPath: resolve(args.videoPath),
  manifestPath: resolve(args.manifestPath),
  outputPath: args.outputPath ? resolve(args.outputPath) : "",
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.pass) process.exitCode = 2;

