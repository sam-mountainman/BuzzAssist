#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { resolveCodexCommand } from "./codex-image-bridge.mjs";
import {
  SUPPORTED_SETUP_AGENTS,
  assertSupportedNodeVersion,
  claudeDesktopConfigPathForPlatform,
  commandNameForPlatform,
  detectSetupAgent,
  hostInstallHelp,
  normalizeSetupAgentName,
} from "../lib/setupAgents.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginName = "buzzassist";
const marketplaceName = "buzzassist";
const legacyMarketplaceName = "buzzassist-local";
const personalMarketplaceName = "personal";
const homeDir = resolve(process.env.BUZZASSIST_SETUP_HOME || homedir());
const managedPluginDir = join(homeDir, "plugins", pluginName);
const managedPluginRoot = join(managedPluginDir, "plugin");
const personalMarketplacePath = join(homeDir, ".agents", "plugins", "marketplace.json");
const argv = process.argv.slice(2);
const packageManifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const pluginVersion = packageManifest.version;
const supportedAgents = SUPPORTED_SETUP_AGENTS;
const agentLabels = {
  codex: "Codex",
  "claude-desktop": "Claude Desktop",
  claude: "Claude Code",
  cursor: "Cursor",
  antigravity: "Antigravity",
};

function usage() {
  return `Usage: node scripts/setup-agents.mjs [options]

Options:
  --agent <name>         Configure one host: codex, claude-desktop, claude, cursor, antigravity.
  --host <name>          Alias for --agent.
  --all-agents           Configure all supported hosts. Not used by default.
  --project-dir <path>   Project whose canvas/ directory should store state.
  --canvas-dir <path>    Override canvas data directory.
  --dry-run              Print commands without changing host config.
  --skip-install         Do not run npm install.
  --skip-build           Do not run npm run build.
  --skip-plugin-source   Do not refresh ~/plugins/buzzassist.
  --no-launch            Do not start the canvas service.
  --tunnel               Start a Canvas Tunnel after setup for phone access to the same full Excalidraw UI (Cloudflare by default).
  --ngrok-authtoken <token>
                         Opt into ngrok instead of Cloudflare and configure it. Also reads BUZZASSIST_NGROK_AUTHTOKEN or NGROK_AUTHTOKEN.
  --help                 Show this message.
`;
}

function readArg(name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function hasArg(name) {
  return argv.includes(name);
}

function resolveTargetAgents() {
  if (hasArg("--all-agents")) return [...supportedAgents];
  const explicit = readArg("--agent", readArg("--host", null));
  return [normalizeSetupAgentName(explicit) || detectSetupAgent({ env: process.env, argv: process.argv })];
}

if (hasArg("--help") || hasArg("-h")) {
  console.log(usage());
  process.exit(0);
}

const dryRun = hasArg("--dry-run");
const skipInstall = hasArg("--skip-install");
const skipBuild = hasArg("--skip-build");
const skipPluginSource = hasArg("--skip-plugin-source");
const launchCanvas = !hasArg("--no-launch");
const launchTunnel = hasArg("--tunnel") && launchCanvas;
const targetAgents = resolveTargetAgents();
const projectDir = resolve(
  readArg("--project-dir", process.env.BUZZASSIST_PROJECT_DIR || process.env.EXCALIDRAW_PROJECT_DIR || process.cwd()),
);
const canvasDir = resolve(readArg("--canvas-dir", process.env.EXCALIDRAW_CANVAS_DIR || join(projectDir, "canvas")));
const ngrokAuthtoken = readArg("--ngrok-authtoken", process.env.BUZZASSIST_NGROK_AUTHTOKEN || process.env.NGROK_AUTHTOKEN || "");

function commandName(name) {
  return commandNameForPlatform(name);
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function formatCommand(command, args) {
  return [command, ...args].map(shellQuote).join(" ");
}

function logStep(message) {
  console.log(`\n==> ${message}`);
}

function logCommand(command, args) {
  console.log(`$ ${formatCommand(command, args)}`);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function run(command, args, options = {}) {
  const {
    cwd = repoRoot,
    env = process.env,
    inherit = false,
    allowFailure = false,
    timeoutMs = 0,
    log = true,
    silent = false,
  } = options;

  if (dryRun) {
    if (log) logCommand(command, args);
    return { ok: true, code: 0, stdout: "", stderr: "" };
  }

  if (log) logCommand(command, args);
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env,
      // Windows requires a command shell for .cmd/.bat launchers (npm,
      // Claude Code), but using one for node.exe or absolute app binaries
      // breaks paths containing spaces and weakens argument escaping.
      shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs) : null;

    if (!inherit) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }

    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      const result = { ok: false, code: null, stdout, stderr, error };
      if (allowFailure) resolveRun(result);
      else rejectRun(error);
    });

    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      const ok = code === 0;
      if (!inherit && !silent && stdout.trim()) console.log(stdout.trim());
      if (!inherit && !silent && stderr.trim()) console.error(stderr.trim());
      const result = { ok, code, stdout, stderr, timedOut };
      if (ok || allowFailure) resolveRun(result);
      else rejectRun(new Error(timedOut ? `${formatCommand(command, args)} timed out` : `${formatCommand(command, args)} exited with ${code}`));
    });
  });
}

