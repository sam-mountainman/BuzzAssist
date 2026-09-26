#!/usr/bin/env node
// Claude Code / Codex 共通の上位入口。
//
//   node scripts/run-video-harness.mjs plan-request --request "依頼文" [--script-path FILE] [--channel-pack BUNDLE] [--strategy-brief FILE]
//   node scripts/run-video-harness.mjs plan-request --channel ID --request "依頼文" [--request-kind KIND] [--strategy-brief FILE]
//   node scripts/run-video-harness.mjs start --harness ID --script-path FILE --channel-pack BUNDLE [--strategy-brief FILE] [--script-quality-work-dir DIR]
//   node scripts/run-video-harness.mjs resume --job-id ID --confirmed
//   node scripts/run-video-harness.mjs status --job-id ID
//   node scripts/run-video-harness.mjs cancel --job-id ID
//
// start は既定では計画だけを保存する。有料生成へ進めるときだけ --confirmed。
// --reviewer-trust-path は MCP の reviewerTrustPath と同じ「照合用」の引数で、信頼アンカーは
// 常に運営者の環境変数 BUZZASSIST_REVIEWER_TRUST（service 層 assertReviewerTrustPathAgreesWithOperator）。

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import { detectHostInvocation } from "../lib/harnessHostProvenance.mjs";
import { appendManagedToolsToPath } from "../lib/prerequisiteTools.mjs";
import { videoHarnessService } from "../lib/videoHarnessService.mjs";

