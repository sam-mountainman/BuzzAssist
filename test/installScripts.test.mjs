import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 1行導入（install.sh / install.ps1）の約束を、実行せずに確かめる。実際の導入は隔離した
// HOME と偽のホスト CLI で手動確認した（Node 22 の取得と照合、Release の取得と照合、
// ホスト検出、setup-agents の実行、再実行で取り直さないこと、前提不足での exit 2）。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shellScript = readFileSync(path.join(root, "install.sh"), "utf8");
const powershellBytes = readFileSync(path.join(root, "install.ps1"));
const powershell = powershellBytes.subarray(3).toString("utf8");

test("install.sh is a strict bash script that parses fully before running anything", () => {
  assert.match(shellScript, /^#!\/usr\/bin\/env bash\n/u);
  assert.match(shellScript, /\nset -euo pipefail\n/u);
  // `curl | bash` で途中の子プロセスが残りのスクリプトを読まないよう、最後の1行でだけ実行する。
  assert.match(shellScript.trimEnd(), /\nmain "\$@"$/u);
  if (process.platform !== "win32") {
    assert.ok((statSync(path.join(root, "install.sh")).mode & 0o111) !== 0, "install.sh must be executable");
    const parsed = spawnSync("bash", ["-n", path.join(root, "install.sh")], { encoding: "utf8" });
    assert.equal(parsed.status, 0, parsed.stderr);
  }
});

test("both installers verify every download and never need administrator rights", () => {
  for (const [name, source] of [["install.sh", shellScript], ["install.ps1", powershell]]) {
    assert.match(source, /nodejs\.org\/dist\/latest-v\$\{?NODE_MIN_MAJOR\}?\.x\/SHASUMS256\.txt|nodejs\.org\/dist\/latest-v\$NodeMinMajor\.x\/SHASUMS256\.txt/u, `${name}: Node is checked against SHASUMS256.txt`);
    assert.match(source, /\.sha256/u, `${name}: the Release tgz is checked against its .sha256`);
    assert.match(source, /buzzassist-canvas-mcp-/u);
    assert.match(source, /setup-agents\.mjs/u);
    assert.match(source, /--agents/u, `${name}: every detected host is configured in one setup run`);
    assert.match(source, /\.buzzassist[\\/]tools[\\/]?/u, `${name}: Node goes to the managed tools directory`);
    assert.doesNotMatch(source, /\bsudo\b|RunAs|-Verb\s+RunAs/u, `${name}: no elevation`);
    assert.match(source, /Claude Code も Codex も見つかりませんでした/u, `${name}: explains how to install a host`);
    assert.match(source, /--allow-harness-not-ready/u, `${name}: explains the canvas-only escape hatch after exit 2`);
  }
  assert.match(shellScript, /mismatch|一致しません/u);
});

test("install.ps1 is BOM-marked UTF-8, uses no symlinks, and survives native stderr and execution policy", () => {
  assert.deepEqual([...powershellBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "Windows PowerShell 5.1 needs the BOM to read Japanese text");
  assert.doesNotMatch(powershell, /SymbolicLink|mklink/iu);
  assert.match(powershell, /-ExecutionPolicy Bypass/u);
  assert.match(powershell, /スクリプトの実行が無効/u, "explains what to do when the execution policy blocks the script");
  assert.match(powershell, /Get-FileHash -Algorithm SHA256/u);
  // Windows PowerShell 5.1 は Stop のまま native の stderr を 2>&1 で受けると最初の1行で止まる。
  assert.match(powershell, /\$ErrorActionPreference = "Continue"\s*\n\s*try \{\s*\n\s*& \$nodeExe \$setup --agents/u);
  assert.doesNotMatch(powershell, /\bnpm(?:\.ps1)?\b\s+(?:install|ci|run)/u, "npm.ps1 would be blocked by the execution policy");
});
