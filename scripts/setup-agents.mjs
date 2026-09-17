#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { resolveCodexCommand } from "./codex-image-bridge.mjs";
import {
  isCompatibleCanvasServerStatus,
  terminateDiscoveredCanvasServer,
} from "../lib/canvasServerRuntime.mjs";
import {
  SUPPORTED_SETUP_AGENTS,
  assertSupportedNodeVersion,
  claudeDesktopConfigPathForPlatform,
  commandNameForPlatform,
  detectSetupAgent,
  hostInstallHelp,
  normalizeSetupAgentName,
} from "../lib/setupAgents.mjs";
import {
  KOYA_REVIEWER_TRUST_JSON_ENV,
  KOYA_REVIEWER_TRUST_PATH_ENV,
  REVIEWER_TRUST_JSON_ENV,
  REVIEWER_TRUST_PATH_ENV,
  reviewerTrustEnvSource,
} from "../lib/koyaReviewAttestation.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginName = "buzzassist";
const marketplaceName = "buzzassist";
const legacyMarketplaceName = "buzzassist-local";
const personalMarketplaceName = "personal";
const homeDir = resolve(process.env.BUZZASSIST_SETUP_HOME || homedir());
const managedPluginDir = join(homeDir, "plugins", pluginName);
const managedPluginRoot = join(managedPluginDir, "plugin");
const personalMarketplacePath = join(homeDir, ".agents", "plugins", "marketplace.json");
// Imports are used by distribution verification. Never inherit an importing
// process's CLI flags and, most importantly, never run setup unless this file
// is the actual Node entrypoint.
const isDirectExecution = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const argv = isDirectExecution ? process.argv.slice(2) : [];
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

// ---- reviewer 信頼リスト env の MCP host への伝播（R6-F2） -----------------------------------
//
// reviewer attestation の唯一の信頼アンカーは運営者 env（BUZZASSIST_REVIEWER_TRUST /
// _JSON、旧 KOYA_ 名は互換）。CLI はシェルの env をそのまま読むが、MCP server は host
// （Codex / Claude Code）が起動する子プロセスで、host が親 env を渡すとは限らない。
// Codex は `env_vars`（**名前の一覧**）に挙げた変数だけを親 env から転送し、Claude Code は
// 自身の process env を継承させる。どちらの host でも「値は host を起動したシェルに置き、
// 設定ファイルには名前しか書かない」で同じ挙動になる。
//
// **設定ファイルに信頼リストの path・本文・鍵を埋め込まない。** .mcp.json は配布・同期・
// plugin cache へコピーされる。値が入れば、要求側の入力で信頼アンカーが立つ（自己承認へ
// 退化）か、運営者の秘密の置き場が配布物に載る。withReviewerTrustEnvPassthrough は
// env に信頼リスト名のキーがあれば fail-closed で拒否する。
export const REVIEWER_TRUST_ENV_PASSTHROUGH = Object.freeze([
  REVIEWER_TRUST_PATH_ENV,
  REVIEWER_TRUST_JSON_ENV,
  KOYA_REVIEWER_TRUST_PATH_ENV,
  KOYA_REVIEWER_TRUST_JSON_ENV,
]);
export const REVIEWER_TRUST_PASSTHROUGH_NOTE =
  `Reviewer trust anchor: this file names the env vars (${REVIEWER_TRUST_ENV_PASSTHROUGH.join(", ")}) that the host must pass through to the MCP server and never stores their values. `
  + "The operator sets BUZZASSIST_REVIEWER_TRUST (path to the trust-list JSON) or BUZZASSIST_REVIEWER_TRUST_JSON in the environment of the shell/launcher that starts Codex or Claude Code; "
  + "Codex forwards exactly the names listed in env_vars, Claude Code inherits its own process environment. Do not write the trust list path, its body, or any key material into this file.";
const TRUST_MATERIAL_IN_CONFIG = /"reviewers"\s*:\s*\[|-----BEGIN [A-Z ]*(?:PRIVATE|PUBLIC) KEY-----/u;

function* stringValues(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "string") { yield value; return; }
  if (Array.isArray(value)) { for (const item of value) yield* stringValues(item, depth + 1); return; }
  if (typeof value === "object") { for (const item of Object.values(value)) yield* stringValues(item, depth + 1); }
}

/**
 * MCP server 設定に信頼リスト env の **名前だけ** を passthrough として付ける。
 * env に信頼リスト名の値があれば投げる（設定ファイルへ値を書く経路を塞ぐ）。
 */
