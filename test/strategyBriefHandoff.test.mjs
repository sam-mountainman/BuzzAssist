// 企画ブリーフを制作へ渡す口（run-video-harness の plan-request / start）の試験。ブリーフは任意で、
// plan-request は verdict の合否と根拠の状態を理由に出し、start はブリーフの SHA-256 を Job の options に残す
// （Job の識別子に入る）。台本・Pack・ブリーフ・会話 id はすべて合成で、有料 API もモデルも呼ばない。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { strategyBriefHandoff, recordStrategyBriefRound, startStrategyBriefLoop } from "../lib/strategyBriefQualityLoop.mjs";
import { STRATEGY_BRIEF_OPTION_INVALID_CODE, createVideoHarnessJob, readVideoHarnessJob } from "../lib/videoHarnessJob.mjs";
import { createVideoHarnessService } from "../lib/videoHarnessService.mjs";
import { planVideoRequest } from "../lib/videoRequestPlan.mjs";
import { strategyBriefStartOptions } from "../scripts/run-video-harness.mjs";
import { evidenceRow, jsonBytes, metricsOutput, sampleBrief, sha, writeJson } from "./helpers/strategyBriefFixture.mjs";

// Job の仕組みを実際の宣言とスキルの上で確かめる（test/videoHarnessJob.test.mjs と同じ理由で、
// スキルの人の承認の要求だけを外す）。
process.env.BUZZASSIST_REQUIRE_SKILL_APPROVAL = "0";
const HARNESS = "narrated-story-video";

