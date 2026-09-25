// 運営者の端末から提供元（BuzzAssist の開発側）へ学習を届ける流れの、端末側の全部。
//
//   同意 → Job の決着時に署名つき bundle を作って送信待ちに積む → 送り先が設定されていれば送る
//
// 守ること:
//
//   - **同意が無ければ何も作らず、何も送らない**。同意の記録が無い・壊れている・取り消された
//     ときは、置き場のディレクトリも作らない（学習の置き場の feedback/consent.json、
//     lib/harnessLearningState.mjs）。同意の範囲（決着の要約・提案の要約・未知の提案）に無い
//     ものは bundle に入れない
//   - **照合できない端末では作らない**。公開面の検査と同じ語彙で bundle を照合する
//     （lib/harnessFeedbackAutoBundle.mjs）。語彙か鍵が無ければ理由だけ残す
//   - **Job を止めない**。作れない・送れないときは理由を返し、events.jsonl に残すだけ
//   - **送り先が未設定なら貯めるだけ**。送り先は HTTPS の URL と提供元の公開鍵の指紋の組で、
//     受領証がその鍵で署名されていなければ「届いた」と記録しない
//   - **二重に送らない**。届いた bundle の sha256 と時刻を sent.jsonl に残し、同じ digest は
//     二度と送らない。受け取る側も digest で冪等（docs/harness-feedback-receiver-spec-ja.md）
//   - **再送は上限つき**。network / 408 / 425 / 429 / 5xx だけを指数バックオフで再送し、
//     それ以外の 4xx と信頼できない受領証は恒久失敗として止める
//
// 置き場（<学習の置き場>/feedback/）:
//   consent.json            同意（lib/harnessLearningState.mjs）
//   destination.json        送り先（URL と提供元の公開鍵の指紋）
//   keys/                   この端末の署名鍵（Ed25519。秘密鍵は 0600、公開鍵を提供元へ渡して登録してもらう）
//   outbox/<sha256>.json    送信待ち（署名済み bundle の正規 JSON）
//   journal/<sha256>.json   送信の試行の記録
//   sent/<sha256>.json      届いた bundle の控え
//   sent.jsonl              届いた bundle の sha256・時刻・受領証の要約（二重送信の防止）
//   reported.json           bundle に入れ済みの決着・提案の指紋（同じ出来事を二度数えさせない）
//   held-candidates.json    送らずに端末へ残した未知の提案（id と理由のコードだけ）
//   events.jsonl            作った・作らなかった・送った・送れなかった理由（本文とパスは残さない）

import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { readJsonIfExists, renameWithRetry, writeJsonAtomic } from "./atomicJsonFile.mjs";
import { withCanvasFileLock } from "./canvasFileLock.mjs";
import { canonicalJson, publicKeyId } from "./channelPackEnvelope.mjs";
import {
  HARNESS_FEEDBACK_AUTO_BUNDLE_KIND,
  HARNESS_FEEDBACK_AUTO_BUNDLE_VERSION,
  HARNESS_FEEDBACK_AUTO_ENDPOINT_PATH,
  assertFeedbackPayloadPrivacy,
  autoFeedbackBundleDigest,
  buildSettlementSummary,
  consentDigestOf,
  loadFeedbackPrivacyContext,
  loadHarnessGateRegistry,
  normalizeAutoFeedbackPayload,
  normalizeProviderKeyFingerprint,
  partitionProposalsForFeedback,
  signAutoFeedbackBundle,
  verifyAutoFeedbackBundle,
  verifyProviderIngestReceipt,
} from "./harnessFeedbackAutoBundle.mjs";
import {
  HARNESS_FEEDBACK_PUBLIC_CATALOG_RELATIVE_PATH,
  parseHarnessFeedbackProposalCatalog,
} from "./harnessFeedbackBundle.mjs";
import { normalizeFeedbackEndpoint, readBoundedResponse } from "./harnessFeedbackUploadClient.mjs";
import { buzzassistVersion } from "./harnessHostProvenance.mjs";
import { proposalOccurrenceDigest } from "./harnessLearningCurator.mjs";
import { learningWritesForbidden } from "./harnessLearningGuard.mjs";
import {
  FEEDBACK_CONSENT_SCOPES,
  appendJsonlRows,
  readFeedbackConsent,
  resolveLearningState,
  sharedLedgerPath,
  writeFeedbackConsent,
} from "./harnessLearningState.mjs";
import { proposalId } from "../scripts/harness-learn.mjs";

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const FEEDBACK_DESTINATION_VERSION = "buzzassist-feedback-destination-v1";
export const FEEDBACK_JOURNAL_VERSION = "buzzassist-feedback-outbox-journal-v1";
export const FEEDBACK_SENT_LOG_VERSION = "buzzassist-feedback-sent-v1";
export const FEEDBACK_REPORTED_VERSION = "buzzassist-feedback-reported-v1";
export const FEEDBACK_HELD_VERSION = "buzzassist-feedback-held-candidates-v1";
export const FEEDBACK_EVENTS_VERSION = "buzzassist-feedback-events-v1";
/** 配布物に同梱する既定の送り先（提供元が配備を決めたら置く。今は無い）。 */
export const RELEASE_DESTINATION_RELATIVE_PATH = "config/feedback-destination.json";
/** 送信待ちの上限。超えたら新しい bundle は作らず理由だけ残す（古いものを黙って捨てない）。 */
export const FEEDBACK_OUTBOX_MAX_BUNDLES = 500;
/** 1つの bundle の試行回数の上限（自動送信はこれを超えて試さない）。 */
export const FEEDBACK_MAX_TOTAL_ATTEMPTS = 12;

