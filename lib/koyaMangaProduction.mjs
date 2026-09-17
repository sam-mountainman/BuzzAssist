import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  AdaptiveConcurrencyController,
  runWithAdaptiveConcurrency,
} from "./adaptiveConcurrency.mjs";
import { findCharacter, readCharacterRegistry } from "./characterRegistry.mjs";
import { buildCharacterCandidateQualityContract } from "./characterAttributeGate.mjs";
import { verifyCharacterRepairPlanDigest, verifyRepairPlanCoverage } from "./characterRepairPlan.mjs";
import {
  buildApprovedIdentityPackJobs,
  buildApprovedIdentityPackRepairJobs,
  buildCharacterStylingVariationJobs,
  checkpointCharacterStylingVariationResult,
  composeCharacterStylingReviewSheet,
  effectiveCharacterIdentityCandidate,
  finalizeApprovedCharacter,
  findWorkflowCandidate,
  findWorkflowCast,
  getCharacterWorkflow,
  identityPackJobRoleKey,
  markCharacterStylingVariationsGenerating,
  readCharacterWorkflowStore,
  recordFailedCharacterStylingReview,
  recordCharacterStylingVariationResults,
  selectCharacterStylingVariation,
  stageApprovedCharacterIdentityPack,
  updateCharacterWorkflow,
  validateCandidateDiversityReview,
} from "./characterPipeline.mjs";
import { eyeOpenReviewKey, identityPackEyeOpenSheets, validateFailedIdentityPackReview } from "./characterIdentityReview.mjs";
import { getImageDimensionsFromBuffer, writeJsonAtomic } from "./canvasScene.mjs";
import { withCanvasFileLock } from "./canvasFileLock.mjs";
import { requirePythonRuntime } from "./harnessRuntimeResolver.mjs";
import {
  auditKoyaFixedCastReadiness,
  auditKoyaStory,
  assertProductionChannelAuthority,
  fingerprintKoyaChannelAuthority,
  KOYA_CHANNEL_AUTHORITY_FINGERPRINT_VERSION,
  auditKoyaEyeOpenPlan,
  buildKoyaEyeOpenPolicy,
  readKoyaChannelAuthority,
  resolveKoyaValidationCanary,
  validateKoyaShowBible,
} from "./koyaChannelGovernance.mjs";
import { auditKoyaCharacterRosterReview } from "./koyaCharacterRosterReview.mjs";
import { recordBlindCandidateVerdict } from "./mangaBlindCandidateStore.mjs";
import {
  applyKoyaSpeechPronunciations,
  generateKoyaDialogueSpeech,
} from "./koyaDialogueSpeech.mjs";
import {
  applyKoyaContractToManifest,
  applyKoyaNarrationVoicePolicy,
  assertKoyaDeclaredProtagonist,
  auditManifestAgainstKoyaContract,
  resolveKoyaProtagonistSpeaker,
  resolveKoyaMangaProductionContract,
} from "./koyaMangaProductionContract.mjs";
import { resolveKoyaAgentProvenance } from "./koyaMangaProvenance.mjs";
import {
  assertKoyaOuterJobBinding,
  createKoyaOuterJobBinding,
  sameKoyaOuterJobBinding,
} from "./koyaOuterJobBinding.mjs";
import { assertVideoHarnessExecutionIdentity } from "./videoHarnessExecutionIdentity.mjs";
import { mergeMangaQualityIncidentLedgers } from "./mangaQualityHarness.mjs";
import {
  applyMangaCameraGrammarToShot,
  applyMangaCameraGrammarToPanelLayout,
  mangaCameraModeFamily,
} from "./mangaPageCameraGrammar.mjs";
import {
  createMangaScriptImagePlan,
  runMangaScriptImagePipeline,
} from "./mangaScriptImagePipeline.mjs";
import {
  assertCutVideoSubstitutionsReadyForRender,
  runCutVideoSubstitutions,
} from "./mangaCutVideoSubstitution.mjs";
import { generateImageMedia } from "./mediaGeneration.mjs";
import {
  compileEpisodeTiming,
  createEpisodeManifest,
  parseMangaScript,
  refreshEpisodeBubbleOverlays,
  renderEpisodeVideo,
} from "./mangaVideoPipeline.mjs";
import {
  assertKoyaHumanVoiceSelections,
  auditKoyaVoiceSelections,
  KOYA_VOICE_SELECTION_GUARD_VERSION,
  KOYA_VOICE_SELECTION_REQUIRED_CODE,
} from "./koyaVoiceSelectionGuard.mjs";
import { voiceLibraryAuditionPaths } from "./voiceLibraryCasting.mjs";
import {
  checkKoyaWardrobeReport,
  evaluateKoyaWardrobeReadiness,
  KOYA_WARDROBE_POLICY_INVALID_CODE,
  KOYA_WARDROBE_READINESS_FILE_NAME,
  KOYA_WARDROBE_READINESS_REQUIRED_CODE,
  KOYA_WARDROBE_READINESS_VERSION,
  KOYA_WARDROBE_REVIEW_INVALID_CODE,
  koyaWardrobeScriptDigest,
  validateKoyaWardrobeOverrideReason,
} from "./koyaWardrobeReadiness.mjs";

const execFile = promisify(execFileCallback);

// パスの包含は区切り文字を決め打ちしない。`${dir}/` との前方一致は Windows の
// バックスラッシュ区切りで必ず外れ、プロジェクト内の正しいファイルまで拒否していた。
function isInsideDirectory(child, parent) {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export const KOYA_CHARACTER_STYLING_IMPORT_VERSION = "koya-character-styling-import-v1";
export const KOYA_IDENTITY_PACK_GENERATION_CHECKPOINT_VERSION = "koya-identity-pack-generation-checkpoint-v1";
export const KOYA_IDENTITY_GENERATION_IMPORT_VERSION = "koya-identity-generation-import-v1";

export const KOYA_UPSTREAM_PREFLIGHT_VERSION = "koya-upstream-preflight-v1";
const KOYA_PREFLIGHT_MAX_AGE_MS = 15 * 60 * 1000;
const KOYA_REQUIRED_PREFLIGHT_CHECKS = Object.freeze([
  "harness-production-route",
  "node",
  "ffmpeg",
  "ffprobe",
  "ffmpeg-capability",
  "voice-quality-python",
  "tts-key",
  "image-key",
  "channel-pack",
]);

const nonEmpty = (value) => typeof value === "string" && value.trim() ? value.trim() : "";
const sha256Text = (value) => createHash("sha256").update(String(value)).digest("hex");

function assertSha256(value, label) {
  const digest = nonEmpty(value);
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error(`${label} must be a SHA-256 digest.`);
  return digest;
}

function parseFreshTimestamp(value, nowMs, label) {
  if (!Number.isFinite(nowMs)) throw new Error("The preflight clock returned an invalid timestamp.");
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) throw new Error(`${label} is missing or invalid.`);
  const age = nowMs - timestamp;
  if (age < -5 * 60 * 1000) throw new Error(`${label} is in the future.`);
  if (age > KOYA_PREFLIGHT_MAX_AGE_MS) throw new Error(`${label} is stale; rerun the common doctor.`);
  return timestamp;
}

/**
 * Parent/child TOCTOU binding for the already-measured common doctor result.
 * This is a fingerprint, not a bearer token: the child still revalidates the
 * durable Job identity and every field represented here before trusting it.
 */
export function createKoyaUpstreamPreflightBinding(job = {}) {
  const doctorStage = (job.stages || []).find((stage) => stage?.id === "doctor") || {};
  const payload = {
    version: KOYA_UPSTREAM_PREFLIGHT_VERSION,
    jobId: nonEmpty(job.id),
    jobRevision: Number(job.revision),
    identityDigest: nonEmpty(job.identityDigest),
    executionIdentityDigest: nonEmpty(job.executionIdentityDigest),
    harnessId: nonEmpty(job.harness?.id),
    executionProjectDir: resolve(job.executionProjectDir || ""),
    deploymentEntrypointPath: resolve(job.deployment?.entrypointPath || ""),
    deploymentEntrypointSha256: nonEmpty(job.deployment?.entrypointSha256),
    canonicalDeploymentEntrypointSha256: nonEmpty(job.canonicalIdentity?.deployment?.entrypointSha256),
    productionDependenciesSha256: sha256Text(JSON.stringify(job.canonicalIdentity?.productionDependencies ?? null)),
    resolvedProductionContractSha256: sha256Text(JSON.stringify(job.resolvedProductionContract ?? null)),
    channelPackEnvelopeSha256: nonEmpty(job.channelPack?.sha256),
    channelPackFileCount: Number(job.channelPack?.fileCount),
    channelPackPayloadSha256: nonEmpty(job.channelPackVerification?.payloadSha256),
    channelPackPayloadKind: nonEmpty(job.channelPackVerification?.payloadKind),
    channelPackSignerKeyId: nonEmpty(job.channelPackVerification?.signerKeyId),
    channelPackTrustedPublicKeyId: nonEmpty(job.channelPackVerification?.trustedPublicKeyId),
    doctorStatus: nonEmpty(doctorStage.status),
    doctorFinishedAt: nonEmpty(doctorStage.finishedAt),
    doctorEvidenceSha256: sha256Text(JSON.stringify(doctorStage.evidence ?? null)),
  };
  return sha256Text(JSON.stringify(payload));
}

function assertKoyaDoctorEvidence(evidence, { projectDir, nowMs }) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error("The upstream Job has no structured doctor evidence.");
  }
  if (evidence.version !== "harness-doctor-v1") {
    throw new Error(`Unsupported upstream doctor evidence version: ${evidence.version || "(missing)"}.`);
  }
  if (evidence.ready !== true || (evidence.blocking || []).length > 0) {
    throw new Error("The upstream common doctor did not pass fail-closed.");
  }
  if (evidence.harnessId !== "koya-manga-video") {
    throw new Error(`The upstream doctor is for another harness: ${evidence.harnessId || "(missing)"}.`);
  }
  if (resolve(evidence.projectDir || "") !== resolve(projectDir)) {
    throw new Error("The upstream doctor projectDir does not match this isolated Koya workspace.");
  }
  const checks = new Map((Array.isArray(evidence.checks) ? evidence.checks : []).map((check) => [check?.id, check]));
  for (const id of KOYA_REQUIRED_PREFLIGHT_CHECKS) {
    const check = checks.get(id);
    if (!check || check.required !== true || check.ok !== true) {
      throw new Error(`The upstream common doctor lacks a passing required check: ${id}.`);
    }
  }
  const tts = checks.get("tts-key");
  const expectedTts = {
    kind: "voice.dialogue",
    provider: "elevenlabs",
    model: "eleven_v3",
    adapterVersion: "elevenlabs-dialogue-server-v1",
    status: "ready",
  };
  for (const [key, expected] of Object.entries(expectedTts)) {
    if (tts?.[key] !== expected) {
      throw new Error(`The Koya doctor TTS evidence is not the exact paid adapter (${key}=${expected}).`);
    }
  }
  const image = checks.get("image-key");
  if (!nonEmpty(image?.host) || !nonEmpty(image?.model)) {
    throw new Error("The Koya doctor image evidence lacks the exact production host/model identity.");
  }
  const authorityFingerprint = checks.get("channel-pack")?.authorityFingerprint;
  if (authorityFingerprint?.version !== KOYA_CHANNEL_AUTHORITY_FINGERPRINT_VERSION
    || !Number.isSafeInteger(Number(authorityFingerprint?.fileCount))
    || Number(authorityFingerprint.fileCount) < 3
    || !Array.isArray(authorityFingerprint?.files)
    || authorityFingerprint.files.length !== Number(authorityFingerprint.fileCount)
    || !/^[a-f0-9]{64}$/u.test(nonEmpty(authorityFingerprint?.sha256))) {
    throw new Error("The Koya doctor Channel Pack evidence lacks an exact restored-authority fingerprint.");
  }
  for (const row of authorityFingerprint.files) {
    if (!nonEmpty(row?.role) || !nonEmpty(row?.path)
      || !/^[a-f0-9]{64}$/u.test(nonEmpty(row?.sha256))
      || !Number.isSafeInteger(Number(row?.bytes)) || Number(row.bytes) < 1) {
      throw new Error("The Koya doctor restored-authority fingerprint contains an invalid file row.");
    }
  }
  const authorityPayload = {
    version: authorityFingerprint.version,
    fileCount: authorityFingerprint.fileCount,
    files: authorityFingerprint.files,
  };
  if (sha256Text(JSON.stringify(authorityPayload)) !== authorityFingerprint.sha256) {
    throw new Error("The Koya doctor restored-authority fingerprint digest is invalid.");
  }
  return {
    version: nonEmpty(evidence.version),
    checkedAt: new Date(nowMs).toISOString(),
    checkIds: [...KOYA_REQUIRED_PREFLIGHT_CHECKS],
    ttsAdapter: expectedTts,
    imageAdapter: { host: image.host, model: image.model },
    authorityFingerprint: structuredClone(authorityFingerprint),
  };
}

async function assertCurrentKoyaAuthorityFingerprint(projectDir, expected, runtime = {}) {
  const readAuthority = runtime.readKoyaChannelAuthority ?? readKoyaChannelAuthority;
  const fingerprintAuthority = runtime.fingerprintKoyaChannelAuthority ?? fingerprintKoyaChannelAuthority;
  const authority = await readAuthority({ projectDir });
  const current = await fingerprintAuthority(authority);
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error("Koya restored Channel Pack authority bytes changed after the common doctor.");
  }
  return current;
}

/**
 * Verify the durable common-Job doctor result before skipping an identical
 * internal doctor. A path/token/environment flag alone is never sufficient:
 * the current Job identity, revision, deployment bytes and signed Channel
 * Pack fingerprint are all revalidated from job.json.
 */
export async function verifyKoyaUpstreamPreflight(options = {}, runtime = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  const jobPath = resolve(nonEmpty(options.upstreamJobPath));
  const expectedJobId = nonEmpty(options.upstreamJobId);
  const expectedRevision = Number(options.upstreamJobRevision);
  const expectedBinding = nonEmpty(options.upstreamPreflightBinding);
  if (!nonEmpty(options.upstreamJobPath) || !expectedJobId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
    || !/^[a-f0-9]{64}$/u.test(expectedBinding)) {
    throw new Error("Upstream preflight requires job path, exact job id/revision, and the exact parent evidence binding together.");
  }
  const jobInfo = await lstat(jobPath);
  if (!jobInfo.isFile() || jobInfo.isSymbolicLink()) throw new Error("Upstream preflight job path must be a regular non-symlink file.");
  const canonicalJobPath = await realpath(jobPath);
  const job = JSON.parse(await readFile(canonicalJobPath, "utf8"));
  if (!nonEmpty(job?.runDir)
    || canonicalJobPath !== await realpath(resolve(job.runDir, "job.json"))) {
    throw new Error("Upstream preflight job path is not the Job's canonical durable job.json.");
  }
  if (job.id !== expectedJobId || Number(job.revision) !== expectedRevision) {
    throw new Error("Upstream preflight Job id/revision is stale or belongs to another Job.");
  }
  const identityDigest = assertSha256(job.identityDigest, "Upstream Job identityDigest");
  if (!/^video-koya-manga-video-[a-f0-9]{16}$/u.test(job.id)
    || !job.id.endsWith(identityDigest.slice(0, 16))) {
    throw new Error("Upstream preflight Job ID is not bound to its canonical identity digest.");
  }
  const executionIdentity = assertVideoHarnessExecutionIdentity(job);
  if (createKoyaUpstreamPreflightBinding(job) !== expectedBinding) {
    throw new Error("Upstream preflight evidence changed after the parent launched the Koya runner.");
  }
  if (job.status !== "running" || job.harness?.id !== "koya-manga-video") {
    throw new Error("Upstream preflight Job is not the running Koya production Job.");
  }
  if (resolve(job.executionProjectDir || "") !== projectDir) {
    throw new Error("Upstream preflight Job is bound to another execution workspace.");
  }
  const doctorStage = (job.stages || []).find((stage) => stage?.id === "doctor");
  if (doctorStage?.status !== "pass") throw new Error("Upstream preflight Job doctor stage has not passed.");
  const nowMs = typeof runtime.now === "function" ? Number(runtime.now()) : Date.now();
  parseFreshTimestamp(doctorStage.finishedAt, nowMs, "Upstream doctor evidence");
  const doctor = assertKoyaDoctorEvidence(doctorStage.evidence, { projectDir, nowMs });
  await assertCurrentKoyaAuthorityFingerprint(projectDir, doctor.authorityFingerprint, runtime);

  const verification = job.channelPackVerification;
  if (verification?.harnessId !== "koya-manga-video"
    || verification?.payloadKind !== "koya-handoff"
    || !nonEmpty(verification?.signerKeyId)
    || !nonEmpty(verification?.trustedPublicKeyId)) {
    throw new Error("Upstream preflight lacks a trusted Koya Channel Pack verification binding.");
  }
  const channelPackPayloadSha256 = assertSha256(
    verification.payloadSha256,
    "Upstream verified Channel Pack payloadSha256",
  );
  const channelPackEnvelopeSha256 = assertSha256(
    job.channelPack?.sha256,
    "Upstream planned Channel Pack envelope sha256",
  );
  if (!Number.isSafeInteger(Number(job.channelPack?.fileCount)) || Number(job.channelPack.fileCount) < 1
    || !Number.isSafeInteger(Number(verification.fileCount)) || Number(verification.fileCount) < 1) {
    throw new Error("Upstream Channel Pack file-count binding is invalid.");
  }

  const officialEntrypoint = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../scripts/koya-manga-video.mjs",
  );
  if (resolve(job.deployment?.entrypointPath || "") !== officialEntrypoint
    || resolve(job.canonicalIdentity?.deployment?.entrypointPath || "") !== officialEntrypoint) {
    throw new Error("Upstream preflight deployment is not the canonical Koya entrypoint.");
  }
  const entrypointSha256 = await sha256Path(officialEntrypoint);
  if (assertSha256(job.deployment?.entrypointSha256, "Upstream deployment entrypointSha256") !== entrypointSha256
    || assertSha256(job.canonicalIdentity?.deployment?.entrypointSha256, "Upstream canonical deployment entrypointSha256") !== entrypointSha256) {
    throw new Error("Upstream Koya deployment bytes changed after the common doctor.");
  }
  const verifyJobIdentity = runtime.verifyJobIdentity
    || (await import("./videoHarnessJob.mjs")).assertVideoHarnessJobIdentity;
  await verifyJobIdentity(job);
  const productionDependencies = job.canonicalIdentity?.productionDependencies;
  if (productionDependencies?.version !== "buzzassist-production-dependency-tree-v1") {
    throw new Error("Upstream Koya production dependency tree is missing or has an unsupported version.");
  }
  for (const scope of ["runtime", "deployment"]) {
    const row = productionDependencies?.[scope];
    if (row?.version !== productionDependencies.version || row?.scope !== scope
      || !/^[a-f0-9]{64}$/u.test(nonEmpty(row?.digest))
      || !Number.isSafeInteger(Number(row?.fileCount)) || Number(row.fileCount) < 1) {
      throw new Error(`Upstream Koya ${scope} production dependency tree binding is invalid.`);
    }
  }
  const productionDependenciesSha256 = sha256Text(JSON.stringify(productionDependencies));
  return {
    version: KOYA_UPSTREAM_PREFLIGHT_VERSION,
    mode: "verified-common-job",
    jobId: job.id,
    jobRevision: job.revision,
    // The Job lives here; the Koya runner works in executionProjectDir, which
    // for a handoff payload is an isolated workspace below the Job's run dir.
    jobProjectDir: nonEmpty(job.projectDir) ? resolve(job.projectDir) : "",
    identityDigest: job.identityDigest,
    executionIdentityDigest: executionIdentity.executionIdentityDigest,
    resolvedProductionContractSha256: executionIdentity.resolvedProductionContractSha256,
    harnessId: job.harness.id,
    executionProjectDir: projectDir,
    deploymentEntrypointSha256: entrypointSha256,
    productionDependenciesSha256,
    channelPackEnvelopeSha256,
    channelPackPayloadSha256,
    doctor,
  };
}

/** Verify the exact fresh parent result. Direct doctor is test-only and cannot authorize paid work. */
export async function assertKoyaFullPreflight(options = {}, runtime = {}) {
  const upstreamValues = [
    nonEmpty(options.upstreamJobPath),
    nonEmpty(options.upstreamJobId),
    options.upstreamJobRevision === undefined || options.upstreamJobRevision === ""
      ? ""
      : String(options.upstreamJobRevision),
    nonEmpty(options.upstreamPreflightBinding),
  ];
  const upstreamCount = upstreamValues.filter(Boolean).length;
  if (upstreamCount > 0 && upstreamCount !== upstreamValues.length) {
    throw new Error("Partial upstream preflight evidence is forbidden; pass path, job id, revision, and binding together.");
  }
  if (upstreamCount === upstreamValues.length) {
    return verifyKoyaUpstreamPreflight(options, runtime);
  }
  if (runtime.allowDirectMeasuredDoctorForTests !== true) {
    const error = new Error("Koya production requires the canonical outer Video Harness Job; run scripts/run-video-harness.mjs start/resume instead of the internal runner directly.");
    error.code = "KOYA_OUTER_JOB_REQUIRED";
    throw error;
  }
  const runDoctor = runtime.runDoctor || (await import("../scripts/harness-doctor.mjs")).runHarnessDoctor;
  const report = await runDoctor({
    projectDir: resolve(options.projectDir || process.cwd()),
    harnessId: "koya-manga-video",
  });
  if (report?.ready !== true) {
    const blocking = Array.isArray(report?.blocking) && report.blocking.length > 0
      ? report.blocking.join(", ")
      : "doctor-not-ready";
    const error = new Error(`Koya full preflight failed before paid generation: ${blocking}`);
    error.code = "KOYA_PREFLIGHT_BLOCKED";
    error.report = report;
    throw error;
  }
  const doctor = assertKoyaDoctorEvidence(report, {
    projectDir: resolve(options.projectDir || process.cwd()),
    nowMs: typeof runtime.now === "function" ? Number(runtime.now()) : Date.now(),
  });
  const identityDigest = sha256Text(JSON.stringify({
    version: "koya-test-only-direct-preflight-v1",
    projectDir: resolve(options.projectDir || process.cwd()),
    episodeId: nonEmpty(options.episodeId),
    doctor,
  }));
  const resolvedProductionContractSha256 = sha256Text(JSON.stringify({
    version: "koya-test-only-direct-contract-v1",
    episodeId: nonEmpty(options.episodeId),
  }));
  const executionIdentityDigest = sha256Text(JSON.stringify({
    version: "koya-test-only-direct-execution-v1",
    jobId: `video-koya-manga-video-${identityDigest.slice(0, 16)}`,
    identityDigest,
    resolvedProductionContractSha256,
  }));
  return {
    version: KOYA_UPSTREAM_PREFLIGHT_VERSION,
    mode: "direct-measured-doctor",
    harnessId: "koya-manga-video",
    jobId: `video-koya-manga-video-${identityDigest.slice(0, 16)}`,
    identityDigest,
    executionIdentityDigest,
    resolvedProductionContractSha256,
    executionProjectDir: resolve(options.projectDir || process.cwd()),
    doctor,
    testOnly: true,
  };
}

function requiredOuterJobBindingFromPreflight(preflight) {
  const binding = createKoyaOuterJobBinding({
    jobId: preflight?.jobId,
    identityDigest: preflight?.identityDigest,
    executionIdentityDigest: preflight?.executionIdentityDigest,
    resolvedProductionContractSha256: preflight?.resolvedProductionContractSha256,
  });
  if (!binding) throw new Error("Koya production requires an outer Video Harness Job binding.");
  return binding;
}

export function applyKoyaValidationCanaryVoiceProfiles(manifestInput, validationCanary, registry, showBible) {
  const manifest = structuredClone(manifestInput);
  if (validationCanary?.active !== true) return manifest;
  if (validationCanary.pass !== true || validationCanary.publicationEligible !== false) {
    throw new Error(`Invalid validation canary voice policy: ${(validationCanary?.failures || ["policy is not fail-closed"]).join("; ")}`);
  }
  const profileByCastId = validationCanary.provisionalVoiceProfileByCastId || {};
  const voiceById = new Map((registry?.voices || []).map((voice) => [voice.id, voice]));
  const characterById = new Map((registry?.characters || []).map((character) => [character.id, character]));
  const assignments = new Map();
  const providerOwner = new Map();
  for (const utterance of manifest.utterances || []) {
    if (utterance.speakerId === "narration" || utterance.preset === "narration") continue;
    const registered = characterById.get(utterance.speakerId)
      || (registry?.characters || []).find((character) => character.name === utterance.speakerName || character.aliases?.includes(utterance.speakerName));
    const names = new Set([
      utterance.speakerId,
      utterance.speakerName,
      registered?.id,
      registered?.name,
      ...(registered?.aliases || []),
    ].map(nonEmpty).filter(Boolean));
    const member = (showBible?.cast || []).find((entry) => [entry.id, entry.name, entry.hiddenName].map(nonEmpty).filter(Boolean).some((value) => names.has(value)));
    if (!member) continue;
    const profileId = nonEmpty(profileByCastId[member.id]);
    if (!profileId) throw new Error(`Validation canary requires a provisional voice profile for speaking cast member ${member.name} (${member.id}).`);
    const voice = voiceById.get(profileId);
    const providerVoiceId = nonEmpty(voice?.providerVoiceId || voice?.elevenLabsVoiceId);
    if (!voice || !providerVoiceId || voice.modelId !== "eleven_v3" || !/^approved/u.test(nonEmpty(voice.status))) {
      throw new Error(`Validation canary voice profile ${profileId} for ${member.name} must be an existing approved eleven_v3 Japanese profile.`);
    }
    const priorOwner = providerOwner.get(providerVoiceId);
    if (priorOwner && priorOwner !== member.id) {
      throw new Error(`Validation canary cannot reuse provider voice ${providerVoiceId} for both ${priorOwner} and ${member.id}.`);
    }
    providerOwner.set(providerVoiceId, member.id);
    utterance.voiceProfileId = voice.id;
    utterance.voiceId = providerVoiceId;
    utterance.voiceName = voice.name || "";
    utterance.voiceSettings = voice.settings || null;
    utterance.model = "eleven_v3";
    utterance.voiceApprovalScope = "validation-canary-provisional";
    assignments.set(member.id, {
      castId: member.id,
      castName: member.name,
      voiceProfileId: voice.id,
      voiceId: providerVoiceId,
      voiceName: voice.name || "",
      approvalScope: "validation-canary-provisional",
    });
  }
  manifest.production = {
    ...(manifest.production || {}),
    validationCanary: {
      version: validationCanary.version,
      active: true,
      episodeId: validationCanary.episodeId,
      scope: validationCanary.scope,
      publicationEligible: false,
      reason: validationCanary.reason,
      provisionalVoiceAssignments: [...assignments.values()],
    },
  };
  return synchronizeKoyaValidationCanaryVoiceCasting(manifest);
}

