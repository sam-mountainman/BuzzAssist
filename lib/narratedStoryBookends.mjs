/**
 * ナレーション物語の「OP → 本編 → 感想」構造（bookend）と、その境目の実測監査。
 *
 * ここは公開 Core なので、チャンネル固有の値（OP の文言・色・秒数・曲・人物素材）は
 * 1つも書かない。全部を署名済み Channel Pack の narrated-story.json `bookends` から受け取り、
 * 足りなければ有料生成の前に blocker として止める。Core が持つのは
 *
 * - 構造（部品の順番、境目の時間割、字幕なし lead-in の置き方）
 * - 汎用の転換 3 種（hard-cut / fade-through-black / film-burn）。film-burn は外部素材なしで
 *   FFmpeg の xfade custom 式から手続き的に作る
 * - 境目を完成 MP4 から測る監査と、その閾値（合成 fixture で測った値から決めた。根拠は各定数の
 *   コメント）
 * - 「運営者の差し替え必須」印の検出（印が残った台本は有料生成へ進めず、最終監査も通さない）
 *
 * 監査の考え方: 生成側が「こう作った」と書いた値を根拠に pass にしない。境目の時刻は計画から
 * 取るが、判定は完成 MP4 の音声 PCM・映像フレーム・字幕トラックと、MP4 へ mux した voice stem を
 * 実際に decode して測る。
 */

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  cameraShotChains,
  groupNarratedCameraShots,
  normalizeNarratedCameraConfig,
  planNarratedCameraShots,
} from "./narratedStoryCamera.mjs";
import { normalizeNarratedReviewLayoutConfig } from "./narratedStoryReviewLayout.mjs";
import { subtitleOverlayGraph, videoConcatAssembled } from "./narratedStorySubtitles.mjs";

const execFile = promisify(execFileCallback);

export const NARRATED_BOOKEND_PLAN_VERSION = "buzzassist-narrated-story-bookend-plan-v1";
export const NARRATED_BOOKEND_AUDIT_VERSION = "buzzassist-narrated-story-bookend-audit-v1";
export const NARRATED_BOOKEND_TRANSITION_TYPES = Object.freeze(["hard-cut", "fade-through-black", "film-burn"]);
export const NARRATED_BOOKEND_BOUNDARY_IDS = Object.freeze(["openingToStory", "storyToReview"]);
/**
 * OP の種類。title-card（Pack の文言と書体）・video（Pack の動画、チャンネルで共通）・episode-video（回ごとに
 * 運営者が用意する動画。Job の運営者の動画の取り込みから来る）。番組の OP は常にこのうちの1つだけ。
 */
export const NARRATED_BOOKEND_OPENING_KINDS = Object.freeze(["title-card", "video", "episode-video"]);
/** 回ごとの OP 映像の、運営者の動画の取り込みの枠の名前。 */
export const EPISODE_OPENING_VIDEO_SLOT = "episode-opening";
/**
 * 台本の中で「この文は運営者が本人の実体験などで差し替えるまで使えない」と示す印。
 * Core 既定の印は常に有効で、Pack は `bookends.review.operatorReplacementMarker` で
 * 自分の台本の書式に合わせた印を足せる（置き換えではなく追加）。
 */
export const OPERATOR_REPLACEMENT_MARKER = "[[operator-replace]]";

const SAMPLE_RATE = 48_000;
const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

// ---- 監査の閾値 -------------------------------------------------------------
//
// 閾値は当て推量で置かず、test/fixtures/narratedBookendFixture.mjs の fixture を同じ測定に
// かけた実測値から決めた（2026-09-24、ffmpeg 7.1.1 / libx264 / AAC 192k / 2 pass 線形 loudnorm −14 LUFS）。
// fixture: 320x180・24fps、声 = 先頭 30ms 無音 + 0.6s の正弦波（0.2s で減衰）+ 120ms 無音、
// BGM gain 0.03、OP→本編 film-burn 0.5s、本編→感想 film-burn / fade-through-black 0.5s / hard-cut、
// lead-in 0.25s。
//   基準版（pass）・語り末尾を切った版（本編最後の声を減衰も無音も無いテイクに差し替え）・
//   転換を抜いた版（MP4 の転換区間を出る側の最終フレームで凍結）を測り、基準版から余白を取った
//   位置に置いた。値を変えるときは同じ fixture を測り直して、この根拠を書き換えること。

/**
 * 境目直前 60ms の音量 − 本編ナレーションの基準音量（本編 segment の RMS の中央値）。
 * 実測: 基準版 −31.2 dB（声が減衰して BGM だけが残る。1 pass loudnorm 時は 3 種の転換とも
 * −31.7〜−32.3）、語り末尾を切った版 +1.3 dB（1 pass 時 −0.8）。−12 dB は基準版から約 19 dB、
 * 切った版から約 13 dB 離れ、
 * 実 TTS の短い減衰（末尾 60ms がまだ −15〜−20 dB 程度残る）を誤って落とさない側に寄せた。
 */
export const BOUNDARY_TAIL_MAX_DELTA_DB = -12;
/**
 * 字幕なし lead-in 区間（転換の後〜次の語りの前）の 50ms 最大音量 − 基準音量。
 * 実測: 基準版 −31.2 dB（OP→本編。OP の音のフェード後）/ −31.2 dB（本編→感想）。語りが
 * 漏れた・重なった場合は基準音量そのもの（0 dB 前後）になる。−10 dB は「lead-in は BGM だけで、
 * 語りより 10 dB 以上小さい」ことを要求する値。
 */
export const BOUNDARY_LEAD_MAX_DELTA_DB = -10;
/**
 * 無音とみなす 10ms ブロックの RMS。デジタル無音（本実装の下限 −120）と、BGM が止まった穴を拾う。
 * 実測: 基準版の転換・lead-in 区間の最小ブロック −47.9 / −48.4 dBFS（余白 11 dB 以上）。
 */
export const BOUNDARY_SILENCE_FLOOR_DBFS = -60;
/**
 * 境目区間で許す連続無音の最長。実測: 基準版 0.00s（BGM が境目を通して鳴り続ける）。
 * 24fps の 2 フレーム未満（83ms）はクリック除けのフェード端の範囲として許し、それ以上の
 * 穴（間をデジタル無音で作る型）を落とす。
 */
export const BOUNDARY_MAX_SILENCE_RUN_SECONDS = 0.08;
/**
 * voice stem の転換・lead-in 区間（OP→本編は番組の頭から）は挿入した無音でなければならない。
 * 実測: 基準版 −120 dBFS（完全無音）。語りが早く始まる・前の語りが延びると発話の音量になる。
 */
export const BOUNDARY_STEM_SILENCE_DBFS = -60;
/**
 * 次の語りの発話開始を MP4 と voice stem の双方で測ったときの許容ずれ。
 * 実測: 基準版 |Δ| ≤ 5ms。AAC 1 フレーム（1024 サンプル = 21.3ms）未満の 21ms を上限にした。
 */
export const BOUNDARY_ONSET_SYNC_TOLERANCE_SECONDS = 0.021;
/**
 * 境目区間のサンプルピークの上限。loudnorm の TP 目標 −1.5 dBTP より 0.5 dB 緩い
 * （sample peak ≤ true peak なので、目標どおりなら必ず下回る）。実測: 基準版 −10.7 / −10.8 dBFS。
 */
export const BOUNDARY_CLIP_CEILING_DBFS = -1.0;
/**
 * 映像: 転換区間のうち「出る側の最終フレームとも、入る側の lead フレームとも違う」度合いの最大
 * （64x36 RGB の平均絶対差、0〜255）。実測: 基準版 film-burn 130.5〜132.0 / fade-through-black 98.1、
 * 転換を抜いた版 0.00〜0.03。12 は基準版の 1/8 以下で、再エンコードの誤差（≤ 1.5）の 8 倍。
 */
export const TRANSITION_EFFECT_MIN_DIFF = 12;
/** film-burn の白ゲート（フレーム平均輝度）。実測: 基準版 253、転換を抜いた版は素材の輝度 91.9 / 122.0。 */
export const TRANSITION_WHITE_GATE_MIN_LUMA = 225;
/** fade-through-black の黒点（フレーム平均輝度）。実測: 基準版 4.5、転換を抜いた版 122.1。 */
export const TRANSITION_BLACK_MAX_LUMA = 16;
/** hard-cut の切れ目で、前後フレームの平均絶対差がこれ以上なら「絵が実際に変わった」。実測: 基準版 135.8、凍結した版 0.03。 */
export const TRANSITION_CUT_MIN_DIFF = 12;
/**
 * lead-in が「入る側のきれいな静止フレーム」であること（lead の各フレームと lead 最終フレームの差の最大）。
 * 実測: 基準版 0.02〜0.45。hard-cut の切れ目を凍結した版は 135.8。
 */
export const TRANSITION_LEAD_STATIC_MAX_DIFF = 4;
/**
 * lead-in の最後と入る側の部の最初のフレームの差（lead が入る側の絵であること）。
 * 実測: 基準版 0.67〜1.42（人物素材は動画なので 1 フレームぶん動く）。
 */
export const TRANSITION_PRE_EFFECT_MAX_DIFF = 6;
/**
 * 転換が宣言区間より前に始まっていないこと（出る側の最後の 2 フレームの輝度差）。本編のカメラ移動は
 * 輝度をほとんど変えない。実測: 基準版 0.00〜0.56。
 */
export const TRANSITION_PRE_EFFECT_MAX_LUMA_STEP = 3;

// ---------------------------------------------------------------------------

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function runRuntime(spec, args, { cwd, timeout = 30 * 60_000, encoding = "utf8" } = {}) {
  if (!spec?.command) throw new Error("A resolved executable is required.");
  return execFile(spec.command, [...(spec.args || []), ...args], {
    cwd,
    timeout,
    windowsHide: true,
    encoding,
    maxBuffer: 512 * 1024 * 1024,
  });
}

