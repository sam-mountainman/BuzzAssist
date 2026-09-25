#!/usr/bin/env node
// 戦略ブリーフと企画の品質ループ（Claude Code / Codex 共通）
//
//   node scripts/strategy-brief.mjs validate    --brief <ブリーフ>
//   node scripts/strategy-brief.mjs fingerprint --skill-dir <戦略の道具のフォルダ>
//   node scripts/strategy-brief.mjs start  --work-dir <作業フォルダ> --generator-context <ブリーフを書いた会話ID>
//   node scripts/strategy-brief.mjs sheet  --brief <ブリーフ> [--work-dir <dir>]
//   node scripts/strategy-brief.mjs record --brief <ブリーフ> --review <採点ファイル> [--work-dir <dir>]
//   node scripts/strategy-brief.mjs status [--work-dir <dir> | --brief <ブリーフ>] [--require-pass]
//
// 企画の判断はホストのエージェントと運営者がする。ここは形の検査・根拠の照合・版ごとの採点の記録だけで、
// モデルを呼ばない。実装の正本は lib/strategyBrief.mjs と lib/strategyBriefQualityLoop.mjs（中核は lib/qualityLoop.mjs）。
// 状態は作業フォルダの quality/ に書く。作業フォルダを省くと、ブリーフのあるフォルダを作業フォルダにする。
//
// 終了コード: 0 = 済んだ / 3 = 人待ち・直しが要る（記録していない）/ 4 = --require-pass で未合格 / 2 = 入力の誤り

import { dirname, resolve } from "node:path";

import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import { readStrategyBrief, strategySkillFingerprint, validateStrategyBrief } from "../lib/strategyBrief.mjs";
import { captureStrategyBriefLearning } from "../lib/strategyBriefLearning.mjs";
import {
  STRATEGY_BRIEF_QUALITY_STATE_FILE,
  recordStrategyBriefRound,
  startStrategyBriefLoop,
  strategyBriefReviewTemplate,
  strategyBriefStatus,
} from "../lib/strategyBriefQualityLoop.mjs";

const VALUE_OPTIONS = new Set([
  "--work-dir", "--generator-context", "--generator-host", "--reason", "--brief", "--review",
  "--revision-delta", "--blocking-condition", "--skill-dir",
]);
const REPEATABLE_OPTIONS = new Set(["--producer-context"]);
const FLAG_OPTIONS = new Set(["--json", "--restart", "--require-pass", "--help", "-h"]);

function camel(option) {
  return option.replace(/^--?/u, "").replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
}

