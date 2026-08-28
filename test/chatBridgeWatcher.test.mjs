import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;

test("ディレクトリ監視が失敗しても、MCP のプロセスは落ちない", async () => {
  // watch(dir, cb) を try/catch で囲んでいたが、try/catch は同期例外しか
  // 捕まえない。EMFILE のような非同期の error はリスナーが無いと
  // unhandled 'error' になり、**MCP のプロセスごと落ちる**。
  // 実際 Codex のレビュー中（多数のプロセスが FD を使う状況）に
  // 「Connection closed」で MCP が起動できなくなっていた。
  // 1500ms のポーリングという代替があるので、watcher を失っても機能は続く。
  const dir = await mkdtemp(join(tmpdir(), "chat-bridge-watch-"));
  // 監視対象のディレクトリが無いと watch は同期例外になり、try/catch が
  // 捨てるので watcher が作られない——最初に書いた版はその経路を通って
  // **何も検証していなかった**。実際に監視が始まる状態を作る。
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, ".chat-bridge"), { recursive: true });

  // 子プロセスで bridge を起動し、watcher に error を投げてから生存を確認する。
  const program = `
    import { startChatBridgeWorker } from ${JSON.stringify(join(root, "lib/chatBridge.mjs"))};
    const stop = startChatBridgeWorker({ canvasDir: ${JSON.stringify(dir)} });
    if (!stop.watcher) { console.log("NO_WATCHER"); process.exit(3); }
    // EMFILE 相当を非同期に投げる。リスナーが無ければここでプロセスが死ぬ。
    stop.watcher.emit("error", Object.assign(new Error("EMFILE: too many open files, watch"), { code: "EMFILE" }));
    setTimeout(() => { stop(); console.log("SURVIVED"); process.exit(0); }, 200);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
    cwd: root, encoding: "utf8", timeout: 20_000,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  assert.equal(result.error, undefined, `子プロセスを起動できていない: ${result.error?.message || ""}`);
  assert.equal(output.includes("NO_WATCHER"), false,
    "watcher が作られていない（この経路では何も検証できない）");
  assert.ok(output.includes("SURVIVED"),
    `watcher の error でプロセスが落ちた（出力: ${output.slice(0, 400)}）`);
  assert.match(output, /ポーリングに切り替え/u, "諦めたことを黙らずに述べること");

  await rm(dir, { recursive: true, force: true });
});
