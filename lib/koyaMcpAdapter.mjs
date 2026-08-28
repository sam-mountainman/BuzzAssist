import { execFile as execFileCallback, spawn } from "node:child_process";
import { resolveChannelPackPath } from "./channelPackResolver.mjs";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { writeJsonAtomic } from "./canvasScene.mjs";
import { readKoyaChannelAuthority } from "./koyaChannelGovernance.mjs";

const execFile = promisify(execFileCallback);
const moduleDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(moduleDir, "..");
const officialCli = join(repositoryRoot, "scripts", "koya-manga-video.mjs");
const jobRunner = join(repositoryRoot, "scripts", "koya-mcp-job-runner.mjs");

export const KOYA_MCP_ACTIONS = Object.freeze([
  "contract", "channel-contract", "character-bootstrap-status", "character-roster-review-draft", "character-roster-audit", "cast-readiness", "story-review-draft", "story-audit", "location-plan", "location-generate", "location-anchor-review-draft", "location-anchor-audit", "location-review-draft", "location-register", "thumbnail-plan-draft", "thumbnail-audit", "handoff-export", "handoff-verify", "handoff-restore", "plan", "images", "character-review-refresh", "character-candidate-migrate-blind", "character-candidate-import", "character-candidate-qa-sheet", "character-style-generate", "character-style-import", "character-style-qa-sheet", "character-style-review-refresh", "character-style-record-failure", "character-style-compose", "character-style-select", "character-approve", "character-register",
  "prepare", "speech", "adjust-gap", "standard-cut", "repair-onset", "repair-tail", "sync-contract",
  "refresh-bubbles", "render", "audit", "signoff", "full", "status",
]);

