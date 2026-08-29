#!/usr/bin/env node
//   node scripts/run-tests.mjs              前提の無い検査は skip、理由を必ず出す
//   node scripts/run-tests.mjs --strict     skip を1件も許さない（リリース前・開発機）
//
// なぜ skip を数えるか:
// 終了コードしか見ていなかったので、**壊れた検査が skip されて緑になる**状態が
// あった。動画品質監査の関数へ必ず例外を投げる変異を入れ、PATH から ffmpeg を
// 外して走らせると「2 pass / 1 skip / exit 0」になる——完全に壊れた関数が生存する。
// 公開 clone や新しい運営者のマシンほど、この状態になりやすい。
//
// skip 自体は要る。前提が手元に無い環境で落とし続けると、本当の失敗が常時赤に
// 埋もれる。だから禁じるのではなく、**必ず目に見えるところへ出す**。
// リリース前は --strict で1件も許さない。

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = join(rootDir, "test");
const strict = process.argv.includes("--strict") || process.env.BUZZASSIST_TEST_STRICT === "1";

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
const buildCommand = { command: "npm", args: ["run", "build"], label: "vite build" };

let skipped = [];

{
  const build = spawnSync(buildCommand.command, buildCommand.args, {
    cwd: rootDir, env: process.env, stdio: "inherit", shell: false,
  });
  if (build.error) throw build.error;
  if (build.status !== 0) {
    process.stdout.write(`\n${buildCommand.label} が失敗しました。UI のテストは App.jsx を`
      + "レンダーしないので、ビルドが通らない状態でも大半が緑になります。\n");
    process.exit(build.status ?? 1);
  }
}

for (const { args, countsSkips } of commands) {
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
    for (const line of output.split("\n")) {
      const match = line.match(/^(?:not )?ok \d+ - (.+?) # SKIP ?(.*)$/u);
      if (match) skipped.push({ name: match[1].trim(), reason: (match[2] || "").trim() || "(理由なし)" });
    }
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (skipped.length > 0) {
  process.stdout.write(`\n前提が無くて走らなかった検査 ${skipped.length}件:\n`);
  for (const entry of skipped) process.stdout.write(`  - ${entry.name}\n      ${entry.reason}\n`);
  // 理由の無い skip は、何を用意すれば走るのか誰にも分からないまま残る。
  const unexplained = skipped.filter((entry) => entry.reason === "(理由なし)");
  if (unexplained.length > 0) {
    process.stdout.write(`\n理由の書かれていない skip が ${unexplained.length}件ある。`
      + "何を用意すれば走るのかを skip の理由に書くこと。\n");
    process.exitCode = 1;
  }
  if (strict) {
    process.stdout.write("\n--strict: skip を1件も許さない設定です。"
      + "前提を揃えるか、その検査が本当に環境依存かを見直してください。\n");
    process.exitCode = 1;
  }
} else {
  process.stdout.write("\nskip なし（全ての検査が実際に走った）\n");
}
