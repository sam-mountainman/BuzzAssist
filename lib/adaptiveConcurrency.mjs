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
 *
 * 2段の工程（生成 → 品質チェック）のために、各ジョブは枠の持ち手 `slot` を引数に受け取る。
 * - `slot.release()` … 生成を終えて QA を待つ間、生成の枠を返す。空いた枠で次のジョブの生成が
 *   始まる（QA の同時数は呼び出し側の QA キューが数える）。
 * - `await slot.reacquire()` … QA に落ちて作り直す前に、生成の枠を取り直す。取り直しは
 *   新しいジョブの開始より先に回す（途中の作り直しを後回しにしない）。利用上限で止めている
 *   間は、取り直しも新しい開始も待つ。
 * 枠を返さないジョブ（従来の呼び出し）は、今までどおり終わるまで枠を1つ持つ。
 */
export async function runWithAdaptiveConcurrency(jobs, controller, options = {}) {
  const sleep = options.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const results = new Array(jobs.length);
  const queue = jobs.map((job, index) => ({ job, index, attempts: 0 }));
  // 生成の枠を持っているジョブの数（上限と比べるのはこれ）。枠を返して QA を待つジョブは数えない。
  let holding = 0;
  let cursor = 0;
  const pending = new Set();
  const reacquireWaiters = [];
  let wake = null;
  const signal = () => {
    if (!wake) return;
    const current = wake;
    wake = null;
    current.resolve();
  };
  const nextWake = () => {
    if (!wake) {
      let resolveWake;
      const promise = new Promise((resolvePromise) => { resolveWake = resolvePromise; });
      wake = { promise, resolve: resolveWake };
    }
    return wake.promise;
  };

  const launch = (entry) => {
    holding += 1;
    let held = true;
    const slot = {
      get held() { return held; },
      release() {
        if (!held) return;
        held = false;
        holding -= 1;
        signal();
      },
      reacquire() {
        if (held) return Promise.resolve();
        return new Promise((granted) => {
          reacquireWaiters.push(() => {
            held = true;
            holding += 1;
            granted();
          });
          signal();
        });
      },
    };
    const promise = (async () => {
      try {
        const value = await entry.job(slot);
        controller.recordSuccess();
        results[entry.index] = { ok: true, value, attempts: entry.attempts + 1 };
      } catch (error) {
        const verdict = controller.recordFailure(error);
        if (verdict.parked && typeof options.onPark === "function") {
          await options.onPark({ index: entry.index, error, controller, verdict });
        }
        entry.attempts += 1;
        if (verdict.retryable && entry.attempts < maxAttempts) {
          // A usage-limit park must resume this exact unfinished job before
          // advancing to later queued work. Otherwise a fixed-width pool can
          // consume one quota failure per job across successive cooldowns.
          if (verdict.parked) queue.splice(cursor, 0, entry);
          else queue.push(entry);
        } else if (verdict.retryable && verdict.parked && entry.attempts >= maxAttempts) {
          // Parked jobs are waiting, not failed: give them another chance
          // after resume without counting the park against the job.
          entry.attempts -= 1;
          queue.splice(cursor, 0, entry);
        } else {
          results[entry.index] = { ok: false, error, attempts: entry.attempts };
        }
      } finally {
        if (held) {
          held = false;
          holding -= 1;
        }
      }
    })();
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
  };

  while (cursor < queue.length || pending.size > 0) {
    const limit = controller.currentLimit();
    if (limit === 0) {
      if (holding === 0) {
        const waitMs = Math.max(50, controller.waitRemainingMs());
        await sleep(waitMs);
        if (controller.resumeFromWait() && typeof options.onResume === "function") {
          await options.onResume({ controller });
        }
      } else {
        await Promise.race([...pending, nextWake()]);
      }
      continue;
    }
    while (reacquireWaiters.length > 0 && holding < limit) reacquireWaiters.shift()();
    while (reacquireWaiters.length === 0 && cursor < queue.length && holding < limit) {
      launch(queue[cursor]);
      cursor += 1;
    }
    if (pending.size > 0) await Promise.race([...pending, nextWake()]);
    else if (cursor >= queue.length) break;
  }
  return results;
}
