/**
 * ナレーション物語の本編の「間」（ジャンル層）。文と文の間・場面と場面の間に、語りの声も字幕も無く BGM だけが
 * 流れる時間を置く。
 *
 * Channel Pack の narrated-story.json `pacing` で宣言する（無ければ 0＝間を足さない。Core の従来どおり、文は声の
 * テイクの実尺で隙間なく並び、行間はテイクの前後の無音だけで決まる）。
 *
 *   "pacing": { "sentenceGapSeconds": 0.94, "sceneGapSeconds": 0.94 }
 *
 * - sentenceGapSeconds: 本編の文と文の間（地の文・台詞のどちらも。同じ場面の画の中の文の境目）
 * - sceneGapSeconds: 場面の画が変わる所（台本の場面 imageKey が変わる文の境目）の間。欄が無ければ
 *   sentenceGapSeconds と同じ。0 を書けば場面の境目には間を置かない
 * - 値は 0 か 0.1〜3 秒（方針値。3 秒を越える無音の間は語りが途切れたように聞こえる）
 *
 * 間の決まり（計画・描画・監査が同じこの決まりを使う）:
 * - 間を置くのは本編（story）の隣り合う文の間だけ。本編の最初の文の前（OP→本編の境目）と最後の文の後ろ
 *   （本編→感想パートの境目・番組の終わり）には置かない。境目は bookends の字幕なし lead-in の決まり
 *   （保証 bookend-audio-breath）に任せる。感想パート（声あり・声なしのどちらも）の文の間にも置かない
 * - 場面の画が変わる境目は sceneGapSeconds、同じ画の中の境目は sentenceGapSeconds。場面の境目は文の境目でも
 *   あるが、足し合わせず場面の間だけを使う（二重にしない）
 * - 声: 前の文のテイクの終わりから次の文のテイクの始まりまで、voice stem は無音（テイクの前後の無音の外に、
 *   宣言の秒数の無音を足す。48kHz の標本の整数で、間の前半を前の文の、後半を次の文の枠に割る）
 * - BGM: 間を通して流れ続ける（間を BGM ごと無音にしない）。BGM の区分（musicPlan）の曲の切り替えは今までどおり
 *   区分の最初の文の語りの始まり（見本も次の語りの始まりで曲を切り替えていた）
 * - 字幕: 語りの区切りで即座に切り替える。字幕は語り（テイク）の始まりで出て、テイクの終わりで消え、間の間は
 *   字幕を出さない（運営者が「このまま出す」と決めた見本が、行の字幕を語りの終わりで消していたのに合わせた）
 * - 画: 場面の画は間の間も映る（カメラのショットは間を含めた長さで1つの動きで通す）。場面の画の切り替えは
 *   場面の間の真ん中に置き、Pack が crossfade を宣言していれば、その重なりを間の中に収める（間より長い
 *   crossfade の宣言は有料生成の前に止める。フレームの丸めで溢れる分は重なりを縮めて計画に残す）
 * - 尺: 間を足した分だけ本編が長くなる。番組の時間割（尺の計画・BGM の依頼の長さ・カメラのショットの長さ・
 *   字幕の時刻・声の時刻）は全部、間を含めた同じ時間割から作る
 *
 * 監査 narrationPacingMeasured（監査契約 v11 から）は、完成 MP4 と、それへ入れた voice stem を読んで、宣言した間の
 * 区間に語りが無く BGM が流れていること、足した無音の長さが宣言どおり（1 フレーム以内）であること、字幕と
 * 場面の切り替えが上の決まりどおりであることを測る。宣言が無ければ、本編の文が間を空けずに並んでいることを
 * 確かめる。
 *
 * 公開 Core なので、秒数などチャンネル固有の値は持たない。
 */

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import {
  BOUNDARY_LEAD_MAX_DELTA_DB,
  BOUNDARY_MAX_SILENCE_RUN_SECONDS,
  BOUNDARY_ONSET_SYNC_TOLERANCE_SECONDS,
  BOUNDARY_SILENCE_FLOOR_DBFS,
  BOUNDARY_STEM_SILENCE_DBFS,
  blockDbSeries,
  extractNarratedPcm,
  extractNarratedSubtitleCues,
  firstOnset,
  longestRunBelow,
  measureNarrationReferenceDb,
  pcmFromS16le,
} from "./narratedStoryBookends.mjs";

const execFile = promisify(execFileCallback);