function tempRoot(t, prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** 合格した企画ブリーフ（品質ループの記録つき）を作業フォルダに作る。 */
async function passedBrief(root) {
  const workDir = path.join(root, "planning");
  fs.mkdirSync(workDir, { recursive: true });
  const metrics = await writeJson(workDir, "evidence/metrics.json", metricsOutput());
  const brief = sampleBrief({
    evidence: [evidenceRow(metrics, { id: "e-metrics", kind: "metrics", premiseBound: false, premiseIndependenceReason: "合成: 公開済みの動画の実測" })],
    changes: { previous: null, keep: [{ point: "合成の残す点", evidenceIds: ["e-metrics"] }], change: [] },
  });
  const bytes = jsonBytes(brief);
  const briefPath = path.join(workDir, "brief.json");
  fs.writeFileSync(briefPath, bytes);
  const now = () => "2026-09-26T09:00:00.000Z";
  await startStrategyBriefLoop({ workDir, generatorContextId: "ctx-planner-1", now });
  const review = await writeJson(workDir, "quality/reviews/r1.json", {
    evaluatorId: "evaluator",
    evaluatorContextId: "ctx-eval-1",
    evaluatorHost: "codex",
    briefSha256: sha(bytes),
    rubricScores: { "single-question": 92, "audience-specificity": 92, "promise-payoff": 92, "evidence-honesty": 92, "change-grounding": 92, producibility: 92 },
    notes: "合成: ブリーフと根拠のファイルを開いて照合した",
    findings: [],
  });
  const recorded = await recordStrategyBriefRound({ workDir, briefPath: "brief.json", reviewPath: review.rel, now });
  assert.equal(recorded.state.status, "passed");
  return { workDir, briefPath, brief, sha256: sha(bytes) };
}

function jobFixture(t) {
  const root = tempRoot(t, "strategy-handoff-job-");
  const deployment = path.join(root, "deployment");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(path.join(deployment, "production"), { recursive: true });
  fs.writeFileSync(path.join(deployment, "production", "story-harness.mjs"), "export const fixture = 1;\n");
  fs.writeFileSync(path.join(root, "script.txt"), "合成の台本です。\n");
  fs.writeFileSync(path.join(root, "pack.bundle"), "synthetic pack");
  fs.writeFileSync(path.join(root, "config", "harness-deployments.json"), `${JSON.stringify({
    deployments: [{ harnessId: HARNESS, root: "deployment", entrypoint: "node production/story-harness.mjs" }],
  }, null, 2)}\n`);
  return root;
}

test("plan-request: 渡したブリーフの verdict（合格・根拠の状態）を理由に出し、start の例にブリーフを載せる", async (t) => {
  const root = tempRoot(t, "strategy-handoff-plan-");
  const { briefPath, sha256 } = await passedBrief(root);
  const receiptsDir = path.join(root, "receipts");
  const evalsDir = path.join(root, "evals");
  fs.mkdirSync(receiptsDir);
  fs.mkdirSync(evalsDir);
  const base = { projectDir: root, env: {}, receiptsDir, skillEvalsDir: evalsDir, harnessId: HARNESS, request: "合成の依頼" };

  const result = await planVideoRequest({ ...base, strategyBriefPath: briefPath });
  assert.equal(result.modelCallsAttempted, false);
  assert.equal(result.input.strategyBrief.pass, true);
  assert.equal(result.input.strategyBrief.briefSha256, sha256);
  assert.deepEqual(result.input.strategyBrief.evidence, { unverified: 0, provisional: 1, verified: 0, stale: 0 });
  const reasons = result.candidates[0].reasons.join("\n");
  assert.match(reasons, /企画ブリーフ（r1）: 合格・根拠 verified 0 \/ provisional 1 \/ unverified 0/u);
  assert.ok(result.summaryLines.some((line) => line.startsWith("企画ブリーフ（r1）")));
  assert.ok(result.nextStep.cli.includes(`--strategy-brief "${path.resolve(briefPath)}"`), result.nextStep.cli);
  assert.equal(result.nextStep.mcp.arguments.options.strategyBriefSha256, sha256);
  // ブリーフは必須ではない（渡さなければ何も出さない）。合否で止めない。
  const without = await planVideoRequest(base);
  assert.deepEqual(without.input.strategyBrief, { provided: false });
  assert.ok(!without.nextStep.cli.includes("--strategy-brief"));
  assert.deepEqual(without.decision.blockers, result.decision.blockers);

  // 合格の後で書き換えたブリーフは、未合格の理由コードつきで出る（止めない）。
  fs.writeFileSync(briefPath, jsonBytes({ ...JSON.parse(fs.readFileSync(briefPath, "utf8")), question: "合成の別の問いへ書き換えた" }));
  const changed = await planVideoRequest({ ...base, strategyBriefPath: briefPath });
  assert.equal(changed.input.strategyBrief.pass, false);
  assert.ok(changed.input.strategyBrief.reasonCodes.includes("strategy-brief-not-reviewed"));
  assert.match(changed.candidates[0].reasons.join("\n"), /企画ブリーフ（r1）: 未合格（/u);
  assert.deepEqual(changed.decision.blockers, result.decision.blockers);
  // 無いファイルは読めないと言う（計画は続ける）。
  const missing = await planVideoRequest({ ...base, strategyBriefPath: path.join(root, "none.json") });
  assert.deepEqual(missing.input.strategyBrief.reasonCodes, ["strategy-brief-missing"]);
});

test("start: ブリーフの SHA-256 を Job の options に残し、Job の識別子に入る。形の違う SHA は拒む", async (t) => {
  const root = jobFixture(t);
  const { briefPath, sha256 } = await passedBrief(root);
  const input = { projectDir: root, scriptPath: path.join(root, "script.txt"), channelPackPath: path.join(root, "pack.bundle"), harnessId: HARNESS, repoRoot: root };

  const { options, strategyBrief } = await strategyBriefStartOptions({ strategyBrief: briefPath }, {});
  assert.deepEqual(options, { strategyBriefSha256: sha256 });
  assert.equal(strategyBrief.pass, true);

  const plain = await createVideoHarnessJob(input);
  const withBrief = await createVideoHarnessJob({ ...input, options });
  assert.equal(withBrief.job.options.strategyBriefSha256, sha256);
  assert.notEqual(withBrief.job.id, plain.job.id, "ブリーフは Job の識別子に入る（別のブリーフなら別の Job）");
  const again = await createVideoHarnessJob({ ...input, options });
  assert.equal(again.attached, true);
  assert.equal(again.job.id, withBrief.job.id);
  await assert.rejects(
    createVideoHarnessJob({ ...input, options: { strategyBriefSha256: "not-a-sha" } }),
    new RegExp(`^Error: ${STRATEGY_BRIEF_OPTION_INVALID_CODE}`, "u"),
  );

  // service の start（計画だけ）を通しても同じ値が Job に残る。
  const service = createVideoHarnessService({
    env: {},
    createJob: (args) => createVideoHarnessJob({ ...args, repoRoot: root }),
    projectCanvas: async () => {},
    planPreflight: async () => null,
    preflightReviewerTrust: async () => ({ ok: true, code: "", activeReviewers: 1, source: "fixture" }),
    captureRunLearning: null,
  });
  const started = await service.start({ ...input, options, confirmed: false });
  const job = await readVideoHarnessJob({ projectDir: root, jobId: started.jobId });
  assert.equal(job.options.strategyBriefSha256, sha256);
  assert.equal(started.jobId, withBrief.job.id);
});

test("start の --strategy-brief: 値が無い・ブリーフでない・--options-json の SHA と食い違うなら Job を作る前に止める", async (t) => {
  const root = tempRoot(t, "strategy-handoff-args-");
  const { briefPath, sha256 } = await passedBrief(root);
  assert.deepEqual(await strategyBriefStartOptions({}, { title: "x" }), { options: { title: "x" }, strategyBrief: null });
  await assert.rejects(strategyBriefStartOptions({ strategyBrief: true }, {}), /--strategy-brief には/u);
  await assert.rejects(strategyBriefStartOptions({ strategyBrief: briefPath }, { strategyBriefSha256: "0".repeat(64) }), /食い違|違う/u);
  assert.equal((await strategyBriefStartOptions({ strategyBrief: briefPath }, { strategyBriefSha256: sha256 })).options.strategyBriefSha256, sha256);
  const notBrief = path.join(root, "not-brief.json");
  fs.writeFileSync(notBrief, JSON.stringify({ version: "something-else" }));
  await assert.rejects(strategyBriefHandoff({ briefPath: notBrief }), { code: "strategy-brief-not-a-brief" });
  await assert.rejects(strategyBriefStartOptions({ strategyBrief: notBrief }, {}), { code: "strategy-brief-not-a-brief" });
});
