import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  PAID_CALL_FORBIDDEN_CODE,
  PAID_CALL_GUARD_ENV,
  assertPaidCallAllowed,
  readPaidCallGuardLedger,
} from "../lib/paidCallGuard.mjs";
import { createPaidMediaJobBroker, paidMediaRequestIdentity } from "../lib/paidMediaJobBroker.mjs";
import { generateImageMedia, generateVideoMedia } from "../lib/mediaGeneration.mjs";
import { executeVideoHarnessAdapter, _testing as adapterTesting } from "../lib/videoHarnessAdapters.mjs";

const spec = (overrides = {}) => ({
  kind: "voice.synthesis",
  provider: "synthetic-voice",
  model: "synthetic-model",
  adapterVersion: "synthetic-adapter-v1",
  voiceId: "synthetic-voice-a",
  input: { text: "合成の一文。", speed: 1 },
  output: { format: "wav", sampleRate: 44_100 },
  reservation: { unit: "seconds", estimatedSeconds: 2, estimatedCost: 0.01, currency: "USD" },
  ...overrides,
});

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

test("関所が無ければ何もしない。あれば台帳に残して課金されていない・再送しない例外で止める", async () => {
  const root = await mkdtemp(join(tmpdir(), "paid-call-guard-"));
  try {
    assert.doesNotThrow(() => assertPaidCallAllowed({ route: "image-generation", kind: "image" }, { env: {} }));
    const ledger = join(root, "guard", "refused.jsonl");
    const env = { [PAID_CALL_GUARD_ENV]: ledger };
    assert.throws(
      () => assertPaidCallAllowed({ route: "paid-media-broker", kind: "voice.synthesis", provider: "p", model: "m", requestKey: "key-1" }, { env }),
      (error) => error.code === PAID_CALL_FORBIDDEN_CODE && error.charged === false && error.retryable === false && error.nonRetryable === true,
    );
    const rows = readPaidCallGuardLedger(ledger);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].route, "paid-media-broker");
    assert.match(rows[0].requestKeyDigest, /^[a-f0-9]{64}$/u);
    assert.equal(JSON.stringify(rows).includes("key-1"), false, "requestKey そのものは台帳に書かない");
    assert.deepEqual(readPaidCallGuardLedger(join(root, "missing.jsonl")), []);
    assert.throws(() => assertPaidCallAllowed({}, { env: { [PAID_CALL_GUARD_ENV]: "relative/ledger.jsonl" } }), /絶対パス/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("broker は記録済みの Media Job へ接続するだけなら通し、新しく送るときだけ予約の記録を書く前に止める", async () => {
  const root = await mkdtemp(join(tmpdir(), "paid-call-guard-broker-"));
  try {
    const stateDir = join(root, "media-jobs");
    let calls = 0;
    const apiFetch = async () => {
      calls += 1;
      return response(201, {
        job: {
          jobId: "job-1",
          status: "completed",
          usage: { seconds: 2, cost: 0.01, currency: "USD" },
          result: { artifact: { url: "https://artifact.invalid/a.wav", sha256: "a".repeat(64), mimeType: "audio/wav", bytes: 10 } },
        },
      });
    };
    // 1回目は関所なしで作る（すでに作った有料の成果物）。
    const open = createPaidMediaJobBroker({ stateDir, apiBase: "https://broker.invalid/api/media/jobs", apiFetch, machineSlots: false, env: {} });
    const made = await open.start(spec());
    assert.equal(made.status, "completed");
    assert.equal(calls, 1);

    const ledger = join(root, "refused.jsonl");
    const guarded = createPaidMediaJobBroker({
      stateDir,
      apiBase: "https://broker.invalid/api/media/jobs",
      apiFetch,
      machineSlots: false,
      env: { [PAID_CALL_GUARD_ENV]: ledger },
    });
    const reused = await guarded.start(spec());
    assert.equal(reused.status, "completed");
    assert.equal(calls, 1, "記録済みの完成品は送り直さない");
    assert.deepEqual(readPaidCallGuardLedger(ledger), []);

    const fresh = spec({ input: { text: "まだ作っていない一文。", speed: 1 } });
    await assert.rejects(() => guarded.start(fresh), (error) => error.code === PAID_CALL_FORBIDDEN_CODE);
    assert.equal(calls, 1, "新しい有料の呼び出しは送らない");
    assert.equal(await guarded.getLocal({ requestKey: paidMediaRequestIdentity(fresh).requestKey }), null, "予約の記録も残さない");
    assert.equal((await readdir(join(stateDir, "jobs"))).length, 1);
    const rows = readPaidCallGuardLedger(ledger);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "voice.synthesis");
    assert.equal(rows[0].provider, "synthetic-voice");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("画像・動画の生成は関所があれば枠を取る前に止める", async () => {
  const root = await mkdtemp(join(tmpdir(), "paid-call-guard-media-"));
  const previous = process.env[PAID_CALL_GUARD_ENV];
  try {
    const ledger = join(root, "refused.jsonl");
    process.env[PAID_CALL_GUARD_ENV] = ledger;
    await assert.rejects(() => generateImageMedia({ model: "gpt-image-2", prompt: "合成" }), (error) => error.code === PAID_CALL_FORBIDDEN_CODE);
    await assert.rejects(() => generateVideoMedia({ prompt: "合成" }), (error) => error.code === PAID_CALL_FORBIDDEN_CODE);
    assert.deepEqual(readPaidCallGuardLedger(ledger).map((row) => row.route), ["image-generation", "video-generation"]);
  } finally {
    if (previous === undefined) delete process.env[PAID_CALL_GUARD_ENV];
    else process.env[PAID_CALL_GUARD_ENV] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("adapter は関所の台帳を子の環境にだけ入れ、固定した制作契約の写しを Koya の子へ渡す", async () => {
  const root = await mkdtemp(join(tmpdir(), "paid-call-guard-adapter-"));
  try {
    assert.equal(adapterTesting.childEnv({}), process.env);
    const ledger = join(root, "refused.jsonl");
    assert.equal(adapterTesting.childEnv({ paidCallGuardPath: ledger })[PAID_CALL_GUARD_ENV], resolve(ledger));
    assert.equal(process.env[PAID_CALL_GUARD_ENV], undefined, "自分のプロセスの環境は変えない");

    const job = {
      id: "video-koya-manga-video-0123456789abcdef",
      identityDigest: "0".repeat(64),
      revision: 3,
      runDir: join(root, "run"),
      executionProjectDir: root,
      harness: { id: "koya-manga-video" },
      deployment: { entrypointPath: join(root, "koya.mjs"), entrypointSha256: "a".repeat(64) },
      canonicalIdentity: { deployment: { entrypointSha256: "a".repeat(64) } },
      channelPack: { sha256: "b".repeat(64), fileCount: 3 },
      projectDir: root,
      script: { path: join(root, "script.txt") },
      stages: [{ id: "doctor", status: "pass", finishedAt: "2026-09-01T00:00:00.000Z", evidence: { ready: true, checks: [] } }],
      options: {
        episodeId: "episode-synthetic",
        protagonistSpeakerId: "protagonist",
        characterBiblePath: join(root, "bible.json"),
        storyReviewPath: join(root, "review.json"),
        contractPath: join(root, "planned-contract.json"),
      },
    };
    let invoked;
    const runChild = async (command, args, options) => {
      invoked = { args, options };
      return { code: 3, signal: null, stderr: "", stdout: JSON.stringify({ status: "awaiting-human-review", knownRemainingIssues: ["fixture"] }) };
    };
    const flag = (name) => invoked.args[invoked.args.indexOf(name) + 1];
    await executeVideoHarnessAdapter({ job, prepareResult: { executionProjectDir: root }, runChild });
    assert.equal(flag("--contract-path"), job.options.contractPath);
    assert.equal(invoked.options.env[PAID_CALL_GUARD_ENV], undefined);

    const pinned = join(root, "run", "finalize-after-update", "pinned-production-contract.json");
    await executeVideoHarnessAdapter({
      job,
      prepareResult: { executionProjectDir: root },
      runChild,
      paidCallGuardPath: ledger,
      pinnedProductionContractPath: pinned,
    });
    assert.equal(flag("--contract-path"), pinned);
    assert.equal(invoked.options.env[PAID_CALL_GUARD_ENV], resolve(ledger));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