// character-bootstrap-status は候補レビューの機械再チェックを走らせ、
// その証跡を .machine-recheck へ書く。読み取り専用ではないので、
// ここに置くと read-only サンドボックスで EPERM になり、
// インフラ障害がレビュー不合格に見える。
const READ_ONLY_ACTIONS = new Set(["contract", "channel-contract", "character-roster-audit", "cast-readiness", "story-review-draft", "story-audit", "location-plan", "location-anchor-review-draft", "location-anchor-audit", "location-review-draft", "thumbnail-plan-draft", "thumbnail-audit", "handoff-verify", "status"]);
const OPTION_NAMES = Object.freeze([
  "episodeId", "scriptPath", "title", "protagonistSpeakerId", "characterBiblePath", "sourceFaceReviewPath",
  "storyReviewPath", "rosterReviewPath", "thumbnailPlanPath", "locationId", "locationStage", "locationAnchorReviewPath", "locationReviewPath", "model",
  "layout",
  "generatorHost", "generatorId", "generatorContextId", "workflowId", "castId", "candidateLabel",
  "candidateLabels", "retiredCandidateLabels", "migrationReason", "candidateImportMapPath", "candidateRebuildSpecPath",
  "approvalReason", "approvedBy", "candidateReviewPath", "identityReviewPath", "videoPath", "reviewer",
  "baseCandidateLabel", "stylingSpecPath", "stylingImportMapPath", "stylingComparisonReferencePaths", "stylingRepairSourcePath", "stylingReviewPath", "stylingRoundId", "stylingOptionId", "selectionReason", "selectedBy", "correctiveSupersedeReason",
  "reviewerId", "reviewerContextId", "reviewNotesPath", "cutIds", "cutId", "planPath", "utteranceId",
  "sourcePath", "outputFileName", "reason", "targetAudibleGapSeconds", "speechEndSeconds", "fadeStartSeconds",
  "fadeMilliseconds", "imageConcurrency", "qaConcurrency", "imageFallbackModel", "qaFallbackProvider",
  "renderConcurrency", "fileName", "contractPath", "overridePath",
  "bundleDir", "outputDir", "bundleId", "characterIds", "visualProfileIds",
]);
const BOOLEAN_OPTIONS = new Set(["retryFailed", "quick", "dryRun", "force", "pass"]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function kebab(value) {
  return value.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

function resolveProjectDir(args = {}) {
  return resolve(nonEmptyString(args.projectDir) || process.cwd());
}

function jobRoot(projectDir) {
  return join(projectDir, "canvas", "koya-mcp-jobs");
}

function buildCliArgs(action, options = {}) {
  if (!KOYA_MCP_ACTIONS.includes(action)) throw new Error(`Unsupported Koya MCP action: ${action || "(missing)"}.`);
  const values = [officialCli, action];
  for (const name of OPTION_NAMES) {
    const value = options[name];
    if (value === undefined || value === null || value === "") continue;
    values.push(`--${kebab(name)}`, String(value));
  }
  for (const name of BOOLEAN_OPTIONS) if (options[name] === true) values.push(`--${kebab(name)}`);
  return values;
}

function parseCliJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function tail(path, maximumBytes = 16_000) {
  try {
    const bytes = await readFile(path);
    return bytes.subarray(Math.max(0, bytes.length - maximumBytes)).toString("utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

export async function runKoyaMcpAction(args = {}) {
  const action = nonEmptyString(args.action);
  const projectDir = resolveProjectDir(args);
  if (!READ_ONLY_ACTIONS.has(action) && args.confirmed !== true) {
    throw new Error(`Koya action '${action}' changes production state or may spend generation credits; confirmed=true is required.`);
  }
  const cliArgs = buildCliArgs(action, { ...(args.options || {}), projectDir });
  const { stdout, stderr } = await execFile(process.execPath, cliArgs, {
    cwd: repositoryRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: true, action, projectDir, result: parseCliJson(stdout), stdout: String(stdout).trim(), stderr: String(stderr).trim() };
}

export async function startKoyaMcpJob(args = {}) {
  const action = nonEmptyString(args.action);
  const projectDir = resolveProjectDir(args);
  if (READ_ONLY_ACTIONS.has(action)) return runKoyaMcpAction(args);
  if (args.confirmed !== true) {
    throw new Error(`Koya action '${action}' changes production state or may spend generation credits; confirmed=true is required.`);
  }
  const id = `koya-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const root = jobRoot(projectDir);
  const jobPath = join(root, `${id}.json`);
  const stdoutPath = join(root, `${id}.stdout.log`);
  const stderrPath = join(root, `${id}.stderr.log`);
  const cliArgs = buildCliArgs(action, { ...(args.options || {}), projectDir });
  await mkdir(root, { recursive: true });
  const queued = {
    version: 1,
    id,
    action,
    projectDir,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    jobPath,
    stdoutPath,
    stderrPath,
  };
  await writeJsonAtomic(jobPath, queued);
  const child = spawn(process.execPath, [jobRunner, "--job-path", jobPath, "--cli-args-json", JSON.stringify(cliArgs)], {
    cwd: repositoryRoot,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { ...queued, runnerPid: child.pid };
}

export async function readKoyaMcpJob(args = {}) {
  const projectDir = resolveProjectDir(args);
  const id = nonEmptyString(args.jobId ?? args.id);
  if (!id || !/^koya-[a-z0-9-]+$/u.test(id)) throw new Error("A valid Koya jobId is required.");
  const path = join(jobRoot(projectDir), `${id}.json`);
  const job = JSON.parse(await readFile(path, "utf8"));
  return {
    ...job,
    stdoutTail: await tail(job.stdoutPath),
    stderrTail: await tail(job.stderrPath),
  };
}

export async function listKoyaMcpJobs(args = {}) {
  const projectDir = resolveProjectDir(args);
  const root = jobRoot(projectDir);
  let names = [];
  try { names = await readdir(root); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const jobs = [];
  for (const name of names.filter((entry) => /^koya-.+\.json$/u.test(entry)).sort().reverse().slice(0, 50)) {
    try { jobs.push(JSON.parse(await readFile(join(root, name), "utf8"))); } catch {}
  }
  return { projectDir, jobs };
}

export async function doctorKoyaMcp(args = {}) {
  const projectDir = resolveProjectDir(args);
  const projectAuthorityPaths = [
    resolveChannelPackPath(projectDir, "config/koya-show-bible.json"),
    resolveChannelPackPath(projectDir, "config/koya-location-bible.json"),
    resolveChannelPackPath(projectDir, "config/koya-thumbnail-contract.json"),
  ];
  const projectAuthorityPresence = await Promise.all(projectAuthorityPaths.map(async (path) => {
    try { await access(path); return true; } catch { return false; }
  }));
  const projectDataRestored = projectAuthorityPresence.every(Boolean);
  const partialProjectData = projectAuthorityPresence.some(Boolean) && !projectDataRestored;
  const authorityRoot = projectDataRestored || partialProjectData ? projectDir : repositoryRoot;
  const showBiblePath = resolveChannelPackPath(authorityRoot, "config/koya-show-bible.json");
  const required = [
    officialCli,
    join(repositoryRoot, ".agents", "skills", "manga-video-production", "SKILL.md"),
    join(repositoryRoot, ".agents", "skills", "manga-page-camera", "SKILL.md"),
    join(repositoryRoot, "config", "koya-manga-production-contract.json"),
    showBiblePath,
    resolveChannelPackPath(authorityRoot, "config/koya-location-bible.json"),
    resolveChannelPackPath(authorityRoot, "config/koya-thumbnail-contract.json"),
  ];
  try {
    const showBible = JSON.parse(await readFile(showBiblePath, "utf8"));
    for (const cast of Array.isArray(showBible?.cast) ? showBible.cast : []) {
      const relativePaths = [cast?.stylingSpecPath, ...(Array.isArray(cast?.stylingSpecPaths) ? cast.stylingSpecPaths : [])]
        .map((value) => nonEmptyString(value))
        .filter(Boolean);
      for (const relativePath of relativePaths) {
        const absolutePath = resolve(authorityRoot, relativePath);
        if (absolutePath !== authorityRoot && !absolutePath.startsWith(`${authorityRoot}${process.platform === "win32" ? "\\" : "/"}`)) {
          required.push(`INVALID_OUTSIDE_PROJECT:${relativePath}`);
        } else if (!required.includes(absolutePath)) required.push(absolutePath);
      }
    }
  } catch {
    // The standard required-file pass below will report the unreadable show bible.
  }
  const checks = [];
  for (const path of required) {
    try {
      await access(path);
      if (extname(path) === ".json") {
        const parsed = JSON.parse(await readFile(path, "utf8"));
        const version = nonEmptyString(parsed?.version);
        if (!version) throw new Error("JSON contract is missing a non-empty version.");
        checks.push({ path, ok: true, version });
      } else checks.push({ path, ok: true });
    }
    catch (error) { checks.push({ path, ok: false, error: error.message }); }
  }
  let contract = null;
  let contractError = "";
  let channelAuthority = null;
  let channelAuthorityError = "";
  try {
    channelAuthority = await readKoyaChannelAuthority({ projectDir, runtimeRoot: repositoryRoot });
  } catch (error) {
    channelAuthorityError = error.message;
  }
  if (checks.every((check) => check.ok)) {
    try {
      const result = await runKoyaMcpAction({ projectDir, action: "contract", options: { episodeId: args.episodeId } });
      contract = result.result;
    } catch (error) {
      contractError = error.message;
    }
  }
  return {
    ok: checks.every((check) => check.ok) && Boolean(contract?.validation?.pass) && Boolean(channelAuthority) && !channelAuthorityError,
    projectDir,
    officialCli,
    checks,
    contract,
    contractError,
    channelAuthority: channelAuthority ? { source: channelAuthority.source, root: channelAuthority.root, validation: channelAuthority.validation } : null,
    channelAuthorityError,
    authorityRoot,
    projectDataRestored,
    projectDataState: projectDataRestored ? "project" : partialProjectData ? "partial-invalid" : "plugin-default-awaiting-restore",
    productionEntrypoint: "node scripts/koya-manga-video.mjs",
  };
}
