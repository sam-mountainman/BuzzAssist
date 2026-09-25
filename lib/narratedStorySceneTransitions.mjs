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
 * （コマンド行の上限を越えない塊に分けて描く共有層）に渡す。
 */

import {
  cameraShotInputs,
  cameraShotPieceChain,
  groupNarratedCameraShots,
} from "./narratedStoryCamera.mjs";
import { renderVideoSequence, sequenceEvidenceGraphs } from "./ffmpegSequenceRender.mjs";

export const NARRATED_SCENE_TRANSITION_PLAN_VERSION = "buzzassist-narrated-story-scene-transition-plan-v1";
export const NARRATED_SCENE_TRANSITION_TYPES = Object.freeze(["cut", "crossfade"]);
export const NARRATED_SCENE_TRANSITION_FIELDS = Object.freeze(["type", "durationSeconds"]);

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

/** 本編のショット（groupNarratedCameraShots と同じまとめ方）を、部の中の文から作る（計画の検査用）。 */
export function sceneShotsFromSegments(segments = []) {
  let cursor = 0;
  return groupNarratedCameraShots(segments.map((segment) => {
    const startFrame = Number.isInteger(segment.partStartFrame) ? segment.partStartFrame : cursor;
    cursor = startFrame + segment.frames;
    return { ...segment, startFrame };
  }));
}
