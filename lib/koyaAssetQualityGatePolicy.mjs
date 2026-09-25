// 漫画（koya-manga-video）の公式経路で、途中の成果物を使う前に品質ループ（lib/assetQualityLoop.mjs）の
// 合格を要求する規則の「純粋な部分」。契約の検査・効力の判定・対象 id の作り方だけを置く。
//
// このファイルは制作契約の検査（lib/koyaMangaProductionContract.mjs）からも読む。契約の検査は
// 配布プラグインの実行系（動画 Job → RunReceipt → 契約）からも読み込まれるので、品質ループ本体
// （ファイル・画像・Channel Pack の検証を読む）を import しない。実際の照合は lib/koyaAssetQualityGate.mjs。
//
// 効力（inForceSince）: この必須化は契約 koya-manga-production-v54 から。それより前の版の契約で
// 作った・承認した成果物（過去の回の人物・場所、完成済みの画・声）を、後から「ループ未合格」で
// 止めない。契約の版で決めるので、契約から節を消しても v54 以降なら効力は消えない（検査が落とす）。

import { createHash } from "node:crypto";

export const KOYA_ASSET_QUALITY_GATE_VERSION = "koya-asset-quality-gate-v1";
// この保証が入った契約の版。契約の同名項目も同じ値。
export const KOYA_ASSET_QUALITY_GATE_IN_FORCE_SINCE = "koya-manga-production-v54";
export const KOYA_ASSET_QUALITY_HARNESS_ID = "koya-manga-video";
/** 使う前に合格を要求する工程（漫画は全工程）。契約はこれを減らせない。 */
export const KOYA_ASSET_QUALITY_REQUIRED_STAGES = Object.freeze(["character", "location", "scene-image", "thumbnail", "voice-take"]);
/** 品質ループの作業フォルダ（成果物と状態の置き場）。canvas/ は私有側で git に入らない。 */
export const KOYA_ASSET_QUALITY_WORK_DIR = "canvas";
/** 参照の照合に使う承認一覧（buzzassist-approved-references-v1）の置き場。作業フォルダからの相対。 */
export const KOYA_APPROVED_REFERENCES_RELATIVE_PATH = "quality/approved-references.json";
export const KOYA_ASSET_QUALITY_REQUIRED_CODE = "KOYA_ASSET_QUALITY_REQUIRED";
/**
 * 最終監査の必須監査 id（契約 v54 から requiredAudits に要る）。登録・完了の瞬間のゲートを通らずに
 * 回へ入った成果物（完了済みの行の再利用・汎用の経路の画・登録後に差し替わった参照画）を、完成の前に
 * 回が実際に使っているファイルで確かめ直す。実体は lib/koyaAssetQualityFinalAudit.mjs。
 */
export const KOYA_ASSET_QUALITY_FINAL_AUDIT_ID = "asset-quality-loops";

/**
 * 理由コード（failures・knownRemainingIssues に `asset-quality-required:<工程>:<対象>:<理由>` で載る）。
 *   loop-not-started      その成果物のループが始まっていない（評価者の採点が1回も無い）
 *   not-passed            ループはあるが合格していない（採点が不合格・人の確認待ち・人の否・上限で停止）
 *   asset-sha-mismatch    使おうとしているファイルが、合格した版と違うバイト列
 *   asset-missing         使おうとしているファイル、または合格した版のファイルが無い
 *   outside-work-dir      ファイルが作業フォルダ（canvas/）の外にある。ループは作業フォルダの中の成果物しか記録しない
 */
export const KOYA_ASSET_QUALITY_REASONS = Object.freeze([
  "loop-not-started",
  "not-passed",
  "asset-sha-mismatch",
  "asset-missing",
  "outside-work-dir",
]);

const CONTRACT_VERSION_PATTERN = /^(?<series>.+)-v(?<number>\d+)$/u;
const SUBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SECTION_KEYS = Object.freeze([
  "version", "inForceSince", "harnessId", "workDir", "approvedReferencesPath", "requirePassBeforeUse",
  "requireReviewedVersionSha256", "stopWithoutPaidRegeneration",
]);

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

const IN_FORCE = seriesNumber(KOYA_ASSET_QUALITY_GATE_IN_FORCE_SINCE);

/**
 * この契約でゲートが効いているか。版で決める（節の有無では決めない）。版の無い部分的な契約
 * （試験の合成の契約）と別系列の契約は効力の外。
 */
