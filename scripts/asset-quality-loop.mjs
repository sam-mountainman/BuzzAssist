#!/usr/bin/env node
// 途中の成果物の品質ループ（Claude Code / Codex 共通）
//
//   node scripts/asset-quality-loop.mjs start  --work-dir <dir> --harness <id> --stage <工程> --subject <id> --generator-context <会話ID>
//   node scripts/asset-quality-loop.mjs sheet  --work-dir <dir> --stage <工程> --subject <id> --asset <file> [--reference <file|sha>]...
//   node scripts/asset-quality-loop.mjs record --work-dir <dir> --stage <工程> --subject <id> --asset <file> --version <版> \
//        --review <採点ファイル> --producer-context <id> --producer-host <host> --route <経路> [--reference <file|sha>]...
//   node scripts/asset-quality-loop.mjs verify --work-dir <dir> --stage <工程> --subject <id> --asset <file> \
//        --check <identity|hand-safety> (--pass|--reject) --reviewer <名前> --note "..." --human-verified
//   node scripts/asset-quality-loop.mjs status --work-dir <dir> [--stage <工程> --subject <id>] [--asset <file>] [--require-pass]
//
// 工程: character（人物の設定画）/ location（背景・場所。漫画固有）/ scene-image（本編の画）/
// thumbnail（サムネ）/ voice-take（声のテイク）。実装の正本は lib/assetQualityLoop.mjs（中核は
// lib/qualityLoop.mjs）。状態は作業フォルダの quality/assets/ に書く。
//
// 終了コード: 0 = 済んだ / 3 = 人待ち・直しが要る（記録していない、または人の確認に数えない）/
//             4 = --require-pass で未合格 / 2 = 入力の誤り

import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import { captureAssetLearning } from "../lib/assetQualityLearning.mjs";
import {
  ASSET_GENERATION_ROUTES,
  ASSET_HUMAN_CHECKS,
  ASSET_MACHINE_GATES,
  ASSET_QUALITY_HARNESSES,
  ASSET_STAGES,
  assetQualityHarness,
  assetQualityReviewTemplate,
  assetQualityStage,
  assetQualityStatus,
  createAssetQualityContract,
  listAssetQualityStatus,
  loadAssetChannelConfig,
  recordAssetHumanVerification,
  recordAssetQualityRound,
  startAssetQualityLoop,
} from "../lib/assetQualityLoop.mjs";

const VALUE_OPTIONS = new Set([
  "--work-dir", "--harness", "--stage", "--subject", "--generator-context", "--generator-host", "--channel-pack",
  "--channel-config", "--reason", "--asset", "--version", "--review", "--producer-host", "--route",
  "--reference-exempt-reason", "--approved-references", "--measurement", "--revision-delta", "--previous-failure",
  "--blocking-condition", "--cost", "--reviewer", "--note",
]);
const REPEATABLE_OPTIONS = new Set(["--producer-context", "--reference", "--check"]);
const FLAG_OPTIONS = new Set([
  "--json", "--restart", "--require-pass", "--pass", "--reject", "--human-verified", "--agent-attested", "--help", "-h",
]);

function camel(option) {
  return option.replace(/^--?/u, "").replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
}

