import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateSkillForProfile,
  loadSkillPolicyManifests,
  skillApprovalState,
} from "./skillInventory.mjs";

// 人の承認を本番の条件にするかどうか。承認は在庫 manifest の approval 欄で、版と
// 内容 SHA に束縛されている（skill-inventory --approve）。既定は「記録するだけ」——
// 運営者の決定（2026-09-24）は「未承認なら止める」だが、いまはどのスキルも未承認で、
// 既定を止めるにすると本番が全部止まる。承認を記録してから
// BUZZASSIST_REQUIRE_SKILL_APPROVAL=1 で止める側に切り替える。
export const SKILL_APPROVAL_REQUIREMENT_ENV = "BUZZASSIST_REQUIRE_SKILL_APPROVAL";
function skillApprovalRequired(env = process.env) {
  return String(env[SKILL_APPROVAL_REQUIREMENT_ENV] || "").trim() === "1";
}

export const VIDEO_HARNESS_PRODUCTION_PROFILE = "operator-production";
const MODULE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

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
} = {}) {
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
    // 承認の状態は毎回記録する。止めるかどうかは上の環境変数で決める。
    const approvalState = skillApprovalState(inventory, `sha256:${actualSha256}`);
    if (approvalState !== "current" && skillApprovalRequired(env)) {
      throw new Error(`Skill ${inventory.id} ${inventory.version} has no human approval bound to its current content (${approvalState}); record one with scripts/skill-inventory.mjs --approve from the approver's terminal.`);
    }
    rows.push({ id: inventory.id, path, sha256: actualSha256, decision: decision.reason, approvalState });
  }
  rows.sort((left, right) => left.id.localeCompare(right.id));
  return {
    profileId: VIDEO_HARNESS_PRODUCTION_PROFILE,
    inventoryManifestVersion: policy.inventory.manifestVersion,
    profilesManifestVersion: policy.profiles.manifestVersion,
    inventoryManifestSha256: digest(await readFile(policy.inventoryPath)),
    profilesManifestSha256: digest(await readFile(policy.profilesPath)),
    declaredSkills: rows,
  };
}
