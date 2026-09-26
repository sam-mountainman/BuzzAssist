// Release のあとの受け入れ確認（読み取り中心）。本体の入口は scripts/release-acceptance.mjs。
//
// なぜ要るか: 自動更新は、確認の段を依存の無い置き場で行っていたため、0.1.26 以降の新しい版が
// 運営者の端末に一度も入っていなかった（0.1.30 で直した）。更新器の試験は模擬の置き場で通って
// いたので、誰も気づかなかった。模擬の環境では観測できない挙動がある——「配った版が本物の端末で
// 本当に入っていて、フックが登録され、MCP が起動するか」は本物の端末で確かめるしかない。
//
// ここが確かめること（ホストごと。Claude Code と Codex）:
//   (a) 版: ホストが有効にしている BuzzAssist の版が、最新の stable Release と同じか。
//       ホストの記録（Claude Code は ~/.claude/plugins/installed_plugins.json と settings.json の
//       enabledPlugins、Codex は ~/.codex/config.toml の plugin の記録と marketplace の置き場）と、
//       その置き場の manifest の版がそろっているかも見る
//   (b) フック: その版の置き場の plugin.json が指すフックの定義に、Release のフック
//       （UserPromptSubmit・Stop など、hooks/*.json にあるもの）が同じ形で入っているか。
//       起動する script が置き場にあり、読み込めるか。Claude Code は disableAllHooks で止められて
//       いないか、Codex は /hooks で信頼されているか
//   (c) MCP: ホストが起動するのと同じ定義（置き場の .mcp.json の buzzassist_mcp）で MCP を起動し、
//       道具の一覧と read_me の呼び出しが返るか。起動する server の置き場の版も比べる
//       （ホストの記録が新しくても、.mcp.json が古い置き場を指していれば古い MCP が動く）
//
// しないこと（どれも意図的）:
//   - ホストの設定・plugin・更新器の状態を書き換えない。MCP の project と canvas は一時フォルダへ向け、
//     運営者の canvas に触らない。依存が置き場に無いときは、置き場へ npm install しない
//     （同じ版の Release の展開先に依存があれば、一時フォルダの写しにつないで確かめる）
//   - 更新と同時に走らない。更新のロックがあれば何も確かめずに「更新中」で返す
//   - モデルを呼ばない。本物のセッションでフックが発火するかは、人が新しいセッションで確かめる
//     （手順は report の manualChecks）

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CODEX_HOOK_TRUST_FIX, inspectCodexHookTrust } from "./codexHookTrust.mjs";
import { readCodexPluginRecord, resolveHostPluginInstalls } from "./hostSkillSync.mjs";
import {
  BUZZASSIST_PLUGIN_SELECTOR,
  BUZZASSIST_REPOSITORY,
  compareVersions,
  fetchLatestStableRelease,
  hostsBehindVersion,
  normalizeVersion,
  releaseVersion,
  updaterPaths,
} from "./pluginAutoUpdate.mjs";
import { prepareVerificationRuntime, releaseSourceDir, resolveVerificationDependencies } from "./pluginRuntimeDependencies.mjs";

export const RELEASE_ACCEPTANCE_SCHEMA = "buzzassist-release-acceptance-v1";
export const ACCEPTANCE_HOSTS = Object.freeze(["claude", "codex"]);
export const REQUIRED_MCP_TOOLS = Object.freeze(["read_me", "open_buzzassist_canvas", "get_excalidraw_selection"]);
export const HOST_LABEL = Object.freeze({ claude: "Claude Code", codex: "Codex" });
const HOST_MANIFEST = Object.freeze({ claude: ".claude-plugin/plugin.json", codex: ".codex-plugin/plugin.json" });
const HOST_HOOK_FILE = Object.freeze({ claude: "hooks/claude-hooks.json", codex: "hooks/codex-hooks.json" });
// update-current.mjs と同じ。これより古いロックは、殺された更新の消し残しとみなす。
const UPDATE_LOCK_STALE_MS = 2 * 60 * 60 * 1000;
// doctor が更新器の記録（state.json の latestVersion）を最新の Release として使ってよい古さ。
// 更新器は1日1回確かめるので、取りこぼしの日を入れて3日。
export const UPDATER_STATE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const UPDATE_NOW_COMMAND = "npm run update:now（配布された置き場なら node ~/plugins/buzzassist/plugin/scripts/update-current.mjs --config ~/.buzzassist/updater/config.json）";
export const RELEASE_ACCEPTANCE_COMMAND = "node scripts/release-acceptance.mjs";

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function versionOf(value) {
  return normalizeVersion(value)?.raw || "";
}

/** 同じ中身かを、鍵の並びに左右されない形で比べる。 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** UserPromptSubmit → user_prompt_submit（Codex の信頼の表の鍵はこの形）。 */
export function codexHookEventKey(event) {
  return String(event).replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
}

// ---------------------------------------------------------------------------
// 最新の Release と更新器の状態

/**
 * 最新の stable Release の版。--expected-version があればネットワークに出ない。
 * 読めなければ version: null（確かめられなかった）を返し、合格にはしない。
 */
