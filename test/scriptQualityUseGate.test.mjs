// 制作の Job が有料の処理の前に台本の品質ループの答えを問う共通の入口（lib/scriptQualityUseGate.mjs）。
// 台本の文・会話 id・人名はすべて合成の値。ループの状態は本物（lib/scriptQualityLoop.mjs）で作る。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  SCRIPT_QUALITY_VERDICT_CODES,
  createScriptQualityContract,
  recordScriptQualityRound,
  scriptQualityVerdict,
  startScriptQualityLoop,
} from "../lib/scriptQualityLoop.mjs";
import {
  SCRIPT_QUALITY_REQUIRED_ISSUE,
  SCRIPT_QUALITY_USE_VERSION,
  SCRIPT_QUALITY_WORK_DIR_INVALID_CODE,
  SCRIPT_QUALITY_WORK_DIR_OPTION,
  SCRIPT_QUALITY_WORK_DIR_UNBOUND_CODE,
  assertScriptQualityWorkDirBoundToJob,
  checkScriptQualityBeforeProduction,
  scriptQualityGenreForHarness,
  scriptQualityNextCommands,
  scriptQualityWorkDirFor,
  withScriptQualityWorkDirDefault,
} from "../lib/scriptQualityUseGate.mjs";
import { acceptScriptForTests } from "./helpers/scriptQualityAcceptance.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const SCRIPT = "「合成の冒頭の台詞」\n合成の地の文。\n";
const REVISED = "「合成の冒頭の台詞」\n合成の地の文を直した。\n";
let clock = Date.parse("2026-09-26T00:00:00.000Z");
const now = () => {
  clock += 60_000;
  return new Date(clock).toISOString();
};

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "script-quality-use-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "quality", "reviews"), { recursive: true });
  await writeFile(join(root, "script.md"), SCRIPT);
  return root;
}

/** 1回目で合格する採点（全項目が下限と目標点を越える）を記録する。 */
async function passLoop(root, { genre = "narrated-story", script = "script.md", text = SCRIPT } = {}) {
  await startScriptQualityLoop({ workDir: root, genre, generatorContextId: "ctx-writer", generatorHost: "claude-code", now });
  const { contract } = createScriptQualityContract({ genre });
  const rubricScores = Object.fromEntries(contract.rubric.map((row) => [row.id, row.minimumScore === 100 ? 100 : 96]));
  await writeFile(join(root, "quality", "reviews", "r1.json"), JSON.stringify({
    evaluatorId: "evaluator", evaluatorContextId: "ctx-eval-1", evaluatorHost: "codex", scriptSha256: sha(text), rubricScores,
    notes: "合成の所見: 全行を読んだ", findings: [],
  }));
  return recordScriptQualityRound({ workDir: root, scriptPath: script, versionLabel: "v1", stage: "draft", reviewPath: "quality/reviews/r1.json", now });
}

test("台本の関門のジャンルはハーネスの宣言から引く（台本の関門を持たないハーネスは空）", () => {
  assert.equal(scriptQualityGenreForHarness("narrated-story-video"), "narrated-story");
  assert.equal(scriptQualityGenreForHarness("koya-manga-video"), "manga");
  assert.equal(scriptQualityGenreForHarness("fixture-harness"), "");
  assert.equal(scriptQualityGenreForHarness(""), "");
});

