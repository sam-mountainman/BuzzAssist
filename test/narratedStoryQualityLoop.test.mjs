import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  NARRATED_QUALITY_AUDIT_ID,
  NARRATED_QUALITY_LIMIT_DEFAULTS,
  advanceNarratedQualityLoop,
  createNarratedQualityContract,
  inspectNarratedQualityReview,
  narratedQualityPaths,
  normalizeNarratedQualityLoopConfig,
} from "../lib/narratedStoryQualityLoop.mjs";

// 人名・承認者名・Job id はすべて合成の値。
const JOB_A = "video-narrated-story-video-aaaaaaaaaaaaaaaa";
const JOB_B = "video-narrated-story-video-bbbbbbbbbbbbbbbb";
const sha = (value) => createHash("sha256").update(String(value)).digest("hex");
const contract = createNarratedQualityContract();
const scores = (overrides = {}) => Object.fromEntries(contract.rubric.map((criterion) => [criterion.id, overrides[criterion.id] ?? 96]));
const PASSING_CHECKS = Object.freeze({
  audioIntegratedLoudness: { pass: true },
  narrationBedSeparation: { pass: true },
  perceptualReviewChecks: { pass: true },
});

function signoffFor(context, rubricScores, { approved = true, contractDigest = contract.digest } = {}) {
  return {
    version: "buzzassist-narrated-story-contact-sheet-signoff-v2",
    reviewer: `codex:${context}`,
    reviewerHost: "codex",
    reviewerContextId: context,
    approved,
    findings: approved ? [] : ["5場面目の顔を設定画に合わせる"],
    knownRemainingIssues: [],
    qualityReview: { contractDigest, evaluatorContextId: context, rubricScores, notes: "全尺を通して見た所見" },
  };
}

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "narrated-quality-loop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDir = (jobId) => join(root, ".media", "narrated-story-video", jobId);
  return {
    root,
    runDir,
    predecessorStatePath: (jobId) => narratedQualityPaths(runDir(jobId)).statePath,
  };
}

let clock = Date.parse("2026-09-25T00:00:00.000Z");
const tick = () => {
  clock += 60_000;
  return new Date(clock).toISOString();
};

function advance(ws, jobId, signoff, extra = {}) {
  return advanceNarratedQualityLoop({
    contract,
    jobId,
    runDir: ws.runDir(jobId),
    signoff,
    signoffPath: join(ws.runDir(jobId), "review", "contact-sheet-signoff.json"),
    signoffSha256: sha(JSON.stringify(signoff)),
    documentValid: Boolean(signoff),
    auditChecks: PASSING_CHECKS,
    video: { path: join(ws.runDir(jobId), "render", "preview.mp4"), sha256: sha(`video:${jobId}`) },
    contactSheet: { path: join(ws.runDir(jobId), "audit", "contact-sheet.png"), sha256: sha(`sheet:${jobId}`) },
    roundCost: 3,
    predecessorStatePath: ws.predecessorStatePath,
    now: tick,
    ...extra,
  });
}

async function writeDelta(ws, jobId, body) {
  const { revisionDeltaPath } = narratedQualityPaths(ws.runDir(jobId));
  await mkdir(join(ws.runDir(jobId), "quality"), { recursive: true });
  await writeFile(revisionDeltaPath, JSON.stringify(body));
}

test("評価項目は全部に下限があり、「話が違う」「別人」「声が違う」の項目は高く、境目の項目は OP・感想を使う Pack だけ", () => {
  const byId = Object.fromEntries(contract.rubric.map((criterion) => [criterion.id, criterion]));
  for (const criterion of contract.rubric) assert.ok(Number.isFinite(criterion.minimumScore), `${criterion.id} に下限が無い`);
  assert.equal(byId["script-image-fit"].minimumScore, 80);
  assert.equal(byId["character-identity"].minimumScore, 80);
  assert.equal(byId["narration-voice"].minimumScore, 80);
  for (const id of ["subtitle-readability", "bgm-narration-balance", "full-length-viewing"]) assert.equal(byId[id].minimumScore, 60);
  assert.equal(byId["bookend-boundaries"], undefined, "境目の無い Pack に境目の項目を採点させない");
  const total = contract.rubric.reduce((sum, criterion) => sum + criterion.weight, 0);
  assert.ok(Math.abs(total - 100) < 1e-6);
  const withBookends = createNarratedQualityContract({ bookendsEnabled: true });
  assert.ok(withBookends.rubric.some((criterion) => criterion.id === "bookend-boundaries"));
  assert.notEqual(withBookends.digest, contract.digest, "評価項目が違えば別の契約");
  assert.deepEqual({ ...contract.limits }, { ...NARRATED_QUALITY_LIMIT_DEFAULTS });
  assert.equal(Object.isFrozen(contract.rubric[0]), true, "走行中に契約を書き換えさせない");
});

