// Channel Pack の所在を解決する。
//
// このリポジトリは PUBLIC なプラグイン配布リポジトリなので、個々の
// チャンネルのデータ（番組名、キャスト、承認記録）を追跡しない。
// ハーネスはジャンル共通で、チャンネル固有のものは pack として外に置く。
//
// 探す順序:
//   1. BUZZASSIST_CHANNEL_PACK が指すディレクトリ
//   2. <projectDir>/channel-packs/<packId>/ 配下の同じ相対パス
//   3. <projectDir>/ 直下の従来パス（移行前の配置。当面は読めるままにする）
//
// 3を残しているのは、移行の途中で「ファイルが無い」と落ちるより、
// 古い場所からでも読めた方が安全なため。ただし追跡はしない。

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const DEFAULT_PACK_ID = process.env.BUZZASSIST_CHANNEL_PACK_ID || "koya";

export function channelPackRoots(projectDir, packId = DEFAULT_PACK_ID) {
  const roots = [];
  if (process.env.BUZZASSIST_CHANNEL_PACK) {
    roots.push(resolve(process.env.BUZZASSIST_CHANNEL_PACK));
  }
  roots.push(join(resolve(projectDir), "channel-packs", packId));
  return roots;
}

/**
 * pack 内の相対パスを解決する。見つからなければ従来の projectDir 直下を返す
 * ——呼び出し側が「無い」ことを自分のやり方で扱えるように、パスは必ず返す。
 */
export function resolveChannelPackPath(projectDir, relativePath, packId = DEFAULT_PACK_ID) {
  for (const root of channelPackRoots(projectDir, packId)) {
    const candidate = join(root, relativePath);
    if (existsSync(candidate)) return candidate;
  }
  return join(resolve(projectDir), relativePath);
}

/** pack が実際に置かれているか。設定漏れを早く気づけるようにする。 */
export function channelPackPresent(projectDir, packId = DEFAULT_PACK_ID) {
  return channelPackRoots(projectDir, packId).some((root) => existsSync(root));
}
