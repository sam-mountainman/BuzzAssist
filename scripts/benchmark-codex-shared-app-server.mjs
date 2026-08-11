#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { AdaptiveConcurrencyController, runWithAdaptiveConcurrency } from "../lib/adaptiveConcurrency.mjs";
import { runWithConcurrency } from "../lib/mediaGeneration.mjs";
import { CodexAppServerClient, SharedCodexImageBridge } from "./codex-image-bridge.mjs";

const execFile = promisify(execFileCallback);
const jobCount = Math.max(2, Math.min(20, Number(process.argv[2]) || 12));
const outputPath = resolve(process.argv[3] || "tmp/r62-shared-app-server-benchmark.json");
const cwd = process.cwd();
const timeoutMs = 120_000;
const supervisoryTimeoutMs = 180_000;
const legacySampleCount = Math.min(2, jobCount);
const benchmarkStartedAt = Date.now();
const activeResources = new Set();

// A real app-server cold start can hang well beyond the useful measurement
// window. Make the supervisor rule reproducible in the benchmark itself and
// dispose only the children created by this process before exiting.
const supervisoryTimer = setTimeout(() => {
  void (async () => {
    for (const resource of activeResources) {
      try { resource.dispose(); } catch {}
    }
    const report = {
      version: "r62-real-codex-app-server-lifecycle-benchmark-v2",
      scope: "real Codex app-server lifecycle; paid image generation excluded",
      cwd,
      jobCount,
      result: "supervisor-timeout",
      supervisoryTimeoutMs,
      elapsedMs: Date.now() - benchmarkStartedAt,
      cleanup: "all benchmark-owned Codex app-server clients disposed",
      conclusion: "The bounded pair did not finish; record the cold-start cost instead of waiting indefinitely.",
      createdAt: new Date().toISOString(),
    };
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stderr.write(`${JSON.stringify({ outputPath, ...report }, null, 2)}\n`);
    process.exit(124);
  })();
}, supervisoryTimeoutMs);

async function rssBytesForPids(pids) {
  const ids = [...pids].filter((pid) => Number.isInteger(pid) && pid > 0);
  if (ids.length === 0) return 0;
  try {
    const { stdout } = await execFile("ps", ["-o", "rss=", "-p", ids.join(",")]);
    return stdout.trim().split(/\s+/u).reduce((sum, value) => sum + (Number(value) || 0) * 1024, 0);
  } catch {
    return 0;
  }
}

async function measure(label, pidSet, work) {
  let peakChildRssBytes = 0;
  let samples = 0;
  const sampler = setInterval(async () => {
    peakChildRssBytes = Math.max(peakChildRssBytes, await rssBytesForPids(pidSet));
    samples += 1;
  }, 25);
  const started = performance.now();
  try {
    const value = await work();
    peakChildRssBytes = Math.max(peakChildRssBytes, await rssBytesForPids(pidSet));
    return {
      label,
      elapsedMs: Number((performance.now() - started).toFixed(3)),
      peakChildRssBytes,
      rssSamples: samples,
      ...value,
    };
  } finally {
    clearInterval(sampler);
  }
}

async function threadLifecycle(client, index) {
  const created = await client.request("thread/start", {
    cwd,
    serviceName: "excalidraw-r62-benchmark",
  });
  const threadId = created?.thread?.id;
  if (!threadId) throw new Error(`benchmark job ${index} received no thread id`);
  await client.request("thread/archive", { threadId });
  return threadId;
}

const legacyPids = new Set();
let legacyStarts = 0;
const legacy = await measure("legacy-one-app-server-per-job-cold-start-sample", legacyPids, async () => {
  const outcomes = await runWithConcurrency(
    Array.from({ length: legacySampleCount }, (_, index) => index),
    1,
    async (index) => {
      const client = new CodexAppServerClient({ cwd, timeoutMs });
      activeResources.add(client);
      try {
        await client.start();
        legacyStarts += 1;
        legacyPids.add(client.child?.pid);
        return await threadLifecycle(client, index);
      } finally {
        legacyPids.delete(client.child?.pid);
        client.dispose();
        activeResources.delete(client);
      }
    },
  );
  return {
    appServerStarts: legacyStarts,
    sampleJobCount: legacySampleCount,
    extrapolatedStartsForJobCount: jobCount,
    completed: outcomes.filter((entry) => entry.ok).length,
    failed: outcomes.filter((entry) => !entry.ok).length,
  };
});

const sharedPids = new Set();
const shared = await measure("shared-app-server-adaptive-thread-jit", sharedPids, async () => {
  const bridge = new SharedCodexImageBridge({ cwd, timeoutMs });
  activeResources.add(bridge);
  try {
    await bridge.start();
    sharedPids.add(bridge.client?.child?.pid);
    const controller = new AdaptiveConcurrencyController({
      initial: Math.min(16, jobCount),
      min: 4,
      max: Math.max(16, jobCount),
      growthSuccessStreak: 4,
    });
    const outcomes = await runWithAdaptiveConcurrency(
      Array.from({ length: jobCount }, (_, index) => () => threadLifecycle(bridge.client, index)),
      controller,
      { maxAttempts: 2 },
    );
    return {
      appServerStarts: bridge.stats.starts,
      appServerRestarts: bridge.stats.restarts,
      completed: outcomes.filter((entry) => entry.ok).length,
      failed: outcomes.filter((entry) => !entry.ok).length,
      finalAdaptiveLimit: controller.limit,
      controllerHistory: controller.history,
    };
  } finally {
    sharedPids.delete(bridge.client?.child?.pid);
    bridge.dispose();
    activeResources.delete(bridge);
  }
});

const report = {
  version: "r62-real-codex-app-server-lifecycle-benchmark-v1",
  scope: "real Codex app-server initialize + real ephemeral thread/start/archive; excludes paid image model latency",
  cwd,
  jobCount,
  fixed10Legacy: legacy,
  adaptiveShared: shared,
  improvement: {
    appServerStartReductionForJobCount: jobCount - shared.appServerStarts,
    legacyColdStartAverageMs: Number((legacy.elapsedMs / legacySampleCount).toFixed(3)),
    extrapolatedLegacySerialElapsedMs: Number((legacy.elapsedMs / legacySampleCount * jobCount).toFixed(3)),
    elapsedRatioSharedToExtrapolatedLegacySerial: Number((shared.elapsedMs / Math.max(1, legacy.elapsedMs / legacySampleCount * jobCount)).toFixed(4)),
    peakChildRssRatioSharedToLegacy: Number((shared.peakChildRssBytes / Math.max(1, legacy.peakChildRssBytes)).toFixed(4)),
  },
  createdAt: new Date().toISOString(),
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
clearTimeout(supervisoryTimer);
process.stdout.write(`${JSON.stringify({ outputPath, ...report }, null, 2)}\n`);
