// 画像の枠の2段化（生成の枠と QA の枠を分ける）の試験。
// 有料の生成器と QA は偽物で、課金・モデル呼び出しは起きない。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AdaptiveConcurrencyController, runWithAdaptiveConcurrency } from "../lib/adaptiveConcurrency.mjs";
import { withMachineSlot } from "../lib/machineSlots.mjs";
import { executeMangaScriptImagePlan, renderEditorialPlatePng } from "../lib/mangaScriptImagePipeline.mjs";

const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function plan(root, count = 6) {
  return {
    version: 1,
    episodeId: "two-stage-fixture",
    scriptSha256: "fixture-script",
    assetDir: root,
    jobs: Array.from({ length: count }, (_, index) => ({
      id: `image:${index + 1}`,
      kind: "scene-image",
      dependencies: [],
      outputPath: path.join(root, `image-${index + 1}.png`),
      prompt: `scene ${index + 1}`,
      referenceImagePaths: [],
      model: "fake",
      aspectRatio: "16:9",
      imageSize: "2K",
      quality: "high",
      imageCount: 1,
      inputHash: `hash-${index + 1}`,
    })),
  };
}

/** 生成器・QA の偽物。出力は入力（何枚目か・修正の回か）だけで決まる。 */
function fakes({ generationMs = 30, qaMs = 30, failFirstQa = new Set(), failGeneration = new Set(), env = null } = {}) {
  const counters = { generation: 0, qa: 0, peakGeneration: 0, peakQa: 0, calls: 0 };
  const generateImage = async (input) => {
    const run = async () => {
      counters.generation += 1;
      counters.calls += 1;
      counters.peakGeneration = Math.max(counters.peakGeneration, counters.generation);
      try {
        await sleep(generationMs);
        const index = Number(String(input.fileName).match(/\d+/u)?.[0] || 1);
        if (failGeneration.has(index)) throw new Error(`fixture provider rejected image ${index}`);
        const correction = /CORRECTION PASS/u.test(input.prompt) ? 20 : 0;
        const k = 20 + index + correction;
        return { buffer: renderEditorialPlatePng("pastel-sky", 16 * k, 9 * k), fileName: input.fileName, mimeType: "image/png" };
      } finally {
        counters.generation -= 1;
      }
    };
    // 本物の生成器（generateImageMedia）と同じく、端末全体の paid-image の枠の中で呼ぶ。
    return env ? withMachineSlot("paid-image", run, { env, pollMs: 5 }) : run();
  };
  const visualQa = async ({ job, attempt }) => {
    counters.qa += 1;
    counters.peakQa = Math.max(counters.peakQa, counters.qa);
    try {
      await sleep(qaMs);
      const index = Number(job.id.split(":")[1]);
      if (failFirstQa.has(index) && attempt === 0) return { pass: false, issues: ["fixture: pose repeats the previous frame"] };
      return { pass: true, issues: [] };
    } finally {
      counters.qa -= 1;
    }
  };
  return { generateImage, visualQa, counters };
}

async function outputDigests(root, count) {
  const rows = {};
  for (let index = 1; index <= count; index += 1) {
    try {
      rows[`image:${index}`] = sha256(await readFile(path.join(root, `image-${index}.png`)));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      rows[`image:${index}`] = null;
    }
  }
  return rows;
}

function verdicts(ledger) {
  return Object.fromEntries(Object.entries(ledger.jobs).map(([id, state]) => [id, {
    status: state.status,
    retries: state.retries,
    qaPass: state.qa?.pass ?? null,
  }]));
}

