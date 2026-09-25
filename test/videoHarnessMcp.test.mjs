import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { createReviewerTrustEntry, generateReviewerKeyPair } from "../lib/koyaReviewAttestation.mjs";
import {
  PROJECT_DIR_UNRESOLVED_CODE,
  REVIEWER_PATH_NOT_ABSOLUTE_CODE,
  TOOL_CANCEL_VIDEO_HARNESS_JOB,
  TOOL_COLLECT_VIDEO_HARNESS_FEEDBACK,
  TOOL_CREATE_VIDEO_HARNESS_REVIEWER_KEY,
  TOOL_GET_VIDEO_HARNESS_JOB,
  TOOL_LIST_VIDEO_HARNESS_JOBS,
  TOOL_PLAN_VIDEO_REQUEST,
  TOOL_RESUME_VIDEO_HARNESS_JOB,
  TOOL_RUN_VIDEO_HARNESS,
  TOOL_SIGNOFF_VIDEO_HARNESS_JOB,
  VIDEO_HARNESS_TOOL_NAMES,
  createVideoHarnessReviewerActions,
  handleVideoHarnessToolCall,
  isVideoHarnessToolName,
  videoHarnessToolDefinitions,
} from "../lib/videoHarnessMcp.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function serviceResult(operation, overrides = {}) {
  return {
    version: "buzzassist-video-harness-service-result-v1",
    ok: true,
    operation,
    projectDir: "/tmp/project",
    jobId: operation === "list" ? null : "video-fixture-0123456789abcdef",
    status: operation === "list" ? null : "planned",
    job: operation === "list" ? null : { id: "video-fixture-0123456789abcdef", status: "planned" },
    jobs: [],
    attached: null,
    execution: { mode: "none", confirmed: false, started: false, planOnly: false },
    note: "",
    ...overrides,
  };
}

