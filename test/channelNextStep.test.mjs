// plan-request の --channel（依頼の種類 → 次の工程の推奨と代案）の試験。チャンネル・台本・ブリーフ・会話 id は
// すべて合成で、端末の本物の配置表は読まない（台帳は試験で作ったものを渡す）。モデルも有料 API も呼ばない。
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createChannelPackEnvelope } from "../lib/channelPackEnvelope.mjs";
import { CHANNEL_INPUT_CONFLICT_CODE, validateChannelRegistry } from "../lib/channelRegistry.mjs";
import { REQUEST_KIND_UNKNOWN_CODE, decideRequestKind, requestKindQuestion } from "../lib/channelNextStep.mjs";
import { STRATEGY_BRIEF_OUTSIDE_CHANNEL_CODE } from "../lib/channelStrategyBrief.mjs";
import { strategySkillFingerprint } from "../lib/strategyBrief.mjs";
import { recordStrategyBriefRound, startStrategyBriefLoop } from "../lib/strategyBriefQualityLoop.mjs";
import { planVideoRequest } from "../lib/videoRequestPlan.mjs";
import { evidenceRow, jsonBytes, metricsOutput, sampleBrief, sha, writeJson } from "./helpers/strategyBriefFixture.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUEST_MARKER = "合成依頼マーカー四一二";
const QUESTION_MARKER = "合成の問いマーカー五九八";
const now = () => "2026-09-26T09:00:00.000Z";
const PASSING_SCORES = { "single-question": 92, "audience-specificity": 92, "promise-payoff": 92, "evidence-honesty": 92, "change-grounding": 92, producibility: 92 };
const FAILING_SCORES = { "single-question": 40, "audience-specificity": 40, "promise-payoff": 40, "evidence-honesty": 40, "change-grounding": 40, producibility: 40 };

function keyPair() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }),
  };
}

async function signedPack(root, id, harnessId, key) {
  const source = path.join(root, `${id}-pack-source`);
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "synthetic.json"), `${JSON.stringify({ fixture: id })}\n`);
  const outputDir = path.join(root, id, "pack");
  await createChannelPackEnvelope({ sourceDir: source, outputDir, id: `synthetic-${id}`, version: "1.0.0", harnessId, ...key, createdAt: "2026-09-25T00:00:00.000Z" });
  return outputDir;
}

async function createFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "channel-next-step-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = keyPair();
  const skillDir = path.join(root, "strategy-skill");
  fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "合成の戦略スキル\n");
  fs.writeFileSync(path.join(skillDir, "references", "a.md"), "合成の参照\n");
  const channels = [
    {
      id: "alpha",
      projectDir: path.join(root, "alpha", "project"),
      channelPack: await signedPack(root, "alpha", "narrated-story-video", key),
      production: { kind: "harness", harnessId: "narrated-story-video" },
      strategy: { workDir: path.join(root, "alpha", "strategy"), requireBrief: true, strategySkillDir: skillDir },
      scriptQuality: { genre: "narrated-story" },
    },
    {
      id: "beta",
      projectDir: path.join(root, "beta", "project"),
      channelPack: await signedPack(root, "beta", "koya-manga-video", key),
      production: { kind: "harness", harnessId: "koya-manga-video" },
      strategy: { workDir: path.join(root, "beta", "strategy"), requireBrief: false },
      scriptQuality: { genre: "manga" },
    },
    {
      id: "gamma",
      projectDir: path.join(root, "gamma", "project"),
      channelPack: path.join(root, "gamma", "pack"),
      production: { kind: "external", note: "合成: チャンネルの既存の書き出しの仕組み" },
      strategy: { workDir: path.join(root, "gamma", "strategy"), requireBrief: false },
    },
  ];
  for (const channel of channels) {
    fs.mkdirSync(channel.projectDir, { recursive: true });
    fs.mkdirSync(channel.strategy.workDir, { recursive: true });
  }
  const registry = {
    source: "test",
    channels: validateChannelRegistry({ channels }, { repoRoot: REPO_ROOT, harnessIds: ["koya-manga-video", "narrated-story-video"], genres: ["narrated-story", "manga", "explainer"] }),
  };
  const receiptsDir = path.join(root, "receipts");
  const evalsDir = path.join(root, "evals");
  fs.mkdirSync(receiptsDir);
  fs.mkdirSync(evalsDir);
  const script = path.join(root, "alpha", "project", "script.md");
  fs.writeFileSync(script, "# 本編\n合成の台本。\n");
  const env = { BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY_PEM: key.publicKeyPem };
  const plan = (overrides = {}) => planVideoRequest({ env, receiptsDir, skillEvalsDir: evalsDir, channelRegistry: registry, ...overrides });
  return { root, key, skillDir, registry, byId: Object.fromEntries(registry.channels.map((entry) => [entry.id, entry])), script, env, plan };
}

