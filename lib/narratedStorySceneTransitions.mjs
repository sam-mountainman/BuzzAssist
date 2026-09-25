/**
 * ナレーション物語の本編の場面の切り替え（ジャンル層）。
 *
 * 本編の場面（カメラのショット＝同じ画が続く文のまとまり）の切り替えは、既定では cut（concat でつなぐ）。
 * Channel Pack の narrated-story.json `sceneTransition` で crossfade と秒数を宣言したときだけ、切り替えの
 * 前後を重ねて混ぜる。尺は足し引きしない: 出る側の場面を切り替えの後ろへ、入る側の場面を前へ伸ばして
 * 重ね（伸ばした分は動きの始まり・終わりの見せ方のまま）、重なりの分だけ短くなる xfade と打ち消し合う。
 * 字幕・声の時刻は切り替えの位置のまま動かない。
 *
 *   "sceneTransition": { "type": "crossfade", "durationSeconds": 0.5 }
 *
 * 重なりは各場面の半分まで（どの場面にも混ざらないフレームを2つ以上残す）。短い場面の隣では重なりを縮め、
 * 2フレームに満たなければその切り替えは cut のまま描き、計画（joins）にそう残す。
 *
 * 公開 Core なので、秒数などチャンネル固有の値は持たない。描く列は lib/ffmpegSequenceRender.mjs
 * （コマンド行の上限を越えない塊に分けて描く共有層）に渡す。監査 sceneTransitionMeasured は、完成 MP4 の
 * フレームで、宣言した crossfade が計画のフレームで線形に混ざっていること、cut の切り替えには混ざった
 * フレームが無いこと（宣言していなければ全部の切り替え）を測る。
 */

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import {
  cameraExclusionMask,
  cameraShotInputs,
  cameraShotPieceChain,
  groupNarratedCameraShots,
} from "./narratedStoryCamera.mjs";
import { renderVideoSequence, sequenceEvidenceGraphs } from "./ffmpegSequenceRender.mjs";

const execFile = promisify(execFileCallback);

export const NARRATED_SCENE_TRANSITION_AUDIT_ID = "sceneTransitionMeasured";
export const NARRATED_SCENE_TRANSITION_PLAN_VERSION = "buzzassist-narrated-story-scene-transition-plan-v1";
export const NARRATED_SCENE_TRANSITION_TYPES = Object.freeze(["cut", "crossfade"]);
export const NARRATED_SCENE_TRANSITION_FIELDS = Object.freeze(["type", "durationSeconds"]);

// ---- 監査の閾値 -------------------------------------------------------------
//
// test/narratedStorySceneTransitions.test.mjs の合成 fixture（模様の違う3枚の画・320x180・24fps・場面ごとに
// 寄り（0.03/秒）と横移動（0.04/秒）のカメラ、0.5 秒＝12 フレームの crossfade、部を描いたあともう1回符号化）で、
// 基準版と壊した版（crossfade を描かない・半分の長さで描く・宣言していないのに描く）を同じ測定にかけて決めた
// （2026-09-26、ffmpeg 7.1.1）。値を変えるときは同じ fixture を測り直すこと。

/** 測る画の大きさ（輝度、area で縮める）。 */
export const SCENE_TRANSITION_ANALYSIS = Object.freeze({ width: 96, height: 54 });
/**
 * 切り替えの前後の画の差（輝度の平均絶対差）がこれより小さいと、混ざり方を読めない（同じような画が続く）。
 * その切り替えは indistinguishable として数え、落とさない（描いた graph の検査 sceneTransitionOwnedByParent が
 * 転換の有無を別に見る）。実測: fixture の切り替え 23.7〜25.2。
 */
export const SCENE_JOIN_MIN_CONTRAST = 6;
/**
 * crossfade の重なりの各フレームで、推定した混ざり具合と計画（k/F）の差の上限。
 * 実測（全フレームの最大）: 基準版 0.028〜0.042、半分の長さで描いた版 0.252〜0.269、描かない版 0.456〜0.503。
 */
