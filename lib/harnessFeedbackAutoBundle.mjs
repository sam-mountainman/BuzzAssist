// 運営者の端末で Job が決着したときに自動で作る、提供元（BuzzAssist の開発側）宛の
// 署名つき feedback bundle（v3）。手動で curator report から作る v2 bundle
// （lib/harnessFeedbackBundle.mjs）と同じ原則で、運ぶのは次の3つだけ:
//
//   - 決着の要約（settlements）: ゲート id と判定・件数・issue コード・ハーネスの版・
//     動かしたホスト（RunReceipt / Job の invocation の要約）
//   - 提案の要約（proposals）: 提供元が既に知っている提案（配布物の公開 catalog にある id）の
//     id・kind・target と、新しく起きた回数とその指紋
//   - 未知の提案（new-candidates）: 提供元がまだ知らない共有層の提案のうち、チャンネル固有の
//     事実・端末のパス・人名・逐語の引用を含まないと確かめられたものの一般化した文
//
// 台本の本文・プロンプト・根拠（evidence）の文・session・端末のパス・人名・Channel Pack の語は
// 入れない。入れられる形（field）自体を持たせず（strict schema）、文を運ぶ唯一の field
// （generalizedText）と bundle 全体を、公開面の検査と同じ語彙（鍵つき digest 語彙と Channel Pack
// の語）で照合する。照合できない端末では作らない。
//
// 一般化できない提案は送らずに端末に残す（件数だけ bundle に入れる）。この module は
// 正本・台帳・catalog を書き換えない。

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, publicKeyId } from "./channelPackEnvelope.mjs";
import {
  normalizeHarnessFeedbackTarget,
  redactSharedLearningText,
} from "./harnessFeedbackBundle.mjs";
import { HOST_IDS, invocationHostSummary } from "./harnessHostProvenance.mjs";
import { inspectLearningText } from "./harnessLearningInspection.mjs";
import { isGateNotInForce } from "./harnessRunReceipt.mjs";
import { FEEDBACK_CONSENT_SCOPES } from "./harnessLearningState.mjs";
import { countVocabularyDigestHits } from "./packageTarballAudit.mjs";
import { loadSensitiveVocabulary, SENSITIVE_VOCABULARY_DIGEST_PATH } from "../scripts/audit-package-tarball.mjs";
import { collectSensitiveSignals, countMachineLocalPathHits } from "../scripts/audit-public-surface.mjs";

export const HARNESS_FEEDBACK_AUTO_BUNDLE_VERSION = "buzzassist-harness-feedback-v3";
export const HARNESS_FEEDBACK_AUTO_BUNDLE_KIND = "operator-auto-feedback";
/** 受け取る側の API（docs/harness-feedback-receiver-spec-ja.md）。v1 は手動の v2 bundle 用。 */
export const HARNESS_FEEDBACK_AUTO_ENDPOINT_PATH = "/v2/feedback/bundles";
export const HARNESS_FEEDBACK_PROVIDER_RECEIPT_VERSION = "buzzassist-feedback-ingest-receipt-v2";
export const HARNESS_FEEDBACK_AUTO_MAX_BYTES = 1024 * 1024;
/** 端末側の検査語彙を運営者が自分で置く場所（学習の置き場の直下）。配布物には語彙が入らないため。 */
export const OPERATOR_VOCABULARY_FILE = "sensitive-vocabulary.digest.json";

export const FEEDBACK_TRIGGERS = Object.freeze(["job-settled", "manual"]);
export const FEEDBACK_EVIDENCE_KINDS = Object.freeze([
  "run-receipt",
  "script-quality-round",
  "canvas-feedback",
  "operator-correction",
  "operator-preference",
  "operator-constraint",
  "measurement",
]);
/** 未知の提案を送らずに端末へ残す理由のコード。本文は出さない。 */
export const FEEDBACK_HOLD_REASONS = Object.freeze({
  "channel-target": "宛先が Channel Pack（運営者専用）",
  blocked: "書き込み前の検査に当たった提案",
  "private-term": "検査語彙に一致する語（人名・顧客の識別子など）",
  "channel-term": "Channel Pack の語（番組名・キャスト名・場所・台帳の文）",
  "machine-path": "端末のパス",
  "unsafe-text": "資格情報・注入・隠しコメント・不可視文字らしい形",
  "verbatim-quote": "長い引用（発言や台本の逐語の可能性）",
  "contact-address": "メールアドレスらしい形",
  url: "URL",
  "too-long": "長すぎる（一般化した1文の形ではない）",
  "too-short": "短すぎる（何を直すかが読めない）",
  "semantic-mismatch": "提供元の catalog と kind / target が食い違う",
});

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHA256 = /^[a-f0-9]{64}$/u;
const PROPOSAL_ID = /^[a-f0-9]{12}$/u;
const VERSION_TOKEN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u;
const HARNESS_ID = /^[a-z0-9][a-z0-9-]{0,80}$/u;
const GATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const STAGE_ID = /^[a-z][a-z0-9-]{0,40}$/u;
const ISSUE_CODE = /^(?:unclassified|[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*)$/u;
const MODEL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-[\]]{0,119}$/u;
const HOST_KEY = /^(?:unrecorded|[a-z-]{1,40}(?:\+[a-z-]{1,40}){0,4})$/u;
const KEY_ID = /^ed25519:[a-f0-9]{24}$/u;
const JOB_STATUSES = new Set(["completed", "failed", "awaiting-human-review"]);
const RECEIPT_SOURCES = new Set(["run-receipt", "adapter-run-receipt", "job-state"]);
const OUTCOMES = new Set(["pass", "fail", "none"]);
const VERDICTS = new Set(["pass", "fail", "skip", "not-in-force"]);
const PROPOSAL_KINDS = new Set(["correction", "preference", "constraint", "fact"]);
const SHARED_TARGET = /^(?:platform|genre):/u;
const FORBIDDEN_KEY = /(?:script|prompt|transcript|evidence.?text|session|channel.?pack|secret|token|api.?key|private.?key|authorization|cookie|provider.?response|artifact.?url|local.?path|path)/iu;
const TEXT_MIN = 12;
const TEXT_MAX = 400;
const LONG_QUOTE = /「[^」]{20,}」|『[^』]{20,}』|"[^"]{20,}"|“[^”]{20,}”/u;
const CONTACT_ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+/u;
const URL_TEXT = /\b(?:https?|ftp):\/\//iu;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function strictKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}はobjectであること。`);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`${label}に未許可field: ${unexpected.join(", ")}`);
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) throw new Error(`${label}にfieldが無い: ${missing.join(", ")}`);
}

