// 人がやるべき操作と署名済みの封筒の書き換えを、道具の実行前に止める PreToolUse フックの試験。
// フックへホストと同じ形の JSON を流し、止まる／通るを確かめる。封筒は合成の一時フォルダにだけ作る。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  GUARD_DISABLE_ENV,
  HUMAN_ONLY_ACTIONS,
  buildGuardResponse,
  evaluateToolCall,
  patchTargets,
  runGuardHookCli,
  signedEnvelopeFor,
  splitShellCommand,
} from "../scripts/harness-guard-hook.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOOK = path.join(ROOT, "scripts", "harness-guard-hook.mjs");
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(ROOT, ...relative.split("/")), "utf8"));
// 実プロセスを起動する試験の待ちの上限。止まったことに気づくための見張りで、速さの基準ではない。
const PROCESS_HANG_GUARD_MS = 120_000;
const CWD = path.join(os.tmpdir(), "guard-hook-project");

function bash(command, { cwd = CWD, tool = "Bash", checkDisk = true } = {}) {
  return evaluateToolCall({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command }, cwd }, { checkDisk });
}

/** 合成の一時プロジェクト。試験が終われば消す。 */
function tempProject(t, prefix = "guard-project-") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** 封筒の目録（版の印）と payload を持つ、合成の封筒を作る。 */
function stageEnvelope(dir) {
  fs.mkdirSync(path.join(dir, "payload"), { recursive: true });
  fs.writeFileSync(path.join(dir, "channel-pack.json"), JSON.stringify({ version: "buzzassist-channel-pack-envelope-v1", files: [] }));
  fs.writeFileSync(path.join(dir, "payload", "a.json"), "{}");
  return dir;
}

function ruleOf(result) {
  return result ? result.rule : "pass";
}

test("--human-verified を渡すコマンドは、包み（sh -c・script・env・timeout・$()・ヒアドキュメント）越しでも止める", () => {
  const blocked = [
    "node scripts/harness-learn.mjs promote --id p1 --reviewer example-reviewer --human-verified",
    "node scripts/harness-learn.mjs approve --change c1 --reviewer example-reviewer --human-verified=yes",
    "script -q /dev/null node scripts/harness-learn.mjs approve --change c1 --reviewer example-reviewer --human-verified",
    "bash -lc \"node scripts/asset-quality-loop.mjs verify --check identity --pass --reviewer r --note n --human-verified\"",
    "cd /somewhere && FOO=1 timeout 30 node scripts/harness-learn.mjs apply --id p1 --reviewer r --human-verified",
    "env -i PATH=/bin caffeinate -i node scripts/harness-learn.mjs promote --human-verified",
    "echo \"$(node scripts/strategy-brief.mjs next --human-verified)\"",
    "bash <<'EOF'\nnode scripts/harness-learn.mjs promote --human-verified\nEOF",
    "npm run skills:check -- --human-verified",
    "node -e \"require('child_process').spawnSync('node', ['scripts/harness-learn.mjs', 'promote', '--human-verified'])\"",
  ];
  for (const command of blocked) assert.equal(ruleOf(bash(command)), "human-verified-flag", `見逃した: ${command}`);
});

test("--human-verified を話題にするだけのコマンド（検索・コミット・ファイルへの書き出し）は止めない", () => {
  const passed = [
    "rg -n -- --human-verified lib scripts",
    "grep -rn -e --human-verified docs",
    "git commit -m \"docs: 人は node scripts/harness-learn.mjs promote --human-verified を打つ\"",
    "git log -S --human-verified --oneline",
    "echo 'node scripts/strategy-brief.mjs stop --human-verified' | pbcopy",
    "cat <<'EOF' > notes.md\nnode scripts/harness-learn.mjs promote --human-verified\nEOF",
    "node -e \"console.log(require('fs').readFileSync('a.md', 'utf8').includes('--human-verified'))\"",
    "node scripts/harness-learn.mjs approve --change c1",
    "node scripts/asset-quality-loop.mjs verify --check identity --pass --reviewer r --note n --agent-attested",
    "node --test test/harnessLearnHook.test.mjs",
  ];
  for (const command of passed) assert.equal(ruleOf(bash(command)), "pass", `止めすぎた: ${command}`);
});