export const NARRATED_PACING_AUDIT_ID = "narrationPacingMeasured";
export const NARRATED_PACING_PLAN_VERSION = "buzzassist-narrated-story-pacing-plan-v1";
export const NARRATED_PACING_FIELDS = Object.freeze(["sentenceGapSeconds", "sceneGapSeconds"]);
/** 間の秒数の範囲（0 は「置かない」）。方針値（実測から決めた値ではない）。 */
export const NARRATED_PACING_GAP_SECONDS = Object.freeze({ minimum: 0.1, maximum: 3 });

const SAMPLE_RATE = 48_000;

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

const DISABLED = Object.freeze({
  enabled: false,
  sentenceGapSeconds: 0,
  sceneGapSeconds: 0,
  sceneGapDeclared: false,
  source: "core-default",
});

function gapValue(value, label, blockers) {
  // 数の型だけを受ける（"0.94" の文字列を黙って数にしない）。
  if (typeof value !== "number" || !Number.isFinite(value)) {
    blockers.push(`pacing.${label}`);
    return 0;
  }
  if (value !== 0 && (value < NARRATED_PACING_GAP_SECONDS.minimum || value > NARRATED_PACING_GAP_SECONDS.maximum)) {
    blockers.push(`pacing.${label}`);
    return 0;
  }
  return value;
}

/**
 * narrated-story.json の `pacing` を正規化する（純粋関数）。無ければ間を足さない（Core の既定）。
 * sceneTransition は正規化した本編の場面の切り替え（lib/narratedStorySceneTransitions.mjs）。crossfade が場面の間より
 * 長ければ、間の中に収められないので止める。
 */
export function normalizeNarratedPacingConfig(source, { sceneTransition = null } = {}) {
  if (source === undefined || source === null) return { config: { ...DISABLED }, blockers: [] };
  if (!plainObject(source)) return { config: { ...DISABLED }, blockers: ["pacing"] };
  const blockers = [];
  for (const key of Object.keys(source)) if (!NARRATED_PACING_FIELDS.includes(key)) blockers.push(`pacing.${key}-unknown`);
  const sentenceGapSeconds = source.sentenceGapSeconds === undefined ? 0 : gapValue(source.sentenceGapSeconds, "sentenceGapSeconds", blockers);
  const sceneGapDeclared = source.sceneGapSeconds !== undefined;
  const sceneGapSeconds = sceneGapDeclared ? gapValue(source.sceneGapSeconds, "sceneGapSeconds", blockers) : sentenceGapSeconds;
  if (sceneTransition?.type === "crossfade" && sceneGapSeconds > 0 && sceneTransition.durationSeconds > sceneGapSeconds + 1e-9) {
    blockers.push("pacing.sceneGapSeconds-shorter-than-sceneTransition");
  }
  if (blockers.length > 0) return { config: { ...DISABLED }, blockers: [...new Set(blockers)] };
  return {
    config: {
      enabled: sentenceGapSeconds > 0 || sceneGapSeconds > 0,
      sentenceGapSeconds,
      sceneGapSeconds,
      sceneGapDeclared,
      source: "channel-pack",
    },
    blockers: [],
  };
}

/** 文の場面（画）の鍵。台本パッケージは場面 id、生テキストは文ごとに1枚（文の id）。 */
export function narratedSceneKey(segment) {
  return segment?.imageKey || segment?.id || "";
}

/** 隣り合う本編の2文の間の種類（場面の画が変わるか）と、宣言から決まる秒数（二重にしない）。 */
export function narratedPauseRule(previous, next, pacing) {
  const kind = narratedSceneKey(previous) === narratedSceneKey(next) ? "sentence" : "scene";
  const seconds = pacing?.enabled ? (kind === "scene" ? pacing.sceneGapSeconds : pacing.sentenceGapSeconds) : 0;
  return { kind, seconds };
}

/**
 * 本編の文の間を計画する（純粋関数）。storySegments は本編の文（台本の順）。感想パートの文を渡さない。
 * 間は 48kHz の標本の整数に丸め、前半を前の文の枠の後ろ（pauseAfter）、後半を次の文の枠の前（pauseBefore）に割る
 * （場面の境目では、枠の境目＝場面の画の切り替えが間の真ん中に来る）。
 * 戻り値: pauses（{ index, afterSegmentId, beforeSegmentId, kind, declaredSeconds, seconds, samples }）、
 * bySegment（文の id → { pauseBeforeSamples, pauseAfterSamples, pauseBeforeSeconds, pauseAfterSeconds }）、
 * addedSeconds（本編に足した秒の合計）。
 */
