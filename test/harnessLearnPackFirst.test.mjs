// channel-pack 宛の正本は Channel Pack を先に読む（ops-7 の回帰テスト）。
//
// 以前の harness-learn は、channel-pack 宛の正本をリポジトリの docs/ から先に探し、
// そこに無いときだけ pack を見ていた。docs/ には pack へ移す前の写しが git 管理外の
// まま残りうるので、**古い写しがあると promote / apply はその写しで印を探し、その
// 写しの sha256 を記録した**。status の読み取り側は pack をまったく見ていなかった。
//
// ここのテストは一時ディレクトリだけを使う。本物のリポジトリの台帳や本物の
// Channel Pack には触れない。宛先・pack・人名はすべて合成。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  HUMAN_VERIFIED,
  createCanonicalReaders,
  describeCanonicalResolution,
  promotionMarker,
  proposalId,
  requireWritableTarget,
  resolveCanonicalTarget,
  resolveRecordedCanonical,
  summarizeProposals,
} from "../scripts/harness-learn.mjs";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEARN_SCRIPT = path.join(SOURCE_ROOT, "scripts", "harness-learn.mjs");

const PACK_ID = "sample-channel";
const PACK_TARGET = `channel-pack:${PACK_ID}`;
const SHARED_TARGET = "platform:sample-craft";
const CANONICAL_REL = "docs/sample-channel-requirements-ledger.md";
const SHARED_REL = ".agents/skills/sample-craft/SKILL.md";
const TARGETS = {
  [PACK_TARGET]: {
    mode: "review-only",
    canonical: CANONICAL_REL,
    reason: "テスト用の合成台帳",
    scope: "channel-pack",
    packId: PACK_ID,
    confidential: true,
  },
  [SHARED_TARGET]: {
    mode: "auto-guidance",
    canonical: SHARED_REL,
    overlay: ".agents/skills/sample-craft/references/learned-auto.md",
    scope: "platform",
  },
};
const OPTIONS = (repoRoot) => ({ repoRoot, targets: TARGETS, deploymentRootFor: () => null });
const PACK_ENV_KEYS = ["BUZZASSIST_CHANNEL_PACK", "BUZZASSIST_CHANNEL_PACK_ID"];
const NOW = "2026-09-18T00:00:00.000Z";
const REVIEWER = "山田花子";

function proposal(text) {
  const entry = {
    kind: "correction",
    target: PACK_TARGET,
    text,
    evidence: "喫茶店の場面で合成した根拠",
    session: "pack-first-test",
    capturedAt: NOW,
  };
  return { ...entry, id: proposalId(entry) };
}

// A は反映済み、B は promote、C は古い写しにだけ印がある、D は apply する。
const A = proposal("会議室の場面では照明を先に決める");
const B = proposal("喫茶店の場面では窓の向きを先に決める");
const C = proposal("古い写しにだけ書かれた規則を昇格させない");
const D = proposal("台帳の改訂は日付つきで残す");
const NOTE = {
  A: "照明は場面の最初に決めて、後から変えない。",
  B: "窓の向きは場面の最初に決めて、途中で変えない。",
  C: "この規則は古い写しにだけ残っている文言です。",
  D: "台帳の改訂は日付と理由を一緒に残すこと。",
};
const rule = (id, note) => `${promotionMarker(id)}\n${note}\n`;
const PACK_BODY = `# 要求台帳（本物）\n\n${rule(A.id, NOTE.A)}${rule(B.id, NOTE.B)}${rule(D.id, NOTE.D)}`;
const STALE_BODY = `# 要求台帳（pack へ移す前の古い写し）\n\n${rule(C.id, NOTE.C)}`;
const LEGACY_BODY = `# 要求台帳（従来配置）\n\n${rule(A.id, NOTE.A)}${rule(B.id, NOTE.B)}${rule(D.id, NOTE.D)}`;

