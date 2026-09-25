// Job が決着したとき（completed / failed / awaiting-human-review）、RunReceipt から
// 学習候補を機械的に取り出して提案台帳へ追記する。
//
// これまで自己改善は「エージェントが思い出したときに capture する」だけだった。
// 何度も落ちているゲートは RunReceipt に数字で残っているのに、それが提案台帳へ
// 届く道が無く、人が rollup を見に行かない限り次の改善の材料にならなかった。
//
// ここで守ること:
//
//   - **書くのは提案台帳への追記と、Receipt の索引の1行だけ**。正本（SKILL.md・台帳）と
//     overlay には一切触らない。捕捉は何も書き換えない、という自己改善の大原則のまま。
//     索引（学習の状態の置き場の receipts/index.jsonl）は rollup の読み先で、Job の id・
//     ハーネス・状態・動かしたホスト・RunReceipt の path と sha256・決着時刻だけを持つ
//   - **本文にはゲート id・issue コード・件数だけ**。台本・プロンプト・生のエラー全文・
//     パス・人名は入れない。issue の自由文からはコードの形をした先頭語だけを拾い、
//     形の合わないものは "unclassified" に丸める
//   - **冪等**。同じ Receipt からは二重に積まない。session に Receipt の digest を使い、
//     台帳の (提案ID, session) 重複検査に乗せる
//   - **宛先は Channel Pack 優先**。Canvas feedback と同じ既定（lib/harnessLearningTargets.mjs）で、
//     まず運営者専用の非公開台帳へ置く。genre / platform への一般化は人が決める
//   - **チャンネルで作った Job はチャンネルの保存先へ**。Job の metadata.channel（start が台帳のチャンネル——明示の
//     id か、Pack・作業フォルダが一致したチャンネル——で作ったときに残す）があれば、そのチャンネルの保存先
//     （lib/channelRegistry.mjs が決める。同じハーネスの別のチャンネルとは別の場所）へ積む。保存先を決められなければ
//     積まずに理由を返す（チャンネルの無い保存先へ落とさない）。metadata.channel の無い Job は従来どおり
//   - **提案ゼロを正常とする**。全部通った Run からは何も積まない。毎回何かを書かせる
//     圧はかけない（書く量が増えるだけで、落ちるところは落ち続ける）
//   - **Job を止めない**。捕捉に失敗しても理由を返すだけで、制作の結果には影響させない
//
// 捕捉のあと、overlay の sync（harness-learn sync と同じ本体）を自動で走らせる。書き換えるのは
// 機械が所有する overlay（learned-auto.md）だけで、正本には触らない。検査語彙を照合できない端末では
// 今どおり書かず、理由だけを学習の置き場の auto-sync.jsonl に残す（Job は止めない）。
// BUZZASSIST_LEARNING_AUTO_SYNC=0 で止まる。

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { autoSyncLearningOverlays, captureLearningProposal } from "../scripts/harness-learn.mjs";
import { jobChannelId, learningCaptureFailureReason } from "./learningChannelResolver.mjs";
import { learningWritesForbidden } from "./harnessLearningGuard.mjs";
import { invocationHostSummary } from "./harnessHostProvenance.mjs";
import { appendReceiptIndexRow, resolveLearningState } from "./harnessLearningState.mjs";
import { HARNESS_LEARNING_ROUTES } from "./harnessLearningTargets.mjs";

