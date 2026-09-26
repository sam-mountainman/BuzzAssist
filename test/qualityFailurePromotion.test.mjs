import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CHANNEL_REGISTRY_PATH_ENV } from "../lib/channelRegistry.mjs";
import { childAgentEnvironment } from "../lib/harnessLearningGuard.mjs";
import { inspectLearningText } from "../lib/harnessLearningInspection.mjs";
import { HARNESS_LEARNING_ROUTES, SCRIPT_LEARNING_ROUTES } from "../lib/harnessLearningTargets.mjs";
import { createNarratedQualityContract } from "../lib/narratedStoryQualityLoop.mjs";
import {
  AUTO_FAILURE_PROMOTION_CREATOR,
  AUTO_FAILURE_PROMOTION_SOURCE,
  autoPromoteQualityLoopFailures,
  classifyFailureBlastRadius,
  describeQualityLoopState,
  failureDetectability,
  failurePromotionCandidates,
  failurePromotionHistoryFromRows,
  failurePromotionKey,
  failurePromotionText,
  findQualityLoopStateFiles,
  groupQualityLoopFailures,
  nextPromotionRung,
  promoteRecurringQualityFailures,
  qualityLoopFailureOccurrences,
} from "../lib/qualityFailurePromotion.mjs";
import { normalizeFailurePromotionMetadata } from "../lib/qualityFailurePromotionShape.mjs";
import { createQualityLoopState, recordQualityRound } from "../lib/qualityLoop.mjs";
import { captureLearningProposal, normalizeProposalMetadata } from "../scripts/harness-learn.mjs";
import { parsePromoteFailuresArgs } from "../scripts/harness-promote-failures.mjs";

// 状態の中身（所見・対象の id・人の名前）はすべて合成の値。本文へ運ばれないことを確かめるために置く。
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (value) => createHash("sha256").update(String(value)).digest("hex");
const SUBJECT = "synthetic-person-zeta";
const NOTES = "合成の所見: 架空の人物の左手の指が六本に見える";
const SCRIPT_TARGET = SCRIPT_LEARNING_ROUTES["narrated-story"];
const NARRATED_TARGET = HARNESS_LEARNING_ROUTES["narrated-story-video"].channel;
const NO_CHANNEL = async () => ({ channelId: "", selectedBy: null });
const NO_HISTORY = () => new Map();

function captureHarness() {
  const rows = [];
  return {
    rows,
    options: {
      signals: { terms: [], castIds: [] },
      privateVocabulary: null,
      homeRoot: "",
      env: {},
      ledgerPathResolver: (target, kind) => join(tmpdir(), "synthetic-promotion-ledger", String(target).replace(/[^a-z0-9-]/gu, "_"), `${kind}.jsonl`),
      append: (_file, entry) => rows.push(entry),
      read: () => rows,
      lock: (_file, action) => action(),
      refreshCatalog: () => ({ written: false }),
    },
  };
}

function round(index, { gates = [], floors = [], fingerprint = "", artifact = "", observedAt = "", extra = {} } = {}) {
  return {
    index,
    failedGateIds: gates,
    floorFailures: floors,
    failureFingerprint: fingerprint || (gates.length || floors.length ? `quality-failure:${sha(`${index}`).slice(0, 24)}` : ""),
    ...(artifact ? { artifactSha256: artifact } : {}),
    reviews: [{ evaluatorId: "synthetic-reviewer-name", notes: NOTES }],
    evidence: [],
    observedAt: observedAt || `2026-09-2${index}T00:00:00.000Z`,
    ...extra,
  };
}

function scriptState({ rounds, versions = [], history = [], status = "needs-human-approval" } = {}) {
  return {
    status,
    stopReason: status === "active" ? "" : "round-limit",
    contractDigest: sha("script-contract"),
    startedAt: "2026-09-20T00:00:00.000Z",
    rounds,
    script: { genre: "narrated-story", versions, history },
  };
}

