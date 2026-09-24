import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 自動更新器（update-current.mjs）から呼ばれた setup-agents は、動画ハーネスの前提が
// 欠けていても配る。対話の setup は今までどおり fail-closed。
//
// 2026-09-24 に、負荷下で voice-quality-python の確認が時間切れになり、setup が exit 2 で
// 止まって 0.1.25→0.1.26 の更新が丸ごと巻き戻された。前提が欠けた端末には、それを直す版も
// 届かなくなる。ここでは前提を意図的に欠かせた隔離 HOME で、偽のホスト CLI を相手に確かめる。

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function quoteForCmd(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function writeFakeHost(binDir, statePath, host) {
  const runnerPath = path.join(binDir, `${host}-fake.mjs`);
  await writeFile(runnerPath, `import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
const statePath = ${JSON.stringify(statePath)};
const args = process.argv.slice(2);
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
appendFileSync(statePath + ".calls", args.join(" ") + "\\n");
if (args[0] === "--version") { console.log(${JSON.stringify(host === "codex" ? "codex-cli 999.0.0" : "2.99.0 (Claude Code)")}); process.exit(0); }
const text = args.join(" ");
if (text.includes("plugin marketplace")) process.exit(0);
if (text.includes("plugin list")) { if (state.installed) console.log("buzzassist@buzzassist"); process.exit(0); }
if (text.includes("plugin add") || text.includes("plugin install") || text.includes("plugin update")) {
  state.installed = true; writeFileSync(statePath, JSON.stringify(state)); process.exit(0);
}
process.exit(0);
`);
  if (process.platform === "win32") {
    const commandPath = path.join(binDir, `${host}.cmd`);
    await writeFile(commandPath, `@echo off\r\n${quoteForCmd(process.execPath)} ${quoteForCmd(runnerPath)} %*\r\n`);
    return commandPath;
  }
  const commandPath = path.join(binDir, host);
  await writeFile(commandPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(runnerPath)} "$@"\n`);
  await chmod(commandPath, 0o755);
  return commandPath;
}

async function isolatedMachine(prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const homeDir = path.join(root, "home");
  const binDir = path.join(root, "bin");
  const projectDir = path.join(root, "project");
  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  const claudeState = path.join(root, "claude-state.json");
  const codexState = path.join(root, "codex-state.json");
  await writeFakeHost(binDir, claudeState, "claude");
  const codexCommand = await writeFakeHost(binDir, codexState, "codex");
  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    BUZZASSIST_SETUP_HOME: homeDir,
    CODEX_HOME: path.join(homeDir, ".codex"),
    CLAUDE_CONFIG_DIR: path.join(homeDir, ".claude"),
    XDG_CONFIG_HOME: path.join(homeDir, ".config"),
    APPDATA: path.join(homeDir, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(homeDir, "AppData", "Local"),
    // ffmpeg も python も見えない PATH。ハーネスの前提は必ず欠ける。
    PATH: binDir,
    Path: binDir,
    CODEX_COMMAND: codexCommand,
    VOICE_QA_PYTHON: path.join(root, "missing-python"),
    BUZZASSIST_PYTHON: path.join(root, "missing-python"),
    FFMPEG_PATH: path.join(root, "missing-ffmpeg"),
    FFPROBE_PATH: path.join(root, "missing-ffprobe"),
    ELEVENLABS_API_KEY: "",
    XI_API_KEY: "",
    LOVART_ACCESS_KEY: "",
    LOVART_SECRET_KEY: "",
    BUZZASSIST_MEDIA_TOKEN: "",
    BUZZASSIST_TOKEN: "",
    BUZZASSIST_UPDATER_INSTALL: "",
    BUZZASSIST_AUTO_UPDATE_SKIP_REGISTER: "",
  };
  return { root, homeDir, projectDir, env, claudeState, codexState };
}

function runSetup(args, env) {
  return spawnSync(process.execPath, [path.join(repoRoot, "scripts", "setup-agents.mjs"), ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 180_000,
  });
}

// 既に運営者の端末で動いている更新器（0.1.26 以前）が渡す引数そのもの。
function legacyUpdaterArgs(hosts, projectDir) {
  return [
    "--agents", hosts,
    "--project-dir", projectDir,
    "--canvas-dir", path.join(projectDir, "canvas"),
    "--skip-install",
    "--skip-build",
    "--no-launch",
    "--no-auto-update",
    // 配布物の差し替えは試験の対象外（隔離 HOME へのコピーに時間がかかる）。
    "--skip-plugin-source",
  ];
}

test("an already-deployed updater's setup call installs the plugin even when harness prerequisites are missing", async () => {
  const machine = await isolatedMachine("buzzassist-updater-legacy-");
  try {
    const result = runSetup(legacyUpdaterArgs("claude", machine.projectDir), {
      ...machine.env,
      BUZZASSIST_AUTO_UPDATE_SKIP_REGISTER: "1",
    });
    assert.equal(result.status, 0, `updater setup must succeed:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /BUZZASSIST_HARNESS_READY=(?:no|unknown)/u);
    assert.match(result.stdout, /BUZZASSIST_HARNESS_READY_OVERRIDE=updater-install/u);
    assert.match(result.stdout, /BUZZASSIST_UPDATER_INSTALL=legacy-updater-arguments/u);
    assert.match(result.stdout, /Claude Code: configured/u);
    assert.equal(JSON.parse(await readFile(machine.claudeState, "utf8")).installed, true, "the host plugin install must still run");
  } finally {
    await rm(machine.root, { recursive: true, force: true });
  }
});

