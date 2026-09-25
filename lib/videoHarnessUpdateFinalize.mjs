// 更新をまたいで Job を確定させる（run-video-harness resume --finalize-after-update）ための部品。
//
// Job の同一性（identityDigest。Job ID の元）は、入力（台本・Channel Pack・options）とコード（コアの
// ファイル・宣言・配置・スキル・依存の木・制作契約）を1つにまとめて指紋にしている。BuzzAssist を更新すると
// コード側だけが変わり、進行中の Job は canonical-identity-drift で止まる。2026-09-26 の運営者決定で、
// 入力と作った成果物が変わっていなければ、作り直さずにその Job を確定までやり直せるようにした。
//
// ここは同一性を2つに分けて扱う:
//   - 入力の同一性: 台本の SHA、Channel Pack の指紋、options の本体（戦略ブリーフの SHA を含む）、
//     運営者の取り込みの記録（options が指す manifest）の SHA。変わっていたら今までどおり止める
//   - コードの同一性: Job の canonicalIdentity（コア・宣言・配置・スキル・依存の木・制作契約）。これだけが
//     変わった Job は、計画時の値を plannedCanonicalIdentity に残したまま今のコードへ付け替える（rebind）
//
// Job ID と identityDigest は付け替えない（計画時の値のまま）。reviewer の署名は identityDigest に
// 結ばれているので、付け替えると済んだレビューまで無効になる。
//
// 漫画（Koya）は実行時に解決した制作契約を Job に固定している（resolvedProductionContract）。更新で
// リポジトリの契約の版が上がっても、確定はその固定した版で行う。中身は Job の run フォルダ（固定した時点の
// 写し）か、子が作った写し（koya-contract-resolved.json）から取り、digest が固定値と一致するものだけを使う。

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { writeJsonAtomic } from "./atomicJsonFile.mjs";
import { canonicalJson } from "./channelPackEnvelope.mjs";
import { koyaContractDigest, validateKoyaMangaProductionContract } from "./koyaMangaProductionContract.mjs";

export const VIDEO_HARNESS_INPUT_IDENTITY_VERSION = "buzzassist-video-harness-input-identity-v1";
export const VIDEO_HARNESS_CODE_REBIND_VERSION = "buzzassist-video-harness-code-rebind-v1";
export const CANONICAL_IDENTITY_DRIFT_CODE = "canonical-identity-drift";

/** コードの同一性は計画時と同じ（更新をまたいでいない）。付け替えは要らないので、ふつうの resume を使う。 */
export const FINALIZE_AFTER_UPDATE_NOT_NEEDED_CODE = "finalize-after-update-not-needed";
/** 入力（台本・Channel Pack・取り込みの記録・Koya の回の上書き）が変わった。新しい Job を作る。 */
export const FINALIZE_AFTER_UPDATE_INPUT_CHANGED_CODE = "finalize-after-update-input-changed";
/** 取り込みの記録の SHA が Job に残っていない（この機能より前に最後の制作を走らせた Job）。変わっていないと示せない。 */
export const FINALIZE_AFTER_UPDATE_INPUT_UNRECORDED_CODE = "finalize-after-update-input-unrecorded";
/** 固定した制作契約の中身が見つからない・今のコードで読めない。固定した版で確定できない。 */
export const FINALIZE_AFTER_UPDATE_PINNED_CONTRACT_UNAVAILABLE_CODE = "finalize-after-update-pinned-contract-unavailable";
/** 確定までに新しい有料の呼び出しが要った（作った成果物の再利用が当たらなかった）。新しい Job を作る。 */
export const FINALIZE_AFTER_UPDATE_PAID_CALL_REQUIRED_CODE = "finalize-after-update-paid-call-required";

/** 止めて Job に残す理由（blockers に canonical-identity-drift と一緒に並べる）。 */
export const FINALIZE_AFTER_UPDATE_BLOCKING_CODES = Object.freeze([
  FINALIZE_AFTER_UPDATE_INPUT_CHANGED_CODE,
  FINALIZE_AFTER_UPDATE_INPUT_UNRECORDED_CODE,
  FINALIZE_AFTER_UPDATE_PINNED_CONTRACT_UNAVAILABLE_CODE,
]);

/** options のうち、運営者の取り込みの記録（manifest）を指すもの。中身の SHA を入力の同一性に入れる。 */
export const OPERATOR_IMPORT_OPTION_KEYS = Object.freeze(["operatorImageManifestPath", "operatorVideoManifestPath"]);

/** 更新をまたいで確定させる実行の置き場（Job の run フォルダの下）。 */
export const FINALIZE_AFTER_UPDATE_DIR = "finalize-after-update";
/** doctor の前に固定した制作契約の中身の写し（Job の run フォルダ直下。固定した時点で書く）。 */
export const PINNED_PRODUCTION_CONTRACT_FILE = "pinned-production-contract.json";
const MAX_REBIND_HISTORY = 50;

