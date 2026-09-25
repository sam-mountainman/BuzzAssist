import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { koyaContractDigest } from "../lib/koyaMangaProductionContract.mjs";
import { PAID_CALL_GUARD_ENV, assertPaidCallAllowed } from "../lib/paidCallGuard.mjs";
import {
  assertVideoHarnessJobIdentity,
  createVideoHarnessJob,
  createVideoHarnessUpstreamExecutionBinding,
  readVideoHarnessJob,
  runVideoHarnessJob,
  verifyVideoHarnessUpstreamExecution,
} from "../lib/videoHarnessJob.mjs";
import {
  CANONICAL_IDENTITY_DRIFT_CODE,
  FINALIZE_AFTER_UPDATE_DIR,
  FINALIZE_AFTER_UPDATE_INPUT_CHANGED_CODE,
  FINALIZE_AFTER_UPDATE_INPUT_UNRECORDED_CODE,
  FINALIZE_AFTER_UPDATE_NOT_NEEDED_CODE,
  FINALIZE_AFTER_UPDATE_PAID_CALL_REQUIRED_CODE,
  FINALIZE_AFTER_UPDATE_PINNED_CONTRACT_UNAVAILABLE_CODE,
  PINNED_PRODUCTION_CONTRACT_FILE,
  VIDEO_HARNESS_CODE_REBIND_VERSION,
  VIDEO_HARNESS_INPUT_IDENTITY_VERSION,
  codeIdentityDigest,
} from "../lib/videoHarnessUpdateFinalize.mjs";

// 実際の宣言とスキルの上で Job の仕組みを確かめる（test/videoHarnessJob.test.mjs と同じ理由で承認の要求を外す）。
process.env.BUZZASSIST_REQUIRE_SKILL_APPROVAL = "0";

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const doctor = async () => ({ ready: true, blocking: [], checks: [{ id: "fixture", ok: true }] });
const projectCanvas = async () => {};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "video-harness-finalize-"));
  const deployment = join(root, "deployment");
  await mkdir(join(root, "config"), { recursive: true });
  await mkdir(join(deployment, "production"), { recursive: true });
  await writeFile(join(deployment, "canonical.mjs"), "import './production/shared.mjs';\n", "utf8");
  await writeFile(join(deployment, "production", "narrated-harness.mjs"), "import './shared.mjs';\n", "utf8");
  await writeFile(join(deployment, "production", "shared.mjs"), "export const fixtureVersion = 1;\n", "utf8");
  await writeFile(join(root, "script.txt"), "合成の台本の一文。\n", "utf8");
  await writeFile(join(root, "config", "harness-deployments.json"), `${JSON.stringify({
    deployments: [
      { harnessId: "koya-manga-video", root: "deployment", entrypoint: "node canonical.mjs" },
      { harnessId: "narrated-story-video", root: "deployment", entrypoint: "node production/narrated-harness.mjs" },
    ],
  }, null, 2)}\n`);
  return root;
}

/** BuzzAssist の更新（配置されたハーネスのコードが変わる）を真似る。入力は変えない。 */
async function simulateUpdate(root, version) {
  await writeFile(join(root, "deployment", "production", "shared.mjs"), `export const fixtureVersion = ${version};\n`, "utf8");
}

function mediaJob(index) {
  return {
    version: "buzzassist-paid-media-receipt-v1",
    jobId: `media-${index}`,
    requestKey: `request-${index}`,
    status: "completed",
    kind: "voice.synthesis",
    provider: "synthetic-voice",
    model: "synthetic-model",
    inputHash: String(index).repeat(64).slice(0, 64),
    artifact: { sha256: "a".repeat(64), mimeType: "audio/wav", bytes: 10 },
    reservation: {},
    usage: { cost: 0.01, currency: "USD" },
    attempts: { total: 1, retries: [] },
  };
}

const awaitingReview = async () => ({
  status: "awaiting-human-review",
  blockers: ["independent-contact-sheet-signoff-required"],
  knownRemainingIssues: ["independent-contact-sheet-signoff-required"],
  mediaJobs: [mediaJob(1)],
});

async function startedJob(root, { harnessId = "narrated-story-video", options = {} } = {}) {
  const { job } = await createVideoHarnessJob({
    projectDir: root,
    scriptPath: join(root, "script.txt"),
    harnessId,
    repoRoot: root,
    options,
  });
  const first = await runVideoHarnessJob({ projectDir: root, jobId: job.id, doctor, adapter: awaitingReview, projectCanvas });
  assert.equal(first.status, "awaiting-human-review");
  return { planned: job, first };
}

