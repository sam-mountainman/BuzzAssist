import { execFile as execFileCallback } from "node:child_process";
import { withCanvasFileLock } from "./canvasFileLock.mjs";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { writeJsonAtomic } from "./canvasScene.mjs";
import { auditKoyaEditorialQuality } from "./koyaEditorialQualityAudit.mjs";
import { auditKoyaRenderedCamera } from "./koyaRenderedCameraAudit.mjs";
import {
  auditManifestAgainstKoyaContract,
  resolveKoyaMangaProductionContract,
  stableJson,
} from "./koyaMangaProductionContract.mjs";
import {
  createMangaFinalQualityDecision,
  createMangaQualityContract,
  createMangaQualityLoopState,
  mergeMangaQualityIncidentLedgers,
  recordMangaQualityIncident,
  recordVerifiedMangaQualityRound,
} from "./mangaQualityHarness.mjs";
import {
  createMangaEvidenceManifest,
  sha256File as sha256EvidenceFile,
  verifyMangaEvidenceManifest,
} from "./mangaQualityEvidence.mjs";
import { assertKoyaIndependentEvaluator, resolveKoyaAgentProvenance } from "./koyaMangaProvenance.mjs";
import {
  auditBubbleSegmentNaturalness,
  mangaBubbleDisplayText,
  renderCutInputHash,
} from "./mangaVideoPipeline.mjs";

const execFile = promisify(execFileCallback);

async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

async function pathExists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function utteranceAudioDigests(manifest) {
  const rows = [];
  for (const utterance of manifest.utterances || []) {
    const filePath = utterance.audio?.filePath ? resolve(utterance.audio.filePath) : "";
    rows.push({
      utteranceId: utterance.id,
      filePath,
      sha256: filePath && await pathExists(filePath) ? await sha256File(filePath) : "",
    });
  }
  return rows;
}

async function staleRenderedCuts(manifest) {
  const utteranceById = new Map((manifest.utterances || []).map((row) => [row.id, row]));
  const failures = [];
  for (const cut of manifest.cuts || []) {
    const utterances = (cut.utteranceIds || []).map((id) => utteranceById.get(id)).filter(Boolean);
    const currentInputHash = await renderCutInputHash(manifest, cut, utterances);
    const renderedInputHash = manifest.jobs?.render?.[cut.id]?.inputHash || "";
    if (!renderedInputHash || renderedInputHash !== currentInputHash) {
      failures.push({ cutId: cut.id, renderedInputHash, currentInputHash });
    }
  }
  return failures;
}

async function runCommand(command, args, options = {}) {
  try {
    const result = await execFile(command, args, {
      cwd: options.cwd,
      maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr, command, args };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || error.message || String(error),
      command,
      args,
      exitCode: error.code || 1,
    };
  }
}

async function probeDurationSeconds(videoPath) {
  const result = await runCommand("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    videoPath,
  ]);
  const durationSeconds = Number(result.stdout.trim());
  if (!result.ok || !(durationSeconds > 0)) throw new Error(`Could not probe video duration: ${result.stderr || result.stdout}`);
  return durationSeconds;
}

function expectedBubbleSegmentCount(manifest) {
  return (manifest.utterances || []).reduce((count, utterance) => (
    count + Math.max(1, utterance.bubbleSegments?.length || 0)
  ), 0);
}

export async function auditBubbleTerminalJapanesePeriods(manifest, contract) {
  const stripRequired = contract?.bubbles?.stripTerminalJapanesePeriod === true;
  const rows = [];
  for (const utterance of manifest.utterances || []) {
    const entries = Array.isArray(utterance.bubbleSegments) && utterance.bubbleSegments.length > 0
      ? utterance.bubbleSegments.map((segment) => ({ id: segment.id, path: segment.overlayPath }))
      : [{ id: utterance.id, path: utterance.overlayPath }];
    for (const [entryIndex, entry] of entries.entries()) {
      const path = entry.path ? resolve(entry.path) : "";
      const svg = path && await pathExists(path) ? await readFile(path, "utf8") : "";
      const renderedTexts = [...svg.matchAll(/data-text="([^"]*)"/gu)].map((match) => match[1]);
      // The display policy strips only the full utterance's final Japanese
      // period. A timed segment may legitimately end at an internal sentence
      // boundary, and removing that punctuation changes the authored text.
      const finalDisplayEntry = entryIndex === entries.length - 1;
      const terminalPeriodFound = finalDisplayEntry && renderedTexts.some((text) => /。$/u.test(text));
      rows.push({
        id: entry.id,
        path,
        renderedTexts,
        finalDisplayEntry,
        pass: Boolean(svg) && renderedTexts.length > 0 && (!stripRequired || !terminalPeriodFound),
        terminalPeriodFound,
      });
    }
  }
  return {
    version: "koya-bubble-terminal-punctuation-v1",
    stripTerminalJapanesePeriod: stripRequired,
    rows,
    pass: rows.length > 0 && rows.every((row) => row.pass),
  };
}