function parseArgs(argv) {
  const values = { command: argv[0] || "help" };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`余分な引数: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) values[key] = true;
    else { values[key] = next; index += 1; }
  }
  return values;
}

function usage() {
  return [
    "BuzzAssist video harness (Claude Code / Codex common entry)",
    "",
    "plan-request --request TEXT [--channel ID] [--request-kind KIND] [--project-dir DIR] [--harness ID] [--script-path FILE] [--channel-pack BUNDLE] [--strategy-brief FILE] [--options-json FILE] [--doctor]",
    "  依頼に合うハーネスの候補・理由（一致した語・否定された語・入力要件・前提・実績・Channel Pack の向き先）と、",
    "  決めきれないときの1問を JSON で返す。モデルも有料 API も呼ばず、Job も作らない。MCP の plan_video_request と同じ結果。",
    "  --doctor で候補ごとに harness-doctor を走らせる（既定では走らせない）。start と同じ Koya の引数（--episode-id など）も受ける。",
    "  --channel ID [--request-kind KIND]: チャンネルの台帳（config/harness-deployments.json の channels）から作業フォルダ・",
    "  署名済み Channel Pack・制作の仕組み・戦略の作業フォルダ・台本の品質ループの設定を決め、依頼の種類（new-design / next-video /",
    "  script-review / produce / rerender / post-publish / research）と戦略の作業フォルダのブリーフの状態から、次の工程の推奨と",
    "  代案（workflow）を返す。種類を決めきれなければ1問を返す（答えは --request-kind）。戦略スキルは実行しない。",
    "start  --harness ID --script-path FILE --channel-pack BUNDLE [--strategy-brief FILE] [--script-quality-work-dir DIR] [--confirmed] [--reviewer-trust-path JSON] [--host-model ID]",
    "start  --channel ID --script-path FILE [--strategy-brief FILE] [--script-quality-work-dir DIR] [--confirmed] ...",
    "  --channel: 作業フォルダ・署名済み Channel Pack・ハーネスをチャンネルの台帳から決める（--project-dir / --channel-pack /",
    "  --harness を渡すと台帳と照合し、違えば channel-input-conflict）。台帳の strategy.requireBrief が true なら、合格した",
    "  --strategy-brief（verdict が pass）が無ければ有料の処理の前・Job を作る前に止める（channel-strategy-brief-required /",
    "  channel-strategy-brief-not-passed。plan-request が推奨する工程を添える）。外部の制作のチャンネルは start しない",
    "  （channel-production-external）。--channel が無くても Pack・作業フォルダが台帳のチャンネルに当たれば同じ関門を通る。",
    "",
    "--script-quality-work-dir DIR（start。任意）: 台本の品質ループ（node scripts/script-quality-loop.mjs）の作業フォルダ。",
    "  省くと --script-path のあるフォルダ（台本スキルが script.md・script-package.json を出すフォルダで、ループの状態と",
    "  外部モデルの呼び出しの台帳はその quality/ にある）。options.scriptQualityWorkDir に残る（Job の識別子に入る。MCP /",
    "  --options-json でも同じ鍵）。漫画（制作契約 v56 から）とナレーション物語（監査契約 v8 から）は、有料の処理の前に、",
    "  使う台本のバイト列がこのフォルダのループで合格した版か、人がそのまま使うと認めた版（accept-human --human-verified）",
    "  かを問い、どちらでもなければ script-quality-required:<理由コード> と次のコマンドを返して人待ちで止まる。",
    "  plan-only の start も同じ理由を preflight.blockers に出す。依頼者・運営者が書いた台本は accept-human で通る。",
    "--strategy-brief FILE（plan-request / start。任意）: 企画ブリーフ（buzzassist-strategy-brief-v1）。plan-request は",
    "  node scripts/strategy-brief.mjs verdict の合否と根拠の状態を理由に出し、start はブリーフの SHA-256 を",
    "  options.strategyBriefSha256 に残す（Job の識別子に入る。MCP では options.strategyBriefSha256 を渡す）。",
    "  必須にするかはチャンネルの台帳の strategy.requireBrief で決まる（台帳のチャンネルでなければ合否で止めない）。",
    "  ブリーフのファイルの場所は Job の metadata に残り、resume は start のときの SHA と今のファイルの SHA を比べて、",
    "  違えば strategy-brief-changed-since-start（無ければ strategy-brief-missing-at-resume）で止める（新しい Job として start する）。",
    "resume --job-id ID --project-dir DIR --confirmed [--reviewer-trust-path JSON] [--retry-failed-images] [--finalize-after-update] [--host-model ID]",
    "status --job-id ID --project-dir DIR",
    "cancel --job-id ID --project-dir DIR",
    "list   --project-dir DIR",
    "",
    "Koya (koya-manga-video) options: --episode-id ID --protagonist-speaker-id ID --character-bible-path FILE --story-review-path FILE [--contract-path FILE] [--override-path FILE] [--confirm-paid-video-generation] [--retry-failed-video] [--wardrobe-readiness-override-reason TEXT]",
    "  --episode-id / --protagonist-speaker-id / --character-bible-path / --story-review-path は start の時点で必須（plan-only でも）。",
    "  Job の識別子に入るので後から足せない。欠けていれば Job を作らずに koya-start-options-missing で止まる",
    "  --wardrobe-readiness-override-reason: 台本駆動の衣装ゲート（wardrobe-readiness）の pass レポートが無いまま有料の画像生成を始める。理由は Job と最終監査に残る",
    "  --confirm-paid-video-generation: エピソード例外で印を付けたカットの動画クリップ生成（別課金）を許可する。無ければ開始フレームと費用計画だけ作って止まる",
    "Narrated (narrated-story-video) options: --episode-id ID [--operator-image-manifest FILE] [--operator-video-manifest FILE]",
    "  --operator-image-manifest: 運営者が用意した本編の画（ChatGPT の web 画面・Codex・ローカルモデル・Grok など）を、",
    "  取り込みの記録（buzzassist-operator-image-manifest-v1）ごと公式経路へ入れる。Channel Pack の image.source が",
    "  operator-file のときに要り、start の時点で渡す（Job の識別子に入る。MCP / --options-json では options.operatorImageManifestPath）。",
    "  --operator-video-manifest: 回ごとの OP 映像・感想パートの人物の映像を、取り込みの記録（buzzassist-operator-video-manifest-v1）ごと",
    "  入れる。Channel Pack が bookends.opening.kind: episode-video か bookends.review.presenter.episodeVideo を宣言したときに要り、",
    "  start の時点で渡す（Job の識別子に入る。MCP / --options-json では options.operatorVideoManifestPath）。",
    "  画の Media Job は作らず、全部の場面をこの記録から取る。sha256・場面の過不足・使い回しの理由・承認済みの参照・寸法の",
    "  いずれかが合わなければ有料の処理の前に operator-image-* の理由で止まる。画を差し替えたら同じ Job を resume すれば、",
    "  声と BGM を払い直さずに作り直す。会話の URL は私有の Job フォルダにだけ残り、Receipt と Canvas には sha256 だけが出る。",
    "Explainer (explainer-video) options: [--explainer-mode import-delivery|produce] [--explainer-renderer-url URL] [--script-quality-work-dir DIR]",
    "  既定の import-delivery は、Channel Pack が指す納品の記録（動画・字幕・サムネ・投稿用情報）と台本の SHA を照合して取り込み、",
    "  完成 MP4 で監査する（制作のスクリプトを起動しない。BuzzAssist の有料の送り口は関所で送る前に止まる）。produce は Pack の",
    "  制作のコマンドを3つのパスを明示して起動する。どちらも start の時点で決まる（Job の識別子に入る）。台本の品質ループの",
    "  作業フォルダは --script-quality-work-dir、無ければ Pack の scriptQuality.workDir。人の試聴・初見の評価は機械の監査の外で、",
    "  Job は explainer-human-review-pending を残して awaiting-human-review で止まる。",
    "Common: --want TEXT --title TEXT --options-json FILE",
    "",
    "--confirmed が無い start は durable job を作るだけで、有料APIを呼びません。",
    "",
    "--host-model ID（start / resume）: いま動いているエージェントのモデル ID を宣言として Job と RunReceipt に残す。",
    "  分からなければ付けない（unknown と記録される）。ホスト（Claude Code / Codex / Antigravity / 素の端末）は",
    "  環境変数の名前から判定し、値は記録しない。Job の識別子には入らない（別のホストから resume しても同じ Job）。",
    "",
    "--reviewer-trust-path は MCP の run_video_harness / resume_video_harness_job の reviewerTrustPath と同じ照合用引数です。",
    "--retry-failed-images は、失敗した画像だけを同じ Job のまま作り直します（完成済みは再課金しない）。Job の識別子には入らず、使った事実は台帳と Receipt に残ります。",
    "--finalize-after-update（resume）: BuzzAssist の更新で canonical-identity-drift に止まった Job を、入力（台本・Channel Pack・options・",
    "  取り込みの記録）が同じなら、作り直さず・新しい有料の呼び出しをせずに、Job に固定した契約の版で確定までやり直します。",
    "  新しい有料の呼び出しが1件でも要れば送る前に止め（finalize-after-update-paid-call-required）、入力が変わっていれば",
    "  今までどおり止めます。どちらも新しい Job を作ってください。Job ID は変わらず、RunReceipt の codeIdentity に残ります。",
    "  reviewer 信頼リストの唯一の信頼アンカーは運営者が実行側に設定する環境変数 BUZZASSIST_REVIEWER_TRUST",
    "  （または BUZZASSIST_REVIEWER_TRUST_JSON。旧 BUZZASSIST_KOYA_REVIEWER_TRUST(_JSON) は互換で読み、新旧不一致は env-ambiguous）。",
    "  明示 path の内容が env と一致しなければ reviewer-trust-conflict、env 未設定なら明示 path があっても",
    "  reviewer-trust-unconfigured で fail-closed（要求側の入力だけで信頼アンカーは立てられない）。一致した path は子 CLI にも渡ります。",
    "  Job identity には入らず、--options-json の reviewerTrust* / 鍵 path（reviewerKeyPath 等）/ PEM は拒否されます。",
    "",
    "reviewer signoff / reviewer-key-create は production Job とは別 context の工程です:",
    "  node scripts/koya-manga-video.mjs signoff|reviewer-key-create ...  /  node scripts/narrated-story-video.mjs signoff|reviewer-key-create ...",
    "  （MCP: run_koya_manga_pipeline / signoff_video_harness_job / create_video_harness_reviewer_key。秘密鍵は --reviewer-key-path の file からだけ読みます）",
  ].join("\n");
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function optionsFrom(args) {
  let options = {};
  if (typeof args.optionsJson === "string") {
    options = JSON.parse(await readFile(resolve(args.optionsJson), "utf8"));
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("--options-json はJSON objectであること。");
  }
  const mappings = [
    ["episodeId", args.episodeId],
    ["title", args.title],
    ["protagonistSpeakerId", args.protagonistSpeakerId],
    ["characterBiblePath", args.characterBiblePath ? resolve(args.characterBiblePath) : ""],
    ["storyReviewPath", args.storyReviewPath ? resolve(args.storyReviewPath) : ""],
    ["contractPath", args.contractPath ? resolve(args.contractPath) : ""],
    ["overridePath", args.overridePath ? resolve(args.overridePath) : ""],
    ["wardrobeReadinessOverrideReason", typeof args.wardrobeReadinessOverrideReason === "string" ? args.wardrobeReadinessOverrideReason : ""],
    ["operatorImageManifestPath", typeof args.operatorImageManifest === "string" ? resolve(args.operatorImageManifest) : ""],
    ["operatorVideoManifestPath", typeof args.operatorVideoManifest === "string" ? resolve(args.operatorVideoManifest) : ""],
    ["scriptQualityWorkDir", typeof args.scriptQualityWorkDir === "string" ? resolve(args.scriptQualityWorkDir) : ""],
    ["explainerMode", typeof args.explainerMode === "string" ? args.explainerMode : ""],
    ["explainerRendererUrl", typeof args.explainerRendererUrl === "string" ? args.explainerRendererUrl : ""],
  ];
  if (args.scriptQualityWorkDir === true) throw new Error("--script-quality-work-dir には台本の品質ループの作業フォルダの path が要る。");
  if (args.explainerMode === true) throw new Error("--explainer-mode には import-delivery か produce が要る。");
  if (args.explainerRendererUrl === true) throw new Error("--explainer-renderer-url には手元の HTTP サーバーの URL が要る。");
  if (args.operatorImageManifest === true) throw new Error("--operator-image-manifest には取り込みの記録（manifest JSON）の path が要る。");
  if (args.operatorVideoManifest === true) throw new Error("--operator-video-manifest には取り込みの記録（manifest JSON）の path が要る。");
  for (const [key, value] of mappings) if (value !== undefined && value !== "") options[key] = value;
  if (args.retryFailed === true) options.retryFailed = true;
  if (args.confirmPaidVideoGeneration === true) options.confirmPaidVideoGeneration = true;
  if (args.retryFailedVideo === true) options.retryFailedVideo = true;
  return options;
}

// 照合用の信頼リスト path。中身（PEM / 信頼リスト JSON）は argv に載せない。service 側が
// 運営者 env と照合し、不一致は reviewer-trust-conflict、env 未設定は reviewer-trust-unconfigured。
function reviewerTrustPathFrom(args) {
  if (args.reviewerTrustPath === undefined) return "";
  if (typeof args.reviewerTrustPath !== "string") throw new Error("--reviewer-trust-path には信頼リスト JSON の path が要る。");
  return resolve(args.reviewerTrustPath);
}

/**
 * --strategy-brief のブリーフを読み、SHA-256 を options.strategyBriefSha256 に入れる（Job の識別子に入る）。
 * 合否では止めない（必須にするかはチャンネルの設定で後から選ぶ）。ブリーフとして読めないものだけ止める。
 */
export async function strategyBriefStartOptions(args, options = {}) {
  if (args.strategyBrief === undefined) return { options, strategyBrief: null };
  if (typeof args.strategyBrief !== "string") throw new Error("--strategy-brief には企画ブリーフのファイルの path が要る。");
  const { strategyBriefHandoff } = await import("../lib/strategyBriefQualityLoop.mjs");
  const strategyBrief = await strategyBriefHandoff({ briefPath: resolve(args.strategyBrief) });
  if (options.strategyBriefSha256 !== undefined && options.strategyBriefSha256 !== strategyBrief.briefSha256) {
    throw new Error("--options-json の strategyBriefSha256 が --strategy-brief のブリーフの SHA-256 と違う。");
  }
  return { options: { ...options, strategyBriefSha256: strategyBrief.briefSha256 }, strategyBrief };
}

// この CLI を呼んだホスト。どのホストの印も無い素の端末なら "cli"。モデルは宣言されたときだけ。
export function cliHostInvocation(args, env = process.env) {
  if (args.hostModel === true) throw new Error("--host-model にはモデル ID が要る。分からなければ付けない。");
  return detectHostInvocation({ via: "cli", env, hostModel: args.hostModel });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = resolve(typeof args.projectDir === "string" ? args.projectDir : process.cwd());
  switch (args.command) {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`${usage()}\n`);
      return;
    case "plan-request": {
      if (args.strategyBrief === true) throw new Error("--strategy-brief には企画ブリーフのファイルの path が要る。");
      const { planVideoRequest } = await import("../lib/videoRequestPlan.mjs");
      print(await planVideoRequest({
        request: typeof args.request === "string" ? args.request : "",
        harnessId: typeof args.harness === "string" ? args.harness : "",
        channelId: typeof args.channel === "string" ? args.channel : "",
        requestKind: typeof args.requestKind === "string" ? args.requestKind : "",
        projectDir,
        scriptPath: typeof args.scriptPath === "string" ? resolve(args.scriptPath) : "",
        channelPackPath: typeof args.channelPack === "string" ? resolve(args.channelPack) : "",
        strategyBriefPath: typeof args.strategyBrief === "string" ? resolve(args.strategyBrief) : "",
        options: await optionsFrom(args),
        checkPrerequisites: args.doctor === true,
      }));
      return;
    }
    case "start": {
      if (!args.scriptPath) throw new Error("start には --script-path が要る。");
      if (args.channel === true) throw new Error("--channel にはチャンネルの台帳の id が要る。");
      const channelId = typeof args.channel === "string" ? args.channel : "";
      // --channel なら作業フォルダ・Pack・ハーネスは台帳から決まる（渡せば台帳と照合する）。
      if (!args.channelPack && !channelId) throw new Error("本番上位Jobには署名済み --channel-pack（または --channel）が要る。");
      if (args.strategyBrief === true) throw new Error("--strategy-brief には企画ブリーフのファイルの path が要る。");
      const { options, strategyBrief } = channelId
        ? { options: await optionsFrom(args), strategyBrief: null }
        : await strategyBriefStartOptions(args, await optionsFrom(args));
      const result = await videoHarnessService.start({
        projectDir: channelId && typeof args.projectDir !== "string" ? undefined : projectDir,
        scriptPath: resolve(args.scriptPath),
        harnessId: typeof args.harness === "string" ? args.harness : "",
        want: typeof args.want === "string" ? args.want : "",
        channelPackPath: typeof args.channelPack === "string" ? resolve(args.channelPack) : "",
        options,
        confirmed: args.confirmed === true,
        reviewerTrustPath: reviewerTrustPathFrom(args),
        invocation: cliHostInvocation(args),
        channelId,
        strategyBriefPath: typeof args.strategyBrief === "string" ? resolve(args.strategyBrief) : "",
      });
      print(strategyBrief ? { ...result, strategyBrief } : result);
      if (result.execution.started && result.status !== "completed") {
        process.exitCode = result.status === "awaiting-human-review" ? 3 : 2;
      }
      return;
    }
    case "resume": {
      if (!args.jobId) throw new Error("resume には --job-id が要る。");
      if (args.confirmed !== true) throw new Error("resume は有料生成へ進み得るため --confirmed が要る。");
      if (args.operatorImageManifest !== undefined) {
        // 黙って捨てると「渡したのに効かない」に見える。置き場は Job の識別子なので start でしか決められない。
        throw new Error("--operator-image-manifest は start でだけ渡す（Job の識別子に入る）。画を差し替えたら、start で渡した同じ manifest の中身（画と sha256）を直して resume する。");
      }
      if (args.operatorVideoManifest !== undefined) {
        throw new Error("--operator-video-manifest は start でだけ渡す（Job の識別子に入る）。動画を差し替えたら、start で渡した同じ manifest の中身（動画と sha256）を直して resume する。");
      }
      if (args.scriptQualityWorkDir !== undefined) {
        throw new Error("--script-quality-work-dir は start でだけ渡す（Job の識別子に入る）。台本を受け入れた・ループが合格したら、同じ Job をそのまま resume する。");
      }
      const result = await videoHarnessService.resume({
        projectDir,
        jobId: String(args.jobId),
        confirmed: true,
        reviewerTrustPath: reviewerTrustPathFrom(args),
        retryFailedImages: args.retryFailedImages === true,
        finalizeAfterUpdate: args.finalizeAfterUpdate === true,
        invocation: cliHostInvocation(args),
      });
      print(result);
      if (result.status !== "completed") process.exitCode = result.status === "awaiting-human-review" ? 3 : 2;
      return;
    }
    case "status": {
      if (!args.jobId) throw new Error("status には --job-id が要る。");
      print(await videoHarnessService.get({ projectDir, jobId: String(args.jobId) }));
      return;
    }
    case "cancel": {
      if (!args.jobId) throw new Error("cancel には --job-id が要る。");
      print(await videoHarnessService.cancel({ projectDir, jobId: String(args.jobId) }));
      return;
    }
    case "list":
      print(await videoHarnessService.list({ projectDir }));
      return;
    default:
      throw new Error(`未知のcommand: ${args.command}\n${usage()}`);
  }
}

if (isDirectCli(import.meta.url)) {
  // setup が ~/.buzzassist/tools に入れた ffmpeg / ffprobe を各工程に見せる（運営者の PATH が先）。
  appendManagedToolsToPath(process.env);
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
