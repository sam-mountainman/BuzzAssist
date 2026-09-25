// Genre adapterの実測監査とMedia Jobを、共通RunReceiptへ閉じる。
// completedという自己申告ではなく、SHA拘束した監査report内の各checkを宣言へ対応付ける。

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  contractVersionPredates,
  declarationContractVersionFloor,
  declaredAuditIdsInForce,
  finalizeRunReceipt,
  openRunReceipt,
  recordApproval,
  recordGatesFromAuditChecks,
  recordGatesFromAuditSteps,
  recordImageRetry,
  recordPaidMediaJob,
  recordResumeFromFailed,
  recordRunArtifact,
  writeRunReceipt,
} from "./harnessRunReceipt.mjs";
import { resolveFfmpegToolchain } from "./harnessRuntimeResolver.mjs";
import { resolveKoyaMangaProductionContract, stableJson } from "./koyaMangaProductionContract.mjs";
import { assertKoyaOuterJobBinding } from "./koyaOuterJobBinding.mjs";
import {
  createKoyaReviewAttestationSubject,
  declaredReviewAttestationSubject,
  expectedSubjectFailureCodes,
  loadReviewerTrust,
  verifyNarratedReviewSignoff,
  verifyReviewAttestation,
} from "./koyaReviewAttestation.mjs";
import { assertVideoHarnessExecutionIdentity } from "./videoHarnessExecutionIdentity.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_HARNESS_DECLARATIONS_DIR = join(REPO_ROOT, "config", "harnesses");
const SHA256 = /^(?:sha256:)?([a-f0-9]{64})$/iu;
const FINAL_VIDEO = /(?:^|[-_. ])final(?:[-_. ]|$).*(?:video|mp4)|(?:video|mp4).*(?:^|[-_. ])final(?:[-_. ]|$)|^(?:video|mp4)$/iu;
const CONTACT_SHEET = /contact[-_. ]?sheet/iu;
const AUDIO = /audio|voice|narration|speech|tts|\.(?:wav|mp3|m4a|aac)(?:\s|$)/iu;
const SUBTITLE = /subtitle|caption|srt|vtt/iu;
const BGM = /(?:^|[-_. ])bgm(?:[-_. ]|$)/iu;
const SIGNOFF_AUDIT = /signoff|contact[-_. ]?sheet.*review|agent-contact-sheet-review/iu;
const NARRATED_STORY_AUDIT_VERSION = "buzzassist-narrated-story-audit-v1";
// v2: 評価項目の点数（qualityReview）を載せた signoff。品質ループの回はこの版からしか作られない。
const NARRATED_STORY_SIGNOFF_VERSION = "buzzassist-narrated-story-contact-sheet-signoff-v2";
// 承認した signoff に結合されていなければならない監査。qualityLoopPassed は、合格した回の
// signoff が今の承認と同じファイル（同じ SHA）であることを示す（別の回の合格を転用させない）。
// characterIdentityReviewed（監査契約 v4）は、人物の同一性の採点がその承認された signoff のものであること。
const NARRATED_STORY_SIGNOFF_AUDIT_IDS = Object.freeze([
  "perceptualReviewChecks",
  "perceptualReviewBoundToOutput",
  "perceptualEvidenceHashes",
  "contactSheetOriginalDetailReviewed",
  "qualityLoopPassed",
  "characterIdentityReviewed",
]);
const execFile = promisify(execFileCallback);
const MEDIA_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const MEDIA_COMMAND_MAX_BUFFER = 4 * 1024 * 1024;

function normalizedSha(value, label) {
  const match = String(value || "").trim().match(SHA256);
  if (!match) throw new Error(`${label}はSHA-256であること。`);
  return match[1].toLowerCase();
}

async function sha256File(path) {
  const target = resolve(path);
  const before = await stat(target);
  if (!before.isFile()) throw new Error("成果物が通常fileではない。");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  const after = await stat(target);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("SHA計算中に成果物が変更された。");
  }
  return { path: target, sha256: hash.digest("hex"), bytes: after.size };
}

async function verifiedArtifact(artifact, label = "成果物") {
  if (!artifact?.path) throw new Error(`${label}にpathが無い。`);
  const verified = await sha256File(artifact.path);
  const declaredSha256 = normalizedSha(artifact.sha256, `${label}.sha256`);
  if (declaredSha256 !== verified.sha256) {
    throw new Error(`${label}のSHA-256が実fileと一致しない。`);
  }
  if (artifact.bytes !== null && artifact.bytes !== undefined && Number(artifact.bytes) !== verified.bytes) {
    throw new Error(`${label}.bytesが実file sizeと一致しない。`);
  }
  return { ...artifact, path: verified.path, sha256: verified.sha256, bytes: verified.bytes };
}

/**
 * A checked audit JSON is not evidence that the referenced MP4 still decodes.
 * Re-open the exact final artifact at common finalization time, require real
 * audio/video streams, decode the complete file with -xerror, then re-hash it.
 * This is deliberately independent from the genre adapter's own audit so a
 * stale or fabricated report cannot promote broken bytes to completed.
 */
