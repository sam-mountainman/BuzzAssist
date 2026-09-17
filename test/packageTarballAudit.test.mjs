import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  PACKAGE_RUNTIME_REQUIRED_PATHS,
  auditPackageEntries,
  parseNpmTarball,
} from "../lib/packageTarballAudit.mjs";

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function tar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.content || "");
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    header.write(octal(0o644, 8), 100, 8, "ascii");
    header.write(octal(0, 8), 108, 8, "ascii");
    header.write(octal(0, 8), 116, 8, "ascii");
    header.write(octal(data.length, 12), 124, 12, "ascii");
    header.write(octal(0, 12), 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header[156] = (entry.type || "0").charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

test("actual tgz bytesをparseしpackage rootを除いたpathとSHAを得る", () => {
  const entries = parseNpmTarball(tar([
    { path: "package/package.json", content: '{"name":"fixture"}' },
    { path: "package/lib/a.mjs", content: "export const a = 1;" },
  ]));
  assert.deepEqual(entries.map((entry) => entry.path), ["lib/a.mjs", "package.json"]);
  assert.match(entries[0].sha256, /^[a-f0-9]{64}$/u);
});

test("path traversalとlink entryとchecksum改変を拒否する", () => {
  assert.throws(() => parseNpmTarball(tar([
    { path: "package/package.json", content: "{}" },
    { path: "package/../secret", content: "x" },
  ])), /pathが不正/u);
  assert.throws(() => parseNpmTarball(tar([
    { path: "package/package.json", content: "{}" },
    { path: "package/link", type: "2" },
  ])), /link entry/u);
  const corrupted = Buffer.from(tar([{ path: "package/package.json", content: "{}" }]));
  corrupted[corrupted.length - 5] ^= 0xff;
  assert.throws(() => parseNpmTarball(corrupted));
});

test("tarball本文の別端末path・Channel Pack語・禁止pathを値を漏らさず検出する", () => {
  const privateTerm = ["非", "公開", "番", "組"].join("");
  const localPath = ["", "Users", "private-builder", "work"].join("/");
  const entries = [
    { path: "package.json", bytes: 2, content: Buffer.from("{}") },
    { path: "docs/a.md", bytes: 1, content: Buffer.from(`${privateTerm} ${localPath}`) },
    { path: "channel-packs/private.json", bytes: 2, content: Buffer.from("{}") },
  ];
  const report = auditPackageEntries(entries, { terms: [privateTerm], homeRoot: "/unrelated/home" });
  assert.equal(report.status, "failed");
  assert.deepEqual(new Set(report.findings.map((finding) => finding.type)),
    new Set(["channel-term", "machine-local-path", "forbidden-path"]));
  assert.equal(JSON.stringify(report).includes(privateTerm), false, "検出値そのものをreportへ含めない");
});

test("Channel Pack signalが無いclean tarballをcleanとは偽らない", () => {
  const entries = [{ path: "package.json", bytes: 2, content: Buffer.from("{}") }];
  const report = auditPackageEntries(entries);
  assert.equal(report.gateOk, true);
  assert.equal(report.status, "incomplete");
  assert.equal(report.channelSignalsAvailable, false);
});

test("既知riskはfileと件数と理由へ拘束し、増えたら再び失敗する", () => {
  const entries = [
    { path: "package.json", bytes: 2, content: Buffer.from("{}") },
    { path: "lib/roster.mjs", bytes: 23, content: Buffer.from("alpha bravo charlie delta") },
  ];
  const base = {
    castIds: ["alpha", "bravo", "charlie", "delta"],
    allowlist: { roster: [{ file: "lib/roster.mjs", count: 3, why: "互換性のため残す既知riskを件数へ拘束している" }] },
  };
  assert.equal(auditPackageEntries(entries, base).status, "failed", "許容件数を超えたら失敗");
  base.allowlist.roster[0].count = 4;
  const accepted = auditPackageEntries(entries, base);
  assert.equal(accepted.status, "accepted-risk");
  assert.equal(accepted.findings.length, 0);
  assert.equal(accepted.accepted[0].count, 4);
});

test("actual distribution audit fails closed when a packaged narrated runner file is missing", () => {
  const complete = PACKAGE_RUNTIME_REQUIRED_PATHS.map((path) => ({ path, bytes: 1, content: Buffer.from("x") }));
  complete.push({ path: "package.json", bytes: 2, content: Buffer.from("{}") });
  assert.equal(auditPackageEntries(complete, { requiredPaths: PACKAGE_RUNTIME_REQUIRED_PATHS }).gateOk, true);
  const missing = complete.filter((entry) => entry.path !== "lib/narratedStoryVideo.mjs");
  const report = auditPackageEntries(missing, { requiredPaths: PACKAGE_RUNTIME_REQUIRED_PATHS });
  assert.equal(report.gateOk, false);
  assert.deepEqual(report.findings, [{ type: "missing-required-path", path: "lib/narratedStoryVideo.mjs" }]);
});

test("配布物は公開catalogを必須にし、本文つきlearning ledgerを禁止pathとして落とす", () => {
  assert.ok(PACKAGE_RUNTIME_REQUIRED_PATHS.includes("docs/learning/proposals.public.jsonl"));
  assert.equal(PACKAGE_RUNTIME_REQUIRED_PATHS.includes("docs/learning/proposals.jsonl"), false);
  for (const path of [
    "lib/harnessFeedbackUploadClient.mjs", "lib/harnessLearningCurator.mjs", "lib/packageTarballAudit.mjs",
    "scripts/harness-feedback.mjs", "scripts/harness-feedback-ingest.mjs", "scripts/harness-curator.mjs",
    "scripts/audit-package-tarball.mjs", "scripts/harness-learn.mjs", "scripts/harness-receipts.mjs",
  ]) assert.ok(PACKAGE_RUNTIME_REQUIRED_PATHS.includes(path), `${path} が必須一覧に無い`);
  const entries = PACKAGE_RUNTIME_REQUIRED_PATHS.map((path) => ({ path, bytes: 1, content: Buffer.from("x") }));
  entries.push({ path: "package.json", bytes: 2, content: Buffer.from("{}") });
  assert.equal(auditPackageEntries(entries, { requiredPaths: PACKAGE_RUNTIME_REQUIRED_PATHS }).gateOk, true);
  const leaked = [
    ...entries,
    { path: "docs/learning/proposals.jsonl", bytes: 2, content: Buffer.from("{}") },
    { path: "docs/learning/applied.jsonl", bytes: 2, content: Buffer.from("{}") },
  ];
  const report = auditPackageEntries(leaked, { requiredPaths: PACKAGE_RUNTIME_REQUIRED_PATHS });
  assert.deepEqual(report.findings.map((finding) => `${finding.type}:${finding.path}`).sort(), [
    "forbidden-path:docs/learning/applied.jsonl",
    "forbidden-path:docs/learning/proposals.jsonl",
  ]);
});

// ---------------------------------------------------------------------------
// Channel Pack 非依存の検査語彙（鍵つき digest）— 2026-09-05 独立レビュー D-1 / D-3 / R-D1
// 2026-09-17: 公開 salt の v1 は総当たりで復元できたので、鍵つき v2 へ移した。
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SENSITIVE_VOCABULARY_DIGEST_VERSION,
  SENSITIVE_VOCABULARY_KEY_ENV,
  VocabularyKeyMissingError,
  buildSensitiveVocabularyDigest,
  countVocabularyDigestHits,
  extractVocabularyTokens,
  parseSensitiveVocabularyDigest,
  resolveVocabularyKey,
  vocabularyKeyId,
} from "../lib/packageTarballAudit.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const AUDIT_CLI = join(REPO_ROOT, "scripts", "audit-package-tarball.mjs");

