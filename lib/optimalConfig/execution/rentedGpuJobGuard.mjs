// 借り GPU の工程の見張り——始める → 動かす → 成果物を回収する → 止める → 止まったことを確かめる → 残った保存費を報告する。
//
// 守ること:
//   - 有料なので、運営者の確認（confirmed: true）が無ければ始めない
//   - 始める前に、時間の上限と現金の上限から「動かしてよい分数」を決める。上限が小さすぎれば始めない
//   - 時間の上限が来たら作業を打ち切る（AbortSignal）。成功しても失敗しても打ち切っても、finally で必ず止める
//   - 止めたあと、本当に止まったかを状態で確かめる。確かめられなければ、今すぐ運営者が止めるよう大きく知らせる
//   - 止めても残る保存（ボリューム）の月の費用を報告する（消すかどうかは運営者が決める。ここでは消さない）
//   - 実際の時間単価が申告した上限を超えていたら、作業を始めずに止める
//   - プロバイダは差し替えられる（provider-agnostic）。Runpod の形のもの（createRunpodProvider）を下に置くが、
//     この版ではどのプロバイダにも実際には呼んでいない（未実測）。API キーは環境変数から読み、記録にも出力にも出さない
//
// provider の形:
//   id: string
//   start(spec, { signal }) -> { instanceId, hourlyJpy? }        始める（課金が始まる）
//   status(instance) -> { state: "starting"|"running"|"stopping"|"stopped"|"terminated"|"unknown" }
//   collectOutputs(instance, { signal, workResult }) -> [{ path, sha256?, bytes? }]
//   stop(instance) -> void                                         止める（ボリュームは残る）
//   storage(instance) -> { volumes: [{ id, sizeGiB, monthlyJpy|null }] }

export const RENTED_GPU_GUARD_VERSION = "optimal-config-rented-gpu-guard-v1";
const STOPPED_STATES = new Set(["stopped", "terminated", "exited"]);
const MIN_RUN_MINUTES = 1;

function codedError(code, message, extra = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function finitePositive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function yen(value) {
  return `${Math.round(value).toLocaleString("ja-JP")} 円`;
}

/** 時間の上限と現金の上限から、動かしてよい分数を決める。 */
export function rentedGpuRunCap({ hourlyJpy, maxJpy, maxMinutes }) {
  if (!finitePositive(hourlyJpy)) throw codedError("rented-gpu-price-unknown", "借り GPU の時間単価（円）が分からないので始めない。プロバイダの料金表の値を spec.hourlyJpy に書く。");
  if (!finitePositive(maxJpy)) throw codedError("rented-gpu-budget-missing", "この回の現金の上限（budget.maxJpy）が要る。");
  if (!finitePositive(maxMinutes)) throw codedError("rented-gpu-time-cap-missing", "この回の時間の上限（budget.maxMinutes）が要る。");
  const byCash = (maxJpy / hourlyJpy) * 60;
  const capMinutes = Math.min(maxMinutes, byCash);
  return { capMinutes, byCashMinutes: byCash, limitedBy: byCash < maxMinutes ? "cash" : "time" };
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // 先に「打ち切った」で決着させてから作業へ止まれと伝える（止まった作業の戻り値を完了と取り違えない）
      reject(codedError("rented-gpu-time-cap", "時間の上限が来たので打ち切った。"));
      onTimeout();
    }, Math.max(0, ms));
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function verifyStopped(provider, instance, { attempts, intervalMs, sleep }) {
  let last = "unknown";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const status = await provider.status(instance);
      last = String(status?.state || "unknown").toLowerCase();
      if (STOPPED_STATES.has(last)) return { verified: true, finalState: last, attempts: attempt };
    } catch (error) {
      last = `status-error: ${error?.code || error?.message || error}`;
    }
    if (attempt < attempts) await sleep(intervalMs);
  }
  return { verified: false, finalState: last, attempts };
}

/**
 * 借り GPU で1回の作業を動かす。どう終わっても、止めて・確かめて・保存費を報告した記録を返す。
 * work({ instance, signal, provider }) が作業の中身（生成など）。signal が abort されたら手を止める。
 */
