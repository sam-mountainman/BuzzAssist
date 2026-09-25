import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MACHINE_SLOT_LEASES_ENV,
  MACHINE_SLOT_WAIT_TIMEOUT_CODE,
  acquireMachineSlot,
  inspectMachinePool,
  machineLockRoot,
  machinePoolDir,
  machinePoolLimit,
  machineSlotLeaseEnv,
  releaseMachineSlot,
  resolveBuzzassistStateDir,
  tryAcquireMachineSlot,
} from "../lib/machineSlots.mjs";

function stateEnv(t, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "machine-slots-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { BUZZASSIST_STATE_DIR: join(root, "state"), ...extra };
}

function deadPid() {
  // 終わったプロセスの PID（試験の間に使い回される可能性は、心拍の判定とは別に無視できる）。
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

test("置き場は BUZZASSIST_STATE_DIR、無ければ ~/.buzzassist、試験の実行中は一時ディレクトリ", () => {
  assert.equal(machineLockRoot({ BUZZASSIST_STATE_DIR: join(tmpdir(), "custom-state") }), join(tmpdir(), "custom-state", "locks"));
  assert.equal(resolveBuzzassistStateDir({}), join(os.homedir(), ".buzzassist"));
  assert.equal(resolveBuzzassistStateDir({ NODE_TEST_CONTEXT: "child-v8" }), join(tmpdir(), "buzzassist-test-state"), "試験は本物の HOME へ書かない");
});

test("枠の上限は種類ごとの既定値で、環境変数で端末ごとに変えられる", () => {
  assert.equal(machinePoolLimit("paid-speech", {}), 4);
  assert.equal(machinePoolLimit("paid-image", {}), 16);
  assert.equal(machinePoolLimit("paid-speech", { BUZZASSIST_MACHINE_SLOTS_PAID_SPEECH: "2" }), 2);
  assert.throws(() => machinePoolLimit("paid-speech", { BUZZASSIST_MACHINE_SLOTS_PAID_SPEECH: "0" }), /1 以上の整数/u);
  assert.throws(() => machinePoolLimit("paid-video", {}), /未知の枠/u);
});

test("上限まで取ったら次は取れず、放せば取れる", (t) => {
  const env = stateEnv(t, { BUZZASSIST_MACHINE_SLOTS_PAID_SPEECH: "2" });
  const first = tryAcquireMachineSlot("paid-speech", { env });
  const second = tryAcquireMachineSlot("paid-speech", { env });
  assert.ok(first && second);
  assert.notEqual(first.index, second.index);
  assert.equal(tryAcquireMachineSlot("paid-speech", { env }), null);
  assert.equal(inspectMachinePool("paid-speech", { env }).occupied, 2);
  assert.equal(releaseMachineSlot(first), true);
  const third = tryAcquireMachineSlot("paid-speech", { env });
  assert.ok(third);
  releaseMachineSlot(second);
  releaseMachineSlot(third);
  assert.equal(inspectMachinePool("paid-speech", { env }).occupied, 0);
});

test("持ち主のプロセスが死んだ枠は PID の生存確認で回収する", (t) => {
  const env = stateEnv(t, { BUZZASSIST_MACHINE_SLOTS_PAID_SPEECH: "1" });
  const dir = machinePoolDir("paid-speech", env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "slot-0.json"), JSON.stringify({ pool: "paid-speech", index: 0, pid: deadPid(), host: os.hostname(), token: "dead-owner" }));
  assert.equal(inspectMachinePool("paid-speech", { env }).slots[0].abandoned, true);
  const handle = tryAcquireMachineSlot("paid-speech", { env });
  assert.ok(handle, "死んだ持ち主の枠を回収して取れる");
  releaseMachineSlot(handle);
});

test("生きている持ち主の枠は奪わず、心拍が止まって久しい枠（PID の使い回し）は回収する", (t) => {
  const env = stateEnv(t, { BUZZASSIST_MACHINE_SLOTS_PAID_SPEECH: "1" });
  const dir = machinePoolDir("paid-speech", env);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "slot-0.json");
  writeFileSync(file, JSON.stringify({ pool: "paid-speech", index: 0, pid: process.pid, host: os.hostname(), token: "live-owner" }));
  assert.equal(tryAcquireMachineSlot("paid-speech", { env }), null, "生きている持ち主の枠は奪わない");
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(file, old, old);
  const handle = tryAcquireMachineSlot("paid-speech", { env });
  assert.ok(handle, "心拍が止まって久しい枠は回収する");
  releaseMachineSlot(handle);
});

test("回収されて他人が取り直した枠を、元の持ち主の解放で消さない", (t) => {
  const env = stateEnv(t, { BUZZASSIST_MACHINE_SLOTS_PAID_SPEECH: "1" });
  const stale = tryAcquireMachineSlot("paid-speech", { env });
  // 持ち主が止まっていた間に回収され、別の持ち主が取り直した状態を作る。
  writeFileSync(stale.file, JSON.stringify({ pool: "paid-speech", index: 0, pid: process.pid, host: os.hostname(), token: "someone-else" }));
  assert.equal(releaseMachineSlot(stale), false, "印が違う枠は消さない");
  assert.ok(existsSync(stale.file));
});

test("待っても空かなければ理由コードつきで失敗し、課金していないことを示す", async (t) => {
  const env = stateEnv(t, { BUZZASSIST_MACHINE_SLOTS_PAID_SPEECH: "1" });
  const held = tryAcquireMachineSlot("paid-speech", { env });
  await assert.rejects(
    () => acquireMachineSlot("paid-speech", { env, waitTimeoutMs: 60, pollMs: 10 }),
    (error) => error.code === MACHINE_SLOT_WAIT_TIMEOUT_CODE && error.charged === false,
  );
  releaseMachineSlot(held);
});

test("親から受け継いだ枠は、上限が埋まっていても子が使え、解放しても消さない", (t) => {
  const env = stateEnv(t, { BUZZASSIST_MACHINE_SLOTS_PAID_SPEECH: "1" });
  const parent = tryAcquireMachineSlot("paid-speech", { env });
  const childEnv = { ...env, ...machineSlotLeaseEnv([parent]) };
  assert.ok(childEnv[MACHINE_SLOT_LEASES_ENV]);
  const lease = tryAcquireMachineSlot("paid-speech", { env: childEnv });
  assert.equal(lease?.inherited, true);
  assert.equal(tryAcquireMachineSlot("paid-speech", { env: childEnv }), null, "受け継いだ枠は同時に1本だけ");
  releaseMachineSlot(lease);
  assert.ok(existsSync(parent.file), "子の解放で親の枠を消さない");
  assert.equal(tryAcquireMachineSlot("paid-speech", { env: childEnv })?.inherited, true, "空きに戻れば再び使える");
  releaseMachineSlot(parent);
});