test("a job that releases its slot lets the next job start, and a reacquire waits for a free slot first", async () => {
  const controller = new AdaptiveConcurrencyController({ mode: "fixed", fixedLimit: 1 });
  const order = [];
  let holdingPeak = 0;
  let holdingNow = 0;
  const job = (name, { qaMs = 20, correct = false } = {}) => async (slot) => {
    holdingNow += 1;
    holdingPeak = Math.max(holdingPeak, holdingNow);
    order.push(`${name}:generate`);
    await sleep(10);
    holdingNow -= 1;
    slot.release();
    order.push(`${name}:qa`);
    await sleep(qaMs);
    if (correct) {
      await slot.reacquire();
      holdingNow += 1;
      holdingPeak = Math.max(holdingPeak, holdingNow);
      order.push(`${name}:regenerate`);
      await sleep(10);
      holdingNow -= 1;
    }
    return name;
  };
  const results = await runWithAdaptiveConcurrency([job("a", { correct: true }), job("b"), job("c")], controller);
  assert.deepEqual(results.map((entry) => entry.value), ["a", "b", "c"]);
  assert.equal(holdingPeak, 1, "生成の枠（上限1）を越えない");
  assert.ok(order.indexOf("b:generate") < order.indexOf("a:regenerate"), "a の QA の間に b の生成が始まる");
});

test("a pool whose jobs never release keeps the old one-slot-per-job behaviour", async () => {
  const controller = new AdaptiveConcurrencyController({ mode: "fixed", fixedLimit: 2 });
  let active = 0;
  let peak = 0;
  const results = await runWithAdaptiveConcurrency(Array.from({ length: 6 }, (_, index) => async () => {
    active += 1;
    peak = Math.max(peak, active);
    await sleep(5);
    active -= 1;
    return index;
  }), controller);
  assert.equal(peak, 2);
  assert.deepEqual(results.map((entry) => entry.value), [0, 1, 2, 3, 4, 5]);
});

