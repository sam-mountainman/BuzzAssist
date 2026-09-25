// Claude Code / Codex 共通の「台本 -> 完成動画」上位ジョブ。
//
// この層は動画を自分で作らない。どのジャンルハーネスを使うかを一意に決め、
// doctor を有料処理より先に通し、同じ Job ID で中断・再開できる状態を保存する。
// 実際の画像・音声・レンダーは adapter が担当する。上位層が shell 文字列を
// 組み立てないため、Claude Code と Codex で別経路にならない。

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "./atomicJsonFile.mjs";
import { canonicalJson } from "./channelPackEnvelope.mjs";
import { validateChannelPackRuntime } from "./harnessChannelPackRuntime.mjs";
import {
  loadHarnessDeployments,
  resolveHarnessDeployment,
  resolveHarnessDeploymentCommand,
} from "./harnessDeploymentResolver.mjs";
import { appendResumedInvocation, createJobInvocationRecord } from "./harnessHostProvenance.mjs";
import { redactSecrets } from "./paidApiRetry.mjs";
import { readPaidCallGuardLedger } from "./paidCallGuard.mjs";
import { createPaidMediaJobBroker } from "./paidMediaJobBroker.mjs";
import { productionDependencyIdentity } from "./productionDependencyManifest.mjs";
import {
  assertVideoHarnessProductionProfile,
  VIDEO_HARNESS_PRODUCTION_PROFILE,
} from "./videoHarnessProductionProfile.mjs";
import { createVideoHarnessRunReceipt } from "./videoHarnessReceipt.mjs";
import {
  assertVideoHarnessExecutionIdentity,
  createVideoHarnessExecutionIdentityDigest,
} from "./videoHarnessExecutionIdentity.mjs";
import {
  DEFAULT_KOYA_CONTRACT_SCHEMA_PATH,
  resolveKoyaMangaProductionContract,
} from "./koyaMangaProductionContract.mjs";
import {
  REVIEWER_KEY_OPTION_PATTERN,
  REVIEWER_TRUST_CONFLICT_CODE,
  REVIEWER_TRUST_OPTION_PATTERN as SHARED_REVIEWER_TRUST_OPTION_PATTERN,
  loadReviewerTrust,
} from "./koyaReviewAttestation.mjs";
import {
  CANONICAL_IDENTITY_DRIFT_CODE,
  FINALIZE_AFTER_UPDATE_BLOCKING_CODES,
  FINALIZE_AFTER_UPDATE_DIR,
  FINALIZE_AFTER_UPDATE_HINT,
  FINALIZE_AFTER_UPDATE_INPUT_CHANGED_CODE,
  FINALIZE_AFTER_UPDATE_INPUT_UNRECORDED_CODE,
  FINALIZE_AFTER_UPDATE_NOT_NEEDED_CODE,
  FINALIZE_AFTER_UPDATE_PAID_CALL_REQUIRED_CODE,
  FINALIZE_AFTER_UPDATE_PINNED_CONTRACT_UNAVAILABLE_CODE,
  PINNED_PRODUCTION_CONTRACT_FILE,
  appendFinalizeRun,
  codeIdentitySummary,
  compareOperatorImports,
  episodeOverrideChanged,
  finalizeAfterUpdateError,
  findPinnedKoyaProductionContract,
  inputIdentityRecord,
  isFinalizeAfterUpdateJob,
  nextCodeIdentityRebind,
  operatorImportDigests,
  plannedCanonicalIdentityOf,
  readRebindPinnedProductionContract,
  videoHarnessInputIdentity,
  writePinnedProductionContractForFinalize,
} from "./videoHarnessUpdateFinalize.mjs";
import { analyzeHarnessRequest, loadHarnesses } from "../scripts/harness-registry.mjs";

export const VIDEO_HARNESS_JOB_VERSION = "buzzassist-video-harness-job-v1";
export const VIDEO_HARNESS_UPSTREAM_EXECUTION_VERSION = "buzzassist-video-harness-upstream-execution-v1";
export const VIDEO_HARNESS_PENDING_RECEIPT_VERSION = "buzzassist-video-harness-pending-receipt-v1";
export const RECEIPT_FINALIZATION_BLOCKER = "run-receipt-finalization";
export const RECEIPT_ARTIFACT_DRIFT_BLOCKER = "run-receipt-artifact-drift";
export const VIDEO_HARNESS_FAILED_RESUME_VERSION = "buzzassist-video-harness-failed-resume-v1";
/** failed Job の resume を拒否するときの失敗コード（journal 破損・workspace 欠落など、直せない状態）。 */
export const FAILED_JOB_UNRECOVERABLE_CODE = "video-harness-failed-job-unrecoverable";
export const JOB_JOURNAL_CORRUPT_CODE = "video-harness-job-journal-corrupt";
/** provider が仕事を受理した可能性のある Media Job が recover で決着するまで、adapter を起動しない。 */
export const PAID_MEDIA_RECOVERY_BLOCKER = "paid-media-recovery-pending";
const MEDIA_JOB_RECOVERY_REQUIRED = "recovery-required";
/** recover の後に adapter を起動してよい Media Job の状態。failed は broker が「未課金」と確定した状態。 */
const MEDIA_JOB_SETTLED = new Set(["completed", "failed", "cancelled"]);
const MAX_FAILED_RESUME_HISTORY = 50;
export { REVIEWER_TRUST_CONFLICT_CODE };
export const REVIEWER_TRUST_OPTION_REJECTED_CODE = "reviewer-trust-path-in-options";
export const REVIEWER_KEY_MATERIAL_OPTION_REJECTED_CODE = "reviewer-key-material-in-options";
/**
 * 企画ブリーフ（lib/strategyBrief.mjs）の SHA-256。任意の options で、Job の識別子に入る（別のブリーフなら別の Job）。
 * 中身は Job に持たない。形だけを確かめる。
 */
export const STRATEGY_BRIEF_OPTION_KEY = "strategyBriefSha256";
export const STRATEGY_BRIEF_OPTION_INVALID_CODE = "strategy-brief-sha256-invalid";
/** Job JSON に残す identity drift の痕跡の上限（Receipt 確定後も消さない。R5-2）。 */
const MAX_DRIFT_HISTORY = 50;
/**
 * Job options に信頼リストの置き場所を書かせない。options は要求側（MCP を叩く agent / Job を
 * 作った側）が決める値で、jobIdentityDigest の材料でもある。ここに信頼アンカーが入ると、
 * 運営者が環境変数で配った信頼リストを要求側が黙って別のものへ差し替えられる。
 */
const REVIEWER_TRUST_OPTION_PATTERN = SHARED_REVIEWER_TRUST_OPTION_PATTERN;
/**
 * reviewer 鍵は中身（PEM）も path も Job options に載せない。service 層と**同じ定数**
 * （koyaReviewAttestation.REVIEWER_KEY_OPTION_PATTERN）を使う——以前は Job 層だけが
 * reviewerKeyPath を通し、拒否範囲が層ごとに食い違っていた（R6-F6）。
 */
const REVIEWER_KEY_MATERIAL_OPTION_PATTERN = REVIEWER_KEY_OPTION_PATTERN;
export const VIDEO_HARNESS_JOB_STATUSES = Object.freeze([
  "planned",
  "preflight-running",
  "blocked-preflight",
  "awaiting-human-review",
  "queued",
  "running",
  "cancel-requested",
  "cancelled",
  "failed",
  "completed",
]);

const TERMINAL = new Set(["cancelled", "failed", "completed"]);
const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_IDENTITY_PATHS = Object.freeze([
  "package.json",
  "lib/channelPackEnvelope.mjs",
  "lib/harnessChannelPackRuntime.mjs",
  "lib/harnessDeploymentResolver.mjs",
  "lib/harnessRuntimeResolver.mjs",
  "lib/koyaMangaProductionContract.mjs",
  "lib/koyaOuterJobBinding.mjs",
  "lib/paidMediaJobBroker.mjs",
  "lib/videoHarnessJob.mjs",
  "lib/videoHarnessAdapters.mjs",
  "lib/videoHarnessCanvasAdapter.mjs",
  "lib/videoHarnessProductionProfile.mjs",
  "lib/videoHarnessReceipt.mjs",
  "lib/videoHarnessService.mjs",
  "config/koya-manga-production-contract.json",
  "config/koya-manga-production-contract.schema.json",
  "scripts/harness-doctor.mjs",
  "scripts/run-video-harness.mjs",
]);
const MAX_PERSISTED_TEXT = 4_000;
const RUNTIME_IDENTITY_FIELDS = Object.freeze([
  "imageModel",
  "ttsProvider",
  "imageProvider",
  "imageAdapterVersion",
  "ttsModel",
  "ttsAdapterVersion",
  "musicProvider",
  "musicModel",
  "musicAdapterVersion",
]);
const ADAPTER_PROBE_FIELDS = Object.freeze([
  "ok",
  "status",
  "kind",
  "provider",
  "model",
  "adapterVersion",
  "httpStatus",
  "serverVersion",
  "detail",
]);

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function boundedText(value, secrets = [], limit = MAX_PERSISTED_TEXT) {
  const redacted = redactSecrets(String(value ?? ""), secrets);
  if (redacted.length <= limit) return redacted;
  return `${redacted.slice(0, Math.max(0, limit - 14))}…[truncated]`;
}

function collectSensitiveValues(value, output = new Set(), seen = new Set(), depth = 0) {
  if (!value || typeof value !== "object" || seen.has(value) || depth > 12 || output.size >= 256) return output;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (/(?:authorization$|credentials?$|password$|secrets?$|token$|api[-_]?key$|(?:client|private|signing|trusted)[-_]?key$)/iu.test(key)) {
      if (["string", "number"].includes(typeof child)) output.add(String(child));
    } else collectSensitiveValues(child, output, seen, depth + 1);
  }
  return output;
}

async function sha256File(path) {
  return sha256(await readFile(path));
}

async function sha256Tree(root) {
  const hash = createHash("sha256");
  let fileCount = 0;
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
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
  if (fileCount === 0) throw new Error("Channel Pack bundleが空。署名・manifestを検証できない。");
  return { digest: hash.digest("hex"), fileCount };
}

async function currentCoreIdentity() {
  const files = [];
  for (const relativePath of CORE_IDENTITY_PATHS) {
    files.push({ relativePath, sha256: await sha256File(join(MODULE_ROOT, relativePath)) });
  }
  const packageManifest = JSON.parse(await readFile(join(MODULE_ROOT, "package.json"), "utf8"));
  return {
    version: String(packageManifest.version || ""),
    files,
    sha256: sha256(canonicalJson(files)),
  };
}

async function canonicalSkillsFromDeclaration(declaration, repositoryRoot) {
  const rows = [];
  for (const declared of declaration?.canonicalSkills || []) {
    const path = resolve(repositoryRoot, declared);
    rows.push({
      id: basename(dirname(path)),
      version: "content-sha",
      path,
      sha256: await sha256File(path),
    });
  }
  if (rows.length === 0) throw new Error(`Harness ${declaration?.id || "(不明)"} にcanonicalSkillsが無い。`);
  return rows;
}

async function canonicalProductionContractIdentity(harnessId) {
  if (harnessId !== "koya-manga-video") return null;
  const resolvedContract = await resolveKoyaMangaProductionContract({ projectDir: MODULE_ROOT });
  return {
    version: "buzzassist-canonical-production-contract-v1",
    harnessId,
    contractVersion: resolvedContract.contract.version,
    contractDigest: resolvedContract.digest,
    contractPath: resolve(resolvedContract.contractPath),
    contractFileSha256: await sha256File(resolvedContract.contractPath),
    schemaPath: resolve(DEFAULT_KOYA_CONTRACT_SCHEMA_PATH),
    schemaFileSha256: await sha256File(DEFAULT_KOYA_CONTRACT_SCHEMA_PATH),
  };
}

async function resolveExecutionContractWithContent(job, projectDir) {
  const resolvedContract = await resolveKoyaMangaProductionContract({
    projectDir: resolve(projectDir),
    episodeId: nonEmpty(job?.options?.episodeId) || undefined,
    contractPath: nonEmpty(job?.options?.contractPath) || undefined,
    overridePath: nonEmpty(job?.options?.overridePath) || undefined,
  });
  const episodeOverridePath = nonEmpty(resolvedContract.episodeOverridePath);
  return {
    contract: resolvedContract.contract,
    record: {
      version: "buzzassist-resolved-production-contract-v1",
      harnessId: "koya-manga-video",
      episodeId: nonEmpty(job?.options?.episodeId),
      contractVersion: resolvedContract.contract.version,
      contractDigest: resolvedContract.digest,
      contractPath: resolve(resolvedContract.contractPath),
      contractFileSha256: await sha256File(resolvedContract.contractPath),
      contractSource: nonEmpty(resolvedContract.contractSource),
      episodeOverridePath: episodeOverridePath ? resolve(episodeOverridePath) : "",
      episodeOverrideFileSha256: episodeOverridePath ? await sha256File(episodeOverridePath) : "",
    },
  };
}

/**
 * 更新をまたいで確定させる Job（付け替えた Job）の Koya の制作契約。リポジトリの契約を解決し直さず、
 * Job に固定した写しの中身（digest・版）と、回の上書き（入力）が変わっていないことを確かめて、固定値を返す。
 */
async function pinnedExecutionContractForRebind(job) {
  const pinned = await readRebindPinnedProductionContract(job);
  if (!pinned) return null;
  if (await episodeOverrideChanged(job)) {
    throw new Error(`${FINALIZE_AFTER_UPDATE_INPUT_CHANGED_CODE}: Koya の回の上書き（episode override）が固定した後に変わった。新しいJobとして計画し直すこと。`);
  }
  return job.resolvedProductionContract;
}

/**
 * Resolve the exact Koya contract that the isolated execution workspace will
 * use, including a signed episode override. This is persisted before doctor
 * and re-resolved before paid dispatch/finalization; a report cannot choose an
 * arbitrary self-consistent digest.
 *
 * 更新をまたいで確定させる Job は、リポジトリの今の契約ではなく Job に固定した写しで確かめる。
 */
export async function resolveVideoHarnessExecutionContract(job, {
  projectDir = job?.executionProjectDir || job?.projectDir,
} = {}) {
  if (job?.harness?.id !== "koya-manga-video") return null;
  const pinned = await pinnedExecutionContractForRebind(job);
  if (pinned) return pinned;
  return (await resolveExecutionContractWithContent(job, projectDir)).record;
}

/**
 * いまのコードの同一性。strict では、宣言の版と canonicalSkills の並びが Job の記録と同じことも求める
 * （ふつうの resume）。更新をまたいで確定させるときは strict を外し、宣言の版・スキルの並びが変わった
 * 更新でも、いまの値を返す（付け替えるのは呼び出し側）。
 */
