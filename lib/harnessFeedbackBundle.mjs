// 運営者環境からBuzzAssist管理側へ返す、redact済み・署名付きfeedback bundle。
// 台本本文、Channel Pack本文、provider response、秘密は受け取らず、改善提案IDと
// 実測gateの指紋だけを運ぶ。署名検証鍵はbundle外の信頼経路から渡す。

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "./canvasScene.mjs";
import { canonicalJson, publicKeyId } from "./channelPackEnvelope.mjs";

export const HARNESS_FEEDBACK_BUNDLE_VERSION = "buzzassist-harness-feedback-v2";
export const HARNESS_FEEDBACK_MAX_BUNDLE_BYTES = 1024 * 1024;
export const HARNESS_FEEDBACK_UNREGISTERED_DRAFT_VERSION = "buzzassist-feedback-unregistered-candidates-v1";
/** 配布物に同梱する、id・kind・targetだけの公開proposal catalog。 */
export const HARNESS_FEEDBACK_PUBLIC_CATALOG_RELATIVE_PATH = "docs/learning/proposals.public.jsonl";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const PROPOSAL_ID = /^[a-f0-9]{12}$/u;
const SHA256 = /^(?:sha256:)?[a-f0-9]{64}$/u;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,79}$/u;
const CREDENTIAL_LIKE_TEXT = /(?:sk-(?:proj|live|test)-[A-Za-z0-9_-]{8,}|\bBearer(?:[._-]|[ \t]+)[A-Za-z0-9._~-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)/iu;
const FORBIDDEN_KEY = /(?:script|prompt|transcript|channel.?pack.?body|secret|token|api.?key|private.?key|authorization|cookie|provider.?response|artifact.?url|local.?path)/iu;
const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const HARNESS_FEEDBACK_PUBLIC_CATALOG_PATH = join(MODULE_ROOT, HARNESS_FEEDBACK_PUBLIC_CATALOG_RELATIVE_PATH);
const FEEDBACK_KINDS = new Set(["correction", "preference", "constraint", "fact"]);
const FEEDBACK_SOURCE_HOSTS = new Set(["claude-code", "codex"]);
const TARGET_ALIASES = new Map([
  ["skill:manga-video-production", "genre:manga-video-production"],
  ["skill:manga-page-camera", "genre:manga-page-camera"],
  ["skill:harness-parallel-execution", "platform:harness-parallel-execution"],
  ["skill:harness-self-improvement", "platform:harness-self-improvement"],
  ["ledger:koya", "channel-pack:koya"],
  ["doc:mike-audio-gates", "channel-pack:narrated-story"],
]);

function loadSemanticRegistry() {
  const targetsDocument = JSON.parse(readFileSync(join(MODULE_ROOT, "docs/learning/targets.json"), "utf8"));
  const targets = new Set(Object.keys(targetsDocument?.targets || {}));
  const harnesses = new Map();
  for (const fileName of ["koya-manga-video.harness.json", "narrated-story-video.harness.json"]) {
    const declaration = JSON.parse(readFileSync(join(MODULE_ROOT, "config/harnesses", fileName), "utf8"));
    harnesses.set(declaration.id, {
      gateIds: new Set((declaration.guarantees || []).map((entry) => entry.id)),
    });
  }
  return { targets, harnesses };
}

const SEMANTIC_REGISTRY = loadSemanticRegistry();

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function feedbackProposalId({ kind, target, text } = {}) {
  return sha256([String(kind || ""), String(target || ""), String(text || "")].join("\u001f")).slice(0, 12);
}

export function normalizeHarnessFeedbackTarget(value) {
  const original = nonEmpty(value);
  const target = TARGET_ALIASES.get(original) || original;
  if (!SEMANTIC_REGISTRY.targets.has(target)) throw new Error("proposal.targetが既知のlearning targetではない。");
  return target;
}

function cleanProposalId(value) {
  const text = nonEmpty(value);
  if (!PROPOSAL_ID.test(text)) throw new Error("proposal.idは内容由来の12桁lowercase hexであること。");
  return text;
}

function cleanEnum(value, allowed, label) {
  const text = nonEmpty(value);
  if (!allowed.has(text)) throw new Error(`${label}が既知の列挙値ではない。`);
  return text;
}

function cleanId(value, label, { optional = false } = {}) {
  const text = nonEmpty(value);
  if (!text && optional) return null;
  if (!ID.test(text)) throw new Error(`${label}が不正。`);
  return text;
}

function cleanVersion(value, label) {
  const text = nonEmpty(value);
  if (!VERSION.test(text)) throw new Error(`${label}が不正。`);
  return text;
}

function cleanBuildLabel(value, label, cleaner) {
  const text = cleaner(value, label);
  if (CREDENTIAL_LIKE_TEXT.test(text)) {
    throw new Error(`${label}にcredentialらしい値を含められない。`);
  }
  return text;
}

function cleanTimestamp(value, label) {
  const text = nonEmpty(value);
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new Error(`${label}はISO-8601 timestampであること。`);
  }
  return text;
}

