import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import test from "node:test";

import {
  ASSET_QUALITY_DIR,
  ASSET_STAGES,
  assetQualityStatus,
  startAssetQualityLoop,
} from "../lib/assetQualityLoop.mjs";
import { EXPLAINER_WORK_DIR } from "../lib/explainerVideo.mjs";
import { narratedStoryRunPaths } from "../lib/narratedStoryPipeline.mjs";
import {
  SCRIPT_QUALITY_DIR,
  SCRIPT_QUALITY_STATE_FILE,
  SCRIPT_REVISION_DELTA_FILE,
  startScriptQualityLoop,
} from "../lib/scriptQualityLoop.mjs";
import {
  SIGNED_REVIEW_QUALITY_DIR,
  SIGNED_REVIEW_QUALITY_STATE_FILE,
} from "../lib/signedReviewQualityLoop.mjs";
import {
  STRATEGY_BRIEF_QUALITY_DIR,
  STRATEGY_BRIEF_QUALITY_STATE_FILE,
  STRATEGY_BRIEF_REVISION_DELTA_FILE,
  startStrategyBriefLoop,
} from "../lib/strategyBriefQualityLoop.mjs";
import {
  ASSET_LOOP_STAGES,
  LOOP_STATE_LAYOUT,
  MAX_LOOP_MARKS,
  QUALITY_LOOP_REASON_PREFIX,
  assetActiveLoopDetail,
  collectQualityLoopReferences,
  evaluateQualityLoopStop,
  isLinkedWorktreeDir,
  jobBoundLoopRef,
  splitShellSegments,
  withLoopMarks,
} from "../lib/stopHookQualityLoops.mjs";
import {
  HARD_TIMEOUT_MS,
  LOOP_CHECK_MARGIN_MS,
  STOP_HOOK_REASON_PREFIX,
  STOP_HOOK_STATE_DIR_ENV,
  STOP_HOOK_SWITCH_ENV,
  decideStop,
  runStopHookCli,
} from "../scripts/harness-stop-hook.mjs";

// 合成の値だけを使う（実在のチャンネル・人の名前は書かない）。
const SESSION = "session-loop-synthetic-1";
const NO_CHANNEL = async () => ({ config: null, source: { kind: "none" }, spec: { kind: "none" } });
const NARRATED_JOB = "video-narrated-story-video-0011223344556677";
const EXPLAINER_JOB = "video-explainer-video-8899aabbccddeeff";
const SAMPLE_JOB = "video-sample-harness-00112233aabbccdd";
const FINGERPRINT = "quality-failure:0123456789abcdef01234567";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "stop-loop-"));
  const stateDir = join(dir, "hook-state");
  const transcript = join(dir, "session.jsonl");
  const env = { [STOP_HOOK_STATE_DIR_ENV]: stateDir };
  return { dir, stateDir, transcript, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function stopInput(fx, overrides = {}) {
  return {
    session_id: SESSION,
    transcript_path: fx.transcript,
    cwd: fx.dir,
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "台本の2稿目を書き、評価を頼みました。",
    ...overrides,
  };
}

/** Claude Code 形式: Bash の実行（tool_use）と結果（tool_result・toolUseResult）。 */
function claudeBash(command, { cwd, id = "toolu_1", output = "ok" } = {}) {
  return [
    { type: "assistant", cwd, message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } },
    { type: "user", cwd, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output }] }, toolUseResult: { stdout: output } },
  ];
}

