import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createChannelPackEnvelope } from "../lib/channelPackEnvelope.mjs";
import { recordExternalCall } from "../lib/externalModelCallLedger.mjs";
import {
  SCRIPT_QUALITY_CHANNEL_CONFIG_FILE,
  SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION,
  SCRIPT_QUALITY_LIMIT_DEFAULTS,
  createScriptQualityContract,
  normalizeScriptChannelConfig,
  recordScriptQualityRound,
  resetScriptQualityCumulative,
  scriptQualityGenre,
  scriptQualityPaths,
  scriptQualityReviewTemplate,
  scriptQualityStatus,
  startScriptQualityLoop,
} from "../lib/scriptQualityLoop.mjs";
import { runScriptQualityCli } from "../scripts/script-quality-loop.mjs";

// 台本の文・会話 id・モデル id はすべて合成の値。
const sha = (value) => createHash("sha256").update(value).digest("hex");
const DRAFT = "「合成の冒頭の台詞」\n合成の地の文。\n「合成の台詞で、間を取る」\n";
const REWRITE = "「合成の冒頭の台詞」\n合成の地の文を整えた。\n「合成の台詞で間を取る」\n";
const CHECKED = "「合成の冒頭の台詞」\n合成の地の文を整えた。\n「合成の台詞で、間を取る」\n";
const WRITER = "ctx-writer-1";
const { contract: DEFAULT_CONTRACT } = createScriptQualityContract();
// 差し替え印の項目は下限 100（1文でも印が欠ければ不合格）なので、既定の採点では満点を付ける。
const scores = (overrides = {}, contract = DEFAULT_CONTRACT) => Object.fromEntries(contract.rubric.map((row) => [
  row.id,
  overrides[row.id] ?? (row.id === "review-first-person-marker" ? 100 : 96),
]));

let clock = Date.parse("2026-09-25T00:00:00.000Z");
const now = () => {
  clock += 60_000;
  return new Date(clock).toISOString();
};

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "script-quality-loop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "drafts"), { recursive: true });
  await mkdir(join(root, "quality", "reviews"), { recursive: true });
  return root;
}

async function writeReview(root, name, body) {
  const rel = `quality/reviews/${name}.json`;
  await writeFile(join(root, rel), `${JSON.stringify(body, null, 2)}\n`);
  return rel;
}

function review({ context, script, base = undefined, rubricScores = scores(), evaluatorId = "evaluator" }) {
  return {
    evaluatorId,
    evaluatorContextId: context,
    evaluatorHost: "codex",
    scriptSha256: sha(script),
    ...(base === undefined ? {} : { baseScriptSha256: sha(base) }),
    rubricScores,
    // 所見は評価ごとに違う（前の回の所見の写しは品質ループが採点に使わない）。
    notes: `全行を読み、前の版と1行ずつ比べた所見（${context}）`,
    findings: [],
  };
}

async function start(root, extra = {}) {
  return startScriptQualityLoop({ workDir: root, generatorContextId: WRITER, generatorHost: "claude-code", now, ...extra });
}

async function record(root, extra) {
  return recordScriptQualityRound({ workDir: root, now, ...extra });
}

test("ナレーション物語の台本の既定の評価項目と下限を持ち、Pack は項目を足し下限を上げることだけできる", () => {
  const ids = DEFAULT_CONTRACT.rubric.map((row) => row.id);
  assert.deepEqual(ids, ["beat-structure", "meaning-preservation", "narration-voice", "duration-fit", "review-first-person-marker", "reading-clarity"]);
  const floor = (contract, id) => contract.rubric.find((row) => row.id === id).minimumScore;
  assert.equal(floor(DEFAULT_CONTRACT, "meaning-preservation"), 90);
  assert.equal(floor(DEFAULT_CONTRACT, "review-first-person-marker"), 100);
  assert.equal(DEFAULT_CONTRACT.limits.targetScore, SCRIPT_QUALITY_LIMIT_DEFAULTS.targetScore);
  assert.equal(Math.round(DEFAULT_CONTRACT.rubric.reduce((sum, row) => sum + row.weight, 0)), 100);

  const channelConfig = {
    version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION,
    genre: "narrated-story",
    criteria: [{ id: "opening-quote-echo", label: "冒頭の台詞の回収", weight: 10, minimumScore: 80, description: "冒頭の台詞が本編で一字違わず再演される" }],
    floors: { "meaning-preservation": 95 },
    weights: { "beat-structure": 30 },
    limits: { targetScore: 92, maximumReviewRounds: 6 },
  };
  const { contract, blockers } = createScriptQualityContract({ channelConfig, channelSource: { kind: "unsigned-file", configSha256: sha("x") } });
  assert.deepEqual(blockers, []);
  assert.equal(floor(contract, "meaning-preservation"), 95);
  assert.equal(contract.rubric.find((row) => row.id === "opening-quote-echo").origin, "channel");
  assert.equal(contract.limits.targetScore, 92);
  assert.equal(contract.limits.maximumReviewRounds, 6);
  assert.notEqual(contract.digest, DEFAULT_CONTRACT.digest);
  assert.equal(contract.channelSource.kind, "unsigned-file");

  const blocked = (config) => normalizeScriptChannelConfig({ version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION, ...config }).blockers;
  assert.deepEqual(blocked({ floors: { "meaning-preservation": 50 } }), ["script-quality.floors.meaning-preservation-cannot-lower"]);
  assert.deepEqual(blocked({ floors: { "no-such": 90 } }), ["script-quality.floors.no-such-unknown"]);
  assert.deepEqual(blocked({ rubric: [] }), ["script-quality.rubric-not-replaceable"]);
  assert.deepEqual(blocked({ genre: "manga" }), ["script-quality.genre-mismatch"]);
  assert.deepEqual(blocked({ limits: { targetScore: 70 } }), ["script-quality.limits.targetScore"]);
  assert.deepEqual(blocked({ limits: { maximumReviewRounds: 2.5 } }), ["script-quality.limits.maximumReviewRounds"]);
  assert.deepEqual(blocked({ criteria: [{ id: "narration-voice", label: "x", weight: 1, minimumScore: 1, description: "説明文です" }] }), ["script-quality.criteria.narration-voice-collides-with-genre"]);
  assert.deepEqual(normalizeScriptChannelConfig({ floors: {} }).blockers, ["script-quality.version"]);
  assert.equal(createScriptQualityContract({ channelConfig: { version: "old" } }).contract, null);
});

