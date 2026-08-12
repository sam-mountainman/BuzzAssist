#!/usr/bin/env node
import { resolve } from "node:path";

import { auditKoyaRenderedCamera } from "../lib/koyaRenderedCameraAudit.mjs";

const args = {};
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith("--")) continue;
  const key = token.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
  const next = process.argv[index + 1];
  if (!next || next.startsWith("--")) args[key] = true;
  else { args[key] = next; index += 1; }
}
if (!args.manifestPath) throw new Error("--manifest-path is required.");
const result = await auditKoyaRenderedCamera({
  projectDir: resolve(args.projectDir || process.cwd()),
  manifestPath: resolve(args.manifestPath),
  videoPath: args.videoPath ? resolve(args.videoPath) : "",
  outputDir: args.outputDir ? resolve(args.outputDir) : "",
  dryRun: args.dryRun === true,
});
process.stdout.write(`${JSON.stringify(result.dryRun
  ? { dryRun: true, planPath: result.planPath, outputPath: result.outputPath }
  : { outputPath: result.outputPath, pass: result.audit.pass, gates: result.audit.gates }, null, 2)}\n`);
if (!result.dryRun && !result.audit.pass) process.exitCode = 2;