test("skill-inventory の --approve は、旗が無くても止める（npm run の形も）", () => {
  assert.equal(ruleOf(bash("node scripts/skill-inventory.mjs --approve buzzassist:example --reviewer r")), "skill-inventory-approve");
  assert.equal(ruleOf(bash("node scripts/skill-inventory.mjs --approve=buzzassist:example")), "skill-inventory-approve");
  assert.equal(ruleOf(bash("npm run skills:check -- --approve buzzassist:example --reviewer r")), "skill-inventory-approve");
  assert.equal(ruleOf(bash("npm run skills:check")), "pass");
  assert.equal(ruleOf(bash("npm run skills:check:release")), "pass");
  assert.equal(ruleOf(bash("node scripts/skill-inventory.mjs --json")), "pass");
});

test("品質ループの人専用の操作は、旗に関わらず止め、--help と他の操作は通す", () => {
  for (const [cli, actions] of Object.entries(HUMAN_ONLY_ACTIONS)) {
    for (const action of actions) {
      const command = `node scripts/${cli} ${action} --work-dir w --reason r --reviewer r`;
      const result = bash(command);
      assert.equal(ruleOf(result), "human-only-action", `見逃した: ${command}`);
      assert.equal(result.action, action);
      assert.equal(ruleOf(bash(`node scripts/${cli} ${action} --help`)), "pass", `使い方の表示まで止めた: ${cli} ${action}`);
    }
  }
  // 実装で確かめた一覧（人の確認が無いと何も数えない操作）。増えたらここも直す。
  assert.deepEqual(Object.fromEntries(Object.entries(HUMAN_ONLY_ACTIONS).map(([cli, actions]) => [cli, [...actions]])), {
    "script-quality-loop.mjs": ["accept-human", "reset-cumulative", "stop"],
    "asset-quality-loop.mjs": ["stop", "verify-pages"],
    "strategy-brief.mjs": ["stop"],
  });
  for (const command of [
    "node scripts/script-quality-loop.mjs status --work-dir w",
    "node scripts/script-quality-loop.mjs record --work-dir w --script s.md --version v1 --stage draft --review r.json",
    "node scripts/asset-quality-loop.mjs start --work-dir w --harness h --stage character --subject a --generator-context c",
    "node scripts/strategy-brief.mjs next --work-dir w",
    "for f in a b; do node scripts/strategy-brief.mjs status --work-dir $f; done",
    "sed -n 1,40p scripts/strategy-brief.mjs",
    "rg -n stop scripts/script-quality-loop.mjs",
  ]) assert.equal(ruleOf(bash(command)), "pass", `止めすぎた: ${command}`);
  assert.equal(ruleOf(bash("for f in a b; do node scripts/strategy-brief.mjs stop --work-dir $f; done")), "human-only-action");
});

