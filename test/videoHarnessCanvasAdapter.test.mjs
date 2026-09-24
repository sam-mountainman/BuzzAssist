import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { _testing, projectVideoHarnessJob, videoHarnessJobToCanvasRun } from "../lib/videoHarnessCanvasAdapter.mjs";
import { resolveCanvasRunStateFile } from "../lib/canvasRunState.mjs";

const fileSha = (value) => createHash("sha256").update(value).digest("hex");

test("provider fingerprints bind runtime identity, not per-job input hashes", () => {
  assert.equal(_testing.canvasArtifactKind("final-video", "/fixture/final-audited.mp4"), "final-mp4");
  assert.equal(_testing.canvasArtifactKind("audit-report", "/fixture/final-audit-report.json"), "audit-report");
  // フォルダ名に紛らわしい文字が入っても判定は変わらない（CI の macOS の一時フォルダ名が
  // 乱数で「png」を含み、JSON が画像と判定されて投影が落ちた）。
  for (const directory of ["/var/folders/png42/T/work", "/tmp/image-reference-approved", "C:\\Users\\x\\png\\run"]) {
    assert.equal(_testing.canvasArtifactKind("generation-manifest", `${directory}/generation-manifest.json`), "other", directory);
  }
  assert.equal(_testing.canvasArtifactKind("image", "/var/folders/png42/T/work/scene-01.png"), "image-candidate");
  const base = {
    mediaJobs: [{
      provider: "fixture-provider",
      kind: "image.generation",
      model: "image-v1",
      adapterVersion: "adapter-v2",
      inputHash: "1".repeat(64),
    }],
  };
  const first = _testing.providerVersions(base);
  const second = _testing.providerVersions({
    mediaJobs: [{ ...base.mediaJobs[0], inputHash: "2".repeat(64) }],
  });
  assert.deepEqual(second, first);
  assert.match(first[0].sha256, /^sha256:[a-f0-9]{64}$/u);
  assert.match(first[0].label, /runtime identity/u);
  assert.throws(
    () => _testing.providerVersions({
      mediaJobs: [base.mediaJobs[0]],
      adapterProbes: [{ ...base.mediaJobs[0], adapterVersion: "adapter-v3" }],
    }),
    /runtime identityが矛盾/u,
  );
});

