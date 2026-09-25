// Durable paid-media job client.
//
// Provider credentials and provider URLs intentionally do not exist in this
// module.  The client submits a typed job to BuzzAssist; the server owns the
// Fish Audio / ElevenLabs adapter and its secret.  A small local journal makes
// request identity, reservation intent and recovery state survive a process
// restart without persisting the submitted request body or any credential.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";

import { buzzAssistFetch, resolveBuzzAssistApiBase } from "./buzzassistApi.mjs";
import { acquireMachineSlot, releaseMachineSlot } from "./machineSlots.mjs";
import {
  NonRetryablePaidApiError,
  RetryablePaidApiError,
  ambiguousChargeError,
  afterSuccessFailure,
  paidApiResponseError,
  redactSecrets,
  withPaidApiRetry,
} from "./paidApiRetry.mjs";

export const PAID_MEDIA_JOB_VERSION = "buzzassist-paid-media-job-v1";
export const PAID_MEDIA_RECEIPT_VERSION = "buzzassist-paid-media-receipt-v1";

export const PAID_MEDIA_JOB_KINDS = Object.freeze([
  "voice.synthesis",
  "voice.dialogue",
  "voice.catalog",
  "image.generation",
  "music.generation",
  "subtitle.transcription",
]);

export const PAID_MEDIA_JOB_STATUSES = Object.freeze([
  "reserved",
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "recovery-required",
]);

const STATUS_ALIASES = Object.freeze({
  accepted: "queued",
  pending: "queued",
  processing: "running",
  succeeded: "completed",
  complete: "completed",
  canceled: "cancelled",
  requires_recovery: "recovery-required",
  "requires-recovery": "recovery-required",
});

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const SECRET_KEY_PATTERN = /(?:api[-_]?key|authorization|auth[-_]?token|access[-_]?token|refresh[-_]?token|token|secret|password|credentials?|private[-_]?key|signing[-_]?key|client[-_]?secret|cookie)$/iu;
const DEFAULT_STALE_LOCK_MS = 15 * 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MEDIA_MIME_PATTERN = /^(?:audio|image|text|video)\/[a-z0-9.+-]+$|^application\/(?:json|octet-stream|pdf|vnd\.[a-z0-9.+-]+)$/u;

const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function finiteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedOrigin(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.username || parsed.password) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function configuredArtifactOrigins(options = {}) {
  const explicit = Array.isArray(options.allowedOrigins) ? options.allowedOrigins : [];
  const configured = String(options.allowedOriginsEnv
    ?? process.env.BUZZASSIST_MEDIA_ARTIFACT_ORIGINS
    ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return new Set([
    resolveBuzzAssistApiBase(),
    ...explicit,
    ...configured,
  ].map(normalizedOrigin).filter(Boolean));
}

function validateArtifactDownloadDescriptor(artifact, options = {}) {
  const expectedSha256 = nonEmptyString(artifact?.sha256);
  if (!SHA256_PATTERN.test(expectedSha256)) {
    throw new Error("Completed paid media artifact requires a lowercase SHA-256 before download.");
  }
  const expectedBytes = finiteNumber(artifact?.bytes);
  const maxBytes = Math.max(1, finiteNumber(options.maxBytes, DEFAULT_MAX_ARTIFACT_BYTES));
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > maxBytes) {
    throw new Error(`Completed paid media artifact byte count must be 1..${maxBytes}.`);
  }
  const expectedMimeType = nonEmptyString(artifact?.mimeType).split(";", 1)[0].trim().toLowerCase();
  if (!MEDIA_MIME_PATTERN.test(expectedMimeType)) {
    throw new Error("Completed paid media artifact requires an allowlisted MIME type before download.");
  }
  let url;
  try { url = new URL(nonEmptyString(artifact?.url)); }
  catch { throw new Error("Completed paid media artifact URL is invalid."); }
  const loopbackHttp = url.protocol === "http:"
    && ["127.0.0.1", "::1", "localhost"].includes(url.hostname.toLowerCase());
  if (url.username || url.password || (url.protocol !== "https:" && !loopbackHttp)) {
    throw new Error("Paid media artifact URL must use HTTPS (HTTP is allowed only for loopback development).");
  }
  if (!configuredArtifactOrigins(options).has(url.origin)) {
    throw new Error(`Paid media artifact origin is not allowlisted: ${url.origin}`);
  }
  return { url, expectedSha256, expectedBytes, expectedMimeType, maxBytes };
}

function responseHeader(response, name) {
  if (typeof response?.headers?.get === "function") return nonEmptyString(response.headers.get(name));
  const entries = response?.headers && typeof response.headers === "object" ? response.headers : {};
  return nonEmptyString(Object.entries(entries).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]);
}

async function readArtifactResponseBytes(response, { expectedBytes, maxBytes }) {
  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value || []);
        total += chunk.length;
        if (total > maxBytes || total > expectedBytes) {
          try { await reader.cancel?.("artifact byte limit exceeded"); } catch {}
          throw new Error("Paid media artifact body exceeded its declared byte budget.");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, total);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes || bytes.length > expectedBytes) {
    throw new Error("Paid media artifact body exceeded its declared byte budget.");
  }
  return bytes;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function assertNoSecrets(value, path = "job") {
  if (!value || typeof value !== "object" || Buffer.isBuffer(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new Error(`${path}.${key} is not allowed. Provider secrets must stay on the BuzzAssist server.`);
    }
    assertNoSecrets(child, `${path}.${key}`);
  }
}

function stripSecretFields(value, secrets = []) {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => stripSecretFields(entry, secrets));
  if (!value || typeof value !== "object" || Buffer.isBuffer(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SECRET_KEY_PATTERN.test(key))
    .map(([key, child]) => [key, stripSecretFields(child, secrets)]));
}