function writeLines(file, entries) {
  writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

async function runCli(input, { env }) {
  const { Readable, Writable } = await import("node:stream");
  let out = "";
  const stdout = new Writable({ write(chunk, _enc, done) { out += chunk.toString(); done(); } });
  const stderr = new Writable({ write(_chunk, _enc, done) { done(); } });
  const stdin = Readable.from([JSON.stringify(input)]);
  const code = await runStopHookCli({ stdin, stdout, stderr, env, home: tmpdir(), exit: () => {}, timeoutMs: 20_000 });
  return { code, stdout: out };
}

async function startScript(workDir) {
  mkdirSync(workDir, { recursive: true });
  const result = await startScriptQualityLoop({ workDir, generatorContextId: "ctx-writer-1", loadChannel: NO_CHANNEL });
  assert.equal(result.started, true);
  return join(workDir, "quality", "script-quality-loop.json");
}

async function startAsset(workDir, subjectId) {
  mkdirSync(workDir, { recursive: true });
  const result = await startAssetQualityLoop({
    workDir, harnessId: "narrated-story-video", stage: "thumbnail", subjectId, generatorContextId: "ctx-maker-1", loadChannel: NO_CHANNEL,
  });
  assert.equal(result.started, true);
  return join(workDir, "quality", "assets", `thumbnail--${subjectId}.json`);
}

async function startStrategy(workDir) {
  mkdirSync(workDir, { recursive: true });
  const result = await startStrategyBriefLoop({ workDir, generatorContextId: "ctx-planner-1" });
  assert.equal(result.started, true);
  return join(workDir, "quality", "strategy-brief-loop.json");
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** 状態ファイルに合成の回を1つ足す（採点の記録そのものは試験の対象でないので、回の形だけ）。 */
function addRound(statePath, { score = 71.5, floorFailures = ["pacing"], status = "active" } = {}) {
  const state = readJson(statePath);
  state.rounds.push({
    index: state.rounds.length + 1,
    score,
    hardGatePass: true,
    failedGateIds: [],
    floorFailures,
    failureFingerprint: FINGERPRINT,
    reviews: [],
    evidence: [],
  });
  state.status = status;
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

function setStatus(statePath, status, stopReason = "") {
  const state = readJson(statePath);
  state.status = status;
  state.stopReason = stopReason;
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function sessionState(fx) {
  const files = readdirSync(fx.stateDir);
  assert.equal(files.length, 1);
  return readFileSync(join(fx.stateDir, files[0]), "utf8");
}

test("台本のループを start した会話が止まる → 周回・次に読むファイル・次の手順を入れて1回だけ差し戻す。回が進めばまた差し戻す", async () => {
  const fx = fixture();
  try {
    const workDir = join(fx.dir, "work", "script-a");
    const statePath = await startScript(workDir);
    // 結果の側（tool_result）にある案内の文は数えない。実行したコマンドだけが手がかり。
    writeLines(fx.transcript, claudeBash(`node scripts/script-quality-loop.mjs start --work-dir "${workDir}" --generator-context ctx-writer-1`, { cwd: fx.dir }));
    const input = stopInput(fx);

    const first = await runCli(input, { env: fx.env });
    assert.equal(first.code, 0);
    const output = JSON.parse(first.stdout);
    assert.deepEqual(Object.keys(output).sort(), ["decision", "reason"], "decision と reason 以外（continue など）を出さない");
    assert.equal(output.decision, "block");
    assert.ok(output.reason.startsWith(QUALITY_LOOP_REASON_PREFIX));
    assert.match(output.reason, /台本の品質ループ/u);
    assert.match(output.reason, /まだ1回も採点を記録していない/u);
    assert.ok(output.reason.includes(statePath), "次に読むファイル（状態ファイル）を入れる");
    // 次の手順はループ自身の説明（nextStepDetail）を使う。
    assert.match(output.reason, /最初の版を、作った文脈とは別の評価文脈で採点して record する/u);
    assert.match(output.reason, /次の手順: 1\) status/u);
    assert.match(output.reason, /運営者の明示の確認があるときだけ/u);
    assert.match(output.reason, /自分では打たない/u);

    // 付箋: 同じ周回では二重に差し戻さない。
    const second = await runCli(input, { env: fx.env });
    assert.equal(second.stdout, "");
    assert.equal((await decideStop(input, { env: fx.env })).loopWhy, "loops-settled-or-noted");

    // 回が進んだ（まだ active）→ 次の周回として、また1回差し戻す。合格点は reason に書かない。
    const state = addRound(statePath, { score: 71.5, floorFailures: ["pacing"] });
    const target = state.script.contract.limits.targetScore;
    const third = JSON.parse((await runCli(input, { env: fx.env })).stdout);
    assert.equal(third.decision, "block");
    assert.match(third.reason, /1 回目まで記録。直近 71\.5 点（目標未達・下限割れ: pacing）/u);
    assert.ok(third.reason.includes(FINGERPRINT));
    assert.ok(third.reason.includes(join(workDir, "quality", "script-revision-delta.json")), "直した内容の置き場を入れる");
    assert.doesNotMatch(third.reason, new RegExp(`目標 ?${target}|targetScore|${target} 点`, "u"));
    assert.equal((await runCli(input, { env: fx.env })).stdout, "");

    // 付箋は会話ごとの記録に、会話の本文なしで残る。
    const saved = sessionState(fx);
    assert.equal(Object.keys(JSON.parse(saved).loops).length, 1);
    assert.doesNotMatch(saved, /評価を頼みました|script-a/u);
  } finally {
    fx.cleanup();
  }
});

test("合格・人の判断待ち・止まったループ・状態ファイルの無いループは差し戻さない", async () => {
  const fx = fixture();
  try {
    const workDir = join(fx.dir, "work", "script-b");
    const statePath = await startScript(workDir);
    writeLines(fx.transcript, claudeBash(`node scripts/script-quality-loop.mjs record --work-dir "${workDir}" --script v1.md --version v1 --stage draft --review r.json`, { cwd: fx.dir }));
    for (const [status, stopReason] of [["passed", "target-reached"], ["needs-human-approval", "round-limit"], ["blocked", "human-stopped"], ["budget-exhausted", "cost-limit"]]) {
      setStatus(statePath, status, stopReason);
      const decision = await decideStop(stopInput(fx), { env: fx.env });
      assert.equal(decision.action, "none", status);
      assert.equal(decision.loopWhy, "loops-settled-or-noted", status);
    }
    // 途中の成果物: 評価者の採点は通り、人の確認を待っている（passed）→ 人の判断待ち。
    const assetDir = join(fx.dir, "work", "assets");
    const assetState = await startAsset(assetDir, "thumb-01");
    setStatus(assetState, "passed", "target-reached");
    writeLines(fx.transcript, claudeBash(`node scripts/asset-quality-loop.mjs record --work-dir "${assetDir}" --stage thumbnail --subject thumb-01 --asset a.png --version v1 --review r.json`, { cwd: fx.dir }));
    assert.equal((await decideStop(stopInput(fx), { env: fx.env })).action, "none");
    // 状態ファイルが無い（始まっていない）→ 何もしない。
    writeLines(fx.transcript, claudeBash(`node scripts/script-quality-loop.mjs start --work-dir "${join(fx.dir, "work", "never")}" --generator-context c1`, { cwd: fx.dir }));
    const missing = await decideStop(stopInput(fx), { env: fx.env });
    assert.equal(missing.action, "none");
    assert.equal(missing.loopWhy, "loops-settled-or-noted");
  } finally {
    fx.cleanup();
  }
});

test("台本のループが目的の判定待ち（awaiting-goal-check）→ 人の判断待ちにせず、新しい文脈に判定させる手順で1回だけ差し戻す", async () => {
  const fx = fixture();
  try {
    const workDir = join(fx.dir, "work", "script-goal");
    const statePath = await startScript(workDir);
    writeLines(fx.transcript, claudeBash(`node scripts/script-quality-loop.mjs record --work-dir "${workDir}" --script v1.md --version v1 --stage draft --review r.json`, { cwd: fx.dir }));
    addRound(statePath, { score: 93 });
    setStatus(statePath, "awaiting-goal-check", "");
    const input = stopInput(fx);
    const first = await runCli(input, { env: fx.env });
    const output = JSON.parse(first.stdout);
    assert.equal(output.decision, "block");
    assert.match(output.reason, /止める前の目的の判定を待っている（まだ合格ではない/u);
    assert.match(output.reason, /goal-sheet/u);
    assert.match(output.reason, /この会話では判定しない/u);
    assert.doesNotMatch(output.reason, /次の手順: 1\) status/u, "直して採点し直す手順は出さない");
    assert.doesNotMatch(output.reason, /目標未達/u);
    // 同じ待ちでは二重に差し戻さない。
    assert.equal((await runCli(input, { env: fx.env })).stdout, "");
    // 判定した会話（goalChecks の評価文脈にこの会話の ID）なら差し戻さない。
    const state = readJson(statePath);
    state.goalChecks = [{ roundIndex: 1, verdict: "not-achieved", evaluatorContextId: `claude:${SESSION}` }];
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    assert.equal((await decideStop(stopInput(fx), { env: fx.env })).action, "none");
  } finally {
    fx.cleanup();
  }
});

test("壊れた状態ファイル → 合格扱いで抜けず、直すよう短く伝える（同じ中身では1回だけ、中身が変われば改めて）", async () => {
  const fx = fixture();
  try {
    const workDir = join(fx.dir, "work", "script-c");
    const statePath = join(workDir, "quality", "script-quality-loop.json");
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, "{ broken");
    writeLines(fx.transcript, claudeBash(`node scripts/script-quality-loop.mjs record --work-dir "${workDir}" --review r.json`, { cwd: fx.dir }));
    const input = stopInput(fx);
    const first = JSON.parse((await runCli(input, { env: fx.env })).stdout);
    assert.equal(first.decision, "block");
    assert.match(first.reason, /状態ファイルが読めない（JSON として壊れている）/u);
    assert.match(first.reason, /合格とは扱わない/u);
    assert.match(first.reason, /手で合格に書き換えず/u);
    assert.doesNotMatch(first.reason, /次の手順: /u, "壊れた状態には周回の手順を出さない");
    assert.equal((await runCli(input, { env: fx.env })).stdout, "", "同じ中身では2回目を出さない");

    // 形が違う（status が無い）→ 改めて伝える。
    writeFileSync(statePath, JSON.stringify({ rounds: [] }));
    const shape = JSON.parse((await runCli(input, { env: fx.env })).stdout);
    assert.match(shape.reason, /品質ループの状態の形になっていない/u);
    // 台本の欄（script）が無い状態も、読めた扱いにしない。
    writeFileSync(statePath, JSON.stringify({ status: "active", rounds: [] }));
    assert.equal((await decideStop(input, { env: fx.env })).loopWhy, "loop-state-broken");
  } finally {
    fx.cleanup();
  }
});

test("status を見ただけ・ツールの結果に出た案内・置き字の引数は、この会話が回したループに数えない", async () => {
  const fx = fixture();
  try {
    const workDir = join(fx.dir, "work", "script-d");
    await startScript(workDir);
    const cases = [
      claudeBash(`node scripts/script-quality-loop.mjs status --work-dir "${workDir}"`, { cwd: fx.dir }),
      claudeBash("cat notes.txt", { cwd: fx.dir, output: `next: node scripts/script-quality-loop.mjs record --work-dir "${workDir}" --review r.json` }),
      [{ type: "user", cwd: fx.dir, message: { role: "user", content: "node scripts/script-quality-loop.mjs start --work-dir <台本の作業フォルダ> --generator-context <会話ID>" } }],
      [{ type: "user", cwd: fx.dir, toolUseResult: { stdout: `node scripts/script-quality-loop.mjs start --work-dir ${workDir}` } }],
    ];
    for (const entries of cases) {
      writeLines(fx.transcript, entries);
      const decision = await decideStop(stopInput(fx), { env: fx.env });
      assert.equal(decision.action, "none");
      assert.equal(decision.loopWhy, "no-loop", JSON.stringify(entries).slice(0, 120));
    }
  } finally {
    fx.cleanup();
  }
});

test("子エージェント・worktree の子・stop_hook_active・スイッチ・Stop 以外では何もしない", async () => {
  const fx = fixture();
  try {
    const workDir = join(fx.dir, "work", "script-e");
    await startScript(workDir);
    writeLines(fx.transcript, claudeBash(`node scripts/script-quality-loop.mjs start --work-dir "${workDir}" --generator-context c1`, { cwd: fx.dir }));
    assert.equal((await decideStop(stopInput(fx), { env: fx.env })).action, "block", "前提: 親の会話なら差し戻す");
    assert.equal((await decideStop(stopInput(fx), { env: { ...fx.env, BUZZASSIST_LEARNING_WRITE_FORBIDDEN: "child-agent" } })).why, "child-agent");
    assert.equal((await decideStop(stopInput(fx, { agent_id: "agent-1" }), { env: fx.env })).why, "subagent");
    assert.equal((await decideStop(stopInput(fx, { stop_hook_active: true }), { env: fx.env })).why, "stop-hook-active");
    assert.equal((await decideStop(stopInput(fx), { env: { ...fx.env, [STOP_HOOK_SWITCH_ENV]: "off" } })).why, "switched-off");
    assert.equal((await decideStop(stopInput(fx, { hook_event_name: "SubagentStop" }), { env: fx.env })).why, "not-stop");

    // worktree の子: 作業場所の .git がファイルで、本体の .git/worktrees/<名前> を指す。
    const child = join(fx.dir, "checkout-child");
    mkdirSync(join(child, "sub"), { recursive: true });
    writeFileSync(join(child, ".git"), `gitdir: ${join(fx.dir, "main", ".git", "worktrees", "child-1")}\n`);
    const inChild = await decideStop(stopInput(fx, { cwd: join(child, "sub") }), { env: fx.env });
    assert.equal(inChild.action, "none");
    assert.equal(inChild.loopWhy, "worktree-child");
    assert.equal(isLinkedWorktreeDir(join(child, "sub")), true);
    assert.equal(isLinkedWorktreeDir(join(fx.dir, "x", ".claude", "worktrees", "agent-1")), true);
    // 本体（.git がフォルダ）と submodule（.git/modules を指すファイル）は子ではない。
    const main = join(fx.dir, "main");
    mkdirSync(join(main, ".git"), { recursive: true });
    assert.equal(isLinkedWorktreeDir(main), false);
    const submodule = join(fx.dir, "with-submodule");
    mkdirSync(submodule, { recursive: true });
    writeFileSync(join(submodule, ".git"), "gitdir: ../.git/modules/with-submodule\n");
    assert.equal(isLinkedWorktreeDir(submodule), false);
  } finally {
    fx.cleanup();
  }
});

test("Codex 形式（function_call の arguments・workdir・語の配列）と cd つきの相対パスからもループを見つける", async () => {
  const fx = fixture();
  try {
    const base = join(fx.dir, "project");
    const strategyState = await startStrategy(join(base, "briefs"));
    const assetState = await startAsset(join(base, "assets-w"), "thumb-01");
    const scriptState = await startScript(join(base, "scripts-w", "ep1"));
    const codex = [
      { type: "turn_context", payload: { cwd: base } },
      // 作業フォルダを省いた record は、ブリーフのあるフォルダを作業フォルダにする。
      { type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "node scripts/strategy-brief.mjs record --brief briefs/b1.json --review r.json", workdir: base }) } },
      { type: "response_item", payload: { type: "local_shell_call", action: { type: "exec", command: ["node", "scripts/asset-quality-loop.mjs", "record", "--work-dir", "assets-w", "--stage", "thumbnail", "--subject", "thumb-01", "--asset", "a.png"], working_directory: base } } },
      { type: "response_item", payload: { type: "function_call_output", output: "node scripts/script-quality-loop.mjs start --work-dir /elsewhere" } },
    ];
    writeLines(fx.transcript, [...codex, ...claudeBash("cd scripts-w && node scripts/script-quality-loop.mjs record --work-dir ep1 --review r.json", { cwd: base })]);
    const refs = collectQualityLoopReferences(readFileSync(fx.transcript, "utf8").split("\n"), { cwd: fx.dir });
    assert.deepEqual(refs.map((ref) => ref.statePath).sort(), [assetState, scriptState, strategyState].sort());
    assert.equal(refs[0].statePath, scriptState, "新しく触ったものが先");
    const decision = await decideStop(stopInput(fx, { last_assistant_message: null }), { env: fx.env });
    assert.equal(decision.action, "block");
    assert.match(decision.reason, /企画ブリーフの品質ループ/u);
    assert.match(decision.reason, /途中の成果物の品質ループ（thumbnail \/ thumb-01/u);
    assert.match(decision.reason, /asset-quality-loop\.mjs status --work-dir ".*" --stage thumbnail --subject thumb-01/u);
    assert.equal(decision.loopMarks.length, 3);
  } finally {
    fx.cleanup();
  }
});

