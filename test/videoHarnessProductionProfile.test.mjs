import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SKILL_APPROVAL_RECORD_VERSION,
  SKILL_APPROVAL_REQUIREMENT_ENV,
  assertVideoHarnessProductionProfile,
  skillApprovalCheckout,
  skillApprovalRequired,
} from "../lib/videoHarnessProductionProfile.mjs";
import { loadSkillPolicyManifests } from "../lib/skillInventory.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

// 実際のハーネス宣言と在庫 manifest を使う。合成の manifest だと「在庫の SHA が
// 古い」「宣言のスキルが在庫に無い」の経路を通らず、承認だけを見た気になる。
function koyaJob(repoRoot = root) {
  const declaration = JSON.parse(readFileSync(join(root, "config/harnesses/koya-manga-video.harness.json"), "utf8"));
  return {
    harness: {
      id: declaration.id,
      canonicalSkills: declaration.canonicalSkills.map((path) => ({ path: join(repoRoot, path) })),
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
      bundleSha256: skill.bundleSha256,
      attestedBy: "human-verified",
    };
    mutate?.(skill);
  }
  return async () => policy;
}

const staleApprovals = () => policyWithApprovals((skill) => { skill.approval.contentSha256 = `sha256:${"0".repeat(64)}`; });

test("本番の記録は、宣言された全スキルの承認状態と版を毎回持つ", async () => {
  const profile = await assertVideoHarnessProductionProfile({ job: koyaJob(), repoRoot: root, env: { [SKILL_APPROVAL_REQUIREMENT_ENV]: "0" } });
  assert.ok(profile.declaredSkills.length > 0);
  for (const row of profile.declaredSkills) {
    assert.ok(["current", "stale", "none"].includes(row.approvalState), `${row.id}: 承認状態が記録されていない`);
    assert.match(row.version, /^\d+\.\d+\.\d+/u, `${row.id}: 版が記録されていない`);
  }
  assert.equal(profile.skillApproval.version, SKILL_APPROVAL_RECORD_VERSION);
});

test("配布された写しでは、未承認のスキルがあれば本番は止まり、外すのは明示の 0 だけ", async () => {
  // 運営者の決定（2026-09-24、2026-09-26 に配布された写しに限った）: 未承認なら止める。
  // 今の版と SHA に承認が付いていれば既定で通る。
  const distributed = { checkout: "distributed" };
  const approved = await assertVideoHarnessProductionProfile({ job: koyaJob(), repoRoot: root, loadPolicy: await policyWithApprovals(), env: {}, ...distributed });
  assert.ok(approved.declaredSkills.every((row) => row.approvalState === "current"), "承認が今の版に付いていれば current と記録すること");
  assert.deepEqual(approved.skillApproval, { version: SKILL_APPROVAL_RECORD_VERSION, checkout: "distributed", builtWithUnapprovedSkills: false, unapprovedSkills: [] });

  // 承認が古い（内容が変わった）と、既定では止まる。"0" のときだけ通す。
  const loadPolicy = await staleApprovals();
  await assert.rejects(
    () => assertVideoHarnessProductionProfile({ job: koyaJob(), repoRoot: root, loadPolicy, env: {}, ...distributed }),
    /has no human approval bound to its current content/u,
  );
  await assert.rejects(
    () => assertVideoHarnessProductionProfile({ job: koyaJob(), repoRoot: root, loadPolicy, env: { [SKILL_APPROVAL_REQUIREMENT_ENV]: "false" }, ...distributed }),
    /has no human approval/u,
    "\"false\" や空を許可と読まない",
  );
  const relaxed = await assertVideoHarnessProductionProfile({ job: koyaJob(), repoRoot: root, loadPolicy, env: { [SKILL_APPROVAL_REQUIREMENT_ENV]: "0" }, ...distributed });
  assert.ok(relaxed.declaredSkills.every((row) => row.approvalState === "stale"), "外したときも承認状態は記録に残ること");
  assert.equal(relaxed.skillApproval.builtWithUnapprovedSkills, true, "外して作ったことも記録に残ること");

  // 版だけ上がって承認が前の版のまま、も止まる。
  const bumped = await policyWithApprovals((skill) => { skill.approval.version = "0.0.0"; });
  await assert.rejects(
    () => assertVideoHarnessProductionProfile({ job: koyaJob(), repoRoot: root, loadPolicy: bumped, env: {}, ...distributed }),
    /has no human approval/u,
  );
});

