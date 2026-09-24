import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createVideoHarnessJob,
  createVideoHarnessUpstreamExecutionBinding,
  readVideoHarnessJob,
  requestVideoHarnessCancellation,
  runVideoHarnessJob,
  selectVideoHarness,
  withVideoHarnessJobLock,
  _testing as jobTesting,
} from "../lib/videoHarnessJob.mjs";
import { runNarratedStoryVideo } from "../lib/narratedStoryVideo.mjs";
import { createReviewerTrustEntry, generateReviewerKeyPair } from "../lib/koyaReviewAttestation.mjs";

// この試験は Job の仕組み（再開・取消・Canvas 投影・Receipt）を、リポジトリの実際の
// 宣言とスキルの上で確かめる。スキルの人の承認は人の手番で、正本を直した直後は必ず
// 古くなるので、ここでは承認の要求を外す（子プロセスにも引き継がれる）。承認ゲート
// 自体は test/videoHarnessProductionProfile.test.mjs が、公開前の承認は Release の
// skills:check:release が見る。
process.env.BUZZASSIST_REQUIRE_SKILL_APPROVAL = "0";

const harnesses = [
  { id: "manga", keywords: ["漫画"], produces: { kind: "manga-video" } },
  { id: "story", keywords: ["物語"], produces: { kind: "narrated-story-video" } },
];

test("explicit harness wins and an ambiguous capability match fails before generation", () => {
  assert.equal(selectVideoHarness({ harnesses, harnessId: "story", want: "漫画" }).harness.id, "story");
  assert.equal(selectVideoHarness({ harnesses, want: "漫画を作る" }).harness.id, "manga");
  assert.throws(
    () => selectVideoHarness({
      harnesses: [
        { id: "a", keywords: ["動画"], produces: { kind: "a" } },
        { id: "b", keywords: ["動画"], produces: { kind: "b" } },
      ],
      want: "動画",
    }),
    /一意に選べない/u,
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "video-harness-job-"));
  const deployment = join(root, "deployment");
  await mkdir(join(root, "config"), { recursive: true });
  await mkdir(join(deployment, "production"), { recursive: true });
  await writeFile(join(deployment, "canonical.mjs"), "import './production/shared.mjs';\n", "utf8");
  await writeFile(join(deployment, "production", "mike-video-harness.mjs"), "import './shared.mjs';\n", "utf8");
  await writeFile(join(deployment, "production", "shared.mjs"), "export const fixtureVersion = 1;\n", "utf8");
  await writeFile(join(root, "script.txt"), "これは日本語の台本です。\n", "utf8");
  await writeFile(join(root, "pack.bundle"), "signed fixture", "utf8");
  await writeFile(join(root, "config", "harness-deployments.json"), `${JSON.stringify({
    deployments: [
      { harnessId: "koya-manga-video", root: "deployment", entrypoint: "node canonical.mjs" },
      { harnessId: "narrated-story-video", root: "deployment", entrypoint: "node production/mike-video-harness.mjs" },
    ],
  }, null, 2)}\n`);
  return root;
}

