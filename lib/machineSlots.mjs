import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 端末全体で数える同時実行の枠（ファイルのセマフォ）。
 *
 * 並列の上限（有料の音声は同時 4 本など）はプロセスの中でしか数えていなかったので、
 * Claude Code と Codex のセッションが別々に音声生成を走らせると、端末全体では上限の何倍もの
 * 有料リクエストが同時に出ていた。枠は `<state>/locks/slots/<pool>/slot-<n>.json` の
 * ファイルで、`wx`（無ければ作る）で取るので、どのプロセスから取っても同じ数を数える。
 *
 * - 置き場は BUZZASSIST_STATE_DIR（既定 ~/.buzzassist）。試験の実行中（node --test が
 *   子へ NODE_TEST_CONTEXT を渡す）は、本物の HOME へ書かないよう一時ディレクトリにする
 * - 持ち主が死んだ枠は PID の生存確認（process.kill(pid, 0)。Windows でも動く）で回収する。
 *   PID が使い回された場合に備え、心拍（ファイルの更新時刻）が止まって久しい枠も回収する
 * - 枠の削除（解放・回収）は、プールごとの短い排他（mkdir）の中で持ち主の印を照合してから
 *   行う。照合せずに消すと、回収と同時に取り直された他人の枠を消してしまう
 * - harness-parallel-run が計画のジョブのために取った枠は、環境変数
 *   BUZZASSIST_MACHINE_SLOT_LEASES で子へ渡す。子の中の有料呼び出しはまずその枠を使うので、
 *   親が枠を持ったまま子が同じプールを待ち続けることは無い
 */

export const MACHINE_SLOTS_VERSION = "buzzassist-machine-slot-v1";
export const MACHINE_SLOT_LEASES_ENV = "BUZZASSIST_MACHINE_SLOT_LEASES";
export const MACHINE_SLOT_WAIT_TIMEOUT_CODE = "machine-slot-wait-timeout";

/** 枠の種類。上限は環境変数で端末ごとに変えられる（下げるのも上げるのも運営者の判断）。 */
export const MACHINE_SLOT_POOLS = Object.freeze({
  // Koya の台詞・読み上げの有料リクエストの上限（KOYA_PAID_SPEECH_REQUEST_CONCURRENCY_LIMIT）と同じ。
  "paid-speech": Object.freeze({ defaultLimit: 4, limitEnv: "BUZZASSIST_MACHINE_SLOTS_PAID_SPEECH", label: "有料の音声生成" }),
  // 画像生成の適応並列（lib/adaptiveConcurrency.mjs）の初期値と同じ。
  "paid-image": Object.freeze({ defaultLimit: 16, limitEnv: "BUZZASSIST_MACHINE_SLOTS_PAID_IMAGE", label: "有料の画像生成" }),
});

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_STALE_MS = 5 * 60_000;
const UNREADABLE_GRACE_MS = 10_000;
const MUTEX_STALE_MS = 10_000;
const MUTEX_TIMEOUT_MS = 5_000;

const inheritedLeases = new Map();
let inheritedLeasesParsedFrom = null;

export function resolveBuzzassistStateDir(env = process.env) {
  const configured = String(env.BUZZASSIST_STATE_DIR || "").trim();
  if (configured) return path.resolve(configured);
  // 試験は本物の ~/.buzzassist へ書かない。
  if (String(env.NODE_TEST_CONTEXT || "").trim()) return path.join(os.tmpdir(), "buzzassist-test-state");
  return path.join(os.homedir(), ".buzzassist");
}

export function machineLockRoot(env = process.env) {
  return path.join(resolveBuzzassistStateDir(env), "locks");
}

function assertPool(pool) {
  if (!Object.hasOwn(MACHINE_SLOT_POOLS, pool)) {
    throw new Error(`未知の枠の種類: ${pool}（使えるのは ${Object.keys(MACHINE_SLOT_POOLS).join(", ")}）`);
  }
}

export function machinePoolLimit(pool, env = process.env) {
  assertPool(pool);
  const spec = MACHINE_SLOT_POOLS[pool];
  const raw = String(env[spec.limitEnv] ?? "").trim();
  if (!raw) return spec.defaultLimit;
  if (!/^\d+$/u.test(raw) || Number(raw) < 1) {
    throw new Error(`${spec.limitEnv} は 1 以上の整数にすること: ${raw}`);
  }
  return Number(raw);
}

export function machinePoolDir(pool, env = process.env) {
  assertPool(pool);
  return path.join(machineLockRoot(env), "slots", pool);
}

