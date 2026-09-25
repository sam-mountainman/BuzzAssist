import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { writeJsonAtomic } from "./canvasScene.mjs";
import { verifyMangaEvidenceRows } from "./mangaQualityEvidence.mjs";
import {
  createQualityLoopState,
  normalizeEvidenceRows,
  normalizeQualityRubric,
  recordQualityRound,
  sanitizeEvidence,
  validSha256,
} from "./qualityLoop.mjs";
import { auditMangaCompositionSequence, planMangaSceneCompositions } from "./mangaSceneComposition.mjs";

export const MANGA_QUALITY_HARNESS_VERSION = 4;

// 品質ループの中核は lib/qualityLoop.mjs（ジャンル共通）へ移した。旧名は互換のため残す。
export const createMangaQualityLoopState = createQualityLoopState;
export const recordMangaQualityRound = recordQualityRound;

// minimumScore は項目ごとの下限。加重平均が目標に届いても、どれか1つがこれを下回れば
// 合格にしない（同一性 47 点・他は満点で平均 92.05 が合格していた。2026-09-24）。
// 値は実測から決めた閾値ではなく方針: 視聴者が「別人」「話が違う」「声が違う」と
// 気づく項目（同一性・意味の一致・声）は 80、ほかは致命傷の足切りとして 60。
const DEFAULT_RUBRIC = [
  { id: "semantic-scene-fit", label: "台本と画面の意味的一致", weight: 20, minimumScore: 80 },
  { id: "character-continuity", label: "キャラクター同一性と演技", weight: 15, minimumScore: 80 },
  { id: "camera-composition", label: "視点・構図・画面変化", weight: 15, minimumScore: 60 },
  { id: "editorial-grammar", label: "漫画的な間・分割・心情演出", weight: 10, minimumScore: 60 },
  { id: "bubble-typography", label: "吹き出し形状・配置・可読性", weight: 10, minimumScore: 60 },
  { id: "voice-performance", label: "人格に合う声と自然な演技", weight: 15, minimumScore: 80 },
  { id: "audio-technical", label: "音量・無音・ピーク等の技術品質", weight: 5, minimumScore: 60 },
  { id: "timing-continuity", label: "台詞・画・間の同期", weight: 5, minimumScore: 60 },
  { id: "final-playback", label: "全尺視聴での完成度", weight: 5, minimumScore: 60 },
];

const DEFAULT_HARD_GATES = [
  "episode-structure",
  "utterance-coverage",
  "speech-readability",
  "voice-coverage",
  "bubble-safety",
  "composition-variation",
  "asset-text-separation",
  "final-media-evidence",
];

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum, fallback = minimum) {
  return Math.min(maximum, Math.max(minimum, finiteNumber(value, fallback)));
}

function uniqueStrings(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((entry) => nonEmptyString(entry))
    .filter(Boolean))];
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map((entry) => stableJsonValue(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableJsonValue(entry)]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stableJsonValue(value))).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

function normalizedChannelDirectives(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  return {
    audience: nonEmptyString(input.audience),
    viewingContext: nonEmptyString(input.viewingContext ?? input.viewing_context),
    voice: nonEmptyString(input.voice),
    visualStyle: nonEmptyString(input.visualStyle ?? input.visual_style),
    narrativeStructure: nonEmptyString(input.narrativeStructure ?? input.narrative_structure),
    pronunciationRules: uniqueStrings(input.pronunciationRules ?? input.pronunciation_rules),
    winningPatterns: uniqueStrings(input.winningPatterns ?? input.winning_patterns),
    prohibitedPatterns: uniqueStrings(input.prohibitedPatterns ?? input.prohibited_patterns),
    knownIncidents: uniqueStrings(input.knownIncidents ?? input.known_incidents),
  };
}

