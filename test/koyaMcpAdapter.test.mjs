import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requireArtifacts, requireChannelPack } from "./helpers/requirePrerequisites.mjs";

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createReviewerTrustEntry, generateReviewerKeyPair } from "../lib/koyaReviewAttestation.mjs";
import {
  KOYA_MCP_ACTIONS,
  READ_ONLY_ACTIONS,
  _assertReviewerTrustPathAgreesWithHost,
  _buildKoyaCliArgs,
  doctorKoyaMcp,
  koyaJobResourceKey,
  readKoyaMcpJob,
  runKoyaMcpAction,
  startKoyaMcpJob,
} from "../lib/koyaMcpAdapter.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

// R6-1: doctor は reviewer 信頼アンカーを必須項目として見るので、決定論 runtime には運営者 env を含める。
const OPERATOR_TRUST_JSON = (() => {
  const pair = generateReviewerKeyPair();
  return JSON.stringify({ version: "koya-reviewer-trust-v1", reviewers: [createReviewerTrustEntry({ publicKeyPem: pair.publicKeyPem, label: "mcp-doctor-fixture" })] });
})();

function deterministicDoctorRuntime() {
  const binary = (command) => ({ ok: true, command, args: [], version: "7.1.1" });
  return {
    env: { ...process.env, BUZZASSIST_REVIEWER_TRUST_JSON: OPERATOR_TRUST_JSON, BUZZASSIST_REVIEWER_TRUST: "", BUZZASSIST_KOYA_REVIEWER_TRUST: "", BUZZASSIST_KOYA_REVIEWER_TRUST_JSON: "" },
    ffmpegToolchain: { ok: true, ffmpeg: binary("ffmpeg"), ffprobe: binary("ffprobe") },
    runCommand: async (_command, args = []) => {
      if (args.includes("-encoders")) return { stdout: "libx264 aac pcm_s24le", stderr: "" };
      if (args.includes("-filters")) return { stdout: "scale crop overlay fps loudnorm aresample", stderr: "" };
      if (args.includes("-show_streams")) {
        return { stdout: JSON.stringify({ streams: [{ codec_type: "video" }, { codec_type: "audio" }] }), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    pythonRuntime: { ok: true, command: "python", args: [], version: "3.12.2" },
    voiceQualityProbe: async () => true,
    mediaAdapterProbe: async (spec) => ({ ok: true, status: "ready", ...spec }),
    imageModel: "gpt-image-2-codex",
    imageHostProbe: async (model) => ({ ok: true, host: "codex", model, detail: `Codex / ${model}` }),
  };
}

test("Koya MCP doctor and read-only actions use the canonical CLI", async (t) => {
  if (!requireChannelPack(t, "doctor の正本チェック")) return;
  const doctor = await doctorKoyaMcp({ projectDir: root }, { runtime: deterministicDoctorRuntime() });
  assert.equal(doctor.ok, true, JSON.stringify(doctor));
  assert.equal(doctor.contract.validation.pass, true);
  assert.equal(doctor.channelAuthority.validation.show.pass, true);
  assert.equal(doctor.channelAuthority.validation.locations.pass, true);
  assert.equal(doctor.channelAuthority.validation.thumbnail.pass, true);
  assert.equal(doctor.channelAuthority.validation.styling.pass, true);
  assert.equal(doctor.productionEntrypoint, "node scripts/koya-manga-video.mjs");
  assert.equal(doctor.runtime.version, "harness-doctor-v1");
  assert.equal(doctor.runtime.harnessId, "koya-manga-video");
  assert.equal(doctor.runtime.ready, true, JSON.stringify(doctor.runtime));
  assert.equal(doctor.runtime.checks.find((check) => check.id === "image-key")?.model, "gpt-image-2-codex");
  const trust = doctor.runtime.checks.find((check) => check.id === "reviewer-trust");
  assert.equal(trust?.required, true, "ハーネス指定の doctor では reviewer 信頼アンカーは必須項目");
  assert.equal(trust?.ok, true, trust?.detail);
  assert.equal(trust?.activeReviewers, 1);
  assert.ok(doctor.checks.filter((check) => check.path.endsWith(".json")).every((check) => check.ok && check.version));
  assert.ok(KOYA_MCP_ACTIONS.includes("character-style-generate"));
  assert.ok(KOYA_MCP_ACTIONS.includes("character-style-import"));
  assert.ok(KOYA_MCP_ACTIONS.includes("character-identity-refresh"));
  assert.ok(KOYA_MCP_ACTIONS.includes("character-style-record-failure"));
  assert.ok(KOYA_MCP_ACTIONS.includes("character-bootstrap-status"));
  assert.ok(KOYA_MCP_ACTIONS.includes("character-style-compose"));
  assert.ok(KOYA_MCP_ACTIONS.includes("character-style-select"));
  assert.ok(KOYA_MCP_ACTIONS.includes("handoff-export"));
  assert.ok(KOYA_MCP_ACTIONS.includes("handoff-verify"));
  assert.ok(KOYA_MCP_ACTIONS.includes("handoff-restore"));
  assert.ok(KOYA_MCP_ACTIONS.includes("story-audit"));
  assert.ok(KOYA_MCP_ACTIONS.includes("story-review-draft"));
  assert.ok(KOYA_MCP_ACTIONS.includes("cast-readiness"));
  assert.ok(KOYA_MCP_ACTIONS.includes("location-plan"));
  assert.ok(KOYA_MCP_ACTIONS.includes("location-generate"));
  assert.ok(KOYA_MCP_ACTIONS.includes("location-anchor-review-draft"));
  assert.ok(KOYA_MCP_ACTIONS.includes("location-anchor-audit"));
  assert.ok(KOYA_MCP_ACTIONS.includes("location-review-draft"));
  assert.ok(KOYA_MCP_ACTIONS.includes("location-register"));
  assert.ok(KOYA_MCP_ACTIONS.includes("thumbnail-plan-draft"));
  assert.ok(KOYA_MCP_ACTIONS.includes("thumbnail-audit"));
  const contract = await runKoyaMcpAction({ projectDir: root, action: "contract" });
  assert.equal(contract.ok, true);
  assert.equal(contract.result.validation.pass, true);
});

test("Koya MCP mutating actions require confirmation and checkpoint background failures", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-koya-mcp-"));
  try {
    await assert.rejects(
      () => startKoyaMcpJob({ projectDir, action: "character-review-refresh", options: {} }),
      /confirmed=true/u,
    );
    const started = await startKoyaMcpJob({
      projectDir,
      action: "character-review-refresh",
      confirmed: true,
      options: {
        workflowId: "missing-workflow",
        generatorHost: "legacy-migration",
        generatorContextId: "test-migration",
      },
    });
    let current = started;
    // 固定回数（100回×50ms＝5秒）で打ち切っていたので、子プロセスの起動が遅い
    // Windows のランナーでは running のまま assert に入って落ちた。締め切りで待ち、
    // 超えたときは何秒待ったのかを出す。
    const waitStartedAt = Date.now();
    const deadline = waitStartedAt + 120_000;
    while (["queued", "running"].includes(current.status) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      current = await readKoyaMcpJob({ projectDir, jobId: started.id });
    }
    assert.equal(
      current.status,
      "failed",
      `${Math.round((Date.now() - waitStartedAt) / 1000)}秒待っても終わらない: ${JSON.stringify(current)}`,
    );
    assert.notEqual(current.exitCode, 0);
    assert.match(current.stderrTail, /Unknown character workflow/u);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Koya MCP doctor refuses an empty recipient until its signed pack is restored locally", async (t) => {
  if (!requireChannelPack(t, "doctor の正本チェック")) return;
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-koya-empty-project-"));
  try {
    const doctor = await doctorKoyaMcp({ projectDir }, { runtime: deterministicDoctorRuntime() });
    assert.equal(doctor.ok, false, JSON.stringify(doctor));
    assert.equal(doctor.projectDataRestored, false);
    assert.equal(doctor.projectDataState, "plugin-default-awaiting-restore");
    assert.equal(doctor.authorityRoot, root);
    assert.equal(doctor.runtime.harnessId, "koya-manga-video");
    assert.equal(doctor.runtime.ready, false, JSON.stringify(doctor.runtime));
    assert.ok(doctor.runtime.blocking.includes("channel-pack"));
    const pack = doctor.runtime.checks.find((check) => check.id === "channel-pack");
    assert.equal(pack.required, true);
    assert.equal(pack.ok, false, "runtime側の別Channel Packを空projectの正本として借りない");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Koya MCP adapter forwards reviewer key/trust file paths to the canonical CLI and refuses key material", () => {
  const args = _buildKoyaCliArgs("signoff", {
    projectDir: "/tmp/project",
    episodeId: "ep-001",
    reviewer: "codex",
    reviewerId: "codex-reviewer",
    reviewerContextId: "review-task-1",
    reviewNotesPath: "/tmp/review.json",
    reviewerKeyPath: "/secure/reviewer-ed25519.pem",
    reviewerTrustPath: "/secure/reviewer-trust.json",
    pass: true,
  });
  assert.equal(args[1], "signoff");
  assert.equal(args[args.indexOf("--reviewer-key-path") + 1], "/secure/reviewer-ed25519.pem");
  assert.equal(args[args.indexOf("--reviewer-trust-path") + 1], "/secure/reviewer-trust.json");
  assert.equal(args[args.indexOf("--reviewer-id") + 1], "codex-reviewer");
  assert.ok(args.includes("--pass"));
  const audit = _buildKoyaCliArgs("audit", { projectDir: "/tmp/project", episodeId: "ep-001", videoPath: "/tmp/final.mp4", reviewerTrustPath: "/secure/trust.json" });
  assert.equal(audit[audit.indexOf("--reviewer-trust-path") + 1], "/secure/trust.json");
  const keyCreate = _buildKoyaCliArgs("reviewer-key-create", { reviewerKeyPath: "/secure/new.pem", reviewerPublicKeyPath: "/secure/new.pub", reviewerLabel: "lane" });
  assert.equal(keyCreate[keyCreate.indexOf("--reviewer-public-key-path") + 1], "/secure/new.pub");
  assert.equal(keyCreate[keyCreate.indexOf("--reviewer-label") + 1], "lane");
  assert.ok(KOYA_MCP_ACTIONS.includes("reviewer-key-create"));

  assert.throws(() => _buildKoyaCliArgs("signoff", { reviewerPrivateKeyPem: "-----BEGIN PRIVATE KEY-----" }), /key material/u);
  assert.throws(() => _buildKoyaCliArgs("signoff", { reviewerKey: "abc" }), /key material/u);
  assert.throws(() => _buildKoyaCliArgs("signoff", { reviewNotesPath: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" }), /key or trust-list material/u);
  assert.throws(() => _buildKoyaCliArgs("audit", { reviewerTrustPath: '{"version":"koya-reviewer-trust-v1","reviewers": [ ]}' }), /key or trust-list material/u);
  assert.ok(!_buildKoyaCliArgs("signoff", { reviewerKeyPath: "/secure/k.pem" }).some((value) => /BEGIN/u.test(value)));
});

test("R4-1: Koya MCP reviewerTrustPath cannot replace the host's BUZZASSIST_REVIEWER_TRUST trust anchor", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "koya-mcp-trust-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const writeTrust = async (file, label) => {
    const pair = generateReviewerKeyPair();
    await writeFile(file, JSON.stringify({ version: "koya-reviewer-trust-v1", reviewers: [createReviewerTrustEntry({ publicKeyPem: pair.publicKeyPem, label })] }));
  };
  const hostTrust = path.join(dir, "host-trust.json");
  const selfMinted = path.join(dir, "self-minted.json");
  const hostCopy = path.join(dir, "host-copy.json");
  await writeTrust(hostTrust, "operator");
  await writeTrust(selfMinted, "self-minted");
  await writeFile(hostCopy, await (await import("node:fs/promises")).readFile(hostTrust));

  // host 未設定なら明示 path は信頼アンカーにならない（要求側の入力だけで自己承認へ退化させない）。
  await assert.rejects(
    _assertReviewerTrustPathAgreesWithHost({ reviewerTrustPath: selfMinted }, {}),
    /^Error: reviewer-trust-unconfigured:/u,
  );
  await assert.rejects(
    _assertReviewerTrustPathAgreesWithHost({ reviewerTrustPath: hostCopy }, {}),
    (error) => /^reviewer-trust-unconfigured:/u.test(error.message) && !error.message.includes(dir),
    "env 未設定は「正しい内容の path」でも同じく fail-closed で、path 文字列は載せない",
  );
  // path を渡さなければここでは何も確認しない（Receipt / audit 側が env を読む）。
  await _assertReviewerTrustPathAgreesWithHost({}, {});
  await _assertReviewerTrustPathAgreesWithHost({}, { BUZZASSIST_REVIEWER_TRUST: hostTrust });
  // host 設定あり + 同じ内容の写し → 通る。別内容 → conflict。
  await _assertReviewerTrustPathAgreesWithHost({ reviewerTrustPath: hostCopy }, { BUZZASSIST_REVIEWER_TRUST: hostTrust });
  await assert.rejects(
    _assertReviewerTrustPathAgreesWithHost({ reviewerTrustPath: selfMinted }, { BUZZASSIST_REVIEWER_TRUST: hostTrust }),
    /^Error: reviewer-trust-conflict:/u,
  );
  await assert.rejects(
    _assertReviewerTrustPathAgreesWithHost({ reviewerTrustPath: selfMinted }, { BUZZASSIST_KOYA_REVIEWER_TRUST: hostTrust }),
    /^Error: reviewer-trust-conflict:/u,
    "旧 env 名でも host が正",
  );
  await assert.rejects(
    _assertReviewerTrustPathAgreesWithHost({ reviewerTrustPath: hostCopy }, { BUZZASSIST_REVIEWER_TRUST: hostTrust, BUZZASSIST_KOYA_REVIEWER_TRUST: selfMinted }),
    /env-ambiguous/u,
    "新旧 env の食い違いは fail-closed",
  );

  // 実入口: process.env に host の信頼リストがある状態で別 path を渡すと、CLI を spawn する前に拒否される。
  const previous = process.env.BUZZASSIST_REVIEWER_TRUST;
  process.env.BUZZASSIST_REVIEWER_TRUST = hostTrust;
  t.after(() => { if (previous === undefined) delete process.env.BUZZASSIST_REVIEWER_TRUST; else process.env.BUZZASSIST_REVIEWER_TRUST = previous; });
  for (const start of [runKoyaMcpAction, startKoyaMcpJob]) {
    await assert.rejects(
      start({ action: "audit", confirmed: true, projectDir: dir, options: { episodeId: "ep-r4", videoPath: path.join(dir, "final.mp4"), reviewerTrustPath: selfMinted } }),
      /^Error: reviewer-trust-conflict:/u,
    );
  }
  await assert.rejects(
    startKoyaMcpJob({ action: "signoff", confirmed: true, projectDir: dir, options: { episodeId: "ep-r4", reviewerKeyPath: path.join(dir, "k.pem"), reviewerTrustPath: selfMinted, pass: true } }),
    /^Error: reviewer-trust-conflict:/u,
  );
  const { readdir } = await import("node:fs/promises");
  await assert.rejects(readdir(path.join(dir, "canvas", "koya-mcp-jobs")), { code: "ENOENT" }, "拒否された起動は detached job を作らない");
});

test("R6-6: OPTION_NAMES maps each option to exactly one CLI flag and READ_ONLY_ACTIONS is the exported single definition", () => {
  const args = _buildKoyaCliArgs("signoff", { projectDir: "/tmp/p", episodeId: "ep", reviewerId: "codex-reviewer", reviewerKeyPath: "/secure/k.pem", pass: true });
  assert.equal(args.filter((value) => value === "--reviewer-id").length, 1, "--reviewer-id は子 argv に 1 回だけ");
  const flags = args.filter((value) => value.startsWith("--"));
  assert.equal(new Set(flags).size, flags.length, "同じ flag が二重に並ばない");
  assert.ok(READ_ONLY_ACTIONS instanceof Set);
  assert.ok(READ_ONLY_ACTIONS.has("contract"));
  assert.ok(READ_ONLY_ACTIONS.has("status"));
  assert.ok(!READ_ONLY_ACTIONS.has("signoff"));
  assert.ok(!READ_ONLY_ACTIONS.has("full"));
  for (const action of READ_ONLY_ACTIONS) assert.ok(KOYA_MCP_ACTIONS.includes(action), `${action} は公開 action 一覧に含まれる`);
});

test("R6-7: reviewer-key-create and signoff resource keys include the key path and reviewer identity so a different request never attaches to a prior job", () => {
  const projectDir = "/tmp/project";
  const keyA = koyaJobResourceKey({ projectDir, action: "reviewer-key-create", options: { reviewerKeyPath: "/secure/a.pem" } });
  const keyB = koyaJobResourceKey({ projectDir, action: "reviewer-key-create", options: { reviewerKeyPath: "/secure/b.pem" } });
  const keyAAgain = koyaJobResourceKey({ projectDir, action: "reviewer-key-create", options: { reviewerKeyPath: "/secure/a.pem" } });
  assert.notEqual(keyA, keyB, "別 path への鍵作成は別案件");
  assert.equal(keyA, keyAAgain, "同じ path は同じ案件（二重起動抑止は保つ）");

  const base = { episodeId: "ep-001", reviewer: "codex", reviewerId: "r1", reviewerContextId: "ctx-1", reviewerKeyPath: "/secure/a.pem", pass: true };
  const signoffA = koyaJobResourceKey({ projectDir, action: "signoff", options: base });
  assert.equal(signoffA, koyaJobResourceKey({ projectDir, action: "signoff", options: { ...base } }));
  assert.notEqual(signoffA, koyaJobResourceKey({ projectDir, action: "signoff", options: { ...base, reviewerKeyPath: "/secure/b.pem" } }), "別鍵の signoff は別案件");
  assert.notEqual(signoffA, koyaJobResourceKey({ projectDir, action: "signoff", options: { ...base, reviewerContextId: "ctx-2" } }), "別 context の signoff は別案件");
  assert.notEqual(signoffA, koyaJobResourceKey({ projectDir, action: "signoff", options: { ...base, reviewer: "claude" } }), "別 reviewer host の signoff は別案件");
  assert.notEqual(signoffA, koyaJobResourceKey({ projectDir, action: "signoff", options: { ...base, reviewerId: "r2" } }), "別 reviewerId の signoff は別案件");
  // 生成系の資源キーは従来どおり project + action + episode（二重課金抑止の粒度を変えない）。
  assert.equal(
    koyaJobResourceKey({ projectDir, action: "speech", options: { episodeId: "ep-001", reviewerKeyPath: "/x" } }),
    koyaJobResourceKey({ projectDir, action: "speech", options: { episodeId: "ep-001" } }),
  );
});
