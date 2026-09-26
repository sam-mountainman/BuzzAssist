// 解説動画（explainer）の台本の評価項目が、ほかのジャンルと共通の観点（面白さ・導入・分かりやすさ・テンポ・
// 内容の整合性）に対応しているか、合成のチャンネル設定（受け入れ方は既定の average）で回せるかの試験。
// 台本・会話 id はすべて合成の値で、モデルも有料 API も呼ばない。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { normalizeQualityAcceptance } from "../lib/qualityLoop.mjs";
import {
  SCRIPT_QUALITY_COMMON_PERSPECTIVES,
  SCRIPT_QUALITY_GENRES,
  createScriptQualityContract,
  loadScriptChannelConfig,
  recordScriptQualityRound,
  scriptQualityPerspectiveCoverage,
  scriptQualityReviewSheet,
  startScriptQualityLoop,
} from "../lib/scriptQualityLoop.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "explainer-channel", "script-quality.json");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const SCRIPT = "合成の冒頭: この動画が答える問いは1つ。\n合成の図解の指示: 画面に数字の表を出し、読み上げと同じ数字を示す。\n合成の本文の段。\n";

test("どのジャンルの評価項目も共通の5つの観点に対応が付き、どの項目もどれかの観点かジャンル固有の項目に入る", () => {
  assert.deepEqual(SCRIPT_QUALITY_COMMON_PERSPECTIVES.map((row) => row.label), ["面白さ", "導入", "分かりやすさ", "テンポ", "内容の整合性"]);
  for (const genre of Object.keys(SCRIPT_QUALITY_GENRES)) {
    const coverage = scriptQualityPerspectiveCoverage(genre);
    assert.deepEqual(coverage.issues, [], genre);
    for (const row of coverage.perspectives) assert.ok(row.items.length > 0, `${genre}.${row.id}`);
  }
  // 解説動画は図解と説明の対応を、分かりやすさと内容の整合性の両方で見る。テンポは専用の項目で見る。
  const explainer = Object.fromEntries(scriptQualityPerspectiveCoverage("explainer").perspectives.map((row) => [row.id, row.items]));
  assert.ok(explainer.clarity.includes("visual-narration-alignment"));
  assert.ok(explainer.consistency.includes("visual-narration-alignment"));
  assert.ok(explainer.tempo.includes("pacing"));
  assert.deepEqual(explainer.opening, ["question-clarity", "opening-promise-payoff"]);
  // 別の形式の項目（漫画の吹き出し・ナレーション物語の差し替え印）は解説動画へ持ち込まない。
  const ids = createScriptQualityContract({ genre: "explainer" }).contract.rubric.map((row) => row.id);
  for (const foreign of ["bubble-fit", "review-first-person-marker", "beat-structure"]) assert.ok(!ids.includes(foreign), foreign);
});

test("解説動画の図解と説明の対応とテンポは下限つきで、評価シートに共通の観点との対応が載る", () => {
  const { contract } = createScriptQualityContract({ genre: "explainer" });
  const row = (id) => contract.rubric.find((entry) => entry.id === id);
  assert.equal(row("visual-narration-alignment").minimumScore, 80);
  assert.equal(row("pacing").minimumScore, 60);
  assert.equal(row("evidence-scope").minimumScore, 85);
  assert.equal(Math.round(contract.rubric.reduce((sum, entry) => sum + entry.weight, 0)), 100);
  const sheet = scriptQualityReviewSheet(contract);
  assert.deepEqual(sheet.commonPerspectives.map((entry) => entry.id), ["interest", "opening", "clarity", "tempo", "consistency"]);
  // 評価者のシートには合格点・重み・下限を載せない（見ると採点がそれに寄る）。
  assert.equal(Object.hasOwn(sheet, "targetScore"), false);
  for (const row of sheet.rubric) {
    assert.equal(Object.hasOwn(row, "weight"), false, `${row.id} の重みが評価者のシートに出ている`);
    assert.equal(Object.hasOwn(row, "minimumScore"), false, `${row.id} の下限が評価者のシートに出ている`);
  }
  assert.doesNotMatch(JSON.stringify(sheet), /targetScore|minimumScore|"weight"/u);
  // 観点は契約の digest に入れない（ナレーション物語の契約の digest は変わらない）。
  assert.equal(createScriptQualityContract().contract.digest, "0f641861c34e3e9bcb0e9c63464a8f3d8e755d493823944e1d83741e6afde6d0");
});

test("合成のチャンネル設定（ジャンル explainer・受け入れ方は既定の average）: 評価者の組も each-evaluator も使わず1件で1回", async (t) => {
  const bytes = await readFile(FIXTURE);
  const config = JSON.parse(bytes.toString("utf8"));
  assert.equal(config.genre, "explainer");
  assert.equal(Object.hasOwn(config, "acceptance"), false, "受け入れ方は書かない（既定の average）");
  const { contract, blockers } = createScriptQualityContract({ genre: "explainer", channelConfig: config, channelSource: { kind: "unsigned-file", configSha256: sha(bytes) } });
  assert.deepEqual(blockers, []);
  assert.equal(Object.hasOwn(contract, "acceptance"), false);
  assert.deepEqual(normalizeQualityAcceptance(contract.acceptance), { declared: false, mode: "average", evaluators: [], minimumEvaluatorScore: null });
  assert.equal(contract.rubric.find((row) => row.id === "evidence-scope").minimumScore, 90);
  assert.equal(contract.rubric.find((row) => row.id === "visual-narration-alignment").minimumScore, 85);
  assert.equal(contract.limits.targetScore, 90);

  const loaded = await loadScriptChannelConfig({ channelConfig: FIXTURE });
  assert.equal(loaded.source.kind, "unsigned-file");
  assert.equal(loaded.source.configSha256, sha(bytes));

  // ループを始めて、1つの評価文脈の採点1件で1回になる（評価の組を待たない）。
  const root = await mkdtemp(path.join(tmpdir(), "script-quality-explainer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "drafts"), { recursive: true });
  await mkdir(path.join(root, "quality", "reviews"), { recursive: true });
  let clock = Date.parse("2026-09-26T00:00:00.000Z");
  const now = () => {
    clock += 60_000;
    return new Date(clock).toISOString();
  };
  const started = await startScriptQualityLoop({ workDir: root, genre: "explainer", generatorContextId: "ctx-writer-1", generatorHost: "claude-code", channelConfig: FIXTURE, now });
  assert.equal(started.started, true, JSON.stringify(started.issues));
  assert.equal(started.state.script.genre, "explainer");
  assert.equal(started.state.script.contract.digest, contract.digest);
  await writeFile(path.join(root, "drafts", "draft.md"), SCRIPT);
  const reviewRel = path.join("quality", "reviews", "r1.json");
  await writeFile(path.join(root, reviewRel), `${JSON.stringify({
    evaluatorId: "evaluator",
    evaluatorContextId: "ctx-eval-1",
    evaluatorHost: "codex",
    scriptSha256: sha(SCRIPT),
    rubricScores: Object.fromEntries(contract.rubric.map((row) => [row.id, 94])),
    notes: "合成: 全行を読み、図解の指示と読み上げの対応を1段ずつ確かめた",
    findings: [],
  }, null, 2)}\n`);
  const recorded = await recordScriptQualityRound({ workDir: root, scriptPath: path.join("drafts", "draft.md"), versionLabel: "v1", stage: "draft", reviewPath: reviewRel, now });
  assert.equal(recorded.recorded, true, JSON.stringify(recorded.issues));
  assert.equal(recorded.state.status, "passed");
  assert.equal(recorded.state.script.pendingPanel ?? null, null);
});
