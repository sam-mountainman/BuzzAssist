import { execFile as execFileCallback } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

function configuredHome(env) {
  return String(env.HOME || env.USERPROFILE || homedir() || "").trim();
}

function expandHome(value, env) {
  const text = String(value || "").trim();
  if (!/^~(?:[\\/]|$)/u.test(text)) return text;
  const home = configuredHome(env);
  if (!home) throw new Error("BON_CLI uses ~ but no HOME/USERPROFILE is available");
  const suffix = text.slice(1).replace(/^[\\/]+/u, "");
  return suffix ? join(home, ...suffix.split(/[\\/]+/u)) : home;
}

function looksLikePath(value) {
  return isAbsolute(value)
    || value.startsWith(".")
    || value.includes("/")
    || value.includes("\\")
    || extname(value).toLowerCase() === ".js";
}

async function exists(path, accessImpl) {
  try {
    await accessImpl(path);
    return true;
  } catch {
    return false;
  }
}

function invocationForPath(path, execPath) {
  if (extname(path).toLowerCase() === ".js") {
    return { command: execPath, argsPrefix: [path], source: "javascript-file" };
  }
  return { command: path, argsPrefix: [], source: "executable-file" };
}

/**
 * Locate the optional bestofn viewer without making a machine-local checkout
 * part of the production harness contract. BON_CLI is authoritative. A
 * checkout may also be supplied through BESTOFN_ROOT; otherwise local package
 * candidates are tried before the portable `bon` command on PATH.
 */
export async function resolveBestOfNInvocation({
  env = process.env,
  cwd = process.cwd(),
  execPath = process.execPath,
  accessImpl = access,
} = {}) {
  const explicit = expandHome(env.BON_CLI, env);
  if (explicit) {
    if (!looksLikePath(explicit)) {
      return { command: explicit, argsPrefix: [], source: "BON_CLI-command" };
    }
    const path = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
    if (!await exists(path, accessImpl)) {
      throw new Error(`BON_CLI does not exist: ${path}`);
    }
    return { ...invocationForPath(path, execPath), source: "BON_CLI-path" };
  }

  const candidates = [];
  if (String(env.BESTOFN_ROOT || "").trim()) {
    const configuredRoot = expandHome(env.BESTOFN_ROOT, env);
    const rootPath = isAbsolute(configuredRoot) ? configuredRoot : resolve(cwd, configuredRoot);
    candidates.push(join(rootPath, "bin", "bon.js"));
  }
  candidates.push(
    join(cwd, "node_modules", "bestofn", "bin", "bon.js"),
    join(cwd, "tools", "bestofn", "bin", "bon.js"),
  );

  for (const candidate of candidates) {
    if (await exists(candidate, accessImpl)) {
      return { ...invocationForPath(candidate, execPath), source: "discovered-file" };
    }
  }
  return { command: "bon", argsPrefix: [], source: "PATH" };
}

export async function runBestOfN(args, {
  env = process.env,
  cwd = process.cwd(),
  maxBuffer = 16 * 1024 * 1024,
  execFileImpl = execFile,
  ...resolverOptions
} = {}) {
  const invocation = await resolveBestOfNInvocation({ env, cwd, ...resolverOptions });
  try {
    const result = await execFileImpl(
      invocation.command,
      [...invocation.argsPrefix, ...args],
      { cwd, env, maxBuffer },
    );
    return { ...result, invocation };
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        "bestofn CLI (bon) was not found. Install/enable the bestofn plugin so `bon` is on PATH, "
        + "or set BON_CLI to an absolute bin/bon.js path.",
        { cause: error },
      );
    }
    throw error;
  }
}

export function formatBestOfNCommand(invocation, args = []) {
  return [invocation.command, ...invocation.argsPrefix, ...args]
    .map((part) => (/\s/u.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}

export function describeBestOfNInvocation(invocation) {
  return `${basename(invocation.command)} (${invocation.source})`;
}
