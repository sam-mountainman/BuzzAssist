#!/usr/bin/env node
// 品質ループの失敗の格上げ（Claude Code / Codex 共通）
//
//   node scripts/harness-promote-failures.mjs scan    --work-dir <作業フォルダ> [--work-dir <dir>]... [--state <状態ファイル>]...
//   node scripts/harness-promote-failures.mjs enqueue --work-dir <作業フォルダ> [--channel <id>] [--job <Job の ID>]
//
// 品質ループ（台本・途中の成果物・企画ブリーフ・完成動画の署名済みレビュー）の状態ファイルを読み、同じ失敗が
// 別の版で2回以上出たもの（被害の大きい種類は1回目）を「機械の検査・関門へ上げる提案」にする。scan は何も
// 書かない（既定）。enqueue は学習の提案台帳へ追記するだけで、ループの状態・正本・overlay には触らない。
// 実装の正本は lib/qualityFailurePromotion.mjs。
//
// 終了コード: 0 = 済んだ（候補ゼロも正常）/ 2 = 入力の誤り / 1 = 予期しない失敗

import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import { assertLearningWriteAllowed } from "../lib/harnessLearningGuard.mjs";
import { learningChannelCliHints } from "../lib/learningChannelResolver.mjs";
import {
  DEFAULT_PROMOTION_THRESHOLD,
  MAX_PROMOTION_THRESHOLD,
  normalizeThreshold,
  promoteRecurringQualityFailures,
} from "../lib/qualityFailurePromotion.mjs";

const ACTIONS = new Set(["scan", "enqueue"]);
const VALUE_OPTIONS = new Set(["--threshold", "--channel", "--job"]);
const REPEATABLE_OPTIONS = new Set(["--work-dir", "--state"]);
const FLAG_OPTIONS = new Set(["--json", "--help", "-h"]);

function camel(option) {
  return option.replace(/^--?/u, "").replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
}