// 合成語。実在の名前をテストへ書かないため、文字を組み立てる。
const SURNAME = ["架", "空"].join("");                 // 漢字2字の姓
const KANA_NAME = ["テ", "ス", "ト", "ネ"].join("");    // カタカナ名
const CUSTOMER_ID = ["cust", "omer", "-xyz"].join(""); // 顧客識別子
const SCRATCH_ID = ["scratch", "-", "777"].join("");   // 端末の作業dir名
// テスト用の鍵。本番の鍵はリポジトリの外にだけ置く。
const TEST_KEY = "5f".repeat(32);
const OTHER_KEY = "a7".repeat(32);
const UNIT_SEPARATOR = String.fromCharCode(0x1f);

function fixtureVocabulary(key = TEST_KEY) {
  return buildSensitiveVocabularyDigest([SURNAME, KANA_NAME, CUSTOMER_ID, SCRATCH_ID], { key });
}

test("digest語彙は平文を含まず、壊れた一覧・鍵の無い照合・違う鍵での照合を語彙ありとして受け取らない", () => {
  const digest = fixtureVocabulary();
  const serialized = JSON.stringify(digest);
  for (const term of [SURNAME, KANA_NAME, CUSTOMER_ID, SCRATCH_ID]) {
    assert.equal(serialized.includes(term), false, "digest JSON に語そのものが載っている");
  }
  assert.equal(serialized.includes(TEST_KEY), false, "digest JSON に鍵が載っている");
  assert.equal(digest.version, SENSITIVE_VOCABULARY_DIGEST_VERSION);
  assert.equal(digest.termCount, 4);
  assert.equal(digest.keyId, vocabularyKeyId(TEST_KEY));
  const parsed = parseSensitiveVocabularyDigest(serialized, { key: TEST_KEY });
  assert.equal(parsed.count, 4);
  assert.throws(() => parseSensitiveVocabularyDigest({ ...digest, version: "other" }, { key: TEST_KEY }), /version/u);
  assert.throws(() => parseSensitiveVocabularyDigest({ ...digest, termCount: 3 }, { key: TEST_KEY }), /termCount/u);
  assert.throws(() => parseSensitiveVocabularyDigest({ ...digest, entries: [{ digest: "zz" }] }, { key: TEST_KEY }), /entry/u);
  // 語ごとの文字数を後から足させない（総当たりの範囲を絞らせる）。
  assert.throws(
    () => parseSensitiveVocabularyDigest({ ...digest, entries: digest.entries.map((e) => ({ ...e, length: 2 })) }, { key: TEST_KEY }),
    /digest 以外を載せない/u,
  );
  assert.throws(() => parseSensitiveVocabularyDigest({ ...digest, salt: "0".repeat(32) }, { key: TEST_KEY }), /salt を載せない/u);
  // 公開 salt の v1 は、形が正しくても受け取らない。
  assert.throws(
    () => parseSensitiveVocabularyDigest({ version: "buzzassist-sensitive-vocabulary-digest-v1", salt: "0".repeat(32), entries: [] }),
    /総当たりで復元される/u,
  );
  // 鍵が無いのは「語彙なし」ではなく、専用の印で止まる。
  assert.throws(() => parseSensitiveVocabularyDigest(digest, {}), (error) => error instanceof VocabularyKeyMissingError);
  // 違う鍵で照合すると何にも当たらず無検出になる——それを合格と読ませない。
  assert.throws(() => parseSensitiveVocabularyDigest(digest, { key: OTHER_KEY }), /鍵が一致しない/u);
  // v1 の salt（16バイト）を鍵として渡す取り違えも拒否する。
  assert.throws(() => parseSensitiveVocabularyDigest(digest, { key: "0123456789abcdef0123456789abcdef" }), /hex/u);
  // 同じ鍵なら同じ語は同じ digest（再生成で差分が語の増減だけになる）。鍵が違えば別物。
  assert.deepEqual(fixtureVocabulary().entries, digest.entries);
  assert.notDeepEqual(fixtureVocabulary(OTHER_KEY).entries, digest.entries);
  // 空白入り・1文字は token として照合できないので落とす
  assert.equal(buildSensitiveVocabularyDigest(["a", "two words"], { key: TEST_KEY }).termCount, 0);
  assert.throws(() => buildSensitiveVocabularyDigest([SURNAME], {}), (error) => error instanceof VocabularyKeyMissingError);
});