export function withReviewerTrustEnvPassthrough(serverConfig) {
  const env = serverConfig?.env && typeof serverConfig.env === "object" ? serverConfig.env : {};
  const embedded = Object.keys(env).filter((key) => REVIEWER_TRUST_ENV_PASSTHROUGH.includes(key));
  if (embedded.length > 0) {
    throw new Error(
      `reviewer-trust-in-config: MCP server config must not embed ${embedded.join(", ")}. `
      + "The trust list is an operator-side host environment variable; config files only name it (env_vars).",
    );
  }
  for (const text of stringValues(serverConfig)) {
    if (TRUST_MATERIAL_IN_CONFIG.test(text)) {
      throw new Error("reviewer-trust-in-config: MCP server config contains trust-list or key material; only env var names are allowed.");
    }
  }
  const existing = Array.isArray(serverConfig?.env_vars) ? serverConfig.env_vars.filter((name) => typeof name === "string") : [];
  const env_vars = [...new Set([...existing, ...REVIEWER_TRUST_ENV_PASSTHROUGH])];
  return { ...serverConfig, env_vars };
}

/**
 * setup を起動したシェルに信頼リスト env が見えるかを、値を印字せずに報告する。
 * GUI から起動した host が同じ env を見るとは限らないので scope を併記する。
 */
export function reviewerTrustEnvStatus(env = process.env) {
  try {
    const source = reviewerTrustEnvSource(env);
    if (!source) return { configured: "no", source: "none" };
    return { configured: "yes", source: source.trustJson ? "inline-json" : "path" };
  } catch (error) {
    return { configured: "ambiguous", source: "env-ambiguous", reason: String(error?.message || error).split(":").slice(0, 3).join(":") };
  }
}

