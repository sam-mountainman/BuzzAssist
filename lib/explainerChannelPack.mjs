// 解説動画のハーネス（explainer-video）の Channel Pack の中身（payload）の形と、start の引数の検査。
//
// 解説動画のハーネスは、チャンネルが自分の端末で持っている既存の制作（HTML/CSS/JS の映像・ローカルの音声・
// レンダーのスクリプト）を作り直さずに、共通の入口（run-video-harness の Job・RunReceipt・Canvas の投影）へ
// つなぐ「薄い接続」。Pack が宣言するのは次だけで、台本の本文・研究の資料・声の参照音声は写さない（パスと SHA だけ）:
//
//   - どのフォルダの制作か（videoRoot）と、制作のスクリプトへ必ず明示して渡す3つのパス
//     （productionDir / visualsDir / outputDir。省くと別の版を作り直すスクリプトがあるので、既定に頼らない）
//   - 制作が書いた納品の記録（delivery.file）と、取り込む版の SHA（release。任意だが、宣言したら全部一致を求める）
//   - 台本の品質ループの作業フォルダ（scriptQuality）と、途中の成果物の品質ループの作業フォルダ・工程（assetQuality）
//   - 表示の決まりのうち機械で確かめられるもの（display: BGM の有無・数の書き方）
//   - 制作のコマンドの雛形（production.steps。argv の配列だけで、シェルの文字列は受けない）。宣言しないなら
//     status: "not-declared" と理由を書く（制作の実行はその理由で止まる）
//
// 読むだけ。ファイルを書かない。Pack の署名の検証は共通の lib/channelPackEnvelope.mjs が行い、ここは中身の形だけを見る。

import { readFile } from "node:fs/promises";
import path from "node:path";

export const EXPLAINER_HARNESS_ID = "explainer-video";
export const EXPLAINER_CHANNEL_PACK_VERSION = "buzzassist-explainer-channel-pack-v1";
export const EXPLAINER_CHANNEL_PACK_FILE = "explainer-channel-pack.json";
/** 署名の封筒（channel-pack.json）の payloadKind。 */
export const EXPLAINER_PAYLOAD_KIND = "explainer-channel-pack";
export const EXPLAINER_CHANNEL_PACK_INVALID_CODE = "explainer-channel-pack-invalid";
export const EXPLAINER_START_OPTIONS_INVALID_CODE = "explainer-start-options-invalid";

/** Job の options の鍵（Job の識別子に入る。start の時点で決まり、後から変えられない）。 */
export const EXPLAINER_MODE_OPTION = "explainerMode";
export const EXPLAINER_RENDERER_URL_OPTION = "explainerRendererUrl";
/**
 * 実行の型。
 *   import-delivery — 既定。制作は済んでいる前提で、納品の記録の成果物と台本の SHA を照合して取り込み、監査する。
 *                     制作のスクリプトは起動しない。新しい有料・モデルの呼び出しは lib/paidCallGuard.mjs の関所で止める
 *   produce         — Pack の production.steps を順に子プロセスで起動し（3つのパスを明示）、できた納品を同じ監査にかける
 */
export const EXPLAINER_MODES = Object.freeze(["import-delivery", "produce"]);
export const EXPLAINER_DEFAULT_MODE = "import-delivery";

/** 制作のコマンドの雛形で使える置き換え。{rendererUrl} は Job の options.explainerRendererUrl から入る。 */
export const EXPLAINER_STEP_PLACEHOLDERS = Object.freeze(["productionDir", "visualsDir", "outputDir", "rendererUrl"]);
/** 制作のコマンドの実行ファイル。シェルも任意のパスも受けない（node は今動いている Node を使う）。 */
export const EXPLAINER_STEP_EXECUTABLES = Object.freeze(["node", "python3", "python"]);
/** 途中の成果物の品質ループで、取り込みの監査が照合できる工程（今は完成品のサムネだけ）。 */
export const EXPLAINER_ASSET_STAGES = Object.freeze(["thumbnail"]);