export function parseAssetQualityArgs(argv) {
  const [action, ...rest] = argv;
  const args = { action: action || "", producerContext: [], reference: [], check: [] };
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

export function assetQualityHelp() {
  const harnesses = Object.values(ASSET_QUALITY_HARNESSES).map((row) => `${row.id}（${row.stages.join(", ")}）`).join("\n      ");
  return `途中の成果物の品質ループ（版ごとに、作った文脈とは別の評価文脈の採点を1回として記録する）

  工程: ${ASSET_STAGES.map((id) => `${id}（${assetQualityStage(id).label}）`).join(" / ")}
  ハーネスと使える工程:
      ${harnesses}
  生成の経路（--route）: ${Object.keys(ASSET_GENERATION_ROUTES).join(" / ")}

  contract  作る側・運営者向けの契約（評価項目・下限・重み・機械ゲート・人の確認の欄・上限）を出す。
            評価者には渡さない（評価者には sheet を渡す）。何も書かない
    --harness <id> --stage <工程> [--channel-pack <署名済みPack> | --channel-config <file>]

  start     ループを始める（状態は <work-dir>/quality/assets/<工程>--<対象>.json）
    --work-dir <dir>              成果物の作業フォルダ（私有側）
    --harness <id> --stage <工程> --subject <対象 id>（人物 id・場所 id・カット id・サムネ案 id・声の単位 id）
    --generator-context <id>      成果物を作る会話・タスクの ID（この文脈は採点できない）
    [--generator-host <claude-code|codex|human>]
    [--channel-pack <dir>]        署名済み Channel Pack。payload/asset-quality.json で工程ごとに評価項目を足し、
                                  下限を上げ、重み・上限を変えられる（下限は下げられない）。検証の公開鍵は
                                  BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY
    [--channel-config <file>]     署名の無い設定（手元の試行用。契約に unsigned-file と刻まれる）
    [--restart --reason "..."]    止まったループ・人の確認で否とされたループだけ始め直せる（前の状態は history に残る）

  sheet     評価者へ渡す評価シートと採点ファイルの雛形（合格点・下限・重み・前の回の点数は載せない）
    --work-dir <dir> --stage <工程> --subject <id> --asset <file> [--reference <file|sha>]...

  record    1つの版を1回として記録する。合格しなかった回は、工程・失敗指紋・評価項目 id・機械ゲート id・
            件数だけを、そのハーネスの Channel Pack の非公開台帳へ自動で積む（本文・対象 id・パスは入れない。
            BUZZASSIST_LEARNING_AUTO_CAPTURE=0 で止まる）
    --work-dir <dir> --stage <工程> --subject <id> --asset <file> --version <版の名前> --review <採点ファイル>
    --producer-context <id>...    この版を作った会話・タスクの ID（1つ以上。採点できない）
    --producer-host <host>        この版を作ったホスト
    --route <経路>                生成の経路（上の一覧から）
    [--reference <file|sha>]...   参照に使った画の SHA かファイル（人物の設定画は必須。本編の画とサムネは
                                  人物が写るなら必須、写らないなら --reference-exempt-reason "理由"）
    [--approved-references <json>] 承認済みの参照の一覧（buzzassist-approved-references-v1）。参照があれば必須
    [--measurement <json>]        声のテイク: scripts/audit-voice-quality.py の報告（このテイクの SHA に結び付くもの）
    [--previous-failure <指紋> --revision-delta "..."]  2回目以降に必須（前回の失敗指紋と、それをどう直したか。
                                  quality/assets/<工程>--<対象>.revision-delta.json に書いてもよい）
    [--blocking-condition "..."]  人の判断が要るなら書く（ループは blocked で止まる）
    [--cost <n>]

  verify    人の確認を記録する（${Object.entries(ASSET_HUMAN_CHECKS).map(([id, text]) => `${id}: ${text}`).join(" / ")}）。
            確認した人が自分の対話端末から --human-verified を付けたときだけ人の確認に数える。
            --agent-attested は agent-self-attested として残るが数えない（機械は人の確認を記録できない）
    --work-dir <dir> --stage <工程> --subject <id> --asset <file> --check <欄>... (--pass|--reject)
    --reviewer <名前> --note "何を見てどう判断したか" (--human-verified | --agent-attested)

  status    今の状態。合格は、評価者の採点で合格し、要る人の確認が揃い、その版のファイルが今も同じときだけ
    --work-dir <dir> [--stage <工程> [--subject <id> [--asset <file>]]] [--require-pass]   未合格なら終了コード 4
    --asset を付けると、そのファイルが合格した版そのものかも見る

  機械ゲート: ${Object.keys(ASSET_MACHINE_GATES).join(" / ")}
  終了コード: 0 済んだ / 3 人待ち・直しが要る / 4 --require-pass で未合格 / 2 入力の誤り
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

function interactiveTerminal() {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export async function runAssetQualityCli(argv = process.argv.slice(2), {
  env = process.env,
  stdout = process.stdout,
  now,
  loadChannel,
  captureLearning,
  isInteractive = interactiveTerminal(),
} = {}) {
  const args = parseAssetQualityArgs(argv);
  if (!args.action || ["--help", "-h", "help"].includes(args.action) || args.help) {
    stdout.write(assetQualityHelp());
    return { exitCode: args.action ? 0 : 2 };
  }
  const injected = { ...(now ? { now } : {}), ...(loadChannel ? { loadChannel } : {}) };
  const learn = captureLearning || ((input) => captureAssetLearning({ ...input, env }));
  switch (args.action) {
    case "contract": {
      const harness = assetQualityHarness(args.harness);
      const stage = assetQualityStage(args.stage, harness.id);
      const channel = await (loadChannel || loadAssetChannelConfig)({
        channelPack: args.channelPack, channelConfig: args.channelConfig, env, expectedHarnessId: harness.id,
      });
      const { contract, blockers } = createAssetQualityContract({
        harnessId: harness.id, stage: stage.id, channelConfig: channel.config, channelSource: channel.source,
      });
      if (!contract) {
        print(stdout, { issues: blockers.map((blocker) => `asset-quality-channel-config-invalid:${blocker}`), detail: "Channel Pack の asset-quality.json に直せない値がある" }, args.json);
        return { exitCode: 3 };
      }
      stdout.write(`${JSON.stringify(contract, null, 2)}\n`);
      return { exitCode: 0, contract };
    }
    case "start": {
      const result = await startAssetQualityLoop({
        workDir: args.workDir,
        harnessId: args.harness,
        stage: args.stage,
        subjectId: args.subject,
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
      const result = await assetQualityReviewTemplate({
        workDir: args.workDir, stage: args.stage, subjectId: args.subject, assetPath: args.asset, references: args.reference,
      });
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return { exitCode: 0, result };
    }
    case "record": {
      const result = await recordAssetQualityRound({
        workDir: args.workDir,
        stage: args.stage,
        subjectId: args.subject,
        assetPath: args.asset,
        versionLabel: args.version,
        reviewPath: args.review,
        producerContexts: args.producerContext,
        producerHost: args.producerHost,
        generationRoute: args.route,
        references: args.reference,
        referenceExemptReason: args.referenceExemptReason,
        approvedReferencesPath: args.approvedReferences,
        measurementPath: args.measurement,
        revisionDelta: args.revisionDelta,
        previousFailureFingerprint: args.previousFailure,
        blockingCondition: args.blockingCondition,
        cost: args.cost === undefined ? 0 : Number(args.cost),
        env,
        ...injected,
        captureLearning: learn,
      });
      print(stdout, result, args.json);
      if (!args.json && result.learning) {
        stdout.write(result.learning.skippedReason
          ? `学習候補は積んでいません（${result.learning.skippedReason}）\n`
          : `学習候補 ${result.learning.captured} 件を ${result.learning.target} へ積みました（既にあったもの ${result.learning.duplicates} 件）\n`);
      }
      return { exitCode: result.recorded || result.alreadyRecorded ? 0 : 3, result };
    }
    case "verify": {
      if (args.pass === true && args.reject === true) throw new Error("--pass と --reject は同時に使えません。");
      const result = await recordAssetHumanVerification({
        workDir: args.workDir,
        stage: args.stage,
        subjectId: args.subject,
        assetPath: args.asset,
        checks: args.check,
        verdict: args.pass === true ? "pass" : args.reject === true ? "reject" : "",
        reviewer: args.reviewer,
        note: args.note,
        humanVerified: args.humanVerified === true,
        agentAttested: args.agentAttested === true,
        isInteractive,
        ...(now ? { now } : {}),
        captureLearning: learn,
      });
      print(stdout, result, args.json);
      return { exitCode: result.recorded && result.counted ? 0 : 3, result };
    }
    case "status": {
      if (args.subject) {
        const result = await assetQualityStatus({ workDir: args.workDir, stage: args.stage, subjectId: args.subject, assetPath: args.asset });
        if (args.json) print(stdout, result, true);
        else {
          print(stdout, result, false);
          for (const round of result.rounds || []) {
            stdout.write(`  ${round.index}. 版 ${round.version}（${round.route}） ${round.score}点`
              + `${round.floorFailures.length ? ` 下限割れ: ${round.floorFailures.join(", ")}` : ""}`
              + `${round.failedGateIds.length ? ` 機械ゲート: ${round.failedGateIds.join(", ")}` : ""}\n`);
          }
          const human = result.check?.humanVerification;
          if (human?.required?.length) stdout.write(`  人の確認: 要る ${human.required.join(", ")} / 済み ${human.verified.join(", ") || "なし"}`
            + `${human.rejected.length ? ` / 否 ${human.rejected.join(", ")}` : ""}\n`);
          stdout.write(`合格（使ってよい状態）: ${result.pass ? "はい" : "いいえ"}\n`);
        }
        if (!result.started) return { exitCode: 3, result };
        return { exitCode: args.requirePass && !result.pass ? 4 : 0, result };
      }
      const result = await listAssetQualityStatus({ workDir: args.workDir, stage: args.stage || "" });
      if (args.json) print(stdout, result, true);
      else {
        for (const entry of result.entries) stdout.write(`  ${entry.stage}/${entry.subjectId}: ${entry.status}${entry.pass ? "" : "（未合格）"}\n`);
        stdout.write(`全部合格: ${result.pass ? "はい" : "いいえ"}（${result.entries.length} 件）\n`);
      }
      if (!result.started) return { exitCode: 3, result };
      return { exitCode: args.requirePass && !result.pass ? 4 : 0, result };
    }
    default:
      throw new Error(`不明なアクション: ${args.action}（contract / start / sheet / record / verify / status）`);
  }
}

if (isDirectCli(import.meta.url)) {
  runAssetQualityCli().then(({ exitCode }) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
