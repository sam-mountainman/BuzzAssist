import assert from "node:assert/strict";
import test from "node:test";

import {
  AdaptiveConcurrencyController,
  classifyGenerationError,
  runWithAdaptiveConcurrency,
  THROTTLE_SIGNAL,
  USAGE_LIMIT_SIGNAL,
} from "../lib/adaptiveConcurrency.mjs";

const makeClock = (start = 0) => {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; } };
};

const lowRss = () => 1 * 1024 * 1024 * 1024;

test("grows multiplicatively after a success streak", () => {
  const clock = makeClock();
  const controller = new AdaptiveConcurrencyController({ now: clock.now, readRssBytes: lowRss, initial: 16, growthSuccessStreak: 4 });
  for (let index = 0; index < 4; index += 1) controller.recordSuccess();
  assert.equal(controller.currentLimit(), 32);
  for (let index = 0; index < 4; index += 1) controller.recordSuccess();
  assert.equal(controller.currentLimit(), 64);
});

test("halves on throttle and holds during cooldown", () => {
  const clock = makeClock();
  const controller = new AdaptiveConcurrencyController({ now: clock.now, readRssBytes: lowRss, initial: 32, growthSuccessStreak: 2, cooldownMs: 10_000 });
  const verdict = controller.recordFailure(new Error("HTTP 429 too many requests"));
  assert.equal(verdict.retryable, true);
  assert.equal(verdict.signal, THROTTLE_SIGNAL);
  assert.equal(controller.currentLimit(), 16);
  controller.recordSuccess();
  controller.recordSuccess();
  assert.equal(controller.currentLimit(), 16, "no growth during cooldown");
  clock.advance(10_001);
  controller.recordSuccess();
  controller.recordSuccess();
  assert.equal(controller.currentLimit(), 32, "growth resumes after cooldown");
});

test("usage limit parks the pool and resumes after the pause", () => {
  const clock = makeClock();
  const controller = new AdaptiveConcurrencyController({ now: clock.now, readRssBytes: lowRss, initial: 16, usageLimitPauseMs: 60_000 });
  const verdict = controller.recordFailure(new Error("ChatGPTの生成上限に達しました"));
  assert.equal(verdict.parked, true);
  assert.equal(verdict.signal, USAGE_LIMIT_SIGNAL);
  assert.equal(controller.currentLimit(), 0);
  assert.equal(controller.state, "waiting");
  clock.advance(60_001);
  assert.equal(controller.resumeFromWait(), true);
  assert.equal(controller.currentLimit(), 16, "limit is preserved across the wait");
});

test("rss hard limit halves, soft limit freezes growth", () => {
  const clock = makeClock();
  let rss = 1 * 1024 ** 3;
  const controller = new AdaptiveConcurrencyController({ now: clock.now, readRssBytes: () => rss, initial: 32, growthSuccessStreak: 2 });
  rss = 4 * 1024 ** 3; // above soft (3.5G), below hard (5G)
  controller.recordSuccess();
  controller.recordSuccess();
  assert.equal(controller.currentLimit(), 32, "soft limit freezes growth");
  rss = 6 * 1024 ** 3; // above hard
  controller.recordSuccess();
  assert.equal(controller.currentLimit(), 16, "hard limit halves");
});

test("fixed and unlimited modes", () => {
  const clock = makeClock();
  const fixed = new AdaptiveConcurrencyController({ now: clock.now, readRssBytes: lowRss, mode: "fixed", fixedLimit: 50 });
  for (let index = 0; index < 20; index += 1) fixed.recordSuccess();
  assert.equal(fixed.currentLimit(), 50, "fixed mode never grows");
  fixed.recordFailure(new Error("429"));
  assert.equal(fixed.currentLimit(), 50, "fixed mode never shrinks");

  const unlimited = new AdaptiveConcurrencyController({ now: clock.now, readRssBytes: lowRss, mode: "unlimited", growthSuccessStreak: 1 });
  for (let index = 0; index < 6; index += 1) unlimited.recordSuccess();
  assert.ok(unlimited.currentLimit() >= 1024, "unlimited mode grows without cap");
});

test("classifier recognizes throttle and usage limits", () => {
  assert.equal(classifyGenerationError(new Error("Request timed out")), THROTTLE_SIGNAL);
  assert.equal(classifyGenerationError(new Error("rate limit exceeded")), THROTTLE_SIGNAL);
  assert.equal(classifyGenerationError(new Error("hit your usage limit")), USAGE_LIMIT_SIGNAL);
  assert.equal(classifyGenerationError(new Error("boom")), null);
});

test("pool retries throttled jobs and fails hard errors without stopping", async () => {
  const clock = makeClock();
  const controller = new AdaptiveConcurrencyController({ now: clock.now, readRssBytes: lowRss, initial: 2, cooldownMs: 0 });
  let flakyAttempts = 0;
  const jobs = [
    async () => "a",
    async () => {
      flakyAttempts += 1;
      if (flakyAttempts < 2) throw new Error("429 slow down");
      return "b-after-retry";
    },
    async () => { throw new Error("hard failure"); },
    async () => "d",
  ];
  const results = await runWithAdaptiveConcurrency(jobs, controller, { sleep: async () => {}, maxAttempts: 3 });
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, true);
  assert.equal(results[1].value, "b-after-retry");
  assert.equal(results[1].attempts, 2);
  assert.equal(results[2].ok, false);
  assert.match(String(results[2].error), /hard failure/);
  assert.equal(results[3].ok, true);
});

test("pool parks on usage limit and resumes to finish all jobs", async () => {
  const clock = makeClock();
  const controller = new AdaptiveConcurrencyController({ now: clock.now, readRssBytes: lowRss, initial: 1, usageLimitPauseMs: 1_000 });
  let first = true;
  const jobs = [
    async () => {
      if (first) {
        first = false;
        throw new Error("usage limit reached");
      }
      return "recovered";
    },
    async () => "second",
  ];
  const lifecycle = [];
  const results = await runWithAdaptiveConcurrency(jobs, controller, {
    sleep: async (ms) => { clock.advance(ms); },
    maxAttempts: 2,
    onPark: async ({ verdict }) => { lifecycle.push(verdict.signal); },
    onResume: async () => { lifecycle.push("resume"); },
  });
  assert.equal(results[0].ok, true);
  assert.equal(results[0].value, "recovered");
  assert.equal(results[1].ok, true);
  assert.deepEqual(lifecycle, [USAGE_LIMIT_SIGNAL, "resume"]);
});
