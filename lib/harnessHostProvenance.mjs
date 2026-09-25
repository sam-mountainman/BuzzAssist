// 実行を呼んだホスト（Claude Code / Codex / Antigravity / 素の端末）の記録。
//
// 「Claude Code と Codex で同じ品質か」は、どのホストから動かした実行なのかが RunReceipt に
// 残っていなければ測れない。ここはその判定と正規化の1か所で、Job（metadata.invocation）と
// RunReceipt（invocation）は同じ形を使う。2つ目の判定を入口ごとに書かない。
//
// 守ること:
//
//   - **推測で埋めない。** 判定できないものは "unknown" と書き、何から判定したか
//     （detectedFrom）を残す。どのホストの印も無い素の端末だけが "cli"
//   - **環境変数は名前で判定し、値は残さない。** 例外は版の文字列で、決まった形
//     （Claude Code の AI_AGENT）に合うときに版の部分だけを取り出す
//   - **モデル ID は呼び出し側が宣言したときだけ残す**（caller-declared）。どのホストも
//     使っているモデルを MCP の clientInfo にも子プロセスの環境にも載せないので、それ以外は "unknown"
//   - **Job の同一性（identityDigest・requestKey）には入れない。** Claude Code で始めた Job を
//     Codex で再開できることを壊さないため。作ったホストと再開したホストは分けて残す
//
// 判定の根拠（2026-09-25、この端末に入っている実物を読んで確かめた。起動はしていない）:
//
//   | ホスト | MCP の clientInfo.name | 子プロセスに渡る環境変数（名前） |
//   |---|---|---|
//   | Claude Code 2.1.280 | "claude-code"（MCP SDK の Client に name/title/version を渡している） | CLAUDECODE=1、AI_AGENT=claude-code_<版の.を-に>_<種別> |
//   | Codex 0.144.1 | "codex-mcp-client"（rmcp の client） | CODEX_THREAD_ID、サンドボックス内は CODEX_SANDBOX、npm 起動は CODEX_MANAGED_BY_NPM=1 と CODEX_MANAGED_PACKAGE_ROOT |
//   | Antigravity | "antigravity-client"（language server の文字列。公式の文書は未確認） | ANTIGRAVITY_AGENT=1、ANTIGRAVITY_CONVERSATION_ID |
//
// 表に無いクライアント名は host "unknown" にし、名前だけを clientName に残す（次に表へ足す材料）。

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_INVOCATION_VERSION = "buzzassist-host-invocation-v1";
export const UNKNOWN = "unknown";
export const HOST_IDS = Object.freeze(["claude-code", "codex", "antigravity", "cli", UNKNOWN]);
export const HOST_VIAS = Object.freeze(["mcp", "cli", UNKNOWN]);
export const HOST_DETECTED_FROM = Object.freeze([
  "mcp-client-info",
  "environment",
  "ambiguous-environment",
  "none",
  "not-provided",
]);
export const HOST_MODEL_SOURCES = Object.freeze(["caller-declared", "unavailable"]);
export const HOST_OPERATIONS = Object.freeze(["start", "resume", "start-attached"]);
export const HOST_MODES = Object.freeze(["plan-only", "execute"]);
/** Job に残す再開の記録の上限。古いものから落とす（作った記録は落とさない）。 */
export const MAX_RESUMED_BY = 50;
export const HOST_MODEL_INVALID_CODE = "host-model-invalid";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MCP_CLIENT_HOSTS = Object.freeze({
  "claude-code": "claude-code",
  "codex-mcp-client": "codex",
  "antigravity-client": "antigravity",
});
const VERSION_TOKEN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u;
const CLIENT_NAME_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._@/ -]{0,79}$/u;
const MODEL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-[\]]{0,119}$/u;
const AI_AGENT_CLAUDE = /^claude-code_(\d+(?:-\d+){1,3})_[a-z-]+$/u;

let cachedBuzzAssistVersion = null;

