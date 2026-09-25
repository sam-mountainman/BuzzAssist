// ナレーション物語の Job で、使う台本が台本の品質ループに合格している（または人がそのまま使うと認めた）ことを、
// 有料の処理の前に確かめる関門（ジャンル層。監査契約 buzzassist-narrated-story-audit-v8 から）。
//
// 答えは lib/scriptQualityLoop.mjs の scriptQualityVerdict、作業フォルダの決め方・止め方・次のコマンドは
// lib/scriptQualityUseGate.mjs（漫画と共通）。ここが持つのは、効力のある版と監査の id と、監査の記録の形だけ。
//
// 効力: v8 より前の監査契約で作った production の状態は、この関門を求めずに従来どおり確定する（確定は state の
// auditContractVersion の版で測る）。台本は Job の識別子に入るので、制作の途中で台本は変わらない。関門は
// 有料の処理を始める前（再開のたびにも）に問い、合格したときの答えを監査 scriptQualityAccepted に残す。

import { checkScriptQualityBeforeProduction } from "./scriptQualityUseGate.mjs";

export const NARRATED_SCRIPT_QUALITY_AUDIT_ID = "scriptQualityAccepted";
/** この関門が入った監査契約の版。宣言の保証 script-quality-accepted の inForceSince と同じ値（試験が一致を見る）。 */
export const NARRATED_SCRIPT_QUALITY_SINCE = "buzzassist-narrated-story-audit-v8";
/** 台本の品質ループのジャンル（lib/scriptQualityLoop.mjs の SCRIPT_QUALITY_GENRES）。 */
export const NARRATED_SCRIPT_QUALITY_GENRE = "narrated-story";

const CONTRACT = /^(?<series>.+)-v(?<number>\d+)$/u;

/** その監査契約でこの関門が効いているか。読めない・別系列の版は効いている側に倒す（欠落を免除にしない）。 */
export function narratedScriptQualityRequired(contractVersion) {
  const since = CONTRACT.exec(NARRATED_SCRIPT_QUALITY_SINCE).groups;
  const match = CONTRACT.exec(String(contractVersion || "").trim());
  if (!match || match.groups.series !== since.series) return true;
  return Number(match.groups.number) >= Number(since.number);
}

/**
 * 有料の処理の前の関門。合格でなければ pass: false と、knownRemainingIssues に載せる理由
 * （script-quality-required:<理由コード>）・次のコマンド（next）・監査の記録（check）を返す。
 * 効力の外の版では何も問わずに通す（check は applicable: false）。
 */
export async function gateNarratedScriptQuality({
  contractVersion,
  scriptPath,
  workDir,
  commandScriptPath = "",
  verdict,
} = {}) {
  if (!narratedScriptQualityRequired(contractVersion)) {
    return {
      required: false,
      pass: true,
      issues: [],
      next: [],
      check: { pass: true, detail: `not in force for ${contractVersion}`, applicable: false },
      summary: null,
    };
  }
  const gate = await checkScriptQualityBeforeProduction({
    workDir,
    scriptPath,
    genre: NARRATED_SCRIPT_QUALITY_GENRE,
    commandScriptPath,
    ...(verdict ? { verdict } : {}),
  });
  const summary = {
    reasonCode: gate.reasonCode,
    acceptedBy: gate.acceptedBy,
    scriptSha256: gate.scriptSha256,
    workDir: gate.workDir,
    next: gate.next,
  };
  return {
    required: true,
    pass: gate.pass,
    issues: gate.issues,
    next: gate.next,
    check: {
      pass: gate.pass,
      detail: gate.pass
        ? `script accepted before paid work (${gate.acceptedBy}: ${gate.reasonCode})`
        : `script not accepted: ${gate.reasonCode}`,
      applicable: true,
      scriptQuality: gate.evidence,
    },
    summary,
  };
}
