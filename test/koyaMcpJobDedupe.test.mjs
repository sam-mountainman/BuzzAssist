import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { koyaJobResourceKey, startKoyaMcpJob } from "../lib/koyaMcpAdapter.mjs";

test("資源キーは project + episode + action で決まる", () => {
  // これが無いと、同じエピソードの同じ工程を二度投げても区別できない。
  const base = { projectDir: "/tmp/p", action: "render", options: { episodeId: "e1" } };
  assert.equal(koyaJobResourceKey(base), koyaJobResourceKey({ ...base }));
  assert.notEqual(koyaJobResourceKey(base), koyaJobResourceKey({ ...base, action: "images" }));
  assert.notEqual(koyaJobResourceKey(base), koyaJobResourceKey({ ...base, options: { episodeId: "e2" } }));
  assert.notEqual(koyaJobResourceKey(base), koyaJobResourceKey({ ...base, projectDir: "/tmp/q" }));
  // エピソード未指定でも落ちない。
  assert.match(koyaJobResourceKey({ projectDir: "/tmp/p", action: "plan" }), /no-episode/u);
});

test("同じ案件が走っている間は、二本目を起動せず既存へ接続する", async () => {
  // 変更系の要求は毎回、無条件に新しい detached ジョブを作っていた。
  // 同じエピソードの同じ工程を二度投げても拒否も接続もされないので、
  // **二重課金・成果物の上書き・状態更新の消失**が起きる。
  const projectDir = await mkdtemp(join(tmpdir(), "koya-jobs-"));
  const root = join(projectDir, "canvas", "koya-mcp-jobs");
  await mkdir(root, { recursive: true });

  // 走っているジョブを1本置く（PID はこのプロセス＝生きている）。
  const resourceKey = koyaJobResourceKey({ projectDir, action: "render", options: { episodeId: "e1" } });
  const existing = {
    version: 1, id: "koya-existing", action: "render", projectDir, resourceKey,
    status: "running", runnerPid: process.pid,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    jobPath: join(root, "koya-existing.json"),
    stdoutPath: join(root, "koya-existing.stdout.log"),
    stderrPath: join(root, "koya-existing.stderr.log"),
  };
  await writeFile(existing.jobPath, JSON.stringify(existing, null, 2));

  const result = await startKoyaMcpJob({
    projectDir, action: "render", confirmed: true, options: { episodeId: "e1" },
  });
  assert.equal(result.attached, true, "既存のジョブへ接続すること");
  assert.equal(result.id, "koya-existing", "新しいジョブを作っていないこと");
  assert.match(result.note, /既に走っています/u);

  await rm(projectDir, { recursive: true, force: true });
});

test("走っていることになっているが死んでいるジョブは interrupted へ直す", async () => {
  // ホストが落ちると running のまま残り、記録だけからは再開も判定もできない。
  const projectDir = await mkdtemp(join(tmpdir(), "koya-jobs-dead-"));
  const root = join(projectDir, "canvas", "koya-mcp-jobs");
  await mkdir(root, { recursive: true });

  const resourceKey = koyaJobResourceKey({ projectDir, action: "images", options: { episodeId: "e9" } });
  const jobPath = join(root, "koya-dead.json");
  await writeFile(jobPath, JSON.stringify({
    version: 1, id: "koya-dead", action: "images", projectDir, resourceKey,
    status: "running", runnerPid: 999_999,          // 居ない PID
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    jobPath, stdoutPath: join(root, "a.log"), stderrPath: join(root, "b.log"),
  }, null, 2));

  // 起動を試みると、死んだジョブは interrupted へ直され、新しいジョブが立つ。
  await startKoyaMcpJob({
    projectDir, action: "images", confirmed: true, options: { episodeId: "e9" },
  }).catch(() => {});   // 実際の CLI 起動は失敗してよい。見たいのは再分類。

  const after = JSON.parse(await readFile(jobPath, "utf8"));
  assert.equal(after.status, "interrupted", "死んだジョブを running のまま残さないこと");
  assert.match(after.interruptedReason, /見つからない/u, "なぜそう判断したのかを残すこと");

  await rm(projectDir, { recursive: true, force: true });
});