function normalizeProvider(value) {
  const provider = nonEmptyString(value).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(provider)) {
    throw new Error("Paid media provider must be a stable lowercase adapter id.");
  }
  return provider;
}

function normalizeReservation(value = {}, requestKey = "", now = new Date().toISOString()) {
  const source = value && typeof value === "object" ? value : {};
  return {
    status: nonEmptyString(source.status) || "requested",
    requestedAt: nonEmptyString(source.requestedAt) || now,
    requestKey,
    reservationId: nonEmptyString(source.reservationId ?? source.id),
    unit: nonEmptyString(source.unit),
    estimatedUnits: finiteNumber(source.estimatedUnits ?? source.units),
    estimatedSeconds: finiteNumber(source.estimatedSeconds ?? source.seconds),
    estimatedCost: finiteNumber(source.estimatedCost ?? source.cost),
    currency: nonEmptyString(source.currency),
  };
}

/** Validate and normalize the closed client-side media job contract. */
export function normalizePaidMediaJobSpec(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Paid media job spec must be an object.");
  }
  assertNoSecrets(input);
  const kind = nonEmptyString(input.kind);
  if (!PAID_MEDIA_JOB_KINDS.includes(kind)) {
    throw new Error(`Unsupported paid media job kind: ${kind || "(missing)"}.`);
  }
  const provider = normalizeProvider(input.provider);
  const model = nonEmptyString(input.model);
  if (!model) throw new Error("Paid media job model is required.");
  const mediaInput = input.input;
  if (!mediaInput || typeof mediaInput !== "object" || Array.isArray(mediaInput)) {
    throw new Error("Paid media job input must be an object.");
  }
  const normalized = {
    version: PAID_MEDIA_JOB_VERSION,
    kind,
    provider,
    model,
    voiceId: nonEmptyString(input.voiceId),
    input: canonicalValue(mediaInput),
    output: canonicalValue(input.output && typeof input.output === "object" ? input.output : {}),
    adapterVersion: nonEmptyString(input.adapterVersion) || "v1",
  };
  const inputHash = sha256(canonicalJson(normalized.input));
  const identityHash = sha256(canonicalJson({ ...normalized, inputHash }));
  const suppliedRequestKey = nonEmptyString(input.requestKey);
  if (suppliedRequestKey && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(suppliedRequestKey)) {
    throw new Error("requestKey contains unsupported characters or is longer than 200 characters.");
  }
  const requestKey = suppliedRequestKey || `media:${kind}:${identityHash}`;
  return {
    ...normalized,
    inputHash,
    identityHash,
    requestKey,
    reservation: normalizeReservation(input.reservation, requestKey),
  };
}

/** Stable content identity used by callers that need deterministic filenames. */
export function paidMediaRequestIdentity(input = {}) {
  const normalized = normalizePaidMediaJobSpec(input);
  return {
    requestKey: normalized.requestKey,
    inputHash: normalized.inputHash,
    identityHash: normalized.identityHash,
  };
}

function header(response, name) {
  if (typeof response?.headers?.get === "function") return nonEmptyString(response.headers.get(name));
  const entries = response?.headers && typeof response.headers === "object" ? response.headers : {};
  const found = Object.entries(entries).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return nonEmptyString(found?.[1]);
}

function normalizeStatus(value, fallback = "queued") {
  const raw = nonEmptyString(value).toLowerCase();
  const status = STATUS_ALIASES[raw] || raw || fallback;
  return PAID_MEDIA_JOB_STATUSES.includes(status) ? status : fallback;
}

function normalizeArtifact(source = {}) {
  const artifact = source?.artifact && typeof source.artifact === "object" ? source.artifact : {};
  const url = nonEmptyString(artifact.url ?? source.artifactUrl ?? source.audioUrl ?? source.outputUrl);
  const sha = nonEmptyString(artifact.sha256 ?? source.artifactSha256 ?? source.outputSha256);
  if (!url && !sha) return null;
  return {
    url,
    sha256: sha,
    mimeType: nonEmptyString(artifact.mimeType ?? source.mimeType),
    bytes: finiteNumber(artifact.bytes ?? source.outputBytes),
  };
}

function normalizeUsage(source = {}, fallback = {}) {
  const usage = source?.usage && typeof source.usage === "object" ? source.usage : source;
  const freeRegeneration = usage.freeRegeneration ?? usage.free_regeneration;
  return {
    seconds: finiteNumber(
      usage.seconds ?? usage.durationSeconds ?? usage.chargedSeconds ?? usage.chargedSec,
      finiteNumber(fallback.seconds),
    ),
    units: finiteNumber(
      usage.units ?? usage.characters ?? usage.characterCount,
      finiteNumber(fallback.units),
    ),
    cost: finiteNumber(
      usage.cost ?? usage.costAmount ?? usage.amount,
      finiteNumber(fallback.cost),
    ),
    currency: nonEmptyString(usage.currency) || nonEmptyString(fallback.currency),
    freeRegeneration: freeRegeneration === undefined
      ? Boolean(fallback.freeRegeneration)
      : Boolean(freeRegeneration),
  };
}

function normalizeResult(source = {}, fallback = null) {
  const previous = fallback && typeof fallback === "object" ? fallback : {};
  const alignment = source.alignment ?? source.normalizedAlignment ?? source.normalized_alignment;
  const rawAlignment = source.rawAlignment ?? source.raw_alignment;
  const voiceSegments = Array.isArray(source.voiceSegments)
    ? source.voiceSegments
    : (Array.isArray(source.voice_segments) ? source.voice_segments : null);
  const dataPresent = Object.hasOwn(source, "data");
  return {
    artifact: normalizeArtifact(source) || previous.artifact || null,
    durationSeconds: finiteNumber(
      source.durationSeconds ?? source.durationSec ?? source.duration_seconds,
      finiteNumber(previous.durationSeconds),
    ),
    outputFormat: nonEmptyString(source.outputFormat ?? source.output_format ?? source.format)
      || nonEmptyString(previous.outputFormat),
    requestId: nonEmptyString(source.requestId ?? source.request_id)
      || nonEmptyString(previous.requestId),
    alignment: alignment === undefined ? (previous.alignment ?? null) : stripSecretFields(alignment),
    rawAlignment: rawAlignment === undefined ? (previous.rawAlignment ?? null) : stripSecretFields(rawAlignment),
    voiceSegments: voiceSegments === null
      ? (Array.isArray(previous.voiceSegments) ? previous.voiceSegments : [])
      : stripSecretFields(voiceSegments),
    data: dataPresent ? stripSecretFields(source.data) : (previous.data ?? null),
  };
}