async function commandAvailable(command) {
  if (dryRun) return true;
  const result = await run(command, ["--version"], { allowFailure: true });
  return result.ok || result.code !== null;
}

function includesConfiguredMarketplace(output) {
  return output.includes(marketplaceName) || output.includes(repoRoot);
}

function installedPluginVersion(output, selector) {
  const index = output.indexOf(selector);
  if (index < 0) return null;
  const nextBlock = output.indexOf("\n\n", index);
  const block = output.slice(index, nextBlock >= 0 ? nextBlock : output.length);
  return block.match(/Version:\s*([^\s]+)/)?.[1] ?? "";
}

function pluginNeedsRefresh(output, selector) {
  const installedVersion = installedPluginVersion(output, selector);
  return installedVersion !== null && installedVersion !== pluginVersion;
}

async function ensureDependencies() {
  if (skipInstall) {
    console.log("Skipping npm install.");
    return;
  }

  const dependencyMarker = join(repoRoot, "node_modules", "@excalidraw", "excalidraw", "package.json");
  if (await pathExists(dependencyMarker)) {
    console.log("npm dependencies are already present.");
    return;
  }

  logStep("Installing npm dependencies");
  await run(commandName("npm"), ["install"], { inherit: true });
}

async function ensureBuild() {
  if (skipBuild) {
    console.log("Skipping npm run build.");
    return;
  }

  if (await pathExists(join(repoRoot, "dist", "index.html"))) {
    console.log("Canvas build already exists.");
    return;
  }

  logStep("Building the static canvas UI");
  await run(commandName("npm"), ["run", "build"], { inherit: true });
}

async function ensureWidgetBuild() {
  if (!targetIncludesWidgetHost()) return;
  if (skipBuild) {
    console.log("Skipping npm run build:widget.");
    return;
  }

  if (await pathExists(join(repoRoot, "dist-widget", "index.html"))) {
    console.log("Widget build already exists.");
    return;
  }

  logStep("Building the native widget UI");
  await run(commandName("npm"), ["run", "build:widget"], { inherit: true });
}

async function copyIfExists(source, target) {
  if (!(await pathExists(source))) return;
  await cp(source, target, { recursive: true, force: true, dereference: false });
}