test("同じコマンド文の中で代入した変数（W=...; --work-dir $W）を展開し、展開できない値は手がかりにしない", async () => {
  const fx = fixture();
  try {
    const base = join(fx.dir, "project");
    const scriptState = await startScript(join(base, "work", "ep-var"));
    const command = [
      `cd ${base}`,
      "W=work/ep-var",
      "export SAMPLE_KEY=~/keys/sample.pem",
      "EC=$(cat $W/calls.txt | tr '\\n' ' ')",
      "node scripts/script-quality-loop.mjs record --work-dir $W --script v2.md --version d2 --stage draft --review quality/review.json 2>&1 | tail -5",
      "node scripts/script-quality-loop.mjs record --work-dir $EC --review r.json",
      "node scripts/script-quality-loop.mjs start --work-dir ${UNKNOWN}/x --generator-context c1",
    ].join("; ");
    const lines = claudeBash(command, { cwd: fx.dir }).map((entry) => JSON.stringify(entry));
    const refs = collectQualityLoopReferences(lines, { cwd: fx.dir });
    assert.deepEqual(refs.map((ref) => ref.statePath), [scriptState]);
  } finally {
    fx.cleanup();
  }
});

test("途中の成果物の batch: 対象の一覧から対象を読み、続いているものだけを差し戻す", async () => {
  const fx = fixture();
  try {
    const workDir = join(fx.dir, "work", "batch");
    await startAsset(workDir, "thumb-01");
    const passed = await startAsset(workDir, "thumb-02");
    setStatus(passed, "passed", "target-reached");
    const manifest = join(workDir, "batch.json");
    writeFileSync(manifest, JSON.stringify({
      version: "buzzassist-asset-quality-batch-v1",
      stage: "thumbnail",
      items: [{ subjectId: "thumb-01", asset: "a1.png", version: "v1" }, { subjectId: "thumb-02", asset: "a2.png", version: "v1" }],
    }));
    writeLines(fx.transcript, claudeBash(`node scripts/asset-quality-loop.mjs record --work-dir "${workDir}" --stage thumbnail --batch "${manifest}" --review r.json`, { cwd: fx.dir }));
    const decision = await decideStop(stopInput(fx), { env: fx.env });
    assert.equal(decision.action, "block");
    assert.match(decision.reason, /thumbnail \/ thumb-01/u);
    assert.doesNotMatch(decision.reason, /thumb-02/u);
  } finally {
    fx.cleanup();
  }
});

