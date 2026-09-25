// start / resume の関門（lib/channelStartGate.mjs と lib/videoHarnessService.mjs）の試験。チャンネルの台帳の
// requireBrief で start が有料の処理の前に止まること、再レンダー（resume）は止めないこと、start のときの
// ブリーフが変われば resume が止まること。チャンネル・台本・ブリーフ・会話 id はすべて合成で、有料 API も
// モデルも呼ばない（Job は計画だけ。resume の実行器は差し替える）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CHANNEL_INPUT_CONFLICT_CODE, validateChannelRegistry } from "../lib/channelRegistry.mjs";
import {
  CHANNEL_PRODUCTION_EXTERNAL_CODE,
  CHANNEL_STRATEGY_BRIEF_NOT_PASSED_CODE,
  CHANNEL_STRATEGY_BRIEF_REQUIRED_CODE,
  STRATEGY_BRIEF_NOT_IN_CHANNEL_CODE,
  checkResumeStrategyBrief,
} from "../lib/channelStartGate.mjs";
import {
  STRATEGY_BRIEF_CHANGED_SINCE_START_CODE,
  STRATEGY_BRIEF_CHANNEL_MISMATCH_CODE,
  STRATEGY_BRIEF_MISSING_AT_RESUME_CODE,
  STRATEGY_BRIEF_OUTSIDE_CHANNEL_CODE,
} from "../lib/channelStrategyBrief.mjs";
import { recordStrategyBriefRound, startStrategyBriefLoop } from "../lib/strategyBriefQualityLoop.mjs";
import { createVideoHarnessJob, readVideoHarnessJob } from "../lib/videoHarnessJob.mjs";
import { createVideoHarnessService } from "../lib/videoHarnessService.mjs";
import { evidenceRow, jsonBytes, metricsOutput, sampleBrief, sha, writeJson } from "./helpers/strategyBriefFixture.mjs";

// Job の仕組みを実際の宣言とスキルの上で確かめる（test/videoHarnessJob.test.mjs と同じ理由で、
// スキルの人の承認の要求だけを外す）。
process.env.BUZZASSIST_REQUIRE_SKILL_APPROVAL = "0";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = "narrated-story-video";
const now = () => "2026-09-26T09:00:00.000Z";
const SCORES = (value) => ({ "single-question": value, "audience-specificity": value, "promise-payoff": value, "evidence-honesty": value, "change-grounding": value, producibility: value });

function channelRow(root, id, overrides = {}) {
  return {
    id,
    projectDir: path.join(root, id, "project"),
    channelPack: path.join(root, id, "pack.bundle"),
    production: { kind: "harness", harnessId: HARNESS },
    strategy: { workDir: path.join(root, id, "strategy"), requireBrief: true },
    scriptQuality: { genre: "narrated-story" },
    ...overrides,
  };
}

