// Claude Code / Codex / CLI / MCP が共有する Video Harness の唯一の操作面。
//
// この service より外側は、Job の状態遷移や doctor / adapter / Canvas 投影を
// 組み立てない。start は明示確認が無ければ durable plan を保存するだけにし、
// 有料処理へ進み得る start/resume は confirmed === true のときだけ実行する。

import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { executeVideoHarnessAdapter, prepareVideoHarnessJob } from "./videoHarnessAdapters.mjs";
import { projectVideoHarnessJob } from "./videoHarnessCanvasAdapter.mjs";
import {
  createVideoHarnessJob,
  readVideoHarnessJob,
  requestVideoHarnessCancellation,
  runVideoHarnessJob,
  withVideoHarnessJobLock,
} from "./videoHarnessJob.mjs";
import { redactSecrets } from "./paidApiRetry.mjs";
import { assertVideoHarnessProductionProfile } from "./videoHarnessProductionProfile.mjs";
import {
  REVIEWER_KEY_MATERIAL_VALUE_PATTERN,
  REVIEWER_KEY_OPTION_PATTERN,
  REVIEWER_TRUST_CONFLICT_CODE,
  REVIEWER_TRUST_OPTION_PATTERN,
  REVIEWER_TRUST_PATH_ENV,
  REVIEWER_TRUST_UNCONFIGURED_CODE,
  loadReviewerTrust,
  preflightReviewerTrust,
} from "./koyaReviewAttestation.mjs";
import { runHarnessDoctor } from "../scripts/harness-doctor.mjs";

export const VIDEO_HARNESS_SERVICE_RESULT_VERSION = "buzzassist-video-harness-service-result-v1";
export { REVIEWER_TRUST_CONFLICT_CODE, REVIEWER_TRUST_UNCONFIGURED_CODE };
export const REVIEWER_KEY_OPTION_REJECTED_CODE = "reviewer-key-in-options";

// reviewer 秘密鍵は production Job のどこにも載らない（path であっても）。signoff は別 context の
// reviewer 工程で、koya-manga-video.mjs / narrated-story-video.mjs の signoff から行う（F-6）。
// パターン定数は lib/koyaReviewAttestation.mjs に 1 つだけ置き、Job 層（videoHarnessJob）と共有する（R6-F6）。
const REVIEWER_KEY_FIELD_PATTERN = REVIEWER_KEY_OPTION_PATTERN;
const KEY_MATERIAL_VALUE_PATTERN = REVIEWER_KEY_MATERIAL_VALUE_PATTERN;
const SENSITIVE_FIELD_PATTERN = /(?:authorization$|credentials?$|password$|secrets?$|token$|api[-_]?key$|pem$|private[-_]?key|(?:client|signing|trusted|reviewer)[-_]?key|key[-_]?path$)/iu;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

// reviewer 信頼リストの置き場所は要求側が Job options で決められない（信頼アンカーの差し替え防止・R4-1）。
// 唯一の信頼アンカーは運営者の環境変数 BUZZASSIST_REVIEWER_TRUST / _JSON（旧 BUZZASSIST_KOYA_* は互換、
// 新旧不一致は env-ambiguous）。start/resume の実行時引数 reviewerTrustPath（Job identity 外）は
// その env との**照合用**でしかなく、env 未設定なら明示 path があっても reviewer-trust-unconfigured で
// fail-closed（R5-1）。「未設定の実行側が path で代替する」経路は存在しない。
const TRUST_ANCHOR_FIELD_PATTERN = REVIEWER_TRUST_OPTION_PATTERN;

