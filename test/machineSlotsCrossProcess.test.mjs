import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

// 有料の音声生成の同時数（4）はプロセスの中でしか数えていなかったので、別のセッション
// （別のプロセス）が同時に音声を作ると、端末全体では上限の何倍もの有料リクエストが同時に
// 出ていた（外部レビューの指摘）。2つのプロセスがそれぞれ4本ずつ同時に投げても、
// 偽の有料 API が見る同時数は端末全体の上限（4）を超えないこと。

const brokerUrl = pathToFileURL(join(import.meta.dirname, "..", "lib", "paidMediaJobBroker.mjs")).href;

function childSource() {
  return `
import { createPaidMediaJobBroker } from ${JSON.stringify(brokerUrl)};
const [apiBase, stateDir, label] = process.argv.slice(2);
const broker = createPaidMediaJobBroker({
  stateDir,
  apiBase,
  apiFetch: (url, options) => fetch(url, { method: options.method, headers: options.headers, body: options.body }),
  sleepFn: (ms) => new Promise((done) => setTimeout(done, ms)),
});
const specs = [0, 1, 2, 3].map((index) => ({
  kind: "voice.dialogue",
  provider: "synthetic-provider",
  model: "synthetic-model",
  adapterVersion: "synthetic-adapter-v1",
  voiceId: "synthetic-voice",
  input: { text: label + " の台詞 " + index },
  output: { format: "wav" },
  reservation: { unit: "seconds", estimatedSeconds: 1, estimatedCost: 0.01, currency: "USD" },
}));
await Promise.all(specs.map((spec) => broker.start(spec)));
process.stdout.write("done\\n");
`;
}

test("別々のプロセスが同時に有料の音声を投げても、端末全体の同時数は上限を超えない", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "machine-slot-cross-process-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let inFlight = 0;
  let maxInFlight = 0;
  let total = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      inFlight += 1;
      total += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight -= 1;
        const payload = JSON.parse(body || "{}");
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({
          job: {
            jobId: `job-${total}-${Math.random().toString(16).slice(2)}`,
            requestKey: payload.requestKey,
            inputHash: payload.inputHash,
            status: "completed",
            result: {},
          },
        }));
      }, 300);
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const apiBase = `http://127.0.0.1:${server.address().port}/api/media/jobs`;
  const childPath = join(root, "child.mjs");
  await writeFile(childPath, childSource());
  const env = { ...process.env, BUZZASSIST_STATE_DIR: join(root, "state") };
  const run = (label) => new Promise((done, fail) => {
    const child = spawn(process.execPath, [childPath, apiBase, join(root, `broker-${label}`), label], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => (code === 0 ? done() : fail(new Error(`child ${label} exited ${code}: ${stderr}`))));
  });
  await Promise.all([run("session-a"), run("session-b")]);
  assert.equal(total, 8, "2つのプロセスの8本が全部送られた");
  assert.ok(maxInFlight <= 4, `端末全体の同時数が上限を超えた: ${maxInFlight}`);
  assert.ok(maxInFlight >= 2, "枠の中では並列に走る");
});