/** Keep the human-readable casting ledger identical to the voices on the timed utterances. */
export function synchronizeKoyaValidationCanaryVoiceCasting(manifestInput) {
  const manifest = structuredClone(manifestInput);
  if (manifest.production?.validationCanary?.active !== true) return manifest;
  const assignments = [];
  const seen = new Set();
  for (const utterance of manifest.utterances || []) {
    const voiceId = nonEmpty(utterance.voiceId);
    if (!voiceId) continue;
    const characterId = utterance.speakerId === "narration" || utterance.preset === "narration"
      ? "narration"
      : nonEmpty(utterance.speakerId);
    const key = `${characterId}\n${voiceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    assignments.push({
      characterId,
      characterName: utterance.speakerId === "narration" || utterance.preset === "narration"
        ? "ナレーション"
        : (nonEmpty(utterance.speakerName) || characterId),
      voiceProfileId: nonEmpty(utterance.voiceProfileId),
      voiceId,
      voiceName: nonEmpty(utterance.voiceName),
      retained: true,
      approvalScope: "validation-canary-provisional",
      ...(characterId === "narration" && nonEmpty(utterance.voiceSourceSpeakerId)
        ? { voiceSourceSpeakerId: nonEmpty(utterance.voiceSourceSpeakerId) }
        : {}),
    });
  }
  manifest.speech = {
    ...(manifest.speech || {}),
    voiceCasting: {
      status: "validation-canary-provisional",
      source: "episode-override",
      scope: "speaking-cast-plus-protagonist-narration",
      assignments,
    },
  };
  return manifest;
}

function koyaShowMemberForWorkflowCast(showBible, cast) {
  const names = new Set([cast?.id, cast?.name, ...(cast?.aliases || [])].map(nonEmpty).filter(Boolean));
  return (showBible?.cast || []).find((member) => [member.id, member.name, member.hiddenName].map(nonEmpty).filter(Boolean).some((value) => names.has(value))) || null;
}

function koyaDeclaredStylingSpecPaths(authority, member) {
  const declared = Array.isArray(member?.stylingSpecPaths) && member.stylingSpecPaths.length > 0
    ? member.stylingSpecPaths
    : [member?.stylingSpecPath].filter(Boolean);
  return declared.map((path) => resolve(authority.root, path));
}

async function sha256Path(path) {
  return createHash("sha256").update(await readFile(resolve(path))).digest("hex");
}

async function writeBufferAtomic(filePath, buffer) {
  const target = resolve(filePath);
  const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(temporary, buffer);
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function assertGeneratedImageBuffer(buffer, label) {
  const dimensions = getImageDimensionsFromBuffer(buffer, label);
  if (dimensions.width < 64 || dimensions.height < 64) throw new Error(`${label} is too small to be a valid generated image.`);
  return dimensions;
}

export async function buildKoyaIdentityPackJobInput(options = {}) {
  const workflowId = nonEmpty(options.workflowId);
  const castId = nonEmpty(options.castId);
  const candidateSha256 = nonEmpty(options.candidateSha256);
  const generator = options.generator && typeof options.generator === "object" ? {
    host: nonEmpty(options.generator.host),
    id: nonEmpty(options.generator.id),
    contextId: nonEmpty(options.generator.contextId),
  } : {};
  const job = options.job && typeof options.job === "object" ? options.job : {};
  const key = `${nonEmpty(job.pipeline?.identityRole)}:${nonEmpty(job.pipeline?.storyStage)}`;
  const fileName = basename(nonEmpty(options.fileName || job.fileName));
  if (!workflowId || !castId || !candidateSha256 || !generator.host || !generator.id || !generator.contextId || key.startsWith(":") || !fileName) {
    throw new Error("Identity-pack job input requires complete workflow, cast, candidate, generator, role, and file-name bindings.");
  }
  const referenceImagePaths = Array.isArray(job.referenceImagePaths) ? job.referenceImagePaths.map((entry) => resolve(entry)) : [];
  const referenceAssets = await Promise.all(referenceImagePaths.map(async (path) => ({ path, sha256: await sha256Path(path) })));
  const input = {
    version: KOYA_IDENTITY_PACK_GENERATION_CHECKPOINT_VERSION,
    workflowId,
    castId,
    candidateSha256,
    generator,
    key,
    prompt: nonEmpty(job.prompt),
    model: nonEmpty(job.model),
    aspectRatio: nonEmpty(job.aspectRatio),
    imageSize: nonEmpty(job.imageSize),
    quality: nonEmpty(job.quality),
    referenceAssets,
    fileName,
  };
  return { input, inputSha256: createHash("sha256").update(JSON.stringify(input)).digest("hex") };
}

export async function prepareKoyaIdentityGenerationImport(options = {}) {
  const canvasDir = resolve(nonEmpty(options.canvasDir));
  const importMapPath = assertInsideDirectory(canvasDir, options.importMapPath, "Identity generation import map");
  const importMap = await readJson(importMapPath);
  if (importMap.version !== KOYA_IDENTITY_GENERATION_IMPORT_VERSION) {
    throw new Error(`Identity generation import map must use ${KOYA_IDENTITY_GENERATION_IMPORT_VERSION}.`);
  }
  const jobs = Array.isArray(options.jobs) ? options.jobs : [];
  const generator = options.generator && typeof options.generator === "object" ? options.generator : {};
  const generationScopeId = nonEmpty(options.generationScopeId);
  for (const [label, actual, declared] of [
    ["workflowId", options.workflowId, importMap.workflowId],
    ["castId", options.castId, importMap.castId],
    ["candidateSha256", options.candidateSha256, importMap.candidateSha256],
    ["generator.host", generator.host, importMap.generator?.host],
    ["generator.id", generator.id, importMap.generator?.id],
    ["generator.contextId", generator.contextId, importMap.generator?.contextId],
    ["generationScopeId", generationScopeId, importMap.generationScopeId],
  ]) {
    if (nonEmpty(actual) !== nonEmpty(declared)) throw new Error(`Identity generation import ${label} does not match the official job.`);
  }
  const entries = Array.isArray(importMap.entries) ? importMap.entries : [];
  const expectedKeys = jobs.map((job) => `${nonEmpty(job.pipeline?.identityRole)}:${nonEmpty(job.pipeline?.storyStage)}`);
  if (entries.length !== jobs.length || new Set(entries.map((entry) => nonEmpty(entry?.key))).size !== entries.length) {
    throw new Error("Identity generation import must map every official job exactly once.");
  }
  if (expectedKeys.some((key) => !entries.some((entry) => nonEmpty(entry?.key) === key))) {
    throw new Error("Identity generation import is missing an official role/storyStage job.");
  }
  const importedByKey = new Map();
  for (const job of jobs) {
    const key = `${nonEmpty(job.pipeline?.identityRole)}:${nonEmpty(job.pipeline?.storyStage)}`;
    const entry = entries.find((candidate) => nonEmpty(candidate?.key) === key);
    const sourceFile = assertInsideDirectory(canvasDir, nonEmpty(entry?.sourceFile), `Identity generation import source ${key}`);
    const sourceSha256 = nonEmpty(entry?.sourceSha256);
    const actualSourceSha256 = await sha256Path(sourceFile);
    if (!sourceSha256 || sourceSha256 !== actualSourceSha256) throw new Error(`Identity generation import source SHA-256 mismatch for ${key}.`);
    const { inputSha256 } = await buildKoyaIdentityPackJobInput({
      workflowId: options.workflowId,
      castId: options.castId,
      candidateSha256: options.candidateSha256,
      generator,
      job,
      fileName: job.fileName,
    });
    if (nonEmpty(entry?.inputSha256) !== inputSha256) throw new Error(`Identity generation import input SHA-256 mismatch for ${key}.`);
    assertGeneratedImageBuffer(await readFile(sourceFile), sourceFile);
    importedByKey.set(key, { sourceFile, sourceSha256, inputSha256 });
  }
  const evidence = {
    version: KOYA_IDENTITY_GENERATION_IMPORT_VERSION,
    importMapPath,
    importMapSha256: await sha256Path(importMapPath),
  };
  return {
    evidence,
    generateImage: async (job) => {
      const key = `${nonEmpty(job.pipeline?.identityRole)}:${nonEmpty(job.pipeline?.storyStage)}`;
      const imported = importedByKey.get(key);
      if (!imported) throw new Error(`No SHA-bound generated source was imported for ${key}.`);
      return { buffer: await readFile(imported.sourceFile) };
    },
  };
}

export async function generateKoyaIdentityPackAssets(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  const canvasDir = resolve(options.canvasDir || join(projectDir, "canvas"));
  const identityPackDir = assertInsideDirectory(canvasDir, options.identityPackDir, "Identity-pack output directory");
  const workflowId = nonEmpty(options.workflowId);
  const castId = nonEmpty(options.castId);
  const candidateSha256 = nonEmpty(options.candidateSha256);
  const generator = {
    host: nonEmpty(options.generatorHost),
    id: nonEmpty(options.generatorId),
    contextId: nonEmpty(options.generatorContextId),
  };
  const jobs = Array.isArray(options.jobs) ? options.jobs : [];
  const generationScopeId = nonEmpty(options.generationScopeId);
  if (!workflowId || !castId || !candidateSha256) throw new Error("workflowId, castId, and candidateSha256 are required for identity-pack generation.");
  if (!generator.host || !generator.id || !generator.contextId) throw new Error("Identity-pack generation requires generatorHost, generatorId, and generatorContextId provenance.");
  if (jobs.length < (generationScopeId ? 1 : 2)) throw new Error(generationScopeId
    ? "Identity-pack repair generation requires at least one failed role job."
    : "Identity-pack generation requires at least turnaround and expression jobs.");
  const keys = jobs.map((job) => `${nonEmpty(job.pipeline?.identityRole)}:${nonEmpty(job.pipeline?.storyStage)}`);
  if (keys.some((key) => key.startsWith(":")) || new Set(keys).size !== keys.length) throw new Error("Identity-pack jobs require unique identityRole/storyStage keys.");
  const fileNames = jobs.map((job) => basename(nonEmpty(job.fileName)));
  if (fileNames.some((name) => !name) || new Set(fileNames).size !== fileNames.length) throw new Error("Identity-pack jobs require unique output file names.");
  await mkdir(identityPackDir, { recursive: true });
  const checkpointKey = createHash("sha256").update(`${workflowId}\n${castId}${generationScopeId ? `\n${generationScopeId}` : ""}`).digest("hex");
  const checkpointPath = join(identityPackDir, `.generation-${checkpointKey}.json`);
  const lockPath = join(canvasDir, "character-identity-generation-locks", checkpointKey);
  const generateImage = options.generateImage || generateImageMedia;
  return withCanvasFileLock(lockPath, async () => {
    let checkpoint = null;
    if (await exists(checkpointPath)) checkpoint = await readJson(checkpointPath);
    const generationImportEvidence = options.generationImportEvidence && typeof options.generationImportEvidence === "object"
      ? options.generationImportEvidence
      : null;
    const binding = {
      workflowId,
      castId,
      candidateSha256,
      generator,
      ...(generationScopeId ? { generationScopeId } : {}),
      ...(generationImportEvidence ? { generationImportEvidence } : {}),
    };
    const bindingSha256 = createHash("sha256").update(JSON.stringify(binding)).digest("hex");
    if (checkpoint && (checkpoint.version !== KOYA_IDENTITY_PACK_GENERATION_CHECKPOINT_VERSION || checkpoint.bindingSha256 !== bindingSha256)) {
      throw new Error("Identity-pack checkpoint belongs to different candidate bytes or generator provenance.");
    }
    checkpoint ||= {
      version: KOYA_IDENTITY_PACK_GENERATION_CHECKPOINT_VERSION,
      ...binding,
      bindingSha256,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      entries: [],
    };
    // チェックポイントは1つの共有ファイル。並列で生成するようになったので、
    // 書き込みだけは直列に流す。同時に writeJsonAtomic を呼ぶと、
    // 後から始まった書き込みが先に終わって古い状態が残ることがある。
    let checkpointWrite = Promise.resolve();
    const writeCheckpoint = () => {
      checkpointWrite = checkpointWrite.then(async () => {
        checkpoint.updatedAt = new Date().toISOString();
        await writeJsonAtomic(checkpointPath, checkpoint);
      }, async () => {
        checkpoint.updatedAt = new Date().toISOString();
        await writeJsonAtomic(checkpointPath, checkpoint);
      });
      return checkpointWrite;
    };
    // identity-pack の有償ジョブは通常2件（三面図シート1枚＋表情シート1枚。
    // 8角度・12セルはシート画像の中のセルであって、別々の生成ではない）。
    // 開眼差分が要るキャラで3件、衣装段階が複数あればその数だけ増える。
    // 件数は多くないが、styling 側が元から Promise.all だったのに対して
    // ここだけ逐次という非対称があり、待ち時間がそのまま件数に比例していた。
    // 台数制御は画像生成用のAIMD（R62）に任せる。429と使用上限、
    // 16GB機のRSSガードまで面倒を見てくれるのが手書きプールとの違い。
    const identityConcurrency = new AdaptiveConcurrencyController({
      mode: "auto",
      initial: Math.max(1, Number(options.identityPackConcurrency) || 4),
    });
    const resultsByIndex = new Array(jobs.length);
    let reusedCount = 0;
    let generatedCount = 0;
    let recoveredCount = 0;

    const makeJob = (job, index) => async () => {
      const key = keys[index];
      const assetFile = assertInsideDirectory(identityPackDir, join(identityPackDir, fileNames[index]), `Identity-pack output ${key}`);
      const { inputSha256 } = await buildKoyaIdentityPackJobInput({
        workflowId,
        castId,
        candidateSha256,
        generator,
        job,
        fileName: fileNames[index],
      });
      let entry = checkpoint.entries.find((row) => row.key === key);
      if (entry && entry.inputSha256 !== inputSha256) throw new Error(`Identity-pack checkpoint input changed for ${key}; use a new workflow/cast generation scope.`);
      const outputExists = await exists(assetFile);
      if (outputExists) {
        const buffer = await readFile(assetFile);
        assertGeneratedImageBuffer(buffer, assetFile);
        const outputSha256 = createHash("sha256").update(buffer).digest("hex");
        if (!entry) throw new Error(`Identity-pack output exists without a matching checkpoint: ${assetFile}`);
        if (entry.status === "generated") {
          if (entry.outputSha256 !== outputSha256) throw new Error(`Identity-pack checkpoint digest mismatch for ${key}.`);
          reusedCount += 1;
          resultsByIndex[index] = { assetFile, sha256: outputSha256, reused: true };
          return;
        }
        if (entry.status === "generating") {
          entry = { ...entry, status: "generated", outputSha256, completedAt: new Date().toISOString(), recoveredAfterInterruption: true, error: "" };
          checkpoint.entries = checkpoint.entries.map((row) => row.key === key ? entry : row);
          await writeCheckpoint();
          recoveredCount += 1;
          resultsByIndex[index] = { assetFile, sha256: outputSha256, reused: true, recoveredAfterInterruption: true };
          return;
        }
        throw new Error(`Identity-pack output for ${key} is not recoverable from checkpoint status ${entry.status || "missing"}.`);
      }
      entry = {
        ...(entry || {}),
        key,
        identityRole: nonEmpty(job.pipeline?.identityRole),
        storyStage: nonEmpty(job.pipeline?.storyStage),
        assetFile,
        inputSha256,
        status: "generating",
        startedAt: new Date().toISOString(),
        completedAt: "",
        outputSha256: "",
        recoveredAfterInterruption: false,
        error: "",
      };
      checkpoint.entries = [...checkpoint.entries.filter((row) => row.key !== key), entry];
      await writeCheckpoint();
      try {
        const media = await generateImage({ ...job, imageCount: 1 });
        const buffer = media?.buffer instanceof Buffer ? media.buffer : media?.buffer ? Buffer.from(media.buffer) : null;
        if (!buffer) throw new Error(`Identity-pack generation returned no image for ${key}.`);
        assertGeneratedImageBuffer(buffer, key);
        await writeBufferAtomic(assetFile, buffer);
        const outputSha256 = createHash("sha256").update(buffer).digest("hex");
        entry = { ...entry, status: "generated", outputSha256, completedAt: new Date().toISOString(), error: "" };
        checkpoint.entries = checkpoint.entries.map((row) => row.key === key ? entry : row);
        await writeCheckpoint();
        generatedCount += 1;
        resultsByIndex[index] = { assetFile, sha256: outputSha256, reused: false };
      } catch (error) {
        entry = { ...entry, status: "failed", error: String(error?.message || error), completedAt: new Date().toISOString() };
        checkpoint.entries = checkpoint.entries.map((row) => row.key === key ? entry : row);
        await writeCheckpoint();
        throw error;
      }
    };

    const outcomes = await runWithAdaptiveConcurrency(
      jobs.map((job, index) => makeJob(job, index)),
      identityConcurrency,
    );
    // 途中で書いたチェックポイントを全て流し切ってから結果を返す。
    await checkpointWrite;
    const failed = outcomes.filter((outcome) => outcome && outcome.ok === false);
    if (failed.length > 0) {
      // 1枚でも落ちたら identity-pack は不完全。部分的な成果で先へ進ませない。
      throw failed[0].error instanceof Error
        ? failed[0].error
        : new Error(String(failed[0].error || "Identity-pack generation failed"));
    }
    const results = resultsByIndex.filter(Boolean);
    return { results, checkpointPath, resumed: reusedCount + recoveredCount > 0, reusedCount, recoveredCount, generatedCount };
  }, { timeoutMs: 60_000, staleMs: 120_000 });
}

function assertInsideDirectory(root, candidate, label) {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === "" || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`${label} must be a file inside ${resolve(root)}.`);
  }
  return resolve(candidate);
}

async function validateApprovedOutfitStageAuthorities({ projectDir, canvasDir, cast }) {
  const stages = Array.isArray(cast?.outfitStages) ? cast.outfitStages : [];
  const declared = stages.filter((stage) => nonEmpty(stage?.referenceAssetFile) || nonEmpty(stage?.referenceAssetSha256));
  if (declared.length === 0) return [];
  const selection = cast?.stylingSelection;
  const round = (cast?.stylingVariationRounds || []).find((entry) => entry.id === selection?.roundId);
  if (!selection || !round || round.status !== "selected") {
    throw new Error(`${cast.name} outfit-stage authorities require a completed SHA-bound styling selection before paid identity generation.`);
  }
  const accepted = round.options.filter((option) => ["passed", "selected"].includes(option.status) && option.assetFile && option.sha256);
  const validated = [];
  for (const stage of declared) {
    const assetFile = assertInsideDirectory(canvasDir, resolve(projectDir, nonEmpty(stage.referenceAssetFile)), `${cast.name} outfit authority ${stage.id}`);
    const expectedSha256 = nonEmpty(stage.referenceAssetSha256);
    if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new Error(`${cast.name} outfit authority ${stage.id} requires lowercase SHA-256 provenance.`);
    const actualSha256 = await sha256Path(assetFile);
    if (actualSha256 !== expectedSha256) throw new Error(`${cast.name} outfit authority ${stage.id} path/SHA-256 changed after client approval.`);
    const reviewedOption = accepted.find((option) => resolve(option.assetFile) === assetFile && option.sha256 === actualSha256);
    if (!reviewedOption) {
      throw new Error(`${cast.name} outfit authority ${stage.id} is not an independently passing option in the selected styling round.`);
    }
    validated.push({ storyStage: stage.id, assetFile, sha256: actualSha256, stylingOptionId: reviewedOption.id });
  }
  return validated;
}

// Show-bible eye-open variants may name client-approved open-eye images as
// generation authorities. They must be SHA-bound canvas files; the workflow
// stores them as absolute paths so identity jobs do not depend on the cwd.
async function resolveApprovedEyeOpenVariantAuthorities({ projectDir, canvasDir, member }) {
  const variants = Array.isArray(member?.eyeOpenVariants) ? member.eyeOpenVariants : [];
  const resolved = [];
  for (const variant of variants) {
    const referenceAssets = [];
    for (const asset of Array.isArray(variant?.referenceAssets) ? variant.referenceAssets : []) {
      const assetFile = assertInsideDirectory(canvasDir, resolve(projectDir, nonEmpty(asset?.path)), `${member.name} eye-open authority ${variant.id}`);
      const expectedSha256 = nonEmpty(asset?.sha256);
      if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new Error(`${member.name} eye-open authority ${variant.id} requires lowercase SHA-256 provenance.`);
      if (await sha256Path(assetFile) !== expectedSha256) throw new Error(`${member.name} eye-open authority ${variant.id} path/SHA-256 changed after client approval: ${assetFile}`);
      referenceAssets.push({ path: assetFile, sha256: expectedSha256 });
    }
    resolved.push({ ...variant, referenceAssets });
  }
  return resolved;
}

export async function assertKoyaStylingSequence(authority, member, cast, requestedSpecPath = "") {
  const expectedPaths = koyaDeclaredStylingSpecPaths(authority, member);
  const selectedRounds = (cast?.stylingVariationRounds || []).filter((round) => round.status === "selected");
  const selectedPaths = selectedRounds.map((round) => resolve(nonEmpty(round.specPath)));
  if (selectedPaths.some((path, index) => path !== expectedPaths[index])) throw new Error(`${member.name} styling history is not the show-bible declared sequence.`);
  for (const round of selectedRounds) {
    if (!nonEmpty(round.specPath) || !/^[a-f0-9]{64}$/u.test(nonEmpty(round.specSha256)) || round.specCharacterId !== member.id) throw new Error(`${member.name} has a selected styling round without declared spec provenance.`);
    if (await sha256Path(round.specPath) !== round.specSha256) throw new Error(`${member.name} styling spec bytes changed after selection: ${round.specPath}`);
  }
  if (requestedSpecPath) {
    const nextPath = expectedPaths[selectedRounds.length];
    if (!nextPath) throw new Error(`${member.name} has already completed every show-bible styling round.`);
    if (resolve(requestedSpecPath) !== nextPath) throw new Error(`${member.name} must use the next declared styling spec in order: ${nextPath}`);
  }
  return { expectedPaths, selectedRounds, complete: selectedRounds.length === expectedPaths.length };
}

export function recommendedKoyaRenderConcurrency({
  requested,
  cameraOversample = 1,
  cpuCount = cpus().length || 1,
  totalMemoryBytes = totalmem(),
} = {}) {
  if (Number.isFinite(Number(requested))) {
    return Math.max(1, Math.min(4, Math.round(Number(requested))));
  }
  const cpuBound = Math.max(1, Math.min(4, Math.floor(Number(cpuCount) || 1)));
  if (Number(cameraOversample) < 3) return cpuBound;
  // A 3x camera pass expands every 1080p source to 5760x3240 before zoompan.
  // Keep roughly 6 GiB of total system memory per concurrent ffmpeg so long
  // episodes do not turn four quality renders into memory-pressure thrashing.
  const memoryBound = Math.max(1, Math.floor(Number(totalMemoryBytes) / (6 * 1024 ** 3)));
  return Math.min(cpuBound, memoryBound);
}

export function koyaSpeechPronunciationsFromCharacterBible(characterBible = {}) {
  const bySource = new Map();
  for (const entry of characterBible.pronunciations || []) {
    if (nonEmpty(entry?.from) && nonEmpty(entry?.to)) {
      bySource.set(nonEmpty(entry.from), nonEmpty(entry.to));
    }
  }
  for (const character of characterBible.cast || []) {
    for (const [from, to] of Object.entries(character.pronunciationMap || {})) {
      if (nonEmpty(from) && nonEmpty(to)) bySource.set(nonEmpty(from), nonEmpty(to));
    }
    if (nonEmpty(character.name) && nonEmpty(character.pronunciation)) {
      bySource.set(nonEmpty(character.name), nonEmpty(character.pronunciation));
    }
  }
  return [...bySource.entries()]
    .sort(([left], [right]) => Array.from(right).length - Array.from(left).length)
    .map(([from, to]) => ({ from, to }));
}

export function applyKoyaCharacterBibleSpeechDirectives(manifestInput, characterBible) {
  const manifest = structuredClone(manifestInput);
  const merged = new Map((manifest.speech?.pronunciations || []).map((entry) => [entry.from, entry.to]));
  for (const entry of koyaSpeechPronunciationsFromCharacterBible(characterBible)) merged.set(entry.from, entry.to);
  manifest.speech = {
    ...(manifest.speech || {}),
    pronunciations: [...merged.entries()]
      .filter(([from, to]) => nonEmpty(from) && nonEmpty(to))
      .sort(([left], [right]) => Array.from(right).length - Array.from(left).length)
      .map(([from, to]) => ({ from, to })),
  };
  const utteranceById = new Map((manifest.utterances || []).map((entry) => [entry.id, entry]));
  const seenDirectionIds = new Set();
  for (const direction of characterBible.speechDirections || []) {
    const utteranceId = nonEmpty(direction?.utteranceId);
    if (!utteranceId) throw new Error("Character-bible speech direction requires utteranceId.");
    if (seenDirectionIds.has(utteranceId)) {
      throw new Error(`Duplicate character-bible speech direction: ${utteranceId}`);
    }
    seenDirectionIds.add(utteranceId);
    const utterance = utteranceById.get(utteranceId);
    if (!utterance) throw new Error(`Unknown character-bible speech direction utterance: ${utteranceId}`);
    if (!Object.hasOwn(direction, "performancePrompt") || typeof direction.performancePrompt !== "string") {
      throw new Error(`Character-bible speech direction ${utteranceId} requires a string performancePrompt.`);
    }
    // An explicit empty string is meaningful: punctuation and wording direct
    // the actor without an additional provider tag. This is useful when an
    // otherwise correct angry line becomes vocally distorted by a strong tag.
    utterance.performancePrompt = direction.performancePrompt.trim();
  }
  return manifest;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

function episodePaths(projectDir, episodeId) {
  const root = resolve(projectDir);
  const episodeDir = join(root, "canvas/manga-videos", episodeId);
  const assetDir = join(root, "canvas/assets", episodeId);
  return {
    projectDir: root,
    canvasDir: join(root, "canvas"),
    episodeDir,
    assetDir,
    manifestPath: join(episodeDir, "episode-manifest.json"),
    statePath: join(episodeDir, "koya-production-state.json"),
    contractSnapshotPath: join(episodeDir, "koya-contract-resolved.json"),
    imagePlanPath: join(assetDir, "script-image-plan.json"),
    imageLedgerPath: join(assetDir, "script-image-ledger.json"),
    wardrobeReadinessPath: join(assetDir, KOYA_WARDROBE_READINESS_FILE_NAME),
    sourceFaceReportPath: join(episodeDir, "source-face-placement.json"),
  };
}

async function updateState(paths, patch) {
  let previous = {};
  try { previous = await readJson(paths.statePath); } catch {}
  const state = {
    version: "koya-production-state-v1",
    episodeId: patch.episodeId || previous.episodeId,
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(paths.episodeDir, { recursive: true });
  await writeJsonAtomic(paths.statePath, state);
  return state;
}

/**
 * Opt-in cut video substitution: runs after speech (cut durations are final)
 * and before render. Only cuts marked in the resolved contract's
 * videoSubstitution section are touched. Paid generation needs
 * confirmPaidVideoGeneration; a failed, in-flight or exhausted clip stops here
 * with a checkpoint instead of silently rendering the still.
 */
export async function substituteKoyaMangaCutVideos(options = {}, runtime = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  const paths = episodePaths(projectDir, options.episodeId);
  const resolved = await resolveKoyaMangaProductionContract({
    projectDir,
    episodeId: options.episodeId,
    contractPath: options.contractPath,
    overridePath: options.overridePath,
  });
  const marked = (resolved.contract.videoSubstitution?.cuts || []).length > 0;
  const storedManifest = await readJson(paths.manifestPath).catch(() => null);
  const leftoverBinding = (storedManifest?.cuts || []).some((cut) => cut.videoSubstitution);
  const stillFallbackRequested = (options.stillFallback?.cutIds || []).length > 0;
  if (!marked && !leftoverBinding && !stillFallbackRequested) {
    // The default episode: no preflight, no reads beyond this, no writes.
    if (nonEmpty(options.videoSubstitutionCutIds)) {
      throw new Error(`--cut-ids names cuts that are not marked for video substitution: ${options.videoSubstitutionCutIds}`);
    }
    return {
      episodeId: options.episodeId,
      status: "not-applicable",
      rows: [],
      blockedCuts: [],
      removedUnmarkedBindings: [],
      manifestChanged: false,
      ledgerPath: "",
      stageReportPath: "",
      paths,
      resolved,
      state: await readJson(paths.statePath).catch(() => ({})),
      waiting: false,
      blocked: false,
    };
  }
  // A paid stage: bind it to the same outer Video Harness Job as speech/render.
  const preflight = await assertKoyaFullPreflight(options, runtime);
  const expectedOuterJobBinding = requiredOuterJobBindingFromPreflight(preflight);
  if (!storedManifest) throw new Error(`Video substitution needs the prepared manifest: ${paths.manifestPath}`);
  const manifestOuterJobBinding = assertKoyaOuterJobBinding(storedManifest?.production?.outerJobBinding, { required: true });
  if (!sameKoyaOuterJobBinding(expectedOuterJobBinding, manifestOuterJobBinding)) {
    throw new Error("Koya video substitution manifest belongs to another outer Video Harness Job.");
  }
  const result = await runCutVideoSubstitutions({
    manifestPath: paths.manifestPath,
    episodeDir: paths.episodeDir,
    contract: resolved.contract,
    confirmPaidGeneration: options.confirmPaidVideoGeneration === true,
    // Not options.retryFailed: in full that flag retries failed images, and
    // re-sending a paid clip must stay a separate, explicit decision.
    retryFailed: options.retryFailedVideo === true,
    cutIds: options.videoSubstitutionCutIds,
    stillFallback: options.stillFallback || null,
    generateVideo: options.generateVideo,
    durationOptionsFor: options.durationOptionsFor,
  });
  const waiting = result.status === "waiting";
  const blocked = result.status === "blocked";
  // `blocked` is the stop flag callers branch on; the per-cut reasons stay
  // readable under blockedCuts.
  const outcome = { ...result, blockedCuts: result.blocked, paths, resolved, waiting, blocked };
  if (result.status === "not-applicable") {
    // No marked cut: leave the production state exactly as speech left it.
    return { ...outcome, state: await readJson(paths.statePath).catch(() => ({})) };
  }
  const state = await updateState(paths, {
    status: blocked ? "video-substitution-blocked" : waiting ? "waiting-paid-video-confirmation" : "video-substitution-ready",
    currentStage: blocked || waiting ? "video-substitution" : "render",
    videoSubstitutionReportPath: result.stageReportPath,
    knownRemainingIssues: result.blocked.map((row) => ({
      id: `video-substitution:${row.cutId}:${row.reason}`,
      detail: row.detail,
      next: row.next,
    })),
  });
  return { ...outcome, state };
}

export async function planKoyaMangaProduction(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.scriptPath && !options.scriptText) throw new Error("scriptPath or scriptText is required.");
  const scriptText = nonEmpty(options.scriptText) || await readFile(resolve(options.scriptPath), "utf8");
  const registry = await readCharacterRegistry({ projectDir });
  const preliminary = createMangaScriptImagePlan({
    scriptText,
    title: options.title,
    episodeId: options.episodeId,
    registry,
    canvasDir: join(projectDir, "canvas"),
    model: options.imageModel,
  });
  const episodeId = preliminary.episodeId || preliminary.manifest.id;
  const paths = episodePaths(projectDir, episodeId);
  const resolved = await resolveKoyaMangaProductionContract({
    projectDir,
    episodeId,
    contractPath: options.contractPath,
    overridePath: options.overridePath,
  });
  // The episode override owns hash-bound visual direction (for example a
  // forced cast-distribution montage). Resolve it before the final plan so a
  // re-plan cannot silently discard those authored decisions merely because
  // the default asset directory already matched.
  const planInput = {
    scriptText,
    title: options.title,
    episodeId,
    registry,
    canvasDir: paths.canvasDir,
    assetDir: paths.assetDir,
    model: options.imageModel,
    protagonistSpeakerId: options.protagonistSpeakerId,
    protagonistSpeakerName: options.protagonistSpeakerName,
    visualPlanOverrides: resolved.episodeOverride?.visualPlan,
  };
  const plan = createMangaScriptImagePlan(planInput);
  // A scene script names its protagonist (主人公: はい). An explicit
  // --protagonist-speaker-id that disagrees stops here, before any paid step,
  // whether or not the script has narration.
  assertKoyaDeclaredProtagonist(plan.manifest, options.protagonistSpeakerId);
  plan.sourceScript = {
    path: options.scriptPath ? resolve(options.scriptPath) : "",
    text: scriptText,
  };
  const previousPlan = await exists(paths.imagePlanPath) ? await readJson(paths.imagePlanPath) : null;
  const previousState = await exists(paths.statePath) ? await readJson(paths.statePath) : null;
  const generatorProvenance = previousPlan?.production?.generatorProvenance
    || previousState?.generatorProvenance
    || resolveKoyaAgentProvenance({
      role: "generator",
      host: options.generatorHost,
      id: options.generatorId,
      contextId: options.generatorContextId,
    });
  if (previousState?.status === resolved.contract.lifecycle.completionStatus && options.allowCompletedReuse !== true) {
    throw new Error(
      `Episode ID ${episodeId} is already complete. Choose a new episode ID so the approved MP4 and assets remain untouched.`,
    );
  }
  if (previousPlan?.scriptSha256 && previousPlan.scriptSha256 !== plan.scriptSha256) {
    throw new Error(
      `Episode ID ${episodeId} already belongs to a different script. Choose a new episode ID; existing assets were not overwritten.`,
    );
  }
  const requestedCharacterBiblePath = options.characterBiblePath
    || previousPlan?.production?.characterBiblePath
    || previousState?.characterBiblePath
    || "";
  let characterBible = null;
  if (requestedCharacterBiblePath) {
    const characterBiblePath = resolve(requestedCharacterBiblePath);
    characterBible = await readJson(characterBiblePath);
    if (characterBible.episodeId && characterBible.episodeId !== episodeId) {
      throw new Error(`Character bible episode ID mismatch: ${characterBible.episodeId} != ${episodeId}`);
    }
    if (!Array.isArray(characterBible.cast) || characterBible.cast.length === 0) {
      throw new Error("Character bible must contain a non-empty cast array.");
    }
    plan.production = {
      ...(plan.production || {}),
      characterBiblePath,
      characterBibleVersion: characterBible.version || "",
    };
  }
  plan.production = {
    ...(plan.production || {}),
    generatorProvenance,
  };
  const incidentSeedPath = join(projectDir, "config", "koya-manga-quality-incidents.json");
  const incidentLedgerPath = join(paths.canvasDir, "manga-quality-harness", "incident-ledger.json");
  if (await exists(incidentSeedPath) || await exists(incidentLedgerPath)) {
    const incidentLedger = mergeMangaQualityIncidentLedgers(
      await exists(incidentSeedPath) ? await readJson(incidentSeedPath) : { incidents: [] },
      await exists(incidentLedgerPath) ? await readJson(incidentLedgerPath) : { incidents: [] },
    );
    plan.production.channelDirectives = {
      ...(plan.production.channelDirectives || {}),
      knownIncidents: (incidentLedger.incidents || [])
        .filter((incident) => ["instruction", "hard-gate"].includes(incident.promotion))
        .map((incident) => `${incident.promotion}:${incident.rule}:${incident.failure}`),
    };
    plan.production.incidentLedger = {
      seedPath: incidentSeedPath,
      runtimePath: incidentLedgerPath,
      version: incidentLedger.version,
      promotedIncidentCount: plan.production.channelDirectives.knownIncidents.length,
    };
  }
  const hasNarration = (plan.manifest?.utterances || []).some((entry) => (
    entry.speakerId === "narration" || entry.preset === "narration"
  ));
  if (resolved.contract.audio.narrationVoicePolicy === "protagonist-voice" && hasNarration) {
    const protagonist = resolveKoyaProtagonistSpeaker(
      plan.manifest,
      options.protagonistSpeakerId
        || previousPlan?.production?.protagonistSpeakerName
        || previousPlan?.production?.protagonistSpeakerId
        || previousState?.protagonistSpeakerName
        || previousState?.protagonistSpeakerId,
    );
    plan.production = {
      ...(plan.production || {}),
      protagonistSpeakerId: protagonist.speakerId,
      protagonistSpeakerName: protagonist.speakerName,
      narrationVoicePolicy: "protagonist-voice",
    };
  }
  const authority = await readKoyaChannelAuthority({ projectDir });
  assertProductionChannelAuthority(authority, "有償生成を伴う本編プラン", {
    // ジャンル共通ハーネスとして pack 無しで回す経路をテストが通るため。
    // 本番の呼び出しはこれを渡さない。
    allowBorrowedChannelData: options.allowBorrowedChannelData === true,
  });
  const validationCanary = resolveKoyaValidationCanary({
    episodeId,
    policy: resolved.episodeOverride?.validationCanary,
    showBible: authority.showBible,
  });
  if (!validationCanary.pass) {
    throw new Error(`Koya validation canary policy failed: ${validationCanary.failures.join("; ")}`);
  }
  const storyReviewPath = nonEmpty(options.storyReviewPath)
    || nonEmpty(previousPlan?.production?.storyGovernance?.reviewPath)
    || nonEmpty(previousState?.storyReviewPath);
  const storyReview = storyReviewPath ? await readJson(resolve(storyReviewPath)) : null;
  const declaredCast = (characterBible?.cast || []).flatMap((entry) => [entry?.id, entry?.name]).filter(Boolean);
  const storyAudit = auditKoyaStory({
    showBible: authority.showBible,
    registry,
    scriptText,
    title: plan.manifest?.title,
    parsed: plan.manifest,
    storyReview,
    declaredCast,
    enforce: authority.source === "project",
    generatorProvenance,
  });
  if (!storyAudit.pass) {
    throw new Error(`Koya show-bible audit failed before generation: ${storyAudit.failures.join("; ")}`);
  }
  const rosterReviewAudit = await auditKoyaCharacterRosterReview({
    projectDir,
    showBible: authority.showBible,
    registry,
    reviewPath: options.rosterReviewPath,
  });
  const fixedCastReadiness = auditKoyaFixedCastReadiness({
    showBible: authority.showBible,
    registry,
    parsed: plan.manifest,
    characterBible,
    enforce: authority.source === "project",
    rosterReviewAudit,
    validationCanary,
  });
  if (!fixedCastReadiness.pass) {
    throw new Error(`Koya fixed-cast readiness failed before generation: ${fixedCastReadiness.failures.join("; ")}`);
  }
  // Rebuild the image jobs with the show-bible eye-open policy: eye-open
  // sheets reach only the images whose beat needs them, and a declared beat
  // without an approved sheet stops here, before any paid call.
  const eyeOpenPolicy = buildKoyaEyeOpenPolicy({ showBible: authority.showBible, registry, storyReview });
  const eyeOpenPlan = createMangaScriptImagePlan({
    ...planInput,
    eyeOpen: { candidates: eyeOpenPolicy.candidates, reviewedBeats: eyeOpenPolicy.reviewedBeats },
  });
  // Eye-open is optional per episode; only unresolved or unbound beats stop
  // (inside createMangaScriptImagePlan). Too many eye-open scenes is a warning.
  const eyeOpenGovernance = auditKoyaEyeOpenPlan({ policy: eyeOpenPolicy, eyeOpenPlan: eyeOpenPlan.eyeOpen, cuts: eyeOpenPlan.manifest?.cuts });
  Object.assign(plan, { ...eyeOpenPlan, sourceScript: plan.sourceScript, production: plan.production });
  plan.production = {
    ...(plan.production || {}),
    channelAuthority: {
      source: authority.source,
      root: authority.root,
      showBiblePath: authority.paths.show,
      showBibleVersion: authority.showBible.version,
      locationBiblePath: authority.paths.locations,
      locationBibleVersion: authority.locationBible.version,
      thumbnailContractPath: authority.paths.thumbnail,
      thumbnailContractVersion: authority.thumbnailContract.version,
    },
    storyGovernance: {
      ...storyAudit,
      reviewPath: storyReviewPath ? resolve(storyReviewPath) : "",
    },
    fixedCastGovernance: fixedCastReadiness,
    eyeOpenGovernance,
    validationCanary: validationCanary.active ? validationCanary : { active: false, publicationEligible: true },
  };
  await Promise.all([
    mkdir(paths.assetDir, { recursive: true }),
    mkdir(paths.episodeDir, { recursive: true }),
  ]);
  await Promise.all([
    writeJsonAtomic(paths.imagePlanPath, plan),
    writeJsonAtomic(paths.contractSnapshotPath, {
      version: resolved.contract.version,
      digest: resolved.digest,
      contractPath: resolved.contractPath,
      episodeOverridePath: resolved.episodeOverridePath,
      contract: resolved.contract,
    }),
  ]);
  const state = await updateState(paths, {
    episodeId,
    status: "planned",
    currentStage: "images",
    scriptPath: options.scriptPath ? resolve(options.scriptPath) : "",
    imagePlanPath: paths.imagePlanPath,
    scriptSha256: plan.scriptSha256,
    contractSnapshotPath: paths.contractSnapshotPath,
    contractDigest: resolved.digest,
    protagonistSpeakerId: plan.production?.protagonistSpeakerId || "",
    protagonistSpeakerName: plan.production?.protagonistSpeakerName || "",
    characterBiblePath: plan.production?.characterBiblePath || "",
    storyReviewPath: plan.production?.storyGovernance?.reviewPath || "",
    storyAuditPass: plan.production?.storyGovernance?.pass === true,
    generatorProvenance,
    validationCanary: validationCanary.active ? {
      version: validationCanary.version,
      active: true,
      scope: validationCanary.scope,
      publicationEligible: false,
    } : { active: false, publicationEligible: true },
    knownRemainingIssues: [],
  });
  return { episodeId, paths, plan, resolved, state };
}

/**
 * The paid image stage. `runtime` lets a test use the test-only direct
 * preflight and observe the call order (wardrobe check, plan, image
 * pipeline); production passes no runtime.
 */
export async function generateKoyaMangaImages(options = {}, runtime = {}) {
  await assertKoyaFullPreflight(options, runtime);
  // No paid image before the wardrobe-readiness pass (or a recorded override).
  const wardrobe = await (runtime.checkWardrobeReadiness || assertKoyaWardrobeReadinessBeforeImages)(options, {
    runtime,
    stage: "images",
  });
  const planned = await (runtime.planProduction || planKoyaMangaProduction)(options);
  if (wardrobe?.status === "pass" || wardrobe?.status === "overridden") {
    planned.plan.production = {
      ...(planned.plan.production || {}),
      wardrobeReadiness: wardrobe.status === "pass"
        ? { status: "pass", ...wardrobe.binding }
        : { status: "overridden", reason: wardrobe.override.reason, recordedAt: wardrobe.override.recordedAt, scriptDigest: wardrobe.override.scriptDigest },
    };
  }
  const contract = planned.resolved.contract;
  const characterBiblePath = options.characterBiblePath || planned.plan.production?.characterBiblePath || "";
  const characterBible = characterBiblePath ? await readJson(resolve(characterBiblePath)) : null;
  const result = await (runtime.runImagePipeline || runMangaScriptImagePipeline)({
    projectDir: planned.paths.projectDir,
    scriptPath: options.scriptPath,
    scriptText: options.scriptText,
    episodeId: planned.episodeId,
    title: options.title,
    model: options.imageModel || contract.art.imageModel,
    fallbackImageModel: options.imageFallbackModel ?? contract.art.usageLimitFallbackModel,
    qaFallbackProvider: options.qaFallbackProvider ?? contract.art.qaUsageLimitFallbackProvider,
    concurrency: options.imageConcurrency ?? contract.art.imageConcurrency,
    qaConcurrency: options.qaConcurrency ?? contract.art.qaConcurrency,
    maxRetries: options.maxRetries ?? contract.art.maximumQaRetries,
    candidateCount: options.candidateCount ?? contract.art.candidateCount,
    qaCommand: options.qaCommand,
    qaModel: options.qaModel,
    autoSemanticQa: options.autoSemanticQa !== false,
    cast: characterBible?.cast || options.cast,
    characterBible,
    protagonistSpeakerId: planned.plan.production?.protagonistSpeakerId || options.protagonistSpeakerId,
    protagonistSpeakerName: planned.plan.production?.protagonistSpeakerName || options.protagonistSpeakerName,
    visualPlanOverrides: planned.resolved.episodeOverride?.visualPlan,
    retryFailed: options.retryFailed === true,
  });
  const waiting = result.status === "awaiting-character-approval";
  const failed = result.status === "failed";
  const state = await updateState(planned.paths, {
    status: waiting ? "awaiting-character-approval" : failed ? "failed" : "images-ready",
    currentStage: waiting ? "character-approval" : failed ? "images" : "source-face-placement",
    imagePlanPath: result.planPath || planned.paths.imagePlanPath,
    imageLedgerPath: result.ledgerPath || planned.paths.imageLedgerPath,
    knownRemainingIssues: waiting
      ? [{ id: "character-approval", detail: result.message, cast: result.cast }]
      : failed ? [{ id: "image-generation", detail: "One or more image jobs failed." }] : [],
  });
  if (result.planPath && result.plan) {
    result.plan.production = {
      ...(result.plan.production || {}),
      ...(planned.plan.production || {}),
    };
    result.plan.sourceScript = {
      path: options.scriptPath ? resolve(options.scriptPath) : planned.plan.sourceScript?.path || "",
      text: options.scriptText || planned.plan.sourceScript?.text || "",
    };
    await writeJsonAtomic(result.planPath, result.plan);
  }
  return { ...planned, result, state, waiting, failed };
}

export async function generateKoyaCharacterStylingVariations(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  if (!options.workflowId) throw new Error("workflowId is required.");
  if (!options.castId) throw new Error("castId is required.");
  if (!options.baseCandidateLabel) throw new Error("baseCandidateLabel is required; use the human-selected anonymous label.");
  if (!options.stylingSpecPath) throw new Error("stylingSpecPath is required.");
  if (!options.candidateReviewPath) throw new Error("candidateReviewPath is required before styling variations can use a base identity.");
  const paths = episodePaths(projectDir, options.episodeId);
  const generationLockKey = createHash("sha256").update(`${options.workflowId}\n${options.castId}`).digest("hex");
  const generationLock = join(paths.canvasDir, "character-styling-generation-locks", generationLockKey);
  return withCanvasFileLock(generationLock, async () => {
    const store = await readCharacterWorkflowStore({ projectDir, canvasDir: paths.canvasDir });
    let workflow = getCharacterWorkflow(store, options.workflowId);
    if (!workflow || workflow.episodeId !== options.episodeId) throw new Error(`Unknown workflow for ${options.episodeId}: ${options.workflowId}`);
    let cast = findWorkflowCast(workflow, options.castId);
    if (!cast) throw new Error(`Unknown workflow character: ${options.castId}`);
    await validateCandidateDiversityReview({ reviewPath: options.candidateReviewPath, workflow, cast });
    const stylingSpecPath = resolve(options.stylingSpecPath);
    const authority = await readKoyaChannelAuthority({ projectDir });
    const showMember = koyaShowMemberForWorkflowCast(authority.showBible, cast);
    if (showMember) await assertKoyaStylingSequence(authority, showMember, cast, stylingSpecPath);
    const stylingSpec = await readJson(stylingSpecPath);
    if (showMember && stylingSpec.characterId !== showMember.id) throw new Error(`${stylingSpecPath} belongs to ${stylingSpec.characterId || "(missing)"}, not ${showMember.id}.`);
    const stylingSpecSha256 = await sha256Path(stylingSpecPath);
    const planned = await buildCharacterStylingVariationJobs(workflow, cast.id, options.baseCandidateLabel, stylingSpec, {
      projectDir,
      canvasDir: paths.canvasDir,
      roundId: options.stylingRoundId,
      selectionReason: options.selectionReason,
      selectedBy: options.selectedBy,
      generatorHost: options.generatorHost,
      generatorId: options.generatorId,
      generatorContextId: options.generatorContextId,
      model: options.imageModel,
      comparisonReferencePaths: options.stylingComparisonReferencePaths,
      repairSourcePath: options.stylingRepairSourcePath,
      specPath: stylingSpecPath,
      specSha256: stylingSpecSha256,
      specCharacterId: nonEmpty(stylingSpec.characterId),
    });
    const outputDir = join(paths.canvasDir, "assets", "characters", options.episodeId, "styling-variations", planned.round.id);
    await mkdir(outputDir, { recursive: true });
    const generationRound = {
      ...planned.round,
      options: planned.round.options.map((option) => {
        const job = planned.jobs.find((entry) => entry.pipeline.stylingOptionId === option.id);
        const expectedAssetFile = join(outputDir, job.fileName);
        if (option.status === "generated" && option.assetFile && resolve(option.assetFile) !== resolve(expectedAssetFile)) {
          throw new Error(`Styling option ${option.id} generated checkpoint points outside its deterministic output path.`);
        }
        return { ...option, assetFile: expectedAssetFile };
      }),
    };
    workflow = await markCharacterStylingVariationsGenerating(
      { projectDir, canvasDir: paths.canvasDir, castId: cast.id },
      workflow.id,
      generationRound,
    );
    cast = findWorkflowCast(workflow, cast.id);
    const activeRound = cast.stylingVariationRounds.find((round) => round.id === generationRound.id);
    const generateImage = typeof options.generateImage === "function" ? options.generateImage : generateImageMedia;
    const results = await Promise.all(planned.jobs.map(async (job) => {
      const option = activeRound.options.find((entry) => entry.id === job.pipeline.stylingOptionId);
      const assetFile = join(outputDir, job.fileName);
      try {
        if (option.status === "generated") {
          const buffer = await readFile(assetFile);
          assertGeneratedImageBuffer(buffer, assetFile);
          const sha256 = createHash("sha256").update(buffer).digest("hex");
          if (sha256 !== option.sha256) throw new Error(`Styling option ${option.id} generated bytes changed after checkpoint.`);
          return { assetFile, reused: true };
        }
        let reusableBuffer = null;
        try {
          reusableBuffer = await readFile(assetFile);
          assertGeneratedImageBuffer(reusableBuffer, assetFile);
        } catch (error) {
          if (error?.code !== "ENOENT") await unlink(assetFile).catch(() => {});
          reusableBuffer = null;
        }
        if (!reusableBuffer) {
          const media = await generateImage({ ...job, imageCount: 1 });
          const buffer = media?.buffer instanceof Buffer ? media.buffer : media?.buffer ? Buffer.from(media.buffer) : null;
          if (!buffer) throw new Error(`Styling generation returned no image for ${cast.name}/${job.pipeline.stylingOptionId}.`);
          assertGeneratedImageBuffer(buffer, `${cast.name}/${job.pipeline.stylingOptionId}`);
          await writeBufferAtomic(assetFile, buffer);
        }
        await checkpointCharacterStylingVariationResult(
          { projectDir, canvasDir: paths.canvasDir, castId: cast.id },
          workflow.id,
          generationRound.id,
          job,
          { assetFile },
        );
        return { assetFile, reused: Boolean(reusableBuffer) };
      } catch (error) {
        if (option.status === "generated") throw error;
        await checkpointCharacterStylingVariationResult(
          { projectDir, canvasDir: paths.canvasDir, castId: cast.id },
          workflow.id,
          generationRound.id,
          job,
          { error: error.message },
        ).catch(() => {});
        return { error: error.message };
      }
    }));
    const recorded = await recordCharacterStylingVariationResults(
      { projectDir, canvasDir: paths.canvasDir, castId: cast.id },
      workflow.id,
      generationRound.id,
      planned.jobs,
      results,
    );
    const failed = recorded.round.options.filter((option) => option.status === "failed");
    const state = await updateState(paths, {
      status: "character-styling-review-required",
      currentStage: "character-styling-review",
      knownRemainingIssues: [{
        id: "character-styling-review",
        detail: `Review every independent styling sheet at original size in ${recorded.reviewDraftPath}; compose only passing candidates.`,
        failedOptionIds: failed.map((option) => option.id),
      }],
    });
    return { episodeId: options.episodeId, workflowId: workflow.id, castId: cast.id, round: recorded.round, reviewDraftPath: recorded.reviewDraftPath, resumed: planned.resumed, state };
  }, { timeoutMs: 5_000, staleMs: 5_000 });
}

export async function recordKoyaCharacterStylingReviewFailure(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  for (const key of ["episodeId", "workflowId", "castId", "stylingRoundId", "stylingReviewPath"]) {
    if (!nonEmpty(options[key])) throw new Error(`${key} is required to record a failed styling review.`);
  }
  const paths = episodePaths(projectDir, options.episodeId);
  const result = await recordFailedCharacterStylingReview({
    projectDir,
    canvasDir: paths.canvasDir,
    workflowId: options.workflowId,
    castId: options.castId,
    roundId: options.stylingRoundId,
    reviewPath: options.stylingReviewPath,
  });
  const state = await updateState(paths, {
    status: "character-styling-repair-required",
    currentStage: "character-styling-repair",
    knownRemainingIssues: [{
      id: "character-styling-repair",
      detail: `Styling round ${options.stylingRoundId} did not reach the minimum passing count. Preserve passing bytes and start a new declared repair round for only the rejected designs.`,
      passingOptionIds: result.passingOptionIds,
      rejectedOptionIds: result.rejectedOptionIds,
      reviewPath: result.reviewPath,
    }],
  });
  return {
    episodeId: options.episodeId,
    workflowId: options.workflowId,
    castId: options.castId,
    round: result.round,
    passingOptionIds: result.passingOptionIds,
    rejectedOptionIds: result.rejectedOptionIds,
    reviewPath: result.reviewPath,
    state,
  };
}

export function isUnselectedStylingConsolidation({ cast, supersededRound } = {}) {
  return supersededRound?.status === "awaiting-selection"
    && !supersededRound.selectedOptionId
    && cast?.stylingSelection?.roundId !== supersededRound.id;
}

export async function importKoyaCharacterStylingVariations(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  for (const key of ["episodeId", "workflowId", "castId", "baseCandidateLabel", "candidateReviewPath", "stylingSpecPath", "stylingImportMapPath", "selectionReason"]) {
    if (!nonEmpty(options[key])) throw new Error(`${key} is required for styling import.`);
  }
  if (options.generatorHost !== "legacy-migration") throw new Error("Styling import requires generatorHost=legacy-migration; imported artifacts must never look like fresh native generation.");
  if (!nonEmpty(options.generatorId) || !nonEmpty(options.generatorContextId)) throw new Error("generatorId and generatorContextId are required for styling import provenance.");
  const paths = episodePaths(projectDir, options.episodeId);
  const canvasDir = resolve(paths.canvasDir);
  const importMapPath = assertInsideDirectory(canvasDir, options.stylingImportMapPath, "Styling import map");
  const supersedeStylingRoundId = nonEmpty(options.supersedeStylingRoundId);
  const correctiveSupersedeReason = nonEmpty(options.correctiveSupersedeReason);
  if (correctiveSupersedeReason && correctiveSupersedeReason.length < 12) throw new Error("correctiveSupersedeReason must concretely record the later human requirement or original-scale defect.");
  const importMap = await readJson(importMapPath);
  if (importMap.version !== KOYA_CHARACTER_STYLING_IMPORT_VERSION) throw new Error(`Styling import map must use ${KOYA_CHARACTER_STYLING_IMPORT_VERSION}.`);
  const roundId = nonEmpty(options.stylingRoundId || importMap.roundId);
  if (!roundId || (nonEmpty(importMap.roundId) && importMap.roundId !== roundId)) throw new Error("Styling import map roundId must match --styling-round-id.");
  const sourceManifestValue = nonEmpty(importMap.sourceManifestPath);
  if (!sourceManifestValue) throw new Error("Styling import map sourceManifestPath is required.");
  const sourceManifestPath = assertInsideDirectory(
    canvasDir,
    isAbsolute(sourceManifestValue) ? sourceManifestValue : resolve(dirname(importMapPath), sourceManifestValue),
    "Styling import source manifest",
  );
  const [sourceManifest, sourceManifestSha256, importMapSha256] = await Promise.all([
    readJson(sourceManifestPath),
    sha256Path(sourceManifestPath),
    sha256Path(importMapPath),
  ]);
  const sourceEntries = Array.isArray(sourceManifest) ? sourceManifest : Array.isArray(sourceManifest.entries) ? sourceManifest.entries : [];
  if (sourceEntries.length === 0) throw new Error("Styling import source manifest contains no entries.");
  const sharedIdentityAuthoritySha256 = nonEmpty(sourceManifest?.sharedIdentityAuthoritySha256);
  if (sharedIdentityAuthoritySha256) {
    if (!/^[a-f0-9]{64}$/u.test(sharedIdentityAuthoritySha256)) throw new Error("Styling import sharedIdentityAuthoritySha256 must be a lowercase SHA-256.");
  }
  const mapEntries = Array.isArray(importMap.entries) ? importMap.entries : [];
  if (mapEntries.length === 0) throw new Error("Styling import map contains no option mappings.");
  const optionIds = mapEntries.map((entry) => nonEmpty(entry?.optionId));
  const sourceNames = mapEntries.map((entry) => nonEmpty(entry?.sourceEntryName));
  if (optionIds.some((id) => !id) || new Set(optionIds).size !== optionIds.length) throw new Error("Styling import optionId values must be non-empty and unique.");
  if (sourceNames.some((name) => !name) || new Set(sourceNames).size !== sourceNames.length) throw new Error("Styling import sourceEntryName values must be non-empty and unique.");
  const importEvidence = { version: KOYA_CHARACTER_STYLING_IMPORT_VERSION, sourceManifestPath, sourceManifestSha256, importMapPath, importMapSha256 };
  const generationLockKey = createHash("sha256").update(`${options.workflowId}\n${options.castId}`).digest("hex");
  const generationLock = join(canvasDir, "character-styling-generation-locks", generationLockKey);
  return withCanvasFileLock(generationLock, async () => {
    const store = await readCharacterWorkflowStore({ projectDir, canvasDir });
    let workflow = getCharacterWorkflow(store, options.workflowId);
    if (!workflow || workflow.episodeId !== options.episodeId) throw new Error(`Unknown workflow for ${options.episodeId}: ${options.workflowId}`);
    let cast = findWorkflowCast(workflow, options.castId);
    if (!cast) throw new Error(`Unknown workflow character: ${options.castId}`);
    const supersededRound = supersedeStylingRoundId
      ? cast.stylingVariationRounds.find((round) => round.id === supersedeStylingRoundId)
      : null;
    if (supersedeStylingRoundId) {
      const selectedCorrection = correctiveSupersedeReason
        && supersededRound?.status === "selected"
        && supersededRound.selectedOptionId
        && cast.stylingSelection?.roundId === supersededRound.id
        && cast.stylingSelection?.optionId === supersededRound.selectedOptionId;
      const unselectedConsolidation = isUnselectedStylingConsolidation({ cast, supersededRound });
      if (!selectedCorrection && !unselectedConsolidation) throw new Error(`Styling import can supersede ${supersedeStylingRoundId} only while it awaits an unmade human selection, or by an explicit corrective supersede of the exact current selection.`);
      const eligibleOptions = supersededRound.options.filter((option) => ["passed", "selected"].includes(option.status) && option.assetFile && option.sha256);
      if (eligibleOptions.length < 1 || (unselectedConsolidation && eligibleOptions.length !== supersededRound.options.length)) {
        throw new Error(`Styling import cannot supersede ${supersedeStylingRoundId} without independently passed SHA-bound options.`);
      }
    }
    await validateCandidateDiversityReview({ reviewPath: options.candidateReviewPath, workflow, cast });
    const stylingSpecPath = resolve(options.stylingSpecPath);
    const authority = await readKoyaChannelAuthority({ projectDir });
    const showMember = koyaShowMemberForWorkflowCast(authority.showBible, cast);
    const selectedCorrection = Boolean(correctiveSupersedeReason && supersededRound?.status === "selected");
    const sequenceCast = selectedCorrection ? {
      ...cast,
      stylingSelection: null,
      stylingVariationRounds: cast.stylingVariationRounds.map((round) => round.id === supersedeStylingRoundId ? { ...round, status: "superseded" } : round),
    } : cast;
    if (showMember) await assertKoyaStylingSequence(authority, showMember, sequenceCast, stylingSpecPath);
    const stylingSpec = await readJson(stylingSpecPath);
    if (nonEmpty(importMap.characterId) !== nonEmpty(stylingSpec.characterId)) throw new Error("Styling import map characterId must match the styling spec.");
    if (showMember && stylingSpec.characterId !== showMember.id) throw new Error(`${stylingSpecPath} belongs to ${stylingSpec.characterId || "(missing)"}, not ${showMember.id}.`);
    const stylingSpecSha256 = await sha256Path(stylingSpecPath);
    if (supersededRound && correctiveSupersedeReason && supersededRound.specSha256 === stylingSpecSha256) {
      throw new Error("Corrective styling supersede requires a new spec SHA-256; do not invalidate a passing round only to rerun the same requirements.");
    }
    const existingRound = (cast.stylingVariationRounds || []).find((round) => round.id === roundId && ["planned", "generating", "awaiting-review"].includes(round.status));
    if (existingRound && JSON.stringify(existingRound.importEvidence || null) !== JSON.stringify(importEvidence)) {
      throw new Error(`Styling import round ${roundId} already exists with different source evidence.`);
    }
    const workflowWithoutSupersededActiveRound = supersedeStylingRoundId ? {
      ...workflow,
      cast: workflow.cast.map((entry) => entry.id === cast.id ? {
        ...entry,
        ...(selectedCorrection ? {
          selectedCandidateId: "",
          stylingSelection: null,
          approval: null,
          identityPack: null,
          identityReviewDraftPath: "",
          identityReviewPath: "",
        } : {}),
        stylingVariationRounds: entry.stylingVariationRounds.map((round) => round.id === supersedeStylingRoundId
          ? { ...round, status: "superseded" }
          : round),
      } : entry),
    } : workflow;
    const planningWorkflow = existingRound ? {
      ...workflowWithoutSupersededActiveRound,
      cast: workflowWithoutSupersededActiveRound.cast.map((entry) => entry.id === cast.id ? {
        ...entry,
        stylingVariationRounds: entry.stylingVariationRounds.filter((round) => round.id !== roundId),
      } : entry),
    } : workflowWithoutSupersededActiveRound;
    const planned = await buildCharacterStylingVariationJobs(planningWorkflow, cast.id, options.baseCandidateLabel, stylingSpec, {
      projectDir,
      canvasDir,
      roundId,
      selectionReason: correctiveSupersedeReason || options.selectionReason,
      selectedBy: options.selectedBy,
      generatorHost: options.generatorHost,
      generatorId: options.generatorId,
      generatorContextId: options.generatorContextId,
      comparisonReferencePaths: options.stylingComparisonReferencePaths,
      specPath: stylingSpecPath,
      specSha256: stylingSpecSha256,
      specCharacterId: nonEmpty(stylingSpec.characterId),
      importEvidence,
    });
    if (sharedIdentityAuthoritySha256
      && !sourceEntries.some((entry) => nonEmpty(entry?.outputSha256) === planned.round.baseAssetSha256)) {
      throw new Error("Styling import shared identity authority is allowed only when the manifest contains the exact current base asset as an output entry.");
    }
    const specOptionIds = new Set(planned.round.options.map((option) => option.id));
    if (optionIds.some((id) => !specOptionIds.has(id))) throw new Error("Styling import map contains an optionId not declared by the current spec.");
    if (mapEntries.length < planned.round.minimumPassingCandidates) throw new Error(`Styling import requires at least ${planned.round.minimumPassingCandidates} mapped options for independent review.`);
    const importedByOption = new Map();
    for (const mapping of mapEntries) {
      const matches = sourceEntries.filter((entry) => nonEmpty(entry?.name) === nonEmpty(mapping.sourceEntryName));
      if (matches.length !== 1) throw new Error(`Styling import source entry '${mapping.sourceEntryName}' must exist exactly once.`);
      const source = matches[0];
      const sourceOutput = nonEmpty(source.output);
      if (!sourceOutput) throw new Error(`Styling import source entry '${source.name}' has no output path.`);
      const assetFile = assertInsideDirectory(
        canvasDir,
        isAbsolute(sourceOutput) ? sourceOutput : resolve(dirname(sourceManifestPath), sourceOutput),
        `Styling import asset ${mapping.optionId}`,
      );
      const buffer = await readFile(assetFile);
      assertGeneratedImageBuffer(buffer, assetFile);
      const outputSha256 = createHash("sha256").update(buffer).digest("hex");
      if (outputSha256 !== nonEmpty(source.outputSha256)) throw new Error(`Styling import source entry '${source.name}' output SHA-256 does not match disk.`);
      const sourceProvenance = await validateKoyaStylingImportSourceProvenance({
        canvasDir,
        source,
        baseAssetSha256: planned.round.baseAssetSha256,
        sharedIdentityAuthoritySha256,
        label: `Styling import source entry '${source.name}'`,
      });
      if (!nonEmpty(source.prompt) || !nonEmpty(source.model) || !/^\d{4}-\d{2}-\d{2}T/u.test(nonEmpty(source.generatedAt)) || !Number.isFinite(Date.parse(source.generatedAt))) {
        throw new Error(`Styling import source entry '${source.name}' lacks prompt, model, or valid generatedAt provenance.`);
      }
      const generationInputSha256 = createHash("sha256").update(JSON.stringify({
        importVersion: KOYA_CHARACTER_STYLING_IMPORT_VERSION,
        sourceManifestSha256,
        importMapSha256,
        sourceEntryName: source.name,
        prompt: source.prompt,
        model: source.model,
        generatedAt: source.generatedAt,
        sourceSha256: sourceProvenance.sourceSha256,
        rootIdentitySha256: sourceProvenance.rootIdentitySha256,
        sourceLineage: sourceProvenance.sourceLineage,
        outputSha256,
        stylingSpecSha256,
        stylingOptionId: mapping.optionId,
      })).digest("hex");
      importedByOption.set(mapping.optionId, { source, assetFile, outputSha256, generationInputSha256 });
    }
    if (new Set([...importedByOption.values()].map((entry) => entry.outputSha256)).size !== importedByOption.size) throw new Error("Styling import options must use distinct output image bytes.");
    if (supersededRound && !correctiveSupersedeReason) {
      const priorPassedOptions = cast.stylingVariationRounds.flatMap((priorRound) => priorRound.options
        .filter((option) => ["passed", "selected"].includes(option.status) && option.assetFile && option.sha256)
        .map((option) => ({ path: resolve(option.assetFile), sha256: option.sha256 })));
      for (const imported of importedByOption.values()) {
        if (!priorPassedOptions.some((prior) => prior.path === resolve(imported.assetFile) && prior.sha256 === imported.outputSha256)) {
          throw new Error("A styling consolidation import may contain only exact path/SHA bytes from prior independently passed options for this character.");
        }
      }
      const importedSha256s = new Set([...importedByOption.values()].map((entry) => entry.outputSha256));
      if (!supersededRound.options.every((option) => importedSha256s.has(option.sha256))) {
        throw new Error(`Styling consolidation must carry every passed option from superseded round ${supersededRound.id} into the replacement round.`);
      }
    }
    const jobs = planned.jobs.map((job) => {
      const imported = importedByOption.get(job.pipeline.stylingOptionId);
      const generationInputSha256 = imported?.generationInputSha256 || createHash("sha256").update(`${importMapSha256}\nmissing\n${job.pipeline.stylingOptionId}`).digest("hex");
      return {
        ...job,
        prompt: imported?.source.prompt || job.prompt,
        model: imported?.source.model || job.model,
        pipeline: { ...job.pipeline, generationInputSha256 },
      };
    });
    const round = {
      ...planned.round,
      importEvidence,
      options: planned.round.options.map((option) => {
        const imported = importedByOption.get(option.id);
        const job = jobs.find((entry) => entry.pipeline.stylingOptionId === option.id);
        return { ...option, prompt: job.prompt, generationInputSha256: job.pipeline.generationInputSha256, assetFile: imported?.assetFile || "" };
      }),
    };
    workflow = await markCharacterStylingVariationsGenerating({
      projectDir,
      canvasDir,
      castId: cast.id,
      supersedeStylingRoundId,
      correctiveSupersedeReason,
    }, workflow.id, round);
    const results = [];
    for (const job of jobs) {
      const imported = importedByOption.get(job.pipeline.stylingOptionId);
      const result = imported ? { assetFile: imported.assetFile } : { error: "No legacy source asset was mapped for this optional styling choice." };
      await checkpointCharacterStylingVariationResult({ projectDir, canvasDir, castId: cast.id }, workflow.id, round.id, job, result);
      results.push(result);
    }
    const recorded = await recordCharacterStylingVariationResults({ projectDir, canvasDir, castId: cast.id }, workflow.id, round.id, jobs, results);
    const state = await updateState(paths, {
      status: "character-styling-review-required",
      currentStage: "character-styling-review",
      knownRemainingIssues: [{ id: "character-styling-import-review", detail: `Imported assets remain unapproved. Independently review every mapped option at original size in ${recorded.reviewDraftPath}.` }],
    });
    return { episodeId: options.episodeId, workflowId: workflow.id, castId: cast.id, round: recorded.round, importedOptionCount: importedByOption.size, reviewDraftPath: recorded.reviewDraftPath, state };
  }, { timeoutMs: 5_000, staleMs: 5_000 });
}

export async function validateKoyaStylingImportSourceProvenance(options = {}) {
  const canvasDir = resolve(nonEmpty(options.canvasDir));
  const source = options.source && typeof options.source === "object" ? options.source : {};
  const label = nonEmpty(options.label) || "Styling import source";
  const baseAssetSha256 = nonEmpty(options.baseAssetSha256);
  const sharedIdentityAuthoritySha256 = nonEmpty(options.sharedIdentityAuthoritySha256);
  const sourceSha256 = nonEmpty(source.sourceSha256);
  const rootIdentitySha256 = nonEmpty(source.rootIdentitySha256) || sourceSha256;
  if (!baseAssetSha256 || !sourceSha256) throw new Error(`${label} requires base/source SHA-256 provenance.`);
  if (rootIdentitySha256 !== baseAssetSha256 && rootIdentitySha256 !== sharedIdentityAuthoritySha256) {
    throw new Error(`${label} was not derived from the current selected base identity bytes or the manifest's shared identity authority.`);
  }
  const declaredLineage = Array.isArray(source.sourceLineage) ? source.sourceLineage : [];
  if (sourceSha256 === rootIdentitySha256 && declaredLineage.length === 0) {
    return { sourceSha256, rootIdentitySha256, sourceLineage: [] };
  }
  if (declaredLineage.length < 2) throw new Error(`${label} derivative imports require an ordered SHA-bound sourceLineage from root identity to immediate edit source.`);
  const sourceLineage = [];
  for (const [index, entry] of declaredLineage.entries()) {
    const path = assertInsideDirectory(canvasDir, nonEmpty(entry?.path), `${label} lineage ${index + 1}`);
    const sha256 = nonEmpty(entry?.sha256);
    if (!sha256) throw new Error(`${label} lineage ${index + 1} requires sha256.`);
    const actualSha256 = await sha256Path(path);
    if (actualSha256 !== sha256) throw new Error(`${label} lineage ${index + 1} path/SHA-256 does not match disk.`);
    sourceLineage.push({ path, sha256 });
  }
  if (sourceLineage[0].sha256 !== rootIdentitySha256) throw new Error(`${label} lineage must start at its declared root identity SHA-256.`);
  if (sourceLineage.at(-1).sha256 !== sourceSha256) throw new Error(`${label} lineage must end at sourceSha256 for the immediate edit source.`);
  if (new Set(sourceLineage.map((entry) => entry.path)).size !== sourceLineage.length
    || new Set(sourceLineage.map((entry) => entry.sha256)).size !== sourceLineage.length) {
    throw new Error(`${label} lineage must not repeat paths or bytes.`);
  }
  return { sourceSha256, rootIdentitySha256, sourceLineage };
}

