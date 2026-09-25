import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  buildEngineArgs,
  CLAUDE_READ_ONLY_REQUIRED_FLAGS,
  claudeReadOnlySupportFromHelp,
  resolveExecutable,
  selectEngine,
  spawnInvocation,
} from "../scripts/harness-parallel-agents.mjs";

// 並列ランナーは PATH を ":" で分けていたので、Windows（区切りは ";"、実行ファイルは
// PATHEXT の拡張子つき）ではエンジンが1つも見つからなかった（外部レビューの指摘）。

test("Windows では PATH を ; で分け、PATHEXT の拡張子で実行ファイルを探す", () => {
  const present = new Set([
    path.win32.join("C:\\Tools\\npm", "claude.cmd"),
    path.win32.join("C:\\Tools\\npm", "claude"), // npm が置く sh 用の拡張子なし shim（Windows では起動できない）
    path.win32.join("C:\\Tools\\codex", "codex.exe"),
  ]);
  const options = {
    platform: "win32",
    env: { Path: "C:\\Windows;C:\\Tools\\npm;C:\\Tools\\codex", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    fileExists: (candidate) => present.has(candidate),
  };
  assert.equal(resolveExecutable("claude", options), path.win32.join("C:\\Tools\\npm", "claude.cmd"));
  assert.equal(resolveExecutable("codex", options), path.win32.join("C:\\Tools\\codex", "codex.exe"));
  assert.equal(resolveExecutable("missing", options), null);
  // 拡張子つきで指定されたものはそのまま探す。
  assert.equal(resolveExecutable("codex.exe", options), path.win32.join("C:\\Tools\\codex", "codex.exe"));
});

test("POSIX では PATH を : で分ける（今までどおり）", () => {
  const present = new Set([path.posix.join("/opt/bin", "codex")]);
  assert.equal(resolveExecutable("codex", {
    platform: "darwin",
    env: { PATH: "/usr/bin:/opt/bin" },
    fileExists: (candidate) => present.has(candidate),
  }), path.posix.join("/opt/bin", "codex"));
});

test("Windows の .cmd / .bat は cmd.exe 越しに、引数を壊さずに起動する", () => {
  const invocation = spawnInvocation("C:\\Tools\\npm\\claude.cmd", ["-p", "--tools", "Read,Grep,Glob"], {
    platform: "win32",
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
  });
  assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(invocation.options.windowsVerbatimArguments, true);
  assert.match(invocation.args[3], /claude\.cmd/u);
  assert.match(invocation.args[3], /Read\^\^\^,Grep/u, "区切りの , を cmd と shim の2段でエスケープする");
  // .exe はそのまま起動する。
  assert.deepEqual(spawnInvocation("C:\\Tools\\codex\\codex.exe", ["exec"], { platform: "win32", env: {} }), {
    command: "C:\\Tools\\codex\\codex.exe",
    args: ["exec"],
    options: {},
  });
});

// claude は読み取り専用の実行から外されていて、既定が読み取り専用なので、Claude Code しか
// 無い端末ではこの入口が使えなかった。書き込みの道具そのものを渡さない引数で読み取り専用に入れる。
test("claude の読み取り専用の実行では、書き込みの道具を渡さず MCP も読まない", () => {
  const args = buildEngineArgs("claude", { prompt: "x" }, { readOnly: true });
  assert.equal(args[0], "-p");
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(value("--permission-mode"), "dontAsk");
  assert.equal(value("--tools"), "Read,Grep,Glob");
  for (const tool of ["Bash", "Edit", "Write", "NotebookEdit"]) {
    assert.ok(value("--disallowedTools").split(",").includes(tool), `${tool} を禁止していない`);
  }
  assert.ok(args.includes("--strict-mcp-config"), "MCP の道具は書き込めるかもしれないので読まない");
});

test("claude の CLI が読み取り専用の引数を持っているかを --help の本文で確かめる（モデルは呼ばない）", () => {
  const full = CLAUDE_READ_ONLY_REQUIRED_FLAGS.join("\n");
  assert.deepEqual(claudeReadOnlySupportFromHelp(full), { supported: true, missing: [] });
  const old = claudeReadOnlySupportFromHelp("--permission-mode <mode> (choices: acceptEdits, plan)");
  assert.equal(old.supported, false);
  assert.ok(old.missing.includes("--tools"));
});

test("read-only では、引数を持つ claude だけを選び、持たない claude は起動もしない", async () => {
  let probed = [];
  const probe = async (engineId, options) => {
    probed.push({ engineId, readOnly: options.readOnly });
    return { engineId, binary: `/fake/${engineId}`, available: true, reason: null };
  };
  const supported = async () => ({ supported: true, missing: [] });
  const unsupported = async () => ({ supported: false, missing: ["--tools"] });

  const chosen = await selectEngine("claude", { readOnly: true, probe, readOnlySupport: supported });
  assert.equal(chosen.engineId, "claude");
  assert.deepEqual(probed, [{ engineId: "claude", readOnly: true }], "読み取り専用の引数でプローブする");

  probed = [];
  await assert.rejects(
    () => selectEngine("claude", { readOnly: true, probe, readOnlySupport: unsupported }),
    /read-only を保証できません/u,
  );
  assert.equal(probed.length, 0, "保証できない版は起動しない（実行も課金もしない）");

  // codex が無く claude しか無い端末でも、自動選択で read-only の claude が選ばれる。
  probed = [];
  const onlyClaude = async (engineId, options) => {
    probed.push({ engineId, readOnly: options.readOnly });
    return engineId === "claude"
      ? { engineId, binary: "/fake/claude", available: true, reason: null }
      : { engineId, available: false, reason: "実行ファイルが見つかりません" };
  };
  const auto = await selectEngine("auto", { readOnly: true, probe: onlyClaude, readOnlySupport: supported });
  assert.equal(auto.engineId, "claude");
});
