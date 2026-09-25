import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createRequire } from "node:module";

import { validateCutVideoSubstitutionContract } from "./mangaCutVideoSubstitutionPolicy.mjs";
import { validateKoyaWardrobeReadinessContract } from "./koyaWardrobeReadiness.mjs";
import { validateKoyaAssetQualityGateContract, validateKoyaVideoClipQualityGateContract } from "./koyaAssetQualityGatePolicy.mjs";
import { validateKoyaScriptQualityGateContract } from "./koyaScriptQualityGatePolicy.mjs";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const moduleDir = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_KOYA_CONTRACT_PATH = resolve(moduleDir, "../config/koya-manga-production-contract.json");
export const DEFAULT_KOYA_CONTRACT_SCHEMA_PATH = resolve(moduleDir, "../config/koya-manga-production-contract.schema.json");
const koyaContractSchema = JSON.parse(readFileSync(DEFAULT_KOYA_CONTRACT_SCHEMA_PATH, "utf8"));
// ajv は検証する瞬間に読む。先頭で読むと、依存を入れていない配布プラグインから
// 実行系（動画 Job → RunReceipt → この契約）を読み込めなくなる。
let compiledContractValidator = null;
function validateContractSchema(contract) {
  if (!compiledContractValidator) {
    const AjvModule = createRequire(import.meta.url)("ajv");
    const Ajv = AjvModule.default || AjvModule;
    compiledContractValidator = new Ajv({ allErrors: true, strict: true }).compile(koyaContractSchema);
  }
  const pass = compiledContractValidator(contract);
  validateContractSchema.errors = compiledContractValidator.errors;
  return pass;
}
/**
 * 台詞音声の有料アダプタとして認める識別子の一覧（kind は常に voice.dialogue）。
 *
 * 以前は ElevenLabs の3値を本番コードの30か所近くにリテラルで書いていたので、
 * 音声の提供元を変えるたびに照合を全部書き換える必要があった。いまは契約
 * （audio.provider / audio.model / audio.adapterVersion）が正で、各所はここから引く。
 *
 * 一覧の外の値を契約に書いても通さない（契約の検証で落ちる）。任意の文字列を
 * 契約に書けば任意の有料アダプタを呼べる、にしないため。
 *
 * otoshigo は運営者の自社音声サービス。2026-09-24 の決定で「最初からオトシゴの声」に
 * する。仕様は docs/otoshigo-media-job-api-spec-ja.md §7.1。
 */
export const KOYA_DIALOGUE_ADAPTERS = Object.freeze([
  Object.freeze({
    kind: "voice.dialogue",
    provider: "elevenlabs",
    model: "eleven_v3",
    adapterVersion: "elevenlabs-dialogue-server-v1",
  }),
  Object.freeze({
    kind: "voice.dialogue",
    provider: "otoshigo",
    model: "irodori-tts-v4.1-small",
    adapterVersion: "otoshigo-dialogue-server-v1",
  }),
]);

/** 旧来の既定。契約に audio が無い古い呼び出し（試験の合成 manifest など）だけが使う。 */
export const DEFAULT_KOYA_DIALOGUE_ADAPTER = KOYA_DIALOGUE_ADAPTERS[0];

function sameDialogueAdapter(left, right) {
  return left?.provider === right?.provider
    && left?.model === right?.model
    && left?.adapterVersion === right?.adapterVersion;
}

/** 与えた3値が一覧の1件とぴったり一致するときだけ、その1件を返す。 */
export function findKoyaDialogueAdapter(identity = {}) {
  return KOYA_DIALOGUE_ADAPTERS.find((entry) => sameDialogueAdapter(entry, identity)) || null;
}

/**
 * 契約（または解決済み契約）から台詞音声のアダプタを1件に決める。
 * adapterVersion を省いた契約は provider と model が一致する1件に決まるときだけ受ける。
 */
export function resolveKoyaDialogueAdapter(contractOrResolved) {
  const contract = contractOrResolved?.contract || contractOrResolved;
  const audio = contract?.audio;
  // 提供元も型番も書いていない（試験の部分的な契約など）ときだけ旧来の既定。
  // 本物の契約は schema が provider と model を必須にしているのでここには来ない。
  if (!audio || (!audio.provider && !audio.model)) return DEFAULT_KOYA_DIALOGUE_ADAPTER;
  const matches = KOYA_DIALOGUE_ADAPTERS.filter((entry) => entry.provider === audio.provider
    && entry.model === audio.model
    && (!audio.adapterVersion || entry.adapterVersion === audio.adapterVersion));
  if (matches.length !== 1) {
    throw new Error(
      `Koya contract audio adapter is not an allowed voice.dialogue adapter: `
      + `${audio.provider || "(missing)"} / ${audio.model || "(missing)"} / ${audio.adapterVersion || "(unspecified)"}.`,
    );
  }
  return matches[0];
}

export const REQUIRED_KOYA_AUDIT_IDS = Object.freeze([
  "contract-manifest",
  "editorial-quality",
  "quality-harness-final",
  "rendered-camera",
  "bubble-midpoint-frames",
  "bubble-transition-clear-frames",
  "bubble-camera-sweep",
  "independent-rendered-face",
  "bubble-typography",
  "thought-spotlight",
  "split-page-integrity",
  "video-substitution",
  "wardrobe-readiness",
  "stt-verification",
  "audio-onset",
  "audio-speaker-continuity",
  "audio-waveform-sync",
  "audio-click-hum-level",
  "agent-contact-sheet-review",
  "full-decode",
]);

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function koyaContractDigest(contract) {
  return createHash("sha256").update(stableJson(contract)).digest("hex");
}

