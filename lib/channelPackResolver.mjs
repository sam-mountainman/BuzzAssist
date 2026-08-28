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

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * 既定の pack id。
 *
 * 以前はここに特定チャンネル由来の名前を直書きしていた。共有層が特定の
 * チャンネルを既定として知っているのは3層分離が崩れている状態で、
 * 運営者が増えるたびに「誰の pack が既定か」が暗黙になる。
 * 明示指定 → 実際に置かれている pack が1つならそれ、の順で決める。
 * 複数あるのに指定が無いときは、選ばせる（黙って1つを選ばない）。
 */
export function resolveDefaultPackId(projectDir = process.cwd()) {
  const explicit = String(process.env.BUZZASSIST_CHANNEL_PACK_ID || "").trim();
  if (explicit) return explicit;
  const packsRoot = join(resolve(projectDir), "channel-packs");
  if (!existsSync(packsRoot)) return "";
  const installed = readdirSync(packsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (installed.length === 1) return installed[0];
  if (installed.length > 1) {
    throw new Error(
      `Channel Pack が ${installed.length} 個ある（${installed.join(", ")}）。`
      + "どれを使うかを BUZZASSIST_CHANNEL_PACK_ID で明示すること"
      + "——黙って1つを選ぶと、別のチャンネルの番組ルールで本番が走る。",
    );
  }
  return "";
}

export const DEFAULT_PACK_ID = process.env.BUZZASSIST_CHANNEL_PACK_ID || "";

export function channelPackRoots(projectDir, packId = "") {
  return channelPackRootEntries(projectDir, packId).map((entry) => entry.root);
}

/**
 * 探索順の各ルートを、それが何なのかの区別つきで返す。
 * fixture を「pack がある」と同じ顔で返してしまうと、上流が実データと
 * 合成データを見分けられない——実際それで、pack を持たない環境の本番が
 * サンプルのキャストで走り、監査には project 正本と記録される穴が空いた。
 */
export function channelPackRootEntries(projectDir, packId = "") {
  const base = resolve(projectDir);
  const id = String(packId || "").trim() || resolveDefaultPackId(projectDir);
  const entries = [];
  if (process.env.BUZZASSIST_CHANNEL_PACK) {
    entries.push({ root: resolve(process.env.BUZZASSIST_CHANNEL_PACK), kind: "env" });
  }
  if (id) entries.push({ root: join(base, "channel-packs", id), kind: "pack" });
  entries.push({ root: join(base, "test", "fixtures", "channel-pack"), kind: "fixture" });
  return entries;
}

/**
 * pack 内の相対パスを、どの層で見つかったかと一緒に解決する。
 * 見つからなければ従来の projectDir 直下を kind:"legacy" で返す
 * ——呼び出し側が「無い」ことを自分のやり方で扱えるように、パスは必ず返す。
 */
export function resolveChannelPackSource(projectDir, relativePath, packId = "") {
  for (const entry of channelPackRootEntries(projectDir, packId)) {
    const candidate = join(entry.root, relativePath);
    if (existsSync(candidate)) return { path: candidate, kind: entry.kind, root: entry.root };
  }
  return { path: join(resolve(projectDir), relativePath), kind: "legacy", root: resolve(projectDir) };
}

export function resolveChannelPackPath(projectDir, relativePath, packId = "") {
  return resolveChannelPackSource(projectDir, relativePath, packId).path;
}

/**
 * 本物の pack が置かれているか。合成 fixture は数えない——
 * 「pack がある」は「実データがある」と同義でなければ、
 * 実データ前提の検証がフォールバックの上で走って誤判定する。
 */
/** 従来レイアウト（<project>/config/ 直下）に正本が揃っているか。 */
function legacyAuthorityPresent(projectDir) {
  const base = resolve(projectDir);
  return [
    "config/koya-show-bible.json",
    "config/koya-location-bible.json",
    "config/koya-thumbnail-contract.json",
  ].every((relative) => existsSync(join(base, relative)));
}

export function channelPackPresent(projectDir, packId = "") {
  const packRootPresent = channelPackRootEntries(projectDir, packId)
    .filter((entry) => entry.kind !== "fixture")
    .some((entry) => existsSync(entry.root));
  if (packRootPresent) return true;
  // handoff-restore は従来レイアウト（<project>/config/）へ書く。
  // pack ディレクトリだけを見ていたので、**復元に成功した直後に
  // doctor が「pack 未設置」と言う**状態だった。読み取り側
  // （resolveChannelPackPath）は従来パスへ落ちるので動きはするが、
  // 検査が嘘をつくと、運営者は何を直せばいいのか分からなくなる。
  return legacyAuthorityPresent(projectDir);
}
