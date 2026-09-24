import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("配布される指示ファイルに、メモリ系プラグインの自動生成ブロックが混ざっていない", async () => {
  // 2026-09-24、AGENTS.md の先頭に開発機のセッション履歴（時刻・ポート・作業題名）が
  // 自動で書き込まれたまま commit され、package.json の files 経由で運営者へ配られていた。
  // 機密ではないが、開発機の作業記録を配布物に載せる理由は無い。
  for (const name of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
    let text;
    try {
      text = await readFile(join(root, name), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    assert.doesNotMatch(text, /<[A-Za-z-]*mem-context>/iu, `${name} に自動生成の履歴ブロックがある`);
  }
});
