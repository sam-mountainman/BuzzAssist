// npmが実際に生成した.tgzを、展開先へ書かずに内容まで監査する。
// `npm pack --dry-run`のファイル名一覧だけでは、build後に混ざった絶対pathや
// Channel Pack由来文字列を見つけられないため、release artifactそのものを読む。

import { createHash, createHmac } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
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
// Channel Pack 非依存の検査語彙（鍵つき digest）
//
// なぜ要るか: channel-term / channel-roster の語彙は channel-packs/ からしか
// 集めない。channel-packs は git 追跡 0 件で運営者端末にしか無いので、CI では
// 語彙が空になり、検査は「無検出」を返して exit 0 になっていた。その状態で
// 同梱 overlay（learned-auto.md）に運営者名・顧客識別子・端末 path が
// 載ったまま tarball 監査が clean と報告した（2026-09-05 独立レビュー D-1/D-3）。
//
// なぜ鍵つきか: 最初の版（v1）は「公開した salt ＋ SHA-256」で、各語の文字数
// まで載せていた。salt は事前計算表を防ぐだけで総当たりは防げない。語彙を
// 一切持たない状態から、ひらがな・カタカナ3文字までの総当たりだけで
// **1.9 秒で 28 件中 4 件が復元できた**（2026-09-17 実測）。漢字2文字や人名
// 辞書を使えばさらに戻る。短い人名の一覧を公開するのは名簿を公開するのと
// 同じで、「チャンネルの情報・実名をリポジトリに書かない」に反する。
//
// v2 は HMAC-SHA256。鍵はリポジトリの外（環境変数か ~/.buzzassist/）にだけ
// 置き、公開ファイルには鍵の指紋・長さの集合・digest だけを載せる。
// 鍵が無い環境（CI で secret 未設定、新しいクローン）では、語彙は「使えない」
// のであって「一致なし」ではない——呼び出し側は未検査として扱う。
// ---------------------------------------------------------------------------

export const SENSITIVE_VOCABULARY_DIGEST_VERSION = "buzzassist-sensitive-vocabulary-digest-v2";
const LEGACY_SALTED_DIGEST_VERSION = "buzzassist-sensitive-vocabulary-digest-v1";
export const SENSITIVE_VOCABULARY_KEY_ENV = "BUZZASSIST_SENSITIVE_VOCABULARY_KEY";
const VOCABULARY_MIN_TERM_LENGTH = 2;
const VOCABULARY_MAX_TERM_LENGTH = 64;
const KANJI_SUBSTRING_MAX = 4;
// 英数字の識別子で、連続して照合する部分の最大数。
const LATIN_JOIN_MAX = 6;
const KEY_MIN_BYTES = 32;
const KEY_HEX_PATTERN = /^(?:[a-f0-9]{2}){32,}$/u;
const KEY_ID_PATTERN = /^[a-f0-9]{16}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const UNIT_SEPARATOR = String.fromCharCode(0x1f);
// Latin token / カタカナ連（半角カナ・長音含む）/ ひらがな連 / 漢字連。
const VOCABULARY_TOKEN_PATTERN = /[A-Za-z0-9][A-Za-z0-9._-]*|[ァ-ヺーｦ-ﾟ]+|[ぁ-ゖ]+|[一-鿿㐀-䶿]+/gu;

/** 鍵が無いことを、壊れた一覧と区別して扱うための印。 */
export class VocabularyKeyMissingError extends Error {
  constructor(message) {
    super(message);
    this.name = "VocabularyKeyMissingError";
    this.code = "VOCABULARY_KEY_MISSING";
  }
}

function isKanjiCodePoint(code) {
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);
}

export function normalizeVocabularyTerm(term) {
  return String(term ?? "").normalize("NFKC").trim().toLowerCase();
}

/** 鍵を Buffer にする。短い鍵・hex でない文字列は受け取らない（v1 の salt を渡す取り違えを含む）。 */
export function normalizeVocabularyKey(value) {
  if (Buffer.isBuffer(value)) {
    if (value.length < KEY_MIN_BYTES) throw new Error(`検査語彙の鍵は ${KEY_MIN_BYTES} バイト以上であること。`);
    return value;
  }
  const text = String(value ?? "").trim();
  if (!KEY_HEX_PATTERN.test(text)) {
    throw new Error(`検査語彙の鍵は ${KEY_MIN_BYTES * 2} 文字以上の小文字 hex であること。`);
  }
  return Buffer.from(text, "hex");
}

export function defaultVocabularyKeyPath(home = homedir()) {
  return join(home, ".buzzassist", "sensitive-vocabulary.key");
}

function isInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * 鍵を探す。環境変数 → 鍵ファイルの順。リポジトリ配下の鍵ファイルは使わない
 * （`git add -A` で公開される）。見つからなければ key: null と理由を返す。
 * 鍵そのものは戻り値の key 以外へ出さない。
 */
export function resolveVocabularyKey({
  env = process.env, keyPath = "", home = homedir(), projectDir = "", readKeyFile = null,
} = {}) {
  const fromEnv = String(env?.[SENSITIVE_VOCABULARY_KEY_ENV] || "").trim();
  if (fromEnv) return { key: normalizeVocabularyKey(fromEnv), source: "env", keyPath: null };
  const file = keyPath ? resolve(keyPath) : defaultVocabularyKeyPath(home);
  // 明示された置き場だけを見る。既定の ~/.buzzassist/ はこちらが選んだ場所で、
  // プロジェクトを HOME そのものにした運営者を締め出さない。
  if (keyPath && projectDir && isInside(file, projectDir)) {
    throw new Error("検査語彙の鍵ファイルをリポジトリ配下に置かない（git add -A で公開される）。");
  }
  if (typeof readKeyFile !== "function") {
    return { key: null, source: null, keyPath: file, reason: "鍵ファイルを読む手段が渡されていない" };
  }
  let text;
  try {
    text = readKeyFile(file);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        key: null,
        source: null,
        keyPath: file,
        reason: `鍵が無い（${SENSITIVE_VOCABULARY_KEY_ENV} も ${file} も見つからない）`,
      };
    }
    throw error;
  }
  return { key: normalizeVocabularyKey(text), source: "file", keyPath: file };
}

/** 鍵の指紋。鍵は 32 バイト以上の乱数なので、指紋から戻すことはできない。 */
export function vocabularyKeyId(key) {
  return createHash("sha256")
    .update(`buzzassist-vocabulary-key-id${UNIT_SEPARATOR}`, "utf8")
    .update(normalizeVocabularyKey(key))
    .digest("hex")
    .slice(0, 16);
}

export function digestVocabularyTerm(term, key) {
  const normalized = normalizeVocabularyTerm(term);
  return createHmac("sha256", normalizeVocabularyKey(key)).update(normalized, "utf8").digest("hex");
}

function keyIsAbsent(key) {
  return key === undefined || key === null || key === "";
}

/** 平文の語一覧から、コミット可能な digest 一覧を作る。語も鍵も含まない。 */
export function buildSensitiveVocabularyDigest(terms, { key, generatedAt = new Date().toISOString() } = {}) {
  if (keyIsAbsent(key)) {
    throw new VocabularyKeyMissingError(
      "検査語彙を作るには鍵が要る（公開 salt の v1 は総当たりで復元されるので使わない）。",
    );
  }
  const useKey = normalizeVocabularyKey(key);
  const normalized = new Set();
  for (const raw of terms || []) {
    const term = normalizeVocabularyTerm(raw);
    const length = [...term].length;
    if (length < VOCABULARY_MIN_TERM_LENGTH || length > VOCABULARY_MAX_TERM_LENGTH) continue;
    if (/\s/u.test(term)) continue; // token 単位で照合するので空白を含む語は表現できない
    normalized.add(term);
  }
  const lengths = [...new Set([...normalized].map((term) => [...term].length))].sort((a, b) => a - b);
  // 語ごとの文字数は載せない。どの digest が何文字かが分かると、鍵が漏れたときの
  // 総当たり範囲をさらに絞らせる。照合に要るのは長さの集合だけ。
  const entries = [...normalized]
    .map((term) => ({ digest: digestVocabularyTerm(term, useKey) }))
    .sort((left, right) => left.digest.localeCompare(right.digest));
  return {
    version: SENSITIVE_VOCABULARY_DIGEST_VERSION,
    algorithm: "hmac-sha256(key, NFKC lowercase term)",
    keyId: vocabularyKeyId(useKey),
    generatedAt,
    termCount: entries.length,
    lengths,
    entries,
  };
}

/**
 * digest JSON を検証して照合用の形にする。壊れた一覧を「語彙あり」と数えない。
 * 鍵が無ければ VocabularyKeyMissingError、鍵が違えば throw する。違う鍵で照合すると
 * 何にも一致せず「無検出」になる——欠落を許可として扱う型そのもの。
 */