function assetState({ rounds, versions = [], humanVerifications = [], stage = "character" } = {}) {
  return {
    status: "active",
    stopReason: "",
    contractDigest: sha("asset-contract"),
    startedAt: "2026-09-20T00:00:00.000Z",
    rounds,
    asset: { harnessId: "narrated-story-video", stage, subjectId: SUBJECT, versions, humanVerifications, history: [] },
  };
}

function groupsOf(state) {
  const description = describeQualityLoopState(state);
  return groupQualityLoopFailures([{ description, occurrences: qualityLoopFailureOccurrences(state, description) }]);
}

test("状態ファイルの形からループの種類と宛先を決める（漫画の最終ループは読まない）", () => {
  assert.equal(describeQualityLoopState(scriptState({ rounds: [] })).target, SCRIPT_TARGET);
  const asset = describeQualityLoopState(assetState({ rounds: [] }));
  assert.equal(asset.loop, "asset");
  assert.equal(asset.target, NARRATED_TARGET);
  assert.deepEqual(asset.humanChecks, ["identity", "hand-safety"]);
  const brief = describeQualityLoopState({
    rounds: [],
    strategy: { versions: [{ harnessId: "explainer-video" }], history: [] },
  });
  assert.equal(brief.loop, "strategy-brief");
  assert.equal(brief.target, HARNESS_LEARNING_ROUTES["explainer-video"].channel);
  // ハーネスの書かれていないブリーフからは宛先を推測しない。
  assert.equal(describeQualityLoopState({ rounds: [], strategy: { versions: [], history: [] } }).skippedReason, "unknown-strategy-brief-harness");
  assert.equal(describeQualityLoopState({ rounds: [], episodeId: `video-narrated-story-video-${"a".repeat(16)}` }).loop, "signed-review");
  // 漫画は事故台帳（recordMangaQualityIncident）で先に格上げしているので、ここでは読まない。
  assert.equal(describeQualityLoopState({ rounds: [], episodeId: `video-koya-manga-video-${"a".repeat(16)}` }).skippedReason, "unknown-quality-loop");
  assert.equal(describeQualityLoopState({ status: "active" }).skippedReason, "not-a-quality-loop-state");
});

test("同じ成果物を採点し直した回は1回に数え、別の版で2回出た失敗だけを上げる", () => {
  const sameArtifact = sha("script-v1");
  const once = scriptState({
    rounds: [
      round(1, { floors: ["beat-structure"], artifact: sameArtifact }),
      round(2, { floors: ["beat-structure"], artifact: sameArtifact }),
    ],
  });
  const heldOnly = failurePromotionCandidates({ groups: groupsOf(once) });
  assert.equal(heldOnly.candidates.length, 0);
  assert.equal(heldOnly.held[0].heldReason, "below-threshold");
  assert.equal(heldOnly.held[0].occurrences, 1);

  const twice = scriptState({
    rounds: [
      round(1, { floors: ["beat-structure"], artifact: sha("script-v1") }),
      round(2, { floors: ["beat-structure"], artifact: sha("script-v2") }),
    ],
  });
  const { candidates } = failurePromotionCandidates({ groups: groupsOf(twice) });
  assert.equal(candidates.length, 1);
  const [candidate] = candidates;
  assert.equal(candidate.target, SCRIPT_TARGET);
  assert.equal(candidate.failureKind, "floor");
  assert.equal(candidate.failureId, "beat-structure");
  assert.equal(candidate.occurrences, 2);
  assert.deepEqual(candidate.versions, [sha("script-v1").slice(0, 12), sha("script-v2").slice(0, 12)]);
  assert.equal(candidate.blastRadius, "normal");
  assert.equal(candidate.detectable, "unknown");
  assert.equal(candidate.currentRung, "verbal");
  assert.equal(candidate.nextRung, "gotcha");
  assert.equal(candidate.reason, "recurrence");
  assert.match(candidate.text, /^\[失敗の格上げ\] 台本の品質ループ（narrated-story）で、評価項目 beat-structure の下限割れが別の版で繰り返し出た/u);
  // 本文に件数・版・所見・評価者の名前は入れない（同じ失敗・同じ段なら同じ本文）。
  for (const forbidden of ["2 回", sha("script-v1").slice(0, 12), "合成の所見", "synthetic-reviewer-name"]) {
    assert.equal(candidate.text.includes(forbidden), false, `本文に ${forbidden} が入った`);
  }
  assert.match(candidate.evidence, /^auto-failure-promotion-v1 source=quality-loop-state loop=script scope=narrated-story stage=- kind=floor occurrences=2 /u);
});

