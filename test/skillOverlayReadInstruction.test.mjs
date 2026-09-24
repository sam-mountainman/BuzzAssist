import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("learned-auto overlay を持つ正本スキルは、作業前にそれを読む指示を持つ", async () => {
  // 2026-09-24 の監査で、narrated-story-video と platform-craft は overlay を書かれ、
  // 配布もされていたのに、SKILL.md に読む指示が無かった。自己改善が積んだ教訓が
  // 誰にも読まれない状態で、sync が成功しても何も改善しない。
  const skillsRoot = join(root, ".agents", "skills");
  const withOverlay = [];
  for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const overlay = join(skillsRoot, entry.name, "references", "learned-auto.md");
    const skill = join(skillsRoot, entry.name, "SKILL.md");
    if (!existsSync(overlay) || !existsSync(skill)) continue;
    withOverlay.push(entry.name);
    const text = await readFile(skill, "utf8");
    assert.match(text, /作業前に `references\/learned-auto\.md` を読む/u, `${entry.name}: overlay を読む指示が無い`);
    assert.match(text, /矛盾したときはこの SKILL\.md が優先/u, `${entry.name}: 優先順位の指示が無い`);
    assert.match(text, /証跡には使えない/u, `${entry.name}: overlay を証跡に使わない旨が無い`);
  }
  assert.ok(withOverlay.length >= 6, `overlay を持つスキルが見つかること（${withOverlay.join(", ")}）`);
});
