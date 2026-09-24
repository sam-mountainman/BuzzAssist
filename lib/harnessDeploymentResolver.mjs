import { constants as fsConstants, copyFileSync, existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function assertInside(root, target) {
  const delta = relative(resolve(root), resolve(target));
  if (delta.startsWith("..") || isAbsolute(delta) || delta.split(sep).includes("..")) {
    throw new Error(`Harness deployment entrypoint is outside its declared root: ${target}`);
  }
}

/** Parse the small argv-only deployment declaration language; shell syntax is intentionally unsupported. */
export function parseDeploymentEntrypoint(value) {
  const input = nonEmpty(value);
  if (!input) throw new Error("Harness deployment entrypoint is empty.");
  if (/[;&|<>\r\n\0]/u.test(input)) throw new Error("Harness deployment entrypoint contains unsupported shell syntax.");
  const tokens = [];
  let token = "";
  let quote = "";
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (char === quote) quote = "";
      else token += char;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (token) { tokens.push(token); token = ""; }
      continue;
    }
    token += char;
  }
  if (quote) throw new Error("Harness deployment entrypoint contains an unterminated quote.");
  if (token) tokens.push(token);
  if (tokens.length < 2 || !/^(?:node|node\.exe)$/iu.test(tokens[0])) {
    throw new Error("Harness deployment entrypoint must be an argv-only `node <script>` command.");
  }
  return tokens;
}

/** Resolve a declared internal runner without a shell or PATH-dependent Node binary. */
export function resolveHarnessDeploymentCommand(deployment, { additionalArgs = [] } = {}) {
  const root = resolve(nonEmpty(deployment?.root));
  if (!nonEmpty(deployment?.root)) throw new Error("Harness deployment root is empty.");
  const tokens = parseDeploymentEntrypoint(deployment?.entrypoint);
  const script = isAbsolute(tokens[1]) ? resolve(tokens[1]) : resolve(root, tokens[1]);
  assertInside(root, script);
  const suffix = Array.isArray(additionalArgs) ? additionalArgs.map(String) : [];
  return {
    command: process.execPath,
    args: [script, ...tokens.slice(2), ...suffix],
    cwd: root,
    entrypointPath: script,
    label: tokens.join(" "),
  };
}

/** Prefer an operator-local deployment map, with the packaged Core map as a portable fallback. */
export function loadHarnessDeployments({ repoRoot = MODULE_ROOT, deploymentPath = "" } = {}) {
  const root = resolve(repoRoot);
  const explicit = nonEmpty(deploymentPath);
  const candidates = explicit
    ? [resolve(explicit)]
    : [join(root, "config", "harness-deployments.json"), join(root, "config", "harness-deployments.example.json")];
  const sourcePath = candidates.find((candidate) => existsSync(candidate));
  if (!sourcePath) {
    throw new Error(`ハーネス配置マップを読めない: ${candidates.join(" または ")}`);
  }
  let parsed;
  try { parsed = JSON.parse(readFileSync(sourcePath, "utf8")); }
  catch (error) { throw new Error(`ハーネス配置マップを読めない: ${sourcePath}: ${error.message}`); }
  if (!Array.isArray(parsed?.deployments)) throw new Error(`ハーネス配置マップに deployments が無い: ${sourcePath}`);
  const byId = new Map();
  for (const row of parsed.deployments) {
    const harnessId = nonEmpty(row?.harnessId);
    const rootValue = nonEmpty(row?.root);
    const entrypoint = nonEmpty(row?.entrypoint);
    if (!harnessId || !rootValue || !entrypoint || /<[^>]+>/u.test(`${rootValue}${entrypoint}`)) {
      throw new Error(`未完成のハーネス配置がある: ${harnessId || "(idなし)"}`);
    }
    if (byId.has(harnessId)) throw new Error(`ハーネス配置が重複している: ${harnessId}`);
    const deploymentRoot = isAbsolute(rootValue) ? resolve(rootValue) : resolve(root, rootValue);
    const deployment = { harnessId, root: deploymentRoot, entrypoint, sourcePath };
    // Validate the argv-only shape while loading; existence is checked at plan/doctor time.
    resolveHarnessDeploymentCommand(deployment);
    byId.set(harnessId, deployment);
  }
  return byId;
}

/**
 * 運営者の配置表（追跡外の config/harness-deployments.json）が無いとき、例から作る。
 *
 * 例（harness-deployments.example.json）は root "." で、このリポジトリ自身に置いた配備なら
 * そのまま使える。既にあるものは決して上書きしない（運営者の配置先を消さない）。
 * harness-learn など配置表だけを読む経路が、真っさらな端末で「配置先が未設定」で止まらないように。
 */
export function ensureOperatorDeploymentMap({ repoRoot = MODULE_ROOT, dryRun = false } = {}) {
  const root = resolve(repoRoot);
  const target = join(root, "config", "harness-deployments.json");
  const example = join(root, "config", "harness-deployments.example.json");
  if (existsSync(target)) return { created: false, reason: "exists", path: target };
  if (!existsSync(example)) return { created: false, reason: "example-missing", path: target };
  if (dryRun) return { created: false, reason: "dry-run", path: target };
  try {
    // COPYFILE_EXCL: 同時に走った別の setup が先に作っていたら、そちらを残す。
    copyFileSync(example, target, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (error?.code === "EEXIST") return { created: false, reason: "exists", path: target };
    throw error;
  }
  return { created: true, reason: "copied-from-example", path: target, source: example };
}

export function resolveHarnessDeployment(harnessId, options = {}) {
  const deployments = options.deployments instanceof Map ? options.deployments : loadHarnessDeployments(options);
  const deployment = deployments.get(nonEmpty(harnessId));
  if (!deployment) throw new Error(`ハーネス ${harnessId} の配置が無い。config/harness-deployments.json を設定すること。`);
  return deployment;
}