test("完成動画のループ（ナレーション物語・解説）: 続いていても人の判断待ちとして通し、状態が壊れていれば伝える", async () => {
  const fx = fixture();
  try {
    const projectDir = join(fx.dir, "project");
    const narratedState = jobBoundLoopRef({ jobId: NARRATED_JOB, projectDir }).statePath;
    const explainerRunDir = join(projectDir, "canvas", "harness-runs", EXPLAINER_JOB);
    const explainerState = jobBoundLoopRef({ jobId: EXPLAINER_JOB, runDir: explainerRunDir }).statePath;
    for (const jobId of [NARRATED_JOB, EXPLAINER_JOB]) {
      const runDir = join(projectDir, "canvas", "harness-runs", jobId);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "job.json"), JSON.stringify({ id: jobId, status: "awaiting-human-review", projectDir, runDir }));
    }
    for (const file of [narratedState, explainerState]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ status: "active", startedAt: "2026-01-01T00:00:00.000Z", rounds: [{ index: 1, score: 70, failureFingerprint: FINGERPRINT }] }));
    }
    writeLines(fx.transcript, [
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__plugin_buzzassist_buzzassist_mcp__get_video_harness_job", input: { projectDir, jobId: NARRATED_JOB } }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "mcp__plugin_buzzassist_buzzassist_mcp__get_video_harness_job", input: { projectDir, jobId: EXPLAINER_JOB } }] } },
    ]);
    const input = stopInput(fx, { last_assistant_message: "2つの Job は確認待ちです。" });
    const waiting = await decideStop(input, { env: fx.env });
    assert.equal(waiting.action, "none");
    assert.equal(waiting.loopWhy, "loops-settled-or-noted");

    writeFileSync(narratedState, "{");
    writeFileSync(explainerState, JSON.stringify({ status: "active" }));
    const broken = await decideStop(input, { env: fx.env });
    assert.equal(broken.action, "block");
    assert.match(broken.reason, new RegExp(`ナレーション物語の完成動画の品質ループ（Job ${NARRATED_JOB}）の状態ファイルが読めない（JSON として壊れている）`, "u"));
    assert.match(broken.reason, new RegExp(`解説動画の完成動画の品質ループ（Job ${EXPLAINER_JOB}）の状態ファイルが読めない（品質ループの状態の形になっていない）`, "u"));
    assert.doesNotMatch(broken.reason, /次の手順: /u);
  } finally {
    fx.cleanup();
  }
});

