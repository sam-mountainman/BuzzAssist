// Codex が BuzzAssist の学習フック（UserPromptSubmit）を信頼しているかを、読むだけで確かめる。
//
// Codex は、管理対象外のコマンドフックを「利用者が /hooks で確認して信頼した定義」だけ動かす。
// 信頼は ~/.codex/config.toml（CODEX_HOME があればそこ）に、フックごとの表として残る:
//
//   [hooks.state."<plugin>@<marketplace>:<フック定義の相対パス>:<イベント>:<群>:<番号>"]
//   trusted_hash = "sha256:<64桁>"
//
// 例: BuzzAssist なら "buzzassist@buzzassist:hooks/codex-hooks.json:user_prompt_submit:0:0"。
// 表が無いフックは、プラグインが有効でも**黙って飛ばされる**。定義（起動行など）が変わると
// hash が合わなくなり、信頼し直すまでまた飛ばされる。hash の作り方は公開されていないので、
// ここでは「表と trusted_hash があるか」「enabled = false で止められていないか」だけを見る。
//
// ここは読むだけ。config.toml へは何も書かない（信頼は人が /hooks で決めるもの）。

import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const BUZZASSIST_CODEX_PLUGIN = "buzzassist@buzzassist";
export const BUZZASSIST_CODEX_HOOK_FILE = "hooks/codex-hooks.json";
export const BUZZASSIST_CODEX_HOOK_EVENT = "user_prompt_submit";

export const CODEX_HOOK_TRUST_FIX =
  "Codex を端末で起動して `/hooks` を開き、BuzzAssist の UserPromptSubmit フック（harness-learn-hook）を確認して信頼する。"
  + "信頼されるまで、Codex ではユーザーの訂正に気づいて capture を促すフックが動かない（Claude Code は信頼の手順なしで動く）。"
  + "デスクトップ版の /hooks は信頼を書き込まない報告があるので、端末の codex で行う。"
  + "BuzzAssist を更新してフックの定義が変わったときは、もう一度 /hooks で信頼し直す。";

/** Codex の設定の置き場。CODEX_HOME があればそれ、無ければ <home>/.codex。 */
export function codexHomeDir({ env = process.env, homeDir = homedir() } = {}) {
  const configured = String(env?.CODEX_HOME ?? "").trim();
  return configured ? path.resolve(configured) : path.join(homeDir, ".codex");
}

function unquoteTomlKey(raw) {
  const text = String(raw).trim();
  if (text.startsWith("\"") && text.endsWith("\"") && text.length >= 2) {
    try { return JSON.parse(text); } catch { return text.slice(1, -1); }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1);
  return text;
}