function assertNoSensitiveFields(value, path = "options", seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveFields(item, `${path}[${index}]`, seen));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (TRUST_ANCHOR_FIELD_PATTERN.test(key)) {
      throw new Error(`reviewer-trust-path-in-options: ${path}.${key} は Job options に書けない。信頼リストの唯一の信頼アンカーは運営者の環境変数 ${REVIEWER_TRUST_PATH_ENV} で、実行時引数 reviewerTrustPath はそれとの照合にだけ使う。`);
    }
    if (REVIEWER_KEY_FIELD_PATTERN.test(key)) {
      throw new Error(`${REVIEWER_KEY_OPTION_REJECTED_CODE}: ${path}.${key} は production Job に書けない（reviewer 鍵は中身も path も Job に載せない）。signoff は別 context の reviewer 工程で、koya-manga-video.mjs / narrated-story-video.mjs の signoff（MCP: run_koya_manga_pipeline signoff / signoff_video_harness_job）から --reviewer-key-path で行う。`);
    }
    if (SENSITIVE_FIELD_PATTERN.test(key)) {
      throw new Error(`${path}.${key} はJobへ保存できない秘密フィールド。Channel Packには検証済みbundleのpathだけを渡すこと。`);
    }
    if (typeof child === "string" && KEY_MATERIAL_VALUE_PATTERN.test(child)) {
      throw new Error(`${REVIEWER_KEY_OPTION_REJECTED_CODE}: ${path}.${key} に鍵または信頼リストの中身が含まれている。Job options には path だけを渡す。`);
    }
    assertNoSensitiveFields(child, `${path}.${key}`, seen);
  }
}

/**
 * reviewer 信頼リストの唯一の信頼アンカーは運営者の環境変数（BUZZASSIST_REVIEWER_TRUST /
 * BUZZASSIST_REVIEWER_TRUST_JSON。旧 BUZZASSIST_KOYA_REVIEWER_TRUST(_JSON) は互換で読み、新旧不一致は
 * env-ambiguous）。CLI / MCP から来る明示 reviewerTrustPath は**照合用**でしかない:
 *
 * - env 設定あり: 明示 path の canonical sha256 が env の内容と一致しなければ reviewer-trust-conflict
 * - env 未設定:   明示 path があっても reviewer-trust-unconfigured で fail-closed
 *   （要求側の入力だけで信頼アンカーを立てられると、生成側が自分で鍵を作り自分で信頼リストへ登録し
 *   自分で署名する「自己承認」へ退化する。R5-1）
 *
 * 規則の実装は koyaReviewAttestation.loadReviewerTrust の1箇所（両ハーネス・Job 層・Receipt と共通）。
 * ここは service / MCP reviewer 工程が同じ呼び方をするための薄い入口で、一致した場合は env 側の
 * 信頼リストを返す。呼び出し側はこれで検証済みの path を子 CLI へ渡してよい（子側も同じ env と照合する）。
 * 失敗コードは `${REVIEWER_TRUST_UNCONFIGURED_CODE}` / `${REVIEWER_TRUST_CONFLICT_CODE}` / env-ambiguous。
 */
export async function assertReviewerTrustPathAgreesWithOperator({
  reviewerTrustPath = "",
  env = process.env,
  loadTrust = loadReviewerTrust,
} = {}) {
  const requestedPath = nonEmpty(reviewerTrustPath);
  if (!requestedPath) return null;
  return loadTrust({ trustPath: resolve(requestedPath), env });
}

function sensitiveValues(value, output = new Set(), seen = new Set(), depth = 0) {
  if (!value || typeof value !== "object" || seen.has(value) || depth > 12 || output.size >= 256) return output;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_FIELD_PATTERN.test(key) && ["string", "number"].includes(typeof child)) output.add(String(child));
    else sensitiveValues(child, output, seen, depth + 1);
  }
  return output;
}