function cleanCount(value, label, { fallback = 0, minimum = 0, maximum = 1_000_000_000 } = {}) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error(`${label}は${minimum}..${maximum}の整数であること。`);
  }
  return candidate;
}

function cleanSha(value, label, { optional = false } = {}) {
  const text = nonEmpty(value).toLowerCase();
  if (!text && optional) return null;
  if (!SHA256.test(text)) throw new Error(`${label}はSHA-256であること。`);
  return text.replace(/^sha256:/u, "");
}

function strictKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}はobjectであること。`);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`${label}に未許可field: ${unexpected.join(", ")}`);
}

function assertNoForbiddenKeys(value, location = "bundle") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, `${location}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    const isNegativePrivacyDeclaration = location === "bundle.privacy"
      && key.startsWith("contains")
      && nested === false;
    if (!isNegativePrivacyDeclaration && FORBIDDEN_KEY.test(key)) {
      throw new Error(`${location}.${key}はfeedback bundleへ含められない。`);
    }
    assertNoForbiddenKeys(nested, `${location}.${key}`);
  }
}

function normalizedProposal(entry, { strict = false, fromCurator = false } = {}) {
  if (strict) {
    strictKeys(entry, ["id", "kind", "target", "occurrences", "occurrenceDigests", "evidenceDigests"], "proposal");
  }
  if (!Array.isArray(entry?.evidenceDigests)) throw new Error("proposal.evidenceDigestsはarrayであること。");
  if (!Array.isArray(entry?.occurrenceDigests)) throw new Error("proposal.occurrenceDigestsはarrayであること。");
  const id = cleanProposalId(entry?.id);
  const kind = cleanEnum(entry?.kind, FEEDBACK_KINDS, "proposal.kind");
  const originalTarget = nonEmpty(entry?.target);
  const target = normalizeHarnessFeedbackTarget(originalTarget);
  if (fromCurator && id !== feedbackProposalId({ kind, target: originalTarget, text: entry?.text })) {
    throw new Error("proposal.idがcurator本文の内容由来IDと一致しない。");
  }
  if (entry.evidenceDigests.length > 64) throw new Error("proposal.evidenceDigestsは64件以下であること。");
  if (entry.occurrenceDigests.length === 0 || entry.occurrenceDigests.length > 10_000) {
    throw new Error("proposal.occurrenceDigestsは1..10000件であること。");
  }
  const occurrenceDigests = [...new Set(entry.occurrenceDigests
    .map((digest) => cleanSha(digest, "proposal.occurrenceDigest")))].sort();
  const occurrences = cleanCount(entry?.occurrences, "proposal.occurrences", {
    fallback: occurrenceDigests.length,
    minimum: 1,
    maximum: 10_000,
  });
  if (occurrences !== occurrenceDigests.length) {
    throw new Error("proposal.occurrencesは一意なoccurrenceDigests件数と一致すること。");
  }
  return {
    id,
    kind,
    target,
    occurrences,
    occurrenceDigests,
    evidenceDigests: [...new Set((entry?.evidenceDigests || []).map((digest) => cleanSha(digest, "proposal.evidenceDigest")))].sort(),
  };
}