export async function validateFinalVideoMedia(artifact, {
  env = process.env,
  runCommand = execFile,
  resolveToolchain = resolveFfmpegToolchain,
} = {}) {
  const path = resolve(String(artifact?.path || ""));
  if (!artifact?.path) throw new Error("final-videoにpathが無い。");
  const before = await stat(path);
  if (!before.isFile() || before.size <= 0) throw new Error("final-videoが空または通常fileではない。");
  const toolchain = await resolveToolchain({ env, runCommand });
  if (!toolchain?.ok || !toolchain.ffmpeg?.command || !toolchain.ffprobe?.command) {
    throw new Error(`final-video実デコード用ffmpeg/ffprobeを解決できない: ${toolchain?.ffmpeg?.detail || toolchain?.ffprobe?.detail || "unavailable"}`);
  }
  const commandOptions = {
    env,
    timeout: MEDIA_COMMAND_TIMEOUT_MS,
    maxBuffer: MEDIA_COMMAND_MAX_BUFFER,
    windowsHide: true,
  };
  let probe;
  try {
    const { stdout = "" } = await runCommand(
      toolchain.ffprobe.command,
      [
        ...(toolchain.ffprobe.args || []),
        "-v", "error",
        "-show_entries", "format=duration:stream=codec_type",
        "-of", "json",
        path,
      ],
      commandOptions,
    );
    probe = JSON.parse(String(stdout));
  } catch (error) {
    throw new Error(`final-videoをffprobeで検証できない: ${String(error?.stderr || error?.message || error).slice(-1200)}`);
  }
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const durationSeconds = Number(probe?.format?.duration);
  if (!(durationSeconds > 0)
    || !streams.some((stream) => stream?.codec_type === "video")
    || !streams.some((stream) => stream?.codec_type === "audio")) {
    throw new Error("final-videoは正の長さを持つ映像stream＋音声streamのMP4であること。");
  }
  try {
    await runCommand(
      toolchain.ffmpeg.command,
      [
        ...(toolchain.ffmpeg.args || []),
        "-v", "error", "-xerror", "-i", path,
        "-map", "0:v:0", "-map", "0:a:0",
        "-f", "null", "-",
      ],
      commandOptions,
    );
  } catch (error) {
    throw new Error(`final-videoの全映像・音声デコードに失敗: ${String(error?.stderr || error?.message || error).slice(-1200)}`);
  }
  const rebound = await sha256File(path);
  if (rebound.sha256 !== normalizedSha(artifact.sha256, "final-video.sha256")
    || rebound.bytes !== Number(artifact.bytes)
    || before.size !== rebound.bytes
    || before.mtimeMs !== (await stat(path)).mtimeMs) {
    throw new Error("final-videoがSHA検証・全デコード中に変更された。");
  }
  return {
    pass: true,
    path,
    sha256: rebound.sha256,
    bytes: rebound.bytes,
    durationSeconds,
    streamTypes: streams.map((stream) => String(stream?.codec_type || "")).filter(Boolean),
    ffmpegVersion: toolchain.ffmpeg.version || "",
    ffprobeVersion: toolchain.ffprobe.version || "",
  };
}

async function readVerifiedAuditReport(artifact) {
  if (!artifact?.path) throw new Error("audit-report成果物にpathが無い。");
  const path = resolve(artifact.path);
  const before = await stat(path);
  if (!before.isFile()) throw new Error("audit-report成果物が通常fileではない。");
  const bytes = await readFile(path);
  const after = await stat(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
    throw new Error("読取り中にaudit-report成果物が変更された。");
  }
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (normalizedSha(artifact.sha256, "audit-report成果物.sha256") !== actualSha256) {
    throw new Error("audit-report成果物のSHA-256が実fileと一致しない。");
  }
  if (artifact.bytes !== null && artifact.bytes !== undefined && Number(artifact.bytes) !== bytes.length) {
    throw new Error("audit-report成果物.bytesが実file sizeと一致しない。");
  }
  const verified = { ...artifact, path, sha256: actualSha256, bytes: bytes.length };
  let report;
  try {
    report = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`audit-reportをJSONとして読めない: ${String(error?.message || error)}`);
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("audit-reportはobjectであること。");
  }
  return { report, artifact: verified };
}

function auditEvidence(report) {
  if (Array.isArray(report?.steps)) return { kind: "steps", value: report.steps };
  if (report?.checks && typeof report.checks === "object" && !Array.isArray(report.checks)) {
    return { kind: "checks", value: report.checks };
  }
  if (report?.auditChecks && typeof report.auditChecks === "object" && !Array.isArray(report.auditChecks)) {
    return { kind: "checks", value: report.auditChecks };
  }
  throw new Error("SHA検証済みaudit-reportに実測auditSteps/auditChecksが無い。走っていないgateをpassにしない。");
}

function auditPassMap(evidence) {
  if (!evidence) return null;
  if (Array.isArray(evidence)) {
    return new Map(evidence.map((entry) => [String(entry?.id || ""), entry?.pass === true]));
  }
  if (typeof evidence === "object") {
    return new Map(Object.entries(evidence).map(([id, value]) => [
      id,
      typeof value === "boolean" ? value : value?.pass === true,
    ]));
  }
  return null;
}

function assertOutcomeAuditConsistent(outcome, observed) {
  const reported = outcome?.auditSteps
    || outcome?.result?.auditSteps
    || outcome?.auditChecks
    || outcome?.result?.auditChecks;
  if (!reported) return;
  const reportMap = auditPassMap(observed.value);
  const outcomeMap = auditPassMap(reported);
  if (!outcomeMap || outcomeMap.size !== reportMap.size
    || [...outcomeMap].some(([id, pass]) => !reportMap.has(id) || reportMap.get(id) !== pass)) {
    throw new Error("adapter outcomeの監査結果がSHA検証済みaudit-reportと一致しない。");
  }
}

function declaredAuditIds(declaration) {
  const ids = (declaration?.guarantees || []).flatMap((guarantee) => guarantee?.evidenceAuditIds || []);
  if (ids.length === 0 || ids.some((id) => typeof id !== "string" || !id.trim())) {
    throw new Error("Harness宣言に必須監査evidenceAuditIdsが無い。");
  }
  if (new Set(ids).size !== ids.length) throw new Error("Harness宣言のevidenceAuditIdsが重複している。");
  return ids;
}

function assertReportAuditRoster(report, auditContract) {
  if (report.requiredAuditIds === undefined) return;
  if (!Array.isArray(report.requiredAuditIds)) throw new Error("audit-report.requiredAuditIdsはarrayであること。");
  const requiredAuditIds = auditContract.requiredAuditIds;
  const reported = report.requiredAuditIds.map(String);
  const required = new Set(requiredAuditIds);
  const actual = new Set(reported);
  const missing = requiredAuditIds.filter((id) => !actual.has(id));
  const unexpected = reported.filter((id) => !required.has(id));
  if (actual.size !== reported.length || missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `audit-reportの必須監査集合がHarness宣言と一致しない（効力のある契約 ${auditContract.contractVersion || "(版不明)"} の必須監査）。`
      + `不足: ${missing.join(", ") || "なし"} / 余分・重複: ${unexpected.join(", ") || (actual.size !== reported.length ? "重複あり" : "なし")}`,
    );
  }
}

/**
 * この Job に効いている契約の版と、その版の必須監査。宣言された監査を版に関係なく全部必須にすると、
 * 監査契約を上げたあと、上げる前の版で確定を待っている Job がジャンルの側では確定できても、この共通の
 * Receipt で当時無かった監査の「未実施」で落ちる（ナレーション物語の v3→v4・v4→v5、漫画の v53→v54 で起きた）。
 *
 *   - 制作契約を Job に固定したハーネス（漫画）: doctor の前に固定し、確定の直前に実ファイルから読み直した
 *     契約の版と requiredAudits。audit-report の自己申告は使わない（report はこの一覧と一致しなければ落ちる）
 *   - それ以外（ナレーション物語）: audit-report が名乗った版（ジャンルが SHA で拘束した production の状態から
 *     決めたもの）を、宣言の保証の inForceSince で測る。ただし Job がこの宣言で計画された（canonicalIdentity の
 *     宣言の SHA が今の宣言と同じ）なら、宣言が書かれた版（inForceSince の最新）より古い版は名乗れず、宣言の版で
 *     測る——計画の時点で約束した保証を、report の自己申告で外させない。計画時の宣言の記録が無い Job も同じ
 *     （欠落を免除にしない）
 *
 * 効力の外の監査は recordGatesFromAuditSteps が保証の inForceSince と突き合わせて not-in-force（skip）にする。
 * 今の版の Job で必須の監査が欠ければ従来どおり落ちる。
 */