export async function runRentedGpuJob({
  provider,
  spec = {},
  work,
  budget = {},
  confirmed = false,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  stopVerifyAttempts = 10,
  stopVerifyIntervalMs = 3000,
} = {}) {
  if (!provider || typeof provider.start !== "function" || typeof provider.stop !== "function" || typeof provider.status !== "function") {
    throw codedError("rented-gpu-provider-invalid", "借り GPU のプロバイダが start / stop / status を持っていない。");
  }
  if (typeof work !== "function") throw codedError("rented-gpu-work-missing", "借り GPU でする作業（work）が要る。");
  if (confirmed !== true) {
    throw codedError("rented-gpu-not-confirmed", "借り GPU はお金がかかる。運営者の確認（confirmed: true）が無いので始めない。");
  }
  const cap = rentedGpuRunCap({ hourlyJpy: spec.hourlyJpy, maxJpy: budget.maxJpy, maxMinutes: budget.maxMinutes });
  if (cap.capMinutes < MIN_RUN_MINUTES) {
    throw codedError("rented-gpu-budget-too-small", `現金の上限 ${yen(budget.maxJpy)} では時間単価 ${yen(spec.hourlyJpy)} の GPU を ${MIN_RUN_MINUTES} 分も動かせないので始めない。`);
  }
  const report = {
    version: RENTED_GPU_GUARD_VERSION,
    providerId: String(provider.id || "unknown"),
    status: "not-started",
    instanceId: null,
    cap: { ...cap, hourlyJpy: spec.hourlyJpy, maxJpy: budget.maxJpy, maxMinutes: budget.maxMinutes },
    startedAt: null,
    endedAt: null,
    elapsedMinutes: 0,
    estimatedCostJpy: 0,
    outputs: [],
    workResult: null,
    error: null,
    stop: { requested: false, verified: false, finalState: null, error: null },
    storage: null,
    alerts: [],
  };
  let instance = null;
  const controller = new AbortController();
  const started = now();
  try {
    try {
      instance = await provider.start(spec, { signal: controller.signal });
    } catch (error) {
      // 始める途中で失敗しても、インスタンスが作られていたら止める（課金を残さない）
      if (error?.instanceId) instance = { instanceId: error.instanceId };
      throw error;
    }
    report.instanceId = instance?.instanceId || null;
    report.startedAt = new Date(started).toISOString();
    report.status = "running";
    if (finitePositive(instance?.hourlyJpy) && instance.hourlyJpy > spec.hourlyJpy) {
      throw codedError("rented-gpu-price-above-declared", `実際の時間単価 ${yen(instance.hourlyJpy)} が申告した ${yen(spec.hourlyJpy)} を超えたので、作業を始めずに止める。`);
    }
    const deadline = started + cap.capMinutes * 60_000;
    report.workResult = await withTimeout(work({ instance, signal: controller.signal, provider }), deadline - now(), () => controller.abort());
    if (typeof provider.collectOutputs === "function") {
      report.outputs = await withTimeout(provider.collectOutputs(instance, { signal: controller.signal, workResult: report.workResult }), deadline - now(), () => controller.abort());
    }
    report.status = "completed";
  } catch (error) {
    report.status = error?.code === "rented-gpu-time-cap" ? "time-capped" : "failed";
    report.error = { code: String(error?.code || "rented-gpu-work-failed"), message: String(error?.message || error) };
  } finally {
    controller.abort();
    if (instance) {
      report.stop.requested = true;
      try {
        await provider.stop(instance);
      } catch (error) {
        report.stop.error = String(error?.message || error);
      }
      const verified = await verifyStopped(provider, instance, { attempts: stopVerifyAttempts, intervalMs: stopVerifyIntervalMs, sleep });
      report.stop.verified = verified.verified;
      report.stop.finalState = verified.finalState;
      report.stop.attempts = verified.attempts;
      if (!verified.verified) {
        report.alerts.push(`止まったことを確かめられなかった（最後の状態: ${verified.finalState}）。課金が続いている恐れがある。今すぐ ${report.providerId} の画面でインスタンス ${report.instanceId} を止める。`);
      }
      if (typeof provider.storage === "function") {
        try {
          const storage = await provider.storage(instance);
          const volumes = Array.isArray(storage?.volumes) ? storage.volumes : [];
          const monthly = volumes.reduce((total, volume) => total + (Number.isFinite(volume?.monthlyJpy) ? volume.monthlyJpy : 0), 0);
          const unknown = volumes.filter((volume) => !Number.isFinite(volume?.monthlyJpy)).map((volume) => volume.id);
          report.storage = { volumes, monthlyJpy: monthly, unknownCostVolumeIds: unknown };
          if (volumes.length > 0) {
            report.alerts.push(`止めても保存（${volumes.map((volume) => `${volume.id} ${volume.sizeGiB ?? "?"}GiB`).join("、")}）が残り、月 ${yen(monthly)}${unknown.length > 0 ? "＋費用の分からない分" : ""}かかる。要らなければ運営者が消す（ここでは消さない）。`);
          }
        } catch (error) {
          report.storage = { error: String(error?.message || error) };
          report.alerts.push("止めた後の保存費を確かめられなかった。プロバイダの画面で残っているボリュームを確かめる。");
        }
      }
    }
    const ended = now();
    report.endedAt = new Date(ended).toISOString();
    report.elapsedMinutes = Math.round(((ended - started) / 60_000) * 100) / 100;
    const hourly = finitePositive(instance?.hourlyJpy) ? instance.hourlyJpy : spec.hourlyJpy;
    report.estimatedCostJpy = instance ? Math.round((hourly * report.elapsedMinutes) / 60) : 0;
  }
  return report;
}

