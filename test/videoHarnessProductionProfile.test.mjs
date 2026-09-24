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

// 承認の記録そのものは人の手番で、正本を直した直後は必ず古くなる。試験がリポジトリの
// 実際の承認状態に依存すると、スキルを1本直すたびに承認が付くまで CI が赤くなる
// （2026-09-24 に Job 層の試験が 37 件落ちた）。承認が今の版に付いているかは Release の
// 公開前ゲート（npm run skills:check:release）が見る。ここでは実際の宣言と在庫の上に、
// 承認だけを合成して、ゲートの振る舞いを確かめる。
async function policyWithApprovals(mutate) {
  const policy = structuredClone(await loadSkillPolicyManifests(root));
  for (const skill of policy.inventory.skills) {
    skill.approval = {
      reviewer: "test-reviewer",
      approvedAt: "2026-09-24T00:00:00.000Z",
      version: skill.version,
      contentSha256: skill.contentSha256,
      attestedBy: "human-verified",
    };
    mutate?.(skill);
  }
  return async () => policy;
}

test("本番の記録は、宣言された全スキルの承認状態を毎回持つ", async () => {
  const profile = await assertVideoHarnessProductionProfile({ job: koyaJob(), repoRoot: root, env: { [SKILL_APPROVAL_REQUIREMENT_ENV]: "0" } });
  assert.ok(profile.declaredSkills.length > 0);
  for (const row of profile.declaredSkills) {
    assert.ok(["current", "stale", "none"].includes(row.approvalState), `${row.id}: 承認状態が記録されていない`);
  }
});

test("未承認のスキルがあれば本番は止まり、外すのは明示の 0 だけ", async () => {
  // 運営者の決定（2026-09-24）: 未承認なら止める。今の版と SHA に承認が付いていれば既定で通る。
  const approved = await assertVideoHarnessProductionProfile({ job: koyaJob(), repoRoot: root, loadPolicy: await policyWithApprovals(), env: {} });
  assert.ok(approved.declaredSkills.every((row) => row.approvalState === "current"), "承認が今の版に付いていれば current と記録すること");

  // 承認が古い（内容が変わった）と、既定では止まる。"0" のときだけ通す。
  const loadPolicy = await policyWithApprovals((skill) => { skill.approval.contentSha256 = "sha256:" + "0".repeat(64); });
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

  // 版だけ上がって承認が前の版のまま、も止まる。
  const bumped = await policyWithApprovals((skill) => { skill.approval.version = "0.0.0"; });
  await assert.rejects(
    () => assertVideoHarnessProductionProfile({ job: koyaJob(), repoRoot: root, loadPolicy: bumped, env: {} }),
    /has no human approval/u,
  );
});
