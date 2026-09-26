import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  GRADER_FORBIDDEN_WORDS,
  SKILL_EVAL_RECORD_SCHEMA,
  buildSkillEvalPlan,
  childEnvironmentFor,
  escapeCmdArgument,
  loadSkillEvalTargets,
  normalizeSkillEvalCases,
  readSkillEvalRecords,
  resolveEvalConcurrency,
  resolveSkillEvalsDir,
  sanitizeRecordText,
  summarizeSkillEvals,
  windowsCmdInvocation,
} from "../lib/skillEvals.mjs";
import { skillBundleDigestOf } from "../lib/skillInventory.mjs";
import { runSkillEvalsCli } from "../scripts/skill-evals.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const fakeAgent = fileURLToPath(new URL("./fixtures/fakeSkillEvalAgent.mjs", import.meta.url));
const inventoryCli = join(repoRoot, "scripts", "skill-inventory.mjs");

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

// 公開リポジトリなので、スキル名・依頼文はすべて合成のもの。
const SKILLS = {
  "alpha-skill": {
    md: "---\nname: alpha-skill\ndescription: アルファ系の依頼で使う合成スキル。\n---\n\n# アルファ\n\n手順を書く。\n",
    references: { "references/notes.md": "補足\n" },
    evals: {
      skill_name: "alpha-skill",
      evals: [
        { id: 1, prompt: "アルファの依頼をこなして。", expected_output: "手順を書く", files: [], expectations: ["応答に手順がある", "余計な操作をしない"] },
        { id: 2, prompt: "アルファの別の依頼 [weak-on-second]", expected_output: "手順を書く", files: [] },
      ],
    },
  },
  "beta-skill": {
    md: "---\nname: beta-skill\ndescription: ベータ系の依頼で使う合成スキル。\n---\n\n# ベータ\n\n入口を確かめる。\n",
    references: {},
    evals: {
      schemaVersion: 1,
      skill: "beta-skill",
      cases: [
        { id: "b-trigger", prompt: "ベータの依頼を進めて。", shouldTrigger: true, invariants: ["入口を確かめる"] },
        { id: "b-negative", prompt: "関係の無い依頼 [no-skill]", shouldTrigger: false, invariants: ["スキルを使わない"] },
        { id: "b-write", prompt: "ベータの依頼 [try-write]", shouldTrigger: true, invariants: ["入口を確かめる"] },
      ],
    },
  },
};

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function makeFixture() {
  // macOS の一時ディレクトリは /private 経由の実体を持つ。子の process.cwd() と比べるので実体にそろえる。
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skill-evals-")));
  const project = join(root, "project");
  const skills = [];
  for (const [name, spec] of Object.entries(SKILLS)) {
    const dir = join(project, ".agents", "skills", name);
    writeFile(join(dir, "SKILL.md"), spec.md);
    for (const [rel, content] of Object.entries(spec.references)) writeFile(join(dir, ...rel.split("/")), content);
    writeFile(join(dir, "evals", "evals.json"), `${JSON.stringify(spec.evals, null, 2)}\n`);
    const contentSha256 = sha(spec.md);
    // 承認は束（SKILL.md と references。evals/ は外す）にも付く。合成のファイルは改行が LF だけなので、
    // 中身の sha256 をそのまま並べた一覧が束の正規の一覧になる。
    const bundleSha256 = skillBundleDigestOf(
      [["SKILL.md", spec.md], ...Object.entries(spec.references)]
        .map(([path, content]) => ({ path, sha256: createHash("sha256").update(content).digest("hex") }))
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    );
    skills.push({
      id: `buzzassist:${name}`,
      name,
      version: "1.0.0",
      contentSha256,
      bundleSha256,
      language: "ja",
      owner: "test",
      origin: "project-canonical",
      canonicalPath: `.agents/skills/${name}/SKILL.md`,
      hosts: ["claude-code", "codex"],
      adapters: [],
      classification: { installed: false, bundled: true, productionAllowed: true, developmentOnly: false },
      approval: { reviewer: "試験の承認者", approvedAt: "2026-09-25T00:00:00.000Z", version: "1.0.0", contentSha256, bundleSha256, attestedBy: "human-verified" },
    });
  }
  writeFile(join(project, ".agents", "skills", "inventory.manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    manifestVersion: "1.0.0",
    namespace: "buzzassist",
    classifications: ["installed", "bundled", "productionAllowed", "developmentOnly"],
    skills,
    plugins: [],
  }, null, 2)}\n`);
  writeFile(join(project, ".agents", "skills", "profiles.manifest.json"), readFileSync(join(repoRoot, ".agents", "skills", "profiles.manifest.json")));

  const fakeBin = join(root, "bin");
  mkdirSync(fakeBin, { recursive: true });
  for (const host of ["claude", "codex"]) {
    writeFileSync(join(fakeBin, `${host}.cmd`), `@echo off\r\n"${process.execPath}" "${fakeAgent}" ${host} %*\r\n`);
    writeFileSync(join(fakeBin, host), `#!/bin/sh\nexec "${process.execPath}" "${fakeAgent}" ${host} "$@"\n`);
    chmodSync(join(fakeBin, host), 0o755);
  }
  const home = join(root, "home");
  const learning = join(root, "learning");
  const workRoot = join(root, "work");
  const log = join(root, "cli.log");
  for (const dir of [home, learning, workRoot]) mkdirSync(dir, { recursive: true });
  writeFileSync(log, "");

  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^path$/iu.test(key)) env[key] = value;
  // 本物の claude / codex に届かないよう、PATH は偽物のディレクトリだけにする。
  env.PATH = process.platform === "win32" ? [fakeBin, join(process.env.SystemRoot || "C:\\Windows", "System32")].join(";") : fakeBin;
  env.HOME = home;
  env.USERPROFILE = home;
  env.BUZZASSIST_LEARNING_DIR = learning;
  env.FAKE_CLI_LOG = log;
  env.FISH_AUDIO_API_KEY = "synthetic-value-for-test";
  delete env.BUZZASSIST_LEARNING_WRITE_FORBIDDEN;
  delete env.FAKE_FAIL_HOST;
  return { root, project, home, learning, workRoot, log, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function readLog(fixture) {
  return readFileSync(fixture.log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function capture() {
  let text = "";
  return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
}

function treeDigest(root) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else out.push(`${relative(root, full)}:${sha(readFileSync(full))}`);
    }
  };
  visit(root);
  return out.sort().join("\n");
}

function isInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !/^[A-Za-z]:/u.test(rel));
}

async function runCli(fixture, argv, extraEnv = {}) {
  const stdout = capture();
  const stderr = capture();
  const result = await runSkillEvalsCli(argv, { env: { ...fixture.env, ...extraEnv }, stdout, stderr, homeDir: fixture.home, workRoot: fixture.workRoot });
  return { ...result, stdout: stdout.text, stderr: stderr.text };
}

test("evals.json の2つの形（skill-creator の evals と BuzzAssist の cases）をそろえる", () => {
  const creator = normalizeSkillEvalCases(SKILLS["alpha-skill"].evals);
  assert.deepEqual(creator.map((entry) => [entry.id, entry.assertions, entry.assertionSource]), [
    ["1", ["応答に手順がある", "余計な操作をしない"], "expectations"],
    ["2", ["手順を書く"], "expected_output"],
  ]);
  const cases = normalizeSkillEvalCases(SKILLS["beta-skill"].evals);
  assert.deepEqual(cases.map((entry) => [entry.id, entry.shouldTrigger, entry.assertionSource]), [
    ["b-trigger", true, "invariants"], ["b-negative", false, "invariants"], ["b-write", true, "invariants"],
  ]);
  // evals の中に invariants を持つ項目が混ざっていても読む（正本にその形がある）
  const mixed = normalizeSkillEvalCases({ evals: [{ id: 1, prompt: "p", expectations: ["a"] }, { id: "x", prompt: "q", shouldTrigger: true, invariants: ["b"] }] });
  assert.deepEqual(mixed.map((entry) => entry.assertions), [["a"], ["b"]]);
  assert.throws(() => normalizeSkillEvalCases({ evals: [{ id: 1, prompt: "p", expectations: ["a"] }, { id: 1, prompt: "q", expectations: ["b"] }] }), /重複/u);
  assert.throws(() => normalizeSkillEvalCases({ cases: [{ id: "a", prompt: "p" }] }), /確認項目/u);
});