export function koyaAssetQualityGateInForce(contractOrResolved) {
  const contract = contractOrResolved?.contract || contractOrResolved;
  const current = seriesNumber(contract?.version);
  return Boolean(current && current.series === IN_FORCE.series && current.number >= IN_FORCE.number);
}

/**
 * 契約の assetQualityGate 節の意味検査（形はスキーマが閉じる）。
 *   - v54 以降の契約は節が必須（消して黙ってゲートを外す道を残さない）
 *   - 節の値はコードの定数と一致すること（工程を減らす・作業フォルダを変えることはできない）
 *   - inForceSince は同じ系列で、契約の版以前
 *   - v54 以降の契約は、最終監査の必須監査に asset-quality-loops を持つ（v53 以前の一覧はそのまま通る）
 */
export function validateKoyaAssetQualityGateContract(contract) {
  const failures = [];
  const fail = (path, message) => failures.push({ path: `assetQualityGate.${path}`, message });
  const section = contract?.assetQualityGate;
  const current = seriesNumber(contract?.version);
  if (koyaAssetQualityGateInForce(contract)
    && !(Array.isArray(contract?.requiredAudits) && contract.requiredAudits.includes(KOYA_ASSET_QUALITY_FINAL_AUDIT_ID))) {
    failures.push({ path: "requiredAudits", message: `missing ${KOYA_ASSET_QUALITY_FINAL_AUDIT_ID} (required from ${KOYA_ASSET_QUALITY_GATE_IN_FORCE_SINCE}: the final audit re-checks every used asset against its passed loop)` });
  }
  if (section === undefined) {
    if (koyaAssetQualityGateInForce(contract)) {
      failures.push({ path: "assetQualityGate", message: `required from ${KOYA_ASSET_QUALITY_GATE_IN_FORCE_SINCE}: intermediate assets must pass the asset quality loop before use` });
    }
    return failures;
  }
  if (!plain(section)) {
    failures.push({ path: "assetQualityGate", message: "must be an object" });
    return failures;
  }
  for (const key of Object.keys(section)) if (!SECTION_KEYS.includes(key)) fail(key, "unknown key");
  if (section.version !== KOYA_ASSET_QUALITY_GATE_VERSION) fail("version", `must equal ${KOYA_ASSET_QUALITY_GATE_VERSION}`);
  if (section.inForceSince !== KOYA_ASSET_QUALITY_GATE_IN_FORCE_SINCE) fail("inForceSince", `must equal ${KOYA_ASSET_QUALITY_GATE_IN_FORCE_SINCE}`);
  else if (!current || current.series !== IN_FORCE.series || current.number < IN_FORCE.number) {
    fail("inForceSince", `a ${current ? contract.version : "(unversioned)"} contract predates ${KOYA_ASSET_QUALITY_GATE_IN_FORCE_SINCE}; drop the section instead of declaring a gate that is not in force`);
  }
  if (section.harnessId !== KOYA_ASSET_QUALITY_HARNESS_ID) fail("harnessId", `must equal ${KOYA_ASSET_QUALITY_HARNESS_ID}`);
  if (section.workDir !== KOYA_ASSET_QUALITY_WORK_DIR) fail("workDir", `must equal ${KOYA_ASSET_QUALITY_WORK_DIR}`);
  if (section.approvedReferencesPath !== `${KOYA_ASSET_QUALITY_WORK_DIR}/${KOYA_APPROVED_REFERENCES_RELATIVE_PATH}`) {
    fail("approvedReferencesPath", `must equal ${KOYA_ASSET_QUALITY_WORK_DIR}/${KOYA_APPROVED_REFERENCES_RELATIVE_PATH}`);
  }
  if (JSON.stringify(section.requirePassBeforeUse) !== JSON.stringify(KOYA_ASSET_QUALITY_REQUIRED_STAGES)) {
    fail("requirePassBeforeUse", `must list every stage: ${KOYA_ASSET_QUALITY_REQUIRED_STAGES.join(", ")}`);
  }
  if (section.requireReviewedVersionSha256 !== true) fail("requireReviewedVersionSha256", "the used file must be the byte-identical reviewed version");
  if (section.stopWithoutPaidRegeneration !== true) fail("stopWithoutPaidRegeneration", "an unpassed asset stops for review; it never triggers paid regeneration on its own");
  return failures;
}