/** 作業フォルダにブリーフを書き、品質ループを回す。pass=false なら不合格の回を1回だけ記録する。 */
async function writeBrief(fixture, channelId, { pass = true, briefChannelId = channelId, label = "r1", loop = true, skillFingerprint = null, extra = {} } = {}) {
  const workDir = fixture.byId[channelId].strategy.workDir;
  const metrics = await writeJson(workDir, "evidence/metrics.json", metricsOutput());
  const brief = sampleBrief({
    label,
    channel: { id: briefChannelId, designVersion: "design-v1" },
    question: `${QUESTION_MARKER}: 合成の問い`,
    evidence: [evidenceRow(metrics, { id: "e-metrics", kind: "metrics", premiseBound: false, premiseIndependenceReason: "合成: 公開済みの動画の実測" })],
    changes: { previous: null, keep: [{ point: "合成の残す点", evidenceIds: ["e-metrics"] }], change: [] },
    ...(skillFingerprint ? { provenance: { host: "claude-code", contextId: "ctx-planner-1", createdAt: "2026-09-21T00:00:00Z", strategySkill: skillFingerprint } } : {}),
    ...extra,
  });
  const bytes = jsonBytes(brief);
  const briefPath = path.join(workDir, "brief.json");
  fs.writeFileSync(briefPath, bytes);
  if (loop) {
    await startStrategyBriefLoop({ workDir, generatorContextId: "ctx-planner-1", now });
    const review = await writeJson(workDir, "quality/reviews/r1.json", {
      evaluatorId: "evaluator",
      evaluatorContextId: "ctx-eval-1",
      evaluatorHost: "codex",
      briefSha256: sha(bytes),
      rubricScores: pass ? PASSING_SCORES : FAILING_SCORES,
      notes: "合成: ブリーフと根拠のファイルを開いて照合した",
      findings: [],
    });
    const recorded = await recordStrategyBriefRound({ workDir, briefPath: "brief.json", reviewPath: review.rel, now });
    assert.equal(recorded.state.status, pass ? "passed" : "active");
  }
  return { workDir, briefPath, sha256: sha(bytes), metricsPath: metrics.full };
}

function writeJob(fixture, channelId, { briefSha256, status = "completed", suffix = "0123456789abcdef" }) {
  const channel = fixture.byId[channelId];
  const jobId = `video-${channel.production.harnessId}-${suffix}`;
  const dir = path.join(channel.projectDir, "canvas", "harness-runs", jobId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({
    id: jobId,
    harness: { id: channel.production.harnessId },
    status,
    updatedAt: "2026-09-26T08:00:00.000Z",
    options: briefSha256 ? { strategyBriefSha256: briefSha256 } : {},
  }));
  return jobId;
}

test("依頼の種類: 7種類を手掛かりの語で決め、否定の節は減点し、決めきれなければ1問（2〜3択）", () => {
  const cases = [
    ["新しいチャンネルを設計したい", "new-design"],
    ["次の動画の企画をお願いします", "next-video"],
    ["この台本を添削してほしい", "script-review"],
    ["確定稿から動画を作って", "produce"],
    ["同じ内容で再レンダーして", "rerender"],
    ["公開後のアナリティクスから改善したい", "post-publish"],
    ["競合を調べるだけにして", "research"],
    ["再設計ではなく、次の動画を作りたい", "next-video"],
  ];
  for (const [request, kind] of cases) {
    const decision = decideRequestKind({ request });
    assert.equal(decision.status, "selected", `${request}: ${JSON.stringify(decision)}`);
    assert.equal(decision.kind, kind, request);
  }
  const negated = decideRequestKind({ request: "再設計ではなく、次の動画を作りたい" });
  assert.deepEqual(negated.candidates.find((row) => row.kind === "new-design").negatedTerms, ["再設計"]);

  // 両方に言及して点差が小さい → 1問。
  const narrow = decideRequestKind({ request: "台本を添削して、確定稿で制作に進みたい" });
  assert.equal(narrow.status, "choice-required");
  const question = requestKindQuestion(narrow);
  assert.equal(question.id, "request-kind");
  assert.deepEqual(question.options.map((option) => option.value).sort(), ["produce", "script-review"]);
  assert.ok(question.options.length >= 2 && question.options.length <= 3);
  assert.equal(question.allKinds.length, 7);
  // どれにも当たらない → 既定の3択。
  const none = decideRequestKind({ request: "よろしくお願いします" });
  assert.equal(none.status, "no-match");
  assert.deepEqual(requestKindQuestion(none).options.map((option) => option.value), ["next-video", "produce", "new-design"]);
  // 明示した種類はそのまま。宣言に無い種類は止める。
  assert.equal(decideRequestKind({ request: "よろしく", requestKind: "rerender" }).kind, "rerender");
  assert.throws(() => decideRequestKind({ requestKind: "synthetic-kind" }), { code: REQUEST_KIND_UNKNOWN_CODE });
});