/**
 * bookends が要る FFmpeg のフィルターのうち、この ffmpeg に無いもの。
 *
 * タイトルカードの文言は drawtext で描くが、drawtext は freetype 付きでビルドした ffmpeg にしか
 * 無い（2026-09-24、CI の macOS の Homebrew 版に無く、描画の段で落ちた）。描画は有料の画像と
 * 音声を作り終えた後なので、そこで落ちると払った分が無駄になる。有料生成の前に確かめる。
 */
export async function missingBookendFfmpegFilters(ffmpeg, config, { run = runRuntime } = {}) {
  const needed = [];
  if (config?.bookends?.enabled === true && config.bookends.opening?.kind === "title-card" && config.bookends.opening.text) {
    needed.push("drawtext");
  }
  // 焼き込み字幕（lib/narratedStorySubtitles.mjs）: 頁の PNG を drawtext と drawbox で描き、overlay で重ねる。
  if (config?.subtitles?.burnIn === true) needed.push("drawtext", "drawbox", "overlay");
  if (needed.length === 0) return [];
  let listing = "";
  try {
    const result = await run(ffmpeg, ["-hide_banner", "-filters"], { timeout: 30_000 });
    listing = `${result?.stdout || ""}\n${result?.stderr || ""}`;
  } catch {
    return needed;
  }
  return [...new Set(needed)].filter((name) => !new RegExp(`\\s${name}\\s`, "u").test(listing));
}

// ---- Channel Pack の bookends 設定 ------------------------------------------

/** Pack 内の相対 path だけを受ける（絶対 path・`..`・空要素・バックスラッシュは拒否）。 */
export function packRelativePath(value) {
  const text = nonEmpty(value);
  if (!text || isAbsolute(text) || text.includes("\\") || /^[a-z]:/iu.test(text)) return null;
  const parts = text.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts;
}

function colorOf(value) {
  const text = nonEmpty(value);
  return HEX_COLOR.test(text) ? text.toLowerCase() : "";
}

function rangeNumber(value, minimum, maximum) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function normalizeTransition(source, label, blockers) {
  if (!plainObject(source)) {
    blockers.push(`${label}`);
    return null;
  }
  const type = nonEmpty(source.type);
  if (!NARRATED_BOOKEND_TRANSITION_TYPES.includes(type)) blockers.push(`${label}.type`);
  const durationSeconds = type === "hard-cut"
    ? (source.durationSeconds === undefined || finiteNumber(source.durationSeconds) === 0 ? 0 : null)
    : rangeNumber(source.durationSeconds, 0.1, 3);
  if (durationSeconds === null) blockers.push(`${label}.durationSeconds`);
  // 字幕なし lead-in は保証「bookend-audio-breath」の一部。0 秒は認めない。
  const leadInSeconds = rangeNumber(source.leadInSeconds, 0.1, 5);
  if (leadInSeconds === null) blockers.push(`${label}.leadInSeconds`);
  let outgoingFadeSeconds = durationSeconds ?? 0;
  if (source.outgoingFadeSeconds !== undefined) {
    const fade = rangeNumber(source.outgoingFadeSeconds, 0, 3);
    if (fade === null || (durationSeconds !== null && durationSeconds > 0 && fade > durationSeconds)) {
      blockers.push(`${label}.outgoingFadeSeconds`);
    } else outgoingFadeSeconds = fade;
  }
  let leakColors = [];
  if (type === "film-burn") {
    leakColors = Array.isArray(source.leakColors) ? source.leakColors.map(colorOf) : [];
    if (leakColors.length !== 2 || leakColors.some((color) => !color)) blockers.push(`${label}.leakColors`);
  }
  return {
    type,
    durationSeconds: durationSeconds ?? 0,
    leadInSeconds: leadInSeconds ?? 0,
    outgoingFadeSeconds,
    ...(type === "film-burn" ? { leakColors } : {}),
  };
}

function mediaRef(value, label, blockers, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) blockers.push(`${label}-required`);
    return null;
  }
  const parts = packRelativePath(value);
  if (!parts) {
    blockers.push(`${label}-invalid-pack-path`);
    return null;
  }
  return parts.join("/");
}

/**
 * narrated-story.json の `bookends` を正規化する。純粋関数（file は見ない）。
 * 返り値の blockers は `bookends.<field>` 形式で、呼び出し側が有料生成前の停止理由にする。
 */
export function normalizeNarratedBookendsConfig(source, { render = { width: 1280, height: 720 } } = {}) {
  const blockers = [];
  if (source === undefined || source === null) return { config: { enabled: false }, blockers };
  if (!plainObject(source)) return { config: { enabled: false }, blockers: ["bookends"] };
  if (source.enabled !== true) return { config: { enabled: false }, blockers };
  const config = { enabled: true, opening: null, review: null, transitions: {} };
  if (source.opening !== undefined && source.opening !== null) {
    const opening = source.opening;
    if (!plainObject(opening)) blockers.push("bookends.opening");
    else {
      const kind = nonEmpty(opening.kind);
      if (!NARRATED_BOOKEND_OPENING_KINDS.includes(kind)) blockers.push("bookends.opening.kind");
      const normalized = { kind };
      if (kind === "title-card") {
        normalized.durationSeconds = rangeNumber(opening.durationSeconds, 0.5, 60);
        if (normalized.durationSeconds === null) blockers.push("bookends.opening.durationSeconds");
        normalized.backgroundImage = mediaRef(opening.backgroundImage, "bookends.opening.backgroundImage", blockers);
        normalized.backgroundColor = colorOf(opening.backgroundColor);
        if (!normalized.backgroundImage && !normalized.backgroundColor) blockers.push("bookends.opening.backgroundColor");
        const text = typeof opening.text === "string" ? opening.text.replaceAll("\r", "").trim() : "";
        if (opening.text !== undefined && (!text || text.length > 200)) blockers.push("bookends.opening.text");
        normalized.text = text;
        if (text) {
          normalized.fontFile = mediaRef(opening.fontFile, "bookends.opening.fontFile", blockers, { required: true });
          normalized.textColor = colorOf(opening.textColor);
          if (!normalized.textColor) blockers.push("bookends.opening.textColor");
          const fontSize = opening.fontSize === undefined
            ? Math.max(12, Math.round(Number(render.height || 720) / 10))
            : rangeNumber(opening.fontSize, 8, 400);
          if (fontSize === null) blockers.push("bookends.opening.fontSize");
          normalized.fontSize = Math.round(fontSize || 0);
        }
      } else if (kind === "video") {
        normalized.video = mediaRef(opening.video, "bookends.opening.video", blockers, { required: true });
        normalized.backgroundColor = colorOf(opening.backgroundColor) || "";
      } else if (kind === "episode-video") {
        // 回ごとの OP 映像（運営者が外で作った短い動画）。動画そのものは Pack ではなく、Job の運営者の動画の
        // 取り込みの記録（lib/operatorVideoImport.mjs、枠 episode-opening）から来る。Pack は尺の範囲と音の扱いを決める。
        normalized.minSeconds = rangeNumber(opening.minSeconds, 0.5, 60);
        if (normalized.minSeconds === null) blockers.push("bookends.opening.minSeconds");
        normalized.maxSeconds = rangeNumber(opening.maxSeconds, normalized.minSeconds ?? 0.5, 120);
        if (normalized.maxSeconds === null) blockers.push("bookends.opening.maxSeconds");
        if (opening.useEmbeddedAudio !== undefined && typeof opening.useEmbeddedAudio !== "boolean") blockers.push("bookends.opening.useEmbeddedAudio");
        normalized.useEmbeddedAudio = opening.useEmbeddedAudio === true;
        normalized.backgroundColor = colorOf(opening.backgroundColor) || "";
      }
      normalized.audio = mediaRef(opening.audio, "bookends.opening.audio", blockers);
      // 映像の音と Pack の OP の音を重ねない（どちらか一方）。
      if (normalized.audio && normalized.useEmbeddedAudio) blockers.push("bookends.opening.audio-conflicts-with-embedded-audio");
      config.opening = normalized;
    }
  }
  if (source.review !== undefined && source.review !== null) {
    const review = source.review;
    if (!plainObject(review)) blockers.push("bookends.review");
    else {
      const scriptMarker = nonEmpty(review.scriptMarker);
      if (!scriptMarker || scriptMarker.length > 80 || scriptMarker.includes("\n")) blockers.push("bookends.review.scriptMarker");
      const presenterSource = plainObject(review.presenter) ? review.presenter : {};
      const presenterRequired = presenterSource.required === true;
      const presenterVideo = mediaRef(presenterSource.video, "bookends.review.presenter.video", blockers);
      // 回ごとの人物の映像（運営者が後から渡す。Job の運営者の動画の取り込みの枠 review-presenter）。
      if (presenterSource.episodeVideo !== undefined && typeof presenterSource.episodeVideo !== "boolean") blockers.push("bookends.review.presenter.episodeVideo");
      const presenterEpisodeVideo = presenterSource.episodeVideo === true;
      if (presenterEpisodeVideo && presenterVideo) blockers.push("bookends.review.presenter.video-and-episodeVideo");
      // 人物素材は運営者が供給する。必須なのに無いときは、代用の絵で埋めずに止める
      // （回ごとの映像なら、Job の取り込みの枠が必須になる）。
      if (presenterRequired && !presenterVideo && !presenterEpisodeVideo) blockers.push("bookends.review.presenter-media-required");
      const presenterBackground = colorOf(presenterSource.backgroundColor);
      if ((presenterVideo || presenterEpisodeVideo) && !presenterBackground) blockers.push("bookends.review.presenter.backgroundColor");
      const layout = normalizeNarratedReviewLayoutConfig(review.layout, { render });
      blockers.push(...layout.blockers);
      const music = mediaRef(review.music, "bookends.review.music", blockers);
      let musicGain = null;
      if (review.musicGain !== undefined) {
        musicGain = rangeNumber(review.musicGain, 0.005, 1);
        if (musicGain === null) blockers.push("bookends.review.musicGain");
      }
      const extraMarker = review.operatorReplacementMarker === undefined ? "" : nonEmpty(review.operatorReplacementMarker);
      if (review.operatorReplacementMarker !== undefined && (!extraMarker || extraMarker.length > 40)) {
        blockers.push("bookends.review.operatorReplacementMarker");
      }
      config.review = {
        scriptMarker,
        presenter: { required: presenterRequired, video: presenterVideo, episodeVideo: presenterEpisodeVideo, backgroundColor: presenterBackground },
        layout: layout.config,
        music,
        musicGain,
        operatorReplacementMarker: extraMarker,
      };
    }
  }
  if (!config.opening && !config.review) blockers.push("bookends.opening-or-review-required");
  const transitions = plainObject(source.transitions) ? source.transitions : {};
  if (config.opening) {
    config.transitions.openingToStory = normalizeTransition(transitions.openingToStory, "bookends.transitions.openingToStory", blockers);
  }
  if (config.review) {
    config.transitions.storyToReview = normalizeTransition(transitions.storyToReview, "bookends.transitions.storyToReview", blockers);
  }
  return { config, blockers: [...new Set(blockers)] };
}

