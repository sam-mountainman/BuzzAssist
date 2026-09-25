import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  HOOK_EVENT_LOG_ENV,
  analyzeUserPrompt,
  buildHookResponse,
  detectHookHost,
  hookEventLogPath,
} from "../scripts/harness-learn-hook.mjs";
import { PLUGIN_HOOK_MANIFESTS, stagePluginHooks } from "../scripts/setup-agents.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOOK = join(ROOT, "scripts", "harness-learn-hook.mjs");
const readJson = (relative) => JSON.parse(readFileSync(join(ROOT, ...relative.split("/")), "utf8"));

function runHook(input, { env = {}, timeoutMs = 10_000 } = {}) {
  const result = spawnSync(process.execPath, [HOOK], {
    cwd: ROOT,
    input: typeof input === "string" ? input : JSON.stringify(input),
    env: { ...process.env, [HOOK_EVENT_LOG_ENV]: "off", ...env },
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return result;
}

test("訂正・禁止・繰り返しの言い回しだけを拾い、普通の文には反応しない", () => {
  const positives = [
    "さっきも言ったけど、スキルは skill-creator を通して",
    "前にも伝えたとおり中身は日本語で",
    "何度も言ってるよね",
    "違う、そうじゃなくて左右が逆",
    "それは違います。ラベルの色が逆です",
    "そうじゃなくて、先に実測して",
    "数値が間違ってる",
    "勝手にコミットしないでください",
    "実在のロゴを使わないで。",
    "その書き方はやめて",
    "また同じミスをしている",
    "I already told you to run the audit first",
    "That's not what I asked for",
    "Don't do that again",
  ];
  for (const prompt of positives) assert.equal(analyzeUserPrompt(prompt).matched, true, `見逃した: ${prompt}`);
  const negatives = [
    "違うファイルを開いて確認して",
    "このテストを追加してください",
    "問題ないですか？",
    "少ないですね",
    "来ないで待つ理由を教えて",
    "何か質問はないでしょうか",
    "やめる理由を整理して",
    "さっき言ったファイルを開いて",
    "",
    "   ",
  ];
  for (const prompt of negatives) assert.equal(analyzeUserPrompt(prompt).matched, false, `誤検知: ${prompt}`);
  assert.deepEqual(analyzeUserPrompt("さっきも言った。それは違う。消さないで").kinds.sort(), ["constraint", "correction", "repeat"]);
});

test("応答は UserPromptSubmit の additionalContext だけで、本文を含めない", () => {
  const prompt = "前にも言ったけど、架空の固有名詞を共有台帳に書かないで";
  // Claude Code は user_prompt、Codex と旧版は prompt で渡す。
  for (const input of [
    { hook_event_name: "UserPromptSubmit", user_prompt: prompt, session_id: "s" },
    { hook_event_name: "UserPromptSubmit", prompt, turn_id: "t" },
  ]) {
    const response = buildHookResponse(input, { env: {} });
    assert.ok(response);
    assert.deepEqual(Object.keys(response.output), ["hookSpecificOutput"]);
    assert.equal(response.output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    const context = response.output.hookSpecificOutput.additionalContext;
    assert.match(context, /harness-self-improvement/u);
    assert.match(context, /capture/u);
    assert.match(context, /提案ゼロは正常/u);
    assert.equal(context.includes("架空の固有名詞"), false, "発言本文を文脈へ写した");
    assert.equal("decision" in response.output || "permissionDecision" in response.output.hookSpecificOutput, false, "入力を止める判定を出した");
  }
  assert.equal(buildHookResponse({ hook_event_name: "PreToolUse", prompt }, { env: {} }), null);
  assert.equal(buildHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "テストを追加して" }, { env: {} }), null);
  assert.equal(
    buildHookResponse({ hook_event_name: "UserPromptSubmit", prompt }, { env: { BUZZASSIST_LEARNING_WRITE_FORBIDDEN: "child-agent" } }),
    null,
    "子エージェントへ capture を促した",
  );
});

test("CLI は常に exit 0 で、当たったときだけ JSON を出し、数えるのは sha256 と時刻だけ", () => {
  const dir = mkdtempSync(join(tmpdir(), "learn-hook-"));
  try {
    const log = join(dir, "nested", "hook-events.jsonl");
    const prompt = "さっきも言ったけど、合成の依頼内容をここに書く";
    const hit = runHook({ hook_event_name: "UserPromptSubmit", user_prompt: prompt }, { env: { [HOOK_EVENT_LOG_ENV]: log } });
    assert.equal(hit.status, 0, hit.stderr);
    const output = JSON.parse(hit.stdout);
    assert.match(output.hookSpecificOutput.additionalContext, /harness-self-improvement/u);
    const lines = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.deepEqual(Object.keys(lines[0]).sort(), ["at", "host", "sha256"]);
    assert.ok(["claude", "codex", "unknown"].includes(lines[0].host));
    assert.match(lines[0].sha256, /^[a-f0-9]{64}$/u);
    assert.equal(readFileSync(log, "utf8").includes("合成の依頼"), false, "発言本文を保存した");

    const miss = runHook({ hook_event_name: "UserPromptSubmit", user_prompt: "テストを追加して" }, { env: { [HOOK_EVENT_LOG_ENV]: log } });
    assert.equal(miss.status, 0);
    assert.equal(miss.stdout, "");
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1, "当たらない発言まで数えた");

    for (const broken of ["{not json", "", "null", "[]", JSON.stringify({ hook_event_name: "UserPromptSubmit", user_prompt: 42 })]) {
      const result = runHook(broken);
      assert.equal(result.status, 0, `壊れた入力で止まった: ${broken}`);
      assert.equal(result.stdout, "");
    }
    // 記録先に書けなくても入力は止めない。
    writeFileSync(join(dir, "file"), "x");
    const unwritable = runHook({ hook_event_name: "UserPromptSubmit", user_prompt: prompt }, { env: { [HOOK_EVENT_LOG_ENV]: join(dir, "file", "sub", "log.jsonl") } });
    assert.equal(unwritable.status, 0);
    assert.ok(JSON.parse(unwritable.stdout).hookSpecificOutput);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // 記録先の既定はリポジトリの外（学習の状態の置き場）。BUZZASSIST_LEARNING_DIR で一緒に動く。
  assert.equal(hookEventLogPath({}, join(tmpdir(), "home")), join(tmpdir(), "home", ".buzzassist", "learning", "hook-events.jsonl"));
  assert.equal(
    hookEventLogPath({ BUZZASSIST_LEARNING_DIR: join(tmpdir(), "state") }, join(tmpdir(), "home")),
    join(tmpdir(), "state", "hook-events.jsonl"),
  );
  assert.equal(hookEventLogPath({ [HOOK_EVENT_LOG_ENV]: "off" }), null);
});

test("記録にどちらのホストから来たかを残す（Codex の起動行は変えずに見分ける）", () => {
  const home = join(tmpdir(), "synthetic-home");
  const noEnv = {};
  assert.equal(detectHookHost({ explicit: "claude", env: { PLUGIN_ROOT: "x" } }), "claude", "起動行の明示が優先");
  assert.equal(detectHookHost({ input: { turn_id: "turn-1", prompt: "x" }, env: noEnv, hookRoot: tmpdir() }), "codex");
  // Codex は互換のため CLAUDE_PLUGIN_ROOT も渡すので、PLUGIN_ROOT を先に見る。
  assert.equal(detectHookHost({ env: { PLUGIN_ROOT: "p", CLAUDE_PLUGIN_ROOT: "p" }, hookRoot: tmpdir() }), "codex");
  assert.equal(detectHookHost({ env: noEnv, hookRoot: join(home, ".codex", "plugins", "cache", "buzzassist", "buzzassist", "9.9.9") }), "codex");
  assert.equal(detectHookHost({ env: noEnv, hookRoot: join(home, ".claude", "plugins", "cache", "buzzassist", "buzzassist", "9.9.9") }), "claude");
  assert.equal(detectHookHost({ env: { CLAUDE_PLUGIN_ROOT: "p" }, hookRoot: tmpdir() }), "claude");
  assert.equal(detectHookHost({ env: noEnv, hookRoot: tmpdir() }), "unknown");
  // Claude Code の起動行はホストを明示する。Codex の起動行は変えない（変えると信頼し直しになる）。
  assert.match(readJson("hooks/claude-hooks.json").hooks.UserPromptSubmit[0].hooks[0].command, /--host claude$/u);
  assert.doesNotMatch(readJson("hooks/codex-hooks.json").hooks.UserPromptSubmit[0].hooks[0].command, /--host/u);
});

test("入力が閉じなくても短時間で exit 0 で終わり、ユーザーの入力を待たせない", async () => {
  const child = spawn(process.execPath, [HOOK], { cwd: ROOT, env: { ...process.env, [HOOK_EVENT_LOG_ENV]: "off" }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.write("{\"hook_event_name\":\"UserPromptSubmit\",");
  const started = Date.now();
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 5000, `終わるまでに時間がかかりすぎた: ${Date.now() - started}ms`);
});

test("両ホストのフック定義は UserPromptSubmit（学習）と Stop（完成前チェック）だけで、plugin.json から参照され、同じスクリプトを起動する", () => {
  const expected = { UserPromptSubmit: /harness-learn-hook\.mjs/u, Stop: /harness-stop-hook\.mjs/u };
  for (const [manifestPath, hookPath] of Object.entries(PLUGIN_HOOK_MANIFESTS)) {
    const manifest = readJson(manifestPath);
    assert.equal(manifest.hooks, `./${hookPath}`, `${manifestPath} が ${hookPath} を参照していない`);
    const hooks = readJson(hookPath);
    assert.deepEqual(Object.keys(hooks.hooks).sort(), Object.keys(expected).sort(), "宣言していないイベントに介入している");
    for (const [event, script] of Object.entries(expected)) {
      for (const hook of hooks.hooks[event].flatMap((group) => group.hooks)) {
        assert.equal(hook.type, "command");
        assert.match(hook.command, script);
        assert.ok(hook.timeout > 0 && hook.timeout <= 10, "タイムアウトが長すぎる（入力・停止を待たせる）");
      }
    }
  }
  // Claude Code 既定の hooks/hooks.json は置かない（manifest の参照と二重に読まれ、
  // Codex も既定で同じ名前を探すため、ホストの取り違えが起きる）。
  assert.equal(existsSync(join(ROOT, "hooks", "hooks.json")), false);
  assert.ok(readJson("package.json").files.includes("hooks/"), "npm の配布物にフック定義が入らない");
});

test("実際のフック起動行を、plugin root を与えたシェルで動かせる", () => {
  // ホストはフックの起動行を OS のシェルへ渡す（Windows は cmd.exe、それ以外は /bin/sh）。
  // 同じ起動行がどちらのシェルでも動くことを、spawnSync の shell: true で確かめる。
  const input = JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "それは違う、前にも伝えた" });
  const env = { ...process.env, [HOOK_EVENT_LOG_ENV]: "off" };
  // Claude Code は ${CLAUDE_PLUGIN_ROOT} を読み込み時に置き換えてからシェルへ渡す。
  const claude = readJson("hooks/claude-hooks.json").hooks.UserPromptSubmit[0].hooks[0].command.replaceAll("${CLAUDE_PLUGIN_ROOT}", ROOT);
  // Codex は PLUGIN_ROOT を環境変数で渡す（起動行は node -e がシェルに依らず解決する）。
  const codex = readJson("hooks/codex-hooks.json").hooks.UserPromptSubmit[0].hooks[0].command;
  for (const [label, command, extraEnv] of [["claude", claude, {}], ["codex", codex, { PLUGIN_ROOT: ROOT }]]) {
    const result = spawnSync(command, { shell: true, cwd: tmpdir(), input, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /harness-self-improvement/u, label);
  }
  // plugin root が渡らなくても、入力は止めない（何も出さずに exit 0）。
  const missing = spawnSync(codex, { shell: true, cwd: tmpdir(), input, env: { ...env, PLUGIN_ROOT: "", CLAUDE_PLUGIN_ROOT: "" }, encoding: "utf8", timeout: 20_000 });
  assert.equal(missing.status, 0);
  assert.equal(missing.stdout, "");
});

test("setup はフック定義を配布物へ入れ、参照先と起動スクリプトの実在を確かめる", async () => {
  const plugin = mkdtempSync(join(tmpdir(), "learn-hook-stage-"));
  try {
    for (const relative of Object.keys(PLUGIN_HOOK_MANIFESTS)) {
      mkdirSync(join(plugin, relative.split("/")[0]), { recursive: true });
      cpSync(join(ROOT, ...relative.split("/")), join(plugin, ...relative.split("/")));
    }
    await assert.rejects(stagePluginHooks(ROOT, plugin), /起動するスクリプトが配布物に無い/u);
    mkdirSync(join(plugin, "scripts"), { recursive: true });
    cpSync(HOOK, join(plugin, "scripts", "harness-learn-hook.mjs"));
    // Stop フックのスクリプトが無ければ、学習フックだけあっても配布を止める。
    await assert.rejects(stagePluginHooks(ROOT, plugin), /起動するスクリプトが配布物に無い: node .*harness-stop-hook/u);
    cpSync(join(ROOT, "scripts", "harness-stop-hook.mjs"), join(plugin, "scripts", "harness-stop-hook.mjs"));
    assert.deepEqual((await stagePluginHooks(ROOT, plugin)).sort(), ["hooks/claude-hooks.json", "hooks/codex-hooks.json"]);
    assert.ok(existsSync(join(plugin, "hooks", "claude-hooks.json")));
    assert.ok(existsSync(join(plugin, "hooks", "codex-hooks.json")));

    const manifest = JSON.parse(readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8"));
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ ...manifest, hooks: "./hooks/other.json" }));
    await assert.rejects(stagePluginHooks(ROOT, plugin), /hooks が hooks\/claude-hooks\.json を指していない/u);
  } finally {
    rmSync(plugin, { recursive: true, force: true });
  }
});
