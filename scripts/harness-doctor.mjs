#!/usr/bin/env node
// ハーネスの前提チェック（Claude Code / Codex 共通）
//
//   node scripts/harness-doctor.mjs
//   node scripts/harness-doctor.mjs --json
//   node scripts/harness-doctor.mjs --harness koya-manga-video
//
// なぜ要るか:
// setup は「configured」と出すが、それはホストの設定が済んだという意味でしかない。
// ffmpeg も python3 も API キーも見ていないので、運営者が最初の本番を回した
// ときに、パイプラインの奥で生の ENOENT が出て止まる。設定できたことと
// 動かせることを同じ言葉で報告していた——このリポジトリで繰り返し見つけた
// 「検証したと書いてあるのに検証していない」と同じ形。
//
// ここが守る規則:
//   - **在ることを確かめるのではなく、動くことを確かめる**。PATH に名前が
//     あるだけでは通さない。実際に起動して版を答えさせる
//   - **足りないものは、直し方まで書く**。「ffmpeg がありません」だけでは、
//     非エンジニアの運営者は次に何をすればいいのか分からない
//   - **秘密は値を出さない**。あるか無いかだけ
//   - **必須と任意を混ぜない**。任意の欠落で止めると、canvas だけ使いたい人が
//     セットアップできなくなる

import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm, statfs } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import path from "node:path";

import { channelPackPresent } from "../lib/channelPackResolver.mjs";
import { resolveKoyaDialogueAdapter, resolveKoyaMangaProductionContract } from "../lib/koyaMangaProductionContract.mjs";
import { CHANNEL_PACK_ENVELOPE_VERSION } from "../lib/channelPackEnvelope.mjs";
import { requireElevenLabsApiKey } from "../lib/speechGeneration.mjs";
import { resolveLovartCredentials } from "../lib/lovartMediaGeneration.mjs";
import { VOICE_QA_REQUIRED_MODULES, voiceQualityAvailable } from "../lib/voiceQualityGate.mjs";
import {
  fingerprintKoyaChannelAuthority,
  readKoyaChannelAuthority,
} from "../lib/koyaChannelGovernance.mjs";
import { GENRE_CANONICAL_ENTRYPOINTS } from "../lib/harnessRouting.mjs";
import { probeHostSkillSync } from "../lib/hostSkillSync.mjs";
import { channelPackRuntimeAdapterSpecs } from "../lib/harnessChannelPackRuntime.mjs";
import {
  resolveHarnessDeployment,
  resolveHarnessDeploymentCommand,
} from "../lib/harnessDeploymentResolver.mjs";
import {
  formatRuntimeCommand,
  imageHostForModel,
  probeCodexImageHost,
  resolveFfmpegToolchain,
  resolvePythonRuntime,
} from "../lib/harnessRuntimeResolver.mjs";
import { probePaidMediaJobAdapter } from "../lib/paidMediaJobBroker.mjs";
import { REVIEWER_TRUST_ENV_GUIDANCE, REVIEWER_TRUST_PATH_ENV, preflightReviewerTrust } from "../lib/koyaReviewAttestation.mjs";
import { resolveCodexCommand } from "./codex-image-bridge.mjs";
import { appendManagedToolsToPath } from "../lib/prerequisiteTools.mjs";
import { probeSvgRasterizerCached } from "../lib/svgRasterizer.mjs";
import { probeYtQualityLoopHooks } from "../lib/ytQualityLoopHooks.mjs";
import { probeCodexLearningHookTrust } from "../lib/codexHookTrust.mjs";

const defaultRunCommand = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 秘密は「あるか無いか」だけ。値も長さも出さない。
 *
 * 判定は**本体と同じ関数に聞く**。doctor が独自に環境変数だけを見る形にすると、
 * 設定ファイルに保存した人へ「未設定」と言うことになり、doctor が
 * 狼少年になる。狼少年になった検査は読まれなくなり、本当の欠落も見逃される。
 */
async function probeSecretVia(resolve, { label, fix }) {
  try {
    await resolve();
    return { ok: true, detail: "設定あり", fix: "" };
  } catch (error) {
    return { ok: false, detail: `未設定（${label}）`, fix };
  }
}

/**
 * ffmpeg が「動く」ことを、実際に1本作って読み返して確かめる。
 *
 * -version が答えるだけでは足りない。終了0で版を出すだけの stub も、
 * libx264 を欠いた最小ビルドも通ってしまう。本体が使う encoder と filter を
 * 揃えた極小の MP4 を作り、ffprobe で読み、全デコードまで通す。
 * ready と言った直後にレンダーが落ちるなら、それは ready ではない。
 */
/**
 * ハーネスの正規入口が「宣言に書いてある」だけでなく**実在して起動する**かを見る。
 *
 * 以前は produces.kind が表にあるかと entrypoint がプレースホルダでないかしか
 * 見ておらず、存在しないコマンドへ書き換えても通った。表の値だけを根拠に
 * 「正規入口」と報告するのは、観測していない事実を合格理由にすること。
 */
/**
 * 正本のスキルと、ホストが実際に読む配布コピーがずれていないかを見る。
 *
 * 自己改善（harness-learn sync）は正本の references/learned-auto.md を
 * 書き換えるが、配布コピーは setup を再実行するまで古いまま。すると
 * **運営者のエージェントは古い指示を読み、記録には新しい指紋が残る**——
 * 記録が、実際に使われたものと別のものを指すことになる。
 */
// 本編1本ぶんの作業一式が置ける空きがあるかを見る。
//
// なぜ必須か:
// 画像を200〜250枚（実測 13〜16時間・課金済み）生成し終えたあとで書き込みに
// 失敗すると、払った分がそのまま消える。しかも Job は failed で終端になり、
// 同じ入力では死んだ Job に再接続するだけなので、やり直しは全額の再課金になる。
// 「揃っている」と言った直後に金が飛ぶなら、それは揃っていない。
//
// しきい値の出し方（推定であることを明示する。実測した値ではない）:
//   実測できているのは完成済みのベンチ回 manga-arano-amane-effort-001 だけ。
//   台本2,850字・完成8分42秒に対して、作業一式 2.7GB（うち 2.6GB は監査の中間物で、
//   直しを3回まわした履歴を含む）。画像そのものは 195MB、音声は 226MB。
//   本番尺は台本6,000〜7,500字＝尺比およそ2.6倍なので 2.7GB × 2.6 ≒ 7GB。
//   これにレンダー中の一時ファイルぶんを足して 8GiB を下限にしている。
//   **掛け算で出した見積りであって、本番尺を1本通して測った値ではない。**
//   1本目が終わったら、その実測値に置き換えること。
const HARNESS_MIN_FREE_BYTES = 8 * 1024 * 1024 * 1024;

function formatGiB(bytes) {
  return `${(bytes / (1024 ** 3)).toFixed(1)}GiB`;
}