test("generic MCP definitions expose plan/run, get/list/cancel/resume without secret or trusted-key fields", () => {
  const definitions = videoHarnessToolDefinitions();
  assert.deepEqual(definitions.map((definition) => definition.name), VIDEO_HARNESS_TOOL_NAMES);
  assert.deepEqual(VIDEO_HARNESS_TOOL_NAMES, [
    TOOL_PLAN_VIDEO_REQUEST,
    TOOL_RUN_VIDEO_HARNESS,
    TOOL_GET_VIDEO_HARNESS_JOB,
    TOOL_LIST_VIDEO_HARNESS_JOBS,
    TOOL_CANCEL_VIDEO_HARNESS_JOB,
    TOOL_RESUME_VIDEO_HARNESS_JOB,
    TOOL_COLLECT_VIDEO_HARNESS_FEEDBACK,
    TOOL_SIGNOFF_VIDEO_HARNESS_JOB,
    TOOL_CREATE_VIDEO_HARNESS_REVIEWER_KEY,
  ]);
  const run = definitions.find((definition) => definition.name === TOOL_RUN_VIDEO_HARNESS);
  // channelPackPath は channelId が無いときに service が要求する（チャンネルなら台帳が決める）。
  assert.deepEqual(run.inputSchema.required, ["scriptPath"]);
  assert.equal(run.inputSchema.properties.confirmed.default, false);
  assert.deepEqual(Object.keys(run.inputSchema.properties).sort(), [
    "channelId",
    "channelPackPath",
    "confirmed",
    "harnessId",
    "hostModel",
    "options",
    "projectDir",
    "reviewerTrustPath",
    "scriptPath",
    "strategyBriefPath",
    "want",
  ]);
  const resume = definitions.find((definition) => definition.name === TOOL_RESUME_VIDEO_HARNESS_JOB);
  assert.deepEqual(resume.inputSchema.required, ["jobId", "confirmed"]);
  assert.deepEqual(Object.keys(resume.inputSchema.properties).sort(), ["confirmed", "finalizeAfterUpdate", "hostModel", "jobId", "projectDir", "retryFailedImages", "reviewerTrustPath"]);
  assert.equal(resume.inputSchema.properties.finalizeAfterUpdate.type, "boolean");
  assert.match(resume.inputSchema.properties.finalizeAfterUpdate.description, /--finalize-after-update/u, "CLI と同じ引数だと説明する");
  assert.match(resume.inputSchema.properties.finalizeAfterUpdate.description, /finalize-after-update-paid-call-required/u, "新しい有料の呼び出しは送る前に止まると説明する");
  assert.doesNotMatch(JSON.stringify(run.inputSchema.properties), /finalizeAfterUpdate/u, "start には無い（実行文脈は resume だけ）");
  assert.equal(resume.inputSchema.properties.retryFailedImages.type, "boolean");
  assert.match(resume.inputSchema.properties.retryFailedImages.description, /re-billing/u, "再課金の事実が記録されると説明する");
  assert.match(resume.inputSchema.properties.retryFailedImages.description, /--retry-failed-images/u, "CLI と同じ引数だと説明する");
  assert.doesNotMatch(JSON.stringify(run.inputSchema.properties), /retryFailedImages/u, "start には無い（実行文脈は resume だけ）");
  for (const definition of [run, resume]) {
    assert.match(definition.inputSchema.properties.reviewerTrustPath.description, /[Pp]ath only/u);
    assert.match(definition.inputSchema.properties.reviewerTrustPath.description, /BUZZASSIST_REVIEWER_TRUST[^.]*authoritative/u, "運営者 env が正であると説明する");
    assert.match(definition.inputSchema.properties.reviewerTrustPath.description, /reviewer-trust-conflict/u);
    assert.match(definition.inputSchema.properties.reviewerTrustPath.description, /reviewer-trust-unconfigured/u, "env 未設定は明示 path があっても fail-closed と説明する");
    assert.doesNotMatch(definition.inputSchema.properties.reviewerTrustPath.description, /only used on its own|stands on its own/u, "明示 path が単独で信頼アンカーになる説明を残さない（R5-F2/R5-3 drift 防止）");
    assert.doesNotMatch(definition.inputSchema.properties.reviewerTrustPath.description, /options\.reviewerTrustPath or/u, "options 経由の fallback は無い");
    assert.ok(!Object.keys(definition.inputSchema.properties).some((key) => /key(?:Path)?$|pem$/iu.test(key)), "production Job には reviewer 秘密鍵の path も取らない");
  }
  // 両ハーネス中立: run_video_harness の説明が Koya 専用ツールだけへ誘導しない。
  assert.match(run.inputSchema.properties.options.description, /signoff_video_harness_job/u);
  assert.match(run.inputSchema.properties.options.description, /run_koya_manga_pipeline action=signoff/u);
  assert.match(run.description, /narrated-story-video/u);

  // narrated signoff / reviewer-key-create の MCP 入口（F-4）。引数名は Koya の MCP 入口と同じ。
  const signoff = definitions.find((definition) => definition.name === TOOL_SIGNOFF_VIDEO_HARNESS_JOB);
  assert.deepEqual(signoff.inputSchema.required.sort(), ["confirmed", "jobId", "pass", "reviewPath", "reviewer", "reviewerContextId", "reviewerKeyPath"]);
  assert.deepEqual(Object.keys(signoff.inputSchema.properties).sort(), [
    "confirmed", "contactSheetPath", "force", "jobId", "pass", "projectDir", "reviewPath", "reviewer", "reviewerContextId",
    "reviewerId", "reviewerKeyPath", "reviewerTrustPath", "signoffPath", "videoPath",
  ]);
  // 採点ファイル（品質ループの1回）と、差し戻し（pass=false）を受ける。
  assert.match(signoff.inputSchema.properties.reviewPath.description, /rubricScores/u);
  assert.match(signoff.inputSchema.properties.reviewPath.description, /reviewer-path-not-absolute/u);
  assert.match(signoff.inputSchema.properties.pass.description, /false asks for changes/u);
  assert.equal(signoff.inputSchema.additionalProperties, false);
  assert.ok(!Object.keys(signoff.inputSchema.properties).some((key) => /pem$|privateKey/iu.test(key)), "鍵の中身を受ける引数は無い");
  assert.match(signoff.inputSchema.properties.reviewerKeyPath.description, /FILE path/u);
  // R6-F5: path 引数は絶対 path と説明し、相対 path の拒否コードを載せる。
  assert.match(signoff.inputSchema.properties.reviewerKeyPath.description, /reviewer-path-not-absolute/u);
  assert.match(signoff.inputSchema.properties.reviewerTrustPath.description, /^Absolute path/u);
  assert.match(signoff.inputSchema.properties.signoffPath.description, /reviewer-path-not-absolute/u);
  const keyCreate = definitions.find((definition) => definition.name === TOOL_CREATE_VIDEO_HARNESS_REVIEWER_KEY);
  assert.deepEqual(keyCreate.inputSchema.required.sort(), ["confirmed", "reviewerKeyPath"]);
  assert.deepEqual(Object.keys(keyCreate.inputSchema.properties).sort(), ["confirmed", "projectDir", "reviewerKeyPath", "reviewerLabel", "reviewerPublicKeyPath"]);
  for (const definition of [signoff, keyCreate]) {
    assert.equal(definition.annotations.readOnlyHint, false);
    assert.equal(definition.annotations.openWorldHint, false, "reviewer 工程は有料 API を呼ばない");
  }
  const collect = definitions.find((definition) => definition.name === TOOL_COLLECT_VIDEO_HARNESS_FEEDBACK);
  assert.deepEqual(collect.inputSchema.required, ["jobId"]);
  assert.deepEqual(Object.keys(collect.inputSchema.properties).sort(), ["jobId", "projectDir"]);
  assert.equal(collect.annotations.idempotentHint, true);
  assert.ok(VIDEO_HARNESS_TOOL_NAMES.every(isVideoHarnessToolName));
  assert.equal(isVideoHarnessToolName("build_excalidraw_manga_video"), false);
});