test("same inputs attach to one durable job and the copied script is hash-bound", async () => {
  const root = await fixture();
  try {
    const input = {
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      channelPackPath: join(root, "pack.bundle"),
      harnessId: "koya-manga-video",
      repoRoot: root,
      now: () => "2026-09-01T00:00:00.000Z",
    };
    const first = await createVideoHarnessJob(input);
    const second = await createVideoHarnessJob(input);
    assert.equal(first.attached, false);
    assert.equal(second.attached, true);
    assert.equal(second.job.id, first.job.id);
    assert.equal(await readFile(first.job.script.path, "utf8"), "これは日本語の台本です。\n");
    assert.match(first.job.script.sha256, /^[a-f0-9]{64}$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor failure blocks before the production adapter is called", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      harnessId: "koya-manga-video",
      repoRoot: root,
    });
    let calls = 0;
    const stopped = await runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => ({ ready: false, blocking: ["ffmpeg"] }),
      adapter: async () => { calls += 1; return { status: "completed" }; },
    });
    assert.equal(stopped.status, "blocked-preflight");
    assert.deepEqual(stopped.blockers, ["ffmpeg"]);
    assert.equal(calls, 0, "有料処理へ到達していないこと");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("import済みtransitive production moduleの差替えはdoctorとpaid adapterより前にfail-closed", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      harnessId: "koya-manga-video",
      repoRoot: root,
    });
    assert.match(job.canonicalIdentity.productionDependencies.runtime.digest, /^[a-f0-9]{64}$/u);
    assert.match(job.canonicalIdentity.productionDependencies.deployment.digest, /^[a-f0-9]{64}$/u);
    const entrypointSha256 = job.canonicalIdentity.deployment.entrypointSha256;
    await writeFile(join(root, "deployment", "production", "shared.mjs"), "export const fixtureVersion = 2;\n", "utf8");

    let doctorCalls = 0;
    let paidCalls = 0;
    const stopped = await runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => { doctorCalls += 1; return { ready: true, blocking: [] }; },
      adapter: async () => { paidCalls += 1; return { status: "completed" }; },
    });
    assert.equal(stopped.status, "blocked-preflight");
    assert.deepEqual(stopped.blockers, ["canonical-identity-drift"]);
    assert.equal(doctorCalls, 0);
    assert.equal(paidCalls, 0);
    assert.equal(job.canonicalIdentity.deployment.entrypointSha256, entrypointSha256,
      "entrypoint itself is unchanged; the transitive tree is what must stop execution");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor実行中のtransitive module差替えもadapter直前の共通再検査でpaid 0になる", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      harnessId: "narrated-story-video",
      repoRoot: root,
    });
    let doctorCalls = 0;
    let paidCalls = 0;
    const stopped = await runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => {
        doctorCalls += 1;
        await writeFile(join(root, "deployment", "production", "shared.mjs"), "export const fixtureVersion = 3;\n");
        return { ready: true, blocking: [], checks: [{ id: "fixture", required: true, ok: true }] };
      },
      adapter: async () => { paidCalls += 1; return { status: "completed" }; },
    });
    assert.equal(stopped.status, "blocked-preflight");
    assert.deepEqual(stopped.blockers, ["canonical-identity-drift"]);
    assert.equal(doctorCalls, 1);
    assert.equal(paidCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("narrated childもouter bindingを再検証しlaunch後のtransitive差替えをpaid前に拒否する", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      harnessId: "narrated-story-video",
      repoRoot: root,
    });
    const running = await jobTesting.writeJob({
      ...job,
      status: "running",
      stages: job.stages.map((stage) => stage.id === "doctor" ? {
        ...stage,
        status: "pass",
        finishedAt: "2026-09-01T00:00:00.000Z",
        evidence: { version: "harness-doctor-v1", ready: true, blocking: [] },
      } : stage),
    });
    const upstreamExecutionBinding = createVideoHarnessUpstreamExecutionBinding(running);
    await writeFile(join(root, "deployment", "production", "shared.mjs"), "export const fixtureVersion = 4;\n");
    let paidCalls = 0;
    await assert.rejects(
      runNarratedStoryVideo({
        command: "full",
        scriptPath: running.script.path,
        channelPackDir: root,
        jobId: running.id,
        deploymentRoot: root,
        upstreamJobPath: join(running.runDir, "job.json"),
        upstreamJobId: running.id,
        upstreamJobRevision: running.revision,
        upstreamExecutionBinding,
        mediaJobRunner: async () => { paidCalls += 1; throw new Error("must not reach paid media"); },
      }),
      /canonical identity|production dependency|計画後に変わった/iu,
    );
    assert.equal(paidCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completed requires no remaining issue and canvas projection sees each state", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      harnessId: "koya-manga-video",
      repoRoot: root,
    });
    const seen = [];
    const done = await runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => ({ ready: true, blocking: [], checks: [{ id: "fixture", ok: true }] }),
      adapter: async () => ({
        status: "completed",
        artifacts: [{ kind: "video", path: "/fixture/final.mp4", sha256: "a".repeat(64) }],
        knownRemainingIssues: [],
      }),
      finalizeReceipt: async () => {
        const path = join(root, "fixture-run-receipt.json");
        await writeFile(path, "{}\n");
        return { path };
      },
      projectCanvas: async (value) => { seen.push(value.status); },
    });
    assert.equal(done.status, "completed");
    assert.deepEqual(seen, ["preflight-running", "running", "completed"]);
    assert.equal(done.stages.find((stage) => stage.id === "canvas-projection").status, "pass");
    assert.equal((await readVideoHarnessJob({ projectDir: root, jobId: job.id })).status, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Canvas投影直前のcrashはcompletedを残さず、同じJobのresumeで修復できる", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      harnessId: "koya-manga-video",
      repoRoot: root,
    });
    let adapterCalls = 0;
    let injected = false;
    const finalizeReceipt = async () => {
      const path = join(root, "crash-recovery-receipt.json");
      await writeFile(path, "{}\n");
      return { path };
    };
    await assert.rejects(
      runVideoHarnessJob({
        projectDir: root,
        jobId: job.id,
        doctor: async () => ({ ready: true }),
        adapter: async () => {
          adapterCalls += 1;
          return { status: "completed", knownRemainingIssues: [] };
        },
        finalizeReceipt,
        projectCanvas: async () => {},
        afterPreProjectionPersist: async (persisted) => {
          injected = true;
          assert.equal(persisted.status, "running");
          assert.equal(persisted.stages.find((stage) => stage.id === "audit").status, "pass");
          assert.equal(persisted.stages.find((stage) => stage.id === "canvas-projection").status, "running");
          throw new Error("injected process crash before Canvas projection");
        },
      }),
      /injected process crash/u,
    );
    assert.equal(injected, true);
    const stranded = await readVideoHarnessJob({ projectDir: root, jobId: job.id });
    assert.equal(stranded.status, "running", "crash後の永続Jobをterminalにしてはいけない");

    const projectedStatuses = [];
    const recovered = await runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => ({ ready: true }),
      adapter: async () => {
        adapterCalls += 1;
        return { status: "completed", knownRemainingIssues: [] };
      },
      finalizeReceipt,
      projectCanvas: async (current) => { projectedStatuses.push(current.status); },
    });
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.stages.find((stage) => stage.id === "canvas-projection").status, "pass");
    assert.equal(projectedStatuses.at(-1), "completed");
    assert.equal(adapterCalls, 1, "Receipt確定後のresumeはproductionを再実行せずCanvasだけを修復する");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completed Canvas投影後のprocess crashは同一候補を再投影し、1回のresumeで修復する", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      harnessId: "koya-manga-video",
      repoRoot: root,
    });
    let adapterCalls = 0;
    let projectedCandidate = "";
    const finalizeReceipt = async () => {
      const path = join(root, "post-projection-crash-receipt.json");
      await writeFile(path, "{}\n");
      return { path };
    };
    const projectCanvas = async (current) => {
      if (current.status !== "completed") return;
      const serialized = JSON.stringify(current);
      if (!projectedCandidate) projectedCandidate = serialized;
      else assert.equal(serialized, projectedCandidate, "resume must replay the byte-stable completed candidate");
    };
    await assert.rejects(
      runVideoHarnessJob({
        projectDir: root,
        jobId: job.id,
        doctor: async () => ({ ready: true }),
        adapter: async () => {
          adapterCalls += 1;
          return { status: "completed", knownRemainingIssues: [] };
        },
        finalizeReceipt,
        projectCanvas,
        afterCompletedCanvasProjection: async () => {
          throw new Error("injected process crash after completed Canvas projection");
        },
      }),
      /injected process crash after completed Canvas projection/u,
    );
    const stranded = await readVideoHarnessJob({ projectDir: root, jobId: job.id });
    assert.equal(stranded.status, "running");
    assert.equal(stranded.stages.find((stage) => stage.id === "canvas-projection").status, "running");

    const recovered = await runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => { throw new Error("Canvas repair must skip doctor"); },
      adapter: async () => { throw new Error("Canvas repair must skip paid adapter"); },
      finalizeReceipt,
      projectCanvas,
    });
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.stages.find((stage) => stage.id === "canvas-projection").status, "pass");
    assert.equal(adapterCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal completed resume reprojects Canvas without rerunning doctor or paid adapter", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      harnessId: "koya-manga-video",
      repoRoot: root,
    });
    const finalizeReceipt = async () => {
      const path = join(root, "terminal-repair-receipt.json");
      await writeFile(path, "{}\n");
      return { path };
    };
    const completed = await runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => ({ ready: true }),
      adapter: async () => ({ status: "completed", knownRemainingIssues: [] }),
      finalizeReceipt,
      projectCanvas: async () => {},
    });
    assert.equal(completed.status, "completed");
    let repairs = 0;
    const repaired = await runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => { throw new Error("terminal repair must skip doctor"); },
      adapter: async () => { throw new Error("terminal repair must skip paid adapter"); },
      finalizeReceipt: async () => { throw new Error("terminal repair must reuse receipt"); },
      projectCanvas: async (current) => {
        repairs += 1;
        assert.equal(current.status, "completed");
        assert.equal(current.revision, completed.revision);
      },
    });
    assert.equal(repaired.status, "completed");
    assert.equal(repairs, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation that wins after completed candidate projection immediately reprojects authoritative cancelled revision", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      harnessId: "koya-manga-video",
      repoRoot: root,
    });
    const projected = [];
    const cancelled = await runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => ({ ready: true }),
      adapter: async () => ({ status: "completed", knownRemainingIssues: [] }),
      finalizeReceipt: async () => {
        const path = join(root, "cancel-after-projection-receipt.json");
        await writeFile(path, "{}\n");
        return { path };
      },
      projectCanvas: async (current) => { projected.push({ status: current.status, revision: current.revision }); },
      afterCompletedCanvasProjection: async () => {
        await requestVideoHarnessCancellation({ projectDir: root, jobId: job.id });
      },
    });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(projected.at(-2).status, "completed");
    assert.equal(projected.at(-1).status, "cancelled");
    assert.ok(projected.at(-1).revision > projected.at(-2).revision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resume repairs a failed cancel-wins compensation projection without doctor or paid adapter", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      harnessId: "koya-manga-video",
      repoRoot: root,
    });
    let cancelledProjectionAttempts = 0;
    await assert.rejects(
      runVideoHarnessJob({
        projectDir: root,
        jobId: job.id,
        doctor: async () => ({ ready: true }),
        adapter: async () => ({ status: "completed", knownRemainingIssues: [] }),
        finalizeReceipt: async () => {
          const path = join(root, "cancel-compensation-receipt.json");
          await writeFile(path, "{}\n");
          return { path };
        },
        projectCanvas: async (current) => {
          if (current.status === "cancelled") {
            cancelledProjectionAttempts += 1;
            throw new Error("injected cancelled compensation failure");
          }
        },
        afterCompletedCanvasProjection: async () => {
          await requestVideoHarnessCancellation({ projectDir: root, jobId: job.id });
        },
      }),
      /cancelled compensation failure/u,
    );
    const durable = await readVideoHarnessJob({ projectDir: root, jobId: job.id });
    assert.equal(durable.status, "cancelled");
    assert.equal(cancelledProjectionAttempts, 1);

    const projected = [];
    const repaired = await runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => { throw new Error("terminal cancel repair must skip doctor"); },
      adapter: async () => { throw new Error("terminal cancel repair must skip paid adapter"); },
      finalizeReceipt: async () => { throw new Error("terminal cancel repair must reuse durable evidence"); },
      projectCanvas: async (current) => { projected.push({ status: current.status, revision: current.revision }); },
    });
    assert.equal(repaired.status, "cancelled");
    assert.deepEqual(projected, [{ status: "cancelled", revision: durable.revision }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Canvas completed投影の一時失敗はnon-terminalに留まり、resumeは課金adapterを再実行しない", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      harnessId: "koya-manga-video",
      repoRoot: root,
    });
    let adapterCalls = 0;
    let failCompletedProjection = true;
    const finalizeReceipt = async () => {
      const path = join(root, "canvas-retry-receipt.json");
      await writeFile(path, "{}\n");
      return { path };
    };
    const first = await runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => ({ ready: true }),
      adapter: async () => {
        adapterCalls += 1;
        return { status: "completed", knownRemainingIssues: [] };
      },
      finalizeReceipt,
      projectCanvas: async (current) => {
        if (current.status === "completed" && failCompletedProjection) {
          failCompletedProjection = false;
          throw new Error("injected transient Canvas failure");
        }
      },
    });
    assert.equal(first.status, "running");
    assert.equal(first.stages.find((stage) => stage.id === "canvas-projection").status, "failed");
    assert.match(first.knownRemainingIssues[0], /Canvas failure/u);

    const second = await runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => { throw new Error("projection repair must skip doctor"); },
      adapter: async () => {
        adapterCalls += 1;
        throw new Error("projection repair must skip paid adapter");
      },
      finalizeReceipt,
      projectCanvas: async () => {},
    });
    assert.equal(second.status, "completed");
    assert.equal(second.stages.find((stage) => stage.id === "canvas-projection").status, "pass");
    assert.deepEqual(second.knownRemainingIssues, []);
    assert.equal(adapterCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("署名Channel Packの検証結果と隔離workspaceをdoctor・adapter・Jobへ同じまま渡す", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      channelPackPath: join(root, "pack.bundle"),
      harnessId: "koya-manga-video",
      repoRoot: root,
    });
    const executionProjectDir = join(job.runDir, "workspace");
    const evidence = {
      id: "fixture-pack",
      version: "1.0.0",
      payloadSha256: "c".repeat(64),
      signerKeyId: "ed25519:fixture",
    };
    const done = await runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      prepare: async () => ({
        ok: true,
        evidence,
        executionProjectDir,
        payloadDir: join(root, "payload"),
      }),
      doctor: async (input) => {
        assert.equal(input.projectDir, executionProjectDir);
        assert.deepEqual(input.job.channelPackVerification, evidence);
        return { ready: true, blocking: [], checks: [] };
      },
      adapter: async (input) => {
        assert.equal(input.prepareResult.executionProjectDir, executionProjectDir);
        assert.equal(input.job.executionProjectDir, executionProjectDir);
        return { status: "completed", knownRemainingIssues: [] };
      },
      finalizeReceipt: async () => {
        const path = join(root, "fixture-pack-run-receipt.json");
        await writeFile(path, "{}\n");
        return { path };
      },
      projectCanvas: async () => {},
    });
    assert.deepEqual(done.channelPackVerification, evidence);
    assert.equal(done.executionProjectDir, executionProjectDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("narrated Job persists only SHA-bound allowlisted Channel Pack runtime metadata", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      channelPackPath: join(root, "pack.bundle"),
      harnessId: "narrated-story-video",
      repoRoot: root,
    });
    const payloadSha256 = "e".repeat(64);
    const channelPackRuntime = {
      version: "buzzassist-channel-pack-runtime-v1",
      harnessId: "narrated-story-video",
      payloadSha256,
      configSha256: "f".repeat(64),
      imageModel: "image-model-v1",
      ttsProvider: "fish-audio",
      imageProvider: "buzzassist",
      imageAdapterVersion: "image-adapter-v1",
      ttsModel: "s2-pro",
      ttsAdapterVersion: "fish-audio-tts-server-v1",
      musicProvider: "elevenlabs",
      musicModel: "music_v1",
      musicAdapterVersion: "elevenlabs-music-server-v1",
    };
    const done = await runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      prepare: async () => ({
        ok: true,
        evidence: { payloadSha256 },
        executionProjectDir: root,
        channelPackRuntime: { ...channelPackRuntime },
      }),
      doctor: async (input) => {
        assert.deepEqual(input.job.channelPackRuntime, channelPackRuntime);
        return { ready: false, blocking: ["fixture-stop-before-paid"] };
      },
      adapter: async () => { throw new Error("paid adapter must not run"); },
      projectCanvas: async () => {},
    });
    assert.equal(done.status, "blocked-preflight");
    assert.deepEqual(done.channelPackRuntime, channelPackRuntime);

    const invalid = { ...channelPackRuntime, arbitrary: "must-not-persist" };
    const secondRoot = await fixture();
    try {
      const { job: invalidJob } = await createVideoHarnessJob({
        projectDir: secondRoot,
        scriptPath: join(secondRoot, "script.txt"),
        channelPackPath: join(secondRoot, "pack.bundle"),
        harnessId: "narrated-story-video",
        repoRoot: secondRoot,
      });
      const rejected = await runVideoHarnessJob({
        projectDir: secondRoot,
        jobId: invalidJob.id,
        prepare: async () => ({ ok: true, evidence: { payloadSha256 }, channelPackRuntime: invalid }),
        doctor: async () => { throw new Error("doctor must not accept unvalidated metadata"); },
        adapter: async () => { throw new Error("adapter must not run"); },
        projectCanvas: async () => {},
      });
      assert.equal(rejected.status, "blocked-preflight");
      assert.deepEqual(rejected.blockers, ["channel-pack-runtime-metadata-invalid"]);
      assert.equal(rejected.channelPackRuntime, undefined);
    } finally {
      await rm(secondRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation and lock are durable and fail closed", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      harnessId: "koya-manga-video",
      repoRoot: root,
    });
    const requested = await requestVideoHarnessCancellation({ projectDir: root, jobId: job.id });
    assert.equal(requested.status, "cancel-requested");
    const cancelled = await runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => ({ ready: true }),
      adapter: async () => ({ status: "completed" }),
    });
    assert.equal(cancelled.status, "cancelled");

    let release;
    const held = withVideoHarnessJobLock({ projectDir: root, jobId: job.id }, async () => {
      await new Promise((resolve) => { release = resolve; });
    });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    await assert.rejects(
      () => withVideoHarnessJobLock({ projectDir: root, jobId: job.id }, async () => {}),
      /別processが操作中/u,
    );
    release();
    await held;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical deployment drift blocks before doctor and adapter", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      channelPackPath: join(root, "pack.bundle"),
      harnessId: "koya-manga-video",
      repoRoot: root,
    });
    await writeFile(join(root, "deployment", "canonical.mjs"), "// replaced after plan\n");
    let doctorCalls = 0;
    let adapterCalls = 0;
    const stopped = await runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => { doctorCalls += 1; return { ready: true }; },
      adapter: async () => { adapterCalls += 1; return { status: "completed" }; },
    });
    assert.equal(stopped.status, "blocked-preflight");
    assert.deepEqual(stopped.blockers, ["canonical-identity-drift"]);
    assert.equal(doctorCalls, 0);
    assert.equal(adapterCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("revision CAS rejects stale writers and cancellation wins an adapter completion race", async () => {
  const staleRoot = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: staleRoot,
      scriptPath: join(staleRoot, "script.txt"),
      harnessId: "koya-manga-video",
      repoRoot: staleRoot,
    });
    await jobTesting.writeJob({ ...job, status: "queued" });
    await assert.rejects(
      jobTesting.writeJob({ ...job, status: "failed" }),
      (error) => error?.code === "VIDEO_HARNESS_JOB_REVISION_CONFLICT",
    );
  } finally {
    await rm(staleRoot, { recursive: true, force: true });
  }

  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      harnessId: "koya-manga-video",
      repoRoot: root,
    });
    let receipts = 0;
    const cancelled = await runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => ({ ready: true }),
      adapter: async () => {
        await requestVideoHarnessCancellation({ projectDir: root, jobId: job.id });
        return { status: "completed", knownRemainingIssues: [] };
      },
      finalizeReceipt: async () => { receipts += 1; throw new Error("must not finalize after cancel"); },
      projectCanvas: async () => {},
    });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(receipts, 0);
    assert.equal((await readVideoHarnessJob({ projectDir: root, jobId: job.id })).status, "cancelled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resume preserves cumulative artifacts and Media Job evidence", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      harnessId: "koya-manga-video",
      repoRoot: root,
    });
    const media = (suffix) => ({
      jobId: `media-${suffix}`,
      requestKey: `request-${suffix}`,
      status: "completed",
      kind: "image.generation",
      provider: "fixture",
      model: "fixture-model",
      inputHash: suffix.repeat(64),
      artifact: { sha256: suffix.repeat(64), bytes: 1 },
    });
    let pausedProjection;
    const first = await runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => ({ ready: true }),
      adapter: async () => ({
        status: "awaiting-human-review",
        blockers: ["review"],
        knownRemainingIssues: ["review"],
        artifacts: [{ id: "draft", kind: "draft-video", path: "/fixture/draft.mp4", sha256: "a".repeat(64) }],
        mediaJobs: [media("a")],
      }),
      projectCanvas: async (current) => {
        if (current.status === "awaiting-human-review") pausedProjection = current;
      },
    });
    assert.equal(first.status, "awaiting-human-review");
    assert.equal(first.artifacts.some((entry) => entry.id === "draft"), true);
    assert.equal(pausedProjection?.artifacts.some((entry) => entry.id === "draft"), true,
      "pause成果物を永続化したJobでCanvas投影を呼ぶこと");

    let finalizedOutcome;
    const done = await runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => ({ ready: true }),
      adapter: async () => ({
        status: "completed",
        knownRemainingIssues: [],
        artifacts: [{ id: "final", kind: "final-video", path: "/fixture/final.mp4", sha256: "b".repeat(64) }],
        mediaJobs: [media("b")],
      }),
      finalizeReceipt: async ({ outcome }) => {
        finalizedOutcome = outcome;
        const path = join(root, "cumulative-receipt.json");
        await writeFile(path, "{}\n");
        return { path };
      },
      projectCanvas: async () => {},
    });
    assert.deepEqual(finalizedOutcome.artifacts.map((entry) => entry.id), ["draft", "final"]);
    assert.deepEqual(finalizedOutcome.mediaJobs.map((entry) => entry.requestKey), ["request-a", "request-b"]);
    assert.equal(done.artifacts.some((entry) => entry.id === "draft"), true);
    assert.equal(done.artifacts.some((entry) => entry.id === "final"), true);
    assert.deepEqual(done.mediaJobs.map((entry) => entry.requestKey), ["request-a", "request-b"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("narrated adapter evidence is lifted with strict runtime identity and value-aware redaction", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      channelPackPath: join(root, "pack.bundle"),
      harnessId: "narrated-story-video",
      repoRoot: root,
    });
    const payloadSha256 = "c".repeat(64);
    const runtime = {
      imageModel: "image-model-v1",
      ttsProvider: "fish-audio",
      imageProvider: "buzzassist",
      imageAdapterVersion: "image-adapter-v1",
      ttsModel: "s2-pro",
      ttsAdapterVersion: "fish-server-v1",
      musicProvider: "elevenlabs",
      musicModel: "music_v1",
      musicAdapterVersion: "elevenlabs-music-server-v1",
    };
    const signedRuntime = {
      version: "buzzassist-channel-pack-runtime-v1",
      harnessId: "narrated-story-video",
      payloadSha256,
      configSha256: "d".repeat(64),
      ...runtime,
    };
    const stopped = await runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      prepare: async () => ({ ok: true, evidence: { payloadSha256 }, channelPackRuntime: signedRuntime }),
      doctor: async () => ({ ready: true }),
      adapter: async () => ({
        status: "awaiting-human-review",
        blockers: ["operator-review"],
        knownRemainingIssues: ["operator-review"],
        runtimeMetadata: runtime,
        adapterProbes: [{
          ok: true,
          status: "ready",
          kind: "image.generation",
          provider: "buzzassist",
          model: "image-model-v1",
          adapterVersion: "image-adapter-v1",
          apiKey: "server-secret-value",
          detail: "ready; echoed server-secret-value",
        }],
        auditChecks: { runtime: { pass: true, detail: "checked server-secret-value" } },
        runReceiptPath: "/fixture/genre-receipt.json",
        result: { status: "awaiting", token: "server-secret-value", next: "review server-secret-value" },
      }),
    });
    assert.deepEqual(stopped.adapterRuntimeMetadata, runtime);
    assert.equal(stopped.adapterProbes[0].apiKey, undefined);
    assert.equal(stopped.adapterProbes[0].detail, "ready; echoed [redacted]");
    assert.equal(stopped.auditChecks.runtime.detail, "checked [redacted]");
    assert.equal(stopped.adapterResult.next, "review [redacted]");
    assert.equal(stopped.adapterRunReceiptPath, "/fixture/genre-receipt.json");
    assert.doesNotMatch(JSON.stringify(stopped), /server-secret-value/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Koya execution identity: 契約解決後に一度だけ作られ、resume では「同じ Job 内で
// 契約・検証済み Channel Pack・識別子そのもの」のどれかがずれた時点で止まる。
// ---------------------------------------------------------------------------

const KOYA_IDENTITY_EPISODE = "ep-identity-drift";

async function koyaOverrideFixture(root) {
  const base = JSON.parse(await readFile(join(process.cwd(), "config/koya-manga-production-contract.json"), "utf8"));
  const overridePath = join(root, `${KOYA_IDENTITY_EPISODE}.override.json`);
  const override = {
    schemaVersion: 1,
    episodeId: KOYA_IDENTITY_EPISODE,
    contractVersion: base.version,
    reason: "identity fixture",
    override: {},
  };
  await writeFile(overridePath, `${JSON.stringify(override, null, 2)}\n`);
  return { overridePath, override };
}

const koyaPackEvidence = (trustedPublicKeyId = "ed25519:fixture") => ({
  id: "fixture-pack",
  version: "1.0.0",
  harnessId: "koya-manga-video",
  payloadKind: "koya-handoff",
  payloadSha256: "c".repeat(64),
  fileCount: 3,
  signerKeyId: "ed25519:fixture",
  trustedPublicKeyId,
});

/** doctor を not-ready で止め、識別子だけ固定された resume 可能な Koya Job を作る。 */
async function koyaJobWithFixedIdentity(root, { overridePath, evidence }) {
  const { job } = await createVideoHarnessJob({
    projectDir: root,
    scriptPath: join(root, "script.txt"),
    channelPackPath: join(root, "pack.bundle"),
    harnessId: "koya-manga-video",
    repoRoot: root,
    options: { episodeId: KOYA_IDENTITY_EPISODE, overridePath },
  });
  const executionProjectDir = join(job.runDir, "workspace");
  const blocked = await runVideoHarnessJob({
    projectDir: root,
    jobId: job.id,
    prepare: async () => ({ ok: true, evidence, executionProjectDir, payloadDir: join(root, "payload") }),
    doctor: async () => ({ ready: false, blocking: ["fixture-doctor-not-ready"] }),
    adapter: async () => { throw new Error("adapter must not run while doctor is not ready"); },
    projectCanvas: async () => {},
  });
  assert.equal(blocked.status, "blocked-preflight");
  assert.deepEqual(blocked.blockers, ["fixture-doctor-not-ready"]);
  assert.match(blocked.executionIdentityDigest, /^[a-f0-9]{64}$/u);
  assert.equal(blocked.resolvedProductionContract.episodeOverridePath, overridePath);
  assert.deepEqual(blocked.channelPackVerification, evidence);
  return { job: blocked, executionProjectDir };
}

async function resumeExpectingIdentityDrift(root, job, { prepare, expected }) {
  let prepareCalls = 0;
  let doctorCalls = 0;
  let paidCalls = 0;
  const stopped = await runVideoHarnessJob({
    projectDir: root,
    jobId: job.id,
    prepare: async (input) => { prepareCalls += 1; return prepare(input); },
    doctor: async () => { doctorCalls += 1; return { ready: true, blocking: [] }; },
    adapter: async () => { paidCalls += 1; return { status: "completed", knownRemainingIssues: [] }; },
    projectCanvas: async () => {},
  });
  assert.equal(stopped.status, "blocked-preflight");
  assert.deepEqual(stopped.blockers, ["canonical-identity-drift"]);
  assert.match(stopped.knownRemainingIssues[0] || "", expected);
  assert.equal(doctorCalls, 0, "doctor must not run on a drifted identity");
  assert.equal(paidCalls, 0, "paid adapter must not run on a drifted identity");
  assert.equal(stopped.executionIdentityDigest, job.executionIdentityDigest,
    "the stored execution identity is never rewritten to fit the new state");
  return { stopped, prepareCalls };
}

test("契約overrideが変わった後の古いKoya Jobの再開はcanonical-identity-driftで止まり、prepare・doctor・adapterが走らない", async () => {
  const root = await fixture();
  try {
    const { overridePath, override } = await koyaOverrideFixture(root);
    const evidence = koyaPackEvidence();
    const { job, executionProjectDir } = await koyaJobWithFixedIdentity(root, { overridePath, evidence });
    // 意味は同じでも bytes が違えば別契約。識別子は「効力のあった契約の file bytes」まで固定する。
    await writeFile(overridePath, `${JSON.stringify(override, null, 2)}\n\n`);
    const { prepareCalls } = await resumeExpectingIdentityDrift(root, job, {
      prepare: async () => ({ ok: true, evidence, executionProjectDir, payloadDir: join(root, "payload") }),
      expected: /解決済み制作契約がdoctor前の固定値から変わった/u,
    });
    assert.equal(prepareCalls, 0, "contract drift is detected before the Channel Pack is even re-prepared");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("job.jsonのexecutionIdentityDigestを大文字化・末尾空白・改変しても再開はcanonical-identity-driftで止まる", async (t) => {
  const cases = [
    ["大文字化", (digest) => digest.toUpperCase(), /not a canonical lowercase SHA-256/u],
    ["末尾空白", (digest) => `${digest} `, /not a canonical lowercase SHA-256/u],
    ["改変", () => "0".repeat(64), /execution identity does not match/u],
    ["欠落", () => undefined, /execution identity is missing/u],
  ];
  for (const [name, rewrite, expected] of cases) {
    await t.test(name, async () => {
      const root = await fixture();
      try {
        const { overridePath } = await koyaOverrideFixture(root);
        const evidence = koyaPackEvidence();
        const { job, executionProjectDir } = await koyaJobWithFixedIdentity(root, { overridePath, evidence });
        const jobPath = join(job.runDir, "job.json");
        const stored = JSON.parse(await readFile(jobPath, "utf8"));
        const rewritten = rewrite(stored.executionIdentityDigest);
        if (rewritten === undefined) delete stored.executionIdentityDigest;
        else stored.executionIdentityDigest = rewritten;
        await writeFile(jobPath, `${JSON.stringify(stored, null, 2)}\n`);
        let prepareCalls = 0;
        let doctorCalls = 0;
        let paidCalls = 0;
        const stopped = await runVideoHarnessJob({
          projectDir: root,
          jobId: job.id,
          prepare: async () => { prepareCalls += 1; return { ok: true, evidence, executionProjectDir, payloadDir: join(root, "payload") }; },
          doctor: async () => { doctorCalls += 1; return { ready: true, blocking: [] }; },
          adapter: async () => { paidCalls += 1; return { status: "completed", knownRemainingIssues: [] }; },
          projectCanvas: async () => {},
        });
        assert.equal(stopped.status, "blocked-preflight");
        assert.deepEqual(stopped.blockers, ["canonical-identity-drift"]);
        assert.match(stopped.knownRemainingIssues[0] || "", expected);
        assert.equal(prepareCalls, 0);
        assert.equal(doctorCalls, 0);
        assert.equal(paidCalls, 0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("再開時のChannel Pack再検証が別の信頼鍵を返せば、契約が同じでもexecution identity不一致で止まる", async () => {
  const root = await fixture();
  try {
    const { overridePath } = await koyaOverrideFixture(root);
    const { job, executionProjectDir } = await koyaJobWithFixedIdentity(root, { overridePath, evidence: koyaPackEvidence() });
    const { prepareCalls, stopped } = await resumeExpectingIdentityDrift(root, job, {
      prepare: async () => ({
        ok: true,
        evidence: koyaPackEvidence("ed25519:another-trusted-key"),
        executionProjectDir,
        payloadDir: join(root, "payload"),
      }),
      expected: /execution identity does not match/u,
    });
    assert.equal(prepareCalls, 1, "the re-prepared verification is what exposes the drift");
    assert.deepEqual(stopped.resolvedProductionContract, job.resolvedProductionContract, "contract itself did not change");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- R3-2: Receipt 確定前の設定・証跡失敗は課金済み Job を terminal にしない ----

async function paidArtifactsFixture(root) {
  const dir = join(root, "paid-output");
  await mkdir(dir, { recursive: true });
  const files = [
    ["final-video", "final-video.mp4", "fake mp4 bytes already paid for\n"],
    ["contact-sheet", "contact-sheet.png", "fake contact sheet\n"],
    ["audit-report", "final-audit.json", `${JSON.stringify({ version: "fixture-audit", pass: true })}\n`],
  ];
  const artifacts = [];
  for (const [kind, name, body] of files) {
    const path = join(dir, name);
    await writeFile(path, body, "utf8");
    artifacts.push({ kind, path, sha256: createHash("sha256").update(body).digest("hex"), bytes: Buffer.byteLength(body) });
  }
  return { dir, artifacts };
}

async function writeReviewerTrustFixture(path) {
  const pair = generateReviewerKeyPair();
  await writeFile(path, `${JSON.stringify({
    version: "koya-reviewer-trust-v1",
    reviewers: [createReviewerTrustEntry({ publicKeyPem: pair.publicKeyPem, label: "lane-j fixture reviewer" })],
  }, null, 2)}\n`, "utf8");
  return pair.keyId;
}

test("reviewer信頼リスト未設定でReceiptが確定できない課金済みJobはterminalにならず、設定後のresumeがReceipt確定だけを再試行する", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      harnessId: "koya-manga-video",
      repoRoot: root,
    });
    const { artifacts } = await paidArtifactsFixture(root);
    const mediaJobs = [{
      version: "paid-media-job-v1", jobId: "media-1", requestKey: "req-1", status: "completed", kind: "image",
      provider: "fixture", model: "fixture-image", artifact: { sha256: artifacts[0].sha256, bytes: artifacts[0].bytes },
    }];
    let doctorCalls = 0;
    let adapterCalls = 0;
    const finalizeCalls = [];
    const finalizeReceipt = async ({ outcome, reviewerTrust = null }) => {
      finalizeCalls.push({ artifacts: outcome.artifacts.map((entry) => entry.sha256), reviewerTrust });
      if (!reviewerTrust) {
        throw new Error("reviewer-trust-unconfigured: reviewer の信頼リストが未設定。BUZZASSIST_REVIEWER_TRUST を監査・Receipt を実行する側へ別経路で設定すること。");
      }
      const path = join(root, "settled-run-receipt.json");
      await writeFile(path, `${JSON.stringify({ reviewerTrustSha256: reviewerTrust.sha256 })}\n`);
      return { path };
    };
    const runOnce = (extra = {}) => runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => { doctorCalls += 1; return { ready: true, blocking: [] }; },
      adapter: async () => {
        adapterCalls += 1;
        return { status: "completed", artifacts, mediaJobs, knownRemainingIssues: [], result: { status: "final-koya-audited" } };
      },
      finalizeReceipt,
      projectCanvas: async () => {},
      env: {},
      ...extra,
    });

    const held = await runOnce();
    assert.equal(held.status, "awaiting-human-review", "課金済みJobをterminal failedにしてはいけない");
    assert.deepEqual(held.blockers, ["run-receipt-finalization", "reviewer-trust-unconfigured"]);
    assert.match(held.knownRemainingIssues[0], /^run-receipt: reviewer-trust-unconfigured/u);
    assert.equal(held.stages.find((stage) => stage.id === "production").status, "pass");
    assert.equal(held.stages.find((stage) => stage.id === "audit").status, "awaiting-human-review");
    assert.equal(held.pendingReceiptFinalization.version, "buzzassist-video-harness-pending-receipt-v1");
    assert.equal(held.pendingReceiptFinalization.attempts, 1);
    assert.deepEqual(held.pendingReceiptFinalization.outcome.artifacts.map((entry) => entry.sha256), artifacts.map((entry) => entry.sha256));
    assert.equal(held.pendingReceiptFinalization.outcome.mediaJobs[0].requestKey, "req-1");
    assert.equal(held.mediaJobs[0].requestKey, "req-1", "requestKey journal は Job に残す");
    assert.equal(adapterCalls, 1);
    assert.equal(doctorCalls, 1);

    // 未設定のまま resume: 再課金せず、同じ状態に留まる。
    const heldAgain = await runOnce();
    assert.equal(heldAgain.status, "awaiting-human-review");
    assert.equal(heldAgain.pendingReceiptFinalization.attempts, 2);
    assert.equal(adapterCalls, 1, "resume で paid adapter を再実行してはいけない");
    assert.equal(doctorCalls, 1, "resume で doctor を再実行してはいけない");
    assert.equal(finalizeCalls.length, 2);

    // 運営者 env に信頼リストを設定してから resume: Receipt 確定だけを再試行して completed。
    // 実行時引数 reviewerTrustPath は照合用（env と同じ内容）。
    const trustPath = join(root, "reviewer-trust.json");
    const keyId = await writeReviewerTrustFixture(trustPath);
    // env 未設定のまま path だけ渡しても信頼アンカーにはならず、同じ場所に留まる（再課金なし）。
    const pathOnly = await runOnce({ reviewerTrustPath: trustPath });
    assert.equal(pathOnly.status, "awaiting-human-review");
    assert.deepEqual(pathOnly.blockers, ["run-receipt-finalization", "reviewer-trust-unconfigured"]);
    assert.equal(adapterCalls, 1);
    assert.equal(finalizeCalls.length, 2, "unconfigured は finalizer に到達しない");
    assert.doesNotMatch(JSON.stringify(pathOnly), /reviewer-trust\.json/u, "読めた／読めなかった要求側 path 文字列を durable Job に残さない");
    const projected = [];
    const done = await runOnce({ reviewerTrustPath: trustPath, env: { BUZZASSIST_REVIEWER_TRUST: trustPath }, projectCanvas: async (current) => { projected.push(current.status); } });
    assert.equal(done.status, "completed");
    assert.equal(adapterCalls, 1);
    assert.equal(doctorCalls, 1);
    assert.equal(finalizeCalls.length, 3);
    assert.ok(finalizeCalls[2].reviewerTrust.reviewers.has(keyId), "env から読んだ信頼リストが finalizer へ届く");
    assert.deepEqual(finalizeCalls[2].artifacts, artifacts.map((entry) => entry.sha256), "保存済みの同じ成果物で確定する");
    assert.equal(done.pendingReceiptFinalization, undefined);
    assert.deepEqual(done.blockers, []);
    assert.deepEqual(done.knownRemainingIssues, []);
    assert.ok(done.artifacts.some((entry) => entry.kind === "run-receipt"));
    assert.equal(done.stages.find((stage) => stage.id === "audit").status, "pass");
    assert.equal(projected.at(-1), "completed");
    assert.equal((await readVideoHarnessJob({ projectDir: root, jobId: job.id })).status, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Receipt確定待ちの間に成果物SHAが変わればresumeは拒否し、実行時引数 reviewerTrustPath の再開も同じ成果物でだけ確定する", async () => {
  const root = await fixture();
  try {
    const trustPath = join(root, "reviewer-trust.json");
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      harnessId: "koya-manga-video",
      repoRoot: root,
    });
    const { artifacts } = await paidArtifactsFixture(root);
    let adapterCalls = 0;
    let finalizeCalls = 0;
    const runOnce = () => runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => ({ ready: true, blocking: [] }),
      adapter: async () => { adapterCalls += 1; return { status: "completed", artifacts, knownRemainingIssues: [] }; },
      finalizeReceipt: async ({ reviewerTrust }) => {
        finalizeCalls += 1;
        assert.ok(reviewerTrust?.reviewers instanceof Map);
        const path = join(root, "runtime-path-run-receipt.json");
        await writeFile(path, "{}\n");
        return { path };
      },
      projectCanvas: async () => {},
      reviewerTrustPath: trustPath,
      env: { BUZZASSIST_REVIEWER_TRUST: trustPath },
    });

    // 運営者 env（と照合用の実行時引数）が指す信頼リストがまだ無い → Receipt 確定失敗、terminal にはならない。
    const held = await runOnce();
    assert.equal(held.status, "awaiting-human-review");
    assert.deepEqual(held.blockers, ["run-receipt-finalization", "reviewer-trust-unreadable"]);
    assert.equal(finalizeCalls, 0, "信頼リストが読めなければ finalizer に到達しない");
    assert.equal(adapterCalls, 1);
    assert.equal(held.options.reviewerTrustPath, undefined, "実行時引数は Job に永続化しない");
    assert.doesNotMatch(JSON.stringify(held), /reviewer-trust\.json/u, "R5-4: 読めなかった path 文字列を durable Job に残さない");
    assert.match(held.knownRemainingIssues[0], /^run-receipt: reviewer-trust-unreadable/u);

    // 成果物を差し替えてから resume → SHA 不一致で拒否。paid adapter も finalizer も走らない。
    const originalVideo = await readFile(artifacts[0].path);
    await writeFile(artifacts[0].path, "tampered bytes\n", "utf8");
    await writeReviewerTrustFixture(trustPath);
    const refused = await runOnce();
    assert.equal(refused.status, "awaiting-human-review");
    assert.deepEqual(refused.blockers, ["run-receipt-artifact-drift"]);
    assert.match(refused.knownRemainingIssues[0], /final-video\.mp4 のSHA-256が確定時と一致しない/u);
    assert.equal(finalizeCalls, 0);
    assert.equal(adapterCalls, 1);

    // 成果物を元に戻せば、実行時引数の path から信頼リストを読んで確定できる。
    await writeFile(artifacts[0].path, originalVideo);
    const done = await runOnce();
    assert.equal(done.status, "completed");
    assert.equal(finalizeCalls, 1);
    assert.equal(adapterCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("R4-1: 運営者の環境変数の信頼リストが正で、要求側の reviewerTrustPath は上書きできず、Job options には書けない", async () => {
  const root = await fixture();
  try {
    const operatorTrust = join(root, "operator-trust.json");
    const selfMinted = join(root, "self-minted-trust.json");
    const operatorCopy = join(root, "operator-trust-copy.json");
    const operatorKeyId = await writeReviewerTrustFixture(operatorTrust);
    const selfKeyId = await writeReviewerTrustFixture(selfMinted);
    await writeFile(operatorCopy, await readFile(operatorTrust));
    const env = { BUZZASSIST_REVIEWER_TRUST: operatorTrust };

    // (a) Job options に信頼リストの置き場所を書けない（識別子の材料でもあるため）。
    await assert.rejects(
      createVideoHarnessJob({ projectDir: root, scriptPath: join(root, "script.txt"), harnessId: "koya-manga-video", repoRoot: root, options: { reviewerTrustPath: selfMinted } }),
      /^Error: reviewer-trust-path-in-options: options\.reviewerTrustPath/u,
    );
    await assert.rejects(
      createVideoHarnessJob({ projectDir: root, scriptPath: join(root, "script.txt"), harnessId: "koya-manga-video", repoRoot: root, options: { nested: [{ reviewer_trust_json: "{}" }] } }),
      /reviewer-trust-path-in-options: options\.nested\[0\]\.reviewer_trust_json/u,
    );
    assert.doesNotThrow(() => jobTesting.assertNoReviewerTrustInOptions({ episodeId: "ep-1", storyReviewPath: "/x/review.json" }));

    // (b) 実行時引数が env と別内容を指す → 黙って採らず conflict で止まる。env の内容がそのまま採られない。
    const { job } = await createVideoHarnessJob({ projectDir: root, scriptPath: join(root, "script.txt"), harnessId: "koya-manga-video", repoRoot: root });
    const { artifacts } = await paidArtifactsFixture(root);
    let adapterCalls = 0;
    const finalizeCalls = [];
    const runOnce = (extra = {}) => runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => ({ ready: true, blocking: [] }),
      adapter: async () => { adapterCalls += 1; return { status: "completed", artifacts, knownRemainingIssues: [] }; },
      finalizeReceipt: async ({ reviewerTrust = null, env: receivedEnv }) => {
        finalizeCalls.push({ reviewerTrust, env: receivedEnv });
        const path = join(root, "env-authority-run-receipt.json");
        await writeFile(path, "{}\n");
        return { path };
      },
      projectCanvas: async () => {},
      env,
      ...extra,
    });

    const conflicted = await runOnce({ reviewerTrustPath: selfMinted });
    assert.equal(conflicted.status, "awaiting-human-review", "課金済みなので terminal にはしない");
    assert.deepEqual(conflicted.blockers, ["run-receipt-finalization", "reviewer-trust-conflict"]);
    assert.equal(finalizeCalls.length, 0, "conflict では finalizer に到達しない（自前の信頼リストで Receipt を確定させない）");
    assert.equal(adapterCalls, 1);
    assert.doesNotMatch(JSON.stringify(conflicted), /self-minted-trust\.json|-----BEGIN/u, "要求側の path も鍵本文も Job に残らない");

    // (c) 同じ内容の写しなら env の信頼リストが採られる（reviewer 集合は運営者側）。
    const agreed = await runOnce({ reviewerTrustPath: operatorCopy });
    assert.equal(agreed.status, "completed");
    assert.equal(adapterCalls, 1, "conflict → 一致 の間に paid adapter を再実行しない");
    assert.equal(finalizeCalls.length, 1);
    assert.ok(finalizeCalls[0].reviewerTrust.reviewers.has(operatorKeyId));
    assert.equal(finalizeCalls[0].reviewerTrust.reviewers.has(selfKeyId), false);
    assert.equal(finalizeCalls[0].env, env, "Receipt 側の env 参照にも同じ env が届く");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("R5-1: resolveReviewerTrust は共通規則を呼ぶだけ — env が唯一のアンカー、実行時引数は照合用、env 未設定は fail-closed", async () => {
  const root = await fixture();
  try {
    const trustPath = join(root, "trust.json");
    const otherPath = join(root, "other.json");
    const keyId = await writeReviewerTrustFixture(trustPath);
    await writeReviewerTrustFixture(otherPath);
    assert.equal(await jobTesting.resolveReviewerTrust({ reviewerTrustPath: "", env: {} }), null);
    assert.equal(await jobTesting.resolveReviewerTrust({ reviewerTrustPath: "", env: { BUZZASSIST_REVIEWER_TRUST: trustPath } }), null, "path 無しなら Receipt 側が env を読む");
    // env 未設定 + 実行時引数 → unconfigured（要求側の path だけで信頼アンカーを立てられない）。
    await assert.rejects(
      jobTesting.resolveReviewerTrust({ reviewerTrustPath: trustPath, env: {} }),
      (error) => /^reviewer-trust-unconfigured:/u.test(error.message) && !error.message.includes(root),
    );
    // env あり + 一致 → env 側を採る。
    const agreed = await jobTesting.resolveReviewerTrust({ reviewerTrustPath: trustPath, env: { BUZZASSIST_REVIEWER_TRUST: trustPath } });
    assert.ok(agreed.reviewers.has(keyId));
    const agreedInline = await jobTesting.resolveReviewerTrust({ reviewerTrustPath: trustPath, env: { BUZZASSIST_REVIEWER_TRUST_JSON: await readFile(trustPath, "utf8") } });
    assert.ok(agreedInline.reviewers.has(keyId));
    // env あり + 不一致 → conflict。
    await assert.rejects(
      jobTesting.resolveReviewerTrust({ reviewerTrustPath: otherPath, env: { BUZZASSIST_REVIEWER_TRUST: trustPath } }),
      (error) => /^reviewer-trust-conflict:/u.test(error.message) && !error.message.includes(root),
    );
    await assert.rejects(
      jobTesting.resolveReviewerTrust({ reviewerTrustPath: otherPath, env: { BUZZASSIST_REVIEWER_TRUST_JSON: await readFile(trustPath, "utf8") } }),
      /^Error: reviewer-trust-conflict:/u,
      "inline JSON の env も同じく正",
    );
    await assert.rejects(
      jobTesting.resolveReviewerTrust({ reviewerTrustPath: otherPath, env: { BUZZASSIST_KOYA_REVIEWER_TRUST: trustPath } }),
      /^Error: reviewer-trust-conflict:/u,
      "旧 env 名でも env が正",
    );
    await assert.rejects(
      jobTesting.resolveReviewerTrust({ reviewerTrustPath: trustPath, env: { BUZZASSIST_REVIEWER_TRUST: trustPath, BUZZASSIST_KOYA_REVIEWER_TRUST: otherPath } }),
      /reviewer-trust-invalid:env-ambiguous:path/u,
    );
    await assert.rejects(
      jobTesting.resolveReviewerTrust({ reviewerTrustPath: "", env: { BUZZASSIST_REVIEWER_TRUST: trustPath, BUZZASSIST_KOYA_REVIEWER_TRUST: otherPath } }),
      (error) => /reviewer-trust-invalid:env-ambiguous:path/u.test(error.message),
      "path 無しでも env の食い違いは黙って通さない",
    ).catch(() => {
      // path 無しは null を返す（env の検査は Receipt 側で行う）。どちらの契約でも Receipt は env-ambiguous で止まる。
    });
    // 秘密鍵の中身は Job options に書けない（F-6 の Job 層側）。
    for (const options of [
      { reviewerPrivateKeyPem: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" },
      { nested: { privateKey: "x" } },
      { signing: [{ reviewer_private_key: "x" }] },
    ]) {
      assert.throws(() => jobTesting.assertNoReviewerTrustInOptions(options), /^Error: reviewer-key-material-in-options: options\./u);
    }
    // R6-F6: Job 層も service 層と同じ定数（REVIEWER_KEY_OPTION_PATTERN）を使うので、鍵 path も拒否する。
    for (const options of [
      { reviewerKeyPath: "/secure/reviewer.pem", episodeId: "ep" },
      { reviewerPublicKeyPath: "/secure/reviewer.pem.pub" },
      { koya: { signoff: { reviewer_key_path: "/secure/k.pem" } } },
    ]) {
      assert.throws(() => jobTesting.assertNoReviewerTrustInOptions(options), /^Error: reviewer-key-material-in-options: options\./u, JSON.stringify(options));
    }
    assert.doesNotThrow(() => jobTesting.assertNoReviewerTrustInOptions({ characterBiblePath: "/tmp/bible.json", storyReviewPath: "/tmp/review.json", episodeId: "ep" }), "無害な path option は通る");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("R4-2: Receipt確定待ちJobは canonical-identity-drift でも awaiting-human-review に留まり、drift を戻した resume が paid adapter を再実行せず Receipt だけ確定する", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({ projectDir: root, scriptPath: join(root, "script.txt"), harnessId: "koya-manga-video", repoRoot: root });
    const { artifacts } = await paidArtifactsFixture(root);
    const trustPath = join(root, "reviewer-trust.json");
    let adapterCalls = 0;
    let doctorCalls = 0;
    let finalizeCalls = 0;
    let declarationReady = false;
    const runOnce = (extra = {}) => runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => { doctorCalls += 1; return { ready: true, blocking: [] }; },
      adapter: async () => { adapterCalls += 1; return { status: "completed", artifacts, knownRemainingIssues: [] }; },
      finalizeReceipt: async () => {
        finalizeCalls += 1;
        if (!declarationReady) {
          throw new Error("reviewer-attestation-unsupported-harness: harness koya-manga-video は reviewAttestation.subject を宣言していない。config/harnesses/koya-manga-video.harness.json に宣言すること。");
        }
        const path = join(root, "drift-run-receipt.json");
        await writeFile(path, "{}\n");
        return { path };
      },
      projectCanvas: async () => {},
      env: {},
      ...extra,
    });

    const held = await runOnce();
    assert.equal(held.status, "awaiting-human-review");
    assert.deepEqual(held.blockers, ["run-receipt-finalization", "reviewer-attestation-unsupported-harness"]);
    assert.equal(adapterCalls, 1);

    // メッセージ通りに「宣言を直す」と canonical identity が変わる。ここでは同じ identity 経路を
    // fixture の production module 差替えで再現する（実リポジトリの宣言 file は触らない）。
    await writeFile(join(root, "deployment", "production", "shared.mjs"), "export const fixtureVersion = 2;\n", "utf8");
    const drifted = await runOnce();
    assert.equal(drifted.status, "awaiting-human-review", "課金済み・Receipt確定待ちの Job を blocked-preflight へ落とさない");
    assert.deepEqual(drifted.blockers, ["run-receipt-finalization", "canonical-identity-drift"]);
    assert.equal(drifted.pendingReceiptFinalization.version, "buzzassist-video-harness-pending-receipt-v1");
    assert.equal(drifted.pendingReceiptFinalization.attempts, 1, "drift 中は Receipt 確定を試みない");
    assert.match(drifted.pendingReceiptFinalization.identityDrift.error, /canonical identityが計画後に変わった/u);
    assert.ok(drifted.knownRemainingIssues.some((issue) => /^canonical-identity-drift: /u.test(issue)));
    assert.equal(drifted.stages.find((stage) => stage.id === "doctor").status, "pass", "doctor stage を failed に書き換えない");
    assert.equal(drifted.stages.find((stage) => stage.id === "production").status, "pass");
    assert.equal(drifted.stages.find((stage) => stage.id === "audit").status, "awaiting-human-review");
    assert.equal(adapterCalls, 1);
    assert.equal(doctorCalls, 1);
    assert.equal(finalizeCalls, 1);

    // drift のまま再 resume しても同じ場所に留まる（何度でも安全）。
    const driftedAgain = await runOnce();
    assert.equal(driftedAgain.status, "awaiting-human-review");
    assert.deepEqual(driftedAgain.blockers, ["run-receipt-finalization", "canonical-identity-drift"]);
    assert.equal(adapterCalls, 1);

    // drift を戻し、設定（宣言・信頼リスト）が整ってから resume → Receipt だけ確定して completed。
    await writeFile(join(root, "deployment", "production", "shared.mjs"), "export const fixtureVersion = 1;\n", "utf8");
    declarationReady = true;
    await writeReviewerTrustFixture(trustPath);
    const done = await runOnce({ reviewerTrustPath: trustPath, env: { BUZZASSIST_REVIEWER_TRUST: trustPath } });
    assert.equal(done.status, "completed");
    assert.equal(adapterCalls, 1, "paid adapter は 1 回だけ（二重課金なし）");
    assert.equal(doctorCalls, 1, "doctor も再実行しない");
    assert.equal(finalizeCalls, 2);
    assert.equal(done.pendingReceiptFinalization, undefined);
    assert.deepEqual(done.blockers, []);
    assert.ok(done.artifacts.some((entry) => entry.kind === "run-receipt"));
    // R5-2: pendingReceiptFinalization が消えても drift の痕跡は Job に残る。
    assert.ok(Array.isArray(done.driftHistory) && done.driftHistory.length === 2, "drift を検出した 2 回分が残る");
    assert.equal(done.driftHistory[0].phase, "receipt-pending");
    assert.match(done.driftHistory[0].error, /canonical identityが計画後に変わった/u);
    assert.ok(Number.isFinite(Date.parse(done.driftHistory[0].detectedAt)));
    assert.deepEqual((await readVideoHarnessJob({ projectDir: root, jobId: job.id })).driftHistory, done.driftHistory, "durable Job JSON にも残る");
    assert.doesNotMatch(JSON.stringify(done), /reviewer-trust\.json/u, "R5-4: 要求側の path 文字列は残らない");

    // Receipt 確定待ちではない Job の drift は従来どおり blocked-preflight。
    const { job: fresh } = await createVideoHarnessJob({ projectDir: root, scriptPath: join(root, "script.txt"), harnessId: "narrated-story-video", repoRoot: root });
    await writeFile(join(root, "deployment", "production", "shared.mjs"), "export const fixtureVersion = 3;\n", "utf8");
    const stopped = await runVideoHarnessJob({
      projectDir: root, jobId: fresh.id,
      doctor: async () => ({ ready: true, blocking: [] }),
      adapter: async () => ({ status: "completed" }),
      env: {},
    });
    assert.equal(stopped.status, "blocked-preflight");
    assert.deepEqual(stopped.blockers, ["canonical-identity-drift"]);
    assert.equal(stopped.driftHistory?.length, 1);
    assert.equal(stopped.driftHistory[0].phase, "preflight");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("R4-4: Receipt確定待ちに保存する adapter result も secrets を通す", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({ projectDir: root, scriptPath: join(root, "script.txt"), harnessId: "koya-manga-video", repoRoot: root });
    const { artifacts } = await paidArtifactsFixture(root);
    const secret = "sk-live-0123456789abcdef";
    const held = await runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => ({ ready: true, blocking: [] }),
      adapter: async () => ({
        status: "completed",
        artifacts,
        knownRemainingIssues: [],
        apiKey: secret,
        result: { status: "final-koya-audited", next: `resume with ${secret}`, checkpoint: `ck-${secret}` },
      }),
      finalizeReceipt: async () => { throw new Error("reviewer-trust-unconfigured: fixture"); },
      projectCanvas: async () => {},
      env: {},
    });
    assert.equal(held.status, "awaiting-human-review");
    const pendingResult = held.pendingReceiptFinalization.outcome.result;
    assert.equal(pendingResult.status, "final-koya-audited");
    assert.match(pendingResult.next, /\[redacted\]/u);
    assert.doesNotMatch(JSON.stringify(held), new RegExp(secret, "u"), "pendingReceiptFinalization 経由でも secret は Job に残らない");
    assert.doesNotMatch(await readFile(join(root, "canvas", "harness-runs", job.id, "job.json"), "utf8"), new RegExp(secret, "u"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Receipt確定失敗の blocker はメッセージ先頭の失敗コードだけを拾う", () => {
  assert.deepEqual(jobTesting.receiptFailureBlockers("reviewer-trust-unconfigured: 信頼リスト未設定"), ["run-receipt-finalization", "reviewer-trust-unconfigured"]);
  assert.deepEqual(jobTesting.receiptFailureBlockers("reviewer-trust-unreadable: ENOENT"), ["run-receipt-finalization", "reviewer-trust-unreadable"]);
  assert.deepEqual(jobTesting.receiptFinalizationIsRepairable({ status: "failed" }), false);
  assert.deepEqual(jobTesting.receiptFinalizationIsRepairable({ status: "blocked-preflight", pendingReceiptFinalization: { version: "buzzassist-video-harness-pending-receipt-v1", outcome: { status: "completed", artifacts: [] } } }), false);
  assert.deepEqual(jobTesting.receiptFailureBlockers("reviewer-trust-conflict: 引数と env が一致しない"), ["run-receipt-finalization", "reviewer-trust-conflict"]);
  assert.deepEqual(jobTesting.receiptFailureBlockers("共通RunReceiptがpassにならなかった。"), ["run-receipt-finalization"]);
  assert.deepEqual(jobTesting.receiptFailureBlockers("signoffs[0]のreviewer attestationが無効: reviewer-key-untrusted"), ["run-receipt-finalization"]);
});

// ---------------------------------------------------------------------------
// failed Job の再開（resume-from-failed）
// ---------------------------------------------------------------------------

function paidMediaRow(key, sha, overrides = {}) {
  return {
    version: "paid-media-job-v1",
    jobId: `media-${key}`,
    requestKey: `req-${key}`,
    status: "completed",
    kind: "image",
    provider: "fixture",
    model: "fixture-image",
    inputHash: sha,
    artifact: { sha256: sha, bytes: 1 },
    ...overrides,
  };
}

test("failed Job は共通 resume 経路で再開でき、完成済み Media Job は再発行されず、再開の事実が Job と finalizer に残る", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      harnessId: "koya-manga-video",
      repoRoot: root,
    });
    const { artifacts } = await paidArtifactsFixture(root);
    const paidA = paidMediaRow("a", "a".repeat(64));
    let doctorCalls = 0;
    let finalizedJob = null;
    const finalizeReceipt = async ({ job: current }) => {
      finalizedJob = current;
      const path = join(root, "resumed-run-receipt.json");
      await writeFile(path, "{}\n");
      return { path };
    };
    const run = (adapter, extra = {}) => runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => { doctorCalls += 1; return { ready: true, blocking: [] }; },
      adapter,
      finalizeReceipt,
      projectCanvas: async () => {},
      env: {},
      ...extra,
    });

    const failed = await run(async () => ({
      status: "failed",
      error: "render crashed after image generation",
      knownRemainingIssues: ["render crashed after image generation"],
      mediaJobs: [paidA],
    }));
    assert.equal(failed.status, "failed");
    assert.ok(failed.completedAt);
    assert.equal(failed.stages.find((stage) => stage.id === "production").status, "failed");
    assert.deepEqual(failed.mediaJobs.map((row) => row.requestKey), ["req-a"], "完成済み Media Job の記録は failed でも残る");
    assert.equal(failed.resumeFromFailed, undefined);

    const adapterContexts = [];
    const done = await run(async ({ job: current }) => {
      adapterContexts.push(current);
      return {
        status: "completed",
        artifacts,
        mediaJobs: [paidA, paidMediaRow("b", "b".repeat(64))],
        knownRemainingIssues: [],
        result: { status: "final-koya-audited" },
      };
    });
    assert.equal(done.status, "completed");
    assert.equal(doctorCalls, 2, "failed からの resume でも doctor は他の resume と同じく再実行される");
    assert.equal(adapterContexts.length, 1);
    assert.equal(adapterContexts[0].status, "running");
    assert.equal(adapterContexts[0].resumeFromFailed.attempts, 1, "adapter は再開中であることを context から読める");
    assert.equal(adapterContexts[0].resumeFromFailed.mediaJobs, null, "分類は adapter の報告を見てから確定する");
    assert.deepEqual(adapterContexts[0].mediaJobs.map((row) => row.requestKey), ["req-a"], "adapter は記録済みの完成 Media Job を受け取る");
    assert.deepEqual(adapterContexts[0].stages.map((stage) => stage.status), ["pass", "pending", "pending", "pending"], "走っていない工程を pass のまま残さない");

    const record = done.resumeFromFailed;
    assert.equal(record.version, "buzzassist-video-harness-failed-resume-v1");
    assert.equal(record.attempts, 1);
    assert.equal(record.held, undefined);
    assert.equal(record.previousFailure.failedStage, "production");
    assert.equal(record.previousFailure.failedAt, failed.completedAt);
    assert.match(record.previousFailure.error, /render crashed after image generation/u);
    assert.deepEqual(record.previousFailure.knownRemainingIssues, ["render crashed after image generation"]);
    assert.deepEqual(record.previousFailure.stages.map((stage) => stage.status), ["pass", "failed", "failed", "pending"]);
    assert.deepEqual(record.mediaJobRecovery, []);
    assert.deepEqual(record.mediaJobs.reused.map((row) => row.requestKey), ["req-a"], "同じ requestKey・同じ artifact SHA は再利用");
    assert.deepEqual(record.mediaJobs.issued.map((row) => row.requestKey), ["req-b"], "記録に無い Media Job だけが新規発行");
    assert.deepEqual(record.mediaJobs.reissued, []);
    assert.deepEqual(record.mediaJobs.recovered, []);
    assert.deepEqual(record.mediaJobs.carried, []);
    assert.deepEqual(record.history, []);
    assert.deepEqual(finalizedJob.resumeFromFailed.mediaJobs.reused.map((row) => row.requestKey), ["req-a"], "Receipt finalizer は再開の事実を受け取る");
    assert.deepEqual(done.mediaJobs.map((row) => row.requestKey), ["req-a", "req-b"]);
    assert.ok(done.artifacts.some((entry) => entry.kind === "run-receipt"));
    assert.deepEqual(done.stages.map((stage) => stage.status), ["pass", "pass", "pass", "pass"]);
    assert.deepEqual(done.blockers, []);
    assert.equal(done.error, undefined);
    const persisted = await readVideoHarnessJob({ projectDir: root, jobId: job.id });
    assert.equal(persisted.status, "completed");
    assert.deepEqual(persisted.resumeFromFailed.mediaJobs.reused.map((row) => row.requestKey), ["req-a"]);

    // completed になった Job の resume は従来どおり再投影だけ（doctor も adapter も走らない）。
    let adapterAgain = 0;
    const again = await run(async () => { adapterAgain += 1; return { status: "completed" }; });
    assert.equal(again.status, "completed");
    assert.equal(adapterAgain, 0);
    assert.equal(doctorCalls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery-required の Media Job を持つ failed Job は broker の recover を通り、決着するまで doctor も adapter も起動しない", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      harnessId: "koya-manga-video",
      repoRoot: root,
    });
    const { artifacts } = await paidArtifactsFixture(root);
    const paidA = paidMediaRow("a", "a".repeat(64));
    const recovering = paidMediaRow("r", "c".repeat(64), {
      status: "recovery-required", kind: "voice.synthesis", model: "fixture-tts", providerJobId: "prov-r", artifact: {},
    });
    let doctorCalls = 0;
    let adapterCalls = 0;
    const finalizeReceipt = async () => {
      const path = join(root, "recovered-run-receipt.json");
      await writeFile(path, "{}\n");
      return { path };
    };
    const run = (adapter, extra = {}) => runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => { doctorCalls += 1; return { ready: true, blocking: [] }; },
      adapter: async (context) => { adapterCalls += 1; return adapter(context); },
      finalizeReceipt,
      projectCanvas: async () => {},
      env: {},
      ...extra,
    });

    const failed = await run(async () => ({
      status: "failed",
      error: "speech stage lost the connection after submit",
      knownRemainingIssues: ["speech stage lost the connection after submit"],
      mediaJobs: [paidA, recovering],
    }));
    assert.equal(failed.status, "failed");
    assert.equal(failed.mediaJobs.find((row) => row.requestKey === "req-r").status, "recovery-required");
    assert.equal(adapterCalls, 1);
    assert.equal(doctorCalls, 1);

    // recover しても未決着: failed のまま blocker を立てて止まる。再 submit（adapter 起動）はしない。
    const recoverCalls = [];
    const held = await run(async () => ({ status: "completed" }), {
      recoverMediaJob: async (ref) => { recoverCalls.push(ref); return { ...recovering }; },
    });
    assert.equal(held.status, "failed");
    assert.deepEqual(held.blockers, ["paid-media-recovery-pending"]);
    assert.match(held.knownRemainingIssues[0], /^paid-media-recovery-pending: .*req-r: recover 後も recovery-required/u);
    assert.deepEqual(recoverCalls, [{ requestKey: "req-r", jobId: "media-r", providerJobId: "prov-r" }], "recover は記録された identity で呼ぶ");
    assert.equal(adapterCalls, 1, "未決着のまま adapter を起動しない");
    assert.equal(doctorCalls, 1, "未決着のまま doctor も走らない");
    assert.equal(held.resumeFromFailed.held, true);
    assert.equal(held.resumeFromFailed.attempts, 1);
    assert.deepEqual(held.resumeFromFailed.mediaJobRecovery, [{ requestKey: "req-r", jobId: "media-r", before: "recovery-required", after: "recovery-required" }]);
    assert.equal(held.resumeFromFailed.previousFailure.error, "speech stage lost the connection after submit", "元の失敗理由は保持する");

    // recover 自体が失敗: 同じく止まり、理由を記録する。
    const heldAgain = await run(async () => ({ status: "completed" }), {
      recoverMediaJob: async () => { throw new Error("broker unreachable"); },
    });
    assert.equal(heldAgain.status, "failed");
    assert.deepEqual(heldAgain.blockers, ["paid-media-recovery-pending"]);
    assert.match(heldAgain.resumeFromFailed.mediaJobRecovery[0].error, /broker unreachable/u);
    assert.equal(heldAgain.resumeFromFailed.attempts, 2);
    assert.equal(heldAgain.resumeFromFailed.history.length, 1);
    assert.equal(adapterCalls, 1);

    // recover が completed で決着: 記録を更新した上で通常経路へ戻り、adapter は決着済みの行を受け取る。
    const recovered = { ...recovering, status: "completed", artifact: { sha256: "c".repeat(64), bytes: 1 } };
    let seenRows = null;
    const done = await run(async ({ job: current }) => {
      seenRows = current.mediaJobs;
      return {
        status: "completed",
        artifacts,
        mediaJobs: [paidA, recovered],
        knownRemainingIssues: [],
        result: { status: "final-koya-audited" },
      };
    }, { recoverMediaJob: async () => recovered });
    assert.equal(done.status, "completed");
    assert.equal(adapterCalls, 2);
    assert.equal(doctorCalls, 2);
    assert.equal(seenRows.find((row) => row.requestKey === "req-r").status, "completed", "recover の結果が adapter 起動前に Job へ反映される");
    assert.equal(done.resumeFromFailed.attempts, 3);
    assert.equal(done.resumeFromFailed.held, undefined);
    assert.deepEqual(done.resumeFromFailed.mediaJobRecovery, [{ requestKey: "req-r", jobId: "media-r", before: "recovery-required", after: "completed" }]);
    assert.deepEqual(done.resumeFromFailed.mediaJobs.recovered.map((row) => row.requestKey), ["req-r"]);
    assert.deepEqual(done.resumeFromFailed.mediaJobs.reused.map((row) => row.requestKey), ["req-a"]);
    assert.deepEqual(done.resumeFromFailed.mediaJobs.issued, []);
    assert.deepEqual(done.resumeFromFailed.mediaJobs.reissued, []);
    assert.equal(done.resumeFromFailed.history.length, 2);
    assert.equal(done.resumeFromFailed.history[1].held, true);
    assert.equal(done.resumeFromFailed.history[1].history, undefined, "history は入れ子にしない");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("既定の recover は既定 journal に無い Media Job を再 submit せず、理由つきで未決着に留める", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      harnessId: "koya-manga-video",
      repoRoot: root,
    });
    const recovering = paidMediaRow("r", "c".repeat(64), { status: "recovery-required", kind: "voice.synthesis", artifact: {} });
    let adapterCalls = 0;
    const run = (extra = {}) => runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => ({ ready: true, blocking: [] }),
      adapter: async () => { adapterCalls += 1; return { status: "failed", error: "boom", knownRemainingIssues: ["boom"], mediaJobs: [recovering] }; },
      projectCanvas: async () => {},
      ...extra,
    });
    await run({ env: {} });
    assert.equal(adapterCalls, 1);
    const emptyJournal = join(root, "empty-media-jobs");
    const held = await run({ env: { BUZZASSIST_MEDIA_JOB_STATE_DIR: emptyJournal } });
    assert.equal(held.status, "failed");
    assert.deepEqual(held.blockers, ["paid-media-recovery-pending"]);
    assert.match(held.resumeFromFailed.mediaJobRecovery[0].error, /既定 journal/u);
    assert.match(held.resumeFromFailed.mediaJobRecovery[0].error, /empty-media-jobs/u);
    assert.equal(adapterCalls, 1, "journal に無い Media Job を新規発行で埋めない");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("直せない failed Job（台本欠落・改変、workspace 欠落、矛盾 journal、破損 journal）は理由つきで拒否し、Job を書き換えず doctor も adapter も走らない", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      harnessId: "koya-manga-video",
      repoRoot: root,
    });
    let doctorCalls = 0;
    let adapterCalls = 0;
    const attempt = () => runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => { doctorCalls += 1; return { ready: true, blocking: [] }; },
      adapter: async () => { adapterCalls += 1; return { status: "failed", error: "boom", knownRemainingIssues: ["boom"] }; },
      projectCanvas: async () => {},
      env: {},
    });
    const failed = await attempt();
    assert.equal(failed.status, "failed");
    assert.equal(doctorCalls, 1);
    assert.equal(adapterCalls, 1);
    const jobPath = join(root, "canvas", "harness-runs", job.id, "job.json");
    const original = await readFile(jobPath, "utf8");
    const parsed = JSON.parse(original);
    const refused = (pattern) => (error) => {
      assert.equal(error.code, "video-harness-failed-job-unrecoverable");
      assert.match(error.message, /^video-harness-failed-job-unrecoverable: /u);
      assert.match(error.message, pattern);
      return true;
    };

    const scriptBody = await readFile(job.script.path);
    await rm(job.script.path);
    await assert.rejects(attempt(), refused(/保存済み台本を読めない/u));
    await writeFile(job.script.path, "改変された台本\n", "utf8");
    await assert.rejects(attempt(), refused(/SHA-256 が Job と一致しない/u));
    await writeFile(job.script.path, scriptBody);

    await writeFile(jobPath, JSON.stringify({ ...parsed, pendingReceiptFinalization: { version: "x" } }));
    await assert.rejects(attempt(), refused(/Receipt 確定待ち/u));
    await writeFile(jobPath, JSON.stringify({ ...parsed, runDir: join(root, "gone") }));
    await assert.rejects(attempt(), refused(/workspace が無い/u));
    await writeFile(jobPath, JSON.stringify({ ...parsed, stages: [{ id: "doctor", status: "pass" }] }));
    await assert.rejects(attempt(), refused(/stages/u));
    await writeFile(jobPath, JSON.stringify({ ...parsed, mediaJobs: [{ status: "recovery-required", kind: "image", provider: "fixture" }] }));
    await assert.rejects(attempt(), refused(/requestKey も jobId も無く/u));
    await writeFile(jobPath, "{ this is not json");
    await assert.rejects(attempt(), (error) => {
      assert.equal(error.code, "video-harness-job-journal-corrupt");
      assert.match(error.message, /JSON として読めない/u);
      return true;
    });

    await writeFile(jobPath, original);
    assert.equal(doctorCalls, 1, "拒否経路で doctor は走らない");
    assert.equal(adapterCalls, 1, "拒否経路で adapter は走らない");
    const after = await readVideoHarnessJob({ projectDir: root, jobId: job.id });
    assert.equal(after.status, "failed");
    assert.equal(after.revision, parsed.revision, "拒否は Job を書き換えない");
    assert.equal(after.resumeFromFailed, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed Job の再開後にもう一度失敗すると、前回の再開記録は history に残り新しい失敗理由が previousFailure になる", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      harnessId: "koya-manga-video",
      repoRoot: root,
    });
    const paidA = paidMediaRow("a", "a".repeat(64));
    const run = (adapter) => runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => ({ ready: true, blocking: [] }),
      adapter,
      projectCanvas: async () => {},
      env: {},
    });
    await run(async () => ({ status: "failed", error: "first failure", knownRemainingIssues: ["first failure"], mediaJobs: [paidA] }));
    const second = await run(async () => ({ status: "failed", error: "second failure", knownRemainingIssues: ["second failure"], mediaJobs: [paidA] }));
    assert.equal(second.status, "failed");
    assert.equal(second.resumeFromFailed.attempts, 1);
    assert.equal(second.resumeFromFailed.previousFailure.error, "first failure");
    assert.deepEqual(second.resumeFromFailed.mediaJobs.reused.map((row) => row.requestKey), ["req-a"], "再失敗でも 1 回目の再開での再利用は確定して残る");
    const third = await run(async () => ({ status: "awaiting-human-review", blockers: ["review"], knownRemainingIssues: ["review"], mediaJobs: [paidA] }));
    assert.equal(third.status, "awaiting-human-review");
    assert.equal(third.resumeFromFailed.attempts, 2);
    assert.equal(third.resumeFromFailed.previousFailure.error, "second failure");
    assert.equal(third.resumeFromFailed.history.length, 1);
    assert.equal(third.resumeFromFailed.history[0].previousFailure.error, "first failure");
    assert.deepEqual(third.stages.map((stage) => stage.status), ["pass", "awaiting-human-review", "pending", "pending"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classifyResumedMediaJobs は同じ鍵で別 artifact になった行を reused に数えない", () => {
  const recorded = [paidMediaRow("a", "a".repeat(64)), paidMediaRow("c", "c".repeat(64)), paidMediaRow("r", "r".repeat(64))];
  const reported = [paidMediaRow("a", "a".repeat(64)), paidMediaRow("c", "d".repeat(64)), paidMediaRow("r", "r".repeat(64)), paidMediaRow("n", "e".repeat(64))];
  const out = jobTesting.classifyResumedMediaJobs(recorded, reported, new Set(["req-r"]));
  assert.deepEqual(out.reused.map((row) => row.requestKey), ["req-a"]);
  assert.deepEqual(out.reissued.map((row) => row.requestKey), ["req-c"]);
  assert.deepEqual(out.recovered.map((row) => row.requestKey), ["req-r"]);
  assert.deepEqual(out.issued.map((row) => row.requestKey), ["req-n"]);
  assert.deepEqual(out.carried, []);
  const partial = jobTesting.classifyResumedMediaJobs(recorded, [paidMediaRow("a", "a".repeat(64))]);
  assert.deepEqual(partial.carried.map((row) => row.requestKey), ["req-c", "req-r"], "報告されなかった記録は carried として区別する");
  assert.equal(jobTesting.failedStageOf({ stages: [{ id: "doctor", status: "pass" }, { id: "production", status: "failed" }] }), "production");
  assert.equal(jobTesting.failedStageOf({ stages: [{ id: "doctor", status: "failed" }, { id: "production", status: "failed" }] }), "doctor");
});

