#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectCanvasRun } from "../lib/canvasRunProjection.mjs";

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (["--input", "--project-dir", "--canvas-dir"].includes(token)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
      args[token.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }
  if (!args.input) throw new Error("--input <canvas-run.json> is required");
  if (!args.projectDir && !args.canvasDir) throw new Error("--project-dir or --canvas-dir is required");
  return args;
}

export async function runCanvasProjectionCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const inputPath = resolve(args.input);
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const result = await projectCanvasRun(
    {
      ...(args.projectDir ? { projectDir: resolve(args.projectDir) } : {}),
      ...(args.canvasDir ? { canvasDir: resolve(args.canvasDir) } : {}),
    },
    input,
    { dryRun: args.dryRun },
  );
  const output = {
    ok: true,
    runId: result.projection.run.runId,
    runFingerprint: result.projection.runFingerprint,
    canvasFile: result.canvasFile,
    stateFile: result.stateFile,
    elementCount: result.projection.elements.length,
    added: result.added,
    updated: result.updated,
    unchanged: result.unchanged,
    removed: result.removed,
    dryRun: result.dryRun,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return output;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : null;
if (invoked && invoked === resolve(fileURLToPath(import.meta.url))) {
  runCanvasProjectionCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}

