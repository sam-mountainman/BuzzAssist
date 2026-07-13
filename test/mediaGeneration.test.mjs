import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MEDIA_BATCH_COLUMNS,
  DEFAULT_MEDIA_BATCH_CONCURRENCY,
  DEFAULT_MEDIA_BATCH_CHUNK_SIZE,
  MAX_CODEX_IMAGE_COUNT,
  MAX_GROK_GENERATION_COUNT,
  chunkMediaBatchJobs,
  generateImageMedia,
  generateVideoMedia,
  isCodexImageModel,
  isGrokImageModel,
  isGrokVideoModel,
  isRetryableGrokRateLimit,
  normalizeCodexImageCount,
  normalizeGrokGenerationCount,
  normalizeMediaBatchColumns,
  normalizeMediaBatchConcurrency,
  sanitizeGrokVideoDuration,
} from "../lib/mediaGeneration.mjs";

test("media batch defaults to 10 concurrent jobs laid out as 2 rows x 5 columns", () => {
  assert.equal(DEFAULT_MEDIA_BATCH_CONCURRENCY, 10);
  assert.equal(DEFAULT_MEDIA_BATCH_COLUMNS, 5);
  assert.equal(DEFAULT_MEDIA_BATCH_CHUNK_SIZE, 10);
  assert.equal(normalizeMediaBatchConcurrency(undefined), 10);
  assert.equal(normalizeMediaBatchColumns(undefined), 5);
});

test("ChatGPT GPT Image 2 returns every requested independent image", async () => {
  const previousCommand = process.env.EXCALIDRAW_GPT_IMAGE_2_CODEX_COMMAND;
  const fixturePath = fileURLToPath(new URL("./fixtures/fakeImageBridge.mjs", import.meta.url));
  process.env.EXCALIDRAW_GPT_IMAGE_2_CODEX_COMMAND = `"${process.execPath}" "${fixturePath}"`;
  try {
    const media = await generateImageMedia({
      model: "gpt-image-2-codex",
      prompt: "parallel image test",
      imageCount: 3,
      fileName: "parallel.png",
    });
    assert.equal(media.fileName, "parallel.png");
    assert.equal(media.extraMedia.length, 2);
    assert.deepEqual(media.extraMedia.map((item) => item.fileName), ["parallel-2.png", "parallel-3.png"]);
    assert.equal(media.buffer.length > 0, true);
    assert.equal(media.extraMedia.every((item) => item.buffer.length > 0), true);
  } finally {
    if (previousCommand === undefined) delete process.env.EXCALIDRAW_GPT_IMAGE_2_CODEX_COMMAND;
    else process.env.EXCALIDRAW_GPT_IMAGE_2_CODEX_COMMAND = previousCommand;
  }
});

test("ChatGPT GPT Image 2 accepts 1-10 independent image runs", () => {
  assert.equal(MAX_CODEX_IMAGE_COUNT, 10);
  assert.equal(isCodexImageModel(undefined), true);
  assert.equal(isCodexImageModel("GPT Image 2 (Codex)"), true);
  assert.equal(isCodexImageModel("gpt-image-2"), false);
  assert.equal(normalizeCodexImageCount(undefined), 1);
  assert.equal(normalizeCodexImageCount("4"), 4);
  assert.equal(normalizeCodexImageCount(0), 1);
  assert.equal(normalizeCodexImageCount(99), 10);
});

test("local Grok accepts 1-10 independent image and video runs", () => {
  assert.equal(MAX_GROK_GENERATION_COUNT, 10);
  assert.equal(isGrokImageModel("Grok Imagine (Grok CLI)"), true);
  assert.equal(isGrokVideoModel("Grok Imagine Video (Grok CLI)"), true);
  assert.equal(normalizeGrokGenerationCount(undefined), 1);
  assert.equal(normalizeGrokGenerationCount("6"), 6);
  assert.equal(normalizeGrokGenerationCount(0), 1);
  assert.equal(normalizeGrokGenerationCount(99), 10);
});