/**
 * Runpod の形のプロバイダ（REST。この版では実際に呼んでいない・未実測）。
 * fetchImpl と API キーの環境変数名を受け取る。キーの値は記録・出力・エラーに出さない。
 * 保存費は Runpod の料金表の円換算（ネットワークボリューム storageJpyPerGiBMonth、止めた Pod に残るディスク
 * stoppedPodVolumeJpyPerGiBMonth）を運営者が渡す。渡されなければ null（分からない）。
 */
export function createRunpodProvider({
  fetchImpl = globalThis.fetch,
  env = process.env,
  apiKeyEnv = "RUNPOD_API_KEY",
  baseUrl = "https://rest.runpod.io/v1",
  jpyPerUsd = null,
  storageJpyPerGiBMonth = null,
  stoppedPodVolumeJpyPerGiBMonth = null,
} = {}) {
  const key = () => {
    const value = String(env[apiKeyEnv] || "").trim();
    if (!value) throw codedError("rented-gpu-credentials-missing", `環境変数 ${apiKeyEnv} が無い（値は記録しない）。`);
    return value;
  };
  const call = async (method, pathname, body, signal) => {
    const response = await fetchImpl(`${baseUrl}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${key()}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw codedError("rented-gpu-provider-http", `Runpod ${method} ${pathname} が ${response.status} を返した。`);
    return response.status === 204 ? null : response.json();
  };
  const toState = (pod) => {
    const raw = String(pod?.desiredStatus || pod?.status || "").toUpperCase();
    if (raw === "RUNNING") return "running";
    if (raw === "EXITED" || raw === "STOPPED") return "stopped";
    if (raw === "TERMINATED") return "terminated";
    return raw ? raw.toLowerCase() : "unknown";
  };
  return {
    id: "runpod",
    async start(spec, { signal } = {}) {
      const pod = await call("POST", "/pods", spec.pod || {}, signal);
      const usd = Number(pod?.costPerHr);
      return {
        instanceId: pod?.id,
        networkVolumeId: spec.pod?.networkVolumeId || pod?.networkVolumeId || null,
        hourlyJpy: Number.isFinite(usd) && Number.isFinite(jpyPerUsd) ? usd * jpyPerUsd : null,
      };
    },
    async status(instance) {
      return { state: toState(await call("GET", `/pods/${encodeURIComponent(instance.instanceId)}`)) };
    },
    async stop(instance) {
      await call("POST", `/pods/${encodeURIComponent(instance.instanceId)}/stop`);
    },
    async storage(instance) {
      const volumes = [];
      const pod = await call("GET", `/pods/${encodeURIComponent(instance.instanceId)}`);
      const podVolume = Number(pod?.volumeInGb);
      if (Number.isFinite(podVolume) && podVolume > 0) {
        volumes.push({ id: `${instance.instanceId}:volume`, kind: "stopped-pod-volume", sizeGiB: podVolume, monthlyJpy: Number.isFinite(stoppedPodVolumeJpyPerGiBMonth) ? podVolume * stoppedPodVolumeJpyPerGiBMonth : null });
      }
      if (instance.networkVolumeId) {
        const volume = await call("GET", `/networkvolumes/${encodeURIComponent(instance.networkVolumeId)}`);
        const sizeGiB = Number(volume?.size);
        volumes.push({ id: instance.networkVolumeId, kind: "network-volume", sizeGiB: Number.isFinite(sizeGiB) ? sizeGiB : null, monthlyJpy: Number.isFinite(sizeGiB) && Number.isFinite(storageJpyPerGiBMonth) ? sizeGiB * storageJpyPerGiBMonth : null });
      }
      return { volumes };
    },
  };
}