function auditBubbleNaturalSegmentation(manifest, contract) {
  const rows = (manifest.utterances || []).map((utterance) => {
    const displayText = mangaBubbleDisplayText(
      utterance.bubbleDisplayText || utterance.text,
      { stripTerminalJapanesePeriod: contract?.bubbles?.stripTerminalJapanesePeriod === true },
    );
    const result = auditBubbleSegmentNaturalness(displayText, utterance.bubbleSegments || []);
    return { utteranceId: utterance.id, displayText, ...result };
  });
  return {
    version: "koya-bubble-natural-segmentation-v1",
    rows,
    pass: rows.length > 0 && rows.every((row) => row.pass),
  };
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validSha256(value) {
  return /^[a-f0-9]{64}$/u.test(String(value || ""));
}

function nonEmptyReviewNote(value, minimumCharacters) {
  return typeof value === "string" && [...value.trim()].length >= minimumCharacters;
}

function samePath(left, right) {
  return Boolean(left && right) && resolve(left) === resolve(right);
}

function validRange(row, durationSeconds) {
  const start = Number(row?.startSeconds);
  const end = Number(row?.endSeconds);
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end <= durationSeconds + 0.25;
}

export function validateKoyaPerceptualReviewNotes(notes, contract, context = {}) {
  const failures = [];
  const evidence = notes?.evidence || {};
  const checks = notes?.checks || {};
  const policy = contract?.qualityReview || {};
  const requiredChecks = policy.requiredChecks || [];
  const minimumCharacters = Number(policy.minimumReviewNoteCharacters || 8);
  const durationSeconds = Number(notes?.video?.durationSeconds || context.videoDurationSeconds || 0);
  const requiredEvidence = ["fullVideoReviewed", "contactSheetReviewed", "representativeFramesReviewed", "audioSpotChecksReviewed"];
  const allowedEvidenceRefs = new Set(["fullVideo", "contactSheet", "representativeFrames", "audioSpotChecks"]);
  const visualChecks = new Set(["characterContinuity", "composition", "bubblePlacement", "splitPages", "textReadability", "anatomyAndPropScale", "generatedTextArtifacts"]);
  const continuousChecks = new Set(["camera", "editContinuity", "imagePacing", "dialoguePacing"]);
  const audioChecks = new Set(["audioNaturalness", "audioBoundaryArtifacts"]);
  const rubricIds = [
    "semantic-scene-fit", "character-continuity", "camera-composition", "editorial-grammar",
    "bubble-typography", "voice-performance", "audio-technical", "timing-continuity", "final-playback",
  ];

  if (notes?.version !== policy.reviewNotesVersion) failures.push("review-notes-version-mismatch");
  if (!notes?.episodeId || (context.episodeId && notes.episodeId !== context.episodeId)) failures.push("review-episode-id-mismatch");
  if (!validSha256(notes?.contractDigest) || (context.contractDigest && notes.contractDigest !== context.contractDigest)) failures.push("review-contract-digest-mismatch");
  const reviewedAtMs = Date.parse(notes?.reviewedAt || "");
  if (!Number.isFinite(reviewedAtMs)) failures.push("reviewed-at-invalid");
  else {
    const nowMs = Number(context.nowMs || Date.now());
    if (reviewedAtMs > nowMs + Number(policy.maximumFutureClockSkewSeconds || 0) * 1000) failures.push("reviewed-at-in-future");
  }
  if (!samePath(notes?.video?.path, context.videoPath || notes?.video?.path)) failures.push("review-video-path-mismatch");
  if (!validSha256(notes?.video?.sha256) || (context.videoSha256 && notes.video.sha256 !== context.videoSha256)) failures.push("review-video-digest-mismatch");
  if (!(durationSeconds > 0) || (context.videoDurationSeconds && Math.abs(durationSeconds - Number(context.videoDurationSeconds)) > 0.05)) failures.push("review-video-duration-mismatch");
  if (!samePath(notes?.contactSheet?.path, context.contactSheetPath || notes?.contactSheet?.path)) failures.push("review-contact-sheet-path-mismatch");
  if (!validSha256(notes?.contactSheet?.sha256) || (context.contactSheetSha256 && notes.contactSheet.sha256 !== context.contactSheetSha256)) failures.push("review-contact-sheet-digest-mismatch");
  if (!notes?.reviewer || typeof notes.reviewer !== "object") failures.push("reviewer-provenance-missing");
  else {
    if (!['claude', 'codex'].includes(notes.reviewer.host)) failures.push("reviewer-host-invalid");
    if (!nonEmptyReviewNote(notes.reviewer.id, 8)) failures.push("reviewer-id-missing");
    if (!nonEmptyReviewNote(notes.reviewer.contextId, 8)) failures.push("reviewer-context-id-missing");
  }
  for (const rubricId of rubricIds) {
    const value = Number(notes?.rubricScores?.[rubricId]);
    if (!Number.isFinite(value) || value < 0 || value > 100) failures.push(`rubric-score-invalid:${rubricId}`);
  }

  for (const key of requiredEvidence) {
    if (!evidence[key] || typeof evidence[key] !== "object") failures.push(`missing-evidence:${key}`);
    else if (!nonEmptyReviewNote(evidence[key].note, minimumCharacters)) failures.push(`missing-evidence-note:${key}`);
  }

  const fullVideo = evidence.fullVideoReviewed;
  if (!validRange(fullVideo, durationSeconds) || Number(fullVideo?.startSeconds) > 0.05 || Number(fullVideo?.endSeconds) < durationSeconds - 0.05) {
    failures.push("full-video-range-incomplete");
  }
  const frames = evidence.representativeFramesReviewed?.frames;
  if (!Array.isArray(frames) || frames.length < Number(policy.minimumRepresentativeFrames || 3)) {
    failures.push("representative-frame-count-insufficient");
  } else {
    const paths = new Set();
    for (const [index, frame] of frames.entries()) {
      if (!frame?.path || paths.has(resolve(frame.path))) failures.push(`representative-frame-path-invalid:${index}`);
      else paths.add(resolve(frame.path));
      if (!validSha256(frame?.sha256)) failures.push(`representative-frame-digest-invalid:${index}`);
      const timestamp = Number(frame?.timestampSeconds);
      if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > durationSeconds) failures.push(`representative-frame-timestamp-invalid:${index}`);
      if (!Array.isArray(frame?.checkIds) || frame.checkIds.length === 0 || frame.checkIds.some((id) => !requiredChecks.includes(id))) {
        failures.push(`representative-frame-checks-invalid:${index}`);
      }
    }
  }
  const intervals = evidence.audioSpotChecksReviewed?.intervals;
  if (!Array.isArray(intervals) || intervals.length < Number(policy.minimumAudioSpotChecks || 3)) {
    failures.push("audio-spot-check-count-insufficient");
  } else {
    for (const [index, interval] of intervals.entries()) {
      if (!validRange(interval, durationSeconds)) failures.push(`audio-spot-check-range-invalid:${index}`);
      if (!nonEmptyReviewNote(interval?.note, minimumCharacters)) failures.push(`audio-spot-check-note-missing:${index}`);
    }
    if (!intervals.some((interval) => Number(interval.startSeconds) <= 0.2)) failures.push("audio-spot-check-start-missing");
    if (!intervals.some((interval) => Number(interval.startSeconds) > 0.2 && Number(interval.endSeconds) < durationSeconds - 0.2)) failures.push("audio-spot-check-middle-missing");
    if (!intervals.some((interval) => Number(interval.endSeconds) >= durationSeconds - 0.2)) failures.push("audio-spot-check-end-missing");
  }

  for (const key of requiredChecks) {
    const row = checks[key];
    if (!row || typeof row !== "object" || !nonEmptyReviewNote(row.note, minimumCharacters)) {
      failures.push(`missing-check-note:${key}`);
      continue;
    }
    if (!Array.isArray(row.evidenceRefs) || row.evidenceRefs.length === 0 || row.evidenceRefs.some((id) => !allowedEvidenceRefs.has(id))) {
      failures.push(`missing-check-evidence:${key}`);
      continue;
    }
    if (visualChecks.has(key) && !row.evidenceRefs.some((id) => id === "representativeFrames" || id === "contactSheet")) failures.push(`visual-evidence-missing:${key}`);
    if (continuousChecks.has(key) && !row.evidenceRefs.includes("fullVideo")) failures.push(`full-video-evidence-missing:${key}`);
    if (audioChecks.has(key) && !row.evidenceRefs.includes("audioSpotChecks")) failures.push(`audio-evidence-missing:${key}`);
  }
  if (!Array.isArray(notes?.knownRemainingIssues)) failures.push("known-issues-missing");
  else if (notes.knownRemainingIssues.length > 0) failures.push("review-known-issues-not-empty");
  return {
    pass: failures.length === 0,
    failures: [...new Set(failures)],
    requiredEvidence,
    requiredChecks,
  };
}

