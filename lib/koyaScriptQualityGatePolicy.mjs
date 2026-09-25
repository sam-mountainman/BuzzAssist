// 漫画（koya-manga-video）の公式経路で、使う台本が台本の品質ループ（lib/scriptQualityLoop.mjs）に合格した版か、
// 人がそのまま使うと認めた版でなければ有料の処理を始めない規則の「純粋な部分」。契約の検査・効力の判定・
// 最終監査の判定（記録を読むだけ）を置く。実際に答えを問うのは lib/koyaMangaProduction.mjs（共通の入口は
// lib/scriptQualityUseGate.mjs）。
//
// このファイルは制作契約の検査（lib/koyaMangaProductionContract.mjs）からも読む。契約の検査は配布プラグインの
// 実行系（動画 Job → RunReceipt → 契約）からも読み込まれるので、ファイルを読む部品を import しない。
//
// 効力（inForceSince）: 契約 koya-manga-production-v56 から。それより前の版の契約で作った回（台本の答えを
// 問うていない回）は、最終監査で applicable: false として通す。漫画の台本は依頼者が書くので、通常は
// script-quality-loop.mjs accept-human（人がそのまま使うと認めた記録）で通る。直しを提案するならループを回す。

import { createHash } from "node:crypto";

export const KOYA_SCRIPT_QUALITY_GATE_VERSION = "koya-script-quality-gate-v1";
// この保証が入った契約の版。契約の同名項目・harness 宣言の inForceSince も同じ値（試験が一致を見る）。
export const KOYA_SCRIPT_QUALITY_IN_FORCE_SINCE = "koya-manga-production-v56";
/** 台本の品質ループのジャンル（lib/scriptQualityLoop.mjs の SCRIPT_QUALITY_GENRES）。 */
export const KOYA_SCRIPT_QUALITY_GENRE = "manga";
/** 最終監査の必須監査 id（契約 v56 から requiredAudits に要る）。 */
export const KOYA_SCRIPT_QUALITY_FINAL_AUDIT_ID = "script-quality-accepted";
/** 止めたときの error.code（full は人待ちの終了コード 3 に変える）。 */
export const KOYA_SCRIPT_QUALITY_REQUIRED_CODE = "KOYA_SCRIPT_QUALITY_REQUIRED";
/** full が人待ちで止まるときの status（Canvas の工程 DAG が「台本の確認」に対応付ける）。 */
export const KOYA_SCRIPT_QUALITY_PAUSE_STATUS = "awaiting-script-quality";
/** Koya の状態ファイルに残す記録の版。 */
export const KOYA_SCRIPT_QUALITY_RECORD_VERSION = "koya-script-quality-record-v1";

const CONTRACT_VERSION_PATTERN = /^(?<series>.+)-v(?<number>\d+)$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SECTION_KEYS = Object.freeze(["version", "inForceSince", "stage", "genre", "acceptedBy", "stopWithoutPaidGeneration"]);
/** 使ってよいと数える受け入れ方。契約はこれを減らせない（依頼者の台本を AI の点で止めないため、人の受け入れを外せない）。 */
export const KOYA_SCRIPT_QUALITY_ACCEPTED_BY = Object.freeze(["quality-loop", "human"]);
const ACCEPTED_REASON_CODES = Object.freeze({
  "quality-loop": "script-quality-passed",
  human: "script-quality-human-accepted",
});

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function seriesNumber(version) {
  const match = CONTRACT_VERSION_PATTERN.exec(text(version));
  return match ? { series: match.groups.series, number: Number(match.groups.number) } : null;
}

const IN_FORCE = seriesNumber(KOYA_SCRIPT_QUALITY_IN_FORCE_SINCE);

/**
 * この契約で台本の関門が効いているか。版で決める（節の有無では決めない）。版の無い部分的な契約
 * （試験の合成の契約）と別系列の契約は効力の外。
 */
export function koyaScriptQualityGateInForce(contractOrResolved) {
  const contract = contractOrResolved?.contract || contractOrResolved;
  const current = seriesNumber(contract?.version);
  return Boolean(current && current.series === IN_FORCE.series && current.number >= IN_FORCE.number);
}

/**
 * 契約の scriptQualityGate 節の意味検査（形はスキーマが閉じる）。
 *   - v56 以降の契約は節が必須（消して黙ってゲートを外す道を残さない）
 *   - 節の値はコードの定数と一致すること（受け入れ方を減らす・ジャンルを変えることはできない）
 *   - inForceSince はコードの定数で、契約の版以前
 *   - v56 以降の契約は、最終監査の必須監査に script-quality-accepted を持つ（v55 以前の一覧はそのまま通る）
 */