function createFixture(t, { alphaRequireBrief = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "channel-start-gate-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(path.join(root, "deployment", "production"), { recursive: true });
  fs.writeFileSync(path.join(root, "deployment", "production", "story-harness.mjs"), "export const fixture = 1;\n");
  fs.writeFileSync(path.join(root, "config", "harness-deployments.json"), `${JSON.stringify({
    deployments: [{ harnessId: HARNESS, root: "deployment", entrypoint: "node production/story-harness.mjs" }],
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "script.txt"), "合成の台本です。\n");
  const rows = [
    channelRow(root, "alpha", { strategy: { workDir: path.join(root, "alpha", "strategy"), requireBrief: alphaRequireBrief } }),
    channelRow(root, "beta", { strategy: { workDir: path.join(root, "beta", "strategy"), requireBrief: false } }),
    channelRow(root, "gamma", { production: { kind: "external", note: "合成: チャンネルの既存の書き出しの仕組み" }, strategy: { workDir: path.join(root, "gamma", "strategy"), requireBrief: false } }),
  ];
  for (const row of rows) {
    fs.mkdirSync(row.projectDir, { recursive: true });
    fs.mkdirSync(row.strategy.workDir, { recursive: true });
    fs.writeFileSync(row.channelPack, `synthetic pack ${row.id}`);
  }
  const registry = { source: "test", channels: validateChannelRegistry({ channels: rows }, { repoRoot: REPO_ROOT, harnessIds: [HARNESS, "koya-manga-video"], genres: ["narrated-story"] }) };
  const byId = Object.fromEntries(registry.channels.map((entry) => [entry.id, entry]));
  const runs = [];
  const service = (overrides = {}) => createVideoHarnessService({
    env: {},
    createJob: (args) => createVideoHarnessJob({ ...args, repoRoot: root }),
    projectCanvas: async () => {},
    planPreflight: async () => null,
    preflightReviewerTrust: async () => ({ ok: true, code: "", activeReviewers: 1, source: "fixture" }),
    captureRunLearning: null,
    productionProfile: async () => ({}),
    withJobLock: async (_lock, action) => action(),
    runJob: async ({ projectDir, jobId }) => {
      runs.push(jobId);
      return { ...(await readVideoHarnessJob({ projectDir, jobId })), status: "completed" };
    },
    channelRegistry: () => registry,
    ...overrides,
  });
  return { root, registry, byId, runs, service, script: path.join(root, "script.txt") };
}

async function writeBrief(fixture, channelId, { pass = true, briefChannelId = channelId, name = "brief.json" } = {}) {
  const workDir = fixture.byId[channelId].strategy.workDir;
  const metrics = await writeJson(workDir, "evidence/metrics.json", metricsOutput());
  const bytes = jsonBytes(sampleBrief({
    channel: { id: briefChannelId, designVersion: "design-v1" },
    evidence: [evidenceRow(metrics, { id: "e-metrics", kind: "metrics", premiseBound: false, premiseIndependenceReason: "合成: 公開済みの動画の実測" })],
    changes: { previous: null, keep: [{ point: "合成の残す点", evidenceIds: ["e-metrics"] }], change: [] },
  }));
  const briefPath = path.join(workDir, name);
  fs.writeFileSync(briefPath, bytes);
  await startStrategyBriefLoop({ workDir, generatorContextId: "ctx-planner-1", now });
  const review = await writeJson(workDir, "quality/reviews/r1.json", {
    evaluatorId: "evaluator",
    evaluatorContextId: "ctx-eval-1",
    evaluatorHost: "codex",
    briefSha256: sha(bytes),
    rubricScores: SCORES(pass ? 92 : 40),
    notes: "合成: ブリーフと根拠のファイルを開いて照合した",
    findings: [],
  });
  const recorded = await recordStrategyBriefRound({ workDir, briefPath: name, reviewPath: review.rel, now });
  assert.equal(recorded.state.status, pass ? "passed" : "active");
  return { briefPath, sha256: sha(bytes) };
}

function jobDirs(projectDir) {
  const dir = path.join(projectDir, "canvas", "harness-runs");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

test("requireBrief: 合格したブリーフが無ければ start は Job を作る前に止まり、直す工程を添える", async (t) => {
  const fixture = createFixture(t);
  const service = fixture.service();
  const alpha = fixture.byId.alpha;
  await assert.rejects(
    service.start({ channelId: "alpha", scriptPath: fixture.script }),
    (error) => error.code === CHANNEL_STRATEGY_BRIEF_REQUIRED_CODE && error.recommendedStep === "hyp-design" && /Job は作っていない/u.test(error.message),
  );
  // --channel を付け忘れても、Pack が台帳のチャンネルに当たれば同じ関門を通る。
  await assert.rejects(
    service.start({ channelPackPath: alpha.channelPack, projectDir: alpha.projectDir, harnessId: HARNESS, scriptPath: fixture.script }),
    { code: CHANNEL_STRATEGY_BRIEF_REQUIRED_CODE },
  );
  // 合格していないブリーフ → 企画の品質ループへ。
  const failing = await writeBrief(fixture, "alpha", { pass: false });
  await assert.rejects(
    service.start({ channelId: "alpha", scriptPath: fixture.script, strategyBriefPath: failing.briefPath }),
    (error) => error.code === CHANNEL_STRATEGY_BRIEF_NOT_PASSED_CODE
      && error.recommendedStep === "strategy-brief-review"
      && error.reasonCodes.some((code) => code.startsWith("strategy-brief-loop-not-passed")),
  );
  assert.deepEqual(jobDirs(alpha.projectDir), [], "止めた start は Job を作らない");
  assert.deepEqual(fixture.runs, [], "有料の実行器に届かない");
});

test("requireBrief: 合格したブリーフで start すると、台帳の作業フォルダ・Pack・ハーネスで Job を作り、ブリーフの場所を残す", async (t) => {
  const fixture = createFixture(t);
  const alpha = fixture.byId.alpha;
  const brief = await writeBrief(fixture, "alpha");
  const service = fixture.service();
  // 作業フォルダに合格したブリーフがあるのに渡し忘れた → 渡し直す案内（reuse-brief）。
  await assert.rejects(
    service.start({ channelId: "alpha", scriptPath: fixture.script }),
    (error) => error.code === CHANNEL_STRATEGY_BRIEF_REQUIRED_CODE && error.recommendedStep === "reuse-brief" && error.message.includes(brief.briefPath),
  );
  const started = await service.start({ channelId: "alpha", scriptPath: fixture.script, strategyBriefPath: brief.briefPath });
  assert.equal(started.execution.planOnly, true);
  assert.equal(started.projectDir, alpha.projectDir);
  assert.deepEqual(started.channel, { id: "alpha", selectedBy: "explicit" });
  assert.equal(started.strategyBrief.pass, true);
  const job = await readVideoHarnessJob({ projectDir: alpha.projectDir, jobId: started.jobId });
  assert.equal(job.harness.id, HARNESS);
  assert.equal(job.channelPack.path, alpha.channelPack);
  assert.equal(job.options.strategyBriefSha256, brief.sha256);
  assert.deepEqual(job.metadata.strategyBrief, { path: brief.briefPath, sha256: brief.sha256 });
  assert.deepEqual(job.metadata.channel, { id: "alpha", selectedBy: "explicit" });
  // ブリーフの場所は Job の識別子に入らない（同じ SHA なら同じ Job）。
  const again = await service.start({ channelId: "alpha", scriptPath: fixture.script, options: { strategyBriefSha256: brief.sha256 } });
  assert.equal(again.jobId, started.jobId);
  assert.equal(again.attached, true);
});

test("MCP の形（SHA だけ）: 品質ループの記録から同じ SHA のブリーフを探し、無ければ止める", async (t) => {
  const fixture = createFixture(t);
  const brief = await writeBrief(fixture, "alpha");
  const service = fixture.service();
  const started = await service.start({ channelId: "alpha", scriptPath: fixture.script, options: { strategyBriefSha256: brief.sha256 } });
  const job = await readVideoHarnessJob({ projectDir: fixture.byId.alpha.projectDir, jobId: started.jobId });
  assert.equal(job.metadata.strategyBrief.path, brief.briefPath);
  await assert.rejects(
    service.start({ channelId: "alpha", scriptPath: fixture.script, options: { strategyBriefSha256: "0".repeat(64) } }),
    { code: STRATEGY_BRIEF_NOT_IN_CHANNEL_CODE },
  );
});

test("台帳と食い違う入力・外部の制作・別のチャンネルのブリーフは start しない", async (t) => {
  const fixture = createFixture(t);
  const { alpha, beta } = fixture.byId;
  const brief = await writeBrief(fixture, "alpha");
  const service = fixture.service();
  const base = { channelId: "alpha", scriptPath: fixture.script, strategyBriefPath: brief.briefPath };
  await assert.rejects(service.start({ ...base, projectDir: beta.projectDir }), { code: CHANNEL_INPUT_CONFLICT_CODE });
  await assert.rejects(service.start({ ...base, channelPackPath: beta.channelPack }), { code: CHANNEL_INPUT_CONFLICT_CODE });
  await assert.rejects(service.start({ ...base, harnessId: "koya-manga-video" }), { code: CHANNEL_INPUT_CONFLICT_CODE });
  // Pack と作業フォルダが別のチャンネルを指す（--channel なし）。
  await assert.rejects(service.start({ scriptPath: fixture.script, channelPackPath: alpha.channelPack, projectDir: beta.projectDir }), { code: CHANNEL_INPUT_CONFLICT_CODE });
  await assert.rejects(service.start({ channelId: "gamma", scriptPath: fixture.script }), { code: CHANNEL_PRODUCTION_EXTERNAL_CODE });
  const betaBrief = await writeBrief(fixture, "beta");
  await assert.rejects(service.start({ channelId: "alpha", scriptPath: fixture.script, strategyBriefPath: betaBrief.briefPath }), { code: STRATEGY_BRIEF_OUTSIDE_CHANNEL_CODE });
  // 作業フォルダの中でも、channel.id が別のチャンネルのブリーフは使わない。
  const mismatch = path.join(beta.strategy.workDir, "mismatch.json");
  fs.writeFileSync(mismatch, jsonBytes(sampleBrief({ channel: { id: "synthetic-other-channel", designVersion: "design-v1" } })));
  await assert.rejects(service.start({ channelId: "beta", scriptPath: fixture.script, strategyBriefPath: mismatch }), { code: STRATEGY_BRIEF_CHANNEL_MISMATCH_CODE });
  assert.deepEqual(jobDirs(alpha.projectDir), []);
  assert.deepEqual(jobDirs(beta.projectDir), []);
});

test("requireBrief が false のチャンネル: ブリーフ無しでも、合格していないブリーフでも start できる（SHA と場所は残す）", async (t) => {
  const fixture = createFixture(t);
  const service = fixture.service();
  const plain = await service.start({ channelId: "beta", scriptPath: fixture.script });
  assert.equal(plain.execution.planOnly, true);
  const failing = await writeBrief(fixture, "beta", { pass: false });
  const withBrief = await service.start({ channelId: "beta", scriptPath: fixture.script, strategyBriefPath: failing.briefPath });
  assert.equal(withBrief.strategyBrief.pass, false);
  const job = await readVideoHarnessJob({ projectDir: fixture.byId.beta.projectDir, jobId: withBrief.jobId });
  assert.equal(job.options.strategyBriefSha256, failing.sha256);
  assert.notEqual(withBrief.jobId, plain.jobId);
});

test("resume: start のときのブリーフが変わった・無くなったなら、Job を変えず有料の処理の前に止める", async (t) => {
  const fixture = createFixture(t);
  const alpha = fixture.byId.alpha;
  const brief = await writeBrief(fixture, "alpha");
  const service = fixture.service();
  const started = await service.start({ channelId: "alpha", scriptPath: fixture.script, strategyBriefPath: brief.briefPath });
  const resumed = await service.resume({ projectDir: alpha.projectDir, jobId: started.jobId, confirmed: true });
  assert.equal(resumed.strategyBriefCheck.status, "unchanged");
  assert.deepEqual(fixture.runs, [started.jobId]);

  const before = fs.readFileSync(path.join(alpha.projectDir, "canvas", "harness-runs", started.jobId, "job.json"), "utf8");
  fs.writeFileSync(brief.briefPath, jsonBytes({ ...JSON.parse(fs.readFileSync(brief.briefPath, "utf8")), question: "合成の別の問いへ書き換えた" }));
  await assert.rejects(
    service.resume({ projectDir: alpha.projectDir, jobId: started.jobId, confirmed: true }),
    (error) => error.code === STRATEGY_BRIEF_CHANGED_SINCE_START_CODE && /新しい Job として start する/u.test(error.message),
  );
  fs.rmSync(brief.briefPath);
  await assert.rejects(service.resume({ projectDir: alpha.projectDir, jobId: started.jobId, confirmed: true }), { code: STRATEGY_BRIEF_MISSING_AT_RESUME_CODE });
  assert.deepEqual(fixture.runs, [started.jobId], "止めた resume は実行器に届かない");
  assert.equal(fs.readFileSync(path.join(alpha.projectDir, "canvas", "harness-runs", started.jobId, "job.json"), "utf8"), before, "Job を書き換えない");
});

test("再レンダー（resume）は requireBrief で止めない。場所の無い Job はチャンネルの記録で探し、探せなければ結果に出して続ける", async (t) => {
  // ブリーフを必須にしていなかったときに作った Job を、必須にした後で再開する。
  const loose = createFixture(t, { alphaRequireBrief: false });
  const plain = await loose.service().start({ channelId: "alpha", scriptPath: loose.script });
  const strictRegistry = {
    source: "test",
    channels: loose.registry.channels.map((entry) => (entry.id === "alpha" ? { ...entry, strategy: { ...entry.strategy, requireBrief: true } } : entry)),
  };
  const resumed = await loose.service({ channelRegistry: () => strictRegistry }).resume({ projectDir: loose.byId.alpha.projectDir, jobId: plain.jobId, confirmed: true });
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.strategyBriefCheck, undefined, "ブリーフの無い Job は照合しない");

  // start がファイルの場所を残していない Job（SHA だけ）: チャンネルの品質ループの記録から探す。
  const fixture = createFixture(t);
  const brief = await writeBrief(fixture, "alpha");
  const job = { id: "video-synthetic-0123456789abcdef", options: { strategyBriefSha256: brief.sha256 }, metadata: { channel: { id: "alpha" } } };
  assert.equal((await checkResumeStrategyBrief({ job, registry: fixture.registry })).status, "unchanged");
  fs.writeFileSync(brief.briefPath, jsonBytes({ ...JSON.parse(fs.readFileSync(brief.briefPath, "utf8")), question: "合成の別の問い" }));
  await assert.rejects(checkResumeStrategyBrief({ job, registry: () => fixture.registry }), { code: STRATEGY_BRIEF_CHANGED_SINCE_START_CODE });
  // チャンネルも場所も無い → 照合できないことを返す（止めない）。
  const orphan = await checkResumeStrategyBrief({ job: { options: { strategyBriefSha256: brief.sha256 } } });
  assert.deepEqual(orphan, { status: "not-verifiable", sha256: brief.sha256, reasonCode: "strategy-brief-path-not-recorded" });
});

test("Job の metadata は channel と strategyBrief だけで、ブリーフの SHA は options と一致させる", async (t) => {
  const fixture = createFixture(t);
  const input = { projectDir: fixture.byId.alpha.projectDir, scriptPath: fixture.script, channelPackPath: fixture.byId.alpha.channelPack, harnessId: HARNESS, repoRoot: fixture.root };
  await assert.rejects(createVideoHarnessJob({ ...input, metadata: { other: 1 } }), /channel と strategyBrief だけ/u);
  await assert.rejects(
    createVideoHarnessJob({ ...input, options: { strategyBriefSha256: "a".repeat(64) }, metadata: { strategyBrief: { path: path.join(fixture.root, "brief.json"), sha256: "b".repeat(64) } } }),
    /strategy-brief-sha256-invalid/u,
  );
  await assert.rejects(
    createVideoHarnessJob({ ...input, options: { strategyBriefSha256: "a".repeat(64) }, metadata: { strategyBrief: { path: "relative/brief.json", sha256: "a".repeat(64) } } }),
    /絶対 path/u,
  );
});
