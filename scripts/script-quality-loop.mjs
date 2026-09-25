#!/usr/bin/env node
// 台本の品質ループ（Claude Code / Codex 共通）
//
//   node scripts/script-quality-loop.mjs start  --work-dir <台本の作業フォルダ> --generator-context <初稿を書いた会話ID>
//   node scripts/script-quality-loop.mjs sheet  --work-dir <dir> --script <版のファイル> --stage <工程>
//   node scripts/script-quality-loop.mjs record --work-dir <dir> --script <版のファイル> --version <版の名前> \
//        --stage <draft|external-rewrite|meaning-check|revision> --review <採点ファイル> [--external-call <id>]...
//   node scripts/script-quality-loop.mjs status --work-dir <dir> [--require-pass]
//
// 版ごとに、その版を作った文脈とは別の評価文脈の採点を1回として記録する。実装の正本は
// lib/scriptQualityLoop.mjs（中核は lib/qualityLoop.mjs）。状態は作業フォルダの quality/ に書く。
//
// 終了コード: 0 = 済んだ / 3 = 人待ち・直しが要る（記録していない）/ 4 = --require-pass で未合格 / 2 = 入力の誤り

import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import { captureScriptRoundLearning } from "../lib/scriptQualityLearning.mjs";
import {
  SCRIPT_QUALITY_GENRES,
  SCRIPT_STAGES,
  createScriptQualityContract,
  loadScriptChannelConfig,
  recordScriptQualityRound,
  scriptQualityGenre,
  scriptQualityReviewSheet,
  scriptQualityReviewTemplate,
  scriptQualityStatus,
  startScriptQualityLoop,
} from "../lib/scriptQualityLoop.mjs";

const VALUE_OPTIONS = new Set([
  "--work-dir", "--genre", "--generator-context", "--generator-host", "--channel-pack", "--channel-config",
  "--reason", "--script", "--version", "--stage", "--review", "--base-version", "--revision-delta",
  "--blocking-condition", "--cost", "--ledger",
]);
const REPEATABLE_OPTIONS = new Set(["--producer-context", "--external-call"]);
const FLAG_OPTIONS = new Set(["--json", "--restart", "--require-pass", "--help", "-h"]);

function camel(option) {
  return option.replace(/^--?/u, "").replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
}