const CHANNEL_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const STEP_ID = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const PLACEHOLDER = /\{([A-Za-z]+)\}/gu;
const HAS_PLACEHOLDER = /\{[A-Za-z]+\}/u;
const LOCAL_RENDERER_URL = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{2,5}\/\S*$/u;
const MAX_TEXT = 500;
const MAX_ARGUMENT = 1000;
const MAX_STEPS = 12;
const MAX_ARGV = 40;
const TOP_KEYS = new Set([
  "version", "channelId", "harnessId", "videoRoot", "paths", "delivery", "release",
  "scriptQuality", "assetQuality", "display", "production", "note",
]);
const RELEASE_KEYS = Object.freeze([
  "deliverySha256", "scriptSha256", "videoSha256", "captionsSha256", "thumbnailSha256", "uploadMetadataSha256",
]);

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function packError(issues) {
  const error = new Error(`${EXPLAINER_CHANNEL_PACK_INVALID_CODE}: 解説動画の Channel Pack を使えない。${issues.join(" / ")}`);
  error.code = EXPLAINER_CHANNEL_PACK_INVALID_CODE;
  error.issues = [...issues];
  return error;
}

/**
 * videoRoot からの相対パスを、videoRoot の中の絶対パスへ解く。絶対パス・ドライブ名・`..` は受けない
 * （Windows の `\` 区切りは `/` として読む）。"." は videoRoot そのもの（allowRoot のときだけ）。
 */