async function probeDiskSpace(projectDir, runtime = {}) {
  // 見るのは実行に使う場所。tmp と別ボリュームのことがあるので、
  // project dir そのものを聞く。
  let free = null;
  try {
    free = typeof runtime.diskFreeBytes === "function"
      ? Number(await runtime.diskFreeBytes(projectDir))
      : await (async () => {
        const stat = await statfs(projectDir);
        return Number(stat.bavail) * Number(stat.bsize);
      })();
  } catch (error) {
    // 測れないこと自体は運営者の落ち度ではないので、必須で止めない。
    // ただし「確かめた」とも言わない。
    return {
      ok: true,
      detail: `空き容量を測れなかった（${String(error?.message || error).slice(0, 80)}）`,
      fix: "",
      measured: false,
    };
  }
  if (!Number.isFinite(free)) {
    return { ok: true, detail: "空き容量を測れなかった（値が数値でない）", fix: "", measured: false };
  }
  const ok = free >= HARNESS_MIN_FREE_BYTES;
  return {
    ok,
    freeBytes: free,
    requiredBytes: HARNESS_MIN_FREE_BYTES,
    measured: true,
    detail: ok
      ? `空き ${formatGiB(free)}（目安 ${formatGiB(HARNESS_MIN_FREE_BYTES)} 以上）`
      : `空き ${formatGiB(free)}。本編1本ぶんの見積り ${formatGiB(HARNESS_MIN_FREE_BYTES)} に足りない`,
    fix: ok ? "" : "有料生成を始める前に空きを作ること。画像を全部作り終えたあとで書き込みに失敗すると、"
      + "払った分は戻らず、Job は再開できないので全額の作り直しになる。"
      + "この目安はベンチ回（台本2,850字で作業一式2.7GB）からの見積りで、本番尺で測った値ではない",
  };
}

/**
 * キャンバスの画像生成は、モデル未指定だと Codex 経由（gpt-image-2-codex）が既定になる。
 * Claude Code だけを入れた運営者は、既定のまま頼むと「Codex を利用できません」で止まる
 * （2026-09-24 監査）。黙って有料の別経路へ切り替えるのは確認なしの課金になるので、
 * ここでは止めずに、使える経路の選び方を先に知らせる。本番 Job の画像経路
 * （Media Job API）とは別の話なので required にはしない。
 */
async function probeDefaultImageRoute({ env = process.env, runtime = {} } = {}) {
  const explicit = String(env.EXCALIDRAW_GPT_IMAGE_2_CODEX_COMMAND || env.EXCALIDRAW_IMAGE_GENERATION_COMMAND
    || env.EXCALIDRAW_GPT_IMAGE_2_CODEX_URL || env.EXCALIDRAW_IMAGE_GENERATION_URL || "").trim();
  if (explicit) return { ok: true, detail: "Codex 経由の画像生成は環境変数で明示された実行先を使う" };
  const disabled = /^(1|true|yes)$/iu.test(String(env.EXCALIDRAW_DISABLE_CODEX_APP_SERVER_BRIDGE || "").trim());
  let command = "";
  if (!disabled) {
    try {
      const resolveCodex = runtime.resolveCodexCommand
        || (await import("./codex-image-bridge.mjs")).resolveCodexCommand;
      command = await resolveCodex();
    } catch {
      command = "";
    }
  }
  if (command) return { ok: true, detail: "既定の画像経路（Codex 経由）に使える Codex がある" };
  return {
    ok: false,
    detail: disabled
      ? "既定の画像経路（Codex 経由）が環境変数で無効化されている"
      : "既定の画像経路（Codex 経由）に使える Codex CLI / ChatGPT アプリが見つからない",
    fix: "キャンバスで画像を頼むとき、モデル未指定だと Codex 経由になって止まる。"
      + "Codex CLI か ChatGPT デスクトップアプリを入れてサインインする（https://chatgpt.com/ja-JP/codex/）か、"
      + "頼むときに Grok（ローカル）など別の経路を明示すること。Lovart と BuzzAssist の経路はクレジットを使う",
  };
}