export const AUTO_RECEIPT_CREATOR = "auto-receipt";
export const AUTO_RECEIPT_LEARNING_VERSION = "buzzassist-auto-receipt-learning-v1";
export const AUTO_RECEIPT_EVIDENCE_TAG = "auto-receipt-v1";
/** 自動捕捉を止める環境変数（"0" で止める）。既定は有効。 */
export const AUTO_RECEIPT_CAPTURE_ENV = "BUZZASSIST_LEARNING_AUTO_CAPTURE";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SETTLED_STATUSES = new Set(["completed", "failed", "awaiting-human-review"]);
const RECEIPT_VERSION = "harness-run-receipt-v1";
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
const HARNESS_ID = /^[a-z0-9][a-z0-9-]{0,80}$/u;
// issue の先頭語として受け付ける形。Job 層の blocker コード（receiptFailureBlockers と同じ
// kebab-case）と、ハーネス宣言にある監査 id（camelCase を含む）だけを通す。
const ISSUE_CODE_PREFIX = /^([A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*)\s*(?::|$)/u;
const KEBAB_CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/u;
const STAGE_ID = /^[a-z][a-z0-9-]{0,40}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;

// Job を作ったチャンネルの決め方は品質ループの捕捉と同じもの（lib/learningChannelResolver.mjs）を使う。
export { jobChannelId };

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

/** ハーネス宣言を読む。id の形が合わなければ読まない（パスを組み立てるため）。 */
export function loadHarnessDeclaration(harnessId, { repoRoot = REPO_ROOT } = {}) {
  if (!HARNESS_ID.test(String(harnessId || ""))) return null;
  const file = join(repoRoot, "config", "harnesses", `${harnessId}.harness.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 宣言にある保証 id と監査 id。issue コードとして本文に書いてよい語はここから来る。 */
function declaredVocabulary(declaration, receipt) {
  const gateIds = new Set(receipt?.harnessBuild?.declaredGates || []);
  const auditToGate = new Map();
  for (const guarantee of declaration?.guarantees || []) {
    if (!guarantee?.id) continue;
    gateIds.add(String(guarantee.id));
    for (const auditId of guarantee.evidenceAuditIds || []) auditToGate.set(String(auditId), String(guarantee.id));
  }
  return { gateIds, auditToGate };
}

/**
 * knownRemainingIssues / blockers の1件を、本文に書いてよいコードへ丸める。
 * 先頭語が宣言にある id か、kebab-case のコードならそれを使い、それ以外は
 * "unclassified"。自由文（エラー全文・パス・人名）は本文へ運ばない。
 */
export function issueCodeOf(value, vocabulary = { gateIds: new Set(), auditToGate: new Map() }) {
  const text = String(value ?? "").trim();
  const code = text.match(ISSUE_CODE_PREFIX)?.[1] ?? "";
  if (!code || code.length > 64) return "unclassified";
  if (vocabulary.gateIds.has(code) || vocabulary.auditToGate.has(code)) return code;
  return KEBAB_CODE.test(code) ? code : "unclassified";
}

function countCodes(values, vocabulary) {
  const counts = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const code = issueCodeOf(value, vocabulary);
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return counts;
}

function mergeCounts(...maps) {
  const out = new Map();
  for (const map of maps) for (const [key, count] of map) out.set(key, Math.max(out.get(key) || 0, count));
  return out;
}

/**
 * 1回の決着から、提案候補（本文はゲート id・コード・件数だけ）を作る。純関数。
 *
 * @param receipt finalize 済みの RunReceipt（無ければ null。Job の状態だけで作る）
 * @param job     durable Video Harness Job（無ければ null）
 */
export function receiptLearningCandidates({
  receipt = null,
  receiptDigest,
  receiptSource,
  job = null,
  declaration = undefined,
} = {}) {
  if (!SHA256_HEX.test(String(receiptDigest || ""))) throw new Error("receiptDigest は sha256 にしてください。");
  const harnessId = String(receipt?.harnessBuild?.harness?.id || job?.harness?.id || "");
  if (!HARNESS_ID.test(harnessId)) return { harnessId: "", candidates: [], skippedReason: "unknown-harness" };
  const harnessVersion = String(receipt?.harnessBuild?.harness?.version || job?.harness?.declarationVersion || "");
  const decl = declaration === undefined ? loadHarnessDeclaration(harnessId) : declaration;
  const vocabulary = declaredVocabulary(decl, receipt);
  const outcome = String(receipt?.outcome || job?.status || "unknown");

  const skillShaAtCapture = {};
  for (const [name, skill] of Object.entries(receipt?.harnessBuild?.genreSkills || {})) {
    if (SHA256_HEX.test(String(skill?.tree || ""))) skillShaAtCapture[name] = skill.tree;
  }
  if (Object.keys(skillShaAtCapture).length === 0) {
    for (const skill of job?.harness?.canonicalSkills || []) {
      const name = String(skill?.id || "");
      if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(name) && SHA256_HEX.test(String(skill?.sha256 || ""))) {
        skillShaAtCapture[name] = skill.sha256;
      }
    }
  }

  const candidates = [];
  const add = (text, count, gateIds) => {
    candidates.push({ text, count: Math.max(1, count), gateIds: [...new Set(gateIds.filter(Boolean))].sort() });
  };

  if (receipt) {
    const gates = receipt.gates || {};
    const failed = Array.isArray(receipt.summary?.failedGates)
      ? receipt.summary.failedGates
      : Object.entries(gates).filter(([, gate]) => gate?.verdict === "fail").map(([id]) => id);
    const skipped = Array.isArray(receipt.summary?.skippedGates) ? receipt.summary.skippedGates : [];
    for (const gateId of [...new Set(failed.map(String))].filter((id) => vocabulary.gateIds.has(id)).sort()) {
      add(`[自動捕捉] ${harnessId} のゲート ${gateId} が不合格のまま Run が確定した。繰り返すなら、このゲートを落とす工程の規則を正本へ足す候補。`, 1, [gateId]);
    }
    for (const gateId of [...new Set(skipped.map(String))].filter((id) => vocabulary.gateIds.has(id)).sort()) {
      add(`[自動捕捉] ${harnessId} のゲート ${gateId} が測られないまま（skip）Run が確定した。測れない理由を工程側で解消する候補。`, 1, [gateId]);
    }
    if (receipt.outcomeOverridden === true) {
      add(`[自動捕捉] ${harnessId} で pass と申告された Run が、実測で fail に直された。申告と実測がずれる工程を探す候補。`, 1, []);
    }
    const retries = (receipt.mediaJobs || []).reduce((sum, mediaJob) => sum + safeCount(mediaJob?.attempts?.retryCount), 0);
    if (retries > 0) add(`[自動捕捉] ${harnessId} で有料 Media Job の再送が発生した。`, retries, []);
    const incomplete = safeCount(receipt.summary?.incompleteMediaJobCount);
    if (incomplete > 0) add(`[自動捕捉] ${harnessId} で未完了の有料 Media Job を残したまま Run が確定した。`, incomplete, []);
    const imageRetries = safeCount(receipt.imageRetry?.attempts);
    if (imageRetries > 0) add(`[自動捕捉] ${harnessId} で失敗した画像の作り直し（指紋迂回）が発生した。`, imageRetries, []);
  }

  // knownRemainingIssues と blockers はコードだけを数える。Receipt と Job の両方にある
  // 同じ issue は二重に数えない（大きい方の件数を採る）。
  const issueCounts = mergeCounts(
    countCodes(receipt?.knownRemainingIssues, vocabulary),
    countCodes(job?.knownRemainingIssues, vocabulary),
    countCodes(job?.blockers, vocabulary),
  );
  for (const [code, count] of [...issueCounts].sort(([left], [right]) => left.localeCompare(right))) {
    const gate = vocabulary.auditToGate.get(code) || (vocabulary.gateIds.has(code) ? code : "");
    add(`[自動捕捉] ${harnessId} の Run に knownRemainingIssues / blocker「${code}」が残った。`, count, [code === "unclassified" ? "" : code, gate]);
  }

  const resume = receipt?.resumeFromFailed || job?.resumeFromFailed || null;
  const resumeAttempts = safeCount(resume?.attempts);
  if (resumeAttempts > 0) {
    const stage = String(resume?.previousFailure?.failedStage || "");
    const stageLabel = STAGE_ID.test(stage) ? stage : "unclassified";
    add(`[自動捕捉] ${harnessId} の Job が failed から再開された（落ちた工程: ${stageLabel}）。同じ工程で繰り返すなら、その前提確認を doctor へ足す候補。`, resumeAttempts, []);
  }
  const pendingReceiptAttempts = safeCount(job?.pendingReceiptFinalization?.attempts);
  if (pendingReceiptAttempts > 0) {
    add(`[自動捕捉] ${harnessId} で生成後に RunReceipt を確定できず、確定待ちで止まった。`, pendingReceiptAttempts, []);
  }
  if (!receipt && job?.status === "failed") {
    const failedStages = (job.stages || [])
      .filter((stage) => stage?.status === "failed" && STAGE_ID.test(String(stage?.id || "")))
      .map((stage) => stage.id);
    for (const stage of [...new Set(failedStages)].sort()) {
      add(`[自動捕捉] ${harnessId} の Job が工程 ${stage} で failed になった。`, 1, []);
    }
  }

  return {
    harnessId,
    harnessVersion,
    outcome,
    receiptSource,
    receiptDigest,
    skillShaAtCapture,
    candidates,
  };
}

async function readReceiptFile(filePath, { expectedSha256 = "" } = {}) {
  const target = resolve(String(filePath));
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("RunReceipt が通常ファイルではない。");
  if (info.size > MAX_RECEIPT_BYTES) throw new Error("RunReceipt が大きすぎる。");
  const bytes = await readFile(target);
  const digest = sha256(bytes);
  const expected = String(expectedSha256 || "").replace(/^sha256:/u, "");
  if (expected && expected !== digest) throw new Error("RunReceipt の SHA-256 が Job の記録と一致しない。");
  const receipt = JSON.parse(bytes.toString("utf8"));
  if (receipt?.version !== RECEIPT_VERSION || receipt?.finalized !== true) {
    throw new Error("finalize 済みの RunReceipt ではない。");
  }
  return { receipt, digest };
}

/**
 * Job から、学習の材料にする RunReceipt を探す。
 *
 * - completed: 共通 RunReceipt（Job 成果物の run-receipt。SHA を照合する）
 * - それ以外: adapter が残した RunReceipt（Koya の最終監査は fail でも finalize する）
 * - どちらも無い failed / awaiting-human-review: Receipt 無しで Job の状態だけを使う
 */
export async function locateJobRunReceipt(job, { readReceipt = readReceiptFile } = {}) {
  const receiptArtifact = (job?.artifacts || []).find((artifact) => String(artifact?.kind || "") === "run-receipt");
  if (receiptArtifact?.path) {
    try {
      const { receipt, digest } = await readReceipt(receiptArtifact.path, { expectedSha256: receiptArtifact.sha256 });
      return { receipt, digest, source: "run-receipt", path: resolve(String(receiptArtifact.path)) };
    } catch {
      // 読めない共通 Receipt は材料にしない（下の adapter Receipt / Job 状態へ進む）。
    }
  }
  const adapterPath = typeof job?.adapterRunReceiptPath === "string" ? job.adapterRunReceiptPath.trim() : "";
  if (adapterPath) {
    try {
      const { receipt, digest } = await readReceipt(adapterPath);
      return { receipt, digest, source: "adapter-run-receipt", path: resolve(adapterPath) };
    } catch {
      // 同上。
    }
  }
  return null;
}

/** Receipt が無い決着の指紋。同じ Job の同じ版からは同じ値になる（冪等の鍵）。 */
export function jobStateDigest(job) {
  return sha256(JSON.stringify({
    version: AUTO_RECEIPT_LEARNING_VERSION,
    jobId: String(job?.id || ""),
    revision: Number.isSafeInteger(job?.revision) ? job.revision : null,
    status: String(job?.status || ""),
    updatedAt: String(job?.updatedAt || ""),
  }));
}

function evidenceFor(summary, candidate) {
  return [
    AUTO_RECEIPT_EVIDENCE_TAG,
    `source=${summary.receiptSource}`,
    `receipt=${summary.receiptDigest.slice(0, 16)}`,
    `outcome=${/^[a-z-]{1,40}$/u.test(summary.outcome) ? summary.outcome : "unknown"}`,
    `harness=${summary.harnessId}@${/^[A-Za-z0-9._+-]{1,40}$/u.test(summary.harnessVersion) ? summary.harnessVersion : "unknown"}`,
    `count=${candidate.count}`,
  ].join(" ");
}


/** 索引の既定の置き場（開発用チェックアウトは docs/learning/receipts、配布された写しは ~/.buzzassist/learning/receipts）。 */
export function defaultReceiptIndexPath(env = process.env) {
  return resolveLearningState({ codeRoot: REPO_ROOT, env }).receiptIndexPath;
}

/**
 * 決着を Receipt の索引へ1行残す（rollup の読み先）。台本・パスの自由文は入れず、
 * Job の id・ハーネス・状態・動かしたホスト・RunReceipt の path と sha256・決着時刻だけ。失敗しても Job は止めない。
 */
export function indexSettledJobReceipt({ job, located = null, indexPath, now = () => new Date().toISOString() } = {}) {
  try {
    const harnessId = String(located?.receipt?.harnessBuild?.harness?.id || job?.harness?.id || "");
    const harnessVersion = String(located?.receipt?.harnessBuild?.harness?.version || job?.harness?.declarationVersion || "");
    // どのホストから動かした決着か（harnessHostProvenance の要約）。記録の無い古い Job は行に足さない。
    const hostSummary = invocationHostSummary(job?.metadata?.invocation ?? located?.receipt?.invocation);
    const result = appendReceiptIndexRow(indexPath, {
      jobId: String(job?.id || ""),
      harnessId: HARNESS_ID.test(harnessId) ? harnessId : "unknown",
      ...(harnessVersion && /^[A-Za-z0-9._+-]{1,40}$/u.test(harnessVersion) ? { harnessVersion } : {}),
      ...(hostSummary.recorded && /^[a-z+-]{1,80}$/u.test(hostSummary.hostKey) ? { host: hostSummary.hostKey } : {}),
      status: String(job?.status || ""),
      receiptSource: located?.source ?? "job-state",
      receiptPath: located?.path ?? null,
      receiptSha256: located?.digest ?? null,
      ...(located ? {} : { stateDigest: jobStateDigest(job) }),
      settledAt: String(job?.completedAt || job?.updatedAt || now()),
      indexedAt: String(now()),
    });
    return { appended: result.appended === true, ...(result.reason ? { reason: result.reason } : {}) };
  } catch (error) {
    return { appended: false, reason: "index-failed", detail: String(error?.message || error).slice(0, 160) };
  }
}

/**
 * 決着した Job から学習候補を捕捉し、そのあと overlay を自動で sync する。Job を止めないため、
 * 例外は投げずに理由を返す。捕捉の前に、決着を Receipt の索引へ残す（BUZZASSIST_LEARNING_AUTO_CAPTURE=0
 * でも残す。索引は集計の読み先で、提案ではないため）。
 *
 * @param syncOverlays 自動 sync の関数。既定は、本番の経路（捕捉も索引も差し替えていない呼び出し）
 *   でだけ autoSyncLearningOverlays。捕捉の経路を差し替えた呼び出し（試験など）では、本物の
 *   リポジトリの overlay を書き換えないよう、明示したときだけ走らせる。null で止める
 */
export async function captureSettledJobLearning(options = {}) {
  const result = await captureSettledJobLearningCore(options);
  if (result.skippedReason === "child-agent" || result.skippedReason === "not-settled") return result;
  const {
    env = process.env,
    now = () => new Date().toISOString(),
    capture = captureLearningProposal,
    captureOptions = {},
    receiptIndexPath = undefined,
    syncOverlays = undefined,
    queueFeedback = undefined,
  } = options;
  const productionWiring = capture === captureLearningProposal
    && Object.keys(captureOptions || {}).length === 0
    && receiptIndexPath === undefined;
  const sync = syncOverlays === undefined ? (productionWiring ? autoSyncLearningOverlays : null) : syncOverlays;
  let output = result;
  if (typeof sync === "function") {
    let autoSync;
    try {
      autoSync = await sync({ trigger: "job-settled", env, now });
    } catch {
      autoSync = { status: "failed", reason: "sync-error", trigger: "job-settled" };
    }
    output = { ...output, autoSync };
  }
  // 提供元へ返す bundle（同意があるときだけ作る。lib/harnessFeedbackOutbox.mjs）。自動 sync と同じく、
  // 本番の経路でだけ既定で走らせ、使う瞬間に読む（読めなくても Job は止めない）。
  const feedback = queueFeedback === undefined
    ? (productionWiring ? async (input) => (await import("./harnessFeedbackOutbox.mjs")).queueJobSettlementFeedback(input) : null)
    : queueFeedback;
  if (typeof feedback !== "function") return output;
  try {
    output = { ...output, feedback: await feedback({ job: options.job, env, now, trigger: "job-settled", codeRoot: REPO_ROOT }) };
  } catch {
    output = { ...output, feedback: { status: "failed", reason: "feedback-error" } };
  }
  return output;
}

async function captureSettledJobLearningCore({
  job,
  env = process.env,
  now = () => new Date().toISOString(),
  capture = captureLearningProposal,
  captureOptions = {},
  locateReceipt = locateJobRunReceipt,
  loadDeclaration = loadHarnessDeclaration,
  receiptIndexPath = undefined,
} = {}) {
  const base = { version: AUTO_RECEIPT_LEARNING_VERSION, captured: 0, duplicates: 0, candidates: 0 };
  if (learningWritesForbidden(env)) return { ...base, skippedReason: "child-agent" };
  if (!job || !SETTLED_STATUSES.has(String(job.status || ""))) return { ...base, skippedReason: "not-settled" };

  let located = null;
  try {
    located = await locateReceipt(job);
  } catch {
    located = null;
  }
  const receiptIndex = indexSettledJobReceipt({
    job,
    located,
    indexPath: receiptIndexPath === undefined ? defaultReceiptIndexPath(env) : receiptIndexPath,
    now,
  });
  base.receiptIndex = receiptIndex;
  if (String(env?.[AUTO_RECEIPT_CAPTURE_ENV] ?? "").trim() === "0") return { ...base, skippedReason: "disabled" };
  const route = HARNESS_LEARNING_ROUTES[String(job.harness?.id || "")];
  if (!route?.channel) return { ...base, skippedReason: "unknown-harness-route" };
  if (!located && job.status === "completed") {
    // completed なのに共通 Receipt が読めないのは Job 側の不整合。推測で埋めない。
    return { ...base, skippedReason: "receipt-unreadable" };
  }
  const source = located?.source ?? "job-state";
  const digest = located?.digest ?? jobStateDigest(job);
  const summary = receiptLearningCandidates({
    receipt: located?.receipt ?? null,
    receiptDigest: digest,
    receiptSource: source,
    job,
    declaration: loadDeclaration(String(job.harness?.id || "")),
  });
  if (summary.skippedReason) return { ...base, skippedReason: summary.skippedReason };
  const channelId = jobChannelId(job);
  const result = {
    ...base,
    target: route.channel,
    ...(channelId ? { channelId } : {}),
    receiptSource: source,
    receiptDigest: digest.slice(0, 16),
    candidates: summary.candidates.length,
    proposalIds: [],
  };
  // チャンネルで作った Job は、そのチャンネルの保存先へ（台帳の読み込みには Job と同じ env を使う）。
  const optionsForCapture = channelId ? { env, ...captureOptions, channelId } : captureOptions;
  const capturedAt = String(now());
  for (const candidate of summary.candidates) {
    try {
      const output = capture({
        kind: "fact",
        target: route.channel,
        text: candidate.text,
        evidence: evidenceFor(summary, candidate),
        session: `auto-receipt:${digest.slice(0, 32)}`,
        now: capturedAt,
        metadata: {
          createdBy: AUTO_RECEIPT_CREATOR,
          receiptDigest: digest,
          receiptSource: source,
          harness: { id: summary.harnessId, ...(summary.harnessVersion ? { version: summary.harnessVersion } : {}) },
          ...(Object.keys(summary.skillShaAtCapture).length > 0 ? { skillShaAtCapture: summary.skillShaAtCapture } : {}),
          ...(candidate.gateIds.length > 0 ? { gateIds: candidate.gateIds } : {}),
        },
      }, optionsForCapture);
      if (output?.appended) result.captured += 1;
      else result.duplicates += 1;
      if (output?.entry?.id) result.proposalIds.push(output.entry.id);
    } catch (error) {
      // 1件目で落ちる理由（台帳が分離されていない等）は残りも同じなので、そこで止める。
      // チャンネルの保存先を決められない（台帳に無い・壊れている・共有台帳と重なる）ときは
      // channel-learning-store-unresolved。チャンネルの無い保存先へは落とさない。
      return { ...result, skippedReason: learningCaptureFailureReason(error, channelId) };
    }
  }
  return result;
}