/** `a.b."c.d"` のような表の見出しを、引用を考慮して区切る。 */
function splitTomlDottedKey(header) {
  const parts = [];
  let current = "";
  let quote = "";
  for (let index = 0; index < header.length; index += 1) {
    const char = header[index];
    if (quote) {
      current += char;
      if (char === "\\" && quote === "\"" && index + 1 < header.length) { current += header[index + 1]; index += 1; continue; }
      if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'") { quote = char; current += char; continue; }
    if (char === ".") { parts.push(unquoteTomlKey(current)); current = ""; continue; }
    current += char;
  }
  parts.push(unquoteTomlKey(current));
  return parts;
}

function tomlScalar(raw) {
  const text = String(raw).trim().replace(/\s+#.*$/u, "");
  if (text === "true") return true;
  if (text === "false") return false;
  if (text.startsWith("\"") || text.startsWith("'")) return unquoteTomlKey(text);
  return text;
}

/**
 * config.toml から、フックの信頼の表とプラグインの有効・無効だけを読む（最小の読み取り）。
 * 返り値: { hooks: Map<key, { trustedHash, enabled }>, plugins: Map<name, { enabled }> }
 */
export function parseCodexHookState(text) {
  const hooks = new Map();
  const plugins = new Map();
  let section = null;
  for (const rawLine of String(text ?? "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[([^[\]]+)\]\s*(?:#.*)?$/u);
    if (header) {
      const parts = splitTomlDottedKey(header[1].trim());
      if (parts.length === 3 && parts[0] === "hooks" && parts[1] === "state") {
        section = { kind: "hook", key: parts[2] };
        if (!hooks.has(section.key)) hooks.set(section.key, { trustedHash: "", enabled: true });
      } else if (parts.length === 2 && parts[0] === "hooks" && parts[1] === "state") {
        section = { kind: "hook-table" };
      } else if (parts.length === 2 && parts[0] === "plugins") {
        section = { kind: "plugin", key: parts[1] };
        if (!plugins.has(section.key)) plugins.set(section.key, { enabled: true });
      } else {
        section = null;
      }
      continue;
    }
    if (!section) continue;
    const assignment = line.match(/^((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.-]+))\s*=\s*(.+)$/u);
    if (!assignment) continue;
    const key = unquoteTomlKey(assignment[1]);
    const value = assignment[2];
    if (section.kind === "hook") {
      const entry = hooks.get(section.key);
      if (key === "trusted_hash") entry.trustedHash = String(tomlScalar(value));
      if (key === "enabled") entry.enabled = tomlScalar(value) !== false;
    } else if (section.kind === "hook-table") {
      // [hooks.state] の下に "key" = { trusted_hash = "...", enabled = false } と書かれた形。
      const inline = value.trim().match(/^\{(.*)\}\s*(?:#.*)?$/u);
      if (!inline) continue;
      const entry = { trustedHash: "", enabled: true };
      const hash = inline[1].match(/trusted_hash\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/u);
      if (hash) entry.trustedHash = String(unquoteTomlKey(hash[1]));
      if (/enabled\s*=\s*false/u.test(inline[1])) entry.enabled = false;
      hooks.set(key, entry);
    } else if (section.kind === "plugin" && key === "enabled") {
      plugins.get(section.key).enabled = tomlScalar(value) !== false;
    }
  }
  return { hooks, plugins };
}

function isBuzzAssistLearningHookKey(key) {
  const text = String(key);
  return text.startsWith(`${BUZZASSIST_CODEX_PLUGIN}:`) && text.split(":").includes(BUZZASSIST_CODEX_HOOK_EVENT);
}

/**
 * Codex の信頼の状態。status は次のどれか:
 *   not-installed  Codex に BuzzAssist が入っていない（対象外）
 *   plugin-disabled  プラグイン自体が無効
 *   trusted        信頼の表と trusted_hash がある
 *   disabled       信頼の表はあるが enabled = false
 *   untrusted      信頼の表が無い（Codex はフックを黙って飛ばす）
 */
export function inspectCodexHookTrust({ env = process.env, homeDir = homedir(), configText = undefined } = {}) {
  const codexHome = codexHomeDir({ env, homeDir });
  const configPath = path.join(codexHome, "config.toml");
  let text = configText;
  if (text === undefined) {
    try { text = fs.readFileSync(configPath, "utf8"); } catch { text = null; }
  }
  const parsed = parseCodexHookState(text ?? "");
  const pluginRecord = parsed.plugins.get(BUZZASSIST_CODEX_PLUGIN) || null;
  const cacheInstalled = fs.existsSync(path.join(codexHome, "plugins", "cache", "buzzassist", "buzzassist"));
  const installed = cacheInstalled || Boolean(pluginRecord);
  const base = { configPath, installed, pluginEnabled: pluginRecord ? pluginRecord.enabled : null, keys: [] };
  if (!installed) return { ...base, status: "not-installed" };
  if (pluginRecord && pluginRecord.enabled === false) return { ...base, status: "plugin-disabled" };
  const entries = [...parsed.hooks.entries()].filter(([key]) => isBuzzAssistLearningHookKey(key));
  const keys = entries.map(([key]) => key);
  if (entries.some(([, entry]) => entry.enabled && /^sha256:[a-f0-9]{64}$/u.test(entry.trustedHash))) {
    return { ...base, keys, status: "trusted" };
  }
  if (entries.some(([, entry]) => entry.enabled === false)) return { ...base, keys, status: "disabled" };
  return { ...base, keys, status: "untrusted" };
}

/** doctor の advisory 検査（learning-hook-trust）の形。止めない（required: false）。 */
export function probeCodexLearningHookTrust(options = {}) {
  const trust = inspectCodexHookTrust(options);
  const expectedKey = `${BUZZASSIST_CODEX_PLUGIN}:${BUZZASSIST_CODEX_HOOK_FILE}:${BUZZASSIST_CODEX_HOOK_EVENT}:0:0`;
  switch (trust.status) {
    case "not-installed":
      return { ok: true, status: trust.status, detail: "Codex に BuzzAssist が入っていない（対象外）", fix: "" };
    case "plugin-disabled":
      return { ok: true, status: trust.status, detail: "Codex で BuzzAssist プラグインが無効（フックも動かない。対象外として扱う）", fix: "" };
    case "trusted":
      return {
        ok: true,
        status: trust.status,
        detail: "Codex が BuzzAssist の学習フックを信頼済み（config.toml の hooks.state に trusted_hash がある。"
          + "hash の一致までは確かめられないので、更新でフックの定義が変わったときは Codex が再確認を求める）",
        fix: "",
      };
    case "disabled":
      return {
        ok: false,
        status: trust.status,
        detail: "Codex で BuzzAssist の学習フックが無効にされている（hooks.state の enabled = false）",
        fix: CODEX_HOOK_TRUST_FIX,
      };
    default:
      return {
        ok: false,
        status: "untrusted",
        detail: `Codex が BuzzAssist の学習フックを信頼していない（config.toml に [hooks.state."${expectedKey}"] が無い）。`
          + "信頼されるまで Codex はこのフックを黙って飛ばす",
        fix: CODEX_HOOK_TRUST_FIX,
      };
  }
}