test("公開される digest ファイルだけからは、どの語の digest も計算できない", () => {
  // v1 は「公開 salt + SHA-256」で、語彙を持たない第三者がひらがな・カタカナ
  // 3文字までの総当たりだけで 28 件中 4 件を 1.9 秒で復元できた（2026-09-17）。
  // ファイルに載っているどの値を使っても、語から digest を再現できないことを固定する。
  const digest = fixtureVocabulary();
  const published = new Set(digest.entries.map((entry) => entry.digest));
  const scalars = [];
  const walk = (value) => {
    if (value && typeof value === "object") Object.values(value).forEach(walk);
    else if (value !== undefined && value !== null) scalars.push(String(value));
  };
  walk({ ...digest, entries: [] });
  for (const term of [SURNAME, KANA_NAME, CUSTOMER_ID, SCRATCH_ID]) {
    const normalized = term.normalize("NFKC").toLowerCase();
    for (const candidate of ["", ...scalars]) {
      const plain = createHash("sha256").update(`${candidate}${UNIT_SEPARATOR}${normalized}`, "utf8").digest("hex");
      const keyed = createHmac("sha256", candidate).update(normalized, "utf8").digest("hex");
      assert.equal(published.has(plain), false, "公開値を salt にした SHA-256 で digest が再現できる");
      assert.equal(published.has(keyed), false, "公開値を鍵にした HMAC で digest が再現できる");
    }
  }
  assert.deepEqual(
    Object.keys(digest).sort(),
    ["algorithm", "entries", "generatedAt", "keyId", "lengths", "termCount", "version"],
    "公開ファイルに載せる項目を増やすときは、復元に使えないかを先に確かめる",
  );
});

