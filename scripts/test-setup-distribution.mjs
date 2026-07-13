#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    await readFile(path.join(pluginRoot, "lib", "openLocalFolder.mjs"), "utf8");
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).installed, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await runHostSetup("codex");
await runHostSetup("claude");
console.log("BuzzAssist distribution setup: Codex and Claude Code passed.");
