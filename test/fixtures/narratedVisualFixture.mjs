/**
 * ナレーション物語の見た目（焼き込み字幕・カメラ・感想の配置・回ごとの OP）の合成 fixture。
 * 外部素材・ネットワーク・有料 API を使わず、FFmpeg の lavfi で画と動画を作る。書体だけは OS に
 * 入っている日本語の書体を探して使う（Linux の CI は fonts-noto-cjk、macOS はヒラギノ、Windows は
 * 游ゴシック / メイリオ / MS ゴシック）。見つからなければ試験は理由つきで落ちる（skip しない:
 * 焼き込み字幕の検査を黙って飛ばさない）。
 */

import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { loadFontMetrics, missingGlyphs } from "../../lib/fontMetrics.mjs";

const execFile = promisify(execFileCallback);

/** 字幕の試験で描く字（仮名・漢字・約物・括弧）。書体がこれを全部持っていることを確かめる。 */
export const FIXTURE_GLYPH_PROBE = "最初の物語です、次の場面へ。「感想」を話します！終わり";

const FONT_CANDIDATES = [
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
  "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
  "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
  "C:\\Windows\\Fonts\\YuGothB.ttc",
  "C:\\Windows\\Fonts\\YuGothM.ttc",
  "C:\\Windows\\Fonts\\YuGothR.ttc",
  "C:\\Windows\\Fonts\\meiryo.ttc",
  "C:\\Windows\\Fonts\\msgothic.ttc",
];

/** OS の日本語の書体を探す。probe の字を全部持つ最初の書体の path（無ければ ""）。 */
export async function findJapaneseFontFile() {
  for (const candidate of FONT_CANDIDATES) {
    if (!existsSync(candidate)) continue;
    try {
      const metrics = await loadFontMetrics(candidate);
      if (missingGlyphs(metrics, FIXTURE_GLYPH_PROBE).length === 0) return candidate;
    } catch {
      // 読めない書体は次へ。
    }
  }
  return "";
}

export async function ff(toolchain, args, { cwd } = {}) {
  return execFile(toolchain.ffmpeg.command, [...(toolchain.ffmpeg.args || []), "-hide_banner", "-loglevel", "error", "-y", ...args], {
    cwd,
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * カメラの動きを測れるだけの模様のある静止画（testsrc2 に正弦波の縞を重ねたもの）。
 * 平らな色の面だけの画は、動いても画素が変わらず、動きを測れない。
 */
export async function makeTexturedStill(toolchain, path, { width = 640, height = 360, phase = 0 } = {}) {
  await ff(toolchain, [
    "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=1:duration=0.1`,
    "-f", "lavfi", "-i", `nullsrc=size=${width}x${height}:rate=1:duration=0.1,format=gray,geq=lum='128+70*sin((X+${phase})/9)*cos(Y/7)+40*sin((X+2*Y)/23)'`,
    "-filter_complex", "[0:v]format=rgb24[a];[1:v]format=rgb24[b];[a][b]blend=all_mode=average,format=rgb24[v]",
    "-map", "[v]", "-frames:v", "1", path,
  ]);
}

/** 字幕の Pack（書体は OS の日本語の書体を Pack の中へ写す）。 */
export async function writeSubtitlePackFont(payloadDir, fontPath) {
  const fonts = join(payloadDir, "fonts");
  await mkdir(fonts, { recursive: true });
  const extension = fontPath.toLowerCase().endsWith(".ttc") ? "ttc" : (fontPath.toLowerCase().endsWith(".otf") ? "otf" : "ttf");
  const name = `subtitle.${extension}`;
  await copyFile(fontPath, join(fonts, name));
  return `fonts/${name}`;
}

/** 縁つきの字幕の宣言（試験用の合成値。どのチャンネルの値でもない）。 */
export function outlineSubtitleConfig(fontFile, overrides = {}) {
  return {
    burnIn: true,
    fontFile,
    fontSizeRatio: 0.1,
    textColor: "#ffffff",
    outline: { color: "#000000", widthRatio: 0.12 },
    position: { anchor: "bottom", baselineRatio: 0.9 },
    sideMarginRatio: 0.06,
    maxLines: 2,
    ...overrides,
  };
}

/** 帯つきの字幕の宣言（縁なし・半透明の白い帯に濃い字）。 */
export function bandSubtitleConfig(fontFile, overrides = {}) {
  return {
    burnIn: true,
    fontFile,
    fontSizeRatio: 0.09,
    textColor: "#1a2340",
    band: { color: "#ffffff", opacity: 0.6, topRatio: 0.68 },
    position: { anchor: "top", baselineRatio: 0.8 },
    lineSpacingRatio: 1.25,
    sideMarginRatio: 0.06,
    maxLines: 2,
    ...overrides,
  };
}
