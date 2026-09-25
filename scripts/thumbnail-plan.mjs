#!/usr/bin/env node
// サムネの計画の下書きと検査（ジャンル共通。Claude Code / Codex 共通）
//
//   node scripts/thumbnail-plan.mjs draft --harness <koya-manga-video|narrated-story-video> [--project-dir DIR]
//        [--layout ID] [--job-id ID] [--channel-pack DIR | --channel-config FILE]
//   node scripts/thumbnail-plan.mjs audit --harness <koya-manga-video|narrated-story-video> --plan-path FILE [--plan-path FILE ...]
//        [--project-dir DIR] [--channel-pack DIR | --channel-config FILE] [--job-id ID] [--work-dir DIR] [--contract-path FILE]
//
// 決まりの置き場:
//   koya-manga-video      プロジェクトへ復元した番組正本の thumbnail contract（koya-manga-video.mjs thumbnail-* と同じ出力）
//   narrated-story-video  Channel Pack の narrated-story.json の thumbnail 節。--channel-pack は署名済みの envelope
//                         （受領側の BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY で検証）、--channel-config は署名の無い
//                         narrated-story.json（試行用。final は通らない）。どちらも無ければ --job-id の Job の Pack
//
// draft --job-id は、Job の id・回の id（episodeId）・完成動画の SHA-256 を jobBinding に入れる。
// サムネは Job の成果物にも Receipt の保証にも入れない。final の監査が、記録した結び付けを実在の Job と照合する。
// audit に --plan-path を2つ以上渡すと、1案ずつの検査に加えて、案どうしが読める軸で違うかも見る。
//
// 本体: lib/thumbnailPlan.mjs（ジャンル共通）、lib/thumbnailPlanHarnesses.mjs（ハーネスごとの決まりの置き場）。
// 読むだけで、有料 API・画像生成・モデル呼び出しはしない。
//
// 終了コード: 0 = 済んだ（draft）・通った（audit）/ 2 = 検査に落ちた / 1 = 入力の誤り（使い方は --help）

import { readFile } from "node:fs/promises";
import path from "node:path";

import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import { THUMBNAIL_HARNESS_IDS, openThumbnailHarness } from "../lib/thumbnailPlanHarnesses.mjs";

export const THUMBNAIL_PLAN_CLI_VERSION = "buzzassist-thumbnail-plan-cli-v1";

const VALUE_OPTIONS = new Set([
  "--harness", "--project-dir", "--layout", "--job-id", "--channel-pack", "--channel-config", "--work-dir", "--contract-path",
]);
const REPEATABLE_OPTIONS = new Set(["--plan-path"]);
const FLAG_OPTIONS = new Set(["--help", "-h"]);

export function thumbnailPlanUsage() {
  return [
    "usage:",
    "  node scripts/thumbnail-plan.mjs draft --harness <koya-manga-video|narrated-story-video> [--project-dir DIR] [--layout ID] [--job-id ID] [--channel-pack DIR | --channel-config FILE]",
    "  node scripts/thumbnail-plan.mjs audit --harness <koya-manga-video|narrated-story-video> --plan-path FILE [--plan-path FILE ...] [--project-dir DIR] [--channel-pack DIR | --channel-config FILE] [--job-id ID] [--work-dir DIR] [--contract-path FILE]",
    "exit: 0 = done / passed, 2 = audit failed, 1 = input error",
  ].join("\n");
}

function camel(option) {
  return option.replace(/^--?/u, "").replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
}

