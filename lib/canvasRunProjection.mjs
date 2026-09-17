import { generateKeyBetween } from "fractional-indexing";
import { withCanvasFileLock } from "./canvasFileLock.mjs";
import {
  normalizeScene,
  readJsonIfExists,
  resolveCanvasFile,
  writeJsonAtomic,
} from "./canvasScene.mjs";
import {
  CANVAS_RUN_SCHEMA_VERSION,
  canonicalJson,
  canvasRunFingerprint,
  normalizeCanvasRun,
  resolveCanvasRunStateFile,
  sha256Hex,
  stableCanvasRunId,
} from "./canvasRunState.mjs";

export const CANVAS_RUN_PROJECTION_VERSION = 1;
export const CANVAS_RUN_PROJECTION_TAG = "buzzassist.harnessRun.v1";

export class CanvasRunProjectionConflictError extends Error {
  constructor(message, { runId, storedRevision, incomingRevision } = {}) {
    super(message);
    this.name = "CanvasRunProjectionConflictError";
    this.runId = runId;
    this.storedRevision = storedRevision;
    this.incomingRevision = incomingRevision;
  }
}

const STATUS_COLORS = Object.freeze({
  pending: { fill: "#f1f3f5", stroke: "#868e96" },
  queued: { fill: "#e7f5ff", stroke: "#1c7ed6" },
  running: { fill: "#fff3bf", stroke: "#f08c00" },
  failed: { fill: "#ffe3e3", stroke: "#e03131" },
  "awaiting-approval": { fill: "#f3d9fa", stroke: "#9c36b5" },
  approved: { fill: "#d3f9d8", stroke: "#2b8a3e" },
  rejected: { fill: "#ffe3e3", stroke: "#c92a2a" },
  skipped: { fill: "#f1f3f5", stroke: "#868e96" },
  complete: { fill: "#d3f9d8", stroke: "#2f9e44" },
  cancelled: { fill: "#e9ecef", stroke: "#495057" },
});

const CARD_WIDTH = 300;
const CARD_HEIGHT = 116;
const ROW_GAP = 34;
const COLUMN_GAP = 100;
const HEADER_Y = 40;
const CONTENT_Y = 250;
const LEFT_X = 40;
const USER_FEEDBACK_FIELDS = Object.freeze([
  "buzzassistDecision",
  "buzzassistComment",
  "buzzassistFeedbackRevision",
]);

function deterministicInteger(seed, offset = 0) {
  return Number.parseInt(sha256Hex(`${seed}:${offset}`).slice(0, 8), 16) & 0x7fffffff;
}

