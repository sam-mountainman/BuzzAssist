#!/usr/bin/env node
import { resolve } from "node:path";

import { runMangaScriptImagePipeline } from "../lib/mangaScriptImagePipeline.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function usage() {
  return `Usage:
  node scripts/generate-manga-script-images.mjs --script-path <script.txt> [--episode-id <id>]

Options:
  --project-dir <dir>        Active project (default: cwd)
  --episode-id <id>          Stable output id; reruns reuse matching completed jobs
  --model <model>            Default: gpt-image-2-codex
  --concurrency <mode>       auto (default), any positive integer, or unlimited (validation only)
  --qa-concurrency <n>       Separate visual-QA pool; default: 12
  --max-retries <0-3>       Retry only QA failures; default: 1
  --qa-model <model>         Optional model override for fresh blind Codex visual QA
  --qa-command <command>     Optional semantic image judge. Receives JSON in BUZZASSIST_IMAGE_QA_INPUT and prints {"pass":boolean,"issues":[]}
  --no-semantic-qa           Disable the default ephemeral Codex vision judge (technical QA still runs)
  --candidate-count <1-10>   New-character design candidates; default: 3

New characters intentionally pause once after candidate generation. Approve one candidate with the existing character workflow, then rerun this same command. Existing characters complete without a pause.`;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}
if (!args.scriptPath) throw new Error(`${usage()}\n\n--script-path is required.`);

const result = await runMangaScriptImagePipeline({
  projectDir: resolve(args.projectDir || process.cwd()),
  scriptPath: resolve(args.scriptPath),
  episodeId: args.episodeId,
  title: args.title,
  model: args.model || "gpt-image-2-codex",
  concurrency: args.concurrency === undefined ? "auto" : args.concurrency,
  qaConcurrency: args.qaConcurrency === undefined ? 12 : Number(args.qaConcurrency),
  maxRetries: args.maxRetries === undefined ? 1 : Number(args.maxRetries),
  candidateCount: args.candidateCount === undefined ? 3 : Number(args.candidateCount),
  qaCommand: args.qaCommand,
  qaModel: args.qaModel,
  qaTimeoutMs: args.qaTimeoutMs === undefined ? undefined : Number(args.qaTimeoutMs),
  autoSemanticQa: args.noSemanticQa !== true,
});

const output = {
  status: result.status,
  episodeId: result.episodeId,
  workflowId: result.workflowId,
  planPath: result.planPath,
  ledgerPath: result.ledgerPath,
  summary: result.ledger?.summary,
  cast: result.cast,
  message: result.message,
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
if (result.status === "failed") process.exitCode = 1;