async function computeCodeIdentity(job, validateProductionProfile = assertVideoHarnessProductionProfile, { strict = true } = {}) {
  const planned = job?.canonicalIdentity;
  if (!planned || typeof planned !== "object") throw new Error("JobにcanonicalIdentityが無い。新しいJobとして計画し直すこと。");
  const repositoryRoot = resolve(nonEmpty(planned.repositoryRoot) || MODULE_ROOT);
  const deploymentRepositoryRoot = resolve(nonEmpty(planned.deploymentRepositoryRoot) || repositoryRoot);
  const declarationPath = resolve(nonEmpty(job.harness?.declarationPath) || nonEmpty(planned.harnessDeclaration?.path));
  const declaration = await readJson(declarationPath);
  if (declaration.id !== job.harness.id || (strict && declaration.version !== job.harness.declarationVersion)) {
    throw new Error("Harness宣言のid/versionがJob計画時と一致しない。");
  }
  const canonicalSkills = await canonicalSkillsFromDeclaration(declaration, repositoryRoot);
  const storedSkillPaths = (job.harness?.canonicalSkills || []).map((entry) => resolve(entry.path));
  if (strict && canonicalJson(canonicalSkills.map((entry) => entry.path)) !== canonicalJson(storedSkillPaths)) {
    throw new Error("Harness宣言のcanonicalSkillsがJob計画後に変わった。");
  }
  const deployment = resolveHarnessDeployment(job.harness.id, {
    repoRoot: deploymentRepositoryRoot,
    deploymentPath: job.deployment?.sourcePath,
  });
  const entrypointPath = resolveHarnessDeploymentCommand(deployment).entrypointPath;
  const profileJob = {
    ...job,
    harness: { ...job.harness, canonicalSkills },
  };
  const productionProfile = await validateProductionProfile({ job: profileJob, repoRoot: repositoryRoot });
  const canonicalIdentity = {
    repositoryRoot,
    deploymentRepositoryRoot,
    core: await currentCoreIdentity(),
    productionDependencies: productionDependencyIdentity({
      runtimeRoot: repositoryRoot,
      deploymentRoot: deployment.root,
    }),
    productionContract: await canonicalProductionContractIdentity(job.harness.id),
    harnessDeclaration: {
      path: declarationPath,
      sha256: await sha256File(declarationPath),
    },
    deployment: {
      root: deployment.root,
      entrypoint: deployment.entrypoint,
      entrypointPath,
      entrypointSha256: await sha256File(entrypointPath),
      sourcePath: deployment.sourcePath,
      sourceSha256: await sha256File(deployment.sourcePath),
    },
    skills: canonicalSkills.map(({ id, path, sha256: digest }) => ({ id, path, sha256: digest })),
    productionProfile,
  };
  return { canonicalIdentity, declaration, canonicalSkills };
}

async function canonicalIdentityForJob(job, validateProductionProfile = assertVideoHarnessProductionProfile) {
  return (await computeCodeIdentity(job, validateProductionProfile, { strict: true })).canonicalIdentity;
}

export async function assertVideoHarnessJobIdentity(job, {
  validateProductionProfile = assertVideoHarnessProductionProfile,
} = {}) {
  const actual = await canonicalIdentityForJob(job, validateProductionProfile);
  if (canonicalJson(actual) !== canonicalJson(job.canonicalIdentity)) {
    throw new Error(`Video Harnessのcanonical identityが計画後に変わった。Core・宣言・配置・Skill・profileを確認し、新しいJobとして計画し直すこと。${FINALIZE_AFTER_UPDATE_HINT}`);
  }
  if (job.harness?.id === "koya-manga-video" && job.resolvedProductionContract) {
    const currentContract = await resolveVideoHarnessExecutionContract(job);
    if (canonicalJson(currentContract) !== canonicalJson(job.resolvedProductionContract)) {
      throw new Error(`Koyaの解決済み制作契約がdoctor前の固定値から変わった。新しいJobとして計画し直すこと。${FINALIZE_AFTER_UPDATE_HINT}`);
    }
    assertVideoHarnessExecutionIdentity(job);
  } else if (job.harness?.id === "koya-manga-video" && job.executionIdentityDigest) {
    throw new Error("Koya Job has an execution identity without a resolved production contract.");
  }
  if (await sha256File(job.script.path) !== job.script.sha256) {
    throw new Error("Jobへ保存した台本が計画後に変わった。新しいJobとして計画し直すこと。");
  }
  let packDigest = "none";
  if (job.channelPack) {
    if (job.channelPack.kind === "directory") {
      const tree = await sha256Tree(job.channelPack.path);
      packDigest = tree.digest;
      if (tree.digest !== job.channelPack.sha256 || tree.fileCount !== job.channelPack.fileCount) {
        throw new Error("Channel PackがJob計画後に差し替えられた。新しいJobとして計画し直すこと。");
      }
    } else if (job.channelPack.kind === "file") {
      packDigest = await sha256File(job.channelPack.path);
      if (packDigest !== job.channelPack.sha256) throw new Error("Channel PackがJob計画後に差し替えられた。新しいJobとして計画し直すこと。");
    } else throw new Error("JobのChannel Pack kindが不正。");
  }
  // Job ID と identityDigest は計画時のコードの同一性から作った値のまま（更新をまたいで付け替えた Job も同じ）。
  const expectedIdentity = jobIdentityDigest({
    harnessId: job.harness.id,
    scriptDigest: job.script.sha256,
    packDigest,
    options: job.options,
    canonicalIdentity: plannedCanonicalIdentityOf(job),
  });
  if (expectedIdentity !== job.identityDigest || !job.id.endsWith(expectedIdentity.slice(0, 16))) {
    throw new Error("Job IDがcanonical identity・台本・Channel Pack・optionsの指紋と一致しない。");
  }
  return actual;
}

function jobIdentityDigest({ harnessId, scriptDigest, packDigest, options, canonicalIdentity }) {
  return sha256(canonicalJson({ harnessId, scriptDigest, packDigest, options, canonicalIdentity }));
}

function upstreamExecutionPayload(job = {}) {
  const doctor = (job.stages || []).find((stage) => stage?.id === "doctor") || {};
  return {
    version: VIDEO_HARNESS_UPSTREAM_EXECUTION_VERSION,
    jobId: nonEmpty(job.id),
    jobRevision: Number(job.revision),
    jobStatus: nonEmpty(job.status),
    identityDigest: nonEmpty(job.identityDigest),
    executionIdentityDigest: nonEmpty(job.executionIdentityDigest),
    harnessId: nonEmpty(job.harness?.id),
    scriptPath: nonEmpty(job.script?.path) ? resolve(job.script.path) : "",
    scriptSha256: nonEmpty(job.script?.sha256),
    executionProjectDir: nonEmpty(job.executionProjectDir || job.projectDir)
      ? resolve(job.executionProjectDir || job.projectDir)
      : "",
    deploymentEntrypointPath: nonEmpty(job.deployment?.entrypointPath)
      ? resolve(job.deployment.entrypointPath)
      : "",
    deploymentEntrypointSha256: nonEmpty(job.deployment?.entrypointSha256),
    productionDependenciesSha256: sha256(canonicalJson(job.canonicalIdentity?.productionDependencies ?? null)),
    doctorStatus: nonEmpty(doctor.status),
    doctorFinishedAt: nonEmpty(doctor.finishedAt),
    doctorEvidenceSha256: sha256(canonicalJson(doctor.evidence ?? null)),
  };
}

/**
 * Fingerprint passed to a genre child after the common doctor.  It is not a
 * bearer token: the child must re-read job.json and recompute canonical
 * identity before any paid provider is reachable.
 */
export function createVideoHarnessUpstreamExecutionBinding(job = {}) {
  return sha256(canonicalJson(upstreamExecutionPayload(job)));
}

export async function verifyVideoHarnessUpstreamExecution({
  upstreamJobPath,
  upstreamJobId,
  upstreamJobRevision,
  upstreamExecutionBinding,
  harnessId,
  scriptPath,
  validateProductionProfile = assertVideoHarnessProductionProfile,
} = {}) {
  const jobPath = resolve(nonEmpty(upstreamJobPath));
  const expectedJobId = nonEmpty(upstreamJobId);
  const expectedRevision = Number(upstreamJobRevision);
  const expectedBinding = nonEmpty(upstreamExecutionBinding);
  if (!nonEmpty(upstreamJobPath) || !expectedJobId
    || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
    || !/^[a-f0-9]{64}$/u.test(expectedBinding)
    || !nonEmpty(harnessId) || !nonEmpty(scriptPath)) {
    throw new Error("Upstream execution requires canonical job path, exact job id/revision, and binding together.");
  }
  const before = await lstat(jobPath);
  if (before.isSymbolicLink() || !before.isFile() || before.size <= 0) {
    throw new Error("Upstream execution job path must be a non-empty regular non-symlink file.");
  }
  const canonicalJobPath = await realpath(jobPath);
  const bytes = await readFile(canonicalJobPath);
  const after = await lstat(canonicalJobPath);
  if (after.isSymbolicLink() || !after.isFile()
    || before.dev !== after.dev || before.ino !== after.ino
    || before.size !== after.size || before.mtimeMs !== after.mtimeMs
    || bytes.length !== after.size) {
    throw new Error("Upstream execution job changed while it was being verified.");
  }
  const job = JSON.parse(bytes.toString("utf8"));
  if (!nonEmpty(job.runDir)
    || canonicalJobPath !== await realpath(resolve(job.runDir, "job.json"))) {
    throw new Error("Upstream execution path is not the Job's canonical durable job.json.");
  }
  if (job.id !== expectedJobId || Number(job.revision) !== expectedRevision) {
    throw new Error("Upstream execution Job id/revision is stale or belongs to another Job.");
  }
  if (createVideoHarnessUpstreamExecutionBinding(job) !== expectedBinding) {
    throw new Error("Upstream execution evidence changed after the parent launched the genre runner.");
  }
  if (job.status !== "running" || job.harness?.id !== nonEmpty(harnessId)) {
    throw new Error("Upstream execution Job is not the expected running harness Job.");
  }
  if (resolve(job.script?.path || "") !== resolve(nonEmpty(scriptPath))) {
    throw new Error("Upstream execution Job is bound to another script path.");
  }
  const doctor = (job.stages || []).find((stage) => stage?.id === "doctor");
  if (doctor?.status !== "pass" || doctor?.evidence?.ready !== true
    || (doctor.evidence.blocking || []).length > 0) {
    throw new Error("Upstream execution common doctor has not passed fail-closed.");
  }
  const actual = await assertVideoHarnessJobIdentity(job, { validateProductionProfile });
  const productionDependencies = actual?.productionDependencies;
  if (productionDependencies?.version !== "buzzassist-production-dependency-tree-v1") {
    throw new Error("Upstream execution lacks a verified production dependency tree.");
  }
  return {
    version: VIDEO_HARNESS_UPSTREAM_EXECUTION_VERSION,
    jobId: job.id,
    jobRevision: job.revision,
    harnessId: job.harness.id,
    identityDigest: job.identityDigest,
    executionIdentityDigest: job.executionIdentityDigest,
    productionDependencies,
  };
}

function safeIdPart(value) {
  return String(value || "run")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48) || "run";
}

