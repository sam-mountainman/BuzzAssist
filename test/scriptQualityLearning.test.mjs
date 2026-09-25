import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";

import { childAgentEnvironment } from "../lib/harnessLearningGuard.mjs";
import { SCRIPT_LEARNING_ROUTES } from "../lib/harnessLearningTargets.mjs";
import {
  AUTO_SCRIPT_QUALITY_CREATOR,
  captureScriptRoundLearning,
  scriptRoundLearningCandidates,
} from "../lib/scriptQualityLearning.mjs";
import { createScriptQualityContract, recordScriptQualityRound, startScriptQualityLoop } from "../lib/scriptQualityLoop.mjs";
import { captureLearningProposal, ledgerPathFor, loadTargets } from "../scripts/harness-learn.mjs";

// 台本の文・所見・会話 id はすべて合成の値。本文・所見が提案へ運ばれないことを確かめるために置く。
const sha = (value) => createHash("sha256").update(value).digest("hex");
const SCRIPT_TEXT = "「合成の冒頭の台詞」\n合成の架空の人物が語る地の文。\n";
const NOTES = "合成の所見: 三行目の台詞で読点が落ちている";
const TARGET = "channel-pack:narrated-story-script";
const { contract: CONTRACT } = createScriptQualityContract();

let clock = Date.parse("2026-09-25T00:00:00.000Z");
const now = () => {
  clock += 60_000;
  return new Date(clock).toISOString();
};

function captureHarness() {
  const rows = [];
  return {
    rows,
    options: {
      signals: { terms: [], castIds: [] },
      privateVocabulary: null,
      homeRoot: "",
      env: {},
      ledgerPathResolver: (target, kind) => (String(target).startsWith("channel-pack:")
        ? join(tmpdir(), "synthetic-private-channel", `${kind}.jsonl`)
        : join(tmpdir(), "synthetic-public-core", "docs", "learning", `${kind}.jsonl`)),
      append: (_file, entry) => rows.push(entry),
      read: () => rows,
      lock: (_file, action) => action(),
      refreshCatalog: () => ({ written: false }),
    },
  };
}

function failingRound(overrides = {}) {
  const state = {
    status: "active",
    stopReason: "",
    contractDigest: CONTRACT.digest,
    startedAt: "2026-09-25T00:00:00.000Z",
    script: { genre: "narrated-story" },
    ...overrides.state,
  };
  const round = {
    index: 2,
    score: 84.5,
    floorFailures: ["meaning-preservation"],
    failedGateIds: ["external-calls-complete"],
    failureFingerprint: "quality-failure:aaaaaaaaaaaaaaaaaaaaaaaa",
    reviewDigest: sha("review"),
    reviews: [{ notes: NOTES }],
    ...overrides.round,
  };
  const version = {
    label: "v2-rewrite",
    stage: "external-rewrite",
    scriptSha256: sha(SCRIPT_TEXT),
    rubricScores: { "beat-structure": 88, "meaning-preservation": 80, "narration-voice": 95 },
    findings: [NOTES],
    ...overrides.version,
  };
  return { state, round, version, contract: CONTRACT };
}

test("台本の学習の宛先は、非公開・人が書く台帳で、共有の learning 台帳から分かれている", () => {
  assert.equal(SCRIPT_LEARNING_ROUTES["narrated-story"], TARGET);
  const definition = loadTargets()[TARGET];
  assert.equal(definition.scope, "channel-pack");
  assert.equal(definition.mode, "review-only");
  assert.equal(definition.confidential, true);
  assert.equal(definition.overlay, undefined);
  const ledger = ledgerPathFor(TARGET);
  assert.ok(ledger.includes(["channel-packs", "narrated-story"].join(sep)), ledger);
  assert.notEqual(ledger, ledgerPathFor("genre:narrated-story-video"));
});

