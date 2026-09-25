// run_video_harness から各ジャンル正規入口へ渡す薄い adapter。
// shell を使わず引数配列だけを渡し、終了コードと実成果物を観測して状態へ戻す。

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, readFileSync } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCoreCompatibility,
  trustedChannelPackKeyFromEnvironment,
  verifyChannelPackRollbackAuthorization,
  verifyChannelPackEnvelope,
} from "./channelPackEnvelope.mjs";
import { acceptChannelPackVersion } from "./channelPackAcceptance.mjs";
import { extractNarratedChannelPackRuntime } from "./harnessChannelPackRuntime.mjs";
import { resolveHarnessDeploymentCommand } from "./harnessDeploymentResolver.mjs";
import { restoreKoyaHandoffBundle, verifyKoyaHandoffBundle } from "./koyaHandoffBundle.mjs";
import { createKoyaUpstreamPreflightBinding } from "./koyaMangaProduction.mjs";
import { redactSecrets } from "./paidApiRetry.mjs";
import { createVideoHarnessUpstreamExecutionBinding } from "./videoHarnessJob.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CORE_VERSION = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
const CHILD_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const CHILD_TERMINATION_GRACE_MS = 5_000;
const CHILD_TERMINATION_SETTLE_MS = 2_000;
const TASKKILL_TIMEOUT_MS = 2_000;
const NARRATED_ARTIFACT_KINDS = Object.freeze({
  auditReport: "audit-report",
  bgmStem: "bgm",
  contactSheet: "contact-sheet",
  dialogueAudio: "voice-stem",
  finalVideo: "final-video",
  generationManifest: "generation-manifest",
  masterAudio: "master-audio",
  previewVideo: "preview-video",
  runReceipt: "genre-run-receipt",
  subtitles: "subtitle",
  voiceStem: "voice-stem",
});

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function parseJsonOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* 下で末尾objectを探す */ }
  const starts = [...text.matchAll(/\{/gu)].map((match) => match.index).reverse();
  for (const start of starts) {
    try { return JSON.parse(text.slice(start)); } catch { /* 次 */ }
  }
  return null;
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function sha256Tree(root) {
  const hash = createHash("sha256");
  let fileCount = 0;
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const full = join(directory, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new Error(`Channel Pack bundleにsymlinkは含められない: ${full}`);
      if (info.isDirectory()) await walk(full);
      else if (info.isFile()) {
        hash.update(relative(root, full).split(sep).join("/"));
        hash.update("\u001f");
        hash.update(await readFile(full));
        hash.update("\u001f");
        fileCount += 1;
      }
    }
  };
  await walk(root);
  return { digest: hash.digest("hex"), fileCount };
}

async function verifiedArtifact(kind, path, expectedSha256 = "") {
  const absolute = resolve(path);
  await access(absolute, fsConstants.R_OK);
  const info = await stat(absolute);
  if (!info.isFile() || info.size === 0) throw new Error(`${kind}成果物が空か通常ファイルではない: ${absolute}`);
  const digest = await sha256File(absolute);
  if (expectedSha256 && digest !== expectedSha256) throw new Error(`${kind}成果物のSHA-256が監査記録と違う。`);
  return { kind, path: absolute, sha256: digest, bytes: info.size };
}

function appendBoundedTail(previous, chunk, limitBytes = CHILD_OUTPUT_LIMIT_BYTES) {
  const combined = Buffer.concat([Buffer.from(previous), Buffer.from(chunk)]);
  if (combined.length <= limitBytes) return { value: combined, truncated: false };
  return { value: combined.subarray(combined.length - limitBytes), truncated: true };
}

function childStillRunning(child) {
  return Number.isSafeInteger(child?.pid) && child.pid > 0
    && (child.exitCode === null || child.exitCode === undefined)
    && !child.signalCode;
}

function exactChildFallback(child, signal) {
  try {
    const success = child.kill(signal) === true;
    return { success, method: "exact-child-fallback", detail: success ? "sent" : "not-sent" };
  } catch (error) {
    return { success: false, method: "exact-child-fallback", detail: String(error?.code || error?.message || "failed") };
  }
}