test("機械で判定できる評価項目は注意書きを飛ばして検査スクリプトへ、判定できないものは注意書きへ", () => {
  const measurable = scriptState({
    rounds: [
      round(1, { floors: ["duration-fit"], artifact: sha("a1") }),
      round(2, { floors: ["duration-fit", "meaning-preservation"], artifact: sha("a2") }),
      round(3, { floors: ["meaning-preservation"], artifact: sha("a3") }),
    ],
  });
  const byId = Object.fromEntries(failurePromotionCandidates({ groups: groupsOf(measurable) }).candidates.map((row) => [row.failureId, row]));
  assert.equal(byId["duration-fit"].detectable, "yes");
  assert.equal(byId["duration-fit"].nextRung, "script");
  assert.match(byId["duration-fit"].text, /上げたら同じ中身の注意書きは消す/u);
  assert.equal(byId["meaning-preservation"].detectable, "no");
  assert.equal(byId["meaning-preservation"].nextRung, "gotcha");
});

test("どの段・どの種類の本文も、書き込み前の検査（注入らしい言い回し・パス等）に当たらない", () => {
  const kinds = [
    { kind: "gate", id: "asset-readable" },
    { kind: "floor", id: "beat-structure" },
    { kind: "human-check", id: "identity" },
    { kind: "blocking", id: "cost-unit-conflict" },
    { kind: "finding", id: "finding:0123456789abcdef", criterionId: "narration-voice" },
    { kind: "fingerprint", id: `quality-failure:${"d".repeat(24)}`, lowestId: "pacing" },
  ];
  for (const group of kinds) {
    for (const [currentRung, nextRung] of [["verbal", "gotcha"], ["verbal", "script"], ["gotcha", "gate"], ["gate", "shift-left"]]) {
      for (const blastRadius of ["normal", "identity"]) {
        for (const detectable of ["yes", "no", "unknown"]) {
          const text = failurePromotionText({ ...group, label: "台本の品質ループ（narrated-story）" }, { blastRadius, detectable, currentRung, nextRung });
          assert.deepEqual(inspectLearningText(text, { homeRoot: "" }), [], text);
        }
      }
    }
  }
});

test("段の決め方: 口頭→注意書き→検査スクリプト→関門、関門で止まっている失敗は前倒し", () => {
  assert.equal(nextPromotionRung({ currentRung: "verbal", detectable: "unknown" }), "gotcha");
  assert.equal(nextPromotionRung({ currentRung: "verbal", detectable: "yes" }), "script");
  assert.equal(nextPromotionRung({ currentRung: "verbal", detectable: "no", high: true }), "gate");
  assert.equal(nextPromotionRung({ currentRung: "gotcha", detectable: "unknown" }), "script");
  assert.equal(nextPromotionRung({ currentRung: "gotcha", detectable: "no" }), "gate");
  assert.equal(nextPromotionRung({ currentRung: "script", detectable: "yes" }), "gate");
  assert.equal(nextPromotionRung({ currentRung: "gate", detectable: "yes", high: true }), "shift-left");

  assert.equal(classifyFailureBlastRadius({ kind: "floor", id: "hand-safety" }), "public-safety");
  assert.equal(classifyFailureBlastRadius({ kind: "floor", id: "no-real-brand-logo" }), "public-safety");
  assert.equal(classifyFailureBlastRadius({ kind: "floor", id: "review-first-person-marker" }), "public-safety");
  assert.equal(classifyFailureBlastRadius({ kind: "floor", id: "character-identity" }), "identity");
  assert.equal(classifyFailureBlastRadius({ kind: "gate", id: "reference-approved" }), "identity");
  assert.equal(classifyFailureBlastRadius({ kind: "gate", id: "external-call-recorded" }), "attestation");
  assert.equal(classifyFailureBlastRadius({ kind: "blocking", id: "cost-unit-conflict" }), "billing");
  assert.equal(classifyFailureBlastRadius({ kind: "floor", id: "beat-structure" }), "normal");
  // 目標点に届かないだけの失敗は、いちばん低い項目が何でも通常。
  assert.equal(classifyFailureBlastRadius({ kind: "fingerprint", id: `quality-failure:${"a".repeat(24)}`, lowestId: "character-identity" }), "normal");
  assert.equal(failureDetectability({ kind: "gate", id: "asset-readable" }), "yes");
  assert.equal(failureDetectability({ kind: "human-check", id: "identity" }), "no");
  assert.equal(failureDetectability({ kind: "finding", id: "finding:0123456789abcdef" }), "unknown");
});

