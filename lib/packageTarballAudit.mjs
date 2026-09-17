// npmが実際に生成した.tgzを、展開先へ書かずに内容まで監査する。
// `npm pack --dry-run`のファイル名一覧だけでは、build後に混ざった絶対pathや
// Channel Pack由来文字列を見つけられないため、release artifactそのものを読む。

import { createHash, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { countMachineLocalPathHits } from "../scripts/audit-public-surface.mjs";

const BLOCK = 512;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const ROSTER_DENSITY = 3;

export const PACKAGE_RUNTIME_REQUIRED_PATHS = Object.freeze([
  "config/harness-deployments.example.json",
  "config/harnesses/koya-manga-video.harness.json",
  "config/harnesses/narrated-story-video.harness.json",
  // 公開catalog（id/kind/targetのみ）。本文つきのproposals.jsonlは配布しない。
  "docs/learning/proposals.public.jsonl",
  "docs/learning/targets.json",
  "lib/cliEntrypoint.mjs",
  "lib/harnessFeedbackBundle.mjs",
  "lib/harnessFeedbackIngest.mjs",
  "lib/harnessFeedbackUploadClient.mjs",
  "lib/harnessLearningCurator.mjs",
  "lib/packageTarballAudit.mjs",
  "lib/harnessDeploymentResolver.mjs",
  "lib/narratedStoryOutcome.mjs",
  "lib/narratedStoryPipeline.mjs",
  "lib/narratedStoryVideo.mjs",
  "scripts/audit-package-tarball.mjs",
  "scripts/audit-public-surface.mjs",
  "scripts/harness-curator.mjs",
  "scripts/harness-feedback.mjs",
  "scripts/harness-feedback-ingest.mjs",
  "scripts/harness-learn.mjs",
  "scripts/harness-receipts.mjs",
  "scripts/narrated-story-video.mjs",
]);

const FORBIDDEN_PACKAGE_PATHS = Object.freeze([
  /^channel-packs\//u,
  /^client-work\//u,
  /^\.codex-tmp\//u,
  /^config\/harness-deployments\.json$/u,
  // 共有learning ledgerは本文・根拠・sessionを持ち、運営者名や顧客pathが
  // 混ざりうる。配布するのは export-public が作る公開catalogだけ。
  /^docs\/learning\/(?:proposals|applied)\.jsonl$/u,
  /^docs\/learning\/receipts\//u,
  // 検査用語彙の平文一覧（git追跡外）。配布してよいのは digest 版だけ。
  /^docs\/learning\/sensitive-vocabulary\.local(?:\.|$)/u,
  /(?:^|\/)\.env(?:\.|$)/iu,
  /(?:^|\/)(?:credentials?|secrets?|private[-_]?keys?)(?:\.|\/|$)/iu,
  /\.reference\.md$/u,
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function cString(buffer, start, length) {
  const field = buffer.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString("utf8").trim();
}

function tarNumber(buffer, start, length, label) {
  const field = buffer.subarray(start, start + length);
  if ((field[0] & 0x80) !== 0) {
    const copy = Buffer.from(field);
    copy[0] &= 0x7f;
    let value = 0n;
    for (const byte of copy) value = (value << 8n) | BigInt(byte);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label}が大きすぎる。`);
    return Number(value);
  }
  const text = field.toString("ascii").replace(/\0.*$/u, "").trim();
  if (!text) return 0;
  if (!/^[0-7]+$/u.test(text)) throw new Error(`${label}がoctalではない。`);
  return Number.parseInt(text, 8);
}

function verifyHeaderChecksum(header) {
  const expected = tarNumber(header, 148, 8, "tar checksum");
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  const actual = copy.reduce((sum, byte) => sum + byte, 0);
  if (expected !== actual) throw new Error(`tar header checksum不一致（expected=${expected}, actual=${actual}）。`);
}

function parsePax(data) {
  const values = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error("PAX record lengthが無い。");
    const lengthText = data.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/u.test(lengthText)) throw new Error("PAX record lengthが不正。");
    const length = Number(lengthText);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > data.length || data[end - 1] !== 0x0a) {
      throw new Error("PAX recordが途中で切れている。");
    }
    const record = data.subarray(space + 1, end - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals <= 0) throw new Error("PAX recordにkey=valueが無い。");
    values[record.slice(0, equals)] = record.slice(equals + 1);
    offset = end;
  }
  return values;
}

function safePackagePath(raw) {
  const normalized = String(raw || "").replaceAll("\\", "/").replace(/^\.\//u, "");
  const withoutRoot = normalized.startsWith("package/") ? normalized.slice("package/".length) : normalized;
  const parts = withoutRoot.split("/").filter(Boolean);
  if (!withoutRoot || normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)
    || parts.includes("..") || parts.includes(".")) {
    throw new Error(`tar entry pathが不正: ${JSON.stringify(raw)}`);
  }
  return parts.join("/");
}

/** gzip済みnpm tarballをstrictに読み、regular file bytesを返す。 */
export function parseNpmTarball(tgzBytes) {
  const tar = gunzipSync(tgzBytes, { maxOutputLength: MAX_TOTAL_BYTES + BLOCK });
  if (tar.length > MAX_TOTAL_BYTES) throw new Error("tarball展開サイズが上限を超えた。");
  const entries = [];
  let offset = 0;
  let nextPax = {};
  let globalPax = {};
  let nextLongName = "";
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    verifyHeaderChecksum(header);
    const name = cString(header, 0, 100);
    const prefix = cString(header, 345, 155);
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const size = tarNumber(header, 124, 12, "tar entry size");
    if (size > MAX_ENTRY_BYTES) throw new Error(`tar entryが上限を超えた: ${headerPath}`);
    const type = String.fromCharCode(header[156] || 0x30);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error(`tar entryが途中で切れている: ${headerPath}`);
    const data = tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "g") {
      globalPax = { ...globalPax, ...parsePax(data) };
      continue;
    }
    if (type === "x") {
      nextPax = parsePax(data);
      continue;
    }
    if (type === "L") {
      nextLongName = data.toString("utf8").replace(/\0+$/u, "").trim();
      continue;
    }

    const effectivePath = nextPax.path || globalPax.path || nextLongName || headerPath;
    nextPax = {};
    nextLongName = "";
    const path = safePackagePath(effectivePath);
    if (type === "2" || type === "1") throw new Error(`package tarballにlink entryは許可しない: ${path}`);
    if (type === "5") continue;
    if (type !== "0" && type !== "\0") throw new Error(`未対応のtar entry type ${JSON.stringify(type)}: ${path}`);
    entries.push({ path, bytes: size, content: Buffer.from(data), sha256: sha256(data) });
    if (entries.length > MAX_ENTRIES) throw new Error("tarball entry数が上限を超えた。");
  }
  if (entries.length === 0) throw new Error("package tarballにregular fileが無い。");
  if (!entries.some((entry) => entry.path === "package.json")) throw new Error("package.jsonがtarballに無い。");
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

// ---------------------------------------------------------------------------
// Channel Pack 非依存の検査語彙（salted digest）
//
// なぜ要るか: channel-term / channel-roster の語彙は channel-packs/ からしか
// 集めない。channel-packs は git 追跡 0 件で運営者端末にしか無いので、CI では
// 語彙が空になり、検査は「無検出」を返して exit 0 になっていた。その状態で
// 同梱 overlay（learned-auto.md）に運営者名・顧客識別子・端末 path が
// 載ったまま tarball 監査が clean と報告した（2026-09-05 独立レビュー D-1/D-3）。
//
// 平文の禁止語一覧を公開リポジトリへ置くと、それ自体が名簿になる。ここでは
// 語を salted SHA-256 にした digest だけをコミットし、本文側は token ごとに同じ
// digest を取って一致を見る。名前は短く低エントロピーなので総当たりで復元
// されうる——これは秘匿ではなく「grep で読めない」程度の難読化であり、
// 一覧の語そのものを report へ出さない規則は従来どおり守る。
// ---------------------------------------------------------------------------

export const SENSITIVE_VOCABULARY_DIGEST_VERSION = "buzzassist-sensitive-vocabulary-digest-v1";
const VOCABULARY_MIN_TERM_LENGTH = 2;
const VOCABULARY_MAX_TERM_LENGTH = 64;
const KANJI_SUBSTRING_MAX = 4;
const SALT_PATTERN = /^[a-f0-9]{16,128}$/u;
// Latin token / カタカナ連（半角カナ・長音含む）/ ひらがな連 / 漢字連。
const VOCABULARY_TOKEN_PATTERN = /[A-Za-z0-9][A-Za-z0-9._-]*|[ァ-ヺーｦ-ﾟ]+|[ぁ-ゖ]+|[一-鿿㐀-䶿]+/gu;

function isKanjiCodePoint(code) {
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);
}

export function normalizeVocabularyTerm(term) {
  return String(term ?? "").normalize("NFKC").trim().toLowerCase();
}

export function digestVocabularyTerm(term, salt) {
  const normalized = normalizeVocabularyTerm(term);
  return createHash("sha256").update(`${String(salt)}\u001f${normalized}`, "utf8").digest("hex");
}

/** 平文の語一覧から、コミット可能な digest 一覧を作る。語そのものは含まない。 */
export function buildSensitiveVocabularyDigest(terms, { salt = "", generatedAt = new Date().toISOString() } = {}) {
  const useSalt = String(salt || "").trim() || randomBytes(16).toString("hex");
  if (!SALT_PATTERN.test(useSalt)) throw new Error("salt は16〜128文字の小文字hexであること。");
  const normalized = new Set();
  for (const raw of terms || []) {
    const term = normalizeVocabularyTerm(raw);
    const length = [...term].length;
    if (length < VOCABULARY_MIN_TERM_LENGTH || length > VOCABULARY_MAX_TERM_LENGTH) continue;
    if (/\s/u.test(term)) continue; // token 単位で照合するので空白を含む語は表現できない
    normalized.add(term);
  }
  const entries = [...normalized]
    .map((term) => ({ digest: digestVocabularyTerm(term, useSalt), length: [...term].length }))
    .sort((left, right) => left.digest.localeCompare(right.digest));
  return {
    version: SENSITIVE_VOCABULARY_DIGEST_VERSION,
    algorithm: "sha256(salt + U+001F + NFKC lowercase term)",
    generatedAt,
    salt: useSalt,
    termCount: entries.length,
    entries,
  };
}

/** digest JSON を検証して照合用の形にする。壊れた一覧を「語彙あり」と数えない。 */
export function parseSensitiveVocabularyDigest(input) {
  const parsed = typeof input === "string" ? JSON.parse(input) : input;
  if (!parsed || typeof parsed !== "object") throw new Error("sensitive vocabulary digest がobjectではない。");
  if (parsed.version !== SENSITIVE_VOCABULARY_DIGEST_VERSION) {
    throw new Error(`sensitive vocabulary digest のversionが不明: ${JSON.stringify(parsed.version)}`);
  }
  if (!SALT_PATTERN.test(String(parsed.salt || ""))) throw new Error("sensitive vocabulary digest のsaltが不正。");
  if (!Array.isArray(parsed.entries)) throw new Error("sensitive vocabulary digest にentriesが無い。");
  const digests = new Set();
  const lengths = new Set();
  for (const entry of parsed.entries) {
    if (!/^[a-f0-9]{64}$/u.test(String(entry?.digest || ""))) throw new Error("sensitive vocabulary digest のentryが不正。");
    if (!Number.isInteger(entry.length) || entry.length < VOCABULARY_MIN_TERM_LENGTH || entry.length > VOCABULARY_MAX_TERM_LENGTH) {
      throw new Error("sensitive vocabulary digest のentry.lengthが不正。");
    }
    digests.add(entry.digest);
    lengths.add(entry.length);
  }
  if (Number.isInteger(parsed.termCount) && parsed.termCount !== digests.size) {
    throw new Error("sensitive vocabulary digest のtermCountがentries数と一致しない。");
  }
  return { salt: String(parsed.salt), digests, lengths, count: digests.size };
}

/**
 * 本文から照合候補 token を取り出す。
 * - Latin token は全体と、`-` `_` `.` で分けた各部分
 * - カタカナ連・ひらがな連は連全体だけ（部分列を見ると「エマージェンシー」等の一般語に当たる）
 * - 漢字連は全体と長さ2〜4の部分列（「運営者〇〇太郎」のように姓が連の内側に来るため）
 */
export function extractVocabularyTokens(text) {
  const tokens = new Set();
  for (const match of String(text || "").matchAll(VOCABULARY_TOKEN_PATTERN)) {
    const token = match[0];
    const code = token.codePointAt(0);
    tokens.add(token);
    if (isKanjiCodePoint(code)) {
      const chars = [...token];
      for (let size = VOCABULARY_MIN_TERM_LENGTH; size <= Math.min(KANJI_SUBSTRING_MAX, chars.length - 1); size += 1) {
        for (let start = 0; start + size <= chars.length; start += 1) tokens.add(chars.slice(start, start + size).join(""));
      }
    } else if (code < 0x80) {
      for (const part of token.split(/[._-]+/u)) if (part) tokens.add(part);
    }
  }
  return tokens;
}

/** 本文中で digest 一覧に一致した token の種類数（値そのものは返さない）。 */
export function countVocabularyDigestHits(text, vocabulary) {
  if (!vocabulary || vocabulary.count === 0) return 0;
  let hits = 0;
  for (const token of extractVocabularyTokens(text)) {
    const normalized = normalizeVocabularyTerm(token);
    if (!vocabulary.lengths.has([...normalized].length)) continue;
    if (vocabulary.digests.has(digestVocabularyTerm(normalized, vocabulary.salt))) hits += 1;
  }
  return hits;
}

function resolveVocabulary(vocabularyDigest) {
  if (!vocabularyDigest) return null;
  if (vocabularyDigest.digests instanceof Set) return vocabularyDigest;
  return parseSensitiveVocabularyDigest(vocabularyDigest);
}

function textContent(buffer) {
  if (buffer.length === 0) return "";
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  const nul = sample.reduce((count, byte) => count + (byte === 0 ? 1 : 0), 0);
  if (nul / sample.length > 0.005) return null;
  return buffer.toString("utf8");
}

export function auditPackageEntries(entries, {
  terms = [], castIds = [], homeRoot = "", allowlist = {}, requiredPaths = [], vocabularyDigest = null,
} = {}) {
  const vocabulary = resolveVocabulary(vocabularyDigest);
  const detected = [];
  const packagedPaths = new Set((entries || []).map((entry) => entry.path));
  for (const path of requiredPaths) {
    if (!packagedPaths.has(path)) detected.push({ type: "missing-required-path", path });
  }
  for (const entry of entries || []) {
    if (FORBIDDEN_PACKAGE_PATHS.some((pattern) => pattern.test(entry.path))) {
      detected.push({ type: "forbidden-path", path: entry.path });
    }
    const text = textContent(entry.content);
    if (text === null) continue;
    const pathHits = countMachineLocalPathHits(text, homeRoot);
    if (pathHits > 0) detected.push({ type: "machine-local-path", path: entry.path, count: pathHits });
    let termHits = 0;
    for (const term of terms) if (String(term).length >= 2 && text.includes(String(term))) termHits += 1;
    if (termHits > 0) detected.push({ type: "channel-term", path: entry.path, count: termHits });
    const rosterHits = castIds.filter((id) => String(id).length >= 3
      && new RegExp(`\\b${String(id).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u").test(text)).length;
    if (rosterHits >= ROSTER_DENSITY) detected.push({ type: "channel-roster", path: entry.path, count: rosterHits });
    const vocabularyHits = countVocabularyDigestHits(text, vocabulary);
    if (vocabularyHits > 0) detected.push({ type: "private-term", path: entry.path, count: vocabularyHits });
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{80,}-----END /u.test(text)) {
      detected.push({ type: "private-key-material", path: entry.path, count: 1 });
    }
  }
  const unique = [...new Map(detected.map((finding) => [`${finding.type}\u001f${finding.path}`, finding])).values()]
    .sort((left, right) => left.path.localeCompare(right.path) || left.type.localeCompare(right.type));
  const allowlistBucket = {
    "forbidden-path": allowlist.path || [],
    "machine-local-path": allowlist.pathLeak || [],
    "channel-term": allowlist.term || [],
    "channel-roster": allowlist.roster || [],
    "private-term": allowlist.privateTerm || [],
  };
  const findings = [];
  const accepted = [];
  for (const finding of unique) {
    const approved = (allowlistBucket[finding.type] || []).find((entry) => entry.file === finding.path);
    if (approved && typeof approved.count === "number" && approved.count >= (finding.count || 1)
      && typeof approved.why === "string" && approved.why.trim().length >= 20) {
      accepted.push({ ...finding, allowedCount: approved.count, why: approved.why });
    } else findings.push(finding);
  }
  const channelSignalsAvailable = terms.length > 0 || castIds.length > 0;
  const vocabularyDigestAvailable = Boolean(vocabulary && vocabulary.count > 0);
  // 語彙が1つも無い状態の「無検出」は clean ではない。status で区別し、
  // gateOk とは別に signalsAvailable を返す。CLI は既定でこれを要求する。
  const signalsAvailable = channelSignalsAvailable || vocabularyDigestAvailable;
  let status;
  if (findings.length > 0) status = "failed";
  else if (accepted.length > 0) status = "accepted-risk";
  else status = signalsAvailable ? "clean" : "incomplete";
  return {
    version: "buzzassist-package-tarball-audit-v1",
    entryCount: entries.length,
    contentBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    channelSignalsAvailable,
    vocabularyDigestAvailable,
    vocabularyTermCount: vocabulary ? vocabulary.count : 0,
    signalsAvailable,
    findings,
    accepted,
    status,
    gateOk: findings.length === 0,
  };
}

export function auditPackageTarball(tgzBytes, options = {}) {
  const entries = parseNpmTarball(tgzBytes);
  return { ...auditPackageEntries(entries, options), tarballSha256: sha256(tgzBytes) };
}