test("作業フォルダは options の明示が勝ち、無ければ台本のあるフォルダ（OS のパスでそろえる）", () => {
  const scriptPath = join(tmpdir(), "synthetic-scripts", "episode-a", "script.md");
  assert.equal(scriptQualityWorkDirFor({ scriptPath }), dirname(resolve(scriptPath)));
  const explicit = join(tmpdir(), "synthetic-loop-folder");
  assert.equal(scriptQualityWorkDirFor({ options: { [SCRIPT_QUALITY_WORK_DIR_OPTION]: explicit }, scriptPath }), resolve(explicit));
  for (const bad of ["", "  ", 42, null]) {
    assert.throws(
      () => scriptQualityWorkDirFor({ options: { [SCRIPT_QUALITY_WORK_DIR_OPTION]: bad }, scriptPath }),
      (error) => error.code === SCRIPT_QUALITY_WORK_DIR_INVALID_CODE,
      `${JSON.stringify(bad)}: 空の明示を黙って台本のフォルダへ倒さない`,
    );
  }
  assert.throws(() => scriptQualityWorkDirFor({}), (error) => error.code === SCRIPT_QUALITY_WORK_DIR_INVALID_CODE);

  // start の既定: 台本の関門を持つハーネスだけ options に入れる（Job の識別子に入る）。明示は上書きしない。
  const narrated = withScriptQualityWorkDirDefault({ harnessId: "narrated-story-video", options: { episodeId: "ep" }, scriptPath });
  assert.deepEqual(narrated, { episodeId: "ep", [SCRIPT_QUALITY_WORK_DIR_OPTION]: dirname(resolve(scriptPath)) });
  const koya = withScriptQualityWorkDirDefault({ harnessId: "koya-manga-video", options: { [SCRIPT_QUALITY_WORK_DIR_OPTION]: explicit }, scriptPath });
  assert.equal(koya[SCRIPT_QUALITY_WORK_DIR_OPTION], resolve(explicit));
  const other = { title: "x" };
  assert.equal(withScriptQualityWorkDirDefault({ harnessId: "fixture-harness", options: other, scriptPath }), other);
});

test("Windows のパスでも作業フォルダは台本のあるフォルダで、Job の宣言との照合もドライブ名を含む path で比べる", () => {
  const win = path.win32;
  const scriptPath = win.join("C:\\", "Users", "synthetic", "scripts", "ep", "script.md");
  assert.equal(win.dirname(scriptPath), "C:\\Users\\synthetic\\scripts\\ep");
  // JSON に書いた Windows のパスは \\ で往復する（options は Job の JSON に入る）。
  const options = JSON.parse(JSON.stringify({ [SCRIPT_QUALITY_WORK_DIR_OPTION]: win.dirname(scriptPath) }));
  assert.equal(options[SCRIPT_QUALITY_WORK_DIR_OPTION], "C:\\Users\\synthetic\\scripts\\ep");
  // この端末の OS のパスでの照合（path.resolve でそろえてから比べる）。
  const workDir = join(tmpdir(), "synthetic-bound");
  assert.doesNotThrow(() => assertScriptQualityWorkDirBoundToJob({ job: { options: { [SCRIPT_QUALITY_WORK_DIR_OPTION]: workDir } }, scriptQualityWorkDir: resolve(workDir) }));
});

test("子へ渡した作業フォルダは Job の宣言と同じでなければ止まる（どちらも無い古い Job は通す）", () => {
  const workDir = join(tmpdir(), "synthetic-bound-a");
  const job = { options: { [SCRIPT_QUALITY_WORK_DIR_OPTION]: workDir } };
  assert.doesNotThrow(() => assertScriptQualityWorkDirBoundToJob({ job, scriptQualityWorkDir: workDir }));
  assert.doesNotThrow(() => assertScriptQualityWorkDirBoundToJob({ job: { options: {} }, scriptQualityWorkDir: "" }));
  for (const [declared, passed] of [[workDir, join(tmpdir(), "synthetic-bound-b")], [workDir, ""], ["", workDir]]) {
    assert.throws(
      () => assertScriptQualityWorkDirBoundToJob({ job: { options: declared ? { [SCRIPT_QUALITY_WORK_DIR_OPTION]: declared } : {} }, scriptQualityWorkDir: passed }),
      (error) => error.code === SCRIPT_QUALITY_WORK_DIR_UNBOUND_CODE,
    );
  }
});