async function refreshManagedPluginSource() {
  if (skipPluginSource) {
    console.log(`Skipping managed plugin source refresh: ${managedPluginDir}`);
    return managedPluginRoot;
  }

  logStep("Refreshing local plugin source");
  if (dryRun) {
    console.log(`Would refresh ${managedPluginRoot} from ${repoRoot}`);
    return managedPluginRoot;
  }

  const tmpDir = `${managedPluginDir}.tmp-${process.pid}`;
  const tmpPluginRoot = join(tmpDir, "plugin");
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpPluginRoot, { recursive: true });

  for (const dirName of [
    "assets",
    "dist",
    "dist-widget",
    "lib",
    "mcp",
    "scripts",
    "skills",
    ".codex-plugin",
    ".claude-plugin",
    ".antigravity-plugin",
    ".cursor",
    ".agents",
  ]) {
    await copyIfExists(join(repoRoot, dirName), join(tmpPluginRoot, dirName));
  }

  for (const fileName of [
    ".mcp.json",
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    "README.md",
    "SETUP.md",
    "package.json",
    "package-lock.json",
    "vite.config.js",
  ]) {
    await copyIfExists(join(repoRoot, fileName), join(tmpPluginRoot, fileName));
  }

  await writeJson(join(tmpDir, ".claude-plugin", "marketplace.json"), {
    $schema: "https://anthropic.com/claude-code/marketplace.schema.json",
    name: marketplaceName,
    description: "BuzzAssist canvas and media plugin for AI coding agents.",
    owner: { name: "higataiyu" },
    metadata: {
      description: "A project-local Excalidraw canvas, shared skills, and MCP-backed plugin tools for visual media workflows.",
    },
    plugins: [
      {
        name: pluginName,
        version: pluginVersion,
        source: "./plugin",
        description: "BuzzAssist canvas and media plugin tools.",
        author: { name: "higataiyu" },
        category: "productivity",
      },
    ],
  });
  // The marketplace lives at ~/plugins/buzzassist; the plugin root should only
  // contain plugin metadata so Claude Code installs it as a plugin, not as a
  // nested marketplace.
  await rm(join(tmpPluginRoot, ".claude-plugin", "marketplace.json"), { force: true });
  await writeJson(join(tmpDir, ".agents", "plugins", "marketplace.json"), {
    name: marketplaceName,
    interface: { displayName: "BuzzAssist" },
    plugins: [
      {
        name: pluginName,
        source: { source: "local", path: "./plugin" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      },
    ],
  });

  await writeJson(join(tmpPluginRoot, ".mcp.json"), {
    mcpServers: {
      excalidraw_official: {
        type: "http",
        url: "https://mcp.excalidraw.com/mcp",
        note: "Official open-source Excalidraw MCP App from excalidraw/excalidraw-mcp. Use for prompt-to-diagram Excalidraw generation and interactive MCP App rendering.",
      },
      buzzassist_mcp: {
        title: "BuzzAssist Local Canvas MCP",
        description: "Start and control the project-local BuzzAssist Excalidraw canvas.",
        command: process.execPath,
        args: [join(managedPluginRoot, "scripts", "start-mcp.mjs")],
        cwd: managedPluginRoot,
        env: {
          NODE_PATH: join(repoRoot, "node_modules"),
          EXCALIDRAW_ALLOW_WIDGET_ORIGINS: "1",
          EXCALIDRAW_PROJECT_DIR: projectDir,
          EXCALIDRAW_CANVAS_DIR: canvasDir,
        },
        note: "Primary local MCP server. It auto-starts the local canvas server and writes canvas/.server.json with the local canvas URL.",
      },
    },
  });

  await rm(join(tmpPluginRoot, "node_modules"), { recursive: true, force: true });
  if (await pathExists(join(repoRoot, "node_modules"))) {
    await symlink(join(repoRoot, "node_modules"), join(tmpPluginRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  }
  await rm(join(tmpPluginRoot, "canvas"), { recursive: true, force: true });
  await rm(managedPluginDir, { recursive: true, force: true });
  await mkdir(dirname(managedPluginDir), { recursive: true });
  await rename(tmpDir, managedPluginDir);
  return managedPluginRoot;
}

async function removeCodexPersonalMarketplaceEntry() {
  const marketplace = await readJson(personalMarketplacePath, null);
  if (!marketplace || !Array.isArray(marketplace.plugins)) return;
  const plugins = marketplace.plugins.filter((plugin) => plugin?.name !== pluginName);
  if (plugins.length === marketplace.plugins.length) return;

  if (dryRun) {
    console.log(`Would remove ${pluginName} from ${personalMarketplacePath}`);
    return;
  }

  marketplace.plugins = plugins;
  await writeJson(personalMarketplacePath, marketplace);
}

async function setupCodexMarketplace(codex) {
  logStep("Configuring Codex marketplace");
  const entry = {
    name: pluginName,
    source: {
      source: "local",
      path: "./plugin",
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Productivity",
  };

  if (dryRun) {
    console.log(`Would register ${managedPluginDir} as the ${marketplaceName} marketplace`);
    return;
  }

  const localMarketplacePath = join(managedPluginDir, ".agents", "plugins", "marketplace.json");
  const marketplace = await readJson(localMarketplacePath, {
    name: marketplaceName,
    interface: { displayName: "BuzzAssist" },
    plugins: [],
  });
  marketplace.name = marketplaceName;
  marketplace.interface ||= { displayName: "BuzzAssist" };
  marketplace.interface.displayName = "BuzzAssist";
  marketplace.plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];

  const index = marketplace.plugins.findIndex((plugin) => plugin?.name === pluginName);
  if (index >= 0) marketplace.plugins[index] = entry;
  else marketplace.plugins.push(entry);

  await writeJson(localMarketplacePath, marketplace);

  const added = await run(codex, ["plugin", "marketplace", "add", managedPluginDir], { allowFailure: true });
  if (!added.ok) {
    console.warn("Codex marketplace add did not complete. Continuing to plugin install in case it is already configured.");
  }
}

async function cleanupLegacyCodex(codex) {
  const listed = await run(codex, ["plugin", "list"], { allowFailure: true, log: false, silent: true });
  if (listed.stdout.includes(`${pluginName}@${personalMarketplaceName}`)) {
    await run(codex, ["plugin", "remove", `${pluginName}@${personalMarketplaceName}`], { allowFailure: true });
  }
  if (listed.stdout.includes(`${pluginName}@${legacyMarketplaceName}`)) {
    await run(codex, ["plugin", "remove", `${pluginName}@${legacyMarketplaceName}`], { allowFailure: true });
  }

  await removeCodexPersonalMarketplaceEntry();

  const marketplaces = await run(codex, ["plugin", "marketplace", "list"], { allowFailure: true, log: false, silent: true });
  if (marketplaces.stdout.includes(legacyMarketplaceName)) {
    await run(codex, ["plugin", "marketplace", "remove", legacyMarketplaceName], { allowFailure: true });
  }
}

async function setupCodex(pluginDir) {
  logStep("Configuring Codex");
  let codex;
  try {
    codex = dryRun ? commandName("codex") : await resolveCodexCommand();
  } catch {
    console.warn(hostInstallHelp("codex"));
    console.warn("ChatGPTデスクトップアプリまたはCodex CLIが見つかりません。インストール後に次を実行してください:");
    console.warn(`  ${formatCommand("codex", ["plugin", "marketplace", "add", managedPluginDir])}`);
    console.warn(`  ${formatCommand("codex", ["plugin", "add", `${pluginName}@${marketplaceName}`])}`);
    return { ok: false, skipped: true };
  }

  await cleanupLegacyCodex(codex);
  await setupCodexMarketplace(codex);

  const current = await run(codex, ["plugin", "list"], { allowFailure: true, log: false, silent: true });
  const codexSelector = `${pluginName}@${marketplaceName}`;
  const codexInstalled = current.stdout.includes(codexSelector);
  if (pluginNeedsRefresh(current.stdout, codexSelector) || (codexInstalled && !skipPluginSource)) {
    await run(codex, ["plugin", "remove", codexSelector], { allowFailure: true });
  }

  const installed = await run(codex, ["plugin", "add", codexSelector], { allowFailure: true });
  if (!installed.ok) {
    console.warn("Codex plugin install did not complete. Check the Codex CLI output above.");
    return { ok: false };
  }
  if (dryRun) return { ok: true, dryRun: true };
  const verified = await run(codex, ["plugin", "list"], { allowFailure: true, log: false, silent: true });
  const ok = verified.ok && verified.stdout.includes(codexSelector);
  if (!ok) console.warn(`Codex did not report ${codexSelector} as installed after setup.`);
  return { ok };
}

async function cleanupLegacyClaude(claude) {
  const listed = await run(claude, ["plugin", "list"], { allowFailure: true, log: false, silent: true });
  if (listed.stdout.includes(`${pluginName}@${legacyMarketplaceName}`)) {
    await run(claude, ["plugin", "uninstall", `${pluginName}@${legacyMarketplaceName}`, "--scope", "user", "-y"], {
      allowFailure: true,
      timeoutMs: 180000,
    });
  }

  const marketplaces = await run(claude, ["plugin", "marketplace", "list"], { allowFailure: true, log: false, silent: true });
  if (marketplaces.stdout.includes(legacyMarketplaceName)) {
    await run(claude, ["plugin", "marketplace", "remove", legacyMarketplaceName, "--scope", "user"], { allowFailure: true });
  }
}

async function setupClaude(pluginDir) {
  logStep("Configuring Claude Code");
  const claude = commandName("claude");
  if (!(await commandAvailable(claude))) {
    console.warn(hostInstallHelp("claude"));
    console.warn("Claude Code CLI was not found. Run these commands after installing Claude Code:");
    console.warn(`  ${formatCommand("claude", ["plugin", "marketplace", "add", managedPluginDir, "--scope", "user"])}`);
    console.warn(`  ${formatCommand("claude", ["plugin", "install", `${pluginName}@${marketplaceName}`, "--scope", "user"])}`);
    return { ok: false, skipped: true };
  }

  await cleanupLegacyClaude(claude);

  const added = await run(claude, ["plugin", "marketplace", "add", managedPluginDir, "--scope", "user"], { allowFailure: true });
  if (!added.ok) {
    console.warn("Claude Code marketplace add did not complete. Continuing to plugin install in case it is already configured.");
  }

  const current = await run(claude, ["plugin", "list"], { allowFailure: true, log: false, silent: true });
  const claudeSelector = `${pluginName}@${marketplaceName}`;
  const claudeInstalled = current.stdout.includes(claudeSelector);
  if (pluginNeedsRefresh(current.stdout, claudeSelector) || (claudeInstalled && !skipPluginSource)) {
    await run(claude, ["plugin", "uninstall", claudeSelector, "--scope", "user", "-y"], {
      allowFailure: true,
      timeoutMs: 180000,
    });
  }

  const installed = await run(claude, ["plugin", "install", claudeSelector, "--scope", "user"], {
    allowFailure: true,
    timeoutMs: 180000,
  });
  if (!installed.ok) {
    console.warn(installed.timedOut
      ? "Claude Code plugin install timed out. Check the Claude Code CLI output above."
      : "Claude Code plugin install did not complete. Check the Claude Code CLI output above.");
    return { ok: false };
  }
  if (dryRun) return { ok: true, dryRun: true };
  const verified = await run(claude, ["plugin", "list"], { allowFailure: true, log: false, silent: true });
  const ok = verified.ok && verified.stdout.includes(claudeSelector);
  if (!ok) console.warn(`Claude Code did not report ${claudeSelector} as installed after setup.`);
  return { ok };
}

function localMcpServerConfig(pluginDir, { cursor = false } = {}) {
  const config = {
    command: process.execPath,
    args: [join(pluginDir, "scripts", "start-mcp.mjs")],
    env: {
      EXCALIDRAW_ALLOW_WIDGET_ORIGINS: "1",
      EXCALIDRAW_PROJECT_DIR: projectDir,
      EXCALIDRAW_CANVAS_DIR: canvasDir,
    },
  };
  if (cursor) config.type = "stdio";
  return config;
}

function claudeDesktopConfigPath() {
  return claudeDesktopConfigPathForPlatform({ homeDir, env: process.env });
}

async function setupClaudeDesktop(pluginDir) {
  logStep("Configuring Claude Desktop");
  const configPath = claudeDesktopConfigPath();
  const config = await readJson(configPath, {});
  config.mcpServers = config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};
  config.mcpServers[pluginName] = localMcpServerConfig(pluginDir);

  if (dryRun) console.log(`Would write ${configPath}`);
  else await writeJson(configPath, config);

  console.log("Claude Desktop config was written. The native widget entrypoint is experimental; use the local canvas URL for normal work.");
  return { ok: true, configPath };
}

function cursorRuleContent() {
  return `---
description: BuzzAssist setup and canvas usage
alwaysApply: true
---

# BuzzAssist

When the user gives this repository URL and asks to set it up, clone or open the repository and run:

\`\`\`bash
node scripts/setup-agents.mjs --agent cursor --project-dir <active-user-project-dir>
\`\`\`

Configure Cursor only. Do not configure Codex, Claude Code, or Antigravity unless the user explicitly asks for those hosts too.

After the script prints \`BUZZASSIST_CANVAS_URL=...\` and \`BUZZASSIST_CANVAS_CHECK=ok\`, open that URL in Cursor's in-app browser or browser preview if available. If browser control is unavailable, report the URL and say setup completed because the canvas check passed.

If the user wants phone/mobile access or the exact same Excalidraw UI outside this machine, run setup with \`--tunnel\` or run \`npm run tunnel:start -- --project-dir <active-user-project-dir>\`. The tunnel uses Cloudflare (\`cloudflared\`) by default — no account needed. If it is not installed, tell the user to install it with \`brew install cloudflared\` on macOS or \`winget install Cloudflare.cloudflared\` on Windows. Give the printed \`BUZZASSIST_TUNNEL_ACCESS_URL\` for the phone.
`;
}

function antigravityRuleBlock() {
  return `# BuzzAssist Agent Setup

When the user gives this repository URL and asks to set it up, do the setup end to end for Antigravity only.

1. Clone or open this repository.
2. Run \`node scripts/setup-agents.mjs --agent antigravity --project-dir <active-user-project-dir>\` from the repository root. If there is no separate active project, use this repository root as the project dir.
3. The script must configure Antigravity only. Do not configure Codex, Claude Code, or Cursor unless the user explicitly asks for those hosts too.
4. After the script prints \`BUZZASSIST_CANVAS_URL=...\` and \`BUZZASSIST_CANVAS_CHECK=ok\`, open that URL in Antigravity's in-app browser if available. If browser control is unavailable, report the URL and say that setup still completed because the canvas check passed.
5. If the user wants phone/mobile access or says they want the exact same Excalidraw UI outside the machine, use Canvas Tunnel: run setup with \`--tunnel\` or run \`npm run tunnel:start -- --project-dir <active-user-project-dir>\`. The tunnel uses Cloudflare (\`cloudflared\`) by default — no account needed. If it is not installed, tell the user to install it with \`brew install cloudflared\` on macOS or \`winget install Cloudflare.cloudflared\` on Windows. Give the printed \`BUZZASSIST_TUNNEL_ACCESS_URL\` for the phone.

Manual fallback:

\`\`\`bash
node scripts/setup-agents.mjs --agent antigravity --project-dir <active-user-project-dir> --no-launch
node scripts/serve-canvas.mjs <active-user-project-dir>
npm run tunnel:start -- --project-dir <active-user-project-dir>
\`\`\`

Use the live URL from \`canvas/.server.json\` when a requested port is busy.
`;
}

async function upsertManagedBlock(path, marker, body) {
  const start = `<!-- ${marker}:START -->`;
  const end = `<!-- ${marker}:END -->`;
  const block = `${start}\n${body.trim()}\n${end}\n`;

  if (dryRun) {
    console.log(`Would update ${path}`);
    return;
  }

  let current = "";
  if (await pathExists(path)) current = await readFile(path, "utf8");

  const startIndex = current.indexOf(start);
  const endIndex = current.indexOf(end);
  let next;
  if (startIndex >= 0 && endIndex > startIndex) {
    next = `${current.slice(0, startIndex)}${block}${current.slice(endIndex + end.length).replace(/^\n/, "")}`;
  } else {
    const prefix = current.trimEnd();
    next = `${prefix}${prefix ? "\n\n" : ""}${block}`;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next);
}

async function setupCursor(pluginDir) {
  logStep("Configuring Cursor");
  const configPath = join(projectDir, ".cursor", "mcp.json");
  const config = await readJson(configPath, {});
  config.mcpServers = config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};
  config.mcpServers[pluginName] = localMcpServerConfig(pluginDir, { cursor: true });

  if (dryRun) console.log(`Would write ${configPath}`);
  else await writeJson(configPath, config);

  const rulePath = join(projectDir, ".cursor", "rules", "buzzassist.mdc");
  if (dryRun) console.log(`Would write ${rulePath}`);
  else {
    await mkdir(dirname(rulePath), { recursive: true });
    await writeFile(rulePath, cursorRuleContent());
  }

  return { ok: true, configPath, rulePath };
}

