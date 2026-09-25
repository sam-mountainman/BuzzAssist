#!/usr/bin/env node
// 正本スキルの evals を Claude Code と Codex の両方で流し、別ベンダーの新しい文脈で採点する。
//
//   node scripts/skill-evals.mjs [plan]        計画だけ（既定。モデルは呼ばない）
//   node scripts/skill-evals.mjs run --execute  実行する（両ホストの利用枠を使う）
//   node scripts/skill-evals.mjs report         版ごと・ホストごとの合格率を表にする
//
// 本体は lib/skillEvals.mjs。

import os from "node:os";
import path from "node:path";

import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import {
  SKILL_EVAL_HOSTS,
  buildSkillEvalPlan,
  formatSkillEvalReport,
  loadSkillEvalTargets,
  readSkillEvalRecords,
  resolveHostBinary,
  resolveSkillEvalsDir,
  runSkillEvals,
  summarizeSkillEvals,
} from "../lib/skillEvals.mjs";

const HELP = `正本スキルの evals を Claude Code と Codex で流して採点する

  node scripts/skill-evals.mjs [plan] [options]      計画だけ出す（既定。モデルは呼ばない）
  node scripts/skill-evals.mjs run --execute [options] 実行して結果を記録する
  node scripts/skill-evals.mjs report [--skill <id>] [--json]

対象を絞る:
  --skill <id|name>        スキル（繰り返し可）。既定は .agents/skills の正本で evals を持つもの全部
  --eval <id>              eval（繰り返し可。<name>/<id> でも指定できる）
  --limit <n>              先頭から n 件の eval だけ（ホストの数だけ実行される）
  --hosts claude,codex     実行するホスト（既定は両方）

モデルと採点:
  --claude-model <m>       claude -p の --model（既定は CLI の既定）
  --codex-model <m>        codex exec の --model（既定は CLI の既定。config.toml は読まない）
  --claude-effort <level>  claude -p の --effort
  --codex-effort <level>   codex exec の model_reasoning_effort
  --grader <cross|claude|codex>  採点するホスト（既定 cross = 実行したのと別のホスト）

実行:
  --execute                run のときに必須。無ければ計画を出すだけで何も起動しない
  --concurrency <auto|n>   同時実行数（既定 auto: claude は min(10, max(2, コア-2))、codex は 8。上限 16）
  --timeout-ms <n>         実行者1回の時間切れ（既定 15 分。採点者は 10 分）
  --claude-bin <path>      claude の実行ファイル（既定は PATH）
  --codex-bin <path>       codex の実行ファイル（既定は PATH）
  --keep-work              一時ディレクトリ（写し・最終応答）を消さずに残す
  --project-dir <dir>      リポジトリ（既定はカレント）
  --json                   JSON で出す

記録の置き場: BUZZASSIST_LEARNING_DIR/evals、開発用チェックアウトなら docs/learning/evals、
それ以外は ~/.buzzassist/learning/evals。1回の eval 実行ごとに1行（JSONL）。
`;

