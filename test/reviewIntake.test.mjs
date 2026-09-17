import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  computeReviewCoverageDigest,
  extractClaudeUserTurnOccurrences,
  loadAndValidateReviewIntake,
  parseFindingsJsonl,
  validateReviewIntake,
} from "../lib/reviewIntake.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function sourceFixture() {
  const rows = [
    { type: "user", message: { role: "user", content: "alpha request" }, origin: { kind: "human" } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "private" }] } },
    { type: "user", message: { role: "user", content: "alpha request" }, origin: { kind: "human" } },
    { type: "user", message: { role: "user", content: "beta request" }, origin: { kind: "human" } },
    { type: "user", message: { role: "user", content: "peer" }, origin: { kind: "peer" } },
    { type: "user", message: { role: "user", content: "notification" }, origin: { kind: "task-notification" } },
    { type: "user", message: { role: "user", content: "summary" }, isCompactSummary: true },
    { type: "user", message: { role: "user", content: "companion" }, isMeta: true },
    { type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } },
  ];
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function refreshCoverageDigest(manifest) {
  manifest.userTurnCoverage.coverageSha256 = computeReviewCoverageDigest(manifest.userTurnCoverage);
}

function fixture() {
  const sourceText = sourceFixture();
  const extracted = extractClaudeUserTurnOccurrences(sourceText, { sourceId: "s1" });
  const byContent = new Map();
  for (const occurrence of extracted.occurrences) {
    const rows = byContent.get(occurrence.contentSha256) || [];
    rows.push(occurrence);
    byContent.set(occurrence.contentSha256, rows);
  }
  const [alpha, beta, control] = [...byContent.entries()];
  const manifest = {
    version: "buzzassist-review-intake-v2",
    policy: {
      rawSessionContentShipped: false,
      machineLocalPathsShipped: false,
    },
    sources: [{
      id: "s1",
      kind: "claude-code-session-jsonl",
      sha256: sha256(sourceText),
      byteCount: Buffer.byteLength(sourceText),
      lineCount: sourceText.trimEnd().split("\n").length,
      turnFilterStats: extracted.stats,
    }],
    rounds: [{ id: "r1", sourceIds: ["s1"], expectedFindingIds: ["f1", "f2"] }],
    userTurnCoverage: {
      version: "buzzassist-user-turn-coverage-v1",
      sourceFilter: {
        version: "claude-user-turn-filter-v1",
        included: ["human scalar content", "plain control"],
        excluded: ["tool and host metadata"],
        deduplicationKey: "exact UTF-8 visible-text SHA-256",
      },
      measurement: {
        userRoleRecords: extracted.stats.userRoleRecords,
        eligibleTurnOccurrences: extracted.stats.eligibleTurnOccurrences,
        uniqueUserMessages: extracted.stats.uniqueContentHashes,
        duplicateOccurrences: extracted.stats.eligibleTurnOccurrences - extracted.stats.uniqueContentHashes,
        findingIds: 2,
        findingIdsAreNotUserMessages: true,
        countExplanation: "findings and deduplicated messages are different measured domains",
      },
      turns: [
        { id: "ut-1", contentSha256: alpha[0], occurrences: alpha[1], findingIds: ["f1"] },
        { id: "ut-2", contentSha256: beta[0], occurrences: beta[1], findingIds: ["f2"] },
        {
          id: "ut-3",
          contentSha256: control[0],
          occurrences: control[1],
          disposition: { code: "host-control-marker", detail: "host control only" },
        },
      ],
      coverageSha256: "",
      independentAgentSignoff: {
        status: "pending",
        reviewerAgentId: null,
        reviewedAt: null,
        reviewedCoverageSha256: null,
        verdict: null,
      },
    },
  };
  refreshCoverageDigest(manifest);
  return {
    manifest,
    findings: [
      { id: "f1", round: "r1", status: "open" },
      { id: "f2", round: "r1", status: "implemented-unverified" },
    ],
    sourceText,
  };
}

test("review intake binds every finding and every exact user-turn occurrence", () => {
  const { manifest, findings } = fixture();
  assert.deepEqual(validateReviewIntake({ manifest, findings }), {
    version: "buzzassist-review-intake-v2",
    sourceCount: 1,
    roundCount: 1,
    findingCount: 2,
    userTurnCoverage: {
      uniqueUserMessages: 3,
      eligibleTurnOccurrences: 4,
      duplicateOccurrences: 1,
      referencedFindingCount: 2,
      signoffStatus: "pending",
    },
    statusCounts: { open: 1, "implemented-unverified": 1 },
  });
});

test("Claude source filter measures human/control turns and excludes tool/meta records", () => {
  const result = extractClaudeUserTurnOccurrences(sourceFixture(), { sourceId: "s1" });
  assert.deepEqual(result.stats, {
    userRoleRecords: 9,
    eligibleTurnOccurrences: 4,
    uniqueContentHashes: 3,
    excludedCounts: {
      "tool-result": 1,
      "peer-injection": 1,
      "task-notification": 1,
      "compact-summary": 1,
      "meta-companion": 1,
    },
  });
  assert.deepEqual(result.occurrences.map((row) => row.sourceTurnOrdinal), [1, 2, 3, 4]);
});

test("review intake rejects an omitted finding", () => {
  const { manifest, findings } = fixture();
  findings.push({ id: "f3", round: "r1", status: "open" });
  assert.throws(() => validateReviewIntake({ manifest, findings }), /missing from the intake manifest/u);
});

test("review intake rejects legacy or self-ambiguous status", () => {
  assert.throws(
    () => parseFindingsJsonl('{"id":"f1","round":"r1","status":"fixed"}\n'),
    /unsupported status/u,
  );
});

