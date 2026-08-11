#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";
import { executeMangaProductionDag } from "../lib/mangaProductionDag.mjs";

const args = {};
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith("--")) continue;
  const key = token.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) args[key] = true;
  else {
    args[key] = value;
    index += 1;
  }
}
if (!args.dagPath) {
  throw new Error(
    "Usage: node scripts/execute-manga-production-dag.mjs --dag-path <production-dag.json> "
    + "[--state-path <production-state.json>] [--handler-module <runtime.mjs>] [--allow-partial] [--force]",
  );
}
const dagPath = resolve(args.dagPath);
const statePath = resolve(args.statePath || resolve(dirname(dagPath), "production-dag-state.json"));
const dag = JSON.parse(await readFile(dagPath, "utf8"));
let previousState;
try { previousState = JSON.parse(await readFile(statePath, "utf8")); } catch {}
let handlers = {};
if (args.handlerModule) {
  const adapter = await import(`${pathToFileURL(resolve(args.handlerModule)).href}?v=${Date.now()}`);
  handlers = adapter.handlers || adapter.default || {};
  if (!handlers || typeof handlers !== "object") {
    throw new Error("The DAG handler module must export an object as `handlers` or default.");
  }
}
const state = await executeMangaProductionDag({
  dag,
  handlers,
  state: previousState,
  statePath,
  force: args.force === true,
  retryFailed: args.retryFailed !== false,
  maximumAttemptsPerRun: Math.max(1, Math.min(5, Number(args.maximumAttemptsPerRun) || 2)),
});
await writeJsonAtomic(statePath, state);
process.stdout.write(`${JSON.stringify({ dagPath, statePath, summary: state.summary, metrics: state.metrics }, null, 2)}\n`);
if (state.summary.failed > 0 || (!args.allowPartial && state.summary.pending > 0)) process.exitCode = 2;
