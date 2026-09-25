// ナレーション物語の有料 Media Job の再開（lib/narratedStoryMediaRunner.mjs）と、子 → Job 層の報告の試験。
// 共通 broker は本物を使い、サーバーだけを合成の応答で置き換える（ネットワーク・有料 API は使わない）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { resolveFfmpegToolchain } from "../lib/harnessRuntimeResolver.mjs";
import {
  NARRATED_REQUEST_KEY_CHAIN_LIMIT,
  PAID_MEDIA_FAILED_CHARGED_CODE,
  PAID_MEDIA_RECOVERY_PENDING_CODE,
  createBrokerMediaJobRunner,
  listUnsettledPaidMediaJobs,
  requestKeyInChain,
} from "../lib/narratedStoryMediaRunner.mjs";
import { narratedStoryRunPaths, runNarratedStoryPipeline } from "../lib/narratedStoryPipeline.mjs";
import { createPaidMediaJobBroker, paidMediaRequestIdentity } from "../lib/paidMediaJobBroker.mjs";
import { _testing as adapterTesting, executeVideoHarnessAdapter } from "../lib/videoHarnessAdapters.mjs";
import { _testing as jobTesting } from "../lib/videoHarnessJob.mjs";
import { bookendFixtureAdapters, createBookendFixtureMedia, passingVoiceQualityGate } from "./fixtures/narratedBookendFixture.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const noSleep = async () => {};
const API = "https://broker.invalid/api/media/jobs";

function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => payload, text: async () => JSON.stringify(payload) };
}

const imageSpec = (prompt = "合成の場面") => ({
  kind: "image.generation",
  provider: "fixture-image",
  model: "fixture-image-v1",
  adapterVersion: "fixture-image-adapter-v1",
  input: { prompt },
  output: { format: "png" },
  reservation: { unit: "images", estimatedUnits: 1 },
});

/**
 * 合成のサーバー。`plan(requestKey, attempt)` が POST ごとの応答を決める:
 * "complete" | "fail-uncharged" | "fail-charged" | "reject-400" | "ambiguous-504"。
 * recover は `recoverAs(requestKey)` の状態で返す。
 */
function fakeServer({ plan = () => "complete", recoverAs = () => "completed", bytesFor = () => Buffer.from("fixture") } = {}) {
  const calls = { posts: [], recover: [], gets: 0 };
  const jobs = new Map();
  const completedJob = (requestKey, inputHash, bytes) => ({
    jobId: `srv-${sha256(requestKey).slice(0, 12)}`,
    requestKey,
    inputHash,
    providerJobId: `prov-${sha256(requestKey).slice(0, 8)}`,
    status: "completed",
    reservation: { reservationId: `res-${sha256(requestKey).slice(0, 8)}`, status: "captured" },
    usage: { cost: 0.01, currency: "USD" },
    result: { artifact: { url: `https://artifact.invalid/${sha256(requestKey).slice(0, 12)}`, sha256: sha256(bytes), mimeType: "image/png", bytes: bytes.length } },
  });
  const apiFetch = async (url, options) => {
    const target = String(url);
    if (options.method === "GET") {
      calls.gets += 1;
      const known = [...jobs.values()].find((job) => target.includes(job.jobId) || target.includes(encodeURIComponent(job.requestKey)));
      return response(200, { job: known || { status: "running" } });
    }
    const body = JSON.parse(options.body || "{}");
    if (target.endsWith("/recover")) {
      calls.recover.push(body.requestKey);
      const status = recoverAs(body.requestKey);
      const job = status === "completed"
        ? completedJob(body.requestKey, body.inputHash, bytesFor(body.requestKey))
        : { jobId: `srv-${sha256(body.requestKey).slice(0, 12)}`, requestKey: body.requestKey, inputHash: body.inputHash, status, error: status === "failed" ? { message: "provider rejected", charged: false } : undefined };
      jobs.set(body.requestKey, job);
      return response(200, { job });
    }
    calls.posts.push(body.requestKey);
    const attempt = calls.posts.filter((key) => key === body.requestKey).length;
    const behaviour = plan(body.requestKey, attempt, body);
    if (behaviour === "ambiguous-504") return response(504, { error: "gateway timeout" });
    if (behaviour === "reject-400") return response(400, { error: "bad request" });
    if (behaviour === "fail-uncharged" || behaviour === "fail-charged") {
      const job = {
        jobId: `srv-${sha256(`${body.requestKey}:${attempt}`).slice(0, 12)}`,
        requestKey: body.requestKey,
        inputHash: body.inputHash,
        status: "failed",
        error: { message: "provider failed", code: "provider_failed", status: 500, charged: behaviour === "fail-charged" },
      };
      jobs.set(body.requestKey, job);
      return response(200, { job });
    }
    const job = completedJob(body.requestKey, body.inputHash, bytesFor(body.requestKey, body));
    jobs.set(body.requestKey, job);
    return response(201, { job });
  };
  return { apiFetch, calls };
}