test("初稿 → 外部モデルの手直し → 意味照合を、それぞれ別の評価文脈の採点で1回ずつ記録し、最後の版で合格する", async (t) => {
  const root = await workspace(t);
  const started = await start(root);
  assert.equal(started.started, true);

  await writeFile(join(root, "drafts/draft.md"), DRAFT);
  const round1 = await record(root, {
    scriptPath: "drafts/draft.md",
    versionLabel: "v1-draft",
    stage: "draft",
    reviewPath: await writeReview(root, "r1", review({ context: "ctx-eval-1", script: DRAFT, rubricScores: scores({ "narration-voice": 55 }) })),
  });
  assert.equal(round1.recorded, true);
  assert.equal(round1.state.status, "active");
  assert.deepEqual(round1.round.floorFailures, ["narration-voice"]);
  assert.ok(round1.round.failureFingerprint.startsWith("quality-failure:"));

  // 外部モデルの手直し。呼んだのは初稿を書いた文脈（ctx-writer-1）。
  await writeFile(join(root, "drafts/rewrite-input.md"), DRAFT);
  await writeFile(join(root, "drafts/rewrite.md"), REWRITE);
  const call = await recordExternalCall({
    ledgerPath: scriptQualityPaths(root).externalCallLedgerPath,
    host: "antigravity",
    model: "synthetic-model-high",
    purpose: "台本の語り口の手直し",
    inputPath: join(root, "drafts/rewrite-input.md"),
    outputPath: join(root, "drafts/rewrite.md"),
    callerHost: "claude-code",
    callerSession: WRITER,
    now,
  });
  const round2 = await record(root, {
    scriptPath: "drafts/rewrite.md",
    versionLabel: "v2-rewrite",
    stage: "external-rewrite",
    externalCallIds: [call.id],
    revisionDelta: "語り口を外部モデルで整えた",
    reviewPath: await writeReview(root, "r2", review({ context: "ctx-eval-2", script: REWRITE, base: DRAFT, rubricScores: scores({ "meaning-preservation": 80 }) })),
  });
  assert.equal(round2.recorded, true);
  assert.deepEqual(round2.round.floorFailures, ["meaning-preservation"]);
  assert.deepEqual(round2.round.failedGateIds, []);
  assert.equal(round2.version.baseVersion, "v1-draft");
  assert.equal(round2.version.externalCalls[0].status, "complete");
  assert.equal(round2.round.previousFailureFingerprint, round1.round.failureFingerprint);

  // 意味照合の修正は、ファイルに書いた修正内容でもよい。
  await writeFile(join(root, "script.md"), CHECKED);
  await writeFile(scriptQualityPaths(root).revisionDeltaPath, JSON.stringify({
    previousFailureFingerprint: round2.round.failureFingerprint,
    revisionDelta: "鉤括弧の中で落ちた読点を初稿どおりに戻した",
  }));
  const round3 = await record(root, {
    scriptPath: "script.md",
    versionLabel: "v3-checked",
    stage: "meaning-check",
    reviewPath: await writeReview(root, "r3", review({ context: "ctx-eval-3", script: CHECKED, base: REWRITE })),
  });
  assert.equal(round3.recorded, true);
  assert.equal(round3.state.status, "passed");
  assert.equal(round3.check.pass, true);
  assert.deepEqual(round3.issues, []);

  const status = await scriptQualityStatus({ workDir: root });
  assert.equal(status.deliverable, true);
  assert.equal(status.rounds.length, 3);
  // 合格した版の後で台本を変えたら、その合格は今の台本を保証しない。
  await writeFile(join(root, "script.md"), `${CHECKED}足した行。\n`);
  const changed = await scriptQualityStatus({ workDir: root });
  assert.equal(changed.deliverable, false);
  assert.ok(changed.issues.includes("script-quality-script-changed-after-review"));
  // 状態は作業フォルダの中に、本文を持たずに書かれている。
  const stateText = await readFile(scriptQualityPaths(root).statePath, "utf8");
  assert.equal(stateText.includes("合成の地の文"), false);
});

test("その版を作った文脈・前の回の文脈・作る係の名乗りでは採点できない（例外ではなく人待ち）", async (t) => {
  const root = await workspace(t);
  await start(root);
  await writeFile(join(root, "drafts/draft.md"), DRAFT);
  const attempt = async (name, body, extra = {}) => record(root, {
    scriptPath: "drafts/draft.md", versionLabel: "v1", stage: "draft", reviewPath: await writeReview(root, name, body), ...extra,
  });
  const sameAsWriter = await attempt("a", review({ context: WRITER, script: DRAFT }));
  assert.equal(sameAsWriter.recorded, false);
  assert.deepEqual(sameAsWriter.issues, ["script-quality-evaluator-not-independent"]);
  const producer = await attempt("b", review({ context: "ctx-helper", script: DRAFT }), { producerContexts: ["ctx-helper"] });
  assert.deepEqual(producer.issues, ["script-quality-evaluator-not-independent"]);
  const roleName = await attempt("c", review({ context: "ctx-eval-x", script: DRAFT, evaluatorId: "script-writer" }));
  assert.deepEqual(roleName.issues, ["script-quality-evaluator-not-independent"]);
  const ok = await attempt("d", review({ context: "ctx-eval-1", script: DRAFT, rubricScores: scores({ "reading-clarity": 50 }) }));
  assert.equal(ok.recorded, true);

  // 外部モデルを呼んだ文脈も「作った文脈」に数える。
  await writeFile(join(root, "drafts/in.md"), DRAFT);
  await writeFile(join(root, "drafts/rewrite.md"), REWRITE);
  const call = await recordExternalCall({
    ledgerPath: scriptQualityPaths(root).externalCallLedgerPath, host: "antigravity", model: "synthetic-model-high",
    purpose: "台本の語り口の手直し", inputPath: join(root, "drafts/in.md"), outputPath: join(root, "drafts/rewrite.md"),
    callerHost: "codex", callerSession: "ctx-caller", now,
  });
  const second = (name, context) => writeReview(root, name, review({ context, script: REWRITE, base: DRAFT }));
  const base = { scriptPath: "drafts/rewrite.md", versionLabel: "v2", stage: "external-rewrite", externalCallIds: [call.id], revisionDelta: "読みの割れる語を言い換えた" };
  assert.deepEqual((await record(root, { ...base, reviewPath: await second("e", "ctx-caller") })).issues, ["script-quality-evaluator-not-independent"]);
  assert.deepEqual((await record(root, { ...base, reviewPath: await second("f", "ctx-eval-1") })).issues, ["script-quality-fresh-review-required"]);
  const state = JSON.parse(await readFile(scriptQualityPaths(root).statePath, "utf8"));
  assert.equal(state.rounds.length, 1, "人待ちの試みは回として数えない");
});

