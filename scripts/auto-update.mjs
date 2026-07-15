#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  BUZZASSIST_REPOSITORY,
  BUZZASSIST_UPDATE_LABEL,
  BUZZASSIST_WINDOWS_TASK,
  mergeUpdaterConfig,
  normalizeUpdateHosts,
  renderLaunchAgentPlist,
  renderWindowsUpdateRunner,
  updaterPaths,
} from "../lib/pluginAutoUpdate.mjs";

const argv = process.argv.slice(2);
const action = argv.find((value) => !value.startsWith("-")) || "status";
const homeDir = resolve(process.env.BUZZASSIST_SETUP_HOME || homedir());
const paths = updaterPaths(homeDir);
const skipRegister = /^(1|true|yes)$/i.test(String(process.env.BUZZASSIST_AUTO_UPDATE_SKIP_REGISTER || ""));

function readArg(name, fallback = "") {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path, fallback = null) {
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

async function run(command, args, { allowFailure = false, inherit = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    if (!inherit) {
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
    }
    child.on("error", (error) => {
      if (allowFailure) resolveRun({ ok: false, code: null, stdout, stderr, error });
      else rejectRun(error);
    });
    child.on("close", (code) => {
      const result = { ok: code === 0, code, stdout, stderr };
      if (result.ok || allowFailure) resolveRun(result);
      else rejectRun(new Error(`${command} exited with ${code}: ${stderr || stdout}`));
    });
  });
}

async function registerMacSchedule(plistPath) {
  if (skipRegister) return;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) throw new Error("Cannot determine the current macOS user id for launchd.");
  await run("launchctl", ["bootout", `gui/${uid}`, plistPath], { allowFailure: true });
  const result = await run("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { allowFailure: true });
  if (!result.ok) throw new Error(`launchd registration failed: ${result.stderr || result.stdout}`);
}

async function unregisterMacSchedule(plistPath) {
  if (!skipRegister && await pathExists(plistPath)) {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid !== null) await run("launchctl", ["bootout", `gui/${uid}`, plistPath], { allowFailure: true });
  }
  await rm(plistPath, { force: true });
}

async function registerWindowsSchedule(runnerPath) {
  if (skipRegister) return;
  const result = await run("schtasks.exe", [
    "/Create", "/F", "/SC", "DAILY", "/ST", "03:17",
    "/TN", BUZZASSIST_WINDOWS_TASK,
    "/TR", runnerPath,
  ], { allowFailure: true });
  if (!result.ok) throw new Error(`Windows Task Scheduler registration failed: ${result.stderr || result.stdout}`);
}

async function unregisterWindowsSchedule() {
  if (!skipRegister) {
    await run("schtasks.exe", ["/Delete", "/F", "/TN", BUZZASSIST_WINDOWS_TASK], { allowFailure: true });
  }
  await rm(paths.windowsRunnerPath, { force: true });
}

async function install() {
  const managedMarketplaceDir = resolve(readArg("--marketplace-dir", join(homeDir, "plugins", "buzzassist")));
  const pluginRoot = resolve(readArg("--plugin-root", join(managedMarketplaceDir, "plugin")));
  const updaterPath = join(pluginRoot, "scripts", "update-current.mjs");
  if (!(await pathExists(updaterPath))) {
    throw new Error(`Updater is missing from the installed plugin: ${updaterPath}`);
  }

  const existing = await readJson(paths.configPath, {});
  const hosts = normalizeUpdateHosts(readArg("--agent", readArg("--hosts", "")));
  if (hosts.length === 0) throw new Error("At least one auto-update host is required: codex or claude.");
  const projectDir = resolve(readArg("--project-dir", existing.projectDir || process.cwd()));
  const canvasDir = resolve(readArg("--canvas-dir", existing.canvasDir || join(projectDir, "canvas")));
  const config = mergeUpdaterConfig(existing, {
    enabled: true,
    repository: readArg("--repository", existing.repository || BUZZASSIST_REPOSITORY),
    hosts,
    pluginRoot,
    managedMarketplaceDir,
    projectDir,
    canvasDir,
  });

  await mkdir(paths.updaterDir, { recursive: true });
  await writeJson(paths.configPath, config);
  if (process.platform === "darwin") {
    await mkdir(dirname(paths.launchAgentPath), { recursive: true });
    await writeFile(paths.launchAgentPath, renderLaunchAgentPlist({
      nodePath: process.execPath,
      updaterPath,
      configPath: paths.configPath,
      logPath: paths.logPath,
    }));
    await registerMacSchedule(paths.launchAgentPath);
  } else if (process.platform === "win32") {
    await writeFile(paths.windowsRunnerPath, renderWindowsUpdateRunner({
      nodePath: process.execPath,
      updaterPath,
      configPath: paths.configPath,
      logPath: paths.logPath,
    }));
    await registerWindowsSchedule(paths.windowsRunnerPath);
  } else {
    console.warn("Automatic scheduling is currently configured for macOS and Windows. Run update-current.mjs manually on this platform.");
  }

  console.log("BUZZASSIST_AUTO_UPDATE=enabled");
  console.log("BUZZASSIST_AUTO_UPDATE_SCHEDULE=daily-03:17-local-time");
  console.log(`BUZZASSIST_AUTO_UPDATE_HOSTS=${config.hosts.join(",")}`);
  console.log(`BUZZASSIST_AUTO_UPDATE_CONFIG=${paths.configPath}`);
}

async function uninstall() {
  const config = await readJson(paths.configPath, {});
  if (process.platform === "darwin") await unregisterMacSchedule(paths.launchAgentPath);
  if (process.platform === "win32") await unregisterWindowsSchedule();
  await writeJson(paths.configPath, { ...config, enabled: false, updatedAt: new Date().toISOString() });
  console.log("BUZZASSIST_AUTO_UPDATE=disabled");
}

async function status() {
  const config = await readJson(paths.configPath, null);
  const state = await readJson(paths.statePath, null);
  console.log(`BUZZASSIST_AUTO_UPDATE=${config?.enabled ? "enabled" : "disabled"}`);
  if (config) console.log(`BUZZASSIST_AUTO_UPDATE_HOSTS=${(config.hosts || []).join(",")}`);
  if (state?.installedVersion) console.log(`BUZZASSIST_INSTALLED_VERSION=${state.installedVersion}`);
  if (state?.latestVersion) console.log(`BUZZASSIST_LATEST_VERSION=${state.latestVersion}`);
  if (state?.lastCheckedAt) console.log(`BUZZASSIST_LAST_UPDATE_CHECK=${state.lastCheckedAt}`);
  if (state?.lastError) console.log(`BUZZASSIST_LAST_UPDATE_ERROR=${state.lastError}`);
  console.log(`BUZZASSIST_AUTO_UPDATE_CONFIG=${paths.configPath}`);
}

async function runUpdate() {
  const config = await readJson(paths.configPath, null);
  if (!config?.pluginRoot) throw new Error("BuzzAssist auto-update has not been installed yet.");
  const updaterPath = join(config.pluginRoot, "scripts", "update-current.mjs");
  const forwarded = ["--config", paths.configPath, ...argv.filter((value) => value !== action)];
  const result = await run(process.execPath, [updaterPath, ...forwarded], { inherit: true, allowFailure: true });
  process.exitCode = result.code ?? 1;
}

if (action === "install") await install();
else if (action === "uninstall" || action === "remove") await uninstall();
else if (action === "status") await status();
else if (action === "run" || action === "check") await runUpdate();
else throw new Error(`Unknown auto-update action: ${action}`);
