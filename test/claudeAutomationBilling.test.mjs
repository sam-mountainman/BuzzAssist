import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  claudeAutomationBillingNotice,
  claudeAutomationPlanLine,
  createClaudeLaunchNotifier,
  isClaudePrintInvocation,
} from "../lib/claudeAutomationBilling.mjs";
import { plannedClaudeLaunches, probeEngine, runAgentTasks } from "../scripts/harness-parallel-agents.mjs";
import { claudePrintJobs } from "../scripts/harness-parallel-run.mjs";

// 本物の claude / codex は起動しない。偽の実行ファイルか、空の PATH で確かめる。

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const posixOnly = process.platform === "win32" ? "Windows では shebang の偽 CLI を直接起動できない（文面と回数の判定は全 OS で見る）" : false;

function capture() {
  let text = "";
  let writes = 0;
  return { write: (chunk) => { text += chunk; writes += 1; return true; }, get text() { return text; }, get writes() { return writes; } };
}

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("注意の文面は、何の枠から引かれるか・いつの公式案内か・多く並べるとどうなるかを書く", () => {
  const text = claudeAutomationBillingNotice({ plannedLaunches: 7, purpose: "試験", alternative: "codex で足りるなら --engine codex" });
  for (const phrase of ["[利用枠の注意]", "claude -p", "対話の Claude Code と同じ契約の利用枠", "2026-10-07 時点の公式案内", "別課金への切り替えは止められ",
    "短い時間で使い切り", "support.claude.com", "見込み 7 回", "--engine codex"]) {
    assert.ok(text.includes(phrase), `注意に「${phrase}」が無い: ${text}`);
  }
  // 2026-09-27 に配った「6/15 から別の月額クレジット」は誤り（変更は止められた）。同じ文面に戻さない。
  for (const wrong of ["月額クレジットから引かれる", "サブスクリプションの利用枠ではなく", "繰り越しなし"]) {
    assert.ok(!text.includes(wrong), `止められた変更を事実として書いている: ${wrong}`);
  }
  assert.equal(claudeAutomationPlanLine(0), "", "起動しない計画には課金の行を出さない");
  assert.match(claudeAutomationPlanLine(12), /^claude -p の起動見込み: 12 回。.*同じ契約の利用枠/u);
});

test("注意は1回だけ出す（起動のたびには出さない）", () => {
  const sink = capture();
  const notifier = createClaudeLaunchNotifier({ write: sink.write });
  assert.equal(notifier.shown, false);
  assert.equal(notifier.notify({ plannedLaunches: 3 }), true);
  assert.equal(notifier.notify({ plannedLaunches: 3 }), false);
  assert.equal(notifier.notify(), false);
  assert.equal(sink.writes, 1);
  assert.equal(notifier.shown, true);
});

test("計画のジョブが claude を非対話で直接起動するかを見分ける", () => {
  assert.equal(isClaudePrintInvocation("claude", ["-p"]), true);
  assert.equal(isClaudePrintInvocation("/usr/local/bin/claude", ["--model", "x", "--print"]), true);
  assert.equal(isClaudePrintInvocation("C:\\Tools\\claude.cmd", ["-p"]), true);
  assert.equal(isClaudePrintInvocation("claude", ["plugin", "list"]), false, "対話でも -p でもない claude のサブコマンドは課金の起動ではない");
  assert.equal(isClaudePrintInvocation("codex", ["exec", "-p"]), false);
  assert.equal(isClaudePrintInvocation("node", ["claude", "-p"]), false);
  const plan = { jobs: [
    { id: "a", command: "claude", args: ["-p"] },
    { id: "b", command: "node", args: ["scripts/x.mjs"] },
    { id: "c", command: "claude", args: ["--print"] },
  ] };
  assert.deepEqual(claudePrintJobs(plan).map((job) => job.id), ["a", "c"]);
});

test("並列実行の起動見込み: auto は codex が使えれば 0 回、claude 指定はプローブ 1 + タスク数", () => {
  assert.deepEqual(plannedClaudeLaunches({ engine: "codex", taskCount: 4 }), { min: 0, max: 0, label: "0 回" });
  assert.equal(plannedClaudeLaunches({ engine: "claude", taskCount: 4 }).label, "5 回（プローブ 1 + タスク 4）");
  const auto = plannedClaudeLaunches({ engine: "auto", taskCount: 4 });
  assert.equal(auto.min, 0);
  assert.equal(auto.max, 5);
  assert.match(auto.label, /codex が使えれば 0 回/u);
});

