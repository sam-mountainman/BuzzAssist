// スキルの棚卸し（lib/skillUsage.mjs・scripts/skill-usage.mjs）の試験。
// 会話の記録は一時フォルダーに偽物を作る。端末の ~/.claude・~/.codex は読まない。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SKILL_REVIEW_INTERVAL_DAYS,
  attributeSkillMdPath,
  attributeSkillName,
  buildSkillReviewSheet,
  buildSkillUsageReport,
  decodeJsStringEscapes,
  detectRipgrep,
  extractSkillMdPaths,
  lastSkillReview,
  loadSkillUsageCatalog,
  readSkillReviews,
  recordSkillReview,
  renderSkillUsageReport,
  resolveUsageWindow,
  skillReviewAgeCheck,
  skillReviewLogPath,
} from "../lib/skillUsage.mjs";
import { parseSkillUsageArgs, runSkillUsageCli } from "../scripts/skill-usage.mjs";
import { runHarnessDoctor } from "../scripts/harness-doctor.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "scripts", "skill-usage.mjs");
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
const at = (daysAgo) => new Date(NOW.getTime() - daysAgo * DAY).toISOString();

const SESSION_A = "11111111-2222-4333-8444-555555555555";
const SESSION_B = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const CODEX_A = "01a0aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const CODEX_OLD = "01a0ffff-bbbb-7ccc-8ddd-eeeeeeeeeeee";

function tempRoot(t, prefix = "skill-usage-") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function skillMd(name, description) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

const CLASS_PROD = { installed: false, bundled: true, productionAllowed: true, developmentOnly: false };
const CLASS_DEV = { installed: false, bundled: true, productionAllowed: false, developmentOnly: true };

/** 架空の BuzzAssist チェックアウト（在庫 manifest・正本・アダプター・ハーネスの宣言）。 */
function stageRepo(root) {
  const repo = path.join(root, "repo");
  write(path.join(repo, ".agents", "skills", "inventory.manifest.json"), JSON.stringify({
    schemaVersion: 1,
    manifestVersion: "9.9.0",
    namespace: "buzzassist",
    skills: [
      {
        id: "buzzassist:alpha-craft",
        name: "alpha-craft",
        version: "1.0.0",
        canonicalPath: ".agents/skills/alpha-craft/SKILL.md",
        adapters: [{ host: "claude-code", path: ".claude/skills/alpha-craft/SKILL.md", name: "alpha-craft" }],
        classification: CLASS_PROD,
      },
      {
        id: "buzzassist:skill-creator",
        name: "skill-creator",
        version: "2.0.0",
        canonicalPath: ".agents/skills/skill-creator/SKILL.md",
        adapters: [
          { host: "claude-code", path: ".claude/skills/buzzassist-skill-creator/SKILL.md", name: "buzzassist-skill-creator" },
          { host: "shared", path: ".agents/skills/buzzassist-skill-creator/SKILL.md", name: "buzzassist-skill-creator" },
        ],
        classification: CLASS_DEV,
      },
      {
        id: "buzzassist:gamma-tool",
        name: "gamma-tool",
        version: "0.3.0",
        canonicalPath: "skills/gamma-tool/SKILL.md",
        adapters: [],
        classification: CLASS_PROD,
      },
      {
        id: "buzzassist:delta-idle",
        name: "delta-idle",
        version: "0.1.0",
        canonicalPath: ".agents/skills/delta-idle/SKILL.md",
        adapters: [],
        classification: CLASS_PROD,
      },
    ],
    plugins: [],
  }, null, 2));
  write(path.join(repo, ".agents", "skills", "profiles.manifest.json"), JSON.stringify({
    schemaVersion: 1,
    profiles: [{ id: "operator-production", alwaysAllowedSkills: ["buzzassist:alpha-craft"], eligibleDeclaredSkills: ["buzzassist:gamma-tool"] }],
  }));
  write(path.join(repo, ".agents", "skills", "alpha-craft", "SKILL.md"), skillMd("alpha-craft", "架空の共通技法の正本。"));
  write(path.join(repo, ".claude", "skills", "alpha-craft", "SKILL.md"), skillMd("alpha-craft", "アダプター"));
  write(path.join(repo, ".agents", "skills", "skill-creator", "SKILL.md"), skillMd("skill-creator", "架空のスキル管理の正本。"));
  write(path.join(repo, ".agents", "skills", "buzzassist-skill-creator", "SKILL.md"), skillMd("buzzassist-skill-creator", "アダプター"));
  write(path.join(repo, ".claude", "skills", "buzzassist-skill-creator", "SKILL.md"), skillMd("buzzassist-skill-creator", "アダプター"));
  write(path.join(repo, "skills", "gamma-tool", "SKILL.md"), skillMd("gamma-tool", "架空のキャンバスの道具。"));
  write(path.join(repo, ".agents", "skills", "delta-idle", "SKILL.md"), skillMd("delta-idle", "架空の使われていないスキル。"));
  write(path.join(repo, ".agents", "skills", "omega-extra", "SKILL.md"), skillMd("omega-extra", "在庫に載せ忘れた架空のスキル。"));
  write(path.join(repo, "config", "harnesses", "demo-video.harness.json"), JSON.stringify({
    id: "demo-video",
    canonicalSkills: [".agents/skills/alpha-craft/SKILL.md"],
  }));
  return repo;
}