export function planNarratedStoryPauses(storySegments = [], pacing = null) {
  const pauses = [];
  const bySegment = new Map();
  const entry = (id) => {
    if (!bySegment.has(id)) bySegment.set(id, { pauseBeforeSamples: 0, pauseAfterSamples: 0, pauseBeforeSeconds: 0, pauseAfterSeconds: 0 });
    return bySegment.get(id);
  };
  if (pacing?.enabled) {
    for (let index = 1; index < storySegments.length; index += 1) {
      const previous = storySegments[index - 1];
      const next = storySegments[index];
      const rule = narratedPauseRule(previous, next, pacing);
      const samples = Math.round(rule.seconds * SAMPLE_RATE);
      if (samples <= 0) continue;
      const tail = Math.floor(samples / 2);
      const head = samples - tail;
      const before = entry(previous.id);
      before.pauseAfterSamples = tail;
      before.pauseAfterSeconds = tail / SAMPLE_RATE;
      const after = entry(next.id);
      after.pauseBeforeSamples = head;
      after.pauseBeforeSeconds = head / SAMPLE_RATE;
      pauses.push({
        index: pauses.length,
        afterSegmentId: previous.id,
        beforeSegmentId: next.id,
        kind: rule.kind,
        declaredSeconds: rule.seconds,
        seconds: samples / SAMPLE_RATE,
        samples,
      });
    }
  }
  return {
    pauses,
    bySegment,
    addedSeconds: pauses.reduce((sum, pause) => sum + pause.seconds, 0),
  };
}

/** plan-only の preflight に出す間の要約（件数と足す秒だけ）。宣言が無ければ null。 */
export function narratedPacingSummary(pacing, planned) {
  if (!pacing?.enabled) return null;
  return {
    sentenceGapSeconds: pacing.sentenceGapSeconds,
    sceneGapSeconds: pacing.sceneGapSeconds,
    sentencePauses: planned.pauses.filter((pause) => pause.kind === "sentence").length,
    scenePauses: planned.pauses.filter((pause) => pause.kind === "scene").length,
    addedSeconds: round(planned.addedSeconds, 3),
  };
}

/** generation manifest に残す間の記録（文の id・種類・秒だけ。台本の字は残さない）。 */
export function narratedPacingManifestEntry(pacing, planned) {
  return {
    version: NARRATED_PACING_PLAN_VERSION,
    enabled: pacing?.enabled === true,
    source: pacing?.source || "core-default",
    sentenceGapSeconds: pacing?.sentenceGapSeconds || 0,
    sceneGapSeconds: pacing?.sceneGapSeconds || 0,
    sceneGapDeclared: pacing?.sceneGapDeclared === true,
    pauses: (planned?.pauses || []).map(({ afterSegmentId, beforeSegmentId, kind, seconds, samples }) => ({ afterSegmentId, beforeSegmentId, kind, seconds, samples })),
    addedSeconds: planned?.addedSeconds || 0,
  };
}

async function runRuntime(spec, args, { timeout = 10 * 60_000, encoding = "utf8" } = {}) {
  if (!spec?.command) throw new Error("A resolved executable is required.");
  return execFile(spec.command, [...(spec.args || []), ...args], { timeout, windowsHide: true, encoding, maxBuffer: 256 * 1024 * 1024 });
}

/**
 * 声のテイクの前後に間の無音を足した声のファイル（48kHz mono の PCM）。voice stem はこのファイルを文の順に
 * つなぐので、stem の中で間の区間は挿入した無音になる（テイクそのものの標本は変えない）。
 */