function mergeKnown(base, override, path = "contract") {
  if (!plainObject(override)) return structuredClone(override);
  if (!plainObject(base)) throw new Error(`Unknown object override at ${path}.`);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (!Object.hasOwn(base, key)) throw new Error(`Unknown contract override key: ${path}.${key}`);
    const nextPath = `${path}.${key}`;
    result[key] = plainObject(value) ? mergeKnown(base[key], value, nextPath) : structuredClone(value);
  }
  return result;
}

function requireValue(failures, condition, path, message) {
  if (!condition) failures.push({ path, message });
}

function schemaFailurePath(error) {
  const parts = String(error.instancePath || "")
    .split("/")
    .filter(Boolean)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (error.keyword === "required" && error.params?.missingProperty) parts.push(error.params.missingProperty);
  if (error.keyword === "additionalProperties" && error.params?.additionalProperty) parts.push(error.params.additionalProperty);
  return parts.join(".") || "contract";
}

export function validateKoyaMangaProductionSchema(contract) {
  const pass = validateContractSchema(contract);
  const failures = pass ? [] : (validateContractSchema.errors || []).map((error) => ({
    path: schemaFailurePath(error),
    message: `schema ${error.keyword}: ${error.message}`,
  }));
  return { pass: failures.length === 0, failures };
}

