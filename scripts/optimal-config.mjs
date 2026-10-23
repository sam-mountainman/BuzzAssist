#!/usr/bin/env node
// 最適構成エンジンの入口（Claude Code / Codex 共通）。結果は JSON で標準出力へ出す。
//
//   node scripts/optimal-config.mjs select --traits examples/optimal-config/traits/fixed-cast-manga.json
//   node scripts/optimal-config.mjs select --project-dir <作業中のプロジェクト> [--pack-id <id>]
//   node scripts/optimal-config.mjs gate --model anima [--route otoshigo-hosted] [--traits <file>]
//   node scripts/optimal-config.mjs trial-plan --traits <file>
//   node scripts/optimal-config.mjs trial-metrics --trial <試験の記録.json>
//   node scripts/optimal-config.mjs explain --traits <file> --ideal <理想.json> [--trial <試験の記録.json>]
//   node scripts/optimal-config.mjs adopt --traits <file> --trial <file> --production A --backup B --reviewer "$REVIEWER" --human-verified
//   node scripts/optimal-config.mjs adopted [--project-dir <dir>]
//
// adopt は運営者が決めた本番と予備を記録する。人の確認として数えるのは、決めた人が自分の対話端末から
// --human-verified を付けたときだけ（エージェントは打たない。harness-guard-hook が止める）。機械が書くなら
// --agent-attested で提案として残り、制作の入口（run-video-harness）はその提案を使わずに止まる。
//
// ここは選ぶ・止める・数えるだけで、何も生成しない（有料の呼び出しも、モデルのダウンロードもしない）。
// 生成は運営者の手元か運営者の契約先で、運営者の確認をもらってから動かす。

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import { loadOptimalConfigCatalog } from "../lib/optimalConfig/catalog.mjs";
import {
  ADOPTION_HUMAN_VERIFIED,
  appendAdoptionDecision,
  buildAdoptionDecision,
  humanAdoptCommand,
  readAdoptedConfig,
  resolveAdoptionPath,
  resolvePackAdoptionPath,
  signAdoptionDecision,
} from "../lib/optimalConfig/adoption.mjs";
import { assertChannelTraits, readChannelTraits } from "../lib/optimalConfig/channelTraits.mjs";
import { explainIdeal } from "../lib/optimalConfig/explainIdeal.mjs";
import { createManualHandoff, importManualHandoff } from "../lib/optimalConfig/execution/manualHandoff.mjs";
import { detectOllamaImage } from "../lib/optimalConfig/execution/ollamaLocalImage.mjs";
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
  "  node scripts/optimal-config.mjs explain --traits <traits.json> --ideal <理想.json> [--trial <trial.json>]",
  "      理想（artStyle / motion / identityLock / budgetMonthlyJpy / models / places / monthlyAdoptedSeconds）をそのまま",
  "      構成にできるか。できなければ理由（予算・機材・権利）と近い代わりの案を返す（黙って置き換えない）",
  "  node scripts/optimal-config.mjs adopt --traits <traits.json> --trial <trial.json> --production <候補ID> --backup <候補ID>",
  "      --reviewer \"$REVIEWER\" (--human-verified | --agent-attested) [--project-dir <dir>] [--to project|channel-pack] [--pack-id <id>]",
  "      [--note <一言>] [--signing-key-path <Ed25519 秘密鍵>]",
  "      （REVIEWER は決めた人の名前。例: REVIEWER=\"$(id -un)\"）",
  "  node scripts/optimal-config.mjs adopted [--project-dir <dir>] [--pack-id <id>]",
  "  node scripts/optimal-config.mjs local-image-check [--model flux2-klein-4b|z-image-turbo] [--ollama-model <名前>] [--ollama-url http://127.0.0.1:11434]",
  "      手元の Ollama が動いていてモデルが入っているかを読むだけで確かめる（ダウンロードしない）",
  "  node scripts/optimal-config.mjs handoff-create --service google-flow --cuts <cuts.json> --work-dir <dir> [--handoff-id <id>] [--channel <id>]",
  "  node scripts/optimal-config.mjs handoff-import --slot <slot.json>",
].join("\n");

const BOOLEAN_FLAGS = new Set(["human-verified", "agent-attested"]);

