// 上位入口（run-video-harness start / MCP run_video_harness）が、台本の関門を持つハーネスの Job の options に
// 台本の品質ループの作業フォルダ（scriptQualityWorkDir。Job の識別子に入る）を入れ、子へ同じ path を渡すこと。
// パスはすべて合成（tmpdir の下）。有料 API もネットワークも使わない。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { executeVideoHarnessAdapter } from "../lib/videoHarnessAdapters.mjs";
import { createVideoHarnessService, videoHarnessStartOptionsWithScriptQuality } from "../lib/videoHarnessService.mjs";
import { createReviewerTrustEntry, generateReviewerKeyPair } from "../lib/koyaReviewAttestation.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const OPERATOR_ENV = Object.freeze({
  BUZZASSIST_REVIEWER_TRUST_JSON: JSON.stringify({
    version: "koya-reviewer-trust-v1",
    reviewers: [createReviewerTrustEntry({ publicKeyPem: generateReviewerKeyPair().publicKeyPem, label: "fixture-operator" })],
  }),
});

function service(calls, harnessId) {
  return createVideoHarnessService({
    createJob: async (input) => {
      calls.push(input);
      return { job: { id: "video-fixture-0123456789abcdef", status: "planned", projectDir: input.projectDir, harness: { id: harnessId }, options: input.options, blockers: [], knownRemainingIssues: [] }, attached: false };
    },
    readJob: async () => { throw new Error("not used"); },
    projectCanvas: async () => ({ ok: true }),
    productionProfile: async () => ({ profileId: "operator-production" }),
    planPreflight: async () => null,
    env: OPERATOR_ENV,
    captureRunLearning: async () => null,
  });
}

test("start の既定: 台本の関門を持つハーネスは、台本のあるフォルダを options.scriptQualityWorkDir に入れる（明示は上書きしない）", async () => {
  const scriptPath = join(tmpdir(), "synthetic-scripts", "episode-a", "script.md");
  const explicit = join(tmpdir(), "synthetic-loop-folder");
  const koyaOptions = { episodeId: "ep", protagonistSpeakerId: "lead", characterBiblePath: "/tmp/bible.json", storyReviewPath: "/tmp/review.json" };
  for (const [harnessId, options] of [["narrated-story-video", {}], ["koya-manga-video", koyaOptions]]) {
    const calls = [];
    await service(calls, harnessId).start({ projectDir: tmpdir(), scriptPath, channelPackPath: join(tmpdir(), "pack"), harnessId, options });
    assert.equal(calls[0].options.scriptQualityWorkDir, dirname(resolve(scriptPath)), harnessId);
    const explicitCalls = [];
    await service(explicitCalls, harnessId).start({ projectDir: tmpdir(), scriptPath, channelPackPath: join(tmpdir(), "pack"), harnessId, options: { ...options, scriptQualityWorkDir: explicit } });
    assert.equal(explicitCalls[0].options.scriptQualityWorkDir, resolve(explicit), harnessId);
  }
  // 相対の明示は Job の projectDir から解く（MCP の server の作業フォルダ＝配布の plugin のフォルダから解かない）。
  const relative = [];
  const projectDir = join(tmpdir(), "synthetic-project");
  await service(relative, "narrated-story-video").start({ projectDir, scriptPath, channelPackPath: join(tmpdir(), "pack"), harnessId: "narrated-story-video", options: { scriptQualityWorkDir: join("scripts", "episode-a") } });
  assert.equal(relative[0].options.scriptQualityWorkDir, join(projectDir, "scripts", "episode-a"));
  // 空の明示は Job を作る前に止める（黙って台本のフォルダへ倒さない）。
  const refused = [];
  await assert.rejects(
    service(refused, "narrated-story-video").start({ projectDir: tmpdir(), scriptPath, channelPackPath: join(tmpdir(), "pack"), harnessId: "narrated-story-video", options: { scriptQualityWorkDir: " " } }),
    /script-quality-work-dir-invalid/u,
  );
  assert.equal(refused.length, 0);
  // 台本の関門を持たない・決まらないハーネスは options に触らない。
  const untouched = { title: "x" };
  assert.equal(videoHarnessStartOptionsWithScriptQuality({ harnessId: "fixture-harness", options: untouched, scriptPath }), untouched);
  assert.equal(videoHarnessStartOptionsWithScriptQuality({ harnessId: "", want: "", options: untouched, scriptPath }), untouched);
});

test("ナレーション物語の子には Job の作業フォルダを渡す（Job に無ければ渡さない）", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "narrated-adapter-script-quality-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, "script.txt"), "合成の台本。\n");
  const loopFolder = join(workspace, "loop");
  const invoke = async (options) => {
    let args = null;
    await executeVideoHarnessAdapter({
      job: {
        id: "video-narrated-story-video-0123456789abcdef",
        identityDigest: "a".repeat(64),
        revision: 1,
        status: "running",
        runDir: join(workspace, "canvas", "harness-runs", "video-narrated-story-video-0123456789abcdef"),
        harness: { id: "narrated-story-video" },
        deployment: { root, entrypoint: "node scripts/narrated-story-video.mjs" },
        projectDir: workspace,
        script: { path: join(workspace, "script.txt"), sha256: "b".repeat(64) },
        stages: [{
          id: "doctor",
          status: "pass",
          finishedAt: "2026-09-01T00:00:00.000Z",
          evidence: { version: "harness-doctor-v1", ready: true, blocking: [] },
        }],
        options,
      },
      prepareResult: { payloadDir: join(workspace, "payload") },
      runChild: async (_command, childArgs) => {
        args = childArgs;
        return { code: 3, signal: null, stdout: JSON.stringify({ status: "awaiting-human-review", knownRemainingIssues: ["script-quality-required:script-quality-loop-not-started"], next: "accept-human ..." }), stderr: "" };
      },
    });
    return args;
  };
  const withFolder = await invoke({ scriptQualityWorkDir: loopFolder });
  assert.equal(withFolder[withFolder.indexOf("--script-quality-work-dir") + 1], loopFolder);
  const without = await invoke({});
  assert.equal(without.includes("--script-quality-work-dir"), false);
});

test("run-video-harness: resume では作業フォルダを変えられない（Job の識別子に入る）", () => {
  const result = spawnSync(process.execPath, [join(root, "scripts", "run-video-harness.mjs"), "resume", "--job-id", "video-fixture-0123456789abcdef", "--confirmed", "--script-quality-work-dir", tmpdir()], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--script-quality-work-dir は start でだけ渡す/u);
  const help = spawnSync(process.execPath, [join(root, "scripts", "run-video-harness.mjs"), "help"], { encoding: "utf8" });
  assert.match(help.stdout, /--script-quality-work-dir DIR/u);
});
