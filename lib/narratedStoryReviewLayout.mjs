/**
 * ナレーション物語の感想パートの配置（ジャンル層）。
 *
 * 感想パート（bookends.review）の区間ごとに配置の型を選ぶ:
 *   - plain: TV 枠なし。人物の映像があれば全面に、無ければ感想の文の画（カメラつき）を出す（従来の感想パート）
 *   - tv-left-presenter-right: 画面の左に TV 枠（中に本編の場面の画）、右に人物の枠。人物の映像が無ければ
 *     枠は空のまま（代わりの人物を描かない・生成しない）
 *
 * TV 枠の中身（Pack の bookends.review.layout.tv.content）:
 *   - still（既定）: 本編の場面の画を止めたまま
 *   - scene-motion: 本編の場面の画を、本編でその場面に当てたカメラの型で動かした映像（区間の長さで動きを
 *     計画し直す。lib/narratedStoryCamera.mjs）
 *   - operator-video: 運営者が渡した短い動画（Job の運営者の動画の取り込みの枠 review-tv。
 *     lib/operatorVideoImport.mjs）。感想パートの時間で流し、短ければ頭から繰り返す。音は使わない
 *
 * 公開 Core なので、枠の位置・大きさ・色はチャンネル固有の値として Channel Pack の
 * narrated-story.json `bookends.review.layout` から受け取る（画面に対する割合）。Core が持つのは型・区間の
 * まとめ方・描き方・完成 MP4 を測る監査だけ。
 *
 * 人物の映像は、Pack の bookends.review.presenter.video（チャンネルで共通の素材）か、回ごとに運営者が
 * 渡す動画（Job の運営者の動画の取り込みの枠 review-presenter。lib/operatorVideoImport.mjs）から来る。
 * 人物の映像の音は使わない（感想の語りは声のテイク）。
 */

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { cameraPerspectiveFilter } from "./narratedStoryCamera.mjs";

const execFile = promisify(execFileCallback);

export const NARRATED_REVIEW_LAYOUTS = Object.freeze(["plain", "tv-left-presenter-right"]);
export const NARRATED_REVIEW_LAYOUT_AUDIT_ID = "reviewLayoutMeasured";
/** 回ごとの人物の映像の、運営者の動画の取り込みの枠の名前。 */
export const REVIEW_PRESENTER_VIDEO_SLOT = "review-presenter";
/** TV 枠の中に流す、運営者の動画の取り込みの枠の名前（tv.content が operator-video のとき）。 */
export const REVIEW_TV_VIDEO_SLOT = "review-tv";
/** TV 枠の中身の種類。 */
export const NARRATED_REVIEW_TV_CONTENTS = Object.freeze(["still", "scene-motion", "operator-video"]);
export const NARRATED_REVIEW_LAYOUT_FIELDS = Object.freeze({
  top: Object.freeze(["default", "backgroundColor", "tv", "presenterFrame"]),
  tv: Object.freeze(["x", "y", "width", "height", "borderColor", "borderRatio", "content"]),
  presenterFrame: Object.freeze(["x", "y", "width", "height", "borderColor", "borderRatio", "emptyColor"]),
});

// ---- 監査の閾値 -------------------------------------------------------------
//
// test/narratedStoryReviewLayout.test.mjs の合成 fixture（320x180・24fps、試験の画と動く人物の映像。人物の映像
// あり・なしの2通り）で、基準版と壊した版（TV の中を別の絵と比べる・人物の映像の有無を逆に申告する）を同じ
// 測定にかけて決めた（2026-09-25、ffmpeg 7.1.1）。値を変えるときは同じ fixture を測り直すこと。

/**
 * 領域の輝度の平均絶対差（0〜255）の上限。TV の中の画・人物の枠の中・全面の人物の映像を、期待する絵
 * （素材を同じ合わせ方で読んだもの）と比べる。実測: 基準版 0.37〜1.59、TV の中が別の絵 83.4〜83.6、
 * 人物が映っていない枠を人物の映像と比べた版 68.1〜103.4。
 */
export const LAYOUT_REGION_MAX_DIFF = 8;
/**
 * TV の中身が動く型（scene-motion / operator-video）で、区間の始まりと終わりの TV の中の変わり方を比べる。
 * 期待する絵の変わり方（輝度の平均絶対差）がこれ以上ある区間だけを見る（動きがほとんど無い区間は比べない）。
 * 実測（test/narratedStoryReviewTvContent.test.mjs、2026-09-26、ffmpeg 7.1.1）: 1.5 秒の区間で scene-motion（pan-left）
 * 37.8、operator-video（動く試験映像）11.1。
 */
