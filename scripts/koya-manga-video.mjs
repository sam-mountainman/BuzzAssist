#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { runKoyaCharacterAttributeGate } from "../lib/koyaCharacterAttributeAudit.mjs";
import { auditKoyaMangaFinal, writeKoyaVisualSignoff } from "../lib/koyaMangaFinalAudit.mjs";
import {
  REVIEWER_TRUST_ENV_GUIDANCE,
  REVIEWER_TRUST_PATH_ENV,
  loadReviewerTrust,
  preflightReviewerTrust,
  writeReviewerKeyPairFiles,
} from "../lib/koyaReviewAttestation.mjs";
import {
  adjustKoyaMangaUtteranceGap,
  assertKoyaFullPreflight,
  approveKoyaCharacterCandidate,
  composeKoyaCharacterStylingReview,
  createKoyaEpisodeManifest,
  generateKoyaMangaImages,
  generateKoyaCharacterStylingVariations,
  importKoyaCharacterStylingVariations,
  generateKoyaMangaSpeech,
  koyaEpisodePaths,
  planKoyaMangaProduction,
  readKoyaProductionState,
  reconcileKoyaRegisteredCharacterShowBibleStatus,
  recordKoyaCharacterStylingReviewFailure,
  registerKoyaCharacterIdentity,
  refreshKoyaRegisteredCharacterIdentityPack,
  repairKoyaCharacterIdentityPack,
  repackKoyaCharacterIdentityPack,
  repairKoyaMangaAudioOnset,
  repairKoyaMangaAudioTail,
  renderKoyaMangaVideo,
  runKoyaMangaFullProduction,
  runKoyaWardrobeReadiness,
  koyaWardrobeReadinessPauseResult,
  refreshKoyaMangaBubbles,
  standardizeKoyaMangaCut,
  substituteKoyaMangaCutVideos,
  syncKoyaMangaContract,
  selectKoyaCharacterStylingVariation,
} from "../lib/koyaMangaProduction.mjs";
import { createKoyaOuterJobBinding } from "../lib/koyaOuterJobBinding.mjs";
import { resolveKoyaDialogueAdapter, resolveKoyaMangaProductionContract } from "../lib/koyaMangaProductionContract.mjs";
import {
  approveKoyaVoiceAudition,
  createKoyaVoiceAuditionCandidatesTemplate,
  createKoyaVoiceAuditionPlan,
  koyaVoiceAuditionPaths,
  writeKoyaVoiceAuditionPlan,
} from "../lib/koyaVoiceAudition.mjs";
import { disposeMediaGenerationResources } from "../lib/mediaGeneration.mjs";
import {
  composeCharacterCandidateQaSheet,
  composeCharacterStylingQaSheet,
  importCharacterCandidateRebuild,
  migrateLegacyCharacterCandidateBlindArtifacts,
  readCharacterWorkflowStore,
  refreshCharacterCandidateReviewDrafts,
  refreshCharacterStylingReviewDraft,
} from "../lib/characterPipeline.mjs";
import {
  exportKoyaHandoffBundle,
  restoreKoyaHandoffBundle,
  verifyKoyaHandoffBundle,
} from "../lib/koyaHandoffBundle.mjs";
import {
  auditKoyaCharacterBootstrap,
  auditKoyaFixedCastReadiness,
  auditKoyaLocationAnchorReview,
  auditKoyaStory,
  assertProductionChannelAuthority,
  auditKoyaThumbnailPlan,
  buildKoyaLocationBoardPlan,
  createKoyaLocationAnchorReviewDraft,
  createKoyaLocationReviewDraft,
  createKoyaStoryReviewDraft,
  createKoyaThumbnailPlanDraft,
  generateKoyaLocationBoards,
  importKoyaLocationBoards,
  readKoyaChannelAuthority,
  registerApprovedKoyaLocation,
  resolveKoyaValidationCanary,
} from "../lib/koyaChannelGovernance.mjs";
import { parseMangaScript } from "../lib/mangaVideoPipeline.mjs";
import { readCharacterRegistry } from "../lib/characterRegistry.mjs";
import { auditKoyaCharacterRosterReview, createKoyaCharacterRosterReviewDraft } from "../lib/koyaCharacterRosterReview.mjs";
import { appendManagedToolsToPath } from "../lib/prerequisiteTools.mjs";

// setup が ~/.buzzassist/tools に入れた ffmpeg / ffprobe を各工程に見せる（運営者の PATH が先）。
appendManagedToolsToPath(process.env);

// usage() に載っていないが実装が読む flag。usage の `--flag` 一覧と合わせて既知集合を作る。
// 上位 Job 層（videoHarnessAdapters）が full へ渡す upstream binding もここに含める。
const EXTRA_KNOWN_FLAGS = Object.freeze([
  "--project-dir", "--contract-path", "--override-path", "--file-name", "--render-concurrency", "--revision-delta",
  "--reading-dictionary-path", "--candidate-rebuild-spec-path", "--reviewer-trust-path",
  "--upstream-job-id", "--upstream-job-path", "--upstream-job-revision", "--upstream-preflight-binding",
  "--upstream-execution-binding",
]);

function knownFlags() {
  const flags = new Set(EXTRA_KNOWN_FLAGS);
  for (const match of usage().matchAll(/--[a-z0-9-]+/gu)) flags.add(match[0]);
  return flags;
}

/**
 * 未知の flag は黙って捨てない（R6-F1 / R6-3）。以前は `full` に渡された --reviewer-trust-path が
 * 解析はされるのに読まれず、上位が照合した信頼リスト path が子で消えていた。既存の呼び出しを壊さない
 * よう、未知 flag は**エラーにせず stderr へ警告**し、値は従来どおり保持する。
 */
function parseArgs(argv, { warn = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const values = { action: argv[2] || "help" };
  const known = knownFlags();
  const unknown = [];
  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    if (!known.has(token)) unknown.push(token);
    const key = token.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) values[key] = true;
    else { values[key] = next; index += 1; }
  }
  if (unknown.length > 0) {
    warn(`warning: unknown option(s) ${unknown.join(", ")} — not documented in usage; check the spelling (see \`node scripts/koya-manga-video.mjs help\`).`);
  }
  return values;
}