test("被害の大きい種類は1回目でも関門へ上げる（完成動画の署名済みレビューの実際の回の形）", () => {
  const contract = createNarratedQualityContract();
  const scores = Object.fromEntries(contract.rubric.map((row) => [row.id, row.id === "character-identity" ? 40 : 100]));
  let state = createQualityLoopState({
    contract,
    episodeId: `video-narrated-story-video-${"b".repeat(16)}`,
    generatorId: "narrated-story-production",
    generatorContextId: "production:synthetic",
    startedAt: "2026-09-24T00:00:00Z",
  });
  const video = { path: "renders/synthetic.mp4", sha256: sha("video-1"), note: "この回に評価した MP4" };
  state = recordQualityRound({
    contract,
    state,
    hardGateReport: { pass: true, failedGateIds: [], contractDigest: contract.digest },
    reviews: [{ evaluatorId: "synthetic-reviewer-name", evaluatorContextId: "review-1", scores, notes: NOTES, evidence: [video] }],
    evidence: [{ path: "signoff.json", sha256: sha("signoff-1"), note: "署名済みの独立レビュー" }, video],
    observedAt: "2026-09-24T01:00:00Z",
  });
  assert.deepEqual(state.rounds[0].floorFailures, ["character-identity"]);
  const { candidates } = failurePromotionCandidates({ groups: groupsOf(state) });
  assert.equal(candidates.length, 1);
  const [candidate] = candidates;
  assert.equal(candidate.target, NARRATED_TARGET);
  assert.equal(candidate.loop, "signed-review");
  assert.equal(candidate.blastRadius, "identity");
  assert.equal(candidate.reason, "high-blast-radius");
  assert.equal(candidate.nextRung, "gate");
  assert.deepEqual(candidate.versions, [sha("video-1").slice(0, 12)], "版は署名ファイルではなく評価した MP4 で数える");
  assert.match(candidate.text, /被害の大きい種類: 人物の取り違え。1回目から上げる/u);
});

