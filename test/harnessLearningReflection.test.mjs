// 回数で起動する振り返り（lib/harnessLearningReflection.mjs と UserPromptSubmit フック）の試験。
//
// 学習の置き場は試験ごとの一時ディレクトリ（BUZZASSIST_LEARNING_DIR）へ向け、本物の
// ~/.buzzassist には書かない。capture は一時ディレクトリに写した開発用チェックアウト
// （.git と .claude/skills と .codex/skills の印を置いたもの）から動かし、本物の台帳にも書かない。
// 会話 ID・発言・人名はすべて合成。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULT_REFLECTION_INTERVAL,
  REFLECTION_INTERVAL_ENV,
  conversationKey,
  countPromptForReflection,
  reflectionDir,
  reflectionInterval,
  reflectionStatePath,
  resetReflectionCounter,
  sessionTokenFor,
} from "../lib/harnessLearningReflection.mjs";
import { resolveLearningState } from "../lib/harnessLearningState.mjs";
import { buildHookResponse } from "../scripts/harness-learn-hook.mjs";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(SOURCE_ROOT, "scripts", "harness-learn-hook.mjs");
const SKILL = "sample-craft";
const TARGET = `platform:${SKILL}`;
const ENV_KEYS_TO_CLEAR = [
  "BUZZASSIST_LEARNING_DIR", "BUZZASSIST_LEARNING_HOOK_LOG", "BUZZASSIST_LEARNING_WRITE_FORBIDDEN",
  REFLECTION_INTERVAL_ENV, "PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT",
];

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "learning-reflection-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function isolatedEnv(root, extra = {}) {
  const env = { ...process.env, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home") };
  for (const key of ENV_KEYS_TO_CLEAR) delete env[key];
  return { ...env, BUZZASSIST_LEARNING_DIR: path.join(root, "learning"), BUZZASSIST_LEARNING_HOOK_LOG: "off", ...extra };
}

