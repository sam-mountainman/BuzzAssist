import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { executeVideoHarnessAdapter, prepareVideoHarnessJob, _testing } from "../lib/videoHarnessAdapters.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("adapter output parser accepts a final JSON object after progress lines", () => {
  assert.deepEqual(_testing.parseJsonOutput("progress\n{\"status\":\"ok\"}\n"), { status: "ok" });
  assert.equal(_testing.parseJsonOutput("not-json"), null);
});

test("all production harnesses require a hash-bound Channel Pack before doctor", async () => {
  assert.deepEqual(await prepareVideoHarnessJob({ job: { harness: { id: "koya-manga-video" }, channelPack: null } }), {
    ok: false,
    blockers: ["signed-channel-pack-required"],
  });
});

test("narrated prepare extracts signed provider metadata without persisting arbitrary Channel Pack JSON", async () => {
  const envelopeDir = await mkdtemp(join(tmpdir(), "narrated-adapter-runtime-"));
  const payloadDir = join(envelopeDir, "payload");
  try {
    await mkdir(payloadDir);
    await writeFile(join(payloadDir, "narrated-story.json"), `${JSON.stringify({
      runtime: { imageModel: "image-model-v1", ttsProvider: "fish-audio" },
      image: { provider: "buzzassist", model: "image-model-v1", adapterVersion: "image-adapter-v1", stylePrompt: "private creative prompt" },
      voice: { provider: "fish-audio", model: "s2-pro", adapterVersion: "fish-server-v1", voiceId: "voice-123" },
      music: { provider: "elevenlabs", model: "music_v1", adapterVersion: "music-server-v1", prompt: "private music prompt" },
    })}\n`);
    const planned = await _testing.sha256Tree(envelopeDir);
    const prepared = await prepareVideoHarnessJob({
      job: {
        harness: { id: "narrated-story-video" },
        channelPack: { kind: "directory", path: envelopeDir, sha256: planned.digest, fileCount: planned.fileCount },
        projectDir: "/fixture/project",
      },
      trustedKey: { trustedPublicKey: "fixture", trustedPublicKeyId: "trusted-key" },
      acceptPack: async () => ({ ok: true, highestVersion: "1.0.0", currentVersion: "1.0.0" }),
      verifyEnvelope: async () => ({
        ok: true,
        manifest: { version: "buzzassist-channel-pack-envelope-v1", coreCompatibility: "*" },
        coreCompatibility: "*",
        id: "narrated-fixture",
        packVersion: "1.0.0",
        harnessId: "narrated-story-video",
        payloadKind: "narrated-story-channel-pack",
        payloadSha256: "d".repeat(64),
        fileCount: 1,
        signerKeyId: "signer",
        trustedPublicKeyId: "trusted-key",
        payloadDir,
      }),
    });
    assert.equal(prepared.ok, true, prepared.error);
    assert.equal(prepared.channelPackRuntime.imageModel, "image-model-v1");
    assert.equal(prepared.channelPackRuntime.ttsProvider, "fish-audio");
    assert.equal(prepared.channelPackRuntime.musicProvider, "elevenlabs");
    assert.equal(prepared.channelPackRuntime.musicModel, "music_v1");
    assert.equal(JSON.stringify(prepared.channelPackRuntime).includes("private creative prompt"), false);
    assert.equal(JSON.stringify(prepared.channelPackRuntime).includes("voice-123"), false);
    assert.equal(JSON.stringify(prepared.channelPackRuntime).includes("private music prompt"), false);
    assert.equal(prepared.channelPackRuntime.payloadSha256, prepared.evidence.payloadSha256);
  } finally {
    await rm(envelopeDir, { recursive: true, force: true });
  }
});

test("prepare rejects a Channel Pack replaced after durable planning", async () => {
  const envelopeDir = await mkdtemp(join(tmpdir(), "narrated-adapter-swapped-"));
  try {
    await writeFile(join(envelopeDir, "planned.txt"), "planned\n");
    const planned = await _testing.sha256Tree(envelopeDir);
    await writeFile(join(envelopeDir, "planned.txt"), "replaced\n");
    let verifies = 0;
    const prepared = await prepareVideoHarnessJob({
      job: {
        harness: { id: "narrated-story-video" },
        channelPack: { kind: "directory", path: envelopeDir, sha256: planned.digest, fileCount: planned.fileCount },
      },
      trustedKey: { trustedPublicKey: "fixture" },
      verifyEnvelope: async () => { verifies += 1; return { ok: true }; },
    });
    assert.equal(prepared.ok, false);
    assert.deepEqual(prepared.blockers, ["channel-pack-signature-verification-failed"]);
    assert.match(prepared.error, /計画後.*差し替え/u);
    assert.equal(verifies, 0, "replacement must fail before signature fixture is trusted");
  } finally {
    await rm(envelopeDir, { recursive: true, force: true });
  }
});

