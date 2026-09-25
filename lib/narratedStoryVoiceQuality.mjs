/**
 * ナレーション物語の声の品質ゲート（ジャンル層）。共通の音声品質ゲート（lib/voiceQualityGate.mjs:
 * scripts/audit-voice-quality.py の CER・UTMOS・間・端無音・音量・抑揚）を、語りと台詞の全テイクに使う。
 * 手本は漫画側（lib/koyaDialogueSpeech.mjs）の使い方:
 *   - QA 環境（python・UTMOS キャッシュ）が無ければ有料生成の前に止める（課金してから止めない）
 *   - テイクを測り、ゲートに落ちたテイクは採用しない。全滅なら上限までテイクを撮り直す
 *   - 必須の指標（utmos・cer）が測れなかったテイクは合格にしない（欠落を許可として扱わない）
 *   - それでも合格のテイクが無い文が残れば監査 voiceTakeQuality を落とす（Job は人待ちで止まる）
 * CER は声に渡した読み（spokenText）を基準に測る。字幕の表記で測ると、読みを指定した語で誤判定する。
 * 報告には台本の文も文字起こしも残さない（id・テイク番号・SHA・数値の指標だけ）。
 */

import { auditVoiceQuality, voiceQualityAvailable, voiceQualityPenalty } from "./voiceQualityGate.mjs";

export const NARRATED_VOICE_QUALITY_AUDIT_ID = "voiceTakeQuality";
export const NARRATED_VOICE_QUALITY_REPORT_VERSION = "buzzassist-narrated-story-voice-quality-v1";
export const NARRATED_VOICE_QUALITY_REQUIRED_METRICS = Object.freeze(["utmos", "cer"]);
/** Pack の voiceQuality.maxTakesPerTurn の既定と範囲（撮り直しは有料なので上限を持つ）。 */
export const NARRATED_VOICE_QUALITY_DEFAULT_MAX_TAKES = 2;
const MAX_TAKES_LIMIT = 4;
const NUMERIC_METRICS = Object.freeze(["utmos", "cer", "durationSec", "peak", "moraPerSec", "f0SemitoneStd", "voicedRatio"]);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** narrated-story.json の `voiceQuality`（任意）。範囲外は blocker（黙って既定へ戻さない）。 */
export function normalizeNarratedVoiceQualityConfig(source) {
  const config = { maxTakesPerTurn: NARRATED_VOICE_QUALITY_DEFAULT_MAX_TAKES };
  if (source === undefined || source === null) return { config, blockers: [] };
  if (!plainObject(source)) return { config, blockers: ["voiceQuality"] };
  const blockers = [];
  for (const key of Object.keys(source)) if (key !== "maxTakesPerTurn") blockers.push(`voiceQuality.${key}-unknown`);
  if (source.maxTakesPerTurn !== undefined) {
    if (!Number.isInteger(source.maxTakesPerTurn) || source.maxTakesPerTurn < 1 || source.maxTakesPerTurn > MAX_TAKES_LIMIT) {
      blockers.push("voiceQuality.maxTakesPerTurn");
    } else config.maxTakesPerTurn = source.maxTakesPerTurn;
  }
  return { config, blockers };
}

/** 既定のゲート（本物の python 実行系）。試験は同じ形の関数を差し込む。 */
export const DEFAULT_NARRATED_VOICE_QUALITY_GATE = Object.freeze({
  available: () => voiceQualityAvailable(),
  audit: (input) => auditVoiceQuality(input),
});

function safeMetrics(metrics = {}) {
  return Object.fromEntries(NUMERIC_METRICS
    .filter((name) => Number.isFinite(Number(metrics?.[name])))
    .map((name) => [name, Number(metrics[name])]));
}

function problemCodes(problems = []) {
  // 問題文に台本の文は入らない（数値と指標名だけ）が、念のため長さを切る。
  return problems.map((problem) => String(problem).slice(0, 120));
}

/**
 * 声のテイクを測り、撮り直し、採用するテイクを決める。
 *   segments: 声の単位（id, text, spokenText）
 *   takesBySegment: Map(segment id → [{ take: 1, path, receipt }])（最初のテイク）
 *   retake(segment, takeNumber) → { path, receipt }（有料の撮り直し。Core の Media Job 経路）
 * 戻り値: selected（segment id → 採用テイク）、extraReceipts（撮り直しの受領記録）、check、report
 */