function assertInside(parent, child, label = "path") {
  const rel = relative(resolve(parent), resolve(child));
  if (!rel || rel === ".") return;
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    throw new Error(`${label} が許可されたルート外を指している: ${child}`);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function runRoot(projectDir, jobId) {
  return join(resolve(projectDir), "canvas", "harness-runs", jobId);
}

export function videoHarnessJobPath(projectDir, jobId) {
  if (!/^video-[a-z0-9_-]+-[a-f0-9]{16}$/u.test(String(jobId || ""))) {
    throw new Error(`不正な video harness Job ID: ${jobId || "(空)"}`);
  }
  return join(runRoot(projectDir, jobId), "job.json");
}

export const VIDEO_HARNESS_CHOICE_REQUIRED_CODE = "video-harness-choice-required";
export const VIDEO_HARNESS_NO_MATCH_CODE = "video-harness-no-match";
export const VIDEO_HARNESS_UNKNOWN_CODE = "video-harness-unknown";
// 1位と、肯定で言及された別のハーネスとの点差がこれ未満なら、根拠が弱いとして1つに決めない。
const VIDEO_HARNESS_DECISIVE_MARGIN = 2;

function harnessChoiceRequired(rows, reason) {
  const candidates = rows.map((row) => ({
    id: row.harness.id,
    displayName: row.harness.displayName || row.harness.id,
    score: row.score,
    positiveHits: [...row.positiveHits],
    negatedHits: [...row.negatedHits],
  }));
  const question = `どちらにしますか: ${candidates.map((entry) => `${entry.displayName}（--harness ${entry.id}）`).join(" / ")}`;
  const error = new Error(
    `${VIDEO_HARNESS_CHOICE_REQUIRED_CODE}: 動画ハーネスを一意に選べない（${reason}）。${question}。`
    + "有料生成前に --harness で1つ指定すること。",
  );
  error.code = VIDEO_HARNESS_CHOICE_REQUIRED_CODE;
  error.reason = reason;
  error.question = question;
  error.candidates = candidates;
  return error;
}

/**
 * 依頼文と明示 ID から、ハーネスを1つに決められるかを判定する（例外を投げない純関数）。
 * start の選択（selectVideoHarness）と plan-request（lib/videoRequestPlan.mjs）が同じ判定を使う——
 * 別々に書くと、plan-request が「決まる」と言った依頼で start が止まる（またはその逆）。
 *
 * 返す status:
 *   selected         — 1つに決まった（harness / selectedBy / evidence）
 *   choice-required  — 決めきれない（reason と、選択肢にする行 choiceRows）
 *   no-match         — どのハーネスの手掛かりも依頼に無い
 *   unknown-harness  — 明示 ID が宣言に無い
 * rows は全ハーネスの解析結果（肯定の語・否定の語・点）で、呼び出し側が理由を並べるのに使う。
 */
export function decideVideoHarness({ harnesses = loadHarnesses(), harnessId = "", want = "" } = {}) {
  const rows = analyzeHarnessRequest(harnesses, want);
  const explicit = nonEmpty(harnessId);
  if (explicit) {
    const harness = harnesses.find((entry) => entry.id === explicit);
    if (!harness) return { status: "unknown-harness", harnessId: explicit, rows };
    return { status: "selected", harness, selectedBy: "explicit", evidence: { harnessId: explicit }, rows };
  }
  const mentioned = rows.filter((row) => row.positiveHits.length > 0 || row.negatedHits.length > 0);
  if (mentioned.length === 0) return { status: "no-match", rows };
  const candidates = rows.filter((row) => row.score > 0).sort((left, right) => right.score - left.score);
  if (candidates.length === 0) {
    return {
      status: "choice-required",
      reason: "否定されていない手掛かりが無い",
      reasonCode: "only-negated-terms",
      choiceRows: [...rows].sort((left, right) => right.score - left.score),
      rows,
    };
  }
  const topScore = candidates[0].score;
  const top = candidates.filter((entry) => entry.score === topScore);
  if (top.length !== 1) {
    return { status: "choice-required", reason: "最高点が同点", reasonCode: "tied-top-score", choiceRows: top, rows };
  }
  const rival = rows
    .filter((row) => row !== top[0] && row.positiveHits.length > 0)
    .sort((left, right) => right.score - left.score)[0];
  if (rival && topScore - rival.score < VIDEO_HARNESS_DECISIVE_MARGIN) {
    return {
      status: "choice-required",
      reason: "両方に言及していて点差が小さい",
      reasonCode: "narrow-margin",
      choiceRows: [top[0], rival],
      rows,
    };
  }
  return {
    status: "selected",
    harness: top[0].harness,
    selectedBy: "capability-match",
    evidence: { score: top[0].score, hits: [...top[0].hits], negatedHits: [...top[0].negatedHits] },
    rows,
  };
}

/**
 * 明示 ID を最優先し、依頼文から推測するときは根拠が十分なときだけ1つに決める。
 * 曖昧なまま有料 API を呼ぶより、候補を返して人に一度だけ選んでもらう。
 *
 * 依頼文の否定の節（〜は使わず、〜ではなく、〜なし、not / without）の語は減点する。
 * 1つに決めないのは、(1) 最高点が同点、(2) 肯定の語が1つも残らないのに語自体は当たっている、
 * (3) 別のハーネスにも肯定で言及していて点差が小さい、のとき。そのときは候補と
 * 「どちらにしますか」の1問を理由コードつきの例外で返す（Job は作らない）。
 * 判定そのものは decideVideoHarness にあり、ここは例外に言い換えるだけ。
 */
export function selectVideoHarness({ harnesses = loadHarnesses(), harnessId = "", want = "" } = {}) {
  const decision = decideVideoHarness({ harnesses, harnessId, want });
  if (decision.status === "selected") {
    return { harness: decision.harness, selectedBy: decision.selectedBy, evidence: decision.evidence };
  }
  if (decision.status === "unknown-harness") {
    const error = new Error(`未知のハーネス: ${decision.harnessId}`);
    error.code = VIDEO_HARNESS_UNKNOWN_CODE;
    throw error;
  }
  if (decision.status === "no-match") {
    const error = new Error("依頼に一致する動画ハーネスが無い。--harness で明示すること。");
    error.code = VIDEO_HARNESS_NO_MATCH_CODE;
    throw error;
  }
  throw harnessChoiceRequired(decision.choiceRows, decision.reason);
}

export { loadHarnessDeployments, resolveHarnessDeployment };

export async function readVideoHarnessJob({ projectDir = process.cwd(), jobId } = {}) {
  return readJson(videoHarnessJobPath(projectDir, jobId));
}

async function withJobWriteLock(jobPath, action, recoveryAttempt = 0) {
  const lockPath = `${jobPath}.write.lock`;
  let handle;
  try {
    handle = await open(lockPath, "wx");
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let owner = null;
    try { owner = JSON.parse(await readFile(lockPath, "utf8")); } catch { /* 保守的に競合扱い */ }
    if (owner && !processIsAlive(Number(owner.pid)) && recoveryAttempt === 0) {
      await rm(lockPath, { force: true });
      return withJobWriteLock(jobPath, action, recoveryAttempt + 1);
    }
    const conflict = new Error("Video Harness Job is being updated concurrently.");
    conflict.code = "VIDEO_HARNESS_JOB_WRITE_BUSY";
    throw conflict;
  }
  try {
    return await action();
  } finally {
    await handle?.close();
    await rm(lockPath, { force: true });
  }
}

async function writeJob(job) {
  if (!VIDEO_HARNESS_JOB_STATUSES.includes(job.status)) throw new Error(`不正な Job status: ${job.status}`);
  const path = videoHarnessJobPath(job.projectDir, job.id);
  const expectedRevision = Number.isSafeInteger(job.revision) ? job.revision : -1;
  return withJobWriteLock(path, async () => {
    let previousRevision = -1;
    try {
      const previous = await readJson(path);
      previousRevision = Number.isSafeInteger(previous?.revision) ? previous.revision : -1;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (previousRevision !== expectedRevision) {
      const conflict = new Error(`Video Harness Job revision conflict: expected ${expectedRevision}, found ${previousRevision}.`);
      conflict.code = "VIDEO_HARNESS_JOB_REVISION_CONFLICT";
      conflict.expectedRevision = expectedRevision;
      conflict.actualRevision = previousRevision;
      throw conflict;
    }
    const next = { ...job, revision: previousRevision + 1 };
    await writeJsonAtomic(path, next);
    return next;
  });
}

function isJobWriteConflict(error) {
  return ["VIDEO_HARNESS_JOB_REVISION_CONFLICT", "VIDEO_HARNESS_JOB_WRITE_BUSY"].includes(error?.code);
}

const shortYield = () => new Promise((done) => { setTimeout(done, 5); });

async function persistJobTransition(job, transition, {
  now = () => new Date().toISOString(),
  honorCancellation = true,
  allowTerminalTransition = false,
  maxAttempts = 40,
} = {}) {
  let current = job;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (TERMINAL.has(current.status) && !allowTerminalTransition) return current;
    const next = honorCancellation && current.status === "cancel-requested"
      ? { ...current, status: "cancelled", updatedAt: now(), completedAt: now() }
      : transition(current);
    try {
      return await writeJob(next);
    } catch (error) {
      if (!isJobWriteConflict(error)) throw error;
      await shortYield();
      current = await readVideoHarnessJob({ projectDir: current.projectDir, jobId: current.id });
    }
  }
  const error = new Error(`Video Harness Job ${job.id} のCAS更新が競合し続けた。`);
  error.code = "VIDEO_HARNESS_JOB_CAS_EXHAUSTED";
  throw error;
}

/** 同じ台本・Harness・Channel Pack版は同じ Job IDへ接続する。 */
export async function createVideoHarnessJob({
  projectDir = process.cwd(),
  scriptPath,
  harnessId = "",
  want = "",
  channelPackPath = "",
  options = {},
  repoRoot = MODULE_ROOT,
  deploymentPath = "",
  validateProductionProfile = assertVideoHarnessProductionProfile,
  now = () => new Date().toISOString(),
  invocation = null,
  metadata = null,
} = {}) {
  const project = resolve(projectDir);
  const sourceScript = resolve(nonEmpty(scriptPath));
  if (!nonEmpty(scriptPath)) throw new Error("--script-path が要る。");
  assertNoReviewerTrustInOptions(options);
  if (options && Object.hasOwn(options, STRATEGY_BRIEF_OPTION_KEY) && !/^[a-f0-9]{64}$/u.test(String(options[STRATEGY_BRIEF_OPTION_KEY]))) {
    throw new Error(`${STRATEGY_BRIEF_OPTION_INVALID_CODE}: options.${STRATEGY_BRIEF_OPTION_KEY} は企画ブリーフのファイルの SHA-256（小文字16進64桁）にする。`);
  }
  const extraMetadata = jobStartMetadata(metadata, options);
  // ホストの記録の形の誤りは、台本を保存する前に止める（at は作成時刻を後で入れる）。
  if (invocation) createJobInvocationRecord({ ...invocation, at: "1970-01-01T00:00:00.000Z" });
  await access(sourceScript, fsConstants.R_OK);
  const sourceStat = await stat(sourceScript);
  if (!sourceStat.isFile() || sourceStat.size === 0) throw new Error(`台本が空か通常ファイルではない: ${sourceScript}`);

  const selection = selectVideoHarness({ harnessId, want });
  const deployment = resolveHarnessDeployment(selection.harness.id, { repoRoot, deploymentPath });
  await access(deployment.root, fsConstants.R_OK);
  const scriptDigest = await sha256File(sourceScript);
  const pack = nonEmpty(channelPackPath) ? resolve(channelPackPath) : "";
  let packDigest = "none";
  let packKind = "";
  let packFileCount = 0;
  if (pack) {
    await access(pack, fsConstants.R_OK);
    const packStat = await stat(pack);
    if (packStat.isFile()) {
      packKind = "file";
      packFileCount = 1;
      packDigest = await sha256File(pack);
    } else if (packStat.isDirectory()) {
      packKind = "directory";
      const tree = await sha256Tree(pack);
      packDigest = tree.digest;
      packFileCount = tree.fileCount;
    } else throw new Error("共通上位Jobへ渡す Channel Pack は通常ファイルか検証可能なbundle directoryであること。");
  }
  const declarationPath = resolve(MODULE_ROOT, selection.harness.file || join("config", "harnesses", `${selection.harness.id}.harness.json`));
  const declaration = await readJson(declarationPath);
  const canonicalSkills = await canonicalSkillsFromDeclaration(declaration, MODULE_ROOT);
  const entrypointPath = resolveHarnessDeploymentCommand(deployment).entrypointPath;
  await access(entrypointPath, fsConstants.R_OK);
  const profileSkeleton = {
    harness: { id: selection.harness.id, canonicalSkills },
    executionProfile: VIDEO_HARNESS_PRODUCTION_PROFILE,
    options: structuredClone(options || {}),
  };
  const productionProfile = await validateProductionProfile({ job: profileSkeleton, repoRoot: MODULE_ROOT });
  const canonicalIdentity = {
    repositoryRoot: MODULE_ROOT,
    deploymentRepositoryRoot: resolve(repoRoot),
    core: await currentCoreIdentity(),
    productionDependencies: productionDependencyIdentity({
      runtimeRoot: MODULE_ROOT,
      deploymentRoot: deployment.root,
    }),
    productionContract: await canonicalProductionContractIdentity(selection.harness.id),
    harnessDeclaration: {
      path: declarationPath,
      sha256: await sha256File(declarationPath),
    },
    deployment: {
      root: deployment.root,
      entrypoint: deployment.entrypoint,
      entrypointPath,
      entrypointSha256: await sha256File(entrypointPath),
      sourcePath: deployment.sourcePath,
      sourceSha256: await sha256File(deployment.sourcePath),
    },
    skills: canonicalSkills.map(({ id, path, sha256: digest }) => ({ id, path, sha256: digest })),
    productionProfile,
  };
  const identity = jobIdentityDigest({
    harnessId: selection.harness.id,
    scriptDigest,
    packDigest,
    options,
    canonicalIdentity,
  });
  const jobId = `video-${safeIdPart(selection.harness.id)}-${identity.slice(0, 16)}`;
  const root = runRoot(project, jobId);
  const jobPath = videoHarnessJobPath(project, jobId);
  await mkdir(join(root, "input"), { recursive: true });

  try {
    const existing = await readJson(jobPath);
    if (existing.identityDigest !== identity || existing.script?.sha256 !== scriptDigest
      || canonicalJson(plannedCanonicalIdentityOf(existing)) !== canonicalJson(canonicalIdentity)) {
      throw new Error(`既存 Job ${jobId} の入力指紋が一致しない。上書きしない。`);
    }
    return { job: existing, attached: true };
  } catch (error) {
    if (error?.code !== "ENOENT" && !/既存 Job/u.test(error?.message || "")) throw error;
    if (/既存 Job/u.test(error?.message || "")) throw error;
  }

  const suffix = extname(sourceScript).toLowerCase() || ".txt";
  const storedScript = join(root, "input", `script${suffix}`);
  assertInside(root, storedScript, "台本保存先");
  await copyFile(sourceScript, storedScript, fsConstants.COPYFILE_EXCL);
  if (await sha256File(storedScript) !== scriptDigest) throw new Error("保存した台本のSHA-256が入力と一致しない。");
  const createdAt = now();
  let packIdentity = null;
  if (pack) {
    let manifest = null;
    if (packKind === "directory") {
      try { manifest = await readJson(join(pack, "channel-pack.json")); }
      catch {
        try { manifest = await readJson(join(pack, "manifest.json")); } catch { /* verifyはprepareで行う */ }
      }
    }
    packIdentity = {
      path: pack,
      kind: packKind,
      sha256: packDigest,
      fileCount: packFileCount,
      id: nonEmpty(manifest?.id) || basename(pack),
      version: nonEmpty(manifest?.packVersion) || nonEmpty(manifest?.version) || "content-sha",
    };
  }
  // 入力の同一性（台本・Channel Pack・options・取り込みの記録の SHA）。コードの同一性（canonicalIdentity）と
  // 分けて持ち、更新をまたいで確定させるときに「入力は変わっていない」を確かめる材料にする。
  const inputIdentity = videoHarnessInputIdentity({
    harnessId: selection.harness.id,
    scriptSha256: scriptDigest,
    channelPack: packIdentity,
    options: structuredClone(options || {}),
    operatorImports: await operatorImportDigests(options || {}),
  });
  const job = {
    version: VIDEO_HARNESS_JOB_VERSION,
    id: jobId,
    identityDigest: identity,
    canonicalIdentity,
    inputIdentity: inputIdentityRecord(inputIdentity, { recordedAt: createdAt, recordedFor: "plan" }),
    executionProfile: VIDEO_HARNESS_PRODUCTION_PROFILE,
    status: "planned",
    createdAt,
    updatedAt: createdAt,
    projectDir: project,
    runDir: root,
    harness: {
      id: selection.harness.id,
      declarationVersion: selection.harness.version || "",
      declarationPath,
      declarationSha256: canonicalIdentity.harnessDeclaration.sha256,
      canonicalSkills,
      selectedBy: selection.selectedBy,
      selectionEvidence: selection.evidence,
    },
    deployment: {
      root: deployment.root,
      entrypoint: deployment.entrypoint,
      entrypointPath,
      entrypointSha256: canonicalIdentity.deployment.entrypointSha256,
      sourcePath: deployment.sourcePath,
      sourceSha256: canonicalIdentity.deployment.sourceSha256,
    },
    script: {
      fileName: basename(storedScript),
      path: storedScript,
      sha256: scriptDigest,
      bytes: sourceStat.size,
    },
    channelPack: packIdentity,
    options: structuredClone(options || {}),
    stages: [
      { id: "doctor", status: "pending" },
      { id: "production", status: "pending" },
      { id: "audit", status: "pending" },
      { id: "canvas-projection", status: "pending" },
    ],
    blockers: [],
    knownRemainingIssues: [],
    artifacts: [],
    // 呼び出したホスト（lib/harnessHostProvenance.mjs）。identityDigest の材料ではない——
    // 同じ台本・宣言・Pack・options なら、どのホストから来ても同じ Job に接続する。
    metadata: {
      ...extraMetadata,
      invocation: createJobInvocationRecord(invocation ? { ...invocation, at: createdAt } : null),
    },
  };
  const written = await writeJob(job);
  return { job: written, attached: false };
}

/**
 * start が Job に残す、識別子に入れない記録（lib/channelStartGate.mjs）: チャンネルの id と、企画ブリーフの
 * ファイルの場所。resume はこの場所で、start のときのブリーフの SHA と今の SHA を比べる。形の違うものは拒む。
 */
function jobStartMetadata(metadata, options) {
  if (metadata === null || metadata === undefined) return {};
  if (typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Job の metadata は JSON object にする。");
  const out = {};
  for (const key of Object.keys(metadata)) {
    if (!["channel", "strategyBrief"].includes(key)) throw new Error(`Job の metadata に ${key} は書けない（channel と strategyBrief だけ）。`);
  }
  if (metadata.channel !== undefined) {
    const id = nonEmpty(metadata.channel?.id);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(id)) throw new Error("metadata.channel.id がチャンネルの id の形ではない。");
    out.channel = { id, selectedBy: nonEmpty(metadata.channel?.selectedBy) || "explicit" };
  }
  if (metadata.strategyBrief !== undefined) {
    const briefPath = nonEmpty(metadata.strategyBrief?.path);
    const sha256 = nonEmpty(metadata.strategyBrief?.sha256);
    if (!briefPath || !isAbsolute(briefPath)) throw new Error("metadata.strategyBrief.path は企画ブリーフのファイルの絶対 path にする。");
    if (sha256 !== String(options?.[STRATEGY_BRIEF_OPTION_KEY] || "")) {
      throw new Error(`${STRATEGY_BRIEF_OPTION_INVALID_CODE}: metadata.strategyBrief.sha256 が options.${STRATEGY_BRIEF_OPTION_KEY} と違う。`);
    }
    out.strategyBrief = { path: resolve(briefPath), sha256 };
  }
  return out;
}

function replaceStage(stages, id, patch) {
  const found = (stages || []).some((entry) => entry.id === id);
  if (!found) throw new Error(`宣言されていない Job stage: ${id}`);
  return stages.map((entry) => entry.id === id ? { ...entry, ...patch } : entry);
}

function safeAdapterResult(result, secrets = []) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const output = {};
  for (const key of ["status", "episodeId", "waiting", "pass", "next", "checkpoint", "runReceiptPath"]) {
    const value = result[key];
    if (["string", "number", "boolean"].includes(typeof value)) output[key] = typeof value === "string" ? boundedText(value, secrets, 1000) : value;
  }
  if (Array.isArray(result.failedAuditIds)) {
    output.failedAuditIds = result.failedAuditIds.slice(0, 200).map((value) => boundedText(value, secrets, 200));
  }
  return output;
}