export function validateKoyaMangaProductionContract(contract) {
  const failures = [...validateKoyaMangaProductionSchema(contract).failures];
  requireValue(failures, contract?.schemaVersion === 1, "schemaVersion", "must equal 1");
  requireValue(failures, /^koya-manga-production-v\d+$/u.test(String(contract?.version || "")), "version", "must be a versioned Koya contract");
  requireValue(failures, (() => {
    try { resolveKoyaDialogueAdapter(contract); return true; } catch { return false; }
  })(), "audio.model", "must name an allowed voice.dialogue adapter (see KOYA_DIALOGUE_ADAPTERS)");
  requireValue(failures, contract?.audio?.generationMode === "text-to-dialogue-with-timestamps", "audio.generationMode", "must preserve cut-level dialogue timing");
  requireValue(failures, Number(contract?.audio?.takeCount) >= 2, "audio.takeCount", "must generate at least two takes");
  requireValue(failures, contract?.audio?.allowBgm === false, "audio.allowBgm", "BGM must remain disabled");
  requireValue(failures, contract?.audio?.allowSignalEffects === false, "audio.allowSignalEffects", "voice signal effects must remain disabled");
  requireValue(
    failures,
    ["protagonist-voice", "approved-original-narrator"].includes(contract?.audio?.narrationVoicePolicy),
    "audio.narrationVoicePolicy",
    "must use the protagonist voice, except for a frozen approved-original-narrator episode override",
  );
  if (contract?.audio?.narrationVoicePolicy === "protagonist-voice") {
    requireValue(failures, contract?.audio?.preserveNarrationVisualStyle === true, "audio.preserveNarrationVisualStyle", "square narration styling must remain independent from voice casting");
    requireValue(failures, contract?.audio?.requireProtagonistVoiceMatch === true, "audio.requireProtagonistVoiceMatch", "narration must hard-match the protagonist voice");
  }
  if (contract?.audio?.narrationVoicePolicy === "approved-original-narrator") {
    requireValue(failures, Boolean(String(contract?.audio?.narrationVoiceId || "").trim()), "audio.narrationVoiceId", "approved narrator policy requires a locked voice id");
  }
  requireValue(failures, contract?.bubbles?.activeSpeakerFaceMaximumOverlap === 0, "bubbles.activeSpeakerFaceMaximumOverlap", "active speaker faces require a hard zero-overlap gate");
  requireValue(failures, contract?.bubbles?.cameraSweepSamples >= 33, "bubbles.cameraSweepSamples", "camera-aware placement requires at least 33 samples");
  requireValue(failures, contract?.bubbles?.requireIndependentRenderedFaceAudit === true, "bubbles.requireIndependentRenderedFaceAudit", "rendered face audit must be independent");
  for (const key of ["requireNaturalAnatomyAndPropScale", "forbidGeneratedPseudoText", "refreshSourceAnnotationsAfterImageChange"]) {
    requireValue(failures, contract?.art?.[key] === true, `art.${key}`, "must be true");
  }
  const characterReview = contract?.art?.characterIdentityReview;
  for (const key of [
    "requireRealImageDiversityReview",
    "requireIndependentReviewerContext",
    "requireOriginalScaleReview",
    "requireAssetSha256",
    "requireRealTurnaround",
    "forbidCandidateTurnaroundSubstitution",
  ]) {
    requireValue(failures, characterReview?.[key] === true, `art.characterIdentityReview.${key}`, "must be true");
  }
  requireValue(failures, characterReview?.candidateCount === 3, "art.characterIdentityReview.candidateCount", "must compare exactly three character candidates");
  requireValue(failures, characterReview?.minimumDistinctAxesPerPair >= 2, "art.characterIdentityReview.minimumDistinctAxesPerPair", "must require at least two real visual differences per pair");
  requireValue(failures, characterReview?.expressionGrid?.cellCount === 12 && characterReview?.expressionGrid?.requireCellIdentityReview === true, "art.characterIdentityReview.expressionGrid", "must inspect all twelve expression cells");
  requireValue(failures, characterReview?.requiredTurnaroundViews?.length === 8, "art.characterIdentityReview.requiredTurnaroundViews", "must inspect all eight turnaround views");
  requireValue(failures, characterReview?.outfitSheetPolicy === "required-when-multiple-story-stages", "art.characterIdentityReview.outfitSheetPolicy", "must require dedicated sheets for changing outfits");
  requireValue(failures, contract?.camera?.grammarVersion === "manga-page-camera-v2", "camera.grammarVersion", "must use the v2 camera grammar");
  for (const family of ["directional", "pullout", "combined"]) {
    requireValue(failures, contract?.camera?.requiredFamilies?.includes(family), "camera.requiredFamilies", `missing ${family}`);
  }
  for (const key of ["forbidPushIn", "forbidDownwardMotion", "forbidStops", "forbidRepeatedCameraImages", "forbidPhaseReset"]) {
    requireValue(failures, contract?.camera?.[key] === true, `camera.${key}`, "must be true");
  }
  requireValue(failures, contract?.video?.width === 1920 && contract?.video?.height === 1080, "video", "must render at 1920x1080");
  requireValue(failures, contract?.video?.fps === 30, "video.fps", "must render at 30 fps");
  for (const key of [
    "preserveFullScript",
    "forbidContextlessLeadInImages",
    "preferMultiUtteranceImageHolds",
    "requireEditContinuityReview",
    "requireDialoguePacingReview",
    "allowSplitPagesOnlyWhenSemanticallyJustified",
    "forbidUnassignedCameraShots",
    "forbidConditionalSplitPageLeadIns",
    "requireEveryUtteranceAssignedToImage",
  ]) {
    requireValue(failures, contract?.editorial?.[key] === true, `editorial.${key}`, "must be true");
  }
  requireValue(failures, Number(contract?.editorial?.minimumMultiUtteranceImageShare) >= 0.35, "editorial.minimumMultiUtteranceImageShare", "must be at least 0.35");
  requireValue(failures, Number(contract?.editorial?.minimumMedianImageHoldSeconds) >= 6, "editorial.minimumMedianImageHoldSeconds", "must be at least 6 seconds");
  requireValue(failures, Number(contract?.editorial?.maximumImageHoldSeconds) <= 69.6, "editorial.maximumImageHoldSeconds", "must be at most 69.6 seconds");
  requireValue(failures, contract?.qualityReview?.version === "koya-agent-perceptual-signoff-v4", "qualityReview.version", "must require perceptual signoff v4");
  requireValue(failures, contract?.qualityReview?.reviewNotesVersion === "koya-perceptual-review-notes-v3", "qualityReview.reviewNotesVersion", "must require perceptual review notes v3");
  for (const key of [
    "userFeedbackOverridesMachinePass",
    "requireFullVideoReview",
    "requireContactSheetReview",
    "requireRepresentativeFrameReview",
    "requireAudioSpotChecks",
    "requireNonEmptyNotesPerCheck",
    "requireEmptyKnownRemainingIssues",
    "requireEvidenceFileHashes",
    "requireContractDigestBinding",
    "requireReviewNotesDigestBinding",
    "requireEvaluatorProvenance",
    "requireRubricScores",
    "requireEvidenceMerkleManifest",
  ]) {
    requireValue(failures, contract?.qualityReview?.[key] === true, `qualityReview.${key}`, "must be true");
  }
  const requiredPerceptualChecks = [
    "characterContinuity",
    "composition",
    "camera",
    "bubblePlacement",
    "splitPages",
    "textReadability",
    "anatomyAndPropScale",
    "editContinuity",
    "imagePacing",
    "dialoguePacing",
    "audioNaturalness",
    "audioBoundaryArtifacts",
    "generatedTextArtifacts",
  ];
  for (const checkId of requiredPerceptualChecks) {
    requireValue(failures, contract?.qualityReview?.requiredChecks?.includes(checkId), "qualityReview.requiredChecks", `missing ${checkId}`);
  }
  requireValue(failures, contract?.qualityLoop?.version === "koya-quality-loop-v3", "qualityLoop.version", "must use quality loop v3");
  for (const key of [
    "generatorEvaluatorSeparation",
    "requireDistinctEvaluatorContext",
    "deterministicGatesBeforeJudgment",
    "immutableCriteriaDuringRun",
    "requireExternalState",
    "requireCompleteRubric",
    "requireEvidence",
    "requireFailureFingerprint",
    "requireRevisionDelta",
    "requireVerifiedEvidenceFiles",
    "requireAtLeastOneCompletedRound",
    "requirePersistedIncidentLedger",
  ]) {
    requireValue(failures, contract?.qualityLoop?.[key] === true, `qualityLoop.${key}`, "must be true");
  }
  requireValue(failures, Number(contract?.qualityLoop?.limits?.targetScore) >= 90, "qualityLoop.limits.targetScore", "must be at least 90");
  requireValue(failures, Number(contract?.qualityLoop?.limits?.maximumReviewRounds) <= 8, "qualityLoop.limits.maximumReviewRounds", "must remain bounded");
  requireValue(failures, Number(contract?.qualityLoop?.limits?.maximumElapsedMinutes) > 0, "qualityLoop.limits.maximumElapsedMinutes", "must be positive");
  requireValue(failures, Number(contract?.qualityLoop?.limits?.maximumCostUnits) > 0, "qualityLoop.limits.maximumCostUnits", "must be positive");
  requireValue(failures, contract?.qualityLoop?.candidateDecision?.minimumCandidates >= 2, "qualityLoop.candidateDecision.minimumCandidates", "must compare at least two candidates");
  requireValue(failures, contract?.qualityLoop?.candidateDecision?.maximumCandidates <= 5, "qualityLoop.candidateDecision.maximumCandidates", "must limit human comparison to five candidates");
  for (const key of ["requireDistinctVariationAxes", "anonymousComparison", "revealMappingOnlyAfterVerdict", "requireSelectionReason", "requireIsolatedPrivateMapping", "requireArtifactHashVerification"]) {
    requireValue(failures, contract?.qualityLoop?.candidateDecision?.[key] === true, `qualityLoop.candidateDecision.${key}`, "must be true");
  }
  for (const state of ["active", "passed", "needs-human-approval", "budget-exhausted", "blocked"]) {
    requireValue(failures, contract?.qualityLoop?.terminalStates?.includes(state), "qualityLoop.terminalStates", `missing ${state}`);
  }
  requireValue(failures, contract?.provenance?.officialEntrypoint === "scripts/koya-manga-video.mjs", "provenance.officialEntrypoint", "must use the official CLI");
  requireValue(failures, contract?.provenance?.requireGeneratorContextId === true, "provenance.requireGeneratorContextId", "must bind generation to a real task/session");
  requireValue(failures, contract?.provenance?.requireReviewerContextId === true, "provenance.requireReviewerContextId", "must bind review to a different real task/session");
  requireValue(failures, contract?.provenance?.forbidLegacyStatusAfterRender === true, "provenance.forbidLegacyStatusAfterRender", "must remove stale render labels");
  requireValue(failures, contract?.provenance?.forbidAmbiguousProductionVersion === true, "provenance.forbidAmbiguousProductionVersion", "must remove ambiguous production versions");
  failures.push(...validateCutVideoSubstitutionContract(contract));
  failures.push(...validateKoyaWardrobeReadinessContract(contract));
  failures.push(...validateKoyaAssetQualityGateContract(contract));
  failures.push(...validateKoyaVideoClipQualityGateContract(contract));
  failures.push(...validateKoyaScriptQualityGateContract(contract));
  requireValue(failures, Array.isArray(contract?.requiredAudits), "requiredAudits", "must enumerate the final audit suite");
  for (const auditId of REQUIRED_KOYA_AUDIT_IDS) {
    requireValue(failures, contract?.requiredAudits?.includes(auditId), "requiredAudits", `missing ${auditId}`);
  }
  const uniqueFailures = [...new Map(failures.map((failure) => [failure.path, failure])).values()]
    .sort((left, right) => left.path.localeCompare(right.path));
  return { pass: uniqueFailures.length === 0, failures: uniqueFailures };
}

