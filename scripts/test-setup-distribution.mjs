#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageVersion = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")).version;
// 運営者の信頼リスト path を模した値。setup の生成物・出力のどこにも現れてはいけない。
const reviewerTrustSentinel = "/secure/operator-only/reviewer-trust-sentinel-7d1e.json";

// These are the exact host-control files that an accidental real
// `codex plugin ...` / `claude plugin ...` invocation changes. Hash files, but
// do not compare live cache directory trees wholesale: the desktop host may
// legitimately finish an unrelated background cache refresh during this test.
// Cache isolation is asserted below by looking for this run's unique temp path
// in every real BuzzAssist cache/source root.
const realHome = os.homedir();
const protectedRealHostConfigPaths = [
  path.join(realHome, ".agents", "plugins", "marketplace.json"),
  path.join(realHome, ".codex", "config.toml"),
  path.join(realHome, ".claude.json"),
  path.join(realHome, ".claude", "plugins", "installed_plugins.json"),
  path.join(realHome, ".claude", "plugins", "known_marketplaces.json"),
];
const protectedRealHostCachePaths = [
  path.join(realHome, ".codex", "plugins", "cache", "buzzassist"),
  path.join(realHome, ".claude", "plugins", "cache", "buzzassist"),
  path.join(realHome, "plugins", "buzzassist"),
];
const hostControlFileNames = new Set([
  ".mcp.json",
  "config.toml",
  "installed_plugins.json",
  "known_marketplaces.json",
  "marketplace.json",
  "plugin.json",
  "settings.json",
]);