export async function renderNarratedPacedVoice({ ffmpeg, takePath, beforeSamples = 0, afterSamples = 0, outputPath }) {
  const filters = [`aresample=${SAMPLE_RATE}`, `aformat=sample_fmts=s16:sample_rates=${SAMPLE_RATE}:channel_layouts=mono`];
  if (beforeSamples > 0) filters.push(`adelay=delays=${beforeSamples}S:all=1`);
  if (afterSamples > 0) filters.push(`apad=pad_len=${afterSamples}`);
  const filterGraph = filters.join(",");
  await runRuntime(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", takePath, "-af", filterGraph, "-c:a", "pcm_s16le", outputPath]);
  return { path: outputPath, filterGraph };
}

// ---- 監査 ---------------------------------------------------------------------
//
// 間の区間は、境目の監査（lib/narratedStoryBookends.mjs）と同じ量を同じ閾値で測る:
//   - voice stem の間の区間の 10ms ブロックの最大 ≤ BOUNDARY_STEM_SILENCE_DBFS（語りが無い。挿入した無音）
//   - 完成 MP4 の間の区間で BOUNDARY_SILENCE_FLOOR_DBFS を下回る連続 ≤ BOUNDARY_MAX_SILENCE_RUN_SECONDS（BGM が途切れない）
//   - 完成 MP4 の間の区間の 50ms ブロックの最大 − 語りの基準音量 ≤ BOUNDARY_LEAD_MAX_DELTA_DB（BGM だけ）
//   - 次の語りの発話の開始が MP4 と voice stem で BOUNDARY_ONSET_SYNC_TOLERANCE_SECONDS 以内（stem が MP4 の時刻に入っている）
// 足した無音の長さの許容は 1 フレーム（「フレーム単位の誤差の範囲」）。当てる前に test/narratedStoryPacing.test.mjs の
// 合成 fixture（640x360・24fps、0.94 秒の文の間 2 と場面の間 2、前後の無音がほぼ無い声 0.6 秒、BGM gain 0.03、
// 2 pass 線形 loudnorm、AAC 192k）で基準版と壊した版を同じ測定にかけた（2026-09-26、ffmpeg 7.1.1）:
//   - 足した無音: 基準版 0.940 秒（誤差 0.000 秒）。間を足していない stem −0.009 秒、場面の間を二重にした stem 1.880 秒
//     （許容 1 フレーム＝0.042 秒に対して、どちらも 0.9 秒以上外れる）
//   - voice stem の間の最大: 基準版 −120 dBFS（挿入した無音）。間を足していない stem −35.0 dBFS（−60 との差 25 dB）
//   - MP4 の間の BGM: 基準版の最長の無音 0.00 秒（最小 −47.7 dBFS）。間の途中の 0.4 秒を消した版 0.38 秒
//   - MP4 の間の最大 − 語りの基準音量: 基準版 −32.1〜−32.3 dB。間に語りと同じ大きさの声を混ぜた版 −3.0 dB
//   - 次の語りの発話の開始: 基準版 MP4 と stem の差 0.000 秒。場面の間を二重にした stem は MP4 とずれて落ちる

/** 間の長さの許容（フレーム）。 */
export const PAUSE_LENGTH_TOLERANCE_FRAMES = 1;
/**
 * 完成 MP4 の間の区間の両端から、BGM の判定（途切れ・語りの大きさの音）に入れない長さ。次の語りの発話の開始は MP4 と
 * stem で BOUNDARY_ONSET_SYNC_TOLERANCE_SECONDS（AAC の 1 フレーム）までのずれを許すので、許したずれの分の語りを
 * 「間の中の語り」と数えないように、同じ幅を両端から外す。実測では、端を外さずに測った値と外した値は同じだった
 * （基準版 −32.1〜−32.3 dB、前後の無音が全く無く語りの大きさのまま始まって終わるテイクでも −33.3〜−33.4 dB）ので、
 * 外す幅は許したずれの幅だけにして広げない（広げると間の端の穴を見落とす）。
 */
export const PAUSE_MP4_EDGE_EXCLUDE_SECONDS = BOUNDARY_ONSET_SYNC_TOLERANCE_SECONDS;
/** 声のテイクと voice stem の、語りの端を決める標本の振幅（−60 dBFS。voice stem の無音の判定と同じ大きさ）。 */
const SPEECH_SAMPLE_FLOOR = 10 ** (BOUNDARY_STEM_SILENCE_DBFS / 20);
/** 計画の「間が無い」の判定（秒の足し算の誤差だけを許す）。 */
const PLAN_EPSILON_SECONDS = 1e-6;
/** 計画の間と宣言の差の許容（48kHz の標本に丸めた分）。 */
const PLAN_TOLERANCE_SECONDS = 1 / SAMPLE_RATE;

async function mapLimit(values, limit, worker) {
  const output = new Array(values.length);
  let next = 0;
  const run = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      output[index] = await worker(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, values.length)) }, run));
  return output;
}

async function decodeWhole(ffmpeg, path) {
  const { stdout } = await runRuntime(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-i", path, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-",
  ], { encoding: "buffer" });
  return pcmFromS16le(stdout);
}

