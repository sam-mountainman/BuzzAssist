import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createReviewerTrustEntry, generateReviewerKeyPair } from "../lib/koyaReviewAttestation.mjs";
import {
  VIDEO_HARNESS_SERVICE_RESULT_VERSION,
  assertReviewerTrustPathAgreesWithOperator,
  createVideoHarnessService,
} from "../lib/videoHarnessService.mjs";

function trustListJson(label, { status = "active" } = {}) {
  const pair = generateReviewerKeyPair();
  const entry = createReviewerTrustEntry({ publicKeyPem: pair.publicKeyPem, label });
  const reviewer = status === "revoked"
    ? { ...entry, status: "revoked", revokedAt: "2026-09-01T00:00:00.000Z", reason: "fixture revoked" }
    : entry;
  return JSON.stringify({ version: "koya-reviewer-trust-v1", reviewers: [reviewer] });
}

async function writeTrustList(file, label) {
  await writeFile(file, trustListJson(label));
  return file;
}

// 既定の fixture runtime は「運営者が信頼リストを配った host」。R6-1 以降、confirmed start / resume は
// 有料 adapter 起動前にこれを確かめるので、無設定 host を試すテストは env を明示的に上書きする。
const OPERATOR_ENV = Object.freeze({ BUZZASSIST_REVIEWER_TRUST_JSON: trustListJson("fixture-operator") });

