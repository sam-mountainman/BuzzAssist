import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createChannelPackEnvelope } from "../lib/channelPackEnvelope.mjs";
import { createReviewerTrustEntry, generateReviewerKeyPair, loadReviewerTrust, signChildReviewSignoff, verifyChildReviewSignoff } from "../lib/koyaReviewAttestation.mjs";
import { createVideoHarnessService } from "../lib/videoHarnessService.mjs";
import { executeVideoHarnessAdapter, prepareVideoHarnessJob, _testing as adapterTesting } from "../lib/videoHarnessAdapters.mjs";
import { createVideoHarnessReviewerActions } from "../lib/videoHarnessMcp.mjs";
import { createVideoHarnessRunReceipt } from "../lib/videoHarnessReceipt.mjs";
import { readVideoHarnessJob } from "../lib/videoHarnessJob.mjs";
import { receiptLearningCandidates } from "../lib/harnessReceiptLearning.mjs";
import { evaluateJobSettlement } from "../scripts/harness-stop-hook.mjs";
import { runHarnessDoctor } from "../scripts/harness-doctor.mjs";
import { DECODABLE_AV_BASE64 } from "./helpers/decodableAvFixture.mjs";
import { acceptScriptForTests } from "./helpers/scriptQualityAcceptance.mjs";

const execFile = promisify(execFileCallback);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const id = "synthetic-child-video";
const moduleUrl = (name) => new URL(`../lib/${name}.mjs`, import.meta.url).href;