test("採点は台本の SHA と前の版に縛られ、2回目以降は修正内容が無ければ人待ちで止まる", async (t) => {
  const root = await workspace(t);
  await start(root);
  await writeFile(join(root, "drafts/draft.md"), DRAFT);
  const mismatch = await record(root, {
    scriptPath: "drafts/draft.md", versionLabel: "v1", stage: "draft",
    reviewPath: await writeReview(root, "m", review({ context: "ctx-eval-1", script: "別の台本" })),
  });
  assert.deepEqual(mismatch.issues, ["script-quality-review-script-mismatch"]);
  const first = await record(root, {
    scriptPath: "drafts/draft.md", versionLabel: "v1", stage: "draft",
    reviewPath: await writeReview(root, "r1", review({ context: "ctx-eval-1", script: DRAFT, rubricScores: scores({ "beat-structure": 40 }) })),
  });
  assert.equal(first.recorded, true);
  // 同じ採点での再実行は記録し直さない。
  const again = await record(root, {
    scriptPath: "drafts/draft.md", versionLabel: "v1", stage: "draft", reviewPath: "quality/reviews/r1.json",
  });
  assert.equal(again.alreadyRecorded, true);

  await writeFile(join(root, "script.md"), CHECKED);
  const noBase = await record(root, {
    scriptPath: "script.md", versionLabel: "v2", stage: "revision", revisionDelta: "拍の順番を入れ替えた",
    reviewPath: await writeReview(root, "nb", review({ context: "ctx-eval-2", script: CHECKED })),
  });
  assert.deepEqual(noBase.issues, ["script-quality-review-base-missing"]);
  const wrongBase = await record(root, {
    scriptPath: "script.md", versionLabel: "v2", stage: "revision", revisionDelta: "拍の順番を入れ替えた",
    reviewPath: await writeReview(root, "wb", review({ context: "ctx-eval-2", script: CHECKED, base: REWRITE })),
  });
  assert.deepEqual(wrongBase.issues, ["script-quality-review-base-mismatch"]);
  const noDelta = await record(root, {
    scriptPath: "script.md", versionLabel: "v2", stage: "revision",
    reviewPath: await writeReview(root, "nd", review({ context: "ctx-eval-2", script: CHECKED, base: DRAFT })),
  });
  assert.deepEqual(noDelta.issues, [`script-quality-revision-delta-required:${first.round.failureFingerprint}`]);
  // 直していない（同じバイト列の）版は、別の評価者に採点し直させない。
  const unchanged = await record(root, {
    scriptPath: "drafts/draft.md", versionLabel: "v1b", stage: "revision", revisionDelta: "何も変えていない",
    reviewPath: await writeReview(root, "u", review({ context: "ctx-eval-9", script: DRAFT, base: DRAFT })),
  });
  assert.deepEqual(unchanged.issues, ["script-quality-script-unchanged:v1"]);
  const reused = await record(root, {
    scriptPath: "script.md", versionLabel: "v1", stage: "revision", revisionDelta: "拍の順番を入れ替えた",
    reviewPath: await writeReview(root, "rl", review({ context: "ctx-eval-2", script: CHECKED, base: DRAFT })),
  });
  assert.deepEqual(reused.issues, ["script-quality-version-label-reused:v1"]);
  const incomplete = await record(root, {
    scriptPath: "script.md", versionLabel: "v2", stage: "revision", revisionDelta: "拍の順番を入れ替えた",
    reviewPath: await writeReview(root, "ic", { ...review({ context: "ctx-eval-2", script: CHECKED, base: DRAFT }), rubricScores: { "beat-structure": 90 } }),
  });
  assert.ok(incomplete.issues.includes("script-quality-review-score-invalid:meaning-preservation"));
  await assert.rejects(record(root, { scriptPath: "../outside.md", versionLabel: "v9", stage: "draft", reviewPath: "quality/reviews/r1.json" }), /作業フォルダの中/u);
});

test("外部モデルの手直しの版は、呼び出しの記録が無いか未完なら機械ゲートで落ちる（満点でも合格しない）", async (t) => {
  const root = await workspace(t);
  await start(root);
  await writeFile(join(root, "drafts/rewrite.md"), REWRITE);
  const noCall = await record(root, {
    scriptPath: "drafts/rewrite.md", versionLabel: "v1", stage: "external-rewrite",
    reviewPath: await writeReview(root, "r1", review({ context: "ctx-eval-1", script: REWRITE, rubricScores: scores({}, DEFAULT_CONTRACT) })),
  });
  assert.equal(noCall.recorded, true);
  assert.equal(noCall.state.status, "active");
  assert.deepEqual(noCall.round.failedGateIds, ["external-call-recorded"]);

  await writeFile(join(root, "drafts/in.md"), DRAFT);
  await writeFile(join(root, "drafts/empty.md"), "");
  const empty = await recordExternalCall({
    ledgerPath: scriptQualityPaths(root).externalCallLedgerPath, host: "antigravity", model: "synthetic-model-high",
    purpose: "台本の語り口の手直し", inputPath: join(root, "drafts/in.md"), outputPath: join(root, "drafts/empty.md"),
    callerHost: "claude-code", callerSession: WRITER, now,
  });
  assert.equal(empty.record.status, "empty");
  await writeFile(join(root, "drafts/rewrite2.md"), `${REWRITE}追記。\n`);
  const emptyCall = await record(root, {
    scriptPath: "drafts/rewrite2.md", versionLabel: "v2", stage: "external-rewrite", externalCallIds: [empty.id],
    revisionDelta: "呼び出しを記録してやり直した",
    reviewPath: await writeReview(root, "r2", review({ context: "ctx-eval-2", script: `${REWRITE}追記。\n`, base: REWRITE })),
  });
  assert.deepEqual(emptyCall.round.failedGateIds, ["external-calls-complete"]);
  assert.equal(emptyCall.version.externalCalls[0].status, "empty");
  assert.notEqual(emptyCall.state.status, "passed");
});

test("上限の回数に届くと人待ちで止まり、止まったループには回を足せない", async (t) => {
  const root = await workspace(t);
  const configPath = join(root, "script-quality.json");
  await writeFile(configPath, JSON.stringify({ version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION, limits: { maximumReviewRounds: 2 } }));
  await start(root, { channelConfig: configPath });
  const texts = [DRAFT, REWRITE, CHECKED];
  let previous = null;
  for (const [index, text] of texts.entries()) {
    const file = `drafts/v${index + 1}.md`;
    await writeFile(join(root, file), text);
    const result = await record(root, {
      scriptPath: file, versionLabel: `v${index + 1}`, stage: index === 0 ? "draft" : "revision",
      ...(index > 0 ? { revisionDelta: "拍の位置を直した" } : {}),
      reviewPath: await writeReview(root, `r${index + 1}`, review({
        context: `ctx-eval-${index + 1}`, script: text, ...(previous ? { base: previous } : {}), rubricScores: scores({ "duration-fit": 30 }),
      })),
    });
    if (index < 2) assert.equal(result.recorded, true);
    else {
      assert.equal(result.recorded, false);
      assert.ok(result.issues.includes("script-quality-stopped:needs-human-approval:round-limit"));
    }
    previous = text;
  }
  // 止まったループは、続いているループと違って始め直せる（理由が要り、前の状態は残る）。
  await assert.rejects(start(root, { channelConfig: configPath, restart: true }), /--reason/u);
  const restarted = await start(root, { channelConfig: configPath, restart: true, restartReason: "拍の表を作り直した" });
  assert.equal(restarted.started, true);
  assert.equal(restarted.state.script.history.length, 1);
  assert.equal(restarted.state.script.history[0].status, "needs-human-approval");
  assert.equal(restarted.state.rounds.length, 0);
});