test("review intake source verification is exact, content-bound, and optional", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buzzassist-review-intake-"));
  const sourcePath = join(directory, "source.jsonl");
  const manifestPath = join(directory, "manifest.json");
  const findingsPath = join(directory, "findings.jsonl");
  const { manifest, findings, sourceText } = fixture();
  await writeFile(sourcePath, sourceText);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(findingsPath, `${findings.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const portable = await loadAndValidateReviewIntake({ manifestPath, findingsPath });
  assert.equal(portable.sources[0].available, false);
  const local = await loadAndValidateReviewIntake({
    manifestPath,
    findingsPath,
    sourcePaths: { s1: sourcePath },
  });
  assert.equal(local.sources[0].verified, true);
  assert.equal(local.sources[0].userTurnCoverageVerified, true);

  await writeFile(sourcePath, sourceText.replace("beta request", "mutated request"));
  await assert.rejects(
    loadAndValidateReviewIntake({ manifestPath, findingsPath, sourcePaths: { s1: sourcePath } }),
    /SHA mismatch/u,
  );
});

test("a completed workflow cannot hide a missing synthesis", () => {
  const { manifest, findings } = fixture();
  manifest.sources.push({
    id: "workflow",
    kind: "claude-code-cross-session-workflow",
    sha256: "a".repeat(64),
    byteCount: 1,
    status: "completed",
    synthesisPresent: false,
  });
  assert.throws(() => validateReviewIntake({ manifest, findings }), /must name its omission finding/u);
  manifest.sources.at(-1).acceptedIssueFindingId = "f1";
  assert.equal(validateReviewIntake({ manifest, findings }).findingCount, 2);
});

test("coverage digest and exact occurrence rows are immutable", () => {
  const { manifest, findings } = fixture();
  manifest.userTurnCoverage.turns[0].occurrences[0].eventSha256 = "0".repeat(64);
  assert.throws(() => validateReviewIntake({ manifest, findings }), /coverage digest does not match/u);

  refreshCoverageDigest(manifest);
  assert.equal(validateReviewIntake({ manifest, findings }).findingCount, 2);
});

test("every logical turn must map to findings or an explicit disposition", () => {
  const { manifest, findings } = fixture();
  delete manifest.userTurnCoverage.turns[1].findingIds;
  refreshCoverageDigest(manifest);
  assert.throws(() => validateReviewIntake({ manifest, findings }), /findingIds or exactly one disposition/u);
});

test("coverage rejects raw text/path fields and stale independent signoff", () => {
  const raw = fixture();
  raw.manifest.userTurnCoverage.turns[0].text = "must not ship";
  refreshCoverageDigest(raw.manifest);
  assert.throws(
    () => validateReviewIntake({ manifest: raw.manifest, findings: raw.findings }),
    /must not ship raw content or paths/u,
  );

  const stale = fixture();
  stale.manifest.userTurnCoverage.independentAgentSignoff = {
    status: "verified",
    reviewerAgentId: "independent-reviewer",
    reviewedAt: "2026-09-01T00:00:00.000Z",
    reviewedCoverageSha256: "0".repeat(64),
    verdict: "pass",
  };
  assert.throws(
    () => validateReviewIntake({ manifest: stale.manifest, findings: stale.findings }),
    /does not bind the current coverage digest/u,
  );
});

test("checked-in intake preserves the measured 46 findings versus 36 unique messages distinction", async () => {
  // 以前は 46 / 36 / 47 を固定値で assert していた。台帳はラウンドごとに
  // 増える設計なので、**正しく次のラウンドを登録した瞬間にこのテストが落ちた**
  // ——現状を仕様として固定する型。守りたいのは数そのものではなく、
  // (1) 9/1 に測った46件が失われず元のラウンドに属し続けること、
  // (2) finding 数と user message 数が1対1ではないことを区別し続けること、
  // (3) 全 finding がどれかの利用者発言に紐付いていること（散逸しない）。
  const [manifestText, findingsText] = await Promise.all([
    readFile(new URL("../docs/review/session-intake.manifest.json", import.meta.url), "utf8"),
    readFile(new URL("../docs/review/findings.jsonl", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const findings = parseFindingsJsonl(findingsText);
  const result = validateReviewIntake({ manifest, findings });

  // (1) 9/1 の測定は追記で増えても消えない。
  const measuredOn0901 = { "codex-2026-08-31": 23, "codex-2026-09-01": 14, "claude-session-intake-2026-09-01": 9 };
  for (const [roundId, count] of Object.entries(measuredOn0901)) {
    const round = manifest.rounds.find((entry) => entry.id === roundId);
    assert.ok(round, `9/1 に測ったラウンド ${roundId} が消えている`);
    assert.equal(round.expectedFindingIds.length, count, `${roundId} の件数が変わっている`);
  }
  assert.ok(result.findingCount >= 46, "9/1 の46件を下回ってはいけない");

  // (2) 数え方の区別。
  const coverage = result.userTurnCoverage;
  assert.equal(result.findingCount, findings.length, "台帳の全行を数えること");
  assert.equal(coverage.duplicateOccurrences, coverage.eligibleTurnOccurrences - coverage.uniqueUserMessages);
  assert.notEqual(result.findingCount, coverage.uniqueUserMessages,
    "finding 数と user message 数は別物（1発言から複数の指摘が出る）");
  assert.equal(manifest.userTurnCoverage.measurement.findingIdsAreNotUserMessages, true);

  // (3) 散逸しない: 全 finding が発言に紐付いている。
  assert.equal(coverage.referencedFindingCount, result.findingCount,
    "発言に紐付いていない finding がある（どの指摘から来たか追えない）");
  assert.equal(coverage.signoffStatus, "pending", "独立レビューを経ずに verified と書かないこと");
});
