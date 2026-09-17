import { execFile as execFileCallback, spawn } from "node:child_process";
import { resolveChannelPackPath } from "./channelPackResolver.mjs";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { writeJsonAtomic } from "./canvasScene.mjs";
import { readKoyaChannelAuthority } from "./koyaChannelGovernance.mjs";
import { loadReviewerTrust } from "./koyaReviewAttestation.mjs";
import { runHarnessDoctor } from "../scripts/harness-doctor.mjs";

const execFile = promisify(execFileCallback);
const moduleDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(moduleDir, "..");
const officialCli = join(repositoryRoot, "scripts", "koya-manga-video.mjs");
const jobRunner = join(repositoryRoot, "scripts", "koya-mcp-job-runner.mjs");

export const KOYA_MCP_ACTIONS = Object.freeze([
  "contract", "channel-contract", "character-bootstrap-status", "character-roster-review-draft", "character-roster-audit", "cast-readiness", "story-review-draft", "story-audit", "location-plan", "location-generate", "location-import", "location-anchor-review-draft", "location-anchor-audit", "location-review-draft", "location-register", "thumbnail-plan-draft", "thumbnail-audit", "handoff-export", "handoff-verify", "handoff-restore", "plan", "images", "character-review-refresh", "character-candidate-migrate-blind", "character-candidate-import", "character-candidate-qa-sheet", "character-style-generate", "character-style-import", "character-style-qa-sheet", "character-style-review-refresh", "character-style-record-failure", "character-style-compose", "character-style-select", "character-approve", "character-identity-refresh", "character-register",
  "prepare", "speech", "adjust-gap", "standard-cut", "repair-onset", "repair-tail", "sync-contract",
  "refresh-bubbles", "render", "audit", "reviewer-key-create", "signoff", "full", "status",
]);