test("--restart しても同じ作業フォルダの回数・時間を持ち越し、止まる条件は累計で判定し、累計は人の確認つきの操作でだけ戻せる", async (t) => {
  const root = await workspace(t);
  const configPath = join(root, "script-quality.json");
  await writeFile(configPath, JSON.stringify({ version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION, limits: { maximumReviewRounds: 3 } }));
  await start(root, { channelConfig: configPath });
  const texts = [DRAFT, REWRITE, CHECKED, `${CHECKED}足した行。\n`];
  let previous = null;
  const recordVersion = async (index, extra = {}) => {
    const file = `drafts/v${index + 1}.md`;
    await writeFile(join(root, file), texts[index]);
    const result = await record(root, {
      scriptPath: file, versionLabel: `v${index + 1}`, stage: previous ? "revision" : "draft",
      ...(previous ? { revisionDelta: "拍の位置を直した" } : {}),
      reviewPath: await writeReview(root, `r${index + 1}`, review({
        context: `ctx-eval-${index + 1}`, script: texts[index], ...(previous ? { base: previous } : {}), rubricScores: scores({ "duration-fit": 30 }),
      })),
      ...extra,
    });
    previous = texts[index];
    return result;
  };
  await recordVersion(0);
  const blocked = await recordVersion(1, { blockingCondition: "拍の表そのものを人が見直す" });
  assert.equal(blocked.state.status, "blocked");
  const firstLoopElapsed = blocked.state.elapsedMs;

  // 始め直しても、前のループの2回を持ち越す。3回目（累計）で回数の上限に届いて止まる。
  const restarted = await start(root, { channelConfig: configPath, restart: true, restartReason: "拍の表を作り直した" });
  assert.equal(restarted.started, true);
  assert.deepEqual(restarted.state.carriedOver, { loops: 1, rounds: 2, cost: 0, elapsedMs: firstLoopElapsed, unpricedCount: 0 });
  previous = null;
  const third = await recordVersion(2);
  assert.equal(third.state.rounds.length, 1, "新しいループの回は1から数える");
  assert.equal(third.state.stopReason, "round-limit", "停止条件は累計で判定する");
  const status = await scriptQualityStatus({ workDir: root });
  assert.equal(status.check.cumulative.rounds, 3);
  assert.equal(status.check.cumulative.loops, 2);
  assert.equal(status.check.cumulative.elapsedMs, firstLoopElapsed + third.state.elapsedMs);

  // 累計が上限に届いたまま始め直しても、新しいループは始めた時点で止まっていて回を足せない。
  const refused = await start(root, { channelConfig: configPath, restart: true, restartReason: "もう一度だけ回したい" });
  assert.deepEqual(refused.issues, ["script-quality-cumulative-limit-reached:round-limit"]);
  assert.equal(refused.state.status, "needs-human-approval");
  assert.equal(refused.state.stopReason, "round-limit");
  previous = CHECKED;
  const blockedRecord = await recordVersion(3);
  assert.equal(blockedRecord.recorded, false);
  assert.ok(blockedRecord.issues.includes("script-quality-stopped:needs-human-approval:round-limit"));
  assert.equal((await runScriptQualityCli(["start", "--work-dir", root, "--generator-context", WRITER, "--channel-config", configPath, "--restart", "--reason", "もう一度"], { stdout: { write() {} }, now })).exitCode, 3);

  // 累計を戻すのは、理由と人の確認（対話端末＋--human-verified）がある明示の操作だけ。
  await assert.rejects(resetScriptQualityCumulative({ workDir: root, reviewer: "operator", reason: "上限を見直す", humanVerified: true, isInteractive: false, now }), /対話端末/u);
  const agent = await resetScriptQualityCumulative({ workDir: root, reviewer: "operator", reason: "上限を見直す", agentAttested: true, now });
  assert.equal(agent.reset, false);
  assert.deepEqual(agent.issues, ["script-quality-cumulative-reset-not-counted:agent-self-attested"]);
  await assert.rejects(resetScriptQualityCumulative({ workDir: root, reviewer: "operator", reason: "", humanVerified: true, isInteractive: true, now }), /--reason/u);
  const reset = await resetScriptQualityCumulative({ workDir: root, reviewer: "operator", reason: "拍の表を人が作り直したので数え直す", humanVerified: true, isInteractive: true, now });
  assert.equal(reset.reset, true);
  assert.equal(reset.before.rounds, 3);
  assert.equal(reset.after.rounds, 0);
  const again = await start(root, { channelConfig: configPath, restart: true, restartReason: "人が累計を戻した" });
  assert.equal(again.started, true);
  assert.deepEqual(again.issues, []);
  assert.equal(again.state.status, "active");
  assert.deepEqual(again.state.carriedOver, { loops: 0, rounds: 0, cost: 0, elapsedMs: 0, unpricedCount: 0 });
  assert.equal(again.state.script.cumulativeResets.length, 1);
  assert.equal(again.state.script.cumulativeResets[0].attestedBy, "human-verified");
  assert.equal(again.state.script.cumulativeResets[0].before.rounds, 3);
  assert.equal(again.state.script.history.length, 4, "始め直しても前のループは全部残る");
});

