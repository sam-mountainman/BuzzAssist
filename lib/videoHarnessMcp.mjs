// Generic Video Harness MCP surface. State transitions stay in
// videoHarnessService; this module only declares tools and translates results.
//
// reviewer 工程（signoff / reviewer-key-create）の MCP 入口もここに置く。両ハーネスから
// 同等に届くこと（CLI = MCP）が目的で、引数名は Koya の MCP 入口（koyaMcpAdapter の
// OPTION_NAMES）と同じ camelCase を使う。秘密鍵・信頼リストは **path だけ** を受け、中身は
// 引数に取らない。信頼アンカーは運営者の環境変数（service 層 assertReviewerTrustPathAgreesWithOperator）。

import { execFile as execFileCallback } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { collectCanvasFeedback } from "./canvasFeedbackCollector.mjs";
import { resolveHarnessDeploymentCommand } from "./harnessDeploymentResolver.mjs";
import { detectHostInvocation } from "./harnessHostProvenance.mjs";
import { redactSecrets } from "./paidApiRetry.mjs";
import { readVideoHarnessJob } from "./videoHarnessJob.mjs";
import { assertReviewerTrustPathAgreesWithOperator, videoHarnessService } from "./videoHarnessService.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const NARRATED_CLI = join(REPO_ROOT, "scripts", "narrated-story-video.mjs");
const KOYA_HARNESS_ID = "koya-manga-video";
const NARRATED_HARNESS_ID = "narrated-story-video";

export const TOOL_PLAN_VIDEO_REQUEST = "plan_video_request";
export const TOOL_RUN_VIDEO_HARNESS = "run_video_harness";
export const TOOL_GET_VIDEO_HARNESS_JOB = "get_video_harness_job";
export const TOOL_LIST_VIDEO_HARNESS_JOBS = "list_video_harness_jobs";
export const TOOL_CANCEL_VIDEO_HARNESS_JOB = "cancel_video_harness_job";
export const TOOL_RESUME_VIDEO_HARNESS_JOB = "resume_video_harness_job";
export const TOOL_COLLECT_VIDEO_HARNESS_FEEDBACK = "collect_video_harness_feedback";
export const TOOL_SIGNOFF_VIDEO_HARNESS_JOB = "signoff_video_harness_job";
export const TOOL_CREATE_VIDEO_HARNESS_REVIEWER_KEY = "create_video_harness_reviewer_key";

export const VIDEO_HARNESS_TOOL_NAMES = Object.freeze([
  TOOL_PLAN_VIDEO_REQUEST,
  TOOL_RUN_VIDEO_HARNESS,
  TOOL_GET_VIDEO_HARNESS_JOB,
  TOOL_LIST_VIDEO_HARNESS_JOBS,
  TOOL_CANCEL_VIDEO_HARNESS_JOB,
  TOOL_RESUME_VIDEO_HARNESS_JOB,
  TOOL_COLLECT_VIDEO_HARNESS_FEEDBACK,
  TOOL_SIGNOFF_VIDEO_HARNESS_JOB,
  TOOL_CREATE_VIDEO_HARNESS_REVIEWER_KEY,
]);

const PROJECT_DIR_PROPERTY = Object.freeze({
  type: "string",
  description: "Current host project ABSOLUTE path: the project that owns (or will own) the durable Job under <projectDir>/canvas/harness-runs. The MCP server fills it from MCP workspace roots / request metadata when the host exposes them, then from EXCALIDRAW_PROJECT_DIR; it is never taken from the MCP server's own working directory (the distributed plugin directory, whose children are replaced on every setup/auto-update). A relative value is refused with reviewer-path-not-absolute, and a call that cannot resolve any project fails closed with video-harness-project-dir-unresolved instead of creating a Job in the plugin directory.",
});

const JOB_ID_PROPERTY = Object.freeze({
  type: "string",
  description: "Durable video harness Job ID returned by run_video_harness.",
});

const REVIEWER_TRUST_PATH_PROPERTY = Object.freeze({
  type: "string",
  description: "Absolute path to the reviewer trust list JSON (koya-reviewer-trust-v1), used only to cross-check the operator's trust anchor when the common RunReceipt re-verifies signoff attestations. Path only; never the list body or any key material. The operator's BUZZASSIST_REVIEWER_TRUST (or BUZZASSIST_REVIEWER_TRUST_JSON; legacy BUZZASSIST_KOYA_REVIEWER_TRUST is read for compatibility and a new/legacy mismatch is env-ambiguous) on the executing host is the only trust anchor and is authoritative: this path must point at a list with the same canonical sha256 or the call is refused with reviewer-trust-conflict, and when the host has no trust list configured the call fails closed with reviewer-trust-unconfigured (an explicit path never becomes the anchor on its own). When it matches, the same path is also handed to the genre child CLI so both layers verify against one list. It is a runtime argument, not persisted in the Job and not part of the Job identity; options.reviewerTrustPath is rejected.",
});

const REVIEWER_KEY_PATH_PROPERTY = Object.freeze({
  type: "string",
  description: "Absolute FILE path of the reviewer's Ed25519 private key (PEM). The key is read from this file by the genre CLI only; key contents on this argument (or any *Pem / *PrivateKey field) are rejected. A relative path is refused with reviewer-path-not-absolute because the MCP server's cwd is the plugin directory, never the caller's.",
});

