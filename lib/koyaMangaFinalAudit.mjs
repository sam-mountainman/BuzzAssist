import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { writeJsonAtomic } from "./canvasScene.mjs";
import { auditKoyaRenderedCamera } from "./koyaRenderedCameraAudit.mjs";
import {
  auditManifestAgainstKoyaContract,
  resolveKoyaMangaProductionContract,
} from "./koyaMangaProductionContract.mjs";
import { renderCutInputHash } from "./mangaVideoPipeline.mjs";

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

function expectedBubbleSegmentCount(manifest) {
  return (manifest.utterances || []).reduce((count, utterance) => (
    count + Math.max(1, utterance.bubbleSegments?.length || 0)
  ), 0);
}

function nonEmptyReviewNote(value) {
  return typeof value === "string" && value.trim().length >= 4;
}

export function validateKoyaPerceptualReviewNotes(notes, contract) {
  const failures = [];
  const evidence = notes?.evidence || {};
  const checks = notes?.checks || {};
  const requiredEvidence = [
    "fullVideoReviewed",
    "contactSheetReviewed",
    "representativeFramesReviewed",
    "audioSpotChecksReviewed",
  ];
  if (notes?.version !== "koya-perceptual-review-notes-v1") failures.push("review-notes-version-mismatch");
  for (const key of requiredEvidence) {
    if (!nonEmptyReviewNote(evidence[key])) failures.push(`missing-evidence-note:${key}`);
  }
  for (const key of contract?.qualityReview?.requiredChecks || []) {
    if (!nonEmptyReviewNote(checks[key])) failures.push(`missing-check-note:${key}`);
  }
  if (!Array.isArray(notes?.knownRemainingIssues)) failures.push("known-issues-missing");
  else if (notes.knownRemainingIssues.length > 0) failures.push("review-known-issues-not-empty");
  return {
    pass: failures.length === 0,
    failures,
    requiredEvidence,
    requiredChecks: contract?.qualityReview?.requiredChecks || [],
  };
}

export function validateKoyaVisualSignoff(signoff, { episodeId, videoSha256, contactSheetPath, contract }) {
  const checks = signoff?.checks || {};
  const required = contract?.qualityReview?.requiredChecks || [];
  const failures = [];
  if (signoff?.version !== contract?.qualityReview?.version) failures.push("signoff-version-mismatch");
  if (signoff?.episodeId !== episodeId) failures.push("episode-id-mismatch");
  if (signoff?.videoSha256 !== videoSha256) failures.push("video-digest-mismatch");
  if (resolve(signoff?.contactSheetPath || "") !== resolve(contactSheetPath)) failures.push("contact-sheet-path-mismatch");
  if (!["claude", "codex"].includes(signoff?.reviewerHost)) failures.push("reviewer-host-missing");
  if (signoff?.pass !== true) failures.push("review-not-passed");
  for (const key of required) if (checks[key] !== true) failures.push(`unchecked:${key}`);
  const reviewNotesGate = validateKoyaPerceptualReviewNotes({
    version: signoff?.reviewNotesVersion,
    evidence: signoff?.reviewEvidence,
    checks: signoff?.reviewNotes,
    knownRemainingIssues: signoff?.knownRemainingIssues,
  }, contract);
  failures.push(...reviewNotesGate.failures);
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
  const reviewNotesGate = validateKoyaPerceptualReviewNotes(reviewNotes, resolvedContract.contract);
  if (!reviewNotesGate.pass) {
    throw new Error(`Perceptual review notes are incomplete: ${reviewNotesGate.failures.join(", ")}`);
  }
  if (options.pass !== true) throw new Error("A passing signoff requires pass=true after the documented review.");
  const signoff = {
    version: resolvedContract.contract.qualityReview.version,
    episodeId: manifest.id,
    videoPath,
    videoSha256: await sha256File(videoPath),
    contactSheetPath,
    reviewerHost,
    reviewNotesPath,
    reviewNotesVersion: reviewNotes.version,
    reviewEvidence: reviewNotes.evidence,
    reviewNotes: reviewNotes.checks,
    checks: Object.fromEntries(resolvedContract.contract.qualityReview.requiredChecks.map((key) => [key, true])),
    pass: true,
    knownRemainingIssues: [],
    reviewedAt: new Date().toISOString(),
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
  const contractReport = {
    ...manifestContractReport,
    audioFreezeAudit,
    renderFreshnessAudit,
    pass: manifestContractReport.pass && audioFreezeAudit.pass && renderFreshnessAudit.pass,
    failures: [
      ...manifestContractReport.failures,
      ...audioFreezeFailures.map((row) => ({ id: "approved-audio-changed", detail: row })),
      ...renderFreshnessFailures.map((row) => ({ id: "render-input-stale", detail: row })),
    ],
  };
  await writeJsonAtomic(contractReportPath, contractReport);
  record("contract-manifest", contractReport.pass, contractReport.pass ? "passed" : JSON.stringify(contractReport.failures), contractReportPath);

  await runReport(
    "quality-harness-final", "node",
    [join(projectDir, "scripts/audit-manga-quality-harness.mjs"), "--manifest-path", manifestPath, "--stage", "final", "--output-dir", join(outputDir, "quality-harness")],
    join(outputDir, "quality-harness/preflight-final.json"),
  );

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
  const contactSheet = options.dryRun
    ? { pass: false, outputPath: contactSheetPath, planned: true }
    : await makeContactSheet(videoPath, contactSheetPath, manifest.metrics?.videoDurationSeconds);
  const videoSha256 = await sha256File(videoPath);
  const signoffPath = resolve(options.visualSignoffPath || join(outputDir, "agent-visual-signoff.json"));
  const signoff = await readJson(signoffPath, null);
  const signoffGate = validateKoyaVisualSignoff(signoff, {
    episodeId: manifest.id,
    videoSha256,
    contactSheetPath,
    contract: resolvedContract.contract,
  });
  record(
    "agent-contact-sheet-review",
    contactSheet.pass && signoffGate.pass,
    contactSheet.pass && signoffGate.pass ? "passed" : `contact sheet/signoff incomplete: ${signoffGate.failures.join(", ")}`,
    signoffPath,
    { contactSheetPath, contactSheetPass: contactSheet.pass, signoffGate },
  );

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
        : evaluation.failedAuditIds.length === 1 && evaluation.failedAuditIds[0] === "agent-contact-sheet-review"
          ? "awaiting-agent-visual-review" : "audit-failed",
      currentStage: report.pass ? "complete" : "audit",
      finalAuditPath: reportPath,
      knownRemainingIssues: evaluation.knownRemainingIssues,
      updatedAt: new Date().toISOString(),
    });
  }
  return { reportPath, report, contactSheetPath, signoffPath };
}
