import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";

const moduleDir = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_KOYA_CONTRACT_PATH = resolve(moduleDir, "../config/koya-manga-production-contract.json");
export const DEFAULT_KOYA_CONTRACT_SCHEMA_PATH = resolve(moduleDir, "../config/koya-manga-production-contract.schema.json");
const koyaContractSchema = JSON.parse(readFileSync(DEFAULT_KOYA_CONTRACT_SCHEMA_PATH, "utf8"));
const validateContractSchema = new Ajv({ allErrors: true, strict: true }).compile(koyaContractSchema);
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
  "stt-verification",
  "audio-onset",
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
  requireValue(failures, contract?.audio?.model === "eleven_v3", "audio.model", "must use eleven_v3");
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
  requireValue(failures, contract?.qualityReview?.version === "koya-agent-perceptual-signoff-v3", "qualityReview.version", "must require perceptual signoff v3");
  requireValue(failures, contract?.qualityReview?.reviewNotesVersion === "koya-perceptual-review-notes-v2", "qualityReview.reviewNotesVersion", "must require perceptual review notes v2");
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
  requireValue(failures, contract?.provenance?.officialEntrypoint === "scripts/koya-manga-video.mjs", "provenance.officialEntrypoint", "must use the official CLI");
  requireValue(failures, contract?.provenance?.forbidLegacyStatusAfterRender === true, "provenance.forbidLegacyStatusAfterRender", "must remove stale render labels");
  requireValue(failures, contract?.provenance?.forbidAmbiguousProductionVersion === true, "provenance.forbidAmbiguousProductionVersion", "must remove ambiguous production versions");
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

/** Resolve the story protagonist without silently guessing in a multi-character episode. */
export function resolveKoyaProtagonistSpeaker(manifest, requestedSpeaker = "") {
  const rows = dialogueSpeakerRows(manifest);
  const bySpeaker = new Map();
  for (const row of rows) {
    if (!bySpeaker.has(row.speakerId)) bySpeaker.set(row.speakerId, row);
  }
  const speakers = [...bySpeaker.values()];
  const requested = normalizeSpeakerToken(
    requestedSpeaker
      || manifest?.production?.protagonistSpeakerId
      || manifest?.story?.protagonistSpeakerId,
  );
  if (requested) {
    const matches = speakers.filter((entry) => [entry.speakerId, entry.speakerName]
      .map(normalizeSpeakerToken)
      .includes(requested));
    if (matches.length !== 1) {
      throw new Error(`Protagonist '${requestedSpeaker || requested}' does not uniquely match a dialogue speaker.`);
    }
    return { speakerId: matches[0].speakerId, speakerName: matches[0].speakerName, utterance: matches[0] };
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

export async function resolveKoyaMangaProductionContract(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  const contractPath = resolve(options.contractPath || join(projectDir, "config/koya-manga-production-contract.json"));
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
      if (options.overridePath) throw error;
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
    qualityPolicy: {
      perceptualReviewVersion: contract.qualityReview.version,
      perceptualReviewNotesVersion: contract.qualityReview.reviewNotesVersion,
      userFeedbackOverridesMachinePass: contract.qualityReview.userFeedbackOverridesMachinePass,
      requireEvidenceFileHashes: contract.qualityReview.requireEvidenceFileHashes,
      requireContractDigestBinding: contract.qualityReview.requireContractDigestBinding,
      requireReviewNotesDigestBinding: contract.qualityReview.requireReviewNotesDigestBinding,
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
  check(manifest?.model === "eleven_v3", "audio-model", `expected eleven_v3, got ${manifest?.model}`);
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
  check(manifest?.production?.qualityPolicy?.perceptualReviewVersion === contract.qualityReview.version, "quality-review-version", "perceptual review policy differs");
  check(manifest?.production?.qualityPolicy?.perceptualReviewNotesVersion === contract.qualityReview.reviewNotesVersion, "quality-review-notes-version", "perceptual review notes policy differs");
  check(manifest?.production?.qualityPolicy?.userFeedbackOverridesMachinePass === true, "user-feedback-priority", "user feedback must outrank machine pass");
  check(manifest?.production?.qualityPolicy?.requireEvidenceFileHashes === true, "review-evidence-hashes", "perceptual review evidence must be hash-bound");
  check(manifest?.production?.qualityPolicy?.requireContractDigestBinding === true, "review-contract-binding", "perceptual review must bind the contract digest");
  check(manifest?.production?.qualityPolicy?.requireReviewNotesDigestBinding === true, "review-notes-binding", "perceptual review notes must be digest-bound");
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
  check((manifest?.utterances || []).every((entry) => entry.model === "eleven_v3"), "utterance-models", "one or more utterances do not use eleven_v3");
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
