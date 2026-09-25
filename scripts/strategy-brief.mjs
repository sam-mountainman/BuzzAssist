#!/usr/bin/env node
// 戦略ブリーフと企画の品質ループ（Claude Code / Codex 共通）
//
//   node scripts/strategy-brief.mjs validate    --brief <ブリーフ>
//   node scripts/strategy-brief.mjs fingerprint --skill-dir <戦略の道具のフォルダ>
//   node scripts/strategy-brief.mjs start  --work-dir <作業フォルダ> --generator-context <ブリーフを書いた会話ID>
//   node scripts/strategy-brief.mjs sheet  --brief <ブリーフ> [--work-dir <dir>]
//   node scripts/strategy-brief.mjs record --brief <ブリーフ> --review <採点ファイル> [--work-dir <dir>]
//   node scripts/strategy-brief.mjs status [--work-dir <dir> | --brief <ブリーフ>] [--require-pass]
//   node scripts/strategy-brief.mjs verdict --brief <ブリーフ> [--work-dir <dir>] [--require-pass]
//   node scripts/strategy-brief.mjs next --from <前のブリーフ> --metrics <指標の集計 JSON> [--referrals <JSON>] \
//        [--audience-run <4分析の run フォルダ>] [--work-dir <dir>] [--out <下書き>]
//   node scripts/strategy-brief.mjs applicability --brief <ブリーフ> [--evidence <id> --applies yes|no --reason "..."] \
//        [--context <判定した会話ID>] [--work-dir <dir>] [--out <書き出し先>]
//   node scripts/strategy-brief.mjs draft --from-hyp <戦略の道具の作業フォルダ> --channel <id> [--previous <前のブリーフ>] \
//        [--strategy-skill-dir <戦略の道具の採用版の置き場>] [--work-dir <dir>] [--out <下書き>]
//
// 企画の判断はホストのエージェントと運営者がする。ここは形の検査・根拠の照合・版ごとの採点の記録だけで、
// モデルを呼ばない。実装の正本は lib/strategyBrief.mjs と lib/strategyBriefQualityLoop.mjs（中核は lib/qualityLoop.mjs）。
// 状態は作業フォルダの quality/ に書く。作業フォルダを省くと、ブリーフのあるフォルダを作業フォルダにする。
//
// 終了コード: 0 = 済んだ / 3 = 人待ち・直しが要る（記録していない）/ 4 = --require-pass で未合格 / 2 = 入力の誤り

import { dirname, resolve } from "node:path";

import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import { readStrategyBrief, strategySkillFingerprint, validateStrategyBrief } from "../lib/strategyBrief.mjs";
import { draftStrategyBriefFromTool } from "../lib/strategyBriefDraft.mjs";
import { captureStrategyBriefLearning } from "../lib/strategyBriefLearning.mjs";
import { draftNextStrategyBrief } from "../lib/strategyBriefNext.mjs";
import {
  STRATEGY_BRIEF_QUALITY_STATE_FILE,
  recordStrategyBriefRound,
  recordStrategyEvidenceApplicability,
  startStrategyBriefLoop,
  strategyBriefReviewTemplate,
  strategyBriefStatus,
  strategyBriefVerdict,
  strategyEvidenceApplicabilityStatus,
} from "../lib/strategyBriefQualityLoop.mjs";