export async function resolveLatestRelease({ expectedVersion = "", fetchLatest = null, repository = BUZZASSIST_REPOSITORY, env = process.env, timeoutMs = 15_000 } = {}) {
  if (expectedVersion) {
    const version = versionOf(expectedVersion);
    if (!version) throw new Error(`--expected-version が版の形ではない: ${expectedVersion}`);
    return { version, source: "expected-version", repository };
  }
  try {
    const release = await (fetchLatest || fetchLatestStableRelease)({ repository, env, timeoutMs });
    return {
      version: releaseVersion(release),
      source: "github",
      repository,
      tagName: release?.tag_name || "",
      publishedAt: release?.published_at || "",
    };
  } catch (error) {
    return { version: null, source: "unavailable", repository, error: String(error?.message || error).slice(0, 200) };
  }
}

export function readUpdaterRecords(homeDir) {
  const paths = updaterPaths(homeDir);
  return { paths, config: readJson(paths.configPath), state: readJson(paths.statePath) };
}

/** 更新（update-current）が走っているか。ロックが2時間より古ければ消し残しとみなす。 */
export function updateLockState({ homeDir, now = Date.now() } = {}) {
  const { lockDir } = updaterPaths(homeDir);
  let details = null;
  try {
    details = statSync(lockDir);
  } catch {
    return { busy: false, lockDir };
  }
  const ageMs = now - details.mtimeMs;
  return { busy: ageMs <= UPDATE_LOCK_STALE_MS, stale: ageMs > UPDATE_LOCK_STALE_MS, lockDir, ageMs };
}

// ---------------------------------------------------------------------------
// ホストの記録

/** Claude Code の設定（~/.claude/settings.json）から、plugin の有効・無効と、フックの全停止を読む。 */
export function readClaudeHostSettings({ homeDir }) {
  const settingsPath = path.join(homeDir, ".claude", "settings.json");
  const settings = readJson(settingsPath);
  const value = settings?.enabledPlugins?.[BUZZASSIST_PLUGIN_SELECTOR];
  return {
    settingsPath,
    readable: settings !== null,
    enabled: value === true ? true : value === false ? false : null,
    disableAllHooks: settings?.disableAllHooks === true,
  };
}

function hostHomePresent(host, homeDir) {
  return existsSync(path.join(homeDir, host === "claude" ? ".claude" : ".codex"));
}

/**
 * ホストが有効にしている BuzzAssist の置き場・版・有効かどうか（読むだけ）。
 * 置き場と版の決め方は hostSkillSync（doctor の host-skill-sync と同じ関数）に任せる。
 */
export function inspectHostInstall({ host, homeDir, installs = resolveHostPluginInstalls({ homeDir }) }) {
  const install = installs.find((entry) => entry.host === host) || null;
  const base = { host, label: HOST_LABEL[host], hostPresent: hostHomePresent(host, homeDir) };
  let enabled = null;
  let enabledSource = "";
  let disableAllHooks = false;
  if (host === "claude") {
    const settings = readClaudeHostSettings({ homeDir });
    enabled = settings.enabled;
    enabledSource = settings.readable ? `${settings.settingsPath} の enabledPlugins` : `${settings.settingsPath} が読めない`;
    disableAllHooks = settings.disableAllHooks;
  } else {
    const record = readCodexPluginRecord({ homeDir });
    enabled = record.pluginRecorded ? record.enabled === true : null;
    enabledSource = record.readable ? "~/.codex/config.toml の [plugins.\"buzzassist@buzzassist\"]" : "~/.codex/config.toml が読めない";
  }
  if (!install) {
    // Codex の設定で無効にされていると、hostSkillSync は導入物として数えない。「入っていない」と
    // 言わずに「無効」と言えるよう、cache があるかを別に見る。
    const disabledInConfig = host === "codex" && enabled === false
      && existsSync(path.join(homeDir, ".codex", "plugins", "cache", "buzzassist", "buzzassist"));
    return { ...base, installed: false, disabledInConfig, enabled, enabledSource, disableAllHooks };
  }
  const manifest = readJson(path.join(install.root, ...HOST_MANIFEST[host].split("/")));
  return {
    ...base,
    installed: true,
    root: install.root,
    version: versionOf(install.version),
    versionSource: install.versionSource,
    estimated: install.estimated === true,
    estimateReason: install.estimateReason || "",
    manifestVersion: versionOf(manifest?.version),
    enabled,
    enabledSource,
    disableAllHooks,
  };
}

// ---------------------------------------------------------------------------
// フック

function hookDefinitionAt(root, host) {
  const manifestPath = path.join(root, ...HOST_MANIFEST[host].split("/"));
  const manifest = readJson(manifestPath);
  if (!manifest) return { error: `${HOST_MANIFEST[host]} が読めない` };
  if (typeof manifest.hooks !== "string" || !manifest.hooks.trim()) return { error: `${HOST_MANIFEST[host]} に hooks が無い（この版はフックを登録しない）` };
  const file = path.resolve(root, manifest.hooks);
  if (!isInside(root, file)) return { error: `${HOST_MANIFEST[host]} の hooks が置き場の外を指す: ${manifest.hooks}` };
  const definition = readJson(file);
  if (!definition || typeof definition.hooks !== "object" || definition.hooks === null) return { error: `${manifest.hooks} が読めない` };
  return { file, relative: manifest.hooks, definition };
}

function hookEvents(definition) {
  return Object.keys(definition?.hooks || {}).sort();
}

function hookCommands(definition, event) {
  return (definition?.hooks?.[event] || [])
    .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
    .map((hook) => String(hook?.command || ""));
}