function usage() {
  return `Usage: node scripts/setup-agents.mjs [options]

Options:
  --agent <name>         Configure one host: codex, claude-desktop, claude, cursor, antigravity.
  --agents <names>       Configure a comma-separated host list. Used by the safe updater.
  --host <name>          Alias for --agent.
  --all-agents           Configure all supported hosts. Not used by default.
  --project-dir <path>   Project whose canvas/ directory should store state.
  --canvas-dir <path>    Override canvas data directory.
  --dry-run              Print commands without changing host config.
  --skip-install         Do not run npm install.
  --skip-build           Do not run npm run build.
  --skip-plugin-source   Do not refresh ~/plugins/buzzassist.
  --no-launch            Do not start the canvas service.
  --no-auto-update       Do not register the daily safe updater for Codex/Claude Code.
  --allow-harness-not-ready
                         Diagnostic/canvas-only mode: report missing video-harness prerequisites without failing setup.
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
  const explicitMany = readArg("--agents", "");
  if (explicitMany) {
    const resolved = [];
    for (const value of explicitMany.split(",")) {
      const normalized = normalizeSetupAgentName(value.trim());
      if (!normalized || !supportedAgents.includes(normalized)) throw new Error(`Unsupported setup agent: ${value}`);
      if (!resolved.includes(normalized)) resolved.push(normalized);
    }
    if (resolved.length === 0) throw new Error("--agents requires at least one supported host.");
    return resolved;
  }
  const explicit = readArg("--agent", readArg("--host", null));
  return [normalizeSetupAgentName(explicit) || detectSetupAgent({ env: process.env, argv: process.argv })];
}

const dryRun = hasArg("--dry-run");
const skipInstall = hasArg("--skip-install");
const skipBuild = hasArg("--skip-build");
const skipPluginSource = hasArg("--skip-plugin-source");
const launchCanvas = !hasArg("--no-launch");
const enableAutoUpdate = !hasArg("--no-auto-update");
const allowHarnessNotReady = hasArg("--allow-harness-not-ready");
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

// このプラグインは PUBLIC な配布物なので、特定チャンネルの番組設定・
// キャスト・承認記録を同梱しない。ジャンル共通の契約とスキルだけを配る。
// 以前は config/ を丸ごとコピーしており、show bible と character styling が
// そのまま配布されていた（配布テストもその存在を要求していた）。
// 配布物に入れてよいものを**列挙する**（allowlist）。
//
// 以前は「入れないもの」を4件挙げる denylist だった。新しいチャンネル固有の
// ファイルが1つ増えるたびに、除外リストへの追加を人が覚えていないと公開される
// ——秘密の境界が人の記憶に依存する fail-open 設計。実際、
// koya-location-bible.json / harness-deployments.json / episode-overrides の
// 3件が漏れていた。harness-deployments.json に至っては、自分自身に
// 「クライアント固有なので共有しない」と書いてありながら配布されていた。
//
// config/ の直下だけは列挙する。ここがチャンネル固有物の集まる場所で、
// lib/ や scripts/ のように「全部ジャンル共通」と言い切れないため。
export const DISTRIBUTABLE_CONFIG_ENTRIES = Object.freeze([
  "harness-deployments.example.json",   // 例。実体（harness-deployments.json）は運営者固有
  "harnesses",                          // ハーネス宣言。名前を含まない
  "koya-manga-legacy-migrations.json",
  "koya-manga-production-contract.json",
  "koya-manga-production-contract.schema.json",
  "koya-manga-quality-incidents.json",
  "koya-manga-episode-overrides",       // モデル選択の上書き。固有情報を含まない
  "koya-reading-dictionary.json",
  "parallel-plans",
]);

// パス要素として、どこに現れても配布しないもの（ディレクトリ名もファイル名も見る）。
// allowlist の網から漏れた場合の二重の歯止め。
//
// proposals.jsonl / applied.jsonl は本文つきの学習台帳。共有層宛でも evidence に
// 顧客識別子・端末 path が残るので、配布物へは harness-curator の export-public が
// 作る proposals.public.jsonl（本文なし）だけを入れる（2026-09-05 独立レビュー D-2）。
// ここに置くことで、コピー元の一覧を誰かが書き戻しても staging 検査で止まる。
const NEVER_DISTRIBUTE = new Set([
  "channel-packs", "client-work", ".codex-tmp", "node_modules",
  "proposals.jsonl", "applied.jsonl",
]);

function isChannelPackPath(sourcePath, repoRootPath = repoRoot) {
  const parts = sourcePath.split(sep);
  if (parts.some((part) => NEVER_DISTRIBUTE.has(part))) return true;
  // config/ 直下は列挙されたものだけ通す。
  const relative = sourcePath.startsWith(repoRootPath) ? sourcePath.slice(repoRootPath.length).split(sep).filter(Boolean) : parts;
  if (relative[0] === "config" && relative.length >= 2) {
    return !DISTRIBUTABLE_CONFIG_ENTRIES.includes(relative[1]);
  }
  return false;
}

async function copyIfExists(source, target) {
  if (!(await pathExists(source))) return;
  await cp(source, target, {
    recursive: true,
    force: true,
    dereference: false,
    filter: (src) => !isChannelPackPath(src),
  });
}

/**
 * Inspect exactly what host plugin managers will stage.
 *
 * A node_modules directory symlink used to point back at the checkout. Codex
 * followed it while caching the local plugin and recursively copied hundreds
 * of megabytes. The staged source is now dependency-free; start-mcp installs
 * its manifest dependencies on first use. Reject symlinks and forbidden roots
 * here so a later copy-rule change cannot silently recreate that recursion.
 */
export async function verifyStagedPluginContents(pluginRoot) {
  const required = [
    "package.json",
    "package-lock.json",
    ".mcp.json",
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    "mcp/server.mjs",
    "config/harness-deployments.example.json",
    "lib/harnessDeploymentResolver.mjs",
    "lib/narratedStoryOutcome.mjs",
    "lib/narratedStoryPipeline.mjs",
    "lib/narratedStoryVideo.mjs",
    "scripts/narrated-story-video.mjs",
    "scripts/start-mcp.mjs",
    "scripts/verify-plugin-runtime.mjs",
  ];
  for (const relative of required) {
    if (!(await pathExists(join(pluginRoot, relative)))) {
      throw new Error(`Staged BuzzAssist plugin is missing required file: ${relative}`);
    }
  }

  let fileCount = 0;
  let totalBytes = 0;
  const visit = async (directory, relativeRoot = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = relativeRoot ? join(relativeRoot, entry.name) : entry.name;
      const parts = relative.split(sep);
      if (parts.some((part) => NEVER_DISTRIBUTE.has(part))) {
        throw new Error(`Forbidden path entered staged BuzzAssist plugin: ${relative}`);
      }
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Symlink entered staged BuzzAssist plugin: ${relative}`);
      }
      if (entry.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Unsupported staged file type: ${relative}`);
      const details = await lstat(absolute);
      fileCount += 1;
      totalBytes += details.size;
    }
  };
  await visit(pluginRoot);

  const configRoot = join(pluginRoot, "config");
  if (await pathExists(configRoot)) {
    const unexpected = (await readdir(configRoot)).filter((name) => !DISTRIBUTABLE_CONFIG_ENTRIES.includes(name));
    if (unexpected.length > 0) {
      throw new Error(`Staged config is outside the distribution allowlist: ${unexpected.join(", ")}`);
    }
  }
  return { ok: true, fileCount, totalBytes, nodeModulesIncluded: false, symlinksIncluded: false };
}

async function replaceDirectoryChildrenPreservingRoot(sourceDir, targetDir, { preserveNames = [] } = {}) {
  await mkdir(targetDir, { recursive: true });
  const preserved = new Set(preserveNames);
  const sourceNames = (await readdir(sourceDir)).filter((name) => !preserved.has(name));
  const sourceSet = new Set(sourceNames);

  for (const name of sourceNames) {
    const sourcePath = join(sourceDir, name);
    const targetPath = join(targetDir, name);
    const previousPath = join(targetDir, `.${name}.previous-${process.pid}`);
    await rm(previousPath, { recursive: true, force: true });
    if (await pathExists(targetPath)) await rename(targetPath, previousPath);
    await rename(sourcePath, targetPath);
    await rm(previousPath, { recursive: true, force: true });
  }

  for (const name of await readdir(targetDir)) {
    if (preserved.has(name) || sourceSet.has(name) || name.endsWith(`.previous-${process.pid}`)) continue;
    await rm(join(targetDir, name), { recursive: true, force: true });
  }
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
    "config",
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

  // ハーネスの正本スキルを、ホストが実際に読む場所へ置く。
  //
  // plugin.json の "skills" は ./skills/ を指している。正本は .agents/skills/ に
  // あり、プラグインには同梱されていたが**その位置からは読み込まれない**ので、
  // 運営者が入れても manga-video-production も platform-craft も1つも
  // 有効にならなかった。CLAUDE.md が「必ず先に読め」と定めた正本が、
  // 配布物の中に在るのに届いていない状態だった。
  // 開発機ではリポジトリの .claude/skills アダプタが効くので気づけない。
/**
 * 配布先の深さに合わせて、スキル内の相対参照を1階層浅くする。
 *
 * 正本は `.agents/skills/<name>/SKILL.md`（リポジトリルートまで ../../../）、
 * 配布先は `skills/<name>/SKILL.md`（プラグインルートまで ../../）。
 * 書き換えずに配ると、全ての参照がプラグインの外を指す。
 */
async function rewriteSkillRelativeDepth(skillDir) {
  for (const entry of await readdir(skillDir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = join(entry.parentPath ?? entry.path ?? skillDir, entry.name);
    const original = await readFile(filePath, "utf8");
    const rewritten = original.replaceAll("../../../", "../../");
    if (rewritten !== original) await writeFile(filePath, rewritten, "utf8");
  }
}

  const canonicalSkillsRoot = join(repoRoot, ".agents", "skills");
  const shippedSkillsRoot = join(tmpPluginRoot, "skills");
  let shippedHarnessSkills = 0;
  if (existsSync(canonicalSkillsRoot)) {
    for (const entry of await readdir(canonicalSkillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const source = join(canonicalSkillsRoot, entry.name);
      if (!existsSync(join(source, "SKILL.md"))) continue;
      const destination = join(shippedSkillsRoot, entry.name);
      await copyIfExists(source, destination);
      // 正本は .agents/skills/<name>/ にあり、配布先は skills/<name>/ で
      // 1階層浅い。相対参照をそのまま持ち込むと全部プラグインの外を指す。
      await rewriteSkillRelativeDepth(destination);
      shippedHarnessSkills += 1;
    }
  }
  if (shippedHarnessSkills === 0) {
    throw new Error(
      "ハーネスの正本スキルを1つも配布物へ入れられませんでした。"
      + ".agents/skills/<name>/SKILL.md を確認してください"
      + "（スキルの無い配布物は、MCP は動いても手順の正本が届かない）。",
    );
  }

  for (const fileName of [
    ".mcp.json",
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    "README.md",
    "SETUP.md",
    // 要求台帳と番組ガバナンスはチャンネル固有なので配布しない。
    // それらは Channel Pack 側（運営者の手元）にあり、共有される
    // 配布物に入れると、パックを分離した意味が無くなる。
    //
    // 一方、スキルが参照する運用 runbook と測定証跡はジャンル／
    // プラットフォーム層のもので、これが無いと配布先には**手順名だけが届き、
    // 手順の実体と測定根拠を読めない**。固有語を含まないことは
    // audit-public-surface で確認済み。
    "docs/koya-harness-handoff-ja.md",
    "docs/koya-character-gate-runbook-ja.md",
    "docs/koya-voice-quality-runbook-ja.md",
    "docs/learning/targets.json",
    // 本文つき台帳（proposals.jsonl）は配布しない。公開版 catalog だけ。
    "docs/learning/proposals.public.jsonl",
    "docs/measurements/parallel-limits-2026-08-28.json",
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
      buzzassist_mcp: withReviewerTrustEnvPassthrough({
        title: "BuzzAssist Local Canvas MCP",
        description: "Start and control the current host workspace's project-local BuzzAssist Excalidraw canvas.",
        command: process.execPath,
        args: [join(managedPluginRoot, "scripts", "start-mcp.mjs")],
        cwd: managedPluginRoot,
        env: {
          EXCALIDRAW_ALLOW_WIDGET_ORIGINS: "1",
          EXCALIDRAW_PROJECT_DIR: projectDir,
          EXCALIDRAW_CANVAS_DIR: canvasDir,
        },
        note: "Primary local MCP server. EXCALIDRAW_PROJECT_DIR is only the setup fallback: tool calls resolve the current host workspace and use <current-project>/canvas. The server writes that project's canvas/.server.json with its dynamic local URL. "
          + REVIEWER_TRUST_PASSTHROUGH_NOTE,
      }),
    },
  });

  // Dependencies are deliberately absent from the host-staged source.
  // scripts/start-mcp.mjs installs the package manifest on first use. Keeping
  // node_modules here (as either a directory or symlink) makes Codex/Claude
  // plugin caches recursively duplicate the checkout's entire dependency tree.
  await rm(join(tmpPluginRoot, "node_modules"), { recursive: true, force: true });
  await rm(join(tmpPluginRoot, "canvas"), { recursive: true, force: true });
  const staged = await verifyStagedPluginContents(tmpPluginRoot);
  console.log(`Verified staged plugin: ${staged.fileCount} files / ${staged.totalBytes} bytes / node_modules=absent / symlinks=absent`);
  // Keep both stable directory inodes alive while refreshing their children.
  // Existing canvas/MCP processes may use either directory as cwd; deleting
  // the roots makes their next shell command fail with getcwd/ENOENT.
  await mkdir(managedPluginRoot, { recursive: true });
  await replaceDirectoryChildrenPreservingRoot(tmpPluginRoot, managedPluginRoot);
  await replaceDirectoryChildrenPreservingRoot(tmpDir, managedPluginDir, { preserveNames: ["plugin"] });
  await rm(tmpDir, { recursive: true, force: true });
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

  const codexSelector = `${pluginName}@${marketplaceName}`;
  // `plugin add` installs the current marketplace snapshot alongside any old
  // version. Do not remove first: an active Codex task may still have its MCP
  // process rooted in the previous version's cache directory.
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
  // Claude Code has a non-destructive update command. Preserve the old cache
  // until active sessions finish instead of uninstalling it out from under them.
  const installed = await run(claude, ["plugin", claudeInstalled ? "update" : "install", claudeSelector, "--scope", "user"], {
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
  const config = withReviewerTrustEnvPassthrough({
    command: process.execPath,
    args: [join(pluginDir, "scripts", "start-mcp.mjs")],
    env: {
      EXCALIDRAW_ALLOW_WIDGET_ORIGINS: "1",
      EXCALIDRAW_PROJECT_DIR: projectDir,
      EXCALIDRAW_CANVAS_DIR: canvasDir,
    },
  });
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

After the script prints \`BUZZASSIST_CANVAS_URL=...\` and \`BUZZASSIST_CANVAS_CHECK=ok\`, first open that URL in Cursor's in-app browser or browser preview. Only if that capability is unavailable, use Chrome/the external-browser fallback.

If the user wants phone/mobile access or the exact same Excalidraw UI outside this machine, run setup with \`--tunnel\` or run \`npm run tunnel:start -- --project-dir <active-user-project-dir>\`. The tunnel uses Cloudflare (\`cloudflared\`) by default — no account is needed. If a system copy is not installed, BuzzAssist downloads the pinned official release into the user's \`~/.buzzassist/tools/\` cache, verifies its SHA-256 checksum, and runs it without administrator privileges. Use \`--no-auto-download\` or \`BUZZASSIST_CLOUDFLARED_AUTO_DOWNLOAD=0\` to opt out. Give the printed \`BUZZASSIST_TUNNEL_ACCESS_URL\` for the phone.
`;
}

