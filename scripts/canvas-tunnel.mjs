#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const isWindows = process.platform === "win32";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TUNNEL_SESSION = "buzzassist_canvas_tunnel";
const LEGACY_TUNNEL_SESSIONS = ["buzzassist_ngrok_canvas", "buzzassist_cloudflared_canvas"];
const DEFAULT_CANVAS_SESSION = "buzzassist_canvas_tunnel_server";
const START_TIMEOUT_MS = 45_000;

const argv = process.argv.slice(2);
const command = argv.shift();

const valueArgs = new Set([
  "--project-dir",
  "--canvas-dir",
  "--local-url",
  "--provider",
  "--cf-hostname",
  "--cf-tunnel-name",
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
  --provider <name>            Tunnel provider: cloudflare (default) or ngrok. Also reads BUZZASSIST_TUNNEL_PROVIDER.
  --project-dir <path>         Project directory. Defaults to EXCALIDRAW_PROJECT_DIR or cwd.
  --canvas-dir <path>          Canvas data directory. Defaults to <projectDir>/canvas.
  --local-url <url>            Existing local canvas URL. Defaults to canvas/.server.json.
  --access-token <token>       URL token for tunnel access. Defaults to a generated token.
  --reuse-local                Reuse canvas/.server.json instead of starting a tunnel-ready canvas server.
  --restart                    Restart an existing tunnel session.

Cloudflare (default provider):
  Zero-config quick tunnel (random *.trycloudflare.com URL, no bandwidth cap, no account).
  --cf-hostname <host>         Serve a fixed named-tunnel hostname (e.g. canvas.buzzassist.ai).
                               Requires a one-time \`cloudflared tunnel login\` and a created tunnel.
  --cf-tunnel-name <name>      Named tunnel to run for --cf-hostname. Defaults to buzzassist-canvas.

ngrok (fallback: --provider ngrok):
  --ngrok-authtoken <token>    Configure ngrok before starting. Also reads BUZZASSIST_NGROK_AUTHTOKEN or NGROK_AUTHTOKEN.
  --basic-auth                 Also enable ngrok Basic Auth. Off by default because some in-app browsers do not show the auth prompt.
  --user <name>                Basic Auth user. Defaults to buzzassist.
  --password <password>        Basic Auth password. Defaults to a generated password.
  --no-compression             Disable ngrok gzip compression.
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

// ---- Cross-platform background process management (replaces tmux) ----

// Resolve a bare command name to an absolute path so detached spawn works on
// Windows (PATHEXT) without a shell and without quoting hazards.
async function resolveExecutable(name) {
  if (name === process.execPath || name.includes("/") || name.includes("\\")) return name;
  const finder = isWindows ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(finder, [name]);
    const first = String(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
    return first || name;
  } catch {
    return name;
  }
}

function isProcessAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM"; // exists but owned by another user
  }
}

async function killProcessTree(pid) {
  const numeric = Number(pid);
  if (!isProcessAlive(numeric)) return false;
  if (isWindows) {
    try {
      await execFileAsync("taskkill", ["/pid", String(numeric), "/T", "/F"], { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }
  // Unix: a detached child leads its own process group (pgid == pid); signal
  // the whole group, then escalate to SIGKILL if it lingers.
  const signalGroup = (signal) => {
    try { process.kill(-numeric, signal); return true; }
    catch { try { process.kill(numeric, signal); return true; } catch { return false; } }
  };
  signalGroup("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  if (isProcessAlive(numeric)) signalGroup("SIGKILL");
  return true;
}

// Spawn a detached, backgrounded process that survives this CLI exiting. Env
// and cwd are passed directly (no shell string), so it is quoting-safe on
// every platform. Returns the child pid.
async function spawnBackground({ file, args, cwd, env, logFile }) {
  const resolved = await resolveExecutable(file);
  let stdio = ["ignore", "ignore", "ignore"];
  let logHandle = null;
  if (logFile) {
    logHandle = await open(logFile, "a");
    stdio = ["ignore", logHandle.fd, logHandle.fd];
  }
  try {
    const child = spawn(resolved, args, { cwd, env, detached: true, stdio, windowsHide: true });
    child.unref();
    if (!child.pid) throw new Error(`Failed to start ${file} (no pid).`);
    return child.pid;
  } finally {
    if (logHandle) await logHandle.close();
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
  const provider = String(readArg("--provider") || process.env.BUZZASSIST_TUNNEL_PROVIDER || "cloudflare").toLowerCase();
  return {
    projectDir,
    canvasDir,
    provider: provider === "ngrok" ? "ngrok" : "cloudflare",
    cfHostname: readArg("--cf-hostname") || process.env.BUZZASSIST_TUNNEL_CF_HOSTNAME || "",
    cfTunnelName: readArg("--cf-tunnel-name") || process.env.BUZZASSIST_TUNNEL_CF_NAME || "buzzassist-canvas",
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

function cloudflaredInstallHelp() {
  return [
    "cloudflared is required for the Cloudflare Canvas Tunnel.",
    "Install it:",
    "  macOS:   brew install cloudflared",
    "  Windows: winget install Cloudflare.cloudflared",
    "  Linux:   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
    "The default quick tunnel needs no account. For a fixed canvas.buzzassist.ai URL, run",
    "`cloudflared tunnel login` once, then `--cf-hostname canvas.buzzassist.ai`.",
  ].join("\n");
}

async function ensureCloudflaredReady(config) {
  if (!await commandAvailable("cloudflared", ["--version"])) {
    throw new Error(cloudflaredInstallHelp());
  }
  if (config.cfHostname) {
    // Named tunnel needs the account cert produced by `cloudflared tunnel login`.
    let hasCert = false;
    try {
      await execFileAsync("test", ["-f", join(process.env.HOME || "", ".cloudflared", "cert.pem")]);
      hasCert = true;
    } catch {
      hasCert = false;
    }
    if (!hasCert) {
      throw new Error([
        `A fixed hostname (${config.cfHostname}) needs a logged-in cloudflared.`,
        "Run `cloudflared tunnel login`, then `cloudflared tunnel create ${config.cfTunnelName}`,",
        "or omit --cf-hostname to use a zero-config quick tunnel.",
      ].join("\n"));
    }
  }
}

async function ensureProviderReady(config) {
  if (config.provider === "ngrok") return ensureNgrokReady(config);
  return ensureCloudflaredReady(config);
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

// Environment for the managed canvas server. Default: no cross-origin
// allowance at all (local origins only); the exact tunnel origin is pinned via
// EXCALIDRAW_ALLOWED_ORIGINS on the post-tunnel restart, so we never leave the
// wildcard *.ngrok*/*.trycloudflare* allowance enabled.
function canvasServerEnv(config, { allowedOrigin } = {}) {
  const env = { ...process.env };
  delete env.EXCALIDRAW_ALLOW_TUNNEL_ORIGINS;
  if (allowedOrigin) env.EXCALIDRAW_ALLOWED_ORIGINS = allowedOrigin;
  else delete env.EXCALIDRAW_ALLOWED_ORIGINS;
  env.EXCALIDRAW_TUNNEL_ACCESS_TOKEN = config.accessToken;
  env.EXCALIDRAW_PROJECT_DIR = config.projectDir;
  env.EXCALIDRAW_CANVAS_DIR = config.canvasDir;
  return env;
}

function canvasServerSpawn(config, paths, { port, allowedOrigin } = {}) {
  const args = [join(repoRoot, "scripts", "serve-canvas.mjs"), config.projectDir];
  if (port) args.push("--port", String(port), "--strict-port");
  return {
    file: process.execPath,
    args,
    cwd: repoRoot,
    env: canvasServerEnv(config, { allowedOrigin }),
    logFile: paths.serverLogFile,
  };
}

function tunnelSpawn(config, paths, localBaseUrl) {
  if (config.provider === "ngrok") {
    const args = ["http"];
    if (config.compression) args.push("--compression");
    if (config.basicAuth) args.push("--basic-auth", `${config.user}:${config.password}`);
    args.push("--log", paths.logFile, "--log-format", "json", localBaseUrl);
    return { file: "ngrok", args, cwd: repoRoot, env: process.env, logFile: null };
  }
  // Cloudflare: quick tunnel (zero-config) unless a named hostname is set.
  // Global flags (--no-autoupdate, --loglevel) MUST precede the subcommand; a
  // named `run` errors out on a trailing global flag. Output is captured via
  // stdio→logFile (spawnBackground) rather than --logfile, which keeps the
  // quick-tunnel URL parseable and avoids the same flag-position problem.
  const args = config.cfHostname
    ? ["--no-autoupdate", "--loglevel", "info", "tunnel", "run", "--url", localBaseUrl, config.cfTunnelName]
    : ["--no-autoupdate", "--loglevel", "info", "tunnel", "--url", localBaseUrl];
  return { file: "cloudflared", args, cwd: repoRoot, env: process.env, logFile: paths.logFile };
}

function portFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.port ? Number(parsed.port) : (parsed.protocol === "https:" ? 443 : 80);
  } catch {
    return 0;
  }
}

async function ensureLocalCanvas(config, paths, previous) {
  const configuredUrl = String(config.localUrl || "").replace(/\/+$/, "");
  if (configuredUrl) {
    if (!await checkHttp(configuredUrl)) {
      throw new Error(`Configured local canvas URL is not reachable: ${configuredUrl}`);
    }
    return { localBaseUrl: configuredUrl, managedCanvas: false, canvasPid: null };
  }

  const discoveredUrl = await readDiscoveredLocalUrl(paths);
  if (config.reuseLocal && discoveredUrl && await checkHttp(discoveredUrl)) {
    return { localBaseUrl: discoveredUrl, managedCanvas: false, canvasPid: null };
  }

  // Reuse a still-running managed server from a previous start.
  if (isProcessAlive(previous?.canvasPid) && discoveredUrl && await checkHttp(discoveredUrl)) {
    return { localBaseUrl: discoveredUrl, managedCanvas: true, canvasPid: previous.canvasPid };
  }

  const startedAt = Date.now() - 1000;
  const canvasPid = await spawnBackground(canvasServerSpawn(config, paths));
  const localBaseUrl = await waitForLocalCanvas(paths, { updatedAfterMs: startedAt });
  return { localBaseUrl, managedCanvas: true, canvasPid };
}

// Restart the managed canvas server on the same port, this time allowing only
// the exact public tunnel origin. The tunnel keeps pointing at the fixed port
// and reconnects across the brief restart. Returns the new pid.
async function pinManagedCanvasOrigin(config, paths, { port, allowedOrigin, canvasPid }) {
  if (!port) throw new Error("Cannot pin tunnel origin without a fixed local port.");
  const startedAt = Date.now() - 1000;
  await killProcessTree(canvasPid);
  const newPid = await spawnBackground(canvasServerSpawn(config, paths, { port, allowedOrigin }));
  await waitForLocalCanvas(paths, { updatedAfterMs: startedAt });
  return newPid;
}

function parseCloudflaredQuickUrl(logText) {
  const match = String(logText || "").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return match ? match[0] : "";
}

async function waitForCloudflaredUrl(paths) {
  const started = Date.now();
  while (Date.now() - started < START_TIMEOUT_MS) {
    let logText = "";
    try {
      logText = await readFile(paths.logFile, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const url = parseCloudflaredQuickUrl(logText);
    if (url) return url;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  throw new Error(`cloudflared quick tunnel URL was not assigned. Check ${paths.logFile}.`);
}

async function resolvePublicUrl(config, paths) {
  if (config.provider === "ngrok") return waitForPublicUrl(paths);
  if (config.cfHostname) return `https://${config.cfHostname.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  return waitForCloudflaredUrl(paths);
}

// Point the named tunnel's DNS at the canvas hostname (idempotent: an existing
// route errors, which we ignore).
async function ensureCloudflareDnsRoute(config) {
  if (config.provider !== "cloudflare" || !config.cfHostname) return;
  try {
    await execFileAsync("cloudflared", ["tunnel", "route", "dns", config.cfTunnelName, config.cfHostname], { timeout: 20_000 });
  } catch (error) {
    const message = String(error.stderr || error.message || "");
    if (!/already|exists|record with that host/i.test(message)) {
      throw new Error(`Failed to route ${config.cfHostname} to tunnel ${config.cfTunnelName}: ${message}`);
    }
  }
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
  console.log(`Canvas tunnel: ${active ? "running" : "not running"}${status.provider ? ` (${status.provider})` : ""}`);
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

function isTunnelRunning(status) {
  return isProcessAlive(status?.tunnelPid);
}

// Legacy cleanup: older versions kept tmux sessions instead of tracked pids.
// Kill any that still exist so upgrading never orphans a running tunnel.
async function killLegacyTmuxSessions(config, previous) {
  if (!await commandAvailable("tmux", ["-V"])) return false;
  const names = [...new Set([
    previous?.sessionName,
    previous?.canvasSessionName,
    config.sessionName,
    config.canvasSessionName,
    ...LEGACY_TUNNEL_SESSIONS,
  ].filter(Boolean))];
  let killed = false;
  for (const name of names) {
    if (await tmuxKillSession(name)) killed = true;
  }
  return killed;
}

async function start() {
  const config = resolveConfig();
  const paths = pathsFor(config);

  await ensureProviderReady(config);
  await ensureCloudflareDnsRoute(config);

  const previous = await readJson(paths.statusFile, null);
  if (isTunnelRunning(previous)) {
    if (!hasArg("--restart")) {
      printStatus(previous, { active: true });
      console.log("Use `npm run tunnel:start -- --restart` to replace the running tunnel.");
      return;
    }
    await killProcessTree(previous.tunnelPid);
  }
  // Always sweep any legacy tmux-based tunnel from older versions.
  await killLegacyTmuxSessions(config, previous);

  const { localBaseUrl, managedCanvas, canvasPid: initialCanvasPid } = await ensureLocalCanvas(config, paths, previous);
  let canvasPid = initialCanvasPid;
  await writeJson(paths.statusFile, {
    ok: false,
    state: "starting",
    provider: config.provider,
    localBaseUrl,
    managedCanvas,
    canvasPid,
    startedAt: new Date().toISOString(),
    statusFile: paths.statusFile,
    logFile: paths.logFile,
  });
  await writeFile(paths.logFile, "", { mode: 0o600 });

  const tunnelPid = await spawnBackground(tunnelSpawn(config, paths, localBaseUrl));

  let publicUrl;
  try {
    publicUrl = await resolvePublicUrl(config, paths);
  } catch (error) {
    await killProcessTree(tunnelPid);
    if (managedCanvas) await killProcessTree(canvasPid);
    throw error;
  }
  const accessUrl = `${publicUrl.replace(/\/+$/, "")}/?t=${encodeURIComponent(config.accessToken)}`;

  // Now that the public URL exists, lock the managed canvas server's CORS
  // allow-list to exactly that origin (replacing the local-only default) so
  // no other site can drive the tunnel-exposed APIs.
  if (managedCanvas) {
    const localPort = portFromUrl(localBaseUrl);
    try {
      canvasPid = await pinManagedCanvasOrigin(config, paths, { port: localPort, allowedOrigin: publicUrl, canvasPid });
    } catch (error) {
      await killProcessTree(tunnelPid);
      await killProcessTree(canvasPid);
      throw new Error(`Failed to pin tunnel origin (${publicUrl}); tore down the tunnel: ${error.message}`);
    }
  }

  const status = {
    ok: true,
    state: "running",
    provider: config.provider,
    tunnelPid,
    canvasPid,
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
  printStatus(status, { active: isProcessAlive(tunnelPid) });
  printTunnelHealth(await probeTunnelAccessUrl(status));
}

async function status() {
  const config = resolveConfig();
  const paths = pathsFor(config);
  const current = await readJson(paths.statusFile, null);
  const active = isTunnelRunning(current);
  printStatus(current, { active });
  if (active) printTunnelHealth(await probeTunnelAccessUrl(current));
}

async function stop() {
  const config = resolveConfig();
  const paths = pathsFor(config);
  const previous = await readJson(paths.statusFile, null);

  const killed = await killProcessTree(previous?.tunnelPid);
  // The canvas server we started for the tunnel carries a widened CORS
  // allow-list; leaving it running kept a tunnel-configured server bound to
  // .server.json after the tunnel was gone. Tear it down too when we managed it.
  const canvasKilled = previous?.managedCanvas === false ? false : await killProcessTree(previous?.canvasPid);
  // Sweep any legacy tmux sessions from older versions as well.
  const legacyKilled = await killLegacyTmuxSessions(config, previous);

  await writeJson(paths.statusFile, {
    ...(previous && typeof previous === "object" ? previous : {}),
    ok: false,
    state: "stopped",
    stoppedAt: new Date().toISOString(),
    tunnelKilled: killed,
    canvasKilled,
    legacyKilled,
    statusFile: paths.statusFile,
    logFile: paths.logFile,
  });
  const parts = [];
  if (killed) parts.push("tunnel");
  if (canvasKilled) parts.push("managed canvas server");
  if (legacyKilled) parts.push("legacy session");
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