const SETTLED_STATUSES = new Set(["completed", "failed", "awaiting-human-review"]);
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const DIGEST_FILE = /^([a-f0-9]{64})\.json$/u;
const SERVER_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const MODES = {
  // Job の決着時。制作の結果を返すのを長く待たせない（全体で budgetMs まで。残りは次の決着か send で）。
  auto: { maxAttempts: 2, responseTimeoutMs: 10_000, maxBundles: 20, lockTimeoutMs: 2_000, budgetMs: 15_000 },
  // 運営者が send を打ったとき。
  manual: { maxAttempts: 4, responseTimeoutMs: 30_000, maxBundles: Number.POSITIVE_INFINITY, lockTimeoutMs: 30_000, budgetMs: Number.POSITIVE_INFINITY },
};

function reasonCode(error, fallback = "error") {
  const code = String(error?.code || "");
  return /^[A-Za-z][A-Za-z0-9_:-]{0,80}$/u.test(code) ? code : fallback;
}

/** 置き場のパス。Windows でも path.win32 を渡せば同じ規則で組み立てる。 */
export function feedbackOutboxPaths(state, pathApi = path) {
  const dir = state?.feedbackDir;
  if (!dir) throw new Error("学習の置き場に feedbackDir が無い。");
  return {
    dir,
    consent: pathApi.join(dir, "consent.json"),
    destination: pathApi.join(dir, "destination.json"),
    privateKey: pathApi.join(dir, "keys", "operator-feedback-ed25519.pem"),
    publicKey: pathApi.join(dir, "keys", "operator-feedback-ed25519.pub.pem"),
    outboxDir: pathApi.join(dir, "outbox"),
    sentDir: pathApi.join(dir, "sent"),
    journalDir: pathApi.join(dir, "journal"),
    sentLog: pathApi.join(dir, "sent.jsonl"),
    reported: pathApi.join(dir, "reported.json"),
    held: pathApi.join(dir, "held-candidates.json"),
    events: pathApi.join(dir, "events.jsonl"),
    queueLock: pathApi.join(dir, "queue"),
    sendLock: pathApi.join(dir, "send"),
  };
}

function readJsonlRows(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const rows = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) rows.push(parsed);
    } catch {
      // 壊れた行は数えない（読む側を止めない）。
    }
  }
  return rows;
}

function logEvent(paths, row) {
  try {
    appendJsonlRows(paths.events, [{ version: FEEDBACK_EVENTS_VERSION, ...row }]);
  } catch {
    // 記録できなくても Job と送信は止めない。
  }
  return row;
}

// ---- 署名鍵 -------------------------------------------------------------------------------

