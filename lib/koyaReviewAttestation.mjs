// 独立レビュー signoff を、生成プロセスとは別に信頼設定した reviewer 鍵の
// Ed25519 署名で結合する。Koya（漫画動画）と narrated-story-video の両ハーネスが
// この 1 つの実装を使う。ハーネスごとに subject の形（schema）だけが違い、
// 信頼リスト・署名・検証の規則は同じ。
//
// 何を解くか: signoff JSON の reviewer / reviewerContextId は自己申告で、
// 生成側と違う文字列を書けば「独立」に見えてしまう。ここでは
// 「運営者が別経路で信頼した reviewer 公開鍵」が、Job 識別子・成果物 SHA・
// 申告した reviewer context（Koya は加えて外側 Job binding・契約 digest・
// review notes SHA、narrated は signoff 本文 SHA）を 1 つの subject として
// 署名したことを、最終監査と RunReceipt の両方で再検証する。
//
// 信頼の置き場: Channel Pack の trusted key と同じ流儀で、環境変数
// （BUZZASSIST_REVIEWER_TRUST = 信頼リスト JSON の path、または
// BUZZASSIST_REVIEWER_TRUST_JSON = inline JSON。旧名 BUZZASSIST_KOYA_REVIEWER_TRUST
// / _JSON も同じ意味で受ける）から読む。attestation 内に鍵を添付しても信頼しない。
// bundle と鍵を一緒に差し替えられるため。
//
// 信頼アンカー規則（全ハーネス・全入口共通、2026-09-06 確定）:
// - 唯一の信頼アンカーは運営者（owner）が監査・Receipt 実行側へ配る環境変数。
// - CLI / MCP / Job 実行時引数の明示 path・inline JSON・in-memory object は「照合用」であり、
//   環境変数の内容（canonical sha256）と一致しなければ reviewer-trust-conflict で拒否する。
// - 環境変数が未設定なら、明示入力があっても reviewer-trust-unconfigured で fail-closed。
//   要求側（生成を行う端末・エージェント）の入力だけで信頼アンカーを立てられる構成では、
//   自分で鍵を作り自分で信頼リストへ登録し自分で署名でき、attestation が自己承認へ退化する。
// この規則は loadReviewerTrust の 1 か所に置き、Job 層・CLI・MCP adapter・Receipt は全て
// それを呼ぶ。呼び出し側に別の優先順を書かない。
//
// 失効: 信頼リストの entry が status "revoked" なら、signedAt がいつであっても
// 拒否する。signedAt は署名者が自己申告する値で、鍵が漏れた後は過去日付の
// 署名を新しく作れる。時刻で失効を区切ると、その署名が通る。
//
// プリミティブ（Ed25519 / canonicalJson / publicKeyId）は channelPackEnvelope.mjs の
// 既存実装を再利用する。ここで 2 つ目の署名方式を作らない。
// （file 名に koya が残っているのは履歴。narrated 側も同じ export を使う。）

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  createHash,
} from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, lstat, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { canonicalJson, publicKeyId } from "./channelPackEnvelope.mjs";

const execFile = promisify(execFileCallback);
const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export const KOYA_REVIEW_ATTESTATION_VERSION = "koya-review-attestation-v1";
export const NARRATED_REVIEW_ATTESTATION_VERSION = "narrated-story-review-attestation-v1";
// 信頼リストは両ハーネス共通。version 文字列は互換のため初版の綴りを維持する。
export const REVIEWER_TRUST_VERSION = "koya-reviewer-trust-v1";
export const KOYA_REVIEWER_TRUST_VERSION = REVIEWER_TRUST_VERSION;
export const REVIEWER_TRUST_PATH_ENV = "BUZZASSIST_REVIEWER_TRUST";
export const REVIEWER_TRUST_JSON_ENV = "BUZZASSIST_REVIEWER_TRUST_JSON";
/** 旧名。同じ信頼リストを指す別綴りとして受け続ける（値が食い違えば拒否）。 */
export const KOYA_REVIEWER_TRUST_PATH_ENV = "BUZZASSIST_KOYA_REVIEWER_TRUST";
export const KOYA_REVIEWER_TRUST_JSON_ENV = "BUZZASSIST_KOYA_REVIEWER_TRUST_JSON";
/** 信頼アンカー規則の理由コード。Job 層・CLI・MCP・Receipt が同じ綴りを使う。 */
export const REVIEWER_TRUST_UNCONFIGURED_CODE = "reviewer-trust-unconfigured";
export const REVIEWER_TRUST_CONFLICT_CODE = "reviewer-trust-conflict";
export const REVIEWER_TRUST_UNREADABLE_CODE = "reviewer-trust-unreadable";
/** help / 案内文で使う環境変数の表記（新名を主、旧名は互換）。 */
export const REVIEWER_TRUST_ENV_GUIDANCE = `${REVIEWER_TRUST_PATH_ENV} (legacy alias ${KOYA_REVIEWER_TRUST_PATH_ENV}; inline JSON via ${REVIEWER_TRUST_JSON_ENV})`;

/**
 * Job options / MCP 引数に「信頼アンカーの置き場所」や「reviewer 鍵（中身・path）」を書かせない
 * ための共通パターン。service 層（videoHarnessService）と Job 層（videoHarnessJob）が**同じ定数**を
 * 参照する（R6-F6: 拒否範囲が層ごとに食い違うと、片方だけが reviewerKeyPath を通す）。
 *
 * - REVIEWER_TRUST_OPTION_PATTERN: reviewerTrustPath / reviewer_trust_json 等。信頼アンカーは運営者 env のみ
 * - REVIEWER_KEY_OPTION_PATTERN: PEM・秘密鍵・reviewer 鍵・鍵 path。production Job には中身も path も載せない
 *   （signoff は別 context の reviewer 工程で --reviewer-key-path から行う）
 * - REVIEWER_KEY_MATERIAL_VALUE_PATTERN: option 名が無害でも値が鍵／信頼リスト本文なら拒否
 */
