// textRenderingGate.mjs
//
// textRenderingPolicy（channel-packs/<channel>/config/<channel>-show-bible.json,
// <channel>-text-rendering-v1）を、生成経路から実際に呼べる形にしたもの。
//
// なぜ要るか
// ---------------------------------------------------------------
// 「本編以外で文字が入る画像は文字ごと一発生成する」という規則を、
// 同じ誤りを2回犯したあとに文章として正本へ書いた。だが文章だけでは
// 3回目を止められない。止められるのは次の2つだけである。
//
//   1. プロンプト側の門: 「文字用の空きを確保せよ」型の指示を弾き、
//      入れる文字列と、それが絵の中でどう存在するか（暖簾の染め抜き・
//      木の看板・垂れ幕・帯）が書かれていることを生成前に確かめる。
//   2. 画素側の門: 生成後に「文字あり版」と「文字なし版」を比べ、
//      完全一致画素が60%を超えていれば後乗せ合成として落とす。
//
// 1 は生成前、2 は生成後。両方を通ったものだけが納品候補になる。
//
// 使い方（生成スクリプトから）:
//   import { loadTextRenderingPolicy, assertPromptRendersTextInWorld,
//            runCompositedTextDetector } from "../lib/textRenderingGate.mjs";
//
//   const { policy, artStyle } = await loadTextRenderingPolicy(projectDir);
//   assertPromptRendersTextInWorld(prompt, {
//     strings: ["<見出し語>"],
//     surface: "暖簾に染め抜かれた",     // 絵の中での存在の仕方
//     assetKind: "チャンネルヘッダー",
//   });
//   ... 生成 ...
//   const gate = await runCompositedTextDetector({
//     projectDir, textImage, plainImage, label: "<asset-label>",
//   });
//   if (gate.verdict !== "PASS_REGENERATED") throw new Error(...);

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// チャンネル固有のパスは共有層に置かない。呼び出し側が showBiblePath を渡す。
export const DETECTOR_RELATIVE_PATH = "scripts/detect-composited-text.py";
export const IDENTICAL_PIXEL_THRESHOLD = 0.60;
export const POLICY_VERSION_SUFFIX = "text-rendering-v1"; // <channel>-text-rendering-v1 の接尾辞

// 「空きを確保せよ」型の言い回し。これが入っていると合成前提に読まれる。
// 2026-09-04 のヘッダー6案はこの言い回しから後乗せ合成へ落ちた。
const RESERVED_SPACE_PHRASES = [
  "reserve space", "reserved space", "reserve a space", "empty type area",
  "type area", "leave room for", "leave space for", "space for the text",
  "space for text", "blank area for", "clear area for", "copy space",
  "placeholder for text", "text will be added", "text added later",
  "文字用の空き", "文字を入れる余白", "文字用の余白", "テキスト用の余白",
  "あとから文字", "後から文字", "文字は後で",
];

// 文字が絵の中の物として存在していることを示す語。少なくとも1つが要る。
const IN_WORLD_SURFACE_HINTS = [
  "noren", "暖簾", "のれん",
  "signboard", "sign board", "wooden sign", "看板", "木札", "木の看板",
  "banner", "hanging banner", "垂れ幕", "幟", "のぼり",
  "lantern", "提灯",
  "band", "帯", "centre band", "center band",
  "painted", "染め抜", "書かれた", "彫られた", "carved", "brushed",
  "dyed", "printed on", "stencil", "calligraphy", "筆文字",
];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 番組正本から artStyle と textRenderingPolicy を読む。
 * どちらかが欠けていれば投げる。生成経路が「読んだつもり」で走るのを防ぐ。
 */
export async function loadTextRenderingPolicy(projectDir, options = {}) {
  if (!isNonEmptyString(options.showBiblePath)) {
    throw new Error("loadTextRenderingPolicy: showBiblePath が要る（共有層はチャンネルの場所を知らない）");
  }
  const showBiblePath = resolve(options.showBiblePath);
  const showBible = JSON.parse(await readFile(showBiblePath, "utf8"));

  const policy = showBible.textRenderingPolicy;
  if (!policy || !String(policy?.version || "").endsWith(POLICY_VERSION_SUFFIX)) {
    throw new Error(
      `textRenderingPolicy(*-${POLICY_VERSION_SUFFIX}) が ${showBiblePath} にない。`
      + " 正本を読まずに文字入り画像を作ってはならない。");
  }
  const artStyle = showBible.artStyle;
  if (!artStyle || !isNonEmptyString(artStyle.id)) {
    throw new Error(`artStyle 宣言が ${showBiblePath} にない。`);
  }
  return {
    showBiblePath,
    showBible,
    policy,
    artStyle,
    clientSourceSpec: showBible.clientSourceSpec || null,
  };
}

/**
 * 生成前の門。プロンプトが「絵の中に文字を描かせる」形になっているか調べる。
 *
 * @param {string} prompt          モデルへ渡す最終プロンプト
 * @param {object} spec
 * @param {string[]} spec.strings  絵に描かせる文字列（そのままの字面）
 * @param {string}  [spec.surface] 文字が乗る物（暖簾・看板・垂れ幕・帯 など）
 * @param {string}  [spec.assetKind] サムネイル/チャンネルアイコン/チャンネルヘッダー
 * @param {object}  [spec.policy]  loadTextRenderingPolicy の policy
 * @returns {{ok:true, strings:string[], surfaceHintsFound:string[]}}
 * @throws  違反なら Error
 */