function insideRoot(root, value, label, issues, { allowRoot = false } = {}) {
  const text = nonEmpty(value);
  if (!text) {
    issues.push(`${label} が要る（videoRoot からの相対パス）`);
    return null;
  }
  const portable = text.replaceAll("\\", "/");
  if (portable.startsWith("/") || /^[A-Za-z]:/u.test(portable) || portable.split("/").includes("..")) {
    issues.push(`${label} は videoRoot からの相対パスにする（絶対パス・ドライブ名・.. は受けない）`);
    return null;
  }
  if (portable === "." || portable === "./") {
    if (allowRoot) return root;
    issues.push(`${label} に videoRoot そのものは書けない`);
    return null;
  }
  return path.resolve(root, ...portable.replace(/^\.\//u, "").split("/").filter(Boolean));
}

function within(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function normalizeSteps(production, issues) {
  if (!plainObject(production)) {
    issues.push("production は { steps: [...] } か { status: \"not-declared\", reason }");
    return { declared: false, reason: "", steps: [] };
  }
  for (const key of Object.keys(production)) {
    if (!["steps", "status", "reason"].includes(key)) issues.push(`知らない欄 production.${key}`);
  }
  if (production.status === "not-declared") {
    const reason = nonEmpty(production.reason);
    if (!reason) issues.push("production.status が not-declared なら reason に理由を書く（制作の実行はその理由で止まる）");
    if (production.steps !== undefined) issues.push("production.status が not-declared なら steps を書かない");
    return { declared: false, reason: reason.slice(0, MAX_TEXT), steps: [] };
  }
  if (production.status !== undefined) issues.push("production.status は not-declared だけ（書くなら）");
  if (!Array.isArray(production.steps) || production.steps.length === 0 || production.steps.length > MAX_STEPS) {
    issues.push(`production.steps は 1〜${MAX_STEPS} 件の配列`);
    return { declared: false, reason: "", steps: [] };
  }
  const seen = new Set();
  const steps = [];
  production.steps.forEach((step, index) => {
    const label = `production.steps[${index}]`;
    if (!plainObject(step)) { issues.push(`${label} は { id, argv }`); return; }
    for (const key of Object.keys(step)) if (!["id", "argv"].includes(key)) issues.push(`知らない欄 ${label}.${key}`);
    const id = nonEmpty(step.id);
    if (!STEP_ID.test(id)) issues.push(`${label}.id は英小文字・数字・- の48字まで`);
    else if (seen.has(id)) issues.push(`${label}.id が重複`);
    seen.add(id);
    if (!Array.isArray(step.argv) || step.argv.length < 2 || step.argv.length > MAX_ARGV) {
      issues.push(`${label}.argv は [実行ファイル, スクリプト, 引数...] の配列（2〜${MAX_ARGV} 個）`);
      return;
    }
    const argv = step.argv.map((value) => (typeof value === "string" ? value : ""));
    if (argv.some((value) => !value || value.length > MAX_ARGUMENT || /[\r\n\0]/u.test(value))) {
      issues.push(`${label}.argv に空・長すぎる・改行を含む値がある`);
      return;
    }
    if (!EXPLAINER_STEP_EXECUTABLES.includes(argv[0])) {
      issues.push(`${label}.argv[0] は ${EXPLAINER_STEP_EXECUTABLES.join(" / ")} のどれか（シェルも任意のパスも受けない）`);
    }
    const script = argv[1].replaceAll("\\", "/");
    if (script.startsWith("/") || /^[A-Za-z]:/u.test(script) || script.split("/").includes("..") || HAS_PLACEHOLDER.test(script)) {
      issues.push(`${label}.argv[1] は videoRoot からの相対パスのスクリプト`);
    }
    for (const value of argv.slice(2)) {
      for (const match of value.matchAll(PLACEHOLDER)) {
        if (!EXPLAINER_STEP_PLACEHOLDERS.includes(match[1])) issues.push(`${label}.argv に知らない置き換え {${match[1]}}`);
      }
    }
    steps.push({ id, argv });
  });
  // 3つのパスは「省くと別の版を作り直す」スクリプトがあるので、宣言した雛形のどこかに必ず出てくること。
  const joined = steps.flatMap((step) => step.argv).join("\u0000");
  for (const name of ["productionDir", "visualsDir", "outputDir"]) {
    if (!joined.includes(`{${name}}`)) issues.push(`production.steps のどこにも {${name}} が無い（3つのパスは制作のスクリプトへ必ず明示して渡す）`);
  }
  return { declared: steps.length > 0, reason: "", steps };
}

/**
 * payload の中身（explainer-channel-pack.json を JSON として読んだもの）を検査し、パスを絶対にした形へ直す。
 * 問題があれば理由の一覧つきの例外（黙って既定へ倒さない）。
 */
export function validateExplainerChannelPack(parsed) {
  const issues = [];
  if (!plainObject(parsed)) throw packError(["JSON object ではない"]);
  for (const key of Object.keys(parsed)) if (!TOP_KEYS.has(key)) issues.push(`知らない欄 ${key}`);
  if (parsed.version !== EXPLAINER_CHANNEL_PACK_VERSION) issues.push(`version は ${EXPLAINER_CHANNEL_PACK_VERSION}`);
  if (parsed.harnessId !== EXPLAINER_HARNESS_ID) issues.push(`harnessId は ${EXPLAINER_HARNESS_ID}`);
  const channelId = nonEmpty(parsed.channelId);
  if (!CHANNEL_ID.test(channelId)) issues.push("channelId はチャンネルの台帳の id（英小文字・数字・_・-）");
  const rootText = nonEmpty(parsed.videoRoot);
  if (!rootText || !path.isAbsolute(rootText)) {
    throw packError([...issues, "videoRoot は制作のフォルダの絶対パス"]);
  }
  const root = path.resolve(rootText);

  const paths = {};
  if (!plainObject(parsed.paths)) issues.push("paths は { productionDir, visualsDir, outputDir }");
  else {
    for (const key of Object.keys(parsed.paths)) if (!["productionDir", "visualsDir", "outputDir"].includes(key)) issues.push(`知らない欄 paths.${key}`);
    for (const key of ["productionDir", "visualsDir", "outputDir"]) paths[key] = insideRoot(root, parsed.paths[key], `paths.${key}`, issues);
  }

  let delivery = null;
  if (!plainObject(parsed.delivery)) issues.push("delivery は { file }（制作が書いた納品の記録）");
  else {
    for (const key of Object.keys(parsed.delivery)) if (key !== "file") issues.push(`知らない欄 delivery.${key}`);
    const file = insideRoot(root, parsed.delivery.file, "delivery.file", issues);
    if (file && paths.outputDir && !within(paths.outputDir, file)) issues.push("delivery.file は paths.outputDir の中");
    delivery = file ? { file } : null;
  }

  let release = null;
  if (parsed.release !== undefined) {
    if (!plainObject(parsed.release)) issues.push("release は取り込む版の SHA の組（任意）");
    else {
      release = {};
      for (const [key, value] of Object.entries(parsed.release)) {
        if (!RELEASE_KEYS.includes(key)) { issues.push(`知らない欄 release.${key}`); continue; }
        if (!SHA256.test(String(value || ""))) issues.push(`release.${key} は小文字の sha256`);
        else release[key] = value;
      }
      if (!release.deliverySha256 || !release.scriptSha256 || !release.videoSha256) {
        issues.push("release を書くなら deliverySha256・scriptSha256・videoSha256 は必ず書く");
      }
    }
  }

  let scriptQuality = null;
  if (!plainObject(parsed.scriptQuality)) issues.push("scriptQuality は { genre: \"explainer\", workDir }");
  else {
    for (const key of Object.keys(parsed.scriptQuality)) if (!["genre", "workDir"].includes(key)) issues.push(`知らない欄 scriptQuality.${key}`);
    if (parsed.scriptQuality.genre !== "explainer") issues.push("scriptQuality.genre は explainer（共通の解説動画の台本の採点表）");
    scriptQuality = { genre: "explainer", workDir: insideRoot(root, parsed.scriptQuality.workDir, "scriptQuality.workDir", issues, { allowRoot: true }) };
  }

  let assetQuality = null;
  if (!plainObject(parsed.assetQuality)) issues.push("assetQuality は { workDir, stages }（途中の成果物の品質ループ）");
  else {
    for (const key of Object.keys(parsed.assetQuality)) if (!["workDir", "stages"].includes(key)) issues.push(`知らない欄 assetQuality.${key}`);
    const stages = Array.isArray(parsed.assetQuality.stages) ? parsed.assetQuality.stages.map(String) : null;
    if (!stages || stages.length === 0) issues.push(`assetQuality.stages は ${EXPLAINER_ASSET_STAGES.join(" / ")} から1つ以上`);
    else for (const stage of stages) if (!EXPLAINER_ASSET_STAGES.includes(stage)) issues.push(`assetQuality.stages に照合できない工程 ${stage}`);
    assetQuality = {
      workDir: insideRoot(root, parsed.assetQuality.workDir, "assetQuality.workDir", issues, { allowRoot: true }),
      stages: stages ? [...new Set(stages)] : [],
    };
  }

  let display = null;
  if (!plainObject(parsed.display)) issues.push("display は { bgm: \"none\" | \"allowed\", numerals: \"arabic\" | \"any\" }");
  else {
    for (const key of Object.keys(parsed.display)) if (!["bgm", "numerals"].includes(key)) issues.push(`知らない欄 display.${key}（機械で確かめられる決まりだけを書く）`);
    if (!["none", "allowed"].includes(parsed.display.bgm)) issues.push("display.bgm は none か allowed");
    if (!["arabic", "any"].includes(parsed.display.numerals)) issues.push("display.numerals は arabic か any");
    display = { bgm: parsed.display.bgm, numerals: parsed.display.numerals };
  }

  const production = normalizeSteps(parsed.production, issues);
  if (parsed.note !== undefined && (typeof parsed.note !== "string" || parsed.note.length > MAX_TEXT)) {
    issues.push(`note は ${MAX_TEXT} 字までの文字列`);
  }
  if (issues.length > 0) throw packError(issues);
  return {
    version: EXPLAINER_CHANNEL_PACK_VERSION,
    channelId,
    harnessId: EXPLAINER_HARNESS_ID,
    videoRoot: root,
    paths,
    delivery,
    release,
    scriptQuality,
    assetQuality,
    display,
    production,
  };
}

/** 検証済みの payload のフォルダから Pack を読む。 */
export async function loadExplainerChannelPack(payloadDir) {
  const file = path.join(path.resolve(nonEmpty(payloadDir)), EXPLAINER_CHANNEL_PACK_FILE);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw packError([`${EXPLAINER_CHANNEL_PACK_FILE} を読めない（${error?.code === "ENOENT" ? "無い" : "JSON として読めない"}）`]);
  }
  return validateExplainerChannelPack(parsed);
}

/**
 * start の options の検査（Job を作る前に止める。options は Job の識別子に入り、後から直せない）。
 * 返すのは実行の型（既定は import-delivery）。
 */
export function explainerModeOf(options = {}) {
  const value = options?.[EXPLAINER_MODE_OPTION];
  if (value === undefined || value === null || value === "") return EXPLAINER_DEFAULT_MODE;
  return String(value);
}

export function assertExplainerStartOptions(options = {}) {
  const problems = [];
  const mode = explainerModeOf(options);
  if (!EXPLAINER_MODES.includes(mode)) problems.push(`options.${EXPLAINER_MODE_OPTION} は ${EXPLAINER_MODES.join(" / ")}`);
  const url = options?.[EXPLAINER_RENDERER_URL_OPTION];
  if (url !== undefined) {
    if (typeof url !== "string" || !LOCAL_RENDERER_URL.test(url)) {
      problems.push(`options.${EXPLAINER_RENDERER_URL_OPTION} は手元の HTTP サーバーの URL（http://127.0.0.1:<port>/... か localhost）`);
    } else if (mode !== "produce") {
      problems.push(`options.${EXPLAINER_RENDERER_URL_OPTION} は ${EXPLAINER_MODE_OPTION}: produce のときだけ使う（取り込みでは使わないので Job の識別子を分けない）`);
    }
  }
  if (problems.length > 0) {
    const error = new Error(`${EXPLAINER_START_OPTIONS_INVALID_CODE}: ${problems.join(" / ")}。Job は作っていない。`);
    error.code = EXPLAINER_START_OPTIONS_INVALID_CODE;
    error.problems = problems;
    throw error;
  }
  return mode;
}

/**
 * 制作のコマンドの雛形を、実際に起動する argv へ直す。3つのパスは絶対パスで明示する。{rendererUrl} を使う雛形は
 * options.explainerRendererUrl が無ければ起動しない（missing に名前を返す）。
 */
export function resolveExplainerSteps(pack, { rendererUrl = "", execPath = process.execPath } = {}) {
  const values = {
    productionDir: pack.paths.productionDir,
    visualsDir: pack.paths.visualsDir,
    outputDir: pack.paths.outputDir,
    rendererUrl: nonEmpty(rendererUrl),
  };
  const missing = new Set();
  const steps = (pack.production?.steps || []).map((step) => {
    const args = step.argv.slice(1).map((value, index) => {
      if (index === 0) return path.resolve(pack.videoRoot, ...value.replaceAll("\\", "/").split("/").filter(Boolean));
      return value.replace(PLACEHOLDER, (whole, name) => {
        if (!values[name]) missing.add(name);
        return values[name] || whole;
      });
    });
    const command = step.argv[0] === "node" ? execPath : step.argv[0];
    return { id: step.id, command, args, cwd: pack.videoRoot, label: [step.argv[0], ...step.argv.slice(1)].join(" ") };
  });
  return { steps, missing: [...missing] };
}