async function setupAntigravity(pluginDir) {
  logStep("Configuring Antigravity");
  const configPath = join(projectDir, ".agents", "mcp_config.json");
  const config = await readJson(configPath, {});
  config.mcpServers = config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};
  config.mcpServers[pluginName] = localMcpServerConfig(pluginDir);

  if (dryRun) console.log(`Would write ${configPath}`);
  else await writeJson(configPath, config);

  const rulePath = join(projectDir, "GEMINI.md");
  await upsertManagedBlock(rulePath, "BUZZASSIST", antigravityRuleBlock());

  return { ok: true, configPath, rulePath };
}

async function setupAgent(agent, pluginDir) {
  if (agent === "codex") return setupCodex(pluginDir);
  if (agent === "claude-desktop") return setupClaudeDesktop(pluginDir);
  if (agent === "claude") return setupClaude(pluginDir);
  if (agent === "cursor") return setupCursor(pluginDir);
  if (agent === "antigravity") return setupAntigravity(pluginDir);
  throw new Error(`Unsupported agent "${agent}".`);
}

function targetIncludesWidgetHost() {
  return targetAgents.includes("claude-desktop");
}

function targetIncludesLocalBrowserHost() {
  return targetAgents.some((agent) => ["codex", "claude", "cursor", "antigravity"].includes(agent));
}