export async function composeKoyaCharacterStylingReview(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  const paths = episodePaths(projectDir, options.episodeId);
  const composed = await composeCharacterStylingReviewSheet({
    projectDir,
    canvasDir: paths.canvasDir,
    workflowId: options.workflowId,
    castId: options.castId,
    roundId: options.stylingRoundId,
    reviewPath: options.stylingReviewPath,
  });
  const state = await updateState(paths, {
    status: "character-styling-selection-required",
    currentStage: "character-styling-selection",
    knownRemainingIssues: [{ id: "character-styling-selection", detail: `A human must choose one SHA-bound option from ${composed.sheetPath}.` }],
  });
  return { episodeId: options.episodeId, workflowId: options.workflowId, castId: options.castId, roundId: options.stylingRoundId, sheetPath: composed.sheetPath, manifestPath: composed.manifestPath, state };
}

export async function selectKoyaCharacterStylingVariation(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  const paths = episodePaths(projectDir, options.episodeId);
  const workflow = await selectCharacterStylingVariation({
    projectDir,
    canvasDir: paths.canvasDir,
    workflowId: options.workflowId,
    castId: options.castId,
    roundId: options.stylingRoundId,
    optionId: options.stylingOptionId,
    reason: options.selectionReason,
    selectedBy: options.selectedBy,
  });
  const cast = findWorkflowCast(workflow, options.castId);
  const state = await updateState(paths, {
    status: "character-candidate-approval-required",
    currentStage: "character-candidate-approval",
    knownRemainingIssues: [{ id: "character-candidate-approval", detail: `${cast.name} styling option ${cast.stylingSelection.optionId} is selected; the independent identity pack is not generated or registered yet.` }],
  });
  return { episodeId: options.episodeId, workflowId: workflow.id, castId: cast.id, stylingSelection: cast.stylingSelection, state };
}

