// 会話の圧縮のあとに、作業中の正本スキルを読み直すよう促す SessionStart フックの試験。
// プロジェクト・プラグインの置き場・会話の記録は、合成の一時フォルダにだけ作る（スキル名は架空）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildCompactReminder,
  readMapReferences,
  runCompactHookCli,
  usedReferences,
} from "../scripts/harness-compact-hook.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOOK = path.join(ROOT, "scripts", "harness-compact-hook.mjs");
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(ROOT, ...relative.split("/")), "utf8"));
const PROCESS_HANG_GUARD_MS = 120_000;

const MAP = [
  "# 地図",
  "制作の前に `.agents/skills/platform-craft/SKILL.md` と `.agents/skills/alpha-genre/SKILL.md` を最後まで読む。",
  "並列のときは `.agents/skills/beta-parallel/SKILL.md`。",
  "解説は `docs/example-guide-ja.md` を読む。",
].join("\n");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function stageRoot(root, { map = MAP, skills = ["platform-craft", "alpha-genre", "beta-parallel", "gamma-extra"] } = {}) {
  for (const id of skills) write(path.join(root, ".agents", "skills", id, "SKILL.md"), `# ${id}\n`);
  write(path.join(root, "docs", "example-guide-ja.md"), "# guide\n");
  if (map !== null) write(path.join(root, "CLAUDE.md"), map);
  return root;
}

function tempDir(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function transcriptLines(project, other) {
  return [
    // 地図の本文そのもの（システムの注入）。道が文中に出てくるだけなので数えない。
    { type: "user", message: { role: "user", content: `<system-reminder>${MAP}</system-reminder>` } },
    // Read の呼び出し（絶対の道）
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: path.join(project, ".agents", "skills", "alpha-genre", "SKILL.md") } }] } },
    // Skill の呼び出し（buzzassist の名前空間）
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "buzzassist:beta-parallel" } }] } },
    // 別の名前空間・端末全体の置き場の同名スキルは数えない
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "other-plugin:gamma-extra" } }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: path.join(other, ".agents", "skills", "gamma-extra", "SKILL.md") } }] } },
    // Codex の記録の形（引数が JSON の文字列）。シェルで読んだ docs も数える
    { type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "sed -n 1,200p docs/example-guide-ja.md"] }) } },
    // 道具の結果の本文に出てくるだけの道は数えない
    { type: "user", message: { content: [{ type: "tool_result", content: "see .agents/skills/gamma-extra/SKILL.md" }] } },
  ].map((line) => JSON.stringify(line)).join("\n");
}

test("記録の道具の呼び出しに出てきた BuzzAssist の正本だけを、出てきた順に挙げる", (t) => {
  const project = stageRoot(tempDir(t, "compact-project-"));
  const plugin = stageRoot(tempDir(t, "compact-plugin-"), { map: null });
  const other = tempDir(t, "compact-global-");
  write(path.join(other, ".agents", "skills", "gamma-extra", "SKILL.md"), "# not buzzassist\n");
  const response = buildCompactReminder(
    { hook_event_name: "SessionStart", source: "compact", cwd: project },
    { hookRoot: plugin, transcriptText: transcriptLines(project, other) },
  );
  assert.equal(response.mode, "used");
  assert.deepEqual(response.listed, [
    ".agents/skills/alpha-genre/SKILL.md",
    ".agents/skills/beta-parallel/SKILL.md",
    "docs/example-guide-ja.md",
  ]);
  const context = response.output.hookSpecificOutput.additionalContext;
  assert.equal(response.output.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(context, /圧縮/u);
  assert.match(context, /最後まで読み直して/u);
  assert.doesNotMatch(context, /gamma-extra/u, "別の置き場・別の名前空間の同名スキルを挙げた");
});

test("プロジェクトに正本が無ければ、プラグインの写しの道を挙げる", (t) => {
  const project = tempDir(t, "compact-operator-project-");
  const plugin = stageRoot(tempDir(t, "compact-plugin-"));
  const transcript = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "buzzassist:alpha-genre" } }] } });
  const response = buildCompactReminder(
    { hook_event_name: "SessionStart", source: "compact", cwd: project },
    { hookRoot: plugin, transcriptText: transcript },
  );
  assert.deepEqual(response.listed, [path.join(plugin, ".agents", "skills", "alpha-genre", "SKILL.md")]);
  // 地図の無いプロジェクトでは、名前空間の無い Skill の呼び出しは数えない（別のスキルかもしれない）。
  const bare = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "alpha-genre" } }] } });
  assert.equal(buildCompactReminder({ hook_event_name: "SessionStart", source: "compact", cwd: project }, { hookRoot: plugin, transcriptText: bare }), null);
});

test("記録が読めないときは、地図が正本を指すプロジェクトでだけ、地図の正本の読み直しを促す", (t) => {
  const project = stageRoot(tempDir(t, "compact-project-"));
  const plugin = stageRoot(tempDir(t, "compact-plugin-"), { map: null });
  const nested = path.join(project, "canvas", "work");
  fs.mkdirSync(nested, { recursive: true });
  const response = buildCompactReminder(
    { hook_event_name: "SessionStart", source: "compact", cwd: nested, transcript_path: path.join(project, "missing.jsonl") },
    { hookRoot: plugin },
  );
  assert.equal(response.mode, "map");
  assert.deepEqual(response.listed, ["platform-craft", "alpha-genre", "beta-parallel"]);
  assert.match(response.output.hookSpecificOutput.additionalContext, /CLAUDE\.md の地図/u);

  // BuzzAssist と関係の無いプロジェクト（地図が無く、記録にも正本が無い）では何も出さない。
  const unrelated = tempDir(t, "compact-unrelated-");
  assert.equal(buildCompactReminder({ hook_event_name: "SessionStart", source: "compact", cwd: unrelated }, { hookRoot: plugin, transcriptText: "" }), null);
});

