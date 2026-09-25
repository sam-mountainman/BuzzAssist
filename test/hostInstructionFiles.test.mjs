import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  HOST_INSTRUCTION_OUTPUTS,
  HOST_INSTRUCTION_PROFILES,
  MANAGED_BLOCK_MARKER,
  antigravitySetupBlock,
  applyManagedBlock,
  generateHostInstructionFiles,
  readHostInstructionTemplate,
  renderHostInstructions,
} from "../lib/hostInstructionFiles.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = async (name) => (await readFile(join(root, name), "utf8")).replace(/\r\n/gu, "\n");

test("CLAUDE.md / AGENTS.md / GEMINI.md は、テンプレートから作ったものと一致する（手で直していない）", async () => {
  // 3つを手で保守していた頃、同じ規則の文面がホストごとにずれた。直すのはテンプレートだけにする。
  for (const file of await generateHostInstructionFiles(root)) {
    assert.equal(await read(file.fileName), file.content,
      `${file.fileName} がテンプレートとずれている。config/host-instructions.template.md を直して node scripts/generate-host-instructions.mjs を走らせること`);
  }
});

test("--check はずれを非0で知らせ、一致していれば0で終わる", () => {
  const result = spawnSync(process.execPath, [join(root, "scripts", "generate-host-instructions.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /一致/u);
});

test("CLAUDE.md と AGENTS.md の違いは、ホストの語が入った行だけ", async () => {
  const claude = (await read(HOST_INSTRUCTION_OUTPUTS.claude)).split("\n");
  const codex = (await read(HOST_INSTRUCTION_OUTPUTS.codex)).split("\n");
  assert.equal(claude.length, codex.length, "同じテンプレートから同じ行数で出る");
  const differing = claude
    .map((line, index) => ({ line: index + 1, claude: line, codex: codex[index] }))
    .filter((entry) => entry.claude !== entry.codex);
  assert.ok(differing.length > 0, "ホストの語は実際に差し込まれている");
  // 両ホストの語（HOST_INSTRUCTION_PROFILES の値）を取り除くと、残りは一字一句同じになること。
  const hostWords = [...Object.values(HOST_INSTRUCTION_PROFILES.claude), ...Object.values(HOST_INSTRUCTION_PROFILES.codex)]
    .flatMap((value) => String(value).split("\n"))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const stripHostWords = (line) => hostWords.reduce((text, value) => text.split(value).join(""), line);
  for (const entry of differing) {
    assert.equal(stripHostWords(entry.claude), stripHostWords(entry.codex), `${entry.line} 行目: ホストの語以外が違う`);
  }
  // 見出しと各ホストのセットアップ先。
  assert.equal(claude[0], "# Koya manga video — mandatory Claude route");
  assert.equal(codex[0], "# Koya manga video — mandatory Codex route");
});

test("3つのホストが同じ規則の段落を同じ文面で持つ（GEMINI.md の共通部分も含む）", async () => {
  const files = Object.fromEntries(await Promise.all(Object.values(HOST_INSTRUCTION_OUTPUTS).map(async (name) => [name, await read(name)])));
  const shared = [
    // 直接起動は拒否される内部 runner を「唯一の入口」と書いていた GEMINI.md を、上位の入口に揃えた。
    "The operator-facing top-level entrypoint is `node scripts/run-video-harness.mjs`",
    "benchmark-only migrations and must not be used for a new episode.",
    "the MP4-derived contact-sheet signoff is valid",
    "pass `--protagonist-speaker-id`",
    "# Raw script to finished video — shared route",
    "- `.agents/skills/harness-parallel-execution/SKILL.md`",
    "Claude Code と Codex のどちらから実行しても同じ結果になる。",
    "入口は `node scripts/harness-learn.mjs`。捕捉は何も書き換えず、統合は既定で",
  ];
  for (const [name, text] of Object.entries(files)) {
    for (const fragment of shared) assert.ok(text.includes(fragment), `${name} に共通の段落が無い: ${fragment}`);
  }
  // ホスト固有の部分は、そのホストにだけある。
  assert.match(files["GEMINI.md"], /Antigravity にはフックの仕組みが無い/u);
  assert.doesNotMatch(files["CLAUDE.md"], /Antigravity にはフックの仕組みが無い。\*\*/u);
  assert.match(files["CLAUDE.md"], /harness-external-call\.mjs record --host/u);
  assert.match(files["GEMINI.md"], /--caller-host antigravity/u);
  assert.doesNotMatch(files["GEMINI.md"], /setup-agents\.mjs --agent claude/u);
});

test("リポジトリで Antigravity の setup を走らせても GEMINI.md は変わらない（管理ブロックが setup と同じもの）", async () => {
  // 以前は GEMINI.md の全文が管理ブロックの中にあり、setup を --project-dir にこのリポジトリで
  // 走らせると、漫画・並列・自己改善の段落がセットアップ手順だけに置き換わっていた。
  const gemini = await read("GEMINI.md");
  assert.equal(applyManagedBlock(gemini, MANAGED_BLOCK_MARKER, antigravitySetupBlock()), gemini);
  assert.ok(gemini.startsWith("# Koya manga video"), "共通の規則は管理ブロックの外にある");
  assert.ok(gemini.trimEnd().endsWith(`<!-- ${MANAGED_BLOCK_MARKER}:END -->`));

  // 運営者のプロジェクト（空・既存の本文あり）へは、これまでどおりブロックだけを足す。
  const fresh = applyManagedBlock("", MANAGED_BLOCK_MARKER, antigravitySetupBlock());
  assert.ok(fresh.startsWith(`<!-- ${MANAGED_BLOCK_MARKER}:START -->\n# BuzzAssist Agent Setup`));
  const existing = applyManagedBlock("# 運営者の規則\n", MANAGED_BLOCK_MARKER, antigravitySetupBlock());
  assert.ok(existing.startsWith("# 運営者の規則\n\n<!-- BUZZASSIST:START -->"));
  assert.equal(applyManagedBlock(existing, MANAGED_BLOCK_MARKER, antigravitySetupBlock()), existing, "2回目は何も変えない");
});

test("setup は GEMINI.md の管理ブロックをテンプレートと同じ関数から書く（2つ目の文面を持たない）", async () => {
  const source = await read("scripts/setup-agents.mjs");
  assert.match(source, /antigravitySetupBlock\(\)/u);
  assert.doesNotMatch(source, /function antigravityRuleBlock/u, "setup に Antigravity の手順の写しを置かない");
});

test("テンプレートの書式の誤りは黙って通さない", async () => {
  assert.throws(() => renderHostInstructions("{{unknownWord}}\n", "claude"), /unknownWord/u);
  assert.throws(() => renderHostInstructions("{{#hosts claude}}\nx\n", "claude"), /閉じていない/u);
  assert.throws(() => renderHostInstructions("{{/hosts}}\n", "claude"), /対応する/u);
  assert.throws(() => renderHostInstructions("{{#hosts cursor}}\nx\n{{/hosts}}\n", "claude"), /未知のホスト/u);
  assert.throws(() => renderHostInstructions("x\n", "cursor"), /未知のホスト/u);
  const template = await readHostInstructionTemplate(root);
  assert.equal(renderHostInstructions("{{#hosts codex}}\nonly-codex\n{{/hosts}}\n{{hostName}}\n", "claude"), "Claude Code\n");
  assert.ok(template.includes("{{#hosts antigravity}}"));
});
