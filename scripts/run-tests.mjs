#!/usr/bin/env node
//   node scripts/run-tests.mjs              前提の無い検査は skip、理由を必ず出す
//   node scripts/run-tests.mjs --strict     skip を1件も許さない（全前提を揃えた開発機）
//   node scripts/run-tests.mjs --skip-policy config/ci-test-skip-allowlist.json
//                                           clean releaseで既知の私有前提だけ許す
//
// なぜ skip を数えるか:
// 終了コードしか見ていなかったので、**壊れた検査が skip されて緑になる**状態が
// あった。動画品質監査の関数へ必ず例外を投げる変異を入れ、PATH から ffmpeg を
// 外して走らせると「2 pass / 1 skip / exit 0」になる——完全に壊れた関数が生存する。
// 公開 clone や新しい運営者のマシンほど、この状態になりやすい。
//
// skip 自体は要る。前提が手元に無い環境で落とし続けると、本当の失敗が常時赤に
// 埋もれる。だから禁じるのではなく、**必ず目に見えるところへ出す**。
// clean releaseは私有Channel Pack等を持たないため、名前・理由・OSを固定した
// --skip-policyを使う。FFmpeg/Pythonなど必須toolchainの欠落はallowlistできない。

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateTestSkips, parseTapSkips, validateTestSkipPolicy } from "../lib/testSkipPolicy.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = join(rootDir, "test");
const strict = process.argv.includes("--strict") || process.env.BUZZASSIST_TEST_STRICT === "1";
const skipPolicyFlag = process.argv.indexOf("--skip-policy");
if (strict && skipPolicyFlag >= 0) {
  throw new Error("--strict and --skip-policy are mutually exclusive.");
}
if (skipPolicyFlag >= 0 && (!process.argv[skipPolicyFlag + 1] || process.argv[skipPolicyFlag + 1].startsWith("--"))) {
  throw new Error("--skip-policy requires a JSON file path.");
}
const skipPolicyPath = skipPolicyFlag >= 0 ? resolve(rootDir, process.argv[skipPolicyFlag + 1]) : "";
const skipPolicy = skipPolicyPath ? JSON.parse(readFileSync(skipPolicyPath, "utf8")) : null;
if (skipPolicy) validateTestSkipPolicy(skipPolicy);

const testFiles = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => relative(rootDir, join(testDir, name)));

// ビルドを入り口に入れる。
//
// UI のテスト44件は App.jsx を**レンダーせず readFile + 正規表現**で
// 判定している。必要な文字列が死んだコードとして残っているだけでも通るので、
// import が壊れていても構文が壊れていても気づけない。
// ビルドはその一群を捕まえる——ただし**トップレベルの throw は捕まえない**
// （構文としては正しく、バンドルも通る）。そこは別途、実際にマウントする
// テストが要る（未着手・要判断）。
const commands = [
  { args: ["--test", ...testFiles], countsSkips: true },
  { args: ["scripts/test-fal-payloads.mjs"], countsSkips: false },
  { args: ["scripts/test-setup-distribution.mjs"], countsSkips: false },
];

// ビルドは node ではなく npm 経由なので別枠。
// Windows の npm は npm.cmd で、.cmd はシェルを通さないと起動できない。
// "npm" のままシェルなしで呼んでいたので、Windows の CI は 2026-08-29 から
// ビルドの手前（spawnSync npm ENOENT）で止まり、テストが1件も走っていなかった。
const isWindows = process.platform === "win32";
const buildCommand = { command: isWindows ? "npm.cmd" : "npm", args: ["run", "build"], label: "vite build" };

let skipped = [];
// process.exit() は書きかけの stdout を捨てる。CI のログはパイプで、捕まえた
// テスト出力（数 MB）を書いている途中で exit していたので、GitHub Actions の
// ログは macOS で 265件目、Linux で 246件目の途中で切れ、それより後の失敗と
// 集計が見えなかった。手元ではファイルへ出していた（同期書き込み）ので切れない。
// 終了コードだけ決め、残りの工程を飛ばし、書き終わるのを待って自然に終わる。
let stopped = false;
let skipsCounted = false;

{
  const build = spawnSync(buildCommand.command, buildCommand.args, {
    // 引数は固定の2語だけなので、シェルを通しても展開される文字は無い。
    cwd: rootDir, env: process.env, stdio: "inherit", shell: isWindows,
  });
  if (build.error) throw build.error;
  if (build.status !== 0) {
    process.stdout.write(`\n${buildCommand.label} が失敗しました。UI のテストは App.jsx を`
      + "レンダーしないので、ビルドが通らない状態でも大半が緑になります。\n");
    process.exitCode = build.status ?? 1;
    stopped = true;
  }
}

for (const { args, countsSkips } of commands) {
  if (stopped) break;
  // skip を数える回だけ出力を捕まえる。捕まえたぶんはそのまま流し直すので、
  // 見え方は変わらない。
  const result = spawnSync(process.execPath, args, {
    cwd: rootDir,
    env: process.env,
    stdio: countsSkips ? ["inherit", "pipe", "inherit"] : "inherit",
    shell: false,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (countsSkips) {
    const output = String(result.stdout || "");
    process.stdout.write(output);
    skipped.push(...parseTapSkips(output));
    skipsCounted = true;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    stopped = true;
  }
}

if (!skipsCounted) {
  // テストの手前（ビルド）で止まった。skip を数えていないので、skip の集計も
  // 許可リストの判定も出さない——出すと「skip なし」「全項目が stale」と誤って読める。
} else if (skipped.length > 0) {
  process.stdout.write(`\n前提が無くて走らなかった検査 ${skipped.length}件:\n`);
  for (const entry of skipped) process.stdout.write(`  - ${entry.name}\n      ${entry.reason}\n`);
  // 理由の無い skip は、何を用意すれば走るのか誰にも分からないまま残る。
  const unexplained = skipped.filter((entry) => entry.reason === "(理由なし)");
  if (unexplained.length > 0) {
    process.stdout.write(`\n理由の書かれていない skip が ${unexplained.length}件ある。`
      + "何を用意すれば走るのかを skip の理由に書くこと。\n");
    process.exitCode = 1;
  }
  if (skipPolicy) {
    const verdict = evaluateTestSkips(skipped, skipPolicy);
    if (!verdict.pass) {
      if (verdict.unexpected.length > 0) {
        process.stdout.write(`\nrelease skip policyに無いskipが ${verdict.unexpected.length}件ある:\n`);
        for (const entry of verdict.unexpected) process.stdout.write(`  - ${entry.name}\n      ${entry.reason}\n`);
      }
      if (verdict.stale.length > 0) {
        process.stdout.write(`\nもう発生しないallowlist項目が ${verdict.stale.length}件ある。削除または前提を確認すること:\n`);
        for (const entry of verdict.stale) process.stdout.write(`  - ${entry.name}\n`);
      }
      process.exitCode = 1;
    } else {
      process.stdout.write(`\nrelease skip policy: clean-cloneで意図した ${skipped.length}件だけを確認した。\n`);
    }
  } else if (strict) {
    process.stdout.write("\n--strict: skip を1件も許さない設定です。"
      + "前提を揃えるか、その検査が本当に環境依存かを見直してください。\n");
    process.exitCode = 1;
  }
} else {
  process.stdout.write("\nskip なし（全ての検査が実際に走った）\n");
  if (skipPolicy) {
    process.stdout.write("release skip policyの全項目がstaleです。不要な例外を残さないため失敗にします。\n");
    process.exitCode = 1;
  }
}