test("今の全正本スキルの evals.json を読める（形の崩れを試験で見つける）", async () => {
  const loaded = await loadSkillEvalTargets({ projectDir: repoRoot });
  assert.ok(loaded.targets.length >= 7, `正本スキルが読めていない: ${loaded.targets.length}`);
  for (const target of loaded.targets) {
    assert.ok(target.cases.length > 0, `${target.skillId} の eval が空`);
    assert.equal(target.manifestShaMatches, true, `${target.skillId} の manifest の SHA が正本と違う`);
  }
  const plan = buildSkillEvalPlan(loaded, { cpuCount: 8 });
  const evalCount = loaded.targets.reduce((sum, target) => sum + target.cases.length, 0);
  assert.equal(plan.evalCount, evalCount);
  assert.equal(plan.totalCalls, evalCount * 4, "1 eval あたり 2ホスト × （実行＋採点）");
});

test("plan は呼び出し回数の見込みを出すだけで、何も起動しない", async () => {
  const fixture = makeFixture();
  try {
    const loaded = await loadSkillEvalTargets({ projectDir: fixture.project });
    const plan = buildSkillEvalPlan(loaded, { cpuCount: 8 });
    assert.equal(plan.evalCount, 5);
    assert.deepEqual(plan.calls, { claude: { executor: 5, grader: 5, total: 10 }, codex: { executor: 5, grader: 5, total: 10 } });
    assert.equal(plan.totalCalls, 20);
    for (const job of plan.jobs) assert.notEqual(job.executor.host, job.grader.host, "既定の採点は別のホスト");
    assert.deepEqual(plan.concurrency, { claude: 6, codex: 8, source: "auto" });

    const onlyClaude = buildSkillEvalPlan(loaded, { hosts: ["claude"], cpuCount: 8 });
    assert.deepEqual(onlyClaude.calls, { claude: { executor: 5, grader: 0, total: 5 }, codex: { executor: 0, grader: 5, total: 5 } });

    const planned = await runCli(fixture, ["plan", "--project-dir", fixture.project]);
    assert.match(planned.stdout, /合計 20 回/u);
    assert.match(planned.stdout, /モデルは呼びません/u);
    const notExecuted = await runCli(fixture, ["run", "--project-dir", fixture.project]);
    assert.match(notExecuted.stderr, /--execute が無いので実行しません/u);
    const help = await runCli(fixture, ["run", "--execute", "--help"]);
    assert.match(help.stdout, /run --execute/u);
    assert.equal(readLog(fixture).length, 0, "plan・--execute なしの run・--help は CLI を1回も起動しない");
    assert.deepEqual(readdirSync(fixture.learning), [], "記録も書かない");
  } finally {
    fixture.cleanup();
  }
});

test("並列数は実測の上限に従い、観測値16を超える指定は受けない", () => {
  assert.deepEqual(resolveEvalConcurrency("auto", 8), { claude: 6, codex: 8, source: "auto" });
  assert.deepEqual(resolveEvalConcurrency("auto", 4), { claude: 2, codex: 8, source: "auto" });
  assert.deepEqual(resolveEvalConcurrency("auto", 32), { claude: 10, codex: 8, source: "auto" });
  assert.deepEqual(resolveEvalConcurrency("16", 8), { claude: 16, codex: 16, source: "explicit" });
  assert.throws(() => resolveEvalConcurrency("17", 8), /16 以下/u);
  assert.throws(() => resolveEvalConcurrency("0", 8), /1 以上/u);
});

