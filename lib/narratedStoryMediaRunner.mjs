/**
 * ナレーション物語の有料 Media Job の実行（ジャンル層）。共通 broker（lib/paidMediaJobBroker.mjs）の
 * get / recover / start / waitFor だけを使い、provider を直接呼ばない。
 *
 * 以前の実行器は、同じ requestKey の journal に recovery-required や課金されていない failed が
 * 残っていると、broker.start がその記録を返すだけで recover を呼ばず、例外で止まっていた
 * （再開しても永久に進まない）。ここでは送る前に鍵ごとに決着させる:
 *   - recovery-required → broker の recover で決着させる。決着しなければ
 *     `paid-media-recovery-pending` で止める（盲目的に送り直さない）
 *   - 課金されていない failed（charged:false）
 *       - サーバーが一度も受理を返していない（jobId が local-）→ 同じ requestKey で送り直す
 *         （サーバーの冪等キーで二重課金にならない）
 *       - サーバーが受理して failed に固定した → 決定論的な次の鍵 `<requestKey>:rN` で送り直す
 *   - 課金された failed → 既定では `paid-media-failed-charged` で止める。運営者が
 *     `--retry-failed-images` を付けたときだけ、画像を次の鍵で作り直し、回数を記録する
 *   - completed / 進行中 → そのまま attach（完成済みは再課金しない）
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createPaidMediaJobBroker,
  paidMediaJobReceiptSummary,
  paidMediaRequestIdentity,
  readPaidMediaJobArtifact,
} from "./paidMediaJobBroker.mjs";

export const PAID_MEDIA_RECOVERY_PENDING_CODE = "paid-media-recovery-pending";
export const PAID_MEDIA_FAILED_CHARGED_CODE = "paid-media-failed-charged";
/** 同じ入力の鍵を `:rN` で進める上限（Koya の台詞と同じ上限）。 */
export const NARRATED_REQUEST_KEY_CHAIN_LIMIT = 8;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const UNSETTLED = new Set(["recovery-required", "queued", "running", "paused"]);

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function serverAcknowledged(job) {
  const id = nonEmpty(job?.jobId);
  return (id.length > 0 && !id.startsWith("local-")) || Boolean(nonEmpty(job?.providerJobId)) || Boolean(nonEmpty(job?.reservation?.reservationId));
}

function codedError(code, message, job = null) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  if (job) error.job = paidMediaJobReceiptSummary(job);
  return error;
}

/** `base` と `base:rN` が同じ入力の鍵の系列か。 */
export function requestKeyInChain(requestKey, base) {
  const key = nonEmpty(requestKey);
  const root = nonEmpty(base);
  if (!key || !root) return false;
  if (key === root) return true;
  if (!key.startsWith(`${root}:r`)) return false;
  const suffix = key.slice(root.length + 2);
  return /^[1-9]\d*$/u.test(suffix) && Number(suffix) <= NARRATED_REQUEST_KEY_CHAIN_LIMIT;
}

/**
 * 共通 broker を使う実行器。`retryFailedKinds` に入った種類（画像）だけ、課金された failed を
 * 作り直してよい（運営者の明示）。戻り値の関数に probeAdapter / stateDir / stats を付ける。
 */