test("prepare persists monotonic Channel Pack acceptance and rejects a later signed downgrade", async () => {
  const root = await mkdtemp(join(tmpdir(), "video-adapter-pack-rollback-"));
  try {
    const projectDir = join(root, "project");
    const pack2 = join(root, "pack-v2");
    const pack1 = join(root, "pack-v1");
    for (const pack of [pack2, pack1]) {
      await mkdir(join(pack, "payload"), { recursive: true });
      await writeFile(join(pack, "payload", "narrated-story.json"), `${JSON.stringify({
        runtime: { imageModel: "gpt-image-2", ttsProvider: "fish-audio" },
        image: { provider: "fal-ai", model: "gpt-image-2", adapterVersion: "fal-gpt-image-2-server-v1" },
        voice: { provider: "fish-audio", model: "s2-pro", adapterVersion: "fish-audio-tts-server-v1", voiceId: "private-voice" },
        music: { provider: "elevenlabs", model: "music_v2", adapterVersion: "elevenlabs-music-server-v1" },
      })}\n`);
    }
    const planned2 = await _testing.sha256Tree(pack2);
    const planned1 = await _testing.sha256Tree(pack1);
    const verifyEnvelope = async ({ bundleDir }) => ({
      ok: true,
      manifest: { version: "buzzassist-channel-pack-envelope-v1", coreCompatibility: "*" },
      coreCompatibility: "*",
      id: "operator-pack",
      packVersion: bundleDir === pack2 ? "2.0.0" : "1.0.0",
      harnessId: "narrated-story-video",
      payloadKind: "narrated-story-channel-pack",
      payloadSha256: bundleDir === pack2 ? "a".repeat(64) : "b".repeat(64),
      fileCount: 1,
      signerKeyId: "fixture-signer",
      trustedPublicKeyId: "ed25519:fixture-trusted",
      payloadDir: join(bundleDir, "payload"),
    });
    const makeJob = (path, planned) => ({
      harness: { id: "narrated-story-video" },
      channelPack: { kind: "directory", path, sha256: planned.digest, fileCount: planned.fileCount },
      projectDir,
    });
    const accepted = await prepareVideoHarnessJob({
      job: makeJob(pack2, planned2),
      trustedKey: { trustedPublicKey: "fixture" },
      verifyEnvelope,
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.acceptance.highestVersion, "2.0.0");
    const rejected = await prepareVideoHarnessJob({
      job: makeJob(pack1, planned1),
      trustedKey: { trustedPublicKey: "fixture" },
      verifyEnvelope,
    });
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.blockers, ["channel-pack-rollback-policy-failed"]);
    assert.match(rejected.error, /より古い|rollback/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("child output tail is byte-bounded and marks truncation", () => {
  const bounded = _testing.appendBoundedTail(Buffer.from("first"), Buffer.from("-0123456789"), 8);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.value.length, 8);
  assert.equal(bounded.value.toString(), "23456789");
});

// timeoutMs は「子が SIGTERM を握り潰す状態になるまでの猶予」も兼ねている。
// node の子は、起動してハンドラを登録する前に SIGTERM が届くと既定動作で即死し、SIGKILL へ昇格しない
// （signalsSent が ["SIGTERM"] になり、実装ではなく起動競合で落ちる）。500ms では並列の試験の間に超え、
// 3 秒に延ばしたが、負荷の平均 140 前後では `node -e 0` の起動だけで最大 3.4 秒かかった。
// POSIX では sh の最初の命令（trap '' TERM）で握り潰すので、起動の重さに左右されない。無視された
// シグナルは子の sleep にも引き継がれ、プロセスグループへの SIGKILL だけが全員を止める。
// Windows は sh が無いので従来の node の子のまま。
const STUBBORN_CHILD_TIMEOUT_MS = 3_000;
const STUBBORN_CHILD_GRACE_MS = 100;
const STUBBORN_CHILD = process.platform === "win32"
  ? [process.execPath, ["-e", "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000)"]]
  : ["/bin/sh", ["-c", "trap '' TERM; echo ready; while :; do sleep 1; done"]];

test("a stubborn child is terminated within a bounded grace period and records escalation", { timeout: 60_000 }, async (t) => {
  const startedAt = Date.now();
  const child = await _testing.runChild(STUBBORN_CHILD[0], STUBBORN_CHILD[1], {
    cwd: process.cwd(),
    timeoutMs: STUBBORN_CHILD_TIMEOUT_MS,
    terminationGraceMs: STUBBORN_CHILD_GRACE_MS,
  });
  assert.equal(child.termination.requested, true);
  assert.equal(child.termination.reason, "timeout");
  assert.equal(child.termination.signalsSent[0], "SIGTERM");
  if (process.platform !== "win32") {
    assert.match(child.stdout, /ready/u, "SIGTERM を握り潰す前に止められた（起動競合）");
    assert.deepEqual(child.termination.signalsSent, ["SIGTERM", "SIGKILL"]);
    assert.equal(child.termination.escalated, true);
    assert.equal(child.signal, "SIGKILL");
  }
  // 設定の猶予で昇格すること（既定の猶予で待ち続けないこと）は、下の「bounded settle watchdog」の試験が
  // 試験の時計で確かめている（猶予を待つ処理は OS に依らず同じ requestTermination を通る）。
  // ここの壁時計は起動と端末の負荷を含むので記録だけにする（負荷の平均 280 で 4.3 秒）。
  t.diagnostic(`起動から打ち切りの決着まで ${Date.now() - startedAt}ms`);
});

test("Windows taskkill nonzero falls back to the exact child and records the failed tree attempt", async () => {
  const signals = [];
  const child = {
    pid: 43210,
    exitCode: null,
    signalCode: null,
    kill(signal) { signals.push(signal); return true; },
  };
  const spawnProcess = () => {
    const killer = new EventEmitter();
    killer.kill = () => true;
    setImmediate(() => killer.emit("close", 1, null));
    return killer;
  };
  const outcome = await _testing.signalChildTree(child, "SIGTERM", {
    platform: "win32",
    spawnProcess,
    taskkillTimeoutMs: 100,
  });
  assert.equal(outcome.success, true);
  assert.equal(outcome.method, "exact-child-fallback");
  assert.equal(outcome.taskkillError, "exit-1");
  assert.deepEqual(signals, ["SIGTERM"]);
});

// 打ち切りの見張りが設定の猶予（各 10ms）で決着することを、壁時計（500ms 未満）で見ていた。負荷の高い端末では
// 偽の子しか使わないこの試験でも 1.3 秒かかって落ちた（同じ試験を 4 本並列で回して1回）。setTimeout・setInterval を
// 試験の時計に差し替え、決着までに進めた時計の長さで見る。既定の猶予（5 秒・2 秒）で待つ壊れ方なら数千 ms 進む。
test("Windows tree and exact-child termination failure rejects within a bounded settle watchdog", { timeout: 60_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let spawnCalls = 0;
  const child = new EventEmitter();
  child.pid = 54321;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => false;
  const spawnProcess = () => {
    spawnCalls += 1;
    if (spawnCalls === 1) return child;
    const killer = new EventEmitter();
    killer.kill = () => true;
    setImmediate(() => killer.emit("close", 1, null));
    return killer;
  };
  let settled = false;
  const outcome = _testing.runChild("fixture.exe", [], {
    cwd: process.cwd(),
    platform: "win32",
    spawnProcess,
    timeoutMs: 10,
    terminationGraceMs: 10,
    terminationSettleMs: 10,
  }).then(
    () => { throw new Error("runChild resolved although the child never exited"); },
    (error) => { throw error; },
  ).finally(() => { settled = true; });
  outcome.catch(() => {});
  // 偽の taskkill の終了（setImmediate）と約束の連鎖を流してから、試験の時計を 5ms ずつ進める。
  let virtualMs = 0;
  while (!settled && virtualMs < 10_000) {
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    if (settled) break;
    t.mock.timers.tick(5);
    virtualMs += 5;
  }
  await assert.rejects(
    outcome,
    (error) => error.code === "CHILD_TERMINATION_FAILED"
      && error.termination.failed === true
      && error.termination.attempts.length === 2,
  );
  assert.ok(virtualMs <= 200, `termination failure must settle within the configured windows, not wait forever (${virtualMs}ms)`);
});

test("Windows child exit before taskkill close still returns complete immutable termination evidence", { timeout: 2_000 }, async () => {
  let spawnCalls = 0;
  const child = new EventEmitter();
  child.pid = 65432;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const spawnProcess = () => {
    spawnCalls += 1;
    if (spawnCalls === 1) return child;
    const killer = new EventEmitter();
    killer.kill = () => true;
    setTimeout(() => {
      child.signalCode = "SIGTERM";
      child.emit("exit", null, "SIGTERM");
    }, 1);
    setTimeout(() => killer.emit("close", 0, null), 15);
    return killer;
  };
  const result = await _testing.runChild("fixture.exe", [], {
    cwd: process.cwd(),
    platform: "win32",
    spawnProcess,
    timeoutMs: 10,
    terminationGraceMs: 20,
    terminationSettleMs: 20,
  });
  assert.equal(result.signal, "SIGTERM");
  assert.deepEqual(result.termination.signalsSent, ["SIGTERM"]);
  assert.equal(result.termination.attempts.length, 1);
  assert.equal(result.termination.attempts[0].method, "windows-taskkill-tree");
  assert.equal(Object.isFrozen(result.termination), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(result.termination.attempts.length, 1, "returned evidence must not mutate after return");
});

test("Koya adapter batches every human blocker without invoking the official CLI", async () => {
  const result = await executeVideoHarnessAdapter({
    job: {
      harness: { id: "koya-manga-video" },
      options: {},
      projectDir: "/fixture",
      script: { path: "/fixture/script.txt" },
    },
  });
  assert.equal(result.status, "awaiting-human-review");
  assert.deepEqual(result.blockers, [
    "episode-id-required",
    "protagonist-speaker-required",
    "character-bible-required",
    "independent-story-review-required",
  ]);
});

test("Koya pause outcome verifies and exposes rendered review artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "koya-adapter-review-artifacts-"));
  try {
    const paths = {
      videoPath: join(root, "preview.mp4"),
      reportPath: join(root, "audit.json"),
      contactSheetPath: join(root, "contact-sheet.jpg"),
      runReceiptPath: join(root, "run-receipt.json"),
    };
    for (const [name, path] of Object.entries(paths)) await writeFile(path, `fixture-${name}\n`);
    const outcome = await executeVideoHarnessAdapter({
      job: {
        harness: { id: "koya-manga-video" },
        projectDir: root,
        script: { path: join(root, "script.txt") },
        options: {
          episodeId: "episode-1",
          protagonistSpeakerId: "protagonist",
          characterBiblePath: join(root, "character-bible.json"),
          storyReviewPath: join(root, "story-review.json"),
        },
      },
      runChild: async () => ({
        code: 3,
        signal: null,
        stderr: "",
        stdout: JSON.stringify({
          status: "awaiting-human-review",
          knownRemainingIssues: ["independent-contact-sheet-signoff-required"],
          ...paths,
        }),
      }),
    });
    assert.equal(outcome.status, "awaiting-human-review");
    assert.deepEqual(outcome.artifacts.map((entry) => entry.kind), [
      "final-video",
      "audit-report",
      "contact-sheet",
      "genre-run-receipt",
    ]);
    assert.equal(outcome.artifacts.every((entry) => /^[a-f0-9]{64}$/u.test(entry.sha256) && entry.bytes > 0), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Koya adapter passes an exact parent-Job preflight binding to the internal full runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "koya-adapter-preflight-binding-"));
  try {
    const job = {
      id: "video-koya-manga-video-0123456789abcdef",
      identityDigest: "0".repeat(64),
      revision: 12,
      runDir: join(root, "run"),
      executionProjectDir: root,
      harness: { id: "koya-manga-video" },
      deployment: { entrypointPath: "/fixture/koya.mjs", entrypointSha256: "a".repeat(64) },
      canonicalIdentity: { deployment: { entrypointSha256: "a".repeat(64) } },
      channelPack: { sha256: "b".repeat(64), fileCount: 3 },
      channelPackVerification: {
        payloadSha256: "c".repeat(64), payloadKind: "koya-handoff",
        signerKeyId: "signer", trustedPublicKeyId: "trusted",
      },
      projectDir: root,
      script: { path: join(root, "script.txt") },
      stages: [{
        id: "doctor", status: "pass", finishedAt: "2026-09-01T00:00:00.000Z",
        evidence: { ready: true, checks: [] },
      }],
      options: {
        episodeId: "episode-bound",
        protagonistSpeakerId: "protagonist",
        characterBiblePath: join(root, "character-bible.json"),
        storyReviewPath: join(root, "story-review.json"),
        speechConcurrency: 1,
      },
    };
    let invokedArgs;
    const runChild = async (_command, args) => {
      invokedArgs = args;
      return {
        code: 3,
        signal: null,
        stderr: "",
        stdout: JSON.stringify({ status: "awaiting-human-review", knownRemainingIssues: ["fixture"] }),
      };
    };
    const outcome = await executeVideoHarnessAdapter({
      job,
      prepareResult: { executionProjectDir: root },
      runChild,
    });
    const flag = (name) => invokedArgs[invokedArgs.indexOf(name) + 1];
    assert.equal(flag("--upstream-job-path"), join(resolve(job.runDir), "job.json"));
    assert.equal(flag("--upstream-job-id"), job.id);
    assert.equal(flag("--upstream-job-revision"), "12");
    assert.match(flag("--upstream-preflight-binding"), /^[a-f0-9]{64}$/u);
    assert.equal(flag("--speech-concurrency"), "1");
    assert.equal(invokedArgs.includes("--confirm-paid-video-generation"), false, "動画差し替えの課金は Job で明示しない限り子へ渡さない");
    assert.equal(invokedArgs.includes("--retry-failed-video"), false);
    assert.equal(invokedArgs.includes("--reviewer-trust-path"), false, "照合済み path が無ければ子には渡さず env に委ねる");
    assert.equal(outcome.status, "awaiting-human-review");

    // F-3: 上位 Job 層で運営者 env と照合済みの信頼リスト path は、子 CLI にも同じものが渡る。
    await executeVideoHarnessAdapter({
      job,
      prepareResult: { executionProjectDir: root },
      reviewerTrustPath: "/etc/buzzassist/reviewer-trust.json",
      runChild,
    });
    assert.equal(flag("--reviewer-trust-path"), "/etc/buzzassist/reviewer-trust.json");
    assert.ok(!invokedArgs.some((value) => /BEGIN|"reviewers"/u.test(value)), "鍵や信頼リストの中身は argv に載らない");

    // 選択カットの動画差し替え: Job 作成時に明示した場合だけ、別課金の確認と再送を子へ渡す。
    await executeVideoHarnessAdapter({
      job: { ...job, options: { ...job.options, confirmPaidVideoGeneration: true, retryFailedVideo: true } },
      prepareResult: { executionProjectDir: root },
      runChild,
    });
    assert.ok(invokedArgs.includes("--confirm-paid-video-generation"));
    assert.ok(invokedArgs.includes("--retry-failed-video"));
    assert.equal(invokedArgs.includes("--retry-failed"), false, "画像の再試行とは別の指定");

    // 画像の失敗分の作り直し（3-18）: resume の実行文脈 retryFailedImages は Job options に
    // 入れずに子へ --retry-failed として渡す。options に入れると jobId の指紋が変わり、
    // 別 Job＝完成済み画像の全額払い直しになる。使った事実は結果に残す（Receipt が記録する）。
    let retryStdout = JSON.stringify({
      status: "awaiting-human-review",
      knownRemainingIssues: ["fixture"],
      imageSummary: { total: 3, complete: 3, failed: 0, reused: 2, paidImages: 3, attempts: 4,
        retriedFailed: { requested: true, jobIds: ["image:2"], count: 1, attempts: 1, completed: 1 } },
      mediaJobStateDir: "/tmp/fixture/.koya-dialogue-source/paid-media-jobs",
    });
    const retryRunChild = async (command, args) => {
      invokedArgs = args;
      return { code: 3, signal: null, stdout: retryStdout, stderr: "" };
    };
    const retried = await executeVideoHarnessAdapter({
      job,
      prepareResult: { executionProjectDir: root },
      retryFailedImages: true,
      runChild: retryRunChild,
    });
    assert.ok(invokedArgs.includes("--retry-failed"), "実行文脈の retryFailedImages は子の --retry-failed になる");
    assert.equal(job.options.retryFailed, undefined, "Job options（identity）には混ぜない");
    assert.deepEqual(retried.imageRetry, {
      requested: true,
      retriedFailed: { requested: true, jobIds: ["image:2"], count: 1, attempts: 1, completed: 1 },
    }, "指紋を迂回した事実と、何枚を何回作り直したかを結果に残す");
    assert.equal(retried.imageSummary.reused, 2);
    assert.equal(retried.mediaJobStateDir, "/tmp/fixture/.koya-dialogue-source/paid-media-jobs", "音声の Media Job journal の場所を親へ返す");

    // 指定が無ければ渡さず、事実も requested:false で残す。
    retryStdout = JSON.stringify({ status: "awaiting-human-review", knownRemainingIssues: ["fixture"] });
    const plain = await executeVideoHarnessAdapter({ job, prepareResult: { executionProjectDir: root }, runChild: retryRunChild });
    assert.equal(invokedArgs.includes("--retry-failed"), false);
    assert.deepEqual(plain.imageRetry, { requested: false, retriedFailed: null });
    assert.equal(plain.imageSummary, null);
    assert.equal(plain.mediaJobStateDir, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("narrated adapter uses the declared generic runner and lifts resumable runtime evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "narrated-adapter-route-"));
  try {
    const cli = join(root, "scripts", "narrated-story-video.mjs");
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(cli, "// fixture runner\n");
    const artifactContents = {
      previewVideo: "fixture-preview-video\n",
      contactSheet: "fixture-contact-sheet\n",
      dialogueAudio: "fixture-dialogue-audio\n",
      subtitles: "fixture-subtitles\n",
    };
    const artifacts = {};
    for (const [kind, contents] of Object.entries(artifactContents)) {
      const path = join(root, `${kind}.fixture`);
      await writeFile(path, contents);
      artifacts[kind] = { path, sha256: sha256(contents) };
    }
    const runReceiptPath = join(root, "run-receipt.json");
    await writeFile(runReceiptPath, "{\"fixture\":true}\n");
    const parsed = {
      status: "awaiting-human-review",
      knownRemainingIssues: ["signoff-required"],
      runtimeMetadata: {
        imageModel: "image-v1",
        ttsProvider: "fish-audio",
        imageProvider: "buzzassist",
        imageAdapterVersion: "image-adapter-v1",
        ttsModel: "s2-pro",
        ttsAdapterVersion: "tts-adapter-v1",
        musicProvider: "elevenlabs",
        musicModel: "music_v1",
        musicAdapterVersion: "music-adapter-v1",
      },
      adapterProbes: [{ ok: true, status: "ready", kind: "voice.synthesis" }],
      mediaJobs: [{ jobId: "media-1", status: "completed" }],
      auditChecks: { duration: true },
      artifacts,
      runReceiptPath,
    };
    let invoked;
    const outcome = await executeVideoHarnessAdapter({
      job: {
        id: "video-narrated-story-video-0123456789abcdef",
        identityDigest: "a".repeat(64),
        revision: 9,
        status: "running",
        runDir: join(root, "canvas", "harness-runs", "video-narrated-story-video-0123456789abcdef"),
        harness: { id: "narrated-story-video" },
        deployment: { root, entrypoint: "node scripts/narrated-story-video.mjs" },
        projectDir: root,
        script: { path: join(root, "script.txt"), sha256: "b".repeat(64) },
        stages: [{
          id: "doctor",
          status: "pass",
          finishedAt: "2026-09-01T00:00:00.000Z",
          evidence: { version: "harness-doctor-v1", ready: true, blocking: [] },
        }],
        options: {},
      },
      prepareResult: { payloadDir: join(root, "payload") },
      runChild: async (command, args, options) => {
        invoked = { command, args, options };
        return { code: 3, signal: null, stdout: JSON.stringify(parsed), stderr: "" };
      },
    });
    assert.equal(invoked.command, process.execPath);
    assert.equal(invoked.args[0], cli);
    assert.equal(invoked.args[1], "full");
    assert.equal(invoked.options.cwd, root);
    const flag = (name) => invoked.args[invoked.args.indexOf(name) + 1];
    assert.equal(flag("--upstream-job-id"), "video-narrated-story-video-0123456789abcdef");
    assert.equal(flag("--upstream-job-revision"), "9");
    assert.match(flag("--upstream-execution-binding"), /^[a-f0-9]{64}$/u);
    assert.equal(invoked.args.includes("--reviewer-trust-path"), false, "照合済み path が無ければ子には渡さず env に委ねる");
    assert.equal(outcome.status, "awaiting-human-review");
    assert.deepEqual(outcome.runtimeMetadata, parsed.runtimeMetadata);
    assert.deepEqual(outcome.adapterProbes, parsed.adapterProbes);
    assert.deepEqual(outcome.mediaJobs, parsed.mediaJobs);
    assert.deepEqual(outcome.auditChecks, parsed.auditChecks);
    assert.equal(outcome.runReceiptPath, parsed.runReceiptPath);
    assert.deepEqual(outcome.artifacts.map((entry) => entry.kind), [
      "preview-video",
      "contact-sheet",
      "voice-stem",
      "subtitle",
      "genre-run-receipt",
    ]);
    const canonicalKinds = {
      previewVideo: "preview-video",
      contactSheet: "contact-sheet",
      dialogueAudio: "voice-stem",
      subtitles: "subtitle",
    };
    for (const [kind, contents] of Object.entries(artifactContents)) {
      assert.equal(outcome.artifacts.find((entry) => entry.kind === canonicalKinds[kind])?.sha256, sha256(contents));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("narrated pause rejects an artifact whose declared SHA no longer matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "narrated-adapter-tampered-artifact-"));
  try {
    const cli = join(root, "scripts", "narrated-story-video.mjs");
    const preview = join(root, "preview.mp4");
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(cli, "// fixture runner\n");
    await writeFile(preview, "tampered-after-outcome\n");
    await assert.rejects(
      () => executeVideoHarnessAdapter({
        job: {
          id: "video-narrated-story-video-fedcba9876543210",
          identityDigest: "c".repeat(64),
          revision: 4,
          status: "running",
          runDir: join(root, "canvas", "harness-runs", "video-narrated-story-video-fedcba9876543210"),
          harness: { id: "narrated-story-video" },
          deployment: { root, entrypoint: "node scripts/narrated-story-video.mjs" },
          projectDir: root,
          script: { path: join(root, "script.txt"), sha256: "d".repeat(64) },
          stages: [{
            id: "doctor",
            status: "pass",
            finishedAt: "2026-09-01T00:00:00.000Z",
            evidence: { version: "harness-doctor-v1", ready: true, blocking: [] },
          }],
          options: {},
        },
        runChild: async () => ({
          code: 3,
          signal: null,
          stderr: "",
          stdout: JSON.stringify({
            status: "awaiting-human-review",
            knownRemainingIssues: ["signoff-required"],
            artifacts: { previewVideo: { path: preview, sha256: sha256("original\n") } },
          }),
        }),
      }),
      /SHA-256/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("F-3: narrated adapter forwards the operator-verified reviewer trust path to the genre CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "narrated-adapter-trust-path-"));
  try {
    const cli = join(root, "scripts", "narrated-story-video.mjs");
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(cli, "// fixture runner\n");
    let invoked;
    const outcome = await executeVideoHarnessAdapter({
      job: {
        id: "video-narrated-story-video-0123456789abcdef",
        identityDigest: "a".repeat(64),
        revision: 2,
        status: "running",
        runDir: join(root, "canvas", "harness-runs", "video-narrated-story-video-0123456789abcdef"),
        harness: { id: "narrated-story-video" },
        deployment: { root, entrypoint: "node scripts/narrated-story-video.mjs" },
        projectDir: root,
        script: { path: join(root, "script.txt"), sha256: "b".repeat(64) },
        stages: [{ id: "doctor", status: "pass", finishedAt: "2026-09-01T00:00:00.000Z", evidence: { version: "harness-doctor-v1", ready: true, blocking: [] } }],
        options: {},
      },
      prepareResult: { payloadDir: join(root, "payload") },
      reviewerTrustPath: join(root, "operator-trust.json"),
      runChild: async (command, args) => {
        invoked = { command, args };
        return { code: 3, signal: null, stdout: JSON.stringify({ status: "awaiting-human-review", knownRemainingIssues: ["signoff-required"], artifacts: {} }), stderr: "" };
      },
    });
    const flag = (name) => invoked.args[invoked.args.indexOf(name) + 1];
    assert.equal(invoked.args[1], "full");
    assert.equal(flag("--reviewer-trust-path"), join(root, "operator-trust.json"));
    assert.equal(invoked.args.filter((value) => value === "--reviewer-trust-path").length, 1);
    assert.equal(outcome.status, "awaiting-human-review");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
