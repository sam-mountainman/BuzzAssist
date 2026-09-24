import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { withCanvasFileLock } from "./canvasFileLock.mjs";
import {
  CANVAS_RUN_PROJECTION_TAG,
  buildCanvasRunProjection,
} from "./canvasRunProjection.mjs";
import {
  readJsonIfExists,
  resolveCanvasFile,
  writeJsonAtomic,
} from "./canvasScene.mjs";
import {
  loadCanvasRunState,
  resolveCanvasRunStateFile,
  sha256Hex,
} from "./canvasRunState.mjs";
import { readVideoHarnessJob, videoHarnessJobPath } from "./videoHarnessJob.mjs";
import {
  blockProposalIfUnsafe,
  buildProposal,
  captureLearningProposal,
  ledgerPathFor,
} from "../scripts/harness-learn.mjs";
import { HARNESS_LEARNING_ROUTES, PLATFORM_LEARNING_TARGETS } from "./harnessLearningTargets.mjs";

export const CANVAS_FEEDBACK_COLLECTION_VERSION = "buzzassist-canvas-feedback-collection-v1";
export const CANVAS_FEEDBACK_STATE_VERSION = "buzzassist-canvas-feedback-state-v1";

const MAX_COMMENT_CHARACTERS = 800;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const PROPOSAL_ID_PATTERN = /^[a-f0-9]{12}$/u;
const FEEDBACK_FIELD_NAMES = Object.freeze([
  "buzzassistDecision",
  "buzzassistComment",
  "buzzassistFeedbackRevision",
  "buzzassistFeedbackTarget",
  "buzzassistFeedbackGeneralize",
]);
const FEEDBACK_FIELD_SET = new Set(FEEDBACK_FIELD_NAMES);
const DECISION_ALIASES = new Map([
  ["accept", "accept"],
  ["accepted", "accept"],
  ["approved", "accept"],
  ["採択", "accept"],
  ["reject", "reject"],
  ["rejected", "reject"],
  ["却下", "reject"],
  ["comment", "comment"],
  ["コメント", "comment"],
]);
// 既定の宛先（Channel Pack 優先）は Receipt からの自動捕捉と同じ定義を読む。
const PLATFORM_TARGETS = new Set(PLATFORM_LEARNING_TARGETS);
const HARNESS_ROUTES = HARNESS_LEARNING_ROUTES;
const ENTITY_LABELS = Object.freeze({
  run: "Harness Run",
  versions: "版・指紋",
  script: "台本カード",
  scene: "scene/cut",
  job: "production job",
  artifact: "成果物",
  audit: "監査",
  signoff: "独立レビュー",
  issues: "knownRemainingIssues",
});
const SECRET_PATTERN = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:sk|rk|pk|ghp|github_pat)_[A-Za-z0-9_-]{8,}|\bAKIA[A-Z0-9]{16}\b|(?:api[-_ ]?key|authorization|credential|password|private[-_ ]?key|secret|signing[-_ ]?key|token|trusted[-_ ]?key)\s*[:=]\s*\S+)/iu;
// Canvas commentは別machine/公開台帳へ移る可能性があるため、POSIXだけでなく
// Windowsのdrive区切り（`C:\\...` / `C:/...`）とUNCも端末固有pathとして拒否する。
const ABSOLUTE_PATH_PATTERN = /(?:^|[\s("'])(?:file:\/\/|\/(?!\/)[A-Za-z0-9._-]+(?:\/[^\s)"']+)+|[A-Za-z]:[\\\/][^\s)"']+|\\\\[^\\\/\s)"']+[\\\/][^\s)"']+|\/\/[^\/\s)"']+\/[^\s)"']+)/iu;
const CHANNEL_PACK_BODY_PATTERN = /(?:^\s*[\[{][\s\S]*[\]}]\s*$|[\[{][\s\S]{0,800}(?:"?(?:channelPack|payload|stylePrompt|negativePrompt|voiceId|signerKeyId|trustedPublicKeyId|runtime|forbidden)"?\s*:)|(?:^|\n)\s*(?:(?:channelPack|payload|runtime|voice|image|bgm)\.[A-Za-z0-9_.-]+|(?:channelPack|payload|runtime|voice|image|bgm|stylePrompt|negativePrompt))\s*:\s*\S*)/iu;

export class CanvasFeedbackValidationError extends Error {
  constructor(message, code = "CANVAS_FEEDBACK_INVALID") {
    super(message);
    this.name = "CanvasFeedbackValidationError";
    this.code = code;
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizedHash(value) {
  const digest = String(value || "").trim().replace(/^sha256:/iu, "").toLowerCase();
  return /^[a-f0-9]{64}$/u.test(digest) ? `sha256:${digest}` : "";
}

function stableDigest(value) {
  return `sha256:${sha256Hex(value)}`;
}

function fail(message, code) {
  throw new CanvasFeedbackValidationError(message, code);
}

function feedbackFieldsPresent(customData) {
  return plainObject(customData) && FEEDBACK_FIELD_NAMES.some((field) => hasOwn(customData, field));
}

function validateFeedbackFieldNames(customData) {
  for (const key of Object.keys(customData)) {
    if (/^buzzassistFeedback/u.test(key) && !FEEDBACK_FIELD_SET.has(key)) {
      fail("未対応のCanvas feedback fieldがある。", "CANVAS_FEEDBACK_SCHEMA_INVALID");
    }
  }
}

function normalizeDecision(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") fail("buzzassistDecisionは文字列で指定すること。", "CANVAS_FEEDBACK_SCHEMA_INVALID");
  const normalized = DECISION_ALIASES.get(value.trim().toLowerCase());
  if (!normalized) {
    fail("buzzassistDecisionは accept / reject / comment（または採択 / 却下 / コメント）のいずれかにすること。", "CANVAS_FEEDBACK_SCHEMA_INVALID");
  }
  return normalized;
}

function normalizedSearchText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, "");
}

function containsScriptExcerpt(comment, scriptText) {
  const candidate = normalizedSearchText(comment);
  const script = normalizedSearchText(scriptText);
  if (candidate.length < 20 || script.length < 20) return false;
  if (script.includes(candidate)) return true;
  const windowLength = 32;
  if (candidate.length < windowLength) return false;
  for (let offset = 0; offset <= candidate.length - windowLength; offset += 8) {
    if (script.includes(candidate.slice(offset, offset + windowLength))) return true;
  }
  return script.includes(candidate.slice(-windowLength));
}

function normalizeComment(value, scriptText) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") fail("buzzassistCommentは文字列で指定すること。", "CANVAS_FEEDBACK_SCHEMA_INVALID");
  const comment = value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  if (Array.from(comment).length > MAX_COMMENT_CHARACTERS) {
    fail(`buzzassistCommentは${MAX_COMMENT_CHARACTERS}文字以内にすること。`, "CANVAS_FEEDBACK_TEXT_TOO_LONG");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(comment)) {
    fail("buzzassistCommentに制御文字を含められない。", "CANVAS_FEEDBACK_SCHEMA_INVALID");
  }
  if (SECRET_PATTERN.test(comment)) {
    fail("Canvas feedbackに秘密・credentialらしき値を含められない。", "CANVAS_FEEDBACK_SENSITIVE_TEXT");
  }
  if (ABSOLUTE_PATH_PATTERN.test(comment)) {
    fail("Canvas feedbackに端末の絶対pathを含められない。", "CANVAS_FEEDBACK_SENSITIVE_TEXT");
  }
  if (CHANNEL_PACK_BODY_PATTERN.test(comment)) {
    fail("Canvas feedbackにChannel Pack本文・payloadを含められない。", "CANVAS_FEEDBACK_CHANNEL_PACK_BODY");
  }
  if (containsScriptExcerpt(comment, scriptText)) {
    fail("Canvas feedbackに台本本文の抜粋を含められない。要点だけを書くこと。", "CANVAS_FEEDBACK_SCRIPT_BODY");
  }
  return comment;
}

function routeForHarness(job) {
  return HARNESS_ROUTES[String(job?.harness?.id || "")] ?? null;
}

function resolveFeedbackTarget(customData, job) {
  const route = routeForHarness(job);
  const supplied = customData.buzzassistFeedbackTarget;
  const generalize = customData.buzzassistFeedbackGeneralize;
  if (generalize !== undefined && typeof generalize !== "boolean") {
    fail("buzzassistFeedbackGeneralizeはbooleanで指定すること。", "CANVAS_FEEDBACK_SCHEMA_INVALID");
  }
  if (supplied === undefined || supplied === null || supplied === "") {
    if (generalize === true) {
      fail("一般化する場合はbuzzassistFeedbackTargetを明示すること。", "CANVAS_FEEDBACK_TARGET_REQUIRED");
    }
    if (!route?.channel) {
      fail("このHarnessには安全なChannel Pack学習台帳が定義されていない。targetを推測しない。", "CANVAS_FEEDBACK_TARGET_REQUIRED");
    }
    return route.channel;
  }
  if (typeof supplied !== "string" || supplied !== supplied.trim() || supplied.length > 100) {
    fail("buzzassistFeedbackTargetは正規化済みの短いtarget IDで指定すること。", "CANVAS_FEEDBACK_SCHEMA_INVALID");
  }
  if (supplied === route?.channel) {
    if (generalize === true) fail("Channel Pack宛ではgeneralize=trueを指定しない。", "CANVAS_FEEDBACK_SCHEMA_INVALID");
    return supplied;
  }
  const allowedGeneralTarget = route?.genres?.includes(supplied) || PLATFORM_TARGETS.has(supplied);
  if (!allowedGeneralTarget) {
    fail("Canvas feedbackのtargetを安全に分類できない。", "CANVAS_FEEDBACK_TARGET_INVALID");
  }
  if (generalize !== true) {
    fail("genre/platformへ一般化するにはbuzzassistFeedbackGeneralize=trueを明示すること。", "CANVAS_FEEDBACK_GENERALIZATION_NOT_CONFIRMED");
  }
  return supplied;
}

async function canonicalPotentialPath(filePath) {
  let current = resolve(filePath);
  const missing = [];
  while (true) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

function insideOrSame(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function assertIsolatedLearningLedger(target, ledgerResolver) {
  if (!target.startsWith("channel-pack:")) return;
  let channelLedger;
  let sharedLedger;
  try {
    channelLedger = await canonicalPotentialPath(ledgerResolver(target, "proposals"));
    sharedLedger = await canonicalPotentialPath(ledgerResolver("platform:platform-craft", "proposals"));
  } catch {
    fail("Channel Pack proposal台帳の安全な配置を確認できない。", "CANVAS_FEEDBACK_LEDGER_NOT_ISOLATED");
  }
  if (insideOrSame(dirname(sharedLedger), channelLedger)) {
    fail("Channel Pack proposal台帳が共有learning台帳から分離されていない。", "CANVAS_FEEDBACK_LEDGER_NOT_ISOLATED");
  }
}

function proposalKindFor(decision) {
  return decision === "reject" ? "correction" : "preference";
}

function proposalTextFor(candidate) {
  const label = ENTITY_LABELS[candidate.entityKind] || "Canvas要素";
  const lead = candidate.decision === "accept"
    ? `${label}について、Canvas上で現行案の採択が明示された。`
    : candidate.decision === "reject"
      ? `${label}について、Canvas上で現行案の却下と再検討が明示された。`
      : `${label}について、Canvas上で改善コメントが記録された。`;
  return candidate.comment ? `${lead} ${candidate.comment}` : lead;
}

function proposalEvidenceFor(candidate, run) {
  return [
    "canvas-feedback-v1",
    `jobId=${run.runId}`,
    `runRevision=${run.revision}`,
    `runFingerprint=${run.runFingerprint}`,
    `entityKind=${candidate.entityKind}`,
    `entityIdDigest=${candidate.entityIdDigest}`,
    `projectionHash=${candidate.projectionHash}`,
    `feedbackRevision=${candidate.feedbackRevision}`,
    `decision=${candidate.decision}`,
  ].join(" ");
}

function proposalSessionFor(candidate, run) {
  return [
    "canvas-feedback",
    run.runId,
    run.runFingerprint.slice(-16),
    candidate.entityIdDigest.slice(-16),
    `r${candidate.feedbackRevision}`,
  ].join(":");
}

function validateJobBinding(job, run, projectDir) {
  if (!plainObject(job) || typeof job.id !== "string" || !job.id) {
    fail("Video Harness Jobが無い。", "CANVAS_FEEDBACK_JOB_INVALID");
  }
  if (resolve(String(job.projectDir || projectDir)) !== resolve(projectDir)) {
    fail("Video Harness JobのprojectがCanvasと一致しない。", "CANVAS_FEEDBACK_JOB_MISMATCH");
  }
  if (job.id !== run.runId) fail("Canvas RunとVideo Harness JobのIDが一致しない。", "CANVAS_FEEDBACK_JOB_MISMATCH");
  if (!Number.isSafeInteger(job.revision) || run.revision > job.revision) {
    fail("Canvas Run revisionがdurable Jobより新しい。", "CANVAS_FEEDBACK_JOB_MISMATCH");
  }
  if (String(job.harness?.id || "") !== run.versions.harness.id
      || normalizedHash(job.harness?.declarationSha256) !== run.versions.harness.sha256) {
    fail("Canvas RunのHarness fingerprintがdurable Jobと一致しない。", "CANVAS_FEEDBACK_JOB_MISMATCH");
  }
  if (String(job.channelPack?.id || "") !== run.versions.channelPack.id
      || normalizedHash(job.channelPack?.sha256) !== run.versions.channelPack.sha256) {
    fail("Canvas RunのChannel Pack fingerprintがdurable Jobと一致しない。", "CANVAS_FEEDBACK_JOB_MISMATCH");
  }
  if (normalizedHash(job.script?.sha256) !== run.script.sha256) {
    fail("Canvas Runの台本fingerprintがdurable Jobと一致しない。", "CANVAS_FEEDBACK_JOB_MISMATCH");
  }
}

function collectorRecord(value, key) {
  if (!plainObject(value)) fail(`Canvas feedback state recordが壊れている: ${key}`, "CANVAS_FEEDBACK_STATE_INVALID");
  const allowed = new Set([
    "entityKind", "entityIdDigest", "lastFeedbackRevision", "feedbackDigest",
    "runRevision", "runFingerprint", "proposalId", "proposalSession", "status", "target", "capturedAt",
  ]);
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    fail(`Canvas feedback state recordに未知fieldがある: ${key}`, "CANVAS_FEEDBACK_STATE_INVALID");
  }
  if (!ENTITY_LABELS[value.entityKind]
      || !HASH_PATTERN.test(value.entityIdDigest)
      || !Number.isSafeInteger(value.lastFeedbackRevision)
      || value.lastFeedbackRevision < 1
      || !HASH_PATTERN.test(value.feedbackDigest)
      || !Number.isSafeInteger(value.runRevision)
      || value.runRevision < 0
      || !HASH_PATTERN.test(value.runFingerprint)
      || !PROPOSAL_ID_PATTERN.test(value.proposalId)
      || typeof value.proposalSession !== "string"
      || !["pending", "captured"].includes(value.status)
      || typeof value.target !== "string"
      || typeof value.capturedAt !== "string") {
    fail(`Canvas feedback state recordのschemaが不正: ${key}`, "CANVAS_FEEDBACK_STATE_INVALID");
  }
  return { ...value };
}

function normalizeCollectorState(value, runId) {
  if (value === null) return { version: CANVAS_FEEDBACK_STATE_VERSION, runId, records: {} };
  if (!plainObject(value)
      || value.version !== CANVAS_FEEDBACK_STATE_VERSION
      || value.runId !== runId
      || !plainObject(value.records)
      || Object.keys(value).some((key) => !["version", "runId", "records"].includes(key))) {
    fail("Canvas feedback stateのschemaまたはrunIdが不正。", "CANVAS_FEEDBACK_STATE_INVALID");
  }
  const records = {};
  for (const [key, record] of Object.entries(value.records)) {
    if (!/^[a-f0-9]{64}$/u.test(key)) fail("Canvas feedback stateのentity keyが不正。", "CANVAS_FEEDBACK_STATE_INVALID");
    records[key] = collectorRecord(record, key);
  }
  return { version: CANVAS_FEEDBACK_STATE_VERSION, runId, records };
}

function candidateFromElement(element, expected, run, job) {
  const customData = element.customData;
  validateFeedbackFieldNames(customData);
  if (customData[CANVAS_RUN_PROJECTION_TAG] !== true
      || customData.buzzassistRunId !== run.runId
      || customData.buzzassistRunRevision !== run.revision
      || customData.buzzassistRunFingerprint !== run.runFingerprint
      || customData.buzzassistEntityKind !== expected.customData.buzzassistEntityKind
      || customData.buzzassistEntityId !== expected.customData.buzzassistEntityId
      || customData.buzzassistProjectionHash !== expected.customData.buzzassistProjectionHash) {
    fail("feedback付きCanvas要素が現在のBuzzAssist projectionへ拘束されていない。", "CANVAS_FEEDBACK_ELEMENT_MISMATCH");
  }
  const feedbackRevision = customData.buzzassistFeedbackRevision;
  if (!Number.isSafeInteger(feedbackRevision) || feedbackRevision < 1) {
    fail("buzzassistFeedbackRevisionは1以上の安全な整数にすること。", "CANVAS_FEEDBACK_SCHEMA_INVALID");
  }
  const decision = normalizeDecision(customData.buzzassistDecision);
  const comment = normalizeComment(customData.buzzassistComment, run.script.text);
  if (!decision && !comment) {
    fail("Canvas feedbackにはdecisionまたはcommentが必要。", "CANVAS_FEEDBACK_SCHEMA_INVALID");
  }
  if (decision === "comment" && !comment) {
    fail("comment decisionにはbuzzassistCommentが必要。", "CANVAS_FEEDBACK_SCHEMA_INVALID");
  }
  const normalizedDecision = decision || "comment";
  const target = resolveFeedbackTarget(customData, job);
  const entityKind = expected.customData.buzzassistEntityKind;
  const entityId = expected.customData.buzzassistEntityId;
  const entityIdDigest = stableDigest(`${entityKind}\u001f${entityId}`);
  const feedbackDigest = stableDigest(JSON.stringify({
    decision: normalizedDecision,
    comment,
    target,
    feedbackRevision,
  }));
  return {
    entityKey: sha256Hex(`${entityKind}\u001f${entityId}`),
    entityKind,
    entityIdDigest,
    feedbackRevision,
    decision: normalizedDecision,
    comment,
    target,
    feedbackDigest,
    projectionHash: expected.customData.buzzassistProjectionHash,
  };
}

function resultEnvelope(run, counts = {}) {
  return {
    version: CANVAS_FEEDBACK_COLLECTION_VERSION,
    ok: true,
    operation: "collect-feedback",
    jobId: run?.runId ?? counts.jobId ?? null,
    runRevision: run?.revision ?? null,
    runFingerprint: run?.runFingerprint ?? null,
    ownedElements: counts.ownedElements ?? 0,
    candidates: counts.candidates ?? 0,
    captured: counts.captured ?? 0,
    duplicates: counts.duplicates ?? 0,
    stale: counts.stale ?? 0,
    proposalIds: counts.proposalIds ?? [],
    targets: counts.targets ?? {},
    ...(counts.skippedReason ? { skippedReason: counts.skippedReason } : {}),
  };
}

export function resolveCanvasFeedbackStateFile(args = {}, runId) {
  return join(dirname(resolveCanvasRunStateFile(args, runId)), "canvas-feedback.json");
}

export function canvasFeedbackSchema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://buzzassist.local/schemas/canvas-feedback-v1.json",
    type: "object",
    properties: {
      buzzassistDecision: { enum: ["accept", "accepted", "approved", "採択", "reject", "rejected", "却下", "comment", "コメント"] },
      buzzassistComment: { type: "string", maxLength: MAX_COMMENT_CHARACTERS },
      buzzassistFeedbackRevision: { type: "integer", minimum: 1 },
      buzzassistFeedbackTarget: { type: "string", minLength: 1, maxLength: 100 },
      buzzassistFeedbackGeneralize: { type: "boolean" },
    },
    required: ["buzzassistFeedbackRevision"],
    anyOf: [
      { required: ["buzzassistDecision"] },
      { required: ["buzzassistComment"] },
    ],
    additionalProperties: false,
  };
}

export async function collectCanvasFeedback({
  projectDir = null,
  jobId = "",
  job: suppliedJob = null,
  ledgerResolver = ledgerPathFor,
  proposalCapture = captureLearningProposal,
  stateWriter = writeJsonAtomic,
  now = () => new Date().toISOString(),
} = {}) {
  const project = resolve(String(projectDir || suppliedJob?.projectDir || process.cwd()));
  let job = suppliedJob;
  const resolvedJobId = String(jobId || suppliedJob?.id || "");
  try {
    videoHarnessJobPath(project, resolvedJobId);
  } catch {
    fail("Video Harness Job IDが不正。", "CANVAS_FEEDBACK_JOB_INVALID");
  }
  if (!job) {
    try {
      job = await readVideoHarnessJob({ projectDir: project, jobId: resolvedJobId });
    } catch {
      fail("durable Video Harness Jobを読めない。", "CANVAS_FEEDBACK_JOB_INVALID");
    }
  }
  if (job?.id !== resolvedJobId || !resolvedJobId) {
    fail("jobIdとdurable Video Harness Jobが一致しない。", "CANVAS_FEEDBACK_JOB_MISMATCH");
  }
  if (typeof proposalCapture !== "function") {
    fail("proposal capture関数が無い。", "CANVAS_FEEDBACK_CAPTURE_INVALID");
  }
  if (typeof ledgerResolver !== "function" || typeof stateWriter !== "function") {
    fail("feedback collectorの永続化dependencyが不正。", "CANVAS_FEEDBACK_CAPTURE_INVALID");
  }

  const canvasRunStateFile = resolveCanvasRunStateFile({ projectDir: project }, resolvedJobId);
  const feedbackStateFile = resolveCanvasFeedbackStateFile({ projectDir: project }, resolvedJobId);
  const canvasFile = resolveCanvasFile({ projectDir: project });

  return withCanvasFileLock(feedbackStateFile, () => withCanvasFileLock(canvasRunStateFile, async () => {
    let run;
    try {
      run = await loadCanvasRunState({ projectDir: project }, resolvedJobId);
    } catch {
      fail("Canvas Run stateを検証できない。", "CANVAS_FEEDBACK_RUN_STATE_INVALID");
    }
    if (!run) return resultEnvelope(null, { jobId: resolvedJobId, skippedReason: "canvas-run-state-missing" });
    validateJobBinding(job, run, project);

    const sceneValue = await withCanvasFileLock(canvasFile, async () => readJsonIfExists(canvasFile, null));
    if (sceneValue === null) return resultEnvelope(run, { skippedReason: "canvas-scene-missing" });
    if (!plainObject(sceneValue) || !Array.isArray(sceneValue.elements)) {
      fail("Canvas sceneのschemaが不正。feedbackを失う可能性があるため投影を止める。", "CANVAS_FEEDBACK_SCENE_INVALID");
    }

    const expectedProjection = buildCanvasRunProjection(run);
    const expectedById = new Map(expectedProjection.elements
      .filter((element) => ["rectangle", "text"].includes(element.type) && ENTITY_LABELS[element.customData?.buzzassistEntityKind])
      .map((element) => [element.id, element]));
    const currentById = new Map();
    for (const element of sceneValue.elements) {
      if (!expectedById.has(element?.id)) continue;
      const rows = currentById.get(element.id) ?? [];
      rows.push(element);
      currentById.set(element.id, rows);
    }

    const candidates = [];
    let ownedElements = 0;
    for (const [elementId, expected] of expectedById) {
      const matches = currentById.get(elementId) ?? [];
      if (matches.length > 1 && matches.some((element) => feedbackFieldsPresent(element?.customData))) {
        fail("同じBuzzAssist element IDを持つfeedback要素が重複している。", "CANVAS_FEEDBACK_ELEMENT_DUPLICATED");
      }
      const element = matches[0];
      if (!element || element.isDeleted === true || !plainObject(element.customData)) continue;
      const data = element.customData;
      const owned = data[CANVAS_RUN_PROJECTION_TAG] === true
        && data.buzzassistRunId === run.runId
        && data.buzzassistRunRevision === run.revision
        && data.buzzassistRunFingerprint === run.runFingerprint
        && data.buzzassistEntityKind === expected.customData.buzzassistEntityKind
        && data.buzzassistEntityId === expected.customData.buzzassistEntityId
        && data.buzzassistProjectionHash === expected.customData.buzzassistProjectionHash;
      if (owned) ownedElements += 1;
      if (!feedbackFieldsPresent(data)) continue;
      if (!owned) {
        fail("現在のBuzzAssist projectionに属さない要素へfeedbackが付いている。", "CANVAS_FEEDBACK_ELEMENT_MISMATCH");
      }
      candidates.push(candidateFromElement(element, expected, run, job));
    }

    const grouped = new Map();
    let stale = 0;
    for (const candidate of candidates) {
      const current = grouped.get(candidate.entityKey);
      if (!current || candidate.feedbackRevision > current.feedbackRevision) {
        if (current) stale += 1;
        grouped.set(candidate.entityKey, candidate);
      } else if (candidate.feedbackRevision < current.feedbackRevision) {
        stale += 1;
      } else if (candidate.feedbackDigest !== current.feedbackDigest) {
        fail("同じentity/revisionに異なるCanvas feedbackがある。revisionを増やして再入力すること。", "CANVAS_FEEDBACK_REVISION_CONFLICT");
      }
    }

    const collectorState = normalizeCollectorState(
      await readJsonIfExists(feedbackStateFile, null),
      run.runId,
    );
    let captured = 0;
    let duplicates = 0;
    const proposalIds = [];
    const targets = {};
    const ordered = [...grouped.values()].sort((left, right) => left.entityKey.localeCompare(right.entityKey));
    for (const candidate of ordered) {
      const previous = collectorState.records[candidate.entityKey];
      if (previous?.status === "pending" && candidate.feedbackRevision !== previous.lastFeedbackRevision) {
        fail("未完了proposalより新旧の異なるfeedbackRevisionを処理できない。先に同じrevisionをrecoverすること。", "CANVAS_FEEDBACK_PENDING_CONFLICT");
      }
      if (previous && candidate.feedbackRevision < previous.lastFeedbackRevision) {
        stale += 1;
        continue;
      }
      if (previous && candidate.feedbackRevision === previous.lastFeedbackRevision) {
        if (candidate.feedbackDigest !== previous.feedbackDigest) {
          fail("同じfeedbackRevisionの内容が保存済みproposalと異なる。revisionを増やすこと。", "CANVAS_FEEDBACK_REVISION_CONFLICT");
        }
        if (previous.status === "captured") {
          duplicates += 1;
          continue;
        }
      }

      const capturedAt = String(now());
      if (!Number.isFinite(Date.parse(capturedAt))) fail("capture timestampが不正。", "CANVAS_FEEDBACK_CAPTURE_INVALID");
      await assertIsolatedLearningLedger(candidate.target, ledgerResolver);
      const proposalInput = {
        kind: proposalKindFor(candidate.decision),
        target: candidate.target,
        text: proposalTextFor(candidate),
        evidence: proposalEvidenceFor(candidate, run),
        session: proposalSessionFor(candidate, run),
        now: capturedAt,
      };
      // capture は書き込み前の検査に当たった提案を blocked 形（本文を無害化し ID を
      // 作り直した形）で残す。予定 ID も同じ変換を通さないと、コメントに注入らしい
      // 言い回しがあるだけで「capture 結果が予定と違う」として投影ごと止まる。
      const plannedEntry = blockProposalIfUnsafe(buildProposal(proposalInput));
      if (previous?.status === "pending"
          && (previous.proposalId !== plannedEntry.id || previous.proposalSession !== plannedEntry.session)) {
        fail("未完了proposalと現在のCanvas feedbackが一致しない。自動一般化・上書きをしない。", "CANVAS_FEEDBACK_PENDING_CONFLICT");
      }
      collectorState.records[candidate.entityKey] = {
        entityKind: candidate.entityKind,
        entityIdDigest: candidate.entityIdDigest,
        lastFeedbackRevision: candidate.feedbackRevision,
        feedbackDigest: candidate.feedbackDigest,
        runRevision: run.revision,
        runFingerprint: run.runFingerprint,
        proposalId: plannedEntry.id,
        proposalSession: plannedEntry.session,
        status: "pending",
        target: candidate.target,
        capturedAt,
      };
      try {
        await stateWriter(feedbackStateFile, collectorState);
      } catch {
        fail("Canvas feedback pending stateを保存できない。proposalは追記していない。", "CANVAS_FEEDBACK_STATE_WRITE_FAILED");
      }
      let output;
      try {
        output = await proposalCapture(proposalInput);
      } catch {
        fail("self-improvement proposalを追記できない。feedback revisionは進めていない。", "CANVAS_FEEDBACK_PROPOSAL_APPEND_FAILED");
      }
      const entry = output?.entry ?? output;
      if (!PROPOSAL_ID_PATTERN.test(String(entry?.id || ""))) {
        fail("proposal capture結果に有効なproposal IDが無い。", "CANVAS_FEEDBACK_CAPTURE_INVALID");
      }
      if (entry.id !== plannedEntry.id || entry.session !== plannedEntry.session) {
        fail("proposal capture結果がpending proposal identityと一致しない。", "CANVAS_FEEDBACK_CAPTURE_INVALID");
      }
      collectorState.records[candidate.entityKey].status = "captured";
      try {
        await stateWriter(feedbackStateFile, collectorState);
      } catch {
        fail("Canvas feedback dedupe stateを保存できない。", "CANVAS_FEEDBACK_STATE_WRITE_FAILED");
      }
      captured += 1;
      proposalIds.push(entry.id);
      targets[candidate.target] = (targets[candidate.target] || 0) + 1;
    }

    return resultEnvelope(run, {
      ownedElements,
      candidates: candidates.length,
      captured,
      duplicates,
      stale,
      proposalIds,
      targets,
    });
  }));
}

export const _testing = Object.freeze({
  containsScriptExcerpt,
  normalizeCollectorState,
  normalizeComment,
  resolveFeedbackTarget,
});