function runHook(input, env) {
  const result = spawnSync(process.execPath, [HOOK], {
    cwd: os.tmpdir(), input: JSON.stringify(input), env, encoding: "utf8", timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.additionalContext : "";
}

function prompt(session, text = "次の手順に進んでください", extra = {}) {
  return { hook_event_name: "UserPromptSubmit", session_id: session, user_prompt: text, ...extra };
}

/** 本物の harness-learn を一時の開発用チェックアウトへ写す（相対 import は本物のモジュールへ転送する）。 */
function stageScript(root, relative) {
  const real = path.join(SOURCE_ROOT, ...relative.split("/"));
  const source = fs.readFileSync(real, "utf8");
  const staged = write(path.join(root, ...relative.split("/")), source);
  for (const [, specifier] of source.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/gu)) {
    const target = path.resolve(path.dirname(staged), specifier);
    if (fs.existsSync(target)) continue;
    write(target, `export * from ${JSON.stringify(pathToFileURL(path.resolve(path.dirname(real), specifier)).href)};\n`);
  }
  return staged;
}

function stageDevelopmentCheckout(root) {
  const repo = path.join(root, "repo");
  stageScript(repo, "scripts/harness-learn.mjs");
  write(path.join(repo, "docs", "learning", "targets.json"), `${JSON.stringify({
    targets: {
      [TARGET]: {
        mode: "auto-guidance",
        canonical: `.agents/skills/${SKILL}/SKILL.md`,
        overlay: `.agents/skills/${SKILL}/references/learned-auto.md`,
        scope: "platform",
      },
    },
  }, null, 2)}\n`);
  write(path.join(repo, ".agents", "skills", SKILL, "SKILL.md"), "# 合成スキル\n");
  for (const marker of [".git", path.join(".claude", "skills"), path.join(".codex", "skills")]) fs.mkdirSync(path.join(repo, marker), { recursive: true });
  return repo;
}

test("間隔は既定 10、環境変数で変えられ、0 / off で止まる。不正な値は既定へ戻す", () => {
  assert.equal(DEFAULT_REFLECTION_INTERVAL, 10);
  assert.equal(reflectionInterval({}), 10);
  assert.equal(reflectionInterval({ [REFLECTION_INTERVAL_ENV]: "3" }), 3);
  assert.equal(reflectionInterval({ [REFLECTION_INTERVAL_ENV]: "0" }), 0);
  assert.equal(reflectionInterval({ [REFLECTION_INTERVAL_ENV]: "off" }), 0);
  for (const broken of ["-1", "2.5", "abc", "100000"]) assert.equal(reflectionInterval({ [REFLECTION_INTERVAL_ENV]: broken }), 10, broken);
});

test("フックは会話ごとに発言を数え、10 回目で振り返りを促す。数えるのは回数と時刻だけ", (t) => {
  const root = tempRoot(t);
  const env = isolatedEnv(root);
  const session = "synthetic-session-0001";
  const body = "合成の依頼本文をここに書く";
  for (let index = 1; index <= 9; index += 1) {
    assert.equal(runHook(prompt(session, `${body}${index}`), env), "", `${index} 回目で促した`);
  }
  const context = runHook(prompt(session, body), env);
  assert.match(context, /発言が 10 回になりました/u);
  assert.match(context, /harness-self-improvement/u);
  assert.match(context, /提案ゼロは正常/u);
  assert.match(context, new RegExp(`--session "${session}"`, "u"), "capture が数え直せる会話 ID を示していない");
  assert.equal(context.includes(body), false, "発言本文を文脈へ写した");

  // 記録は学習の置き場の reflection/ に、会話 ID の sha256 の名前で1つだけ。本文も会話 ID も残さない。
  const dir = path.join(root, "learning", "reflection");
  const files = fs.readdirSync(dir);
  assert.deepEqual(files, [`${conversationKey(session)}.json`]);
  const text = fs.readFileSync(path.join(dir, files[0]), "utf8");
  assert.equal(text.includes(body), false, "発言本文を保存した");
  assert.equal(text.includes(session), false, "会話 ID をそのまま保存した");
  const state = JSON.parse(text);
  assert.equal(state.count, 10);
  assert.equal(state.nudges, 1);

  // 別の会話は別に数える（10 回目の会話の数に混ざらない）。
  assert.equal(runHook(prompt("synthetic-session-0002"), env), "");
  assert.equal(JSON.parse(fs.readFileSync(reflectionStatePath("synthetic-session-0002", { env }), "utf8")).count, 1);

  // capture しなければ、次は 20 回目で促す。
  for (let index = 11; index <= 19; index += 1) assert.equal(runHook(prompt(session), env), "");
  assert.match(runHook(prompt(session), env), /発言が 20 回になりました/u);
  // 本物の HOME（~/.buzzassist）の下を使っていない。
  assert.equal(fs.existsSync(path.join(root, "home", ".buzzassist")), false);
});

test("capture（同じ --session）で0に戻り、そこから数え直す", (t) => {
  const root = tempRoot(t);
  const env = isolatedEnv(root, { [REFLECTION_INTERVAL_ENV]: "3" });
  const repo = stageDevelopmentCheckout(root);
  const session = "synthetic-session-capture";
  assert.equal(runHook(prompt(session), env), "");
  assert.equal(runHook(prompt(session), env), "");
  assert.match(runHook(prompt(session), env), /発言が 3 回になりました/u);

  const capture = spawnSync(process.execPath, [
    path.join(repo, "scripts", "harness-learn.mjs"), "capture",
    "--kind", "preference", "--target", TARGET,
    "--text", "合成の手順では置き場を先に確かめる", "--evidence", "合成の根拠", "--session", session,
  ], { cwd: repo, env, encoding: "utf8", input: "", timeout: 60_000 });
  assert.equal(capture.status, 0, `${capture.stdout}\n${capture.stderr}`);
  assert.match(capture.stdout, /振り返りの数を0に戻しました/u);
  // 捕捉は一時の開発用チェックアウトの台帳へ入る（本物のリポジトリには書かない）。
  assert.equal(fs.readFileSync(path.join(repo, "docs", "learning", "proposals.jsonl"), "utf8").trim().split("\n").length, 1);
  const state = JSON.parse(fs.readFileSync(reflectionStatePath(session, { env }), "utf8"));
  assert.equal(state.count, 0);
  assert.equal(state.lastResetReason, "capture");

  // 0 に戻ったので、次に促すのは 3 回あと。
  assert.equal(runHook(prompt(session), env), "");
  assert.equal(runHook(prompt(session), env), "");
  assert.match(runHook(prompt(session), env), /発言が 3 回になりました/u);

  // 数えていない会話の capture は何もしない（記録を作らない）。
  assert.equal(resetReflectionCounter("synthetic-session-unknown", { env }), false);
  assert.equal(fs.existsSync(reflectionStatePath("synthetic-session-unknown", { env })), false);
});

test("子エージェント・サブエージェント・0 設定では数えも促しもしない", (t) => {
  const root = tempRoot(t);
  const session = "synthetic-session-child";
  const child = isolatedEnv(root, { BUZZASSIST_LEARNING_WRITE_FORBIDDEN: "child-agent", [REFLECTION_INTERVAL_ENV]: "1" });
  assert.equal(runHook(prompt(session), child), "");
  assert.equal(runHook(prompt(session, "それは違う、前にも伝えた"), child), "", "子エージェントへ促した");
  const subagent = isolatedEnv(root, { [REFLECTION_INTERVAL_ENV]: "1" });
  assert.equal(runHook(prompt(session, "次へ", { agent_id: "synthetic-agent" }), subagent), "");
  const disabled = isolatedEnv(root, { [REFLECTION_INTERVAL_ENV]: "0" });
  for (let index = 0; index < 12; index += 1) assert.equal(runHook(prompt(session), disabled), "");
  assert.equal(fs.existsSync(path.join(root, "learning", "reflection")), false, "止めたのに数えた");
  assert.equal(countPromptForReflection(prompt(session), { env: disabled }).reason, "disabled");
  assert.equal(countPromptForReflection(prompt(session), { env: child }).reason, "child-agent");
  assert.equal(resetReflectionCounter(session, { env: child }), false);
  // 訂正の言い回しの検知は 0 設定でも今のまま動く。
  assert.match(runHook(prompt(session, "それは違う、前にも伝えた"), disabled), /訂正/u);
});

test("訂正の言い回しと振り返りの回が重なれば、両方の段落を1つの文脈で返す。Codex の形の入力も数える", (t) => {
  const root = tempRoot(t);
  const env = isolatedEnv(root, { [REFLECTION_INTERVAL_ENV]: "2" });
  const session = "synthetic-codex-session";
  const codexInput = (text, turn) => ({ hook_event_name: "UserPromptSubmit", session_id: session, turn_id: turn, prompt: text });
  assert.equal(runHook(codexInput("次へ", "turn-1"), env), "");
  const both = runHook(codexInput("それは違う、前にも伝えた", "turn-2"), env);
  assert.match(both, /直前の発言に「[^」]*訂正[^」]*」らしい言い回し/u);
  assert.match(both, /発言が 2 回になりました/u);
  assert.equal(both.split("[BuzzAssist 自己改善]").length - 1, 2);
  // 訂正の段落にも同じ会話 ID を入れる（その capture でも数え直せるように）。
  assert.equal(both.split(`--session "${session}"`).length - 1, 2);
});

test("会話 ID がパスの形なら文脈に写さず conv-<鍵> を示し、その鍵の capture でも0に戻る", (t) => {
  const root = tempRoot(t);
  const env = isolatedEnv(root, { [REFLECTION_INTERVAL_ENV]: "1" });
  const transcript = path.join(root, "home", "synthetic-transcripts", "session.jsonl");
  const context = runHook({ hook_event_name: "UserPromptSubmit", transcript_path: transcript, prompt: "次へ" }, env);
  const token = sessionTokenFor(transcript);
  assert.match(token, /^conv-[a-f0-9]{32}$/u);
  assert.match(context, new RegExp(`--session "${token}"`, "u"));
  assert.equal(context.includes(transcript), false, "端末のパスを文脈へ写した");
  assert.equal(conversationKey(token), conversationKey(transcript));
  assert.equal(resetReflectionCounter(token, { env }), true);
  assert.equal(JSON.parse(fs.readFileSync(reflectionStatePath(transcript, { env }), "utf8")).count, 0);
  // 会話 ID が無ければ数えない（どの会話か分からないものを1つに混ぜない）。
  assert.equal(countPromptForReflection({ hook_event_name: "UserPromptSubmit", prompt: "次へ" }, { env }).reason, "no-session");
  // 応答を作る関数そのものは副作用が無く、数えた結果を受け取って段落を足すだけ。
  assert.equal(buildHookResponse(prompt("s", "次へ"), { env: {}, reflection: { counted: true, due: false, count: 1, interval: 10 } }), null);
});

test("Windows のパス区切りでも、数える置き場を学習の置き場から組み立てる", () => {
  const win = path.win32;
  const home = win.join("C:", "Users", "sample-operator");
  assert.equal(reflectionDir({ env: {}, homeDir: home, pathApi: win }), win.join(home, ".buzzassist", "learning", "reflection"));
  const override = win.join("D:", "operator-data", "learning");
  assert.equal(reflectionDir({ env: { BUZZASSIST_LEARNING_DIR: override }, homeDir: home, pathApi: win }), win.join(win.resolve(override), "reflection"));
  const installed = resolveLearningState({ codeRoot: win.join(home, ".codex", "plugins", "cache", "buzzassist", "buzzassist", "9.9.1"), homeDir: home, env: {}, pathApi: win, developmentCheckout: false });
  assert.equal(installed.reflectionDir, win.join(home, ".buzzassist", "learning", "reflection"));
  assert.equal(installed.autoSyncLogPath, win.join(home, ".buzzassist", "learning", "auto-sync.jsonl"));
  const development = resolveLearningState({ codeRoot: win.join("C:", "work", "buzzassist"), homeDir: home, env: {}, pathApi: win, developmentCheckout: true });
  assert.equal(development.reflectionDir, win.join(home, ".buzzassist", "learning", "reflection"), "開発用チェックアウトでも数えた記録はリポジトリの外");
  // 同じ会話 ID は、区切り文字に依らず同じ鍵になる。
  assert.equal(conversationKey("synthetic-session"), conversationKey(" synthetic-session "));
});
