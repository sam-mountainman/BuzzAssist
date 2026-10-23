import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createManualHandoff, importManualHandoff } from "../lib/optimalConfig/execution/manualHandoff.mjs";
import { detectOllamaImage, generateOllamaImage } from "../lib/optimalConfig/execution/ollamaLocalImage.mjs";
import { assertFinalOutputs, createRateLimitFallbackRouter, isRateLimitError } from "../lib/optimalConfig/execution/rateLimitFallback.mjs";
import { createRunpodProvider, rentedGpuRunCap, runRentedGpuJob } from "../lib/optimalConfig/execution/rentedGpuJobGuard.mjs";
import { runOptimalConfigCommand } from "../scripts/optimal-config.mjs";

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Ollama の形の偽物。呼ばれた URL を残す（外へは出ない）。 */
function fakeOllama({ running = true, models = ["x/flux2-klein:4b"], image = PNG.toString("base64") } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    if (!running) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    if (String(url).endsWith("/api/version")) return jsonResponse({ version: "0.13.0" });
    if (String(url).endsWith("/api/tags")) return jsonResponse({ models: models.map((name) => ({ name })) });
    if (String(url).endsWith("/api/generate")) return jsonResponse({ model: init.body ? JSON.parse(init.body).model : "", image, done: true });
    return jsonResponse({ error: "not found" }, 404);
  };
  return { fetchImpl, calls };
}

test("Ollama: 動いていない・モデルが無いときは理由と運営者のコマンドを返し、ダウンロードしない", async () => {
  const down = fakeOllama({ running: false });
  const offline = await detectOllamaImage({ fetchImpl: down.fetchImpl });
  assert.equal(offline.available, false);
  assert.equal(offline.reasons[0].code, "ollama-not-running");

  const missing = fakeOllama({ models: ["llama3:8b"] });
  const result = await detectOllamaImage({ catalogModelId: "z-image-turbo", fetchImpl: missing.fetchImpl });
  assert.equal(result.running, true);
  assert.equal(result.modelPresent, false);
  assert.equal(result.reasons[0].code, "ollama-model-missing");
  assert.match(result.reasons[0].message, /勝手にダウンロードしない/u);
  assert.deepEqual(result.operatorCommands, ["ollama pull x/z-image-turbo"]);
  assert.ok(missing.calls.every((call) => !/\/api\/pull/u.test(call.url)), "/api/pull は呼ばない");
  await assert.rejects(generateOllamaImage({ catalogModelId: "z-image-turbo", prompt: "猫", outputPath: "/never/written.png", fetchImpl: missing.fetchImpl }), { code: "ollama-unavailable" });
  assert.ok(missing.calls.every((call) => !/\/api\/(pull|generate)/u.test(call.url)));
});

