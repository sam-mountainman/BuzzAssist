#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRemoteCanvasRelayClient,
  createRemoteCanvasSession,
} from "../lib/remoteCanvasRelayClient.mjs";
import { requireBuzzAssistToken, resolveBuzzAssistApiBase } from "../lib/buzzassistApi.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = fileURLToPath(import.meta.url);
const DEFAULT_RELAY_SESSION = "buzzassist_remote_relay";
const DEFAULT_CANVAS_SESSION = "buzzassist_canvas_server";
const START_TIMEOUT_MS = 45_000;

const argv = process.argv.slice(2);
const command = argv.shift();

const valueArgs = new Set([
  "--project-dir",
  "--canvas-dir",
  "--local-url",
  "--relay-url",
  "--title",
  "--mode",
  "--expires-hours",
  "--session-name",
  "--canvas-session-name",
  "--status-file",
  "--log-file",
]);

function usage() {
  return `Usage:
  npm run remote:start -- [projectDir] [--mode generate|view] [--expires-hours 24]
  npm run remote:status -- [projectDir]
  npm run remote:stop -- [projectDir]

Options:
  --project-dir <path>         Project directory. Defaults to EXCALIDRAW_PROJECT_DIR or cwd.
  --canvas-dir <path>          Canvas data directory. Defaults to <projectDir>/canvas.
  --local-url <url>            Existing local canvas URL. Defaults to canvas/.server.json.
  --relay-url <url>            BuzzAssist Cloud URL. Defaults to BUZZASSIST_API_BASE or https://buzzassist.ai.
  --title <text>               Remote session title.
  --mode <generate|view>       Remote mode. Defaults to generate.
  --expires-hours <hours>      Share URL lifetime. Defaults to 24.
  --restart                    Restart an existing relay session.
`;
}

function readArg(name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function hasArg(name) {
  return argv.includes(name);
}

function positionalArgs() {
  return argv.filter((arg, index) => !arg.startsWith("--") && !valueArgs.has(argv[index - 1]));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolveExec, rejectExec) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        rejectExec(error);
        return;
      }
      resolveExec({ stdout, stderr });
    });
  });
}

async function tmuxAvailable() {
  try {
    await execFileAsync("tmux", ["-V"]);
    return true;
  } catch {
    return false;
  }
}

async function tmuxHasSession(name) {
  try {
    await execFileAsync("tmux", ["has-session", "-t", name]);
    return true;
  } catch {
    return false;
  }
}

async function tmuxKillSession(name) {
  if (!await tmuxHasSession(name)) return false;
  await execFileAsync("tmux", ["kill-session", "-t", name]);
  return true;
}

async function tmuxNewSession(name, shellCommand) {
  await execFileAsync("tmux", ["new-session", "-d", "-s", name, shellCommand]);
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath, payload) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function resolveConfig() {
  const positional = positionalArgs();
  const projectDir = resolve(
    readArg("--project-dir") ||
      process.env.EXCALIDRAW_PROJECT_DIR ||
      positional[0] ||
      process.cwd(),
  );
  const canvasDir = resolve(readArg("--canvas-dir") || process.env.EXCALIDRAW_CANVAS_DIR || join(projectDir, "canvas"));
  return {
    projectDir,
    canvasDir,
    relayBaseUrl: String(readArg("--relay-url") || process.env.BUZZASSIST_REMOTE_CANVAS_BASE_URL || resolveBuzzAssistApiBase()).replace(/\/+$/, ""),
    title: readArg("--title") || process.env.BUZZASSIST_REMOTE_CANVAS_TITLE || "BuzzAssist Remote Canvas",
    mode: readArg("--mode") === "view" || process.env.BUZZASSIST_REMOTE_CANVAS_MODE === "view" ? "view" : "generate",
    expiresHours: Number(readArg("--expires-hours") || process.env.BUZZASSIST_REMOTE_CANVAS_EXPIRES_HOURS || 24),
    sessionName: readArg("--session-name") || process.env.BUZZASSIST_REMOTE_CANVAS_TMUX_SESSION || DEFAULT_RELAY_SESSION,
    canvasSessionName: readArg("--canvas-session-name") || process.env.BUZZASSIST_CANVAS_TMUX_SESSION || DEFAULT_CANVAS_SESSION,
    localUrl: readArg("--local-url") || process.env.BUZZASSIST_REMOTE_CANVAS_LOCAL_URL || "",
  };
}

function pathsFor(config) {
  return {
    statusFile: resolve(readArg("--status-file") || join(config.canvasDir, ".remote-canvas-relay.json")),
    logFile: resolve(readArg("--log-file") || join(config.canvasDir, ".remote-canvas-relay.log")),
    serverLogFile: resolve(join(config.canvasDir, ".remote-canvas-server.log")),
    discoveryFile: resolve(join(config.canvasDir, ".server.json")),
  };
}