/** この端末の署名鍵を用意する（無ければ作る）。秘密鍵は印字しない。 */
export function ensureOperatorFeedbackKey(paths) {
  const existing = readOperatorFeedbackKey(paths);
  if (existing) return { created: false, keyId: existing.keyId, publicKeyPem: existing.publicKeyPem, publicKeyPath: paths.publicKey };
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  fs.mkdirSync(path.dirname(paths.privateKey), { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.privateKey, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  fs.writeFileSync(paths.publicKey, publicKeyPem, { mode: 0o644 });
  return { created: true, keyId: publicKeyId(publicKey), publicKeyPem, publicKeyPath: paths.publicKey };
}

export function readOperatorFeedbackKey(paths) {
  let privateKeyPem;
  try { privateKeyPem = fs.readFileSync(paths.privateKey, "utf8"); } catch { return null; }
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("feedback の署名鍵が Ed25519 ではない。");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  if (!fs.existsSync(paths.publicKey)) fs.writeFileSync(paths.publicKey, publicKeyPem, { mode: 0o644 });
  return { privateKeyPem, publicKeyPem, keyId: publicKeyId(publicKey) };
}

// ---- 同意 ---------------------------------------------------------------------------------

/**
 * 同意を記録する。同意するときは先に署名鍵を用意する（鍵が作れないのに同意だけ残すと、
 * 決着のたびに「鍵が無い」で止まる）。取り消しでは鍵を消さない（送信待ちは purge で消す）。
 */
export function recordFeedbackConsent({ state, enabled, scopes = [], via = "cli", interactive = false, now = new Date().toISOString() } = {}) {
  const paths = feedbackOutboxPaths(state);
  const signer = enabled ? ensureOperatorFeedbackKey(paths) : null;
  const consent = writeFeedbackConsent(state, { enabled, scopes, via, interactive, now });
  return { consent, signer: signer ? { keyId: signer.keyId, created: signer.created, publicKeyPath: signer.publicKeyPath } : null };
}

// ---- 送り先 -------------------------------------------------------------------------------

function normalizeDestination(value) {
  if (!value || typeof value !== "object" || value.version !== FEEDBACK_DESTINATION_VERSION) throw new Error("送り先の記録の形が違う。");
  return {
    endpoint: normalizeFeedbackEndpoint(value.endpoint, { endpointPath: HARNESS_FEEDBACK_AUTO_ENDPOINT_PATH }),
    providerKeyFingerprint: normalizeProviderKeyFingerprint(value.providerKeyFingerprint),
  };
}

/**
 * 送り先を読む。運営者が設定したもの（feedback/destination.json）を優先し、無ければ配布物に
 * 同梱された既定（config/feedback-destination.json、今は無い）。壊れていれば「未設定」扱い
 * （invalid: true）で送らない。
 */
export function readFeedbackDestination({ state, codeRoot = MODULE_ROOT } = {}) {
  const sources = [
    { file: feedbackOutboxPaths(state).destination, source: "operator" },
    { file: path.join(codeRoot, RELEASE_DESTINATION_RELATIVE_PATH), source: "release" },
  ];
  for (const { file, source } of sources) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    try {
      return { configured: true, source, ...normalizeDestination(JSON.parse(text)) };
    } catch {
      return { configured: false, invalid: true, source };
    }
  }
  return { configured: false };
}

export function writeFeedbackDestination({ state, endpoint, providerKeyFingerprint, now = new Date().toISOString() } = {}) {
  const record = {
    version: FEEDBACK_DESTINATION_VERSION,
    endpoint: normalizeFeedbackEndpoint(endpoint, { endpointPath: HARNESS_FEEDBACK_AUTO_ENDPOINT_PATH }),
    providerKeyFingerprint: normalizeProviderKeyFingerprint(providerKeyFingerprint),
    configuredAt: String(now),
  };
  const file = feedbackOutboxPaths(state).destination;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
  return record;
}

export function clearFeedbackDestination({ state } = {}) {
  const file = feedbackOutboxPaths(state).destination;
  const existed = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  return { cleared: existed };
}

// ---- 入れ済みの指紋 -------------------------------------------------------------------------

async function readReported(file) {
  const value = await readJsonIfExists(file, null);
  const settlements = new Set(Array.isArray(value?.settlements) ? value.settlements.filter((entry) => /^[a-f0-9]{64}$/u.test(entry)) : []);
  const proposals = new Map();
  for (const [id, digests] of Object.entries(value?.proposals || {})) {
    if (/^[a-f0-9]{12}$/u.test(id) && Array.isArray(digests)) proposals.set(id, new Set(digests.filter((entry) => /^[a-f0-9]{64}$/u.test(entry))));
  }
  return { settlements, proposals };
}

async function writeReported(file, reported) {
  await writeJsonAtomic(file, {
    version: FEEDBACK_REPORTED_VERSION,
    // 決着の指紋は新しい方から 5000 件だけ持つ（同じ決着が2回目に来るのは直後だけ）。
    settlements: [...reported.settlements].slice(-5000),
    proposals: Object.fromEntries([...reported.proposals].sort(([left], [right]) => left.localeCompare(right))
      .map(([id, digests]) => [id, [...digests].sort()])),
  });
}

async function outboxDigests(paths) {
  let names = [];
  try { names = await readdir(paths.outboxDir); } catch { return []; }
  return names.map((name) => DIGEST_FILE.exec(name)?.[1]).filter(Boolean).sort();
}

function sentIndex(paths) {
  return new Set(readJsonlRows(paths.sentLog).map((row) => row.bundleSha256).filter((digest) => /^[a-f0-9]{64}$/u.test(String(digest))));
}

function loadCatalog(codeRoot) {
  const file = path.join(codeRoot, HARNESS_FEEDBACK_PUBLIC_CATALOG_RELATIVE_PATH);
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return new Map(); }
  return parseHarnessFeedbackProposalCatalog(text);
}

// ---- 決着時に積む ----------------------------------------------------------------------------

/**
 * Job の決着時に呼ぶ（lib/harnessReceiptLearning.mjs の捕捉と自動 sync のあと）。
 * 同意があれば bundle を作って送信待ちに積み、送り先が設定されていれば送る。例外は投げない。
 */