test("Ollama: 手元以外の URL には話さない。使えれば手元で1枚作って記録を返す", async (t) => {
  await assert.rejects(detectOllamaImage({ baseUrl: "https://ollama.example.com", fetchImpl: async () => { throw new Error("呼ばれてはいけない"); } }), { code: "ollama-not-local" });
  const dir = await mkdtemp(join(tmpdir(), "ollama-image-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ok = fakeOllama({ models: ["x/flux2-klein:4b"] });
  const outputPath = join(dir, "cut-01.png");
  const record = await generateOllamaImage({ prompt: "小料理屋の店内、2人の掛け合い", width: 1280, height: 720, steps: 4, outputPath, fetchImpl: ok.fetchImpl });
  assert.equal(record.cashCostJpy, 0);
  assert.equal(record.dataDestination, "local");
  assert.equal(record.runtime.place, "operator-mac");
  assert.equal(record.sha256, createHash("sha256").update(PNG).digest("hex"));
  assert.deepEqual(await readFile(outputPath), PNG);
  const generate = ok.calls.find((call) => call.url.endsWith("/api/generate"));
  assert.deepEqual({ model: generate.body.model, stream: generate.body.stream, width: generate.body.width, steps: generate.body.steps }, { model: "x/flux2-klein:4b", stream: false, width: 1280, steps: 4 });
  assert.ok(ok.calls.every((call) => call.url.startsWith("http://127.0.0.1:11434/")));
});

/** Runpod の形の偽物（Pod の desiredStatus と、止めても残るボリューム）。 */
function mockRunpod({ stopWorks = true, hourlyJpy = 120, volumeGiB = 20 } = {}) {
  const pods = new Map();
  const log = [];
  return {
    log,
    pods,
    provider: {
      id: "runpod-mock",
      async start(spec) {
        const id = `pod-${pods.size + 1}`;
        pods.set(id, { desiredStatus: "RUNNING", spec });
        log.push(["start", id]);
        return { instanceId: id, hourlyJpy };
      },
      async status(instance) {
        const pod = pods.get(instance.instanceId);
        return { state: pod.desiredStatus === "EXITED" ? "stopped" : pod.desiredStatus.toLowerCase() };
      },
      async collectOutputs(instance, { workResult }) {
        log.push(["collect", instance.instanceId]);
        return (workResult?.files || []).map((file) => ({ path: file, sha256: "c".repeat(64) }));
      },
      async stop(instance) {
        log.push(["stop", instance.instanceId]);
        if (stopWorks) pods.get(instance.instanceId).desiredStatus = "EXITED";
      },
      async storage(instance) {
        return { volumes: [{ id: `${instance.instanceId}:volume`, sizeGiB: volumeGiB, monthlyJpy: volumeGiB * 15 }] };
      },
    },
  };
}

const quick = { stopVerifyAttempts: 3, stopVerifyIntervalMs: 0, sleep: async () => {} };

test("借り GPU: 始める→動かす→回収→止める→止まったと確かめる→保存費を報告する", async () => {
  const mock = mockRunpod();
  const report = await runRentedGpuJob({
    provider: mock.provider,
    spec: { hourlyJpy: 120, gpu: "L4" },
    budget: { maxJpy: 300, maxMinutes: 60 },
    confirmed: true,
    work: async ({ instance, signal }) => {
      assert.equal(signal.aborted, false);
      return { files: [`/workspace/${instance.instanceId}/cut-01.mp4`] };
    },
    ...quick,
  });
  assert.equal(report.status, "completed");
  assert.deepEqual(mock.log.map(([kind]) => kind), ["start", "collect", "stop"]);
  assert.equal(report.outputs.length, 1);
  assert.equal(report.stop.verified, true);
  assert.equal(report.stop.finalState, "stopped");
  assert.equal(report.storage.monthlyJpy, 300);
  assert.ok(report.alerts.some((alert) => /保存/u.test(alert) && /消さない/u.test(alert)));
  assert.equal(report.cap.limitedBy, "time");
});

test("借り GPU: 失敗しても時間の上限でも必ず止める。上限は現金からも決まる", async () => {
  const failing = mockRunpod();
  const failed = await runRentedGpuJob({ provider: failing.provider, spec: { hourlyJpy: 120 }, budget: { maxJpy: 300, maxMinutes: 60 }, confirmed: true, work: async () => { throw new Error("OOM"); }, ...quick });
  assert.equal(failed.status, "failed");
  assert.equal(failed.stop.verified, true);
  assert.ok(failing.log.some(([kind]) => kind === "stop"));

  const cap = rentedGpuRunCap({ hourlyJpy: 600, maxJpy: 50, maxMinutes: 60 });
  assert.equal(cap.limitedBy, "cash");
  assert.equal(cap.capMinutes, 5);

  // 1分に満たない上限では始めない
  const slow = mockRunpod();
  await assert.rejects(
    runRentedGpuJob({ provider: slow.provider, spec: { hourlyJpy: 120 }, budget: { maxJpy: 1, maxMinutes: 60 }, confirmed: true, work: async () => null, ...quick }),
    { code: "rented-gpu-budget-too-small" },
  );
  assert.equal(slow.log.length, 0, "始めていない");

  const hanging = mockRunpod();
  const realNow = Date.now;
  const report = await runRentedGpuJob({
    provider: hanging.provider,
    spec: { hourlyJpy: 120 },
    budget: { maxJpy: 1000, maxMinutes: 1 },
    confirmed: true,
    now: (() => { let first = true; return () => { if (first) { first = false; return realNow() - 59_990; } return realNow(); }; })(),
    work: ({ signal }) => new Promise((resolveWork) => { signal.addEventListener("abort", () => resolveWork("aborted")); }),
    ...quick,
  });
  assert.equal(report.status, "time-capped");
  assert.equal(report.error.code, "rented-gpu-time-cap");
  assert.equal(report.stop.verified, true);
  assert.ok(hanging.log.some(([kind]) => kind === "stop"));
});

test("借り GPU: 確認が無い・単価が申告を超える・止まったと確かめられないときの扱い", async () => {
  const mock = mockRunpod();
  await assert.rejects(runRentedGpuJob({ provider: mock.provider, spec: { hourlyJpy: 120 }, budget: { maxJpy: 300, maxMinutes: 60 }, work: async () => null }), { code: "rented-gpu-not-confirmed" });
  assert.equal(mock.log.length, 0);

  const pricey = mockRunpod({ hourlyJpy: 500 });
  let worked = false;
  const above = await runRentedGpuJob({ provider: pricey.provider, spec: { hourlyJpy: 120 }, budget: { maxJpy: 300, maxMinutes: 60 }, confirmed: true, work: async () => { worked = true; }, ...quick });
  assert.equal(above.status, "failed");
  assert.equal(above.error.code, "rented-gpu-price-above-declared");
  assert.equal(worked, false);
  assert.equal(above.stop.verified, true);

  const stuck = mockRunpod({ stopWorks: false });
  const unverified = await runRentedGpuJob({ provider: stuck.provider, spec: { hourlyJpy: 120 }, budget: { maxJpy: 300, maxMinutes: 60 }, confirmed: true, work: async () => null, ...quick });
  assert.equal(unverified.stop.verified, false);
  assert.ok(unverified.alerts.some((alert) => /課金が続いている恐れ/u.test(alert) && /今すぐ/u.test(alert)));
});

test("Runpod の形のプロバイダは鍵を環境変数から読み、出力に出さない（通信は偽物）", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, auth: init.headers?.authorization });
    if (init.method === "POST" && String(url).endsWith("/pods")) return jsonResponse({ id: "abc", costPerHr: 0.8, desiredStatus: "RUNNING" });
    if (init.method === "POST" && String(url).endsWith("/stop")) return jsonResponse({}, 200);
    if (init.method === "GET" && String(url).endsWith("/pods/abc")) return jsonResponse({ id: "abc", desiredStatus: calls.some((call) => call.url.endsWith("/stop")) ? "EXITED" : "RUNNING", volumeInGb: 10 });
    return jsonResponse({}, 404);
  };
  const provider = createRunpodProvider({ fetchImpl, env: { RUNPOD_API_KEY: "test-key-not-real" }, jpyPerUsd: 150, stoppedPodVolumeJpyPerGiBMonth: 30 });
  const report = await runRentedGpuJob({ provider, spec: { hourlyJpy: 150, pod: { gpuTypeIds: ["NVIDIA L4"] } }, budget: { maxJpy: 300, maxMinutes: 30 }, confirmed: true, work: async () => null, ...quick });
  assert.equal(report.status, "completed");
  assert.equal(report.stop.verified, true);
  assert.equal(report.storage.monthlyJpy, 300);
  assert.ok(!JSON.stringify(report).includes("test-key-not-real"), "鍵を記録に出さない");
  await assert.rejects(createRunpodProvider({ fetchImpl, env: {} }).start({ pod: {} }), { code: "rented-gpu-credentials-missing" });
});