export const SCENE_CROSSFADE_WEIGHT_TOLERANCE = 0.12;
/**
 * 混ざったフレームを、重なりの前後の画の混ぜ合わせで説明できない残り（輝度の平均絶対差）の上限。黒や白を
 * 挟む転換・別の絵を落とす。重なりの間もカメラが動くので残りは 0 にならない。実測: 基準版 5.16〜6.69
 * （重なりが長く動きが速いほど増えるので、2 秒の重なりと宣言の上限の速さを見込んで広く取る）。
 */
export const SCENE_CROSSFADE_RESIDUAL_MAX = 16;
/** cut の直前のフレームの混ざり具合の上限（直後は 1 − これ以上）。実測: 基準版 ≤ 0.013、宣言せずに描いた版 0.31〜0.34。 */
export const SCENE_CUT_WEIGHT_MAX = 0.15;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

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

/**
 * narrated-story.json の `sceneTransition` を正規化する（純粋関数）。無ければ cut（Core の既定）。
 * crossfade の秒数は 0.1〜2 秒で、描く fps で 2 フレーム以上。
 */
export function normalizeNarratedSceneTransitionConfig(source, { fps = 24 } = {}) {
  if (source === undefined || source === null) return { config: { type: "cut", durationSeconds: 0, frames: 0, source: "core-default" }, blockers: [] };
  if (!plainObject(source)) return { config: null, blockers: ["sceneTransition"] };
  const blockers = [];
  for (const key of Object.keys(source)) if (!NARRATED_SCENE_TRANSITION_FIELDS.includes(key)) blockers.push(`sceneTransition.${key}-unknown`);
  const type = nonEmpty(source.type);
  if (!NARRATED_SCENE_TRANSITION_TYPES.includes(type)) blockers.push("sceneTransition.type");
  let durationSeconds = 0;
  if (type === "crossfade") {
    const parsed = Number(source.durationSeconds);
    if (!Number.isFinite(parsed) || parsed < 0.1 || parsed > 2) blockers.push("sceneTransition.durationSeconds");
    else durationSeconds = parsed;
  } else if (source.durationSeconds !== undefined && Number(source.durationSeconds) !== 0) blockers.push("sceneTransition.durationSeconds");
  const frames = type === "crossfade" ? Math.round(durationSeconds * fps) : 0;
  if (type === "crossfade" && durationSeconds > 0 && frames < 2) blockers.push("sceneTransition.durationSeconds-too-short-for-fps");
  if (blockers.length > 0) return { config: null, blockers: [...new Set(blockers)] };
  return { config: { type, durationSeconds, frames, source: "channel-pack" }, blockers: [] };
}

/** ショットの片側で重ねてよいフレーム数（混ざらないフレームを2つ以上残す）。 */
function overlapAllowance(frames) {
  return Math.max(0, Math.floor((frames - 2) / 2));
}

/**
 * 場面の切り替えの計画（純粋関数）。shots は同じ部の中で隣り合うショット（{ startFrame, frames }、フレームは
 * 部の中でも番組の中でもよい。返す cutFrame は同じ座標）。joins[i-1] が shots[i-1] と shots[i] の間:
 * { index, cutFrame, type, requestedFrames, frames, before, after }。crossfade は [cutFrame − before,
 * cutFrame + after) の frames フレームで混ざる（最初のフレームは出る側のまま、k フレーム目は入る側が k/F）。
 */