test("指摘に id を付け、次の版は指摘ごとの採否と理由が無ければ記録せず、採用した指摘が次の回でも出たら停滞に数える", async (t) => {
  const root = await workspace(t);
  const configPath = join(root, "script-quality.json");
  await writeFile(configPath, JSON.stringify({ version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION, limits: { maximumStagnantRounds: 1, maximumReviewRounds: 6 } }));
  await start(root, { channelConfig: configPath });
  await writeFile(join(root, "drafts/draft.md"), DRAFT);
  const failing = (overrides) => scores({ "duration-fit": 30, ...overrides });
  const first = await record(root, {
    scriptPath: "drafts/draft.md", versionLabel: "v1", stage: "draft",
    reviewPath: await writeReview(root, "r1", {
      ...review({ context: "ctx-eval-1", script: DRAFT, rubricScores: failing({ "narration-voice": 55 }) }),
      findings: ["三行目の台詞で読点が落ちている", { text: "山場が前に寄っている", criterionId: "beat-structure" }],
    }),
  });
  assert.deepEqual(first.version.findingRecords.map((row) => row.id), ["r1-f1", "r1-f2"]);
  assert.equal(first.version.findingRecords[1].criterionId, "beat-structure");
  assert.deepEqual(first.version.findings, ["三行目の台詞で読点が落ちている", "山場が前に寄っている"], "今までの文の一覧も残す");
  assert.deepEqual(first.check.pendingFindingIds, ["r1-f1", "r1-f2"]);
  const { template } = await scriptQualityReviewTemplate({ workDir: root, scriptPath: "drafts/draft.md", stage: "revision" });
  assert.deepEqual(template.previousFindings.map((row) => row.id), ["r1-f1", "r1-f2"]);

  await writeFile(join(root, "drafts/v2.md"), REWRITE);
  const secondReview = (name, findings) => writeReview(root, name, {
    ...review({ context: "ctx-eval-2", script: REWRITE, base: DRAFT, rubricScores: failing({ "narration-voice": 75 }) }), findings,
  });
  const attempt = async (extra, findings = []) => record(root, {
    scriptPath: "drafts/v2.md", versionLabel: "v2", stage: "revision", revisionDelta: "読点を戻し、語り口を整えた",
    reviewPath: await secondReview(`r2-${Math.random().toString(16).slice(2)}`, findings), ...extra,
  });
  assert.deepEqual((await attempt({})).issues, ["script-quality-finding-dispositions-required:r1-f1,r1-f2"]);
  assert.deepEqual((await attempt({ findingDispositions: [{ findingId: "r1-f1", decision: "adopted", reason: "読点を戻した" }] })).issues, ["script-quality-finding-dispositions-required:r1-f2"]);
  const noReason = await attempt({ findingDispositions: [
    { findingId: "r1-f1", decision: "adopted", reason: "読点を戻した" },
    { findingId: "r1-f2", decision: "rejected", reason: "" },
  ] });
  assert.deepEqual(noReason.issues, ["script-quality-finding-disposition-reason-required:r1-f2"]);
  const unknown = await attempt({ findingDispositions: [
    { findingId: "r1-f1", decision: "adopted", reason: "読点を戻した" },
    { findingId: "r1-f2", decision: "maybe", reason: "考え中の指摘" },
    { findingId: "r1-f9", decision: "adopted", reason: "無い指摘への採否" },
  ] });
  assert.deepEqual(unknown.issues, ["script-quality-finding-disposition-invalid:r1-f2", "script-quality-finding-disposition-unknown:r1-f9"]);
  const badRecurrence = await attempt({ findingDispositions: [
    { findingId: "r1-f1", decision: "adopted", reason: "読点を戻した" },
    { findingId: "r1-f2", decision: "rejected", reason: "山場の位置は宣言した拍どおり" },
  ] }, [{ text: "前にも出た指摘", recurrenceOf: "r9-f1" }]);
  assert.deepEqual(badRecurrence.issues, ["script-quality-review-recurrence-unknown:r9-f1"]);
  assert.equal(JSON.parse(await readFile(scriptQualityPaths(root).statePath, "utf8")).rounds.length, 1, "採否の無い版は記録しない");

  // 採否は修正内容のファイルにも書ける。採用した r1-f1 が同じ文で、却下した r1-f2 が recurrenceOf で再び出た。
  await writeFile(scriptQualityPaths(root).revisionDeltaPath, JSON.stringify({
    previousFailureFingerprint: first.round.failureFingerprint,
    revisionDelta: "読点を戻し、語り口を整えた",
    findingDispositions: [
      { findingId: "r1-f1", decision: "adopted", reason: "読点を戻した" },
      { findingId: "r1-f2", decision: "rejected", reason: "山場の位置は宣言した拍どおり" },
    ],
  }));
  const second = await record(root, {
    scriptPath: "drafts/v2.md", versionLabel: "v2", stage: "revision",
    reviewPath: await secondReview("r2", [" 三行目の台詞で 読点が落ちている", { text: "山場がまだ前寄り", recurrenceOf: "r1-f2" }]),
  });
  assert.equal(second.recorded, true);
  assert.deepEqual(second.version.findingDispositions.map((row) => [row.findingId, row.decision]), [["r1-f1", "adopted"], ["r1-f2", "rejected"]]);
  assert.deepEqual(second.round.unresolvedFindingIds, ["r1-f1"], "却下した指摘の再登場は直っていない指摘に数えない");
  assert.deepEqual(second.version.findingRecords.map((row) => row.unresolvedOf || []), [["r1-f1"], []]);
  assert.ok(second.round.improvement >= 1, "点は上がっている");
  assert.equal(second.state.stopReason, "no-improvement", "採用した指摘が直っていなければ停滞として止まる");
  assert.ok(second.issues.includes("script-quality-unresolved-findings:r1-f1"));
});

test("持ち越しの記録が無い前の版の状態でも、history に残したループを累計に数える", async (t) => {
  const root = await workspace(t);
  await start(root);
  await writeFile(join(root, "drafts/draft.md"), DRAFT);
  await record(root, {
    scriptPath: "drafts/draft.md", versionLabel: "v1", stage: "draft", blockingCondition: "人が拍の表を決める",
    reviewPath: await writeReview(root, "r1", review({ context: "ctx-eval-1", script: DRAFT, rubricScores: scores({ "duration-fit": 30 }) })),
  });
  await start(root, { restart: true, restartReason: "拍の表を作り直した" });
  // 前の版のコードが書いた状態（carriedOver が無い）を作る。
  const statePath = scriptQualityPaths(root).statePath;
  const legacy = JSON.parse(await readFile(statePath, "utf8"));
  delete legacy.carriedOver;
  await writeFile(statePath, JSON.stringify(legacy));
  const status = await scriptQualityStatus({ workDir: root });
  assert.equal(status.check.cumulative.rounds, 1);
  assert.equal(status.check.cumulative.loops, 2);
});

test("費用の分からない外部モデルの呼び出しは0円として数えず不明の件数に残し、同じ呼び出しを二重に数えない", async (t) => {
  const root = await workspace(t);
  const configPath = join(root, "script-quality.json");
  await writeFile(configPath, JSON.stringify({ version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION, limits: { maximumCostUnits: 5 } }));
  await start(root, { channelConfig: configPath });
  await writeFile(join(root, "drafts/in.md"), DRAFT);
  await writeFile(join(root, "drafts/rewrite.md"), REWRITE);
  const call = await recordExternalCall({
    ledgerPath: scriptQualityPaths(root).externalCallLedgerPath, host: "antigravity", model: "synthetic-model-high",
    purpose: "台本の語り口の手直し", inputPath: join(root, "drafts/in.md"), outputPath: join(root, "drafts/rewrite.md"),
    callerHost: "claude-code", callerSession: WRITER, now,
  });
  const unpriced = await record(root, {
    scriptPath: "drafts/rewrite.md", versionLabel: "v1", stage: "external-rewrite", externalCallIds: [call.id],
    reviewPath: await writeReview(root, "r1", review({ context: "ctx-eval-1", script: REWRITE, rubricScores: scores({ "narration-voice": 50 }) })),
  });
  assert.equal(unpriced.round.cost, 0);
  assert.equal(unpriced.round.costAccounting.unpricedCount, 1);
  assert.equal((await scriptQualityStatus({ workDir: root })).check.cumulative.unpricedCount, 1);
  // 同じ呼び出しを次の版でも参照しても、二重には数えない。費用を書いた回はその値で数える。
  await writeFile(join(root, "drafts/checked.md"), CHECKED);
  const priced = await record(root, {
    scriptPath: "drafts/checked.md", versionLabel: "v2", stage: "meaning-check", externalCallIds: [call.id], cost: 3,
    revisionDelta: "語り口を戻した", blockingCondition: "人が語り口を決める",
    reviewPath: await writeReview(root, "r2", review({ context: "ctx-eval-2", script: CHECKED, base: REWRITE, rubricScores: scores({ "narration-voice": 50 }) })),
  });
  assert.equal(priced.round.cost, 3);
  assert.equal(priced.round.costAccounting.unpricedCount, 0);
  assert.equal(priced.round.costAccounting.newJobCount, 0, "前の回で数えた呼び出しは数えない");
  const status = await scriptQualityStatus({ workDir: root });
  assert.equal(status.check.cumulative.cost, 3);
  assert.equal(status.check.cumulative.unpricedCount, 1);
  assert.equal(status.check.cumulative.costIncomplete, true);
  // 費用も累計で判定する: 始め直した後の 3 を足すと上限 5 を越える。
  await start(root, { channelConfig: configPath, restart: true, restartReason: "語り口の方針を人が決めた" });
  await writeFile(join(root, "drafts/v3.md"), `${CHECKED}足した行。\n`);
  const third = await record(root, {
    scriptPath: "drafts/v3.md", versionLabel: "v3", stage: "draft", cost: 3,
    reviewPath: await writeReview(root, "r3", review({ context: "ctx-eval-3", script: `${CHECKED}足した行。\n`, rubricScores: scores({ "narration-voice": 50 }) })),
  });
  assert.equal(third.state.stopReason, "cost-limit");
  assert.equal(third.state.carriedOver.unpricedCount, 1);
});

