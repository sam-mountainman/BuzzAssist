// 途中の成果物の品質ループの状態 → 理由コードの対応は lib/assetQualityLoop.mjs の1か所
// （assetQualityReasonCode）にある。使う前の照合（lib/assetQualityUseGate.mjs。漫画の全工程とナレーション物語の
// サムネ）と、ナレーション物語の関門（lib/narratedStoryAssetLoops.mjs）は語彙だけを選ぶ。
// 下の表は、一本化する前の2つの実装が返していた理由コード（外から見える文字列）をそのまま写したもの。
// 対象 id・パスは合成の値。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ASSET_QUALITY_REASON_VOCABULARIES, assetQualityReasonCode } from "../lib/assetQualityLoop.mjs";
import { ASSET_QUALITY_USE_REASONS, checkAssetQualityBeforeUse } from "../lib/assetQualityUseGate.mjs";
import { KOYA_ASSET_QUALITY_REASONS } from "../lib/koyaAssetQualityGatePolicy.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

const human = (missing = [], rejected = []) => ({ required: [...missing, ...rejected], verified: [], missing, rejected, uncounted: [] });
const status = (loopStatus, { started = true, pass = false, issues = [], rounds = 0, missing = [], rejected = [] } = {}) => ({
  started, pass, issues,
  check: started ? { status: loopStatus, rounds, humanVerification: human(missing, rejected) } : {},
});
const CANDIDATE_MISMATCH = "asset-quality-candidate-not-reviewed-version";
const CHANGED = "asset-quality-asset-changed-after-review";
const MISSING = "asset-quality-asset-missing";
const CANDIDATE_MISSING = "asset-quality-candidate-missing";

// [名前, assetQualityStatus の結果, 使う前の照合の理由, ナレーション物語の関門の理由]
const GOLDEN = [
  ["not-started", status("not-started", { started: false, issues: ["asset-quality-loop-not-started"] }), "loop-not-started", "loop-not-started"],
  ["active-first", status("active", { issues: ["asset-quality-first-review-required"] }), "not-passed", "review-required"],
  ["active-first+candidate-mismatch", status("active", { issues: ["asset-quality-first-review-required", CANDIDATE_MISMATCH] }), "asset-sha-mismatch", "review-required"],
  ["active-retry", status("active", { rounds: 1, issues: ["asset-quality-round-1-not-passed:quality-failure:x", "asset-quality-revision-and-fresh-review-required"] }), "not-passed", "revision-required"],
  ["active-retry+changed", status("active", { rounds: 1, issues: ["asset-quality-revision-and-fresh-review-required", CHANGED] }), "asset-sha-mismatch", "revision-required"],
  ["active-retry+missing", status("active", { rounds: 2, issues: ["asset-quality-revision-and-fresh-review-required", MISSING] }), "asset-missing", "revision-required"],
  ["awaiting-human", status("awaiting-human-verification", { rounds: 1, missing: ["identity"], issues: ["asset-quality-human-verification-required:identity"] }), "not-passed", "human-verification-required:identity"],
  ["awaiting-human-two", status("awaiting-human-verification", { rounds: 1, missing: ["identity", "hand-safety"] }), "not-passed", "human-verification-required:identity+hand-safety"],
  ["awaiting-human-none-listed", status("awaiting-human-verification", { rounds: 1 }), "not-passed", "human-verification-required:unknown"],
  ["awaiting-human+candidate-mismatch", status("awaiting-human-verification", { rounds: 1, missing: ["identity"], issues: [CANDIDATE_MISMATCH] }), "asset-sha-mismatch", "human-verification-required:identity"],
  ["human-rejected", status("human-rejected", { rounds: 1, rejected: ["identity"], issues: ["asset-quality-human-rejected:identity"] }), "not-passed", "human-rejected:identity"],
  ["human-rejected-none-listed", status("human-rejected", { rounds: 1 }), "not-passed", "human-rejected:unknown"],
  ["human-rejected+candidate-missing", status("human-rejected", { rounds: 1, rejected: ["hand-safety"], issues: [CANDIDATE_MISSING] }), "asset-missing", "human-rejected:hand-safety"],
  ["stopped-blocked", status("blocked", { rounds: 1, issues: ["asset-quality-stopped:blocked:needs-human"] }), "not-passed", "loop-stopped:blocked"],
  ["stopped-exhausted", status("stopped", { rounds: 4 }), "not-passed", "loop-stopped:stopped"],
  ["stopped-unknown", { started: true, pass: false, issues: [], check: { rounds: 1 } }, "not-passed", "loop-stopped:unknown"],
  ["passed+changed", status("passed", { rounds: 1, issues: [CHANGED] }), "asset-sha-mismatch", "sha256-mismatch"],
  ["passed+asset-missing", status("passed", { rounds: 1, issues: [MISSING] }), "asset-missing", "asset-missing"],
  ["passed+candidate-missing", status("passed", { rounds: 1, issues: [CANDIDATE_MISSING] }), "asset-missing", "asset-missing"],
  ["passed+candidate-mismatch", status("passed", { rounds: 1, issues: [CANDIDATE_MISMATCH] }), "asset-sha-mismatch", "sha256-mismatch"],
  ["passed-no-issue-not-deliverable", status("passed", { rounds: 1 }), "not-passed", "sha256-mismatch"],
  ["passed", status("passed", { rounds: 1, pass: true }), "passed", "passed"],
];