function count(value, label, { minimum = 0, maximum = 1_000_000 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label}は${minimum}..${maximum}の整数であること。`);
  }
  return value;
}

function sha(value, label, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  const text = nonEmpty(value).toLowerCase();
  if (!SHA256.test(text)) throw new Error(`${label}はSHA-256であること。`);
  return text;
}

function token(value, pattern, label, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  const text = nonEmpty(value);
  if (!pattern.test(text)) throw new Error(`${label}が不正。`);
  return text;
}

function isoTime(value, label) {
  const text = nonEmpty(value);
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(text) || !Number.isFinite(Date.parse(text))) throw new Error(`${label}はISO-8601であること。`);
  return text;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function assertNoForbiddenKeys(value, location = "bundle") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, `${location}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    // privacy 宣言の「含まない」（false）だけは名前に禁止語を含んでよい。
    const negativeDeclaration = location === "bundle.privacy" && key.startsWith("contains") && nested === false;
    if (!negativeDeclaration && FORBIDDEN_KEY.test(key)) throw new Error(`${location}.${key}はfeedback bundleへ含められない。`);
    assertNoForbiddenKeys(nested, `${location}.${key}`);
  }
}

// ---- ハーネス宣言（ゲート id の語彙） -------------------------------------------------

/** config/harnesses/*.harness.json から、ハーネス id → { version, gateIds, digest }。 */
export function loadHarnessGateRegistry(codeRoot = MODULE_ROOT) {
  const dir = join(codeRoot, "config", "harnesses");
  const registry = new Map();
  let names = [];
  try { names = readdirSync(dir).filter((name) => name.endsWith(".harness.json")).sort(); } catch { names = []; }
  for (const name of names) {
    try {
      const bytes = readFileSync(join(dir, name));
      const declaration = JSON.parse(bytes.toString("utf8"));
      if (!HARNESS_ID.test(String(declaration?.id || ""))) continue;
      registry.set(declaration.id, {
        version: VERSION_TOKEN.test(String(declaration.version || "")) ? String(declaration.version) : null,
        gateIds: new Set((declaration.guarantees || []).map((entry) => String(entry?.id || "")).filter((id) => GATE_ID.test(id))),
        declarationDigest: sha256(bytes),
      });
    } catch {
      // 読めない宣言は語彙に入れない（その harness の決着は要約しない）。
    }
  }
  return registry;
}

// ---- 照合の材料（公開面の検査と同じ語彙） ------------------------------------------------

/**
 * bundle の照合に使う材料。公開面の検査と同じもの——鍵つき digest 語彙
 * （docs/learning/sensitive-vocabulary.digest.json）と、Channel Pack から集めた語・ID・文。
 *
 * 配布物には語彙が入らないので、運営者の端末では学習の置き場の直下
 * （<learning>/sensitive-vocabulary.digest.json、鍵は ~/.buzzassist/sensitive-vocabulary.key か
 * BUZZASSIST_SENSITIVE_VOCABULARY_KEY）に運営者が自分の語彙を置く。どちらも照合できなければ
 * available: false（bundle を作らない）。
 */
export function loadFeedbackPrivacyContext({
  codeRoot = MODULE_ROOT,
  operatorDir = "",
  env = process.env,
  homeDir = homedir(),
  signals = undefined,
} = {}) {
  const collected = signals ?? collectSensitiveSignals(codeRoot);
  const base = {
    terms: [...(collected?.terms || [])],
    castIds: [...(collected?.castIds || [])],
    sentences: [...(collected?.sentences || [])],
    homeRoot: homeDir,
  };
  const candidates = [
    { file: join(codeRoot, SENSITIVE_VOCABULARY_DIGEST_PATH), source: "code-root" },
    ...(nonEmpty(operatorDir) ? [{ file: join(operatorDir, OPERATOR_VOCABULARY_FILE), source: "operator-state" }] : []),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate.file)) continue;
    let loaded;
    try {
      loaded = loadSensitiveVocabulary(candidate.file, { projectDir: codeRoot, env });
    } catch {
      return { ...base, available: false, reason: "vocabulary-invalid", vocabulary: null, vocabularySource: candidate.source };
    }
    if (!loaded.vocabulary) {
      return { ...base, available: false, reason: `vocabulary-${loaded.state || "unavailable"}`, vocabulary: null, vocabularySource: candidate.source };
    }
    return { ...base, available: true, reason: null, vocabulary: loaded.vocabulary, vocabularySource: candidate.source };
  }
  return { ...base, available: false, reason: "vocabulary-missing-file", vocabulary: null, vocabularySource: null };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * 文字列を照合する。当たった語そのものは返さず、理由のコードだけを返す。
 * 語彙（vocabulary）が無い文脈では照合しない代わりに available を見て呼び出し側が止める。
 */