test("durable job maps to the strict Canvas Run schema and projects idempotently", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "video-job-canvas-"));
  try {
    const scriptPath = join(projectDir, "script.txt");
    const contactSheetPath = join(projectDir, "contact-sheet.png");
    const contactSheet = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await mkdir(join(projectDir, "canvas"), { recursive: true });
    await writeFile(scriptPath, "日本語の台本。\n");
    await writeFile(contactSheetPath, contactSheet);
    const job = {
      id: "video-fixture-0123456789abcdef",
      revision: 2,
      status: "awaiting-human-review",
      projectDir,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:01:00.000Z",
      harness: {
        id: "fixture-harness",
        declarationVersion: "1.0.0",
        declarationSha256: "1".repeat(64),
        canonicalSkills: [{ id: "fixture-skill", version: "1.0.0", sha256: "2".repeat(64) }],
      },
      channelPack: { id: "fixture-pack", version: "1.0.0", sha256: "3".repeat(64) },
      script: { path: scriptPath, sha256: "e032ecd023297ad156a0a7e16e31264089fb596c13f73fa3f2c5c03be6ba76ef" },
      options: { title: "Fixture" },
      stages: [
        { id: "doctor", status: "pass" },
        { id: "production", status: "awaiting-human-review" },
        { id: "audit", status: "pending" },
        { id: "canvas-projection", status: "pending" },
      ],
      artifacts: [{ kind: "contact-sheet", path: contactSheetPath, sha256: fileSha(contactSheet), mimeType: "image/png" }],
      knownRemainingIssues: ["独立レビュー待ち"],
    };
    // fixtureの台本SHAは実bytesに合わせる。
    job.script.sha256 = createHash("sha256").update("日本語の台本。\n").digest("hex");
    const run = await videoHarnessJobToCanvasRun(job);
    assert.equal(run.status, "awaiting-approval");
    assert.equal(run.jobs[0].status, "complete");
    assert.equal(run.artifacts[0].kind, "contact-sheet");
    const first = await projectVideoHarnessJob(job);
    const second = await projectVideoHarnessJob(job);
    assert.ok(first.added > 0);
    assert.equal(second.added, 0);
    assert.equal(second.updated, 0);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("media projection failure never advances the main Canvas Run state to a false completed candidate", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "video-job-canvas-two-phase-"));
  try {
    const scriptPath = join(projectDir, "script.txt");
    const script = "二段階Canvas投影fixture。\n";
    await writeFile(scriptPath, script);
    const job = {
      id: "video-two-phase-0123456789abcdef",
      revision: 9,
      status: "awaiting-human-review",
      projectDir,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:01:00.000Z",
      harness: { id: "fixture-harness", declarationVersion: "1", declarationSha256: "1".repeat(64), canonicalSkills: [] },
      channelPack: { id: "fixture-pack", version: "1", sha256: "3".repeat(64) },
      script: { path: scriptPath, sha256: fileSha(script) },
      stages: [],
      artifacts: [],
      knownRemainingIssues: ["fixture media commit failure"],
    };
    await assert.rejects(
      () => projectVideoHarnessJob(job, {
        feedbackCollector: async () => ({ ok: true, captured: 0 }),
        mediaAssetPreparer: async () => [],
        mediaProjector: async () => { throw new Error("injected media commit failure"); },
      }),
      /media commit failure/u,
    );
    await assert.rejects(
      () => readFile(resolveCanvasRunStateFile({ projectDir }, job.id)),
      (error) => error?.code === "ENOENT",
      "main Run state must remain absent when media commit fails",
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("completed Job maps only SHA-verified RunReceipt approvals to Canvas signoffs", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "video-job-signoff-"));
  try {
    const scriptPath = join(projectDir, "script.txt");
    const signoffPath = join(projectDir, "independent-signoff.json");
    const receiptPath = join(projectDir, "run-receipt.json");
    const script = "完成済みfixture。\n";
    await writeFile(scriptPath, script);
    await writeFile(signoffPath, "{\"pass\":true}\n");
    const receipt = {
      version: "harness-run-receipt-v1",
      finalized: true,
      outcome: "pass",
      knownRemainingIssues: [],
      harnessBuild: { harness: { id: "fixture-harness", declarationDigest: "1".repeat(64) } },
      artifacts: [{ kind: "signoff-report", sha256: fileSha("{\"pass\":true}\n"), bytes: null }],
      mediaJobs: [],
      approvals: [{
        type: "independent-agent",
        scope: "final-contact-sheet",
        evidenceDigest: "a".repeat(64),
        reviewer: "independent-reviewer",
        reviewerContextId: "review-context-2",
        decidedAt: "2026-09-01T00:02:00.000Z",
      }],
    };
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
    await writeFile(receiptPath, receiptBytes);
    const job = {
      id: "video-completed-0123456789abcdef",
      revision: 7,
      status: "completed",
      projectDir,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:03:00.000Z",
      harness: {
        id: "fixture-harness",
        declarationVersion: "1.0.0",
        declarationSha256: "1".repeat(64),
        canonicalSkills: [],
      },
      channelPack: { id: "fixture-pack", version: "1.0.0", sha256: "3".repeat(64) },
      script: { path: scriptPath, sha256: fileSha(script) },
      stages: [{ id: "canvas-projection", status: "pass" }],
      artifacts: [
        { kind: "signoff-report", path: signoffPath, sha256: fileSha("{\"pass\":true}\n"), mimeType: "application/json" },
        { kind: "run-receipt", path: receiptPath, sha256: fileSha(receiptBytes), bytes: receiptBytes.length, mimeType: "application/json" },
      ],
      knownRemainingIssues: [],
      mediaJobs: [],
    };

    const run = await videoHarnessJobToCanvasRun(job);
    assert.equal(run.status, "complete");
    assert.equal(run.signoffs.length, 1);
    assert.equal(run.signoffs[0].status, "approved");
    assert.equal(run.signoffs[0].reviewer, "independent-reviewer");
    assert.equal(run.signoffs[0].evidenceSha256, `sha256:${"a".repeat(64)}`);
    assert.ok(run.artifacts.some((artifact) => artifact.kind === "signoff"));
    assert.equal(Object.hasOwn(run.script, "path"), false);
    assert.ok(run.artifacts.every((artifact) => !Object.hasOwn(artifact, "path")));

    const originalSignoffSha = job.artifacts[0].sha256;
    job.artifacts[0] = { ...job.artifacts[0], sha256: "c".repeat(64) };
    await assert.rejects(
      videoHarnessJobToCanvasRun(job),
      /artifact SHA rosterが現在のJob成果物と一致しない/u,
    );
    job.artifacts[0] = { ...job.artifacts[0], sha256: originalSignoffSha };

    receipt.approvals = [];
    const withoutApproval = Buffer.from(`${JSON.stringify(receipt)}\n`);
    await writeFile(receiptPath, withoutApproval);
    job.artifacts[1] = { ...job.artifacts[1], sha256: fileSha(withoutApproval), bytes: withoutApproval.length };
    await assert.rejects(
      videoHarnessJobToCanvasRun(job),
      /signoff evidenceが無い/u,
    );

    receipt.approvals = [{
      type: "independent-agent",
      scope: "final-contact-sheet",
      evidenceDigest: "b".repeat(64),
      reviewer: "independent-reviewer",
      reviewerContextId: "review-context-2",
      decidedAt: "2026-09-01T00:02:00.000Z",
    }];
    const restored = Buffer.from(`${JSON.stringify(receipt)}\n`);
    await writeFile(receiptPath, restored);
    job.artifacts[1] = { ...job.artifacts[1], sha256: "f".repeat(64), bytes: restored.length };
    await assert.rejects(
      videoHarnessJobToCanvasRun(job),
      /SHA-256が実fileと一致しない/u,
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Job adapter preflights and projects real media without persisting source absolute paths", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "video-job-real-media-"));
  try {
    const scriptPath = join(projectDir, "script.txt");
    const imagePath = join(projectDir, "selected.png");
    const previewPath = join(projectDir, "preview.mp4");
    const finalPath = join(projectDir, "final.mp4");
    const script = "実media fixture。\n";
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(scriptPath, script);
    await writeFile(imagePath, image);
    const sharedVideoBytes = Buffer.from("\u0000\u0000\u0000\u0018ftypmp42same-preview-and-final");
    await writeFile(previewPath, sharedVideoBytes);
    await writeFile(finalPath, sharedVideoBytes);
    const job = {
      id: "video-media-0123456789abcdef",
      revision: 2,
      status: "awaiting-human-review",
      projectDir,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:01:00.000Z",
      harness: { id: "fixture-harness", declarationVersion: "1", declarationSha256: "1".repeat(64), canonicalSkills: [] },
      channelPack: { id: "fixture-pack", version: "1", sha256: "3".repeat(64) },
      script: { path: scriptPath, sha256: fileSha(script) },
      stages: [],
      artifacts: [
        { id: "selected", kind: "selected-image", title: "採用画像", path: imagePath, sha256: fileSha(image), mimeType: "image/png" },
        { id: "preview", kind: "preview-video", title: "preview", path: previewPath, sha256: fileSha(sharedVideoBytes), mimeType: "video/mp4" },
        { id: "final", kind: "final-video", title: "final", path: finalPath, sha256: fileSha(sharedVideoBytes), mimeType: "video/mp4" },
      ],
      knownRemainingIssues: ["独立レビュー待ち"],
    };
    const result = await projectVideoHarnessJob(job);
    assert.equal(result.mediaProjection.projectedMedia, 3);
    const sceneText = await readFile(join(projectDir, "canvas", "excalidraw-canvas.json"), "utf8");
    const scene = JSON.parse(sceneText);
    assert.ok(scene.elements.some((element) => element.customData?.codexMediaKind === "image"));
    const videos = scene.elements.filter((element) => element.customData?.codexMediaKind === "video" && !element.isDeleted);
    assert.equal(videos.length, 2, "同じSHAでもpreview/finalのrole別elementを作る");
    assert.equal(new Set(videos.map((element) => element.id)).size, 2);
    assert.equal(sceneText.includes(projectDir), false);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
