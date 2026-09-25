/**
 * FFmpeg の filter_complex を、長ければファイルで渡す（共有層）。
 *
 * 1本の引数の長さには上限がある（Linux は 1 引数 128KiB、Windows はコマンド行全体で 32,767 字）。
 * 場面ごとにカメラの式を書く graph は場面の数に比例して伸びるので、長い台本では引数に入らない。
 * 長い graph はファイルへ書き、FFmpeg 7 以降は `-/filter_complex <file>`、それより前は
 * `-filter_complex_script <file>` で渡す（7 で前者が入り、後者は非推奨になった。固定版の 9 系は前者だけ）。
 * 版が読めない build（git の版名など）は新しい方とみなす。
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** これより短い graph は引数でそのまま渡す（Windows のコマンド行の上限より十分小さく）。 */
export const INLINE_FILTER_GRAPH_MAX = 8_000;

export function ffmpegMajorVersion(ffmpeg) {
  const match = /^(\d+)\./u.exec(String(ffmpeg?.version || "").trim());
  return match ? Number(match[1]) : null;
}

/** filter_complex の引数（短ければそのまま、長ければ dir へ書いたファイルを指す）。 */
export async function filterComplexArgs(ffmpeg, filterGraph, dir) {
  const graph = String(filterGraph);
  if (graph.length <= INLINE_FILTER_GRAPH_MAX) return ["-filter_complex", graph];
  await mkdir(dir, { recursive: true });
  const file = join(dir, `filter-graph-${createHash("sha256").update(graph).digest("hex").slice(0, 16)}.txt`);
  await writeFile(file, graph, "utf8");
  const major = ffmpegMajorVersion(ffmpeg);
  return major !== null && major < 7 ? ["-filter_complex_script", file] : ["-/filter_complex", file];
}