test("署名済みの封筒（*-signed-* の下）へのシェルからの書き込みを止め、読むだけ・外へ写すだけ・公式の署名は通す", (t) => {
  const root = tempProject(t);
  const envelope = "canvas/example-handoff/example-signed-20260101";
  stageEnvelope(path.join(root, ...envelope.split("/")));
  stageEnvelope(path.join(root, "canvas", "example-handoff", "signed-envelope"));
  const blocked = [
    `cat > ${envelope}/channel-pack.json <<EOF\n{}\nEOF`,
    `echo x >> ${envelope}/payload/notes.md`,
    `cp /tmp/x.json ${envelope}/payload/x.json`,
    `rm -rf ${envelope}`,
    `mv ${envelope} /tmp/old-envelope`,
    `sed -i '' s/a/b/ ${envelope}/payload/a.json`,
    `perl -pi -e s/a/b/ ${envelope}/payload/a.json`,
    `tee ${envelope}/payload/a.json < /tmp/a.json`,
    `touch ${envelope}/payload/new.txt`,
    `tar xzf /tmp/a.tgz -C ${envelope}`,
    `unzip -o /tmp/a.zip -d ${envelope}`,
    `git -C ${envelope} checkout -- .`,
    `git restore ${envelope}/payload/a.json`,
    `find ${envelope} -name '*.json' -delete`,
    `cd ${envelope} && rm payload/a.json`,
    `node -e "require('fs').writeFileSync('${envelope}/payload/a.json', '{}')"`,
    `sh -c "rm ${envelope}/channel-pack.json"`,
    "rm -rf canvas/example-handoff/signed-envelope",
  ];
  for (const command of blocked) assert.equal(ruleOf(bash(command, { cwd: root })), "signed-pack-write", `見逃した: ${command}`);
  const passed = [
    `sha256sum ${envelope}/payload/* > /tmp/sums.txt`,
    `cp ${envelope}/channel-pack.json /tmp/`,
    `sed -n 1,20p ${envelope}/channel-pack.json`,
    `cat ${envelope}/channel-pack.json | jq .files`,
    `tar czf /tmp/envelope.tgz ${envelope}`,
    `find ${envelope} -name '*.json'`,
    `node scripts/channel-pack.mjs verify --bundle-dir ${envelope} --public-key /keys/pub.pem`,
    `node scripts/channel-pack.mjs sign --source-dir src --output-dir canvas/example-handoff/example-signed-20260102 --private-key /keys/k.pem`,
    `node scripts/run-video-harness.mjs start --channel-pack ${envelope}`,
    "echo ok > review/contact-sheet-signed-off.json",
    "ls 2>/dev/null >&2",
  ];
  for (const command of passed) assert.equal(ruleOf(bash(command, { cwd: root })), "pass", `止めすぎた: ${command}`);
});

test("名前が *-signed-* でも、目録の無い実在の階層とまだ無い階層は止めず、確かめられない道は名前で止める", (t) => {
  const root = tempProject(t);
  // ほかのプロジェクトの self-signed の証明書置き場（目録が無い）
  const certs = path.join(root, "certs", "self-signed-localhost");
  fs.mkdirSync(certs, { recursive: true });
  for (const command of [
    "rm certs/self-signed-localhost/key.pem",
    "openssl req -x509 -out certs/self-signed-localhost/cert.pem",
    "echo x > certs/self-signed-localhost/nginx.conf",
    // まだ無い階層に作るのは、署名済みの中身の書き換えではない
    "mkdir -p canvas/example-handoff/new-signed-1 && cp a.json canvas/example-handoff/new-signed-1/",
  ]) assert.equal(ruleOf(bash(command, { cwd: root })), "pass", `止めすぎた: ${command}`);
  assert.equal(ruleOf(evaluateToolCall({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(certs, "nginx.conf") }, cwd: root })), "pass");

  // glob を含む道は名前で数える。名前の無い封筒でも、glob の手前に目録があれば止める。
  assert.equal(ruleOf(bash("rm -rf canvas/*-signed-*/payload", { cwd: root })), "signed-pack-write");
  const plain = stageEnvelope(path.join(root, "delivery", "plain-envelope"));
  assert.equal(ruleOf(bash("rm -rf delivery/plain-envelope/*", { cwd: root })), "signed-pack-write");
  assert.equal(signedEnvelopeFor(path.join(plain, "payload", "*.json")), plain);
  // cwd の無い相対の道・道を確かめない判定は、名前だけで数える。
  assert.equal(signedEnvelopeFor("canvas/example-signed-1/payload/a.json"), "canvas/example-signed-1");
  assert.equal(signedEnvelopeFor(path.join(certs, "key.pem"), { checkDisk: false }), certs);
});