function usage() {
  return [
    "Koya manga video production (fail-closed)",
    "",
    "node scripts/koya-manga-video.mjs <action> [options]",
    "actions: contract, channel-contract, wardrobe-readiness, character-bootstrap-status, character-registration-reconcile, character-roster-review-draft, character-roster-audit, cast-readiness, story-review-draft, story-audit, location-plan, location-generate, location-import, location-anchor-review-draft, location-anchor-audit, location-review-draft, location-register, thumbnail-plan-draft, thumbnail-audit, handoff-export, handoff-verify, handoff-restore, voice-audition, voice-approve, plan, images, character-review-refresh, character-candidate-migrate-blind, character-candidate-import, character-style-generate, character-style-import, character-style-review-refresh, character-style-record-failure, character-style-compose, character-style-select, character-attribute-gate, character-approve, character-identity-refresh, character-identity-repair, character-identity-repack, character-register, prepare, speech, video-substitute, adjust-gap, standard-cut, repair-onset, repair-tail, sync-contract, refresh-bubbles, render, audit, reviewer-key-create, signoff, full, status",
    "common: --project-dir DIR --episode-id ID --script-path FILE --title TITLE --protagonist-speaker-id ID_OR_EXACT_NAME --character-bible-path JSON [--story-review-path JSON] [--source-face-review-path JSON] [--generator-host codex|claude|legacy-migration] [--generator-id ID] [--generator-context-id TASK_OR_SESSION_ID] [--retry-failed] [--image-concurrency N|auto] [--qa-concurrency N] [--speech-concurrency N|auto] [--image-fallback-model MODEL] [--qa-fallback-provider grok]",
    "wardrobe-readiness: --episode-id ID [--script-path FILE] [--wardrobe-review-path JSON] (free script-driven outfit gate; writes canvas/assets/<episode-id>/wardrobe-readiness.json. exit 0 = every checked character has an outfit for every scene, exit 2 = pending slots. images/full refuse to start without a passing report for the exact script)",
    "audit: [--video-path MP4] [--revision-delta TEXT] (final audit; from the 2nd quality-loop round on, pass what was fixed for the previous failure, or write audits/koya-final/revision-delta.json; without it the audit stops for a human instead of recording the round)",
    "story-audit: --script-path FILE --story-review-path JSON --protagonist-speaker-id ID_OR_EXACT_NAME (read-only; binds reversal beats and human policy checks to the exact script SHA-256)",
    "story-review-draft: --script-path FILE [--protagonist-speaker-id ID_OR_EXACT_NAME] (read-only; prints exact utterance inventory with all subjective fields unset and machine-suggested eyeOpenBeats to confirm)",
    "cast-readiness: --script-path FILE [--character-bible-path JSON] (read-only; blocks episode-local replacements for unregistered Koya fixed cast and checks required identity roles)",
    "character-bootstrap-status: read-only fixed-cast progress report across the show bible, workflows, candidate reviews, styling rounds, registry assets, and next legal action",
    "character-registration-reconcile: --workflow-id ID --cast-id ID_OR_NAME (promotes only an already registered, SHA-bound client-approved cast member to show-bible approved)",
    "character-roster-review-draft: --generator-host codex|claude --generator-id ID --generator-context-id TASK_OR_SESSION (writes the 11-member/55-pair review draft only after all members are individually registered)",
    "character-roster-audit: [--roster-review-path JSON] (validates current identity-face/review SHA evidence and all 55 independent pair checks)",
    "location-plan: --location-id yamatani|apparecho-night [--output-dir DIR] (read-only; four independent architecture-board jobs)",
    "location-generate: --location-id ID --location-stage anchor|continuity --generator-host codex|claude --generator-id ID --generator-context-id TASK_OR_SESSION [--location-anchor-review-path JSON for continuity] [--model MODEL] [--force] (combined all-stage generation is forbidden; continuity requires a separately reviewed anchor)",
    "location-import: --location-id ID --import-map-path FILE [--output-dir DIR] (no paid call; copies boards made in a chat-based image tool into the planned paths from a koya-location-import-map-v1 map that SHA-binds every required board's source file, generator {host,id,contextId,generatedAt}, the prompt actually used (promptText, or promptPath + promptSha256), referenceImages [{path,sha256,role anchor|derived|style|other}] and importedBy {host,id,contextId}; continuity views must list the imported anchor as their role anchor reference, except a board edited from previously approved images of this location, which lists those images as role derived instead (no anchor SHA is bound and its architecture continuity is judged by eye through architectureLockPass); moves differing older files and the older manifest into superseded-<timestamp>/, never deletes, and never records an anchor approval; a board made before anyone kept those records may say so instead of inventing them, with provenanceGap {reason, specificationPath, specificationSha256} naming the written specification the image was made to satisfy plus whichever of promptRecorded, generatorContextRecorded and referenceImagesRecorded is false; the three are independent, only false is accepted, and each one removes what it says was never kept: promptRecorded drops promptText/promptPath, generatorContextRecorded drops generator.contextId, and referenceImagesRecorded requires referenceImages [] with no anchor reference, so that board carries no anchor SHA and its architecture continuity has to be judged by eye through the ordinary architectureLockPass check; every review of a board with any gap also needs the extra check provenanceGapAcknowledged set true by the independent reviewer; map shape: docs/examples/koya-location-import-map.example.json, gap example: docs/examples/koya-location-import-map-provenance-gap.example.json)",
    "location-anchor-review-draft: --location-id ID [--output-dir DIR] (read-only; hashes the generated anchor and leaves perceptual checks false)",
    "location-anchor-audit: --location-id ID --location-anchor-review-path JSON (read-only; verifies the anchor review before continuity generation)",
    "location-review-draft: --location-id ID [--output-dir DIR] [--location-anchor-review-path JSON] (read-only; hashes current planned files and leaves perceptual checks false; imported boards bind the passed anchor review as anchorApproval)",
    "location-register: --location-id ID --location-review-path JSON (requires four SHA-bound original-scale independent reviews)",
    "thumbnail-audit: --thumbnail-plan-path JSON (read-only; blocks pending brand tokens, copy violations, and final artwork reuse)",
    "thumbnail-plan-draft: [--layout twoPanel|threePanel] (read-only; prints a fail-closed plan template)",
    "source region fallback: inspect the exact source image and pass a koya-source-region-review-v2 JSON whose annotations bind normalized face/hand/prop/evidence/text bounds to the source SHA-256 (legacy koya-source-face-review-v1 remains accepted)",
    `audit: --video-path MP4 [--quick] [--dry-run] [--reviewer-trust-path JSON] (the reviewer trust list comes only from the operator's ${REVIEWER_TRUST_ENV_GUIDANCE}; --reviewer-trust-path is a cross-check and must match that list or the action stops with reviewer-trust-conflict, and without the environment variable it stops with reviewer-trust-unconfigured; the signoff's Ed25519 reviewer attestation is re-verified against it)`,
    "character-approve: --workflow-id ID --cast-id ID_OR_NAME --candidate-label A..E --approval-reason WHY --candidate-review-path JSON --generator-context-id TASK_OR_SESSION [--approved-by NAME] [--identity-generation-import-map-path JSON] (generates or imports a SHA/input-bound pending identity pack; does not register)",
    "character-identity-repair: --episode-id ID --workflow-id ID --cast-id ID_OR_NAME (--identity-review-path FAILED_REVIEW_JSON | --identity-findings-path FINDINGS_JSON --identity-repair-plan-path REPAIR_PLAN_JSON) --identity-repair-id UNIQUE_ID --generator-host codex|claude --generator-id ID --generator-context-id TASK_OR_SESSION [--identity-generation-import-map-path JSON] (revalidates failed evidence; findings mode applies findingId/ROI repair and SHA-bound import while preserving protected pixels)",
    "character-identity-refresh: --episode-id ID --workflow-id ID --cast-id ID_OR_NAME --identity-refresh-id UNIQUE_ID --generator-host codex|claude --generator-id ID --generator-context-id TASK_OR_SESSION [--identity-generation-import-map-path JSON] (keeps the already registered identity-face SHA frozen, regenerates or SHA/input-bound imports only turnaround/expression, and stages fresh QA without face reapproval)",
    "character-identity-repack: --episode-id ID --workflow-id ID --cast-id ID_OR_NAME (--identity-review-path FAILED_REVIEW_JSON | --identity-findings-path FINDINGS_JSON --identity-repair-plan-path REPAIR_PLAN_JSON) --identity-repair-id UNIQUE_ID --generator-context-id TASK_OR_SESSION (for turnaround/expression/eye-open boundary failures: archives or binds the failure evidence, redraws nothing, extracts existing views from actual white gutters, and contains them in exact cells with 8% clearance before fresh QA)",
    "character-review-refresh: --workflow-id ID [--cast-id ID_OR_NAME] --generator-host legacy-migration --generator-context-id MIGRATION_ID (rebuilds v2 review drafts from existing anonymous artifacts; no paid generation and no auto-approval)",
    "character-candidate-migrate-blind: --workflow-id ID --cast-id ID --candidate-labels A,B,C[,D,E] [--retired-candidate-labels F] --migration-reason WHY --generator-host legacy-migration --generator-id ID --generator-context-id ID (rebuilds a published-label A-E packet from existing canvas assets, retires explicitly excluded legacy extras, and never auto-approves)",
    "character-candidate-import: --workflow-id ID --cast-id ID --candidate-import-map-path JSON --generator-host codex|claude|legacy-migration --generator-id ID --generator-context-id ID (imports SHA-bound candidate images, supports per-entry source generators for archival mixed-origin migration, archives the superseded packet, rebuilds anonymous artifacts, and requires fresh independent review)",
    "character-candidate-qa-sheet: --workflow-id ID --cast-id ID (writes a non-authoritative A/B/C original-scale comparison sheet before independent review)",
    "character-style-generate: --episode-id ID --workflow-id ID --cast-id ID_OR_NAME --base-candidate-label A..E --candidate-review-path JSON --styling-spec-path JSON --selection-reason WHY --generator-host codex|claude --generator-context-id TASK_OR_SESSION [--styling-round-id STABLE_ID] [--styling-comparison-reference-paths path1,path2] [--styling-repair-source-path PASSED_OPTION] (generates each option separately; an optional repair source must be a prior SHA-bound independently passed option; exclusion references remain QA-only)",
    "character-style-import: same identity/spec/review inputs plus --styling-import-map-path JSON --styling-round-id ID --generator-host legacy-migration --generator-id ID --generator-context-id ID [--supersede-styling-round-id AWAITING_SELECTION_ID] [--corrective-supersede-reason LATER_REQUIREMENT] (imports existing SHA-bound generated sheets without auto-approval; ordinary consolidation carries old options, while a corrective supersede preserves but retires a wrong-spec round)",
    "character-style-qa-sheet: --workflow-id ID --cast-id ID --styling-round-id ID (writes a clearly watermarked pre-review comparison sheet and includes non-similarity references when declared)",
    "character-style-review-refresh: --workflow-id ID --cast-id ID --styling-round-id ID (rebuilds the unreviewed draft and fresh machine hair-color distance evidence without regenerating images)",
    "character-style-record-failure: --episode-id ID --workflow-id ID --cast-id ID_OR_NAME --styling-round-id ID --styling-review-path JSON (records a complete independent review that missed the minimum count, closes the round, preserves all bytes, and permits a new repair round)",
    "character-style-compose: --episode-id ID --workflow-id ID --cast-id ID_OR_NAME --styling-round-id ID --styling-review-path JSON (composes only independently reviewed passing sheets; no image model)",
    "character-attribute-gate: --inventory-path FILE [--output-path FILE] (R192/R196 mandatory attribute gates for a character sheet set; per-asset coverage + human eye-side attestation; must pass before the setting-sheet stage)",
    "character-style-select: --episode-id ID --workflow-id ID --cast-id ID_OR_NAME --styling-round-id ID --styling-option-id ID --selection-reason WHY [--selected-by NAME] (binds one reviewed individual asset; does not register the person)",
    "character-register: --workflow-id ID --cast-id ID_OR_NAME --identity-review-path JSON (requires real turnaround + eight-view + twelve-cell SHA-bound QA)",
    "repair-onset: --utterance-id ID --source-path WAV --fade-start-seconds N --fade-milliseconds 6..8 --output-file-name NAME.wav",
    "repair-tail: --utterance-id ID --source-path WAV --speech-end-seconds N --fade-start-seconds N --fade-milliseconds 6..8 --output-file-name NAME.wav",
    "adjust-gap: --utterance-id ID --target-audible-gap-seconds N [--reason TEXT]",
    "standard-cut: --cut-id ID --plan-path JSON [--reason TEXT] (remove split layout and apply validated ordinary single-image shots)",
    "sync-contract: update manifest contract metadata without changing media, then require a fresh audit",
    "refresh-bubbles: rebuild every SVG under the resolved punctuation/placement contract, then require a fresh render and audit",
    "video-substitute: opt-in per-cut clip substitution for cuts marked in config/koya-manga-episode-overrides/<episode-id>.json (override.videoSubstitution.model + cuts[{cutId,motionPrompt,reason}], at most 2); runs after speech and before render. Without --confirm-paid-generation it only builds the start frames and prints the paid plan (exit 3). [--cut-ids cut-01] [--retry-failed] (re-submits a failed or charge-unknown attempt within the contract attempt cap) [--allow-still-fallback --still-fallback-cut-ids cut-01 --still-fallback-reason WHY --still-fallback-decided-by NAME] (renders that marked cut as the still; recorded and audited). full uses the same stage and needs --confirm-paid-video-generation to spend (--retry-failed-video re-submits there).",
    "render: [--cut-ids cut-01,cut-02] rerenders at least the named cuts; unselected cuts are reused only when their completed input hash still matches and the MP4 decodes",
    `full: --episode-id ID --script-path FILE [--reviewer-trust-path JSON] (paid production runner; stops before any paid generation unless the operator's reviewer trust list from ${REVIEWER_TRUST_ENV_GUIDANCE} is configured, readable, and holds at least one active key — reviewer-trust-unconfigured / reviewer-trust-invalid; an explicit --reviewer-trust-path is only cross-checked against it — reviewer-trust-conflict)`,
    `signoff: --reviewer claude|codex [--reviewer-id ID] [--reviewer-context-id TASK_OR_SESSION_ID] --review-notes-path /absolute/review.json --reviewer-key-path /absolute/reviewer-ed25519.pem [--reviewer-trust-path JSON] --pass (the evaluator task/session must differ from the generator; the private key is read from the file, never from argv, and must be listed as active in the operator's trust list from ${REVIEWER_TRUST_ENV_GUIDANCE}; --reviewer-trust-path only cross-checks that list and never replaces it)`,
    "reviewer-key-create: --reviewer-key-path /absolute/outside-repo/reviewer-ed25519.pem [--reviewer-public-key-path FILE] [--reviewer-label NAME] (writes a new Ed25519 private key with mode 0600, refuses to overwrite either file, refuses paths inside this repository, --project-dir, or any git working tree, and prints the keyId plus the trust-list entry the operator registers out of band)",
    "handoff-export: [--output-dir DIR] [--bundle-id ID] [--character-ids id1,id2] [--visual-profile-ids id1] [--force] (exports only approved Koya data and SHA evidence; excludes candidate mappings, sessions and credentials)",
    "images/full wardrobe override: --wardrobe-readiness-override-reason TEXT starts the paid images without a passing wardrobe-readiness report; the reason is recorded in the inventory and the episode state and reported by the final audit",
    "speech: R194 voice quality gate is always on; [--take-count 2..8] [--max-adaptive-takes 2..8]; --no-voice-quality-gate requires --voice-quality-gate-override-reason",
    "voice-audition: [--episode-id REGISTRY_SCOPE (default global = fixed cast)] --character-ids id1,id2 [--candidates-path JSON] writes a koya-voice-audition-candidates-v1 template (never overwrites); then --candidates-path JSON [--confirm-paid-preview] has every candidate voice read the same sampleLine through the contract's voice.dialogue adapter and writes the anonymous A-E listening page, the private mapping and the selections file. Without --confirm-paid-preview it only prints how many paid previews are pending (exit 3); existing previews whose SHA-256 still matches are reused, never paid again.",
    "voice-approve: [--episode-id REGISTRY_SCOPE] [--selections-path JSON] --approved-by NAME (the person who listened; records winnerLabel, selectionReason and previewConfirmed=true in the verdicts before opening the private mapping, then writes the human voice selection (selectionVersion 2) to the character registry)",
    "handoff-verify: --bundle-dir DIR (read-only full manifest/SHA/path/symlink verification)",
    "handoff-restore: --bundle-dir DIR (requires the matching installed production contract, then merges approved registry/profile data)",
  ].join("\n");
}