// 子も宣言も試験用の一時フォルダ。API・動画生成はなく、既存の小さなMP4を実デコードする。
function childSource() {
  return `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyVideoHarnessUpstreamExecution } from ${JSON.stringify(moduleUrl("videoHarnessJob"))};
import { assertScriptQualityWorkDirBoundToJob } from ${JSON.stringify(moduleUrl("scriptQualityUseGate"))};
import { loadReviewerTrust, verifyChildReviewSignoff } from ${JSON.stringify(moduleUrl("koyaReviewAttestation"))};
import { CHILD_AUDIT_VERSION } from ${JSON.stringify(moduleUrl("harnessChildProtocol"))};
const action = process.argv[2];
const args = {};
for (let i = 3; i < process.argv.length; i++) {
  const name = process.argv[i].slice(2);
  args[name] = ['pass', 'fail'].includes(name) ? true : process.argv[++i];
}
if (action === 'help') { console.log('synthetic child: full'); process.exit(0); }
const jobPath = args['upstream-job-path'] || join(args['project-dir'], 'canvas', 'harness-runs', args['job-id'], 'job.json');
const job = JSON.parse(await readFile(jobPath, 'utf8'));
const dir = join(job.runDir, 'synthetic-output');
await mkdir(dir, { recursive: true });
const video = join(dir, 'final.mp4');
const sheet = join(dir, 'contact-sheet.png');
const signoffPath = args['review-signoff-path'];
const digest = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const json = async (file, value) => writeFile(file, JSON.stringify(value, null, 2));
const trust = await loadReviewerTrust({ trustPath: args['reviewer-trust-path'] || '' });
assert.equal(action, 'full');
await verifyVideoHarnessUpstreamExecution({ upstreamJobPath: jobPath, upstreamJobId: args['upstream-job-id'],
  upstreamJobRevision: Number(args['upstream-job-revision']), upstreamExecutionBinding: args['upstream-execution-binding'],
  harnessId: job.harness.id, scriptPath: args['script-path'] });
assertScriptQualityWorkDirBoundToJob({ job, scriptQualityWorkDir: args['script-quality-work-dir'] });
assert.equal(JSON.parse(await readFile(join(args['channel-pack-dir'], 'synthetic.json'), 'utf8')).synthetic, true);
if (!existsSync(video)) {
  await writeFile(video, Buffer.from(${JSON.stringify(DECODABLE_AV_BASE64)}, 'base64'));
  await writeFile(sheet, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
}
const videoSha256 = await digest(video), contactSheetSha256 = await digest(sheet);
const signed = existsSync(signoffPath) ? JSON.parse(await readFile(signoffPath, 'utf8')) : null;
if (signed) assert.equal(verifyChildReviewSignoff(signed, { harnessId: job.harness.id, jobId: job.id,
  identityDigest: job.identityDigest, videoSha256, contactSheetSha256, trust }).pass, true);
const pass = signed?.approved === true;
const issues = pass ? [] : ['independent-contact-sheet-signoff-required'];
const auditChecks = { syntheticQuality: { pass: true, detail: 'existing encoded fixture' }, separateSignoff: { pass } };
const report = { version: CHILD_AUDIT_VERSION, harnessId: job.harness.id, jobId: job.id, contractVersion: '1.0.0',
  status: pass ? 'pass' : 'awaiting-human-review', knownRemainingIssues: issues, videoSha256, contactSheetSha256, auditChecks,
  ...(signed ? { independentSignoff: { path: signoffPath, sha256: await digest(signoffPath), reviewer: signed.reviewer,
    reviewerContextId: signed.reviewerContextId } } : {}) };
const reportPath = join(dir, 'audit-report.json');
const runReceiptPath = join(dir, 'child-receipt.json');
await json(reportPath, report);
await json(runReceiptPath, { status: report.status, auditChecks });
const artifacts = {};
for (const [kind, path] of [['final-video', video], ['contact-sheet', sheet], ['audit-report', reportPath]]) artifacts[kind] = { path, sha256: await digest(path) };
console.log('synthetic log before final JSON');
console.log(JSON.stringify({ status: pass ? 'final-audited' : 'awaiting-human-review', knownRemainingIssues: issues, artifacts, runReceiptPath, auditChecks }));
process.exit(pass ? 0 : 3);
`;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "harness-child-protocol-"));
  const privateDir = join(root, "private-layer");
  const source = join(root, "pack-source");
  const projectDir = join(root, "project");
  for (const dir of [privateDir, source, projectDir]) await mkdir(dir);
  const declaration = { id, layer: "private", childProtocol: "buzzassist-child-v1", version: "1.0.0",
    displayName: "合成ジャンル", status: "in-production", produces: { kind: "video" }, entrypoint: "node child.mjs",
    canonicalSkills: [".agents/skills/platform-craft/SKILL.md"], learningTargets: ["platform:platform-craft"],
    scriptQualityGenre: "narrated-story", reviewAttestation: { subject: id },
    requiresFromOperator: [{ id: "signed-channel-pack", blocking: true }, { id: "script-quality-acceptance", blocking: true }],
    guarantees: [{ id: "synthetic-quality", evidenceAuditIds: ["syntheticQuality"] }, { id: "separate-signoff", evidenceAuditIds: ["separateSignoff"] }],
    runtimeRequirements: { paidMedia: false, voiceQualityGate: false, reason: "合成試験には有料の処理がない" } };
  await writeFile(join(privateDir, `${id}.harness.json`), JSON.stringify(declaration));
  await writeFile(join(privateDir, "child.mjs"), childSource());
  await writeFile(join(source, "synthetic.json"), JSON.stringify({ synthetic: true }));
  const packKeys = generateReviewerKeyPair();
  const reviewer = generateReviewerKeyPair();
  const trustPath = join(root, "trust.json");
  const keyPath = join(root, "reviewer.pem");
  await writeFile(keyPath, reviewer.privateKeyPem, { mode: 0o600 });
  await writeFile(trustPath, JSON.stringify({ version: "koya-reviewer-trust-v1", reviewers: [createReviewerTrustEntry({ publicKeyPem: reviewer.publicKeyPem, label: "synthetic-reviewer" })] }));
  const channelPackPath = join(root, "signed-pack");
  await createChannelPackEnvelope({ sourceDir: source, outputDir: channelPackPath, id: "synthetic-pack", version: "1.0.0", harnessId: id, privateKeyPem: packKeys.privateKeyPem });
  const scriptPath = join(projectDir, "script.txt");
  await writeFile(scriptPath, "合成試験の短い台本です。\n");
  const env = { BUZZASSIST_PRIVATE_HARNESS_DIRS: privateDir, BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY_PEM: packKeys.publicKeyPem,
    BUZZASSIST_REVIEWER_TRUST: trustPath, BUZZASSIST_REVIEWER_TRUST_JSON: "", BUZZASSIST_KOYA_REVIEWER_TRUST: "", BUZZASSIST_KOYA_REVIEWER_TRUST_JSON: "",
    BUZZASSIST_REQUIRE_SKILL_APPROVAL: "0", BUZZASSIST_LEARNING_AUTO_CAPTURE: "0", BUZZASSIST_LEARNING_AUTO_SYNC: "0" };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  return { root, privateDir, projectDir, channelPackPath, scriptPath, trustPath, keyPath, declaration, reviewer, packKeys, source };
}