/** 走っている BuzzAssist の版（このコードの package.json）。読めなければ "unknown"。 */
export function buzzassistVersion({ root = REPO_ROOT, readFile = readFileSync } = {}) {
  if (root === REPO_ROOT && cachedBuzzAssistVersion) return cachedBuzzAssistVersion;
  let version = UNKNOWN;
  try {
    const parsed = JSON.parse(String(readFile(join(root, "package.json"), "utf8")));
    if (typeof parsed?.version === "string" && VERSION_TOKEN.test(parsed.version)) version = parsed.version;
  } catch {
    version = UNKNOWN;
  }
  if (root === REPO_ROOT) cachedBuzzAssistVersion = version;
  return version;
}

function versionToken(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return VERSION_TOKEN.test(text) ? text : "";
}

function present(env, name) {
  const value = env?.[name];
  return typeof value === "string" && value.trim() !== "";
}

/** Claude Code が子プロセスへ渡す AI_AGENT（claude-code_2-1-280_harness）から版だけを取り出す。 */
export function claudeCodeVersionFromAiAgent(value) {
  const match = AI_AGENT_CLAUDE.exec(typeof value === "string" ? value.trim() : "");
  return match ? match[1].replace(/-/gu, ".") : "";
}

/**
 * npm から起動した Codex は、自分の package の場所を CODEX_MANAGED_PACKAGE_ROOT に置く。
 * その package.json が @openai/codex のときだけ版を読む（場所そのものは記録しない）。
 */
export function codexVersionFromPackageRoot(root, { readFile = readFileSync } = {}) {
  const text = typeof root === "string" ? root.trim() : "";
  if (!text || !isAbsolute(text)) return "";
  try {
    const parsed = JSON.parse(String(readFile(join(text, "package.json"), "utf8")));
    return parsed?.name === "@openai/codex" ? versionToken(parsed.version) : "";
  } catch {
    return "";
  }
}

/** MCP の initialize で受けた clientInfo からホストを決める。clientInfo が無ければ null。 */
export function hostFromMcpClientInfo(clientInfo) {
  const name = typeof clientInfo?.name === "string" ? clientInfo.name.trim() : "";
  if (!name) return null;
  return {
    host: MCP_CLIENT_HOSTS[name.toLowerCase()] || UNKNOWN,
    hostVersion: versionToken(clientInfo?.version) || UNKNOWN,
    clientName: CLIENT_NAME_TOKEN.test(name) ? name : UNKNOWN,
    detectedFrom: "mcp-client-info",
    candidates: [],
  };
}

/**
 * 環境変数の名前からホストを決める。印が1つのホストにだけあるときだけ決め、
 * 複数のホストの印が重なっていれば（入れ子で起動した等）決めずに候補を残す。印が無ければ null。
 */
export function hostFromEnvironment(env = process.env, { readFile = readFileSync } = {}) {
  const found = [];
  if (env?.CLAUDECODE === "1") {
    found.push({ host: "claude-code", hostVersion: claudeCodeVersionFromAiAgent(env.AI_AGENT) || UNKNOWN });
  }
  if (present(env, "CODEX_THREAD_ID") || present(env, "CODEX_SANDBOX")
    || ["CODEX_MANAGED_BY_NPM", "CODEX_MANAGED_BY_BUN", "CODEX_MANAGED_BY_PNPM"].some((name) => env?.[name] === "1")) {
    found.push({ host: "codex", hostVersion: codexVersionFromPackageRoot(env?.CODEX_MANAGED_PACKAGE_ROOT, { readFile }) || UNKNOWN });
  }
  if (env?.ANTIGRAVITY_AGENT === "1") found.push({ host: "antigravity", hostVersion: UNKNOWN });
  if (found.length === 1) return { ...found[0], clientName: "", detectedFrom: "environment", candidates: [] };
  if (found.length > 1) {
    return {
      host: UNKNOWN,
      hostVersion: UNKNOWN,
      clientName: "",
      detectedFrom: "ambiguous-environment",
      candidates: found.map((entry) => entry.host).sort(),
    };
  }
  return null;
}

