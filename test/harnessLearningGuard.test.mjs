import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LEARNING_WRITE_FORBIDDEN_ENV,
  assertLearningWriteAllowed,
  childAgentEnvironment,
  learningWritesForbidden,
} from "../lib/harnessLearningGuard.mjs";
import { LEARNING_WRITE_ACTIONS, captureLearningProposal } from "../scripts/harness-learn.mjs";

const HARNESS_LEARN = fileURLToPath(new URL("../scripts/harness-learn.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("子エージェントの環境には学習書き込み禁止の印が入り、親の環境は変えない", () => {
  const parent = { PATH: "/usr/bin", SOMETHING: "kept" };
  const child = childAgentEnvironment(parent);
  assert.equal(child.SOMETHING, "kept");
  assert.equal(learningWritesForbidden(child), true);
  assert.equal(learningWritesForbidden(parent), false);
  assert.equal(parent[LEARNING_WRITE_FORBIDDEN_ENV], undefined, "親の環境を書き換えた");
  // 明示の解除だけを許す。
  assert.equal(learningWritesForbidden({ [LEARNING_WRITE_FORBIDDEN_ENV]: "0" }), false);
  assert.equal(learningWritesForbidden({ [LEARNING_WRITE_FORBIDDEN_ENV]: "" }), false);
  assert.throws(() => assertLearningWriteAllowed(child, "capture"), (error) => (
    error.code === "LEARNING_WRITE_FORBIDDEN_IN_CHILD_AGENT" && /親へ返/u.test(error.message)
  ));
});

test("印があれば capture は台帳へ書く前に止まる（Canvas / Receipt の自動捕捉も同じ関数を通る）", () => {
  let appended = false;
  assert.throws(
    () => captureLearningProposal({
      kind: "fact", target: "platform:platform-craft", text: "子エージェントが見つけた事実", session: "child-1",
      now: "2026-09-24T00:00:00.000Z",
    }, {
      env: childAgentEnvironment({}),
      signals: { terms: [], castIds: [] },
      privateVocabulary: null,
      append: () => { appended = true; },
      read: () => [],
      lock: (_file, action) => action(),
    }),
    /子エージェントからは学習を書きません/u,
  );
  assert.equal(appended, false);
});

test("CLI の書き込み系は印があれば拒否し、読むだけの status は通す", () => {
  assert.deepEqual([...LEARNING_WRITE_ACTIONS].sort(), ["apply", "approve", "capture", "curate", "pending", "promote", "reject", "sync"]);
  const env = childAgentEnvironment(process.env);
  for (const args of [
    ["capture", "--kind", "fact", "--target", "platform:platform-craft", "--text", "子からの捕捉は拒否される", "--session", "child"],
    ["sync"],
    ["promote", "--id", "000000000000", "--reviewer", "x"],
    ["apply", "--id", "000000000000", "--reviewer", "x"],
    ["curate", "--archive", "--id", "000000000000", "--reviewer", "x"],
    // 差分の承認キュー: 置く・承認・却下は書き込み（一覧と表示は読むだけ）。
    ["pending", "--id", "000000000000", "--proposed", "proposed.md", "--note", "子からの案は置かない規則本文"],
    ["approve", "--change", "chg-000000000000", "--reviewer", "x", "--human-verified"],
    ["reject", "--change", "chg-000000000000", "--reviewer", "x", "--reason", "子からは却下しない"],
  ]) {
    const result = spawnSync(process.execPath, [HARNESS_LEARN, ...args], { cwd: REPO_ROOT, env, encoding: "utf8" });
    assert.equal(result.status, 2, `${args[0]} が拒否されなかった: ${result.stdout}`);
    assert.match(result.stderr, /子エージェントからは学習を書きません/u);
  }
  const status = spawnSync(process.execPath, [HARNESS_LEARN, "status"], { cwd: REPO_ROOT, env, encoding: "utf8" });
  assert.equal(status.status, 0, status.stderr);
  const pending = spawnSync(process.execPath, [HARNESS_LEARN, "pending"], { cwd: REPO_ROOT, env, encoding: "utf8" });
  assert.equal(pending.status, 0, pending.stderr);
});
