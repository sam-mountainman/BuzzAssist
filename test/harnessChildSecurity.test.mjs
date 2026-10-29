import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeVideoHarnessAdapter, _testing as adapter } from "../lib/videoHarnessAdapters.mjs";
import { createVideoHarnessRunReceipt, _testing as receiptTesting } from "../lib/videoHarnessReceipt.mjs";
import { createVideoHarnessReviewerActions } from "../lib/videoHarnessMcp.mjs";
import { createReviewerTrustEntry, generateReviewerKeyPair, loadReviewerTrust, signChildReviewSignoff, verifyChildReviewSignoff } from "../lib/koyaReviewAttestation.mjs";
import { evaluateHarnessConformance, loadCoreSupport } from "../lib/harnessConformance.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const id = "synthetic-security-child";
async function fixture(t, { kind = "video" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "child-security-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const privateDir = join(root, "external");
  const runDir = join(root, "run");
  await mkdir(privateDir); await mkdir(runDir);
  const declaration = { id, version: "1.0.0", layer: "private", childProtocol: "buzzassist-child-v1",
    displayName: "合成", status: "in-production", produces: { kind }, entrypoint: "node child.mjs",
    reviewAttestation: { subject: id }, requiresFromOperator: [{ id: "signed-channel-pack" }],
    canonicalSkills: [".agents/skills/platform-craft/SKILL.md"], learningTargets: ["platform:platform-craft"],
    guarantees: [{ id: "synthetic-quality", evidenceAuditIds: ["syntheticQuality"] }] };
  const declarationPath = join(privateDir, `${id}.harness.json`);
  const declarationBytes = JSON.stringify(declaration);
  await writeFile(declarationPath, declarationBytes);
  await writeFile(join(privateDir, "child.mjs"), "throw new Error('child must never receive reviewer credentials');\n");
  const key = generateReviewerKeyPair();
  const keyPath = join(root, "reviewer.pem");
  await writeFile(keyPath, key.privateKeyPem, { mode: 0o600 });
  const trustRaw = { version: "koya-reviewer-trust-v1", reviewers: [createReviewerTrustEntry({ publicKeyPem: key.publicKeyPem, label: "synthetic" })] };
  const env = { BUZZASSIST_PRIVATE_HARNESS_DIRS: privateDir, BUZZASSIST_REVIEWER_TRUST_JSON: JSON.stringify(trustRaw),
    BUZZASSIST_REVIEWER_TRUST: "", BUZZASSIST_KOYA_REVIEWER_TRUST: "", BUZZASSIST_KOYA_REVIEWER_TRUST_JSON: "" };
  const previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const trust = await loadReviewerTrust({ env });
  const artifacts = [];
  for (const [kind, name] of [["final-video", "final.mp4"], ["contact-sheet", "contact-sheet.png"]]) {
    const path = join(runDir, name); const bytes = Buffer.from(`synthetic ${kind}`);
    await writeFile(path, bytes); artifacts.push({ kind, path, sha256: sha(bytes), bytes: bytes.length });
  }
  const job = { id: `video-${id}-${"0".repeat(16)}`, revision: 1, runDir, projectDir: root, identityDigest: "1".repeat(64),
    harness: { id, declarationSha256: sha(declarationBytes) },
    canonicalIdentity: { harnessDeclaration: { path: declarationPath, sha256: sha(declarationBytes) } },
    deployment: { root: privateDir, entrypoint: "node child.mjs" }, script: { path: join(root, "script.txt"), sha256: "2".repeat(64) },
    stages: [{ id: "doctor", status: "pass", evidence: { ready: true } }], artifacts };
  await writeFile(job.script.path, "synthetic script");
  const reviewPath = join(root, "review.json");
  await writeFile(reviewPath, JSON.stringify({ originalDetailReviewed: true, findings: [], knownRemainingIssues: [] }));
  const signoffPath = join(runDir, "signed.json");
  const signed = await signChildReviewSignoff({ signoff: { version: "buzzassist-child-contact-sheet-signoff-v1", approved: true,
    originalDetailReviewed: true, findings: [], knownRemainingIssues: [], reviewer: "codex", reviewerContextId: "independent-fixture",
    generatorContextId: `production:${job.id}`, videoSha256: artifacts[0].sha256, contactSheetSha256: artifacts[1].sha256 },
  harnessId: id, jobId: job.id, identityDigest: job.identityDigest, privateKeyPem: key.privateKeyPem, trust });
  const signedBytes = JSON.stringify(signed); await writeFile(signoffPath, signedBytes);
  const report = { version: "buzzassist-child-audit-v1", harnessId: id, jobId: job.id, status: "pass", contractVersion: "1.0.0",
    knownRemainingIssues: [], videoSha256: artifacts[0].sha256, contactSheetSha256: artifacts[1].sha256, auditChecks: { syntheticQuality: { pass: true } },
    independentSignoff: { path: signoffPath, sha256: sha(signedBytes), reviewer: "codex", reviewerContextId: "independent-fixture" } };
  async function outcome() {
    const path = join(runDir, "audit.json"); const bytes = JSON.stringify(report); await writeFile(path, bytes);
    return { status: "completed", knownRemainingIssues: [], artifacts: [...artifacts, { kind: "audit-report", path, sha256: sha(bytes), bytes: Buffer.byteLength(bytes) }] };
  }
  const finalize = async (options = {}) => createVideoHarnessRunReceipt({ job, outcome: await outcome(), reviewerTrust: trust, env,
    verifyFinalVideo: async (artifact) => ({ pass: true, sha256: artifact.sha256 }), ...options });
  return { root, privateDir, declaration, declarationPath, job, report, finalize, reviewPath, keyPath, env, trust };
}

test("#1 childProtocol の署名・実デコード・成果物要件は produces.kind で外せない", () => {
  const requirements = receiptTesting.completionRequirements({ childProtocol: "buzzassist-child-v1", produces: { kind: "image" } });
  assert.equal(requirements.signoffRequired, true);
  assert.equal(requirements.finalVideoDecodeRequired, true);
  assert.deepEqual(requirements.requiredArtifacts.map((row) => row.id), ["audit-report", "final-video", "contact-sheet"]);
});

test("#1 conformance の separate-signoff は Receipt が実際に要求する条件にそろう", async () => {
  const row = evaluateHarnessConformance({ harnessId: "narrated-story-video", declaration: { id: "narrated-story-video", produces: { kind: "image" },
    reviewAttestation: { subject: "narrated-story-video" } }, support: await loadCoreSupport() });
  assert.notEqual(row.results["separate-signoff"].status, "ok");
});

for (const [label, mutate, pattern] of [
  ["署名欠落", (f) => { delete f.report.independentSignoff; }, /signoff/iu],
  ["audit版", (f) => { f.report.version = "wrong"; }, /audit contract/u],
  ["harnessId", (f) => { f.report.harnessId = "wrong"; }, /child audit/u],
  ["jobId", (f) => { f.report.jobId = "wrong"; }, /現在のJob/u],
]) test(`#1 video 以外を名乗る子でも ${label} を照合する`, async (t) => {
  const f = await fixture(t, { kind: "image" }); mutate(f);
  await assert.rejects(f.finalize(), pattern);
});

test("#1 video 以外を名乗る子でも共通層の実デコード失敗を拒否する", async (t) => {
  const f = await fixture(t, { kind: "image" });
  await assert.rejects(f.finalize({ verifyFinalVideo: async () => { throw new Error("decode-regression"); } }), /decode-regression/u);
});

for (const variant of ["sha", "path"]) test(`#3 確定時の宣言 ${variant} は計画時の canonicalIdentity に固定する`, async (t) => {
  const f = await fixture(t);
  if (variant === "sha") await writeFile(f.declarationPath, JSON.stringify({ ...f.declaration, version: "2.0.0" }));
  else {
    await mkdir(join(f.root, "other"));
    f.job.canonicalIdentity.harnessDeclaration.path = join(f.root, "other", `${id}.harness.json`);
    await writeFile(f.job.canonicalIdentity.harnessDeclaration.path, await readFile(f.declarationPath));
  }
  await assert.rejects(f.finalize(), /canonical-identity-drift/u);
});

test("#3 子の canonicalIdentity が欠落しても通常確定の照合を省略しない", async (t) => {
  const f = await fixture(t);
  delete f.job.canonicalIdentity;
  await assert.rejects(f.finalize(), /canonical-identity-drift/u);
});

test("#3 デコード中の宣言差し替えも Receipt を書く前に拒否する", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.finalize({ verifyFinalVideo: async (artifact) => {
    await writeFile(f.declarationPath, JSON.stringify({ ...f.declaration, guarantees: [] }));
    return { pass: true, sha256: artifact.sha256 };
  } }), /canonical-identity-drift/u);
});

