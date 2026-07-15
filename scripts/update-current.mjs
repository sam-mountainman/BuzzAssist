#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { resolveCodexCommand } from "./codex-image-bridge.mjs";
import {
  BUZZASSIST_REPOSITORY,
  compareVersions,
  normalizeUpdateHosts,
  normalizeVersion,
  releaseVersion,
  safeReleaseDirectoryName,
  updaterPaths,
} from "../lib/pluginAutoUpdate.mjs";

const argv = process.argv.slice(2);
const homeDir = resolve(process.env.BUZZASSIST_SETUP_HOME || homedir());
const paths = updaterPaths(homeDir);
const configPath = resolve(readArg("--config", paths.configPath));
const checkOnly = hasArg("--check-only");
const force = hasArg("--force");
const scheduled = hasArg("--scheduled");
const skipValidationTests = hasArg("--skip-validation-tests");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
let stableSourceTouched = false;
let backupDir = "";
let config = null;
let lockAcquired = false;

function readArg(name, fallback = "") {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function hasArg(name) {
  return argv.includes(name);
}

function timestamp() {
  return new Date().toISOString();
}

function log(message) {
  console.log(`[${timestamp()}] ${message}`);
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

async function updateState(patch) {
  const previous = await readJson(paths.statePath, {});
  await writeJson(paths.statePath, { ...previous, ...patch });
}

async function run(command, args, options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    allowFailure = false,
    inherit = true,
    timeoutMs = 0,
  } = options;
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs) : null;
    if (!inherit) {
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
    }
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      if (allowFailure) resolveRun({ ok: false, code: null, stdout, stderr, error, timedOut });
      else rejectRun(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const result = { ok: code === 0, code, stdout, stderr, timedOut };
      if (result.ok || allowFailure) resolveRun(result);
      else rejectRun(new Error(timedOut
        ? `${command} timed out.`
        : `${command} exited with ${code}: ${stderr || stdout}`));
    });
  });
}

async function acquireLock() {
  await mkdir(paths.updaterDir, { recursive: true });
  try {
    await mkdir(paths.lockDir);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const lockStat = await stat(paths.lockDir).catch(() => null);
    if (!lockStat || Date.now() - lockStat.mtimeMs <= 2 * 60 * 60 * 1000) {
      throw new Error("Another BuzzAssist update is already running.");
    }
    await rm(paths.lockDir, { recursive: true, force: true });
    await mkdir(paths.lockDir);
  }
  await writeFile(join(paths.lockDir, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: timestamp() }));
  lockAcquired = true;
}

async function releaseLock() {
  await rm(paths.lockDir, { recursive: true, force: true });
}

function githubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "BuzzAssist-safe-updater",
  };
  const token = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function fetchLatestRelease(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GitHub Release check failed (${response.status}).`);
  const release = await response.json();
  releaseVersion(release);
  return release;
}

async function downloadReleaseArchive(release, targetPath) {
  const response = await fetch(release.zipball_url, {
    headers: githubHeaders(),
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`GitHub Release download failed (${response.status}).`);
  const finalUrl = new URL(response.url);
  if (!["api.github.com", "github.com", "codeload.github.com", "objects.githubusercontent.com"].includes(finalUrl.hostname)) {
    throw new Error(`Release download redirected to an untrusted host: ${finalUrl.hostname}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1024) throw new Error("Downloaded Release archive is unexpectedly small.");
  await writeFile(targetPath, buffer);
  return createHash("sha256").update(buffer).digest("hex");
}

async function extractZip(archivePath, targetDir) {
  await mkdir(targetDir, { recursive: true });
  if (process.platform === "darwin") {
    await run("/usr/bin/ditto", ["-x", "-k", archivePath, targetDir]);
    return;
  }
  if (process.platform === "win32") {
    const command = `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${targetDir.replaceAll("'", "''")}' -Force`;
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]);
    return;
  }
  await run("unzip", ["-q", archivePath, "-d", targetDir]);
}

async function findReleaseSource(extractDir) {
  const direct = join(extractDir, "package.json");
  if (await pathExists(direct)) return extractDir;
  const entries = await readdir(extractDir, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(extractDir, entry.name);
    if (await pathExists(join(candidate, "package.json"))) candidates.push(candidate);
  }
  if (candidates.length !== 1) throw new Error("Release archive must contain exactly one BuzzAssist source directory.");
  return candidates[0];
}