function sha(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

/**
 * 品質ループの対象 id（英数字と . _ -、64文字まで）を部品から決定論的に作る。
 * 英数字以外（日本語の名前など）を含む部品は置き換えたうえで元の値の短い指紋を足し、別の部品が
 * 同じ id に潰れないようにする。長すぎれば先頭を残して全体の指紋で詰める。
 */
export function koyaAssetQualitySubjectId(...parts) {
  const pieces = parts
    .flat()
    .map((part) => text(String(part ?? "")).normalize("NFKC"))
    .filter(Boolean)
    .map((part) => {
      const cleaned = part.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/-{2,}/gu, "-").replace(/^[-._]+|[-._]+$/gu, "");
      return cleaned === part && cleaned ? cleaned : `${cleaned ? `${cleaned}-` : ""}${sha(part).slice(0, 8)}`;
    });
  if (pieces.length === 0) throw new Error("koyaAssetQualitySubjectId requires at least one non-empty part.");
  let id = pieces.join(".");
  if (id.length > 64) id = `${id.slice(0, 51).replace(/[-._]+$/u, "")}-${sha(id).slice(0, 12)}`;
  if (!SUBJECT_ID.test(id)) id = `a${sha(id).slice(0, 12)}`;
  return id;
}

/** 失敗の行（機械で読める1行）。 */
export function koyaAssetQualityFailureCode(stage, subjectId, reason) {
  return `asset-quality-required:${stage}:${subjectId}:${reason}`;
}

/** 本編の画として品質ループを通す画像の行の種類（1枚の画と、分割ページの各コマ）。 */
export const KOYA_SCENE_IMAGE_JOB_KINDS = Object.freeze(["scene-image", "split-panel"]);

/** 本編の画の対象 id（回 id と画像の行 id。行 id の ":" は "." にする）。 */
export function koyaSceneImageAssetQualitySubjectId(episodeId, jobId) {
  return koyaAssetQualitySubjectId(episodeId, String(jobId || "").replace(/:/gu, "."));
}

/** 声のテイクの対象 id（回 id とカット id。版＝そのカットで採用するテイク）。 */
export function koyaVoiceTakeAssetQualitySubjectId(episodeId, cutId) {
  return koyaAssetQualitySubjectId(episodeId, cutId);
}

// ---------------------------------------------------------------------------------------------
// 動画クリップ（カットを動画に差し替える経路。lib/mangaCutVideoSubstitution.mjs）の品質ループ。
//
// 効力（inForceSince）: 契約 koya-manga-production-v55 から。v54 までの契約の回は、差し替えのクリップを
// 来歴と実 MP4 の監査（保証 cut-video-substitution）だけで確かめる従来どおり。契約の版で決めるので、節を
// 消しても v55 以降なら効力は消えない（検査が落とす）。
//
// 求めること: 印の付いたカットに結び付けたクリップは、レンダーの前に工程 video-clip のループで合格
// （別文脈の評価者の採点・要る人の確認・使うファイルの sha256 が合格した版と同じ）していること。最終監査の
// asset-quality-loops も、manifest で実際に使ったクリップを使ったファイルそのものの SHA で照らし直す。
// ---------------------------------------------------------------------------------------------

export const KOYA_VIDEO_CLIP_GATE_VERSION = "koya-video-clip-quality-gate-v1";
// この保証が入った契約の版。契約の同名項目も同じ値。
export const KOYA_VIDEO_CLIP_GATE_IN_FORCE_SINCE = "koya-manga-production-v55";
export const KOYA_VIDEO_CLIP_STAGE = "video-clip";
/**
 * 理由コード（`asset-quality-required:video-clip:<対象>:<理由>`）の理由は、1つの成果物のループの理由
 * （KOYA_ASSET_QUALITY_REASONS）と同じ。レンダーの前の照合と工程が止めたカットの理由は
 * video-clip-asset-quality-required（カットごとの failures・blocked の reason）。
 */
export const KOYA_VIDEO_CLIP_BLOCK_REASON = "video-clip-asset-quality-required";
const VIDEO_CLIP_SECTION_KEYS = Object.freeze([
  "version", "inForceSince", "harnessId", "workDir", "stage", "approvedReferencesPath", "requirePassBeforeRender",
  "requireReviewedVersionSha256", "stopWithoutPaidRegeneration",
]);
const VIDEO_CLIP_IN_FORCE = seriesNumber(KOYA_VIDEO_CLIP_GATE_IN_FORCE_SINCE);