test("状態 → 理由コードの対応は1か所で、2つの語彙の外に見える文字列は一本化する前と同じ", async () => {
  const workDir = path.join(tmpdir(), "asset-reason-golden-work");
  for (const [name, value, beforeUse, loopState] of GOLDEN) {
    assert.equal(assetQualityReasonCode(value, { vocabulary: "before-use" }), beforeUse, `${name}: 使う前の照合`);
    assert.equal(assetQualityReasonCode(value, { vocabulary: "loop-state" }), loopState, `${name}: ナレーション物語の関門`);
    // 使う前の照合は、同じ対応を通って同じ理由を返す（判定を作り直さない）。
    const checked = await checkAssetQualityBeforeUse({ harnessId: "synthetic-harness", workDir, stage: "thumbnail", subjectId: "synthetic-a", assetPath: "a.png", status: async () => value });
    assert.equal(checked.reason, beforeUse, `${name}: checkAssetQualityBeforeUse`);
    assert.equal(checked.pass, beforeUse === "passed");
    if (beforeUse !== "passed") assert.equal(checked.code, `asset-quality-required:thumbnail:synthetic-a:${beforeUse}`);
  }
  // 語彙の既定はループの状態（細かい方）。知らない語彙は例外（黙って別の語彙へ倒さない）。
  assert.equal(assetQualityReasonCode(GOLDEN[1][1]), "review-required");
  assert.throws(() => assetQualityReasonCode(GOLDEN[1][1], { vocabulary: "unknown" }), /語彙/u);
});

test("語彙の理由の一覧は、漫画・使う前の照合が外へ出している一覧と同じ（作業フォルダの外はその照合の前検査）", () => {
  const beforeUse = ASSET_QUALITY_REASON_VOCABULARIES["before-use"].reasons;
  assert.deepEqual([...beforeUse, "outside-work-dir"], [...ASSET_QUALITY_USE_REASONS]);
  assert.deepEqual([...ASSET_QUALITY_USE_REASONS], [...KOYA_ASSET_QUALITY_REASONS]);
  for (const [, value, used, loop] of GOLDEN) {
    if (used !== "passed") assert.ok(beforeUse.includes(used), used);
    if (loop !== "passed") assert.ok(ASSET_QUALITY_REASON_VOCABULARIES["loop-state"].reasons.some((reason) => loop === reason || loop.startsWith(`${reason.split(":")[0]}:`)), loop);
    assert.ok(value);
  }
});

test("状態の issues と工程の状態から理由を決める規則は、品質ループの本体の外に2つ目を持たない", async () => {
  // ループの issues の文字列や状態名を読んで理由を決める箇所が、照合側に残っていないこと。
  const statusVocabulary = [CANDIDATE_MISMATCH, CHANGED, MISSING, CANDIDATE_MISSING, "awaiting-human-verification", "human-rejected\""];
  for (const file of ["lib/assetQualityUseGate.mjs", "lib/narratedStoryAssetLoops.mjs", "lib/koyaAssetQualityGate.mjs", "lib/thumbnailPlanHarnesses.mjs"]) {
    const source = await readFile(path.join(root, file), "utf8");
    for (const token of statusVocabulary) {
      assert.equal(source.includes(token), false, `${file} が品質ループの状態 ${token} を自分で読んでいる（assetQualityReasonCode を使う）`);
    }
  }
});
