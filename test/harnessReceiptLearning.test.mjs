import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { childAgentEnvironment } from "../lib/harnessLearningGuard.mjs";
import {
  AUTO_RECEIPT_CREATOR,
  captureSettledJobLearning,
  issueCodeOf,
  jobStateDigest,
  loadHarnessDeclaration,
  receiptLearningCandidates,
} from "../lib/harnessReceiptLearning.mjs";
import { captureLearningProposal, proposalId } from "../scripts/harness-learn.mjs";

// すべて合成データ。台本・人名・端末パスに見える文字列は「本文へ運ばれないこと」を
// 確かめるためだけに置いている。
// 端末パスの形はソースに直書きしない（公開面の検査が開発機の絶対パスとして数える）。
const SYNTHETIC_PATH = ["", "Users", "synthetic-operator", "work", "episode", "cut-11.mp4"].join("/");
const SYNTHETIC_NAME = "架空太郎";
const SKILL_TREE = "a".repeat(64);
const DECLARATION = loadHarnessDeclaration("koya-manga-video");
// 決着の索引（receipts/index.jsonl）はリポジトリへ書かせない。試験ごとの一時ディレクトリへ向ける。
const TEST_RECEIPT_INDEX = join(mkdtempSync(join(tmpdir(), "receipt-index-")), "index.jsonl");
test.after(() => rmSync(dirname(TEST_RECEIPT_INDEX), { recursive: true, force: true }));

function receiptFixture(overrides = {}) {
  return {
    version: "harness-run-receipt-v1",
    finalized: true,
    finalizedAt: "2026-09-24T00:00:00.000Z",
    outcome: "fail",
    outcomeOverridden: true,
    harnessBuild: {
      harness: { id: "koya-manga-video", version: "1.1.0", declarationDigest: "b".repeat(64) },
      genreSkills: { "manga-video-production": { tree: SKILL_TREE, fileCount: 3, learnedOverlay: "c".repeat(64) } },
      declaredGates: DECLARATION.guarantees.map((entry) => entry.id),
    },
    gates: {
      "final-audit": { verdict: "fail", evidenceDigest: "d".repeat(64), detail: `不合格: ${SYNTHETIC_PATH}` },
      "camera-grammar": { verdict: "skip", evidenceDigest: "e".repeat(64), detail: "理由" },
      "voice-quality-gate": { verdict: "pass", evidenceDigest: "f".repeat(64), detail: "" },
    },
    summary: { failedGates: ["final-audit"], skippedGates: ["camera-grammar"], incompleteMediaJobCount: 0 },
    knownRemainingIssues: [
      `rendered-camera: ${SYNTHETIC_PATH} で揺れ`,
      `Error: ${SYNTHETIC_NAME}さんの台本「第一幕」が読めない`,
      "reviewer-trust-unconfigured: 信頼リストが無い",
    ],
    mediaJobs: [{ status: "completed", attempts: { retryCount: 2 } }, { status: "completed", attempts: { retryCount: 0 } }],
    resumeFromFailed: { attempts: 1, previousFailure: { failedStage: "production", error: `${SYNTHETIC_PATH} ENOSPC` } },
    imageRetry: { requested: true, attempts: 3 },
    ...overrides,
  };
}

function captureHarness() {
  const rows = [];
  const paths = [];
  return {
    rows,
    paths,
    options: {
      signals: { terms: [], castIds: [] },
      privateVocabulary: null,
      homeRoot: "",
      env: {},
      ledgerPathResolver: (target, kind) => {
        paths.push(kind);
        return String(target).startsWith("channel-pack:")
          ? join(tmpdir(), "synthetic-private-channel", `${kind}.jsonl`)
          : join(tmpdir(), "synthetic-public-core", "docs", "learning", `${kind}.jsonl`);
      },
      append: (_file, entry) => rows.push(entry),
      read: () => rows,
      lock: (_file, action) => action(),
      refreshCatalog: () => ({ written: false }),
    },
  };
}

test("issue の自由文からは、宣言にある id か kebab-case のコードだけを拾う", () => {
  const vocabulary = { gateIds: new Set(["final-audit"]), auditToGate: new Map([["rendered-camera", "camera-grammar"], ["perceptualReviewChecks", "x"]]) };
  assert.equal(issueCodeOf("rendered-camera: 詳細", vocabulary), "rendered-camera");
  assert.equal(issueCodeOf("perceptualReviewChecks: 詳細", vocabulary), "perceptualReviewChecks");
  assert.equal(issueCodeOf("canonical-identity-drift", vocabulary), "canonical-identity-drift");
  assert.equal(issueCodeOf(`Error: ${SYNTHETIC_NAME}`, vocabulary), "unclassified");
  assert.equal(issueCodeOf(`${SYNTHETIC_PATH}: x`, vocabulary), "unclassified");
  assert.equal(issueCodeOf("Taro: x", vocabulary), "unclassified", "宣言に無い単語は拾わない");
  assert.equal(issueCodeOf("", vocabulary), "unclassified");
});

