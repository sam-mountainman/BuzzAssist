// Durable Video Harness Job -> Canvas Run v1 の唯一の変換点。
// Canvas側へAPI key、doctor生ログ、台本以外の秘密を渡さない。

import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { collectCanvasFeedback } from "./canvasFeedbackCollector.mjs";
import { projectCanvasRun } from "./canvasRunProjection.mjs";
import {
  prepareCanvasRunMediaAssets,
  projectCanvasRunMedia,
} from "./canvasRunMediaProjection.mjs";

function safeId(value, fallback) {
  return String(value || fallback)
    .replace(/[^a-zA-Z0-9._:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 150) || fallback;
}

function sha(value) {
  const raw = String(value || "").replace(/^sha256:/u, "");
  return `sha256:${raw}`;
}

function canvasRunStatus(status) {
  if (["planned", "queued"].includes(status)) return "queued";
  if (["preflight-running", "running"].includes(status)) return "running";
  if (status === "awaiting-human-review") return "awaiting-approval";
  if (status === "completed") return "complete";
  if (["cancel-requested", "cancelled"].includes(status)) return "cancelled";
  return "failed";
}

function canvasJobStatus(status) {
  const mapping = {
    pending: "pending",
    queued: "queued",
    running: "running",
    pass: "complete",
    completed: "complete",
    complete: "complete",
    failed: "failed",
    "blocked-preflight": "failed",
    "awaiting-human-review": "awaiting-approval",
    cancelled: "cancelled",
    "cancel-requested": "cancelled",
  };
  return mapping[status] || "pending";
}

function canvasArtifactKind(kind, path = "") {
  const value = `${kind || ""} ${path || ""}`.toLowerCase();
  if (/contact.?sheet/u.test(value)) return "contact-sheet";
  if (/sign.?off|independent.?review|human.?review/u.test(value)) return "signoff";
  if (/final.*(?:video|mp4)|(?:video|mp4).*final/u.test(value)) return "final-mp4";
  if (/preview.*(?:video|mp4)|(?:video|mp4).*preview/u.test(value)) return "preview-mp4";
  if (/^(?:video|mp4)$/u.test(String(kind || "").toLowerCase()) || /\.mp4(?:\s|$)/u.test(value)) return "final-mp4";
  if (/audit|receipt|report/u.test(value)) return "audit-report";
  if (/subtitle|srt|vtt/u.test(value)) return "subtitle";
  if (/bgm/u.test(value)) return "bgm";
  if (/audio|voice|wav|mp3|m4a/u.test(value)) return "audio";
  if (/reference/u.test(value)) return "image-reference";
  if (/selected|approved/u.test(value)) return "image-selected";
  if (/image|png|jpe?g|webp/u.test(value)) return "image-candidate";
  return "other";
}

function providerVersions(job) {
  const rows = [
    ...(Array.isArray(job.mediaJobs) ? job.mediaJobs : []),
    ...(Array.isArray(job.adapterProbes) ? job.adapterProbes : []),
  ];
  const grouped = new Map();
  for (const row of rows) {
    const provider = String(row?.provider || "").trim();
    if (!provider) continue;
    const kind = String(row?.kind || "media").trim() || "media";
    const model = String(row?.model || "default").trim() || "default";
    const key = `${provider}\u001f${kind}\u001f${model}`;
    const incoming = {
      provider,
      kind,
      model,
      adapterVersion: String(row?.adapterVersion || "").trim(),
      providerVersion: String(row?.providerVersion || "").trim(),
      serverVersion: String(row?.serverVersion || "").trim(),
      adapterSha256: String(row?.adapterSha256 || "").replace(/^sha256:/iu, "").toLowerCase(),
    };
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, incoming);
      continue;
    }
    for (const field of ["adapterVersion", "providerVersion", "serverVersion", "adapterSha256"]) {
      if (current[field] && incoming[field] && current[field] !== incoming[field]) {
        throw new Error(`provider runtime identityが矛盾している: ${provider}/${kind}/${model}/${field}`);
      }
      if (!current[field] && incoming[field]) current[field] = incoming[field];
    }
  }
  const ids = new Set();
  return [...grouped.values()]
    .sort((left, right) => `${left.provider}\u001f${left.kind}\u001f${left.model}`.localeCompare(`${right.provider}\u001f${right.kind}\u001f${right.model}`))
    .map((row) => {
      const id = safeId(`${row.provider}:${row.kind}:${row.model}`, "provider");
      if (ids.has(id)) throw new Error(`provider runtime IDが衝突している: ${id}`);
      ids.add(id);
      const declaredDigest = /^[a-f0-9]{64}$/u.test(row.adapterSha256) ? row.adapterSha256 : "";
      const identityDigest = declaredDigest || createHash("sha256")
        .update(JSON.stringify({
          provider: row.provider,
          kind: row.kind,
          model: row.model,
          adapterVersion: row.adapterVersion,
          providerVersion: row.providerVersion,
          serverVersion: row.serverVersion,
        }))
        .digest("hex");
      return {
        id,
        version: row.adapterVersion || row.providerVersion || row.serverVersion || "runtime-identity-v1",
        sha256: sha(identityDigest),
        label: declaredDigest ? "adapter binary SHA-256" : "provider runtime identity SHA-256",
      };
    });
}