async function runnerWith(t, server, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "narrated-media-runner-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const make = (extra = {}) => createBrokerMediaJobRunner({
    broker: createPaidMediaJobBroker({ stateDir, apiBase: API, apiFetch: server.apiFetch, sleepFn: noSleep }),
    readArtifact: async (job) => Buffer.from(`artifact:${job.requestKey}`),
    waitOptions: { pollIntervalMs: 10, timeoutMs: 2_000 },
    ...options,
    ...extra,
  });
  return { stateDir, make };
}

test("鍵の系列: <requestKey>:rN だけを同じ入力の送り直しとして受ける", () => {
  assert.equal(requestKeyInChain("media:k", "media:k"), true);
  assert.equal(requestKeyInChain("media:k:r1", "media:k"), true);
  assert.equal(requestKeyInChain(`media:k:r${NARRATED_REQUEST_KEY_CHAIN_LIMIT + 1}`, "media:k"), false);
  assert.equal(requestKeyInChain("media:k:r0", "media:k"), false);
  assert.equal(requestKeyInChain("media:other", "media:k"), false);
  assert.equal(requestKeyInChain("media:k:rx", "media:k"), false);
});

test("recovery-required は送り直さず recover で決着させてから進む。決着しなければ理由つきで止める", async (t) => {
  let recoverAs = "completed";
  const server = fakeServer({ plan: (key, attempt) => (attempt === 1 ? "ambiguous-504" : "complete"), recoverAs: () => recoverAs });
  const { stateDir, make } = await runnerWith(t, server);
  const spec = imageSpec();
  const baseKey = paidMediaRequestIdentity(spec).requestKey;
  await assert.rejects(make()(spec), (error) => error?.job?.status === "recovery-required");
  assert.deepEqual((await listUnsettledPaidMediaJobs(stateDir)).map((row) => [row.requestKey, row.status]), [[baseKey, "recovery-required"]]);
  // 以前は同じ鍵の recovery-required を返されて例外で止まるだけだった。今は recover を呼ぶ。
  recoverAs = "recovery-required";
  await assert.rejects(make()(spec), (error) => error?.code === PAID_MEDIA_RECOVERY_PENDING_CODE);
  assert.equal(server.calls.posts.length, 1, "決着しない間は送り直さない");
  recoverAs = "completed";
  const done = await make()(spec);
  assert.equal(done.job.status, "completed");
  assert.equal(done.receipt.requestKey, baseKey);
  assert.equal(server.calls.posts.length, 1, "recover で完成した仕事を再課金しない");
  assert.deepEqual(server.calls.recover, [baseKey, baseKey]);
  assert.deepEqual(await listUnsettledPaidMediaJobs(stateDir), []);
});

test("課金されていない失敗は送り直す: 受理前の失敗は同じ鍵、受理後に failed で固定された仕事は次の鍵", async (t) => {
  const server = fakeServer({
    plan: (key, attempt) => {
      if (key.endsWith(":r1")) return "complete";
      if (key.includes("reject")) return attempt === 1 ? "reject-400" : "complete";
      return "fail-uncharged";
    },
  });
  const { make } = await runnerWith(t, server);
  // 受理前の失敗（HTTP 400、jobId は local- のまま）。
  const rejected = { ...imageSpec("reject"), requestKey: "media:image:reject-case" };
  await assert.rejects(make()(rejected));
  const replayed = await make()(rejected);
  assert.equal(replayed.receipt.requestKey, "media:image:reject-case", "同じ鍵（サーバーの冪等キー）で送り直す");
  assert.deepEqual(server.calls.posts.filter((key) => key === "media:image:reject-case").length, 2);
  // 受理後に failed で固定された仕事（charged:false）。
  const spec = imageSpec("fixed-failure");
  const baseKey = paidMediaRequestIdentity(spec).requestKey;
  await assert.rejects(make()(spec), (error) => /paid-media-job-failed/u.test(error.code));
  const runner = make();
  const next = await runner(spec);
  assert.equal(next.receipt.requestKey, `${baseKey}:r1`);
  assert.deepEqual(runner.stats().resubmittedUncharged, [{ requestKey: baseKey, sameKey: false }]);
  assert.equal(runner.stats().retriedFailed.count, 0, "課金されていない送り直しは作り直しの回数に数えない");
});