export async function queueJobSettlementFeedback(options = {}) {
  const {
    job,
    env = process.env,
    now = () => new Date().toISOString(),
    trigger = "job-settled",
    codeRoot = MODULE_ROOT,
    homeDir = homedir(),
    state: stateOption = undefined,
    send = true,
    sendOptions = {},
  } = options;
  if (learningWritesForbidden(env)) return { status: "skipped", reason: "child-agent" };
  let state;
  try {
    state = stateOption ?? resolveLearningState({ codeRoot, env, homeDir });
  } catch {
    return { status: "failed", reason: "state-unresolved" };
  }
  const consent = readFeedbackConsent(state);
  // 同意が無ければ、置き場のディレクトリも作らない（記録も残さない）。
  if (!consent.enabled) {
    return { status: "skipped", reason: consent.recorded ? "consent-disabled" : consent.invalid ? "consent-invalid" : "no-consent" };
  }
  if (!job || !SETTLED_STATUSES.has(String(job.status || ""))) return { status: "skipped", reason: "not-settled" };
  const paths = feedbackOutboxPaths(state);
  const at = String(typeof now === "function" ? now() : now);
  let queued;
  try {
    queued = await withCanvasFileLock(paths.queueLock, () => queueLocked({ ...options, state, consent, paths, at, codeRoot, homeDir, env }), { timeoutMs: 10_000 });
  } catch (error) {
    queued = { status: "failed", reason: reasonCode(error, "queue-error") };
  }
  logEvent(paths, { at, trigger, action: "queue", ...queued });
  if (queued.status !== "queued" || send !== true) return queued;
  let sent;
  try {
    sent = await flushFeedbackOutbox({ state, codeRoot, env, now, mode: "auto", ...sendOptions });
  } catch (error) {
    sent = { status: "failed", reason: reasonCode(error, "send-error") };
  }
  return { ...queued, send: sent };
}

