import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("Claude Code reaches the canonical skill through its adapter and Codex reads the canonical skill directly", async () => {
  // Claude Code は .agents/skills を読まないので .claude/skills のアダプターから正本へ届く。
  const production = await read(".claude/skills/manga-video-production/SKILL.md");
  const camera = await read(".claude/skills/manga-page-camera/SKILL.md");
  assert.match(production, /\.agents\/skills\/manga-video-production\/SKILL\.md/u);
  assert.match(camera, /\.agents\/skills\/manga-page-camera\/SKILL\.md/u);
  // Codex はリポジトリの .agents/skills を直接読む。.codex/skills のアダプターは同じ Skill を一覧に
  // 2回出すだけなので外した（2026-09-26）。正本の frontmatter の名前が Codex の一覧に出る名前になる。
  for (const name of ["manga-video-production", "manga-page-camera"]) {
    const canonical = await read(`.agents/skills/${name}/SKILL.md`);
    assert.match(canonical, new RegExp(`^---\\nname: ${name}\\n`, "u"));
    assert.equal(existsSync(resolve(root, ".codex", "skills", name, "SKILL.md")), false, `.codex/skills/${name} を戻さない`);
  }
});

test("project instructions force both hosts onto the official fail-closed route", async () => {
  for (const file of ["AGENTS.md", "CLAUDE.md"]) {
    const source = await read(file);
    assert.match(source, /operator-facing top-level entrypoint is `node scripts\/run-video-harness\.mjs`/u);
    assert.match(source, /scripts\/koya-manga-video\.mjs/u);
    assert.match(source, /knownRemainingIssues/u);
    assert.match(source, /contact-sheet/u);
    assert.match(source, /protagonist-speaker-id/u);
  }
});

test("canonical skill evals cover production, repair, and resumability", async () => {
  const production = JSON.parse(await read(".agents/skills/manga-video-production/evals/evals.json"));
  const camera = JSON.parse(await read(".agents/skills/manga-page-camera/evals/evals.json"));
  assert.ok(production.evals.length >= 3);
  assert.ok(camera.evals.length >= 2);
  const canonical = await read(".agents/skills/manga-video-production/SKILL.md");
  assert.match(canonical, /運営者が新規作品を作る入口[^\n]*上位Video Harness/u);
  assert.match(canonical, /run-video-harness\.mjs start/u);
  assert.match(canonical, /--harness koya-manga-video/u);
  assert.match(canonical, /署名済みChannel Pack/u);
  assert.match(canonical, /唯一の内部Koya runner/u);
  assert.match(canonical, /新作を直接`plan\/full`で開始[\s\S]{0,160}迂回してはならない/u);
  assert.match(canonical, /koya-manga-video\.mjs/u);
  assert.match(canonical, /知覚レビュー/u);
  assert.match(canonical, /主人公の承認済みVoice ID\/Profile\/設定\/モデルと完全一致/u);
  assert.doesNotMatch(canonical, /generate-manga-v22-dialogue-audio\.mjs/u);
});

test("canonical skills and the Claude Code adapters are written in Japanese", async () => {
  for (const path of [
    ".agents/skills/manga-video-production/SKILL.md",
    ".agents/skills/manga-page-camera/SKILL.md",
    ".claude/skills/manga-video-production/SKILL.md",
    ".claude/skills/manga-page-camera/SKILL.md",
  ]) {
    const source = await read(path);
    assert.match(source, /[ぁ-んァ-ヶ一-龠]/u, `${path} must contain Japanese guidance`);
  }
});

test("canonical production skill generalizes session regressions for new scripts", async () => {
  const quality = await read(".agents/skills/manga-video-production/references/quality-contract-ja.md");
  for (const phrase of ["疑似文字", "小道具", "一つの承認画像で複数発話", "孤立tail burst", "旧座標は流用しない"]) {
    assert.match(quality, new RegExp(phrase, "u"));
  }
});