function inferredChannelDirectives(manifest = {}) {
  const production = manifest.production && typeof manifest.production === "object" ? manifest.production : {};
  const audio = production.audioUpgrade && typeof production.audioUpgrade === "object" ? production.audioUpgrade : {};
  const visual = production.visualUpgrade && typeof production.visualUpgrade === "object" ? production.visualUpgrade : {};
  const editorial = production.editorialGrammar && typeof production.editorialGrammar === "object" ? production.editorialGrammar : {};
  const camera = production.cameraPolicy && typeof production.cameraPolicy === "object" ? production.cameraPolicy : {};
  const bubble = production.bubblePolicy && typeof production.bubblePolicy === "object" ? production.bubblePolicy : {};
  return {
    voice: [audio.provider, audio.model, audio.nativeJapaneseVoiceCount ? `${audio.nativeJapaneseVoiceCount} native Japanese voices` : ""]
      .filter(Boolean).join(" / "),
    visualStyle: nonEmptyString(visual.stylePackPath || production.visualProfileId),
    narrativeStructure: nonEmptyString(editorial.version || production.version),
    winningPatterns: uniqueStrings(visual.backgroundPriorities),
    prohibitedPatterns: uniqueStrings([
      camera.repeatedImageShotsAllowed === false ? "同一画像・同一カメラ設定を連続させない" : "",
      camera.terminalStopsAllowed === false ? "カメラを不自然に終端停止させない" : "",
      bubble.syntheticBold === false ? "吹き出し文字へ合成太字を使わない" : "",
      bubble.activeSpeakerFaceOverlapAllowed === false ? "吹き出しを話者の顔へ重ねない" : "",
      "日本語文字を画像素材へ焼き込まない",
    ]),
  };
}

export function createMangaQualityContract(input = {}) {
  const manifest = input.manifest && typeof input.manifest === "object" ? input.manifest : {};
  const manifestQualityPolicy = manifest.production?.qualityPolicy && typeof manifest.production.qualityPolicy === "object"
    ? manifest.production.qualityPolicy
    : {};
  const manifestLimits = manifestQualityPolicy.qualityLoopLimits && typeof manifestQualityPolicy.qualityLoopLimits === "object"
    ? manifestQualityPolicy.qualityLoopLimits
    : {};
  const manifestCandidateDecision = manifestQualityPolicy.candidateDecision && typeof manifestQualityPolicy.candidateDecision === "object"
    ? manifestQualityPolicy.candidateDecision
    : {};
  const explicitOverrides = input.overrides && typeof input.overrides === "object" ? input.overrides : {};
  const overrides = {
    targetScore: manifestLimits.targetScore,
    maximumReviewRounds: manifestLimits.maximumReviewRounds,
    maximumElapsedMs: Number.isFinite(Number(manifestLimits.maximumElapsedMinutes))
      ? Number(manifestLimits.maximumElapsedMinutes) * 60 * 1_000
      : undefined,
    maximumCost: manifestLimits.maximumCostUnits,
    minimumImprovement: manifestLimits.minimumImprovementPoints,
    maximumStagnantRounds: manifestLimits.maximumStagnantRounds,
    minimumCandidates: manifestCandidateDecision.minimumCandidates,
    maximumCandidates: manifestCandidateDecision.maximumCandidates,
    ...(manifest.production?.qualityHarness && typeof manifest.production.qualityHarness === "object"
      ? manifest.production.qualityHarness
      : {}),
    ...explicitOverrides,
  };
  const explicitChannelDirectives = input.channelDirectives
    ?? manifest.production?.channelDirectives
    ?? manifest.channelDirectives
    ?? {};
  const inferred = normalizedChannelDirectives(inferredChannelDirectives(manifest));
  const explicit = normalizedChannelDirectives(explicitChannelDirectives);
  const channelDirectives = {
    ...inferred,
    ...Object.fromEntries(Object.entries(explicit).filter(([, value]) => Array.isArray(value) ? value.length > 0 : Boolean(value))),
    pronunciationRules: uniqueStrings([...inferred.pronunciationRules, ...explicit.pronunciationRules]),
    winningPatterns: uniqueStrings([...inferred.winningPatterns, ...explicit.winningPatterns]),
    prohibitedPatterns: uniqueStrings([...inferred.prohibitedPatterns, ...explicit.prohibitedPatterns]),
    knownIncidents: uniqueStrings([...inferred.knownIncidents, ...explicit.knownIncidents]),
  };
  const minimumCandidates = Math.round(clamp(overrides.minimumCandidates, 2, 5, 2));
  const maximumCandidates = Math.max(minimumCandidates, Math.round(clamp(overrides.maximumCandidates, 2, 5, 5)));
  const body = {
    version: MANGA_QUALITY_HARNESS_VERSION,
    episodeId: nonEmptyString(manifest.id),
    channelDirectives,
    universalRules: {
      generatorEvaluatorSeparation: true,
      distinctEvaluatorContextRequired: true,
      deterministicGatesBeforeJudgment: true,
      evidenceRequired: true,
      completeRubricRequired: true,
      failureFingerprintRequired: true,
      revisionDeltaRequired: true,
      fullLengthViewingRequired: true,
      referenceSideBySideRequired: true,
      japaneseTextRenderedSeparately: true,
      immutableDuringRun: true,
    },
    hardGates: uniqueStrings(overrides.hardGates).length > 0
      ? uniqueStrings(overrides.hardGates)
      : [...DEFAULT_HARD_GATES],
    rubric: normalizeQualityRubric(overrides.rubric, DEFAULT_RUBRIC),
    limits: {
      targetScore: clamp(overrides.targetScore, 0, 100, 92),
      maximumReviewRounds: Math.round(clamp(overrides.maximumReviewRounds, 1, 8, 2)),
      maximumElapsedMs: Math.round(clamp(overrides.maximumElapsedMs, 1_000, 7 * 24 * 60 * 60 * 1_000, 6 * 60 * 60 * 1_000)),
      maximumCost: clamp(overrides.maximumCost, 0, Number.MAX_SAFE_INTEGER, 100),
      minimumImprovement: clamp(overrides.minimumImprovement, 0, 100, 1),
      maximumStagnantRounds: Math.round(clamp(overrides.maximumStagnantRounds, 1, 5, 1)),
    },
    candidatePolicy: {
      minimumCandidates,
      maximumCandidates,
      anonymousComparison: true,
      explicitVariationAxes: true,
      revealMappingOnlyAfterVerdict: true,
      selectionReasonRequired: true,
    },
  };
  const contract = { ...body, digest: digest(body) };
  return deepFreeze(contract);
}