test("run --execute: 別のホストが採点し、採点者に合格点も実行者も見せず、一時ディレクトリの外に書かない", async () => {
  const fixture = makeFixture();
  try {
    const projectBefore = treeDigest(fixture.project);
    const run = await runCli(fixture, ["run", "--execute", "--project-dir", fixture.project, "--eval", "1", "--eval", "2", "--eval", "b-trigger", "--eval", "b-negative"]);
    assert.equal(run.exitCode, 0, run.stdout + run.stderr);

    // 記録: 1回の eval 実行ごとに1行
    const files = readdirSync(join(fixture.learning, "evals"));
    assert.equal(files.length, 1);
    const { records, malformed } = readSkillEvalRecords(join(fixture.learning, "evals"));
    assert.equal(malformed, 0);
    assert.equal(records.length, 8, "4 eval × 2ホスト");
    for (const record of records) {
      assert.equal(record.schema, SKILL_EVAL_RECORD_SCHEMA);
      assert.equal(record.status, "graded", JSON.stringify(record));
      assert.notEqual(record.grader.host, record.host, "採点は実行したのと別のホスト");
      assert.equal(record.skillVersion, "1.0.0");
      assert.equal(record.contentSha256, sha(SKILLS[record.skillName].md));
      assert.ok(Number.isFinite(record.durationMs.total));
      assert.ok(record.assertions.every((entry) => typeof entry.passed === "boolean" && entry.evidence));
    }
    const claudeRecord = records.find((record) => record.host === "claude");
    assert.equal(claudeRecord.observedModel, "fake-claude-model", "Claude の実際のモデル名が残る");
    assert.equal(claudeRecord.cliVersion, "0.0.0-fake-claude");

    // 発火の確認は作業の記録から機械で決める
    const negative = records.filter((record) => record.evalId === "b-negative");
    assert.ok(negative.every((record) => record.assertions.some((entry) => entry.source === "trace" && entry.passed)), "読まなかったことが合格として残る");
    const trigger = records.filter((record) => record.evalId === "b-trigger");
    assert.ok(trigger.every((record) => record.trace.filesRead.includes(".agents/skills/beta-skill/SKILL.md")), "両ホストとも読んだファイルが同じ形で残る");

    const log = readLog(fixture);
    const executors = log.filter((entry) => entry.role === "executor");
    const graders = log.filter((entry) => entry.role === "grader");
    assert.equal(executors.length, 8);
    assert.equal(graders.length, 8);
    assert.equal(executors.filter((entry) => entry.host === "claude").length, graders.filter((entry) => entry.host === "codex").length, "Claude の出力は Codex が採点する");
    assert.equal(executors.filter((entry) => entry.host === "codex").length, graders.filter((entry) => entry.host === "claude").length, "Codex の出力は Claude が採点する");

    const allAssertions = Object.values(SKILLS).flatMap((spec) => normalizeSkillEvalCases(spec.evals).flatMap((entry) => entry.assertions));
    for (const entry of graders) {
      for (const word of GRADER_FORBIDDEN_WORDS) assert.equal(entry.input.includes(word), false, `採点者の入力に「${word}」がある`);
      assert.doesNotMatch(entry.input, /claude|codex|fake-claude-model/iu, "採点者に実行者のホスト名・モデル名を見せない");
      assert.equal(entry.input.includes("GOOD がある"), false, "前回の採点の根拠を見せない");
      assert.ok(isInside(fixture.workRoot, entry.cwd), "採点者は一時ディレクトリで動く");
      assert.deepEqual(entry.tree, [], "採点者の作業ディレクトリは空");
    }
    for (const entry of executors) {
      assert.ok(isInside(fixture.workRoot, entry.cwd), `実行者の作業ディレクトリが一時ディレクトリの外: ${entry.cwd}`);
      assert.equal(entry.tree.some((file) => file.includes("/evals/") || file.endsWith("evals.json")), false, "写しに evals を入れない");
      assert.ok(entry.tree.includes(".agents/skills/alpha-skill/references/notes.md"), "スキルの参照ファイルは写す");
      for (const text of allAssertions) assert.equal(entry.input.includes(text), false, "実行者に確認項目を見せない");
      assert.equal(entry.env.learningWriteForbidden, "child-agent", "子は学習を書かない");
      assert.equal(entry.env.fishKey, null, "制作用の鍵を子へ渡さない");
      if (entry.host === "claude") {
        assert.deepEqual(entry.argv.slice(entry.argv.indexOf("--tools"), entry.argv.indexOf("--tools") + 2), ["--tools", "Read,Glob,Grep"]);
        assert.ok(entry.argv[entry.argv.indexOf("--disallowedTools") + 1].split(",").includes("Write"));
        for (const flag of ["-p", "--safe-mode", "--restricted", "--no-session-persistence", "--strict-mcp-config"]) assert.ok(entry.argv.includes(flag), flag);
      } else {
        assert.equal(entry.argv[entry.argv.indexOf("--sandbox") + 1], "read-only");
        for (const flag of ["exec", "--ephemeral", "--ignore-user-config", "--json"]) assert.ok(entry.argv.includes(flag), flag);
        assert.equal(entry.argv.at(-1), "-", "プロンプトは stdin");
      }
    }

    assert.equal(treeDigest(fixture.project), projectBefore, "本物のプロジェクトを書き換えない");
    assert.deepEqual(readdirSync(fixture.home), [], "HOME に何も書かない");
    assert.deepEqual(readdirSync(fixture.workRoot), [], "一時ディレクトリは終わったら消す");

    // report: 片方のホストだけ落ちた eval を拾う
    const summary = summarizeSkillEvals(records);
    assert.deepEqual(summary.oneSided.map((entry) => [entry.skillId, entry.evalId, entry.passedHosts, entry.failedHosts]), [
      ["buzzassist:alpha-skill", "2", ["claude"], ["codex"]],
    ]);
    const reported = await runCli(fixture, ["report", "--project-dir", fixture.project]);
    assert.match(reported.stdout, /片方のホストだけ落ちた eval/u);
    assert.match(reported.stdout, /\| buzzassist:alpha-skill \| 1\.0\.0 \| 2 \| claude \| codex \|/u);
    // 記録に端末のパスを残さない
    const raw = readFileSync(join(fixture.learning, "evals", files[0]), "utf8");
    assert.equal(raw.includes(fixture.root), false);
    assert.equal(raw.includes(fixture.home), false);
  } finally {
    fixture.cleanup();
  }
});

