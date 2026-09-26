/**
 * ナレーション物語のゆっくりした寄り引き（カメラ）と、その実測の監査（ジャンル層）。
 *
 * 公開 Core なので、チャンネル固有の値（どの型をどの順に使うか・速さ・寄りの上限）は Channel Pack の
 * narrated-story.json `camera` から受け取る。Core が持つのは
 *
 * - 型（slow-push-in / slow-pull-out / pan-left / pan-right / static）と、その動きの式
 * - 場面（画1枚）を1つのショットにまとめる規則。台本パッケージで1つの場面を話者ごとに分けた文は、
 *   同じ画の続きなので1つの動きを通しで続ける（文ごとに動きを始め直さない。以前は文ごとに寄りを始め直し、
 *   パンの向きを文の番号で交互にしていたので、話者が替わるたびに画が跳ねて逆へ流れた）
 * - 描き方: perspective（eval=frame、bicubic）で、見せる範囲をフレームごとに小数の画素で動かす
 *   （zoompan は位置を整数の画素に丸めるので、遅い動きが止まって跳ぶ）
 * - 完成 MP4 のフレームを読み、ショットの動きを測る監査（相似変換の推定。下の measure*）
 * - 場面ごとの焦点（`cameraFocus: { x, y }`、画の中の顔の位置など。0〜1）。焦点を指定した場面は、Pack の
 *   型ごとの焦点（focusX / focusY）の代わりにその場面の焦点を使う。場面の焦点は
 *   「運営者の画の取り込みの記録の行 → 台本パッケージの本編の場面 → Pack の型ごとの焦点」の順に決める
 *   （applyNarratedSceneCameraFocus）。焦点は画に属する値で、画ができるまで決められない。台本パッケージに
 *   後から書き足すと台本のバイト列が変わり、台本の品質ループの合格（lib/scriptQualityUseGate.mjs）が外れる
 *   ので、画の後で決める焦点は取り込みの記録に書く。指定の無い場面は今までどおり Pack の型ごとの焦点
 *   （後方互換）。焦点は書いた値だけを使い、画から顔を推測しない。完成 MP4 で焦点どおりの範囲を見せて
 *   いることは cameraFocusMeasured が、どこから来た焦点でも計画の焦点で測る
 *
 * pan-left / pan-right は「カメラが左 / 右へ動く」（画の中身は反対へ流れる）。
 *
 * 焦点の効き方（見せる範囲の中心。どの型でも見せる範囲は画の外へ出ない）:
 *   - slow-push-in / slow-pull-out: 寄った端の見せる範囲の中心（Pack の focusX / focusY と同じ意味・同じ計算）。
 *     見せる範囲は毎フレーム画の内側へ寄せる（cameraRectAt と perspective の clip）ので、焦点が端に近いほど
 *     その端に寄せた寄りになる。拡大の上限が 1.010 倍なら中心が動ける幅は画の幅の ±0.495% しかなく、中心から
 *     それより離れた焦点は、一番近い端（角）を動かさない寄りになる（顔は画面の中央の側へ最大 0.5% 寄る）
 *   - pan-left / pan-right: y は見せる範囲の縦の中心（Pack の focusY と同じ）。x はパンの道のりの中ほどの位置。
 *     道のりの両端が画の中に収まる範囲（余白 1 − 1/zoom から道のりを引いた幅）へ寄せる。寄せないと、端で
 *     見せる範囲が止まり、パンが途中で止まって見える
 *   - static: 見せる範囲の中心（zoom が 1 なら全体を見せるので焦点は効かない）
 */

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const NARRATED_CAMERA_PLAN_VERSION = "buzzassist-narrated-story-camera-plan-v1";
export const NARRATED_CAMERA_AUDIT_ID = "cameraMotionMeasured";
/** 場面ごとの焦点を完成 MP4 で測る監査の id（監査契約 v10 から）。 */
export const NARRATED_CAMERA_FOCUS_AUDIT_ID = "cameraFocusMeasured";
/** 場面ごとの焦点の欄（取り込みの記録の行・台本パッケージの本編の場面の cameraFocus）。 */
export const NARRATED_CAMERA_FOCUS_FIELDS = Object.freeze(["x", "y"]);
/**
 * ショットの焦点の出どころ（決める順）。image-manifest は運営者の画の取り込みの記録の行、script-package は
 * 台本パッケージの本編の場面、pack は Channel Pack の型ごとの焦点（場面の焦点が無い）。
 */
export const NARRATED_CAMERA_FOCUS_SOURCES = Object.freeze(["image-manifest", "script-package", "pack"]);
export const NARRATED_CAMERA_MOVES = Object.freeze(["slow-push-in", "slow-pull-out", "pan-left", "pan-right", "static"]);
export const NARRATED_CAMERA_EASINGS = Object.freeze(["linear", "ease-in-out"]);

/**
 * 「ゆっくり」の範囲（Core の上限）。Pack の速さはこの中で宣言する。
 * 寄り: 1秒あたりの拡大率の増え方（0.03 = 3%/s）。パン: 1秒あたりに画の中身が動く量（画面の幅に対する割合）。
 */
export const CAMERA_MAX_ZOOM_PER_SECOND = 0.03;
export const CAMERA_MAX_PAN_PER_SECOND = 0.05;
export const CAMERA_MAX_ZOOM = 1.3;

/**
 * Pack の camera が無いときの Core の既定（ジャンルの既定。どのチャンネルの値でもない）。
 * 従来の既定（拡大の上限 1.08）に合わせた、ゆっくりした寄りだけの型。
 */
export const DEFAULT_NARRATED_CAMERA = Object.freeze({
  moves: Object.freeze({ "slow-push-in": Object.freeze({ zoomPerSecond: 0.01, maxZoom: 1.08, focusX: 0.5, focusY: 0.5 }) }),
  sequence: Object.freeze(["slow-push-in"]),
  easing: Object.freeze({ kind: "linear", linearShare: 1 }),
});

// ---- 監査の閾値 -------------------------------------------------------------
//
// test/narratedStoryCamera.test.mjs の合成 fixture（640x360・24fps・libx264、模様のある静止画）を、基準版と
// 壊した版（動かさない・逆へ動かす・文の境目で動きを始め直す）で同じ測定にかけて決めた
// （2026-09-25、ffmpeg 7.1.1）。値を変えるときは同じ fixture を測り直して、この根拠を書き換えること。
// 2026-09-26 に perspective の on を 1 始まりとして描くよう直した後、同じ fixture の基準版の区間ごとの誤差は
// 拡大率の比 0.0004・移動 0.06px に下がった（許容は変えていない）。

/** 測るときの縦横（16:9 を 192x108 に縮めて測る）。 */
export const CAMERA_ANALYSIS_WIDTH = 192;
/**
 * 計画と実測の拡大率の比の差の許容（区間の始まりと終わりの拡大率の比。始まり→終わりはこの2倍）。
 * 実測: 基準版（等速・緩急つき、寄り・引き・左右のパン・静止）の区間ごとの誤差の最大 0.0008。
 * 壊した版: 動かさない版 0.039〜0.047、逆へ動かす版 0.076〜0.096、文の境目で寄りを始め直す版 0.025。
 */
export const CAMERA_SCALE_TOLERANCE = 0.004;
/**
 * 計画と実測の中身の移動の差の許容（測る画の画素。192 幅で 1px ≒ 画面の幅の 0.52%。始まり→終わりはこの2倍）。
 * 実測: 基準版の区間ごとの誤差の最大 0.11px。壊した版: 動かさない版 4.3〜13.9px、逆へ動かす版 8.4〜27.9px、
 * 文の境目で寄りを始め直す版 2.8px。
 */