test("ブリーフが無い: 次作・新規は hyp-design、制作は requireBrief で止めて hyp-design、調べるだけは hyp-research", async (t) => {
  const fixture = await createFixture(t);
  const next = await fixture.plan({ channelId: "alpha", request: `次の動画を作りたい ${REQUEST_MARKER}` });
  assert.equal(next.channel.id, "alpha");
  assert.equal(next.channel.selectedBy, "explicit");
  assert.equal(next.requestKind.kind, "next-video");
  assert.equal(next.input.strategyBrief.state, "none");
  assert.equal(next.workflow.recommended.id, "hyp-design");
  assert.equal(next.workflow.recommended.hypProcess, "新規設計");
  assert.equal(next.workflow.recommended.workDir, fixture.byId.alpha.strategy.workDir);
  assert.equal(next.workflow.recommended.produces.kind, "strategy-brief");
  assert.equal(next.workflow.recommended.strategySkill.fingerprint, (await strategySkillFingerprint(fixture.skillDir)).fingerprint);
  // 終わったら作業フォルダからブリーフを組み立てる（docs/strategy-handoff-spec-ja.md の 7）。
  const draft = next.workflow.recommended.then[0].cli;
  assert.ok(draft.startsWith(`node scripts/strategy-brief.mjs draft --from-hyp "${fixture.byId.alpha.strategy.workDir}" --channel alpha`), draft);
  assert.ok(draft.includes(`--strategy-skill-dir "${fixture.skillDir}"`), draft);
  assert.ok(draft.endsWith(`--out "${path.join(fixture.byId.alpha.strategy.workDir, "strategy-brief-r1.json")}"`), draft);
  assert.ok(!draft.includes("--previous"), "前のブリーフが無ければ --previous を付けない");
  assert.ok(next.workflow.recommended.then.some((entry) => !entry.cli && /needsAuthoring/u.test(entry.what)));
  assert.ok(next.workflow.recommended.then.some((entry) => entry.cli?.includes("strategy-brief.mjs start --work-dir")));
  assert.deepEqual(next.workflow.alternatives.map((entry) => entry.id), ["hyp-next-video"]);
  assert.equal(next.nextStep.action, "hyp-design");
  assert.equal(next.question, null);
  // 依頼文・ブリーフの文を写さない。
  assert.ok(!JSON.stringify(next).includes(REQUEST_MARKER));

  const design = await fixture.plan({ channelId: "alpha", request: "チャンネルを設計し直したい" });
  assert.equal(design.workflow.recommended.id, "hyp-design");

  const produce = await fixture.plan({ channelId: "alpha", request: "この台本で動画にして", scriptPath: fixture.script });
  assert.equal(produce.requestKind.kind, "produce");
  assert.equal(produce.workflow.recommended.id, "hyp-design");
  const blockedProduce = produce.workflow.alternatives.find((entry) => entry.id === "produce");
  assert.equal(blockedProduce.blocked.code, "channel-strategy-brief-required");
  const blocker = produce.decision.blockers.find((entry) => entry.code === "channel-strategy-brief-required");
  assert.equal(blocker.recommendedStep, "hyp-design");
  assert.equal(produce.decision.startable, false);

  const research = await fixture.plan({ channelId: "alpha", request: "競合を調べるだけにして" });
  assert.equal(research.workflow.recommended.id, "hyp-research");
  assert.equal(research.workflow.recommended.produces.kind, "research-files");

  const post = await fixture.plan({ channelId: "alpha", request: "公開後の数字から改善したい" });
  assert.equal(post.workflow.recommended.id, "hyp-post-publish");
  assert.ok(!post.workflow.recommended.then.some((entry) => entry.cli?.includes("strategy-brief.mjs next")), "前のブリーフが無いので next は出さない");
  assert.ok(post.workflow.recommended.then[0].cli.includes("strategy-brief.mjs draft --from-hyp"));

  const rerender = await fixture.plan({ channelId: "alpha", request: "同じ内容で再レンダーして" });
  assert.equal(rerender.workflow.recommended.id, "rerender");
  assert.equal(rerender.workflow.recommended.blocked.code, "channel-no-job");
});