test("Channel Pack は上限だけを上書きでき、評価項目・下限の上書きや範囲外の値は有料生成前の blocker になる", () => {
  const ok = normalizeNarratedQualityLoopConfig({ targetScore: 95, maximumReviewRounds: 4, maximumElapsedMinutes: 120, maximumCostUnits: 30, minimumImprovementPoints: 2, maximumStagnantRounds: 2 });
  assert.deepEqual(ok.blockers, []);
  assert.deepEqual(ok.limits, { targetScore: 95, maximumReviewRounds: 4, maximumElapsedMs: 120 * 60_000, maximumCost: 30, minimumImprovement: 2, maximumStagnantRounds: 2 });
  const overridden = createNarratedQualityContract({ limits: ok.limits });
  assert.equal(overridden.limits.targetScore, 95);
  assert.notEqual(overridden.digest, contract.digest);
  assert.deepEqual(normalizeNarratedQualityLoopConfig(undefined), { limits: {}, blockers: [] });
  const bad = normalizeNarratedQualityLoopConfig({ targetScore: 50, maximumReviewRounds: 2.5, rubric: [], minimumScore: 10, surprise: 1, maximumCostUnits: "10" });
  assert.deepEqual(bad.blockers.sort(), [
    "qualityLoop.maximumCostUnits",
    "qualityLoop.maximumReviewRounds",
    "qualityLoop.minimumScore-not-overridable",
    "qualityLoop.rubric-not-overridable",
    "qualityLoop.surprise-unknown",
    "qualityLoop.targetScore",
  ]);
  assert.deepEqual(normalizeNarratedQualityLoopConfig([]).blockers, ["qualityLoop"]);
});

test("1つの評価項目が下限を割ると、平均が目標に届いても合格しない", async (t) => {
  const ws = await workspace(t);
  const result = await advance(ws, JOB_A, signoffFor("review-ctx-001", scores({ "character-identity": 55 })));
  assert.equal(result.recorded, true);
  assert.notEqual(result.state.status, "passed");
  assert.equal(result.check.pass, false);
  assert.deepEqual(result.check.floorFailures, ["character-identity"]);
  assert.ok(result.issues.includes("quality-loop-floor-failed:character-identity"));
  // 平均だけなら目標に届く点数でも落ちる（加重平均で 1 項目の致命傷を薄めない）。
  const highElsewhere = await advance(await workspace(t), JOB_A, signoffFor("review-ctx-002", scores({ "narration-voice": 79, "script-image-fit": 100, "character-identity": 100, "subtitle-readability": 100, "bgm-narration-balance": 100, "full-length-viewing": 100 })));
  assert.ok(highElsewhere.state.rounds[0].score >= contract.limits.targetScore, `平均 ${highElsewhere.state.rounds[0].score} は目標以上`);
  assert.equal(highElsewhere.check.pass, false);
  assert.deepEqual(highElsewhere.check.floorFailures, ["narration-voice"]);
});

test("目標に届かない回は例外にならず、失敗指紋を残して人待ちの理由を返し、状態を作業領域に原子的に書く", async (t) => {
  const ws = await workspace(t);
  const result = await advance(ws, JOB_A, signoffFor("review-ctx-001", scores(Object.fromEntries(contract.rubric.map((criterion) => [criterion.id, 85])))));
  assert.equal(result.state.status, "active");
  assert.equal(result.check.pass, false);
  assert.match(result.check.failureFingerprint, /^quality-failure:/u);
  assert.ok(result.issues.some((issue) => issue.startsWith("quality-loop-below-target:85<92")));
  assert.ok(result.issues.includes(`quality-loop-round-1-not-passed:${result.check.failureFingerprint}`));
  assert.ok(result.issues.includes("quality-loop-revision-and-fresh-review-required"));
  assert.match(result.check.detail, /revision-delta\.json/u, "次に何を書けばよいかを示す");
  const onDisk = JSON.parse(await readFile(narratedQualityPaths(ws.runDir(JOB_A)).statePath, "utf8"));
  assert.equal(onDisk.rounds.length, 1);
  assert.equal(onDisk.generatorContextId, `production:${JOB_A}`);
  assert.equal(result.check.stateSha256, sha256OfFile(await readFile(narratedQualityPaths(ws.runDir(JOB_A)).statePath)));
  assert.equal(onDisk.totalCost, 3, "この Job の有料生成の費用を1回だけ数える");
});

