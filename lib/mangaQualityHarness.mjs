import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { writeJsonAtomic } from "./canvasScene.mjs";
import { auditMangaCompositionSequence, planMangaSceneCompositions } from "./mangaSceneComposition.mjs";

export const MANGA_QUALITY_HARNESS_VERSION = 2;

const DEFAULT_RUBRIC = [
  { id: "semantic-scene-fit", label: "台本と画面の意味的一致", weight: 20 },
  { id: "character-continuity", label: "キャラクター同一性と演技", weight: 15 },
  { id: "camera-composition", label: "視点・構図・画面変化", weight: 15 },
  { id: "editorial-grammar", label: "漫画的な間・分割・心情演出", weight: 10 },
  { id: "bubble-typography", label: "吹き出し形状・配置・可読性", weight: 10 },
  { id: "voice-performance", label: "人格に合う声と自然な演技", weight: 15 },
  { id: "audio-technical", label: "音量・無音・ピーク等の技術品質", weight: 5 },
  { id: "timing-continuity", label: "台詞・画・間の同期", weight: 5 },
  { id: "final-playback", label: "全尺視聴での完成度", weight: 5 },
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

function normalizedRubric(value) {
  const source = Array.isArray(value) && value.length > 0 ? value : DEFAULT_RUBRIC;
  const rows = source.map((entry, index) => ({
    id: nonEmptyString(entry?.id) || `criterion-${index + 1}`,
    label: nonEmptyString(entry?.label) || nonEmptyString(entry?.id) || `評価項目${index + 1}`,
    weight: clamp(entry?.weight, 0.1, 100, 1),
    description: nonEmptyString(entry?.description),
  }));
  const total = rows.reduce((sum, entry) => sum + entry.weight, 0) || 1;
  return rows.map((entry) => ({ ...entry, weight: Number((entry.weight * 100 / total).toFixed(6)) }));
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
    rubric: normalizedRubric(overrides.rubric),
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

function sanitizeEvidence(value, maximum = 2_000) {
  return nonEmptyString(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/[\r\n\u2028\u2029]+/gu, " ")
    .replace(/\[(?:採用案|理由)\]/gu, "（$&）")
    .slice(0, maximum);
}

function validSha256(value) {
  return /^[a-f0-9]{64}$/u.test(nonEmptyString(value));
}

function normalizeEvidenceRows(value, { required = true } = {}) {
  const rows = (Array.isArray(value) ? value : []).map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Evidence must be an object with path, sha256, and note.");
    }
    const path = sanitizeEvidence(entry.path, 1_000);
    const sha256 = nonEmptyString(entry.sha256).toLowerCase();
    const note = sanitizeEvidence(entry.note, 1_000);
    if (!path || !validSha256(sha256) || note.length < 4) {
      throw new Error("Evidence requires a path, a SHA-256 digest, and a concrete note.");
    }
    return { path, sha256, note };
  });
  if (required && rows.length === 0) throw new Error("At least one hash-bound evidence artifact is required.");
  return rows;
}

function weightedReviewScore(review, contract) {
  const scores = review?.scores && typeof review.scores === "object" ? review.scores : {};
  const missing = (contract.rubric || []).filter((criterion) => !Number.isFinite(Number(scores[criterion.id]))).map((criterion) => criterion.id);
  if (missing.length > 0) throw new Error(`Every rubric criterion must be scored: ${missing.join(", ")}`);
  let weighted = 0;
  let includedWeight = 0;
  for (const criterion of contract.rubric || []) {
    const score = Number(scores[criterion.id]);
    if (!Number.isFinite(score)) continue;
    weighted += clamp(score, 0, 100, 0) * criterion.weight;
    includedWeight += criterion.weight;
  }
  if (includedWeight <= 0) throw new Error("Each review must score every rubric criterion.");
  return Number((weighted / includedWeight).toFixed(3));
}

export function createMangaQualityLoopState(input = {}) {
  const contract = input.contract;
  if (!contract?.digest) throw new Error("An immutable quality contract is required.");
  const startedAt = nonEmptyString(input.startedAt) || new Date().toISOString();
  if (!Number.isFinite(Date.parse(startedAt))) throw new Error("Quality loop startedAt must be a valid timestamp.");
  return {
    version: MANGA_QUALITY_HARNESS_VERSION,
    episodeId: nonEmptyString(input.episodeId || contract.episodeId),
    contractDigest: contract.digest,
    generatorId: nonEmptyString(input.generatorId) || "generator",
    generatorContextId: nonEmptyString(input.generatorContextId) || nonEmptyString(input.generatorId) || "generator-context",
    status: "active",
    startedAt: new Date(startedAt).toISOString(),
    rounds: [],
    bestScore: null,
    stagnantRounds: 0,
    totalCost: 0,
    elapsedMs: 0,
    nextAction: "run-deterministic-gates",
  };
}

