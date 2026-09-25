import assert from "node:assert/strict";
import test from "node:test";

import { openKoyaQualityLoopState } from "../lib/koyaMangaFinalAudit.mjs";
import { createMangaQualityContract, recordMangaQualityRound } from "../lib/mangaQualityHarness.mjs";

// 時間の予算（既定 6 時間）はレビューの回数のためのもので、画像生成の時間ではない。
// 計画時刻を起点にしていたので、本番尺の生成（実測 13〜16 時間）を終えて最初の
// 監査に来た時点で time-limit になり、人手待ちへ落ちていた（公式経路で長編を一度も
// 通せていなかった理由の1つ）。
const PLANNED_AT = "2026-09-01T00:00:00.000Z";
const FIRST_AUDIT_AT = "2026-09-01T16:00:00.000Z"; // 計画から 16 時間後

function manifest() {
  return {
    id: "loop-start-test",
    production: { provenance: { generator: { host: "codex", id: "codex:g", contextId: "generator-context", capturedAt: PLANNED_AT } } },
    qualityHarness: { limits: {} },
  };
}

test("the quality-loop clock starts at the first audit, not at planning time", () => {
  const contract = createMangaQualityContract({ manifest: manifest() });
  const state = openKoyaQualityLoopState({
    existing: null,
    contract,
    manifest: manifest(),
    evidenceMerkleRoot: "a".repeat(64),
    now: () => FIRST_AUDIT_AT,
  });
  assert.equal(state.startedAt, FIRST_AUDIT_AT, "計画時刻を起点にしないこと");
  assert.equal(state.generatorProvenance?.capturedAt, PLANNED_AT, "生成者の記録はそのまま残す");

  // 最初のレビューは、生成に 16 時間かかっていても time-limit にならない。
  const perfect = Object.fromEntries((contract.rubric || []).map((criterion) => [criterion.id, 100]));
  const evidence = [{ path: "/tmp/round.json", sha256: "b".repeat(64), note: "最初の監査で固定した証拠" }];
  const round = recordMangaQualityRound({
    contract,
    state,
    hardGateReport: { pass: true, contractDigest: contract.digest },
    reviews: [{ evaluatorId: "r1", evaluatorContextId: "rc1", scores: perfect, notes: "問題なし", evidence }],
    evidence,
    observedAt: "2026-09-01T16:05:00.000Z",
  });
  assert.notEqual(round.stopReason, "time-limit", `時間切れになった: ${round.status}/${round.stopReason}`);
  assert.equal(round.elapsedMs, 5 * 60_000);
});

test("an existing loop is kept unless the contract or the passed evidence changed", () => {
  const contract = createMangaQualityContract({ manifest: manifest() });
  const opened = openKoyaQualityLoopState({ existing: null, contract, manifest: manifest(), evidenceMerkleRoot: "a".repeat(64), now: () => FIRST_AUDIT_AT });
  const kept = openKoyaQualityLoopState({ existing: opened, contract, manifest: manifest(), evidenceMerkleRoot: "a".repeat(64), now: () => "2026-09-02T00:00:00.000Z" });
  assert.equal(kept, opened, "同じ契約・未合格の状態は作り直さない");

  const other = createMangaQualityContract({ manifest: manifest(), overrides: { targetScore: 99 } });
  const replaced = openKoyaQualityLoopState({ existing: opened, contract: other, manifest: manifest(), evidenceMerkleRoot: "a".repeat(64), now: () => "2026-09-02T00:00:00.000Z" });
  assert.notEqual(replaced, opened, "契約が変われば作り直す");
  assert.equal(replaced.startedAt, "2026-09-02T00:00:00.000Z");

  const passed = { ...opened, status: "passed", rounds: [{ evidenceMerkleRoot: "a".repeat(64) }] };
  assert.equal(openKoyaQualityLoopState({ existing: passed, contract, manifest: manifest(), evidenceMerkleRoot: "a".repeat(64) }), passed);
  const reopened = openKoyaQualityLoopState({ existing: passed, contract, manifest: manifest(), evidenceMerkleRoot: "c".repeat(64), now: () => "2026-09-03T00:00:00.000Z" });
  assert.equal(reopened.startedAt, "2026-09-03T00:00:00.000Z", "合格済みでも証拠が変われば新しいループを今から始める");
});

// 署名済みのレビューがあってから最初の監査を走らせると、ループは監査の時刻で開き、
// 回の時刻はレビューの時刻（signoff.reviewedAt）になる。以前はここで「回の時刻が開始より前」
// として例外になり、監査そのものが落ちていた（外部レビューで再現）。契約が変わってループを
// 作り直したときも同じ形になる。レビューと監査のどちらが先でも記録でき、経過時間は負に
// ならず、2つの時刻をまたぐ長さとして数えること。
test("a review signed before the audit that opens the loop is recorded, not rejected", () => {
  const contract = createMangaQualityContract({ manifest: manifest() });
  const state = openKoyaQualityLoopState({
    existing: null,
    contract,
    manifest: manifest(),
    evidenceMerkleRoot: "a".repeat(64),
    now: () => FIRST_AUDIT_AT,
  });
  const perfect = Object.fromEntries((contract.rubric || []).map((criterion) => [criterion.id, 100]));
  const evidence = [{ path: "/tmp/round.json", sha256: "b".repeat(64), note: "レビュー後に走らせた監査の証拠" }];
  const reviewedBeforeAudit = "2026-09-01T15:30:00.000Z"; // 監査の 30 分前に署名
  const recorded = recordMangaQualityRound({
    contract,
    state,
    hardGateReport: { pass: true, contractDigest: contract.digest },
    reviews: [{ evaluatorId: "r1", evaluatorContextId: "rc1", scores: perfect, notes: "問題なし", evidence }],
    evidence,
    observedAt: reviewedBeforeAudit,
  });
  assert.equal(recorded.status, "passed");
  assert.equal(recorded.elapsedMs, 30 * 60_000, "レビューから監査までの 30 分を数える");
  assert.ok(recorded.rounds[0].elapsedMs >= 0, "経過時間は負にならない");
  assert.equal(recorded.clockStartedAt, reviewedBeforeAudit, "時計の起点は早い方の時刻");
  assert.equal(recorded.startedAt, FIRST_AUDIT_AT, "ループを開いた時刻は書き換えない");
});