function effectiveAuditContract({ declaration, declarationSha256, report, job, pinnedContract = null }) {
  const reportedContractVersion = String(report?.contractVersion || "").trim();
  if (pinnedContract) {
    return {
      source: "resolved-production-contract",
      contractVersion: pinnedContract.contractVersion,
      reportedContractVersion,
      requiredAuditIds: [...pinnedContract.requiredAudits],
    };
  }
  const reported = reportedContractVersion || String(declaration?.version || "");
  const floor = declarationContractVersionFloor(declaration);
  const plannedDeclarationSha256 = String(job?.canonicalIdentity?.harnessDeclaration?.sha256 || "").trim().toLowerCase();
  const plannedUnderThisDeclaration = !plannedDeclarationSha256 || plannedDeclarationSha256 === declarationSha256;
  const raised = Boolean(floor) && plannedUnderThisDeclaration && contractVersionPredates(reported, floor);
  const contractVersion = raised ? floor : reported;
  const inForce = declaredAuditIdsInForce(declaration, contractVersion);
  return {
    source: raised ? "declaration-floor" : "declaration-in-force-since",
    contractVersion,
    reportedContractVersion,
    requiredAuditIds: inForce.requiredAuditIds,
  };
}

function mediaJobs(outcome) {
  if (Array.isArray(outcome?.mediaJobs)) return outcome.mediaJobs;
  if (Array.isArray(outcome?.result?.mediaJobs)) return outcome.result.mediaJobs;
  return [];
}

function artifactText(artifact) {
  return `${artifact?.kind || ""} ${basename(String(artifact?.path || ""))}`;
}

function completionRequirements(declaration) {
  const producesKind = String(declaration?.produces?.kind || "");
  const requiredArtifacts = [
    { id: "audit-report", matches: (artifact) => String(artifact?.kind || "") === "audit-report" },
  ];
  const isVideo = /video/iu.test(producesKind);
  if (isVideo) {
    requiredArtifacts.push(
      { id: "final-video", matches: (artifact) => FINAL_VIDEO.test(artifactText(artifact)) },
      { id: "contact-sheet", matches: (artifact) => CONTACT_SHEET.test(artifactText(artifact)) },
    );
  }
  if (producesKind === "narrated-story-video") {
    requiredArtifacts.push(
      { id: "audio", matches: (artifact) => AUDIO.test(artifactText(artifact)) && !BGM.test(artifactText(artifact)) },
      { id: "subtitle", matches: (artifact) => SUBTITLE.test(artifactText(artifact)) },
      { id: "bgm", matches: (artifact) => BGM.test(artifactText(artifact)) },
    );
  }
  return {
    requiredArtifacts,
    minimumMediaJobs: ["koya-manga-video", "narrated-story-video"].includes(declaration?.id) ? 1 : 0,
    signoffRequired: isVideo,
    finalVideoDecodeRequired: isVideo,
  };
}

function assertArtifactRoster(artifacts, requirements) {
  const missing = requirements.requiredArtifacts
    .filter((requirement) => !artifacts.some(requirement.matches))
    .map((requirement) => requirement.id);
  if (missing.length > 0) throw new Error(`completed成果物rosterが不足: ${missing.join(", ")}`);
}

function assertMediaJobRoster(rows, requirements) {
  if (rows.length < requirements.minimumMediaJobs) {
    throw new Error(`completed Media Job rosterが不足: 最低${requirements.minimumMediaJobs}件必要。`);
  }
  rows.forEach((row, index) => {
    if (row?.status !== "completed") throw new Error(`mediaJobs[${index}]がcompletedではない。`);
    normalizedSha(row?.inputHash, `mediaJobs[${index}].inputHash`);
    normalizedSha(row?.artifact?.sha256, `mediaJobs[${index}].artifact.sha256`);
    if (!String(row?.provider || "").trim() || !String(row?.kind || "").trim()) {
      throw new Error(`mediaJobs[${index}]にprovider/kindが無い。`);
    }
  });
}

function signoffCandidates(report, { attestationSubject = "" } = {}) {
  if (attestationSubject === "narrated-story-video") {
    const signoff = report?.independentSignoff;
    if (!signoff || typeof signoff !== "object" || Array.isArray(signoff)) return [];
    return [{
      type: "independent-agent",
      scope: "final-contact-sheet",
      status: report?.status === "pass" ? "approved" : "rejected",
      evidencePath: signoff.path,
      evidenceSha256: signoff.sha256,
      reviewer: signoff.reviewer,
      reviewerContextId: signoff.reviewerContextId,
      evidenceContract: NARRATED_STORY_SIGNOFF_VERSION,
    }];
  }
  const explicit = Array.isArray(report?.signoffs)
    ? report.signoffs
    : (Array.isArray(report?.approvals) ? report.approvals : []);
  if (explicit.length > 0) return explicit;
  return (Array.isArray(report?.steps) ? report.steps : [])
    .filter((step) => SIGNOFF_AUDIT.test(String(step?.id || "")))
    .map((step) => ({
      ...step,
      type: "independent-agent",
      scope: String(step.id),
      status: step.pass === true ? "approved" : "rejected",
    }));
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function singleArtifact(artifacts, matcher, label) {
  const matches = artifacts.filter(matcher);
  if (matches.length !== 1) {
    throw new Error(`signoffの${label}結合先はちょうど1件であること。`);
  }
  return matches[0];
}

function sameResolvedPath(left, right) {
  if (!firstText(left) || !firstText(right)) return false;
  return resolve(left) === resolve(right);
}

async function assertCurrentKoyaResolvedContract(job) {
  const expected = job?.resolvedProductionContract;
  if (!expected || expected.version !== "buzzassist-resolved-production-contract-v1"
    || expected.harnessId !== "koya-manga-video") {
    throw new Error("Koya Jobにdoctor前に固定した解決済み制作契約が無い。");
  }
  const actual = await resolveKoyaMangaProductionContract({
    projectDir: resolve(job.executionProjectDir || job.projectDir),
    episodeId: firstText(job?.options?.episodeId) || undefined,
    contractPath: firstText(job?.options?.contractPath) || undefined,
    overridePath: firstText(job?.options?.overridePath) || undefined,
  });
  const contractFile = await sha256File(actual.contractPath);
  const overridePath = firstText(actual.episodeOverridePath);
  const overrideFile = overridePath ? await sha256File(overridePath) : null;
  const current = {
    version: "buzzassist-resolved-production-contract-v1",
    harnessId: "koya-manga-video",
    episodeId: firstText(job?.options?.episodeId),
    contractVersion: actual.contract.version,
    contractDigest: actual.digest,
    contractPath: resolve(actual.contractPath),
    contractFileSha256: contractFile.sha256,
    contractSource: firstText(actual.contractSource),
    episodeOverridePath: overridePath ? resolve(overridePath) : "",
    episodeOverrideFileSha256: overrideFile?.sha256 || "",
  };
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error("Koyaの解決済み制作契約がdoctor後に変わった、または別契約を指している。");
  }
  // 効力のある契約の必須監査は、いま読み直して固定値と一致した契約そのものから取る（report の申告ではなく）。
  const requiredAudits = actual.contract.requiredAudits;
  if (!Array.isArray(requiredAudits) || requiredAudits.length === 0 || requiredAudits.some((id) => typeof id !== "string" || !id.trim())) {
    throw new Error("Koyaの解決済み制作契約に必須監査requiredAuditsが無い。");
  }
  return { ...current, requiredAudits: [...requiredAudits] };
}

