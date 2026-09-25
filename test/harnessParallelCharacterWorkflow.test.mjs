// 別の話数の `images` を並べる前提: 人物の準備（prepareCharacterWorkflow）がストアを錠の中で読み書きする。
// 合成の台本・合成の人名だけを使う。有料の呼び出しは無い。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { prepareCharacterWorkflow, readCharacterWorkflowStore } from "../lib/characterPipeline.mjs";

const execFileAsync = promisify(execFile);
const MODULE_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "characterPipeline.mjs")).href;

function script(index) {
  return [
    "【ナレーション】ある町の朝。",
    `人物甲${index}：おはようございます。`,
    `人物乙${index}：今日もよろしく。`,
  ].join("\n");
}

test("prepareCharacterWorkflow for different episodes can run at the same time without a stale-revision failure", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-parallel-workflow-"));
  try {
    const episodes = Array.from({ length: 6 }, (_, index) => `fixture-episode-${index + 1}`);
    const workflows = await Promise.all(episodes.map((episodeId, index) => prepareCharacterWorkflow({
      projectDir,
      episodeId,
      workflowId: `workflow-${episodeId}`,
      scriptText: script(index + 1),
    })));
    assert.equal(workflows.length, episodes.length);
    const store = await readCharacterWorkflowStore({ projectDir });
    assert.equal(store.revision, episodes.length, "1件ごとに revision が1つ進む（書き込みが消えていない）");
    assert.deepEqual(
      store.workflows.map((workflow) => workflow.id).sort(),
      episodes.map((episodeId) => `workflow-${episodeId}`).sort(),
      "どの話数の workflow も残っている",
    );
    // 同じ workflow を作り直すと、件数は増えずに差し替わる
    await prepareCharacterWorkflow({ projectDir, episodeId: episodes[0], workflowId: `workflow-${episodes[0]}`, scriptText: script(1) });
    const after = await readCharacterWorkflowStore({ projectDir });
    assert.equal(after.workflows.length, episodes.length);
    assert.equal(after.revision, episodes.length + 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("separate processes preparing different episodes keep every workflow", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-parallel-workflow-proc-"));
  try {
    const episodes = ["fixture-proc-a", "fixture-proc-b", "fixture-proc-c"];
    await Promise.all(episodes.map((episodeId, index) => execFileAsync(process.execPath, [
      "--input-type=module",
      "-e",
      `import { prepareCharacterWorkflow } from ${JSON.stringify(MODULE_URL)};
       await prepareCharacterWorkflow({ projectDir: ${JSON.stringify(projectDir)}, episodeId: ${JSON.stringify(episodeId)}, workflowId: ${JSON.stringify(`workflow-${episodeId}`)}, scriptText: ${JSON.stringify(script(index + 1))} });`,
    ], { env: { ...process.env } })));
    const store = await readCharacterWorkflowStore({ projectDir });
    assert.equal(store.revision, episodes.length);
    assert.deepEqual(store.workflows.map((workflow) => workflow.id).sort(), episodes.map((episodeId) => `workflow-${episodeId}`).sort());
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