/** 呼び出し側が宣言したモデル ID。空なら ""、形が合わなければ黙って捨てずに拒否する。 */
export function declaredHostModel(value) {
  if (value === undefined || value === null || value === "") return "";
  const text = typeof value === "string" ? value.trim() : "";
  if (!MODEL_TOKEN.test(text)) {
    const error = new Error(
      `${HOST_MODEL_INVALID_CODE}: hostModel はモデル ID の文字列だけを受ける（英数字と ._:@/+-[] で120字まで）。`
      + "分からなければ渡さない（記録は unknown になる）。推測で埋めないこと。",
    );
    error.code = HOST_MODEL_INVALID_CODE;
    throw error;
  }
  return text;
}

/**
 * 入口（MCP / CLI）で1回だけ呼ぶ。MCP は clientInfo を先に見て、無ければ MCP サーバー自身の
 * 環境を見る。CLI は環境だけを見て、どのホストの印も無ければ "cli"。
 * 返すのは operation・mode・at を持たない「呼び出し元」の記述で、service が操作ごとに足す。
 */
export function detectHostInvocation({
  via,
  clientInfo = null,
  env = process.env,
  hostModel = "",
  readFile = readFileSync,
} = {}) {
  const channel = HOST_VIAS.includes(via) ? via : UNKNOWN;
  const detected = (channel === "mcp" ? hostFromMcpClientInfo(clientInfo) : null)
    || hostFromEnvironment(env, { readFile })
    || {
      host: channel === "cli" ? "cli" : UNKNOWN,
      hostVersion: UNKNOWN,
      clientName: "",
      detectedFrom: "none",
      candidates: [],
    };
  const model = declaredHostModel(hostModel);
  return {
    host: detected.host,
    hostVersion: detected.hostVersion,
    clientName: detected.clientName || "",
    candidates: detected.candidates || [],
    model: model || UNKNOWN,
    modelSource: model ? "caller-declared" : "unavailable",
    buzzassistVersion: buzzassistVersion(),
    via: channel,
    detectedFrom: detected.detectedFrom,
  };
}

/** 入口が記述を渡さなかった呼び出し（ライブラリの直接呼び出し）の記述。推測しない。 */
export function unprovidedHostInvocation() {
  return {
    host: UNKNOWN,
    hostVersion: UNKNOWN,
    clientName: "",
    candidates: [],
    model: UNKNOWN,
    modelSource: "unavailable",
    buzzassistVersion: buzzassistVersion(),
    via: UNKNOWN,
    detectedFrom: "not-provided",
  };
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`host invocation の ${label} が不正: ${String(value).slice(0, 80)}`);
  return value;
}

function tokenOrUnknown(value, pattern, label) {
  const text = typeof value === "string" ? value : "";
  if (text === UNKNOWN) return UNKNOWN;
  if (!pattern.test(text)) throw new Error(`host invocation の ${label} が不正。`);
  return text;
}

/**
 * 1回の呼び出しの記録を、決まった鍵・決まった値の範囲へ揃える。範囲外は拒否する——
 * 黙って丸めると、改変された記録と正しい記録が同じ形に収束する。
 */
