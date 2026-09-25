// 汎用の画像スクリプト（scripts/generate-manga-script-images.mjs）は、公式経路と同じ置き場へ本編の画の計画と
// 台帳を書くが、契約 v54 の本編の画の品質ループを通らない。Koya の公式経路の対象のプロジェクトでは何も
// 書かないうちに止まり、公式の action を案内する。対象でないプロジェクトでは従来どおり引数の検査へ進む。
// 有料の生成は呼ばない（台本を渡さないので、止まらなかった場合も引数の検査で終わる）。値はすべて合成。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts", "generate-manga-script-images.mjs");

function run(projectDir, extra = []) {
  const env = { ...process.env };
  delete env.BUZZASSIST_CHANNEL_PACK;
  return spawnSync(process.execPath, [script, "--project-dir", projectDir, ...extra], { cwd: projectDir, env, encoding: "utf8" });
}

test("Koya の公式経路の対象のプロジェクトでは、汎用の画像スクリプトが何も書かずに止まり images を案内する", async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), "manga-images-governed-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await mkdir(join(projectDir, "channel-packs", "synthetic-pack", "config"), { recursive: true });
  await writeFile(join(projectDir, "channel-packs", "synthetic-pack", "config", "koya-show-bible.json"), "{}\n");
  const scriptPath = join(projectDir, "script.txt");
  await writeFile(scriptPath, "合成の話者：合成の台詞。\n");

  const blocked = run(projectDir, ["--script-path", scriptPath, "--episode-id", "synthetic-ep"]);
  assert.equal(blocked.status, 2, blocked.stderr);
  assert.match(blocked.stderr, /公式経路の対象/u);
  assert.match(blocked.stderr, /run_koya_manga_pipeline の action "images"/u);
  assert.match(blocked.stderr, /--benchmark-migration/u);
  assert.equal(existsSync(join(projectDir, "canvas")), false, "計画も台帳も書かない");

  // 過去成果物の再現と明言したときだけ、ルーティングを通って引数の検査へ進む（ここでは台本を渡さない）。
  const migrated = run(projectDir, ["--benchmark-migration"]);
  assert.notEqual(migrated.status, 0);
  assert.doesNotMatch(migrated.stderr, /公式経路の対象/u);
  assert.match(migrated.stderr, /--script-path is required/u);
});

test("Koya の公式経路の対象でないプロジェクトでは、汎用の画像スクリプトは従来どおり引数の検査へ進む", async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), "manga-images-generic-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const result = run(projectDir);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /公式経路の対象/u);
  assert.match(result.stderr, /--script-path is required/u);
  const help = run(projectDir, ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--benchmark-migration/u);
});