test("鍵は環境変数か、リポジトリ外の鍵ファイルからだけ読む", () => {
  const missing = () => { throw Object.assign(new Error("none"), { code: "ENOENT" }); };
  const fromFile = () => `${TEST_KEY}\n`;
  // 環境変数が優先。
  assert.equal(resolveVocabularyKey({ env: { [SENSITIVE_VOCABULARY_KEY_ENV]: OTHER_KEY }, home: "/h", readKeyFile: fromFile }).source, "env");
  // 無ければ鍵ファイル。
  const file = resolveVocabularyKey({ env: {}, home: "/h", readKeyFile: fromFile });
  assert.equal(file.source, "file");
  assert.equal(file.key.toString("hex"), TEST_KEY);
  // どちらも無ければ、理由つきで key: null。
  const none = resolveVocabularyKey({ env: {}, home: "/h", readKeyFile: missing });
  assert.equal(none.key, null);
  assert.match(none.reason, /鍵が無い/u);
  // リポジトリ配下の鍵ファイルは使わない（git add -A で公開される）。
  assert.throws(
    () => resolveVocabularyKey({ env: {}, keyPath: "/repo/docs/key", projectDir: "/repo", readKeyFile: fromFile }),
    /リポジトリ配下/u,
  );
  // 既定の置き場（HOME 配下）は、プロジェクトが HOME そのものでも使える。
  assert.equal(resolveVocabularyKey({ env: {}, home: "/h", projectDir: "/h", readKeyFile: fromFile }).source, "file");
  // 短い鍵は拒否。
  assert.throws(() => resolveVocabularyKey({ env: { [SENSITIVE_VOCABULARY_KEY_ENV]: "abcd" } }), /hex/u);
});