function safeMediaJobs(outcome, secrets = []) {
  const rows = Array.isArray(outcome?.mediaJobs)
    ? outcome.mediaJobs
    : (Array.isArray(outcome?.result?.mediaJobs) ? outcome.result.mediaJobs : []);
  return rows.slice(0, 10_000).map((row) => ({
    version: boundedText(row?.version, secrets, 200),
    jobId: boundedText(row?.jobId, secrets, 500),
    requestKey: boundedText(row?.requestKey, secrets, 1000),
    status: boundedText(row?.status, secrets, 100),
    kind: boundedText(row?.kind, secrets, 200),
    provider: boundedText(row?.provider, secrets, 200),
    adapterVersion: boundedText(row?.adapterVersion, secrets, 200),
    providerJobId: boundedText(row?.providerJobId, secrets, 500),
    model: boundedText(row?.model, secrets, 500),
    voiceId: boundedText(row?.voiceId, secrets, 500),
    inputHash: boundedText(row?.inputHash, secrets, 200).replace(/^sha256:/u, ""),
    reservation: {
      reservationId: boundedText(row?.reservation?.reservationId, secrets, 500),
      status: boundedText(row?.reservation?.status, secrets, 100),
      estimatedSeconds: Number.isFinite(Number(row?.reservation?.estimatedSeconds)) ? Number(row.reservation.estimatedSeconds) : null,
      estimatedUnits: Number.isFinite(Number(row?.reservation?.estimatedUnits)) ? Number(row.reservation.estimatedUnits) : null,
      estimatedCost: Number.isFinite(Number(row?.reservation?.estimatedCost)) ? Number(row.reservation.estimatedCost) : null,
      currency: boundedText(row?.reservation?.currency, secrets, 20),
    },
    usage: {
      seconds: Number.isFinite(Number(row?.usage?.seconds)) ? Number(row.usage.seconds) : null,
      units: Number.isFinite(Number(row?.usage?.units)) ? Number(row.usage.units) : null,
      cost: Number.isFinite(Number(row?.usage?.cost)) ? Number(row.usage.cost) : null,
      currency: boundedText(row?.usage?.currency, secrets, 20),
      freeRegeneration: row?.usage?.freeRegeneration === true,
    },
    artifact: {
      sha256: boundedText(row?.artifact?.sha256, secrets, 200).replace(/^sha256:/u, ""),
      mimeType: boundedText(row?.artifact?.mimeType, secrets, 200),
      bytes: Number.isFinite(Number(row?.artifact?.bytes)) ? Number(row.artifact.bytes) : null,
    },
    attempts: {
      total: Number.isFinite(Number(row?.attempts?.total)) ? Number(row.attempts.total) : 0,
      retries: Array.isArray(row?.attempts?.retries)
        ? row.attempts.retries.map((retry) => ({
          operation: boundedText(retry?.operation, secrets, 200),
          attempt: Number(retry?.attempt || 0),
          status: Number.isFinite(Number(retry?.status)) ? Number(retry.status) : null,
          backoffMs: Number.isFinite(Number(retry?.backoffMs)) ? Number(retry.backoffMs) : null,
        }))
        : [],
    },
  }));
}

function safeArtifacts(rows, secrets = []) {
  return (Array.isArray(rows) ? rows : []).slice(0, 10_000).map((artifact) => ({
    ...(artifact?.id ? { id: boundedText(artifact.id, secrets, 500) } : {}),
    kind: boundedText(artifact?.kind || "artifact", secrets, 200),
    path: boundedText(artifact?.path, secrets, 4000),
    sha256: boundedText(artifact?.sha256, secrets, 200).replace(/^sha256:/u, ""),
    bytes: Number.isFinite(Number(artifact?.bytes)) ? Number(artifact.bytes) : null,
    ...(artifact?.mimeType ? { mimeType: boundedText(artifact.mimeType, secrets, 200) } : {}),
    ...(artifact?.title ? { title: boundedText(artifact.title, secrets, 1000) } : {}),
  }));
}

function mergeByIdentity(previous, current, identity) {
  const output = [];
  const positions = new Map();
  for (const row of [...previous, ...current]) {
    const key = identity(row);
    if (positions.has(key)) output[positions.get(key)] = row;
    else {
      positions.set(key, output.length);
      output.push(row);
    }
  }
  return output;
}

function mergeArtifacts(previous, current) {
  return mergeByIdentity(previous, current, (row) => row.id || `${row.kind}\u001f${row.path}`);
}

// 同じ入力の鍵の系列（<requestKey>:rN）。課金されていない失敗を子が次の鍵で送り直した印。
const REQUEST_KEY_CHAIN_SUFFIX = /:r([1-9]\d{0,2})$/u;

function requestKeyChain(requestKey) {
  const key = String(requestKey || "");
  const match = REQUEST_KEY_CHAIN_SUFFIX.exec(key);
  return match ? { base: key.slice(0, match.index), step: Number(match[1]) } : { base: key, step: 0 };
}

function mergeMediaJobs(previous, current) {
  const merged = mergeByIdentity(previous, current, (row) => row.requestKey || row.jobId
    || `${row.kind}\u001f${row.provider}\u001f${row.model}\u001f${row.inputHash}`);
  // 子が同じ入力を次の鍵（:rN）で送り直したら、前の鍵の未完了の行（課金されていない failed や、
  // recover で failed に決着した recovery-required）はその後継に置き換わる。残すと、完成した Job の
  // Media Job 一覧に未完了の行が居座り、Receipt を確定できなくなる。completed の行は決して消さない。
  const latestStep = new Map();
  for (const row of merged) {
    if (!row?.requestKey) continue;
    const chain = requestKeyChain(row.requestKey);
    latestStep.set(chain.base, Math.max(latestStep.get(chain.base) ?? 0, chain.step));
  }
  return merged.filter((row) => {
    if (!row?.requestKey || row.status === "completed") return true;
    const chain = requestKeyChain(row.requestKey);
    return chain.step >= (latestStep.get(chain.base) ?? 0);
  });
}

function safeRuntimeMetadata(value, expected, secrets = []) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("adapter runtimeMetadataはobjectであること。");
  const keys = Object.keys(value).sort();
  if (canonicalJson(keys) !== canonicalJson([...RUNTIME_IDENTITY_FIELDS].sort())) {
    throw new Error(`adapter runtimeMetadataはallowlist ${RUNTIME_IDENTITY_FIELDS.length}項目だけを持つこと: ${keys.join(", ")}`);
  }
  const output = {};
  for (const field of RUNTIME_IDENTITY_FIELDS) {
    output[field] = boundedText(value[field], secrets, 500).trim();
    if (!output[field]) throw new Error(`adapter runtimeMetadata.${field}が空。`);
    if (expected?.[field] !== output[field]) {
      throw new Error(`adapter runtimeMetadata.${field}が署名Channel Packのidentityと一致しない。`);
    }
  }
  return output;
}

function safeAdapterProbes(rows, secrets = []) {
  return (Array.isArray(rows) ? rows : []).slice(0, 32).map((row) => Object.fromEntries(
    ADAPTER_PROBE_FIELDS.flatMap((field) => {
      const value = row?.[field];
      if (value === undefined) return [];
      if (field === "ok") return [[field, value === true]];
      if (field === "httpStatus") return [[field, Number.isFinite(Number(value)) ? Number(value) : null]];
      return [[field, boundedText(value, secrets, field === "detail" ? 1000 : 500)]];
    }),
  ));
}

function mergeAdapterProbes(previous, current) {
  return mergeByIdentity(previous, current, (row) => `${row.kind || ""}\u001f${row.provider || ""}\u001f${row.model || ""}\u001f${row.adapterVersion || ""}`);
}

/**
 * 設定・証跡側の失敗（reviewer 信頼リスト未設定、attestation 欠落など）で Receipt が
 * 確定できなかった課金済み Job。成果物・Media Job・課金は既に済んでいるので、
 * terminal にせず awaiting-human-review へ置き、resume は Receipt 確定だけを再試行する。
 */
function receiptFinalizationIsRepairable(job) {
  const stage = (id) => (job.stages || []).find((entry) => entry.id === id)?.status;
  const pending = job.pendingReceiptFinalization;
  return job.status === "awaiting-human-review"
    && pending?.version === VIDEO_HARNESS_PENDING_RECEIPT_VERSION
    && pending.outcome?.status === "completed"
    && Array.isArray(pending.outcome.artifacts)
    && stage("production") === "pass"
    && stage("audit") !== "pass"
    && !(job.artifacts || []).some((artifact) => artifact?.kind === "run-receipt");
}

function failedStageOf(job) {
  const order = ["doctor", "production", "audit", "canvas-projection"];
  return order.find((id) => (job.stages || []).find((entry) => entry?.id === id)?.status === "failed") || "production";
}

function unrecoverable(code, reason) {
  const error = new Error(`${code}: ${reason}`);
  error.code = code;
  return error;
}

/**
 * failed Job を再開してよいかの前提。直せない状態（workspace や台本の欠落、矛盾した journal）は
 * 理由つきで拒否し、Job を書き換えない。「欠落を許可として扱う」型を避けるため、
 * 確認できないものは通さない。
 */
async function assertFailedJobResumable(job, { finalizeAfterUpdate = false } = {}) {
  const refuse = (reason) => { throw unrecoverable(FAILED_JOB_UNRECOVERABLE_CODE, reason); };
  if (job.version !== VIDEO_HARNESS_JOB_VERSION) refuse(`Job version が ${VIDEO_HARNESS_JOB_VERSION} ではない (${job.version || "(空)"})。`);
  // 更新をまたいで確定させる実行で「新しい有料の呼び出しが要る」と分かった Job は、ふつうの resume では
  // 再開しない（再開しても同じ所で止まる）。新しい Job を作るか、再利用が当たるよう直してから
  // --finalize-after-update で試し直す。
  if (!finalizeAfterUpdate && (Array.isArray(job.blockers) ? job.blockers : []).includes(FINALIZE_AFTER_UPDATE_PAID_CALL_REQUIRED_CODE)) {
    throw unrecoverable(
      FINALIZE_AFTER_UPDATE_PAID_CALL_REQUIRED_CODE,
      "この Job は更新をまたいで確定させる実行で、新しい有料の呼び出しが要ると分かって止まった。ふつうの resume では再開しない。"
      + "新しい Job を作ること（再利用が当たるよう直したなら resume --finalize-after-update で試し直せる）。",
    );
  }
  const stageIds = ["doctor", "production", "audit", "canvas-projection"];
  if (!Array.isArray(job.stages) || !stageIds.every((id) => job.stages.some((entry) => entry?.id === id))) {
    refuse("stages が宣言と一致しない。journal が壊れている。");
  }
  if (job.pendingReceiptFinalization) refuse("failed なのに Receipt 確定待ちの証跡を持つ。矛盾した journal は再開しない。");
  const runDir = nonEmpty(job.runDir);
  const directoryExists = async (path) => {
    try { return (await stat(path)).isDirectory(); } catch { return false; }
  };
  if (!runDir || !(await directoryExists(runDir))) refuse(`Job workspace が無い: ${runDir || "(未設定)"}`);
  const scriptPath = nonEmpty(job.script?.path);
  const expectedScript = nonEmpty(job.script?.sha256).toLowerCase();
  if (!scriptPath || !expectedScript) refuse("保存済み台本の path / SHA-256 が journal に無い。");
  let actualScript = "";
  try { actualScript = await sha256File(scriptPath); } catch (error) { refuse(`保存済み台本を読めない: ${basename(scriptPath)} (${error?.code || "error"})`); }
  if (actualScript !== expectedScript) refuse(`保存済み台本の SHA-256 が Job と一致しない: ${basename(scriptPath)}`);
  const executionProjectDir = nonEmpty(job.executionProjectDir);
  if (executionProjectDir && executionProjectDir !== nonEmpty(job.projectDir) && !(await directoryExists(executionProjectDir))) {
    refuse(`隔離 workspace が無い: ${executionProjectDir}`);
  }
  for (const row of Array.isArray(job.mediaJobs) ? job.mediaJobs : []) {
    if (row?.status === MEDIA_JOB_RECOVERY_REQUIRED && !nonEmpty(row.requestKey) && !nonEmpty(row.jobId)) {
      refuse("recovery-required の Media Job に requestKey も jobId も無く、recover できない。");
    }
  }
}

/**
 * 既定の recover。broker の recover 意味論をそのまま使い、盲目的な再 submit をしない。
 * Job 層は子ハーネスごとの journal 置き場を知らない（Koya は sourceDir/paid-media-jobs、
 * narrated は既定 dir）ので、既定 journal（BUZZASSIST_MEDIA_JOB_STATE_DIR か ~/.buzzassist/media-jobs）
 * に同じ requestKey が無ければ recover せず理由を返す。呼び出し側はその Media Job を未決着として
 * adapter を起動しない。
 */
async function defaultRecoverMediaJob(ref, { job = null, env = process.env } = {}) {
  const lookup = nonEmpty(ref?.requestKey) ? { requestKey: ref.requestKey } : { jobId: nonEmpty(ref?.jobId) };
  // 探す順: 子 adapter が報告した実際の journal（job.mediaJobStateDir）→ 既定 journal。
  // 両方に無ければ recover せず拒否する（黙って再 submit しない）。
  const candidates = [];
  const reported = nonEmpty(job?.mediaJobStateDir);
  if (reported) candidates.push({ label: "adapter が報告した journal", options: { stateDir: reported } });
  const configured = nonEmpty(env?.BUZZASSIST_MEDIA_JOB_STATE_DIR);
  candidates.push({ label: "既定 journal", options: configured ? { stateDir: configured } : {} });
  const searched = [];
  for (const candidate of candidates) {
    const broker = createPaidMediaJobBroker(candidate.options);
    if (searched.includes(broker.stateDir)) continue;
    searched.push(broker.stateDir);
    if (await broker.getLocal(lookup)) return broker.receipt(await broker.recover(lookup));
  }
  throw new Error(
    `Media Job ${lookup.requestKey || lookup.jobId} が既定 journal (${searched.join(", ")}) に無い。`
    + "子ハーネスの journal 置き場を BUZZASSIST_MEDIA_JOB_STATE_DIR で指すか、broker の recover で決着させてから resume すること。",
  );
}

function safeCount(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
}

/** 子の台帳 summary.retriedFailed（指紋を迂回して作り直した画像行の事実）。名前は adapter の出力と同じ。 */
function safeRetriedFailed(value, secrets = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    requested: value.requested === true,
    jobIds: (Array.isArray(value.jobIds) ? value.jobIds : []).slice(0, 10_000).map((id) => boundedText(id, secrets, 300)),
    count: safeCount(value.count),
    attempts: safeCount(value.attempts),
    completed: safeCount(value.completed),
  };
}

function safeImageRetry(value, secrets = []) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return { requested: value.requested === true, retriedFailed: safeRetriedFailed(value.retriedFailed, secrets) };
}

function safeImageSummary(value, secrets = []) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    total: safeCount(value.total),
    complete: safeCount(value.complete),
    failed: safeCount(value.failed),
    reused: safeCount(value.reused),
    paidImages: safeCount(value.paidImages),
    attempts: safeCount(value.attempts),
    retriedFailed: safeRetriedFailed(value.retriedFailed, secrets),
  };
}

/**
 * 子が報告した工程ごとの開始・終了（{ version, stages: [{ id, startedAt, finishedAt, durationMs, overlapsWith? }] }）。
 * id と時刻と長さだけを残し、形の崩れた行は落とす（本文や path は持たせない）。
 */
const STAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
function safeStageTimings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.stages)) return null;
  const time = (text) => (typeof text === "string" && Number.isFinite(Date.parse(text)) ? text : "");
  const stages = value.stages.slice(0, 64).flatMap((row) => {
    const id = typeof row?.id === "string" && STAGE_ID_PATTERN.test(row.id) ? row.id : "";
    const startedAt = time(row?.startedAt);
    const finishedAt = time(row?.finishedAt);
    const durationMs = Number(row?.durationMs);
    if (!id || !startedAt || !finishedAt || !Number.isSafeInteger(durationMs) || durationMs < 0) return [];
    const overlapsWith = typeof row?.overlapsWith === "string" && STAGE_ID_PATTERN.test(row.overlapsWith) ? row.overlapsWith : "";
    return [{ id, startedAt, finishedAt, durationMs, ...(overlapsWith ? { overlapsWith } : {}) }];
  });
  return { version: typeof value.version === "string" ? value.version.slice(0, 64) : "", stages };
}

/**
 * adapter outcome の imageRetry / imageSummary / mediaJobStateDir を Job に写す。
 * 名前は adapter が出すものと同じ。outcome に無い項目は前回の値を保つ（空文字の
 * mediaJobStateDir で既知の journal 置き場を消さない）。retryFailedImages は Job identity を
 * 迂回する引数なので、使った回は imageRetryHistory にも残す（最新値の上書きで消えないように）。
 */
function imageEvidenceFromOutcome(job, outcome, secrets, now) {
  const evidence = {};
  const imageRetry = safeImageRetry(outcome?.imageRetry, secrets);
  if (imageRetry !== undefined) evidence.imageRetry = imageRetry;
  const imageSummary = safeImageSummary(outcome?.imageSummary, secrets);
  if (imageSummary !== undefined) evidence.imageSummary = imageSummary;
  const stateDir = nonEmpty(typeof outcome?.mediaJobStateDir === "string" ? outcome.mediaJobStateDir : "");
  if (stateDir) evidence.mediaJobStateDir = boundedText(stateDir, secrets, 4000);
  const stageTimings = safeStageTimings(outcome?.stageTimings);
  if (stageTimings) evidence.stageTimings = stageTimings;
  if (imageRetry?.requested === true) {
    evidence.imageRetryHistory = [
      ...(Array.isArray(job.imageRetryHistory) ? job.imageRetryHistory : []),
      { recordedAt: now(), ...imageRetry },
    ].slice(-MAX_FAILED_RESUME_HISTORY);
  }
  return evidence;
}

function mediaJobKey(row) {
  return row.requestKey || row.jobId || `${row.kind}${row.provider}${row.model}${row.inputHash}`;
}

/**
 * resume 時点の記録（recover 後）と adapter が報告した Media Job を突き合わせる。
 * reused    = 記録済み completed と同じ requestKey・同じ artifact SHA（再課金なし）
 * recovered = recover で completed になった記録を、そのまま使った
 * reissued  = 記録はあったが、同じ鍵で別の結果になった／未完了だった
 * issued    = 記録に無い新しい Media Job（この再開で初めて発行）
 * carried   = 記録にはあるが今回の adapter が報告しなかった（再利用の可否は報告が無いので断定しない）
 */
function classifyResumedMediaJobs(recorded, reported, recoveredKeys = new Set()) {
  const before = new Map(recorded.map((row) => [mediaJobKey(row), row]));
  const summary = (row) => ({
    requestKey: row.requestKey || "",
    jobId: row.jobId || "",
    kind: row.kind || "",
    provider: row.provider || "",
    artifactSha256: row.artifact?.sha256 || "",
  });
  const output = { reused: [], recovered: [], reissued: [], issued: [], carried: [] };
  const seen = new Set();
  for (const row of reported) {
    const key = mediaJobKey(row);
    seen.add(key);
    const prior = before.get(key);
    if (!prior) {
      output.issued.push(summary(row));
      continue;
    }
    const sameArtifact = prior.status === "completed" && row.status === "completed"
      && Boolean(prior.artifact?.sha256) && prior.artifact.sha256 === row.artifact?.sha256;
    if (sameArtifact) output[recoveredKeys.has(key) ? "recovered" : "reused"].push(summary(row));
    else output.reissued.push(summary(row));
  }
  for (const [key, row] of before) {
    if (!seen.has(key)) output.carried.push(summary(row));
  }
  return output;
}

/**
 * failed Job を再開可能な状態へ戻す。順序:
 *   1. 直せない状態は拒否（journal 矛盾・workspace 欠落）。Job は書き換えない
 *   2. recovery-required の Media Job は broker の recover で決着させる。決着しなければ
 *      failed のまま PAID_MEDIA_RECOVERY_BLOCKER を立てて止まる（doctor も adapter も走らない）
 *   3. 決着していれば queued へ戻し、doctor から通常経路で再実行する。stages は pending に戻す
 *      （走っていない工程を pass のまま残さない）。前回の失敗と recover の結果は resumeFromFailed に残す
 * completed 済みの Media Job は Job の mediaJobs と broker journal に残るので、子ハーネスは同じ
 * requestKey で attach し再課金しない。
 */
async function reopenFailedJob(job, { recoverMediaJob, env, now, projectCanvas, finalizeAfterUpdate = false }) {
  await assertFailedJobResumable(job, { finalizeAfterUpdate });
  const secrets = [...collectSensitiveValues(job)];
  const previous = job.resumeFromFailed?.version === VIDEO_HARNESS_FAILED_RESUME_VERSION ? job.resumeFromFailed : null;
  const history = [
    ...(Array.isArray(previous?.history) ? previous.history : []),
    ...(previous ? [{ ...previous, history: undefined }] : []),
  ].slice(-MAX_FAILED_RESUME_HISTORY);
  const previousFailure = {
    failedAt: nonEmpty(job.completedAt) || nonEmpty(job.updatedAt),
    failedStage: failedStageOf(job),
    error: boundedText(job.error || "", secrets),
    blockers: (Array.isArray(job.blockers) ? job.blockers : []).slice(0, 200).map((value) => boundedText(value, secrets, 500)),
    knownRemainingIssues: (Array.isArray(job.knownRemainingIssues) ? job.knownRemainingIssues : []).slice(0, 200).map((value) => boundedText(value, secrets)),
    stages: (job.stages || []).map((entry) => ({ id: entry.id, status: entry.status })),
  };
  const recorded = safeMediaJobs({ mediaJobs: job.mediaJobs }, secrets);
  const recovery = [];
  const pending = [];
  let settled = recorded;
  for (const row of recorded.filter((entry) => entry.status === MEDIA_JOB_RECOVERY_REQUIRED)) {
    const label = row.requestKey || row.jobId;
    try {
      const recovered = await recoverMediaJob(
        { requestKey: row.requestKey, jobId: row.jobId, providerJobId: row.providerJobId },
        { job, env },
      );
      const [after] = safeMediaJobs({ mediaJobs: [recovered] }, secrets);
      if (!after) throw new Error("recover が Media Job を返さなかった。");
      if (row.requestKey && after.requestKey && after.requestKey !== row.requestKey) {
        throw new Error("recover が別の requestKey の Media Job を返した。");
      }
      const merged = { ...after, requestKey: after.requestKey || row.requestKey, jobId: after.jobId || row.jobId };
      recovery.push({ requestKey: row.requestKey, jobId: row.jobId, before: row.status, after: merged.status });
      settled = mergeMediaJobs(settled, [merged]);
      if (!MEDIA_JOB_SETTLED.has(merged.status)) pending.push(`${label}: recover 後も ${merged.status}`);
    } catch (error) {
      const detail = boundedText(error?.message || error, secrets);
      recovery.push({ requestKey: row.requestKey, jobId: row.jobId, before: row.status, after: row.status, error: detail });
      pending.push(`${label}: ${detail}`);
    }
  }
  const record = {
    version: VIDEO_HARNESS_FAILED_RESUME_VERSION,
    attempts: Number(previous?.attempts || 0) + 1,
    resumedAt: now(),
    previousFailure,
    mediaJobRecovery: recovery,
    mediaJobs: null,
    history,
  };
  if (pending.length > 0) {
    const detail = boundedText(`${PAID_MEDIA_RECOVERY_BLOCKER}: provider が受理した可能性のある Media Job が未決着。再 submit せず停止する: ${pending.join("; ")}`, secrets);
    const held = await persistJobTransition(job, (current) => ({
      ...current,
      status: "failed",
      updatedAt: now(),
      blockers: [PAID_MEDIA_RECOVERY_BLOCKER],
      knownRemainingIssues: [detail],
      error: detail,
      mediaJobs: settled,
      resumeFromFailed: { ...record, held: true },
    }), { now, allowTerminalTransition: true });
    if (typeof projectCanvas === "function") await projectCanvas(held);
    return held;
  }
  return persistJobTransition(job, (current) => ({
    ...current,
    status: "queued",
    updatedAt: now(),
    completedAt: undefined,
    blockers: [],
    knownRemainingIssues: [],
    error: undefined,
    mediaJobs: settled,
    resumeFromFailed: record,
    stages: current.stages.map((entry) => ({ id: entry.id, status: "pending" })),
  }), { now, allowTerminalTransition: true });
}

/**
 * 更新をまたいで確定させる前に、入力が変わっていないことを確かめる。Job に保存した台本の SHA・Pack の
 * 指紋・options が計画時の identityDigest と結ばれていること（journal が壊れていないこと）、保存した台本と
 * Pack の現物が変わっていないこと、取り込みの記録（options が指す manifest）の中身が最後に制作へ渡した
 * ときと同じこと、Koya の回の上書きが固定したときと同じこと。
 */
async function currentInputIdentity(job) {
  const storedPackDigest = job.channelPack ? job.channelPack.sha256 : "none";
  const plannedDigest = jobIdentityDigest({
    harnessId: job.harness?.id,
    scriptDigest: job.script?.sha256,
    packDigest: storedPackDigest,
    options: job.options,
    canonicalIdentity: plannedCanonicalIdentityOf(job),
  });
  if (plannedDigest !== job.identityDigest || !String(job.id || "").endsWith(String(job.identityDigest || "").slice(0, 16))) {
    throw unrecoverable(JOB_JOURNAL_CORRUPT_CODE, "Job に保存した入力（台本・Channel Pack・options）が計画時の identityDigest と結ばれていない。付け替えない。");
  }
  const changes = [];
  let scriptSha256 = "";
  try { scriptSha256 = await sha256File(job.script.path); } catch { scriptSha256 = ""; }
  if (scriptSha256 !== job.script.sha256) changes.push("script");
  if (job.channelPack) {
    try {
      if (job.channelPack.kind === "directory") {
        const tree = await sha256Tree(job.channelPack.path);
        if (tree.digest !== job.channelPack.sha256 || tree.fileCount !== job.channelPack.fileCount) changes.push("channel-pack");
      } else if (await sha256File(job.channelPack.path) !== job.channelPack.sha256) changes.push("channel-pack");
    } catch {
      changes.push("channel-pack");
    }
  }
  const operatorImports = await operatorImportDigests(job.options || {});
  const compared = compareOperatorImports(job, operatorImports);
  changes.push(...compared.changed);
  if (job.harness?.id === "koya-manga-video" && await episodeOverrideChanged(job)) changes.push("episode-override");
  const identity = videoHarnessInputIdentity({
    harnessId: job.harness?.id,
    scriptSha256: job.script?.sha256,
    channelPack: job.channelPack || null,
    options: job.options || {},
    operatorImports,
  });
  return { identity, changes, unrecorded: compared.unrecorded };
}

/** 付け替えずにふつうの resume を使うべき Job か（更新をまたいでいない）。Job は変えない。 */
async function assertFinalizeAfterUpdateNeeded(job, validateProductionProfile) {
  if (isFinalizeAfterUpdateJob(job)) return;
  let current = null;
  try {
    current = await computeCodeIdentity(job, validateProductionProfile, { strict: false });
  } catch {
    return; // 読めない差は付け替えの段で理由つきで止める
  }
  if (canonicalJson(current.canonicalIdentity) === canonicalJson(job.canonicalIdentity)) {
    throw finalizeAfterUpdateError(
      FINALIZE_AFTER_UPDATE_NOT_NEEDED_CODE,
      "コードの同一性は計画時と同じで、更新をまたいでいない。--finalize-after-update（finalizeAfterUpdate）を付けずに resume すること。Job は変えていない。",
    );
  }
}

async function koyaEpisodeContractSnapshotPath(job) {
  const episodeId = nonEmpty(job?.options?.episodeId);
  // 子が回のフォルダを作る作業場（resolveVideoHarnessExecutionContract と同じ既定）。
  const workspace = nonEmpty(job?.executionProjectDir) || nonEmpty(job?.projectDir);
  if (!episodeId || !workspace) return "";
  const { koyaEpisodePaths } = await import("./koyaMangaProduction.mjs");
  return koyaEpisodePaths(workspace, episodeId).contractSnapshotPath;
}

/**
 * 更新をまたいで確定させる（resume --finalize-after-update）ための付け替え。入力が変わっていれば止め、
 * コードだけが変わっていれば、Job の canonicalIdentity・宣言・配置の記録を今のコードへ付け替える。
 * 計画時の値は codeIdentityRebind.plannedCanonicalIdentity に残し、Job ID と identityDigest は変えない。
 * Koya は固定した制作契約の中身を Job の置き場へ写し、以後の制作・監査・Receipt はその写しで行う。
 */
async function rebindForFinalizeAfterUpdate(job, { validateProductionProfile, now }) {
  const inputs = await currentInputIdentity(job);
  if (inputs.changes.length > 0) {
    throw finalizeAfterUpdateError(
      FINALIZE_AFTER_UPDATE_INPUT_CHANGED_CODE,
      `入力が計画時・最後の制作から変わった（${inputs.changes.join(", ")}）。作り直しになるので付け替えない。新しい Job を作ること。`,
    );
  }
  if (inputs.unrecorded.length > 0) {
    throw finalizeAfterUpdateError(
      FINALIZE_AFTER_UPDATE_INPUT_UNRECORDED_CODE,
      `取り込みの記録（${inputs.unrecorded.join(", ")}）の SHA が Job に残っていない（この機能より前に最後の制作を走らせた Job）。`
      + "変わっていないと示せないので付け替えない。新しい Job を作ること。",
    );
  }
  const current = await computeCodeIdentity(job, validateProductionProfile, { strict: false });
  if (canonicalJson(current.canonicalIdentity) === canonicalJson(job.canonicalIdentity)) {
    if (isFinalizeAfterUpdateJob(job)) return job;
    throw finalizeAfterUpdateError(FINALIZE_AFTER_UPDATE_NOT_NEEDED_CODE, "コードの同一性は計画時と同じ。--finalize-after-update を付けずに resume すること。");
  }
  let pinnedProductionContract = null;
  if (job.harness.id === "koya-manga-video") {
    if (!job.resolvedProductionContract) {
      throw finalizeAfterUpdateError(
        FINALIZE_AFTER_UPDATE_PINNED_CONTRACT_UNAVAILABLE_CODE,
        "doctor の前で止まった Koya の Job には、固定した制作契約も作った有料の成果物も無い。新しい Job を作ること。",
      );
    }
    let found = null;
    if (isFinalizeAfterUpdateJob(job) && job.codeIdentityRebind.pinnedProductionContract) {
      try {
        const pinned = await readRebindPinnedProductionContract(job);
        found = { contract: pinned.contract, source: job.codeIdentityRebind.pinnedProductionContract.source || "finalize-after-update" };
      } catch { found = null; }
    }
    if (!found) found = await findPinnedKoyaProductionContract(job, { episodeSnapshotPath: await koyaEpisodeContractSnapshotPath(job) });
    if (!found) {
      throw finalizeAfterUpdateError(
        FINALIZE_AFTER_UPDATE_PINNED_CONTRACT_UNAVAILABLE_CODE,
        `固定した制作契約 ${job.resolvedProductionContract.contractVersion || "(版不明)"} の中身（digest ${String(job.resolvedProductionContract.contractDigest || "").slice(0, 12)}）が`
        + " Job の置き場にも回の写しにも見つからない。固定した版で確定できないので付け替えない。新しい Job を作ること。",
      );
    }
    pinnedProductionContract = await writePinnedProductionContractForFinalize(job, found.contract, { source: found.source });
  }
  const at = now();
  const rebound = current.canonicalIdentity;
  return persistJobTransition(job, (latest) => ({
    ...latest,
    updatedAt: at,
    canonicalIdentity: rebound,
    harness: {
      ...latest.harness,
      declarationVersion: String(current.declaration?.version || latest.harness?.declarationVersion || ""),
      declarationSha256: rebound.harnessDeclaration.sha256,
      canonicalSkills: current.canonicalSkills,
    },
    deployment: {
      ...latest.deployment,
      root: rebound.deployment.root,
      entrypoint: rebound.deployment.entrypoint,
      entrypointPath: rebound.deployment.entrypointPath,
      entrypointSha256: rebound.deployment.entrypointSha256,
      sourcePath: rebound.deployment.sourcePath,
      sourceSha256: rebound.deployment.sourceSha256,
    },
    inputIdentity: inputIdentityRecord(inputs.identity, { recordedAt: at, recordedFor: "finalize-after-update" }),
    codeIdentityRebind: nextCodeIdentityRebind(latest, {
      currentCanonicalIdentity: rebound,
      inputIdentityDigest: inputs.identity.digest,
      pinnedProductionContract,
      at,
    }),
  }), { now });
}

