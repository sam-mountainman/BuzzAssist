#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageVersion = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")).version;

function quoteForCmd(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
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

  try {
    const env = {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      BUZZASSIST_SETUP_HOME: homeDir,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      CODEX_COMMAND: host === "codex" ? path.join(binDir, process.platform === "win32" ? "codex.cmd" : "codex") : "",
      CLAUDE_CODE: host === "claude" ? "1" : "",
      CODEX: host === "codex" ? "1" : "",
      BUZZASSIST_AUTO_UPDATE_SKIP_REGISTER: "1",
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
      ],
      { cwd: repoRoot, env, encoding: "utf8", timeout: 120_000 },
    );
    assert.equal(result.status, 0, `${host} setup failed:\n${result.stdout}\n${result.stderr}`);
    const label = host === "codex" ? "Codex" : "Claude Code";
    assert.match(result.stdout, new RegExp(`${label}: configured`));
    assert.match(result.stdout, /BUZZASSIST_HOST_RESTART_REQUIRED=yes/);
    const otherLabel = host === "codex" ? "Claude Code" : "Codex";
    assert.match(result.stdout, new RegExp(`${otherLabel}: not touched`));

    const pluginRoot = path.join(homeDir, "plugins", "buzzassist", "plugin");
    const manifest = JSON.parse(await readFile(path.join(pluginRoot, host === "codex" ? ".codex-plugin" : ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(manifest.name, "buzzassist");
    const mcp = JSON.parse(await readFile(path.join(pluginRoot, ".mcp.json"), "utf8"));
    const local = mcp.mcpServers.buzzassist_mcp;
    assert.equal(local.env.EXCALIDRAW_PROJECT_DIR, projectDir);
    assert.equal(local.env.EXCALIDRAW_CANVAS_DIR, path.join(projectDir, "canvas"));
    assert.equal(local.command, process.execPath);
    assert.match(local.note, /setup fallback/);
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
    ]) {
      assert.equal(
        existsSync(leaked), false,
        `Channel Pack が配布物に含まれています: ${path.relative(pluginRoot, leaked)}`,
      );
    }
    await readFile(path.join(pluginRoot, "docs", "koya-harness-handoff-ja.md"), "utf8");

    // 配布は allowlist。config/ 直下に列挙外のものが1つでも入っていたら止める。
    //
    // 以前は denylist で、新しいチャンネル固有ファイルが増えるたびに
    // 除外を人が覚えていないと配布された——秘密の境界が人の記憶に依存する
    // fail-open 設計。実際3件漏れており、うち1件は自分自身に
    // 「クライアント固有なので共有しない」と書いてあった。
    const { DISTRIBUTABLE_CONFIG_ENTRIES } = await import(pathToFileURL(path.join(repoRoot, "scripts", "setup-agents.mjs")).href)
      .catch(() => ({ DISTRIBUTABLE_CONFIG_ENTRIES: null }));
    if (DISTRIBUTABLE_CONFIG_ENTRIES) {
      const shippedConfig = existsSync(path.join(pluginRoot, "config"))
        ? await readdir(path.join(pluginRoot, "config"))
        : [];
      const unexpected = shippedConfig.filter((name) => !DISTRIBUTABLE_CONFIG_ENTRIES.includes(name));
      assert.deepEqual(unexpected, [], `配布の許可一覧に無いものが config/ に入っています: ${unexpected.join(", ")}`);
    }

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
    const updaterConfig = JSON.parse(await readFile(path.join(homeDir, ".buzzassist", "updater", "config.json"), "utf8"));
    assert.equal(updaterConfig.enabled, true);
    assert.deepEqual(updaterConfig.hosts, [host]);
    assert.equal(updaterConfig.projectDir, projectDir);
    if (process.platform === "darwin") {
      const plist = await readFile(path.join(homeDir, "Library", "LaunchAgents", "ai.buzzassist.plugin-updater.plist"), "utf8");
      assert.match(plist, /update-current\.mjs/);
    }
    if (process.platform === "win32") {
      const runner = await readFile(path.join(homeDir, ".buzzassist", "updater", "run-update.cmd"), "utf8");
      assert.match(runner, /update-current\.mjs/);
    }
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).installed, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await runHostSetup("codex");
await runHostSetup("claude");
console.log("BuzzAssist distribution setup: Codex and Claude Code passed.");
