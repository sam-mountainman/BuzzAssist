// BuzzAssist Core とは別に配る Channel Pack の署名付き envelope。
//
// Channel Pack の中身は非公開でもよいが、provider secret は絶対に含めない。
// 署名鍵は配布元だけが持ち、受領側は信頼済み公開鍵を別経路で設定する。
// bundle 内の公開鍵をそのまま信頼すると、bundle と鍵を一緒に差し替えられるため、
// この実装は意図的にその fallback を持たない。

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { writeJsonAtomic } from "./canvasScene.mjs";

export const CHANNEL_PACK_ENVELOPE_VERSION = "buzzassist-channel-pack-envelope-v1";
export const CHANNEL_PACK_ROLLBACK_AUTHORIZATION_VERSION = "buzzassist-channel-pack-rollback-authorization-v1";
export const CHANNEL_PACK_MANIFEST = "channel-pack.json";
export const CHANNEL_PACK_PAYLOAD_DIR = "payload";

const FORBIDDEN_SECRET_PATH = /(^|\/)(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)|[^/]*(?:private[-_.]?key|api[-_.]?key|access[-_.]?token|refresh[-_.]?token)[^/]*)$/iu;
const TEXT_FILE = /\.(?:json|jsonl|ya?ml|toml|ini|conf|config|env|txt|md|js|mjs|cjs|ts|tsx|py|sh|ps1|xml|csv|srt|vtt)$/iu;
const SECRET_VALUE_PATTERNS = Object.freeze([
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\b(?:FISH_AUDIO_API_KEY|ELEVENLABS_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)\s*[:=]\s*["']?[^\s"']{8,}/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
]);
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function semverTuple(value) {
  const match = String(value || "").trim().match(SEMVER);
  return match ? match.slice(1, 4).map(Number) : null;
}

function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

/** Small, deterministic compatibility subset used by signed Channel Packs. */
export function coreVersionSatisfies(coreVersion, compatibility) {
  const current = semverTuple(coreVersion);
  const range = nonEmpty(compatibility);
  if (!current || !range) return false;
  if (range === "*") return true;
  const exact = semverTuple(range);
  if (exact) return compareSemver(current, exact) === 0;
  if (/^[~^]/u.test(range)) {
    const base = semverTuple(range.slice(1));
    if (!base || compareSemver(current, base) < 0) return false;
    const upper = range[0] === "~"
      ? [base[0], base[1] + 1, 0]
      : base[0] > 0
        ? [base[0] + 1, 0, 0]
        : base[1] > 0 ? [0, base[1] + 1, 0] : [0, 0, base[2] + 1];
    return compareSemver(current, upper) < 0;
  }
  const comparators = range.split(/\s+/u).filter(Boolean);
  if (comparators.length === 0) return false;
  return comparators.every((token) => {
    const match = token.match(/^(>=|<=|>|<)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/u);
    if (!match) return false;
    const target = semverTuple(match[2]);
    const order = compareSemver(current, target);
    return match[1] === ">=" ? order >= 0
      : match[1] === "<=" ? order <= 0
        : match[1] === ">" ? order > 0 : order < 0;
  });
}

export function assertCoreCompatibility(coreVersion, compatibility) {
  if (!coreVersionSatisfies(coreVersion, compatibility)) {
    throw new Error(`Channel Pack coreCompatibility ${compatibility || "(なし)"} は BuzzAssist Core ${coreVersion || "(不明)"} と互換でない。`);
  }
  return { coreVersion, coreCompatibility: compatibility };
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function portable(value) {
  return String(value || "").split(sep).join("/");
}

function safeRelative(value) {
  const rel = portable(value).replace(/^\.\//u, "");
  if (!rel || rel === "." || rel.startsWith("/") || /^[A-Za-z]:\//u.test(rel)
    || rel.split("/").includes("..")) {
    throw new Error(`Channel Pack内のpathが不正: ${value || "(空)"}`);
  }
  return rel;
}

function inside(root, rel) {
  const target = resolve(root, safeRelative(rel));
  const delta = relative(resolve(root), target);
  if (delta.startsWith("..") || isAbsolute(delta)) throw new Error(`Channel Packのroot外を指している: ${rel}`);
  return target;
}

async function pathExists(path) {
  try { await access(path, fsConstants.F_OK); return true; } catch { return false; }
}

async function sha256File(path) {
  return sha256(await readFile(path));
}

async function assertNoEmbeddedSecret(path, rel, size) {
  if (FORBIDDEN_SECRET_PATH.test(rel)) {
    throw new Error(`Channel Packへ秘密らしいファイル名を含められない: ${basename(rel)}`);
  }
  // 巨大なmediaを文字列へ変換しない。秘密検査は設定・文書系だけに限定する。
  if (!TEXT_FILE.test(rel) || size > 2 * 1024 * 1024) return;
  const text = await readFile(path, "utf8");
  if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error(`Channel Packへprovider secretらしい値を含められない: ${rel}`);
  }
}

async function walkRegularFiles(root, current = root) {
  const output = [];
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Channel Packへsymlinkは含められない: ${portable(relative(root, path))}`);
    if (info.isDirectory()) output.push(...await walkRegularFiles(root, path));
    else if (info.isFile()) output.push({ path, relativePath: safeRelative(relative(root, path)), size: info.size });
    else throw new Error(`Channel Packへ通常ファイル以外は含められない: ${portable(relative(root, path))}`);
  }
  return output;
}

async function readKey({ pem = "", path = "", kind }) {
  const inline = nonEmpty(pem);
  if (inline) return inline;
  const file = nonEmpty(path);
  if (!file) throw new Error(`${kind}鍵を信頼済みの別経路で指定すること。bundle内の鍵は信頼しない。`);
  return readFile(resolve(file), "utf8");
}

export function publicKeyId(publicKey) {
  const key = publicKey?.type === "public" ? publicKey : createPublicKey(publicKey);
  const der = key.export({ type: "spki", format: "der" });
  return `ed25519:${sha256(der).slice(0, 24)}`;
}

function signedBody(manifest) {
  const body = structuredClone(manifest);
  delete body.signature;
  return body;
}

function rollbackAuthorizationBody(value) {
  const body = structuredClone(value);
  delete body.signature;
  return body;
}

function rollbackFields(value) {
  const fields = {
    trustedPublicKeyId: nonEmpty(value?.trustedPublicKeyId),
    harnessId: nonEmpty(value?.harnessId),
    packId: nonEmpty(value?.packId),
    fromVersion: nonEmpty(value?.fromVersion),
    fromPayloadSha256: nonEmpty(value?.fromPayloadSha256).toLowerCase(),
    toVersion: nonEmpty(value?.toVersion),
    toPayloadSha256: nonEmpty(value?.toPayloadSha256).toLowerCase(),
  };
  if (!fields.trustedPublicKeyId || !fields.harnessId || !fields.packId
    || !semverTuple(fields.fromVersion) || !semverTuple(fields.toVersion)
    || !/^[a-f0-9]{64}$/u.test(fields.fromPayloadSha256)
    || !/^[a-f0-9]{64}$/u.test(fields.toPayloadSha256)) {
    throw new Error("Channel Pack rollback承認の対象identityが不正。");
  }
  return fields;
}

export async function createChannelPackRollbackAuthorization({
  trustedPublicKeyId,
  harnessId,
  packId,
  fromVersion,
  fromPayloadSha256,
  toVersion,
  toPayloadSha256,
  reason,
  privateKeyPem = "",
  privateKeyPath = "",
  publicKeyPem = "",
  publicKeyPath = "",
  keyId = "",
  authorizedAt = new Date().toISOString(),
  expiresAt,
} = {}) {
  const target = rollbackFields({
    trustedPublicKeyId,
    harnessId,
    packId,
    fromVersion,
    fromPayloadSha256,
    toVersion,
    toPayloadSha256,
  });
  if (compareSemver(semverTuple(target.toVersion), semverTuple(target.fromVersion)) >= 0) {
    throw new Error("rollback承認のtoVersionはfromVersionより古い必要がある。");
  }
  const note = nonEmpty(reason);
  if (!note || note.length > 500) throw new Error("rollback承認には500文字以内のreasonが要る。");
  const authorized = new Date(authorizedAt);
  const expires = new Date(expiresAt);
  if (!Number.isFinite(authorized.getTime()) || !Number.isFinite(expires.getTime())
    || expires <= authorized || expires.getTime() - authorized.getTime() > 30 * 24 * 60 * 60 * 1000) {
    throw new Error("rollback承認の期限はauthorizedAtより後、30日以内であること。");
  }
  const privatePem = await readKey({ pem: privateKeyPem, path: privateKeyPath, kind: "秘密" });
  const privateKey = createPrivateKey(privatePem);
  const derivedPublic = createPublicKey(privateKey);
  const suppliedPublicPem = nonEmpty(publicKeyPem) || nonEmpty(publicKeyPath)
    ? await readKey({ pem: publicKeyPem, path: publicKeyPath, kind: "公開" })
    : derivedPublic.export({ type: "spki", format: "pem" });
  const suppliedPublic = createPublicKey(suppliedPublicPem);
  if (publicKeyId(suppliedPublic) !== publicKeyId(derivedPublic)) throw new Error("rollback承認の秘密鍵と公開鍵が対応していない。");
  const body = {
    version: CHANNEL_PACK_ROLLBACK_AUTHORIZATION_VERSION,
    ...target,
    reason: note,
    authorizedAt: authorized.toISOString(),
    expiresAt: expires.toISOString(),
    signer: { algorithm: "Ed25519", keyId: nonEmpty(keyId) || publicKeyId(derivedPublic) },
  };
  return {
    ...body,
    signature: cryptoSign(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64url"),
  };
}

export async function verifyChannelPackRollbackAuthorization({
  authorization,
  expected,
  trustedPublicKeyPem = "",
  trustedPublicKeyPath = "",
  trustedKeys = null,
  now = () => new Date(),
} = {}) {
  if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)
    || authorization.version !== CHANNEL_PACK_ROLLBACK_AUTHORIZATION_VERSION
    || authorization.signer?.algorithm !== "Ed25519" || !nonEmpty(authorization.signer?.keyId)) {
    throw new Error("Channel Pack rollback承認の形式が不正。");
  }
  const target = rollbackFields(authorization);
  const wanted = rollbackFields(expected);
  if (canonicalJson(target) !== canonicalJson(wanted)) throw new Error("Channel Pack rollback承認が現在値と対象packへ一致しない。");
  if (compareSemver(semverTuple(target.toVersion), semverTuple(target.fromVersion)) >= 0) {
    throw new Error("Channel Pack rollback承認がdowngradeを指していない。");
  }
  const authorizedAt = new Date(authorization.authorizedAt);
  const expiresAt = new Date(authorization.expiresAt);
  const current = now() instanceof Date ? now() : new Date(now());
  if (!Number.isFinite(authorizedAt.getTime()) || !Number.isFinite(expiresAt.getTime())
    || expiresAt <= authorizedAt || expiresAt.getTime() - authorizedAt.getTime() > 30 * 24 * 60 * 60 * 1000
    || current < authorizedAt || current > expiresAt) {
    throw new Error("Channel Pack rollback承認が未発効・期限切れ・期間超過。");
  }
  let publicPem = nonEmpty(trustedPublicKeyPem);
  if (!publicPem && trustedKeys && typeof trustedKeys === "object") publicPem = nonEmpty(trustedKeys[authorization.signer.keyId]);
  if (!publicPem) publicPem = await readKey({ path: trustedPublicKeyPath, kind: "公開" });
  const publicKey = createPublicKey(publicPem);
  const trustedId = publicKeyId(publicKey);
  if (trustedId !== target.trustedPublicKeyId) throw new Error("rollback承認の信頼済み公開鍵identityが違う。");
  if (String(authorization.signer.keyId).startsWith("ed25519:") && authorization.signer.keyId !== trustedId) {
    throw new Error("rollback承認のsigner key IDが信頼済み公開鍵と一致しない。");
  }
  const signature = Buffer.from(nonEmpty(authorization.signature), "base64url");
  if (signature.length === 0
    || !cryptoVerify(null, Buffer.from(canonicalJson(rollbackAuthorizationBody(authorization))), publicKey, signature)) {
    throw new Error("Channel Pack rollback承認のEd25519署名が一致しない。");
  }
  return { ok: true, authorizationSha256: sha256(canonicalJson(authorization)), trustedPublicKeyId: trustedId };
}

/**
 * 既存のChannel Pack payloadをコピーし、Ed25519署名済みenvelopeにする。
 * outputDirは空の新規directoryだけを受け付ける。既存bundleを上書きしない。
 */
export async function createChannelPackEnvelope({
  sourceDir,
  outputDir,
  id,
  version,
  harnessId,
  payloadKind = "channel-pack",
  coreCompatibility = "*",
  privateKeyPem = "",
  privateKeyPath = "",
  publicKeyPem = "",
  publicKeyPath = "",
  keyId = "",
  createdAt = new Date().toISOString(),
} = {}) {
  const source = resolve(nonEmpty(sourceDir));
  const output = resolve(nonEmpty(outputDir));
  if (!nonEmpty(sourceDir) || !nonEmpty(outputDir)) throw new Error("sourceDir と outputDir が要る。");
  if (source === output || output.startsWith(`${source}${sep}`)) throw new Error("outputDirをsourceDir自身またはその配下に置けない。");
  if (await pathExists(output)) throw new Error(`Channel Pack出力先が既にある。上書きしない: ${output}`);
  const sourceInfo = await stat(source);
  if (!sourceInfo.isDirectory()) throw new Error("sourceDirはdirectoryであること。");
  const packId = nonEmpty(id);
  const packVersion = nonEmpty(version);
  const targetHarness = nonEmpty(harnessId);
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/u.test(packId)) throw new Error("Channel Pack idが不正。");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(packVersion)) throw new Error("Channel Pack versionはsemverで指定すること。");
  if (!targetHarness) throw new Error("harnessIdが要る。");

  const sourceFiles = await walkRegularFiles(source);
  if (sourceFiles.length === 0) throw new Error("空のChannel Packは署名できない。");
  await mkdir(dirname(output), { recursive: true });
  const stage = join(dirname(output), `.${basename(output)}.${process.pid}.${randomUUID()}.partial`);
  await mkdir(stage);
  try {
    await mkdir(join(stage, CHANNEL_PACK_PAYLOAD_DIR));
    const files = [];
    for (const entry of sourceFiles) {
      await assertNoEmbeddedSecret(entry.path, entry.relativePath, entry.size);
      const destination = inside(join(stage, CHANNEL_PACK_PAYLOAD_DIR), entry.relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(entry.path, destination, fsConstants.COPYFILE_EXCL);
      files.push({
        path: `${CHANNEL_PACK_PAYLOAD_DIR}/${entry.relativePath}`,
        bytes: entry.size,
        sha256: await sha256File(destination),
      });
    }
    files.sort((left, right) => left.path.localeCompare(right.path));

    const privatePem = await readKey({ pem: privateKeyPem, path: privateKeyPath, kind: "秘密" });
    const privateKey = createPrivateKey(privatePem);
    const derivedPublic = createPublicKey(privateKey);
    const suppliedPublicPem = nonEmpty(publicKeyPem) || nonEmpty(publicKeyPath)
      ? await readKey({ pem: publicKeyPem, path: publicKeyPath, kind: "公開" })
      : derivedPublic.export({ type: "spki", format: "pem" });
    const suppliedPublic = createPublicKey(suppliedPublicPem);
    const derivedId = publicKeyId(derivedPublic);
    if (publicKeyId(suppliedPublic) !== derivedId) throw new Error("秘密鍵と公開鍵が対応していない。");
    const signerKeyId = nonEmpty(keyId) || derivedId;
    const manifestBody = {
      version: CHANNEL_PACK_ENVELOPE_VERSION,
      id: packId,
      packVersion,
      harnessId: targetHarness,
      payloadKind: nonEmpty(payloadKind) || "channel-pack",
      coreCompatibility: nonEmpty(coreCompatibility) || "*",
      createdAt,
      signer: { algorithm: "Ed25519", keyId: signerKeyId },
      files,
      payloadSha256: sha256(canonicalJson(files)),
    };
    const signature = cryptoSign(null, Buffer.from(canonicalJson(manifestBody)), privateKey).toString("base64url");
    const manifest = { ...manifestBody, signature };
    await writeJsonAtomic(join(stage, CHANNEL_PACK_MANIFEST), manifest);
    // stageで全file・署名・unexpected fileを検査してから、完成名へ一度だけrename。
    await verifyChannelPackEnvelope({ bundleDir: stage, trustedPublicKeyPem: suppliedPublicPem });
    await rename(stage, output);
    const verified = await verifyChannelPackEnvelope({ bundleDir: output, trustedPublicKeyPem: suppliedPublicPem });
    return { ...verified, manifest };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

/** bundle内ではなく、受領側が信頼した公開鍵だけで検証する。 */
export async function verifyChannelPackEnvelope({
  bundleDir,
  trustedPublicKeyPem = "",
  trustedPublicKeyPath = "",
  trustedKeys = null,
  expectedHarnessId = "",
  coreVersion = "",
} = {}) {
  const root = resolve(nonEmpty(bundleDir));
  if (!nonEmpty(bundleDir)) throw new Error("bundleDirが要る。");
  const manifestPath = join(root, CHANNEL_PACK_MANIFEST);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.version !== CHANNEL_PACK_ENVELOPE_VERSION) {
    throw new Error(`未対応のChannel Pack envelope: ${manifest.version || "(versionなし)"}`);
  }
  if (manifest.signer?.algorithm !== "Ed25519" || !nonEmpty(manifest.signer?.keyId)) {
    throw new Error("Channel Pack署名情報が不正。");
  }
  if (expectedHarnessId && manifest.harnessId !== expectedHarnessId) {
    throw new Error(`Channel Packの対象Harnessが違う: ${manifest.harnessId || "(なし)"}`);
  }
  if (nonEmpty(coreVersion)) assertCoreCompatibility(coreVersion, manifest.coreCompatibility);
  let publicPem = nonEmpty(trustedPublicKeyPem);
  if (!publicPem && trustedKeys && typeof trustedKeys === "object") {
    publicPem = nonEmpty(trustedKeys[manifest.signer.keyId]);
  }
  if (!publicPem) publicPem = await readKey({ path: trustedPublicKeyPath, kind: "公開" });
  const publicKey = createPublicKey(publicPem);
  const trustedId = publicKeyId(publicKey);
  // 明示keyIdは組織側aliasにもできるためfingerprint一致を必須にしない。
  // ただしfingerprint形式を名乗る場合だけは、差し替えを必ず検出する。
  if (String(manifest.signer.keyId).startsWith("ed25519:") && manifest.signer.keyId !== trustedId) {
    throw new Error("Channel Packのsigner key IDが信頼済み公開鍵と一致しない。");
  }
  const signature = Buffer.from(nonEmpty(manifest.signature), "base64url");
  if (signature.length === 0 || !cryptoVerify(null, Buffer.from(canonicalJson(signedBody(manifest))), publicKey, signature)) {
    throw new Error("Channel PackのEd25519署名が一致しない。");
  }
  const rows = Array.isArray(manifest.files) ? manifest.files : [];
  if (rows.length === 0 || manifest.payloadSha256 !== sha256(canonicalJson(rows))) {
    throw new Error("Channel Packのpayload manifestが不正。");
  }
  const expected = new Set([CHANNEL_PACK_MANIFEST]);
  const failures = [];
  for (const row of rows) {
    const rel = safeRelative(row.path);
    if (!rel.startsWith(`${CHANNEL_PACK_PAYLOAD_DIR}/`)) failures.push(`${rel}: payload/配下ではない`);
    if (expected.has(rel)) failures.push(`${rel}: manifestで重複`);
    expected.add(rel);
    try {
      const path = inside(root, rel);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) failures.push(`${rel}: 通常ファイルではない`);
      else {
        if (info.size !== row.bytes) failures.push(`${rel}: byte数が違う`);
        if (await sha256File(path) !== row.sha256) failures.push(`${rel}: SHA-256が違う`);
      }
    } catch (error) { failures.push(`${rel}: ${error.message}`); }
  }
  for (const entry of await walkRegularFiles(root)) {
    if (!expected.has(entry.relativePath)) failures.push(`${entry.relativePath}: manifestに無いファイル`);
  }
  if (failures.length > 0) throw new Error(`Channel Pack検証に失敗:\n- ${failures.join("\n- ")}`);
  const payloadDir = join(root, CHANNEL_PACK_PAYLOAD_DIR);
  return {
    ok: true,
    bundleDir: root,
    payloadDir,
    manifestPath,
    id: manifest.id,
    packVersion: manifest.packVersion,
    harnessId: manifest.harnessId,
    payloadKind: manifest.payloadKind,
    coreCompatibility: manifest.coreCompatibility,
    signerKeyId: manifest.signer.keyId,
    trustedPublicKeyId: trustedId,
    payloadSha256: manifest.payloadSha256,
    fileCount: rows.length,
    manifest,
  };
}

export async function trustedChannelPackKeyFromEnvironment(env = process.env) {
  const inline = nonEmpty(env.BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY_PEM);
  const path = nonEmpty(env.BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY);
  if (!inline && !path) {
    throw new Error(
      "署名Channel Packの信頼済み公開鍵が未設定。"
      + "BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY（PEM file）を受領側へ別経路で設定すること。",
    );
  }
  return inline ? { trustedPublicKeyPem: inline } : { trustedPublicKeyPath: path };
}