export const TV_MOTION_MIN_EXPECTED_CHANGE = 3;
/**
 * 完成 MP4 の TV の中の変わり方が、期待する変わり方のこの割合に満たなければ「動いていない」。止まった画で
 * 代用した版は 0 に近い。実測: 基準版 scene-motion 37.3/37.8（0.99）、operator-video 11.3/11.1（1.02）。
 * TV の中そのものの一致（LAYOUT_REGION_MAX_DIFF）の実測: 基準版 scene-motion 1.33〜1.46・operator-video 0.88〜1.16、
 * 動く計画を止めた画と比べた版 20.4〜25.2。
 */
export const TV_MOTION_MIN_RATIO = 0.5;
/**
 * 単色であるべき領域（枠の線・背景・空の人物の枠）の、宣言した色の輝度との差の上限。
 * 実測: 基準版 0.04〜1.87、人物が映っている枠を空の枠と比べた版 67.7〜69.3、plain の区間の枠の線の位置 62.8〜199.2。
 */
export const LAYOUT_FLAT_MAX_DIFF = 10;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rangeNumber(value, minimum, maximum) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function colorOf(value) {
  const text = nonEmpty(value);
  return /^#[0-9a-f]{6}$/iu.test(text) ? text.toLowerCase() : "";
}

function lumaOfHex(hex) {
  const value = Number.parseInt(String(hex).slice(1), 16);
  return 0.299 * ((value >> 16) & 255) + 0.587 * ((value >> 8) & 255) + 0.114 * (value & 255);
}

function even(value) {
  return Math.max(2, Math.round(value / 2) * 2);
}

function ffColor(hex) {
  return `0x${String(hex).slice(1)}`;
}

/** 画面に対する割合の矩形を、描く寸法の px（偶数）にする。 */
function pixelRect(rect, render) {
  return {
    x: even(rect.x * render.width),
    y: even(rect.y * render.height),
    width: even(rect.width * render.width),
    height: even(rect.height * render.height),
  };
}

function normalizeRect(source, label, blockers, fields) {
  if (!plainObject(source)) {
    blockers.push(label);
    return null;
  }
  for (const key of Object.keys(source)) if (!fields.includes(key)) blockers.push(`${label}.${key}-unknown`);
  const x = rangeNumber(source.x, 0, 0.98);
  const y = rangeNumber(source.y, 0, 0.98);
  const width = rangeNumber(source.width, 0.05, 1);
  const height = rangeNumber(source.height, 0.05, 1);
  for (const [key, value] of Object.entries({ x, y, width, height })) if (value === null) blockers.push(`${label}.${key}`);
  if (x !== null && width !== null && x + width > 1) blockers.push(`${label}.outside-frame`);
  if (y !== null && height !== null && y + height > 1) blockers.push(`${label}.outside-frame`);
  const borderColor = colorOf(source.borderColor);
  if (!borderColor) blockers.push(`${label}.borderColor`);
  const borderRatio = rangeNumber(source.borderRatio, 0.002, 0.05);
  if (borderRatio === null) blockers.push(`${label}.borderRatio`);
  return { x: x ?? 0, y: y ?? 0, width: width ?? 0.1, height: height ?? 0.1, borderColor, borderRatio: borderRatio ?? 0.002 };
}

/**
 * narrated-story.json の `bookends.review.layout` を正規化する（純粋関数）。
 *
 *   "layout": {
 *     "default": "tv-left-presenter-right",        // 台本が区間の型を指定しない文に使う型
 *     "backgroundColor": "#1a1d24",               // TV の型の背景
 *     "tv": { "x": 0.03, "y": 0.08, "width": 0.6, "height": 0.6, "borderColor": "#000000", "borderRatio": 0.01,
 *             "content": "scene-motion" },                // 省略すると still
 *     "presenterFrame": { "x": 0.66, "y": 0.12, "width": 0.31, "height": 0.62, "borderColor": "#ffffff", "borderRatio": 0.006, "emptyColor": "#30343c" }
 *   }
 *
 * 位置と大きさは画面に対する割合。枠の線の太さ（borderRatio）は画面の高さに対する割合で、線は枠の外側に描く。
 */