async function readDiscovery() {
  try {
    return JSON.parse(await readFile(join(canvasDir, ".server.json"), "utf8"));
  } catch {
    return null;
  }
}

async function isReachable(url) {
  if (!url || dryRun) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyCanvasDiscovery(discovery) {
  if (!discovery?.url) return { ok: false, checks: [] };
  const checks = [
    { name: "canvas", url: discovery.url, ok: await isReachable(discovery.url) },
  ];
  if (discovery.mcpUrl) {
    checks.push({ name: "mcp", url: discovery.mcpUrl, ok: await isReachable(discovery.mcpUrl) });
  }
  return { ok: checks.every((check) => check.ok), checks };
}

async function launchCanvasServer() {
  logStep("Starting the BuzzAssist canvas");
  await mkdir(canvasDir, { recursive: true });

  const existing = await readDiscovery();
  if (existing?.url && (await isReachable(existing.url))) {
    console.log(`Using existing canvas server: ${existing.url}`);
    return existing;
  }

  const command = process.execPath;
  const args = [join(repoRoot, "scripts", "serve-canvas.mjs"), projectDir];
  if (dryRun) {
    logCommand(command, args);
    return {
      url: "http://127.0.0.1:43219/",
      mcpUrl: "http://127.0.0.1:43219/mcp",
      canvasDir,
      projectDir,
      dryRun: true,
    };
  }

  const child = spawn(command, args, {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      EXCALIDRAW_ALLOW_WIDGET_ORIGINS: "1",
      EXCALIDRAW_PROJECT_DIR: projectDir,
      EXCALIDRAW_CANVAS_DIR: canvasDir,
    },
  });
  child.unref();

  for (let attempt = 0; attempt < 45; attempt += 1) {
    await sleep(1000);
    const discovery = await readDiscovery();
    if (discovery?.url && (await isReachable(discovery.url))) {
      console.log(`Started canvas server: ${discovery.url}`);
      return discovery;
    }
  }

  throw new Error(`Canvas server did not become reachable. Check ${join(canvasDir, ".server.json")} or run node scripts/serve-canvas.mjs ${shellQuote(projectDir)} manually.`);
}