async function receiptWriter(root, seen) {
  return async ({ job }) => {
    seen.push(job);
    const path = join(root, "fixture-run-receipt.json");
    await writeFile(path, "{}\n");
    return { path };
  };
}

test("入力が同じでコードだけ変わった Job は、作り直さず新しい有料の呼び出し0件で確定し、同一性を2つに分けて残す", async () => {
  const root = await fixture();
  try {
    const { planned } = await startedJob(root);
    assert.equal(planned.inputIdentity.version, VIDEO_HARNESS_INPUT_IDENTITY_VERSION);
    assert.match(planned.inputIdentity.digest, /^[a-f0-9]{64}$/u);
    await simulateUpdate(root, 2);

    let plainCalls = 0;
    const blocked = await runVideoHarnessJob({
      projectDir: root, jobId: planned.id, doctor, projectCanvas,
      adapter: async () => { plainCalls += 1; return { status: "completed" }; },
    });
    assert.equal(blocked.status, "blocked-preflight");
    assert.deepEqual(blocked.blockers, [CANONICAL_IDENTITY_DRIFT_CODE]);
    assert.match(blocked.knownRemainingIssues[0], /--finalize-after-update/u, "止まったときに作り直さずに確定する道を案内する");
    assert.equal(plainCalls, 0);

    let context = null;
    const receipts = [];
    const done = await runVideoHarnessJob({
      projectDir: root,
      jobId: planned.id,
      doctor,
      projectCanvas,
      finalizeAfterUpdate: true,
      adapter: async (value) => {
        context = value;
        // 子（ナレーション物語の正規入口）が有料の前に行う上位 Job の検証が、付け替えた Job を通すこと。
        const verified = await verifyVideoHarnessUpstreamExecution({
          upstreamJobPath: join(value.job.runDir, "job.json"),
          upstreamJobId: value.job.id,
          upstreamJobRevision: value.job.revision,
          upstreamExecutionBinding: createVideoHarnessUpstreamExecutionBinding(value.job),
          harnessId: "narrated-story-video",
          scriptPath: value.job.script.path,
        });
        assert.equal(verified.identityDigest, planned.identityDigest);
        return {
          status: "completed",
          artifacts: [{ kind: "video", path: join(root, "final.mp4"), sha256: "b".repeat(64) }],
          mediaJobs: [mediaJob(1)],
          knownRemainingIssues: [],
        };
      },
      finalizeReceipt: await receiptWriter(root, receipts),
    });
    assert.equal(done.status, "completed");
    assert.equal(done.id, planned.id, "Job ID は付け替えない");
    assert.equal(done.identityDigest, planned.identityDigest, "reviewer の署名が結ばれた identityDigest も付け替えない");
    assert.equal(context.paidCallGuardPath, join(resolve(planned.runDir), FINALIZE_AFTER_UPDATE_DIR, `refused-paid-calls-r${context.job.revision}.jsonl`));
    assert.equal(context.pinnedProductionContractPath, "", "ナレーション物語は Job 層で契約を固定しない");

    const rebind = done.codeIdentityRebind;
    assert.equal(rebind.version, VIDEO_HARNESS_CODE_REBIND_VERSION);
    assert.deepEqual(rebind.plannedCanonicalIdentity, planned.canonicalIdentity, "計画時のコードの同一性を残す");
    assert.notDeepEqual(done.canonicalIdentity, planned.canonicalIdentity, "コードの同一性は今のコードへ付け替わる");
    assert.equal(rebind.rebinds.length, 1);
    assert.equal(rebind.rebinds[0].from.digest, codeIdentityDigest(planned.canonicalIdentity));
    assert.equal(rebind.rebinds[0].to.digest, codeIdentityDigest(done.canonicalIdentity));
    assert.notEqual(rebind.rebinds[0].from.deploymentDependenciesDigest, rebind.rebinds[0].to.deploymentDependenciesDigest);
    assert.equal(JSON.stringify(rebind.rebinds).includes(root), false, "要約に端末の絶対パスを入れない");
    const run = rebind.finalizeRuns.at(-1);
    assert.equal(run.refusedPaidCalls, 0, "新しい有料の呼び出しは0件");
    assert.equal(run.mediaJobs.reused, 1);
    assert.equal(run.mediaJobs.issued, 0);
    assert.equal(done.inputIdentity.recordedFor, "dispatch");
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].codeIdentityRebind.finalizeRuns.at(-1).refusedPaidCalls, 0, "Receipt は再利用だけの実行の記録を見る");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("新しい有料の呼び出しが1件でも要れば、子が握りつぶして completed と言っても確定させず、ふつうの resume も断る", async () => {
  const root = await fixture();
  try {
    const { planned } = await startedJob(root);
    await simulateUpdate(root, 2);
    let calls = 0;
    const stopped = await runVideoHarnessJob({
      projectDir: root,
      jobId: planned.id,
      doctor,
      projectCanvas,
      finalizeAfterUpdate: true,
      adapter: async (context) => {
        calls += 1;
        // 子が関所の例外を握って先へ進んだ場合でも、台帳に残った1行で止まる。
        try {
          assertPaidCallAllowed(
            { route: "paid-media-broker", kind: "voice.synthesis", provider: "synthetic-voice", requestKey: "request-new" },
            { env: { [PAID_CALL_GUARD_ENV]: context.paidCallGuardPath } },
          );
        } catch { /* 握りつぶす子 */ }
        return { status: "completed", artifacts: [], mediaJobs: [mediaJob(1)], knownRemainingIssues: [] };
      },
      finalizeReceipt: async () => { throw new Error("確定まで進んではならない"); },
    });
    assert.equal(stopped.status, "failed");
    assert.deepEqual(stopped.blockers, [FINALIZE_AFTER_UPDATE_PAID_CALL_REQUIRED_CODE]);
    assert.match(stopped.knownRemainingIssues[0], /1 件/u);
    assert.match(stopped.knownRemainingIssues[0], /新しい Job/u);
    assert.equal(stopped.codeIdentityRebind.finalizeRuns.at(-1).refusedPaidCalls, 1);
    assert.equal(stopped.stages.find((stage) => stage.id === "production").status, "failed");

    await assert.rejects(
      runVideoHarnessJob({ projectDir: root, jobId: planned.id, doctor, projectCanvas, adapter: async () => { calls += 1; return { status: "completed" }; } }),
      (error) => error.code === FINALIZE_AFTER_UPDATE_PAID_CALL_REQUIRED_CODE,
    );
    assert.equal(calls, 1, "ふつうの resume は子を起動しない");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("入力が変わっていれば今までどおり canonical-identity-drift で止め、付け替えない", async () => {
  const root = await fixture();
  try {
    const { planned } = await startedJob(root);
    await simulateUpdate(root, 2);
    await writeFile(planned.script.path, "差し替えた合成の台本。\n", "utf8");
    let calls = 0;
    const blocked = await runVideoHarnessJob({
      projectDir: root, jobId: planned.id, doctor, projectCanvas, finalizeAfterUpdate: true,
      adapter: async () => { calls += 1; return { status: "completed" }; },
    });
    assert.equal(blocked.status, "blocked-preflight");
    assert.deepEqual(blocked.blockers, [CANONICAL_IDENTITY_DRIFT_CODE, FINALIZE_AFTER_UPDATE_INPUT_CHANGED_CODE]);
    assert.match(blocked.knownRemainingIssues[0], /script/u);
    assert.match(blocked.knownRemainingIssues[0], /新しい Job/u);
    assert.equal(blocked.codeIdentityRebind, undefined);
    assert.deepEqual(blocked.canonicalIdentity, planned.canonicalIdentity);
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("運営者の取り込みの記録は最後に制作へ渡した中身と比べ、変わっていれば止め、記録の無い古い Job は付け替えない", async () => {
  const root = await fixture();
  try {
    const manifest = join(root, "operator-images.json");
    await writeFile(manifest, `${JSON.stringify({ version: "synthetic", scenes: ["a"] })}\n`, "utf8");
    const { planned, first } = await startedJob(root, { options: { operatorImageManifestPath: manifest } });
    assert.deepEqual(first.inputIdentity.operatorImports, [{ option: "operatorImageManifestPath", sha256: sha256(await readFile(manifest)) }]);
    await simulateUpdate(root, 2);
    await writeFile(manifest, `${JSON.stringify({ version: "synthetic", scenes: ["b"] })}\n`, "utf8");
    const changed = await runVideoHarnessJob({
      projectDir: root, jobId: planned.id, doctor, projectCanvas, finalizeAfterUpdate: true,
      adapter: async () => { throw new Error("子を起動してはならない"); },
    });
    assert.deepEqual(changed.blockers, [CANONICAL_IDENTITY_DRIFT_CODE, FINALIZE_AFTER_UPDATE_INPUT_CHANGED_CODE]);
    assert.match(changed.knownRemainingIssues[0], /operator-import:operatorImageManifestPath/u);

    // この機能より前に最後の制作を走らせた Job（inputIdentity が無い）は、変わっていないと示せない。
    const jobPath = join(planned.runDir, "job.json");
    const legacy = JSON.parse(await readFile(jobPath, "utf8"));
    delete legacy.inputIdentity;
    await writeFile(jobPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
    const unrecorded = await runVideoHarnessJob({
      projectDir: root, jobId: planned.id, doctor, projectCanvas, finalizeAfterUpdate: true,
      adapter: async () => { throw new Error("子を起動してはならない"); },
    });
    assert.deepEqual(unrecorded.blockers, [CANONICAL_IDENTITY_DRIFT_CODE, FINALIZE_AFTER_UPDATE_INPUT_UNRECORDED_CODE]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("更新をまたいでいない Job に --finalize-after-update が来たら Job を変えずに断る", async () => {
  const root = await fixture();
  try {
    const { planned } = await startedJob(root);
    const before = await readVideoHarnessJob({ projectDir: root, jobId: planned.id });
    await assert.rejects(
      runVideoHarnessJob({
        projectDir: root, jobId: planned.id, doctor, projectCanvas, finalizeAfterUpdate: true,
        adapter: async () => { throw new Error("子を起動してはならない"); },
      }),
      (error) => error.code === FINALIZE_AFTER_UPDATE_NOT_NEEDED_CODE,
    );
    const after = await readVideoHarnessJob({ projectDir: root, jobId: planned.id });
    assert.equal(after.revision, before.revision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Receipt の確定だけを待っていた Job は、付け替えて Receipt の確定だけをやり直す（子を起動しない）", async () => {
  const root = await fixture();
  try {
    const { job } = await createVideoHarnessJob({
      projectDir: root, scriptPath: join(root, "script.txt"), harnessId: "narrated-story-video", repoRoot: root,
    });
    const finalVideo = join(root, "final.mp4");
    await writeFile(finalVideo, "synthetic mp4 bytes");
    const artifact = { kind: "video", path: finalVideo, sha256: sha256(await readFile(finalVideo)), bytes: (await stat(finalVideo)).size };
    const pending = await runVideoHarnessJob({
      projectDir: root, jobId: job.id, doctor, projectCanvas,
      adapter: async () => ({ status: "completed", artifacts: [artifact], mediaJobs: [mediaJob(1)], knownRemainingIssues: [] }),
      finalizeReceipt: async () => { throw new Error("reviewer-trust-unconfigured: 合成の失敗"); },
    });
    assert.equal(pending.status, "awaiting-human-review");
    assert.ok(pending.pendingReceiptFinalization);
    await simulateUpdate(root, 3);
    const receipts = [];
    const done = await runVideoHarnessJob({
      projectDir: root, jobId: job.id, doctor, projectCanvas, finalizeAfterUpdate: true,
      adapter: async () => { throw new Error("Receipt の確定だけで、子を起動してはならない"); },
      finalizeReceipt: await receiptWriter(root, receipts),
    });
    assert.equal(done.status, "completed");
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].codeIdentityRebind.rebinds.length, 1);
    assert.deepEqual(receipts[0].codeIdentityRebind.finalizeRuns, [], "子を走らせていない");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function koyaContractFixture(root) {
  const bytes = await readFile(join(SOURCE_ROOT, "config", "koya-manga-production-contract.json"));
  const contract = JSON.parse(bytes.toString("utf8"));
  const path = join(root, "koya-contract.json");
  await writeFile(path, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
  return { path, contract };
}

test("Koya は doctor の前に固定した制作契約の写しで確定し、更新後のリポジトリの契約を後から当てない", async () => {
  const root = await fixture();
  try {
    const { path: contractPath, contract } = await koyaContractFixture(root);
    const { planned, first } = await startedJob(root, {
      harnessId: "koya-manga-video",
      options: { episodeId: "episode-synthetic", contractPath },
    });
    const pinnedDigest = first.resolvedProductionContract.contractDigest;
    assert.equal(pinnedDigest, koyaContractDigest(contract));
    assert.equal(koyaContractDigest(JSON.parse(await readFile(join(planned.runDir, PINNED_PRODUCTION_CONTRACT_FILE), "utf8"))), pinnedDigest,
      "固定した時点で中身の写しを Job の run フォルダへ残す");

    // 更新で契約の中身もコードも変わる。
    const updated = { ...contract, description: `${contract.description} (updated)` };
    await writeFile(contractPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    await simulateUpdate(root, 2);
    const blocked = await runVideoHarnessJob({
      projectDir: root, jobId: planned.id, doctor, projectCanvas,
      adapter: async () => { throw new Error("子を起動してはならない"); },
    });
    assert.deepEqual(blocked.blockers, [CANONICAL_IDENTITY_DRIFT_CODE]);

    let context = null;
    const stillWaiting = await runVideoHarnessJob({
      projectDir: root, jobId: planned.id, doctor, projectCanvas, finalizeAfterUpdate: true,
      adapter: async (value) => {
        context = value;
        // Koya の子が有料の前に行う Job の同一性の検証（固定した契約で解決する）と、配置のバイトの照合。
        await assertVideoHarnessJobIdentity(value.job);
        const entrypointSha256 = sha256(await readFile(value.job.deployment.entrypointPath));
        assert.equal(value.job.deployment.entrypointSha256, entrypointSha256);
        assert.equal(value.job.canonicalIdentity.deployment.entrypointSha256, entrypointSha256);
        return awaitingReview();
      },
    });
    assert.equal(stillWaiting.status, "awaiting-human-review");
    const pinnedPath = context.pinnedProductionContractPath;
    assert.equal(pinnedPath, join(resolve(planned.runDir), FINALIZE_AFTER_UPDATE_DIR, PINNED_PRODUCTION_CONTRACT_FILE));
    const pinned = JSON.parse(await readFile(pinnedPath, "utf8"));
    assert.equal(koyaContractDigest(pinned), pinnedDigest, "子には固定した版の中身を渡す");
    assert.notEqual(koyaContractDigest(pinned), koyaContractDigest(updated));
    assert.deepEqual(stillWaiting.resolvedProductionContract, first.resolvedProductionContract, "固定値（署名の結び先）は変えない");
    assert.equal(stillWaiting.codeIdentityRebind.pinnedProductionContract.source, "job-pinned-at-doctor");
    assert.equal(stillWaiting.codeIdentityRebind.pinnedProductionContract.contractDigest, pinnedDigest);

    // 付け替えた後のふつうの resume も、再利用だけで固定した契約のまま走る。
    let resumedContext = null;
    await runVideoHarnessJob({
      projectDir: root, jobId: planned.id, doctor, projectCanvas,
      adapter: async (value) => { resumedContext = value; return awaitingReview(); },
    });
    assert.equal(resumedContext.pinnedProductionContractPath, pinnedPath);
    assert.match(resumedContext.paidCallGuardPath, /refused-paid-calls-r\d+\.jsonl$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Koya の古い Job は子の回の写しから固定した契約を取り、どこにも無ければ付け替えない", async () => {
  const root = await fixture();
  try {
    const { path: contractPath, contract } = await koyaContractFixture(root);
    const { planned } = await startedJob(root, {
      harnessId: "koya-manga-video",
      options: { episodeId: "episode-synthetic", contractPath },
    });
    // この機能より前の Job は run フォルダの写しを持たない。子の回の写しだけがある。
    await rm(join(planned.runDir, PINNED_PRODUCTION_CONTRACT_FILE), { force: true });
    const snapshot = join(root, "canvas", "manga-videos", "episode-synthetic", "koya-contract-resolved.json");
    await mkdir(dirname(snapshot), { recursive: true });
    await writeFile(snapshot, `${JSON.stringify({ version: contract.version, digest: koyaContractDigest(contract), contract })}\n`, "utf8");
    await writeFile(contractPath, `${JSON.stringify({ ...contract, description: "updated" }, null, 2)}\n`, "utf8");
    await simulateUpdate(root, 2);
    const rebound = await runVideoHarnessJob({
      projectDir: root, jobId: planned.id, doctor, projectCanvas, finalizeAfterUpdate: true, adapter: awaitingReview,
    });
    assert.equal(rebound.status, "awaiting-human-review");
    assert.equal(rebound.codeIdentityRebind.pinnedProductionContract.source, "episode-contract-snapshot");

    // 写しがどこにも無い Job。
    const other = await fixture();
    try {
      const second = await koyaContractFixture(other);
      const { planned: orphan } = await startedJob(other, {
        harnessId: "koya-manga-video",
        options: { episodeId: "episode-synthetic", contractPath: second.path },
      });
      await rm(join(orphan.runDir, PINNED_PRODUCTION_CONTRACT_FILE), { force: true });
      await writeFile(second.path, `${JSON.stringify({ ...second.contract, description: "updated" }, null, 2)}\n`, "utf8");
      await simulateUpdate(other, 2);
      const blocked = await runVideoHarnessJob({
        projectDir: other, jobId: orphan.id, doctor, projectCanvas, finalizeAfterUpdate: true,
        adapter: async () => { throw new Error("子を起動してはならない"); },
      });
      assert.deepEqual(blocked.blockers, [CANONICAL_IDENTITY_DRIFT_CODE, FINALIZE_AFTER_UPDATE_PINNED_CONTRACT_UNAVAILABLE_CODE]);
      assert.equal(blocked.codeIdentityRebind, undefined);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