/** PCM の中で振幅が floor 以上の最初と最後の標本（無ければ null）。 */
export function loudSampleEdges(samples, floor = SPEECH_SAMPLE_FLOOR) {
  let first = -1;
  for (let index = 0; index < samples.length; index += 1) {
    if (Math.abs(samples[index]) >= floor) { first = index; break; }
  }
  if (first < 0) return null;
  let last = first;
  for (let index = samples.length - 1; index >= first; index -= 1) {
    if (Math.abs(samples[index]) >= floor) { last = index; break; }
  }
  return { first, last, length: samples.length };
}

/** voice stem の窓（windowStart 秒から）で、center より前の語りの終わりと、center 以後の語りの始まり（秒）。 */
export function speechEdgesAround(samples, windowStart, center, floor = SPEECH_SAMPLE_FLOOR) {
  const centerIndex = Math.min(samples.length - 1, Math.max(0, Math.round((center - windowStart) * SAMPLE_RATE)));
  let speechEnd = null;
  for (let index = centerIndex; index >= 0; index -= 1) {
    if (Math.abs(samples[index]) >= floor) { speechEnd = windowStart + (index + 1) / SAMPLE_RATE; break; }
  }
  let speechStart = null;
  for (let index = centerIndex; index < samples.length; index += 1) {
    if (Math.abs(samples[index]) >= floor) { speechStart = windowStart + index / SAMPLE_RATE; break; }
  }
  return { speechEnd, speechStart };
}

function overlaps(from, to, start, end) {
  return from < end && to > start;
}

/**
 * 本編の間を完成 MP4 と、それへ入れた voice stem で測る。
 * - segments: 番組の時刻の文（{ id, part, imageKey, startSeconds, endSeconds, takePath }。startSeconds〜endSeconds は
 *   声のテイクの区間。takePath は採用したテイクそのもの）
 * - storyPart: 本編の部の { startSeconds, endSeconds }（bookends が無ければ番組の 0〜終わり）
 * - programFrames: 番組のフレームの文（captionStartFrame / captionFrames。lib/narratedStoryVisuals.mjs）。あれば、焼き込み
 *   字幕の頁の計画と場面の切り替えの計画が間の決まりどおりかも見る
 * 決まり（宣言の秒・二重にしない・最初の前と最後の後ろと感想パートには置かない）は、計画の関数を通さず、宣言と
 * 場面の鍵から数え直して比べる。
 */