export async function approveKoyaCharacterCandidate(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  if (!options.workflowId) throw new Error("workflowId is required.");
  if (!options.castId) throw new Error("castId is required.");
  if (!options.candidateLabel) throw new Error("candidateLabel is required; private candidate IDs and generation order cannot be used for approval.");
  if (!nonEmpty(options.generatorHost) || !nonEmpty(options.generatorId) || !nonEmpty(options.generatorContextId)) {
    throw new Error("character approval requires generatorHost, generatorId, and generatorContextId provenance.");
  }
  const approvalReason = String(options.approvalReason || "").trim();
  if (approvalReason.length < 4) throw new Error("approvalReason is required and must explain why this character candidate was selected.");
  const paths = episodePaths(projectDir, options.episodeId);
  const store = await readCharacterWorkflowStore({ projectDir, canvasDir: paths.canvasDir });
  let workflow = getCharacterWorkflow(store, options.workflowId);
  if (!workflow || workflow.episodeId !== options.episodeId) {
    throw new Error(`Unknown workflow for ${options.episodeId}: ${options.workflowId}`);
  }
  let cast = findWorkflowCast(workflow, options.castId);
  if (!cast) throw new Error(`Unknown workflow character: ${options.castId}`);
  const packageCandidate = cast.candidates.find((entry) => entry.blindPublicPacketPath && entry.blindPrivateMappingPath);
  if (!packageCandidate) throw new Error(`Blind candidate package is missing for ${cast.name}.`);
  await validateCandidateDiversityReview({
    reviewPath: options.candidateReviewPath,
    workflow,
    cast,
  });
  const authority = await readKoyaChannelAuthority({ projectDir });
  const showMember = koyaShowMemberForWorkflowCast(authority.showBible, cast);
  if (showMember) {
    const sequence = await assertKoyaStylingSequence(authority, showMember, cast);
    if (!sequence.complete) throw new Error(`${showMember.name} must complete every declared styling round before identity-pack generation. Next: ${sequence.expectedPaths[sequence.selectedRounds.length]}`);
    const eyeOpenVariants = Array.isArray(showMember.eyeOpenVariants)
      ? await resolveApprovedEyeOpenVariantAuthorities({ projectDir, canvasDir: paths.canvasDir, member: showMember })
      : null;
    workflow = await updateCharacterWorkflow({ projectDir, canvasDir: paths.canvasDir }, workflow.id, (current) => {
      current.cast = current.cast.map((entry) => entry.id === cast.id ? {
        ...entry,
        role: "fixed",
        aliases: [...new Set([...(entry.aliases || []), showMember.hiddenName].filter(Boolean))],
        invariants: [...new Set([...(entry.invariants || []), ...(showMember.currentDesignDirective || [])])],
        // 左右固定の宣言は show bible が正本。ここで渡さないと identity-pack
        // レビューの左右検査が宣言ゼロのまま走り、鏡像欠陥が素通りする。
        sideLockedFeatures: Array.isArray(showMember.sideLockedFeatures) && showMember.sideLockedFeatures.length > 0
          ? showMember.sideLockedFeatures
          : entry.sideLockedFeatures,
        outfitStages: Array.isArray(showMember.outfitStages) ? showMember.outfitStages : entry.outfitStages,
        eyeOpenVariants: eyeOpenVariants || entry.eyeOpenVariants,
      } : entry);
      return current;
    });
    cast = findWorkflowCast(workflow, options.castId);
  }
  await validateApprovedOutfitStageAuthorities({ projectDir, canvasDir: paths.canvasDir, cast });
  const approvedBy = options.approvedBy || "human-user";
  const verdictResult = await recordBlindCandidateVerdict({
    publicPath: packageCandidate.blindPublicPacketPath,
    privatePath: packageCandidate.blindPrivateMappingPath,
    winnerLabel: options.candidateLabel,
    decidedBy: approvedBy,
    reason: approvalReason,
  });
  const candidate = findWorkflowCandidate(cast, verdictResult.selected.id);
  if (!candidate?.assetFile) throw new Error(`Selected anonymous candidate is missing its source asset: ${options.candidateLabel}`);
  const identityCandidate = effectiveCharacterIdentityCandidate(cast, candidate);
  const approvalGenerationScopeId = `approval:${options.generatorContextId}`;
  const jobs = buildApprovedIdentityPackJobs(workflow, cast, identityCandidate, {
    model: options.imageModel,
    fileNameSuffix: options.generatorContextId,
  });
  const identityPackDir = join(paths.canvasDir, "assets", "characters", options.episodeId, "approved-identity-packs");
  const candidateSha256 = await sha256Path(identityCandidate.assetFile);
  const generator = {
    host: options.generatorHost,
    id: options.generatorId,
    contextId: options.generatorContextId,
  };
  const generationImport = nonEmpty(options.identityGenerationImportMapPath)
    ? await prepareKoyaIdentityGenerationImport({
      canvasDir: paths.canvasDir,
      importMapPath: options.identityGenerationImportMapPath,
      workflowId: workflow.id,
      castId: cast.id,
      candidateSha256,
      generator,
      generationScopeId: approvalGenerationScopeId,
      jobs,
    })
    : null;
  const identityGeneration = await generateKoyaIdentityPackAssets({
    projectDir,
    canvasDir: paths.canvasDir,
    identityPackDir,
    workflowId: workflow.id,
    castId: cast.id,
    candidateSha256,
    generatorHost: options.generatorHost,
    generatorId: options.generatorId,
    generatorContextId: options.generatorContextId,
    generationScopeId: approvalGenerationScopeId,
    jobs,
    ...(generationImport ? {
      generateImage: generationImport.generateImage,
      generationImportEvidence: generationImport.evidence,
    } : {}),
  });
  const generated = identityGeneration.results;
  const staged = await stageApprovedCharacterIdentityPack({
    projectDir,
    canvasDir: paths.canvasDir,
    workflowId: workflow.id,
    castId: cast.id,
    candidateId: candidate.id,
    approvalReason,
    approvedBy,
    candidateLabel: verdictResult.verdict.winnerLabel,
    candidateSetId: verdictResult.verdict.setId,
    verdictDigest: verdictResult.verdict.digest,
    candidateReviewPath: options.candidateReviewPath,
    generatorContextId: options.generatorContextId,
    jobs,
    results: generated,
  });
  const state = await updateState(paths, {
    status: "character-identity-review-required",
    currentStage: "character-identity-review",
    knownRemainingIssues: [{ id: "character-identity-review", detail: `Review the real turnaround and every expression cell at ${staged.identityReviewDraftPath}, then register the character.` }],
  });
  return {
    episodeId: options.episodeId,
    workflowId: workflow.id,
    castId: cast.id,
    candidateLabel: verdictResult.verdict.winnerLabel,
    candidateSetId: verdictResult.verdict.setId,
    verdictPath: verdictResult.verdictPath,
    approvalReason,
    resumed: identityGeneration.resumed,
    generationCheckpointPath: identityGeneration.checkpointPath,
    staged,
    state,
  };
}

export async function registerKoyaCharacterIdentity(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  if (!options.workflowId) throw new Error("workflowId is required.");
  if (!options.castId) throw new Error("castId is required.");
  if (!options.identityReviewPath) throw new Error("identityReviewPath is required.");
  const paths = episodePaths(projectDir, options.episodeId);
  const finalized = await finalizeApprovedCharacter({
    projectDir,
    canvasDir: paths.canvasDir,
    workflowId: options.workflowId,
    castId: options.castId,
    identityReviewPath: options.identityReviewPath,
  });
  const showBibleSync = await reconcileKoyaRegisteredCharacterShowBibleStatus({
    projectDir,
    workflowId: options.workflowId,
    castId: options.castId,
  });
  const unresolved = finalized.workflow.cast.filter((entry) => entry.status !== "ready" && entry.status !== "existing");
  const state = await updateState(paths, {
    status: unresolved.length > 0 ? "character-approval-in-progress" : "images-ready",
    currentStage: unresolved.length > 0 ? "character-approval" : "source-face-placement",
    knownRemainingIssues: unresolved.length > 0
      ? [{ id: "character-approval", detail: `Complete character approval for: ${unresolved.map((entry) => entry.name).join(", ")}.` }]
      : [],
  });
  return { episodeId: options.episodeId, finalized, showBibleSync, state };
}

export function registeredIdentityReviewBinding(cast, registered) {
  const workflowPath = nonEmpty(cast?.identityReviewPath);
  const registryPath = nonEmpty(registered?.approval?.identityReviewPath);
  const sha256 = nonEmpty(registered?.approval?.identityReviewSha256);
  if (!workflowPath || !registryPath || !sha256) return null;
  if (resolve(workflowPath) !== resolve(registryPath)) return null;
  return { path: workflowPath, sha256 };
}

export async function reconcileKoyaRegisteredCharacterShowBibleStatus(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  const workflowId = nonEmpty(options.workflowId);
  const castId = nonEmpty(options.castId);
  if (!workflowId) throw new Error("workflowId is required.");
  if (!castId) throw new Error("castId is required.");

  const [workflowStore, registry, authority] = await Promise.all([
    readCharacterWorkflowStore({ projectDir }),
    readCharacterRegistry({ projectDir }),
    readKoyaChannelAuthority({ projectDir }),
  ]);
  assertProductionChannelAuthority(authority, "character registration show-bible reconciliation");
  const workflow = getCharacterWorkflow(workflowStore, workflowId);
  if (!workflow) throw new Error(`Unknown character workflow: ${workflowId}.`);
  const cast = findWorkflowCast(workflow, castId);
  if (!cast) throw new Error(`Unknown workflow character: ${castId}.`);
  if (cast.status !== "ready") throw new Error(`${cast.name} is not a ready registered character.`);
  const registered = (registry.characters || []).find((entry) => entry.id === cast.id && entry.status === "approved");
  if (!registered) throw new Error(`${cast.name} is not present as an approved registry character.`);
  const reviewBinding = registeredIdentityReviewBinding(cast, registered);
  if (!reviewBinding) throw new Error(`${cast.name} lacks an exact workflow/registry identity-review binding.`);
  const reviewSha256 = await sha256Path(reviewBinding.path);
  if (reviewSha256 !== reviewBinding.sha256) throw new Error(`${cast.name} identity-review SHA no longer matches the registered approval.`);

  const showMember = koyaShowMemberForWorkflowCast(authority.showBible, cast);
  if (!showMember) throw new Error(`${cast.name} is not declared in the Koya show bible.`);
  if (showMember.designStatus === "approved") {
    return { updated: false, memberId: showMember.id, designStatus: "approved", path: authority.paths.show };
  }
  if (showMember.designStatus !== "client-approved-awaiting-official-import") {
    throw new Error(`${showMember.name} cannot be promoted from designStatus=${showMember.designStatus}; client confirmation remains required.`);
  }

  const nextShowBible = structuredClone(authority.showBible);
  nextShowBible.cast = nextShowBible.cast.map((member) => member.id === showMember.id
    ? { ...member, designStatus: "approved" }
    : member);
  validateKoyaShowBible(nextShowBible);
  await writeJsonAtomic(authority.paths.show, nextShowBible);
  return {
    updated: true,
    memberId: showMember.id,
    previousDesignStatus: showMember.designStatus,
    designStatus: "approved",
    path: authority.paths.show,
  };
}

export async function refreshKoyaRegisteredCharacterIdentityPack(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  if (!options.workflowId) throw new Error("workflowId is required.");
  if (!options.castId) throw new Error("castId is required.");
  const refreshId = nonEmpty(options.identityRefreshId);
  if (!refreshId) throw new Error("identityRefreshId is required so a new-standard refresh never overwrites an approved generation.");
  if (!nonEmpty(options.generatorHost) || !nonEmpty(options.generatorId) || !nonEmpty(options.generatorContextId)) {
    throw new Error("Identity-pack refresh requires generatorHost, generatorId, and generatorContextId provenance.");
  }
  const paths = episodePaths(projectDir, options.episodeId);
  const store = await readCharacterWorkflowStore({ projectDir, canvasDir: paths.canvasDir });
  const workflow = getCharacterWorkflow(store, options.workflowId);
  if (!workflow || workflow.episodeId !== options.episodeId) throw new Error(`Unknown workflow for ${options.episodeId}: ${options.workflowId}`);
  const cast = findWorkflowCast(workflow, options.castId);
  if (!cast) throw new Error(`Unknown workflow character: ${options.castId}`);
  if (cast.status !== "ready" || !cast.identityPack?.selectedFace?.assetFile || !cast.identityReviewPath) {
    throw new Error("Identity-pack refresh is only for a previously registered ready character with approved identity evidence.");
  }
  const baseCandidate = findWorkflowCandidate(cast, cast.selectedCandidateId);
  if (!baseCandidate?.assetFile) throw new Error("The frozen selected candidate is missing for identity-pack refresh.");
  const identityCandidate = effectiveCharacterIdentityCandidate(cast, baseCandidate);
  const frozenFaceSha256 = await sha256Path(identityCandidate.assetFile);
  if (frozenFaceSha256 !== nonEmpty(cast.identityPack.selectedFace.sha256)
    || await sha256Path(cast.identityPack.selectedFace.assetFile) !== frozenFaceSha256) {
    throw new Error("The workflow selected-face bytes changed; face regeneration or reapproval is forbidden during identity-pack refresh.");
  }
  const registry = await readCharacterRegistry({ projectDir, canvasDir: paths.canvasDir });
  const registered = registry.characters.find((entry) => entry.id === cast.id && entry.status === "approved");
  const registeredFace = registered?.referenceAssets?.find((entry) => entry.role === "identity-face");
  if (!registered || !registeredFace?.path || registeredFace.sha256 !== frozenFaceSha256) {
    throw new Error("The approved registry does not bind the exact frozen workflow identity face.");
  }
  const registeredFacePath = assertInsideDirectory(paths.canvasDir, resolve(paths.canvasDir, registeredFace.path), `${cast.name} registered identity face`);
  if (await sha256Path(registeredFacePath) !== frozenFaceSha256) throw new Error("The registered identity-face bytes changed after approval.");
  const priorIdentityReviewBinding = registeredIdentityReviewBinding(cast, registered);
  if (!priorIdentityReviewBinding) {
    throw new Error("The workflow and approved registry do not bind the same prior identity review.");
  }
  const priorIdentityReviewPath = assertInsideDirectory(paths.canvasDir, priorIdentityReviewBinding.path, `${cast.name} prior identity review`);
  const priorIdentityReviewSha256 = await sha256Path(priorIdentityReviewPath);
  if (priorIdentityReviewSha256 !== priorIdentityReviewBinding.sha256) {
    throw new Error("The prior approved identity review is missing, stale, or differs from the registry.");
  }
  const allJobs = buildApprovedIdentityPackJobs(workflow, cast, identityCandidate, { model: options.imageModel });
  const refreshJobs = allJobs.filter((job) => ["turnaround", "expression"].includes(nonEmpty(job.pipeline?.identityRole)));
  if (allJobs.length !== 2 || refreshJobs.length !== 2) {
    throw new Error("Registered-character refresh may replace only the standard turnaround and expression roles; use the role-specific official route for eye-open or outfits.");
  }
  const slug = refreshId.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48) || "refresh";
  const jobs = refreshJobs.map((job) => {
    const extension = extname(job.fileName) || ".png";
    const stem = basename(job.fileName, extension);
    return {
      ...job,
      fileName: `${stem}-refresh-${slug}${extension}`,
      prompt: [
        `AUTHORIZED NEW-STANDARD IDENTITY-PACK REFRESH ${refreshId}.`,
        "Reference image 1 is the exact already-approved, SHA-frozen identity face. Do not regenerate, reinterpret, beautify, age-shift, mirror, or reapprove that face. Create only the requested fresh sheet under the current eight-view / 12-cell standard.",
        job.prompt,
      ].join("\n"),
    };
  });
  const generationScopeId = `refresh:${refreshId}`;
  const generator = {
    host: options.generatorHost,
    id: options.generatorId,
    contextId: options.generatorContextId,
  };
  const generationImport = nonEmpty(options.identityGenerationImportMapPath)
    ? await prepareKoyaIdentityGenerationImport({
      canvasDir: paths.canvasDir,
      importMapPath: options.identityGenerationImportMapPath,
      workflowId: workflow.id,
      castId: cast.id,
      candidateSha256: frozenFaceSha256,
      generator,
      generationScopeId,
      jobs,
    })
    : null;
  const identityPackDir = join(paths.canvasDir, "assets", "characters", options.episodeId, "approved-identity-packs");
  const identityGeneration = await generateKoyaIdentityPackAssets({
    projectDir,
    canvasDir: paths.canvasDir,
    identityPackDir,
    workflowId: workflow.id,
    castId: cast.id,
    candidateSha256: frozenFaceSha256,
    generatorHost: options.generatorHost,
    generatorId: options.generatorId,
    generatorContextId: options.generatorContextId,
    generationScopeId,
    jobs,
    ...(generationImport ? {
      generateImage: generationImport.generateImage,
      generationImportEvidence: generationImport.evidence,
    } : options.generateImage ? { generateImage: options.generateImage } : {}),
  });
  const staged = await stageApprovedCharacterIdentityPack({
    projectDir,
    canvasDir: paths.canvasDir,
    workflowId: workflow.id,
    castId: cast.id,
    candidateId: baseCandidate.id,
    approvalReason: cast.approval.reason,
    approvedBy: cast.approval.approvedBy,
    approvedAt: cast.approval.approvedAt,
    candidateLabel: cast.approval.selectedCandidateLabel || baseCandidate.blindLabel,
    candidateSetId: cast.approval.candidateSetId || baseCandidate.candidateSetId,
    verdictDigest: cast.approval.verdictDigest || "",
    selectedVariationAxis: cast.approval.selectedVariationAxis || identityCandidate.variationAxis,
    candidateReviewPath: cast.approval.candidateReviewPath || cast.candidateReviewPath,
    generatorContextId: options.generatorContextId,
    jobs,
    results: identityGeneration.results,
    refreshEvidence: {
      refreshId,
      frozenFaceSha256,
      priorIdentityReviewPath,
      priorIdentityReviewSha256,
      generationCheckpointPath: identityGeneration.checkpointPath,
    },
  });
  const state = await updateState(paths, {
    status: "character-identity-review-required",
    currentStage: "character-identity-review",
    knownRemainingIssues: [{
      id: "registered-character-identity-refresh-review",
      detail: `${cast.name} kept frozen identity face ${frozenFaceSha256} and generated fresh turnaround/expression sheets. Independently inspect every new 8/12 cell at ${staged.identityReviewDraftPath} before serial re-registration.`,
    }],
  });
  return {
    episodeId: options.episodeId,
    workflowId: workflow.id,
    castId: cast.id,
    refreshId,
    frozenFaceSha256,
    generatedCount: identityGeneration.generatedCount,
    resumed: identityGeneration.resumed,
    generationCheckpointPath: identityGeneration.checkpointPath,
    identityReviewDraftPath: staged.identityReviewDraftPath,
    state,
  };
}

async function archiveFailedIdentityReview(failedReview, repairId) {
  const failedReviewSha256 = await sha256Path(failedReview.path);
  const archivePath = join(dirname(failedReview.path), "failed-reviews", `${nonEmpty(repairId)}-${failedReviewSha256.slice(0, 16)}.json`);
  const bytes = await readFile(failedReview.path);
  if (await exists(archivePath)) {
    if (await sha256Path(archivePath) !== failedReviewSha256) throw new Error(`Archived failed identity review bytes changed: ${archivePath}`);
  } else {
    await mkdir(dirname(archivePath), { recursive: true });
    await writeBufferAtomic(archivePath, bytes);
  }
  return { path: archivePath, sha256: failedReviewSha256 };
}

async function validateSettingSheetFindingRepair({ projectDir, findingsPath, repairPlanPath, cast } = {}) {
  const resolvedFindingsPath = resolve(nonEmpty(findingsPath));
  const resolvedRepairPlanPath = resolve(nonEmpty(repairPlanPath));
  if (!nonEmpty(findingsPath) || !nonEmpty(repairPlanPath)) {
    throw new Error("Finding-level identity repair requires both identityFindingsPath and identityRepairPlanPath.");
  }
  const [findingsBytes, planBytes] = await Promise.all([readFile(resolvedFindingsPath), readFile(resolvedRepairPlanPath)]);
  const findings = JSON.parse(findingsBytes);
  const repairPlan = JSON.parse(planBytes);
  if (findings.version !== "koya-setting-sheet-human-qa-findings-v1" || !Array.isArray(findings.findings) || findings.findings.length === 0) {
    throw new Error("Unsupported or empty setting-sheet findings file.");
  }
  const digestCheck = verifyCharacterRepairPlanDigest(repairPlan);
  if (!digestCheck.valid) throw new Error("Persisted character repair-plan digest does not match its body.");
  const coverage = verifyRepairPlanCoverage(repairPlan, findings.findings);
  if (!coverage.complete) throw new Error(`Repair plan misses findings: ${coverage.missing.join(", ")}`);
  const expectedContract = buildCharacterCandidateQualityContract({
    castId: "setting-sheet-human-qa-findings-2026-08-30-r4",
    maximumReviewRounds: 3,
  });
  if (repairPlan.contractDigest !== expectedContract.digest) throw new Error("Repair plan is not bound to the setting-sheet repair quality contract.");
  const findingsSha256 = createHash("sha256").update(findingsBytes).digest("hex");
  if (repairPlan.previousFailureFingerprint !== findingsSha256) throw new Error("Repair plan is not bound to the exact findings bytes.");
  const roleAssets = [
    { role: "turnaround", path: cast.identityPack?.turnaround?.assetFile },
    { role: "expression", path: cast.identityPack?.expression?.assetFile },
    ...identityPackEyeOpenSheets(cast.identityPack).map((asset) => ({ role: eyeOpenReviewKey(asset.storyStage), path: asset.assetFile })),
    ...(cast.identityPack?.outfitSheets || []).map((asset) => ({ role: `outfit:${asset.storyStage}`, path: asset.assetFile })),
  ].filter((entry) => nonEmpty(entry.path));
  const relevantFindings = findings.findings.flatMap((finding) => {
    const findingPath = resolve(projectDir, nonEmpty(finding.sheet));
    const findingExtension = extname(findingPath);
    const findingStem = basename(findingPath, findingExtension);
    const inferredRole = findingStem.includes("-outfit-")
      ? `outfit:${findingStem.split("-outfit-")[1]}`
      : findingStem.includes("-expressions") ? "expression"
        : findingStem.includes("-turnaround") ? "turnaround" : "";
    const match = roleAssets.find((asset) => {
      const assetPath = resolve(asset.path);
      return assetPath === findingPath
        || (dirname(assetPath) === dirname(findingPath)
          && basename(assetPath).startsWith(`${findingStem}-repair-`))
        || (findingStem.startsWith(`${cast.id}-`) && asset.role === inferredRole);
    });
    return match ? [{ ...finding, role: match.role }] : [];
  });
  if (relevantFindings.length === 0) throw new Error(`No finding targets the current staged sheets for ${cast.id}.`);
  const findingIds = new Set(relevantFindings.map((entry) => entry.findingId));
  const planEntries = repairPlan.entries.filter((entry) => findingIds.has(entry.findingId));
  if (planEntries.length !== relevantFindings.length) throw new Error("Current cast findings are not covered exactly once by the repair plan.");
  return {
    path: resolvedFindingsPath,
    sha256: findingsSha256,
    planPath: resolvedRepairPlanPath,
    planSha256: createHash("sha256").update(planBytes).digest("hex"),
    repairPlan,
    relevantFindings,
    failedRoles: [...new Set(relevantFindings.map((entry) => entry.role))],
  };
}

export async function repairKoyaCharacterIdentityPack(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  if (!options.workflowId) throw new Error("workflowId is required.");
  if (!options.castId) throw new Error("castId is required.");
  const findingRepairRequested = nonEmpty(options.identityFindingsPath) || nonEmpty(options.identityRepairPlanPath);
  if (!findingRepairRequested && !options.identityReviewPath) throw new Error("identityReviewPath is required unless a findings-bound repair plan is supplied.");
  const repairId = nonEmpty(options.identityRepairId);
  if (!repairId) throw new Error("identityRepairId is required so repair generations never overwrite an earlier paid result.");
  const paths = episodePaths(projectDir, options.episodeId);
  const store = await readCharacterWorkflowStore({ projectDir, canvasDir: paths.canvasDir });
  const workflow = getCharacterWorkflow(store, options.workflowId);
  if (!workflow || workflow.episodeId !== options.episodeId) throw new Error(`Unknown workflow for ${options.episodeId}: ${options.workflowId}`);
  const cast = findWorkflowCast(workflow, options.castId);
  if (!cast) throw new Error(`Unknown workflow character: ${options.castId}`);
  if (cast.status !== "awaiting-identity-qa" || !cast.identityPack?.turnaround?.assetFile || !cast.identityPack?.expression?.assetFile) {
    throw new Error("Identity-pack repair requires a staged character in awaiting-identity-qa status.");
  }
  const findingRepair = findingRepairRequested ? await validateSettingSheetFindingRepair({
    projectDir,
    findingsPath: options.identityFindingsPath,
    repairPlanPath: options.identityRepairPlanPath,
    cast,
  }) : null;
  const failedReview = findingRepair || await validateFailedIdentityPackReview({
    reviewPath: options.identityReviewPath,
    workflow,
    cast,
    identityPack: cast.identityPack,
  });
  const failedReviewArchive = findingRepair ? null : await archiveFailedIdentityReview(failedReview, repairId);
  const baseCandidate = findWorkflowCandidate(cast, cast.selectedCandidateId);
  if (!baseCandidate?.assetFile) throw new Error("The selected base candidate is missing for identity-pack repair.");
  const identityCandidate = effectiveCharacterIdentityCandidate(cast, baseCandidate);
  const repairJobs = buildApprovedIdentityPackRepairJobs(workflow, cast, identityCandidate, failedReview.failedRoles, {
    model: options.imageModel,
    repairId,
    ...(findingRepair ? {
      repairFindings: findingRepair.relevantFindings,
      repairPlan: findingRepair.repairPlan,
      strictOutfitAuthorityStages: findingRepair.relevantFindings
        .filter((entry) => entry.findingId === "ema-outfit-office-wrong-garment-and-background")
        .map(() => "office"),
    } : {}),
  });
  const identityPackDir = join(paths.canvasDir, "assets", "characters", options.episodeId, "approved-identity-packs");
  const generationScopeId = findingRepair
    ? `repair:${repairId}:${findingRepair.repairPlan.digest.slice(0, 16)}`
    : `repair:${repairId}`;
  const candidateSha256 = await sha256Path(identityCandidate.assetFile);
  const generator = { host: options.generatorHost, id: options.generatorId, contextId: options.generatorContextId };
  const generationImport = nonEmpty(options.identityGenerationImportMapPath)
    ? await prepareKoyaIdentityGenerationImport({
      canvasDir: paths.canvasDir,
      importMapPath: options.identityGenerationImportMapPath,
      workflowId: workflow.id,
      castId: cast.id,
      candidateSha256,
      generator,
      generationScopeId,
      jobs: repairJobs,
    })
    : null;
  const identityGeneration = await generateKoyaIdentityPackAssets({
    projectDir,
    canvasDir: paths.canvasDir,
    identityPackDir,
    workflowId: workflow.id,
    castId: cast.id,
    candidateSha256,
    generatorHost: options.generatorHost,
    generatorId: options.generatorId,
    generatorContextId: options.generatorContextId,
    generationScopeId,
    jobs: repairJobs,
    ...(generationImport ? {
      generateImage: generationImport.generateImage,
      generationImportEvidence: generationImport.evidence,
    } : {}),
  });
  const keyFor = identityPackJobRoleKey;
  const repairedByRole = new Map(repairJobs.map((job, index) => [keyFor(job), identityGeneration.results[index]]));
  const currentAssetFor = (job) => {
    const role = nonEmpty(job.pipeline?.identityRole);
    if (role === "turnaround") return cast.identityPack.turnaround;
    if (role === "expression") return cast.identityPack.expression;
    if (role === "eye-open") return identityPackEyeOpenSheets(cast.identityPack).find((entry) => entry.storyStage === nonEmpty(job.pipeline?.storyStage));
    if (role === "outfit") return (cast.identityPack.outfitSheets || []).find((entry) => entry.storyStage === nonEmpty(job.pipeline?.storyStage));
    return null;
  };
  const allJobs = buildApprovedIdentityPackJobs(workflow, cast, identityCandidate, { model: options.imageModel });
  const combinedResults = allJobs.map((job) => repairedByRole.get(keyFor(job)) || currentAssetFor(job));
  if (combinedResults.some((entry) => !entry?.assetFile)) throw new Error("Identity-pack repair could not preserve every non-failed required role.");
  const staged = await stageApprovedCharacterIdentityPack({
    projectDir,
    canvasDir: paths.canvasDir,
    workflowId: workflow.id,
    castId: cast.id,
    candidateId: baseCandidate.id,
    approvalReason: cast.approval?.reason || "Keep the existing human-selected identity and repair only independently failed identity sheets.",
    approvedBy: cast.approval?.approvedBy || "human-user",
    candidateLabel: cast.approval?.selectedCandidateLabel || baseCandidate.blindLabel,
    candidateSetId: cast.approval?.candidateSetId || baseCandidate.candidateSetId,
    verdictDigest: cast.approval?.verdictDigest || "",
    candidateReviewPath: cast.approval?.candidateReviewPath || cast.candidateReviewPath,
    generatorContextId: options.generatorContextId,
    jobs: allJobs,
    results: combinedResults,
    repairEvidence: {
      repairId,
      failedReviewPath: failedReviewArchive?.path || "",
      failedReviewSha256: failedReviewArchive?.sha256 || "",
      findingsPath: findingRepair?.path || "",
      findingsSha256: findingRepair?.sha256 || "",
      repairPlanPath: findingRepair?.planPath || "",
      repairPlanSha256: findingRepair?.planSha256 || "",
      repairPlanDigest: findingRepair?.repairPlan?.digest || "",
      findingIds: findingRepair?.relevantFindings?.map((entry) => entry.findingId) || [],
      failedRoles: failedReview.failedRoles,
      generationCheckpointPath: identityGeneration.checkpointPath,
    },
  });
  const state = await updateState(paths, {
    status: "character-identity-review-required",
    currentStage: "character-identity-review",
    knownRemainingIssues: [{
      id: "character-identity-repair-review",
      detail: `Repair ${repairId} replaced only failed roles (${failedReview.failedRoles.join(", ")}). Independently inspect the fresh eight/12-cell evidence at ${staged.identityReviewDraftPath}.`,
    }],
  });
  return {
    episodeId: options.episodeId,
    workflowId: workflow.id,
    castId: cast.id,
    repairId,
    failedRoles: failedReview.failedRoles,
    failedReviewPath: failedReviewArchive?.path || "",
    failedReviewSha256: failedReviewArchive?.sha256 || "",
    findingsPath: findingRepair?.path || "",
    findingsSha256: findingRepair?.sha256 || "",
    repairPlanPath: findingRepair?.planPath || "",
    repairPlanDigest: findingRepair?.repairPlan?.digest || "",
    generatedCount: identityGeneration.generatedCount,
    reusedRequiredRoleCount: allJobs.length - repairJobs.length,
    generationCheckpointPath: identityGeneration.checkpointPath,
    staged,
    state,
  };
}