test("harness-parallel-agents --dry-run はエンジンを1つも起動せず、claude の起動見込みと課金の行を出す", (t) => {
  const dir = tempDir(t, "parallel-agents-dry-run-");
  const emptyPath = join(dir, "empty-path");
  mkdirSync(emptyPath);
  const tasks = join(dir, "tasks.json");
  writeFileSync(tasks, JSON.stringify({ tasks: [{ id: "t1", prompt: "x" }, { id: "t2", prompt: "y" }] }));
  const run = (engine) => spawnSync(process.execPath, [join(repoRoot, "scripts", "harness-parallel-agents.mjs"), "--tasks", tasks, "--dry-run", "--engine", engine], {
    encoding: "utf8",
    env: { PATH: emptyPath, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
  });
  const auto = run("auto");
  assert.equal(auto.status, 0, auto.stderr);
  assert.match(auto.stdout, /エンジンを起動しません/u);
  assert.match(auto.stdout, /claude -p の起動見込み: codex が使えれば 0 回、使えなければ 3 回（プローブ 1 \+ タスク 2）/u);
  assert.match(auto.stdout, /同じ契約の利用枠/u);
  assert.doesNotMatch(auto.stderr, /\[利用枠の注意\]/u, "dry-run で起動前の注意を出した（起動していないのに）");
  const codex = run("codex");
  assert.equal(codex.status, 0, codex.stderr);
  assert.match(codex.stdout, /claude -p の起動見込み: 0 回/u);
  assert.doesNotMatch(codex.stdout, /同じ契約の利用枠/u);
  const claude = run("claude");
  assert.match(claude.stdout, /claude -p の起動見込み: 3 回（プローブ 1 \+ タスク 2）/u);
});

test("claude のプローブは、起動する前に注意を1回だけ出す", { skip: posixOnly }, async (t) => {
  const dir = tempDir(t, "parallel-agents-claude-notice-");
  const log = join(dir, "spawned.log");
  const fake = join(dir, "claude");
  writeFileSync(fake, [
    "#!/usr/bin/env node",
    `require("node:fs").appendFileSync(${JSON.stringify(log)}, "spawned\\n");`,
    "process.stdin.resume();",
    "process.stdin.on('end', () => process.stdout.write('PROBE-OK'));",
  ].join("\n"));
  chmodSync(fake, 0o755);
  const seen = [];
  const probe = await probeEngine("claude", {
    env: { PATH: `${dir}:${process.env.PATH || ""}` },
    notifyClaudeLaunch: (notice) => { seen.push({ notice, spawnedBefore: existsSync(log) }); return true; },
  });
  assert.equal(probe.available, true, probe.reason);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].spawnedBefore, false, "claude を起動してから注意を出した");
  assert.equal(readFileSync(log, "utf8").trim(), "spawned");
});

test("claude でタスクを流すと注意は1回、codex では出さない。起動した回数を summary に残す", { skip: posixOnly }, async (t) => {
  const dir = tempDir(t, "parallel-agents-claude-runs-");
  const fake = join(dir, "fake-agent");
  writeFileSync(fake, [
    "#!/usr/bin/env node",
    "process.stdin.resume();",
    "process.stdin.on('end', () => process.stdout.write('done'));",
  ].join("\n"));
  chmodSync(fake, 0o755);
  const tasks = [{ id: "t1", prompt: "x" }, { id: "t2", prompt: "y" }];
  const sink = capture();
  const summary = await runAgentTasks(tasks, {
    engineInfo: { engineId: "claude", binary: fake },
    notifyClaudeLaunch: createClaudeLaunchNotifier({ write: sink.write }).notify,
    outDir: join(dir, "claude-out"),
    concurrency: 2,
    timeoutMs: 20_000,
  });
  assert.equal(summary.counts.completed, 2);
  assert.equal(sink.writes, 1, "タスクごとに注意を出した");
  assert.equal(summary.claudePrintLaunches, 2);

  let codexNotices = 0;
  const codexSummary = await runAgentTasks(tasks, {
    engineInfo: { engineId: "codex", binary: fake },
    notifyClaudeLaunch: () => { codexNotices += 1; return true; },
    outDir: join(dir, "codex-out"),
    concurrency: 2,
    timeoutMs: 20_000,
  });
  assert.equal(codexNotices, 0, "codex で流すのに claude の注意を出した");
  assert.equal(codexSummary.claudePrintLaunches, 0);
});

test("harness-parallel-run --dry-run は claude -p を直接起動するジョブの回数を出す", (t) => {
  const dir = tempDir(t, "parallel-run-claude-dry-");
  const plan = join(dir, "plan.json");
  writeFileSync(plan, JSON.stringify({
    planId: "billing-dry-run",
    jobs: [
      { id: "review-a", command: "claude", args: ["-p", "--model", "example"] },
      { id: "render", command: "node", args: ["--version"] },
    ],
  }));
  const run = spawnSync(process.execPath, [join(repoRoot, "scripts", "harness-parallel-run.mjs"), "--plan", plan, "--dry-run"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /claude -p の起動見込み: 1 回（review-a）/u);
  assert.doesNotMatch(run.stderr, /\[利用枠の注意\]/u, "dry-run で起動前の注意を出した");
});
