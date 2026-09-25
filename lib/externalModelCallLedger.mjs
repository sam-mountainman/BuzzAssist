// 外部モデル（Antigravity 経由の Gemini、Codex、Claude など）への呼び出しを、本文を持たずに
// 記録する台帳。
//
// なぜ要るか: 台本づくりには、ホストが書いた初稿を外部モデルに手直しさせる工程がある。
// その呼び出しで何を渡し何が返ったかは中継ツールの私有領域にしか残らず、品質ループの回が
// 「どの呼び出しの結果を採点したか」を指せなかった。空返答・途中切れも、あとから見ると
// 成功した呼び出しと区別が付かなかった。
//
// 設計（ホストの分担）:
//
//   - **Antigravity にはフックの仕組みが無い**（Claude Code と Codex には UserPromptSubmit
//     などのフックがあるが、Antigravity には無い）。だから Antigravity 側で呼び出しを自動で
//     記録することはできない
//   - そこで **呼び出した側のホスト（Claude Code / Codex）が、呼び出しのたびにこの台帳へ
//     記録する**。入口は `node scripts/harness-external-call.mjs record`
//   - 返った id を、台本の品質ループ（lib/scriptQualityLoop.mjs）の回が参照する
//
// 守ること:
//
//   - **本文は保存しない**。入出力は SHA-256 と byte 数だけ。台本・プロンプト・返答の文は
//     台帳に入れない（台帳を読める人に台本が漏れない）
//   - **空返答・途中切れを未完として残す**。出力が空なら、呼び出し元が complete と言っても
//     empty として記録する（申告より実測を優先する）
//   - **台帳は私有の場所に置く**。公開リポジトリの追跡対象の中には書かない（git が無視する
//     場所だけ許す）。置き場は台本の作業フォルダか Channel Pack
//   - **同じ呼び出しを二重に数えない**。同じ内容の記録は同じ id になり、追記しない

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { withCanvasFileLock } from "./canvasFileLock.mjs";
import { inspectLearningText, describeLearningBlockReasons } from "./harnessLearningInspection.mjs";

export const EXTERNAL_CALL_RECORD_VERSION = "buzzassist-external-call-v1";
export const EXTERNAL_CALL_LEDGER_DIR = "quality";
export const EXTERNAL_CALL_LEDGER_FILE = "external-calls.jsonl";
/** 外部モデルを実行したホスト。 */
export const EXTERNAL_CALL_HOSTS = Object.freeze(["antigravity", "codex", "claude"]);
/**
 * 呼び出し元（記録する側）のホスト。ふつうは Claude Code か Codex。Antigravity が自分で別の
 * モデルを呼んだときは、Antigravity が呼び出し元として記録する（環境からは推せないので明示する）。
 */