export async function repackKoyaCharacterIdentityPack(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  if (!options.workflowId) throw new Error("workflowId is required.");
  if (!options.castId) throw new Error("castId is required.");
  const findingRepairRequested = nonEmpty(options.identityFindingsPath) || nonEmpty(options.identityRepairPlanPath);
  if (!findingRepairRequested && !options.identityReviewPath) {
    throw new Error("identityReviewPath is required unless a findings-bound repair plan is supplied.");
  }
  const repairId = nonEmpty(options.identityRepairId);
  const generatorContextId = nonEmpty(options.generatorContextId);
  if (!repairId || !generatorContextId) throw new Error("identityRepairId and generatorContextId are required for deterministic identity repack.");
  const paths = episodePaths(projectDir, options.episodeId);
  const store = await readCharacterWorkflowStore({ projectDir, canvasDir: paths.canvasDir });
  const workflow = getCharacterWorkflow(store, options.workflowId);
  if (!workflow || workflow.episodeId !== options.episodeId) throw new Error(`Unknown workflow for ${options.episodeId}: ${options.workflowId}`);
  const cast = findWorkflowCast(workflow, options.castId);
  if (!cast) throw new Error(`Unknown workflow character: ${options.castId}`);
  if (cast.status !== "awaiting-identity-qa" || !cast.identityPack?.turnaround?.assetFile || !cast.identityPack?.expression?.assetFile) {
    throw new Error("Identity-pack repack requires a staged character in awaiting-identity-qa status.");
  }
  const findingRepair = findingRepairRequested ? await validateSettingSheetFindingRepair({
    projectDir,
    findingsPath: options.identityFindingsPath,
    repairPlanPath: options.identityRepairPlanPath,
    cast,
  }) : null;
  const failedReview = findingRepair || await validateFailedIdentityPackReview({
    reviewPath: options.identityReviewPath,
    workflow,
    cast,
    identityPack: cast.identityPack,
  });
  // Every eye-open sheet (one per declared variant) is a 2x2 grid keyed like
  // its review row, so a failed variant repacks without touching the others.
  const roleConfig = {
    turnaround: { asset: cast.identityPack.turnaround, columns: 4, rows: 2 },
    expression: { asset: cast.identityPack.expression, columns: 4, rows: 3 },
    ...Object.fromEntries(identityPackEyeOpenSheets(cast.identityPack).map((sheet) => [
      eyeOpenReviewKey(sheet.storyStage),
      { asset: sheet, columns: 2, rows: 2 },
    ])),
  };
  const unsupported = failedReview.failedRoles.filter((role) => !Object.hasOwn(roleConfig, role));
  if (unsupported.length > 0) throw new Error(`Deterministic grid repack supports only turnaround/expression/eye-open roles; regenerate: ${unsupported.join(", ")}`);
  const failedReviewArchive = findingRepair ? null : await archiveFailedIdentityReview(failedReview, repairId);
  const baseCandidate = findWorkflowCandidate(cast, cast.selectedCandidateId);
  if (!baseCandidate?.assetFile) throw new Error("The selected base candidate is missing for identity-pack repack.");
  const identityCandidate = effectiveCharacterIdentityCandidate(cast, baseCandidate);
  const identityPackDir = join(paths.canvasDir, "assets", "characters", options.episodeId, "approved-identity-packs");
  await mkdir(identityPackDir, { recursive: true });
  const repackedByRole = new Map();
  const evidenceEntries = [];
  const scriptPath = join(projectDir, "scripts", "repack-koya-identity-grid.py");
  const python = await requirePythonRuntime({
    runtime: options.pythonRuntime,
    purposeEnv: "KOYA_GATE_PYTHON",
    projectDir,
    requiredModules: ["numpy", "PIL"],
  });
  for (const role of failedReview.failedRoles) {
    const config = roleConfig[role];
    const extension = ".png";
    const sourceStem = basename(config.asset.assetFile, extname(config.asset.assetFile));
    const outputPath = assertInsideDirectory(identityPackDir, join(identityPackDir, `${sourceStem}-repack-${repairId}${extension}`), `Identity repack output ${role}`);
    const manifestPath = assertInsideDirectory(identityPackDir, join(identityPackDir, `${sourceStem}-repack-${repairId}.manifest.json`), `Identity repack manifest ${role}`);
    const sourceSha256 = await sha256Path(config.asset.assetFile);
    if ((await exists(outputPath)) !== (await exists(manifestPath))) throw new Error(`Identity repack output/manifest checkpoint is incomplete for ${role}.`);
    if (!(await exists(outputPath))) {
      await execFile(python.command, [...python.args, scriptPath,
        "--input", config.asset.assetFile,
        "--output", outputPath,
        "--manifest", manifestPath,
        "--columns", String(config.columns),
        "--rows", String(config.rows),
        "--margin-fraction", "0.08",
      ], { maxBuffer: 16 * 1024 * 1024 });
    }
    const manifest = await readJson(manifestPath);
    if (manifest.version !== "koya-identity-grid-repack-v1"
      || manifest.sourcePath !== resolve(config.asset.assetFile)
      || manifest.sourceSha256 !== sourceSha256
      || manifest.outputPath !== resolve(outputPath)
      || manifest.outputSha256 !== await sha256Path(outputPath)
      || manifest.columns !== config.columns
      || manifest.rows !== config.rows
      || manifest.marginFraction !== 0.08) {
      throw new Error(`Identity repack manifest does not bind the current ${role} input/output bytes.`);
    }
    repackedByRole.set(role, { assetFile: outputPath, sha256: manifest.outputSha256 });
    evidenceEntries.push({ role, manifestPath, manifestSha256: await sha256Path(manifestPath), sourcePath: manifest.sourcePath, sourceSha256, outputPath, outputSha256: manifest.outputSha256 });
  }
  const repackEvidencePath = join(identityPackDir, `${cast.id}-repack-${repairId}.evidence.json`);
  const repackEvidence = {
    version: "koya-identity-repack-evidence-v1",
    workflowId: workflow.id,
    castId: cast.id,
    repairId,
    failedReviewPath: failedReviewArchive?.path || "",
    failedReviewSha256: failedReviewArchive?.sha256 || "",
    findingsPath: findingRepair?.path || "",
    findingsSha256: findingRepair?.sha256 || "",
    repairPlanPath: findingRepair?.planPath || "",
    repairPlanSha256: findingRepair?.planSha256 || "",
    repairPlanDigest: findingRepair?.repairPlan?.digest || "",
    findingIds: findingRepair?.relevantFindings?.map((entry) => entry.findingId) || [],
    entries: evidenceEntries,
    createdAt: new Date().toISOString(),
  };
  if (await exists(repackEvidencePath)) {
    const existing = await readJson(repackEvidencePath);
    const withoutTime = (value) => ({ ...value, createdAt: "" });
    if (JSON.stringify(withoutTime(existing)) !== JSON.stringify(withoutTime(repackEvidence))) throw new Error("Identity repack evidence already exists with different bytes or inputs.");
  } else {
    await writeJsonAtomic(repackEvidencePath, repackEvidence);
  }
  const allJobs = buildApprovedIdentityPackJobs(workflow, cast, identityCandidate, { model: options.imageModel });
  const currentAssetFor = (job) => {
    const role = nonEmpty(job.pipeline?.identityRole);
    const roleKey = identityPackJobRoleKey(job);
    if (repackedByRole.has(roleKey)) return repackedByRole.get(roleKey);
    if (role === "turnaround") return cast.identityPack.turnaround;
    if (role === "expression") return cast.identityPack.expression;
    if (role === "eye-open") return identityPackEyeOpenSheets(cast.identityPack).find((entry) => entry.storyStage === nonEmpty(job.pipeline?.storyStage));
    if (role === "outfit") return (cast.identityPack.outfitSheets || []).find((entry) => entry.storyStage === nonEmpty(job.pipeline?.storyStage));
    return null;
  };
  const combinedResults = allJobs.map(currentAssetFor);
  if (combinedResults.some((entry) => !entry?.assetFile)) throw new Error("Identity repack could not preserve every required non-failed role.");
  const staged = await stageApprovedCharacterIdentityPack({
    projectDir,
    canvasDir: paths.canvasDir,
    workflowId: workflow.id,
    castId: cast.id,
    candidateId: baseCandidate.id,
    approvalReason: cast.approval?.reason || "Keep the human-selected identity and deterministically contain existing approved views inside the exact QA grid.",
    approvedBy: cast.approval?.approvedBy || "human-user",
    candidateLabel: cast.approval?.selectedCandidateLabel || baseCandidate.blindLabel,
    candidateSetId: cast.approval?.candidateSetId || baseCandidate.candidateSetId,
    verdictDigest: cast.approval?.verdictDigest || "",
    candidateReviewPath: cast.approval?.candidateReviewPath || cast.candidateReviewPath,
    generatorContextId,
    jobs: allJobs,
    results: combinedResults,
    repairEvidence: {
      repairId,
      failedReviewPath: failedReviewArchive?.path || "",
      failedReviewSha256: failedReviewArchive?.sha256 || "",
      findingsPath: findingRepair?.path || "",
      findingsSha256: findingRepair?.sha256 || "",
      repairPlanPath: findingRepair?.planPath || "",
      repairPlanSha256: findingRepair?.planSha256 || "",
      repairPlanDigest: findingRepair?.repairPlan?.digest || "",
      findingIds: findingRepair?.relevantFindings?.map((entry) => entry.findingId) || [],
      failedRoles: failedReview.failedRoles,
      generationCheckpointPath: repackEvidencePath,
    },
  });
  const state = await updateState(paths, {
    status: "character-identity-review-required",
    currentStage: "character-identity-review",
    knownRemainingIssues: [{
      id: "character-identity-repack-review",
      detail: `Repack ${repairId} redrew nothing and contained existing failed roles (${failedReview.failedRoles.join(", ")}) in exact cells. Independently recheck all eight/12 cells at ${staged.identityReviewDraftPath}.`,
    }],
  });
  return { episodeId: options.episodeId, workflowId: workflow.id, castId: cast.id, repairId, failedRoles: failedReview.failedRoles, repackEvidencePath, staged, state };
}

function viewpointForComposition(composition = {}, index = 0) {
  const elevation = String(composition.setup?.elevation || "").toLowerCase();
  const azimuth = String(composition.setup?.azimuth || "").toLowerCase();
  const shotSize = String(composition.setup?.shotSize || "").toLowerCase();
  if (/(?:top|overhead|bird)/u.test(elevation) || /(?:top|overhead)/u.test(azimuth)) return "top";
  if (azimuth.includes("left")) return "left";
  if (azimuth.includes("right") || azimuth.includes("reverse")) return "right";
  if (/(?:wide|long)/u.test(shotSize)) return "wide";
  return index % 2 === 0 ? "left" : "right";
}

export function koyaCameraModeForShot(viewpoint, movingIndex) {
  // A wide source has no left/right/top semantic direction. Applying a
  // directional mode to it creates an impossible camera contract (for
  // example, viewpoint=wide with mode=left-then-pullout). Keep the strong
  // reveal as a pure pull-out and reserve directional modes for matching
  // directional source viewpoints.
  if (viewpoint === "wide") return "pullout-only";
  const family = ["directional", "combined", "pullout"][movingIndex % 3];
  const direction = viewpoint;
  if (family === "pullout") return "pullout-only";
  if (family === "combined") return `${direction}-then-pullout`;
  return `${direction}-only`;
}

export function koyaCameraModeForMissingFamily(viewpoint, emittedFamilies, movingIndex = 0, composition = {}) {
  let missingFamily = ["directional", "combined", "pullout"]
    .find((family) => !emittedFamilies.has(family));
  // The normal wide-shot default remains a true pull-out. A wide establishing
  // composition with explicit depth/foreground can, however, scan the spatial
  // relationship it was authored to establish. This is a semantic exception,
  // not a fake left/right label applied to every wide source.
  const semanticWideScan = viewpoint === "wide"
    && missingFamily !== "pullout"
    && nonEmpty(composition?.setup?.depth)
    && nonEmpty(composition?.visibleAction);
  // Prefer the combined family on a roomy establishing illustration. Pure
  // directional travel is then still available to a later flattened split
  // page, whose typography-safe camera window is intentionally tighter.
  if (semanticWideScan && !emittedFamilies.has("directional") && !emittedFamilies.has("combined")) {
    missingFamily = "combined";
  }
  if (viewpoint === "wide" && !semanticWideScan) return "pullout-only";
  const direction = semanticWideScan
    ? (Number(composition.sequenceIndex || movingIndex) % 2 === 0 ? "right" : "left")
    : viewpoint;
  if (missingFamily === "directional") return `${direction}-only`;
  if (missingFamily === "combined") return `${direction}-then-pullout`;
  if (missingFamily === "pullout") return "pullout-only";
  return koyaCameraModeForShot(viewpoint, movingIndex);
}

export function dialogueShotRequiresAnchoredPullout(activeSpeakerFace) {
  if (!activeSpeakerFace) return false;
  const faceCenterX = Number(activeSpeakerFace.x) + Number(activeSpeakerFace.width) / 2;
  const faceCenterY = Number(activeSpeakerFace.y) + Number(activeSpeakerFace.height) / 2;
  return faceCenterX < 0.34 || faceCenterX > 0.66 || faceCenterY < 0.28 || faceCenterY > 0.72;
}

export async function reuseKoyaApprovedAudio(manifest, previousManifest) {
  const previousById = new Map((previousManifest?.utterances || []).map((entry) => [entry.id, entry]));
  const reused = [];
  for (const utterance of manifest.utterances || []) {
    const previous = previousById.get(utterance.id);
    const audio = previous?.audio;
    const sameContractInput = previous
      && previous.cutId === utterance.cutId
      && previous.speakerId === utterance.speakerId
      && previous.text === utterance.text
      && previous.speechText === utterance.speechText
      && previous.voiceId === utterance.voiceId
      && previous.model === utterance.model
      && JSON.stringify(previous.voiceSettings || {}) === JSON.stringify(utterance.voiceSettings || {});
    if (!sameContractInput || !nonEmpty(audio?.filePath) || !await exists(resolve(audio.filePath))) continue;
    utterance.audio = structuredClone(audio);
    reused.push(utterance.id);
  }
  return reused;
}

export async function recoverKoyaApprovedAudioFromAlignments(manifest, canvasDir) {
  const recovered = [];
  for (const utterance of manifest.utterances || []) {
    if (nonEmpty(utterance.audio?.filePath) && await exists(resolve(utterance.audio.filePath))) continue;
    const expectedFileName = `${manifest.id}-${utterance.id}-koya-v44.wav`;
    const alignmentPath = join(resolve(canvasDir), "audio-alignments", `${expectedFileName}.json`);
    let audio;
    try {
      audio = await readJson(alignmentPath);
    } catch {
      continue;
    }
    const exactBoundInput = audio?.pipeline === "koya-dialogue-v44"
      && audio?.utteranceId === utterance.id
      && audio?.displayText === utterance.text
      && audio?.speechText === utterance.speechText
      && audio?.voiceId === utterance.voiceId
      && audio?.model === utterance.model
      && basename(audio?.filePath || "") === expectedFileName
      && resolve(audio?.alignmentPath || "") === alignmentPath
      && await exists(resolve(audio?.filePath || ""));
    if (!exactBoundInput) continue;
    utterance.audio = structuredClone(audio);
    recovered.push(utterance.id);
  }
  return recovered;
}

export function groupPagesForPacing(pages, utteranceById, compositionByUtterance = new Map()) {
  const groups = [];
  for (const page of pages) {
    const utterance = utteranceById.get(page.utteranceId);
    const previous = groups.at(-1);
    const pacing = page.pacing && typeof page.pacing === "object" ? page.pacing : {};
    const holdGroup = nonEmpty(pacing.holdGroup);
    const pageIsSpecial = page.editorial?.split?.recommended || page.editorial?.editorialPlate?.recommended;
    const previousPageIsSpecial = previous?.pages?.some((entry) => (
      entry.editorial?.split?.recommended || entry.editorial?.editorialPlate?.recommended
    ));
    const explicitHold = previous
      && previous.cutId === page.cutId
      && previous.pages.length < 2
      && holdGroup
      && previous.holdGroup === holdGroup
      && pacing.dedicatedVisual !== true
      && !pageIsSpecial
      && !previousPageIsSpecial;
    const sameSpeakerContinuation = previous
      && previous.cutId === page.cutId
      && previous.pages.length < 2
      && utterance?.speakerId !== "narration"
      && previous.speakerId === utterance?.speakerId
      && pacing.dedicatedVisual !== true
      && !pageIsSpecial
      && !previousPageIsSpecial;
    const compositionIntent = compositionByUtterance.get(page.utteranceId)?.intent || "";
    const narrationRequiresDedicatedVisual = utterance?.speakerId === "narration"
      && (
        /(?:子供|子ども|赤ちゃん|家族|結婚|妊娠|出産|卒業|入学|就職|内定|昇進|解雇|死亡|葬儀|病院|手術|事故|引っ越|転居|到着|出発|出てい|立ち去|去った|翌日|数年後|数ヶ月後|写真|スマホ|地図|賞状|契約書|手紙|証拠)/u.test(utterance?.text || "")
        // A purpose-reflection image expresses an internal choice through a
        // deliberate face/posture/prop composition. Bridging it onto the
        // preceding dialogue image discards that authored evidence and can
        // leave a narration card trapped between unrelated close-up heads.
        || ["purpose-reflection", "scene-establishing", "object-action", "resolution-montage"].includes(compositionIntent)
        || /(?:開場|開演|開会|催事|式|会議|授業|営業).{0,12}(?:始ま|始め|開始)/u.test(utterance?.text || "")
      );
    const dedicatedVisual = pacing.dedicatedVisual === true || narrationRequiresDedicatedVisual;
    const narrationBridge = previous
      && previous.cutId === page.cutId
      && previous.pages.length < 2
      // Keep long narration holds unless the incoming narration explicitly
      // introduces a visible fact (for example children, graduation, a
      // letter, or a location/time transition). Such a line already owns a
      // purpose-built source image and must not be hidden merely to increase
      // hold length. Narration/dialogue bridges keep their existing concrete
      // character-led representative-page behavior.
      && !dedicatedVisual
      && previous.dedicatedNarrationVisual !== true
      && (previous.speakerId === "narration" || utterance?.speakerId === "narration")
      && !pageIsSpecial
      && !previousPageIsSpecial;
    if (explicitHold || sameSpeakerContinuation || narrationBridge) {
      previous.pages.push(page);
      previous.utteranceIds.push(page.utteranceId);
      // Narration may hold over the concrete dialogue illustration, but a
      // dialogue must never be assigned to a narration-only establishing
      // image that lacks its active speaker.  Preserve utterance order while
      // choosing the non-narration page as the visual/face evidence source.
      if (pacing.preferAsRepresentative === true
        || previous.speakerId === "narration" && utterance?.speakerId !== "narration") {
        previous.representativePage = page;
        previous.speakerId = utterance.speakerId;
      }
    } else {
      groups.push({
        cutId: page.cutId,
        speakerId: utterance?.speakerId || "",
        pages: [page],
        representativePage: page,
        utteranceIds: [page.utteranceId],
        holdGroup,
        dedicatedNarrationVisual: dedicatedVisual,
      });
    }
  }
  return groups;
}

