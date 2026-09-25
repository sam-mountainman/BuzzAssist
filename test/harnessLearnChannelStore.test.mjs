// チャンネルの学習の保存先（要求台帳・提案・反映記録）を、制作プログラムの配備 root とは別の設定で
// 解決する試験。以前は配備 root が "." のとき共有台帳と同じ場所に解決され、隔離の検査で捕捉そのものが
// 止まっていた。一時ディレクトリだけを使い、宛先・pack・私有プロジェクト・人名はすべて合成。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CHANNEL_LEARNING_STORE_ERROR, promotionMarker, resolveChannelLearningStore } from "../scripts/harness-learn.mjs";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEARN_SCRIPT = path.join(SOURCE_ROOT, "scripts", "harness-learn.mjs");
const PACK_ID = "sample-story";
const TARGET = `channel-pack:${PACK_ID}`;
const CANONICAL_REL = "docs/requirements-ledger.md";
const TARGETS = {
  [TARGET]: {
    mode: "review-only",
    canonical: CANONICAL_REL,
    reason: "テスト用の合成台帳",
    scope: "channel-pack",
    packId: PACK_ID,
    confidential: true,
  },
  "platform:sample-craft": {
    mode: "auto-guidance",
    canonical: ".agents/skills/sample-craft/SKILL.md",
    overlay: ".agents/skills/sample-craft/references/learned-auto.md",
    scope: "platform",
  },
};
const PACK_ENV_KEYS = ["BUZZASSIST_CHANNEL_PACK", "BUZZASSIST_CHANNEL_PACK_ID"];
const REVIEWER = "山田花子";

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harness-learn-channel-store-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** 本物の CLI を一時リポジトリで動かす（harnessLearnPackFirst.test.mjs と同じ写し方）。 */
function stageRepo(root, { channelLearning } = {}) {
  const repo = path.join(root, "repo");
  write(path.join(repo, "docs", "learning", "targets.json"), `${JSON.stringify({ targets: TARGETS }, null, 2)}\n`);
  write(path.join(repo, "config", "harness-deployments.json"), `${JSON.stringify({
    deployments: [{ harnessId: "sample-harness", root: ".", entrypoint: "node scripts/sample-entry.mjs" }],
    ...(channelLearning ? { channelLearning } : {}),
  }, null, 2)}\n`);
  // 公開リポジトリ側に置かれた同名の写し。チャンネルの台帳として読んではいけない。
  write(path.join(repo, CANONICAL_REL), "# 公開側の古い写し\n");
  const source = fs.readFileSync(LEARN_SCRIPT, "utf8");
  const staged = write(path.join(repo, "scripts", "harness-learn.mjs"), source);
  const specifiers = new Set([...source.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/gu)].map((match) => match[1]));
  for (const specifier of specifiers) {
    const real = path.resolve(path.dirname(LEARN_SCRIPT), specifier);
    write(path.resolve(path.dirname(staged), specifier), `export * from ${JSON.stringify(pathToFileURL(real).href)};\n`);
  }
  return repo;
}