test("完成の主張と品質ループの両方 → 1回の差し戻しにまとめ、Job の回数と付箋の両方を書く", async () => {
  const fx = fixture();
  try {
    const projectDir = join(fx.dir, "project");
    const runDir = join(projectDir, "canvas", "harness-runs", SAMPLE_JOB);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "job.json"), JSON.stringify({ id: SAMPLE_JOB, status: "running", projectDir, runDir, stages: [], blockers: [], knownRemainingIssues: [], artifacts: [] }));
    const workDir = join(projectDir, "canvas", "scripts", "ep1");
    await startScript(workDir);
    writeLines(fx.transcript, [
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__plugin_buzzassist_buzzassist_mcp__get_video_harness_job", input: { projectDir, jobId: SAMPLE_JOB } }] } },
      ...claudeBash(`node scripts/script-quality-loop.mjs start --work-dir "${workDir}" --generator-context c1`, { cwd: projectDir, id: "t2" }),
    ]);
    const output = JSON.parse((await runCli(stopInput(fx, { last_assistant_message: "動画が完成しました。" }), { env: fx.env })).stdout);
    assert.equal(output.decision, "block");
    assert.ok(output.reason.startsWith(STOP_HOOK_REASON_PREFIX));
    assert.ok(output.reason.includes(`\n${QUALITY_LOOP_REASON_PREFIX}`));
    const saved = JSON.parse(sessionState(fx));
    assert.equal(saved.jobs[SAMPLE_JOB].blocks, 1);
    assert.equal(Object.keys(saved.loops).length, 1);
  } finally {
    fx.cleanup();
  }
});

