// R62: adaptive concurrency controller (AIMD) for high-volume image
// generation. Pure logic — no I/O, no timers of its own — so behaviour is
// deterministic under test: the caller injects `now()` and RSS readings.
//
// Policy (approved design, docs/r62-parallel-image-generation-design.md):
// - start at `initial` (default 16), grow multiplicatively (x2) after
//   `growthSuccessStreak` consecutive successes up to `max`;
// - on a retryable throttle signal (429/timeout) halve the limit (floor
//   `min`) and enter a cooldown before growth may resume;
// - a usage-limit signal parks the controller in `waiting` (jobs must NOT be
//   failed) until `resumeAfterMs` elapses;
// - an RSS guard freezes growth above `rssSoftLimitBytes` and halves once
//   above `rssHardLimitBytes` (memory discipline for 16GB hosts).

const DEFAULTS = {
  initial: 16,
  min: 4,
  max: 256,
  growthSuccessStreak: 8,
  cooldownMs: 15_000,
  usageLimitPauseMs: 5 * 60_000,
  rssSoftLimitBytes: 3.5 * 1024 * 1024 * 1024,
  rssHardLimitBytes: 5 * 1024 * 1024 * 1024,
};

export const THROTTLE_SIGNAL = "throttle";
export const USAGE_LIMIT_SIGNAL = "usage-limit";

export function classifyGenerationError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/usage[_ -]?limit|hit your usage|quota|生成上限/iu.test(message)) return USAGE_LIMIT_SIGNAL;
  if (/rate[_ -]?limit|too many requests|\b429\b|timed? ?out|timeout/iu.test(message)) return THROTTLE_SIGNAL;
  return null;
}

export class AdaptiveConcurrencyController {
  constructor(options = {}) {
    const config = { ...DEFAULTS, ...options };
    if (options.mode === "fixed") {
      config.initial = Math.max(1, Math.round(options.fixedLimit ?? config.initial));
      config.min = config.initial;
      config.max = config.initial;
    } else if (options.mode === "unlimited") {
      // Discouraged, validation-only: no throttle-driven ceiling, but the RSS
      // guard still applies.
      config.initial = Math.max(config.initial, 64);
      config.max = Number.MAX_SAFE_INTEGER;
    }
    this.config = config;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.readRssBytes = typeof options.readRssBytes === "function"
      ? options.readRssBytes
      : () => process.memoryUsage().rss;
    this.limit = config.initial;
    this.successStreak = 0;
    this.cooldownUntil = 0;
    this.waitingUntil = 0;
    this.history = [];
  }

  get state() {
    if (this.waitingUntil > this.now()) return "waiting";
    if (this.cooldownUntil > this.now()) return "cooldown";
    return "steady";
  }

  /** Current permitted parallelism (0 while waiting on a usage limit). */
  currentLimit() {
    if (this.waitingUntil > this.now()) return 0;
    return this.limit;
  }

  /** Milliseconds the caller should wait before polling again while parked. */
  waitRemainingMs() {
    return Math.max(0, this.waitingUntil - this.now());
  }

  recordSuccess() {
    this.successStreak += 1;
    const rss = this.readRssBytes();
    if (rss >= this.config.rssHardLimitBytes) {
      this.#halve("rss-hard-limit");
      return;
    }
    const growthBlocked = rss >= this.config.rssSoftLimitBytes
      || this.cooldownUntil > this.now()
      || this.waitingUntil > this.now();
    if (!growthBlocked && this.successStreak >= this.config.growthSuccessStreak && this.limit < this.config.max) {
      this.limit = Math.min(this.config.max, this.limit * 2);
      this.successStreak = 0;
      this.history.push({ at: this.now(), event: "grow", limit: this.limit });
    }
  }

  recordFailure(error) {
    const signal = classifyGenerationError(error);
    if (signal === USAGE_LIMIT_SIGNAL) {
      this.waitingUntil = this.now() + this.config.usageLimitPauseMs;
      this.successStreak = 0;
      this.history.push({ at: this.now(), event: "usage-limit-wait", untilMs: this.waitingUntil });
      return { retryable: true, parked: true, signal };
    }
    if (signal === THROTTLE_SIGNAL) {
      this.#halve("throttle");
      return { retryable: true, parked: false, signal };
    }
    this.successStreak = 0;
    return { retryable: false, parked: false, signal: null };
  }

  /** Called when the parked period elapsed and generation resumes. */
  resumeFromWait() {
    if (this.waitingUntil <= this.now()) {
      this.waitingUntil = 0;
      this.history.push({ at: this.now(), event: "resume" });
      return true;
    }
    return false;
  }

  #halve(reason) {
    this.limit = Math.max(this.config.min, Math.floor(this.limit / 2));
    this.successStreak = 0;
    this.cooldownUntil = this.now() + this.config.cooldownMs;
    this.history.push({ at: this.now(), event: "halve", reason, limit: this.limit });
  }
}

/**
 * Runs `jobs` (array of async thunks) under the controller. Jobs are
 * registered up-front; worker slots are created just-in-time as the limit
 * allows. Throttle-classified failures are retried (with the reduced limit);
 * usage-limit failures park the whole pool and resume automatically.
 * Non-retryable failures are reported per-job without stopping the pool.
 */
export async function runWithAdaptiveConcurrency(jobs, controller, options = {}) {
  const sleep = options.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const results = new Array(jobs.length);
  const queue = jobs.map((job, index) => ({ job, index, attempts: 0 }));
  let active = 0;
  let cursor = 0;
  const pending = new Set();

  const launch = (entry) => {
    active += 1;
    const promise = (async () => {
      try {
        const value = await entry.job();
        controller.recordSuccess();
        results[entry.index] = { ok: true, value, attempts: entry.attempts + 1 };
      } catch (error) {
        const verdict = controller.recordFailure(error);
        if (verdict.parked && typeof options.onPark === "function") {
          await options.onPark({ index: entry.index, error, controller, verdict });
        }
        entry.attempts += 1;
        if (verdict.retryable && entry.attempts < maxAttempts) {
          queue.push(entry);
        } else if (verdict.retryable && verdict.parked && entry.attempts >= maxAttempts) {
          // Parked jobs are waiting, not failed: give them another chance
          // after resume without counting the park against the job.
          entry.attempts -= 1;
          queue.push(entry);
        } else {
          results[entry.index] = { ok: false, error, attempts: entry.attempts };
        }
      } finally {
        active -= 1;
      }
    })();
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
  };

  while (cursor < queue.length || active > 0) {
    const limit = controller.currentLimit();
    if (limit === 0) {
      if (active === 0) {
        const waitMs = Math.max(50, controller.waitRemainingMs());
        await sleep(waitMs);
        if (controller.resumeFromWait() && typeof options.onResume === "function") {
          await options.onResume({ controller });
        }
      } else {
        await Promise.race(pending);
      }
      continue;
    }
    while (cursor < queue.length && active < limit) {
      launch(queue[cursor]);
      cursor += 1;
    }
    if (active > 0) await Promise.race(pending);
    else if (cursor >= queue.length) break;
  }
  return results;
}