export function normalizeNarratedReviewLayoutConfig(source, { render = { width: 1280, height: 720 } } = {}) {
  const blockers = [];
  if (source === undefined || source === null) return { config: null, blockers };
  if (!plainObject(source)) return { config: null, blockers: ["bookends.review.layout"] };
  for (const key of Object.keys(source)) if (!NARRATED_REVIEW_LAYOUT_FIELDS.top.includes(key)) blockers.push(`bookends.review.layout.${key}-unknown`);
  const fallback = nonEmpty(source.default);
  if (!NARRATED_REVIEW_LAYOUTS.includes(fallback)) blockers.push("bookends.review.layout.default");
  const backgroundColor = colorOf(source.backgroundColor);
  if (!backgroundColor) blockers.push("bookends.review.layout.backgroundColor");
  const tv = normalizeRect(source.tv, "bookends.review.layout.tv", blockers, NARRATED_REVIEW_LAYOUT_FIELDS.tv);
  const presenter = normalizeRect(source.presenterFrame, "bookends.review.layout.presenterFrame", blockers, NARRATED_REVIEW_LAYOUT_FIELDS.presenterFrame);
  const emptyColor = colorOf(source.presenterFrame?.emptyColor);
  if (source.presenterFrame && !emptyColor) blockers.push("bookends.review.layout.presenterFrame.emptyColor");
  const tvContent = source.tv?.content === undefined ? "still" : nonEmpty(source.tv.content);
  if (!NARRATED_REVIEW_TV_CONTENTS.includes(tvContent)) blockers.push("bookends.review.layout.tv.content");
  if (tv && presenter) {
    const overlapX = Math.min(tv.x + tv.width, presenter.x + presenter.width) - Math.max(tv.x, presenter.x);
    const overlapY = Math.min(tv.y + tv.height, presenter.y + presenter.height) - Math.max(tv.y, presenter.y);
    if (overlapX > 0 && overlapY > 0) blockers.push("bookends.review.layout.frames-overlap");
  }
  if (blockers.length > 0) return { config: null, blockers: [...new Set(blockers)] };
  const border = (ratio) => Math.max(2, even(ratio * render.height));
  const config = {
    default: fallback,
    backgroundColor,
    tv: { ...pixelRect(tv, render), borderColor: tv.borderColor, borderPx: border(tv.borderRatio), content: tvContent },
    presenterFrame: { ...pixelRect(presenter, render), borderColor: presenter.borderColor, borderPx: border(presenter.borderRatio), emptyColor },
  };
  // 枠の線（枠の外側に描く）も画面の中に収まること。
  for (const [name, rect] of [["tv", config.tv], ["presenterFrame", config.presenterFrame]]) {
    if (rect.x - rect.borderPx < 0 || rect.y - rect.borderPx < 0
      || rect.x + rect.width + rect.borderPx > render.width || rect.y + rect.height + rect.borderPx > render.height) {
      blockers.push(`bookends.review.layout.${name}.border-outside-frame`);
    }
  }
  if (blockers.length > 0) return { config: null, blockers };
  return { config, blockers: [] };
}

/**
 * 感想の文（部の中の partStartFrame・frames を持つ）を、配置の区間にまとめる。
 * - 型は文の reviewLayout（台本パッケージの layout）か、Pack の既定
 * - TV の型の文は、中に出す本編の場面（tvScene。台本パッケージの tvScene か、本編の場面を順に）を持つ。
 *   TV の中身が運営者の動画（tv.content: operator-video）なら場面は使わない（台本の tvScene も使わない）
 * 同じ型・同じ中身の隣り合う文は1つの区間にまとめる。
 */
