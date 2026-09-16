// 選んだカットだけを短い動画クリップへ差し替える工程の「純粋な規則」。
//
// 漫画動画は全カットが「静止画＋カメラ」で出来ている。クライアントの要望で、
// 冒頭やクライマックスなど1話あたり1〜2カットだけを image-to-video の
// クリップへ置き換えられるようにする。置き換わるのはそのカットの映像だけで、
// 音声・吹き出し・尺・前後のタイムラインは変えない。口パクやレイヤー分解の
// アニメーションはしない。
//
// このファイルはレンダラー（mangaVideoPipeline）からも読む。だから他の制作
// モジュールを import しない——循環 import を作ると、どちらが先に評価されたかで
// 未定義の関数を掴む。ここに置くのは入力だけで答えが決まる関数に限る。

import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

export const MANGA_CUT_VIDEO_SUBSTITUTION_VERSION = "manga-cut-video-substitution-v1";
export const MANGA_CUT_VIDEO_BINDING_VERSION = "manga-cut-video-binding-v1";
export const MANGA_CUT_VIDEO_START_FRAME_VERSION = "approved-still-camera-start-v1";
export const MANGA_CUT_VIDEO_LEDGER_VERSION = "manga-cut-video-ledger-v1";

// 1話あたりの上限の天井。契約の maximumCutsPerEpisode はこれ以下でしか
// 設定できない（スキーマでも同じ値で閉じている）。
export const MANGA_CUT_VIDEO_SUBSTITUTION_HARD_CAP = 2;

// 口パク・文字を求める動きの指示は受け取らない。生成側の禁止文と矛盾する
// 指示を混ぜると、どちらが効くかはモデル次第になる。
const FORBIDDEN_MOTION_PROMPT_PATTERNS = [
  { id: "lip-sync", pattern: /lip[\s-]?sync|lipsync|口パク|リップシンク|talking|speaking|mouth\s+mov/iu },
  { id: "text", pattern: /\b(?:text|subtitles?|captions?|letters?|logos?|typography|signage)\b|字幕|テロップ|文字|ロゴ|看板/iu },
];

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

export function stableDigest(value) {
  return sha256Hex(JSON.stringify(stableValue(value)));
}

