/**
 * FFmpeg の filter_complex を、長ければファイルで渡す（共有層）。
 *
 * 1本の引数の長さには上限がある（Linux は 1 引数 128KiB、Windows はコマンド行全体で 32,767 字）。
 * 場面ごとにカメラの式を書く graph は場面の数に比例して伸びるので、長い台本では引数に入らない。
 * 長い graph はファイルへ書き、FFmpeg 7 以降は `-/filter_complex <file>`、それより前は
 * `-filter_complex_script <file>` で渡す（7 で前者が入り、後者は非推奨になった。固定版の 9 系は前者だけ）。
 * 版が読めない build（git の版名など）は新しい方とみなす。
 *
 * コマンド行の長さ（Windows の上限）もここで測る。入力（`-i <path>`）の数に比例して伸びる呼び出しは、
 * 組み立てたコマンド行を windowsCommandLineLength で測り、FFMPEG_COMMAND_LINE_BUDGET を越えない単位に
 * 分けて描く（lib/ffmpegSequenceRender.mjs）。
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** これより短い graph は引数でそのまま渡す（Windows のコマンド行の上限より十分小さく）。 */
export const INLINE_FILTER_GRAPH_MAX = 8_000;

/** Windows の CreateProcess が受けるコマンド行の上限（終端の NUL を含めて 32,767 字。UTF-16 の単位）。 */
export const WINDOWS_COMMAND_LINE_MAX = 32_767;

/**
 * 1回の FFmpeg の呼び出しに許すコマンド行の長さ。上限から約 2,700 字を余白に残す（ffmpeg の置き場所が
 * 端末ごとに違う分と、Node の引数の組み立ての差の分）。どの OS でも同じ値で分ける（Windows だけ別の
 * 分け方にすると、同じ台本の描き方が OS で変わる）。
 */
export const FFMPEG_COMMAND_LINE_BUDGET = 30_000;

export function ffmpegMajorVersion(ffmpeg) {
  const match = /^(\d+)\./u.exec(String(ffmpeg?.version || "").trim());
  return match ? Number(match[1]) : null;
}

/**
 * Windows で Node（libuv）が1つの引数をコマンド行へ書く形。libuv の quote_cmd_arg と同じ規則:
 * 空は `""`、空白・タブ・`"` を含まなければそのまま、`"` も `\` も無ければ `"…"`、それ以外は `"` の前と
 * 末尾の `\` の並びを二重にし、`"` を `\"` にして囲む。
 */
export function windowsQuotedArgument(value) {
  const text = String(value);
  if (text.length === 0) return "\"\"";
  if (!/[ \t"]/u.test(text)) return text;
  if (!/["\\]/u.test(text)) return `"${text}"`;
  const reversed = [];
  let quoteHit = true;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const character = text[index];
    reversed.push(character);
    if (quoteHit && character === "\\") reversed.push("\\");
    else if (character === "\"") {
      quoteHit = true;
      reversed.push("\\");
    } else quoteHit = false;
  }
  return `"${reversed.reverse().join("")}"`;
}

/**
 * execFile(command, args) が Windows で作るコマンド行の長さ（UTF-16 の字数、終端の NUL を除く）。
 * libuv の make_program_args と同じく、argv[0]（command）も含めて引数ごとに quote して空白1つでつなぐ。
 */
export function windowsCommandLineLength(command, args = []) {
  return [command, ...args].reduce((sum, value, index) => sum + windowsQuotedArgument(value).length + (index > 0 ? 1 : 0), 0);
}

/** ffmpeg の実行系（{ command, args }）へ、この引数を足した呼び出しのコマンド行の長さ。 */
export function ffmpegCommandLineLength(ffmpeg, args = []) {
  return windowsCommandLineLength(ffmpeg?.command || "ffmpeg", [...(ffmpeg?.args || []), ...args]);
}

/**
 * filter_complex の渡し方を決める（書き込まない）。短ければ引数そのもの、長ければ dir の中のファイル
 * （graph の sha256 で名前を付ける）を指す引数。コマンド行の長さを先に測るときに使う。
 */
export function filterComplexPlan(ffmpeg, filterGraph, dir) {
  const graph = String(filterGraph);
  if (graph.length <= INLINE_FILTER_GRAPH_MAX) return { args: ["-filter_complex", graph], file: "", graph };
  const file = join(dir, `filter-graph-${createHash("sha256").update(graph).digest("hex").slice(0, 16)}.txt`);
  const major = ffmpegMajorVersion(ffmpeg);
  return { args: [major !== null && major < 7 ? "-filter_complex_script" : "-/filter_complex", file], file, graph };
}

/** filterComplexPlan の計画どおりに、長い graph をファイルへ書く。 */
export async function writeFilterComplexPlan(plan) {
  if (!plan?.file) return;
  await mkdir(dirname(plan.file), { recursive: true });
  await writeFile(plan.file, plan.graph, "utf8");
}

/** filter_complex の引数（短ければそのまま、長ければ dir へ書いたファイルを指す）。 */
export async function filterComplexArgs(ffmpeg, filterGraph, dir) {
  const plan = filterComplexPlan(ffmpeg, filterGraph, dir);
  await writeFilterComplexPlan(plan);
  return plan.args;
}
