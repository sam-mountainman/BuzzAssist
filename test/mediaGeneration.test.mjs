import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MEDIA_BATCH_COLUMNS,
  DEFAULT_MEDIA_BATCH_CONCURRENCY,
  DEFAULT_MEDIA_BATCH_CHUNK_SIZE,
  chunkMediaBatchJobs,
  normalizeMediaBatchColumns,
  normalizeMediaBatchConcurrency,
  sanitizeGrokVideoDuration,
} from "../lib/mediaGeneration.mjs";

test("media batch defaults to 10 concurrent jobs laid out as 2 columns x 5 rows", () => {
  assert.equal(DEFAULT_MEDIA_BATCH_CONCURRENCY, 10);
  assert.equal(DEFAULT_MEDIA_BATCH_COLUMNS, 2);
  assert.equal(DEFAULT_MEDIA_BATCH_CHUNK_SIZE, 10);
  assert.equal(normalizeMediaBatchConcurrency(undefined), 10);
  assert.equal(normalizeMediaBatchColumns(undefined), 2);
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