async function launchCanvasTunnel() {
  logStep("Starting the BuzzAssist Canvas Tunnel");
  await mkdir(canvasDir, { recursive: true });

  const args = [
    join(repoRoot, "scripts", "canvas-tunnel.mjs"),
    "start",
    "--project-dir",
    projectDir,
    "--canvas-dir",
    canvasDir,
    "--restart",
  ];
  // Default provider is Cloudflare (no bandwidth cap, no account). Passing an
  // ngrok authtoken opts into ngrok explicitly.
  if (ngrokAuthtoken) args.push("--provider", "ngrok", "--ngrok-authtoken", ngrokAuthtoken);

  if (dryRun) {
    logCommand(process.execPath, args);
    return {
      ok: true,
      publicUrl: "https://example.ngrok-free.dev",
      accessUrl: "https://example.ngrok-free.dev/?t=<generated>",
      localBaseUrl: "http://127.0.0.1:43219",
      user: "buzzassist",
      password: "<generated>",
      dryRun: true,
    };
  }

  await run(process.execPath, args, { timeoutMs: 75_000 });
  const status = await readJson(join(canvasDir, ".canvas-tunnel.json"), null);
  if (!status?.ok || !status.publicUrl) {
    throw new Error(`Canvas Tunnel did not report a public URL. Check ${join(canvasDir, ".canvas-tunnel.log")}.`);
  }
  return status;
}

