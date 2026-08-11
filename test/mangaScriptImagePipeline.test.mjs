import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createMangaScriptImagePlan,
  executeMangaScriptImagePlan,
  normalizeScriptImageConcurrency,
  renderEditorialPlatePng,
  runMangaScriptImagePipeline,
} from "../lib/mangaScriptImagePipeline.mjs";
import { writeCharacterRegistry } from "../lib/characterRegistry.mjs";
import { AdaptiveConcurrencyController } from "../lib/adaptiveConcurrency.mjs";

test("script planner covers strict plates, thought focus, split pages, and camera diversity", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-script-plan-"));
  const scriptText = `タイトル：雨の写真店
【カット1：冒頭】
ナレーション：目が覚めると、見慣れた天井だった。
【カット2：対立】
美緒：絶対に戻らない！
玲司：本当に、それでいいのか？
【カット3：内心】
美緒：どうしよう、本当に私だけなのか……
【カット4：時間経過】
ナレーション：その後、各地を巡り、日々と年月が過ぎた。
【カット5：重い反省】
ナレーション：けれど、約束を失った痛みだけは消えなかった。`;
  const registry = {
    characters: [
      { id: "mio", name: "美緒", kind: "character", status: "approved", referenceImagePaths: [] },
      { id: "reiji", name: "玲司", kind: "character", status: "approved", referenceImagePaths: [] },
    ],
  };
  const plan = createMangaScriptImagePlan({
    scriptText,
    episodeId: "planner-test",
    registry,
    canvasDir: root,
    assetDir: join(root, "assets"),
  });

  assert.ok(plan.editorialDecisions.some((entry) => entry.editorialPlate.type === "white-solid"));
  assert.ok(plan.editorialDecisions.some((entry) => entry.editorialPlate.type === "black-solid"));
  assert.ok(plan.editorialDecisions.some((entry) => entry.thoughtFocus.recommended));
  assert.ok(plan.pages.some((entry) => entry.editorial.split.type === "vertical-2"));
  assert.ok(plan.pages.some((entry) => entry.editorial.split.type === "story-3"));
  assert.ok(plan.pages.filter((entry) => entry.editorial.split.recommended).every((entry) => (
    entry.flattenBeforeCamera === true && entry.panelCamera === "static" && entry.wholePageCamera === true
  )));
  assert.ok(plan.jobs.filter((entry) => ["scene-image", "split-panel"].includes(entry.kind)).every((entry) => entry.imageCount === 1));
  assert.ok(plan.jobs.filter((entry) => entry.kind === "editorial-plate").every((entry) => entry.imageCount === 0));
  assert.equal(plan.compositionPlan.diagnostics.consecutiveTooSimilarCount, 0);
  assert.equal(plan.policy.splitPageCamera, "single-continuous");
  assert.equal(plan.policy.typographyGeneratedInImage, false);
});

