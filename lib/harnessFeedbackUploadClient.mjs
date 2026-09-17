// 運営者端末側のdurable feedback uploader。管理側はbundle digestで冪等なため、
// network切断や「server受理後・local journal前」のcrashでも同じ署名bytesだけを再送する。

import { createHash } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { withCanvasFileLock } from "./canvasFileLock.mjs";
import { canonicalJson } from "./channelPackEnvelope.mjs";
import { readJsonIfExists, writeJsonAtomic } from "./canvasScene.mjs";
import {
  HARNESS_FEEDBACK_MAX_BUNDLE_BYTES,
  validateHarnessFeedbackBundleForTransport,
} from "./harnessFeedbackBundle.mjs";
import { HARNESS_FEEDBACK_INGEST_RECEIPT_VERSION } from "./harnessFeedbackIngest.mjs";

export const HARNESS_FEEDBACK_UPLOAD_JOURNAL_VERSION = "buzzassist-feedback-upload-journal-v2";
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_RESPONSE_BYTES = 64 * 1024;
const RESPONSE_TIMEOUT_MS = 30_000;

export class HarnessFeedbackUploadError extends Error {
  constructor(message, { code = "FEEDBACK_UPLOAD_FAILED", status = null, journal = null } = {}) {
    super(message);
    this.name = "HarnessFeedbackUploadError";
    this.code = code;
    this.status = status;
    this.journal = journal;
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedEndpoint(value) {
  let endpoint;
  try { endpoint = new URL(nonEmpty(value)); }
  catch { throw new HarnessFeedbackUploadError("feedback upload endpoint URLが不正。"); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new HarnessFeedbackUploadError("feedback upload endpointへcredential/query/fragmentを含めない。");
  }
  const local = ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(local && endpoint.protocol === "http:")) {
    throw new HarnessFeedbackUploadError("feedback uploadはHTTPS（localhost testだけHTTP）であること。");
  }
  if (endpoint.pathname === "/" || !endpoint.pathname) endpoint.pathname = "/v1/feedback/bundles";
  if (endpoint.pathname !== "/v1/feedback/bundles") {
    throw new HarnessFeedbackUploadError("feedback upload endpoint pathは/v1/feedback/bundlesであること。");
  }
  return endpoint.toString();
}

function responseInvalid(message, status = null) {
  return new HarnessFeedbackUploadError(message, {
    code: "FEEDBACK_UPLOAD_RESPONSE_INVALID",
    status,
  });
}

function cancelStreamBestEffort(target) {
  try {
    const pending = target?.cancel?.();
    pending?.catch?.(() => {});
  } catch { /* best effort */ }
}

async function readBoundedResponse(response, { timeoutMs = RESPONSE_TIMEOUT_MS } = {}) {
  const declaredText = response?.headers?.get?.("content-length");
  if (declaredText != null && declaredText !== "") {
    if (!/^\d+$/u.test(declaredText)) throw responseInvalid("feedback server responseのContent-Lengthが不正。", response?.status);
    const declared = Number(declaredText);
    if (!Number.isSafeInteger(declared) || declared > MAX_RESPONSE_BYTES) {
      cancelStreamBestEffort(response?.body);
      throw responseInvalid("feedback server responseが大きすぎる。", response?.status);
    }
  }
  if (!response?.body) return {};
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw responseInvalid("feedback server responseの読込がtimeoutした。", response?.status);
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(responseInvalid("feedback server responseの読込がtimeoutした。", response?.status)), remaining);
      });
      let part;
      try { part = await Promise.race([reader.read(), timeout]); }
      finally { clearTimeout(timer); }
      if (part.done) break;
      const chunk = Buffer.from(part.value || []);
      total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) {
        throw responseInvalid("feedback server responseが大きすぎる。", response?.status);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    cancelStreamBestEffort(reader);
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* best effort */ }
  }
  const bytes = Buffer.concat(chunks, total);
  const text = bytes.toString("utf8");
  try { return text ? JSON.parse(text) : {}; }
  catch { return { error: text.slice(0, 1000) }; }
}