export function assertPromptRendersTextInWorld(prompt, spec = {}) {
  if (!isNonEmptyString(prompt)) {
    throw new Error("assertPromptRendersTextInWorld: prompt が空");
  }
  const strings = Array.isArray(spec.strings) ? spec.strings.filter(isNonEmptyString) : [];
  if (strings.length === 0) {
    throw new Error(
      "assertPromptRendersTextInWorld: 描かせる文字列を strings で明示すること。"
      + " 字面を決めずに『文字を入れて』とだけ書くと合成前提に読まれる。");
  }
  const lower = prompt.toLowerCase();

  const reserved = RESERVED_SPACE_PHRASES.filter((p) => lower.includes(p.toLowerCase()));
  if (reserved.length > 0) {
    throw new Error(
      `textRenderingPolicy 違反: プロンプトに「空きを確保」型の指示がある → ${reserved.join(" / ")}\n`
      + "  これは 2026-09-04 のヘッダー6案が後乗せ合成へ落ちた原因そのもの。\n"
      + "  『文字用の空きを確保せよ』ではなく、文字列と、それが絵の中でどう存在するか"
      + "（暖簾に染め抜く／木の看板に彫る／垂れ幕に刷る／帯に組む）を書くこと。");
  }

  const missing = strings.filter((s) => !prompt.includes(s));
  if (missing.length > 0) {
    throw new Error(
      `textRenderingPolicy 違反: 描かせる字面がプロンプトに現れていない → ${missing.join(" / ")}\n`
      + "  モデルに描かせる文字列は、そのままの字面でプロンプトに書くこと。");
  }

  const surfaceHintsFound = IN_WORLD_SURFACE_HINTS.filter(
    (h) => lower.includes(h.toLowerCase()));
  const surfaceDeclared = isNonEmptyString(spec.surface);
  if (surfaceHintsFound.length === 0 && !surfaceDeclared) {
    throw new Error(
      "textRenderingPolicy 違反: 文字が絵の中のどこに存在するかが書かれていない。\n"
      + "  暖簾・木の看板・垂れ幕・提灯・帯 のように、文字が乗る物を名指しすること。");
  }
  if (surfaceDeclared && !prompt.includes(spec.surface)) {
    throw new Error(
      `textRenderingPolicy 違反: surface「${spec.surface}」がプロンプト本文に無い。`);
  }
  return { ok: true, strings, surfaceHintsFound };
}

/**
 * 生成後の門。文字あり版と文字なし版の完全一致画素率を測る。
 * scripts/detect-composited-text.py を呼ぶ（実装を二重に持たない）。
 *
 * @returns {Promise<object>} detector の1件分の結果
 */
export async function runCompositedTextDetector({
  projectDir,
  textImage,
  plainImage,
  label = "ad-hoc",
  jsonOut = null,
  python = process.env.PYTHON_BIN || "python3",
} = {}) {
  if (!isNonEmptyString(textImage) || !isNonEmptyString(plainImage)) {
    throw new Error("runCompositedTextDetector: textImage と plainImage が要る");
  }
  const detector = resolve(join(projectDir, DETECTOR_RELATIVE_PATH));
  const out = jsonOut
    || join(projectDir, "canvas", ".text-rendering-gate",
            `${label.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  // detector は日本語を print する。Windows の既定の文字コードで落ちないよう UTF-8 モードで起動する。
  const argv = [
    "-X", "utf8",
    detector,
    "--text-image", resolve(textImage),
    "--plain-image", resolve(plainImage),
    "--label", label,
    "--json-out", out,
  ];
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync(python, argv, { cwd: projectDir, maxBuffer: 1 << 24 }));
  } catch (error) {
    // 終了コード1は「不合格あり」。台帳は書かれているので読み進める。
    if (error?.code !== 1) throw error;
    stdout = error.stdout || "";
  }
  const report = JSON.parse(await readFile(out, "utf8"));
  const result = report.results?.[0];
  if (!result) throw new Error(`detector が結果を返さなかった: ${stdout}`);
  return {
    ...result,
    gate: report.gate,
    reportPath: out,
    policy: POLICY_VERSION_SUFFIX,
  };
}

/**
 * 一括版。案ごとに {label, textImage, plainImage} を渡す。
 * 1件でも不合格なら throwOnFail=true で投げる。
 */
export async function assertNoCompositedText(pairs, {
  projectDir,
  throwOnFail = true,
  jsonOut = null,
} = {}) {
  const results = [];
  for (const pair of pairs) {
    results.push(await runCompositedTextDetector({ projectDir, jsonOut, ...pair }));
  }
  const failed = results.filter((r) => r.verdict !== "PASS_REGENERATED");
  if (failed.length > 0 && throwOnFail) {
    const lines = failed.map(
      (r) => `  ${r.textImage} 完全一致 ${r.identicalPixelPercent}% > ${IDENTICAL_PIXEL_THRESHOLD * 100}%`);
    throw new Error(
      `textRenderingPolicy 不合格（後乗せ合成）${failed.length}件:\n${lines.join("\n")}`);
  }
  return { results, failures: failed.length, gate: failed.length === 0 ? "PASS" : "FAIL" };
}
