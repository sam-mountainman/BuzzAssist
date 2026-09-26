#!/usr/bin/env node
// 解説動画のハーネス（explainer-video）の入口。運営者の入口は上位の node scripts/run-video-harness.mjs で、
// ここの full はその Job の中で動く runner（Job の束縛が無ければ何もせずに止まる）。plan は読むだけ。
// signoff と reviewer-key-create は、生成とは別の文脈の評価者が人の確認を記録するための入口（Job の外）。

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { trustedChannelPackKeyFromEnvironment, verifyChannelPackEnvelope } from "../lib/channelPackEnvelope.mjs";
import {
  EXPLAINER_HARNESS_ID,
  EXPLAINER_MODE_OPTION,
  EXPLAINER_PAYLOAD_KIND,
  EXPLAINER_RENDERER_URL_OPTION,
  loadExplainerChannelPack,
} from "../lib/explainerChannelPack.mjs";
import {
  EXPLAINER_OUTCOME_VERSION,
  planExplainerVideo,
  runExplainerVideo,
  writeExplainerReviewSignoff,
} from "../lib/explainerVideo.mjs";
import {
  REVIEWER_TRUST_ENV_GUIDANCE,
  REVIEWER_TRUST_PATH_ENV,
  writeReviewerKeyPairFiles,
} from "../lib/koyaReviewAttestation.mjs";
import { appendManagedToolsToPath } from "../lib/prerequisiteTools.mjs";

export { EXPLAINER_OUTCOME_VERSION };