test("ループが合格した版・人の受け入れは通り、ループ未開始・未合格・合格後の変更は理由コードと両方の次のコマンドで止まる", async (t) => {
  const root = await workspace(t);
  const scriptPath = join(root, "script.md");
  const ask = (genre = "narrated-story", input = scriptPath) => checkScriptQualityBeforeProduction({ workDir: root, scriptPath: input, genre, commandScriptPath: input });

  // ループ未開始。
  const notStarted = await ask();
  assert.equal(notStarted.pass, false);
  assert.equal(notStarted.reasonCode, SCRIPT_QUALITY_VERDICT_CODES.notStarted);
  assert.deepEqual(notStarted.issues, [`${SCRIPT_QUALITY_REQUIRED_ISSUE}:script-quality-loop-not-started`]);
  const lines = notStarted.next.join("\n");
  assert.match(lines, /accept-human --work-dir .* --script script\.md --reviewer <確認した人> .*--human-verified/u, "依頼者の台本をそのまま使う口");
  assert.match(lines, /script-quality-loop\.mjs start --work-dir .* --genre narrated-story/u, "直しを提案する口");
  assert.match(lines, /resume/u);
  assert.equal(notStarted.evidence.version, SCRIPT_QUALITY_USE_VERSION);
  assert.equal(notStarted.evidence.acceptedBy, null);
  assert.equal(notStarted.scriptSha256, sha(SCRIPT));

  // ループが合格した版。
  const recorded = await passLoop(root);
  assert.equal(recorded.state.status, "passed", JSON.stringify(recorded.issues));
  const passed = await ask();
  assert.equal(passed.pass, true);
  assert.equal(passed.reasonCode, SCRIPT_QUALITY_VERDICT_CODES.passed);
  assert.equal(passed.acceptedBy, "quality-loop");
  assert.deepEqual(passed.issues, []);
  assert.deepEqual(passed.next, []);
  assert.equal(passed.evidence.loop.status, "passed");
  assert.equal(passed.evidence.loop.versionLabel, "v1");
  // 監査の記録に、台本の文・所見・人名・パスを持たない。
  const evidenceText = JSON.stringify(passed.evidence);
  for (const forbidden of ["合成の", root, "ctx-eval-1", "evaluator"]) assert.equal(evidenceText.includes(forbidden), false, forbidden);

  // 別ジャンルの採点表での合格は、漫画の制作には使えない。
  const mismatch = await ask("manga");
  assert.equal(mismatch.pass, false);
  assert.equal(mismatch.reasonCode, SCRIPT_QUALITY_VERDICT_CODES.genreMismatch);
  assert.match(mismatch.next.join("\n"), /--genre manga/u);

  // 合格した後に台本が変わった（制作が読む写しのバイト列が違う）。
  const copy = join(root, "job-copy", "script.md");
  await mkdir(dirname(copy), { recursive: true });
  await writeFile(copy, REVISED);
  const changed = await ask("narrated-story", copy);
  assert.equal(changed.pass, false);
  assert.equal(changed.reasonCode, SCRIPT_QUALITY_VERDICT_CODES.changedAfterPass);
  assert.match(changed.next.join("\n"), /record --work-dir .* --stage revision/u);

  // 人がその写し（同じバイト列）をそのまま使うと認めれば通る（ループの合格とは別の理由）。
  await writeFile(join(root, "operator-script.md"), REVISED);
  const accepted = await acceptScriptForTests(join(root, "operator-script.md"), { workDir: root });
  assert.equal(accepted.counted, true);
  const human = await ask("narrated-story", copy);
  assert.equal(human.pass, true);
  assert.equal(human.reasonCode, SCRIPT_QUALITY_VERDICT_CODES.humanAccepted);
  assert.equal(human.acceptedBy, "human");
  assert.ok(human.evidence.humanAcceptance.recordedAt);
  assert.equal(JSON.stringify(human.evidence).includes("synthetic-operator"), false, "人名を監査の記録に持たない");
  // 人の受け入れはジャンルを問わない。
  assert.equal((await ask("manga", copy)).pass, true);
});