test("Edit・Write・MultiEdit・NotebookEdit・apply_patch で封筒の中を書き換えるのを止める", (t) => {
  const root = tempProject(t);
  stageEnvelope(path.join(root, "packs", "example-signed-1.0.0"));
  stageEnvelope(path.join(root, "packs", "example-signed-1"));
  stageEnvelope(path.join(root, "x-signed-2"));
  const inside = path.join(root, "packs", "example-signed-1.0.0", "payload", "a.json");
  for (const tool of ["Edit", "Write", "MultiEdit"]) {
    assert.equal(ruleOf(evaluateToolCall({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path: inside }, cwd: root })), "signed-pack-write", tool);
  }
  assert.equal(ruleOf(evaluateToolCall({ hook_event_name: "PreToolUse", tool_name: "NotebookEdit", tool_input: { notebook_path: inside.replace(/json$/u, "ipynb") }, cwd: root })), "signed-pack-write");
  // 相対の道は cwd を基準に解決する。
  assert.equal(ruleOf(evaluateToolCall({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "payload/a.json" }, cwd: path.join(root, "x-signed-2") })), "signed-pack-write");
  // 拡張子の付いたファイル名の中の -signed- は封筒の名前として数えない。
  assert.equal(ruleOf(evaluateToolCall({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(root, "review", "sheet-signed-off.json") }, cwd: root })), "pass");
  assert.equal(ruleOf(evaluateToolCall({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: path.join(root, "lib", "a.mjs") }, cwd: root })), "pass");

  const patch = "*** Begin Patch\n*** Update File: packs/example-signed-1/payload/a.json\n@@\n-a\n+b\n*** End Patch";
  assert.deepEqual(patchTargets(patch), ["packs/example-signed-1/payload/a.json"]);
  assert.equal(ruleOf(evaluateToolCall({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: patch }, cwd: root })), "signed-pack-write");
  // Codex がシェル経由で apply_patch を渡す形。
  assert.equal(ruleOf(bash(`apply_patch <<'EOF'\n${patch}\nEOF`, { cwd: root })), "signed-pack-write");
  const outside = "*** Begin Patch\n*** Add File: lib/new.mjs\n+export {};\n*** End Patch";
  assert.equal(ruleOf(evaluateToolCall({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: outside }, cwd: root })), "pass");
});

test("名前に -signed- が無い封筒も、祖先の目録（channel-pack.json の版）で見分ける", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-envelope-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const envelope = path.join(root, "delivery", "example-envelope");
  fs.mkdirSync(path.join(envelope, "payload"), { recursive: true });
  fs.writeFileSync(path.join(envelope, "channel-pack.json"), JSON.stringify({ version: "buzzassist-channel-pack-envelope-v1", files: [] }));
  const plain = path.join(root, "delivery", "source-bundle");
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(path.join(plain, "channel-pack.json"), JSON.stringify({ id: "not-an-envelope" }));

  assert.equal(signedEnvelopeFor(path.join(envelope, "payload", "a.json")), envelope);
  assert.equal(signedEnvelopeFor(path.join(plain, "a.json")), "", "封筒でない束を封筒として数えた");
  assert.equal(signedEnvelopeFor(path.join(envelope, "payload", "a.json"), { checkDisk: false }), "");
  const write = evaluateToolCall({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(envelope, "payload", "new.json") }, cwd: root });
  assert.equal(ruleOf(write), "signed-pack-write");
  assert.equal(ruleOf(bash("rm payload/a.json", { cwd: envelope })), "signed-pack-write");
  assert.equal(ruleOf(bash(`cp ${path.join(envelope, "channel-pack.json")} /tmp/copy.json`, { cwd: root })), "pass");
  assert.equal(ruleOf(evaluateToolCall({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(plain, "a.json") }, cwd: root })), "pass");
});