test("合成ジャンル: 計画→明示確認→子の人待ち→別文脈の署名→completed / Receipt pass / Stop 合格", { timeout: 240000 }, async (t) => {
  const f = await fixture(t);
  let childCalls = 0;
  const service = createVideoHarnessService({
    // doctor 本体と子の help は本物。端末依存の probe だけを差し替える。
    doctor: async (input) => {
      const binary = (command) => ({ ok: true, command, args: [], version: "7.1.1" });
      const report = await runHarnessDoctor({ ...input, runtime: {
        ffmpegToolchain: { ok: true, ffmpeg: binary("ffmpeg"), ffprobe: binary("ffprobe") },
        pythonRuntime: { ok: true, command: "python", args: [], version: "3.12.2" },
        runCommand: async (command, args = [], options = {}) => {
          if (args.includes("help")) return execFile(command, args, options);
          if (args.includes("-encoders")) return { stdout: "libx264 aac pcm_s24le", stderr: "" };
          if (args.includes("-filters")) return { stdout: "scale crop overlay fps loudnorm aresample", stderr: "" };
          if (args.includes("-show_streams")) return { stdout: JSON.stringify({ streams: [{ codec_type: "video" }, { codec_type: "audio" }] }), stderr: "" };
          return { stdout: "", stderr: "" };
        },
        diskFreeBytes: async () => 64 * 1024 ** 3,
        svgRasterizerProbe: async () => ({ ok: true, backend: "synthetic", detail: "synthetic fixture" }),
      } });
      assert.equal(report.checks.find((check) => check.id === "harness-production-route").ok, true);
      assert.equal(report.checks.find((check) => check.id === "channel-pack").ok, true);
      assert.equal(report.ready, true, JSON.stringify(report.blocking));
      return report;
    },
    adapter: async (context) => { childCalls++; return executeVideoHarnessAdapter(context); },
    captureRunLearning: async () => null,
  });
  const planned = await service.start({ projectDir: f.projectDir, scriptPath: f.scriptPath, channelPackPath: f.channelPackPath, harnessId: id });
  assert.equal(planned.status, "planned");
  assert.equal(childCalls, 0);
  assert.match(JSON.stringify(planned), /script-quality-required/u);
  const input = { projectDir: f.projectDir, jobId: planned.jobId };
  await assert.rejects(service.resume(input), /confirmed=true/u);
  const qualityWait = await service.resume({ ...input, confirmed: true });
  assert.equal(qualityWait.status, "awaiting-human-review", JSON.stringify(qualityWait));
  assert.match(qualityWait.job.knownRemainingIssues.join(","), /script-quality-required/u);
  await acceptScriptForTests(f.scriptPath);
  const waiting = await service.resume({ ...input, confirmed: true });
  assert.equal(waiting.status, "awaiting-human-review", JSON.stringify(waiting));
  assert.deepEqual(waiting.job.knownRemainingIssues, ["independent-contact-sheet-signoff-required"]);
  const waitingJob = await readVideoHarnessJob(input);
  assert.equal(evaluateJobSettlement(waitingJob, { runDir: waitingJob.runDir }).category, "human");
  const reviewPath = join(f.root, "review.json");
  await writeFile(reviewPath, JSON.stringify({ originalDetailReviewed: true, findings: [], knownRemainingIssues: [] }));
  await createVideoHarnessReviewerActions().signoff({ ...input, confirmed: true, reviewer: "codex",
    reviewerContextId: "synthetic-independent-context", reviewerKeyPath: f.keyPath, reviewPath, pass: true });
  const completed = await service.resume({ ...input, confirmed: true });
  assert.equal(completed.status, "completed", JSON.stringify(completed));
  const job = await readVideoHarnessJob(input);
  assert.deepEqual(job.blockers, []);
  assert.deepEqual(job.knownRemainingIssues, []);
  const receiptBytes = await readFile(join(job.runDir, "run-receipt.json"));
  const receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.outcome, "pass");
  assert.equal(receipt.harnessBuild.harness.id, id);
  assert.equal(receipt.finalized, true);
  assert.equal(evaluateJobSettlement(job, { runDir: job.runDir }).settled, true);
  assert.deepEqual(receiptLearningCandidates({ receipt, receiptDigest: sha(receiptBytes), job }).candidates, []);
  assert.ok(childCalls >= 3);

  const artifacts = job.artifacts.filter((artifact) => artifact.kind !== "run-receipt");
  const audit = artifacts.find((artifact) => artifact.kind === "audit-report");
  const reportBytes = await readFile(audit.path);
  const report = JSON.parse(reportBytes);
  const signoffPath = report.independentSignoff.path;
  const signoffBytes = await readFile(signoffPath);
  const signed = JSON.parse(signoffBytes);
  const trust = await loadReviewerTrust();
  for (const [name, mutate, resign, pattern] of [
    ["本文改変", (value) => { value.note = "tampered"; }, false, /attestation/u],
    ["動画SHA", (value) => { value.videoSha256 = "a".repeat(64); }, true, /final-video SHA/u],
    ["sheet SHA", (value) => { value.contactSheetSha256 = "a".repeat(64); }, true, /contact-sheet SHA/u],
    ["生成と同じ文脈", (value) => { value.reviewerContextId = `production:${job.id}`; }, true, /同じcontext/u],
    ["否認", (value) => { value.approved = false; }, true, /contractがpassではない/u],
  ]) {
    let value = structuredClone(signed); mutate(value);
    if (resign) value = await signChildReviewSignoff({ signoff: value, harnessId: id, jobId: job.id, identityDigest: job.identityDigest, privateKeyPem: f.reviewer.privateKeyPem, trust });
    const bytes = Buffer.from(JSON.stringify(value));
    await writeFile(signoffPath, bytes);
    const updatedReport = { ...report, independentSignoff: { ...report.independentSignoff, sha256: sha(bytes), reviewerContextId: value.reviewerContextId } };
    const auditBytes = Buffer.from(JSON.stringify(updatedReport));
    await writeFile(audit.path, auditBytes);
    const changedArtifacts = artifacts.map((artifact) => artifact === audit ? { ...artifact, sha256: sha(auditBytes), bytes: auditBytes.length } : artifact);
    await assert.rejects(createVideoHarnessRunReceipt({ job, outcome: { status: "completed", artifacts: changedArtifacts, knownRemainingIssues: [], auditChecks: report.auditChecks } }), pattern, name);
  }
  await writeFile(signoffPath, signoffBytes);
  await writeFile(audit.path, reportBytes);
  assert.equal(verifyChildReviewSignoff(signed, { harnessId: "synthetic-wrong", jobId: job.id, identityDigest: job.identityDigest,
    videoSha256: report.videoSha256, contactSheetSha256: report.contactSheetSha256, trust }).pass, false);
});

