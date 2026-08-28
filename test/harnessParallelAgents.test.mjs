import assert from "node:assert/strict";
import test from "node:test";

import { probeEngine, selectEngine } from "../scripts/harness-parallel-agents.mjs";

// 認証されていないCLIを「入っているから使える」と判断すると、全タスクが
// 同じエラーで落ちてから気づくことになる。存在ではなく実際に応答するかで選ぶ。
test("未知のエンジンは使えないものとして扱う", async () => {
  const probe = await probeEngine("nope");
  assert.equal(probe.available, false);
  assert.match(probe.reason, /未知のエンジン/u);
});

test("エンジン指定が使えないときは黙って別のへ落ちない", async () => {
  await assert.rejects(
    () => selectEngine("nope"),
    /エンジン nope は使えません/u,
  );
});

test("実行ファイルが無いエンジンは理由つきで落とす", async () => {
  // claude は入っているが未ログインのことがある。どちらの理由でも
  // available=false になり、reason が空にならないことを確かめる。
  const probe = await probeEngine("claude", { timeoutMs: 120_000 });
  if (!probe.available) {
    assert.ok(typeof probe.reason === "string" && probe.reason.length > 0);
  } else {
    assert.ok(probe.binary);
  }
});
