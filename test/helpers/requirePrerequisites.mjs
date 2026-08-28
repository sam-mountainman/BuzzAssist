// テストの前提が手元に無いとき、落ちるのではなく「何が足りないか」を言って飛ばす。
//
// このリポジトリは公開されている配布物なので、clone しただけの人が
// テストを走らせる。チャンネル固有のデータや過去の成果物は運営者の手元に
// しか無いので、それを要求するテストはその環境では成立しない。
//
// 落ちるままにしておくと2つ困る。clone した人には「壊れている」ように見えるし、
// **本当の失敗が20件の常時赤に埋もれて見えなくなる**。実際そうなっていた。
//
// 飛ばす理由は必ず具体的に書く。「skip」だけだと、何を用意すれば走るのかが
// 分からず、そのテストは永久に走らないまま残る。

import { existsSync } from "node:fs";
import { join } from "node:path";

import { channelPackPresent } from "../../lib/channelPackResolver.mjs";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

/**
 * Channel Pack が要るテスト。
 * @returns true なら前提が揃っている。false なら呼び出し側が return する。
 */
export function requireChannelPack(t, what = "この検証") {
  if (channelPackPresent(REPO_ROOT)) return true;
  t.skip(`${what}には Channel Pack が要る（channel-packs/<id>/ を配置するか BUZZASSIST_CHANNEL_PACK を指定）`);
  return false;
}

/**
 * 過去の成果物（エピソードの manifest、レビュー記録など）が要るテスト。
 * @param paths リポジトリルートからの相対パス
 */
export function requireArtifacts(t, paths, what = "この検証") {
  const missing = paths.filter((rel) => !existsSync(join(REPO_ROOT, rel)));
  if (missing.length === 0) return true;
  t.skip(`${what}には運営者の手元にしかない成果物が要る: ${missing.join(", ")}`);
  return false;
}