/** この契約で動画クリップのゲートが効いているか。版で決める（節の有無では決めない）。 */
export function koyaVideoClipGateInForce(contractOrResolved) {
  const contract = contractOrResolved?.contract || contractOrResolved;
  const current = seriesNumber(contract?.version);
  return Boolean(current && current.series === VIDEO_CLIP_IN_FORCE.series && current.number >= VIDEO_CLIP_IN_FORCE.number);
}

/**
 * 契約の videoClipQualityGate 節の意味検査（形はスキーマが閉じる）。
 *   - v55 以降の契約は節が必須（消して黙ってゲートを外す道を残さない）
 *   - 節の値はコードの定数と一致すること（工程・作業フォルダ・承認一覧の置き場は変えられない）
 *   - inForceSince は同じ系列で、契約の版以前
 */
export function validateKoyaVideoClipQualityGateContract(contract) {
  const failures = [];
  const fail = (path, message) => failures.push({ path: `videoClipQualityGate.${path}`, message });
  const section = contract?.videoClipQualityGate;
  const current = seriesNumber(contract?.version);
  if (section === undefined) {
    if (koyaVideoClipGateInForce(contract)) {
      failures.push({ path: "videoClipQualityGate", message: `required from ${KOYA_VIDEO_CLIP_GATE_IN_FORCE_SINCE}: a substituted cut's clip must pass the video-clip asset quality loop before render` });
    }
    return failures;
  }
  if (!plain(section)) {
    failures.push({ path: "videoClipQualityGate", message: "must be an object" });
    return failures;
  }
  for (const key of Object.keys(section)) if (!VIDEO_CLIP_SECTION_KEYS.includes(key)) fail(key, "unknown key");
  if (section.version !== KOYA_VIDEO_CLIP_GATE_VERSION) fail("version", `must equal ${KOYA_VIDEO_CLIP_GATE_VERSION}`);
  if (section.inForceSince !== KOYA_VIDEO_CLIP_GATE_IN_FORCE_SINCE) fail("inForceSince", `must equal ${KOYA_VIDEO_CLIP_GATE_IN_FORCE_SINCE}`);
  else if (!current || current.series !== VIDEO_CLIP_IN_FORCE.series || current.number < VIDEO_CLIP_IN_FORCE.number) {
    fail("inForceSince", `a ${current ? contract.version : "(unversioned)"} contract predates ${KOYA_VIDEO_CLIP_GATE_IN_FORCE_SINCE}; drop the section instead of declaring a gate that is not in force`);
  }
  if (section.harnessId !== KOYA_ASSET_QUALITY_HARNESS_ID) fail("harnessId", `must equal ${KOYA_ASSET_QUALITY_HARNESS_ID}`);
  if (section.workDir !== KOYA_ASSET_QUALITY_WORK_DIR) fail("workDir", `must equal ${KOYA_ASSET_QUALITY_WORK_DIR}`);
  if (section.stage !== KOYA_VIDEO_CLIP_STAGE) fail("stage", `must equal ${KOYA_VIDEO_CLIP_STAGE}`);
  if (section.approvedReferencesPath !== `${KOYA_ASSET_QUALITY_WORK_DIR}/${KOYA_APPROVED_REFERENCES_RELATIVE_PATH}`) {
    fail("approvedReferencesPath", `must equal ${KOYA_ASSET_QUALITY_WORK_DIR}/${KOYA_APPROVED_REFERENCES_RELATIVE_PATH}`);
  }
  if (section.requirePassBeforeRender !== true) fail("requirePassBeforeRender", "a marked cut renders only from a clip whose video-clip loop passed");
  if (section.requireReviewedVersionSha256 !== true) fail("requireReviewedVersionSha256", "the rendered clip must be the byte-identical reviewed version");
  if (section.stopWithoutPaidRegeneration !== true) fail("stopWithoutPaidRegeneration", "an unpassed clip stops for review; it never triggers paid regeneration on its own");
  return failures;
}

/** 動画クリップの対象 id（回 id・"video"・カット id。版＝そのカットに結び付けたクリップ）。 */
export function koyaVideoClipAssetQualitySubjectId(episodeId, cutId) {
  return koyaAssetQualitySubjectId(episodeId, "video", cutId);
}
