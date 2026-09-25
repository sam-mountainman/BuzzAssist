/**
 * Public, channel-agnostic narrated-story video runtime.
 *
 * Private channel policy enters only through the verified Channel Pack payload
 * directory. Provider credentials remain behind the paid-media job boundary.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadReviewerTrust, preflightReviewerTrust } from "./koyaReviewAttestation.mjs";
import {
  NARRATED_STORY_HARNESS_ID,
  inspectNarratedStoryInputs,
  runNarratedStoryPipeline,
  writeNarratedReviewSignoff,
} from "./narratedStoryPipeline.mjs";
import { readVideoHarnessJob, verifyVideoHarnessUpstreamExecution } from "./videoHarnessJob.mjs";

const SHA256_HEX = /^[a-f0-9]{64}$/u;
const text = (value) => (typeof value === "string" ? value.trim() : "");

export const NARRATED_STORY_VIDEO_OUTCOME_VERSION = "buzzassist-narrated-story-video-outcome-v1";
/** `full` が外側の durable Job 無しで呼ばれたときの error.code（Koya の KOYA_OUTER_JOB_REQUIRED と対）。 */
export const NARRATED_OUTER_JOB_REQUIRED_CODE = "NARRATED_OUTER_JOB_REQUIRED";

/**
 * 有料生成の前に reviewer 信頼アンカーを確かめる（R6-1 の narrated 側。R5-REV-01）。
 *
 * 規則の実装は lib/koyaReviewAttestation.mjs の loadReviewerTrust / preflightReviewerTrust の
 * 1 か所で、ここはそれを「pipeline が disk・Media Job に触る前」に呼ぶだけ。明示 path と
 * in-memory の `reviewerTrust` は照合用として同じ loadReviewerTrust に渡す（env と不一致なら
 * reviewer-trust-conflict、env 未設定なら reviewer-trust-unconfigured、全件 revoked なら
 * reviewer-trust-invalid:no-active-reviewers）。不合格は throw し、error.code に失敗コードを載せる。
 * detail に path 文字列は含まれない（loadReviewerTrust の例外文も path を含まない）。
 */
export async function assertNarratedReviewerTrustPreflight({ reviewerTrust = null, reviewerTrustPath = "", env = process.env } = {}) {
  const result = await preflightReviewerTrust({
    trustPath: text(reviewerTrustPath),
    env,
    loadTrust: (args) => loadReviewerTrust({ ...args, trust: reviewerTrust }),
  });
  if (result.ok) return result;
  const error = new Error(`${result.code}: narrated-story full stopped before paid generation (reviewer trust anchor preflight). ${result.detail}`);
  error.code = result.code;
  error.reviewerTrust = result;
  throw error;
}

/** 子へ渡した manifest が、Job の options.operatorImageManifestPath と違うときの error.code。 */
export const OPERATOR_IMAGE_MANIFEST_UNBOUND_CODE = "operator-image-manifest-not-bound-to-job";

/**
 * 子 CLI の --operator-image-manifest と、検証済みの上位 Job の options.operatorImageManifestPath が
 * 同じ path を指すこと（どちらかだけ、または別の path なら止める）。Job の options は identity に入るので、
 * 取り込む画の置き場は Job を作った時点で決まる。中身（sha256）は pipeline が入力の指紋として束縛する。
 */
export async function assertOperatorImageManifestBoundToJob({ upstreamJobPath, operatorImageManifestPath }) {
  let job;
  try {
    job = JSON.parse(await readFile(resolve(String(upstreamJobPath)), "utf8"));
  } catch {
    job = null;
  }
  const declared = text(job?.options?.operatorImageManifestPath);
  const passed = text(operatorImageManifestPath);
  if (!declared && !passed) return;
  if (!declared || !passed || resolve(declared) !== resolve(passed)) {
    const error = new Error(`${OPERATOR_IMAGE_MANIFEST_UNBOUND_CODE}: the operator image manifest passed to the narrated runner must be the one the outer Job declares in options.operatorImageManifestPath (start the Job with --operator-image-manifest).`);
    error.code = OPERATOR_IMAGE_MANIFEST_UNBOUND_CODE;
    throw error;
  }
}

export async function inspectNarratedStoryVideoInputs({ scriptPath, channelPackDir } = {}) {
  return inspectNarratedStoryInputs({ scriptPath, channelPackDir });
}