test("compact 以外の SessionStart・ほかのイベント・子エージェント・壊れた入力には何も出さない", (t) => {
  const project = stageRoot(tempDir(t, "compact-project-"));
  for (const source of ["startup", "resume", "clear", ""]) {
    assert.equal(buildCompactReminder({ hook_event_name: "SessionStart", source, cwd: project }, { hookRoot: project, transcriptText: "" }), null, source);
  }
  assert.equal(buildCompactReminder({ hook_event_name: "UserPromptSubmit", source: "compact", cwd: project }, { hookRoot: project }), null);
  assert.equal(buildCompactReminder({ hook_event_name: "SessionStart", source: "compact", cwd: project, agent_id: "child" }, { hookRoot: project }), null);
  assert.equal(buildCompactReminder(null), null);
});

test("地図から正本の id と docs を出てくる順に取り出し、記録の行が壊れていても落ちない", () => {
  assert.deepEqual(readMapReferences(MAP), {
    skills: ["platform-craft", "alpha-genre", "beta-parallel"],
    docs: ["docs/example-guide-ja.md"],
  });
  const known = new Set(["alpha-genre"]);
  const broken = `{"type":"assistant","message":{"content":[{"type":"tool_use","input":{"file_path":".agents/skills/alpha-genre/SKILL.md"`;
  assert.deepEqual(usedReferences(broken, { knownSkills: known, projectRoot: "/p" }), { skills: [], docs: [] });
  const relative = JSON.stringify({ input: { command: "cat .agents/skills/alpha-genre/SKILL.md" } });
  assert.deepEqual(usedReferences(relative, { knownSkills: known, projectRoot: "/p" }).skills, ["alpha-genre"]);
  assert.deepEqual(usedReferences(relative, { knownSkills: known, projectRoot: "" }).skills, [], "地図の無いプロジェクトで相対の道を数えた");
});

test("実プロセス: このリポジトリで圧縮されたら、記録で読んだ正本を挙げる。壊れた入力では何も出さずに exit 0", (t) => {
  const dir = tempDir(t, "compact-transcript-");
  const transcript = path.join(dir, "session.jsonl");
  write(transcript, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: path.join(ROOT, ".agents", "skills", "platform-craft", "SKILL.md") } }] } })}\n`);
  const input = JSON.stringify({ hook_event_name: "SessionStart", source: "compact", cwd: ROOT, transcript_path: transcript });
  const result = spawnSync(process.execPath, [HOOK], { cwd: ROOT, input, encoding: "utf8", timeout: PROCESS_HANG_GUARD_MS });
  assert.equal(result.status, 0, result.stderr);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /\.agents\/skills\/platform-craft\/SKILL\.md/u);
  for (const bad of ["{not json", ""]) {
    const empty = spawnSync(process.execPath, [HOOK], { cwd: ROOT, input: bad, encoding: "utf8", timeout: PROCESS_HANG_GUARD_MS });
    assert.equal(empty.status, 0);
    assert.equal(empty.stdout, "");
  }
});

test("入力が閉じなくても、見張りの時計で exit 0 を呼び、何も出さない", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { PassThrough } = await import("node:stream");
  const stdin = new PassThrough();
  let out = "";
  const exits = [];
  const running = runCompactHookCli({
    stdin,
    stdout: { write: (chunk) => { out += chunk; return true; } },
    exit: (code) => { exits.push(code); },
  });
  stdin.write("{\"hook_event_name\":\"SessionStart\",");
  let virtualMs = 0;
  while (exits.length === 0 && virtualMs < 60_000) {
    t.mock.timers.tick(100);
    virtualMs += 100;
  }
  assert.deepEqual(exits, [0]);
  assert.ok(virtualMs <= 10_000, `会話を待たせすぎる（${virtualMs}ms）`);
  stdin.end();
  assert.equal(await running, 0);
  assert.equal(out, "");
});

test("両ホストのフック定義: SessionStart は compact にだけ当て、起動行はシェルに依らず動く", (t) => {
  const claude = readJson("hooks/claude-hooks.json").hooks.SessionStart;
  const codex = readJson("hooks/codex-hooks.json").hooks.SessionStart;
  assert.equal(claude.length, 1);
  assert.equal(claude[0].matcher, "compact");
  assert.equal(codex.length, 1);
  assert.match("compact", new RegExp(codex[0].matcher, "u"));
  for (const source of ["startup", "resume", "clear"]) assert.doesNotMatch(source, new RegExp(codex[0].matcher, "u"));

  const dir = tempDir(t, "compact-transcript-");
  const transcript = path.join(dir, "session.jsonl");
  write(transcript, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "buzzassist:platform-craft" } }] } })}\n`);
  const input = JSON.stringify({ hook_event_name: "SessionStart", source: "compact", cwd: ROOT, transcript_path: transcript });
  const claudeCommand = claude[0].hooks[0].command.replaceAll("${CLAUDE_PLUGIN_ROOT}", ROOT);
  for (const [label, command, extraEnv] of [["claude", claudeCommand, {}], ["codex", codex[0].hooks[0].command, { PLUGIN_ROOT: ROOT }]]) {
    const result = spawnSync(command, { shell: true, cwd: os.tmpdir(), input, env: { ...process.env, ...extraEnv }, encoding: "utf8", timeout: PROCESS_HANG_GUARD_MS });
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /platform-craft/u, label);
  }
});