export async function runSourceFacePlacement(paths, planPath, sourceFaceReviewPath = "", options = {}) {
  let exitCode = 0;
  let stderr = "";
  const runCommand = options.runCommand ?? execFile;
  // A failed detector must never inherit a passing report from an earlier
  // invocation. Remove this exact derived artifact before spawning so only a
  // report produced by the current command can be accepted.
  await unlink(paths.sourceFaceReportPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  try {
    const python = await requirePythonRuntime({
      runtime: options.pythonRuntime,
      purposeEnv: "KOYA_GATE_PYTHON",
      projectDir: paths.projectDir,
      requiredModules: ["cv2", "cv2:CascadeClassifier"],
    });
    const command = [
      join(paths.projectDir, "scripts/detect-koya-manga-source-faces.py"),
      "--plan", planPath,
      "--output", paths.sourceFaceReportPath,
      "--cascade", join(paths.projectDir, "scripts/data/lbpcascade_animeface.xml"),
    ];
    if (nonEmpty(sourceFaceReviewPath)) command.push("--review", resolve(sourceFaceReviewPath));
    await runCommand(python.command, [...python.args, ...command], { cwd: paths.projectDir, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    exitCode = error.code || 1;
    stderr = error.stderr || error.message;
  }
  if (!await exists(paths.sourceFaceReportPath)) {
    throw new Error(`Source face placement failed before producing evidence: ${stderr}`);
  }
  const report = await readJson(paths.sourceFaceReportPath);
  return { report, exitCode };
}

/**
 * Arguments for the shared manifest builder on the Koya path.
 *
 * The generic builder casts and persists voices automatically whenever an
 * ElevenLabs key exists. Koya voices must be chosen by a person through an
 * anonymous comparison, so this path always turns casting and its registry
 * write off; voices come only from what the registry already records.
 */
export function koyaEpisodeManifestPipelineOptions({
  projectDir,
  episodeId,
  scriptPath = "",
  plan = {},
  firstPageByCut = new Map(),
  resolved,
} = {}) {
  const contract = resolved?.contract || resolved;
  return {
    projectDir,
    scriptPath: scriptPath || plan.sourceScript?.path || plan.manifest?.scriptPath,
    scriptText: plan.sourceScript?.text || plan.manifest?.scriptText || plan.scriptText,
    episodeId,
    title: plan.manifest?.title,
    imagePathByCutId: Object.fromEntries(firstPageByCut),
    model: "eleven_v3",
    motion: "left-only",
    width: contract.video.width,
    height: contract.video.height,
    fps: contract.video.fps,
    bgmPath: "",
    bgmVolume: 0,
    normalizeVoiceAudio: false,
    voiceTargetLufs: contract.audio.targetLineLufs,
    masterTargetLufs: contract.audio.masterTargetLufs,
    masterTruePeakDb: contract.audio.masterTruePeakDb,
    sameSpeakerGapSeconds: contract.audio.sameSpeakerGapSeconds,
    speakerChangeGapSeconds: contract.audio.speakerChangeGapSeconds,
    emphasisGapSeconds: contract.audio.emphasisGapSeconds,
    bubbleFadeInMilliseconds: contract.bubbles.fadeInMilliseconds,
    bubbleFadeOutMilliseconds: contract.bubbles.fadeOutMilliseconds,
    bubbleTransitionCrossfadeSeconds: contract.bubbles.transitionCrossfadeSeconds,
    stripTerminalJapanesePeriod: contract.bubbles.stripTerminalJapanesePeriod,
    autoCastVoices: false,
    persistVoiceCasting: false,
  };
}

/**
 * Replace the generic builder's casting summary with what the registry
 * records for each speaking character. A validation canary keeps its own
 * provisional summary. This only describes the state; the refusal happens
 * right before paid speech.
 */
export function recordKoyaRegistryVoiceSelections(manifestInput, { registry, validationCanary, narrationVoicePolicy } = {}) {
  const manifest = structuredClone(manifestInput);
  if (manifest.production?.validationCanary?.active === true) return manifest;
  const audit = auditKoyaVoiceSelections({ manifest, registry, validationCanary, narrationVoicePolicy });
  manifest.speech = {
    ...(manifest.speech || {}),
    voiceCasting: {
      status: audit.pass ? "human-selected" : "human-selection-required",
      source: "character-registry",
      scope: "speaking-cast-plus-protagonist-narration",
      autoCast: "disabled",
      guardVersion: KOYA_VOICE_SELECTION_GUARD_VERSION,
      assignments: audit.speakers.map((entry) => ({
        characterId: entry.characterId,
        characterName: entry.speakerName || entry.characterId,
        voiceProfileId: entry.voiceProfileId,
        voiceId: entry.voiceId,
        protagonist: entry.protagonist,
        selection: entry.selectionKind,
      })),
      pendingCharacterIds: audit.pendingCharacterIds,
    },
  };
  return manifest;
}

function isKoyaNarrationRow(row) {
  return row?.speakerId === "narration" || row?.preset === "narration";
}

/** Where the refusal message points: this project, this Job, and its audition files. */
function koyaVoiceSelectionMessageOptions({ projectDir, jobId = "", jobProjectDir = "" } = {}) {
  const root = resolve(projectDir || process.cwd());
  return {
    projectDir: root,
    jobId: nonEmpty(jobId),
    jobProjectDir: nonEmpty(jobProjectDir),
    auditionPaths: (registryEpisodeId) => voiceLibraryAuditionPaths({ projectDir: root, episodeId: registryEpisodeId }),
  };
}

async function recordKoyaVoiceSelectionPause(paths, { episodeId, stage, error, pendingCutIds = null }) {
  await updateState(paths, {
    episodeId,
    status: "awaiting-voice-selection",
    currentStage: stage,
    knownRemainingIssues: [{
      id: "voice-selection-required",
      characterIds: error.characterIds,
      ...(pendingCutIds ? { pendingCutIds } : {}),
      detail: error.message,
    }],
  });
}

/**
 * The canary exception is recomputed from the frozen episode override, never
 * taken from a manifest.
 */
async function resolveKoyaVoiceSelectionCanary({ projectDir, episodeId, resolved, showBible = null }) {
  const policy = resolved?.episodeOverride?.validationCanary;
  if (!policy) return { validationCanary: { active: false }, showBible };
  const canaryShowBible = showBible || (await readKoyaChannelAuthority({ projectDir })).showBible;
  return {
    validationCanary: resolveKoyaValidationCanary({ episodeId, policy, showBible: canaryShowBible }),
    showBible: canaryShowBible,
  };
}

/**
 * Refuse paid speech unless every speaking character (and the protagonist,
 * whose voice narration uses) has a human-selected voice in the registry.
 */
export async function assertKoyaSpeechVoiceSelections({
  projectDir,
  episodeId,
  manifest,
  resolved,
  jobId = "",
  jobProjectDir = "",
  registry = null,
  showBible = null,
} = {}) {
  const root = resolve(projectDir || process.cwd());
  const { validationCanary } = await resolveKoyaVoiceSelectionCanary({ projectDir: root, episodeId, resolved, showBible });
  return assertKoyaHumanVoiceSelections({
    manifest,
    registry: registry || await readCharacterRegistry({ projectDir: root }),
    validationCanary,
    narrationVoicePolicy: resolved?.contract?.audio?.narrationVoicePolicy,
    ...koyaVoiceSelectionMessageOptions({ projectDir: root, jobId, jobProjectDir }),
  });
}

/**
 * The gate generateKoyaMangaSpeech hands to the dialogue runner. It runs only
 * when a cut would really be generated (or a line has no voice at all); a
 * refusal is recorded in the episode state so `status` shows who still needs
 * a human voice selection.
 */
export function koyaSpeechVoiceSelectionGate({ projectDir, episodeId, resolved, jobId = "", jobProjectDir = "" } = {}) {
  const paths = episodePaths(resolve(projectDir || process.cwd()), episodeId);
  return async ({ manifest, pendingCutIds = [] } = {}) => {
    try {
      return await assertKoyaSpeechVoiceSelections({
        projectDir: paths.projectDir,
        episodeId,
        manifest,
        resolved,
        jobId,
        jobProjectDir,
      });
    } catch (error) {
      if (error?.code === KOYA_VOICE_SELECTION_REQUIRED_CODE) {
        await recordKoyaVoiceSelectionPause(paths, { episodeId, stage: "speech", error, pendingCutIds });
      }
      throw error;
    }
  };
}

/**
 * The manifest as the guard should see it once narration is bound to the
 * protagonist: narration lines carry the protagonist's registry voice (or
 * none yet) and the protagonist is recorded. Returns null when the
 * protagonist cannot be resolved; that refusal belongs to the stage that owns
 * it, not to the voice guard.
 */
export function koyaVoiceSelectionProbe(manifest, { narrationVoicePolicy = "", protagonistRequest = "" } = {}) {
  const probe = structuredClone(manifest || {});
  const utterances = Array.isArray(probe.utterances) ? probe.utterances : [];
  const narration = utterances.filter(isKoyaNarrationRow);
  if (narrationVoicePolicy !== "protagonist-voice" || narration.length === 0) return probe;
  let protagonist;
  try {
    protagonist = resolveKoyaProtagonistSpeaker(probe, protagonistRequest);
  } catch {
    return null;
  }
  const source = utterances.find((row) => (
    !isKoyaNarrationRow(row) && row.speakerId === protagonist.speakerId && nonEmpty(row.voiceId)
  ));
  for (const row of narration) {
    Object.assign(row, { voiceId: source?.voiceId || "", voiceProfileId: source?.voiceProfileId || "" });
  }
  probe.production = { ...(probe.production || {}), protagonistSpeakerId: protagonist.speakerId };
  return probe;
}

/**
 * With casting off, a protagonist who has no registry voice stops prepare,
 * because narration must speak with that voice. When that is the cause,
 * return the guided voice-selection error (every person still needing a
 * selection, and the commands) instead of the bare policy refusal. Any other
 * cause returns the original error unchanged.
 */
export async function explainKoyaUnvoicedProtagonist(error, {
  manifest,
  resolved,
  protagonistRequest = "",
  registry,
  validationCanary,
  paths,
  episodeId,
  jobId = "",
  jobProjectDir = "",
} = {}) {
  const contract = resolved?.contract || resolved;
  if (contract?.audio?.narrationVoicePolicy !== "protagonist-voice") return error;
  const probe = koyaVoiceSelectionProbe(manifest, { narrationVoicePolicy: "protagonist-voice", protagonistRequest });
  const protagonistId = nonEmpty(probe?.production?.protagonistSpeakerId);
  if (!protagonistId) return error;
  const voiced = (probe.utterances || []).some((row) => (
    !isKoyaNarrationRow(row) && row.speakerId === protagonistId && nonEmpty(row.voiceId)
  ));
  if (voiced) return error;
  try {
    assertKoyaHumanVoiceSelections({
      manifest: probe,
      registry,
      validationCanary,
      narrationVoicePolicy: "protagonist-voice",
      ...koyaVoiceSelectionMessageOptions({ projectDir: paths.projectDir, jobId, jobProjectDir }),
    });
  } catch (guardError) {
    if (guardError?.code !== KOYA_VOICE_SELECTION_REQUIRED_CODE) return error;
    await recordKoyaVoiceSelectionPause(paths, { episodeId, stage: "prepare", error: guardError });
    return guardError;
  }
  return error;
}

/**
 * With casting off, any speaker whose registry entry has no voice reaches
 * prepare with empty voice fields. Such a line can never be spoken, so stop
 * here with the guided error (and the awaiting-voice-selection state) instead
 * of letting speech fail per cut. Voiced lines are left to the paid-speech
 * gate, which knows which cuts are already approved.
 */
export async function assertKoyaPreparedSpeakersVoiced(manifest, {
  registry,
  validationCanary,
  narrationVoicePolicy,
  paths,
  episodeId,
  jobId = "",
  jobProjectDir = "",
} = {}) {
  const unvoiced = (manifest?.utterances || []).some((row) => !isKoyaNarrationRow(row) && !nonEmpty(row.voiceId));
  if (!unvoiced) return null;
  try {
    return assertKoyaHumanVoiceSelections({
      manifest,
      registry,
      validationCanary,
      narrationVoicePolicy,
      ...koyaVoiceSelectionMessageOptions({ projectDir: paths.projectDir, jobId, jobProjectDir }),
    });
  } catch (error) {
    if (error?.code === KOYA_VOICE_SELECTION_REQUIRED_CODE) {
      await recordKoyaVoiceSelectionPause(paths, { episodeId, stage: "prepare", error });
    }
    throw error;
  }
}

async function koyaSpeechEvidenceExists(paths, episodeId) {
  try {
    const prefix = `${episodeId}-cut-`;
    return (await readdir(join(paths.canvasDir, "audio-alignments")))
      .some((name) => name.startsWith(prefix) && name.endsWith("-koya-v44.wav.json"));
  } catch {
    return false;
  }
}

/**
 * Before any paid image, stop a fresh Koya episode whose speaking cast (or the
 * protagonist behind narration) has no human-selected voice: speech would
 * refuse later anyway, after the images were paid for.
 *
 * This check only ever adds that one refusal. Once an episode manifest exists
 * (prepare only builds one after every image exists, so no image is left to
 * pay for) or speech evidence for the episode exists, the prepare and
 * paid-speech checks decide; the speech gate knows which cuts are already
 * approved and would not be paid again. Anything this check cannot evaluate
 * (an unreadable script, an unresolved protagonist, an invalid canary policy)
 * is left to the stage that already owns that error.
 */
export async function assertKoyaVoiceSelectionsBeforeImages(options = {}, context = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  const episodeId = nonEmpty(options.episodeId);
  if (!episodeId) return { skipped: "no-episode-id" };
  const paths = episodePaths(projectDir, episodeId);
  if (await exists(paths.manifestPath)) return { skipped: "manifest-exists" };
  if (await koyaSpeechEvidenceExists(paths, episodeId)) return { skipped: "speech-evidence-exists" };
  let probe;
  let registry;
  let validationCanary;
  let narrationVoicePolicy;
  try {
    const scriptText = nonEmpty(options.scriptText) || await readFile(resolve(options.scriptPath), "utf8");
    registry = await readCharacterRegistry({ projectDir });
    const resolved = await resolveKoyaMangaProductionContract({
      projectDir,
      episodeId,
      contractPath: options.contractPath,
      overridePath: options.overridePath,
    });
    narrationVoicePolicy = resolved.contract.audio.narrationVoicePolicy;
    const canary = await resolveKoyaVoiceSelectionCanary({ projectDir, episodeId, resolved });
    validationCanary = canary.validationCanary;
    if (validationCanary.active === true && validationCanary.pass !== true) {
      return { skipped: "validation-canary-invalid" };
    }
    // The same parse and the same registry lookup createEpisodeManifest uses,
    // without casting: every line gets the voice its character already has.
    const parsed = parseMangaScript(scriptText, { registry, title: options.title });
    const voices = Array.isArray(registry.voices) ? registry.voices : [];
    let manifest = {
      id: episodeId,
      utterances: parsed.utterances.map((utterance) => {
        if (utterance.speakerId === "narration") return { ...utterance, voiceProfileId: "", voiceId: "" };
        const character = findCharacter(registry, utterance.speakerId);
        const voice = voices.find((entry) => entry.id === character?.voiceId) || null;
        return {
          ...utterance,
          voiceProfileId: voice?.id || "",
          voiceId: voice?.providerVoiceId || voice?.elevenLabsVoiceId || "",
        };
      }),
    };
    manifest = applyKoyaValidationCanaryVoiceProfiles(manifest, validationCanary, registry, canary.showBible);
    const [previousPlan, previousState] = await Promise.all([
      readJson(paths.imagePlanPath).catch(() => null),
      readJson(paths.statePath).catch(() => null),
    ]);
    probe = koyaVoiceSelectionProbe(manifest, {
      narrationVoicePolicy,
      protagonistRequest: options.protagonistSpeakerId
        || previousPlan?.production?.protagonistSpeakerName
        || previousPlan?.production?.protagonistSpeakerId
        || previousState?.protagonistSpeakerName
        || previousState?.protagonistSpeakerId
        || "",
    });
  } catch (error) {
    return { skipped: "not-evaluable", detail: String(error?.message || error) };
  }
  if (!probe) return { skipped: "protagonist-unresolved" };
  try {
    const audit = assertKoyaHumanVoiceSelections({
      manifest: probe,
      registry,
      validationCanary,
      narrationVoicePolicy,
      ...koyaVoiceSelectionMessageOptions({ projectDir, jobId: context.jobId, jobProjectDir: context.jobProjectDir }),
    });
    return { pass: true, audit };
  } catch (error) {
    if (error?.code === KOYA_VOICE_SELECTION_REQUIRED_CODE) {
      await recordKoyaVoiceSelectionPause(paths, { episodeId, stage: "voice-selection", error });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// wardrobe-readiness (docs/manga-wardrobe-readiness-spec-ja.md). The rules live
// in koyaWardrobeReadiness.mjs; this part only reads and writes the episode's
// files. `runtime.readKoyaChannelAuthority` and `runtime.env` exist for tests;
// production passes neither.

async function readKoyaWardrobeInputs({ projectDir, options = {}, runtime = {} }) {
  const readAuthority = runtime.readKoyaChannelAuthority || readKoyaChannelAuthority;
  const authority = await readAuthority({ projectDir });
  assertProductionChannelAuthority(authority, "wardrobe-readiness", {
    allowBorrowedChannelData: options.allowBorrowedChannelData === true,
  });
  const registry = await readCharacterRegistry({ projectDir });
  return { showBible: authority.showBible, registry };
}

function evaluateKoyaEpisodeWardrobe({ episodeId, scriptText, title, registry, showBible, review = null, reviewPath = "", reviewSha256 = "", generatorContexts = [] }) {
  const parsed = parseMangaScript(scriptText, { registry, title });
  return evaluateKoyaWardrobeReadiness({
    episodeId,
    scriptText,
    parsed,
    registry,
    showBible,
    review,
    reviewPath,
    reviewSha256,
    generatorContexts,
  });
}

function tryResolveGeneratorProvenance(options = {}, env = process.env) {
  try {
    return resolveKoyaAgentProvenance({
      role: "generator",
      host: options.generatorHost,
      id: options.generatorId,
      contextId: options.generatorContextId,
      env,
    });
  } catch {
    return null;
  }
}

/**
 * The contexts a wardrobe review must not come from: the episode's recorded
 * image generator and the context running the gate now.
 */
function koyaWardrobeGeneratorContexts({ previousPlan, previousState, options, env }) {
  const contexts = [];
  const episodeGenerator = previousPlan?.production?.generatorProvenance || previousState?.generatorProvenance;
  if (nonEmpty(episodeGenerator?.contextId)) {
    contexts.push({ role: "episode-generator", host: episodeGenerator.host, id: episodeGenerator.id, contextId: episodeGenerator.contextId });
  }
  const invocation = tryResolveGeneratorProvenance(options, env);
  if (invocation) contexts.push({ role: "gate-invocation", host: invocation.host, id: invocation.id, contextId: invocation.contextId });
  return contexts;
}

// Episode states that only exist once this episode's images were generated.
// A wardrobe refusal at or after these must not rewrite the checkpoint the
// operator resumes from.
const KOYA_STATUSES_AFTER_IMAGES = new Set([
  "images-ready",
  "awaiting-source-face-review",
  "bubble-layout-ready",
  "manifest-ready",
  "speech-planned",
  "speech-ready",
  "waiting-usage-limit",
  "audio-repaired-awaiting-render",
  "timing-adjusted-awaiting-render",
  "layout-adjusted-awaiting-render",
  "video-substitution-ready",
  "video-substitution-blocked",
  "waiting-paid-video-confirmation",
  "rendered-awaiting-audit",
]);

const KOYA_WARDROBE_STATE_ISSUE_ID = "wardrobe-readiness-required";

/** Keep the issues the episode already carries; replace only our own entry. */
function appendKnownIssue(previous, issue) {
  const kept = (Array.isArray(previous) ? previous : []).filter((entry) => entry?.id !== issue.id);
  return [...kept, issue];
}

function withoutKnownIssue(previous, id) {
  return (Array.isArray(previous) ? previous : []).filter((entry) => entry?.id !== id);
}

/**
 * Once the gate passes (or is overridden), drop the wardrobe entry this gate
 * added and leave every other issue alone. Nothing is written when the episode
 * never carried one, so a passing check does not touch the checkpoint.
 */
function clearedWardrobeIssue(previousState) {
  const issues = Array.isArray(previousState?.knownRemainingIssues) ? previousState.knownRemainingIssues : [];
  const carries = issues.some((entry) => entry?.id === KOYA_WARDROBE_STATE_ISSUE_ID);
  const top = carries ? { knownRemainingIssues: withoutKnownIssue(issues, KOYA_WARDROBE_STATE_ISSUE_ID) } : {};
  // This gate is the only writer of awaiting-wardrobe-readiness, and it
  // remembers what it interrupted, so a later pass hands the episode back
  // instead of leaving it parked at the gate.
  const interrupted = previousState?.wardrobeReadiness?.interrupted;
  const restored = previousState?.status === "awaiting-wardrobe-readiness" && nonEmpty(interrupted?.status);
  if (restored) {
    top.status = interrupted.status;
    top.currentStage = nonEmpty(interrupted.currentStage) || "images";
  }
  return { top, clearInterrupted: restored };
}

async function recordKoyaWardrobeState(paths, episodeId, record, { appendOverride = null, top = {}, clearInterrupted = false } = {}) {
  const previous = await readJson(paths.statePath).catch(() => ({}));
  const overrideHistory = Array.isArray(previous.wardrobeReadiness?.overrideHistory)
    ? [...previous.wardrobeReadiness.overrideHistory]
    : [];
  // What the refusal interrupted survives a later free check of the same
  // episode, so the pass that follows can hand the episode back to it.
  const interrupted = clearInterrupted || record.interrupted !== undefined
    ? record.interrupted
    : previous.wardrobeReadiness?.interrupted;
  if (appendOverride) {
    const last = overrideHistory.at(-1);
    if (last && last.reason === appendOverride.reason && last.scriptDigest === appendOverride.scriptDigest) {
      last.lastConfirmedAt = appendOverride.recordedAt;
    } else {
      overrideHistory.push(appendOverride);
    }
  }
  return updateState(paths, {
    episodeId,
    ...top,
    wardrobeReadiness: {
      version: KOYA_WARDROBE_READINESS_VERSION,
      ...record,
      ...(interrupted ? { interrupted } : {}),
      overrideHistory,
    },
  });
}

/**
 * The `wardrobe-readiness` action: evaluate the episode's script against the
 * registry and show bible (plus an optional independent review), write the
 * inventory next to the image plan, and record the result in the episode
 * state. exitCode 0 = every checked character has an outfit for every scene,
 * 2 = pending slots remain. No paid call is made.
 */
export async function runKoyaWardrobeReadiness(options = {}, runtime = {}) {
  const env = runtime.env || process.env;
  const projectDir = resolve(options.projectDir || process.cwd());
  const episodeId = nonEmpty(options.episodeId);
  if (!episodeId) throw new Error("episodeId is required.");
  const paths = episodePaths(projectDir, episodeId);
  const [previousState, previousPlan] = await Promise.all([
    readJson(paths.statePath).catch(() => ({})),
    readJson(paths.imagePlanPath).catch(() => null),
  ]);
  const scriptPath = nonEmpty(options.scriptPath) ? resolve(options.scriptPath) : nonEmpty(previousState.scriptPath);
  if (!nonEmpty(options.scriptText) && !scriptPath) {
    throw new Error("wardrobe-readiness needs --script-path (this episode has no recorded script yet).");
  }
  const scriptText = nonEmpty(options.scriptText) ? options.scriptText : await readFile(scriptPath, "utf8");
  const inputs = await readKoyaWardrobeInputs({ projectDir, options, runtime });
  let review = null;
  let reviewPath = "";
  let reviewSha256 = "";
  if (nonEmpty(options.wardrobeReviewPath)) {
    reviewPath = resolve(options.wardrobeReviewPath);
    const bytes = await readFile(reviewPath);
    reviewSha256 = createHash("sha256").update(bytes).digest("hex");
    try {
      review = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new Error(`wardrobe review is not valid JSON: ${reviewPath} (${error.message})`);
    }
  }
  const evaluated = evaluateKoyaEpisodeWardrobe({
    episodeId,
    scriptText,
    title: options.title,
    ...inputs,
    review,
    reviewPath,
    reviewSha256,
    generatorContexts: koyaWardrobeGeneratorContexts({ previousPlan, previousState, options, env }),
  });
  const generatedAt = new Date().toISOString();
  const report = { ...evaluated, generatedAt, scriptPath };
  await writeJsonAtomic(paths.wardrobeReadinessPath, report);
  const reportSha256 = await sha256Path(paths.wardrobeReadinessPath);
  const state = await recordKoyaWardrobeState(paths, episodeId, {
    status: report.status,
    stage: "wardrobe-readiness",
    reportPath: paths.wardrobeReadinessPath,
    reportSha256,
    inventoryDigest: report.inventoryDigest,
    outcomeDigest: report.outcomeDigest,
    scriptDigest: report.scriptDigest,
    pendingSlotIds: report.pendingSlotIds,
    checkedAt: generatedAt,
  });
  return {
    episodeId,
    exitCode: report.pass ? 0 : 2,
    report,
    reportPath: paths.wardrobeReadinessPath,
    reportSha256,
    paths,
    state,
  };
}

async function verifyKoyaWardrobeReportForImages({ projectDir, episodeId, paths, scriptText, scriptDigest, options, runtime, env, previousState }) {
  const reportPath = paths.wardrobeReadinessPath;
  let bytes;
  try {
    bytes = await readFile(reportPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { pass: false, status: "missing", failures: [`no wardrobe-readiness report at ${reportPath}`], reportPath: "" };
  }
  const reportSha256 = createHash("sha256").update(bytes).digest("hex");
  let report;
  try {
    report = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { pass: false, status: "stale", failures: ["the wardrobe-readiness report is not valid JSON"], reportPath, reportSha256 };
  }
  const stale = (failure) => ({ pass: false, status: "stale", failures: [failure], reportPath, reportSha256, report });
  const checked = checkKoyaWardrobeReport(report, { episodeId, scriptDigest });
  if (!checked.pass) return { ...checked, reportPath, reportSha256, report };
  // A pass is only as good as the inputs it was computed from: recompute it
  // with today's registry, show bible and the exact review file it names.
  let review = null;
  let reviewSha256 = "";
  if (report.review) {
    try {
      const reviewBytes = await readFile(report.review.path);
      reviewSha256 = createHash("sha256").update(reviewBytes).digest("hex");
      review = JSON.parse(reviewBytes.toString("utf8"));
    } catch {
      return stale(`the wardrobe review the report relies on cannot be read: ${report.review.path || "(no path)"}`);
    }
    if (reviewSha256 !== report.review.sha256) return stale("the wardrobe review file changed after the report was written");
  }
  const inputs = await readKoyaWardrobeInputs({ projectDir, options, runtime });
  let recomputed;
  try {
    recomputed = evaluateKoyaEpisodeWardrobe({
      episodeId,
      scriptText,
      title: options.title,
      ...inputs,
      review,
      reviewPath: report.review?.path || "",
      reviewSha256,
      generatorContexts: report.generatorContexts || [],
    });
  } catch (error) {
    if (![KOYA_WARDROBE_POLICY_INVALID_CODE, KOYA_WARDROBE_REVIEW_INVALID_CODE].includes(error?.code)) throw error;
    return stale(`the report no longer re-evaluates: ${error.message}`);
  }
  if (recomputed.pass !== true) {
    return stale("with today's registry and show bible this episode no longer passes; rerun wardrobe-readiness");
  }
  // Compare the verdict, not the whole inventory: the inventory folds in every
  // approved channel-wide character and all of their reference assets, so
  // registering next season's cast or adding an unrelated character's
  // expression sheet would invalidate a passing report and stop the Job
  // without being able to change this episode's outcome. The verdict covers
  // the scenes, the outfit each checked character wears (with its sha256) and
  // the slots, so removing this episode's outfit or un-approving one of its
  // characters still refuses. Reports written before the verdict digest
  // existed fall back to the wider comparison.
  const previousVerdict = nonEmpty(report.verdictDigest);
  if (previousVerdict ? recomputed.verdictDigest !== previousVerdict : recomputed.inventoryDigest !== report.inventoryDigest) {
    return stale("the character registry, show bible or scene keyword rules changed this episode's wardrobe verdict after the report; rerun wardrobe-readiness");
  }
  if (report.review) {
    // The review must also come from a context other than the one about to
    // pay for the images.
    const previousPlan = await readJson(paths.imagePlanPath).catch(() => null);
    const imageGenerator = previousPlan?.production?.generatorProvenance
      || previousState?.generatorProvenance
      || tryResolveGeneratorProvenance(options, env);
    if (nonEmpty(imageGenerator?.contextId) && imageGenerator.contextId === report.review.reviewer?.contextId) {
      return stale("the wardrobe review was written by the context that generates this episode's images; an independent context must review");
    }
  }
  return { pass: true, status: "pass", failures: [], reportPath, reportSha256, report };
}

function shellWord(value) {
  const text = String(value ?? "");
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

export function formatKoyaWardrobeReadinessError(verdict, { projectDir, episodeId, scriptPath = "", jobId = "", jobProjectDir = "" } = {}) {
  const pendingSlotIds = verdict.pendingSlotIds || [];
  const check = [
    "node scripts/koya-manga-video.mjs wardrobe-readiness",
    `--project-dir ${shellWord(projectDir)}`,
    `--episode-id ${shellWord(episodeId)}`,
    `--script-path ${scriptPath ? shellWord(scriptPath) : "<script>"}`,
  ].join(" ");
  const resume = [
    "node scripts/run-video-harness.mjs resume",
    `--job-id ${nonEmpty(jobId) ? shellWord(jobId) : "<job id>"}`,
    `--project-dir ${nonEmpty(jobProjectDir) ? shellWord(jobProjectDir) : "<project that holds the Job>"}`,
    "--confirmed",
  ].join(" ");
  return [
    `Koya images stopped before any paid request: wardrobe-readiness is ${verdict.status} for ${episodeId}.`,
    ...verdict.failures.map((failure) => `- ${failure}`),
    ...(verdict.reportPath ? [`Inventory: ${verdict.reportPath}`] : []),
    `Run the free wardrobe check (exit 0 = pass, 2 = pending slots): ${check}`,
    "A pending or undecidable slot is resolved only by a koya-wardrobe-review-v1 file written in a context other than the generator's"
      + " (per slot: decision fits/does-not-fit, the outfit it fits with, and a reason; bound to the inventory's verdictDigest), passed with --wardrobe-review-path;"
      + " a slot that really needs another outfit waits until that outfit is registered with matching sceneTags.",
    "An explicit operator override is recorded in the report and the episode state and shown by the final audit:"
      + " --wardrobe-readiness-override-reason \"<reason>\" on images/full (for an outer Job, on run-video-harness start).",
    `Then resume the same Video Harness Job: ${resume}`,
    ...(pendingSlotIds.length > 0 ? [`Pending slots: ${pendingSlotIds.join(", ")}`] : []),
  ].join("\n");
}

/**
 * Before any paid image: a new or resumed episode needs a wardrobe-readiness
 * pass report for its exact script (episodeId + scriptDigest), still
 * reproducible from today's registry and show bible, or an explicit operator
 * override with a reason. A refusal is recorded in the episode state and
 * thrown with KOYA_WARDROBE_READINESS_REQUIRED_CODE so the full runner can
 * pause the outer Job instead of failing it. A completed episode is left to
 * plan, which refuses to regenerate it.
 */
export async function assertKoyaWardrobeReadinessBeforeImages(options = {}, context = {}) {
  const runtime = context.runtime || {};
  const env = runtime.env || process.env;
  const stage = nonEmpty(context.stage) || "images";
  const projectDir = resolve(options.projectDir || process.cwd());
  const episodeId = nonEmpty(options.episodeId);
  if (!episodeId) throw new Error("episodeId is required.");
  const overrideRequested = options.wardrobeReadinessOverrideReason !== undefined && options.wardrobeReadinessOverrideReason !== "";
  const overrideReason = overrideRequested ? validateKoyaWardrobeOverrideReason(options.wardrobeReadinessOverrideReason) : "";
  const paths = episodePaths(projectDir, episodeId);
  const previousState = await readJson(paths.statePath).catch(() => ({}));
  const resolved = await resolveKoyaMangaProductionContract({
    projectDir,
    episodeId,
    contractPath: options.contractPath,
    overridePath: options.overridePath,
  });
  if (previousState.status === resolved.contract.lifecycle.completionStatus && options.allowCompletedReuse !== true) {
    return { skipped: "episode-complete" };
  }
  const scriptPath = nonEmpty(options.scriptPath) ? resolve(options.scriptPath) : "";
  const scriptText = nonEmpty(options.scriptText) ? options.scriptText : await readFile(scriptPath, "utf8");
  const scriptDigest = koyaWardrobeScriptDigest(scriptText);
  // A mistyped or reused episode id belongs to another script. Say nothing and
  // write nothing: plan (which runs right after this, before any paid call)
  // refuses it with its own error, and this episode's checkpoint stays as the
  // other script left it.
  const ownedPlan = await readJson(paths.imagePlanPath).catch(() => null);
  if (nonEmpty(ownedPlan?.scriptSha256) && ownedPlan.scriptSha256 !== scriptDigest) {
    return { skipped: "episode-owns-another-script" };
  }
  const verdict = await verifyKoyaWardrobeReportForImages({
    projectDir, episodeId, paths, scriptText, scriptDigest, options, runtime, env, previousState,
  });
  const checkedAt = new Date().toISOString();
  if (verdict.pass) {
    const binding = {
      status: "pass",
      stage,
      reportPath: verdict.reportPath,
      reportSha256: verdict.reportSha256,
      inventoryDigest: verdict.report.inventoryDigest,
      outcomeDigest: verdict.report.outcomeDigest,
      scriptDigest,
      pendingSlotIds: [],
      checkedAt,
    };
    await recordKoyaWardrobeState(paths, episodeId, binding, clearedWardrobeIssue(previousState));
    return { pass: true, status: "pass", binding, overrideIgnored: Boolean(overrideReason) };
  }
  if (overrideReason) {
    const override = {
      reason: overrideReason,
      recordedAt: checkedAt,
      scriptDigest,
      stage,
      refusedStatus: verdict.status,
      refusedFailures: verdict.failures,
    };
    // Keep the report truthful (its slots stay pending) and add the override
    // outside its digests; a report for another script is replaced by a
    // fresh inventory of this one.
    let report = verdict.report && verdict.report.episodeId === episodeId && verdict.report.scriptDigest === scriptDigest
      ? { ...verdict.report }
      : null;
    if (!report) {
      try {
        const previousPlan = await readJson(paths.imagePlanPath).catch(() => null);
        const inputs = await readKoyaWardrobeInputs({ projectDir, options, runtime });
        report = {
          ...evaluateKoyaEpisodeWardrobe({
            episodeId,
            scriptText,
            title: options.title,
            ...inputs,
            generatorContexts: koyaWardrobeGeneratorContexts({ previousPlan, previousState, options, env }),
          }),
          generatedAt: checkedAt,
          scriptPath,
        };
      } catch (error) {
        report = {
          version: KOYA_WARDROBE_READINESS_VERSION,
          episodeId,
          scriptDigest,
          status: "not-evaluated",
          pass: false,
          evaluationError: String(error?.message || error),
          generatedAt: checkedAt,
          scriptPath,
        };
      }
    }
    report.operatorOverride = override;
    await writeJsonAtomic(paths.wardrobeReadinessPath, report);
    const reportSha256 = await sha256Path(paths.wardrobeReadinessPath);
    await recordKoyaWardrobeState(paths, episodeId, {
      status: "overridden",
      stage,
      reportPath: paths.wardrobeReadinessPath,
      reportSha256,
      inventoryDigest: report.inventoryDigest || "",
      outcomeDigest: report.outcomeDigest || "",
      scriptDigest,
      pendingSlotIds: report.pendingSlotIds || [],
      checkedAt,
      override,
    }, { appendOverride: override, ...clearedWardrobeIssue(previousState) });
    return { pass: true, status: "overridden", override, reportPath: paths.wardrobeReadinessPath };
  }
  const message = formatKoyaWardrobeReadinessError(verdict, {
    projectDir,
    episodeId,
    scriptPath,
    jobId: context.jobId,
    jobProjectDir: context.jobProjectDir,
  });
  const pendingSlotIds = verdict.pendingSlotIds || [];
  // The refusal must not eat the episode's resume checkpoint. An episode whose
  // images are already made (a resume that only needs speech or render) keeps
  // its own status, stage and remaining issues; the refusal is recorded under
  // wardrobeReadiness either way, and the pause is what the runner returns.
  const passedImages = KOYA_STATUSES_AFTER_IMAGES.has(nonEmpty(previousState.status))
    || await exists(paths.manifestPath);
  const interrupted = !passedImages && nonEmpty(previousState.status) && previousState.status !== "awaiting-wardrobe-readiness"
    ? { status: previousState.status, currentStage: nonEmpty(previousState.currentStage) }
    : previousState.wardrobeReadiness?.interrupted;
  await recordKoyaWardrobeState(paths, episodeId, {
    status: verdict.status,
    stage,
    reportPath: verdict.reportPath || "",
    reportSha256: verdict.reportSha256 || "",
    scriptDigest,
    pendingSlotIds,
    failures: verdict.failures,
    checkedAt,
    ...(interrupted ? { interrupted } : {}),
  }, {
    top: {
      ...(passedImages ? {} : { status: "awaiting-wardrobe-readiness", currentStage: "wardrobe-readiness" }),
      knownRemainingIssues: appendKnownIssue(previousState.knownRemainingIssues, {
        id: "wardrobe-readiness-required",
        wardrobeStatus: verdict.status,
        slotIds: pendingSlotIds,
        detail: message,
      }),
    },
  });
  const error = new Error(message);
  error.code = KOYA_WARDROBE_READINESS_REQUIRED_CODE;
  error.wardrobeStatus = verdict.status;
  error.slotIds = [...pendingSlotIds];
  error.inventoryPath = verdict.reportPath || "";
  throw error;
}

/**
 * `runtime.createEpisodeManifest` lets a test observe exactly what the Koya
 * path hands the shared builder (casting must stay off); production passes no
 * runtime.
 */
export async function createKoyaEpisodeManifest(options = {}, runtime = {}) {
  const buildEpisodeManifest = runtime.createEpisodeManifest || createEpisodeManifest;
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  const paths = episodePaths(projectDir, options.episodeId);
  const previousState = await readJson(paths.statePath).catch(() => ({}));
  const previousManifest = await readJson(paths.manifestPath).catch(() => null);
  const requestedOuterJobBinding = assertKoyaOuterJobBinding(options.outerJobBinding, { required: true });
  const previousOuterJobBinding = assertKoyaOuterJobBinding(previousManifest?.production?.outerJobBinding);
  if (requestedOuterJobBinding && previousOuterJobBinding
    && !sameKoyaOuterJobBinding(requestedOuterJobBinding, previousOuterJobBinding)) {
    throw new Error("Koya episode manifest is already bound to another outer Video Harness Job.");
  }
  const outerJobBinding = requestedOuterJobBinding || previousOuterJobBinding;
  const planPath = resolve(options.imagePlanPath || paths.imagePlanPath);
  const plan = await readJson(planPath);
  const generatorProvenance = plan.production?.generatorProvenance
    || previousState?.generatorProvenance
    || resolveKoyaAgentProvenance({
      role: "generator",
      host: options.generatorHost,
      id: options.generatorId,
      contextId: options.generatorContextId,
      source: options.generatorProvenanceSource || "legacy-contract-migration",
    });
  plan.production = {
    ...(plan.production || {}),
    generatorProvenance,
  };
  // Older approved plans predate provenance binding. Persist the real legacy
  // generator carried by the production state so subsequent audits never need
  // to invent or silently replace the original generation identity.
  await writeJsonAtomic(planPath, plan);
  for (const page of plan.pages || []) {
    if (!await exists(page.outputPath)) throw new Error(`Generated page is missing: ${page.outputPath}`);
  }
  const resolved = await resolveKoyaMangaProductionContract({
    projectDir,
    episodeId: options.episodeId,
    contractPath: options.contractPath,
    overridePath: options.overridePath,
  });
  const sourceFaceReviewPath = nonEmpty(options.sourceFaceReviewPath) || nonEmpty(previousState.sourceFaceReviewPath);
  const faceResult = await runSourceFacePlacement(paths, planPath, sourceFaceReviewPath, {
    pythonRuntime: options.pythonRuntime,
  });
  if (!faceResult.report.pass) {
    const state = await updateState(paths, {
      status: "awaiting-source-face-review",
      currentStage: "source-face-placement",
      sourceFaceReportPath: paths.sourceFaceReportPath,
      sourceFaceReviewPath,
      knownRemainingIssues: faceResult.report.knownRemainingIssues,
    });
    return { episodeId: options.episodeId, paths, plan, resolved, state, waiting: true, faceReport: faceResult.report };
  }
  const firstPageByCut = new Map();
  for (const page of plan.pages || []) if (!firstPageByCut.has(page.cutId)) firstPageByCut.set(page.cutId, page.outputPath);
  const created = await buildEpisodeManifest(koyaEpisodeManifestPipelineOptions({
    projectDir,
    episodeId: options.episodeId,
    scriptPath: options.scriptPath,
    plan,
    firstPageByCut,
    resolved,
  }));
  let manifest = applyKoyaContractToManifest(created.manifest, resolved);
  const characterBiblePath = plan.production?.characterBiblePath || "";
  const characterBible = characterBiblePath ? await readJson(resolve(characterBiblePath)) : null;
  if (characterBible) manifest = applyKoyaCharacterBibleSpeechDirectives(manifest, characterBible);
  const authority = await readKoyaChannelAuthority({ projectDir });
  const registry = await readCharacterRegistry({ projectDir });
  const validationCanary = resolveKoyaValidationCanary({
    episodeId: options.episodeId,
    policy: resolved.episodeOverride?.validationCanary,
    showBible: authority.showBible,
  });
  if (!validationCanary.pass) throw new Error(`Koya validation canary policy failed: ${validationCanary.failures.join("; ")}`);
  manifest = applyKoyaValidationCanaryVoiceProfiles(manifest, validationCanary, registry, authority.showBible);
  const protagonistRequest = options.protagonistSpeakerId
    || plan.production?.protagonistSpeakerName
    || plan.production?.protagonistSpeakerId;
  try {
    manifest = applyKoyaNarrationVoicePolicy(manifest, resolved, { protagonistSpeakerId: protagonistRequest });
  } catch (error) {
    throw await explainKoyaUnvoicedProtagonist(error, {
      manifest,
      resolved,
      protagonistRequest,
      registry,
      validationCanary,
      paths,
      episodeId: options.episodeId,
      jobId: outerJobBinding?.jobId,
      jobProjectDir: options.jobProjectDir,
    });
  }
  manifest = synchronizeKoyaValidationCanaryVoiceCasting(manifest);
  manifest = recordKoyaRegistryVoiceSelections(manifest, {
    registry,
    validationCanary,
    narrationVoicePolicy: resolved.contract.audio.narrationVoicePolicy,
  });
  await assertKoyaPreparedSpeakersVoiced(manifest, {
    registry,
    validationCanary,
    narrationVoicePolicy: resolved.contract.audio.narrationVoicePolicy,
    paths,
    episodeId: options.episodeId,
    jobId: outerJobBinding?.jobId,
    jobProjectDir: options.jobProjectDir,
  });
  for (const utterance of manifest.utterances || []) {
    const authoredSpeechText = utterance.speechOverride || utterance.speechText || utterance.text || "";
    utterance.speechText = applyKoyaSpeechPronunciations(
      authoredSpeechText,
      manifest.speech?.pronunciations,
    ).trim();
  }
  const reusedAudioUtteranceIds = await reuseKoyaApprovedAudio(manifest, previousManifest);
  const recoveredAudioUtteranceIds = await recoverKoyaApprovedAudioFromAlignments(
    manifest,
    paths.canvasDir,
  );
  reusedAudioUtteranceIds.push(...recoveredAudioUtteranceIds);
  const annotationByUtterance = new Map(faceResult.report.rows.map((entry) => [entry.utteranceId, entry]));
  const compositionByUtterance = new Map((plan.compositionPlan?.beats || []).map((entry) => [entry.utteranceId, entry]));
  const imageJobById = new Map((plan.jobs || []).map((entry) => [entry.id, entry]));
  const utteranceById = new Map(manifest.utterances.map((entry) => [entry.id, entry]));
  const groups = groupPagesForPacing(plan.pages || [], utteranceById, compositionByUtterance);
  let movingIndex = 0;
  const emittedCameraFamilies = new Set();
  for (const cut of manifest.cuts) {
    const cutGroups = groups.filter((entry) => entry.cutId === cut.id);
    const cutPages = cutGroups.flatMap((entry) => entry.pages);
    const conflictingPage = cutPages.find((page) => (
      page.editorial?.split?.recommended === true && page.editorial?.editorialPlate?.recommended === true
    ));
    if (conflictingPage) {
      throw new Error(`${conflictingPage.utteranceId}: editorial plate and split page are mutually exclusive; regenerate the image plan.`);
    }
    const splitPage = cutPages.find((page) => page.editorial?.split?.recommended === true);
    if (splitPage) {
      const composition = compositionByUtterance.get(splitPage.utteranceId) || {};
      const viewpoint = viewpointForComposition(composition, movingIndex);
      const diversityMode = koyaCameraModeForMissingFamily(viewpoint, emittedCameraFamilies, movingIndex, composition);
      // A flattened split page has one shared visibility window for every
      // panel and every timed replacement. Directional travel can shrink that
      // window enough to make previously valid Japanese typography impossible.
      // Keep the page centered and reveal it with a deterministic pull-out;
      // still consume the scheduled family so later shots remain stable.
      const mode = "pullout-only";
      emittedCameraFamilies.add(mangaCameraModeFamily(diversityMode));
      movingIndex += 1;
      const panelJobs = (splitPage.panelJobIds || []).map((id) => imageJobById.get(id)).filter(Boolean);
      const expectedPanelCount = splitPage.editorial.split.type === "story-3" ? 3 : 2;
      if (panelJobs.length !== expectedPanelCount) {
        throw new Error(`${splitPage.utteranceId}: ${splitPage.editorial.split.type} requires ${expectedPanelCount} real panel jobs; found ${panelJobs.length}. Regenerate the image plan.`);
      }
      const gutter = Math.max(8, Math.round(1920 * Number(splitPage.editorial.split.separatorWidthRatio || 0.0145)));
      cut.panelLayout = applyMangaCameraGrammarToPanelLayout({
        enabled: true,
        type: splitPage.editorial.split.type,
        layoutVariant: splitPage.layoutVariant || "",
        gutter,
        ...(splitPage.editorial.split.type === "vertical-2" ? { ratios: [0.47, 0.53] } : {
          splitRatio: 0.39,
          diagonalStart: 0.36,
          diagonalEnd: 0.63,
        }),
        panels: panelJobs.map((job, index) => ({
          imagePath: job.outputPath,
          role: splitPage.editorial.split.type === "story-3"
            ? ["cause", "action", "consequence"][index]
            : ["speaker-or-cause", "listener-or-consequence"][index],
          motion: "none",
          camera: { zoomStart: 1, zoomEnd: 1, focusX: 0.5, focusY: 0.5, focusXEnd: 0.5, focusYEnd: 0.5 },
        })),
        cameraIntensity: "strong",
      }, viewpoint, mode);
      cut.cameraSequence = [];
      cut.imagePath = splitPage.outputPath;
      cut.motion = mode;
      cut.cameraMode = mode;
      cut.camera = cut.panelLayout.pageCamera;
      cut.flattenedSplitPage = {
        enabled: true,
        sourcePagePath: splitPage.outputPath,
        splitType: splitPage.editorial.split.type,
        panelCount: panelJobs.length,
        separatorWidthRatio: splitPage.editorial.split.separatorWidthRatio,
        flattenBeforeCamera: true,
        panelCamera: "static",
        motionPolicy: "whole-page",
      };
      cut.imageGeneration = {
        status: "approved-koya-v44-image-pipeline",
        route: resolved.contract.art.imageModel,
        visualProfileId: resolved.contract.art.visualProfileId,
        planPath,
        adoptedAt: new Date().toISOString(),
      };
      continue;
    }
    const shots = [];
    for (const group of cutGroups) {
      const page = group.representativePage || group.pages[0];
      const composition = compositionByUtterance.get(page.utteranceId) || {};
      const annotation = annotationByUtterance.get(page.utteranceId) || {};
      const isPlate = page.editorial?.editorialPlate?.recommended === true;
      const isDedicatedNarrationInsert = group.speakerId === "narration"
        && composition.intent === "purpose-reflection";
      const requestedCameraMode = nonEmpty(page.cameraMode);
      const viewpoint = isPlate ? "graphic" : viewpointForComposition(composition, movingIndex);
      const activeSpeakerFace = annotation.sourceFaceBoundsBySpeakerId?.[group.speakerId] || null;
      const faceDominatesFrame = Number(activeSpeakerFace?.width) >= 0.16
        && Number(activeSpeakerFace?.height) >= 0.28;
      const faceCenterX = Number(activeSpeakerFace?.x) + Number(activeSpeakerFace?.width) / 2;
      const faceCenterY = Number(activeSpeakerFace?.y) + Number(activeSpeakerFace?.height) / 2;
      const faceNearFrameEdge = activeSpeakerFace && (
        faceCenterX < 0.25 || faceCenterX > 0.75 || faceCenterY < 0.25 || faceCenterY > 0.75
      );
      const faceRequiresAnchoredPullout = faceDominatesFrame || faceNearFrameEdge;
      // Dialogue may never begin with its active speaker outside the crop.
      // Wide source art can still use motion, but an edge-positioned speaker
      // must stay anchored while the shot pulls out rather than traversing
      // from an unrelated side of the frame.
      const dialogueRequiresAnchoredPullout = group.speakerId !== "narration"
        && dialogueShotRequiresAnchoredPullout(activeSpeakerFace);
      const dialogueDiversityMode = dialogueRequiresAnchoredPullout
        ? koyaCameraModeForMissingFamily(viewpoint, emittedCameraFamilies, movingIndex, composition)
        : "";
      // Extreme crops and edge faces stay anchored. A centered medium close-up
      // is allowed to use the missing camera family; the downstream 33-sample
      // face/camera placement gate remains the final authority.
      const mode = isPlate
        ? "none"
        : requestedCameraMode
          ? requestedCameraMode
        : isDedicatedNarrationInsert
          ? "pullout-only"
        : faceRequiresAnchoredPullout || dialogueRequiresAnchoredPullout
          ? "pullout-only"
          : koyaCameraModeForMissingFamily(viewpoint, emittedCameraFamilies, movingIndex, composition);
      const cameraViewpoint = mode !== "pullout-only" && mode !== "none"
        ? (["left", "right", "top"].find((direction) => mode.startsWith(direction)) || viewpoint)
        : viewpoint;
      // A newly retained narration insert must not rotate the global camera
      // family sequence for every later shot. It has a deterministic semantic
      // pull-out and leaves the existing downstream diversity order intact.
      if (!isPlate && !isDedicatedNarrationInsert) {
        // Anchoring an edge speaker is a safety correction, not a request to
        // rotate the diversity schedule of every following shot. Consume the
        // family the unconstrained shot would have occupied.
        emittedCameraFamilies.add(mangaCameraModeFamily(dialogueDiversityMode || mode));
        movingIndex += 1;
      }
      let shot = {
        id: `${cut.id}-${page.utteranceId}-koya-v44`,
        utteranceIds: group.utteranceIds,
        imagePath: page.outputPath,
        transition: "cut",
        motion: mode,
        cameraMode: mode,
        cameraIntensity: "strong",
        semanticStartSubject: composition.purpose || page.utteranceId,
        semanticEndSubject: composition.visibleAction || composition.purpose || page.utteranceId,
        compositionId: composition.id || "",
        sourceCompositionViewpoint: viewpoint,
        sourceFaceBoundsBySpeakerId: annotation.sourceFaceBoundsBySpeakerId || {},
        sourceAvoidRegions: annotation.sourceAvoidRegions || [],
        camera: page.camera && typeof page.camera === "object" ? structuredClone(page.camera) : undefined,
        imagePlanUtteranceIds: group.pages.map((entry) => entry.utteranceId),
        ...(isPlate ? {
          editorialPlate: {
            type: page.editorial.editorialPlate.type,
            characterPolicy: "strictly-none",
            environmentPolicy: "none",
          },
        } : {}),
      };
      shot = isPlate
        ? applyMangaCameraGrammarToShot(shot, "wide", "none")
        : applyMangaCameraGrammarToShot(shot, cameraViewpoint, mode);
      if (!isPlate && !requestedCameraMode && (faceRequiresAnchoredPullout || dialogueRequiresAnchoredPullout) && shot.camera) {
        const focusX = Math.max(0, Math.min(1, faceCenterX));
        const focusY = Math.max(0, Math.min(1, faceCenterY));
        shot.camera = {
          ...shot.camera,
          focusX,
          focusY,
          focusXEnd: focusX,
          focusYEnd: focusY,
          keyframes: [
            { at: 0, zoom: shot.camera.zoomStart, focusX, focusY },
            { at: 1, zoom: shot.camera.zoomEnd, focusX, focusY },
          ],
        };
      }
      shots.push(shot);
    }
    cut.cameraSequence = shots;
    const firstMoving = shots.find((entry) => mangaCameraModeFamily(entry.cameraMode) !== "static") || shots[0];
    if (firstMoving) {
      cut.imagePath = firstMoving.imagePath;
      cut.motion = firstMoving.motion;
      cut.cameraMode = firstMoving.cameraMode;
      cut.camera = firstMoving.camera;
    }
    cut.imageGeneration = {
      status: "approved-koya-v44-image-pipeline",
      route: resolved.contract.art.imageModel,
      visualProfileId: resolved.contract.art.visualProfileId,
      planPath,
      adoptedAt: new Date().toISOString(),
    };
  }
  manifest.production = {
    ...(manifest.production || {}),
    ...(outerJobBinding ? { outerJobBinding: structuredClone(outerJobBinding) } : {}),
    provenance: {
      ...(manifest.production?.provenance || {}),
      generator: structuredClone(generatorProvenance),
    },
    channelDirectives: structuredClone(plan.production?.channelDirectives || {}),
    incidentLedger: structuredClone(plan.production?.incidentLedger || {}),
    channelAuthority: structuredClone(plan.production?.channelAuthority || {}),
    storyGovernance: structuredClone(plan.production?.storyGovernance || {}),
    validationCanary: structuredClone(plan.production?.validationCanary?.active ? {
      ...plan.production.validationCanary,
      provisionalVoiceAssignments: manifest.production?.validationCanary?.provisionalVoiceAssignments || [],
    } : { active: false, publicationEligible: true }),
    imagePlan: {
      path: planPath,
      pageCount: plan.pages.length,
      adoptedShotCount: manifest.cuts.reduce((sum, cut) => sum + (cut.panelLayout?.enabled ? 1 : cut.cameraSequence.length), 0),
      sameSpeakerImageGroups: groups.filter((entry) => entry.utteranceIds.length > 1).length,
      multiUtteranceImageGroups: groups.filter((entry) => entry.utteranceIds.length > 1).length,
    },
    approvedAudioReuse: {
      version: "koya-approved-audio-reuse-v1",
      utteranceIds: reusedAudioUtteranceIds,
      reusedCount: reusedAudioUtteranceIds.length,
      recoveredFromAlignmentCount: recoveredAudioUtteranceIds.length,
      complete: reusedAudioUtteranceIds.length === manifest.utterances.length,
      policy: "exact-previous-manifest-or-hash-bound-dialogue-alignment-and-existing-file",
    },
    sourceFacePlacement: {
      path: paths.sourceFaceReportPath,
      pass: true,
      independentFinalAuditRequired: true,
      manualReviewEvidence: structuredClone(faceResult.report.manualReviewEvidence || null),
    },
  };
  for (const cut of manifest.cuts.filter((entry) => entry.panelLayout?.enabled)) {
    const splitPage = (plan.pages || []).find((page) => page.cutId === cut.id && page.editorial?.split?.recommended === true);
    const annotation = annotationByUtterance.get(splitPage?.utteranceId) || {};
    for (const utterance of manifest.utterances.filter((entry) => entry.cutId === cut.id)) {
      const spec = await readJson(utterance.overlaySpecPath);
      // Legacy/source images are not always contract-sized. Placement occurs
      // in the overlay raster's coordinate space, so normalized source faces
      // must be expanded with that exact width/height, not fixed 1920x1080.
      const absoluteAvoidRegions = sourceAvoidRegionsInOverlaySpace(
        annotation.sourceAvoidRegions,
        spec.imageSize,
        resolved.contract.video,
      );
      await writeJsonAtomic(utterance.overlaySpecPath, {
        ...spec,
        imagePath: cut.imagePath,
        plan: { ...(spec.plan || {}), avoidRegions: absoluteAvoidRegions },
        sourceAvoidRegions: annotation.sourceAvoidRegions || [],
        splitPageSource: splitPage?.outputPath || "",
      });
    }
  }
  const contractAudit = auditManifestAgainstKoyaContract(manifest, resolved);
  if (!contractAudit.pass) throw new Error(`Koya manifest contract failed: ${JSON.stringify(contractAudit.failures)}`);
  await writeJsonAtomic(paths.manifestPath, manifest);
  const refreshed = await refreshEpisodeBubbleOverlays({
    projectDir,
    manifestPath: paths.manifestPath,
    refreshAll: true,
    reflowPlacement: true,
    sequenceAware: true,
    stripTerminalJapanesePeriod: resolved.contract.bubbles.stripTerminalJapanesePeriod,
  });
  manifest = refreshed.manifest;
  manifest.production = {
    ...(manifest.production || {}),
    contractManifestAudit: contractAudit,
  };
  await writeJsonAtomic(paths.manifestPath, manifest);
  if (reusedAudioUtteranceIds.length === manifest.utterances.length && manifest.utterances.length > 0) {
    manifest = compileEpisodeTiming(manifest, {
      sameSpeakerGapSeconds: resolved.contract.audio.sameSpeakerGapSeconds,
      speakerChangeGapSeconds: resolved.contract.audio.speakerChangeGapSeconds,
      emphasisGapSeconds: resolved.contract.audio.emphasisGapSeconds,
      bubbleFadeInMilliseconds: resolved.contract.bubbles.fadeInMilliseconds,
      bubbleFadeOutMilliseconds: resolved.contract.bubbles.fadeOutMilliseconds,
      bubbleTransitionCrossfadeSeconds: resolved.contract.bubbles.transitionCrossfadeSeconds,
    });
    await writeJsonAtomic(paths.manifestPath, manifest);
    const timedRefresh = await refreshEpisodeBubbleOverlays({
      projectDir,
      manifestPath: paths.manifestPath,
      refreshAll: true,
      reflowPlacement: true,
      sequenceAware: true,
      stripTerminalJapanesePeriod: resolved.contract.bubbles.stripTerminalJapanesePeriod,
    });
    manifest = timedRefresh.manifest;
    await writeJsonAtomic(paths.manifestPath, manifest);
  }
  const speechReady = reusedAudioUtteranceIds.length === manifest.utterances.length && manifest.utterances.length > 0;
  const state = await updateState(paths, {
    status: speechReady ? "speech-ready" : "manifest-ready",
    currentStage: speechReady ? "render" : "speech",
    manifestPath: paths.manifestPath,
    sourceFaceReportPath: paths.sourceFaceReportPath,
    sourceFaceReviewPath,
    contractAuditPass: true,
    knownRemainingIssues: [],
  });
  return { episodeId: options.episodeId, paths, plan, resolved, state, waiting: false, manifest };
}

/**
 * `runtime` mirrors substituteKoyaMangaCutVideos: tests may pass the
 * test-only preflight switches and observe the dialogue-runner call
 * (`runtime.generateDialogueSpeech`); production passes no runtime.
 */
export async function generateKoyaMangaSpeech(options = {}, runtime = {}) {
  const preflight = await assertKoyaFullPreflight(options, runtime);
  const runDialogueSpeech = runtime.generateDialogueSpeech || generateKoyaDialogueSpeech;
  const expectedOuterJobBinding = requiredOuterJobBindingFromPreflight(preflight);
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  const paths = episodePaths(projectDir, options.episodeId);
  const resolved = await resolveKoyaMangaProductionContract({
    projectDir,
    episodeId: options.episodeId,
    contractPath: options.contractPath,
    overridePath: options.overridePath,
  });
  const productionState = await readJson(paths.statePath).catch(() => ({}));
  const storedManifest = await readJson(paths.manifestPath);
  const manifestOuterJobBinding = assertKoyaOuterJobBinding(storedManifest?.production?.outerJobBinding, { required: true });
  if (!sameKoyaOuterJobBinding(expectedOuterJobBinding, manifestOuterJobBinding)) {
    throw new Error("Koya speech manifest belongs to another outer Video Harness Job.");
  }
  const manifestInput = applyKoyaContractToManifest(storedManifest, resolved);
  const characterBiblePath = options.characterBiblePath || productionState.characterBiblePath || "";
  const characterBible = characterBiblePath ? await readJson(resolve(characterBiblePath)) : null;
  const manifest = characterBible
    ? applyKoyaCharacterBibleSpeechDirectives(manifestInput, characterBible)
    : manifestInput;
  const result = await runDialogueSpeech({
    beforePaidSpeech: koyaSpeechVoiceSelectionGate({
      projectDir,
      episodeId: options.episodeId,
      resolved,
      jobId: preflight?.jobId,
      jobProjectDir: preflight?.jobProjectDir,
    }),
    projectDir,
    canvasDir: paths.canvasDir,
    manifest,
    manifestPath: paths.manifestPath,
    contract: resolved,
    takeCount: options.takeCount || resolved.contract.audio.takeCount,
    maxAdaptiveTakes: options.maxAdaptiveTakes,
    speechConcurrency: options.speechConcurrency,
    signal: options.signal,
    isCancellationRequested: options.isCancellationRequested,
    cutIds: options.cutIds,
    forcedTakes: options.forcedTakes,
    dryRun: options.dryRun,
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
    voiceQualityGate: options.voiceQualityGate,
    readingDictionaryPath: options.readingDictionaryPath,
  });
  if (result.waiting) {
    await updateState(paths, {
      status: "waiting-usage-limit",
      currentStage: "speech",
      knownRemainingIssues: result.report.knownRemainingIssues,
    });
    return { ...result, paths, resolved, waiting: true };
  }
  if (result.cancelled || result.partial) {
    const status = result.cancelled ? "speech-checkpointed" : "speech-partial";
    const state = await updateState(paths, {
      status,
      currentStage: "speech",
      speechReportPath: result.reportPath,
      knownRemainingIssues: result.report.knownRemainingIssues,
    });
    return { ...result, paths, resolved, state, waiting: false };
  }
  if (!options.dryRun) {
    const timedManifest = compileEpisodeTiming(result.manifest, {
      sameSpeakerGapSeconds: resolved.contract.audio.sameSpeakerGapSeconds,
      speakerChangeGapSeconds: resolved.contract.audio.speakerChangeGapSeconds,
      emphasisGapSeconds: resolved.contract.audio.emphasisGapSeconds,
      bubbleFadeInMilliseconds: resolved.contract.bubbles.fadeInMilliseconds,
      bubbleFadeOutMilliseconds: resolved.contract.bubbles.fadeOutMilliseconds,
      bubbleTransitionCrossfadeSeconds: resolved.contract.bubbles.transitionCrossfadeSeconds,
    });
    await writeJsonAtomic(paths.manifestPath, timedManifest);
    await refreshEpisodeBubbleOverlays({
      projectDir,
      manifestPath: paths.manifestPath,
      refreshAll: true,
      reflowPlacement: true,
      sequenceAware: true,
      stripTerminalJapanesePeriod: resolved.contract.bubbles.stripTerminalJapanesePeriod,
    });
  }
  const state = await updateState(paths, {
    status: options.dryRun ? "speech-planned" : "speech-ready",
    currentStage: options.dryRun ? "speech" : "render",
    speechReportPath: result.reportPath,
    knownRemainingIssues: [],
  });
  return { ...result, paths, resolved, state, waiting: false };
}

export async function repairKoyaMangaAudioOnset(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  if (!options.utteranceId) throw new Error("utteranceId is required.");
  const paths = episodePaths(projectDir, options.episodeId);
  const resolved = await resolveKoyaMangaProductionContract({
    projectDir,
    episodeId: options.episodeId,
    contractPath: options.contractPath,
    overridePath: options.overridePath,
  });
  const fadeMilliseconds = Number(options.fadeMilliseconds ?? resolved.contract.audio.joinFadeInMilliseconds);
  if (!Number.isFinite(fadeMilliseconds) || fadeMilliseconds < 6 || fadeMilliseconds > 8) {
    throw new Error(`fadeMilliseconds must stay within the contract's 6–8 ms join-fade range; got ${options.fadeMilliseconds}.`);
  }
  const fadeStartSeconds = Number(options.fadeStartSeconds);
  if (!Number.isFinite(fadeStartSeconds) || fadeStartSeconds <= 0) {
    throw new Error("fadeStartSeconds must be a positive number.");
  }
  const manifestInput = await readJson(paths.manifestPath);
  const utterance = (manifestInput.utterances || []).find((entry) => entry.id === options.utteranceId);
  if (!utterance) throw new Error(`Utterance is missing: ${options.utteranceId}`);
  const sourcePath = resolve(options.sourcePath || utterance.audio?.filePath || "");
  if (!isInsideDirectory(sourcePath, projectDir) || !await exists(sourcePath)) {
    throw new Error(`Repair source must be an existing file inside the project: ${sourcePath}`);
  }
  const outputFileName = basename(options.outputFileName || `${options.episodeId}-${options.utteranceId}-onset-repaired.wav`);
  if (outputFileName !== options.outputFileName && options.outputFileName) {
    throw new Error("outputFileName must not contain directory components.");
  }
  if (!outputFileName.toLowerCase().endsWith(".wav")) throw new Error("outputFileName must end in .wav.");
  const outputDir = join(paths.canvasDir, "assets/audio");
  const outputPath = join(outputDir, outputFileName);
  const fadeDurationSeconds = fadeMilliseconds / 1000;
  await mkdir(outputDir, { recursive: true });
  await execFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath,
    "-af", `afade=t=in:st=${fadeStartSeconds.toFixed(6)}:d=${fadeDurationSeconds.toFixed(6)}:curve=tri`,
    "-ar", String(resolved.contract.video.audioSampleRate), "-ac", "1", "-c:a", "pcm_s24le", outputPath,
  ], { cwd: projectDir, maxBuffer: 16 * 1024 * 1024 });
  const [{ stdout: sourceProbe }, { stdout: outputProbe }] = await Promise.all([
    execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", sourcePath]),
    execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", outputPath]),
  ]);
  const sourceDurationSeconds = Number(JSON.parse(sourceProbe).format.duration);
  const outputDurationSeconds = Number(JSON.parse(outputProbe).format.duration);
  if (!Number.isFinite(outputDurationSeconds) || Math.abs(outputDurationSeconds - sourceDurationSeconds) > 1 / resolved.contract.video.audioSampleRate) {
    throw new Error(`Onset repair changed duration: ${sourceDurationSeconds} -> ${outputDurationSeconds}`);
  }
  let manifest = applyKoyaContractToManifest(manifestInput, resolved);
  const repaired = manifest.utterances.find((entry) => entry.id === options.utteranceId);
  const previousAudio = repaired.audio || {};
  repaired.audio = {
    ...previousAudio,
    fileName: outputFileName,
    filePath: outputPath,
    assetUrl: `/excalidraw-assets/audio/${encodeURIComponent(outputFileName)}`,
    durationSeconds: outputDurationSeconds,
    speechStartSeconds: fadeStartSeconds,
    outputHeadPaddingSeconds: fadeStartSeconds,
    joinFadeRepair: {
      version: "koya-approved-onset-repair-v1",
      sourcePath,
      fadeStartSeconds,
      fadeMilliseconds,
      curve: "linear",
      reason: options.reason || "user-reported onset click",
      repairedAt: new Date().toISOString(),
    },
  };
  if (repaired.audio.acousticSpeechDetection) {
    repaired.audio.acousticSpeechDetection = {
      ...repaired.audio.acousticSpeechDetection,
      startSeconds: fadeStartSeconds,
    };
  }
  repaired.audioFileName = outputFileName;
  repaired.audioFilePath = outputPath;
  repaired.audioAssetUrl = repaired.audio.assetUrl;
  const alignmentFileName = `${outputFileName}.json`;
  const alignmentPath = join(paths.canvasDir, "audio-alignments", alignmentFileName);
  repaired.audio.alignmentFileName = alignmentFileName;
  repaired.audio.alignmentPath = alignmentPath;
  await writeJsonAtomic(alignmentPath, repaired.audio);
  const legacyApprovedAudio = manifest.production?.approvedAudio || null;
  manifest.production = {
    ...(manifest.production || {}),
    audioRepairs: [
      ...(manifest.production?.audioRepairs || []),
      {
        utteranceId: options.utteranceId,
        sourcePath,
        outputPath,
        fadeStartSeconds,
        fadeMilliseconds,
        reason: options.reason || "user-reported onset click",
        repairedAt: new Date().toISOString(),
      },
    ],
    ...(legacyApprovedAudio ? { supersededApprovedAudio: legacyApprovedAudio } : {}),
  };
  delete manifest.production.approvedAudio;
  manifest.status = "audio-repaired-awaiting-render";
  manifest.knownRemainingIssues = [{ id: "audio-click-user-review", detail: `${options.utteranceId} must pass rendered MP4 audit and user listening review.` }];
  await Promise.all([
    writeJsonAtomic(paths.manifestPath, manifest),
    writeJsonAtomic(paths.contractSnapshotPath, {
      version: resolved.contract.version,
      digest: resolved.digest,
      contractPath: resolved.contractPath,
      episodeOverridePath: resolved.episodeOverridePath,
      contract: resolved.contract,
    }),
  ]);
  const contractAudit = auditManifestAgainstKoyaContract(manifest, resolved);
  if (!contractAudit.pass) throw new Error(`Koya manifest contract failed after audio repair: ${JSON.stringify(contractAudit.failures)}`);
  const state = await updateState(paths, {
    episodeId: options.episodeId,
    status: "audio-repaired-awaiting-render",
    currentStage: "render",
    manifestPath: paths.manifestPath,
    contractSnapshotPath: paths.contractSnapshotPath,
    contractDigest: resolved.digest,
    knownRemainingIssues: manifest.knownRemainingIssues,
  });
  return {
    episodeId: options.episodeId,
    utteranceId: options.utteranceId,
    sourcePath,
    outputPath,
    sourceDurationSeconds,
    outputDurationSeconds,
    fadeStartSeconds,
    fadeMilliseconds,
    contractAudit,
    paths,
    state,
  };
}

export async function repairKoyaMangaAudioTail(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  if (!options.utteranceId) throw new Error("utteranceId is required.");
  const paths = episodePaths(projectDir, options.episodeId);
  const resolved = await resolveKoyaMangaProductionContract({
    projectDir,
    episodeId: options.episodeId,
    contractPath: options.contractPath,
    overridePath: options.overridePath,
  });
  const fadeMilliseconds = Number(options.fadeMilliseconds ?? resolved.contract.audio.joinFadeOutMilliseconds);
  if (!Number.isFinite(fadeMilliseconds) || fadeMilliseconds < 6 || fadeMilliseconds > 8) {
    throw new Error(`fadeMilliseconds must stay within the contract's 6–8 ms join-fade range; got ${options.fadeMilliseconds}.`);
  }
  const fadeStartSeconds = Number(options.fadeStartSeconds);
  if (!Number.isFinite(fadeStartSeconds) || fadeStartSeconds <= 0) {
    throw new Error("fadeStartSeconds must be a positive number.");
  }
  const manifestInput = await readJson(paths.manifestPath);
  const utterance = (manifestInput.utterances || []).find((entry) => entry.id === options.utteranceId);
  if (!utterance) throw new Error(`Utterance is missing: ${options.utteranceId}`);
  const sourcePath = resolve(options.sourcePath || utterance.audio?.filePath || "");
  if (!isInsideDirectory(sourcePath, projectDir) || !await exists(sourcePath)) {
    throw new Error(`Repair source must be an existing file inside the project: ${sourcePath}`);
  }
  const speechEndSeconds = Number(
    options.speechEndSeconds
      ?? utterance.audio?.acousticSpeechDetection?.endSeconds
      ?? utterance.audio?.speechEndSeconds,
  );
  if (!Number.isFinite(speechEndSeconds) || speechEndSeconds <= 0 || speechEndSeconds > fadeStartSeconds) {
    throw new Error(`speechEndSeconds must identify preserved speech at or before the fade; got ${options.speechEndSeconds}.`);
  }
  const fadeDurationSeconds = fadeMilliseconds / 1000;
  if (fadeStartSeconds + fadeDurationSeconds - speechEndSeconds + 1e-9 < resolved.contract.audio.minimumReleasePaddingSeconds) {
    throw new Error(
      `Tail repair must preserve at least ${resolved.contract.audio.minimumReleasePaddingSeconds}s after speech; `
      + `got ${fadeStartSeconds + fadeDurationSeconds - speechEndSeconds}s.`,
    );
  }
  const outputFileName = basename(options.outputFileName || `${options.episodeId}-${options.utteranceId}-tail-repaired.wav`);
  if (outputFileName !== options.outputFileName && options.outputFileName) {
    throw new Error("outputFileName must not contain directory components.");
  }
  if (!outputFileName.toLowerCase().endsWith(".wav")) throw new Error("outputFileName must end in .wav.");
  const outputDir = join(paths.canvasDir, "assets/audio");
  const outputPath = join(outputDir, outputFileName);
  await mkdir(outputDir, { recursive: true });
  await execFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath,
    "-af", `afade=t=out:st=${fadeStartSeconds.toFixed(6)}:d=${fadeDurationSeconds.toFixed(6)}:curve=tri`,
    "-ar", String(resolved.contract.video.audioSampleRate), "-ac", "1", "-c:a", "pcm_s24le", outputPath,
  ], { cwd: projectDir, maxBuffer: 16 * 1024 * 1024 });
  const [{ stdout: sourceProbe }, { stdout: outputProbe }] = await Promise.all([
    execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", sourcePath]),
    execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", outputPath]),
  ]);
  const sourceDurationSeconds = Number(JSON.parse(sourceProbe).format.duration);
  const outputDurationSeconds = Number(JSON.parse(outputProbe).format.duration);
  if (!Number.isFinite(outputDurationSeconds) || Math.abs(outputDurationSeconds - sourceDurationSeconds) > 1 / resolved.contract.video.audioSampleRate) {
    throw new Error(`Tail repair changed duration: ${sourceDurationSeconds} -> ${outputDurationSeconds}`);
  }
  if (fadeStartSeconds + fadeDurationSeconds > outputDurationSeconds + 1e-9) {
    throw new Error(`Tail fade ends after the source duration: ${fadeStartSeconds + fadeDurationSeconds} > ${outputDurationSeconds}`);
  }
  let manifest = applyKoyaContractToManifest(manifestInput, resolved);
  const repaired = manifest.utterances.find((entry) => entry.id === options.utteranceId);
  const repairedAt = new Date().toISOString();
  repaired.audio = {
    ...(repaired.audio || {}),
    fileName: outputFileName,
    filePath: outputPath,
    assetUrl: `/excalidraw-assets/audio/${encodeURIComponent(outputFileName)}`,
    durationSeconds: outputDurationSeconds,
    speechEndSeconds,
    outputTailPaddingSeconds: outputDurationSeconds - speechEndSeconds,
    releasePaddingSeconds: outputDurationSeconds - speechEndSeconds,
    tailTransientRepair: {
      version: "koya-approved-tail-transient-repair-v1",
      sourcePath,
      speechEndSeconds,
      fadeStartSeconds,
      fadeMilliseconds,
      curve: "linear",
      reason: options.reason || "user-reported isolated tail click before next utterance",
      repairedAt,
    },
  };
  if (repaired.audio.acousticSpeechDetection) {
    repaired.audio.acousticSpeechDetection = {
      ...repaired.audio.acousticSpeechDetection,
      endSeconds: speechEndSeconds,
    };
  }
  repaired.audioFileName = outputFileName;
  repaired.audioFilePath = outputPath;
  repaired.audioAssetUrl = repaired.audio.assetUrl;
  const alignmentFileName = `${outputFileName}.json`;
  const alignmentPath = join(paths.canvasDir, "audio-alignments", alignmentFileName);
  repaired.audio.alignmentFileName = alignmentFileName;
  repaired.audio.alignmentPath = alignmentPath;
  await writeJsonAtomic(alignmentPath, repaired.audio);
  const legacyApprovedAudio = manifest.production?.approvedAudio || null;
  manifest.production = {
    ...(manifest.production || {}),
    audioRepairs: [
      ...(manifest.production?.audioRepairs || []),
      {
        type: "tail-transient",
        utteranceId: options.utteranceId,
        sourcePath,
        outputPath,
        speechEndSeconds,
        fadeStartSeconds,
        fadeMilliseconds,
        reason: options.reason || "user-reported isolated tail click before next utterance",
        repairedAt,
      },
    ],
    ...(legacyApprovedAudio ? { supersededApprovedAudio: legacyApprovedAudio } : {}),
  };
  delete manifest.production.approvedAudio;
  manifest.status = "audio-repaired-awaiting-render";
  manifest.knownRemainingIssues = [{ id: "audio-click-user-review", detail: `${options.utteranceId} tail repair must pass rendered MP4 audit and user listening review.` }];
  await Promise.all([
    writeJsonAtomic(paths.manifestPath, manifest),
    writeJsonAtomic(paths.contractSnapshotPath, {
      version: resolved.contract.version,
      digest: resolved.digest,
      contractPath: resolved.contractPath,
      episodeOverridePath: resolved.episodeOverridePath,
      contract: resolved.contract,
    }),
  ]);
  const contractAudit = auditManifestAgainstKoyaContract(manifest, resolved);
  if (!contractAudit.pass) throw new Error(`Koya manifest contract failed after audio repair: ${JSON.stringify(contractAudit.failures)}`);
  const state = await updateState(paths, {
    episodeId: options.episodeId,
    status: "audio-repaired-awaiting-render",
    currentStage: "render",
    manifestPath: paths.manifestPath,
    contractSnapshotPath: paths.contractSnapshotPath,
    contractDigest: resolved.digest,
    knownRemainingIssues: manifest.knownRemainingIssues,
  });
  return {
    episodeId: options.episodeId,
    utteranceId: options.utteranceId,
    sourcePath,
    outputPath,
    sourceDurationSeconds,
    outputDurationSeconds,
    speechEndSeconds,
    fadeStartSeconds,
    fadeMilliseconds,
    contractAudit,
    paths,
    state,
  };
}

export async function adjustKoyaMangaUtteranceGap(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  if (!options.utteranceId) throw new Error("utteranceId is required.");
  const targetAudibleGapSeconds = Number(options.targetAudibleGapSeconds);
  if (!Number.isFinite(targetAudibleGapSeconds) || targetAudibleGapSeconds < 0 || targetAudibleGapSeconds > 3) {
    throw new Error(`targetAudibleGapSeconds must be between 0 and 3; got ${options.targetAudibleGapSeconds}.`);
  }

  const paths = episodePaths(projectDir, options.episodeId);
  const resolved = await resolveKoyaMangaProductionContract({
    projectDir,
    episodeId: options.episodeId,
    contractPath: options.contractPath,
    overridePath: options.overridePath,
  });
  const manifestInput = await readJson(paths.manifestPath);
  let manifest = applyKoyaContractToManifest(manifestInput, resolved);
  const utterance = (manifest.utterances || []).find((entry) => entry.id === options.utteranceId);
  if (!utterance) throw new Error(`Utterance is missing: ${options.utteranceId}`);
  const cut = (manifest.cuts || []).find((entry) => (entry.utteranceIds || []).includes(options.utteranceId));
  const utteranceIndex = cut?.utteranceIds?.indexOf(options.utteranceId) ?? -1;
  if (!cut || utteranceIndex <= 0) {
    throw new Error(`Utterance must follow another utterance in the same cut: ${options.utteranceId}`);
  }
  const previousUtteranceId = cut.utteranceIds[utteranceIndex - 1];
  const previousUtterance = manifest.utterances.find((entry) => entry.id === previousUtteranceId);
  if (!previousUtterance) throw new Error(`Previous utterance is missing: ${previousUtteranceId}`);

  const previousDurationSeconds = Number(previousUtterance.audio?.durationSeconds);
  const previousSpeechEndSeconds = Number(previousUtterance.audio?.speechEndSeconds);
  const speechStartSeconds = Number(utterance.audio?.speechStartSeconds);
  if (
    !Number.isFinite(previousDurationSeconds)
    || !Number.isFinite(previousSpeechEndSeconds)
    || !Number.isFinite(speechStartSeconds)
  ) {
    throw new Error(`Speech-bound metadata is incomplete around ${previousUtteranceId} -> ${options.utteranceId}.`);
  }
  const embeddedPaddingGapSeconds = Math.max(0, previousDurationSeconds - previousSpeechEndSeconds)
    + Math.max(0, speechStartSeconds);
  const authoredGapBeforeSeconds = targetAudibleGapSeconds - embeddedPaddingGapSeconds;
  if (authoredGapBeforeSeconds < -0.25 || authoredGapBeforeSeconds > 3) {
    throw new Error(
      `Target audible gap requires an unsupported authored gap: ${authoredGapBeforeSeconds}s `
      + `(embedded padding ${embeddedPaddingGapSeconds}s).`,
    );
  }

  const previousTargetAudibleGapSeconds = Math.max(
    0,
    Number(utterance.pauseBeforeSeconds || 0) + embeddedPaddingGapSeconds,
  );
  utterance.pauseBeforeSeconds = authoredGapBeforeSeconds;
  utterance.audio = {
    ...(utterance.audio || {}),
    targetAudibleGapBeforeSeconds: targetAudibleGapSeconds,
    embeddedPaddingGapSeconds,
    authoredGapBeforeSeconds,
  };
  const adjustedAt = new Date().toISOString();
  manifest.production = {
    ...(manifest.production || {}),
    timingAdjustments: [
      ...(manifest.production?.timingAdjustments || []),
      {
        version: "koya-user-audible-gap-v1",
        previousUtteranceId,
        utteranceId: options.utteranceId,
        previousTargetAudibleGapSeconds,
        targetAudibleGapSeconds,
        embeddedPaddingGapSeconds,
        authoredGapBeforeSeconds,
        reason: options.reason || "user-requested more natural pause",
        adjustedAt,
      },
    ],
  };
  manifest = compileEpisodeTiming(manifest, {
    sameSpeakerGapSeconds: resolved.contract.audio.sameSpeakerGapSeconds,
    speakerChangeGapSeconds: resolved.contract.audio.speakerChangeGapSeconds,
    emphasisGapSeconds: resolved.contract.audio.emphasisGapSeconds,
    bubbleFadeInMilliseconds: resolved.contract.bubbles.fadeInMilliseconds,
    bubbleFadeOutMilliseconds: resolved.contract.bubbles.fadeOutMilliseconds,
    bubbleTransitionCrossfadeSeconds: resolved.contract.bubbles.transitionCrossfadeSeconds,
  });
  manifest.status = "timing-adjusted-awaiting-render";
  manifest.knownRemainingIssues = [{
    id: "timing-gap-user-review",
    detail: `${previousUtteranceId} -> ${options.utteranceId} must pass rendered MP4 timing and visual review.`,
  }];
  await Promise.all([
    writeJsonAtomic(paths.manifestPath, manifest),
    writeJsonAtomic(paths.contractSnapshotPath, {
      version: resolved.contract.version,
      digest: resolved.digest,
      contractPath: resolved.contractPath,
      episodeOverridePath: resolved.episodeOverridePath,
      contract: resolved.contract,
    }),
  ]);
  const contractAudit = auditManifestAgainstKoyaContract(manifest, resolved);
  if (!contractAudit.pass) {
    throw new Error(`Koya manifest contract failed after timing adjustment: ${JSON.stringify(contractAudit.failures)}`);
  }
  const state = await updateState(paths, {
    episodeId: options.episodeId,
    status: "timing-adjusted-awaiting-render",
    currentStage: "render",
    manifestPath: paths.manifestPath,
    contractSnapshotPath: paths.contractSnapshotPath,
    contractDigest: resolved.digest,
    knownRemainingIssues: manifest.knownRemainingIssues,
  });
  return {
    episodeId: options.episodeId,
    cutId: cut.id,
    previousUtteranceId,
    utteranceId: options.utteranceId,
    previousTargetAudibleGapSeconds,
    targetAudibleGapSeconds,
    embeddedPaddingGapSeconds,
    authoredGapBeforeSeconds,
    contractAudit,
    paths,
    state,
  };
}

function assertNormalizedSourceRegion(region, label) {
  const values = [region?.x, region?.y, region?.width, region?.height].map(Number);
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error(`${label} must contain finite x/y/width/height values.`);
  }
  const [x, y, width, height] = values;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
    throw new Error(`${label} must stay inside normalized source-image coordinates.`);
  }
}

export function sourceAvoidRegionsInOverlaySpace(regions = [], imageSize = {}, fallbackSize = {}) {
  const width = Number(imageSize?.width || fallbackSize?.width);
  const height = Number(imageSize?.height || fallbackSize?.height);
  if (!(width > 0) || !(height > 0)) throw new Error("Overlay image size is required for source face projection.");
  return (Array.isArray(regions) ? regions : []).map((region) => ({
    ...region,
    x: Number(region.x) * width,
    y: Number(region.y) * height,
    width: Number(region.width) * width,
    height: Number(region.height) * height,
  }));
}

export async function standardizeKoyaMangaCut(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  if (!options.cutId) throw new Error("cutId is required.");
  if (!options.planPath) throw new Error("planPath is required.");
  const paths = episodePaths(projectDir, options.episodeId);
  const planPath = resolve(options.planPath);
  if (!isInsideDirectory(planPath, projectDir) || !await exists(planPath)) {
    throw new Error(`Standard-cut plan must be an existing JSON file inside the project: ${planPath}`);
  }
  const plan = await readJson(planPath);
  if (plan.episodeId !== options.episodeId || plan.cutId !== options.cutId) {
    throw new Error(`Standard-cut plan target mismatch: ${plan.episodeId}/${plan.cutId}.`);
  }
  if (!nonEmpty(plan.revision)) throw new Error("Standard-cut plan revision is required.");

  const resolved = await resolveKoyaMangaProductionContract({
    projectDir,
    episodeId: options.episodeId,
    contractPath: options.contractPath,
    overridePath: options.overridePath,
  });
  const manifestInput = await readJson(paths.manifestPath);
  let manifest = applyKoyaContractToManifest(manifestInput, resolved);
  const cut = (manifest.cuts || []).find((entry) => entry.id === options.cutId);
  if (!cut) throw new Error(`Cut is missing: ${options.cutId}`);
  const shots = Array.isArray(plan.shots) ? plan.shots : [];
  if (shots.length === 0) throw new Error("Standard-cut plan must contain at least one shot.");
  const coveredUtteranceIds = shots.flatMap((shot) => shot.utteranceIds || []);
  if (JSON.stringify(coveredUtteranceIds) !== JSON.stringify(cut.utteranceIds || [])) {
    throw new Error(`Standard-cut shots must cover cut utterances exactly once and in order: ${options.cutId}.`);
  }

  const normalizedShots = [];
  for (const [shotIndex, sourceShot] of shots.entries()) {
    const imagePath = resolve(sourceShot.imagePath || "");
    if (!isInsideDirectory(imagePath, projectDir) || !await exists(imagePath)) {
      throw new Error(`Shot image must be an existing file inside the project: ${imagePath}`);
    }
    const sourceAvoidRegions = Array.isArray(sourceShot.sourceAvoidRegions)
      ? sourceShot.sourceAvoidRegions
      : [];
    if (!sourceAvoidRegions.some((region) => region?.kind === "face")) {
      throw new Error(`Shot ${sourceShot.id || shotIndex} requires remeasured face regions from its actual source image.`);
    }
    sourceAvoidRegions.forEach((region, regionIndex) => (
      assertNormalizedSourceRegion(region, `${sourceShot.id || shotIndex}.sourceAvoidRegions[${regionIndex}]`)
    ));
    const sourceFaceBoundsBySpeakerId = sourceShot.sourceFaceBoundsBySpeakerId
      && typeof sourceShot.sourceFaceBoundsBySpeakerId === "object"
      ? sourceShot.sourceFaceBoundsBySpeakerId
      : {};
    for (const [speakerId, region] of Object.entries(sourceFaceBoundsBySpeakerId)) {
      assertNormalizedSourceRegion(region, `${sourceShot.id || shotIndex}.sourceFaceBoundsBySpeakerId.${speakerId}`);
    }
    const viewpoint = nonEmpty(sourceShot.viewpoint || sourceShot.angle) || "wide";
    const cameraMode = nonEmpty(sourceShot.cameraMode || sourceShot.motion)
      || (viewpoint === "wide" ? "pullout-only" : `${viewpoint}-only`);
    const shot = applyMangaCameraGrammarToShot({
      ...sourceShot,
      imagePath,
      sourceAvoidRegions,
      sourceFaceBoundsBySpeakerId,
      transition: nonEmpty(sourceShot.transition) || "cut",
    }, viewpoint, cameraMode);
    delete shot.metadataOnlyUnderWholePageCamera;
    normalizedShots.push(shot);
  }

  const utteranceById = new Map((manifest.utterances || []).map((utterance) => [utterance.id, utterance]));
  for (const [utteranceId, segmentPlan] of Object.entries(plan.bubbleSegmentTimings || {})) {
    const utterance = utteranceById.get(utteranceId);
    if (!utterance || utterance.cutId !== cut.id) {
      throw new Error(`Bubble timing target is not in ${cut.id}: ${utteranceId}`);
    }
    const segments = Array.isArray(utterance.bubbleSegments) ? utterance.bubbleSegments : [];
    const timingById = new Map((segmentPlan.segments || []).map((segment) => [segment.id, segment]));
    if (segments.length === 0 || timingById.size !== segments.length) {
      throw new Error(`Bubble timing plan must cover every existing segment for ${utteranceId}.`);
    }
    let previousEnd = -Infinity;
    for (const segment of segments) {
      const timing = timingById.get(segment.id);
      const start = Number(timing?.startOffsetSeconds);
      const end = Number(timing?.endOffsetSeconds);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || start < -0.25) {
        throw new Error(`Invalid bubble timing for ${segment.id}.`);
      }
      if (start < previousEnd) throw new Error(`Bubble segments overlap for ${utteranceId}.`);
      if (end > Number(utterance.audio?.durationSeconds || 0) + 0.5) {
        throw new Error(`Bubble segment exceeds approved audio for ${segment.id}.`);
      }
      Object.assign(segment, {
        startOffsetSeconds: start,
        endOffsetSeconds: end,
        timingPolicy: nonEmpty(segmentPlan.timingPolicy) || "provider-character-timestamps+waveform-pause-v1",
        alignmentEvidence: segmentPlan.alignmentEvidence || null,
      });
      previousEnd = end;
    }
  }
  for (const [utteranceId, bounds] of Object.entries(plan.bubbleSpeechBounds || {})) {
    const utterance = utteranceById.get(utteranceId);
    if (!utterance || utterance.cutId !== cut.id) {
      throw new Error(`Visual speech-bound target is not in ${cut.id}: ${utteranceId}`);
    }
    const speechStartSeconds = Number(bounds?.speechStartSeconds);
    const speechEndSeconds = Number(bounds?.speechEndSeconds);
    const durationSeconds = Number(utterance.audio?.durationSeconds);
    if (
      !Number.isFinite(speechStartSeconds)
      || !Number.isFinite(speechEndSeconds)
      || !Number.isFinite(durationSeconds)
      || speechStartSeconds < 0
      || speechEndSeconds <= speechStartSeconds
      || speechEndSeconds > durationSeconds
    ) {
      throw new Error(`Invalid visual speech bounds for ${utteranceId}.`);
    }
    utterance.bubbleTiming = {
      speechStartSeconds,
      speechEndSeconds,
      timingPolicy: nonEmpty(bounds.timingPolicy) || "waveform-audible-bounds-v1",
      evidence: bounds.evidence || null,
    };
  }

  const backupPath = join(paths.episodeDir, `episode-manifest-pre-${plan.revision}.json`);
  if (!await exists(backupPath)) await writeJsonAtomic(backupPath, manifestInput);
  delete cut.panelLayout;
  delete cut.flattenedSplitPage;
  cut.cameraSequence = normalizedShots;
  cut.imagePath = normalizedShots[0].imagePath;
  cut.imageSize = plan.shots[0].imageSize || cut.imageSize;
  cut.motion = normalizedShots[0].motion;
  cut.cameraMode = normalizedShots[0].cameraMode;
  cut.camera = normalizedShots[0].camera;
  cut.cameraAssetInventory = {
    version: plan.revision,
    shotCount: normalizedShots.length,
    uniqueImageCount: new Set(normalizedShots.map((shot) => shot.imagePath)).size,
    repeatedImages: [],
  };
  cut.imageGeneration = {
    ...(cut.imageGeneration || {}),
    status: "approved-standard-single-image-shots",
    standardLayoutRevision: plan.revision,
    standardLayoutPlanPath: planPath,
    adoptedAt: new Date().toISOString(),
  };

  for (const shot of normalizedShots) {
    for (const utteranceId of shot.utteranceIds || []) {
      const utterance = utteranceById.get(utteranceId);
      const overlaySpecPath = nonEmpty(utterance?.overlaySpecPath);
      if (!overlaySpecPath || !await exists(overlaySpecPath)) {
        throw new Error(`Overlay spec is missing for ${utteranceId}.`);
      }
      const overlaySpec = await readJson(overlaySpecPath);
      delete overlaySpec.splitPageSource;
      await writeJsonAtomic(overlaySpecPath, {
        ...overlaySpec,
        imagePath: shot.imagePath,
        imageSize: sourceShotImageSize(plan, shot.id, overlaySpec.imageSize),
        sourceAvoidRegions: shot.sourceAvoidRegions,
        plan: { ...(overlaySpec.plan || {}), avoidRegions: [] },
      });
    }
  }

  manifest = compileEpisodeTiming(manifest, {
    sameSpeakerGapSeconds: resolved.contract.audio.sameSpeakerGapSeconds,
    speakerChangeGapSeconds: resolved.contract.audio.speakerChangeGapSeconds,
    emphasisGapSeconds: resolved.contract.audio.emphasisGapSeconds,
    bubbleFadeInMilliseconds: resolved.contract.bubbles.fadeInMilliseconds,
    bubbleFadeOutMilliseconds: resolved.contract.bubbles.fadeOutMilliseconds,
    bubbleTransitionCrossfadeSeconds: resolved.contract.bubbles.transitionCrossfadeSeconds,
  });
  const adjustedAt = new Date().toISOString();
  manifest.production = {
    ...(manifest.production || {}),
    layoutAdjustments: [
      ...(manifest.production?.layoutAdjustments || []),
      {
        version: "koya-standard-single-image-cut-v1",
        cutId: cut.id,
        revision: plan.revision,
        planPath,
        removedPanelLayout: true,
        shotIds: normalizedShots.map((shot) => shot.id),
        bubbleTimingEvidence: plan.bubbleSegmentTimings || {},
        reason: options.reason || plan.reason || "user requested ordinary single-image shots",
        adjustedAt,
      },
    ],
  };
  manifest.status = "layout-adjusted-awaiting-render";
  manifest.knownRemainingIssues = [{
    id: "standard-cut-user-review",
    detail: `${cut.id} must pass rendered MP4 bubble timing, face, camera, and visual review.`,
  }];
  await writeJsonAtomic(paths.manifestPath, manifest);
  const refreshed = await refreshEpisodeBubbleOverlays({
    projectDir,
    manifestPath: paths.manifestPath,
    bubbleOverrides: Object.fromEntries((cut.utteranceIds || []).map((utteranceId) => [utteranceId, {}])),
    reflowPlacement: true,
    sequenceAware: true,
    stripTerminalJapanesePeriod: resolved.contract.bubbles.stripTerminalJapanesePeriod,
  });
  manifest = refreshed.manifest;
  manifest.status = "layout-adjusted-awaiting-render";
  manifest.knownRemainingIssues = [{
    id: "standard-cut-user-review",
    detail: `${cut.id} must pass rendered MP4 bubble timing, face, camera, and visual review.`,
  }];
  const contractAudit = auditManifestAgainstKoyaContract(manifest, resolved);
  if (!contractAudit.pass) {
    throw new Error(`Koya manifest contract failed after standard-cut adjustment: ${JSON.stringify(contractAudit.failures)}`);
  }
  await Promise.all([
    writeJsonAtomic(paths.manifestPath, manifest),
    writeJsonAtomic(paths.contractSnapshotPath, {
      version: resolved.contract.version,
      digest: resolved.digest,
      contractPath: resolved.contractPath,
      episodeOverridePath: resolved.episodeOverridePath,
      contract: resolved.contract,
    }),
  ]);
  const state = await updateState(paths, {
    episodeId: options.episodeId,
    status: "layout-adjusted-awaiting-render",
    currentStage: "render",
    manifestPath: paths.manifestPath,
    contractSnapshotPath: paths.contractSnapshotPath,
    contractDigest: resolved.digest,
    knownRemainingIssues: manifest.knownRemainingIssues,
  });
  return {
    episodeId: options.episodeId,
    cutId: cut.id,
    revision: plan.revision,
    planPath,
    backupPath,
    shotIds: normalizedShots.map((shot) => shot.id),
    refreshedBubbleCount: refreshed.refreshed.length,
    contractAudit,
    paths,
    state,
  };
}

function sourceShotImageSize(plan, shotId, fallback) {
  const shot = (plan.shots || []).find((entry) => entry.id === shotId);
  return shot?.imageSize || fallback;
}

export async function syncKoyaMangaContract(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  const paths = episodePaths(projectDir, options.episodeId);
  const resolved = await resolveKoyaMangaProductionContract({
    projectDir,
    episodeId: options.episodeId,
    contractPath: options.contractPath,
    overridePath: options.overridePath,
  });
  const manifestInput = await readJson(paths.manifestPath);
  const existingGenerator = manifestInput.production?.provenance?.generator;
  const generatorProvenance = existingGenerator?.contextId
    ? existingGenerator
    : resolveKoyaAgentProvenance({
      role: "generator",
      host: options.generatorHost,
      id: options.generatorId,
      contextId: options.generatorContextId,
      source: options.generatorProvenanceSource || "legacy-contract-migration",
    });
  const manifest = applyKoyaContractToManifest(manifestInput, resolved);
  manifest.production = {
    ...(manifest.production || {}),
    provenance: {
      ...(manifest.production?.provenance || {}),
      generator: generatorProvenance,
    },
  };
  const contractAudit = auditManifestAgainstKoyaContract(manifest, resolved);
  if (!contractAudit.pass) {
    throw new Error(`Koya manifest contract failed after contract sync: ${JSON.stringify(contractAudit.failures)}`);
  }
  await Promise.all([
    writeJsonAtomic(paths.manifestPath, manifest),
    writeJsonAtomic(paths.contractSnapshotPath, {
      version: resolved.contract.version,
      digest: resolved.digest,
      contractPath: resolved.contractPath,
      episodeOverridePath: resolved.episodeOverridePath,
      contract: resolved.contract,
    }),
  ]);
  const state = await updateState(paths, {
    episodeId: options.episodeId,
    status: "rendered-awaiting-audit",
    currentStage: "audit",
    manifestPath: paths.manifestPath,
    contractSnapshotPath: paths.contractSnapshotPath,
    contractDigest: resolved.digest,
    generatorProvenance,
    knownRemainingIssues: manifest.knownRemainingIssues || [],
  });
  return { episodeId: options.episodeId, contractAudit, paths, resolved, state };
}

export async function refreshKoyaMangaBubbles(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  const paths = episodePaths(projectDir, options.episodeId);
  const resolved = await resolveKoyaMangaProductionContract({
    projectDir,
    episodeId: options.episodeId,
    contractPath: options.contractPath,
    overridePath: options.overridePath,
  });
  const refreshed = await refreshEpisodeBubbleOverlays({
    projectDir,
    manifestPath: paths.manifestPath,
    refreshAll: true,
    reflowPlacement: options.reflowPlacement !== false,
    sequenceAware: true,
    stripTerminalJapanesePeriod: resolved.contract.bubbles.stripTerminalJapanesePeriod,
  });
  // Refreshing can re-split a balloon into different segments, and a segment
  // that never went through timing compilation carries no display window at
  // all. Recompile here so every segment leaves this step timed.
  const manifest = compileEpisodeTiming(applyKoyaContractToManifest(refreshed.manifest, resolved), {
    sameSpeakerGapSeconds: resolved.contract.audio.sameSpeakerGapSeconds,
    speakerChangeGapSeconds: resolved.contract.audio.speakerChangeGapSeconds,
    emphasisGapSeconds: resolved.contract.audio.emphasisGapSeconds,
    bubbleFadeInMilliseconds: resolved.contract.bubbles.fadeInMilliseconds,
    bubbleFadeOutMilliseconds: resolved.contract.bubbles.fadeOutMilliseconds,
    bubbleTransitionCrossfadeSeconds: resolved.contract.bubbles.transitionCrossfadeSeconds,
  });
  manifest.status = "bubble-layout-ready";
  manifest.outputs = {};
  manifest.knownRemainingIssues = [{
    id: "fresh-render-required",
    detail: "Bubble SVG artifacts changed and the real MP4 must be rendered and audited again.",
  }];
  manifest.production = {
    ...(manifest.production || {}),
    bubbleDisplayPolicy: {
      preserveAuthoredSpeechText: true,
      stripTerminalJapanesePeriod: resolved.contract.bubbles.stripTerminalJapanesePeriod === true,
      refreshedAt: new Date().toISOString(),
    },
  };
  const contractAudit = auditManifestAgainstKoyaContract(manifest, resolved);
  if (!contractAudit.pass) {
    throw new Error(`Koya manifest contract failed after bubble refresh: ${JSON.stringify(contractAudit.failures)}`);
  }
  await writeJsonAtomic(paths.manifestPath, manifest);
  const state = await updateState(paths, {
    status: "bubble-layout-ready",
    currentStage: "render",
    manifestPath: paths.manifestPath,
    knownRemainingIssues: manifest.knownRemainingIssues,
  });
  return { episodeId: options.episodeId, paths, resolved, manifest, refreshed: refreshed.refreshed, contractAudit, state };
}

export async function renderKoyaMangaVideo(options = {}) {
  const preflight = await assertKoyaFullPreflight(options);
  const expectedOuterJobBinding = requiredOuterJobBindingFromPreflight(preflight);
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  const paths = episodePaths(projectDir, options.episodeId);
  const resolved = await resolveKoyaMangaProductionContract({
    projectDir,
    episodeId: options.episodeId,
    contractPath: options.contractPath,
    overridePath: options.overridePath,
  });
  const manifestBeforeRender = await readJson(paths.manifestPath);
  const manifestOuterJobBinding = assertKoyaOuterJobBinding(manifestBeforeRender?.production?.outerJobBinding, { required: true });
  if (!sameKoyaOuterJobBinding(expectedOuterJobBinding, manifestOuterJobBinding)) {
    throw new Error("Koya render manifest belongs to another outer Video Harness Job.");
  }
  if (!manifestBeforeRender.production?.provenance?.generator?.contextId) {
    throw new Error("Render is blocked: generator task/session provenance is missing. Run plan or sync-contract with a real generator context first.");
  }

  // Marked cuts render only from a ledger-verified clip or a recorded still
  // fallback; anything else stops before ffmpeg starts.
  await assertCutVideoSubstitutionsReadyForRender({
    manifest: manifestBeforeRender,
    manifestPath: paths.manifestPath,
    contract: resolved.contract,
  });
  const result = await renderEpisodeVideo({
    projectDir,
    manifestPath: paths.manifestPath,
    renderConcurrency: recommendedKoyaRenderConcurrency({
      requested: options.renderConcurrency,
      cameraOversample: resolved.contract.camera.cameraOversample,
    }),
    cutIds: options.cutIds,
    reuseRenderedCuts: options.reuseRenderedCuts !== false,
    force: options.force === true,
    fileName: options.fileName || `${options.episodeId}-${resolved.contract.version}.mp4`,
    bgmPath: "",
    bgmVolume: 0,
    masterTargetLufs: resolved.contract.audio.masterTargetLufs,
    masterTruePeakDb: resolved.contract.audio.masterTruePeakDb,
  });
  const state = await updateState(paths, {
    status: "rendered-awaiting-audit",
    currentStage: "audit",
    reviewVideoPath: result.outputPath || result.manifest?.outputs?.reviewVideo?.filePath || "",
    knownRemainingIssues: [],
  });
  return { ...result, paths, resolved, state };
}

/**
 * A missing human voice selection is a pause for a person, not a failure:
 * the full runner returns exit code 3 so the outer Job waits in
 * awaiting-human-review and a later resume runs again. A thrown error would
 * end the Job as failed, and a failed Job never runs again.
 */
export function koyaVoiceSelectionPauseResult(error, { preflight, projectDir, episodeId, stage }) {
  if (error?.code !== KOYA_VOICE_SELECTION_REQUIRED_CODE) return null;
  const characterIds = Array.isArray(error.characterIds) ? [...error.characterIds] : [];
  return {
    exitCode: 3,
    preflight,
    payload: {
      episodeId,
      status: "awaiting-voice-selection",
      waiting: true,
      stage,
      checkpoint: episodePaths(projectDir, episodeId).statePath,
      characterIds,
      knownRemainingIssues: [
        `voice-selection-required: ${characterIds.join(", ")}`,
        String(error.message || ""),
      ],
    },
  };
}

/**
 * A missing wardrobe-readiness pass is also a pause for a person (run the
 * free check, have another context review a slot, register an outfit, or
 * record an override), so the full runner returns exit code 3 like the voice
 * selection pause and the outer Job stays resumable.
 */
export function koyaWardrobeReadinessPauseResult(error, { preflight, projectDir, episodeId, stage }) {
  if (error?.code !== KOYA_WARDROBE_READINESS_REQUIRED_CODE) return null;
  const slotIds = Array.isArray(error.slotIds) ? [...error.slotIds] : [];
  const wardrobeStatus = nonEmpty(error.wardrobeStatus) || "missing";
  return {
    exitCode: 3,
    preflight,
    payload: {
      episodeId,
      status: "awaiting-wardrobe-readiness",
      waiting: true,
      stage,
      checkpoint: episodePaths(projectDir, episodeId).statePath,
      wardrobeReadiness: {
        status: wardrobeStatus,
        inventoryPath: nonEmpty(error.inventoryPath),
        pendingSlotIds: slotIds,
      },
      knownRemainingIssues: [
        `wardrobe-readiness-required: ${wardrobeStatus}${slotIds.length > 0 ? ` (${slotIds.join(", ")})` : ""}`,
        String(error.message || ""),
      ],
    },
  };
}

/**
 * The only full Koya stage orchestration used by the CLI. Keeping preflight
 * and the first paid runner in one function makes the ordering testable: a
 * failed doctor cannot accidentally fall through to image or speech calls.
 */
async function runKoyaMangaFullProductionUnlocked(options = {}, runtime = {}) {
  if (!options.episodeId) throw new Error("episodeId is required.");
  if (!nonEmpty(options.scriptPath)) throw new Error("scriptPath is required for a full run.");
  const preflight = await assertKoyaFullPreflight(options, runtime);
  const outerJobBinding = requiredOuterJobBindingFromPreflight(preflight);
  const boundOptions = { ...options, outerJobBinding };
  const runImages = runtime.generateImages || generateKoyaMangaImages;
  const prepareManifest = runtime.prepareManifest || createKoyaEpisodeManifest;
  const runSpeech = runtime.generateSpeech || generateKoyaMangaSpeech;
  const runRender = runtime.renderVideo || renderKoyaMangaVideo;
  const auditFinal = runtime.auditFinal
    || (await import("./koyaMangaFinalAudit.mjs")).auditKoyaMangaFinal;
  // The pre-image voice check protects the real paid image runner. A test that
  // stubs the image runner spends nothing, so it opts in by injecting the check.
  const checkVoicesBeforeImages = runtime.checkVoiceSelectionsBeforeImages
    || (runtime.generateImages ? null : assertKoyaVoiceSelectionsBeforeImages);
  // Same opt-in rule for the wardrobe check; the real image runner also runs
  // it itself, so the paid path is covered either way.
  const checkWardrobeBeforeImages = runtime.checkWardrobeReadinessBeforeImages
    || (runtime.generateImages ? null : assertKoyaWardrobeReadinessBeforeImages);
  const projectDir = resolve(options.projectDir || process.cwd());
  const jobContext = { jobId: preflight.jobId || "", jobProjectDir: preflight.jobProjectDir || "" };
  const pauseFor = (error, stage, episodeId) => koyaVoiceSelectionPauseResult(error, {
    preflight,
    projectDir,
    episodeId,
    stage,
  });

  const wardrobePauseFor = (error, stage, episodeId) => koyaWardrobeReadinessPauseResult(error, {
    preflight,
    projectDir,
    episodeId,
    stage,
  });

  if (checkVoicesBeforeImages) {
    try {
      await checkVoicesBeforeImages(boundOptions, jobContext);
    } catch (error) {
      const paused = pauseFor(error, "before-images", options.episodeId);
      if (paused) return paused;
      throw error;
    }
  }
  if (checkWardrobeBeforeImages) {
    try {
      await checkWardrobeBeforeImages(boundOptions, { ...jobContext, runtime, stage: "before-images" });
    } catch (error) {
      const paused = wardrobePauseFor(error, "before-images", options.episodeId);
      if (paused) return paused;
      throw error;
    }
  }
  let imageResult;
  try {
    imageResult = await runImages(boundOptions);
  } catch (error) {
    const paused = wardrobePauseFor(error, "images", options.episodeId);
    if (paused) return paused;
    throw error;
  }
  const episodeId = imageResult.episodeId || options.episodeId;
  if (imageResult.waiting || imageResult.failed) {
    return {
      exitCode: 3,
      preflight,
      payload: {
        episodeId,
        status: imageResult.state?.status || "images-paused",
        waiting: imageResult.waiting === true,
        checkpoint: imageResult.paths?.statePath || "",
        knownRemainingIssues: imageResult.state?.knownRemainingIssues || [],
      },
    };
  }
  let prepared;
  try {
    prepared = await prepareManifest({ ...boundOptions, episodeId, jobProjectDir: jobContext.jobProjectDir });
  } catch (error) {
    const paused = pauseFor(error, "prepare", episodeId);
    if (paused) return paused;
    throw error;
  }
  if (prepared.waiting) {
    return {
      exitCode: 3,
      preflight,
      payload: {
        episodeId,
        status: prepared.state?.status || "prepare-paused",
        waiting: true,
        checkpoint: prepared.paths?.statePath || "",
        knownRemainingIssues: prepared.state?.knownRemainingIssues || [],
      },
    };
  }
  let speech;
  try {
    speech = await runSpeech({ ...boundOptions, episodeId });
  } catch (error) {
    const paused = pauseFor(error, "speech", episodeId);
    if (paused) return paused;
    throw error;
  }
  const mediaJobs = Array.isArray(speech.report?.mediaJobs) ? speech.report.mediaJobs : [];
  if (speech.waiting || speech.cancelled || speech.partial) {
    return {
      exitCode: 3,
      preflight,
      payload: {
        episodeId,
        status: speech.waiting
          ? "waiting-usage-limit"
          : speech.cancelled ? "speech-checkpointed" : "speech-partial",
        waiting: speech.waiting === true,
        checkpoint: speech.paths?.statePath || "",
        mediaJobs,
        knownRemainingIssues: speech.report?.knownRemainingIssues || [],
      },
    };
  }
  const runVideoSubstitution = runtime.substituteVideos || substituteKoyaMangaCutVideos;
  const substituted = await runVideoSubstitution({ ...boundOptions, episodeId }, runtime);
  if (substituted.waiting || substituted.blocked) {
    return {
      exitCode: 3,
      preflight,
      payload: {
        episodeId,
        status: substituted.state?.status || (substituted.waiting ? "waiting-paid-video-confirmation" : "video-substitution-blocked"),
        waiting: substituted.waiting === true,
        checkpoint: substituted.paths?.statePath || "",
        mediaJobs,
        videoSubstitution: {
          stageReportPath: substituted.stageReportPath || "",
          ledgerPath: substituted.ledgerPath || "",
          rows: substituted.rows || [],
          blockedCuts: substituted.blockedCuts || [],
        },
        knownRemainingIssues: substituted.state?.knownRemainingIssues || [],
      },
    };
  }
  const rendered = await runRender({ ...boundOptions, episodeId });
  const audited = await auditFinal({
    projectDir: resolve(options.projectDir || process.cwd()),
    manifestPath: rendered.paths.manifestPath,
    videoPath: rendered.outputPath,
    outerJobBinding,
  });
  return {
    exitCode: audited.report.pass ? 0 : 2,
    preflight,
    payload: {
      episodeId,
      status: audited.report.pass ? "final-koya-audited" : "audit-incomplete",
      videoPath: rendered.outputPath,
      reportPath: audited.reportPath,
      contactSheetPath: audited.contactSheetPath,
      visualSignoffPath: audited.signoffPath,
      visualSignoffSha256: audited.signoffSha256,
      runReceiptPath: audited.runReceiptPath,
      mediaJobs,
      failedAuditIds: audited.report.failedAuditIds,
      knownRemainingIssues: audited.report.knownRemainingIssues,
    },
  };
}

/**
 * One coordinator owns an episode's shared manifest/state for the whole full
 * run. Per-cut speech locks are not enough: two direct CLI `full` processes
 * could otherwise both pass doctor and race image/manifest/render writes.
 */
export async function runKoyaMangaFullProduction(options = {}, runtime = {}) {
  if (!options.episodeId) throw new Error("episodeId is required.");
  const projectDir = resolve(options.projectDir || process.cwd());
  const lockKey = sha256Text(`${projectDir}\n${options.episodeId}`);
  const lockTarget = join(projectDir, "canvas", "manga-videos", ".full-run-locks", lockKey);
  const withFullRunLock = runtime.withFullRunLock || withCanvasFileLock;
  return withFullRunLock(
    lockTarget,
    () => runKoyaMangaFullProductionUnlocked({ ...options, projectDir }, runtime),
    { timeoutMs: 0 },
  );
}

export async function readKoyaProductionState(options = {}) {
  const paths = episodePaths(resolve(options.projectDir || process.cwd()), options.episodeId);
  return { paths, state: await readJson(paths.statePath) };
}

export { episodePaths as koyaEpisodePaths };