test("合格したブリーフ: まだ作っていなければ reuse-brief、作った Job があれば hyp-next-video。制作は --channel とブリーフで start", async (t) => {
  const fixture = await createFixture(t);
  const fingerprint = await strategySkillFingerprint(fixture.skillDir);
  const brief = await writeBrief(fixture, "alpha", { skillFingerprint: { fingerprint: fingerprint.fingerprint, fileCount: fingerprint.fileCount } });

  const next = await fixture.plan({ channelId: "alpha", request: "次の動画の企画", scriptPath: fixture.script });
  assert.equal(next.input.strategyBrief.state, "passed");
  assert.equal(next.input.strategyBrief.source, "quality-loop");
  assert.equal(next.input.strategyBrief.path, brief.briefPath);
  assert.equal(next.workflow.recommended.id, "reuse-brief");
  const produceInReuse = next.workflow.recommended.then[0];
  assert.equal(produceInReuse.id, "produce");
  assert.ok(produceInReuse.cli.includes("--channel alpha"), produceInReuse.cli);
  assert.ok(produceInReuse.cli.includes(`--strategy-brief "${brief.briefPath}"`), produceInReuse.cli);
  assert.deepEqual(produceInReuse.mcp.arguments.channelId, "alpha");
  assert.equal(produceInReuse.mcp.arguments.strategyBriefPath, brief.briefPath);
  assert.equal(next.nextStep.action, "reuse-brief");
  assert.equal(next.nextStep.cli, produceInReuse.cli);
  assert.equal(next.channel.strategySkill.matches, true);
  assert.ok(!JSON.stringify(next).includes(QUESTION_MARKER), "ブリーフの文を写さない");

  const produce = await fixture.plan({ channelId: "alpha", request: "確定稿から動画を作って", scriptPath: fixture.script });
  assert.equal(produce.workflow.recommended.id, "produce");
  assert.equal(produce.decision.harnessId, "narrated-story-video");
  assert.equal(produce.decision.selectedBy, "explicit");
  assert.ok(!produce.decision.blockers.some((entry) => entry.code.startsWith("channel-strategy-brief")));

  const post = await fixture.plan({ channelId: "alpha", request: "公開後のアナリティクスを見て次へ" });
  assert.equal(post.workflow.recommended.id, "hyp-post-publish");
  assert.ok(post.workflow.recommended.then[0].cli.includes(`strategy-brief.mjs next --from "${brief.briefPath}"`));

  // このブリーフで作った Job がある → 前作のブリーフなので次作の工程。
  const jobId = writeJob(fixture, "alpha", { briefSha256: brief.sha256 });
  const used = await fixture.plan({ channelId: "alpha", request: "次の動画の企画" });
  assert.equal(used.workflow.recommended.id, "hyp-next-video");
  assert.equal(used.workflow.recommended.hypProcess, "次作");
  assert.match(used.workflow.recommended.reason, new RegExp(jobId, "u"));
  assert.deepEqual(used.workflow.alternatives.map((entry) => entry.id), ["hyp-post-publish", "reuse-brief"]);

  // 再レンダーは既存の Job の再開だけ。ブリーフが変わっていないことも出す。
  const rerender = await fixture.plan({ channelId: "alpha", request: "同じ内容で書き出し直して" });
  assert.equal(rerender.workflow.recommended.id, "rerender");
  assert.equal(rerender.workflow.recommended.jobs[0].jobId, jobId);
  assert.equal(rerender.workflow.recommended.jobs[0].strategyBrief, "unchanged");
  assert.ok(rerender.workflow.recommended.cli.includes(`resume --job-id ${jobId}`));
  assert.equal(rerender.workflow.recommended.mcp.tool, "resume_video_harness_job");

  // 戦略スキルの版が変わった → 注意に出す（黙って切り替えない）。
  fs.writeFileSync(path.join(fixture.skillDir, "references", "a.md"), "合成の参照（改訂）\n");
  const drifted = await fixture.plan({ channelId: "alpha", request: "次の動画の企画" });
  assert.ok(drifted.workflow.warnings.some((entry) => entry.code === "strategy-skill-fingerprint-changed"));
  assert.equal(drifted.channel.strategySkill.matches, false);
});