export function planNarratedSceneJoins({ shots = [], transition = null } = {}) {
  const requested = transition?.type === "crossfade" ? transition.frames : 0;
  const joins = [];
  for (let index = 1; index < shots.length; index += 1) {
    const outgoing = shots[index - 1];
    const incoming = shots[index];
    const cutFrame = incoming.startFrame;
    if (!requested) {
      joins.push({ index, cutFrame, type: "cut", requestedFrames: 0, frames: 0, before: 0, after: 0 });
      continue;
    }
    // 出る側の尾は、前の切り替えの頭の重なりと合わせて半分まで。入る側の頭も同じ。
    const outgoingAllowance = overlapAllowance(outgoing.frames);
    const incomingAllowance = overlapAllowance(incoming.frames);
    const frames = Math.min(requested, outgoingAllowance + incomingAllowance);
    let before = Math.min(outgoingAllowance, Math.floor(frames / 2));
    let after = frames - before;
    if (after > incomingAllowance) {
      after = incomingAllowance;
      before = frames - after;
    }
    if (frames < 2) {
      joins.push({ index, cutFrame, type: "cut", requestedFrames: requested, frames: 0, before: 0, after: 0, reduced: "shots-too-short" });
      continue;
    }
    joins.push({ index, cutFrame, type: "crossfade", requestedFrames: requested, frames, before, after, ...(frames < requested ? { reduced: "shots-too-short" } : {}) });
  }
  return joins;
}

/**
 * 番組のカメラの計画（lib/narratedStoryVisuals.mjs の planNarratedVisualCamera。番組のフレーム）から、本編の
 * 場面の切り替えの計画（番組のフレーム）を作る。描く側（renderNarratedSceneVideo）は部の中のフレームで同じ
 * 計画を作る（切り替えの長さはショットのフレーム数だけで決まるので、座標をずらしても同じ）。
 */
export function planNarratedProgramSceneJoins({ cameraPlan, transition }) {
  const shots = (cameraPlan?.shots || []).filter((shot) => (shot.part || "story") === "story");
  return planNarratedSceneJoins({ shots, transition });
}

/**
 * カメラの監査に、crossfade の重なりを測る範囲から外した印（measureFrom / measureTo）を付けたショットを返す。
 */
export function shotsOutsideSceneJoins(shots = [], joins = []) {
  const byCut = new Map(joins.filter((join) => join.type === "crossfade").map((join) => [join.cutFrame, join]));
  return shots.map((shot) => {
    const head = byCut.get(shot.startFrame);
    const tail = byCut.get(shot.startFrame + shot.frames);
    if (!head && !tail) return shot;
    return { ...shot, measureFrom: head ? head.after : 0, measureTo: shot.frames - (tail ? tail.before : 0) };
  });
}

/**
 * ショットと切り替えの計画から、描く列（lib/ffmpegSequenceRender.mjs の unit と join）を作る。
 * 各ショットは、前の crossfade の before 分を前へ、次の crossfade の after 分を後ろへ伸ばして描く。
 * split は、塊の境目が crossfade に当たったときに、混ざらないフレームの中ほどで2つに分ける。
 */
export function narratedSceneSequence({ shots, joins, render }) {
  const units = shots.map((shot, index) => {
    const head = index > 0 ? joins[index - 1] : null;
    const tail = index < shots.length - 1 ? joins[index] : null;
    const pureFrom = head?.type === "crossfade" ? head.after : 0;
    const pureTo = shot.frames - (tail?.type === "crossfade" ? tail.before : 0);
    const piece = (from, to, suffix = "") => ({
      id: `${shot.id || `shot-${index}`}${suffix}`,
      frames: to - from,
      inputs: cameraShotInputs(shot, render),
      chain: (inputIndex, label) => cameraShotPieceChain({ shot, render, inputIndex, label, fromFrame: from, frames: to - from }),
      split: () => {
        const start = Math.max(from, pureFrom);
        const end = Math.min(to, pureTo);
        const middle = Math.floor((start + end) / 2);
        if (!(middle > from && middle < to && middle >= pureFrom && middle <= pureTo)) throw new Error(`scene ${shot.id} cannot be split outside its crossfades`);
        return [piece(from, middle, `${suffix}#a`), piece(middle, to, `${suffix}#b`)];
      },
    });
    const from = head?.type === "crossfade" ? -head.before : 0;
    const to = shot.frames + (tail?.type === "crossfade" ? tail.after : 0);
    return piece(from, to);
  });
  const sequenceJoins = joins.map((join) => (join.type === "crossfade" ? { type: "crossfade", frames: join.frames } : { type: "cut" }));
  return { units, joins: sequenceJoins };
}

