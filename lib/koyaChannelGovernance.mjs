import { execFile as execFileCallback } from "node:child_process";
import { channelPackRoots, resolveChannelPackPath } from "./channelPackResolver.mjs";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { getImageDimensionsFromBuffer, resolveCanvasDir, writeJsonAtomic } from "./canvasScene.mjs";
import { withCanvasFileLock } from "./canvasFileLock.mjs";
import { validateCandidateDiversityReview, validateCharacterStylingSpec } from "./characterPipeline.mjs";
import { readCharacterRegistry, writeCharacterRegistry } from "./characterRegistry.mjs";
import { generateImageMedia } from "./mediaGeneration.mjs";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(moduleDir, "..");
const execFile = promisify(execFileCallback);

export const KOYA_STORY_REVIEW_VERSION = "koya-story-review-v1";
export const KOYA_LOCATION_ANCHOR_REVIEW_VERSION = "koya-location-anchor-review-v1";
export const KOYA_LOCATION_REVIEW_VERSION = "koya-location-review-v3";
export const KOYA_LOCATION_GENERATION_MANIFEST_VERSION = "koya-location-generation-v2";
export const KOYA_THUMBNAIL_PLAN_VERSION = "koya-thumbnail-plan-v1";

const AUTHORITY_FILES = Object.freeze({
  show: "config/koya-show-bible.json",
  locations: "config/koya-location-bible.json",
  thumbnail: "config/koya-thumbnail-contract.json",
});

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function validIsoDate(value) {
  const text = nonEmpty(value);
  return Boolean(text && /^\d{4}-\d{2}-\d{2}T/u.test(text) && Number.isFinite(Date.parse(text)));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function readJsonStrict(path) {
  const source = await readFile(path, "utf8");
  if (!source.trim()) throw new Error(`Koya authority file is empty: ${path}`);
  try { return JSON.parse(source); } catch (error) {
    throw new Error(`Koya authority JSON is invalid (${path}): ${error.message}`);
  }
}

function assertVersion(value, expected, label) {
  if (value?.version !== expected) throw new Error(`${label} version must be ${expected}.`);
}

export function validateKoyaShowBible(showBible) {
  assertVersion(showBible, "koya-show-bible-v1", "Show bible");
  if (!nonEmpty(showBible?.channel?.name)) throw new Error("Show bible channel.name is required.");
  if (!nonEmpty(showBible?.world?.town) || !nonEmpty(showBible?.world?.homeBase)) {
    throw new Error("Show bible fictional town and home base are required.");
  }
  const cast = Array.isArray(showBible?.cast) ? showBible.cast : [];
  if (cast.length === 0) throw new Error("Show bible cast must not be empty.");
  const ids = new Set();
  for (const member of cast) {
    if (!nonEmpty(member?.id) || !nonEmpty(member?.name) || !nonEmpty(member?.role) || !nonEmpty(member?.designStatus)) {
      throw new Error("Every show-bible cast member requires id, name, role, and designStatus.");
    }
    if (ids.has(member.id)) throw new Error(`Duplicate show-bible cast id: ${member.id}`);
    ids.add(member.id);
    const referenceRoles = Array.isArray(member.requiredReferenceRoles) ? member.requiredReferenceRoles : [];
    if (referenceRoles.some((role) => !["identity-face", "turnaround", "expression", "eye-open", "outfit"].includes(role))) {
      throw new Error(`${member.id}.requiredReferenceRoles contains an unsupported role.`);
    }
    if (member.requiredReferenceRoles?.includes("outfit") && (!Array.isArray(member.outfitStages) || member.outfitStages.length < 2)) {
      throw new Error(`${member.id} requires at least two explicit outfitStages when outfit evidence is mandatory.`);
    }
    if (Array.isArray(member.outfitStages)) {
      const stageIds = member.outfitStages.map((stage) => nonEmpty(stage?.id));
      if (stageIds.some((id) => !id) || new Set(stageIds).size !== stageIds.length
        || member.outfitStages.some((stage) => !nonEmpty(stage?.label) || !nonEmpty(stage?.description))) {
        throw new Error(`${member.id}.outfitStages require unique ids, labels, and descriptions.`);
      }
    }
    const declaredStylingSpecs = Array.isArray(member.stylingSpecPaths) && member.stylingSpecPaths.length > 0
      ? member.stylingSpecPaths
      : [member.stylingSpecPath].filter(Boolean);
    if (declaredStylingSpecs.length > 0 && !/^[A-E]$/u.test(nonEmpty(member.selectedBaseLabel))) {
      throw new Error(`${member.id}.selectedBaseLabel A..E is required when styling rounds branch from a human-selected candidate.`);
    }
    if (member.designStatus === "human-selected-awaiting-identity-pack" && !/^[A-E]$/u.test(nonEmpty(member.selectedLabel))) {
      throw new Error(`${member.id}.selectedLabel A..E is required for a human-selected design.`);
    }
  }
  const horo = cast.find((member) => member.id === "horo");
  const tatsu = cast.find((member) => member.id === "tatsu");
  const ema = cast.find((member) => member.id === "ema");
  if (horo?.requiredEveryEpisode !== true || !horo?.requiredReferenceRoles?.includes("eye-open")) throw new Error("Show bible must require Horo in every episode with an eye-open asset.");
  if (!tatsu?.requiredReferenceRoles?.includes("eye-open")) throw new Error("Show bible must require Tatsu's eye-open asset.");
  if (ema?.episodeRoleSelectionRequired !== true || !ema?.requiredReferenceRoles?.includes("outfit")) throw new Error("Show bible must require Ema's episode role and outfit evidence.");
  const reversal = showBible?.storyGrammar?.reversal;
  if (!Array.isArray(reversal) || reversal.length !== 4) throw new Error("Show bible requires the four-step reversal grammar.");
  if (showBible?.storyReview?.version !== KOYA_STORY_REVIEW_VERSION
    || showBible?.storyReview?.bindToExactScriptSha256 !== true
    || showBible?.storyReview?.requireIndependentReviewerContext !== true) {
    throw new Error("Show bible must require the SHA-bound independent story review.");
  }
  const rosterReview = showBible?.rosterReview;
  if (rosterReview?.version !== "koya-character-roster-review-v1"
    || rosterReview?.requiredBeforeEpisodeProduction !== true
    || rosterReview?.requiredMemberCount !== 11
    || rosterReview?.requiredPairCount !== 55
    || rosterReview?.requireIndependentReviewerContext !== true
    || rosterReview?.requireOriginalScaleInspection !== true
    || rosterReview?.requireThumbnailScaleInspection !== true
    || !["silhouetteDistinct", "faceAgeRoleDistinct", "hairOutfitColorNotConfusing", "thumbnailScaleDistinct"].every((key) => rosterReview?.requiredPairChecks?.includes(key))) {
    throw new Error("Show bible must require the complete SHA-bound independent 11-member roster review before episode production.");
  }
  return { pass: true, castCount: cast.length, version: showBible.version };
}

function showBibleMemberMatches(member, value) {
  const id = nonEmpty(value?.id ?? value?.speakerId);
  const name = nonEmpty(value?.name ?? value?.speakerName ?? value);
  return [member.id, member.name, member.hiddenName].filter(Boolean).includes(id)
    || [member.id, member.name, member.hiddenName].filter(Boolean).includes(name);
}

function approvedRegistryCharacterForMember(registry, member) {
  return (registry?.characters || []).find((character) => (
    character?.status === "approved"
    && character?.kind === "character"
    && (
      character.id === member.id
      || character.name === member.name
      || character.name === member.hiddenName
      || (character.aliases || []).some((alias) => alias === member.name || alias === member.hiddenName)
    )
  )) || null;
}

export function auditKoyaFixedCastReadiness(options = {}) {
  const showBible = options.showBible;
  validateKoyaShowBible(showBible);
  const parsed = options.parsed;
  if (!parsed || !Array.isArray(parsed.utterances)) throw new Error("Parsed manga script is required for Koya fixed-cast readiness.");
  const declaredCast = Array.isArray(options.characterBible?.cast)
    ? options.characterBible.cast
    : Array.isArray(options.declaredCast) ? options.declaredCast : [];
  const activeIds = new Set();
  for (const member of showBible.cast || []) {
    if (parsed.utterances.some((utterance) => showBibleMemberMatches(member, utterance))) activeIds.add(member.id);
    if (declaredCast.some((entry) => showBibleMemberMatches(member, entry))) activeIds.add(member.id);
  }
  const active = options.enforce === true || activeIds.size > 0;
  const failures = [];
  if (active && showBible?.rosterReview?.requiredBeforeEpisodeProduction === true && options.rosterReviewAudit?.pass !== true) {
    failures.push(`Fixed-cast roster review is not approved: ${(options.rosterReviewAudit?.failures || ["review missing"]).join("; ")}`);
  }
  if (active) {
    for (const member of showBible.cast || []) {
      if (member.requiredEveryEpisode === true && !activeIds.has(member.id)) failures.push(`${member.name} (${member.id}) must be declared in every episode, including silent appearances.`);
    }
  }
  const rows = [];
  for (const member of (showBible.cast || []).filter((entry) => activeIds.has(entry.id))) {
    const declared = declaredCast.find((entry) => showBibleMemberMatches(member, entry));
    const registered = approvedRegistryCharacterForMember(options.registry, member);
    const requiredRoles = Array.isArray(member.requiredReferenceRoles) && member.requiredReferenceRoles.length > 0
      ? member.requiredReferenceRoles
      : ["identity-face", "turnaround", "expression"];
    const availableRoles = new Set((registered?.referenceAssets || []).map((asset) => asset.role));
    if (member.designStatus === "on-hold") failures.push(`${member.name} is on hold in the show bible and cannot enter an episode.`);
    if (!registered) failures.push(`${member.name} (${member.id}) is not an approved registered fixed character; current designStatus=${member.designStatus}. Do not generate an episode-local replacement.`);
    else {
      for (const role of requiredRoles) if (!availableRoles.has(role)) failures.push(`${member.name} is missing required approved reference role '${role}'.`);
      if (!nonEmpty(registered?.approval?.identityReviewPath) || !/^[a-f0-9]{64}$/u.test(nonEmpty(registered?.approval?.identityReviewSha256))) failures.push(`${member.name} is missing SHA-bound identity review provenance.`);
    }
    if (member.episodeRoleSelectionRequired === true && !["ally", "antagonist"].includes(nonEmpty(declared?.episodeRole))) {
      failures.push(`${member.name} requires characterBible.cast[].episodeRole = ally or antagonist for this episode.`);
    }
    rows.push({
      id: member.id,
      name: member.name,
      designStatus: member.designStatus,
      declared: Boolean(declared),
      registeredCharacterId: registered?.id || "",
      requiredReferenceRoles: requiredRoles,
      availableReferenceRoles: [...availableRoles],
      episodeRole: nonEmpty(declared?.episodeRole),
    });
  }
  return { version: "koya-fixed-cast-readiness-v1", active, pass: failures.length === 0, activeCastIds: [...activeIds], rows, failures };
}

export async function auditKoyaCharacterBootstrap(options = {}) {
  const showBible = options.showBible;
  validateKoyaShowBible(showBible);
  const workflows = Array.isArray(options.workflowStore?.workflows) ? options.workflowStore.workflows : [];
  const rows = [];
  const blockers = [];
  for (const member of showBible.cast || []) {
    const registered = approvedRegistryCharacterForMember(options.registry, member);
    const matches = workflows.flatMap((workflow) => (workflow.cast || [])
      .filter((cast) => showBibleMemberMatches(member, cast))
      .map((cast) => ({ workflow, cast })))
      .sort((left, right) => String(right.workflow.updatedAt || "").localeCompare(String(left.workflow.updatedAt || "")));
    const latest = matches[0] || null;
    const baseLabel = nonEmpty(member.selectedBaseLabel || member.selectedLabel);
    const baseCandidate = latest?.cast?.candidates?.find((candidate) => candidate.blindLabel === baseLabel) || null;
    const baseAssetExists = Boolean(baseCandidate?.assetFile && await exists(baseCandidate.assetFile));
    let candidateReviewPass = false;
    let candidateReviewFailure = "";
    const candidateReviewPath = nonEmpty(latest?.cast?.candidateReviewPath || latest?.cast?.candidateReviewDraftPath);
    if (latest && candidateReviewPath) {
      try {
        const result = await validateCandidateDiversityReview({
          reviewPath: candidateReviewPath,
          workflow: latest.workflow,
          cast: latest.cast,
        });
        candidateReviewPass = result.review?.pass === true;
      } catch (error) {
        candidateReviewFailure = error.message;
      }
    }
    const declaredSpecs = Array.isArray(member.stylingSpecPaths) && member.stylingSpecPaths.length > 0
      ? member.stylingSpecPaths
      : [member.stylingSpecPath].filter(Boolean);
    const selectedRounds = (latest?.cast?.stylingVariationRounds || []).filter((round) => round.status === "selected");
    const activeStylingRound = [...(latest?.cast?.stylingVariationRounds || [])].reverse().find((round) => (
      ["planned", "generating", "awaiting-review", "reviewed", "awaiting-selection"].includes(round.status)
    ));
    const requiredRoles = Array.isArray(member.requiredReferenceRoles) && member.requiredReferenceRoles.length > 0
      ? member.requiredReferenceRoles
      : ["identity-face", "turnaround", "expression"];
    const availableRoles = [...new Set((registered?.referenceAssets || []).map((asset) => asset.role))];
    let stage = "identity-pack-required";
    let nextAction = "Generate and independently review the real identity pack.";
    if (member.designStatus === "on-hold") {
      stage = "on-hold";
      nextAction = "Wait for an explicit human design decision; do not generate or register.";
    } else if (registered) {
      stage = requiredRoles.every((role) => availableRoles.includes(role)) ? "approved" : "registered-evidence-incomplete";
      nextAction = stage === "approved" ? "No bootstrap action." : "Repair the approved registry evidence before episode use.";
    } else if (!latest) {
      stage = "workflow-missing";
      nextAction = "Create or migrate the fixed-cast workflow without selecting a replacement identity.";
    } else if (!baseLabel) {
      stage = candidateReviewPass ? "human-candidate-selection-required" : "candidate-review-required";
      nextAction = candidateReviewPass
        ? "A human must select one reviewed anonymous candidate and record the concrete reason."
        : "Complete the independent original-scale candidate diversity review before any selection.";
    } else if (!baseCandidate || !baseAssetExists) {
      stage = "selected-base-missing";
      nextAction = `Restore the human-selected anonymous base ${baseLabel || "A..E"} and its actual image bytes.`;
    } else if (!candidateReviewPass) {
      stage = "candidate-review-required";
      nextAction = "Complete the independent original-scale candidate diversity review.";
    } else if (selectedRounds.length < declaredSpecs.length) {
      stage = activeStylingRound ? `styling-${activeStylingRound.status}` : "styling-round-required";
      nextAction = activeStylingRound
        ? `Resume or finish styling round ${activeStylingRound.id}.`
        : `Run declared styling spec ${declaredSpecs[selectedRounds.length]}.`;
    } else if (latest.cast.status === "awaiting-identity-qa" || latest.cast.identityReviewDraftPath) {
      stage = "identity-review-required";
      const reviewParts = ["eight-view turnaround", "twelve-cell expression"];
      if (requiredRoles.includes("outfit")) reviewParts.push("every required outfit stage");
      if (requiredRoles.includes("eye-open")) reviewParts.push("eye-open differential");
      nextAction = `Complete independent original-scale QA for ${reviewParts.join(", ")}, then register.`;
    }
    const blocking = !["approved", "on-hold"].includes(stage);
    if (blocking) blockers.push(`${member.name}: ${stage}`);
    rows.push({
      id: member.id,
      name: member.name,
      designStatus: member.designStatus,
      selectedBaseLabel: baseLabel,
      workflowId: latest?.workflow?.id || "",
      workflowCastId: latest?.cast?.id || "",
      workflowStatus: latest?.cast?.status || "",
      baseCandidateAsset: baseCandidate?.assetFile || "",
      baseAssetExists,
      candidateReviewPath,
      candidateReviewPass,
      candidateReviewFailure,
      declaredStylingSpecCount: declaredSpecs.length,
      selectedStylingRoundCount: selectedRounds.length,
      activeStylingRound: activeStylingRound?.id || "",
      registeredCharacterId: registered?.id || "",
      requiredReferenceRoles: requiredRoles,
      availableReferenceRoles: availableRoles,
      stage,
      nextAction,
    });
  }
  return {
    version: "koya-character-bootstrap-status-v1",
    pass: blockers.length === 0,
    approvedCount: rows.filter((row) => row.stage === "approved").length,
    onHoldCount: rows.filter((row) => row.stage === "on-hold").length,
    blockingCount: blockers.length,
    rows,
    blockers,
  };
}

export function validateKoyaLocationBible(locationBible) {
  assertVersion(locationBible, "koya-location-bible-v1", "Location bible");
  if (locationBible?.reviewContract?.version !== KOYA_LOCATION_REVIEW_VERSION
    || locationBible?.reviewContract?.anchorReviewVersion !== KOYA_LOCATION_ANCHOR_REVIEW_VERSION
    || locationBible?.reviewContract?.generationManifestVersion !== KOYA_LOCATION_GENERATION_MANIFEST_VERSION
    || locationBible?.reviewContract?.requireGenerationManifestSha256 !== true
    || locationBible?.reviewContract?.requireAnchorReviewBeforeContinuity !== true
    || locationBible?.reviewContract?.requireIndependentReviewerContext !== true
    || locationBible?.reviewContract?.requireDistinctSha256PerBoard !== true) {
    throw new Error("Location bible must require independent, distinct-SHA board review.");
  }
  const locations = Array.isArray(locationBible?.locations) ? locationBible.locations : [];
  if (locations.length === 0) throw new Error("Location bible must contain locations.");
  const ids = new Set();
  for (const location of locations) {
    if (!nonEmpty(location?.id) || !nonEmpty(location?.name)) throw new Error("Every location requires id and name.");
    if (ids.has(location.id)) throw new Error(`Duplicate Koya location id: ${location.id}`);
    ids.add(location.id);
    if (!Array.isArray(location.requiredBoards) || location.requiredBoards.length !== 4) {
      throw new Error(`${location.id} must define exactly four required boards.`);
    }
    if (!Array.isArray(location.generationRules) || location.generationRules.length === 0) {
      throw new Error(`${location.id} must define generation rules.`);
    }
  }
  return { pass: true, locationCount: locations.length, version: locationBible.version };
}

export function validateKoyaThumbnailContract(contract) {
  assertVersion(contract, "koya-thumbnail-contract-v1", "Thumbnail contract");
  if (contract?.canvas?.width !== 1280 || contract?.canvas?.height !== 720) {
    throw new Error("Koya thumbnail canvas must be 1280x720.");
  }
  if (contract?.sourcePolicy?.dedicatedThumbnailArtworkRequired !== true
    || contract?.sourcePolicy?.mainVideoFrameReuseForbidden !== true) {
    throw new Error("Koya thumbnail contract must require dedicated, non-reused artwork.");
  }
  if (contract?.copy?.band?.lines !== 2 || contract?.copy?.band?.maxCharactersPerLine !== 15) {
    throw new Error("Koya thumbnail band must remain two lines of at most 15 characters each.");
  }
  if (contract?.copy?.approvalBinding?.requireCopySha256 !== true
    || !(Number(contract?.sourcePolicy?.normalizedGray32MaximumReuseDistance) > 0)) {
    throw new Error("Koya thumbnail contract must bind copy approval and perceptual source-reuse detection.");
  }
  return { pass: true, version: contract.version, status: contract.status };
}

export async function readKoyaChannelAuthority(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  const runtimeRoot = resolve(options.runtimeRoot || repositoryRoot);
  // Channel Pack は projectDir 直下ではなく channel-packs/<id>/ に置く。
  // このリポジトリは PUBLIC なプラグイン配布物なので、チャンネル固有の
  // 番組設定を追跡しない。解決層が pack → 従来パスの順に探す。
  const projectPaths = Object.fromEntries(
    Object.entries(AUTHORITY_FILES).map(([key, path]) => [key, resolveChannelPackPath(projectDir, path)]),
  );
  const present = await Promise.all(Object.values(projectPaths).map(exists));
  if (present.some(Boolean) && !present.every(Boolean)) {
    throw new Error("Koya project authority is partial. Restore or provide all three show/location/thumbnail files before production.");
  }
  const source = present.every(Boolean) ? "project" : "runtime-template";
  const root = source === "project" ? projectDir : runtimeRoot;
  const paths = Object.fromEntries(Object.entries(AUTHORITY_FILES).map(([key, path]) => [key, resolveChannelPackPath(root, path)]));
  const [showBible, locationBible, thumbnailContract] = await Promise.all([
    readJsonStrict(paths.show),
    readJsonStrict(paths.locations),
    readJsonStrict(paths.thumbnail),
  ]);
  const validation = {
    show: validateKoyaShowBible(showBible),
    locations: validateKoyaLocationBible(locationBible),
    thumbnail: validateKoyaThumbnailContract(thumbnailContract),
  };
  const stylingSpecs = [];
  for (const member of showBible.cast || []) {
    const primary = nonEmpty(member.stylingSpecPath);
    const sequence = Array.isArray(member.stylingSpecPaths) ? member.stylingSpecPaths.map(nonEmpty).filter(Boolean) : [];
    if (sequence.length > 0 && primary !== sequence[0]) {
      throw new Error(`${member.id}.stylingSpecPaths must start with stylingSpecPath so attribute rounds have an explicit order.`);
    }
    const declaredSequence = sequence.length > 0 ? sequence : [primary].filter(Boolean);
    const declarations = [...new Set(declaredSequence)];
    if (declarations.length !== declaredSequence.length) {
      throw new Error(`${member.id} contains duplicate styling spec declarations.`);
    }
    for (const relativePath of declarations) {
      if (isAbsolute(relativePath)) throw new Error(`${member.id} styling spec path must be project-relative: ${relativePath}`);
      // styling spec は Channel Pack 側にある。宣言は project-relative の
      // ままにして、解決だけ pack を見る——宣言に絶対パスを許すと、
      // 脱出検査の意味が無くなるため。
      const absolutePath = resolveChannelPackPath(root, relativePath);
      const packRoots = channelPackRoots(root);
      if (!inside(root, absolutePath) && !packRoots.some((r) => inside(r, absolutePath))) {
        throw new Error(`${member.id} styling spec path escapes the authority root: ${relativePath}`);
      }
      const spec = await readJsonStrict(absolutePath);
      const checked = validateCharacterStylingSpec(spec);
      if (checked.characterId !== member.id) throw new Error(`${relativePath} belongs to ${checked.characterId}, not show-bible cast ${member.id}.`);
      stylingSpecs.push({ characterId: member.id, relativePath, path: absolutePath, spec, validation: checked });
    }
  }
  validation.styling = { pass: true, specCount: stylingSpecs.length, sequenceCount: (showBible.cast || []).filter((member) => Array.isArray(member.stylingSpecPaths) && member.stylingSpecPaths.length > 1).length };
  return { projectDir, root, source, paths, showBible, locationBible, thumbnailContract, stylingSpecs, validation };
}

function castMemberForSpeaker(showBible, utterance) {
  const speaker = nonEmpty(utterance?.speakerName);
  const speakerId = nonEmpty(utterance?.speakerId);
  return (showBible.cast || []).find((member) => (
    member.id === speakerId || member.id === speaker || member.name === speaker || member.hiddenName === speaker
  )) || null;
}

function storyReviewFailure(failures, condition, message) {
  if (!condition) failures.push(message);
}

function normalizedJapaneseLength(value) {
  return Array.from(nonEmpty(value).replace(/[\s　]/gu, "")).length;
}

function alcoholHits(text, terms) {
  const source = String(text || "");
  return terms.flatMap((term) => {
    const matches = source.match(new RegExp(term, "gu"));
    return matches ? Array(matches.length).fill(term) : [];
  });
}

export function auditKoyaStory(options = {}) {
  const showBible = options.showBible;
  validateKoyaShowBible(showBible);
  const parsed = options.parsed;
  if (!parsed || !Array.isArray(parsed.utterances)) throw new Error("Parsed manga script is required for Koya story audit.");
  const scriptText = String(options.scriptText || "");
  const scriptSha256 = sha256(scriptText);
  const fixedRows = parsed.utterances
    .map((utterance) => ({ utterance, cast: castMemberForSpeaker(showBible, utterance) }))
    .filter((row) => row.cast);
  const fixedCastIds = [...new Set(fixedRows.map((row) => row.cast.id))];
  const declaredCast = new Set((options.declaredCast || []).map(nonEmpty).filter(Boolean));
  const declaredFixedCastIds = (showBible.cast || [])
    .filter((member) => declaredCast.has(member.id) || declaredCast.has(member.name) || declaredCast.has(member.hiddenName))
    .map((member) => member.id);
  const active = options.enforce === true || fixedCastIds.length > 0 || declaredFixedCastIds.length > 0;
  const terms = Array.isArray(showBible?.channel?.alcoholLexicon)
    ? showBible.channel.alcoholLexicon.map(nonEmpty).filter(Boolean)
    : ["日本酒", "焼酎", "ビール", "ワイン", "飲酒", "泥酔", "酒", "呑"];
  const titleHits = alcoholHits(options.title || parsed.title, terms);
  const scriptHits = alcoholHits(scriptText, terms);
  const warnings = [];
  if (titleHits.length > 1) warnings.push(`Title contains ${titleHits.length} alcohol-keyword hits; restrained policy expects at most one.`);
  if (scriptHits.length > Math.max(3, Math.ceil(parsed.utterances.length * 0.08))) {
    warnings.push(`Script contains ${scriptHits.length} alcohol-keyword hits; confirm alcohol is not the narrative hook.`);
  }
  if (!active) {
    return {
      version: "koya-story-audit-v1",
      pass: true,
      active: false,
      scriptSha256,
      fixedCastIds,
      declaredFixedCastIds,
      warnings,
      failures: [],
      reason: "No Koya fixed cast was detected or declared; legacy/non-show script compatibility mode.",
    };
  }

  const failures = [];
  const review = options.storyReview && typeof options.storyReview === "object" ? options.storyReview : null;
  storyReviewFailure(failures, review, `A ${KOYA_STORY_REVIEW_VERSION} file is required before Koya fixed-cast production.`);
  if (!review) return { version: "koya-story-audit-v1", pass: false, active, scriptSha256, fixedCastIds, declaredFixedCastIds, warnings, failures };
  storyReviewFailure(failures, review.version === KOYA_STORY_REVIEW_VERSION, `Story review version must be ${KOYA_STORY_REVIEW_VERSION}.`);
  storyReviewFailure(failures, review.scriptSha256 === scriptSha256, "Story review scriptSha256 does not match the exact script.");
  storyReviewFailure(failures, nonEmpty(review?.reviewer?.host) && nonEmpty(review?.reviewer?.id) && nonEmpty(review?.reviewer?.contextId), "Story review requires reviewer.host, reviewer.id, and reviewer.contextId.");
  storyReviewFailure(failures, validIsoDate(review?.reviewedAt), "Story review requires a valid ISO-8601 reviewedAt.");
  const generatorContextId = nonEmpty(options?.generatorProvenance?.contextId);
  if (generatorContextId) {
    storyReviewFailure(failures, nonEmpty(review?.reviewer?.contextId) !== generatorContextId, "Story review must come from a context different from the generator task/session.");
  }
  storyReviewFailure(failures, nonEmpty(review?.protagonistSpeakerId), "Story review requires protagonistSpeakerId.");
  const byId = new Map(parsed.utterances.map((utterance, index) => [utterance.id, { ...utterance, sequenceIndex: index }]));
  const beatNames = ["attack1", "attack2", "attack3", "ibukiSignal", "evidence", "protagonistFinish"];
  const beats = beatNames.map((name) => ({ name, id: nonEmpty(review?.beats?.[name]), row: byId.get(nonEmpty(review?.beats?.[name])) }));
  for (const beat of beats) storyReviewFailure(failures, beat.id && beat.row, `Story review beat '${beat.name}' must name a real utterance ID.`);
  const validBeatRows = beats.filter((beat) => beat.row);
  storyReviewFailure(
    failures,
    validBeatRows.length === beatNames.length && validBeatRows.every((beat, index) => index === 0 || beat.row.sequenceIndex > validBeatRows[index - 1].row.sequenceIndex),
    "Story review beats must be unique and ordered: attack1 -> attack2 -> attack3 -> Ibuki signal -> evidence -> protagonist finish.",
  );
  const ibukiBeat = beats.find((beat) => beat.name === "ibukiSignal")?.row;
  storyReviewFailure(failures, castMemberForSpeaker(showBible, ibukiBeat)?.id === "ibuki", "ibukiSignal must be spoken by 標本イツキ.");
  const protagonistBeat = beats.find((beat) => beat.name === "protagonistFinish")?.row;
  storyReviewFailure(
    failures,
    protagonistBeat && [protagonistBeat.speakerId, protagonistBeat.speakerName].includes(review.protagonistSpeakerId),
    "protagonistFinish must be spoken by the reviewed protagonist, not an ally.",
  );
  const tatsuRows = fixedRows.filter((row) => row.cast.id === "tatsu");
  if (tatsuRows.length > 0) {
    const tatsuBeatId = nonEmpty(review?.beats?.tatsuExitBlock);
    storyReviewFailure(failures, tatsuRows.length === 1, "タツ may speak exactly one exit-blocking line in a reviewed episode.");
    storyReviewFailure(failures, tatsuBeatId === tatsuRows[0]?.utterance.id, "tatsuExitBlock must identify タツ's only utterance.");
    storyReviewFailure(failures, !protagonistBeat || tatsuRows[0].utterance.order === undefined || byId.get(tatsuBeatId)?.sequenceIndex > protagonistBeat.sequenceIndex, "タツ's exit-blocking line must follow the protagonist's finishing line.");
  }
  const requiredChecks = [
    "realPlaceNamesAbsent",
    "realBrandSignsAbsent",
    "directViolenceNotGlorified",
    "villainComedyPresent",
    "protagonistAgencyPass",
    "alcoholKeywordsRestrained",
  ];
  for (const key of requiredChecks) storyReviewFailure(failures, review?.checks?.[key] === true, `Story review check '${key}' must be true.`);
  if (titleHits.length > 1) failures.push("Title violates the restrained alcohol-keyword limit.");
  return {
    version: "koya-story-audit-v1",
    pass: failures.length === 0,
    active,
    scriptSha256,
    storyReviewVersion: review.version,
    fixedCastIds,
    declaredFixedCastIds,
    protagonistSpeakerId: nonEmpty(review.protagonistSpeakerId),
    beatUtteranceIds: Object.fromEntries(Object.entries(review.beats || {}).map(([key, value]) => [key, nonEmpty(value)])),
    warnings,
    failures,
  };
}

export function createKoyaStoryReviewDraft(options = {}) {
  const showBible = options.showBible;
  validateKoyaShowBible(showBible);
  const parsed = options.parsed;
  if (!parsed || !Array.isArray(parsed.utterances)) throw new Error("Parsed manga script is required for a story review draft.");
  return {
    version: KOYA_STORY_REVIEW_VERSION,
    scriptSha256: sha256(String(options.scriptText || "")),
    reviewer: { host: "", id: "", contextId: "" },
    reviewedAt: "",
    protagonistSpeakerId: nonEmpty(options.protagonistSpeakerId),
    beats: {
      attack1: "",
      attack2: "",
      attack3: "",
      ibukiSignal: "",
      evidence: "",
      protagonistFinish: "",
      tatsuExitBlock: "",
    },
    checks: Object.fromEntries((showBible.storyReview.requiredChecks || []).map((key) => [key, false])),
    utteranceInventory: parsed.utterances.map((utterance, sequenceIndex) => ({
      sequenceIndex,
      id: utterance.id,
      cutId: utterance.cutId,
      speakerId: utterance.speakerId,
      speakerName: utterance.speakerName,
      fixedCastId: castMemberForSpeaker(showBible, utterance)?.id || "",
      text: utterance.text,
    })),
    instructions: "Fill every required beat with one utteranceInventory id, complete the human checks, and remove utteranceInventory only if desired. Never change scriptSha256 by hand.",
  };
}

function slug(value, fallback) {
  const normalized = nonEmpty(value).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return normalized || fallback;
}

export function buildKoyaLocationBoardPlan(options = {}) {
  const locationBible = options.locationBible;
  validateKoyaLocationBible(locationBible);
  const locationId = nonEmpty(options.locationId);
  const location = locationBible.locations.find((entry) => entry.id === locationId);
  if (!location) throw new Error(`Unknown Koya location: ${locationId || "(missing)"}`);
  const projectDir = resolve(options.projectDir || process.cwd());
  const outputDir = resolve(options.outputDir || join(projectDir, "canvas/assets/koya-locations", location.id, "source"));
  const jobs = location.requiredBoards.map((board, index) => {
    const boardId = `board-${index + 1}-${slug(board, `view-${index + 1}`)}`;
    return {
      id: `${location.id}:${boardId}`,
      locationId: location.id,
      boardId,
      boardLabel: board,
      phase: index === 0 ? "anchor" : "continuity-view",
      dependsOn: index === 0 ? [] : [`${location.id}:board-1-${slug(location.requiredBoards[0], "view-1")}`],
      outputPath: join(outputDir, `${boardId}.png`),
      prompt: [
        `Create one clean 16:9 production environment reference for the fictional location ${location.name}.`,
        `Required view: ${board}.`,
        `Architecture lock: ${(location.architectureLock || []).join("; ")}.`,
        `Material and light palette: ${(location.materialPalette || []).join("; ")}.`,
        `Hard rules: ${(location.generationRules || []).join("; ")}.`,
        "No people, silhouettes, faces, readable lettering, real logos, or real place names. Preserve navigable spatial continuity across all approved views.",
      ].join("\n"),
      referencePolicy: index === 0 ? "no image reference; establish the canonical architecture" : "use only the current SHA-bound anchor candidate as the architecture reference; final approval happens after all four views pass independent review",
    };
  });
  return {
    version: "koya-location-board-plan-v1",
    location: { id: location.id, name: location.name, status: location.status },
    jobs,
    anchorReviewVersion: KOYA_LOCATION_ANCHOR_REVIEW_VERSION,
    reviewVersion: KOYA_LOCATION_REVIEW_VERSION,
    reviewRequirements: [
      "anchor generation first; no combined all-stage generation",
      "SHA-bound independent anchor review before continuity generation",
      "official generation manifest and per-board generator provenance",
      "independent final reviewer in a context different from every generator",
      "original-scale review and SHA-256 per board",
      "no people, readable text, or real brands",
      "cross-view architecture continuity",
    ],
    registrationBlockedUntilReviewPass: true,
  };
}

function locationGenerationManifestPath(plan) {
  return join(dirname(plan.jobs[0].outputPath), "location-generation.manifest.json");
}

function locationAnchorEntrySha256(entry) {
  return sha256(JSON.stringify(entry || null));
}

async function validExistingLocationBoard(path, minimumWidth, minimumHeight) {
  const buffer = await readFile(path);
  const dimensions = getImageDimensionsFromBuffer(buffer);
  if (!dimensions || dimensions.width < minimumWidth || dimensions.height < minimumHeight) {
    throw new Error(`Existing location board is below ${minimumWidth}x${minimumHeight}: ${path}`);
  }
  return { buffer, dimensions, sha256: sha256(buffer) };
}

export async function createKoyaLocationAnchorReviewDraft(options = {}) {
  const plan = buildKoyaLocationBoardPlan(options);
  const anchorJob = plan.jobs[0];
  const manifestPath = locationGenerationManifestPath(plan);
  let manifest = null;
  try { manifest = await readJsonStrict(manifestPath); } catch {}
  const anchorEntry = (Array.isArray(manifest?.entries) ? manifest.entries : []).find((entry) => entry?.boardId === anchorJob.boardId);
  let buffer = null;
  try { buffer = await readFile(anchorJob.outputPath); } catch {}
  let dimensions = null;
  try { dimensions = buffer ? getImageDimensionsFromBuffer(buffer) : null; } catch {}
  return {
    version: KOYA_LOCATION_ANCHOR_REVIEW_VERSION,
    locationId: plan.location.id,
    reviewer: { host: "", id: "", contextId: "" },
    reviewedAt: "",
    generationManifest: {
      path: manifestPath,
      anchorEntrySha256: anchorEntry ? locationAnchorEntrySha256(anchorEntry) : "",
    },
    anchor: {
      boardId: anchorJob.boardId,
      path: anchorJob.outputPath,
      sha256: buffer ? sha256(buffer) : "",
      dimensions,
      checks: {
        containsPeopleFalse: false,
        readableTextAbsent: false,
        realBrandsAbsent: false,
        architectureLockPass: false,
        originalScalePass: false,
        continuitySourceApproved: false,
      },
    },
    instructions: "A reviewer in a different context from the anchor generator must inspect the anchor at original scale. Change only observed checks to true; continuity generation remains blocked until this exact SHA-bound review passes.",
  };
}

export async function auditKoyaLocationAnchorReview(options = {}) {
  const plan = buildKoyaLocationBoardPlan(options);
  const anchorJob = plan.jobs[0];
  const review = options.review && typeof options.review === "object" ? options.review : null;
  const failures = [];
  if (!review) return { version: KOYA_LOCATION_ANCHOR_REVIEW_VERSION, pass: false, locationId: plan.location.id, failures: ["Location anchor review is required."] };
  storyReviewFailure(failures, review.version === KOYA_LOCATION_ANCHOR_REVIEW_VERSION, `Location anchor review version must be ${KOYA_LOCATION_ANCHOR_REVIEW_VERSION}.`);
  storyReviewFailure(failures, review.locationId === plan.location.id, "Location anchor review ID does not match the requested location.");
  storyReviewFailure(failures, nonEmpty(review?.reviewer?.host) && nonEmpty(review?.reviewer?.id) && nonEmpty(review?.reviewer?.contextId), "Independent anchor reviewer host, id, and contextId are required.");
  storyReviewFailure(failures, validIsoDate(review?.reviewedAt), "Location anchor review requires a valid ISO-8601 reviewedAt.");
  const expectedManifestPath = locationGenerationManifestPath(plan);
  const manifestPath = resolve(nonEmpty(review?.generationManifest?.path));
  let manifest = null;
  if (!nonEmpty(review?.generationManifest?.path)) failures.push("Location anchor review requires the official generation manifest path.");
  else if (manifestPath !== resolve(expectedManifestPath)) failures.push("Location anchor review must bind the official planned generation manifest path.");
  else {
    try {
      manifest = await readJsonStrict(manifestPath);
      if (!inside(resolve(options.projectDir || process.cwd()), manifestPath)) failures.push("Location anchor generation manifest must stay inside the project.");
      if (manifest.version !== KOYA_LOCATION_GENERATION_MANIFEST_VERSION || manifest.locationId !== plan.location.id) failures.push("Location anchor generation manifest version or locationId is invalid.");
    } catch (error) { failures.push(`Location anchor generation manifest is missing or invalid: ${error.message}`); }
  }
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  const matchingEntries = entries.filter((entry) => entry?.boardId === anchorJob.boardId);
  const generated = matchingEntries[0];
  if (matchingEntries.length !== 1) failures.push("Location generation manifest must contain the anchor board exactly once.");
  if (!generated || locationAnchorEntrySha256(generated) !== nonEmpty(review?.generationManifest?.anchorEntrySha256)) {
    failures.push("Location anchor entry SHA-256 does not match the reviewed generation evidence.");
  }
  const reviewed = review?.anchor;
  if (reviewed?.boardId !== anchorJob.boardId) failures.push("Location anchor review must cover the planned anchor board.");
  const assetPath = resolve(nonEmpty(reviewed?.path));
  if (assetPath !== resolve(anchorJob.outputPath)) failures.push("Location anchor review path must match the planned anchor output.");
  if (!inside(resolve(options.projectDir || process.cwd()), assetPath)) failures.push("Location anchor asset must stay inside the recipient project.");
  let buffer = null;
  try { buffer = await readFile(assetPath); } catch { failures.push(`Location anchor asset is missing: ${assetPath}`); }
  const actualSha256 = buffer ? sha256(buffer) : "";
  let dimensions = null;
  try { dimensions = buffer ? getImageDimensionsFromBuffer(buffer) : null; } catch {}
  const minimumWidth = Number(options.locationBible.reviewContract.minimumWidth || 1280);
  const minimumHeight = Number(options.locationBible.reviewContract.minimumHeight || 720);
  if (!/^[a-f0-9]{64}$/u.test(nonEmpty(reviewed?.sha256)) || reviewed.sha256 !== actualSha256) failures.push("Location anchor SHA-256 does not match disk.");
  if (!dimensions || dimensions.width < minimumWidth || dimensions.height < minimumHeight) failures.push(`Location anchor must be reviewed at ${minimumWidth}x${minimumHeight} or larger.`);
  if (!generated || resolve(nonEmpty(generated.path)) !== assetPath || generated.sha256 !== actualSha256) failures.push("Location anchor is not bound to the official generation manifest.");
  if (generated?.promptSha256 !== sha256(anchorJob.prompt) || nonEmpty(generated?.anchorSha256)) failures.push("Location anchor generation prompt or anchor binding is invalid.");
  if (!nonEmpty(generated?.generator?.host) || !nonEmpty(generated?.generator?.id) || !nonEmpty(generated?.generator?.contextId)) failures.push("Location anchor generation provenance is incomplete.");
  if (nonEmpty(generated?.generator?.contextId) === nonEmpty(review?.reviewer?.contextId)) failures.push("Location anchor must be reviewed in a context different from its generator.");
  for (const key of ["containsPeopleFalse", "readableTextAbsent", "realBrandsAbsent", "architectureLockPass", "originalScalePass", "continuitySourceApproved"]) {
    if (reviewed?.checks?.[key] !== true) failures.push(`Location anchor check '${key}' must be true.`);
  }
  return {
    version: KOYA_LOCATION_ANCHOR_REVIEW_VERSION,
    pass: failures.length === 0,
    locationId: plan.location.id,
    review,
    manifestPath,
    anchorEntry: generated || null,
    anchorEntrySha256: generated ? locationAnchorEntrySha256(generated) : "",
    anchor: { path: assetPath, sha256: actualSha256, dimensions },
    failures,
  };
}

async function generateKoyaLocationBoardsUnlocked(options = {}) {
  const authority = options.authority || await readKoyaChannelAuthority({ projectDir: options.projectDir });
  if (authority.source !== "project") throw new Error("Restore the Koya project authority before generating location boards.");
  const generator = options.generator && typeof options.generator === "object" ? options.generator : {};
  for (const key of ["host", "id", "contextId"]) if (!nonEmpty(generator[key])) throw new Error(`Location generator.${key} is required for independent review provenance.`);
  const stage = nonEmpty(options.stage);
  if (!new Set(["anchor", "continuity"]).has(stage)) throw new Error("Location generation stage must be anchor or continuity; combined all-stage generation is forbidden because the anchor requires human review first.");
  const plan = buildKoyaLocationBoardPlan({
    projectDir: authority.projectDir,
    locationBible: authority.locationBible,
    locationId: options.locationId,
    outputDir: options.outputDir,
  });
  const canvasDir = resolveCanvasDir({ projectDir: authority.projectDir });
  if (plan.jobs.some((job) => !inside(canvasDir, resolve(job.outputPath)))) throw new Error("Location boards must be generated inside canvas/ for portable review and handoff.");
  const minimumWidth = Number(authority.locationBible.reviewContract.minimumWidth || 1280);
  const minimumHeight = Number(authority.locationBible.reviewContract.minimumHeight || 720);
  const anchorJob = plan.jobs[0];
  const targetJobs = stage === "anchor" ? [anchorJob] : plan.jobs.slice(1);
  const imageGenerator = typeof options.generateImage === "function" ? options.generateImage : generateImageMedia;
  const generatedAt = new Date().toISOString();
  const manifestPath = locationGenerationManifestPath(plan);
  let priorManifest = null;
  let priorEntries = [];
  if (await exists(manifestPath)) {
    priorManifest = await readJsonStrict(manifestPath);
    if (priorManifest.version !== KOYA_LOCATION_GENERATION_MANIFEST_VERSION || priorManifest.locationId !== plan.location.id) throw new Error(`Existing location generation manifest does not match ${plan.location.id}.`);
    const expectedBoardIds = plan.jobs.map((job) => job.boardId);
    if (JSON.stringify(priorManifest.requiredBoardIds || []) !== JSON.stringify(expectedBoardIds)) throw new Error("Existing location generation manifest does not match the current board plan.");
    priorEntries = Array.isArray(priorManifest.entries) ? priorManifest.entries : [];
    const priorIds = priorEntries.map((entry) => entry?.boardId);
    if (new Set(priorIds).size !== priorIds.length || priorIds.some((id) => !expectedBoardIds.includes(id))) throw new Error("Existing location generation manifest contains duplicate or unknown board IDs.");
  }
  const priorByBoardId = new Map(priorEntries.map((entry) => [entry.boardId, entry]));
  const results = [];
  let anchorEvidence = null;
  let anchorApproval = null;
  if (stage === "continuity") {
    try { anchorEvidence = await validExistingLocationBoard(anchorJob.outputPath, minimumWidth, minimumHeight); }
    catch (error) { throw new Error(`Generate a valid anchor board before continuity views: ${error.message}`); }
    const priorAnchor = priorByBoardId.get(anchorJob.boardId);
    if (!priorAnchor || priorAnchor.sha256 !== anchorEvidence.sha256 || resolve(priorAnchor.path) !== resolve(anchorJob.outputPath)) {
      throw new Error("The anchor board is not bound to the official location generation manifest; regenerate it with stage=anchor and force=true.");
    }
    const anchorReviewPath = resolve(nonEmpty(options.anchorReviewPath));
    if (!nonEmpty(options.anchorReviewPath)) throw new Error("A SHA-bound location anchor review path is required before continuity generation.");
    if (!inside(canvasDir, anchorReviewPath)) throw new Error("Location anchor review must be stored inside canvas/ for portable handoff.");
    const anchorReview = await readJsonStrict(anchorReviewPath);
    const anchorAudit = await auditKoyaLocationAnchorReview({
      projectDir: authority.projectDir,
      locationBible: authority.locationBible,
      locationId: plan.location.id,
      outputDir: dirname(anchorJob.outputPath),
      review: anchorReview,
    });
    if (!anchorAudit.pass) throw new Error(`Koya location anchor review failed: ${anchorAudit.failures.join("; ")}`);
    anchorApproval = {
      path: anchorReviewPath,
      sha256: sha256(await readFile(anchorReviewPath)),
      anchorSha256: anchorEvidence.sha256,
      reviewedAt: anchorReview.reviewedAt,
      reviewer: anchorReview.reviewer,
    };
    if (options.force !== true
      && priorEntries.some((entry) => entry.boardId !== anchorJob.boardId)
      && JSON.stringify(priorManifest?.anchorApproval || null) !== JSON.stringify(anchorApproval)) {
      throw new Error("Existing continuity views were generated under a different anchor approval; pass force=true to regenerate continuity from the current approved anchor.");
    }
  }
  const workingByBoardId = new Map(stage === "anchor" ? [] : priorEntries.map((entry) => [entry.boardId, entry]));
  let manifest = priorManifest;
  let wroteManifest = false;
  // 非アンカーの背景はアンカー1枚だけに依存し、互いには依存しない。
  // アンカーを先に片付けてから残りを同時に投げる。順序を守るのは
  // anchorEvidence の確立だけで、そこから先は並列にしてよい。
  const resultsByIndex = new Array(targetJobs.length);

  // マニフェストは1つのファイル。書き込みだけは直列に流す。
  // 並列のジョブから writeJsonAtomic を同時に呼ぶと、後から始まった
  // 書き込みが先に終わって古い内容が残ることがある。
  let manifestWrite = Promise.resolve();
  const queueManifestWrite = (next) => {
    manifestWrite = manifestWrite.then(next, next);
    return manifestWrite;
  };

  const processJob = async (job, jobIndex) => {
    const isAnchor = job.boardId === anchorJob.boardId;
    if (!isAnchor && !anchorEvidence) anchorEvidence = await validExistingLocationBoard(anchorJob.outputPath, minimumWidth, minimumHeight);
    let evidence = null;
    let reused = false;
    if (await exists(job.outputPath) && options.force !== true) {
      evidence = await validExistingLocationBoard(job.outputPath, minimumWidth, minimumHeight);
      reused = true;
      const prior = priorByBoardId.get(job.boardId);
      if (!prior || prior.sha256 !== evidence.sha256 || resolve(prior.path) !== resolve(job.outputPath) || !nonEmpty(prior?.generator?.contextId)) {
        throw new Error(`${job.boardId} exists without matching official generation provenance; pass force=true to regenerate it.`);
      }
      if (prior.promptSha256 !== sha256(job.prompt) || (!isAnchor && prior.anchorSha256 !== anchorEvidence.sha256)) {
        throw new Error(`${job.boardId} was generated from a stale location prompt or anchor; pass force=true to regenerate it.`);
      }
    } else {
      const media = await imageGenerator({
        prompt: job.prompt,
        model: nonEmpty(options.model) || "gpt-image-2-codex",
        aspectRatio: "16:9",
        imageSize: "2K",
        quality: "high",
        imageCount: 1,
        fileName: basename(job.outputPath),
        referenceImagePaths: isAnchor ? [] : [anchorJob.outputPath],
      });
      const buffer = media?.buffer instanceof Buffer ? media.buffer : media?.buffer ? Buffer.from(media.buffer) : null;
      if (!buffer) throw new Error(`Location generation returned no image for ${job.boardId}.`);
      const dimensions = getImageDimensionsFromBuffer(buffer);
      if (!dimensions || dimensions.width < minimumWidth || dimensions.height < minimumHeight) {
        throw new Error(`${job.boardId} generation is below ${minimumWidth}x${minimumHeight}; no file was accepted.`);
      }
      await mkdir(dirname(job.outputPath), { recursive: true });
      await writeFile(job.outputPath, buffer);
      evidence = { buffer, dimensions, sha256: sha256(buffer) };
    }
    const currentResult = {
      boardId: job.boardId,
      path: job.outputPath,
      sha256: evidence.sha256,
      dimensions: evidence.dimensions,
      promptSha256: sha256(job.prompt),
      anchorSha256: isAnchor ? "" : anchorEvidence.sha256,
      generator: { host: nonEmpty(generator.host), id: nonEmpty(generator.id), contextId: nonEmpty(generator.contextId) },
      generatedAt,
      reused,
    };
    const result = reused ? { ...priorByBoardId.get(job.boardId), reused: true } : currentResult;
    resultsByIndex[jobIndex] = result;
    workingByBoardId.set(job.boardId, reused ? priorByBoardId.get(job.boardId) : currentResult);
    if (!reused) {
      manifest = {
        version: KOYA_LOCATION_GENERATION_MANIFEST_VERSION,
        locationId: plan.location.id,
        requiredBoardIds: plan.jobs.map((entry) => entry.boardId),
        entries: plan.jobs.map((entry) => workingByBoardId.get(entry.boardId)).filter(Boolean),
        anchorApproval: stage === "continuity" ? anchorApproval : null,
        updatedAt: generatedAt,
      };
      await queueManifestWrite(() => writeJsonAtomic(manifestPath, manifest));
      wroteManifest = true;
    }
    if (isAnchor) anchorEvidence = evidence;
    };

  const anchorIndex = targetJobs.findIndex((job) => job.boardId === anchorJob.boardId);
  if (anchorIndex >= 0) {
    // アンカーは他の参照元になるので必ず先に確定させる。
    await processJob(targetJobs[anchorIndex], anchorIndex);
  }
  await Promise.all(
    targetJobs
      .map((job, jobIndex) => ({ job, jobIndex }))
      .filter(({ jobIndex }) => jobIndex !== anchorIndex)
      .map(({ job, jobIndex }) => processJob(job, jobIndex)),
  );
  await manifestWrite;
  results.push(...resultsByIndex.filter(Boolean));

  if (!wroteManifest && !manifest) throw new Error("No location board was generated and no official manifest exists.");
  const manifestSha256 = sha256(await readFile(manifestPath));
  const complete = JSON.stringify((manifest.entries || []).map((entry) => entry.boardId)) === JSON.stringify(plan.jobs.map((job) => job.boardId));
  return { locationId: plan.location.id, stage, manifestPath, manifestSha256, results, complete, manifestRewritten: wroteManifest };
}

export async function generateKoyaLocationBoards(options = {}) {
  const authority = options.authority || await readKoyaChannelAuthority({ projectDir: options.projectDir });
  if (authority.source !== "project") throw new Error("Restore the Koya project authority before generating location boards.");
  const plan = buildKoyaLocationBoardPlan({
    projectDir: authority.projectDir,
    locationBible: authority.locationBible,
    locationId: options.locationId,
    outputDir: options.outputDir,
  });
  const manifestPath = locationGenerationManifestPath(plan);
  return withCanvasFileLock(
    manifestPath,
    () => generateKoyaLocationBoardsUnlocked({ ...options, authority }),
    { timeoutMs: 30 * 60_000, staleMs: 2 * 60 * 60_000 },
  );
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function auditKoyaLocationReview(options = {}) {
  const plan = buildKoyaLocationBoardPlan(options);
  const review = options.review && typeof options.review === "object" ? options.review : null;
  const failures = [];
  if (!review) return { version: KOYA_LOCATION_REVIEW_VERSION, pass: false, locationId: plan.location.id, failures: ["Location review is required."], rows: [] };
  storyReviewFailure(failures, review.version === KOYA_LOCATION_REVIEW_VERSION, `Location review version must be ${KOYA_LOCATION_REVIEW_VERSION}.`);
  storyReviewFailure(failures, review.locationId === plan.location.id, "Location review ID does not match the requested location.");
  storyReviewFailure(failures, nonEmpty(review?.reviewer?.host) && nonEmpty(review?.reviewer?.id) && nonEmpty(review?.reviewer?.contextId), "Independent reviewer host, id, and contextId are required.");
  storyReviewFailure(failures, validIsoDate(review?.reviewedAt), "Location review requires a valid ISO-8601 reviewedAt.");
  storyReviewFailure(failures, review?.checks?.crossViewArchitectureContinuity === true, "Cross-view architecture continuity must pass.");
  storyReviewFailure(failures, review?.checks?.originalScaleReview === true, "Original-scale review must pass.");
  const manifestPath = resolve(nonEmpty(review?.generationManifest?.path));
  let generationManifest = null;
  let generationManifestSha256 = "";
  if (!nonEmpty(review?.generationManifest?.path)) failures.push("Location review requires the official generation manifest path.");
  else {
    try {
      const manifestBuffer = await readFile(manifestPath);
      generationManifestSha256 = sha256(manifestBuffer);
      generationManifest = JSON.parse(manifestBuffer.toString("utf8"));
      if (!inside(resolve(options.projectDir || process.cwd()), manifestPath)) failures.push("Location generation manifest must stay inside the project.");
      if (generationManifestSha256 !== nonEmpty(review?.generationManifest?.sha256)) failures.push("Location generation manifest SHA-256 does not match the reviewed bytes.");
      if (generationManifest.version !== KOYA_LOCATION_GENERATION_MANIFEST_VERSION || generationManifest.locationId !== plan.location.id) failures.push("Location generation manifest version or locationId is invalid.");
    } catch (error) { failures.push(`Location generation manifest is missing or invalid: ${error.message}`); }
  }
  const generationByBoardId = new Map((Array.isArray(generationManifest?.entries) ? generationManifest.entries : []).map((entry) => [entry.boardId, entry]));
  const expectedBoardIds = plan.jobs.map((job) => job.boardId);
  if (JSON.stringify(generationManifest?.requiredBoardIds || []) !== JSON.stringify(expectedBoardIds)
    || !Array.isArray(generationManifest?.entries)
    || generationManifest.entries.length !== expectedBoardIds.length
    || generationByBoardId.size !== expectedBoardIds.length
    || JSON.stringify(generationManifest.entries.map((entry) => entry?.boardId)) !== JSON.stringify(expectedBoardIds)) {
    failures.push("Location generation manifest must cover the four required boards exactly once and in the planned order.");
  }
  const anchorApproval = generationManifest?.anchorApproval;
  if (!nonEmpty(anchorApproval?.path) || !/^[a-f0-9]{64}$/u.test(nonEmpty(anchorApproval?.sha256))) {
    failures.push("Location generation manifest requires the SHA-bound anchor approval used before continuity generation.");
  } else {
    const anchorReviewPath = resolve(anchorApproval.path);
    try {
      const anchorReviewBytes = await readFile(anchorReviewPath);
      if (sha256(anchorReviewBytes) !== anchorApproval.sha256) failures.push("Location anchor approval SHA-256 no longer matches disk.");
      const anchorReview = JSON.parse(anchorReviewBytes.toString("utf8"));
      const anchorAudit = await auditKoyaLocationAnchorReview({
        projectDir: options.projectDir,
        locationBible: options.locationBible,
        locationId: plan.location.id,
        outputDir: dirname(plan.jobs[0].outputPath),
        review: anchorReview,
      });
      if (!anchorAudit.pass) failures.push(`Location anchor approval is no longer valid: ${anchorAudit.failures.join("; ")}`);
      if (anchorApproval.anchorSha256 !== generationByBoardId.get(plan.jobs[0].boardId)?.sha256) failures.push("Location anchor approval does not bind the current anchor SHA-256.");
      if (anchorApproval.reviewedAt !== anchorReview.reviewedAt || JSON.stringify(anchorApproval.reviewer || {}) !== JSON.stringify(anchorReview.reviewer || {})) failures.push("Location anchor approval provenance does not match its review file.");
    } catch (error) { failures.push(`Location anchor approval is missing or invalid: ${error.message}`); }
  }
  if (!Array.isArray(review.boards) || review.boards.length !== expectedBoardIds.length) failures.push("Location review must cover the four required boards exactly once.");
  const reviewedById = new Map((Array.isArray(review.boards) ? review.boards : []).map((entry) => [entry.boardId, entry]));
  if (reviewedById.size !== expectedBoardIds.length) failures.push("Location review contains duplicate or unknown board IDs.");
  const minimumWidth = Number(options.locationBible.reviewContract.minimumWidth || 1280);
  const minimumHeight = Number(options.locationBible.reviewContract.minimumHeight || 720);
  const rows = [];
  for (const job of plan.jobs) {
    const reviewed = reviewedById.get(job.boardId);
    if (!reviewed) { failures.push(`Missing review for ${job.boardId}.`); continue; }
    const assetPath = resolve(nonEmpty(reviewed.path));
    if (!inside(resolve(options.projectDir || process.cwd()), assetPath)) failures.push(`${job.boardId} asset must stay inside the recipient project.`);
    let buffer = null;
    try { buffer = await readFile(assetPath); } catch { failures.push(`${job.boardId} asset is missing: ${assetPath}`); }
    const actualSha256 = buffer ? sha256(buffer) : "";
    const dimensions = buffer ? getImageDimensionsFromBuffer(buffer) : null;
    if (!/^[a-f0-9]{64}$/u.test(nonEmpty(reviewed.sha256)) || reviewed.sha256 !== actualSha256) failures.push(`${job.boardId} SHA-256 does not match disk.`);
    if (!dimensions || dimensions.width < minimumWidth || dimensions.height < minimumHeight) failures.push(`${job.boardId} must be reviewed at ${minimumWidth}x${minimumHeight} or larger.`);
    const generated = generationByBoardId.get(job.boardId);
    if (!generated || resolve(nonEmpty(generated.path)) !== assetPath || generated.sha256 !== actualSha256) failures.push(`${job.boardId} is not bound to the official generation manifest.`);
    if (generated?.promptSha256 !== sha256(job.prompt)) failures.push(`${job.boardId} generation prompt does not match the current location bible.`);
    const expectedAnchorSha = job.boardId === plan.jobs[0].boardId ? "" : generationByBoardId.get(plan.jobs[0].boardId)?.sha256;
    if (nonEmpty(generated?.anchorSha256) !== nonEmpty(expectedAnchorSha)) failures.push(`${job.boardId} is not bound to the current anchor SHA-256.`);
    if (!nonEmpty(generated?.generator?.host) || !nonEmpty(generated?.generator?.id) || !nonEmpty(generated?.generator?.contextId)) failures.push(`${job.boardId} generation provenance is incomplete.`);
    if (nonEmpty(generated?.generator?.contextId) === nonEmpty(review?.reviewer?.contextId)) failures.push(`${job.boardId} must be reviewed in a context different from its generator.`);
    for (const key of ["containsPeopleFalse", "readableTextAbsent", "realBrandsAbsent", "architectureLockPass", "originalScalePass"]) {
      if (reviewed?.checks?.[key] !== true) failures.push(`${job.boardId} check '${key}' must be true.`);
    }
    rows.push({ boardId: job.boardId, path: assetPath, sha256: actualSha256, dimensions });
  }
  if (rows.length > 0 && new Set(rows.map((row) => row.sha256)).size !== rows.length) {
    failures.push("All four location views must be distinct image files; duplicate SHA-256 values are not allowed.");
  }
  return { version: KOYA_LOCATION_REVIEW_VERSION, pass: failures.length === 0, locationId: plan.location.id, review, generationManifestPath: manifestPath, generationManifestSha256, rows, failures };
}

export async function createKoyaLocationReviewDraft(options = {}) {
  const plan = buildKoyaLocationBoardPlan(options);
  const manifestPath = locationGenerationManifestPath(plan);
  let manifestSha256 = "";
  try { manifestSha256 = sha256(await readFile(manifestPath)); } catch {}
  const boards = [];
  for (const job of plan.jobs) {
    let buffer = null;
    try { buffer = await readFile(job.outputPath); } catch {}
    let dimensions = null;
    try { dimensions = buffer ? getImageDimensionsFromBuffer(buffer) : null; } catch {}
    boards.push({
      boardId: job.boardId,
      path: job.outputPath,
      sha256: buffer ? sha256(buffer) : "",
      dimensions,
      checks: { containsPeopleFalse: false, readableTextAbsent: false, realBrandsAbsent: false, architectureLockPass: false, originalScalePass: false },
    });
  }
  return {
    version: KOYA_LOCATION_REVIEW_VERSION,
    locationId: plan.location.id,
    reviewer: { host: "", id: "", contextId: "" },
    reviewedAt: "",
    generationManifest: { path: manifestPath, sha256: manifestSha256 },
    checks: { crossViewArchitectureContinuity: false, originalScaleReview: false },
    boards,
    instructions: "SHA and dimensions are read from the current planned files. A different reviewer must inspect every image at original scale and change only observed checks to true.",
  };
}

export async function registerApprovedKoyaLocation(options = {}) {
  const authority = options.authority || await readKoyaChannelAuthority({ projectDir: options.projectDir });
  if (authority.source !== "project") throw new Error("Restore the Koya project authority before registering a location.");
  if (!nonEmpty(options.reviewPath)) throw new Error("Koya location reviewPath is required so the exact reviewed evidence can be SHA-bound and transferred.");
  const review = options.review || await readJsonStrict(resolve(options.reviewPath));
  const audit = await auditKoyaLocationReview({
    projectDir: authority.projectDir,
    locationBible: authority.locationBible,
    locationId: options.locationId,
    review,
  });
  if (!audit.pass) throw new Error(`Koya location review failed: ${audit.failures.join("; ")}`);
  const location = authority.locationBible.locations.find((entry) => entry.id === options.locationId);
  const registry = await readCharacterRegistry({ projectDir: authority.projectDir });
  const existing = registry.characters.find((entry) => entry.id === location.id);
  if (existing?.status === "approved") throw new Error(`Approved location already exists: ${location.id}`);
  const canvasDir = resolveCanvasDir({ projectDir: authority.projectDir });
  const reviewPath = resolve(options.reviewPath);
  if (!inside(canvasDir, reviewPath) || audit.rows.some((row) => !inside(canvasDir, row.path))) {
    throw new Error("Location review and all approved boards must be stored inside canvas/ for portable handoff.");
  }
  const now = new Date().toISOString();
  const entry = {
    id: location.id,
    name: location.name,
    kind: "location",
    role: "fixed",
    status: "approved",
    aliases: [],
    description: `${(location.architectureLock || []).join("、")}。${(location.materialPalette || []).join("、")}。`,
    invariants: [...(location.architectureLock || []), ...(location.materialPalette || [])],
    negativePrompt: "people, silhouettes, readable text, real logos, real place names, architecture drift",
    referenceImagePaths: audit.rows.map((row) => relative(canvasDir, row.path)),
    referenceAssets: audit.rows.map((row) => ({
      id: row.boardId,
      role: "supplemental",
      path: relative(canvasDir, row.path),
      sha256: row.sha256,
      sourceReviewPath: relative(canvasDir, reviewPath),
    })),
    approval: {
      route: KOYA_LOCATION_REVIEW_VERSION,
      approvedBy: nonEmpty(review?.reviewer?.id),
      approvedAt: nonEmpty(review.reviewedAt) || now,
      reason: "All four SHA-bound environment boards passed independent original-scale and continuity review.",
      identityReviewPath: relative(canvasDir, reviewPath),
      identityReviewSha256: sha256(await readFile(reviewPath)),
    },
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  registry.characters = [...registry.characters.filter((character) => character.id !== location.id), entry];
  const written = await writeCharacterRegistry({ projectDir: authority.projectDir }, registry);
  return { location: written.characters.find((character) => character.id === location.id), registryRevision: written.revision, audit };
}

function validateLines(lines, expectedLines, maximumLength, label, failures) {
  if (!Array.isArray(lines) || lines.length !== expectedLines) {
    failures.push(`${label} requires exactly ${expectedLines} lines.`);
    return;
  }
  lines.forEach((line, index) => {
    if (!nonEmpty(line)) failures.push(`${label} line ${index + 1} is empty.`);
    if (normalizedJapaneseLength(line) > maximumLength) failures.push(`${label} line ${index + 1} exceeds ${maximumLength} characters.`);
  });
}

export function koyaThumbnailCopySha256(plan = {}) {
  return sha256(JSON.stringify({
    layout: nonEmpty(plan.layout),
    thirdBeatReason: nonEmpty(plan.thirdBeatReason),
    bandLines: (plan.bandLines || []).map(nonEmpty),
    speechBubbles: (plan.speechBubbles || []).map((entry) => ({ panelId: nonEmpty(entry.panelId), lines: (entry.lines || []).map(nonEmpty) })),
    telops: (plan.telops || []).map((entry) => ({ text: nonEmpty(entry.text), concreteNounReviewPassed: entry.concreteNounReviewPassed === true })),
  }));
}

async function normalizedGray32(path) {
  const result = await execFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", path,
    "-vf", "scale=32:32:force_original_aspect_ratio=decrease,pad=32:32:(ow-iw)/2:(oh-ih)/2:black,format=gray",
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ], { encoding: null, maxBuffer: 1024 * 1024 });
  const buffer = Buffer.from(result.stdout || []);
  if (buffer.length !== 1024) throw new Error(`Could not normalize thumbnail audit image: ${path}`);
  return buffer;
}

function normalizedPixelDistance(left, right) {
  if (!left || !right || left.length !== right.length || left.length === 0) return Infinity;
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += Math.abs(left[index] - right[index]);
  return sum / (left.length * 255);
}

export async function auditKoyaThumbnailPlan(options = {}) {
  const contract = options.thumbnailContract;
  validateKoyaThumbnailContract(contract);
  const plan = options.plan && typeof options.plan === "object" ? options.plan : {};
  const projectDir = resolve(options.projectDir || process.cwd());
  const failures = [];
  const warnings = [];
  storyReviewFailure(failures, plan.version === KOYA_THUMBNAIL_PLAN_VERSION, `Thumbnail plan version must be ${KOYA_THUMBNAIL_PLAN_VERSION}.`);
  storyReviewFailure(failures, ["preflight", "final"].includes(plan.stage), "Thumbnail plan stage must be preflight or final.");
  storyReviewFailure(failures, ["twoPanel", "threePanel"].includes(plan.layout), "Thumbnail layout must be twoPanel or threePanel.");
  if (plan.layout === "threePanel") storyReviewFailure(failures, nonEmpty(plan.thirdBeatReason), "threePanel requires a concrete thirdBeatReason.");
  validateLines(plan.bandLines, contract.copy.band.lines, contract.copy.band.maxCharactersPerLine, "Band copy", failures);
  const forbidden = contract.copy.forbiddenAbstractHooks || [];
  for (const text of [...(plan.bandLines || []), ...(plan.speechBubbles || []).flatMap((entry) => entry.lines || [])]) {
    for (const hook of forbidden) if (String(text || "").includes(hook)) failures.push(`Forbidden abstract hook '${hook}' appears in thumbnail copy.`);
  }
  const panelIds = new Set();
  for (const bubble of Array.isArray(plan.speechBubbles) ? plan.speechBubbles : []) {
    if (!nonEmpty(bubble.panelId)) failures.push("Every speech bubble requires panelId.");
    if (panelIds.has(bubble.panelId)) failures.push(`Only one speech bubble is allowed in panel ${bubble.panelId}.`);
    panelIds.add(bubble.panelId);
    if (!Array.isArray(bubble.lines) || bubble.lines.length < 1 || bubble.lines.length > contract.copy.speechBubble.lines) {
      failures.push(`Speech bubble ${bubble.panelId || "(unknown)"} requires one or two lines.`);
    } else {
      for (const [index, line] of bubble.lines.entries()) if (normalizedJapaneseLength(line) > contract.copy.speechBubble.maxCharactersPerLine) failures.push(`Speech bubble ${bubble.panelId} line ${index + 1} exceeds ${contract.copy.speechBubble.maxCharactersPerLine} characters.`);
    }
  }
  for (const telop of Array.isArray(plan.telops) ? plan.telops : []) {
    const length = normalizedJapaneseLength(telop.text);
    if (length < contract.copy.telop.minCharacters || length > contract.copy.telop.maxCharacters) failures.push(`Telop '${telop.text || ""}' must be ${contract.copy.telop.minCharacters}-${contract.copy.telop.maxCharacters} characters.`);
    if (telop.concreteNounReviewPassed !== true) failures.push(`Telop '${telop.text || ""}' requires concrete-noun human review.`);
  }
  storyReviewFailure(failures, plan.exactTextApproved === true, "Exact thumbnail text requires human approval.");
  const copySha256 = koyaThumbnailCopySha256(plan);
  storyReviewFailure(failures, nonEmpty(plan?.textApproval?.approvedBy) && validIsoDate(plan?.textApproval?.approvedAt), "Thumbnail text approval requires approvedBy and a valid ISO-8601 approvedAt.");
  storyReviewFailure(failures, plan?.textApproval?.copySha256 === copySha256, "Thumbnail text approval is stale or does not match the exact copy.");
  const pendingTokens = [contract.visual.bandColorToken, contract.visual.bandFontToken].filter((value) => /^PENDING_/u.test(nonEmpty(value)));
  if (pendingTokens.length > 0) failures.push(`Thumbnail brand tokens are pending: ${pendingTokens.join(", ")}.`);
  const artRows = [];
  const videoRows = [];
  if (plan.stage === "final") {
    const expectedArtCount = plan.layout === "threePanel" ? 3 : 2;
    storyReviewFailure(failures, Array.isArray(plan.artworkPaths) && plan.artworkPaths.length === expectedArtCount, `${plan.layout} final audit requires ${expectedArtCount} dedicated artwork files.`);
    storyReviewFailure(failures, Array.isArray(plan.mainVideoFramePaths) && plan.mainVideoFramePaths.length > 0, "Final thumbnail audit requires mainVideoFramePaths to prove non-reuse.");
    const normalizedByPath = new Map();
    for (const [collection, rows, label] of [[plan.artworkPaths, artRows, "artwork"], [plan.mainVideoFramePaths, videoRows, "video frame/source image"]]) {
      for (const value of Array.isArray(collection) ? collection : []) {
        const path = resolve(value);
        if (!inside(projectDir, path)) failures.push(`Thumbnail ${label} must stay inside the project: ${path}`);
        try {
          const buffer = await readFile(path);
          const normalized = await normalizedGray32(path);
          normalizedByPath.set(path, normalized);
          rows.push({ path, sha256: sha256(buffer), normalizedGray32Sha256: sha256(normalized), dimensions: getImageDimensionsFromBuffer(buffer) });
        } catch { failures.push(`Thumbnail ${label} is missing: ${path}`); }
      }
    }
    const frameDigests = new Set(videoRows.map((row) => row.sha256));
    for (const row of artRows) if (frameDigests.has(row.sha256)) failures.push(`Dedicated thumbnail artwork reuses a main-video frame: ${row.path}`);
    for (const artwork of artRows) {
      for (const frame of videoRows) {
        const distance = normalizedPixelDistance(normalizedByPath.get(artwork.path), normalizedByPath.get(frame.path));
        const reuseDistance = Number(contract?.sourcePolicy?.normalizedGray32MaximumReuseDistance ?? 0.025);
        if (distance < reuseDistance) failures.push(`Dedicated thumbnail artwork is perceptually the same as a main-video frame/source image (distance=${distance.toFixed(4)}): ${artwork.path}`);
      }
    }
    const requiredFinalChecks = ["original1280x720", "mobile320x180", "textCropZero", "faceCropZero", "primaryEmotionReadable", "approvedCharacterReferencesOnly", "realLogoZero"];
    if (requiredFinalChecks.some((key) => plan?.checks?.[key] !== true)) {
      failures.push(`Final thumbnail audit requires all checks: ${requiredFinalChecks.join(", ")}.`);
    }
  } else if (Array.isArray(plan.artworkPaths) && plan.artworkPaths.length > 0) {
    warnings.push("Preflight ignores artwork files; use stage=final after dedicated artwork is generated.");
  }
  return {
    version: "koya-thumbnail-audit-v1",
    pass: failures.length === 0,
    readyForGeneration: failures.length === 0 && plan.stage === "preflight",
    readyForPublish: failures.length === 0 && plan.stage === "final",
    contractStatus: contract.status,
    copySha256,
    pendingTokens,
    artwork: artRows,
    videoFrames: videoRows,
    failures,
    warnings,
  };
}

export function createKoyaThumbnailPlanDraft(options = {}) {
  const contract = options.thumbnailContract;
  validateKoyaThumbnailContract(contract);
  const layout = options.layout === "threePanel" ? "threePanel" : "twoPanel";
  return {
    version: KOYA_THUMBNAIL_PLAN_VERSION,
    stage: "preflight",
    layout,
    ...(layout === "threePanel" ? { thirdBeatReason: "" } : {}),
    bandLines: ["", ""],
    speechBubbles: [],
    telops: [],
    exactTextApproved: false,
    textApproval: { approvedBy: "", approvedAt: "", copySha256: "" },
    artworkPaths: [],
    mainVideoFramePaths: [],
    checks: {
      original1280x720: false,
      mobile320x180: false,
      textCropZero: false,
      faceCropZero: false,
      primaryEmotionReadable: false,
      approvedCharacterReferencesOnly: false,
      realLogoZero: false,
    },
    contractStatus: contract.status,
    brandTokens: { bandColorToken: contract.visual.bandColorToken, bandFontToken: contract.visual.bandFontToken },
    instructions: "Approve exact copy and record koyaThumbnailCopySha256(plan) only after band/font tokens are human-approved. Change stage to final and add dedicated artwork plus main-video source images for reuse audit.",
  };
}