export async function verifyKoyaPerceptualEvidenceFiles(notes) {
  const failures = [];
  const rows = [
    { id: "video", path: notes?.video?.path, sha256: notes?.video?.sha256 },
    { id: "contact-sheet", path: notes?.contactSheet?.path, sha256: notes?.contactSheet?.sha256 },
    ...((notes?.evidence?.representativeFramesReviewed?.frames || []).map((frame, index) => ({
      id: `representative-frame:${index}`,
      path: frame.path,
      sha256: frame.sha256,
    }))),
  ];
  for (const row of rows) {
    if (!row.path || !await pathExists(resolve(row.path))) {
      failures.push(`evidence-file-missing:${row.id}`);
      continue;
    }
    const actual = await sha256File(resolve(row.path));
    if (actual !== row.sha256) failures.push(`evidence-file-digest-mismatch:${row.id}`);
  }
  return { pass: failures.length === 0, failures, fileCount: rows.length };
}

export function validateKoyaVisualSignoff(signoff, {
  episodeId,
  videoPath,
  videoSha256,
  videoDurationSeconds,
  contactSheetPath,
  contactSheetSha256,
  reviewNotesFileSha256,
  reviewNotesContentSha256,
  evidenceFilesGate,
  contractDigest,
  contract,
  generatorProvenance,
}) {
  const checks = signoff?.checks || {};
  const required = contract?.qualityReview?.requiredChecks || [];
  const failures = [];
  if (signoff?.version !== contract?.qualityReview?.version) failures.push("signoff-version-mismatch");
  if (signoff?.episodeId !== episodeId) failures.push("episode-id-mismatch");
  if (!samePath(signoff?.videoPath, videoPath)) failures.push("video-path-mismatch");
  if (signoff?.videoSha256 !== videoSha256) failures.push("video-digest-mismatch");
  if (Math.abs(Number(signoff?.videoDurationSeconds || 0) - Number(videoDurationSeconds || 0)) > 0.05) failures.push("video-duration-mismatch");
  if (resolve(signoff?.contactSheetPath || "") !== resolve(contactSheetPath)) failures.push("contact-sheet-path-mismatch");
  if (signoff?.contactSheetSha256 !== contactSheetSha256) failures.push("contact-sheet-digest-mismatch");
  if (signoff?.contractDigest !== contractDigest) failures.push("contract-digest-mismatch");
  if (!validSha256(signoff?.reviewNotesFileSha256) || signoff.reviewNotesFileSha256 !== reviewNotesFileSha256) failures.push("review-notes-file-digest-mismatch");
  if (!validSha256(signoff?.reviewNotesContentSha256) || signoff.reviewNotesContentSha256 !== reviewNotesContentSha256) failures.push("review-notes-content-digest-mismatch");
  if (signoff?.reviewNotesContentSha256 !== sha256Text(stableJson(signoff?.reviewNotes || {}))) failures.push("embedded-review-notes-digest-mismatch");
  if (!["claude", "codex"].includes(signoff?.reviewerHost)) failures.push("reviewer-host-missing");
  const evaluatorProvenance = signoff?.reviewerProvenance;
  const independence = assertKoyaIndependentEvaluator(generatorProvenance, evaluatorProvenance);
  failures.push(...independence.failures);
  if (evaluatorProvenance?.host !== signoff?.reviewerHost) failures.push("reviewer-provenance-host-mismatch");
  if (signoff?.reviewNotes?.reviewer?.contextId !== evaluatorProvenance?.contextId) failures.push("review-notes-reviewer-context-mismatch");
  if (signoff?.pass !== true) failures.push("review-not-passed");
  for (const key of required) if (checks[key] !== true) failures.push(`unchecked:${key}`);
  const reviewNotesGate = validateKoyaPerceptualReviewNotes(signoff?.reviewNotes, contract, {
    episodeId,
    contractDigest,
    videoPath,
    videoSha256,
    videoDurationSeconds,
    contactSheetPath,
    contactSheetSha256,
  });
  failures.push(...reviewNotesGate.failures);
  if (evidenceFilesGate?.pass !== true) failures.push(...(evidenceFilesGate?.failures || ["evidence-files-not-verified"]));
  if ((signoff?.knownRemainingIssues || []).length > 0) failures.push("review-known-issues-not-empty");
  return { pass: failures.length === 0, failures: [...new Set(failures)], requiredChecks: required, reviewNotesGate };
}