function normalizedGate(entry, { strict = false } = {}) {
  if (strict) {
    strictKeys(entry, ["harnessId", "harnessVersion", "declarationDigest", "gateId", "pass", "fail", "skip"], "gate");
  }
  const harnessId = cleanId(entry?.harnessId, "gate.harnessId");
  const harness = SEMANTIC_REGISTRY.harnesses.get(harnessId);
  if (!harness) throw new Error("gate.harnessIdが既知のHarnessではない。");
  const gateId = cleanId(entry?.gateId, "gate.gateId");
  if (!harness.gateIds.has(gateId)) throw new Error("gate.gateIdがHarness宣言の既知gateではない。");
  return {
    harnessId,
    harnessVersion: cleanVersion(entry?.harnessVersion, "gate.harnessVersion"),
    declarationDigest: cleanSha(entry?.declarationDigest, "gate.declarationDigest"),
    gateId,
    pass: cleanCount(entry?.pass, "gate.pass"),
    fail: cleanCount(entry?.fail, "gate.fail"),
    skip: cleanCount(entry?.skip, "gate.skip"),
  };
}

function compareText(left, right) {
  return left < right ? -1 : (left > right ? 1 : 0);
}

function feedbackSourceReportDigest(value) {
  return sha256(canonicalJson({
    version: HARNESS_FEEDBACK_BUNDLE_VERSION,
    sourceHost: value.sourceHost,
    build: value.build,
    proposals: value.proposals,
    observedGates: value.observedGates,
  }));
}

function assertUniqueIds(entries, label) {
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error(`${label} IDが重複している: ${entry.id}`);
    seen.add(entry.id);
  }
  return entries;
}

/**
 * 管理側のoperator enrollmentと端末側bundleが同じrelease tupleを比較するための
 * 唯一の正規化関数。digestだけでなく、全fieldをexact matchする。
 */
export function normalizeHarnessFeedbackBuild(value) {
  strictKeys(value, ["coreVersion", "harnessId", "harnessVersion", "skillDigests", "channelPack"], "build");
  strictKeys(value.channelPack, ["id", "version", "payloadSha256"], "build.channelPack");
  if (!Array.isArray(value.skillDigests)) throw new Error("build.skillDigestsはarrayであること。");
  if (value.skillDigests.length > 128) throw new Error("build.skillDigestsは128件以下であること。");
  return {
    coreVersion: cleanBuildLabel(value.coreVersion, "build.coreVersion", cleanVersion),
    harnessId: cleanEnum(value.harnessId, new Set(SEMANTIC_REGISTRY.harnesses.keys()), "build.harnessId"),
    harnessVersion: cleanBuildLabel(value.harnessVersion, "build.harnessVersion", cleanVersion),
    skillDigests: [...new Set(value.skillDigests.map((digest) => cleanSha(digest, "build.skillDigest")))].sort(compareText),
    channelPack: {
      id: cleanBuildLabel(value.channelPack.id, "build.channelPack.id", cleanId),
      version: cleanBuildLabel(value.channelPack.version, "build.channelPack.version", cleanVersion),
      payloadSha256: cleanSha(value.channelPack.payloadSha256, "build.channelPack.payloadSha256"),
    },
  };
}