async function main() {
  assertSupportedNodeVersion();
  console.log("BuzzAssist setup");
  console.log(`Repository: ${repoRoot}`);
  console.log(`Project dir: ${projectDir}`);
  console.log(`Canvas dir: ${canvasDir}`);
  console.log(`Plugin source: ${managedPluginDir}`);
  console.log(`Agent target: ${targetAgents.map((agent) => agentLabels[agent]).join(", ")}`);

  await ensureDependencies();
  await ensureBuild();
  await ensureWidgetBuild();
  const pluginDir = await refreshManagedPluginSource();

  const results = {};
  for (const agent of targetAgents) {
    results[agent] = await setupAgent(agent, pluginDir);
  }

  const tunnelStatus = launchTunnel ? await launchCanvasTunnel() : null;
  const discovery = launchCanvas
    ? (launchTunnel
        ? (await readDiscovery()) || {
            url: tunnelStatus.localBaseUrl.endsWith("/") ? tunnelStatus.localBaseUrl : `${tunnelStatus.localBaseUrl}/`,
            canvasDir,
            projectDir,
          }
        : await launchCanvasServer())
    : null;
  const canvasCheck = discovery ? await verifyCanvasDiscovery(discovery) : null;

  logStep("Setup summary");
  for (const agent of supportedAgents) {
    const result = results[agent];
    const label = agentLabels[agent];
    if (!result) {
      console.log(`${label}: not touched`);
      continue;
    }
    console.log(`${label}: ${result.ok ? "configured" : result.skipped ? "skipped" : "needs attention"}`);
  }
  if (!hasArg("--all-agents")) {
    console.log("Other agents were intentionally left untouched. Use --all-agents only when the user explicitly asks for every host.");
  }
  if (targetAgents.some((agent) => agent === "codex" || agent === "claude")) {
    console.log("BUZZASSIST_HOST_RESTART_REQUIRED=yes");
    console.log("Start a new Codex task or Claude Code session after setup so the newly installed skills and MCP tools are loaded.");
  }
  if (targetIncludesWidgetHost()) {
    console.log("BUZZASSIST_WIDGET_TOOL=render_buzzassist_canvas_widget");
    console.log("Native widget is experimental. Use BUZZASSIST_CANVAS_URL for normal desktop work unless the user explicitly asks to test the widget.");
  }
  if (discovery?.url) {
    console.log(`BUZZASSIST_CANVAS_URL=${discovery.url}`);
    console.log(`BUZZASSIST_CANVAS_CHECK=${canvasCheck?.ok ? "ok" : "needs-attention"}`);
    console.log(`BUZZASSIST_CANVAS_DISCOVERY=${join(canvasDir, ".server.json")}`);
    if (targetIncludesLocalBrowserHost()) {
      console.log("For Codex, Claude Code, Cursor, or Antigravity, open BUZZASSIST_CANVAS_URL in the host in-app browser. Do not use the OS/default browser unless the user explicitly asks.");
    }
  }
  if (tunnelStatus?.publicUrl) {
    console.log(`BUZZASSIST_TUNNEL_URL=${tunnelStatus.publicUrl}`);
    if (tunnelStatus.accessUrl) console.log(`BUZZASSIST_TUNNEL_ACCESS_URL=${tunnelStatus.accessUrl}`);
    if (tunnelStatus.basicAuth) {
      console.log(`BUZZASSIST_TUNNEL_USER=${tunnelStatus.user}`);
      console.log(`BUZZASSIST_TUNNEL_PASSWORD=${tunnelStatus.password}`);
    }
    console.log(`BUZZASSIST_TUNNEL_CHECK=${tunnelStatus.ok ? "ok" : "needs-attention"}`);
    console.log("Open BUZZASSIST_TUNNEL_ACCESS_URL on the phone to use the same full Excalidraw canvas UI. Basic Auth is only needed when the tunnel was started with --basic-auth.");
  }

  const failedAgents = targetAgents.filter((agent) => !results[agent]?.ok);
  if (failedAgents.length > 0) {
    throw new Error(
      `BuzzAssist host setup did not complete for: ${failedAgents.map((agent) => agentLabels[agent]).join(", ")}. ` +
        "Install or update the host shown above, then rerun the same setup command.",
    );
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