/** フックの起動行から、起動する script の名前と、Codex 形の起動行が呼ぶ関数の名前を読む。 */
export function hookCommandTarget(command) {
  const text = String(command || "");
  const script = text.match(/scripts['"\\/,\s]+([A-Za-z0-9._-]+\.mjs)/u)?.[1] || "";
  const exportName = text.match(/\bm\.([A-Za-z_$][\w$]*)\s*\(/u)?.[1] || "";
  return { script, exportName };
}

/**
 * 期待するフックの定義の出どころ。最新の Release を更新器が展開した場所があればそれ
 * （その版で配ったもの）、無ければこの写し（source）の hooks/*.json。
 */
export function expectedHookSource({ homeDir, latestVersion = "", sourceRoot = SOURCE_ROOT } = {}) {
  if (latestVersion) {
    const releaseRoot = releaseSourceDir({ homeDir, version: latestVersion });
    if (ACCEPTANCE_HOSTS.every((host) => existsSync(path.join(releaseRoot, ...HOST_HOOK_FILE[host].split("/"))))) {
      return { root: releaseRoot, version: versionOf(readJson(path.join(releaseRoot, "package.json"))?.version) || latestVersion, kind: "release-extract" };
    }
  }
  return { root: sourceRoot, version: versionOf(readJson(path.join(sourceRoot, "package.json"))?.version), kind: "this-copy" };
}

function hookLoadProbe({ root, script, exportName, env, timeoutMs = 20_000 }) {
  const file = path.join(root, "scripts", script);
  const code = [
    "const [url, name] = process.argv.slice(1);",
    "const m = await import(url);",
    "if (name && typeof m[name] !== 'function') { process.stderr.write('export が無い: ' + name); process.exit(3); }",
  ].join("\n");
  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, pathToFileURL(file).href, exportName || ""], {
      cwd: root,
      // 読み込むだけ。万一 main が走っても、学習・完成前チェックの記録を書かない印を立てる。
      env: {
        ...env,
        BUZZASSIST_LEARNING_WRITE_FORBIDDEN: "1",
        BUZZASSIST_LEARNING_HOOK_LOG: "off",
        BUZZASSIST_STOP_HOOK: "off",
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* 終わっている */ }
      done({ ok: false, detail: `${script} の読み込みが ${timeoutMs}ms で終わらない` });
    }, timeoutMs);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => done({ ok: false, detail: `${script} を読み込めない: ${error.message}` }));
    child.on("close", (code) => done(code === 0
      ? { ok: true, detail: "" }
      : { ok: false, detail: `${script} を読み込めない（exit ${code}）: ${stderr.trim().slice(-300)}` }));
  });
}

/**
 * (b) その版の置き場に、Release のフックが登録されているか。
 * expected は期待する定義（Release の hooks/<host>-hooks.json）。
 */
export async function inspectHostHooks({ host, install, expected, homeDir, env = process.env, loadCheck = true }) {
  if (!install?.installed) {
    return { ok: false, status: "not-installed", detail: "BuzzAssist が入っていないので、フックも登録されていない", fix: "" };
  }
  const root = install.root;
  const found = hookDefinitionAt(root, host);
  if (found.error) {
    return { ok: false, status: "no-hooks", detail: found.error, fix: `${UPDATE_NOW_COMMAND} で最新の Release を入れ、ホストのセッションを開き直す` };
  }
  const expectedEvents = hookEvents(expected);
  const installedEvents = hookEvents(found.definition);
  const missingEvents = expectedEvents.filter((event) => !installedEvents.includes(event));
  const staleEvents = expectedEvents.filter((event) => installedEvents.includes(event)
    && canonicalJson(found.definition.hooks[event]) !== canonicalJson(expected.hooks[event]));
  const extraEvents = installedEvents.filter((event) => !expectedEvents.includes(event));
  const missingScripts = [];
  const loadFailures = [];
  const targets = [];
  for (const event of installedEvents) {
    for (const command of hookCommands(found.definition, event)) {
      const target = hookCommandTarget(command);
      if (!target.script) {
        missingScripts.push(`${event}: 起動行から script を読めない`);
        continue;
      }
      if (!existsSync(path.join(root, "scripts", target.script))) {
        missingScripts.push(`${event}: scripts/${target.script}`);
        continue;
      }
      targets.push({ event, ...target });
    }
  }
  if (loadCheck) {
    for (const target of targets) {
      const result = await hookLoadProbe({ root, script: target.script, exportName: target.exportName, env });
      if (!result.ok) loadFailures.push(`${target.event}: ${result.detail}`);
    }
  }

  const problems = [];
  const fixes = [];
  if (missingEvents.length) problems.push(`Release のフックが入っていない: ${missingEvents.join(", ")}`);
  if (staleEvents.length) problems.push(`定義が Release と違う（古い版の起動行）: ${staleEvents.join(", ")}`);
  if (extraEvents.length) problems.push(`Release に無いフックが残っている: ${extraEvents.join(", ")}`);
  if (missingScripts.length) problems.push(`起動する script が置き場に無い: ${missingScripts.join(", ")}`);
  if (loadFailures.length) problems.push(`起動する script が読み込めない: ${loadFailures.join(" / ")}`);
  if (missingEvents.length || staleEvents.length || extraEvents.length || missingScripts.length || loadFailures.length) {
    fixes.push(`${UPDATE_NOW_COMMAND} で最新の Release を入れ、ホストのセッションを開き直す`);
  }

  const trust = {};
  if (host === "claude") {
    if (install.disableAllHooks) {
      problems.push("~/.claude/settings.json の disableAllHooks が true（Claude Code は全部のフックを動かさない）");
      fixes.push("~/.claude/settings.json の disableAllHooks を外す（運営者が決めること）");
    }
    if (install.enabled !== true) {
      problems.push("plugin が有効でないので、フックは動かない");
    }
  } else {
    for (const event of expectedEvents) {
      trust[event] = inspectCodexHookTrust({ env, homeDir, event: codexHookEventKey(event) }).status;
    }
    const untrusted = Object.entries(trust).filter(([, status]) => status !== "trusted");
    if (untrusted.length) {
      problems.push(`Codex が信頼していない（/hooks 未確認）: ${untrusted.map(([event, status]) => `${event}=${status}`).join(", ")}`);
      fixes.push(CODEX_HOOK_TRUST_FIX);
    }
  }

  const ok = problems.length === 0;
  return {
    ok,
    status: ok ? "registered" : "problem",
    hooksFile: found.relative,
    events: installedEvents,
    expectedEvents,
    missingEvents,
    staleEvents,
    extraEvents,
    missingScripts,
    loadFailures,
    ...(host === "codex" ? { trust } : {}),
    detail: ok
      ? `Release のフック ${expectedEvents.join("・")} が ${found.relative} に同じ形で入っている${loadCheck ? "（起動する script も読み込めた）" : ""}`
        + (host === "codex" ? "。/hooks の信頼あり（hash の一致までは見ていない）" : "")
      : problems.join("。"),
    fix: [...new Set(fixes)].join(" / "),
  };
}