/** 生きているか。Windows でも process.kill(pid, 0) は存在確認として動く。 */
export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withPoolMutex(dir, action, { isAlive = processIsAlive, now = Date.now } = {}) {
  const mutex = path.join(dir, ".mutex");
  const deadline = now() + MUTEX_TIMEOUT_MS;
  for (;;) {
    try {
      fs.mkdirSync(mutex);
      break;
    } catch (error) {
      // Windows では削除待ちの排他へ mkdir すると EPERM / EACCES が返る（一時的。lib/paidMediaJobBroker.mjs と同じ扱い）。
      if (process.platform === "win32" && (error?.code === "EPERM" || error?.code === "EACCES")) {
        if (now() > deadline) throw error;
        sleepSync(5);
        continue;
      }
      if (error?.code !== "EEXIST") throw error;
      // 排他の中は数ミリ秒で終わる。持ち主が死んでいる、または長く残っている排他は外す。
      let ownerPid = null;
      let age = 0;
      try { ownerPid = Number(fs.readFileSync(path.join(mutex, "pid"), "utf8").trim()); } catch { /* 書き込み前 */ }
      try { age = now() - fs.statSync(mutex).mtimeMs; } catch { continue; }
      if ((ownerPid && !isAlive(ownerPid)) || age > MUTEX_STALE_MS) {
        fs.rmSync(mutex, { recursive: true, force: true });
        continue;
      }
      if (now() > deadline) throw new Error(`枠の排他を取れない: ${mutex}`);
      sleepSync(5);
    }
  }
  try {
    try { fs.writeFileSync(path.join(mutex, "pid"), `${process.pid}\n`); } catch { /* 印が無くても排他は効く */ }
    return action();
  } finally {
    fs.rmSync(mutex, { recursive: true, force: true });
  }
}

function readSlot(file) {
  try {
    return { record: JSON.parse(fs.readFileSync(file, "utf8")), stat: fs.statSync(file) };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    let stat = null;
    try { stat = fs.statSync(file); } catch { return null; }
    return { record: null, stat };
  }
}

/** 残っている枠を回収してよいか（持ち主が死んだ、または心拍が止まって久しい）。 */
function slotAbandoned(slot, { isAlive = processIsAlive, now = Date.now } = {}) {
  if (!slot) return false;
  const heartbeatAge = now() - slot.stat.mtimeMs;
  if (!slot.record) return heartbeatAge > UNREADABLE_GRACE_MS;
  const sameHost = !slot.record.host || slot.record.host === os.hostname();
  if (sameHost && !isAlive(Number(slot.record.pid))) return true;
  return heartbeatAge > HEARTBEAT_STALE_MS;
}

function reclaimIfAbandoned(dir, file, options) {
  const observed = readSlot(file);
  if (!slotAbandoned(observed, options)) return false;
  return withPoolMutex(dir, () => {
    // 排他の中で読み直す。外で見た枠が、回収のあいだに取り直されているかもしれない。
    const current = readSlot(file);
    if (!current || !slotAbandoned(current, options)) return false;
    if (observed?.record?.token && current.record?.token !== observed.record.token) return false;
    fs.rmSync(file, { force: true });
    return true;
  }, options);
}

function parseInheritedLeases(env) {
  const raw = String(env[MACHINE_SLOT_LEASES_ENV] || "");
  if (raw === inheritedLeasesParsedFrom) return;
  inheritedLeasesParsedFrom = raw;
  inheritedLeases.clear();
  if (!raw) return;
  let rows = [];
  try { rows = JSON.parse(raw); } catch { return; }
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !Object.hasOwn(MACHINE_SLOT_POOLS, row.pool) || typeof row.file !== "string" || typeof row.token !== "string") continue;
    inheritedLeases.set(row.file, { pool: row.pool, file: row.file, token: row.token, busy: false });
  }
}

function tryInheritedLease(pool, env) {
  parseInheritedLeases(env);
  for (const lease of inheritedLeases.values()) {
    if (lease.pool !== pool || lease.busy) continue;
    // 親がまだその枠を持っていること（持ち主の印が同じ）を確かめてから使う。
    const current = readSlot(lease.file);
    if (current?.record?.token !== lease.token) continue;
    lease.busy = true;
    return { version: MACHINE_SLOTS_VERSION, pool, index: current.record.index, file: lease.file, token: lease.token, inherited: true };
  }
  return null;
}

/**
 * 空いている枠を1つ取る（待たない）。取れなければ null。
 */
export function tryAcquireMachineSlot(pool, {
  env = process.env,
  limit,
  label = "",
  isAlive = processIsAlive,
  now = Date.now,
  heartbeatMs = HEARTBEAT_INTERVAL_MS,
} = {}) {
  assertPool(pool);
  const inherited = tryInheritedLease(pool, env);
  if (inherited) return inherited;
  const dir = machinePoolDir(pool, env);
  fs.mkdirSync(dir, { recursive: true });
  const max = limit ?? machinePoolLimit(pool, env);
  for (let index = 0; index < max; index += 1) {
    const file = path.join(dir, `slot-${index}.json`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = randomUUID();
      const record = {
        version: MACHINE_SLOTS_VERSION,
        pool,
        index,
        pid: process.pid,
        host: os.hostname(),
        token,
        label: String(label || "").slice(0, 200),
        acquiredAt: new Date(now()).toISOString(),
      };
      let fd;
      try {
        fd = fs.openSync(file, "wx");
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (attempt === 0 && reclaimIfAbandoned(dir, file, { isAlive, now })) continue;
        break;
      }
      try {
        fs.writeSync(fd, `${JSON.stringify(record)}\n`);
      } finally {
        fs.closeSync(fd);
      }
      const timer = setInterval(() => {
        try {
          const stamp = new Date();
          fs.utimesSync(file, stamp, stamp);
        } catch { /* 解放済み */ }
      }, heartbeatMs);
      timer.unref?.();
      return { version: MACHINE_SLOTS_VERSION, pool, index, file, token, inherited: false, timer };
    }
  }
  return null;
}