const args = parseArgs(process.argv);
const projectDir = resolve(args.projectDir || process.cwd());
const common = {
  projectDir,
  episodeId: args.episodeId,
  scriptPath: args.scriptPath ? resolve(args.scriptPath) : "",
  title: args.title,
  contractPath: args.contractPath ? resolve(args.contractPath) : "",
  overridePath: args.overridePath ? resolve(args.overridePath) : "",
  protagonistSpeakerId: args.protagonistSpeakerId || "",
  wardrobeReviewPath: args.wardrobeReviewPath ? resolve(args.wardrobeReviewPath) : "",
  // 衣装ゲートを外すのは監査に残る人の判断で、素の flag では外せない。
  wardrobeReadinessOverrideReason: typeof args.wardrobeReadinessOverrideReason === "string"
    ? args.wardrobeReadinessOverrideReason
    : "",
  // R194: the voice quality gate is ON for every official speech run. Turning
  // it off is an audited human override, never a default or an env-only flag.
  voiceQualityGate: args.noVoiceQualityGate === true ? false : true,
  voiceQualityGateOverrideReason: args.voiceQualityGateOverrideReason || "",
  takeCount: args.takeCount ? Number(args.takeCount) : undefined,
  maxAdaptiveTakes: args.maxAdaptiveTakes ? Number(args.maxAdaptiveTakes) : undefined,
  readingDictionaryPath: args.readingDictionaryPath ? resolve(args.readingDictionaryPath) : "",
  characterBiblePath: args.characterBiblePath ? resolve(args.characterBiblePath) : "",
  sourceFaceReviewPath: args.sourceFaceReviewPath ? resolve(args.sourceFaceReviewPath) : "",
  storyReviewPath: args.storyReviewPath ? resolve(args.storyReviewPath) : "",
  rosterReviewPath: args.rosterReviewPath ? resolve(args.rosterReviewPath) : "",
  cutIds: args.cutIds || "",
  retryFailed: args.retryFailed === true,
  imageConcurrency: args.imageConcurrency,
  qaConcurrency: args.qaConcurrency,
  speechConcurrency: args.speechConcurrency,
  imageFallbackModel: args.imageFallbackModel,
  qaFallbackProvider: args.qaFallbackProvider,
  generatorHost: args.generatorHost,
  generatorId: args.generatorId,
  generatorContextId: args.generatorContextId,
  candidateReviewPath: args.candidateReviewPath ? resolve(args.candidateReviewPath) : "",
  candidateImportMapPath: args.candidateImportMapPath ? resolve(args.candidateImportMapPath) : "",
  candidateRebuildSpecPath: args.candidateRebuildSpecPath ? resolve(args.candidateRebuildSpecPath) : "",
  stylingSpecPath: args.stylingSpecPath ? resolve(args.stylingSpecPath) : "",
  stylingImportMapPath: args.stylingImportMapPath ? resolve(args.stylingImportMapPath) : "",
  stylingComparisonReferencePaths: args.stylingComparisonReferencePaths || "",
  stylingRepairSourcePath: args.stylingRepairSourcePath ? resolve(args.stylingRepairSourcePath) : "",
  stylingReviewPath: args.stylingReviewPath ? resolve(args.stylingReviewPath) : "",
  stylingRoundId: args.stylingRoundId,
  supersedeStylingRoundId: args.supersedeStylingRoundId,
  correctiveSupersedeReason: args.correctiveSupersedeReason,
  stylingOptionId: args.stylingOptionId,
  baseCandidateLabel: args.baseCandidateLabel,
  selectionReason: args.selectionReason,
  selectedBy: args.selectedBy,
  identityReviewPath: args.identityReviewPath ? resolve(args.identityReviewPath) : "",
  identityGenerationImportMapPath: args.identityGenerationImportMapPath ? resolve(args.identityGenerationImportMapPath) : "",
  identityFindingsPath: args.identityFindingsPath ? resolve(args.identityFindingsPath) : "",
  identityRepairPlanPath: args.identityRepairPlanPath ? resolve(args.identityRepairPlanPath) : "",
  identityRepairId: args.identityRepairId,
  identityRefreshId: args.identityRefreshId,
  upstreamJobPath: args.upstreamJobPath ? resolve(args.upstreamJobPath) : "",
  upstreamJobId: args.upstreamJobId || "",
  upstreamJobRevision: args.upstreamJobRevision,
  upstreamPreflightBinding: args.upstreamPreflightBinding || "",
};