function sha256OfFile(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("2回目以降は、修正内容が無ければ人待ち・同じ評価文脈なら人待ち・修正内容と新しい文脈があれば記録できる（再開で状態を引き継ぐ）", async (t) => {
  const ws = await workspace(t);
  const first = await advance(ws, JOB_A, signoffFor("review-ctx-001", scores({ "script-image-fit": 60 })));
  const fingerprint = first.check.failureFingerprint;

  // 同じ signoff で再開しても二重に記録しない。
  const again = await advance(ws, JOB_A, signoffFor("review-ctx-001", scores({ "script-image-fit": 60 })));
  assert.equal(again.recorded, false);
  assert.equal(again.state.rounds.length, 1);
  assert.equal(again.check.failureFingerprint, fingerprint);

  // 同じ評価文脈で採点し直した signoff は人待ち（新しい文脈のレビューが要る）。
  const sameContext = await advance(ws, JOB_A, signoffFor("review-ctx-001", scores()));
  assert.equal(sameContext.recorded, false);
  assert.ok(sameContext.issues.includes("quality-loop-fresh-review-required"));
  assert.equal(sameContext.check.pass, false);

  // 新しい文脈でも、修正内容が無ければ例外ではなく人待ち（前回の失敗指紋を示す）。
  const noDelta = await advance(ws, JOB_A, signoffFor("review-ctx-002", scores()));
  assert.equal(noDelta.recorded, false);
  assert.deepEqual(noDelta.issues, [`quality-loop-revision-delta-required:${fingerprint}`]);
  assert.match(noDelta.check.detail, new RegExp(fingerprint.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

  // 別の失敗に宛てた古い修正内容は使わない。
  await writeDelta(ws, JOB_A, { previousFailureFingerprint: "quality-failure:old", revisionDelta: "古い修正" });
  assert.equal((await advance(ws, JOB_A, signoffFor("review-ctx-002", scores()))).recorded, false);

  // 修正内容を書いて再開すると、ディスクの状態を引き継いで 2 回目が記録され、合格する。
  await writeDelta(ws, JOB_A, { previousFailureFingerprint: fingerprint, revisionDelta: "3場面目の画を台本の場所に合わせて差し替えた" });
  const second = await advance(ws, JOB_A, signoffFor("review-ctx-002", scores()));
  assert.equal(second.recorded, true);
  assert.equal(second.state.rounds.length, 2);
  assert.equal(second.state.rounds[1].previousFailureFingerprint, fingerprint);
  assert.equal(second.state.rounds[1].revisionDelta, "3場面目の画を台本の場所に合わせて差し替えた");
  assert.equal(second.state.status, "passed");
  assert.equal(second.check.pass, true);
  assert.equal(second.check.rounds, 2);
  assert.deepEqual(second.issues, []);
  // 同じ MP4 のままの2回目は、出力が変わっていないことを証跡に残す。
  assert.match(second.state.rounds[1].evidence.find((row) => row.path.endsWith("preview.mp4")).note, /出力は変わっていない/u);
  assert.equal(second.state.totalCost, 3, "同じ Job の費用を二重に数えない");
  // 合格の根拠（signoff / MP4 / contact sheet の SHA）を監査に載せる。
  assert.equal(second.check.signoffSha256, sha(JSON.stringify(signoffFor("review-ctx-002", scores()))));
  // 合格後に同じ signoff で再開しても合格のまま、別の signoff に差し替わっていたら人が確かめる。
  assert.equal((await advance(ws, JOB_A, signoffFor("review-ctx-002", scores()))).check.pass, true);
  const replaced = await advance(ws, JOB_A, signoffFor("review-ctx-003", scores()));
  assert.deepEqual(replaced.issues, ["quality-loop-passed-review-replaced"]);
});

test("直した出力が別の Job になったときは、revision-delta.json の predecessorJobId で前の Job のループを引き継ぐ", async (t) => {
  const ws = await workspace(t);
  const first = await advance(ws, JOB_A, signoffFor("review-ctx-001", scores({ "narration-voice": 50 }), { approved: false }));
  const fingerprint = first.check.failureFingerprint;
  assert.ok(first.state.rounds[0].failedGateIds.length === 0, "差し戻しかどうかは呼び出し側の目視ゲートで決まる（ここでは全部通過）");

  // 前の Job の失敗指紋と違えば引き継がない。
  await writeDelta(ws, JOB_B, { predecessorJobId: JOB_A, previousFailureFingerprint: "quality-failure:other", revisionDelta: "声を差し替えた" });
  const stale = await advance(ws, JOB_B, signoffFor("review-ctx-002", scores()));
  assert.equal(stale.recorded, false);
  assert.match(stale.issues[0], /^quality-loop-revision-delta-stale:/u);
  // 自分自身・形の違う id は拒否。
  await writeDelta(ws, JOB_B, { predecessorJobId: JOB_B, previousFailureFingerprint: fingerprint, revisionDelta: "声を差し替えた" });
  assert.deepEqual((await advance(ws, JOB_B, signoffFor("review-ctx-002", scores()))).issues, ["quality-loop-predecessor-invalid"]);
  await writeDelta(ws, JOB_B, { predecessorJobId: "../../etc", previousFailureFingerprint: fingerprint, revisionDelta: "声を差し替えた" });
  assert.deepEqual((await advance(ws, JOB_B, signoffFor("review-ctx-002", scores()))).issues, ["quality-loop-predecessor-invalid"]);

  // 前の回で使った評価文脈は、別の Job でも使えない。
  await writeDelta(ws, JOB_B, { predecessorJobId: JOB_A, previousFailureFingerprint: fingerprint, revisionDelta: "Pack の声を承認済みの声に差し替えて作り直した" });
  const reused = await advance(ws, JOB_B, signoffFor("review-ctx-001", scores()));
  assert.ok(reused.issues.includes("quality-loop-fresh-review-required"));

  const continued = await advance(ws, JOB_B, signoffFor("review-ctx-002", scores()));
  assert.equal(continued.recorded, true);
  assert.equal(continued.state.rounds.length, 2, "前の Job の回に続けて数える");
  assert.deepEqual(continued.state.predecessorJobIds, [JOB_A]);
  assert.equal(continued.state.rounds[1].previousFailureFingerprint, fingerprint);
  assert.equal(continued.state.status, "passed");
  assert.equal(continued.state.totalCost, 6, "作り直した Job の費用も上限に数える");
  assert.deepEqual([...continued.state.costedJobIds].sort(), [JOB_A, JOB_B]);
  // 前の Job の状態は書き換えない（新しい Job の作業領域にだけ書く）。
  const predecessor = JSON.parse(await readFile(ws.predecessorStatePath(JOB_A), "utf8"));
  assert.equal(predecessor.rounds.length, 1);
});

test("回数の上限・止まったループ・契約の違う前の Job は、人の判断を待つ", async (t) => {
  const ws = await workspace(t);
  const low = scores({ "character-identity": 40 });
  let result = await advance(ws, JOB_A, signoffFor("review-ctx-001", low));
  for (let round = 2; round <= contract.limits.maximumReviewRounds; round += 1) {
    await writeDelta(ws, JOB_A, { previousFailureFingerprint: result.check.failureFingerprint, revisionDelta: `修正 ${round}` });
    // 毎回はっきり良くなっている（停滞では止まらない）が、同一性の下限 80 には届かない。
    result = await advance(ws, JOB_A, signoffFor(`review-ctx-00${round}`, scores({ "character-identity": 40 + round * 10 })));
    assert.equal(result.recorded, true);
  }
  assert.equal(result.state.status, "needs-human-approval");
  assert.equal(result.state.stopReason, "round-limit");
  assert.ok(result.issues.includes("quality-loop-stopped:needs-human-approval:round-limit"));
  // 止まったループには、新しい文脈・修正内容があっても回を足さない。
  await writeDelta(ws, JOB_A, { previousFailureFingerprint: result.check.failureFingerprint, revisionDelta: "さらに修正" });
  const blocked = await advance(ws, JOB_A, signoffFor("review-ctx-009", scores()));
  assert.equal(blocked.recorded, false);
  assert.ok(blocked.issues.includes("quality-loop-stopped:needs-human-approval:round-limit"));
  // 止まったループは別の Job でも引き継がない。
  await writeDelta(ws, JOB_B, { predecessorJobId: JOB_A, previousFailureFingerprint: result.check.failureFingerprint, revisionDelta: "作り直した" });
  assert.deepEqual((await advance(ws, JOB_B, signoffFor("review-ctx-010", scores()))).issues, ["quality-loop-predecessor-stopped:needs-human-approval:round-limit"]);

  // 直しても点がほとんど上がらなければ、回数の上限より前に停滞で止まる。
  const ws3 = await workspace(t);
  const stuck = await advance(ws3, JOB_A, signoffFor("review-ctx-201", scores({ "character-identity": 40 })));
  await writeDelta(ws3, JOB_A, { previousFailureFingerprint: stuck.check.failureFingerprint, revisionDelta: "髪の色だけ直した" });
  const stagnant = await advance(ws3, JOB_A, signoffFor("review-ctx-202", scores({ "character-identity": 42 })));
  assert.equal(stagnant.state.status, "needs-human-approval");
  assert.equal(stagnant.state.stopReason, "no-improvement");
  assert.ok(stagnant.issues.includes("quality-loop-stopped:needs-human-approval:no-improvement"));

  // 前の Job と契約が違えば引き継がない（黙って新しいループにもしない）。
  const ws2 = await workspace(t);
  const other = createNarratedQualityContract({ limits: { targetScore: 95 } });
  const firstOther = await advanceNarratedQualityLoop({
    contract: other,
    jobId: JOB_A,
    runDir: ws2.runDir(JOB_A),
    signoff: signoffFor("review-ctx-101", scores({ "character-identity": 40 }), { contractDigest: other.digest }),
    signoffPath: "/fixture/signoff.json",
    signoffSha256: sha("other"),
    documentValid: true,
    auditChecks: PASSING_CHECKS,
    video: { path: "/fixture/preview.mp4", sha256: sha("v") },
    contactSheet: { path: "/fixture/sheet.png", sha256: sha("s") },
    now: tick,
  });
  await writeDelta(ws2, JOB_B, { predecessorJobId: JOB_A, previousFailureFingerprint: firstOther.check.failureFingerprint, revisionDelta: "作り直した" });
  assert.deepEqual(
    (await advance(ws2, JOB_B, signoffFor("review-ctx-102", scores()))).issues,
    [`quality-loop-predecessor-contract-changed:${JOB_A}`],
  );
});

test("署名や SHA の検査に落ちた signoff・採点の無い signoff・別の契約の採点は、回にしない", async (t) => {
  const ws = await workspace(t);
  const pending = await advance(ws, JOB_A, null);
  assert.equal(pending.recorded, false);
  assert.deepEqual(pending.issues, []);
  assert.equal(pending.check.status, "not-started");
  const unsigned = await advance(ws, JOB_A, signoffFor("review-ctx-001", scores()), { documentValid: false });
  assert.equal(unsigned.recorded, false);
  const { qualityReview: _dropped, ...noScores } = signoffFor("review-ctx-001", scores());
  assert.deepEqual((await advance(ws, JOB_A, noScores)).issues, ["quality-loop-quality-review-missing"]);
  assert.ok((await advance(ws, JOB_A, signoffFor("review-ctx-001", scores(), { contractDigest: "f".repeat(64) }))).issues.includes("quality-loop-quality-review-contract-mismatch"));
  const mismatchedContext = signoffFor("review-ctx-001", scores());
  mismatchedContext.qualityReview.evaluatorContextId = "some-other-context";
  assert.ok(inspectNarratedQualityReview(mismatchedContext, contract).problems.includes("quality-review-evaluator-context-mismatch"), "評価文脈は reviewer の文脈と同じでなければならない");
  const { "narration-voice": _voice, ...partial } = scores();
  assert.ok((await advance(ws, JOB_A, signoffFor("review-ctx-001", partial))).issues.includes("quality-loop-quality-review-score-invalid:narration-voice"));
  // 作る係の名乗り・文脈は採点できない（例外ではなく人待ち）。
  const generatorContext = await advance(ws, JOB_A, signoffFor(`production:${JOB_A}`, scores()));
  assert.deepEqual(generatorContext.issues, ["quality-loop-round-rejected"]);
  const { statePath } = narratedQualityPaths(ws.runDir(JOB_A));
  await assert.rejects(readFile(statePath), (error) => error?.code === "ENOENT", "回にならなかった signoff は状態を作らない");
});

test("機械ゲートが落ちた回は記録するが合格にせず、落ちたゲートを失敗指紋と人待ちの理由に入れる", async (t) => {
  const ws = await workspace(t);
  const result = await advance(ws, JOB_A, signoffFor("review-ctx-001", scores()), {
    auditChecks: { ...PASSING_CHECKS, narrationBedSeparation: { pass: false }, [NARRATED_QUALITY_AUDIT_ID]: { pass: false } },
  });
  assert.equal(result.recorded, true);
  assert.equal(result.check.pass, false);
  assert.deepEqual(result.state.rounds[0].failedGateIds, ["narrationBedSeparation"], "品質ループ自身の判定は機械ゲートに数えない");
  assert.ok(result.issues.includes("quality-loop-hard-gate-failed:narrationBedSeparation"));
});