test("上限（429）: 本番の経路が上限の間は予備で下書きだけを作り、本番は待ちに積んで空いたら作り直す", async () => {
  let clock = 1_000;
  let limited = true;
  const primaryCalls = [];
  const primary = { id: "gpt-image@codex", generate: async (request) => { primaryCalls.push(request.id); if (limited) throw Object.assign(new Error("usage limit reached"), { status: 429, retryAfterSeconds: 60 }); return { path: `final-${request.id}.png` }; } };
  const backup = { id: "flux2-klein-4b@mac", generate: async (request) => ({ path: `draft-${request.id}.png` }) };
  const router = createRateLimitFallbackRouter({ primary, backup, now: () => clock });

  const first = await router.generate({ id: "cut-01" }, { purpose: "final" });
  assert.equal(first.status, "draft-while-limited");
  assert.equal(first.output.draft, true);
  assert.equal(first.output.finalEligible, false);
  assert.equal(first.output.producedBy, "flux2-klein-4b@mac");
  const second = await router.generate({ id: "cut-02" }, { purpose: "final" });
  assert.equal(second.status, "draft-while-limited");
  assert.deepEqual(primaryCalls, ["cut-01"], "上限の間は本番の経路を叩き続けない");
  assert.throws(() => assertFinalOutputs([first.output]), { code: "draft-not-final" });

  const early = await router.resumePending();
  assert.deepEqual(early.stillPending, ["cut-01", "cut-02"]);
  clock += 61_000;
  limited = false;
  const resumed = await router.resumePending();
  assert.deepEqual(resumed.resumed.map((row) => row.id), ["cut-01", "cut-02"]);
  assert.equal(resumed.stillPending.length, 0);
  assert.equal(assertFinalOutputs(resumed.resumed.map((row) => row.output)), true);
  const fresh = await router.generate({ id: "cut-03" }, { purpose: "final" });
  assert.equal(fresh.status, "final");
  assert.equal(fresh.output.finalEligible, true);
});