test("PowerShell と、Codex の配列の形のコマンドも同じ判定にかける", () => {
  assert.equal(ruleOf(bash("node scripts\\harness-learn.mjs promote --human-verified", { tool: "PowerShell" })), "human-verified-flag");
  // Windows の道はこの試験の端末には無いので、道を確かめない判定（名前の規則）で見る。
  assert.equal(ruleOf(bash("Remove-Item -Recurse C:\\packs\\example-signed-1", { tool: "PowerShell", checkDisk: false })), "signed-pack-write");
  assert.equal(ruleOf(bash("Get-Content C:\\packs\\example-signed-1\\channel-pack.json", { tool: "PowerShell", checkDisk: false })), "pass");
  const array = evaluateToolCall({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: ["bash", "-lc", "node scripts/strategy-brief.mjs stop --work-dir w"] },
    cwd: CWD,
  });
  assert.equal(ruleOf(array), "human-only-action");
});

test("BuzzAssist と関係の無い呼び出し・一般の git 操作・ほかのイベント・壊れた入力には何も言わない", () => {
  for (const command of [
    "git add -A && git commit -m wip",
    "git push --force origin feature/x",
    "npm install && npm test",
    "rm -rf node_modules/.cache",
    "docker compose up -d",
  ]) assert.equal(ruleOf(bash(command)), "pass", command);
  assert.equal(evaluateToolCall({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "node x.mjs --human-verified" } }), null);
  assert.equal(evaluateToolCall({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/x/y-signed-1/a.json" } }), null);
  assert.equal(evaluateToolCall(null), null);
  assert.equal(evaluateToolCall({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }), null);
});

test("止めるときはホスト共通の deny の形で、人が自分の端末で打つ操作だという理由を返す", () => {
  const response = buildGuardResponse({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "node scripts/harness-learn.mjs promote --human-verified" },
    cwd: CWD,
  }, { env: {} });
  assert.equal(response.output.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(response.output.hookSpecificOutput.permissionDecision, "deny");
  const reason = response.output.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /自分の対話端末/u);
  assert.match(reason, /--agent-attested/u);
  assert.match(reason, /`!` の入力/u);
  // 運営者はホストを起動するシェルで止められる（エージェントのコマンドの環境変数では止まらない）。
  for (const value of ["0", "off"]) {
    assert.equal(buildGuardResponse({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "node x.mjs --human-verified" } }, { env: { [GUARD_DISABLE_ENV]: value } }), null);
  }
  assert.equal(ruleOf(bash(`${GUARD_DISABLE_ENV}=0 node scripts/harness-learn.mjs promote --human-verified`)), "human-verified-flag");
});

test("シェルの分解: 引用・fd の複製・ヒアドキュメントの本文・コマンド置換を取り違えない", () => {
  const { commands, substitutions } = splitShellCommand("a 'b c' \"d $(e f) g\" 2>&1 >out.txt | h <<EOF && i\nbody line\nEOF\nj");
  assert.deepEqual(commands.map((command) => command.words), [["a", "b c", "d $(e f) g"], ["h"], ["i"], ["j"]]);
  assert.deepEqual(commands[0].redirects, [{ op: ">", target: "out.txt" }]);
  assert.deepEqual(commands[1].heredocs, ["body line"]);
  assert.deepEqual(substitutions, ["e f"]);
  // POSIX の "..." の中の \ は、$ ` " \ の前でだけ効く。
  assert.deepEqual(splitShellCommand("echo \"a\\b \\\"c\\\"\"").commands[0].words, ["echo", "a\\b \"c\""]);
});