export function parseSensitiveVocabularyDigest(input, { key } = {}) {
  const parsed = typeof input === "string" ? JSON.parse(input) : input;
  if (!parsed || typeof parsed !== "object") throw new Error("sensitive vocabulary digest がobjectではない。");
  if (parsed.version === LEGACY_SALTED_DIGEST_VERSION) {
    throw new Error(
      "sensitive vocabulary digest v1 は公開 salt の SHA-256 で、短い名前は総当たりで復元される。"
      + "node scripts/audit-package-tarball.mjs build-vocabulary --new-key で v2 に作り直すこと。",
    );
  }
  if (parsed.version !== SENSITIVE_VOCABULARY_DIGEST_VERSION) {
    throw new Error(`sensitive vocabulary digest のversionが不明: ${JSON.stringify(parsed.version)}`);
  }
  if (Object.hasOwn(parsed, "salt")) throw new Error("sensitive vocabulary digest v2 に salt を載せない。");
  if (!KEY_ID_PATTERN.test(String(parsed.keyId || ""))) throw new Error("sensitive vocabulary digest のkeyIdが不正。");
  if (!Array.isArray(parsed.entries)) throw new Error("sensitive vocabulary digest にentriesが無い。");
  if (!Array.isArray(parsed.lengths) || parsed.lengths.length === 0) {
    throw new Error("sensitive vocabulary digest にlengthsが無い。");
  }
  const lengths = new Set();
  for (const length of parsed.lengths) {
    if (!Number.isInteger(length) || length < VOCABULARY_MIN_TERM_LENGTH || length > VOCABULARY_MAX_TERM_LENGTH) {
      throw new Error("sensitive vocabulary digest のlengthsが不正。");
    }
    lengths.add(length);
  }
  const digests = new Set();
  for (const entry of parsed.entries) {
    const keys = Object.keys(entry || {});
    if (keys.length !== 1 || keys[0] !== "digest" || !DIGEST_PATTERN.test(String(entry.digest || ""))) {
      // 語ごとの文字数などを後から足させない。
      throw new Error("sensitive vocabulary digest のentryが不正（digest 以外を載せない）。");
    }
    digests.add(entry.digest);
  }
  if (Number.isInteger(parsed.termCount) && parsed.termCount !== digests.size) {
    throw new Error("sensitive vocabulary digest のtermCountがentries数と一致しない。");
  }
  if (keyIsAbsent(key)) {
    throw new VocabularyKeyMissingError("sensitive vocabulary digest を照合する鍵が無い。");
  }
  const useKey = normalizeVocabularyKey(key);
  if (vocabularyKeyId(useKey) !== parsed.keyId) {
    throw new Error(
      "sensitive vocabulary digest の鍵が一致しない（違う鍵で照合すると何にも当たらず、無検出を合格と読む）。",
    );
  }
  return { key: useKey, keyId: parsed.keyId, digests, lengths, count: digests.size };
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
      // 区切り（. _ -）で分けた部分と、連続する部分のつながり。
      // 部分と全体だけを見ていたので、語彙の「xxx-yyy」が本文の「xxx-yyy-v1」の中に
      // あると見落とした（エピソード ID に版の接尾辞が付く、というよくある形）。
      const pieces = [];
      const pattern = /[^._-]+/gu;
      let piece;
      while ((piece = pattern.exec(token)) !== null) pieces.push({ start: piece.index, end: piece.index + piece[0].length });
      for (let first = 0; first < pieces.length; first += 1) {
        for (let last = first; last < Math.min(pieces.length, first + LATIN_JOIN_MAX); last += 1) {
          tokens.add(token.slice(pieces[first].start, pieces[last].end));
        }
      }
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
    if (vocabulary.digests.has(digestVocabularyTerm(normalized, vocabulary.key))) hits += 1;
  }
  return hits;
}

function resolveVocabulary(vocabularyDigest, vocabularyKey) {
  if (!vocabularyDigest) return null;
  if (vocabularyDigest.digests instanceof Set) return vocabularyDigest;
  return parseSensitiveVocabularyDigest(vocabularyDigest, { key: vocabularyKey });
}

function textContent(buffer) {
  if (buffer.length === 0) return "";
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  const nul = sample.reduce((count, byte) => count + (byte === 0 ? 1 : 0), 0);
  if (nul / sample.length > 0.005) return null;
  return buffer.toString("utf8");
}

export function auditPackageEntries(entries, {
  terms = [], castIds = [], homeRoot = "", allowlist = {}, requiredPaths = [], vocabularyDigest = null, vocabularyKey = null,
} = {}) {
  const vocabulary = resolveVocabulary(vocabularyDigest, vocabularyKey);
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