export async function runNarratedStoryVideo({
  command = "full",
  scriptPath,
  channelPackDir,
  jobId,
  deploymentRoot = process.cwd(),
  mediaJobRunner,
  mediaJobProbe,
  mediaJobApiBase,
  mediaJobFetch,
  artifactFetch,
  signoffPath,
  ffmpegToolchain,
  upstreamJobPath,
  upstreamJobId,
  upstreamJobRevision,
  upstreamExecutionBinding,
  jobIdentityDigest = "",
  reviewerTrust = null,
  reviewerTrustPath = "",
  retryFailedImages = false,
  voiceQualityGate = undefined,
  operatorImageManifestPath = "",
  env = process.env,
} = {}, runtime = {}) {
  if (command !== "full") throw new Error(`Unsupported narrated-story video command: ${command}`);
  if (!String(jobId || "").trim()) throw new Error("full requires --job-id from the durable outer job.");
  // reviewer attestation の期待 subject に要る Job identityDigest。上位 Job から渡る
  // upstream binding が真値で、明示値があれば一致を要求する（食い違いは別 Job の疑い）。
  let identityDigest = text(jobIdentityDigest);
  if (identityDigest && !SHA256_HEX.test(identityDigest)) {
    throw new Error("--job-identity-digest must be the durable Job's lowercase SHA-256 identityDigest.");
  }
  const upstreamValues = [
    upstreamJobPath,
    upstreamJobId,
    upstreamJobRevision === undefined || upstreamJobRevision === "" ? "" : String(upstreamJobRevision),
    upstreamExecutionBinding,
  ];
  const upstreamCount = upstreamValues.filter((value) => String(value || "").trim()).length;
  // Koya の assertKoyaFullPreflight と同じ規則: 部分指定は禁止、0 件も禁止。外側 Job（doctor pass・
  // 署名済み Channel Pack・identityDigest）を持たない直呼びは有料生成へ進めない。in-process の
  // テストだけが runtime.allowDirectUnboundJobForTests で通り、その場合も identityDigest の明示を要求する
  // （無ければ生成後に reviewer-attestation-expected-subject-unavailable で止まるだけの Job になる）。
  if (upstreamCount > 0 && upstreamCount !== upstreamValues.length) {
    throw new Error("Partial upstream execution evidence is forbidden; pass --upstream-job-path, --upstream-job-id, --upstream-job-revision, and --upstream-execution-binding together.");
  }
  if (upstreamCount === 0) {
    if (runtime.allowDirectUnboundJobForTests !== true) {
      const error = new Error("Narrated-story production requires the canonical outer Video Harness Job; run scripts/run-video-harness.mjs start/resume (or the run_video_harness MCP tool) instead of the internal runner directly.");
      error.code = NARRATED_OUTER_JOB_REQUIRED_CODE;
      throw error;
    }
    if (!identityDigest) {
      throw new Error("Test-only unbound narrated-story run still requires --job-identity-digest of the durable Job.");
    }
  } else {
    if (String(jobId) !== String(upstreamJobId || "")) {
      throw new Error("Narrated-story runner jobId does not match the bound upstream Job.");
    }
    const upstream = await verifyVideoHarnessUpstreamExecution({
      upstreamJobPath,
      upstreamJobId,
      upstreamJobRevision,
      upstreamExecutionBinding,
      harnessId: NARRATED_STORY_HARNESS_ID,
      scriptPath,
    });
    if (identityDigest && identityDigest !== upstream.identityDigest) {
      throw new Error("Narrated-story runner --job-identity-digest does not match the bound upstream Job.");
    }
    identityDigest = text(upstream.identityDigest);
    // 運営者の画の manifest は Job の options（identity の一部）に書いたものだけを使う。子へ別の
    // manifest を渡して、Job が宣言していない画を取り込む道を残さない。
    await assertOperatorImageManifestBoundToJob({ upstreamJobPath, operatorImageManifestPath });
  }
  // R6-1（narrated）: 信頼アンカーが無い host では、生成後に Receipt 確定で止まるのではなくここで止める。
  // pipeline は run dir を作り Media Job を submit するので、その前に呼ぶ。
  await assertNarratedReviewerTrustPreflight({ reviewerTrust, reviewerTrustPath, env });
  const outcome = await runNarratedStoryPipeline({
    scriptPath,
    channelPackDir,
    jobId: String(jobId),
    deploymentRoot,
    mediaJobRunner,
    mediaJobProbe,
    mediaJobApiBase,
    mediaJobFetch,
    artifactFetch,
    signoffPath,
    ffmpegToolchain,
    jobIdentityDigest: identityDigest,
    reviewerTrust,
    reviewerTrustPath,
    // 失敗した画像だけを作り直す（課金された失敗の送り直し。Job の識別子には入らず、回数を記録する）。
    retryFailedImages: retryFailedImages === true,
    // 声の品質ゲートの差し替えは in-process の試験だけ（CLI からは渡せない。既定は本物の python 実行系）。
    ...(voiceQualityGate ? { voiceQualityGate } : {}),
    // 運営者の画の取り込みの記録（Pack の image.source が operator-file のとき）。
    operatorImageManifestPath: text(operatorImageManifestPath) ? resolve(text(operatorImageManifestPath)) : "",
    env,
  });
  return { ...outcome, version: NARRATED_STORY_VIDEO_OUTCOME_VERSION };
}

/**
 * reviewer CLI の signoff。identityDigest は durable Job（canvas/harness-runs/<id>/job.json）
 * から読む。手入力させると別 Job の digest で署名できてしまうので、引数には取らない。
 */
export async function signNarratedStoryVideoReview({
  projectDir = process.cwd(),
  deploymentRoot = "",
  jobId,
  ...rest
} = {}) {
  const id = text(jobId);
  if (!id) throw new Error("signoff requires --job-id of the durable outer Job.");
  let job;
  try {
    job = await readVideoHarnessJob({ projectDir, jobId: id });
  } catch (error) {
    throw new Error(`durable Job を読めない（--project-dir は Job を作った project を指すこと）: ${error?.message || error}`);
  }
  if (job?.id !== id || job?.harness?.id !== NARRATED_STORY_HARNESS_ID) {
    throw new Error("The durable Job is not the requested narrated-story-video Job.");
  }
  if (!SHA256_HEX.test(text(job.identityDigest))) {
    throw new Error("reviewer-attestation-expected-subject-unavailable:identityDigest — the durable Job has no canonical identityDigest.");
  }
  return writeNarratedReviewSignoff({
    ...rest,
    // production 子は --project-dir を deploymentRoot に使う（job.deployment.root は
    // BuzzAssist 配備側の root で、Job workspace の置き場ではない）。
    deploymentRoot: text(deploymentRoot) || projectDir,
    jobId: id,
    identityDigest: job.identityDigest,
  });
}
