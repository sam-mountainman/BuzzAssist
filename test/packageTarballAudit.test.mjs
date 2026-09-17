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
// Channel Pack 非依存の検査語彙（salted digest）— 2026-09-05 独立レビュー D-1 / D-3 / R-D1
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SENSITIVE_VOCABULARY_DIGEST_VERSION,
  buildSensitiveVocabularyDigest,
  countVocabularyDigestHits,
  extractVocabularyTokens,
  parseSensitiveVocabularyDigest,
} from "../lib/packageTarballAudit.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const AUDIT_CLI = join(REPO_ROOT, "scripts", "audit-package-tarball.mjs");

// 合成語。実在の名前をテストへ書かないため、文字を組み立てる。
const SURNAME = ["架", "空"].join("");                 // 漢字2字の姓
const KANA_NAME = ["テ", "ス", "ト", "ネ"].join("");    // カタカナ名
const CUSTOMER_ID = ["cust", "omer", "-xyz"].join(""); // 顧客識別子
const SCRATCH_ID = ["scratch", "-", "777"].join("");   // 端末の作業dir名

function fixtureVocabulary() {
  return buildSensitiveVocabularyDigest([SURNAME, KANA_NAME, CUSTOMER_ID, SCRATCH_ID], { salt: "0123456789abcdef0123456789abcdef" });
}

test("digest語彙は平文を含まず、壊れた一覧を語彙ありとして受け取らない", () => {
  const digest = fixtureVocabulary();
  const serialized = JSON.stringify(digest);
  for (const term of [SURNAME, KANA_NAME, CUSTOMER_ID, SCRATCH_ID]) {
    assert.equal(serialized.includes(term), false, "digest JSON に語そのものが載っている");
  }
  assert.equal(digest.version, SENSITIVE_VOCABULARY_DIGEST_VERSION);
  assert.equal(digest.termCount, 4);
  const parsed = parseSensitiveVocabularyDigest(serialized);
  assert.equal(parsed.count, 4);
  assert.throws(() => parseSensitiveVocabularyDigest({ ...digest, version: "other" }), /version/u);
  assert.throws(() => parseSensitiveVocabularyDigest({ ...digest, termCount: 3 }), /termCount/u);
  assert.throws(() => parseSensitiveVocabularyDigest({ ...digest, salt: "short" }), /salt/u);
  assert.throws(() => parseSensitiveVocabularyDigest({ ...digest, entries: [{ digest: "zz", length: 2 }] }), /entry/u);
  // 同じ salt なら同じ語は同じ digest（再生成で差分が語の増減だけになる）
  assert.deepEqual(fixtureVocabulary().entries, digest.entries);
  // 空白入り・1文字は token として照合できないので落とす
  assert.equal(buildSensitiveVocabularyDigest(["a", "two words"], { salt: digest.salt }).termCount, 0);
});

test("overlay風の根拠行から姓（漢字連の内側）・カタカナ名・顧客ID・作業dir名を値を出さずに検出する", () => {
  const vocabulary = parseSensitiveVocabularyDigest(fixtureVocabulary());
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
  const report = auditPackageEntries(entries, { vocabularyDigest: fixtureVocabulary(), homeRoot: "/unrelated/home" });
  assert.equal(report.status, "failed");
  assert.deepEqual(report.findings, [{ type: "private-term", path: ".agents/skills/x/references/learned-auto.md", count: 4 }]);
  const serialized = JSON.stringify(report);
  for (const term of [SURNAME, KANA_NAME, CUSTOMER_ID, SCRATCH_ID]) assert.equal(serialized.includes(term), false);
});

test("digest語彙だけでも signals あり＝clean、語彙ゼロは incomplete で signalsAvailable=false", () => {
  const entries = [{ path: "package.json", bytes: 2, content: Buffer.from("{}") }];
  const withDigest = auditPackageEntries(entries, { vocabularyDigest: fixtureVocabulary() });
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
  assert.throws(() => auditPackageEntries(entries, { vocabularyDigest: { version: "x" } }), /version/u);
});