function validateKoyaSignoffBinding({
  report,
  reportPath,
  evidenceDocument,
  evidencePath,
  evidenceSha256,
  verifiedArtifacts,
  job,
  index,
  reviewerTrust,
}) {
  const executionIdentity = assertVideoHarnessExecutionIdentity(job);
  if (report?.version !== "koya-final-audit-v1" || report?.pass !== true
    || (Array.isArray(report?.knownRemainingIssues) && report.knownRemainingIssues.length > 0)) {
    throw new Error(`signoffs[${index}]のKoya final-audit contractがpassではない。`);
  }
  const episodeId = firstText(job?.options?.episodeId);
  if (!episodeId || report?.episodeId !== episodeId || evidenceDocument?.episodeId !== episodeId) {
    throw new Error(`signoffs[${index}]が現在のKoya Job episodeIdに結合されていない。`);
  }
  const reportOuterJobBinding = assertKoyaOuterJobBinding(report?.outerJobBinding, {
    required: true,
    expectedJobId: job?.id,
    expectedIdentityDigest: job?.identityDigest,
    expectedExecutionIdentityDigest: executionIdentity.executionIdentityDigest,
    expectedResolvedProductionContractSha256: executionIdentity.resolvedProductionContractSha256,
  });
  const signedOuterJobBinding = assertKoyaOuterJobBinding(evidenceDocument?.outerJobBinding, {
    required: true,
    expectedJobId: job?.id,
    expectedIdentityDigest: job?.identityDigest,
    expectedExecutionIdentityDigest: executionIdentity.executionIdentityDigest,
    expectedResolvedProductionContractSha256: executionIdentity.resolvedProductionContractSha256,
  });
  if (reportOuterJobBinding.bindingSha256 !== signedOuterJobBinding.bindingSha256) {
    throw new Error(`signoffs[${index}]のKoya outer Job bindingがaudit-reportと一致しない。`);
  }
  const contractVersion = firstText(report?.contractVersion);
  const contractDigest = normalizedSha(report?.contractDigest, `signoffs[${index}].report.contractDigest`);
  const expectedContractVersion = firstText(job?.resolvedProductionContract?.contractVersion);
  const expectedContractDigest = normalizedSha(
    job?.resolvedProductionContract?.contractDigest,
    `signoffs[${index}].job.contractDigest`,
  );
  if (!contractVersion
    || contractVersion !== expectedContractVersion
    || contractDigest !== expectedContractDigest
    || evidenceDocument?.version !== "koya-agent-perceptual-signoff-v4"
    || evidenceDocument?.contractVersion !== contractVersion
    || normalizedSha(evidenceDocument?.contractDigest, `signoffs[${index}].contractDigest`) !== contractDigest) {
    throw new Error(`signoffs[${index}]が現在のKoya production contractに結合されていない。`);
  }
  const finalVideo = singleArtifact(
    verifiedArtifacts,
    (artifact) => FINAL_VIDEO.test(artifactText(artifact)),
    "final-video",
  );
  const contactSheet = singleArtifact(
    verifiedArtifacts,
    (artifact) => CONTACT_SHEET.test(artifactText(artifact)),
    "contact-sheet",
  );
  if (normalizedSha(report?.videoSha256, `signoffs[${index}].report.videoSha256`) !== finalVideo.sha256
    || !sameResolvedPath(report?.videoPath, finalVideo.path)
    || normalizedSha(evidenceDocument?.videoSha256, `signoffs[${index}].videoSha256`) !== finalVideo.sha256
    || !sameResolvedPath(evidenceDocument?.videoPath, finalVideo.path)) {
    throw new Error(`signoffs[${index}]が現在のKoya final-video path/SHAに結合されていない。`);
  }
  if (normalizedSha(evidenceDocument?.contactSheetSha256, `signoffs[${index}].contactSheetSha256`) !== contactSheet.sha256
    || !sameResolvedPath(evidenceDocument?.contactSheetPath, contactSheet.path)) {
    throw new Error(`signoffs[${index}]が現在のKoya contact-sheet path/SHAに結合されていない。`);
  }
  const reviewSteps = (report?.steps || []).filter((step) => step?.id === "agent-contact-sheet-review");
  if (reviewSteps.length !== 1) {
    throw new Error(`signoffs[${index}]のKoya agent-contact-sheet-reviewはちょうど1件であること。`);
  }
  const reviewStep = reviewSteps[0];
  const stepEvidencePath = firstText(reviewStep?.evidencePath);
  const resolvedStepEvidencePath = stepEvidencePath
    ? (isAbsolute(stepEvidencePath) ? resolve(stepEvidencePath) : resolve(dirname(reportPath), stepEvidencePath))
    : "";
  if (reviewStep?.pass !== true
    || reviewStep?.contactSheetPass !== true
    || reviewStep?.signoffGate?.pass !== true
    || !sameResolvedPath(resolvedStepEvidencePath, evidencePath)
    || normalizedSha(reviewStep?.evidenceSha256, `signoffs[${index}].step.evidenceSha256`) !== evidenceSha256
    || normalizedSha(reviewStep?.contactSheetSha256, `signoffs[${index}].step.contactSheetSha256`) !== contactSheet.sha256
    || !sameResolvedPath(reviewStep?.contactSheetPath, contactSheet.path)) {
    throw new Error(`signoffs[${index}]のKoya audit stepが現在のsignoff/contact-sheet証跡に結合されていない。`);
  }
  // 信頼設定済み reviewer 鍵の署名を、Receipt 側でも独立に再検証する。
  // review notes の digest は signoff の申告値ではなく、埋め込まれた notes から再計算する。
  const reviewNotes = evidenceDocument?.reviewNotes;
  if (!reviewNotes || typeof reviewNotes !== "object" || Array.isArray(reviewNotes)) {
    throw new Error(`signoffs[${index}]のKoya signoffにreviewNotesが埋め込まれていない。`);
  }
  const reviewNotesContentSha256 = createHash("sha256").update(stableJson(reviewNotes)).digest("hex");
  if (evidenceDocument?.reviewNotesContentSha256 !== reviewNotesContentSha256) {
    throw new Error(`signoffs[${index}]のreviewNotesContentSha256が埋め込まれたreview notesと一致しない。`);
  }
  let expectedSubject;
  try {
    expectedSubject = createKoyaReviewAttestationSubject({
      episodeId,
      outerJobBinding: signedOuterJobBinding,
      contractDigest,
      videoSha256: finalVideo.sha256,
      contactSheetSha256: contactSheet.sha256,
      reviewNotesContentSha256,
      reviewer: evidenceDocument?.reviewerProvenance,
    });
  } catch (error) {
    // 期待 subject が組めない（Job・成果物・reviewer 申告側の欠落）は、署名 subject の
    // 不正とは別の理由コード（reviewer-attestation-expected-subject-*）で落とす。
    throw new Error(`signoffs[${index}]のreviewer attestation期待対象を組めない: ${expectedSubjectFailureCodes(error).join(", ")}`);
  }
  const attestation = verifyReviewAttestation(evidenceDocument?.reviewerAttestation, {
    expectedSubject,
    trust: reviewerTrust,
  });
  if (!attestation.pass) {
    throw new Error(`signoffs[${index}]のreviewer attestationが無効: ${attestation.failures.join(", ")}`);
  }
  return {
    signerKeyId: attestation.signerKeyId,
    reviewerLabel: attestation.reviewerLabel,
    trustSha256: attestation.trustSha256,
  };
}