async function checkHttp(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function readDiscoveredLocalUrl(paths) {
  const discovery = await readJson(paths.discoveryFile);
  return typeof discovery?.url === "string" ? discovery.url.replace(/\/+$/, "") : "";
}

async function waitForLocalCanvas(paths) {
  const started = Date.now();
  while (Date.now() - started < START_TIMEOUT_MS) {
    const url = await readDiscoveredLocalUrl(paths);
    if (url && await checkHttp(url)) return url;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  throw new Error(`Canvas server did not become reachable. Check ${paths.serverLogFile}.`);
}

async function ensureLocalCanvas(config, paths) {
  const configuredUrl = String(config.localUrl || "").replace(/\/+$/, "");
  if (configuredUrl) {
    if (!await checkHttp(configuredUrl)) {
      throw new Error(`Configured local canvas URL is not reachable: ${configuredUrl}`);
    }
    return { localBaseUrl: configuredUrl, managedCanvas: false };
  }

  const discoveredUrl = await readDiscoveredLocalUrl(paths);
  if (discoveredUrl && await checkHttp(discoveredUrl)) {
    return { localBaseUrl: discoveredUrl, managedCanvas: false };
  }

  if (!await tmuxAvailable()) {
    throw new Error("No reachable canvas server found, and tmux is not available to start one. Run npm run serve first.");
  }

  if (!await tmuxHasSession(config.canvasSessionName)) {
    const canvasCommand = [
      `cd ${shellQuote(repoRoot)}`,
      `exec ${shellQuote(process.execPath)} ${shellQuote(join(repoRoot, "scripts", "serve-canvas.mjs"))} ${shellQuote(config.projectDir)} >> ${shellQuote(paths.serverLogFile)} 2>&1`,
    ].join(" && ");
    await tmuxNewSession(config.canvasSessionName, canvasCommand);
  }

  const localBaseUrl = await waitForLocalCanvas(paths);
  return { localBaseUrl, managedCanvas: true };
}

function formatRemaining(expiresAt) {
  const ms = Number(expiresAt) - Date.now();
  if (!Number.isFinite(ms)) return "unknown";
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function printStatus(status, { active }) {
  if (!status?.ok) {
    console.log(active ? "Remote relay: starting or unhealthy" : "Remote relay: stopped");
    if (status?.error) console.log(`Error: ${status.error}`);
    return;
  }
  console.log(`Remote relay: ${active ? "running" : "not running"}`);
  console.log(`Viewer URL: ${status.viewerUrl}`);
  console.log(`Mode: ${status.mode}`);
  console.log(`Expires: ${new Date(status.expiresAt).toISOString()} (${formatRemaining(status.expiresAt)} remaining)`);
  console.log(`Session ID: ${status.sessionId}`);
  console.log(`Local canvas: ${status.localBaseUrl}`);
  console.log(`Status file: ${status.statusFile}`);
  console.log(`Log file: ${status.logFile}`);
}

async function waitForStatus(paths) {
  const started = Date.now();
  let lastStatus = null;
  while (Date.now() - started < START_TIMEOUT_MS) {
    lastStatus = await readJson(paths.statusFile, null);
    if (lastStatus?.ok || lastStatus?.error) return lastStatus;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  return lastStatus;
}

async function start() {
  const config = resolveConfig();
  const paths = pathsFor(config);

  if (!await tmuxAvailable()) {
    throw new Error("tmux is required for remote:start. Install tmux or run the relay in the foreground with `node scripts/remote-canvas-relay.mjs run`.");
  }

  if (await tmuxHasSession(config.sessionName)) {
    if (!hasArg("--restart")) {
      const status = await readJson(paths.statusFile, null);
      printStatus(status, { active: true });
      console.log("Use `npm run remote:start -- --restart` to replace the running relay.");
      return;
    }
    await tmuxKillSession(config.sessionName);
  }

  const { localBaseUrl, managedCanvas } = await ensureLocalCanvas(config, paths);
  await writeJson(paths.statusFile, {
    ok: false,
    state: "starting",
    sessionName: config.sessionName,
    localBaseUrl,
    managedCanvas,
    startedAt: new Date().toISOString(),
  });

  const runArgs = [
    scriptPath,
    "run",
    "--project-dir",
    config.projectDir,
    "--canvas-dir",
    config.canvasDir,
    "--local-url",
    localBaseUrl,
    "--relay-url",
    config.relayBaseUrl,
    "--title",
    config.title,
    "--mode",
    config.mode,
    "--expires-hours",
    String(Number.isFinite(config.expiresHours) && config.expiresHours > 0 ? config.expiresHours : 24),
    "--session-name",
    config.sessionName,
    "--status-file",
    paths.statusFile,
    "--log-file",
    paths.logFile,
  ];
  const relayCommand = [
    `cd ${shellQuote(repoRoot)}`,
    `exec ${shellQuote(process.execPath)} ${runArgs.map(shellQuote).join(" ")} >> ${shellQuote(paths.logFile)} 2>&1`,
  ].join(" && ");
  await tmuxNewSession(config.sessionName, relayCommand);

  const status = await waitForStatus(paths);
  const active = await tmuxHasSession(config.sessionName);
  if (!status?.ok) {
    printStatus(status, { active });
    throw new Error(`Remote relay did not start cleanly. Check ${paths.logFile}.`);
  }
  printStatus(status, { active });
}

async function status() {
  const config = resolveConfig();
  const paths = pathsFor(config);
  const active = await tmuxHasSession(config.sessionName);
  const current = await readJson(paths.statusFile, null);
  printStatus(current, { active });
}

async function revokeCloudSession(status) {
  if (!status?.sessionId || !status?.relayBaseUrl) return { skipped: true, reason: "missing session metadata" };
  const token = await requireBuzzAssistToken();
  const response = await fetch(`${status.relayBaseUrl}/api/remote-canvas/sessions/${encodeURIComponent(status.sessionId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 404) {
    throw new Error(body?.error || `Failed to revoke remote session with HTTP ${response.status}`);
  }
  return { skipped: false, status: response.status, body };
}

async function stop() {
  const config = resolveConfig();
  const paths = pathsFor(config);
  const previous = await readJson(paths.statusFile, null);
  const killed = await tmuxKillSession(config.sessionName);
  let revoke = null;
  try {
    revoke = await revokeCloudSession(previous);
  } catch (error) {
    revoke = { error: error instanceof Error ? error.message : String(error) };
  }
  const stopped = {
    ...(previous && typeof previous === "object" ? previous : {}),
    ok: false,
    state: "stopped",
    stoppedAt: new Date().toISOString(),
    tmuxKilled: killed,
    cloudRevoke: revoke,
    statusFile: paths.statusFile,
    logFile: paths.logFile,
  };
  await writeJson(paths.statusFile, stopped);
  console.log(killed ? "Remote relay stopped." : "Remote relay was not running.");
  if (revoke?.error) console.log(`Cloud revoke failed: ${revoke.error}`);
  else if (revoke?.skipped) console.log(`Cloud revoke skipped: ${revoke.reason}`);
  else console.log("Remote share URL revoked.");
}

async function run() {
  const config = resolveConfig();
  const paths = pathsFor(config);
  let relay = null;

  async function markStopped(reason) {
    const existing = await readJson(paths.statusFile, {});
    await writeJson(paths.statusFile, {
      ...existing,
      ok: false,
      state: "stopped",
      stoppedAt: new Date().toISOString(),
      stopReason: reason,
      statusFile: paths.statusFile,
      logFile: paths.logFile,
    });
  }

  async function shutdown(signal) {
    if (relay) relay.stop();
    await markStopped(signal);
    process.exit(0);
  }

  process.on("SIGINT", () => { shutdown("SIGINT").catch(() => process.exit(1)); });
  process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(1)); });

  try {
    const localBaseUrl = String(config.localUrl || "").replace(/\/+$/, "");
    if (!localBaseUrl) throw new Error("remote relay run requires --local-url.");
    const created = await createRemoteCanvasSession({
      relayBaseUrl: config.relayBaseUrl,
      title: config.title,
      mode: config.mode,
      expiresInHours: config.expiresHours,
    });
    const statusPayload = {
      ok: true,
      state: "running",
      sessionName: config.sessionName,
      sessionId: created.sessionId,
      viewerUrl: created.viewerUrl,
      relayBaseUrl: created.relayBaseUrl || config.relayBaseUrl,
      localBaseUrl,
      title: created.title || config.title,
      mode: created.mode || config.mode,
      expiresAt: created.expiresAt,
      expiresInHours: created.expiresInHours || config.expiresHours,
      pid: process.pid,
      projectDir: config.projectDir,
      canvasDir: config.canvasDir,
      statusFile: paths.statusFile,
      logFile: paths.logFile,
      startedAt: new Date().toISOString(),
    };
    await writeJson(paths.statusFile, statusPayload);
    console.log(`Remote canvas viewer: ${created.viewerUrl}`);

    relay = createRemoteCanvasRelayClient({
      relayBaseUrl: statusPayload.relayBaseUrl,
      sessionId: created.sessionId,
      desktopToken: created.desktopToken,
      canvasDir: config.canvasDir,
      localBaseUrl,
    });
    await relay.done;
    await markStopped("relay.done");
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    await writeJson(paths.statusFile, {
      ok: false,
      state: "failed",
      error: message,
      sessionName: config.sessionName,
      pid: process.pid,
      projectDir: config.projectDir,
      canvasDir: config.canvasDir,
      statusFile: paths.statusFile,
      logFile: paths.logFile,
      failedAt: new Date().toISOString(),
    });
    console.error(message);
    process.exit(1);
  }
}

try {
  if (command === "start") await start();
  else if (command === "status") await status();
  else if (command === "stop") await stop();
  else if (command === "run") await run();
  else {
    console.error(usage());
    process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