test("executor respects fixed concurrency, retries only QA failures, and reuses completed jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-script-exec-"));
  const buffer = renderEditorialPlatePng("pastel-sky", 320, 180);
  let active = 0;
  let peak = 0;
  let generated = 0;
  const jobs = Array.from({ length: 13 }, (_, index) => ({
    id: `image:${index + 1}`,
    kind: "scene-image",
    dependencies: [],
    outputPath: join(root, `image-${index + 1}.png`),
    prompt: `scene ${index + 1}`,
    referenceImagePaths: [],
    model: "fake",
    aspectRatio: "16:9",
    imageSize: "2K",
    quality: "high",
    imageCount: 1,
    inputHash: `hash-${index + 1}`,
  }));
  const plan = {
    version: 1,
    episodeId: "executor-test",
    scriptSha256: "script-hash",
    assetDir: root,
    jobs,
  };
  const attempts = new Map();
  const generateImage = async (input) => {
    generated += 1;
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 12));
    active -= 1;
    return { buffer, fileName: input.fileName, mimeType: "image/png" };
  };
  const visualQa = async ({ job, attempt }) => {
    attempts.set(job.id, (attempts.get(job.id) || 0) + 1);
    if (job.id === "image:4" && attempt === 0) return { pass: false, issues: ["subject camera repeats previous frame"] };
    return { pass: true, issues: [] };
  };

  const first = await executeMangaScriptImagePlan(plan, { concurrency: 10, maxRetries: 1, generateImage, visualQa });
  assert.equal(first.ledger.status, "complete");
  assert.ok(peak <= 10);
  assert.ok(peak > 1);
  assert.equal(generated, 14);
  assert.equal(attempts.get("image:4"), 2);
  assert.equal(attempts.get("image:5"), 1);
  assert.equal(first.ledger.jobs["image:4"].retries, 1);

  const beforeReuse = generated;
  const second = await executeMangaScriptImagePlan(plan, { concurrency: 10, maxRetries: 1, generateImage, visualQa });
  assert.equal(second.ledger.status, "complete");
  assert.equal(generated, beforeReuse);
  assert.equal(second.ledger.summary.reused, 13);
  const persisted = JSON.parse(await readFile(second.ledgerPath, "utf8"));
  assert.equal(persisted.summary.complete, 13);
});

test("usage limits persist a waiting checkpoint and resume the unfinished image without duplication", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-script-park-"));
  const ledgerPath = join(root, "image-generation-ledger.json");
  const outputPath = join(root, "image-1.png");
  const plan = {
    version: 1,
    episodeId: "park-test",
    scriptSha256: "park-script-hash",
    assetDir: root,
    jobs: [{
      id: "image:1",
      kind: "scene-image",
      dependencies: [],
      outputPath,
      prompt: "scene",
      referenceImagePaths: [],
      model: "fake",
      aspectRatio: "16:9",
      imageSize: "2K",
      quality: "high",
      imageCount: 1,
      inputHash: "park-input-hash",
    }],
  };
  const buffer = renderEditorialPlatePng("pastel-sky", 320, 180);
  let attempts = 0;
  let clockMs = 0;
  let parkedCheckpoint;
  const adaptiveController = new AdaptiveConcurrencyController({
    initial: 1,
    min: 1,
    max: 1,
    usageLimitPauseMs: 100,
    now: () => clockMs,
  });
  const result = await executeMangaScriptImagePlan(plan, {
    concurrency: "auto",
    ledgerPath,
    maxRetries: 0,
    adaptiveController,
    generateImage: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("usage limit reached");
      return { buffer, fileName: "image-1.png", mimeType: "image/png" };
    },
    visualQa: async () => ({ pass: true, issues: [] }),
    adaptiveRunOptions: {
      sleep: async (ms) => { clockMs += ms; },
      onPark: async () => { parkedCheckpoint = JSON.parse(await readFile(ledgerPath, "utf8")); },
    },
  });
  assert.equal(parkedCheckpoint.status, "waiting");
  assert.equal(parkedCheckpoint.jobs["image:1"].status, "waiting");
  assert.equal(result.ledger.status, "complete");
  assert.equal(result.ledger.jobs["image:1"].status, "complete");
  assert.equal(attempts, 2);
});

test("pipeline concurrency parser supports auto, arbitrary fixed limits, and validation-only unlimited", () => {
  assert.deepEqual(normalizeScriptImageConcurrency(), { mode: "auto", initial: 16, label: "auto" });
  assert.deepEqual(normalizeScriptImageConcurrency("37"), { mode: "fixed", fixedLimit: 37, initial: 37, label: "37" });
  assert.deepEqual(normalizeScriptImageConcurrency("unlimited"), { mode: "unlimited", initial: 64, label: "unlimited" });
});