async function readVerifiedRunReceipt(job) {
  const candidates = (job.artifacts || []).filter((artifact) => String(artifact?.kind || "") === "run-receipt");
  if (candidates.length !== 1) {
    throw new Error("completed JobをCanvasへ投影するには共通run-receipt成果物がちょうど1件要る。");
  }
  const artifact = candidates[0];
  const digest = String(artifact.sha256 || "").replace(/^sha256:/iu, "").toLowerCase();
  if (!artifact.path || !/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error("run-receipt成果物にpath/SHA-256が無い。");
  }
  const path = resolve(artifact.path);
  const linkBefore = await lstat(path);
  if (linkBefore.isSymbolicLink() || !linkBefore.isFile()) {
    throw new Error("run-receipt成果物はsymlinkでない通常fileであること。");
  }
  const before = await stat(path);
  const bytes = await readFile(path);
  const after = await stat(path);
  const linkAfter = await lstat(path);
  if (linkAfter.isSymbolicLink()
    || before.dev !== after.dev || before.ino !== after.ino
    || before.size !== after.size || before.mtimeMs !== after.mtimeMs
    || linkBefore.dev !== linkAfter.dev || linkBefore.ino !== linkAfter.ino
    || bytes.length !== after.size) {
    throw new Error("run-receipt成果物が読取り中に変更された。");
  }
  if (createHash("sha256").update(bytes).digest("hex") !== digest) {
    throw new Error("run-receipt成果物のSHA-256が実fileと一致しない。");
  }
  if (artifact.bytes !== undefined && artifact.bytes !== null && Number(artifact.bytes) !== bytes.length) {
    throw new Error("run-receipt成果物のbytesが実file sizeと一致しない。");
  }
  let receipt;
  try {
    receipt = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("run-receipt成果物をJSONとして読めない。");
  }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || receipt.version !== "harness-run-receipt-v1"
    || receipt.finalized !== true || receipt.outcome !== "pass"
    || (Array.isArray(receipt.knownRemainingIssues) && receipt.knownRemainingIssues.length > 0)) {
    throw new Error("completed Jobのrun-receiptがfinalized passではない。");
  }
  if (String(receipt.harnessBuild?.harness?.id || "") !== String(job.harness?.id || "")) {
    throw new Error("run-receiptのHarness IDがJobと一致しない。");
  }
  const declarationDigest = String(receipt.harnessBuild?.harness?.declarationDigest || "").replace(/^sha256:/iu, "");
  const jobDeclarationDigest = String(job.harness?.declarationSha256 || "").replace(/^sha256:/iu, "");
  if (jobDeclarationDigest && declarationDigest !== jobDeclarationDigest) {
    throw new Error("run-receiptのHarness宣言SHAがJobと一致しない。");
  }
  const rosterKey = (row) => {
    const rowDigest = String(row?.sha256 || "").replace(/^sha256:/iu, "").toLowerCase();
    const rowBytes = row?.bytes === null || row?.bytes === undefined ? "" : String(Number(row.bytes));
    return `${String(row?.kind || "")}\u001f${rowDigest}\u001f${rowBytes}`;
  };
  const jobRoster = (job.artifacts || [])
    .filter((row) => String(row?.kind || "") !== "run-receipt")
    .map(rosterKey)
    .sort();
  const receiptRoster = (Array.isArray(receipt.artifacts) ? receipt.artifacts : [])
    .map(rosterKey)
    .sort();
  if (JSON.stringify(jobRoster) !== JSON.stringify(receiptRoster)) {
    throw new Error("run-receiptのartifact SHA rosterが現在のJob成果物と一致しない。");
  }
  return receipt;
}