/** Route a production decision to the cheapest judge that can decide it safely. */
export function classifyMangaDecisionGate(input = {}) {
  const candidateCount = Math.max(1, Math.round(finiteNumber(input.candidateCount, 1)));
  const objectivelyVerifiable = input.objectivelyVerifiable === true;
  const subjective = input.subjective === true || input.brandSensitive === true;
  const irreversibleOrPaid = input.irreversibleOrPaid === true;
  const rubricDefined = input.rubricDefined === true;
  if (objectivelyVerifiable) {
    return {
      route: "deterministic-gate",
      judge: "machine",
      pauseBeforePaidWork: false,
      reason: "正解を外部証拠で一意に判定できるため、人間へ質問しない。",
    };
  }
  if (candidateCount > 1 && (subjective || irreversibleOrPaid)) {
    return {
      route: "human-best-of-n",
      judge: "human",
      pauseBeforePaidWork: true,
      reason: "好み・ブランド・高コスト判断を、異なる軸の候補から人間が選ぶ。",
    };
  }
  if (candidateCount > 1 && rubricDefined) {
    return {
      route: "independent-blind-best-of-n",
      judge: "fresh-independent-evaluator",
      pauseBeforePaidWork: false,
      reason: "固定rubricで比較できるため、fresh evaluatorが匿名候補を判定する。",
    };
  }
  return {
    route: "human-red-pen",
    judge: "human",
    pauseBeforePaidWork: irreversibleOrPaid,
    maximumQuestions: 4,
    reason: "単一提案の曖昧点だけを3±1問へ圧縮し、実行前に訂正を受ける。",
  };
}

function result(id, pass, details = {}, status = "checked") {
  return { id, status, pass: status === "not-applicable" ? true : Boolean(pass), ...details };
}

function explicitSilentCut(cut) {
  return cut?.silent === true
    || cut?.silenceCut === true
    || cut?.editorialPlate?.silent === true
    || /(?:無言|無音|silence|silent)/iu.test(nonEmptyString(cut?.purpose));
}

function bubbleFailures(manifest) {
  return (manifest.utterances || []).flatMap((utterance) => {
    const quality = Array.isArray(utterance.bubbleQuality)
      ? utterance.bubbleQuality
      : Array.isArray(utterance.overlayQuality)
        ? utterance.overlayQuality
        : [];
    return quality
      .filter((entry) => entry?.overflow || entry?.textLoss || entry?.tooSmall || entry?.insideBubble === false)
      .map((entry) => ({ utteranceId: utterance.id, quality: entry }));
  });
}

function bakedTextViolations(manifest) {
  return (manifest.cuts || []).filter((cut) => (
    cut?.imageGeneration?.containsBakedText === true
    || cut?.imageGeneration?.textLayerPolicy === "baked"
    || cut?.containsBakedText === true
  )).map((cut) => cut.id);
}

