// チャンネル単位の学習の保存先（harness-learn の --channel、差分の承認キュー、Job の確定時の自動の捕捉）の試験。
//
// 同じハーネスのチャンネルが2つあると、以前は宛先（channel-pack:<id>）がハーネス単位で同じになり、片方の捕捉が
// もう片方の status / pending に出ていた。ここでは、チャンネルで作った学習がそのチャンネルの保存先にだけ積まれ、
// 別のチャンネル・チャンネルの無い保存先（従来）の一覧に出ないこと、チャンネルの無い従来の捕捉は今までどおり
// Channel Pack の台帳へ積むこと、共有層へはチャンネルを付けて上げられないことを確かめる。
//
// 一時ディレクトリだけを使う。本物の台帳・本物の配置表・本物の ~/.buzzassist には触れない。
// チャンネル・フォルダ・確認者の名前はすべて合成。path は node:path で組み立てる。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { approveLearningChange, enqueueLearningChange, listLearningChanges } from "../lib/harnessLearningChanges.mjs";
import { captureSettledJobLearning, jobChannelId } from "../lib/harnessReceiptLearning.mjs";
import {
  CHANNEL_LEARNING_SCOPE_ERROR,
  CHANNEL_SCOPE_SHARED_TARGET_ERROR,
  captureLearningProposal,
  promotionMarker,
  resolveChannelLearningScope,
  rowInChannelScope,
} from "../scripts/harness-learn.mjs";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEARN_SCRIPT = path.join(SOURCE_ROOT, "scripts", "harness-learn.mjs");
// チャンネルの学習の宛先は、台帳の制作のハーネス（narrated-story-video）から決まる公開の宛先の名前。
const TARGET = "channel-pack:narrated-story";
const SHARED_TARGET = "platform:sample-craft";
const CANONICAL_REL = "docs/requirements-ledger.md";
const TARGETS = {
  [TARGET]: {
    mode: "review-only",
    canonical: CANONICAL_REL,
    reason: "テスト用の合成台帳",
    scope: "channel-pack",
    packId: "narrated-story",
    confidential: true,
  },
  [SHARED_TARGET]: {
    mode: "auto-guidance",
    canonical: ".agents/skills/sample-craft/SKILL.md",
    overlay: ".agents/skills/sample-craft/references/learned-auto.md",
    scope: "platform",
  },
};
const ENV_KEYS_TO_DROP = ["BUZZASSIST_CHANNEL_PACK", "BUZZASSIST_CHANNEL_PACK_ID", "BUZZASSIST_CHANNEL_REGISTRY", "BUZZASSIST_LEARNING_WRITE_FORBIDDEN"];
const REVIEWER = "合成の確認者";
const NOW = "2026-09-26T00:00:00.000Z";

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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harness-learn-channel-scope-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function syntheticChannel(root, id) {
  return {
    id,
    projectDir: path.join(root, "channels", id, "project"),
    channelPack: path.join(root, "channels", id, "pack"),
    production: { kind: "harness", harnessId: "narrated-story-video" },
    strategy: { workDir: path.join(root, "channels", id, "strategy"), requireBrief: false },
  };
}

function deploymentMap(root, { channelLearning = [], channelIds = ["alpha", "beta"] } = {}) {
  return {
    deployments: [{ harnessId: "narrated-story-video", root: ".", entrypoint: "node scripts/sample-entry.mjs" }],
    channelLearning,
    channels: channelIds.map((id) => syntheticChannel(root, id)),
  };
}

/** 本物の CLI を一時リポジトリで動かす（harnessLearnChannelStore.test.mjs と同じ写し方）。 */
function stageRepo(root, options = {}) {
  const repo = path.join(root, "repo");
  // 開発用チェックアウトの印。これが無いと配布された写しと判定される（lib/harnessLearningState.mjs）。
  for (const marker of [".git", path.join(".claude", "skills"), path.join(".agents", "skills")]) {
    fs.mkdirSync(path.join(repo, marker), { recursive: true });
  }
  write(path.join(repo, "docs", "learning", "targets.json"), `${JSON.stringify({ targets: TARGETS }, null, 2)}\n`);
  write(path.join(repo, "config", "harness-deployments.json"), `${JSON.stringify(deploymentMap(root, options), null, 2)}\n`);
  const source = fs.readFileSync(LEARN_SCRIPT, "utf8");
  const staged = write(path.join(repo, "scripts", "harness-learn.mjs"), source);
  const specifiers = new Set([...source.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/gu)].map((match) => match[1]));
  // pending / approve は差分の承認キューを動的に読む。
  specifiers.add("../lib/harnessLearningChanges.mjs");
  for (const specifier of specifiers) {
    const real = path.resolve(path.dirname(LEARN_SCRIPT), specifier);
    write(path.resolve(path.dirname(staged), specifier), `export * from ${JSON.stringify(pathToFileURL(real).href)};\n`);
  }
  return repo;
}

