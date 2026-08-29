import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_LOG_ROOTS } from "../scripts/sanitize-agent-session-secrets.mjs";

const root = new URL("..", import.meta.url).pathname;

function runScanner() {
  const result = spawnSync(process.execPath, ["scripts/sanitize-agent-session-secrets.mjs", "--fail-on-findings"], {
    cwd: root, encoding: "utf8", timeout: 120_000,
  });
  return { ...result, report: JSON.parse(result.stdout) };
}

test("既定の走査先が、実際にログが書かれる場所と一致している", async () => {
  // 標準コマンドはパスを渡さずに検査器を呼び、検査器はパスを必須にしていた。
  // つまり `npm run security:session-logs` は**1ファイルも検査せずに
  // Usage エラーで終わっていた**。名前だけがある検査だった。
  const { readFileSync } = await import("node:fs");
  const runner = readFileSync(join(root, "scripts/harness-parallel-run.mjs"), "utf8");
  const adapter = readFileSync(join(root, "lib/koyaMcpAdapter.mjs"), "utf8");
  assert.ok(runner.includes('"canvas", "parallel-runs"'), "並列ランナーの出力先が既定に無い");
  assert.ok(adapter.includes('"canvas", "koya-mcp-jobs"'), "ジョブの出力先が既定に無い");
  for (const expected of ["canvas/parallel-runs", "canvas/koya-mcp-jobs"]) {
    assert.ok(DEFAULT_LOG_ROOTS.includes(expected), `既定の走査先に ${expected} が無い`);
  }
});

test("秘密を含むログを検出し、見つかったら非0で終わる", async () => {
  const dir = join(root, "canvas", "parallel-runs", `scanner-test-${process.pid}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "probe.log"),
    "Authorization: Bearer sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE\n");
  try {
    const { report, status } = runScanner();
    assert.ok(report.fileCount > 0, "検査対象が0件（何も検査していない）");
    assert.ok(report.matchCount > 0, "植えた秘密を検出できていない");
    assert.equal(status, 2, "見つかったら非0で終わること");
    assert.equal(report.source, "default-roots", "既定の走査先を使ったことが記録されること");
    // 検出内容そのものを出さないこと。
    assert.equal(JSON.stringify(report).includes("sk-ant-api03-FAKE"), false, "秘密が報告に出ている");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("走査対象0件を「安全」と報告しない", async () => {
  // 対象0件は「秘密が無い」ことを意味しない。設定の問題として扱う。
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(join(root, "scripts/sanitize-agent-session-secrets.mjs"), "utf8");
  assert.match(source, /対象0件は「秘密が無い」ことを意味しません/u, "0件のときの説明が無い");
  assert.match(source, /process\.exitCode = 3/u, "0件を専用の終了コードにしていない");
});