function assertWardrobeOverrideReason() {
  if (args.wardrobeReadinessOverrideReason === true) {
    throw new Error("--wardrobe-readiness-override-reason requires TEXT explaining why the paid images start without a wardrobe-readiness pass.");
  }
}

function requireEpisodeId() {
  if (!args.episodeId) throw new Error("--episode-id is required for this action.");
  return args.episodeId;
}

function print(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

// full reuses --retry-failed for images; re-sending a paid clip must be its own
// explicit decision there, so full reads --retry-failed-video instead. The
// stage option has its own key so it never changes the image retry flag.
function videoSubstitutionOptions({ confirmFlag, retryFlag }) {
  const allowStillFallback = args.allowStillFallback === true;
  if (!allowStillFallback && (args.stillFallbackCutIds || args.stillFallbackReason || args.stillFallbackDecidedBy)) {
    throw new Error("--still-fallback-* options require --allow-still-fallback.");
  }
  return {
    confirmPaidVideoGeneration: args[confirmFlag] === true,
    retryFailedVideo: args[retryFlag] === true,
    // full processes every marked cut; --cut-ids there limits the render only.
    videoSubstitutionCutIds: args.action === "video-substitute" ? args.cutIds || "" : "",
    stillFallback: allowStillFallback
      ? {
        cutIds: String(args.stillFallbackCutIds || "").split(",").map((value) => value.trim()).filter(Boolean),
        reason: args.stillFallbackReason || "",
        decidedBy: args.stillFallbackDecidedBy || "",
      }
      : null,
  };
}

function videoSubstitutionPayload(result) {
  return {
    episodeId: result.episodeId,
    status: result.status,
    model: result.model,
    rows: result.rows,
    blocked: result.blockedCuts,
    stageReportPath: result.stageReportPath,
    ledgerPath: result.ledgerPath,
    checkpoint: result.paths.statePath,
  };
}

async function scriptPathForResume() {
  if (common.scriptPath) return common.scriptPath;
  if (!args.episodeId) return "";
  try {
    const { state } = await readKoyaProductionState({ projectDir, episodeId: args.episodeId });
    return state.scriptPath || "";
  } catch {
    return "";
  }
}

async function auditOptions() {
  const episodeId = requireEpisodeId();
  const paths = koyaEpisodePaths(projectDir, episodeId);
  return {
    projectDir,
    manifestPath: paths.manifestPath,
    videoPath: args.videoPath ? resolve(args.videoPath) : "",
    quick: args.quick === true,
    dryRun: args.dryRun === true,
    reviewerTrustPath: typeof args.reviewerTrustPath === "string" ? resolve(args.reviewerTrustPath) : "",
    // 品質ループの2回目以降で、前回の失敗をどう直したか。無ければ audit は人待ちで止まる。
    revisionDelta: typeof args.revisionDelta === "string" ? args.revisionDelta : "",
  };
}

async function canonicalOuterJobContext() {
  const preflight = await assertKoyaFullPreflight(common);
  const outerJobBinding = createKoyaOuterJobBinding({
    jobId: preflight.jobId,
    identityDigest: preflight.identityDigest,
    executionIdentityDigest: preflight.executionIdentityDigest,
    resolvedProductionContractSha256: preflight.resolvedProductionContractSha256,
  });
  if (!outerJobBinding) throw new Error("Koya canonical outer Job binding is required.");
  return { preflight, outerJobBinding };
}

let exitCode = 0;
try {
switch (args.action) {
  case "help":
  case "--help":
  case "-h":
    process.stdout.write(`${usage()}\n`);
    break;
  case "contract": {
    const resolvedContract = await resolveKoyaMangaProductionContract({
      projectDir,
      episodeId: args.episodeId,
      contractPath: common.contractPath || undefined,
      overridePath: common.overridePath || undefined,
    });
    print({
      version: resolvedContract.contract.version,
      digest: resolvedContract.digest,
      contractPath: resolvedContract.contractPath,
      episodeOverridePath: resolvedContract.episodeOverridePath,
      validation: resolvedContract.validation,
    });
    break;
  }
  case "channel-contract": {
    const authority = await readKoyaChannelAuthority({ projectDir });
    print({ source: authority.source, root: authority.root, paths: authority.paths, validation: authority.validation });
    break;
  }
  case "character-bootstrap-status": {
    const authority = await readKoyaChannelAuthority({ projectDir });
    const [registry, workflowStore] = await Promise.all([
      readCharacterRegistry({ projectDir }),
      readCharacterWorkflowStore({ projectDir }),
    ]);
    const result = await auditKoyaCharacterBootstrap({ showBible: authority.showBible, registry, workflowStore });
    print(result);
    if (!result.pass) exitCode = 2;
    break;
  }
  case "character-registration-reconcile": {
    const result = await reconcileKoyaRegisteredCharacterShowBibleStatus({
      projectDir,
      workflowId: args.workflowId,
      castId: args.castId,
    });
    print(result);
    break;
  }
  case "character-roster-review-draft": {
    const authority = await readKoyaChannelAuthority({ projectDir });
    const registry = await readCharacterRegistry({ projectDir });
    const result = await createKoyaCharacterRosterReviewDraft({
      projectDir,
      showBible: authority.showBible,
      registry,
      generatorHost: args.generatorHost,
      generatorId: args.generatorId,
      generatorContextId: args.generatorContextId,
    });
    print(result);
    if (!result.ready) exitCode = 2;
    break;
  }
  case "character-roster-audit": {
    const authority = await readKoyaChannelAuthority({ projectDir });
    const registry = await readCharacterRegistry({ projectDir });
    const result = await auditKoyaCharacterRosterReview({ projectDir, showBible: authority.showBible, registry, reviewPath: common.rosterReviewPath });
    print(result);
    if (!result.pass) exitCode = 2;
    break;
  }
  case "cast-readiness": {
    if (!common.scriptPath) throw new Error("--script-path is required for cast-readiness.");
    const authority = await readKoyaChannelAuthority({ projectDir });
    const scriptText = await readFile(common.scriptPath, "utf8");
    const registry = await readCharacterRegistry({ projectDir });
    const rosterReviewAudit = await auditKoyaCharacterRosterReview({ projectDir, showBible: authority.showBible, registry, reviewPath: common.rosterReviewPath });
    const resolved = args.episodeId ? await resolveKoyaMangaProductionContract({
      projectDir,
      episodeId: args.episodeId,
      contractPath: common.contractPath || undefined,
      overridePath: common.overridePath || undefined,
    }) : null;
    const validationCanary = resolveKoyaValidationCanary({
      episodeId: args.episodeId,
      policy: resolved?.episodeOverride?.validationCanary,
      showBible: authority.showBible,
    });
    const parsed = parseMangaScript(scriptText, { title: args.title, registry });
    const characterBible = common.characterBiblePath ? JSON.parse(await readFile(common.characterBiblePath, "utf8")) : null;
    const result = auditKoyaFixedCastReadiness({ showBible: authority.showBible, registry, parsed, characterBible, enforce: authority.source === "project", rosterReviewAudit, validationCanary });
    print(result);
    if (!result.pass) exitCode = 2;
    break;
  }
  case "story-audit": {
    if (!common.scriptPath) throw new Error("--script-path is required for story-audit.");
    if (!common.storyReviewPath) throw new Error("--story-review-path is required for story-audit.");
    const authority = await readKoyaChannelAuthority({ projectDir });
    const scriptText = await readFile(common.scriptPath, "utf8");
    const storyReview = JSON.parse(await readFile(common.storyReviewPath, "utf8"));
    const characterBible = common.characterBiblePath ? JSON.parse(await readFile(common.characterBiblePath, "utf8")) : null;
    const registry = await readCharacterRegistry({ projectDir });
    const parsed = parseMangaScript(scriptText, { title: args.title, registry });
    const result = auditKoyaStory({
      showBible: authority.showBible,
      registry,
      scriptText,
      title: parsed.title,
      parsed,
      storyReview,
      declaredCast: (characterBible?.cast || []).flatMap((entry) => [entry?.id, entry?.name]).filter(Boolean),
      enforce: true,
    });
    print(result);
    if (!result.pass) exitCode = 2;
    break;
  }
  case "story-review-draft": {
    if (!common.scriptPath) throw new Error("--script-path is required for story-review-draft.");
    const authority = await readKoyaChannelAuthority({ projectDir });
    const scriptText = await readFile(common.scriptPath, "utf8");
    const registry = await readCharacterRegistry({ projectDir });
    const parsed = parseMangaScript(scriptText, { title: args.title, registry });
    print(createKoyaStoryReviewDraft({ showBible: authority.showBible, scriptText, parsed, registry, protagonistSpeakerId: args.protagonistSpeakerId }));
    break;
  }
  case "location-plan": {
    const authority = await readKoyaChannelAuthority({ projectDir });
    print(buildKoyaLocationBoardPlan({
      projectDir,
      locationBible: authority.locationBible,
      showBible: authority.showBible,
      locationId: args.locationId,
      outputDir: args.outputDir ? resolve(args.outputDir) : "",
    }));
    break;
  }
  case "location-generate": {
    const result = await generateKoyaLocationBoards({
      projectDir,
      locationId: args.locationId,
      stage: args.locationStage,
      outputDir: args.outputDir ? resolve(args.outputDir) : "",
      model: args.model,
      force: args.force === true,
      anchorReviewPath: args.locationAnchorReviewPath ? resolve(args.locationAnchorReviewPath) : "",
      generator: { host: args.generatorHost, id: args.generatorId, contextId: args.generatorContextId },
    });
    print(result);
    break;
  }
  case "location-import": {
    if (!args.locationId) throw new Error("--location-id is required for location-import.");
    if (typeof args.importMapPath !== "string") throw new Error("--import-map-path is required for location-import.");
    const result = await importKoyaLocationBoards({
      projectDir,
      locationId: args.locationId,
      importMapPath: resolve(args.importMapPath),
      outputDir: args.outputDir ? resolve(args.outputDir) : "",
    });
    print(result);
    break;
  }
  case "location-anchor-review-draft": {
    const authority = await readKoyaChannelAuthority({ projectDir });
    print(await createKoyaLocationAnchorReviewDraft({
      projectDir,
      locationBible: authority.locationBible,
      showBible: authority.showBible,
      locationId: args.locationId,
      outputDir: args.outputDir ? resolve(args.outputDir) : "",
    }));
    break;
  }
  case "location-anchor-audit": {
    if (!args.locationAnchorReviewPath) throw new Error("--location-anchor-review-path is required for location-anchor-audit.");
    const authority = await readKoyaChannelAuthority({ projectDir });
    const review = JSON.parse(await readFile(resolve(args.locationAnchorReviewPath), "utf8"));
    const result = await auditKoyaLocationAnchorReview({
      projectDir,
      locationBible: authority.locationBible,
      showBible: authority.showBible,
      locationId: args.locationId,
      outputDir: args.outputDir ? resolve(args.outputDir) : "",
      review,
    });
    print(result);
    if (!result.pass) exitCode = 2;
    break;
  }
  case "location-review-draft": {
    const authority = await readKoyaChannelAuthority({ projectDir });
    print(await createKoyaLocationReviewDraft({
      projectDir,
      locationBible: authority.locationBible,
      showBible: authority.showBible,
      locationId: args.locationId,
      outputDir: args.outputDir ? resolve(args.outputDir) : "",
      anchorReviewPath: args.locationAnchorReviewPath ? resolve(args.locationAnchorReviewPath) : "",
    }));
    break;
  }
  case "location-register": {
    const result = await registerApprovedKoyaLocation({
      projectDir,
      locationId: args.locationId,
      reviewPath: args.locationReviewPath ? resolve(args.locationReviewPath) : "",
    });
    print({ location: result.location, registryRevision: result.registryRevision, reviewPass: result.audit.pass });
    break;
  }
  case "thumbnail-audit": {
    if (!args.thumbnailPlanPath) throw new Error("--thumbnail-plan-path is required for thumbnail-audit.");
    const authority = await readKoyaChannelAuthority({ projectDir });
    const plan = JSON.parse(await readFile(resolve(args.thumbnailPlanPath), "utf8"));
    const result = await auditKoyaThumbnailPlan({ projectDir, thumbnailContract: authority.thumbnailContract, plan });
    print(result);
    if (!result.pass) exitCode = 2;
    break;
  }
  case "thumbnail-plan-draft": {
    const authority = await readKoyaChannelAuthority({ projectDir });
    print(createKoyaThumbnailPlanDraft({ thumbnailContract: authority.thumbnailContract, layout: args.layout }));
    break;
  }
  case "handoff-export": {
    const result = await exportKoyaHandoffBundle({
      projectDir,
      outputDir: args.outputDir ? resolve(args.outputDir) : "",
      bundleId: args.bundleId,
      characterIds: args.characterIds,
      visualProfileIds: args.visualProfileIds,
      force: args.force === true,
    });
    print(result);
    break;
  }
  case "handoff-verify": {
    const result = await verifyKoyaHandoffBundle({ bundleDir: args.bundleDir ? resolve(args.bundleDir) : "" });
    print(result);
    break;
  }
  case "handoff-restore": {
    const result = await restoreKoyaHandoffBundle({ projectDir, bundleDir: args.bundleDir ? resolve(args.bundleDir) : "" });
    print(result);
    break;
  }
  case "plan": {
    requireEpisodeId();
    if (!common.scriptPath) throw new Error("--script-path is required for plan.");
    await canonicalOuterJobContext();
    const result = await planKoyaMangaProduction(common);
    print({ episodeId: result.episodeId, state: result.state, paths: result.paths });
    break;
  }
  case "wardrobe-readiness": {
    const episodeId = requireEpisodeId();
    const scriptPath = await scriptPathForResume();
    const result = await runKoyaWardrobeReadiness({ ...common, scriptPath });
    print({
      episodeId,
      status: result.report.status,
      pass: result.report.pass,
      inventoryPath: result.reportPath,
      verdictDigest: result.report.verdictDigest,
      summary: result.report.summary,
      pendingSlotIds: result.report.pendingSlotIds,
      // 人の名前を伏せたせいで消えた場面キーワード（スロットは作らないが黙って落とさない）。
      maskedKeywordHits: result.report.scenes
        .filter((scene) => (scene.maskedKeywordHits || []).length > 0)
        .map((scene) => ({ sceneKey: scene.sceneKey, hits: scene.maskedKeywordHits })),
      slots: result.report.slots.map((slot) => ({
        slotId: slot.slotId,
        castId: slot.castId,
        sceneTags: slot.sceneTags,
        sceneRef: slot.sceneRef,
        status: slot.status,
        matchedOutfit: slot.matchedOutfit,
        requirement: slot.requirement,
      })),
      review: result.report.review
        ? { path: result.report.review.path, reviewer: result.report.review.reviewer.id, decisions: result.report.review.decisions.length }
        : null,
    });
    exitCode = result.exitCode;
    break;
  }
  case "images": {
    requireEpisodeId();
    assertWardrobeOverrideReason();
    if (!common.scriptPath) throw new Error("--script-path is required for images.");
    let result;
    try {
      result = await generateKoyaMangaImages(common);
    } catch (error) {
      const paused = koyaWardrobeReadinessPauseResult(error, { preflight: null, projectDir, episodeId: args.episodeId, stage: "images" });
      if (!paused) throw error;
      print(paused.payload);
      exitCode = paused.exitCode;
      break;
    }
    print({ episodeId: result.episodeId, status: result.state.status, waiting: result.waiting, paths: result.paths });
    if (result.waiting || result.failed) exitCode = 3;
    break;
  }
  case "character-review-refresh": {
    if (args.generatorHost !== "legacy-migration") {
      throw new Error("character-review-refresh requires --generator-host legacy-migration so migrated artifacts cannot be mistaken for fresh generation.");
    }
    const result = await refreshCharacterCandidateReviewDrafts({
      projectDir,
      workflowId: args.workflowId,
      castId: args.castId,
      generatorContextId: args.generatorContextId,
    });
    print({ workflowId: result.workflowId, refreshed: result.refreshed, status: "awaiting-independent-candidate-review" });
    break;
  }
  case "character-candidate-migrate-blind": {
    const result = await migrateLegacyCharacterCandidateBlindArtifacts({
      projectDir,
      workflowId: args.workflowId,
      castId: args.castId,
      candidateLabels: args.candidateLabels,
      retiredCandidateLabels: args.retiredCandidateLabels,
      migrationReason: args.migrationReason,
      generatorHost: args.generatorHost,
      generatorId: args.generatorId,
      generatorContextId: args.generatorContextId,
    });
    print({
      version: result.version,
      workflowId: result.workflowId,
      castId: result.castId,
      castName: result.castName,
      candidateSetId: result.candidateSetId,
      activeLabels: result.activeLabels,
      retiredLabels: result.retiredLabels,
      mappingConflicts: result.mappingConflicts,
      reviewDraftPath: result.reviewDraftPath,
      reportPath: result.reportPath,
      status: "awaiting-independent-candidate-review",
    });
    break;
  }
  case "character-candidate-import": {
    const result = await importCharacterCandidateRebuild({
      ...common,
      workflowId: args.workflowId,
      castId: args.castId,
    });
    print({ workflowId: result.workflow.id, castId: result.cast.id, evidencePath: result.evidencePath, evidenceSha256: result.evidenceSha256, reviewDraftPath: result.reviewDraftPath, status: "awaiting-independent-candidate-review" });
    break;
  }
  case "character-candidate-qa-sheet": {
    const result = await composeCharacterCandidateQaSheet({ ...common, workflowId: args.workflowId, castId: args.castId });
    print({ ...result, status: "unapproved-pre-review-qa-only" });
    break;
  }
  case "character-style-generate": {
    requireEpisodeId();
    const result = await generateKoyaCharacterStylingVariations({
      ...common,
      workflowId: args.workflowId,
      castId: args.castId,
    });
    print({ episodeId: result.episodeId, workflowId: result.workflowId, castId: result.castId, resumed: result.resumed, round: result.round, reviewDraftPath: result.reviewDraftPath, state: result.state });
    break;
  }
  case "character-style-import": {
    requireEpisodeId();
    const result = await importKoyaCharacterStylingVariations({
      ...common,
      workflowId: args.workflowId,
      castId: args.castId,
    });
    print(result);
    break;
  }
  case "character-style-qa-sheet": {
    const result = await composeCharacterStylingQaSheet({ ...common, workflowId: args.workflowId, castId: args.castId, roundId: args.stylingRoundId });
    print({ ...result, status: "unapproved-pre-review-qa-only" });
    break;
  }
  case "character-style-review-refresh": {
    const result = await refreshCharacterStylingReviewDraft({ ...common, workflowId: args.workflowId, castId: args.castId, roundId: args.stylingRoundId });
    print({ reviewDraftPath: result.reviewDraftPath, machineAxisMeasurement: result.machineAxisMeasurement, status: "awaiting-independent-styling-review" });
    break;
  }
  case "character-style-record-failure": {
    requireEpisodeId();
    const result = await recordKoyaCharacterStylingReviewFailure({ ...common, workflowId: args.workflowId, castId: args.castId });
    print(result);
    break;
  }
  case "character-style-compose": {
    requireEpisodeId();
    const result = await composeKoyaCharacterStylingReview({ ...common, workflowId: args.workflowId, castId: args.castId });
    print(result);
    break;
  }
  case "character-attribute-gate": {
    if (!args.inventoryPath) throw new Error("--inventory-path is required");
    const result = await runKoyaCharacterAttributeGate({
      projectDir,
      inventoryPath: resolve(args.inventoryPath),
      outputPath: args.outputPath ? resolve(args.outputPath) : "",
    });
    print({
      pass: result.decision.pass,
      machinePass: result.decision.machinePass,
      castId: result.decision.castId,
      failedCheckIds: result.decision.failedCheckIds,
      missingCoverage: result.decision.missingCoverage,
      missingHumanGates: result.decision.missingHumanGates,
      decision: result.outputPath,
    });
    if (!result.decision.pass) exitCode = 3;
    break;
  }
  case "character-style-select": {
    requireEpisodeId();
    const result = await selectKoyaCharacterStylingVariation({ ...common, workflowId: args.workflowId, castId: args.castId });
    print(result);
    break;
  }
  case "character-approve": {
    requireEpisodeId();
    const result = await approveKoyaCharacterCandidate({
      ...common,
      workflowId: args.workflowId,
      castId: args.castId,
      candidateLabel: args.candidateLabel,
      approvalReason: args.approvalReason,
      approvedBy: args.approvedBy,
      candidateReviewPath: args.candidateReviewPath ? resolve(args.candidateReviewPath) : "",
      generatorContextId: args.generatorContextId,
    });
    print({ episodeId: result.episodeId, workflowId: result.workflowId, castId: result.castId, candidateLabel: result.candidateLabel, candidateSetId: result.candidateSetId, verdictPath: result.verdictPath, resumed: result.resumed, generationCheckpointPath: result.generationCheckpointPath, identityReviewDraftPath: result.staged.identityReviewDraftPath, state: result.state });
    break;
  }
  case "character-register": {
    requireEpisodeId();
    const result = await registerKoyaCharacterIdentity({
      ...common,
      workflowId: args.workflowId,
      castId: args.castId,
      identityReviewPath: args.identityReviewPath ? resolve(args.identityReviewPath) : "",
    });
    print({ episodeId: result.episodeId, character: result.finalized.character, showBibleSync: result.showBibleSync, state: result.state });
    break;
  }
  case "character-identity-refresh": {
    requireEpisodeId();
    const result = await refreshKoyaRegisteredCharacterIdentityPack({
      ...common,
      workflowId: args.workflowId,
      castId: args.castId,
    });
    print(result);
    break;
  }
  case "character-identity-repair": {
    requireEpisodeId();
    const result = await repairKoyaCharacterIdentityPack({
      ...common,
      workflowId: args.workflowId,
      castId: args.castId,
    });
    print({
      episodeId: result.episodeId,
      workflowId: result.workflowId,
      castId: result.castId,
      repairId: result.repairId,
      failedRoles: result.failedRoles,
      generatedCount: result.generatedCount,
      reusedRequiredRoleCount: result.reusedRequiredRoleCount,
      generationCheckpointPath: result.generationCheckpointPath,
      identityReviewDraftPath: result.staged.identityReviewDraftPath,
      state: result.state,
    });
    break;
  }
  case "character-identity-repack": {
    requireEpisodeId();
    const result = await repackKoyaCharacterIdentityPack({
      ...common,
      workflowId: args.workflowId,
      castId: args.castId,
    });
    print({
      episodeId: result.episodeId,
      workflowId: result.workflowId,
      castId: result.castId,
      repairId: result.repairId,
      failedRoles: result.failedRoles,
      repackEvidencePath: result.repackEvidencePath,
      identityReviewDraftPath: result.staged.identityReviewDraftPath,
      state: result.state,
    });
    break;
  }
  case "prepare": {
    requireEpisodeId();
    const scriptPath = await scriptPathForResume();
    const { outerJobBinding } = await canonicalOuterJobContext();
    const result = await createKoyaEpisodeManifest({ ...common, scriptPath, outerJobBinding });
    print({ episodeId: result.episodeId, status: result.state.status, waiting: result.waiting, paths: result.paths });
    if (result.waiting) exitCode = 3;
    break;
  }
  case "speech": {
    requireEpisodeId();
    if (common.voiceQualityGate === false && !common.voiceQualityGateOverrideReason) {
      throw new Error("--no-voice-quality-gate requires --voice-quality-gate-override-reason <text>");
    }
    const result = await generateKoyaMangaSpeech({ ...common, dryRun: args.dryRun === true });
    print({ episodeId: args.episodeId, status: result.state?.status, waiting: result.waiting, partial: result.partial === true, cancelled: result.cancelled === true, reportPath: result.reportPath });
    if (result.waiting || result.partial || result.cancelled) exitCode = 3;
    break;
  }
  case "video-substitute": {
    requireEpisodeId();
    const result = await substituteKoyaMangaCutVideos({
      ...common,
      ...videoSubstitutionOptions({ confirmFlag: "confirmPaidGeneration", retryFlag: "retryFailed" }),
    });
    print(videoSubstitutionPayload(result));
    if (result.waiting || result.blocked) exitCode = 3;
    break;
  }
  case "repair-onset": {
    requireEpisodeId();
    const result = await repairKoyaMangaAudioOnset({
      ...common,
      utteranceId: args.utteranceId,
      sourcePath: args.sourcePath ? resolve(args.sourcePath) : "",
      fadeStartSeconds: args.fadeStartSeconds,
      fadeMilliseconds: args.fadeMilliseconds,
      outputFileName: args.outputFileName,
      reason: args.reason,
    });
    print({
      episodeId: result.episodeId,
      utteranceId: result.utteranceId,
      status: result.state.status,
      sourcePath: result.sourcePath,
      outputPath: result.outputPath,
      durationSeconds: result.outputDurationSeconds,
      fadeStartSeconds: result.fadeStartSeconds,
      fadeMilliseconds: result.fadeMilliseconds,
      contractAuditPass: result.contractAudit.pass,
    });
    break;
  }
  case "repair-tail": {
    requireEpisodeId();
    const result = await repairKoyaMangaAudioTail({
      ...common,
      utteranceId: args.utteranceId,
      sourcePath: args.sourcePath ? resolve(args.sourcePath) : "",
      speechEndSeconds: args.speechEndSeconds,
      fadeStartSeconds: args.fadeStartSeconds,
      fadeMilliseconds: args.fadeMilliseconds,
      outputFileName: args.outputFileName,
      reason: args.reason,
    });
    print({
      episodeId: result.episodeId,
      utteranceId: result.utteranceId,
      status: result.state.status,
      sourcePath: result.sourcePath,
      outputPath: result.outputPath,
      durationSeconds: result.outputDurationSeconds,
      speechEndSeconds: result.speechEndSeconds,
      fadeStartSeconds: result.fadeStartSeconds,
      fadeMilliseconds: result.fadeMilliseconds,
      contractAuditPass: result.contractAudit.pass,
    });
    break;
  }
  case "adjust-gap": {
    requireEpisodeId();
    const result = await adjustKoyaMangaUtteranceGap({
      ...common,
      utteranceId: args.utteranceId,
      targetAudibleGapSeconds: args.targetAudibleGapSeconds,
      reason: args.reason,
    });
    print({
      episodeId: result.episodeId,
      cutId: result.cutId,
      previousUtteranceId: result.previousUtteranceId,
      utteranceId: result.utteranceId,
      status: result.state.status,
      previousTargetAudibleGapSeconds: result.previousTargetAudibleGapSeconds,
      targetAudibleGapSeconds: result.targetAudibleGapSeconds,
      embeddedPaddingGapSeconds: result.embeddedPaddingGapSeconds,
      authoredGapBeforeSeconds: result.authoredGapBeforeSeconds,
      contractAuditPass: result.contractAudit.pass,
    });
    break;
  }
  case "standard-cut": {
    requireEpisodeId();
    const result = await standardizeKoyaMangaCut({
      ...common,
      cutId: args.cutId,
      planPath: args.planPath ? resolve(args.planPath) : "",
      reason: args.reason,
    });
    print({
      episodeId: result.episodeId,
      cutId: result.cutId,
      revision: result.revision,
      status: result.state.status,
      planPath: result.planPath,
      backupPath: result.backupPath,
      shotIds: result.shotIds,
      refreshedBubbleCount: result.refreshedBubbleCount,
      contractAuditPass: result.contractAudit.pass,
    });
    break;
  }
  case "sync-contract": {
    requireEpisodeId();
    const result = await syncKoyaMangaContract(common);
    print({
      episodeId: result.episodeId,
      status: result.state.status,
      contractVersion: result.resolved.contract.version,
      contractDigest: result.resolved.digest,
      contractAuditPass: result.contractAudit.pass,
    });
    break;
  }
  case "refresh-bubbles": {
    requireEpisodeId();
    const result = await refreshKoyaMangaBubbles(common);
    print({
      episodeId: result.episodeId,
      status: result.state.status,
      refreshedBubbleCount: result.refreshed.length,
      contractVersion: result.resolved.contract.version,
      contractDigest: result.resolved.digest,
      contractAuditPass: result.contractAudit.pass,
      next: `Run render: node scripts/koya-manga-video.mjs render --episode-id ${result.episodeId} --force`,
    });
    break;
  }
  case "render": {
    requireEpisodeId();
    await canonicalOuterJobContext();
    const result = await renderKoyaMangaVideo({
      ...common,
      force: args.force === true,
      renderConcurrency: args.renderConcurrency,
      fileName: args.fileName,
    });
    print({ episodeId: args.episodeId, status: result.state.status, videoPath: result.outputPath, state: result.state });
    break;
  }
  case "audit": {
    const result = await auditKoyaMangaFinal(await auditOptions());
    print({ reportPath: result.reportPath, pass: result.report.pass, failedAuditIds: result.report.failedAuditIds, knownRemainingIssues: result.report.knownRemainingIssues, contactSheetPath: result.contactSheetPath, runReceiptPath: result.runReceiptPath });
    if (!result.report.pass) exitCode = 2;
    break;
  }
  case "reviewer-key-create": {
    if (typeof args.reviewerKeyPath !== "string") throw new Error("reviewer-key-create requires --reviewer-key-path FILE (the private key is written there, never printed).");
    // 共通実装（両ハーネスの CLI が同じ関数を呼ぶ）: 両 path の存在を先に検査し、
    // リポジトリ／project 配下を拒否し、wx + 0600 で書く。鍵の中身は argv に取らない。
    const created = await writeReviewerKeyPairFiles({
      privateKeyPath: resolve(args.reviewerKeyPath),
      publicKeyPath: typeof args.reviewerPublicKeyPath === "string" ? resolve(args.reviewerPublicKeyPath) : "",
      label: typeof args.reviewerLabel === "string" ? args.reviewerLabel : "",
      projectDir,
    });
    print({
      ...created,
      next: `Hand trustEntry to the operator (owner) out of band; the operator registers it under reviewers[] in the trust list and points ${REVIEWER_TRUST_PATH_ENV} (legacy alias BUZZASSIST_KOYA_REVIEWER_TRUST) at that file on the audit/receipt host. Only that environment variable is a trust anchor; --reviewer-trust-path is a cross-check. The private key never enters a Channel Pack, signoff, argv, MCP arguments, or Job options.`,
    });
    break;
  }
  case "signoff": {
    const episodeId = requireEpisodeId();
    if (args.pass !== true) throw new Error("Signoff requires --pass after the contact sheet has actually been inspected.");
    if (typeof args.reviewerKeyPath !== "string") {
      throw new Error("Signoff requires --reviewer-key-path FILE pointing at the reviewer's Ed25519 private key (create one with reviewer-key-create; never pass key material on argv).");
    }
    const paths = koyaEpisodePaths(projectDir, episodeId);
    const written = await writeKoyaVisualSignoff({
      projectDir,
      manifestPath: paths.manifestPath,
      videoPath: args.videoPath ? resolve(args.videoPath) : "",
      reviewerHost: args.reviewer,
      reviewerId: args.reviewerId,
      reviewerContextId: args.reviewerContextId,
      reviewNotesPath: args.reviewNotesPath ? resolve(args.reviewNotesPath) : "",
      reviewerPrivateKeyPath: resolve(args.reviewerKeyPath),
      reviewerTrustPath: typeof args.reviewerTrustPath === "string" ? resolve(args.reviewerTrustPath) : "",
      pass: true,
    });
    print({
      episodeId,
      outputPath: written.outputPath,
      reviewerHost: written.signoff.reviewerHost,
      reviewerKeyId: written.signoff.reviewerAttestation?.signer?.keyId || "",
      pass: true,
      next: `Run audit again: node scripts/koya-manga-video.mjs audit --episode-id ${episodeId}`,
    });
    break;
  }
  case "full": {
    requireEpisodeId();
    assertWardrobeOverrideReason();
    const scriptPath = await scriptPathForResume();
    if (!scriptPath) throw new Error("--script-path is required for a new full run; resumed runs can recover it from state.");
    // R6-F1: 上位から渡された --reviewer-trust-path を捨てず、開始前に運営者 env と照合する
    // （不一致は reviewer-trust-conflict、env 未設定は reviewer-trust-unconfigured。規則は loadReviewerTrust の 1 箇所）。
    const reviewerTrustPath = typeof args.reviewerTrustPath === "string" ? resolve(args.reviewerTrustPath) : "";
    if (reviewerTrustPath) await loadReviewerTrust({ trustPath: reviewerTrustPath, env: process.env });
    // R6-1: full は有料生成へ進む唯一の production runner。信頼アンカーが env に無い／読めない／active 鍵が
    // 無い host では、生成後に Receipt 確定で止まるのではなく、ここで止める。
    const trustPreflight = await preflightReviewerTrust({ trustPath: reviewerTrustPath, env: process.env });
    if (!trustPreflight.ok) {
      throw new Error(`${trustPreflight.code}: Koya full stopped before paid generation. ${trustPreflight.detail}`);
    }
    const result = await runKoyaMangaFullProduction({
      ...common,
      scriptPath,
      reviewerTrustPath,
      ...videoSubstitutionOptions({ confirmFlag: "confirmPaidVideoGeneration", retryFlag: "retryFailedVideo" }),
    });
    print(result.payload);
    exitCode = result.exitCode;
    break;
  }
  case "voice-audition": {
    const episodeId = args.episodeId || "global";
    const resolvedContract = await resolveKoyaMangaProductionContract({
      projectDir,
      contractPath: common.contractPath || undefined,
      overridePath: common.overridePath || undefined,
    });
    const dialogueAdapter = resolveKoyaDialogueAdapter(resolvedContract);
    const registry = await readCharacterRegistry({ projectDir });
    const paths = koyaVoiceAuditionPaths({ projectDir, episodeId });
    const candidatesPath = typeof args.candidatesPath === "string" ? resolve(args.candidatesPath) : paths.candidatesPath;
    if (args.characterIds) {
      const template = createKoyaVoiceAuditionCandidatesTemplate({
        registry,
        episodeId,
        characterIds: String(args.characterIds),
        dialogueAdapter,
      });
      await mkdir(dirname(candidatesPath), { recursive: true });
      try {
        await writeFile(candidatesPath, `${JSON.stringify(template, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        print({ status: "candidates-file-exists", candidatesPath, next: "edit that file, then rerun voice-audition with --candidates-path (without --character-ids)" });
        break;
      }
      print({
        status: "candidates-template-written",
        candidatesPath,
        adapter: template.adapter,
        characterIds: template.entries.map((entry) => entry.characterId),
        next: "fill sampleLine and 2 to 5 candidate voiceIds per character, then rerun voice-audition with --candidates-path and --confirm-paid-preview",
      });
      break;
    }
    const candidates = JSON.parse(await readFile(candidatesPath, "utf8"));
    const plan = createKoyaVoiceAuditionPlan({ candidates, registry, dialogueAdapter, episodeId });
    const result = await writeKoyaVoiceAuditionPlan({
      projectDir,
      plan,
      confirmPaidPreview: args.confirmPaidPreview === true,
    });
    print({
      status: result.status,
      planId: result.planId,
      adapter: result.adapter,
      pendingPreviews: result.pendingPreviews,
      estimatedCharacters: result.estimatedCharacters,
      rendered: result.rendered,
      reused: result.reused,
      listeningPage: result.status === "awaiting-selection" ? result.htmlPath : "",
      selectionsPath: result.status === "awaiting-selection" ? result.selectionsPath : "",
    });
    if (result.status === "awaiting-paid-confirmation") exitCode = 3;
    break;
  }
  case "voice-approve": {
    const episodeId = args.episodeId || "global";
    const paths = koyaVoiceAuditionPaths({ projectDir, episodeId });
    const selectionsPath = typeof args.selectionsPath === "string" ? resolve(args.selectionsPath) : paths.selectionsPath;
    const selections = JSON.parse(await readFile(selectionsPath, "utf8"));
    print(await approveKoyaVoiceAudition({
      projectDir,
      episodeId,
      selections,
      approvedBy: typeof args.approvedBy === "string" ? args.approvedBy : "",
    }));
    break;
  }
  case "status": {
    requireEpisodeId();
    const status = await readKoyaProductionState({ projectDir, episodeId: args.episodeId });
    print(status);
    break;
  }
  default:
    throw new Error(`Unknown action: ${args.action}\n${usage()}`);
}
} finally {
  await disposeMediaGenerationResources();
}
process.exitCode = exitCode;