function withPackEnv(values, fn) {
  const saved = Object.fromEntries(PACK_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PACK_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try {
    return fn();
  } finally {
    for (const key of PACK_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harness-learn-pack-first-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** 一時リポジトリ。pack の正本・古い写し・台帳を必要に応じて置く。 */
function buildRepo(root, { packBody = PACK_BODY, repoBody = STALE_BODY } = {}) {
  const repo = path.join(root, "repo");
  write(path.join(repo, "docs", "learning", "targets.json"), `${JSON.stringify({ targets: TARGETS }, null, 2)}\n`);
  const packRoot = path.join(repo, "channel-packs", PACK_ID);
  const packCopy = path.join(packRoot, CANONICAL_REL);
  const repoCopy = path.join(repo, CANONICAL_REL);
  if (packBody !== null) write(packCopy, packBody);
  if (repoBody !== null) write(repoCopy, repoBody);
  return {
    repo,
    packRoot,
    packCopy,
    repoCopy,
    proposalsLedger: path.join(packRoot, "docs", "learning", "proposals.jsonl"),
    appliedLedger: path.join(packRoot, "docs", "learning", "applied.jsonl"),
    sharedApplied: path.join(repo, "docs", "learning", "applied.jsonl"),
  };
}

function seedLedgers(layout, canonicalForA) {
  write(layout.proposalsLedger, `${[A, B, C, D].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  write(layout.appliedLedger, `${JSON.stringify({
    id: A.id,
    target: PACK_TARGET,
    targetPath: CANONICAL_REL,
    targetSha256: sha256(canonicalForA),
    text: A.text,
    reviewer: REVIEWER,
    attestedBy: HUMAN_VERIFIED,
    note: NOTE.A,
    evidenceVersion: 2,
    promotionMarker: promotionMarker(A.id),
    promotedAt: NOW,
  })}\n`);
}

/**
 * 本物の CLI を一時リポジトリの中で動かす。スクリプトだけを写し、相対 import は
 * 本物のモジュールへ転送する（symlink は Windows で作れないことがあるので使わない）。
 * REPO_ROOT はスクリプトの置き場所から決まるので、台帳も正本も一時ディレクトリを指す。
 */
function stageCli(repo) {
  const source = fs.readFileSync(LEARN_SCRIPT, "utf8");
  const staged = write(path.join(repo, "scripts", "harness-learn.mjs"), source);
  const specifiers = new Set([...source.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/gu)].map((match) => match[1]));
  assert.ok(specifiers.size > 0, "相対 import を見つけられない");
  for (const specifier of specifiers) {
    const real = path.resolve(path.dirname(LEARN_SCRIPT), specifier);
    assert.ok(fs.existsSync(real), `転送先が無い: ${specifier}`);
    write(path.resolve(path.dirname(staged), specifier), `export * from ${JSON.stringify(pathToFileURL(real).href)};\n`);
  }
  return staged;
}

function runLearn(repo, args, env = {}) {
  const childEnv = { ...process.env };
  for (const key of PACK_ENV_KEYS) delete childEnv[key];
  Object.assign(childEnv, env);
  const result = spawnSync(process.execPath, [path.join(repo, "scripts", "harness-learn.mjs"), ...args], {
    cwd: repo,
    env: childEnv,
    encoding: "utf8",
    input: "",
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

function snapshot(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = sha256(full);
    }
  };
  walk(dir);
  return out;
}

const packDisplay = path.join("channel-packs", PACK_ID, CANONICAL_REL);
// 出力の読み先は path.relative で作るので、区切りは OS ごとの区切り（Windows では \）。
// 宣言どおりの "docs/..." で探すと Windows の CI だけ落ちる。
const repoDisplay = path.normalize(CANONICAL_REL);
const repoCanonicalLine = `正本: ${repoDisplay}（リポジトリ）`;

// --- 解決器（in-process） ---

test("channel-pack 宛の正本は、リポジトリの古い写しより Channel Pack を先に読む", (t) => {
  const layout = buildRepo(tempRoot(t));
  assert.notEqual(sha256(layout.packCopy), sha256(layout.repoCopy), "前提: 2つの写しは別物");
  withPackEnv({}, () => {
    const resolved = resolveCanonicalTarget(PACK_TARGET, OPTIONS(layout.repo));
    assert.equal(resolved.full, layout.packCopy, "古い写しが pack より優先された");
    assert.equal(resolved.rel, CANONICAL_REL, "記録する相対パスは変えない");
    assert.equal(resolved.source, "channel-pack");
    assert.equal(resolved.missing, false);
    assert.equal(resolved.ignoredRepoCopy, layout.repoCopy, "読まなかった写しを知らせること");
    assert.equal(requireWritableTarget(PACK_TARGET, OPTIONS(layout.repo)).full, layout.packCopy);

    const lines = describeCanonicalResolution(resolved, { repoRoot: layout.repo }).join("\n");
    assert.ok(lines.includes(packDisplay), `読み先が出力に出ない:\n${lines}`);
    assert.match(lines, /Channel Pack/u);
    assert.match(lines, /リポジトリ側の同名ファイルは読みません/u);

    // status / curator の読み手も同じファイルを読む（書く側と読む側で別物を比べない）。
    const readers = createCanonicalReaders({ repoRoot: layout.repo, targets: TARGETS });
    const record = { target: PACK_TARGET, targetPath: CANONICAL_REL };
    assert.equal(readers.readCanonical(CANONICAL_REL, record), PACK_BODY);
    assert.equal(readers.hashCanonical(CANONICAL_REL, record), sha256(layout.packCopy));
    assert.equal(resolveRecordedCanonical(record, { repoRoot: layout.repo, targets: TARGETS }).full, layout.packCopy);
    // 相対パスだけで呼ぶ既存の呼び出し方は、従来どおりリポジトリ基準のまま。
    assert.equal(readers.readCanonical(CANONICAL_REL), STALE_BODY);
  });
});

test("BUZZASSIST_CHANNEL_PACK の pack も、リポジトリの古い写しより先に読む", (t) => {
  const root = tempRoot(t);
  const layout = buildRepo(root, { packBody: null });
  const envRoot = path.join(root, "env-pack-root");
  const envCopy = write(path.join(envRoot, CANONICAL_REL), PACK_BODY);
  withPackEnv({ BUZZASSIST_CHANNEL_PACK: envRoot }, () => {
    const resolved = resolveCanonicalTarget(PACK_TARGET, OPTIONS(layout.repo));
    assert.equal(resolved.full, envCopy);
    assert.equal(resolved.source, "channel-pack-env");
    assert.equal(resolved.ignoredRepoCopy, layout.repoCopy);
    const lines = describeCanonicalResolution(resolved, { repoRoot: layout.repo }).join("\n");
    assert.ok(lines.includes(path.join("env-pack-root", CANONICAL_REL)), lines);
    assert.match(lines, /BUZZASSIST_CHANNEL_PACK/u);
    const readers = createCanonicalReaders({ repoRoot: layout.repo, targets: TARGETS });
    assert.equal(readers.hashCanonical(CANONICAL_REL, { target: PACK_TARGET }), sha256(envCopy));
  });
});

test("Channel Pack に正本が無いときだけ、リポジトリ直下の正本を読む", (t) => {
  const root = tempRoot(t);
  withPackEnv({}, () => {
    // pack を置いていない（channel-packs/ 自体が無い）。
    const noPack = buildRepo(path.join(root, "no-pack"), { packBody: null, repoBody: LEGACY_BODY });
    assert.equal(fs.existsSync(path.join(noPack.repo, "channel-packs")), false);
    const resolved = resolveCanonicalTarget(PACK_TARGET, OPTIONS(noPack.repo));
    assert.equal(resolved.full, noPack.repoCopy);
    assert.equal(resolved.source, "repository");
    assert.equal(resolved.missing, false);
    assert.equal(resolved.packRootWithoutCanonical, null);
    const noPackLines = describeCanonicalResolution(resolved, { repoRoot: noPack.repo }).join("\n");
    assert.ok(noPackLines.includes(repoCanonicalLine), `リポジトリ側の読み先が出ない:\n${noPackLines}`);
    const readers = createCanonicalReaders({ repoRoot: noPack.repo, targets: TARGETS });
    assert.equal(readers.readCanonical(CANONICAL_REL, { target: PACK_TARGET }), LEGACY_BODY);

    // pack の置き場はあるが正本が無い（台帳だけがある）。従来配置の正本を使い、そう知らせる。
    const ledgerOnly = buildRepo(path.join(root, "ledger-only"), { packBody: null, repoBody: LEGACY_BODY });
    write(ledgerOnly.proposalsLedger, "");
    const fallback = resolveCanonicalTarget(PACK_TARGET, OPTIONS(ledgerOnly.repo));
    assert.equal(fallback.full, ledgerOnly.repoCopy);
    assert.equal(fallback.source, "repository");
    assert.equal(fallback.packRootWithoutCanonical, ledgerOnly.packRoot);
    assert.match(
      describeCanonicalResolution(fallback, { repoRoot: ledgerOnly.repo }).join("\n"),
      /に正本が無いので、リポジトリ側を使います/u,
    );

    // 合成 fixture は承認記録の材料にしない。
    const withFixture = buildRepo(path.join(root, "fixture"), { packBody: null, repoBody: LEGACY_BODY });
    write(path.join(withFixture.repo, "test", "fixtures", "channel-pack", CANONICAL_REL), "# 合成 fixture\n");
    assert.equal(resolveCanonicalTarget(PACK_TARGET, OPTIONS(withFixture.repo)).full, withFixture.repoCopy);
    fs.rmSync(withFixture.repoCopy);
    const fixtureOnly = resolveCanonicalTarget(PACK_TARGET, OPTIONS(withFixture.repo));
    assert.equal(fixtureOnly.missing, true, "fixture を正本として扱った");
    assert.throws(() => requireWritableTarget(PACK_TARGET, OPTIONS(withFixture.repo)), /正本がこの環境にありません/u);
  });
});

test("共有層宛の解決と出力は変えない（リポジトリを先に読む）", (t) => {
  const root = tempRoot(t);
  const layout = buildRepo(root);
  const repoSkill = write(path.join(layout.repo, SHARED_REL), "# リポジトリの正本\n");
  write(path.join(layout.packRoot, SHARED_REL), "# pack 側の同名ファイル\n");
  withPackEnv({}, () => {
    const resolved = resolveCanonicalTarget(SHARED_TARGET, OPTIONS(layout.repo));
    assert.equal(resolved.full, repoSkill);
    assert.equal(resolved.source, "repository");
    assert.deepEqual(describeCanonicalResolution(resolved, { repoRoot: layout.repo }), [], "共有層宛の出力が増えた");
    const readers = createCanonicalReaders({ repoRoot: layout.repo, targets: TARGETS });
    assert.equal(readers.readCanonical(SHARED_REL, { target: SHARED_TARGET }), "# リポジトリの正本\n");
  });
});

test("反映済みの判定は、pack の写しに対する記録を pack の写しで照合する", (t) => {
  const layout = buildRepo(tempRoot(t));
  withPackEnv({}, () => {
    const readers = createCanonicalReaders({ repoRoot: layout.repo, targets: TARGETS });
    const record = {
      id: A.id, target: PACK_TARGET, targetPath: CANONICAL_REL, targetSha256: sha256(layout.packCopy),
      reviewer: REVIEWER, attestedBy: HUMAN_VERIFIED, note: NOTE.A,
    };
    const summary = summarizeProposals([A, B], [record], readers.readCanonical, readers.hashCanonical);
    assert.equal(summary.find((entry) => entry.id === A.id).applied, true, "pack の写しにある反映が未反映に戻った");
    assert.equal(summary.find((entry) => entry.id === B.id).applied, false);
    // 古い写しの sha256 を持つ記録は、現在の正本（pack）を保証しない。
    const staleRecord = { ...record, targetSha256: sha256(layout.repoCopy) };
    const staleSummary = summarizeProposals([A], [staleRecord], readers.readCanonical, readers.hashCanonical);
    assert.equal(staleSummary[0].applied, false);
  });
});

// --- CLI（一時リポジトリで本物の main を動かす） ---

test("CLI: status / review / promote / apply は、古い写しがあっても Channel Pack の写しを照合する", (t) => {
  const layout = buildRepo(tempRoot(t));
  seedLedgers(layout, layout.packCopy);
  stageCli(layout.repo);

  const status = runLearn(layout.repo, ["status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.ok(!status.stdout.includes(A.id), `pack の写しで反映済みの A が未反映に出た:\n${status.stdout}`);
  for (const entry of [B, C, D]) assert.ok(status.stdout.includes(entry.id), `${entry.id} が出ない`);
  assert.ok(status.stdout.includes(packDisplay), `status に読み先が出ない:\n${status.stdout}`);
  assert.match(status.stdout, /リポジトリ側の同名ファイルは読みません/u);

  const before = snapshot(layout.repo);
  const review = runLearn(layout.repo, ["review"]);
  assert.equal(review.status, 0, review.stderr);
  assert.match(review.stdout, /dry-run/u);
  assert.ok(review.stdout.includes(packDisplay), `review に読み先が出ない:\n${review.stdout}`);
  assert.ok(!review.stdout.includes(A.id));
  assert.deepEqual(snapshot(layout.repo), before, "review が何かを書き換えた");

  // 古い写しにだけ印がある提案は、昇格できない（古い写しを読んでいない証拠）。
  const rejected = runLearn(layout.repo, [
    "promote", "--id", C.id, "--reviewer", REVIEWER, "--note", NOTE.C, "--agent-attested",
  ]);
  assert.notEqual(rejected.status, 0, "古い写しの印で promote が通った");
  assert.match(rejected.stderr, /該当の記述が見つかりません/u);
  assert.ok(rejected.stderr.includes(packDisplay), `失敗文に読んだファイルが出ない:\n${rejected.stderr}`);
  assert.equal(readJsonl(layout.appliedLedger).length, 1);

  const promoted = runLearn(layout.repo, [
    "promote", "--id", B.id, "--reviewer", REVIEWER, "--note", NOTE.B, "--agent-attested",
  ]);
  assert.equal(promoted.status, 0, promoted.stderr);
  assert.ok(promoted.stdout.includes(packDisplay), `promote に読み先が出ない:\n${promoted.stdout}`);
  const promotedRow = readJsonl(layout.appliedLedger).at(-1);
  assert.equal(promotedRow.id, B.id);
  assert.equal(promotedRow.targetPath, CANONICAL_REL);
  assert.equal(promotedRow.targetSha256, sha256(layout.packCopy), "pack の写し以外の sha256 を記録した");
  assert.equal(promotedRow.targetSource, "channel-pack");
  assert.equal(promotedRow.attestedBy, "agent-self-attested");

  const applied = runLearn(layout.repo, [
    "apply", "--id", D.id, "--reviewer", REVIEWER, "--note", NOTE.D, "--agent-attested",
  ]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.ok(applied.stdout.includes(packDisplay), `apply に読み先が出ない:\n${applied.stdout}`);
  const appliedRow = readJsonl(layout.appliedLedger).at(-1);
  assert.equal(appliedRow.id, D.id);
  assert.equal(appliedRow.targetPath, CANONICAL_REL);
  assert.equal(appliedRow.targetSha256, sha256(layout.packCopy));
  assert.equal(appliedRow.targetSource, "channel-pack");
  assert.ok(appliedRow.appliedAt);

  assert.equal(fs.existsSync(layout.sharedApplied), false, "channel-pack 宛の記録が共有台帳へ書かれた");
  assert.equal(fs.readFileSync(layout.repoCopy, "utf8"), STALE_BODY, "古い写しが書き換えられた");
  assert.equal(fs.readFileSync(layout.packCopy, "utf8"), PACK_BODY, "正本が書き換えられた");
});

test("CLI: BUZZASSIST_CHANNEL_PACK の写しで status と promote を照合する", (t) => {
  const root = tempRoot(t);
  const layout = buildRepo(root, { packBody: null });
  const envRoot = path.join(root, "env-pack-root");
  const envCopy = write(path.join(envRoot, CANONICAL_REL), PACK_BODY);
  seedLedgers(layout, envCopy);
  stageCli(layout.repo);
  const env = { BUZZASSIST_CHANNEL_PACK: envRoot };

  const status = runLearn(layout.repo, ["status"], env);
  assert.equal(status.status, 0, status.stderr);
  assert.ok(!status.stdout.includes(A.id), status.stdout);
  assert.ok(status.stdout.includes(path.join("env-pack-root", CANONICAL_REL)), status.stdout);
  assert.match(status.stdout, /BUZZASSIST_CHANNEL_PACK/u);

  const promoted = runLearn(layout.repo, [
    "promote", "--id", B.id, "--reviewer", REVIEWER, "--note", NOTE.B, "--agent-attested",
  ], env);
  assert.equal(promoted.status, 0, promoted.stderr);
  const row = readJsonl(layout.appliedLedger).at(-1);
  assert.equal(row.targetSha256, sha256(envCopy));
  assert.equal(row.targetSource, "channel-pack-env");
});

test("CLI: Channel Pack に正本が無ければ、従来どおりリポジトリ直下の正本で動く", (t) => {
  const layout = buildRepo(tempRoot(t), { packBody: null, repoBody: LEGACY_BODY });
  seedLedgers(layout, layout.repoCopy);
  stageCli(layout.repo);

  const status = runLearn(layout.repo, ["status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.ok(!status.stdout.includes(A.id), `従来配置の反映済みが未反映に出た:\n${status.stdout}`);
  assert.ok(status.stdout.includes(repoCanonicalLine), `status にリポジトリ側の読み先が出ない:\n${status.stdout}`);
  assert.match(status.stdout, /リポジトリ側を使います/u);

  const before = snapshot(layout.repo);
  const review = runLearn(layout.repo, ["review"]);
  assert.equal(review.status, 0, review.stderr);
  assert.match(review.stdout, /dry-run/u);
  assert.deepEqual(snapshot(layout.repo), before, "review が何かを書き換えた");

  const promoted = runLearn(layout.repo, [
    "promote", "--id", B.id, "--reviewer", REVIEWER, "--note", NOTE.B, "--agent-attested",
  ]);
  assert.equal(promoted.status, 0, promoted.stderr);
  const promotedRow = readJsonl(layout.appliedLedger).at(-1);
  assert.equal(promotedRow.targetSha256, sha256(layout.repoCopy));
  assert.equal(promotedRow.targetSource, "repository");

  const applied = runLearn(layout.repo, [
    "apply", "--id", D.id, "--reviewer", REVIEWER, "--note", NOTE.D, "--agent-attested",
  ]);
  assert.equal(applied.status, 0, applied.stderr);
  const appliedRow = readJsonl(layout.appliedLedger).at(-1);
  assert.equal(appliedRow.id, D.id);
  assert.equal(appliedRow.targetSha256, sha256(layout.repoCopy));
  assert.equal(appliedRow.targetSource, "repository");
});