function learningEnv(root) {
  const env = { ...process.env };
  for (const key of ENV_KEYS_TO_DROP) delete env[key];
  env.BUZZASSIST_LEARNING_DIR = path.join(root, "operator-learning-state");
  env.BUZZASSIST_LEARNING_AUTO_SYNC = "0";
  return env;
}

function runLearn(repo, root, args) {
  const result = spawnSync(process.execPath, [path.join(repo, "scripts", "harness-learn.mjs"), ...args], {
    cwd: repo, env: learningEnv(root), encoding: "utf8", input: "", timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function capture(repo, root, text, session, extra = []) {
  return runLearn(repo, root, [
    "capture", "--kind", "correction", "--target", TARGET, "--text", text,
    "--evidence", "合成の根拠（試験の観測）", "--session", session, ...extra,
  ]);
}

function capturedId(result) {
  const match = /記録しました: ([a-f0-9]{12})/u.exec(result.stdout);
  assert.ok(match, `capture の出力に id が無い:\n${result.stdout}\n${result.stderr}`);
  return match[1];
}

function channelStore(root, id) {
  return path.join(root, "operator-learning-state", "channels", id);
}

function ledger(storeRoot, kind = "proposals") {
  return path.join(storeRoot, "docs", "learning", `${kind}.jsonl`);
}

test("CLI: 同じハーネスの2チャンネルの捕捉はそれぞれの保存先に積み、別のチャンネル・チャンネルの無い一覧に出ない", (t) => {
  const root = tempRoot(t);
  const repo = stageRepo(root);
  const alphaStore = channelStore(root, "alpha");
  const betaStore = channelStore(root, "beta");
  const unscopedLedger = path.join(repo, "channel-packs", "narrated-story", "docs", "learning", "proposals.jsonl");

  const alphaCapture = capture(repo, root, "合成: 場面の最初に照明の向きを決める", "scope-alpha", ["--channel", "alpha"]);
  assert.equal(alphaCapture.status, 0, alphaCapture.stderr);
  const betaCapture = capture(repo, root, "合成: 場面の最初に窓の位置を決める", "scope-beta", ["--channel", "beta"]);
  assert.equal(betaCapture.status, 0, betaCapture.stderr);
  const unscopedCapture = capture(repo, root, "合成: 場面の最初に机の配置を決める", "scope-none");
  assert.equal(unscopedCapture.status, 0, unscopedCapture.stderr);
  const alphaId = capturedId(alphaCapture);
  const betaId = capturedId(betaCapture);
  const unscopedId = capturedId(unscopedCapture);

  // 保存先: チャンネルごとの root の docs/learning。チャンネルの無い捕捉は従来の Channel Pack の台帳。
  assert.deepEqual(readJsonl(ledger(alphaStore)).map((row) => [row.id, row.channel]), [[alphaId, "alpha"]]);
  assert.deepEqual(readJsonl(ledger(betaStore)).map((row) => [row.id, row.channel]), [[betaId, "beta"]]);
  assert.deepEqual(readJsonl(unscopedLedger).map((row) => [row.id, row.channel]), [[unscopedId, undefined]]);
  assert.deepEqual(readJsonl(path.join(repo, "docs", "learning", "proposals.jsonl")), [], "共有台帳へは書かない");

  const alphaStatus = runLearn(repo, root, ["status", "--channel", "alpha"]);
  assert.equal(alphaStatus.status, 0, alphaStatus.stderr);
  assert.ok(alphaStatus.stdout.includes(alphaId), alphaStatus.stdout);
  for (const other of [betaId, unscopedId]) assert.equal(alphaStatus.stdout.includes(other), false, `alpha の一覧に ${other} が出た:\n${alphaStatus.stdout}`);
  // 正本の読み先はそのチャンネルの保存先。
  assert.ok(alphaStatus.stdout.includes(path.join(alphaStore, CANONICAL_REL)), alphaStatus.stdout);

  const betaStatus = runLearn(repo, root, ["status", "--channel", "beta"]);
  assert.ok(betaStatus.stdout.includes(betaId) && !betaStatus.stdout.includes(alphaId) && !betaStatus.stdout.includes(unscopedId), betaStatus.stdout);

  // チャンネルの無い status は従来の台帳だけを並べ、チャンネルごとの保存先は件数だけを末尾に出す。
  const unscopedStatus = runLearn(repo, root, ["status"]);
  assert.equal(unscopedStatus.status, 0, unscopedStatus.stderr);
  assert.ok(unscopedStatus.stdout.includes(unscopedId), unscopedStatus.stdout);
  for (const other of [alphaId, betaId]) assert.equal(unscopedStatus.stdout.includes(other), false, `チャンネルの無い一覧に ${other} が出た:\n${unscopedStatus.stdout}`);
  assert.match(unscopedStatus.stdout, /alpha: 未反映 1 件/u);
  assert.match(unscopedStatus.stdout, /beta: 未反映 1 件/u);

  // overlay の材料（sync）にもチャンネルの行は入らない（保留に数えるのは従来の台帳の1件だけ）。
  const sync = runLearn(repo, root, ["sync", "--allow-missing-vocabulary"]);
  assert.equal(sync.status, 0, sync.stderr);
  assert.match(sync.stdout, new RegExp(`${TARGET} は review-only なので自動反映しません（1件保留）`, "u"));
});

test("CLI: 台帳に無いチャンネル・共有層の宛先へのチャンネル・sync の --channel は理由つきで止め、何も書かない", (t) => {
  const root = tempRoot(t);
  const repo = stageRepo(root);
  const unknown = capture(repo, root, "合成: 台帳に無いチャンネルへの捕捉", "scope-ghost", ["--channel", "ghost"]);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, new RegExp(CHANNEL_LEARNING_SCOPE_ERROR, "u"));
  assert.equal(fs.existsSync(path.join(root, "operator-learning-state", "channels")), false, "保存先を作らない");
  assert.equal(fs.existsSync(path.join(repo, "channel-packs")), false, "チャンネルの無い保存先へ落とさない");

  const shared = runLearn(repo, root, [
    "capture", "--kind", "fact", "--target", SHARED_TARGET, "--text", "合成: 共有層へ上げようとした観測",
    "--evidence", "合成の根拠", "--session", "scope-shared", "--channel", "alpha",
  ]);
  assert.notEqual(shared.status, 0);
  assert.match(shared.stderr, new RegExp(CHANNEL_SCOPE_SHARED_TARGET_ERROR, "u"));
  assert.deepEqual(readJsonl(path.join(repo, "docs", "learning", "proposals.jsonl")), [], "共有台帳へ書かない");

  const sync = runLearn(repo, root, ["sync", "--allow-missing-vocabulary", "--channel", "alpha"]);
  assert.notEqual(sync.status, 0);
  assert.match(sync.stderr, /--channel は sync では使いません/u);
});

test("差分の承認キュー: チャンネルの変更はそのチャンネルの保存先のキューにだけ置き、別のチャンネルからは当てられない", (t) => {
  const root = tempRoot(t);
  const repo = stageRepo(root);
  const alphaStore = channelStore(root, "alpha");
  const betaStore = channelStore(root, "beta");
  const alphaId = capturedId(capture(repo, root, "合成: 台詞の前に一拍おく", "queue-alpha", ["--channel", "alpha"]));
  capturedId(capture(repo, root, "合成: 台詞の後に一拍おく", "queue-beta", ["--channel", "beta"]));

  // チャンネルの正本（要求台帳）はそのチャンネルの保存先に置く。別のチャンネルの正本と別のファイル。
  const alphaCanonical = write(path.join(alphaStore, CANONICAL_REL), "# 要求台帳（合成・alpha）\n");
  const betaCanonical = write(path.join(betaStore, CANONICAL_REL), "# 要求台帳（合成・beta）\n");
  const note = "台詞の前に一拍おいてから話し始める。";
  const proposed = write(path.join(root, "proposed.md"), `# 要求台帳（合成・alpha）\n\n<!-- ${promotionMarker(alphaId)} -->\n${note}\n`);

  const queued = runLearn(repo, root, ["pending", "--channel", "alpha", "--id", alphaId, "--proposed", proposed, "--note", note]);
  assert.equal(queued.status, 0, queued.stderr);
  const changeId = /キューに置きました: (chg-[a-f0-9]+)/u.exec(queued.stdout)?.[1];
  assert.ok(changeId, queued.stdout);
  assert.match(queued.stdout, new RegExp(`approve --change ${changeId} --channel alpha`, "u"));
  assert.deepEqual(readJsonl(ledger(alphaStore, "changes")).map((row) => [row.changeId, row.channel, row.targetSource]), [[changeId, "alpha", "channel"]]);

  const listBeta = runLearn(repo, root, ["pending", "--channel", "beta"]);
  assert.equal(listBeta.status, 0, listBeta.stderr);
  assert.match(listBeta.stdout, /承認待ちの変更はありません/u);
  const listUnscoped = runLearn(repo, root, ["pending"]);
  assert.match(listUnscoped.stdout, /承認待ちの変更はありません/u);
  const listAlpha = runLearn(repo, root, ["pending", "--channel", "alpha"]);
  assert.ok(listAlpha.stdout.includes(changeId), listAlpha.stdout);

  // ライブラリから当てる（Channel Pack の台帳は人の確認でだけ当たる。試験では対話端末と二手を渡す）。
  const env = learningEnv(root);
  const common = { repoRoot: repo, env, homeDir: root, now: () => NOW };
  assert.deepEqual(listLearningChanges({ ...common, channel: "beta" }), []);
  assert.throws(
    () => approveLearningChange({ ...common, channel: "beta", changeId, reviewer: REVIEWER, humanVerified: true, isInteractive: true }),
    (error) => error.code === "change-not-found",
  );
  assert.throws(
    () => approveLearningChange({ ...common, channel: "alpha", changeId }),
    (error) => error.code === "human-verification-required",
    "エージェントは Channel Pack の台帳へ当てない（従来どおり）",
  );
  const { record } = approveLearningChange({ ...common, channel: "alpha", changeId, reviewer: REVIEWER, humanVerified: true, isInteractive: true });
  assert.equal(record.channel, "alpha");
  assert.ok(fs.readFileSync(alphaCanonical, "utf8").includes(note), "alpha の正本に当たる");
  assert.equal(fs.readFileSync(betaCanonical, "utf8"), "# 要求台帳（合成・beta）\n", "beta の正本は変わらない");
  assert.deepEqual(readJsonl(ledger(alphaStore, "applied")).map((row) => [row.changeId, row.channel]), [[changeId, "alpha"]]);
  assert.equal(fs.existsSync(ledger(betaStore, "applied")), false);
  // alpha の提案は反映済み、beta の提案は未反映のまま。
  const alphaStatus = runLearn(repo, root, ["status", "--channel", "alpha"]);
  assert.match(alphaStatus.stdout, /未反映の提案はありません/u);
  const betaStatus = runLearn(repo, root, ["status", "--channel", "beta"]);
  assert.match(betaStatus.stdout, /未反映 1 件/u);

  // 範囲の保存先は台帳が決めた alpha の root。
  const scope = resolveChannelLearningScope("alpha", { repoRoot: repo, env });
  assert.equal(scope.stores.get(TARGET).root, alphaStore);
});

test("範囲の読み取り: 保存先のファイルに別のチャンネルの印の行・範囲外の宛先の行があっても読まない", () => {
  const scope = { channelId: "alpha", stores: new Map([[TARGET, { root: "unused", source: "channel-default" }]]) };
  assert.equal(rowInChannelScope({ id: "a", target: TARGET, channel: "alpha" }, scope), true);
  assert.equal(rowInChannelScope({ id: "b", target: TARGET }, scope), true, "印の無い行は、引き継いだ従来の行として読む");
  assert.equal(rowInChannelScope({ id: "c", target: TARGET, channel: "beta" }, scope), false);
  assert.equal(rowInChannelScope({ id: "d", target: "channel-pack:sample-other" }, scope), false);
});

test("チャンネルの宣言: { target, channel, root } の私有プロジェクトへ積み、同じ宛先の2チャンネルの片方が従来の台帳を引き継ぐ宣言は拒む", (t) => {
  const root = tempRoot(t);
  const privateProject = path.join(root, "operator-private", "alpha-project");
  const repo = stageRepo(root, { channelLearning: [{ target: TARGET, channel: "alpha", root: privateProject }] });
  const id = capturedId(capture(repo, root, "合成: 場面転換の前に音を落とす", "declared-alpha", ["--channel", "alpha"]));
  assert.deepEqual(readJsonl(ledger(privateProject)).map((row) => row.id), [id]);
  assert.equal(fs.existsSync(channelStore(root, "alpha")), false, "宣言があれば既定の保存先は使わない");

  // 2チャンネルが同じ宛先を使うのに、片方がチャンネルの無い Job の保存先（従来の台帳）を引き継ぐ宣言は台帳で拒む。
  const inheritRoot = path.join(root, "inherit");
  const inherit = stageRepo(inheritRoot, { channelLearning: [{ target: TARGET, channel: "alpha", root: path.join(inheritRoot, "repo", "channel-packs", "narrated-story") }] });
  const refused = capture(inherit, inheritRoot, "合成: 引き継ぎの宣言を拒む", "inherit-alpha", ["--channel", "alpha"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /channel-learning-store-unscoped-overlap:alpha/u);
});

test("引き継ぎ: 既存の Channel Pack の台帳を持つチャンネルを1つ目として登録し、root をその Pack にすれば従来の学習を読み続ける", (t) => {
  const root = tempRoot(t);
  // 登録する前（チャンネルの無い従来の捕捉）。台帳は Channel Pack の既定の置き場に積まれる。
  const repo = stageRepo(root, { channelIds: [] });
  const legacyId = capturedId(capture(repo, root, "合成: 登録の前に拾った指摘", "inherit-before"));
  const packLedger = path.join(repo, "channel-packs", "narrated-story", "docs", "learning", "proposals.jsonl");
  assert.deepEqual(readJsonl(packLedger).map((row) => row.id), [legacyId]);

  // 1つ目のチャンネルとして登録し、root を従来の Pack のフォルダにする（docs の書き方と同じ）。
  fs.writeFileSync(path.join(repo, "config", "harness-deployments.json"), `${JSON.stringify(deploymentMap(root, {
    channelIds: ["alpha"],
    channelLearning: [{ target: TARGET, channel: "alpha", root: "channel-packs/narrated-story" }],
  }), null, 2)}\n`);
  const afterId = capturedId(capture(repo, root, "合成: 登録の後に拾った指摘", "inherit-after", ["--channel", "alpha"]));
  // 同じ台帳のファイルに、印の無い従来の行と、印のある新しい行が並ぶ。
  assert.deepEqual(readJsonl(packLedger).map((row) => [row.id, row.channel]), [[legacyId, undefined], [afterId, "alpha"]]);
  const status = runLearn(repo, root, ["status", "--channel", "alpha"]);
  assert.equal(status.status, 0, status.stderr);
  assert.ok(status.stdout.includes(legacyId) && status.stdout.includes(afterId), `従来の行も読む:\n${status.stdout}`);
  assert.equal(fs.existsSync(channelStore(root, "alpha")), false, "既定の保存先は使わない");
});

test("Job の確定時の自動の捕捉: metadata.channel の Job はそのチャンネルの保存先へ、無い Job は従来の宛先へ", async (t) => {
  const root = tempRoot(t);
  const registryPath = write(path.join(root, "registry.json"), JSON.stringify(deploymentMap(root)));
  const learningDir = path.join(root, "operator-learning-state");
  const env = { BUZZASSIST_CHANNEL_REGISTRY: registryPath, BUZZASSIST_LEARNING_DIR: learningDir };
  const job = (id, metadata) => ({
    id,
    status: "failed",
    revision: 3,
    updatedAt: NOW,
    harness: { id: "narrated-story-video", declarationVersion: "1.0.0" },
    stages: [{ id: "production", status: "failed" }],
    ...(metadata ? { metadata } : {}),
  });
  const common = {
    env,
    now: () => NOW,
    locateReceipt: async () => null,
    loadDeclaration: () => null,
    receiptIndexPath: path.join(root, "receipts", "index.jsonl"),
    syncOverlays: null,
    queueFeedback: null,
  };
  assert.equal(jobChannelId(job("video-a", { channel: { id: "alpha", selectedBy: "channel-pack" } })), "alpha");
  assert.equal(jobChannelId(job("video-b")), "");
  assert.equal(jobChannelId(job("video-c", { channel: { id: "../escape" } })), "", "id の形でないものは使わない");

  // 本物の捕捉で、チャンネルの保存先（一時ディレクトリ）へ積む。
  const quiet = { signals: { terms: [], castIds: [] }, privateVocabulary: null, homeRoot: "" };
  const alpha = await captureSettledJobLearning({
    ...common,
    job: job("video-alpha", { channel: { id: "alpha", selectedBy: "explicit" } }),
    captureOptions: quiet,
  });
  assert.equal(alpha.channelId, "alpha");
  assert.equal(alpha.target, TARGET);
  assert.ok(alpha.captured > 0, JSON.stringify(alpha));
  const alphaRows = readJsonl(ledger(path.join(learningDir, "channels", "alpha")));
  assert.equal(alphaRows.length, alpha.captured);
  assert.ok(alphaRows.every((row) => row.channel === "alpha" && row.target === TARGET && row.createdBy === "auto-receipt"));
  assert.equal(fs.existsSync(path.join(learningDir, "channels", "beta")), false, "別のチャンネルの保存先に積まない");

  // 台帳に無いチャンネルの Job は、チャンネルの無い保存先へ落とさずに理由を返す。
  const ghost = await captureSettledJobLearning({ ...common, job: job("video-ghost", { channel: { id: "ghost" } }), captureOptions: quiet });
  assert.equal(ghost.captured, 0);
  assert.equal(ghost.skippedReason, "channel-learning-store-unresolved");

  // チャンネルの無い Job は従来どおり（捕捉にチャンネルを渡さない）。本物の台帳へ書かないよう捕捉を差し替える。
  const calls = [];
  const legacy = await captureSettledJobLearning({
    ...common,
    job: job("video-legacy"),
    capture: (input, options) => {
      calls.push({ target: input.target, options });
      return { appended: true, entry: { id: "0123456789ab" } };
    },
  });
  assert.equal(legacy.channelId, undefined);
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => call.target === TARGET && !("channelId" in (call.options || {}))), JSON.stringify(calls));
});

test("共有層へ上げる経路: チャンネルを付けた共有層宛の捕捉は止め、チャンネルの宛先に無い宛先へも積まない", (t) => {
  const root = tempRoot(t);
  const registryPath = write(path.join(root, "registry.json"), JSON.stringify(deploymentMap(root)));
  const env = { BUZZASSIST_CHANNEL_REGISTRY: registryPath, BUZZASSIST_LEARNING_DIR: path.join(root, "operator-learning-state") };
  const rows = [];
  const options = {
    env,
    channelId: "alpha",
    signals: { terms: [], castIds: [] },
    privateVocabulary: null,
    homeRoot: "",
    append: (_file, entry) => rows.push(entry),
    read: () => rows,
    lock: (_file, action) => action(),
    refreshCatalog: () => ({ written: false }),
  };
  const input = (target) => ({ kind: "fact", target, text: "合成: チャンネルで観測した事実", evidence: "合成の根拠", session: "shared-escalation", now: NOW });
  assert.throws(() => captureLearningProposal(input("genre:narrated-story-video"), options), (error) => error.code === CHANNEL_SCOPE_SHARED_TARGET_ERROR);
  assert.throws(() => captureLearningProposal(input("platform:platform-craft"), options), (error) => error.code === CHANNEL_SCOPE_SHARED_TARGET_ERROR);
  // チャンネルの学習の宛先に無い channel-pack 宛（このチャンネルは台本の品質ループを持たない）へも積まない。
  assert.throws(() => captureLearningProposal(input("channel-pack:narrated-story-script"), options), (error) => error.code === CHANNEL_LEARNING_SCOPE_ERROR);
  assert.deepEqual(rows, []);
});