test("続いているループは始め直せず、Pack の設定が変わったら同じループとして続けない", async (t) => {
  const root = await workspace(t);
  const configPath = join(root, "script-quality.json");
  await writeFile(configPath, JSON.stringify({ version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION, floors: { "narration-voice": 70 } }));
  await start(root, { channelConfig: configPath });
  const again = await start(root, { channelConfig: configPath });
  assert.deepEqual(again.issues, ["script-quality-loop-already-started"]);
  const restart = await start(root, { channelConfig: configPath, restart: true, restartReason: "理由を書いても不可" });
  assert.deepEqual(restart.issues, ["script-quality-loop-active-cannot-restart"]);
  await writeFile(configPath, JSON.stringify({ version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION, floors: { "narration-voice": 90 } }));
  await writeFile(join(root, "drafts/draft.md"), DRAFT);
  const changed = await record(root, {
    scriptPath: "drafts/draft.md", versionLabel: "v1", stage: "draft",
    reviewPath: await writeReview(root, "r1", review({ context: "ctx-eval-1", script: DRAFT })),
  });
  assert.deepEqual(changed.issues, ["script-quality-contract-changed"]);
  const invalid = await startScriptQualityLoop({
    workDir: await workspace(t), generatorContextId: WRITER, now,
    loadChannel: async () => ({ config: { version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION, floors: { "meaning-preservation": 10 } }, source: { kind: "unsigned-file", configSha256: sha("c") }, spec: { kind: "none" } }),
  });
  assert.equal(invalid.started, false);
  assert.deepEqual(invalid.issues, ["script-quality-channel-config-invalid:script-quality.floors.meaning-preservation-cannot-lower"]);
});

test("署名済み Channel Pack の script-quality.json を、信頼した公開鍵で検証してから読む", async (t) => {
  const root = await workspace(t);
  const source = join(root, "pack-source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, SCRIPT_QUALITY_CHANNEL_CONFIG_FILE), JSON.stringify({
    version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION,
    criteria: [{ id: "closing-line", label: "締めの一言", weight: 10, minimumScore: 75, description: "締めの一言が決めた字数と型に収まる" }],
  }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicPem = publicKey.export({ type: "spki", format: "pem" });
  const bundle = join(root, "signed-pack");
  await createChannelPackEnvelope({
    sourceDir: source, outputDir: bundle, id: "synthetic-channel", version: "1.0.0", harnessId: "narrated-story-video", privateKeyPem: privatePem,
  });
  await assert.rejects(start(root, { channelPack: bundle, env: {} }), /公開鍵が未設定/u);
  const env = { BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY_PEM: publicPem };
  const started = await start(root, { channelPack: bundle, env });
  assert.equal(started.started, true);
  const contract = started.state.script.contract;
  assert.ok(contract.rubric.some((row) => row.id === "closing-line" && row.origin === "channel"));
  assert.equal(contract.channelSource.kind, "signed-channel-pack");
  assert.equal(contract.channelSource.packId, "synthetic-channel");
  // 採点ファイルの雛形は、Pack が足した項目も含む。
  await writeFile(join(root, "drafts/draft.md"), DRAFT);
  const { template } = await scriptQualityReviewTemplate({ workDir: root, scriptPath: "drafts/draft.md" });
  assert.equal(template.scriptSha256, sha(DRAFT));
  assert.ok(Object.hasOwn(template.rubricScores, "closing-line"));
  const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  const wrongKey = await record(root, {
    scriptPath: "drafts/draft.md", versionLabel: "v1", stage: "draft", env: { BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY_PEM: other },
    reviewPath: await writeReview(root, "r1", review({ context: "ctx-eval-1", script: DRAFT, rubricScores: scores({}, contract) })),
  });
  assert.deepEqual(wrongKey.issues, ["script-quality-channel-config-unavailable"]);
  const recorded = await record(root, { scriptPath: "drafts/draft.md", versionLabel: "v1", stage: "draft", env, reviewPath: "quality/reviews/r1.json" });
  assert.equal(recorded.recorded, true);
  assert.equal(recorded.state.status, "passed");
});

test("漫画と解説動画の台本のジャンルを持ち、どちらも全項目に下限があり重みの合計は 100", () => {
  const manga = createScriptQualityContract({ genre: "manga" }).contract;
  const explainer = createScriptQualityContract({ genre: "explainer" }).contract;
  assert.deepEqual(manga.rubric.map((row) => row.id), ["source-fidelity", "speaker-attribution", "panel-premise", "bubble-fit", "reading-clarity", "beat-pacing"]);
  assert.deepEqual(explainer.rubric.map((row) => row.id), ["question-clarity", "first-view-comprehension", "evidence-scope", "discovery-progression", "opening-promise-payoff", "reading-clarity"]);
  for (const contract of [manga, explainer]) {
    assert.equal(Math.round(contract.rubric.reduce((sum, row) => sum + row.weight, 0)), 100);
    for (const row of contract.rubric) {
      assert.ok(Number.isFinite(row.minimumScore), `${contract.genre}.${row.id} に下限が無い`);
      assert.ok(row.description.length >= 20, `${contract.genre}.${row.id} の説明が短い`);
      assert.equal(row.origin, "genre");
    }
    assert.notEqual(contract.digest, DEFAULT_CONTRACT.digest);
    assert.deepEqual(contract.machineGates, DEFAULT_CONTRACT.machineGates);
  }
  const floor = (contract, id) => contract.rubric.find((row) => row.id === id).minimumScore;
  assert.equal(floor(manga, "source-fidelity"), 90, "原文の保持はナレーション物語の意味の保持と同じ高さ");
  assert.equal(floor(explainer, "evidence-scope"), 85, "根拠が支える範囲を越えた主張は致命傷として高い下限");
  assert.equal(manga.harnessId, "koya-manga-video");
  assert.equal(explainer.harnessId, null, "解説動画のハーネスはまだ無い");
  // Pack の設定のジャンル違いは blocker。ハーネスの無いジャンルは設定にジャンルの明記が要る。
  assert.deepEqual(normalizeScriptChannelConfig({ version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION, genre: "narrated-story" }, scriptQualityGenre("manga")).blockers, ["script-quality.genre-mismatch"]);
  assert.deepEqual(normalizeScriptChannelConfig({ version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION }, scriptQualityGenre("explainer")).blockers, ["script-quality.genre-required"]);
  assert.deepEqual(normalizeScriptChannelConfig({ version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION, genre: "explainer" }, scriptQualityGenre("explainer")).blockers, []);
  assert.throws(() => scriptQualityGenre("documentary"), /未知の台本ジャンル/u);
});