function normalizeRemoteJob(payload, localJob) {
  const envelope = payload && typeof payload === "object" ? payload : {};
  const source = envelope.job && typeof envelope.job === "object" ? envelope.job : envelope;
  const resultSource = source.result && typeof source.result === "object"
    ? source.result
    : (envelope.result && typeof envelope.result === "object" ? envelope.result : source);
  const reservationSource = source.reservation || envelope.reservation || {};
  const result = normalizeResult({
    ...resultSource,
    requestId: resultSource.requestId ?? resultSource.request_id ?? source.requestId ?? source.request_id,
    ...(Object.hasOwn(resultSource, "data") || !Object.hasOwn(envelope, "data")
      ? {}
      : { data: envelope.data }),
  }, localJob.result);
  const reservation = {
    ...localJob.reservation,
    requestKey: localJob.requestKey,
    requestedAt: nonEmptyString(reservationSource.requestedAt)
      || localJob.reservation?.requestedAt
      || new Date().toISOString(),
    unit: nonEmptyString(reservationSource.unit) || nonEmptyString(localJob.reservation?.unit),
    estimatedUnits: finiteNumber(
      reservationSource.estimatedUnits ?? reservationSource.units,
      finiteNumber(localJob.reservation?.estimatedUnits),
    ),
    estimatedSeconds: finiteNumber(
      reservationSource.estimatedSeconds ?? reservationSource.seconds,
      finiteNumber(localJob.reservation?.estimatedSeconds),
    ),
    estimatedCost: finiteNumber(
      reservationSource.estimatedCost ?? reservationSource.cost,
      finiteNumber(localJob.reservation?.estimatedCost),
    ),
    currency: nonEmptyString(reservationSource.currency) || nonEmptyString(localJob.reservation?.currency),
    status: nonEmptyString(reservationSource.status) || localJob.reservation?.status || "requested",
    reservationId: nonEmptyString(
      reservationSource.reservationId ?? reservationSource.id ?? localJob.reservation?.reservationId,
    ),
  };
  return {
    ...localJob,
    adapterVersion: nonEmptyString(
      source.adapterVersion ?? source.adapter_version ?? envelope.adapterVersion ?? envelope.adapter_version,
    ) || localJob.adapterVersion,
    jobId: nonEmptyString(source.jobId ?? source.id ?? envelope.jobId) || localJob.jobId,
    providerJobId: nonEmptyString(
      source.providerJobId ?? source.provider_job_id
        ?? resultSource.providerJobId ?? resultSource.provider_job_id
        ?? envelope.providerJobId ?? envelope.provider_job_id,
    ) || localJob.providerJobId,
    status: normalizeStatus(source.status ?? envelope.status, localJob.status),
    reservation,
    usage: normalizeUsage(source.usage ?? resultSource.usage ?? envelope.usage ?? {}, localJob.usage),
    result,
    error: source.error
      ? {
        message: redactSecrets(nonEmptyString(source.error.message ?? source.error)),
        code: nonEmptyString(source.error.code),
        status: finiteNumber(source.error.status ?? source.error.httpStatus),
        retryable: source.error.retryable === true,
        charged: source.error.charged === true ? true : (source.error.charged === false ? false : null),
      }
      : null,
    updatedAt: nonEmptyString(source.updatedAt ?? envelope.updatedAt) || new Date().toISOString(),
  };
}

function assertRemoteIdentity(payload, localJob, operation) {
  const envelope = payload && typeof payload === "object" ? payload : {};
  const source = envelope.job && typeof envelope.job === "object" ? envelope.job : envelope;
  const remoteRequestKey = nonEmptyString(source.requestKey ?? envelope.requestKey);
  const remoteInputHash = nonEmptyString(source.inputHash ?? envelope.inputHash);
  if ((remoteRequestKey && remoteRequestKey !== localJob.requestKey)
    || (remoteInputHash && remoteInputHash !== localJob.inputHash)) {
    throw afterSuccessFailure(
      `${operation} returned HTTP 2xx for a different paid-media identity; recover the existing job`,
    );
  }
}

function errorSummary(error, secrets = [], now = new Date().toISOString()) {
  return {
    name: nonEmptyString(error?.name) || "Error",
    message: redactSecrets(error?.message || String(error), secrets),
    code: nonEmptyString(error?.code),
    status: finiteNumber(error?.status),
    retryable: error?.retryable === true,
    charged: error?.charged === true ? true : (error?.charged === false ? false : null),
    at: now,
  };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temp, path);
}

/** 端末全体で数える枠の種類（lib/machineSlots.mjs）。有料の音声生成と画像生成だけ。 */
export function machineSlotPoolForKind(kind) {
  if (kind === "voice.synthesis" || kind === "voice.dialogue") return "paid-speech";
  if (kind === "image.generation") return "paid-image";
  return "";
}

