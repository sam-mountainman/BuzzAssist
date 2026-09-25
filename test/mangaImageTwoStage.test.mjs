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
  // 偽の外部呼び出しが始まった・終わった順の記録。所要時間を壁時計でなくこの順序から出す（logicalMakespan）。
  const timeline = [];
  let nextCallId = 0;
  const generateImage = async (input) => {
    const run = async () => {
      const id = (nextCallId += 1);
      timeline.push({ stage: "generation", phase: "start", id });
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
        timeline.push({ stage: "generation", phase: "end", id });
      }
    };
    // 本物の生成器（generateImageMedia）と同じく、端末全体の paid-image の枠の中で呼ぶ。
    return env ? withMachineSlot("paid-image", run, { env, pollMs: 5 }) : run();
  };
  const visualQa = async ({ job, attempt }) => {
    const id = (nextCallId += 1);
    timeline.push({ stage: "qa", phase: "start", id });
    counters.qa += 1;
    counters.peakQa = Math.max(counters.peakQa, counters.qa);
    try {
      await sleep(qaMs);
      const index = Number(job.id.split(":")[1]);
      if (failFirstQa.has(index) && attempt === 0) return { pass: false, issues: ["fixture: pose repeats the previous frame"] };
      return { pass: true, issues: [] };
    } finally {
      counters.qa -= 1;
      timeline.push({ stage: "qa", phase: "end", id });
    }
  };
  return { generateImage, visualQa, counters, timeline };
}

/**
 * 呼び出しの記録（始まり・終わりの順序だけ）から、どの呼び出しも名目の時間ちょうどで終わったとしたときの
 * 全体の所要時間を出す。ある呼び出しは「それが始まる前に終わった呼び出し」のうち、名目で最も遅く終わるものの
 * 直後に始まったとみなす（記録の順序が作る前後関係の最長経路）。
 * 壁時計は使わないので、共有ランナーの負荷やタイマーの粒度で遅れた分は値に入らない。枠の受け渡し・生成の
 * あとの QA・QA に落ちたあとの作り直しのような本当の待ちは必ず記録の順序に出るので、負荷で順序がずれても、
 * 値がその待ちの最長経路より短くなることはない（負荷で出入りするのは、たまたまの前後関係だけ）。
 * 1本ずつ順に呼べば全部が一本につながり、値は全部の呼び出しの合計になる。
 */
function logicalMakespan(timeline, durations) {
  const nominalEnd = new Map();
  let finished = 0; // ここまでに終わった呼び出しの、名目の終わりの最大
  for (const event of timeline) {
    if (event.phase === "start") {
      nominalEnd.set(event.id, finished + durations[event.stage]);
    } else {
      assert.ok(nominalEnd.has(event.id), `始まりの無い終わり: ${event.stage} #${event.id}`);
      finished = Math.max(finished, nominalEnd.get(event.id));
      nominalEnd.delete(event.id);
    }
  }
  assert.equal(nominalEnd.size, 0, "終わっていない呼び出しが残っている");
  return finished;
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
  const durations = { generation: 30, qa: 30 };
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
    const { generateImage, visualQa, counters, timeline } = fakes({
      failFirstQa,
      generationMs: durations.generation,
      qaMs: durations.qa,
    });
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
      timeline,
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
  // 所要時間: 生成30ms・QA30ms × 7回（1回は作り直し）。直列は420ms、重ねると約240ms、生成3・QA2 なら約150ms。
  // 壁時計では比べない。偽物の待ちは30msずつだが、PNG の描画・保存・技術 QA は同じスレッドの CPU 仕事で重ならず、
  // 負荷の高い共有ランナーではそちらが待ちより長くなる。Windows ではタイマーの粒度（15ms刻み）で差が出ず
  // （2026-09-25、serial=636ms overlapped=628ms）、macOS の CI では逆転した（Node 22 で serial=703ms
  // overlapped=855ms、Node 20 では parallel の比較で落ちた）。2段化が縮めるのは外部呼び出し（生成・QA）を
  // 待つ時間なので、偽物が記録した呼び出しの順序から名目の所要時間を出し、それを比べる。
  const makespan = Object.fromEntries(Object.entries(runs).map(([name, run]) => [name, logicalMakespan(run.timeline, durations)]));
  const calls = (timeline, stage) => timeline.filter((event) => event.stage === stage && event.phase === "start").length;
  const totalWork = (timeline) => calls(timeline, "generation") * durations.generation + calls(timeline, "qa") * durations.qa;
  // 偽物が数えた生成の回数は、台帳の有料の生成回数（summary.attempts、生成7回）と一致する。
  assert.equal(calls(runs.serial.timeline, "generation"), runs.serial.summary.attempts);
  // 直列は1本ずつ順に呼ぶので、名目の所要時間は全部の呼び出しの合計にちょうど一致する。
  assert.equal(makespan.serial, totalWork(runs.serial.timeline), "直列はどの呼び出しも重ならない");
  for (const name of ["overlapped", "parallel"]) {
    assert.equal(totalWork(runs[name].timeline), totalWork(runs.serial.timeline), `${name}: 呼び出しの量は直列と同じ`);
    assert.ok(
      makespan[name] < makespan.serial * 0.85,
      `${name}: 名目の所要時間が直列より短い（serial=${makespan.serial}ms ${name}=${makespan[name]}ms）`,
    );
  }
  // 壁時計は記録だけにする（負荷とタイマーの粒度で上の比較と食い違うことがある）。
  t.diagnostic(`壁時計: serial=${runs.serial.elapsedMs}ms overlapped=${runs.overlapped.elapsedMs}ms parallel=${runs.parallel.elapsedMs}ms`);
  t.diagnostic(`名目の所要時間: serial=${makespan.serial}ms overlapped=${makespan.overlapped}ms parallel=${makespan.parallel}ms`);
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