async function regularFile(path) {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() && info.size > 0;
  } catch {
    return false;
  }
}

/**
 * bookends が参照する Pack 内 file を検証済み payload から解決する。無い file は blocker。
 * 返す absolute path は payload の中だけを指す（payloadIdentity が SHA で拘束済み）。
 */
export async function resolveNarratedBookendMedia(config, channelPackDir) {
  const blockers = [];
  const root = resolve(String(channelPackDir || ""));
  const media = {};
  const refs = [];
  if (config?.enabled) {
    const opening = config.opening || {};
    refs.push(["opening.backgroundImage", opening.backgroundImage]);
    refs.push(["opening.fontFile", opening.fontFile]);
    refs.push(["opening.video", opening.video]);
    refs.push(["opening.audio", opening.audio]);
    refs.push(["review.presenter.video", config.review?.presenter?.video]);
    refs.push(["review.music", config.review?.music]);
  }
  for (const [label, ref] of refs) {
    if (!ref) continue;
    const absolute = join(root, ...ref.split("/"));
    if (!await regularFile(absolute)) {
      blockers.push(`bookends.${label}-missing`);
      continue;
    }
    media[label] = absolute;
  }
  return { media, blockers };
}

// ---- 台本の区分と「差し替え必須」印 ------------------------------------------

/**
 * 台本を本編と感想パートに分ける。感想パートは Pack が宣言した区切り行
 * （前後空白を除いて完全一致する 1 行）の後ろ。区切り行そのものは読まない。
 */
export function partitionNarratedStoryScript(raw, bookends = { enabled: false }) {
  const text = String(raw ?? "").replaceAll("\r", "");
  const marker = bookends?.enabled ? nonEmpty(bookends.review?.scriptMarker) : "";
  if (!marker) return { bodyText: text, reviewText: "", blockers: [] };
  const lines = text.split("\n");
  const indexes = lines.map((line, index) => (line.trim() === marker ? index : -1)).filter((index) => index >= 0);
  if (indexes.length !== 1) {
    return {
      bodyText: text,
      reviewText: "",
      blockers: [indexes.length === 0 ? "script-review-marker-missing" : "script-review-marker-duplicated"],
    };
  }
  const bodyText = lines.slice(0, indexes[0]).join("\n");
  const reviewText = lines.slice(indexes[0] + 1).join("\n");
  const blockers = [];
  if (!bodyText.trim()) blockers.push("script-story-section-empty");
  if (!reviewText.trim()) blockers.push("script-review-section-empty");
  return { bodyText, reviewText, blockers };
}

/** 差し替え必須の印が残っている segment の id を返す。Core 既定の印と Pack の追加印の両方を見る。 */
export function operatorReplacementSegments(segments = [], { extraMarker = "" } = {}) {
  const markers = [OPERATOR_REPLACEMENT_MARKER, nonEmpty(extraMarker)].filter(Boolean);
  return segments
    .filter((segment) => markers.some((marker) => String(segment?.text || "").includes(marker)))
    .map((segment) => segment.id);
}

// ---- 時間割 ---------------------------------------------------------------

function sampleAt(frame, fps) {
  return Math.round((frame * SAMPLE_RATE) / fps);
}

function framesFromSeconds(seconds, fps) {
  return Math.max(0, Math.round(Number(seconds) * fps));
}

/**
 * 声の実尺から、segment ごとのフレーム数を累積丸めで決める。最後は切り上げなので、
 * 映像がその部の声より短くなることはない（声の末尾が次の転換へ食い込まない）。
 */
export function segmentFramePlan(durations, fps) {
  let cumulative = 0;
  let previousEnd = 0;
  const total = durations.reduce((sum, value) => sum + value, 0);
  const totalFrames = Math.max(1, Math.ceil(total * fps - 1e-6));
  return durations.map((duration, index) => {
    cumulative += duration;
    const end = index === durations.length - 1 ? totalFrames : Math.min(totalFrames, Math.round(cumulative * fps));
    const frames = Math.max(1, end - previousEnd);
    const startFrame = previousEnd;
    previousEnd = startFrame + frames;
    return { startFrame, frames };
  });
}

/**
 * 番組全体の時間割。部（opening / story / review）と境目（effect → 字幕なし lead-in →
 * 次の語り）の時刻を、フレームとサンプルの両方で決める。
 *   opening | effect1 | lead1 | story | effect2 | lead2 | review
 * 次の部の語りと最初の字幕は lead の終わりで同時に始まる。
 */
export function planNarratedBookendProgram({ fps, openingFrames = 0, story = [], review = [], reviewPresenter = false, reviewVisual = "", reviewSegmentCamera = null, transitions = {} }) {
  if (!Number.isInteger(fps) || fps <= 0) throw new Error("Bookend plan requires an integer fps.");
  if (story.length === 0) throw new Error("Bookend plan requires at least one story segment.");
  const parts = [];
  const boundaries = [];
  const segments = [];
  let frame = 0;
  const addBoundary = (id, transition, outgoingPart, incomingPart) => {
    const effectFrames = transition.type === "hard-cut" ? 0 : Math.max(1, framesFromSeconds(transition.durationSeconds, fps));
    const leadFrames = Math.max(1, framesFromSeconds(transition.leadInSeconds, fps));
    const boundary = {
      id,
      type: transition.type,
      outgoingPart,
      incomingPart,
      effectStartFrame: frame,
      effectFrames,
      leadFrames,
      effectEndFrame: frame + effectFrames,
      incomingStartFrame: frame + effectFrames + leadFrames,
      outgoingFadeSeconds: transition.type === "hard-cut"
        ? 0.01
        : Math.max(0.01, Math.min(Number(transition.outgoingFadeSeconds ?? transition.durationSeconds), effectFrames / fps)),
      ...(transition.leakColors ? { leakColors: [...transition.leakColors] } : {}),
    };
    boundary.effectStartSeconds = boundary.effectStartFrame / fps;
    boundary.effectEndSeconds = boundary.effectEndFrame / fps;
    boundary.incomingStartSeconds = boundary.incomingStartFrame / fps;
    boundaries.push(boundary);
    frame = boundary.incomingStartFrame;
  };
  const addSegmentsPart = (id, list, { presenter = false, visual = "", cameraOf = null } = {}) => {
    const startFrame = frame;
    const startSeconds = startFrame / fps;
    const framePlan = segmentFramePlan(list.map((segment) => segment.durationSeconds), fps);
    let cursor = 0;
    list.forEach((segment, index) => {
      segments.push({
        ...segment,
        part: id,
        camera: cameraOf?.get(segment.id) || (presenter ? "presenter-video" : "camera-shot"),
        partIndex: index,
        frames: framePlan[index].frames,
        partStartFrame: framePlan[index].startFrame,
        startSeconds: startSeconds + cursor,
        endSeconds: startSeconds + cursor + segment.durationSeconds,
      });
      cursor += segment.durationSeconds;
    });
    const frames = framePlan.reduce((sum, entry) => sum + entry.frames, 0);
    parts.push({ id, startFrame, frames, voiceSeconds: cursor, visual: visual || (presenter ? "presenter-video" : "segment-images") });
    frame += frames;
  };
  if (openingFrames > 0) {
    parts.push({ id: "opening", startFrame: 0, frames: openingFrames, voiceSeconds: 0, visual: "opening" });
    frame = openingFrames;
    addBoundary("openingToStory", transitions.openingToStory, "opening", "story");
  }
  addSegmentsPart("story", story);
  if (review.length > 0) {
    addBoundary("storyToReview", transitions.storyToReview, "story", "review");
    // 感想パートの配置（lib/narratedStoryReviewLayout.mjs）があれば、部の見た目は review-layout、文ごとの見た目は
    // reviewSegmentCamera（presenter-video / review-tv / camera-shot）。
    addSegmentsPart("review", review, { presenter: reviewPresenter, visual: reviewVisual, cameraOf: reviewSegmentCamera });
  }
  for (const part of parts) {
    part.startSeconds = part.startFrame / fps;
    part.endFrame = part.startFrame + part.frames;
    part.endSeconds = part.endFrame / fps;
    part.startSample = sampleAt(part.startFrame, fps);
    part.endSample = sampleAt(part.endFrame, fps);
  }
  for (const boundary of boundaries) {
    boundary.effectStartSample = sampleAt(boundary.effectStartFrame, fps);
    boundary.effectEndSample = sampleAt(boundary.effectEndFrame, fps);
    boundary.incomingStartSample = sampleAt(boundary.incomingStartFrame, fps);
  }
  return {
    version: NARRATED_BOOKEND_PLAN_VERSION,
    fps,
    sampleRate: SAMPLE_RATE,
    totalFrames: frame,
    totalSeconds: frame / fps,
    totalSamples: sampleAt(frame, fps),
    parts,
    boundaries,
    segments,
  };
}

/**
 * generation manifest に残した bookend の記録（フレーム単位）と segment の時刻から、監査に要る
 * 時間割を組み直す。記録だけから境目の実測監査をやり直せるようにするため（再監査・否定テスト）。
 */
