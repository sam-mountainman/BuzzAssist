// 試験の台本を「人がそのまま使うと認めた」ことにする（lib/scriptQualityLoop.mjs の acceptScriptAsHumanVerified を
// 本物の記録のまま使う）。人の確認の判定（scripts/harness-learn.mjs の attestationFor）だけを合成の確認に差し替える。
// 名前・理由はすべて合成の値。

import { dirname, resolve } from "node:path";

import { acceptScriptAsHumanVerified } from "../../lib/scriptQualityLoop.mjs";

export const SYNTHETIC_SCRIPT_REVIEWER = "synthetic-operator";

export function syntheticHumanAttestation({ reviewer }) {
  return { ok: true, attestation: { reviewer: reviewer || SYNTHETIC_SCRIPT_REVIEWER, attestedBy: "human-verified" } };
}

/** 台本のあるフォルダ（または workDir）の quality/ に、人がその台本をそのまま使うと認めた記録を書く。 */
export async function acceptScriptForTests(scriptPath, { workDir = "", reviewer = SYNTHETIC_SCRIPT_REVIEWER } = {}) {
  const full = resolve(scriptPath);
  return acceptScriptAsHumanVerified({
    workDir: workDir || dirname(full),
    scriptPath: full,
    reviewer,
    reason: "合成の試験の台本をそのまま使う",
    humanVerified: true,
    isInteractive: true,
    attest: syntheticHumanAttestation,
  });
}
