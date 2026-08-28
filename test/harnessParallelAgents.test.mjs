import assert from "node:assert/strict";
import test from "node:test";

import { maskSecrets, probeEngine, runAgentTasks, selectEngine } from "../scripts/harness-parallel-agents.mjs";

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

// --- Codexレビュー(2026-08-28)で指摘された経路の回帰テスト ---

test("並列数0や負数は「1件も実行せず成功」にせず、その場で落とす", async () => {
  const tasks = [{ id: "t1", prompt: "x" }];
  for (const bad of [0, -1, 1.5, Number.NaN, "3"]) {
    await assert.rejects(
      () => runAgentTasks(tasks, {
        concurrency: bad,
        engineInfo: { engineId: "codex", binary: "/bin/true" },
      }),
      /1 以上の整数/u,
      `concurrency=${bad} が通ってしまった`,
    );
  }
});

test("ログに残す前に、形の分かる秘密を伏せる", () => {
  const cases = [
    "key=sk-abcdefghijklmnopqrstuvwx",
    "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
    'api_key="0123456789abcdef0123"',
  ];
  for (const text of cases) {
    const masked = maskSecrets(text);
    assert.match(masked, /\[redacted\]/u, `伏せられていない: ${text}`);
  }
  // 普通の文章は壊さない
  assert.equal(maskSecrets("レビューは合格しました"), "レビューは合格しました");
  assert.equal(maskSecrets(""), "");
  assert.equal(maskSecrets(null), "");
});

test("read-only を要求したら、保証できないエンジンは選ばない", async () => {
  // claude は read-only を保証できないので、read-only 指定では候補から外れる。
  // codex が使えない環境では「使えるエージェントCLIがない」で落ちるのが正しく、
  // 黙って書き込み可能な claude へ落ちてはいけない。
  // 認証状態とは無関係に、read-only を保証できないという理由で落ちること。
  // 「未ログインだから落ちた」では、ログインした途端に書き込み可能になる。
  await assert.rejects(
    () => selectEngine("claude", { readOnly: true }),
    /read-only を保証できません/u,
  );
  // read-only を要求しなければ、判定理由は認証状態になる（別の経路）。
  await assert.rejects(() => selectEngine("claude", {}), /使えません/u);
});