export function rehydrateBookendPlan({ bookends, segments = [] }) {
  const fps = Number(bookends?.fps);
  if (!Number.isInteger(fps) || fps <= 0) throw new Error("bookend manifest entry has no fps.");
  const parts = (bookends.parts || []).map((part) => ({
    ...part,
    startSeconds: part.startFrame / fps,
    endFrame: part.startFrame + part.frames,
    endSeconds: (part.startFrame + part.frames) / fps,
    startSample: sampleAt(part.startFrame, fps),
    endSample: sampleAt(part.startFrame + part.frames, fps),
  }));
  const boundaries = (bookends.boundaries || []).map((boundary) => {
    const effectEndFrame = boundary.effectStartFrame + boundary.effectFrames;
    return {
      ...boundary,
      effectEndFrame,
      effectStartSeconds: boundary.effectStartFrame / fps,
      effectEndSeconds: effectEndFrame / fps,
      incomingStartSeconds: boundary.incomingStartFrame / fps,
      effectStartSample: sampleAt(boundary.effectStartFrame, fps),
      effectEndSample: sampleAt(effectEndFrame, fps),
      incomingStartSample: sampleAt(boundary.incomingStartFrame, fps),
    };
  });
  return {
    version: bookends.version,
    fps,
    sampleRate: SAMPLE_RATE,
    totalFrames: bookends.totalFrames,
    totalSeconds: bookends.totalFrames / fps,
    totalSamples: sampleAt(bookends.totalFrames, fps),
    parts,
    boundaries,
    segments: segments.filter((segment) => segment.part).map((segment) => ({ ...segment })),
  };
}

// ---- film-burn（手続き的） -------------------------------------------------

function rgbOf(hex) {
  const value = Number.parseInt(String(hex).slice(1), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

/**
 * film-burn の xfade custom 式（gbrp 平面。PLANE 0=G, 1=B, 2=R）。
 * 形は「出る側に左から差し込む光の漏れ → 短い白ゲート → 入る側に右寄りの残り火が減衰」。
 * 形（相対位置）は汎用の手法として Core が持ち、色は Pack の leakColors から受け取る。
 * t = 1 − P（0→1）。ゲートは t ∈ [0.40, 0.47] で全白、前後 0.06 で立ち上がり・減衰。
 */
export function filmBurnExpression(leakColors) {
  const [left, right] = leakColors.map(rgbOf);
  const channel = (component) => `${left[component]}*(1-ld(2))+${right[component]}*ld(2)`;
  return [
    "st(0,1-P)",
    "st(1,if(lt(ld(0),0.34),0,if(lt(ld(0),0.40),(ld(0)-0.34)/0.06,if(lt(ld(0),0.47),1,if(lt(ld(0),0.53),(0.53-ld(0))/0.06,0)))))",
    "st(2,X/W)",
    // 出る側の漏れ: 左から広がる前線、強さは t と共に 0.85 まで。入る側: 右寄りの残り火が t=1 で 0。
    "st(3,if(lt(ld(0),0.47),0.85*clip(ld(0)/0.36,0,1)*clip((1.5*ld(0)/0.40-ld(2))*3,0,1),"
      + "0.55*clip((ld(0)-0.47)/0.08,0,1)*clip((1-ld(0))/0.4,0,1)*clip(0.25+0.75*ld(2),0,1)))",
    `st(4,if(eq(PLANE,0),${channel("g")},if(eq(PLANE,1),${channel("b")},${channel("r")})))`,
    "st(5,if(lt(ld(0),0.47),A,B))",
    "st(6,ld(4)*ld(3))",
    "st(7,ld(5)+ld(6)-ld(5)*ld(6)/255)",
    "ld(7)*(1-ld(1))+255*ld(1)",
  ].join(";");
}

function xfadeFor(boundary) {
  if (boundary.type === "fade-through-black") return "xfade=transition=fadeblack";
  if (boundary.type === "film-burn") return `xfade=transition=custom:expr='${filmBurnExpression(boundary.leakColors)}'`;
  return "";
}

// ---- 描画 -----------------------------------------------------------------

function ffColor(hex, fallback = "black") {
  return hex ? `0x${hex.slice(1)}` : fallback;
}

function fitGraph(config, padColor) {
  const { width, height, fps } = config.render;
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,`
    + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:${ffColor(padColor)},setsar=1,fps=${fps}`;
}

// trim + setpts の後は出力の frame rate 情報が落ち、mp4 muxer が最後のフレームの長さを誤って
// 1 フレーム欠ける（2026-09-24 実測: trim=end_frame=19 → 読み戻し 18 フレーム）。各 graph の最後に
// fps を置いて rate を戻す。
const PART_ENCODE = ["-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p"];

/** OP 部（title-card か Pack の動画）を映像だけで描く。 */
export async function renderOpeningPart({ ffmpeg, ffprobe, opening, media, config, workDir, outputPath }) {
  await mkdir(workDir, { recursive: true });
  const { fps } = config.render;
  if (opening.kind === "video" || opening.kind === "episode-video") {
    const probe = JSON.parse((await runRuntime(ffprobe, [
      "-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", media["opening.video"],
    ])).stdout);
    const duration = Math.max(0, Number(probe?.format?.duration) || 0);
    const frames = Math.floor(duration * fps + 1e-6);
    if (frames < 1) throw new Error("bookends.opening.video has no measurable duration.");
    const filterGraph = `[0:v]${fitGraph(config, opening.backgroundColor)},trim=end_frame=${frames},setpts=N/(${fps}*TB),fps=${fps},format=yuv420p[video]`;
    await runRuntime(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y", "-i", media["opening.video"],
      "-filter_complex", filterGraph, "-map", "[video]", "-frames:v", String(frames), ...PART_ENCODE, outputPath,
    ]);
    const hasAudio = (probe.streams || []).some((stream) => stream.codec_type === "audio");
    // 回ごとの OP 映像の音は、Pack が useEmbeddedAudio を宣言したときだけ使う。
    const useAudio = hasAudio && (opening.kind === "video" || opening.useEmbeddedAudio === true);
    return { frames, graph: { filterGraph, inputCount: 1, outputMap: "[video]" }, embeddedAudio: useAudio ? media["opening.video"] : "" };
  }
  const frames = Math.max(1, Math.round(opening.durationSeconds * fps));
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  let source;
  if (media["opening.backgroundImage"]) {
    args.push("-loop", "1", "-framerate", String(fps), "-i", media["opening.backgroundImage"]);
    source = `[0:v]${fitGraph(config, opening.backgroundColor)}`;
  } else {
    args.push("-f", "lavfi", "-i", `color=c=${ffColor(opening.backgroundColor)}:s=${config.render.width}x${config.render.height}:r=${fps}`);
    source = "[0:v]setsar=1";
  }
  let text = "";
  if (opening.text) {
    // 文言と書体は作業 dir へ置き、filter には相対名だけを書く（Windows の `C:` と
    // filter 引数の `:` がぶつからない。文言の escape も要らない）。
    const fontName = `opening-font${extname(media["opening.fontFile"]).toLowerCase() || ".ttf"}`;
    await copyFile(media["opening.fontFile"], join(workDir, fontName));
    await writeFile(join(workDir, "opening-card.txt"), opening.text, "utf8");
    // expansion=none: Pack の文言の % を書式指定として解釈させない。
    text = `,drawtext=fontfile=${fontName}:textfile=opening-card.txt:expansion=none:fontcolor=${ffColor(opening.textColor)}:`
      + `fontsize=${opening.fontSize}:x=(w-text_w)/2:y=(h-text_h)/2:line_spacing=${Math.round(opening.fontSize / 3)}`;
  }
  const filterGraph = `${source}${text},trim=end_frame=${frames},setpts=N/(${fps}*TB),fps=${fps},format=yuv420p[video]`;
  await runRuntime(ffmpeg, [...args, "-filter_complex", filterGraph, "-map", "[video]", "-frames:v", String(frames), ...PART_ENCODE, outputPath], { cwd: workDir });
  return { frames, graph: { filterGraph, inputCount: 1, outputMap: "[video]" }, embeddedAudio: "" };
}

/**
 * 部の中の文（partStartFrame・frames・imageKey を持つ）を、カメラのショット（同じ画が続く範囲）に
 * まとめる。描く側と監査・graph の検査が同じまとめ方を使う。
 */
export function partCameraShots(segments, config) {
  const camera = config.camera || normalizeNarratedCameraConfig(undefined).config;
  let cursor = 0;
  const timed = segments.map((segment) => {
    const startFrame = Number.isInteger(segment.partStartFrame) ? segment.partStartFrame : cursor;
    cursor = startFrame + segment.frames;
    return { ...segment, startFrame };
  });
  return planNarratedCameraShots({ segments: timed, camera, fps: config.render.fps }).shots;
}

/**
 * segment 画像の部（本編・画像の感想）を映像だけで描く。同じ画が続く文は1つのショットとして1つの動きで
 * 通し（lib/narratedStoryCamera.mjs）、ショットの間は concat（転換を足さない）。
 */
export async function renderSegmentImagesPart({ ffmpeg, segments, config, outputPath }) {
  const shots = partCameraShots(segments, config);
  const { inputs, chains, labels } = cameraShotChains({ shots, render: config.render });
  const filterGraph = `${chains.join(";")};${labels.join("")}concat=n=${shots.length}:v=1:a=0[video]`;
  const frames = shots.reduce((sum, shot) => sum + shot.frames, 0);
  await runRuntime(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", filterGraph, "-map", "[video]", "-frames:v", String(frames), ...PART_ENCODE, outputPath]);
  return { frames, shots, graph: { filterGraph, imageInputCount: shots.length, videoMap: "[video]" } };
}

/** 人物素材（Pack が供給）の感想部。素材の音は使わない（語りは TTS の voice stem）。 */
export async function renderPresenterPart({ ffmpeg, presenterPath, frames, backgroundColor, config, outputPath }) {
  const { fps } = config.render;
  const filterGraph = `[0:v]${fitGraph(config, backgroundColor)},trim=end_frame=${frames},setpts=N/(${fps}*TB),fps=${fps},format=yuv420p[video]`;
  await runRuntime(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-stream_loop", "-1", "-i", presenterPath,
    "-filter_complex", filterGraph, "-map", "[video]", "-frames:v", String(frames), ...PART_ENCODE, outputPath,
  ]);
  return { frames, graph: { filterGraph, inputCount: 1, outputMap: "[video]" } };
}

/** 部の動画から 1 フレームを PNG へ取り出す（転換の両端の静止フレーム）。 */
export async function extractPartFrame({ ffmpeg, videoPath, frameIndex, outputPath }) {
  await runRuntime(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-i", videoPath,
    "-vf", `select=eq(n\\,${frameIndex})`, "-fps_mode", "passthrough", "-frames:v", "1", outputPath,
  ]);
}