async function snapshotPath(target, depth = 2) {
  let details;
  try { details = await lstat(target); } catch (error) {
    if (error?.code === "ENOENT") return { type: "missing" };
    throw error;
  }
  if (details.isSymbolicLink()) return { type: "symlink", target: await readlink(target) };
  if (details.isFile()) {
    const bytes = await readFile(target);
    return { type: "file", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  if (!details.isDirectory()) return { type: "other", size: details.size };
  const entries = {};
  if (depth > 0) {
    for (const name of (await readdir(target)).sort()) {
      entries[name] = await snapshotPath(path.join(target, name), depth - 1);
    }
  }
  return { type: "directory", mtimeMs: details.mtimeMs, entries };
}

// 実ユーザーの launchd に読み込まれている自動更新ジョブ。ファイルの比較だけでは、
// 読み込み中のジョブが別の plist へ差し替わったことを検出できない。
function realLaunchdUpdaterState() {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") return null;
  const result = spawnSync("/bin/launchctl", ["print", `gui/${process.getuid()}/ai.buzzassist.plugin-updater`], { encoding: "utf8" });
  if (result.status !== 0) return { loaded: false };
  const plist = result.stdout.match(/^\s*path = (.+)$/mu)?.[1] ?? null;
  return { loaded: true, plist };
}

async function snapshotRealHostState() {
  return {
    ...Object.fromEntries(await Promise.all(
      protectedRealHostConfigPaths.map(async (target) => [target, await snapshotPath(target, 0)]),
    )),
    launchdUpdater: realLaunchdUpdaterState(),
  };
}

async function pathContainsText(target, needle, depth = 7) {
  let details;
  try { details = await lstat(target); } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (details.isSymbolicLink()) return (await readlink(target)).includes(needle);
  if (details.isFile()) {
    const controlFile = hostControlFileNames.has(path.basename(target));
    if (details.size > 2 * 1024 * 1024 || !controlFile) return false;
    return (await readFile(target, "utf8")).includes(needle);
  }
  if (!details.isDirectory() || depth <= 0) return false;
  for (const name of await readdir(target)) {
    if (name === "node_modules") continue;
    if (await pathContainsText(path.join(target, name), needle, depth - 1)) return true;
  }
  return false;
}

async function assertRealCachesExcludeIsolatedPath(isolatedPath) {
  for (const cacheRoot of protectedRealHostCachePaths) {
    assert.equal(
      await pathContainsText(cacheRoot, isolatedPath),
      false,
      `isolated distribution path leaked into real host cache/source: ${cacheRoot}`,
    );
  }
}

function quoteForCmd(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

// 自動更新の登録が呼ぶスケジューラを偽物にする。
//
// codex / claude は偽物にしていたのに、launchctl と systemctl は本物を呼んでいた。
// 隔離した HOME の plist で bootout / bootstrap するので、**実ユーザーの launchd に
// 読み込まれた ai.buzzassist.plugin-updater が、テスト後に消える一時ディレクトリを
// 指すジョブへ置き換わっていた**（2026-09-17 に確認）。npm test を回すたびに、この Mac の
// 自動更新が壊れる。ファイルの比較では見えないので、上の realLaunchdUpdaterState でも見る。
// Windows の schtasks.exe は実行ファイルの偽物を置けないので対象外（CI の runner は使い捨て）。
async function writeFakeSchedulers(binDir, logPath) {
  if (process.platform === "win32") return;
  for (const name of ["launchctl", "systemctl"]) {
    const file = path.join(binDir, name);
    // systemctl の登録確認は is-enabled / is-active の答えを見るので、それに答える。
    const answers = name === "systemctl"
      ? `case "$*" in\n  *is-enabled*) echo enabled ;;\n  *is-active*) echo active ;;\nesac\n`
      : "";
    await writeFile(file, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> ${JSON.stringify(logPath)}\n${answers}exit 0\n`);
    await chmod(file, 0o755);
  }
}

async function writeFakeHost(binDir, statePath, host) {
  const runnerPath = path.join(binDir, `${host}-fake.mjs`);
  const runner = `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const host = ${JSON.stringify(host)};
const statePath = ${JSON.stringify(statePath)};
const args = process.argv.slice(2);
let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
if (args[0] === "--version") {
  console.log(host === "codex" ? "codex-cli 999.0.0" : "2.99.0 (Claude Code)");
  process.exit(0);
}
const text = args.join(" ");
if (text.includes("plugin marketplace list")) {
  if (state.marketplace) console.log("buzzassist " + state.marketplace);
  process.exit(0);
}
if (text.includes("plugin marketplace add")) {
  state.marketplace = args.find((arg) => arg.includes("plugins")) || "configured";
  writeFileSync(statePath, JSON.stringify(state));
  process.exit(0);
}
if (text.includes("plugin list")) {
  if (state.installed) console.log("buzzassist@buzzassist\\nVersion: ${packageVersion}\\nStatus: enabled");
  process.exit(0);
}
if (text.includes("plugin add") || text.includes("plugin install")) {
  state.installed = true;
  writeFileSync(statePath, JSON.stringify(state));
  process.exit(0);
}
if (text.includes("plugin remove") || text.includes("plugin uninstall")) {
  state.installed = false;
  writeFileSync(statePath, JSON.stringify(state));
  process.exit(0);
}
process.exit(0);
`;
  await writeFile(runnerPath, runner);
  await chmod(runnerPath, 0o755);

  if (process.platform === "win32") {
    const commandPath = path.join(binDir, `${host}.cmd`);
    await writeFile(commandPath, `@echo off\r\n${quoteForCmd(process.execPath)} ${quoteForCmd(runnerPath)} %*\r\n`);
    return;
  }
  const commandPath = path.join(binDir, host);
  await writeFile(commandPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(runnerPath)} "$@"\n`);
  await chmod(commandPath, 0o755);
}

async function runHostSetup(host) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `buzzassist-${host}-distribution-`));
  const homeDir = path.join(tempRoot, "home");
  const binDir = path.join(tempRoot, "bin");
  const projectDir = path.join(tempRoot, "Project With Spaces", "動画プロジェクト");
  const statePath = path.join(tempRoot, `${host}-state.json`);
  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await writeFakeHost(binDir, statePath, host);
  const schedulerLog = path.join(tempRoot, "scheduler-calls.log");
  await writeFakeSchedulers(binDir, schedulerLog);
  // Claude setup still runs the shared image-host doctor. Give it an isolated
  // Codex executable too, so no read-only probe can escape to the desktop
  // application's real CLI while verifying the Claude distribution path.
  if (host !== "codex") {
    await writeFakeHost(binDir, path.join(tempRoot, "doctor-codex-state.json"), "codex");
  }

  try {
    const env = {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      BUZZASSIST_SETUP_HOME: homeDir,
      CODEX_HOME: path.join(homeDir, ".codex"),
      CLAUDE_CONFIG_DIR: path.join(homeDir, ".claude"),
      XDG_CONFIG_HOME: path.join(homeDir, ".config"),
      XDG_CACHE_HOME: path.join(homeDir, ".cache"),
      APPDATA: path.join(homeDir, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(homeDir, "AppData", "Local"),
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      CODEX_COMMAND: path.join(binDir, process.platform === "win32" ? "codex.cmd" : "codex"),
      CLAUDE_CODE: host === "claude" ? "1" : "",
      CODEX: host === "codex" ? "1" : "",
      // 登録を省略すると、updater は正直に manual と報告する（確かめていない状態を
      // 有効と言わない）。macOS / Linux は偽のスケジューラを通して実際に登録させ、
      // 偽物を置けない Windows だけ省略する。
      BUZZASSIST_AUTO_UPDATE_SKIP_REGISTER: process.platform === "win32" ? "1" : "",
      VOICE_QA_PYTHON: path.join(tempRoot, "missing-python"),
      ELEVENLABS_API_KEY: "",
      XI_API_KEY: "",
      LOVART_ACCESS_KEY: "",
      LOVART_SECRET_KEY: "",
      XAI_API_KEY: "",
      GROK_DEPLOYMENT_KEY: "",
      BUZZASSIST_MEDIA_TOKEN: "",
      BUZZASSIST_TOKEN: "",
      // R6-F2: 運営者の信頼リスト env は host の起動シェルに置く。setup が生成する
      // MCP 設定には **名前だけ** が載り、この値（sentinel）は一切書かれないこと。
      BUZZASSIST_REVIEWER_TRUST: reviewerTrustSentinel,
      BUZZASSIST_REVIEWER_TRUST_JSON: "",
      BUZZASSIST_KOYA_REVIEWER_TRUST: "",
      BUZZASSIST_KOYA_REVIEWER_TRUST_JSON: "",
    };
    const result = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, "scripts", "setup-agents.mjs"),
        "--agent",
        host,
        "--project-dir",
        projectDir,
        "--skip-install",
        "--skip-build",
        "--no-launch",
        "--allow-harness-not-ready",
      ],
      { cwd: repoRoot, env, encoding: "utf8", timeout: 120_000 },
    );
    assert.equal(result.status, 0, `${host} setup failed:\n${result.stdout}\n${result.stderr}`);
    const label = host === "codex" ? "Codex" : "Claude Code";
    assert.match(result.stdout, new RegExp(`${label}: configured`));
    assert.match(result.stdout, /BUZZASSIST_HOST_RESTART_REQUIRED=yes/);
    assert.match(result.stdout, /BUZZASSIST_HARNESS_READY=(?:no|unknown)/);
    assert.match(result.stdout, /BUZZASSIST_HARNESS_READY_OVERRIDE=diagnostic-only/);
    const otherLabel = host === "codex" ? "Claude Code" : "Codex";
    assert.match(result.stdout, new RegExp(`${otherLabel}: not touched`));

    const pluginRoot = path.join(homeDir, "plugins", "buzzassist", "plugin");
    assert.equal(existsSync(path.join(pluginRoot, "node_modules")), false, "staged plugin must not contain node_modules");
    const manifest = JSON.parse(await readFile(path.join(pluginRoot, host === "codex" ? ".codex-plugin" : ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(manifest.name, "buzzassist");
    const mcpText = await readFile(path.join(pluginRoot, ".mcp.json"), "utf8");
    const mcp = JSON.parse(mcpText);
    const local = mcp.mcpServers.buzzassist_mcp;
    assert.equal(local.env.EXCALIDRAW_PROJECT_DIR, projectDir);
    assert.equal(local.env.EXCALIDRAW_CANVAS_DIR, path.join(projectDir, "canvas"));
    assert.equal(local.command, process.execPath);
    assert.match(local.note, /setup fallback/);
    // R6-F2: 両 host が読む同じ .mcp.json に、reviewer 信頼リスト env の **名前だけ** が
    // Codex の env_vars 形式で載る。値・path・本文はどこにも書かれない（設定ファイルは
    // 配布・同期・plugin cache へコピーされる）。Claude Code は自身の process env を継承する。
    assert.deepEqual(local.env_vars, [
      "BUZZASSIST_REVIEWER_TRUST",
      "BUZZASSIST_REVIEWER_TRUST_JSON",
      "BUZZASSIST_KOYA_REVIEWER_TRUST",
      "BUZZASSIST_KOYA_REVIEWER_TRUST_JSON",
    ]);
    for (const name of local.env_vars) {
      assert.equal(Object.hasOwn(local.env, name), false, `${name} の値が .mcp.json の env に埋め込まれています`);
    }
    assert.equal(mcpText.includes(reviewerTrustSentinel), false, "運営者の信頼リスト path が .mcp.json に書かれています");
    assert.equal(mcpText.includes("reviewer-trust-sentinel"), false);
    assert.match(local.note, /never stores their values/u);
    assert.match(result.stdout, /BUZZASSIST_REVIEWER_TRUST_PASSTHROUGH=env-name-only/u);
    assert.match(result.stdout, /BUZZASSIST_REVIEWER_TRUST_CONFIGURED=yes/u);
    assert.equal(result.stdout.includes(reviewerTrustSentinel), false, "setup 出力に信頼リスト path の値を載せない");
    // 他 host 向け MCP 設定を書く関数も同じ passthrough を通ること（形式が違っても挙動は同じ）。
    for (const otherHostConfig of Object.values(mcp.mcpServers)) {
      if (otherHostConfig.env) {
        for (const key of Object.keys(otherHostConfig.env)) assert.doesNotMatch(key, /REVIEWER_TRUST/u);
      }
    }
    console.log(`R6-F2 verified for ${host}: staged .mcp.json names reviewer trust env vars only (env_vars=${local.env_vars.length}), no trust value embedded.`);
    const installedServer = await readFile(path.join(pluginRoot, "mcp", "server.mjs"), "utf8");
    const installedOpenSkill = await readFile(path.join(pluginRoot, "skills", "excalidraw-open-canvas", "SKILL.md"), "utf8");
    const installedViteConfig = await readFile(path.join(pluginRoot, "vite.config.js"), "utf8");
    assert.match(installedServer, /open_buzzassist_canvas/);
    assert.match(installedServer, /server\.listRoots/);
    assert.match(installedOpenSkill, /current workspace\/project root/);
    assert.match(installedOpenSkill, /<current-project>\/canvas\/assets/);
    assert.match(installedViteConfig, /\/api\/assets\/open-folder/);
    await readFile(path.join(pluginRoot, "lib", "projectContext.mjs"), "utf8");
    await readFile(path.join(pluginRoot, "lib", "koyaHandoffBundle.mjs"), "utf8");
    await readFile(path.join(pluginRoot, "lib", "openLocalFolder.mjs"), "utf8");
    await readFile(path.join(pluginRoot, "lib", "koyaChannelGovernance.mjs"), "utf8");
    const narratedRuntime = await import(
      `${pathToFileURL(path.join(pluginRoot, "lib", "narratedStoryVideo.mjs")).href}?distribution=${host}-${Date.now()}`
    );
    assert.equal(typeof narratedRuntime.inspectNarratedStoryVideoInputs, "function");
    assert.equal(typeof narratedRuntime.runNarratedStoryVideo, "function");
    const narratedFixtureRoot = path.join(tempRoot, "narrated-runtime-fixture");
    const narratedFixturePayload = path.join(narratedFixtureRoot, "payload");
    const narratedFixtureScript = path.join(narratedFixtureRoot, "script.txt");
    const narratedScriptBytes = Buffer.from("これは配布runtime検証用の日本語台本です。\n");
    await mkdir(narratedFixturePayload, { recursive: true });
    await writeFile(narratedFixtureScript, narratedScriptBytes);
    await writeFile(path.join(narratedFixturePayload, "narrated-story.json"), "{}\n");
    const inspectedNarrated = await narratedRuntime.inspectNarratedStoryVideoInputs({
      scriptPath: narratedFixtureScript,
      channelPackDir: narratedFixturePayload,
    });
    assert.equal(inspectedNarrated.script.sha256, createHash("sha256").update(narratedScriptBytes).digest("hex"));
    assert.equal(inspectedNarrated.script.bytes, narratedScriptBytes.length);
    assert.match(inspectedNarrated.channelPack.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(inspectedNarrated.channelPack.fileCount, 1);
    const deploymentRuntime = await import(
      `${pathToFileURL(path.join(pluginRoot, "lib", "harnessDeploymentResolver.mjs")).href}?distribution=${host}-${Date.now()}`
    );
    const narratedDeployment = deploymentRuntime.resolveHarnessDeployment("narrated-story-video", { repoRoot: pluginRoot });
    const narratedCommand = deploymentRuntime.resolveHarnessDeploymentCommand(narratedDeployment, { additionalArgs: ["help"] });
    assert.equal(narratedCommand.entrypointPath, path.join(pluginRoot, "scripts", "narrated-story-video.mjs"));
    const learningRuntime = await import(
      `${pathToFileURL(path.join(pluginRoot, "scripts", "harness-learn.mjs")).href}?distribution=${host}-${Date.now()}`
    );
    const narratedFeedbackLedger = learningRuntime.ledgerPathFor("channel-pack:narrated-story", "proposals");
    const canonicalPluginRoot = await realpath(pluginRoot);
    assert.notEqual(
      path.resolve(narratedFeedbackLedger),
      path.join(canonicalPluginRoot, "docs", "learning", "proposals.jsonl"),
      "narrated operator feedback must never resolve to the shared plugin learning ledger",
    );
    assert.equal(
      path.resolve(narratedFeedbackLedger).startsWith(`${path.join(canonicalPluginRoot, "channel-packs", "narrated-story")}${path.sep}`),
      true,
      `narrated operator feedback ledger escaped its private Channel Pack root: ${narratedFeedbackLedger}`,
    );
    const narratedHelp = spawnSync(narratedCommand.command, narratedCommand.args, {
      cwd: narratedCommand.cwd,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(narratedHelp.status, 0, `staged narrated runner help failed:\n${narratedHelp.stdout}\n${narratedHelp.stderr}`);
    const narratedCli = await import(
      `${pathToFileURL(path.join(pluginRoot, "scripts", "narrated-story-video.mjs")).href}?distribution=${host}-${Date.now()}`
    );
    let installedHelp = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => { installedHelp += String(chunk); return true; };
    try { await narratedCli.main(["help"]); }
    finally { process.stdout.write = originalWrite; }
    assert.match(installedHelp, /Usage: node scripts\/narrated-story-video\.mjs/u);
    // ジャンル共通の契約は配布する。
    await readFile(path.join(pluginRoot, "config", "koya-manga-production-contract.json"), "utf8");

    // Channel Pack は配布しない。このプラグインは PUBLIC な配布物なので、
    // 特定チャンネルの番組名・キャスト・承認記録が入ってはいけない。
    // 以前はこのテストが「配布物に show bible が存在すること」を
    // 要求しており、テスト自体が漏えいを固定していた。
    for (const leaked of [
      path.join(pluginRoot, "config", "koya-show-bible.json"),
      path.join(pluginRoot, "config", "koya-character-styling"),
      path.join(pluginRoot, "channel-packs"),
      path.join(pluginRoot, "docs", "koya-channel-governance-ja.md"),
      path.join(pluginRoot, "docs", "koya-channel-requirements-ledger.md"),
      // 本文つき学習台帳は evidence に顧客識別子・端末 path を含みうる。
      // 配布するのは export-public が作る proposals.public.jsonl だけ。
      path.join(pluginRoot, "docs", "learning", "proposals.jsonl"),
      path.join(pluginRoot, "docs", "learning", "applied.jsonl"),
    ]) {
      assert.equal(
        existsSync(leaked), false,
        `Channel Pack が配布物に含まれています: ${path.relative(pluginRoot, leaked)}`,
      );
    }
    await readFile(path.join(pluginRoot, "docs", "learning", "proposals.public.jsonl"), "utf8");
    await readFile(path.join(pluginRoot, "docs", "koya-harness-handoff-ja.md"), "utf8");

    // 配布は allowlist。config/ 直下に列挙外のものが1つでも入っていたら止める。
    //
    // 以前は denylist で、新しいチャンネル固有ファイルが増えるたびに
    // 除外を人が覚えていないと配布された——秘密の境界が人の記憶に依存する
    // fail-open 設計。実際3件漏れており、うち1件は自分自身に
    // 「クライアント固有なので共有しない」と書いてあった。
    const { DISTRIBUTABLE_CONFIG_ENTRIES, verifyStagedPluginContents } = await import(
      `${pathToFileURL(path.join(repoRoot, "scripts", "setup-agents.mjs")).href}?distribution=${host}-${Date.now()}`
    );
    const staged = await verifyStagedPluginContents(pluginRoot);
    assert.equal(staged.ok, true);
    assert.equal(staged.nodeModulesIncluded, false);
    assert.equal(staged.symlinksIncluded, false);
    const shippedConfig = existsSync(path.join(pluginRoot, "config"))
      ? await readdir(path.join(pluginRoot, "config"))
      : [];
    const unexpected = shippedConfig.filter((name) => !DISTRIBUTABLE_CONFIG_ENTRIES.includes(name));
    assert.deepEqual(unexpected, [], `配布の許可一覧に無いものが config/ に入っています: ${unexpected.join(", ")}`);

    // 運営者固有・チャンネル固有のものが、どの深さにも無いこと。
    for (const forbidden of ["channel-packs", "client-work", ".codex-tmp"]) {
      assert.equal(existsSync(path.join(pluginRoot, forbidden)), false, `配布物に ${forbidden} が入っています`);
    }
    assert.equal(
      existsSync(path.join(pluginRoot, "config", "harness-deployments.json")), false,
      "運営者固有の配置先マップが配布物に入っています",
    );

    // ハーネスの正本スキルがホストの読む位置に在ること。
    // plugin.json の "skills" は ./skills/ を指すので、.agents/skills/ に
    // 同梱されているだけでは1つも有効にならない。実際その状態で配っており、
    // 運営者には MCP は届くのに手順の正本が届いていなかった。
    // 開発機ではリポジトリの .claude/skills アダプタが効くので気づけない。
    const canonicalSkillsRoot = path.join(repoRoot, ".agents", "skills");
    const canonicalSkillNames = (await readdir(canonicalSkillsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && existsSync(path.join(canonicalSkillsRoot, entry.name, "SKILL.md")))
      .map((entry) => entry.name);
    assert.ok(canonicalSkillNames.length > 0, "正本スキルが1つも無い");
    for (const name of canonicalSkillNames) {
      const shipped = path.join(pluginRoot, "skills", name, "SKILL.md");
      assert.equal(existsSync(shipped), true, `正本スキルが配布物のskills/に無い: ${name}`);
    }

    // 配布物の中で、スキルが指すローカル参照が全て解決すること。
    //
    // 以前は SKILL.md の `../` だけを正規表現で拾っていたので、
    // `docs/...` のようなルート相対の参照と、references/ 配下の
    // Markdown を検査していなかった。**配布先には手順名だけが届き、
    // 手順の実体と測定根拠を読めない**状態がそれで残っていた。
    // Channel Pack 側にあるものだけを明示的に除外する。
    const packOnly = /channel-packs\/|koya-channel-requirements-ledger|koya-channel-governance-ja|koya-show-bible|koya-location-bible|koya-thumbnail-contract|koya-character-styling/u;
    for (const name of canonicalSkillNames) {
      const skillDir = path.join(pluginRoot, "skills", name);
      const markdowns = (await readdir(skillDir, { withFileTypes: true, recursive: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => path.join(entry.parentPath ?? entry.path ?? skillDir, entry.name));
      for (const file of markdowns) {
        const body = await readFile(file, "utf8");
        const references = new Set([
          ...(body.match(/\.\.\/[.\/a-zA-Z0-9_-]+/gu) || []),
          // `docs/...` のようにバッククォートで囲まれたルート相対の参照。
          ...[...body.matchAll(/`((?:docs|config|scripts|lib)\/[a-zA-Z0-9_./-]+)`/gu)].map((m) => m[1]),
        ]);
        for (const ref of references) {
          if (packOnly.test(ref)) continue;
          if (ref.includes("*")) continue;
          const resolved = ref.startsWith("..")
            ? path.resolve(path.dirname(file), ref)
            : path.join(pluginRoot, ref);
          assert.equal(
            existsSync(resolved), true,
            `配布物のスキル ${name}（${path.basename(file)}）の参照が解決しません: ${ref}`,
          );
        }
      }
    }
    await readFile(path.join(pluginRoot, "scripts", "update-current.mjs"), "utf8");
    await readFile(path.join(pluginRoot, "scripts", "verify-plugin-runtime.mjs"), "utf8");
    if (process.platform !== "win32") {
      // 登録は偽のスケジューラへ届いていること（本物の launchd / systemd を触らない）。
      const calls = existsSync(schedulerLog) ? await readFile(schedulerLog, "utf8") : "";
      const updateLines = String(result.stdout).split("\n").filter((line) => /update|AUTO_UPDATE/iu.test(line)).join("\n");
      assert.match(calls, process.platform === "darwin" ? /launchctl bootstrap/u : /systemctl/u,
        `自動更新の登録が偽のスケジューラを通っていない（本物を呼んでいる可能性）。setup の出力:\n${updateLines}`);
    }
    const updaterConfig = JSON.parse(await readFile(path.join(homeDir, ".buzzassist", "updater", "config.json"), "utf8"));
    if (process.platform === "win32") {
      assert.equal(updaterConfig.scheduler?.state, "manual", "登録を省略した回を有効と報告しない");
      assert.match(result.stdout, /BUZZASSIST_AUTO_UPDATE=manual/u);
    } else {
      assert.equal(updaterConfig.enabled, true);
      assert.match(result.stdout, /BUZZASSIST_AUTO_UPDATE=enabled/u);
    }
    assert.deepEqual(updaterConfig.hosts, [host]);
    assert.equal(updaterConfig.projectDir, projectDir);
    if (process.platform === "darwin") {
      const plist = await readFile(path.join(homeDir, "Library", "LaunchAgents", "ai.buzzassist.plugin-updater.plist"), "utf8");
      assert.match(plist, /update-current\.mjs/);
    }
    // Windows は登録を省略しているので、runner は書かれない（省略した回の正しい姿）。
    const hostState = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(hostState.installed, true);
    assert.ok(
      !hostState.marketplace || path.resolve(hostState.marketplace).startsWith(`${path.resolve(homeDir)}${path.sep}`),
      `${host} marketplace escaped isolated home: ${hostState.marketplace}`,
    );
    await assertRealCachesExcludeIsolatedPath(tempRoot);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

const realHostBefore = await snapshotRealHostState();
try {
  await runHostSetup("codex");
  await runHostSetup("claude");
} finally {
  const realHostAfter = await snapshotRealHostState();
  assert.deepEqual(
    realHostAfter,
    realHostBefore,
    "distribution tests changed the real Codex/Claude configuration or BuzzAssist plugin cache",
  );
}
console.log("BuzzAssist distribution setup: isolated Codex and Claude Code passed; real host config unchanged and no test path entered real caches.");