test("関門（機械ゲート・人の確認の欄）で止まっている失敗は、被害が大きくても再発してから前倒しを提案する", () => {
  const gateOnce = assetState({ rounds: [round(1, { gates: ["reference-approved"] })], versions: [{ round: 1, assetSha256: sha("img-1") }] });
  const first = failurePromotionCandidates({ groups: groupsOf(gateOnce) });
  assert.equal(first.candidates.length, 0);
  assert.equal(first.held[0].currentRung, "gate");
  assert.equal(first.held[0].needed, 2);

  const rejections = [
    { check: "identity", verdict: "reject", assetSha256: sha("img-1"), recordedAt: "2026-09-21T00:00:00.000Z" },
    { check: "identity", verdict: "reject", assetSha256: sha("img-1"), recordedAt: "2026-09-21T01:00:00.000Z" },
    { check: "hand-safety", verdict: "pass", assetSha256: sha("img-1"), recordedAt: "2026-09-21T00:00:00.000Z" },
  ];
  const humanOnce = failurePromotionCandidates({ groups: groupsOf(assetState({ rounds: [], humanVerifications: rejections })) });
  assert.equal(humanOnce.candidates.length, 0, "同じ画の否を2回記録しても1回");
  const humanTwice = failurePromotionCandidates({
    groups: groupsOf(assetState({
      rounds: [],
      humanVerifications: [...rejections, { check: "identity", verdict: "reject", assetSha256: sha("img-2"), recordedAt: "2026-09-22T00:00:00.000Z" }],
    })),
  });
  assert.equal(humanTwice.candidates.length, 1);
  assert.equal(humanTwice.candidates[0].failureKind, "human-check");
  assert.equal(humanTwice.candidates[0].nextRung, "shift-left");
  assert.match(humanTwice.candidates[0].text, /今の段: 通過必須の関門（人の確認の欄）/u);
  assert.equal(humanTwice.candidates[0].text.includes(SUBJECT), false, "対象の id（人物名になりうる）が本文に入った");

  // 工程に同じ中身の人の確認の欄がある評価項目（手指の安全）は、下限割れでも関門で止まっている扱い。
  const floorHand = failurePromotionCandidates({ groups: groupsOf(assetState({ rounds: [round(1, { floors: ["hand-safety"] })], versions: [{ round: 1, assetSha256: sha("img-3") }] })) });
  assert.equal(floorHand.candidates.length, 0);
  assert.equal(floorHand.held[0].currentRung, "gate");
});

test("台本の「採用したのに直らなかった指摘」と、始め直す前のループの回も数える", () => {
  const previousLoop = scriptState({
    rounds: [round(1, { floors: ["reading-clarity"], artifact: sha("old-1") })],
    status: "needs-human-approval",
  });
  const state = scriptState({
    status: "active",
    rounds: [round(1, { floors: ["reading-clarity"], artifact: sha("new-1") }), round(2, { artifact: sha("new-2"), fingerprint: `quality-failure:${"c".repeat(24)}` })],
    versions: [
      { round: 1, scriptSha256: sha("new-1"), recordedAt: "2026-09-22T00:00:00.000Z", findingRecords: [{ id: "r1-f1", text: NOTES, textDigest: "0123456789abcdef", criterionId: "narration-voice" }] },
      {
        round: 2,
        scriptSha256: sha("new-2"),
        recordedAt: "2026-09-23T00:00:00.000Z",
        rubricScores: { "beat-structure": 90, "narration-voice": 70 },
        findingRecords: [{ id: "r2-f1", text: NOTES, textDigest: "0123456789abcdef", unresolvedOf: ["r1-f1"] }],
      },
    ],
    history: [{ reason: "合成の理由", state: previousLoop }],
  });
  const byKind = Object.fromEntries(failurePromotionCandidates({ groups: groupsOf(state) }).candidates.map((row) => [row.failureKind, row]));
  assert.equal(byKind.floor.failureId, "reading-clarity");
  assert.equal(byKind.floor.occurrences, 2, "始め直す前のループの回と今の回");
  assert.equal(byKind.finding.failureId, "finding:0123456789abcdef");
  assert.equal(byKind.finding.occurrences, 2);
  assert.match(byKind.finding.text, /採用したのに直らなかった指摘（評価項目 narration-voice、指摘の指紋 0123456789abcdef）/u);
  assert.equal(byKind.finding.text.includes("架空の人物"), false);
  // 目標点に届かないだけの回は1回なので上げない。
  assert.equal(byKind.fingerprint, undefined);
});