export function recordMangaQualityRound(input = {}) {
  const contract = input.contract;
  const previous = input.state;
  if (!contract?.digest || previous?.contractDigest !== contract.digest) {
    throw new Error("Quality contract changed during the run; start a new run instead.");
  }
  if (previous.status !== "active") throw new Error(`Quality loop is already ${previous.status}.`);
  const reviews = Array.isArray(input.reviews) ? input.reviews : [];
  if (reviews.length === 0) throw new Error("At least one independent review is required.");
  const priorEvaluators = new Set(previous.rounds.flatMap((round) => round.reviews.map((review) => review.evaluatorId)));
  const priorEvaluatorContexts = new Set(previous.rounds.flatMap((round) => round.reviews.map((review) => review.evaluatorContextId)));
  const normalizedReviews = reviews.map((review) => {
    const evaluatorId = nonEmptyString(review?.evaluatorId);
    const evaluatorContextId = nonEmptyString(review?.evaluatorContextId);
    if (!evaluatorId) throw new Error("Every review requires evaluatorId.");
    if (!evaluatorContextId) throw new Error("Every review requires evaluatorContextId.");
    if (evaluatorId === previous.generatorId) throw new Error("The generator cannot judge its own output.");
    if (evaluatorContextId === previous.generatorContextId) throw new Error("The generator context cannot judge its own output under another name.");
    if (priorEvaluators.has(evaluatorId)) throw new Error(`Fresh evaluator required; ${evaluatorId} already reviewed an earlier round.`);
    if (priorEvaluatorContexts.has(evaluatorContextId)) throw new Error(`Fresh evaluator context required; ${evaluatorContextId} already reviewed an earlier round.`);
    const notes = sanitizeEvidence(review.notes);
    if (notes.length < 4) throw new Error("Every review requires concrete notes.");
    return {
      evaluatorId,
      evaluatorContextId,
      candidateLabel: nonEmptyString(review.candidateLabel).toUpperCase(),
      score: weightedReviewScore(review, contract),
      notes,
      evidence: normalizeEvidenceRows(review.evidence),
    };
  });
  const score = Number((normalizedReviews.reduce((sum, review) => sum + review.score, 0) / normalizedReviews.length).toFixed(3));
  if (input.hardGateReport?.contractDigest !== contract.digest) {
    throw new Error("Hard-gate report must be bound to the immutable quality contract digest.");
  }
  const hardGatePass = input.hardGateReport?.pass === true;
  const candidateSetId = nonEmptyString(input.candidateSetId);
  const candidateVerdictDigest = nonEmptyString(input.candidateVerdictDigest);
  if (candidateSetId && (!candidateVerdictDigest || normalizedReviews.some((review) => !review.candidateLabel))) {
    throw new Error("Candidate comparison requires labeled reviews and a recorded verdict digest.");
  }
  const previousBest = previous.bestScore;
  const improvement = previousBest === null ? score : score - previousBest;
  const bestScore = previousBest === null ? score : Math.max(previousBest, score);
  const stagnantRounds = previousBest === null || improvement >= contract.limits.minimumImprovement
    ? 0
    : previous.stagnantRounds + 1;
  const observedAt = nonEmptyString(input.observedAt) || new Date().toISOString();
  if (!Number.isFinite(Date.parse(observedAt)) || Date.parse(observedAt) < Date.parse(previous.startedAt)) {
    throw new Error("Round observedAt must be a valid timestamp at or after startedAt.");
  }
  const revisionDelta = sanitizeEvidence(input.revisionDelta);
  if (previous.rounds.length > 0 && revisionDelta.length < 4) {
    throw new Error("Every retry requires a concrete revisionDelta from the previous failure.");
  }
  const expectedPreviousFailure = previous.rounds.at(-1)?.failureFingerprint || "";
  if (previous.rounds.length > 0 && nonEmptyString(input.previousFailureFingerprint) !== expectedPreviousFailure) {
    throw new Error("Retry must reference the immediately previous failure fingerprint.");
  }
  const passingTarget = hardGatePass && score >= contract.limits.targetScore;
  const failureFingerprint = nonEmptyString(input.failureFingerprint);
  if (!passingTarget && failureFingerprint.length < 8) {
    throw new Error("A non-passing round requires a stable failureFingerprint.");
  }
  const round = {
    index: previous.rounds.length + 1,
    candidateSetId,
    candidateVerdictDigest,
    hardGatePass,
    failedGateIds: uniqueStrings(input.hardGateReport?.failedGateIds),
    score,
    improvement: Number(improvement.toFixed(3)),
    reviews: normalizedReviews,
    evidence: normalizeEvidenceRows(input.evidence),
    failureFingerprint,
    previousFailureFingerprint: nonEmptyString(input.previousFailureFingerprint),
    revisionDelta,
    cost: Math.max(0, finiteNumber(input.cost, 0)),
    observedAt: new Date(observedAt).toISOString(),
    elapsedMs: Math.max(0, Date.parse(observedAt) - Date.parse(previous.startedAt)),
  };
  const state = {
    ...previous,
    rounds: [...previous.rounds, round],
    bestScore,
    stagnantRounds,
    totalCost: previous.totalCost + round.cost,
    elapsedMs: Math.max(previous.elapsedMs, round.elapsedMs),
  };
  const blockingCondition = sanitizeEvidence(input.blockingCondition);
  if (passingTarget) {
    state.status = "passed";
    state.stopReason = "target-reached";
    state.nextAction = "publish-checklist-and-final-watch";
  } else if (blockingCondition) {
    state.status = "blocked";
    state.stopReason = "blocking-condition";
    state.blockingCondition = blockingCondition;
    state.nextAction = "human-review";
  } else if (state.totalCost >= contract.limits.maximumCost) {
    state.status = "budget-exhausted";
    state.stopReason = "cost-limit";
    state.nextAction = "human-review";
  } else if (state.elapsedMs >= contract.limits.maximumElapsedMs) {
    state.status = "budget-exhausted";
    state.stopReason = "time-limit";
    state.nextAction = "human-review";
  } else if (state.rounds.length >= contract.limits.maximumReviewRounds) {
    state.status = "needs-human-approval";
    state.stopReason = "round-limit";
    state.nextAction = "human-review";
  } else if (state.stagnantRounds >= contract.limits.maximumStagnantRounds) {
    state.status = "needs-human-approval";
    state.stopReason = "no-improvement";
    state.nextAction = "human-review";
  } else {
    state.status = "active";
    state.stopReason = "";
    state.nextAction = hardGatePass ? "revise-lowest-rubric-category" : "repair-failed-hard-gates";
  }
  return deepFreeze(state);
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
  const body = {
    version: "koya-final-quality-decision-v2",
    episodeId,
    contractDigest,
    videoSha256,
    generatorEvaluatorSeparation: true,
    status,
    pass,
    stopReason,
    nextAction: pass ? "complete" : onlyHumanApprovalMissing ? "perform-perceptual-review" : "repair-failed-audits",
    requiredAuditIds,
    passedAuditIds,
    failedAuditIds,
    missingAuditIds,
    invalidEvidenceAuditIds,
    evidence,
    knownRemainingIssues: [...new Set([...missingAuditIds, ...failedAuditIds, ...invalidEvidenceAuditIds])]
      .map((id) => ({ id, detail: `final quality decision: ${id}` })),
    decidedAt: new Date(decidedAt).toISOString(),
  };
  return deepFreeze({ ...body, digest: digest(body) });
}