function antigravityRuleBlock() {
  return `# BuzzAssist Agent Setup

When the user gives this repository URL and asks to set it up, do the setup end to end for Antigravity only.

1. Clone or open this repository.
2. Run \`node scripts/setup-agents.mjs --agent antigravity --project-dir <active-user-project-dir>\` from the repository root. If there is no separate active project, use this repository root as the project dir.
3. The script must configure Antigravity only. Do not configure Codex, Claude Code, or Cursor unless the user explicitly asks for those hosts too.
4. After the script prints \`BUZZASSIST_CANVAS_URL=...\` and \`BUZZASSIST_CANVAS_CHECK=ok\`, first open that URL in Antigravity's in-app browser. Only if that capability is unavailable, use Chrome/the external-browser fallback.
5. If the user wants phone/mobile access or says they want the exact same Excalidraw UI outside the machine, use Canvas Tunnel: run setup with \`--tunnel\` or run \`npm run tunnel:start -- --project-dir <active-user-project-dir>\`. The tunnel uses Cloudflare (\`cloudflared\`) by default — no account is needed. If a system copy is not installed, BuzzAssist downloads the pinned official release into the user's \`~/.buzzassist/tools/\` cache, verifies its SHA-256 checksum, and runs it without administrator privileges. Use \`--no-auto-download\` or \`BUZZASSIST_CLOUDFLARED_AUTO_DOWNLOAD=0\` to opt out. Give the printed \`BUZZASSIST_TUNNEL_ACCESS_URL\` for the phone.

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

export function parseAutoUpdateRegistrationOutput(stdout) {
  const values = new Map();
  for (const line of String(stdout || "").split(/\r?\n/gu)) {
    const match = line.match(/^(BUZZASSIST_AUTO_UPDATE(?:_[A-Z_]+)?)=(.*)$/u);
    if (match) values.set(match[1], match[2].trim());
  }
  const status = values.get("BUZZASSIST_AUTO_UPDATE") || "unknown";
  const provider = values.get("BUZZASSIST_AUTO_UPDATE_SCHEDULER") || "unknown";
  const schedulerCheck = values.get("BUZZASSIST_AUTO_UPDATE_SCHEDULER_CHECK") || "unknown";
  const schedule = values.get("BUZZASSIST_AUTO_UPDATE_SCHEDULE") || "unknown";
  const enabled = status === "enabled"
    && provider !== "unknown"
    && provider !== "manual"
    && schedulerCheck === "ok"
    && schedule === "daily-03:17-local-time";
  return {
    status,
    provider,
    schedulerCheck,
    schedule,
    enabled,
    manual: status === "manual" && schedule === "manual",
  };
}

async function configureAutoUpdate(pluginDir, results) {
  const hosts = targetAgents.filter((agent) => ["codex", "claude"].includes(agent) && results[agent]?.ok);
  if (hosts.length === 0) return null;
  if (!enableAutoUpdate) {
    console.log("Skipping automatic update registration.");
    return { enabled: false, hosts };
  }
  logStep("Registering safe automatic updates");
  if (dryRun) {
    console.log(`Would register daily stable-Release updates for ${hosts.join(", ")}.`);
    return { enabled: false, hosts, planned: true, dryRun: true };
  }
  const updater = join(pluginDir, "scripts", "auto-update.mjs");
  const registration = await run(process.execPath, [
    updater,
    "install",
    "--agent", hosts.join(","),
    "--marketplace-dir", managedPluginDir,
    "--plugin-root", pluginDir,
    "--project-dir", projectDir,
    "--canvas-dir", canvasDir,
    "--repository", "sam-mountainman/BuzzAssist",
  ], {
    timeoutMs: 120_000,
    env: { ...process.env, BUZZASSIST_SETUP_HOME: homeDir },
  });
  const verified = parseAutoUpdateRegistrationOutput(registration.stdout);
  if (verified.enabled) return { enabled: true, hosts, ...verified };
  if (verified.manual) return { enabled: false, manual: true, hosts, ...verified };
  throw new Error(
    "Auto-update installer returned success without a verified scheduler; refusing to report BUZZASSIST_AUTO_UPDATE=enabled.",
  );
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

async function readCanvasRuntimeStatus(discovery) {
  if (!discovery?.url) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(new URL('/api/canvas-clients', discovery.url), { signal: controller.signal });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
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
  const existingStatus = await readCanvasRuntimeStatus(existing);
  if (
    existing?.url &&
    (await isReachable(existing.url)) &&
    isCompatibleCanvasServerStatus(existingStatus, { canvasDir })
  ) {
    console.log(`Using existing canvas server: ${existing.url}`);
    return existing;
  }
  if (existingStatus) {
    const stopped = terminateDiscoveredCanvasServer(existing, { expectedCanvasDir: canvasDir });
    if (stopped) {
      console.log(`Restarting outdated canvas server: ${existing.url}`);
      await sleep(350);
    }
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
    const runtimeStatus = await readCanvasRuntimeStatus(discovery);
    if (
      discovery?.url &&
      (await isReachable(discovery.url)) &&
      isCompatibleCanvasServerStatus(runtimeStatus, { canvasDir })
    ) {
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

export async function runSetupAgents() {
  if (hasArg("--help") || hasArg("-h")) {
    console.log(usage());
    return { help: true };
  }
  assertSupportedNodeVersion();
  console.log("BuzzAssist setup");
  console.log(`Repository: ${repoRoot}`);
  console.log(`Project dir: ${projectDir}`);
  console.log(`Canvas dir: ${canvasDir}`);
  console.log(`Plugin source: ${managedPluginDir}`);
  console.log(`Agent target: ${targetAgents.map((agent) => agentLabels[agent]).join(", ")}`);

  // A clean clone may not be able to import the doctor until package
  // dependencies are installed. Bootstrap/build only the checkout first;
  // host configuration and managed plugin/cache staging remain behind the
  // fail-closed readiness gate below.
  await ensureDependencies();
  await ensureBuild();
  await ensureWidgetBuild();

  // ホストの設定が済んだことと、ハーネスが動かせることは別。ここを区別せずに
  // 「configured」だけ出していたので、運営者が最初の本番を回したときに
  // パイプラインの奥で生の ENOENT が出て止まっていた。
  //
  // 自動更新ブロックの中に置いていたせいで、対象外のホストと
  // --no-auto-update では yes/no/unknown のどれも出ないまま
  // 「configured」だけが見えていた——確認しなかったことが、
  // 確認して問題なかったことと区別できない状態。必ず1回出す。
  // 通常セットアップは fail-closed。Canvas単体の診断を続けたい場合だけ、
  // --allow-harness-not-ready という明示的な例外を要求する。
  let harnessReadinessError = null;
  try {
    const { runHarnessDoctor } = await import("./harness-doctor.mjs");
    const report = await runHarnessDoctor({ projectDir });
    console.log(`BUZZASSIST_HARNESS_READY=${report.ready ? "yes" : "no"}`);
    if (!report.ready) {
      harnessReadinessError = new Error(`BuzzAssist video harness prerequisites are missing: ${report.blocking.join(", ")}`);
      harnessReadinessError.exitCode = 2;
      console.log("動画ハーネスを回すには、まだ足りないものがあります:");
      for (const check of report.checks.filter((entry) => entry.required && !entry.ok)) {
        console.log(`  - ${check.id}: ${check.fix}`);
      }
      console.log("  詳しくは: node scripts/harness-doctor.mjs");
    } else if (report.advisory.length > 0) {
      console.log(`任意の前提が未充足（該当ゲートは skip されます）: ${report.advisory.join(", ")}`);
    }
    // doctor は setup を起動したシェルの環境を見ている。GUI ホストから
    // 起動したときに同じ環境が見えるとは限らないので、そのことを記録する。
    console.log("BUZZASSIST_HARNESS_READY_SCOPE=setup-shell-environment");
  } catch (error) {
    // 「確認できなかった」を「問題なし」に見せない。
    console.log("BUZZASSIST_HARNESS_READY=unknown");
    console.log(`  前提チェックを実行できませんでした: ${String(error?.message || error).slice(0, 160)}`);
    harnessReadinessError = new Error(`BuzzAssist video harness prerequisites could not be verified: ${error?.message || error}`);
    harnessReadinessError.exitCode = 2;
  }
  if (harnessReadinessError && !allowHarnessNotReady) {
    console.log("通常セットアップは fail-closed です。前提を直して同じコマンドを再実行してください。");
    console.log("診断またはCanvas単体の確認だけを続ける場合は --allow-harness-not-ready を明示してください。");
    throw harnessReadinessError;
  }
  if (harnessReadinessError) {
    console.log("BUZZASSIST_HARNESS_READY_OVERRIDE=diagnostic-only");
  }

  // A normal setup must not stage a plugin or modify host configuration before
  // returning HARNESS_READY=no. Only the explicit diagnostic override reaches
  // host/plugin mutation with missing prerequisites.
  const pluginDir = await refreshManagedPluginSource();

  const results = {};
  for (const agent of targetAgents) {
    results[agent] = await setupAgent(agent, pluginDir);
  }
  const autoUpdateStatus = await configureAutoUpdate(pluginDir, results);

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
  // reviewer 信頼リストの MCP 経路（R6-F2）。設定ファイルには env 名だけを書いたこと、
  // 値は host を起動するシェルに置くことを、値を印字せずに報告する。
  const trustEnv = reviewerTrustEnvStatus();
  console.log("BUZZASSIST_REVIEWER_TRUST_PASSTHROUGH=env-name-only");
  console.log(`BUZZASSIST_REVIEWER_TRUST_ENV_VARS=${REVIEWER_TRUST_ENV_PASSTHROUGH.join(",")}`);
  console.log(`BUZZASSIST_REVIEWER_TRUST_CONFIGURED=${trustEnv.configured}`);
  console.log("BUZZASSIST_REVIEWER_TRUST_SCOPE=setup-shell-environment");
  if (trustEnv.configured !== "yes") {
    console.log(trustEnv.configured === "ambiguous"
      ? `  ${REVIEWER_TRUST_PATH_ENV} と旧名 ${KOYA_REVIEWER_TRUST_PATH_ENV}（または _JSON）の両方が違う値で設定されています。どちらか1つにしてください（reviewer-trust-invalid:env-ambiguous）。`
      : `  ${REVIEWER_TRUST_PATH_ENV}（信頼リスト JSON の path）または ${REVIEWER_TRUST_JSON_ENV} が、この setup シェルには設定されていません。運営者が設定するまで reviewer signoff / RunReceipt は reviewer-trust-unconfigured で止まります（fail-closed）。`);
  }
  console.log("The MCP config names these env vars only (Codex: env_vars passthrough; Claude Code: inherits its process environment) and never stores their values. Set the value in the environment of the shell or launcher that starts Codex / Claude Code (GUI hosts do not see this setup shell's exports), then restart the host.");
  if (autoUpdateStatus?.enabled) {
    console.log("BUZZASSIST_AUTO_UPDATE=enabled");
    console.log(`BUZZASSIST_AUTO_UPDATE_SCHEDULER=${autoUpdateStatus.provider}`);
    console.log("BUZZASSIST_AUTO_UPDATE_SCHEDULER_CHECK=ok");
    console.log(`BUZZASSIST_AUTO_UPDATE_SCHEDULE=${autoUpdateStatus.schedule}`);
    console.log(`BUZZASSIST_AUTO_UPDATE_HOSTS=${autoUpdateStatus.hosts.join(",")}`);
    console.log("Stable GitHub Releases are checked daily at 03:17 local time. Updates are verified and rolled back on failure; restart the host to load a newly installed version.");
  } else if (autoUpdateStatus?.planned) {
    console.log("BUZZASSIST_AUTO_UPDATE=planned");
    console.log("BUZZASSIST_AUTO_UPDATE_SCHEDULE=not-registered-dry-run");
  } else if (autoUpdateStatus?.manual) {
    console.log("BUZZASSIST_AUTO_UPDATE=manual");
    console.log(`BUZZASSIST_AUTO_UPDATE_SCHEDULER=${autoUpdateStatus.provider}`);
    console.log("BUZZASSIST_AUTO_UPDATE_SCHEDULER_CHECK=manual");
    console.log("BUZZASSIST_AUTO_UPDATE_SCHEDULE=manual");
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
      console.log("For Codex, Claude Code, Cursor, or Antigravity, first open BUZZASSIST_CANVAS_URL in the host in-app browser. Only when that Browser capability is unavailable, use Chrome/the external-browser fallback.");
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
  return { results, harnessReady: !harnessReadinessError, discovery, canvasCheck, tunnelStatus };
}

if (isDirectExecution) {
  runSetupAgents().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  });
}
