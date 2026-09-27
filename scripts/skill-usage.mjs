#!/usr/bin/env node
// スキルの棚卸し（読むだけの入口。Claude Code / Codex 共通）
//
//   node scripts/skill-usage.mjs                     直近30日の使われ方（report）
//   node scripts/skill-usage.mjs report --days 90 --json
//   node scripts/skill-usage.mjs review-sheet --output <file>
//   node scripts/skill-usage.mjs record-review --note "..."
//
// 定量（会話の記録から、どのスキルが何回・いつ使われたか）と、定性の判定（別の文脈の LLM に
// 「このハーネスの中でこのスキルは要るか」を判定させる）を頼むシートまで。外部モデルは呼ばない。
// 会話の記録には何も書かない。書くのは record-review の手元の記録（~/.buzzassist/learning/）だけ。
// 本体は lib/skillUsage.mjs。

import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import {
  DEFAULT_MAX_BYTES_PER_HOST,
  DEFAULT_MAX_SECONDS_PER_HOST,
  DEFAULT_USAGE_WINDOW_DAYS,
  SKILL_REVIEW_INTERVAL_DAYS,
  SKILL_USAGE_HOSTS,
  buildSkillReviewSheet,
  buildSkillUsageReport,
  defaultTranscriptRoots,
  formatLocalDate,
  loadSkillUsageCatalog,
  recordSkillReview,
  renderSkillUsageReport,
  resolveUsageWindow,
} from "../lib/skillUsage.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMMANDS = new Set(["report", "review-sheet", "record-review"]);
const FLAGS = new Set(["--json", "--help", "-h"]);
const VALUE_OPTIONS = new Set([
  "--days", "--since", "--until", "--host", "--max-gib", "--max-seconds", "--scanner",
  "--project-dir", "--claude-config-dir", "--codex-home", "--usage", "--output", "--note", "--sheet",
]);

export const USAGE = `Usage:
  node scripts/skill-usage.mjs [report] [期間] [--host claude|codex|all] [--json]
  node scripts/skill-usage.mjs review-sheet [期間] [--usage <report.json>] [--output <file>] [--json]
  node scripts/skill-usage.mjs record-review [--note <text>] [--sheet <file>]

期間（既定は直近 ${DEFAULT_USAGE_WINDOW_DAYS} 日）:
  --days N | --since YYYY-MM-DD   [--until YYYY-MM-DD]

report        会話の記録から BuzzAssist のスキルの使われ方を数える（読むだけ。本文は保存しない）
              Claude Code: Skill の道具・/コマンド・SKILL.md を読んだ道具の呼び出し（~/.claude/projects）
              Codex: コマンドの実行で SKILL.md を読んだ記録（~/.codex/sessions・archived_sessions）
review-sheet  要不要を別の文脈の LLM に判定させるためのシート（外部モデルは呼ばない）
record-review 棚卸しをした日を手元（~/.buzzassist/learning/skill-reviews.jsonl）に残す。
              doctor は前の棚卸しから ${SKILL_REVIEW_INTERVAL_DAYS} 日以上たつと知らせる（記録が無ければ黙る）

上限（ホストごと。当たったら「数え切れていない」と出し、数は下限になる）:
  --max-gib N      読む量（既定 ${DEFAULT_MAX_BYTES_PER_HOST / 1024 ** 3}）
  --max-seconds N  時間（既定 ${DEFAULT_MAX_SECONDS_PER_HOST}）
  --scanner auto|ripgrep|node  行の絞り込み（既定 auto: rg があれば rg）

置き場の指定: --project-dir（在庫 manifest のある BuzzAssist）、--claude-config-dir（既定 CLAUDE_CONFIG_DIR か ~/.claude）、
  --codex-home（既定 CODEX_HOME か ~/.codex）
`;

