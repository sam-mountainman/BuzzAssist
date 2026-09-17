import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  buildCanvasRunProjection,
  CanvasRunProjectionConflictError,
  projectCanvasRun,
} from "../lib/canvasRunProjection.mjs";
import {
  CanvasRunValidationError,
  canvasRunSchema,
  loadCanvasRunState,
  normalizeCanvasRun,
  sha256Hex,
} from "../lib/canvasRunState.mjs";

const hash = (value) => `sha256:${sha256Hex(value)}`;

function fixtureRun(overrides = {}) {
  const scriptText = "第一幕。テスト用の日本語台本です。";
  return {
    schemaVersion: 1,
    runId: "fixture-run-001",
    revision: 3,
    status: "running",
    title: "共通fixture",
    updatedAt: "2026-09-01T00:00:00.000Z",
    script: { id: "input-script", title: "入力台本", language: "ja", text: scriptText, sha256: hash(scriptText) },
    scenes: [
      { id: "cut-01", title: "導入", status: "running", jobIds: ["image-01", "speech-01"] },
    ],
    jobs: [
      { id: "image-01", title: "画像生成", kind: "image", status: "complete", needs: [] },
      { id: "speech-01", title: "音声生成", kind: "tts", status: "running", needs: [] },
      { id: "render-01", title: "動画レンダー", kind: "render", status: "pending", needs: ["image-01", "speech-01"] },
    ],
    artifacts: [
      { id: "candidate-a", kind: "image-candidate", title: "画像候補A", status: "complete", sha256: hash("image-a"), producerJobId: "image-01", canvasAssetUrl: "/excalidraw-assets/candidate-a.png", mimeType: "image/png" },
      { id: "selected-a", kind: "image-selected", title: "採用画像", status: "approved", sha256: hash("selected-a"), producerJobId: "image-01" },
      { id: "reference-a", kind: "image-reference", title: "参照画像", status: "complete", sha256: hash("reference-a") },
      { id: "voice-stem", kind: "audio", title: "音声", status: "complete", sha256: hash("audio"), producerJobId: "speech-01" },
      { id: "subtitle", kind: "subtitle", title: "字幕", status: "complete", sha256: hash("srt") },
      { id: "bgm", kind: "bgm", title: "BGM", status: "complete", sha256: hash("bgm") },
      { id: "preview", kind: "preview-mp4", title: "Preview MP4", status: "complete", sha256: hash("preview") },
      { id: "final", kind: "final-mp4", title: "Final MP4", status: "pending", sha256: hash("final") },
    ],
    audits: [
      { id: "full-decode", title: "全デコード", status: "complete", evidenceSha256: hash("decode-report") },
    ],
    signoffs: [
      { id: "contact-sheet-review", title: "contact sheet 独立確認", status: "awaiting-approval" },
    ],
    knownRemainingIssues: [],
    versions: {
      harness: { id: "fixture-harness", version: "1.0.0", sha256: hash("harness") },
      skills: [{ id: "buzzassist:platform-craft", version: "1.0.0", sha256: hash("skill") }],
      channelPack: { id: "fixture-pack", version: "1.0.0", sha256: hash("channel-pack") },
      providers: [{ id: "fixture-provider", version: "2026-09", sha256: hash("provider") }],
    },
    ...overrides,
  };
}

test("Canvas Run normalization verifies script/artifact evidence and rejects secrets", () => {
  const run = fixtureRun();
  assert.equal(normalizeCanvasRun(run).script.sha256, hash(run.script.text));
  assert.throws(
    () => normalizeCanvasRun({ ...run, apiKey: "must-not-enter-canvas" }),
    (error) => error instanceof CanvasRunValidationError && /sensitive/u.test(error.message),
  );
  assert.throws(
    () => normalizeCanvasRun({ ...run, artifacts: [{ id: "bad", kind: "audio" }] }),
    /artifacts\[0\]\.sha256/u,
  );
  assert.throws(
    () => normalizeCanvasRun({ ...run, status: "complete", knownRemainingIssues: ["未解決"] }),
    /knownRemainingIssues/u,
  );
  assert.throws(
    () => normalizeCanvasRun({ ...run, status: "complete", knownRemainingIssues: [], signoffs: [] }),
    /without an evidence-bound signoff/u,
  );
});

test("exported Canvas Run JSON schema validates the normalized nested state", () => {
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(canvasRunSchema());
  const normalized = normalizeCanvasRun(fixtureRun());
  assert.equal(validate(normalized), true, JSON.stringify(validate.errors));

  const missingScript = structuredClone(normalized);
  delete missingScript.script;
  assert.equal(validate(missingScript), false);

  const malformedJob = structuredClone(normalized);
  malformedJob.jobs[0].status = "self-certified";
  assert.equal(validate(malformedJob), false);

  const unknownNestedField = structuredClone(normalized);
  unknownNestedField.versions.harness.absolutePath = "/private/workspace";
  assert.equal(validate(unknownNestedField), false);

  const completedWithoutSignoff = structuredClone(normalized);
  completedWithoutSignoff.status = "complete";
  completedWithoutSignoff.signoffs = [];
  assert.equal(validate(completedWithoutSignoff), false);
});