function toolUse({ id, name, input, ts, sessionId, cwd, sidechain = false }) {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: sidechain,
    type: "assistant",
    uuid: `u-${id}`,
    timestamp: ts,
    sessionId,
    cwd,
    message: { role: "assistant", type: "message", content: [{ type: "tool_use", id, name, input }] },
  });
}

function userText({ uuid, text, ts, sessionId }) {
  return JSON.stringify({ type: "user", uuid, timestamp: ts, sessionId, message: { role: "user", content: text } });
}

function codexLine(ts, type, payload) {
  return JSON.stringify({ timestamp: ts, type, payload });
}

/** 偽の端末（~/.claude/projects と ~/.codex）。 */
function stageHome(root, repo) {
  const home = path.join(root, "home");
  const projects = path.join(home, ".claude", "projects");
  const claudeMain = path.join(projects, "-work-demo", `${SESSION_A}.jsonl`);
  const read = (file) => ({ file_path: file });
  write(claudeMain, [
    // 道具の定義とスキルの一覧（使ったことではない）
    JSON.stringify({
      type: "attachment",
      timestamp: at(2),
      sessionId: SESSION_A,
      attachment: {
        type: "prompt_snapshot",
        tools: [{ name: "Skill", description: "Invoke a skill" }],
        skills: `alpha-craft: ${path.join(repo, ".agents", "skills", "alpha-craft", "SKILL.md")}`,
      },
    }),
    toolUse({ id: "toolu_1", name: "Skill", input: { skill: "alpha-craft" }, ts: at(2), sessionId: SESSION_A, cwd: repo }),
    toolUse({ id: "toolu_2", name: "Read", input: read(path.join(repo, ".agents", "skills", "alpha-craft", "SKILL.md")), ts: at(2), sessionId: SESSION_A, cwd: repo }),
    // 素の skill-creator は端末全体の汎用スキルとぶつかるので数えない
    toolUse({ id: "toolu_3", name: "Skill", input: { skill: "skill-creator" }, ts: at(2), sessionId: SESSION_A, cwd: repo }),
    toolUse({ id: "toolu_4", name: "Skill", input: { skill: "buzzassist:skill-creator" }, ts: at(2), sessionId: SESSION_A, cwd: repo }),
    // 端末全体の置き場の同名スキル（数えない）
    toolUse({ id: "toolu_5", name: "Read", input: read(path.join(home, ".agents", "skills", "skill-creator", "SKILL.md")), ts: at(2), sessionId: SESSION_A, cwd: repo }),
    // BuzzAssist のチェックアウトの中だと確かめられる（数える）
    toolUse({ id: "toolu_6", name: "Read", input: read(path.join(repo, ".agents", "skills", "skill-creator", "SKILL.md")), ts: at(2), sessionId: SESSION_A, cwd: repo }),
    // 確かめられない（帰属できなかったものとして件数だけ）
    toolUse({ id: "toolu_7", name: "Read", input: read(path.join(root, "elsewhere", ".agents", "skills", "skill-creator", "SKILL.md")), ts: at(2), sessionId: SESSION_A, cwd: repo }),
    userText({ uuid: "u-slash-1", text: "<command-message>gamma-tool</command-message>\n<command-name>/buzzassist:gamma-tool</command-name>", ts: at(3), sessionId: SESSION_A }),
    userText({ uuid: "u-slash-2", text: "<command-name>/loop</command-name>", ts: at(3), sessionId: SESSION_A }),
    // 書き換えは数えない
    toolUse({ id: "toolu_8", name: "Edit", input: { file_path: path.join(repo, ".agents", "skills", "alpha-craft", "SKILL.md"), old_string: "a", new_string: "b" }, ts: at(2), sessionId: SESSION_A, cwd: repo }),
    // 期間の外
    toolUse({ id: "toolu_9", name: "Skill", input: { skill: "alpha-craft" }, ts: at(60), sessionId: SESSION_A, cwd: repo }),
    // 在庫に無い buzzassist: の名前
    toolUse({ id: "toolu_10", name: "Skill", input: { skill: "buzzassist:retired-thing" }, ts: at(2), sessionId: SESSION_A, cwd: repo }),
    // 相対パスの読み込み（会話の cwd で解決する）
    toolUse({ id: "toolu_11", name: "Bash", input: { command: "cat .agents/skills/alpha-craft/SKILL.md | head -5" }, ts: at(1), sessionId: SESSION_A, cwd: repo }),
    // 何度にも分けて届く長い行（rg の出力・逐次読みの継ぎ目をまたぐ）
    toolUse({ id: "toolu_16", name: "Bash", input: { command: `cat .agents/skills/alpha-craft/SKILL.md # ${"長".repeat(120_000)}` }, ts: at(1), sessionId: SESSION_A, cwd: repo }),
    // リダイレクトの書き込み先は読んだことにしない
    toolUse({ id: "toolu_15", name: "Bash", input: { command: `echo x > ${path.join(repo, ".agents", "skills", "delta-idle", "SKILL.md")}` }, ts: at(1), sessionId: SESSION_A, cwd: repo }),
    // 絞り込みには当たるが JSON として読めない行（書きかけ）。数えずに件数だけ出す
    '{"type":"tool_use","name":"Read","input":{"file_path":".agents/skills/alpha-craft/SKILL.md"',
    // 目印の語が無い行は JSON として読みもしない
    "{壊れた行",
  ].join("\n") + "\n");
  // 子エージェントの記録（同じ会話）
  write(path.join(projects, "-work-demo", SESSION_A, "subagents", "agent-a1.jsonl"), [
    toolUse({ id: "toolu_12", name: "Skill", input: { skill: "alpha-craft" }, ts: at(1), sessionId: SESSION_A, cwd: repo, sidechain: true }),
  ].join("\n") + "\n");
  // 別の会話。toolu_1 の写しは重複として数えない
  write(path.join(projects, "-work-other", `${SESSION_B}.jsonl`), [
    toolUse({ id: "toolu_1", name: "Skill", input: { skill: "alpha-craft" }, ts: at(2), sessionId: SESSION_B, cwd: repo }),
    toolUse({ id: "toolu_13", name: "Grep", input: { pattern: "x", path: path.join(home, ".claude", "plugins", "cache", "buzzassist", "buzzassist", "9.9.0", "skills", "gamma-tool", "SKILL.md") }, ts: at(4), sessionId: SESSION_B, cwd: repo }),
    // 別の plugin の同名スキル（数えない）
    toolUse({ id: "toolu_14", name: "Read", input: read(path.join(home, ".claude", "plugins", "cache", "other-market", "other", "1.0.0", "skills", "gamma-tool", "SKILL.md")), ts: at(4), sessionId: SESSION_B, cwd: repo }),
  ].join("\n") + "\n");

  const codexHome = path.join(home, ".codex");
  const codexFile = path.join(codexHome, "sessions", "2026", "09", "20", `rollout-2026-09-20T10-00-00-${CODEX_A}.jsonl`);
  const listing = `<skills_instructions>alpha-craft: ${path.join(repo, ".agents", "skills", "alpha-craft", "SKILL.md")}</skills_instructions>`;
  write(codexFile, [
    codexLine(at(1), "session_meta", { id: CODEX_A, cwd: repo, base_instructions: { text: listing } }),
    codexLine(at(1), "response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: listing }] }),
    codexLine(at(1), "response_item", {
      type: "custom_tool_call",
      status: "completed",
      call_id: "call_c1",
      name: "exec",
      input: `const r = await tools.exec_command(${JSON.stringify({ cmd: "sed -n '1,200p' .agents/skills/alpha-craft/SKILL.md\nrg -n x lib", workdir: repo })}); text(r.output);`,
    }),
    codexLine(at(1), "response_item", {
      type: "function_call",
      call_id: "call_c2",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: `cat ${path.join(repo, "skills", "gamma-tool", "SKILL.md")}`, workdir: repo }),
    }),
    // 子への伝言の中の SKILL.md（読んだことではない）
    codexLine(at(1), "response_item", {
      type: "custom_tool_call",
      call_id: "call_c4",
      name: "send_message",
      input: "まず .agents/skills/alpha-craft/SKILL.md を読むこと",
    }),
    // apply_patch（書き換え）
    codexLine(at(1), "response_item", {
      type: "custom_tool_call",
      call_id: "call_c5",
      name: "exec",
      input: `text(await tools.apply_patch(${JSON.stringify("*** Begin Patch\n*** Update File: .agents/skills/delta-idle/SKILL.md\n@@\n-a\n+b\n*** End Patch")}))`,
    }),
    codexLine(at(1), "response_item", {
      type: "local_shell_call",
      call_id: "call_c3",
      action: { type: "exec", command: ["bash", "-lc", "cat .agents/skills/buzzassist-skill-creator/SKILL.md"], working_directory: repo },
    }),
  ].join("\n") + "\n");
  // 期間より前に最後に書かれた記録（更新日時で外れる）
  const old = path.join(codexHome, "archived_sessions", `rollout-2026-06-01T10-00-00-${CODEX_OLD}.jsonl`);
  write(old, codexLine(at(90), "response_item", {
    type: "function_call",
    call_id: "call_old",
    name: "exec_command",
    arguments: JSON.stringify({ cmd: "cat .agents/skills/alpha-craft/SKILL.md", workdir: repo }),
  }) + "\n");
  const oldTime = new Date(NOW.getTime() - 90 * DAY);
  fs.utimesSync(old, oldTime, oldTime);
  return { home, codexHome, projects };
}