export const CAMERA_SHIFT_TOLERANCE_PX = 0.8;
/**
 * 推定が当てにならない（模様が無い・一致しない）とみなす残差（0〜255 の平均絶対差）。
 * 実測: 基準版 0.04〜1.15。粗い探索を入れる前に周期的な模様で別の山へ落ちた推定は 19。
 */
export const CAMERA_MAX_RESIDUAL = 8;

// ---- 場面ごとの焦点の監査の閾値 ---------------------------------------------
//
// フレームどうしの動き（上の相似変換）では、焦点の違いは測れない型がある: パンと static は焦点を変えても
// フレームどうしの動きが同じで、寄りも 1.010 倍では寄った端の違いが 192 幅で 1px に満たない。そこで焦点の監査は、
// 完成 MP4 のフレームを、場面の画を計画の見せる範囲（cameraRectAt）で切り出した絵と直接比べる（絶対の位置）。
//
// test/narratedStoryCameraFocus.test.mjs と同じ合成 fixture（640x360・24fps・libx264 crf 20、模様のある静止画）で、
// 寄り・引き・左右のパン・static に焦点を付けた6つのショットを、拡大の上限 1.010 倍の Pack と 1.12 倍の Pack で描き、
// 基準版と壊した版を同じ測定にかけて決めた（2026-09-26、ffmpeg 7.1.1。perspective の on を 1 始まりに直した後）:
//   - 基準版（計画の焦点で描いた）: 位置の差の最大 0.131px、拡大の差の最大 0.00022
//   - 焦点を無視して Pack の型ごとの焦点で描いた版: 焦点の効くフレームで 2.06〜15.8px
//   - 焦点を上下左右に反転して描いた版: 4.22〜31.6px
//   - パンの焦点を横へ 0.1 ずらして描いた版: 1.86〜11.5px（寄り・static は余白へ寄せた結果が同じ見せ方になり、差は無い）
// 1.010 倍では、焦点を中心から離すと見せる範囲が端へ寄り、中心の焦点との差は寄った端で 2.16px になる（許容の4倍）。
// 描いた k フレーム目が計画の k+1 フレーム目の見せ方だった以前の描き方（perspective の on は 1 始まり）は、この
// fixture の速さで 0.52〜0.58px ずれ、この許容で落ちる。

/** 焦点を測るときの幅（16:9 を 384x216 に縮めて測る。描く寸法がこれより小さければ描く寸法）。 */
export const CAMERA_FOCUS_ANALYSIS_WIDTH = 384;
/**
 * 計画の見せる範囲と MP4 のフレームの、拡大の差の許容。基準版の最大 0.00022 の約9倍（Pack の上限の速さ 3%/s の寄りで
 * 1.6 フレーム分）。焦点の違いは拡大を変えないので、ここは見せる範囲の大きさの取り違えだけを落とす。
 */
export const CAMERA_FOCUS_SCALE_TOLERANCE = 0.002;
/**
 * 計画の見せる範囲と MP4 のフレームの、位置の差の許容（測る画の画素。384 幅で 1px ≒ 画面の幅の 0.26%）。
 * 基準版の最大 0.131px と、壊した版の最小 1.86px のあいだ（どちらからも約 3.7 倍）。
 */
export const CAMERA_FOCUS_SHIFT_TOLERANCE_PX = 0.5;

// ---- 小道具 ---------------------------------------------------------------

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

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