test("持ち時間を使い切ったら品質ループの判定だけを諦め、完成の主張の差し戻しは失わない（見張りの時計より前に諦める）", async () => {
  const fx = fixture();
  try {
    assert.ok(LOOP_CHECK_MARGIN_MS > 0 && LOOP_CHECK_MARGIN_MS < HARD_TIMEOUT_MS / 2, "見張りの時計の内側で諦める");
    const projectDir = join(fx.dir, "project");
    const runDir = join(projectDir, "canvas", "harness-runs", SAMPLE_JOB);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "job.json"), JSON.stringify({ id: SAMPLE_JOB, status: "running", projectDir, runDir, stages: [], blockers: [], knownRemainingIssues: [], artifacts: [] }));
    const workDir = join(projectDir, "canvas", "scripts", "ep2");
    await startScript(workDir);
    writeLines(fx.transcript, [
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__plugin_buzzassist_buzzassist_mcp__get_video_harness_job", input: { projectDir, jobId: SAMPLE_JOB } }] } },
      ...claudeBash(`node scripts/script-quality-loop.mjs start --work-dir "${workDir}" --generator-context c1`, { cwd: projectDir, id: "t2" }),
    ]);
    const expired = await decideStop(stopInput(fx, { last_assistant_message: "動画が完成しました。" }), { env: fx.env, deadline: Date.now() - 1 });
    assert.equal(expired.action, "block");
    assert.equal(expired.loopWhy, "loop-check-timeout");
    assert.ok(expired.reason.startsWith(STOP_HOOK_REASON_PREFIX));
    assert.ok(!expired.reason.includes(QUALITY_LOOP_REASON_PREFIX));
    assert.deepEqual(expired.loopMarks, [], "判定していないループに付箋を貼らない");
    // 集める途中で時間が切れても同じ（行の数が多い記録）。
    const lines = Array.from({ length: 600 }, () => "{}");
    assert.equal((await evaluateQualityLoopStop({ cwd: fx.dir, lines, deadline: Date.now() - 1 })).why, "loop-check-timeout");
  } finally {
    fx.cleanup();
  }
});