function stage(t) {
  const root = tempRoot(t);
  const repo = stageRepo(root);
  const { home, codexHome, projects } = stageHome(root, repo);
  const learningDir = path.join(root, "learning");
  const env = { BUZZASSIST_LEARNING_DIR: learningDir, PATH: process.env.PATH || "" };
  const roots = { claude: [projects], codex: [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")] };
  return { root, repo, home, codexHome, projects, learningDir, env, roots };
}

function byId(report) {
  return Object.fromEntries(report.skills.map((skill) => [skill.id, skill]));
}

async function reportWith(fixture, options = {}) {
  return buildSkillUsageReport({
    repoRoot: fixture.repo,
    env: fixture.env,
    homeDir: fixture.home,
    roots: fixture.roots,
    now: NOW,
    window: resolveUsageWindow({ now: NOW }),
    // 数えた結果を比べる試験は、混んだ機械や一時停止で時間の上限に当たらないように広く取る
    // （時間の上限そのものは上限の試験で 0 秒を渡して確かめる）
    maxSeconds: 3600,
    ...options,
  });
}

test("目録: 在庫のスキルと、在庫に無い .agents/skills の中身を並べ、素の名前がぶつかるものは素の名前で数えない", (t) => {
  const { repo } = stage(t);
  const catalog = loadSkillUsageCatalog({ repoRoot: repo });
  assert.deepEqual(catalog.skills.map((skill) => skill.id), [
    "buzzassist:alpha-craft",
    "buzzassist:skill-creator",
    "buzzassist:gamma-tool",
    "buzzassist:delta-idle",
    "unlisted:omega-extra",
  ]);
  assert.equal(attributeSkillName(catalog, "alpha-craft"), "buzzassist:alpha-craft");
  assert.equal(attributeSkillName(catalog, "buzzassist:alpha-craft"), "buzzassist:alpha-craft");
  assert.equal(attributeSkillName(catalog, "skill-creator"), null, "汎用の skill-creator を BuzzAssist のものと数えた");
  assert.equal(attributeSkillName(catalog, "buzzassist:skill-creator"), "buzzassist:skill-creator");
  assert.equal(attributeSkillName(catalog, "buzzassist-skill-creator"), "buzzassist:skill-creator");
  assert.equal(attributeSkillName(catalog, "/buzzassist:gamma-tool"), "buzzassist:gamma-tool");
  const alpha = catalog.skills[0];
  assert.deepEqual(alpha.harnesses, ["demo-video"]);
  assert.deepEqual(alpha.profiles, [{ profile: "operator-production", placement: "always" }]);
  assert.equal(alpha.description, "架空の共通技法の正本。");
  assert.equal(catalog.skills[4].listedInManifest, false);
});

test("SKILL.md のパスの抜き出しと帰属: 書き換え・端末全体・他の plugin は数えない", (t) => {
  const { repo, home } = stage(t);
  const catalog = loadSkillUsageCatalog({ repoRoot: repo });
  assert.deepEqual(
    extractSkillMdPaths("cat .agents/skills/a/SKILL.md && echo x > /x/skills/b/SKILL.md; ls */SKILL.md *** Begin Patch\n*** Update File: y/skills/c/SKILL.md\n*** End Patch sed -n 1p ~/d/skills/e/SKILL.md"),
    [".agents/skills/a/SKILL.md", "*/SKILL.md", "~/d/skills/e/SKILL.md"],
  );
  assert.deepEqual(extractSkillMdPaths("x >> a/skills/b/SKILL.md; cat \"c/skills/d/SKILL.md\" foo/SKILL.md:12"), ["c/skills/d/SKILL.md", "foo/SKILL.md"]);
  // 区切りの無い長い塊（1行数MBの記録にある）の中の SKILL.md はパスとみなさない。区切りから始まるパスは長くても拾う
  assert.deepEqual(extractSkillMdPaths(`${"長".repeat(200_000)}/skills/x/SKILL.md cat .agents/skills/y/SKILL.md`), [".agents/skills/y/SKILL.md"]);
  assert.deepEqual(extractSkillMdPaths(` ${"a".repeat(4000)}/SKILL.md`), [`${"a".repeat(4000)}/SKILL.md`]);
  // JS の文字列の escape は1回だけ戻す（Windows のパスの \\n を改行と取り違えない）
  assert.equal(decodeJsStringEscapes(String.raw`cmd:"cat C:\\w\\narrated\\SKILL.md\nsed"`), String.raw`cmd:"cat C:\w\narrated\SKILL.md sed"`);
  const options = { cwd: repo, homeDir: home, isBuzzAssistRoot: (dir) => dir === repo };
  assert.deepEqual(attributeSkillMdPath(catalog, ".agents/skills/alpha-craft/SKILL.md", options), { skillId: "buzzassist:alpha-craft" });
  assert.deepEqual(attributeSkillMdPath(catalog, "C:\\work\\proj\\.agents\\skills\\alpha-craft\\SKILL.md", options), { skillId: "buzzassist:alpha-craft" });
  assert.equal(attributeSkillMdPath(catalog, path.join(home, ".claude", "skills", "alpha-craft", "SKILL.md"), options), null);
  assert.equal(attributeSkillMdPath(catalog, "~/.agents/skills/skill-creator/SKILL.md", options), null);
  assert.deepEqual(attributeSkillMdPath(catalog, path.join(home, "plugins", "buzzassist", "plugin", "skills", "skill-creator", "SKILL.md"), options), { skillId: "buzzassist:skill-creator" });
  assert.equal(attributeSkillMdPath(catalog, path.join(home, ".codex", "plugins", "cache", "someone", "x", "1.0.0", "skills", "alpha-craft", "SKILL.md"), options), null);
  assert.deepEqual(attributeSkillMdPath(catalog, "/somewhere/.agents/skills/skill-creator/SKILL.md", options), { ambiguous: true });
  assert.deepEqual(attributeSkillMdPath(catalog, ".agents/skills/skill-creator/SKILL.md", { ...options, cwd: "" }), { ambiguous: true });
  assert.equal(attributeSkillMdPath(catalog, ".agents/skills/unknown/SKILL.md", options), null);
  assert.equal(attributeSkillMdPath(catalog, ".agents/skills/alpha-craft/references/SKILL.md", options), null);
});

test("使われ方を数える: 使った形だけ、期間の中だけ、重複なし、ホストごと", async (t) => {
  const fixture = stage(t);
  const report = await reportWith(fixture, { scanner: "node" });
  const skills = byId(report);
  assert.equal(report.complete, true, JSON.stringify(report.coverage));

  const alpha = skills["buzzassist:alpha-craft"];
  assert.deepEqual(
    { ...alpha.hosts.claude, lastUsedAt: undefined },
    { sessions: 1, skillToolCalls: 2, slashCommands: 0, skillMdReads: 3, lastUsedAt: undefined },
  );
  assert.equal(alpha.hosts.codex.sessions, 1);
  assert.equal(alpha.hosts.codex.skillMdReads, 1);
  assert.equal(alpha.sessions, 2);
  assert.equal(alpha.lastUsedAt, at(1));

  const creator = skills["buzzassist:skill-creator"];
  assert.equal(creator.hosts.claude.skillToolCalls, 1);
  assert.equal(creator.hosts.claude.skillMdReads, 1);
  assert.equal(creator.hosts.codex.skillMdReads, 1, "アダプター（buzzassist-skill-creator）を読んだ分");

  const gamma = skills["buzzassist:gamma-tool"];
  assert.equal(gamma.hosts.claude.slashCommands, 1);
  assert.equal(gamma.hosts.claude.skillMdReads, 1, "BuzzAssist の plugin の写しを読んだ分だけ");
  assert.equal(gamma.hosts.claude.sessions, 2);
  assert.equal(gamma.hosts.codex.skillMdReads, 1);
  assert.equal(gamma.sessions, 3);

  assert.equal(skills["buzzassist:delta-idle"].sessions, 0, "書き換え・リダイレクトを読んだと数えた");
  assert.deepEqual(report.unusedInWindow, ["buzzassist:delta-idle", "unlisted:omega-extra"]);
  assert.deepEqual(report.skills.map((skill) => skill.id).slice(0, 3), ["buzzassist:gamma-tool", "buzzassist:alpha-craft", "buzzassist:skill-creator"]);
  assert.equal(report.unattributed.claude.ambiguousSkillMdReads, 1);
  assert.deepEqual(report.unattributed.unknownNamespacedSkillNames, [{ name: "buzzassist:retired-thing", count: 1 }]);
  assert.equal(report.unparsableLines.claude, 1);
  assert.equal(report.coverage.codex.filesOlderThanWindow, 1);
  assert.equal(report.coverage.codex.filesInWindow, 1);
  assert.equal(report.coverage.claude.filesInWindow, 3);

  // 本文を持ち出さない: 集計にパスや会話の文は入らない
  const text = JSON.stringify(report);
  assert.equal(text.includes(fixture.repo), false, "集計に端末のパスが入った");
  assert.equal(text.includes("読むこと"), false);
  const rendered = renderSkillUsageReport(report);
  assert.match(rendered, /buzzassist:alpha-craft/u);
  assert.match(rendered, /期間内に使われていない: buzzassist:delta-idle, unlisted:omega-extra/u);
  assert.match(rendered, /Codex: 数え切れた/u);
});

test("rg と Node の逐次読みで同じ数になる（rg が無ければ auto は Node を使う）", async (t) => {
  const fixture = stage(t);
  const viaNode = await reportWith(fixture, { scanner: "node" });
  const auto = await reportWith(fixture, { scanner: "auto" });
  if (!detectRipgrep()) {
    assert.equal(auto.coverage.claude.scanner, "node");
    assert.deepEqual(auto.skills, viaNode.skills);
    await assert.rejects(reportWith(fixture, { scanner: "ripgrep" }), /rg（ripgrep）が見つからない/u);
    return;
  }
  const viaRg = await reportWith(fixture, { scanner: "ripgrep" });
  assert.equal(viaRg.coverage.claude.scanner, "ripgrep");
  assert.equal(viaRg.complete, true, JSON.stringify(viaRg.coverage));
  assert.deepEqual(viaRg.skills, viaNode.skills);
  assert.deepEqual(viaRg.unattributed, viaNode.unattributed);
  assert.deepEqual(auto.skills, viaNode.skills);
});

test("上限に当たったら「数え切れていない」と言い、どこから先を数え切れているかを出す", async (t) => {
  const fixture = stage(t);
  const scanners = detectRipgrep() ? ["node", "ripgrep"] : ["node"];
  for (const scanner of scanners) {
    const bytes = await reportWith(fixture, { scanner, maxBytes: 1 });
    assert.equal(bytes.complete, false);
    assert.deepEqual(bytes.coverage.claude.reasons, ["bytes"]);
    assert.equal(bytes.coverage.claude.filesSkippedForBytes, 3);
    assert.ok(bytes.coverage.claude.fullyCountedSince, "数え切れている範囲が出ていない");
    assert.equal(byId(bytes)["buzzassist:alpha-craft"].sessions, 0);
    assert.match(renderSkillUsageReport(bytes), /数え切れていない（読む量の上限/u);

    // 時間の上限 0 秒: 1つも読まずに「時間の上限」と言う（速さは測らない）
    const time = await reportWith(fixture, { scanner, maxSeconds: 0 });
    assert.equal(time.complete, false);
    assert.ok(time.coverage.codex.reasons.includes("time"));
    assert.equal(time.coverage.codex.filesScanned, 0);

    // 長すぎる行は読まずに飛ばし、そのことを出す
    const longLine = await reportWith(fixture, { scanner, maxLineBytes: 200 });
    assert.equal(longLine.complete, false, `${scanner}: 長い行を黙って飛ばした`);
    assert.ok(longLine.coverage.claude.reasons.includes("long-line"));
    assert.ok(longLine.coverage.claude.longLinesSkipped > 0);
  }
});

test("判定シート: スキルごとに回数・最後に使った日・description・束ねるハーネスを並べ、外部モデルは呼ばない", async (t) => {
  const fixture = stage(t);
  const report = await reportWith(fixture, { scanner: "node" });
  const catalog = loadSkillUsageCatalog({ repoRoot: fixture.repo });
  const sheet = buildSkillReviewSheet({ report, catalog });
  assert.match(sheet.markdown, /### buzzassist:alpha-craft（1\.0\.0）/u);
  assert.match(sheet.markdown, /架空の共通技法の正本。/u);
  assert.match(sheet.markdown, /束ねるハーネス: demo-video/u);
  assert.match(sheet.markdown, /operator-production（常に許可）/u);
  assert.match(sheet.markdown, /### unlisted:omega-extra/u);
  assert.match(sheet.markdown, /別の新しい文脈/u);
  assert.match(sheet.markdown, /"verdict": "keep \| merge \| retire \| rewrite"/u);
  assert.match(sheet.markdown, /Codex: 数え切れた/u);
  assert.equal(sheet.json.skills.length, 5);
  assert.equal(sheet.json.skills.find((skill) => skill.id === "buzzassist:delta-idle").usage.sessions, 0);
  assert.equal(sheet.markdown.includes(fixture.repo), false, "シートに端末のパスが入った");
});

test("棚卸しの記録: 手元の置き場に日付だけを残し、doctor は30日以上で知らせる（記録が無ければ黙る）", (t) => {
  const fixture = stage(t);
  const catalog = loadSkillUsageCatalog({ repoRoot: fixture.repo });
  const options = { env: fixture.env, homeDir: fixture.home };
  assert.equal(skillReviewLogPath(options), path.join(fixture.learningDir, "skill-reviews.jsonl"));
  assert.equal(skillReviewAgeCheck({ ...options, now: NOW }), null, "記録が無いのに知らせた");

  const sheet = path.join(fixture.root, "sheet.md");
  fs.writeFileSync(sheet, "# シート\n");
  const old = recordSkillReview({ ...options, catalog, now: new Date(NOW.getTime() - (SKILL_REVIEW_INTERVAL_DAYS + 1) * DAY), note: "初回", sheetPath: sheet });
  assert.equal(old.path, skillReviewLogPath(options));
  assert.deepEqual(old.record.skills[0], { id: "buzzassist:alpha-craft", version: "1.0.0" });
  assert.equal(old.record.note, "初回");
  assert.match(old.record.sheetSha256, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(old.record).includes("# シート"), false, "シートの本文を残した");

  const stale = skillReviewAgeCheck({ ...options, now: NOW });
  assert.equal(stale.id, "skill-usage-review");
  assert.equal(stale.required, false);
  assert.equal(stale.ok, false);
  assert.equal(stale.daysSinceReview, SKILL_REVIEW_INTERVAL_DAYS + 1);
  assert.match(stale.fix, /record-review/u);

  fs.appendFileSync(skillReviewLogPath(options), "{壊れた行\n");
  recordSkillReview({ ...options, catalog, now: new Date(NOW.getTime() - 3 * DAY) });
  assert.equal(readSkillReviews(options).length, 2);
  assert.equal(lastSkillReview(options).reviewedAt, new Date(NOW.getTime() - 3 * DAY).toISOString());
  const fresh = skillReviewAgeCheck({ ...options, now: NOW });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.daysSinceReview, 3);
  assert.equal(fresh.fix, "");
});

function doctorRuntime(fixture, now) {
  const binary = (name) => ({ ok: true, path: `/stub/${name}`, version: "stub" });
  return {
    homeDir: fixture.home,
    now: () => now,
    env: { ...fixture.env, CODEX_HOME: fixture.codexHome },
    ffmpegToolchain: { ok: true, ffmpeg: binary("ffmpeg"), ffprobe: binary("ffprobe") },
    runCommand: async (_command, args = []) => {
      if (args.includes("-encoders")) return { stdout: "libx264 aac pcm_s24le", stderr: "" };
      if (args.includes("-filters")) return { stdout: "scale crop overlay fps loudnorm aresample", stderr: "" };
      if (args.includes("-show_streams")) return { stdout: JSON.stringify({ streams: [{ codec_type: "video" }, { codec_type: "audio" }] }), stderr: "" };
      return { stdout: "", stderr: "" };
    },
    pythonRuntime: { ok: true, command: "python", args: [], version: "3.12.2" },
    voiceQualityProbe: async () => true,
    diskFreeBytes: async () => 64 * 1024 ** 3,
    ttsProbe: async () => ({ ok: true, detail: "設定あり", fix: "" }),
    imageModel: "gpt-image-2-codex",
    imageHostProbe: async (model) => ({ ok: true, host: "codex", model, detail: `Codex / ${model}` }),
    // ブラウザーの起動を省く（この試験が見るのは棚卸しの項目だけ）
    svgRasterizerProbe: async () => ({ ok: true, backend: "chrome", detail: "fixture", fix: "" }),
  };
}

test("doctor: 棚卸しの記録が無ければ項目を出さず、30日以上前なら止めずに知らせる", async (t) => {
  const fixture = stage(t);
  const quiet = await runHarnessDoctor({ runtime: doctorRuntime(fixture, NOW) });
  assert.equal(quiet.checks.some((check) => check.id === "skill-usage-review"), false, "記録が無いのに項目を出した");

  const catalog = loadSkillUsageCatalog({ repoRoot: fixture.repo });
  recordSkillReview({ env: fixture.env, homeDir: fixture.home, catalog, now: new Date(NOW.getTime() - 45 * DAY) });
  const report = await runHarnessDoctor({ runtime: doctorRuntime(fixture, NOW) });
  const check = report.checks.find((entry) => entry.id === "skill-usage-review");
  assert.ok(check, "skill-usage-review の項目が無い");
  assert.equal(check.required, false);
  assert.equal(check.ok, false);
  assert.equal(check.daysSinceReview, 45);
  assert.ok(report.advisory.includes("skill-usage-review"));
  assert.equal(report.blocking.includes("skill-usage-review"), false, "棚卸しの遅れで本番を止めた");
});

test("CLI: 知らない引数は止め、--help は数えずに使い方だけを出す", (t) => {
  assert.throws(() => parseSkillUsageArgs(["report", "--dayz", "3"]), /未知の引数: --dayz/u);
  assert.throws(() => parseSkillUsageArgs(["tally"]), /未知のコマンド/u);
  assert.throws(() => parseSkillUsageArgs(["--days"]), /--days に値が要る/u);
  assert.deepEqual(parseSkillUsageArgs(["review-sheet", "--days", "90", "--json"]), { command: "review-sheet", json: true, help: false, days: "90" });

  const fixture = stage(t);
  const env = {
    PATH: process.env.PATH || "",
    HOME: fixture.home,
    USERPROFILE: fixture.home,
    CLAUDE_CONFIG_DIR: path.join(fixture.home, ".claude"),
    CODEX_HOME: fixture.codexHome,
    BUZZASSIST_LEARNING_DIR: fixture.learningDir,
  };
  const help = spawnSync(process.execPath, [CLI, "--help"], { env, encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage:/u);
  assert.match(help.stdout, /record-review/u);

  const recorded = spawnSync(process.execPath, [CLI, "record-review", "--project-dir", fixture.repo, "--json"], { env, encoding: "utf8" });
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.equal(JSON.parse(recorded.stdout).path, path.join(fixture.learningDir, "skill-reviews.jsonl"));
  assert.equal(readSkillReviews({ env, homeDir: fixture.home }).length, 1);
});

test("CLI: report と review-sheet は指定した置き場だけを読む", async (t) => {
  const fixture = stage(t);
  const env = { PATH: process.env.PATH || "", BUZZASSIST_LEARNING_DIR: fixture.learningDir };
  const out = [];
  const err = [];
  const io = { env, homeDir: fixture.home, now: NOW, stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) } };
  const common = ["--project-dir", fixture.repo, "--claude-config-dir", path.join(fixture.home, ".claude"), "--codex-home", fixture.codexHome, "--scanner", "node", "--max-seconds", "3600"];
  const report = await runSkillUsageCli(["report", ...common, "--json"], io);
  assert.equal(JSON.parse(out.join("")).skills.find((skill) => skill.id === "buzzassist:gamma-tool").sessions, 3);
  assert.equal(report.window.days, 30);

  out.length = 0;
  const onlyCodex = await runSkillUsageCli(["report", ...common, "--host", "codex", "--days", "7"], io);
  assert.deepEqual(onlyCodex.hosts, ["codex"]);
  assert.match(out.join(""), /Codex: 数え切れた/u);
  assert.equal(out.join("").includes("Claude Code:"), false);

  out.length = 0;
  const sheetPath = path.join(fixture.root, "out", "sheet.md");
  await runSkillUsageCli(["review-sheet", ...common, "--output", sheetPath], io);
  assert.match(fs.readFileSync(sheetPath, "utf8"), /### buzzassist:gamma-tool（0\.3\.0）/u);
  assert.match(err.join(""), /判定シートを書いた/u);
});
