import { createHash } from "node:crypto";
import { findHarnessDeclaration } from "./harnessDeclarationDirs.mjs";

export const CHILD_PROTOCOL = "buzzassist-child-v1";
export const CHILD_AUDIT_VERSION = "buzzassist-child-audit-v1";
export const CHILD_SIGNOFF_VERSION = "buzzassist-child-contact-sheet-signoff-v1";
export const CHILD_REVIEW_ATTESTATION_VERSION = "buzzassist-child-review-attestation-v1";

export function usesChildProtocol(declaration) {
  return declaration?.childProtocol === CHILD_PROTOCOL;
}

export function requiresChildScriptQuality(declaration) {
  return usesChildProtocol(declaration)
    && Array.isArray(declaration.requiresFromOperator)
    && declaration.requiresFromOperator.some((row) => row?.id === "script-quality-acceptance");
}

// 解決先を毎回照らす。計画後の env の切替や宣言の差し替えで別の契約を実行させない。
export function jobHarnessDeclaration(job, options = {}) {
  const record = findHarnessDeclaration(job?.harness?.id, options);
  const expected = job?.harness?.declarationSha256;
  if (expected && (!record || createHash("sha256").update(record.bytes).digest("hex") !== expected)) {
    throw new Error("canonical-identity-drift: harness declaration changed after planning");
  }
  return record?.declaration || null;
}