test("子の終了コード・状態・成果物SHAの不整合を拒否し、failed の問題を保持する", async (t) => {
  const f = await fixture(t);
  await acceptScriptForTests(f.scriptPath);
  const job = { id: `video-${id}-${"0".repeat(16)}`, revision: 1, runDir: f.projectDir, projectDir: f.projectDir,
    harness: { id }, deployment: { root: f.privateDir, entrypoint: "node child.mjs" },
    script: { path: f.scriptPath }, options: { scriptQualityWorkDir: f.projectDir },
    stages: [{ id: "doctor", status: "pass", evidence: { ready: true } }] };
  const result = { status: "awaiting-human-review", knownRemainingIssues: ["synthetic-wait"], artifacts: {}, auditChecks: {}, runReceiptPath: "" };
  const call = (code, body) => executeVideoHarnessAdapter({ job,
    runChild: async (_command, args) => {
      assert.ok(args.includes("--upstream-execution-binding"));
      assert.ok(args.includes("--script-quality-work-dir"));
      return { code, stdout: `log\n${JSON.stringify(body)}`, stderr: "" };
    } });
  assert.equal((await call(3, result)).status, "awaiting-human-review");
  await assert.rejects(call(0, result), /exit-status-mismatch/u);
  await assert.rejects(call(3, { ...result, status: "final-audited" }), /exit-status-mismatch/u);
  await assert.rejects(call(3, { ...result, artifacts: { video: { path: "x", sha256: "bad" } } }), /artifact-invalid/u);
  const artifactPath = join(f.projectDir, "synthetic-artifact.mp4");
  await writeFile(artifactPath, "actual bytes");
  await assert.rejects(call(3, { ...result, artifacts: { "final-video": { path: artifactPath, sha256: "a".repeat(64) } } }), /SHA-256/u);
  await assert.rejects(call(3, { ...result, knownRemainingIssues: null }), /result-invalid/u);
  const failed = await call(2, { ...result, status: "failed", knownRemainingIssues: ["synthetic-failure"] });
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.knownRemainingIssues, ["synthetic-failure"]);
});

test("childProtocol は署名が正しくても channel-pack 以外のpayloadを拒否する", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, "wrong-payload-kind");
  await createChannelPackEnvelope({ sourceDir: f.source, outputDir: path, id: "synthetic-wrong-kind", version: "1.0.0", harnessId: id,
    payloadKind: "narrated-story-channel-pack", privateKeyPem: f.packKeys.privateKeyPem });
  const tree = await adapterTesting.sha256Tree(path);
  const result = await prepareVideoHarnessJob({ job: { harness: { id }, projectDir: f.projectDir,
    channelPack: { path, kind: "directory", sha256: tree.digest, fileCount: tree.fileCount } } });
  assert.equal(result.ok, false);
  assert.deepEqual(result.blockers, ["child-channel-pack-payload-required"]);
});
