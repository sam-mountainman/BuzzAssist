// reviewer の秘密鍵はこの信頼された共通層だけで読む。外付けの実装は起動しない。
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeJsonAtomic } from "./atomicJsonFile.mjs";
import { hashHarnessArtifact } from "./harnessArtifactHash.mjs";
import { CHILD_SIGNOFF_VERSION } from "./harnessChildProtocol.mjs";
import { loadReviewerTrust, signChildReviewSignoff } from "./koyaReviewAttestation.mjs";

export function childReviewSignoffPath(job) {
  return join(resolve(job.runDir), "child-review-signoff.json");
}

export async function signoffProtocolChild({ job, args, env = process.env }) {
  const context = args.reviewerContextId.trim();
  const generatorContextId = job.generatorContextId || `production:${job.id}`;
  if ([job.id, `production:${job.id}`, generatorContextId].includes(context)) throw new Error("child-signoff-reviewer-context-not-independent");
  const signoffPath = childReviewSignoffPath(job);
  if (args.signoffPath && resolve(args.signoffPath) !== signoffPath) throw new Error("child-signoff-path-fixed-to-job");
  const review = JSON.parse(await readFile(args.reviewPath, "utf8"));
  if (review?.originalDetailReviewed !== true || !Array.isArray(review.findings) || !Array.isArray(review.knownRemainingIssues)
    || [...review.findings, ...review.knownRemainingIssues].some((value) => typeof value !== "string" || !value.trim())
    || (args.pass && (review.findings.length || review.knownRemainingIssues.length))
    || (!args.pass && !review.findings.length && !review.knownRemainingIssues.length)) {
    throw new Error("child-signoff-review-invalid: detail review and findings/issues must agree with pass");
  }
  const artifact = async (kind, override) => {
    const rows = (job.artifacts || []).filter((row) => row.kind === kind);
    if (rows.length !== 1 || (override && resolve(override) !== resolve(rows[0].path))) throw new Error(`child-signoff-artifact-invalid: ${kind}`);
    const actual = await hashHarnessArtifact(rows[0].path);
    if (!actual.bytes || actual.sha256 !== rows[0].sha256 || (rows[0].bytes !== undefined && actual.bytes !== rows[0].bytes)) {
      throw new Error(`child-signoff-artifact-SHA-mismatch: ${kind}`);
    }
    return actual;
  };
  const video = await artifact("final-video", args.videoPath);
  const sheet = await artifact("contact-sheet", args.contactSheetPath);
  const trust = await loadReviewerTrust({ env });
  const signed = await signChildReviewSignoff({
    signoff: { version: CHILD_SIGNOFF_VERSION, approved: args.pass, originalDetailReviewed: true,
      findings: review.findings, knownRemainingIssues: review.knownRemainingIssues,
      reviewer: args.reviewerId || args.reviewer, reviewerContextId: context, generatorContextId,
      videoSha256: video.sha256, contactSheetSha256: sheet.sha256 },
    harnessId: job.harness.id, jobId: job.id, identityDigest: job.identityDigest,
    privateKeyPath: args.reviewerKeyPath, trust,
  });
  await writeJsonAtomic(signoffPath, signed);
  return { signoffPath, approved: signed.approved };
}