function mediaJobClassificationCounts(classified) {
  return Object.fromEntries(["reused", "recovered", "reissued", "issued", "carried"]
    .map((key) => [key, Array.isArray(classified?.[key]) ? classified[key].length : 0]));
}

function receiptFailureBlockers(detail) {
  const code = String(detail || "").match(/^([a-z][a-z0-9]*(?:-[a-z0-9]+)+)(?::|\s|$)/u)?.[1];
  return code && code !== RECEIPT_FINALIZATION_BLOCKER
    ? [RECEIPT_FINALIZATION_BLOCKER, code]
    : [RECEIPT_FINALIZATION_BLOCKER];
}

function pendingReceiptSnapshot({ previous, outcome, artifacts, mediaJobs, runtimeMetadata, adapterProbes, auditChecks, detail, now, secrets = [] }) {
  return {
    version: VIDEO_HARNESS_PENDING_RECEIPT_VERSION,
    outcome: {
      status: "completed",
      artifacts,
      mediaJobs,
      runtimeMetadata,
      adapterProbes,
      auditChecks,
      knownRemainingIssues: [],
      // R4-4: 保存する adapter result も secrets を通す（Job 本体の adapterResult と同じ扱い）。
      ...(outcome?.result ? { result: safeAdapterResult(outcome.result, secrets) } : {}),
    },
    attempts: Number(previous?.attempts || 0) + 1,
    firstFailedAt: nonEmpty(previous?.firstFailedAt) || now(),
    lastAttemptAt: now(),
    lastError: detail,
  };
}

function assertNoReviewerTrustInOptions(options, path = "options", seen = new Set()) {
  if (!options || typeof options !== "object" || seen.has(options)) return;
  seen.add(options);
  if (Array.isArray(options)) {
    options.forEach((item, index) => assertNoReviewerTrustInOptions(item, `${path}[${index}]`, seen));
    return;
  }
  for (const [key, child] of Object.entries(options)) {
    if (REVIEWER_TRUST_OPTION_PATTERN.test(key)) {
      throw new Error(
        `${REVIEWER_TRUST_OPTION_REJECTED_CODE}: ${path}.${key} は Job options に書けない。`
        + "reviewer 信頼リストの唯一の信頼アンカーは、運営者が監査・Receipt を実行する側へ配る環境変数 BUZZASSIST_REVIEWER_TRUST。"
        + "resume/start の実行時引数 reviewerTrustPath は環境変数との照合にだけ使う（未設定の実行側では fail-closed）。",
      );
    }
    if (REVIEWER_KEY_MATERIAL_OPTION_PATTERN.test(key)) {
      throw new Error(
        `${REVIEWER_KEY_MATERIAL_OPTION_REJECTED_CODE}: ${path}.${key} は Job options に書けない。`
        + "reviewer 鍵は中身も path も argv / MCP 引数 / Job options に載せず、別 context の reviewer 工程（CLI signoff）で --reviewer-key-path を使う。",
      );
    }
    assertNoReviewerTrustInOptions(child, `${path}.${key}`, seen);
  }
}

/**
 * 信頼アンカー規則は lib/koyaReviewAttestation.mjs の loadReviewerTrust に 1 か所だけ置く。
 * ここは実行時引数 reviewerTrustPath（Job identity 外・要求側が決める値ではない）を
 * その照合入力として渡すだけの薄い wrapper。
 *
 * - 実行時引数が無ければ null（Receipt 側が signoff 要否を見て env を読む）
 * - 環境変数が未設定なら reviewer-trust-unconfigured（実行時引数だけでは信頼アンカーにならない）
 * - 環境変数と別内容なら reviewer-trust-conflict、一致すれば環境変数側を採る
 * - 新旧 env 名が食い違う env-ambiguous はそのまま fail-closed
 */
async function resolveReviewerTrust({ reviewerTrustPath, env = process.env }) {
  const path = nonEmpty(reviewerTrustPath);
  if (!path) return null;
  return loadReviewerTrust({ trustPath: resolve(path), env });
}

async function finalizeCompletedOutcome({ job, outcome, finalizeReceipt, now, reviewerTrustPath, env = process.env, secrets = [] }) {
  try {
    const reviewerTrust = await resolveReviewerTrust({ reviewerTrustPath, env });
    const finalized = await finalizeReceipt({
      job,
      outcome,
      now,
      env,
      ...(reviewerTrust ? { reviewerTrust } : {}),
    });
    if (!finalized?.path) throw new Error("共通RunReceipt pathが返らなかった。");
    const receiptInfo = await stat(finalized.path);
    return {
      ok: true,
      receiptArtifact: {
        kind: "run-receipt",
        path: resolve(finalized.path),
        sha256: await sha256File(finalized.path),
        bytes: receiptInfo.size,
        mimeType: "application/json",
      },
    };
  } catch (error) {
    return { ok: false, detail: boundedText(error?.message || error, secrets) };
  }
}

/** 保存済み成果物の SHA が現物と一致しないなら、Receipt 確定を再試行せず拒否する。 */
async function pendingArtifactDrift(artifacts) {
  const drift = [];
  for (const artifact of artifacts) {
    const path = nonEmpty(artifact?.path);
    const expected = nonEmpty(artifact?.sha256).toLowerCase();
    if (!path || !expected) continue;
    let actual = "";
    try {
      actual = await sha256File(path);
    } catch (error) {
      drift.push(`${artifact.kind || "artifact"}: ${basename(path)} を読めない (${error?.code || "error"})`);
      continue;
    }
    if (actual !== expected) drift.push(`${artifact.kind || "artifact"}: ${basename(path)} のSHA-256が確定時と一致しない`);
  }
  return drift;
}

async function retryReceiptFinalization(job, { finalizeReceipt, projectCanvas, now, reviewerTrustPath, env = process.env, afterPreProjectionPersist, afterCompletedCanvasProjection }) {
  const pending = job.pendingReceiptFinalization;
  const secrets = [...collectSensitiveValues(job)];
  const holdWith = (detail, blockers) => persistJobTransition(job, (current) => ({
    ...current,
    status: "awaiting-human-review",
    updatedAt: now(),
    blockers,
    knownRemainingIssues: [`run-receipt: ${detail}`],
    pendingReceiptFinalization: {
      ...current.pendingReceiptFinalization,
      attempts: Number(current.pendingReceiptFinalization?.attempts || 0) + 1,
      lastAttemptAt: now(),
      lastError: detail,
    },
    error: detail,
    stages: replaceStage(current.stages, "audit", { status: "awaiting-human-review", finishedAt: undefined }),
  }), { now });

  const drift = await pendingArtifactDrift(pending.outcome.artifacts);
  if (drift.length > 0) {
    const detail = boundedText(`成果物がReceipt確定待ちの間に変わった。production を再実行せず停止する: ${drift.join("; ")}`, secrets);
    const held = await holdWith(detail, [RECEIPT_ARTIFACT_DRIFT_BLOCKER]);
    if (typeof projectCanvas === "function") await projectCanvas(held);
    return held;
  }
  const finalized = await finalizeCompletedOutcome({
    job,
    outcome: pending.outcome,
    finalizeReceipt,
    now,
    reviewerTrustPath,
    env,
    secrets,
  });
  if (!finalized.ok) {
    const held = await holdWith(finalized.detail, receiptFailureBlockers(finalized.detail));
    if (typeof projectCanvas === "function") await projectCanvas(held);
    return held;
  }
  const running = await persistJobTransition(job, (current) => ({
    ...current,
    status: "running",
    updatedAt: now(),
    blockers: [],
    knownRemainingIssues: [],
    error: undefined,
    pendingReceiptFinalization: undefined,
    artifacts: mergeArtifacts(safeArtifacts(current.artifacts, secrets), [finalized.receiptArtifact]),
    stages: replaceStage(
      replaceStage(current.stages, "audit", { status: "pass", finishedAt: now() }),
      "canvas-projection",
      { status: "running", startedAt: now() },
    ),
  }), { now });
  if (running.status === "cancelled") {
    if (typeof projectCanvas === "function") await projectCanvas(running);
    return running;
  }
  if (typeof afterPreProjectionPersist === "function") await afterPreProjectionPersist(running);
  return completeCanvasProjection(running, { projectCanvas, now, afterCompletedCanvasProjection });
}

function canvasCompletionIsRepairable(job) {
  const stage = (id) => (job.stages || []).find((entry) => entry.id === id)?.status;
  return job.status === "running"
    && stage("production") === "pass"
    && stage("audit") === "pass"
    && ["running", "failed"].includes(stage("canvas-projection"))
    && (job.artifacts || []).some((artifact) => artifact?.kind === "run-receipt" && artifact?.path && artifact?.sha256);
}

async function completeCanvasProjection(job, { projectCanvas, now, afterCompletedCanvasProjection = null }) {
  if (typeof projectCanvas !== "function") {
    return persistJobTransition(job, (current) => ({
      ...current,
      status: "running",
      error: "Canvas projection is required for a completed production Job.",
      knownRemainingIssues: ["canvas-projection: Canvas投影関数が無いため完成を確定できない。"],
      stages: replaceStage(current.stages, "canvas-projection", { status: "failed", finishedAt: now() }),
      updatedAt: now(),
    }), { now });
  }
  let projecting = job;
  if ((job.stages || []).find((entry) => entry.id === "canvas-projection")?.status !== "running") {
    projecting = await persistJobTransition(job, (current) => ({
      ...current,
      status: "running",
      stages: replaceStage(current.stages, "canvas-projection", {
        status: "running",
        startedAt: current.stages.find((entry) => entry.id === "canvas-projection")?.startedAt || now(),
        finishedAt: undefined,
      }),
      updatedAt: now(),
    }), { now });
  }
  // まだ永続化していないcompleted候補をCanvasへ投影する。この呼び出し自身が
  // 実mediaの検証・隔離も行う。runningを同じ直前に別revisionで投影すると、
  // completed投影後のprocess crashでCanvasだけがdurable Jobより1版先へ進み、
  // resumeがstale revisionになるため、ここでは完成候補を1回だけ投影する。
  const completionIntentAt = projecting.stages.find((entry) => entry.id === "canvas-projection")?.startedAt || now();
  const completedCandidate = {
    ...projecting,
    revision: Number(projecting.revision || 0) + 1,
    status: "completed",
    completedAt: completionIntentAt,
    error: undefined,
    blockers: [],
    knownRemainingIssues: [],
    stages: replaceStage(projecting.stages, "canvas-projection", { status: "pass", finishedAt: completionIntentAt }),
    updatedAt: completionIntentAt,
  };
  try {
    await projectCanvas(completedCandidate);
  } catch (error) {
    const detail = boundedText(error?.message || error);
    return persistJobTransition(projecting, (current) => ({
      ...current,
      status: "running",
      completedAt: undefined,
      error: detail,
      knownRemainingIssues: [`canvas-projection: ${detail}`],
      stages: replaceStage(current.stages, "canvas-projection", { status: "failed", finishedAt: now() }),
      updatedAt: now(),
    }), { now, allowTerminalTransition: true });
  }
  if (typeof afterCompletedCanvasProjection === "function") {
    // Test/host fault-injection point. ここでprocessが落ちてもdurable Jobは
    // runningのまま。同じcompletedCandidateを次のresumeがidempotentに再投影する。
    await afterCompletedCanvasProjection(completedCandidate);
  }
  const persisted = await persistJobTransition(projecting, (current) => ({
    ...current,
    status: "completed",
    completedAt: completedCandidate.completedAt,
    error: undefined,
    blockers: [],
    knownRemainingIssues: [],
    stages: replaceStage(current.stages, "canvas-projection", {
      status: "pass",
      finishedAt: completedCandidate.stages.find((entry) => entry.id === "canvas-projection")?.finishedAt,
    }),
    updatedAt: completedCandidate.updatedAt,
  }), { now });
  // completed候補の投影後にcancel CASが勝った場合、persistJobTransitionは
  // authoritative stateをcancelledへ進める。Canvasを候補のcomplete表示のまま
  // 残さず、その新しいrevisionを同じ呼出しで上書きする。
  if (persisted.status === "cancelled" && typeof projectCanvas === "function") {
    await projectCanvas(persisted);
  }
  return persisted;
}

function safeAuditChecks(value, secrets = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const output = {};
  for (const [id, check] of Object.entries(value).slice(0, 1000)) {
    const safeId = boundedText(id, secrets, 300);
    if (typeof check === "boolean") output[safeId] = check;
    else if (check && typeof check === "object" && !Array.isArray(check)) {
      output[safeId] = {
        pass: check.pass === true,
        ...(check.detail !== undefined ? { detail: boundedText(check.detail, secrets, 2000) } : {}),
        ...(check.reason !== undefined ? { reason: boundedText(check.reason, secrets, 2000) } : {}),
      };
    }
  }
  return output;
}

function safeChannelPackVerification(value, secrets = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = [
    "envelopeVersion", "id", "version", "harnessId", "payloadKind", "coreCompatibility",
    "coreVersion", "payloadSha256", "signerKeyId", "trustedPublicKeyId",
  ];
  const output = Object.fromEntries(fields
    .filter((field) => value[field] !== undefined)
    .map((field) => [field, boundedText(value[field], secrets, 500)]));
  if (value.fileCount !== undefined) {
    output.fileCount = Number.isSafeInteger(Number(value.fileCount)) ? Number(value.fileCount) : 0;
  }
  return output;
}

function safeDiagnosticValue(value, secrets = [], state = { seen: new Set(), depth: 0 }) {
  if (typeof value === "string") return boundedText(value, secrets, 4000);
  if (["number", "boolean"].includes(typeof value) || value === null) return value;
  if (value === undefined) return null;
  if (typeof value !== "object" || state.depth >= 10 || state.seen.has(value)) return "[bounded]";
  state.seen.add(value);
  const childState = { seen: state.seen, depth: state.depth + 1 };
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => safeDiagnosticValue(item, secrets, childState));
  const output = {};
  for (const [key, child] of Object.entries(value).slice(0, 500)) {
    if (/(?:authorization$|credentials?$|password$|secrets?$|token$|api[-_]?key$|(?:client|private|signing|trusted)[-_]?key$)/iu.test(key)) continue;
    output[boundedText(key, secrets, 300)] = safeDiagnosticValue(child, secrets, childState);
  }
  return output;
}