async function signalChildTree(child, signal, {
  platform = process.platform,
  spawnProcess = spawn,
  killProcess = process.kill,
  taskkillTimeoutMs = TASKKILL_TIMEOUT_MS,
} = {}) {
  if (!childStillRunning(child)) return { signal, success: false, method: "already-exited", detail: "not-running" };
  if (platform !== "win32") {
    try {
      // POSIX children are spawned as their own process group below. A negative
      // PID reaches only that verified group, including renderer descendants.
      killProcess(-child.pid, signal);
      return { signal, success: true, method: "posix-process-group", detail: `pgid:${child.pid}` };
    } catch (error) {
      if (error?.code === "ESRCH") return { signal, success: false, method: "posix-process-group", detail: "not-found" };
      return { signal, ...exactChildFallback(child, signal), groupError: String(error?.code || "failed") };
    }
  }
  const taskkillArgs = ["/PID", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])];
  let taskkill;
  try {
    taskkill = spawnProcess("taskkill.exe", taskkillArgs, {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
  } catch (error) {
    return { signal, ...exactChildFallback(child, signal), taskkillError: String(error?.code || error?.message || "spawn-failed") };
  }
  const taskkillResult = await new Promise((resolveResult) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(value);
    };
    const timer = setTimeout(() => {
      try { taskkill.kill?.(); } catch { /* helper cleanup */ }
      finish({ ok: false, detail: "timeout" });
    }, taskkillTimeoutMs);
    taskkill.once("error", (error) => finish({ ok: false, detail: String(error?.code || error?.message || "error") }));
    taskkill.once("close", (code, closeSignal) => finish({
      ok: code === 0,
      detail: code === 0 ? "exit-0" : `exit-${code ?? closeSignal ?? "unknown"}`,
    }));
  });
  if (taskkillResult.ok) {
    return { signal, success: true, method: "windows-taskkill-tree", detail: taskkillResult.detail };
  }
  return {
    signal,
    ...exactChildFallback(child, signal),
    taskkillError: taskkillResult.detail,
  };
}

function waitForChildExit(exitPromise, isExited, timeoutMs) {
  if (isExited()) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => resolveWait(false), timeoutMs);
    exitPromise.then(
      () => { clearTimeout(timer); resolveWait(true); },
      () => { clearTimeout(timer); resolveWait(true); },
    );
  });
}

function terminationFailure(child, termination) {
  const error = new Error(
    `Child process ${child.pid} did not exit after bounded termination attempts: ${JSON.stringify(termination.attempts)}`,
  );
  error.code = "CHILD_TERMINATION_FAILED";
  error.termination = structuredClone(termination);
  return error;
}