export const FINALIZE_AFTER_UPDATE_HINT = "入力（台本・Channel Pack・取り込みの記録・options）と作った成果物が同じなら、"
  + "resume --finalize-after-update（MCP は finalizeAfterUpdate: true）で、作り直さず新しい有料の呼び出しもせずに、"
  + "Job に固定した契約の版で確定までやり直せる。";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function finalizeAfterUpdateError(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  return error;
}

/** 付け替えの記録を持つ Job（更新をまたいで確定させる実行に入った Job）。以後の再開は再利用だけで走る。 */
export function isFinalizeAfterUpdateJob(job) {
  return job?.codeIdentityRebind?.version === VIDEO_HARNESS_CODE_REBIND_VERSION
    && Boolean(job.codeIdentityRebind.plannedCanonicalIdentity);
}

/** Job ID と identityDigest の元になった計画時のコードの同一性。付け替えた Job でも計画時の値を返す。 */
export function plannedCanonicalIdentityOf(job) {
  return isFinalizeAfterUpdateJob(job) ? job.codeIdentityRebind.plannedCanonicalIdentity : job?.canonicalIdentity;
}

export function codeIdentityDigest(canonicalIdentity) {
  return sha256(canonicalJson(canonicalIdentity ?? null));
}

/**
 * コードの同一性の要約（Job の記録と RunReceipt に残す）。版と SHA だけで、端末の絶対パスは持たない。
 */