test("実行者が写しを書き換えたら、その出力は採点しない", async () => {
  const fixture = makeFixture();
  try {
    const run = await runCli(fixture, ["run", "--execute", "--project-dir", fixture.project, "--eval", "b-write"]);
    assert.equal(run.exitCode, 1);
    const { records } = readSkillEvalRecords(join(fixture.learning, "evals"));
    assert.equal(records.length, 2);
    for (const record of records) {
      assert.equal(record.status, "executor-error");
      assert.match(record.error, /^sandbox-modified: .*escaped\.txt/u);
    }
    assert.equal(readLog(fixture).filter((entry) => entry.role === "grader").length, 0);
    assert.deepEqual(readdirSync(fixture.workRoot), []);
  } finally {
    fixture.cleanup();
  }
});

test("利用枠の上限で落ちたホストへは、残りを投げない", async () => {
  const fixture = makeFixture();
  try {
    const run = await runCli(fixture, ["run", "--execute", "--project-dir", fixture.project, "--concurrency", "1", "--eval", "1", "--eval", "2", "--eval", "b-trigger"], { FAKE_FAIL_HOST: "claude" });
    assert.equal(run.exitCode, 1);
    assert.match(run.stdout, /claude は利用枠か認証で止まった/u);
    const claudeCalls = readLog(fixture).filter((entry) => entry.host === "claude");
    assert.equal(claudeCalls.length, 1, "最初の失敗で止め、2回目を投げない");
    const { records } = readSkillEvalRecords(join(fixture.learning, "evals"));
    assert.equal(records.length, 6);
    assert.ok(records.some((record) => record.status === "skipped" && record.reason === "host-halted:claude"));
    assert.equal(records.filter((record) => record.status === "graded").length, 0, "採点者が止まったので合否は1件も付かない");
  } finally {
    fixture.cleanup();
  }
});

test("子エージェントからは評価の記録を書かない", async () => {
  const fixture = makeFixture();
  try {
    await assert.rejects(
      () => runCli(fixture, ["run", "--execute", "--project-dir", fixture.project, "--eval", "1"], { BUZZASSIST_LEARNING_WRITE_FORBIDDEN: "child-agent" }),
      /学習を書きません/u,
    );
    assert.equal(readLog(fixture).length, 0);
  } finally {
    fixture.cleanup();
  }
});

function syntheticRecord({ skillId, version = "1.0.0", contentSha256, evalId, host, passed, total = 2, recordedAt = "2026-09-25T00:00:00.000Z", evidence = "根拠" }) {
  return {
    schema: SKILL_EVAL_RECORD_SCHEMA,
    runId: "synthetic",
    jobIndex: 0,
    recordedAt,
    skillId,
    skillName: skillId.split(":").at(-1),
    skillVersion: version,
    contentSha256,
    evalId,
    host,
    model: null,
    observedModel: `${host}-model`,
    grader: { host: host === "claude" ? "codex" : "claude", freshContext: true },
    status: "graded",
    assertions: Array.from({ length: total }, (_, index) => ({ index: index + 1, text: `項目${index + 1}`, passed: index < passed, evidence, source: "grader" })),
    passed,
    total,
    allPassed: passed === total,
    durationMs: { executor: 1, grader: 1, total: 2 },
  };
}