test("overlay風の根拠行から姓（漢字連の内側）・カタカナ名・顧客ID・作業dir名を値を出さずに検出する", () => {
  const vocabulary = parseSensitiveVocabularyDigest(fixtureVocabulary(), { key: TEST_KEY });
  const evidence = [
    `  - 根拠: client-work/${CUSTOMER_ID}/episode-v1/reports/review.md V18-001;`,
    `運営者${SURNAME}太郎の訂正。実例: ${KANA_NAME}OLがカーディガン→ブレザー化。`,
    `掃除先: /private/tmp/${SCRATCH_ID}の旧scratchpad`,
  ].join(" ");
  assert.equal(countVocabularyDigestHits(evidence, vocabulary), 4);
  assert.equal(countVocabularyDigestHits(evidence.toUpperCase(), vocabulary) >= 2, true, "大文字化でLatin語を逃さない");
  // カナ連は全体一致だけ——名前を含むだけの長い一般語には当てない
  assert.equal(countVocabularyDigestHits(`${KANA_NAME}ーション は一般語`, vocabulary), 0);
  // 語彙に無い文は 0
  assert.equal(countVocabularyDigestHits("課金APIの再送は 429/5xx/ネットワーク断だけ。", vocabulary), 0);
  const tokens = extractVocabularyTokens(`${CUSTOMER_ID}/x ${SURNAME}太郎`);
  assert.ok(tokens.has(CUSTOMER_ID) && tokens.has(SURNAME) && tokens.has(`${SURNAME}太郎`));

  const entries = [
    { path: "package.json", bytes: 2, content: Buffer.from("{}") },
    { path: ".agents/skills/x/references/learned-auto.md", bytes: evidence.length, content: Buffer.from(evidence) },
  ];
  const report = auditPackageEntries(entries, { vocabularyDigest: fixtureVocabulary(), vocabularyKey: TEST_KEY, homeRoot: "/unrelated/home" });
  assert.equal(report.status, "failed");
  assert.deepEqual(report.findings, [{ type: "private-term", path: ".agents/skills/x/references/learned-auto.md", count: 4 }]);
  const serialized = JSON.stringify(report);
  for (const term of [SURNAME, KANA_NAME, CUSTOMER_ID, SCRATCH_ID]) assert.equal(serialized.includes(term), false);
  assert.equal(serialized.includes(TEST_KEY), false, "監査結果に鍵を出さない");
});

test("digest語彙だけでも signals あり＝clean、語彙ゼロは incomplete で signalsAvailable=false", () => {
  const entries = [{ path: "package.json", bytes: 2, content: Buffer.from("{}") }];
  const withDigest = auditPackageEntries(entries, { vocabularyDigest: fixtureVocabulary(), vocabularyKey: TEST_KEY });
  assert.equal(withDigest.status, "clean");
  assert.equal(withDigest.channelSignalsAvailable, false);
  assert.equal(withDigest.vocabularyDigestAvailable, true);
  assert.equal(withDigest.vocabularyTermCount, 4);
  assert.equal(withDigest.signalsAvailable, true);
  const none = auditPackageEntries(entries);
  assert.equal(none.status, "incomplete");
  assert.equal(none.signalsAvailable, false);
  assert.equal(none.gateOk, true, "gateOk は findings の有無だけ。signals の欠落は別枝で fail-closed にする");
  // 壊れた digest は黙って「語彙なし」にせず例外
  assert.throws(() => auditPackageEntries(entries, { vocabularyDigest: { version: "x" }, vocabularyKey: TEST_KEY }), /version/u);
  // 鍵を渡さずに digest だけ渡しても、黙って「語彙なし」にしない
  assert.throws(
    () => auditPackageEntries(entries, { vocabularyDigest: fixtureVocabulary() }),
    (error) => error instanceof VocabularyKeyMissingError,
  );
});

test("private-term の既知riskは privateTerm bucket で file・件数・理由へ拘束する", () => {
  const body = `${CUSTOMER_ID} と ${SURNAME}`;
  const entries = [
    { path: "package.json", bytes: 2, content: Buffer.from("{}") },
    { path: "docs/legacy.md", bytes: body.length, content: Buffer.from(body) },
  ];
  const base = { vocabularyDigest: fixtureVocabulary(), vocabularyKey: TEST_KEY };
  assert.equal(auditPackageEntries(entries, base).status, "failed");
  const tooSmall = { ...base, allowlist: { privateTerm: [{ file: "docs/legacy.md", count: 1, why: "互換性のため残す既知riskを件数へ拘束している" }] } };
  assert.equal(auditPackageEntries(entries, tooSmall).status, "failed", "許容件数を超えたら失敗");
  const exact = { ...base, allowlist: { privateTerm: [{ file: "docs/legacy.md", count: 2, why: "互換性のため残す既知riskを件数へ拘束している" }] } };
  assert.equal(auditPackageEntries(entries, exact).status, "accepted-risk");
  // term bucket（Channel Pack 語）へ書いても private-term は通らない
  const wrongBucket = { ...base, allowlist: { term: [{ file: "docs/legacy.md", count: 2, why: "互換性のため残す既知riskを件数へ拘束している" }] } };
  assert.equal(auditPackageEntries(entries, wrongBucket).status, "failed");
});

