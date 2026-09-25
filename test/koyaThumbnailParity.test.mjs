// 漫画（Koya）のサムネの計画・検査を、ジャンル共通の層（lib/thumbnailPlan.mjs）へ寄せても出力が変わらないこと。
//
// test/fixtures/koya-thumbnail-parity.golden.json は、寄せる前の実装（lib/koyaChannelGovernance.mjs の
// auditKoyaThumbnailPlan / createKoyaThumbnailPlanDraft / koyaThumbnailCopySha256 /
// koyaThumbnailAssetQualitySubjectId）に同じ入力の束（test/helpers/koyaThumbnailParityCorpus.mjs）を通して
// 書き出したもの。検査の結果・失敗の文言と順番・警告・下書き・文言の SHA・品質ループの対象 id・例外の文言を、
// 全部そのまま比べる。漫画の検査を意図して変えるときは、この golden を作り直し、差分を人が読んでから入れる。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditKoyaThumbnailPlan,
  createKoyaThumbnailPlanDraft,
  koyaThumbnailAssetQualitySubjectId,
  koyaThumbnailCopySha256,
  readKoyaChannelAuthority,
} from "../lib/koyaChannelGovernance.mjs";
import { runKoyaThumbnailParityCorpus } from "./helpers/koyaThumbnailParityCorpus.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("漫画のサムネの検査・下書き・文言の SHA・対象 id は、共通層へ寄せる前と同じ出力になる", async () => {
  const golden = JSON.parse(await readFile(join(root, "test", "fixtures", "koya-thumbnail-parity.golden.json"), "utf8"));
  // golden は合成の fixture の契約で書き出した。開発機のように本物の Channel Pack が
  // channel-packs/ にあると、そちらの契約で測って出力が変わる。存在しない pack id を明示して
  // fixture へ落とす（本物の Pack は読まない）。
  const saved = { id: process.env.BUZZASSIST_CHANNEL_PACK_ID, pack: process.env.BUZZASSIST_CHANNEL_PACK };
  process.env.BUZZASSIST_CHANNEL_PACK_ID = "thumbnail-parity-fixture-only";
  delete process.env.BUZZASSIST_CHANNEL_PACK;
  let actual;
  try {
    actual = await runKoyaThumbnailParityCorpus({
      audit: auditKoyaThumbnailPlan,
      draft: createKoyaThumbnailPlanDraft,
      copySha256: koyaThumbnailCopySha256,
      subjectId: koyaThumbnailAssetQualitySubjectId,
      readAuthority: readKoyaChannelAuthority,
    }, { root });
  } finally {
    if (saved.id === undefined) delete process.env.BUZZASSIST_CHANNEL_PACK_ID;
    else process.env.BUZZASSIST_CHANNEL_PACK_ID = saved.id;
    if (saved.pack !== undefined) process.env.BUZZASSIST_CHANNEL_PACK = saved.pack;
  }
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(golden).sort(), "入力の束の件数が golden と同じ");
  for (const key of Object.keys(golden)) {
    assert.deepEqual(maskScalerHashes(actual[key]), maskScalerHashes(golden[key]), `${key} の出力が寄せる前と違う`);
  }
  // 束が今の検査のほぼ全部を通っていること（数が減ると比較の意味が薄れる）。
  const failures = new Set(Object.values(golden).flatMap((entry) => entry.ok ? entry.value?.failures || [] : []));
  assert.ok(failures.size >= 30, `比べる失敗の文言が少なすぎる: ${failures.size}`);
});

/**
 * 32×32 に縮小した灰色の画素の SHA（normalizedGray32Sha256）は、ffmpeg の縮小の実装に依る。
 * golden は macOS の ffmpeg で書き出したもので、CI の Ubuntu・Windows の ffmpeg では値が変わる
 * （2026-09-25 の CI）。使い回しの判定（距離と失敗の文言）はそのまま比べ、この SHA は形だけを見る。
 */
function maskScalerHashes(value) {
  // 失敗の文言に入る距離の数値も縮小の実装に依る（macOS 0.0000 / Ubuntu 0.0098）。判定の有無と文言の形は比べる。
  if (typeof value === "string") return value.replace(/distance=\d+(?:\.\d+)?/gu, "distance=<n>");
  if (Array.isArray(value)) return value.map(maskScalerHashes);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      key === "normalizedGray32Sha256" && /^[a-f0-9]{64}$/u.test(String(entry)) ? "<sha256>" : maskScalerHashes(entry),
    ]));
  }
  return value;
}
