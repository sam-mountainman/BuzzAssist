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