function parseArgs(argv) {
  const parsed = { command: argv[0] || "help" };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`余分な引数: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = value;
      index += 1;
    }
  }
  return parsed;
}

function usage() {
  return [
    "Usage: node scripts/explainer-video.mjs <command> [options]",
    "",
    "plan --channel-pack BUNDLE [--script-path FILE] [--mode import-delivery|produce] [--renderer-url URL] [--script-quality-work-dir DIR]",
    "  読むだけ。署名済み Channel Pack（信頼鍵は BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY）・台本・3つのパス・納品の記録を読み、",
    "  何を再利用し何を実行するか（reuse / wouldRun）と、止まる理由（blockers）を JSON で出す。モデルも有料 API も呼ばず、",
    "  制作のスクリプトも起動しない。動画の実デコードは取り込みの監査で行う。",
    "",
    "full --script-path FILE --job-id ID --project-dir DIR --channel-pack-dir PAYLOAD --upstream-job-path JOB.json --upstream-job-id ID --upstream-job-revision N --upstream-execution-binding SHA256 [--reviewer-trust-path JSON]",
    "  上位の node scripts/run-video-harness.mjs start / resume（MCP の run_video_harness）だけが起動する runner。Job の束縛が",
    `  無い・一部だけなら何もせずに止まる。Job の options.${EXPLAINER_MODE_OPTION} で型が決まる:`,
    "    import-delivery（既定）: 納品の記録の成果物（動画・字幕・サムネ・投稿用情報）と台本の SHA を照合して取り込み、監査する。",
    "      制作のスクリプトは起動しない。BuzzAssist の有料の送り口は関所（BUZZASSIST_PAID_CALL_GUARD）で送る前に止まる",
    "    produce: Pack の production.steps を順に起動し（3つのパス --production-dir / --visuals-dir / --output-dir を必ず明示）、",
    `      できた納品を同じ監査にかける。{rendererUrl} を使う工程は options.${EXPLAINER_RENDERER_URL_OPTION} が要る`,
    "  取り込みの監査の後、完成 MP4 から contact sheet（explainer/review/contact-sheet.png）と評価シート",
    "  （explainer/review/review-sheet.json）を置き、評価者の signoff が無ければ explainer-human-review-pending で",
    "  awaiting-human-review に止まる。signoff があれば信頼リストの鍵の署名を確かめ、機械の監査が全部通っているときだけ",
    "  品質ループの1回として記録する。合格すれば final-audited（共通の RunReceipt が署名を検証し直して completed に確定する）。",
    `  --reviewer-trust-path JSON は ${REVIEWER_TRUST_ENV_GUIDANCE} との照合用（それ単独では信頼アンカーにならない）。`,
    "",
    "signoff --job-id ID --project-dir DIR --reviewer-id NAME --reviewer-context-id ID --reviewer-key-path /absolute/reviewer-ed25519.pem --review-path REVIEW.json --full-length-viewed --pass|--fail [--reviewer claude|codex] [--reviewer-trust-path JSON] [--force]",
    "  人の確認を記録する（生成とは別の文脈の評価者だけが打つ）。評価者は完成 MP4 を最初から最後まで通して見て（聞いて）、",
    "  前提の知識が無い初見の視聴者として、Job の explainer/review/review-sheet.json の評価項目ごとに 0〜100 で採点し、",
    "  --review-path に { rubricScores: { <項目 id>: 点 }, notes: \"見て判断したこと\", findings: [\"直すべき点\"] } を書く",
    "  （評価シートには合格点・下限を載せていない。ループのソースは開かない）。--pass は承認（findings は空）、--fail は差し戻し",
    "  （findings 1件以上）。Job の監査の報告が指す完成 MP4・contact sheet・納品の記録を disk から読み直して SHA を取り、",
    `  --reviewer-key-path の鍵（${REVIEWER_TRUST_PATH_ENV} の信頼リストで active なもの）で Job・完成 MP4・contact sheet・`,
    "  納品の記録に結び付けて署名し、explainer/review/human-review-signoff.json に書く。--reviewer-context-id は評価ごとに新しくする",
    "  （同じ文脈で2回目は採点できない）。2回目以降は explainer/quality/revision-delta.json に前回の失敗と直した内容を書く。",
    "  そのあと node scripts/run-video-harness.mjs resume --job-id ID --project-dir DIR --confirmed で確定まで進める。",
    "",
    "reviewer-key-create --reviewer-key-path /absolute/outside-repo/reviewer-ed25519.pem [--reviewer-public-key-path FILE] [--reviewer-label NAME] [--project-dir DIR]",
    "  評価者の Ed25519 の鍵を作る（ナレーション物語・漫画と同じ実装）。秘密鍵は mode 0600 で書き、リポジトリ・作業フォルダ・",
    "  リポジトリの作業木の中には書かない。出力の trustEntry（公開鍵だけ）を運営者へ渡し、運営者が信頼リストに足す。",
    "",
    "help",
  ].join("\n");
}

function print(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (["help", "--help", "-h"].includes(args.command)) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  if (args.command === "plan") {
    if (typeof args.channelPack !== "string") throw new Error("plan には --channel-pack（署名済み Channel Pack のフォルダ）が要る。");
    const verified = await verifyChannelPackEnvelope({
      bundleDir: resolve(args.channelPack),
      ...(await trustedChannelPackKeyFromEnvironment(process.env)),
      expectedHarnessId: EXPLAINER_HARNESS_ID,
    });
    if (verified.payloadKind !== EXPLAINER_PAYLOAD_KIND) throw new Error(`Channel Pack の payloadKind が ${EXPLAINER_PAYLOAD_KIND} ではない: ${verified.payloadKind}`);
    const pack = await loadExplainerChannelPack(verified.payloadDir);
    const options = {
      ...(typeof args.mode === "string" ? { [EXPLAINER_MODE_OPTION]: args.mode } : {}),
      ...(typeof args.rendererUrl === "string" ? { [EXPLAINER_RENDERER_URL_OPTION]: args.rendererUrl } : {}),
      ...(typeof args.scriptQualityWorkDir === "string" ? { scriptQualityWorkDir: resolve(args.scriptQualityWorkDir) } : {}),
    };
    const plan = await planExplainerVideo({
      pack,
      scriptPath: typeof args.scriptPath === "string" ? resolve(args.scriptPath) : "",
      options,
    });
    print({ ...plan, channelPack: { payloadSha256: verified.payloadSha256, signerKeyId: verified.signerKeyId } });
    return plan;
  }
  if (args.command === "reviewer-key-create") {
    if (typeof args.reviewerKeyPath !== "string") {
      throw new Error("reviewer-key-create には --reviewer-key-path FILE が要る（秘密鍵はそこに書き、印字しない）。");
    }
    const created = await writeReviewerKeyPairFiles({
      privateKeyPath: resolve(args.reviewerKeyPath),
      publicKeyPath: typeof args.reviewerPublicKeyPath === "string" ? resolve(args.reviewerPublicKeyPath) : "",
      label: typeof args.reviewerLabel === "string" ? args.reviewerLabel : "",
      projectDir: resolve(args.projectDir || process.cwd()),
    });
    print({
      ...created,
      next: `trustEntry（公開鍵だけ）を別の経路で運営者へ渡す。運営者が信頼リストの reviewers[] に足し、監査・確定を動かす端末の ${REVIEWER_TRUST_PATH_ENV} にその file を指させる。秘密鍵は Channel Pack・signoff・引数・MCP の引数・Job の options に載せない。`,
    });
    return created;
  }
  if (args.command === "signoff") {
    if ((args.pass === true) === (args.fail === true)) {
      throw new Error("signoff には --pass（承認）か --fail（差し戻し）のどちらか1つが要る。完成 MP4 を全編通して見て（聞いて）から打つ。");
    }
    if (typeof args.reviewerKeyPath !== "string") throw new Error("signoff には --reviewer-key-path FILE（評価者の Ed25519 の秘密鍵）が要る。鍵の中身を引数に書かない。");
    if (typeof args.reviewPath !== "string") throw new Error("signoff には --review-path FILE（評価シートで採点した { rubricScores, notes, findings }）が要る。");
    if (typeof args.jobId !== "string") throw new Error("signoff には --job-id（上位の Job の id）が要る。");
    const projectDir = resolve(typeof args.projectDir === "string" ? args.projectDir : process.cwd());
    // Job を読む部品は signoff のときだけ読み込む（Job の中の runner の起動を重くしない）。
    const { readVideoHarnessJob } = await import("../lib/videoHarnessJob.mjs");
    let job;
    try {
      job = await readVideoHarnessJob({ projectDir, jobId: args.jobId });
    } catch (error) {
      throw new Error(`Job を読めない（--project-dir は Job を作った作業フォルダを指す）: ${error?.message || error}`);
    }
    const written = await writeExplainerReviewSignoff({
      job,
      reviewerId: typeof args.reviewerId === "string" ? args.reviewerId : "",
      reviewerHost: typeof args.reviewer === "string" ? args.reviewer : "",
      reviewerContextId: typeof args.reviewerContextId === "string" ? args.reviewerContextId : "",
      reviewerPrivateKeyPath: resolve(args.reviewerKeyPath),
      reviewerTrustPath: typeof args.reviewerTrustPath === "string" ? resolve(args.reviewerTrustPath) : "",
      reviewPath: resolve(args.reviewPath),
      pass: args.pass === true,
      fail: args.fail === true,
      fullLengthViewed: args.fullLengthViewed === true,
      force: args.force === true,
    });
    const result = {
      jobId: job.id,
      outputPath: written.outputPath,
      reviewer: written.signoff.reviewer,
      reviewerContextId: written.signoff.reviewerContextId,
      reviewerKeyId: written.signerKeyId,
      videoSha256: written.videoSha256,
      contactSheetSha256: written.contactSheetSha256,
      deliverySha256: written.deliverySha256,
      approved: written.signoff.approved === true,
      next: `node scripts/run-video-harness.mjs resume --job-id ${job.id} --project-dir ${projectDir} --confirmed（runner と共通の RunReceipt がこの署名を信頼リストで検証し直し、品質ループの1回として記録する）`,
    };
    print(result);
    return result;
  }
  if (args.command !== "full") throw new Error(`未知の command: ${args.command}\n${usage()}`);
  const outcome = await runExplainerVideo({
    scriptPath: typeof args.scriptPath === "string" ? resolve(args.scriptPath) : "",
    channelPackDir: typeof args.channelPackDir === "string" ? resolve(args.channelPackDir) : "",
    jobId: typeof args.jobId === "string" ? args.jobId : "",
    projectDir: typeof args.projectDir === "string" ? resolve(args.projectDir) : "",
    upstreamJobPath: typeof args.upstreamJobPath === "string" ? resolve(args.upstreamJobPath) : "",
    upstreamJobId: typeof args.upstreamJobId === "string" ? args.upstreamJobId : "",
    upstreamJobRevision: typeof args.upstreamJobRevision === "string" ? args.upstreamJobRevision : "",
    upstreamExecutionBinding: typeof args.upstreamExecutionBinding === "string" ? args.upstreamExecutionBinding : "",
    reviewerTrustPath: typeof args.reviewerTrustPath === "string" ? resolve(args.reviewerTrustPath) : "",
  });
  print(outcome);
  process.exitCode = outcome.status === "final-audited" ? 0 : outcome.status === "awaiting-human-review" ? 3 : 2;
  return outcome;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // setup が ~/.buzzassist/tools に入れた ffmpeg / ffprobe を各工程に見せる（運営者の PATH が先）。
  appendManagedToolsToPath(process.env);
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
