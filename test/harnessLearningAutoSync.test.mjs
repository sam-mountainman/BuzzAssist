// 自動 sync（Job の決着時と setup のたび）の試験。
//
// Job の決着は、本物の harness-learn と harnessReceiptLearning を一時の開発用チェックアウトへ写して
// （相対 import は本物のモジュールへ転送）、本番と同じ呼び方（捕捉の経路を差し替えない）で流す。
// setup は、合成の HOME に配布された写しを作って setup と同じ引数で呼ぶ。学習の置き場は一時ディレクトリ、
// 本物のリポジトリの台帳・overlay と ~/.buzzassist には書かない。人名・提案・Job はすべて合成。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { LOCAL_OVERLAY_BEGIN, resolveLearningState, sameIgnoringOverlayTimestamp, sharedLedgerPath } from "../lib/harnessLearningState.mjs";
import { childAgentEnvironment } from "../lib/harnessLearningGuard.mjs";
import { buildSensitiveVocabularyDigest, SENSITIVE_VOCABULARY_KEY_ENV } from "../lib/packageTarballAudit.mjs";
import { captureSettledJobLearning } from "../lib/harnessReceiptLearning.mjs";
import { AUTO_SYNC_ENV, autoSyncLearningOverlays, proposalId } from "../scripts/harness-learn.mjs";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = "sample-craft";
const TARGET = `platform:${SKILL}`;
const TEST_VOCABULARY_KEY = "5d".repeat(32);
const TARGETS = {
  [TARGET]: {
    mode: "auto-guidance",
    canonical: `.agents/skills/${SKILL}/SKILL.md`,
    overlay: `.agents/skills/${SKILL}/references/learned-auto.md`,
    scope: "platform",
  },
  "channel-pack:narrated-story": {
    mode: "review-only",
    canonical: "docs/requirements-ledger.md",
    reason: "合成の台帳",
    scope: "channel-pack",
    packId: "narrated-story",
  },
};

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "learning-auto-sync-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function stageScript(root, relative) {
  const real = path.join(SOURCE_ROOT, ...relative.split("/"));
  const source = fs.readFileSync(real, "utf8");
  const staged = write(path.join(root, ...relative.split("/")), source);
  for (const [, specifier] of source.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/gu)) {
    const target = path.resolve(path.dirname(staged), specifier);
    if (fs.existsSync(target)) continue;
    write(target, `export * from ${JSON.stringify(pathToFileURL(path.resolve(path.dirname(real), specifier)).href)};\n`);
  }
  return staged;
}

function syntheticProposal(text, session = "synthetic-session") {
  const entry = { kind: "preference", target: TARGET, text, evidence: "合成の根拠", session, capturedAt: "2026-09-24T00:00:00.000Z" };
  return { ...entry, id: proposalId(entry) };
}

function writeVocabulary(root) {
  write(
    path.join(root, "docs", "learning", "sensitive-vocabulary.digest.json"),
    JSON.stringify(buildSensitiveVocabularyDigest(["fictional-client-zz"], { key: TEST_VOCABULARY_KEY, generatedAt: "2026-09-25T00:00:00Z" })),
  );
}

async function withVocabularyKey(action) {
  const saved = process.env[SENSITIVE_VOCABULARY_KEY_ENV];
  process.env[SENSITIVE_VOCABULARY_KEY_ENV] = TEST_VOCABULARY_KEY;
  try {
    return await action();
  } finally {
    if (saved === undefined) delete process.env[SENSITIVE_VOCABULARY_KEY_ENV];
    else process.env[SENSITIVE_VOCABULARY_KEY_ENV] = saved;
  }
}