export const EXTERNAL_CALL_CALLER_HOSTS = Object.freeze(["claude-code", "codex", "antigravity", "unknown"]);
export const EXTERNAL_CALL_STATUSES = Object.freeze(["complete", "empty", "truncated", "error", "timeout", "usage-limit"]);
export const EXTERNAL_CALL_INCOMPLETE_STATUSES = Object.freeze(EXTERNAL_CALL_STATUSES.filter((status) => status !== "complete"));

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const REASON_CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const CALL_ID = /^xcall-[a-f0-9]{20}$/u;
const MAX_PURPOSE_CHARS = 200;
const MAX_LEDGER_BYTES = 32 * 1024 * 1024;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isoOrEmpty(value, label) {
  const text = nonEmpty(value);
  if (!text) return "";
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} は ISO 形式の時刻にしてください。`);
  return new Date(text).toISOString();
}

export function isExternalCallId(value) {
  return CALL_ID.test(String(value ?? ""));
}

/**
 * 呼び出し元のホストを環境から推す。明示（--caller-host）が勝つ。
 * Claude Code は子プロセスへ CLAUDECODE=1 を渡す。Codex は CODEX_ で始まる変数を渡す。
 */
export function inferCallerHost(env = process.env) {
  if (String(env?.CLAUDECODE ?? "").trim() === "1") return "claude-code";
  if (Object.keys(env || {}).some((key) => key.startsWith("CODEX_"))) return "codex";
  return "unknown";
}

/** 台帳の置き場。明示の --ledger が勝ち、無ければ作業フォルダの quality/external-calls.jsonl。 */
export function externalCallLedgerPath({ workDir = "", ledger = "" } = {}) {
  if (nonEmpty(ledger)) return resolve(ledger);
  if (nonEmpty(workDir)) return join(resolve(workDir), EXTERNAL_CALL_LEDGER_DIR, EXTERNAL_CALL_LEDGER_FILE);
  throw new Error("台帳の置き場が要ります（--work-dir <台本の作業フォルダ> か --ledger <file.jsonl>）。");
}

function gitIgnores(repoRoot, relativePath) {
  try {
    execFileSync("git", ["-C", repoRoot, "check-ignore", "-q", "--", relativePath], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    // 1 = 無視されていない、128 = git の外・git が無い。どちらも「私有と確かめられない」。
    return false;
  }
}

/**
 * 台帳を公開リポジトリの追跡対象へ書かせない。BuzzAssist のリポジトリの中なら、git が
 * 無視する場所（channel-packs/・client-work/・canvas/ など）だけを許す。確かめられなければ止める。
 */
export function assertPrivateLedgerLocation(ledgerPath, { repoRoot = REPO_ROOT, isIgnored = gitIgnores } = {}) {
  const rel = relative(resolve(repoRoot), resolve(ledgerPath));
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (!inside) return;
  if (!isIgnored(resolve(repoRoot), rel.split("\\").join("/"))) {
    throw new Error(
      "外部モデル呼び出しの台帳を、公開リポジトリの追跡対象の中には書きません。"
      + "台本の作業フォルダ（私有側）か Channel Pack の下を --work-dir / --ledger で指定してください。",
    );
  }
}

function normalizePurpose(value) {
  const text = nonEmpty(value).replace(/[\r\n\u2028\u2029]+/gu, " ").replace(/\s{2,}/gu, " ");
  if (Array.from(text).length < 4) throw new Error("--purpose に用途を書いてください（例: 台本の語り口の手直し）。");
  if (Array.from(text).length > MAX_PURPOSE_CHARS) throw new Error(`--purpose は ${MAX_PURPOSE_CHARS} 文字以内にしてください（本文は台帳に入れません）。`);
  const reasons = inspectLearningText(text);
  if (reasons.length > 0) {
    throw new Error(`--purpose が書き込み前の検査に当たりました: ${describeLearningBlockReasons(reasons)}。用途だけを一般的な言い方で書いてください。`);
  }
  return text;
}

async function digestFile(filePath, { optional = false } = {}) {
  const path = resolve(String(filePath));
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw new Error(`${optional ? "出力" : "入力"}ファイルを読めません（${error?.code || error?.message}）。`);
  }
  if (!info.isFile()) throw new Error(`${optional ? "出力" : "入力"}は通常ファイルにしてください。`);
  const bytes = await readFile(path);
  return {
    sha256: sha256(bytes),
    bytes: bytes.length,
    // 空白だけの返答は空返答として扱う（Antigravity の非対話実行は空の本文を返すことがある）。
    blank: bytes.toString("utf8").trim() === "",
  };
}

/**
 * 1件の記録を作る（純関数）。出力が空なら、申告が complete でも empty にする。
 */
export function buildExternalCallRecord({
  host,
  model,
  purpose,
  input,
  output = null,
  status = "complete",
  incompleteReason = "",
  callerHost = "unknown",
  callerSession,
  startedAt = "",
  finishedAt = "",
  recordedAt = new Date().toISOString(),
} = {}) {
  const hostId = nonEmpty(host);
  if (!EXTERNAL_CALL_HOSTS.includes(hostId)) throw new Error(`--host は ${EXTERNAL_CALL_HOSTS.join(" / ")} のどれかにしてください。`);
  const modelId = nonEmpty(model);
  if (!MODEL_ID.test(modelId)) throw new Error("--model はモデルの id（英数字と . _ : / @ + -）にしてください。");
  const caller = nonEmpty(callerHost) || "unknown";
  if (!EXTERNAL_CALL_CALLER_HOSTS.includes(caller)) throw new Error(`--caller-host は ${EXTERNAL_CALL_CALLER_HOSTS.join(" / ")} のどれかにしてください。`);
  const session = nonEmpty(callerSession);
  if (!SESSION_ID.test(session)) {
    throw new Error("--session に呼び出し元の会話・タスクの ID が要ります（英数字と . _ : @ -）。採点する文脈と呼び出した文脈を見分けるのに使います。");
  }
  const requested = nonEmpty(status) || "complete";
  if (!EXTERNAL_CALL_STATUSES.includes(requested)) throw new Error(`--status は ${EXTERNAL_CALL_STATUSES.join(" / ")} のどれかにしてください。`);
  if (!input?.sha256 || !/^[a-f0-9]{64}$/u.test(input.sha256)) throw new Error("入力の SHA-256 が要ります。");
  const outputRow = output && /^[a-f0-9]{64}$/u.test(String(output.sha256 || "")) ? output : null;
  // 申告より実測。出力が無い・空白だけなら、complete と言われても空返答として残す。
  const outputBlank = !outputRow || outputRow.blank === true || outputRow.bytes === 0;
  const effective = requested === "complete" && outputBlank ? "empty" : requested;
  const reason = nonEmpty(incompleteReason);
  if (reason && effective === "complete") throw new Error("--incomplete-reason は未完の呼び出しにだけ付けます。");
  if (reason && !REASON_CODE.test(reason)) throw new Error("--incomplete-reason は kebab-case のコードにしてください（例: empty-response, usage-limit）。");
  const started = isoOrEmpty(startedAt, "--started-at");
  const finished = isoOrEmpty(finishedAt, "--finished-at");
  if (started && finished && Date.parse(finished) < Date.parse(started)) throw new Error("--finished-at が --started-at より前です。");
  const identity = {
    version: EXTERNAL_CALL_RECORD_VERSION,
    host: hostId,
    model: modelId,
    purpose: normalizePurpose(purpose),
    callerHost: caller,
    callerSession: session,
    input: { sha256: input.sha256, bytes: Number(input.bytes) || 0 },
    output: outputRow ? { sha256: outputRow.sha256, bytes: Number(outputRow.bytes) || 0 } : null,
    status: effective,
    ...(reason ? { incompleteReason: reason } : {}),
    ...(started ? { startedAt: started } : {}),
    ...(finished ? { finishedAt: finished } : {}),
  };
  return {
    id: `xcall-${sha256(canonicalJson(identity)).slice(0, 20)}`,
    ...identity,
    ...(effective !== requested ? { statusCorrected: { requested, reason: "output-empty" } } : {}),
    ...(started && finished ? { durationMs: Date.parse(finished) - Date.parse(started) } : {}),
    recordedAt: new Date(recordedAt).toISOString(),
  };
}

/** 台帳を読む。壊れた行は黙って飛ばさない（記録が欠けたことに誰も気づかなくなる）。 */
export async function readExternalCallLedger(ledgerPath) {
  let text;
  try {
    const info = await stat(ledgerPath);
    if (info.size > MAX_LEDGER_BYTES) throw new Error("外部モデル呼び出しの台帳が大きすぎます。");
    text = await readFile(ledgerPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return text.split("\n").filter((line) => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`外部モデル呼び出しの台帳 ${index + 1} 行目が壊れています: ${error.message}`);
    }
  });
}

/** id → 記録。見つからない id は含めない（呼び出し側が「無い」を判定する）。 */
export async function findExternalCalls(ledgerPath, ids = []) {
  const wanted = new Set(ids.map(String));
  const found = new Map();
  for (const row of await readExternalCallLedger(ledgerPath)) {
    if (row?.version === EXTERNAL_CALL_RECORD_VERSION && wanted.has(String(row.id)) && !found.has(row.id)) found.set(row.id, row);
  }
  return found;
}

/**
 * 呼び出しを台帳へ追記し、id を返す。同じ内容の記録が既にあれば追記せずその id を返す。
 */
export async function recordExternalCall({
  ledgerPath,
  host,
  model,
  purpose,
  inputPath,
  outputPath,
  status = "complete",
  incompleteReason = "",
  callerHost = "",
  callerSession,
  startedAt = "",
  finishedAt = "",
  env = process.env,
  now = () => new Date().toISOString(),
  repoRoot = REPO_ROOT,
  isIgnored = gitIgnores,
} = {}) {
  if (!nonEmpty(ledgerPath)) throw new Error("台帳の置き場が要ります。");
  const target = resolve(ledgerPath);
  assertPrivateLedgerLocation(target, { repoRoot, isIgnored });
  if (!nonEmpty(inputPath)) throw new Error("--input に外部モデルへ渡した本文のファイルが要ります。");
  if (!nonEmpty(outputPath)) throw new Error("--output に返ってきた本文のファイルが要ります（空返答なら空のファイルか、存在しないパス）。");
  const input = await digestFile(inputPath);
  if (input.bytes === 0) throw new Error("入力が空です。外部モデルへ渡した本文のファイルを指定してください。");
  const output = await digestFile(outputPath, { optional: true });
  const record = buildExternalCallRecord({
    host,
    model,
    purpose,
    input,
    output,
    status,
    incompleteReason,
    callerHost: nonEmpty(callerHost) || inferCallerHost(env),
    callerSession,
    startedAt,
    finishedAt,
    recordedAt: now(),
  });
  return withCanvasFileLock(target, async () => {
    const existing = (await readExternalCallLedger(target)).find((row) => row?.id === record.id);
    if (existing) return { id: existing.id, record: existing, appended: false, ledgerPath: target };
    // 1行を1回の書き込みで出す（JSON.stringify は改行を含まない）。
    await appendFile(target, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    return { id: record.id, record, appended: true, ledgerPath: target };
  });
}