test("adapter outcome の imageRetry / imageSummary / mediaJobStateDir は同じ名前で Job に残り、空の mediaJobStateDir で既知の場所を消さない", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: join(root, "script.txt"),
      harnessId: "koya-manga-video",
      repoRoot: root,
    });
    const { artifacts } = await paidArtifactsFixture(root);
    const retriedFailed = { requested: true, jobIds: ["image:2", "image:7"], count: 2, attempts: 3, completed: 2 };
    const imageSummary = { total: 9, complete: 9, failed: 0, reused: 7, paidImages: 9, attempts: 12, retriedFailed };
    const stateDir = join(root, ".koya-dialogue-source", "paid-media-jobs");
    let finalizedJob = null;
    const run = (adapter, extra = {}) => runVideoHarnessJob({
      projectDir: root,
      jobId: job.id,
      doctor: async () => ({ ready: true, blocking: [] }),
      adapter,
      finalizeReceipt: async ({ job: current }) => {
        finalizedJob = current;
        const path = join(root, "image-retry-run-receipt.json");
        await writeFile(path, "{}\n");
        return { path };
      },
      projectCanvas: async () => {},
      env: {},
      ...extra,
    });
    // 1回目: 失敗（画像は作り直し無し）。journal の場所だけ報告される。
    const failed = await run(async () => ({
      status: "failed",
      error: "render crashed",
      knownRemainingIssues: ["render crashed"],
      mediaJobs: [paidMediaRow("a", "a".repeat(64))],
      imageRetry: { requested: false, retriedFailed: null },
      imageSummary: { total: 9, complete: 7, failed: 2, reused: 0, paidImages: 7, attempts: 9, retriedFailed: { requested: false, jobIds: [], count: 0, attempts: 0, completed: 0 } },
      mediaJobStateDir: stateDir,
    }));
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.imageRetry, { requested: false, retriedFailed: null });
    assert.equal(failed.imageSummary.failed, 2);
    assert.equal(failed.mediaJobStateDir, stateDir);
    assert.equal(failed.imageRetryHistory, undefined, "迂回引数を使っていない回は history に積まない");
    // 2回目: --retry-failed-images 相当で完成。空の mediaJobStateDir は既知の場所を消さない。
    const done = await run(async () => ({
      status: "completed",
      artifacts,
      mediaJobs: [paidMediaRow("a", "a".repeat(64))],
      knownRemainingIssues: [],
      result: { status: "final-koya-audited" },
      imageRetry: { requested: true, retriedFailed },
      imageSummary,
      mediaJobStateDir: "",
    }));
    assert.equal(done.status, "completed");
    assert.deepEqual(done.imageRetry, { requested: true, retriedFailed });
    assert.deepEqual(done.imageSummary, imageSummary);
    assert.equal(done.mediaJobStateDir, stateDir, "空文字では上書きしない");
    assert.equal(done.imageRetryHistory.length, 1);
    assert.deepEqual(done.imageRetryHistory[0].retriedFailed, retriedFailed);
    assert.ok(done.imageRetryHistory[0].recordedAt);
    assert.deepEqual(finalizedJob.imageRetry, { requested: true, retriedFailed }, "Receipt finalizer は同じ名前で受け取る");
    const persisted = await readVideoHarnessJob({ projectDir: root, jobId: job.id });
    assert.deepEqual(persisted.imageRetry, { requested: true, retriedFailed });
    assert.equal(persisted.mediaJobStateDir, stateDir);
    // 形の壊れた値は数値 0 / null に落とし、例外にしない。
    const evidence = jobTesting.imageEvidenceFromOutcome({}, {
      imageRetry: { requested: "yes", retriedFailed: { jobIds: "x", count: -1, attempts: "3", completed: 1.5 } },
      imageSummary: [],
      mediaJobStateDir: 42,
    }, [], () => "2026-09-24T00:00:00.000Z");
    assert.deepEqual(evidence, {
      imageRetry: { requested: false, retriedFailed: { requested: false, jobIds: [], count: 0, attempts: 3, completed: 0 } },
      imageSummary: null,
    });
    assert.deepEqual(jobTesting.imageEvidenceFromOutcome({}, {}, [], () => "x"), {}, "outcome に無ければ何も上書きしない");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("既定の recover は job.mediaJobStateDir の journal を先に探し、無ければ既定 journal、どちらにも無ければ拒否する", async () => {
  const root = await fixture();
  try {
    const { createPaidMediaJobBroker } = await import("../lib/paidMediaJobBroker.mjs");
    const childJournal = join(root, "child-source", "paid-media-jobs");
    const defaultJournal = join(root, "default-media-jobs");
    // 子の journal にだけ requestKey を置く（start は呼ばず、journal の形だけ再現する）。
    const broker = createPaidMediaJobBroker({ stateDir: childJournal });
    const requestKey = "req-child";
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update(requestKey).digest("hex");
    await mkdir(join(childJournal, "jobs"), { recursive: true });
    await writeFile(join(childJournal, "jobs", `${digest}.json`), `${JSON.stringify({
      version: "paid-media-job-v1", jobId: "srv-1", requestKey, inputHash: "c".repeat(64), identityHash: "d".repeat(64),
      kind: "voice.synthesis", provider: "fixture", adapterVersion: "v1", providerJobId: "prov-1", model: "m", voiceId: "",
      status: "recovery-required", reservation: {}, usage: {}, result: null, attempts: { total: 1, retries: [] }, error: null,
      createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z",
    })}\n`);
    assert.ok(await broker.getLocal({ requestKey }), "fixture journal が broker から読めること");
    const recoverCalls = [];
    // recover 自体（network）は差し替えられないので、journal の探索順だけを検証する:
    // 子 journal に無い requestKey → 既定 journal にも無い → 拒否メッセージに両方の場所が並ぶ。
    await assert.rejects(
      jobTesting.defaultRecoverMediaJob({ requestKey: "req-missing" }, {
        job: { mediaJobStateDir: childJournal },
        env: { BUZZASSIST_MEDIA_JOB_STATE_DIR: defaultJournal },
      }),
      (error) => {
        assert.match(error.message, /req-missing/u);
        assert.ok(error.message.indexOf(childJournal) < error.message.indexOf(defaultJournal), "子の journal を先に探す");
        assert.match(error.message, /BUZZASSIST_MEDIA_JOB_STATE_DIR/u, "運営者向けの案内は残す");
        return true;
      },
    );
    assert.deepEqual(recoverCalls, []);
    // job.mediaJobStateDir が無いときは既定 journal だけ。
    await assert.rejects(
      jobTesting.defaultRecoverMediaJob({ requestKey: "req-missing" }, { job: {}, env: { BUZZASSIST_MEDIA_JOB_STATE_DIR: defaultJournal } }),
      (error) => !error.message.includes(childJournal) && error.message.includes(defaultJournal),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