function defaultStateDir() {
  const configured = nonEmptyString(process.env.BUZZASSIST_MEDIA_JOB_STATE_DIR);
  return resolve(configured || join(os.homedir(), ".buzzassist", "media-jobs"));
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** Receipt-safe view: no text, artifact URL, provider response body or secret. */
export function paidMediaJobReceiptSummary(job = {}) {
  const artifact = job.result?.artifact || {};
  return {
    version: PAID_MEDIA_RECEIPT_VERSION,
    jobId: nonEmptyString(job.jobId),
    requestKey: nonEmptyString(job.requestKey),
    status: normalizeStatus(job.status, "failed"),
    kind: nonEmptyString(job.kind),
    provider: nonEmptyString(job.provider),
    adapterVersion: nonEmptyString(job.adapterVersion),
    providerJobId: nonEmptyString(job.providerJobId),
    model: nonEmptyString(job.model),
    voiceId: nonEmptyString(job.voiceId),
    inputHash: nonEmptyString(job.inputHash),
    identityHash: nonEmptyString(job.identityHash),
    reservation: {
      reservationId: nonEmptyString(job.reservation?.reservationId),
      status: nonEmptyString(job.reservation?.status),
      requestedAt: nonEmptyString(job.reservation?.requestedAt),
      unit: nonEmptyString(job.reservation?.unit),
      estimatedSeconds: finiteNumber(job.reservation?.estimatedSeconds),
      estimatedUnits: finiteNumber(job.reservation?.estimatedUnits),
      estimatedCost: finiteNumber(job.reservation?.estimatedCost),
      currency: nonEmptyString(job.reservation?.currency),
    },
    usage: normalizeUsage(job.usage || {}),
    artifact: {
      sha256: nonEmptyString(artifact.sha256),
      mimeType: nonEmptyString(artifact.mimeType),
      bytes: finiteNumber(artifact.bytes),
    },
    attempts: {
      total: finiteNumber(job.attempts?.total, 0),
      retries: Array.isArray(job.attempts?.retries)
        ? job.attempts.retries.map((entry) => ({
          operation: nonEmptyString(entry.operation),
          attempt: finiteNumber(entry.attempt),
          status: finiteNumber(entry.status),
          backoffMs: finiteNumber(entry.backoffMs),
        }))
        : [],
    },
    createdAt: nonEmptyString(job.createdAt),
    updatedAt: nonEmptyString(job.updatedAt),
  };
}

function normalizeAdapterProbe(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Paid media adapter probe must be an object.");
  }
  assertNoSecrets(input, "probe");
  const kind = nonEmptyString(input.kind);
  if (!PAID_MEDIA_JOB_KINDS.includes(kind)) throw new Error(`Unsupported paid media job kind: ${kind || "(missing)"}.`);
  const provider = normalizeProvider(input.provider);
  const model = nonEmptyString(input.model);
  const adapterVersion = nonEmptyString(input.adapterVersion);
  if (!model || !adapterVersion) throw new Error("Paid media adapter probe requires model and adapterVersion.");
  return { kind, provider, model, adapterVersion };
}

/**
 * 仲介が BuzzAssist のログインではなく API キーで認証する場合（例: オトシゴ）の fetch。
 * `BUZZASSIST_MEDIA_JOB_API_KEY` があれば `Authorization: Bearer` で送る。キーは応答・エラー・
 * 記録のどこにも出さない（呼び出し側の redactionSecrets にも入れる）。再送は requestJson 側が持つ。
 */
