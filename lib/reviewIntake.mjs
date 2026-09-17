import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const MANIFEST_VERSION = "buzzassist-review-intake-v2";
const TURN_COVERAGE_VERSION = "buzzassist-user-turn-coverage-v1";
const SOURCE_FILTER_VERSION = "claude-user-turn-filter-v1";
const ALLOWED_STATUSES = new Set([
  "open",
  "implemented-unverified",
  "verified",
  "accepted-risk",
]);
const ALLOWED_DISPOSITIONS = new Set([
  "acknowledgement-only",
  "host-control-marker",
  "metadata-query",
  "operational-followup",
  "runtime-status-query",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function classifyClaudeUserRecord(row) {
  const content = row?.message?.content;
  if (row?.type !== "user" || row?.message?.role !== "user") return { eligible: false, reason: "not-user-role" };
  if (Array.isArray(content) && content.some((block) => block?.type === "tool_result")) {
    return { eligible: false, reason: "tool-result" };
  }
  if (row.isCompactSummary === true || row.isVisibleInTranscriptOnly === true) {
    return { eligible: false, reason: "compact-summary" };
  }
  if (row.origin?.kind === "task-notification") return { eligible: false, reason: "task-notification" };
  if (row.origin?.kind === "peer") return { eligible: false, reason: "peer-injection" };
  if (row.isMeta === true || row.sourceToolUseID || row.turnCompanion) {
    return { eligible: false, reason: "meta-companion" };
  }
  if (row.origin?.kind === "human" && typeof content === "string") {
    return { eligible: true, filterClass: "origin-human-string", visibleText: content };
  }
  if (!row.origin && Array.isArray(content) && content.length === 1
    && content[0]?.type === "text" && typeof content[0].text === "string") {
    return { eligible: true, filterClass: "plain-text-control", visibleText: content[0].text };
  }
  return { eligible: false, reason: "other-user-role-record" };
}

export function extractClaudeUserTurnOccurrences(text, { sourceId }) {
  assert(nonEmpty(sourceId), "Claude user-turn extraction requires a sourceId.");
  const occurrences = [];
  const excludedCounts = {};
  let userRoleRecords = 0;
  let sourceTurnOrdinal = 0;
  const lines = String(text).split(/\r?\n/u);
  for (const [index, rawLine] of lines.entries()) {
    if (!rawLine) continue;
    let row;
    try {
      row = JSON.parse(rawLine);
    } catch (error) {
      throw new Error(`review source ${sourceId} line ${index + 1} is not valid JSON: ${error.message}`);
    }
    if (row?.type !== "user" || row?.message?.role !== "user") continue;
    userRoleRecords += 1;
    const classified = classifyClaudeUserRecord(row);
    if (!classified.eligible) {
      excludedCounts[classified.reason] = (excludedCounts[classified.reason] || 0) + 1;
      continue;
    }
    sourceTurnOrdinal += 1;
    occurrences.push({
      sourceId,
      sourceTurnOrdinal,
      sourceLineNumber: index + 1,
      filterClass: classified.filterClass,
      contentSha256: sha256(Buffer.from(classified.visibleText, "utf8")),
      eventSha256: sha256(Buffer.from(rawLine, "utf8")),
    });
  }
  return {
    occurrences,
    stats: {
      userRoleRecords,
      eligibleTurnOccurrences: occurrences.length,
      uniqueContentHashes: new Set(occurrences.map((entry) => entry.contentSha256)).size,
      excludedCounts,
    },
  };
}

export function computeReviewCoverageDigest(coverage) {
  return sha256(Buffer.from(canonicalJson({
    version: coverage.version,
    sourceFilter: coverage.sourceFilter,
    measurement: coverage.measurement,
    turns: coverage.turns,
  }), "utf8"));
}

function validateCoverage({ manifest, findings }) {
  const coverage = manifest.userTurnCoverage;
  assert(coverage?.version === TURN_COVERAGE_VERSION,
    `review user-turn coverage must use ${TURN_COVERAGE_VERSION}.`);
  assert(coverage.sourceFilter?.version === SOURCE_FILTER_VERSION,
    `review source filter must use ${SOURCE_FILTER_VERSION}.`);
  assert(Array.isArray(coverage.turns) && coverage.turns.length > 0,
    "review user-turn coverage must contain turns.");
  assert(/^[a-f0-9]{64}$/u.test(coverage.coverageSha256 || ""),
    "review user-turn coverage has no coverage SHA-256.");
  assert(computeReviewCoverageDigest(coverage) === coverage.coverageSha256,
    "review user-turn coverage digest does not match its canonical rows.");

  const sessionSources = manifest.sources.filter((source) => source.kind === "claude-code-session-jsonl");
  const sessionSourceIds = new Set(sessionSources.map((source) => source.id));
  assert(sessionSourceIds.size > 0, "review user-turn coverage has no Claude session sources.");

  const findingIds = new Set(findings.map((finding) => finding.id));
  const referencedFindingIds = new Set();
  const turnIds = new Set();
  const contentHashes = new Set();
  const occurrenceKeys = new Set();
  const bySourceOrdinals = new Map();
  let occurrenceCount = 0;
  for (const turn of coverage.turns) {
    assert(nonEmpty(turn.id), "review user-turn coverage has a turn without id.");
    assert(!turnIds.has(turn.id), `duplicate review user-turn id ${turn.id}.`);
    turnIds.add(turn.id);
    assert(/^[a-f0-9]{64}$/u.test(turn.contentSha256 || ""), `review turn ${turn.id} has no content SHA-256.`);
    assert(!contentHashes.has(turn.contentSha256), `review turn content hash is duplicated: ${turn.contentSha256}.`);
    contentHashes.add(turn.contentSha256);
    for (const forbidden of ["content", "excerpt", "message", "path", "prompt", "rawText", "text"]) {
      assert(turn[forbidden] === undefined, `review turn ${turn.id} must not ship raw content or paths (${forbidden}).`);
    }
    assert(Array.isArray(turn.occurrences) && turn.occurrences.length > 0,
      `review turn ${turn.id} has no source occurrences.`);
    for (const occurrence of turn.occurrences) {
      assert(sessionSourceIds.has(occurrence.sourceId),
        `review turn ${turn.id} names non-session source ${occurrence.sourceId}.`);
      assert(Number.isInteger(occurrence.sourceTurnOrdinal) && occurrence.sourceTurnOrdinal > 0,
        `review turn ${turn.id} has invalid sourceTurnOrdinal.`);
      assert(Number.isInteger(occurrence.sourceLineNumber) && occurrence.sourceLineNumber > 0,
        `review turn ${turn.id} has invalid sourceLineNumber.`);
      assert(["origin-human-string", "plain-text-control"].includes(occurrence.filterClass),
        `review turn ${turn.id} has unsupported filterClass ${occurrence.filterClass}.`);
      assert(/^[a-f0-9]{64}$/u.test(occurrence.eventSha256 || ""),
        `review turn ${turn.id} has no event SHA-256.`);
      const key = `${occurrence.sourceId}:${occurrence.sourceTurnOrdinal}`;
      assert(!occurrenceKeys.has(key), `review user-turn occurrence is duplicated: ${key}.`);
      occurrenceKeys.add(key);
      const rows = bySourceOrdinals.get(occurrence.sourceId) || [];
      rows.push(occurrence.sourceTurnOrdinal);
      bySourceOrdinals.set(occurrence.sourceId, rows);
      occurrenceCount += 1;
    }

    const hasFindings = Array.isArray(turn.findingIds) && turn.findingIds.length > 0;
    const hasDisposition = Boolean(turn.disposition && typeof turn.disposition === "object");
    assert(hasFindings !== hasDisposition,
      `review turn ${turn.id} must have findingIds or exactly one disposition.`);
    if (hasFindings) {
      const local = new Set();
      for (const findingId of turn.findingIds) {
        assert(findingIds.has(findingId), `review turn ${turn.id} names unknown finding ${findingId}.`);
        assert(!local.has(findingId), `review turn ${turn.id} repeats finding ${findingId}.`);
        local.add(findingId);
        referencedFindingIds.add(findingId);
      }
    } else {
      assert(ALLOWED_DISPOSITIONS.has(turn.disposition.code),
        `review turn ${turn.id} has unsupported disposition ${turn.disposition.code}.`);
      assert(nonEmpty(turn.disposition.detail), `review turn ${turn.id} disposition has no detail.`);
    }
  }

  for (const source of sessionSources) {
    assert(source.turnFilterStats && typeof source.turnFilterStats === "object",
      `review session source ${source.id} has no turnFilterStats.`);
    const ordinals = (bySourceOrdinals.get(source.id) || []).sort((a, b) => a - b);
    assert(ordinals.length === source.turnFilterStats.eligibleTurnOccurrences,
      `review session source ${source.id} occurrence count does not match turnFilterStats.`);
    assert(ordinals.every((value, index) => value === index + 1),
      `review session source ${source.id} has an omitted or duplicate eligible turn ordinal.`);
  }
  const unreferencedFindings = [...findingIds].filter((id) => !referencedFindingIds.has(id));
  assert(unreferencedFindings.length === 0,
    `findings are not bound to any exact user turn: ${unreferencedFindings.join(", ")}.`);

  const measurement = coverage.measurement;
  assert(measurement?.findingIds === findings.length,
    "review coverage findingIds count does not match the findings ledger.");
  assert(measurement.eligibleTurnOccurrences === occurrenceCount,
    "review coverage eligible occurrence count does not match its turn rows.");
  assert(measurement.uniqueUserMessages === coverage.turns.length,
    "review coverage unique user message count does not match its turn rows.");
  assert(measurement.duplicateOccurrences === occurrenceCount - coverage.turns.length,
    "review coverage duplicate occurrence count is inconsistent.");
  assert(measurement.findingIdsAreNotUserMessages === true,
    "review coverage must explicitly distinguish finding IDs from user messages.");
  assert(nonEmpty(measurement.countExplanation), "review coverage has no count explanation.");

  const signoff = coverage.independentAgentSignoff;
  assert(["pending", "verified"].includes(signoff?.status),
    "review coverage independent-agent signoff must be pending or verified.");
  if (signoff.status === "pending") {
    for (const key of ["reviewerAgentId", "reviewedAt", "reviewedCoverageSha256", "verdict"]) {
      assert(signoff[key] === null, `pending review signoff must leave ${key} null.`);
    }
  } else {
    assert(nonEmpty(signoff.reviewerAgentId), "verified review signoff has no reviewerAgentId.");
    assert(nonEmpty(signoff.reviewedAt), "verified review signoff has no reviewedAt.");
    assert(signoff.reviewedCoverageSha256 === coverage.coverageSha256,
      "verified review signoff does not bind the current coverage digest.");
    assert(signoff.verdict === "pass", "verified review signoff verdict must be pass.");
  }

  return {
    uniqueUserMessages: coverage.turns.length,
    eligibleTurnOccurrences: occurrenceCount,
    duplicateOccurrences: occurrenceCount - coverage.turns.length,
    referencedFindingCount: referencedFindingIds.size,
    signoffStatus: signoff.status,
  };
}

export function parseFindingsJsonl(text) {
  const findings = [];
  for (const [index, rawLine] of String(text).split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let finding;
    try {
      finding = JSON.parse(line);
    } catch (error) {
      throw new Error(`findings line ${index + 1} is not valid JSON: ${error.message}`);
    }
    assert(nonEmpty(finding.id), `findings line ${index + 1} has no id.`);
    assert(nonEmpty(finding.round), `finding ${finding.id} has no round.`);
    assert(ALLOWED_STATUSES.has(finding.status),
      `finding ${finding.id} has unsupported status ${JSON.stringify(finding.status)}.`);
    findings.push(finding);
  }
  return findings;
}

export function validateReviewIntake({ manifest, findings }) {
  assert(manifest?.version === MANIFEST_VERSION,
    `review intake manifest must use ${MANIFEST_VERSION}.`);
  assert(Array.isArray(manifest.sources) && manifest.sources.length > 0,
    "review intake manifest must declare at least one source.");
  assert(Array.isArray(manifest.rounds) && manifest.rounds.length > 0,
    "review intake manifest must declare at least one round.");
  assert(manifest.policy?.rawSessionContentShipped === false,
    "review intake policy must prohibit shipping raw session content.");
  assert(manifest.policy?.machineLocalPathsShipped === false,
    "review intake policy must prohibit shipping machine-local paths.");

  const sourceIds = new Set();
  for (const source of manifest.sources) {
    assert(nonEmpty(source.id), "review intake source has no id.");
    assert(!sourceIds.has(source.id), `duplicate review intake source ${source.id}.`);
    sourceIds.add(source.id);
    assert(nonEmpty(source.kind), `review intake source ${source.id} has no kind.`);
    assert(/^[a-f0-9]{64}$/u.test(source.sha256 || ""),
      `review intake source ${source.id} has no SHA-256.`);
    assert(Number.isInteger(source.byteCount) && source.byteCount > 0,
      `review intake source ${source.id} has no byteCount.`);
    assert(!nonEmpty(source.path),
      `review intake source ${source.id} must not publish a machine-local path.`);
    if (source.kind === "claude-code-cross-session-workflow"
      && source.status === "completed" && source.synthesisPresent !== true) {
      assert(nonEmpty(source.acceptedIssueFindingId),
        `completed workflow ${source.id} without synthesis must name its omission finding.`);
    }
  }

  const byFindingId = new Map();
  for (const finding of findings) {
    const rows = byFindingId.get(finding.id) || [];
    rows.push(finding);
    byFindingId.set(finding.id, rows);
  }
  const duplicateFindingIds = [...byFindingId]
    .filter(([, rows]) => rows.length !== 1)
    .map(([id]) => id);
  assert(duplicateFindingIds.length === 0,
    `findings ledger contains duplicate ids: ${duplicateFindingIds.join(", ")}.`);

  const roundIds = new Set();
  const claimedFindingIds = new Map();
  for (const round of manifest.rounds) {
    assert(nonEmpty(round.id), "review intake round has no id.");
    assert(!roundIds.has(round.id), `duplicate review intake round ${round.id}.`);
    roundIds.add(round.id);
    assert(Array.isArray(round.sourceIds), `review intake round ${round.id} has no sourceIds.`);
    for (const sourceId of round.sourceIds) {
      assert(sourceIds.has(sourceId), `review intake round ${round.id} names unknown source ${sourceId}.`);
    }
    assert(Array.isArray(round.expectedFindingIds) && round.expectedFindingIds.length > 0,
      `review intake round ${round.id} has no expected findings.`);
    const local = new Set();
    for (const findingId of round.expectedFindingIds) {
      assert(nonEmpty(findingId), `review intake round ${round.id} has an empty finding id.`);
      assert(!local.has(findingId), `review intake round ${round.id} repeats ${findingId}.`);
      local.add(findingId);
      const priorRound = claimedFindingIds.get(findingId);
      assert(!priorRound,
        `finding ${findingId} is claimed by both ${priorRound} and ${round.id}.`);
      claimedFindingIds.set(findingId, round.id);
      const rows = byFindingId.get(findingId) || [];
      assert(rows.length === 1, `review intake expected finding ${findingId} exactly once; found ${rows.length}.`);
      assert(rows[0].round === round.id,
        `finding ${findingId} belongs to ${rows[0].round}, not manifest round ${round.id}.`);
    }
  }

  const unclaimed = findings
    .filter((finding) => !claimedFindingIds.has(finding.id))
    .map((finding) => finding.id);
  assert(unclaimed.length === 0,
    `findings ledger has entries missing from the intake manifest: ${unclaimed.join(", ")}.`);
  for (const source of manifest.sources) {
    if (nonEmpty(source.acceptedIssueFindingId)) {
      assert(claimedFindingIds.has(source.acceptedIssueFindingId),
        `review source ${source.id} names unknown omission finding ${source.acceptedIssueFindingId}.`);
    }
  }

  const coverage = validateCoverage({ manifest, findings });

  return {
    version: MANIFEST_VERSION,
    sourceCount: sourceIds.size,
    roundCount: roundIds.size,
    findingCount: findings.length,
    userTurnCoverage: coverage,
    statusCounts: findings.reduce((counts, finding) => {
      counts[finding.status] = (counts[finding.status] || 0) + 1;
      return counts;
    }, {}),
  };
}

export async function verifyReviewSourceFiles({ manifest, sourcePaths = {} }) {
  const results = [];
  for (const source of manifest.sources) {
    const candidate = sourcePaths[source.id];
    if (!candidate) {
      results.push({ id: source.id, available: false, verified: false });
      continue;
    }
    const bytes = await readFile(resolve(candidate));
    const actualSha256 = sha256(bytes);
    const actualByteCount = bytes.byteLength;
    assert(actualSha256 === source.sha256,
      `review source ${source.id} SHA mismatch for ${basename(candidate)}.`);
    assert(actualByteCount === source.byteCount,
      `review source ${source.id} byte count mismatch for ${basename(candidate)}.`);
    if (Number.isInteger(source.lineCount)) {
      const actualLineCount = bytes.toString("utf8").split(/\r?\n/u).filter(Boolean).length;
      assert(actualLineCount === source.lineCount,
        `review source ${source.id} line count mismatch for ${basename(candidate)}.`);
    }
    if (source.kind === "claude-code-cross-session-workflow") {
      const workflow = JSON.parse(bytes);
      assert(workflow.status === source.status,
        `review workflow ${source.id} status does not match the manifest.`);
      const synthesisPresent = workflow?.result?.synthesis != null;
      assert(synthesisPresent === source.synthesisPresent,
        `review workflow ${source.id} synthesis presence does not match the manifest.`);
    }
    let userTurnCoverageVerified = null;
    if (source.kind === "claude-code-session-jsonl") {
      const extracted = extractClaudeUserTurnOccurrences(bytes.toString("utf8"), { sourceId: source.id });
      assert(canonicalJson(extracted.stats) === canonicalJson(source.turnFilterStats),
        `review session ${source.id} turn-filter stats do not match the manifest.`);
      const expected = manifest.userTurnCoverage.turns
        .flatMap((turn) => turn.occurrences
          .filter((occurrence) => occurrence.sourceId === source.id)
          .map((occurrence) => ({ ...occurrence, contentSha256: turn.contentSha256 })))
        .sort((a, b) => a.sourceTurnOrdinal - b.sourceTurnOrdinal);
      assert(canonicalJson(extracted.occurrences) === canonicalJson(expected),
        `review session ${source.id} eligible user-turn coverage does not match the source bytes.`);
      userTurnCoverageVerified = true;
    }
    results.push({
      id: source.id,
      available: true,
      verified: true,
      sha256: actualSha256,
      byteCount: actualByteCount,
      ...(userTurnCoverageVerified == null ? {} : { userTurnCoverageVerified }),
    });
  }
  return results;
}

export async function loadAndValidateReviewIntake({ manifestPath, findingsPath, sourcePaths = {} }) {
  const [manifestBytes, findingsBytes] = await Promise.all([
    readFile(resolve(manifestPath)),
    readFile(resolve(findingsPath)),
  ]);
  const manifest = JSON.parse(manifestBytes);
  const findings = parseFindingsJsonl(findingsBytes);
  const ledger = validateReviewIntake({ manifest, findings });
  const sources = await verifyReviewSourceFiles({ manifest, sourcePaths });
  return {
    ...ledger,
    manifestSha256: sha256(manifestBytes),
    findingsSha256: sha256(findingsBytes),
    sources,
  };
}
