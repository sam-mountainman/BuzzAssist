import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SKILL_APPROVAL_REQUIREMENT_ENV,
  assertVideoHarnessProductionProfile,
} from "../lib/videoHarnessProductionProfile.mjs";
import { loadSkillPolicyManifests } from "../lib/skillInventory.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

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

test("未承認のスキルがあれば本番は止まり、外すのは明示の 0 だけ", async () => {
  // 運営者の決定（2026-09-24）: 未承認なら止める。6 本の承認が記録済みなので、既定で通ること。
  const strict = await assertVideoHarnessProductionProfile({ job: koyaJob(), repoRoot: root, env: {} });
  assert.ok(strict.declaredSkills.every((row) => row.approvalState === "current"), "宣言された全スキルが人の承認に束縛されていること");

  // 在庫の承認が古い（内容が変わった）と、既定では止まる。"0" のときだけ通す。
  const policy = await loadSkillPolicyManifests(root);
  const stale = structuredClone(policy);
  for (const skill of stale.inventory.skills) if (skill.approval) skill.approval.contentSha256 = "sha256:" + "0".repeat(64);
  const loadPolicy = async () => stale;
  await assert.rejects(
    () => assertVideoHarnessProductionProfile({ job: koyaJob(), repoRoot: root, loadPolicy, env: {} }),
    /has no human approval bound to its current content/u,
  );
  await assert.rejects(
    () => assertVideoHarnessProductionProfile({ job: koyaJob(), repoRoot: root, loadPolicy, env: { [SKILL_APPROVAL_REQUIREMENT_ENV]: "false" } }),
    /has no human approval/u,
    "\"false\" や空を許可と読まない",
  );
  const relaxed = await assertVideoHarnessProductionProfile({ job: koyaJob(), repoRoot: root, loadPolicy, env: { [SKILL_APPROVAL_REQUIREMENT_ENV]: "0" } });
  assert.ok(relaxed.declaredSkills.every((row) => row.approvalState === "stale"), "外したときも承認状態は記録に残ること");
});