export function codeIdentitySummary(canonicalIdentity) {
  if (!canonicalIdentity || typeof canonicalIdentity !== "object") return null;
  const contract = canonicalIdentity.productionContract;
  return {
    digest: codeIdentityDigest(canonicalIdentity),
    coreVersion: String(canonicalIdentity.core?.version || ""),
    coreSha256: String(canonicalIdentity.core?.sha256 || ""),
    runtimeDependenciesDigest: String(canonicalIdentity.productionDependencies?.runtime?.digest || ""),
    deploymentDependenciesDigest: String(canonicalIdentity.productionDependencies?.deployment?.digest || ""),
    harnessDeclarationSha256: String(canonicalIdentity.harnessDeclaration?.sha256 || ""),
    deploymentEntrypointSha256: String(canonicalIdentity.deployment?.entrypointSha256 || ""),
    productionContract: contract && typeof contract === "object"
      ? { contractVersion: String(contract.contractVersion || ""), contractDigest: String(contract.contractDigest || "") }
      : null,
    skills: (Array.isArray(canonicalIdentity.skills) ? canonicalIdentity.skills : [])
      .map((row) => ({ id: String(row?.id || ""), sha256: String(row?.sha256 || "") }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

async function fileSha256OrEmpty(path) {
  try {
    return sha256(await readFile(path));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return "";
    throw error;
  }
}

/** options が指す取り込みの記録の SHA（無い・指していない manifest は ""）。options に無い鍵は並べない。 */
export async function operatorImportDigests(options = {}) {
  const rows = [];
  for (const option of OPERATOR_IMPORT_OPTION_KEYS) {
    const path = text(options?.[option]);
    if (!path) continue;
    rows.push({ option, sha256: await fileSha256OrEmpty(resolve(path)) });
  }
  return rows;
}

/**
 * 入力の同一性。台本・Channel Pack・options は Job に保存した値（identityDigest で計画時の値と結ばれている）、
 * 取り込みの記録はいまの中身の SHA。digest は Job と RunReceipt に残す。
 */
export function videoHarnessInputIdentity({ harnessId, scriptSha256, channelPack = null, options = {}, operatorImports = [] } = {}) {
  const identity = {
    version: VIDEO_HARNESS_INPUT_IDENTITY_VERSION,
    harnessId: String(harnessId || ""),
    scriptSha256: String(scriptSha256 || ""),
    channelPack: channelPack
      ? { kind: String(channelPack.kind || ""), sha256: String(channelPack.sha256 || ""), fileCount: Number(channelPack.fileCount || 0) }
      : null,
    options: options && typeof options === "object" ? options : {},
    operatorImports: [...operatorImports]
      .map((row) => ({ option: String(row.option), sha256: String(row.sha256 || "") }))
      .sort((left, right) => left.option.localeCompare(right.option)),
  };
  return { ...identity, digest: sha256(canonicalJson(identity)) };
}

/** Job に残す入力の同一性の記録（options・台本・Pack は Job 本体にあるので、digest と取り込みの SHA だけ）。 */
export function inputIdentityRecord(identity, { recordedAt, recordedFor }) {
  return {
    version: VIDEO_HARNESS_INPUT_IDENTITY_VERSION,
    digest: identity.digest,
    operatorImports: identity.operatorImports,
    recordedAt: String(recordedAt || ""),
    recordedFor: String(recordedFor || ""),
  };
}

/**
 * 最後に制作へ渡した取り込みの記録と、いまの中身を比べる。返すのは違い（changed）と、記録が無くて
 * 比べられないもの（unrecorded）。options に取り込みの鍵が無ければどちらも空。
 */
export function compareOperatorImports(job, current) {
  const recorded = job?.inputIdentity?.version === VIDEO_HARNESS_INPUT_IDENTITY_VERSION && Array.isArray(job.inputIdentity.operatorImports)
    ? new Map(job.inputIdentity.operatorImports.map((row) => [row.option, String(row.sha256 || "")]))
    : null;
  const changed = [];
  const unrecorded = [];
  for (const row of current) {
    if (!recorded || !recorded.has(row.option)) unrecorded.push(row.option);
    else if (recorded.get(row.option) !== row.sha256) changed.push(`operator-import:${row.option}`);
  }
  return { changed, unrecorded };
}

/**
 * 付け替えの記録を作る。計画時の値（plannedCanonicalIdentity・plannedHarness）は最初の付け替えで1回だけ
 * 残し、2回目以降の更新では付け替えの履歴だけを積む。
 */
export function nextCodeIdentityRebind(job, {
  currentCanonicalIdentity,
  inputIdentityDigest,
  pinnedProductionContract = null,
  at,
}) {
  const previous = isFinalizeAfterUpdateJob(job) ? job.codeIdentityRebind : null;
  const plannedHarness = previous?.plannedHarness || {
    declarationVersion: String(job?.harness?.declarationVersion || ""),
    declarationSha256: String(job?.harness?.declarationSha256 || job?.canonicalIdentity?.harnessDeclaration?.sha256 || ""),
    canonicalSkills: (job?.harness?.canonicalSkills || []).map((row) => ({ id: String(row?.id || ""), sha256: String(row?.sha256 || "") })),
  };
  return {
    version: VIDEO_HARNESS_CODE_REBIND_VERSION,
    plannedCanonicalIdentity: previous?.plannedCanonicalIdentity || job.canonicalIdentity,
    plannedHarness,
    pinnedProductionContract: pinnedProductionContract || previous?.pinnedProductionContract || null,
    rebinds: [
      ...(Array.isArray(previous?.rebinds) ? previous.rebinds : []),
      {
        at: String(at || ""),
        from: codeIdentitySummary(job.canonicalIdentity),
        to: codeIdentitySummary(currentCanonicalIdentity),
        inputIdentityDigest: String(inputIdentityDigest || ""),
      },
    ].slice(-MAX_REBIND_HISTORY),
    finalizeRuns: Array.isArray(previous?.finalizeRuns) ? previous.finalizeRuns : [],
  };
}

/** 1回の「再利用だけの実行」の記録（止めた有料の呼び出しと、Media Job の再利用の内訳）。 */
export function appendFinalizeRun(rebind, run) {
  return {
    ...rebind,
    finalizeRuns: [...(Array.isArray(rebind?.finalizeRuns) ? rebind.finalizeRuns : []), run].slice(-MAX_REBIND_HISTORY),
  };
}

function contractFromDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) return null;
  // Job の写しは契約そのもの。子の写し（koya-contract-resolved.json）は { version, digest, contract }。
  if (document.contract && typeof document.contract === "object" && !Array.isArray(document.contract)) return document.contract;
  return document;
}

async function readJsonIfPresent(path) {
  try {
    return { bytes: await readFile(path), found: true };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { bytes: null, found: false };
    throw error;
  }
}

/**
 * Koya の固定した制作契約の中身を探す。探す順: Job の run フォルダの写し（固定した時点で書いたもの）→
 * 子が回のフォルダに作った写し。digest と版が Job の固定値（resolvedProductionContract）と一致するものだけ
 * を返す。見つからなければ null（呼び出し側が止める）。
 */
export async function findPinnedKoyaProductionContract(job, { episodeSnapshotPath = "" } = {}) {
  const record = job?.resolvedProductionContract;
  if (!record?.contractDigest) return null;
  const candidates = [
    { source: "job-pinned-at-doctor", path: join(resolve(job.runDir), PINNED_PRODUCTION_CONTRACT_FILE) },
    ...(episodeSnapshotPath ? [{ source: "episode-contract-snapshot", path: resolve(episodeSnapshotPath) }] : []),
  ];
  for (const candidate of candidates) {
    const { bytes, found } = await readJsonIfPresent(candidate.path);
    if (!found) continue;
    let contract;
    try { contract = contractFromDocument(JSON.parse(bytes.toString("utf8"))); } catch { continue; }
    if (!contract) continue;
    if (koyaContractDigest(contract) !== record.contractDigest || contract.version !== record.contractVersion) continue;
    return { contract, source: candidate.source };
  }
  return null;
}

/**
 * 固定した制作契約の中身を、付け替えた Job の置き場へ書く。いまのコードの検証に通らない契約は書かない
 * （いまのコードで固定した版の制作・監査ができないので、確定させない）。
 */
export async function writePinnedProductionContractForFinalize(job, contract, { source }) {
  const validation = validateKoyaMangaProductionContract(contract);
  if (!validation.pass) {
    throw finalizeAfterUpdateError(
      FINALIZE_AFTER_UPDATE_PINNED_CONTRACT_UNAVAILABLE_CODE,
      `固定した制作契約 ${contract?.version || "(版不明)"} を今のコードの検証に通せない: `
      + validation.failures.slice(0, 5).map((entry) => `${entry.path}: ${entry.message}`).join("; "),
    );
  }
  const path = join(resolve(job.runDir), FINALIZE_AFTER_UPDATE_DIR, PINNED_PRODUCTION_CONTRACT_FILE);
  await writeJsonAtomic(path, contract);
  return {
    path,
    sha256: sha256(await readFile(path)),
    contractVersion: String(contract.version || ""),
    contractDigest: koyaContractDigest(contract),
    source: String(source || ""),
  };
}

/**
 * 付け替えた Koya の Job の固定した制作契約を読み、写しの SHA と、中身の digest・版が Job の固定値と一致する
 * ことを確かめて返す。付け替えていない Job・固定した写しを持たない Job は null。
 */
export async function readRebindPinnedProductionContract(job) {
  const pinned = isFinalizeAfterUpdateJob(job) ? job.codeIdentityRebind.pinnedProductionContract : null;
  if (!pinned) return null;
  const record = job?.resolvedProductionContract;
  if (!record?.contractDigest) throw new Error("付け替えた Koya の Job に固定した制作契約の記録（resolvedProductionContract）が無い。");
  const bytes = await readFile(resolve(pinned.path));
  if (sha256(bytes) !== pinned.sha256) throw new Error("固定した制作契約の写しが付け替えの後に変わった。");
  const contract = JSON.parse(bytes.toString("utf8"));
  if (koyaContractDigest(contract) !== record.contractDigest || contract.version !== record.contractVersion
    || pinned.contractDigest !== record.contractDigest || pinned.contractVersion !== record.contractVersion) {
    throw new Error("固定した制作契約の写しが Job の固定値（版・digest）と一致しない。");
  }
  return { record, contract, pinned };
}

/**
 * 共通 RunReceipt の codeIdentity 欄へ渡す記録（lib/harnessRunReceipt.mjs が正規化して digest を付ける）。
 * 計画したコードと確定したコードの要約、更新をまたいだ付け替えの履歴、固定した制作契約の版、入力の同一性の
 * digest、再利用だけの実行の結果。版と SHA と数だけで、端末の絶対パスは渡さない。
 */
export function runReceiptCodeIdentityRecord(job) {
  // コードの同一性を持たない Job（計画の記録が無い）は「記録を渡さない」。推測で埋めない。
  if (!job?.canonicalIdentity || typeof job.canonicalIdentity !== "object") return null;
  const rebind = isFinalizeAfterUpdateJob(job) ? job.codeIdentityRebind : null;
  const pinned = rebind?.pinnedProductionContract;
  return {
    planned: codeIdentitySummary(plannedCanonicalIdentityOf(job)),
    finalized: codeIdentitySummary(job?.canonicalIdentity),
    rebinds: Array.isArray(rebind?.rebinds) ? rebind.rebinds : [],
    pinnedProductionContract: pinned ? { contractVersion: pinned.contractVersion, contractDigest: pinned.contractDigest } : null,
    inputIdentityDigest: job?.inputIdentity?.version === VIDEO_HARNESS_INPUT_IDENTITY_VERSION ? String(job.inputIdentity.digest || "") : "",
    finalizeRuns: Array.isArray(rebind?.finalizeRuns) ? rebind.finalizeRuns : [],
  };
}

/** Koya の回の上書き（episode override）は入力。固定した時点の SHA と、いまの中身を比べる。 */
export async function episodeOverrideChanged(job) {
  const record = job?.resolvedProductionContract;
  const path = text(record?.episodeOverridePath);
  if (!path) return false;
  return await fileSha256OrEmpty(path) !== String(record.episodeOverrideFileSha256 || "");
}