async function runRuntime(spec, args, { timeout = 10 * 60_000, encoding = "utf8" } = {}) {
  if (!spec?.command) throw new Error("A resolved executable is required.");
  return execFile(spec.command, [...(spec.args || []), ...args], { timeout, windowsHide: true, encoding, maxBuffer: 512 * 1024 * 1024 });
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

// ---- Channel Pack の camera -------------------------------------------------

export const NARRATED_CAMERA_FIELDS = Object.freeze({
  top: Object.freeze(["moves", "sequence", "easing"]),
  zoomMove: Object.freeze(["zoomPerSecond", "maxZoom", "focusX", "focusY"]),
  panMove: Object.freeze(["panPerSecond", "zoom", "focusY"]),
  staticMove: Object.freeze(["zoom"]),
  easing: Object.freeze(["kind", "linearShare"]),
});

function moveFields(kind) {
  if (kind === "slow-push-in" || kind === "slow-pull-out") return NARRATED_CAMERA_FIELDS.zoomMove;
  if (kind === "pan-left" || kind === "pan-right") return NARRATED_CAMERA_FIELDS.panMove;
  return NARRATED_CAMERA_FIELDS.staticMove;
}

/**
 * narrated-story.json の `camera` を正規化する（純粋関数）。
 *
 *   "camera": {
 *     "moves": {
 *       "slow-push-in":  { "zoomPerSecond": 0.006, "maxZoom": 1.08 },          // 焦点は任意（focusX/focusY、0〜1）
 *       "slow-pull-out": { "zoomPerSecond": 0.006, "maxZoom": 1.08 },
 *       "pan-left":      { "panPerSecond": 0.012, "zoom": 1.08 },               // zoom は動く余白のための一定の拡大
 *       "pan-right":     { "panPerSecond": 0.012, "zoom": 1.08 },
 *       "static":        {}
 *     },
 *     "sequence": ["slow-push-in", "pan-right", "slow-pull-out", "pan-left"],  // ショットの順に繰り返して当てる
 *     "easing": { "kind": "ease-in-out", "linearShare": 0.5 }                 // 任意。既定は linear
 *   }
 *
 * 長いショットは、上限（maxZoom・動ける余白）に届くように速さを落とす（途中で止めない）。
 */
export function normalizeNarratedCameraConfig(source) {
  const blockers = [];
  if (source === undefined || source === null) {
    return { config: structuredClone({ ...DEFAULT_NARRATED_CAMERA, source: "core-default" }), blockers };
  }
  if (!plainObject(source)) return { config: structuredClone({ ...DEFAULT_NARRATED_CAMERA, source: "core-default" }), blockers: ["camera"] };
  for (const key of Object.keys(source)) if (!NARRATED_CAMERA_FIELDS.top.includes(key)) blockers.push(`camera.${key}-unknown`);
  const moves = {};
  if (!plainObject(source.moves) || Object.keys(source.moves).length === 0) blockers.push("camera.moves");
  else {
    for (const [kind, spec] of Object.entries(source.moves)) {
      const at = `camera.moves.${kind}`;
      if (!NARRATED_CAMERA_MOVES.includes(kind)) { blockers.push(`${at}-unknown`); continue; }
      if (!plainObject(spec)) { blockers.push(at); continue; }
      for (const key of Object.keys(spec)) if (!moveFields(kind).includes(key)) blockers.push(`${at}.${key}-unknown`);
      if (kind === "slow-push-in" || kind === "slow-pull-out") {
        const zoomPerSecond = rangeNumber(spec.zoomPerSecond, 0.001, CAMERA_MAX_ZOOM_PER_SECOND);
        const maxZoom = rangeNumber(spec.maxZoom, 1.01, CAMERA_MAX_ZOOM);
        if (zoomPerSecond === null) blockers.push(`${at}.zoomPerSecond`);
        if (maxZoom === null) blockers.push(`${at}.maxZoom`);
        const focusX = spec.focusX === undefined ? 0.5 : rangeNumber(spec.focusX, 0, 1);
        const focusY = spec.focusY === undefined ? 0.5 : rangeNumber(spec.focusY, 0, 1);
        if (focusX === null) blockers.push(`${at}.focusX`);
        if (focusY === null) blockers.push(`${at}.focusY`);
        moves[kind] = { zoomPerSecond: zoomPerSecond ?? 0, maxZoom: maxZoom ?? 1, focusX: focusX ?? 0.5, focusY: focusY ?? 0.5 };
      } else if (kind === "pan-left" || kind === "pan-right") {
        const panPerSecond = rangeNumber(spec.panPerSecond, 0.001, CAMERA_MAX_PAN_PER_SECOND);
        const zoom = rangeNumber(spec.zoom, 1.02, CAMERA_MAX_ZOOM);
        const focusY = spec.focusY === undefined ? 0.5 : rangeNumber(spec.focusY, 0, 1);
        if (panPerSecond === null) blockers.push(`${at}.panPerSecond`);
        if (zoom === null) blockers.push(`${at}.zoom`);
        if (focusY === null) blockers.push(`${at}.focusY`);
        moves[kind] = { panPerSecond: panPerSecond ?? 0, zoom: zoom ?? 1, focusY: focusY ?? 0.5 };
      } else {
        const zoom = spec.zoom === undefined ? 1 : rangeNumber(spec.zoom, 1, CAMERA_MAX_ZOOM);
        if (zoom === null) blockers.push(`${at}.zoom`);
        moves[kind] = { zoom: zoom ?? 1 };
      }
    }
  }
  const sequence = Array.isArray(source.sequence) ? source.sequence.map(nonEmpty) : [];
  if (sequence.length === 0 || sequence.length > 64) blockers.push("camera.sequence");
  for (const kind of sequence) if (!moves[kind]) blockers.push(`camera.sequence.${kind || "empty"}-undeclared`);
  let easing = { kind: "linear", linearShare: 1 };
  if (source.easing !== undefined) {
    if (!plainObject(source.easing)) blockers.push("camera.easing");
    else {
      for (const key of Object.keys(source.easing)) if (!NARRATED_CAMERA_FIELDS.easing.includes(key)) blockers.push(`camera.easing.${key}-unknown`);
      const kind = nonEmpty(source.easing.kind);
      if (!NARRATED_CAMERA_EASINGS.includes(kind)) blockers.push("camera.easing.kind");
      // 緩急を付けても等速の分を残す（動きが止まって見える瞬間を作らない）。
      const linearShare = kind === "linear" ? 1 : rangeNumber(source.easing.linearShare, 0.3, 1);
      if (linearShare === null) blockers.push("camera.easing.linearShare");
      easing = { kind: kind || "linear", linearShare: linearShare ?? 1 };
    }
  }
  return { config: { source: "channel-pack", moves, sequence, easing }, blockers: [...new Set(blockers)] };
}

/**
 * 場面ごとの焦点（`{ x, y }`、画の中の位置の 0〜1。左上が 0）を正規化する（純粋関数）。台本パッケージの検査・
 * 運営者の画の取り込みの記録の検査（lib/operatorImageImport.mjs）・ショットのまとめ方が同じ規則を使う。
 * 戻り値の problem は欄の名前（"" なら正しい）。undefined は「指定なし」。
 */
export function normalizeNarratedCameraFocus(value) {
  if (value === undefined) return { focus: null, problem: "" };
  if (!plainObject(value)) return { focus: null, problem: "cameraFocus" };
  for (const key of Object.keys(value)) if (!NARRATED_CAMERA_FOCUS_FIELDS.includes(key)) return { focus: null, problem: `cameraFocus.${key}-unknown` };
  // 数の型だけを受ける（"0.3" の文字列を黙って数にしない）。
  const x = typeof value.x === "number" ? rangeNumber(value.x, 0, 1) : null;
  const y = typeof value.y === "number" ? rangeNumber(value.y, 0, 1) : null;
  if (x === null) return { focus: null, problem: "cameraFocus.x" };
  if (y === null) return { focus: null, problem: "cameraFocus.y" };
  return { focus: { x, y }, problem: "" };
}

function focusKey(focus) {
  return focus ? `${focus.x},${focus.y}` : "";
}

/**
 * 場面ごとの焦点を決める（有料生成の前、台本を文に分けた直後に1回）。決める順は
 *   1. 運営者の画の取り込みの記録の行の cameraFocus（imageFocus: 場面 id → { x, y }）
 *   2. 台本パッケージの本編の場面の cameraFocus（文に付いている値）
 *   3. どちらも無ければ Pack の型ごとの焦点（文に何も付けない）
 * 決めた焦点と出どころを文の cameraFocus / cameraFocusSource に書く（segments をその場で書き換える。
 * 場面の全部の文に同じ値を付けるので、同じ場面の文は同じ焦点のまま1つのショットで通る）。
 * 場面の鍵は画の鍵（imageKey。台本パッケージでは story[].id、生テキストでは文の id）で、取り込みの記録の
 * sceneId と同じ。止める理由（有料生成の前に止める）:
 *   - camera-focus-conflict:<場面>:image-vs-package  取り込みの記録と台本パッケージの両方に書かれていて値が違う
 *     （同じ値なら通り、出どころは先に決まる image-manifest）
 *   - camera-focus-review-scene:<場面>  取り込みの記録が感想パートの場面に焦点を書いた（台本パッケージと同じく、
 *     焦点は本編の場面だけ）
 */
export function applyNarratedSceneCameraFocus({ segments = [], imageFocus = new Map() } = {}) {
  const issues = [];
  for (const segment of segments) {
    const scene = segment.imageKey || segment.id;
    const fromImage = imageFocus.get(scene) || null;
    const fromPackage = segment.cameraFocus || null;
    if (fromImage) {
      if ((segment.part || "story") !== "story") { issues.push(`camera-focus-review-scene:${scene}`); continue; }
      if (fromPackage && focusKey(fromPackage) !== focusKey(fromImage)) { issues.push(`camera-focus-conflict:${scene}:image-vs-package`); continue; }
      segment.cameraFocus = { x: fromImage.x, y: fromImage.y };
      segment.cameraFocusSource = "image-manifest";
    } else if (fromPackage) {
      segment.cameraFocusSource = "script-package";
    }
  }
  return { issues: [...new Set(issues)] };
}

/** 文が持つ焦点の出どころ（出どころの無い焦点は台本パッケージの値として扱う。場面の焦点を足した当初の形）。 */
function segmentFocusSource(segment) {
  return segment.cameraFocusSource === "image-manifest" ? "image-manifest" : "script-package";
}

// ---- ショットの計画 ---------------------------------------------------------

/**
 * 時刻を持つ文（{ id, part, imageKey, imagePath, startFrame, frames, cameraMove?, cameraFocus?, cameraFocusSource? }）を、
 * 同じ画が続く範囲ごとのショットにまとめる（部の中で、画の鍵が同じ隣り合う文）。文の順は変えない。
 * 場面ごとの焦点と出どころはショットの最初の文から取る。同じショットの文が違う焦点を持てば（片方だけ持つ場合も）、
 * 1つの動きで通せないので focusConflicts に文の id を残す（計画の problems になり、有料生成の前にも止める）。
 */
export function groupNarratedCameraShots(segments = []) {
  const shots = [];
  for (const segment of segments) {
    const key = segment.imageKey || segment.id;
    const focus = normalizeNarratedCameraFocus(segment.cameraFocus ?? undefined);
    const last = shots.at(-1);
    if (last && last.part === (segment.part || "story") && last.imageKey === key && last.startFrame + last.frames === segment.startFrame) {
      last.segmentIds.push(segment.id);
      last.cutFrames.push(segment.startFrame);
      last.frames += segment.frames;
      if (!last.requestedMove && segment.cameraMove) last.requestedMove = segment.cameraMove;
      if (focus.problem || focusKey(focus.focus) !== focusKey(last.requestedFocus)) {
        last.focusConflicts = [...(last.focusConflicts || []), segment.id];
      }
      continue;
    }
    shots.push({
      part: segment.part || "story",
      imageKey: key,
      imagePath: segment.imagePath || "",
      segmentIds: [segment.id],
      cutFrames: [],
      startFrame: segment.startFrame,
      frames: segment.frames,
      requestedMove: segment.cameraMove || "",
      ...(focus.focus ? { requestedFocus: focus.focus, requestedFocusSource: segmentFocusSource(segment) } : {}),
      ...(focus.problem ? { focusConflicts: [segment.id] } : {}),
    });
  }
  return shots;
}

/**
 * 有料生成の前の検査: 同じ画が続く文（1つのショットになる文）の焦点が食い違う場面の id（最初の文の
 * sourceSegmentId か id）。時刻はまだ無いので、部の中で隣り合う順に並べて、描く側と同じまとめ方で見る。
 * 人物の映像の文（presenterVideo）はショットにしないので外す。
 */
export function narratedCameraFocusConflicts(segments = []) {
  const timed = segments
    .filter((segment) => !segment.presenterVideo)
    .map((segment, index) => ({ ...segment, part: segment.part || "story", startFrame: index, frames: 1 }));
  const bySource = new Map(timed.map((segment) => [segment.id, segment.sourceSegmentId || segment.id]));
  return groupNarratedCameraShots(timed)
    .filter((shot) => shot.focusConflicts?.length)
    .map((shot) => bySource.get(shot.segmentIds[0]));
}

/** 進み具合 p（0〜1）を緩急の式へ通した値（0〜1。等速の分 linearShare を必ず残す）。 */
export function cameraEase(p, easing = { kind: "linear", linearShare: 1 }) {
  const clamped = Math.min(1, Math.max(0, p));
  if (easing.kind !== "ease-in-out") return clamped;
  const share = easing.linearShare;
  return share * clamped + (1 - share) * (1 - Math.cos(Math.PI * clamped)) / 2;
}

/**
 * 1つのショットの動き（始まりと終わりの拡大率・見せる範囲の中心）を決める。
 * 長いショットは上限に届くように速さを落とす（止めない）。durationSeconds はショットの長さ。
 * focus（場面ごとの焦点 { x, y }。無ければ null）は Pack の型ごとの焦点の代わりに使う（効き方はファイルの頭）。
 * focus が null なら、場面ごとの焦点を足す前と同じ動きになる。
 */
export function planCameraMove(kind, spec, durationSeconds, focus = null) {
  const seconds = Math.max(0, Number(durationSeconds) || 0);
  if (kind === "slow-push-in" || kind === "slow-pull-out") {
    const peak = Math.min(spec.maxZoom, (1 + spec.zoomPerSecond) ** seconds);
    const zoomed = { zoom: peak, centerX: focus?.x ?? spec.focusX ?? 0.5, centerY: focus?.y ?? spec.focusY ?? 0.5 };
    const wide = { zoom: 1, centerX: 0.5, centerY: 0.5 };
    return kind === "slow-push-in" ? { from: wide, to: zoomed } : { from: zoomed, to: wide };
  }
  if (kind === "pan-left" || kind === "pan-right") {
    // 中心が動ける幅は 1 - 1/zoom（見せる範囲が画の外へ出ない）。中身が画面の幅の panPerSecond ずつ流れる速さ。
    const margin = 1 - 1 / spec.zoom;
    const travel = Math.min(margin, (spec.panPerSecond / spec.zoom) * seconds);
    const direction = kind === "pan-right" ? 1 : -1;
    // 道のりの中ほど。焦点があれば、道のりの両端が画の中に収まる範囲（0.5 ± (余白 − 道のり)/2）で焦点へ寄せる。
    const slack = Math.max(0, margin - travel) / 2;
    const middle = focus ? Math.min(0.5 + slack, Math.max(0.5 - slack, focus.x)) : 0.5;
    const centerY = focus?.y ?? spec.focusY ?? 0.5;
    return {
      from: { zoom: spec.zoom, centerX: middle - (direction * travel) / 2, centerY },
      to: { zoom: spec.zoom, centerX: middle + (direction * travel) / 2, centerY },
    };
  }
  const still = { zoom: spec.zoom ?? 1, centerX: focus?.x ?? 0.5, centerY: focus?.y ?? 0.5 };
  return { from: still, to: still };
}

/** ショットの frame 番目（0 始まり）の見せる範囲（画の中の正規化座標 0〜1）。 */
export function cameraRectAt(shot, frame) {
  const denominator = Math.max(1, shot.frames - 1);
  const eased = cameraEase(frame / denominator, shot.easing);
  const { from, to } = shot;
  // 拡大率は対数で補間する（見た目の寄りの速さが一定になる）。
  const zoom = Math.max(1, from.zoom * Math.exp(Math.log(to.zoom / from.zoom) * eased));
  const centerX = from.centerX + (to.centerX - from.centerX) * eased;
  const centerY = from.centerY + (to.centerY - from.centerY) * eased;
  const size = 1 / zoom;
  const left = Math.min(1 - size, Math.max(0, centerX - size / 2));
  const top = Math.min(1 - size, Math.max(0, centerY - size / 2));
  return { zoom, left, top, size };
}

/**
 * 時刻を持つ文から、カメラのショットの計画を作る。台本パッケージの場面が型を指定していれば
 * それを使い（Pack が宣言した型だけ）、無ければ Pack の sequence を部の中のショットの順に繰り返す。
 * 場面が焦点を指定していれば、その焦点で動きを決め、ショットに focus（{ x, y, source }。source は
 * image-manifest か script-package）を残す。どのショットにも焦点の出どころ focusSource（image-manifest /
 * script-package / pack）を残す（pack は Pack の型ごとの焦点で、focus の欄は足さない）。
 */
export function planNarratedCameraShots({ segments = [], camera, fps }) {
  const problems = [];
  const shots = groupNarratedCameraShots(segments);
  const counters = new Map();
  const planned = shots.map((shot) => {
    const index = counters.get(shot.part) || 0;
    counters.set(shot.part, index + 1);
    let kind = shot.requestedMove || camera.sequence[index % camera.sequence.length];
    if (!camera.moves[kind]) {
      problems.push(`camera-move-undeclared:${shot.segmentIds[0]}`);
      kind = camera.sequence[index % camera.sequence.length];
    }
    if (shot.focusConflicts?.length) problems.push(`camera-focus-conflict:${shot.segmentIds[0]}`);
    const { requestedFocus, requestedFocusSource, focusConflicts, ...rest } = shot;
    const focus = requestedFocus ? { ...requestedFocus, source: requestedFocusSource || "script-package" } : null;
    const durationSeconds = shot.frames / fps;
    const move = planCameraMove(kind, camera.moves[kind], durationSeconds, requestedFocus || null);
    return {
      id: `${shot.part}:${shot.segmentIds[0]}`,
      ...rest,
      move: kind,
      requested: Boolean(shot.requestedMove),
      focusSource: focus ? focus.source : "pack",
      ...(focus ? { focus } : {}),
      ...(focusConflicts?.length ? { focusConflicts } : {}),
      durationSeconds,
      from: move.from,
      to: move.to,
      easing: camera.easing,
    };
  });
  return { version: NARRATED_CAMERA_PLAN_VERSION, shots: planned, problems };
}

function number(value) {
  return Number(value).toFixed(9).replace(/0+$/u, "").replace(/\.$/u, "");
}

/**
 * ショットの見せる範囲を、perspective の元の四隅の式にする（on = このショットの出力のフレーム番号）。
 * 入力は描く寸法（W×H）に合わせた画。式の中身は計画の cameraRectAt と同じ。
 */
export function cameraPerspectiveFilter(shot, { frameOffset = 0 } = {}) {
  const denominator = Math.max(1, shot.frames - 1);
  // frameOffset: この鎖の最初の出力フレームが、ショットの何フレーム目か（負はショットの前に足した分。場面の
  // crossfade の重なりと、塊の境目で分けた後ろ半分。lib/narratedStorySceneTransitions.mjs）。ショットの外は
  // 始まり・終わりの見せ方のまま止める。
  // perspective の on（出力のフレームの数）は 1 から数える（FFmpeg 7.1.1 で実測: 最初の出力フレームで on=1）。
  // 以前は on をそのまま使っていたので、描いた k フレーム目が計画の k+1 フレーム目の見せ方になり、ショットの
  // 始まりを1フレーム飛ばして終わりの見せ方を2フレーム続けていた。on − 1 で計画（cameraRectAt）と揃える。
  const offset = Math.trunc(Number(frameOffset) || 0) - 1;
  const progress = offset === -1
    ? `min(1,(on-1)/${denominator})`
    : `clip((on${offset > 0 ? "+" : "-"}${Math.abs(offset)})/${denominator},0,1)`;
  const share = shot.easing.kind === "ease-in-out" ? shot.easing.linearShare : 1;
  const eased = share >= 1 ? progress : `(${number(share)}*${progress}+${number(1 - share)}*(1-cos(PI*${progress}))/2)`;
  // 丸めで 1 をわずかに下回ると見せる範囲が画の外へ出る（perspective が止まる）ので、1 未満にしない。
  const zoom = `max(1,${number(shot.from.zoom)}*exp(${number(Math.log(shot.to.zoom / shot.from.zoom))}*${eased}))`;
  const centerX = `(${number(shot.from.centerX)}+${number(shot.to.centerX - shot.from.centerX)}*${eased})`;
  const centerY = `(${number(shot.from.centerY)}+${number(shot.to.centerY - shot.from.centerY)}*${eased})`;
  const left = `(W*clip(${centerX}-0.5/${zoom},0,1-1/${zoom}))`;
  const top = `(H*clip(${centerY}-0.5/${zoom},0,1-1/${zoom}))`;
  const right = `(${left}+W/${zoom})`;
  const bottom = `(${top}+H/${zoom})`;
  return `perspective=x0='${left}':y0='${top}':x1='${right}':y1='${top}':x2='${left}':y2='${bottom}':x3='${right}':y3='${bottom}':interpolation=cubic:sense=source:eval=frame`;
}

/**
 * ショットごとの入力と filter の鎖（[input]→カメラ→[label]）を作る。inputOffset は最初の入力の番号。
 * 描いたショットを concat するのは呼び出し側（場面の間に転換を足さない）。
 */
export function cameraShotChains({ shots, render, inputOffset = 0 }) {
  const inputs = [];
  const chains = shots.map((shot, index) => {
    inputs.push(...cameraShotInputs(shot, render));
    return cameraShotPieceChain({ shot, render, inputIndex: inputOffset + index, label: `c${index}` });
  });
  return { inputs, chains, labels: shots.map((_, index) => `[c${index}]`) };
}

/** ショットの画の入力（静止画を fps で繰り返す）。 */
export function cameraShotInputs(shot, render) {
  return ["-loop", "1", "-framerate", String(render.fps), "-i", shot.imagePath];
}

/**
 * ショットの一部（ショットの fromFrame フレーム目から frames フレーム）を描く鎖（[inputIndex:v] → [label]）。
 * fromFrame は負でもよい（ショットの前に足す分は始まりの見せ方のまま）。frames を省けばショットの終わりまで。
 */
export function cameraShotPieceChain({ shot, render, inputIndex, label, fromFrame = 0, frames = shot.frames - fromFrame }) {
  const { width, height, fps } = render;
  const still = shot.move === "static" && shot.from.zoom === 1;
  return `[${inputIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,`
    + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv444p,`
    + `${still ? "null" : cameraPerspectiveFilter(shot, { frameOffset: fromFrame })},`
    + `trim=end_frame=${frames},setpts=N/(${fps}*TB),fps=${fps},format=yuv420p[${label}]`;
}

/** generation manifest に残すカメラの記録（数値だけ）。 */
export function narratedCameraManifestEntry(plan, camera) {
  return {
    version: plan.version,
    source: camera.source,
    easing: camera.easing,
    shots: plan.shots.map((shot) => ({
      id: shot.id,
      part: shot.part,
      imageKey: shot.imageKey,
      segmentIds: shot.segmentIds,
      startFrame: shot.startFrame,
      frames: shot.frames,
      move: shot.move,
      requested: shot.requested,
      // 焦点の出どころ（image-manifest / script-package / pack）。
      focusSource: shot.focusSource || (shot.focus ? shot.focus.source : "pack"),
      // 場面ごとの焦点（取り込みの記録か台本パッケージの cameraFocus）。Pack の型ごとの焦点のショットには欄を足さない。
      ...(shot.focus ? { focus: shot.focus } : {}),
      from: shot.from,
      to: shot.to,
    })),
  };
}

// ---- 実測（相似変換の推定） -------------------------------------------------------

/**
 * 小さな画で、拡大 s（0.92〜1.08、0.01 刻み）と中心まわりの移動（±8px、1px 刻み）を全部試し、
 * 平均絶対差が最小の組を返す（最近傍で標本を取る。出発点を決めるだけなので粗くてよい）。
 */
function coarseSimilaritySearch(a, b, width, height, mask) {
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const margin = 2;
  let best = { s: 1, tx: 0, ty: 0, cost: Infinity };
  for (let step = -8; step <= 8; step += 1) {
    const s = 1 + step * 0.01;
    for (let ty = -8; ty <= 8; ty += 1) {
      for (let tx = -8; tx <= 8; tx += 1) {
        let sum = 0;
        let count = 0;
        for (let y = margin; y < height - margin; y += 1) {
          for (let x = margin; x < width - margin; x += 1) {
            if (mask && mask[y * width + x]) continue;
            const u = Math.round(s * (x - cx) + cx + tx);
            const v = Math.round(s * (y - cy) + cy + ty);
            if (u < 0 || v < 0 || u >= width || v >= height) continue;
            sum += Math.abs(a[v * width + u] - b[y * width + x]);
            count += 1;
          }
        }
        if (count < 30) continue;
        const cost = sum / count;
        if (cost < best.cost) best = { s, tx, ty, cost };
      }
    }
  }
  return best;
}

/**
 * 2枚の灰色のフレーム A・B（w×h、Float32Array）で、B の画素 x が A の s·x + d に当たる（拡大 s と中身の
 * 移動 d）を推定する（Gauss-Newton。2段の解像度で粗から細へ）。mask（1 = 測らない）は字幕などの動かない
 * 重ね物を外すため。戻り値の residual は一致の残差（0〜255 の平均絶対差）。
 */
export function estimateSimilarity(a, b, width, height, { mask = null, iterations = 30 } = {}) {
  const pyramid = (image, w, h) => {
    const w2 = Math.floor(w / 2);
    const h2 = Math.floor(h / 2);
    const out = new Float32Array(w2 * h2);
    for (let y = 0; y < h2; y += 1) {
      for (let x = 0; x < w2; x += 1) {
        const i = 2 * y * w + 2 * x;
        out[y * w2 + x] = (image[i] + image[i + 1] + image[i + w] + image[i + w + 1]) / 4;
      }
    }
    return out;
  };
  const maskPyramid = (m, w, h) => {
    if (!m) return null;
    const w2 = Math.floor(w / 2);
    const h2 = Math.floor(h / 2);
    const out = new Uint8Array(w2 * h2);
    for (let y = 0; y < h2; y += 1) {
      for (let x = 0; x < w2; x += 1) {
        const i = 2 * y * w + 2 * x;
        out[y * w2 + x] = m[i] || m[i + 1] || m[i + w] || m[i + w + 1] ? 1 : 0;
      }
    }
    return out;
  };
  const solve = (A, B, w, h, m, start) => {
    const gx = new Float32Array(w * h);
    const gy = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y += 1) {
      for (let x = 1; x < w - 1; x += 1) {
        const i = y * w + x;
        gx[i] = (A[i + 1] - A[i - 1]) / 2;
        gy[i] = (A[i + w] - A[i - w]) / 2;
      }
    }
    const sample = (image, u, v) => {
      const x0 = Math.floor(u);
      const y0 = Math.floor(v);
      const fx = u - x0;
      const fy = v - y0;
      const i = y0 * w + x0;
      return image[i] * (1 - fx) * (1 - fy) + image[i + 1] * fx * (1 - fy) + image[i + w] * (1 - fx) * fy + image[i + w + 1] * fx * fy;
    };
    const cx = (w - 1) / 2;
    const cy = (h - 1) / 2;
    let [s, tx, ty] = start;
    const margin = 3;
    let residual = Infinity;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      let h00 = 0; let h01 = 0; let h02 = 0; let h11 = 0; let h12 = 0; let h22 = 0;
      let g0 = 0; let g1 = 0; let g2 = 0;
      let sumAbs = 0;
      let count = 0;
      for (let y = margin; y < h - margin; y += 1) {
        for (let x = margin; x < w - margin; x += 1) {
          if (m && m[y * w + x]) continue;
          const px = x - cx;
          const py = y - cy;
          const u = s * px + cx + tx;
          const v = s * py + cy + ty;
          if (u < 1 || v < 1 || u >= w - 2 || v >= h - 2) continue;
          const r = sample(A, u, v) - B[y * w + x];
          const ax = sample(gx, u, v);
          const ay = sample(gy, u, v);
          const j0 = ax * px + ay * py;
          h00 += j0 * j0; h01 += j0 * ax; h02 += j0 * ay; h11 += ax * ax; h12 += ax * ay; h22 += ay * ay;
          g0 += j0 * r; g1 += ax * r; g2 += ay * r;
          sumAbs += Math.abs(r);
          count += 1;
        }
      }
      if (count < 50) return { s, tx, ty, residual: Infinity, count };
      residual = sumAbs / count;
      // 3x3 の連立方程式（対称）を解く。
      const det = h00 * (h11 * h22 - h12 * h12) - h01 * (h01 * h22 - h12 * h02) + h02 * (h01 * h12 - h11 * h02);
      if (!Number.isFinite(det) || Math.abs(det) < 1e-9) break;
      const d0 = (g0 * (h11 * h22 - h12 * h12) - h01 * (g1 * h22 - h12 * g2) + h02 * (g1 * h12 - h11 * g2)) / det;
      const d1 = (h00 * (g1 * h22 - h12 * g2) - g0 * (h01 * h22 - h12 * h02) + h02 * (h01 * g2 - g1 * h02)) / det;
      const d2 = (h00 * (h11 * g2 - g1 * h12) - h01 * (h01 * g2 - g1 * h02) + g0 * (h01 * h12 - h11 * h02)) / det;
      s -= d0;
      tx -= d1;
      ty -= d2;
      if (Math.abs(d0) < 1e-6 && Math.abs(d1) < 1e-4 && Math.abs(d2) < 1e-4) break;
    }
    return { s, tx, ty, residual, count: 0 };
  };
  // 1/4 の解像度で、拡大と移動の格子を全部試して出発点を決める（模様が周期的でも、近くの別の山へ落ちない。
  // 計画の値を出発点にしない: 計画へ寄せた推定は、計画と違う動きを見逃す）。
  const w2 = Math.floor(width / 2);
  const h2 = Math.floor(height / 2);
  const a2 = pyramid(a, width, height);
  const b2 = pyramid(b, width, height);
  const m2 = maskPyramid(mask, width, height);
  const w4 = Math.floor(w2 / 2);
  const h4 = Math.floor(h2 / 2);
  const a4 = pyramid(a2, w2, h2);
  const b4 = pyramid(b2, w2, h2);
  const m4 = maskPyramid(m2, w2, h2);
  const grid = coarseSimilaritySearch(a4, b4, w4, h4, m4);
  const middle = solve(a2, b2, w2, h2, m2, [grid.s, grid.tx * 2, grid.ty * 2]);
  const fine = solve(a, b, width, height, mask, [middle.s, middle.tx * 2, middle.ty * 2]);
  // 中心まわりの式（u = s·(x−c) + c + t）を、B の x → A の s·x + d に直す。
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  return {
    scale: fine.s,
    dx: fine.tx + cx - fine.s * cx,
    dy: fine.ty + cy - fine.s * cy,
    residual: fine.residual,
  };
}

/**
 * 計画から、フレーム fa と fb（ショットの中の番号）の間の拡大と中身の移動（測る画の画素）を予想する。
 * B の x は A の s·x + d に当たる: s = zoomA/zoomB、d = (leftB − leftA)·zoomA·幅。
 */
export function predictedSimilarity(shot, fa, fb, width, height) {
  const a = cameraRectAt(shot, fa);
  const b = cameraRectAt(shot, fb);
  return {
    scale: a.zoom / b.zoom,
    dx: (b.left - a.left) * a.zoom * width,
    dy: (b.top - a.top) * a.zoom * height,
  };
}

async function extractGrayFrames(ffmpeg, videoPath, firstFrame, count, fps, width, height) {
  const { stdout } = await runRuntime(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-ss", Math.max(0, (firstFrame - 0.25) / fps).toFixed(6), "-i", videoPath,
    "-frames:v", String(count), "-vf", `scale=${width}:${height}:flags=area,format=gray`, "-f", "rawvideo", "-",
  ], { encoding: "buffer" });
  const size = width * height;
  const frames = [];
  for (let offset = 0; offset + size <= stdout.length; offset += size) frames.push(Float32Array.from(stdout.subarray(offset, offset + size)));
  return frames;
}

/** 画面の中の矩形（描く寸法の px）を、測る画の mask（1 = 測らない）にする。隣の画素まで外す。 */
export function cameraExclusionMask(regions, render, width, height) {
  const list = (Array.isArray(regions) ? regions : [regions]).filter((region) => region && region.width > 0 && region.height > 0);
  if (list.length === 0) return null;
  const mask = new Uint8Array(width * height);
  for (const region of list) {
    const left = Math.max(0, Math.floor((region.x * width) / render.width) - 1);
    const top = Math.max(0, Math.floor((region.y * height) / render.height) - 1);
    const right = Math.min(width - 1, Math.ceil(((region.x + region.width) * width) / render.width) + 1);
    const bottom = Math.min(height - 1, Math.ceil(((region.y + region.height) * height) / render.height) + 1);
    for (let y = top; y <= bottom; y += 1) for (let x = left; x <= right; x += 1) mask[y * width + x] = 1;
  }
  return mask;
}

/**
 * 1つのショットの区間の実測を、計画と比べる（純粋関数）。
 */
export function judgeCameraInterval(measured, predicted) {
  const scaleError = Math.abs(measured.scale - predicted.scale);
  const shiftError = Math.hypot(measured.dx - predicted.dx, measured.dy - predicted.dy);
  const problems = [];
  if (!Number.isFinite(measured.residual) || measured.residual > CAMERA_MAX_RESIDUAL) problems.push("motion-unmeasurable");
  if (scaleError > CAMERA_SCALE_TOLERANCE) problems.push("zoom-differs-from-plan");
  if (shiftError > CAMERA_SHIFT_TOLERANCE_PX) problems.push("pan-differs-from-plan");
  return { scaleError: round(scaleError, 5), shiftError: round(shiftError, 3), problems };
}

/** 区間の分け方（ショットを6つに分ける。緩急を付けても1区間の動きが粗い格子の探索の範囲に収まる）。 */
export const CAMERA_MEASURE_INTERVALS = 6;

/** 続く区間の相似変換（B の x → A の s·x + d）をつなぐ: 先頭のフレームから最後のフレームへの変換。 */
export function composeSimilarities(list) {
  let scale = 1;
  let dx = 0;
  let dy = 0;
  for (const step of list) {
    dx += scale * step.dx;
    dy += scale * step.dy;
    scale *= step.scale;
  }
  return { scale, dx, dy };
}

/**
 * 完成 MP4 のカメラを測る。ショットごとに
 *   - 6つの区間（途中で止まる・逆へ戻る・速さが跳ねる、を区間ごとに計画と比べる）
 *   - 区間をつないだ始まり→終わり（全体の動きの量と向き。誤差は区間の数だけ足し合わさるので許容も広げる）
 *   - 同じ画の中の文の境目の前後のフレーム（文ごとに動きを始め直していない）
 * を、フレームから推定した拡大と移動で計画と比べる。
 * 速さの範囲: 始まり→終わりの実測の拡大の速さ・中身の流れる速さが、Pack の型の上限を越えないこと。
 * shots の startFrame は番組のフレーム（MP4 のフレーム番号）。exclude は字幕など動かない重ね物の範囲。
 */
export async function measureNarratedCameraMotion({ ffmpeg, videoPath, shots, camera, render, exclude = [], concurrency = 4 }) {
  const width = CAMERA_ANALYSIS_WIDTH;
  const height = Math.max(2, Math.round((CAMERA_ANALYSIS_WIDTH * render.height) / render.width / 2) * 2);
  const mask = cameraExclusionMask(exclude, render, width, height);
  const fps = render.fps;
  const rows = await mapLimit(shots, concurrency, async (shot) => {
    const problems = [];
    // 測る範囲（ショットの中のフレーム）。場面の crossfade の重なりは、隣の画と混ざるので外す（measureFrom /
    // measureTo。lib/narratedStorySceneTransitions.mjs が決める）。
    const lo = Math.max(0, Math.trunc(Number(shot.measureFrom) || 0));
    const hi = Math.min(shot.frames, Number.isInteger(shot.measureTo) ? shot.measureTo : shot.frames);
    if (hi - lo < 3) return { id: shot.id, move: shot.move, pass: true, skipped: "shot-too-short-to-measure", problems };
    const frames = await extractGrayFrames(ffmpeg, videoPath, shot.startFrame, shot.frames, fps, width, height);
    if (frames.length < shot.frames) return { id: shot.id, move: shot.move, pass: false, problems: ["shot-frames-unavailable"] };
    // 端のフレームは転換・字幕の切り替えと重ならないように1つ内側を使う。
    const first = lo + 1;
    const last = hi - 2 >= first + 1 ? hi - 2 : hi - 1;
    const count = Math.max(1, Math.min(CAMERA_MEASURE_INTERVALS, last - first));
    const marks = [...new Set(Array.from({ length: count + 1 }, (_, k) => Math.round(first + ((last - first) * k) / count)))];
    const measure = (kind, fa, fb) => {
      const measured = estimateSimilarity(frames[fa], frames[fb], width, height, { mask });
      const predicted = predictedSimilarity(shot, fa, fb, width, height);
      return { kind, fa, fb, measured, predicted, ...judgeCameraInterval(measured, predicted) };
    };
    const sections = [];
    for (let k = 0; k + 1 < marks.length; k += 1) sections.push(measure(`section-${k + 1}`, marks[k], marks[k + 1]));
    const cuts = [];
    for (const cut of shot.cutFrames || []) {
      const local = cut - shot.startFrame;
      if (local >= lo + 1 && local < hi) cuts.push(measure("cut", local - 1, local));
    }
    // 始まり→終わり: 区間をつないだ実測と、計画の全体を比べる。
    const composed = composeSimilarities(sections.map((section) => section.measured));
    const wholePredicted = predictedSimilarity(shot, marks[0], marks.at(-1), width, height);
    const wholeScaleError = Math.abs(composed.scale - wholePredicted.scale);
    const wholeShiftError = Math.hypot(composed.dx - wholePredicted.dx, composed.dy - wholePredicted.dy);
    const wholeProblems = [];
    if (wholeScaleError > CAMERA_SCALE_TOLERANCE * 2) wholeProblems.push("zoom-differs-from-plan");
    if (wholeShiftError > CAMERA_SHIFT_TOLERANCE_PX * 2) wholeProblems.push("pan-differs-from-plan");
    const intervals = [
      { kind: "whole", fa: marks[0], fb: marks.at(-1), measured: { ...composed, residual: Math.max(...sections.map((section) => section.measured.residual)) }, predicted: wholePredicted, scaleError: round(wholeScaleError, 5), shiftError: round(wholeShiftError, 3), problems: wholeProblems },
      ...sections,
      ...cuts,
    ].map((interval) => ({
      kind: interval.kind,
      fromFrame: shot.startFrame + interval.fa,
      toFrame: shot.startFrame + interval.fb,
      measured: { scale: round(interval.measured.scale, 5), dx: round(interval.measured.dx, 3), dy: round(interval.measured.dy, 3), residual: round(interval.measured.residual, 2) },
      predicted: { scale: round(interval.predicted.scale, 5), dx: round(interval.predicted.dx, 3), dy: round(interval.predicted.dy, 3) },
      scaleError: interval.scaleError,
      shiftError: interval.shiftError,
      problems: interval.problems,
    }));
    for (const interval of intervals) for (const problem of interval.problems) problems.push(`${interval.kind}:${problem}`);
    // 速さの範囲（始まり→終わりの実測）。
    const seconds = (marks.at(-1) - marks[0]) / fps;
    const zoomPerSecond = seconds > 0 ? Math.exp(Math.abs(Math.log(composed.scale)) / seconds) - 1 : 0;
    const panPerSecond = seconds > 0 ? Math.hypot(composed.dx / width, composed.dy / height) / seconds : 0;
    const spec = camera.moves[shot.move] || {};
    const zoomLimit = (spec.zoomPerSecond ?? 0) + (2 * CAMERA_SCALE_TOLERANCE) / Math.max(seconds, 1e-6);
    const panLimit = (spec.panPerSecond ?? 0) + (2 * CAMERA_SHIFT_TOLERANCE_PX) / width / Math.max(seconds, 1e-6);
    if ((shot.move === "slow-push-in" || shot.move === "slow-pull-out") && zoomPerSecond > zoomLimit) problems.push("zoom-faster-than-declared");
    if ((shot.move === "pan-left" || shot.move === "pan-right") && panPerSecond > panLimit) problems.push("pan-faster-than-declared");
    return {
      id: shot.id,
      move: shot.move,
      segmentIds: shot.segmentIds,
      startFrame: shot.startFrame,
      frames: shot.frames,
      pass: problems.length === 0,
      problems,
      rates: { zoomPerSecond: round(zoomPerSecond, 5), panPerSecond: round(panPerSecond, 5) },
      intervals,
    };
  });
  const failed = rows.filter((row) => !row.pass);
  return {
    version: NARRATED_CAMERA_PLAN_VERSION,
    analysis: { width, height },
    pass: rows.length > 0 && failed.length === 0,
    shotCount: rows.length,
    failedShotIds: failed.map((row) => row.id),
    problems: [...new Set(failed.flatMap((row) => row.problems))],
    shots: rows,
  };
}

// ---- 計画の見せる範囲の期待の絵 ---------------------------------------------------

/**
 * 場面の画を、描くときと同じ合わせ方（描く寸法へ縮めて黒で埋める）で読み、計画の見せる範囲 rect（cameraRectAt の
 * 正規化座標）だけを切り出して、MP4 のフレームと同じ縮小で輝度にした絵（width×height の Float32Array）。
 * 見せる範囲は描く側の式（perspective の毎フレームの式）を使わず、計画の値を定数で渡す（描く側の式の誤りを、
 * 期待の絵へ持ち込まない）。
 */
export async function expectedCameraView({ ffmpeg, imagePath, rect, render, width, height }) {
  const { width: W, height: H } = render;
  const x0 = number(rect.left * W);
  const y0 = number(rect.top * H);
  const x1 = number((rect.left + rect.size) * W);
  const y1 = number((rect.top + rect.size) * H);
  const graph = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv444p,`
    + `perspective=x0=${x0}:y0=${y0}:x1=${x1}:y1=${y0}:x2=${x0}:y2=${y1}:x3=${x1}:y3=${y1}:interpolation=cubic:sense=source,`
    + `format=yuv420p,scale=${width}:${height}:flags=area,format=gray`;
  const { stdout } = await runRuntime(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-i", imagePath, "-vf", graph, "-frames:v", "1", "-f", "rawvideo", "-",
  ], { encoding: "buffer" });
  return stdout.length >= width * height ? Float32Array.from(stdout.subarray(0, width * height)) : null;
}

