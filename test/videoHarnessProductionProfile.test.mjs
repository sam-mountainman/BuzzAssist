import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  SKILL_APPROVAL_REQUIREMENT_ENV,
  assertVideoHarnessProductionProfile,
} from "../lib/videoHarnessProductionProfile.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);

// 実際のハーネス宣言と在庫 manifest を使う。合成の manifest だと「在庫の SHA が
// 古い」「宣言のスキルが在庫に無い」の経路を通らず、承認だけを見た気になる。
function koyaJob() {
  const declaration = JSON.parse(readFileSync(join(root, "config/harnesses/koya-manga-video.harness.json"), "utf8"));
  return {
    harness: {
      id: declaration.id,
      canonicalSkills: declaration.canonicalSkills.map((path) => ({ path: join(root, path) })),
    },
    options: {},
  };
}

test("本番の記録は、宣言された全スキルの承認状態を毎回持つ", async () => {
  const profile = await assertVideoHarnessProductionProfile({ job: koyaJob(), repoRoot: root, env: {} });
  assert.ok(profile.declaredSkills.length > 0);
  for (const row of profile.declaredSkills) {
    assert.ok(["current", "stale", "none"].includes(row.approvalState), `${row.id}: 承認状態が記録されていない`);
  }
});

test("承認を本番の条件にするのは環境変数で切り替え、未承認のスキルがあれば止まる", async () => {
  // いまはどのスキルも未承認。既定では記録するだけで止めない（止めると本番が全部止まる）。
  const relaxed = await assertVideoHarnessProductionProfile({ job: koyaJob(), repoRoot: root, env: {} });
  const unapproved = relaxed.declaredSkills.filter((row) => row.approvalState !== "current");
  if (unapproved.length === 0) {
    // 全部承認済みなら、止める側でも通ること。
    await assertVideoHarnessProductionProfile({ job: koyaJob(), repoRoot: root, env: { [SKILL_APPROVAL_REQUIREMENT_ENV]: "1" } });
    return;
  }
  await assert.rejects(
    () => assertVideoHarnessProductionProfile({ job: koyaJob(), repoRoot: root, env: { [SKILL_APPROVAL_REQUIREMENT_ENV]: "1" } }),
    /has no human approval bound to its current content/u,
  );
  // "1" 以外は止めない（"true" や空を許可と読まない）。
  await assertVideoHarnessProductionProfile({ job: koyaJob(), repoRoot: root, env: { [SKILL_APPROVAL_REQUIREMENT_ENV]: "true" } });
});