// 必須pathを揃えた fixture。無いと missing-required-path で exit 2 になり、signals の判定を見られない。
function fixtureTar(extra = []) {
  return tar([
    { path: "package/package.json", content: '{"name":"fixture"}' },
    ...PACKAGE_RUNTIME_REQUIRED_PATHS.map((path) => ({ path: `package/${path}`, content: "x" })),
    ...extra,
  ]);
}

// 開発者の本物の鍵（~/.buzzassist/）や環境変数に依存しないよう、HOME を隔離する。
function isolatedEnv(dir, extra = {}) {
  // HOME はプロジェクトの外に置く（実運用と同じ位置関係）。
  const home = `${dir}-home`;
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...extra };
  if (!(SENSITIVE_VOCABULARY_KEY_ENV in extra)) delete env[SENSITIVE_VOCABULARY_KEY_ENV];
  return env;
}

function runCli(args, { cwd = REPO_ROOT, env = process.env } = {}) {
  return spawnSync(process.execPath, [AUDIT_CLI, ...args], { cwd, env, encoding: "utf8", timeout: 60_000 });
}

test("CLI は語彙ゼロの無検出を exit 3 で止め、--allow-missing-signals だけが通す", () => {
  const dir = mkdtempSync(join(tmpdir(), "buzzassist-audit-cli-"));
  try {
    const env = isolatedEnv(dir);
    const tgz = join(dir, "fixture.tgz");
    writeFileSync(tgz, fixtureTar());
    const strict = runCli(["--tarball", tgz, "--project-dir", dir, "--json"], { env });
    assert.equal(strict.status, 3, strict.stderr);
    const report = JSON.parse(strict.stdout);
    assert.equal(report.status, "incomplete");
    assert.equal(report.signalsAvailable, false);
    assert.match(strict.stderr, /検査語彙が無い/u);
    // 旧 --require-signals も同じ結果（互換のため受理する）
    assert.equal(runCli(["--tarball", tgz, "--project-dir", dir, "--require-signals"], { env }).status, 3);
    const relaxed = runCli(["--tarball", tgz, "--project-dir", dir, "--allow-missing-signals"], { env });
    assert.equal(relaxed.status, 0, relaxed.stderr);
    assert.match(relaxed.stdout, /incomplete/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI build-vocabulary は鍵をリポジトリ外に作り、audit が同梱本文の語を exit 2 で落とす。鍵が無ければ未検査で止まる", () => {
  const dir = mkdtempSync(join(tmpdir(), "buzzassist-audit-vocab-"));
  const keyDir = mkdtempSync(join(tmpdir(), "buzzassist-audit-key-"));
  try {
    const env = isolatedEnv(dir);
    const keyFile = join(keyDir, "vocab.key");
    const termsFile = join(dir, "terms.local.txt");
    writeFileSync(termsFile, `# comment\n${CUSTOMER_ID}\n${SURNAME}   # 姓\n\n${KANA_NAME}\n`);
    const digestFile = join(dir, "vocab.digest.json");
    const base = ["build-vocabulary", "--terms-file", termsFile, "--output", digestFile, "--project-dir", dir, "--key-file", keyFile];

    // 鍵が無ければ作らない（黙って作ると、別の端末で照合できない一覧ができる）。
    const noKey = runCli(base, { env });
    assert.equal(noKey.status, 1);
    assert.match(noKey.stderr, /--new-key/u);

    const built = runCli([...base, "--new-key"], { env });
    assert.equal(built.status, 0, built.stderr);
    const result = JSON.parse(built.stdout);
    assert.equal(result.termCount, 3);
    assert.equal(result.keyCreated, true);
    assert.equal(built.stdout.includes(readFileSync(keyFile, "utf8").trim()), false, "鍵を出力しない");
    // Windows は POSIX の権限ビットを持たない（Node は書き込み可否しか反映しない）。
    if (process.platform !== "win32") assert.equal(statSync(keyFile).mode & 0o777, 0o600, "鍵ファイルは本人だけが読める");
    const digestText = readFileSync(digestFile, "utf8");
    for (const term of [CUSTOMER_ID, SURNAME, KANA_NAME]) assert.equal(digestText.includes(term), false);
    const keyId = JSON.parse(digestText).keyId;

    // 既定は鍵を維持して、差分を語の増減だけにする。
    const rebuilt = runCli(base, { env });
    assert.equal(rebuilt.status, 0, rebuilt.stderr);
    assert.equal(JSON.parse(rebuilt.stdout).keyCreated, false);
    assert.equal(JSON.parse(readFileSync(digestFile, "utf8")).keyId, keyId);
    // --new-key は既存の鍵を上書きしない。作り直すのは --rotate-key だけ。
    assert.equal(JSON.parse(runCli([...base, "--new-key"], { env }).stdout).keyId, keyId);
    // 廃止した --new-salt は理由つきで拒否する。
    const oldFlag = runCli([...base, "--new-salt"], { env });
    assert.equal(oldFlag.status, 1);
    assert.match(oldFlag.stderr, /総当たり/u);
    // リポジトリ（projectDir）配下に鍵を作らない。
    const inside = runCli(["build-vocabulary", "--terms-file", termsFile, "--output", digestFile, "--project-dir", dir, "--key-file", join(dir, "k.key"), "--new-key"], { env });
    assert.equal(inside.status, 1);
    assert.match(inside.stderr, /リポジトリ配下/u);
    assert.equal(runCli(["build-vocabulary", "--output", digestFile, "--project-dir", dir, "--key-file", keyFile], { env }).status, 1, "語ゼロの一覧は作らない");

    const leaking = fixtureTar([
      { path: "package/.agents/skills/x/references/learned-auto.md", content: `- 根拠: client-work/${CUSTOMER_ID}/v1 と ${SURNAME}さん` },
    ]);
    const tgz = join(dir, "leaking.tgz");
    writeFileSync(tgz, leaking);
    const keyEnv = isolatedEnv(dir, { [SENSITIVE_VOCABULARY_KEY_ENV]: readFileSync(keyFile, "utf8").trim() });
    const audited = runCli(["--tarball", tgz, "--project-dir", dir, "--vocabulary", digestFile], { env: keyEnv });
    assert.equal(audited.status, 2, audited.stderr);
    assert.match(audited.stdout, /private-term: \.agents\/skills\/x\/references\/learned-auto\.md \(2\)/u);
    assert.match(audited.stdout, /vocabulary-digest=3/u);
    for (const term of [CUSTOMER_ID, SURNAME]) assert.equal(audited.stdout.includes(term), false, "CLI 出力に語を出さない");

    // 一覧はあるのに鍵が無い＝その語を見ていない。exit 3（未検査）で止まる。
    const blind = runCli(["--tarball", tgz, "--project-dir", dir, "--vocabulary", digestFile], { env });
    assert.equal(blind.status, 3, blind.stderr);
    assert.match(blind.stderr, /鍵が無い/u);
    assert.match(blind.stdout, /vocabulary-digest=missing-key/u);

    // 作り直した鍵では、古い一覧を照合しない（違う鍵で「無検出」にしない）。
    assert.equal(runCli([...base, "--rotate-key"], { env }).status, 0);
    const rotatedEnv = isolatedEnv(dir, { [SENSITIVE_VOCABULARY_KEY_ENV]: readFileSync(keyFile, "utf8").trim() });
    writeFileSync(digestFile.replace(".json", ".old.json"), digestText);
    const stale = runCli(["--tarball", tgz, "--project-dir", dir, "--vocabulary", digestFile.replace(".json", ".old.json")], { env: rotatedEnv });
    assert.equal(stale.status, 1, stale.stderr);
    assert.match(stale.stderr, /鍵が一致しない/u);

    writeFileSync(tgz, fixtureTar());
    const ok = runCli(["--tarball", tgz, "--project-dir", dir, "--vocabulary", digestFile], { env: rotatedEnv });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /audit: clean/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}-home`, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
  }
});

test("リポジトリは鍵つき digest 語彙をコミットし、平文一覧と鍵は追跡外かつ配布禁止", () => {
  const digestPath = join(REPO_ROOT, "docs", "learning", "sensitive-vocabulary.digest.json");
  assert.ok(existsSync(digestPath), "docs/learning/sensitive-vocabulary.digest.json が無いと CI では語彙ゼロになる");
  const text = readFileSync(digestPath, "utf8");
  const raw = JSON.parse(text);
  assert.equal(raw.version, SENSITIVE_VOCABULARY_DIGEST_VERSION, "公開 salt の v1 をコミットしない");
  assert.equal("salt" in raw, false);
  // 鍵が無い環境（CI）では、形は正しいが照合できない、という状態であること。
  assert.throws(() => parseSensitiveVocabularyDigest(text, {}), (error) => error instanceof VocabularyKeyMissingError);
  // 鍵がある環境（運営側の端末、secret を渡した CI）では照合できること。
  const key = process.env[SENSITIVE_VOCABULARY_KEY_ENV];
  if (key) assert.ok(parseSensitiveVocabularyDigest(text, { key }).count >= 1);

  const files = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).files;
  assert.equal(files.some((entry) => entry.includes("sensitive-vocabulary")), false, "語彙ファイルは配布物に入れない");
  const entries = [
    { path: "package.json", bytes: 2, content: Buffer.from("{}") },
    { path: "docs/learning/sensitive-vocabulary.local.txt", bytes: 1, content: Buffer.from("x") },
  ];
  assert.deepEqual(auditPackageEntries(entries, { vocabularyDigest: fixtureVocabulary(), vocabularyKey: TEST_KEY }).findings,
    [{ type: "forbidden-path", path: "docs/learning/sensitive-vocabulary.local.txt" }]);
  for (const privateFile of ["docs/learning/sensitive-vocabulary.local.txt", "docs/learning/sensitive-vocabulary.key"]) {
    const ignored = spawnSync("git", ["check-ignore", "-q", privateFile], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(ignored.status, 0, `${privateFile} が .gitignore に無い`);
  }
});

test("英数字の識別子は、区切りの後ろに接尾辞が続いても語彙に当たる", () => {
  // 部分と全体だけを照合していたので、語彙の「xxx-yyy」が本文の「xxx-yyy-v1」の
  // 中にあると見落とした（エピソード ID に版の接尾辞が付く、よくある形）。
  const vocabulary = parseSensitiveVocabularyDigest(buildSensitiveVocabularyDigest([CUSTOMER_ID], { key: TEST_KEY }), { key: TEST_KEY });
  assert.equal(countVocabularyDigestHits(`episodes/${CUSTOMER_ID}-v1/audits`, vocabulary), 1);
  assert.equal(countVocabularyDigestHits(`prefix_${CUSTOMER_ID}.json`, vocabulary), 1);
  // 一部だけ一致しても当てない（部分の境界で切る）。
  assert.equal(countVocabularyDigestHits(`${CUSTOMER_ID}x-v1`, vocabulary), 0);
  const tokens = extractVocabularyTokens("a-b-c");
  for (const expected of ["a", "b", "c", "a-b", "b-c", "a-b-c"]) assert.ok(tokens.has(expected), expected);
});

test("tarball を作る npm の起動は、Windows でもシェル経由で起動でき、空白を含むパスを壊さない", async () => {
  // "npm" をシェルなしで起動していたので、Windows の CI で spawnSync npm ENOENT になった。
  const { npmInvocation } = await import("../scripts/audit-package-tarball.mjs");
  assert.deepEqual(
    npmInvocation(["pack", "--pack-destination", "C:\\Users\\A B\\Temp"], { env: {}, platform: "win32" }),
    { command: "npm.cmd", args: ['"pack"', '"--pack-destination"', '"C:\\Users\\A B\\Temp"'], shell: true },
  );
  assert.deepEqual(
    npmInvocation(["pack"], { env: { npm_execpath: "C:\\npm\\bin\\npm-cli.js" }, platform: "win32", execPath: "C:\\node.exe" }),
    { command: "C:\\node.exe", args: ["C:\\npm\\bin\\npm-cli.js", "pack"], shell: false },
    "npm run から呼ばれたときは npm 本体をシェルを通さずに起動する",
  );
  assert.deepEqual(npmInvocation(["pack"], { env: {}, platform: "linux" }), { command: "npm", args: ["pack"], shell: false });
});