function normalizeHarnessFeedbackPayload(value) {
  strictKeys(value, ["version", "generatedAt", "sourceHost", "build", "sourceReportSha256", "proposals", "observedGates", "privacy"], "payload");
  if (value.version !== HARNESS_FEEDBACK_BUNDLE_VERSION) throw new Error("feedback payload versionが不正。");
  strictKeys(
    value.privacy,
    ["containsRawText", "containsChannelPackPayload", "containsProviderCredentials", "containsProviderResponses"],
    "payload.privacy",
  );
  if (!Array.isArray(value.proposals)) throw new Error("payload.proposalsはarrayであること。");
  if (!Array.isArray(value.observedGates)) throw new Error("payload.observedGatesはarrayであること。");
  if (value.privacy.containsRawText !== false
    || value.privacy.containsChannelPackPayload !== false
    || value.privacy.containsProviderCredentials !== false
    || value.privacy.containsProviderResponses !== false) {
    throw new Error("feedback bundleのprivacy宣言がfail-closedではない。");
  }
  if (value.proposals.length > 1000) throw new Error("payload.proposalsは1000件以下であること。");
  if (value.observedGates.length > 100) throw new Error("payload.observedGatesは100件以下であること。");
  const proposals = assertUniqueIds(
    value.proposals.map((entry) => ({ ...normalizedProposal(entry, { strict: true }), id: cleanProposalId(entry?.id) })),
    "proposal",
  ).sort((left, right) => compareText(left.id, right.id));
  const observedGates = assertUniqueIds(
    value.observedGates.map((entry) => ({ ...normalizedGate(entry, { strict: true }), id: cleanId(entry?.gateId, "gate.gateId") })),
    "observed gate",
  ).map(({ id: _id, ...entry }) => entry)
    .sort((left, right) => compareText(left.gateId, right.gateId));
  const normalized = {
    version: HARNESS_FEEDBACK_BUNDLE_VERSION,
    generatedAt: cleanTimestamp(value.generatedAt, "payload.generatedAt"),
    sourceHost: cleanEnum(value.sourceHost, FEEDBACK_SOURCE_HOSTS, "payload.sourceHost"),
    build: normalizeHarnessFeedbackBuild(value.build),
    sourceReportSha256: cleanSha(value.sourceReportSha256, "payload.sourceReportSha256"),
    proposals,
    observedGates,
    privacy: {
      containsRawText: false,
      containsChannelPackPayload: false,
      containsProviderCredentials: false,
      containsProviderResponses: false,
    },
  };
  for (const gate of normalized.observedGates) {
    if (gate.harnessId !== normalized.build.harnessId) throw new Error("observed gateがpayload Harnessと一致しない。");
  }
  if (normalized.sourceReportSha256 !== feedbackSourceReportDigest(normalized)) {
    throw new Error("sourceReportSha256がsemantic feedback snapshotと一致しない。");
  }
  assertNoForbiddenKeys(normalized);
  return normalized;
}