export const REVIEWER_TRUST_OPTION_PATTERN = /reviewer[-_]?trust/iu;
export const REVIEWER_KEY_OPTION_PATTERN = /(?:pem$|private[-_]?key|reviewer[-_]?(?:public[-_]?)?key|key[-_]?path$)/iu;
export const REVIEWER_KEY_MATERIAL_VALUE_PATTERN = /-----BEGIN [A-Z ]*(?:PRIVATE|PUBLIC) KEY-----|"reviewers"\s*:\s*\[/u;
/** 信頼リストは読めたが active な reviewer 鍵が 1 件も無い（全件 revoked）。 */
export const REVIEWER_TRUST_NO_ACTIVE_CODE = "reviewer-trust-invalid:no-active-reviewers";

export const KOYA_HARNESS_ID = "koya-manga-video";
export const NARRATED_STORY_HARNESS_ID = "narrated-story-video";

const SHA256 = /^[a-f0-9]{64}$/u;
const KEY_ID = /^ed25519:[a-f0-9]{24}$/u;
const REVIEWER_HOSTS = Object.freeze(["claude", "codex"]);
const TRUST_STATUSES = Object.freeze(["active", "revoked"]);

/** Koya の署名対象に入る field。順序は canonicalJson が決めるのでここは列挙だけ。 */
export const KOYA_REVIEW_ATTESTATION_SUBJECT_FIELDS = Object.freeze([
  "version",
  "harnessId",
  "episodeId",
  "jobId",
  "identityDigest",
  "executionIdentityDigest",
  "resolvedProductionContractSha256",
  "outerJobBindingSha256",
  "contractDigest",
  "videoSha256",
  "contactSheetSha256",
  "reviewNotesContentSha256",
  "reviewerHost",
  "reviewerId",
  "reviewerContextId",
]);

/**
 * narrated-story-video の署名対象。narrated Job は execution identity を持たない
 * （Koya 専用）ので、Job 側の真値は jobId と identityDigest。signoff 本文
 * （approved / findings / knownRemainingIssues / originalDetailReviewed を含む、
 * reviewerAttestation を除いた全体）の canonical SHA を入れ、承認内容の書き換えも
 * 署名で落とす。
 */
export const NARRATED_REVIEW_ATTESTATION_SUBJECT_FIELDS = Object.freeze([
  "version",
  "harnessId",
  "jobId",
  "identityDigest",
  "videoSha256",
  "contactSheetSha256",
  "signoffBodySha256",
  "reviewerId",
  "reviewerContextId",
]);

const SUBJECT_SCHEMAS = new Map([
  [KOYA_HARNESS_ID, Object.freeze({
    harnessId: KOYA_HARNESS_ID,
    version: KOYA_REVIEW_ATTESTATION_VERSION,
    jobId: /^video-koya-manga-video-[a-f0-9]{16}$/u,
    fields: KOYA_REVIEW_ATTESTATION_SUBJECT_FIELDS,
    shaFields: Object.freeze([
      "identityDigest",
      "executionIdentityDigest",
      "resolvedProductionContractSha256",
      "outerJobBindingSha256",
      "contractDigest",
      "videoSha256",
      "contactSheetSha256",
      "reviewNotesContentSha256",
    ]),
    textFields: Object.freeze(["episodeId", "reviewerId"]),
    hostField: "reviewerHost",
  })],
  [NARRATED_STORY_HARNESS_ID, Object.freeze({
    harnessId: NARRATED_STORY_HARNESS_ID,
    version: NARRATED_REVIEW_ATTESTATION_VERSION,
    jobId: /^video-narrated-story-video-[a-f0-9]{16}$/u,
    fields: NARRATED_REVIEW_ATTESTATION_SUBJECT_FIELDS,
    shaFields: Object.freeze(["identityDigest", "videoSha256", "contactSheetSha256", "signoffBodySha256"]),
    textFields: Object.freeze(["reviewerId"]),
    hostField: "",
  })],
]);
const KNOWN_ATTESTATION_VERSIONS = Object.freeze([...SUBJECT_SCHEMAS.values()].map((schema) => schema.version));

export const REVIEW_ATTESTATION_HARNESS_IDS = Object.freeze([...SUBJECT_SCHEMAS.keys()]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// 正規形だけを受ける。trim や toLowerCase をここで行うと、末尾空白や大文字の
// 写しが原本と同じ subject に収束し、署名が「別の綴り」を区別できなくなる。
const canonicalText = (value) => typeof value === "string" && value.length > 0 && value === value.trim();
const canonicalSha256 = (value) => typeof value === "string" && SHA256.test(value);
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function schemaFor(harnessId) {
  return SUBJECT_SCHEMAS.get(harnessId) || null;
}

function subjectFieldFailures(subject, prefix, schema = null) {
  const failures = [];
  if (!isPlainObject(subject)) return [`${prefix}-invalid`];
  const effective = schema || schemaFor(subject.harnessId);
  if (!effective) return [`${prefix}-noncanonical:harnessId`];
  if (subject.harnessId !== effective.harnessId) failures.push(`${prefix}-noncanonical:harnessId`);
  if (subject.version !== effective.version) failures.push(`${prefix}-noncanonical:version`);
  if (typeof subject.jobId !== "string" || !effective.jobId.test(subject.jobId)) failures.push(`${prefix}-noncanonical:jobId`);
  for (const field of effective.shaFields) {
    if (!canonicalSha256(subject[field])) failures.push(`${prefix}-noncanonical:${field}`);
  }
  for (const field of effective.textFields) {
    if (!canonicalText(subject[field])) failures.push(`${prefix}-noncanonical:${field}`);
  }
  if (effective.hostField && !REVIEWER_HOSTS.includes(subject[effective.hostField])) {
    failures.push(`${prefix}-noncanonical:${effective.hostField}`);
  }
  if (!canonicalText(subject.reviewerContextId) || subject.reviewerContextId.length < 8) {
    failures.push(`${prefix}-noncanonical:reviewerContextId`);
  }
  for (const key of Object.keys(subject)) {
    if (!effective.fields.includes(key)) failures.push(`${prefix}-noncanonical:${key}`);
  }
  return failures;
}

/**
 * 監査・署名側が真値から subject を「組む」段の失敗は、attestation 内の署名済み
 * subject が壊れている失敗（reviewer-attestation-subject-*）とは別の理由コード
 * （reviewer-attestation-expected-subject-*）にする。前者は入力（Job・成果物・
 * reviewer 申告）の欠落や非正規形、後者は署名文書の不正で、対処先が違う。
 */
export const REVIEW_ATTESTATION_EXPECTED_SUBJECT_PREFIX = "reviewer-attestation-expected-subject";

function freezeSubject(subject) {
  const failures = subjectFieldFailures(subject, REVIEW_ATTESTATION_EXPECTED_SUBJECT_PREFIX);
  if (failures.length > 0) throw new Error(failures.join(", "));
  return Object.freeze(subject);
}

/** 期待 subject を組めなかった例外を理由コードの配列へ（メッセージ本文は残さない）。 */
export function expectedSubjectFailureCodes(error) {
  const codes = String(error?.message || error || "")
    .split(", ")
    .map((code) => code.trim())
    .filter((code) => code.startsWith(`${REVIEW_ATTESTATION_EXPECTED_SUBJECT_PREFIX}-`));
  return codes.length > 0 ? codes : [`${REVIEW_ATTESTATION_EXPECTED_SUBJECT_PREFIX}-invalid`];
}

/**
 * ハーネス宣言（config/harnesses/*.harness.json）が申告する attestation subject。
 * `reviewAttestation.subject` が既知の schema 名でなければ空文字を返し、呼び出し側は
 * fail-closed（reviewer-attestation-unsupported-harness）にする。harness id で分岐すると
 * 後から増えた 1 つが素通りするので、宣言に書かせる。
 */
export function declaredReviewAttestationSubject(declaration) {
  const subject = declaration?.reviewAttestation?.subject;
  return typeof subject === "string" && SUBJECT_SCHEMAS.has(subject) ? subject : "";
}

/**
 * Koya: 監査側が信頼できる値（manifest の outer Job binding、契約 digest、
 * disk から計算した MP4 / contact sheet / review notes の SHA、signoff が申告した
 * reviewer provenance）から署名対象を組む。signoff 自身の写しからは組まない。
 * 不正な入力は throw する。ここで黙って空文字を入れると、欠落が「一致」になる。
 */
export function createKoyaReviewAttestationSubject({
  episodeId,
  outerJobBinding,
  contractDigest,
  videoSha256,
  contactSheetSha256,
  reviewNotesContentSha256,
  reviewer,
} = {}) {
  if (!isPlainObject(outerJobBinding)) throw new Error(`${REVIEW_ATTESTATION_EXPECTED_SUBJECT_PREFIX}-invalid:outerJobBinding`);
  return freezeSubject({
    version: KOYA_REVIEW_ATTESTATION_VERSION,
    harnessId: KOYA_HARNESS_ID,
    episodeId,
    jobId: outerJobBinding.jobId,
    identityDigest: outerJobBinding.identityDigest,
    executionIdentityDigest: outerJobBinding.executionIdentityDigest,
    resolvedProductionContractSha256: outerJobBinding.resolvedProductionContractSha256,
    outerJobBindingSha256: outerJobBinding.bindingSha256,
    contractDigest,
    videoSha256,
    contactSheetSha256,
    reviewNotesContentSha256,
    reviewerHost: reviewer?.host,
    reviewerId: reviewer?.id,
    reviewerContextId: reviewer?.contextId,
  });
}

/**
 * narrated-story-video: Job の真値（id / identityDigest）、disk から計算した
 * MP4 / contact sheet の SHA、signoff 本文の canonical SHA、signoff が申告した
 * reviewer から組む。
 */
export function createNarratedReviewAttestationSubject({
  jobId,
  identityDigest,
  videoSha256,
  contactSheetSha256,
  signoffBodySha256,
  reviewer,
} = {}) {
  return freezeSubject({
    version: NARRATED_REVIEW_ATTESTATION_VERSION,
    harnessId: NARRATED_STORY_HARNESS_ID,
    jobId,
    identityDigest,
    videoSha256,
    contactSheetSha256,
    signoffBodySha256,
    reviewerId: reviewer?.id,
    reviewerContextId: reviewer?.contextId,
  });
}

/**
 * narrated signoff 本文の canonical SHA。reviewerAttestation だけを除く（署名が
 * 自分自身を含めない）。JSON 往復で undefined を落とし、file から読んだ写しと
 * in-memory の原本が同じ digest になるようにする。
 */
export function narratedSignoffBodySha256(signoff) {
  if (!isPlainObject(signoff)) throw new Error("narrated-signoff-invalid");
  const body = JSON.parse(JSON.stringify(signoff));
  delete body.reviewerAttestation;
  return sha256(canonicalJson(body));
}

/** narrated signoff の reviewer 申告（文字列 / object の両形を受ける）。 */
export function narratedSignoffReviewer(signoff) {
  const reviewer = signoff?.reviewer;
  const id = typeof reviewer === "string" ? reviewer : (typeof reviewer?.id === "string" ? reviewer.id : "");
  const contextId = typeof signoff?.reviewerContextId === "string"
    ? signoff.reviewerContextId
    : (typeof reviewer?.contextId === "string" ? reviewer.contextId : "");
  return { id, contextId };
}

function trustFailure(detail) {
  return new Error(`reviewer-trust-invalid:${detail}`);
}

function ed25519PublicKey(pem, detail) {
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    throw trustFailure(`${detail}:public-key-unparseable`);
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw trustFailure(`${detail}:not-ed25519`);
  return key;
}

/**
 * 信頼リストを検査して索引化する。entry の keyId は公開鍵から導いた fingerprint と
 * 一致しなければならない。alias を許すと、別鍵の entry に既知の keyId を書いて
 * 差し替えられる。
 */
export function normalizeReviewerTrust(raw) {
  if (!isPlainObject(raw)) throw trustFailure("not-an-object");
  if (raw.version !== REVIEWER_TRUST_VERSION) throw trustFailure("version-unsupported");
  if (!Array.isArray(raw.reviewers) || raw.reviewers.length === 0) throw trustFailure("reviewers-empty");
  const reviewers = new Map();
  raw.reviewers.forEach((entry, index) => {
    const detail = `reviewers[${index}]`;
    if (!isPlainObject(entry)) throw trustFailure(`${detail}:not-an-object`);
    if (typeof entry.keyId !== "string" || !KEY_ID.test(entry.keyId)) throw trustFailure(`${detail}:key-id-invalid`);
    // PEM は末尾改行を含むのが正規。正規形の判定は keyId（fingerprint）側で行う。
    if (typeof entry.publicKeyPem !== "string" || !entry.publicKeyPem.trim()) throw trustFailure(`${detail}:public-key-missing`);
    const publicKey = ed25519PublicKey(entry.publicKeyPem, detail);
    if (publicKeyId(publicKey) !== entry.keyId) throw trustFailure(`${detail}:key-id-fingerprint-mismatch`);
    if (!TRUST_STATUSES.includes(entry.status)) throw trustFailure(`${detail}:status-invalid`);
    if (entry.status === "revoked") {
      if (!Number.isFinite(Date.parse(entry.revokedAt || ""))) throw trustFailure(`${detail}:revoked-at-missing`);
      if (!canonicalText(entry.reason)) throw trustFailure(`${detail}:revocation-reason-missing`);
    }
    if (reviewers.has(entry.keyId)) throw trustFailure(`${detail}:duplicate-key-id`);
    reviewers.set(entry.keyId, Object.freeze({
      keyId: entry.keyId,
      publicKey,
      label: typeof entry.label === "string" ? entry.label.trim() : "",
      status: entry.status,
      revokedAt: entry.status === "revoked" ? new Date(entry.revokedAt).toISOString() : "",
      reason: entry.status === "revoked" ? entry.reason.trim() : "",
    }));
  });
  return Object.freeze({
    version: REVIEWER_TRUST_VERSION,
    sha256: sha256(canonicalJson(raw)),
    reviewers,
  });
}
export const normalizeKoyaReviewerTrust = normalizeReviewerTrust;

function envText(env, name) {
  return typeof env?.[name] === "string" ? env[name].trim() : "";
}

function unconfiguredError(explicitGiven = false) {
  return new Error(
    `${REVIEWER_TRUST_UNCONFIGURED_CODE}: reviewer の信頼リストが未設定。${REVIEWER_TRUST_PATH_ENV}`
    + `（JSON file の path）または ${REVIEWER_TRUST_JSON_ENV}（inline JSON）を、運営者（owner）が監査・Receipt を実行する側へ`
    + "別経路で設定すること。signoff 内の鍵は信頼しない。"
    + (explicitGiven
      ? " 明示した --reviewer-trust-path / reviewerTrustPath / trust object は環境変数との照合にだけ使い、それ単独では信頼アンカーにならない（要求側の入力だけで信頼リストを立てると attestation が自己承認へ退化する）。"
      : ""),
  );
}

/**
 * 環境変数から信頼リストの置き場を読む。新名と旧名（KOYA_）の両方が設定され値が違えば、
 * どちらが効いているのか分からない状態なので env-ambiguous で拒否する。
 * 未設定なら null（呼び出し側が fail-closed にする）。
 */
export function reviewerTrustEnvSource(env = process.env) {
  const pick = (generic, legacy, label) => {
    const a = envText(env, generic);
    const b = envText(env, legacy);
    if (a && b && a !== b) throw trustFailure(`env-ambiguous:${label}`);
    return a || b;
  };
  const inline = pick(REVIEWER_TRUST_JSON_ENV, KOYA_REVIEWER_TRUST_JSON_ENV, "json");
  const path = pick(REVIEWER_TRUST_PATH_ENV, KOYA_REVIEWER_TRUST_PATH_ENV, "path");
  if (!inline && !path) return null;
  return inline ? { trustJson: inline } : { trustPath: path };
}

/**
 * channelPackEnvelope.trustedChannelPackKeyFromEnvironment と同じ流儀の位置決め。
 * 未設定は throw（reviewer-trust-unconfigured）。
 */
export function trustedReviewerTrustFromEnvironment(env = process.env) {
  const source = reviewerTrustEnvSource(env);
  if (!source) throw unconfiguredError(false);
  return source;
}
export const trustedKoyaReviewerTrustFromEnvironment = trustedReviewerTrustFromEnvironment;

/**
 * path / inline JSON から信頼リストを読んで正規化する。読めなかった path の文字列は
 * 例外に載せない（例外文はそのまま durable Job・ログへ残るため。R5-4）。
 */
async function readTrustSource({ trustPath = "", trustJson = "" }, label) {
  let text = trustJson;
  if (!text) {
    try {
      text = await readFile(resolve(trustPath), "utf8");
    } catch (error) {
      throw new Error(`${REVIEWER_TRUST_UNREADABLE_CODE}: ${label} の信頼リスト file を読めない (${error?.code || "error"})。`);
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw trustFailure("json-unparseable");
  }
  return normalizeReviewerTrust(parsed);
}

function normalizedTrustObject(trust) {
  if (trust && trust.version === REVIEWER_TRUST_VERSION && trust.reviewers instanceof Map && canonicalSha256(trust.sha256)) return trust;
  return normalizeReviewerTrust(trust);
}

/**
 * 信頼アンカー規則の唯一の実装。
 *
 * - 環境変数（運営者が配る）が唯一の信頼アンカー。未設定なら、明示入力があっても
 *   reviewer-trust-unconfigured で fail-closed
 * - 明示入力（in-memory object / path / inline JSON）は照合用。環境変数の信頼リストと
 *   canonical sha256 が一致しなければ reviewer-trust-conflict
 * - 一致すれば環境変数側の信頼リストを返す（要求側の写しではなく運営者側を採る）
 *
 * Job 層・CLI・MCP adapter・Receipt は全てここを呼ぶ。呼び出し側は失敗理由コードを gate に載せる。
 */
export async function loadReviewerTrust({
  trust = null,
  trustPath = "",
  trustJson = "",
  env = process.env,
} = {}) {
  const explicit = [];
  if (trust) explicit.push({ label: "trust object", load: async () => normalizedTrustObject(trust) });
  if (canonicalText(trustPath)) explicit.push({ label: "explicit path", load: () => readTrustSource({ trustPath }, "明示 path") });
  if (canonicalText(trustJson)) explicit.push({ label: "explicit inline JSON", load: () => readTrustSource({ trustJson }, "明示 inline JSON") });
  const envSource = reviewerTrustEnvSource(env);
  if (!envSource) throw unconfiguredError(explicit.length > 0);
  const operator = await readTrustSource(envSource, `環境変数 ${envSource.trustJson ? REVIEWER_TRUST_JSON_ENV : REVIEWER_TRUST_PATH_ENV}`);
  for (const candidate of explicit) {
    const requested = await candidate.load();
    if (requested.sha256 !== operator.sha256) {
      throw new Error(
        `${REVIEWER_TRUST_CONFLICT_CODE}: 明示した信頼リスト（${candidate.label}, sha256 ${requested.sha256.slice(0, 16)}…）が`
        + `環境変数 ${REVIEWER_TRUST_PATH_ENV} の信頼リスト（sha256 ${operator.sha256.slice(0, 16)}…）と一致しない。`
        + "運営者の環境変数が唯一の信頼アンカーで、要求側の入力で上書きしない。明示入力を外すか同じ内容を指すこと。",
      );
    }
  }
  return operator;
}
export const loadKoyaReviewerTrust = loadReviewerTrust;

/** 信頼リストの失敗理由コードだけを取り出す（メッセージ本文はログに残さない）。 */
export function reviewerTrustFailureCode(error) {
  const message = String(error?.message || error || "");
  const match = message.match(/^(reviewer-trust-[a-z-]+(?::[^\s,]+)?)/u);
  return match ? match[1] : "reviewer-trust-unconfigured";
}

/** 信頼リスト内の active な reviewer 鍵の数。 */
export function activeReviewerCount(trust) {
  if (!trust || !(trust.reviewers instanceof Map)) return 0;
  let count = 0;
  for (const entry of trust.reviewers.values()) if (entry?.status === "active") count += 1;
  return count;
}

/**
 * 有料生成の**前**に信頼アンカーを確かめる preflight（R6-1）。
 *
 * これまで fail-closed は「明示 path を渡したとき」と「Receipt 確定時」にだけ効いていたので、
 * env 未設定・env-ambiguous の host では有料生成が丸ごと走ってから Receipt 確定で止まっていた。
 * ここは loadReviewerTrust（信頼アンカー規則の唯一の実装）を呼び、さらに
 * 「reviewers に active な鍵が 1 件以上ある」ことまで確かめる——全件 revoked のリストは
 * 読めても signoff を 1 件も受け付けられず、やはり生成後に止まる。
 *
 * 戻り値は throw せず `{ ok, code, detail, activeReviewers, sha256, source }`。detail に path 文字列は
 * 載せない（loadReviewerTrust の例外文も path を含まない）。呼び出し側:
 *   - videoHarnessService.start(confirmed) / resume: ok でなければ Job を作らず code で止める
 *   - videoHarnessService.start(plan-only): 警告として結果に載せる
 *   - harness-doctor: `reviewer-trust` 項目（ハーネス指定時は必須）
 */
export async function preflightReviewerTrust({
  trustPath = "",
  env = process.env,
  loadTrust = loadReviewerTrust,
} = {}) {
  let source = "";
  try {
    const envSource = reviewerTrustEnvSource(env);
    source = envSource ? (envSource.trustJson ? "json" : "path") : "";
  } catch {
    source = "ambiguous";
  }
  try {
    const trust = await loadTrust({ trustPath: canonicalText(trustPath) ? trustPath : "", env });
    const active = activeReviewerCount(trust);
    if (active < 1) {
      return {
        ok: false,
        code: REVIEWER_TRUST_NO_ACTIVE_CODE,
        detail: `${REVIEWER_TRUST_NO_ACTIVE_CODE}: 信頼リストは読めたが status=active の reviewer 鍵が 1 件も無い（全件 revoked）。この状態では signoff を 1 件も受理できず、有料生成を終えてから Receipt 確定で止まる。`,
        activeReviewers: 0,
        sha256: trust.sha256,
        source,
      };
    }
    return { ok: true, code: "", detail: "", activeReviewers: active, sha256: trust.sha256, source };
  } catch (error) {
    return {
      ok: false,
      code: reviewerTrustFailureCode(error),
      detail: String(error?.message || error || ""),
      activeReviewers: 0,
      sha256: "",
      source,
    };
  }
}

async function readPrivateKeyPem({ pem = "", path = "" }) {
  if (typeof pem === "string" && pem.trim()) return pem;
  if (!canonicalText(path)) throw new Error("reviewer-private-key-missing: reviewer の Ed25519 秘密鍵は path で指定すること。鍵の中身を引数に書かない。");
  return readFile(resolve(path), "utf8");
}

function ed25519PrivateKey(pem) {
  let key;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error("reviewer-private-key-invalid: Ed25519 の PEM として読めない。");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("reviewer-private-key-invalid: Ed25519 以外の鍵は使えない。");
  return key;
}

function lookupTrustedReviewer(trust, keyId) {
  if (!trust || !(trust.reviewers instanceof Map)) return { failures: ["reviewer-trust-unconfigured"], entry: null };
  const entry = trust.reviewers.get(keyId) || null;
  if (!entry) return { failures: ["reviewer-key-untrusted"], entry: null };
  if (entry.status === "revoked") return { failures: ["reviewer-key-revoked"], entry };
  if (entry.status !== "active") return { failures: ["reviewer-key-inactive"], entry };
  return { failures: [], entry };
}

function attestationBody(attestation) {
  const body = structuredClone(attestation);
  delete body.signature;
  return body;
}

/**
 * reviewer が自分の秘密鍵で subject に署名する。鍵は信頼リストに active で
 * 登録済みでなければならない。未登録・失効鍵で作った attestation は監査で必ず
 * 落ちるので、ここで先に止める。attestation.version は subject のハーネスで決まる。
 */
export async function createReviewAttestation({
  subject,
  privateKeyPem = "",
  privateKeyPath = "",
  trust,
  signedAt = new Date().toISOString(),
} = {}) {
  const subjectFailures = subjectFieldFailures(subject, "reviewer-attestation-subject");
  if (subjectFailures.length > 0) throw new Error(subjectFailures.join(", "));
  if (!Number.isFinite(Date.parse(signedAt))) throw new Error("reviewer-attestation-signed-at-invalid");
  const privateKey = ed25519PrivateKey(await readPrivateKeyPem({ pem: privateKeyPem, path: privateKeyPath }));
  const keyId = publicKeyId(createPublicKey(privateKey));
  const trusted = lookupTrustedReviewer(trust, keyId);
  if (trusted.failures.length > 0) {
    throw new Error(`${trusted.failures[0]}: reviewer 鍵 ${keyId} は信頼リストで有効ではない。`);
  }
  const body = {
    version: schemaFor(subject.harnessId).version,
    subject: { ...subject },
    signer: { algorithm: "Ed25519", keyId },
    signedAt: new Date(signedAt).toISOString(),
  };
  const signature = cryptoSign(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64url");
  return { ...body, signature };
}
export const createKoyaReviewAttestation = createReviewAttestation;

/**
 * 監査と Receipt の両方がこの 1 関数で再検証する。失敗理由コードを列挙して返し、
 * 例外は投げない（gate 側が並べて記録する）。公開鍵は信頼リストからだけ取る。
 * 署名済み subject は「期待 subject のハーネス」の schema で検査する。別ハーネスの
 * attestation を持ち込めば version-unsupported と field 不一致で落ちる。
 */
export function verifyReviewAttestation(attestation, { expectedSubject, trust } = {}) {
  const result = { pass: false, failures: [], signerKeyId: "", reviewerLabel: "", trustSha256: trust?.sha256 || "" };
  if (attestation === null || attestation === undefined) {
    result.failures.push("reviewer-attestation-missing");
    return result;
  }
  if (!isPlainObject(attestation)) {
    result.failures.push("reviewer-attestation-invalid");
    return result;
  }
  const expectedFailures = subjectFieldFailures(expectedSubject, "reviewer-attestation-expected-subject");
  const schema = expectedFailures.length === 0 ? schemaFor(expectedSubject.harnessId) : null;
  const versionOk = schema
    ? attestation.version === schema.version
    : KNOWN_ATTESTATION_VERSIONS.includes(attestation.version);
  if (!versionOk) result.failures.push("reviewer-attestation-version-unsupported");
  const signer = attestation.signer;
  if (!isPlainObject(signer) || signer.algorithm !== "Ed25519" || typeof signer.keyId !== "string" || !KEY_ID.test(signer.keyId)) {
    result.failures.push("reviewer-attestation-signer-invalid");
  } else {
    result.signerKeyId = signer.keyId;
  }
  if (typeof attestation.signedAt !== "string" || !Number.isFinite(Date.parse(attestation.signedAt))) {
    result.failures.push("reviewer-attestation-signed-at-invalid");
  }
  result.failures.push(...expectedFailures);
  const signedFailures = subjectFieldFailures(attestation.subject, "reviewer-attestation-subject", schema);
  result.failures.push(...signedFailures);
  if (schema && isPlainObject(attestation.subject)) {
    for (const field of schema.fields) {
      if (attestation.subject[field] !== expectedSubject[field]) {
        result.failures.push(`reviewer-attestation-subject-mismatch:${field}`);
      }
    }
    if (signedFailures.length === 0 && canonicalJson(attestation.subject) !== canonicalJson(expectedSubject)) {
      result.failures.push("reviewer-attestation-subject-mismatch:shape");
    }
  }
  let publicKey = null;
  if (result.signerKeyId) {
    const trusted = lookupTrustedReviewer(trust, result.signerKeyId);
    result.failures.push(...trusted.failures);
    if (trusted.entry) {
      publicKey = trusted.entry.publicKey;
      result.reviewerLabel = trusted.entry.label;
    }
  }
  if (publicKey) {
    let signature = Buffer.alloc(0);
    if (typeof attestation.signature === "string" && attestation.signature.length > 0) {
      try { signature = Buffer.from(attestation.signature, "base64url"); } catch { signature = Buffer.alloc(0); }
    }
    let verified = false;
    if (signature.length > 0) {
      try {
        verified = cryptoVerify(null, Buffer.from(canonicalJson(attestationBody(attestation))), publicKey, signature);
      } catch {
        verified = false;
      }
    }
    if (!verified) result.failures.push("reviewer-attestation-signature-invalid");
  }
  result.failures = [...new Set(result.failures)];
  result.pass = result.failures.length === 0;
  return result;
}
export const verifyKoyaReviewAttestation = verifyReviewAttestation;

/**
 * narrated-story-video の外部 signoff に reviewer attestation を付ける。生成側は
 * この関数を呼ばない（signoff を書くのは別 context の reviewer だけ）。既存の
 * reviewerAttestation は本文から除いて署名し直す。
 */
export async function signNarratedReviewSignoff({
  signoff,
  jobId,
  identityDigest,
  privateKeyPem = "",
  privateKeyPath = "",
  trust,
  signedAt = new Date().toISOString(),
} = {}) {
  if (!isPlainObject(signoff)) throw new Error("narrated-signoff-invalid");
  const body = JSON.parse(JSON.stringify(signoff));
  delete body.reviewerAttestation;
  const subject = createNarratedReviewAttestationSubject({
    jobId,
    identityDigest,
    videoSha256: body.videoSha256,
    contactSheetSha256: body.contactSheetSha256,
    signoffBodySha256: narratedSignoffBodySha256(body),
    reviewer: narratedSignoffReviewer(body),
  });
  const reviewerAttestation = await createReviewAttestation({ subject, privateKeyPem, privateKeyPath, trust, signedAt });
  const check = verifyReviewAttestation(reviewerAttestation, { expectedSubject: subject, trust });
  if (!check.pass) throw new Error(`reviewer-attestation-self-check-failed: ${check.failures.join(", ")}`);
  return { ...body, reviewerAttestation };
}

/**
 * narrated signoff の attestation を、呼び出し側の真値（Job id / identityDigest、
 * disk から計算した MP4 / contact sheet SHA）から組んだ期待 subject で再検証する。
 * signoff の申告値（videoSha256 等）は期待側に使わない。
 */
export function verifyNarratedReviewSignoff(signoff, {
  jobId,
  identityDigest,
  videoSha256,
  contactSheetSha256,
  trust,
} = {}) {
  const failed = (codes) => ({
    pass: false,
    failures: [...new Set(codes)],
    signerKeyId: "",
    reviewerLabel: "",
    trustSha256: trust?.sha256 || "",
  });
  if (!isPlainObject(signoff)) return failed(["narrated-signoff-invalid"]);
  let expectedSubject;
  try {
    expectedSubject = createNarratedReviewAttestationSubject({
      jobId,
      identityDigest,
      videoSha256,
      contactSheetSha256,
      signoffBodySha256: narratedSignoffBodySha256(signoff),
      reviewer: narratedSignoffReviewer(signoff),
    });
  } catch (error) {
    return failed(expectedSubjectFailureCodes(error));
  }
  return verifyReviewAttestation(signoff.reviewerAttestation, { expectedSubject, trust });
}

/** reviewer 鍵ペアを作る補助。秘密鍵の保存と権限は呼び出し側（CLI）が扱う。 */
export function generateReviewerKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    keyId: publicKeyId(publicKey),
  };
}
export const generateKoyaReviewerKeyPair = generateReviewerKeyPair;

async function pathExists(path) {
  try { await access(path); return true; } catch { return false; }
}

/**
 * 末尾 component が存在するか（symlink 自体を含む）。access() は symlink を辿るので、
 * 先の無い（dangling）symlink を「無い」と答え、その後の wx 書き込みが生の EEXIST で落ちる（R6-4）。
 */
async function entryExists(path) {
  try { await lstat(path); return true; } catch { return false; }
}

/** 末尾 component が symlink なら、その指す先（絶対 path・未解決）を返す。そうでなければ ""。 */
async function symlinkTargetOf(path) {
  try {
    const info = await lstat(path);
    if (!info.isSymbolicLink()) return "";
    return resolve(dirname(path), await readlink(path));
  } catch {
    return "";
  }
}

/** macOS（APFS/HFS+ 既定）と Windows は大文字小文字を区別しない。 */
export const CASE_INSENSITIVE_FILE_SYSTEM = process.platform === "darwin" || process.platform === "win32";

function foldCase(path, caseInsensitive) {
  return caseInsensitive ? path.toLowerCase() : path;
}

function isInside(path, root, { caseInsensitive = CASE_INSENSITIVE_FILE_SYSTEM } = {}) {
  const target = foldCase(resolve(path), caseInsensitive);
  const base = foldCase(resolve(root), caseInsensitive);
  return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

async function nearestExistingDirectory(path) {
  let current = resolve(path);
  // 鍵 file 自身はまだ無いので、実在する最寄りの祖先から git を問う。
  while (!(await pathExists(current))) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/**
 * symlink を解いた正規 path。まだ存在しない末尾は、実在する最寄りの祖先を realpath
 * したものに残りの segment を継ぐ。`/tmp/link/key.pem`（link → リポジトリ）のような
 * 置き場は、resolve だけでは repo 配下と分からない（F-1）。
 */
async function canonicalizePath(path) {
  const target = resolve(path);
  const existing = await nearestExistingDirectory(target);
  let real = existing;
  try {
    real = realpathSync.native(existing);
  } catch {
    real = existing;
  }
  if (existing === target) return real;
  const remainder = [];
  let cursor = target;
  while (cursor !== existing) {
    remainder.unshift(basename(cursor));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return join(real, ...remainder);
}

async function defaultDetectGitToplevel(directory) {
  try {
    const { stdout } = await execFile("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
      timeout: 10_000,
      windowsHide: true,
    });
    const top = String(stdout || "").trim();
    return top ? resolve(top) : "";
  } catch {
    return "";
  }
}

/**
 * reviewer 秘密鍵の置き場を検査する。リポジトリ配下（このリポジトリ、projectDir、
 * git rev-parse --show-toplevel が返す作業ツリー）への書き込みは拒否する。
 * 秘密鍵が `git add -A` で公開リポジトリへ入る事故を、.gitignore の *.pem だけに
 * 頼らず入口で止める。理由コードは reviewer-key-path-inside-repository。
 */
export async function assertReviewerKeyPathOutsideRepository(path, {
  projectDir = "",
  repositoryRoots = [REPO_ROOT],
  detectGitToplevel = defaultDetectGitToplevel,
  caseInsensitive = CASE_INSENSITIVE_FILE_SYSTEM,
} = {}) {
  const target = resolve(path);
  if (!isAbsolute(String(path || "")) ) {
    throw new Error(`reviewer-key-path-not-absolute: reviewer 鍵の path は絶対 path で指定すること: ${path}`);
  }
  // symlink と大文字小文字違い（case-insensitive FS）で素通りしないよう、target も
  // 各 root も realpath へ正規化して比べる。表記どおりの path でも一度は比べる。
  const canonicalTarget = await canonicalizePath(target);
  // 末尾 component 自身が symlink（先が無い dangling を含む）なら、指す先も同じ検査に掛ける。
  // realpath は dangling を解けないので、canonicalizePath だけでは link 先がリポジトリ内でも見えない（R6-4）。
  const linkTarget = await symlinkTargetOf(target);
  const candidates = [target, canonicalTarget];
  if (linkTarget) candidates.push(linkTarget, await canonicalizePath(linkTarget));
  const compare = { caseInsensitive };
  const roots = [...repositoryRoots, ...(canonicalText(projectDir) ? [projectDir] : [])].filter(Boolean);
  for (const root of roots) {
    const canonicalRoot = await canonicalizePath(root);
    const hit = candidates.some((candidate) => isInside(candidate, root, compare) || isInside(candidate, canonicalRoot, compare));
    if (hit) {
      throw new Error(`reviewer-key-path-inside-repository: reviewer 鍵をリポジトリ／project 配下へ書かない: ${target}（${canonicalRoot} 配下${linkTarget ? "・symlink 先を含む" : ""}）`);
    }
  }
  for (const probe of [canonicalTarget, ...(linkTarget ? [await canonicalizePath(linkTarget)] : [])]) {
    const gitTop = await detectGitToplevel(await nearestExistingDirectory(dirname(probe)));
    if (!gitTop) continue;
    const canonicalGitTop = await canonicalizePath(gitTop);
    if (candidates.some((candidate) => isInside(candidate, gitTop, compare) || isInside(candidate, canonicalGitTop, compare))) {
      throw new Error(`reviewer-key-path-inside-repository: reviewer 鍵を git 作業ツリー配下へ書かない: ${target}（${canonicalGitTop} 配下${linkTarget ? "・symlink 先を含む" : ""}）`);
    }
  }
  return target;
}

/**
 * reviewer 鍵ペアを file へ書く。両ハーネスの CLI（reviewer-key-create）が呼ぶ
 * 唯一の実装。秘密鍵は 0600・公開鍵は 0644、どちらも既存 file を上書きしない。
 * 先に両 path の存在を検査してから書く（公開鍵側の EEXIST で秘密鍵だけ残る事故を防ぐ）。
 * 置き場はリポジトリ／project 配下を拒否する。
 */
export async function writeReviewerKeyPairFiles({
  privateKeyPath,
  publicKeyPath = "",
  label = "",
  projectDir = "",
  repositoryRoots,
  detectGitToplevel,
  caseInsensitive,
} = {}) {
  if (!canonicalText(privateKeyPath)) {
    throw new Error("reviewer-key-path-missing: reviewer-key-create requires --reviewer-key-path FILE (the private key is written there, never printed).");
  }
  const constraint = {
    projectDir,
    ...(repositoryRoots ? { repositoryRoots } : {}),
    ...(detectGitToplevel ? { detectGitToplevel } : {}),
    ...(typeof caseInsensitive === "boolean" ? { caseInsensitive } : {}),
  };
  const privatePath = await assertReviewerKeyPathOutsideRepository(privateKeyPath, constraint);
  const publicPath = await assertReviewerKeyPathOutsideRepository(
    canonicalText(publicKeyPath) ? publicKeyPath : `${privatePath}.pub`,
    constraint,
  );
  if (privatePath === publicPath) throw new Error("reviewer-key-path-conflict: 秘密鍵と公開鍵の path が同じ。");
  for (const existing of [privatePath, publicPath]) {
    // lstat で見る: 先の無い symlink も「既に何かがある」——wx 書き込みが生の EEXIST で落ちる前に
    // 理由コード付きで止める（R6-4）。
    if (await entryExists(existing)) {
      throw new Error(`reviewer-key-path-exists: 既存の鍵 file（symlink を含む）を上書きしない: ${existing}`);
    }
  }
  const pair = generateReviewerKeyPair();
  await mkdir(dirname(privatePath), { recursive: true });
  await mkdir(dirname(publicPath), { recursive: true });
  // wx: 存在検査と書き込みの間に現れた file も上書きしない。
  await writeFile(privatePath, pair.privateKeyPem, { flag: "wx", mode: 0o600 });
  await writeFile(publicPath, pair.publicKeyPem, { flag: "wx", mode: 0o644 });
  return {
    keyId: pair.keyId,
    privateKeyPath: privatePath,
    publicKeyPath: publicPath,
    trustListVersion: REVIEWER_TRUST_VERSION,
    trustEntry: createReviewerTrustEntry({ publicKeyPem: pair.publicKeyPem, label }),
  };
}

/** 信頼リストへ貼る entry。運営者が別経路で配布・保存する。 */
export function createReviewerTrustEntry({ publicKeyPem, label = "" } = {}) {
  const publicKey = ed25519PublicKey(publicKeyPem, "entry");
  return {
    keyId: publicKeyId(publicKey),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    label: typeof label === "string" ? label.trim() : "",
    status: "active",
  };
}
export const createKoyaReviewerTrustEntry = createReviewerTrustEntry;
