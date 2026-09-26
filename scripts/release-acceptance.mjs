#!/usr/bin/env node
// Release のあとの受け入れ確認（Claude Code / Codex 共通、読み取り中心）
//
//   node scripts/release-acceptance.mjs                 両ホストの版・フック・MCP を確かめる
//   node scripts/release-acceptance.mjs --json
//   node scripts/release-acceptance.mjs --update-first  先に自動更新（update-current）を1回走らせてから確かめる
//
// 本体は lib/releaseAcceptance.mjs。確かめるのは、運営者の実機で
//   (a) Claude Code と Codex の両方に、最新の stable Release の版が入っていて有効か
//   (b) その版のフック（hooks/*.json の UserPromptSubmit・Stop など）がホストに登録されているか
//   (c) その版の MCP サーバーが起動して、道具の一覧と read_me を返すか
// ホストの設定・plugin・更新器の状態は書き換えない（--update-first を付けたときだけ、更新器を呼ぶ）。
// 更新が走っている間は確かめない（更新のロックを見る）。
//
// 終了コード: 0 合格 / 1 不合格 / 2 未確定（確かめられない項目がある）/ 3 更新中 / 64 引数の誤り

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import { updaterPaths } from "../lib/pluginAutoUpdate.mjs";
import { ACCEPTANCE_HOSTS, formatReleaseAcceptance, runReleaseAcceptance, updateLockState } from "../lib/releaseAcceptance.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const HELP = `Release のあとの受け入れ確認（読み取り中心）

  node scripts/release-acceptance.mjs [options]

確かめること（Claude Code と Codex のそれぞれ）:
  version   ホストが有効にしている BuzzAssist の版が最新の stable Release と同じか
  enabled   plugin が有効か
  hooks     その版のフック（UserPromptSubmit・Stop など）が登録され、起動する script を読み込めるか。
            Codex は /hooks の信頼、Claude Code は disableAllHooks も見る
  mcp       ホストが起動するのと同じ定義で MCP を起動し、道具の一覧と read_me が返るか
            （project と canvas は一時フォルダ。起動する置き場の版も比べる）

options:
  --json                      JSON で出す
  --expected-version <版>     最新の Release を GitHub に聞かずにこの版と比べる
  --hosts claude,codex        確かめるホスト（既定は両方。無いホストは対象外として出す）
  --skip-mcp                  MCP を起動しない（mcp は未確認になる）
  --skip-hook-load            フックの script の読み込みを試さない
  --allow-dependency-install  MCP の置き場に依存が無く Release の展開先も使えないとき、一時フォルダの写しに
                              npm install して確かめる（置き場には入れない。ネットワークと数分かかる）
  --mcp-timeout-ms <n>        MCP の応答を待つ上限（既定 60000）
  --update-first              先に更新器（この写しの scripts/update-current.mjs）を1回走らせてから確かめる。
                              走っている更新があれば待たずに止まる
  -h, --help                  この説明

終了コード: 0 合格 / 1 不合格 / 2 未確定 / 3 更新中 / 64 引数の誤り
HOME は BUZZASSIST_SETUP_HOME があればそれ（自動更新と同じ決め方）。
`;

export function parseAcceptanceArgs(argv) {
  const args = { json: false, expectedVersion: "", hosts: [...ACCEPTANCE_HOSTS], skipMcp: false, hookLoadCheck: true, allowDependencyInstall: false, mcpTimeoutMs: 60_000, updateFirst: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${token} には値が要る`);
      index += 1;
      return next;
    };
    if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--json") args.json = true;
    else if (token === "--expected-version") args.expectedVersion = value();
    else if (token === "--hosts") {
      const hosts = value().split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
      for (const host of hosts) if (!ACCEPTANCE_HOSTS.includes(host)) throw new Error(`未知のホスト: ${host}（claude / codex）`);
      if (hosts.length === 0) throw new Error("--hosts が空");
      args.hosts = [...new Set(hosts)];
    } else if (token === "--skip-mcp") args.skipMcp = true;
    else if (token === "--skip-hook-load") args.hookLoadCheck = false;
    else if (token === "--allow-dependency-install") args.allowDependencyInstall = true;
    else if (token === "--mcp-timeout-ms") {
      const parsed = Number.parseInt(value(), 10);
      if (!Number.isSafeInteger(parsed) || parsed < 1000) throw new Error("--mcp-timeout-ms は 1000 以上の整数");
      args.mcpTimeoutMs = parsed;
    } else if (token === "--update-first") args.updateFirst = true;
    else throw new Error(`未知の引数: ${token}`);
  }
  return args;
}

// 更新器の出力は標準エラーへ回す（--json の標準出力を JSON だけに保つ）。
function runUpdaterOnce({ homeDir, env, stderr }) {
  const updater = path.join(SCRIPT_DIR, "update-current.mjs");
  const { configPath } = updaterPaths(homeDir);
  stderr.write(`先に更新器を1回走らせます: node ${updater} --config ${configPath}\n`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [updater, "--config", configPath], { env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => stderr.write(chunk));
    child.stderr.on("data", (chunk) => stderr.write(chunk));
    child.on("error", (error) => resolve({ code: null, error: error.message }));
    child.on("close", (code) => resolve({ code }));
  });
}

const EXIT_CODES = { pass: 0, fail: 1, incomplete: 2, busy: 3 };

export async function runReleaseAcceptanceCli(argv = process.argv.slice(2), { env = process.env, stdout = process.stdout, stderr = process.stderr, fetchLatest = null, runUpdater = runUpdaterOnce } = {}) {
  let args;
  try {
    args = parseAcceptanceArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return { exitCode: 64 };
  }
  if (args.help) {
    stdout.write(HELP);
    return { exitCode: 0 };
  }
  const homeDir = path.resolve(env.BUZZASSIST_SETUP_HOME || homedir());
  if (args.updateFirst) {
    // 更新と同時に走らせない。走っている更新があれば、ここで止まる（待たない）。
    const lock = updateLockState({ homeDir });
    if (lock.busy) {
      stderr.write(`自動更新が走っている（${lock.lockDir}）。終わってからもう一度回す\n`);
      return { exitCode: EXIT_CODES.busy };
    }
    const updated = await runUpdater({ homeDir, env, stderr });
    if (updated.code !== 0) stderr.write(`更新器が exit ${updated.code ?? updated.error} で終わった。今の状態のまま確かめる\n`);
  }
  let report;
  try {
    report = await runReleaseAcceptance({
      homeDir,
      env,
      hosts: args.hosts,
      expectedVersion: args.expectedVersion,
      fetchLatest,
      skipMcp: args.skipMcp,
      allowDependencyInstall: args.allowDependencyInstall,
      hookLoadCheck: args.hookLoadCheck,
      mcpTimeoutMs: args.mcpTimeoutMs,
    });
  } catch (error) {
    stderr.write(`${error?.message || error}\n`);
    return { exitCode: 64 };
  }
  stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : formatReleaseAcceptance(report));
  return { exitCode: EXIT_CODES[report.status] ?? 1, report };
}

if (isDirectCli(import.meta.url)) {
  runReleaseAcceptanceCli().then(({ exitCode }) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