async function validateReleaseSource(sourceDir, expectedVersion) {
  const packageManifest = await readJson(join(sourceDir, "package.json"), null);
  const codexManifest = await readJson(join(sourceDir, ".codex-plugin", "plugin.json"), null);
  const claudeManifest = await readJson(join(sourceDir, ".claude-plugin", "plugin.json"), null);
  if (packageManifest?.name !== "buzzassist-canvas-mcp") throw new Error("Release package name is not BuzzAssist.");
  for (const [label, manifest] of [["package", packageManifest], ["Codex", codexManifest], ["Claude Code", claudeManifest]]) {
    if (manifest?.version !== expectedVersion) {
      throw new Error(`${label} manifest version ${manifest?.version || "missing"} does not match Release ${expectedVersion}.`);
    }
  }
  for (const required of ["scripts/setup-agents.mjs", "scripts/update-current.mjs", "scripts/verify-plugin-runtime.mjs", "mcp/server.mjs", "package-lock.json"]) {
    if (!(await pathExists(join(sourceDir, required)))) throw new Error(`Release is missing required file: ${required}`);
  }
  return packageManifest;
}

async function prepareReleaseSource(release, version) {
  const finalSource = join(paths.releasesDir, safeReleaseDirectoryName(version), "source");
  if (
    await pathExists(join(finalSource, "dist", "index.html")) &&
    await pathExists(join(finalSource, "node_modules", "@modelcontextprotocol", "sdk", "package.json"))
  ) {
    await validateReleaseSource(finalSource, version);
    return { sourceDir: finalSource, archiveSha256: null, reused: true };
  }

  await mkdir(paths.releasesDir, { recursive: true });
  const stagingDir = join(paths.releasesDir, `.staging-${safeReleaseDirectoryName(version)}-${process.pid}-${Date.now()}`);
  const archivePath = join(stagingDir, "release.zip");
  const extractDir = join(stagingDir, "extract");
  await mkdir(stagingDir, { recursive: true });
  try {
    log(`Downloading ${release.tag_name} from GitHub Releases.`);
    const archiveSha256 = await downloadReleaseArchive(release, archivePath);
    await extractZip(archivePath, extractDir);
    const extractedSource = await findReleaseSource(extractDir);
    await validateReleaseSource(extractedSource, version);

    log("Installing Release dependencies.");
    await run(npmCommand, ["ci"], { cwd: extractedSource, timeoutMs: 10 * 60 * 1000 });
    log("Building canvas and widget bundles.");
    await run(npmCommand, ["run", "build"], { cwd: extractedSource, timeoutMs: 10 * 60 * 1000 });
    await run(npmCommand, ["run", "build:widget"], { cwd: extractedSource, timeoutMs: 10 * 60 * 1000 });
    if (!skipValidationTests) {
      log("Running cross-host distribution validation.");
      await run(npmCommand, ["run", "test:setup"], {
        cwd: extractedSource,
        timeoutMs: 10 * 60 * 1000,
        env: { ...process.env, BUZZASSIST_AUTO_UPDATE_SKIP_REGISTER: "1" },
      });
    }
    await verifyRuntime(extractedSource, config.projectDir, config.canvasDir);

    const finalReleaseDir = dirname(finalSource);
    await rm(finalReleaseDir, { recursive: true, force: true });
    await mkdir(finalReleaseDir, { recursive: true });
    await rename(extractedSource, finalSource);
    await writeJson(join(finalReleaseDir, "release.json"), {
      version,
      tagName: release.tag_name,
      publishedAt: release.published_at,
      archiveSha256,
      preparedAt: timestamp(),
    });
    return { sourceDir: finalSource, archiveSha256, reused: false };
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

async function verifyRuntime(pluginRoot, projectDir, canvasDir) {
  log(`Verifying MCP runtime at ${pluginRoot}.`);
  await run(process.execPath, [
    join(pluginRoot, "scripts", "verify-plugin-runtime.mjs"),
    "--plugin-root", pluginRoot,
    "--project-dir", projectDir,
    "--canvas-dir", canvasDir,
  ], {
    cwd: pluginRoot,
    timeoutMs: 60_000,
    env: { ...process.env, EXCALIDRAW_NO_AUTO_OPEN: "1" },
  });
}

async function createBackup(currentVersion) {
  if (!(await pathExists(config.managedMarketplaceDir))) return "";
  await mkdir(paths.backupsDir, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeReleaseDirectoryName(currentVersion)}`;
  const target = join(paths.backupsDir, name);
  await cp(config.managedMarketplaceDir, target, { recursive: true, force: true, dereference: false });
  await writeJson(join(target, "backup.json"), { currentVersion, createdAt: timestamp() });
  return target;
}

async function syncDirectoryPreservingRoot(
  sourceDir,
  targetDir,
  { preserveChildren = [], ignoreChildren = [] } = {},
) {
  await mkdir(targetDir, { recursive: true });
  const preserved = new Set(preserveChildren);
  const ignored = new Set(ignoreChildren);
  const sourceEntries = (await readdir(sourceDir, { withFileTypes: true }))
    .filter((entry) => !ignored.has(entry.name));
  const sourceNames = new Set(sourceEntries.map((entry) => entry.name));
  for (const entry of sourceEntries) {
    if (preserved.has(entry.name)) continue;
    const source = join(sourceDir, entry.name);
    const target = join(targetDir, entry.name);
    const incoming = join(targetDir, `.${entry.name}.restore-${process.pid}`);
    const previous = join(targetDir, `.${entry.name}.previous-${process.pid}`);
    await rm(incoming, { recursive: true, force: true });
    await rm(previous, { recursive: true, force: true });
    await cp(source, incoming, { recursive: true, force: true, dereference: false });
    if (await pathExists(target)) await rename(target, previous);
    await rename(incoming, target);
    await rm(previous, { recursive: true, force: true });
  }
  for (const entry of await readdir(targetDir, { withFileTypes: true })) {
    if (preserved.has(entry.name) || sourceNames.has(entry.name) || entry.name.includes(`-${process.pid}`)) continue;
    await rm(join(targetDir, entry.name), { recursive: true, force: true });
  }
}

async function restoreBackup() {
  if (!backupDir || !(await pathExists(backupDir))) return;
  log(`Restoring previous managed plugin from ${backupDir}.`);
  const backupPluginRoot = join(backupDir, "plugin");
  const managedPluginRoot = join(config.managedMarketplaceDir, "plugin");
  await syncDirectoryPreservingRoot(backupDir, config.managedMarketplaceDir, {
    preserveChildren: ["plugin"],
    ignoreChildren: ["backup.json"],
  });
  await syncDirectoryPreservingRoot(backupPluginRoot, managedPluginRoot);
  await reinstallRestoredHosts();
}

function commandName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

async function reinstallRestoredHosts() {
  const selector = "buzzassist@buzzassist";
  for (const host of normalizeUpdateHosts(config.hosts)) {
    if (host === "codex") {
      try {
        const codex = await resolveCodexCommand();
        await run(codex, ["plugin", "add", selector], { allowFailure: true, timeoutMs: 180_000 });
      } catch {
        // The stable managed source is already restored; retry on next host launch.
      }
    } else if (host === "claude") {
      const claude = commandName("claude");
      await run(claude, ["plugin", "uninstall", selector, "--scope", "user", "--keep-data", "-y"], {
        allowFailure: true,
        timeoutMs: 180_000,
      });
      await run(claude, ["plugin", "install", selector, "--scope", "user"], {
        allowFailure: true,
        timeoutMs: 180_000,
      });
    }
  }
}

async function installRelease(sourceDir) {
  const hosts = normalizeUpdateHosts(config.hosts);
  if (hosts.length === 0) throw new Error("No Codex or Claude Code host is registered for updates.");
  const setupArgs = [
    join(sourceDir, "scripts", "setup-agents.mjs"),
    "--agents", hosts.join(","),
    "--project-dir", config.projectDir,
    "--canvas-dir", config.canvasDir,
    "--skip-install",
    "--skip-build",
    "--no-launch",
    "--no-auto-update",
  ];
  log(`Installing the Release for ${hosts.join(" and ")}.`);
  const result = await run(process.execPath, setupArgs, {
    cwd: sourceDir,
    timeoutMs: 8 * 60 * 1000,
    env: {
      ...process.env,
      BUZZASSIST_SETUP_HOME: homeDir,
      BUZZASSIST_AUTO_UPDATE_SKIP_REGISTER: "1",
    },
    allowFailure: true,
  });
  stableSourceTouched = true;
  if (!result.ok) throw new Error(`Host plugin update failed with exit ${result.code}.`);
  await verifyRuntime(config.pluginRoot, config.projectDir, config.canvasDir);
}

async function pruneOldDirectories() {
  for (const [directory, keep] of [[paths.releasesDir, 3], [paths.backupsDir, 3]]) {
    if (!(await pathExists(directory))) continue;
    const entries = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const details = await stat(join(directory, entry.name));
      entries.push({ name: entry.name, mtimeMs: details.mtimeMs });
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const entry of entries.slice(keep)) {
      await rm(join(directory, entry.name), { recursive: true, force: true });
    }
  }
}

async function main() {
  await acquireLock();
  config = await readJson(configPath, null);
  if (!config?.enabled && scheduled) {
    log("Automatic updates are disabled; skipping scheduled check.");
    return;
  }
  if (!config?.pluginRoot || !config?.managedMarketplaceDir) {
    throw new Error(`Auto-update configuration is incomplete: ${configPath}`);
  }
  config.hosts = normalizeUpdateHosts(config.hosts);
  config.repository ||= BUZZASSIST_REPOSITORY;

  const currentManifest = await readJson(join(config.pluginRoot, "package.json"), null);
  const currentVersion = normalizeVersion(currentManifest?.version)?.raw;
  if (!currentVersion) throw new Error(`Cannot determine the installed BuzzAssist version at ${config.pluginRoot}.`);

  log(`Checking ${config.repository} for a stable Release (installed ${currentVersion}).`);
  const release = await fetchLatestRelease(config.repository);
  const latestVersion = releaseVersion(release);
  await updateState({
    status: "checked",
    installedVersion: currentVersion,
    latestVersion,
    lastCheckedAt: timestamp(),
    lastError: "",
  });
  console.log(`BUZZASSIST_INSTALLED_VERSION=${currentVersion}`);
  console.log(`BUZZASSIST_LATEST_VERSION=${latestVersion}`);

  if (!force && compareVersions(latestVersion, currentVersion) <= 0) {
    log("BuzzAssist is already up to date.");
    console.log("BUZZASSIST_UPDATE=up-to-date");
    return;
  }
  if (checkOnly) {
    log(`Update ${currentVersion} -> ${latestVersion} is available.`);
    console.log("BUZZASSIST_UPDATE=available");
    return;
  }

  const prepared = await prepareReleaseSource(release, latestVersion);
  backupDir = await createBackup(currentVersion);
  await installRelease(prepared.sourceDir);
  await updateState({
    status: "updated",
    installedVersion: latestVersion,
    previousVersion: currentVersion,
    latestVersion,
    lastUpdatedAt: timestamp(),
    lastCheckedAt: timestamp(),
    lastError: "",
    archiveSha256: prepared.archiveSha256 || undefined,
    backupDir: backupDir || undefined,
    restartRequired: true,
  });
  await pruneOldDirectories();
  log(`BuzzAssist updated successfully: ${currentVersion} -> ${latestVersion}.`);
  console.log("BUZZASSIST_UPDATE=updated");
  console.log("BUZZASSIST_HOST_RESTART_REQUIRED=yes");
}

try {
  await main();
} catch (error) {
  const message = error?.message || String(error);
  if (stableSourceTouched && backupDir) {
    try {
      await restoreBackup();
      log("Rollback completed; the previous managed plugin remains active.");
    } catch (rollbackError) {
      log(`Rollback needs attention: ${rollbackError?.message || rollbackError}`);
    }
  }
  await updateState({
    status: "failed",
    lastCheckedAt: timestamp(),
    lastError: message,
    rollbackAttempted: Boolean(stableSourceTouched && backupDir),
  }).catch(() => {});
  console.error(`[${timestamp()}] BuzzAssist update failed: ${message}`);
  process.exitCode = 1;
} finally {
  if (lockAcquired) await releaseLock().catch(() => {});
}