export function mediaJobApiKeyFetch(apiKey) {
  const key = nonEmptyString(apiKey);
  if (!key) throw new Error("mediaJobApiKeyFetch requires a non-empty API key.");
  return async function apiKeyFetch(url, { method = "POST", headers = {}, body, signal, timeoutMs = 180_000 } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      return await fetch(url, {
        method,
        headers: { ...headers, authorization: `Bearer ${key}` },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  };
}

export function createPaidMediaJobBroker(options = {}) {
  const stateDir = resolve(options.stateDir || defaultStateDir());
  const jobsDir = join(stateDir, "jobs");
  const locksDir = join(stateDir, "locks");
  // doctor・narrated・recover が「仲介の住所」として見る BUZZASSIST_MEDIA_JOB_API_BASE を、
  // broker 自身も既定として読む。読まないと doctor はその住所を probe して通すのに、
  // 本番（Koya の台詞・recover）は BuzzAssist 側の既定へ送っていた（2026-09-24 に mock で実測）。
  const apiBase = nonEmptyString(options.apiBase)
    || nonEmptyString(process.env.BUZZASSIST_MEDIA_JOB_API_BASE)
    || `${resolveBuzzAssistApiBase()}/api/media/jobs`;
  const apiKey = nonEmptyString(options.apiKey ?? process.env.BUZZASSIST_MEDIA_JOB_API_KEY);
  const apiFetch = typeof options.apiFetch === "function"
    ? options.apiFetch
    : (apiKey ? mediaJobApiKeyFetch(apiKey) : buzzAssistFetch);
  const sleepFn = typeof options.sleepFn === "function" ? options.sleepFn : sleep;
  const clock = typeof options.now === "function" ? options.now : () => new Date();
  const alive = typeof options.pidIsAlive === "function" ? options.pidIsAlive : pidIsAlive;
  const lockTimeoutMs = finiteNumber(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
  const staleLockMs = finiteNumber(options.staleLockMs, DEFAULT_STALE_LOCK_MS);
  const heartbeatMs = Math.max(25, finiteNumber(options.heartbeatMs, 5_000));
  const lockPollMs = Math.max(5, finiteNumber(options.lockPollMs, 100));
  const maxAttempts = Math.max(1, finiteNumber(options.maxAttempts, 4));
  // 端末全体の枠。false で使わない（呼び出し側が自分で枠を持つ場合だけ）。{ env, waitTimeoutMs } で差し替えられる。
  const machineSlots = options.machineSlots === false ? false : (options.machineSlots || {});
  const redactionSecrets = [
    ...(Array.isArray(options.redactionSecrets) ? options.redactionSecrets : []),
    ...(apiKey ? [apiKey] : []),
  ];
  const baseUrl = apiBase.replace(/\/+$/u, "");

  const isoNow = () => clock().toISOString();
  const keyDigest = (requestKey) => sha256(requestKey);
  const jobPath = (requestKey) => join(jobsDir, `${keyDigest(requestKey)}.json`);
  const lockPath = (requestKey) => join(locksDir, keyDigest(requestKey));

  /** Read-only server capability probe. It never creates or reserves a job. */
  async function probeAdapter(input, callOptions = {}) {
    const requested = normalizeAdapterProbe(input);
    const query = new URLSearchParams(requested);
    const url = `${baseUrl}/capabilities?${query.toString()}`;
    let response;
    try {
      response = await apiFetch(url, {
        method: "GET",
        signal: callOptions.signal,
        timeoutMs: callOptions.timeoutMs || 30_000,
      });
    } catch (error) {
      return {
        ok: false,
        status: "unreachable",
        ...requested,
        httpStatus: null,
        detail: redactSecrets(error?.message || String(error), redactionSecrets),
      };
    }
    if (!response?.ok) {
      return {
        ok: false,
        status: "unavailable",
        ...requested,
        httpStatus: finiteNumber(response?.status),
        detail: `BuzzAssist paid-media capability probe returned HTTP ${response?.status ?? "unknown"}.`,
      };
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      return {
        ok: false,
        status: "invalid-response",
        ...requested,
        httpStatus: finiteNumber(response.status),
        detail: "BuzzAssist paid-media capability probe returned undecodable JSON.",
      };
    }
    const source = payload?.adapter && typeof payload.adapter === "object" ? payload.adapter : payload;
    const echoed = {
      kind: nonEmptyString(source?.kind),
      provider: nonEmptyString(source?.provider),
      model: nonEmptyString(source?.model),
      adapterVersion: nonEmptyString(source?.adapterVersion ?? source?.adapter_version),
    };
    // A generic "ready" response is not evidence that the exact paid adapter
    // selected by the signed Channel Pack exists. Require the server to echo
    // every identity field before a caller may proceed to reservation.
    const identityMatches = Object.entries(requested).every(([key, value]) => echoed[key] === value);
    const available = source?.available === true || source?.status === "ready";
    return {
      ok: identityMatches && available,
      status: identityMatches && available ? "ready" : (identityMatches ? "unavailable" : "identity-mismatch"),
      ...requested,
      httpStatus: finiteNumber(response.status),
      serverVersion: nonEmptyString(payload?.serverVersion ?? payload?.version),
      detail: identityMatches && available
        ? "BuzzAssist paid-media server adapter is ready; no paid job was created."
        : (identityMatches
          ? "BuzzAssist paid-media server does not report this adapter as ready."
          : "BuzzAssist paid-media capability response does not match the requested adapter identity."),
    };
  }

  async function persist(job) {
    const safe = stripSecretFields(job, redactionSecrets);
    await writeJsonAtomic(jobPath(job.requestKey), safe);
    return safe;
  }

  async function findLocal(ref) {
    const requestKey = nonEmptyString(typeof ref === "string" ? ref : ref?.requestKey);
    if (requestKey) return readJson(jobPath(requestKey));
    const jobId = nonEmptyString(ref?.jobId);
    if (!jobId) throw new Error("A media job requestKey or jobId is required.");
    let names = [];
    try { names = await readdir(jobsDir); } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const job = await readJson(join(jobsDir, name));
      if (job?.jobId === jobId) return job;
    }
    return null;
  }

  async function acquire(requestKey) {
    await mkdir(locksDir, { recursive: true });
    const path = lockPath(requestKey);
    const ownerPath = join(path, "owner.json");
    const started = Date.now();
    for (;;) {
      try {
        await mkdir(path);
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        let owner = await readJson(ownerPath).catch(() => null);
        let heartbeatAt = Date.parse(owner?.heartbeatAt || "");
        if (!Number.isFinite(heartbeatAt)) {
          try { heartbeatAt = (await stat(path)).mtimeMs; } catch { heartbeatAt = Date.now(); }
        }
        // Never steal from a live process, even when a provider job has run
        // longer than fifteen minutes.  The heartbeat is evidence for dead
        // owner recovery, not permission to kill a living owner.
        if (!alive(Number(owner?.pid)) && Date.now() - heartbeatAt > staleLockMs) {
          await rm(path, { recursive: true, force: true });
          continue;
        }
        if (Date.now() - started > lockTimeoutMs) {
          throw new Error(`Timed out waiting for paid media request lock ${keyDigest(requestKey).slice(0, 12)}.`);
        }
        await sleepFn(lockPollMs);
      }
    }
    const owner = {
      pid: process.pid,
      requestKeyHash: keyDigest(requestKey),
      acquiredAt: isoNow(),
      heartbeatAt: isoNow(),
    };
    await writeJsonAtomic(ownerPath, owner);
    let heartbeatPromise = null;
    const timer = setInterval(() => {
      if (heartbeatPromise) return;
      owner.heartbeatAt = isoNow();
      heartbeatPromise = writeJsonAtomic(ownerPath, owner)
        .catch(() => {})
        .finally(() => { heartbeatPromise = null; });
    }, heartbeatMs);
    timer.unref?.();
    return async () => {
      clearInterval(timer);
      if (heartbeatPromise) await heartbeatPromise;
      await rm(path, { recursive: true, force: true });
    };
  }

  async function withLock(requestKey, callback) {
    const release = await acquire(requestKey);
    try { return await callback(); } finally { await release(); }
  }

  async function requestJson(url, requestOptions = {}, operation = "media-job") {
    const retries = [];
    let attempts = 0;
    try {
      const result = await withPaidApiRetry(async ({ attempt }) => {
        attempts = attempt;
        let response;
        try {
          response = await apiFetch(url, requestOptions);
        } catch (error) {
          if (requestOptions.signal?.aborted || error?.name === "AbortError") {
            throw ambiguousChargeError(
              `${operation} was aborted after transport began`,
              { cause: error, status: error?.status ?? null },
            );
          }
          if (error?.retryable === false || error?.nonRetryable === true
            || (Number(error?.status) >= 400 && Number(error?.status) < 500 && Number(error?.status) !== 429)) {
            throw new NonRetryablePaidApiError(
              `${operation} transport rejected the request${Number.isFinite(Number(error?.status)) ? ` (HTTP ${Number(error.status)})` : ""}.`,
              {
                cause: error,
                status: error?.status ?? null,
                charged: error?.charged === true ? true : (error?.charged === null ? null : false),
              },
            );
          }
          throw new RetryablePaidApiError(
            `${operation} network transport failed before a response.`,
            { cause: error, status: error?.status ?? null },
          );
        }
        if (!response?.ok) {
          // Provider bodies can echo submitted text as well as credentials. A
          // durable broker needs the status/retry class, never the raw body.
          throw await paidApiResponseError(response, {
            label: operation,
            secrets: redactionSecrets,
            bodyLimit: 0,
          });
        }
        if (typeof requestOptions.onAccepted === "function") {
          try {
            await requestOptions.onAccepted({
              status: response.status,
              jobId: header(response, "x-buzzassist-job-id") || header(response, "x-job-id"),
              providerJobId: header(response, "x-provider-job-id"),
              reservationId: header(response, "x-reservation-id"),
            });
          } catch (cause) {
            if (cause?.retryable === false) throw cause;
            throw afterSuccessFailure(
              `${operation} returned HTTP ${response.status} but its acceptance metadata could not be journaled`,
              { cause, status: response.status },
            );
          }
        }
        let payload;
        try {
          if (typeof response.json !== "function") throw new Error("response.json is unavailable");
          payload = await response.json();
        } catch (cause) {
          throw afterSuccessFailure(`${operation} returned HTTP ${response.status} but its JSON body could not be decoded`, {
            cause,
            status: response.status,
          });
        }
        if (!payload || typeof payload !== "object") {
          throw afterSuccessFailure(`${operation} returned HTTP ${response.status} without a job payload`, {
            status: response.status,
          });
        }
        return { response, payload };
      }, {
        label: operation,
        maxAttempts,
        secrets: redactionSecrets,
        sleepFn,
        onRetry: (event) => {
          const row = {
            operation,
            attempt: event.attempt,
            status: finiteNumber(event.status),
            backoffMs: event.backoffMs,
            error: redactSecrets(event.error, redactionSecrets),
          };
          retries.push(row);
          if (typeof options.onRetry === "function") options.onRetry(row);
          if (typeof requestOptions.onRetry === "function") requestOptions.onRetry(row);
        },
      });
      return { ...result, attempts, retries };
    } catch (error) {
      error.paidMediaAttempts = attempts;
      error.paidMediaRetries = retries;
      throw error;
    }
  }

  function assertIdentity(job, identity) {
    if (!job) return;
    if (job.inputHash !== identity.inputHash || job.identityHash !== identity.identityHash) {
      throw new Error(
        `requestKey ${identity.requestKey} is already bound to different paid-media input. `
        + "Use a new requestKey; silently rebinding it could return or charge for the wrong artifact.",
      );
    }
  }

  async function start(spec, callOptions = {}) {
    const normalized = normalizePaidMediaJobSpec(spec);
    return withLock(normalized.requestKey, async () => {
      const existing = await readJson(jobPath(normalized.requestKey));
      let job;
      if (existing) {
        assertIdentity(existing, normalized);
        const neverAcknowledged = nonEmptyString(existing.jobId).startsWith("local-")
          && !nonEmptyString(existing.providerJobId)
          && !nonEmptyString(existing.reservation?.reservationId);
        const locallyReservedBeforeDispatch = existing.status === "reserved" && neverAcknowledged;
        // 課金されていないと確定した（charged:false）失敗のうち、サーバーが一度も受理を返して
        // いないもの（jobId が local- のまま）。呼び出し側が明示したときだけ、同じ requestKey で
        // 送り直す。サーバーは requestKey を冪等キーにしているので、実は受け付けていたなら
        // その仕事が返り、二重に課金されない。受理を返した失敗（server jobId あり）は同じ鍵では
        // 再開できないので、ここでは送り直さない（呼び出し側が新しい鍵を選ぶ）。
        const replayableUnchargedFailure = callOptions.replayUnchargedLocalFailure === true
          && existing.status === "failed"
          && existing.error?.charged === false
          && neverAcknowledged;
        // A process can stop after the reservation intent is journaled but before
        // the first HTTP byte is sent. The caller supplies the same content-bound
        // spec again, so replay the *server-idempotent* start only for that exact
        // local-only state. Any accepted/remote state remains attach-only.
        if (!locallyReservedBeforeDispatch && !replayableUnchargedFailure) return existing;
        job = replayableUnchargedFailure
          ? await persist({ ...existing, status: "reserved", error: null, updatedAt: isoNow() })
          : existing;
      } else {
        job = await persist({
          version: PAID_MEDIA_JOB_VERSION,
          jobId: `local-${normalized.identityHash.slice(0, 24)}`,
          requestKey: normalized.requestKey,
          inputHash: normalized.inputHash,
          identityHash: normalized.identityHash,
          kind: normalized.kind,
          provider: normalized.provider,
          adapterVersion: normalized.adapterVersion,
          providerJobId: "",
          model: normalized.model,
          voiceId: normalized.voiceId,
          status: "reserved",
          reservation: { ...normalized.reservation, requestedAt: isoNow() },
          usage: normalizeUsage({}),
          result: null,
          attempts: { total: 0, retries: [] },
          error: null,
          createdAt: isoNow(),
          updatedAt: isoNow(),
        });
      }
      const body = {
        version: PAID_MEDIA_JOB_VERSION,
        requestKey: normalized.requestKey,
        inputHash: normalized.inputHash,
        kind: normalized.kind,
        provider: normalized.provider,
        model: normalized.model,
        voiceId: normalized.voiceId || undefined,
        input: normalized.input,
        output: normalized.output,
        adapterVersion: normalized.adapterVersion,
        reservation: normalized.reservation,
      };
      // 端末全体の枠（lib/machineSlots.mjs）。有料の音声・画像の同時数はプロセスの中だけで
      // 数えていたので、別のセッションが同時に投げると上限の何倍にもなっていた。枠を待つ間に
      // 失敗しても、まだ何も送っていない（ジョブは reserved のまま・charged=false）。
      const machineSlot = await acquireBrokerMachineSlot(normalized.kind, callOptions);
      try {
        const response = await requestJson(baseUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": normalized.requestKey,
            "x-buzzassist-request-key": normalized.requestKey,
          },
          body: JSON.stringify(body),
          signal: callOptions.signal,
          timeoutMs: callOptions.timeoutMs || 300_000,
          onRetry: callOptions.onRetry,
          onAccepted: async (accepted) => {
            job = await persist({
              ...job,
              jobId: accepted.jobId || job.jobId,
              providerJobId: accepted.providerJobId || job.providerJobId,
              status: "queued",
              reservation: {
                ...job.reservation,
                reservationId: accepted.reservationId || job.reservation.reservationId,
                status: accepted.reservationId ? "reserved" : job.reservation.status,
              },
              updatedAt: isoNow(),
            });
          },
        }, `paid media ${normalized.kind} start`);
        assertRemoteIdentity(response.payload, job, `paid media ${normalized.kind} start`);
        job = normalizeRemoteJob(response.payload, job);
        job.attempts = {
          total: response.attempts,
          retries: [...(job.attempts?.retries || []), ...response.retries],
        };
        // normalizeRemoteJob already replaced the local error with the server's
        // view. A 2xx envelope can still carry a terminal `failed` job whose
        // error (429 rate limit, 402 credits, charged=false) is what callers use
        // to park instead of fail; never blank it here.
        return persist(job);
      } catch (error) {
        const accepted = job.status === "queued" || Boolean(job.providerJobId);
        job = await persist({
          ...job,
          status: error?.charged === true || error?.charged === null || accepted
            ? "recovery-required"
            : "failed",
          attempts: {
            total: Number(job.attempts?.total || 0) + Number(error?.paidMediaAttempts || 0),
            retries: [...(job.attempts?.retries || []), ...(error?.paidMediaRetries || [])],
          },
          error: errorSummary(error, redactionSecrets, isoNow()),
          updatedAt: isoNow(),
        });
        error.job = paidMediaJobReceiptSummary(job);
        throw error;
      } finally {
        releaseMachineSlot(machineSlot);
      }
    });
  }

  async function acquireBrokerMachineSlot(kind, callOptions = {}) {
    const pool = machineSlotPoolForKind(kind);
    if (!pool || machineSlots === false) return null;
    return acquireMachineSlot(pool, {
      env: machineSlots?.env || process.env,
      signal: callOptions.signal,
      label: `paid-media ${kind}`,
      ...(Number.isFinite(Number(machineSlots?.waitTimeoutMs)) ? { waitTimeoutMs: Number(machineSlots.waitTimeoutMs) } : {}),
    });
  }

  async function remoteOperation(ref, operation, callOptions = {}) {
    const local = await findLocal(ref);
    if (!local) throw new Error("Paid media job is not present in the local durable journal.");
    return withLock(local.requestKey, async () => {
      let job = await readJson(jobPath(local.requestKey));
      const remoteId = nonEmptyString(job.jobId).startsWith("local-") ? "" : nonEmptyString(job.jobId);
      let url;
      let method;
      let body;
      if (operation === "get") {
        method = "GET";
        url = remoteId
          ? `${baseUrl}/${encodeURIComponent(remoteId)}`
          : `${baseUrl}/by-request-key/${encodeURIComponent(job.requestKey)}`;
      } else if (operation === "recover") {
        method = "POST";
        url = `${baseUrl}/recover`;
        body = JSON.stringify({ requestKey: job.requestKey, inputHash: job.inputHash, jobId: remoteId || undefined });
      } else {
        if (!remoteId) {
          throw new Error(`${operation} requires a server job id; use recover first.`);
        }
        method = "POST";
        url = `${baseUrl}/${encodeURIComponent(remoteId)}/${operation}`;
        body = JSON.stringify({ requestKey: job.requestKey, inputHash: job.inputHash });
      }
      try {
        const response = await requestJson(url, {
          method,
          headers: method === "POST" ? {
            "content-type": "application/json",
            "idempotency-key": `${job.requestKey}:${operation}`,
          } : {},
          body,
          signal: callOptions.signal,
          timeoutMs: callOptions.timeoutMs || 60_000,
          onRetry: callOptions.onRetry,
          onAccepted: async (accepted) => {
            if (accepted.providerJobId || accepted.reservationId || accepted.jobId) {
              job = await persist({
                ...job,
                jobId: accepted.jobId || job.jobId,
                providerJobId: accepted.providerJobId || job.providerJobId,
                reservation: {
                  ...job.reservation,
                  reservationId: accepted.reservationId || job.reservation?.reservationId,
                },
                updatedAt: isoNow(),
              });
            }
          },
        }, `paid media job ${operation}`);
        assertRemoteIdentity(response.payload, job, `paid media job ${operation}`);
        const updated = normalizeRemoteJob(response.payload, job);
        updated.attempts = {
          total: Number(job.attempts?.total || 0) + response.attempts,
          retries: [...(job.attempts?.retries || []), ...response.retries],
        };
        return persist(updated);
      } catch (error) {
        job = await persist({
          ...job,
          status: error?.charged === true || error?.charged === null ? "recovery-required" : job.status,
          attempts: {
            total: Number(job.attempts?.total || 0) + Number(error?.paidMediaAttempts || 0),
            retries: [...(job.attempts?.retries || []), ...(error?.paidMediaRetries || [])],
          },
          error: errorSummary(error, redactionSecrets, isoNow()),
          updatedAt: isoNow(),
        });
        error.job = paidMediaJobReceiptSummary(job);
        throw error;
      }
    });
  }

  const get = (ref, callOptions) => remoteOperation(ref, "get", callOptions);
  const cancel = (ref, callOptions) => remoteOperation(ref, "cancel", callOptions);
  const resume = (ref, callOptions) => remoteOperation(ref, "resume", callOptions);
  const recover = (ref, callOptions) => remoteOperation(ref, "recover", callOptions);

  async function waitFor(ref, callOptions = {}) {
    const timeoutMs = finiteNumber(callOptions.timeoutMs, 15 * 60_000);
    const pollIntervalMs = Math.max(10, finiteNumber(callOptions.pollIntervalMs, 2_000));
    const started = Date.now();
    let job = await findLocal(ref);
    if (!job) throw new Error("Paid media job is not present in the local durable journal.");
    while (!TERMINAL_STATUSES.has(job.status) && job.status !== "recovery-required") {
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Paid media job ${job.jobId} did not finish before the local wait timeout.`);
      }
      await sleepFn(pollIntervalMs);
      job = await get({ requestKey: job.requestKey }, callOptions);
      if (typeof callOptions.onStatus === "function") {
        callOptions.onStatus({
          jobId: job.jobId,
          providerJobId: job.providerJobId,
          status: job.status,
        });
      }
    }
    return job;
  }

  return Object.freeze({
    stateDir,
    probeAdapter,
    start,
    get,
    cancel,
    resume,
    recover,
    waitFor,
    getLocal: findLocal,
    receipt: paidMediaJobReceiptSummary,
  });
}

/** Download the completed artifact without ever resubmitting its paid job. */
export async function readPaidMediaJobArtifact(job, options = {}) {
  if (job?.status !== "completed") throw new Error("Paid media artifact is available only for a completed job.");
  const artifact = job.result?.artifact;
  if (!artifact?.url) throw new Error("Completed paid media job has no artifact URL.");
  const descriptor = validateArtifactDownloadDescriptor(artifact, options);
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable for the paid media artifact download.");
  let response;
  try {
    response = await fetchImpl(descriptor.url.href, {
      method: "GET",
      redirect: "error",
      signal: options.signal,
    });
  } catch (cause) {
    throw new NonRetryablePaidApiError(
      "Paid media artifact download failed before a response. Recover the existing job; do not resubmit generation.",
      { cause, charged: true },
    );
  }
  if (!response?.ok) {
    throw new NonRetryablePaidApiError(
      `Paid media artifact download failed with HTTP ${response?.status}. Recover the existing job; do not resubmit generation.`,
      { status: response?.status ?? null, charged: true },
    );
  }
  const responseUrl = nonEmptyString(response.url);
  if (responseUrl && normalizedOrigin(responseUrl) !== descriptor.url.origin) {
    throw afterSuccessFailure("Paid media artifact response crossed an origin boundary", { status: response.status });
  }
  const declaredLength = responseHeader(response, "content-length");
  if (declaredLength) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength !== descriptor.expectedBytes || parsedLength > descriptor.maxBytes) {
      throw afterSuccessFailure("Paid media artifact Content-Length does not match the completed job", { status: response.status });
    }
  }
  const responseMimeType = responseHeader(response, "content-type").split(";", 1)[0].trim().toLowerCase();
  if (!responseMimeType || responseMimeType !== descriptor.expectedMimeType) {
    throw afterSuccessFailure("Paid media artifact Content-Type does not match the completed job", { status: response.status });
  }
  let bytes;
  try {
    bytes = await readArtifactResponseBytes(response, descriptor);
  } catch (cause) {
    throw afterSuccessFailure("Paid media artifact returned 2xx but its body could not be decoded", {
      cause,
      status: response.status,
    });
  }
  if (bytes.length === 0) {
    throw afterSuccessFailure("Paid media artifact returned 2xx with an empty body", { status: response.status });
  }
  if (bytes.length !== descriptor.expectedBytes) {
    throw afterSuccessFailure("Paid media artifact byte count does not match the completed job", { status: response.status });
  }
  if (sha256(bytes) !== descriptor.expectedSha256) {
    throw afterSuccessFailure("Paid media artifact SHA-256 does not match the completed job", { status: response.status });
  }
  return bytes;
}

// Stateless convenience exports for callers that do not need to retain a
// broker object.  The durable journal still prevents duplicate submission.
export async function startPaidMediaJob(spec, options = {}) {
  return createPaidMediaJobBroker(options).start(spec, options);
}

export async function getPaidMediaJob(ref, options = {}) {
  return createPaidMediaJobBroker(options).get(ref, options);
}

export async function cancelPaidMediaJob(ref, options = {}) {
  return createPaidMediaJobBroker(options).cancel(ref, options);
}

export async function resumePaidMediaJob(ref, options = {}) {
  return createPaidMediaJobBroker(options).resume(ref, options);
}

export async function recoverPaidMediaJob(ref, options = {}) {
  return createPaidMediaJobBroker(options).recover(ref, options);
}

/** Stateless, read-only doctor probe for one exact server-side adapter. */
export async function probePaidMediaJobAdapter(spec, options = {}) {
  return createPaidMediaJobBroker(options).probeAdapter(spec, options);
}
