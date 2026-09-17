import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { withCanvasFileLock } from "./canvasFileLock.mjs";
import { readJsonIfExists, resolveCanvasDir, writeJsonAtomic } from "./canvasScene.mjs";

export const CANVAS_RUN_SCHEMA_VERSION = 1;
export const CANVAS_RUN_STATE_DIRECTORY = "harness-runs";

export const CANVAS_RUN_STATUSES = Object.freeze([
  "queued",
  "running",
  "failed",
  "awaiting-approval",
  "complete",
  "cancelled",
]);

export const CANVAS_JOB_STATUSES = Object.freeze([
  "pending",
  "queued",
  "running",
  "failed",
  "awaiting-approval",
  "approved",
  "rejected",
  "skipped",
  "complete",
  "cancelled",
]);

export const CANVAS_ARTIFACT_KINDS = Object.freeze([
  "image-candidate",
  "image-selected",
  "image-reference",
  "audio",
  "subtitle",
  "bgm",
  "preview-mp4",
  "final-mp4",
  "audit-report",
  "contact-sheet",
  "signoff",
  "other",
]);

const HASH_PATTERN = /^(?:sha256:)?([a-f0-9]{64})$/iu;
const ENTITY_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/u;
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/u;
const SENSITIVE_FIELD_PATTERN = /^(?:api[-_]?key|authorization|credential|password|private[-_]?key|secret|token)$/iu;