async function verifiedSignoffs(job) {
  if (job.status !== "completed") return [];
  const receipt = await readVerifiedRunReceipt(job);
  const approvals = (Array.isArray(receipt.approvals) ? receipt.approvals : [])
    .filter((approval) => ["human", "independent-agent"].includes(approval?.type));
  if (approvals.length === 0) {
    throw new Error("completed Jobのrun-receiptに人間または独立agentのsignoff evidenceが無い。");
  }
  const ids = new Set();
  return approvals.map((approval, index) => {
    const evidenceDigest = String(approval.evidenceDigest || "").replace(/^sha256:/iu, "").toLowerCase();
    const reviewer = String(approval.reviewer || "").trim();
    const scope = String(approval.scope || "").trim();
    const decidedAt = String(approval.decidedAt || "").trim();
    if (!/^[a-f0-9]{64}$/u.test(evidenceDigest) || !reviewer || !scope || !Number.isFinite(Date.parse(decidedAt))) {
      throw new Error(`run-receipt approvals[${index}]のevidence/reviewer/scope/decidedAtが不正。`);
    }
    const id = safeId(`signoff-${createHash("sha256").update(`${approval.type}:${scope}:${reviewer}:${evidenceDigest}`).digest("hex").slice(0, 24)}`, `signoff-${index + 1}`);
    if (ids.has(id)) throw new Error("run-receiptのsignoff evidenceが重複している。");
    ids.add(id);
    return {
      id,
      title: approval.type === "human" ? `人間確認: ${scope}` : `独立レビュー: ${scope}`,
      status: "approved",
      evidenceSha256: `sha256:${evidenceDigest}`,
      reviewer,
      detail: approval.type,
    };
  });
}

export async function videoHarnessJobToCanvasRun(job) {
  if (!job?.id || !job?.script?.path || !job?.script?.sha256) throw new Error("Canvasへ投影できるVideo Harness Jobではない。");
  if (!job.channelPack?.sha256) throw new Error("Channel Pack指紋の無い本番JobをCanvasへ投影しない。");
  const scriptText = await readFile(job.script.path, "utf8");
  const stages = Array.isArray(job.stages) ? job.stages : [];
  const stageIds = new Set(stages.map((stage) => stage.id));
  const needs = (id) => {
    if (id === "production" && stageIds.has("doctor")) return ["doctor"];
    if (id === "audit" && stageIds.has("production")) return ["production"];
    if (id === "canvas-projection" && stageIds.has("audit")) return ["audit"];
    return [];
  };
  const artifacts = (job.artifacts || []).map((artifact, index) => ({
    id: safeId(artifact.id || `${artifact.kind || "artifact"}-${index + 1}`, `artifact-${index + 1}`),
    kind: canvasArtifactKind(artifact.kind, artifact.path),
    title: String(artifact.title || artifact.kind || `成果物 ${index + 1}`),
    status: "complete",
    sha256: sha(artifact.sha256),
    ...(artifact.mimeType ? { mimeType: String(artifact.mimeType) } : {}),
    ...(Number.isFinite(Number(artifact.durationSeconds)) ? { durationSeconds: Number(artifact.durationSeconds) } : {}),
  }));
  const auditArtifacts = artifacts.filter((artifact) => artifact.kind === "audit-report");
  const signoffs = await verifiedSignoffs(job);
  return {
    schemaVersion: 1,
    runId: job.id,
    revision: Number.isSafeInteger(job.revision) ? job.revision : 0,
    status: canvasRunStatus(job.status),
    title: String(job.options?.title || job.harness?.id || job.id),
    updatedAt: job.updatedAt || job.createdAt,
    script: {
      id: "input-script",
      title: "入力台本",
      language: "ja",
      text: scriptText,
      sha256: sha(job.script.sha256),
    },
    scenes: [],
    jobs: stages.map((stage) => ({
      id: safeId(stage.id, "stage"),
      title: String(stage.id),
      kind: stage.id,
      status: canvasJobStatus(stage.status),
      needs: needs(stage.id),
      ...(stage.evidence?.detail ? { detail: String(stage.evidence.detail) } : {}),
    })),
    artifacts,
    audits: auditArtifacts.map((artifact) => ({
      id: safeId(`audit-${artifact.id}`, "audit"),
      title: artifact.title,
      status: "complete",
      evidenceSha256: artifact.sha256,
    })),
    signoffs,
    knownRemainingIssues: (job.knownRemainingIssues || []).map(String),
    versions: {
      harness: {
        id: safeId(job.harness?.id, "harness"),
        version: String(job.harness?.declarationVersion || "content-sha"),
        sha256: sha(job.harness?.declarationSha256),
      },
      skills: (job.harness?.canonicalSkills || []).map((skill) => ({
        id: safeId(skill.id, "skill"),
        version: String(skill.version || "content-sha"),
        sha256: sha(skill.sha256),
      })),
      channelPack: {
        id: safeId(job.channelPack.id, "channel-pack"),
        version: String(job.channelPack.version || "content-sha"),
        sha256: sha(job.channelPack.sha256),
      },
      providers: providerVersions(job),
    },
  };
}