test("採点したが合格していない版は script-quality-not-passed で止まり、ループの次の手順を案内する", async (t) => {
  const root = await workspace(t);
  await startScriptQualityLoop({ workDir: root, genre: "manga", generatorContextId: "ctx-writer", generatorHost: "claude-code", now });
  const { contract } = createScriptQualityContract({ genre: "manga" });
  const rubricScores = Object.fromEntries(contract.rubric.map((row) => [row.id, row.id === "speaker-attribution" ? 50 : 96]));
  await writeFile(join(root, "quality", "reviews", "r1.json"), JSON.stringify({
    evaluatorId: "evaluator", evaluatorContextId: "ctx-eval-1", evaluatorHost: "codex", scriptSha256: sha(SCRIPT), rubricScores,
    notes: "合成の所見: 話者が読めない行がある", findings: ["合成の指摘"],
  }));
  const failed = await recordScriptQualityRound({ workDir: root, scriptPath: "script.md", versionLabel: "v1", stage: "draft", reviewPath: "quality/reviews/r1.json", now });
  assert.equal(failed.state.status, "active");
  const gate = await checkScriptQualityBeforeProduction({ workDir: root, scriptPath: join(root, "script.md"), genre: "manga" });
  assert.equal(gate.pass, false);
  assert.equal(gate.reasonCode, SCRIPT_QUALITY_VERDICT_CODES.notPassed);
  assert.deepEqual(gate.issues, ["script-quality-required:script-quality-not-passed"]);
  assert.equal(gate.evidence.loop.status, "active");
  assert.ok(gate.evidence.loop.score < gate.evidence.loop.targetScore);
  const lines = gate.next.join("\n");
  assert.match(lines, /status --work-dir/u);
  assert.match(lines, /accept-human/u, "依頼者の台本をそのまま使う口も並べる");
});

test("作業フォルダの外にある台本（Job の写し）は、次のコマンドに置き場の説明と SHA の頭を書く", () => {
  const workDir = join(tmpdir(), "synthetic-loop");
  const inside = scriptQualityNextCommands({ reasonCode: "script-quality-loop-not-started", workDir, scriptPath: join(workDir, "sub", "script.md"), scriptSha256: "a".repeat(64), genre: "manga" });
  assert.match(inside.join("\n"), /--script sub\/script\.md/u, "作業フォルダの中なら / 区切りの相対パス");
  const outside = scriptQualityNextCommands({ reasonCode: "script-quality-not-passed", workDir, scriptPath: join(tmpdir(), "harness-runs", "input", "script.md"), scriptSha256: "b".repeat(64), genre: "manga" });
  assert.match(outside.join("\n"), /<作業フォルダの中の台本（sha256 bbbbbbbbbbbb…）>/u);
  for (const code of Object.values(SCRIPT_QUALITY_VERDICT_CODES).filter((value) => !["script-quality-passed", "script-quality-human-accepted"].includes(value))) {
    const next = scriptQualityNextCommands({ reasonCode: code, workDir, genre: "narrated-story" });
    assert.ok(next.some((line) => line.includes("accept-human")), `${code}: accept-human の口`);
    assert.ok(next.length >= 3, code);
  }
});

test("verdict の genre: 知らないジャンルは例外、ループの合格はそのジャンルの採点表のものだけ", async (t) => {
  const root = await workspace(t);
  await passLoop(root, { genre: "manga" });
  const scriptPath = join(root, "script.md");
  assert.equal((await scriptQualityVerdict({ workDir: root, scriptPath, genre: "manga" })).pass, true);
  assert.equal((await scriptQualityVerdict({ workDir: root, scriptPath })).pass, true, "genre を渡さなければ従来どおり");
  assert.equal((await scriptQualityVerdict({ workDir: root, scriptPath, genre: "narrated-story" })).reasonCode, "script-quality-genre-mismatch");
  await assert.rejects(scriptQualityVerdict({ workDir: root, scriptPath, genre: "unknown-genre" }), /未知の台本ジャンル/u);
});