test("合格していない・根拠が合わない・別のチャンネルのブリーフ: 品質ループ・追加調査・新規設計を理由つきで推奨する", async (t) => {
  const fixture = await createFixture(t);
  // 不合格の回だけ → 企画の品質ループ。
  await writeBrief(fixture, "alpha", { pass: false });
  const review = await fixture.plan({ channelId: "alpha", request: "次の動画の企画" });
  assert.equal(review.input.strategyBrief.state, "needs-review");
  assert.equal(review.workflow.recommended.id, "strategy-brief-review");
  assert.ok(review.workflow.recommended.reasonCodes.some((code) => code.startsWith("strategy-brief-loop-not-passed")), review.workflow.recommended.reasonCodes.join(","));
  const produce = await fixture.plan({ channelId: "alpha", request: "確定稿から動画を作って" });
  assert.equal(produce.workflow.recommended.id, "strategy-brief-review");
  assert.equal(produce.decision.blockers.find((entry) => entry.code === "channel-strategy-brief-not-passed").recommendedStep, "strategy-brief-review");

  // 合格の後で根拠のファイルが変わった → 追加調査（どの根拠かを理由に出す）。
  const other = await createFixture(t);
  const passed = await writeBrief(other, "alpha");
  fs.writeFileSync(passed.metricsPath, jsonBytes({ ...metricsOutput(), row_count: 4 }));
  const research = await other.plan({ channelId: "alpha", request: "次の動画の企画" });
  assert.equal(research.input.strategyBrief.state, "needs-research");
  assert.equal(research.workflow.recommended.id, "hyp-additional-research");
  assert.deepEqual(research.workflow.recommended.gaps.map((gap) => [gap.evidenceId, gap.reasonCode]), [["e-metrics", "strategy-evidence-changed"]]);
  assert.match(research.workflow.recommended.reason, /e-metrics（strategy-evidence-changed）/u);

  // brief.channel.id が別のチャンネル → 使わない（新規設計）。
  const third = await createFixture(t);
  await writeBrief(third, "alpha", { briefChannelId: "synthetic-other-channel" });
  const mismatch = await third.plan({ channelId: "alpha", request: "次の動画の企画" });
  assert.equal(mismatch.input.strategyBrief.state, "unusable");
  assert.ok(mismatch.input.strategyBrief.reasonCodes.includes("strategy-brief-channel-mismatch"));
  assert.equal(mismatch.workflow.recommended.id, "hyp-design");

  // 合格していても、制作を止める未確認事項が open なら制作へ渡さず、確かめる工程へ回す。
  const fifth = await createFixture(t);
  await writeBrief(fifth, "alpha", {
    extra: { openQuestions: [{ id: "q-01", question: "合成の未確認事項", blocksProduction: true, plannedCheck: "合成の確かめ方" }] },
  });
  const blocking = await fifth.plan({ channelId: "alpha", request: "確定稿から動画を作って" });
  assert.equal(blocking.input.strategyBrief.state, "needs-research");
  assert.equal(blocking.workflow.recommended.id, "hyp-additional-research");
  assert.deepEqual(blocking.workflow.recommended.gaps.map((gap) => [gap.openQuestionId, gap.reasonCode]), [["q-01", "strategy-brief-open-question-blocks-production"]]);
  assert.equal(blocking.decision.blockers.find((entry) => entry.code === "channel-strategy-brief-not-passed").recommendedStep, "hyp-additional-research");

  // 明示のブリーフ（ループ前）→ 品質ループを始める。
  const fourth = await createFixture(t);
  const unlooped = await writeBrief(fourth, "alpha", { loop: false });
  const explicit = await fourth.plan({ channelId: "alpha", request: "次の動画の企画", strategyBriefPath: unlooped.briefPath });
  assert.equal(explicit.input.strategyBrief.source, "explicit");
  assert.equal(explicit.workflow.recommended.id, "strategy-brief-review");
  assert.ok(explicit.workflow.recommended.then.some((entry) => entry.cli?.includes("strategy-brief.mjs start --work-dir")));
});

test("作業フォルダの下書き strategy-brief-r<N>.json: まだ採点していない最新の下書きを今の作業として見つける", async (t) => {
  const fixture = await createFixture(t);
  const workDir = fixture.byId.alpha.strategy.workDir;
  // ループ前の下書き → 企画の品質ループへ（形の検査を通らない下書きなら、先に needsAuthoring を埋める）。
  fs.writeFileSync(path.join(workDir, "strategy-brief-r1.json"), jsonBytes({ ...sampleBrief({ channel: { id: "alpha", designVersion: "design-v1" } }), question: null }));
  const draft = await fixture.plan({ channelId: "alpha", request: "次の動画の企画" });
  assert.equal(draft.input.strategyBrief.source, "draft");
  assert.equal(draft.input.strategyBrief.path, path.join(workDir, "strategy-brief-r1.json"));
  assert.equal(draft.workflow.recommended.id, "strategy-brief-review");
  assert.match(draft.workflow.recommended.then[0].what, /needsAuthoring/u);
  fs.rmSync(path.join(workDir, "strategy-brief-r1.json"));

  // 合格した版のあとに新しい下書き r2 → r2 が今の作業。次の下書きの名前は r3。
  const passed = await writeBrief(fixture, "alpha");
  const r2 = path.join(workDir, "strategy-brief-r2.json");
  fs.writeFileSync(r2, jsonBytes(sampleBrief({ label: "r2", channel: { id: "alpha", designVersion: "design-v1" } })));
  const newer = await fixture.plan({ channelId: "alpha", request: "次の動画の企画" });
  assert.equal(newer.input.strategyBrief.source, "draft");
  assert.equal(newer.input.strategyBrief.path, r2);
  assert.equal(newer.input.strategyBrief.state, "needs-review");
  // 採点した版の下書き（同じ SHA）は今の作業に数えない。
  fs.rmSync(r2);
  fs.writeFileSync(path.join(workDir, "strategy-brief-r1.json"), fs.readFileSync(passed.briefPath));
  const reviewed = await fixture.plan({ channelId: "alpha", request: "次の動画の企画" });
  assert.equal(reviewed.input.strategyBrief.source, "quality-loop");
  assert.equal(reviewed.input.strategyBrief.state, "passed");
  const design = await fixture.plan({ channelId: "alpha", request: "チャンネルを設計し直したい" });
  assert.ok(design.workflow.recommended.then[0].cli.includes(`--previous "${passed.briefPath}"`), "前のブリーフを引き継ぐ");
  assert.ok(design.workflow.recommended.then[0].cli.endsWith(`--out "${path.join(workDir, "strategy-brief-r2.json")}"`));
});

