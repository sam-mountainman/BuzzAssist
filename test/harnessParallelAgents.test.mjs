import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LEARNING_WRITE_FORBIDDEN_ENV } from "../lib/harnessLearningGuard.mjs";

import { classifyProbeOutcome, maskSecrets, probeEngine, runAgentTasks, selectEngine } from "../scripts/harness-parallel-agents.mjs";

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

test("成功したCodex probeは無関係なMCPの401警告で未ログイン扱いにしない", () => {
  const result = classifyProbeOutcome({
    code: 0,
    text: "PROBE-OK\n",
    stderr: "optional MCP startup returned 401 unauthorized",
  });
  assert.deepEqual(result, {ok: true, reason: null});
});

test("非0終了の認証エラーは未ログインとして分類する", () => {
  const result = classifyProbeOutcome({code: 1, text: "", stderr: "401 unauthorized"});
  assert.deepEqual(result, {ok: false, reason: "未ログイン（認証が必要）"});
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
  //
  // 以前は2つ目の assert で本物のプローブを呼び、「この機械では claude が
  // 使えない」ことを期待していた。環境の事実を振る舞いとして固定していたので
  // ログイン済みの機械では必ず落ち、しかも落ちる前に**実際のモデル呼び出しが
  // 走っていた**。プローブを差し替えて、判定の経路だけを見る。
  let probed = 0;
  const probe = async (engineId) => {
    probed += 1;
    return { engineId, available: false, reason: "テスト用の未ログイン" };
  };
  await assert.rejects(
    () => selectEngine("claude", { readOnly: true, probe }),
    /read-only を保証できません/u,
  );
  assert.equal(probed, 0, "read-only で弾くときは、エンジンを起動しない（実行も課金もしない）");
  // read-only を要求しなければ、判定理由は認証状態になる（別の経路）。
  await assert.rejects(() => selectEngine("claude", { probe }), /使えません: テスト用の未ログイン/u);
  assert.equal(probed, 1, "read-only でなければプローブで判定する");
  // 自動選択でも、read-only を保証できない claude はプローブせずに外す。
  probed = 0;
  await assert.rejects(() => selectEngine("auto", { readOnly: true, probe }), /使えるエージェントCLIがありません/u);
  assert.equal(probed, 1, "codex だけをプローブし、claude は起動しないこと");
});

test("起動する子エージェントには、学習を書かない印を環境変数で渡す", { skip: process.platform === "win32" }, async () => {
  // 子が並列に capture / sync すると同じ台帳の取り合いになり、同じ観測が子の数だけ
  // 別の回数として数えられる。子は結果本文で親へ返す。
  const dir = mkdtempSync(join(tmpdir(), "parallel-agent-env-"));
  try {
    const fake = join(dir, "fake-claude");
    writeFileSync(fake, [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      `  process.stdout.write('flag=' + (process.env.${LEARNING_WRITE_FORBIDDEN_ENV} || 'none'));`,
      "});",
    ].join("\n"));
    chmodSync(fake, 0o755);
    const summary = await runAgentTasks([{ id: "t1", prompt: "x" }], {
      engineInfo: { engineId: "claude", binary: fake },
      outDir: join(dir, "out"),
      concurrency: 1,
      timeoutMs: 20_000,
    });
    assert.equal(summary.tasks[0].status, "completed");
    assert.equal(summary.tasks[0].resultPreview, "flag=child-agent");
    assert.equal(process.env[LEARNING_WRITE_FORBIDDEN_ENV], undefined, "親の環境へ印が漏れた");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