export function recordMangaQualityIncident(input = {}) {
  const ledger = input.ledger && typeof input.ledger === "object" ? input.ledger : { version: 1, incidents: [] };
  const incident = input.incident && typeof input.incident === "object" ? input.incident : {};
  const signature = nonEmptyString(incident.signature)
    || digest({ scope: nonEmptyString(incident.scope), rule: nonEmptyString(incident.rule), failure: nonEmptyString(incident.failure) }).slice(0, 20);
  const previous = (ledger.incidents || []).find((entry) => entry.signature === signature);
  const occurrences = Math.max(1, finiteNumber(previous?.occurrences, 0) + 1);
  const severity = nonEmptyString(incident.severity || previous?.severity) || "medium";
  const deterministic = incident.deterministic === true || previous?.deterministic === true;
  const promotion = deterministic && /^(?:high|critical)$/u.test(severity) && occurrences >= 2
    ? "hard-gate"
    : occurrences >= 2
      ? "instruction"
      : "checklist";
  const updated = {
    signature,
    scope: nonEmptyString(incident.scope || previous?.scope),
    rule: nonEmptyString(incident.rule || previous?.rule),
    failure: nonEmptyString(incident.failure || previous?.failure),
    severity,
    deterministic,
    occurrences,
    promotion,
    evidence: uniqueStrings([...(previous?.evidence || []), ...(incident.evidence || [])]).map((entry) => sanitizeEvidence(entry, 1_000)),
    lastSeenAt: nonEmptyString(incident.observedAt) || new Date().toISOString(),
  };
  return {
    version: MANGA_QUALITY_HARNESS_VERSION,
    incidents: [...(ledger.incidents || []).filter((entry) => entry.signature !== signature), updated]
      .sort((left, right) => left.signature.localeCompare(right.signature)),
  };
}

export async function writeMangaQualityHarnessState(filePath, state) {
  await writeJsonAtomic(resolve(filePath), state);
  return state;
}

export async function readMangaQualityHarnessState(filePath) {
  return JSON.parse(await readFile(resolve(filePath), "utf8"));
}