export function scanFeedbackText(text, context = {}) {
  const value = String(text ?? "");
  const reasons = new Set();
  if (!value) return [];
  if (context.vocabulary && countVocabularyDigestHits(value, context.vocabulary) > 0) reasons.add("private-term");
  if ((context.terms || []).some((term) => String(term).length >= 2 && value.includes(term))
    || (context.castIds || []).some((id) => String(id).length >= 3 && new RegExp(`\\b${escapeRegExp(id)}\\b`, "u").test(value))
    || (context.sentences || []).some((sentence) => value.includes(sentence))) {
    reasons.add("channel-term");
  }
  const inspection = inspectLearningText(value, { homeRoot: context.homeRoot || homedir() });
  if (inspection.includes("absolute-path")) reasons.add("machine-path");
  if (inspection.some((code) => code !== "absolute-path")) reasons.add("unsafe-text");
  if (countMachineLocalPathHits(value, context.homeRoot || "") > 0) reasons.add("machine-path");
  // 共有層へ出す文の置換規則（~/… や /Users/… の形、資格情報）に1件でも当たれば、文をそのまま出さない。
  if (redactSharedLearningText(value, { homeRoot: context.homeRoot || "" }).hits > 0) reasons.add("machine-path");
  return Object.keys(FEEDBACK_HOLD_REASONS).filter((code) => reasons.has(code));
}

// ---- 未知の提案の一般化 ----------------------------------------------------------------

/**
 * 未知の提案を bundle に入れてよい一般化した文にする。モデルは呼ばない（決定論）。
 *
 * 規則: 提案の文を空白だけ畳み、チャンネル固有の事実（語彙・Channel Pack の語）・端末のパス・
 * 資格情報らしい形・長い引用・URL・メールアドレスが1つも無く、長さが一般化した1文の範囲に
 * あるときだけ、その文を一般化した文とみなす。1つでも当たれば送らない（書き換えて送る道は
 * 作らない——置換した文は元の意味を保証できず、置換の痕から元の語を推測させる）。
 */
export function generalizeProposalText(text, context = {}) {
  const value = String(text ?? "").replace(/\s+/gu, " ").trim();
  const reasons = new Set(scanFeedbackText(value, context));
  if (LONG_QUOTE.test(value)) reasons.add("verbatim-quote");
  if (CONTACT_ADDRESS.test(value)) reasons.add("contact-address");
  if (URL_TEXT.test(value)) reasons.add("url");
  const length = [...value].length;
  if (length > TEXT_MAX) reasons.add("too-long");
  if (length < TEXT_MIN) reasons.add("too-short");
  const ordered = Object.keys(FEEDBACK_HOLD_REASONS).filter((code) => reasons.has(code));
  return ordered.length === 0 ? { ok: true, text: value, reasons: [] } : { ok: false, text: null, reasons: ordered };
}

/** 提案の行から根拠の種類だけを取り出す（根拠の文そのものは読まない）。 */
export function evidenceKindOf(row = {}) {
  if (row.createdBy === "auto-receipt") return "run-receipt";
  if (row.createdBy === "auto-script-quality") return "script-quality-round";
  if (String(row.session || "").startsWith("canvas-feedback:")) return "canvas-feedback";
  return {
    correction: "operator-correction",
    preference: "operator-preference",
    constraint: "operator-constraint",
    fact: "measurement",
  }[row.kind] || "measurement";
}

/**
 * 共有台帳の行を、既知の提案・未知の一般化できる提案・端末に残す提案へ分ける。
 *
 * @param rows      共有台帳（platform / genre）の行。channel-pack 宛の台帳は渡さない
 * @param catalog   提供元が知っている提案（配布物の公開 catalog: id → {kind, target}）
 * @param reported  既に bundle に入れた指紋（id → Set(occurrenceDigest)）
 * @param occurrenceDigestOf 1行の出来事の指紋（lib/harnessLearningCurator.mjs と同じもの）
 */
export function partitionProposalsForFeedback({
  rows = [],
  catalog = new Map(),
  reported = new Map(),
  occurrenceDigestOf,
  proposalIdOf,
  context = {},
} = {}) {
  if (typeof occurrenceDigestOf !== "function" || typeof proposalIdOf !== "function") {
    throw new Error("occurrenceDigestOf と proposalIdOf が要る。");
  }
  const byId = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = nonEmpty(row.id) || proposalIdOf(row);
    if (!PROPOSAL_ID.test(id) || !PROPOSAL_KINDS.has(row.kind)) continue;
    let target;
    try { target = normalizeHarnessFeedbackTarget(row.target); } catch { continue; }
    if (!byId.has(id)) {
      byId.set(id, { id, kind: row.kind, target, text: String(row.text || ""), blocked: false, digests: new Set(), evidenceKinds: new Set() });
    }
    const entry = byId.get(id);
    if (row.blocked) entry.blocked = true;
    entry.digests.add(occurrenceDigestOf({ ...row, id }));
    entry.evidenceKinds.add(evidenceKindOf(row));
  }
  const known = [];
  const candidates = [];
  const held = [];
  for (const entry of [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    const already = reported.get(entry.id) || new Set();
    const fresh = [...entry.digests].filter((digest) => !already.has(digest)).sort();
    if (fresh.length === 0) continue;
    const base = { id: entry.id, target: entry.target, occurrences: fresh.length };
    if (!SHARED_TARGET.test(entry.target)) { held.push({ ...base, reasons: ["channel-target"] }); continue; }
    if (entry.blocked) { held.push({ ...base, reasons: ["blocked"] }); continue; }
    const known_ = catalog.get(entry.id);
    if (known_) {
      if (known_.kind !== entry.kind || known_.target !== entry.target) {
        held.push({ ...base, reasons: ["semantic-mismatch"] });
        continue;
      }
      known.push({ id: entry.id, kind: entry.kind, target: entry.target, occurrences: fresh.length, occurrenceDigests: fresh });
      continue;
    }
    const general = generalizeProposalText(entry.text, context);
    if (!general.ok) { held.push({ ...base, reasons: general.reasons }); continue; }
    candidates.push({
      candidateId: entry.id,
      kind: entry.kind,
      target: entry.target,
      generalizedText: general.text,
      evidenceKinds: FEEDBACK_EVIDENCE_KINDS.filter((kind) => entry.evidenceKinds.has(kind)),
      occurrences: fresh.length,
      occurrenceDigests: fresh,
    });
  }
  return { known, candidates, held };
}