test("漫画のジャンルでもループを回せ、評価項目はそのジャンルのもので採点する", async (t) => {
  const root = await workspace(t);
  const started = await start(root, { genre: "manga" });
  assert.equal(started.state.script.genre, "manga");
  const contract = started.state.script.contract;
  await writeFile(join(root, "drafts/draft.md"), DRAFT);
  const narratedScores = await record(root, {
    scriptPath: "drafts/draft.md", versionLabel: "v1", stage: "draft",
    reviewPath: await writeReview(root, "n", review({ context: "ctx-eval-0", script: DRAFT })),
  });
  assert.ok(narratedScores.issues.includes("script-quality-review-score-invalid:source-fidelity"));
  const passed = await record(root, {
    scriptPath: "drafts/draft.md", versionLabel: "v1", stage: "draft",
    reviewPath: await writeReview(root, "m", review({ context: "ctx-eval-1", script: DRAFT, rubricScores: scores({}, contract) })),
  });
  assert.equal(passed.state.status, "passed");
  const out = [];
  assert.equal((await runScriptQualityCli(["contract", "--genre", "explainer"], { stdout: { write: (text) => out.push(text) } })).exitCode, 0);
  assert.equal(JSON.parse(out.join("")).genre, "explainer");
});

test("受け入れ方を宣言しない契約の digest は今までと同じ値（進行中のループを契約の変更で止めない）", () => {
  assert.equal(DEFAULT_CONTRACT.digest, "0f641861c34e3e9bcb0e9c63464a8f3d8e755d493823944e1d83741e6afde6d0");
  assert.equal(Object.hasOwn(DEFAULT_CONTRACT, "acceptance"), false);
});

async function startPanel(t, acceptance) {
  const root = await workspace(t);
  const configPath = join(root, "script-quality.json");
  await writeFile(configPath, JSON.stringify({ version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION, acceptance }));
  const started = await start(root, { channelConfig: configPath });
  assert.equal(started.started, true);
  return { root, contract: started.state.script.contract };
}

test("評価者を宣言した組は全員そろった時点で1回として閉じ、欠員・別の版・作った文脈・同じ文脈の再利用・宣言外・2件目は組に入れない", async (t) => {
  const { root, contract } = await startPanel(t, { evaluators: ["eval-a", "eval-b"] });
  assert.deepEqual(contract.acceptance, { mode: "average", evaluators: ["eval-a", "eval-b"] });
  await writeFile(join(root, "drafts/draft.md"), DRAFT);
  const panelReview = (name, body) => writeReview(root, name, body);
  const reviewOf = (context, evaluatorId, script = DRAFT, extra = {}) => ({
    ...review({ context, script, evaluatorId, rubricScores: scores({}, contract) }), ...extra,
  });
  // 宣言に無い評価者では組を開かない。
  const undeclaredOpen = await record(root, { scriptPath: "drafts/draft.md", versionLabel: "v1", stage: "draft", reviewPath: await panelReview("z0", reviewOf("ctx-z0", "eval-z")) });
  assert.deepEqual(undeclaredOpen.issues, ["script-quality-panel-evaluator-undeclared:eval-z"]);
  const first = await record(root, { scriptPath: "drafts/draft.md", versionLabel: "v1", stage: "draft", reviewPath: await panelReview("a1", reviewOf("ctx-a1", "eval-a")) });
  assert.equal(first.recorded, false);
  assert.equal(first.panelAccepted, true);
  assert.deepEqual(first.issues, ["script-quality-panel-waiting:eval-b"]);
  assert.equal(first.state.rounds.length, 0, "欠員の組は回として数えない");
  assert.deepEqual(first.check.pendingPanel.missing, ["eval-b"]);
  // 同じ採点の再実行は二重に入れない。
  assert.equal((await record(root, { reviewPath: "quality/reviews/a1.json" })).alreadyRecorded, true);
  // 別の版の採点は組に入れない（採点の SHA でも、渡した台本の SHA でも）。
  assert.deepEqual((await record(root, { reviewPath: await panelReview("b-other", reviewOf("ctx-b1", "eval-b", REWRITE)) })).issues, ["script-quality-panel-version-mismatch"]);
  await writeFile(join(root, "drafts/other.md"), REWRITE);
  assert.deepEqual((await record(root, { scriptPath: "drafts/other.md", reviewPath: await panelReview("b-other2", reviewOf("ctx-b1", "eval-b")) })).issues, ["script-quality-panel-version-mismatch"]);
  // 同じ評価者の2件目・宣言に無い評価者・組の中の同じ文脈・作った文脈・組の中の写しの所見。
  assert.deepEqual((await record(root, { reviewPath: await panelReview("a2", reviewOf("ctx-a2", "eval-a")) })).issues, ["script-quality-panel-evaluator-duplicate:eval-a"]);
  assert.deepEqual((await record(root, { reviewPath: await panelReview("z1", reviewOf("ctx-z1", "eval-z")) })).issues, ["script-quality-panel-evaluator-undeclared:eval-z"]);
  assert.deepEqual((await record(root, { reviewPath: await panelReview("b-same", reviewOf("ctx-a1", "eval-b")) })).issues, ["script-quality-panel-context-reused"]);
  assert.deepEqual((await record(root, { reviewPath: await panelReview("b-writer", reviewOf(WRITER, "eval-b")) })).issues, ["script-quality-evaluator-not-independent"]);
  const copied = reviewOf("ctx-b1", "eval-b", DRAFT, { notes: `全行を読み、前の版と1行ずつ比べた所見（ctx-a1）` });
  assert.deepEqual((await record(root, { reviewPath: await panelReview("b-copy", copied) })).issues, ["script-quality-panel-notes-duplicated"]);
  const stateBefore = JSON.parse(await readFile(scriptQualityPaths(root).statePath, "utf8"));
  assert.equal(stateBefore.script.pendingPanel.reviews.length, 1);

  const closed = await record(root, { reviewPath: await panelReview("b1", reviewOf("ctx-b1", "eval-b", DRAFT, { rubricScores: scores({ "narration-voice": 55 }, contract) })) });
  assert.equal(closed.recorded, true);
  assert.equal(closed.state.status, "active");
  assert.deepEqual(closed.round.floorFailures, ["narration-voice"]);
  assert.equal(closed.round.reviews.length, 2);
  assert.deepEqual(closed.version.reviews.map((row) => row.evaluatorId), ["eval-a", "eval-b"]);
  assert.equal(closed.state.script.pendingPanel, undefined);
  assert.equal(closed.round.acceptance.mode, "average");
  assert.deepEqual(closed.round.acceptance.missingEvaluators, []);
  // 平均で判定する（評価者ごとの点は回に残る）。
  const perEvaluator = closed.round.acceptance.evaluators.map((row) => row.score);
  assert.equal(closed.round.score, Number(((perEvaluator[0] + perEvaluator[1]) / 2).toFixed(3)));
  // 閉じた後は同じ版を採点し直さない。前の回の文脈は次の版でも使えない。
  await writeFile(join(root, "drafts/v2.md"), REWRITE);
  const reused = await record(root, {
    scriptPath: "drafts/v2.md", versionLabel: "v2", stage: "revision", revisionDelta: "語り口を直した",
    reviewPath: await panelReview("a3", reviewOf("ctx-a1", "eval-a", REWRITE, { baseScriptSha256: sha(DRAFT) })),
  });
  assert.deepEqual(reused.issues, ["script-quality-fresh-review-required"]);
  assert.deepEqual((await record(root, { scriptPath: "drafts/draft.md", versionLabel: "v1b", stage: "revision", revisionDelta: "直していない", reviewPath: await panelReview("a4", reviewOf("ctx-a4", "eval-a", DRAFT, { baseScriptSha256: sha(DRAFT) })) })).issues, ["script-quality-script-unchanged:v1"]);
});