async function runChild(command, args, {
  cwd,
  isCancellationRequested,
  timeoutMs = 24 * 60 * 60 * 1000,
  terminationGraceMs = CHILD_TERMINATION_GRACE_MS,
  terminationSettleMs = CHILD_TERMINATION_SETTLE_MS,
  platform = process.platform,
  spawnProcess = spawn,
  killProcess = process.kill,
} = {}) {
  const child = spawnProcess(command, args, {
    cwd,
    shell: false,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: platform !== "win32",
    windowsHide: true,
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let stdoutTruncated = false;
  let stderrTruncated = false;
  child.stdout.on("data", (chunk) => {
    const bounded = appendBoundedTail(stdout, chunk);
    stdout = bounded.value;
    stdoutTruncated ||= bounded.truncated;
  });
  child.stderr.on("data", (chunk) => {
    const bounded = appendBoundedTail(stderr, chunk);
    stderr = bounded.value;
    stderrTruncated ||= bounded.truncated;
  });
  let exited = false;
  const exitPromise = new Promise((resolveExit, reject) => {
    child.once("error", (error) => { exited = true; reject(error); });
    child.once("exit", (code, signal) => { exited = true; resolveExit({ code, signal }); });
  });
  let rejectTermination;
  const failedTermination = new Promise((_, reject) => { rejectTermination = reject; });
  const termination = {
    requested: false,
    reason: "",
    pid: child.pid,
    graceMs: terminationGraceMs,
    settleMs: terminationSettleMs,
    signalsSent: [],
    attempts: [],
    escalated: false,
    failed: false,
  };
  let terminationFlow = null;
  const requestTermination = (reason) => {
    if (termination.requested || exited || !childStillRunning(child)) return;
    termination.requested = true;
    termination.reason = reason;
    terminationFlow = (async () => {
      const term = await signalChildTree(child, "SIGTERM", { platform, spawnProcess, killProcess });
      termination.attempts.push(term);
      if (term.success) termination.signalsSent.push("SIGTERM");
      if (await waitForChildExit(exitPromise, () => exited, terminationGraceMs)) return;
      termination.escalated = true;
      const force = await signalChildTree(child, "SIGKILL", { platform, spawnProcess, killProcess });
      termination.attempts.push(force);
      if (force.success) termination.signalsSent.push("SIGKILL");
      if (await waitForChildExit(exitPromise, () => exited, terminationSettleMs)) return;
      termination.failed = true;
      rejectTermination(terminationFailure(child, termination));
    })().catch((error) => {
      termination.failed = true;
      rejectTermination(error);
    });
  };
  const timer = setTimeout(() => requestTermination("timeout"), timeoutMs);
  const cancellation = setInterval(async () => {
    try {
      if (await isCancellationRequested?.()) requestTermination("cancelled");
    } catch { /* Job stateが一時的に読めなくてもprocessを誤停止しない */ }
  }, 500);
  cancellation.unref?.();
  let result;
  try {
    result = await Promise.race([exitPromise, failedTermination]);
  } finally {
    clearTimeout(timer);
    clearInterval(cancellation);
    // If exit wins while Windows taskkill is still reporting its outcome,
    // wait for that bounded helper before freezing evidence. Otherwise the
    // returned object could mutate after it was persisted into the Job.
    if (terminationFlow) await terminationFlow;
  }
  return {
    ...result,
    stdout: redactSecrets(stdout.toString("utf8")),
    stderr: redactSecrets(stderr.toString("utf8")),
    stdoutTruncated,
    stderrTruncated,
    termination: Object.freeze(structuredClone(termination)),
  };
}

function narratedEvidence(parsed, retryFailedImages = false) {
  const imageRetry = parsed?.imageRetry && typeof parsed.imageRetry === "object" && !Array.isArray(parsed.imageRetry)
    ? parsed.imageRetry
    : null;
  return {
    mediaJobs: Array.isArray(parsed?.mediaJobs) ? parsed.mediaJobs : [],
    // 子が止まったときの Media Job journal の置き場。failed からの resume で Job 層の recover が探す。
    mediaJobStateDir: nonEmpty(parsed?.mediaJobStateDir),
    // 画像の失敗分の作り直し（指紋を迂回する引数）。使った事実と回数を Job / Receipt へ渡す。
    imageRetry: {
      requested: retryFailedImages === true || imageRetry?.requested === true,
      retriedFailed: imageRetry?.retriedFailed || null,
    },
    auditChecks: parsed?.auditChecks && typeof parsed.auditChecks === "object" && !Array.isArray(parsed.auditChecks)
      ? parsed.auditChecks
      : null,
    runtimeMetadata: parsed?.runtimeMetadata && typeof parsed.runtimeMetadata === "object" && !Array.isArray(parsed.runtimeMetadata)
      ? parsed.runtimeMetadata
      : null,
    adapterProbes: Array.isArray(parsed?.adapterProbes) ? parsed.adapterProbes : [],
    runReceiptPath: nonEmpty(parsed?.runReceiptPath),
  };
}

function childTerminationSummary(child) {
  const termination = child?.termination;
  if (!termination?.requested) return "";
  const signals = Array.isArray(termination.signalsSent) && termination.signalsSent.length
    ? termination.signalsSent.join("->")
    : "signal-not-observed";
  return ` termination=${termination.reason}:${signals}`;
}

async function collectKoyaArtifacts(parsed) {
  const artifacts = [];
  if (nonEmpty(parsed?.videoPath)) artifacts.push(await verifiedArtifact("final-video", parsed.videoPath));
  if (nonEmpty(parsed?.reportPath)) artifacts.push(await verifiedArtifact("audit-report", parsed.reportPath));
  if (nonEmpty(parsed?.contactSheetPath)) artifacts.push(await verifiedArtifact("contact-sheet", parsed.contactSheetPath));
  if (nonEmpty(parsed?.visualSignoffPath)) {
    artifacts.push(await verifiedArtifact("signoff-report", parsed.visualSignoffPath, nonEmpty(parsed.visualSignoffSha256)));
  }
  if (nonEmpty(parsed?.runReceiptPath)) artifacts.push(await verifiedArtifact("genre-run-receipt", parsed.runReceiptPath));
  return artifacts;
}

async function collectNarratedArtifacts(parsed, deploymentRoot) {
  const artifacts = [];
  const seen = new Set();
  const append = async (kind, path, expectedSha256 = "") => {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(deploymentRoot, path);
    const key = `${kind}\u0000${absolute}`;
    if (seen.has(key)) return;
    artifacts.push(await verifiedArtifact(kind, absolute, expectedSha256));
    seen.add(key);
  };
  for (const [rawKind, value] of Object.entries(parsed?.artifacts || {})) {
    const path = nonEmpty(value?.path ?? value);
    if (path) {
      const kind = NARRATED_ARTIFACT_KINDS[rawKind] || rawKind;
      await append(kind, path, nonEmpty(value?.sha256));
    }
  }
  if (nonEmpty(parsed?.runReceiptPath)) {
    await append("genre-run-receipt", parsed.runReceiptPath);
  }
  return artifacts;
}

function pushOption(args, name, value) {
  const normalized = nonEmpty(value);
  if (normalized) args.push(`--${name}`, normalized);
}

/**
 * Koya の Job が有料生成へ進むのに要る options。options は Job の identity に入るので
 * 後から足せず、足りないまま作った Job は作り直しになる。表はここに1つだけ置き、
 * adapter（実行時の人待ち）と service の start（Job を作る前の停止）が同じものを見る。
 */
export const KOYA_REQUIRED_JOB_OPTIONS = Object.freeze([
  Object.freeze({ key: "episodeId", blocker: "episode-id-required", cliFlag: "--episode-id" }),
  Object.freeze({ key: "protagonistSpeakerId", blocker: "protagonist-speaker-required", cliFlag: "--protagonist-speaker-id" }),
  Object.freeze({ key: "characterBiblePath", blocker: "character-bible-required", cliFlag: "--character-bible-path" }),
  Object.freeze({ key: "storyReviewPath", blocker: "independent-story-review-required", cliFlag: "--story-review-path" }),
]);

export function missingKoyaJobOptions(options = {}) {
  return KOYA_REQUIRED_JOB_OPTIONS.filter((entry) => !nonEmpty(options?.[entry.key]));
}

function koyaBlockers(job) {
  return missingKoyaJobOptions(job.options).map((entry) => entry.blocker);
}

function koyaUpstreamPreflightArgs(job, executionProjectDir) {
  const doctorStage = (job?.stages || []).find((stage) => stage?.id === "doctor");
  if (!nonEmpty(job?.id)
    || !nonEmpty(job?.runDir)
    || !Number.isSafeInteger(Number(job?.revision))
    || doctorStage?.status !== "pass"
    || doctorStage?.evidence?.ready !== true
    || resolve(job?.executionProjectDir || executionProjectDir) !== resolve(executionProjectDir)) return [];
  return [
    "--upstream-job-path", join(resolve(job.runDir), "job.json"),
    "--upstream-job-id", job.id,
    "--upstream-job-revision", String(job.revision),
    "--upstream-preflight-binding", createKoyaUpstreamPreflightBinding(job),
  ];
}

function commonUpstreamExecutionArgs(job) {
  const doctorStage = (job?.stages || []).find((stage) => stage?.id === "doctor");
  if (!nonEmpty(job?.id)
    || !nonEmpty(job?.runDir)
    || !Number.isSafeInteger(Number(job?.revision))
    || doctorStage?.status !== "pass"
    || doctorStage?.evidence?.ready !== true) {
    throw new Error("Narrated-story child requires the exact passed outer Job/doctor execution binding.");
  }
  return [
    "--upstream-job-path", join(resolve(job.runDir), "job.json"),
    "--upstream-job-id", job.id,
    "--upstream-job-revision", String(job.revision),
    "--upstream-execution-binding", createVideoHarnessUpstreamExecutionBinding(job),
  ];
}

function safeChannelPackEvidence(verified) {
  return {
    envelopeVersion: verified.manifest?.version || "",
    id: verified.id,
    version: verified.packVersion,
    harnessId: verified.harnessId,
    payloadKind: verified.payloadKind,
    coreCompatibility: verified.coreCompatibility || verified.manifest?.coreCompatibility || "",
    coreVersion: CORE_VERSION,
    payloadSha256: verified.payloadSha256,
    fileCount: verified.fileCount,
    signerKeyId: verified.signerKeyId,
    trustedPublicKeyId: verified.trustedPublicKeyId,
  };
}

/**
 * Channel Pack importは有料処理ではない。外側envelopeの署名 -> payloadの
 * genre固有検証 -> 隔離workspaceへのrestoreをdoctorより先に行う。
 *
 * 信頼済み公開鍵はbundleから読まない。provider secretと同じく、受領側が
 * 別経路で設定する。Koyaは既存projectへmergeせずJob固有workspaceへ復元し、
 * 「渡されたbundleを検証したが、偶然置かれていた別packで制作した」を防ぐ。
 */
export async function prepareVideoHarnessJob({
  job,
  env = process.env,
  verifyEnvelope = verifyChannelPackEnvelope,
  trustedKey = null,
  rollbackAuthorization = null,
  acceptPack = acceptChannelPackVersion,
  verifyRollbackAuthorization = verifyChannelPackRollbackAuthorization,
} = {}) {
  if (!job?.channelPack) {
    return { ok: false, blockers: ["signed-channel-pack-required"] };
  }
  if (job.channelPack.kind !== "directory") {
    return { ok: false, blockers: ["signed-channel-pack-envelope-directory-required"] };
  }
  let verified;
  let trust;
  try {
    const currentPack = await sha256Tree(resolve(job.channelPack.path));
    if (currentPack.digest !== job.channelPack.sha256 || currentPack.fileCount !== job.channelPack.fileCount) {
      throw new Error("計画後にChannel Pack bundleが差し替えられた。新しいJobとして計画し直すこと。");
    }
    trust = trustedKey || await trustedChannelPackKeyFromEnvironment(env);
    verified = await verifyEnvelope({
      bundleDir: job.channelPack.path,
      expectedHarnessId: job.harness.id,
      coreVersion: CORE_VERSION,
      ...trust,
    });
    assertCoreCompatibility(CORE_VERSION, verified.coreCompatibility || verified.manifest?.coreCompatibility);
  } catch (error) {
    return {
      ok: false,
      blockers: ["channel-pack-signature-verification-failed"],
      error: String(error?.message || error),
    };
  }
  if (verified?.ok !== true || !nonEmpty(verified.payloadDir)) {
    return { ok: false, blockers: ["channel-pack-signature-verification-failed"] };
  }
  const evidence = safeChannelPackEvidence(verified);
  const acceptVerifiedPack = async () => {
    let authorization = rollbackAuthorization;
    const authorizationPath = nonEmpty(env.BUZZASSIST_CHANNEL_PACK_ROLLBACK_AUTHORIZATION);
    if (!authorization && authorizationPath) {
      const absolute = resolve(authorizationPath);
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 64 * 1024) {
        throw new Error("Channel Pack rollback承認fileが通常の64KiB以下JSONではない。");
      }
      authorization = JSON.parse(await readFile(absolute, "utf8"));
    }
    return acceptPack({
      projectDir: job.projectDir,
      evidence,
      rollbackAuthorization: authorization,
      verifyRollbackAuthorization: ({ authorization: candidate, expected }) => verifyRollbackAuthorization({
        authorization: candidate,
        expected,
        ...trust,
      }),
    });
  };
  if (job.harness.id === "koya-manga-video") {
    if (verified.payloadKind !== "koya-handoff") {
      return { ok: false, blockers: ["koya-handoff-payload-required"], evidence };
    }
    let inner;
    try {
      inner = await verifyKoyaHandoffBundle({ bundleDir: verified.payloadDir });
    } catch (error) {
      return {
        ok: false,
        blockers: ["koya-handoff-verification-failed"],
        evidence,
        error: String(error?.message || error),
      };
    }
    const executionProjectDir = join(job.runDir, "workspace");
    await mkdir(executionProjectDir, { recursive: true });
    const restored = await restoreKoyaHandoffBundle({ projectDir: executionProjectDir, bundleDir: verified.payloadDir });
    if (restored?.ok !== true) {
      return { ok: false, blockers: ["channel-pack-restore-failed"], evidence: restored };
    }
    let acceptance;
    try {
      acceptance = await acceptVerifiedPack();
    } catch (error) {
      return {
        ok: false,
        blockers: ["channel-pack-rollback-policy-failed"],
        evidence,
        error: String(error?.message || error),
      };
    }
    return {
      ok: true,
      action: "signature-verified-and-restored-to-isolated-workspace",
      evidence,
      acceptance,
      payloadDir: verified.payloadDir,
      executionProjectDir,
      innerBundleId: inner.manifest?.id || "",
    };
  }
  if (job.harness.id === "narrated-story-video") {
    if (!["channel-pack", "narrated-story-channel-pack"].includes(verified.payloadKind)) {
      return { ok: false, blockers: ["narrated-story-channel-pack-payload-required"], evidence };
    }
    let channelPackRuntime;
    try {
      channelPackRuntime = await extractNarratedChannelPackRuntime({
        payloadDir: verified.payloadDir,
        evidence,
      });
    } catch (error) {
      return {
        ok: false,
        blockers: ["narrated-story-channel-pack-runtime-invalid"],
        evidence,
        error: String(error?.message || error),
      };
    }
    let acceptance;
    try {
      acceptance = await acceptVerifiedPack();
    } catch (error) {
      return {
        ok: false,
        blockers: ["channel-pack-rollback-policy-failed"],
        evidence,
        error: String(error?.message || error),
      };
    }
    return {
      ok: true,
      action: "signature-verified",
      evidence,
      acceptance,
      channelPackRuntime,
      payloadDir: verified.payloadDir,
      executionProjectDir: job.projectDir,
    };
  }
  return { ok: false, blockers: ["channel-pack-adapter-missing"], evidence };
}

async function runKoya(job, context) {
  const blockers = koyaBlockers(job);
  if (blockers.length > 0) {
    return {
      status: "awaiting-human-review",
      blockers,
      knownRemainingIssues: blockers,
      result: {
        next: "有料生成前に主人公・episode character bible・別contextのstory reviewを一括確定する",
      },
    };
  }
  const executionProjectDir = nonEmpty(context.prepareResult?.executionProjectDir) || job.projectDir;
  const args = [join(REPO_ROOT, "scripts", "koya-manga-video.mjs"), "full", "--project-dir", executionProjectDir];
  pushOption(args, "episode-id", job.options.episodeId);
  pushOption(args, "script-path", job.script.path);
  pushOption(args, "title", job.options.title);
  pushOption(args, "protagonist-speaker-id", job.options.protagonistSpeakerId);
  pushOption(args, "character-bible-path", job.options.characterBiblePath);
  pushOption(args, "story-review-path", job.options.storyReviewPath);
  pushOption(args, "contract-path", job.options.contractPath);
  pushOption(args, "override-path", job.options.overridePath);
  pushOption(
    args,
    "speech-concurrency",
    job.options.speechConcurrency === undefined ? "" : String(job.options.speechConcurrency),
  );
  // 衣装ゲートを人が外す判断は、Job 作成時に明示された理由でだけ子へ渡す。
  pushOption(args, "wardrobe-readiness-override-reason", job.options.wardrobeReadinessOverrideReason);
  args.push(...koyaUpstreamPreflightArgs(job, executionProjectDir));
  // 画像の失敗分の作り直しは2経路: Job 作成時の options.retryFailed（identity に入る）と、
  // resume の実行文脈 context.retryFailedImages（identity に入らない。service が execute 時に載せる）。
  // 後者を options に混ぜると jobId が変わって別 Job＝全額払い直しになるので、ここで合流させる。
  const retryFailedImages = job.options.retryFailed === true || context.retryFailedImages === true;
  if (retryFailedImages) args.push("--retry-failed");
  // 選択カットの動画差し替えは別の有料生成なので、Job 作成時に明示された場合だけ渡す。
  if (job.options.confirmPaidVideoGeneration === true) args.push("--confirm-paid-video-generation");
  if (job.options.retryFailedVideo === true) args.push("--retry-failed-video");
  // 上位 Job 層で運営者 env と照合済みの信頼リスト path。子にも同じ path を渡し、両層が同じ
  // 信頼リストで signoff を再検証することを保証する（F-3）。env が正で、子側も env と照合する。
  // Job options ではなく service が execute 時に context へ載せる（options は信頼アンカーを持てない）。
  pushOption(args, "reviewer-trust-path", context.reviewerTrustPath);
  const child = await (context.runChild || runChild)(process.execPath, args, {
    cwd: REPO_ROOT,
    isCancellationRequested: context.isCancellationRequested,
  });
  const parsed = parseJsonOutput(child.stdout);
  if (child.termination?.reason === "cancelled" || (child.signal === "SIGTERM" && await context.isCancellationRequested?.())) {
    return {
      status: "cancelled",
      knownRemainingIssues: [],
      result: { signal: child.signal, termination: child.termination || null },
    };
  }
  const status = nonEmpty(parsed?.status);
  if (child.code === 3 || /awaiting|waiting/iu.test(status)) {
    const issues = Array.isArray(parsed?.knownRemainingIssues) ? parsed.knownRemainingIssues.map(String) : [status || "production-paused"];
    const artifacts = await collectKoyaArtifacts(parsed);
    return {
      status: "awaiting-human-review",
      blockers: issues,
      knownRemainingIssues: issues,
      artifacts,
      mediaJobs: Array.isArray(parsed?.mediaJobs) ? parsed.mediaJobs : [],
      ...koyaRetryEvidence(parsed, retryFailedImages),
      auditChecks: parsed?.auditChecks || null,
      result: parsed,
    };
  }
  if (child.code !== 0 || !parsed) {
    throw new Error(`ハーネスの正規入口が失敗した (${child.code ?? child.signal}):${childTerminationSummary(child)} ${child.stderr.slice(-2000)}`);
  }
  if (status !== "final-koya-audited" || parsed?.knownRemainingIssues?.length) {
    const issues = Array.isArray(parsed?.knownRemainingIssues) && parsed.knownRemainingIssues.length
      ? parsed.knownRemainingIssues.map(String)
      : ["independent-contact-sheet-signoff-required"];
    const artifacts = await collectKoyaArtifacts(parsed);
    return {
      status: "awaiting-human-review",
      blockers: issues,
      knownRemainingIssues: issues,
      artifacts,
      mediaJobs: Array.isArray(parsed?.mediaJobs) ? parsed.mediaJobs : [],
      ...koyaRetryEvidence(parsed, retryFailedImages),
      auditChecks: parsed?.auditChecks || null,
      result: parsed,
    };
  }
  const artifacts = await collectKoyaArtifacts(parsed);
  if (!artifacts.some((entry) => entry.kind === "final-video")) throw new Error("最終監査がpassでもMP4成果物が無い。");
  return {
    status: "completed",
    knownRemainingIssues: [],
    artifacts,
    mediaJobs: Array.isArray(parsed?.mediaJobs) ? parsed.mediaJobs : [],
    ...koyaRetryEvidence(parsed, retryFailedImages),
    result: parsed,
  };
}

/**
 * 画像の失敗分の作り直しと、音声の Media Job journal の場所を、Job／Receipt が
 * 記録できる形で返す。retryFailedImages は指紋を迂回する引数なので、使った事実と
 * 「何枚を何回作り直したか」（子の台帳 summary.retriedFailed）を必ず一緒に返す。
 * mediaJobStateDir は failed からの resume で recover が journal を探す場所。
 */
function koyaRetryEvidence(parsed, retryFailedImages) {
  const summary = parsed?.imageSummary && typeof parsed.imageSummary === "object" ? parsed.imageSummary : null;
  return {
    imageRetry: {
      requested: retryFailedImages === true,
      retriedFailed: summary?.retriedFailed || null,
    },
    imageSummary: summary,
    mediaJobStateDir: nonEmpty(parsed?.mediaJobStateDir),
    // 工程ごとの開始・終了（画と重ねた台詞の音声を含む）。Job が写し、RunReceipt の timing.stages になる。
    ...(parsed?.stageTimings && typeof parsed.stageTimings === "object" ? { stageTimings: parsed.stageTimings } : {}),
  };
}

async function runNarratedStory(job, context) {
  let route;
  try {
    route = resolveHarnessDeploymentCommand(job.deployment);
    await access(route.entrypointPath, fsConstants.R_OK);
  } catch {
    return {
      status: "failed",
      error: `ナレーション物語の正規入口が無い: ${job.deployment?.entrypoint || "(未設定)"}`,
      knownRemainingIssues: ["canonical-narrated-story-entrypoint-missing"],
    };
  }
  const args = [...route.args, "full", "--script-path", job.script.path, "--job-id", job.id, "--project-dir", job.projectDir];
  pushOption(args, "episode-id", job.options?.episodeId);
  pushOption(args, "channel-pack-dir", context.prepareResult?.payloadDir);
  // 運営者の画の取り込みの記録（Pack の image.source が operator-file のとき）。Job の options にある
  // path だけを渡す（子はこれが Job の宣言と同じかを照合する）。中身は子が sha256 で束縛する。
  pushOption(args, "operator-image-manifest", job.options?.operatorImageManifestPath);
  // 運営者の動画の取り込みの記録（回ごとの OP 映像・感想パートの人物の映像）。画と同じく Job の options の path だけを渡す。
  pushOption(args, "operator-video-manifest", job.options?.operatorVideoManifestPath);
  // 台本の品質ループの作業フォルダ（Job の options の path だけを渡す。子はこれが Job の宣言と同じかを照合する）。
  pushOption(args, "script-quality-work-dir", job.options?.scriptQualityWorkDir);
  // 上位 Job 層で運営者 env と照合済みの信頼リスト path（F-3。Koya adapter と同じ規則）。
  pushOption(args, "reviewer-trust-path", context.reviewerTrustPath);
  // 画像の失敗分の作り直し。Koya と同じ2経路（Job 作成時の options.retryFailed と、resume の実行文脈）。
  const retryFailedImages = job.options?.retryFailed === true || context.retryFailedImages === true;
  if (retryFailedImages) args.push("--retry-failed-images");
  args.push(...commonUpstreamExecutionArgs(job));
  const child = await (context.runChild || runChild)(route.command, args, {
    cwd: route.cwd,
    isCancellationRequested: context.isCancellationRequested,
  });
  const parsed = parseJsonOutput(child.stdout);
  if (child.termination?.reason === "cancelled" || (child.signal === "SIGTERM" && await context.isCancellationRequested?.())) {
    return {
      status: "cancelled",
      knownRemainingIssues: [],
      result: { signal: child.signal, termination: child.termination || null },
    };
  }
  const status = nonEmpty(parsed?.status);
  if (child.code === 3 || /awaiting|waiting/iu.test(status)) {
    const issues = Array.isArray(parsed?.knownRemainingIssues) && parsed.knownRemainingIssues.length
      ? parsed.knownRemainingIssues.map(String)
      : [status || "production-paused"];
    const artifacts = await collectNarratedArtifacts(parsed, job.deployment.root);
    return {
      status: "awaiting-human-review",
      blockers: issues,
      knownRemainingIssues: issues,
      artifacts,
      ...narratedEvidence(parsed, retryFailedImages),
      result: parsed,
    };
  }
  if (child.code !== 0 || !parsed) {
    throw new Error(`ナレーション物語正規入口が失敗した (${child.code ?? child.signal}):${childTerminationSummary(child)} ${child.stderr.slice(-2000)}`);
  }
  const issues = Array.isArray(parsed.knownRemainingIssues) ? parsed.knownRemainingIssues.map(String) : [];
  if (status !== "final-audited" || issues.length > 0) {
    const artifacts = await collectNarratedArtifacts(parsed, job.deployment.root);
    return {
      status: "awaiting-human-review",
      blockers: issues.length ? issues : ["final-audit-required"],
      knownRemainingIssues: issues.length ? issues : ["final-audit-required"],
      artifacts,
      ...narratedEvidence(parsed, retryFailedImages),
      result: parsed,
    };
  }
  const artifacts = await collectNarratedArtifacts(parsed, job.deployment.root);
  if (!artifacts.some((entry) => /video|mp4/u.test(entry.kind))) throw new Error("最終監査がpassでもMP4成果物が無い。");
  return {
    status: "completed",
    knownRemainingIssues: [],
    artifacts,
    ...narratedEvidence(parsed, retryFailedImages),
    result: parsed,
  };
}

export async function executeVideoHarnessAdapter(context = {}) {
  const job = context.job;
  if (job?.harness?.id === "koya-manga-video") return runKoya(job, context);
  if (job?.harness?.id === "narrated-story-video") return runNarratedStory(job, context);
  throw new Error(`上位Job adapterが無いハーネス: ${job?.harness?.id || "(空)"}`);
}

export const _testing = Object.freeze({
  appendBoundedTail,
  collectKoyaArtifacts,
  collectNarratedArtifacts,
  narratedEvidence,
  parseJsonOutput,
  runChild,
  signalChildTree,
  sha256Tree,
  koyaUpstreamPreflightArgs,
});