test("実プロセス: 止めるときだけ deny を1行出し、通すとき・壊れた入力では何も出さずに exit 0", () => {
  const run = (input) => spawnSync(process.execPath, [HOOK], {
    cwd: ROOT,
    input: typeof input === "string" ? input : JSON.stringify(input),
    env: { ...process.env, [GUARD_DISABLE_ENV]: "" },
    encoding: "utf8",
    timeout: PROCESS_HANG_GUARD_MS,
  });
  const denied = run({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "node scripts/strategy-brief.mjs stop --work-dir w" }, cwd: CWD });
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
  for (const input of [
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls -la" }, cwd: CWD },
    "{not json",
    "",
  ]) {
    const result = run(input);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  }
});

test("入力が閉じなくても、見張りの時計で exit 0 を呼び、何も出さない（道具を止めない）", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { PassThrough } = await import("node:stream");
  const stdin = new PassThrough();
  let out = "";
  const exits = [];
  const running = runGuardHookCli({
    stdin,
    stdout: { write: (chunk) => { out += chunk; return true; } },
    env: {},
    exit: (code) => { exits.push(code); },
  });
  stdin.write("{\"hook_event_name\":\"PreToolUse\",");
  let virtualMs = 0;
  while (exits.length === 0 && virtualMs < 60_000) {
    t.mock.timers.tick(100);
    virtualMs += 100;
  }
  assert.deepEqual(exits, [0]);
  assert.ok(virtualMs <= 2_000, `道具を待たせすぎる（${virtualMs}ms）`);
  stdin.end();
  assert.equal(await running, 0);
  assert.equal(out, "");
});

test("両ホストのフック定義: PreToolUse は Bash と編集の道具に当て、起動行はシェルに依らず動く", () => {
  const claude = readJson("hooks/claude-hooks.json").hooks.PreToolUse;
  const codex = readJson("hooks/codex-hooks.json").hooks.PreToolUse;
  assert.equal(claude.length, 1);
  assert.equal(codex.length, 1);
  for (const tool of ["Bash", "PowerShell", "Edit", "Write", "MultiEdit", "NotebookEdit"]) {
    assert.ok(claude[0].matcher.split("|").includes(tool), `Claude Code の matcher に ${tool} が無い`);
  }
  for (const tool of ["Bash", "apply_patch", "Edit", "Write"]) {
    assert.match(tool, new RegExp(codex[0].matcher, "u"), `Codex の matcher が ${tool} に当たらない`);
  }
  assert.doesNotMatch("Read", new RegExp(codex[0].matcher, "u"));

  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "node scripts/harness-learn.mjs promote --human-verified" }, cwd: CWD });
  const claudeCommand = claude[0].hooks[0].command.replaceAll("${CLAUDE_PLUGIN_ROOT}", ROOT);
  const codexCommand = codex[0].hooks[0].command;
  const env = { ...process.env, [GUARD_DISABLE_ENV]: "" };
  for (const [label, command, extraEnv] of [["claude", claudeCommand, {}], ["codex", codexCommand, { PLUGIN_ROOT: ROOT }]]) {
    const result = spawnSync(command, { shell: true, cwd: os.tmpdir(), input, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: PROCESS_HANG_GUARD_MS });
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny", label);
  }
  // plugin root が渡らなくても、道具は止めない（何も出さずに exit 0）。
  const missing = spawnSync(codexCommand, { shell: true, cwd: os.tmpdir(), input, env: { ...env, PLUGIN_ROOT: "", CLAUDE_PLUGIN_ROOT: "" }, encoding: "utf8", timeout: PROCESS_HANG_GUARD_MS });
  assert.equal(missing.status, 0);
  assert.equal(missing.stdout, "");
});

test("実プロセス: 入力が閉じなくても、自分で exit 0 で終わる", { timeout: PROCESS_HANG_GUARD_MS }, async (t) => {
  const child = spawn(process.execPath, [HOOK], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stdin.on("error", () => {});
  child.stdin.write("{\"hook_event_name\":\"PreToolUse\",");
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(child.stdin.writableEnded, false);
  assert.equal(code, 0);
  assert.equal(stdout, "");
});