export function planNarratedReviewSections({ segments = [], layout, storyScenes = [] }) {
  const problems = [];
  const sections = [];
  const sceneIds = storyScenes.map((scene) => scene.sceneId);
  let cycle = 0;
  let cursor = 0;
  for (const segment of segments) {
    const kind = segment.reviewLayout || layout.default;
    if (!NARRATED_REVIEW_LAYOUTS.includes(kind)) problems.push(`review-layout-unknown:${segment.sourceSegmentId || segment.id}`);
    let tvScene = "";
    const scenesInTv = kind === "tv-left-presenter-right" && layout.tv?.content !== "operator-video";
    if (scenesInTv) {
      if (segment.tvScene) {
        if (!sceneIds.includes(segment.tvScene)) problems.push(`review-tv-scene-unknown:${segment.sourceSegmentId || segment.id}`);
        tvScene = segment.tvScene;
      } else if (sceneIds.length > 0) {
        tvScene = sceneIds[cycle % sceneIds.length];
        cycle += 1;
      } else problems.push("review-tv-scene-unavailable");
    }
    const startFrame = Number.isInteger(segment.partStartFrame) ? segment.partStartFrame : cursor;
    cursor = startFrame + segment.frames;
    const last = sections.at(-1);
    if (last && last.layout === kind && last.tvScene === tvScene && last.startFrame + last.frames === startFrame
      && (!scenesInTv || !segment.tvScene || segment.tvScene === last.tvScene)) {
      last.frames += segment.frames;
      last.segmentIds.push(segment.id);
      continue;
    }
    sections.push({ layout: kind, tvScene, startFrame, frames: segment.frames, segmentIds: [segment.id] });
  }
  const byScene = new Map(storyScenes.map((scene) => [scene.sceneId, scene.imagePath]));
  for (const section of sections) section.tvImagePath = section.tvScene ? byScene.get(section.tvScene) || "" : "";
  return { sections, problems: [...new Set(problems)] };
}

function coverGraph(width, height) {
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;
}

function fitGraph(render, padColor) {
  return `scale=${render.width}:${render.height}:force_original_aspect_ratio=decrease,pad=${render.width}:${render.height}:(ow-iw)/2:(oh-ih)/2:${padColor ? ffColor(padColor) : "black"},setsar=1`;
}

/** 画を描く寸法に合わせる鎖（本編の場面の画と同じ合わせ方。カメラはこの上で動かす）。 */
function sceneCanvasGraph(render) {
  return `scale=${render.width}:${render.height}:force_original_aspect_ratio=decrease,pad=${render.width}:${render.height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv444p`;
}

/**
 * TV 枠の中身の入力と鎖（[input:v] → TV の大きさ）。区間の中のフレームで section.frames フレームを出す。
 * still は場面の画を覆って切り取る。scene-motion は場面の画を描く寸法に合わせ、区間のカメラ（section.tvMotion）で
 * 動かしてから覆う。operator-video は運営者の動画を感想パートの時間（section.startFrame から）で流す。
 */
export function reviewTvContentChain({ section, layout, render, tvVideoPath = "", inputIndex }) {
  const { fps } = render;
  const { tv } = layout;
  const content = tv.content || "still";
  const tail = `trim=end_frame=${section.frames},setpts=N/(${fps}*TB)`;
  if (content === "operator-video") {
    if (!tvVideoPath) throw new Error("review TV operator video is required for tv.content operator-video");
    return {
      inputs: ["-stream_loop", "-1", "-i", tvVideoPath],
      graph: `[${inputIndex}:v]fps=${fps},trim=start_frame=${section.startFrame}:end_frame=${section.startFrame + section.frames},setpts=N/(${fps}*TB),${coverGraph(tv.width, tv.height)}`,
    };
  }
  const inputs = ["-loop", "1", "-framerate", String(fps), "-i", section.tvImagePath];
  if (content === "scene-motion") {
    if (!section.tvMotion) throw new Error("review TV scene motion was not planned");
    const still = section.tvMotion.move === "static" && section.tvMotion.from.zoom === 1;
    return {
      inputs,
      graph: `[${inputIndex}:v]${sceneCanvasGraph(render)},${still ? "null" : cameraPerspectiveFilter(section.tvMotion)},${tail},fps=${fps},${coverGraph(tv.width, tv.height)}`,
    };
  }
  return { inputs, graph: `[${inputIndex}:v]${coverGraph(tv.width, tv.height)},fps=${fps},${tail}` };
}

/**
 * 1つの区間を描く filter の鎖（[label] を出す）と、その入力。imageChain は plain で人物の映像が無い区間の
 * 画の描き方（カメラつき。呼び出し側が lib/narratedStoryCamera.mjs で作る）。
 */