const VALUE_OPTIONS = new Set([
  "--work-dir", "--generator-context", "--generator-host", "--reason", "--brief", "--review",
  "--revision-delta", "--blocking-condition", "--skill-dir",
  "--from", "--metrics", "--referrals", "--audience-run", "--out",
  "--evidence", "--applies", "--context",
  "--from-hyp", "--channel", "--previous", "--strategy-skill-dir",
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

  verdict      制作へ渡す前の判定。合格した版と同じ SHA か、根拠のファイルが揃い 4分析の run が現行か、
               前提（問い・見る人・制作条件）を変えた後の根拠に当てはまりの判定があるかを理由コードつきで返す。
               判定が無ければ strategy-evidence-applicability-review-required:<id>、当てはまらないと判定した
               根拠は strategy-evidence-refresh-required:<id>（日数では決めない。入口の表現だけの変更は数えない）。採点した版から
               根拠の確かさを上げた書き換えは strategy-brief-evidence-upgraded-without-review:<id>。
               制作を止める未確認事項（openQuestions の blocksProduction: true で open）が残れば
               strategy-brief-open-question-blocks-production:<id>。採点した版から未確認を確認済みにした・
               仮説の状態を変えた書き換えは、新しい根拠が無ければ ...-without-new-evidence:<id>
    --brief <file> [--work-dir <dir>] [--require-pass]     pass でなければ終了コード 4

  next         公開後の数字から次のブリーフの下書きを作る（照合と下書きだけ。数字の解釈と次の企画の判断は
               ホストのエージェントと運営者がする）。前のブリーフの postPublish.metrics を実際の数字と照らし、
               期待の数値があれば満たした／届かなかったを残す点・変える点の候補にして、数字のファイルを根拠に
               結び付ける。無い数字は missing（推測で埋めない）、一部の行だけの値は partial で比べない。
               4分析の run は report-manifest.json が現行のものだけを根拠にする（stale は理由つきで外す）
    --from <前のブリーフ> --metrics <指標の集計 JSON（schema 1.1）>
    [--referrals <関連元の集計 JSON（schema 1.0）>] [--audience-run <run フォルダ>]
    [--work-dir <dir>]             既定は前のブリーフのフォルダ。数字のファイルはこの中に置く
    [--out <file>]                 下書きのブリーフだけをこのファイルに書く（既存のファイルは上書きしない）

  applicability 前提（問い・見る人・制作条件）を変えた後、前の前提で集めた根拠が今の前提に当てはまるかを
               根拠ごとに記録する。判定は上位の AI が根拠を開いてする（ここは記録と照合だけ）。入口の約束（表現）を
               変えただけなら判定は要らない。当てはまるなら再利用、当てはまらないならその根拠だけ取り直す
               （verdict の strategy-evidence-refresh-required:<id>）。日数では決めない
    --brief <file> [--work-dir <dir>]              --evidence を付けなければ、判定が要る根拠の一覧を出す（何も書かない）
    [--evidence <id> --applies yes|no --reason "..."]  1件の判定を書く（ブリーフの SHA が変わる）
    [--context <id>]               判定した会話・タスクの ID
    [--out <file>]                 ブリーフを書き換えず、判定を足したブリーフをこのファイルに書く（既存は上書きしない）

  draft        戦略の道具の作業フォルダからブリーフの下書きを組み立てる（照合と下書きだけ。戦略の道具のスクリプトは
               実行せず、文書の中身も読まない）。4分析の run（現行のものだけ）・指標と関連元の集計・取得スナップショット・
               作業文書の SHA・根拠の表 evidence.csv の行を根拠（provisional）に集め、strategy-handoff.json があれば
               優先して取り込む。前のブリーフの問い・見る人・約束・回収・制作条件・仮説・未確認事項を引き継ぐ。
               機械で埋められない欄（企画の判断そのもの）は needsAuthoring に、どの成果物から埋めるかと一緒に返す。
               上位の AI がそれを読んで埋める（人が毎回手で書く前提にしない）。形は docs/strategy-handoff-spec-ja.md
    --from-hyp <dir> --channel <id>
    [--previous <前のブリーフ>]       引き継ぐ前の版。根拠の行には前の版の前提が付く
    [--strategy-skill-dir <dir>]    戦略の道具の採用版の置き場。指紋を provenance.strategySkill に書く
    [--work-dir <dir>]              既定は --from-hyp のフォルダ。--from-hyp を含むフォルダだけ
    [--out <file>]                  下書きを作業フォルダの中に書く（既存のファイルは上書きしない）

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
    case "verdict": {
      const result = await strategyBriefVerdict({ workDir: strategyWorkDir(args), briefPath: requireBrief(args) });
      if (args.json) print(stdout, result, true);
      else {
        stdout.write(`${result.pass ? "合格（制作へ渡せる）" : "未合格"}: ${result.detail}\n`);
        for (const code of result.reasonCodes) stdout.write(`  - ${code}\n`);
      }
      return { exitCode: args.requirePass && !result.pass ? 4 : 0, result };
    }
    case "next": {
      const result = await draftNextStrategyBrief({
        fromPath: typeof args.from === "string" ? resolve(args.from) : "",
        metricsPath: typeof args.metrics === "string" ? resolve(args.metrics) : "",
        referralsPath: typeof args.referrals === "string" ? resolve(args.referrals) : "",
        audienceRunPath: typeof args.audienceRun === "string" ? resolve(args.audienceRun) : "",
        workDir: typeof args.workDir === "string" ? resolve(args.workDir) : "",
        outPath: typeof args.out === "string" ? resolve(args.out) : "",
        ...injected,
      });
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return { exitCode: 0, result };
    }
    case "applicability": {
      const briefPath = requireBrief(args);
      const workDir = strategyWorkDir(args);
      if (args.evidence === undefined) {
        const result = await strategyEvidenceApplicabilityStatus({ workDir, briefPath });
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return { exitCode: 0, result };
      }
      const applies = args.applies === "yes" ? true : args.applies === "no" ? false : null;
      if (applies === null) throw new Error("--applies は yes か no にする。");
      try {
        const result = await recordStrategyEvidenceApplicability({
          workDir,
          briefPath,
          evidenceId: args.evidence,
          applies,
          reason: args.reason,
          decidedBy: args.context,
          outPath: typeof args.out === "string" ? resolve(args.out) : "",
          ...injected,
        });
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return { exitCode: 0, result };
      } catch (error) {
        if (error?.code === "strategy-evidence-applicability-not-required" || error?.code === "strategy-evidence-applicability-unknown-evidence") {
          const result = { recorded: false, issues: [`${error.code}:${args.evidence}`], detail: error.message };
          print(stdout, result, args.json);
          return { exitCode: 3, result };
        }
        throw error;
      }
    }
    case "draft": {
      const result = await draftStrategyBriefFromTool({
        fromDir: typeof args.fromHyp === "string" ? resolve(args.fromHyp) : "",
        channelId: args.channel,
        previousPath: typeof args.previous === "string" ? resolve(args.previous) : "",
        strategySkillDir: typeof args.strategySkillDir === "string" ? resolve(args.strategySkillDir) : "",
        workDir: typeof args.workDir === "string" ? resolve(args.workDir) : "",
        outPath: typeof args.out === "string" ? resolve(args.out) : "",
        ...injected,
      });
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return { exitCode: 0, result };
    }
    default:
      throw new Error(`不明なアクション: ${args.action}（validate / fingerprint / start / sheet / record / status / verdict / next / applicability / draft）`);
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