async function queueLocked({
  job,
  state,
  consent,
  paths,
  at,
  codeRoot,
  homeDir,
  env,
  trigger = "job-settled",
  locateReceipt = undefined,
  issueCodeOf = undefined,
  jobStateDigestOf = undefined,
  privacy: privacyOption = undefined,
  registry: registryOption = undefined,
  readLedgerRows = undefined,
}) {
  const keys = readOperatorFeedbackKey(paths);
  if (!keys) return { status: "skipped", reason: "signing-key-missing" };
  const privacy = privacyOption ?? loadFeedbackPrivacyContext({ codeRoot, operatorDir: path.dirname(state.feedbackDir), env, homeDir });
  if (privacy.available !== true) return { status: "skipped", reason: privacy.reason || "vocabulary-unavailable" };
  if ((await outboxDigests(paths)).length >= FEEDBACK_OUTBOX_MAX_BUNDLES) return { status: "skipped", reason: "outbox-full" };

  // Receipt の探し方・issue のコードの丸め方は、学習候補の自動捕捉と同じもの（lib/harnessReceiptLearning.mjs）。
  // そちらがこの module を呼ぶので、使う瞬間に読む（循環を静的 import に持ち込まない）。
  const learning = (locateReceipt && issueCodeOf && jobStateDigestOf) ? null : await import("./harnessReceiptLearning.mjs");
  const locate = locateReceipt ?? learning.locateJobRunReceipt;
  const codeOf = issueCodeOf ?? learning.issueCodeOf;
  const stateDigestOf = jobStateDigestOf ?? learning.jobStateDigest;
  const registry = registryOption ?? loadHarnessGateRegistry(codeRoot);
  const scopes = new Set(consent.scopes);
  const reported = await readReported(paths.reported);

  let located = null;
  try { located = await locate(job); } catch { located = null; }
  const sourceDigest = located?.digest ?? stateDigestOf(job);
  const summary = buildSettlementSummary({ job, located, sourceDigest, registry, issueCodeOf: codeOf, context: privacy });
  const settlement = scopes.has("settlements") && summary.settlement && !reported.settlements.has(sourceDigest)
    ? summary.settlement
    : null;

  let catalog;
  try { catalog = loadCatalog(codeRoot); } catch { return { status: "skipped", reason: "catalog-invalid" }; }
  const rows = readLedgerRows ? readLedgerRows(state) : readJsonlRows(sharedLedgerPath(state, "proposals"));
  const partition = partitionProposalsForFeedback({
    rows,
    catalog,
    reported: reported.proposals,
    occurrenceDigestOf: proposalOccurrenceDigest,
    proposalIdOf: proposalId,
    context: privacy,
  });
  const proposals = scopes.has("proposals") ? partition.known.slice(0, 1000) : [];
  const newCandidates = scopes.has("new-candidates") ? partition.candidates.slice(0, 200) : [];
  const held = {
    proposals: partition.held.filter((entry) => catalog.has(entry.id)).length,
    newCandidates: partition.held.filter((entry) => !catalog.has(entry.id)).length,
  };
  await writeJsonAtomic(paths.held, {
    version: FEEDBACK_HELD_VERSION,
    updatedAt: at,
    note: "送らずにこの端末へ残した提案。本文は harness-learn status で id から引く。",
    entries: partition.held.map(({ id, target, reasons, occurrences }) => ({ id, target, reasons, occurrences })),
  });
  if (!settlement && proposals.length === 0 && newCandidates.length === 0) {
    return { status: "skipped", reason: summary.settlement && reported.settlements.has(sourceDigest) ? "settlement-already-queued" : "nothing-new", held };
  }

  const harness = summary.harness;
  const payload = {
    version: HARNESS_FEEDBACK_AUTO_BUNDLE_VERSION,
    kind: HARNESS_FEEDBACK_AUTO_BUNDLE_KIND,
    generatedAt: at,
    trigger,
    consent: { scopes: [...consent.scopes], consentDigest: consentDigestOf(consent) },
    build: {
      coreVersion: buzzassistVersion({ root: codeRoot }),
      harnessId: harness?.harnessId ?? null,
      harnessVersion: harness?.harnessVersion ?? null,
      declarationDigest: harness?.declarationDigest ?? null,
    },
    settlement,
    proposals,
    newCandidates,
    held,
    privacy: {
      containsScriptText: false,
      containsPrompts: false,
      containsEvidenceText: false,
      containsSessionIds: false,
      containsPaths: false,
      containsPersonNames: false,
      containsChannelTerms: false,
      vocabularyChecked: true,
    },
  };
  let normalized;
  try {
    normalized = normalizeAutoFeedbackPayload(payload, { registry });
    assertFeedbackPayloadPrivacy(normalized, privacy);
  } catch (error) {
    return { status: "skipped", reason: reasonCode(error, "bundle-invalid"), held };
  }
  const bundle = signAutoFeedbackBundle({ payload: normalized, privateKeyPem: keys.privateKeyPem, registry });
  const digest = autoFeedbackBundleDigest(bundle);
  const file = path.join(paths.outboxDir, `${digest}.json`);
  if (!fs.existsSync(file) && !sentIndex(paths).has(digest)) {
    fs.mkdirSync(paths.outboxDir, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${canonicalJson(bundle)}\n`, "utf8");
    await renameWithRetry(temporary, file);
    await writeJsonAtomic(path.join(paths.journalDir, `${digest}.json`), {
      version: FEEDBACK_JOURNAL_VERSION, bundleSha256: digest, status: "pending", createdAt: at, attempts: [],
    });
  }
  if (settlement) reported.settlements.add(sourceDigest);
  for (const entry of [...proposals, ...newCandidates]) {
    const id = entry.id ?? entry.candidateId;
    if (!reported.proposals.has(id)) reported.proposals.set(id, new Set());
    for (const digestOf of entry.occurrenceDigests) reported.proposals.get(id).add(digestOf);
  }
  await writeReported(paths.reported, reported);
  return {
    status: "queued",
    bundleSha256: digest,
    sections: { settlement: Boolean(settlement), proposals: proposals.length, newCandidates: newCandidates.length },
    held,
  };
}

// ---- 送る -----------------------------------------------------------------------------------

async function postOnce({ endpoint, bytes, digest, fetchImpl, responseTimeoutMs, providerKeyFingerprint }) {
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-buzzassist-feedback-bundle-sha256": digest,
      },
      body: bytes,
      redirect: "error",
      signal: AbortSignal.timeout(responseTimeoutMs),
    });
  } catch {
    return { kind: "retryable", httpStatus: null, code: "network-error" };
  }
  const httpStatus = Number(response.status) || null;
  let body = null;
  try {
    body = await readBoundedResponse(response, { timeoutMs: responseTimeoutMs });
  } catch {
    // 受理されたのに本文が読めなかった可能性がある。受け取る側は digest で冪等なので、再送してよい。
    return { kind: RETRYABLE_STATUS.has(httpStatus) || [200, 202].includes(httpStatus) ? "retryable" : "permanent", httpStatus, code: "response-unreadable" };
  }
  if ([200, 202].includes(httpStatus)) {
    try {
      const receipt = verifyProviderIngestReceipt({ receipt: body, bundleDigest: digest, providerKeyFingerprint });
      return { kind: "delivered", httpStatus, receipt };
    } catch {
      // 設定した提供元の鍵で署名された受領証でなければ、届いたとは記録しない。
      return { kind: "permanent", httpStatus, code: "receipt-untrusted" };
    }
  }
  if (RETRYABLE_STATUS.has(httpStatus)) return { kind: "retryable", httpStatus, code: `http-${httpStatus}` };
  return { kind: "permanent", httpStatus, code: SERVER_CODE.test(String(body?.code || "")) ? body.code : `http-${httpStatus}` };
}

async function moveToSent(paths, digest) {
  const from = path.join(paths.outboxDir, `${digest}.json`);
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(paths.sentDir, { recursive: true });
  await renameWithRetry(from, path.join(paths.sentDir, `${digest}.json`));
}

async function sendOne({ digest, paths, keys, consent, destination, mode, settings, fetchImpl, now, sleep, maxTotalAttempts, baseDelayMs, maxDelayMs, sent, deadline, clock }) {
  const journalPath = path.join(paths.journalDir, `${digest}.json`);
  if (sent.has(digest)) {
    // 届いた記録がある bundle は二度と送らない。控えへ移し忘れていれば移す。
    await moveToSent(paths, digest);
    return { bundleSha256: digest, status: "already-sent" };
  }
  const journal = (await readJsonIfExists(journalPath, null)) ?? {
    version: FEEDBACK_JOURNAL_VERSION, bundleSha256: digest, status: "pending", createdAt: String(now()), attempts: [],
  };
  if (!Array.isArray(journal.attempts)) journal.attempts = [];
  if (mode === "auto" && ["permanent-failure", "exhausted"].includes(journal.status)) {
    return { bundleSha256: digest, status: journal.status, skipped: true };
  }
  let bytes;
  let bundle;
  try {
    bytes = await readFile(path.join(paths.outboxDir, `${digest}.json`));
    bundle = JSON.parse(bytes.toString("utf8"));
    verifyAutoFeedbackBundle({ bundle, trustedPublicKeyPem: keys.publicKeyPem });
    if (autoFeedbackBundleDigest(bundle) !== digest) throw new Error("digest mismatch");
  } catch {
    // 積んだあとに書き換わった・この端末の鍵で署名されていない bundle は送らない。
    journal.status = "permanent-failure";
    journal.lastCode = "bundle-invalid";
    journal.updatedAt = String(now());
    await writeJsonAtomic(journalPath, journal);
    return { bundleSha256: digest, status: "permanent-failure", code: "bundle-invalid" };
  }
  // 同意の範囲を狭めたら、今の範囲に無い中身を持つ bundle は送らない（消すかどうかは運営者が purge で決める）。
  const carried = [
    ...(bundle.settlement ? ["settlements"] : []),
    ...(bundle.proposals.length > 0 ? ["proposals"] : []),
    ...(bundle.newCandidates.length > 0 ? ["new-candidates"] : []),
  ];
  if (!carried.every((scope) => consent.scopes.includes(scope))) {
    return { bundleSha256: digest, status: "held", code: "consent-narrowed" };
  }
  for (let attempt = 0; attempt < settings.maxAttempts; attempt += 1) {
    if (mode === "auto" && journal.attempts.length >= maxTotalAttempts) break;
    const remaining = deadline - clock();
    if (remaining <= 0) break;
    const startedAt = String(now());
    const outcome = await postOnce({
      endpoint: destination.endpoint,
      bytes,
      digest,
      fetchImpl,
      responseTimeoutMs: Math.max(1, Math.min(settings.responseTimeoutMs, remaining)),
      providerKeyFingerprint: destination.providerKeyFingerprint,
    });
    journal.attempts.push({
      number: journal.attempts.length + 1,
      startedAt,
      finishedAt: String(now()),
      httpStatus: outcome.httpStatus,
      result: outcome.kind,
      ...(outcome.code ? { code: outcome.code } : {}),
    });
    journal.updatedAt = String(now());
    if (outcome.kind === "delivered") {
      const sentAt = String(now());
      appendJsonlRows(paths.sentLog, [{
        version: FEEDBACK_SENT_LOG_VERSION,
        bundleSha256: digest,
        sentAt,
        endpoint: destination.endpoint,
        providerKeyId: outcome.receipt.providerKeyId,
        duplicate: outcome.receipt.duplicate,
        receivedAt: outcome.receipt.receivedAt,
      }]);
      sent.add(digest);
      journal.status = "delivered";
      journal.deliveredAt = sentAt;
      journal.receipt = outcome.receipt;
      delete journal.lastCode;
      await writeJsonAtomic(journalPath, journal);
      await moveToSent(paths, digest);
      return { bundleSha256: digest, status: "delivered", duplicate: outcome.receipt.duplicate, attempts: journal.attempts.length };
    }
    journal.lastCode = outcome.code;
    if (outcome.kind === "permanent") {
      journal.status = "permanent-failure";
      await writeJsonAtomic(journalPath, journal);
      return { bundleSha256: digest, status: "permanent-failure", code: outcome.code, attempts: journal.attempts.length };
    }
    journal.status = journal.attempts.length >= maxTotalAttempts ? "exhausted" : "retry-pending";
    await writeJsonAtomic(journalPath, journal);
    if (journal.status === "exhausted" && mode === "auto") break;
    const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
    if (attempt < settings.maxAttempts - 1 && clock() + delay < deadline) await sleep(delay);
  }
  return { bundleSha256: digest, status: journal.status, code: journal.lastCode, attempts: journal.attempts.length };
}

/**
 * 送信待ちを送る。自動（決着時）は短く、手動（send）は恒久失敗・上限到達のものも1回ずつ試し直す。
 * 同意が無い・送り先が未設定なら送らない（送信待ちは残す）。
 */
export async function flushFeedbackOutbox({
  state,
  codeRoot = MODULE_ROOT,
  env = process.env,
  mode = "manual",
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
  maxAttempts = undefined,
  maxTotalAttempts = FEEDBACK_MAX_TOTAL_ATTEMPTS,
  baseDelayMs = 250,
  maxDelayMs = 4_000,
  responseTimeoutMs = undefined,
  maxBundles = undefined,
  lockTimeoutMs = undefined,
  budgetMs = undefined,
  clock = Date.now,
  destination: destinationOverride = undefined,
} = {}) {
  if (!MODES[mode]) throw new Error(`mode は ${Object.keys(MODES).join(" / ")}`);
  if (learningWritesForbidden(env)) return { status: "skipped", reason: "child-agent" };
  const settings = {
    maxAttempts: maxAttempts ?? MODES[mode].maxAttempts,
    responseTimeoutMs: responseTimeoutMs ?? MODES[mode].responseTimeoutMs,
    maxBundles: maxBundles ?? MODES[mode].maxBundles,
    lockTimeoutMs: lockTimeoutMs ?? MODES[mode].lockTimeoutMs,
    budgetMs: budgetMs ?? MODES[mode].budgetMs,
  };
  if (!Number.isSafeInteger(settings.maxAttempts) || settings.maxAttempts < 1 || settings.maxAttempts > 10) throw new Error("maxAttempts は 1..10");
  const consent = readFeedbackConsent(state);
  if (!consent.enabled) return { status: "skipped", reason: consent.recorded ? "consent-disabled" : "no-consent" };
  const paths = feedbackOutboxPaths(state);
  const pending = await outboxDigests(paths);
  const destination = destinationOverride ?? readFeedbackDestination({ state, codeRoot });
  if (!destination.configured) {
    return { status: "skipped", reason: destination.invalid ? "destination-invalid" : "destination-unset", pending: pending.length };
  }
  if (typeof fetchImpl !== "function") return { status: "skipped", reason: "fetch-unavailable", pending: pending.length };
  const keys = readOperatorFeedbackKey(paths);
  if (!keys) return { status: "skipped", reason: "signing-key-missing", pending: pending.length };
  const at = String(now());
  let result;
  try {
    result = await withCanvasFileLock(paths.sendLock, async () => {
      const sent = sentIndex(paths);
      const deadline = clock() + settings.budgetMs;
      const results = [];
      for (const digest of (await outboxDigests(paths)).slice(0, settings.maxBundles)) {
        if (clock() >= deadline) break;
        results.push(await sendOne({
          digest, paths, keys, consent, destination, mode, settings, fetchImpl, now, sleep, maxTotalAttempts, baseDelayMs, maxDelayMs, sent, deadline, clock,
        }));
      }
      const countOf = (status) => results.filter((entry) => entry.status === status).length;
      return {
        status: "flushed",
        mode,
        attempted: results.filter((entry) => !entry.skipped && entry.status !== "already-sent" && entry.status !== "held").length,
        delivered: countOf("delivered"),
        alreadySent: countOf("already-sent"),
        retryPending: countOf("retry-pending"),
        permanentFailure: countOf("permanent-failure"),
        exhausted: countOf("exhausted"),
        held: countOf("held"),
        remaining: (await outboxDigests(paths)).length,
        results,
      };
    }, { timeoutMs: settings.lockTimeoutMs });
  } catch (error) {
    if (/Timed out waiting/u.test(String(error?.message || ""))) return { status: "skipped", reason: "send-busy", pending: pending.length };
    throw error;
  }
  const { results: _results, ...summary } = result;
  logEvent(paths, { at, action: "send", ...summary });
  return result;
}

// ---- 一覧と削除 --------------------------------------------------------------------------------

/** 同意・送り先・署名鍵・照合の可否・送信待ち・届いた件数・端末に残した提案の一覧。 */
export async function listFeedbackOutbox({ state, codeRoot = MODULE_ROOT, env = process.env, homeDir = homedir(), privacy = undefined } = {}) {
  const paths = feedbackOutboxPaths(state);
  const consent = readFeedbackConsent(state);
  const destination = readFeedbackDestination({ state, codeRoot });
  let signer = null;
  try { signer = readOperatorFeedbackKey(paths); } catch { signer = { invalid: true }; }
  const vocabulary = privacy ?? loadFeedbackPrivacyContext({ codeRoot, operatorDir: path.dirname(state.feedbackDir), env, homeDir });
  const pending = [];
  for (const digest of await outboxDigests(paths)) {
    const journal = await readJsonIfExists(path.join(paths.journalDir, `${digest}.json`), null).catch(() => null);
    let bundle = null;
    try { bundle = JSON.parse(await readFile(path.join(paths.outboxDir, `${digest}.json`), "utf8")); } catch { bundle = null; }
    pending.push({
      bundleSha256: digest,
      generatedAt: bundle?.generatedAt ?? null,
      harnessId: bundle?.build?.harnessId ?? null,
      sections: {
        settlement: Boolean(bundle?.settlement),
        proposals: Array.isArray(bundle?.proposals) ? bundle.proposals.length : 0,
        newCandidates: Array.isArray(bundle?.newCandidates) ? bundle.newCandidates.length : 0,
      },
      status: journal?.status ?? "pending",
      attempts: Array.isArray(journal?.attempts) ? journal.attempts.length : 0,
      lastCode: journal?.lastCode ?? null,
    });
  }
  const sentRows = readJsonlRows(paths.sentLog);
  const held = await readJsonIfExists(paths.held, null).catch(() => null);
  const byReason = {};
  for (const entry of held?.entries || []) for (const reason of entry.reasons || []) byReason[reason] = (byReason[reason] || 0) + 1;
  return {
    consent: { recorded: consent.recorded, enabled: consent.enabled, scopes: consent.scopes, decidedAt: consent.decidedAt, via: consent.via, ...(consent.invalid ? { invalid: true } : {}) },
    destination: destination.configured
      ? { configured: true, source: destination.source, endpoint: destination.endpoint, providerKeyFingerprint: destination.providerKeyFingerprint }
      : { configured: false, ...(destination.invalid ? { invalid: true, source: destination.source } : {}) },
    signer: signer?.keyId ? { keyId: signer.keyId, publicKeyPath: paths.publicKey } : signer,
    vocabulary: { available: vocabulary.available === true, reason: vocabulary.reason ?? null, source: vocabulary.vocabularySource ?? null },
    pending,
    sent: { count: sentRows.length, lastSentAt: sentRows.at(-1)?.sentAt ?? null },
    held: { count: (held?.entries || []).length, byReason },
    recentEvents: readJsonlRows(paths.events).slice(-10),
  };
}

/**
 * 貯めたものを消す。既定は何も消さずに消える件数だけを返す（confirm: true で消す）。
 * 消すのは送信待ちの bundle と試行の記録（includeSent なら届いた bundle の控えも）。
 * sent.jsonl（届いた digest の記録）と reported.json は残す——消すと同じものを二重に送れてしまう。
 */
export async function purgeFeedbackOutbox({ state, includeSent = false, confirm = false, now = () => new Date().toISOString() } = {}) {
  const paths = feedbackOutboxPaths(state);
  const pending = await outboxDigests(paths);
  let sentCopies = [];
  if (includeSent) {
    try { sentCopies = (await readdir(paths.sentDir)).filter((name) => DIGEST_FILE.test(name)); } catch { sentCopies = []; }
  }
  if (!confirm) return { dryRun: true, wouldRemove: { outbox: pending.length, sentCopies: sentCopies.length } };
  const removed = await withCanvasFileLock(paths.sendLock, () => withCanvasFileLock(paths.queueLock, async () => {
    const digests = await outboxDigests(paths);
    for (const digest of digests) {
      await rm(path.join(paths.outboxDir, `${digest}.json`), { force: true });
      await rm(path.join(paths.journalDir, `${digest}.json`), { force: true });
    }
    for (const name of sentCopies) await rm(path.join(paths.sentDir, name), { force: true });
    return { outbox: digests.length, sentCopies: sentCopies.length };
  }));
  logEvent(paths, { at: String(now()), action: "purge", ...removed });
  return { dryRun: false, removed };
}

// ---- setup の質問 ---------------------------------------------------------------------------

function answeredYes(value) {
  return /^(?:y|yes|はい|うん)$/iu.test(String(value || "").trim());
}

/**
 * setup で同意を聞く。対話の端末で、まだ記録が無いときだけ聞く。対話でなければ聞かずに
 * 「未同意」のまま（記録も作らない）。断ったら「送らない」を記録し、次の setup では聞かない。
 */
export async function promptFeedbackConsent({
  state,
  input = process.stdin,
  output = process.stdout,
  interactive = Boolean(input?.isTTY && output?.isTTY),
  now = () => new Date().toISOString(),
} = {}) {
  const current = readFeedbackConsent(state);
  if (current.recorded) return { asked: false, status: current.enabled ? "enabled" : "disabled", scopes: current.scopes };
  if (!interactive) return { asked: false, status: "unset", reason: "non-interactive" };
  const rl = readline.createInterface({ input, output });
  try {
    output.write([
      "",
      "BuzzAssist の提供元へ、運営で分かった改善の材料を送れます（既定は送りません）。",
      "送るのはゲートの合否の件数・ハーネスの版・動かしたホスト・提案の ID だけで、",
      "台本・プロンプト・パス・人名・チャンネル固有の語は含みません。あとから",
      "node scripts/harness-feedback.mjs consent --disable で取り消せます。",
      "",
    ].join("\n"));
    const first = await rl.question("改善の材料を提供元へ送りますか？ [y/N] ");
    if (!answeredYes(first)) {
      recordFeedbackConsent({ state, enabled: false, via: "setup", interactive: true, now: String(now()) });
      return { asked: true, status: "disabled", scopes: [] };
    }
    const second = await rl.question("提供元がまだ知らない改善候補（チャンネル固有の語を含まないと確かめた一般化した文）も送りますか？ [y/N] ");
    const scopes = answeredYes(second) ? [...FEEDBACK_CONSENT_SCOPES] : ["settlements", "proposals"];
    const { consent, signer } = recordFeedbackConsent({ state, enabled: true, scopes, via: "setup", interactive: true, now: String(now()) });
    return { asked: true, status: "enabled", scopes: consent.scopes, signerKeyId: signer?.keyId ?? null };
  } finally {
    rl.close();
  }
}