test("上限以外の失敗は下書きで隠さない。429 の見分け方", async () => {
  const router = createRateLimitFallbackRouter({
    primary: { id: "p", generate: async () => { throw Object.assign(new Error("content policy"), { status: 400 }); } },
    backup: { id: "b", generate: async () => { throw new Error("呼ばれてはいけない"); } },
  });
  await assert.rejects(router.generate({ id: "cut-01" }), /content policy/u);
  assert.equal(isRateLimitError({ status: 429 }), true);
  assert.equal(isRateLimitError({ code: "usage_limit" }), true);
  assert.equal(isRateLimitError(new Error("ChatGPT の利用上限に達しました")), true);
  assert.equal(isRateLimitError(new Error("timeout")), false);
  assert.throws(() => createRateLimitFallbackRouter({ primary: { id: "p", generate: async () => ({}) } }), { code: "fallback-backup-missing" });
});

test("手渡し（Flow / Veo）: 手順書と取り込み口を作り、置かれた動画を SHA-256 で取り込む。画面は操作しない", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "manual-handoff-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cuts = [
    { cutId: "cut-01", prompt: "夜の海辺を歩く2人、ゆっくり寄る", startFramePath: join(dir, "cut-01.png"), durationSeconds: 8, aspect: "16:9" },
    { cutId: "cut-02", prompt: "古い神殿の内部、松明が揺れる", durationSeconds: 6 },
  ];
  const created = await createManualHandoff({ service: "google-flow", cuts, workDir: dir, handoffId: "ep-01", channelId: "myth-docs" });
  const sheet = await readFile(created.instructionsPath, "utf8");
  assert.match(sheet, /画面を操作しない/u);
  assert.match(sheet, /https:\/\/labs\.google\/fx\/tools\/flow/u);
  assert.match(sheet, /夜の海辺を歩く2人/u);
  assert.ok(sheet.includes(created.slotPath), "取り込みのコマンドは実際のパスで埋まっている");
  assert.doesNotMatch(sheet, /<[a-z名前]+>/u, "<...> の穴を残さない");
  assert.equal(created.slot.automation, "none");
  await assert.rejects(createManualHandoff({ service: "google-flow", cuts, workDir: dir, handoffId: "ep-01" }), { code: "handoff-exists" });

  await writeFile(join(created.importDir, "cut-01.mp4"), Buffer.from("fake-mp4-bytes"));
  const partial = await importManualHandoff({ slotPath: created.slotPath });
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.missing, ["cut-02"]);
  assert.equal(partial.imported[0].sha256, createHash("sha256").update("fake-mp4-bytes").digest("hex"));
  assert.equal(partial.imported[0].route, "manual-handoff");

  await writeFile(join(created.importDir, "cut-02.mov"), Buffer.from("mov"));
  await writeFile(join(created.importDir, "cut-02.mp4"), Buffer.from("mp4"));
  const ambiguous = await importManualHandoff({ slotPath: created.slotPath });
  assert.equal(ambiguous.complete, false);
  assert.equal(ambiguous.problems[0].code, "handoff-ambiguous");

  const cli = await runOptimalConfigCommand(["handoff-import", "--slot", created.slotPath]);
  assert.equal(cli.ok, true);
  assert.equal(cli.problems.length, 1);
});

test("local-image-check は手元の Ollama を読むだけ（偽物の fetch）", async () => {
  const fake = fakeOllama();
  const output = await runOptimalConfigCommand(["local-image-check", "--model", "flux2-klein-4b"], { fetchImpl: fake.fetchImpl });
  assert.equal(output.available, true);
  assert.deepEqual(fake.calls.map((call) => new URL(call.url).pathname), ["/api/version", "/api/tags"]);
});