test("MCP handler is a thin dispatcher and preserves the service result envelope", async () => {
  const calls = [];
  const service = {
    start: async (args) => {
      calls.push(["start", args]);
      return serviceResult("start", {
        execution: { mode: "plan-only", confirmed: false, started: false, planOnly: true },
      });
    },
    get: async (args) => { calls.push(["get", args]); return serviceResult("get"); },
    list: async (args) => { calls.push(["list", args]); return serviceResult("list", { jobs: [{ id: "video-a" }] }); },
    cancel: async (args) => { calls.push(["cancel", args]); return serviceResult("cancel", { status: "cancel-requested" }); },
    resume: async (args) => { calls.push(["resume", args]); return serviceResult("resume", { status: "completed" }); },
  };
  const feedbackCollector = async (args) => {
    calls.push(["collect-feedback", args]);
    return {
      version: "buzzassist-canvas-feedback-collection-v1",
      ok: true,
      operation: "collect-feedback",
      jobId: args.jobId,
      captured: 1,
      duplicates: 0,
      stale: 0,
    };
  };

  // projectDir を省いた呼び出しは EXCALIDRAW_PROJECT_DIR（setup 時 project）で埋まる。cwd には落ちない。
  const env = { EXCALIDRAW_PROJECT_DIR: "/tmp/project" };
  const planned = await handleVideoHarnessToolCall({
    name: TOOL_RUN_VIDEO_HARNESS,
    arguments: { projectDir: "/tmp/project", scriptPath: "script.txt", channelPackPath: "pack" },
  }, { service, feedbackCollector, env });
  assert.equal(planned.structuredContent.operation, "start");
  assert.equal(planned.structuredContent.execution.planOnly, true);
  assert.match(planned.content[0].text, /paid generation was not started/u);

  await handleVideoHarnessToolCall({ name: TOOL_GET_VIDEO_HARNESS_JOB, arguments: { jobId: "video-a" } }, { service, feedbackCollector, env });
  await handleVideoHarnessToolCall({ name: TOOL_LIST_VIDEO_HARNESS_JOBS, arguments: {} }, { service, feedbackCollector, env });
  await handleVideoHarnessToolCall({ name: TOOL_CANCEL_VIDEO_HARNESS_JOB, arguments: { jobId: "video-a" } }, { service, feedbackCollector, env });
  await handleVideoHarnessToolCall({
    name: TOOL_RESUME_VIDEO_HARNESS_JOB,
    arguments: { jobId: "video-a", confirmed: true, reviewerTrustPath: "/secure/reviewer-trust.json", retryFailedImages: true, finalizeAfterUpdate: false },
  }, { service, feedbackCollector, env });
  const feedback = await handleVideoHarnessToolCall({
    name: TOOL_COLLECT_VIDEO_HARNESS_FEEDBACK,
    arguments: { jobId: "video-a" },
  }, { service, feedbackCollector, env });
  const reviewerActions = {
    signoff: async (args) => { calls.push(["signoff", args]); return { ok: true, operation: "signoff", harnessId: "narrated-story-video", jobId: args.jobId, entrypoint: "node scripts/narrated-story-video.mjs", result: { pass: true } }; },
    createReviewerKey: async (args) => { calls.push(["reviewer-key-create", args]); return { ok: true, operation: "reviewer-key-create", result: { keyId: "ed25519:" + "a".repeat(24), privateKeyPath: args.reviewerKeyPath } }; },
  };
  const signed = await handleVideoHarnessToolCall({
    name: TOOL_SIGNOFF_VIDEO_HARNESS_JOB,
    arguments: { jobId: "video-a", confirmed: true, reviewer: "codex", reviewerContextId: "task-2", reviewerKeyPath: "/secure/k.pem", pass: true },
  }, { service, feedbackCollector, reviewerActions });
  const keyed = await handleVideoHarnessToolCall({
    name: TOOL_CREATE_VIDEO_HARNESS_REVIEWER_KEY,
    arguments: { confirmed: true, reviewerKeyPath: "/secure/k.pem" },
  }, { service, feedbackCollector, reviewerActions });
  assert.deepEqual(calls.map(([operation]) => operation), ["start", "get", "list", "cancel", "resume", "collect-feedback", "signoff", "reviewer-key-create"]);
  // R5-REV-02: Job 系 6 tool すべてで projectDir が絶対 path で service / collector まで届く。
  // 本体は path を resolve して渡す。Windows ではドライブ名と "\\" 区切りになるので、期待値も resolve で作る。
  for (const index of [0, 1, 2, 3, 4, 5]) assert.equal(calls[index][1].projectDir, resolve("/tmp/project"), `${calls[index][0]} projectDir`);
  assert.equal(calls[0][1].scriptPath, resolve("/tmp/project", "script.txt"), "相対 scriptPath は projectDir 基準で解決される");
  assert.equal(calls[0][1].channelPackPath, resolve("/tmp/project", "pack"), "相対 channelPackPath は projectDir 基準で解決される");
  assert.equal(calls[4][1].confirmed, true);
  assert.equal(calls[4][1].reviewerTrustPath, resolve("/secure/reviewer-trust.json"), "MCP 引数の信頼リスト path は service.resume まで届く");
  assert.equal(calls[4][1].retryFailedImages, true, "retryFailedImages は service.resume へそのまま届く");
  assert.equal(calls[4][1].finalizeAfterUpdate, false, "finalizeAfterUpdate も service.resume へそのまま届く");
  assert.equal(calls[6][1].reviewerKeyPath, "/secure/k.pem", "signoff 引数は reviewer adapter までそのまま届く");
  assert.equal(feedback.structuredContent.captured, 1);
  assert.match(feedback.content[0].text, /captured=1/u);
  assert.match(signed.content[0].text, /Reviewer signoff written for narrated-story-video Job video-a/u);
  assert.match(keyed.content[0].text, /register result\.trustEntry/u);
  assert.equal(await handleVideoHarnessToolCall({ name: "unknown" }, { service }), null);
});

async function writeTrustList(file, label) {
  const pair = generateReviewerKeyPair();
  await writeFile(file, JSON.stringify({ version: "koya-reviewer-trust-v1", reviewers: [createReviewerTrustEntry({ publicKeyPem: pair.publicKeyPem, label })] }));
  return file;
}