function narrationRows(manifest) {
  return (manifest?.utterances || []).filter((entry) => (
    entry.speakerId === "narration" || entry.preset === "narration"
  ));
}

function dialogueSpeakerRows(manifest) {
  return (manifest?.utterances || []).filter((entry) => (
    entry.speakerId && entry.speakerId !== "narration" && entry.preset !== "narration"
  ));
}

function normalizeSpeakerToken(value) {
  return String(value || "").trim().toLocaleLowerCase("ja-JP");
}

function uniqueDialogueSpeakers(manifest) {
  const bySpeaker = new Map();
  for (const row of dialogueSpeakerRows(manifest)) {
    if (!bySpeaker.has(row.speakerId)) bySpeaker.set(row.speakerId, row);
  }
  return [...bySpeaker.values()];
}

// The protagonist a scene script declares with 「主人公: はい」: the manifest's
// declaredProtagonistName, or protagonistName on scene-script parse output.
// Legacy scripts carry neither, so this is "" and nothing below changes for
// them (an isProtagonist mark alone is not a declaration).
function declaredProtagonistName(manifest) {
  const declared = manifest?.declaredProtagonistName
    ?? (manifest?.format === "scene-script" ? manifest?.protagonistName : "");
  return typeof declared === "string" ? declared.trim() : "";
}

function speakerMatchesToken(entry, token) {
  return [entry.speakerId, entry.speakerName].map(normalizeSpeakerToken).includes(token);
}

// Speaker ids the declaration points at. Every row counts, so a line written
// under a registry alias of the protagonist (same speaker id) still binds.
function declaredProtagonistSpeakerIds(manifest, declaredName) {
  const token = normalizeSpeakerToken(declaredName);
  return new Set(dialogueSpeakerRows(manifest)
    .filter((entry) => entry.isProtagonist === true || normalizeSpeakerToken(entry.speakerName) === token)
    .map((entry) => entry.speakerId));
}

function declaredProtagonistMismatch(requestedSpeaker, declared) {
  return new Error(
    `Protagonist '${String(requestedSpeaker).trim()}' does not match the protagonist declared in the script (主人公: はい → '${declared}'). `
    + "Fix --protagonist-speaker-id or the script's 登場人物 list before paid generation.",
  );
}

/**
 * Refuse an explicit protagonist that disagrees with the one the script
 * declares. Accepts the declared name or that speaker's id. No-op when the
 * script declares nothing (every legacy script) or nothing was requested.
 * Works on a manifest or on scene-script parse output.
 */
export function assertKoyaDeclaredProtagonist(manifest, requestedSpeaker = "") {
  const requested = normalizeSpeakerToken(requestedSpeaker);
  if (!requested) return "";
  const declared = declaredProtagonistName(manifest);
  if (!declared) return "";
  if (normalizeSpeakerToken(declared) === requested) return declared;
  const declaredIds = declaredProtagonistSpeakerIds(manifest, declared);
  const requestedIds = new Set(dialogueSpeakerRows(manifest)
    .filter((entry) => speakerMatchesToken(entry, requested))
    .map((entry) => entry.speakerId));
  if (requestedIds.size > 0 && [...requestedIds].every((speakerId) => declaredIds.has(speakerId))) return declared;
  throw declaredProtagonistMismatch(requestedSpeaker, declared);
}

function declaredProtagonistWithoutDialogue(declared) {
  return new Error(
    `The protagonist declared in the script ('${declared}') has no dialogue line, so narration cannot use the protagonist's voice. `
    + `Give ${declared} at least one line (「${declared}：…」 or 「${declared}（心）：…」) before paid generation.`,
  );
}