export function parsePromoteFailuresArgs(argv) {
  const [first, ...rest] = argv;
  const helpFirst = first === "--help" || first === "-h";
  const args = { action: helpFirst ? "" : first || "", workDir: [], state: [], help: helpFirst };
  const tokens = helpFirst ? [] : rest;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (FLAG_OPTIONS.has(token)) {
      args[token === "-h" ? "help" : camel(token)] = true;
      continue;
    }
    if (VALUE_OPTIONS.has(token) || REPEATABLE_OPTIONS.has(token)) {
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${token} に値が要ります。`);
      if (REPEATABLE_OPTIONS.has(token)) args[camel(token)].push(value);
      else args[camel(token)] = value;
      index += 1;
      continue;
    }
    throw new Error(`不明なオプション: ${token}`);
  }
  return args;
}

export function promoteFailuresHelp() {
  return `品質ループの失敗の格上げ（同じ失敗が2回起きたら、注意書きでなく仕組みにする）

  scan      品質ループの状態ファイルを読み、格上げの候補を出す。何も書かない（dry-run）
  enqueue   候補を学習の提案台帳（ループの自動捕捉と同じチャンネルの非公開台帳）へ積む。正本は書き換えない

  --work-dir <dir>   作業フォルダ（何度でも）。quality/ の台本・企画ブリーフ・完成動画の状態と、
                     quality/assets/ の途中の成果物の状態を全部読む
  --state <file>     状態ファイルを直接渡す（何度でも）
  --threshold <N>    別の版で何回出たら上げるか（既定 ${DEFAULT_PROMOTION_THRESHOLD}、${DEFAULT_PROMOTION_THRESHOLD}〜${MAX_PROMOTION_THRESHOLD}）
  --channel <id>     積むチャンネル（config/harness-deployments.json の channels）。ループの CLI と同じ決め方で照らす
  --job <id>         制作の Job の ID（その Job のチャンネルを使う）
  --json             結果を JSON で出す

  格上げの段（まさおさんの記事の「失敗の昇格ラダー」）:
    口頭（評価者の採点・所見だけ）→ 注意書き（Gotcha）→ 検査スクリプト → 通過必須の関門
    - 同じ失敗が別の版で ${DEFAULT_PROMOTION_THRESHOLD} 回出たら1つ上げる（同じ成果物の採点し直しは1回に数える）
    - 機械で判定できる失敗は、注意書きを飛ばして検査スクリプトへ
    - 被害の大きい種類（公開面の安全・人物の取り違え・課金・署名や承認の詐称）は1回目でも関門へ飛ばす
    - すでに関門（機械ゲート・人の確認の欄）で止まっている失敗が再発したら、関門の前倒し
      （同じ検査を生成の直後へ移し、作る側の指示にも足す）を提案する
    - 上げたら同じ中身の注意書きは消す（提案の本文に書いてある）

  台帳に同じ失敗・同じ段の提案があれば積まない（承認待ちでも反映済みでも）。段を上げた提案が反映されたら、
  反映より後の再発だけを数えて次の段を提案する。積んだ提案は harness-learn の status で見え、正本への反映は
  pending → approve（Channel Pack の台帳は人だけ）で行う。

  子エージェント（BUZZASSIST_LEARNING_WRITE_FORBIDDEN）からの enqueue は拒否する（結果を親へ返す）。
  漫画（koya-manga-video）の最終の品質ループは読まない（事故台帳 recordMangaQualityIncident で先に格上げしている）。
`;
}

const KIND_LABELS = Object.freeze({
  gate: "機械ゲート",
  floor: "評価項目の下限割れ",
  finding: "直らなかった指摘",
  "human-check": "人の確認の否",
  fingerprint: "目標点未達の同じ形",
  blocking: "止まる条件",
});

function formatReport(result, { write }) {
  const lines = [];
  lines.push(write
    ? "品質ループの失敗の格上げ（提案台帳へ積んだ。正本は書き換えていない）"
    : "品質ループの失敗の格上げ（dry-run。台帳には書いていない）");
  lines.push(`読んだ状態: ${result.sources} 件${result.skippedSources.length ? ` / 読まなかった状態: ${result.skippedSources.length} 件` : ""}`);
  for (const row of result.skippedSources) lines.push(`  - ${row.file}（${row.skippedReason}）`);
  lines.push(`格上げの候補: ${result.candidates.length} 件`);
  for (const candidate of result.candidates) {
    lines.push(`  - [${candidate.target}${candidate.channelId ? ` / チャンネル ${candidate.channelId}` : ""}] ${KIND_LABELS[candidate.failureKind]} ${candidate.failureId}`
      + `（${candidate.loop}${candidate.stage ? `・${candidate.stage}` : ""}）`);
    lines.push(`      ${candidate.occurrences} 回（版 ${candidate.versions.join(", ")}）/ 被害: ${candidate.blastRadius} / 機械で判定: ${candidate.detectable}`
      + ` / 今の段: ${candidate.currentRung} → 次の段: ${candidate.nextRung}（${candidate.reason}）${candidate.proposalId ? ` / 提案 ${candidate.proposalId}` : ""}`);
  }
  const already = result.held.filter((row) => row.heldReason === "already-queued");
  const below = result.held.filter((row) => row.heldReason === "below-threshold");
  if (already.length) lines.push(`台帳に同じ段の提案があるので積まない: ${already.length} 件`);
  if (below.length) lines.push(`まだ上げない（再発していない）: ${below.length} 件`);
  if (write) {
    lines.push(`積んだ: ${result.captured} 件 / 同じ提案が既にあった: ${result.duplicates} 件${result.failures.length ? ` / 積めなかった: ${result.failures.length} 件` : ""}`);
    for (const failure of result.failures) lines.push(`  - ${failure.target}: ${failure.reason}`);
    if (result.skippedReason) lines.push(`積まなかった理由: ${result.skippedReason}`);
  } else if (result.candidates.length > 0) {
    lines.push("台帳へ積むには同じ引数で enqueue を打つ（正本は書き換えない。反映は harness-learn の pending → approve）");
  }
  return `${lines.join("\n")}\n`;
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parsePromoteFailuresArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${promoteFailuresHelp()}`);
    process.exitCode = 2;
    return;
  }
  if (args.help || !args.action) {
    process.stdout.write(promoteFailuresHelp());
    process.exitCode = args.help ? 0 : 2;
    return;
  }
  if (!ACTIONS.has(args.action)) {
    process.stderr.write(`不明な操作: ${args.action}\n\n${promoteFailuresHelp()}`);
    process.exitCode = 2;
    return;
  }
  if (args.workDir.length === 0 && args.state.length === 0) {
    process.stderr.write("--work-dir か --state が要ります。\n");
    process.exitCode = 2;
    return;
  }
  let threshold;
  try {
    threshold = normalizeThreshold(args.threshold ?? DEFAULT_PROMOTION_THRESHOLD);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const write = args.action === "enqueue";
  // 子エージェントからは書かない（台帳を読む前に止める）。
  if (write) assertLearningWriteAllowed(process.env, "harness-promote-failures enqueue");
  const hints = await learningChannelCliHints({ channelId: args.channel || "", jobId: args.job || "" });
  const result = await promoteRecurringQualityFailures({
    workDirs: args.workDir,
    stateFiles: args.state,
    write,
    threshold,
    ...hints.captureInput,
  });
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(formatReport(result, { write }));
}

if (isDirectCli(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = error?.code === "LEARNING_WRITE_FORBIDDEN_IN_CHILD_AGENT" ? 2 : 1;
  });
}