export async function measureNarratedPacing({
  ffmpeg,
  videoPath,
  voiceStemPath,
  pacing,
  segments = [],
  storyPart = null,
  programFrames = null,
  subtitleLayer = null,
  sceneJoins = null,
  fps,
  concurrency = 4,
  // 完成 MP4 の間の区間の端から BGM の判定に入れない長さ（閾値の較正の試験だけが変える）。
  mp4EdgeExcludeSeconds = PAUSE_MP4_EDGE_EXCLUDE_SECONDS,
}) {
  const frameSeconds = 1 / fps;
  const story = segments.filter((segment) => (segment.part || "story") === "story");
  const review = segments.filter((segment) => segment.part === "review");
  const problems = [];
  if (story.length > 0 && storyPart) {
    if (Math.abs(story[0].startSeconds - storyPart.startSeconds) > PLAN_EPSILON_SECONDS) problems.push("pause-before-first-story-utterance");
    // 部の尺はフレームへ切り上げる（1 フレーム未満の余りは間ではない）。
    if (storyPart.endSeconds - story.at(-1).endSeconds > frameSeconds + PLAN_EPSILON_SECONDS) problems.push("pause-after-last-story-utterance");
  }
  for (let index = 1; index < review.length; index += 1) {
    if (review[index].startSeconds - review[index - 1].endSeconds > PLAN_EPSILON_SECONDS) problems.push(`pause-in-review-part:${review[index].id}`);
  }
  const pairs = story.slice(1).map((next, index) => {
    const previous = story[index];
    const rule = narratedPauseRule(previous, next, pacing);
    const plannedSeconds = next.startSeconds - previous.endSeconds;
    const pairProblems = Math.abs(plannedSeconds - rule.seconds) > (rule.seconds > 0 ? PLAN_TOLERANCE_SECONDS : PLAN_EPSILON_SECONDS)
      ? ["planned-pause-differs-from-declaration"]
      : [];
    return { previous, next, kind: rule.kind, declaredSeconds: rule.seconds, plannedSeconds, problems: pairProblems };
  });
  for (const pair of pairs.filter((entry) => entry.declaredSeconds === 0 && entry.problems.length > 0)) problems.push(`pause-not-declared:${pair.next.id}`);
  const declared = pairs.filter((pair) => pair.declaredSeconds > 0);
  const summary = {
    version: NARRATED_PACING_PLAN_VERSION,
    declared: {
      enabled: pacing?.enabled === true,
      sentenceGapSeconds: pacing?.sentenceGapSeconds || 0,
      sceneGapSeconds: pacing?.sceneGapSeconds || 0,
    },
    storyUtterances: story.length,
    pauseCount: declared.length,
    sentencePauses: declared.filter((pair) => pair.kind === "sentence").length,
    scenePauses: declared.filter((pair) => pair.kind === "scene").length,
    addedSeconds: round(declared.reduce((sum, pair) => sum + pair.plannedSeconds, 0), 4),
  };
  if (declared.length === 0) {
    return { ...summary, pass: problems.length === 0, problems: [...new Set(problems)], pauses: [] };
  }
  const cues = [...await extractNarratedSubtitleCues(ffmpeg, videoPath)].sort((left, right) => left.start - right.start);
  const cueById = new Map();
  if (cues.length !== segments.length) problems.push("caption-count-differs-from-plan");
  else segments.forEach((segment, index) => cueById.set(segment.id, cues[index]));
  const narrationReferenceDb = await measureNarrationReferenceDb({ ffmpeg, videoPath, segments: story });
  if (narrationReferenceDb === null) problems.push("narration-reference-unmeasured");
  const framesById = new Map((programFrames?.segments || []).map((segment) => [segment.id, segment]));
  const captionTolerance = 0.5 * frameSeconds + 0.002;
  const lengthTolerance = PAUSE_LENGTH_TOLERANCE_FRAMES * frameSeconds;
  const rows = await mapLimit(declared, concurrency, async (pair) => {
    const { previous, next } = pair;
    const rowProblems = [...pair.problems];
    const pauseStart = previous.endSeconds;
    const pauseEnd = next.startSeconds;
    const metrics = {};
    // 採用したテイクそのものの端の無音（間の外。テイクの前後の無音は間に数えない）。
    const [previousTake, nextTake] = await Promise.all([decodeWhole(ffmpeg, previous.takePath), decodeWhole(ffmpeg, next.takePath)]);
    const previousEdges = loudSampleEdges(previousTake);
    const nextEdges = loudSampleEdges(nextTake);
    let takeTail = 0;
    let takeLead = 0;
    if (!previousEdges || !nextEdges) rowProblems.push("take-edges-unmeasured");
    else {
      takeTail = (previousEdges.length - previousEdges.last - 1) / SAMPLE_RATE;
      takeLead = nextEdges.first / SAMPLE_RATE;
    }
    // voice stem: 間の区間は挿入した無音で、語りの端どうしの無音の長さ − テイクの端の無音が宣言の秒。語りの端は、
    // 間が宣言の倍に伸びた（または語りが間へずれ込んだ）場合も測れるように、宣言の秒だけ外側まで探す。
    const searchMargin = pair.declaredSeconds + 0.3;
    const stemFrom = Math.max(0, pauseStart - takeTail - searchMargin);
    const stemTo = pauseEnd + takeLead + searchMargin;
    const stem = await extractNarratedPcm(ffmpeg, voiceStemPath, stemFrom, stemTo - stemFrom);
    const stemSeries = blockDbSeries(stem, stemFrom, pauseStart + 0.005, pauseEnd - 0.005, 0.01);
    const stemMaxDb = stemSeries.reduce((maximum, entry) => Math.max(maximum, entry.db), -120);
    if (stemMaxDb > BOUNDARY_STEM_SILENCE_DBFS) rowProblems.push("narration-inside-declared-pause");
    const edges = speechEdgesAround(stem, stemFrom, (pauseStart + pauseEnd) / 2);
    let insertedSeconds = null;
    if (edges.speechEnd === null || edges.speechStart === null) rowProblems.push("pause-edges-unmeasured");
    else {
      insertedSeconds = edges.speechStart - edges.speechEnd - takeTail - takeLead;
      if (Math.abs(insertedSeconds - pair.declaredSeconds) > lengthTolerance) rowProblems.push("pause-length-differs-from-declaration");
      if (Math.abs(edges.speechEnd - (pauseStart - takeTail)) > lengthTolerance) rowProblems.push("utterance-end-differs-from-plan");
      if (Math.abs(edges.speechStart - (pauseEnd + takeLead)) > lengthTolerance) rowProblems.push("utterance-start-differs-from-plan");
    }
    Object.assign(metrics, {
      takeTailSilenceSeconds: round(takeTail, 4),
      takeLeadSilenceSeconds: round(takeLead, 4),
      stemMaxDb: round(stemMaxDb, 2),
      stemSpeechEndSeconds: edges.speechEnd === null ? null : round(edges.speechEnd, 4),
      stemSpeechStartSeconds: edges.speechStart === null ? null : round(edges.speechStart, 4),
      insertedPauseSeconds: insertedSeconds === null ? null : round(insertedSeconds, 4),
      lengthErrorSeconds: insertedSeconds === null ? null : round(Math.abs(insertedSeconds - pair.declaredSeconds), 4),
    });
    // 完成 MP4: 間の中は BGM だけが流れる（途切れない・語りの大きさの音が無い）。次の語りは stem と同じ時刻に始まる。
    const mp4From = pauseStart;
    const mp4To = pauseEnd + takeLead + Math.max(0.8, searchMargin);
    const mp4 = await extractNarratedPcm(ffmpeg, videoPath, mp4From, mp4To - mp4From);
    const bedFrom = pauseStart + mp4EdgeExcludeSeconds;
    const bedTo = pauseEnd - mp4EdgeExcludeSeconds;
    if (bedTo - bedFrom >= 0.02) {
      const bedSeries = blockDbSeries(mp4, mp4From, bedFrom, bedTo, 0.01);
      const longestSilence = longestRunBelow(bedSeries, BOUNDARY_SILENCE_FLOOR_DBFS);
      const bedMinDb = bedSeries.reduce((minimum, entry) => Math.min(minimum, entry.db), Infinity);
      if (longestSilence > BOUNDARY_MAX_SILENCE_RUN_SECONDS) rowProblems.push("dead-air-inside-declared-pause");
      const levelSeries = blockDbSeries(mp4, mp4From, bedFrom, bedTo, Math.min(0.05, bedTo - bedFrom));
      const bedMaxDb = levelSeries.reduce((maximum, entry) => Math.max(maximum, entry.db), -120);
      const bedDeltaDb = narrationReferenceDb === null ? null : bedMaxDb - narrationReferenceDb;
      if (bedDeltaDb !== null && bedDeltaDb > BOUNDARY_LEAD_MAX_DELTA_DB) rowProblems.push("speech-level-audio-inside-declared-pause");
      Object.assign(metrics, {
        bedLongestSilenceSeconds: round(longestSilence, 3),
        bedMinDb: Number.isFinite(bedMinDb) ? round(bedMinDb, 2) : null,
        bedMaxDb: round(bedMaxDb, 2),
        bedDeltaDb: bedDeltaDb === null ? null : round(bedDeltaDb, 2),
      });
    } else {
      metrics.bedMeasured = false;
    }
    const stemOnset = firstOnset(blockDbSeries(stem, stemFrom, pauseEnd - 0.05, stemTo, 0.005), -45);
    const mp4Onset = narrationReferenceDb === null
      ? null
      : firstOnset(blockDbSeries(mp4, mp4From, pauseEnd - 0.05, mp4To, 0.005), narrationReferenceDb - 15);
    if (stemOnset === null) rowProblems.push("next-utterance-onset-unmeasured");
    else if (mp4Onset === null || Math.abs(mp4Onset - stemOnset) > BOUNDARY_ONSET_SYNC_TOLERANCE_SECONDS) rowProblems.push("mp4-narration-onset-drift");
    Object.assign(metrics, {
      stemOnsetSeconds: stemOnset === null ? null : round(stemOnset, 4),
      mp4OnsetSeconds: mp4Onset === null ? null : round(mp4Onset, 4),
    });
    // 字幕（MP4 の字幕のトラック）: 前の語りの終わりで消え、間の中には無く、次の語りの始まりで出る。
    const previousCue = cueById.get(previous.id) || null;
    const nextCue = cueById.get(next.id) || null;
    if (previousCue && Math.abs(previousCue.end - pauseStart) > captionTolerance) rowProblems.push("caption-not-cleared-at-utterance-end");
    if (nextCue && Math.abs(nextCue.start - pauseEnd) > captionTolerance) rowProblems.push("caption-not-shown-at-utterance-start");
    if (cues.some((cue) => overlaps(cue.start, cue.end, pauseStart + 0.002, pauseEnd - 0.002))) rowProblems.push("caption-inside-declared-pause");
    Object.assign(metrics, {
      previousCaptionEndSeconds: previousCue ? round(previousCue.end, 4) : null,
      nextCaptionStartSeconds: nextCue ? round(nextCue.start, 4) : null,
    });
    // 計画のフレーム: 焼き込み字幕の頁と場面の切り替え（間を持つ文の枠の中の、声の区間の外）。
    const previousFrames = framesById.get(previous.id) || null;
    const nextFrames = framesById.get(next.id) || null;
    if (previousFrames && nextFrames) {
      const pauseFrameStart = previousFrames.captionStartFrame + previousFrames.captionFrames;
      const pauseFrameEnd = nextFrames.captionStartFrame;
      metrics.pauseFrames = { start: pauseFrameStart, end: pauseFrameEnd };
      if (subtitleLayer && subtitleLayer.cues.some((cue) => overlaps(cue.startFrame, cue.endFrame, pauseFrameStart, pauseFrameEnd))) {
        rowProblems.push("burned-caption-planned-inside-pause");
      }
      if (pair.kind === "scene" && Array.isArray(sceneJoins)) {
        const join = sceneJoins.find((entry) => entry.cutFrame >= pauseFrameStart && entry.cutFrame <= pauseFrameEnd) || null;
        const from = join ? join.cutFrame - (join.type === "crossfade" ? join.before : 0) : null;
        const to = join ? join.cutFrame + (join.type === "crossfade" ? join.after : 0) : null;
        if (!join || from < pauseFrameStart || to > pauseFrameEnd) rowProblems.push("scene-change-outside-declared-pause");
        metrics.sceneChange = join ? { cutFrame: join.cutFrame, type: join.type, fromFrame: from, toFrame: to, ...(join.reduced ? { reduced: join.reduced } : {}) } : null;
      }
    }
    return {
      afterSegmentId: previous.id,
      beforeSegmentId: next.id,
      kind: pair.kind,
      declaredSeconds: pair.declaredSeconds,
      plannedSeconds: round(pair.plannedSeconds, 6),
      pauseStartSeconds: round(pauseStart, 4),
      pauseEndSeconds: round(pauseEnd, 4),
      pass: rowProblems.length === 0,
      problems: [...new Set(rowProblems)],
      metrics,
    };
  });
  const failed = rows.filter((row) => !row.pass);
  const lengthErrors = rows.map((row) => row.metrics.lengthErrorSeconds).filter((value) => value !== null && value !== undefined);
  return {
    ...summary,
    pass: problems.length === 0 && failed.length === 0,
    problems: [...new Set([...problems, ...failed.flatMap((row) => row.problems)])],
    failedPauses: failed.map((row) => `${row.afterSegmentId}>${row.beforeSegmentId}`),
    narrationReferenceDb: narrationReferenceDb === null ? null : round(narrationReferenceDb, 2),
    worstLengthErrorSeconds: lengthErrors.length ? Math.max(...lengthErrors) : null,
    pauses: rows,
  };
}