/**
 * 境目の映像クリップ: [出る側の最終フレーム × effect] → 転換 → [入る側の最初のフレーム × lead]。
 * lead は字幕も語りも無い「入る側のきれいな静止フレーム」。hard-cut は effect 0 で lead だけ。
 */
export async function renderTransitionClip({ ffmpeg, boundary, stillOutgoing, stillIncoming, config, outputPath }) {
  const { fps } = config.render;
  const total = boundary.effectFrames + boundary.leadFrames;
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  let filterGraph;
  if (boundary.type === "hard-cut") {
    args.push("-loop", "1", "-framerate", String(fps), "-i", stillIncoming);
    filterGraph = `[0:v]setsar=1,trim=end_frame=${total},setpts=N/(${fps}*TB),fps=${fps},format=yuv420p[video]`;
  } else {
    args.push("-loop", "1", "-framerate", String(fps), "-i", stillOutgoing);
    args.push("-loop", "1", "-framerate", String(fps), "-i", stillIncoming);
    const duration = (boundary.effectFrames / fps).toFixed(6);
    // xfade は一定フレームレートの入力を要る（trim 後の setpts だけでは rate が 1/0 になる）。
    filterGraph = `[0:v]setsar=1,trim=end_frame=${boundary.effectFrames},setpts=N/(${fps}*TB),fps=${fps},format=gbrp[a];`
      + `[1:v]setsar=1,trim=end_frame=${total},setpts=N/(${fps}*TB),fps=${fps},format=gbrp[b];`
      + `[a][b]${xfadeFor(boundary)}:duration=${duration}:offset=0,format=yuv420p[video]`;
  }
  // film-burn の式は st()/ld() の変数を使う。xfade は slice を並列に評価し、式の変数は共有なので、
  // 並列のままだと画素ごとに値が混ざって砂嵐になる（2026-09-24 実測）。filter graph を 1 thread にする。
  await runRuntime(ffmpeg, [...args, "-filter_complex_threads", "1", "-filter_complex", filterGraph, "-map", "[video]", "-frames:v", String(total), ...PART_ENCODE, outputPath]);
  return { filterGraph, inputCount: boundary.type === "hard-cut" ? 1 : 2, outputMap: "[video]", transition: boundary.type };
}

/**
 * 部と境目クリップを順に並べ、master 音声と字幕を mux して番組 MP4 を作る。焼き込み字幕の層
 * （lib/narratedStorySubtitles.mjs の concat の一覧）があれば、番組の時間で1回だけ重ねる
 * （転換と字幕なし lead-in の間には頁が無いので、そこには何も重ならない）。
 */
export async function renderBookendProgram({ ffmpeg, clipPaths, masterAudioPath, srtPath, plan, outputPath, subtitleLayer = null }) {
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const path of clipPaths) args.push("-i", path);
  const audioIndex = clipPaths.length;
  const subtitleIndex = clipPaths.length + 1;
  args.push("-i", masterAudioPath, "-i", srtPath);
  if (subtitleLayer) args.push("-f", "concat", "-i", subtitleLayer.listPath);
  const assembled = `${clipPaths.map((_, index) => `[${index}:v]`).join("")}concat=n=${clipPaths.length}:v=1:a=0[${subtitleLayer ? "program" : "video"}]`;
  const filterGraph = subtitleLayer
    ? `${assembled};${subtitleOverlayGraph({ inputIndex: subtitleIndex + 1, input: "program", output: "video" })}`
    : assembled;
  args.push(
    "-filter_complex", filterGraph,
    "-map", "[video]", "-map", `${audioIndex}:a:0`, "-map", `${subtitleIndex}:s:0`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-c:s", "mov_text", "-metadata:s:s:0", "language=jpn",
    "-r", String(plan.fps), "-frames:v", String(plan.totalFrames), "-t", plan.totalSeconds.toFixed(6), "-movflags", "+faststart", outputPath,
  );
  await runRuntime(ffmpeg, args);
  return {
    filterGraph,
    imageInputCount: clipPaths.length,
    videoMap: "[video]",
    audioMap: `${audioIndex}:a:0`,
    subtitleMap: `${subtitleIndex}:s:0`,
  };
}

/**
 * 番組全体の voice stem（mono 48kHz）。OP・転換・lead-in の間は挿入した無音で、
 * 各部の語りは部の先頭サンプルから始まり、部の映像尺まで無音で埋める。
 */
export async function makeBookendVoiceStem({ ffmpeg, plan, voicePaths, outputPath }) {
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  const filters = [];
  const blocks = [];
  let input = 0;
  let cursor = 0;
  let gap = 0;
  const addGap = (samples) => {
    if (samples <= 0) return;
    filters.push(`anullsrc=r=${SAMPLE_RATE}:cl=mono,atrim=end_sample=${samples}[g${gap}]`);
    blocks.push(`[g${gap}]`);
    gap += 1;
  };
  for (const part of plan.parts) {
    if (part.startSample > cursor) addGap(part.startSample - cursor);
    const partSegments = plan.segments.filter((segment) => segment.part === part.id);
    const partSamples = part.endSample - part.startSample;
    if (partSegments.length === 0) {
      addGap(partSamples);
    } else {
      const labels = partSegments.map((segment) => {
        args.push("-i", voicePaths[segment.id]);
        const label = `a${input}`;
        filters.push(`[${input}:a]aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=mono[${label}]`);
        input += 1;
        return `[${label}]`;
      });
      filters.push(`${labels.join("")}concat=n=${labels.length}:v=0:a=1,apad=whole_len=${partSamples},atrim=end_sample=${partSamples}[${part.id}]`);
      blocks.push(`[${part.id}]`);
    }
    cursor = part.endSample;
  }
  filters.push(`${blocks.join("")}concat=n=${blocks.length}:v=0:a=1[voice]`);
  const filterGraph = filters.join(";");
  await runRuntime(ffmpeg, [...args, "-filter_complex", filterGraph, "-map", "[voice]", "-c:a", "pcm_s16le", outputPath]);
  return { filterGraph, inputCount: input, outputMap: "[voice]" };
}

/**
 * 語り以外の番組音（BGM と OP の音）を 1 本の stem にする（stereo 48kHz）。
 * - 本編の BGM は OP→本編の転換の頭からフェードインし、lead-in を通して鳴り続ける
 *   （間をデジタル無音で作らない）。
 * - 感想用の曲が Pack にあれば、本編→感想の転換の全長で等電力クロスフェードする。
 *   無ければ本編の BGM が最後まで続く。
 * - OP の音は OP の終わりから転換の終わりまでで 0 へ下げる（次の語りと重ねない）。
 * 全体の acrossfade は使わない（afade と amix だけ）。
 */
export async function makeBookendBedStem({ ffmpeg, plan, storyMusicPath, storyGain, reviewMusicPath = "", reviewGain = storyGain, openingAudioPath = "", outputPath }) {
  const total = plan.totalSamples;
  const opening = plan.boundaries.find((boundary) => boundary.id === "openingToStory") || null;
  const toReview = plan.boundaries.find((boundary) => boundary.id === "storyToReview") || null;
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-stream_loop", "-1", "-i", storyMusicPath];
  const stereo = `aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo`;
  const filters = [];
  const beds = [];
  const bedStart = opening ? opening.effectStartSample : 0;
  const crossfade = Boolean(toReview && reviewMusicPath);
  const bedEnd = crossfade ? toReview.effectEndSample : total;
  const storyLength = bedEnd - bedStart;
  const storyChain = [`[0:a]${stereo}`, `atrim=end_sample=${storyLength}`, `apad=whole_len=${storyLength}`, `volume=${storyGain.toFixed(5)}`];
  if (opening) {
    // 立ち上がりの速い曲線（ipar: 1−(1−t)²）で入れる。OP の音が OP の終わりで切れる素材（回ごとの OP 映像の
    // 音など）でも、転換の頭に無音の穴を作らない（直線だと小さな BGM が −60dBFS を越えるまで 0.1 秒以上かかった）。
    const fadeIn = Math.max(0.01, (opening.effectEndSample - opening.effectStartSample) / SAMPLE_RATE);
    storyChain.push(`afade=t=in:st=0:d=${fadeIn.toFixed(6)}:curve=ipar`);
  }
  if (crossfade) {
    const fadeOut = Math.max(0.01, (toReview.effectEndSample - toReview.effectStartSample) / SAMPLE_RATE);
    storyChain.push(`afade=t=out:st=${((storyLength / SAMPLE_RATE) - fadeOut).toFixed(6)}:d=${fadeOut.toFixed(6)}:curve=qsin`);
  }
  if (bedStart > 0) storyChain.push(`adelay=delays=${bedStart}S:all=1`);
  storyChain.push(`apad=whole_len=${total}`, `atrim=end_sample=${total}[storybed]`);
  filters.push(storyChain.join(","));
  beds.push("[storybed]");
  let input = 1;
  if (crossfade) {
    args.push("-stream_loop", "-1", "-i", reviewMusicPath);
    const start = toReview.effectStartSample;
    const length = total - start;
    const fadeIn = Math.max(0.01, (toReview.effectEndSample - toReview.effectStartSample) / SAMPLE_RATE);
    filters.push([
      `[${input}:a]${stereo}`, `atrim=end_sample=${length}`, `apad=whole_len=${length}`, `volume=${reviewGain.toFixed(5)}`,
      `afade=t=in:st=0:d=${fadeIn.toFixed(6)}:curve=qsin`, `adelay=delays=${start}S:all=1`,
      `apad=whole_len=${total}`, `atrim=end_sample=${total}[reviewbed]`,
    ].join(","));
    beds.push("[reviewbed]");
    input += 1;
  }
  if (openingAudioPath && opening) {
    args.push("-i", openingAudioPath);
    const length = opening.effectEndSample;
    const fade = Math.min(opening.outgoingFadeSeconds, length / SAMPLE_RATE);
    filters.push([
      `[${input}:a]${stereo}`, `atrim=end_sample=${length}`, `apad=whole_len=${length}`,
      `afade=t=out:st=${((length / SAMPLE_RATE) - fade).toFixed(6)}:d=${fade.toFixed(6)}`,
      `apad=whole_len=${total}`, `atrim=end_sample=${total}[openingaudio]`,
    ].join(","));
    beds.push("[openingaudio]");
    input += 1;
  }
  filters.push(beds.length === 1
    ? `${beds[0]}anull[bed]`
    : `${beds.join("")}amix=inputs=${beds.length}:duration=longest:dropout_transition=0:normalize=0[bed]`);
  const filterGraph = filters.join(";");
  await runRuntime(ffmpeg, [...args, "-filter_complex", filterGraph, "-map", "[bed]", "-c:a", "pcm_s16le", outputPath]);
  return { filterGraph, inputCount: input, outputMap: "[bed]" };
}