export function parseScriptQualityArgs(argv) {
  const [action, ...rest] = argv;
  const args = { action: action || "", producerContext: [], externalCall: [] };
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

export function scriptQualityHelp() {
  return `台本の品質ループ（版ごとに、作った文脈とは別の評価文脈の採点を1回として記録する）

  contract  採点表（評価項目・下限・機械ゲート・上限）を出す。何も書かない
    [--genre ${Object.keys(SCRIPT_QUALITY_GENRES).join("|")}] [--channel-pack <署名済みPack> | --channel-config <file>]

  start     ループを始める（状態は <work-dir>/quality/script-quality-loop.json）
    --work-dir <dir>              台本の作業フォルダ（私有側）
    --generator-context <id>      初稿を書いた会話・タスクの ID（この文脈は採点できない）
    [--generator-host <claude-code|codex>] [--genre ${Object.keys(SCRIPT_QUALITY_GENRES).join("|")}]
                                  既定は narrated-story。manga は漫画の台本、explainer は解説動画の台本
                                  （どちらも BuzzAssist 独自の評価基準。contract --genre <id> で採点表を見る）
    [--channel-pack <dir>]        署名済み Channel Pack。payload/script-quality.json でチャンネル固有の
                                  評価項目を足し、下限を上げられる（下げられない）。検証の公開鍵は
                                  BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY
    [--channel-config <file>]     署名の無い設定（手元の試行用。契約に unsigned-file と刻まれる）
    [--restart --reason "..."]    止まったループだけ始め直せる（前の状態は history に残る）

  sheet     評価者へ渡す採点ファイルの雛形を出す（scriptSha256 / baseScriptSha256 を計算して埋める）
    --work-dir <dir> --script <版のファイル> --stage <${SCRIPT_STAGES.join("|")}> [--base-version <版>]

  record    1つの版を1回として記録する。合格しなかった回は、評価項目 id・機械ゲート id・止まった
            理由のコードだけを台本の非公開台帳（channel-pack:narrated-story-script）へ自動で積む
            （本文は入れない。BUZZASSIST_LEARNING_AUTO_CAPTURE=0 で止まる。学習の宛先がまだ無いジャンル
            manga / explainer では積まない）
    --work-dir <dir> --script <版のファイル> --version <版の名前> --stage <${SCRIPT_STAGES.join("|")}>
    --review <採点ファイル>        { evaluatorId, evaluatorContextId, evaluatorHost, scriptSha256,
                                    baseScriptSha256（初稿以外）, rubricScores, notes, findings }
    [--producer-context <id>]...  この版を作ったほかの文脈（採点できない）
    [--external-call <id>]...     harness-external-call が返した id（外部モデルの手直しの版には必須）
    [--base-version <版>]         意味の保持を比べる前の版（既定は直前の版）
    [--revision-delta "..."]      2回目以降に必須。前回の失敗をどう直したか
                                  （quality/script-revision-delta.json に書いてもよい）
    [--blocking-condition "..."]  人の判断が要るなら書く（ループは blocked で止まる）
    [--cost <n>] [--ledger <file>]
            Pack の script-quality.json が acceptance.evaluators で評価者を宣言していれば、採点は
            「評価の組」に入り、宣言した評価者が全員そろった時点で1回として閉じる。組が開いている間は
            record --work-dir <dir> --review <採点ファイル> だけでよい（版・工程・台本は組を開いた記録を使う）。
            別の版の採点・作った文脈・前の回や組の中で使った文脈・宣言外の評価者・2件目は組に入れない。
            合否は acceptance.mode で決まる: average（既定。評価者の平均）/ each-evaluator（評価者それぞれの
            総合点が minimumEvaluatorScore（無ければ目標点）以上で、各自の項目の下限も満たす）

  status    今の状態。deliverable は合格して、その版の台本が今も同じバイト列のときだけ
    --work-dir <dir> [--require-pass]   未合格なら終了コード 4

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

export async function runScriptQualityCli(argv = process.argv.slice(2), {
  env = process.env,
  stdout = process.stdout,
  now,
  loadChannel,
  captureLearning,
} = {}) {
  const args = parseScriptQualityArgs(argv);
  if (!args.action || ["--help", "-h", "help"].includes(args.action) || args.help) {
    stdout.write(scriptQualityHelp());
    return { exitCode: args.action ? 0 : 2 };
  }
  const injected = { ...(now ? { now } : {}), ...(loadChannel ? { loadChannel } : {}) };
  switch (args.action) {
    case "contract": {
      const genre = scriptQualityGenre(args.genre || "narrated-story");
      const channel = await (loadChannel || loadScriptChannelConfig)({
        channelPack: args.channelPack, channelConfig: args.channelConfig, env, expectedHarnessId: genre.harnessId,
      });
      const { contract, blockers } = createScriptQualityContract({ genre: genre.id, channelConfig: channel.config, channelSource: channel.source });
      if (!contract) {
        print(stdout, { issues: blockers.map((blocker) => `script-quality-channel-config-invalid:${blocker}`), detail: "Channel Pack の script-quality.json に直せない値がある" }, args.json);
        return { exitCode: 3 };
      }
      stdout.write(`${JSON.stringify(scriptQualityReviewSheet(contract), null, 2)}\n`);
      return { exitCode: 0, contract };
    }
    case "start": {
      const result = await startScriptQualityLoop({
        workDir: args.workDir,
        genre: args.genre || "narrated-story",
        generatorContextId: args.generatorContext,
        generatorHost: args.generatorHost,
        channelPack: args.channelPack,
        channelConfig: args.channelConfig,
        restart: args.restart === true,
        restartReason: args.reason,
        env,
        ...injected,
      });
      print(stdout, result, args.json);
      return { exitCode: result.started ? 0 : 3, result };
    }
    case "sheet": {
      const result = await scriptQualityReviewTemplate({
        workDir: args.workDir, scriptPath: args.script, baseVersion: args.baseVersion, stage: args.stage || "draft",
      });
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return { exitCode: 0, result };
    }
    case "record": {
      const result = await recordScriptQualityRound({
        workDir: args.workDir,
        scriptPath: args.script,
        versionLabel: args.version,
        stage: args.stage,
        reviewPath: args.review,
        producerContexts: args.producerContext,
        externalCallIds: args.externalCall,
        baseVersion: args.baseVersion,
        revisionDelta: args.revisionDelta,
        blockingCondition: args.blockingCondition,
        cost: args.cost === undefined ? 0 : Number(args.cost),
        ledgerPath: args.ledger,
        env,
        ...injected,
        // 合格しなかった回は、評価項目 id・機械ゲート id・止まった理由のコードだけを台本の
        // 非公開台帳へ積む（lib/scriptQualityLearning.mjs。BUZZASSIST_LEARNING_AUTO_CAPTURE=0 で止まる）。
        captureLearning: captureLearning || ((input) => captureScriptRoundLearning({ ...input, env })),
      });
      print(stdout, result, args.json);
      if (!args.json && result.learning) {
        stdout.write(result.learning.skippedReason
          ? `学習候補は積んでいません（${result.learning.skippedReason}）\n`
          : `学習候補 ${result.learning.captured} 件を ${result.learning.target} へ積みました（既にあったもの ${result.learning.duplicates} 件）\n`);
      }
      return { exitCode: result.recorded || result.alreadyRecorded || result.panelAccepted ? 0 : 3, result };
    }
    case "status": {
      const result = await scriptQualityStatus({ workDir: args.workDir });
      if (args.json) print(stdout, result, true);
      else {
        print(stdout, result, false);
        for (const round of result.rounds || []) {
          stdout.write(`  ${round.index}. 版 ${round.version}（${round.stage}） ${round.score}点`
            + `${round.floorFailures.length ? ` 下限割れ: ${round.floorFailures.join(", ")}` : ""}`
            + `${round.failedGateIds.length ? ` 機械ゲート: ${round.failedGateIds.join(", ")}` : ""}\n`);
        }
        stdout.write(`納品できる状態: ${result.deliverable ? "はい" : "いいえ"}\n`);
      }
      if (!result.started) return { exitCode: 3, result };
      return { exitCode: args.requirePass && !result.deliverable ? 4 : 0, result };
    }
    default:
      throw new Error(`不明なアクション: ${args.action}（contract / start / sheet / record / status）`);
  }
}

if (isDirectCli(import.meta.url)) {
  runScriptQualityCli().then(({ exitCode }) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
