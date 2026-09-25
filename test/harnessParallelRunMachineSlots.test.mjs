import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { executePlan, validatePlan } from "../scripts/harness-parallel-run.mjs";
import { releaseMachineSlot, tryAcquireMachineSlot } from "../lib/machineSlots.mjs";

// harness-parallel-run の並列数もプロセスごとで、別のセッションの有料生成と合算していなかった。
// 計画のジョブに slots（端末全体の枠の種類）を書けば、有料 API の呼び出し（broker・画像生成）と
// 同じ枠を数え、枠が空くまで待つ。取った枠は子へ渡し、子の中の有料呼び出しはそれを使う。

const machineSlotsUrl = pathToFileURL(join(import.meta.dirname, "..", "lib", "machineSlots.mjs")).href;

function withEnv(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function sleeper(ms) {
  return { command: process.execPath, args: ["-e", `setTimeout(() => {}, ${ms})`] };
}

test("計画の slots は既知の枠の種類だけを受け付ける", () => {
  const base = { id: "a", command: "node", args: [] };
  assert.deepEqual(validatePlan({ jobs: [{ ...base, slots: ["paid-speech"] }] }), []);
  assert.ok(validatePlan({ jobs: [{ ...base, slots: ["paid-video"] }] }).some((error) => /slots/u.test(error)));
  assert.ok(validatePlan({ jobs: [{ ...base, slots: "paid-speech" }] }).some((error) => /slots/u.test(error)));
});

test("slots を書いたジョブは、端末全体の枠の数までしか同時に走らない", { timeout: 60_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "parallel-run-slots-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  withEnv(t, { BUZZASSIST_STATE_DIR: join(root, "state"), BUZZASSIST_MACHINE_SLOTS_PAID_SPEECH: "1" });
  const plan = {
    jobs: ["a", "b", "c"].map((id) => ({ id, ...sleeper(300), slots: ["paid-speech"] })),
  };
  const summary = await executePlan(plan, { concurrency: 3, logDir: join(root, "logs") });
  assert.equal(summary.ok, true, JSON.stringify(summary.jobs));
  const spans = summary.jobs.map((job) => [job.startedAtMs, job.endedAtMs]).sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < spans.length; index += 1) {
    assert.ok(spans[index][0] >= spans[index - 1][1], `枠1つなのに重なって走った: ${JSON.stringify(spans)}`);
  }
});

test("別のセッションが枠を持っている間は待ち、放されたら走る", { timeout: 60_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "parallel-run-slots-held-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  withEnv(t, { BUZZASSIST_STATE_DIR: join(root, "state"), BUZZASSIST_MACHINE_SLOTS_PAID_SPEECH: "1" });
  const held = tryAcquireMachineSlot("paid-speech", { label: "another session" });
  assert.ok(held);
  const releasedAt = { ms: 0 };
  setTimeout(() => { releasedAt.ms = Date.now(); releaseMachineSlot(held); }, 700);
  const startedAt = Date.now();
  const summary = await executePlan({ jobs: [{ id: "waits", ...sleeper(50), slots: ["paid-speech"] }] }, {
    concurrency: 1,
    logDir: join(root, "logs"),
  });
  assert.equal(summary.ok, true);
  assert.ok(releasedAt.ms > 0, "枠が放される前に計画が終わった（待っていない）");
  assert.ok(startedAt + summary.jobs[0].startedAtMs >= releasedAt.ms, "枠が放される前に走った");
});

test("取った枠は子へ渡り、子の中の有料呼び出しは同じ枠を使う（親が持ったまま子が待ち続けない）", { timeout: 60_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "parallel-run-slots-lease-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  withEnv(t, { BUZZASSIST_STATE_DIR: join(root, "state"), BUZZASSIST_MACHINE_SLOTS_PAID_SPEECH: "1" });
  const script = join(root, "child.mjs");
  writeFileSync(script, [
    `import { acquireMachineSlot, releaseMachineSlot } from ${JSON.stringify(machineSlotsUrl)};`,
    "const handle = await acquireMachineSlot('paid-speech', { waitTimeoutMs: 5000, pollMs: 20 });",
    "process.stdout.write(JSON.stringify({ inherited: handle.inherited }));",
    "releaseMachineSlot(handle);",
  ].join("\n"));
  const summary = await executePlan({
    jobs: [{ id: "child", command: process.execPath, args: [script], slots: ["paid-speech"] }],
  }, { concurrency: 1, logDir: join(root, "logs") });
  assert.equal(summary.ok, true, readFileSync(summary.jobs[0].stderrPath, "utf8"));
  assert.deepEqual(JSON.parse(readFileSync(summary.jobs[0].stdoutPath, "utf8")), { inherited: true });
  assert.deepEqual(summary.jobs[0].slots, ["paid-speech"]);
});
