import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readsCanonicalDirectly } from "./hostSkillSync.mjs";
import {
  evaluateSkillForProfile,
  loadSkillPolicyManifests,
  skillApprovalState,
} from "./skillInventory.mjs";

// 正本スキルの人の承認。承認は在庫 manifest の approval 欄で、版と内容 SHA に束縛されている
// （skill-inventory --approve、承認者本人の端末から。機械は記録できない）。
//
// 運営者の決定（2026-09-26）: 人が確かめるのは、運営者へ配る版（GitHub Release）を出すときの1回
// だけにする（npm run skills:check:release と release.yml の関門）。だから止める場所を写しの種類で分ける:
//
//   - 配布された写し（運営者のパソコンに入ったプラグイン。開発用チェックアウトでない）: 今までどおり、
//     承認が今の版と内容 SHA に付いていなければ止める。Release は承認済みの版しか出ないので、普通は止まらない
//   - 開発用チェックアウト（.git と .claude/skills と .agents/skills がある。lib/hostSkillSync.mjs の
//     readsCanonicalDirectly と同じ判定）: 止めない。代わりに「承認前の正本スキルで作った」ことと、
//     そのスキルの id・版・sha256 を Job の記録（canonicalIdentity.productionProfile.skillApproval）に残し、
//     RunReceipt の skillApproval 欄へ写す
//
// BUZZASSIST_REQUIRE_SKILL_APPROVAL: 未設定・空なら上の既定。"0" は止めない（今までどおりの開発用の外し方）。
// それ以外の値（"1" など）はどちらの写しでも止める（開発用チェックアウトでリリースと同じ振る舞いを試すとき）。
// "false" のような値を「外す」とは読まない。
const MODULE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export const SKILL_APPROVAL_REQUIREMENT_ENV = "BUZZASSIST_REQUIRE_SKILL_APPROVAL";
export const SKILL_APPROVAL_RECORD_VERSION = "buzzassist-skill-approval-record-v1";

/** 写しの種類。開発用チェックアウトか、配布された写しか。 */
export function skillApprovalCheckout(repoRoot = MODULE_ROOT) {
  return readsCanonicalDirectly(resolve(repoRoot)) ? "development" : "distributed";
}

/** 未承認の正本スキルで止めるか。env の明示が既定（写しの種類）に勝つ。 */
export function skillApprovalRequired({ env = process.env, checkout = "distributed" } = {}) {
  const value = String(env?.[SKILL_APPROVAL_REQUIREMENT_ENV] ?? "").trim();
  if (value === "0") return false;
  if (value) return true;
  return checkout !== "development";
}

export const VIDEO_HARNESS_PRODUCTION_PROFILE = "operator-production";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Enforce the operator profile at both durable-job and service boundaries.
 * The result is hashable evidence, not a mutable set of globally installed
 * tools: production is allowed only to use each Harness's declared skills.
 */