test("report は前の版からの悪化を拾い、読めない行を数える", async () => {
  const fixture = makeFixture();
  try {
    const dir = join(fixture.learning, "evals");
    mkdirSync(dir, { recursive: true });
    const old = sha("old");
    const current = sha("current");
    const lines = [
      syntheticRecord({ skillId: "buzzassist:alpha-skill", version: "1.0.0", contentSha256: old, evalId: "1", host: "claude", passed: 2, recordedAt: "2026-09-01T00:00:00.000Z" }),
      syntheticRecord({ skillId: "buzzassist:alpha-skill", version: "1.0.0", contentSha256: old, evalId: "1", host: "codex", passed: 2, recordedAt: "2026-09-01T00:00:00.000Z" }),
      syntheticRecord({ skillId: "buzzassist:alpha-skill", version: "1.1.0", contentSha256: current, evalId: "1", host: "claude", passed: 1, recordedAt: "2026-09-20T00:00:00.000Z" }),
      syntheticRecord({ skillId: "buzzassist:alpha-skill", version: "1.1.0", contentSha256: current, evalId: "1", host: "codex", passed: 2, recordedAt: "2026-09-20T00:00:00.000Z" }),
    ].map((record) => JSON.stringify(record));
    writeFileSync(join(dir, "synthetic.jsonl"), `${lines.join("\n")}\n{"broken":\n`);
    const { records, malformed } = readSkillEvalRecords(dir);
    assert.equal(records.length, 4);
    assert.equal(malformed, 1);
    const summary = summarizeSkillEvals(records);
    assert.deepEqual(summary.regressions.map((entry) => [entry.evalId, entry.host, entry.previous.version, entry.current.version, entry.current.passed]), [["1", "claude", "1.0.0", "1.1.0", 1]]);
    assert.deepEqual(summary.oneSided.map((entry) => [entry.evalId, entry.failedHosts]), [["1", ["claude"]]]);
    assert.equal(summary.rows.length, 4, "版ごと・ホストごとに1行");
    const reported = await runCli(fixture, ["report", "--project-dir", fixture.project]);
    assert.match(reported.stdout, /前の版からの悪化/u);
    assert.match(reported.stdout, /\| buzzassist:alpha-skill \| 1 \| claude \| 1\.0\.0（2\/2/u);
    assert.match(reported.stdout, /読めない行 1/u);
  } finally {
    fixture.cleanup();
  }
});

function inventoryRelease(fixture, extraArgs = []) {
  return spawnSync(process.execPath, [inventoryCli, "--project-dir", fixture.project, "--require-approval", ...extraArgs], {
    cwd: fixture.project,
    env: { ...fixture.env, PATH: process.env.PATH },
    encoding: "utf8",
  });
}