test("editorial plate renderer emits exact PNG dimensions for every supported plate", () => {
  for (const type of ["white-solid", "black-solid", "pastel-sky"]) {
    const png = renderEditorialPlatePng(type, 640, 360);
    assert.equal(png.toString("ascii", 1, 4), "PNG");
    assert.equal(png.readUInt32BE(16), 640);
    assert.equal(png.readUInt32BE(20), 360);
  }
});

test("split panels are flattened into one 1920x1080 page before camera motion", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-split-page-"));
  const buffer = renderEditorialPlatePng("pastel-sky", 640, 360);
  const panel1 = join(root, "panel-1.png");
  const panel2 = join(root, "panel-2.png");
  const page = join(root, "page.png");
  const plan = {
    version: 1,
    episodeId: "split-page-test",
    scriptSha256: "split-script",
    assetDir: root,
    jobs: [
      { id: "panel:1", kind: "split-panel", dependencies: [], outputPath: panel1, prompt: "left", referenceImagePaths: [], model: "fake", imageCount: 1, inputHash: "p1" },
      { id: "panel:2", kind: "split-panel", dependencies: [], outputPath: panel2, prompt: "right", referenceImagePaths: [], model: "fake", imageCount: 1, inputHash: "p2" },
      { id: "split-page:1", kind: "split-page", dependencies: ["panel:1", "panel:2"], panelPaths: [panel1, panel2], outputPath: page, splitType: "vertical-2", separatorWidthRatio: 0.0145, imageCount: 0, inputHash: "page" },
    ],
  };
  const result = await executeMangaScriptImagePlan(plan, {
    generateImage: async () => ({ buffer, mimeType: "image/png" }),
    visualQa: async () => ({ pass: true, issues: [] }),
  });
  assert.equal(result.ledger.status, "complete");
  const flattened = await readFile(page);
  assert.equal(flattened.readUInt32BE(16), 1920);
  assert.equal(flattened.readUInt32BE(20), 1080);
  assert.equal(result.ledger.jobs["split-page:1"].attempts, 1);
});

test("one-call pipeline pauses after generating candidates for a genuinely new character", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-new-character-"));
  const buffer = renderEditorialPlatePng("pastel-sky", 320, 180);
  let generated = 0;
  const result = await runMangaScriptImagePipeline({
    projectDir: root,
    episodeId: "new-character-test",
    scriptText: "【カット1：部屋】\n新田：ここから始めよう。",
    candidateCount: 3,
    concurrency: 10,
    generateImage: async () => {
      generated += 1;
      return { buffer, mimeType: "image/png" };
    },
  });
  assert.equal(result.status, "awaiting-character-approval");
  assert.equal(result.cast.length, 1);
  assert.equal(result.cast[0].candidates.filter((entry) => entry.status === "generated").length, 3);
  assert.equal(generated, 3);
});

test("one-call pipeline finishes all image jobs for approved cast without intermediate input", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-approved-character-"));
  await writeCharacterRegistry({ projectDir: root }, {
    characters: [{ id: "nitta", name: "新田", kind: "character", role: "per-video", episodeId: "approved-test", status: "approved", referenceImagePaths: [] }],
    voices: [],
  });
  const buffer = renderEditorialPlatePng("pastel-sky", 320, 180);
  let generated = 0;
  const result = await runMangaScriptImagePipeline({
    projectDir: root,
    episodeId: "approved-test",
    scriptText: "【カット1：写真店】\n新田：この写真を確かめよう。",
    concurrency: 10,
    autoSemanticQa: false,
    generateImage: async () => {
      generated += 1;
      return { buffer, mimeType: "image/png" };
    },
  });
  assert.equal(result.status, "complete");
  assert.equal(result.ledger.summary.complete, result.plan.jobs.length);
  assert.ok(result.plan.jobs.some((entry) => entry.kind === "environment-sheet"));
  assert.ok(result.plan.jobs.some((entry) => entry.kind === "scene-image"));
  assert.equal(generated, 2);
});