export function createBrokerMediaJobRunner({
  apiBase,
  stateDir,
  apiFetch,
  artifactFetch,
  retryFailedKinds = [],
  broker: injectedBroker = null,
  readArtifact = readPaidMediaJobArtifact,
  waitOptions = {},
} = {}) {
  const base = nonEmpty(apiBase);
  if (!base && !injectedBroker) return null;
  const broker = injectedBroker || createPaidMediaJobBroker({ stateDir, apiBase: base, apiFetch });
  const retryKinds = new Set(retryFailedKinds.map(String));
  const retriedFailed = { requested: retryKinds.has("image.generation"), jobIds: [], count: 0, attempts: 0, completed: 0 };
  const settled = { recovered: [], resubmittedUncharged: [] };

  async function route(spec) {
    const baseKey = nonEmpty(spec.requestKey) || paidMediaRequestIdentity(spec).requestKey;
    let retriedFrom = "";
    for (let n = 0; n <= NARRATED_REQUEST_KEY_CHAIN_LIMIT; n += 1) {
      const requestKey = n === 0 ? baseKey : `${baseKey}:r${n}`;
      let local = await broker.getLocal({ requestKey });
      if (!local) return { requestKey, replay: false, retriedFrom };
      if (local.status === "recovery-required") {
        local = await broker.recover({ requestKey });
        settled.recovered.push({ requestKey, after: local.status });
        if (local.status === "recovery-required") {
          throw codedError(PAID_MEDIA_RECOVERY_PENDING_CODE, "the provider may have accepted this Media Job; recover did not settle it, so nothing is resubmitted.", local);
        }
        if (!TERMINAL.has(local.status)) return { requestKey, replay: false, retriedFrom };
      }
      if (local.status === "failed" || local.status === "cancelled") {
        const charged = local.error?.charged;
        if (charged === false && local.status === "failed" && !serverAcknowledged(local)) {
          settled.resubmittedUncharged.push({ requestKey, sameKey: true });
          return { requestKey, replay: true, retriedFrom };
        }
        if (charged === false) {
          settled.resubmittedUncharged.push({ requestKey, sameKey: false });
          continue;
        }
        if (retryKinds.has(spec.kind)) {
          retriedFrom = retriedFrom || requestKey;
          retriedFailed.jobIds.push(nonEmpty(local.jobId) || requestKey);
          continue;
        }
        throw codedError(PAID_MEDIA_FAILED_CHARGED_CODE, `a ${spec.kind} Media Job ended ${local.status} after it may have been charged; it is not resubmitted automatically.`, local);
      }
      return { requestKey, replay: false, retriedFrom };
    }
    throw codedError(PAID_MEDIA_FAILED_CHARGED_CODE, `the request key chain for this ${spec.kind} reached its limit (${NARRATED_REQUEST_KEY_CHAIN_LIMIT}).`);
  }

  const runner = async (spec) => {
    const chosen = await route(spec);
    if (chosen.retriedFrom) {
      retriedFailed.count += 1;
      retriedFailed.attempts += 1;
    }
    let job = await broker.start({ ...spec, requestKey: chosen.requestKey }, { replayUnchargedLocalFailure: chosen.replay });
    if (job.status === "recovery-required") job = await broker.recover({ requestKey: job.requestKey });
    if (!TERMINAL.has(job.status) && job.status !== "recovery-required") {
      job = await broker.waitFor({ requestKey: job.requestKey }, waitOptions);
    }
    if (job.status === "recovery-required") {
      throw codedError(PAID_MEDIA_RECOVERY_PENDING_CODE, "the provider may have accepted this Media Job; recover did not settle it, so nothing is resubmitted.", job);
    }
    if (job.status !== "completed") {
      const error = codedError(`paid-media-job-${job.status}`, job.error?.message || `Media job ${job.jobId} stopped in ${job.status}.`, job);
      error.charged = job.error?.charged ?? null;
      throw error;
    }
    if (chosen.retriedFrom) retriedFailed.completed += 1;
    return {
      bytes: await readArtifact(job, { fetchImpl: artifactFetch }),
      job,
      receipt: broker.receipt(job),
    };
  };
  runner.probeAdapter = (spec, options = {}) => broker.probeAdapter(spec, options);
  runner.stateDir = broker.stateDir;
  runner.stats = () => ({
    retriedFailed: { ...retriedFailed, jobIds: [...retriedFailed.jobIds] },
    recovered: settled.recovered.map((entry) => ({ ...entry })),
    resubmittedUncharged: settled.resubmittedUncharged.map((entry) => ({ ...entry })),
  });
  return runner;
}

/**
 * broker journal にある、まだ決着していない Media Job（recovery-required・進行中）。
 * 子が止まったときに Job 層へ報告し、Job 層の recover がこの journal を見つけられるようにする。
 * failed は報告しない（Job 層で完成を妨げる行を残さない。課金されていない失敗は次の実行で送り直す）。
 */
export async function listUnsettledPaidMediaJobs(stateDir) {
  const dir = nonEmpty(stateDir);
  if (!dir) return [];
  let names = [];
  try {
    names = await readdir(join(dir, "jobs"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const rows = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    let job = null;
    try {
      job = JSON.parse(await readFile(join(dir, "jobs", name), "utf8"));
    } catch {
      continue;
    }
    if (!UNSETTLED.has(job?.status)) continue;
    rows.push(paidMediaJobReceiptSummary(job));
  }
  return rows;
}