function validateNarratedSignoffBinding({
  report,
  evidenceDocument,
  evidenceSha256,
  verifiedArtifacts,
  job,
  index,
  reviewerTrust,
  auditContract,
}) {
  // 承認した signoff への結合も、効力のある契約の監査だけを求める（v3 の Job に v4 の人物の同一性の結合を求めない）。
  const inForce = new Set(auditContract?.requiredAuditIds || NARRATED_STORY_SIGNOFF_AUDIT_IDS);
  if (report?.version !== NARRATED_STORY_AUDIT_VERSION || report?.status !== "pass") {
    throw new Error(`signoffs[${index}]のnarrated-story audit contractが不正。`);
  }
  if (String(report?.jobId || "") !== String(job?.id || "")) {
    throw new Error(`signoffs[${index}]のaudit-reportが現在のJobに結合されていない。`);
  }
  if (evidenceDocument?.version !== NARRATED_STORY_SIGNOFF_VERSION
    || evidenceDocument?.approved !== true
    || evidenceDocument?.originalDetailReviewed !== true
    || !Array.isArray(evidenceDocument?.findings)
    || evidenceDocument.findings.length > 0
    || !Array.isArray(evidenceDocument?.knownRemainingIssues)
    || evidenceDocument.knownRemainingIssues.length > 0) {
    throw new Error(`signoffs[${index}]のnarrated-story signoff contractがpassではない。`);
  }
  const finalVideo = singleArtifact(
    verifiedArtifacts,
    (artifact) => FINAL_VIDEO.test(artifactText(artifact)),
    "final-video",
  );
  const contactSheet = singleArtifact(
    verifiedArtifacts,
    (artifact) => CONTACT_SHEET.test(artifactText(artifact)),
    "contact-sheet",
  );
  const reportVideoSha256 = normalizedSha(report?.videoSha256, `signoffs[${index}].report.videoSha256`);
  const reportContactSheetSha256 = normalizedSha(
    report?.contactSheetSha256,
    `signoffs[${index}].report.contactSheetSha256`,
  );
  const signedVideoSha256 = normalizedSha(evidenceDocument?.videoSha256, `signoffs[${index}].videoSha256`);
  const signedContactSheetSha256 = normalizedSha(
    evidenceDocument?.contactSheetSha256,
    `signoffs[${index}].contactSheetSha256`,
  );
  if (reportVideoSha256 !== finalVideo.sha256 || signedVideoSha256 !== finalVideo.sha256) {
    throw new Error(`signoffs[${index}]が現在のfinal-video SHAに結合されていない。`);
  }
  if (reportContactSheetSha256 !== contactSheet.sha256 || signedContactSheetSha256 !== contactSheet.sha256) {
    throw new Error(`signoffs[${index}]が現在のcontact-sheet SHAに結合されていない。`);
  }
  for (const auditId of NARRATED_STORY_SIGNOFF_AUDIT_IDS.filter((id) => inForce.has(id))) {
    const observed = report?.auditChecks?.[auditId];
    if (observed?.pass !== true
      || normalizedSha(observed?.signoffSha256, `${auditId}.signoffSha256`) !== evidenceSha256
      || normalizedSha(observed?.videoSha256, `${auditId}.videoSha256`) !== finalVideo.sha256
      || normalizedSha(observed?.contactSheetSha256, `${auditId}.contactSheetSha256`) !== contactSheet.sha256) {
      throw new Error(`signoffs[${index}]がauditChecks.${auditId}の証跡に結合されていない。`);
    }
  }
  // 合格した回の採点が、品質ループの契約（評価項目と下限）に対するものであること。
  const qualityDigest = String(report?.auditChecks?.qualityLoopPassed?.contractDigest || "");
  if (inForce.has("qualityLoopPassed")
    && (!/^[a-f0-9]{64}$/u.test(qualityDigest) || evidenceDocument?.qualityReview?.contractDigest !== qualityDigest)) {
    throw new Error(`signoffs[${index}]の採点が品質ループの契約に結合されていない。`);
  }
  // 人物の同一性: 署名された採点そのものが下限以上であること（audit report の写しの数字を信じない）。
  const identity = report?.auditChecks?.characterIdentityReviewed;
  const signedIdentityScore = evidenceDocument?.qualityReview?.rubricScores?.[identity?.criterionId];
  if (inForce.has("characterIdentityReviewed") && (identity?.contractDigest !== qualityDigest
    || typeof signedIdentityScore !== "number"
    || !Number.isFinite(Number(identity?.minimumScore))
    || signedIdentityScore !== identity?.score
    || signedIdentityScore < Number(identity.minimumScore))) {
    throw new Error(`signoffs[${index}]の人物の同一性の採点が、署名された採点と下限に結合されていない。`);
  }
  // Koya と同じ信頼リスト・同じ署名方式で reviewer を鍵に結合する。期待 subject は
  // signoff の写しではなく、Job の真値と disk から計算した成果物 SHA から組む。
  // 自己申告の reviewerContextId だけでは、生成側の端末が別名を書くだけで
  // 「独立レビュー済み」の completed Job を作れてしまう。
  const attestation = verifyNarratedReviewSignoff(evidenceDocument, {
    jobId: job?.id,
    identityDigest: job?.identityDigest,
    videoSha256: finalVideo.sha256,
    contactSheetSha256: contactSheet.sha256,
    trust: reviewerTrust,
  });
  if (!attestation.pass) {
    throw new Error(`signoffs[${index}]のreviewer attestationが無効: ${attestation.failures.join(", ")}`);
  }
  return {
    signerKeyId: attestation.signerKeyId,
    reviewerLabel: attestation.reviewerLabel,
    trustSha256: attestation.trustSha256,
  };
}