/** 番組の字幕。各部の語りと同じ時刻に始まり、転換・lead-in の間には字幕を置かない。 */
export function buildBookendSrt(plan, formatTime) {
  return plan.segments.map((segment, index) => [
    String(index + 1),
    `${formatTime(segment.startSeconds)} --> ${formatTime(segment.endSeconds, { floor: true })}`,
    segment.text,
    "",
  ].join("\n")).join("\n");
}

/** 確認用 contact sheet に入れるフレーム: 各部の中央と、各境目の effect 前後・ゲート・lead の終わり。 */
export function bookendContactSheetFrames(plan) {
  const frames = new Set();
  for (const part of plan.parts) frames.add(part.startFrame + Math.floor(part.frames / 2));
  for (const boundary of plan.boundaries) {
    frames.add(Math.max(0, boundary.effectStartFrame - 1));
    if (boundary.effectFrames > 0) {
      frames.add(boundary.effectStartFrame + Math.floor(boundary.effectFrames * 0.25));
      frames.add(boundary.effectStartFrame + Math.floor(boundary.effectFrames * 0.43));
      frames.add(boundary.effectStartFrame + Math.floor(boundary.effectFrames * 0.75));
    }
    frames.add(boundary.incomingStartFrame - 1);
    frames.add(boundary.incomingStartFrame);
  }
  return [...frames].filter((frame) => frame >= 0 && frame < plan.totalFrames).sort((left, right) => left - right);
}

export async function makeBookendContactSheet({ ffmpeg, videoPath, plan, outputPath }) {
  const frames = bookendContactSheetFrames(plan);
  const columns = Math.min(4, frames.length);
  const rows = Math.ceil(frames.length / columns);
  const select = frames.map((frame) => `eq(n\\,${frame})`).join("+");
  await runRuntime(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-i", videoPath,
    "-vf", `select='${select}',scale=320:-2,tile=${columns}x${rows}`,
    "-fps_mode", "passthrough", "-frames:v", "1", outputPath,
  ]);
  return frames;
}

// ---- 実測（純粋関数） -------------------------------------------------------

function toDb(value) {
  return value > 0 ? 20 * Math.log10(value) : -120;
}

/** s16le mono PCM → Float32Array（−1〜1）。 */
export function pcmFromS16le(buffer) {
  const samples = new Float32Array(Math.floor(buffer.length / 2));
  for (let index = 0; index < samples.length; index += 1) samples[index] = buffer.readInt16LE(index * 2) / 32768;
  return samples;
}

/** 区間 [start, end) 秒の RMS（dBFS）。samples は windowStart 秒から始まる。 */
export function rmsDb(samples, windowStart, start, end, rate = SAMPLE_RATE) {
  const from = Math.max(0, Math.round((start - windowStart) * rate));
  const to = Math.min(samples.length, Math.round((end - windowStart) * rate));
  if (to <= from) return -120;
  let sum = 0;
  for (let index = from; index < to; index += 1) sum += samples[index] * samples[index];
  return toDb(Math.sqrt(sum / (to - from)));
}

/** 区間を block 秒ごとに切った RMS（dBFS）の列。 */
export function blockDbSeries(samples, windowStart, start, end, block = 0.01, rate = SAMPLE_RATE) {
  const output = [];
  for (let time = start; time + block <= end + 1e-9; time += block) {
    output.push({ time, db: rmsDb(samples, windowStart, time, time + block, rate) });
  }
  return output;
}

export function peakDb(samples, windowStart, start, end, rate = SAMPLE_RATE) {
  const from = Math.max(0, Math.round((start - windowStart) * rate));
  const to = Math.min(samples.length, Math.round((end - windowStart) * rate));
  let peak = 0;
  for (let index = from; index < to; index += 1) peak = Math.max(peak, Math.abs(samples[index]));
  return toDb(peak);
}

export function longestRunBelow(series, floorDb) {
  if (series.length === 0) return 0;
  const step = series.length > 1 ? series[1].time - series[0].time : 0;
  let longest = 0;
  let current = 0;
  for (const entry of series) {
    current = entry.db < floorDb ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest * step;
}

export function firstOnset(series, thresholdDb) {
  return series.find((entry) => entry.db >= thresholdDb)?.time ?? null;
}

/**
 * 64x36 RGB フレーム列の平均絶対差・平均輝度。mask（64x36 の画素ごとに 1 = 測らない）があれば、その画素を
 * 除いて測る（焼き込み字幕の帯と字は、字幕なし lead-in と語りの始まりのフレームで出たり消えたりするので、
 * 転換の実測からは外す。字幕そのものは lib/narratedStorySubtitles.mjs の監査が測る）。
 */
export function frameMeanAbsDiff(left, right, mask = null) {
  if (!left || !right || left.length !== right.length) return 255;
  let sum = 0;
  let count = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (mask && mask[Math.floor(index / 3)]) continue;
    sum += Math.abs(left[index] - right[index]);
    count += 1;
  }
  return count ? sum / count : 255;
}

export function frameLuma(frame, mask = null) {
  let sum = 0;
  let count = 0;
  for (let index = 0; index + 2 < frame.length; index += 3) {
    if (mask && mask[index / 3]) continue;
    sum += 0.299 * frame[index] + 0.587 * frame[index + 1] + 0.114 * frame[index + 2];
    count += 1;
  }
  return count ? sum / count : 0;
}

/**
 * 画面の中の矩形（描く寸法の px）を、境目の実測に使う 64x36 のフレームの画素の mask にする。矩形に少しでも
 * 掛かる画素と、その隣の画素を外す（縮小のにじみも外す）。
 */
export function boundaryExclusionMask(region, render, width = 64, height = 36) {
  if (!region || !(region.width > 0) || !(region.height > 0)) return null;
  const mask = new Uint8Array(width * height);
  const scaleX = width / render.width;
  const scaleY = height / render.height;
  const left = Math.max(0, Math.floor(region.x * scaleX) - 1);
  const top = Math.max(0, Math.floor(region.y * scaleY) - 1);
  const right = Math.min(width - 1, Math.ceil((region.x + region.width) * scaleX));
  const bottom = Math.min(height - 1, Math.ceil((region.y + region.height) * scaleY));
  for (let y = top; y <= bottom; y += 1) for (let x = left; x <= right; x += 1) mask[y * width + x] = 1;
  return mask;
}

/**
 * 1 つの境目の映像を判定する（純粋関数）。frames は effectStartFrame − 2 から
 * incomingStartFrame まで（両端含む）の連続フレーム。
 */