/** 一時の開発用チェックアウトに、本物の harness-learn と Receipt からの捕捉を写す。 */
async function stageDevelopmentCheckout(root, { vocabulary }) {
  const repo = path.join(root, "repo");
  stageScript(repo, "scripts/harness-learn.mjs");
  const receiptModule = stageScript(repo, "lib/harnessReceiptLearning.mjs");
  write(path.join(repo, "docs", "learning", "targets.json"), `${JSON.stringify({ targets: TARGETS }, null, 2)}\n`);
  write(path.join(repo, ".agents", "skills", SKILL, "SKILL.md"), "# 合成スキル\n");
  for (const marker of [".git", path.join(".claude", "skills"), path.join(".codex", "skills")]) fs.mkdirSync(path.join(repo, marker), { recursive: true });
  if (vocabulary) writeVocabulary(repo);
  const proposal = syntheticProposal("合成の手順では置き場を先に確かめる");
  write(path.join(repo, "docs", "learning", "proposals.jsonl"), `${JSON.stringify(proposal)}\n`);
  const module = await import(pathToFileURL(receiptModule).href);
  return { repo, module, proposal, overlay: path.join(repo, ".agents", "skills", SKILL, "references", "learned-auto.md") };
}

function failedJob(id = "video-synthetic-0001") {
  return {
    id,
    status: "failed",
    revision: 3,
    updatedAt: "2026-09-25T00:00:00.000Z",
    harness: { id: "narrated-story-video", declarationVersion: "1.0.0" },
    stages: [{ id: "render", status: "failed" }],
    knownRemainingIssues: [],
    blockers: ["render-timeout: 合成の失敗"],
  };
}

test("Job の決着で、捕捉のあとに自動 sync が走り、overlay に提案が載る。2回目は最終更新の行だけで書き直さない", async (t) => {
  const root = tempRoot(t);
  const fx = await stageDevelopmentCheckout(root, { vocabulary: true });
  const env = { BUZZASSIST_LEARNING_DIR: path.join(root, "learning") };
  const first = await withVocabularyKey(() => fx.module.captureSettledJobLearning({ job: failedJob(), env, now: () => "2026-09-25T01:00:00.000Z" }));
  assert.ok(first.captured >= 1, `Receipt からの捕捉が無い: ${JSON.stringify(first)}`);
  assert.equal(first.target, "channel-pack:narrated-story");
  assert.equal(first.autoSync.status, "synced", JSON.stringify(first.autoSync));
  assert.equal(first.autoSync.trigger, "job-settled");
  assert.equal(first.autoSync.written, 1);
  const overlay = fs.readFileSync(fx.overlay, "utf8");
  assert.match(overlay, /合成の手順では置き場を先に確かめる/u);
  assert.match(overlay, new RegExp(`id: \`${fx.proposal.id}\``, "u"));
  // 自動で捕捉したのはチャンネルの非公開台帳（review-only）で、overlay には載らず保留として数える。
  assert.equal(first.autoSync.held, 1);
  assert.ok(readJsonl(path.join(fx.repo, "channel-packs", "narrated-story", "docs", "learning", "proposals.jsonl")).length >= 1);
  const log = readJsonl(path.join(root, "learning", "auto-sync.jsonl"));
  assert.deepEqual(log.map((row) => [row.trigger, row.status, row.mode]), [["job-settled", "synced", "development"]]);

  const second = await withVocabularyKey(() => fx.module.captureSettledJobLearning({ job: failedJob("video-synthetic-0002"), env, now: () => "2026-09-25T02:00:00.000Z" }));
  assert.equal(second.autoSync.status, "synced");
  assert.equal(second.autoSync.written, 0, "項目が同じなのに最終更新の行だけで書き直した");
  assert.equal(fs.readFileSync(fx.overlay, "utf8"), overlay);
  assert.equal(sameIgnoringOverlayTimestamp("a\n_最終更新: 2026-09-25T01:00:00Z_\n", "a\n_最終更新: 2026-09-26T01:00:00Z_\n"), true);
  assert.equal(sameIgnoringOverlayTimestamp("a\n", "b\n"), false);
});

