#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  REVIEWER_TRUST_ENV_GUIDANCE,
  REVIEWER_TRUST_PATH_ENV,
  writeReviewerKeyPairFiles,
} from "../lib/koyaReviewAttestation.mjs";
import {
  NARRATED_STORY_VIDEO_OUTCOME_VERSION,
  inspectNarratedStoryVideoInputs,
  runNarratedStoryVideo,
  signNarratedStoryVideoReview,
} from "../lib/narratedStoryVideo.mjs";
import { appendManagedToolsToPath } from "../lib/prerequisiteTools.mjs";

export {
  NARRATED_STORY_VIDEO_OUTCOME_VERSION,
  inspectNarratedStoryVideoInputs,
  runNarratedStoryVideo,
};

function parseArgs(argv) {
  const parsed = { command: argv[0] || "help" };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = value;
      index += 1;
    }
  }
  return parsed;
}

function usage() {
  return [
    "Usage: node scripts/narrated-story-video.mjs <command> [options]",
    "",
    "full --script-path FILE --channel-pack-dir DIR --job-id ID --upstream-job-path JOB.json --upstream-job-id ID --upstream-job-revision N --upstream-execution-binding SHA256 [--project-dir DIR] [--reviewer-trust-path JSON] [--job-identity-digest SHA256] [--retry-failed-images] [--operator-image-manifest FILE] [--operator-video-manifest FILE]",
    "  --script-path accepts a raw Japanese script, a script package (script-package.json, format buzzassist-narrated-script-package-v1: story / review / speakers / readings / musicSection / sceneIntent), or a Markdown script whose story and review headings the Channel Pack declares in scriptIntake.markdown. Headings are never voiced.",
    "  --retry-failed-images rebuilds image Media Jobs that ended failed after they may have been charged (uncharged failures and recovery-required jobs are settled automatically without it); the outcome records how many were rebuilt.",
    "  --operator-image-manifest FILE (buzzassist-operator-image-manifest-v1) imports the operator's own scene images (ChatGPT web / Codex / local model / Grok / other) instead of image Media Jobs, when the Channel Pack declares image.source \"operator-file\". It must be the path the outer Job declares in options.operatorImageManifestPath (run-video-harness.mjs start --operator-image-manifest FILE); otherwise the runner stops with operator-image-manifest-not-bound-to-job. Every scene of the script must be covered (no mixing with paid image generation); the image and prompt files are re-hashed against the manifest, references must be approved character sheets, sizes must be within the Pack tolerance, and any failure stops before paid work with an operator-image-* reason code. Replacing an image changes the input fingerprint, so resume re-imports it and re-renders without re-billing voices or music. Conversation URLs stay in the private Job folder (.media/.../operator-images); only their SHA-256 reaches the generation manifest, audit, RunReceipt and Canvas.",
    "  --operator-video-manifest FILE (buzzassist-operator-video-manifest-v1) imports the operator's own short videos for the slots the Channel Pack declares (episode-opening when bookends.opening.kind is episode-video). It must be the path the outer Job declares in options.operatorVideoManifestPath (pass it at start through --options-json or the MCP options); otherwise the runner stops with operator-video-manifest-not-bound-to-job. Each clip is re-hashed, probed (duration, size, frame rate, audio) against the slot rules and copied into the Job folder before any paid work; failures stop with an operator-video-* reason code. Conversation URLs and route notes stay in the private Job folder; only SHA-256 values and numbers reach the generation manifest, audit, RunReceipt and Canvas.",
    "  Paid production runner, launched only by the outer scripts/run-video-harness.mjs start/resume (or the run_video_harness MCP tool). Without the complete outer Job binding it stops with NARRATED_OUTER_JOB_REQUIRED before any paid generation, the same way scripts/koya-manga-video.mjs full does; a partial binding is refused too.",
    `  Before the pipeline touches disk or a Media Job it checks the reviewer trust anchor: the trust list comes only from the operator's ${REVIEWER_TRUST_ENV_GUIDANCE} and must hold at least one active key (reviewer-trust-unconfigured / reviewer-trust-invalid:env-ambiguous / reviewer-trust-invalid:no-active-reviewers otherwise); --reviewer-trust-path is a cross-check that must match it (reviewer-trust-conflict) and cannot stand alone. The finalizer re-verifies the signoff's Ed25519 reviewer attestation against the same list and never passes an unsigned or untrusted signoff. The Job identityDigest is taken from the bound upstream Job.`,
    "",
    "reviewer-key-create --reviewer-key-path /absolute/outside-repo/reviewer-ed25519.pem [--reviewer-public-key-path FILE] [--reviewer-label NAME] [--project-dir DIR]",
    "  Writes a new Ed25519 private key with mode 0600 (public key beside it as .pub), refuses to overwrite either file, refuses paths inside this repository, the project dir, or any git working tree, and prints the keyId plus the trust-list entry the operator registers out of band. Same behavior as scripts/koya-manga-video.mjs reviewer-key-create.",
    "",
    "signoff --job-id ID --project-dir DIR --reviewer claude|codex [--reviewer-id ID] --reviewer-context-id TASK_OR_SESSION_ID --reviewer-key-path /absolute/reviewer-ed25519.pem --review-path REVIEW.json [--reviewer-trust-path JSON] [--signoff-path FILE] [--video-path MP4] [--contact-sheet-path PNG] [--force] --pass|--fail",
    `  Independent reviewer only (the reviewer task/session must differ from the production Job). Reads the durable Job's identityDigest from --project-dir, hashes the reviewed MP4 and contact sheet from disk, signs the subject with the private key read from --reviewer-key-path (never from argv), and requires that key to be active in the operator's trust list from ${REVIEWER_TRUST_ENV_GUIDANCE}; --reviewer-trust-path only cross-checks that list and never replaces it. Writes review/contact-sheet-signoff.json in the Job workspace unless --signoff-path is given.`,
    "  --review-path is the reviewer's scoring file { \"rubricScores\": { <criterion id>: 0-100 }, \"notes\": \"what was watched and judged\", \"findings\": [\"what to change\"] }, scored against every criterion in the Job's review.quality rubric (shown in the production outcome). --pass approves (findings must be empty); --fail asks for changes (at least one finding). Either verdict becomes one round of the quality loop; the Job is final only when a round meets the target score with no criterion below its floor and every machine gate passing. Each round needs a fresh --reviewer-context-id, and every round after the first needs quality/revision-delta.json { previousFailureFingerprint, revisionDelta[, predecessorJobId] } in the Job workspace.",
    "",
    "help",
  ].join("\n");
}