test("Grok image count runs independent bridge requests", async () => {
  const previousCommand = process.env.EXCALIDRAW_GROK_IMAGE_HERMES_COMMAND;
  const fixturePath = fileURLToPath(new URL("./fixtures/fakeImageBridge.mjs", import.meta.url));
  process.env.EXCALIDRAW_GROK_IMAGE_HERMES_COMMAND = `"${process.execPath}" "${fixturePath}"`;
  try {
    const media = await generateImageMedia({
      model: "grok-imagine-image-hermes",
      prompt: "parallel Grok image test",
      imageCount: 4,
      fileName: "grok.png",
    });
    assert.equal(media.fileName, "grok.png");
    assert.equal(media.extraMedia.length, 3);
    assert.deepEqual(media.extraMedia.map((item) => item.fileName), ["grok-2.png", "grok-3.png", "grok-4.png"]);
    assert.equal(media.requestedCount, 4);
  } finally {
    if (previousCommand === undefined) delete process.env.EXCALIDRAW_GROK_IMAGE_HERMES_COMMAND;
    else process.env.EXCALIDRAW_GROK_IMAGE_HERMES_COMMAND = previousCommand;
  }
});

test("Grok video count runs independent bridge requests with shared settings", async () => {
  const previousCommand = process.env.EXCALIDRAW_GROK_VIDEO_HERMES_COMMAND;
  const fixturePath = fileURLToPath(new URL("./fixtures/fakeVideoBridge.mjs", import.meta.url));
  process.env.EXCALIDRAW_GROK_VIDEO_HERMES_COMMAND = `"${process.execPath}" "${fixturePath}"`;
  try {
    const media = await generateVideoMedia({
      model: "grok-imagine-video-hermes",
      prompt: "parallel Grok video test",
      duration: "10",
      resolution: "720p",
      videoCount: 3,
      fileName: "grok.mp4",
    });
    assert.equal(media.fileName, "grok.mp4");
    assert.equal(media.extraMedia.length, 2);
    assert.deepEqual(media.extraMedia.map((item) => item.fileName), ["grok-2.mp4", "grok-3.mp4"]);
    assert.equal(media.requestedCount, 3);
  } finally {
    if (previousCommand === undefined) delete process.env.EXCALIDRAW_GROK_VIDEO_HERMES_COMMAND;
    else process.env.EXCALIDRAW_GROK_VIDEO_HERMES_COMMAND = previousCommand;
  }
});

test("Grok retries temporary 429 responses but not exhausted quota", () => {
  assert.equal(isRetryableGrokRateLimit(429, "rate limit exceeded, retry later"), true);
  assert.equal(isRetryableGrokRateLimit(429, "monthly quota exhausted"), false);
  assert.equal(isRetryableGrokRateLimit(500, "rate limit"), false);
});

test("media batch concurrency is capped at 10", () => {
  assert.equal(normalizeMediaBatchConcurrency(99), 10);
  assert.equal(normalizeMediaBatchConcurrency(0), 1);
  assert.equal(normalizeMediaBatchConcurrency(4.6), 5);
});

test("media batch jobs split 18 requests into 10 then 8", () => {
  const jobs = Array.from({ length: 18 }, (_, index) => ({ prompt: `job ${index + 1}` }));
  const chunks = chunkMediaBatchJobs(jobs);
  assert.equal(chunks.length, 2);
  assert.deepEqual(
    chunks.map((chunk) => ({ start: chunk.start, count: chunk.jobs.length })),
    [
      { start: 0, count: 10 },
      { start: 10, count: 8 },
    ],
  );
});

test("Grok CLI video duration accepts only the native 6s or 10s tool choices", () => {
  assert.equal(sanitizeGrokVideoDuration(undefined), 6);
  assert.equal(sanitizeGrokVideoDuration("6"), 6);
  assert.equal(sanitizeGrokVideoDuration("10"), 10);
  assert.throws(() => sanitizeGrokVideoDuration("5"), /must be 6 or 10/);
  assert.throws(() => sanitizeGrokVideoDuration("7"), /must be 6 or 10/);
  assert.throws(() => sanitizeGrokVideoDuration("15"), /must be 6 or 10/);
  assert.throws(() => sanitizeGrokVideoDuration("6s"), /must be 6 or 10/);
});