test("two-stage slots give the same artifacts and verdicts as the serial run, and finish sooner", async (t) => {
  const count = 6;
  const failFirstQa = new Set([3]);
  const runs = {};
  for (const [name, options] of Object.entries({
    // 従来の形: 1本が生成から QA まで枠を持つ（生成1・QA1、重ねない）
    serial: { concurrency: 1, qaConcurrency: 1, stageOverlap: false },
    // 生成1・QA1 のまま、QA を待つ間に次の生成を進める
    overlapped: { concurrency: 1, qaConcurrency: 1 },
    // 生成3・QA2
    parallel: { concurrency: 3, qaConcurrency: 2 },
  })) {
    const root = await mkdtemp(path.join(tmpdir(), `buzzassist-two-stage-${name}-`));
    const { generateImage, visualQa, counters } = fakes({ failFirstQa });
    const events = [];
    const startedAt = Date.now();
    const result = await executeMangaScriptImagePlan(plan(root, count), {
      ...options,
      maxRetries: 1,
      generateImage,
      visualQa,
      onStageEvent: (event) => events.push(event),
    });
    runs[name] = {
      elapsedMs: Date.now() - startedAt,
      digests: await outputDigests(root, count),
      verdicts: verdicts(result.ledger),
      status: result.ledger.status,
      summary: result.ledger.summary,
      counters,
      events,
    };
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(runs.serial.status, "complete");
  for (const name of ["overlapped", "parallel"]) {
    assert.deepEqual(runs[name].digests, runs.serial.digests, `${name}: 成果物の sha256 が直列と同じ`);
    assert.deepEqual(runs[name].verdicts, runs.serial.verdicts, `${name}: 合否と作り直しの回数が直列と同じ`);
    assert.equal(runs[name].status, runs.serial.status);
    assert.equal(runs[name].summary.attempts, runs.serial.summary.attempts, `${name}: 有料の生成回数が直列と同じ`);
  }
  assert.equal(runs.serial.verdicts["image:3"].retries, 1, "QA に落ちた1枚だけを作り直している");
  // 生成の同時数は上限（チャンネル）を越えない。QA も QA の枠を越えない。
  assert.equal(runs.serial.counters.peakGeneration, 1);
  assert.equal(runs.overlapped.counters.peakGeneration, 1);
  assert.equal(runs.overlapped.counters.peakQa, 1);
  assert.ok(runs.parallel.counters.peakGeneration <= 3);
  assert.ok(runs.parallel.counters.peakQa <= 2);
  assert.equal(runs.parallel.summary.stagePipeline.peakGeneration <= 3, true);
  assert.equal(runs.overlapped.summary.stagePipeline.releaseSlotForQa, true);
  assert.equal(runs.serial.summary.stagePipeline.releaseSlotForQa, false);
  // 重ねた回だけ、ある画の QA の最中に別の画の生成が走っている。
  const overlapSeen = (events) => {
    let generating = 0;
    let qa = 0;
    let seen = false;
    for (const event of events) {
      if (event.stage === "generation") generating += event.phase === "start" ? 1 : -1;
      else qa += event.phase === "start" ? 1 : -1;
      if (generating > 0 && qa > 0) seen = true;
    }
    return seen;
  };
  assert.equal(overlapSeen(runs.serial.events), false);
  assert.equal(overlapSeen(runs.overlapped.events), true);
  // 所要時間: 生成30ms・QA30ms × 7回（1回は作り直し）。直列は約420ms、重ねると約240ms。
  // 重なったことは上の overlapSeen で確かめている。壁時計の比較は、タイマーの粒度が粗い Windows の CI
  // （setTimeout が 15ms 刻み）では差が出ない回があった（2026-09-25、serial=636ms overlapped=628ms）。
  // Windows では記録だけにし、ほかの OS では短くなることまで見る。
  const shorter = runs.overlapped.elapsedMs < runs.serial.elapsedMs * 0.85;
  const timingNote = `重ねた回が直列より短い（serial=${runs.serial.elapsedMs}ms overlapped=${runs.overlapped.elapsedMs}ms）`;
  if (process.platform === "win32") {
    if (!shorter) t.diagnostic(`${timingNote}: Windows のタイマーの粒度で差が出なかった`);
  } else {
    assert.ok(shorter, timingNote);
  }
  assert.ok(runs.parallel.elapsedMs < runs.serial.elapsedMs * 0.85);
});

test("generation stays within the smaller of the machine-wide paid-image slots and the channel limit", async () => {
  for (const [machineLimit, channelLimit, expectedPeak] of [[2, 4, 2], [8, 3, 3]]) {
    const stateDir = await mkdtemp(path.join(tmpdir(), "buzzassist-two-stage-slots-"));
    const env = { BUZZASSIST_STATE_DIR: stateDir, BUZZASSIST_MACHINE_SLOTS_PAID_IMAGE: String(machineLimit) };
    const root = await mkdtemp(path.join(tmpdir(), "buzzassist-two-stage-slot-run-"));
    const { generateImage, visualQa, counters } = fakes({ env, generationMs: 25, qaMs: 5 });
    const result = await executeMangaScriptImagePlan(plan(root, 8), {
      concurrency: channelLimit,
      qaConcurrency: 2,
      maxRetries: 0,
      generateImage,
      visualQa,
    });
    assert.equal(result.ledger.status, "complete");
    assert.equal(counters.peakGeneration, expectedPeak, `machine=${machineLimit} channel=${channelLimit}`);
    // 枠は全部返っている
    const leftover = await readdir(path.join(stateDir, "locks", "slots", "paid-image")).catch(() => []);
    assert.deepEqual(leftover.filter((name) => name.startsWith("slot-")), []);
    await rm(root, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("one failed generation leaves no half-written state for the other images", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "buzzassist-two-stage-failure-"));
  const { generateImage, visualQa } = fakes({ failGeneration: new Set([2]) });
  const result = await executeMangaScriptImagePlan(plan(root, 5), {
    concurrency: 2,
    qaConcurrency: 1,
    maxRetries: 0,
    generateImage,
    visualQa,
  });
  assert.equal(result.ledger.status, "failed");
  assert.equal(result.ledger.jobs["image:2"].status, "failed");
  for (const id of ["image:1", "image:3", "image:4", "image:5"]) {
    assert.equal(result.ledger.jobs[id].status, "complete", `${id} は完成している`);
  }
  assert.equal(Object.values(result.ledger.jobs).some((state) => ["running", "waiting"].includes(state.status)), false);
  const files = await readdir(root);
  assert.equal(files.includes("image-2.png"), false, "失敗した画は出力の名前に残らない");
  assert.deepEqual(files.filter((name) => name.endsWith(".tmp")), [], "書きかけの一時ファイルが残らない");
  const persisted = JSON.parse(await readFile(result.ledgerPath, "utf8"));
  assert.equal(persisted.status, "failed");
  await rm(root, { recursive: true, force: true });
});