/**
 * 宣言された attestation subject → signoff 結合検証器。harness id では分岐しない。
 * ここに無い subject を宣言した harness、宣言の無い harness は completed にしない。
 */
const SIGNOFF_BINDING_VALIDATORS = Object.freeze({
  "koya-manga-video": validateKoyaSignoffBinding,
  "narrated-story-video": validateNarratedSignoffBinding,
});

export const REVIEW_ATTESTATION_UNSUPPORTED_HARNESS = "reviewer-attestation-unsupported-harness";

/**
 * signoff を要する harness は、宣言 `reviewAttestation.subject` で attestation の
 * 形を申告しなければならない。宣言が無い／未知なら fail-closed。
 */
function requiredAttestationSubject(declaration) {
  const subject = declaredReviewAttestationSubject(declaration);
  if (!subject || typeof SIGNOFF_BINDING_VALIDATORS[subject] !== "function") {
    const declared = declaration?.reviewAttestation?.subject;
    // R5-F2 / R5-3: 「宣言を足して resume」を案内しない。宣言 file は canonical identity の材料で、
    // 既存 Job の実行中に編集すると canonical-identity-drift になり Receipt を確定できない。
    throw new Error(
      `${REVIEW_ATTESTATION_UNSUPPORTED_HARNESS}: harness ${declaration?.id || "(不明)"} は reviewAttestation.subject`
      + `${declared === undefined ? "を宣言していない" : ` "${String(declared)}" が未知`}。`
      + "signoff を要する harness は Job 作成前に宣言 config/harnesses/<id>.harness.json へ"
      + ' { "reviewAttestation": { "subject": "<既知の subject>" } } を持っていなければならない。'
      + "この Job は復旧不能: 宣言を直してから新しい Job を作ること（生成済み成果物・課金は requestKey journal で再利用される）。"
      + "既存 Job の宣言を編集して resume すると canonical-identity-drift になり、Receipt は確定できない。宣言の無い harness は completed にしない。",
    );
  }
  return subject;
}

async function validateSignoffs(report, {
  reportPath,
  now,
  required,
  attestationSubject,
  verifiedArtifacts,
  job,
  reviewerTrust = null,
  auditContract = null,
}) {
  if (typeof SIGNOFF_BINDING_VALIDATORS[attestationSubject] !== "function") {
    throw new Error(
      `${REVIEW_ATTESTATION_UNSUPPORTED_HARNESS}: ${attestationSubject || "(未宣言)"}。`
      + "宣言 reviewAttestation.subject は Job 作成前に必要で、この Job は復旧不能。宣言を直して新しい Job を作ること。",
    );
  }
  const candidates = signoffCandidates(report, { attestationSubject });
  if (required && candidates.length === 0) {
    throw new Error("completed監査reportに独立signoff evidenceが無い。");
  }
  const approvals = [];
  for (const [index, candidate] of candidates.entries()) {
    const approved = candidate?.pass === true || ["approved", "complete", "pass"].includes(String(candidate?.status || ""));
    if (!approved) throw new Error(`signoffs[${index}]がapprovedではない。`);
    const evidencePathValue = firstText(candidate.evidencePath, candidate.path);
    const evidencePath = evidencePathValue
      ? (isAbsolute(evidencePathValue) ? resolve(evidencePathValue) : resolve(dirname(reportPath), evidencePathValue))
      : "";
    if (!evidencePath) throw new Error(`signoffs[${index}]にevidencePathが無い。`);
    if (attestationSubject === "koya-manga-video" && !candidate.evidenceSha256) {
      throw new Error(`signoffs[${index}]のKoya audit stepにevidenceSha256が無い。`);
    }
    let evidenceDocument = null;
    let evidenceSha256 = candidate.evidenceSha256 ? normalizedSha(candidate.evidenceSha256, `signoffs[${index}].evidenceSha256`) : "";
    const before = await stat(evidencePath);
    if (!before.isFile()) throw new Error(`signoffs[${index}]のevidenceが通常fileではない。`);
    const evidenceBytes = await readFile(evidencePath);
    const after = await stat(evidencePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || evidenceBytes.length !== after.size) {
      throw new Error(`signoffs[${index}]のevidenceが読取り中に変更された。`);
    }
    const actualEvidenceSha256 = createHash("sha256").update(evidenceBytes).digest("hex");
    if (evidenceSha256 && evidenceSha256 !== actualEvidenceSha256) {
      throw new Error(`signoffs[${index}]のevidence SHAが実fileと一致しない。`);
    }
    evidenceSha256 = actualEvidenceSha256;
    try {
      evidenceDocument = JSON.parse(evidenceBytes.toString("utf8"));
    } catch {
      evidenceDocument = null;
    }
    if (!evidenceDocument || typeof evidenceDocument !== "object" || Array.isArray(evidenceDocument)
      || (attestationSubject !== "narrated-story-video" && (
        evidenceDocument.pass !== true
        || (Array.isArray(evidenceDocument.knownRemainingIssues) && evidenceDocument.knownRemainingIssues.length > 0)
      ))) {
      throw new Error(`signoffs[${index}]のevidence documentがpassではない。`);
    }
    if (!evidenceSha256) throw new Error(`signoffs[${index}]にSHA拘束されたevidenceが無い。`);
    const typeValue = firstText(candidate.type) || "independent-agent";
    const type = typeValue === "human" ? "human" : (typeValue === "independent-agent" ? typeValue : "");
    if (!type) throw new Error(`signoffs[${index}].typeはhumanまたはindependent-agentであること。`);
    const reviewer = firstText(
      evidenceDocument?.reviewer,
      evidenceDocument?.reviewer?.id,
      evidenceDocument?.reviewerProvenance?.id,
    );
    const reviewerContextId = firstText(
      evidenceDocument?.reviewerContextId,
      evidenceDocument?.reviewer?.contextId,
      evidenceDocument?.reviewerProvenance?.contextId,
    );
    if (!reviewer || !reviewerContextId) {
      throw new Error(`signoffs[${index}]にreviewerとreviewerContextIdが無い。`);
    }
    if (reviewerContextId === job?.id || reviewerContextId === `production:${job?.id}`) {
      throw new Error(`signoffs[${index}]のreviewerがproduction Jobと同じcontextである。`);
    }
    const generatorContextId = firstText(
      evidenceDocument?.generatorContextId,
      evidenceDocument?.generator?.contextId,
      evidenceDocument?.generatorProvenance?.contextId,
    );
    if (generatorContextId && generatorContextId === reviewerContextId) {
      throw new Error(`signoffs[${index}]のreviewerがgeneratorと同じcontextである。`);
    }
    const claimedReviewer = firstText(candidate.reviewer, candidate.reviewer?.id, candidate.reviewerProvenance?.id);
    const claimedContextId = firstText(
      candidate.reviewerContextId,
      candidate.reviewer?.contextId,
      candidate.reviewerProvenance?.contextId,
    );
    if ((claimedReviewer && claimedReviewer !== reviewer) || (claimedContextId && claimedContextId !== reviewerContextId)) {
      throw new Error(`signoffs[${index}]のreport記載provenanceがevidence documentと一致しない。`);
    }
    // 宣言駆動: harness id ではなく attestation subject で検証器を選ぶ。
    const reviewerAttestation = SIGNOFF_BINDING_VALIDATORS[attestationSubject]({
      report,
      reportPath,
      evidenceDocument,
      evidencePath,
      evidenceSha256,
      verifiedArtifacts,
      job,
      index,
      reviewerTrust,
      auditContract,
    });
    approvals.push({
      reviewerAttestation,
      type,
      scope: firstText(candidate.scope, candidate.id) || "final-contact-sheet",
      evidence: evidenceSha256,
      reviewer,
      reviewerContextId,
      decidedAt: firstText(
        candidate.decidedAt,
        candidate.reviewedAt,
        candidate.signedAt,
        evidenceDocument?.decidedAt,
        evidenceDocument?.reviewedAt,
        evidenceDocument?.signedAt,
        report.generatedAt,
      ) || now,
    });
  }
  return approvals;
}