// ---- 場面ごとの焦点の実測（絶対の位置） -----------------------------------------

async function extractGrayFrameAt(ffmpeg, videoPath, frame, fps, width, height) {
  const { stdout } = await runRuntime(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-ss", Math.max(0, (frame - 0.25) / fps).toFixed(6), "-i", videoPath,
    "-frames:v", "1", "-vf", `scale=${width}:${height}:flags=area,format=gray`, "-f", "rawvideo", "-",
  ], { encoding: "buffer" });
  return stdout.length >= width * height ? Float32Array.from(stdout.subarray(0, width * height)) : null;
}

/** 計画の見せる範囲と MP4 のフレームの一致を判定する（純粋関数）。measured は estimateSimilarity の戻り値。 */
export function judgeCameraFocusView(measured) {
  const scaleError = Math.abs(measured.scale - 1);
  const shiftError = Math.hypot(measured.dx, measured.dy);
  const problems = [];
  if (!Number.isFinite(measured.residual) || measured.residual > CAMERA_MAX_RESIDUAL) problems.push("focus-view-unmeasurable");
  if (scaleError > CAMERA_FOCUS_SCALE_TOLERANCE) problems.push("focus-view-zoom-differs-from-plan");
  if (shiftError > CAMERA_FOCUS_SHIFT_TOLERANCE_PX) problems.push("focus-differs-from-plan");
  return { scaleError: round(scaleError, 5), shiftError: round(shiftError, 3), problems };
}

