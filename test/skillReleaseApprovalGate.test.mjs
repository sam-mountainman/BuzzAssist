// 運営者の決定（2026-09-26）: 正本スキルはエージェントも直してよく、人が確かめるのは運営者へ配る版を
// 出すときの1回。その1回（npm run skills:check:release = skill-inventory --require-approval）が、
// エージェントが直して在庫の SHA を更新した版を、人の承認なしには通さないことを確かめる。
// リポジトリの写しを一時ディレクトリへ作り、承認は合成する（実際の承認状態に試験を依存させない）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SKILL_INVENTORY_MANIFEST_PATH, skillApprovalState } from "../lib/skillInventory.mjs";
import { runSkillInventoryCli } from "../scripts/skill-inventory.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function stageRepository(t) {
  const copy = realpathSync(mkdtempSync(join(tmpdir(), "skill-release-gate-")));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  for (const entry of [".agents", join(".claude", "skills"), join(".codex", "skills"), ".claude-plugin", ".codex-plugin", "skills", "package.json"]) {
    if (existsSync(join(root, entry))) cpSync(join(root, entry), join(copy, entry), { recursive: true });
  }
  return copy;
}

function readManifest(copy) {
  return JSON.parse(readFileSync(join(copy, SKILL_INVENTORY_MANIFEST_PATH), "utf8"));
}

function writeManifest(copy, manifest) {
  writeFileSync(join(copy, SKILL_INVENTORY_MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function releaseGate(copy, home) {
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const report = await runSkillInventoryCli(["--project-dir", copy, "--require-approval", "--json"], { env: {}, homeDir: home });
    return { report, exitCode: process.exitCode };
  } finally {
    process.stdout.write = originalWrite;
    process.exitCode = 0;
  }
}

test("エージェントが正本を直して在庫の SHA を更新しても、リリースの関門は人の承認が付くまで止める", async (t) => {
  const copy = stageRepository(t);
  const home = realpathSync(mkdtempSync(join(tmpdir(), "skill-release-gate-home-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  // 出発点: 正本の本番スキルすべてに、今の版と内容への人の承認が付いている（合成の承認者）。
  const manifest = readManifest(copy);
  for (const skill of manifest.skills) {
    if (skill.origin !== "project-canonical" || skill.classification?.productionAllowed !== true) continue;
    skill.approval = { reviewer: "synthetic-approver", approvedAt: "2026-09-26T00:00:00.000Z", version: skill.version, contentSha256: skill.contentSha256, attestedBy: "human-verified" };
  }
  writeManifest(copy, manifest);
  const approved = await releaseGate(copy, home);
  assert.deepEqual(approved.report.analysis.unapprovedProductionSkills, []);
  assert.notEqual(approved.exitCode, 4, "承認済みなのにリリースの関門で止まった");

  // エージェントが正本スキルを直し（差分の承認キューの approve か skill-creator の直接の編集）、
  // skill-creator の手順どおり在庫の contentSha256 を今の内容へ更新した。版は据え置き。
  const target = manifest.skills.find((skill) => skill.id === "buzzassist:platform-craft");
  const skillPath = join(copy, target.canonicalPath);
  const edited = `${readFileSync(skillPath, "utf8")}\n<!-- 合成の追記: エージェントが当てた変更 -->\n`;
  writeFileSync(skillPath, edited);
  const afterEdit = readManifest(copy);
  const entry = afterEdit.skills.find((skill) => skill.id === target.id);
  entry.contentSha256 = sha(edited);
  writeManifest(copy, afterEdit);
  assert.equal(skillApprovalState(entry), "stale", "承認は前の内容に束縛されたまま");

  const gated = await releaseGate(copy, home);
  assert.equal(gated.report.analysis.ok, true, "在庫の SHA は正本と一致している（整合の問題ではない）");
  assert.deepEqual(
    gated.report.analysis.unapprovedProductionSkills.map((row) => [row.id, row.approvalState]),
    [[target.id, "stale"]],
  );
  assert.equal(gated.exitCode, 4, "承認の無い版をリリースの関門が通した");

  // 機械が名乗った承認（human-verified でない）は、在庫そのものが壊れているとして読まない（fail-closed）。
  entry.approval = { reviewer: "agent", approvedAt: "2026-09-26T01:00:00.000Z", version: entry.version, contentSha256: entry.contentSha256, attestedBy: "agent-self-attested" };
  writeManifest(copy, afterEdit);
  await assert.rejects(() => releaseGate(copy, home), /attestedBy must be human-verified/u, "機械の申告を承認として通した");
});
