#!/usr/bin/env node
// 解説動画のハーネス（explainer-video）の入口。運営者の入口は上位の node scripts/run-video-harness.mjs で、
// ここの full はその Job の中で動く runner（Job の束縛が無ければ何もせずに止まる）。plan は読むだけ。

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
import { EXPLAINER_OUTCOME_VERSION, planExplainerVideo, runExplainerVideo } from "../lib/explainerVideo.mjs";
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
    "full --script-path FILE --job-id ID --project-dir DIR --channel-pack-dir PAYLOAD --upstream-job-path JOB.json --upstream-job-id ID --upstream-job-revision N --upstream-execution-binding SHA256",
    "  上位の node scripts/run-video-harness.mjs start / resume（MCP の run_video_harness）だけが起動する runner。Job の束縛が",
    `  無い・一部だけなら何もせずに止まる。Job の options.${EXPLAINER_MODE_OPTION} で型が決まる:`,
    "    import-delivery（既定）: 納品の記録の成果物（動画・字幕・サムネ・投稿用情報）と台本の SHA を照合して取り込み、監査する。",
    "      制作のスクリプトは起動しない。BuzzAssist の有料の送り口は関所（BUZZASSIST_PAID_CALL_GUARD）で送る前に止まる",
    "    produce: Pack の production.steps を順に起動し（3つのパス --production-dir / --visuals-dir / --output-dir を必ず明示）、",
    `      できた納品を同じ監査にかける。{rendererUrl} を使う工程は options.${EXPLAINER_RENDERER_URL_OPTION} が要る`,
    "  人の試聴・初見の評価は機械の監査の外で、いつも knownRemainingIssues に残る（awaiting-human-review で止まる）。",
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