test("語彙を照合できない端末では overlay を書かず、理由だけを残し、Job の捕捉と結果は止めない", async (t) => {
  const root = tempRoot(t);
  const fx = await stageDevelopmentCheckout(root, { vocabulary: false });
  const env = { BUZZASSIST_LEARNING_DIR: path.join(root, "learning") };
  const result = await fx.module.captureSettledJobLearning({ job: failedJob(), env, now: () => "2026-09-25T01:00:00.000Z" });
  assert.ok(result.captured >= 1, "語彙が無いだけで Receipt からの捕捉まで止めた");
  assert.deepEqual(result.autoSync, { status: "skipped", reason: "vocabulary-missing-file", trigger: "job-settled" });
  assert.equal(fs.existsSync(fx.overlay), false, "語彙照合なしで overlay を書いた");
  const log = readJsonl(path.join(root, "learning", "auto-sync.jsonl"));
  assert.equal(log.length, 1);
  assert.equal(log[0].reason, "vocabulary-missing-file");
  assert.equal(JSON.stringify(log[0]).includes(root), false, "記録に端末のパスを残した");

  // 止める環境変数と子エージェントでは、自動 sync を走らせない（記録も増やさない）。
  const disabled = await fx.module.captureSettledJobLearning({ job: failedJob("video-synthetic-0003"), env: { ...env, [AUTO_SYNC_ENV]: "0" } });
  assert.deepEqual(disabled.autoSync, { status: "skipped", reason: "disabled", trigger: "job-settled" });
  const child = await fx.module.captureSettledJobLearning({ job: failedJob("video-synthetic-0004"), env: childAgentEnvironment(env) });
  assert.equal(child.skippedReason, "child-agent");
  assert.equal(child.autoSync, undefined);
  assert.equal(readJsonl(path.join(root, "learning", "auto-sync.jsonl")).length, 1);
});

test("捕捉の経路を差し替えた呼び出しでは既定の自動 sync を走らせず、明示の sync は失敗しても結果を返す", async (t) => {
  const root = tempRoot(t);
  const indexPath = path.join(root, "index.jsonl");
  const noCapture = () => ({ appended: false });
  const plain = await captureSettledJobLearning({ job: failedJob(), env: {}, capture: noCapture, receiptIndexPath: indexPath });
  assert.equal("autoSync" in plain, false, "試験の差し替えで本物のリポジトリの overlay を sync しようとした");
  const calls = [];
  const synced = await captureSettledJobLearning({
    job: failedJob("video-synthetic-0005"), env: {}, capture: noCapture, receiptIndexPath: indexPath,
    syncOverlays: (input) => { calls.push(input.trigger); return { status: "synced", trigger: input.trigger }; },
  });
  assert.deepEqual(calls, ["job-settled"]);
  assert.equal(synced.autoSync.status, "synced");
  const broken = await captureSettledJobLearning({
    job: failedJob("video-synthetic-0006"), env: {}, capture: noCapture, receiptIndexPath: indexPath,
    syncOverlays: () => { throw new Error("合成の失敗"); },
  });
  assert.deepEqual(broken.autoSync, { status: "failed", reason: "sync-error", trigger: "job-settled" });
  assert.equal(broken.receiptIndex.appended, true, "自動 sync の失敗で決着の記録まで止めた");
});

/** 合成の HOME に、配布された写し（~/plugins/buzzassist/plugin）と Claude Code の版別キャッシュを作る。 */
function stageOperatorHome(root) {
  const home = path.join(root, "home");
  const copy = (dir) => {
    write(path.join(dir, "docs", "learning", "targets.json"), `${JSON.stringify({ targets: TARGETS }, null, 2)}\n`);
    write(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "buzzassist", version: "9.9.1" }));
    for (const base of [path.join(dir, "skills", SKILL), path.join(dir, ".agents", "skills", SKILL)]) {
      write(path.join(base, "SKILL.md"), "# 合成スキル\n");
      write(path.join(base, "references", "learned-auto.md"), "# 自動で積み上がった指摘\n\n_まだ自動反映された項目はありません。_\n");
    }
    return dir;
  };
  const managed = copy(path.join(home, "plugins", "buzzassist", "plugin"));
  const claude = copy(path.join(home, ".claude", "plugins", "cache", "buzzassist", "buzzassist", "9.9.1"));
  write(path.join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({
    version: 2,
    plugins: { "buzzassist@buzzassist": [{ scope: "user", installPath: claude, version: "9.9.1" }] },
  }));
  const state = resolveLearningState({ codeRoot: managed, homeDir: home, env: {}, developmentCheckout: false });
  write(sharedLedgerPath(state, "proposals"), `${JSON.stringify(syntheticProposal("この端末で捕捉した合成の指摘"))}\n`);
  return { home, managed, claude, state };
}