test("private-term の既知riskは privateTerm bucket で file・件数・理由へ拘束する", () => {
  const body = `${CUSTOMER_ID} と ${SURNAME}`;
  const entries = [
    { path: "package.json", bytes: 2, content: Buffer.from("{}") },
    { path: "docs/legacy.md", bytes: body.length, content: Buffer.from(body) },
  ];
  const base = { vocabularyDigest: fixtureVocabulary() };
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

function runCli(args, { cwd = REPO_ROOT } = {}) {
  return spawnSync(process.execPath, [AUDIT_CLI, ...args], { cwd, encoding: "utf8", timeout: 60_000 });
}

test("CLI は語彙ゼロの無検出を exit 3 で止め、--allow-missing-signals だけが通す", () => {
  const dir = mkdtempSync(join(tmpdir(), "buzzassist-audit-cli-"));
  try {
    const tgz = join(dir, "fixture.tgz");
    writeFileSync(tgz, fixtureTar());
    const strict = runCli(["--tarball", tgz, "--project-dir", dir, "--json"]);
    assert.equal(strict.status, 3, strict.stderr);
    const report = JSON.parse(strict.stdout);
    assert.equal(report.status, "incomplete");
    assert.equal(report.signalsAvailable, false);
    assert.match(strict.stderr, /検査語彙が無い/u);
    // 旧 --require-signals も同じ結果（互換のため受理する）
    assert.equal(runCli(["--tarball", tgz, "--project-dir", dir, "--require-signals"]).status, 3);
    const relaxed = runCli(["--tarball", tgz, "--project-dir", dir, "--allow-missing-signals"]);
    assert.equal(relaxed.status, 0, relaxed.stderr);
    assert.match(relaxed.stdout, /incomplete/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI build-vocabulary は平文一覧から digest を書き、audit --vocabulary が同梱本文の語を exit 2 で落とす", () => {
  const dir = mkdtempSync(join(tmpdir(), "buzzassist-audit-vocab-"));
  try {
    const termsFile = join(dir, "terms.local.txt");
    writeFileSync(termsFile, `# comment\n${CUSTOMER_ID}\n${SURNAME}   # 姓\n\n${KANA_NAME}\n`);
    const digestFile = join(dir, "vocab.digest.json");
    const built = runCli(["build-vocabulary", "--terms-file", termsFile, "--output", digestFile, "--project-dir", dir]);
    assert.equal(built.status, 0, built.stderr);
    assert.equal(JSON.parse(built.stdout).termCount, 3);
    const digestText = readFileSync(digestFile, "utf8");
    for (const term of [CUSTOMER_ID, SURNAME, KANA_NAME]) assert.equal(digestText.includes(term), false);
    const salt = JSON.parse(digestText).salt;
    const rebuilt = runCli(["build-vocabulary", "--terms-file", termsFile, "--output", digestFile, "--project-dir", dir]);
    assert.equal(JSON.parse(rebuilt.stdout).saltReused, true);
    assert.equal(JSON.parse(readFileSync(digestFile, "utf8")).salt, salt, "既定は salt を維持して差分を語の増減だけにする");
    assert.equal(runCli(["build-vocabulary", "--output", digestFile, "--project-dir", dir]).status, 1, "語ゼロの一覧は作らない");

    const leaking = fixtureTar([
      { path: "package/.agents/skills/x/references/learned-auto.md", content: `- 根拠: client-work/${CUSTOMER_ID}/v1 と ${SURNAME}さん` },
    ]);
    const tgz = join(dir, "leaking.tgz");
    writeFileSync(tgz, leaking);
    const audited = runCli(["--tarball", tgz, "--project-dir", dir, "--vocabulary", digestFile]);
    assert.equal(audited.status, 2, audited.stderr);
    assert.match(audited.stdout, /private-term: \.agents\/skills\/x\/references\/learned-auto\.md \(2\)/u);
    assert.match(audited.stdout, /vocabulary-digest=3/u);
    for (const term of [CUSTOMER_ID, SURNAME]) assert.equal(audited.stdout.includes(term), false, "CLI 出力に語を出さない");

    writeFileSync(tgz, fixtureTar());
    const ok = runCli(["--tarball", tgz, "--project-dir", dir, "--vocabulary", digestFile]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /audit: clean/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("リポジトリは digest 語彙をコミットし、平文一覧は追跡外かつ配布禁止", () => {
  const digestPath = join(REPO_ROOT, "docs", "learning", "sensitive-vocabulary.digest.json");
  assert.ok(existsSync(digestPath), "docs/learning/sensitive-vocabulary.digest.json が無いと CI では語彙ゼロになる");
  const parsed = parseSensitiveVocabularyDigest(readFileSync(digestPath, "utf8"));
  assert.ok(parsed.count >= 1);
  const files = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).files;
  assert.equal(files.some((entry) => entry.includes("sensitive-vocabulary")), false, "語彙ファイルは配布物に入れない");
  const entries = [
    { path: "package.json", bytes: 2, content: Buffer.from("{}") },
    { path: "docs/learning/sensitive-vocabulary.local.txt", bytes: 1, content: Buffer.from("x") },
  ];
  assert.deepEqual(auditPackageEntries(entries, { vocabularyDigest: fixtureVocabulary() }).findings,
    [{ type: "forbidden-path", path: "docs/learning/sensitive-vocabulary.local.txt" }]);
  const ignored = spawnSync("git", ["check-ignore", "-q", "docs/learning/sensitive-vocabulary.local.txt"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(ignored.status, 0, "平文一覧が .gitignore に無い");
});