// character-bootstrap-status は候補レビューの機械再チェックを走らせ、
// その証跡を .machine-recheck へ書く。読み取り専用ではないので、
// ここに置くと read-only サンドボックスで EPERM になり、
// インフラ障害がレビュー不合格に見える。
// server.mjs はこの Set を read-only 判定の唯一の定義として参照する（R4-8）ので export する（R6-6）。
export const READ_ONLY_ACTIONS = new Set(["contract", "channel-contract", "character-roster-audit", "cast-readiness", "story-review-draft", "story-audit", "location-plan", "location-anchor-review-draft", "location-anchor-audit", "location-review-draft", "thumbnail-plan-draft", "thumbnail-audit", "handoff-verify", "status"]);
const OPTION_NAMES = Object.freeze([
  "episodeId", "scriptPath", "title", "protagonistSpeakerId", "characterBiblePath", "sourceFaceReviewPath",
  "storyReviewPath", "rosterReviewPath", "thumbnailPlanPath", "locationId", "locationStage", "locationAnchorReviewPath", "locationReviewPath", "importMapPath", "model",
  "layout",
  "generatorHost", "generatorId", "generatorContextId", "workflowId", "castId", "candidateLabel",
  "candidateLabels", "retiredCandidateLabels", "migrationReason", "candidateImportMapPath", "candidateRebuildSpecPath",
  "approvalReason", "approvedBy", "candidateReviewPath", "identityReviewPath", "identityGenerationImportMapPath", "identityRefreshId", "videoPath", "reviewer",
  "baseCandidateLabel", "stylingSpecPath", "stylingImportMapPath", "stylingComparisonReferencePaths", "stylingRepairSourcePath", "stylingReviewPath", "stylingRoundId", "stylingOptionId", "selectionReason", "selectedBy", "correctiveSupersedeReason",
  "reviewerContextId", "reviewNotesPath", "cutIds", "cutId", "planPath", "utteranceId",
  "sourcePath", "outputFileName", "reason", "targetAudibleGapSeconds", "speechEndSeconds", "fadeStartSeconds",
  "fadeMilliseconds", "imageConcurrency", "qaConcurrency", "imageFallbackModel", "qaFallbackProvider",
  "renderConcurrency", "fileName", "contractPath", "overridePath",
  "bundleDir", "outputDir", "bundleId", "characterIds", "visualProfileIds",
  // signoff / audit / reviewer-key-create: 鍵と信頼リストは path だけを渡す。
  // 中身（PEM・信頼リスト JSON）は MCP 引数に取らない。reviewerId はここに 1 回だけ
  // （二重に載せると子 argv に --reviewer-id が 2 回並ぶ。R6-6）。
  "reviewerId", "reviewerKeyPath", "reviewerTrustPath", "reviewerPublicKeyPath", "reviewerLabel",
]);
if (new Set(OPTION_NAMES).size !== OPTION_NAMES.length) {
  throw new Error("Koya MCP OPTION_NAMES has a duplicate entry; each option must map to exactly one CLI flag.");
}
const BOOLEAN_OPTIONS = new Set(["retryFailed", "quick", "dryRun", "force", "pass"]);
// 鍵の中身らしい option 名／値は allowlist 外でも黙って捨てず、呼び出し側へ拒否を返す。
// 黙って捨てると「渡したのに効かない」と見え、鍵本体を argv に載せる回避策を誘発する。
const KEY_MATERIAL_OPTION = /(?:pem$|private[-_]?key|secrets?$|token$|password$|api[-_]?key$|(?:^|[a-z0-9])key$)/iu;
const KEY_MATERIAL_VALUE = /-----BEGIN [A-Z ]*(?:PRIVATE|PUBLIC) KEY-----|"reviewers"\s*:\s*\[/u;

function assertNoKeyMaterialOptions(options = {}) {
  for (const [name, value] of Object.entries(options || {})) {
    if (KEY_MATERIAL_OPTION.test(name)) {
      throw new Error(`Koya MCP option '${name}' looks like key material; pass reviewerKeyPath / reviewerTrustPath file paths only.`);
    }
    if (typeof value === "string" && KEY_MATERIAL_VALUE.test(value)) {
      throw new Error(`Koya MCP option '${name}' contains key or trust-list material; pass a file path instead.`);
    }
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * MCP 引数の reviewerTrustPath は照合用。信頼アンカー規則（唯一のアンカーは MCP host の
 * 環境変数 BUZZASSIST_REVIEWER_TRUST、明示 path は一致確認のみ、env 未設定なら fail-closed）
 * は lib/koyaReviewAttestation.mjs の loadReviewerTrust に 1 か所だけあり、ここはそれを
 * CLI を spawn する前に呼ぶだけ。ここで止めないと、MCP を叩く agent が自分で作った鍵だけの
 * 信頼リストへ audit/signoff の信頼アンカーを差し替えられる。
 * env は process.env だけを見る。MCP 引数から env を受けると host 設定を偽装できる。
 */
async function assertReviewerTrustPathAgreesWithHost(options = {}, env = process.env) {
  const requestedPath = nonEmptyString(options?.reviewerTrustPath);
  if (!requestedPath) return;
  try {
    await loadReviewerTrust({ trustPath: resolve(requestedPath), env });
  } catch (error) {
    const message = String(error?.message || error || "");
    if (/^reviewer-trust-conflict/u.test(message)) {
      throw new Error(
        "reviewer-trust-conflict: Koya MCP option reviewerTrustPath points at a trust list that differs from the host's"
        + " BUZZASSIST_REVIEWER_TRUST. The operator's host environment is the only trust anchor; omit reviewerTrustPath or point it at the same list.",
      );
    }
    if (/^reviewer-trust-unconfigured/u.test(message)) {
      throw new Error(
        "reviewer-trust-unconfigured: Koya MCP option reviewerTrustPath was given but the MCP host has no BUZZASSIST_REVIEWER_TRUST"
        + " (legacy BUZZASSIST_KOYA_REVIEWER_TRUST). A requester-supplied path cannot stand in for the operator's trust anchor; the operator must configure the host environment first.",
      );
    }
    throw error;
  }
}
export { assertReviewerTrustPathAgreesWithHost as _assertReviewerTrustPathAgreesWithHost };

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
  assertNoKeyMaterialOptions(options);
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

export { buildCliArgs as _buildKoyaCliArgs };

export async function runKoyaMcpAction(args = {}) {
  const action = nonEmptyString(args.action);
  const projectDir = resolveProjectDir(args);
  if (!READ_ONLY_ACTIONS.has(action) && args.confirmed !== true) {
    throw new Error(`Koya action '${action}' changes production state or may spend generation credits; confirmed=true is required.`);
  }
  await assertReviewerTrustPathAgreesWithHost(args.options || {});
  const cliArgs = buildCliArgs(action, { ...(args.options || {}), projectDir });
  const { stdout, stderr } = await execFile(process.execPath, cliArgs, {
    cwd: repositoryRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: true, action, projectDir, result: parseCliJson(stdout), stdout: String(stdout).trim(), stderr: String(stderr).trim() };
}

/**
 * 同じ案件を二度走らせないための資源キー。
 *
 * 変更系の要求は毎回、無条件に新しい detached ジョブを作っていた。
 * 同じエピソードの同じ工程を二度投げても拒否も接続もされないので、
 * **二重課金・成果物の上書き・状態更新の消失**が起きる。
 * project + episode + action で1本に絞る。
 */
export function koyaJobResourceKey({ projectDir, action, options = {} }) {
  const episode = nonEmptyString(options.episodeId ?? options.episode ?? "");
  const parts = [resolve(projectDir), action, episode || "(no-episode)"];
  // R6-7: reviewer-key-create / signoff は episode だけでは同じ案件と言えない。別 path への鍵作成要求や
  // 別 reviewer の signoff が、先行 job へ attach されて「成功」に見えないよう資源キーへ含める。
  if (action === "reviewer-key-create" || action === "signoff") {
    parts.push(`key=${nonEmptyString(options.reviewerKeyPath) ? resolve(options.reviewerKeyPath) : "(no-key-path)"}`);
  }
  if (action === "signoff") {
    parts.push(
      `reviewer=${nonEmptyString(options.reviewer) || "(none)"}`,
      `reviewerId=${nonEmptyString(options.reviewerId) || "(none)"}`,
      `context=${nonEmptyString(options.reviewerContextId) || "(none)"}`,
    );
  }
  return parts.join("\u001f");
}

/** 走っていることになっているジョブが、本当に走っているか。 */
function jobStillRunning(job) {
  if (!job || !["queued", "running"].includes(job.status)) return false;
  const pid = Number(job.runnerPid);
  if (!Number.isInteger(pid) || pid <= 0) {
    // PID が記録されていない古いジョブ。走っているとみなす方が安全
    // ——走っていないのに塞ぐより、二重に走らせる方が高くつく。
    return true;
  }
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

/**
 * 同じ資源キーで走っているジョブを探す。
 * ついでに、走っていることになっているが PID が死んでいるものを
 * interrupted へ直す——ホストが落ちると running のまま残り、
 * 記録だけからは再開も判定もできなくなる。
 */
async function findActiveJob(projectDir, resourceKey) {
  const root = jobRoot(projectDir);
  let names = [];
  try { names = await readdir(root); } catch { return null; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const jobPath = join(root, name);
    let job;
    try { job = JSON.parse(await readFile(jobPath, "utf8")); } catch { continue; }
    if (job.resourceKey !== resourceKey) continue;
    if (!["queued", "running"].includes(job.status)) continue;
    if (jobStillRunning(job)) return job;
    // 走っていない。記録を直しておく。
    try {
      await writeJsonAtomic(jobPath, {
        ...job,
        status: "interrupted",
        updatedAt: new Date().toISOString(),
        interruptedReason: "実行プロセスが見つからない（ホスト停止などで中断された）",
      });
    } catch { /* 読み取り専用の環境かもしれない */ }
  }
  return null;
}

export async function startKoyaMcpJob(args = {}) {
  const action = nonEmptyString(args.action);
  const projectDir = resolveProjectDir(args);
  if (READ_ONLY_ACTIONS.has(action)) return runKoyaMcpAction(args);
  if (args.confirmed !== true) {
    throw new Error(`Koya action '${action}' changes production state or may spend generation credits; confirmed=true is required.`);
  }
  await assertReviewerTrustPathAgreesWithHost(args.options || {});
  const resourceKey = koyaJobResourceKey({ projectDir, action, options: args.options || {} });
  const active = await findActiveJob(projectDir, resourceKey);
  if (active) {
    // 黙って2本目を作らない。既に走っているものを返す——拒否だけだと、
    // 呼び出し側は「失敗した」と受け取って作り直しにかかる。
    return {
      ...active,
      attached: true,
      note: `同じ案件（${action}${args.options?.episodeId ? ` / ${args.options.episodeId}` : ""}）が既に走っています。新しく起動せず、そのジョブを返します。`,
    };
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
    resourceKey,
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
  // PID をファイルにも残す。返り値にしか無いと、後から
  // 「本当に走っているか」を記録だけから判定できず、二重起動の抑止も
  // 中断の再分類もできない。
  const started = { ...queued, runnerPid: child.pid ?? null, status: "queued", updatedAt: new Date().toISOString() };
  await writeJsonAtomic(jobPath, started);
  return started;
}

export async function readKoyaMcpJob(args = {}) {
  const projectDir = resolveProjectDir(args);
  const id = nonEmptyString(args.jobId ?? args.id);
  if (!id || !/^koya-[a-z0-9-]+$/u.test(id)) throw new Error("A valid Koya jobId is required.");
  const path = join(jobRoot(projectDir), `${id}.json`);
  let job = JSON.parse(await readFile(path, "utf8"));
  // 実行プロセスが居ないのに queued / running のままなら、それは待機ではなく中断。
  // 読むだけの側は再分類していなかったので、runner が起動に失敗したジョブが
  // 「待機中」に見え続けた（Windows で実際に起きた。記録は queued、ログは空）。
  // findActiveJob と同じ判定を使い、記録も直す。
  if (["queued", "running"].includes(job.status) && !jobStillRunning(job)) {
    job = {
      ...job,
      status: "interrupted",
      updatedAt: new Date().toISOString(),
      interruptedReason: job.interruptedReason
        || "実行プロセスが見つからない（起動に失敗したか、ホスト停止などで中断された）",
    };
    try { await writeJsonAtomic(path, job); } catch { /* 読み取り専用の環境かもしれない */ }
  }
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

export async function doctorKoyaMcp(args = {}, options = {}) {
  const projectDir = resolveProjectDir(args);
  // The MCP used to have a second, file-only definition of "doctor". Embed
  // the canonical runtime report so CLI and MCP agree on Python, ffmpeg,
  // provider authentication, model route, schema and final readiness.
  // Keep dependency injection outside the MCP argument object: remote tool
  // callers must not be able to submit a forged ffmpeg/Python result. The
  // second parameter is available only to trusted in-process tests/callers.
  const runtime = await (options.runHarnessDoctor ?? runHarnessDoctor)({
    projectDir,
    harnessId: "koya-manga-video",
    runtime: options.runtime ?? {},
  });
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
    ok: runtime.ready && checks.every((check) => check.ok) && Boolean(contract?.validation?.pass) && Boolean(channelAuthority) && !channelAuthorityError,
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
    runtime,
  };
}
