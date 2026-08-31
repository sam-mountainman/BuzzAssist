import assert from "node:assert/strict";
import test from "node:test";

import { generateOnClient, SharedCodexImageBridge } from "../scripts/codex-image-bridge.mjs";

function fakeClientFactory(state) {
  return async () => {
    const id = ++state.created;
    return {
      id,
      closed: false,
      command: "fake-codex",
      async start() { state.started += 1; },
      dispose() { this.closed = true; state.disposed += 1; },
    };
  };
}

test("shared Codex bridge starts one app-server for concurrent image threads", async () => {
  const state = { created: 0, started: 0, disposed: 0 };
  const bridge = new SharedCodexImageBridge({
    cwd: process.cwd(),
    timeoutMs: 1000,
    clientFactory: fakeClientFactory(state),
  });
  const results = await Promise.all(Array.from({ length: 24 }, (_, index) => bridge.generate(
    { prompt: `job ${index}` },
    { generateOnClient: async (client, payload) => ({ clientId: client.id, prompt: payload.prompt }) },
  )));
  assert.equal(state.started, 1);
  assert.deepEqual(new Set(results.map((entry) => entry.clientId)), new Set([1]));
  assert.equal(bridge.stats.completed, 24);
  bridge.dispose();
  assert.equal(state.disposed, 1);
});

test("shared Codex bridge restarts once and reconnects an unfinished job after app-server crash", async () => {
  const state = { created: 0, started: 0, disposed: 0 };
  const bridge = new SharedCodexImageBridge({
    cwd: process.cwd(),
    timeoutMs: 1000,
    clientFactory: fakeClientFactory(state),
  });
  const result = await bridge.generate({ prompt: "recover" }, {
    generateOnClient: async (client) => {
      if (client.id === 1) throw new Error("Codex app-server exited unexpectedly (code: 1, signal: none).");
      return { clientId: client.id };
    },
  });
  assert.equal(result.clientId, 2);
  assert.equal(state.started, 2);
  assert.equal(bridge.stats.restarts, 1);
  assert.equal(bridge.stats.completed, 1);
  bridge.dispose();
});

test("Codex bridge fails immediately when a turn ends without an image payload", async () => {
  let listener;
  const client = {
    command: "fake-codex",
    async request(method) {
      if (method === "thread/start") return { thread: { id: "thread-1" } };
      if (method === "turn/start") {
        queueMicrotask(() => listener?.({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "interrupted", items: [] },
          },
        }));
        return { turn: { id: "turn-1", items: [] } };
      }
      if (method === "thread/archive") return {};
      throw new Error(`Unexpected request: ${method}`);
    },
    onNotification(next) {
      listener = next;
      return () => { listener = undefined; };
    },
  };

  await assert.rejects(
    generateOnClient(client, { prompt: "test" }, { cwd: process.cwd(), model: "", timeoutMs: 1000 }),
    /ended without an image payload \(status: interrupted\)/,
  );
});
