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
  return channelPackRootEntries(projectDir, packId).map((entry) => entry.root);
}

/**
 * 探索順の各ルートを、それが何なのかの区別つきで返す。
 * fixture を「pack がある」と同じ顔で返してしまうと、上流が実データと
 * 合成データを見分けられない——実際それで、pack を持たない環境の本番が
 * サンプルのキャストで走り、監査には project 正本と記録される穴が空いた。
 */
export function channelPackRootEntries(projectDir, packId = DEFAULT_PACK_ID) {
  const base = resolve(projectDir);
  const entries = [];
  if (process.env.BUZZASSIST_CHANNEL_PACK) {
    entries.push({ root: resolve(process.env.BUZZASSIST_CHANNEL_PACK), kind: "env" });
  }
  entries.push({ root: join(base, "channel-packs", packId), kind: "pack" });
  entries.push({ root: join(base, "test", "fixtures", "channel-pack"), kind: "fixture" });
  return entries;
}

/**
 * pack 内の相対パスを、どの層で見つかったかと一緒に解決する。
 * 見つからなければ従来の projectDir 直下を kind:"legacy" で返す
 * ——呼び出し側が「無い」ことを自分のやり方で扱えるように、パスは必ず返す。
 */
export function resolveChannelPackSource(projectDir, relativePath, packId = DEFAULT_PACK_ID) {
  for (const entry of channelPackRootEntries(projectDir, packId)) {
    const candidate = join(entry.root, relativePath);
    if (existsSync(candidate)) return { path: candidate, kind: entry.kind, root: entry.root };
  }
  return { path: join(resolve(projectDir), relativePath), kind: "legacy", root: resolve(projectDir) };
}

export function resolveChannelPackPath(projectDir, relativePath, packId = DEFAULT_PACK_ID) {
  return resolveChannelPackSource(projectDir, relativePath, packId).path;
}

/**
 * 本物の pack が置かれているか。合成 fixture は数えない——
 * 「pack がある」は「実データがある」と同義でなければ、
 * 実データ前提の検証がフォールバックの上で走って誤判定する。
 */
export function channelPackPresent(projectDir, packId = DEFAULT_PACK_ID) {
  return channelPackRootEntries(projectDir, packId)
    .filter((entry) => entry.kind !== "fixture")
    .some((entry) => existsSync(entry.root));
}