function runLearn(repo, args) {
  const env = { ...process.env };
  for (const key of PACK_ENV_KEYS) delete env[key];
  const result = spawnSync(process.execPath, [path.join(repo, "scripts", "harness-learn.mjs"), ...args], {
    cwd: repo, env, encoding: "utf8", input: "", timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function capture(repo, text, session) {
  return runLearn(repo, [
    "capture", "--kind", "correction", "--target", TARGET, "--text", text,
    "--evidence", "合成の根拠（喫茶店の場面）", "--session", session,
  ]);
}

function capturedId(result) {
  const match = /記録しました: ([a-f0-9]{12})/u.exec(result.stdout);
  assert.ok(match, `capture の出力に id が無い:\n${result.stdout}\n${result.stderr}`);
  return match[1];
}

function assertCaptureToPromoteToApply(repo, storeRoot, { expectedSource }) {
  const sharedProposals = path.join(repo, "docs", "learning", "proposals.jsonl");
  const sharedApplied = path.join(repo, "docs", "learning", "applied.jsonl");
  const channelProposals = path.join(storeRoot, "docs", "learning", "proposals.jsonl");
  const channelApplied = path.join(storeRoot, "docs", "learning", "applied.jsonl");
  const canonical = path.join(storeRoot, CANONICAL_REL);

  const first = capture(repo, "喫茶店の場面では窓の向きを先に決める", "channel-store-1");
  assert.equal(first.status, 0, first.stderr);
  const second = capture(repo, "会議室の場面では照明を先に決める", "channel-store-2");
  assert.equal(second.status, 0, second.stderr);
  const promoteId = capturedId(first);
  const applyId = capturedId(second);
  assert.deepEqual(readJsonl(channelProposals).map((row) => row.id).sort(), [promoteId, applyId].sort(), "チャンネルの提案台帳に書く");
  assert.deepEqual(readJsonl(sharedProposals), [], "共有台帳へは書かない");

  const promoteNote = "窓の向きは場面の最初に決めて、途中で変えない。";
  const applyNote = "照明は場面の最初に決めて、後から変えない。";
  write(canonical, `# 要求台帳（合成）\n\n${promotionMarker(promoteId)}\n${promoteNote}\n\n${promotionMarker(applyId)}\n${applyNote}\n`);
  const promoted = runLearn(repo, ["promote", "--id", promoteId, "--reviewer", REVIEWER, "--note", promoteNote, "--agent-attested"]);
  assert.equal(promoted.status, 0, promoted.stderr);
  const applied = runLearn(repo, ["apply", "--id", applyId, "--reviewer", REVIEWER, "--note", applyNote, "--agent-attested"]);
  assert.equal(applied.status, 0, applied.stderr);

  const rows = readJsonl(channelApplied);
  assert.deepEqual(rows.map((row) => row.id), [promoteId, applyId]);
  for (const row of rows) {
    assert.equal(row.targetSource, expectedSource);
    assert.equal(row.targetSha256, sha256(canonical), "チャンネルの正本の SHA を記録する（公開側の写しではない）");
  }
  assert.equal(fs.existsSync(sharedApplied), false, "反映の記録も共有台帳へは書かない");
  assert.equal(fs.readFileSync(path.join(repo, CANONICAL_REL), "utf8"), "# 公開側の古い写し\n", "公開側の写しを書き換えない");
  // status はチャンネルの台帳を読み、正本の読み先としてチャンネルの保存先を示す
  // （機械の自己申告の反映は「人の確認済み」ではないので、未反映の一覧には残る）。
  const status = runLearn(repo, ["status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.ok(status.stdout.includes(promoteId), `チャンネルの提案台帳を読んでいない:\n${status.stdout}`);
  const relativeCanonical = path.relative(repo, canonical);
  const shown = relativeCanonical.startsWith("..") ? canonical : relativeCanonical;
  assert.ok(status.stdout.includes(`正本: ${shown}`), `正本の読み先が出ない:\n${status.stdout}`);
  return rows;
}

test("私有プロジェクト（リポジトリの外）を宣言すれば、捕捉 → promote → apply をそこで行い、記録に端末の絶対 path を残さない", (t) => {
  const root = tempRoot(t);
  const privateProject = path.join(root, "operator-private", "sample-project");
  const repo = stageRepo(root, { channelLearning: [{ target: TARGET, root: privateProject }] });
  const rows = assertCaptureToPromoteToApply(repo, privateProject, { expectedSource: "operator-project" });
  for (const row of rows) {
    assert.equal(row.targetPath, CANONICAL_REL, "保存先の中の相対 path だけを残す");
    assert.equal(JSON.stringify(row).includes(root), false);
  }
});

test("私有プロジェクトがリポジトリの中の追跡外の場所でも同じ（配備 root は '.' のまま、別の設定で決まる）", (t) => {
  const root = tempRoot(t);
  const repo = stageRepo(root, { channelLearning: [{ target: TARGET, root: "client-area/sample-project" }] });
  assertCaptureToPromoteToApply(repo, path.join(repo, "client-area", "sample-project"), { expectedSource: "operator-project" });
});

test("宣言が無ければ Channel Pack に置く（配備 root の '.' を学習の保存先にしない）", (t) => {
  const root = tempRoot(t);
  const repo = stageRepo(root);
  assertCaptureToPromoteToApply(repo, path.join(repo, "channel-packs", PACK_ID), { expectedSource: "channel-pack" });
});

test("保存先が共有台帳・リポジトリの作業木の直下に重なる宣言は、捕捉の前に理由つきで止める（fail-closed）", (t) => {
  const root = tempRoot(t);
  for (const declared of [".", "docs/..", null]) {
    const repo = stageRepo(path.join(root, `case-${declared === null ? "absolute" : declared.replaceAll(/[./]/gu, "_")}`), {
      channelLearning: [{ target: TARGET, root: declared === null ? "__REPO__" : declared }],
    });
    if (declared === null) {
      const mapPath = path.join(repo, "config", "harness-deployments.json");
      fs.writeFileSync(mapPath, fs.readFileSync(mapPath, "utf8").replace("__REPO__", repo.replaceAll("\\", "\\\\")));
    }
    const result = capture(repo, "喫茶店の場面では窓の向きを先に決める", "channel-store-refused");
    assert.notEqual(result.status, 0, `共有台帳と重なる保存先で捕捉が通った（${declared}）`);
    assert.match(result.stderr, new RegExp(CHANNEL_LEARNING_STORE_ERROR, "u"));
    assert.match(result.stderr, /共有台帳|作業木の直下/u);
    assert.deepEqual(readJsonl(path.join(repo, "docs", "learning", "proposals.jsonl")), [], "何も書かない");
    const promote = runLearn(repo, ["promote", "--id", "0123456789ab", "--reviewer", REVIEWER, "--note", "理由つきで止まることを確かめる文", "--agent-attested"]);
    assert.notEqual(promote.status, 0);
  }
});

test("解決器: 宣言の重複・未完成の root は止める。宣言の無い宛先は Channel Pack（null）", (t) => {
  const root = tempRoot(t);
  const repo = path.join(root, "repo");
  const writeMap = (channelLearning) => write(path.join(repo, "config", "harness-deployments.json"), JSON.stringify({ deployments: [], channelLearning }));
  writeMap([{ target: TARGET, root: "a" }, { target: TARGET, root: "b" }]);
  assert.throws(() => resolveChannelLearningStore(TARGET, TARGETS[TARGET], { repoRoot: repo }), (error) => error.code === CHANNEL_LEARNING_STORE_ERROR && /2回/u.test(error.message));
  writeMap([{ target: TARGET, root: "<private project>" }]);
  assert.throws(() => resolveChannelLearningStore(TARGET, TARGETS[TARGET], { repoRoot: repo }), /未完成/u);
  writeMap([{ target: "channel-pack:other", root: "elsewhere" }]);
  assert.equal(resolveChannelLearningStore(TARGET, TARGETS[TARGET], { repoRoot: repo }), null);
  writeMap([{ target: TARGET, root: "private/sample" }]);
  assert.deepEqual(resolveChannelLearningStore(TARGET, TARGETS[TARGET], { repoRoot: repo }), { root: path.join(repo, "private", "sample"), source: "operator-project" });
  assert.equal(resolveChannelLearningStore("platform:sample-craft", TARGETS["platform:sample-craft"], { repoRoot: repo }), null, "共有層宛は対象外");
  // 配置先相対の従来の宛先: 配備 root がリポジトリそのものなら学習の保存先にしない。
  const legacy = { ...TARGETS[TARGET], relativeToDeployment: "sample-harness" };
  writeMap([]);
  assert.equal(resolveChannelLearningStore(TARGET, legacy, { repoRoot: repo, deploymentRootFor: () => "." }), null);
  const outside = path.join(root, "separate-deployment");
  assert.deepEqual(resolveChannelLearningStore(TARGET, legacy, { repoRoot: repo, deploymentRootFor: () => outside }), { root: outside, source: "deployment" });
});

test("本物の宛先: narrated-story のチャンネル宛は配備 root に依らず、共有台帳と別の場所に解決する", async () => {
  const { ledgerPathFor, loadTargets } = await import("../scripts/harness-learn.mjs");
  const definition = loadTargets()["channel-pack:narrated-story"];
  assert.equal(definition.relativeToDeployment, undefined, "配備 root を学習の保存先に使わない");
  assert.equal(definition.packId, "narrated-story");
  const shared = ledgerPathFor("platform:platform-craft");
  const channel = ledgerPathFor("channel-pack:narrated-story");
  assert.notEqual(path.dirname(channel), path.dirname(shared));
  assert.notEqual(channel, ledgerPathFor("channel-pack:koya"));
});