test("開発用チェックアウトでは、承認前の正本スキルでも止めず、そのスキルの id・版・sha256 を記録する", async () => {
  // 運営者の決定（2026-09-26）: 人が確かめるのはリリースのときの1回。開発用チェックアウトの制作は止めない。
  const loadPolicy = await staleApprovals();
  const profile = await assertVideoHarnessProductionProfile({ job: koyaJob(), repoRoot: root, loadPolicy, env: {}, checkout: "development" });
  assert.equal(profile.skillApproval.checkout, "development");
  assert.equal(profile.skillApproval.builtWithUnapprovedSkills, true);
  assert.deepEqual(
    profile.skillApproval.unapprovedSkills,
    profile.declaredSkills.map(({ id, version, sha256, approvalState }) => ({ id, version, sha256, approvalState })),
    "承認前のスキルを、id・版・sha256・承認の状態で残す",
  );
  assert.ok(profile.skillApproval.unapprovedSkills.every((row) => /^[a-f0-9]{64}$/u.test(row.sha256) && row.approvalState === "stale"));
  // 記録に止めたかどうか（環境変数）は入れない。Job の同一性に入る値なので、env で Job が分かれないようにする。
  const relaxed = await assertVideoHarnessProductionProfile({ job: koyaJob(), repoRoot: root, loadPolicy, env: { [SKILL_APPROVAL_REQUIREMENT_ENV]: "0" }, checkout: "development" });
  assert.deepEqual(relaxed.skillApproval, profile.skillApproval);
  // 開発用チェックアウトでも、明示の "1" ならリリースと同じく止める。
  await assert.rejects(
    () => assertVideoHarnessProductionProfile({ job: koyaJob(), repoRoot: root, loadPolicy, env: { [SKILL_APPROVAL_REQUIREMENT_ENV]: "1" }, checkout: "development" }),
    /has no human approval/u,
  );
  // 承認が今の版に付いていれば、承認前のスキルは無いと記録する。
  const approved = await assertVideoHarnessProductionProfile({ job: koyaJob(), repoRoot: root, loadPolicy: await policyWithApprovals(), env: {}, checkout: "development" });
  assert.deepEqual(approved.skillApproval, { version: SKILL_APPROVAL_RECORD_VERSION, checkout: "development", builtWithUnapprovedSkills: false, unapprovedSkills: [] });
  // 在庫の SHA が古いのは承認とは別の不整合なので、開発用チェックアウトでも止める。
  const staleInventory = await policyWithApprovals((skill) => { skill.contentSha256 = `sha256:${"1".repeat(64)}`; });
  await assert.rejects(
    () => assertVideoHarnessProductionProfile({ job: koyaJob(), repoRoot: root, loadPolicy: staleInventory, env: {}, checkout: "development" }),
    /Production inventory SHA is stale/u,
  );
});

test("写しの種類は既定で repoRoot から決まる（.git と .claude/skills と .agents/skills が揃えば開発用）", async (t) => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "skill-approval-checkout-")));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  // 配布された写しの形: 正本スキルと在庫はあるが、.git もホストのアダプターも無い。
  const copy = join(tmp, "plugin");
  cpSync(join(root, ".agents", "skills"), join(copy, ".agents", "skills"), { recursive: true });
  assert.equal(skillApprovalCheckout(copy), "distributed");
  assert.equal(skillApprovalRequired({ env: {}, checkout: skillApprovalCheckout(copy) }), true);
  const loadPolicy = await staleApprovals();
  const policy = await loadPolicy();
  const copiedPolicy = async () => ({
    ...policy,
    inventoryPath: join(copy, ".agents", "skills", "inventory.manifest.json"),
    profilesPath: join(copy, ".agents", "skills", "profiles.manifest.json"),
  });
  await assert.rejects(
    () => assertVideoHarnessProductionProfile({ job: koyaJob(copy), repoRoot: copy, loadPolicy: copiedPolicy, env: {} }),
    /has no human approval/u,
    "配布された写しの既定は止める",
  );
  // 配布された写しは .agents/skills を持つ（setup-agents は .agents を写す）。.git だけ、または外した
  // .codex/skills が残っているだけでは開発用にしない。Claude Code が正本へ届く .claude/skills が要る。
  mkdirSync(join(copy, ".git"), { recursive: true });
  mkdirSync(join(copy, ".codex", "skills"), { recursive: true });
  assert.equal(skillApprovalCheckout(copy), "distributed", ".git と古い .codex/skills だけでは開発用にしない");
  // 同じ中身に開発用チェックアウトの印を置くと、既定で止めずに記録する。
  for (const marker of [".git", join(".claude", "skills"), join(".agents", "skills")]) mkdirSync(join(copy, marker), { recursive: true });
  assert.equal(skillApprovalCheckout(copy), "development");
  const profile = await assertVideoHarnessProductionProfile({ job: koyaJob(copy), repoRoot: copy, loadPolicy: copiedPolicy, env: {} });
  assert.equal(profile.skillApproval.checkout, "development");
  assert.equal(profile.skillApproval.builtWithUnapprovedSkills, true);
  await assert.rejects(
    () => assertVideoHarnessProductionProfile({ job: koyaJob(), repoRoot: root, env: {}, checkout: "elsewhere" }),
    /写しの種類が不正/u,
  );
});
