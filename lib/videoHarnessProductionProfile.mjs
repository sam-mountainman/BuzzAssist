import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateSkillForProfile,
  loadSkillPolicyManifests,
} from "./skillInventory.mjs";

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
    rows.push({ id: inventory.id, path, sha256: actualSha256, decision: decision.reason });
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