/** Resolve the story protagonist without silently guessing in a multi-character episode. */
export function resolveKoyaProtagonistSpeaker(manifest, requestedSpeaker = "") {
  const speakers = uniqueDialogueSpeakers(manifest);
  const declared = declaredProtagonistName(manifest);
  const requested = normalizeSpeakerToken(
    requestedSpeaker
      || manifest?.production?.protagonistSpeakerId
      || manifest?.story?.protagonistSpeakerId,
  );
  if (requested) {
    assertKoyaDeclaredProtagonist(manifest, requestedSpeaker || requested);
    const matches = speakers.filter((entry) => speakerMatchesToken(entry, requested));
    if (matches.length === 0 && declared && declaredProtagonistSpeakerIds(manifest, declared).size === 0) {
      throw declaredProtagonistWithoutDialogue(declared);
    }
    if (matches.length !== 1) {
      throw new Error(`Protagonist '${requestedSpeaker || requested}' does not uniquely match a dialogue speaker.`);
    }
    return { speakerId: matches[0].speakerId, speakerName: matches[0].speakerName, utterance: matches[0] };
  }
  if (declared) {
    // The script named its protagonist: use exactly that speaker and never
    // fall back to guessing from the other speakers.
    const declaredIds = declaredProtagonistSpeakerIds(manifest, declared);
    const rows = speakers.filter((entry) => declaredIds.has(entry.speakerId));
    if (rows.length === 0) throw declaredProtagonistWithoutDialogue(declared);
    if (rows.length > 1) {
      throw new Error(
        `The protagonist declared in the script ('${declared}') matches ${rows.length} speaker IDs (${rows.map((entry) => entry.speakerId).join(", ")}). `
        + "Pass --protagonist-speaker-id with one of them before paid generation.",
      );
    }
    return { speakerId: rows[0].speakerId, speakerName: rows[0].speakerName, utterance: rows[0] };
  }
  const marked = speakers.filter((entry) => (
    entry.isProtagonist === true
    || entry.characterRole === "protagonist"
    || /^(?:主人公|protagonist|hero)$/iu.test(String(entry.speakerName || ""))
    || /^(?:protagonist|hero)(?:-|$)/iu.test(String(entry.speakerId || ""))
  ));
  if (marked.length === 1) {
    return { speakerId: marked[0].speakerId, speakerName: marked[0].speakerName, utterance: marked[0] };
  }
  if (speakers.length === 1) {
    return { speakerId: speakers[0].speakerId, speakerName: speakers[0].speakerName, utterance: speakers[0] };
  }
  throw new Error(
    "The protagonist is ambiguous. Pass --protagonist-speaker-id with the protagonist's speaker ID or exact speaker name before paid generation.",
  );
}