test("前提を変えたブリーフ: 根拠の当てはまりの確認を先に記録し、当てはまらない根拠だけを取り直す", async (t) => {
  const fixture = await createFixture(t);
  const workDir = fixture.byId.alpha.strategy.workDir;
  const notes = await writeJson(workDir, "evidence/notes.json", { synthetic: "合成の調査メモ" });
  const metrics = await writeJson(workDir, "evidence/metrics.json", metricsOutput());
  const brief = sampleBrief({
    channel: { id: "alpha", designVersion: "design-v1" },
    evidence: [
      evidenceRow(metrics, { id: "e-metrics", kind: "metrics", premiseBound: false, premiseIndependenceReason: "合成: 公開済みの動画の実測" }),
      evidenceRow(notes, { id: "e-notes", kind: "other" }),
    ],
    changes: { previous: null, keep: [{ point: "合成の残す点", evidenceIds: ["e-metrics", "e-notes"] }], change: [] },
  });
  const bytes = jsonBytes(brief);
  const briefPath = path.join(workDir, "brief.json");
  fs.writeFileSync(briefPath, bytes);
  await startStrategyBriefLoop({ workDir, generatorContextId: "ctx-planner-1", now });
  const review = await writeJson(workDir, "quality/reviews/r1.json", {
    evaluatorId: "evaluator", evaluatorContextId: "ctx-eval-1", evaluatorHost: "codex", briefSha256: sha(bytes),
    rubricScores: PASSING_SCORES, notes: "合成: ブリーフと根拠のファイルを開いて照合した", findings: [],
  });
  assert.equal((await recordStrategyBriefRound({ workDir, briefPath: "brief.json", reviewPath: review.rel, now })).state.status, "passed");
  // 動画の問い（前提）を変える。
  fs.writeFileSync(briefPath, jsonBytes({ ...brief, question: "合成の別の問い: 店を継ぐ前に何を確かめるか" }));
  const result = await fixture.plan({ channelId: "alpha", request: "次の動画の企画" });
  assert.equal(result.input.strategyBrief.state, "needs-research");
  const step = result.workflow.recommended;
  assert.equal(step.id, "hyp-additional-research");
  assert.ok(step.gaps.some((gap) => gap.evidenceId === "e-notes" && gap.reasonCode.startsWith("strategy-evidence-applicability-review-required")), JSON.stringify(step.gaps));
  assert.ok(!step.gaps.some((gap) => gap.evidenceId === "e-metrics"), "前提に依らない根拠は確認しない");
  assert.ok(step.premiseChangedFields.includes("question"), JSON.stringify(step.premiseChangedFields));
  assert.ok(step.then[0].cli.includes(`strategy-brief.mjs applicability --brief "${briefPath}"`));
  assert.ok(step.then[1].cli.includes("--applies yes|no"));
  assert.match(step.reason, /e-notes（strategy-evidence-applicability-review-required/u);
});