function canvasArtifactSources(job) {
  return (job.artifacts || []).map((artifact, index) => ({
    ...artifact,
    canvasArtifactId: safeId(
      artifact.id || `${artifact.kind || "artifact"}-${index + 1}`,
      `artifact-${index + 1}`,
    ),
  }));
}

export async function projectVideoHarnessJob(job, options = {}) {
  const {
    feedbackCollector = collectCanvasFeedback,
    feedbackCollectorOptions = {},
    mediaAssetPreparer = prepareCanvasRunMediaAssets,
    mediaProjector = projectCanvasRunMedia,
    mediaProjectionOptions = {},
    ...projectionOptions
  } = options;
  let feedbackCollection;
  if (projectionOptions.dryRun === true) {
    feedbackCollection = {
      version: "buzzassist-canvas-feedback-collection-v1",
      ok: true,
      operation: "collect-feedback",
      jobId: job.id,
      captured: 0,
      skippedReason: "dry-run",
    };
  } else {
    if (typeof feedbackCollector !== "function") throw new Error("Canvas feedback collectorが無い。");
    // 既存projectionを更新する前に読む。投影後では、削除されたentityのfeedbackを
    // tombstoneへ変えた後になり、ユーザーの採択・却下を失う。
    feedbackCollection = await feedbackCollector({
      projectDir: job.projectDir,
      job,
      ...feedbackCollectorOptions,
    });
  }
  const run = await videoHarnessJobToCanvasRun(job);
  if (typeof mediaAssetPreparer !== "function" || typeof mediaProjector !== "function") {
    throw new Error("Canvas media projectorが無い。");
  }
  // main Canvas stateをcompleteへ進める前に、実media bytesとSHAを検証・隔離する。
  const preparedAssets = await mediaAssetPreparer(
    { projectDir: job.projectDir },
    run,
    {
      ...mediaProjectionOptions,
      dryRun: projectionOptions.dryRun === true,
      sourceArtifacts: canvasArtifactSources(job),
    },
  );
  // 実mediaを先にcommitし、状態cardを最後に進める。逆順だとmedia投影が失敗した瞬間だけ
  // Canvas上のRunがcompleteなのに動画/音声が無い、という偽の完成表示になる。
  // media側はcontent-addressedかつ同revisionで冪等なので、state投影前に落ちても再実行できる。
  const mediaProjection = await mediaProjector(
    { projectDir: job.projectDir },
    run,
    {
      ...mediaProjectionOptions,
      dryRun: projectionOptions.dryRun === true,
      preparedAssets,
      allowRunStateLag: projectionOptions.dryRun !== true,
    },
  );
  const projected = await projectCanvasRun({ projectDir: job.projectDir }, run, projectionOptions);
  return { ...projected, feedbackCollection, mediaProjection };
}

export const _testing = Object.freeze({ canvasArtifactKind, canvasArtifactSources, canvasJobStatus, canvasRunStatus, providerVersions, readVerifiedRunReceipt, verifiedSignoffs });