/**
 * doctor は依存注入できるので、fixture が実資格情報や有料providerへ触れずに
 * 同じ状態遷移を検証できる。production adapter は doctor 合格後にしか呼ばない。
 */
export async function runVideoHarnessJob({
  projectDir = process.cwd(),
  jobId,
  doctor,
  prepare,
  adapter,
  finalizeReceipt = createVideoHarnessRunReceipt,
  projectCanvas,
  afterPreProjectionPersist = null,
  afterCompletedCanvasProjection = null,
  validateProductionProfile = assertVideoHarnessProductionProfile,
  reviewerTrustPath = "",
  recoverMediaJob = defaultRecoverMediaJob,
  env = process.env,
  now = () => new Date().toISOString(),
  // 再開（resume / 既存 Job に接続した confirmed start）を呼んだホスト。Job を作った
  // 呼び出しは createdBy に残っているので渡さない。
  invocation = null,
  // 更新をまたいで確定させる（resume --finalize-after-update）。入力が同じでコードだけが変わった Job を、
  // 作り直さず・新しい有料の呼び出しをせずに、固定した契約の版で確定までやり直す。
  finalizeAfterUpdate = false,
} = {}) {
  if (typeof doctor !== "function") throw new Error("runVideoHarnessJob には共通 doctor 関数が要る。");
  if (typeof adapter !== "function") throw new Error("runVideoHarnessJob にはHarness adapterが要る。");
  // ホストの記録の形の誤りは、Job に触る前に止める。
  if (invocation) appendResumedInvocation(null, { ...invocation, at: "1970-01-01T00:00:00.000Z" });
  let job;
  try {
    job = await readVideoHarnessJob({ projectDir, jobId });
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw unrecoverable(JOB_JOURNAL_CORRUPT_CODE, `Job ${jobId} の journal を JSON として読めない。再開しない: ${boundedText(error.message, [], 500)}`);
  }
  if (job.status === "cancel-requested") {
    job = await persistJobTransition(job, (current) => current, { now });
    if (typeof projectCanvas === "function") await projectCanvas(job);
    return job;
  }
  if (TERMINAL.has(job.status) && job.status !== "failed") {
    // terminal永続化後のCanvas一時障害や外部損傷は、doctor/paid adapterを
    // 再実行せずauthoritative revisionを冪等再投影する。特にcomplete候補の直後に
    // cancelが勝ち、その補償投影だけ失敗した場合も次のresumeでcancelledへ戻せる。
    if (typeof projectCanvas === "function") await projectCanvas(job);
    return job;
  }
  // 更新をまたいでいない Job に --finalize-after-update が来たら、Job を変えずに断る（ふつうの resume を使う）。
  if (finalizeAfterUpdate === true) await assertFinalizeAfterUpdateNeeded(job, validateProductionProfile);
  if (job.status === "failed") {
    // failed は terminal ではなく再開可能。直せない状態は拒否し、provider が受理した可能性の
    // ある Media Job は recover で決着させてから、通常の doctor → adapter 経路へ戻す。
    job = await reopenFailedJob(job, { recoverMediaJob, env, now, projectCanvas, finalizeAfterUpdate: finalizeAfterUpdate === true });
    if (job.status === "failed") return job;
  }

  // 実際に何かを走らせる再開だけを、作った記録とは別の一覧に積む（同一性の材料ではない）。
  // Receipt はこの一覧を写すので、確定より前に残す。
  if (invocation) {
    job = await persistJobTransition(job, (current) => ({
      ...current,
      updatedAt: now(),
      metadata: {
        ...(current.metadata && typeof current.metadata === "object" ? current.metadata : {}),
        invocation: appendResumedInvocation(current.metadata?.invocation, { ...invocation, at: now() }),
      },
    }), { now });
    if (job.status === "cancelled") {
      if (typeof projectCanvas === "function") await projectCanvas(job);
      return job;
    }
  }

  try {
    if (finalizeAfterUpdate === true) {
      job = await rebindForFinalizeAfterUpdate(job, { validateProductionProfile, now });
      if (job.status === "cancelled") {
        if (typeof projectCanvas === "function") await projectCanvas(job);
        return job;
      }
    }
    await assertVideoHarnessJobIdentity(job, { validateProductionProfile });
  } catch (error) {
    // 付け替えが要らない・journal が壊れている、は Job を変えずに断る。
    if ([FINALIZE_AFTER_UPDATE_NOT_NEEDED_CODE, JOB_JOURNAL_CORRUPT_CODE].includes(error?.code)) throw error;
    // 入力が変わった・固定した契約が無い、は今までどおり canonical-identity-drift で止め、理由の code を並べる。
    const finalizeCode = FINALIZE_AFTER_UPDATE_BLOCKING_CODES.includes(error?.code) ? error.code : "";
    const driftBlockers = [CANONICAL_IDENTITY_DRIFT_CODE, ...(finalizeCode ? [finalizeCode] : [])];
    const secrets = [...collectSensitiveValues(job)];
    const detail = boundedText(error?.message || error, secrets);
    // Receipt 確定待ちの課金済み Job は、identity drift でも awaiting-human-review から動かさない。
    // blocked-preflight へ落とすと receiptFinalizationIsRepairable が二度と成立せず、drift を
    // 戻した次の resume が doctor と paid adapter の経路へ戻って二重課金になる（R4-2）。
    const receiptPending = receiptFinalizationIsRepairable(job);
    // R5-2: drift の痕跡は pendingReceiptFinalization だけに置かない（Receipt 確定成功で
    // その object は消える）。Job 本体の driftHistory に残し、確定後も追えるようにする。
    const driftRecord = (current, phase) => [
      ...(Array.isArray(current.driftHistory) ? current.driftHistory : []),
      { detectedAt: now(), phase, status: current.status, error: detail },
    ].slice(-MAX_DRIFT_HISTORY);
    job = await persistJobTransition(job, (current) => (receiptPending
      ? {
        ...current,
        status: "awaiting-human-review",
        updatedAt: now(),
        blockers: [RECEIPT_FINALIZATION_BLOCKER, ...driftBlockers],
        knownRemainingIssues: [
          `run-receipt: ${current.pendingReceiptFinalization?.lastError || "Receipt 確定待ち"}`,
          `canonical-identity-drift: ${detail} Receipt 確定待ちの成果物は保持している。drift を戻してから resume すると Receipt 確定だけを再試行する。`,
        ],
        error: detail,
        driftHistory: driftRecord(current, "receipt-pending"),
        pendingReceiptFinalization: {
          ...current.pendingReceiptFinalization,
          identityDrift: { detectedAt: now(), error: detail },
        },
      }
      : {
        ...current,
        status: "blocked-preflight",
        updatedAt: now(),
        blockers: driftBlockers,
        knownRemainingIssues: [detail],
        driftHistory: driftRecord(current, finalizeCode ? "finalize-after-update" : "preflight"),
        stages: replaceStage(current.stages, "doctor", {
          status: "failed",
          finishedAt: now(),
          evidence: { ready: false, blocking: driftBlockers, error: detail },
        }),
      }), { now });
    if (typeof projectCanvas === "function") await projectCanvas(job);
    return job;
  }

  // Receipt確定後のprocess crash/Canvas一時障害はproductionを再実行せず、
  // 同じ成果物とsignoffを使って投影だけを修復する。再課金の余地を作らない。
  if (canvasCompletionIsRepairable(job)) {
    return completeCanvasProjection(job, { projectCanvas, now, afterCompletedCanvasProjection });
  }
  // 設定・証跡側の失敗で Receipt だけが確定できなかった課金済み Job は、doctor も
  // paid adapter も再実行せず、保存済みの同じ成果物・Media Job で Receipt 確定だけを再試行する。
  if (receiptFinalizationIsRepairable(job)) {
    return retryReceiptFinalization(job, {
      finalizeReceipt,
      projectCanvas,
      now,
      reviewerTrustPath,
      env,
      afterPreProjectionPersist,
      afterCompletedCanvasProjection,
    });
  }

  job = await persistJobTransition(job, (current) => ({
    ...current,
    status: "preflight-running",
    updatedAt: now(),
    stages: replaceStage(current.stages, "doctor", { status: "running", startedAt: now() }),
  }), { now });
  if (job.status === "cancelled") {
    if (typeof projectCanvas === "function") await projectCanvas(job);
    return job;
  }
  if (typeof projectCanvas === "function") await projectCanvas(job);

  let prepareResult = null;
  if (typeof prepare === "function") {
    try {
      prepareResult = await prepare({ job });
    } catch (error) {
      prepareResult = { ok: false, blockers: ["channel-pack-prepare"], error: boundedText(error?.message || error) };
    }
    if (prepareResult?.ok === true && job.harness.id === "narrated-story-video") {
      try {
        prepareResult = {
          ...prepareResult,
          channelPackRuntime: validateChannelPackRuntime(prepareResult.channelPackRuntime, {
            harnessId: job.harness.id,
            payloadSha256: prepareResult.evidence?.payloadSha256,
          }),
        };
      } catch (error) {
        prepareResult = {
          ok: false,
          blockers: ["channel-pack-runtime-metadata-invalid"],
          error: boundedText(error?.message || error),
          evidence: prepareResult.evidence || null,
        };
      }
    }
    if (prepareResult?.ok !== true) {
      const secrets = [...collectSensitiveValues(prepareResult)];
      const blockers = Array.isArray(prepareResult?.blockers) && prepareResult.blockers.length
        ? prepareResult.blockers.slice(0, 200).map((value) => boundedText(value, secrets, 500))
        : ["channel-pack-prepare"];
      const evidence = safeDiagnosticValue(prepareResult, secrets);
      job = await persistJobTransition(job, (current) => ({
        ...current,
        status: "blocked-preflight",
        updatedAt: now(),
        blockers,
        stages: replaceStage(current.stages, "doctor", {
          status: "failed",
          finishedAt: now(),
          evidence,
        }),
      }), { now });
      if (typeof projectCanvas === "function") await projectCanvas(job);
      return job;
    }
    const prepareSecrets = [...collectSensitiveValues(prepareResult)];
    const verification = safeChannelPackVerification(prepareResult.evidence, prepareSecrets);
    const runtimeMetadata = prepareResult.channelPackRuntime || null;
    job = await persistJobTransition(job, (current) => ({
      ...current,
      channelPackVerification: verification,
      channelPackRuntime: runtimeMetadata,
      executionProjectDir: prepareResult.executionProjectDir || job.projectDir,
      updatedAt: now(),
    }), { now });
    if (job.status === "cancelled") {
      if (typeof projectCanvas === "function") await projectCanvas(job);
      return job;
    }
  }

  if (job.harness.id === "koya-manga-video") {
    let resolvedProductionContract;
    try {
      if (job.resolvedProductionContract) {
        resolvedProductionContract = await resolveVideoHarnessExecutionContract(job);
      } else {
        // 初めて固定するときは、中身の写しを Job の run フォルダへ残す。更新でリポジトリの契約の版が
        // 上がっても、更新をまたいで確定させるときに固定した版の中身で制作・監査できるように。
        const resolved = await resolveExecutionContractWithContent(job, job.executionProjectDir || job.projectDir);
        resolvedProductionContract = resolved.record;
        await writeJsonAtomic(join(resolve(job.runDir), PINNED_PRODUCTION_CONTRACT_FILE), resolved.contract);
      }
    } catch (error) {
      const detail = boundedText(error?.message || error);
      job = await persistJobTransition(job, (current) => ({
        ...current,
        status: "blocked-preflight",
        updatedAt: now(),
        blockers: ["production-contract-resolution-failed"],
        knownRemainingIssues: [detail],
        stages: replaceStage(current.stages, "doctor", {
          status: "failed",
          finishedAt: now(),
          evidence: { ready: false, blocking: ["production-contract-resolution-failed"], error: detail },
        }),
      }), { now });
      if (typeof projectCanvas === "function") await projectCanvas(job);
      return job;
    }
    if (job.resolvedProductionContract
      && canonicalJson(job.resolvedProductionContract) !== canonicalJson(resolvedProductionContract)) {
      const detail = "Koyaの解決済み制作契約が同じJob内で変わった。新しいJobとして計画し直すこと。";
      job = await persistJobTransition(job, (current) => ({
        ...current,
        status: "blocked-preflight",
        updatedAt: now(),
        blockers: ["canonical-identity-drift"],
        knownRemainingIssues: [detail],
        stages: replaceStage(current.stages, "doctor", {
          status: "failed",
          finishedAt: now(),
          evidence: { ready: false, blocking: ["canonical-identity-drift"], error: detail },
        }),
      }), { now });
      if (typeof projectCanvas === "function") await projectCanvas(job);
      return job;
    }
    if (!job.resolvedProductionContract) {
      // Created exactly once, after the Channel Pack was verified against a
      // trusted key and the effective contract was fixed. Both are inputs, so a
      // later Job with another signed pack or another override cannot reuse
      // this Job's manifests, reviews or receipts.
      const executionIdentityDigest = createVideoHarnessExecutionIdentityDigest({
        jobId: job.id,
        identityDigest: job.identityDigest,
        resolvedProductionContract,
        channelPackVerification: job.channelPackVerification ?? null,
      });
      job = await persistJobTransition(job, (current) => ({
        ...current,
        resolvedProductionContract,
        executionIdentityDigest,
        updatedAt: now(),
      }), { now });
      if (job.status === "cancelled") {
        if (typeof projectCanvas === "function") await projectCanvas(job);
        return job;
      }
    } else {
      // Resume path: the contract is unchanged, but the stored digest itself or
      // the re-persisted Channel Pack verification may have drifted. Block the
      // durable Job instead of throwing past it, so the reason is recorded.
      try {
        assertVideoHarnessExecutionIdentity(job);
      } catch (error) {
        const detail = boundedText(error?.message || error, [...collectSensitiveValues(job)]);
        job = await persistJobTransition(job, (current) => ({
          ...current,
          status: "blocked-preflight",
          updatedAt: now(),
          blockers: ["canonical-identity-drift"],
          knownRemainingIssues: [detail],
          stages: replaceStage(current.stages, "doctor", {
            status: "failed",
            finishedAt: now(),
            evidence: { ready: false, blocking: ["canonical-identity-drift"], error: detail },
          }),
        }), { now });
        if (typeof projectCanvas === "function") await projectCanvas(job);
        return job;
      }
    }
  }

  let report;
  try {
    report = await doctor({
      projectDir: job.executionProjectDir || job.projectDir,
      harnessId: job.harness.id,
      job,
    });
  } catch (error) {
    report = { ready: false, blocking: ["doctor-error"], error: boundedText(error?.message || error) };
  }
  const reportSecrets = [...collectSensitiveValues(report)];
  const safeReport = safeDiagnosticValue(report, reportSecrets);
  if (report?.ready !== true) {
    const blockers = Array.isArray(report?.blocking) && report.blocking.length
      ? report.blocking.slice(0, 200).map((value) => boundedText(value, reportSecrets, 500))
      : ["doctor-not-ready"];
    job = await persistJobTransition(job, (current) => ({
      ...current,
      status: "blocked-preflight",
      updatedAt: now(),
      blockers,
      stages: replaceStage(current.stages, "doctor", {
        status: "failed",
        finishedAt: now(),
        evidence: safeReport,
      }),
    }), { now });
    if (typeof projectCanvas === "function") await projectCanvas(job);
    return job;
  }

  // 制作へ渡す入力（取り込みの記録の中身の SHA を含む）を、渡す直前の値で残す。更新をまたいで確定させる
  // ときは、最後に制作へ渡した入力と今の入力を比べる。
  const dispatchInputIdentity = videoHarnessInputIdentity({
    harnessId: job.harness.id,
    scriptSha256: job.script.sha256,
    channelPack: job.channelPack || null,
    options: job.options || {},
    operatorImports: await operatorImportDigests(job.options || {}),
  });
  job = await persistJobTransition(job, (current) => ({
    ...current,
    status: "running",
    blockers: [],
    updatedAt: now(),
    inputIdentity: inputIdentityRecord(dispatchInputIdentity, { recordedAt: now(), recordedFor: "dispatch" }),
    stages: replaceStage(current.stages, "doctor", { status: "pass", finishedAt: now(), evidence: safeReport }),
  }), { now });
  if (job.status === "cancelled") {
    if (typeof projectCanvas === "function") await projectCanvas(job);
    return job;
  }
  if (typeof projectCanvas === "function") await projectCanvas(job);

  // doctor itself (or a concurrent updater while doctor was running) may have
  // changed an imported production module.  Recheck the complete dependency
  // identity at the last common boundary before any genre adapter can start;
  // this protects both Koya and narrated-story routes, not only children that
  // implement their own upstream verification.
  try {
    await assertVideoHarnessJobIdentity(job, { validateProductionProfile });
  } catch (error) {
    const secrets = [...collectSensitiveValues(job)];
    const detail = boundedText(error?.message || error, secrets);
    job = await persistJobTransition(job, (current) => ({
      ...current,
      status: "blocked-preflight",
      updatedAt: now(),
      blockers: ["canonical-identity-drift"],
      knownRemainingIssues: [detail],
      stages: replaceStage(current.stages, "doctor", {
        status: "failed",
        finishedAt: now(),
        evidence: { ready: false, blocking: ["canonical-identity-drift"], error: detail },
      }),
    }), { now });
    if (typeof projectCanvas === "function") await projectCanvas(job);
    return job;
  }

  // 更新をまたいで確定させる Job は再利用だけで走らせる。新しい有料の呼び出しは送る直前に止め、台帳に残す
  // （lib/paidCallGuard.mjs）。Koya の子には Job に固定した制作契約の写しを渡す。
  const finalizeOnly = isFinalizeAfterUpdateJob(job);
  const paidCallGuardPath = finalizeOnly
    ? join(resolve(job.runDir), FINALIZE_AFTER_UPDATE_DIR, `refused-paid-calls-r${job.revision}.jsonl`)
    : "";
  if (paidCallGuardPath) {
    await mkdir(dirname(paidCallGuardPath), { recursive: true });
    await rm(paidCallGuardPath, { force: true });
  }
  let outcome;
  try {
    outcome = await adapter({
      job,
      prepareResult,
      now,
      isCancellationRequested: async () => {
        const current = await readVideoHarnessJob({ projectDir: job.projectDir, jobId: job.id });
        return current.status === "cancel-requested";
      },
      ...(finalizeOnly ? {
        paidCallGuardPath,
        pinnedProductionContractPath: nonEmpty(job.codeIdentityRebind.pinnedProductionContract?.path),
      } : {}),
    });
  } catch (error) {
    const detail = boundedText(error?.message || error);
    outcome = { status: "failed", error: detail, knownRemainingIssues: [detail] };
  }
  job = await readVideoHarnessJob({ projectDir: job.projectDir, jobId: job.id });
  if (job.status === "cancel-requested") {
    job = await persistJobTransition(job, (current) => current, { now });
    if (typeof projectCanvas === "function") await projectCanvas(job);
    return job;
  }
  if (TERMINAL.has(job.status)) return job;
  // 再利用だけの実行の結果。止めた有料の呼び出しが1件でもあれば、子がどう報告しても確定させない。
  let finalizeRun = null;
  if (paidCallGuardPath) {
    const refused = readPaidCallGuardLedger(paidCallGuardPath);
    finalizeRun = {
      at: now(),
      jobRevision: job.revision,
      guard: "reuse-only",
      refusedPaidCalls: refused.length,
      refused: refused.slice(0, 200),
      mediaJobs: mediaJobClassificationCounts(classifyResumedMediaJobs(
        safeMediaJobs({ mediaJobs: job.mediaJobs }),
        safeMediaJobs(outcome && typeof outcome === "object" ? outcome : {}),
      )),
    };
    if (refused.length > 0) {
      const kinds = [...new Set(refused.map((row) => [row.route, row.kind, row.provider].filter(Boolean).join("/")))].slice(0, 10);
      const detail = `${FINALIZE_AFTER_UPDATE_PAID_CALL_REQUIRED_CODE}: 確定までに新しい有料の呼び出しが ${refused.length} 件要った（${kinds.join(", ")}）。`
        + "すでに作った成果物の再利用が当たらなかったので、送る前に止めた（課金していない）。入力か成果物が変わっている。新しい Job を作ること。";
      outcome = {
        ...(outcome && typeof outcome === "object" ? outcome : {}),
        status: "failed",
        blockers: [FINALIZE_AFTER_UPDATE_PAID_CALL_REQUIRED_CODE],
        error: detail,
        knownRemainingIssues: [detail],
      };
    }
    job = { ...job, codeIdentityRebind: appendFinalizeRun(job.codeIdentityRebind, finalizeRun) };
  }
  const allowed = new Set(["completed", "failed", "awaiting-human-review", "queued", "running", "cancelled"]);
  if (!allowed.has(outcome?.status)) throw new Error(`adapter が不正な status を返した: ${outcome?.status}`);
  const outcomeSecrets = [...collectSensitiveValues(outcome)];
  let completed = outcome.status === "completed";
  const issues = Array.isArray(outcome.knownRemainingIssues)
    ? outcome.knownRemainingIssues.slice(0, 1000).map((value) => boundedText(value, outcomeSecrets))
    : [];
  if (completed && issues.length > 0) {
    throw new Error("knownRemainingIssues が残るJobを completed にできない。");
  }
  let artifacts = mergeArtifacts(safeArtifacts(job.artifacts, outcomeSecrets), safeArtifacts(outcome.artifacts, outcomeSecrets));
  const mediaJobs = mergeMediaJobs(safeMediaJobs({ mediaJobs: job.mediaJobs }, outcomeSecrets), safeMediaJobs(outcome, outcomeSecrets));
  const runtimeMetadata = outcome.runtimeMetadata === undefined
    ? (job.adapterRuntimeMetadata || null)
    : safeRuntimeMetadata(outcome.runtimeMetadata, job.channelPackRuntime, outcomeSecrets);
  const adapterProbes = mergeAdapterProbes(
    safeAdapterProbes(job.adapterProbes, outcomeSecrets),
    safeAdapterProbes(outcome.adapterProbes, outcomeSecrets),
  );
  const auditChecks = safeAuditChecks(outcome.auditChecks, outcomeSecrets) || job.auditChecks || null;
  // failed からの再開なら、この adapter 実行で Media Job がどう扱われたか（再利用／recover 済み／
  // 再発行／新規）を、resume 時点の記録と突き合わせて一度だけ確定する。Receipt はこの記録を写す。
  const resumeRecord = job.resumeFromFailed?.version === VIDEO_HARNESS_FAILED_RESUME_VERSION && job.resumeFromFailed.mediaJobs === null
    ? {
      ...job.resumeFromFailed,
      mediaJobs: classifyResumedMediaJobs(
        safeMediaJobs({ mediaJobs: job.mediaJobs }, outcomeSecrets),
        safeMediaJobs(outcome, outcomeSecrets),
        new Set((job.resumeFromFailed.mediaJobRecovery || [])
          .filter((row) => row.after === "completed")
          .map((row) => row.requestKey || row.jobId)),
      ),
    }
    : job.resumeFromFailed;
  if (resumeRecord) job = { ...job, resumeFromFailed: resumeRecord };
  // 画像の作り直し（指紋迂回）の事実と、子の Media Job journal の場所。Receipt は job から読む。
  const imageEvidence = imageEvidenceFromOutcome(job, outcome, outcomeSecrets, now);
  job = { ...job, ...imageEvidence };
  let receiptPending = null;
  if (completed) {
    const finalized = await finalizeCompletedOutcome({
      job,
      outcome: { ...outcome, artifacts, mediaJobs, runtimeMetadata, adapterProbes, auditChecks },
      finalizeReceipt,
      now,
      reviewerTrustPath,
      env,
      secrets: outcomeSecrets,
    });
    if (finalized.ok) {
      artifacts = mergeArtifacts(artifacts, [finalized.receiptArtifact]);
    } else {
      // 画像・音声は生成済み＝課金済み。Receipt 確定前の失敗（信頼リスト未設定、
      // attestation 欠落、成果物 roster 不足など）で terminal failed にすると正規入口から
      // 復旧できず、作り直しは二重課金になる。再開可能な状態に置き、成果物と Media Job の
      // 証跡を Job に保存して resume が Receipt 確定だけを再試行できるようにする。
      completed = false;
      const detail = finalized.detail;
      receiptPending = pendingReceiptSnapshot({
        previous: job.pendingReceiptFinalization,
        outcome,
        artifacts,
        mediaJobs,
        runtimeMetadata,
        adapterProbes,
        auditChecks,
        detail,
        now,
        secrets: outcomeSecrets,
      });
      outcome = {
        ...outcome,
        status: "awaiting-human-review",
        blockers: receiptFailureBlockers(detail),
        error: detail,
        knownRemainingIssues: [`run-receipt: ${detail}`],
      };
    }
  }
  const finalIssues = Array.isArray(outcome.knownRemainingIssues)
    ? outcome.knownRemainingIssues.slice(0, 1000).map((value) => boundedText(value, outcomeSecrets))
    : [];
  const blockers = Array.isArray(outcome.blockers)
    ? outcome.blockers.slice(0, 1000).map((value) => boundedText(value, outcomeSecrets, 500))
    : [];
  // Receiptの確定だけではJobはcompletedではない。Canvas投影も本番契約の一部なので、
  // 投影前にprocessが落ちても次のresumeが早期returnせず修復できるよう、ここでは
  // non-terminalのrunningを永続化する。completedへ進めるのは投影成功後だけ。
  const persistedOutcomeStatus = completed ? "running" : outcome.status;
  job = await persistJobTransition(job, (current) => ({
    ...current,
    status: persistedOutcomeStatus,
    updatedAt: now(),
    ...(TERMINAL.has(persistedOutcomeStatus) ? { completedAt: now() } : {}),
    blockers,
    knownRemainingIssues: finalIssues,
    artifacts: mergeArtifacts(safeArtifacts(current.artifacts, outcomeSecrets), artifacts),
    mediaJobs: mergeMediaJobs(safeMediaJobs({ mediaJobs: current.mediaJobs }, outcomeSecrets), mediaJobs),
    adapterRuntimeMetadata: runtimeMetadata,
    adapterProbes: mergeAdapterProbes(safeAdapterProbes(current.adapterProbes, outcomeSecrets), adapterProbes),
    auditChecks,
    adapterRunReceiptPath: boundedText(outcome.runReceiptPath, outcomeSecrets, 4000),
    adapterResult: safeAdapterResult(outcome.result, outcomeSecrets),
    ...(resumeRecord ? { resumeFromFailed: resumeRecord } : {}),
    ...(finalizeRun ? { codeIdentityRebind: appendFinalizeRun(current.codeIdentityRebind, finalizeRun) } : {}),
    ...imageEvidence,
    pendingReceiptFinalization: receiptPending || undefined,
    ...(outcome.error ? { error: boundedText(outcome.error, outcomeSecrets) } : { error: undefined }),
    stages: replaceStage(current.stages, "production", {
      status: completed || receiptPending ? "pass" : outcome.status === "failed" ? "failed" : outcome.status,
      finishedAt: completed || receiptPending || TERMINAL.has(outcome.status) ? now() : undefined,
    }),
  }), { now });
  if (job.status === "cancelled") {
    if (typeof projectCanvas === "function") await projectCanvas(job);
    return job;
  }
  job = {
    ...job,
    stages: replaceStage(job.stages, "audit", {
      status: completed ? "pass" : receiptPending ? "awaiting-human-review" : outcome.status === "failed" ? "failed" : "pending",
      finishedAt: completed || outcome.status === "failed" ? now() : undefined,
    }),
  };
  if (completed) {
    job.stages = replaceStage(job.stages, "canvas-projection", { status: "running", startedAt: now() });
  }
  job = await persistJobTransition(job, (current) => ({
    ...current,
    ...job,
    revision: current.revision,
  }), { now, allowTerminalTransition: true });
  if (completed && typeof afterPreProjectionPersist === "function") {
    // Test/host fault-injection point: a crash here must leave a resumable Job.
    await afterPreProjectionPersist(job);
  }
  if (completed) return completeCanvasProjection(job, { projectCanvas, now, afterCompletedCanvasProjection });
  if (typeof projectCanvas === "function") await projectCanvas(job);
  return job;
}