function finite(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 契約の videoSubstitution を検査する。スキーマと重なる項目もあるが、
 * 「件数が上限以下」「モデルが許可一覧にある」のような項目間の関係は
 * スキーマでは書けないのでここで見る。
 */
export function validateCutVideoSubstitutionContract(contract) {
  const failures = [];
  const fail = (path, message) => failures.push({ path: `videoSubstitution.${path}`, message });
  const section = contract?.videoSubstitution;
  if (!section || typeof section !== "object") {
    failures.push({ path: "videoSubstitution", message: "must declare the opt-in cut video substitution policy" });
    return failures;
  }
  if (section.version !== MANGA_CUT_VIDEO_SUBSTITUTION_VERSION) fail("version", `must equal ${MANGA_CUT_VIDEO_SUBSTITUTION_VERSION}`);
  const cap = Number(section.maximumCutsPerEpisode);
  if (!Number.isInteger(cap) || cap < 0 || cap > MANGA_CUT_VIDEO_SUBSTITUTION_HARD_CAP) {
    fail("maximumCutsPerEpisode", `must be an integer from 0 to ${MANGA_CUT_VIDEO_SUBSTITUTION_HARD_CAP}`);
  }
  const attempts = Number(section.maximumGenerationAttemptsPerCut);
  if (!Number.isInteger(attempts) || attempts < 1) fail("maximumGenerationAttemptsPerCut", "must be a positive integer");
  if (section.requireOperatorPaidConfirmation !== true) fail("requireOperatorPaidConfirmation", "paid clip generation must require explicit operator confirmation");
  if (section.forbidGeneratedAudio !== true) fail("forbidGeneratedAudio", "the approved dialogue audio must stay the only audio");
  if (section.forbidLipSync !== true) fail("forbidLipSync", "lip-sync animation is out of scope");
  const cuts = Array.isArray(section.cuts) ? section.cuts : [];
  if (Number.isInteger(cap) && cuts.length > cap) {
    fail("cuts", `marks ${cuts.length} cuts but maximumCutsPerEpisode is ${cap}`);
  }
  const seen = new Set();
  for (const [index, entry] of cuts.entries()) {
    const cutId = text(entry?.cutId);
    if (!cutId) fail(`cuts[${index}].cutId`, "is required");
    else if (seen.has(cutId)) fail(`cuts[${index}].cutId`, `duplicates ${cutId}`);
    seen.add(cutId);
    const motionPrompt = text(entry?.motionPrompt);
    for (const rule of FORBIDDEN_MOTION_PROMPT_PATTERNS) {
      if (rule.pattern.test(motionPrompt)) fail(`cuts[${index}].motionPrompt`, `must not request ${rule.id}`);
    }
  }
  if (cuts.length > 0) {
    const model = text(section.model);
    if (!model) fail("model", "must name the image-to-video model before any cut is marked");
    else if (!(section.allowedModels || []).includes(model)) fail("model", `${model} is not in allowedModels`);
  }
  return failures;
}

export function resolveCutVideoSubstitutionPolicy(contract) {
  const failures = validateCutVideoSubstitutionContract(contract);
  if (failures.length > 0) {
    throw new Error(`Invalid cut video substitution policy: ${failures.map((row) => `${row.path}: ${row.message}`).join("; ")}`);
  }
  const section = contract.videoSubstitution;
  return {
    version: section.version,
    maximumCutsPerEpisode: section.maximumCutsPerEpisode,
    maximumGenerationAttemptsPerCut: section.maximumGenerationAttemptsPerCut,
    model: text(section.model),
    allowedModels: [...section.allowedModels],
    resolution: section.resolution,
    aspectRatio: section.aspectRatio,
    startFrame: section.startFrame,
    maximumClipShortfallFrames: section.maximumClipShortfallFrames,
    minimumStartFrameSimilarity: section.minimumStartFrameSimilarity,
    denseFaceSamplesPerSecond: section.denseFaceSamplesPerSecond,
    requireOperatorPaidConfirmation: section.requireOperatorPaidConfirmation === true,
    cuts: (section.cuts || []).map((entry) => ({
      cutId: text(entry.cutId),
      motionPrompt: text(entry.motionPrompt),
      reason: text(entry.reason),
    })),
  };
}

/** 渡されたカメラ（normalizeEpisodeCamera 済み）の t=0 の状態。 */
export function cameraStartPoint(camera = {}) {
  const keyframes = Array.isArray(camera.keyframes) && camera.keyframes.length >= 2
    ? [...camera.keyframes].sort((left, right) => finite(left.at, 0) - finite(right.at, 0))
    : null;
  const first = keyframes ? keyframes[0] : {
    zoom: camera.zoomStart,
    focusX: camera.focusX,
    focusY: camera.focusY,
  };
  return {
    zoom: Math.max(1, finite(first.zoom, 1)),
    focusX: Math.min(1, Math.max(0, finite(first.focusX, 0.5))),
    focusY: Math.min(1, Math.max(0, finite(first.focusY, 0.5))),
    saturation: finite(camera.saturation, 1),
    contrast: finite(camera.contrast, 1),
    brightness: finite(camera.brightness, 0),
  };
}

function decimal(value) {
  return Number(finite(value, 0).toFixed(6)).toString();
}

/**
 * 承認済み静止画から、カメラ設計どおりの「カット冒頭の1枚」を切り出す
 * ffmpeg フィルタ。renderCutVideo の固定ズーム経路と同じ式を使う——
 * 見る人が静止画版で最初に見るフレームと、クリップの開始フレームを揃えるため。
 * 吹き出しはこの後で画面座標に重ねるので、ここには含めない。
 */
export function cutVideoStartFrameFilter({ width, height, oversample = 3, start }) {
  const cameraWidth = width * oversample;
  const cameraHeight = height * oversample;
  const zoom = decimal(start.zoom);
  return [
    `scale=${cameraWidth}:${cameraHeight}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${cameraWidth}:${cameraHeight}`,
    `crop=w='trunc(iw/${zoom}/2)*2':h='trunc(ih/${zoom}/2)*2':`
      + `x='max(0,min(iw-ow,iw*${decimal(start.focusX)}-ow/2))':y='max(0,min(ih-oh,ih*${decimal(start.focusY)}-oh/2))'`,
    `scale=${width}:${height}:flags=lanczos`,
    `eq=saturation=${decimal(start.saturation)}:contrast=${decimal(start.contrast)}:brightness=${decimal(start.brightness)}`,
    "setsar=1",
    "format=rgb24",
  ].join(",");
}

/**
 * 開始フレームの仕様（どの画像を、どのカメラ位置で切ったか）の指紋。
 * 画素ではなく仕様で持つのは、PNG の符号化が ffmpeg の版で変わりうるため。
 * 画像かカメラが変われば値が変わり、古いクリップはレンダーで拒否される。
 */
export function cutVideoStartFrameSpecDigest({ sourceImageSha256, width, height, oversample, start }) {
  return stableDigest({
    version: MANGA_CUT_VIDEO_START_FRAME_VERSION,
    sourceImageSha256,
    width,
    height,
    oversample,
    start: {
      zoom: decimal(start.zoom),
      focusX: decimal(start.focusX),
      focusY: decimal(start.focusY),
      saturation: decimal(start.saturation),
      contrast: decimal(start.contrast),
      brightness: decimal(start.brightness),
    },
  });
}

/**
 * 生成へ渡す指示文。運営者が書くのは「何がどう動くか」だけで、
 * 同一性・文字禁止・口パク禁止・カメラ固定は毎回ここで固定文として付ける。
 */
export function buildCutVideoSubstitutionPrompt(motionPrompt) {
  const motion = text(motionPrompt);
  if (!motion) throw new Error("motionPrompt is required for a substituted cut.");
  return [
    "Animate this exact manga illustration as one short, continuous, subtle motion shot.",
    "The first frame must be identical to the provided image.",
    "Keep every character's face, hairstyle, eye shape, outfit, body proportions, colors, line art and art style exactly the same for the whole clip.",
    "Keep the camera locked off or nearly still: no zoom, no cut, no pan that reveals areas outside the image.",
    "Do not add any people, animals, objects, text, letters, numbers, signs, subtitles, captions, speech bubbles, watermarks or logos.",
    "Mouths stay as drawn: no talking, no lip-sync, no mouth animation.",
    `Motion: ${motion}`,
  ].join(" ");
}

/**
 * 「何を作るか」の指紋（尺を除く）。開始フレームは画素ではなく仕様の指紋で
 * 持つ——ffmpeg の版で PNG のバイトが変わっただけで、有料の再生成を
 * 要求しないため。音声の間合い調整でカット尺が縮んでも、既存クリップが
 * 尺を覆っていれば作り直さない。
 */
export function cutVideoContentIdentity({ model, resolution, aspectRatio, prompt, startFrameSpecDigest }) {
  return stableDigest({
    version: MANGA_CUT_VIDEO_SUBSTITUTION_VERSION,
    model,
    resolution,
    aspectRatio,
    promptSha256: sha256Hex(String(prompt || "")),
    startFrameSpecDigest,
    generateAudio: false,
  });
}

/** 実際に投げた要求の指紋（内容＋要求尺）。台帳の試行はこれで束ねる。 */
export function cutVideoRequestIdentity({ contentIdentity, durationSeconds }) {
  return stableDigest({ contentIdentity, durationSeconds });
}

/** exactCutMediaClock と同じ丸め。カットの実フレーム数。 */
export function cutFrameCount(durationSeconds, fps) {
  return Math.max(1, Math.ceil(Math.max(0, finite(durationSeconds, 0)) * fps - 1e-7));
}

/**
 * カットを動画化できるかを決める。
 *
 * 対象外にするもの（どれも、動画にすると既存の保証が測れなくなる）:
 *   - 分割ページ: 黒ガターと「ページ全体に1台のカメラ」を動画モデルは保てない
 *   - 心の声: 暗部と顔の明部は元画像へ焼き込む規則で、動画ではその位置を保証できない
 *   - 複数の元画像を持つカット: 1枚の開始フレームから作るクリップは他の画像を消す
 *   - モデルの最長尺より長いカット: 引き伸ばし・ループ・静止での水増しはしない
 */
export function evaluateCutVideoSubstitutionEligibility({
  cutId,
  cut,
  utterances = [],
  shots = [],
  fps,
  durationOptions = [],
  maximumClipShortfallFrames = 0,
}) {
  const failures = [];
  if (!cut) {
    return { cutId, eligible: false, failures: [{ id: "cut-not-found", detail: `${cutId} is not a cut of this episode` }] };
  }
  if (cut.panelLayout?.enabled) failures.push({ id: "split-page-not-eligible", detail: "split pages keep a whole-page camera and black gutters" });
  const thoughtIds = utterances.filter((row) => row.preset === "thought").map((row) => row.id);
  if (thoughtIds.length > 0) failures.push({ id: "thought-spotlight-not-eligible", detail: `thought utterances ${thoughtIds.join(", ")} need a baked spotlight` });
  const imagePaths = shots.length > 0
    ? [...new Set(shots.map((shot) => shot.imagePath).filter(Boolean))]
    : [text(cut.imagePath)].filter(Boolean);
  if (imagePaths.length !== 1) {
    failures.push({ id: "single-source-image-required", detail: `cut uses ${imagePaths.length} source images` });
  }
  const durationSeconds = finite(cut.timing?.durationSeconds, 0);
  if (!(durationSeconds > 0)) failures.push({ id: "cut-not-timed", detail: "run speech first so the cut duration is final" });
  const frameCount = durationSeconds > 0 ? cutFrameCount(durationSeconds, fps) : 0;
  const minimumSeconds = Math.max(0, (frameCount - maximumClipShortfallFrames) / fps);
  const options = [...durationOptions].map(Number).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  const requestDurationSeconds = options.find((value) => value + 1e-9 >= minimumSeconds) ?? null;
  if (options.length === 0) {
    failures.push({ id: "model-has-no-exact-duration", detail: "the selected model cannot guarantee a clip length" });
  } else if (durationSeconds > 0 && requestDurationSeconds === null) {
    failures.push({
      id: "cut-longer-than-model-maximum",
      detail: `cut is ${durationSeconds.toFixed(3)}s but the model's longest clip is ${options.at(-1)}s; split the cut or choose another`,
    });
  }
  return {
    cutId,
    eligible: failures.length === 0,
    failures,
    durationSeconds,
    frameCount,
    requestDurationSeconds,
    sourceImagePath: imagePaths[0] || "",
  };
}

/**
 * レンダーが使う差し替え情報を取り出す。status が applied 以外なら
 * 静止画で描く（still-fallback は運営者が理由つきで選んだ場合だけ存在する）。
 * applied なのに必須項目が欠けている、または未知の status は例外——
 * 壊れた記録を「差し替え無し」と読み替えると、黙って静止画に戻る。
 */
export function appliedCutVideoBinding(cut) {
  const binding = cut?.videoSubstitution;
  if (binding === undefined || binding === null) return null;
  if (typeof binding !== "object") throw new Error(`${cut?.id}: videoSubstitution must be an object.`);
  if (binding.version !== MANGA_CUT_VIDEO_BINDING_VERSION) {
    throw new Error(`${cut?.id}: unsupported videoSubstitution binding ${binding.version}.`);
  }
  if (binding.status === "still-fallback") {
    if (!text(binding.fallback?.reason) || !text(binding.fallback?.decidedBy)) {
      throw new Error(`${cut?.id}: a still fallback needs the operator's reason and name.`);
    }
    return null;
  }
  if (binding.status !== "applied") {
    throw new Error(`${cut?.id}: videoSubstitution status ${binding.status} cannot be rendered.`);
  }
  const problems = [];
  if (!text(binding.clipPath) || !isAbsolute(binding.clipPath)) problems.push("clipPath");
  if (!SHA256_PATTERN.test(String(binding.clipSha256 || ""))) problems.push("clipSha256");
  if (!SHA256_PATTERN.test(String(binding.startFrameSha256 || ""))) problems.push("startFrameSha256");
  if (!SHA256_PATTERN.test(String(binding.startFrameSpecDigest || ""))) problems.push("startFrameSpecDigest");
  if (!SHA256_PATTERN.test(String(binding.requestIdentity || ""))) problems.push("requestIdentity");
  if (!SHA256_PATTERN.test(String(binding.contentIdentity || ""))) problems.push("contentIdentity");
  if (!(finite(binding.clipDurationSeconds, 0) > 0)) problems.push("clipDurationSeconds");
  if (!Number.isInteger(binding.maximumClipShortfallFrames) || binding.maximumClipShortfallFrames < 0) problems.push("maximumClipShortfallFrames");
  if (problems.length > 0) throw new Error(`${cut?.id}: applied videoSubstitution is missing ${problems.join(", ")}.`);
  return binding;
}

/** レンダー入力ハッシュへ入れる要約。静止画カットは何も足さない（既存キャッシュを壊さない）。 */
export function cutVideoBindingHashInput(binding) {
  if (!binding) return undefined;
  return {
    version: binding.version,
    status: binding.status,
    clipSha256: binding.clipSha256,
    startFrameSpecDigest: binding.startFrameSpecDigest,
    contentIdentity: binding.contentIdentity,
    requestIdentity: binding.requestIdentity,
    maximumClipShortfallFrames: binding.maximumClipShortfallFrames,
  };
}

/**
 * クリップを、そのカットの映像ベースに整えるフィルタ。
 * fps を揃えて 1920x1080 を覆うように拡大・中央切り出しし、カットの
 * 実フレーム数で切る。足りない分は最大 shortfallFrames 枚だけ最終フレームを
 * 複製する（生成尺の丸めで1枚足りないことがあるため）。それ以上の水増しは
 * レンダー前に拒否している。
 */
export function cutVideoClipConformChain({ width, height, fps, frameCount, shortfallFrames = 0 }) {
  const padSeconds = Math.max(0, shortfallFrames) / fps;
  return `setpts=PTS-STARTPTS,fps=${fps},`
    + `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height},setsar=1,`
    + `tpad=stop_mode=clone:stop_duration=${padSeconds.toFixed(6)},`
    + `trim=end_frame=${frameCount},setpts=PTS-STARTPTS`;
}

export function cutVideoClipBaseLayerFilter({ inputIndex, outputLabel = "base0", ...conform }) {
  return `[${inputIndex}:v]${cutVideoClipConformChain(conform)},format=rgba[${outputLabel}]`;
}

/** 実MP4の中で各カットが始まるフレーム番号（カットのフレーム数の累積）。 */
export function cutFrameRanges(manifest) {
  const fps = Math.max(12, finite(manifest?.video?.fps, 30));
  let cursor = 0;
  return (manifest?.cuts || []).map((cut) => {
    const frameCount = cutFrameCount(cut.timing?.durationSeconds, fps);
    const row = { cutId: cut.id, startFrame: cursor, frameCount, fps };
    cursor += frameCount;
    return row;
  });
}