export function auditMangaPreflight(input = {}) {
  const manifest = input.manifest && typeof input.manifest === "object" ? input.manifest : {};
  const contract = input.contract || createMangaQualityContract({ manifest });
  const stage = nonEmptyString(input.stage) || "planning";
  const cuts = Array.isArray(manifest.cuts) ? manifest.cuts : [];
  const utterances = Array.isArray(manifest.utterances) ? manifest.utterances : [];
  const utteranceById = new Map(utterances.map((entry) => [entry.id, entry]));
  const references = cuts.flatMap((cut) => (cut.utteranceIds || []).map((id) => ({ cutId: cut.id, id })));
  const referenceCounts = new Map();
  for (const entry of references) referenceCounts.set(entry.id, (referenceCounts.get(entry.id) || 0) + 1);
  const missingReferences = references.filter((entry) => !utteranceById.has(entry.id));
  const orphanUtteranceIds = utterances.filter((entry) => !referenceCounts.has(entry.id)).map((entry) => entry.id);
  const duplicateReferenceIds = [...referenceCounts].filter(([, count]) => count !== 1).map(([id]) => id);
  const emptyCutIds = cuts.filter((cut) => (cut.utteranceIds || []).length === 0 && !explicitSilentCut(cut)).map((cut) => cut.id);
  const invalidSpeech = utterances.filter((entry) => (
    !nonEmptyString(entry.text)
    || !nonEmptyString(entry.speechText || entry.text)
    || /(?:https?:\/\/|```|^#{1,6}\s|\[[^\]]+\]\([^)]+\))/mu.test(nonEmptyString(entry.speechText || entry.text))
  )).map((entry) => entry.id);
  const missingVoices = utterances.filter((entry) => (
    !nonEmptyString(entry.voiceId)
    && !nonEmptyString(entry.voiceProfileId)
    && !nonEmptyString(manifest.defaultVoiceId)
  )).map((entry) => entry.id);
  const bubbles = bubbleFailures(manifest);
  const compositionPlan = input.compositionPlan || (utterances.length > 0
    ? planMangaSceneCompositions({ manifest: { ...manifest, id: manifest.id || "preflight" } })
    : { beats: [] });
  const composition = auditMangaCompositionSequence(compositionPlan);
  const bakedTextCutIds = bakedTextViolations(manifest);
  const finalEvidencePresent = Boolean(
    manifest.outputs?.reviewVideo?.filePath
    || manifest.outputs?.finalVideo?.filePath
    || manifest.outputs?.video?.filePath,
  );
  const gates = [
    result("episode-structure", Boolean(manifest.id && cuts.length > 0 && utterances.length > 0), {
      cutCount: cuts.length,
      utteranceCount: utterances.length,
      emptyCutIds,
    }),
    result("utterance-coverage", missingReferences.length === 0 && orphanUtteranceIds.length === 0 && duplicateReferenceIds.length === 0 && emptyCutIds.length === 0, {
      missingReferences,
      orphanUtteranceIds,
      duplicateReferenceIds,
      emptyCutIds,
    }),
    result("speech-readability", invalidSpeech.length === 0, { invalidUtteranceIds: invalidSpeech }),
    result("voice-coverage", missingVoices.length === 0, { missingVoiceUtteranceIds: missingVoices }),
    result("bubble-safety", bubbles.length === 0, { failures: bubbles }, bubbles.length === 0 && !utterances.some((entry) => entry.bubbleQuality || entry.overlayQuality) ? "not-applicable" : "checked"),
    result("composition-variation", composition.ok, composition),
    result("asset-text-separation", bakedTextCutIds.length === 0, { bakedTextCutIds }),
    result("final-media-evidence", finalEvidencePresent, { finalEvidencePresent }, stage === "final" ? "checked" : "not-applicable"),
  ];
  const enabled = new Set(contract.hardGates || DEFAULT_HARD_GATES);
  const activeGates = gates.filter((entry) => enabled.has(entry.id));
  const failed = activeGates.filter((entry) => entry.status !== "not-applicable" && !entry.pass);
  return {
    version: MANGA_QUALITY_HARNESS_VERSION,
    episodeId: nonEmptyString(manifest.id),
    contractDigest: contract.digest,
    stage,
    pass: failed.length === 0,
    checkedCount: activeGates.filter((entry) => entry.status === "checked").length,
    failedCount: failed.length,
    failedGateIds: failed.map((entry) => entry.id),
    gates: activeGates,
  };
}

function anonymousLabel(index) {
  let value = index + 1;
  let output = "";
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
}

export function createBlindCandidateSet(candidates = [], options = {}) {
  const minimumCandidates = Math.round(clamp(options.minimumCandidates, 2, 5, 2));
  const maximumCandidates = Math.round(clamp(options.maximumCandidates, minimumCandidates, 5, 5));
  if (!Array.isArray(candidates) || candidates.length < minimumCandidates || candidates.length > maximumCandidates) {
    throw new Error(`Blind comparison requires ${minimumCandidates} to ${maximumCandidates} candidates.`);
  }
  const ids = candidates.map((entry) => nonEmptyString(entry?.id));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error("Candidate IDs must be unique and non-empty.");
  const axes = candidates.map((entry) => nonEmptyString(entry?.variationAxis));
  if (axes.some((axis) => !axis) || new Set(axes).size !== axes.length) {
    throw new Error("Every candidate requires a unique, non-empty variationAxis.");
  }
  const artifacts = candidates.map((entry) => nonEmptyString(entry?.artifact ?? entry?.filePath));
  if (artifacts.some((artifact) => !artifact)) throw new Error("Every candidate requires an artifact reference.");
  const salt = nonEmptyString(options.salt) || randomBytes(16).toString("hex");
  const shuffled = candidates.map((entry) => ({
    entry,
    orderKey: digest({ salt, id: entry.id }),
  })).sort((left, right) => left.orderKey.localeCompare(right.orderKey));
  const mapping = shuffled.map(({ entry }, index) => ({
    label: anonymousLabel(index),
    id: entry.id,
    provider: nonEmptyString(entry.provider),
    source: nonEmptyString(entry.source),
    artifact: nonEmptyString(entry.artifact ?? entry.filePath),
    artifactSha256: nonEmptyString(entry.artifactSha256),
    variationAxis: nonEmptyString(entry.variationAxis),
  }));
  const setId = digest({ salt, ids: mapping.map((entry) => entry.id) });
  const judgePacket = {
    setId,
    candidates: mapping.map((entry) => ({
      label: entry.label,
      artifactRef: `anonymous-candidate-${entry.label}`,
      ...(entry.artifactSha256 ? { artifactSha256: entry.artifactSha256 } : {}),
    })),
    instructions: "候補の出所・生成モデル・変化軸を推測せず、固定rubricのみで比較する。採用ラベルと理由を確定する前に対応表を開かない。",
  };
  return {
    version: MANGA_QUALITY_HARNESS_VERSION,
    setId,
    judgePacket: { ...judgePacket, digest: digest(judgePacket) },
    privateMapping: {
      setId,
      salt,
      mapping,
      digest: digest(mapping),
    },
  };
}

export function revealBlindSelection(candidateSet, verdict = {}) {
  if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) {
    throw new Error("A recorded verdict is required before revealing the private mapping.");
  }
  if (verdict.setId !== candidateSet?.setId) throw new Error("Verdict setId does not match the candidate set.");
  const normalized = nonEmptyString(verdict.winnerLabel).toUpperCase();
  const decidedBy = nonEmptyString(verdict.decidedBy ?? verdict.evaluatorId);
  const reason = sanitizeEvidence(verdict.reason, 1_000);
  const decidedAt = nonEmptyString(verdict.decidedAt);
  if (!decidedBy || reason.length < 4 || !Number.isFinite(Date.parse(decidedAt))) {
    throw new Error("Verdict requires decidedBy, a concrete selection reason, and a valid decidedAt timestamp.");
  }
  const found = candidateSet?.privateMapping?.mapping?.find((entry) => entry.label === normalized);
  if (!found) throw new Error(`Unknown anonymous candidate label: ${normalized || "(empty)"}`);
  return {
    ...found,
    setId: candidateSet.setId,
    mappingDigest: candidateSet.privateMapping.digest,
    verdict: {
      winnerLabel: normalized,
      decidedBy,
      reason,
      decidedAt: new Date(decidedAt).toISOString(),
      digest: digest({ setId: candidateSet.setId, winnerLabel: normalized, decidedBy, reason, decidedAt: new Date(decidedAt).toISOString() }),
    },
  };
}

export async function recordVerifiedMangaQualityRound(input = {}) {
  const verifiedRoundEvidence = await verifyMangaEvidenceRows(input.evidence);
  const reviews = [];
  for (const review of Array.isArray(input.reviews) ? input.reviews : []) {
    reviews.push({
      ...review,
      evidence: await verifyMangaEvidenceRows(review.evidence),
    });
  }
  return recordMangaQualityRound({
    ...input,
    evidence: verifiedRoundEvidence,
    reviews,
  });
}

/**
 * Build the final second-order decision from the real audit suite. The
 * quality-harness-final step is intentionally excluded to avoid self-grading.
 */
export function createMangaFinalQualityDecision(input = {}) {
  const episodeId = nonEmptyString(input.episodeId);
  const contractDigest = nonEmptyString(input.contractDigest);
  const videoSha256 = nonEmptyString(input.videoSha256).toLowerCase();
  const qualityAuditId = nonEmptyString(input.qualityAuditId) || "quality-harness-final";
  const humanApprovalAuditId = nonEmptyString(input.humanApprovalAuditId) || "agent-contact-sheet-review";
  if (!episodeId || !validSha256(contractDigest) || !validSha256(videoSha256)) {
    throw new Error("Final quality decision requires episodeId plus contract and MP4 SHA-256 digests.");
  }
  const decidedAt = nonEmptyString(input.decidedAt) || new Date().toISOString();
  if (!Number.isFinite(Date.parse(decidedAt))) throw new Error("Final quality decision requires a valid decidedAt timestamp.");
  const requiredAuditIds = uniqueStrings(input.requiredAuditIds).filter((id) => id !== qualityAuditId);
  if (requiredAuditIds.length === 0) throw new Error("Final quality decision requires independent audit IDs.");
  const auditSteps = Array.isArray(input.auditSteps) ? input.auditSteps : [];
  const byId = new Map(auditSteps.map((step) => [nonEmptyString(step?.id), step]));
  const missingAuditIds = requiredAuditIds.filter((id) => !byId.has(id));
  const failedAuditIds = requiredAuditIds.filter((id) => byId.has(id) && byId.get(id).pass !== true);
  const passedAuditIds = requiredAuditIds.filter((id) => byId.get(id)?.pass === true);
  const invalidEvidenceAuditIds = requiredAuditIds.filter((id) => {
    const step = byId.get(id);
    if (!step || step.pass !== true || step.applicable === false) return false;
    return !nonEmptyString(step.evidencePath) || !validSha256(step.evidenceSha256);
  });
  const machineFailures = [...new Set([
    ...missingAuditIds,
    ...failedAuditIds.filter((id) => id !== humanApprovalAuditId),
    ...invalidEvidenceAuditIds,
  ])];
  const onlyHumanApprovalMissing = machineFailures.length === 0
    && failedAuditIds.length === 1
    && failedAuditIds[0] === humanApprovalAuditId;
  const pass = missingAuditIds.length === 0 && failedAuditIds.length === 0 && invalidEvidenceAuditIds.length === 0;
  const status = pass ? "passed" : onlyHumanApprovalMissing ? "needs-human-approval" : "blocked";
  const stopReason = pass
    ? "all-independent-audits-passed"
    : onlyHumanApprovalMissing
      ? "perceptual-signoff-required"
      : missingAuditIds.length > 0
        ? "required-audit-missing"
        : invalidEvidenceAuditIds.length > 0
          ? "audit-evidence-unbound"
          : "independent-audit-failed";
  const evidence = requiredAuditIds.map((id) => {
    const step = byId.get(id) || {};
    return {
      id,
      pass: step.pass === true,
      applicable: step.applicable !== false,
      evidencePath: sanitizeEvidence(step.evidencePath, 1_000),
      evidenceSha256: nonEmptyString(step.evidenceSha256).toLowerCase(),
    };
  });
  const qualityLoopState = input.qualityLoopState && typeof input.qualityLoopState === "object"
    ? input.qualityLoopState
    : null;
  const qualityLoopRoundCount = Array.isArray(qualityLoopState?.rounds) ? qualityLoopState.rounds.length : 0;
  const qualityLoopPassed = qualityLoopState?.status === "passed" && qualityLoopRoundCount > 0;
  const evaluatorContexts = new Set((qualityLoopState?.rounds || [])
    .flatMap((round) => round.reviews || [])
    .map((review) => nonEmptyString(review.evaluatorContextId))
    .filter(Boolean));
  const generatorContextId = nonEmptyString(qualityLoopState?.generatorContextId);
  const generatorEvaluatorSeparation = Boolean(
    generatorContextId
    && evaluatorContexts.size > 0
    && !evaluatorContexts.has(generatorContextId),
  );
  const evidenceManifestPath = nonEmptyString(input.evidenceManifestPath);
  const evidenceManifestSha256 = nonEmptyString(input.evidenceManifestSha256).toLowerCase();
  const evidenceMerkleRoot = nonEmptyString(input.evidenceMerkleRoot).toLowerCase();
  const evidenceManifestBound = Boolean(
    evidenceManifestPath
    && validSha256(evidenceManifestSha256)
    && validSha256(evidenceMerkleRoot)
    && qualityLoopState?.rounds?.at(-1)?.evidenceMerkleRoot === evidenceMerkleRoot
  );
  const qualityLoopFailures = [
    ...(!qualityLoopPassed ? ["quality-loop-not-passed"] : []),
    ...(!generatorEvaluatorSeparation ? ["generator-evaluator-separation-unproven"] : []),
    ...(!evidenceManifestBound ? ["evidence-merkle-unbound"] : []),
  ];
  const basePass = missingAuditIds.length === 0 && failedAuditIds.length === 0 && invalidEvidenceAuditIds.length === 0;
  const finalPass = basePass && qualityLoopFailures.length === 0;
  const awaitingPerceptualReview = onlyHumanApprovalMissing
    || (basePass && qualityLoopState?.status === "active" && qualityLoopRoundCount === 0);
  const finalStatus = finalPass ? "passed" : awaitingPerceptualReview ? "needs-human-approval" : "blocked";
  const finalStopReason = finalPass
    ? "all-independent-audits-and-quality-loop-passed"
    : awaitingPerceptualReview
      ? "perceptual-signoff-required"
      : qualityLoopFailures[0] || stopReason;
  const body = {
    version: "koya-final-quality-decision-v2",
    episodeId,
    contractDigest,
    videoSha256,
    generatorEvaluatorSeparation,
    status: finalStatus,
    pass: finalPass,
    stopReason: finalStopReason,
    nextAction: finalPass ? "complete" : awaitingPerceptualReview ? "perform-perceptual-review" : "repair-failed-audits-or-quality-loop",
    qualityLoopStateDigest: qualityLoopState ? digest(qualityLoopState) : "",
    qualityLoopStatus: nonEmptyString(qualityLoopState?.status),
    qualityLoopRoundCount,
    qualityLoopFailures,
    // 合格しないまま止まったループの最高点の回（成果物 SHA つき）。納品するかを人が決める
    // 材料で、合格の根拠にはしない（pass は上の条件だけで決まる）。
    qualityLoopBestRound: qualityLoopState?.bestRound && qualityLoopState.status !== "passed"
      ? structuredClone(qualityLoopState.bestRound)
      : null,
    evidenceManifestPath,
    evidenceManifestSha256,
    evidenceMerkleRoot,
    requiredAuditIds,
    passedAuditIds,
    failedAuditIds,
    missingAuditIds,
    invalidEvidenceAuditIds,
    evidence,
    knownRemainingIssues: [...new Set([...missingAuditIds, ...failedAuditIds, ...invalidEvidenceAuditIds, ...qualityLoopFailures])]
      .map((id) => ({ id, detail: `final quality decision: ${id}` })),
    decidedAt: new Date(decidedAt).toISOString(),
  };
  return deepFreeze({ ...body, digest: digest(body) });
}

// 版の識別子に残す上限。再発の判定には直近の版だけが要る。
const MAXIMUM_INCIDENT_REVISION_KEYS = 50;
const INCIDENT_PROMOTION_RANK = Object.freeze({ checklist: 1, instruction: 2, "hard-gate": 3 });

/**
 * 失敗が出た「版」の識別子。成果物 SHA と修正内容（revisionDelta）のどちらかが違えば別の版。
 * どちらも渡されなければ版を識別できないので空を返す（その呼び出しは従来どおり毎回数える）。
 */
export function mangaIncidentRevisionKey(revision = {}) {
  const artifactSha256 = nonEmptyString(revision?.artifactSha256).toLowerCase();
  const revisionDelta = sanitizeEvidence(revision?.revisionDelta, 2_000);
  if (!artifactSha256 && !revisionDelta) return "";
  return `revision:${digest({ artifactSha256, revisionDelta }).slice(0, 32)}`;
}

export function recordMangaQualityIncident(input = {}) {
  const ledger = input.ledger && typeof input.ledger === "object" ? input.ledger : { version: 1, incidents: [] };
  const incident = input.incident && typeof input.incident === "object" ? input.incident : {};
  const signature = nonEmptyString(incident.signature)
    || digest({ scope: nonEmptyString(incident.scope), rule: nonEmptyString(incident.rule), failure: nonEmptyString(incident.failure) }).slice(0, 20);
  const previous = (ledger.incidents || []).find((entry) => entry.signature === signature);
  // 再発として数えるのは、別の版（成果物 SHA か revisionDelta が違う）で同じ失敗
  // （同じ signature）が出たときだけ。同じ版の監査をやり直しただけで数えると、1回の失敗が
  // 再実行の回数だけ checklist → instruction → hard-gate へ格上げされる。
  const revisionKey = mangaIncidentRevisionKey(incident.revision);
  const previousRevisionKeys = uniqueStrings(previous?.revisionKeys);
  const sameRevision = Boolean(revisionKey) && previousRevisionKeys.includes(revisionKey);
  const occurrences = sameRevision
    ? Math.max(1, finiteNumber(previous?.occurrences, 1))
    : Math.max(1, finiteNumber(previous?.occurrences, 0) + 1);
  const revisionKeys = revisionKey && !sameRevision
    ? [...previousRevisionKeys, revisionKey].slice(-MAXIMUM_INCIDENT_REVISION_KEYS)
    : previousRevisionKeys;
  const sameRevisionReaudits = finiteNumber(previous?.sameRevisionReaudits, 0) + (sameRevision ? 1 : 0);
  const severity = nonEmptyString(incident.severity || previous?.severity) || "medium";
  const deterministic = incident.deterministic === true || previous?.deterministic === true;
  const derivedPromotion = deterministic && /^(?:high|critical)$/u.test(severity) && occurrences >= 2
    ? "hard-gate"
    : occurrences >= 2
      ? "instruction"
      : "checklist";
  // 一度上がった昇格状態は、記録し直しても下げない（seed の hard-gate を含む）。
  const promotion = (INCIDENT_PROMOTION_RANK[previous?.promotion] || 0) > INCIDENT_PROMOTION_RANK[derivedPromotion]
    ? previous.promotion
    : derivedPromotion;
  const updated = {
    signature,
    scope: nonEmptyString(incident.scope || previous?.scope),
    rule: nonEmptyString(incident.rule || previous?.rule),
    failure: nonEmptyString(incident.failure || previous?.failure),
    severity,
    deterministic,
    occurrences,
    promotion,
    ...(revisionKeys.length > 0 ? { revisionKeys } : {}),
    ...(sameRevisionReaudits > 0 ? { sameRevisionReaudits } : {}),
    evidence: uniqueStrings([...(previous?.evidence || []), ...(incident.evidence || [])]).map((entry) => sanitizeEvidence(entry, 1_000)),
    lastSeenAt: nonEmptyString(incident.observedAt) || new Date().toISOString(),
  };
  return {
    version: MANGA_QUALITY_HARNESS_VERSION,
    incidents: [...(ledger.incidents || []).filter((entry) => entry.signature !== signature), updated]
      .sort((left, right) => left.signature.localeCompare(right.signature)),
  };
}

export function mergeMangaQualityIncidentLedgers(...ledgers) {
  const rank = INCIDENT_PROMOTION_RANK;
  const bySignature = new Map();
  for (const ledger of ledgers) {
    for (const incident of ledger?.incidents || []) {
      const signature = nonEmptyString(incident?.signature);
      if (!signature) continue;
      const previous = bySignature.get(signature);
      if (!previous) {
        bySignature.set(signature, structuredClone(incident));
        continue;
      }
      bySignature.set(signature, {
        ...previous,
        ...incident,
        // 別々の台帳で別の版に出た同じ失敗は、版の和集合の数だけ再発している。
        occurrences: Math.max(
          finiteNumber(previous.occurrences, 0),
          finiteNumber(incident.occurrences, 0),
          uniqueStrings([...(previous.revisionKeys || []), ...(incident.revisionKeys || [])]).length,
          1,
        ),
        promotion: (rank[incident.promotion] || 0) >= (rank[previous.promotion] || 0)
          ? incident.promotion
          : previous.promotion,
        evidence: uniqueStrings([...(previous.evidence || []), ...(incident.evidence || [])]),
        // 同じ版は台帳をまたいでも1つの版。和集合で持ち、再発の数え直しに使う。
        ...(previous.revisionKeys || incident.revisionKeys ? {
          revisionKeys: uniqueStrings([...(previous.revisionKeys || []), ...(incident.revisionKeys || [])])
            .slice(-MAXIMUM_INCIDENT_REVISION_KEYS),
        } : {}),
        ...(previous.sameRevisionReaudits || incident.sameRevisionReaudits ? {
          sameRevisionReaudits: Math.max(finiteNumber(previous.sameRevisionReaudits, 0), finiteNumber(incident.sameRevisionReaudits, 0)),
        } : {}),
        lastSeenAt: [previous.lastSeenAt, incident.lastSeenAt].filter(Boolean).sort().at(-1) || "",
      });
    }
  }
  return {
    version: MANGA_QUALITY_HARNESS_VERSION,
    incidents: [...bySignature.values()].sort((left, right) => left.signature.localeCompare(right.signature)),
  };
}

export async function writeMangaQualityHarnessState(filePath, state) {
  await writeJsonAtomic(resolve(filePath), state);
  return state;
}

export async function readMangaQualityHarnessState(filePath) {
  return JSON.parse(await readFile(resolve(filePath), "utf8"));
}