// ---- 決着の要約 ------------------------------------------------------------------------

function hostSection(invocation) {
  const summary = invocationHostSummary(invocation);
  if (!summary.recorded) return { hostKey: "unrecorded", hosts: [], createdByHost: "unknown", buzzassistVersion: "unknown", models: [], hostVersions: [] };
  const hostOk = (value) => HOST_IDS.includes(value);
  return {
    hostKey: HOST_KEY.test(summary.hostKey) ? summary.hostKey : "unknown",
    hosts: sortedUnique(summary.hosts.filter(hostOk)),
    createdByHost: hostOk(summary.createdByHost) ? summary.createdByHost : "unknown",
    buzzassistVersion: VERSION_TOKEN.test(summary.buzzassistVersion) ? summary.buzzassistVersion : "unknown",
    models: sortedUnique(summary.models.map((model) => (MODEL_TOKEN.test(model) ? model : "unknown"))),
    hostVersions: sortedUnique(summary.hostVersions.filter((value) => {
      const [host, version] = String(value).split("@");
      return hostOk(host) && VERSION_TOKEN.test(version || "");
    })),
  };
}

function mergeMaxCounts(...maps) {
  const out = new Map();
  for (const map of maps) for (const [key, value] of map) out.set(key, Math.max(out.get(key) || 0, value));
  return out;
}

function countIssueCodes(values, issueCodeOf) {
  const counts = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const code = String(issueCodeOf(value));
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return counts;
}

/**
 * 1回の決着の要約。ゲート id と判定・件数・issue コード・工程 id・ホストだけ。
 *
 * @param located  { receipt, digest, source }（lib/harnessReceiptLearning.mjs の locateJobRunReceipt）か null
 * @param sourceDigest 決着の指紋（Receipt の sha256、無ければ Job の状態の指紋）
 * @param issueCodeOf  knownRemainingIssues / blockers の1件をコードへ丸める関数（自由文は運ばない）
 */
export function buildSettlementSummary({
  job,
  located = null,
  sourceDigest,
  registry = loadHarnessGateRegistry(),
  issueCodeOf,
  context = {},
} = {}) {
  if (typeof issueCodeOf !== "function") throw new Error("issueCodeOf が要る。");
  const receipt = located?.receipt ?? null;
  const harnessId = String(receipt?.harnessBuild?.harness?.id || job?.harness?.id || "");
  const declared = registry.get(harnessId);
  if (!declared) return { harness: null, settlement: null, skippedReason: "unknown-harness" };
  const harnessVersion = String(receipt?.harnessBuild?.harness?.version || job?.harness?.declarationVersion || "");
  const receiptDigestOfDeclaration = String(receipt?.harnessBuild?.harness?.declarationDigest || "");
  const harness = {
    harnessId,
    harnessVersion: VERSION_TOKEN.test(harnessVersion) ? harnessVersion : null,
    declarationDigest: SHA256.test(receiptDigestOfDeclaration) ? receiptDigestOfDeclaration : declared.declarationDigest,
  };
  const gates = [];
  const gateCounts = { declared: declared.gateIds.size, pass: 0, fail: 0, skip: 0, notInForce: 0, missing: 0 };
  if (receipt) {
    for (const gateId of [...declared.gateIds].sort()) {
      const gate = receipt.gates?.[gateId];
      if (!gate) { gateCounts.missing += 1; continue; }
      const verdict = isGateNotInForce(gate) ? "not-in-force" : String(gate.verdict || "");
      if (!VERDICTS.has(verdict)) { gateCounts.missing += 1; continue; }
      gates.push({ gateId, verdict });
      gateCounts[verdict === "not-in-force" ? "notInForce" : verdict] += 1;
    }
  } else {
    gateCounts.missing = declared.gateIds.size;
  }
  // issue のコードは自由文の先頭語から作るので、照合に当たったものは unclassified に丸める。
  const codeOf = (value) => {
    const code = String(issueCodeOf(value));
    if (!ISSUE_CODE.test(code) || code.length > 64) return "unclassified";
    return scanFeedbackText(code, context).length > 0 ? "unclassified" : code;
  };
  const merged = mergeMaxCounts(
    countIssueCodes(receipt?.knownRemainingIssues, codeOf),
    countIssueCodes(job?.knownRemainingIssues, codeOf),
    countIssueCodes(job?.blockers, codeOf),
  );
  const issueCodes = [...merged].sort(([left], [right]) => left.localeCompare(right)).slice(0, 50)
    .map(([code, value]) => ({ code, count: value }));
  const resume = receipt?.resumeFromFailed || job?.resumeFromFailed || null;
  const failedStages = sortedUnique((job?.stages || [])
    .filter((stage) => stage?.status === "failed" && STAGE_ID.test(String(stage?.id || "")))
    .map((stage) => stage.id)).slice(0, 20);
  const outcome = receipt ? (OUTCOMES.has(String(receipt.outcome)) ? String(receipt.outcome) : "none") : "none";
  const jobStatus = String(job?.status || "");
  return {
    harness,
    settlement: {
      sourceDigest: sha(sourceDigest, "sourceDigest"),
      receiptSource: RECEIPT_SOURCES.has(String(located?.source || "")) ? String(located.source) : "job-state",
      jobStatus: JOB_STATUSES.has(jobStatus) ? jobStatus : "failed",
      outcome,
      outcomeOverridden: receipt?.outcomeOverridden === true,
      gates,
      gateCounts,
      issueCodes,
      counts: {
        mediaJobRetries: (receipt?.mediaJobs || []).reduce((sum, mediaJob) => sum + safeCount(mediaJob?.attempts?.retryCount), 0),
        incompleteMediaJobs: safeCount(receipt?.summary?.incompleteMediaJobCount),
        imageRetries: safeCount(receipt?.imageRetry?.attempts),
        resumeAttempts: safeCount(resume?.attempts),
        pendingReceiptAttempts: safeCount(job?.pendingReceiptFinalization?.attempts),
      },
      failedStages,
      host: hostSection(job?.metadata?.invocation ?? receipt?.invocation),
    },
  };
}

