// 台本の品質ループの採点まわり: 採点の目安（anchors）・元の依頼の固定（start --request）・止める前の目的の判定
// （acceptance.goalCheck と goal-check）の試験。台本・依頼・会話 id はすべて合成の値で、モデルも有料 API も呼ばない。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkScriptQualityBeforeProduction } from "../lib/scriptQualityUseGate.mjs";
import {
  SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION,
  createScriptQualityContract,
  normalizeScriptChannelConfig,
  recordScriptGoalCheck,
  recordScriptQualityRound,
  scriptQualityContractSummary,
  scriptQualityGoalCheckSheet,
  scriptQualityPaths,
  scriptQualityReviewSheet,
  scriptQualityReviewTemplate,
  scriptQualityStatus,
  scriptQualityVerdict,
  startScriptQualityLoop,
  stopScriptQualityLoop,
} from "../lib/scriptQualityLoop.mjs";
import { runScriptQualityCli } from "../scripts/script-quality-loop.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const DRAFT = "「合成の冒頭の台詞」\n合成の地の文。\n";
const REVISED = "「合成の冒頭の台詞」\n合成の地の文に、依頼の結論を足した。\n";
const REQUEST = { version: "synthetic-brief-v1", audience: "合成の視聴者", goal: "合成の結論を最後に届ける", doneWhen: "結論の一文が締めにある" };
const WRITER = "ctx-writer-1";

let clock = Date.parse("2026-09-27T00:00:00.000Z");
const now = () => {
  clock += 60_000;
  return new Date(clock).toISOString();
};

const { contract: DEFAULT_CONTRACT } = createScriptQualityContract();
const scores = (overrides = {}) => Object.fromEntries(DEFAULT_CONTRACT.rubric.map((row) => [
  row.id,
  overrides[row.id] ?? (row.id === "review-first-person-marker" ? 100 : 96),
]));