test("合格しなかった回からは、評価項目 id・機械ゲート id・工程・止まった理由のコードだけの候補を作る", () => {
  const input = failingRound();
  const candidates = scriptRoundLearningCandidates(input);
  const texts = candidates.map((candidate) => candidate.text).join("\n");
  for (const forbidden of ["合成の冒頭の台詞", "架空の人物", "合成の所見", "読点が落ちて", "84.5", "v2-rewrite"]) {
    assert.equal(texts.includes(forbidden), false, `本文に ${forbidden} が運ばれた`);
  }
  assert.ok(texts.includes("外部モデルの手直しの版で、評価項目 meaning-preservation が下限を割った"));
  assert.ok(texts.includes("機械ゲート external-calls-complete が落ちた"));
  assert.equal(texts.includes("目標点に届かなかった"), false, "下限割れがあれば目標未達は別に積まない");
  assert.deepEqual(candidates[0].gateIds, ["meaning-preservation"]);

  // 下限割れが無い目標未達は、いちばん低い項目を id で言う。
  const below = scriptRoundLearningCandidates(failingRound({ round: { floorFailures: [], failedGateIds: [] } }));
  assert.equal(below.length, 1);
  assert.match(below[0].text, /いちばん低い評価項目: meaning-preservation/u);

  // 止まったループは、止まった理由のコードも積む。
  const stopped = scriptRoundLearningCandidates(failingRound({ state: { status: "needs-human-approval", stopReason: "round-limit" } }));
  assert.ok(stopped.some((candidate) => candidate.text.includes("needs-human-approval（round-limit）で止まった")));

  assert.deepEqual(scriptRoundLearningCandidates(failingRound({ state: { status: "passed" } })), []);
});

test("台本の非公開台帳へ auto-script-quality として積み、同じ回からは二重に積まない", async () => {
  const harness = captureHarness();
  const input = failingRound();
  const first = await captureScriptRoundLearning({ ...input, env: {}, now, captureOptions: harness.options });
  assert.equal(first.target, TARGET);
  assert.equal(first.captured, 2);
  assert.equal(harness.rows.length, 2);
  for (const row of harness.rows) {
    assert.equal(row.target, TARGET);
    assert.equal(row.kind, "fact");
    assert.equal(row.createdBy, AUTO_SCRIPT_QUALITY_CREATOR);
    assert.equal(row.receiptSource, "script-quality-round");
    assert.equal(row.harness.id, "narrated-story-video");
    assert.match(row.evidence, /^auto-script-quality-v1 source=script-quality-round stage=external-rewrite round=2 /u);
    assert.equal(JSON.stringify(row).includes("合成の"), false, "本文・所見が台帳へ運ばれた");
  }
  const second = await captureScriptRoundLearning({ ...input, env: {}, now, captureOptions: harness.options });
  assert.equal(second.captured, 0);
  assert.equal(second.duplicates, 2);
  assert.equal(harness.rows.length, 2);

  // 別の回で同じ項目が下限を割れば、同じ提案の再発として数えられる（本文が同じ）。
  const again = await captureScriptRoundLearning({ ...failingRound({ round: { index: 3, reviewDigest: sha("other") } }), env: {}, now, captureOptions: harness.options });
  assert.equal(again.captured, 2);
  assert.equal(harness.rows[2].id, harness.rows[0].id);
});

test("子エージェント・自動捕捉の停止・合格した回では積まない", async () => {
  const harness = captureHarness();
  assert.equal((await captureScriptRoundLearning({ ...failingRound(), env: childAgentEnvironment({}), captureOptions: harness.options })).skippedReason, "child-agent");
  assert.equal((await captureScriptRoundLearning({ ...failingRound(), env: { BUZZASSIST_LEARNING_AUTO_CAPTURE: "0" }, captureOptions: harness.options })).skippedReason, "disabled");
  assert.equal((await captureScriptRoundLearning({ ...failingRound({ state: { status: "passed" } }), env: {}, captureOptions: harness.options })).skippedReason, "passed");
  assert.equal(harness.rows.length, 0);
  // 台帳が分離されていなければ、理由を返して止まる（ループの記録は変えない）。
  const refused = await captureScriptRoundLearning({
    ...failingRound(),
    env: {},
    capture: () => { throw new Error("Channel Pack proposal台帳が共有learning台帳から分離されていない。"); },
  });
  assert.equal(refused.skippedReason, "ledger-not-isolated");
});

