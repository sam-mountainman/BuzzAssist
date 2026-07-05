import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MEDIA_BATCH_COLUMNS,
  DEFAULT_MEDIA_BATCH_CONCURRENCY,
  DEFAULT_MEDIA_BATCH_CHUNK_SIZE,
  chunkMediaBatchJobs,
  normalizeMediaBatchColumns,
  normalizeMediaBatchConcurrency,
} from "../lib/mediaGeneration.mjs";

test("media batch defaults to 10 concurrent jobs in 5 columns", () => {
  assert.equal(DEFAULT_MEDIA_BATCH_CONCURRENCY, 10);
  assert.equal(DEFAULT_MEDIA_BATCH_COLUMNS, 5);
  assert.equal(DEFAULT_MEDIA_BATCH_CHUNK_SIZE, 10);
  assert.equal(normalizeMediaBatchConcurrency(undefined), 10);
  assert.equal(normalizeMediaBatchColumns(undefined), 5);
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