test("次の手順の説明が読めない・遅いときも、既定の文で差し戻す（止めない側に倒さない）", async () => {
  const fx = fixture();
  try {
    const workDir = join(fx.dir, "work", "script-f");
    await startScript(workDir);
    const lines = claudeBash(`node scripts/script-quality-loop.mjs start --work-dir "${workDir}" --generator-context c1`, { cwd: fx.dir }).map((entry) => JSON.stringify(entry));
    const failing = await evaluateQualityLoopStop({ cwd: fx.dir, lines, loadDetail: () => { throw new Error("synthetic"); } });
    assert.equal(failing.action, "block");
    assert.match(failing.reason, /ループの案内: 直した版を、作った文脈とも前の回とも別の評価文脈で採点して record する/u);
    const slow = await evaluateQualityLoopStop({ cwd: fx.dir, lines, loadDetail: () => new Promise(() => {}), detailTimeoutMs: 20 });
    assert.equal(slow.action, "block");
    assert.match(slow.reason, /ループの案内: 直した版を/u);
  } finally {
    fx.cleanup();
  }
});

test("評価者の会話（この会話の ID がそのループの評価文脈として記録されている）は差し戻さない。見分けられない評価者向けの一文も入れる", async () => {
  const fx = fixture();
  try {
    const workDir = join(fx.dir, "work", "script-g");
    const statePath = await startScript(workDir);
    const state = addRound(statePath);
    state.rounds[0].reviews = [{ evaluatorId: "reviewer-a", evaluatorContextId: `claude:${SESSION}`, score: 71.5, notes: "合成の所見" }];
    writeFileSync(statePath, JSON.stringify(state));
    writeLines(fx.transcript, claudeBash(`node scripts/script-quality-loop.mjs record --work-dir "${workDir}" --review r.json`, { cwd: fx.dir }));
    const evaluator = await decideStop(stopInput(fx), { env: fx.env });
    assert.equal(evaluator.action, "none");
    assert.equal(evaluator.loopWhy, "loops-settled-or-noted");
    // 別の会話（作る係）には差し戻す。評価者に届いたときのための一文がある。
    const generator = await decideStop(stopInput(fx, { session_id: "session-loop-generator-2" }), { env: fx.env });
    assert.equal(generator.action, "block");
    assert.match(generator.reason, /評価者）なら、版を直さず、記録した採点だけを報告して止まる/u);
  } finally {
    fx.cleanup();
  }
});

test("途中の成果物の案内の写しは、ループ自身の案内（assetQualityStatus の detail）と同じ文", async () => {
  const fx = fixture();
  try {
    const workDir = join(fx.dir, "work", "asset-sync");
    const statePath = await startAsset(workDir, "thumb-09");
    const lines = claudeBash(`node scripts/asset-quality-loop.mjs start --work-dir "${workDir}" --harness narrated-story-video --stage thumbnail --subject thumb-09 --generator-context c1`, { cwd: fx.dir })
      .map((entry) => JSON.stringify(entry));
    const [ref] = collectQualityLoopReferences(lines, { cwd: fx.dir });
    assert.equal(ref.statePath, statePath);
    for (const step of ["first", "after-round"]) {
      if (step === "after-round") addRound(statePath);
      const status = await assetQualityStatus({ workDir, stage: "thumbnail", subjectId: "thumb-09" });
      assert.equal(status.check.status, "active");
      assert.equal(assetActiveLoopDetail(readJson(statePath), ref), status.detail, step);
    }
  } finally {
    fx.cleanup();
  }
});