export function parseSkillUsageArgs(argv) {
  const args = { command: "report", json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (index === 0 && !token.startsWith("-")) {
      if (!COMMANDS.has(token)) throw new Error(`未知のコマンド: ${token}（report | review-sheet | record-review）`);
      args.command = token;
      continue;
    }
    if (FLAGS.has(token)) {
      if (token === "--json") args.json = true;
      else args.help = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(token)) {
      // 知らない引数を黙って無視すると、指定したつもりの期間や置き場で数えたと誤解する。
      throw new Error(`未知の引数: ${token}\n${USAGE}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${token} に値が要る`);
    index += 1;
    const key = token.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    args[key] = value;
  }
  return args;
}

function hostsFrom(value) {
  if (!value || value === "all") return [...SKILL_USAGE_HOSTS];
  const hosts = String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const host of hosts) {
    if (!SKILL_USAGE_HOSTS.includes(host)) throw new Error(`--host は ${SKILL_USAGE_HOSTS.join(" / ")} / all: ${host}`);
  }
  return hosts;
}

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} は 0 以上の数: ${value}`);
  return number;
}

function writeFileAtomic(file, text) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, "utf8");
  fs.renameSync(temporary, target);
  return target;
}

async function usageReport(args, { env, homeDir, now }) {
  if (args.usage) {
    try {
      return JSON.parse(fs.readFileSync(path.resolve(args.usage), "utf8"));
    } catch (error) {
      throw new Error(`--usage の集計を読めない: ${args.usage}: ${error.message}`);
    }
  }
  const window = resolveUsageWindow({ since: args.since || "", until: args.until || "", days: args.days, now });
  const roots = defaultTranscriptRoots({
    env: {
      ...env,
      ...(args.claudeConfigDir ? { CLAUDE_CONFIG_DIR: path.resolve(args.claudeConfigDir) } : {}),
      ...(args.codexHome ? { CODEX_HOME: path.resolve(args.codexHome) } : {}),
    },
    homeDir,
  });
  return buildSkillUsageReport({
    repoRoot: path.resolve(args.projectDir || REPO_ROOT),
    hosts: hostsFrom(args.host),
    window,
    env,
    homeDir,
    roots,
    maxBytes: args.maxGib !== undefined ? positiveNumber(args.maxGib, "--max-gib") * 1024 ** 3 : DEFAULT_MAX_BYTES_PER_HOST,
    maxSeconds: args.maxSeconds !== undefined ? positiveNumber(args.maxSeconds, "--max-seconds") : DEFAULT_MAX_SECONDS_PER_HOST,
    scanner: args.scanner || "",
    now,
  });
}

export async function runSkillUsageCli(argv = process.argv.slice(2), { env = process.env, homeDir = homedir(), now = new Date(), stdout = process.stdout, stderr = process.stderr } = {}) {
  const args = parseSkillUsageArgs(argv);
  if (args.help) {
    stdout.write(USAGE);
    return null;
  }
  const repoRoot = path.resolve(args.projectDir || REPO_ROOT);

  if (args.command === "record-review") {
    const catalog = loadSkillUsageCatalog({ repoRoot });
    const result = recordSkillReview({ catalog, env, homeDir, now, note: args.note || "", sheetPath: args.sheet ? path.resolve(args.sheet) : "" });
    if (args.json) stdout.write(`${JSON.stringify({ ok: true, path: result.path, record: result.record }, null, 2)}\n`);
    else stdout.write(`スキルの棚卸しを ${formatLocalDate(result.record.reviewedAt)} として記録した（${result.path}）。次の目安は ${SKILL_REVIEW_INTERVAL_DAYS} 日後\n`);
    return result;
  }

  const report = await usageReport(args, { env, homeDir, now });
  if (args.command === "review-sheet") {
    const catalog = loadSkillUsageCatalog({ repoRoot });
    const sheet = buildSkillReviewSheet({ report, catalog });
    const text = args.json ? `${JSON.stringify(sheet.json, null, 2)}\n` : `${sheet.markdown}\n`;
    if (args.output) {
      const written = writeFileAtomic(args.output, text);
      stderr.write(`判定シートを書いた: ${written}\n`);
    } else {
      stdout.write(text);
    }
    if (!report.complete) stderr.write("注意: 使われ方は数え切れていない（数は下限）。シートにも書いてある\n");
    return sheet;
  }

  if (args.json) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else stdout.write(`${renderSkillUsageReport(report)}\n`);
  if (!report.complete && args.json) stderr.write("注意: 使われ方は数え切れていない（complete: false。数は下限）\n");
  return report;
}

if (isDirectCli(import.meta.url)) {
  runSkillUsageCli().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
