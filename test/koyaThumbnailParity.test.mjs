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
  const actual = await runKoyaThumbnailParityCorpus({
    audit: auditKoyaThumbnailPlan,
    draft: createKoyaThumbnailPlanDraft,
    copySha256: koyaThumbnailCopySha256,
    subjectId: koyaThumbnailAssetQualitySubjectId,
    readAuthority: readKoyaChannelAuthority,
  }, { root });
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(golden).sort(), "入力の束の件数が golden と同じ");
  for (const key of Object.keys(golden)) {
    assert.deepEqual(actual[key], golden[key], `${key} の出力が寄せる前と違う`);
  }
  // 束が今の検査のほぼ全部を通っていること（数が減ると比較の意味が薄れる）。
  const failures = new Set(Object.values(golden).flatMap((entry) => entry.ok ? entry.value?.failures || [] : []));
  assert.ok(failures.size >= 30, `比べる失敗の文言が少なすぎる: ${failures.size}`);
});