export function evaluateKoyaFinalAuditSteps(contract, steps) {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const missing = contract.requiredAudits.filter((id) => !byId.has(id));
  const failed = contract.requiredAudits.filter((id) => byId.has(id) && byId.get(id).pass !== true);
  const knownRemainingIssues = [
    ...missing.map((id) => ({ id, detail: "required audit did not run" })),
    ...failed.map((id) => ({ id, detail: byId.get(id).detail || "required audit failed" })),
  ];
  return {
    requiredAuditIds: contract.requiredAudits,
    missingAuditIds: missing,
    failedAuditIds: failed,
    knownRemainingIssues,
    pass: missing.length === 0 && failed.length === 0,
  };
}

async function makeContactSheet(videoPath, outputPath, durationSeconds) {
  const interval = Math.max(0.5, Number(durationSeconds || 0) / 24);
  const result = await runCommand("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", videoPath,
    "-vf", `fps=1/${interval.toFixed(6)},scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2:black,tile=4x6:padding=2:margin=2`,
    "-frames:v", "1", outputPath,
  ]);
  return { ...result, pass: result.ok && await pathExists(outputPath), outputPath };
}

export async function writeKoyaVisualSignoff(options = {}) {
  const manifestPath = resolve(options.manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const videoPath = resolve(options.videoPath || manifest.outputs?.reviewVideo?.filePath || manifest.outputs?.finalVideo?.filePath || "");
  const contactSheetPath = resolve(options.contactSheetPath || join(dirname(manifestPath), "audits/koya-final/contact-sheet.jpg"));
  if (!await pathExists(contactSheetPath)) throw new Error(`Contact sheet does not exist: ${contactSheetPath}`);
  const reviewerHost = String(options.reviewerHost || "").toLowerCase();
  if (!["claude", "codex"].includes(reviewerHost)) throw new Error("reviewerHost must be claude or codex.");
  const projectDir = resolve(options.projectDir || process.cwd());
  const resolvedContract = await resolveKoyaMangaProductionContract({ projectDir, episodeId: manifest.id });
  if (!options.reviewNotesPath) throw new Error("reviewNotesPath is required; signoff cannot be created from --pass alone.");
  const reviewNotesPath = resolve(options.reviewNotesPath);
  const reviewNotes = await readJson(reviewNotesPath, null);
  const videoSha256 = await sha256File(videoPath);
  const videoDurationSeconds = await probeDurationSeconds(videoPath);
  const contactSheetSha256 = await sha256File(contactSheetPath);
  const reviewNotesFileSha256 = await sha256File(reviewNotesPath);
  const reviewNotesContentSha256 = sha256Text(stableJson(reviewNotes));
  const generatorProvenance = manifest.production?.provenance?.generator;
  const reviewerProvenance = resolveKoyaAgentProvenance({
    role: "evaluator",
    host: reviewerHost,
    id: options.reviewerId,
    contextId: options.reviewerContextId,
  });
  const independence = assertKoyaIndependentEvaluator(generatorProvenance, reviewerProvenance);
  if (!independence.pass) throw new Error(`Independent evaluator provenance failed: ${independence.failures.join(", ")}`);
  const reviewNotesGate = validateKoyaPerceptualReviewNotes(reviewNotes, resolvedContract.contract, {
    episodeId: manifest.id,
    contractDigest: resolvedContract.digest,
    videoPath,
    videoSha256,
    videoDurationSeconds,
    contactSheetPath,
    contactSheetSha256,
  });
  if (!reviewNotesGate.pass) {
    throw new Error(`Perceptual review notes are incomplete: ${reviewNotesGate.failures.join(", ")}`);
  }
  if (reviewNotes?.reviewer?.id !== reviewerProvenance.id || reviewNotes?.reviewer?.contextId !== reviewerProvenance.contextId || reviewNotes?.reviewer?.host !== reviewerProvenance.host) {
    throw new Error("Review notes reviewer provenance does not match the signing task/session.");
  }
  const evidenceFilesGate = await verifyKoyaPerceptualEvidenceFiles(reviewNotes);
  if (!evidenceFilesGate.pass) {
    throw new Error(`Perceptual review evidence does not match disk: ${evidenceFilesGate.failures.join(", ")}`);
  }
  if (options.pass !== true) throw new Error("A passing signoff requires pass=true after the documented review.");
  const signoff = {
    version: resolvedContract.contract.qualityReview.version,
    episodeId: manifest.id,
    contractVersion: resolvedContract.contract.version,
    contractDigest: resolvedContract.digest,
    videoPath,
    videoSha256,
    videoDurationSeconds,
    contactSheetPath,
    contactSheetSha256,
    reviewerHost,
    reviewerProvenance,
    generatorProvenance,
    reviewNotesPath,
    reviewNotesFileSha256,
    reviewNotesContentSha256,
    reviewNotesVersion: reviewNotes.version,
    reviewNotes,
    checks: Object.fromEntries(resolvedContract.contract.qualityReview.requiredChecks.map((key) => [key, true])),
    pass: true,
    knownRemainingIssues: [],
    reviewedAt: reviewNotes.reviewedAt,
    signedAt: new Date().toISOString(),
  };
  const outputPath = resolve(options.outputPath || join(dirname(manifestPath), "audits/koya-final/agent-visual-signoff.json"));
  await writeJsonAtomic(outputPath, signoff);
  return { outputPath, signoff };
}

export async function auditKoyaMangaFinal(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  const manifestPath = resolve(options.manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const episodeDir = dirname(manifestPath);
  const videoPath = resolve(options.videoPath || manifest.outputs?.reviewVideo?.filePath || manifest.outputs?.finalVideo?.filePath || "");
  if (!videoPath || !await pathExists(videoPath)) throw new Error(`Rendered video is missing: ${videoPath}`);
  const outputDir = resolve(options.outputDir || join(episodeDir, "audits/koya-final"));
  await mkdir(outputDir, { recursive: true });
  const resolvedContract = await resolveKoyaMangaProductionContract({ projectDir, episodeId: manifest.id });
  const steps = [];
  const commands = [];
  const record = (id, pass, detail, evidencePath = "", extra = {}) => {
    const row = { id, pass: pass === true, detail, evidencePath, ...extra };
    steps.push(row);
    return row;
  };
  const runReport = async (id, command, args, reportPath, evaluator = (report) => report?.pass === true) => {
    commands.push({ id, command, args, reportPath });
    if (options.dryRun) return record(id, false, "dry-run: not executed", reportPath, { planned: true });
    const execution = await runCommand(command, args, { cwd: projectDir });
    const report = await readJson(reportPath, null);
    const pass = execution.ok && evaluator(report);
    return record(id, pass, pass ? "passed" : (execution.stderr || "report gate failed").slice(-1200), reportPath, { execution });
  };

  const contractReportPath = join(outputDir, "contract-manifest.json");
  const manifestContractReport = auditManifestAgainstKoyaContract(manifest, resolvedContract);
  const audioDigests = await utteranceAudioDigests(manifest);
  const approvedAudio = manifest.production?.approvedAudio;
  const approvedById = new Map((approvedAudio?.utterances || []).map((row) => [row.utteranceId, row.sha256]));
  const audioFreezeFailures = approvedAudio
    ? audioDigests.filter((row) => !row.sha256 || approvedById.get(row.utteranceId) !== row.sha256)
    : [];
  const audioFreezeAudit = {
    applicable: Boolean(approvedAudio),
    baselineCreatedAt: approvedAudio?.createdAt || "",
    rows: audioDigests,
    failures: audioFreezeFailures,
    pass: audioDigests.every((row) => Boolean(row.sha256)) && audioFreezeFailures.length === 0,
  };
  const renderFreshnessFailures = await staleRenderedCuts(manifest);
  const renderFreshnessAudit = {
    failures: renderFreshnessFailures,
    pass: renderFreshnessFailures.length === 0,
  };
  const storyGovernance = manifest.production?.storyGovernance;
  const storyGovernanceApplicable = Boolean(manifest.production?.channelAuthority?.showBibleVersion);
  const currentScriptSha256 = sha256Text(manifest.scriptText || "");
  const storyReviewPath = storyGovernance?.reviewPath ? resolve(storyGovernance.reviewPath) : "";
  const storyReview = storyReviewPath ? await readJson(storyReviewPath, null) : null;
  const storyGovernanceFailures = [];
  if (storyGovernanceApplicable) {
    if (storyGovernance?.pass !== true) storyGovernanceFailures.push("story-governance-plan-not-passed");
    if (storyGovernance?.scriptSha256 !== currentScriptSha256) storyGovernanceFailures.push("story-governance-script-sha-mismatch");
    if (storyGovernance?.active === true) {
      if (!storyReview) storyGovernanceFailures.push("story-review-file-missing");
      if (storyReview?.version !== "koya-story-review-v1") storyGovernanceFailures.push("story-review-version-mismatch");
      if (storyReview?.scriptSha256 !== currentScriptSha256) storyGovernanceFailures.push("story-review-script-sha-mismatch");
      if (!storyReview?.reviewer?.contextId) storyGovernanceFailures.push("story-review-context-missing");
      if (storyReview?.reviewer?.contextId === manifest.production?.provenance?.generator?.contextId) storyGovernanceFailures.push("story-review-not-independent");
    }
  }
  const storyGovernanceAudit = {
    applicable: storyGovernanceApplicable,
    active: storyGovernance?.active === true,
    scriptSha256: currentScriptSha256,
    reviewPath: storyReviewPath,
    failures: storyGovernanceFailures,
    pass: storyGovernanceFailures.length === 0,
  };
  const contractReport = {
    ...manifestContractReport,
    audioFreezeAudit,
    renderFreshnessAudit,
    storyGovernanceAudit,
    pass: manifestContractReport.pass && audioFreezeAudit.pass && renderFreshnessAudit.pass && storyGovernanceAudit.pass,
    failures: [
      ...manifestContractReport.failures,
      ...audioFreezeFailures.map((row) => ({ id: "approved-audio-changed", detail: row })),
      ...renderFreshnessFailures.map((row) => ({ id: "render-input-stale", detail: row })),
      ...storyGovernanceFailures.map((detail) => ({ id: "story-governance", detail })),
    ],
  };
  await writeJsonAtomic(contractReportPath, contractReport);
  record("contract-manifest", contractReport.pass, contractReport.pass ? "passed" : JSON.stringify(contractReport.failures), contractReportPath);

  const editorialReportPath = join(outputDir, "editorial-quality.json");
  if (options.dryRun) {
    record("editorial-quality", false, "dry-run: not executed", editorialReportPath, { planned: true });
  } else {
    const editorialReport = auditKoyaEditorialQuality(manifest, resolvedContract.contract);
    await writeJsonAtomic(editorialReportPath, editorialReport);
    record(
      "editorial-quality",
      editorialReport.pass,
      editorialReport.pass ? "passed" : JSON.stringify(editorialReport.failures),
      editorialReportPath,
      { metrics: editorialReport.metrics },
    );
  }

  if (options.dryRun) {
    record("rendered-camera", false, "dry-run: not executed", join(outputDir, "rendered-camera/audit.json"), { planned: true });
  } else {
    try {
      const camera = await auditKoyaRenderedCamera({ projectDir, manifestPath, videoPath, outputDir: join(outputDir, "rendered-camera") });
      record("rendered-camera", camera.audit.pass, camera.audit.pass ? "passed" : JSON.stringify(camera.audit.knownRemainingIssues), camera.outputPath);
    } catch (error) {
      record("rendered-camera", false, error.message, join(outputDir, "rendered-camera/audit.json"));
    }
  }

  const midpointDir = join(outputDir, "bubble-midpoints");
  await runReport(
    "bubble-midpoint-frames", "node", [join(projectDir, "scripts/audit-manga-bubble-frames.mjs"), manifestPath, videoPath, midpointDir],
    join(midpointDir, "bubble-frame-audit.json"),
    (report) => report?.frameCount === expectedBubbleSegmentCount(manifest) && Array.isArray(report?.rows),
  );
  // Resolve the async frame-existence predicate used above with an explicit gate.
  const midpointStep = steps.find((step) => step.id === "bubble-midpoint-frames");
  if (!options.dryRun && midpointStep?.pass) {
    const report = await readJson(midpointStep.evidencePath, {});
    midpointStep.pass = (await Promise.all((report.rows || []).map((row) => pathExists(row.framePath)))).every(Boolean);
    if (!midpointStep.pass) midpointStep.detail = "one or more midpoint frames are missing";
  }

  const transitionDir = join(outputDir, "bubble-transitions");
  await runReport(
    "bubble-transition-clear-frames", "node", [join(projectDir, "scripts/audit-manga-v24-bubble-transitions.mjs"), manifestPath, videoPath, transitionDir],
    join(transitionDir, "bubble-transition-audit.json"), (report) => report?.everyTransitionHasEncodedClearFrame === true,
  );
  const sweepDir = join(outputDir, "bubble-camera-sweep");
  await runReport(
    "bubble-camera-sweep", "node", [join(projectDir, "scripts/audit-manga-bubble-camera-sweep.mjs"), manifestPath, videoPath, sweepDir],
    join(sweepDir, "bubble-camera-sweep-audit.json"), (report) => (
      Array.isArray(report?.rows)
      && ((manifest.utterances || []).every((utterance) => utterance.preset === "narration") || report.utteranceCount > 0)
    ),
  );
  await runReport(
    "independent-rendered-face", "python3",
    [join(projectDir, "scripts/audit-manga-bubble-faces-independent.py"), "--manifest", manifestPath, "--video", videoPath, "--cascade", join(projectDir, "scripts/data/lbpcascade_animeface.xml"), "--max-cover", "0", "--output", join(outputDir, "independent-rendered-face.json")],
    join(outputDir, "independent-rendered-face.json"),
  );
  await runReport(
    "bubble-typography", "python3",
    [join(projectDir, "scripts/audit-manga-bubble-typography-frames.py"), "--manifest", manifestPath, "--output", join(outputDir, "bubble-typography.json")],
    join(outputDir, "bubble-typography.json"),
  );
  if (!options.dryRun) {
    const typographyPath = join(outputDir, "bubble-typography.json");
    const typographyStep = steps.find((step) => step.id === "bubble-typography");
    const typographyReport = await readJson(typographyPath, {});
    const terminalPunctuation = await auditBubbleTerminalJapanesePeriods(manifest, resolvedContract.contract);
    const naturalSegmentation = auditBubbleNaturalSegmentation(manifest, resolvedContract.contract);
    typographyReport.terminalPunctuation = terminalPunctuation;
    typographyReport.naturalSegmentation = naturalSegmentation;
    typographyReport.pass = typographyReport.pass === true
      && terminalPunctuation.pass
      && naturalSegmentation.pass;
    await writeJsonAtomic(typographyPath, typographyReport);
    if (typographyStep) {
      typographyStep.pass = typographyReport.pass;
      if (!typographyStep.pass) typographyStep.detail = "typography, terminal punctuation, or natural segmentation gate failed";
    }
  }

  const hasThought = manifest.utterances?.some((utterance) => utterance.preset === "thought");
  if (!hasThought) record("thought-spotlight", true, "not applicable: no thought utterances", "", { applicable: false });
  else await runReport(
    "thought-spotlight", "python3",
    [join(projectDir, "scripts/audit-manga-thought-spotlight.py"), "--manifest", manifestPath, "--video", videoPath, "--output", join(outputDir, "thought-spotlight.json")],
    join(outputDir, "thought-spotlight.json"),
  );
  await runReport(
    "split-page-integrity", "python3",
    [join(projectDir, "scripts/audit-koya-split-page-integrity.py"), "--manifest", manifestPath, "--video", videoPath, "--output", join(outputDir, "split-page-integrity.json")],
    join(outputDir, "split-page-integrity.json"),
  );

  if (options.quick) record("stt-verification", false, "quick audit does not run STT", "", { skipped: true });
  else await runReport(
    "stt-verification", "python3",
    [join(projectDir, "scripts/audit-manga-stt-verification.py"), "--manifest", manifestPath, "--video", videoPath, "--output", join(outputDir, "stt-verification.json")],
    join(outputDir, "stt-verification.json"),
  );
  await runReport(
    "audio-onset", "python3",
    [join(projectDir, "scripts/audit-manga-audio-onset.py"), "--manifest", manifestPath, "--output", join(outputDir, "audio-onset.json")],
    join(outputDir, "audio-onset.json"),
  );
  await runReport(
    "audio-speaker-continuity", "python3",
    [join(projectDir, "scripts/audit-manga-speaker-continuity.py"), "--manifest", manifestPath, "--video", videoPath, "--output", join(outputDir, "audio-speaker-continuity.json")],
    join(outputDir, "audio-speaker-continuity.json"),
  );
  const waveformPath = join(outputDir, "audio-waveform.json");
  await runReport(
    "audio-waveform-sync", "python3",
    [join(projectDir, "scripts/audit-koya-audio-waveform.py"), "--manifest", manifestPath, "--video", videoPath, "--output", waveformPath],
    waveformPath, (report) => report?.gates?.everyUtteranceHasRenderedSpeech === true && report?.gates?.lineLevelSpread === true,
  );
  const waveform = await readJson(waveformPath, null);
  record(
    "audio-click-hum-level",
    options.dryRun ? false : waveform?.gates?.noClickImpulse === true && waveform?.gates?.noMainsHum === true,
    options.dryRun ? "dry-run: not executed" : "derived from rendered waveform audit",
    waveformPath,
    options.dryRun ? { planned: true } : {},
  );

  const mediaPath = join(outputDir, "media-quality.json");
  await runReport(
    "full-decode", "node",
    [join(projectDir, "scripts/audit-manga-video.mjs"), "--video-path", videoPath, "--manifest-path", manifestPath, "--output-path", mediaPath],
    mediaPath,
  );

  const contactSheetPath = join(outputDir, "contact-sheet.jpg");
  const videoDurationSeconds = await probeDurationSeconds(videoPath);
  const contactSheet = options.dryRun
    ? { pass: false, outputPath: contactSheetPath, planned: true }
    : await makeContactSheet(videoPath, contactSheetPath, videoDurationSeconds);
  const videoSha256 = await sha256File(videoPath);
  const contactSheetSha256 = contactSheet.pass ? await sha256File(contactSheetPath) : "";
  const signoffPath = resolve(options.visualSignoffPath || join(outputDir, "agent-visual-signoff.json"));
  const signoff = await readJson(signoffPath, null);
  const reviewNotesPath = signoff?.reviewNotesPath ? resolve(signoff.reviewNotesPath) : "";
  const reviewNotesSource = reviewNotesPath ? await readJson(reviewNotesPath, null) : null;
  const reviewNotesFileSha256 = reviewNotesPath && await pathExists(reviewNotesPath) ? await sha256File(reviewNotesPath) : "";
  const reviewNotesContentSha256 = reviewNotesSource ? sha256Text(stableJson(reviewNotesSource)) : "";
  const evidenceFilesGate = reviewNotesSource
    ? await verifyKoyaPerceptualEvidenceFiles(reviewNotesSource)
    : { pass: false, failures: ["review-notes-source-missing"], fileCount: 0 };
  const signoffGate = validateKoyaVisualSignoff(signoff, {
    episodeId: manifest.id,
    videoPath,
    videoSha256,
    videoDurationSeconds,
    contactSheetPath,
    contactSheetSha256,
    reviewNotesFileSha256,
    reviewNotesContentSha256,
    evidenceFilesGate,
    contractDigest: resolvedContract.digest,
    contract: resolvedContract.contract,
    generatorProvenance: manifest.production?.provenance?.generator,
  });
  record(
    "agent-contact-sheet-review",
    contactSheet.pass && signoffGate.pass,
    contactSheet.pass && signoffGate.pass ? "passed" : `contact sheet/signoff incomplete: ${signoffGate.failures.join(", ")}`,
    signoffPath,
    { contactSheetPath, contactSheetSha256, contactSheetPass: contactSheet.pass, evidenceFilesGate, signoffGate },
  );

  const qualityHarnessDir = join(outputDir, "quality-harness");
  const qualityDecisionPath = join(qualityHarnessDir, "final-decision.json");
  const qualityLoopStatePath = join(qualityHarnessDir, "quality-loop-state.json");
  const evidenceManifestPath = join(qualityHarnessDir, "evidence-manifest.json");
  const incidentSeedPath = join(projectDir, "config/koya-manga-quality-incidents.json");
  const incidentLedgerPath = join(projectDir, "canvas/manga-quality-harness/incident-ledger.json");
  let qualityDecision = null;
  if (options.dryRun) {
    record("quality-harness-final", false, "dry-run: not executed", qualityDecisionPath, { planned: true });
  } else {
    await mkdir(qualityHarnessDir, { recursive: true });
    const auditSteps = await Promise.all(steps.map(async (step) => {
      const evidencePath = step.evidencePath ? resolve(step.evidencePath) : "";
      const evidenceSha256 = evidencePath && await pathExists(evidencePath) ? await sha256File(evidencePath) : "";
      return {
        id: step.id,
        pass: step.pass === true,
        applicable: step.applicable !== false,
        evidencePath,
        evidenceSha256,
      };
    }));
    const evidenceManifest = await createMangaEvidenceManifest({
      episodeId: manifest.id,
      projectDir,
      // A prior review may legitimately mention the previous evidence manifest.
      // Never admit the manifest currently being replaced into its own Merkle tree.
      excludePaths: [evidenceManifestPath],
      artifacts: [
        videoPath, contactSheetPath, signoffPath, reviewNotesPath,
        manifest.production?.sourceFacePlacement?.path,
        ...auditSteps.map((step) => step.evidencePath),
        join(projectDir, "config/koya-manga-production-contract.json"),
        join(projectDir, "config/koya-manga-production-contract.schema.json"),
        join(projectDir, "config/koya-manga-quality-incidents.json"),
        join(projectDir, "lib/koyaMangaFinalAudit.mjs"),
        join(projectDir, "lib/mangaQualityHarness.mjs"),
        join(projectDir, "lib/mangaQualityEvidence.mjs"),
      ].filter(Boolean),
    });
    await writeJsonAtomic(evidenceManifestPath, evidenceManifest);
    const evidenceManifestGate = await verifyMangaEvidenceManifest(evidenceManifest);
    if (!evidenceManifestGate.pass) throw new Error(`Evidence manifest verification failed: ${evidenceManifestGate.failures.join(", ")}`);
    const evidenceManifestSha256 = await sha256EvidenceFile(evidenceManifestPath);
    const qualityContract = createMangaQualityContract({ manifest });
    const generatorProvenance = manifest.production?.provenance?.generator;
    let qualityLoopState = await readJson(qualityLoopStatePath, null);
    if (!qualityLoopState || qualityLoopState.contractDigest !== qualityContract.digest) {
      qualityLoopState = createMangaQualityLoopState({
        episodeId: manifest.id,
        contract: qualityContract,
        generatorHost: generatorProvenance?.host,
        generatorId: generatorProvenance?.id,
        generatorContextId: generatorProvenance?.contextId,
        generatorProvenance,
        startedAt: generatorProvenance?.capturedAt || new Date().toISOString(),
      });
    }
    if (qualityLoopState.status === "passed" && qualityLoopState.rounds?.at(-1)?.evidenceMerkleRoot !== evidenceManifest.merkleRoot) {
      qualityLoopState = createMangaQualityLoopState({
        episodeId: manifest.id,
        contract: qualityContract,
        generatorHost: generatorProvenance?.host,
        generatorId: generatorProvenance?.id,
        generatorContextId: generatorProvenance?.contextId,
        generatorProvenance,
        startedAt: generatorProvenance?.capturedAt || signoff?.reviewedAt || new Date().toISOString(),
      });
    }
    if (signoffGate.pass && qualityLoopState.status === "active") {
      const failedGateIds = auditSteps
        .filter((step) => step.id !== "quality-harness-final" && step.pass !== true)
        .map((step) => step.id);
      const roundEvidence = [
        { path: signoffPath, sha256: await sha256EvidenceFile(signoffPath), note: "独立評価者による署名済み全尺レビュー" },
        { path: evidenceManifestPath, sha256: evidenceManifestSha256, note: "全監査証拠のMerkleマニフェスト" },
      ];
      qualityLoopState = await recordVerifiedMangaQualityRound({
        contract: qualityContract,
        state: qualityLoopState,
        hardGateReport: { pass: failedGateIds.length === 0, failedGateIds, contractDigest: qualityContract.digest },
        reviews: [{
          evaluatorHost: signoff.reviewerProvenance.host,
          evaluatorId: signoff.reviewerProvenance.id,
          evaluatorContextId: signoff.reviewerProvenance.contextId,
          scores: reviewNotesSource.rubricScores,
          notes: reviewNotesSource.summary || reviewNotesSource.evidence?.fullVideoReviewed?.note,
          evidence: roundEvidence,
        }],
        evidence: roundEvidence,
        reviewDigest: signoff.reviewNotesContentSha256,
        evidenceMerkleRoot: evidenceManifest.merkleRoot,
        failureFingerprint: failedGateIds.length > 0 ? sha256Text(failedGateIds.sort().join("\n")) : "",
        observedAt: signoff.reviewedAt,
      });
      await writeJsonAtomic(qualityLoopStatePath, qualityLoopState);
    } else if (!await pathExists(qualityLoopStatePath)) {
      await writeJsonAtomic(qualityLoopStatePath, qualityLoopState);
    }
    // incident-ledger.json はエピソードごとではなくチャンネル全体で1つ。
    // read→merge→write をロックの外でやると、別エピソードの監査を同時に
    // 走らせたとき後勝ちになり、片方の品質事故が台帳から消える。
    // 読み直しはロックの内側で行う（外で読んだ内容は既に古い可能性がある）。
    await withCanvasFileLock(incidentLedgerPath, async () => {
      let incidentLedger = mergeMangaQualityIncidentLedgers(
        await readJson(incidentSeedPath, { incidents: [] }),
        await readJson(incidentLedgerPath, { incidents: [] }),
      );
      for (const step of auditSteps.filter((entry) => (
        entry.pass !== true
        && entry.id !== "agent-contact-sheet-review"
        && entry.id !== "quality-harness-final"
      ))) {
        incidentLedger = recordMangaQualityIncident({
          ledger: incidentLedger,
          incident: {
            signature: `${manifest.id}:${step.id}`,
            scope: manifest.id,
            rule: step.id,
            failure: steps.find((entry) => entry.id === step.id)?.detail || "audit failed",
            severity: "high",
            deterministic: true,
            evidence: step.evidencePath ? [step.evidencePath] : [],
          },
        });
      }
      await writeJsonAtomic(incidentLedgerPath, incidentLedger);
    });
    qualityDecision = createMangaFinalQualityDecision({
      episodeId: manifest.id,
      contractDigest: resolvedContract.digest,
      videoSha256,
      requiredAuditIds: resolvedContract.contract.requiredAudits,
      auditSteps,
      qualityLoopState,
      evidenceManifestPath,
      evidenceManifestSha256,
      evidenceMerkleRoot: evidenceManifest.merkleRoot,
    });
    await writeJsonAtomic(qualityDecisionPath, qualityDecision);
    record(
      "quality-harness-final",
      qualityDecision.pass,
      qualityDecision.pass ? "passed" : `${qualityDecision.status}: ${qualityDecision.stopReason}`,
      qualityDecisionPath,
      { qualityDecision },
    );
  }

  const evaluation = evaluateKoyaFinalAuditSteps(resolvedContract.contract, steps);
  const reportPath = join(outputDir, "final-audit.json");
  const report = {
    version: "koya-final-audit-v1",
    episodeId: manifest.id,
    contractVersion: resolvedContract.contract.version,
    contractDigest: resolvedContract.digest,
    manifestPath,
    videoPath,
    videoSha256,
    videoDurationSeconds,
    steps,
    commands,
    ...evaluation,
    generatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(reportPath, report);

  const statePath = join(episodeDir, "koya-production-state.json");
  const previousState = await readJson(statePath, {});
  if (report.pass && !options.dryRun) {
    const videoStats = await stat(videoPath);
    manifest.status = resolvedContract.contract.lifecycle.completionStatus;
    manifest.knownRemainingIssues = [];
    manifest.outputs = {
      ...(manifest.outputs || {}),
      finalVideo: {
        ...(manifest.outputs?.reviewVideo || {}),
        fileName: basename(videoPath),
        filePath: videoPath,
        sizeBytes: videoStats.size,
        sha256: videoSha256,
        auditReportPath: reportPath,
        auditedAt: new Date().toISOString(),
      },
    };
    manifest.production = { ...(manifest.production || {}), finalKoyaAudit: { path: reportPath, pass: true, digest: videoSha256 } };
    manifest.production.approvedAudio = approvedAudio || {
      version: "koya-approved-audio-hashes-v1",
      utterances: audioDigests,
      createdAt: new Date().toISOString(),
    };
    await writeJsonAtomic(manifestPath, manifest);
  }
  if (!options.dryRun) {
    await writeJsonAtomic(statePath, {
      ...previousState,
      version: "koya-production-state-v1",
      episodeId: manifest.id,
      status: report.pass ? resolvedContract.contract.lifecycle.completionStatus
        : qualityDecision?.status === "needs-human-approval"
          ? "awaiting-agent-visual-review" : "audit-failed",
      currentStage: report.pass ? "complete" : "audit",
      finalAuditPath: reportPath,
      knownRemainingIssues: evaluation.knownRemainingIssues,
      updatedAt: new Date().toISOString(),
    });
  }
  return { reportPath, report, contactSheetPath, signoffPath };
}
