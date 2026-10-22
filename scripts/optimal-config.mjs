#!/usr/bin/env node
// 最適構成エンジンの入口（Claude Code / Codex 共通）。結果は JSON で標準出力へ出す。
//
//   node scripts/optimal-config.mjs select --traits examples/optimal-config/traits/koya.json
//   node scripts/optimal-config.mjs select --project-dir <作業中のプロジェクト> [--pack-id <id>]
//   node scripts/optimal-config.mjs gate --model anima [--route otoshigo-hosted] [--traits <file>]
//   node scripts/optimal-config.mjs trial-plan --traits <file>
//   node scripts/optimal-config.mjs trial-metrics --trial <試験の記録.json>
//
// ここは選ぶ・止める・数えるだけで、何も生成しない（有料の呼び出しも、モデルのダウンロードもしない）。
// 生成は運営者の手元か運営者の契約先で、運営者の確認をもらってから動かす。

import { readFileSync } from "node:fs";
import path from "node:path";

import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import { loadOptimalConfigCatalog } from "../lib/optimalConfig/catalog.mjs";
import { assertChannelTraits, readChannelTraits } from "../lib/optimalConfig/channelTraits.mjs";
import { gateModelById, rightsContextFromTraits } from "../lib/optimalConfig/rightsGate.mjs";
import { selectConfig } from "../lib/optimalConfig/selectConfig.mjs";
import { computeTrialMetrics, createTrialPlan, recommendFromTrial } from "../lib/optimalConfig/trialRecord.mjs";

const USAGE = [
  "使い方:",
  "  node scripts/optimal-config.mjs select --traits <traits.json>",
  "  node scripts/optimal-config.mjs select --project-dir <dir> [--pack-id <id>]",
  "  node scripts/optimal-config.mjs gate --model <id> [--route <実行場所>] [--traits <traits.json>] [--use evaluation] [--publish-scope japan-only]",
  "  node scripts/optimal-config.mjs trial-plan --traits <traits.json>",
  "  node scripts/optimal-config.mjs trial-metrics --trial <trial.json>",
].join("\n");

function parseArgs(argv) {
  const [command = "", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) throw new Error(`引数の形が違う: ${arg}\n${USAGE}`);
    const key = arg.slice(2);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${key} には値が要る。\n${USAGE}`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function loadTraits(options) {
  if (options.traits) {
    const read = readChannelTraits({ traitsPath: options.traits });
    return { traits: assertChannelTraits(read.traits), inferred: read.inferred };
  }
  if (options["project-dir"]) {
    const read = readChannelTraits({ projectDir: path.resolve(options["project-dir"]), packId: options["pack-id"] || "" });
    if (read.source.kind === "none") {
      throw new Error("Channel Pack に config/channel-traits.json が無い。examples/optimal-config/traits/ を写して埋めるか、--traits で渡す。");
    }
    return { traits: assertChannelTraits(read.traits), inferred: read.inferred };
  }
  throw new Error(`--traits か --project-dir が要る。\n${USAGE}`);
}

export function runOptimalConfigCommand(argv) {
  const { command, options } = parseArgs(argv);
  const catalog = loadOptimalConfigCatalog(options.catalog ? path.resolve(options.catalog) : undefined);
  if (command === "select") {
    const { traits, inferred } = loadTraits(options);
    return { ok: true, command, inferred, ...selectConfig(traits, { catalog }) };
  }
  if (command === "gate") {
    if (!options.model) throw new Error(`--model が要る。\n${USAGE}`);
    const traits = options.traits ? loadTraits(options).traits : null;
    const context = {
      ...(traits ? rightsContextFromTraits(traits) : {}),
      ...(options.route ? { route: options.route } : {}),
      ...(options.use ? { use: options.use } : {}),
      ...(options["publish-scope"] ? { publishScope: options["publish-scope"] } : {}),
    };
    if (!traits && !context.route) delete context.route;
    const verdicts = gateModelById(catalog, options.model, context);
    return { ok: true, command, modelId: options.model, allowedAnywhere: verdicts.some((verdict) => verdict.allowed), verdicts };
  }
  if (command === "trial-plan") {
    const { traits } = loadTraits(options);
    const selection = selectConfig(traits, { catalog });
    return { ok: true, command, trial: createTrialPlan({ channelId: traits.channelId, candidates: selection.candidates }) };
  }
  if (command === "trial-metrics") {
    if (!options.trial) throw new Error(`--trial が要る。\n${USAGE}`);
    const trial = JSON.parse(readFileSync(path.resolve(options.trial), "utf8"));
    return { ok: true, command, metrics: computeTrialMetrics(trial), recommendation: recommendFromTrial(trial) };
  }
  throw new Error(`知らないコマンド: ${command || "（なし）"}\n${USAGE}`);
}

if (isDirectCli(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(runOptimalConfigCommand(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error?.code || "OPTIMAL_CONFIG_ERROR", error: error instanceof Error ? error.message : String(error), ...(error?.errors ? { errors: error.errors } : {}) }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