// ---- payload の形 ------------------------------------------------------------------------

const PRIVACY = Object.freeze({
  containsScriptText: false,
  containsPrompts: false,
  containsEvidenceText: false,
  containsSessionIds: false,
  containsPaths: false,
  containsPersonNames: false,
  containsChannelTerms: false,
  vocabularyChecked: true,
});

function normalizeGateList(gates, gateIds) {
  if (!Array.isArray(gates) || gates.length > 200) throw new Error("settlement.gatesは200件以下のarrayであること。");
  const seen = new Set();
  return gates.map((gate) => {
    strictKeys(gate, ["gateId", "verdict"], "settlement.gate");
    const gateId = token(gate.gateId, GATE_ID, "settlement.gate.gateId");
    if (gateIds && !gateIds.has(gateId)) throw new Error("settlement.gate.gateIdがHarness宣言の既知gateではない。");
    if (seen.has(gateId)) throw new Error("settlement.gatesにgateIdが重複している。");
    seen.add(gateId);
    if (!VERDICTS.has(gate.verdict)) throw new Error("settlement.gate.verdictが不正。");
    return { gateId, verdict: gate.verdict };
  }).sort((left, right) => left.gateId.localeCompare(right.gateId));
}

function normalizeHost(value) {
  strictKeys(value, ["hostKey", "hosts", "createdByHost", "buzzassistVersion", "models", "hostVersions"], "settlement.host");
  const host = (item) => {
    if (item !== "unknown" && !HOST_IDS.includes(item)) throw new Error("settlement.hostのhostが不正。");
    return item;
  };
  if (!Array.isArray(value.hosts) || !Array.isArray(value.models) || !Array.isArray(value.hostVersions)
    || value.hosts.length > 10 || value.models.length > 20 || value.hostVersions.length > 20) {
    throw new Error("settlement.hostの配列が不正。");
  }
  return {
    hostKey: value.hostKey === "unknown" ? "unknown" : token(value.hostKey, HOST_KEY, "settlement.host.hostKey"),
    hosts: sortedUnique(value.hosts.map(host)),
    createdByHost: host(value.createdByHost),
    buzzassistVersion: value.buzzassistVersion === "unknown" ? "unknown" : token(value.buzzassistVersion, VERSION_TOKEN, "settlement.host.buzzassistVersion"),
    models: sortedUnique(value.models.map((model) => (model === "unknown" ? model : token(model, MODEL_TOKEN, "settlement.host.model")))),
    hostVersions: sortedUnique(value.hostVersions.map((entry) => {
      const [name, version] = String(entry).split("@");
      host(name);
      token(version, VERSION_TOKEN, "settlement.host.hostVersion");
      return `${name}@${version}`;
    })),
  };
}

function normalizeSettlement(value, gateIds) {
  if (value === null) return null;
  strictKeys(value, ["sourceDigest", "receiptSource", "jobStatus", "outcome", "outcomeOverridden", "gates", "gateCounts", "issueCodes", "counts", "failedStages", "host"], "settlement");
  if (!RECEIPT_SOURCES.has(value.receiptSource)) throw new Error("settlement.receiptSourceが不正。");
  if (!JOB_STATUSES.has(value.jobStatus)) throw new Error("settlement.jobStatusが不正。");
  if (!OUTCOMES.has(value.outcome)) throw new Error("settlement.outcomeが不正。");
  if (typeof value.outcomeOverridden !== "boolean") throw new Error("settlement.outcomeOverriddenはbooleanであること。");
  strictKeys(value.gateCounts, ["declared", "pass", "fail", "skip", "notInForce", "missing"], "settlement.gateCounts");
  strictKeys(value.counts, ["mediaJobRetries", "incompleteMediaJobs", "imageRetries", "resumeAttempts", "pendingReceiptAttempts"], "settlement.counts");
  if (!Array.isArray(value.issueCodes) || value.issueCodes.length > 50) throw new Error("settlement.issueCodesは50件以下のarrayであること。");
  if (!Array.isArray(value.failedStages) || value.failedStages.length > 20) throw new Error("settlement.failedStagesは20件以下のarrayであること。");
  const issueSeen = new Set();
  return {
    sourceDigest: sha(value.sourceDigest, "settlement.sourceDigest"),
    receiptSource: value.receiptSource,
    jobStatus: value.jobStatus,
    outcome: value.outcome,
    outcomeOverridden: value.outcomeOverridden,
    gates: normalizeGateList(value.gates, gateIds),
    gateCounts: Object.fromEntries(Object.entries(value.gateCounts).map(([key, item]) => [key, count(item, `settlement.gateCounts.${key}`, { maximum: 1000 })])),
    issueCodes: value.issueCodes.map((entry) => {
      strictKeys(entry, ["code", "count"], "settlement.issueCode");
      const code = token(entry.code, ISSUE_CODE, "settlement.issueCode.code");
      if (code.length > 64 || issueSeen.has(code)) throw new Error("settlement.issueCode.codeが不正か重複している。");
      issueSeen.add(code);
      return { code, count: count(entry.count, "settlement.issueCode.count", { minimum: 1, maximum: 10_000 }) };
    }).sort((left, right) => left.code.localeCompare(right.code)),
    counts: Object.fromEntries(Object.entries(value.counts).map(([key, item]) => [key, count(item, `settlement.counts.${key}`)])),
    failedStages: sortedUnique(value.failedStages.map((stage) => token(stage, STAGE_ID, "settlement.failedStage"))),
    host: normalizeHost(value.host),
  };
}