function redactSensitive(value, secrets = []) {
  let text = String(value || "");
  for (const secret of secrets.filter((entry) => nonEmpty(entry)).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("[REDACTED]");
  }
  return text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]");
}

function safeAttempt({ number, startedAt, finishedAt, status = null, retryable, error = "", secrets = [] }) {
  return {
    number,
    startedAt,
    finishedAt,
    status,
    retryable: retryable === true,
    error: redactSensitive(error, secrets).slice(0, 1000),
  };
}

function validateBundleForUpload(bundle) {
  try { validateHarnessFeedbackBundleForTransport(bundle); }
  catch (error) {
    throw new HarnessFeedbackUploadError(`送信前feedback bundle検証に失敗: ${error?.message || error}`, {
      code: "FEEDBACK_UPLOAD_BUNDLE_INVALID",
    });
  }
  return bundle;
}

async function readBoundedBundle(path) {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > HARNESS_FEEDBACK_MAX_BUNDLE_BYTES) {
      throw new HarnessFeedbackUploadError(`feedback bundleは1..${HARNESS_FEEDBACK_MAX_BUNDLE_BYTES} bytesの通常fileであること。`, {
        code: "FEEDBACK_UPLOAD_BUNDLE_SIZE_INVALID",
      });
    }
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, offset);
    if (offset !== info.size || extraBytes !== 0) {
      throw new HarnessFeedbackUploadError("feedback bundleが読込中に変化した。新しいbundleとして作り直すこと。", {
        code: "FEEDBACK_UPLOAD_BUNDLE_CHANGED",
      });
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function normalizeServerReceipt(value, bundleDigest, responseStatus = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.version !== HARNESS_FEEDBACK_INGEST_RECEIPT_VERSION
    || value.ok !== true
    || typeof value.duplicate !== "boolean"
    || value.status !== "verified-quarantine"
    || value.bundleDigest !== bundleDigest
    || value.ownerApprovalRequired !== true) {
    throw new HarnessFeedbackUploadError("feedback server receiptが送信bundle digestへ結合された正式形式ではない。", {
      code: "FEEDBACK_UPLOAD_RECEIPT_MISMATCH",
      status: responseStatus,
    });
  }
  return {
    version: HARNESS_FEEDBACK_INGEST_RECEIPT_VERSION,
    ok: true,
    duplicate: value.duplicate,
    status: "verified-quarantine",
    bundleDigest,
    ownerApprovalRequired: true,
  };
}

function assertDeliveredJournal(journal, bundleDigest) {
  const normalized = normalizeServerReceipt(journal.serverReceipt, bundleDigest);
  const last = journal.attempts.at(-1);
  if (![200, 202].includes(journal.lastStatus)
    || !last || last.number !== journal.attempts.length
    || last.status !== journal.lastStatus || last.retryable !== false
    || nonEmpty(last.error) || !Number.isFinite(Date.parse(nonEmpty(journal.deliveredAt)))) {
    throw new HarnessFeedbackUploadError("delivered feedback journalの成功証跡が不正。", {
      code: "FEEDBACK_UPLOAD_JOURNAL_CONFLICT",
    });
  }
  if (canonicalJson(normalized) !== canonicalJson(journal.serverReceipt)) {
    throw new HarnessFeedbackUploadError("delivered feedback journalのserver receiptが改変されている。", {
      code: "FEEDBACK_UPLOAD_JOURNAL_CONFLICT",
    });
  }
}

function publicUploadResult(journal, attached = false) {
  return {
    ok: journal.status === "delivered",
    attached,
    status: journal.status,
    bundleDigest: journal.bundleDigest,
    endpoint: journal.endpoint,
    attemptCount: journal.attempts.length,
    serverReceipt: journal.serverReceipt || null,
    journalPath: journal.journalPath,
  };
}