/** 監査 narrationPacingMeasured の判定（lib/narratedStoryPipeline.mjs が完成 MP4 を描いた後に呼ぶ）。 */
export async function narratedPacingAuditCheck(options) {
  const measured = await measureNarratedPacing(options);
  const pacing = options.pacing;
  let detail;
  if (!measured.pass) {
    detail = `declared pacing differs from the MP4/plan: ${measured.problems.join(", ")}${measured.failedPauses?.length ? ` (${measured.failedPauses.slice(0, 8).join(", ")})` : ""}`;
  } else if (!pacing?.enabled) {
    detail = `Channel Pack declares no pacing; ${measured.storyUtterances} story utterances are placed back to back (no inserted pause), as before`;
  } else if (measured.pauseCount === 0) {
    detail = `Channel Pack declares pacing (sentence ${pacing.sentenceGapSeconds}s, scene ${pacing.sceneGapSeconds}s) but no story boundary takes a pause`;
  } else {
    detail = `${measured.pauseCount} declared pauses (${measured.sentencePauses} sentence ${pacing.sentenceGapSeconds}s, ${measured.scenePauses} scene ${pacing.sceneGapSeconds}s; +${measured.addedSeconds}s) measured on the MP4 and its voice stem: `
      + "no narration inside, the bed never drops out and carries no speech-level audio, the inserted silence is within one frame of the declaration "
      + `(worst ${measured.worstLengthErrorSeconds}s), the next utterance starts together on the MP4 and the stem, captions clear at each utterance end and return at the next start, `
      + "every scene change sits inside its pause; no pause before the first or after the last story utterance, none in the review part";
  }
  return { pass: measured.pass, detail, measurement: measured };
}