function parseArgs(argv) {
  const args = { command: "plan", skills: [], evals: [], hosts: null, models: {}, efforts: {}, binaries: {}, grader: "cross", concurrency: "auto", limit: null, execute: false, json: false, keepWork: false, projectDir: null, timeoutMs: null, help: false };
  let index = 0;
  if (argv[0] && !argv[0].startsWith("-")) {
    args.command = argv[0];
    index = 1;
  }
  const valueOf = (token) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${token} には値が要ります`);
    index += 1;
    return value;
  };
  for (; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--execute") args.execute = true;
    else if (token === "--json") args.json = true;
    else if (token === "--keep-work") args.keepWork = true;
    else if (token === "--skill") args.skills.push(valueOf(token));
    else if (token === "--eval") args.evals.push(valueOf(token));
    else if (token === "--hosts") args.hosts = valueOf(token).split(",").map((host) => host.trim()).filter(Boolean);
    else if (token === "--claude-model") args.models.claude = valueOf(token);
    else if (token === "--codex-model") args.models.codex = valueOf(token);
    else if (token === "--claude-effort") args.efforts.claude = valueOf(token);
    else if (token === "--codex-effort") args.efforts.codex = valueOf(token);
    else if (token === "--claude-bin") args.binaries.claude = valueOf(token);
    else if (token === "--codex-bin") args.binaries.codex = valueOf(token);
    else if (token === "--grader") args.grader = valueOf(token);
    else if (token === "--concurrency") args.concurrency = valueOf(token);
    else if (token === "--limit") args.limit = Number.parseInt(valueOf(token), 10);
    else if (token === "--timeout-ms") args.timeoutMs = Number.parseInt(valueOf(token), 10);
    else if (token === "--project-dir") args.projectDir = valueOf(token);
    else throw new Error(`不明な引数: ${token}`);
  }
  if (!["plan", "run", "report"].includes(args.command)) throw new Error(`不明なコマンド: ${args.command}（plan / run / report）`);
  if (args.timeoutMs !== null && (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 1000)) throw new Error("--timeout-ms は 1000 以上の整数にしてください");
  if (args.limit !== null && Number.isNaN(args.limit)) throw new Error("--limit は整数にしてください");
  return args;
}

function shortSha(value) {
  return String(value || "").replace(/^sha256:/u, "").slice(0, 12);
}

function formatPlan(plan, { evalsDir, evalsDirSource, binaries }) {
  const lines = ["スキル評価の計画（モデルは呼びません）", ""];
  const graderLabel = plan.grader === "cross" ? "実行したのと別のホスト（別ベンダー・新しい文脈）" : `${plan.grader}（新しい文脈）`;
  lines.push(`対象 ${plan.skills.length} スキル / ${plan.evalCount} eval / 実行ホスト ${plan.hosts.join(", ")} / 採点 ${graderLabel}`, "");
  for (const skill of plan.skills) {
    lines.push(`  ${skill.skillId} ${skill.version} (${shortSha(skill.contentSha256)})  eval ${skill.evals}${skill.manifestShaMatches ? "" : "  ※manifest の SHA と違う"}`);
  }
  lines.push("", "呼び出し回数の見込み");
  for (const host of SKILL_EVAL_HOSTS) {
    const calls = plan.calls[host];
    if (!calls.total) continue;
    const model = plan.models[host] || "CLI の既定";
    const effort = plan.efforts[host] || "既定";
    const binary = binaries[host] || "見つからない（PATH か --" + host + "-bin）";
    lines.push(`  ${host}: 実行 ${calls.executor} + 採点 ${calls.grader} = ${calls.total} 回（モデル ${model}、effort ${effort}、同時 ${plan.concurrency[host]}、実行ファイル ${binary}）`);
  }
  lines.push(`  合計 ${plan.totalCalls} 回`, "");
  lines.push(`記録の置き場: ${evalsDir}（${evalsDirSource === "env" ? "BUZZASSIST_LEARNING_DIR" : evalsDirSource === "development-checkout" ? "開発用チェックアウト" : "運営者の端末"}）`);
  if (plan.warnings.length > 0) {
    lines.push("", "注意:");
    for (const warning of plan.warnings) lines.push(`  - ${warning}`);
  }
  lines.push("", "実行するには run --execute を付けます（両ホストの利用枠を使います）。");
  return `${lines.join("\n")}\n`;
}

export async function runSkillEvalsCli(argv = process.argv.slice(2), { env = process.env, stdout = process.stdout, stderr = process.stderr, homeDir = os.homedir(), workRoot, platform = process.platform } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    stdout.write(HELP);
    return { exitCode: 0 };
  }
  const projectDir = path.resolve(args.projectDir || process.cwd());
  const evalsLocation = resolveSkillEvalsDir({ repoRoot: projectDir, env, homeDir });

  if (args.command === "report") {
    const { records, malformed } = readSkillEvalRecords(evalsLocation.dir);
    const summary = summarizeSkillEvals(records, { skills: args.skills });
    if (args.json) stdout.write(`${JSON.stringify({ evalsDir: evalsLocation.dir, records: records.length, malformed, ...summary }, null, 2)}\n`);
    else stdout.write(formatSkillEvalReport(summary, { recordsRead: records.length, malformed, evalsDir: evalsLocation.dir }));
    return { exitCode: 0, summary };
  }

  const loaded = await loadSkillEvalTargets({ projectDir, skills: args.skills, evals: args.evals });
  const plan = buildSkillEvalPlan(loaded, {
    hosts: args.hosts || SKILL_EVAL_HOSTS,
    grader: args.grader,
    models: args.models,
    efforts: args.efforts,
    concurrency: args.concurrency,
    limit: args.limit,
  });
  const binaries = Object.fromEntries(SKILL_EVAL_HOSTS.map((host) => [host, resolveHostBinary(host, { env, platform, override: args.binaries[host] })]));

  if (args.command === "plan" || !args.execute) {
    if (args.json) stdout.write(`${JSON.stringify({ ...plan, evalsDir: evalsLocation.dir, binaries }, null, 2)}\n`);
    else stdout.write(formatPlan(plan, { evalsDir: evalsLocation.dir, evalsDirSource: evalsLocation.source, binaries }));
    if (args.command === "run") stderr.write("--execute が無いので実行しません（計画だけ出しました）。\n");
    return { exitCode: 0, plan };
  }

  const result = await runSkillEvals({
    loaded,
    plan,
    execute: true,
    env,
    homeDir,
    workRoot: workRoot || os.tmpdir(),
    binaries: args.binaries,
    timeouts: args.timeoutMs ? { executorMs: args.timeoutMs } : {},
    keepWork: args.keepWork,
    platform,
    onProgress: (event) => {
      if (args.json) return;
      if (event.type === "started") {
        stdout.write(`▶ ${event.job.skillId} ${event.job.evalId} ${event.role === "executor" ? `実行 ${event.job.executor.host}` : `採点 ${event.job.grader.host}`}\n`);
      } else {
        const record = event.record;
        const mark = record.status === "graded" ? (record.allPassed ? "✅" : "❌") : "⚠️";
        const detail = record.status === "graded" ? `${record.passed}/${record.total}` : `${record.status}${record.reason ? ` ${record.reason}` : ""}`;
        stdout.write(`${mark} ${record.skillId} ${record.evalId} ${record.host}→採点 ${record.grader.host}: ${detail}\n`);
      }
    },
  });
  const counts = {
    graded: result.records.filter((record) => record.status === "graded").length,
    allPassed: result.records.filter((record) => record.allPassed).length,
    errors: result.records.filter((record) => record.status !== "graded").length,
  };
  if (args.json) {
    stdout.write(`${JSON.stringify({ runId: result.runId, resultsPath: result.resultsPath, counts, halted: result.halted, cliVersions: result.cliVersions, workDir: result.workDir }, null, 2)}\n`);
  } else {
    stdout.write(`\n記録: ${result.resultsPath}\n採点 ${counts.graded} 件（全項目合格 ${counts.allPassed}）/ 採点できなかった ${counts.errors} 件\n`);
    for (const [host, reason] of Object.entries(result.halted)) stdout.write(`⚠️ ${host} は利用枠か認証で止まったため、残りを流していません: ${reason}\n`);
    if (result.workDir) stdout.write(`一時ディレクトリを残しました: ${result.workDir}\n`);
    stdout.write("集計: node scripts/skill-evals.mjs report\n");
  }
  return { exitCode: counts.errors > 0 ? 1 : 0, result };
}

if (isDirectCli(import.meta.url)) {
  runSkillEvalsCli().then(({ exitCode }) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
