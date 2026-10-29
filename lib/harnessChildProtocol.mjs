import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { findHarnessDeclaration } from "./harnessDeclarationDirs.mjs";

export const CHILD_PROTOCOL = "buzzassist-child-v1";
export const CHILD_AUDIT_VERSION = "buzzassist-child-audit-v1";
export const CHILD_SIGNOFF_VERSION = "buzzassist-child-contact-sheet-signoff-v1";
export const CHILD_REVIEW_ATTESTATION_VERSION = "buzzassist-child-review-attestation-v1";

export function usesChildProtocol(declaration) {
  return declaration?.childProtocol === CHILD_PROTOCOL;
}

export function requiresVideoCompletionEvidence(declaration) {
  return usesChildProtocol(declaration) || /video/iu.test(String(declaration?.produces?.kind || ""));
}

// 通常確定も更新後確定も、現在の canonicalIdentity に束縛した宣言でだけ実行する。
// 更新後の旧契約の扱いは videoHarnessUpdateFinalize が別に担う。
export function assertJobHarnessDeclaration(job, record, { requireCanonical = false } = {}) {
  const planned = job?.canonicalIdentity?.harnessDeclaration;
  const expectedSha = planned?.sha256 || job?.harness?.declarationSha256;
  let samePath = !planned?.path;
  try { if (planned?.path && record) samePath = realpathSync.native(record.path) === realpathSync.native(resolve(planned.path)); } catch { /* drift */ }
  if ((requireCanonical && !planned) || (planned && (!planned.path || !planned.sha256))
    || (expectedSha && (!record || createHash("sha256").update(record.bytes).digest("hex") !== expectedSha))
    || !samePath) {
    throw new Error("canonical-identity-drift: harness declaration path or SHA changed after planning");
  }
}

export function requiresChildScriptQuality(declaration) {
  return usesChildProtocol(declaration)
    && Array.isArray(declaration.requiresFromOperator)
    && declaration.requiresFromOperator.some((row) => row?.id === "script-quality-acceptance");
}

// 解決先を毎回照らす。計画後の env の切替や宣言の差し替えで別の契約を実行させない。
export function jobHarnessDeclaration(job, options = {}) {
  const record = findHarnessDeclaration(job?.harness?.id, options);
  assertJobHarnessDeclaration(job, record);
  return record?.declaration || null;
}
