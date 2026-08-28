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
import { promisify } from "node:util";
import path from "node:path";

import { channelPackPresent } from "../lib/channelPackResolver.mjs";
import { requireElevenLabsApiKey } from "../lib/speechGeneration.mjs";
import { resolveLovartCredentials } from "../lib/lovartMediaGeneration.mjs";
import { DEFAULT_VOICE_QA_PYTHON, voiceQualityAvailable } from "../lib/voiceQualityGate.mjs";
import { readKoyaChannelAuthority } from "../lib/koyaChannelGovernance.mjs";

const run = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/**
 * 起動して名乗らせる。名前が PATH にあるだけでは通さない。
 *
 * 終了コード0だけで通す形にすると、終了0で何も出さない偽の実行ファイルや、
 * 名前が同じ別のツールのラッパーが「揃っている」ことになる。
 * そのコマンド固有の署名に一致しなければ落とす。
 */
async function probeCommand(command, args, { signature, versionPattern = /(\d+\.\d+(?:\.\d+)?)/u } = {}) {
  try {
    const { stdout, stderr } = await run(command, args, { timeout: 15_000 });
    const text = `${stdout}${stderr}`;
    if (signature && !signature.test(text)) {
      return {
        ok: false,
        missing: false,
        detail: `${command} を名乗る何かが応答したが、${command} の出力署名に一致しない: ${text.slice(0, 80).replace(/\s+/gu, " ")}`,
      };
    }
    const match = text.match(versionPattern);
    if (!match) {
      return { ok: false, missing: false, detail: `${command} が版を答えなかった: ${text.slice(0, 80).replace(/\s+/gu, " ")}` };
    }
    return { ok: true, version: match[1] };
  } catch (error) {
    const message = String(error?.message || error);
    const missing = /ENOENT|not found|command not found/iu.test(message);
    return { ok: false, missing, detail: message.slice(0, 200) };
  }
}

async function probePythonModules(modules) {
  const script = `import json,importlib.util as u;print(json.dumps({m:(u.find_spec(m) is not None) for m in ${JSON.stringify(modules)}}))`;
  try {
    const { stdout } = await run("python3", ["-c", script], { timeout: 20_000 });
    return { ok: true, modules: JSON.parse(stdout.trim()) };
  } catch (error) {
    return { ok: false, detail: String(error?.message || error).slice(0, 200) };
  }
}

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

export async function runHarnessDoctor({ projectDir = REPO_ROOT } = {}) {
  const checks = [];
  const add = (entry) => { checks.push(entry); return entry; };

  // --- 実行環境（必須） ---
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add({
    id: "node",
    required: true,
    ok: nodeMajor >= 20,
    detail: `Node ${process.versions.node}`,
    fix: nodeMajor >= 20 ? "" : "Node 20 以上が要る。nvm を使っているなら `nvm use 22` で切り替える（既定が18のままだと Vite も動かない）",
  });

  for (const [id, command] of [["ffmpeg", "ffmpeg"], ["ffprobe", "ffprobe"]]) {
    const probe = await probeCommand(command, ["-version"], {
      signature: new RegExp(`${command} version`, "iu"),
    });
    add({
      id,
      required: true,
      ok: probe.ok,
      detail: probe.ok ? `${command} ${probe.version}` : probe.detail,
      fix: probe.ok ? "" : `${command} が要る。macOS なら \`brew install ffmpeg\`、Windows なら \`winget install Gyan.FFmpeg\`。動画のレンダーと実測監査の全部がこれに乗っているので、無いと本編は1本も作れない`,
    });
  }

  // --- 音声品質ゲート ---
  // 本体の判定関数に聞く。doctor が PATH の python3 を見る形にすると、
  // 本体が使う VOICE_QA_PYTHON（既定 /usr/bin/python3）と別の interpreter を
  // 調べることになり、揃っていないのに ready と言う。実際そうなっていた。
  // 必須にするのは、正規入口が音声品質ゲートを既定で有効にしていて、
  // QA環境が無いと有償生成の手前で止まるため——ready と言った直後に
  // 止まるなら、それは ready ではない。
  const voiceQa = await voiceQualityAvailable().then((value) => value === true, () => false);
  add({
    id: "voice-quality-python",
    required: true,
    ok: voiceQa,
    detail: voiceQa ? `利用可能（${DEFAULT_VOICE_QA_PYTHON}）` : `利用不可（${DEFAULT_VOICE_QA_PYTHON}）`,
    fix: voiceQa ? "" : `音声品質ゲートが動かない。正規入口はこのゲートを既定で有効にしているので、有償生成の手前で止まる。${DEFAULT_VOICE_QA_PYTHON} に numpy / soundfile / pyworld / torch / faster_whisper / fugashi を入れるか、別の interpreter を VOICE_QA_PYTHON で指定する`,
  });

  // --- 有償API（必須。無いと生成が1つも通らない） ---
  const tts = await probeSecretVia(() => requireElevenLabsApiKey({}), {
    label: "音声合成",
    fix: "ELEVENLABS_API_KEY を環境変数に置くか、音声ジェネレーターの設定から保存する。キーはファイルにもログにも書かない",
  });
  add({ id: "tts-key", required: true, ...tts });

  const image = await probeSecretVia(() => resolveLovartCredentials(), {
    label: "画像生成",
    fix: "LOVART_ACCESS_KEY と LOVART_SECRET_KEY を環境変数に置くか、~/.lovart/credentials.json を作る",
  });
  add({ id: "image-key", required: true, ...image });

  // --- Channel Pack ---
  // ディレクトリの存在だけを見ると、空ディレクトリでも「設置済み」になる。
  // 正本が実際に読めて検証を通ることまで見る。
  let packDetail = "未設置";
  let packOk = false;
  if (channelPackPresent(projectDir)) {
    try {
      const authority = await readKoyaChannelAuthority({ projectDir });
      packOk = authority.source === "project";
      packDetail = packOk
        ? `設置済み・正本を検証（cast ${authority.validation.show.castCount}名 / styling ${authority.validation.styling.specCount}件）`
        : `ディレクトリはあるが正本の出所が ${authority.source}`;
    } catch (error) {
      packDetail = `設置されているが正本を読めない: ${String(error?.message || error).slice(0, 120)}`;
    }
  }
  add({
    id: "channel-pack",
    required: false,
    ok: packOk,
    detail: packDetail,
    fix: packOk ? "" : "自分のチャンネルの本番を回すには Channel Pack が要る（キャスト、番組規則、承認記録）。`node scripts/koya-manga-video.mjs handoff-restore --bundle-dir <配布された束>` で入れる。無くてもジャンル共通の工程は動くが、番組ルールは適用されない",
  });

  const blocking = checks.filter((c) => c.required && !c.ok);
  const advisory = checks.filter((c) => !c.required && !c.ok);
  return {
    version: "harness-doctor-v1",
    projectDir: path.resolve(projectDir),
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
    lines.push(`回せるが、次のゲートは skip になる: ${report.advisory.join(", ")}`);
  }
  return lines.join("\n");
}

async function main() {
  const asJson = process.argv.includes("--json");
  const dirIndex = process.argv.indexOf("--project-dir");
  const projectDir = dirIndex >= 0 ? process.argv[dirIndex + 1] : REPO_ROOT;
  const report = await runHarnessDoctor({ projectDir });
  process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : `${render(report)}\n`);
  // 必須が欠けているときだけ非0。任意の欠落で止めると、canvas だけ使いたい人が
  // セットアップできなくなる。
  if (!report.ready) process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