test("台帳に同じ段の提案があれば積まず、段が反映された後は反映より後の再発だけで次の段を提案する", () => {
  const state = scriptState({
    rounds: [
      round(1, { floors: ["beat-structure"], artifact: sha("v1"), observedAt: "2026-09-21T00:00:00.000Z" }),
      round(2, { floors: ["beat-structure"], artifact: sha("v2"), observedAt: "2026-09-22T00:00:00.000Z" }),
      round(3, { floors: ["beat-structure"], artifact: sha("v3"), observedAt: "2026-09-24T00:00:00.000Z" }),
    ],
  });
  const groups = groupsOf(state);
  const key = failurePromotionKey({ loop: "script", scope: "narrated-story", kind: "floor", id: "beat-structure" });
  assert.equal(groups[0].key, key);
  const row = (id, nextRung) => ({
    id,
    target: SCRIPT_TARGET,
    createdBy: AUTO_FAILURE_PROMOTION_CREATOR,
    capturedAt: "2026-09-22T12:00:00.000Z",
    failurePromotion: { key, nextRung },
  });

  const queued = failurePromotionHistoryFromRows({ proposals: [row("aaaaaaaaaaaa", "gotcha")] });
  const pending = failurePromotionCandidates({ groups, history: queued });
  assert.equal(pending.candidates.length, 0);
  assert.equal(pending.held[0].heldReason, "already-queued");

  // 注意書きが 9/23 に反映された。その後の再発は1回（9/24）なので、まだ次の段へは上げない。
  const applied = failurePromotionHistoryFromRows({
    proposals: [row("aaaaaaaaaaaa", "gotcha")],
    appliedAt: new Map([["aaaaaaaaaaaa", "2026-09-23T00:00:00.000Z"]]),
  });
  const afterApply = failurePromotionCandidates({ groups, history: applied });
  assert.equal(afterApply.candidates.length, 0);
  assert.equal(afterApply.held[0].currentRung, "gotcha");
  assert.equal(afterApply.held[0].occurrences, 1);

  // 反映の後に2回再発したら、注意書きで防げていないので次の段（検査スクリプト）。
  const again = scriptState({ rounds: [...state.rounds, round(4, { floors: ["beat-structure"], artifact: sha("v4"), observedAt: "2026-09-25T00:00:00.000Z" })] });
  const next = failurePromotionCandidates({ groups: groupsOf(again), history: applied });
  assert.equal(next.candidates.length, 1);
  assert.equal(next.candidates[0].currentRung, "gotcha");
  assert.equal(next.candidates[0].nextRung, "script");
  assert.equal(next.candidates[0].occurrences, 2);

  // 別のチャンネルの印のある行は、このチャンネルの履歴に使わない。
  const other = failurePromotionHistoryFromRows({ channelId: "", proposals: [{ ...row("bbbbbbbbbbbb", "gotcha"), channel: "synthetic-other" }] });
  assert.equal(other.size, 0);
});

test("提案台帳へ auto-failure-promotion として積み、同じ提案は二重に積まない", async () => {
  const harness = captureHarness();
  const state = scriptState({
    rounds: [
      round(1, { floors: ["beat-structure"], gates: ["external-calls-complete"], artifact: sha("w1") }),
      round(2, { floors: ["beat-structure"], gates: ["external-calls-complete"], artifact: sha("w2") }),
    ],
  });
  const description = describeQualityLoopState(state);
  const sources = [{ file: "synthetic.json", workDir: "", description, occurrences: qualityLoopFailureOccurrences(state, description), job: null }];
  const run = (options = {}) => promoteRecurringQualityFailures({
    sources,
    write: true,
    env: {},
    captureOptions: harness.options,
    resolveChannel: NO_CHANNEL,
    readHistory: NO_HISTORY,
    now: () => "2026-09-27T00:00:00.000Z",
    ...options,
  });

  const dry = await promoteRecurringQualityFailures({ sources, env: {}, captureOptions: harness.options, resolveChannel: NO_CHANNEL, readHistory: NO_HISTORY });
  assert.equal(dry.write, false);
  assert.equal(dry.candidates.length, 2);
  assert.equal(harness.rows.length, 0, "dry-run は書かない");

  const first = await run();
  assert.equal(first.captured, 2);
  assert.equal(harness.rows.length, 2);
  for (const entry of harness.rows) {
    assert.equal(entry.target, SCRIPT_TARGET);
    assert.equal(entry.kind, "constraint");
    assert.equal(entry.createdBy, AUTO_FAILURE_PROMOTION_CREATOR);
    assert.equal(entry.receiptSource, AUTO_FAILURE_PROMOTION_SOURCE);
    assert.equal(entry.blocked, undefined, "書き込み前の検査に当たった");
    assert.equal(entry.failurePromotion.occurrences, 2);
    assert.equal(entry.failurePromotion.versions.length, 2);
    assert.equal(JSON.stringify(entry).includes("合成の所見"), false);
    assert.equal(JSON.stringify(entry).includes("synthetic-reviewer-name"), false);
  }
  const gateRow = harness.rows.find((entry) => entry.failurePromotion.failureKind === "gate");
  assert.equal(gateRow.failurePromotion.blastRadius, "attestation");
  assert.equal(gateRow.failurePromotion.currentRung, "gate");
  assert.equal(gateRow.failurePromotion.nextRung, "shift-left");
  assert.deepEqual(gateRow.gateIds, ["external-calls-complete"]);

  const second = await run();
  assert.equal(second.captured, 0);
  assert.equal(second.duplicates, 2);
  assert.equal(harness.rows.length, 2);

  // 台帳から読んだ履歴に同じ提案があれば、捕捉の前に止める。
  const withHistory = await run({ readHistory: () => failurePromotionHistoryFromRows({ proposals: harness.rows }) });
  assert.equal(withHistory.candidates.length, 0);
  assert.equal(withHistory.held.filter((row) => row.heldReason === "already-queued").length, 2);
});

