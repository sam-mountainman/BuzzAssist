import assert from "node:assert/strict";
import test from "node:test";

import { runHarnessDoctor } from "../scripts/harness-doctor.mjs";

function routeCheck(report) {
  return report.checks.find((check) => check.id === "image-default-route");
}

test("Codex が無い端末では、既定の画像経路が止まることを先に知らせる（本番は止めない）", async () => {
  // Claude Code だけを入れた運営者が、モデル未指定で画像を頼むと Codex 経由になって止まる。
  // 黙って有料の別経路へ切り替えない代わりに、選び方を doctor で先に出す。
  const env = { ...process.env };
  for (const key of ["EXCALIDRAW_GPT_IMAGE_2_CODEX_COMMAND", "EXCALIDRAW_IMAGE_GENERATION_COMMAND", "EXCALIDRAW_GPT_IMAGE_2_CODEX_URL", "EXCALIDRAW_IMAGE_GENERATION_URL", "EXCALIDRAW_DISABLE_CODEX_APP_SERVER_BRIDGE"]) delete env[key];
  const report = await runHarnessDoctor({
    runtime: {
      env,
      resolveCodexCommand: async () => { throw new Error("codex not found"); },
    },
  });
  const check = routeCheck(report);
  assert.ok(check, "検査があること");
  assert.equal(check.ok, false);
  assert.equal(check.required, false, "キャンバスの既定経路の問題で本番 Job を止めない");
  assert.match(check.fix, /Grok/u, "課金しない別経路を示すこと");
  assert.match(check.fix, /クレジット/u, "クレジットを使う経路はそう言うこと");
});

test("Codex があるか、実行先を明示していれば通す", async () => {
  const found = await runHarnessDoctor({ runtime: { resolveCodexCommand: async () => "/usr/local/bin/codex" } });
  assert.equal(routeCheck(found).ok, true);
  const explicit = await runHarnessDoctor({
    runtime: {
      env: { ...process.env, EXCALIDRAW_GPT_IMAGE_2_CODEX_URL: "http://127.0.0.1:9/bridge" },
      resolveCodexCommand: async () => { throw new Error("not reached"); },
    },
  });
  assert.equal(routeCheck(explicit).ok, true);
});