export function parseStrategyBriefArgs(argv) {
  const [action, ...rest] = argv;
  const args = { action: action || "", producerContext: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (FLAG_OPTIONS.has(token)) {
      args[token === "-h" ? "help" : camel(token)] = true;
      continue;
    }
    if (VALUE_OPTIONS.has(token) || REPEATABLE_OPTIONS.has(token)) {
      const value = rest[index + 1];
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

export function strategyBriefHelp() {
  return `戦略ブリーフと企画の品質ループ（形の検査・根拠の照合・版ごとの採点の記録。モデルは呼ばない）

  validate     ブリーフの形と欄どうしの対応を検査する。何も書かない
    --brief <file>

  fingerprint  戦略の道具の版の指紋（実行に使うファイルの sha256 の集合）を出す。中身は写さない
    --skill-dir <dir>              ブリーフの provenance.strategySkill.fingerprint に書く値

  start        企画の品質ループを始める（状態は <work-dir>/quality/${STRATEGY_BRIEF_QUALITY_STATE_FILE}）
    --work-dir <dir>               ブリーフと根拠を置く作業フォルダ（私有側）
    --generator-context <id>       ブリーフを書いた会話・タスクの ID（この文脈は採点できない）
    [--generator-host <claude-code|codex>]
    [--restart --reason "..."]     止まったループだけ始め直せる（前の状態は history に残る）

  sheet        評価者へ渡す評価シートと採点ファイルの雛形を出す（briefSha256 を計算して埋める）。
               合格点・下限・重み・前の回の点数は載せない
    --brief <file> [--work-dir <dir>]

  record       1つの版を1回として記録する。合格しなかった回は、評価項目 id・機械ゲート id・失敗指紋だけを
               ブリーフの制作条件のハーネスの Channel Pack の非公開台帳へ積む（本文は入れない。
               BUZZASSIST_LEARNING_AUTO_CAPTURE=0 で止まる）
    --brief <file> --review <採点ファイル> [--work-dir <dir>]
               採点ファイル: { evaluatorId, evaluatorContextId, evaluatorHost, briefSha256, rubricScores, notes, findings }
    [--producer-context <id>]...   このブリーフを作ったほかの文脈（採点できない）
    [--revision-delta "..."]       2回目以降に必須。前回の失敗をどう直したか
                                   （quality/strategy-brief-revision-delta.json に書いてもよい）
    [--blocking-condition "..."]   人の判断が要るなら書く（ループは blocked で止まる）

  status       今の状態。deliverable は合格して、その版のブリーフが今も同じバイト列のときだけ
    [--work-dir <dir> | --brief <file>] [--require-pass]   未合格なら終了コード 4

  --work-dir を省くと、--brief のあるフォルダを作業フォルダにする。根拠のパスは作業フォルダからの相対。

  終了コード: 0 済んだ / 3 人待ち・直しが要る（記録していない）/ 4 --require-pass で未合格 / 2 入力の誤り
`;
}

function print(stdout, value, json) {
  if (json) {
    stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  const lines = [];
  if (value.detail) lines.push(value.detail);
  for (const issue of value.issues || []) lines.push(`  - ${issue}`);
  if (value.check?.status) {
    lines.push(`状態: ${value.check.status}${value.check.stopReason ? `（${value.check.stopReason}）` : ""} / 回数 ${value.check.rounds}`
      + `${value.check.score === null ? "" : ` / 直近 ${value.check.score}点（目標 ${value.check.targetScore}）`}`);
  }
  stdout.write(`${lines.join("\n")}\n`);
}

/** 作業フォルダ。--work-dir が無ければ --brief のあるフォルダ。 */
export function strategyWorkDir(args) {
  if (typeof args.workDir === "string" && args.workDir.trim()) return resolve(args.workDir);
  if (typeof args.brief === "string" && args.brief.trim()) return dirname(resolve(args.brief));
  throw new Error("--work-dir（または --brief）が要ります。");
}

function requireBrief(args) {
  if (typeof args.brief !== "string" || !args.brief.trim()) throw new Error("--brief にブリーフのファイルが要ります。");
  return resolve(args.brief);
}

export async function runStrategyBriefCli(argv = process.argv.slice(2), {
  env = process.env,
  stdout = process.stdout,
  now,
  captureLearning,
} = {}) {
  const args = parseStrategyBriefArgs(argv);
  if (!args.action || ["--help", "-h", "help"].includes(args.action) || args.help) {
    stdout.write(strategyBriefHelp());
    return { exitCode: args.action ? 0 : 2 };
  }
  const injected = now ? { now } : {};
  switch (args.action) {
    case "validate": {
      const file = requireBrief(args);
      const read = await readStrategyBrief(file);
      const result = read.brief === null
        ? { ok: false, sha256: read.sha256, issues: ["not-json"], linkIssues: [] }
        : { ...validateStrategyBrief(read.brief), sha256: read.sha256 };
      if (args.json) print(stdout, result, true);
      else {
        stdout.write(`${result.ok ? "形は合っている" : "形に誤りがある"}（sha256 ${result.sha256}）\n`);
        for (const issue of [...result.issues, ...result.linkIssues]) stdout.write(`  - ${issue}\n`);
      }
      return { exitCode: result.ok ? 0 : 3, result };
    }
    case "fingerprint": {
      if (typeof args.skillDir !== "string" || !args.skillDir.trim()) throw new Error("--skill-dir に戦略の道具のフォルダが要ります。");
      const result = await strategySkillFingerprint(resolve(args.skillDir));
      const out = { fingerprint: result.fingerprint, fileCount: result.fileCount, include: result.include };
      stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      return { exitCode: 0, result: out };
    }
    case "start": {
      const result = await startStrategyBriefLoop({
        workDir: typeof args.workDir === "string" ? resolve(args.workDir) : "",
        generatorContextId: args.generatorContext,
        generatorHost: args.generatorHost,
        restart: args.restart === true,
        restartReason: args.reason,
        ...injected,
      });
      print(stdout, result, args.json);
      return { exitCode: result.started ? 0 : 3, result };
    }
    case "sheet": {
      const result = await strategyBriefReviewTemplate({ workDir: strategyWorkDir(args), briefPath: requireBrief(args) });
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return { exitCode: 0, result };
    }
    case "record": {
      if (typeof args.review !== "string" || !args.review.trim()) throw new Error("--review に採点ファイルが要ります。");
      const result = await recordStrategyBriefRound({
        workDir: strategyWorkDir(args),
        briefPath: requireBrief(args),
        reviewPath: resolve(args.review),
        producerContexts: args.producerContext,
        revisionDelta: args.revisionDelta,
        blockingCondition: args.blockingCondition,
        ...injected,
        // 合格しなかった回は、失敗指紋・評価項目 id・機械ゲート id だけを Channel Pack の非公開台帳へ積む
        // （lib/strategyBriefLearning.mjs。BUZZASSIST_LEARNING_AUTO_CAPTURE=0 で止まる）。
        captureLearning: captureLearning || ((input) => captureStrategyBriefLearning({ ...input, env })),
      });
      print(stdout, result, args.json);
      if (!args.json && result.learning) {
        stdout.write(result.learning.skippedReason
          ? `学習候補は積んでいません（${result.learning.skippedReason}）\n`
          : `学習候補 ${result.learning.captured} 件を ${result.learning.target} へ積みました（既にあったもの ${result.learning.duplicates} 件）\n`);
      }
      return { exitCode: result.recorded || result.alreadyRecorded ? 0 : 3, result };
    }
    case "status": {
      const result = await strategyBriefStatus({ workDir: strategyWorkDir(args) });
      if (args.json) print(stdout, result, true);
      else {
        print(stdout, result, false);
        for (const round of result.rounds || []) {
          stdout.write(`  ${round.index}. 版 ${round.label} ${round.score}点`
            + `${round.floorFailures.length ? ` 下限割れ: ${round.floorFailures.join(", ")}` : ""}`
            + `${round.failedGateIds.length ? ` 機械ゲート: ${round.failedGateIds.join(", ")}` : ""}\n`);
        }
        stdout.write(`制作へ渡せる状態: ${result.deliverable ? "はい" : "いいえ"}\n`);
      }
      if (!result.started) return { exitCode: 3, result };
      return { exitCode: args.requirePass && !result.deliverable ? 4 : 0, result };
    }
    default:
      throw new Error(`不明なアクション: ${args.action}（validate / fingerprint / start / sheet / record / status）`);
  }
}

if (isDirectCli(import.meta.url)) {
  runStrategyBriefCli().then(({ exitCode }) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