/**
 * 計画の2つの見せる範囲の、測る画の画素での位置の差（a の見せ方で見たとき）。焦点の監査が、場面の焦点と Pack の
 * 型ごとの焦点を見分けられるかを記録するのに使う（合否には使わない）。
 */
function viewOffsetPx(a, b, width, height) {
  return Math.hypot((b.left - a.left) * a.zoom * width, (b.top - a.top) * a.zoom * height);
}

/**
 * 場面ごとの焦点を完成 MP4 で測る（cameraFocusMeasured）。焦点を指定した場面のショットごとに、測る範囲の最初と
 * 最後のフレーム（カメラの監査と同じ1つ内側）を、場面の画を計画の見せる範囲で切り出した絵と比べ、拡大と位置の差が
 * 許容の中にあることを見る。焦点を指定していないショットは測らない（Pack の型ごとの焦点は cameraMotionMeasured が測る）。
 * shots の startFrame は番組のフレーム。camera は Pack の camera（型ごとの焦点と比べた差を記録するため）。
 * exclude は字幕など動かない重ね物の範囲。
 */
export async function measureNarratedCameraFocus({ ffmpeg, videoPath, shots, camera, render, exclude = [], concurrency = 4 }) {
  const width = Math.min(CAMERA_FOCUS_ANALYSIS_WIDTH, render.width);
  const height = Math.max(2, Math.round((width * render.height) / render.width / 2) * 2);
  const mask = cameraExclusionMask(exclude, render, width, height);
  const fps = render.fps;
  const focused = shots.filter((shot) => shot.focus);
  const rows = await mapLimit(focused, concurrency, async (shot) => {
    const lo = Math.max(0, Math.trunc(Number(shot.measureFrom) || 0));
    const hi = Math.min(shot.frames, Number.isInteger(shot.measureTo) ? shot.measureTo : shot.frames);
    if (hi - lo < 3) return { id: shot.id, move: shot.move, focus: shot.focus, pass: true, skipped: "shot-too-short-to-measure", problems: [] };
    if (!shot.imagePath) return { id: shot.id, move: shot.move, focus: shot.focus, pass: false, problems: ["scene-image-unavailable"] };
    const first = lo + 1;
    const last = hi - 2 >= first + 1 ? hi - 2 : hi - 1;
    // Pack の型ごとの焦点で決めた動き（場面の焦点が無かったときの見せ方）。
    const spec = camera?.moves?.[shot.move];
    const packMove = spec ? planCameraMove(shot.move, spec, shot.frames / fps, null) : null;
    const problems = [];
    const views = [];
    for (const local of [...new Set([first, last])]) {
      const rect = cameraRectAt(shot, local);
      const [actual, expected] = await Promise.all([
        extractGrayFrameAt(ffmpeg, videoPath, shot.startFrame + local, fps, width, height),
        expectedCameraView({ ffmpeg, imagePath: shot.imagePath, rect, render, width, height }),
      ]);
      if (!actual || !expected) { problems.push("focus-frame-unavailable"); continue; }
      const measured = estimateSimilarity(expected, actual, width, height, { mask });
      const judged = judgeCameraFocusView(measured);
      for (const problem of judged.problems) problems.push(problem);
      views.push({
        frame: shot.startFrame + local,
        rect: { zoom: round(rect.zoom, 5), left: round(rect.left, 5), top: round(rect.top, 5) },
        measured: { scale: round(measured.scale, 5), dx: round(measured.dx, 3), dy: round(measured.dy, 3), residual: round(measured.residual, 2) },
        scaleError: judged.scaleError,
        shiftError: judged.shiftError,
        ...(packMove ? { packFocusOffsetPx: round(viewOffsetPx(rect, cameraRectAt({ ...shot, from: packMove.from, to: packMove.to }, local), width, height), 3) } : {}),
        problems: judged.problems,
      });
    }
    const packOffsets = views.map((view) => view.packFocusOffsetPx).filter((value) => Number.isFinite(value));
    return {
      id: shot.id,
      move: shot.move,
      focus: shot.focus,
      segmentIds: shot.segmentIds,
      startFrame: shot.startFrame,
      frames: shot.frames,
      pass: problems.length === 0,
      problems: [...new Set(problems)],
      // 場面の焦点で見せる範囲が、Pack の型ごとの焦点の見せ方と許容を越えて違う（この MP4 で焦点が効いたことまで
      // 読み取れる）か。1.010 倍の寄りで焦点が中心に近いときなどは、違いが許容より小さく false になる。
      distinguishableFromPackFocus: packOffsets.length > 0 && Math.max(...packOffsets) > CAMERA_FOCUS_SHIFT_TOLERANCE_PX,
      views,
    };
  });
  const failed = rows.filter((row) => !row.pass);
  return {
    version: NARRATED_CAMERA_PLAN_VERSION,
    analysis: { width, height },
    pass: failed.length === 0,
    shotCount: rows.length,
    distinguishableCount: rows.filter((row) => row.distinguishableFromPackFocus).length,
    failedShotIds: failed.map((row) => row.id),
    problems: [...new Set(failed.flatMap((row) => row.problems))],
    shots: rows,
  };
}
