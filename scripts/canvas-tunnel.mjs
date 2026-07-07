#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TUNNEL_SESSION = "buzzassist_ngrok_canvas";
const DEFAULT_CANVAS_SESSION = "buzzassist_canvas_tunnel_server";
const START_TIMEOUT_MS = 45_000;

const argv = process.argv.slice(2);
const command = argv.shift();

const valueArgs = new Set([
  "--project-dir",
  "--canvas-dir",
  "--local-url",
  "--ngrok-authtoken",
  "--access-token",
  "--user",
  "--password",
  "--session-name",
  "--canvas-session-name",
  "--status-file",
  "--log-file",
]);

function usage() {
  return `Usage:
  npm run tunnel:start -- [projectDir]
  npm run tunnel:status -- [projectDir]
  npm run tunnel:stop -- [projectDir]

Options:
  --project-dir <path>         Project directory. Defaults to EXCALIDRAW_PROJECT_DIR or cwd.
  --canvas-dir <path>          Canvas data directory. Defaults to <projectDir>/canvas.
  --local-url <url>            Existing local canvas URL. Defaults to canvas/.server.json.
  --ngrok-authtoken <token>    Configure ngrok before starting. Also reads BUZZASSIST_NGROK_AUTHTOKEN or NGROK_AUTHTOKEN.
  --access-token <token>       URL token for tunnel access. Defaults to a generated token.
  --basic-auth                 Also enable ngrok Basic Auth. Off by default because some in-app browsers do not show the auth prompt.
  --user <name>                Basic Auth user. Defaults to buzzassist.
  --password <password>        Basic Auth password. Defaults to a generated password.
  --reuse-local                Reuse canvas/.server.json instead of starting a tunnel-ready canvas server.
  --no-compression             Disable ngrok gzip compression.
  --restart                    Restart an existing tunnel session.
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

async function commandAvailable(commandName, args = ["--version"]) {
  try {
    await execFileAsync(commandName, args);
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
    localUrl: readArg("--local-url") || process.env.BUZZASSIST_TUNNEL_LOCAL_URL || "",
    ngrokAuthtoken: readArg("--ngrok-authtoken") || process.env.BUZZASSIST_NGROK_AUTHTOKEN || process.env.NGROK_AUTHTOKEN || "",
    accessToken: readArg("--access-token") || process.env.BUZZASSIST_TUNNEL_ACCESS_TOKEN || randomBytes(16).toString("hex"),
    basicAuth: hasArg("--basic-auth") || /^(1|true|yes)$/i.test(String(process.env.BUZZASSIST_TUNNEL_BASIC_AUTH || "")),
    user: readArg("--user") || process.env.BUZZASSIST_TUNNEL_USER || "buzzassist",
    password: readArg("--password") || process.env.BUZZASSIST_TUNNEL_PASSWORD || randomBytes(6).toString("hex"),
    sessionName: readArg("--session-name") || process.env.BUZZASSIST_TUNNEL_TMUX_SESSION || DEFAULT_TUNNEL_SESSION,
    canvasSessionName: readArg("--canvas-session-name") || process.env.BUZZASSIST_CANVAS_TMUX_SESSION || DEFAULT_CANVAS_SESSION,
    reuseLocal: hasArg("--reuse-local") || /^(1|true|yes)$/i.test(String(process.env.BUZZASSIST_TUNNEL_REUSE_LOCAL || "")),
    compression: !hasArg("--no-compression") && !/^(0|false|no)$/i.test(String(process.env.BUZZASSIST_TUNNEL_COMPRESSION || "true")),
  };
}

function ngrokInstallHelp() {
  return [
    "ngrok is required for Canvas Tunnel.",
    "Install it, then add your personal ngrok authtoken:",
    "  macOS:   brew install ngrok",
    "  Windows: winget install Ngrok.Ngrok",
    "  Linux:   install from https://ngrok.com/download",
    "  ngrok config add-authtoken <token>",
    "You can also run tunnel:start with --ngrok-authtoken <token> or set BUZZASSIST_NGROK_AUTHTOKEN.",
  ].join("\n");
}

function tmuxInstallHelp() {
  return [
    "tmux is required for tunnel:start to keep ngrok and the canvas server running.",
    "Install it first:",
    "  macOS:   brew install tmux",
    "  Linux:   sudo apt install tmux / sudo dnf install tmux",
    "On Windows, run from WSL or start the canvas manually and use --reuse-local --local-url <url>.",
  ].join("\n");
}

async function ensureNgrokReady(config) {
  if (!await commandAvailable("ngrok", ["version"])) {
    throw new Error(ngrokInstallHelp());
  }

  if (config.ngrokAuthtoken) {
    try {
      await execFileAsync("ngrok", ["config", "add-authtoken", config.ngrokAuthtoken], { timeout: 15_000 });
    } catch (error) {
      throw new Error(`Failed to configure ngrok authtoken: ${error.stderr || error.message || String(error)}`);
    }
  }

  try {
    await execFileAsync("ngrok", ["config", "check"], { timeout: 10_000 });
  } catch (error) {
    throw new Error([
      "ngrok is installed but its config is not ready.",
      "Run `ngrok config add-authtoken <token>`, pass `--ngrok-authtoken <token>`, or set BUZZASSIST_NGROK_AUTHTOKEN.",
      error.stderr || error.stdout || error.message || String(error),
    ].filter(Boolean).join("\n"));
  }
}

function pathsFor(config) {
  return {
    statusFile: resolve(readArg("--status-file") || join(config.canvasDir, ".canvas-tunnel.json")),
    logFile: resolve(readArg("--log-file") || join(config.canvasDir, ".canvas-tunnel.log")),
    serverLogFile: resolve(join(config.canvasDir, ".canvas-tunnel-server.log")),
    discoveryFile: resolve(join(config.canvasDir, ".server.json")),
  };
}

async function checkHttp(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 3000);
  try {
    const headers = options.basicAuth
      ? { authorization: `Basic ${Buffer.from(options.basicAuth).toString("base64")}` }
      : {};
    const response = await fetch(url, { method: "GET", headers, signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function probeTunnelAccessUrl(status, options = {}) {
  if (!status?.accessUrl) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 5000);
  try {
    const response = await fetch(status.accessUrl, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    const body = await response.text().catch(() => "");
    const ngrokError = response.headers.get("ngrok-error-code") || body.match(/ERR_NGROK_\d+/)?.[0] || "";
    if (ngrokError) {
      return {
        ok: false,
        status: response.status,
        error: `${ngrokError}: ngrok is not serving the canvas. Check the ngrok dashboard, bandwidth limit, or use another ngrok authtoken.`,
      };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, error: `Tunnel returned HTTP ${response.status}.` };
    }
    return { ok: true, status: response.status };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

function printTunnelHealth(health) {
  if (!health) return;
  if (health.ok) {
    console.log("Tunnel health: ok");
    return;
  }
  console.log(`Tunnel health: needs-attention${health.status ? ` (HTTP ${health.status})` : ""}`);
  console.log(`Tunnel error: ${health.error}`);
}

async function readDiscoveredLocalUrl(paths) {
  const discovery = await readJson(paths.discoveryFile);
  return typeof discovery?.url === "string" ? discovery.url.replace(/\/+$/, "") : "";
}

async function waitForLocalCanvas(paths, options = {}) {
  const started = Date.now();
  while (Date.now() - started < START_TIMEOUT_MS) {
    const discovery = await readJson(paths.discoveryFile, null);
    const url = typeof discovery?.url === "string" ? discovery.url.replace(/\/+$/, "") : "";
    const updatedAt = Date.parse(discovery?.updatedAt || "");
    const isFreshEnough = !options.updatedAfterMs || (Number.isFinite(updatedAt) && updatedAt >= options.updatedAfterMs);
    if (url && isFreshEnough && await checkHttp(url)) return url;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  throw new Error(`Canvas server did not become reachable. Check ${paths.serverLogFile}.`);
}

function buildCanvasCommand(config, paths, { port, allowedOrigin } = {}) {
  // Default: no cross-origin allowance at all (local origins only). The exact
  // tunnel origin is pinned via EXCALIDRAW_ALLOWED_ORIGINS on the post-tunnel
  // restart, so we never leave the wildcard *.ngrok* allowance enabled.
  const originExport = allowedOrigin
    ? `unset EXCALIDRAW_ALLOW_TUNNEL_ORIGINS && export EXCALIDRAW_ALLOWED_ORIGINS=${shellQuote(allowedOrigin)}`
    : `unset EXCALIDRAW_ALLOW_TUNNEL_ORIGINS EXCALIDRAW_ALLOWED_ORIGINS`;
  const portArgs = port ? ` --port ${port} --strict-port` : "";
  return [
    `cd ${shellQuote(repoRoot)}`,
    originExport,
    `export EXCALIDRAW_TUNNEL_ACCESS_TOKEN=${shellQuote(config.accessToken)}`,
    `export EXCALIDRAW_PROJECT_DIR=${shellQuote(config.projectDir)}`,
    `export EXCALIDRAW_CANVAS_DIR=${shellQuote(config.canvasDir)}`,
    `exec ${shellQuote(process.execPath)} ${shellQuote(join(repoRoot, "scripts", "serve-canvas.mjs"))} ${shellQuote(config.projectDir)}${portArgs} >> ${shellQuote(paths.serverLogFile)} 2>&1`,
  ].join(" && ");
}

function portFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.port ? Number(parsed.port) : (parsed.protocol === "https:" ? 443 : 80);
  } catch {
    return 0;
  }
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
  if (config.reuseLocal && discoveredUrl && await checkHttp(discoveredUrl)) {
    return { localBaseUrl: discoveredUrl, managedCanvas: false };
  }

  if (!await commandAvailable("tmux", ["-V"])) {
    throw new Error(`No reachable canvas server found, and tmux is not available to start one.\n${tmuxInstallHelp()}`);
  }

  if (!await tmuxHasSession(config.canvasSessionName)) {
    const startedAt = Date.now() - 1000;
    await tmuxNewSession(config.canvasSessionName, buildCanvasCommand(config, paths));
    const localBaseUrl = await waitForLocalCanvas(paths, { updatedAfterMs: startedAt });
    return { localBaseUrl, managedCanvas: true };
  }

  const localBaseUrl = await waitForLocalCanvas(paths);
  return { localBaseUrl, managedCanvas: true };
}

// Restart the managed canvas server on the same port, this time allowing only
// the exact public tunnel origin. ngrok keeps pointing at the fixed port and
// reconnects across the brief restart.
async function pinManagedCanvasOrigin(config, paths, { port, allowedOrigin }) {
  if (!port) throw new Error("Cannot pin tunnel origin without a fixed local port.");
  const startedAt = Date.now() - 1000;
  await tmuxKillSession(config.canvasSessionName);
  await tmuxNewSession(config.canvasSessionName, buildCanvasCommand(config, paths, { port, allowedOrigin }));
  return waitForLocalCanvas(paths, { updatedAfterMs: startedAt });
}

function parseNgrokPublicUrl(logText) {
  const lines = String(logText || "").trim().split(/\r?\n/).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry?.url && /^https:\/\//.test(entry.url)) return entry.url;
    } catch {
      const match = line.match(/https:\/\/[^\s"']+\.ngrok[^\s"']*/);
      if (match) return match[0];
    }
  }
  return "";
}

async function waitForPublicUrl(paths) {
  const started = Date.now();
  while (Date.now() - started < START_TIMEOUT_MS) {
    let logText = "";
    try {
      logText = await readFile(paths.logFile, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const publicUrl = parseNgrokPublicUrl(logText);
    if (publicUrl) return publicUrl;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  throw new Error(`ngrok tunnel URL was not assigned. Check ${paths.logFile}.`);
}

function printStatus(status, { active }) {
  if (!status?.ok) {
    console.log(active ? "Canvas tunnel: starting or unhealthy" : "Canvas tunnel: stopped");
    if (status?.error) console.log(`Error: ${status.error}`);
    return;
  }
  console.log(`Canvas tunnel: ${active ? "running" : "not running"}`);
  console.log(`URL: ${status.publicUrl}`);
  if (status.accessUrl) console.log(`Access URL: ${status.accessUrl}`);
  if (status.basicAuth) {
    console.log(`Basic Auth User: ${status.user}`);
    console.log(`Basic Auth Password: ${status.password}`);
  }
  console.log(`Local canvas: ${status.localBaseUrl}`);
  console.log(`Status file: ${status.statusFile}`);
  console.log(`Log file: ${status.logFile}`);
}

async function start() {
  const config = resolveConfig();
  const paths = pathsFor(config);

  if (!await commandAvailable("tmux", ["-V"])) {
    throw new Error(tmuxInstallHelp());
  }
  await ensureNgrokReady(config);

  if (await tmuxHasSession(config.sessionName)) {
    if (!hasArg("--restart")) {
      const status = await readJson(paths.statusFile, null);
      printStatus(status, { active: true });
      console.log("Use `npm run tunnel:start -- --restart` to replace the running tunnel.");
      return;
    }
    await tmuxKillSession(config.sessionName);
  }

  const { localBaseUrl, managedCanvas } = await ensureLocalCanvas(config, paths);
  await writeJson(paths.statusFile, {
    ok: false,
    state: "starting",
    sessionName: config.sessionName,
    canvasSessionName: config.canvasSessionName,
    localBaseUrl,
    managedCanvas,
    startedAt: new Date().toISOString(),
    statusFile: paths.statusFile,
    logFile: paths.logFile,
  });
  await writeFile(paths.logFile, "", { mode: 0o600 });

  const tunnelCommand = [
    `cd ${shellQuote(repoRoot)}`,
    [
      "exec ngrok http",
      config.compression ? "--compression" : "",
      config.basicAuth ? `--basic-auth ${shellQuote(`${config.user}:${config.password}`)}` : "",
      `--log=${shellQuote(paths.logFile)}`,
      "--log-format=json",
      shellQuote(localBaseUrl),
    ].filter(Boolean).join(" "),
  ].join(" && ");
  await tmuxNewSession(config.sessionName, tunnelCommand);

  const publicUrl = await waitForPublicUrl(paths);
  const accessUrl = `${publicUrl.replace(/\/+$/, "")}/?t=${encodeURIComponent(config.accessToken)}`;

  // Now that the public URL exists, lock the managed canvas server's CORS
  // allow-list to exactly that origin (replacing the local-only default) so
  // no other site can drive the tunnel-exposed APIs.
  if (managedCanvas) {
    const localPort = portFromUrl(localBaseUrl);
    try {
      await pinManagedCanvasOrigin(config, paths, { port: localPort, allowedOrigin: publicUrl });
    } catch (error) {
      await tmuxKillSession(config.sessionName);
      await tmuxKillSession(config.canvasSessionName);
      throw new Error(`Failed to pin tunnel origin (${publicUrl}); tore down the tunnel: ${error.message}`);
    }
  }

  const status = {
    ok: true,
    state: "running",
    sessionName: config.sessionName,
    canvasSessionName: config.canvasSessionName,
    publicUrl,
    accessUrl,
    localBaseUrl,
    accessToken: config.accessToken,
    basicAuth: config.basicAuth,
    user: config.user,
    password: config.password,
    compression: config.compression,
    managedCanvas,
    projectDir: config.projectDir,
    canvasDir: config.canvasDir,
    statusFile: paths.statusFile,
    logFile: paths.logFile,
    startedAt: new Date().toISOString(),
  };
  await writeJson(paths.statusFile, status);
  printStatus(status, { active: await tmuxHasSession(config.sessionName) });
  printTunnelHealth(await probeTunnelAccessUrl(status));
}

async function status() {
  const config = resolveConfig();
  const paths = pathsFor(config);
  const active = await tmuxHasSession(config.sessionName);
  const current = await readJson(paths.statusFile, null);
  printStatus(current, { active });
  if (active) printTunnelHealth(await probeTunnelAccessUrl(current));
}

async function stop() {
  const config = resolveConfig();
  const paths = pathsFor(config);
  const previous = await readJson(paths.statusFile, null);
  const killed = await tmuxKillSession(config.sessionName);
  // The canvas server we started for the tunnel carries a widened CORS
  // allow-list; leaving it running (as prior versions did) kept a
  // tunnel-configured server bound to .server.json after the tunnel was gone.
  // Tear it down too whenever we managed it.
  const canvasSessionName = previous?.canvasSessionName || config.canvasSessionName;
  const canvasKilled = previous?.managedCanvas === false ? false : await tmuxKillSession(canvasSessionName);
  await writeJson(paths.statusFile, {
    ...(previous && typeof previous === "object" ? previous : {}),
    ok: false,
    state: "stopped",
    stoppedAt: new Date().toISOString(),
    tmuxKilled: killed,
    canvasKilled,
    statusFile: paths.statusFile,
    logFile: paths.logFile,
  });
  const parts = [];
  if (killed) parts.push("tunnel");
  if (canvasKilled) parts.push("managed canvas server");
  console.log(parts.length ? `Stopped: ${parts.join(" + ")}.` : "Canvas tunnel was not running.");
}

try {
  if (command === "start") await start();
  else if (command === "status") await status();
  else if (command === "stop") await stop();
  else {
    console.error(usage());
    process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