/**
 * 本編（または画の感想パート）の場面の画を、カメラのショットと切り替えの計画どおりに1本の動画に描く。
 * shots は部の中のフレームのショット（lib/narratedStoryBookends.mjs の partCameraShots）。
 */
export async function renderNarratedSceneVideo({ ffmpeg, shots, transition = null, render, outputPath, encode, budget }) {
  const joins = planNarratedSceneJoins({ shots, transition });
  const sequence = narratedSceneSequence({ shots, joins, render });
  const rendered = await renderVideoSequence({
    ffmpeg,
    units: sequence.units,
    joins: sequence.joins,
    fps: render.fps,
    outputPath,
    encode,
    ...(budget ? { budget } : {}),
  });
  const expected = shots.reduce((sum, shot) => sum + shot.frames, 0);
  if (rendered.frames !== expected) throw new Error(`scene video frames ${rendered.frames} differ from the planned ${expected}`);
  return {
    frames: rendered.frames,
    joins,
    graph: { ...rendered, imageInputCount: shots.length, videoMap: "[video]", shotCount: shots.length, sceneJoins: joins.map(({ cutFrame, type, frames }) => ({ cutFrame, type, frames })) },
  };
}

const TRANSITION_FILTER = /(?:^|[;,\]])\s*(?:x?fade|blend|tblend)(?:=|[;,[]|$)/iu;
const DECLARED_CROSSFADE = /xfade=transition=fade:duration=(\d+(?:\.\d+)?):offset=\d+(?:\.\d+)?/gu;

/**
 * 描いた場面の列の graph の検査（純粋関数）。宣言した crossfade（計画の切り替えの長さ）の xfade だけがあり、
 * それ以外の転換の filter が無く、塊ごとに [video] を出し、ショットの数だけの画を描いたこと。
 * evidence は renderNarratedSceneVideo の graph か、塊を持たない旧い形（concat だけ）。
 */
export function inspectNarratedSceneVideoGraph(evidence, { shotCount, joins = [], fps }) {
  const problems = [];
  const graphs = sequenceEvidenceGraphs(evidence);
  const planned = joins.filter((join) => join.type === "crossfade").map((join) => (join.frames / fps).toFixed(6)).sort();
  const drawn = [];
  for (const graph of graphs) {
    for (const match of graph.matchAll(DECLARED_CROSSFADE)) drawn.push(Number(match[1]).toFixed(6));
    if (TRANSITION_FILTER.test(graph.replace(DECLARED_CROSSFADE, ""))) problems.push("undeclared-transition-filter");
    if (!/\[video\]$/u.test(graph)) problems.push("chunk-output-not-video");
  }
  if (JSON.stringify(drawn.sort()) !== JSON.stringify(planned)) problems.push("crossfades-differ-from-plan");
  if (Array.isArray(evidence?.chunks)) {
    const ids = evidence.chunks.flatMap((chunk) => chunk.unitIds || []);
    const shots = ids.filter((id) => !/#b$/u.test(id));
    if (shots.length !== shotCount) problems.push("scene-count-differs-from-plan");
  } else if (!String(evidence?.filterGraph || "").includes(`concat=n=${shotCount}:v=1:a=0[video]`)) {
    problems.push("scene-count-differs-from-plan");
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

// ---- 実測（完成 MP4） ---------------------------------------------------------

async function grayRun(ffmpeg, videoPath, firstFrame, count, fps) {
  const { width, height } = SCENE_TRANSITION_ANALYSIS;
  const { stdout } = await execFile(ffmpeg.command, [...(ffmpeg.args || []),
    "-hide_banner", "-loglevel", "error", "-ss", Math.max(0, (firstFrame - 0.25) / fps).toFixed(6), "-i", videoPath,
    "-frames:v", String(count), "-vf", `scale=${width}:${height}:flags=area,format=gray`, "-f", "rawvideo", "-",
  ], { encoding: "buffer", timeout: 120_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const size = width * height;
  const frames = [];
  for (let offset = 0; offset + size <= stdout.length; offset += size) frames.push(stdout.subarray(offset, offset + size));
  return frames;
}

/**
 * f が a と b を (1−w):w で混ぜた画に最も近い w と、その残り（測らない画素は mask で外す）。
 * 戻り値の contrast は a と b の差（輝度の平均絶対差）。
 */
export function blendWeight(f, a, b, mask = null) {
  let dot = 0;
  let norm = 0;
  let contrast = 0;
  let count = 0;
  for (let index = 0; index < f.length; index += 1) {
    if (mask?.[index]) continue;
    const d = b[index] - a[index];
    dot += (f[index] - a[index]) * d;
    norm += d * d;
    contrast += Math.abs(d);
    count += 1;
  }
  const weight = norm > 0 ? dot / norm : 0;
  let residual = 0;
  for (let index = 0; index < f.length; index += 1) {
    if (mask?.[index]) continue;
    residual += Math.abs(f[index] - ((1 - weight) * a[index] + weight * b[index]));
  }
  return { weight, residual: count ? residual / count : 255, contrast: count ? contrast / count : 0 };
}

/**
 * 1つの切り替えを、そのまわりのフレーム（frames[0] が firstFrame）で判定する（純粋関数）。
 * - crossfade: 重なりの前の出る側の画 A（cutFrame − before − 1）と後の入る側の画 B（cutFrame + after）を
 *   混ぜた画として、重なりの最初・中ほど・最後のフレームの混ざり具合が計画（k/F）どおり
 * - cut: A = cutFrame − 2、B = cutFrame + 1 で、直前（cutFrame − 1）は A のまま、直後（cutFrame）は B
 */
export function judgeSceneJoin(join, frames, firstFrame, { mask = null } = {}) {
  const at = (frame) => frames[frame - firstFrame] || null;
  const problems = [];
  const samples = [];
  let contrast = 0;
  if (join.type === "crossfade") {
    const start = join.cutFrame - join.before;
    const a = at(start - 1);
    const b = at(join.cutFrame + join.after);
    if (!a || !b) return { pass: false, problems: ["join-frames-unavailable"], samples, contrast };
    contrast = blendWeight(a, a, b, mask).contrast;
    if (contrast < SCENE_JOIN_MIN_CONTRAST) return { pass: true, indistinguishable: true, problems, samples, contrast: round(contrast, 2) };
    // 重なりの全部のフレームを測る（最初・中ほど・最後だけでは、半分の長さで中央に描いた版が通る）。記録に
    // 残すのは最初・中ほど・最後と、最も外れたフレームの値。
    const shown = new Set([0, Math.floor(join.frames / 2), join.frames - 1]);
    let worstWeight = 0;
    let worstResidual = 0;
    for (let k = 0; k < join.frames; k += 1) {
      const frame = at(start + k);
      if (!frame) { problems.push("join-frames-unavailable"); continue; }
      const measured = blendWeight(frame, a, b, mask);
      const expected = k / join.frames;
      const error = Math.abs(measured.weight - expected);
      worstWeight = Math.max(worstWeight, error);
      worstResidual = Math.max(worstResidual, measured.residual);
      if (shown.has(k)) samples.push({ frame: start + k, expected: round(expected), weight: round(measured.weight), residual: round(measured.residual, 2) });
      if (error > SCENE_CROSSFADE_WEIGHT_TOLERANCE) problems.push("crossfade-weight-differs-from-plan");
      if (measured.residual > SCENE_CROSSFADE_RESIDUAL_MAX) problems.push("crossfade-not-a-blend-of-the-two-scenes");
    }
    return { pass: problems.length === 0, problems: [...new Set(problems)], samples, maxWeightError: round(worstWeight), maxResidual: round(worstResidual, 2), contrast: round(contrast, 2) };
  } else {
    const a = at(join.cutFrame - 2);
    const b = at(join.cutFrame + 1);
    const before = at(join.cutFrame - 1);
    const after = at(join.cutFrame);
    if (!a || !b || !before || !after) return { pass: false, problems: ["join-frames-unavailable"], samples, contrast };
    contrast = blendWeight(a, a, b, mask).contrast;
    if (contrast < SCENE_JOIN_MIN_CONTRAST) return { pass: true, indistinguishable: true, problems, samples, contrast: round(contrast, 2) };
    const last = blendWeight(before, a, b, mask);
    const first = blendWeight(after, a, b, mask);
    samples.push({ frame: join.cutFrame - 1, expected: 0, weight: round(last.weight), residual: round(last.residual, 2) });
    samples.push({ frame: join.cutFrame, expected: 1, weight: round(first.weight), residual: round(first.residual, 2) });
    if (last.weight > SCENE_CUT_WEIGHT_MAX || first.weight < 1 - SCENE_CUT_WEIGHT_MAX) problems.push("cut-shows-blended-frames");
  }
  return { pass: problems.length === 0, problems: [...new Set(problems)], samples, contrast: round(contrast, 2) };
}

/**
 * 完成 MP4 の本編の場面の切り替えを測る。joins は番組のフレームの計画（planNarratedProgramSceneJoins）。
 * exclude は字幕・固定の重ね物など、場面と関係なく出入りする範囲（描く寸法の px の矩形）。
 */
export async function measureNarratedSceneTransitions({ ffmpeg, videoPath, joins = [], render, exclude = [], concurrency = 4 }) {
  const { width, height } = SCENE_TRANSITION_ANALYSIS;
  const mask = cameraExclusionMask(exclude, render, width, height);
  const rows = await mapLimit(joins, concurrency, async (join) => {
    const firstFrame = join.type === "crossfade" ? join.cutFrame - join.before - 1 : join.cutFrame - 2;
    const lastFrame = join.type === "crossfade" ? join.cutFrame + join.after : join.cutFrame + 1;
    const frames = await grayRun(ffmpeg, videoPath, firstFrame, lastFrame - firstFrame + 1, render.fps);
    const judged = judgeSceneJoin(join, frames, firstFrame, { mask });
    return { cutFrame: join.cutFrame, type: join.type, frames: join.frames, before: join.before, after: join.after, ...(join.reduced ? { reduced: join.reduced } : {}), ...judged };
  });
  const failed = rows.filter((row) => !row.pass);
  return {
    version: NARRATED_SCENE_TRANSITION_PLAN_VERSION,
    analysis: { ...SCENE_TRANSITION_ANALYSIS },
    pass: failed.length === 0,
    joinCount: rows.length,
    crossfadeCount: rows.filter((row) => row.type === "crossfade").length,
    indistinguishableCount: rows.filter((row) => row.indistinguishable).length,
    failedCutFrames: failed.map((row) => row.cutFrame),
    problems: [...new Set(failed.flatMap((row) => row.problems))],
    joins: rows,
  };
}

/** generation manifest に残す場面の切り替えの記録（数値だけ）。 */
export function narratedSceneTransitionManifestEntry({ transition, joins = [] }) {
  return {
    version: NARRATED_SCENE_TRANSITION_PLAN_VERSION,
    type: transition?.type || "cut",
    durationSeconds: transition?.durationSeconds || 0,
    source: transition?.source || "core-default",
    joins: joins.map(({ cutFrame, type, frames, before, after, reduced }) => ({ cutFrame, type, frames, before, after, ...(reduced ? { reduced } : {}) })),
  };
}

/** 本編のショット（groupNarratedCameraShots と同じまとめ方）を、部の中の文から作る（計画の検査用）。 */
export function sceneShotsFromSegments(segments = []) {
  let cursor = 0;
  return groupNarratedCameraShots(segments.map((segment) => {
    const startFrame = Number.isInteger(segment.partStartFrame) ? segment.partStartFrame : cursor;
    cursor = startFrame + segment.frames;
    return { ...segment, startFrame };
  }));
}