function normalizeDigestList(values, label) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 10_000) throw new Error(`${label}は1..10000件のarrayであること。`);
  const digests = sortedUnique(values.map((value) => sha(value, label)));
  if (digests.length !== values.length) throw new Error(`${label}が重複している。`);
  return digests;
}

function normalizeProposalList(values) {
  if (!Array.isArray(values) || values.length > 1000) throw new Error("proposalsは1000件以下のarrayであること。");
  const seen = new Set();
  return values.map((entry) => {
    strictKeys(entry, ["id", "kind", "target", "occurrences", "occurrenceDigests"], "proposal");
    const id = token(entry.id, PROPOSAL_ID, "proposal.id");
    if (seen.has(id)) throw new Error("proposal.idが重複している。");
    seen.add(id);
    if (!PROPOSAL_KINDS.has(entry.kind)) throw new Error("proposal.kindが不正。");
    const target = normalizeHarnessFeedbackTarget(entry.target);
    if (target !== entry.target || !SHARED_TARGET.test(target)) throw new Error("proposal.targetは共有層（platform / genre）の正規名であること。");
    const occurrenceDigests = normalizeDigestList(entry.occurrenceDigests, "proposal.occurrenceDigests");
    if (entry.occurrences !== occurrenceDigests.length) throw new Error("proposal.occurrencesは指紋の件数と一致すること。");
    return { id, kind: entry.kind, target, occurrences: entry.occurrences, occurrenceDigests };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

/** 文の field だけに掛ける、語彙に依らない形の検査（送信の直前・受け取る側でも同じ）。 */
function assertTransportableText(text, label) {
  const value = String(text ?? "");
  const length = [...value].length;
  if (length < TEXT_MIN || length > TEXT_MAX || value !== value.replace(/\s+/gu, " ").trim()) {
    throw new Error(`${label}は${TEXT_MIN}..${TEXT_MAX}文字の1行であること。`);
  }
  const reasons = scanFeedbackText(value, { homeRoot: "" });
  if (reasons.length > 0 || LONG_QUOTE.test(value) || CONTACT_ADDRESS.test(value) || URL_TEXT.test(value)) {
    throw new Error(`${label}に送れない形がある。`);
  }
  return value;
}

function normalizeCandidateList(values) {
  if (!Array.isArray(values) || values.length > 200) throw new Error("newCandidatesは200件以下のarrayであること。");
  const seen = new Set();
  return values.map((entry) => {
    strictKeys(entry, ["candidateId", "kind", "target", "generalizedText", "evidenceKinds", "occurrences", "occurrenceDigests"], "newCandidate");
    const candidateId = token(entry.candidateId, PROPOSAL_ID, "newCandidate.candidateId");
    if (seen.has(candidateId)) throw new Error("newCandidate.candidateIdが重複している。");
    seen.add(candidateId);
    if (!PROPOSAL_KINDS.has(entry.kind)) throw new Error("newCandidate.kindが不正。");
    const target = normalizeHarnessFeedbackTarget(entry.target);
    if (target !== entry.target || !SHARED_TARGET.test(target)) throw new Error("newCandidate.targetは共有層（platform / genre）の正規名であること。");
    if (!Array.isArray(entry.evidenceKinds) || entry.evidenceKinds.length === 0
      || entry.evidenceKinds.some((kind) => !FEEDBACK_EVIDENCE_KINDS.includes(kind))) {
      throw new Error("newCandidate.evidenceKindsが不正。");
    }
    const occurrenceDigests = normalizeDigestList(entry.occurrenceDigests, "newCandidate.occurrenceDigests");
    if (entry.occurrences !== occurrenceDigests.length) throw new Error("newCandidate.occurrencesは指紋の件数と一致すること。");
    return {
      candidateId,
      kind: entry.kind,
      target,
      generalizedText: assertTransportableText(entry.generalizedText, "newCandidate.generalizedText"),
      evidenceKinds: FEEDBACK_EVIDENCE_KINDS.filter((kind) => entry.evidenceKinds.includes(kind)),
      occurrences: entry.occurrences,
      occurrenceDigests,
    };
  }).sort((left, right) => left.candidateId.localeCompare(right.candidateId));
}

/**
 * payload（署名前）を検査して正規形にする。未許可 field・範囲外の値・文の形の違反は拒否。
 * 受け取る側も同じ関数で検査できるよう、語彙に依らない検査だけをここに置く。
 */
export function normalizeAutoFeedbackPayload(value, { registry = loadHarnessGateRegistry() } = {}) {
  strictKeys(value, ["version", "kind", "generatedAt", "trigger", "consent", "build", "settlement", "proposals", "newCandidates", "held", "privacy"], "payload");
  if (value.version !== HARNESS_FEEDBACK_AUTO_BUNDLE_VERSION) throw new Error("feedback payload versionが不正。");
  if (value.kind !== HARNESS_FEEDBACK_AUTO_BUNDLE_KIND) throw new Error("feedback payload kindが不正。");
  if (!FEEDBACK_TRIGGERS.includes(value.trigger)) throw new Error("feedback payload triggerが不正。");
  strictKeys(value.consent, ["scopes", "consentDigest"], "consent");
  if (!Array.isArray(value.consent.scopes) || value.consent.scopes.length === 0
    || value.consent.scopes.some((scope) => !FEEDBACK_CONSENT_SCOPES.includes(scope))) {
    throw new Error("consent.scopesが不正。");
  }
  const scopes = FEEDBACK_CONSENT_SCOPES.filter((scope) => value.consent.scopes.includes(scope));
  strictKeys(value.build, ["coreVersion", "harnessId", "harnessVersion", "declarationDigest"], "build");
  const harnessId = value.build.harnessId === null ? null : token(value.build.harnessId, HARNESS_ID, "build.harnessId");
  if (harnessId !== null && !registry.has(harnessId)) throw new Error("build.harnessIdが既知のHarnessではない。");
  const build = {
    coreVersion: value.build.coreVersion === "unknown" ? "unknown" : token(value.build.coreVersion, VERSION_TOKEN, "build.coreVersion"),
    harnessId,
    harnessVersion: token(value.build.harnessVersion, VERSION_TOKEN, "build.harnessVersion", { nullable: true }),
    declarationDigest: sha(value.build.declarationDigest, "build.declarationDigest", { nullable: true }),
  };
  if ((harnessId === null) !== (build.declarationDigest === null)) throw new Error("build.harnessIdとdeclarationDigestは揃って存在すること。");
  const settlement = normalizeSettlement(value.settlement, harnessId ? registry.get(harnessId)?.gateIds : null);
  if (settlement && harnessId === null) throw new Error("settlementにはbuild.harnessIdが要る。");
  const proposals = normalizeProposalList(value.proposals);
  const newCandidates = normalizeCandidateList(value.newCandidates);
  if (settlement && !scopes.includes("settlements")) throw new Error("同意の範囲に無い決着の要約を含めない。");
  if (proposals.length > 0 && !scopes.includes("proposals")) throw new Error("同意の範囲に無い提案の要約を含めない。");
  if (newCandidates.length > 0 && !scopes.includes("new-candidates")) throw new Error("同意の範囲に無い未知の提案を含めない。");
  if (!settlement && proposals.length === 0 && newCandidates.length === 0) throw new Error("送る内容が無いbundleは作らない。");
  strictKeys(value.held, ["proposals", "newCandidates"], "held");
  strictKeys(value.privacy, Object.keys(PRIVACY), "privacy");
  for (const [key, expected] of Object.entries(PRIVACY)) {
    if (value.privacy[key] !== expected) throw new Error("feedback bundleのprivacy宣言がfail-closedではない。");
  }
  const normalized = {
    version: HARNESS_FEEDBACK_AUTO_BUNDLE_VERSION,
    kind: HARNESS_FEEDBACK_AUTO_BUNDLE_KIND,
    generatedAt: isoTime(value.generatedAt, "generatedAt"),
    trigger: value.trigger,
    consent: { scopes, consentDigest: sha(value.consent.consentDigest, "consent.consentDigest") },
    build,
    settlement,
    proposals,
    newCandidates,
    held: {
      proposals: count(value.held.proposals, "held.proposals"),
      newCandidates: count(value.held.newCandidates, "held.newCandidates"),
    },
    privacy: { ...PRIVACY },
  };
  assertNoForbiddenKeys(normalized);
  return normalized;
}

/** 同意の記録の指紋。どの同意のもとで作った bundle かを、同意の中身を出さずに示す。 */
export function consentDigestOf(consent = {}) {
  return sha256(canonicalJson({
    enabled: consent.enabled === true,
    scopes: [...(consent.scopes || [])],
    decidedAt: String(consent.decidedAt || ""),
    via: String(consent.via || ""),
  }));
}

/**
 * bundle 全体（署名前の payload）を、公開面の検査と同じ語彙で照合する。
 * 1つでも当たれば throw（理由のコードだけ。当たった語は出さない）。
 */
export function assertFeedbackPayloadPrivacy(payload, context = {}) {
  if (context.available !== true || !context.vocabulary) {
    const error = new Error("検査語彙を照合できないので feedback bundle を作らない。");
    error.code = context.reason || "vocabulary-unavailable";
    throw error;
  }
  const reasons = scanFeedbackText(canonicalJson(payload), context);
  if (reasons.length > 0) {
    const error = new Error(`feedback bundle に送れない語・形がある: ${reasons.join(", ")}`);
    error.code = `bundle-${reasons[0]}`;
    error.reasons = reasons;
    throw error;
  }
  return true;
}

export function autoFeedbackBundleDigest(bundle) {
  return sha256(canonicalJson(bundle));
}

function signedBody(bundle) {
  const { signature: _signature, ...body } = bundle;
  return body;
}

export function signAutoFeedbackBundle({ payload, privateKeyPem, registry = undefined } = {}) {
  const normalized = normalizeAutoFeedbackPayload(payload, registry ? { registry } : {});
  const privateKey = createPrivateKey(String(privateKeyPem || ""));
  const keyId = publicKeyId(createPublicKey(privateKey));
  const body = { ...normalized, signer: { algorithm: "Ed25519", keyId } };
  const signature = cryptoSign(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64url");
  return { ...body, signature };
}

/** 送る直前・受け取ったときの形の検査（公開鍵は要らない）。 */
export function validateAutoFeedbackBundleForTransport(value, { registry = undefined } = {}) {
  strictKeys(value, ["version", "kind", "generatedAt", "trigger", "consent", "build", "settlement", "proposals", "newCandidates", "held", "privacy", "signer", "signature"], "bundle");
  strictKeys(value.signer, ["algorithm", "keyId"], "bundle.signer");
  if (value.signer.algorithm !== "Ed25519" || !KEY_ID.test(String(value.signer.keyId || ""))) throw new Error("signer情報が不正。");
  const { signer: _signer, signature, ...payload } = value;
  const normalized = normalizeAutoFeedbackPayload(payload, registry ? { registry } : {});
  if (canonicalJson(payload) !== canonicalJson(normalized)) throw new Error("feedback bundle payloadは正規形と完全一致すること。");
  const bytes = Buffer.from(nonEmpty(signature), "base64url");
  if (bytes.length !== 64 || bytes.toString("base64url") !== signature) throw new Error("feedback bundle署名の形式が不正。");
  if (Buffer.byteLength(canonicalJson(value)) > HARNESS_FEEDBACK_AUTO_MAX_BYTES) throw new Error("feedback bundleが大きすぎる。");
  return { ok: true, signerKeyId: value.signer.keyId, digest: autoFeedbackBundleDigest(value) };
}

export function verifyAutoFeedbackBundle({ bundle, trustedPublicKeyPem, registry = undefined } = {}) {
  const transport = validateAutoFeedbackBundleForTransport(bundle, { registry });
  const publicKey = createPublicKey(String(trustedPublicKeyPem || ""));
  if (publicKey.asymmetricKeyType !== "ed25519" || publicKeyId(publicKey) !== bundle.signer.keyId) {
    throw new Error("feedback signer key IDが信頼済み公開鍵と一致しない。");
  }
  if (!cryptoVerify(null, Buffer.from(canonicalJson(signedBody(bundle))), publicKey, Buffer.from(bundle.signature, "base64url"))) {
    throw new Error("feedback bundle署名が一致しない。");
  }
  return transport;
}

// ---- 提供元の受領証（送り先の本人確認） ----------------------------------------------------

export function normalizeProviderKeyFingerprint(value) {
  const text = nonEmpty(value).toLowerCase();
  if (!KEY_ID.test(text)) throw new Error("提供元の公開鍵の指紋は ed25519:<24桁hex> の形にしてください（publicKeyId と同じ形）。");
  return text;
}

const RECEIPT_KEYS = ["version", "ok", "duplicate", "status", "bundleDigest", "receivedAt", "ownerApprovalRequired", "provider", "signature"];

/**
 * 受け取る側の受領証に署名する（受け取る側の実装と、試験の偽サーバーが使う）。
 * 端末は、設定した指紋の鍵で署名された受領証を受け取ったときだけ「届いた」と記録する。
 */
export function signProviderIngestReceipt({ bundleDigest, duplicate = false, receivedAt = new Date().toISOString(), privateKeyPem } = {}) {
  const privateKey = createPrivateKey(String(privateKeyPem || ""));
  const publicKey = createPublicKey(privateKey);
  const body = {
    version: HARNESS_FEEDBACK_PROVIDER_RECEIPT_VERSION,
    ok: true,
    duplicate: duplicate === true,
    status: "verified-quarantine",
    bundleDigest: sha(bundleDigest, "bundleDigest"),
    receivedAt: isoTime(receivedAt, "receivedAt"),
    ownerApprovalRequired: true,
    provider: { keyId: publicKeyId(publicKey), publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() },
  };
  return { ...body, signature: cryptoSign(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64url") };
}

/** 受領証を検査する。指紋・署名・bundle の digest が1つでも合わなければ throw。 */
export function verifyProviderIngestReceipt({ receipt, bundleDigest, providerKeyFingerprint } = {}) {
  const expectedKey = normalizeProviderKeyFingerprint(providerKeyFingerprint);
  strictKeys(receipt, RECEIPT_KEYS, "receipt");
  strictKeys(receipt.provider, ["keyId", "publicKeyPem"], "receipt.provider");
  if (receipt.version !== HARNESS_FEEDBACK_PROVIDER_RECEIPT_VERSION || receipt.ok !== true
    || receipt.status !== "verified-quarantine" || receipt.ownerApprovalRequired !== true
    || typeof receipt.duplicate !== "boolean") {
    throw new Error("受領証の形が正式ではない。");
  }
  if (receipt.bundleDigest !== sha(bundleDigest, "bundleDigest")) throw new Error("受領証が送った bundle の digest に結び付いていない。");
  isoTime(receipt.receivedAt, "receipt.receivedAt");
  if (receipt.provider.keyId !== expectedKey) throw new Error("受領証の署名鍵が、設定した提供元の指紋と違う。");
  let publicKey;
  try { publicKey = createPublicKey(String(receipt.provider.publicKeyPem || "")); }
  catch { throw new Error("受領証の公開鍵が読めない。"); }
  if (publicKey.asymmetricKeyType !== "ed25519" || publicKeyId(publicKey) !== expectedKey) {
    throw new Error("受領証の公開鍵が、設定した提供元の指紋と一致しない。");
  }
  const { signature, ...body } = receipt;
  const bytes = Buffer.from(nonEmpty(signature), "base64url");
  if (bytes.length !== 64 || !cryptoVerify(null, Buffer.from(canonicalJson(body)), publicKey, bytes)) {
    throw new Error("受領証の署名が一致しない。");
  }
  return { duplicate: receipt.duplicate, receivedAt: receipt.receivedAt, providerKeyId: expectedKey };
}