export function judgeBoundaryFrames(boundary, frames, { mask = null } = {}) {
  const offset = boundary.effectStartFrame - 2;
  const at = (frame) => frames[frame - offset] || null;
  const refOutgoing = at(boundary.effectStartFrame - 1);
  const refIncoming = at(boundary.incomingStartFrame - 1);
  const problems = [];
  if (!refOutgoing || !refIncoming || frames.length < boundary.incomingStartFrame - offset + 1) {
    return { pass: false, problems: ["boundary-frames-unavailable"], metrics: { framesRead: frames.length } };
  }
  const effect = [];
  for (let frame = boundary.effectStartFrame; frame < boundary.effectEndFrame; frame += 1) {
    const image = at(frame);
    const toOutgoing = frameMeanAbsDiff(image, refOutgoing, mask);
    const toIncoming = frameMeanAbsDiff(image, refIncoming, mask);
    effect.push({ frame, luma: frameLuma(image, mask), toOutgoing, toIncoming, effect: Math.min(toOutgoing, toIncoming) });
  }
  const lead = [];
  for (let frame = boundary.effectEndFrame; frame < boundary.incomingStartFrame; frame += 1) {
    lead.push(frameMeanAbsDiff(at(frame), refIncoming, mask));
  }
  const preEffectDiff = frameMeanAbsDiff(at(boundary.effectStartFrame - 2), refOutgoing, mask);
  // 転換が宣言より早く始まると、出る側の最終フレームの明るさが 1 フレーム前から跳ぶ（光の漏れは明るく、
  // 黒への溶暗は暗くする）。本編のカメラ移動は輝度をほとんど変えないので、差分ではなく輝度差で見る。
  const preEffectLumaStep = Math.abs(frameLuma(refOutgoing, mask) - frameLuma(at(boundary.effectStartFrame - 2), mask));
  const incomingContinuity = frameMeanAbsDiff(at(boundary.incomingStartFrame), refIncoming, mask);
  const leadMaxDiff = lead.length ? Math.max(...lead) : 0;
  const metrics = {
    preEffectDiff: round(preEffectDiff),
    preEffectLumaStep: round(preEffectLumaStep),
    leadMaxDiff: round(leadMaxDiff),
    incomingContinuityDiff: round(incomingContinuity),
    effectPeak: round(effect.length ? Math.max(...effect.map((entry) => entry.effect)) : 0),
    effectMaxLuma: round(effect.length ? Math.max(...effect.map((entry) => entry.luma)) : 0),
    effectMinLuma: round(effect.length ? Math.min(...effect.map((entry) => entry.luma)) : 0),
    cutDiff: round(frameMeanAbsDiff(refOutgoing, at(boundary.effectEndFrame), mask)),
  };
  if (preEffectLumaStep > TRANSITION_PRE_EFFECT_MAX_LUMA_STEP) problems.push("transition-starts-before-declared-window");
  if (leadMaxDiff > TRANSITION_LEAD_STATIC_MAX_DIFF) problems.push("lead-in-not-clean-destination-frame");
  if (incomingContinuity > TRANSITION_PRE_EFFECT_MAX_DIFF) problems.push("lead-in-does-not-match-incoming-part");
  if (boundary.type === "hard-cut") {
    if (metrics.cutDiff < TRANSITION_CUT_MIN_DIFF) problems.push("hard-cut-not-observed");
  } else {
    if (metrics.effectPeak < TRANSITION_EFFECT_MIN_DIFF) problems.push("transition-effect-not-observed");
    if (boundary.type === "fade-through-black" && metrics.effectMinLuma > TRANSITION_BLACK_MAX_LUMA) {
      problems.push("fade-through-black-not-observed");
    }
    if (boundary.type === "film-burn") {
      const gateIndex = effect.findIndex((entry) => entry.luma >= TRANSITION_WHITE_GATE_MIN_LUMA);
      if (gateIndex < 0) problems.push("film-burn-white-gate-not-observed");
      else {
        const before = effect.slice(0, gateIndex).some((entry) => entry.effect >= TRANSITION_EFFECT_MIN_DIFF);
        const after = effect.slice(gateIndex + 1).some((entry) => entry.effect >= TRANSITION_EFFECT_MIN_DIFF
          && entry.luma < TRANSITION_WHITE_GATE_MIN_LUMA);
        metrics.whiteGateFrame = effect[gateIndex].frame;
        if (!before) problems.push("film-burn-outgoing-lobe-not-observed");
        if (!after) problems.push("film-burn-incoming-lobe-not-observed");
      }
    }
  }
  return { pass: problems.length === 0, problems, metrics };
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

// ---- 実測（ffmpeg で MP4 / stem を decode） ----------------------------------

async function extractPcm(ffmpeg, path, start, duration) {
  const { stdout } = await runRuntime(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-ss", Math.max(0, start).toFixed(6), "-t", Math.max(0.001, duration).toFixed(6),
    "-i", path, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-",
  ], { encoding: "buffer" });
  return pcmFromS16le(stdout);
}

async function extractFrames(ffmpeg, path, firstFrame, count, fps) {
  const width = 64;
  const height = 36;
  const { stdout } = await runRuntime(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-ss", Math.max(0, (firstFrame - 0.25) / fps).toFixed(6), "-i", path,
    "-frames:v", String(count), "-vf", `scale=${width}:${height}:flags=area`, "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
  ], { encoding: "buffer" });
  const size = width * height * 3;
  const frames = [];
  for (let offset = 0; offset + size <= stdout.length; offset += size) frames.push(stdout.subarray(offset, offset + size));
  return frames;
}