export class CanvasRunValidationError extends Error {
  constructor(issues) {
    super(`Canvas Harness Run is invalid:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "CanvasRunValidationError";
    this.issues = issues;
  }
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredString(value, field, issues) {
  const normalized = stringValue(value);
  if (!normalized) issues.push(`${field} is required`);
  return normalized ?? "";
}

function normalizeEntityId(value, field, issues) {
  const id = requiredString(value, field, issues);
  if (id && !ENTITY_ID_PATTERN.test(id)) {
    issues.push(`${field} must match ${ENTITY_ID_PATTERN}`);
  }
  return id;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  if (value === undefined) return "null";
  return JSON.stringify(value);
}

export function sha256Hex(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return createHash("sha256").update(bytes).digest("hex");
}

export function normalizeSha256(value, field = "sha256", issues = []) {
  const raw = stringValue(value);
  const match = raw?.match(HASH_PATTERN);
  if (!match) {
    issues.push(`${field} must be a SHA-256 digest`);
    return "";
  }
  return `sha256:${match[1].toLowerCase()}`;
}

export function stableCanvasRunId(runId, kind, logicalId) {
  const digest = sha256Hex(`buzzassist-canvas-run:v${CANVAS_RUN_SCHEMA_VERSION}:${runId}:${kind}:${logicalId}`);
  return `bar_${digest.slice(0, 24)}`;
}

export function stableCanvasArtifactId(runId, artifact) {
  const explicit = stringValue(artifact?.id);
  const logical = explicit || `${artifact?.kind || "other"}:${artifact?.sha256 || artifact?.path || artifact?.uri || "artifact"}`;
  return `artifact_${sha256Hex(`buzzassist-artifact:v1:${runId}:${logical}`).slice(0, 24)}`;
}

function findSensitiveFields(value, path = "$", found = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return found;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSensitiveFields(item, `${path}[${index}]`, found, seen));
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (SENSITIVE_FIELD_PATTERN.test(key)) found.push(childPath);
    findSensitiveFields(child, childPath, found, seen);
  }
  return found;
}

function normalizeStatus(value, allowed, fallback, field, issues) {
  const status = stringValue(value) || fallback;
  if (!allowed.includes(status)) issues.push(`${field} has unsupported status: ${status}`);
  return status;
}

function normalizeVersionRecord(value, field, issues, { versionRequired = true } = {}) {
  if (!plainObject(value)) {
    issues.push(`${field} is required`);
    return { id: "", version: "", sha256: "" };
  }
  const id = normalizeEntityId(value.id, `${field}.id`, issues);
  const version = versionRequired
    ? requiredString(value.version, `${field}.version`, issues)
    : (stringValue(value.version) || "unversioned");
  const sha256 = normalizeSha256(value.sha256, `${field}.sha256`, issues);
  return {
    id,
    version,
    sha256,
    ...(stringValue(value.label) ? { label: stringValue(value.label) } : {}),
  };
}

function normalizeScript(value, issues) {
  if (!plainObject(value)) {
    issues.push("script is required");
    return { id: "script", language: "ja", text: "", sha256: "" };
  }
  const text = typeof value.text === "string" ? value.text : "";
  const suppliedHash = stringValue(value.sha256);
  const computedHash = text ? `sha256:${sha256Hex(text)}` : "";
  let sha256 = suppliedHash
    ? normalizeSha256(suppliedHash, "script.sha256", issues)
    : computedHash;
  if (!sha256) issues.push("script.text or script.sha256 is required");
  if (computedHash && sha256 && computedHash !== sha256) {
    issues.push("script.sha256 does not match script.text");
  }
  return {
    id: normalizeEntityId(value.id || "script", "script.id", issues),
    language: stringValue(value.language) || "ja",
    title: stringValue(value.title) || "入力台本",
    text,
    sha256,
    ...(stringValue(value.path) ? { path: stringValue(value.path) } : {}),
  };
}

function normalizeNeeds(value, field, issues) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push(`${field} must be an array`);
    return [];
  }
  return [...new Set(value.map((item, index) => normalizeEntityId(item, `${field}[${index}]`, issues)).filter(Boolean))];
}

function normalizeJobs(value, issues) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push("jobs must be an array");
    return [];
  }
  const ids = new Set();
  const jobs = value.map((job, index) => {
    const field = `jobs[${index}]`;
    if (!plainObject(job)) {
      issues.push(`${field} must be an object`);
      return { id: `invalid-${index}`, title: "", status: "pending", needs: [] };
    }
    const id = normalizeEntityId(job.id, `${field}.id`, issues);
    if (ids.has(id)) issues.push(`${field}.id is duplicated: ${id}`);
    ids.add(id);
    return {
      id,
      title: stringValue(job.title) || id,
      kind: stringValue(job.kind) || "job",
      status: normalizeStatus(job.status, CANVAS_JOB_STATUSES, "pending", `${field}.status`, issues),
      needs: normalizeNeeds(job.needs, `${field}.needs`, issues),
      ...(stringValue(job.detail) ? { detail: stringValue(job.detail) } : {}),
      ...(Number.isFinite(job.progress) ? { progress: Math.max(0, Math.min(1, Number(job.progress))) } : {}),
    };
  });
  for (const [index, job] of jobs.entries()) {
    for (const dependency of job.needs) {
      if (!ids.has(dependency)) issues.push(`jobs[${index}].needs references missing job: ${dependency}`);
      if (dependency === job.id) issues.push(`jobs[${index}] cannot depend on itself`);
    }
  }
  return jobs;
}

function normalizeScenes(value, jobs, issues) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push("scenes must be an array");
    return [];
  }
  const jobIds = new Set(jobs.map((job) => job.id));
  const ids = new Set();
  return value.map((scene, index) => {
    const field = `scenes[${index}]`;
    if (!plainObject(scene)) {
      issues.push(`${field} must be an object`);
      return { id: `invalid-${index}`, title: "", jobIds: [] };
    }
    const id = normalizeEntityId(scene.id, `${field}.id`, issues);
    if (ids.has(id)) issues.push(`${field}.id is duplicated: ${id}`);
    ids.add(id);
    const sceneJobIds = normalizeNeeds(scene.jobIds, `${field}.jobIds`, issues);
    sceneJobIds.forEach((jobId) => {
      if (!jobIds.has(jobId)) issues.push(`${field}.jobIds references missing job: ${jobId}`);
    });
    return {
      id,
      title: stringValue(scene.title) || id,
      status: normalizeStatus(scene.status, CANVAS_JOB_STATUSES, "pending", `${field}.status`, issues),
      jobIds: sceneJobIds,
      ...(Number.isInteger(scene.index) ? { index: scene.index } : { index }),
    };
  });
}

function normalizeArtifacts(value, runId, jobs, issues) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push("artifacts must be an array");
    return [];
  }
  const jobIds = new Set(jobs.map((job) => job.id));
  const ids = new Set();
  return value.map((artifact, index) => {
    const field = `artifacts[${index}]`;
    if (!plainObject(artifact)) {
      issues.push(`${field} must be an object`);
      return { id: `invalid-${index}`, kind: "other", title: "", sha256: "", status: "complete" };
    }
    const kind = stringValue(artifact.kind) || "other";
    if (!CANVAS_ARTIFACT_KINDS.includes(kind)) issues.push(`${field}.kind is unsupported: ${kind}`);
    const sha256 = normalizeSha256(artifact.sha256, `${field}.sha256`, issues);
    const stableId = stableCanvasArtifactId(runId, { ...artifact, kind, sha256 });
    const id = stringValue(artifact.id)
      ? normalizeEntityId(artifact.id, `${field}.id`, issues)
      : stableId;
    if (ids.has(id)) issues.push(`${field}.id is duplicated: ${id}`);
    ids.add(id);
    const producerJobId = stringValue(artifact.producerJobId);
    if (producerJobId && !jobIds.has(producerJobId)) {
      issues.push(`${field}.producerJobId references missing job: ${producerJobId}`);
    }
    return {
      id,
      stableId,
      kind,
      title: stringValue(artifact.title) || id,
      sha256,
      status: normalizeStatus(artifact.status, CANVAS_JOB_STATUSES, "complete", `${field}.status`, issues),
      ...(producerJobId ? { producerJobId } : {}),
      ...(stringValue(artifact.path) ? { path: stringValue(artifact.path) } : {}),
      ...(stringValue(artifact.uri) ? { uri: stringValue(artifact.uri) } : {}),
      ...(stringValue(artifact.canvasAssetUrl) ? { canvasAssetUrl: stringValue(artifact.canvasAssetUrl) } : {}),
      ...(stringValue(artifact.mimeType) ? { mimeType: stringValue(artifact.mimeType) } : {}),
      ...(Number.isFinite(artifact.durationSeconds) ? { durationSeconds: Number(artifact.durationSeconds) } : {}),
    };
  });
}

function normalizeEvidenceRecords(value, fieldName, issues) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push(`${fieldName} must be an array`);
    return [];
  }
  const ids = new Set();
  return value.map((record, index) => {
    const field = `${fieldName}[${index}]`;
    if (!plainObject(record)) {
      issues.push(`${field} must be an object`);
      return { id: `invalid-${index}`, title: "", status: "failed", evidenceSha256: "" };
    }
    const id = normalizeEntityId(record.id, `${field}.id`, issues);
    if (ids.has(id)) issues.push(`${field}.id is duplicated: ${id}`);
    ids.add(id);
    const status = normalizeStatus(
      record.status,
      ["pending", "running", "failed", "awaiting-approval", "approved", "rejected", "skipped", "complete"],
      "pending",
      `${field}.status`,
      issues,
    );
    const evidenceRequired = !["pending", "running", "awaiting-approval"].includes(status);
    const evidenceSha256 = stringValue(record.evidenceSha256)
      ? normalizeSha256(record.evidenceSha256, `${field}.evidenceSha256`, issues)
      : "";
    if (evidenceRequired && !evidenceSha256) issues.push(`${field}.evidenceSha256 is required for ${status}`);
    return {
      id,
      title: stringValue(record.title) || id,
      status,
      evidenceSha256,
      ...(stringValue(record.reviewer) ? { reviewer: stringValue(record.reviewer) } : {}),
      ...(stringValue(record.detail) ? { detail: stringValue(record.detail) } : {}),
    };
  });
}

function normalizeKnownIssues(value, issues) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push("knownRemainingIssues must be an array");
    return [];
  }
  return value.map((item, index) => {
    if (typeof item === "string" && item.trim()) return { id: `issue-${index + 1}`, text: item.trim() };
    if (!plainObject(item)) {
      issues.push(`knownRemainingIssues[${index}] must be a string or object`);
      return { id: `issue-${index + 1}`, text: "" };
    }
    return {
      id: normalizeEntityId(item.id || `issue-${index + 1}`, `knownRemainingIssues[${index}].id`, issues),
      text: requiredString(item.text, `knownRemainingIssues[${index}].text`, issues),
    };
  });
}

function assertAcyclicJobs(jobs, issues) {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id, trail) => {
    if (visiting.has(id)) {
      issues.push(`jobs contain a dependency cycle: ${[...trail, id].join(" -> ")}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.needs ?? []) visit(dependency, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  };
  jobs.forEach((job) => visit(job.id, []));
}

export function normalizeCanvasRun(input) {
  const issues = [];
  if (!plainObject(input)) throw new CanvasRunValidationError(["run must be an object"]);
  const sensitiveFields = findSensitiveFields(input);
  sensitiveFields.forEach((field) => issues.push(`${field} is sensitive and must not be projected to Canvas`));

  const runId = requiredString(input.runId, "runId", issues);
  if (runId && !RUN_ID_PATTERN.test(runId)) issues.push(`runId must match ${RUN_ID_PATTERN}`);
  const jobs = normalizeJobs(input.jobs, issues);
  assertAcyclicJobs(jobs, issues);
  const artifacts = normalizeArtifacts(input.artifacts, runId, jobs, issues);
  const normalized = {
    schemaVersion: CANVAS_RUN_SCHEMA_VERSION,
    runId,
    revision: Number.isSafeInteger(input.revision) && input.revision >= 0 ? input.revision : 0,
    status: normalizeStatus(input.status, CANVAS_RUN_STATUSES, "queued", "status", issues),
    title: stringValue(input.title) || runId,
    updatedAt: stringValue(input.updatedAt) || null,
    script: normalizeScript(input.script, issues),
    scenes: normalizeScenes(input.scenes, jobs, issues),
    jobs,
    artifacts,
    audits: normalizeEvidenceRecords(input.audits, "audits", issues),
    signoffs: normalizeEvidenceRecords(input.signoffs, "signoffs", issues),
    knownRemainingIssues: normalizeKnownIssues(input.knownRemainingIssues, issues),
    versions: {
      harness: normalizeVersionRecord(input.versions?.harness, "versions.harness", issues),
      skills: Array.isArray(input.versions?.skills)
        ? input.versions.skills.map((value, index) => normalizeVersionRecord(value, `versions.skills[${index}]`, issues))
        : (issues.push("versions.skills must be an array"), []),
      channelPack: normalizeVersionRecord(input.versions?.channelPack, "versions.channelPack", issues),
      providers: Array.isArray(input.versions?.providers)
        ? input.versions.providers.map((value, index) => normalizeVersionRecord(value, `versions.providers[${index}]`, issues, { versionRequired: false }))
        : (issues.push("versions.providers must be an array"), []),
    },
  };

  if (normalized.status === "complete" && normalized.knownRemainingIssues.length > 0) {
    issues.push("status cannot be complete while knownRemainingIssues is non-empty");
  }
  if (normalized.status === "complete" && normalized.signoffs.length === 0) {
    issues.push("status cannot be complete without an evidence-bound signoff");
  }
  if (normalized.status === "complete" && normalized.signoffs.some((record) => record.status !== "approved" && record.status !== "complete")) {
    issues.push("status cannot be complete while a signoff is not approved/complete");
  }
  if (issues.length > 0) throw new CanvasRunValidationError(issues);
  return normalized;
}

export function canvasRunFingerprint(run) {
  return `sha256:${sha256Hex(canonicalJson(normalizeCanvasRun(run)))}`;
}

export function resolveCanvasRunStateFile(args = {}, runId) {
  const normalizedRunId = stringValue(runId);
  if (!normalizedRunId || !RUN_ID_PATTERN.test(normalizedRunId)) {
    throw new CanvasRunValidationError(["runId is required to resolve Canvas state"]);
  }
  return join(resolveCanvasDir(args), CANVAS_RUN_STATE_DIRECTORY, normalizedRunId, "canvas-run.json");
}

export async function saveCanvasRunState(args = {}, input) {
  const run = normalizeCanvasRun(input);
  const stateFile = resolveCanvasRunStateFile(args, run.runId);
  const payload = { ...run, runFingerprint: canvasRunFingerprint(run) };
  await withCanvasFileLock(stateFile, () => writeJsonAtomic(stateFile, payload));
  return { run: payload, stateFile };
}

export async function loadCanvasRunState(args = {}, runId) {
  const stateFile = resolveCanvasRunStateFile(args, runId);
  const value = await readJsonIfExists(stateFile, null);
  if (!value) return null;
  const { runFingerprint: recordedFingerprint, ...runValue } = value;
  const run = normalizeCanvasRun(runValue);
  const actualFingerprint = canvasRunFingerprint(run);
  if (recordedFingerprint && recordedFingerprint !== actualFingerprint) {
    throw new CanvasRunValidationError([`stored run fingerprint does not match ${resolve(stateFile)}`]);
  }
  return { ...run, runFingerprint: actualFingerprint };
}

export function canvasRunSchema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://buzzassist.local/schemas/canvas-harness-run-v1.json",
    title: "BuzzAssist Canvas Harness Run",
    type: "object",
    required: [
      "schemaVersion",
      "runId",
      "revision",
      "status",
      "title",
      "updatedAt",
      "script",
      "scenes",
      "jobs",
      "artifacts",
      "audits",
      "signoffs",
      "knownRemainingIssues",
      "versions",
    ],
    properties: {
      schemaVersion: { const: CANVAS_RUN_SCHEMA_VERSION },
      runId: { type: "string", pattern: RUN_ID_PATTERN.source },
      revision: { type: "integer", minimum: 0 },
      status: { enum: CANVAS_RUN_STATUSES },
      title: { type: "string", minLength: 1 },
      updatedAt: { type: ["string", "null"] },
      script: { $ref: "#/$defs/script" },
      scenes: { type: "array", items: { $ref: "#/$defs/scene" } },
      jobs: { type: "array", items: { $ref: "#/$defs/job" } },
      artifacts: { type: "array", items: { $ref: "#/$defs/artifact" } },
      audits: { type: "array", items: { $ref: "#/$defs/evidence" } },
      signoffs: { type: "array", items: { $ref: "#/$defs/evidence" } },
      knownRemainingIssues: { type: "array", items: { $ref: "#/$defs/knownIssue" } },
      versions: {
        type: "object",
        required: ["harness", "skills", "channelPack", "providers"],
        properties: {
          harness: { $ref: "#/$defs/versionRecord" },
          skills: { type: "array", items: { $ref: "#/$defs/versionRecord" } },
          channelPack: { $ref: "#/$defs/versionRecord" },
          providers: { type: "array", items: { $ref: "#/$defs/versionRecord" } },
        },
        additionalProperties: false,
      },
    },
    allOf: [
      {
        if: { properties: { status: { const: "complete" } }, required: ["status"] },
        then: {
          properties: {
            knownRemainingIssues: { maxItems: 0 },
            signoffs: {
              minItems: 1,
              items: {
                allOf: [
                  { $ref: "#/$defs/evidence" },
                  { properties: { status: { enum: ["approved", "complete"] } } },
                ],
              },
            },
          },
        },
      },
    ],
    $defs: {
      entityId: { type: "string", pattern: ENTITY_ID_PATTERN.source },
      sha256: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
      script: {
        type: "object",
        required: ["id", "language", "title", "text", "sha256"],
        properties: {
          id: { $ref: "#/$defs/entityId" },
          language: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          text: { type: "string" },
          sha256: { $ref: "#/$defs/sha256" },
          path: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
      job: {
        type: "object",
        required: ["id", "title", "kind", "status", "needs"],
        properties: {
          id: { $ref: "#/$defs/entityId" },
          title: { type: "string", minLength: 1 },
          kind: { type: "string", minLength: 1 },
          status: { enum: CANVAS_JOB_STATUSES },
          needs: { type: "array", uniqueItems: true, items: { $ref: "#/$defs/entityId" } },
          detail: { type: "string", minLength: 1 },
          progress: { type: "number", minimum: 0, maximum: 1 },
        },
        additionalProperties: false,
      },
      scene: {
        type: "object",
        required: ["id", "title", "status", "jobIds", "index"],
        properties: {
          id: { $ref: "#/$defs/entityId" },
          title: { type: "string", minLength: 1 },
          status: { enum: CANVAS_JOB_STATUSES },
          jobIds: { type: "array", uniqueItems: true, items: { $ref: "#/$defs/entityId" } },
          index: { type: "integer" },
        },
        additionalProperties: false,
      },
      artifact: {
        type: "object",
        required: ["id", "stableId", "kind", "title", "sha256", "status"],
        properties: {
          id: { $ref: "#/$defs/entityId" },
          stableId: { type: "string", pattern: "^artifact_[a-f0-9]{24}$" },
          kind: { enum: CANVAS_ARTIFACT_KINDS },
          title: { type: "string", minLength: 1 },
          sha256: { $ref: "#/$defs/sha256" },
          status: { enum: CANVAS_JOB_STATUSES },
          producerJobId: { $ref: "#/$defs/entityId" },
          path: { type: "string", minLength: 1 },
          uri: { type: "string", minLength: 1 },
          canvasAssetUrl: { type: "string", minLength: 1 },
          mimeType: { type: "string", minLength: 1 },
          durationSeconds: { type: "number" },
        },
        additionalProperties: false,
      },
      evidence: {
        type: "object",
        required: ["id", "title", "status", "evidenceSha256"],
        properties: {
          id: { $ref: "#/$defs/entityId" },
          title: { type: "string", minLength: 1 },
          status: {
            enum: ["pending", "running", "failed", "awaiting-approval", "approved", "rejected", "skipped", "complete"],
          },
          evidenceSha256: {
            anyOf: [
              { const: "" },
              { $ref: "#/$defs/sha256" },
            ],
          },
          reviewer: { type: "string", minLength: 1 },
          detail: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
      knownIssue: {
        type: "object",
        required: ["id", "text"],
        properties: {
          id: { $ref: "#/$defs/entityId" },
          text: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
      versionRecord: {
        type: "object",
        required: ["id", "version", "sha256"],
        properties: {
          id: { $ref: "#/$defs/entityId" },
          version: { type: "string", minLength: 1 },
          sha256: { $ref: "#/$defs/sha256" },
          label: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  };
}