test("#2 共通層が否認を署名し、子を呼ばず秘密鍵のパスも渡さない", async (t) => {
  const f = await fixture(t); let calls = 0;
  await writeFile(f.reviewPath, JSON.stringify({ originalDetailReviewed: true, findings: ["changes required"], knownRemainingIssues: ["review-rejected"],
    approved: true, reviewerContextId: "forged-reviewer", generatorContextId: "forged-generator" }));
  const actions = createVideoHarnessReviewerActions({ readJob: async () => f.job, env: f.env,
    execFile: async () => { calls++; return { stdout: JSON.stringify({ approved: true }), stderr: "" }; } });
  const result = await actions.signoff({ jobId: f.job.id, projectDir: f.root, confirmed: true, pass: false, reviewer: "codex",
    reviewerContextId: "independent-reviewer", reviewerKeyPath: f.keyPath, reviewPath: f.reviewPath });
  assert.equal(calls, 0, "外付けの子に reviewer の argv / env を渡さない");
  const signed = JSON.parse(await readFile(result.result.signoffPath, "utf8"));
  assert.equal(signed.approved, false);
  assert.equal(signed.reviewerContextId, "independent-reviewer");
  assert.equal(signed.generatorContextId, `production:${f.job.id}`);
  assert.equal(verifyChildReviewSignoff(signed, { harnessId: id, jobId: f.job.id, identityDigest: f.job.identityDigest,
    videoSha256: f.job.artifacts[0].sha256, contactSheetSha256: f.job.artifacts[1].sha256, trust: f.trust }).pass, true);
});

