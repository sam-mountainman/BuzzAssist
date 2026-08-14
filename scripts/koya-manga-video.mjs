#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { auditKoyaMangaFinal, writeKoyaVisualSignoff } from "../lib/koyaMangaFinalAudit.mjs";
import {
  adjustKoyaMangaUtteranceGap,
  approveKoyaCharacterCandidate,
  createKoyaEpisodeManifest,
  generateKoyaMangaImages,
  generateKoyaMangaSpeech,
  koyaEpisodePaths,
  planKoyaMangaProduction,
  readKoyaProductionState,
  repairKoyaMangaAudioOnset,
  repairKoyaMangaAudioTail,
  renderKoyaMangaVideo,
  refreshKoyaMangaBubbles,
  standardizeKoyaMangaCut,
  syncKoyaMangaContract,
} from "../lib/koyaMangaProduction.mjs";
import { resolveKoyaMangaProductionContract } from "../lib/koyaMangaProductionContract.mjs";
import { disposeMediaGenerationResources } from "../lib/mediaGeneration.mjs";

function parseArgs(argv) {
  const values = { action: argv[2] || "help" };
  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) values[key] = true;
    else { values[key] = next; index += 1; }
  }
  return values;
}

function usage() {
  return [
    "Koya manga video production (fail-closed)",
    "",
    "node scripts/koya-manga-video.mjs <action> [options]",
    "actions: contract, plan, images, character-approve, prepare, speech, adjust-gap, standard-cut, repair-onset, repair-tail, sync-contract, refresh-bubbles, render, audit, signoff, full, status",
    "common: --project-dir DIR --episode-id ID --script-path FILE --title TITLE --protagonist-speaker-id ID_OR_EXACT_NAME --character-bible-path JSON [--source-face-review-path JSON] [--generator-host codex|claude|legacy-migration] [--generator-id ID] [--generator-context-id TASK_OR_SESSION_ID] [--retry-failed] [--image-concurrency N|auto] [--qa-concurrency N] [--image-fallback-model MODEL] [--qa-fallback-provider grok]",
    "source region fallback: inspect the exact source image and pass a koya-source-region-review-v2 JSON whose annotations bind normalized face/hand/prop/evidence/text bounds to the source SHA-256 (legacy koya-source-face-review-v1 remains accepted)",
    "audit: --video-path MP4 [--quick] [--dry-run]",
    "character-approve: --workflow-id ID --cast-id ID_OR_NAME --candidate-label A..E --approval-reason WHY [--approved-by NAME]",
    "repair-onset: --utterance-id ID --source-path WAV --fade-start-seconds N --fade-milliseconds 6..8 --output-file-name NAME.wav",
    "repair-tail: --utterance-id ID --source-path WAV --speech-end-seconds N --fade-start-seconds N --fade-milliseconds 6..8 --output-file-name NAME.wav",
    "adjust-gap: --utterance-id ID --target-audible-gap-seconds N [--reason TEXT]",
    "standard-cut: --cut-id ID --plan-path JSON [--reason TEXT] (remove split layout and apply validated ordinary single-image shots)",
    "sync-contract: update manifest contract metadata without changing media, then require a fresh audit",
    "refresh-bubbles: rebuild every SVG under the resolved punctuation/placement contract, then require a fresh render and audit",
    "render: [--cut-ids cut-01,cut-02] rerenders at least the named cuts; unselected cuts are reused only when their completed input hash still matches and the MP4 decodes",
    "signoff: --reviewer claude|codex [--reviewer-id ID] [--reviewer-context-id TASK_OR_SESSION_ID] --review-notes-path /absolute/review.json --pass (the evaluator task/session must differ from the generator)",
  ].join("\n");
}