const HOST_MODEL_PROPERTY = Object.freeze({
  type: "string",
  description: "Optional. The exact model ID the calling agent is running as (the ID your host states, e.g. in your system prompt). Recorded in the Job and RunReceipt as caller-declared so runs can be compared per host and model; the host itself (Claude Code, Codex, Antigravity) is taken from the MCP clientInfo, not from this argument. Never guess: omit it when you do not know, and the record says unknown. Not part of the Job identity, so resuming from another host or model attaches to the same Job. Refused with host-model-invalid unless it is a plain model ID token.",
});

const CONFIRMED_REVIEWER_PROPERTY = Object.freeze({
  type: "boolean",
  description: "Must be exactly true. Same rule as run_koya_manga_pipeline: reviewer actions change production state (they write a signed signoff or a new key file), so they are never run on an unconfirmed call.",
});

export function videoHarnessToolDefinitions() {
  return [
    {
      name: TOOL_PLAN_VIDEO_REQUEST,
      title: "Plan Video Request (Choose a Harness)",
      description: "Read-only harness chooser; call it before run_video_harness when the operator describes what video they want. Ranks the declared harnesses for the request with the same deterministic rule run_video_harness uses for want (negated clauses such as 〜は使わず / 〜ではなく / not / without are subtracted), and explains each candidate: matched and negated terms, whether the script format, the signed Channel Pack's target harness, and the start options meet that harness's capability card, prerequisites (harness doctor, only when checkPrerequisites=true), and track record read from settled RunReceipts and skill evals (\"実績なし\" when there is none). When one harness is not decisive (tie, narrow margin, only negated terms, no match, or a Channel Pack aimed at another harness) it returns exactly one question with 2-3 options for the host question UI instead of choosing. Calls no model and no paid API, creates no Job, and never echoes the request, the script text, or Channel Pack contents. The host decides from this output, then calls run_video_harness with the chosen harnessId (plan-only unless confirmed=true). With channelId (or a pack/projectDir registered to a channel) it also classifies the request kind and recommends the next step with alternatives from the channel's strategy brief state (workflow); the host runs strategy-skill steps itself, and nothing here runs them. Same result as `node scripts/run-video-harness.mjs plan-request`.",
      inputSchema: {
        type: "object",
        properties: {
          request: { type: "string", description: "The operator's request as written (Japanese is fine). Used only for deterministic term matching; it is not stored or returned." },
          projectDir: {
            type: "string",
            description: "Current host project ABSOLUTE path. Used to read this project's settled RunReceipts (canvas/harness-runs) and to resolve a relative scriptPath / channelPackPath. Filled from MCP workspace roots / EXCALIDRAW_PROJECT_DIR when omitted; when nothing resolves, project receipts are skipped and relative paths are refused.",
          },
          harnessId: { type: "string", description: "Optional declared harness id to evaluate directly, e.g. the operator's answer to the returned question." },
          scriptPath: { type: "string", description: "Optional script file (absolute, or relative to projectDir). Only its format and size are read (raw text / Markdown / script package); the text is never returned." },
          channelPackPath: { type: "string", description: "Optional signed Channel Pack envelope directory. Only the manifest's target harness is reported, plus whether the signature verified against the operator's BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY; the pack id, files, and contents are never returned." },
          channelId: {
            type: "string",
            description: "Optional channel id from the operator's channel registry (channels in config/harness-deployments.json). The channel fixes the project folder, the signed Channel Pack, the production route (a harness, or the channel's existing external route), the strategy work folder, and the script-quality-loop settings; values passed here that disagree are refused with channel-input-conflict. With a channel the result adds requestKind (new-design / next-video / script-review / produce / rerender / post-publish / research, or one question when undecided) and workflow: the recommended next step with alternatives and reasons — a strategy-skill step (new design, next video, additional research, script review, post-publish, research; step name, work folder, and what to produce only), the strategy-brief quality loop, reusing a passed brief, production, or resuming an existing Job for a same-content rerender. A pack or projectDir that matches a registered channel selects that channel even without channelId.",
          },
          requestKind: {
            type: "string",
            enum: ["new-design", "next-video", "script-review", "produce", "rerender", "post-publish", "research"],
            description: "Optional explicit request kind, e.g. the operator's answer to the returned request-kind question. Only used with a channel.",
          },
          strategyBriefPath: {
            type: "string",
            description: "Optional strategy brief (buzzassist-strategy-brief-v1). Its verdict (pass, evidence states, reason codes) is reported, never its text. With a channel it must be inside the channel's strategy work folder; without it the latest brief of that folder's quality loop is used.",
          },
          options: {
            type: "object",
            description: "Optional start options exactly as run_video_harness would receive them (for koya-manga-video: episodeId, protagonistSpeakerId, characterBiblePath, storyReviewPath). Only key presence is checked.",
            additionalProperties: true,
          },
          checkPrerequisites: {
            type: "boolean",
            default: false,
            description: "When true, run the harness doctor (non-billing probes such as an ffmpeg test encode, the voice-QA Python stack, the reviewer trust anchor, and media adapter capability probes) for the selected or offered harnesses. Items the doctor can only confirm from a Job's signed Channel Pack are reported as checked at Job prepare, not as missing. Default false keeps the call local and fast.",
          },
        },
        required: ["request"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: TOOL_RUN_VIDEO_HARNESS,
      title: "Plan or Run Video Harness",
      description: "Create or attach to one durable script-to-video Job for any declared harness (koya-manga-video, narrated-story-video). Call plan_video_request first when the harness or the next step is not yet decided. Defaults to plan-only and never starts paid generation unless confirmed=true. A signed Channel Pack path is mandatory; never pass trusted keys or secrets.",
      inputSchema: {
        type: "object",
        properties: {
          projectDir: PROJECT_DIR_PROPERTY,
          scriptPath: { type: "string", description: "Input script file path: absolute, or relative to projectDir (a relative path is resolved against the resolved projectDir, never against the MCP server's working directory)." },
          channelPackPath: { type: "string", description: "Path to the signed Channel Pack envelope (channel-pack.json plus payload): absolute, or relative to projectDir. Pass a path only, never verification keys or secrets. Required unless channelId is given (then the channel registry supplies it)." },
          channelId: {
            type: "string",
            description: "Optional channel id from the operator's channel registry. The registry supplies projectDir, channelPackPath, and harnessId (values passed that disagree are refused with channel-input-conflict; an external-production channel is refused with channel-production-external). When the channel sets strategy.requireBrief, start stops before creating a Job unless a passed strategy brief is given (channel-strategy-brief-required / channel-strategy-brief-not-passed, with the recommended step). A pack or projectDir matching a registered channel applies the same gate without channelId.",
          },
          strategyBriefPath: {
            type: "string",
            description: "Optional strategy brief file (absolute, or relative to projectDir). Its SHA-256 goes into options.strategyBriefSha256 (Job identity) and its location into the Job metadata, so resume stops with strategy-brief-changed-since-start if the file changed. With a channel it must be inside the channel's strategy work folder.",
          },
          harnessId: { type: "string", description: "Declared harness id. Omit only when want uniquely selects one harness." },
          want: { type: "string", description: "Natural-language capability request used only for deterministic harness selection when harnessId is omitted." },
          options: {
            type: "object",
            description: "Harness-specific non-secret JSON options (e.g. episodeId, protagonistSpeakerId, characterBiblePath, storyReviewPath). For koya-manga-video those four are required at start, even plan-only: they are part of the Job identity and cannot be added later, so start refuses with koya-start-options-missing (naming the missing ones) and creates no Job. Paths only: API keys, tokens, trusted/signing keys, private key material, credentials, and passwords are rejected, and so is any reviewerTrust* field and any reviewer key field (reviewerKeyPath, reviewerPrivateKeyPem, ...). The trust anchor comes only from the executing host's BUZZASSIST_REVIEWER_TRUST; the top-level reviewerTrustPath argument merely cross-checks it. Reviewer signoff is a separate reviewer-context step and never part of the production Job: run_koya_manga_pipeline action=signoff for koya-manga-video Jobs, signoff_video_harness_job for narrated-story-video Jobs (both take reviewerKeyPath as a file path). Script quality: options.scriptQualityWorkDir (optional, a path) names the script-quality-loop work folder; omitted, start fills in the script's folder. It is part of the Job identity, and from Koya production contract v56 / narrated audit contract v8 paid work waits for a human with script-quality-required:<reason> unless those exact script bytes passed that loop or were accepted with accept-human. Operator-made media for narrated-story-video: options.operatorImageManifestPath (image manifest, needed when the channel's images come from the operator) and options.operatorVideoManifestPath (per-episode opening video manifest); both are paths, part of the Job identity, and must be given at start.",
            additionalProperties: true,
          },
          reviewerTrustPath: REVIEWER_TRUST_PATH_PROPERTY,
          confirmed: { type: "boolean", default: false, description: "Set exactly true only after explicit approval to begin paid-capable execution. Omitted/false saves a plan only." },
          hostModel: HOST_MODEL_PROPERTY,
        },
        // channelPackPath は channelId が無いときに service が要求する（チャンネルなら台帳が決める）。
        required: ["scriptPath"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    {
      name: TOOL_GET_VIDEO_HARNESS_JOB,
      title: "Get Video Harness Job",
      description: "Read one durable video harness Job using the same service result schema as run, list, cancel, and resume.",
      inputSchema: {
        type: "object",
        properties: { projectDir: PROJECT_DIR_PROPERTY, jobId: JOB_ID_PROPERTY },
        required: ["jobId"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: TOOL_LIST_VIDEO_HARNESS_JOBS,
      title: "List Video Harness Jobs",
      description: "List durable video harness Jobs using the common service result schema. A damaged run does not hide other valid runs.",
      inputSchema: {
        type: "object",
        properties: { projectDir: PROJECT_DIR_PROPERTY },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: TOOL_CANCEL_VIDEO_HARNESS_JOB,
      title: "Cancel Video Harness Job",
      description: "Durably request cancellation and project the updated Job state to Canvas.",
      inputSchema: {
        type: "object",
        properties: { projectDir: PROJECT_DIR_PROPERTY, jobId: JOB_ID_PROPERTY },
        required: ["jobId"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: TOOL_RESUME_VIDEO_HARNESS_JOB,
      title: "Resume Video Harness Job",
      description: "Resume a durable Job through the common doctor and adapter path. A Job held in awaiting-human-review with pendingReceiptFinalization (e.g. blocker reviewer-trust-unconfigured after paid generation) retries only the RunReceipt finalization with the stored artifacts and Media Jobs; nothing is regenerated or re-billed. A failed Job is resumable: doctor re-runs, completed Media Jobs are reused by their recorded requestKey (never re-billed), Media Jobs in recovery-required go through the broker's recover first (blocker paid-media-recovery-pending until settled), and the Job plus RunReceipt record the resume-from-failed facts. Unrecoverable states (corrupt journal, missing workspace) still refuse. Because other resumes may invoke paid providers, confirmed=true is mandatory.",
      inputSchema: {
        type: "object",
        properties: {
          projectDir: PROJECT_DIR_PROPERTY,
          jobId: JOB_ID_PROPERTY,
          confirmed: { type: "boolean", description: "Must be exactly true after explicit approval for paid-capable execution." },
          reviewerTrustPath: REVIEWER_TRUST_PATH_PROPERTY,
          retryFailedImages: {
            type: "boolean",
            description: "Optional. Rebuild only the image rows the child ledger marks failed, inside the same Job (completed images are reused, not re-billed). This is execution context, not Job identity: the Job ID does not change. It bypasses the identity fingerprint for those rows, so the Job and the RunReceipt record the fact (imageRetry / imageSummary.retriedFailed: requested, jobIds, count, attempts = re-billing count, completed). Same as CLI resume --retry-failed-images. Default false.",
          },
          hostModel: HOST_MODEL_PROPERTY,
        },
        required: ["jobId", "confirmed"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    {
      name: TOOL_COLLECT_VIDEO_HARNESS_FEEDBACK,
      title: "Collect Video Harness Canvas Feedback",
      description: "Collect changed adoption, rejection, or comment fields from current BuzzAssist-owned Canvas elements and append ordinary self-improvement proposals. This never applies or promotes a proposal and accepts no secret or Channel Pack body input.",
      inputSchema: {
        type: "object",
        properties: { projectDir: PROJECT_DIR_PROPERTY, jobId: JOB_ID_PROPERTY },
        required: ["jobId"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: TOOL_SIGNOFF_VIDEO_HARNESS_JOB,
      title: "Sign Off Video Harness Job Review",
      description: "Independent-reviewer step for a durable narrated-story-video Job: runs the genre CLI's signoff (scripts/narrated-story-video.mjs signoff) with the same argument names as run_koya_manga_pipeline action=signoff, so Claude Code and Codex reach the identical entry the CLI offers. The reviewer task/session must differ from the production Job's context. Hashes the reviewed MP4 and contact sheet from disk, signs the subject with the Ed25519 private key read from reviewerKeyPath (file path only), requires that key to be active in the operator's trust list, and writes the signed signoff into the Job workspace. Never spends credits. koya-manga-video Jobs sign off through run_koya_manga_pipeline action=signoff instead and are refused here.",
      inputSchema: {
        type: "object",
        properties: {
          projectDir: PROJECT_DIR_PROPERTY,
          jobId: JOB_ID_PROPERTY,
          confirmed: CONFIRMED_REVIEWER_PROPERTY,
          reviewer: { type: "string", enum: ["claude", "codex"], description: "Reviewer host, as in the Koya signoff." },
          reviewerId: { type: "string", description: "Optional reviewer identity label." },
          reviewerContextId: { type: "string", description: "Reviewer task/session ID. Must differ from the generator context of the Job." },
          reviewerKeyPath: REVIEWER_KEY_PATH_PROPERTY,
          reviewerTrustPath: REVIEWER_TRUST_PATH_PROPERTY,
          videoPath: { type: "string", description: "Reviewed MP4 absolute path (defaults to the Job's final video)." },
          contactSheetPath: { type: "string", description: "Reviewed contact sheet PNG absolute path (defaults to the Job's contact sheet)." },
          signoffPath: { type: "string", description: "Optional absolute output path; defaults to review/contact-sheet-signoff.json in the Job workspace. Relative paths are refused (reviewer-path-not-absolute): they would resolve against the MCP server's cwd, i.e. the plugin directory." },
          reviewPath: { type: "string", description: "Absolute path to the reviewer's scoring JSON { rubricScores: { <criterion id>: 0-100 }, notes, findings } covering every criterion of the Job's review.quality rubric. The signed review becomes one round of the quality loop. Relative paths are refused (reviewer-path-not-absolute)." },
          force: { type: "boolean", description: "Overwrite an existing signoff file (a new round needs a new reviewerContextId)." },
          pass: { type: "boolean", description: "true approves (findings must be empty); false asks for changes (at least one finding in reviewPath). Only after the MP4 and contact sheet were actually inspected." },
        },
        required: ["jobId", "confirmed", "reviewer", "reviewerContextId", "reviewerKeyPath", "reviewPath", "pass"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    {
      name: TOOL_CREATE_VIDEO_HARNESS_REVIEWER_KEY,
      title: "Create Video Harness Reviewer Key",
      description: "Create a reviewer Ed25519 key pair through the shared genre CLI implementation (identical to scripts/koya-manga-video.mjs and scripts/narrated-story-video.mjs reviewer-key-create). Writes the private key with mode 0600 and the public key beside it, refuses to overwrite existing files, refuses paths inside this repository, the project dir, or any git working tree, and returns the keyId plus the trust-list entry (public key only) that the OPERATOR registers out of band in BUZZASSIST_REVIEWER_TRUST. The private key is never printed or returned. A reviewer key created by the same context that generates the video does not make an independent review.",
      inputSchema: {
        type: "object",
        properties: {
          projectDir: PROJECT_DIR_PROPERTY,
          confirmed: CONFIRMED_REVIEWER_PROPERTY,
          reviewerKeyPath: { type: "string", description: "Absolute FILE path outside any repository where the new private key is written (mode 0600). Never a key body." },
          reviewerPublicKeyPath: { type: "string", description: "Optional absolute public key output path; defaults to reviewerKeyPath + .pub. Relative paths are refused (reviewer-path-not-absolute)." },
          reviewerLabel: { type: "string", description: "Label stored in the returned trust entry." },
        },
        required: ["reviewerKeyPath", "confirmed"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
  ];
}

export function isVideoHarnessToolName(name) {
  return VIDEO_HARNESS_TOOL_NAMES.includes(name);
}

// ---- reviewer 工程（signoff / reviewer-key-create）の adapter ---------------------------------

// koyaMcpAdapter と同じ規則。鍵の中身らしい引数名／値は黙って捨てず拒否する
// （黙って捨てると「渡したのに効かない」と見え、鍵本体を argv に載せる回避策を誘発する）。
const KEY_MATERIAL_ARGUMENT = /(?:pem$|private[-_]?key|secrets?$|token$|password$|api[-_]?key$|(?:^|[a-z0-9])key$)/iu;
const KEY_MATERIAL_VALUE = /-----BEGIN [A-Z ]*(?:PRIVATE|PUBLIC) KEY-----|"reviewers"\s*:\s*\[/u;
const SIGNOFF_STRING_OPTIONS = Object.freeze([
  "reviewer", "reviewerId", "reviewerContextId", "reviewerKeyPath", "reviewerTrustPath",
  "reviewPath", "videoPath", "contactSheetPath", "signoffPath",
]);
// pass は true → --pass（承認）、false → --fail（差し戻し）として別に渡す。
const SIGNOFF_BOOLEAN_OPTIONS = Object.freeze(["force"]);
const KEY_CREATE_STRING_OPTIONS = Object.freeze(["reviewerKeyPath", "reviewerPublicKeyPath", "reviewerLabel"]);
const CHILD_OUTPUT_LIMIT = 16 * 1024 * 1024;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function kebab(value) {
  return value.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

function assertNoKeyMaterialArguments(args = {}) {
  for (const [name, value] of Object.entries(args || {})) {
    if (KEY_MATERIAL_ARGUMENT.test(name)) {
      throw new Error(`Video harness reviewer argument '${name}' looks like key material; pass reviewerKeyPath / reviewerTrustPath file paths only.`);
    }
    if (typeof value === "string" && KEY_MATERIAL_VALUE.test(value)) {
      throw new Error(`Video harness reviewer argument '${name}' contains key or trust-list material; pass a file path instead.`);
    }
  }
}

export const REVIEWER_PATH_NOT_ABSOLUTE_CODE = "reviewer-path-not-absolute";

/**
 * MCP 入口の path 引数は絶対 path だけを受ける（R6-F5）。
 *
 * MCP server の cwd は host が決める（配布 plugin では plugin ディレクトリ）。相対 path を
 * ここで resolve すると、reviewer 秘密鍵や signoff が plugin 配下（配布・同期・更新で
 * 差し替わる場所）へ書かれ、CLI から同じ相対 path を渡した場合と別の場所を指す。
 * 黙って resolve せず、理由コード付きで拒否する。
 */
function pathArgument(args, name, { required = false } = {}) {
  const value = args[name];
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${name} (an absolute FILE path) is required.`);
    return "";
  }
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a file path string.`);
  const trimmed = value.trim();
  if (!isAbsolute(trimmed)) {
    throw new Error(
      `${REVIEWER_PATH_NOT_ABSOLUTE_CODE}: ${name} must be an absolute path (got a relative path). `
      + "Relative paths would resolve against the MCP server's own working directory (the plugin directory), not the caller's; pass the full path.",
    );
  }
  return resolve(trimmed);
}

export const PROJECT_DIR_UNRESOLVED_CODE = "video-harness-project-dir-unresolved";

/**
 * Job の projectDir を決める（R5-REV-02）。
 *
 * service 層の既定値は server process の作業ディレクトリだが、MCP server の cwd は host が決め、
 * 配布 plugin では scripts/start-mcp.mjs が plugin ディレクトリへ chdir する。そこへ有料 Job の
 * durable 状態を作ると、次の setup/auto-update が staged tree に無い child を削除して証跡ごと消える。
 * だから MCP 入口では cwd に一切 fallback しない: 明示 projectDir（絶対 path 必須）→
 * server が roots/request meta から埋めた projectDir（同じ引数に入る）→ EXCALIDRAW_PROJECT_DIR
 * （setup 時の project）→ それも無ければ fail-closed。
 */
function resolveJobProjectDir(args, env = process.env) {
  const explicit = pathArgument(args, "projectDir");
  if (explicit) return explicit;
  const fromEnv = nonEmpty(env?.EXCALIDRAW_PROJECT_DIR);
  if (fromEnv && isAbsolute(fromEnv)) return resolve(fromEnv);
  throw new Error(
    `${PROJECT_DIR_UNRESOLVED_CODE}: projectDir could not be resolved (no absolute projectDir argument, no MCP workspace root, `
    + "and no absolute EXCALIDRAW_PROJECT_DIR). Refusing to fall back to the MCP server's working directory, which is the "
    + "distributed plugin directory and is replaced on setup/auto-update; pass the host project's absolute path as projectDir.",
  );
}

// 相対 path は projectDir 基準で解決する（cwd 基準にしない）。絶対 path はそのまま。
function projectRelativePath(args, name, projectDir) {
  const value = args[name];
  if (value === undefined || value === null || value === "") return value;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a file path string.`);
  const trimmed = value.trim();
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(projectDir, trimmed);
}

/**
 * production Job 系 tool（run / resume / get / list / cancel / collect-feedback）の引数正規化。
 * projectDir は必ず絶対 path で埋まり、scriptPath / channelPackPath は projectDir 基準、
 * reviewerTrustPath は reviewer 入口と同じく絶対 path のみ。service には正規化後だけを渡す。
 */
function normalizeJobArguments(args, env) {
  const projectDir = resolveJobProjectDir(args, env);
  const normalized = { ...args, projectDir };
  if ("scriptPath" in args) normalized.scriptPath = projectRelativePath(args, "scriptPath", projectDir);
  if ("channelPackPath" in args) normalized.channelPackPath = projectRelativePath(args, "channelPackPath", projectDir);
  if ("strategyBriefPath" in args) normalized.strategyBriefPath = projectRelativePath(args, "strategyBriefPath", projectDir);
  if (args.reviewerTrustPath !== undefined && args.reviewerTrustPath !== null && args.reviewerTrustPath !== "") {
    normalized.reviewerTrustPath = pathArgument(args, "reviewerTrustPath");
  }
  return normalized;
}

/**
 * plan_video_request の引数正規化。Job を作らないので、project が決まらなくても止めない
 * （その project の RunReceipt を読まないだけ）。ただし相対 path は project が決まらないと
 * どこを指すか分からないので拒否する——server の cwd（plugin ディレクトリ）基準にはしない。
 */
function normalizePlanArguments(args, env) {
  let projectDir = null;
  try {
    projectDir = resolveJobProjectDir(args, env);
  } catch (error) {
    if (!String(error?.message || "").startsWith(PROJECT_DIR_UNRESOLVED_CODE)) throw error;
  }
  const planPath = (name) => {
    const value = args[name];
    if (value === undefined || value === null || value === "") return "";
    if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a file path string.`);
    const trimmed = value.trim();
    if (isAbsolute(trimmed)) return resolve(trimmed);
    if (!projectDir) {
      throw new Error(`${REVIEWER_PATH_NOT_ABSOLUTE_CODE}: ${name} is relative but projectDir could not be resolved; pass an absolute path or projectDir.`);
    }
    return resolve(projectDir, trimmed);
  };
  if (args.options !== undefined && args.options !== null
    && (typeof args.options !== "object" || Array.isArray(args.options))) {
    throw new Error("options must be a JSON object.");
  }
  return {
    request: typeof args.request === "string" ? args.request : "",
    harnessId: nonEmpty(args.harnessId),
    projectDir,
    scriptPath: planPath("scriptPath"),
    channelPackPath: planPath("channelPackPath"),
    strategyBriefPath: planPath("strategyBriefPath"),
    channelId: nonEmpty(args.channelId),
    requestKind: nonEmpty(args.requestKind),
    options: args.options ?? {},
    checkPrerequisites: args.checkPrerequisites === true,
    env,
  };
}

/**
 * run_video_harness で channelId を渡し projectDir を省いたときは、チャンネルの台帳の projectDir を使う
 * （MCP の workspace root は台帳の作業フォルダと限らないので、root で埋めると channel-input-conflict になる）。
 */
async function withChannelProjectDir(args, env, loadRegistry) {
  if (!nonEmpty(args.channelId) || (args.projectDir !== undefined && args.projectDir !== null && args.projectDir !== "")) return args;
  const { findChannel } = await import("./channelRegistry.mjs");
  const channel = findChannel(await loadRegistry({ env }), args.channelId);
  return { ...args, projectDir: channel.projectDir };
}

async function defaultChannelRegistry({ env }) {
  const { loadRuntimeChannelRegistry } = await import("./channelStartGate.mjs");
  return loadRuntimeChannelRegistry({ env });
}

// 計画は呼ばれたときだけ読み込む（記録の集計・skill evals の読み取りを server の起動に載せない）。
async function defaultVideoRequestPlanner(args) {
  const { planVideoRequest } = await import("./videoRequestPlan.mjs");
  return planVideoRequest(args);
}

function parseCliJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* 末尾 object を探す */ }
  const starts = [...text.matchAll(/\{/gu)].map((match) => match.index).reverse();
  for (const start of starts) {
    try { return JSON.parse(text.slice(start)); } catch { /* 次 */ }
  }
  return null;
}

function assertNoKeyMaterialInOutput(value, what) {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(JSON.stringify(value ?? null))) {
    throw new Error(`${what} produced private key material; refusing to return it through MCP.`);
  }
}

function childFailure(label, error) {
  const stderr = redactSecrets(String(error?.stderr || "")).trim();
  const tail = stderr.slice(-2_000) || redactSecrets(String(error?.message || error));
  const failure = new Error(`${label} failed (${error?.code ?? "error"}): ${tail}`);
  failure.code = "REVIEWER_CLI_FAILED";
  return failure;
}

/**
 * reviewer 工程の実行器。テストと別 host は execFile / readJob / env を差し替えられる。
 * 引数は path と識別子だけを子 CLI の argv に写す。信頼リスト path は service 層と同じ規則で
 * 運営者 env と照合してから渡す（env 未設定なら明示 path があっても reviewer-trust-unconfigured）。
 */
export function createVideoHarnessReviewerActions({
  execFile = promisify(execFileCallback),
  readJob = readVideoHarnessJob,
  env = process.env,
  narratedCli = NARRATED_CLI,
} = {}) {
  async function run(command, argv, cwd, label) {
    let stdout;
    let stderr;
    try {
      ({ stdout, stderr } = await execFile(command, argv, { cwd, env, maxBuffer: CHILD_OUTPUT_LIMIT, windowsHide: true }));
    } catch (error) {
      throw childFailure(label, error);
    }
    const result = parseCliJson(stdout);
    assertNoKeyMaterialInOutput(result, label);
    return { result, stderr: redactSecrets(String(stderr || "")).trim() };
  }

  async function signoff(args = {}) {
    assertNoKeyMaterialArguments(args);
    if (args.confirmed !== true) {
      throw new Error("signoff_video_harness_job writes a signed review into the durable Job workspace; confirmed=true is required (same rule as run_koya_manga_pipeline).");
    }
    const jobId = nonEmpty(args.jobId);
    if (!jobId) throw new Error("signoff_video_harness_job requires jobId of the durable outer Job.");
    if (typeof args.pass !== "boolean") {
      throw new Error("Signoff requires pass=true (approve) or pass=false (ask for changes, with findings in reviewPath), after the MP4 and contact sheet have actually been inspected.");
    }
    const reviewerKeyPath = pathArgument(args, "reviewerKeyPath", { required: true });
    pathArgument(args, "reviewPath", { required: true });
    if (!nonEmpty(args.reviewer)) throw new Error("signoff requires reviewer (claude|codex).");
    if (!nonEmpty(args.reviewerContextId)) throw new Error("signoff requires reviewerContextId (the reviewer task/session, distinct from the production Job's context).");
    const reviewerTrustPath = pathArgument(args, "reviewerTrustPath");
    // 任意の path 引数も全て絶対 path（相対なら子 CLI を起動する前に拒否）。
    for (const name of SIGNOFF_STRING_OPTIONS) if (/Path$/u.test(name)) pathArgument(args, name);
    // projectDir は明示（絶対）→ EXCALIDRAW_PROJECT_DIR。server cwd（plugin ディレクトリ）には落とさない（R5-REV-02）。
    const projectDir = resolveJobProjectDir(args, env);
    await assertReviewerTrustPathAgreesWithOperator({ reviewerTrustPath, env });

    let job;
    try {
      job = await readJob({ projectDir, jobId });
    } catch (error) {
      throw new Error(`durable Video Harness Job ${jobId} could not be read (projectDir must be the project that created the Job): ${redactSecrets(String(error?.message || error))}`);
    }
    const harnessId = nonEmpty(job?.harness?.id);
    if (harnessId === KOYA_HARNESS_ID) {
      throw new Error(`Job ${jobId} is a ${KOYA_HARNESS_ID} Job: sign it off through run_koya_manga_pipeline action=signoff (episodeId, reviewNotesPath, reviewerKeyPath, reviewerContextId, pass). signoff_video_harness_job serves ${NARRATED_HARNESS_ID} Jobs.`);
    }
    if (harnessId !== NARRATED_HARNESS_ID) {
      throw new Error(`Job ${jobId} declares harness '${harnessId || "(empty)"}', which has no reviewer signoff entry here.`);
    }
    const route = resolveHarnessDeploymentCommand(job.deployment);
    const argv = [...route.args, "signoff", "--job-id", jobId, "--project-dir", projectDir];
    for (const name of SIGNOFF_STRING_OPTIONS) {
      const value = name === "reviewerKeyPath" ? reviewerKeyPath : name === "reviewerTrustPath" ? reviewerTrustPath : args[name];
      if (value === undefined || value === null || value === "") continue;
      if (typeof value !== "string") throw new Error(`${name} must be a string.`);
      argv.push(`--${kebab(name)}`, /Path$/u.test(name) ? resolve(value) : value);
    }
    for (const name of SIGNOFF_BOOLEAN_OPTIONS) if (args[name] === true) argv.push(`--${kebab(name)}`);
    argv.push(args.pass === true ? "--pass" : "--fail");
    const { result, stderr } = await run(route.command, argv, route.cwd, `${route.label} signoff`);
    return {
      ok: true,
      operation: "signoff",
      harnessId,
      jobId,
      projectDir,
      entrypoint: route.label,
      result,
      stderr,
    };
  }

  async function createReviewerKey(args = {}) {
    assertNoKeyMaterialArguments(args);
    if (args.confirmed !== true) {
      throw new Error("create_video_harness_reviewer_key writes a new private key file; confirmed=true is required (same rule as run_koya_manga_pipeline reviewer-key-create).");
    }
    const reviewerKeyPath = pathArgument(args, "reviewerKeyPath", { required: true });
    for (const name of KEY_CREATE_STRING_OPTIONS) if (/Path$/u.test(name)) pathArgument(args, name);
    const projectDir = resolveJobProjectDir(args, env);
    const argv = [narratedCli, "reviewer-key-create", "--reviewer-key-path", reviewerKeyPath, "--project-dir", projectDir];
    for (const name of KEY_CREATE_STRING_OPTIONS) {
      if (name === "reviewerKeyPath") continue;
      const value = /Path$/u.test(name) ? pathArgument(args, name) : args[name];
      if (value === undefined || value === null || value === "") continue;
      if (typeof value !== "string") throw new Error(`${name} must be a string.`);
      argv.push(`--${kebab(name)}`, /Path$/u.test(name) ? resolve(value) : value);
    }
    const { result, stderr } = await run(process.execPath, argv, REPO_ROOT, "reviewer-key-create");
    return { ok: true, operation: "reviewer-key-create", projectDir, result, stderr };
  }

  return Object.freeze({ signoff, createReviewerKey });
}

export const videoHarnessReviewerActions = createVideoHarnessReviewerActions();

function resultText(result) {
  if (result.operation === "plan-request") {
    return Array.isArray(result.summaryLines) ? result.summaryLines.join("\n") : "Video request plan.";
  }
  if (result.operation === "collect-feedback") {
    return `Canvas feedback for video harness Job ${result.jobId || "(unknown)"}: captured=${result.captured || 0}, duplicate=${result.duplicates || 0}, stale=${result.stale || 0}.`;
  }
  if (result.operation === "signoff") {
    return `Reviewer signoff written for ${result.harnessId} Job ${result.jobId} via ${result.entrypoint}; resume the Job so the finalizer and the common RunReceipt re-verify the signature against the operator's trust list.`;
  }
  if (result.operation === "reviewer-key-create") {
    return `Reviewer key ${result.result?.keyId || "(unknown)"} created at ${result.result?.privateKeyPath || "(unknown)"}; register result.trustEntry in the operator's BUZZASSIST_REVIEWER_TRUST list out of band. The private key was not returned.`;
  }
  if (result.operation === "list") return `${result.jobs.length} durable video harness Job(s).`;
  const id = result.jobId || "(unknown)";
  if (result.execution?.planOnly) return `Video harness Job ${id} planned; paid generation was not started.`;
  if (result.operation === "cancel") return `Cancellation requested for video harness Job ${id}; status=${result.status}.`;
  return `Video harness Job ${id}: status=${result.status}.`;
}

/**
 * run / resume を呼んだホスト。MCP の initialize で受けた clientInfo を先に見る
 * （lib/harnessHostProvenance.mjs）。hostModel は呼び出し側の宣言で、Job の識別子には入れない。
 */
function hostInvocationArguments(args, { clientInfo, env }) {
  const { hostModel, ...rest } = args;
  return { args: rest, invocation: detectHostInvocation({ via: "mcp", clientInfo, env, hostModel }) };
}

export async function handleVideoHarnessToolCall(params, {
  service = videoHarnessService,
  feedbackCollector = collectCanvasFeedback,
  reviewerActions = videoHarnessReviewerActions,
  planner = defaultVideoRequestPlanner,
  env = process.env,
  clientInfo = params?.clientInfo ?? null,
  channelRegistry = defaultChannelRegistry,
} = {}) {
  const args = params?.arguments ?? {};
  let result;
  switch (params?.name) {
    case TOOL_PLAN_VIDEO_REQUEST:
      result = await planner(normalizePlanArguments(args, env));
      break;
    // R5-REV-02: Job 系は service に渡す前に projectDir / path を正規化する。service の
    // cwd 既定値（配布 plugin では plugin ディレクトリ）へは決して落とさない。
    case TOOL_RUN_VIDEO_HARNESS: {
      const { args: startArgs, invocation } = hostInvocationArguments(args, { clientInfo, env });
      const channelArgs = await withChannelProjectDir(startArgs, env, channelRegistry);
      result = await service.start({ ...normalizeJobArguments(channelArgs, env), invocation });
      break;
    }
    case TOOL_GET_VIDEO_HARNESS_JOB:
      result = await service.get(normalizeJobArguments(args, env));
      break;
    case TOOL_LIST_VIDEO_HARNESS_JOBS:
      result = await service.list(normalizeJobArguments(args, env));
      break;
    case TOOL_CANCEL_VIDEO_HARNESS_JOB:
      result = await service.cancel(normalizeJobArguments(args, env));
      break;
    case TOOL_RESUME_VIDEO_HARNESS_JOB: {
      const { args: resumeArgs, invocation } = hostInvocationArguments(args, { clientInfo, env });
      result = await service.resume({ ...normalizeJobArguments(resumeArgs, env), invocation });
      break;
    }
    case TOOL_COLLECT_VIDEO_HARNESS_FEEDBACK:
      result = await feedbackCollector(normalizeJobArguments(args, env));
      break;
    case TOOL_SIGNOFF_VIDEO_HARNESS_JOB:
      result = await reviewerActions.signoff(args);
      break;
    case TOOL_CREATE_VIDEO_HARNESS_REVIEWER_KEY:
      result = await reviewerActions.createReviewerKey(args);
      break;
    default:
      return null;
  }
  return {
    content: [{ type: "text", text: resultText(result) }],
    structuredContent: result,
  };
}

export const _testing = Object.freeze({ assertNoKeyMaterialArguments, parseCliJson, normalizeJobArguments, normalizePlanArguments, resolveJobProjectDir });
