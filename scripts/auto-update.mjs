#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

const DAILY_SCHEDULE = "daily-03:17-local-time";
const LINUX_SERVICE_NAME = `${BUZZASSIST_UPDATE_LABEL}.service`;
const LINUX_TIMER_NAME = `${BUZZASSIST_UPDATE_LABEL}.timer`;
const DEFAULT_FS = Object.freeze({ access, mkdir, readFile, rm, writeFile });

function readArg(argv, name, fallback = "") {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function envFlag(value) {
  return /^(1|true|yes)$/iu.test(String(value || ""));
}

async function pathExists(path, fsOps = DEFAULT_FS) {
  try {
    await fsOps.access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path, fallback = null, fsOps = DEFAULT_FS) {
  try {
    return JSON.parse(await fsOps.readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(path, value, fsOps = DEFAULT_FS) {
  await fsOps.mkdir(dirname(path), { recursive: true });
  await fsOps.writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function runProcess(command, args, {
  allowFailure = false,
  inherit = false,
  platform = process.platform,
  env = process.env,
} = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      shell: platform === "win32" && /\.(?:cmd|bat)$/iu.test(command),
      env,
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

function systemdQuote(value) {
  const text = String(value);
  if (/[\0\r\n]/u.test(text)) throw new Error("systemd unit arguments must be single-line strings without NUL bytes.");
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

export function renderSystemdUserService({ nodePath, updaterPath, configPath }) {
  const command = [nodePath, updaterPath, "--scheduled", "--config", configPath].map(systemdQuote).join(" ");
  return `[Unit]\nDescription=BuzzAssist stable Release update\n\n[Service]\nType=oneshot\nExecStart=${command}\n`;
}

export function renderSystemdUserTimer({ hour = 3, minute = 17 } = {}) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error("systemd timer hour/minute are out of range.");
  }
  const clock = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  return `[Unit]\nDescription=Run the BuzzAssist stable Release updater daily\n\n[Timer]\nOnCalendar=*-*-* ${clock}\nPersistent=true\nAccuracySec=5m\nUnit=${LINUX_SERVICE_NAME}\n\n[Install]\nWantedBy=timers.target\n`;
}

export function autoUpdateRuntimePaths(homeDir, platform = process.platform, env = process.env) {
  const paths = updaterPaths(resolve(homeDir), platform);
  const declaredXdg = String(env.XDG_CONFIG_HOME || "").trim();
  const userConfigDir = declaredXdg && isAbsolute(declaredXdg) ? declaredXdg : join(resolve(homeDir), ".config");
  const systemdUserDir = join(userConfigDir, "systemd", "user");
  return {
    ...paths,
    systemdUserDir,
    systemdServicePath: join(systemdUserDir, LINUX_SERVICE_NAME),
    systemdTimerPath: join(systemdUserDir, LINUX_TIMER_NAME),
  };
}

function schedulerProvider(platform) {
  if (platform === "darwin") return "launchd-user";
  if (platform === "win32") return "windows-task-scheduler";
  if (platform === "linux") return "systemd-user";
  return "manual";
}

function currentUid(getuid = process.getuid) {
  return typeof getuid === "function" ? getuid() : null;
}

async function registerMacSchedule({ paths, runCommand, fsOps, uid }) {
  if (uid === null) throw new Error("Cannot determine the current macOS user id for launchd.");
  await fsOps.mkdir(dirname(paths.launchAgentPath), { recursive: true });
  await runCommand("launchctl", ["bootout", `gui/${uid}`, paths.launchAgentPath], { allowFailure: true });
  const registered = await runCommand("launchctl", ["bootstrap", `gui/${uid}`, paths.launchAgentPath], { allowFailure: true });
  if (!registered.ok) throw new Error(`launchd registration failed: ${registered.stderr || registered.stdout || "unknown error"}`);
  const verified = await runCommand("launchctl", ["print", `gui/${uid}/${BUZZASSIST_UPDATE_LABEL}`], { allowFailure: true });
  if (!verified.ok) throw new Error("launchd registration could not be verified.");
}

async function registerWindowsSchedule({ paths, runCommand }) {
  const registered = await runCommand("schtasks.exe", [
    "/Create", "/F", "/SC", "DAILY", "/ST", "03:17",
    "/TN", BUZZASSIST_WINDOWS_TASK,
    "/TR", paths.windowsRunnerPath,
  ], { allowFailure: true });
  if (!registered.ok) throw new Error(`Windows Task Scheduler registration failed: ${registered.stderr || registered.stdout || "unknown error"}`);
  const verified = await runCommand("schtasks.exe", ["/Query", "/TN", BUZZASSIST_WINDOWS_TASK], { allowFailure: true });
  if (!verified.ok) throw new Error("Windows Task Scheduler registration could not be verified.");
}

async function registerLinuxSchedule({ paths, runCommand, fsOps }) {
  const available = await runCommand("systemctl", ["--user", "--version"], { allowFailure: true });
  if (!available.ok) throw new Error("A usable user-level systemd instance is required for automatic scheduling on Linux.");
  await fsOps.mkdir(paths.systemdUserDir, { recursive: true });
  const reloaded = await runCommand("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
  if (!reloaded.ok) throw new Error("systemd user manager is unavailable; daemon-reload failed.");
  const registered = await runCommand("systemctl", ["--user", "enable", "--now", LINUX_TIMER_NAME], { allowFailure: true });
  if (!registered.ok) throw new Error(`systemd user timer registration failed: ${registered.stderr || registered.stdout || "unknown error"}`);
  const enabled = await runCommand("systemctl", ["--user", "is-enabled", LINUX_TIMER_NAME], { allowFailure: true });
  const active = await runCommand("systemctl", ["--user", "is-active", LINUX_TIMER_NAME], { allowFailure: true });
  if (!enabled.ok || enabled.stdout.trim() !== "enabled" || !active.ok || active.stdout.trim() !== "active") {
    throw new Error("systemd user timer registration could not be verified as both enabled and active.");
  }
}

export async function installAutoUpdateScheduler(options) {
  const {
    platform,
    paths,
    nodePath,
    updaterPath,
    configPath,
    logPath,
    runCommand,
    fsOps = DEFAULT_FS,
    skipRegister = false,
    getuid = process.getuid,
  } = options;
  const provider = schedulerProvider(platform);
  if (skipRegister) return { enabled: false, state: "manual", provider, reason: "registration-skipped" };
  if (provider === "manual") throw new Error(`Automatic scheduling is unsupported on platform ${platform}; use manual updates.`);

  if (platform === "darwin") {
    await fsOps.mkdir(dirname(paths.launchAgentPath), { recursive: true });
    await fsOps.writeFile(paths.launchAgentPath, renderLaunchAgentPlist({ nodePath, updaterPath, configPath, logPath }));
    await registerMacSchedule({ paths, runCommand, fsOps, uid: currentUid(getuid) });
  } else if (platform === "win32") {
    await fsOps.mkdir(dirname(paths.windowsRunnerPath), { recursive: true });
    await fsOps.writeFile(paths.windowsRunnerPath, renderWindowsUpdateRunner({ nodePath, updaterPath, configPath, logPath }));
    await registerWindowsSchedule({ paths, runCommand });
  } else if (platform === "linux") {
    await fsOps.mkdir(paths.systemdUserDir, { recursive: true });
    await fsOps.writeFile(paths.systemdServicePath, renderSystemdUserService({ nodePath, updaterPath, configPath }));
    await fsOps.writeFile(paths.systemdTimerPath, renderSystemdUserTimer());
    await registerLinuxSchedule({ paths, runCommand, fsOps });
  }
  return { enabled: true, state: "enabled", provider, schedule: DAILY_SCHEDULE };
}

export async function uninstallAutoUpdateScheduler(options) {
  const {
    platform,
    paths,
    runCommand,
    fsOps = DEFAULT_FS,
    skipRegister = false,
    getuid = process.getuid,
  } = options;
  if (platform === "darwin") {
    const uid = currentUid(getuid);
    if (!skipRegister && uid !== null && await pathExists(paths.launchAgentPath, fsOps)) {
      await runCommand("launchctl", ["bootout", `gui/${uid}`, paths.launchAgentPath], { allowFailure: true });
    }
    await fsOps.rm(paths.launchAgentPath, { force: true });
  } else if (platform === "win32") {
    if (!skipRegister) await runCommand("schtasks.exe", ["/Delete", "/F", "/TN", BUZZASSIST_WINDOWS_TASK], { allowFailure: true });
    await fsOps.rm(paths.windowsRunnerPath, { force: true });
  } else if (platform === "linux") {
    if (!skipRegister) {
      await runCommand("systemctl", ["--user", "disable", "--now", LINUX_TIMER_NAME], { allowFailure: true });
    }
    await fsOps.rm(paths.systemdServicePath, { force: true });
    await fsOps.rm(paths.systemdTimerPath, { force: true });
    if (!skipRegister) {
      await runCommand("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
      await runCommand("systemctl", ["--user", "reset-failed", LINUX_SERVICE_NAME], { allowFailure: true });
    }
  }
}

export async function inspectAutoUpdateScheduler(options) {
  const {
    platform,
    paths,
    runCommand,
    fsOps = DEFAULT_FS,
    skipRegister = false,
    getuid = process.getuid,
  } = options;
  const provider = schedulerProvider(platform);
  if (skipRegister || provider === "manual") return { enabled: false, provider, reason: skipRegister ? "inspection-skipped" : "unsupported-platform" };
  if (platform === "darwin") {
    const uid = currentUid(getuid);
    if (uid === null || !(await pathExists(paths.launchAgentPath, fsOps))) return { enabled: false, provider, reason: "artifact-missing" };
    const result = await runCommand("launchctl", ["print", `gui/${uid}/${BUZZASSIST_UPDATE_LABEL}`], { allowFailure: true });
    return { enabled: result.ok, provider, reason: result.ok ? "verified" : "not-registered" };
  }
  if (platform === "win32") {
    if (!(await pathExists(paths.windowsRunnerPath, fsOps))) return { enabled: false, provider, reason: "artifact-missing" };
    const result = await runCommand("schtasks.exe", ["/Query", "/TN", BUZZASSIST_WINDOWS_TASK], { allowFailure: true });
    return { enabled: result.ok, provider, reason: result.ok ? "verified" : "not-registered" };
  }
  if (!(await pathExists(paths.systemdServicePath, fsOps)) || !(await pathExists(paths.systemdTimerPath, fsOps))) {
    return { enabled: false, provider, reason: "artifact-missing" };
  }
  const enabled = await runCommand("systemctl", ["--user", "is-enabled", LINUX_TIMER_NAME], { allowFailure: true });
  const active = await runCommand("systemctl", ["--user", "is-active", LINUX_TIMER_NAME], { allowFailure: true });
  const ok = enabled.ok && enabled.stdout.trim() === "enabled" && active.ok && active.stdout.trim() === "active";
  return { enabled: ok, provider, reason: ok ? "verified" : "not-enabled-and-active" };
}

function safeReason(error) {
  return String(error?.message || error || "unknown scheduler error").replace(/[\r\n]+/gu, " ").slice(0, 240);
}

function schedulerRecord(schedule, platform, now) {
  return {
    platform,
    provider: schedule.provider,
    state: schedule.state,
    schedule: schedule.schedule || "manual",
    reason: schedule.reason || "",
    verifiedAt: schedule.enabled ? now : "",
    updatedAt: now,
  };
}

function emitSchedule(logger, schedule, config, configPath) {
  logger.log(`BUZZASSIST_AUTO_UPDATE=${schedule.enabled ? "enabled" : "manual"}`);
  logger.log(`BUZZASSIST_AUTO_UPDATE_SCHEDULER=${schedule.provider}`);
  logger.log(`BUZZASSIST_AUTO_UPDATE_SCHEDULER_CHECK=${schedule.enabled ? "ok" : "manual"}`);
  logger.log(`BUZZASSIST_AUTO_UPDATE_SCHEDULE=${schedule.enabled ? DAILY_SCHEDULE : "manual"}`);
  logger.log(`BUZZASSIST_AUTO_UPDATE_HOSTS=${config.hosts.join(",")}`);
  logger.log(`BUZZASSIST_AUTO_UPDATE_CONFIG=${configPath}`);
}

export async function runAutoUpdateCli(options = {}) {
  const argv = options.argv || [];
  const action = argv[0] && !argv[0].startsWith("-") ? argv[0] : "status";
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homeDir = resolve(options.homeDir || env.BUZZASSIST_SETUP_HOME || homedir());
  const paths = options.paths || autoUpdateRuntimePaths(homeDir, platform, env);
  const fsOps = options.fsOps || DEFAULT_FS;
  const logger = options.logger || console;
  const execPath = options.execPath || process.execPath;
  const skipRegister = options.skipRegister ?? envFlag(env.BUZZASSIST_AUTO_UPDATE_SKIP_REGISTER);
  const runCommand = options.runCommand || ((command, args, runOptions = {}) => runProcess(command, args, {
    ...runOptions,
    platform,
    env,
  }));
  const schedulerOptions = { platform, paths, runCommand, fsOps, skipRegister, getuid: options.getuid };

  if (action === "install") {
    const managedMarketplaceDir = resolve(readArg(argv, "--marketplace-dir", join(homeDir, "plugins", "buzzassist")));
    const pluginRoot = resolve(readArg(argv, "--plugin-root", join(managedMarketplaceDir, "plugin")));
    const updaterPath = join(pluginRoot, "scripts", "update-current.mjs");
    if (!(await pathExists(updaterPath, fsOps))) throw new Error(`Updater is missing from the installed plugin: ${updaterPath}`);

    const existing = await readJson(paths.configPath, {}, fsOps);
    const hosts = normalizeUpdateHosts(readArg(argv, "--agent", readArg(argv, "--hosts", "")));
    if (hosts.length === 0) throw new Error("At least one auto-update host is required: codex or claude.");
    const projectDir = resolve(readArg(argv, "--project-dir", existing.projectDir || process.cwd()));
    const canvasDir = resolve(readArg(argv, "--canvas-dir", existing.canvasDir || join(projectDir, "canvas")));
    const now = (options.now || (() => new Date().toISOString()))();
    const baseConfig = mergeUpdaterConfig(existing, {
      enabled: false,
      repository: readArg(argv, "--repository", existing.repository || BUZZASSIST_REPOSITORY),
      hosts,
      pluginRoot,
      managedMarketplaceDir,
      projectDir,
      canvasDir,
      updatedAt: now,
    });
    await fsOps.mkdir(paths.updaterDir, { recursive: true });
    await writeJson(paths.configPath, {
      ...baseConfig,
      enabled: false,
      scheduler: { platform, provider: schedulerProvider(platform), state: "installing", updatedAt: now },
    }, fsOps);

    try {
      const schedule = await installAutoUpdateScheduler({
        ...schedulerOptions,
        nodePath: execPath,
        updaterPath,
        configPath: paths.configPath,
        logPath: paths.logPath,
      });
      const config = {
        ...baseConfig,
        enabled: schedule.enabled,
        scheduler: schedulerRecord(schedule, platform, now),
      };
      await writeJson(paths.configPath, config, fsOps);
      emitSchedule(logger, schedule, config, paths.configPath);
      return { action, config, schedule, exitCode: 0 };
    } catch (error) {
      await uninstallAutoUpdateScheduler({ ...schedulerOptions, skipRegister: false }).catch(() => {});
      const schedule = {
        enabled: false,
        state: "manual",
        provider: schedulerProvider(platform),
        reason: safeReason(error),
      };
      const config = { ...baseConfig, enabled: false, scheduler: schedulerRecord(schedule, platform, now) };
      await writeJson(paths.configPath, config, fsOps).catch(() => {});
      emitSchedule(logger, schedule, config, paths.configPath);
      logger.warn?.(`BUZZASSIST_AUTO_UPDATE_ERROR=${schedule.reason}`);
      throw error;
    }
  }

  if (action === "uninstall" || action === "remove") {
    const config = await readJson(paths.configPath, {}, fsOps);
    await uninstallAutoUpdateScheduler(schedulerOptions);
    const now = (options.now || (() => new Date().toISOString()))();
    await writeJson(paths.configPath, {
      ...config,
      enabled: false,
      updatedAt: now,
      scheduler: {
        platform,
        provider: schedulerProvider(platform),
        state: "disabled",
        schedule: "manual",
        reason: "uninstalled",
        verifiedAt: "",
        updatedAt: now,
      },
    }, fsOps);
    logger.log("BUZZASSIST_AUTO_UPDATE=disabled");
    return { action, enabled: false, exitCode: 0 };
  }

  if (action === "status") {
    const config = await readJson(paths.configPath, null, fsOps);
    const state = await readJson(paths.statePath, null, fsOps);
    const actual = await inspectAutoUpdateScheduler(schedulerOptions);
    const enabled = config?.enabled === true && actual.enabled === true;
    const configuredManual = config?.scheduler?.state === "manual";
    const reported = enabled ? "enabled" : (configuredManual || config?.enabled === true) ? "manual" : "disabled";
    logger.log(`BUZZASSIST_AUTO_UPDATE=${reported}`);
    logger.log(`BUZZASSIST_AUTO_UPDATE_SCHEDULER=${actual.provider}`);
    logger.log(`BUZZASSIST_AUTO_UPDATE_SCHEDULER_CHECK=${actual.enabled ? "ok" : actual.reason}`);
    if (enabled) logger.log(`BUZZASSIST_AUTO_UPDATE_SCHEDULE=${DAILY_SCHEDULE}`);
    else if (reported === "manual") logger.log("BUZZASSIST_AUTO_UPDATE_SCHEDULE=manual");
    if (config) logger.log(`BUZZASSIST_AUTO_UPDATE_HOSTS=${(config.hosts || []).join(",")}`);
    if (state?.installedVersion) logger.log(`BUZZASSIST_INSTALLED_VERSION=${state.installedVersion}`);
    if (state?.latestVersion) logger.log(`BUZZASSIST_LATEST_VERSION=${state.latestVersion}`);
    if (state?.lastCheckedAt) logger.log(`BUZZASSIST_LAST_UPDATE_CHECK=${state.lastCheckedAt}`);
    if (state?.lastError) logger.log(`BUZZASSIST_LAST_UPDATE_ERROR=${state.lastError}`);
    logger.log(`BUZZASSIST_AUTO_UPDATE_CONFIG=${paths.configPath}`);
    return { action, enabled, reported, actual, config, exitCode: 0 };
  }

  if (action === "run" || action === "check") {
    const config = await readJson(paths.configPath, null, fsOps);
    if (!config?.pluginRoot) throw new Error("BuzzAssist auto-update has not been installed yet.");
    const updaterPath = join(config.pluginRoot, "scripts", "update-current.mjs");
    const forwarded = ["--config", paths.configPath, ...argv.slice(1)];
    const result = await runCommand(execPath, [updaterPath, ...forwarded], { inherit: true, allowFailure: true });
    return { action, exitCode: result.code ?? 1 };
  }

  throw new Error(`Unknown auto-update action: ${action}`);
}

async function isDirectExecution(argvPath = process.argv[1]) {
  if (!argvPath) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    const [canonicalArgv, canonicalModule] = await Promise.all([realpath(resolve(argvPath)), realpath(modulePath)]);
    return canonicalArgv === canonicalModule;
  } catch {
    return resolve(argvPath) === modulePath;
  }
}

if (await isDirectExecution()) {
  try {
    const result = await runAutoUpdateCli({ argv: process.argv.slice(2) });
    if (result.exitCode) process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