async function workspace(t, { request = true, config = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "script-quality-goal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "quality", "reviews"), { recursive: true });
  if (request) await writeFile(join(root, "brief.json"), `${JSON.stringify(REQUEST, null, 2)}\n`);
  if (config) await writeFile(join(root, "script-quality.json"), JSON.stringify({ version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION, ...config }));
  return root;
}

async function writeJson(root, rel, body) {
  await writeFile(join(root, rel), `${JSON.stringify(body, null, 2)}\n`);
  return rel;
}

function review({ context, script, base = undefined, rubricScores = scores(), requestSha256 = sha(`${JSON.stringify(REQUEST, null, 2)}\n`), findings = [] }) {
  return {
    evaluatorId: "evaluator",
    evaluatorContextId: context,
    evaluatorHost: "codex",
    scriptSha256: sha(script),
    ...(base === undefined ? {} : { baseScriptSha256: sha(base) }),
    ...(requestSha256 ? { requestSha256 } : {}),
    rubricScores,
    notes: `元の依頼と全行を読んだ所見（${context}）`,
    findings,
  };
}

const REQUEST_SHA = sha(`${JSON.stringify(REQUEST, null, 2)}\n`);

test("採点の目安は Pack のチャンネルの項目とジャンルの項目の両方に書け、評価シートに載り、契約の digest に入る（合格点・重み・下限は載せない）", () => {
  const config = {
    version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION,
    criteria: [{
      id: "closing-line",
      label: "締めの一文",
      weight: 10,
      minimumScore: 70,
      description: "締めに結論の一文がある",
      anchors: [{ score: 60, state: "締めはあるが結論がぼやける" }, { score: 95, state: "結論の一文が締めにあり言い切っている" }],
    }],
    anchors: {
      "narration-voice": [{ score: 90, state: "1行1文で耳で聞いて自然" }, { score: 50, state: "説明の繰り返しが3か所以上ある" }],
    },
  };
  const { contract, blockers } = createScriptQualityContract({ channelConfig: config, channelSource: { kind: "unsigned-file", configSha256: sha("x") } });
  assert.deepEqual(blockers, []);
  const row = (id) => contract.rubric.find((entry) => entry.id === id);
  // 点の高い順に並ぶ。
  assert.deepEqual(row("closing-line").anchors.map((anchor) => anchor.score), [95, 60]);
  assert.deepEqual(row("narration-voice").anchors.map((anchor) => anchor.score), [90, 50]);
  assert.equal(Object.hasOwn(row("beat-structure"), "anchors"), false, "目安の無い項目の形は変えない");
  const without = createScriptQualityContract({ channelConfig: { ...config, anchors: undefined, criteria: [{ ...config.criteria[0], anchors: undefined }] }, channelSource: { kind: "unsigned-file", configSha256: sha("x") } }).contract;
  assert.notEqual(contract.digest, without.digest, "目安は契約の digest に入る（走行中に変えられない）");

  const sheet = scriptQualityReviewSheet(contract);
  const sheetRow = (id) => sheet.rubric.find((entry) => entry.id === id);
  assert.deepEqual(sheetRow("closing-line").anchors, row("closing-line").anchors);
  assert.deepEqual(sheetRow("narration-voice").anchors, row("narration-voice").anchors);
  assert.doesNotMatch(JSON.stringify(sheet), /targetScore|minimumScore|"weight"|minimumImprovement/u);
  assert.match(sheet.instructions, /絶対評価/u);
  // 運営者向けの表には目安も最小改善も出る。
  const summary = scriptQualityContractSummary(contract);
  assert.equal(summary.minimumImprovement, 5);
  assert.equal(summary.goalCheck, false);
  assert.deepEqual(summary.rubric.find((entry) => entry.id === "closing-line").anchors, row("closing-line").anchors);

  const blocked = (extra) => normalizeScriptChannelConfig({ version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION, ...extra }).blockers;
  // 合否の線を目安に書かない（評価シートに合格点・下限を載せない決まりと同じ理由）。
  assert.deepEqual(blocked({ anchors: { "narration-voice": [{ score: 70, state: "ここが合格の線" }] } }), ["script-quality.anchors.narration-voice.pass-line-mentioned"]);
  assert.deepEqual(blocked({ anchors: { "narration-voice": [{ score: 70, state: "足切りの状態" }] } }), ["script-quality.anchors.narration-voice.pass-line-mentioned"]);
  assert.deepEqual(blocked({ anchors: { "narration-voice": [{ score: 70, state: "同じ点その1" }, { score: 70, state: "同じ点その2" }] } }), ["script-quality.anchors.narration-voice.score"]);
  assert.deepEqual(blocked({ anchors: { "narration-voice": [{ score: 70.5, state: "整数でない点" }] } }), ["script-quality.anchors.narration-voice.score"]);
  assert.deepEqual(blocked({ anchors: { "narration-voice": [{ score: 70, state: "短" }] } }), ["script-quality.anchors.narration-voice.state"]);
  assert.deepEqual(blocked({ anchors: { "narration-voice": [] } }), ["script-quality.anchors.narration-voice"]);
  assert.deepEqual(blocked({ anchors: { "narration-voice": [{ score: 70, state: "余計な鍵がある", note: "x" }] } }), ["script-quality.anchors.narration-voice"]);
  assert.deepEqual(blocked({ anchors: { "no-such": [{ score: 70, state: "無い項目の目安" }] } }), ["script-quality.anchors.no-such-unknown"]);
  assert.deepEqual(blocked({ anchors: [] }), ["script-quality.anchors"]);
  assert.deepEqual(blocked({ criteria: [{ ...config.criteria[0], anchors: [{ score: 50, state: "下限の状態" }] }] }), ["script-quality.criteria.closing-line.anchors.pass-line-mentioned"]);
});

test("start --request で元の依頼を SHA で固定し、毎回の評価シートに本文を載せ、採点ファイルに依頼の SHA を求め、依頼が変わったら記録しない", async (t) => {
  const root = await workspace(t);
  // 作業フォルダの外の依頼は受けない（状態は作業フォルダからの相対パスで残す）。
  await assert.rejects(startScriptQualityLoop({ workDir: root, generatorContextId: WRITER, requestPath: join(root, "..", "outside.json"), now }), /作業フォルダの中/u);
  const started = await startScriptQualityLoop({ workDir: root, generatorContextId: WRITER, requestPath: "brief.json", now });
  assert.equal(started.started, true);
  assert.deepEqual(started.state.script.request, { path: "brief.json", sha256: REQUEST_SHA, bytes: Buffer.byteLength(`${JSON.stringify(REQUEST, null, 2)}\n`), format: "json", pinnedAt: started.state.script.request.pinnedAt });
  assert.deepEqual(started.sheet.originalRequest.content, REQUEST);
  // 状態に依頼の本文は持たない。
  assert.equal((await readFile(scriptQualityPaths(root).statePath, "utf8")).includes("合成の結論"), false);

  await writeFile(join(root, "draft.md"), DRAFT);
  const template = await scriptQualityReviewTemplate({ workDir: root, scriptPath: "draft.md" });
  assert.deepEqual(template.sheet.originalRequest.content, REQUEST);
  assert.equal(template.sheet.originalRequest.sha256, REQUEST_SHA);
  assert.equal(template.template.requestSha256, REQUEST_SHA);
  assert.match(template.sheet.instructions, /元の依頼/u);

  const attempt = async (name, body) => recordScriptQualityRound({ workDir: root, scriptPath: "draft.md", versionLabel: "v1", stage: "draft", reviewPath: await writeJson(root, `quality/reviews/${name}.json`, body), now });
  assert.deepEqual((await attempt("missing", review({ context: "ctx-eval-1", script: DRAFT, requestSha256: "" }))).issues, ["script-quality-review-request-missing"]);
  assert.deepEqual((await attempt("wrong", review({ context: "ctx-eval-1", script: DRAFT, requestSha256: sha("別の依頼") }))).issues, ["script-quality-review-request-mismatch"]);
  const first = await attempt("r1", review({ context: "ctx-eval-1", script: DRAFT, rubricScores: scores({ "narration-voice": 50 }) }));
  assert.equal(first.recorded, true);
  assert.ok(first.round.evidence.some((row) => row.path === "brief.json" && row.sha256 === REQUEST_SHA), "回の証跡に渡した依頼が残る");

  // 依頼のファイルが途中で変わったら、シートも出さず、記録もしない。
  await writeFile(join(root, "brief.json"), JSON.stringify({ ...REQUEST, goal: "書き換えた目的" }));
  await writeFile(join(root, "revised.md"), REVISED);
  await assert.rejects(scriptQualityReviewTemplate({ workDir: root, scriptPath: "revised.md", stage: "revision" }), /script-quality-request-changed/u);
  const changed = await recordScriptQualityRound({
    workDir: root, scriptPath: "revised.md", versionLabel: "v2", stage: "revision", revisionDelta: "語り口を直した",
    reviewPath: await writeJson(root, "quality/reviews/r2.json", review({ context: "ctx-eval-2", script: REVISED, base: DRAFT })), now,
  });
  assert.deepEqual(changed.issues, ["script-quality-request-changed"]);
  assert.match(changed.detail, /--restart/u);
  const status = await scriptQualityStatus({ workDir: root });
  assert.ok(status.issues.includes("script-quality-request-changed"));
  assert.equal((await readFile(scriptQualityPaths(root).statePath, "utf8")).includes("\"v2\""), false, "変わった依頼では回を足さない");
});

test("始め直しで --request を省くと前のループの依頼を持ち越し、そのファイルが変わっていれば固定し直すまで始めない", async (t) => {
  const root = await workspace(t);
  await startScriptQualityLoop({ workDir: root, generatorContextId: WRITER, requestPath: "brief.json", now });
  await stopScriptQualityLoop({ workDir: root, reviewer: "operator", reason: "方向を変えると決めた", humanVerified: true, isInteractive: true, now, attest: () => ({ ok: true, attestation: { reviewer: "operator", attestedBy: "human-verified" } }) });
  const carried = await startScriptQualityLoop({ workDir: root, generatorContextId: "ctx-writer-2", restart: true, restartReason: "同じ依頼で始め直す", now });
  assert.equal(carried.started, true);
  assert.equal(carried.state.script.request.sha256, REQUEST_SHA);
  await stopScriptQualityLoop({ workDir: root, reviewer: "operator", reason: "依頼を書き換えると決めた", humanVerified: true, isInteractive: true, now, attest: () => ({ ok: true, attestation: { reviewer: "operator", attestedBy: "human-verified" } }) });
  await writeFile(join(root, "brief.json"), JSON.stringify({ ...REQUEST, goal: "新しい目的" }));
  const refused = await startScriptQualityLoop({ workDir: root, generatorContextId: "ctx-writer-3", restart: true, restartReason: "依頼を書き換えた", now });
  assert.equal(refused.started, false);
  assert.deepEqual(refused.issues, ["script-quality-request-changed"]);
  const repinned = await startScriptQualityLoop({ workDir: root, generatorContextId: "ctx-writer-3", restart: true, restartReason: "依頼を書き換えた", requestPath: "brief.json", now });
  assert.equal(repinned.started, true);
  assert.equal(repinned.state.script.request.sha256, sha(JSON.stringify({ ...REQUEST, goal: "新しい目的" })));
});

async function goalLoop(t) {
  const root = await workspace(t, { config: { acceptance: { goalCheck: true } } });
  const channelConfig = join(root, "script-quality.json");
  const started = await startScriptQualityLoop({ workDir: root, generatorContextId: WRITER, channelConfig, requestPath: "brief.json", now });
  assert.equal(started.started, true);
  await writeFile(join(root, "draft.md"), DRAFT);
  const reached = await recordScriptQualityRound({
    workDir: root, scriptPath: "draft.md", versionLabel: "v1", stage: "draft", producerContexts: ["ctx-helper"],
    reviewPath: await writeJson(root, "quality/reviews/r1.json", review({ context: "ctx-eval-1", script: DRAFT })), now,
  });
  return { root, channelConfig, reached };
}

function judgement({ context, script = DRAFT, verdict, reason, evaluatorId = "goal-judge" }) {
  return { evaluatorId, evaluatorContextId: context, evaluatorHost: "claude-code", scriptSha256: sha(script), requestSha256: REQUEST_SHA, verdict, reason };
}

test("goalCheck の Pack は元の依頼が無いと始めず、合格点に届いた版をすぐ合格にせず目的の判定を待つ（verdict と制作の関門も通さない）", async (t) => {
  const noRequest = await workspace(t, { request: false, config: { acceptance: { goalCheck: true } } });
  const refused = await startScriptQualityLoop({ workDir: noRequest, generatorContextId: WRITER, channelConfig: join(noRequest, "script-quality.json"), now });
  assert.equal(refused.started, false);
  assert.deepEqual(refused.issues, ["script-quality-goal-check-request-required"]);
  assert.equal(normalizeScriptChannelConfig({ version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION, acceptance: { goalCheck: "yes" } }).blockers.includes("script-quality.acceptance.goalCheck"), true);

  const { root, reached } = await goalLoop(t);
  assert.equal(reached.recorded, true);
  assert.equal(reached.state.status, "awaiting-goal-check");
  assert.equal(reached.check.pass, false);
  assert.deepEqual(reached.issues, ["script-quality-goal-check-required:round-1"]);
  assert.match(reached.detail, /goal-check/u);
  const verdict = await scriptQualityVerdict({ workDir: root, scriptPath: "draft.md" });
  assert.equal(verdict.pass, false);
  assert.equal(verdict.reasonCode, "script-quality-goal-check-pending");
  const gate = await checkScriptQualityBeforeProduction({ workDir: root, scriptPath: join(root, "draft.md"), genre: "narrated-story" });
  assert.equal(gate.pass, false);
  assert.deepEqual(gate.issues, ["script-quality-required:script-quality-goal-check-pending"]);
  assert.ok(gate.next.some((line) => line.includes("goal-check")));
  // 判定待ちのループには版を足せない（判定が先）。
  await writeFile(join(root, "revised.md"), REVISED);
  const blocked = await recordScriptQualityRound({
    workDir: root, scriptPath: "revised.md", versionLabel: "v2", stage: "revision", revisionDelta: "足した",
    reviewPath: await writeJson(root, "quality/reviews/r2.json", review({ context: "ctx-eval-2", script: REVISED, base: DRAFT })), now,
  });
  assert.equal(blocked.recorded, false);
  // 目的の判定のシートには、元の依頼と台本だけを載せ、点数・合格点・評価項目は載せない。
  const { sheet, template } = await scriptQualityGoalCheckSheet({ workDir: root });
  assert.deepEqual(sheet.originalRequest.content, REQUEST);
  assert.equal(sheet.script.sha256, sha(DRAFT));
  assert.equal(template.scriptSha256, sha(DRAFT));
  assert.equal(template.requestSha256, REQUEST_SHA);
  assert.doesNotMatch(JSON.stringify(sheet), /targetScore|minimumScore|"weight"|"score"|rubric|findings/u);
  // 判定待ちのループも、人は採点なしで止められる。止めても合格にはならない。
  const stopped = await stopScriptQualityLoop({ workDir: root, reviewer: "operator", reason: "依頼を変えると決めた", humanVerified: true, isInteractive: true, now, attest: () => ({ ok: true, attestation: { reviewer: "operator", attestedBy: "human-verified" } }) });
  assert.equal(stopped.stopped, true);
  assert.equal((await scriptQualityVerdict({ workDir: root, scriptPath: "draft.md" })).reasonCode, "script-quality-stopped");
});

test("目的の判定: 作成・採点に使った文脈は判定できず、not-achieved は理由を指摘として戻し、次の版は採否と判定の指紋が要り、achieved で合格する", async (t) => {
  const { root } = await goalLoop(t);
  const judge = async (name, body) => recordScriptGoalCheck({ workDir: root, reviewPath: await writeJson(root, `quality/reviews/${name}.json`, body), now });
  const reason = "依頼の結論（締めの一文）が台本に無い。締めに結論の一文を足す";
  assert.deepEqual((await judge("g-writer", judgement({ context: WRITER, verdict: "not-achieved", reason }))).issues, ["script-quality-goal-check-evaluator-not-independent"]);
  assert.deepEqual((await judge("g-helper", judgement({ context: "ctx-helper", verdict: "not-achieved", reason }))).issues, ["script-quality-goal-check-evaluator-not-independent"]);
  assert.deepEqual((await judge("g-scorer", judgement({ context: "ctx-eval-1", verdict: "not-achieved", reason }))).issues, ["script-quality-goal-check-evaluator-not-independent"]);
  assert.deepEqual((await judge("g-role", judgement({ context: "ctx-goal-x", verdict: "not-achieved", reason, evaluatorId: "script-writer" }))).issues, ["script-quality-goal-check-evaluator-not-independent"]);
  assert.deepEqual((await judge("g-script", judgement({ context: "ctx-goal-1", script: REVISED, verdict: "not-achieved", reason }))).issues, ["script-quality-goal-check-script-mismatch"]);
  assert.deepEqual((await judge("g-verdict", judgement({ context: "ctx-goal-1", verdict: "almost", reason }))).issues, ["script-quality-goal-check-verdict-invalid"]);
  assert.deepEqual((await judge("g-reason", judgement({ context: "ctx-goal-1", verdict: "achieved", reason: "" }))).issues, ["script-quality-goal-check-reason-required"]);

  const reopened = await judge("g1", judgement({ context: "ctx-goal-1", verdict: "not-achieved", reason }));
  assert.equal(reopened.recorded, true);
  assert.equal(reopened.state.status, "active");
  assert.equal(reopened.state.rounds.length, 1, "判定は回に数えない");
  const fingerprint = reopened.goalCheck.failureFingerprint;
  assert.match(fingerprint, /^goal-check:/u);
  assert.deepEqual(reopened.issues.slice(0, 1), [`script-quality-goal-not-achieved:${fingerprint}`]);
  assert.deepEqual(reopened.check.pendingFindingIds, ["r1-f1"]);
  assert.equal(reopened.check.failureFingerprint, fingerprint);
  // 同じ判定ファイルでの再実行は記録し直さない。
  assert.equal((await recordScriptGoalCheck({ workDir: root, reviewPath: "quality/reviews/g1.json", now })).alreadyRecorded, true);
  // 差し戻しの理由は次の版の採点表に「前の回の指摘」として出る。
  await writeFile(join(root, "revised.md"), REVISED);
  const template = await scriptQualityReviewTemplate({ workDir: root, scriptPath: "revised.md", stage: "revision" });
  assert.deepEqual(template.template.previousFindings, [{ id: "r1-f1", text: reason }]);

  const record = async (name, body, extra = {}) => recordScriptQualityRound({
    workDir: root, scriptPath: "revised.md", versionLabel: "v2", stage: "revision",
    reviewPath: await writeJson(root, `quality/reviews/${name}.json`, body), now, ...extra,
  });
  // 採否が無ければ記録しない。判定の文脈は採点にも使えない。
  const noDisposition = await record("r2a", review({ context: "ctx-eval-2", script: REVISED, base: DRAFT }), { revisionDelta: "締めに結論の一文を足した" });
  assert.deepEqual(noDisposition.issues, ["script-quality-finding-dispositions-required:r1-f1"]);
  await writeJson(root, "quality/dispositions.json", [{ findingId: "r1-f1", decision: "adopted", reason: "締めに結論の一文を足した" }]);
  const reusedJudge = await record("r2b", review({ context: "ctx-goal-1", script: REVISED, base: DRAFT }), { revisionDelta: "締めに結論の一文を足した", findingDispositionsPath: "quality/dispositions.json" });
  assert.deepEqual(reusedJudge.issues, ["script-quality-fresh-review-required"]);
  // 修正内容のファイルは、判定の指紋を「直した失敗」として指す。
  await writeJson(root, "quality/script-revision-delta.json", { previousFailureFingerprint: fingerprint, revisionDelta: "締めに結論の一文を足した" });
  const second = await record("r2", review({ context: "ctx-eval-2", script: REVISED, base: DRAFT }), { findingDispositionsPath: "quality/dispositions.json" });
  assert.equal(second.recorded, true);
  assert.equal(second.round.previousFailureFingerprint, fingerprint);
  assert.equal(second.state.status, "awaiting-goal-check");

  // 前の判定の文脈は次の判定に使えない。新しい文脈の achieved で合格する。
  assert.deepEqual((await judge("g2-reused", judgement({ context: "ctx-goal-1", script: REVISED, verdict: "achieved", reason: "締めに結論がある" }))).issues, ["script-quality-goal-check-evaluator-not-independent"]);
  const passed = await judge("g2", judgement({ context: "ctx-goal-2", script: REVISED, verdict: "achieved", reason: "締めの一文で依頼の結論が届く" }));
  assert.equal(passed.recorded, true);
  assert.equal(passed.state.status, "passed");
  assert.equal(passed.check.pass, true);
  const verdict = await scriptQualityVerdict({ workDir: root, scriptPath: "revised.md" });
  assert.equal(verdict.pass, true);
  assert.equal(verdict.reasonCode, "script-quality-passed");

  // 目的の判定の記録を消して「合格」と書いた状態は、制作に通さない。
  const statePath = scriptQualityPaths(root).statePath;
  const state = JSON.parse(await readFile(statePath, "utf8"));
  await writeFile(statePath, JSON.stringify({ ...state, goalChecks: state.goalChecks.slice(0, 1) }));
  const forged = await scriptQualityVerdict({ workDir: root, scriptPath: "revised.md" });
  assert.equal(forged.pass, false);
  assert.equal(forged.reasonCode, "script-quality-state-inconsistent");
  assert.ok(forged.problems.includes("goal-check"));
});

test("CLI: goal-sheet と goal-check があり、判定待ちでない goal-sheet は例外、人待ちの goal-check は終了コード 3", async (t) => {
  const { root } = await goalLoop(t);
  const out = [];
  const stdout = { write: (text) => out.push(text) };
  const sheet = await runScriptQualityCli(["goal-sheet", "--work-dir", root], { stdout, now });
  assert.equal(sheet.exitCode, 0);
  assert.match(out.join(""), /originalRequest/u);
  await writeJson(root, "quality/reviews/g-cli-bad.json", judgement({ context: "ctx-eval-1", verdict: "achieved", reason: "結論が届く" }));
  assert.equal((await runScriptQualityCli(["goal-check", "--work-dir", root, "--review", "quality/reviews/g-cli-bad.json"], { stdout, now })).exitCode, 3);
  await writeJson(root, "quality/reviews/g-cli.json", judgement({ context: "ctx-goal-cli", verdict: "achieved", reason: "結論が届く" }));
  assert.equal((await runScriptQualityCli(["goal-check", "--work-dir", root, "--review", "quality/reviews/g-cli.json"], { stdout, now })).exitCode, 0);
  await assert.rejects(runScriptQualityCli(["goal-sheet", "--work-dir", root], { stdout, now }), /script-quality-goal-check-not-awaiting/u);
  const help = [];
  await runScriptQualityCli(["--help"], { stdout: { write: (text) => help.push(text) } });
  assert.match(help.join(""), /goal-check/u);
  assert.match(help.join(""), /--request/u);
});