/** Keep narration visuals intact while binding every narration line to the protagonist's approved voice. */
export function applyKoyaNarrationVoicePolicy(manifestInput, resolved, options = {}) {
  const manifest = structuredClone(manifestInput);
  const contract = resolved.contract || resolved;
  const rows = narrationRows(manifest);
  if (contract.audio.narrationVoicePolicy !== "protagonist-voice" || rows.length === 0) return manifest;
  const protagonist = resolveKoyaProtagonistSpeaker(manifest, options.protagonistSpeakerId);
  const source = dialogueSpeakerRows(manifest).find((entry) => (
    entry.speakerId === protagonist.speakerId && String(entry.voiceId || "").trim()
  ));
  if (!source) {
    throw new Error(`The protagonist '${protagonist.speakerName}' has no approved voice. Approve the protagonist voice before speech generation.`);
  }
  for (const row of rows) {
    row.voiceProfileId = source.voiceProfileId || "";
    row.voiceId = source.voiceId;
    row.voiceName = source.voiceName || "";
    row.voiceSettings = source.voiceSettings || null;
    row.model = source.model || contract.audio.model;
    row.voiceSourceSpeakerId = protagonist.speakerId;
    row.narrationVoiceRole = "protagonist-inner-voice";
  }
  manifest.production = {
    ...(manifest.production || {}),
    protagonistSpeakerId: protagonist.speakerId,
    protagonistSpeakerName: protagonist.speakerName,
    narrationVoiceBinding: {
      policy: "protagonist-voice",
      protagonistSpeakerId: protagonist.speakerId,
      voiceProfileId: source.voiceProfileId || "",
      voiceId: source.voiceId,
      preserveNarrationVisualStyle: true,
    },
  };
  return manifest;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/**
 * 制作契約の在り処を決める。
 *
 * 契約はジャンル層のもので、**それを読むコードと一緒に配布・更新される**。
 * 運営者のプロジェクトには置かれない（Channel Pack と台本と成果物だけ）。
 * それなのに projectDir から読んでいたので、空の作業フォルダから実行すると
 * 生の ENOENT で止まっていた——運営者が最初の1本で必ず踏む。
 *
 * 解決順:
 *   1. --contract-path の明示指定（ベンチマーク移行用）
 *   2. ランタイム（プラグイン）側の契約。これが既定
 *   3. projectDir 側の契約。移行途中の配置を読めなくしないための後方互換
 *
 * projectDir 側にランタイムと違う契約が残っていたら黙って使わない。
 * 自動更新でランタイムだけが新しくなり、古い契約が居座る形が版ずれの入口。
 */
export async function resolveKoyaMangaContractPath(options = {}) {
  if (String(options.contractPath || "").trim()) {
    return { path: resolve(options.contractPath), source: "explicit", divergence: null };
  }
  const projectDir = resolve(options.projectDir || process.cwd());
  const relative = "config/koya-manga-production-contract.json";
  const runtimePath = join(repositoryRoot, relative);
  const projectPath = join(projectDir, relative);
  const hasRuntime = existsSync(runtimePath);
  const hasProject = existsSync(projectPath);

  if (hasRuntime) {
    let divergence = null;
    if (hasProject && projectPath !== runtimePath) {
      const [a, b] = [readFileSync(runtimePath), readFileSync(projectPath)];
      if (!a.equals(b)) {
        divergence = `プロジェクト側にランタイムと異なる契約が残っている: ${projectPath}（ランタイム側を使う）`;
      }
    }
    return { path: runtimePath, source: "runtime", divergence };
  }
  return { path: projectPath, source: "project", divergence: null };
}

export async function resolveKoyaMangaProductionContract(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  const located = await resolveKoyaMangaContractPath(options);
  const contractPath = located.path;
  const base = await readJson(contractPath);
  let resolvedContract = base;
  let episodeOverridePath = "";
  let episodeOverride = null;
  if (options.overridePath || options.episodeId) {
    episodeOverridePath = resolve(options.overridePath || join(
      projectDir,
      "config/koya-manga-episode-overrides",
      `${options.episodeId}.json`,
    ));
    try {
      episodeOverride = await readJson(episodeOverridePath);
    } catch (error) {
      if (options.overridePath || error?.code !== "ENOENT") throw error;
      episodeOverridePath = "";
    }
  }
  if (episodeOverride) {
    if (episodeOverride.episodeId !== options.episodeId) {
      throw new Error(`Episode override ID mismatch: ${episodeOverride.episodeId} != ${options.episodeId}`);
    }
    if (episodeOverride.contractVersion !== base.version) {
      throw new Error(`Episode override targets ${episodeOverride.contractVersion}; current contract is ${base.version}.`);
    }
    resolvedContract = mergeKnown(base, episodeOverride.override || {});
  }
  const validation = validateKoyaMangaProductionContract(resolvedContract);
  if (!validation.pass) {
    throw new Error(`Invalid Koya contract: ${validation.failures.map((entry) => `${entry.path}: ${entry.message}`).join("; ")}`);
  }
  return {
    contract: resolvedContract,
    digest: koyaContractDigest(resolvedContract),
    contractPath,
    // どこの契約を読んだかを残す。ランタイムとプロジェクトのどちらを
    // 使ったのか分からないと、版ずれが起きたときに辿れない。
    contractSource: located.source,
    contractDivergence: located.divergence,
    episodeOverridePath,
    episodeOverride,
    validation,
  };
}

export function applyKoyaContractToManifest(manifestInput, resolved) {
  const manifest = structuredClone(manifestInput);
  const contract = resolved.contract || resolved;
  const digest = resolved.digest || koyaContractDigest(contract);
  manifest.model = contract.audio.model;
  manifest.manifestSchemaVersion = contract.provenance.manifestSchemaVersion;
  manifest.video = {
    ...(manifest.video || {}),
    width: contract.video.width,
    height: contract.video.height,
    fps: contract.video.fps,
    frameAlignCutDurations: true,
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
    cameraGrammarVersion: contract.camera.grammarVersion,
    cameraOversample: contract.camera.cameraOversample,
    requireSemanticCameraViews: contract.camera.requireSemanticViews,
    requireConstantCameraSpeed: contract.camera.requireConstantSpeed,
    requireWholePageSplitCamera: contract.camera.requireWholePageSplitCamera,
    forbidPushInCameraMotion: contract.camera.forbidPushIn,
    forbidDownwardCameraMotion: contract.camera.forbidDownwardMotion,
    forbidCameraStops: contract.camera.forbidStops,
    forbidRepeatedCameraImages: contract.camera.forbidRepeatedCameraImages,
  };
  if (contract.provenance.forbidLegacyStatusAfterRender) delete manifest.video.statusAfterRender;
  for (const utterance of manifest.utterances || []) utterance.model = contract.audio.model;
  manifest.production = {
    ...(manifest.production || {}),
    channelId: contract.channelId,
    channelVisualProfileId: contract.art.visualProfileId,
    koyaContract: {
      version: contract.version,
      digest,
      narrationVoicePolicy: contract.audio.narrationVoicePolicy,
      preserveNarrationVisualStyle: contract.audio.preserveNarrationVisualStyle,
      qualityReviewVersion: contract.qualityReview.version,
      qualityReviewNotesVersion: contract.qualityReview.reviewNotesVersion,
      requiredAudits: [...contract.requiredAudits],
    },
    pipeline: {
      entrypoint: contract.provenance.officialEntrypoint,
      contractVersion: contract.version,
      contractDigest: digest,
      manifestSchemaVersion: contract.provenance.manifestSchemaVersion,
    },
    dialogueEditorialPolicy: {
      ...(manifest.production?.dialogueEditorialPolicy || {}),
      punctuation: contract.bubbles.stripTerminalJapanesePeriod
        ? "Preserve authored speech punctuation, but omit a terminal Japanese full stop (。) from rendered bubble display text. Preserve questions, exclamations, ellipses, and non-terminal punctuation."
        : "Preserve authored punctuation in rendered bubble display text.",
    },
    bubbleDisplayPolicy: {
      ...(manifest.production?.bubbleDisplayPolicy || {}),
      preserveAuthoredSpeechText: true,
      stripTerminalJapanesePeriod: contract.bubbles.stripTerminalJapanesePeriod === true,
    },
    qualityPolicy: {
      perceptualReviewVersion: contract.qualityReview.version,
      perceptualReviewNotesVersion: contract.qualityReview.reviewNotesVersion,
      userFeedbackOverridesMachinePass: contract.qualityReview.userFeedbackOverridesMachinePass,
      requireEvidenceFileHashes: contract.qualityReview.requireEvidenceFileHashes,
      requireContractDigestBinding: contract.qualityReview.requireContractDigestBinding,
      requireReviewNotesDigestBinding: contract.qualityReview.requireReviewNotesDigestBinding,
      requireEvaluatorProvenance: contract.qualityReview.requireEvaluatorProvenance,
      requireRubricScores: contract.qualityReview.requireRubricScores,
      requireEvidenceMerkleManifest: contract.qualityReview.requireEvidenceMerkleManifest,
      refreshSourceAnnotationsAfterImageChange: contract.art.refreshSourceAnnotationsAfterImageChange,
      requireNaturalAnatomyAndPropScale: contract.art.requireNaturalAnatomyAndPropScale,
      forbidGeneratedPseudoText: contract.art.forbidGeneratedPseudoText,
      forbidContextlessLeadInImages: contract.editorial.forbidContextlessLeadInImages,
      preferMultiUtteranceImageHolds: contract.editorial.preferMultiUtteranceImageHolds,
      requireEditContinuityReview: contract.editorial.requireEditContinuityReview,
      requireDialoguePacingReview: contract.editorial.requireDialoguePacingReview,
      minimumMultiUtteranceImageShare: contract.editorial.minimumMultiUtteranceImageShare,
      minimumMedianImageHoldSeconds: contract.editorial.minimumMedianImageHoldSeconds,
      maximumImageHoldSeconds: contract.editorial.maximumImageHoldSeconds,
      forbidUnassignedCameraShots: contract.editorial.forbidUnassignedCameraShots,
      forbidConditionalSplitPageLeadIns: contract.editorial.forbidConditionalSplitPageLeadIns,
      requireEveryUtteranceAssignedToImage: contract.editorial.requireEveryUtteranceAssignedToImage,
      qualityLoopVersion: contract.qualityLoop.version,
      generatorEvaluatorSeparation: contract.qualityLoop.generatorEvaluatorSeparation,
      requireDistinctEvaluatorContext: contract.qualityLoop.requireDistinctEvaluatorContext,
      requireCompleteRubric: contract.qualityLoop.requireCompleteRubric,
      requireQualityEvidence: contract.qualityLoop.requireEvidence,
      requireVerifiedEvidenceFiles: contract.qualityLoop.requireVerifiedEvidenceFiles,
      requireAtLeastOneCompletedRound: contract.qualityLoop.requireAtLeastOneCompletedRound,
      requirePersistedIncidentLedger: contract.qualityLoop.requirePersistedIncidentLedger,
      qualityLoopLimits: structuredClone(contract.qualityLoop.limits),
      candidateDecision: structuredClone(contract.qualityLoop.candidateDecision),
    },
  };
  if (contract.provenance.forbidAmbiguousProductionVersion) delete manifest.production.version;
  return manifest;
}

export function auditManifestAgainstKoyaContract(manifest, resolved) {
  const contract = resolved.contract || resolved;
  const expectedDigest = resolved.digest || koyaContractDigest(contract);
  const failures = [];
  const check = (condition, id, detail) => {
    if (!condition) failures.push({ id, detail });
  };
  const dialogueAdapter = resolveKoyaDialogueAdapter(contract);
  check(manifest?.model === dialogueAdapter.model, "audio-model", `expected ${dialogueAdapter.model}, got ${manifest?.model}`);
  check(manifest?.video?.bgmVolume === 0 && !manifest?.video?.bgmPath, "bgm-disabled", "BGM must be empty and zero volume");
  check(manifest?.video?.width === contract.video.width && manifest?.video?.height === contract.video.height, "resolution", "resolution differs from contract");
  check(manifest?.video?.fps === contract.video.fps, "fps", "fps differs from contract");
  check(manifest?.video?.cameraGrammarVersion === contract.camera.grammarVersion, "camera-grammar", "camera grammar version differs");
  check(manifest?.video?.forbidPushInCameraMotion === true, "push-in-policy", "push-in policy is not enabled");
  check(manifest?.video?.requireWholePageSplitCamera === true, "split-page-policy", "whole-page split camera policy is not enabled");
  check(!Object.hasOwn(manifest?.video || {}, "statusAfterRender"), "stale-render-status", "video.statusAfterRender is a legacy label and must be removed");
  check(manifest?.production?.channelVisualProfileId === contract.art.visualProfileId, "visual-profile", "channel visual profile differs");
  check(!Object.hasOwn(manifest?.production || {}, "version"), "ambiguous-production-version", "production.version is ambiguous and must be removed");
  check(manifest?.manifestSchemaVersion === contract.provenance.manifestSchemaVersion, "manifest-schema-version", "manifest schema version differs from the contract");
  check(manifest?.production?.pipeline?.entrypoint === contract.provenance.officialEntrypoint, "official-entrypoint", "manifest does not identify the official production entrypoint");
  check(manifest?.production?.pipeline?.contractVersion === contract.version, "pipeline-contract-version", "pipeline contract version differs");
  check(manifest?.production?.pipeline?.contractDigest === expectedDigest, "pipeline-contract-digest", "pipeline contract digest differs");
  check(manifest?.production?.bubbleDisplayPolicy?.preserveAuthoredSpeechText === true, "bubble-authored-text-policy", "authored speech text must remain unchanged");
  check(
    manifest?.production?.bubbleDisplayPolicy?.stripTerminalJapanesePeriod === contract.bubbles.stripTerminalJapanesePeriod,
    "bubble-terminal-period-policy",
    "bubble display punctuation policy differs from the contract",
  );
  check(Boolean(manifest?.production?.provenance?.generator?.id), "generator-id", "manifest must identify the generator");
  check(Boolean(manifest?.production?.provenance?.generator?.contextId), "generator-context-id", "manifest must bind generation to a real Codex task or Claude session");
  check(manifest?.production?.qualityPolicy?.perceptualReviewVersion === contract.qualityReview.version, "quality-review-version", "perceptual review policy differs");
  check(manifest?.production?.qualityPolicy?.perceptualReviewNotesVersion === contract.qualityReview.reviewNotesVersion, "quality-review-notes-version", "perceptual review notes policy differs");
  check(manifest?.production?.qualityPolicy?.userFeedbackOverridesMachinePass === true, "user-feedback-priority", "user feedback must outrank machine pass");
  check(manifest?.production?.qualityPolicy?.requireEvidenceFileHashes === true, "review-evidence-hashes", "perceptual review evidence must be hash-bound");
  check(manifest?.production?.qualityPolicy?.requireContractDigestBinding === true, "review-contract-binding", "perceptual review must bind the contract digest");
  check(manifest?.production?.qualityPolicy?.requireReviewNotesDigestBinding === true, "review-notes-binding", "perceptual review notes must be digest-bound");
  check(manifest?.production?.qualityPolicy?.requireEvaluatorProvenance === true, "reviewer-provenance", "perceptual review must identify its real evaluator context");
  check(manifest?.production?.qualityPolicy?.requireRubricScores === true, "review-rubric-scores", "perceptual review must score the complete rubric");
  check(manifest?.production?.qualityPolicy?.requireEvidenceMerkleManifest === true, "review-evidence-merkle", "final evidence must be Merkle-bound");
  check(manifest?.production?.qualityPolicy?.qualityLoopVersion === contract.qualityLoop.version, "quality-loop-version", "quality loop version differs");
  check(manifest?.production?.qualityPolicy?.generatorEvaluatorSeparation === true, "quality-loop-evaluator-separation", "generator and evaluator must be separated");
  check(manifest?.production?.qualityPolicy?.requireDistinctEvaluatorContext === true, "quality-loop-fresh-context", "evaluator context must differ from generator context");
  check(manifest?.production?.qualityPolicy?.requireCompleteRubric === true, "quality-loop-complete-rubric", "every rubric item must be scored");
  check(manifest?.production?.qualityPolicy?.requireQualityEvidence === true, "quality-loop-evidence", "quality decisions require evidence");
  check(manifest?.production?.qualityPolicy?.requireVerifiedEvidenceFiles === true, "quality-loop-verified-evidence", "quality evidence must match files on disk");
  check(manifest?.production?.qualityPolicy?.requireAtLeastOneCompletedRound === true, "quality-loop-round", "quality loop must complete at least one round");
  check(manifest?.production?.qualityPolicy?.requirePersistedIncidentLedger === true, "quality-loop-incidents", "quality incidents must be persisted");
  check(
    JSON.stringify(manifest?.production?.qualityPolicy?.qualityLoopLimits || {}) === JSON.stringify(contract.qualityLoop.limits),
    "quality-loop-limits",
    "quality loop limits differ from the contract",
  );
  check(
    JSON.stringify(manifest?.production?.qualityPolicy?.candidateDecision || {}) === JSON.stringify(contract.qualityLoop.candidateDecision),
    "candidate-decision-policy",
    "candidate decision policy differs from the contract",
  );
  check(manifest?.production?.qualityPolicy?.refreshSourceAnnotationsAfterImageChange === true, "annotation-refresh-policy", "source annotations must be refreshed after image changes");
  check(manifest?.production?.qualityPolicy?.requireNaturalAnatomyAndPropScale === true, "anatomy-prop-policy", "anatomy and prop scale review is required");
  check(manifest?.production?.qualityPolicy?.forbidGeneratedPseudoText === true, "pseudo-text-policy", "generated pseudo text must be rejected");
  check(manifest?.production?.koyaContract?.digest === expectedDigest, "contract-digest", "manifest does not carry the resolved contract digest");
  check(
    JSON.stringify([...(manifest?.production?.koyaContract?.requiredAudits || [])].sort())
      === JSON.stringify([...contract.requiredAudits].sort()),
    "required-audits",
    "manifest audit list differs from the resolved contract",
  );
  check((manifest?.utterances || []).every((entry) => entry.model === dialogueAdapter.model), "utterance-models", `one or more utterances do not use ${dialogueAdapter.model}`);
  if (contract.audio.narrationVoicePolicy === "protagonist-voice") {
    const rows = narrationRows(manifest);
    if (rows.length > 0) {
      let protagonist = null;
      try {
        protagonist = resolveKoyaProtagonistSpeaker(manifest);
      } catch (error) {
        check(false, "protagonist-speaker", error.message);
      }
      const source = protagonist && dialogueSpeakerRows(manifest).find((entry) => (
        entry.speakerId === protagonist.speakerId && String(entry.voiceId || "").trim()
      ));
      check(Boolean(source), "protagonist-voice", "the protagonist has no approved voice");
      check(
        Boolean(source) && rows.every((entry) => (
          entry.voiceId === source.voiceId
          && entry.voiceProfileId === source.voiceProfileId
          && entry.voiceSourceSpeakerId === protagonist.speakerId
          && (!entry.audio?.voiceId || entry.audio.voiceId === source.voiceId)
        )),
        "narration-voice-is-protagonist",
        "every narration line must use the protagonist's exact approved voice while retaining narration visuals",
      );
    }
  }
  if (contract.audio.narrationVoicePolicy === "approved-original-narrator") {
    const narrationRows = (manifest?.utterances || []).filter((entry) => entry.speakerId === "narration" || entry.preset === "narration");
    check(
      narrationRows.length > 0 && narrationRows.every((entry) => (
        entry.voiceId === contract.audio.narrationVoiceId
        && (!entry.audio?.voiceId || entry.audio.voiceId === contract.audio.narrationVoiceId)
      )),
      "narration-voice-lock",
      `narration must use approved voice ${contract.audio.narrationVoiceId}`,
    );
  }
  return { version: "koya-contract-manifest-audit-v1", pass: failures.length === 0, failures, expectedDigest };
}