test("状態ファイルの置き場は各ループの定義と同じ", () => {
  const workDir = join(tmpdir(), "layout-work");
  assert.equal(LOOP_STATE_LAYOUT.script.dir, SCRIPT_QUALITY_DIR);
  assert.equal(LOOP_STATE_LAYOUT.script.file, SCRIPT_QUALITY_STATE_FILE);
  assert.equal(LOOP_STATE_LAYOUT.script.revisionDelta, SCRIPT_REVISION_DELTA_FILE);
  assert.equal(LOOP_STATE_LAYOUT.asset.dir, ASSET_QUALITY_DIR);
  assert.deepEqual([...ASSET_LOOP_STAGES], [...ASSET_STAGES]);
  assert.equal(LOOP_STATE_LAYOUT.strategy.dir, STRATEGY_BRIEF_QUALITY_DIR);
  assert.equal(LOOP_STATE_LAYOUT.strategy.file, STRATEGY_BRIEF_QUALITY_STATE_FILE);
  assert.equal(LOOP_STATE_LAYOUT.strategy.revisionDelta, STRATEGY_BRIEF_REVISION_DELTA_FILE);
  assert.equal(LOOP_STATE_LAYOUT.signedReview.dir, SIGNED_REVIEW_QUALITY_DIR);
  assert.equal(LOOP_STATE_LAYOUT.signedReview.file, SIGNED_REVIEW_QUALITY_STATE_FILE);
  assert.equal(LOOP_STATE_LAYOUT.explainerWorkDir, EXPLAINER_WORK_DIR);
  // ナレーション物語の Job の作業領域（production 子と signoff が同じ場所を指す定義）。
  const narrated = jobBoundLoopRef({ jobId: NARRATED_JOB, projectDir: workDir }).statePath;
  assert.equal(narrated, join(narratedStoryRunPaths({ deploymentRoot: workDir, jobId: NARRATED_JOB }).runDir, SIGNED_REVIEW_QUALITY_DIR, SIGNED_REVIEW_QUALITY_STATE_FILE));
  // Windows のパスは win32 で組む。
  assert.equal(jobBoundLoopRef({ jobId: NARRATED_JOB, projectDir: "C:\\work\\proj" }).statePath,
    win32.join("C:\\work\\proj", ".media", "narrated-story-video", NARRATED_JOB, "quality", "quality-loop-state.json"));
  assert.equal(jobBoundLoopRef({ jobId: SAMPLE_JOB, projectDir: workDir }), null, "完成動画のループを持たないハーネスは見ない");
});

test("コマンド文の分け方: 引用符・区切り・Windows のパス", () => {
  assert.deepEqual(splitShellSegments("cd '/a b' && node x.mjs record --work-dir \"c d\"; echo ok | cat"), [
    ["cd", "/a b"], ["node", "x.mjs", "record", "--work-dir", "c d"], ["echo", "ok"], ["cat"],
  ]);
  assert.deepEqual(splitShellSegments("node s.mjs start --work-dir C:\\work\\ep1 --x \\\"q\\\""), [
    ["node", "s.mjs", "start", "--work-dir", "C:\\work\\ep1", "--x", "\"q\""],
  ]);
  const lines = [JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", input: { command: "node scripts/script-quality-loop.mjs record --work-dir C:\\work\\ep1 --review r.json" } }] } })];
  assert.equal(collectQualityLoopReferences(lines, { cwd: "C:\\work" })[0].statePath, win32.join("C:\\work\\ep1", "quality", "script-quality-loop.json"));
});

test("付箋は会話ごとに上限まで（古いものから捨てる）", () => {
  let loops = {};
  for (let index = 0; index < MAX_LOOP_MARKS + 5; index += 1) {
    loops = withLoopMarks(loops, [{ key: `k${index}`, mark: "active|t|0|0" }], new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString());
  }
  assert.equal(Object.keys(loops).length, MAX_LOOP_MARKS);
  assert.equal(loops.k0, undefined);
  assert.ok(loops[`k${MAX_LOOP_MARKS + 4}`]);
  assert.equal(withLoopMarks(loops, [{ key: "k10", mark: "active|t|1|0" }], "2027-01-01T00:00:00.000Z").k10.blocks, 2);
});