test("受け入れ方 each-evaluator は Pack で選び、平均だけ目標を越える組を合格にしない（average なら合格）", async (t) => {
  const run = async (acceptance) => {
    const { root, contract } = await startPanel(t, acceptance);
    await writeFile(join(root, "drafts/draft.md"), DRAFT);
    const high = scores(Object.fromEntries(contract.rubric.map((row) => [row.id, 100])), contract);
    // どの項目も下限は割らない（意味の保持 90・差し替え印 100）が、総合点は目標（90）に届かない。
    const floorsKept = { "review-first-person-marker": 100, "meaning-preservation": 90 };
    const low = scores(Object.fromEntries(contract.rubric.map((row) => [row.id, floorsKept[row.id] ?? 84])), contract);
    await record(root, { scriptPath: "drafts/draft.md", versionLabel: "v1", stage: "draft", reviewPath: await writeReview(root, "a", review({ context: "ctx-a", script: DRAFT, evaluatorId: "eval-a", rubricScores: high })) });
    return record(root, { reviewPath: await writeReview(root, "b", review({ context: "ctx-b", script: DRAFT, evaluatorId: "eval-b", rubricScores: low })) });
  };
  const averaged = await run({ mode: "average", evaluators: ["eval-a", "eval-b"] });
  assert.equal(averaged.state.status, "passed");
  const each = await run({ mode: "each-evaluator", evaluators: ["eval-a", "eval-b"] });
  assert.equal(each.recorded, true);
  assert.notEqual(each.state.status, "passed");
  assert.ok(each.round.score >= each.state.script.contract.limits.targetScore, "平均は目標に届いている");
  assert.deepEqual(each.round.acceptance.failures, ["evaluator-below-minimum:eval-b"]);
  assert.match(each.detail, /evaluator-below-minimum:eval-b/u);
  assert.equal(each.state.script.contract.acceptance.mode, "each-evaluator");
});

test("組の宣言が壊れた Pack は blocker で止め、黙って1人の組へ戻さない", () => {
  const blockedEach = (acceptance) => normalizeScriptChannelConfig({ version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION, acceptance }).blockers;
  assert.deepEqual(blockedEach({ mode: "each-evaluator" }), ["script-quality.acceptance.evaluators-required"]);
  assert.deepEqual(blockedEach({ mode: "each-evaluator", evaluators: ["a"], minimumEvaluatorScore: 70 }), ["script-quality.acceptance.minimumEvaluatorScore"]);
  assert.deepEqual(blockedEach({ mode: "average", evaluators: ["a"], minimumEvaluatorScore: 85 }), ["script-quality.acceptance.minimumEvaluatorScore-each-evaluator-only"]);
  assert.deepEqual(blockedEach({ mode: "each-evaluator", evaluators: ["a", "b"], minimumEvaluatorScore: 85 }), []);
  const blocked = (acceptance) => normalizeScriptChannelConfig({ version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION, acceptance }).blockers;
  assert.deepEqual(blocked({ evaluators: ["a", "a"] }), ["script-quality.acceptance.evaluators.a-duplicated"]);
  assert.deepEqual(blocked({ evaluators: ["script-writer"] }), ["script-quality.acceptance.evaluators.id"]);
  assert.deepEqual(blocked({ mode: "median" }), ["script-quality.acceptance.mode", "script-quality.acceptance"]);
  assert.deepEqual(blocked({ evaluators: "a" }), ["script-quality.acceptance.evaluators"]);
  assert.deepEqual(blocked({ quorum: 1 }), ["script-quality.acceptance.quorum-unknown"]);
  assert.deepEqual(blocked([]), ["script-quality.acceptance"]);
});

test("CLI は人待ちを終了コード 3、未合格の --require-pass を 4 で返し、--help では何も書かない", async (t) => {
  const root = await workspace(t);
  const out = [];
  const stdout = { write: (text) => out.push(text) };
  assert.equal((await runScriptQualityCli(["start", "--help"], { stdout })).exitCode, 0);
  assert.equal((await scriptQualityStatus({ workDir: root })).started, false);
  assert.equal((await runScriptQualityCli(["start", "--work-dir", root, "--generator-context", WRITER], { stdout, now })).exitCode, 0);
  await writeFile(join(root, "drafts/draft.md"), DRAFT);
  const reviewPath = await writeReview(root, "r1", review({ context: WRITER, script: DRAFT }));
  const waitingRun = await runScriptQualityCli(["record", "--work-dir", root, "--script", "drafts/draft.md", "--version", "v1", "--stage", "draft", "--review", reviewPath], { stdout, now });
  assert.equal(waitingRun.exitCode, 3);
  const failing = await writeReview(root, "r2", review({ context: "ctx-eval-1", script: DRAFT, rubricScores: scores({ "narration-voice": 10 }) }));
  // 試験では本物の非公開台帳へ学習候補を積まない（自動捕捉は環境変数で止まる）。
  const recorded = await runScriptQualityCli(
    ["record", "--work-dir", root, "--script", "drafts/draft.md", "--version", "v1", "--stage", "draft", "--review", failing, "--json"],
    { stdout, now, env: { BUZZASSIST_LEARNING_AUTO_CAPTURE: "0" } },
  );
  assert.equal(recorded.exitCode, 0);
  assert.equal(recorded.result.learning.skippedReason, "disabled");
  assert.equal((await runScriptQualityCli(["status", "--work-dir", root, "--require-pass"], { stdout })).exitCode, 4);
  out.length = 0;
  assert.equal((await runScriptQualityCli(["contract"], { stdout })).exitCode, 0);
  assert.equal(JSON.parse(out.join("")).rubric.length, 6);
  await assert.rejects(runScriptQualityCli(["record", "--nope"], { stdout }), /不明なオプション/u);
});