export async function uploadHarnessFeedbackBundle({
  bundlePath,
  endpoint,
  uploadToken,
  journalDir = "",
  fetchImpl = globalThis.fetch,
  maxAttempts = 4,
  baseDelayMs = 250,
  responseTimeoutMs = RESPONSE_TIMEOUT_MS,
  now = () => new Date().toISOString(),
  sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
} = {}) {
  if (typeof fetchImpl !== "function") throw new HarnessFeedbackUploadError("fetch実装が無い。");
  if (!nonEmpty(uploadToken)) throw new HarnessFeedbackUploadError("feedback upload tokenが要る。");
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new HarnessFeedbackUploadError("maxAttemptsは1..10であること。");
  }
  if (!Number.isSafeInteger(responseTimeoutMs) || responseTimeoutMs < 1 || responseTimeoutMs > 60_000) {
    throw new HarnessFeedbackUploadError("responseTimeoutMsは1..60000であること。");
  }
  const path = resolve(nonEmpty(bundlePath));
  if (!nonEmpty(bundlePath)) throw new HarnessFeedbackUploadError("bundlePathが要る。");
  const bytes = await readBoundedBundle(path);
  let parsed;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch {
    throw new HarnessFeedbackUploadError("feedback bundleがJSONではない。", {
      code: "FEEDBACK_UPLOAD_BUNDLE_INVALID",
    });
  }
  const bundle = validateBundleForUpload(parsed);
  const bundleDigest = sha256(canonicalJson(bundle));
  const target = normalizedEndpoint(endpoint);
  const journals = resolve(nonEmpty(journalDir) || join(dirname(path), ".feedback-upload-journal"));
  const journalPath = join(journals, `${bundleDigest}.json`);
  return withCanvasFileLock(journalPath, async () => {
    let journal = await readJsonIfExists(journalPath, null);
    if (journal) {
      if (journal.version !== HARNESS_FEEDBACK_UPLOAD_JOURNAL_VERSION
        || journal.bundleDigest !== bundleDigest
        || journal.bundlePath !== path
        || journal.endpoint !== target
        || journal.journalPath !== journalPath
        || !Array.isArray(journal.attempts)) {
        throw new HarnessFeedbackUploadError("feedback upload journalがbundle/endpointと一致しない。", {
          code: "FEEDBACK_UPLOAD_JOURNAL_CONFLICT",
          journal,
        });
      }
      if (journal.status === "delivered") {
        assertDeliveredJournal(journal, bundleDigest);
        return publicUploadResult(journal, true);
      }
      if (journal.status === "permanent-failure") {
        throw new HarnessFeedbackUploadError("feedback uploadは恒久失敗済み。内容/権限を直して新bundleにすること。", {
          code: "FEEDBACK_UPLOAD_PERMANENT_FAILURE",
          status: journal.lastStatus,
          journal,
        });
      }
    } else {
      journal = {
        version: HARNESS_FEEDBACK_UPLOAD_JOURNAL_VERSION,
        bundleDigest,
        bundlePath: path,
        endpoint: target,
        status: "pending",
        createdAt: now(),
        updatedAt: now(),
        attempts: [],
        serverReceipt: null,
        journalPath,
      };
      await writeJsonAtomic(journalPath, journal);
    }

    for (let offset = 0; offset < maxAttempts; offset += 1) {
      const attemptNumber = journal.attempts.length + 1;
      const startedAt = now();
      let response;
      let responseBody = null;
      try {
        response = await fetchImpl(target, {
          method: "POST",
          headers: {
            authorization: `Bearer ${uploadToken}`,
            "content-type": "application/json",
            "content-length": String(bytes.length),
          },
          body: bytes,
          redirect: "error",
          signal: AbortSignal.timeout(responseTimeoutMs),
        });
        responseBody = await readBoundedResponse(response, { timeoutMs: responseTimeoutMs });
        if ([200, 202].includes(response.status)) {
          const serverReceipt = normalizeServerReceipt(responseBody, bundleDigest, response.status);
          journal.attempts.push(safeAttempt({
            number: attemptNumber,
            startedAt,
            finishedAt: now(),
            status: response.status,
            retryable: false,
          }));
          journal.status = "delivered";
          journal.deliveredAt = now();
          journal.updatedAt = now();
          journal.lastStatus = response.status;
          journal.serverReceipt = serverReceipt;
          await writeJsonAtomic(journalPath, journal);
          return publicUploadResult(journal, false);
        }
        const retryable = RETRYABLE_STATUS.has(response.status);
        journal.attempts.push(safeAttempt({
          number: attemptNumber,
          startedAt,
          finishedAt: now(),
          status: response.status,
          retryable,
          error: responseBody?.error || responseBody?.code || `HTTP ${response.status}`,
          secrets: [uploadToken],
        }));
        journal.status = retryable ? "retry-pending" : "permanent-failure";
        journal.updatedAt = now();
        journal.lastStatus = response.status;
        await writeJsonAtomic(journalPath, journal);
        if (!retryable) {
          throw new HarnessFeedbackUploadError(`feedback uploadがHTTP ${response.status}で拒否された。`, {
            code: "FEEDBACK_UPLOAD_PERMANENT_FAILURE",
            status: response.status,
            journal,
          });
        }
      } catch (error) {
        if (error instanceof HarnessFeedbackUploadError
          && ["FEEDBACK_UPLOAD_PERMANENT_FAILURE", "FEEDBACK_UPLOAD_RECEIPT_MISMATCH", "FEEDBACK_UPLOAD_RESPONSE_INVALID"].includes(error.code)) {
          if (["FEEDBACK_UPLOAD_RECEIPT_MISMATCH", "FEEDBACK_UPLOAD_RESPONSE_INVALID"].includes(error.code)) {
            journal.attempts.push(safeAttempt({
              number: attemptNumber,
              startedAt,
              finishedAt: now(),
              status: error.status,
              retryable: false,
              error: error.message,
              secrets: [uploadToken],
            }));
            journal.status = "permanent-failure";
            journal.updatedAt = now();
            journal.lastStatus = error.status;
            await writeJsonAtomic(journalPath, journal);
          }
          throw error;
        }
        // A retryable HTTP response was already journaled above. Network and
        // parser failures arrive here without an attempt row.
        const alreadyRecorded = journal.attempts.at(-1)?.number === attemptNumber;
        if (!alreadyRecorded) {
          journal.attempts.push(safeAttempt({
            number: attemptNumber,
            startedAt,
            finishedAt: now(),
            status: response?.status ?? null,
            retryable: true,
            error: error?.message || error,
            secrets: [uploadToken],
          }));
          journal.status = "retry-pending";
          journal.updatedAt = now();
          journal.lastStatus = response?.status ?? null;
          await writeJsonAtomic(journalPath, journal);
        }
      }
      if (offset < maxAttempts - 1) await sleep(baseDelayMs * (2 ** offset));
    }
    throw new HarnessFeedbackUploadError("feedback uploadのretry上限に達した。journalから同じbundleを再開できる。", {
      code: "FEEDBACK_UPLOAD_RETRY_EXHAUSTED",
      status: journal.lastStatus,
      journal,
    });
  });
}

export async function syncHarnessFeedbackBundles({
  bundleDir,
  endpoint,
  uploadToken,
  journalDir = "",
  upload = uploadHarnessFeedbackBundle,
} = {}) {
  const root = resolve(nonEmpty(bundleDir));
  if (!nonEmpty(bundleDir)) throw new HarnessFeedbackUploadError("bundleDirが要る。");
  const names = (await readdir(root)).filter((name) => name.endsWith(".json")).sort();
  const results = [];
  for (const name of names) {
    try {
      results.push(await upload({
        bundlePath: join(root, basename(name)),
        endpoint,
        uploadToken,
        journalDir,
      }));
    } catch (error) {
      results.push({
        ok: false,
        bundlePath: join(root, basename(name)),
        code: error?.code || "FEEDBACK_UPLOAD_FAILED",
        error: String(error?.message || error),
      });
    }
  }
  return {
    ok: results.every((entry) => entry.ok === true),
    bundleDir: root,
    attempted: results.length,
    delivered: results.filter((entry) => entry.ok === true).length,
    failed: results.filter((entry) => entry.ok !== true).length,
    results,
  };
}