export async function requestVideoHarnessCancellation({ projectDir = process.cwd(), jobId, now = () => new Date().toISOString() } = {}) {
  let job = await readVideoHarnessJob({ projectDir, jobId });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (TERMINAL.has(job.status) || job.status === "cancel-requested") return job;
    const updated = {
      ...job,
      status: "cancel-requested",
      cancelRequestedAt: now(),
      updatedAt: now(),
    };
    try {
      return await writeJob(updated);
    } catch (error) {
      if (!isJobWriteConflict(error)) throw error;
      await shortYield();
      job = await readVideoHarnessJob({ projectDir, jobId });
    }
  }
  const error = new Error(`Video Harness Job ${jobId} のcancel CASが競合し続けた。`);
  error.code = "VIDEO_HARNESS_JOB_CAS_EXHAUSTED";
  throw error;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

export const _testing = Object.freeze({
  assertFailedJobResumable,
  assertNoReviewerTrustInOptions,
  classifyResumedMediaJobs,
  collectSensitiveValues,
  defaultRecoverMediaJob,
  failedStageOf,
  imageEvidenceFromOutcome,
  resolveReviewerTrust,
  receiptFailureBlockers,
  receiptFinalizationIsRepairable,
  mergeAdapterProbes,
  mergeArtifacts,
  mergeMediaJobs,
  safeAdapterProbes,
  safeAdapterResult,
  safeArtifacts,
  safeAuditChecks,
  safeMediaJobs,
  safeRuntimeMetadata,
  writeJob,
});

/**
 * 二重起動を防ぐprocess lock。heartbeatを持ち、PIDが生きている限り古く見えても
 * 奪わない。ホスト停止後の死んだPIDだけを1回回収する。
 */
export async function withVideoHarnessJobLock({ projectDir = process.cwd(), jobId }, action, recoveryAttempt = 0) {
  const path = join(runRoot(projectDir, jobId), ".job.lock");
  let handle;
  try {
    handle = await open(path, "wx");
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
  } catch (error) {
    if (error?.code === "EEXIST") {
      let owner = null;
      try { owner = JSON.parse(await readFile(path, "utf8")); } catch { /* 壊れたlockも下で保守的に扱う */ }
      if (owner && !processIsAlive(Number(owner.pid)) && recoveryAttempt === 0) {
        await rm(path, { force: true });
        return withVideoHarnessJobLock({ projectDir, jobId }, action, recoveryAttempt + 1);
      }
      throw new Error(`Job ${jobId} は別processが操作中。二重実行しない。`);
    }
    throw error;
  }
  const heartbeat = setInterval(() => {
    writeFile(path, `${JSON.stringify({ pid: process.pid, heartbeatAt: new Date().toISOString() })}\n`, "utf8").catch(() => {});
  }, 10_000);
  heartbeat.unref?.();
  try {
    return await action();
  } finally {
    clearInterval(heartbeat);
    await handle?.close();
    await rm(path, { force: true });
  }
}