function parseArgs(argv) {
  const [command = "", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) throw new Error(`引数の形が違う: ${arg}\n${USAGE}`);
    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      options[key] = true;
      continue;
    }
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function interactiveTerminal() {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function runAdopt(options, { catalog, isInteractive = interactiveTerminal(), attest = null, now } = {}) {
  for (const key of ["traits", "trial", "production", "backup"]) {
    if (!options[key]) throw new Error(`adopt には --${key} が要る。\n${USAGE}`);
  }
  const traitsPath = path.resolve(options.traits);
  const trialPath = path.resolve(options.trial);
  const projectDir = path.resolve(options["project-dir"] || process.cwd());
  const next = humanAdoptCommand({
    traitsPath,
    trialPath,
    production: String(options.production).toUpperCase(),
    backup: String(options.backup).toUpperCase(),
    projectDir: options["project-dir"] ? projectDir : "",
    note: options.note || "",
  });
  const attestationFor = attest || (await import("./harness-learn.mjs")).attestationFor;
  const verdict = attestationFor({
    reviewer: options.reviewer || "",
    isInteractive,
    agentAttested: options["agent-attested"] === true,
    humanVerified: options["human-verified"] === true,
  });
  if (!verdict.ok) {
    const error = new Error(`${verdict.message} 決めた人が自分の端末で次を打つ: ${next}`);
    error.code = "OPTIMAL_CONFIG_ADOPTION_ATTESTATION";
    error.next = next;
    throw error;
  }
  const rawTraits = readChannelTraits({ traitsPath }).traits;
  const trialBytes = readFileSync(trialPath);
  const trial = JSON.parse(trialBytes.toString("utf8"));
  let decision = buildAdoptionDecision({
    traits: rawTraits,
    trial,
    trialSha256: sha256(trialBytes),
    production: options.production,
    backup: options.backup,
    attestation: verdict.attestation,
    note: options.note || "",
    catalog,
    ...(now ? { now } : {}),
  });
  if (options["signing-key-path"]) decision = await signAdoptionDecision(decision, { privateKeyPath: options["signing-key-path"] });
  const to = options.to || "project";
  let filePath;
  if (options.out) filePath = path.resolve(options.out);
  else if (to === "project") filePath = resolveAdoptionPath(projectDir);
  else if (to === "channel-pack") {
    filePath = resolvePackAdoptionPath(projectDir, options["pack-id"] || "");
    if (!filePath) throw new Error("Channel Pack の元フォルダが見つからない（channel-packs/<id>/ か BUZZASSIST_CHANNEL_PACK）。--to project で作業フォルダへ書く。");
  } else throw new Error("--to は project か channel-pack。");
  const written = await appendAdoptionDecision({ filePath, decision });
  const effective = written.decision.approval.attestedBy === ADOPTION_HUMAN_VERIFIED;
  return {
    ok: true,
    command: "adopt",
    effective,
    filePath: written.filePath,
    decision: written.decision,
    detail: effective
      ? `本番 ${written.decision.production.candidateId}・予備 ${written.decision.backup.candidateId} を ${written.decision.approval.reviewer} の確認つきで記録した。run-video-harness はこの作業フォルダでこの構成を使う。`
        + (to === "project" ? " 配る Pack に入れるなら、Pack の元フォルダの config/optimal-config-adoption.json に写して署名し直す。" : " Pack の元フォルダに書いた。配るには署名し直す。")
      : `提案（${written.decision.approval.attestedBy}）として残した。人の確認がまだなので、run-video-harness はこの作業フォルダで止まる。決めた人が自分の端末で次を打つ: ${next}`,
    ...(effective ? {} : { next }),
  };
}

export async function runOptimalConfigCommand(argv, runtime = {}) {
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
  if (command === "explain") {
    if (!options.ideal) throw new Error(`--ideal が要る。\n${USAGE}`);
    const { traits } = loadTraits(options);
    const ideal = JSON.parse(readFileSync(path.resolve(options.ideal), "utf8"));
    const trial = options.trial ? JSON.parse(readFileSync(path.resolve(options.trial), "utf8")) : null;
    return { ok: true, command, ...explainIdeal(traits, ideal, { catalog, trial }) };
  }
  if (command === "local-image-check") {
    return { ok: true, command, ...(await detectOllamaImage({ catalogModelId: options.model || "flux2-klein-4b", modelName: options["ollama-model"] || "", ...(options["ollama-url"] ? { baseUrl: options["ollama-url"] } : {}), ...(runtime.fetchImpl ? { fetchImpl: runtime.fetchImpl } : {}) })) };
  }
  if (command === "handoff-create") {
    for (const key of ["cuts", "work-dir"]) if (!options[key]) throw new Error(`handoff-create には --${key} が要る。\n${USAGE}`);
    const cuts = JSON.parse(readFileSync(path.resolve(options.cuts), "utf8"));
    const created = await createManualHandoff({ service: options.service || "google-flow", cuts: Array.isArray(cuts) ? cuts : cuts.cuts, workDir: options["work-dir"], handoffId: options["handoff-id"] || "", channelId: options.channel || "" });
    return { ok: true, command, ...created };
  }
  if (command === "handoff-import") {
    if (!options.slot) throw new Error(`handoff-import には --slot が要る。\n${USAGE}`);
    return { ok: true, command, ...(await importManualHandoff({ slotPath: options.slot })) };
  }
  if (command === "adopt") return runAdopt(options, { catalog, ...runtime });
  if (command === "adopted") {
    const read = await readAdoptedConfig({ projectDir: path.resolve(options["project-dir"] || process.cwd()), packId: options["pack-id"] || "" });
    return { ok: true, command, ...read };
  }
  throw new Error(`知らないコマンド: ${command || "（なし）"}\n${USAGE}`);
}

if (isDirectCli(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await runOptimalConfigCommand(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      code: error?.code || "OPTIMAL_CONFIG_ERROR",
      error: error instanceof Error ? error.message : String(error),
      ...(error?.errors ? { errors: error.errors } : {}),
      ...(error?.problems ? { problems: error.problems } : {}),
      ...(error?.next ? { next: error.next } : {}),
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