const args = parseArgs(process.argv);
const projectDir = resolve(args.projectDir || process.cwd());
const common = {
  projectDir,
  episodeId: args.episodeId,
  scriptPath: args.scriptPath ? resolve(args.scriptPath) : "",
  title: args.title,
  contractPath: args.contractPath ? resolve(args.contractPath) : "",
  overridePath: args.overridePath ? resolve(args.overridePath) : "",
  protagonistSpeakerId: args.protagonistSpeakerId || "",
  characterBiblePath: args.characterBiblePath ? resolve(args.characterBiblePath) : "",
  sourceFaceReviewPath: args.sourceFaceReviewPath ? resolve(args.sourceFaceReviewPath) : "",
  cutIds: args.cutIds || "",
  retryFailed: args.retryFailed === true,
  imageConcurrency: args.imageConcurrency,
  qaConcurrency: args.qaConcurrency,
  imageFallbackModel: args.imageFallbackModel,
  qaFallbackProvider: args.qaFallbackProvider,
  generatorHost: args.generatorHost,
  generatorId: args.generatorId,
  generatorContextId: args.generatorContextId,
};

function requireEpisodeId() {
  if (!args.episodeId) throw new Error("--episode-id is required for this action.");
  return args.episodeId;
}

function print(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function scriptPathForResume() {
  if (common.scriptPath) return common.scriptPath;
  if (!args.episodeId) return "";
  try {
    const { state } = await readKoyaProductionState({ projectDir, episodeId: args.episodeId });
    return state.scriptPath || "";
  } catch {
    return "";
  }
}

async function auditOptions() {
  const episodeId = requireEpisodeId();
  const paths = koyaEpisodePaths(projectDir, episodeId);
  return {
    projectDir,
    manifestPath: paths.manifestPath,
    videoPath: args.videoPath ? resolve(args.videoPath) : "",
    quick: args.quick === true,
    dryRun: args.dryRun === true,
  };
}

let exitCode = 0;
try {
switch (args.action) {
  case "help":
  case "--help":
  case "-h":
    process.stdout.write(`${usage()}\n`);
    break;
  case "contract": {
    const resolvedContract = await resolveKoyaMangaProductionContract({
      projectDir,
      episodeId: args.episodeId,
      contractPath: common.contractPath || undefined,
      overridePath: common.overridePath || undefined,
    });
    print({
      version: resolvedContract.contract.version,
      digest: resolvedContract.digest,
      contractPath: resolvedContract.contractPath,
      episodeOverridePath: resolvedContract.episodeOverridePath,
      validation: resolvedContract.validation,
    });
    break;
  }
  case "plan": {
    requireEpisodeId();
    if (!common.scriptPath) throw new Error("--script-path is required for plan.");
    const result = await planKoyaMangaProduction(common);
    print({ episodeId: result.episodeId, state: result.state, paths: result.paths });
    break;
  }
  case "images": {
    requireEpisodeId();
    if (!common.scriptPath) throw new Error("--script-path is required for images.");
    const result = await generateKoyaMangaImages(common);
    print({ episodeId: result.episodeId, status: result.state.status, waiting: result.waiting, paths: result.paths });
    if (result.waiting || result.failed) exitCode = 3;
    break;
  }
  case "character-approve": {
    requireEpisodeId();
    const result = await approveKoyaCharacterCandidate({
      ...common,
      workflowId: args.workflowId,
      castId: args.castId,
      candidateLabel: args.candidateLabel,
      approvalReason: args.approvalReason,
      approvedBy: args.approvedBy,
    });
    print({ episodeId: result.episodeId, workflowId: result.workflowId, castId: result.castId, candidateLabel: result.candidateLabel, candidateSetId: result.candidateSetId, verdictPath: result.verdictPath, character: result.finalized.character, state: result.state });
    break;
  }
  case "prepare": {
    requireEpisodeId();
    const scriptPath = await scriptPathForResume();
    const result = await createKoyaEpisodeManifest({ ...common, scriptPath });
    print({ episodeId: result.episodeId, status: result.state.status, waiting: result.waiting, paths: result.paths });
    if (result.waiting) exitCode = 3;
    break;
  }
  case "speech": {
    requireEpisodeId();
    const result = await generateKoyaMangaSpeech({ ...common, dryRun: args.dryRun === true });
    print({ episodeId: args.episodeId, status: result.state?.status, waiting: result.waiting, reportPath: result.reportPath });
    if (result.waiting) exitCode = 3;
    break;
  }
  case "repair-onset": {
    requireEpisodeId();
    const result = await repairKoyaMangaAudioOnset({
      ...common,
      utteranceId: args.utteranceId,
      sourcePath: args.sourcePath ? resolve(args.sourcePath) : "",
      fadeStartSeconds: args.fadeStartSeconds,
      fadeMilliseconds: args.fadeMilliseconds,
      outputFileName: args.outputFileName,
      reason: args.reason,
    });
    print({
      episodeId: result.episodeId,
      utteranceId: result.utteranceId,
      status: result.state.status,
      sourcePath: result.sourcePath,
      outputPath: result.outputPath,
      durationSeconds: result.outputDurationSeconds,
      fadeStartSeconds: result.fadeStartSeconds,
      fadeMilliseconds: result.fadeMilliseconds,
      contractAuditPass: result.contractAudit.pass,
    });
    break;
  }
  case "repair-tail": {
    requireEpisodeId();
    const result = await repairKoyaMangaAudioTail({
      ...common,
      utteranceId: args.utteranceId,
      sourcePath: args.sourcePath ? resolve(args.sourcePath) : "",
      speechEndSeconds: args.speechEndSeconds,
      fadeStartSeconds: args.fadeStartSeconds,
      fadeMilliseconds: args.fadeMilliseconds,
      outputFileName: args.outputFileName,
      reason: args.reason,
    });
    print({
      episodeId: result.episodeId,
      utteranceId: result.utteranceId,
      status: result.state.status,
      sourcePath: result.sourcePath,
      outputPath: result.outputPath,
      durationSeconds: result.outputDurationSeconds,
      speechEndSeconds: result.speechEndSeconds,
      fadeStartSeconds: result.fadeStartSeconds,
      fadeMilliseconds: result.fadeMilliseconds,
      contractAuditPass: result.contractAudit.pass,
    });
    break;
  }
  case "adjust-gap": {
    requireEpisodeId();
    const result = await adjustKoyaMangaUtteranceGap({
      ...common,
      utteranceId: args.utteranceId,
      targetAudibleGapSeconds: args.targetAudibleGapSeconds,
      reason: args.reason,
    });
    print({
      episodeId: result.episodeId,
      cutId: result.cutId,
      previousUtteranceId: result.previousUtteranceId,
      utteranceId: result.utteranceId,
      status: result.state.status,
      previousTargetAudibleGapSeconds: result.previousTargetAudibleGapSeconds,
      targetAudibleGapSeconds: result.targetAudibleGapSeconds,
      embeddedPaddingGapSeconds: result.embeddedPaddingGapSeconds,
      authoredGapBeforeSeconds: result.authoredGapBeforeSeconds,
      contractAuditPass: result.contractAudit.pass,
    });
    break;
  }
  case "standard-cut": {
    requireEpisodeId();
    const result = await standardizeKoyaMangaCut({
      ...common,
      cutId: args.cutId,
      planPath: args.planPath ? resolve(args.planPath) : "",
      reason: args.reason,
    });
    print({
      episodeId: result.episodeId,
      cutId: result.cutId,
      revision: result.revision,
      status: result.state.status,
      planPath: result.planPath,
      backupPath: result.backupPath,
      shotIds: result.shotIds,
      refreshedBubbleCount: result.refreshedBubbleCount,
      contractAuditPass: result.contractAudit.pass,
    });
    break;
  }
  case "sync-contract": {
    requireEpisodeId();
    const result = await syncKoyaMangaContract(common);
    print({
      episodeId: result.episodeId,
      status: result.state.status,
      contractVersion: result.resolved.contract.version,
      contractDigest: result.resolved.digest,
      contractAuditPass: result.contractAudit.pass,
    });
    break;
  }
  case "refresh-bubbles": {
    requireEpisodeId();
    const result = await refreshKoyaMangaBubbles(common);
    print({
      episodeId: result.episodeId,
      status: result.state.status,
      refreshedBubbleCount: result.refreshed.length,
      contractVersion: result.resolved.contract.version,
      contractDigest: result.resolved.digest,
      contractAuditPass: result.contractAudit.pass,
      next: `Run render: node scripts/koya-manga-video.mjs render --episode-id ${result.episodeId} --force`,
    });
    break;
  }
  case "render": {
    requireEpisodeId();
    const result = await renderKoyaMangaVideo({
      ...common,
      force: args.force === true,
      renderConcurrency: args.renderConcurrency,
      fileName: args.fileName,
    });
    print({ episodeId: args.episodeId, status: result.state.status, videoPath: result.outputPath, state: result.state });
    break;
  }
  case "audit": {
    const result = await auditKoyaMangaFinal(await auditOptions());
    print({ reportPath: result.reportPath, pass: result.report.pass, failedAuditIds: result.report.failedAuditIds, knownRemainingIssues: result.report.knownRemainingIssues, contactSheetPath: result.contactSheetPath });
    if (!result.report.pass) exitCode = 2;
    break;
  }
  case "signoff": {
    const episodeId = requireEpisodeId();
    if (args.pass !== true) throw new Error("Signoff requires --pass after the contact sheet has actually been inspected.");
    const paths = koyaEpisodePaths(projectDir, episodeId);
    const written = await writeKoyaVisualSignoff({
      projectDir,
      manifestPath: paths.manifestPath,
      videoPath: args.videoPath ? resolve(args.videoPath) : "",
      reviewerHost: args.reviewer,
      reviewerId: args.reviewerId,
      reviewerContextId: args.reviewerContextId,
      reviewNotesPath: args.reviewNotesPath ? resolve(args.reviewNotesPath) : "",
      pass: true,
    });
    print({ episodeId, outputPath: written.outputPath, reviewerHost: written.signoff.reviewerHost, pass: true, next: `Run audit again: node scripts/koya-manga-video.mjs audit --episode-id ${episodeId}` });
    break;
  }
  case "full": {
    requireEpisodeId();
    const scriptPath = await scriptPathForResume();
    if (!scriptPath) throw new Error("--script-path is required for a new full run; resumed runs can recover it from state.");
    const imageResult = await generateKoyaMangaImages({ ...common, scriptPath });
    const episodeId = imageResult.episodeId;
    if (imageResult.waiting || imageResult.failed) {
      print({ episodeId, status: imageResult.state.status, waiting: imageResult.waiting, checkpoint: imageResult.paths.statePath, knownRemainingIssues: imageResult.state.knownRemainingIssues });
      exitCode = 3;
      break;
    }
    const prepared = await createKoyaEpisodeManifest({ ...common, episodeId, scriptPath });
    if (prepared.waiting) {
      print({ episodeId, status: prepared.state.status, waiting: true, checkpoint: prepared.paths.statePath, knownRemainingIssues: prepared.state.knownRemainingIssues });
      exitCode = 3;
      break;
    }
    const speech = await generateKoyaMangaSpeech({ ...common, episodeId });
    if (speech.waiting) {
      print({ episodeId, status: "waiting-usage-limit", waiting: true, checkpoint: speech.paths.statePath, knownRemainingIssues: speech.report.knownRemainingIssues });
      exitCode = 3;
      break;
    }
    const rendered = await renderKoyaMangaVideo({ ...common, episodeId });
    const audited = await auditKoyaMangaFinal({ projectDir, manifestPath: rendered.paths.manifestPath, videoPath: rendered.outputPath });
    print({
      episodeId,
      status: audited.report.pass ? "final-koya-audited" : "audit-incomplete",
      videoPath: rendered.outputPath,
      reportPath: audited.reportPath,
      contactSheetPath: audited.contactSheetPath,
      failedAuditIds: audited.report.failedAuditIds,
      knownRemainingIssues: audited.report.knownRemainingIssues,
    });
    if (!audited.report.pass) exitCode = 2;
    break;
  }
  case "status": {
    requireEpisodeId();
    const status = await readKoyaProductionState({ projectDir, episodeId: args.episodeId });
    print(status);
    break;
  }
  default:
    throw new Error(`Unknown action: ${args.action}\n${usage()}`);
}
} finally {
  await disposeMediaGenerationResources();
}
process.exitCode = exitCode;