/** 運営者 env の信頼リスト、その同一内容の写し、別鍵だけの自作リストを用意する。 */
async function trustFixtures(t) {
  const dir = await mkdtemp(join(tmpdir(), "video-service-trust-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const operator = await writeTrustList(join(dir, "operator-trust.json"), "operator");
  const selfMinted = await writeTrustList(join(dir, "self-minted.json"), "self-minted");
  const operatorCopy = join(dir, "operator-copy.json");
  await writeFile(operatorCopy, await readFile(operator));
  return { dir, operator, operatorCopy, selfMinted };
}

function fixtureJob(overrides = {}) {
  return {
    id: "video-fixture-0123456789abcdef",
    status: "planned",
    projectDir: "/tmp/video-service-project",
    updatedAt: "2026-09-01T00:00:00.000Z",
    harness: { id: "fixture-harness" },
    blockers: [],
    knownRemainingIssues: [],
    ...overrides,
  };
}

function runtimeFixture(overrides = {}) {
  return {
    createJob: async () => ({ job: fixtureJob(), attached: false }),
    readJob: async ({ jobId }) => fixtureJob({ id: jobId }),
    cancelJob: async ({ jobId }) => fixtureJob({ id: jobId, status: "cancel-requested" }),
    runJob: async ({ jobId }) => fixtureJob({ id: jobId, status: "completed" }),
    withJobLock: async (_lock, action) => action(),
    prepare: async () => ({ ok: true }),
    doctor: async () => ({ ready: true }),
    adapter: async () => ({ status: "completed", knownRemainingIssues: [] }),
    projectCanvas: async () => ({ ok: true }),
    productionProfile: async () => ({ profileId: "operator-production" }),
    readDirectory: async () => [],
    env: OPERATOR_ENV,
    // 既定の学習捕捉は実リポジトリの台帳へ書くので、fixture では必ず差し替える。
    captureRunLearning: async () => null,
    ...overrides,
  };
}

test("start defaults to plan-only, requires Channel Pack, and never reaches the paid runner", async () => {
  const calls = [];
  const service = createVideoHarnessService(runtimeFixture({
    createJob: async (input) => {
      calls.push(["create", input]);
      return { job: fixtureJob({ projectDir: input.projectDir }), attached: false };
    },
    runJob: async () => {
      calls.push(["run"]);
      return fixtureJob({ status: "completed" });
    },
    projectCanvas: async (job) => { calls.push(["project", job.status]); },
  }));

  await assert.rejects(
    () => service.start({ projectDir: "/tmp/video-service-project", scriptPath: "script.txt" }),
    /Channel Pack/u,
  );
  const result = await service.start({
    projectDir: "/tmp/video-service-project",
    scriptPath: "script.txt",
    channelPackPath: "channel-pack",
    harnessId: "fixture-harness",
  });

  assert.equal(result.version, VIDEO_HARNESS_SERVICE_RESULT_VERSION);
  assert.equal(result.operation, "start");
  assert.equal(result.status, "planned");
  assert.deepEqual(result.execution, { mode: "plan-only", confirmed: false, started: false, planOnly: true });
  assert.deepEqual(calls.map(([kind]) => kind), ["create", "project"]);
  assert.equal(calls[0][1].scriptPath, resolve("script.txt"));
  assert.equal(calls[0][1].channelPackPath, resolve("channel-pack"));
});

test("confirmed start and resume use one injected execution composition", async () => {
  const executions = [];
  const service = createVideoHarnessService(runtimeFixture({
    withJobLock: async (lock, action) => {
      executions.push({ kind: "lock", lock });
      return action();
    },
    runJob: async (input) => {
      executions.push({ kind: "run", input });
      assert.equal(typeof input.prepare, "function");
      assert.equal(typeof input.doctor, "function");
      assert.equal(typeof input.adapter, "function");
      assert.equal(typeof input.projectCanvas, "function");
      return fixtureJob({ id: input.jobId, status: "completed" });
    },
  }));

  const started = await service.start({
    projectDir: "/tmp/video-service-project",
    scriptPath: "script.txt",
    channelPackPath: "channel-pack",
    confirmed: true,
  });
  assert.deepEqual(started.execution, { mode: "execute", confirmed: true, started: true, planOnly: false });
  assert.equal(started.status, "completed");

  await assert.rejects(
    () => service.resume({ projectDir: "/tmp/video-service-project", jobId: started.jobId }),
    /confirmed=true/u,
  );
  const resumed = await service.resume({
    projectDir: "/tmp/video-service-project",
    jobId: started.jobId,
    confirmed: true,
  });
  assert.equal(resumed.operation, "resume");
  assert.equal(resumed.status, "completed");
  assert.equal(executions.filter((entry) => entry.kind === "run").length, 2);
});

test("secret-bearing options fail before durable creation and public results redact legacy secret fields", async () => {
  let creates = 0;
  const service = createVideoHarnessService(runtimeFixture({
    createJob: async () => { creates += 1; return { job: fixtureJob(), attached: false }; },
    readJob: async ({ jobId }) => fixtureJob({
      id: jobId,
      options: { title: "safe", apiKey: "must-not-leak" },
      adapterResult: { token: "must-not-leak", output: "safe", note: "upstream echoed must-not-leak" },
    }),
  }));

  await assert.rejects(
    () => service.start({
      projectDir: "/tmp/video-service-project",
      scriptPath: "script.txt",
      channelPackPath: "channel-pack",
      options: { nested: { channelTrustedKey: "must-not-store" } },
    }),
    /秘密フィールド/u,
  );
  assert.equal(creates, 0);

  const result = await service.get({ projectDir: "/tmp/video-service-project", jobId: "video-fixture-0123456789abcdef" });
  assert.deepEqual(result.job.options, { title: "safe" });
  assert.deepEqual(result.job.adapterResult, { output: "safe", note: "upstream echoed [redacted]" });
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak/u);
});

test("production profile is enforced before plan projection and before resume execution", async () => {
  let runs = 0;
  let projections = 0;
  const service = createVideoHarnessService(runtimeFixture({
    productionProfile: async () => { throw new Error("development-only profile is forbidden"); },
    runJob: async () => { runs += 1; return fixtureJob({ status: "completed" }); },
    projectCanvas: async () => { projections += 1; },
  }));
  await assert.rejects(
    service.start({
      projectDir: "/tmp/video-service-project",
      scriptPath: "script.txt",
      channelPackPath: "channel-pack",
    }),
    /development-only profile/u,
  );
  await assert.rejects(
    service.resume({
      projectDir: "/tmp/video-service-project",
      jobId: "video-fixture-0123456789abcdef",
      confirmed: true,
    }),
    /development-only profile/u,
  );
  assert.equal(runs, 0);
  assert.equal(projections, 0);
});

test("get, list, and cancel share the same stable result envelope", async () => {
  const projected = [];
  const service = createVideoHarnessService(runtimeFixture({
    readDirectory: async () => [
      { name: "not-a-job", isDirectory: () => true },
      { name: "video-b-0123456789abcdef", isDirectory: () => true },
      { name: "video-a-0123456789abcdef", isDirectory: () => true },
    ],
    readJob: async ({ jobId }) => fixtureJob({ id: jobId }),
    projectCanvas: async (job) => { projected.push(job.status); },
  }));

  const get = await service.get({ projectDir: "/tmp/video-service-project", jobId: "video-a-0123456789abcdef" });
  const list = await service.list({ projectDir: "/tmp/video-service-project" });
  const cancel = await service.cancel({ projectDir: "/tmp/video-service-project", jobId: "video-a-0123456789abcdef" });
  const keys = Object.keys(get).sort();
  assert.deepEqual(Object.keys(list).sort(), keys);
  assert.deepEqual(Object.keys(cancel).sort(), keys);
  assert.equal(list.job, null);
  assert.deepEqual(list.jobs.map((job) => job.id), ["video-b-0123456789abcdef", "video-a-0123456789abcdef"]);
  assert.equal(cancel.status, "cancel-requested");
  assert.deepEqual(projected, ["cancel-requested"]);
});

test("start/resume pass an operator-matching reviewerTrustPath (path only) to the execution and to the adapter context, and reject trust-list or key bodies", async (t) => {
  const { operator, operatorCopy } = await trustFixtures(t);
  const runs = [];
  const adapterContexts = [];
  const service = createVideoHarnessService(runtimeFixture({
    env: { BUZZASSIST_REVIEWER_TRUST: operator },
    createJob: async (input) => {
      assert.equal(input.options.reviewerTrustPath, undefined, "実行時引数の path は Job identity(options) に混ぜない");
      return { job: fixtureJob(), attached: false };
    },
    adapter: async (context) => { adapterContexts.push(context); return { status: "completed", knownRemainingIssues: [] }; },
    runJob: async (input) => {
      runs.push(input);
      await input.adapter({ job: fixtureJob({ id: input.jobId }), prepareResult: { ok: true } });
      return fixtureJob({ id: input.jobId, status: "completed" });
    },
  }));
  await service.start({
    projectDir: "/tmp/video-service-project",
    scriptPath: "script.txt",
    channelPackPath: "channel-pack",
    confirmed: true,
    reviewerTrustPath: operatorCopy,
  });
  assert.equal(runs[0].reviewerTrustPath, operatorCopy, "env と同一内容の写しは照合を通り Job 層へ届く");
  assert.equal(adapterContexts[0].reviewerTrustPath, operatorCopy, "照合済み path は adapter context にも載り、子 CLI へ同じ信頼リストが渡る（F-3）");
  assert.equal(adapterContexts[0].prepareResult.ok, true, "既存の adapter context は保たれる");

  await service.resume({ projectDir: "/tmp/video-service-project", jobId: "video-fixture-0123456789abcdef", confirmed: true });
  assert.equal("reviewerTrustPath" in runs[1], false, "未指定なら runJob へ空文字を渡さず、実行側の env に委ねる");
  assert.equal("reviewerTrustPath" in adapterContexts[1], false, "未指定なら adapter context にも載せない");

  await service.resume({
    projectDir: "/tmp/video-service-project",
    jobId: "video-fixture-0123456789abcdef",
    confirmed: true,
    reviewerTrustPath: operator,
  });
  assert.equal(runs[2].reviewerTrustPath, operator);

  for (const body of [
    '{"version":"koya-reviewer-trust-v1","reviewers":[]}',
    "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
  ]) {
    await assert.rejects(
      () => service.resume({ projectDir: "/tmp/video-service-project", jobId: "video-fixture-0123456789abcdef", confirmed: true, reviewerTrustPath: body }),
      /path だけを渡す/u,
    );
  }
  assert.equal(runs.length, 3);
  // R4-1: 要求側が Job options で信頼アンカーの置き場所を決めることはできない（createJob に到達しない）。
  for (const options of [
    { reviewerTrustPath: "/attacker/self-minted-trust.json" },
    { reviewerTrustJson: "{}" },
    { koya: { reviewer_trust: "/x.json" } },
  ]) {
    await assert.rejects(
      () => service.start({
        projectDir: "/tmp/video-service-project",
        scriptPath: "script.txt",
        channelPackPath: "channel-pack",
        options,
      }),
      /^Error: reviewer-trust-path-in-options: options\./u,
    );
  }
  assert.equal(runs.length, 3, "拒否された start は runJob に到達しない");
});

test("the operator env is the only trust anchor: an explicit reviewerTrustPath is a cross-check (conflict) and never stands alone (unconfigured)", async (t) => {
  const { operator, operatorCopy, selfMinted } = await trustFixtures(t);
  let creates = 0;
  let runs = 0;
  const build = (env) => createVideoHarnessService(runtimeFixture({
    env,
    createJob: async () => { creates += 1; return { job: fixtureJob(), attached: false }; },
    runJob: async ({ jobId }) => { runs += 1; return fixtureJob({ id: jobId, status: "completed" }); },
  }));
  const startArgs = { projectDir: "/tmp/video-service-project", scriptPath: "script.txt", channelPackPath: "channel-pack", confirmed: true };
  const resumeArgs = { projectDir: "/tmp/video-service-project", jobId: "video-fixture-0123456789abcdef", confirmed: true };

  // env 未設定 + 明示 path → reviewer-trust-unconfigured（要求側の入力だけで信頼アンカーは立たない。R5-1）。
  const unconfigured = build({});
  await assert.rejects(unconfigured.start({ ...startArgs, reviewerTrustPath: selfMinted }), /^Error: reviewer-trust-unconfigured:/u);
  await assert.rejects(unconfigured.start({ ...startArgs, confirmed: false, reviewerTrustPath: operator }), /^Error: reviewer-trust-unconfigured:/u, "plan-only でも照合用 path は env 無しでは受けない");
  await assert.rejects(unconfigured.resume({ ...resumeArgs, reviewerTrustPath: operator }), /^Error: reviewer-trust-unconfigured:/u);
  assert.equal(creates, 0, "durable Job を作る前に止まる");
  assert.equal(runs, 0);
  // R6-1: env 未設定 + path 無しも service で止める（以前は Job 層の Receipt 確定まで有料生成が丸ごと走っていた）。
  await assert.rejects(unconfigured.resume(resumeArgs), /^Error: reviewer-trust-unconfigured:/u);
  assert.equal(runs, 0);

  // env 設定あり + 別内容 → reviewer-trust-conflict。旧 env 名でも同じ。
  for (const env of [{ BUZZASSIST_REVIEWER_TRUST: operator }, { BUZZASSIST_KOYA_REVIEWER_TRUST: operator }]) {
    const configured = build(env);
    await assert.rejects(configured.start({ ...startArgs, reviewerTrustPath: selfMinted }), /^Error: reviewer-trust-conflict:/u);
    await assert.rejects(configured.resume({ ...resumeArgs, reviewerTrustPath: selfMinted }), /^Error: reviewer-trust-conflict:/u);
    await configured.resume({ ...resumeArgs, reviewerTrustPath: operatorCopy });
  }
  assert.equal(creates, 0);
  assert.equal(runs, 2);

  // 新旧 env の食い違いは env-ambiguous で fail-closed（どちらが効いているか分からない状態を通さない）。
  const ambiguous = build({ BUZZASSIST_REVIEWER_TRUST: operator, BUZZASSIST_KOYA_REVIEWER_TRUST: selfMinted });
  await assert.rejects(ambiguous.resume({ ...resumeArgs, reviewerTrustPath: operatorCopy }), /env-ambiguous/u);
  // inline JSON の env も同じ照合を受ける。
  const inline = build({ BUZZASSIST_REVIEWER_TRUST_JSON: await readFile(operator, "utf8") });
  await inline.resume({ ...resumeArgs, reviewerTrustPath: operatorCopy });
  await assert.rejects(inline.resume({ ...resumeArgs, reviewerTrustPath: selfMinted }), /^Error: reviewer-trust-conflict:/u);

  // 共有 helper 単体（MCP reviewer 工程も同じ関数を使う）。
  assert.equal(await assertReviewerTrustPathAgreesWithOperator({ reviewerTrustPath: "", env: {} }), null);
  await assert.rejects(assertReviewerTrustPathAgreesWithOperator({ reviewerTrustPath: operator, env: {} }), /^Error: reviewer-trust-unconfigured:/u);
  const matched = await assertReviewerTrustPathAgreesWithOperator({ reviewerTrustPath: operatorCopy, env: { BUZZASSIST_REVIEWER_TRUST: operator } });
  assert.match(matched.sha256, /^[a-f0-9]{64}$/u);
});

test("F-6: reviewer key material or key paths never enter a production Job's options", async () => {
  let creates = 0;
  const service = createVideoHarnessService(runtimeFixture({
    createJob: async () => { creates += 1; return { job: fixtureJob(), attached: false }; },
  }));
  const startArgs = { projectDir: "/tmp/video-service-project", scriptPath: "script.txt", channelPackPath: "channel-pack" };
  for (const options of [
    { reviewerPrivateKeyPem: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" },
    { reviewerKeyPath: "/secure/reviewer-ed25519.pem" },
    { reviewerPublicKeyPath: "/secure/reviewer-ed25519.pem.pub" },
    { koya: { signoff: { reviewer_key_path: "/secure/k.pem" } } },
    { nested: { anythingPem: "x" } },
  ]) {
    await assert.rejects(service.start({ ...startArgs, options }), /^Error: reviewer-key-in-options: options\./u, JSON.stringify(options));
  }
  // 名前が無害でも中身が鍵／信頼リストなら拒否する。
  await assert.rejects(
    service.start({ ...startArgs, options: { note: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" } }),
    /^Error: reviewer-key-in-options: options\.note/u,
  );
  await assert.rejects(
    service.start({ ...startArgs, options: { note: '{"version":"koya-reviewer-trust-v1","reviewers": [ ]}' } }),
    /^Error: reviewer-key-in-options: options\.note/u,
  );
  assert.equal(creates, 0, "拒否された options は durable Job にならない");
  // 無害な path option は通る。
  const planned = await service.start({ ...startArgs, options: { characterBiblePath: "/tmp/bible.json", storyReviewPath: "/tmp/review.json", episodeId: "ep" } });
  assert.equal(planned.execution.planOnly, true);
  assert.equal(creates, 1);
});

test("R6-1: an unconfigured, ambiguous, or all-revoked trust anchor stops confirmed start/resume before any Job or paid adapter; plan-only only warns", async (t) => {
  const { operator, selfMinted } = await trustFixtures(t);
  const build = (env) => {
    const calls = { create: 0, run: 0, adapter: 0, doctor: 0 };
    const service = createVideoHarnessService(runtimeFixture({
      env,
      createJob: async () => { calls.create += 1; return { job: fixtureJob(), attached: false }; },
      doctor: async () => { calls.doctor += 1; return { ready: true }; },
      adapter: async () => { calls.adapter += 1; return { status: "completed", knownRemainingIssues: [] }; },
      runJob: async (input) => {
        calls.run += 1;
        await input.doctor({});
        await input.adapter({ job: fixtureJob({ id: input.jobId }) });
        return fixtureJob({ id: input.jobId, status: "completed" });
      },
    }));
    return { service, calls };
  };
  const startArgs = { projectDir: "/tmp/video-service-project", scriptPath: "script.txt", channelPackPath: "channel-pack", confirmed: true };
  const resumeArgs = { projectDir: "/tmp/video-service-project", jobId: "video-fixture-0123456789abcdef", confirmed: true };

  const cases = [
    { name: "env 未設定", env: {}, code: /^Error: reviewer-trust-unconfigured:/u },
    { name: "新旧 env 不一致", env: { BUZZASSIST_REVIEWER_TRUST: operator, BUZZASSIST_KOYA_REVIEWER_TRUST: selfMinted }, code: /^Error: reviewer-trust-invalid:env-ambiguous:path:/u },
    { name: "path は設定されているが読めない", env: { BUZZASSIST_REVIEWER_TRUST: `${operator}.missing` }, code: /^Error: reviewer-trust-unreadable:/u },
    { name: "全件 revoked", env: { BUZZASSIST_REVIEWER_TRUST_JSON: trustListJson("retired", { status: "revoked" }) }, code: /^Error: reviewer-trust-invalid:no-active-reviewers:/u },
  ];
  for (const entry of cases) {
    const { service, calls } = build(entry.env);
    await assert.rejects(service.start(startArgs), entry.code, `${entry.name}: confirmed start`);
    await assert.rejects(service.resume(resumeArgs), entry.code, `${entry.name}: resume`);
    assert.deepEqual(calls, { create: 0, run: 0, adapter: 0, doctor: 0 }, `${entry.name}: Job を作らず、doctor も有料 adapter も一度も呼ばれない`);
    // 拒否理由に path 文字列を載せない（例外文は durable Job・ログへそのまま残る）。
    await service.start(startArgs).catch((error) => assert.ok(!error.message.includes(operator), `${entry.name}: path を漏らさない`));

    // plan-only は有料へ進まないので Job を作り、警告として結果へ載せる。
    const planned = await service.start({ ...startArgs, confirmed: false });
    assert.equal(planned.execution.planOnly, true, `${entry.name}: plan-only は通る`);
    assert.equal(planned.reviewerTrust.ok, false);
    assert.match(planned.reviewerTrust.code, /^reviewer-trust-/u);
    assert.match(planned.note, /警告 reviewer-trust-/u);
    assert.equal(planned.jobId, "video-fixture-0123456789abcdef");
    assert.deepEqual(calls, { create: 1, run: 0, adapter: 0, doctor: 0 }, `${entry.name}: plan-only は Job だけ作る`);
  }

  // 整った host: preflight を通り、結果に active 鍵数と出所が残る。
  const ready = build({ BUZZASSIST_REVIEWER_TRUST: operator });
  const started = await ready.service.start(startArgs);
  assert.deepEqual(started.reviewerTrust, { ok: true, code: "", activeReviewers: 1, source: "path" });
  const resumed = await ready.service.resume(resumeArgs);
  assert.deepEqual(resumed.reviewerTrust, { ok: true, code: "", activeReviewers: 1, source: "path" });
  assert.deepEqual(ready.calls, { create: 1, run: 2, adapter: 2, doctor: 2 });
  const planned = await ready.service.start({ ...startArgs, confirmed: false });
  assert.equal(planned.reviewerTrust.ok, true);
  assert.doesNotMatch(planned.note, /警告/u);
});


test("resume の retryFailedImages は adapter context にだけ載り、Job identity(options) と runJob には混ぜない", async () => {
  // 画像の失敗分だけを同じ Job のまま作り直す（3-18）。options に入れると jobId の指紋が
  // 変わって別 Job＝完成済み画像の全額払い直しになるので、reviewerTrustPath と同じ
  // 実行文脈の経路で子へ渡す。
  const runs = [];
  const adapterContexts = [];
  const service = createVideoHarnessService(runtimeFixture({
    runJob: async (input) => {
      runs.push(input);
      await input.adapter({ job: fixtureJob({ id: input.jobId }), prepareResult: {} });
      return fixtureJob({ id: input.jobId, status: "completed" });
    },
    adapter: async (context) => { adapterContexts.push(context); return { status: "completed", knownRemainingIssues: [] }; },
  }));

  await service.resume({ projectDir: "/tmp/video-service-project", jobId: "video-fixture-0123456789abcdef", confirmed: true, retryFailedImages: true });
  assert.equal(adapterContexts[0].retryFailedImages, true, "adapter context には載る");
  assert.equal("retryFailedImages" in runs[0], false, "runJob（Job 層）には渡さない");
  assert.equal(runs[0].options, undefined, "resume は options を作らない（identity を変えない）");

  await service.resume({ projectDir: "/tmp/video-service-project", jobId: "video-fixture-0123456789abcdef", confirmed: true });
  assert.equal("retryFailedImages" in adapterContexts[1], false, "指定が無ければ context にも載せない");
});

test("決着した Job の学習捕捉は結果に件数だけを載せ、失敗しても Job の結果を変えない", async () => {
  const calls = [];
  const service = createVideoHarnessService(runtimeFixture({
    runJob: async ({ jobId }) => fixtureJob({ id: jobId, status: "failed", knownRemainingIssues: ["final-audit: x"] }),
    captureRunLearning: async ({ job, env }) => {
      calls.push({ status: job.status, env });
      return { captured: 2, duplicates: 0, candidates: 2, target: "channel-pack:fixture" };
    },
  }));
  const resumed = await service.resume({ projectDir: "/tmp/video-service-project", jobId: "video-fixture-0123456789abcdef", confirmed: true });
  assert.equal(resumed.status, "failed");
  assert.deepEqual(calls.map((call) => call.status), ["failed"]);
  assert.equal(calls[0].env, OPERATOR_ENV, "運営者の環境（子エージェントの印を含む）をそのまま渡す");
  assert.equal(resumed.learningCapture.captured, 2);

  const failing = createVideoHarnessService(runtimeFixture({
    runJob: async ({ jobId }) => fixtureJob({ id: jobId, status: "completed" }),
    captureRunLearning: async () => { throw new Error("台帳を書けない sk-proj-" + "x".repeat(24)); },
  }));
  const completed = await failing.resume({ projectDir: "/tmp/video-service-project", jobId: "video-fixture-0123456789abcdef", confirmed: true });
  assert.equal(completed.status, "completed", "捕捉の失敗で制作の結果を変えない");
  assert.equal(completed.learningCapture.skippedReason, "capture-error");
  assert.equal(completed.learningCapture.detail.includes("x".repeat(24)), false, "秘密らしい値を結果へ写さない");

  // plan-only の start は有料処理へ進まないので、学習捕捉もしない。
  const planned = await failing.start({ projectDir: "/tmp/video-service-project", scriptPath: "/tmp/script.txt", channelPackPath: "/tmp/pack" });
  assert.equal(planned.learningCapture, undefined);
});

test("plan-only start reports the read-only preflight blockers without running doctor or the paid adapter", async () => {
  const calls = [];
  const service = createVideoHarnessService(runtimeFixture({
    createJob: async (input) => ({ job: fixtureJob({ projectDir: input.projectDir, harness: { id: "narrated-story-video" } }), attached: false }),
    planPreflight: async (input) => {
      calls.push(["preflight", input.scriptPath, input.channelPackPath]);
      return { ok: false, blockers: ["channel-pack-declared-blocker:fixture"], paidCallsAttempted: false };
    },
    runJob: async () => { calls.push(["run"]); return fixtureJob({ status: "completed" }); },
    doctor: async () => { calls.push(["doctor"]); return { ready: true }; },
    adapter: async () => { calls.push(["adapter"]); return { status: "completed" }; },
  }));
  const result = await service.start({
    projectDir: "/tmp/video-service-project",
    scriptPath: "script.txt",
    channelPackPath: "channel-pack",
    harnessId: "narrated-story-video",
  });
  assert.equal(result.execution.planOnly, true);
  assert.deepEqual(result.preflight.blockers, ["channel-pack-declared-blocker:fixture"]);
  assert.match(result.note, /有料前 preflight で 1 件/u);
  assert.deepEqual(calls, [["preflight", resolve("script.txt"), resolve("channel-pack")]]);
  // 検査を持たないハーネス・検査が例外を投げた場合も plan は保存され、結果は壊れない。
  const plain = await createVideoHarnessService(runtimeFixture()).start({
    projectDir: "/tmp/video-service-project", scriptPath: "script.txt", channelPackPath: "channel-pack", harnessId: "fixture-harness",
  });
  assert.equal("preflight" in plain, false);
  const thrown = await createVideoHarnessService(runtimeFixture({
    planPreflight: async () => { throw new Error("boom"); },
  })).start({ projectDir: "/tmp/video-service-project", scriptPath: "script.txt", channelPackPath: "channel-pack" });
  assert.deepEqual(thrown.preflight.blockers, ["plan-preflight-failed"]);
  assert.equal(thrown.status, "planned");
});

test("Koya の start は、後から足せない必須引数が欠けていれば Job を作らずに名指しして止める（plan-only でも）", async () => {
  const calls = [];
  const service = createVideoHarnessService(runtimeFixture({
    createJob: async (input) => {
      calls.push(["create", input.harnessId]);
      return { job: fixtureJob({ projectDir: input.projectDir, harness: { id: "koya-manga-video" } }), attached: false };
    },
    runJob: async () => { calls.push(["run"]); return fixtureJob({ status: "completed" }); },
    projectCanvas: async () => { calls.push(["project"]); },
    planPreflight: async () => null,
  }));
  const base = { projectDir: "/tmp/video-service-project", scriptPath: "script.txt", channelPackPath: "channel-pack", harnessId: "koya-manga-video" };
  const complete = {
    episodeId: "manga-fixture-001",
    protagonistSpeakerId: "fixture-lead",
    characterBiblePath: "/tmp/fixture-character-bible.json",
    storyReviewPath: "/tmp/fixture-story-review.json",
  };
  for (const confirmed of [false, true]) {
    for (const omitted of Object.keys(complete)) {
      const options = { ...complete };
      delete options[omitted];
      await assert.rejects(
        () => service.start({ ...base, options, confirmed }),
        (error) => {
          assert.equal(error.code, "koya-start-options-missing");
          assert.deepEqual(error.missingOptions.map((entry) => entry.key), [omitted]);
          const flag = `--${omitted.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`;
          assert.ok(error.message.includes(flag), `${omitted}: CLI の旗 ${flag} を名指しすること`);
          assert.ok(error.message.includes(`options.${omitted}`), `${omitted}: MCP の引数名も名指しすること`);
          assert.match(error.message, /Job は作っていない/u);
          return true;
        },
      );
    }
    // 全部欠けていれば全部を1回で言う（1つ直すたびに次が出る往復をさせない）。
    await assert.rejects(
      () => service.start({ ...base, options: {}, confirmed }),
      (error) => error.missingOptions.length === 4,
    );
    // 空白だけの値は欠けているのと同じ。
    await assert.rejects(
      () => service.start({ ...base, options: { ...complete, storyReviewPath: "   " }, confirmed }),
      (error) => error.missingOptions[0].key === "storyReviewPath",
    );
  }
  // 依頼文からの選択で Koya に決まった場合も同じ。
  await assert.rejects(
    () => service.start({ ...base, harnessId: "", want: "漫画の動画を作って", options: {} }),
    /koya-start-options-missing/u,
  );
  assert.deepEqual(calls, [], "足りない間は Job を作らず、Canvas にも投影せず、実行もしない");

  const planned = await service.start({ ...base, options: complete });
  assert.equal(planned.execution.planOnly, true);
  assert.deepEqual(calls.map(([kind]) => kind), ["create", "project"]);
  // Koya 以外のハーネスには Koya の必須引数を課さない。
  const narrated = await service.start({ ...base, harnessId: "narrated-story-video", options: {} });
  assert.equal(narrated.execution.planOnly, true);
});