export async function assertVideoHarnessProductionProfile({
  job,
  repoRoot = MODULE_ROOT,
  loadPolicy = loadSkillPolicyManifests,
  env = process.env,
  checkout = skillApprovalCheckout(repoRoot),
} = {}) {
  if (checkout !== "development" && checkout !== "distributed") throw new Error(`写しの種類が不正: ${checkout}`);
  const approvalRequired = skillApprovalRequired({ env, checkout });
  if (!job?.harness?.id) throw new Error("Production profile requires a selected Harness Job.");
  if (job.executionProfile && job.executionProfile !== VIDEO_HARNESS_PRODUCTION_PROFILE) {
    throw new Error(`Video Harness production cannot run under profile ${job.executionProfile}.`);
  }
  for (const optionName of ["profileId", "skillProfile", "executionProfile"]) {
    const requested = typeof job.options?.[optionName] === "string" ? job.options[optionName].trim() : "";
    if (requested && requested !== VIDEO_HARNESS_PRODUCTION_PROFILE) {
      throw new Error(`Video Harness production cannot override ${optionName}=${requested}.`);
    }
  }
  const policy = await loadPolicy(resolve(repoRoot));
  const declaredSkills = Array.isArray(job.harness.canonicalSkills) ? job.harness.canonicalSkills : [];
  if (declaredSkills.length === 0) throw new Error(`Harness ${job.harness.id} declares no canonical production skill.`);
  const inventoryByPath = new Map((policy.inventory.skills || []).map((skill) => [
    resolve(repoRoot, skill.canonicalPath),
    skill,
  ]));
  const rows = [];
  for (const declared of declaredSkills) {
    const path = resolve(String(declared.path || ""));
    const inventory = inventoryByPath.get(path);
    if (!inventory) throw new Error(`Canonical skill is absent from the production inventory: ${declared.path || declared.id || "(missing)"}.`);
    if (inventory.classification?.productionAllowed !== true || inventory.classification?.developmentOnly === true) {
      throw new Error(`Skill ${inventory.id} is not classified for production.`);
    }
    const decision = evaluateSkillForProfile(
      inventory.id,
      VIDEO_HARNESS_PRODUCTION_PROFILE,
      policy.profiles,
      { declaredSkillIds: declaredSkills.map((entry) => inventoryByPath.get(resolve(String(entry.path || "")))?.id).filter(Boolean) },
    );
    if (!decision.allowed) throw new Error(`Skill ${inventory.id} is denied by ${VIDEO_HARNESS_PRODUCTION_PROFILE}: ${decision.reason}.`);
    const actualSha256 = digest(await readFile(path));
    if (declared.sha256 && declared.sha256 !== actualSha256) throw new Error(`Canonical skill changed after Job planning: ${inventory.id}.`);
    if (inventory.contentSha256 !== `sha256:${actualSha256}`) throw new Error(`Production inventory SHA is stale for ${inventory.id}.`);
    // 承認の状態は毎回記録する。止めるかどうかは写しの種類と環境変数で決める。
    const approvalState = skillApprovalState(inventory, `sha256:${actualSha256}`);
    if (approvalState !== "current" && approvalRequired) {
      throw new Error(`Skill ${inventory.id} ${inventory.version} has no human approval bound to its current content (${approvalState}); record one with scripts/skill-inventory.mjs --approve from the approver's terminal.`);
    }
    rows.push({ id: inventory.id, version: inventory.version, path, sha256: actualSha256, decision: decision.reason, approvalState });
  }
  rows.sort((left, right) => left.id.localeCompare(right.id));
  // 止めなかった未承認の正本スキル。Job の同一性に入る値なので、環境変数（止めたかどうか）は入れず、
  // 写しの種類と、どのスキルのどの版・内容だったかだけを残す。
  const unapprovedSkills = rows
    .filter((row) => row.approvalState !== "current")
    .map(({ id, version, sha256, approvalState }) => ({ id, version, sha256, approvalState }));
  return {
    profileId: VIDEO_HARNESS_PRODUCTION_PROFILE,
    inventoryManifestVersion: policy.inventory.manifestVersion,
    profilesManifestVersion: policy.profiles.manifestVersion,
    inventoryManifestSha256: digest(await readFile(policy.inventoryPath)),
    profilesManifestSha256: digest(await readFile(policy.profilesPath)),
    declaredSkills: rows,
    skillApproval: {
      version: SKILL_APPROVAL_RECORD_VERSION,
      checkout,
      builtWithUnapprovedSkills: unapprovedSkills.length > 0,
      unapprovedSkills,
    },
  };
}

/**
 * doctor 用の読むだけの検査。宣言の正本スキル（宣言が無ければ在庫の正本の本番スキル全部）のうち、人の承認が
 * 今の版と内容 SHA に付いていないものを並べる。止めるかどうかは Job の作成と同じ判定（写しの種類と env）。
 *
 * - 開発用チェックアウト: 止めない（doctor では advisory）。Job と RunReceipt に「承認前の正本で作った」と残る
 * - 配布された写し: 止める（ハーネスを指定した doctor では必須項目。Job の作成も同じ理由で止まる）
 */
export async function probeSkillApproval({
  repoRoot = MODULE_ROOT,
  env = process.env,
  declaration = null,
  checkout = skillApprovalCheckout(repoRoot),
  loadPolicy = loadSkillPolicyManifests,
} = {}) {
  const root = resolve(repoRoot);
  const enforced = skillApprovalRequired({ env, checkout });
  let policy;
  try {
    policy = await loadPolicy(root);
  } catch (error) {
    return { ok: false, enforced, checkout, checked: 0, unapprovedSkills: [], unreadable: String(error?.message || error).split("\n")[0].slice(0, 200) };
  }
  const declaredPaths = declaration
    ? new Set((declaration.canonicalSkills || []).map((entry) => resolve(root, String(entry || ""))))
    : null;
  // 宣言が無いとき（ハーネス未指定の doctor）は、リリースの関門（skills:check:release の
  // unapprovedProductionSkills）と同じ集合を見る: 正本（project-canonical）の本番スキル。
  const skills = (policy.inventory.skills || []).filter((skill) => (declaredPaths
    ? declaredPaths.has(resolve(root, skill.canonicalPath))
    : skill.origin === "project-canonical"
      && skill.classification?.productionAllowed === true && skill.classification?.developmentOnly !== true));
  const unapprovedSkills = [];
  for (const skill of skills) {
    let actual = "";
    try { actual = `sha256:${digest(await readFile(resolve(root, skill.canonicalPath)))}`; } catch { actual = ""; }
    const approvalState = skillApprovalState(skill, actual);
    if (approvalState !== "current") unapprovedSkills.push({ id: skill.id, version: skill.version, approvalState });
  }
  unapprovedSkills.sort((left, right) => left.id.localeCompare(right.id));
  return { ok: unapprovedSkills.length === 0, enforced, checkout, checked: skills.length, unapprovedSkills };
}