function publicText(value, secrets, limit = 8_000) {
  let text = redactSecrets(String(value ?? ""), secrets);
  for (const secret of secrets) {
    if (secret.length >= 4 && secret.length < 8) text = text.split(secret).join("[redacted]");
  }
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 14))}…[truncated]`;
}

function publicValue(value) {
  const secrets = [...sensitiveValues(value)];
  const seen = new Set();
  const visit = (current, depth = 0) => {
    if (typeof current === "string") return publicText(current, secrets);
    if (["number", "boolean"].includes(typeof current) || current === null) return current;
    if (current === undefined) return null;
    if (typeof current !== "object" || depth >= 12 || seen.has(current)) return "[bounded]";
    seen.add(current);
    if (Array.isArray(current)) return current.slice(0, 1000).map((item) => visit(item, depth + 1));
    const output = {};
    for (const [key, child] of Object.entries(current).slice(0, 1000)) {
      if (!SENSITIVE_FIELD_PATTERN.test(key)) output[publicText(key, secrets, 300)] = visit(child, depth + 1);
    }
    return output;
  };
  return visit(value);
}

function jobSummary(job) {
  return {
    id: job.id,
    harnessId: job.harness?.id || "",
    status: job.status,
    updatedAt: job.updatedAt,
    blockers: Array.isArray(job.blockers) ? job.blockers.map(String) : [],
    knownRemainingIssues: Array.isArray(job.knownRemainingIssues) ? job.knownRemainingIssues.map(String) : [],
  };
}

function serviceResult({
  operation,
  projectDir,
  job = null,
  jobs = [],
  attached = null,
  executionMode = "none",
  confirmed = false,
  note = "",
  reviewerTrust = null,
} = {}) {
  const publicJob = job ? publicValue(job) : null;
  const publicJobs = jobs.map((entry) => publicValue(entry));
  return {
    version: VIDEO_HARNESS_SERVICE_RESULT_VERSION,
    ok: true,
    operation,
    projectDir: resolve(projectDir),
    jobId: publicJob?.id || null,
    status: publicJob?.status || null,
    job: publicJob,
    jobs: publicJobs,
    attached,
    execution: {
      mode: executionMode,
      confirmed: confirmed === true,
      started: executionMode === "execute",
      planOnly: executionMode === "plan-only",
    },
    // 有料実行前 preflight の結果（R6-1）。plan-only では警告として残し、execute では ok のときだけ到達する。
    reviewerTrust: reviewerTrust
      ? {
        ok: reviewerTrust.ok === true,
        code: String(reviewerTrust.code || ""),
        activeReviewers: Number(reviewerTrust.activeReviewers) || 0,
        source: String(reviewerTrust.source || ""),
      }
      : null,
    note: String(note || ""),
  };
}

const DEFAULT_RUNTIME = Object.freeze({
  createJob: createVideoHarnessJob,
  readJob: readVideoHarnessJob,
  cancelJob: requestVideoHarnessCancellation,
  runJob: runVideoHarnessJob,
  withJobLock: withVideoHarnessJobLock,
  prepare: prepareVideoHarnessJob,
  doctor: runHarnessDoctor,
  adapter: executeVideoHarnessAdapter,
  projectCanvas: projectVideoHarnessJob,
  productionProfile: assertVideoHarnessProductionProfile,
  readDirectory: readdir,
  env: process.env,
  loadReviewerTrust,
  preflightReviewerTrust,
});

/** Tests and alternate hosts may replace dependencies, while production uses one shared service. */
export function createVideoHarnessService(overrides = {}) {
  const runtime = { ...DEFAULT_RUNTIME, ...overrides };

  // reviewer 信頼リストは path だけを受け取る。中身（鍵）を引数に取らず、Job identity
  // にも入れない（実行側の端末ごとの置き場所で Job ID が変わらないように）。
  // path は照合用: 運営者の環境変数と一致しなければ reviewer-trust-conflict、環境変数が
  // 未設定なら reviewer-trust-unconfigured で、durable 作成・有料実行のどちらにも進まない。
  function reviewerTrustPathOf(value) {
    if (value === undefined || value === null || value === "") return "";
    if (typeof value !== "string" || !value.trim()) throw new Error("reviewerTrustPath は信頼リストJSONの path 文字列であること。");
    if (/-----BEGIN|"reviewers"\s*:/u.test(value)) {
      throw new Error("reviewerTrustPath には path だけを渡す。信頼リストや鍵の中身を引数に書かない。");
    }
    return resolve(value.trim());
  }

  async function verifiedReviewerTrustPath(value) {
    const trustPath = reviewerTrustPathOf(value);
    if (!trustPath) return "";
    await assertReviewerTrustPathAgreesWithOperator({
      reviewerTrustPath: trustPath,
      env: runtime.env,
      loadTrust: runtime.loadReviewerTrust,
    });
    return trustPath;
  }

  /**
   * 有料 adapter 起動前の信頼アンカー preflight（R6-1）。
   *
   * 明示 path の照合（verifiedReviewerTrustPath）だけでは、env 未設定・env-ambiguous・全件 revoked の
   * host で path を渡さない要求が素通りし、有料生成が丸ごと走ってから Receipt 確定
   * （reviewer-trust-unconfigured）で止まっていた。ここで「env に設定され、読めて、active 鍵が 1 件以上」
   * を確かめ、満たさなければ durable Job を作らず・有料 adapter を一度も呼ばずに止める。
   * plan-only は有料処理へ進まないので例外: 結果の reviewerTrust に警告として載せるだけ。
   */
  async function preflightTrustAnchor({ reviewerTrustPath = "", planOnly = false } = {}) {
    const result = await runtime.preflightReviewerTrust({
      trustPath: reviewerTrustPath,
      env: runtime.env,
      loadTrust: runtime.loadReviewerTrust,
    });
    if (result.ok === true || planOnly) return result;
    throw new Error(
      `${result.code}: 有料実行前の信頼アンカー preflight で停止。Job は作成せず有料 adapter も起動していない。`
      + ` 運営者が ${REVIEWER_TRUST_PATH_ENV}（または _JSON）に active な reviewer 鍵を含む信頼リストを設定してから start/resume すること。`
      + ` 原因: ${result.detail}`,
    );
  }

  async function execute(projectDir, jobId, { reviewerTrustPath = "" } = {}) {
    const planned = await runtime.readJob({ projectDir, jobId });
    await runtime.productionProfile({ job: planned });
    // 照合済みの path は Receipt 確定（Job 層）だけでなく子 CLI にも同じものを渡し、
    // 両層が同じ信頼リストを使うことを保証する（F-3。子側は env と照合する）。
    const adapter = reviewerTrustPath
      ? (context) => runtime.adapter({ ...context, reviewerTrustPath })
      : runtime.adapter;
    return runtime.withJobLock({ projectDir, jobId }, () => runtime.runJob({
      projectDir,
      jobId,
      prepare: runtime.prepare,
      doctor: runtime.doctor,
      adapter,
      projectCanvas: runtime.projectCanvas,
      validateProductionProfile: runtime.productionProfile,
      ...(reviewerTrustPath ? { reviewerTrustPath } : {}),
    }));
  }

  async function start({
    projectDir = process.cwd(),
    scriptPath,
    harnessId = "",
    want = "",
    channelPackPath,
    options = {},
    confirmed = false,
    reviewerTrustPath = "",
  } = {}) {
    const project = resolve(projectDir);
    const script = nonEmpty(scriptPath);
    const channelPack = nonEmpty(channelPackPath);
    if (!script) throw new Error("run_video_harness/start には scriptPath が要る。");
    if (!channelPack) throw new Error("本番上位Jobには署名済み Channel Pack の channelPackPath が要る。");
    if (!plainObject(options)) throw new Error("options はJSON objectであること。");
    assertNoSensitiveFields(options);
    const trustPath = await verifiedReviewerTrustPath(reviewerTrustPath);
    // R6-1: confirmed なら durable 作成の前に止める。plan-only は警告として結果へ。
    const reviewerTrust = await preflightTrustAnchor({ reviewerTrustPath: trustPath, planOnly: confirmed !== true });

    const created = await runtime.createJob({
      projectDir: project,
      scriptPath: resolve(script),
      harnessId: nonEmpty(harnessId),
      want: nonEmpty(want),
      channelPackPath: resolve(channelPack),
      options: structuredClone(options),
    });
    await runtime.productionProfile({ job: created.job });
    await runtime.projectCanvas(created.job);
    if (confirmed !== true) {
      return serviceResult({
        operation: "start",
        projectDir: project,
        job: created.job,
        attached: created.attached === true,
        executionMode: "plan-only",
        reviewerTrust,
        note: "計画だけを保存。有料処理は未実行。同じJobを resume_video_harness_job confirmed=true で再開できる。"
          + (reviewerTrust.ok === true
            ? ""
            : ` 警告 ${reviewerTrust.code}: reviewer 信頼アンカーが未整備のため、このまま resume すると有料実行前 preflight で止まる。運営者が ${REVIEWER_TRUST_PATH_ENV} を設定してから resume すること。`),
      });
    }

    const job = await execute(project, created.job.id, { reviewerTrustPath: trustPath });
    return serviceResult({
      operation: "start",
      projectDir: project,
      job,
      attached: created.attached === true,
      executionMode: "execute",
      confirmed: true,
      reviewerTrust,
    });
  }

  async function resume({ projectDir = process.cwd(), jobId, confirmed = false, reviewerTrustPath = "" } = {}) {
    const project = resolve(projectDir);
    const id = nonEmpty(jobId);
    if (!id) throw new Error("resume には jobId が要る。");
    if (confirmed !== true) throw new Error("resume は有料生成へ進み得るため confirmed=true が要る。");
    const trustPath = await verifiedReviewerTrustPath(reviewerTrustPath);
    // R6-1: resume は常に有料へ進み得るので、adapter 起動前に信頼アンカーを確かめる。
    const reviewerTrust = await preflightTrustAnchor({ reviewerTrustPath: trustPath, planOnly: false });
    const job = await execute(project, id, { reviewerTrustPath: trustPath });
    return serviceResult({
      operation: "resume",
      projectDir: project,
      job,
      executionMode: "execute",
      confirmed: true,
      reviewerTrust,
    });
  }

  async function get({ projectDir = process.cwd(), jobId } = {}) {
    const project = resolve(projectDir);
    const id = nonEmpty(jobId);
    if (!id) throw new Error("get/status には jobId が要る。");
    const job = await runtime.readJob({ projectDir: project, jobId: id });
    return serviceResult({ operation: "get", projectDir: project, job });
  }

  async function cancel({ projectDir = process.cwd(), jobId } = {}) {
    const project = resolve(projectDir);
    const id = nonEmpty(jobId);
    if (!id) throw new Error("cancel には jobId が要る。");
    const job = await runtime.cancelJob({ projectDir: project, jobId: id });
    await runtime.projectCanvas(job);
    return serviceResult({ operation: "cancel", projectDir: project, job });
  }

  async function list({ projectDir = process.cwd() } = {}) {
    const project = resolve(projectDir);
    const root = join(project, "canvas", "harness-runs");
    let entries = [];
    try {
      entries = await runtime.readDirectory(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const jobs = [];
    const directories = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("video-"))
      .sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of directories) {
      try {
        jobs.push(jobSummary(await runtime.readJob({ projectDir: project, jobId: entry.name })));
      } catch {
        // 1つの破損runで、他の正常なrunの一覧まで読めなくしない。
      }
    }
    return serviceResult({ operation: "list", projectDir: project, jobs });
  }

  return Object.freeze({ start, resume, get, cancel, list });
}

export const videoHarnessService = createVideoHarnessService();

export const _testing = Object.freeze({ assertNoSensitiveFields, jobSummary, publicValue, serviceResult });