test("Receipt からはゲート id・コード・件数だけの候補を作る（台本・パス・人名・エラー全文を運ばない）", () => {
  const digest = "1".repeat(64);
  const summary = receiptLearningCandidates({ receipt: receiptFixture(), receiptDigest: digest, receiptSource: "run-receipt", declaration: DECLARATION });
  const texts = summary.candidates.map((candidate) => candidate.text);
  const joined = texts.join("\n");
  for (const forbidden of [SYNTHETIC_PATH, "/Users/", SYNTHETIC_NAME, "第一幕", "ENOSPC", "揺れ", "信頼リスト"]) {
    assert.equal(joined.includes(forbidden), false, `本文に ${forbidden} が運ばれた`);
  }
  assert.ok(texts.some((text) => text.includes("ゲート final-audit が不合格")));
  assert.ok(texts.some((text) => text.includes("ゲート camera-grammar が測られない")));
  assert.equal(texts.some((text) => text.includes("voice-quality-gate")), false, "通ったゲートは積まない");
  assert.ok(texts.some((text) => text.includes("「rendered-camera」")));
  assert.ok(texts.some((text) => text.includes("「reviewer-trust-unconfigured」")));
  assert.ok(texts.some((text) => text.includes("「unclassified」")));
  assert.ok(texts.some((text) => text.includes("failed から再開された（落ちた工程: production）")));
  assert.ok(texts.some((text) => text.includes("Media Job の再送")));
  assert.ok(texts.some((text) => text.includes("画像の作り直し")));
  assert.ok(texts.some((text) => text.includes("実測で fail に直された")));
  // 監査 id の issue は、それを裏づける保証へ結び付ける（減衰の判定で使う）。
  const rendered = summary.candidates.find((candidate) => candidate.text.includes("「rendered-camera」"));
  assert.deepEqual(rendered.gateIds, ["camera-grammar", "rendered-camera"]);
  const media = summary.candidates.find((candidate) => candidate.text.includes("再送"));
  assert.equal(media.count, 2);
  assert.deepEqual(summary.skillShaAtCapture, { "manga-video-production": SKILL_TREE });
  // 件数は本文に入れない（同じ観測を別の Receipt から拾ったとき同じ提案として数えるため）。
  assert.equal(texts.some((text) => /\d+ ?件/u.test(text)), false);
});

test("全部通った Run からは何も積まない（提案ゼロを正常とする）", () => {
  const passing = receiptFixture({
    outcome: "pass",
    outcomeOverridden: false,
    gates: { "final-audit": { verdict: "pass" } },
    summary: { failedGates: [], skippedGates: [], incompleteMediaJobCount: 0 },
    knownRemainingIssues: [],
    mediaJobs: [{ status: "completed", attempts: { retryCount: 0 } }],
    resumeFromFailed: undefined,
    imageRetry: undefined,
  });
  const summary = receiptLearningCandidates({ receipt: passing, receiptDigest: "2".repeat(64), receiptSource: "run-receipt", declaration: DECLARATION });
  assert.deepEqual(summary.candidates, []);
});