test("子エージェントと自動の捕捉の停止では積まない。自動の経路は例外を投げない", async () => {
  const harness = captureHarness();
  const state = scriptState({ rounds: [round(1, { floors: ["beat-structure"], artifact: sha("x1") }), round(2, { floors: ["beat-structure"], artifact: sha("x2") })] });
  const description = describeQualityLoopState(state);
  const sources = [{ file: "synthetic.json", workDir: "", description, occurrences: qualityLoopFailureOccurrences(state, description), job: null }];
  const base = { sources, captureOptions: harness.options, resolveChannel: NO_CHANNEL, readHistory: NO_HISTORY };
  const child = await promoteRecurringQualityFailures({ ...base, write: true, env: childAgentEnvironment({}) });
  assert.equal(child.skippedReason, "child-agent");
  const disabled = await promoteRecurringQualityFailures({ ...base, write: true, auto: true, env: { BUZZASSIST_LEARNING_AUTO_CAPTURE: "0" } });
  assert.equal(disabled.skippedReason, "disabled");
  assert.equal(harness.rows.length, 0);
  const broken = await autoPromoteQualityLoopFailures({ workDir: join(tmpdir(), "synthetic-missing-work-dir"), threshold: 99, env: {} });
  assert.equal(broken.skippedReason, "promotion-failed");
  await assert.rejects(() => promoteRecurringQualityFailures({ ...base, threshold: 1 }), /--threshold/u);
});

test("本物の台帳の検査（captureLearningProposal）を通り、付帯情報に自由文を入れさせない", () => {
  const harness = captureHarness();
  const metadata = {
    key: "0123456789abcdef",
    loop: "asset",
    scope: "narrated-story-video",
    stage: "character",
    failureKind: "human-check",
    failureId: "identity",
    occurrences: 2,
    versions: [sha("i1").slice(0, 12), "r3-abcdef"],
    blastRadius: "identity",
    detectable: "no",
    currentRung: "gate",
    nextRung: "shift-left",
    reason: "recurrence",
  };
  const { entry } = captureLearningProposal({
    kind: "constraint",
    target: NARRATED_TARGET,
    text: "[失敗の格上げ] 合成の本文で、人の確認（identity）の否が別の版で繰り返し出た。",
    evidence: "auto-failure-promotion-v1 source=quality-loop-state",
    session: "auto-failure-promotion:synthetic",
    now: "2026-09-27T00:00:00.000Z",
    metadata: { createdBy: AUTO_FAILURE_PROMOTION_CREATOR, receiptSource: AUTO_FAILURE_PROMOTION_SOURCE, failurePromotion: metadata },
  }, harness.options);
  assert.deepEqual(entry.failurePromotion, metadata);
  assert.throws(() => normalizeProposalMetadata({ failurePromotion: { ...metadata, note: "自由文" } }), /未知のキー/u);
  assert.throws(() => normalizeFailurePromotionMetadata({ ...metadata, failureId: "合成の人物名" }), /failureId/u);
  // 版には短い sha か回の番号だけ。ファイル名や相対パスの形は通さない（公開面の検査に当たる絶対パスは書かない）。
  assert.throws(() => normalizeFailurePromotionMetadata({ ...metadata, versions: ["renders/synthetic-file.png"] }), /versions/u);
  assert.throws(() => normalizeFailurePromotionMetadata({ ...metadata, nextRung: "anything" }), /nextRung/u);
});