function print(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (["help", "--help", "-h"].includes(args.command)) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  if (args.command === "reviewer-key-create") {
    if (typeof args.reviewerKeyPath !== "string") {
      throw new Error("reviewer-key-create requires --reviewer-key-path FILE (the private key is written there, never printed).");
    }
    // 鍵の中身は argv に取らない。置き場の制約と wx/0600 は共通実装が守る。
    const created = await writeReviewerKeyPairFiles({
      privateKeyPath: resolve(args.reviewerKeyPath),
      publicKeyPath: typeof args.reviewerPublicKeyPath === "string" ? resolve(args.reviewerPublicKeyPath) : "",
      label: typeof args.reviewerLabel === "string" ? args.reviewerLabel : "",
      projectDir: resolve(args.projectDir || process.cwd()),
    });
    print({
      ...created,
      next: `Hand trustEntry to the operator (owner) out of band; the operator registers it under reviewers[] in the trust list and points ${REVIEWER_TRUST_PATH_ENV} (legacy alias BUZZASSIST_KOYA_REVIEWER_TRUST) at that file on the audit/receipt host. Only that environment variable is a trust anchor; --reviewer-trust-path is a cross-check. The private key never enters a Channel Pack, signoff, argv, MCP arguments, or Job options.`,
    });
    return created;
  }
  if (args.command === "signoff") {
    if ((args.pass === true) === (args.fail === true)) {
      throw new Error("Signoff requires exactly one of --pass (approve) or --fail (ask for changes), after the MP4 and contact sheet have actually been inspected.");
    }
    if (typeof args.reviewerKeyPath !== "string") {
      throw new Error("Signoff requires --reviewer-key-path FILE pointing at the reviewer's Ed25519 private key (create one with reviewer-key-create; never pass key material on argv).");
    }
    if (typeof args.reviewPath !== "string") {
      throw new Error("Signoff requires --review-path FILE with { rubricScores, notes, findings } scored against the Job's review.quality rubric.");
    }
    const written = await signNarratedStoryVideoReview({
      projectDir: resolve(args.projectDir || process.cwd()),
      jobId: args.jobId,
      reviewerHost: typeof args.reviewer === "string" ? args.reviewer : "",
      reviewerId: typeof args.reviewerId === "string" ? args.reviewerId : "",
      reviewerContextId: typeof args.reviewerContextId === "string" ? args.reviewerContextId : "",
      videoPath: typeof args.videoPath === "string" ? resolve(args.videoPath) : "",
      contactSheetPath: typeof args.contactSheetPath === "string" ? resolve(args.contactSheetPath) : "",
      signoffPath: typeof args.signoffPath === "string" ? resolve(args.signoffPath) : "",
      reviewerPrivateKeyPath: resolve(args.reviewerKeyPath),
      reviewerTrustPath: typeof args.reviewerTrustPath === "string" ? resolve(args.reviewerTrustPath) : "",
      reviewPath: resolve(args.reviewPath),
      force: args.force === true,
      pass: args.pass === true,
      fail: args.fail === true,
    });
    print({
      jobId: args.jobId,
      outputPath: written.outputPath,
      reviewer: written.signoff.reviewer,
      reviewerContextId: written.signoff.reviewerContextId,
      reviewerKeyId: written.signerKeyId,
      videoSha256: written.videoSha256,
      contactSheetSha256: written.contactSheetSha256,
      pass: args.pass === true,
      approved: written.signoff.approved === true,
      next: `Resume the outer Job: node scripts/run-video-harness.mjs resume --job-id ${args.jobId} (the finalizer and the common RunReceipt re-verify this signature against the trust list, then record this review as one round of the quality loop).`,
    });
    return written;
  }
  if (args.command !== "full") throw new Error(`Unknown command: ${args.command}\n${usage()}`);
  const outcome = await runNarratedStoryVideo({
    command: args.command,
    scriptPath: args.scriptPath,
    channelPackDir: args.channelPackDir,
    jobId: args.jobId,
    deploymentRoot: args.projectDir || process.cwd(),
    mediaJobApiBase: args.mediaJobApiBase,
    signoffPath: args.signoffPath,
    upstreamJobPath: args.upstreamJobPath,
    upstreamJobId: args.upstreamJobId,
    upstreamJobRevision: args.upstreamJobRevision,
    upstreamExecutionBinding: args.upstreamExecutionBinding,
    jobIdentityDigest: typeof args.jobIdentityDigest === "string" ? args.jobIdentityDigest : "",
    reviewerTrustPath: typeof args.reviewerTrustPath === "string" ? resolve(args.reviewerTrustPath) : "",
    retryFailedImages: args.retryFailedImages === true,
    operatorImageManifestPath: typeof args.operatorImageManifest === "string" ? resolve(args.operatorImageManifest) : "",
    operatorVideoManifestPath: typeof args.operatorVideoManifest === "string" ? resolve(args.operatorVideoManifest) : "",
  });
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  process.exitCode = outcome.status === "final-audited" ? 0 : 3;
  return outcome;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // setup が ~/.buzzassist/tools に入れた ffmpeg / ffprobe を各工程に見せる（運営者の PATH が先）。
  appendManagedToolsToPath(process.env);
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