test("台本の添削: 戦略スキルの添削から、チャンネルの台帳のジャンルと Pack の台本の品質ループへ", async (t) => {
  const fixture = await createFixture(t);
  const alpha = await fixture.plan({ channelId: "alpha", request: "この台本を添削して", scriptPath: fixture.script });
  const step = alpha.workflow.recommended;
  assert.equal(step.id, "hyp-script-review");
  assert.equal(step.hypProcess, "添削");
  assert.equal(step.scriptQuality.genre, "narrated-story");
  const start = step.then[0].cli;
  assert.ok(start.includes("script-quality-loop.mjs start"), start);
  assert.ok(start.includes("--genre narrated-story"), start);
  assert.ok(start.includes(`--channel-pack "${fixture.byId.alpha.channelPack}"`), start);
  assert.ok(start.includes(`--work-dir "${path.dirname(fixture.script)}"`), start);
  // 別のチャンネルは自分の台帳の設定だけ。
  const beta = await fixture.plan({ channelId: "beta", request: "この台本を添削して" });
  const betaStart = beta.workflow.recommended.then[0].cli;
  assert.ok(betaStart.includes("--genre manga"), betaStart);
  assert.ok(betaStart.includes(`--channel-pack "${fixture.byId.beta.channelPack}"`), betaStart);
  // 作業フォルダは start が Job の options.scriptQualityWorkDir に入れるのと同じ（明示があればそれ）。
  const loopDir = path.join(fixture.byId.alpha.projectDir, "episode-01");
  const explicitDir = await fixture.plan({ channelId: "alpha", request: "この台本を添削して", scriptPath: fixture.script, options: { scriptQualityWorkDir: loopDir } });
  assert.equal(explicitDir.workflow.recommended.scriptQuality.workDir, loopDir);
  assert.ok(explicitDir.workflow.recommended.then[0].cli.includes(`--work-dir "${loopDir}"`));
  // 相対の明示はチャンネルの作業フォルダから解く（start と同じ）。
  const relativeDir = await fixture.plan({ channelId: "alpha", request: "この台本を添削して", scriptPath: fixture.script, options: { scriptQualityWorkDir: "episode-01" } });
  assert.equal(relativeDir.workflow.recommended.scriptQuality.workDir, loopDir);
  const produce = await fixture.plan({ channelId: "alpha", request: "確定稿から動画を作って", scriptPath: fixture.script, options: { scriptQualityWorkDir: loopDir } });
  const produceStep = produce.workflow.alternatives.find((entry) => entry.id === "produce");
  assert.deepEqual(produceStep.scriptQuality, { genre: "narrated-story", workDir: loopDir });
  assert.ok(produceStep.cli.includes(`--script-quality-work-dir "${loopDir}"`), produceStep.cli);
  // 台帳に scriptQuality が無いハーネスのチャンネルは、制作のハーネスが問うジャンルを使う（別のチャンネルの設定ではない）。
  const bare = { ...fixture.registry, channels: fixture.registry.channels.map((entry) => (entry.id === "alpha" ? { ...entry, scriptQuality: undefined } : entry)) };
  const harnessGenre = await fixture.plan({ channelId: "alpha", request: "この台本を添削して", channelRegistry: bare });
  assert.equal(harnessGenre.workflow.recommended.scriptQuality.genre, "narrated-story");
  assert.equal(harnessGenre.workflow.recommended.scriptQuality.genreSource, "production-harness");
  // 台本の品質ループの設定が無く、制作も外部のチャンネルは、推測で埋めずに「台帳に無い」と言う。
  const gamma = await fixture.plan({ channelId: "gamma", request: "この台本を添削して" });
  assert.equal(gamma.workflow.recommended.scriptQuality.status, "not-configured");
  assert.ok(gamma.workflow.recommended.then[0].cli.includes("--genre <台帳の scriptQuality.genre>"));
});

test("外部の制作のチャンネル: ハーネスを選ばず「制作はチャンネルの既存の仕組みで行う」と明記する", async (t) => {
  const fixture = await createFixture(t);
  const produce = await fixture.plan({ channelId: "gamma", request: "確定稿から動画を作って" });
  assert.equal(produce.decision.status, "external-production");
  assert.equal(produce.decision.startable, false);
  assert.deepEqual(produce.candidates, []);
  assert.equal(produce.workflow.recommended.id, "produce");
  assert.equal(produce.workflow.recommended.production, "external");
  assert.match(produce.workflow.recommended.instructions, /制作はチャンネルの既存の仕組みで行う/u);
  assert.equal(produce.workflow.recommended.productionNote, "合成: チャンネルの既存の書き出しの仕組み");
  assert.ok(produce.summaryLines.some((line) => line.includes("制作はチャンネルの既存の仕組み")));
  const rerender = await fixture.plan({ channelId: "gamma", request: "同じ内容で再レンダーして" });
  assert.match(rerender.workflow.recommended.instructions, /既存の仕組み/u);
  assert.deepEqual(produce.channel.learning, []);
});