/** 引数を読む。知らない引数・値の無い引数は誤りにする（既定値で本処理を走らせない）。 */
export function parseThumbnailPlanArgs(argv = []) {
  const [first = "", ...tail] = argv;
  // 先頭の --help / -h / help は使い方だけを出す（何も読まず、何も走らせない）。
  if (["--help", "-h", "help"].includes(first)) return { action: "", help: true, planPath: [] };
  const action = first;
  const rest = tail;
  const args = { action, planPath: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (FLAG_OPTIONS.has(token)) {
      args.help = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(token) && !REPEATABLE_OPTIONS.has(token)) throw new Error(`知らない引数: ${token}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${token} に値が要る。`);
    index += 1;
    if (REPEATABLE_OPTIONS.has(token)) args[camel(token)].push(value);
    else args[camel(token)] = value;
  }
  return args;
}

function print(stdout, value) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runThumbnailPlanCli({ argv = process.argv.slice(2), stdout = process.stdout, env = process.env, cwd = process.cwd(), harnessOptions = {} } = {}) {
  let args;
  try {
    args = parseThumbnailPlanArgs(argv);
  } catch (error) {
    stdout.write(`${error.message}\n${thumbnailPlanUsage()}\n`);
    return { exitCode: 1 };
  }
  if (args.help || !["draft", "audit"].includes(args.action)) {
    stdout.write(`${args.help ? "" : `不明なアクション: ${args.action || "(なし)"}\n`}${thumbnailPlanUsage()}\n`);
    return { exitCode: args.help ? 0 : 1 };
  }
  if (!THUMBNAIL_HARNESS_IDS.includes(args.harness)) {
    stdout.write(`--harness は ${THUMBNAIL_HARNESS_IDS.join(" / ")} のどれか。\n${thumbnailPlanUsage()}\n`);
    return { exitCode: 1 };
  }
  const projectDir = path.resolve(cwd, args.projectDir || ".");
  const harness = await openThumbnailHarness({
    harnessId: args.harness,
    projectDir,
    channelPack: args.channelPack ? path.resolve(cwd, args.channelPack) : "",
    channelConfig: args.channelConfig ? path.resolve(cwd, args.channelConfig) : "",
    jobId: args.jobId || "",
    workDir: args.workDir ? path.resolve(cwd, args.workDir) : "",
    contractPath: args.contractPath ? path.resolve(cwd, args.contractPath) : "",
    env,
    ...harnessOptions,
  });
  if (args.action === "draft") {
    if (args.planPath.length > 0) throw new Error("draft は --plan-path を取らない（下書きは標準出力に出す）。");
    const draft = await harness.draft({ layout: args.layout, jobId: args.jobId || "" });
    print(stdout, draft);
    return { exitCode: 0, result: draft };
  }
  if (args.planPath.length === 0) {
    stdout.write(`audit には --plan-path が要る。\n${thumbnailPlanUsage()}\n`);
    return { exitCode: 1 };
  }
  if (args.layout) throw new Error("audit は --layout を取らない（配置は計画に書く）。");
  const plans = [];
  for (const file of args.planPath) {
    const planPath = path.resolve(cwd, file);
    plans.push({ planPath, plan: JSON.parse(await readFile(planPath, "utf8")) });
  }
  const results = [];
  for (const entry of plans) results.push({ planPath: entry.planPath, result: await harness.audit(entry.plan) });
  if (plans.length === 1) {
    // 1案なら、ハーネスの検査の結果そのもの（漫画は koya-manga-video.mjs thumbnail-audit と同じ出力）。
    const { result } = results[0];
    print(stdout, result);
    return { exitCode: result.pass ? 0 : 2, result };
  }
  const ideaSet = await harness.auditIdeaSet(plans.map((entry) => ({ plan: entry.plan, label: entry.plan?.idea?.id || path.basename(entry.planPath) })));
  const summary = {
    version: THUMBNAIL_PLAN_CLI_VERSION,
    harnessId: args.harness,
    pass: results.every((entry) => entry.result.pass) && ideaSet.pass,
    plans: results,
    ideaSet,
  };
  print(stdout, summary);
  return { exitCode: summary.pass ? 0 : 2, result: summary };
}

if (isDirectCli(import.meta.url)) {
  runThumbnailPlanCli().then(({ exitCode }) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