export function reviewSectionChain({ section, index, label = `r${index}`, layout, render, presenterPath, presenterBackground, tvVideoPath = "", inputOffset, imageChain = null }) {
  const { fps } = render;
  const frames = section.frames;
  const presenterTrim = (input) => `[${input}:v]fps=${fps},trim=start_frame=${section.startFrame}:end_frame=${section.startFrame + frames},setpts=N/(${fps}*TB)`;
  if (section.layout === "plain") {
    if (presenterPath) {
      return {
        inputs: ["-stream_loop", "-1", "-i", presenterPath],
        chain: `${presenterTrim(inputOffset)},${fitGraph(render, presenterBackground)},format=yuv420p,trim=end_frame=${frames},setpts=N/(${fps}*TB),fps=${fps}[${label}]`,
      };
    }
    if (!imageChain) throw new Error("plain review section without presenter needs the image chain");
    return imageChain(label, inputOffset);
  }
  const { tv, presenterFrame } = layout;
  const content = reviewTvContentChain({ section, layout, render, tvVideoPath, inputIndex: inputOffset });
  const inputs = [...content.inputs];
  const parts = [
    `color=c=${ffColor(layout.backgroundColor)}:s=${render.width}x${render.height}:r=${fps},trim=end_frame=${frames},setsar=1[bg${index}]`,
    `${content.graph}[tv${index}]`,
  ];
  let canvas = `[bg${index}][tv${index}]overlay=x=${tv.x}:y=${tv.y}:shortest=1`;
  canvas += `,drawbox=x=${tv.x - tv.borderPx}:y=${tv.y - tv.borderPx}:w=${tv.width + 2 * tv.borderPx}:h=${tv.height + 2 * tv.borderPx}:color=${ffColor(tv.borderColor)}:t=${tv.borderPx}`;
  if (presenterPath) {
    inputs.push("-stream_loop", "-1", "-i", presenterPath);
    parts.push(`${presenterTrim(inputOffset + 1)},${coverGraph(presenterFrame.width, presenterFrame.height)}[pv${index}]`);
    parts.push(`${canvas}[cv${index}]`);
    canvas = `[cv${index}][pv${index}]overlay=x=${presenterFrame.x}:y=${presenterFrame.y}:shortest=1`;
  } else {
    // 人物の映像が無ければ枠は空のまま（代わりの人物を描かない）。
    canvas += `,drawbox=x=${presenterFrame.x}:y=${presenterFrame.y}:w=${presenterFrame.width}:h=${presenterFrame.height}:color=${ffColor(presenterFrame.emptyColor)}:t=fill`;
  }
  canvas += `,drawbox=x=${presenterFrame.x - presenterFrame.borderPx}:y=${presenterFrame.y - presenterFrame.borderPx}:w=${presenterFrame.width + 2 * presenterFrame.borderPx}:h=${presenterFrame.height + 2 * presenterFrame.borderPx}:color=${ffColor(presenterFrame.borderColor)}:t=${presenterFrame.borderPx}`;
  canvas += `,format=yuv420p,trim=end_frame=${frames},setpts=N/(${fps}*TB),fps=${fps}[${label}]`;
  parts.push(canvas);
  return { inputs, chain: parts.join(";") };
}

/** generation manifest に残す配置の記録（区間の型・時刻・中身の場面 id・TV の中身・人物の映像の有無だけ）。 */
export function narratedReviewLayoutManifestEntry({ sections, layout, presenter, tvVideo = null }) {
  return {
    default: layout.default,
    tvContent: layout.tv?.content || "still",
    ...(tvVideo ? { tvVideo: { source: "operator-video", sha256: tvVideo.sha256 || null } } : {}),
    presenter: presenter ? { source: presenter.source, sha256: presenter.sha256 } : null,
    sections: sections.map((section) => ({
      layout: section.layout,
      startFrame: section.startFrame,
      frames: section.frames,
      segmentIds: section.segmentIds,
      tvScene: section.tvScene || null,
      ...(section.tvMotion ? { tvMotion: { move: section.tvMotion.move, from: section.tvMotion.from, to: section.tvMotion.to } } : {}),
    })),
  };
}

// ---- 実測 -----------------------------------------------------------------

const ANALYSIS_WIDTH = 160;