test("F-4: narrated signoff / reviewer-key-create MCP entries carry only paths and identifiers to the genre CLI, with the operator env as the sole trust anchor", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "video-harness-reviewer-mcp-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const operator = await writeTrustList(join(dir, "operator-trust.json"), "operator");
  const selfMinted = await writeTrustList(join(dir, "self-minted.json"), "self-minted");
  const operatorCopy = join(dir, "operator-copy.json");
  await writeFile(operatorCopy, await readFile(operator));
  const deploymentRoot = join(dir, "deploy");
  await writeFile(join(dir, "placeholder"), "");
  await (await import("node:fs/promises")).mkdir(join(deploymentRoot, "scripts"), { recursive: true });
  await writeFile(join(deploymentRoot, "scripts", "narrated-story-video.mjs"), "// fixture\n");
  const jobs = {
    "video-narrated-0123456789abcdef": { id: "video-narrated-0123456789abcdef", harness: { id: "narrated-story-video" }, deployment: { root: deploymentRoot, entrypoint: "node scripts/narrated-story-video.mjs" } },
    "video-koya-0123456789abcdef": { id: "video-koya-0123456789abcdef", harness: { id: "koya-manga-video" }, deployment: { root: deploymentRoot, entrypoint: "node scripts/koya-manga-video.mjs" } },
  };
  const invocations = [];
  const build = (env) => createVideoHarnessReviewerActions({
    env,
    narratedCli: join(deploymentRoot, "scripts", "narrated-story-video.mjs"),
    readJob: async ({ jobId }) => {
      if (!jobs[jobId]) throw new Error(`ENOENT job ${jobId}`);
      return jobs[jobId];
    },
    execFile: async (command, argv, options) => {
      invocations.push({ command, argv, options });
      const action = argv[1];
      return {
        stdout: JSON.stringify(action === "signoff"
          ? { jobId: argv[3], outputPath: join(dir, "signoff.json"), reviewerKeyId: "ed25519:" + "b".repeat(24), pass: true }
          : { keyId: "ed25519:" + "c".repeat(24), privateKeyPath: argv[3], trustEntry: { keyId: "ed25519:" + "c".repeat(24), status: "active" } }),
        stderr: "",
      };
    },
  });
  const actions = build({ BUZZASSIST_REVIEWER_TRUST: operator });
  const base = {
    projectDir: dir,
    jobId: "video-narrated-0123456789abcdef",
    confirmed: true,
    reviewer: "codex",
    reviewerId: "independent-reviewer-1",
    reviewerContextId: "codex-task-9",
    reviewerKeyPath: "/secure/outside-repo/reviewer-ed25519.pem",
    videoPath: join(dir, "final.mp4"),
    contactSheetPath: join(dir, "contact-sheet.png"),
    reviewPath: join(dir, "review-scores.json"),
    pass: true,
  };

  // 正常系: 引数は kebab-case の argv として CLI signoff まで届き、鍵の中身は一切載らない。
  const signed = await actions.signoff({ ...base, reviewerTrustPath: operatorCopy, force: true });
  assert.equal(signed.operation, "signoff");
  assert.equal(signed.harnessId, "narrated-story-video");
  assert.equal(signed.result.pass, true);
  const call = invocations.at(-1);
  assert.equal(call.command, process.execPath);
  assert.equal(call.argv[0], join(deploymentRoot, "scripts", "narrated-story-video.mjs"));
  assert.equal(call.argv[1], "signoff");
  assert.equal(call.options.cwd, deploymentRoot);
  const flag = (name) => call.argv[call.argv.indexOf(name) + 1];
  assert.equal(flag("--job-id"), base.jobId);
  assert.equal(flag("--project-dir"), dir);
  assert.equal(flag("--reviewer"), "codex");
  assert.equal(flag("--reviewer-id"), "independent-reviewer-1");
  assert.equal(flag("--reviewer-context-id"), "codex-task-9");
  assert.equal(flag("--reviewer-key-path"), resolve("/secure/outside-repo/reviewer-ed25519.pem"));
  assert.equal(flag("--reviewer-trust-path"), operatorCopy);
  assert.equal(flag("--video-path"), join(dir, "final.mp4"));
  assert.equal(flag("--contact-sheet-path"), join(dir, "contact-sheet.png"));
  assert.equal(flag("--review-path"), join(dir, "review-scores.json"));
  assert.ok(call.argv.includes("--force") && call.argv.includes("--pass"));
  assert.equal(call.argv.includes("--fail"), false);

  // 差し戻し（pass=false）は --fail として子 CLI へ届く（採点ファイルの findings は子 CLI が検査する）。
  await actions.signoff({ ...base, pass: false });
  assert.ok(invocations.at(-1).argv.includes("--fail"));
  assert.equal(invocations.at(-1).argv.includes("--pass"), false);
  assert.ok(!call.argv.some((value) => /BEGIN|"reviewers"/u.test(value)));

  // 信頼アンカー規則は service と同じ helper: env 不一致 → conflict、env 未設定 → unconfigured（CLI を呼ばない）。
  const before = invocations.length;
  await assert.rejects(actions.signoff({ ...base, reviewerTrustPath: selfMinted }), /^Error: reviewer-trust-conflict:/u);
  await assert.rejects(build({}).signoff({ ...base, reviewerTrustPath: operator }), /^Error: reviewer-trust-unconfigured:/u);
  assert.equal(invocations.length, before, "拒否された signoff は子 CLI を起動しない");
  // env 未設定 + path 無しは子 CLI に任せる（子側が fail-closed）。
  await build({}).signoff(base);
  assert.equal(invocations.length, before + 1);
  assert.equal(invocations.at(-1).argv.includes("--reviewer-trust-path"), false);

  // R6-F5: 相対 path は MCP server の cwd（plugin ディレクトリ）で解決されてしまうので、
  // 子 CLI を起動する前に理由コード付きで拒否する。鍵・信頼リスト・任意の出力 path すべて。
  const beforeRelative = invocations.length;
  for (const relative of [
    { reviewerKeyPath: "reviewer-ed25519.pem" },
    { reviewerKeyPath: "./keys/reviewer.pem" },
    { reviewerTrustPath: "trust.json" },
    { videoPath: "final.mp4" },
    { contactSheetPath: "../contact-sheet.png" },
    { signoffPath: "review/signoff.json" },
    { reviewPath: "review-scores.json" },
    { projectDir: "." },
  ]) {
    await assert.rejects(actions.signoff({ ...base, ...relative }), /^Error: reviewer-path-not-absolute: /u, JSON.stringify(relative));
  }
  await assert.rejects(actions.createReviewerKey({ confirmed: true, reviewerKeyPath: "new.pem" }), /^Error: reviewer-path-not-absolute: reviewerKeyPath/u);
  await assert.rejects(actions.createReviewerKey({ confirmed: true, reviewerKeyPath: "/secure/outside-repo/new.pem", reviewerPublicKeyPath: "new.pub" }), /^Error: reviewer-path-not-absolute: reviewerPublicKeyPath/u);
  await assert.rejects(actions.createReviewerKey({ confirmed: true, reviewerKeyPath: "/secure/outside-repo/new.pem", projectDir: "sub/project" }), /^Error: reviewer-path-not-absolute: projectDir/u);
  assert.equal(invocations.length, beforeRelative, "相対 path で拒否された呼び出しは子 CLI を起動しない");

  // 鍵の中身・confirmed 無し・pass 無し・Koya Job・未知 Job は拒否。
  await assert.rejects(actions.signoff({ ...base, reviewerPrivateKeyPem: "-----BEGIN PRIVATE KEY-----" }), /key material/u);
  await assert.rejects(actions.signoff({ ...base, reviewerKeyPath: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" }), /key or trust-list material/u);
  await assert.rejects(actions.signoff({ ...base, confirmed: false }), /confirmed=true/u);
  await assert.rejects(actions.signoff({ ...base, pass: undefined }), /pass=true \(approve\) or pass=false/u);
  await assert.rejects(actions.signoff({ ...base, pass: "yes" }), /pass=true \(approve\) or pass=false/u);
  await assert.rejects(actions.signoff({ ...base, reviewPath: undefined }), /reviewPath \(an absolute FILE path\) is required/u);
  await assert.rejects(actions.signoff({ ...base, jobId: "video-koya-0123456789abcdef" }), /run_koya_manga_pipeline action=signoff/u);
  await assert.rejects(actions.signoff({ ...base, jobId: "video-missing-0123456789abcdef" }), /durable Video Harness Job/u);

  // reviewer-key-create: 共通実装の CLI へ path とラベルだけを渡す。
  const created = await actions.createReviewerKey({ projectDir: dir, confirmed: true, reviewerKeyPath: "/secure/outside-repo/new.pem", reviewerPublicKeyPath: "/secure/outside-repo/new.pub", reviewerLabel: "independent-reviewer-2" });
  assert.equal(created.operation, "reviewer-key-create");
  assert.match(created.result.keyId, /^ed25519:/u);
  const keyCall = invocations.at(-1);
  assert.equal(keyCall.argv[1], "reviewer-key-create");
  assert.equal(keyCall.argv[keyCall.argv.indexOf("--reviewer-key-path") + 1], resolve("/secure/outside-repo/new.pem"));
  assert.equal(keyCall.argv[keyCall.argv.indexOf("--reviewer-public-key-path") + 1], resolve("/secure/outside-repo/new.pub"));
  assert.equal(keyCall.argv[keyCall.argv.indexOf("--reviewer-label") + 1], "independent-reviewer-2");
  assert.equal(keyCall.argv[keyCall.argv.indexOf("--project-dir") + 1], dir);
  await assert.rejects(actions.createReviewerKey({ confirmed: true, reviewerKeyPath: "/x.pem", reviewerPrivateKeyPem: "x" }), /key material/u);
  await assert.rejects(actions.createReviewerKey({ reviewerKeyPath: "/x.pem" }), /confirmed=true/u);
  await assert.rejects(actions.createReviewerKey({ confirmed: true }), /reviewerKeyPath/u);

  // 子 CLI が秘密鍵を印字してしまっても MCP 応答には載せない。
  const leaky = createVideoHarnessReviewerActions({
    env: {},
    readJob: async () => jobs["video-narrated-0123456789abcdef"],
    execFile: async () => ({ stdout: JSON.stringify({ pem: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" }), stderr: "" }),
  });
  await assert.rejects(leaky.createReviewerKey({ projectDir: dir, confirmed: true, reviewerKeyPath: "/x.pem" }), /refusing to return it/u);
});

test("R5-REV-02: run/resume/get/list/cancel/collect-feedback never fall back to the MCP server cwd and resolve paths against the project", async () => {
  const calls = [];
  const record = (operation) => async (args) => { calls.push([operation, args]); return serviceResult(operation); };
  const service = { start: record("start"), get: record("get"), list: record("list"), cancel: record("cancel"), resume: record("resume") };
  const feedbackCollector = async (args) => { calls.push(["collect-feedback", args]); return { ok: true, operation: "collect-feedback", jobId: args.jobId, captured: 0, duplicates: 0, stale: 0 }; };
  const deps = { service, feedbackCollector, env: {} };
  const cwdBefore = process.cwd();

  // 元報告の再現入力: projectDir 無し・全 path 相対・env 無し → service を呼ばずに fail-closed。
  const original = { scriptPath: "rel/script.md", channelPackPath: "rel/pack.json", reviewerTrustPath: "rel/trust.json" };
  await assert.rejects(handleVideoHarnessToolCall({ name: TOOL_RUN_VIDEO_HARNESS, arguments: original }, deps), new RegExp(`^Error: ${PROJECT_DIR_UNRESOLVED_CODE}: `, "u"));
  for (const [name, args] of [
    [TOOL_RESUME_VIDEO_HARNESS_JOB, { jobId: "video-a", confirmed: true }],
    [TOOL_GET_VIDEO_HARNESS_JOB, { jobId: "video-a" }],
    [TOOL_LIST_VIDEO_HARNESS_JOBS, {}],
    [TOOL_CANCEL_VIDEO_HARNESS_JOB, { jobId: "video-a" }],
    [TOOL_COLLECT_VIDEO_HARNESS_FEEDBACK, { jobId: "video-a" }],
  ]) {
    await assert.rejects(handleVideoHarnessToolCall({ name, arguments: args }, deps), new RegExp(`^Error: ${PROJECT_DIR_UNRESOLVED_CODE}: `, "u"), name);
  }
  // 相対 projectDir、空白だけの env、相対 env も同じ扱い（cwd で解決しない）。
  await assert.rejects(handleVideoHarnessToolCall({ name: TOOL_LIST_VIDEO_HARNESS_JOBS, arguments: { projectDir: "." } }, deps), new RegExp(`^Error: ${REVIEWER_PATH_NOT_ABSOLUTE_CODE}: projectDir`, "u"));
  await assert.rejects(handleVideoHarnessToolCall({ name: TOOL_LIST_VIDEO_HARNESS_JOBS, arguments: {} }, { ...deps, env: { EXCALIDRAW_PROJECT_DIR: "   " } }), new RegExp(`^Error: ${PROJECT_DIR_UNRESOLVED_CODE}: `, "u"));
  await assert.rejects(handleVideoHarnessToolCall({ name: TOOL_LIST_VIDEO_HARNESS_JOBS, arguments: {} }, { ...deps, env: { EXCALIDRAW_PROJECT_DIR: "relative/project" } }), new RegExp(`^Error: ${PROJECT_DIR_UNRESOLVED_CODE}: `, "u"));
  // 相対 reviewerTrustPath は projectDir があっても拒否（reviewer 入口と同じ規則）。
  await assert.rejects(handleVideoHarnessToolCall({ name: TOOL_RUN_VIDEO_HARNESS, arguments: { ...original, projectDir: "/work/project" } }, deps), new RegExp(`^Error: ${REVIEWER_PATH_NOT_ABSOLUTE_CODE}: reviewerTrustPath`, "u"));
  await assert.rejects(handleVideoHarnessToolCall({ name: TOOL_RESUME_VIDEO_HARNESS_JOB, arguments: { projectDir: "/work/project", jobId: "video-a", confirmed: true, reviewerTrustPath: "trust.json" } }, deps), new RegExp(`^Error: ${REVIEWER_PATH_NOT_ABSOLUTE_CODE}: reviewerTrustPath`, "u"));
  assert.deepEqual(calls, [], "拒否された呼び出しは service / collector に届かない");

  // 明示 projectDir: 相対 script / pack は projectDir 基準、絶対はそのまま。cwd の値は結果に現れない。
  await handleVideoHarnessToolCall({ name: TOOL_RUN_VIDEO_HARNESS, arguments: { projectDir: "/work/project", scriptPath: "rel/script.md", channelPackPath: "/packs/pack.json", reviewerTrustPath: "/secure/trust.json" } }, deps);
  // invocation（呼び出したホスト）は Job の引数ではなく、入口が判定して別に渡す。
  const { invocation: startInvocation, ...startArgs } = calls.at(-1)[1];
  assert.deepEqual(startArgs, { projectDir: resolve("/work/project"), scriptPath: resolve("/work/project", "rel/script.md"), channelPackPath: resolve("/packs/pack.json"), reviewerTrustPath: resolve("/secure/trust.json") });
  assert.equal(startInvocation.via, "mcp");
  // server が roots から埋めた projectDir が env より優先される。
  await handleVideoHarnessToolCall({ name: TOOL_GET_VIDEO_HARNESS_JOB, arguments: { projectDir: "/work/from-roots", jobId: "video-a" } }, { ...deps, env: { EXCALIDRAW_PROJECT_DIR: "/work/from-env" } });
  assert.equal(calls.at(-1)[1].projectDir, resolve("/work/from-roots"));
  // 明示も roots も無ければ EXCALIDRAW_PROJECT_DIR（setup 時 project）。
  await handleVideoHarnessToolCall({ name: TOOL_CANCEL_VIDEO_HARNESS_JOB, arguments: { jobId: "video-a" } }, { ...deps, env: { EXCALIDRAW_PROJECT_DIR: "/work/from-env" } });
  assert.equal(calls.at(-1)[1].projectDir, resolve("/work/from-env"));
  for (const [, args] of calls) assert.notEqual(args.projectDir, cwdBefore, "MCP server の cwd が projectDir になることはない");
  assert.equal(process.cwd(), cwdBefore);
});

test("plan_video_request は読むだけの道具で、Job 系と同じ path の規則を使い、project が決まらなくても止めない", async () => {
  const definitions = videoHarnessToolDefinitions();
  const planTool = definitions.find((definition) => definition.name === TOOL_PLAN_VIDEO_REQUEST);
  assert.deepEqual(planTool.inputSchema.required, ["request"]);
  assert.deepEqual(Object.keys(planTool.inputSchema.properties).sort(), [
    "channelId", "channelPackPath", "checkPrerequisites", "harnessId", "options", "projectDir", "request", "requestKind", "scriptPath", "strategyBriefPath",
  ]);
  assert.equal(planTool.inputSchema.properties.checkPrerequisites.default, false);
  assert.equal(planTool.annotations.readOnlyHint, true);
  assert.equal(planTool.annotations.destructiveHint, false);
  assert.match(planTool.description, /no model and no paid API, creates no Job/u);
  assert.match(planTool.description, /run-video-harness\.mjs plan-request/u, "CLI と同じ結果だと説明する");

  const calls = [];
  const planner = async (args) => {
    calls.push(args);
    return { operation: "plan-request", summaryLines: ["判定: fixture"], decision: { status: "selected" } };
  };
  const env = { EXCALIDRAW_PROJECT_DIR: "/work/from-env" };
  const result = await handleVideoHarnessToolCall({
    name: TOOL_PLAN_VIDEO_REQUEST,
    arguments: { request: "朗読の動画", projectDir: "/work/project", scriptPath: "rel/script.md", channelPackPath: "/packs/pack", options: { episodeId: "ep" }, checkPrerequisites: true },
  }, { planner, env });
  assert.equal(result.content[0].text, "判定: fixture");
  assert.equal(result.structuredContent.operation, "plan-request");
  assert.equal(calls[0].request, "朗読の動画");
  assert.equal(calls[0].projectDir, resolve("/work/project"));
  assert.equal(calls[0].scriptPath, resolve("/work/project", "rel/script.md"), "相対 path は projectDir 基準");
  assert.equal(calls[0].channelPackPath, resolve("/packs/pack"));
  assert.deepEqual(calls[0].options, { episodeId: "ep" });
  assert.equal(calls[0].checkPrerequisites, true);
  assert.equal(calls[0].env, env);

  // project が決まらなくても、読むだけなので止めない（その project の記録を読まないだけ）。
  await handleVideoHarnessToolCall({ name: TOOL_PLAN_VIDEO_REQUEST, arguments: { request: "朗読" } }, { planner, env: {} });
  assert.equal(calls.at(-1).projectDir, null);
  assert.equal(calls.at(-1).checkPrerequisites, false);
  // ただし相対 path は server の cwd で解決しない。
  await assert.rejects(
    handleVideoHarnessToolCall({ name: TOOL_PLAN_VIDEO_REQUEST, arguments: { request: "朗読", scriptPath: "rel/script.md" } }, { planner, env: {} }),
    new RegExp(`^Error: ${REVIEWER_PATH_NOT_ABSOLUTE_CODE}: scriptPath`, "u"),
  );
  await assert.rejects(
    handleVideoHarnessToolCall({ name: TOOL_PLAN_VIDEO_REQUEST, arguments: { request: "朗読", projectDir: "." } }, { planner, env: {} }),
    new RegExp(`^Error: ${REVIEWER_PATH_NOT_ABSOLUTE_CODE}: projectDir`, "u"),
  );
  await assert.rejects(
    handleVideoHarnessToolCall({ name: TOOL_PLAN_VIDEO_REQUEST, arguments: { request: "朗読", options: ["x"] } }, { planner, env: {} }),
    /options must be a JSON object/u,
  );
  assert.equal(calls.length, 2, "拒否した呼び出しは planner に届かない");
});

test("the real MCP server registers all generic harness tools and list uses the common envelope", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "video-harness-mcp-"));
  const client = new Client({ name: "video-harness-mcp-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repoRoot, "mcp", "server.mjs")],
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX: "1",
      EXCALIDRAW_NO_AUTO_OPEN: "1",
      EXCALIDRAW_PROJECT_DIR: projectDir,
      EXCALIDRAW_CANVAS_DIR: join(projectDir, "canvas"),
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const listedTools = await client.listTools();
    for (const name of VIDEO_HARNESS_TOOL_NAMES) {
      assert.ok(listedTools.tools.some((tool) => tool.name === name), `${name} should be registered`);
    }
    const result = await client.callTool({ name: TOOL_LIST_VIDEO_HARNESS_JOBS, arguments: { projectDir } });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent.version, "buzzassist-video-harness-service-result-v1");
    assert.equal(result.structuredContent.operation, "list");
    assert.deepEqual(result.structuredContent.jobs, []);

    const refused = await client.callTool({
      name: TOOL_RESUME_VIDEO_HARNESS_JOB,
      arguments: { projectDir, jobId: "video-fixture-0123456789abcdef", confirmed: false },
    });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /confirmed=true/u);

    const missingFeedback = await client.callTool({
      name: TOOL_COLLECT_VIDEO_HARNESS_FEEDBACK,
      arguments: { projectDir, jobId: "video-missing-0123456789abcdef" },
    });
    assert.equal(missingFeedback.isError, true);
    assert.match(missingFeedback.content[0].text, /durable Video Harness Job/u);
    assert.doesNotMatch(missingFeedback.content[0].text, new RegExp(projectDir.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

    // 両hostから同等入口: run_video_harness / resume の schema が信頼リスト path を受ける。
    const runTool = listedTools.tools.find((tool) => tool.name === TOOL_RUN_VIDEO_HARNESS);
    const resumeTool = listedTools.tools.find((tool) => tool.name === TOOL_RESUME_VIDEO_HARNESS_JOB);
    assert.equal(runTool.inputSchema.properties.reviewerTrustPath.type, "string");
    assert.equal(resumeTool.inputSchema.properties.reviewerTrustPath.type, "string");

    // Koya 経路: reviewer 鍵の path は MCP 引数 → adapter → 正規 CLI まで届く（鍵本体は返らない）。
    const keyPath = join(projectDir, "keys", "reviewer-ed25519.pem");
    const created = await client.callTool({
      name: "run_koya_manga_pipeline",
      arguments: { projectDir, action: "reviewer-key-create", confirmed: true, background: false, options: { reviewerKeyPath: keyPath, reviewerLabel: "mcp lane-j" } },
    });
    assert.equal(created.isError, undefined, JSON.stringify(created));
    assert.match(created.structuredContent.result.keyId, /^ed25519:[a-f0-9]{24}$/u);
    assert.equal(created.structuredContent.result.privateKeyPath, keyPath);
    assert.equal(created.structuredContent.result.trustEntry.label, "mcp lane-j");
    assert.doesNotMatch(JSON.stringify(created), /PRIVATE KEY/u, "秘密鍵の中身は MCP 応答に載せない");
    // Windows は POSIX の権限ビットを持たない（Node は書き込み可否しか反映しない）。
    if (process.platform !== "win32") assert.equal(((await stat(keyPath)).mode & 0o777), 0o600);

    const refused2 = await client.callTool({
      name: "run_koya_manga_pipeline",
      arguments: { projectDir, action: "signoff", confirmed: true, background: false, options: { episodeId: "ep", reviewerPrivateKeyPem: "-----BEGIN PRIVATE KEY-----" } },
    });
    assert.equal(refused2.isError, true);
    assert.match(refused2.content[0].text, /key material/u);
    // R4-8: read-only 判定は adapter に一元化。server 側の列挙が無くても read-only action は confirmed 無しで直接返る。
    const status = await client.callTool({
      name: "run_koya_manga_pipeline",
      arguments: { projectDir, action: "status", options: { episodeId: "ep-none" } },
    });
    assert.equal(typeof status.isError === "boolean" ? status.isError : false, true, "存在しない episode の status は CLI の失敗として返る（confirmed 要求ではない）");
    assert.doesNotMatch(status.content[0].text, /confirmed=true/u);

    // 両ハーネス同等入口（F-4）: narrated 側の reviewer-key-create / signoff も実 MCP server から同じ引数名で届く。
    const keyHome = await mkdtemp(join(tmpdir(), "video-harness-reviewer-key-"));
    try {
      const narratedKeyPath = join(keyHome, "reviewer-ed25519.pem");
      const createdNarrated = await client.callTool({
        name: TOOL_CREATE_VIDEO_HARNESS_REVIEWER_KEY,
        arguments: { projectDir, confirmed: true, reviewerKeyPath: narratedKeyPath, reviewerLabel: "mcp lane-e" },
      });
      assert.equal(createdNarrated.isError, undefined, JSON.stringify(createdNarrated));
      assert.equal(createdNarrated.structuredContent.operation, "reviewer-key-create");
      assert.match(createdNarrated.structuredContent.result.keyId, /^ed25519:[a-f0-9]{24}$/u);
      assert.equal(createdNarrated.structuredContent.result.privateKeyPath, narratedKeyPath);
      assert.equal(createdNarrated.structuredContent.result.trustEntry.label, "mcp lane-e");
      assert.doesNotMatch(JSON.stringify(createdNarrated), /PRIVATE KEY/u, "秘密鍵の中身は MCP 応答に載せない");
      if (process.platform !== "win32") assert.equal(((await stat(narratedKeyPath)).mode & 0o777), 0o600);

      const insideProject = await client.callTool({
        name: TOOL_CREATE_VIDEO_HARNESS_REVIEWER_KEY,
        arguments: { projectDir, confirmed: true, reviewerKeyPath: join(projectDir, "keys", "inside.pem") },
      });
      assert.equal(insideProject.isError, true, "project 配下への鍵作成は共通実装が拒否する");
      assert.match(insideProject.content[0].text, /reviewer-key-path-inside-repository/u);

      const missingJob = await client.callTool({
        name: TOOL_SIGNOFF_VIDEO_HARNESS_JOB,
        arguments: { projectDir, jobId: "video-missing-0123456789abcdef", confirmed: true, reviewer: "codex", reviewerContextId: "task-x", reviewerKeyPath: narratedKeyPath, reviewPath: join(keyHome, "review-scores.json"), pass: true },
      });
      assert.equal(missingJob.isError, true);
      assert.match(missingJob.content[0].text, /durable Video Harness Job/u);

      const pemArg = await client.callTool({
        name: TOOL_SIGNOFF_VIDEO_HARNESS_JOB,
        arguments: { projectDir, jobId: "video-missing-0123456789abcdef", confirmed: true, reviewer: "codex", reviewerContextId: "task-x", reviewerKeyPath: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", reviewPath: join(keyHome, "review-scores.json"), pass: true },
      });
      assert.equal(pemArg.isError, true);
      assert.match(pemArg.content[0].text, /key or trust-list material/u);
    } finally {
      await rm(keyHome, { recursive: true, force: true });
    }
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("R5-REV-02 (real server): without a project root the server refuses run_video_harness instead of creating a Job in its own cwd", async () => {
  // start-mcp.mjs は plugin ディレクトリへ chdir する。ここでは repoRoot を「server の cwd」に見立て、
  // EXCALIDRAW_PROJECT_DIR を渡さず、client も roots capability を持たない状態で呼ぶ。
  const canvasDir = await mkdtemp(join(tmpdir(), "video-harness-mcp-nocwd-"));
  const env = { ...process.env, CODEX: "1", EXCALIDRAW_NO_AUTO_OPEN: "1", EXCALIDRAW_CANVAS_DIR: canvasDir };
  delete env.EXCALIDRAW_PROJECT_DIR;
  const client = new Client({ name: "video-harness-mcp-nocwd-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(repoRoot, "mcp", "server.mjs")], cwd: repoRoot, env, stderr: "pipe" });
  const harnessRuns = join(repoRoot, "canvas", "harness-runs");
  const listRuns = async () => (await import("node:fs/promises")).readdir(harnessRuns).catch(() => []);
  const before = await listRuns();
  try {
    await client.connect(transport);
    const refused = await client.callTool({
      name: TOOL_RUN_VIDEO_HARNESS,
      arguments: { scriptPath: "rel/script.md", channelPackPath: "rel/pack.json", reviewerTrustPath: "rel/trust.json", confirmed: true },
    });
    assert.equal(refused.isError, true, JSON.stringify(refused));
    assert.match(refused.content[0].text, new RegExp(PROJECT_DIR_UNRESOLVED_CODE, "u"));
    const listed = await client.callTool({ name: TOOL_LIST_VIDEO_HARNESS_JOBS, arguments: {} });
    assert.equal(listed.isError, true);
    assert.match(listed.content[0].text, new RegExp(PROJECT_DIR_UNRESOLVED_CODE, "u"));
    assert.deepEqual(await listRuns(), before, "server cwd 配下に Job が作られない");
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await rm(canvasDir, { recursive: true, force: true });
  }
});