export function validateKoyaScriptQualityGateContract(contract) {
  const failures = [];
  const fail = (path, message) => failures.push({ path: `scriptQualityGate.${path}`, message });
  const section = contract?.scriptQualityGate;
  const current = seriesNumber(contract?.version);
  if (koyaScriptQualityGateInForce(contract)
    && !(Array.isArray(contract?.requiredAudits) && contract.requiredAudits.includes(KOYA_SCRIPT_QUALITY_FINAL_AUDIT_ID))) {
    failures.push({ path: "requiredAudits", message: `missing ${KOYA_SCRIPT_QUALITY_FINAL_AUDIT_ID} (required from ${KOYA_SCRIPT_QUALITY_IN_FORCE_SINCE}: the final audit checks that the script was accepted before paid work)` });
  }
  if (section === undefined) {
    if (koyaScriptQualityGateInForce(contract)) {
      failures.push({ path: "scriptQualityGate", message: `required from ${KOYA_SCRIPT_QUALITY_IN_FORCE_SINCE}: the script must pass the script quality loop or be accepted by a person before paid work` });
    }
    return failures;
  }
  if (!plain(section)) {
    failures.push({ path: "scriptQualityGate", message: "must be an object" });
    return failures;
  }
  for (const key of Object.keys(section)) if (!SECTION_KEYS.includes(key)) fail(key, "unknown key");
  if (section.version !== KOYA_SCRIPT_QUALITY_GATE_VERSION) fail("version", `must equal ${KOYA_SCRIPT_QUALITY_GATE_VERSION}`);
  if (section.inForceSince !== KOYA_SCRIPT_QUALITY_IN_FORCE_SINCE) fail("inForceSince", `must equal ${KOYA_SCRIPT_QUALITY_IN_FORCE_SINCE}`);
  else if (!current || current.series !== IN_FORCE.series || current.number < IN_FORCE.number) {
    fail("inForceSince", `a ${current ? contract.version : "(unversioned)"} contract predates ${KOYA_SCRIPT_QUALITY_IN_FORCE_SINCE}; drop the section instead of declaring a gate that is not in force`);
  }
  if (section.stage !== "before-paid-generation") fail("stage", "must equal before-paid-generation");
  if (section.genre !== KOYA_SCRIPT_QUALITY_GENRE) fail("genre", `must equal ${KOYA_SCRIPT_QUALITY_GENRE}`);
  if (JSON.stringify(section.acceptedBy) !== JSON.stringify(KOYA_SCRIPT_QUALITY_ACCEPTED_BY)) {
    fail("acceptedBy", `must list ${KOYA_SCRIPT_QUALITY_ACCEPTED_BY.join(", ")} (a person's accept-human keeps the client's own script from being stopped by an AI score)`);
  }
  if (section.stopWithoutPaidGeneration !== true) fail("stopWithoutPaidGeneration", "an unaccepted script stops before any paid work");
  return failures;
}

/** 台本の生テキストの SHA-256（画像計画の scriptSha256・最終監査の currentScriptSha256 と同じ定義）。 */
export function koyaScriptTextSha256(scriptText) {
  return createHash("sha256").update(String(scriptText ?? "")).digest("hex");
}

/**
 * 最終監査の判定（Koya の状態ファイルの scriptQuality を読むだけ）。
 *   - v55 以前の契約: 対象外（pass・applicable: false）
 *   - 記録が無い・合格でない・受け入れ方と理由コードが合わない・台本の生テキストの SHA が今の回の台本と違う: 不合格
 */
export function auditKoyaScriptQualityFinal({ contract, state, scriptTextSha256 } = {}) {
  const base = {
    auditId: KOYA_SCRIPT_QUALITY_FINAL_AUDIT_ID,
    version: KOYA_SCRIPT_QUALITY_GATE_VERSION,
    contractVersion: text(contract?.version),
  };
  if (!koyaScriptQualityGateInForce(contract)) {
    return { ...base, applicable: false, pass: true, detail: `not in force for ${text(contract?.version) || "(unversioned contract)"} (from ${KOYA_SCRIPT_QUALITY_IN_FORCE_SINCE})`, failures: [] };
  }
  const record = plain(state?.scriptQuality) ? state.scriptQuality : null;
  const failures = [];
  if (!record) failures.push("script-quality-record-missing");
  else {
    if (record.pass !== true) failures.push(`script-quality-not-accepted:${text(record.reasonCode) || "unknown"}`);
    const acceptedBy = text(record.acceptedBy);
    if (record.pass === true && (!KOYA_SCRIPT_QUALITY_ACCEPTED_BY.includes(acceptedBy) || ACCEPTED_REASON_CODES[acceptedBy] !== text(record.reasonCode))) {
      failures.push("script-quality-acceptance-inconsistent");
    }
    if (!SHA256.test(text(record.scriptTextSha256)) || text(record.scriptTextSha256) !== text(scriptTextSha256)) {
      failures.push("script-quality-script-sha-mismatch");
    }
  }
  const pass = failures.length === 0;
  return {
    ...base,
    applicable: true,
    pass,
    detail: pass
      ? `script accepted before paid work (${text(record.acceptedBy)}: ${text(record.reasonCode)})`
      : failures.join(", "),
    failures,
    ...(record ? {
      record: {
        reasonCode: text(record.reasonCode),
        acceptedBy: text(record.acceptedBy) || null,
        scriptSha256: text(record.scriptSha256),
        scriptTextSha256: text(record.scriptTextSha256),
        contractVersion: text(record.contractVersion),
      },
    } : {}),
  };
}