function timestampForRun(run) {
  const parsed = run.updatedAt ? Date.parse(run.updatedAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : run.revision;
}

function statusColor(status) {
  return STATUS_COLORS[status] ?? STATUS_COLORS.pending;
}

function shortHash(value) {
  return String(value || "").replace(/^sha256:/u, "").slice(0, 12) || "—";
}

function truncate(value, length = 420) {
  const text = String(value || "").trim();
  return text.length <= length ? text : `${text.slice(0, Math.max(0, length - 1))}…`;
}

function artifactLink(artifact) {
  const candidate = artifact.canvasAssetUrl || artifact.uri || "";
  if (candidate.startsWith("/")) return candidate;
  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function jobDepths(jobs) {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const memo = new Map();
  const depth = (id) => {
    if (memo.has(id)) return memo.get(id);
    const value = Math.max(0, ...((byId.get(id)?.needs ?? []).map((dependency) => depth(dependency) + 1)));
    memo.set(id, value);
    return value;
  };
  jobs.forEach((job) => depth(job.id));
  return memo;
}

function makeBaseElement({ id, type, x, y, width, height, index, customData, link = null, run }) {
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: type === "rectangle" ? { type: 3 } : null,
    seed: deterministicInteger(id, 1),
    version: 1,
    versionNonce: deterministicInteger(id, 2),
    isDeleted: false,
    boundElements: null,
    updated: timestampForRun(run),
    link,
    locked: false,
    index,
    customData: { ...customData },
  };
}

function finalizeProjectionHash(element) {
  const {
    version: _version,
    versionNonce: _versionNonce,
    updated: _updated,
    index: _index,
    customData: rawCustomData,
    ...stable
  } = element;
  const { buzzassistProjectionHash: _oldHash, ...customData } = rawCustomData ?? {};
  element.customData = {
    ...rawCustomData,
    buzzassistProjectionHash: `sha256:${sha256Hex(canonicalJson({ ...stable, customData }))}`,
  };
  return element;
}

function makeCard({ run, logicalKind, logicalId, title, lines = [], status = "pending", x, y, width = CARD_WIDTH, height = CARD_HEIGHT, link = null }, sequence) {
  const cardId = stableCanvasRunId(run.runId, `${logicalKind}-card`, logicalId);
  const labelId = stableCanvasRunId(run.runId, `${logicalKind}-label`, logicalId);
  const groupId = stableCanvasRunId(run.runId, `${logicalKind}-group`, logicalId);
  const colors = statusColor(status);
  const commonCustomData = {
    [CANVAS_RUN_PROJECTION_TAG]: true,
    buzzassistHarnessRun: true,
    buzzassistRunId: run.runId,
    buzzassistRunRevision: run.revision,
    buzzassistRunFingerprint: canvasRunFingerprint(run),
    buzzassistEntityKind: logicalKind,
    buzzassistEntityId: logicalId,
    buzzassistStatus: status,
    buzzassistProjectionVersion: CANVAS_RUN_PROJECTION_VERSION,
    buzzassistCanvasRunSchemaVersion: CANVAS_RUN_SCHEMA_VERSION,
  };
  const card = makeBaseElement({
    id: cardId,
    type: "rectangle",
    x,
    y,
    width,
    height,
    index: sequence.next(),
    customData: commonCustomData,
    link,
    run,
  });
  card.strokeColor = colors.stroke;
  card.backgroundColor = colors.fill;
  card.groupIds = [groupId];
  card.boundElements = [{ type: "text", id: labelId }];

  const text = [title, ...lines].filter(Boolean).join("\n");
  const label = makeBaseElement({
    id: labelId,
    type: "text",
    x: x + 16,
    y: y + 14,
    width: width - 32,
    height: height - 28,
    index: sequence.next(),
    customData: commonCustomData,
    link,
    run,
  });
  label.strokeColor = "#212529";
  label.backgroundColor = "transparent";
  label.fillStyle = "hachure";
  label.strokeWidth = 1;
  label.groupIds = [groupId];
  label.fontSize = 16;
  label.fontFamily = 1;
  label.text = text;
  label.rawText = text;
  label.originalText = text;
  label.textAlign = "left";
  label.verticalAlign = "top";
  label.containerId = cardId;
  label.autoResize = false;
  label.lineHeight = 1.25;
  finalizeProjectionHash(card);
  finalizeProjectionHash(label);
  return { card, label, cardId };
}

function makeArrow({ run, logicalKind, logicalId, from, to }, sequence) {
  const id = stableCanvasRunId(run.runId, `${logicalKind}-edge`, logicalId);
  const start = { x: from.x + from.width, y: from.y + from.height / 2 };
  const end = { x: to.x, y: to.y + to.height / 2 };
  const width = end.x - start.x;
  const height = end.y - start.y;
  const customData = {
    [CANVAS_RUN_PROJECTION_TAG]: true,
    buzzassistHarnessRun: true,
    buzzassistRunId: run.runId,
    buzzassistRunRevision: run.revision,
    buzzassistRunFingerprint: canvasRunFingerprint(run),
    buzzassistEntityKind: logicalKind,
    buzzassistEntityId: logicalId,
    buzzassistProjectionVersion: CANVAS_RUN_PROJECTION_VERSION,
    buzzassistCanvasRunSchemaVersion: CANVAS_RUN_SCHEMA_VERSION,
  };
  const arrow = makeBaseElement({
    id,
    type: "arrow",
    x: start.x,
    y: start.y,
    width: Math.max(1, Math.abs(width)),
    height: Math.max(1, Math.abs(height)),
    index: sequence.next(),
    customData,
    run,
  });
  arrow.points = [[0, 0], [width, height]];
  arrow.startBinding = { elementId: from.id, focus: 0, gap: 4 };
  arrow.endBinding = { elementId: to.id, focus: 0, gap: 4 };
  arrow.startArrowhead = null;
  arrow.endArrowhead = "arrow";
  arrow.elbowed = false;
  arrow.strokeColor = "#868e96";
  arrow.strokeWidth = 1;
  return finalizeProjectionHash(arrow);
}

function indexSequence() {
  let previous = null;
  return {
    next() {
      previous = generateKeyBetween(previous, null);
      return previous;
    },
  };
}

function versionLines(run) {
  const descriptors = [
    ["Harness", run.versions.harness],
    ...run.versions.skills.map((skill) => ["Skill", skill]),
    ["Channel Pack", run.versions.channelPack],
    ...run.versions.providers.map((provider) => ["Provider", provider]),
  ];
  return descriptors.map(([kind, record]) => `${kind}: ${record.id}@${record.version} #${shortHash(record.sha256)}`);
}

function cardBounds(card) {
  return { id: card.id, x: card.x, y: card.y, width: card.width, height: card.height };
}

export function buildCanvasRunProjection(input) {
  const run = normalizeCanvasRun(input);
  const sequence = indexSequence();
  const elements = [];
  const bounds = new Map();
  const addCard = (spec) => {
    const result = makeCard({ run, ...spec }, sequence);
    elements.push(result.card, result.label);
    bounds.set(`${spec.logicalKind}:${spec.logicalId}`, cardBounds(result.card));
    return result;
  };

  addCard({
    logicalKind: "run",
    logicalId: run.runId,
    title: `Harness Run: ${run.title}`,
    lines: [`状態: ${run.status}`, `Run: ${run.runId} / rev ${run.revision}`, `#${shortHash(canvasRunFingerprint(run))}`],
    status: run.status,
    x: LEFT_X,
    y: HEADER_Y,
    width: 520,
    height: 148,
  });
  addCard({
    logicalKind: "versions",
    logicalId: "versions",
    title: "版・指紋",
    lines: versionLines(run),
    status: "complete",
    x: LEFT_X + 560,
    y: HEADER_Y,
    width: 650,
    height: Math.max(148, 48 + versionLines(run).length * 22),
  });

  addCard({
    logicalKind: "script",
    logicalId: run.script.id,
    title: run.script.title,
    lines: [`${run.script.language} / #${shortHash(run.script.sha256)}`, truncate(run.script.text || run.script.path || "本文はmanifest外")],
    status: "complete",
    x: LEFT_X,
    y: CONTENT_Y,
    width: 340,
    height: 190,
  });

  run.scenes.forEach((scene, index) => {
    addCard({
      logicalKind: "scene",
      logicalId: scene.id,
      title: `Scene/Cut ${scene.index + 1}: ${scene.title}`,
      lines: [`状態: ${scene.status}`, scene.jobIds.length ? `Jobs: ${scene.jobIds.join(", ")}` : "Jobs: —"],
      status: scene.status,
      x: LEFT_X + CARD_WIDTH + COLUMN_GAP,
      y: CONTENT_Y + index * (CARD_HEIGHT + ROW_GAP),
    });
  });

  const depths = jobDepths(run.jobs);
  const rowByDepth = new Map();
  const jobXStart = LEFT_X + (run.scenes.length ? 2 : 1) * (CARD_WIDTH + COLUMN_GAP);
  run.jobs.forEach((job) => {
    const depth = depths.get(job.id) ?? 0;
    const row = rowByDepth.get(depth) ?? 0;
    rowByDepth.set(depth, row + 1);
    addCard({
      logicalKind: "job",
      logicalId: job.id,
      title: job.title,
      lines: [
        `${job.kind} / ${job.status}`,
        job.progress === undefined ? "" : `進捗: ${Math.round(job.progress * 100)}%`,
        truncate(job.detail || "", 100),
      ],
      status: job.status,
      x: jobXStart + depth * (CARD_WIDTH + COLUMN_GAP),
      y: CONTENT_Y + row * (CARD_HEIGHT + ROW_GAP),
    });
  });

  const maxDepth = Math.max(0, ...depths.values());
  const artifactX = jobXStart + (run.jobs.length ? maxDepth + 1 : 0) * (CARD_WIDTH + COLUMN_GAP);
  run.artifacts.forEach((artifact, index) => {
    const result = addCard({
      logicalKind: "artifact",
      logicalId: artifact.id,
      title: artifact.title,
      lines: [
        `${artifact.kind} / ${artifact.status}`,
        `Artifact: ${artifact.stableId}`,
        `#${shortHash(artifact.sha256)}`,
        truncate(artifact.path || artifact.uri || artifact.canvasAssetUrl || "", 100),
      ],
      status: artifact.status,
      x: artifactX,
      y: CONTENT_Y + index * (CARD_HEIGHT + ROW_GAP),
      height: 142,
      link: artifactLink(artifact),
    });
    result.card.customData.buzzassistArtifactId = artifact.stableId;
    result.card.customData.buzzassistArtifactKind = artifact.kind;
    result.card.customData.buzzassistArtifactSha256 = artifact.sha256;
    result.label.customData.buzzassistArtifactId = artifact.stableId;
    result.label.customData.buzzassistArtifactKind = artifact.kind;
    result.label.customData.buzzassistArtifactSha256 = artifact.sha256;
    finalizeProjectionHash(result.card);
    finalizeProjectionHash(result.label);
  });

  const evidenceX = artifactX + (run.artifacts.length ? CARD_WIDTH + COLUMN_GAP : 0);
  let evidenceRow = 0;
  for (const [kind, records] of [["audit", run.audits], ["signoff", run.signoffs]]) {
    records.forEach((record) => {
      addCard({
        logicalKind: kind,
        logicalId: record.id,
        title: `${kind === "audit" ? "監査" : "独立レビュー"}: ${record.title}`,
        lines: [
          `状態: ${record.status}`,
          record.evidenceSha256 ? `証跡 #${shortHash(record.evidenceSha256)}` : "証跡: 未確定",
          record.reviewer ? `Reviewer: ${record.reviewer}` : "",
          truncate(record.detail || "", 100),
        ],
        status: record.status,
        x: evidenceX,
        y: CONTENT_Y + evidenceRow * (CARD_HEIGHT + ROW_GAP),
        height: 142,
      });
      evidenceRow += 1;
    });
  }

  if (run.knownRemainingIssues.length > 0) {
    addCard({
      logicalKind: "issues",
      logicalId: "known-remaining-issues",
      title: "knownRemainingIssues",
      lines: run.knownRemainingIssues.map((issue) => `• ${issue.text}`),
      status: "failed",
      x: evidenceX,
      y: CONTENT_Y + evidenceRow * (CARD_HEIGHT + ROW_GAP),
      width: 420,
      height: Math.max(116, 58 + run.knownRemainingIssues.length * 24),
    });
  }

  const arrows = [];
  for (const job of run.jobs) {
    const to = bounds.get(`job:${job.id}`);
    for (const dependency of job.needs) {
      const from = bounds.get(`job:${dependency}`);
      if (from && to) arrows.push(makeArrow({ run, logicalKind: "job-dependency", logicalId: `${dependency}->${job.id}`, from, to }, sequence));
    }
  }
  for (const scene of run.scenes) {
    const from = bounds.get(`scene:${scene.id}`);
    for (const jobId of scene.jobIds) {
      const to = bounds.get(`job:${jobId}`);
      if (from && to) arrows.push(makeArrow({ run, logicalKind: "scene-job", logicalId: `${scene.id}->${jobId}`, from, to }, sequence));
    }
  }
  for (const artifact of run.artifacts) {
    if (!artifact.producerJobId) continue;
    const from = bounds.get(`job:${artifact.producerJobId}`);
    const to = bounds.get(`artifact:${artifact.id}`);
    if (from && to) arrows.push(makeArrow({ run, logicalKind: "job-artifact", logicalId: `${artifact.producerJobId}->${artifact.id}`, from, to }, sequence));
  }
  elements.push(...arrows);

  return {
    schemaVersion: CANVAS_RUN_SCHEMA_VERSION,
    projectionVersion: CANVAS_RUN_PROJECTION_VERSION,
    run,
    runFingerprint: canvasRunFingerprint(run),
    elements,
  };
}

function projectionOwnedByRun(element, runId) {
  return element?.customData?.[CANVAS_RUN_PROJECTION_TAG] === true
    && element?.customData?.buzzassistRunId === runId;
}

function preserveUserFeedback(existing, desired) {
  const existingData = existing?.customData ?? {};
  const customData = { ...(desired.customData ?? {}) };
  for (const field of USER_FEEDBACK_FIELDS) {
    if (existingData[field] !== undefined) customData[field] = existingData[field];
  }
  return { ...desired, customData };
}

function nextProjectedElement(existing, desired, run) {
  if (!existing) return desired;
  const sameProjection = existing.customData?.buzzassistProjectionHash === desired.customData?.buzzassistProjectionHash;
  if (sameProjection && existing.isDeleted !== true) return existing;
  const nextVersion = Math.max(1, Number(existing.version) || 1) + 1;
  const next = preserveUserFeedback(existing, desired);
  return {
    ...next,
    version: nextVersion,
    versionNonce: deterministicInteger(`${next.id}:${next.customData.buzzassistProjectionHash}`, nextVersion),
    updated: timestampForRun(run),
    isDeleted: false,
    index: existing.index ?? next.index,
  };
}

function tombstoneElement(element, run) {
  if (element.isDeleted === true) return element;
  const nextVersion = Math.max(1, Number(element.version) || 1) + 1;
  return {
    ...element,
    version: nextVersion,
    versionNonce: deterministicInteger(`${element.id}:deleted`, nextVersion),
    updated: timestampForRun(run),
    isDeleted: true,
  };
}

export function reconcileCanvasRunProjection(sceneValue, projection) {
  const scene = normalizeScene(sceneValue);
  const desiredById = new Map(projection.elements.map((element) => [element.id, element]));
  const existingById = new Map(scene.elements.map((element) => [element.id, element]));
  const statistics = { added: 0, updated: 0, unchanged: 0, removed: 0 };
  const nextElements = [];

  for (const element of scene.elements) {
    const desired = desiredById.get(element.id);
    if (desired) {
      const next = nextProjectedElement(element, desired, projection.run);
      nextElements.push(next);
      desiredById.delete(element.id);
      if (next === element) statistics.unchanged += 1;
      else statistics.updated += 1;
      continue;
    }
    if (projectionOwnedByRun(element, projection.run.runId)) {
      const next = tombstoneElement(element, projection.run);
      nextElements.push(next);
      if (next === element) statistics.unchanged += 1;
      else statistics.removed += 1;
      continue;
    }
    nextElements.push(element);
  }

  for (const desired of desiredById.values()) {
    if (existingById.has(desired.id)) continue;
    nextElements.push(desired);
    statistics.added += 1;
  }

  return {
    scene: {
      ...scene,
      elements: nextElements,
      appState: { ...scene.appState },
      files: { ...scene.files },
    },
    statistics,
  };
}

function validateProjectionRevision(storedValue, projection) {
  if (!storedValue) return null;
  const { runFingerprint: recordedFingerprint, ...storedRunValue } = storedValue;
  const storedRun = normalizeCanvasRun(storedRunValue);
  const actualFingerprint = canvasRunFingerprint(storedRun);
  if (recordedFingerprint && recordedFingerprint !== actualFingerprint) {
    throw new CanvasRunProjectionConflictError(
      `保存済みCanvas Runのfingerprintが一致しない: ${projection.run.runId}`,
      {
        runId: projection.run.runId,
        storedRevision: storedRun.revision,
        incomingRevision: projection.run.revision,
      },
    );
  }
  if (storedRun.runId !== projection.run.runId) {
    throw new CanvasRunProjectionConflictError(
      `Canvas Run stateのrunIdが一致しない: ${storedRun.runId} != ${projection.run.runId}`,
      {
        runId: projection.run.runId,
        storedRevision: storedRun.revision,
        incomingRevision: projection.run.revision,
      },
    );
  }
  if (projection.run.revision < storedRun.revision) {
    throw new CanvasRunProjectionConflictError(
      `古いCanvas Run revisionは投影できない: ${projection.run.revision} < ${storedRun.revision}`,
      {
        runId: projection.run.runId,
        storedRevision: storedRun.revision,
        incomingRevision: projection.run.revision,
      },
    );
  }
  if (projection.run.revision === storedRun.revision && projection.runFingerprint !== actualFingerprint) {
    throw new CanvasRunProjectionConflictError(
      `同じCanvas Run revisionに異なる内容は投影できない: ${projection.run.revision}`,
      {
        runId: projection.run.runId,
        storedRevision: storedRun.revision,
        incomingRevision: projection.run.revision,
      },
    );
  }
  return { run: storedRun, runFingerprint: actualFingerprint };
}

export async function projectCanvasRun(args = {}, input, options = {}) {
  const projection = buildCanvasRunProjection(input);
  const canvasFile = resolveCanvasFile(args);
  const stateFile = resolveCanvasRunStateFile(args, projection.run.runId);
  if (options.dryRun === true) {
    validateProjectionRevision(await readJsonIfExists(stateFile, null), projection);
    const current = normalizeScene(await readJsonIfExists(canvasFile, null));
    const reconciled = reconcileCanvasRunProjection(current, projection);
    return { ...reconciled.statistics, projection, canvasFile, stateFile, dryRun: true };
  }

  return withCanvasFileLock(stateFile, async () => {
    // state lock内で必ず読み直す。lock前に読んだrevisionは別processの投影後には古い。
    validateProjectionRevision(await readJsonIfExists(stateFile, null), projection);
    const statistics = await withCanvasFileLock(canvasFile, async () => {
      const current = normalizeScene(await readJsonIfExists(canvasFile, null));
      const reconciled = reconcileCanvasRunProjection(current, projection);
      await writeJsonAtomic(canvasFile, reconciled.scene);
      return reconciled.statistics;
    });
    await writeJsonAtomic(stateFile, { ...projection.run, runFingerprint: projection.runFingerprint });
    return { ...statistics, projection, canvasFile, stateFile, dryRun: false };
  });
}

export const _testing = Object.freeze({ validateProjectionRevision });