function parseSrtTime(value) {
  const match = /(\d+):(\d+):(\d+)[,.](\d+)/u.exec(value);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

async function extractSubtitleCues(ffmpeg, path) {
  const { stdout } = await runRuntime(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", path, "-map", "0:s:0", "-f", "srt", "-"]);
  const cues = [];
  for (const match of String(stdout).matchAll(/(\d+:\d+:\d+[,.]\d+)\s*-->\s*(\d+:\d+:\d+[,.]\d+)/gu)) {
    cues.push({ start: parseSrtTime(match[1]), end: parseSrtTime(match[2]) });
  }
  return cues;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * 完成 MP4 の境目を実測する。返り値の audio / visual がそれぞれ監査 1 件になる。
 * - audio: 語りの末尾が切れていない / 境目に不自然な無音が無い / 転換・lead-in に語りが無い
 *   （MP4 と voice stem の両方）/ クリップしない / 次の語りの発話と最初の字幕が lead の終わりに
 *   揃う / 転換・lead-in に字幕が無い / 映像フレーム数と音声尺が計画どおりで終端が揃う
 * - visual: 宣言した区間に、宣言した種類の転換が実在する（フレーム差分・輝度）
 */
export async function measureNarratedBookendBoundaries({ ffmpeg, ffprobe, videoPath, voiceStemPath, plan, excludeRegion = null, render = null }) {
  const mask = excludeRegion && render ? boundaryExclusionMask(excludeRegion, render) : null;
  const fps = plan.fps;
  const probe = JSON.parse((await runRuntime(ffprobe, [
    "-v", "error", "-count_packets",
    "-show_entries", "format=duration:stream=codec_type,duration,nb_read_packets",
    "-of", "json", videoPath,
  ])).stdout);
  const videoStream = (probe.streams || []).find((stream) => stream.codec_type === "video");
  const audioStream = (probe.streams || []).find((stream) => stream.codec_type === "audio");
  const videoFrames = Number(videoStream?.nb_read_packets) || 0;
  const audioDuration = Number(audioStream?.duration) || 0;
  const cues = await extractSubtitleCues(ffmpeg, videoPath);

  // 基準音量: 本編の segment（最大 8 個、等間隔に選ぶ）を MP4 から測った RMS の中央値。
  const story = plan.segments.filter((segment) => segment.part === "story");
  const step = Math.max(1, Math.floor(story.length / 8));
  const sampled = story.filter((_, index) => index % step === 0).slice(0, 8);
  const segmentLevels = [];
  for (const segment of sampled) {
    const samples = await extractPcm(ffmpeg, videoPath, segment.startSeconds, segment.endSeconds - segment.startSeconds);
    segmentLevels.push(rmsDb(samples, segment.startSeconds, segment.startSeconds, segment.endSeconds));
  }
  const narrationReferenceDb = median(segmentLevels);

  const audioBoundaries = [];
  const visualBoundaries = [];
  for (const boundary of plan.boundaries) {
    const effectStart = boundary.effectStartSeconds;
    const effectEnd = boundary.effectEndSeconds;
    const incomingStart = boundary.incomingStartSeconds;
    const windowStart = Math.max(0, effectStart - 0.5);
    const windowEnd = Math.min(plan.totalSeconds, incomingStart + 0.8);
    const mp4 = await extractPcm(ffmpeg, videoPath, windowStart, windowEnd - windowStart);
    const stemStart = boundary.id === "openingToStory" ? 0 : windowStart;
    const stem = await extractPcm(ffmpeg, voiceStemPath, stemStart, windowEnd - stemStart);
    const problems = [];
    const tailDb = rmsDb(mp4, windowStart, effectStart - 0.06, effectStart);
    const leadSeries = blockDbSeries(mp4, windowStart, effectEnd, incomingStart - 0.005, 0.05);
    const leadMaxDb = leadSeries.length ? Math.max(...leadSeries.map((entry) => entry.db)) : -120;
    const gapSeries = blockDbSeries(mp4, windowStart, effectStart, incomingStart - 0.005, 0.01);
    const silenceRun = longestRunBelow(gapSeries, BOUNDARY_SILENCE_FLOOR_DBFS);
    const gapMinDb = gapSeries.length ? Math.min(...gapSeries.map((entry) => entry.db)) : -120;
    // 語りが入ってはいけない区間: OP→本編は番組の頭から、本編→感想は転換の頭から、次の語りの開始まで。
    const stemQuietFrom = boundary.id === "openingToStory" ? 0 : effectStart;
    const stemSeries = blockDbSeries(stem, stemStart, stemQuietFrom, incomingStart - 0.005, 0.01);
    const stemGapMaxDb = stemSeries.length ? Math.max(...stemSeries.map((entry) => entry.db)) : -120;
    const onsetSearchEnd = Math.min(windowEnd, incomingStart + 0.75);
    const stemOnset = firstOnset(blockDbSeries(stem, stemStart, incomingStart - 0.05, onsetSearchEnd, 0.005), -45);
    const mp4Onset = narrationReferenceDb === null
      ? null
      : firstOnset(blockDbSeries(mp4, windowStart, incomingStart - 0.05, onsetSearchEnd, 0.005), narrationReferenceDb - 15);
    const clipPeakDb = peakDb(mp4, windowStart, Math.max(windowStart, effectStart - 0.2), windowEnd);
    const firstIncomingCue = cues.find((cue) => cue.start >= effectStart - 0.001) || null;
    const cueInGap = cues.some((cue) => cue.end > effectStart + 0.002 && cue.start < incomingStart - 0.002);
    const tailDeltaDb = narrationReferenceDb === null ? null : tailDb - narrationReferenceDb;
    const leadDeltaDb = narrationReferenceDb === null ? null : leadMaxDb - narrationReferenceDb;
    if (narrationReferenceDb === null) problems.push("narration-reference-unmeasured");
    // 語り末尾の判定は Core が語りを載せる部（本編・感想）から出る境目だけに掛ける。OP の音は
    // Pack が供給する素材で、転換の間に 0 へフェードする設計なので、境目直前の音量は測って残すが
    // 切れの判定には使わない（フェード後に音が残っていないことは lead-in の判定が見る）。
    const outgoingCarriesNarration = boundary.outgoingPart !== "opening";
    if (tailDeltaDb !== null && outgoingCarriesNarration && tailDeltaDb > BOUNDARY_TAIL_MAX_DELTA_DB) {
      problems.push("outgoing-narration-tail-cut");
    }
    if (leadDeltaDb !== null && leadDeltaDb > BOUNDARY_LEAD_MAX_DELTA_DB) problems.push("speech-level-audio-in-caption-free-lead");
    if (silenceRun > BOUNDARY_MAX_SILENCE_RUN_SECONDS) problems.push("dead-air-at-boundary");
    if (stemGapMaxDb > BOUNDARY_STEM_SILENCE_DBFS) problems.push("narration-overlaps-transition-or-lead");
    if (stemOnset === null) problems.push("incoming-narration-onset-unmeasured");
    else if (stemOnset < incomingStart - 0.5 / fps) problems.push("incoming-narration-starts-before-lead-end");
    if (stemOnset !== null && (mp4Onset === null || Math.abs(mp4Onset - stemOnset) > BOUNDARY_ONSET_SYNC_TOLERANCE_SECONDS)) {
      problems.push("mp4-narration-onset-drift");
    }
    if (clipPeakDb > BOUNDARY_CLIP_CEILING_DBFS) problems.push("clipping-at-boundary");
    if (!firstIncomingCue || Math.abs(firstIncomingCue.start - incomingStart) > 0.5 / fps + 0.002) {
      problems.push("incoming-caption-not-aligned-with-narration");
    }
    if (cueInGap) problems.push("caption-inside-transition-or-lead");
    audioBoundaries.push({
      id: boundary.id,
      type: boundary.type,
      pass: problems.length === 0,
      problems,
      metrics: {
        effectStartSeconds: round(effectStart, 4),
        effectEndSeconds: round(effectEnd, 4),
        incomingStartSeconds: round(incomingStart, 4),
        narrationReferenceDb: narrationReferenceDb === null ? null : round(narrationReferenceDb),
        tailDb: round(tailDb),
        tailDeltaDb: tailDeltaDb === null ? null : round(tailDeltaDb),
        leadMaxDb: round(leadMaxDb),
        leadDeltaDb: leadDeltaDb === null ? null : round(leadDeltaDb),
        gapMinDb: round(gapMinDb),
        longestSilenceSeconds: round(silenceRun, 3),
        stemGapMaxDb: round(stemGapMaxDb),
        stemOnsetSeconds: stemOnset === null ? null : round(stemOnset, 4),
        mp4OnsetSeconds: mp4Onset === null ? null : round(mp4Onset, 4),
        clipPeakDb: round(clipPeakDb),
        firstIncomingCueSeconds: firstIncomingCue ? round(firstIncomingCue.start, 4) : null,
        captionInsideGap: cueInGap,
      },
    });

    const firstFrame = boundary.effectStartFrame - 2;
    const count = boundary.incomingStartFrame - firstFrame + 1;
    const frames = await extractFrames(ffmpeg, videoPath, firstFrame, count, fps);
    visualBoundaries.push({ id: boundary.id, type: boundary.type, ...judgeBoundaryFrames(boundary, frames, { mask }) });
  }
  const lastCueEnd = cues.length ? Math.max(...cues.map((cue) => cue.end)) : 0;
  const endProblems = [];
  if (videoFrames !== plan.totalFrames) endProblems.push("video-frame-count-differs-from-plan");
  if (Math.abs(audioDuration - plan.totalSeconds) > Math.max(2 / fps, 0.05)) endProblems.push("audio-duration-differs-from-plan");
  if (lastCueEnd > plan.totalSeconds + 1 / fps) endProblems.push("caption-extends-past-video-end");
  // 字幕は segment ごとに 1 つ。数が合わなければ mux で落ちた字幕がある（最後の字幕が消える型）。
  if (cues.length !== plan.segments.length) endProblems.push("caption-count-differs-from-plan");
  return {
    version: NARRATED_BOOKEND_AUDIT_VERSION,
    narrationReferenceDb: narrationReferenceDb === null ? null : round(narrationReferenceDb),
    audio: {
      pass: audioBoundaries.length > 0 && audioBoundaries.every((entry) => entry.pass) && endProblems.length === 0,
      boundaries: audioBoundaries,
      end: {
        pass: endProblems.length === 0,
        problems: endProblems,
        videoFrames,
        plannedFrames: plan.totalFrames,
        audioDurationSeconds: round(audioDuration, 4),
        plannedSeconds: round(plan.totalSeconds, 4),
        captionCount: cues.length,
        plannedCaptionCount: plan.segments.length,
        lastCueEndSeconds: round(lastCueEnd, 4),
      },
    },
    visual: {
      pass: visualBoundaries.length > 0 && visualBoundaries.every((entry) => entry.pass),
      boundaries: visualBoundaries,
    },
  };
}

// ---- 実行した filter graph の検査 -------------------------------------------

const TRANSITION_FILTER = /(?:^|[;,\]])\s*(?:x?fade|blend|tblend)(?:=|[;,[]|$)/iu;
const ACROSSFADE = /(?:^|[;,\]])\s*acrossfade(?:=|[;,[]|$)/iu;

/**
 * bookend 番組で実行した filter graph を検査する（純粋関数）。
 * - 本編・感想の場面間は concat だけ（転換 filter を持たない）
 * - 番組の組み立ても concat だけ。転換は境目クリップの graph にだけあり、宣言した種類と一致する
 * - 語りは部ごとに concat され、master は [voice][bed] の amix。全体 acrossfade は無い
 */
export function inspectNarratedBookendRenderGraphs(renderGraphs = {}, plan) {
  const graphEvidence = Object.fromEntries(Object.entries(renderGraphs || {}).map(([name, value]) => [name, {
    filterGraphSha256: sha256(String(value?.filterGraph || "")),
    inputCount: Number(value?.inputCount ?? value?.imageInputCount ?? 0),
    outputMap: nonEmpty(value?.outputMap ?? value?.videoMap),
  }]));
  const problems = [];
  const graph = (name) => String(renderGraphs?.[name]?.filterGraph || "");
  const count = (id) => plan.segments.filter((segment) => segment.part === id).length;
  // 画の部は、同じ画が続く文を1つのショットにまとめて concat する（カメラの動きを文ごとに始め直さない）。
  const shotCount = (id) => groupNarratedCameraShots(plan.segments
    .filter((segment) => segment.part === id)
    .map((segment) => ({ ...segment, startFrame: segment.partStartFrame }))).length;
  const storyGraph = graph("storyVideo");
  if (!storyGraph.includes(`concat=n=${shotCount("story")}:v=1:a=0[video]`) || TRANSITION_FILTER.test(storyGraph)) {
    problems.push("story-scene-transitions-not-owned-by-parent");
  }
  const reviewPart = plan.parts.find((part) => part.id === "review");
  if (reviewPart) {
    const reviewGraph = graph("reviewVideo");
    // 配置の型の感想パートは、区間を concat でつなぐ（区間の中で転換を足さない）。
    const ok = reviewPart.visual === "presenter-video"
      ? Boolean(reviewGraph) && !TRANSITION_FILTER.test(reviewGraph)
      : (reviewPart.visual === "review-layout"
        ? /concat=n=\d+:v=1:a=0\[video\]$/u.test(reviewGraph) && !TRANSITION_FILTER.test(reviewGraph)
        : reviewGraph.includes(`concat=n=${shotCount("review")}:v=1:a=0[video]`) && !TRANSITION_FILTER.test(reviewGraph));
    if (!ok) problems.push("review-scene-transitions-not-owned-by-parent");
  }
  if (plan.parts.some((part) => part.id === "opening") && (!graph("openingVideo") || TRANSITION_FILTER.test(graph("openingVideo")))) {
    problems.push("opening-graph-invalid");
  }
  const clipCount = plan.parts.length + plan.boundaries.length;
  const programGraph = graph("preview");
  if (!videoConcatAssembled(programGraph, { count: clipCount, label: "program" }) || TRANSITION_FILTER.test(programGraph)) {
    problems.push("program-assembly-adds-undeclared-transition");
  }
  for (const boundary of plan.boundaries) {
    const clip = graph(`transition:${boundary.id}`);
    const expected = boundary.type === "film-burn"
      ? /xfade=transition=custom:/u
      : (boundary.type === "fade-through-black" ? /xfade=transition=fadeblack:/u : null);
    const xfades = (clip.match(/xfade=/gu) || []).length;
    const ok = Boolean(clip) && (expected ? expected.test(clip) && xfades === 1 : xfades === 0 && !TRANSITION_FILTER.test(clip));
    if (!ok) problems.push(`transition-graph-mismatch:${boundary.id}`);
  }
  const voiceGraph = graph("voiceStem");
  const parentAudioMapped = Boolean(voiceGraph)
    && renderGraphs.voiceStem.outputMap === "[voice]"
    && plan.parts.filter((part) => count(part.id) > 0).every((part) => voiceGraph.includes(`concat=n=${count(part.id)}:v=0:a=1`))
    && renderGraphs?.masterAudio?.outputMap === "[master]"
    && graph("masterAudio").includes("[voice][bed]amix=inputs=2")
    && renderGraphs?.preview?.audioMap === `${clipCount}:a:0`;
  const requiredGraphNames = ["voiceStem", "bgmStem", "masterAudio", "preview", "storyVideo"];
  const acrossfadeEvidenceComplete = requiredGraphNames.every((name) => Boolean(graph(name)));
  const acrossfadeGraphs = Object.entries(renderGraphs || {})
    .filter(([, value]) => ACROSSFADE.test(String(value?.filterGraph || "")))
    .map(([name]) => name);
  return {
    graphEvidence,
    problems,
    sceneTransitionOwnedByParent: problems.length === 0,
    parentAudioMapped,
    expectedAudioMap: `${clipCount}:a:0`,
    acrossfadeEvidenceComplete,
    acrossfadeGraphs,
    noWholeProgramAcrossfade: acrossfadeEvidenceComplete && acrossfadeGraphs.length === 0,
  };
}