test("チャンネルの設定が混ざらない: Pack・台本の設定・学習の宛先・戦略の作業フォルダは台帳の値だけ", async (t) => {
  const fixture = await createFixture(t);
  const { alpha, beta } = fixture.byId;
  // 既定の Pack の探索を惑わせる環境（別のチャンネルの Pack・複数の channel-packs/）でも、台帳の値だけを使う。
  const saved = { id: process.env.BUZZASSIST_CHANNEL_PACK_ID, pack: process.env.BUZZASSIST_CHANNEL_PACK };
  process.env.BUZZASSIST_CHANNEL_PACK_ID = "synthetic-beta";
  process.env.BUZZASSIST_CHANNEL_PACK = beta.channelPack;
  t.after(() => {
    if (saved.id === undefined) delete process.env.BUZZASSIST_CHANNEL_PACK_ID; else process.env.BUZZASSIST_CHANNEL_PACK_ID = saved.id;
    if (saved.pack === undefined) delete process.env.BUZZASSIST_CHANNEL_PACK; else process.env.BUZZASSIST_CHANNEL_PACK = saved.pack;
  });
  for (const id of ["one", "two"]) fs.mkdirSync(path.join(alpha.projectDir, "channel-packs", id), { recursive: true });

  const result = await fixture.plan({ channelId: "alpha", request: "この台本を添削して", projectDir: beta.projectDir });
  const text = JSON.stringify(result);
  for (const value of [beta.projectDir, beta.channelPack, beta.strategy.workDir, "channel-pack:koya", "--genre manga"]) {
    assert.ok(!text.includes(value), `別のチャンネルの値が混ざった: ${value}`);
  }
  assert.equal(result.projectDir, alpha.projectDir);
  assert.equal(result.channel.channelPack, alpha.channelPack);
  assert.equal(result.input.channelPack.targetHarnessId, "narrated-story-video");
  assert.deepEqual(result.channel.learning.map((entry) => entry.target), ["channel-pack:narrated-story", "channel-pack:narrated-story-script"]);
  assert.equal(result.workflow.recommended.workDir, alpha.strategy.workDir);

  // 渡した値が台帳と食い違えば止める（黙ってどちらかを採らない）。
  await assert.rejects(fixture.plan({ channelId: "alpha", request: "次作", channelPackPath: beta.channelPack }), { code: CHANNEL_INPUT_CONFLICT_CODE });
  await assert.rejects(fixture.plan({ channelId: "alpha", request: "次作", harnessId: "koya-manga-video" }), { code: CHANNEL_INPUT_CONFLICT_CODE });
  const betaBrief = await writeBrief(fixture, "beta");
  await assert.rejects(fixture.plan({ channelId: "alpha", request: "次作", strategyBriefPath: betaBrief.briefPath }), { code: STRATEGY_BRIEF_OUTSIDE_CHANNEL_CODE });
  await assert.rejects(fixture.plan({ channelId: "synthetic-missing", request: "次作" }), { code: "channel-unknown" });

  // --channel が無くても、Pack が台帳のチャンネルに当たればそのチャンネルとして扱う。
  const inferred = await fixture.plan({ request: "次の動画の企画", channelPackPath: beta.channelPack });
  assert.equal(inferred.channel.id, "beta");
  assert.equal(inferred.channel.selectedBy, "channel-pack");
  assert.equal(inferred.decision.harnessId, "koya-manga-video");
  await assert.rejects(fixture.plan({ request: "次作", channelPackPath: beta.channelPack, projectDir: alpha.projectDir }), { code: CHANNEL_INPUT_CONFLICT_CODE });
  // 台帳に当たらない呼び出しは従来どおり（channel は null）。
  const legacy = await fixture.plan({ request: "感動する実話の朗読動画を作りたい" });
  assert.equal(legacy.channel, null);
  assert.equal(legacy.workflow, null);
  assert.equal(legacy.records.channelRegistry.status, "ok");
});

test("依頼の種類を決めきれないときは、チャンネルでも1問だけ返し、Job も工程も決めない", async (t) => {
  const fixture = await createFixture(t);
  const result = await fixture.plan({ channelId: "alpha", request: "台本を添削して、確定稿で制作に進みたい" });
  assert.equal(result.requestKind.status, "choice-required");
  assert.equal(result.workflow, null);
  assert.equal(result.question.id, "request-kind");
  assert.equal(result.nextStep.action, "ask");
  assert.equal(result.jobCreated, false);
  const answered = await fixture.plan({ channelId: "alpha", request: "台本を添削して、確定稿で制作に進みたい", requestKind: "script-review" });
  assert.equal(answered.requestKind.selectedBy, "explicit");
  assert.equal(answered.workflow.recommended.id, "hyp-script-review");
  // 依頼文が無くても種類を明示すれば計画できる（チャンネルのときだけ）。
  const kindOnly = await fixture.plan({ channelId: "alpha", requestKind: "research" });
  assert.equal(kindOnly.workflow.recommended.id, "hyp-research");
  await assert.rejects(fixture.plan({ requestKind: "research" }), { code: "video-request-missing" });
});
