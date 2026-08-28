import assert from "node:assert/strict";
import test from "node:test";

import { creditReservationVerdict } from "../lib/subtitleGeneration.mjs";

test("クレジット会計を配備していない構成では、予約なしで進む", () => {
  // 404/405/501 は「機能が無い」。会計を置いていない配備なので通す。
  for (const status of [404, 405, 501]) {
    const verdict = creditReservationVerdict(status, {});
    assert.equal(verdict.proceedWithoutReservation, true, `HTTP ${status}`);
    assert.equal(verdict.blocked, false);
  }
});

test("課金制御が落ちているときは、有償処理を始めない", () => {
  // 5xx は「サービスが在るのに答えられない」。404 と同じに扱っていたので、
  // 課金制御が落ちた瞬間に有償処理が上限なしで走った。
  // 連打だけでなく、エージェントのループや壊れた再送でも残高を使い切れる。
  for (const status of [500, 502, 503, 504]) {
    const verdict = creditReservationVerdict(status, {});
    assert.equal(verdict.blocked, true, `HTTP ${status} で止まること`);
    assert.equal(verdict.proceedWithoutReservation, false);
    assert.match(verdict.message, /上限のないまま残高を消費/u, "なぜ止めたのかを述べること");
  }
});

test("会計なしで進めるのは、明示したときだけ", () => {
  const verdict = creditReservationVerdict(503, { BUZZASSIST_ALLOW_UNRESERVED_ON_CREDIT_OUTAGE: "1" });
  assert.equal(verdict.proceedWithoutReservation, true);
  assert.equal(verdict.blocked, false);
  // 明示していない値では通さない。
  for (const value of ["", "0", "true", "yes"]) {
    assert.equal(
      creditReservationVerdict(503, { BUZZASSIST_ALLOW_UNRESERVED_ON_CREDIT_OUTAGE: value }).blocked,
      true,
      `"${value}" を許可として読まないこと`,
    );
  }
});

test("正常系は予約を要求する", () => {
  for (const status of [200, 201, 400, 401, 403]) {
    const verdict = creditReservationVerdict(status, {});
    assert.equal(verdict.proceedWithoutReservation, false, `HTTP ${status} を素通りさせないこと`);
    assert.equal(verdict.blocked, false);
  }
});

test("2xx を受け取っただけでは予約したことにしない", async () => {
  // 欠けた値を 0 や undefined へ丸めていたので、200 {} も、全フィールド null も、
  // 負のクレジットも「予約成功」として通っていた——形だけ検査して中身を
  // 見ない型そのもの。壊れた制御プレーンの応答で有償生成が始まる。
  const { validateCreditReservationPayload } = await import("../lib/subtitleGeneration.mjs");
  const rejected = [
    [undefined, "本文なし"],
    [{}, "空のオブジェクト"],
    [{ credits: 5 }, "トークンなし"],
    [{ reservationToken: "t" }, "credits なし"],
    [{ reservationToken: "t", credits: 0 }, "credits が0"],
    [{ reservationToken: "t", credits: -3 }, "credits が負"],
    [{ reservationToken: "t", credits: 1.5 }, "credits が非整数"],
    [{ reservationToken: "t", credits: "many" }, "credits が数値でない"],
    [{ reservationToken: "   ", credits: 5 }, "空白だけのトークン"],
    [{ reservationToken: "t", credits: 5, requestId: "other" }, "requestId が食い違う"],
  ];
  for (const [payload, why] of rejected) {
    const result = validateCreditReservationPayload(payload, "req-1");
    assert.equal(result.ok, false, `${why} を予約として受け取ってはいけない`);
    assert.match(result.message, /有償処理を開始しない/u);
  }

  const accepted = validateCreditReservationPayload(
    { reservationToken: "tok", credits: 12, requestId: "req-1", estimatedCostYen: 34 }, "req-1",
  );
  assert.equal(accepted.ok, true);
  assert.equal(accepted.reservation.credits, 12);
  assert.equal(accepted.reservation.reservationToken, "tok");
});

test("課金の有無が分からない失敗は再送しない", async () => {
  // 504（ゲートウェイタイムアウト）は上流が受理して課金した後にも返る。
  // 冪等性キーを提供側まで通せない構成で再送すると、同じ有償生成が2回走る。
  const { isRetryableStatus, AMBIGUOUS_STATUSES, paidApiResponseError, withPaidApiRetry } =
    await import("../lib/paidApiRetry.mjs");

  for (const status of AMBIGUOUS_STATUSES) {
    assert.equal(isRetryableStatus(status), false, `HTTP ${status} を再送してはいけない`);
    const error = await paidApiResponseError({ status, text: async () => "gateway timeout" }, { label: "TTS" });
    assert.equal(error.retryable, false);
    assert.equal(error.charged, null, "課金の有無が不明であることを残すこと");
    assert.match(error.message, /二重に払う/u);
  }
  // 502/503 は上流が受理する前なので、従来どおり再送する。
  for (const status of [500, 502, 503]) {
    assert.equal(isRetryableStatus(status), true, `HTTP ${status} は再送してよい`);
  }

  let attempts = 0;
  await assert.rejects(
    () => withPaidApiRetry(async () => {
      attempts += 1;
      throw await paidApiResponseError({ status: 504, text: async () => "" }, { label: "TTS" });
    }, { maxAttempts: 4, sleepFn: async () => {} }),
    /二重に払う/u,
  );
  assert.equal(attempts, 1, "1回で止めること");
});