test("課金された失敗は自動で送り直さない。画像だけ --retry-failed-images で作り直し、回数を記録する", async (t) => {
  const server = fakeServer({ plan: (key) => (key.endsWith(":r1") ? "complete" : "fail-charged") });
  const { make } = await runnerWith(t, server);
  const spec = imageSpec("charged-failure");
  await assert.rejects(make()(spec));
  await assert.rejects(make()(spec), (error) => error?.code === PAID_MEDIA_FAILED_CHARGED_CODE);
  const voiceLike = { ...spec, kind: "voice.synthesis", voiceId: "fixture-voice", input: { text: "合成" } };
  await assert.rejects(make({ retryFailedKinds: ["image.generation"] })(voiceLike));
  await assert.rejects(make({ retryFailedKinds: ["image.generation"] })(voiceLike), (error) => error?.code === PAID_MEDIA_FAILED_CHARGED_CODE, "声は対象外");
  const runner = make({ retryFailedKinds: ["image.generation"] });
  const rebuilt = await runner(spec);
  assert.match(rebuilt.receipt.requestKey, /:r1$/u);
  const stats = runner.stats().retriedFailed;
  assert.equal(stats.requested, true);
  assert.equal(stats.count, 1);
  assert.equal(stats.attempts, 1);
  assert.equal(stats.completed, 1);
  assert.equal(stats.jobIds.length, 1);
});

test("Job 層: 同じ入力の次の鍵が来たら、前の鍵の未完了の行は置き換わる（completed は消さない）", () => {
  const row = (requestKey, status) => ({ requestKey, status, jobId: `j-${requestKey}`, kind: "image.generation", provider: "p", model: "m", inputHash: "a".repeat(64) });
  const merged = jobTesting.mergeMediaJobs(
    [row("media:a", "recovery-required"), row("media:b", "completed"), row("media:c", "failed")],
    [row("media:a:r1", "completed"), row("media:d", "completed")],
  );
  assert.deepEqual(merged.map((entry) => [entry.requestKey, entry.status]), [
    ["media:b", "completed"], ["media:c", "failed"], ["media:a:r1", "completed"], ["media:d", "completed"],
  ]);
  const kept = jobTesting.mergeMediaJobs([row("media:e", "completed")], [row("media:e:r1", "completed")]);
  assert.equal(kept.length, 2, "完成した行は後継があっても消さない");
});

test("adapter: --retry-failed-images を narrated の子へ渡し、子が報告した journal の置き場と作り直しの記録を Job へ返す", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "narrated-adapter-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "scripts", "narrated-story-video.mjs"), "// fixture entrypoint\n");
  const seen = [];
  const stateDir = join(root, ".media", "narrated-story-video", "job", "broker-journal");
  const job = {
    id: "video-narrated-story-video-0000000000000abc",
    harness: { id: "narrated-story-video" },
    projectDir: root,
    runDir: join(root, "run"),
    revision: 3,
    script: { path: join(root, "script.json") },
    options: {},
    deployment: { root, entrypoint: "node scripts/narrated-story-video.mjs" },
    stages: [{ id: "doctor", status: "pass", evidence: { ready: true } }],
  };
  const outcome = await executeVideoHarnessAdapter({
    job,
    retryFailedImages: true,
    prepareResult: { payloadDir: join(root, "pack") },
    runChild: async (command, args) => {
      seen.push(args);
      return {
        code: 3,
        signal: null,
        stdout: JSON.stringify({
          status: "awaiting-media",
          knownRemainingIssues: ["media-job-failure:paid-media-recovery-pending"],
          mediaJobs: [{ requestKey: "media:image:x", status: "recovery-required", kind: "image.generation" }],
          mediaJobStateDir: stateDir,
          imageRetry: { requested: true, retriedFailed: { requested: true, jobIds: ["srv-1"], count: 1, attempts: 1, completed: 0 } },
        }),
        stderr: "",
      };
    },
  });
  assert.ok(seen[0].includes("--retry-failed-images"), "resume の実行文脈の作り直しを子へ渡す");
  assert.equal(outcome.status, "awaiting-human-review");
  assert.equal(outcome.mediaJobStateDir, stateDir);
  assert.equal(outcome.mediaJobs[0].status, "recovery-required");
  assert.equal(outcome.imageRetry.requested, true);
  assert.equal(outcome.imageRetry.retriedFailed.count, 1);
  // 渡さなければ付けない。
  seen.length = 0;
  await executeVideoHarnessAdapter({ job, prepareResult: { payloadDir: join(root, "pack") }, runChild: async (command, args) => { seen.push(args); return { code: 3, signal: null, stdout: "{}", stderr: "" }; } });
  assert.equal(seen[0].includes("--retry-failed-images"), false);
  assert.deepEqual(adapterTesting.narratedEvidence({}, false).imageRetry, { requested: false, retriedFailed: null });
});

