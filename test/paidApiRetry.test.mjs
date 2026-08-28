import assert from "node:assert/strict";
import test from "node:test";

import {
  NonRetryablePaidApiError,
  RetryablePaidApiError,
  afterSuccessFailure,
  isRetryableStatus,
  paidApiResponseError,
  redactSecrets,
  withPaidApiRetry,
} from "../lib/paidApiRetry.mjs";

const noSleep = async () => {};

test("再送してよいのは 429 と 5xx だけ", () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(503), true);
  // 認証も不正リクエストも、何度投げても結果は同じで課金だけ増える。
  assert.equal(isRetryableStatus(401), false);
  assert.equal(isRetryableStatus(403), false);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(404), false);
  assert.equal(isRetryableStatus(200), false);
  assert.equal(isRetryableStatus(undefined), false);
});

test("2xx を受けた後の失敗は再送しない", async () => {
  // サーバは仕事を終えている＝課金済み。転送が切れただけで倍の金が出る。
  let attempts = 0;
  await assert.rejects(
    () => withPaidApiRetry(async () => {
      attempts += 1;
      throw afterSuccessFailure("200を受けた後に本文を受け取れなかった");
    }, { sleepFn: noSleep }),
    (error) => {
      assert.equal(error instanceof NonRetryablePaidApiError, true);
      assert.equal(error.charged, true, "課金済みの可能性が記録されること");
      assert.match(error.message, /課金済みの可能性/u);
      return true;
    },
  );
  assert.equal(attempts, 1, "1回だけで止まること");
});

test("再送可能な失敗は上限まで試し、上限で止まる", async () => {
  let attempts = 0;
  await assert.rejects(
    () => withPaidApiRetry(async () => {
      attempts += 1;
      throw new RetryablePaidApiError("HTTP 503", { status: 503 });
    }, { maxAttempts: 3, sleepFn: noSleep }),
    /3回試行して失敗/u,
  );
  assert.equal(attempts, 3);
});

test("印の付いていない例外はネットワーク断とみなして再送する", async () => {
  // fetch 自体が投げる例外に retryable は付かない。
  let attempts = 0;
  const result = await withPaidApiRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new TypeError("fetch failed");
    return "ok";
  }, { sleepFn: noSleep });
  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});

test("バックオフは指数で伸びるが上限で頭打ちになる", async () => {
  // 上限が無いと、止めたいときに止まらない。
  const waits = [];
  await assert.rejects(
    () => withPaidApiRetry(async () => { throw new RetryablePaidApiError("503"); }, {
      maxAttempts: 6,
      baseBackoffMs: 1000,
      maxBackoffMs: 4000,
      sleepFn: async (ms) => { waits.push(ms); },
    }),
    /6回試行して失敗/u,
  );
  assert.deepEqual(waits, [1000, 2000, 4000, 4000, 4000]);
});

test("秘密は例外の本文からもリトライ通知からも消える", async () => {
  // 残るのは例外の文字列。ログとレポートにそのまま載る。
  const apiKey = "sk-live-0123456789abcdef";
  const notices = [];
  await assert.rejects(
    () => withPaidApiRetry(async () => {
      throw new RetryablePaidApiError(`Authorization: Bearer ${apiKey} が拒否された`);
    }, { maxAttempts: 2, secrets: [apiKey], sleepFn: noSleep, onRetry: (info) => notices.push(info) }),
    (error) => {
      assert.equal(error.message.includes(apiKey), false, "最終例外に秘密が残らないこと");
      assert.match(error.message, /\[redacted\]/u);
      return true;
    },
  );
  assert.equal(notices.length, 1);
  assert.equal(notices[0].error.includes(apiKey), false, "リトライ通知にも残らないこと");
});

test("非再送の例外からも秘密が消える", async () => {
  const apiKey = "sk-live-0123456789abcdef";
  await assert.rejects(
    () => withPaidApiRetry(async () => {
      throw new NonRetryablePaidApiError(`bad key ${apiKey}`, { status: 401 });
    }, { secrets: [apiKey], sleepFn: noSleep }),
    (error) => {
      assert.equal(error.message.includes(apiKey), false);
      return true;
    },
  );
});

test("短すぎる秘密で文字列を壊さない", () => {
  // 空文字で replaceAll すると文字列が壊れる。
  assert.equal(redactSecrets("abc", [""]), "abc");
  assert.equal(redactSecrets("abc", ["ab"]), "abc", "短い値は伏せ字にしない");
  assert.equal(redactSecrets("x sk-live-0123456789 y", ["sk-live-0123456789"]), "x [redacted] y");
});

test("Response からの例外は、本文が読めなくてもステータスで判定する", async () => {
  // 本文を読んでから決める形だと、読み取り失敗で判定が付かないまま
  // catch へ落ちて、印の無い再送が起きる。
  const unreadable = {
    status: 503,
    text: async () => { throw new Error("stream closed"); },
  };
  const retryable = await paidApiResponseError(unreadable, { label: "TTS" });
  assert.equal(retryable.retryable, true);
  assert.match(retryable.message, /本文を読めませんでした/u);

  const denied = { status: 401, text: async () => "invalid token sk-live-0123456789abcdef" };
  const fatal = await paidApiResponseError(denied, { label: "TTS", secrets: ["sk-live-0123456789abcdef"] });
  assert.equal(fatal.retryable, false);
  assert.equal(fatal.message.includes("sk-live"), false, "本文に混ざった秘密も消えること");
});

test("成功すれば1回で返る", async () => {
  let attempts = 0;
  const value = await withPaidApiRetry(async () => { attempts += 1; return 42; }, { sleepFn: noSleep });
  assert.equal(value, 42);
  assert.equal(attempts, 1);
});

test("maxAttempts の指定が不正なら、投げる前に止める", async () => {
  await assert.rejects(
    () => withPaidApiRetry(async () => "x", { maxAttempts: 0 }),
    /maxAttempts は1以上/u,
  );
});