export async function gateNarratedVoiceTakes({
  segments = [],
  takesBySegment = new Map(),
  retake,
  maxTakes = NARRATED_VOICE_QUALITY_DEFAULT_MAX_TAKES,
  gate = DEFAULT_NARRATED_VOICE_QUALITY_GATE,
} = {}) {
  const takes = new Map(segments.map((segment) => [segment.id, [...(takesBySegment.get(segment.id) || [])]]));
  const verdicts = new Map();
  const extraReceipts = [];
  const measure = async () => {
    const pending = [];
    for (const segment of segments) {
      for (const take of takes.get(segment.id) || []) {
        const key = `${segment.id}#${take.take}`;
        if (!verdicts.has(key)) pending.push({ segment, take, key });
      }
    }
    if (pending.length === 0) return;
    const report = await gate.audit({
      checks: pending.map(({ segment, take, key }) => ({
        id: key,
        type: "voiceQuality",
        audio: take.path,
        expectedText: segment.spokenText || segment.text,
      })),
    });
    const byId = new Map((report?.checks || []).map((check) => [String(check.id), check]));
    for (const { key } of pending) {
      const check = byId.get(key);
      if (!check) {
        verdicts.set(key, { hardFail: true, penalty: Number.POSITIVE_INFINITY, problems: ["voice quality gate returned no result"], metrics: {}, missingRequiredMetrics: [...NARRATED_VOICE_QUALITY_REQUIRED_METRICS] });
        continue;
      }
      verdicts.set(key, voiceQualityPenalty(check, { requiredMetrics: [...NARRATED_VOICE_QUALITY_REQUIRED_METRICS] }));
    }
  };
  await measure();
  const failing = () => segments.filter((segment) => (takes.get(segment.id) || []).every((take) => verdicts.get(`${segment.id}#${take.take}`)?.hardFail !== false));
  for (let round = 1; round < maxTakes; round += 1) {
    const needRetake = failing().filter((segment) => (takes.get(segment.id) || []).length <= round);
    if (needRetake.length === 0 || typeof retake !== "function") break;
    for (const segment of needRetake) {
      const takeNumber = (takes.get(segment.id) || []).length + 1;
      const made = await retake(segment, takeNumber);
      takes.get(segment.id).push({ take: takeNumber, path: made.path, receipt: made.receipt });
      if (made.receipt) extraReceipts.push(made.receipt);
    }
    await measure();
  }
  const selected = new Map();
  const rows = [];
  let passing = 0;
  for (const segment of segments) {
    const candidates = (takes.get(segment.id) || []).map((take) => ({ ...take, verdict: verdicts.get(`${segment.id}#${take.take}`) }));
    const ranked = [...candidates].sort((left, right) => (
      Number(left.verdict?.hardFail === true) - Number(right.verdict?.hardFail === true)
      || (left.verdict?.penalty ?? Infinity) - (right.verdict?.penalty ?? Infinity)
      || left.take - right.take
    ));
    const choice = ranked[0] || null;
    if (choice) selected.set(segment.id, { path: choice.path, receipt: choice.receipt, take: choice.take });
    const ok = Boolean(choice) && choice.verdict?.hardFail === false;
    if (ok) passing += 1;
    rows.push({
      segmentId: segment.id,
      selectedTake: choice?.take ?? null,
      pass: ok,
      takes: candidates.map((candidate) => ({
        take: candidate.take,
        artifactSha256: String(candidate.receipt?.artifact?.sha256 || ""),
        hardFail: candidate.verdict?.hardFail !== false,
        penalty: Number.isFinite(candidate.verdict?.penalty) ? candidate.verdict.penalty : null,
        metrics: safeMetrics(candidate.verdict?.metrics),
        missingRequiredMetrics: [...(candidate.verdict?.missingRequiredMetrics || [])],
        problems: problemCodes(candidate.verdict?.problems),
      })),
    });
  }
  const failed = rows.filter((row) => !row.pass).map((row) => row.segmentId);
  const retakes = rows.reduce((sum, row) => sum + Math.max(0, row.takes.length - 1), 0);
  const pass = segments.length > 0 && failed.length === 0;
  return {
    selected,
    extraReceipts,
    report: {
      version: NARRATED_VOICE_QUALITY_REPORT_VERSION,
      requiredMetrics: [...NARRATED_VOICE_QUALITY_REQUIRED_METRICS],
      maxTakesPerTurn: maxTakes,
      segments: rows,
    },
    check: {
      pass,
      detail: pass
        ? `${passing}/${segments.length} voice takes (narration and dialogue) passed the voice quality gate (utmos, cer against the spoken reading); ${retakes} retake(s)`
        : (segments.length === 0
          ? "no voice takes were measured"
          : `voice quality gate failed for ${failed.length} of ${segments.length} lines after up to ${maxTakes} take(s): ${failed.slice(0, 20).join(", ")}`),
      measuredTakes: rows.reduce((sum, row) => sum + row.takes.length, 0),
      retakes,
      failedSegmentIds: failed,
    },
  };
}
