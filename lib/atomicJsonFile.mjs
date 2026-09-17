// JSON ファイルの原子的な書き込みと、無ければ既定値を返す読み込み。
//
// なぜ canvasScene.mjs から切り出したか: ハーネスの実行系（Channel Pack の署名、
// 動画 Job、フィードバック bundle）がこの2つのためだけに canvasScene.mjs を読み、
// canvasScene.mjs は先頭で外部パッケージ（fractional-indexing）を読む。そのため
// 依存を入れていない配布プラグインから実行系を読み込めず、配布シミュレーションが
// 落ちていた。この2つは Node の標準機能だけで書けるので、外部依存を持たせない。
// canvasScene.mjs からも同じ名前で使える（再公開している）。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** 途中で落ちた書き込みが「完成したファイル」に見えないよう、temp → rename で書く。 */
export async function writeJsonAtomic(filePath, payload) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(payload, null, 2)}\n`);
  await rename(tempFile, filePath);
}

/** ファイルが無ければ fallback。壊れた JSON や権限エラーは投げる（無いことと区別する）。 */
export async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}