test("決着した Job の Receipt から Channel Pack 宛の台帳へ追記し、同じ Receipt からは二重に積まない", async () => {
  const dir = mkdtempSync(join(tmpdir(), "receipt-learning-"));
  try {
    const receiptPath = join(dir, "run-receipt.json");
    const bytes = `${JSON.stringify(receiptFixture(), null, 2)}\n`;
    writeFileSync(receiptPath, bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const job = {
      id: "video-synthetic-0123456789abcdef",
      status: "completed",
      revision: 7,
      harness: { id: "koya-manga-video", declarationVersion: "1.1.0" },
      artifacts: [{ kind: "run-receipt", path: receiptPath, sha256: digest }],
      knownRemainingIssues: [],
    };
    const { rows, paths, options } = captureHarness();
    const first = await captureSettledJobLearning({ receiptIndexPath: TEST_RECEIPT_INDEX, job, env: {}, captureOptions: options, now: () => "2026-09-24T01:00:00.000Z" });
    assert.equal(first.skippedReason, undefined);
    assert.equal(first.receiptSource, "run-receipt");
    assert.equal(first.target, "channel-pack:koya");
    assert.ok(first.captured >= 8, `捕捉件数が少ない: ${first.captured}`);
    assert.equal(rows.length, first.captured);
    assert.deepEqual([...new Set(paths)], ["proposals"], "提案台帳以外（applied・正本・overlay）へ書こうとした");
    for (const row of rows) {
      assert.equal(row.createdBy, AUTO_RECEIPT_CREATOR);
      assert.equal(row.receiptDigest, digest);
      assert.equal(row.receiptSource, "run-receipt");
      assert.equal(row.target, "channel-pack:koya");
      assert.equal(row.kind, "fact");
      assert.equal(row.session, `auto-receipt:${digest.slice(0, 32)}`);
      assert.deepEqual(row.skillShaAtCapture, { "manga-video-production": SKILL_TREE });
      assert.deepEqual(row.harness, { id: "koya-manga-video", version: "1.1.0" });
      assert.equal(row.id, proposalId(row), "ID は kind+target+text から作る（付帯情報は入れない）");
      assert.equal(row.blocked, undefined, "自動捕捉の本文が検査に当たった");
      const serialized = JSON.stringify(row);
      assert.equal(serialized.includes(SYNTHETIC_PATH) || serialized.includes(SYNTHETIC_NAME) || serialized.includes(dir), false);
      assert.match(row.evidence, /^auto-receipt-v1 source=run-receipt receipt=[a-f0-9]{16} outcome=fail harness=koya-manga-video@1\.1\.0 count=\d+$/u);
    }
    const second = await captureSettledJobLearning({ receiptIndexPath: TEST_RECEIPT_INDEX, job, env: {}, captureOptions: options, now: () => "2026-09-24T02:00:00.000Z" });
    assert.equal(second.captured, 0);
    assert.equal(second.duplicates, first.captured);
    assert.equal(rows.length, first.captured, "同じ Receipt から二重に積んだ");

    // 別の Receipt で同じゲートが落ちれば、同じ提案IDの別 session として再発に数えられる。
    const otherBytes = `${JSON.stringify(receiptFixture({ finalizedAt: "2026-09-25T00:00:00.000Z" }), null, 2)}\n`;
    const otherPath = join(dir, "run-receipt-2.json");
    writeFileSync(otherPath, otherBytes);
    const otherDigest = createHash("sha256").update(otherBytes).digest("hex");
    const third = await captureSettledJobLearning({ receiptIndexPath: TEST_RECEIPT_INDEX,
      job: { ...job, artifacts: [{ kind: "run-receipt", path: otherPath, sha256: otherDigest }] },
      env: {}, captureOptions: options,
    });
    assert.equal(third.captured, first.captured);
    const finalAuditIds = new Set(rows.filter((row) => row.text.includes("final-audit が不合格")).map((row) => row.id));
    assert.equal(finalAuditIds.size, 1, "同じゲートの不合格が別の提案として増えた");

    // Job の記録と SHA が合わない Receipt は材料にしない（completed なのに読めない＝推測で埋めない）。
    const mismatch = await captureSettledJobLearning({ receiptIndexPath: TEST_RECEIPT_INDEX,
      job: { ...job, artifacts: [{ kind: "run-receipt", path: receiptPath, sha256: "9".repeat(64) }] },
      env: {}, captureOptions: options,
    });
    assert.equal(mismatch.skippedReason, "receipt-unreadable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed / awaiting-human-review も捕捉する（adapter の Receipt、無ければ Job の状態）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "receipt-learning-failed-"));
  try {
    const adapterPath = join(dir, "adapter-run-receipt.json");
    writeFileSync(adapterPath, JSON.stringify(receiptFixture({ resumeFromFailed: undefined })));
    const failedJob = {
      id: "video-synthetic-failed-0123456789",
      status: "failed",
      revision: 3,
      updatedAt: "2026-09-24T00:00:00.000Z",
      harness: { id: "koya-manga-video" },
      adapterRunReceiptPath: adapterPath,
      blockers: ["paid-media-recovery-pending"],
      knownRemainingIssues: [`${SYNTHETIC_PATH} を書けない`],
      stages: [{ id: "production", status: "failed" }],
    };
    const { rows, options } = captureHarness();
    const failed = await captureSettledJobLearning({ receiptIndexPath: TEST_RECEIPT_INDEX, job: failedJob, env: {}, captureOptions: options });
    assert.equal(failed.receiptSource, "adapter-run-receipt");
    assert.ok(rows.some((row) => row.text.includes("「paid-media-recovery-pending」")));

    const pending = {
      id: "video-synthetic-pending-0123456789",
      status: "awaiting-human-review",
      revision: 5,
      updatedAt: "2026-09-24T03:00:00.000Z",
      harness: { id: "narrated-story-video", declarationVersion: "1.4.0", canonicalSkills: [{ id: "narrated-story-video", sha256: "4".repeat(64) }] },
      blockers: ["run-receipt-finalization-pending", "reviewer-trust-unconfigured"],
      knownRemainingIssues: ["run-receipt: reviewer-trust-unconfigured: 詳細"],
      pendingReceiptFinalization: { attempts: 2 },
    };
    const before = rows.length;
    const awaiting = await captureSettledJobLearning({ receiptIndexPath: TEST_RECEIPT_INDEX, job: pending, env: {}, captureOptions: options });
    assert.equal(awaiting.receiptSource, "job-state");
    assert.equal(awaiting.target, "channel-pack:narrated-story");
    const added = rows.slice(before);
    assert.ok(added.some((row) => row.text.includes("RunReceipt を確定できず")));
    assert.ok(added.every((row) => row.receiptDigest === jobStateDigest(pending)));
    assert.deepEqual(added[0].skillShaAtCapture, { "narrated-story-video": "4".repeat(64) });
    // 同じ Job の同じ版をもう一度見ても積まない。
    const again = await captureSettledJobLearning({ receiptIndexPath: TEST_RECEIPT_INDEX, job: pending, env: {}, captureOptions: options });
    assert.equal(again.captured, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("子エージェント・無効化・未決着・未知のハーネス・台帳が分離されていない、では書かない", async () => {
  const job = { id: "video-x", status: "failed", revision: 1, harness: { id: "koya-manga-video" }, blockers: ["canonical-identity-drift"] };
  let calls = 0;
  const capture = () => { calls += 1; return { appended: true, entry: { id: "0".repeat(12) } }; };
  assert.equal((await captureSettledJobLearning({ receiptIndexPath: TEST_RECEIPT_INDEX, job, env: childAgentEnvironment({}), capture })).skippedReason, "child-agent");
  assert.equal((await captureSettledJobLearning({ receiptIndexPath: TEST_RECEIPT_INDEX, job, env: { BUZZASSIST_LEARNING_AUTO_CAPTURE: "0" }, capture })).skippedReason, "disabled");
  assert.equal((await captureSettledJobLearning({ receiptIndexPath: TEST_RECEIPT_INDEX, job: { ...job, status: "cancelled" }, env: {}, capture })).skippedReason, "not-settled");
  assert.equal((await captureSettledJobLearning({ receiptIndexPath: TEST_RECEIPT_INDEX, job: { ...job, harness: { id: "unknown-harness" } }, env: {}, capture })).skippedReason, "unknown-harness-route");
  assert.equal(calls, 0);

  // Channel Pack の台帳が共有台帳と分離されていなければ、Job を止めずに理由だけ返す。
  const { options } = captureHarness();
  const sameLedger = { ...options, ledgerPathResolver: () => join(tmpdir(), "synthetic-shared", "proposals.jsonl") };
  const result = await captureSettledJobLearning({ receiptIndexPath: TEST_RECEIPT_INDEX, job, env: {}, captureOptions: sameLedger, locateReceipt: async () => null });
  assert.equal(result.skippedReason, "ledger-not-isolated");
  assert.equal(result.captured, 0);
});

test("提案の付帯情報は形を固定し、自由文を運ばせない", async () => {
  const { normalizeProposalMetadata } = await import("../scripts/harness-learn.mjs");
  assert.deepEqual(normalizeProposalMetadata(undefined), {});
  assert.throws(() => normalizeProposalMetadata({ note: "自由文" }), /未知のキー/u);
  assert.throws(() => normalizeProposalMetadata({ createdBy: "someone" }), /既知の捕捉経路/u);
  assert.throws(() => normalizeProposalMetadata({ receiptDigest: "not-a-sha" }), /sha256/u);
  assert.throws(() => normalizeProposalMetadata({ gateIds: [`${SYNTHETIC_PATH}`] }), /ゲート id/u);
  assert.throws(() => normalizeProposalMetadata({ skillShaAtCapture: { [SYNTHETIC_NAME]: SKILL_TREE } }), /スキル名/u);
  assert.deepEqual(
    normalizeProposalMetadata({ createdBy: "auto-receipt", gateIds: ["b-gate", "a-gate", "a-gate"] }),
    { createdBy: "auto-receipt", gateIds: ["a-gate", "b-gate"] },
  );
});

test("既定の捕捉関数は harness-learn の唯一の追記経路を使う", async () => {
  // 別の追記経路を作ると、書き込み前の検査・語彙照合・子エージェントの印・重複検査を迂回できる。
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../lib/harnessReceiptLearning.mjs", import.meta.url), "utf8");
  assert.match(source, /capture = captureLearningProposal/u);
  assert.equal(/appendFile|writeFile|appendJsonl/u.test(source), false, "自動捕捉が台帳へ直接書いている");
  assert.equal(typeof captureLearningProposal, "function");
});