test("setup と同じ呼び方（台帳は状態の置き場、語彙は setup のソース）で、区画を作り直してホストが読む写しへ届ける", async (t) => {
  const root = tempRoot(t);
  const { home, managed, claude, state } = stageOperatorHome(root);
  const source = path.join(root, "setup-source");
  const setupCall = (vocabularyRoot) => autoSyncLearningOverlays({
    trigger: "setup", state, repoRoot: managed, vocabularyRoot, homeDir: home, env: {}, now: () => "2026-09-25T03:00:00.000Z",
  });

  // 語彙の無いソース（リリースの写しなど）: 書かずに理由だけを状態の置き場に残す。
  fs.mkdirSync(source, { recursive: true });
  assert.deepEqual(setupCall(source), { status: "skipped", reason: "vocabulary-missing-file", trigger: "setup" });
  assert.equal(fs.existsSync(path.join(state.overlaysDir, SKILL, "learned-auto.md")), false);
  assert.equal(readJsonl(state.autoSyncLogPath)[0].mode, "installed");

  writeVocabulary(source);
  const result = await withVocabularyKey(() => setupCall(source));
  assert.equal(result.status, "synced", JSON.stringify(result));
  const block = fs.readFileSync(path.join(state.overlaysDir, SKILL, "learned-auto.md"), "utf8");
  assert.ok(block.startsWith(LOCAL_OVERLAY_BEGIN));
  assert.match(block, /この端末で捕捉した合成の指摘/u);
  for (const copy of [managed, claude]) {
    for (const base of ["skills", ".agents/skills"]) {
      const text = fs.readFileSync(path.join(copy, ...base.split("/"), SKILL, "references", "learned-auto.md"), "utf8");
      assert.equal(text.split(LOCAL_OVERLAY_BEGIN).length - 1, 1, `区画が届いていない: ${copy} ${base}`);
    }
  }
  assert.deepEqual(readJsonl(state.autoSyncLogPath).map((row) => [row.trigger, row.status]), [["setup", "skipped"], ["setup", "synced"]]);
});

test("setup は自動 sync を置き換えた写しと setup のソースの語彙で呼び、dry-run では走らせない", () => {
  const source = fs.readFileSync(path.join(SOURCE_ROOT, "scripts", "setup-agents.mjs"), "utf8");
  assert.match(source, /autoSyncLearningOverlays\(\{\s*trigger: "setup",\s*state,\s*repoRoot: managedPluginRoot,\s*vocabularyRoot: repoRoot,/u);
  assert.match(source, /BUZZASSIST_LEARNING_AUTO_SYNC=skipped \(dry-run\)/u);
  // 自動 sync を先に、そのあと従来どおり区画を届け直す（sync が止まっても届け直しは走る）。
  assert.ok(source.indexOf("await autoSyncOperatorLearning();") < source.indexOf("    deliverOperatorLearningOverlays();"));
  assert.match(source, /"changes\.jsonl"/u, "差分の承認キューを配布物から外す安全網が無い");
});

test("Windows のパス区切りでも、自動 sync の記録は学習の置き場に置く", () => {
  const win = path.win32;
  const home = win.join("C:", "Users", "sample-operator");
  const installed = resolveLearningState({ codeRoot: win.join(home, "plugins", "buzzassist", "plugin"), homeDir: home, env: {}, pathApi: win, developmentCheckout: false });
  assert.equal(installed.autoSyncLogPath, win.join(home, ".buzzassist", "learning", "auto-sync.jsonl"));
  const override = win.join("D:", "operator-data", "learning");
  const development = resolveLearningState({ codeRoot: win.join("C:", "work", "buzzassist"), homeDir: home, env: { BUZZASSIST_LEARNING_DIR: override }, pathApi: win, developmentCheckout: true });
  assert.equal(development.autoSyncLogPath, win.join(win.resolve(override), "auto-sync.jsonl"), "開発用チェックアウトでも記録はリポジトリの外");
});