// ---------------------------------------------------------------------------
// MCP

const PLUGIN_ROOT_PLACEHOLDERS = [/\$\{CLAUDE_PLUGIN_ROOT\}/gu, /\$\{PLUGIN_ROOT\}/gu];

function expandRoot(value, root) {
  let text = String(value);
  for (const pattern of PLUGIN_ROOT_PLACEHOLDERS) text = text.replace(pattern, root);
  return text;
}

/**
 * ホストが起動する BuzzAssist の MCP の定義を、その版の置き場から読む（置き場の .mcp.json の
 * buzzassist_mcp）。setup は .mcp.json に「管理下の置き場の start-mcp.mjs」の絶対パスを書くので、
 * ホストの記録の置き場と、実際に MCP を動かす置き場は別になることがある。
 */
export function resolveMcpLaunch({ root, host }) {
  const manifest = readJson(path.join(root, ...HOST_MANIFEST[host].split("/")));
  let servers = null;
  let configLabel = ".mcp.json";
  if (manifest?.mcpServers && typeof manifest.mcpServers === "object") {
    servers = manifest.mcpServers.mcpServers || manifest.mcpServers;
    configLabel = `${HOST_MANIFEST[host]} の mcpServers`;
  } else {
    const relative = typeof manifest?.mcpServers === "string" ? manifest.mcpServers : "./.mcp.json";
    const file = path.resolve(root, relative);
    configLabel = relative;
    servers = readJson(file)?.mcpServers || null;
  }
  const entry = servers?.buzzassist_mcp;
  if (!entry) return { error: `${configLabel} に buzzassist_mcp が無い` };
  if (entry.type && entry.type !== "stdio") return { error: `buzzassist_mcp が stdio でない（${entry.type}）` };
  if (typeof entry.command !== "string" || !entry.command.trim()) return { error: "buzzassist_mcp に command が無い" };
  const cwd = path.resolve(root, expandRoot(entry.cwd || ".", root));
  const rawArgs = Array.isArray(entry.args) ? entry.args.map((arg) => expandRoot(arg, root)) : [];
  const scriptIndex = rawArgs.findIndex((arg) => /start-mcp\.mjs$/u.test(arg));
  const args = rawArgs.map((arg, index) => (index === scriptIndex ? path.resolve(cwd, arg) : arg));
  const serverRoot = scriptIndex >= 0 ? path.dirname(path.dirname(args[scriptIndex])) : "";
  const env = {};
  for (const [key, value] of Object.entries(entry.env || {})) env[key] = expandRoot(value, root);
  return {
    command: expandRoot(entry.command, root),
    args,
    cwd,
    env,
    scriptIndex,
    serverRoot,
    serverRootExists: Boolean(serverRoot) && existsSync(path.join(serverRoot, "scripts", "start-mcp.mjs")),
    serverVersion: serverRoot ? versionOf(readJson(path.join(serverRoot, "package.json"))?.version) : "",
    configLabel,
  };
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * MCP を stdio で起動し、initialize → tools/list（ページ送りも）→ read_me を確かめる。
 * 依存は Node の組み込みだけ（SDK を持たない置き場からでも動くように、JSON-RPC を自前で話す）。
 */
export function runMcpSession({ command, args = [], cwd, env, timeoutMs = 60_000, requiredTools = REQUIRED_MCP_TOOLS, callReadMe = true }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stderrChunks = [];
    const pending = new Map();
    let buffer = "";
    let nextId = 1;
    let finished = null;
    let closed = false;
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(String(command)),
      });
    } catch (error) {
      resolve({ ok: false, status: "spawn-error", detail: `MCP を起動できない: ${error.message}`, durationMs: 0, stderrTail: "" });
      return;
    }
    const stderrTail = () => stderrChunks.join("").trim().slice(-800);
    const settle = () => resolve({ ...finished, durationMs: Date.now() - startedAt, stderrTail: stderrTail() });
    const finish = (result) => {
      if (finished) return;
      finished = result;
      clearTimeout(timer);
      for (const reject of pending.values()) reject(null);
      pending.clear();
      try { child.stdin.end(); } catch { /* 閉じている */ }
      if (closed) {
        settle();
        return;
      }
      try { child.kill("SIGTERM"); } catch { /* 終わっている */ }
      // 子が閉じるのを待ってから返す（一時フォルダを消す前に。Windows は使用中を消せない）。
      const hard = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* 終わっている */ }
        settle();
      }, 3000);
      child.once("close", () => {
        clearTimeout(hard);
        settle();
      });
    };
    const timer = setTimeout(() => finish({ ok: false, status: "timeout", detail: `MCP が ${timeoutMs}ms 以内に答えない` }), timeoutMs);
    const send = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        // 閉じていれば close の側で終わる
      }
    };
    const request = (method, params) => new Promise((resolveRequest) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, resolveRequest);
      send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
    const handle = (message) => {
      if (message && message.id !== undefined && message.id !== null && ("result" in message || "error" in message) && pending.has(message.id)) {
        const resolveRequest = pending.get(message.id);
        pending.delete(message.id);
        resolveRequest(message);
        return;
      }
      // server からの要求（ping など）には答える。知らないものは method not found。
      if (message && typeof message.method === "string" && message.id !== undefined && message.id !== null) {
        if (message.method === "ping") send({ jsonrpc: "2.0", id: message.id, result: {} });
        else send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        handle(message);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(String(chunk));
      if (stderrChunks.length > 40) stderrChunks.shift();
    });
    child.stdin.on("error", () => { /* 相手が先に終わっていれば close の側で終わる */ });
    child.on("error", (error) => finish({ ok: false, status: "spawn-error", detail: `MCP を起動できない: ${error.message}` }));
    child.on("close", (code, signal) => {
      closed = true;
      if (!finished) finish({ ok: false, status: "exited", detail: `MCP が答える前に終わった（exit ${code ?? signal}）` });
    });

    (async () => {
      const init = await request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "buzzassist-release-acceptance", version: "1.0.0" },
      });
      if (!init) return;
      if (init.error) {
        finish({ ok: false, status: "initialize-failed", detail: `initialize が失敗した: ${init.error.message || JSON.stringify(init.error)}` });
        return;
      }
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const names = [];
      let cursor;
      for (let page = 0; page < 20; page += 1) {
        const listed = await request("tools/list", cursor ? { cursor } : {});
        if (!listed) return;
        if (listed.error) {
          finish({ ok: false, status: "tools-list-failed", detail: `tools/list が失敗した: ${listed.error.message || JSON.stringify(listed.error)}` });
          return;
        }
        for (const tool of listed.result?.tools || []) if (tool?.name) names.push(tool.name);
        cursor = listed.result?.nextCursor;
        if (!cursor) break;
      }
      const missingTools = requiredTools.filter((name) => !names.includes(name));
      if (missingTools.length) {
        finish({ ok: false, status: "missing-tools", toolCount: names.length, missingTools, detail: `必須の道具が無い: ${missingTools.join(", ")}` });
        return;
      }
      if (callReadMe) {
        const called = await request("tools/call", { name: "read_me", arguments: {} });
        if (!called) return;
        if (called.error || called.result?.isError) {
          finish({ ok: false, status: "read-me-failed", toolCount: names.length, detail: `read_me の呼び出しが失敗した: ${called.error?.message || "isError"}` });
          return;
        }
      }
      finish({
        ok: true,
        status: "ok",
        toolCount: names.length,
        serverInfo: init.result?.serverInfo || null,
        protocolVersion: init.result?.protocolVersion || "",
        detail: `道具 ${names.length} 個を返した${callReadMe ? "（read_me の呼び出しも通った）" : ""}`,
      });
    })().catch((error) => finish({ ok: false, status: "error", detail: String(error?.message || error) }));
  });
}