test("公式経路: 止まった回は決着していない Media Job と journal の置き場を報告し、再開では recover で決着させて再課金せずに進む", async (t) => {
  const toolchain = await resolveFfmpegToolchain();
  if (!toolchain.ok) { t.skip("ffmpeg/ffprobe is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "narrated-resume-recover-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pack = join(root, "pack");
  await mkdir(pack, { recursive: true });
  await writeFile(join(pack, "narrated-story.json"), JSON.stringify({
    version: "fixture-pack-v1",
    runtime: { imageModel: "fixture-image-v1", ttsProvider: "fixture-voice" },
    image: { provider: "fixture-image", model: "fixture-image-v1", adapterVersion: "fixture-image-adapter-v1", stylePrompt: "flat fixture" },
    voice: { provider: "fixture-voice", model: "fixture-voice-v1", adapterVersion: "fixture-voice-adapter-v1", voiceId: "fixture-narrator", speed: 1 },
    music: { provider: "fixture-music", model: "fixture-music-v1", adapterVersion: "fixture-music-adapter-v1", prompt: "quiet", gain: 0.03 },
    render: { width: 320, height: 180, fps: 12 },
    concurrency: 1,
    bookends: { enabled: false },
  }), "utf8");
  const scriptPath = join(root, "input", "script.txt");
  await mkdir(dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, "最初の物語です。次の場面です。\n", "utf8");
  const fixture = await createBookendFixtureMedia(join(root, "media"), toolchain);
  const bytesByKind = { "image.generation": fixture.image, "voice.synthesis": fixture.voice, "music.generation": fixture.music };
  const kindByKey = new Map();
  let recoverReady = false;
  const server = fakeServer({
    plan: (key, attempt, body) => {
      kindByKey.set(key, body.kind);
      return body.kind === "voice.synthesis" && body.input?.text === "次の場面です。" && attempt === 1 ? "ambiguous-504" : "complete";
    },
    recoverAs: () => (recoverReady ? "completed" : "recovery-required"),
    bytesFor: (key, body) => bytesByKind[body?.kind || kindByKey.get(key)],
  });
  const jobId = "video-narrated-story-video-00000000000000d1";
  const stateDir = join(narratedStoryRunPaths({ deploymentRoot: root, jobId }).runDir, "broker-journal");
  const artifactsByKey = new Map();
  const make = () => createBrokerMediaJobRunner({
    broker: createPaidMediaJobBroker({ stateDir, apiBase: API, apiFetch: server.apiFetch, sleepFn: noSleep }),
    readArtifact: async (job) => artifactsByKey.get(job.requestKey) || bytesByKind[kindByKey.get(job.requestKey)],
    waitOptions: { pollIntervalMs: 10, timeoutMs: 2_000 },
  });
  const run = () => runNarratedStoryPipeline({
    scriptPath,
    channelPackDir: pack,
    jobId,
    deploymentRoot: root,
    mediaJobRunner: make(),
    mediaJobProbe: bookendFixtureAdapters(fixture).mediaJobProbe,
    ffmpegToolchain: toolchain,
    voiceQualityGate: passingVoiceQualityGate,
    jobIdentityDigest: "a1".repeat(32),
    env: {},
  });
  const stopped = await run();
  assert.equal(stopped.status, "awaiting-media");
  assert.equal(stopped.mediaJobStateDir, stateDir, "Job 層の recover が探す journal の置き場を報告する");
  const pending = stopped.mediaJobs.filter((row) => row.status === "recovery-required");
  assert.equal(pending.length, 1, "決着していない Media Job を Job へ報告する");
  const postsAfterStop = server.calls.posts.length;
  // 決着しない間の再開は送り直さずに止まる。
  const held = await run();
  assert.equal(held.status, "awaiting-media");
  assert.ok(held.knownRemainingIssues.includes(`media-job-failure:${PAID_MEDIA_RECOVERY_PENDING_CODE}`), held.knownRemainingIssues.join(", "));
  assert.equal(server.calls.posts.length, postsAfterStop);
  recoverReady = true;
  const resumed = await run();
  assert.equal(resumed.status, "awaiting-human-review", resumed.knownRemainingIssues.join(", "));
  assert.equal(server.calls.posts.filter((key) => key === pending[0].requestKey).length, 1, "recover で完成した声を再課金しない");
  assert.ok(resumed.mediaJobs.every((row) => row.status === "completed"));
  assert.deepEqual(await listUnsettledPaidMediaJobs(stateDir), []);
  const manifest = JSON.parse(await readFile(join(dirname(stateDir), "generation-manifest.json"), "utf8"));
  assert.equal(manifest.mediaJobs.length, resumed.mediaJobs.length);
});