test("the same arguments without the updater's environment stay fail-closed", async () => {
  const machine = await isolatedMachine("buzzassist-updater-notupdater-");
  try {
    const result = runSetup(legacyUpdaterArgs("claude", machine.projectDir), machine.env);
    assert.equal(result.status, 2, `interactive setup must stay fail-closed:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /BUZZASSIST_HARNESS_READY=(?:no|unknown)/u);
    assert.match(result.stdout, /fail-closed/u);
    assert.doesNotMatch(result.stdout, /BUZZASSIST_HARNESS_READY_OVERRIDE/u);
    await assert.rejects(readFile(machine.claudeState, "utf8"), { code: "ENOENT" }, "fail-closed must stop before touching the host");
  } finally {
    await rm(machine.root, { recursive: true, force: true });
  }
});

test("the new updater also refreshes the other host where BuzzAssist is already installed", async () => {
  const machine = await isolatedMachine("buzzassist-updater-bothhosts-");
  try {
    // Codex にも BuzzAssist が入っている端末（cache の置き場所だけで判定する）。
    await mkdir(path.join(machine.homeDir, ".codex", "plugins", "cache", "buzzassist", "buzzassist", "0.1.25"), { recursive: true });
    const result = runSetup(legacyUpdaterArgs("claude", machine.projectDir), {
      ...machine.env,
      BUZZASSIST_UPDATER_INSTALL: "1",
      BUZZASSIST_AUTO_UPDATE_SKIP_REGISTER: "1",
    });
    assert.equal(result.status, 0, `updater setup must succeed:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /BUZZASSIST_UPDATER_INSTALL=env/u);
    assert.match(result.stdout, /Claude Code: configured/u);
    assert.match(result.stdout, /Codex: configured/u);
    assert.equal(JSON.parse(await readFile(machine.codexState, "utf8")).installed, true);
  } finally {
    await rm(machine.root, { recursive: true, force: true });
  }
});

test("updater setup tolerates a host whose CLI is gone, but not a failed install or zero configured hosts", async () => {
  const { setupFailureVerdict, resolveAutoUpdateHosts } = await import("../scripts/setup-agents.mjs");
  const agents = ["claude", "codex"];
  const okAndSkipped = { claude: { ok: true }, codex: { ok: false, skipped: true } };
  assert.deepEqual(setupFailureVerdict({ targetAgents: agents, results: okAndSkipped, updater: true }), { failed: [], skipped: ["codex"] });
  assert.deepEqual(setupFailureVerdict({ targetAgents: agents, results: okAndSkipped, updater: false }).failed, ["codex"], "interactive setup reports every host");
  const okAndFailed = { claude: { ok: true }, codex: { ok: false } };
  assert.deepEqual(setupFailureVerdict({ targetAgents: agents, results: okAndFailed, updater: true }).failed, ["codex"]);
  const allSkipped = { claude: { ok: false, skipped: true }, codex: { ok: false, skipped: true } };
  assert.deepEqual(setupFailureVerdict({ targetAgents: agents, results: allSkipped, updater: true }).failed, ["claude", "codex"]);

  // 自動更新の対象: 今回の対象に、既存の登録と導入済みのホストを足す（どちら向きでも）。
  assert.deepEqual(resolveAutoUpdateHosts({ configured: ["claude"], installedHosts: ["codex", "claude"] }), ["claude", "codex"]);
  assert.deepEqual(resolveAutoUpdateHosts({ configured: ["codex"], existingHosts: ["claude"] }), ["codex", "claude"]);
  assert.deepEqual(resolveAutoUpdateHosts({ configured: ["codex"], installedHosts: ["claude"] }), ["codex", "claude"]);
  // Cursor だけの setup など、今回 codex / claude を1つも設定していなければ登録しない。
  assert.deepEqual(resolveAutoUpdateHosts({ configured: [], existingHosts: ["claude"], installedHosts: ["codex"] }), []);
});