test("the same Harness Run builds a byte-stable projection with every production artifact class", () => {
  const first = buildCanvasRunProjection(fixtureRun());
  const second = buildCanvasRunProjection(structuredClone(fixtureRun()));
  assert.deepEqual(second, first);
  assert.equal(new Set(first.elements.map((element) => element.id)).size, first.elements.length);

  const artifactCards = first.elements.filter((element) =>
    element.type === "rectangle" && element.customData?.buzzassistEntityKind === "artifact"
  );
  assert.deepEqual(
    [...new Set(artifactCards.map((element) => element.customData.buzzassistArtifactKind))].sort(),
    ["audio", "bgm", "final-mp4", "image-candidate", "image-reference", "image-selected", "preview-mp4", "subtitle"].sort(),
  );
  assert.ok(artifactCards.every((element) => /^sha256:[a-f0-9]{64}$/u.test(element.customData.buzzassistArtifactSha256)));
  assert.ok(first.elements.some((element) => element.customData?.buzzassistEntityKind === "audit"));
  assert.ok(first.elements.some((element) => element.customData?.buzzassistEntityKind === "signoff"));
  assert.ok(first.elements.some((element) => element.customData?.buzzassistEntityKind === "versions"));
});

test("projection is idempotent, preserves unrelated elements, and stores state beside the durable job", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "buzzassist-canvas-run-"));
  try {
    const canvasDir = join(projectDir, "canvas");
    await mkdir(canvasDir, { recursive: true });
    await writeFile(join(canvasDir, "excalidraw-canvas.json"), `${JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "test",
      elements: [{ id: "user-note", type: "text", version: 1, versionNonce: 1, isDeleted: false, customData: {} }],
      appState: {},
      files: {},
    })}\n`);

    const first = await projectCanvasRun({ projectDir }, fixtureRun());
    const second = await projectCanvasRun({ projectDir }, fixtureRun());
    assert.ok(first.added > 0);
    assert.equal(second.added, 0);
    assert.equal(second.updated, 0);
    assert.equal(second.removed, 0);
    assert.equal(second.stateFile, join(canvasDir, "harness-runs", "fixture-run-001", "canvas-run.json"));

    const scene = JSON.parse(await readFile(join(canvasDir, "excalidraw-canvas.json"), "utf8"));
    assert.ok(scene.elements.some((element) => element.id === "user-note" && element.isDeleted === false));
    const ownedIds = scene.elements
      .filter((element) => element.customData?.buzzassistRunId === "fixture-run-001" && !element.isDeleted)
      .map((element) => element.id);
    assert.equal(new Set(ownedIds).size, ownedIds.length);
    assert.equal((await loadCanvasRunState({ projectDir }, "fixture-run-001")).runId, "fixture-run-001");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("job transitions reuse stable element IDs and removed artifacts become tombstones", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "buzzassist-canvas-transition-"));
  try {
    const initial = fixtureRun();
    await projectCanvasRun({ projectDir }, initial);
    const firstScene = JSON.parse(await readFile(join(projectDir, "canvas", "excalidraw-canvas.json"), "utf8"));
    const firstJob = firstScene.elements.find((element) =>
      element.type === "rectangle" && element.customData?.buzzassistEntityKind === "job" && element.customData?.buzzassistEntityId === "speech-01"
    );
    const removedArtifact = firstScene.elements.find((element) =>
      element.type === "rectangle" && element.customData?.buzzassistEntityKind === "artifact" && element.customData?.buzzassistEntityId === "candidate-a"
    );

    const changed = fixtureRun({
      revision: 4,
      updatedAt: "2026-09-01T00:01:00.000Z",
      jobs: initial.jobs.map((job) => job.id === "speech-01" ? { ...job, status: "complete", progress: 1 } : job),
      artifacts: initial.artifacts.filter((artifact) => artifact.id !== "candidate-a"),
    });
    const result = await projectCanvasRun({ projectDir }, changed);
    assert.ok(result.updated > 0);
    assert.ok(result.removed > 0);

    const secondScene = JSON.parse(await readFile(join(projectDir, "canvas", "excalidraw-canvas.json"), "utf8"));
    const secondJob = secondScene.elements.find((element) => element.id === firstJob.id);
    assert.equal(secondJob.customData.buzzassistStatus, "complete");
    assert.ok(secondJob.version > firstJob.version);
    assert.equal(secondScene.elements.filter((element) => element.id === firstJob.id).length, 1);
    assert.equal(secondScene.elements.find((element) => element.id === removedArtifact.id).isDeleted, true);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("projection rejects stale revisions and divergent content at the same revision", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "buzzassist-canvas-revision-"));
  try {
    const initial = fixtureRun();
    await projectCanvasRun({ projectDir }, initial);
    const canvasFile = join(projectDir, "canvas", "excalidraw-canvas.json");
    const originalScene = await readFile(canvasFile, "utf8");

    await assert.rejects(
      projectCanvasRun({ projectDir }, fixtureRun({
        revision: 2,
        status: "queued",
        updatedAt: "2026-08-31T23:59:00.000Z",
      })),
      (error) => error instanceof CanvasRunProjectionConflictError
        && /古いCanvas Run revision/u.test(error.message)
        && error.storedRevision === 3
        && error.incomingRevision === 2,
    );

    await assert.rejects(
      projectCanvasRun({ projectDir }, fixtureRun({ title: "同じrevisionの別内容" })),
      (error) => error instanceof CanvasRunProjectionConflictError
        && /同じCanvas Run revisionに異なる内容/u.test(error.message),
    );

    assert.equal(await readFile(canvasFile, "utf8"), originalScene);
    const stored = await loadCanvasRunState({ projectDir }, initial.runId);
    assert.equal(stored.revision, 3);
    assert.equal(stored.title, initial.title);

    const advanced = fixtureRun({
      revision: 4,
      title: "revisionを進めた更新",
      updatedAt: "2026-09-01T00:01:00.000Z",
    });
    const result = await projectCanvasRun({ projectDir }, advanced);
    assert.ok(result.updated > 0);
    assert.equal((await loadCanvasRunState({ projectDir }, initial.runId)).revision, 4);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
