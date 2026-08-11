import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { writeJsonAtomic } from "./canvasScene.mjs";
import { auditMangaCompositionSequence, planMangaSceneCompositions } from "./mangaSceneComposition.mjs";

export const MANGA_QUALITY_HARNESS_VERSION = 1;

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
  const overrides = input.overrides && typeof input.overrides === "object" ? input.overrides : {};
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
  const minimumCandidates = Math.round(clamp(overrides.minimumCandidates, 2, 8, 2));
  const maximumCandidates = Math.max(minimumCandidates, Math.round(clamp(overrides.maximumCandidates, 2, 8, 5)));
  const body = {
    version: MANGA_QUALITY_HARNESS_VERSION,
    episodeId: nonEmptyString(manifest.id),
    channelDirectives,
    universalRules: {
      generatorEvaluatorSeparation: true,
      deterministicGatesBeforeJudgment: true,
      evidenceRequired: true,
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
    },
  };
  const contract = { ...body, digest: digest(body) };
  return deepFreeze(contract);
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
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > 26) {
    throw new Error("Blind comparison requires 2 to 26 candidates.");
  }
  const ids = candidates.map((entry) => nonEmptyString(entry?.id));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error("Candidate IDs must be unique and non-empty.");
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
  }));
  const setId = digest({ salt, ids: mapping.map((entry) => entry.id) });
  return {
    version: MANGA_QUALITY_HARNESS_VERSION,
    setId,
    judgePacket: {
      setId,
      candidates: mapping.map((entry) => ({
        label: entry.label,
        artifactRef: `anonymous-candidate-${entry.label}`,
      })),
      instructions: "候補の出所・生成モデルを推測せず、固定rubricのみで比較する。採用ラベル確定前に対応表を開かない。",
    },
    privateMapping: {
      setId,
      salt,
      mapping,
      digest: digest(mapping),
    },
  };
}

export function revealBlindSelection(candidateSet, label) {
  const normalized = nonEmptyString(label).toUpperCase();
  const found = candidateSet?.privateMapping?.mapping?.find((entry) => entry.label === normalized);
  if (!found) throw new Error(`Unknown anonymous candidate label: ${normalized || "(empty)"}`);
  return { ...found, setId: candidateSet.setId, mappingDigest: candidateSet.privateMapping.digest };
}

function sanitizeEvidence(value, maximum = 2_000) {
  return nonEmptyString(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/[\r\n\u2028\u2029]+/gu, " ")
    .replace(/\[(?:採用案|理由)\]/gu, "（$&）")
    .slice(0, maximum);
}

function weightedReviewScore(review, contract) {
  const scores = review?.scores && typeof review.scores === "object" ? review.scores : {};
  let weighted = 0;
  let includedWeight = 0;
  for (const criterion of contract.rubric || []) {
    const score = Number(scores[criterion.id]);
    if (!Number.isFinite(score)) continue;
    weighted += clamp(score, 0, 100, 0) * criterion.weight;
    includedWeight += criterion.weight;
  }
  if (includedWeight <= 0) throw new Error("Each review must score at least one rubric criterion.");
  return Number((weighted / includedWeight).toFixed(3));
}

export function createMangaQualityLoopState(input = {}) {
  const contract = input.contract;
  if (!contract?.digest) throw new Error("An immutable quality contract is required.");
  return {
    version: MANGA_QUALITY_HARNESS_VERSION,
    episodeId: nonEmptyString(input.episodeId || contract.episodeId),
    contractDigest: contract.digest,
    generatorId: nonEmptyString(input.generatorId) || "generator",
    status: "active",
    startedAt: nonEmptyString(input.startedAt) || new Date().toISOString(),
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
  const normalizedReviews = reviews.map((review) => {
    const evaluatorId = nonEmptyString(review?.evaluatorId);
    if (!evaluatorId) throw new Error("Every review requires evaluatorId.");
    if (evaluatorId === previous.generatorId) throw new Error("The generator cannot judge its own output.");
    if (priorEvaluators.has(evaluatorId)) throw new Error(`Fresh evaluator required; ${evaluatorId} already reviewed an earlier round.`);
    return {
      evaluatorId,
      candidateLabel: nonEmptyString(review.candidateLabel).toUpperCase(),
      score: weightedReviewScore(review, contract),
      notes: sanitizeEvidence(review.notes),
      evidence: uniqueStrings(review.evidence).map((entry) => sanitizeEvidence(entry, 1_000)),
    };
  });
  const score = Number((normalizedReviews.reduce((sum, review) => sum + review.score, 0) / normalizedReviews.length).toFixed(3));
  const hardGatePass = input.hardGateReport?.pass === true;
  const previousBest = previous.bestScore;
  const improvement = previousBest === null ? score : score - previousBest;
  const bestScore = previousBest === null ? score : Math.max(previousBest, score);
  const stagnantRounds = previousBest === null || improvement >= contract.limits.minimumImprovement
    ? 0
    : previous.stagnantRounds + 1;
  const round = {
    index: previous.rounds.length + 1,
    candidateSetId: nonEmptyString(input.candidateSetId),
    hardGatePass,
    failedGateIds: uniqueStrings(input.hardGateReport?.failedGateIds),
    score,
    improvement: Number(improvement.toFixed(3)),
    reviews: normalizedReviews,
    evidence: uniqueStrings(input.evidence).map((entry) => sanitizeEvidence(entry, 1_000)),
    cost: Math.max(0, finiteNumber(input.cost, 0)),
    elapsedMs: Math.max(0, Math.round(finiteNumber(input.elapsedMs, 0))),
  };
  const state = {
    ...previous,
    rounds: [...previous.rounds, round],
    bestScore,
    stagnantRounds,
    totalCost: previous.totalCost + round.cost,
    elapsedMs: previous.elapsedMs + round.elapsedMs,
  };
  if (hardGatePass && score >= contract.limits.targetScore) {
    state.status = "passed";
    state.stopReason = "target-reached";
    state.nextAction = "publish-checklist-and-final-watch";
  } else if (state.totalCost >= contract.limits.maximumCost) {
    state.status = "escalated";
    state.stopReason = "cost-limit";
    state.nextAction = "human-review";
  } else if (state.elapsedMs >= contract.limits.maximumElapsedMs) {
    state.status = "escalated";
    state.stopReason = "time-limit";
    state.nextAction = "human-review";
  } else if (state.rounds.length >= contract.limits.maximumReviewRounds) {
    state.status = "escalated";
    state.stopReason = "round-limit";
    state.nextAction = "human-review";
  } else if (state.stagnantRounds >= contract.limits.maximumStagnantRounds) {
    state.status = "escalated";
    state.stopReason = "no-improvement";
    state.nextAction = "human-review";
  } else {
    state.status = "active";
    state.stopReason = "";
    state.nextAction = hardGatePass ? "revise-lowest-rubric-category" : "repair-failed-hard-gates";
  }
  return deepFreeze(state);
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