test("品質ループの record は、合格しなかった回でだけ学習の捕捉を呼ぶ", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "script-quality-learning-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "quality", "reviews"), { recursive: true });
  await writeFile(join(root, "draft.md"), SCRIPT_TEXT);
  await startScriptQualityLoop({ workDir: root, generatorContextId: "ctx-writer", now });
  const harness = captureHarness();
  const captureLearning = (input) => captureScriptRoundLearning({ ...input, env: {}, now, captureOptions: harness.options });
  const scores = (overrides) => Object.fromEntries(CONTRACT.rubric.map((row) => [row.id, overrides[row.id] ?? (row.id === "review-first-person-marker" ? 100 : 96)]));
  const reviewFile = async (name, context, rubricScores, extra = {}) => {
    await writeFile(join(root, "quality", "reviews", `${name}.json`), JSON.stringify({
      evaluatorId: "evaluator", evaluatorContextId: context, scriptSha256: sha(SCRIPT_TEXT), rubricScores, notes: NOTES, ...extra,
    }));
    return `quality/reviews/${name}.json`;
  };
  const failed = await recordScriptQualityRound({
    workDir: root, scriptPath: "draft.md", versionLabel: "v1", stage: "draft", now, captureLearning,
    reviewPath: await reviewFile("r1", "ctx-eval-1", scores({ "reading-clarity": 40 })),
  });
  assert.equal(failed.recorded, true);
  assert.equal(failed.learning.captured, 1);
  assert.match(harness.rows[0].text, /初稿の版で、評価項目 reading-clarity が下限を割った/u);

  const revised = `${SCRIPT_TEXT}読みを直した行。\n`;
  await writeFile(join(root, "draft2.md"), revised);
  await writeFile(join(root, "quality", "reviews", "r2.json"), JSON.stringify({
    evaluatorId: "evaluator", evaluatorContextId: "ctx-eval-2", scriptSha256: sha(revised), baseScriptSha256: sha(SCRIPT_TEXT),
    // 直した版を読んだ新しい所見（前の回の所見の写しは品質ループが採点に使わない）。
    rubricScores: scores({}), notes: "合成の所見: 読みを直した版を全行読み直した",
  }));
  let called = false;
  const passed = await recordScriptQualityRound({
    workDir: root, scriptPath: "draft2.md", versionLabel: "v2", stage: "revision", now, revisionDelta: "読みが割れる語を言い換えた",
    reviewPath: "quality/reviews/r2.json", captureLearning: () => { called = true; },
  });
  assert.equal(passed.state.status, "passed");
  assert.equal(called, false);
});

test("学習の宛先が決まっていない台本のジャンル（漫画・解説動画）は、推測で別の台帳へ積まない", async () => {
  const harness = captureHarness();
  for (const genre of ["manga", "explainer"]) {
    const { contract } = createScriptQualityContract({ genre });
    const input = failingRound({ state: { script: { genre } } });
    const result = await captureScriptRoundLearning({ ...input, contract, env: {}, now, captureOptions: harness.options });
    assert.equal(result.skippedReason, "unknown-genre-route", genre);
  }
  assert.equal(harness.rows.length, 0);
});

test("台本の直し・訂正は、人が harness-learn capture で台本の非公開台帳へ積める", () => {
  const harness = captureHarness();
  const { entry, ledgerPath, appended } = captureLearningProposal({
    kind: "correction",
    target: TARGET,
    text: "読みが割れる語は、直前の地の文で読みが一意になる語に言い換える",
    evidence: "別の文脈の点検で、読みが割れる行が見つかった（合成の例）",
    session: "session-synthetic-3",
    now: now(),
  }, harness.options);
  assert.equal(appended, true);
  assert.equal(entry.target, TARGET);
  assert.ok(ledgerPath.includes("synthetic-private-channel"));
});