/** 自分の枠だけを返す。親から受け継いだ枠は消さずに「空き」に戻す。 */
export function releaseMachineSlot(handle) {
  if (!handle) return false;
  if (handle.inherited) {
    const lease = inheritedLeases.get(handle.file);
    if (lease && lease.token === handle.token) lease.busy = false;
    return true;
  }
  clearInterval(handle.timer);
  const dir = path.dirname(handle.file);
  if (!fs.existsSync(dir)) return false;
  return withPoolMutex(dir, () => {
    const current = readSlot(handle.file);
    if (current?.record?.token !== handle.token) return false; // もう自分の枠ではない
    fs.rmSync(handle.file, { force: true });
    return true;
  });
}

/**
 * 枠が空くまで待って取る。待ち時間の上限を過ぎたら理由コードつきで失敗する（有料の呼び出しは
 * まだ送っていないので、課金は起きていない）。
 */
export async function acquireMachineSlot(pool, {
  waitTimeoutMs = 60 * 60_000,
  pollMs = 250,
  signal,
  onWait,
  // 待つ間の時計は unref しない（待っている間にプロセスが「することが無い」として終わってしまう）。
  sleep = (ms) => new Promise((done) => { setTimeout(done, ms); }),
  ...options
} = {}) {
  const now = options.now ?? Date.now;
  const startedAt = now();
  let reported = false;
  for (;;) {
    // 空いていれば中断の印に関わらず取る。中断の扱いは呼び出し側の本来の経路に任せ、
    // ここで判定するのは「待っている間の中断」だけ。
    const handle = tryAcquireMachineSlot(pool, options);
    if (handle) return handle;
    if (signal?.aborted) {
      const error = new Error(`${pool} の枠を待つ間に中断された。有料の呼び出しは送っていない。`);
      error.name = "AbortError";
      error.charged = false;
      throw error;
    }
    if (now() - startedAt >= waitTimeoutMs) {
      const error = new Error(
        `${MACHINE_SLOT_WAIT_TIMEOUT_CODE}: 端末全体の ${MACHINE_SLOT_POOLS[pool].label}の枠（${machinePoolLimit(pool, options.env)}）が`
        + ` ${Math.round(waitTimeoutMs / 1000)} 秒空かなかった。有料の呼び出しは送っていない。`,
      );
      error.code = MACHINE_SLOT_WAIT_TIMEOUT_CODE;
      error.charged = false;
      throw error;
    }
    if (!reported && typeof onWait === "function") {
      reported = true;
      try { onWait({ pool, limit: machinePoolLimit(pool, options.env) }); } catch { /* 表示の失敗で止めない */ }
    }
    await sleep(pollMs + Math.floor(Math.random() * pollMs));
  }
}

export async function withMachineSlot(pool, action, options = {}) {
  const handle = await acquireMachineSlot(pool, options);
  try {
    return await action(handle);
  } finally {
    releaseMachineSlot(handle);
  }
}

/** 子へ枠を渡す環境変数（harness-parallel-run がジョブのために取った枠）。 */
export function machineSlotLeaseEnv(handles = []) {
  const rows = handles.filter(Boolean).map((handle) => ({ pool: handle.pool, file: handle.file, token: handle.token }));
  return rows.length > 0 ? { [MACHINE_SLOT_LEASES_ENV]: JSON.stringify(rows) } : {};
}

/** いま埋まっている枠（診断用）。 */
export function inspectMachinePool(pool, { env = process.env, isAlive = processIsAlive, now = Date.now } = {}) {
  const dir = machinePoolDir(pool, env);
  const limit = machinePoolLimit(pool, env);
  const slots = [];
  for (let index = 0; index < limit; index += 1) {
    const slot = readSlot(path.join(dir, `slot-${index}.json`));
    if (!slot) continue;
    slots.push({
      index,
      pid: slot.record?.pid ?? null,
      label: slot.record?.label ?? "",
      acquiredAt: slot.record?.acquiredAt ?? "",
      abandoned: slotAbandoned(slot, { isAlive, now }),
    });
  }
  return { pool, limit, dir, occupied: slots.length, slots };
}