async function grayFrameAt(ffmpeg, videoPath, frame, fps, width, height) {
  const { stdout } = await execFile(ffmpeg.command, [...(ffmpeg.args || []),
    "-hide_banner", "-loglevel", "error", "-ss", Math.max(0, (frame - 0.25) / fps).toFixed(6), "-i", videoPath,
    "-frames:v", "1", "-vf", `scale=${width}:${height}:flags=area,format=gray`, "-f", "rawvideo", "-",
  ], { encoding: "buffer", timeout: 120_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return stdout.length >= width * height ? stdout.subarray(0, width * height) : null;
}

/** 期待する絵: 素材を描くときと同じ合わせ方で読み、同じ縮小で輝度にする（人物の映像は frameIndex 番目）。 */
async function expectedGray(ffmpeg, file, graph, frameIndex, { loop = false, still = false, width, height, fps }) {
  const input = still ? ["-loop", "1", "-framerate", String(fps), "-i", file] : [...(loop ? ["-stream_loop", "-1"] : []), "-i", file];
  const { stdout } = await execFile(ffmpeg.command, [...(ffmpeg.args || []),
    "-hide_banner", "-loglevel", "error", ...input,
    "-vf", `fps=${fps},${graph},select=eq(n\\,${frameIndex}),scale=${width}:${height}:flags=area,format=gray`,
    "-frames:v", "1", "-fps_mode", "passthrough", "-f", "rawvideo", "-",
  ], { encoding: "buffer", timeout: 120_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return stdout.length >= width * height ? stdout.subarray(0, width * height) : null;
}

function scaledRect(rect, render, width, height, inset = 2) {
  const scaleX = width / render.width;
  const scaleY = height / render.height;
  const x = Math.ceil(rect.x * scaleX) + inset;
  const y = Math.ceil(rect.y * scaleY) + inset;
  const right = Math.floor((rect.x + rect.width) * scaleX) - inset;
  const bottom = Math.floor((rect.y + rect.height) * scaleY) - inset;
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

/** 2枚の輝度の画の、矩形の中の平均絶対差（expectedRect は期待の画の中の同じ大きさの矩形）。 */
function regionDiff(frame, frameWidth, rect, expected, expectedWidth, expectedRect = rect) {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < rect.height; y += 1) {
    for (let x = 0; x < rect.width; x += 1) {
      const actual = frame[(rect.y + y) * frameWidth + rect.x + x];
      const wanted = expected[(expectedRect.y + y) * expectedWidth + expectedRect.x + x];
      sum += Math.abs(actual - wanted);
      count += 1;
    }
  }
  return count ? sum / count : 255;
}

function flatDiff(frame, frameWidth, rect, luma) {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < rect.height; y += 1) {
    for (let x = 0; x < rect.width; x += 1) {
      sum += Math.abs(frame[(rect.y + y) * frameWidth + rect.x + x] - luma);
      count += 1;
    }
  }
  return count ? sum / count : 255;
}

/**
 * 感想パートの配置を完成 MP4 で測る。区間ごとに、始まり・中ほど・終わりのフレームで
 * - TV の型: 背景が宣言の色、TV 枠の線が宣言の色、TV の中が本編の場面の画（同じ合わせ方で読んだもの）、
 *   人物の枠の線が宣言の色、人物の枠の中が人物の映像のその時刻のフレーム（無ければ空の枠の色のまま）
 * - plain の型で人物の映像がある: 画面の全体が人物の映像のその時刻のフレーム
 * - plain の型で人物の映像が無い: 画はカメラの監査（cameraMotionMeasured）が測る。ここでは TV の型の
 *   枠が描かれていないことだけを見る
 * 始まりと終わりのフレームで型が合うことで、区間の切り替わりが計画のフレームにあることも確かめる。
 * reviewStartFrame は番組の中の感想パートの頭のフレーム。
 */
export async function measureNarratedReviewLayout({ ffmpeg, videoPath, sections, layout, render, reviewStartFrame, presenterPath = "", presenterBackground = "", tvVideoPath = "" }) {
  const tvContent = layout.tv.content || "still";
  const width = ANALYSIS_WIDTH;
  const height = Math.max(2, Math.round((width * render.height) / render.width));
  const fps = render.fps;
  const tvInner = scaledRect(layout.tv, render, width, height);
  const presenterInner = scaledRect(layout.presenterFrame, render, width, height);
  const tvBorder = scaledRect({ x: layout.tv.x - layout.tv.borderPx, y: layout.tv.y - layout.tv.borderPx, width: layout.tv.width + 2 * layout.tv.borderPx, height: layout.tv.borderPx }, render, width, height, 0);
  const presenterBorder = scaledRect({ x: layout.presenterFrame.x - layout.presenterFrame.borderPx, y: layout.presenterFrame.y - layout.presenterFrame.borderPx, width: layout.presenterFrame.width + 2 * layout.presenterFrame.borderPx, height: layout.presenterFrame.borderPx }, render, width, height, 0);
  // 背景は2つの枠の外側（上の端の帯と下の端の帯のうち、枠に掛からない行）から取る。
  const topOfFrames = Math.min(layout.tv.y - layout.tv.borderPx, layout.presenterFrame.y - layout.presenterFrame.borderPx);
  const background = topOfFrames * (height / render.height) >= 4
    ? { x: 1, y: 1, width: width - 2, height: Math.max(1, Math.floor(topOfFrames * (height / render.height)) - 2) }
    : null;
  const tvScale = { width: Math.max(2, Math.round(layout.tv.width * (width / render.width))), height: Math.max(2, Math.round(layout.tv.height * (height / render.height))) };
  const presenterScale = { width: Math.max(2, Math.round(layout.presenterFrame.width * (width / render.width))), height: Math.max(2, Math.round(layout.presenterFrame.height * (height / render.height))) };
  const rows = [];
  for (const section of sections) {
    const problems = [];
    const samples = [...new Set([0, Math.floor(section.frames / 2), section.frames - 1])];
    const metrics = [];
    // TV の中身が動く型では、最初と最後のフレームの TV の中（完成 MP4 と期待の絵）を残して変わり方を比べる。
    const tvEnds = [];
    for (const local of samples) {
      const programFrame = reviewStartFrame + section.startFrame + local;
      const frame = await grayFrameAt(ffmpeg, videoPath, programFrame, fps, width, height);
      if (!frame) { problems.push("frame-unavailable"); continue; }
      const presenterIndex = section.startFrame + local;
      const entry = { frame: programFrame };
      if (section.layout === "tv-left-presenter-right") {
        entry.tvBorderDiff = flatDiff(frame, width, tvBorder, lumaOfHex(layout.tv.borderColor));
        entry.presenterBorderDiff = flatDiff(frame, width, presenterBorder, lumaOfHex(layout.presenterFrame.borderColor));
        if (background) entry.backgroundDiff = flatDiff(frame, width, background, lumaOfHex(layout.backgroundColor));
        // TV の中の期待する絵: 描くときと同じ合わせ方で読む（still は場面の画、scene-motion は区間のカメラで動かした
        // 場面の画のそのフレーム、operator-video は運営者の動画の感想パートの時刻のフレーム）。
        const tvCover = coverGraph(layout.tv.width, layout.tv.height);
        const tvExpected = tvContent === "operator-video"
          ? (tvVideoPath ? await expectedGray(ffmpeg, tvVideoPath, tvCover, presenterIndex, { loop: true, width: tvScale.width, height: tvScale.height, fps }) : null)
          : (tvContent === "scene-motion"
            ? (section.tvMotion ? await expectedGray(ffmpeg, section.tvImagePath, `${sceneCanvasGraph(render)},${section.tvMotion.move === "static" && section.tvMotion.from.zoom === 1 ? "null" : cameraPerspectiveFilter(section.tvMotion)},${tvCover}`, local, { still: true, width: tvScale.width, height: tvScale.height, fps }) : null)
            : await expectedGray(ffmpeg, section.tvImagePath, tvCover, 0, { still: true, width: tvScale.width, height: tvScale.height, fps }));
        const tvOffset = { x: tvInner.x - Math.ceil(layout.tv.x * (width / render.width)), y: tvInner.y - Math.ceil(layout.tv.y * (height / render.height)) };
        const tvRegion = { ...tvInner, width: Math.min(tvInner.width, tvScale.width - tvOffset.x), height: Math.min(tvInner.height, tvScale.height - tvOffset.y) };
        entry.tvContentDiff = tvExpected
          ? regionDiff(frame, width, tvRegion, tvExpected, tvScale.width, { ...tvOffset, width: 0, height: 0 })
          : 255;
        if (tvContent !== "still" && tvExpected && (local === 0 || local === section.frames - 1)) tvEnds.push({ frame, expected: tvExpected, region: tvRegion, offset: tvOffset });
        if (presenterPath) {
          const expected = await expectedGray(ffmpeg, presenterPath, coverGraph(layout.presenterFrame.width, layout.presenterFrame.height), presenterIndex, { loop: true, width: presenterScale.width, height: presenterScale.height, fps });
          const offset = { x: presenterInner.x - Math.ceil(layout.presenterFrame.x * (width / render.width)), y: presenterInner.y - Math.ceil(layout.presenterFrame.y * (height / render.height)) };
          entry.presenterDiff = expected
            ? regionDiff(frame, width, { ...presenterInner, width: Math.min(presenterInner.width, presenterScale.width - offset.x), height: Math.min(presenterInner.height, presenterScale.height - offset.y) }, expected, presenterScale.width, offset)
            : 255;
        } else {
          entry.emptyFrameDiff = flatDiff(frame, width, presenterInner, lumaOfHex(layout.presenterFrame.emptyColor));
        }
        if (entry.tvBorderDiff > LAYOUT_FLAT_MAX_DIFF) problems.push("tv-frame-not-observed");
        if (entry.presenterBorderDiff > LAYOUT_FLAT_MAX_DIFF) problems.push("presenter-frame-not-observed");
        if (entry.backgroundDiff !== undefined && entry.backgroundDiff > LAYOUT_FLAT_MAX_DIFF) problems.push("background-not-observed");
        if (entry.tvContentDiff > LAYOUT_REGION_MAX_DIFF) problems.push("tv-content-differs-from-story-scene");
        if (entry.presenterDiff !== undefined && entry.presenterDiff > LAYOUT_REGION_MAX_DIFF) problems.push("presenter-video-not-in-frame");
        if (entry.emptyFrameDiff !== undefined && entry.emptyFrameDiff > LAYOUT_FLAT_MAX_DIFF) problems.push("empty-presenter-frame-not-empty");
      } else if (presenterPath) {
        const expected = await expectedGray(ffmpeg, presenterPath, fitGraph(render, presenterBackground), presenterIndex, { loop: true, width, height, fps });
        entry.presenterDiff = expected ? regionDiff(frame, width, { x: 0, y: 0, width, height }, expected, width) : 255;
        if (entry.presenterDiff > LAYOUT_REGION_MAX_DIFF) problems.push("plain-presenter-video-not-observed");
      } else {
        entry.tvBorderDiff = flatDiff(frame, width, tvBorder, lumaOfHex(layout.tv.borderColor));
        entry.presenterBorderDiff = flatDiff(frame, width, presenterBorder, lumaOfHex(layout.presenterFrame.borderColor));
        // 枠の線が2つとも宣言の色なら、plain の区間に TV の型が描かれている。
        if (entry.tvBorderDiff <= LAYOUT_FLAT_MAX_DIFF && entry.presenterBorderDiff <= LAYOUT_FLAT_MAX_DIFF) problems.push("plain-section-shows-tv-layout");
      }
      for (const key of Object.keys(entry)) if (key !== "frame") entry[key] = Math.round(entry[key] * 100) / 100;
      metrics.push(entry);
    }
    let tvMotion = null;
    if (tvEnds.length === 2) {
      const [first, last] = tvEnds;
      const expectedChange = regionDiff(first.expected, tvScale.width, { ...first.offset, width: first.region.width, height: first.region.height }, last.expected, tvScale.width, { ...last.offset, width: 0, height: 0 });
      const actualChange = regionDiff(first.frame, width, first.region, last.frame, width);
      tvMotion = { expectedChange: Math.round(expectedChange * 100) / 100, actualChange: Math.round(actualChange * 100) / 100 };
      if (expectedChange >= TV_MOTION_MIN_EXPECTED_CHANGE && actualChange < expectedChange * TV_MOTION_MIN_RATIO) problems.push("tv-content-not-moving");
    }
    rows.push({
      layout: section.layout,
      segmentIds: section.segmentIds,
      startFrame: reviewStartFrame + section.startFrame,
      frames: section.frames,
      tvScene: section.tvScene || null,
      ...(section.layout === "tv-left-presenter-right" ? { tvContent } : {}),
      ...(tvMotion ? { tvMotion } : {}),
      presenter: Boolean(presenterPath),
      pass: problems.length === 0,
      problems: [...new Set(problems)],
      metrics,
    });
  }
  const failed = rows.filter((row) => !row.pass);
  return {
    pass: rows.length > 0 && failed.length === 0,
    sectionCount: rows.length,
    problems: [...new Set(failed.flatMap((row) => row.problems))],
    sections: rows,
  };
}