function probeShippedSkillDrift() {
  const canonicalRoot = path.join(REPO_ROOT, ".agents", "skills");
  const shippedRoot = path.join(homedir(), "plugins", "buzzassist", "plugin", "skills");
  if (!existsSync(shippedRoot)) {
    return { ok: true, detail: "配布コピーが無い（未インストール）", fix: "" };
  }
  const drifted = [];
  for (const entry of readdirSync(canonicalRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const canonicalSkill = path.join(canonicalRoot, entry.name, "SKILL.md");
    const shippedSkill = path.join(shippedRoot, entry.name, "SKILL.md");
    if (!existsSync(canonicalSkill)) continue;
    if (!existsSync(shippedSkill)) { drifted.push(`${entry.name}(未配布)`); continue; }
    // overlay は自己改善が書き換える層なので、ここを重点的に見る。
    const overlayName = path.join("references", "learned-auto.md");
    for (const [rel, label] of [[overlayName, "learned-auto"], ["SKILL.md", "SKILL"]]) {
      const a = path.join(canonicalRoot, entry.name, rel);
      const b = path.join(shippedRoot, entry.name, rel);
      if (!existsSync(a) && !existsSync(b)) continue;
      if (!existsSync(a) || !existsSync(b)) { drifted.push(`${entry.name}/${label}(片方のみ)`); continue; }
      // SKILL.md は配布時に相対参照を書き換えるので、その差は無視する。
      const left = readFileSync(a, "utf8").replaceAll("../../../", "../../");
      if (left !== readFileSync(b, "utf8")) drifted.push(`${entry.name}/${label}`);
    }
  }
  return {
    ok: drifted.length === 0,
    detail: drifted.length === 0 ? "配布コピーが正本と一致" : `ずれ: ${drifted.join(", ")}`,
    fix: drifted.length === 0 ? ""
      : "正本と配布コピーがずれている。自己改善（harness-learn sync）の後に setup を再実行していないと、"
        + "エージェントは古い指示を読み、記録には新しい指紋が残る。"
        + "`node scripts/setup-agents.mjs --agent <host> --project-dir <dir> --no-launch` で配布し直すこと",
  };
}

function configuredHarnessDeployment(harnessId, runtime = {}) {
  if (runtime.deployment && typeof runtime.deployment === "object") return runtime.deployment;
  return resolveHarnessDeployment(harnessId, {
    repoRoot: REPO_ROOT,
    deploymentPath: runtime.deploymentPath || "",
  });
}

async function resolveProductionRouteProbe(declaration, harnessId, { job, runtime = {} } = {}) {
  if (typeof runtime.resolveProductionRoute === "function") {
    return runtime.resolveProductionRoute({ declaration, harnessId, job, projectDir: runtime.projectDir });
  }
  if (harnessId === "narrated-story-video") {
    const deployment = job?.deployment && typeof job.deployment === "object"
      ? job.deployment
      : configuredHarnessDeployment(harnessId, runtime);
    const rootValue = String(deployment.root || "").trim();
    const declaredEntrypoint = String(deployment.entrypoint || "").trim();
    if (!rootValue || !declaredEntrypoint || /<[^>]+>/u.test(declaredEntrypoint)) {
      throw new Error("ナレーションハーネスの実配備root / entrypointが未完成");
    }
    const route = resolveHarnessDeploymentCommand(deployment, { additionalArgs: ["help"] });
    if (!existsSync(route.entrypointPath)) throw new Error(`配備済みの正規internal entrypointが無い: ${declaredEntrypoint}`);
    return {
      command: route.command,
      args: route.args,
      cwd: route.cwd,
      label: route.label,
      mcpTool: "run_video_harness",
    };
  }

  const canonical = GENRE_CANONICAL_ENTRYPOINTS[declaration?.produces?.kind];
  if (!canonical) throw new Error(`${declaration?.produces?.kind || "unknown"} が正規ルーティングに登録されていない`);
  const entrypoint = String(declaration.entrypoint || "");
  if (/<[^>]+>/u.test(entrypoint) || !entrypoint) throw new Error(`入口がプレースホルダのまま: ${entrypoint || "(未設定)"}`);
  if (entrypoint.trim() !== canonical.cli.trim()) {
    throw new Error(`宣言の入口が正規 CLI と違う: 宣言「${entrypoint}」/ 正規「${canonical.cli}」`);
  }
  const script = canonical.cli.replace(/^node\s+/u, "").trim();
  const scriptPath = path.join(REPO_ROOT, script);
  if (!existsSync(scriptPath)) throw new Error(`正規 CLI のスクリプトが無い: ${script}`);
  return {
    command: process.execPath,
    args: [scriptPath, "help"],
    cwd: REPO_ROOT,
    label: canonical.cli,
    mcpTool: canonical.mcpTool,
  };
}

async function probeProductionRoute(declaration, harnessId, { runCommand = defaultRunCommand, job = null, runtime = {} } = {}) {
  if (!declaration) {
    return { ok: false, detail: `宣言が読めない: config/harnesses/${harnessId}.harness.json`,
      fix: `config/harnesses/${harnessId}.harness.json を置くこと` };
  }
  let route;
  try {
    route = await resolveProductionRouteProbe(declaration, harnessId, { job, runtime });
    await runCommand(route.command, route.args, { cwd: route.cwd, timeout: 30_000 });
  } catch (error) {
    return { ok: false, detail: `正規 CLI が起動しない: ${String(error?.message || error).slice(0, 140)}`,
      fix: `${harnessId} の実配備canonical entrypointを配置し、非課金の help probe が通る状態にすること` };
  }
  return { ok: true, detail: `正規入口が起動した: ${route.mcpTool || "run_video_harness"} / ${route.label}`, fix: "" };
}

async function probeFfmpegCapability({ ffmpeg, ffprobe, runCommand = defaultRunCommand } = {}) {
  const missing = [];
  if (!ffmpeg?.command || !ffprobe?.command) {
    return { ok: false, missing: ["ffmpeg", "ffprobe"], detail: "ffmpeg / ffprobe の実行先を解決できない" };
  }
  try {
    const { stdout } = await runCommand(ffmpeg.command, [...(ffmpeg.args ?? []), "-hide_banner", "-encoders"], { timeout: 20_000 });
    for (const encoder of ["libx264", "aac", "pcm_s24le"]) {
      if (!stdout.includes(encoder)) missing.push(`encoder:${encoder}`);
    }
  } catch (error) {
    return { ok: false, missing, detail: `encoder 一覧を取れない: ${String(error?.message || error).slice(0, 120)}` };
  }
  try {
    const { stdout } = await runCommand(ffmpeg.command, [...(ffmpeg.args ?? []), "-hide_banner", "-filters"], { timeout: 20_000 });
    for (const filter of ["scale", "crop", "overlay", "fps", "loudnorm", "aresample"]) {
      if (!new RegExp(`\\b${filter}\\b`, "u").test(stdout)) missing.push(`filter:${filter}`);
    }
  } catch (error) {
    return { ok: false, missing, detail: `filter 一覧を取れない: ${String(error?.message || error).slice(0, 120)}` };
  }
  if (missing.length > 0) return { ok: false, missing, detail: `不足: ${missing.join(", ")}` };

  // 一覧に載っていても実際に使えるとは限らない。1本作って読み返す。
  const probeDir = await mkdtemp(join(tmpdir(), "harness-doctor-ffmpeg-"));
  const target = join(probeDir, "probe.mp4");
  try {
    await runCommand(ffmpeg.command, [...(ffmpeg.args ?? []),
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=64x64:d=1:r=10",
      "-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=48000",
      "-t", "1", "-vf", "scale=64:64,fps=10", "-af", "aresample=48000",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", target,
    ], { timeout: 60_000 });
    const { stdout: probeOutput } = await runCommand(
      ffprobe.command,
      [...(ffprobe.args ?? []), "-v", "error", "-show_streams", "-of", "json", target],
      { timeout: 20_000 },
    );
    const streams = JSON.parse(probeOutput || "{}").streams;
    if (!Array.isArray(streams) || !streams.some((stream) => stream.codec_type === "video") || !streams.some((stream) => stream.codec_type === "audio")) {
      throw new Error("ffprobe が音声・映像streamの両方を返さなかった");
    }
    // 実デコードまで通す。書けても読めない出力を「作れた」ことにしない。
    await runCommand(ffmpeg.command, [...(ffmpeg.args ?? []), "-v", "error", "-xerror", "-i", target, "-f", "null", "-"], { timeout: 30_000 });
    return { ok: true, missing: [], detail: "極小MP4の生成・probe・全デコードが通った" };
  } catch (error) {
    return { ok: false, missing, detail: `極小MP4を作って読み返せない: ${String(error?.stderr || error?.message || error).slice(0, 160)}` };
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
}

function configuredImageModel(harnessId = "") {
  if (harnessId && harnessId !== "koya-manga-video") {
    try {
      const declaration = JSON.parse(readFileSync(path.join(REPO_ROOT, "config", "harnesses", `${harnessId}.harness.json`), "utf8"));
      return String(declaration?.runtime?.imageModel || declaration?.defaults?.imageModel || declaration?.imageModel || "").trim();
    } catch {
      return "";
    }
  }
  try {
    const contract = JSON.parse(readFileSync(path.join(REPO_ROOT, "config", "koya-manga-production-contract.json"), "utf8"));
    return String(contract?.art?.imageModel || "").trim();
  } catch {
    return "";
  }
}

async function probeConfiguredImageHost(model, runtime = {}) {
  if (typeof runtime.imageHostProbe === "function") return runtime.imageHostProbe(model);
  const host = imageHostForModel(model);
  if (!model || host === "unknown") {
    return { ok: false, host, model: model || null, detail: "本番で使う画像モデルが宣言されていない" };
  }
  if (host === "codex") {
    let command = "";
    try {
      command = await (runtime.resolveCodexCommand ?? resolveCodexCommand)();
    } catch (error) {
      return { ok: false, host, model, detail: String(error?.message || error).slice(0, 180) };
    }
    return probeCodexImageHost({
      model,
      command,
      env: runtime.env ?? process.env,
      runCommand: runtime.runCommand ?? defaultRunCommand,
    });
  }
  if (host === "lovart") {
    const credentials = await probeSecretVia(runtime.resolveLovartCredentials ?? resolveLovartCredentials, {
      label: "Lovart画像生成",
      fix: "LOVART_ACCESS_KEY と LOVART_SECRET_KEY を環境変数に置くか、~/.lovart/credentials.json を作る",
    });
    return { ...credentials, host, model, detail: credentials.ok ? `画像ホスト認証情報あり（Lovart / ${model}）` : credentials.detail };
  }
  if (host === "grok") {
    try {
      const getStatus = runtime.getGrokStatus ?? (await import("../lib/mediaGeneration.mjs")).getHermesStatus;
      const status = await getStatus();
      const ok = status?.installed === true && status?.session === "logged-in";
      return { ok, host, model, detail: ok ? `画像ホスト認証済み（Grok / ${model}）` : `Grok画像ホストを認証できない（${status?.session || "unknown"}）` };
    } catch (error) {
      return { ok: false, host, model, detail: `Grok画像ホストを検査できない: ${String(error?.message || error).slice(0, 140)}` };
    }
  }
  try {
    const getStatus = runtime.getBuzzAssistAuthStatus ?? (await import("../lib/buzzassistApi.mjs")).getBuzzAssistAuthStatus;
    const status = await getStatus({ verifyServer: true });
    const ok = status?.loggedIn === true && status?.verified !== false;
    return { ok, host, model, detail: ok ? `画像ホスト認証済み（BuzzAssist / ${model}）` : `BuzzAssist画像ホストを認証できない（${status?.error || "未ログイン"}）` };
  } catch (error) {
    return { ok: false, host, model, detail: `BuzzAssist画像ホストを検査できない: ${String(error?.message || error).slice(0, 140)}` };
  }
}

async function probeNarratedPaidMediaRuntime({ job, runtime = {}, env = process.env } = {}) {
  const evidence = runtime.channelPackEvidence ?? job?.channelPackVerification ?? null;
  const persisted = runtime.channelPackRuntime ?? job?.channelPackRuntime ?? null;
  let specs;
  try {
    specs = channelPackRuntimeAdapterSpecs(persisted, {
      harnessId: "narrated-story-video",
      payloadSha256: evidence?.payloadSha256,
    });
  } catch (error) {
    const detail = `署名Channel Packのruntime metadataを信頼できない: ${String(error?.message || error).slice(0, 180)}`;
    return {
      tts: { ok: false, status: "metadata-invalid", provider: null, model: null, detail },
      image: { ok: false, status: "metadata-invalid", host: "buzzassist-media-job", provider: null, model: null, detail },
      music: { ok: false, status: "metadata-invalid", provider: null, model: null, detail },
    };
  }

  const injectedProbe = typeof runtime.mediaAdapterProbe === "function" ? runtime.mediaAdapterProbe : null;
  const apiBase = String(runtime.mediaJobApiBase ?? env.BUZZASSIST_MEDIA_JOB_API_BASE ?? "").trim();
  if (!injectedProbe && !apiBase) {
    const detail = "BUZZASSIST_MEDIA_JOB_API_BASEが無く、署名Channel Packのadapterを非課金probeできない";
    return {
      tts: { ok: false, status: "route-missing", ...specs.tts, detail },
      image: { ok: false, status: "route-missing", host: "buzzassist-media-job", ...specs.image, detail },
      music: { ok: false, status: "route-missing", ...specs.music, detail },
    };
  }
  const probe = injectedProbe ?? ((spec) => probePaidMediaJobAdapter(spec, {
    apiBase,
    ...(runtime.mediaJobStateDir ? { stateDir: runtime.mediaJobStateDir } : {}),
    ...(runtime.mediaJobFetch ? { apiFetch: runtime.mediaJobFetch } : {}),
  }));
  const safeProbe = async (spec) => {
    try {
      const result = await probe(spec);
      return {
        ok: result?.ok === true,
        status: String(result?.status || (result?.ok === true ? "ready" : "unavailable")),
        kind: spec.kind,
        provider: spec.provider,
        model: spec.model,
        adapterVersion: spec.adapterVersion,
        ...(result?.serverVersion ? { serverVersion: String(result.serverVersion).slice(0, 120) } : {}),
        detail: result?.ok === true
          ? `BuzzAssist Media Job adapter ready（${spec.provider} / ${spec.model} / ${spec.adapterVersion}、非課金GET probe）`
          : String(result?.detail || "BuzzAssist Media Job adapterがreadyを返さない").slice(0, 200),
      };
    } catch (error) {
      return {
        ok: false,
        status: "probe-error",
        ...spec,
        detail: `BuzzAssist Media Job adapter probeに失敗: ${String(error?.message || error).slice(0, 180)}`,
      };
    }
  };
  const [image, tts, music] = await Promise.all([
    safeProbe(specs.image),
    safeProbe(specs.tts),
    safeProbe(specs.music),
  ]);
  return {
    tts,
    image: { ...image, host: "buzzassist-media-job" },
    music,
  };
}

/**
 * 測るアダプタは契約が決める（KOYA_DIALOGUE_ADAPTERS の1件）。以前は ElevenLabs を
 * ここに固定していたので、契約をオトシゴに切り替えても doctor は ElevenLabs を測り、
 * 本番は測っていないオトシゴに課金する、という食い違いが起き得た。本番側も
 * 「doctor が測ったアダプタ＝契約のアダプタ」を有料の音声の前に照合する。
 */
async function koyaDialogueAdapterSpec(projectDir, runtime = {}) {
  if (runtime.koyaDialogueAdapter) return runtime.koyaDialogueAdapter;
  const resolved = await resolveKoyaMangaProductionContract({ projectDir });
  return resolveKoyaDialogueAdapter(resolved);
}

/**
 * Koya speech no longer calls ElevenLabs with a local raw key. Probe the exact
 * non-billable BuzzAssist Media Job adapter used by requestKoyaDialogueMediaJob.
 * A raw ELEVENLABS_API_KEY must never make this check pass.
 */
async function probeKoyaDialoguePaidMediaRuntime({ runtime = {}, env = process.env, projectDir = REPO_ROOT } = {}) {
  let spec;
  try {
    spec = { ...(await koyaDialogueAdapterSpec(projectDir, runtime)) };
  } catch (error) {
    return {
      ok: false,
      status: "contract-invalid",
      kind: "voice.dialogue",
      detail: `Koya 契約から台詞音声のアダプタを決められない: ${String(error?.message || error).slice(0, 180)}`,
    };
  }
  const injectedProbe = typeof runtime.mediaAdapterProbe === "function" ? runtime.mediaAdapterProbe : null;
  const apiBase = String(runtime.mediaJobApiBase ?? env.BUZZASSIST_MEDIA_JOB_API_BASE ?? "").trim();
  if (!injectedProbe && !apiBase) {
    return {
      ok: false,
      status: "route-missing",
      ...spec,
      detail: "BUZZASSIST_MEDIA_JOB_API_BASEが無く、Koya本番のvoice.dialogue adapterを非課金probeできない",
    };
  }
  const probe = injectedProbe ?? ((input) => probePaidMediaJobAdapter(input, {
    apiBase,
    ...(runtime.mediaJobStateDir ? { stateDir: runtime.mediaJobStateDir } : {}),
    ...(runtime.mediaJobFetch ? { apiFetch: runtime.mediaJobFetch } : {}),
  }));
  try {
    const result = await probe(spec);
    const identityMatches = ["kind", "provider", "model", "adapterVersion"]
      .every((key) => result?.[key] === spec[key]);
    const ready = result?.ok === true && result?.status === "ready" && identityMatches;
    return {
      ok: ready,
      status: ready ? "ready" : (identityMatches ? String(result?.status || "unavailable") : "identity-mismatch"),
      ...spec,
      ...(result?.serverVersion ? { serverVersion: String(result.serverVersion).slice(0, 120) } : {}),
      detail: ready
        ? `BuzzAssist Media Job adapter ready（${spec.kind} / ${spec.provider} / ${spec.model} / ${spec.adapterVersion}、非課金GET probe）`
        : identityMatches
          ? String(result?.detail || "Koya voice.dialogue adapterがreadyを返さない").slice(0, 200)
          : "Koya paid-media capability responseが要求したvoice.dialogue adapter identityと一致しない",
    };
  } catch (error) {
    return {
      ok: false,
      status: "probe-error",
      ...spec,
      detail: `Koya voice.dialogue adapter probeに失敗: ${String(error?.message || error).slice(0, 180)}`,
    };
  }
}

function validateSignedChannelPackEvidence(evidence, harnessId) {
  const value = evidence && typeof evidence === "object" ? evidence : null;
  const failures = [];
  if (!value) failures.push("署名検証evidenceが無い");
  else {
    if (value.envelopeVersion !== CHANNEL_PACK_ENVELOPE_VERSION) failures.push("envelope versionが違う");
    if (value.harnessId !== harnessId) failures.push(`対象Harnessが違う（${value.harnessId || "無し"}）`);
    if (!/^[a-f0-9]{64}$/u.test(String(value.payloadSha256 || ""))) failures.push("payload SHA-256が無いか不正");
    if (!Number.isSafeInteger(value.fileCount) || value.fileCount < 1) failures.push("payload file countが不正");
    if (!String(value.signerKeyId || "").trim()) failures.push("signer key IDが無い");
    if (!String(value.trustedPublicKeyId || "").trim()) failures.push("信頼済み公開鍵IDが無い");
  }
  return {
    ok: failures.length === 0,
    detail: failures.length === 0
      ? `署名検証evidence確認（${harnessId} / ${value.fileCount}ファイル）`
      : `署名検証evidenceを信頼できない: ${failures.join(", ")}`,
  };
}

// 同じ端末に Channel Pack が複数あり、どれを使うか指定が無いと channelPackPresent は
// 例外を投げる（黙って1つを選ばないため）。doctor ごと落ちると他の項目まで見えなく
// なるので、ここで受けて channel-pack の項目として報告する。
const CHANNEL_PACK_AMBIGUOUS_FIX = "BUZZASSIST_CHANNEL_PACK_ID に使う Channel Pack の名前（channel-packs/ の下のフォルダ名）を入れて実行する。複数のチャンネルを同じ端末で回すときは、端末全体の既定にせず実行ごとに指定する";

function channelPackPresence(projectDir) {
  try {
    return { present: channelPackPresent(projectDir), error: "" };
  } catch (error) {
    return { present: false, error: String(error?.message || error).slice(0, 200) };
  }
}

async function probeChannelPack({ projectDir, harnessId, job, runtime }) {
  if (!harnessId) {
    // Setup時はHarness未選択でも、実際に復元済みのKoya正本があるなら
    // 「存在する」だけでなく読んで検証する。何も無い新規projectへKoyaを
    // 強制はせず、このcheck自体は任意のままにする。
    const presence = channelPackPresence(projectDir);
    if (presence.error) {
      return { id: "channel-pack", required: false, ok: false, detail: presence.error, fix: CHANNEL_PACK_AMBIGUOUS_FIX };
    }
    if (presence.present) {
      let packDetail = "未設置";
      let packOk = false;
      try {
        const authority = await (runtime.readKoyaChannelAuthority ?? readKoyaChannelAuthority)({ projectDir });
        packOk = authority.source === "project";
        packDetail = packOk
          ? `設置済み・正本を検証（cast ${authority.validation.show.castCount}名 / styling ${authority.validation.styling.specCount}件）`
          : `データは読めたが正本の出所が ${authority.source}`;
      } catch (error) {
        packDetail = `設置されているが正本を読めない: ${String(error?.message || error).slice(0, 140)}`;
      }
      return {
        id: "channel-pack",
        required: false,
        ok: packOk,
        detail: packDetail,
        fix: packOk ? "" : "復元済みChannel Packのshow/location/thumbnail/styling正本を読める状態にする",
      };
    }
    return {
      id: "channel-pack",
      required: false,
      ok: true,
      detail: "Harness未選択のため対象外（本番JobでHarness別に検証）",
      fix: "",
    };
  }

  if (harnessId === "koya-manga-video") {
    let packDetail = "未設置";
    let packOk = false;
    let authorityFingerprint = null;
    const presence = channelPackPresence(projectDir);
    if (presence.error) packDetail = presence.error;
    if (presence.present) {
      try {
        const authority = await (runtime.readKoyaChannelAuthority ?? readKoyaChannelAuthority)({ projectDir });
        packOk = authority.source === "project";
        if (packOk) {
          authorityFingerprint = await (runtime.fingerprintKoyaChannelAuthority ?? fingerprintKoyaChannelAuthority)(authority);
        }
        packDetail = packOk
          ? `設置済み・正本を検証（cast ${authority.validation.show.castCount}名 / styling ${authority.validation.styling.specCount}件）`
          : `データは読めたが正本の出所が ${authority.source}`;
      } catch (error) {
        packDetail = `設置されているが正本を読めない: ${String(error?.message || error).slice(0, 140)}`;
      }
    }
    return {
      id: "channel-pack",
      required: true,
      ok: packOk,
      detail: packDetail,
      ...(authorityFingerprint ? { authorityFingerprint } : {}),
      fix: packOk ? "" : presence.error ? CHANNEL_PACK_AMBIGUOUS_FIX : "Koya本番には、署名済みChannel PackからJob固有workspaceへ復元した番組正本が要る。run_video_harnessのprepareを通し、show/location/thumbnail/stylingの全検証が通る状態にする",
    };
  }

  const evidence = runtime.channelPackEvidence ?? job?.channelPackVerification ?? null;
  const verified = validateSignedChannelPackEvidence(evidence, harnessId);
  return {
    id: "channel-pack",
    required: true,
    ...verified,
    fix: verified.ok ? "" : "run_video_harnessに対象Harness用の署名済みChannel Pack envelopeを渡し、prepareが保存した署名・payload hash・信頼済み公開鍵のevidence付きでdoctorを実行する",
  };
}

/**
 * Canonical CLI/MCP preflight.
 *
 * `runtime` is dependency injection for deterministic tests; production
 * callers should omit it. Both CLI and MCP return this same report/schema.
 */
export async function runHarnessDoctor({ projectDir = REPO_ROOT, harnessId = "", job = null, runtime = {} } = {}) {
  const checks = [];
  const add = (entry) => { checks.push(entry); return entry; };
  const runCommand = runtime.runCommand ?? defaultRunCommand;
  const runtimeEnv = runtime.env ?? process.env;

  // ハーネスを名指しされたら、そのハーネスが実際に配れる状態かを見る。
  // 入口がプレースホルダのまま、正規ルーティングにも載っていないハーネスは、
  // 前提が全部揃っても運営者は「台本をどこへ渡すのか」で止まる。
  // それは前提不足ではなく配布路の欠落なので、ready と言ってはいけない。
  let declaration = null;
  if (harnessId) {
    const declarationPath = path.join(REPO_ROOT, "config", "harnesses", `${harnessId}.harness.json`);
    try { declaration = JSON.parse(readFileSync(declarationPath, "utf8")); } catch { /* 下で落とす */ }
    const route = await probeProductionRoute(declaration, harnessId, {
      runCommand,
      job,
      runtime: { ...runtime, projectDir },
    });
    add({ id: "harness-production-route", required: true, ...route });
  }

  // --- 実行環境（必須） ---
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add({
    id: "node",
    required: true,
    ok: nodeMajor >= 20,
    detail: `Node ${process.versions.node}`,
    fix: nodeMajor >= 20 ? "" : "Node 20 以上が要る。nvm を使っているなら `nvm use 22` で切り替える（既定が18のままだと Vite も動かない）",
  });

  const mediaToolchain = runtime.ffmpegToolchain ?? await resolveFfmpegToolchain({
    env: runtimeEnv,
    runCommand,
  });
  for (const [id, probe] of [["ffmpeg", mediaToolchain.ffmpeg], ["ffprobe", mediaToolchain.ffprobe]]) {
    add({
      id,
      required: true,
      ok: probe.ok,
      detail: probe.ok ? `${id} ${probe.version}（${formatRuntimeCommand(probe)}）` : probe.detail,
      fix: probe.ok ? "" : `${id} が要る。setup（node scripts/setup-agents.mjs）を --no-install-prerequisites なしで実行すると、固定版を管理者権限なしで ~/.buzzassist/tools に入れる。自分で入れるなら macOS は \`brew install ffmpeg\`、Windows は \`winget install Gyan.FFmpeg\`。動画のレンダーと実測監査の全部がこれに乗っているので、無いと本編は1本も作れない。独自パスは ${id === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"} で指定できる`,
    });
  }

  // 版を答えられるだけでは足りない。本体が使う encoder と filter を欠いた
  // ビルドは珍しくなく（libx264 抜きの最小ビルドなど）、その場合 doctor は
  // ready と言った直後にレンダーが落ちる。**実際に1本作って読み返す**。
  const capability = mediaToolchain.ok
    ? await probeFfmpegCapability({ ffmpeg: mediaToolchain.ffmpeg, ffprobe: mediaToolchain.ffprobe, runCommand })
    : { ok: false, missing: [
        ...(!mediaToolchain.ffmpeg?.ok ? ["ffmpeg"] : []),
        ...(!mediaToolchain.ffprobe?.ok ? ["ffprobe"] : []),
      ], detail: "ffmpeg / ffprobe のどちらかを起動できないため実MP4検査を実行できない" };
  add({
    id: "ffmpeg-capability",
    required: true,
    ok: capability.ok,
    detail: capability.detail,
    fix: capability.ok ? "" : `この ffmpeg ビルドには本編のレンダーに要るものが足りない: ${capability.missing.join(", ") || capability.detail}。libx264 と aac を含むビルドを入れること（macOS の \`brew install ffmpeg\` は既定で含む）`,
  });

  // --- 吹き出しの描画器（漫画ハーネスでは必須） ---
  // 縦組みの吹き出しは SVG をブラウザーで PNG にして載せる。探索先が macOS だけだった頃、
  // Windows / Linux ではブラウザーが見つからず、有料の画像と音声を作り終えたあとの
  // 合成で止まっていた。**本番と同じ rasterizeSvg で縦書きの小さな SVG を描き、
  // 読み返して**、字が縦に並び、豆腐（フォント無しの四角）でないことまで確かめる。
  // 漫画ハーネスを名指ししたときは必須（有料生成の前に止める）、それ以外は任意。
  const svgRasterizer = typeof runtime.svgRasterizerProbe === "function"
    ? await runtime.svgRasterizerProbe()
    : await probeSvgRasterizerCached({ env: runtimeEnv, platform: runtime.platform ?? process.platform });
  add({
    id: "svg-rasterizer",
    required: harnessId === "koya-manga-video" || declaration?.produces?.kind === "manga-video",
    ok: svgRasterizer?.ok === true,
    ...(svgRasterizer?.code ? { code: svgRasterizer.code } : {}),
    ...(svgRasterizer?.backend ? { backend: svgRasterizer.backend } : {}),
    detail: String(svgRasterizer?.detail || "吹き出しの描画器を確かめられなかった"),
    fix: svgRasterizer?.ok === true ? "" : String(svgRasterizer?.fix || "Chrome / Edge / Chromium を入れるか BUZZASSIST_CHROME_PATH で指定する"),
  });

  // ハーネスを名指しした本番 preflight では必須、Harness 未選択の setup では任意。
  // reviewer 信頼アンカー（R6-1）と同じ扱い: 空きが要るのは「回すとき」であって
  // 「設定するとき」ではない。setup を空き容量で止めると、空きを作るために要る
  // 配り直しそのものができなくなる。
  add({
    id: "disk-space",
    required: Boolean(harnessId),
    ...await probeDiskSpace(path.resolve(projectDir), runtime),
  });

  // --- 音声品質ゲート ---
  // 本体と同じ解決器に聞く。doctor だけ PATH の python3 に固定すると、
  // Windows の `py -3`、project venv、VOICE_QA_PYTHON と違う interpreter を
  // 調べることになり、揃っていないのに ready と言う。
  // 必須にするのは、正規入口が音声品質ゲートを既定で有効にしていて、
  // QA環境が無いと有償生成の手前で止まるため——ready と言った直後に
  // 止まるなら、それは ready ではない。
  const pythonRuntime = runtime.pythonRuntime ?? await resolvePythonRuntime({
    env: runtimeEnv,
    platform: runtime.platform ?? process.platform,
    projectDir,
    purposeEnv: "VOICE_QA_PYTHON",
    requiredModules: VOICE_QA_REQUIRED_MODULES,
    runCommand,
  });
  const voiceQa = pythonRuntime.ok
    ? await (runtime.voiceQualityProbe
        ? runtime.voiceQualityProbe(pythonRuntime)
        : voiceQualityAvailable(pythonRuntime)).then((value) => value === true, () => false)
    : false;
  const pythonLabel = formatRuntimeCommand(pythonRuntime);
  add({
    id: "voice-quality-python",
    required: true,
    ok: voiceQa,
    detail: voiceQa
      ? `利用可能（${pythonLabel} / Python ${pythonRuntime.version || "version確認済み"}）`
      : `利用不可（${pythonLabel}${pythonRuntime.detail ? ` / ${pythonRuntime.detail}` : ""}）`,
    fix: voiceQa ? "" : `音声品質ゲートが動かない。正規入口はこのゲートを既定で有効にしているので、有償生成の手前で止まる。利用するPythonに ${VOICE_QA_REQUIRED_MODULES.join(" / ")} を入れ、UTMOSキャッシュ（~/.cache/torch/hub）と、faster-whisper の kotoba-tech/kotoba-whisper-v2.0-faster と small（Hugging Face キャッシュ。監査中はダウンロードしない）を用意する。別のinterpreterは VOICE_QA_PYTHON で指定できる（Windowsは py -3 / python.exe も自動探索）`,
  });

  // --- 有償API（必須。無いと生成が1つも通らない） ---
  const narratedMedia = harnessId === "narrated-story-video"
    ? await probeNarratedPaidMediaRuntime({ job, runtime, env: runtimeEnv })
    : null;
  const tts = narratedMedia?.tts
    ?? (harnessId === "koya-manga-video"
      ? await probeKoyaDialoguePaidMediaRuntime({ runtime, env: runtimeEnv, projectDir: path.resolve(projectDir) })
      : (runtime.ttsProbe
        ? await runtime.ttsProbe()
        : await probeSecretVia(() => requireElevenLabsApiKey({}), {
            label: "音声合成",
            fix: "ELEVENLABS_API_KEY を環境変数に置くか、音声ジェネレーターの設定から保存する。キーはファイルにもログにも書かない",
          })));
  add({
    id: "tts-key",
    required: true,
    ...tts,
    fix: tts.ok ? "" : harnessId === "narrated-story-video"
      ? "署名Channel Packのruntime.ttsProvider / voice adapter identityを一致させ、BUZZASSIST_MEDIA_JOB_API_BASEの非課金capabilities probeがreadyを返す状態にする"
      : harnessId === "koya-manga-video"
        ? `BUZZASSIST_MEDIA_JOB_API_BASEを設定し、契約が指す ${[tts.kind, tts.provider, tts.model, tts.adapterVersion].filter(Boolean).join(" / ")} の非課金capabilities probeがreadyを返す状態にする。生の提供元APIキーだけではKoya本番経路の確認にならない`
        : tts.fix,
  });

  const imageModel = runtime.imageModel ?? configuredImageModel(harnessId);
  const image = narratedMedia?.image ?? await probeConfiguredImageHost(imageModel, runtime);
  add({
    id: "image-key",
    required: true,
    ...image,
    fix: image.ok ? "" : harnessId === "narrated-story-video"
      ? "署名Channel Packのruntime.imageModel / image adapter identityを一致させ、BUZZASSIST_MEDIA_JOB_API_BASEの非課金capabilities probeがreadyを返す状態にする"
      : image.host === "codex"
      ? "本番モデルは Codex の GPT Image 2 経路。ChatGPTデスクトップアプリまたはCodex CLIを入れ、`codex login status` がログイン済みを返す状態にする"
      : image.host === "lovart"
        ? "LOVART_ACCESS_KEY と LOVART_SECRET_KEY を設定し、本番契約の画像モデルへアクセスできる状態にする"
        : image.host === "grok"
          ? "Grok CLIを入れて `grok login --device-auth` を完了する"
          : "BuzzAssistへログインし、本番契約の画像モデルへアクセスできる状態にする",
  });

  if (harnessId === "narrated-story-video") {
    const music = narratedMedia?.music ?? {
      ok: false,
      status: "metadata-invalid",
      detail: "署名Channel Packのmusic adapter identityを取得できない",
    };
    add({
      id: "music-key",
      required: true,
      ...music,
      fix: music.ok ? "" : "署名Channel Packのmusic adapter identityを一致させ、BUZZASSIST_MEDIA_JOB_API_BASEの非課金capabilities probeがreadyを返す状態にする",
    });
  }

  // --- reviewer 信頼アンカー（R6-1） ---
  // 有料生成を終えた Job が Receipt 確定で reviewer-trust-unconfigured に落ちるのは「ready と言った
  // 直後に止まる」の一形。ハーネスを名指しした本番 preflight では必須、Harness 未選択の setup では任意
  // （canvas だけ使う人を止めない）。判定は本体と同じ preflightReviewerTrust に聞く。秘密も path も出さない。
  const reviewerTrust = runtime.reviewerTrustProbe
    ? await runtime.reviewerTrustProbe()
    : await preflightReviewerTrust({ env: runtimeEnv });
  add({
    id: "reviewer-trust",
    required: Boolean(harnessId),
    ok: reviewerTrust.ok === true,
    ...(reviewerTrust.code ? { code: reviewerTrust.code } : {}),
    activeReviewers: Number(reviewerTrust.activeReviewers) || 0,
    detail: reviewerTrust.ok === true
      ? `運営者の信頼リスト設定あり（env ${reviewerTrust.source === "json" ? "inline JSON" : "path"} / active な reviewer 鍵 ${reviewerTrust.activeReviewers} 件 / sha256 ${String(reviewerTrust.sha256 || "").slice(0, 16)}…）`
      : `reviewer 信頼アンカーが有料実行前 preflight を通らない: ${String(reviewerTrust.code || "reviewer-trust-unconfigured")}`,
    fix: reviewerTrust.ok === true
      ? ""
      : `運営者（owner）が、監査・Receipt を実行するこの端末の環境変数 ${REVIEWER_TRUST_ENV_GUIDANCE} に、status=active の reviewer 公開鍵を 1 件以上含む信頼リスト（koya-reviewer-trust-v1）を配る。新旧 env 名の両方を別内容で設定しない（env-ambiguous）。要求側の --reviewer-trust-path / Job options / MCP 引数では代替できない。これが無いと有料生成を終えてから Receipt 確定で止まる（${REVIEWER_TRUST_PATH_ENV} 未設定の host では start/resume 自体が reviewer-trust-unconfigured で拒否される）`,
  });

  // --- Channel Pack ---
  // Koyaの番組正本を全Harnessへ強制しない。Koyaは復元先の
  // authority自体を検証し、他Harnessは共通prepareが残した署名検証
  // evidenceを見る。Harness未選択のセットアップでは対象外と明記する。
  add(await probeChannelPack({ projectDir, harnessId, job, runtime }));

  add({ id: "image-default-route", required: false, ...(await probeDefaultImageRoute({ env: runtimeEnv, runtime })) });

  // yt-quality-loop（別配布のプラグイン）の Stop フックは、同じ会話・同じ作業フォルダーで
  // そのループが動いているときだけ終了を止めてループの続きを指示する。制作 Job の会話で
  // それが起きないかを知らせる（任意。yt-quality-loop 側は変更しない）。
  add({
    id: "yt-quality-loop-hooks",
    required: false,
    ...probeYtQualityLoopHooks({
      projectDirs: [path.resolve(projectDir), process.cwd()],
      homeDir: runtime.homeDir || runtimeEnv.BUZZASSIST_SETUP_HOME || homedir(),
      env: runtimeEnv,
    }),
  });

  const drift = probeShippedSkillDrift();
  add({ id: "shipped-skill-drift", required: false, ...drift });

  // 配布元が新しくても、ホストが読む cache が古ければ意味がない（2026-09-24、両ホストが
  // 1版古いまま動いていた）。ハーネス指定ありで、そのハーネスが束縛するスキルがずれて
  // いるときだけ止める。
  const hostSync = probeHostSkillSync({
    repoRoot: REPO_ROOT,
    homeDir: runtime.homeDir || runtimeEnv.BUZZASSIST_SETUP_HOME || homedir(),
    declaration,
  });
  add({
    id: "host-skill-sync",
    required: hostSync.required,
    ok: hostSync.ok,
    detail: hostSync.detail,
    fix: hostSync.fix,
    hosts: hostSync.installs.map((install) => ({ host: install.host, version: install.version })),
    ...(hostSync.blockingSkills?.length ? { blockingSkills: hostSync.blockingSkills } : {}),
    developmentCheckout: hostSync.developmentCheckout === true,
  });

  // Codex は /hooks で信頼されたフックだけを動かす。信頼が無いと学習フックは黙って飛ばされる。
  add({
    id: "learning-hook-trust",
    required: false,
    ...probeCodexLearningHookTrust({ env: runtimeEnv, homeDir: runtime.homeDir || runtimeEnv.BUZZASSIST_SETUP_HOME || homedir() }),
  });

  const blocking = checks.filter((c) => c.required && !c.ok);
  const advisory = checks.filter((c) => !c.required && !c.ok);
  return {
    version: "harness-doctor-v1",
    projectDir: path.resolve(projectDir),
    harnessId: harnessId || null,
    ready: blocking.length === 0,
    checks,
    blocking: blocking.map((c) => c.id),
    advisory: advisory.map((c) => c.id),
  };
}

function render(report) {
  const lines = [];
  lines.push(report.ready ? "ハーネスの前提: 揃っている" : "ハーネスの前提: 足りないものがある");
  lines.push("");
  for (const check of report.checks) {
    const mark = check.ok ? "OK  " : check.required ? "必須 " : "任意 ";
    lines.push(`  [${mark}] ${check.id}: ${check.detail}`);
    if (!check.ok && check.fix) lines.push(`         → ${check.fix}`);
  }
  lines.push("");
  if (report.blocking.length > 0) {
    lines.push(`このままでは本番を回せない: ${report.blocking.join(", ")}`);
  } else if (report.advisory.length > 0) {
    // 任意項目の影響は項目ごとに違う。「ゲートが skip になる」と一括で
    // 書くと、実際には起きないことを述べることになる。
    lines.push("本番は回せるが、次が未充足:");
    for (const id of report.advisory) {
      const check = report.checks.find((entry) => entry.id === id);
      lines.push(`  - ${id}: ${check?.detail || ""}`);
    }
  }
  return lines.join("\n");
}

/** ハーネス宣言を読み、未知のIDを黙って受け流さない。 */
function knownHarnessIds(repoRoot = REPO_ROOT) {
  const dir = path.join(repoRoot, "config", "harnesses");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".harness.json"))
    .map((name) => name.replace(/\.harness\.json$/u, ""))
    .sort();
}