test("作業フォルダから品質ループの状態ファイルを全部見つけ、CLI の scan は何も書かない", async () => {
  const root = await mkdtemp(join(tmpdir(), "quality-failure-promotion-"));
  try {
    const workDir = join(root, "work");
    await mkdir(join(workDir, "quality", "assets"), { recursive: true });
    const script = scriptState({ rounds: [round(1, { floors: ["beat-structure"], artifact: sha("s1") }), round(2, { floors: ["beat-structure"], artifact: sha("s2") })] });
    await writeFile(join(workDir, "quality", "script-quality-loop.json"), JSON.stringify(script));
    await writeFile(join(workDir, "quality", "assets", "character--synthetic-subject.json"), JSON.stringify(assetState({ rounds: [] })));
    await writeFile(join(workDir, "quality", "assets", "character--synthetic-subject.revision-delta.json"), "{}");
    const files = await findQualityLoopStateFiles(workDir);
    assert.deepEqual(files, [
      join(workDir, "quality", "assets", "character--synthetic-subject.json"),
      join(workDir, "quality", "script-quality-loop.json"),
    ]);

    const registry = join(root, "registry.json");
    await writeFile(registry, JSON.stringify({ version: 1, channels: [] }));
    const env = { ...process.env, [CHANNEL_REGISTRY_PATH_ENV]: registry };
    delete env.BUZZASSIST_LEARNING_WRITE_FORBIDDEN;
    const cli = join(REPO_ROOT, "scripts", "harness-promote-failures.mjs");
    const scan = spawnSync(process.execPath, [cli, "scan", "--work-dir", workDir, "--json"], { encoding: "utf8", env, cwd: REPO_ROOT });
    assert.equal(scan.status, 0, scan.stderr);
    const result = JSON.parse(scan.stdout);
    assert.equal(result.write, false);
    assert.equal(result.sources, 2);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].failureId, "beat-structure");

    const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", env, cwd: REPO_ROOT });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /失敗の昇格ラダー/u);
    const noArgs = spawnSync(process.execPath, [cli, "enqueue"], { encoding: "utf8", env, cwd: REPO_ROOT });
    assert.equal(noArgs.status, 2);
    const child = spawnSync(process.execPath, [cli, "enqueue", "--work-dir", workDir], { encoding: "utf8", env: childAgentEnvironment(env), cwd: REPO_ROOT });
    assert.equal(child.status, 2);
    assert.match(child.stderr, /子エージェントからは学習を書きません/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI の引数: 何度でも渡せる作業フォルダ、不明なオプションは止める", () => {
  const args = parsePromoteFailuresArgs(["scan", "--work-dir", "a", "--work-dir", "b", "--state", "c.json", "--threshold", "3", "--json"]);
  assert.deepEqual(args.workDir, ["a", "b"]);
  assert.deepEqual(args.state, ["c.json"]);
  assert.equal(args.threshold, "3");
  assert.equal(args.json, true);
  assert.equal(parsePromoteFailuresArgs(["--help"]).help, true);
  assert.throws(() => parsePromoteFailuresArgs(["scan", "--unknown"]), /不明なオプション/u);
  assert.throws(() => parsePromoteFailuresArgs(["scan", "--work-dir"]), /値が要ります/u);
});