/**
 * Job に残った imageRetry / imageRetryHistory から、Receipt に写す 1 件を選ぶ。
 * 名前は adapter の出力（imageRetry.retriedFailed = { requested, jobIds, count, attempts, completed }）と同じ。
 * requested でも count>0 でもない（迂回引数を使っていない）なら null。
 */
function imageRetryFactsOf(job) {
  const rows = [
    ...(Array.isArray(job?.imageRetryHistory) ? job.imageRetryHistory : []),
    ...(job?.imageRetry && typeof job.imageRetry === "object" ? [job.imageRetry] : []),
  ];
  const used = rows.filter((row) => row?.requested === true || Number(row?.retriedFailed?.count) > 0);
  const latest = used.at(-1);
  if (!latest) return null;
  const retried = latest.retriedFailed || {};
  return {
    requested: latest.requested === true || retried.requested === true,
    jobIds: Array.isArray(retried.jobIds) ? retried.jobIds : [],
    count: retried.count,
    attempts: retried.attempts,
    completed: retried.completed,
  };
}

/** completed adapterだけを共通Receiptへ確定する。失敗すれば完成扱いを拒否する。 */
export async function createVideoHarnessRunReceipt({
  job,
  outcome,
  now = () => new Date().toISOString(),
  verifyFinalVideo = validateFinalVideoMedia,
  reviewerTrust = null,
  env = process.env,
  harnessDeclarationsDir = DEFAULT_HARNESS_DECLARATIONS_DIR,
} = {}) {
  if (outcome?.status !== "completed") return null;
  const declarationBytes = await readFile(join(harnessDeclarationsDir, `${job.harness.id}.harness.json`));
  const declaration = JSON.parse(declarationBytes.toString("utf8"));
  const declarationSha256 = createHash("sha256").update(declarationBytes).digest("hex");
  const artifacts = Array.isArray(outcome.artifacts) ? outcome.artifacts : [];
  const auditArtifacts = artifacts.filter((artifact) => String(artifact?.kind || "") === "audit-report");
  if (auditArtifacts.length !== 1 || !auditArtifacts[0]?.path || !auditArtifacts[0]?.sha256) {
    throw new Error("completed adapterにはSHA拘束されたaudit-report成果物がちょうど1件要る。");
  }
  const { report, artifact: verifiedAuditArtifact } = await readVerifiedAuditReport(auditArtifacts[0]);
  const observed = auditEvidence(report);
  assertOutcomeAuditConsistent(outcome, observed);
  // 宣言の形（証拠の監査 id が空でない・重複しない）はいつでも検める。必須かどうかは効力のある契約で決める。
  declaredAuditIds(declaration);
  const requirements = completionRequirements(declaration);

  const verifiedArtifacts = [];
  for (const artifact of artifacts) {
    verifiedArtifacts.push(artifact === auditArtifacts[0]
      ? verifiedAuditArtifact
      : await verifiedArtifact(artifact));
  }
  assertArtifactRoster(verifiedArtifacts, requirements);
  let pinnedContract = null;
  if (job.harness.id === "koya-manga-video") {
    assertVideoHarnessExecutionIdentity(job);
    pinnedContract = await assertCurrentKoyaResolvedContract(job);
  }
  const auditContract = effectiveAuditContract({ declaration, declarationSha256, report, job, pinnedContract });
  assertReportAuditRoster(report, auditContract);
  // signoff を要する harness は全て、信頼設定済み reviewer 鍵の署名を要する。
  // 信頼リストは生成プロセスと別経路で受け取る。無ければ completed にしない。
  // harness ごとに分岐させない: 分岐にすると後から増えた 1 つが素通りする。
  // attestation の形は harness 宣言 reviewAttestation.subject が申告する（宣言無し＝拒否）。
  const attestationSubject = requirements.signoffRequired ? requiredAttestationSubject(declaration) : "";
  const loadedReviewerTrust = requirements.signoffRequired
    ? await loadReviewerTrust({ trust: reviewerTrust, env })
    : null;
  if (requirements.finalVideoDecodeRequired) {
    const finalVideo = singleArtifact(
      verifiedArtifacts,
      (artifact) => FINAL_VIDEO.test(artifactText(artifact)),
      "final-video",
    );
    if (typeof verifyFinalVideo !== "function") throw new Error("final-video実デコード検証器が無い。");
    const decode = await verifyFinalVideo(finalVideo);
    if (decode?.pass !== true
      || normalizedSha(decode?.sha256, "final-video decode.sha256") !== finalVideo.sha256) {
      throw new Error("final-videoの実デコード証跡が現在の成果物SHAに結合されていない。");
    }
  }
  const completedMediaJobs = mediaJobs(outcome);
  assertMediaJobRoster(completedMediaJobs, requirements);
  const timestamp = now();
  const approvals = requirements.signoffRequired
    ? await validateSignoffs(report, {
      reportPath: verifiedAuditArtifact.path,
      now: timestamp,
      required: true,
      attestationSubject,
      verifiedArtifacts,
      job,
      reviewerTrust: loadedReviewerTrust,
      auditContract,
    })
    : [];

  const receipt = openRunReceipt({
    projectDir: job.executionProjectDir || job.projectDir,
    harnessId: job.harness.id,
    repoRoot: job.canonicalIdentity?.repositoryRoot,
    deploymentRoot: job.canonicalIdentity?.deployment?.root,
    expectedProductionDependencies: job.canonicalIdentity?.productionDependencies || null,
    entrypoint: "scripts/run-video-harness.mjs",
    action: "full",
    inputs: {
      scriptSha256: job.script.sha256,
      jobIdentityDigest: job.identityDigest,
      executionIdentityDigest: job.executionIdentityDigest || null,
      productionContract: job.resolvedProductionContract || null,
      channelPackPayloadSha256: job.channelPackVerification?.payloadSha256,
      channelPackRuntimeIdentity: job.channelPackRuntime || null,
      adapterRuntimeIdentity: outcome.runtimeMetadata || null,
      adapterCapabilityProbes: (outcome.adapterProbes || []).map((probe) => ({
        ok: probe?.ok === true,
        status: String(probe?.status || ""),
        kind: String(probe?.kind || ""),
        provider: String(probe?.provider || ""),
        model: String(probe?.model || ""),
        adapterVersion: String(probe?.adapterVersion || ""),
        serverVersion: String(probe?.serverVersion || ""),
      })),
      auditReportSha256: verifiedAuditArtifact.sha256,
      // どの契約の版の必須監査で測ったか（固定した制作契約か、宣言の inForceSince か、宣言の版へ引き上げたか）。
      auditContract,
      ...(loadedReviewerTrust ? {
        reviewerAttestationSubject: attestationSubject,
        reviewerTrustSha256: loadedReviewerTrust.sha256,
        reviewerAttestations: approvals
          .map((approval) => approval.reviewerAttestation)
          .filter(Boolean),
      } : {}),
    },
    verifiedChannelPack: job.channelPackVerification,
    // 作ったホスト・再開したホスト（Job 層が入口ごとに残した記録をそのまま写す。ここで判定し直さない）。
    invocation: job.metadata?.invocation ?? null,
    // 正本スキルの承認の状態（開発用チェックアウトで承認前の正本のまま作ったか）。Job の計画時に
    // 本番の profile が残した記録をそのまま写す（resume でも canonicalIdentity と一致を確かめ済み）。
    skillApproval: job.canonicalIdentity?.productionProfile?.skillApproval ?? null,
    timing: {
      jobCreatedAt: job.createdAt,
      runStartedAt: (job.stages || []).find((stage) => stage?.id === "doctor")?.startedAt,
      // Receipt の確定だけをやり直す回は、成果物を作った実行から人待ちを挟んでいる。
      receiptOnlyRetry: Boolean(job.pendingReceiptFinalization),
      // 工程ごとの開始・終了（子が報告し Job が写したもの。重ねた工程は overlapsWith を持つ）。
      stages: Array.isArray(job.stageTimings?.stages) ? job.stageTimings.stages : [],
    },
  });
  // 効力のある契約の必須監査だけで測る。効力の外の保証は inForceSince と突き合わせて not-in-force になる。
  const gateInput = {
    declaration,
    requiredAuditIds: auditContract.requiredAuditIds,
    contractVersion: auditContract.contractVersion,
  };
  if (observed.kind === "steps") {
    recordGatesFromAuditSteps(receipt, { ...gateInput, steps: observed.value });
  } else {
    recordGatesFromAuditChecks(receipt, { ...gateInput, checks: observed.value });
  }
  // failed からの再開で完成した Job は、その事実（前回の失敗、再利用/再発行した Media Job）を
  // Receipt に残す。Job 層が保存した記録をそのまま写す（ここで作り直さない）。
  if (job.resumeFromFailed && typeof job.resumeFromFailed === "object") {
    recordResumeFromFailed(receipt, job.resumeFromFailed);
  }
  // 失敗した画像行を指紋迂回の引数で作り直した事実。最新の実行で使っていなくても、
  // この Job のどこかの回で使っていれば（imageRetryHistory）その最後の回を写す。
  const imageRetryFacts = imageRetryFactsOf(job);
  if (imageRetryFacts) recordImageRetry(receipt, imageRetryFacts);
  for (const artifact of verifiedArtifacts) recordRunArtifact(receipt, artifact);
  for (const summary of completedMediaJobs) recordPaidMediaJob(receipt, summary);
  for (const approval of approvals) recordApproval(receipt, approval);
  finalizeRunReceipt(receipt, {
    outcome: "pass",
    knownRemainingIssues: outcome.knownRemainingIssues || [],
    timestamp,
  });
  if (receipt.outcome !== "pass") {
    throw new Error("共通RunReceiptがpassにならなかった。未完了Media Job、signoff、成果物または不合格gateがある。");
  }
  const path = await writeRunReceipt(receipt, join(job.runDir, "run-receipt.json"));
  return { receipt, path };
}

export const _testing = Object.freeze({
  auditEvidence,
  completionRequirements,
  declaredAuditIds,
  effectiveAuditContract,
  mediaJobs,
  requiredAttestationSubject,
  signoffCandidates,
});