test("skills:check:release は承認する版の eval 結果を警告し、--require-evals のときだけ止める", () => {
  const fixture = makeFixture();
  try {
    // 結果が無い: 既定は警告だけ（exit 0）、--require-evals なら exit 5
    let result = inventoryRelease(fixture);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /警告のみ/u);
    assert.match(result.stdout, /buzzassist:alpha-skill 1\.0\.0 .*記録 claude 0\/2、codex 0\/2/u);
    result = inventoryRelease(fixture, ["--require-evals"]);
    assert.equal(result.status, 5);

    // 両ホストの結果がそろい、全部合格: 止めない
    const dir = join(fixture.learning, "evals");
    mkdirSync(dir, { recursive: true });
    const records = [];
    for (const [name, spec] of Object.entries(SKILLS)) {
      for (const evalCase of normalizeSkillEvalCases(spec.evals)) {
        for (const host of ["claude", "codex"]) records.push(syntheticRecord({ skillId: `buzzassist:${name}`, contentSha256: sha(spec.md), evalId: evalCase.id, host, passed: 2 }));
      }
    }
    writeFileSync(join(dir, "complete.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    result = inventoryRelease(fixture, ["--require-evals"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /2\/2 スキルで両ホストの結果がそろい/u);

    // 別の版（SHA）の結果は数えない
    writeFileSync(join(dir, "complete.jsonl"), `${records.map((record) => JSON.stringify({ ...record, contentSha256: sha("別の版") })).join("\n")}\n`);
    result = inventoryRelease(fixture, ["--require-evals"]);
    assert.equal(result.status, 5, "承認する版と違う SHA の結果で通さない");

    // 片方のホストだけ落ちた eval がある: 既定は警告、--require-evals で止める
    writeFileSync(join(dir, "complete.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    writeFileSync(join(dir, "later.jsonl"), `${JSON.stringify(syntheticRecord({ skillId: "buzzassist:beta-skill", contentSha256: sha(SKILLS["beta-skill"].md), evalId: "b-trigger", host: "codex", passed: 1, recordedAt: "2026-09-26T00:00:00.000Z" }))}\n`);
    result = inventoryRelease(fixture);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /片方だけ落ちた eval b-trigger（合格 claude \/ 不合格 codex）/u);
    result = inventoryRelease(fixture, ["--require-evals"]);
    assert.equal(result.status, 5);

    // --json のときは標準出力を JSON だけに保つ
    result = inventoryRelease(fixture, ["--json"]);
    const report = JSON.parse(result.stdout);
    assert.equal(report.evalCoverage.ok, false);
    assert.match(result.stderr, /片方だけ落ちた/u);
  } finally {
    fixture.cleanup();
  }
});

test("記録の置き場は学習の置き場と同じ規則", () => {
  const home = join(tmpdir(), "skill-evals-home-example");
  assert.deepEqual(resolveSkillEvalsDir({ repoRoot: repoRoot, env: {}, homeDir: home }), { dir: join(repoRoot, "docs", "learning", "evals"), source: "development-checkout" });
  const bare = mkdtempSync(join(tmpdir(), "skill-evals-bare-"));
  try {
    assert.deepEqual(resolveSkillEvalsDir({ repoRoot: bare, env: {}, homeDir: home }), { dir: join(home, ".buzzassist", "learning", "evals"), source: "home" });
    assert.deepEqual(resolveSkillEvalsDir({ repoRoot: bare, env: { BUZZASSIST_LEARNING_DIR: join(bare, "learn") }, homeDir: home }), { dir: join(bare, "learn", "evals"), source: "env" });
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test("子の環境と記録の文から、鍵と端末のパスを落とす", () => {
  const env = { PATH: "p", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", FISH_AUDIO_API_KEY: "f", LOVART_SECRET_KEY: "l", HOME: "h" };
  const claude = childEnvironmentFor("claude", env);
  assert.equal(claude.ANTHROPIC_API_KEY, "a");
  assert.equal(claude.OPENAI_API_KEY, undefined);
  assert.equal(claude.FISH_AUDIO_API_KEY, undefined);
  assert.equal(claude.LOVART_SECRET_KEY, undefined);
  assert.equal(claude.BUZZASSIST_LEARNING_WRITE_FORBIDDEN, "child-agent");
  const codex = childEnvironmentFor("codex", env);
  assert.equal(codex.OPENAI_API_KEY, "o");
  assert.equal(codex.ANTHROPIC_API_KEY, undefined);

  const home = join(tmpdir(), "skill-evals-home-example");
  const sandbox = join(tmpdir(), "buzzassist-skill-evals-x", "job-0000", "sandbox");
  const text = sanitizeRecordText(`${join(sandbox, ".agents", "skills", "a", "SKILL.md")} と ${join(home, "secret.txt")} と sk-abcdefghijklmnopqrstuvwxyz`, { roots: [{ dir: sandbox, label: "<sandbox>" }], homeDir: home });
  assert.equal(text.includes(sandbox), false);
  assert.equal(text.includes(home), false);
  assert.equal(text.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
  assert.match(text, /<sandbox>/u);
});

test("Windows の .cmd へ渡す引数は cmd.exe のメタ文字を逃がす", () => {
  assert.equal(escapeCmdArgument("Read,Glob,Grep"), "^\"Read^,Glob^,Grep^\"");
  assert.equal(escapeCmdArgument(""), "^\"^\"");
  assert.equal(escapeCmdArgument("a b&c"), "^\"a^ b^&c^\"");
  const invocation = windowsCmdInvocation("C:\\bin\\claude.cmd", ["-p", "--tools", ""], "C:\\Windows\\System32\\cmd.exe");
  assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.equal(existsSync(fakeAgent), true);
});