/** Curator reportから本文を捨て、再現に必要な指紋だけの署名前payloadを作る。 */
export function buildHarnessFeedbackPayload({
  curatorReport,
  coreVersion,
  harnessId,
  harnessVersion,
  skillDigests = [],
  channelPack = {},
  sourceHost,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!curatorReport || curatorReport.readOnly !== true) throw new Error("read-only curator reportが要る。");
  if (!Array.isArray(curatorReport.pending) || !Array.isArray(curatorReport.observedGates)) {
    throw new Error("curator reportのpending/observedGatesはarrayであること。");
  }
  if (!Array.isArray(skillDigests)) throw new Error("skillDigestsはarrayであること。");
  const targetHarness = cleanEnum(harnessId, new Set(SEMANTIC_REGISTRY.harnesses.keys()), "harnessId");
  const payload = {
    version: HARNESS_FEEDBACK_BUNDLE_VERSION,
    generatedAt: cleanTimestamp(generatedAt, "generatedAt"),
    sourceHost: cleanEnum(sourceHost, FEEDBACK_SOURCE_HOSTS, "sourceHost"),
    build: {
      coreVersion: cleanVersion(coreVersion, "coreVersion"),
      harnessId: targetHarness,
      harnessVersion: cleanVersion(harnessVersion, "harnessVersion"),
      skillDigests: [...new Set(skillDigests.map((digest) => cleanSha(digest, "skillDigest")))].sort(),
      channelPack: {
        id: cleanId(channelPack?.id, "channelPack.id"),
        version: cleanVersion(channelPack?.version, "channelPack.version"),
        payloadSha256: cleanSha(channelPack?.payloadSha256, "channelPack.payloadSha256"),
      },
    },
    sourceReportSha256: "",
    proposals: (curatorReport.pending || [])
      .filter((entry) => Array.isArray(entry?.localOccurrenceDigests || entry?.occurrenceDigests)
        && (entry.localOccurrenceDigests || entry.occurrenceDigests).length > 0)
      .map((entry) => normalizedProposal({
        ...entry,
        occurrenceDigests: entry.localOccurrenceDigests || entry.occurrenceDigests,
        occurrences: (entry.localOccurrenceDigests || entry.occurrenceDigests).length,
      }, { fromCurator: true }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    observedGates: (curatorReport.observedGates || [])
      .filter((entry) => entry?.harnessId === targetHarness)
      .map(normalizedGate)
      .sort((left, right) => left.gateId.localeCompare(right.gateId)),
    privacy: {
      containsRawText: false,
      containsChannelPackPayload: false,
      containsProviderCredentials: false,
      containsProviderResponses: false,
    },
  };
  payload.sourceReportSha256 = feedbackSourceReportDigest(payload);
  return normalizeHarnessFeedbackPayload(payload);
}

function signedBody(bundle) {
  const clone = structuredClone(bundle);
  delete clone.signature;
  return clone;
}

/**
 * Networkへ出す前に使う、公開鍵を必要としないstrict transport validation。
 * 署名の本人性は管理側の登録済み公開鍵で別途検証する。この関数は、未許可field・
 * privacy違反・壊れた署名形を持つsigned-looking JSONを送信しないための境界である。
 */
export function validateHarnessFeedbackBundleForTransport(value) {
  strictKeys(value, ["version", "generatedAt", "sourceHost", "build", "sourceReportSha256", "proposals", "observedGates", "privacy", "signer", "signature"], "bundle");
  strictKeys(value.signer, ["algorithm", "keyId"], "bundle.signer");
  assertNoForbiddenKeys(value);
  const { signer: _signer, signature: _signature, ...payload } = value;
  const normalized = normalizeHarnessFeedbackPayload(payload);
  if (canonicalJson(payload) !== canonicalJson(normalized)) {
    throw new Error("feedback bundle payloadは正規化済みcanonical表現と完全一致すること。");
  }
  if (value.signer.algorithm !== "Ed25519") throw new Error("signer情報が不正。");
  const signerKeyId = cleanId(value.signer.keyId, "bundle.signer.keyId");
  if (value.signer.keyId !== signerKeyId) throw new Error("feedback signer key IDはcanonical表現であること。");
  const signatureText = nonEmpty(value.signature);
  const signature = Buffer.from(signatureText, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== signatureText) {
    throw new Error("feedback bundle署名の形式が不正。");
  }
  return {
    ok: true,
    harnessId: normalized.build.harnessId,
    coreVersion: normalized.build.coreVersion,
    signerKeyId,
    sourceReportSha256: normalized.sourceReportSha256,
  };
}

async function keyText({ pem = "", path = "", label }) {
  if (nonEmpty(pem)) return pem;
  if (!nonEmpty(path)) throw new Error(`${label}鍵をbundle外の経路で指定すること。`);
  return readFile(resolve(path), "utf8");
}

export async function signHarnessFeedbackBundle({
  payload,
  outputPath = "",
  privateKeyPem = "",
  privateKeyPath = "",
  keyId = "",
} = {}) {
  const normalized = normalizeHarnessFeedbackPayload(payload);
  const privateKey = createPrivateKey(await keyText({ pem: privateKeyPem, path: privateKeyPath, label: "秘密" }));
  const signerId = keyId ? cleanId(keyId, "signer.keyId") : publicKeyId(createPublicKey(privateKey));
  const body = { ...normalized, signer: { algorithm: "Ed25519", keyId: signerId } };
  const signature = cryptoSign(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64url");
  const bundle = { ...body, signature };
  if (nonEmpty(outputPath)) await writeJsonAtomic(resolve(outputPath), bundle);
  return bundle;
}

export async function verifyHarnessFeedbackBundle({
  bundle,
  bundlePath = "",
  trustedPublicKeyPem = "",
  trustedPublicKeyPath = "",
  expectedHarnessId = "",
  expectedCoreVersion = "",
} = {}) {
  const value = bundle || JSON.parse(await readFile(resolve(bundlePath), "utf8"));
  validateHarnessFeedbackBundleForTransport(value);
  const { signer: _signer, signature: _signature, ...payload } = value;
  const normalized = normalizeHarnessFeedbackPayload(payload);
  if (expectedHarnessId && normalized.build.harnessId !== expectedHarnessId) throw new Error("feedback bundleのHarnessが違う。");
  if (expectedCoreVersion && normalized.build.coreVersion !== expectedCoreVersion) throw new Error("feedback bundleのCore版が違う。");
  const publicKey = createPublicKey(await keyText({ pem: trustedPublicKeyPem, path: trustedPublicKeyPath, label: "信頼済み公開" }));
  const trustedId = publicKeyId(publicKey);
  if (String(value.signer.keyId).startsWith("ed25519:") && value.signer.keyId !== trustedId) {
    throw new Error("feedback signer key IDが信頼済み公開鍵と一致しない。");
  }
  const signature = Buffer.from(nonEmpty(value.signature), "base64url");
  if (signature.length === 0 || !cryptoVerify(null, Buffer.from(canonicalJson(signedBody(value))), publicKey, signature)) {
    throw new Error("feedback bundle署名が一致しない。");
  }
  return {
    ok: true,
    signerKeyId: value.signer.keyId,
    trustedPublicKeyId: trustedId,
    harnessId: normalized.build.harnessId,
    coreVersion: normalized.build.coreVersion,
    harnessVersion: normalized.build.harnessVersion,
    channelPackId: normalized.build.channelPack.id,
    channelPackVersion: normalized.build.channelPack.version,
    proposalCount: normalized.proposals.length,
    observedGateCount: normalized.observedGates.length,
    sourceReportSha256: normalized.sourceReportSha256,
  };
}

/**
 * 管理側が意味を知っているproposalの一覧。公開catalog（id/kind/target）でも
 * 共有ledger（本文つき）でも読めるが、使うのは3 fieldだけ。同じIDが別の
 * kind/targetを指していたら壊れているので読まない。
 */
export function parseHarnessFeedbackProposalCatalog(text) {
  const catalog = new Map();
  for (const [index, line] of String(text || "").split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); }
    catch { throw new Error(`proposal catalog ${index + 1}行目がJSONではない。`); }
    const id = nonEmpty(row?.id);
    if (!PROPOSAL_ID.test(id)) throw new Error(`proposal catalog ${index + 1}行目のID形式が不正。`);
    const semantic = {
      id,
      kind: cleanEnum(row?.kind, FEEDBACK_KINDS, `proposal catalog ${index + 1}行目のkind`),
      target: normalizeHarnessFeedbackTarget(row?.target),
    };
    const existing = catalog.get(id);
    if (existing && canonicalJson(existing) !== canonicalJson(semantic)) {
      throw new Error(`proposal catalogで同じIDが別semanticを指している: ${id}`);
    }
    catalog.set(id, semantic);
  }
  return catalog;
}

export async function loadHarnessFeedbackProposalCatalog(filePath = HARNESS_FEEDBACK_PUBLIC_CATALOG_PATH) {
  return parseHarnessFeedbackProposalCatalog(await readFile(resolve(filePath), "utf8"));
}

/**
 * curator reportのpendingを、管理側が知っているID（bundleへ入れられる）と
 * 知らないID（bundleへ入れても422で丸ごと拒否される）へ分ける。
 * kind/targetが食い違うIDは「知っている」扱いにしない——ingestが
 * semantic mismatchで拒否するのを端末側で先に見えるようにする。
 */
export function partitionCuratorPendingByCatalog({ curatorReport, catalog } = {}) {
  if (!curatorReport || !Array.isArray(curatorReport.pending)) throw new Error("curator reportのpendingはarrayであること。");
  if (!(catalog instanceof Map)) throw new Error("proposal catalogはMapであること。");
  const registered = [];
  const unregistered = [];
  const semanticMismatch = [];
  for (const entry of curatorReport.pending) {
    const id = nonEmpty(entry?.id);
    const known = catalog.get(id);
    if (!known) { unregistered.push(entry); continue; }
    let target = "";
    try { target = normalizeHarnessFeedbackTarget(entry?.target); } catch { target = ""; }
    if (known.kind !== nonEmpty(entry?.kind) || known.target !== target) {
      semanticMismatch.push(entry);
      continue;
    }
    registered.push(entry);
  }
  return {
    registeredReport: { ...curatorReport, pending: registered },
    registered,
    unregistered,
    semanticMismatch,
  };
}

const MACHINE_PATH_PATTERNS = [
  /(?:^|(?<=[\s"'`(=:,]))~\/[^\s"'`)]*/gu,
  /\/(?:Users|home|root|private\/tmp|tmp|var\/folders)\/[^\s"'`)]*/gu,
  /(?:[A-Za-z]:\\|\\\\)[^\s"'`)]*/gu,
  /(?<![A-Za-z0-9])-Users-[A-Za-z0-9._-]+/gu,
];

/**
 * 共有層へ出す文から端末path・credential・Channel Pack語を置換する。
 *
 * 未登録草案（下）と、配布物に同梱される overlay（scripts/harness-learn.mjs の
 * renderOverlay）が同じ規則を使えるように export する。overlay は
 * `.agents/skills/<name>/references/learned-auto.md` として npm tarball と plugin に
 * 入るのに、生成経路がこの置換を通していなかった（2026-09-05 独立レビュー D-1）。
 * 置換は語彙に依存するので、evidence 逐語を落とすことの代わりにはならない。
 */
export function redactSharedLearningText(value, options = {}) {
  return redactUnregisteredText(value, options);
}

function redactUnregisteredText(value, { terms = [], castIds = [], homeRoot = "" } = {}) {
  let text = String(value ?? "")
    .replace(/\r?\n/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  let hits = 0;
  const swap = (regex, replacement) => {
    text = text.replace(regex, () => { hits += 1; return replacement; });
  };
  // 一般形（/Users/<name>/... 等）を先に丸ごと置換し、残った素のHOME文字列を最後に消す。
  for (const pattern of MACHINE_PATH_PATTERNS) swap(pattern, "<machine-path>");
  if (nonEmpty(homeRoot)) swap(new RegExp(String(homeRoot).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu"), "<machine-path>");
  swap(new RegExp(CREDENTIAL_LIKE_TEXT.source, "giu"), "<credential>");
  for (const term of [...terms].filter((entry) => String(entry).length >= 2).sort((a, b) => b.length - a.length)) {
    swap(new RegExp(String(term).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu"), "<channel-term>");
  }
  for (const id of [...castIds].filter((entry) => String(entry).length >= 3)) {
    swap(new RegExp(`\\b${String(id).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "gu"), "<channel-id>");
  }
  return { text, hits };
}

/**
 * 管理側がまだ知らない提案を、bundleの外でownerへ渡す草案にする。
 *
 * ID-only境界は「管理側が本文を受け取らない」ことで守られるが、そのままだと
 * 運営者で見つかった新しい知見はどこにも届かない。この草案は運営者が
 * 人手で（メール・チケット等で）ownerへ渡すもので、uploadもingestも通らない。
 * ownerは読んだうえで自分のsession IDで capture し、正本へは従来の人手の
 * 昇格手順で載せる。ここから正本やcatalogを自動で書き換える経路は無い。
 *
 * - channel-pack宛は運営者固有なので草案にも入れない（件数だけ）
 * - evidenceは逐語を含みやすいので本文を落とし、digestだけ残す
 * - textは端末path・credential・Channel Pack語を置換し、置換件数を残す
 */
export function buildUnregisteredProposalDraft({
  unregistered = [],
  semanticMismatch = [],
  catalogSha256 = "",
  build = {},
  sourceHost = "",
  signals = { terms: [], castIds: [] },
  homeRoot = "",
  generatedAt = new Date().toISOString(),
} = {}) {
  const candidates = [];
  let confidentialExcluded = 0;
  for (const entry of unregistered) {
    const id = nonEmpty(entry?.id);
    if (!PROPOSAL_ID.test(id)) continue;
    const rawTarget = nonEmpty(entry?.target);
    let target;
    try { target = normalizeHarnessFeedbackTarget(rawTarget); } catch { continue; }
    if (target.startsWith("channel-pack:")) { confidentialExcluded += 1; continue; }
    const redacted = redactUnregisteredText(entry?.text, {
      terms: signals?.terms || [],
      castIds: signals?.castIds || [],
      homeRoot,
    });
    candidates.push({
      id,
      kind: cleanEnum(entry?.kind, FEEDBACK_KINDS, "proposal.kind"),
      target,
      redactedText: redacted.text,
      redactionHits: redacted.hits,
      occurrences: Array.isArray(entry?.localOccurrenceDigests)
        ? entry.localOccurrenceDigests.length
        : cleanCount(entry?.occurrences, "proposal.occurrences", { fallback: 1, minimum: 1 }),
      evidenceDigests: [...new Set((entry?.evidenceDigests || []).map((digest) => cleanSha(digest, "proposal.evidenceDigest")))].sort(),
      firstSeenAt: nonEmpty(entry?.firstSeenAt) || null,
      lastSeenAt: nonEmpty(entry?.lastSeenAt) || null,
    });
  }
  candidates.sort((left, right) => right.occurrences - left.occurrences || compareText(left.id, right.id));
  const draft = {
    version: HARNESS_FEEDBACK_UNREGISTERED_DRAFT_VERSION,
    generatedAt: cleanTimestamp(generatedAt, "generatedAt"),
    status: "unregistered-candidate",
    transmittedInBundle: false,
    writesCanonical: false,
    ownerActionRequired: "review-then-capture",
    sourceHost: nonEmpty(sourceHost) || null,
    build: {
      coreVersion: nonEmpty(build?.coreVersion) || null,
      harnessId: nonEmpty(build?.harnessId) || null,
      harnessVersion: nonEmpty(build?.harnessVersion) || null,
    },
    catalogSha256: cleanSha(catalogSha256, "catalogSha256", { optional: true }),
    counts: {
      candidates: candidates.length,
      confidentialExcluded,
      semanticMismatch: semanticMismatch.length,
    },
    semanticMismatchIds: semanticMismatch.map((entry) => nonEmpty(entry?.id)).filter(Boolean).sort(),
    redaction: {
      evidenceTextIncluded: false,
      sessionIncluded: false,
      channelSignalsAvailable: (signals?.terms || []).length > 0 || (signals?.castIds || []).length > 0,
    },
    nextStep: [
      "運営者: この草案をownerへ人手で渡す（upload APIは受け付けない）。",
      "owner: 内容を読み、一般化できるものだけ自分のsession IDで harness-learn.mjs capture する。",
      "owner: harness-curator.mjs export-public --output docs/learning/proposals.public.jsonl でcatalogを再生成し、次回配布へ含める。",
      "正本（SKILL.md・台帳）への反映は従来どおりskill-creatorと人の承認証跡を要する。",
    ],
    candidates,
  };
  assertNoForbiddenKeys(draft, "draft");
  return draft;
}