export function normalizeHostInvocation(entry = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("host invocation は object であること。");
  const at = typeof entry.at === "string" ? entry.at : "";
  if (!at || !Number.isFinite(Date.parse(at))) throw new Error("host invocation の at が時刻ではない。");
  const clientName = typeof entry.clientName === "string" ? entry.clientName : "";
  if (clientName && clientName !== UNKNOWN && !CLIENT_NAME_TOKEN.test(clientName)) {
    throw new Error("host invocation の clientName が不正。");
  }
  const candidates = Array.isArray(entry.candidates) ? entry.candidates : [];
  const modelSource = oneOf(entry.modelSource, HOST_MODEL_SOURCES, "modelSource");
  const model = tokenOrUnknown(entry.model, MODEL_TOKEN, "model");
  if ((modelSource === "caller-declared") !== (model !== UNKNOWN)) {
    throw new Error("host invocation の model と modelSource が食い違う。");
  }
  return {
    host: oneOf(entry.host, HOST_IDS, "host"),
    hostVersion: tokenOrUnknown(entry.hostVersion, VERSION_TOKEN, "hostVersion"),
    clientName,
    candidates: [...new Set(candidates.map((value) => oneOf(value, HOST_IDS, "candidates")))].sort(),
    model,
    modelSource,
    buzzassistVersion: tokenOrUnknown(entry.buzzassistVersion, VERSION_TOKEN, "buzzassistVersion"),
    via: oneOf(entry.via, HOST_VIAS, "via"),
    detectedFrom: oneOf(entry.detectedFrom, HOST_DETECTED_FROM, "detectedFrom"),
    operation: oneOf(entry.operation, HOST_OPERATIONS, "operation"),
    mode: oneOf(entry.mode, HOST_MODES, "mode"),
    at,
  };
}

/** Job の metadata.invocation。作った記録と再開の記録を分けて持つ。 */
export function createJobInvocationRecord(createdBy = null) {
  return {
    version: HOST_INVOCATION_VERSION,
    createdBy: createdBy ? normalizeHostInvocation(createdBy) : null,
    resumedBy: [],
  };
}

/** 再開の記録を1件足す。作った記録（createdBy）は書き換えない。 */
export function appendResumedInvocation(record, entry) {
  const current = record && typeof record === "object" && record.version === HOST_INVOCATION_VERSION
    ? record
    : createJobInvocationRecord(null);
  return {
    version: HOST_INVOCATION_VERSION,
    createdBy: current.createdBy ?? null,
    resumedBy: [
      ...(Array.isArray(current.resumedBy) ? current.resumedBy : []),
      normalizeHostInvocation(entry),
    ].slice(-MAX_RESUMED_BY),
  };
}

/**
 * 集計のための要約。host は「実行した呼び出し」（mode=execute の作成と、全ての再開）の
 * ホストを並べたもので、1つなら "codex"、複数なら "claude-code+codex" のように混在を隠さない。
 * 計画だけを作った呼び出しは数えない（端末で計画し Claude Code で実行した Job は claude-code）。
 * 記録そのものが無い（host を残す前の版の Receipt）ときは "unrecorded"。
 */
export function invocationHostSummary(invocation) {
  if (!invocation || typeof invocation !== "object") {
    return { recorded: false, hostKey: "unrecorded", hosts: [], createdByHost: "", buzzassistVersion: UNKNOWN, models: [], hostVersions: [] };
  }
  const createdBy = invocation.createdBy && typeof invocation.createdBy === "object" ? invocation.createdBy : null;
  const resumedBy = Array.isArray(invocation.resumedBy) ? invocation.resumedBy : [];
  const executions = [...(createdBy?.mode === "execute" ? [createdBy] : []), ...resumedBy];
  const hosts = [...new Set(executions.map((entry) => String(entry?.host || UNKNOWN)))].sort();
  const last = executions.at(-1) || createdBy;
  return {
    recorded: true,
    hostKey: hosts.length > 0 ? hosts.join("+") : String(createdBy?.host || UNKNOWN),
    hosts,
    createdByHost: String(createdBy?.host || ""),
    buzzassistVersion: String(last?.buzzassistVersion || UNKNOWN),
    models: [...new Set(executions.map((entry) => String(entry?.model || UNKNOWN)))].sort(),
    hostVersions: [...new Set(executions.map((entry) => `${entry?.host || UNKNOWN}@${entry?.hostVersion || UNKNOWN}`))].sort(),
  };
}