test("#2 共通署名は残件のある承認・制作と同じ文脈・成果物の差し替えを拒否する", async (t) => {
  const f = await fixture(t);
  const actions = createVideoHarnessReviewerActions({ readJob: async () => f.job, env: f.env, execFile: async () => ({ stdout: "{}" }) });
  const args = { jobId: f.job.id, projectDir: f.root, confirmed: true, pass: true, reviewer: "codex", reviewerContextId: "independent-reviewer", reviewerKeyPath: f.keyPath, reviewPath: f.reviewPath };
  await writeFile(f.reviewPath, JSON.stringify({ originalDetailReviewed: true, findings: ["problem"], knownRemainingIssues: [] }));
  await assert.rejects(actions.signoff(args), /review|signoff/u);
  await writeFile(f.reviewPath, JSON.stringify({ originalDetailReviewed: true, findings: [], knownRemainingIssues: [] }));
  await assert.rejects(actions.signoff({ ...args, reviewerContextId: `production:${f.job.id}` }), /context/u);
  await writeFile(f.job.artifacts[0].path, "replaced");
  await assert.rejects(actions.signoff(args), /SHA/u);
});

test("#7 子の結果は最後の空でない1行全体だけを JSON として読む", async (t) => {
  const f = await fixture(t);
  const body = { status: "final-audited", knownRemainingIssues: [], artifacts: {}, auditChecks: {}, runReceiptPath: "" };
  for (const stdout of [`log ${JSON.stringify(body)}`, `log\n${JSON.stringify(body, null, 2)}`, `${JSON.stringify(body)}\ntrailer`]) {
    await assert.rejects(executeVideoHarnessAdapter({ job: f.job, runChild: async () => ({ code: 0, stdout, stderr: "" }) }), /result-invalid/u);
  }
  assert.deepEqual(adapter.parseJsonOutput(`log\n${JSON.stringify(body)}\n\n`), body);
});

test("#8 timeout の子が exit 0 と final-audited を返しても失敗する", async (t) => {
  const f = await fixture(t);
  await assert.rejects(executeVideoHarnessAdapter({ job: f.job, runChild: async () => ({ code: 0, termination: { reason: "timeout" }, stderr: "",
    stdout: JSON.stringify({ status: "final-audited", knownRemainingIssues: [], artifacts: {}, auditChecks: {}, runReceiptPath: "" }) }) }), /timeout/u);
});

for (const [code, status] of [[3, "awaiting-human-review"], [2, "failed"]]) test(`#12 ${status} の空の残件を拒否する`, async (t) => {
  const f = await fixture(t);
  await assert.rejects(executeVideoHarnessAdapter({ job: f.job, runChild: async () => ({ code, stderr: "",
    stdout: JSON.stringify({ status, knownRemainingIssues: [], artifacts: {}, auditChecks: {}, runReceiptPath: "" }) }) }), /child-protocol-result-invalid/u);
});

test("#10 成果物を readFile で全読込せずストリームでハッシュする", async (t) => {
  const f = await fixture(t); const artifact = f.job.artifacts[0];
  const original = fs.promises.readFile;
  t.mock.method(fs.promises, "readFile", async (path, ...args) => {
    if (String(path) === artifact.path) throw new Error("whole-artifact-read-forbidden");
    return original(path, ...args);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const collected = await adapter.collectNarratedArtifacts({ artifacts: { "final-video": artifact } }, f.root);
  assert.equal(collected[0].sha256, artifact.sha256);
});

test("#10 ハッシュ中に成果物が変更されたら拒否する", async (t) => {
  const f = await fixture(t); const artifact = f.job.artifacts[0]; const original = fs.createReadStream;
  t.mock.method(fs, "createReadStream", (...args) => {
    const stream = original(...args);
    stream.once("end", () => fs.appendFileSync(artifact.path, "changed"));
    return stream;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(adapter.collectNarratedArtifacts({ artifacts: { "final-video": artifact } }, f.root), /変更|changed/u);
});

test("#13 形が正しい誤SHAは同じ成果物を別名で重ねても検証を省略しない", async (t) => {
  const f = await fixture(t); const artifact = f.job.artifacts[0];
  for (const artifacts of [
    { "final-video": { ...artifact, sha256: "a".repeat(64) } },
    { finalVideo: artifact, "final-video": { ...artifact, sha256: "a".repeat(64) } },
  ]) {
    await assert.rejects(executeVideoHarnessAdapter({ job: f.job, runChild: async () => ({ code: 3, stderr: "", stdout: JSON.stringify({
      status: "awaiting-human-review", knownRemainingIssues: ["review-required"], artifacts, auditChecks: {}, runReceiptPath: "" }) }) }), /SHA-256/u);
  }
});