/**
 * (c) ホストが起動する MCP を、その定義のまま（project と canvas だけ一時フォルダへ向けて）起動して確かめる。
 * 置き場に依存が無いときは置き場へ npm install しない。同じ版の Release の展開先に依存があれば、
 * 一時フォルダの写しにつないで確かめる（mode: link）。それも無ければ allowDependencyInstall のときだけ
 * 写しの中で npm install する。
 */
export async function probeHostMcp({ launch, homeDir, env = process.env, timeoutMs = 60_000, allowDependencyInstall = false, runSession = runMcpSession }) {
  if (!launch.serverRootExists) {
    return { ok: false, status: "server-missing", detail: `MCP の起動先（${launch.args[launch.scriptIndex] || launch.command}）が無い`, fix: `${UPDATE_NOW_COMMAND} で入れ直す` };
  }
  const plan = resolveVerificationDependencies({ pluginRoot: launch.serverRoot, homeDir });
  if (plan.mode === "install" && !allowDependencyInstall) {
    return {
      ok: null,
      status: "dependencies-missing",
      mode: plan.mode,
      detail: `MCP の置き場 ${launch.serverRoot} に依存が無く、同じ版の Release の展開先も使えないので起動していない（${plan.reasons.join(" / ")}）`,
      fix: "ホストのセッションを1回開く（start-mcp が初回に依存を入れる）か、--allow-dependency-install で一時フォルダの写しに入れて確かめる",
    };
  }
  let runtime = null;
  const project = mkdtempSync(path.join(tmpdir(), "buzzassist-acceptance-project-"));
  try {
    let command = launch.command;
    let args = launch.args;
    let cwd = launch.cwd;
    if (plan.mode !== "in-place") {
      const logs = [];
      runtime = await prepareVerificationRuntime({
        pluginRoot: launch.serverRoot,
        homeDir,
        log: (message) => logs.push(message),
        stderr: { write: () => true },
      });
      args = launch.args.map((arg, index) => (index === launch.scriptIndex ? path.join(runtime.runtimeRoot, "scripts", "start-mcp.mjs") : arg));
      cwd = runtime.runtimeRoot;
    }
    const session = await runSession({
      command,
      args,
      cwd,
      env: {
        ...env,
        ...launch.env,
        EXCALIDRAW_NO_AUTO_OPEN: "1",
        // 運営者の project と canvas に触らない（MCP は起動時に canvas の保守と chat bridge を始める）。
        EXCALIDRAW_PROJECT_DIR: project,
        EXCALIDRAW_CANVAS_DIR: path.join(project, "canvas"),
      },
      timeoutMs,
    });
    return {
      ...session,
      mode: plan.mode,
      fix: session.ok ? "" : `MCP の置き場 ${launch.serverRoot} を ${UPDATE_NOW_COMMAND} で入れ直す。直らなければ stderrTail の根因を見る`,
    };
  } finally {
    await runtime?.cleanup?.();
    rmSync(project, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}

// ---------------------------------------------------------------------------
// 全体

function versionCheck({ install, latestVersion }) {
  if (!install.installed && install.disabledInConfig) {
    return {
      ok: false,
      status: "disabled",
      detail: `Codex の設定で BuzzAssist が無効にされている（${install.enabledSource}）ので、どの版も読まれていない`,
      fix: "Codex の /plugins で BuzzAssist を有効にする（有効にするかは運営者が決める）",
    };
  }
  if (!install.installed) {
    return {
      ok: false,
      status: "not-installed",
      detail: install.hostPresent ? "BuzzAssist が入っていない" : `${install.label} の設定の置き場が無い（ホストが入っていない）`,
      fix: "node scripts/setup-agents.mjs --agents claude,codex --project-dir <作業フォルダ> で両ホストへ入れる",
    };
  }
  if (install.estimated) {
    return {
      ok: false,
      status: "estimated",
      detail: `有効な版を記録から決められない（cache の最大の版 ${install.version} を推定で使った。理由 ${install.estimateReason}）`,
      fix: "Codex の設定（~/.codex/config.toml）の [plugins.\"buzzassist@buzzassist\"] と [marketplaces.buzzassist] を setup で作り直す",
    };
  }
  if (!install.manifestVersion || install.manifestVersion !== install.version) {
    return {
      ok: false,
      status: "manifest-mismatch",
      detail: `ホストの記録の版 ${install.version || "不明"} と、置き場の manifest の版 ${install.manifestVersion || "読めない"} が違う（${install.root}）`,
      fix: `${UPDATE_NOW_COMMAND} で入れ直す`,
    };
  }
  if (!latestVersion) {
    return { ok: null, status: "latest-unknown", detail: `入っているのは ${install.version}。最新の Release を確かめられないので比べていない`, fix: "ネットワークのある所で回すか、--expected-version <版> を渡す" };
  }
  const order = compareVersions(install.version, latestVersion);
  if (order < 0) {
    return { ok: false, status: "behind", detail: `最新の Release ${latestVersion} より古い ${install.version} が入っている`, fix: `${UPDATE_NOW_COMMAND} で更新し、ホストのセッションを開き直す` };
  }
  if (order > 0) {
    return { ok: false, status: "ahead", detail: `最新の Release ${latestVersion} より新しい ${install.version} が入っている（Release でない写しから配った？）`, fix: "配った版を確かめるなら、その版の Release を出してから回す" };
  }
  return { ok: true, status: "current", detail: `最新の Release ${latestVersion} が入っている（${install.root}）`, fix: "" };
}

function enabledCheck(install) {
  if (install.enabled === true) return { ok: true, status: "enabled", detail: `有効（${install.enabledSource}）`, fix: "" };
  const fix = install.host === "claude"
    ? "claude plugin enable buzzassist@buzzassist（有効にするかは運営者が決める）"
    : "Codex の /plugins で BuzzAssist を有効にする（~/.codex/config.toml の [plugins.\"buzzassist@buzzassist\"] enabled = true）";
  if (install.enabled === false) return { ok: false, status: "disabled", detail: `無効にされている（${install.enabledSource}）`, fix };
  return { ok: false, status: "unrecorded", detail: `有効の記録が無い（${install.enabledSource}）。有効かどうかを確かめられない`, fix };
}

function mcpVersionProblem({ launch, latestVersion, install }) {
  const want = latestVersion || install.version;
  if (!launch.serverVersion) return `MCP の置き場 ${launch.serverRoot} の版が読めない`;
  if (want && launch.serverVersion !== want) {
    return `MCP の置き場 ${launch.serverRoot} の版 ${launch.serverVersion} が ${latestVersion ? `最新の Release ${latestVersion}` : `ホストの版 ${install.version}`} と違う（ホストはこの古い MCP を起動する）`;
  }
  return "";
}

/**
 * 受け入れ確認の本体。何も書き換えない（MCP の project と canvas は一時フォルダ）。
 * status: pass（全部そろった）/ fail（どれか落ちた）/ incomplete（落ちたものは無いが、確かめられない項目がある）/ busy（更新中）
 */
export async function runReleaseAcceptance({
  homeDir = homedir(),
  env = process.env,
  hosts = ACCEPTANCE_HOSTS,
  expectedVersion = "",
  fetchLatest = null,
  sourceRoot = SOURCE_ROOT,
  skipMcp = false,
  allowDependencyInstall = false,
  hookLoadCheck = true,
  mcpTimeoutMs = 60_000,
  runSession = runMcpSession,
  now = () => new Date(),
} = {}) {
  const home = path.resolve(homeDir);
  const checkedAt = now().toISOString();
  const lock = updateLockState({ homeDir: home, now: now().getTime() });
  if (lock.busy) {
    return {
      schema: RELEASE_ACCEPTANCE_SCHEMA,
      checkedAt,
      status: "busy",
      detail: `自動更新が走っている（${lock.lockDir}）。更新と同時には確かめない。終わってからもう一度回す`,
      hosts: [],
    };
  }
  const updater = readUpdaterRecords(home);
  const repository = updater.config?.repository || BUZZASSIST_REPOSITORY;
  const latest = await resolveLatestRelease({ expectedVersion, fetchLatest, repository, env });
  const expectation = expectedHookSource({ homeDir: home, latestVersion: latest.version || "", sourceRoot });
  const installs = resolveHostPluginInstalls({ homeDir: home });
  const mcpCache = new Map();
  const results = [];

  for (const host of hosts) {
    const install = inspectHostInstall({ host, homeDir: home, installs });
    if (!install.hostPresent && !install.installed) {
      results.push({ host, label: HOST_LABEL[host], skipped: true, status: "host-absent", detail: `${HOST_LABEL[host]} がこの端末に無い（${host === "claude" ? "~/.claude" : "~/.codex"} が無い）ので対象外`, checks: [] });
      continue;
    }
    const checks = [];
    checks.push({ id: "version", ...versionCheck({ install, latestVersion: latest.version }) });
    if (install.installed) {
      checks.push({ id: "enabled", ...enabledCheck(install) });
      const expected = readJson(path.join(expectation.root, ...HOST_HOOK_FILE[host].split("/")));
      if (!expected) {
        checks.push({ id: "hooks", ok: null, status: "expectation-missing", detail: `期待するフックの定義（${HOST_HOOK_FILE[host]}）を ${expectation.root} から読めない`, fix: "" });
      } else {
        const hooks = await inspectHostHooks({ host, install, expected, homeDir: home, env, loadCheck: hookLoadCheck });
        checks.push({ id: "hooks", ...hooks, expectationSource: expectation });
      }
      const launch = resolveMcpLaunch({ root: install.root, host });
      if (launch.error) {
        checks.push({ id: "mcp", ok: false, status: "no-mcp", detail: launch.error, fix: `${UPDATE_NOW_COMMAND} で入れ直す` });
      } else {
        const versionProblem = mcpVersionProblem({ launch, latestVersion: latest.version, install });
        let probe;
        if (skipMcp) {
          probe = { ok: null, status: "skipped", detail: "--skip-mcp なので MCP を起動していない", fix: "" };
        } else {
          const key = JSON.stringify([launch.command, launch.args, launch.cwd]);
          if (!mcpCache.has(key)) {
            mcpCache.set(key, await probeHostMcp({ launch, homeDir: home, env, timeoutMs: mcpTimeoutMs, allowDependencyInstall, runSession }));
          }
          probe = mcpCache.get(key);
        }
        const ok = versionProblem ? false : probe.ok;
        checks.push({
          id: "mcp",
          ...probe,
          ok,
          status: versionProblem ? "server-version-mismatch" : probe.status,
          serverRoot: launch.serverRoot,
          serverVersion: launch.serverVersion,
          detail: versionProblem ? `${versionProblem}。${probe.detail || ""}` : `${probe.detail}（MCP の置き場 ${launch.serverRoot}、版 ${launch.serverVersion || "不明"}）`,
          fix: versionProblem ? `${UPDATE_NOW_COMMAND} で管理下の置き場を入れ直す` : probe.fix,
        });
      }
    }
    const failed = checks.filter((check) => check.ok === false);
    const unknown = checks.filter((check) => check.ok !== true && check.ok !== false);
    results.push({
      host,
      label: HOST_LABEL[host],
      installed: install.installed,
      version: install.version || "",
      root: install.root || "",
      status: failed.length ? "fail" : unknown.length ? "incomplete" : "pass",
      checks,
    });
  }

  const considered = results.filter((result) => !result.skipped);
  const anyFail = considered.some((result) => result.status === "fail");
  const anyIncomplete = considered.some((result) => result.status === "incomplete") || !latest.version || considered.length === 0;
  const status = anyFail ? "fail" : anyIncomplete ? "incomplete" : "pass";
  return {
    schema: RELEASE_ACCEPTANCE_SCHEMA,
    checkedAt,
    status,
    latestRelease: latest,
    expectationSource: expectation,
    updater: updater.state ? {
      status: updater.state.status || "",
      installedVersion: updater.state.installedVersion || "",
      latestVersion: updater.state.latestVersion || "",
      lastCheckedAt: updater.state.lastCheckedAt || "",
      lastError: String(updater.state.lastError || "").slice(0, 300),
    } : null,
    hosts: results,
    manualChecks: [
      "本物のセッションでの発火はここでは確かめていない（モデルを呼ぶため）。両ホストで新しいセッションを開き、Claude Code は /hooks、Codex は /hooks で BuzzAssist の UserPromptSubmit と Stop が並ぶかを見る",
      "開いたままのセッションは、開き直すまで前の版のスキル・フック・MCP を使う",
    ],
  };
}

const MARK = { true: "OK  ", false: "NG  ", null: "未確認" };

/** 人が読む形（日本語）。 */
export function formatReleaseAcceptance(report) {
  const lines = [];
  if (report.status === "busy") {
    lines.push("Release の受け入れ確認: 更新中なので確かめていない", `  ${report.detail}`);
    return `${lines.join("\n")}\n`;
  }
  const heading = { pass: "合格（両ホストに最新の Release が入り、フックと MCP が動く）", fail: "不合格（直すものがある）", incomplete: "未確定（落ちたものは無いが、確かめられない項目がある）" }[report.status] || report.status;
  lines.push(`Release の受け入れ確認: ${heading}`);
  const latest = report.latestRelease;
  lines.push(latest.version
    ? `最新の Release: ${latest.version}（${latest.source === "github" ? `GitHub ${latest.repository}` : "--expected-version"}）`
    : `最新の Release: 確かめられない（${latest.error || "理由不明"}）`);
  if (report.expectationSource) {
    lines.push(`期待するフックの定義: ${report.expectationSource.kind === "release-extract" ? "Release の展開先" : "この写し"} ${report.expectationSource.root}（版 ${report.expectationSource.version || "不明"}）`);
  }
  if (report.updater) {
    const state = report.updater;
    lines.push(`自動更新の前回の記録: ${state.status || "不明"}（入っている ${state.installedVersion || "?"} / 最新 ${state.latestVersion || "?"}、${state.lastCheckedAt || "時刻不明"}）${state.status === "failed" && state.lastError ? ` 失敗の理由: ${state.lastError}` : ""}`);
  }
  for (const host of report.hosts) {
    lines.push("");
    if (host.skipped) {
      lines.push(`[${host.label}] 対象外: ${host.detail}`);
      continue;
    }
    lines.push(`[${host.label}] ${host.status === "pass" ? "合格" : host.status === "fail" ? "不合格" : "未確定"}${host.version ? `（入っている版 ${host.version}）` : ""}`);
    for (const check of host.checks) {
      lines.push(`  [${MARK[String(check.ok === true ? true : check.ok === false ? false : null)]}] ${check.id}: ${check.detail}`);
      if (check.ok !== true && check.fix) lines.push(`         → ${check.fix}`);
      if (check.id === "mcp" && check.ok === false && check.stderrTail) lines.push(`         MCP の stderr（末尾）: ${check.stderrTail.replace(/\s+/gu, " ").slice(-300)}`);
    }
  }
  lines.push("", "人が確かめること:");
  for (const item of report.manualChecks || []) lines.push(`  - ${item}`);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// doctor 用（入っている版が最新の Release より古いか）

/**
 * doctor の advisory 検査 release-currency。ホストの版（host-skill-sync と同じ installs）を
 * 最新の Release と比べる。最新の Release は、渡された latestVersion、次に更新器の記録
 * （state.json の latestVersion。3日以内に確かめたものだけ）。どちらも無ければ黙る（ok: true、skipped）。
 */
export function probeReleaseCurrency({ installs = [], latestVersion = "", latestSource = "", updaterState = null, now = Date.now() } = {}) {
  let latest = versionOf(latestVersion);
  let source = latest ? (latestSource || "github") : "";
  if (!latest && updaterState?.latestVersion) {
    const checkedAt = Date.parse(String(updaterState.lastCheckedAt || ""));
    if (Number.isFinite(checkedAt) && now - checkedAt >= 0 && now - checkedAt <= UPDATER_STATE_MAX_AGE_MS) {
      latest = versionOf(updaterState.latestVersion);
      source = latest ? "updater-state" : "";
    }
  }
  if (!latest) {
    return { ok: true, skipped: true, detail: "最新の Release を確かめていない（ネットワークに届かないか、自動更新の最近の記録が無い）", fix: "" };
  }
  if (installs.length === 0) {
    return { ok: true, latestVersion: latest, latestSource: source, detail: `BuzzAssist plugin を入れたホストが無い（最新の Release は ${latest}）`, fix: "" };
  }
  const behind = hostsBehindVersion({ installs, hosts: installs.map((install) => install.host), version: latest });
  const hostsLabel = installs.map((install) => `${install.host} ${install.version || "版不明"}${install.estimated ? "（推定）" : ""}`).join(" / ");
  const failedUpdate = updaterState?.status === "failed" && updaterState?.lastError
    ? `。前回の自動更新は失敗している: ${String(updaterState.lastError).slice(0, 160)}`
    : "";
  if (behind.length === 0) {
    return { ok: true, latestVersion: latest, latestSource: source, detail: `ホストに入っている版が最新の Release ${latest} と同じか新しい（${hostsLabel}）`, fix: "" };
  }
  return {
    ok: false,
    latestVersion: latest,
    latestSource: source,
    behind,
    detail: `ホストに入っている BuzzAssist が最新の Release ${latest} より古い: ${behind.map((entry) => `${entry.host} ${entry.version}`).join(", ")}${source === "updater-state" ? "（最新の版は自動更新の記録から）" : ""}${failedUpdate}`,
    fix: `${UPDATE_NOW_COMMAND} で更新し、ホストのセッションを開き直す。そのあと ${RELEASE_ACCEPTANCE_COMMAND} で両ホストの版・フック・MCP を確かめる`,
  };
}