function parseArgs(argv) {
  const known = new Set(["--help", "-h", "--json", "--project-dir", "--harness"]);
  const args = { help: false, json: false, projectDir: REPO_ROOT, harnessId: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--") && token !== "-h") throw new Error(`余分な引数: ${token}`);
    if (!known.has(token)) {
      // 未知の引数を黙って無視すると、運営者は希望した診断が通ったと
      // 誤認する。実際 --harness は使用例にあるのに解析されておらず、
      // 別ジャンルを指定しても漫画動画と同じ検査をしていた。
      throw new Error(`未知の引数: ${token}\n使えるのは ${[...known].join(" / ")}`);
    }
    if (token === "--help" || token === "-h") { args.help = true; continue; }
    if (token === "--json") { args.json = true; continue; }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} に値が要る`);
    i += 1;
    if (token === "--project-dir") args.projectDir = path.resolve(value);
    if (token === "--harness") args.harnessId = value;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "Usage: node scripts/harness-doctor.mjs [--json] [--project-dir DIR] [--harness ID]\n"
      + "\n有料生成の前提、実runtime、provider、署名Channel Pack、Canvasをfail-closedで検査します。\n",
    );
    return;
  }
  const ids = knownHarnessIds();
  if (args.harnessId && !ids.includes(args.harnessId)) {
    throw new Error(`未知のハーネス: ${args.harnessId}\n宣言があるのは: ${ids.join(", ")}`);
  }
  const report = await runHarnessDoctor({ projectDir: args.projectDir, harnessId: args.harnessId });
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : `${render(report)}\n`);
  // 必須が欠けているときだけ非0。任意の欠落で止めると、canvas だけ使いたい人が
  // セットアップできなくなる。
  if (!report.ready) process.exitCode = 2;
}

const isDirectExecution = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  // setup が ~/.buzzassist/tools に入れた ffmpeg / ffprobe も、運営者の PATH の後ろで見る。
  appendManagedToolsToPath(process.env);
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
