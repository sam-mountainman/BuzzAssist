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
/**
 * 声のテイクの測定（CER・UTMOS など）を、途中の成果物の品質ループの声のテイクの工程（voice-take）の
 * measurement として置くときの形。ループの機械ゲート voice-metrics-pass（lib/assetQualityLoop.mjs）は
 * checks[] から inputSha256 がテイクの sha256 に一致する行を探し、同じ voiceQualityPenalty で判定する。
 */
export const NARRATED_VOICE_TAKE_MEASUREMENT_VERSION = "buzzassist-narrated-voice-take-measurement-v1";
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
 * measurement に残す指標。数値の指標と、区間ごとの UTMOS を使ったかの印・区間の数値だけ
 * （区間の期待文・文字起こしなどの文字列は残さない）。voiceQualityPenalty が同じ判定をできる形にする。
 */
function measurementMetrics(metrics = {}) {
  const out = safeMetrics(metrics);
  if (metrics?.segmentUtmosApplied === true) out.segmentUtmosApplied = true;
  if (Array.isArray(metrics?.segments)) {
    out.segments = metrics.segments.map((segment) => Object.fromEntries(Object.entries(segment || {})
      .filter(([, value]) => typeof value === "number" && Number.isFinite(value))));
  }
  return out;
}

/**
 * 声のテイクの工程（voice-take）の measurement。gateNarratedVoiceTakes の measurements と、テイクの
 * ファイルの sha256（呼び出し側がディスクから読んだ値）から作る。台本の文・文字起こし・パスは持たない。
 * shaByPath に無いテイク（読めなかった）は載せない（載せないテイクはループの機械ゲートに通らない）。
 */
export function narratedVoiceTakeMeasurementReport(measurements = [], shaByPath = new Map()) {
  const checks = [];
  for (const row of measurements) {
    const sha = String(shaByPath.get(row.path) || "").toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(sha)) continue;
    checks.push({
      id: `${row.segmentId}#${row.take}`,
      segmentId: row.segmentId,
      take: row.take,
      type: "voiceQuality",
      status: ["pass", "warn", "fail"].includes(row.status) ? row.status : "fail",
      metrics: measurementMetrics(row.metrics),
      problems: problemCodes(row.problems),
      warnings: problemCodes(row.warnings),
      unavailable: problemCodes(row.unavailable),
      ...(row.checkDigest ? { checkDigest: String(row.checkDigest).slice(0, 128) } : {}),
      inputSha256: { audio: sha },
    });
  }
  return {
    version: NARRATED_VOICE_TAKE_MEASUREMENT_VERSION,
    requiredMetrics: [...NARRATED_VOICE_QUALITY_REQUIRED_METRICS],
    checks,
  };
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
        verdicts.set(key, { status: "fail", hardFail: true, penalty: Number.POSITIVE_INFINITY, problems: ["voice quality gate returned no result"], metrics: {}, missingRequiredMetrics: [...NARRATED_VOICE_QUALITY_REQUIRED_METRICS] });
        continue;
      }
      // ゲートの判定（pass / warn / fail）も残す。声のテイクの工程の measurement に同じ判定を載せるため。
      verdicts.set(key, { ...voiceQualityPenalty(check, { requiredMetrics: [...NARRATED_VOICE_QUALITY_REQUIRED_METRICS] }), status: check.status });
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
  // 文ごとの全テイクと、ゲートに通ったか（途中の成果物の品質ループが、採用するテイクをこの中から選ぶ）。
  const candidatesBySegment = new Map();
  // 測ったテイクごとの測定（声のテイクの工程の measurement の材料。台本の文・文字起こしは持たない）。
  const measurements = [];
  const rows = [];
  let passing = 0;
  for (const segment of segments) {
    const candidates = (takes.get(segment.id) || []).map((take) => ({ ...take, verdict: verdicts.get(`${segment.id}#${take.take}`) }));
    candidatesBySegment.set(segment.id, candidates.map((candidate) => ({
      take: candidate.take,
      path: candidate.path,
      receipt: candidate.receipt,
      machinePass: candidate.verdict?.hardFail === false,
    })));
    for (const candidate of candidates) {
      if (!candidate.verdict) continue;
      measurements.push({
        segmentId: segment.id,
        take: candidate.take,
        path: candidate.path,
        status: candidate.verdict.status,
        metrics: candidate.verdict.metrics,
        problems: candidate.verdict.problems,
        warnings: candidate.verdict.warnings,
        unavailable: candidate.verdict.unavailable,
        checkDigest: candidate.verdict.checkDigest,
      });
    }
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
    candidates: candidatesBySegment,
    measurements,
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
