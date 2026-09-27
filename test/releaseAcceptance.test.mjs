import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MCP_RUNTIME_DEPENDENCIES } from "../lib/pluginRuntimeDependencies.mjs";
import {
  codexHookEventKey,
  hookCommandTarget,
  probeReleaseCurrency,
  runReleaseAcceptance,
} from "../lib/releaseAcceptance.mjs";
import { runHarnessDoctor } from "../scripts/harness-doctor.mjs";
import { parseAcceptanceArgs, runReleaseAcceptanceCli } from "../scripts/release-acceptance.mjs";

// 実機の ~/.claude と ~/.codex は読まない。ホストの設定・plugin の置き場・更新器の記録を、
// 一時フォルダに偽物で作って読ませる。MCP は偽の stdio サーバー（fixtures）を起動する。

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const fakeServerSource = readFileSync(fileURLToPath(new URL("./fixtures/fakeAcceptanceMcpServer.mjs", import.meta.url)), "utf8");
const expectedClaudeHooks = JSON.parse(readFileSync(join(repoRoot, "hooks", "claude-hooks.json"), "utf8"));
const expectedCodexHooks = JSON.parse(readFileSync(join(repoRoot, "hooks", "codex-hooks.json"), "utf8"));
const LATEST = "9.1.0";
const REPOSITORY = "example-owner/example-plugin";
const TRUSTED_HASH = `sha256:${"a".repeat(64)}`;

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
}

function releaseFor(version) {
  return { tag_name: `v${version}`, draft: false, prerelease: false, zipball_url: `https://api.github.com/repos/${REPOSITORY}/zipball/v${version}` };
}

// フックの定義（hooks/*.json）が起動する script と、その export。フックを足したらここにも足す
// （足し忘れると、偽の導入物に script が無いとして受け入れ確認が落ちる）。
// Release のフックの定義にある出来事（PreToolUse・SessionStart・Stop・UserPromptSubmit など）。試験はこの一覧に合わせる。
const RELEASE_HOOK_EVENTS = Object.freeze(Object.keys(JSON.parse(readFileSync(resolve("hooks", "codex-hooks.json"), "utf8")).hooks).sort());
const trustFor = (value) => Object.fromEntries(RELEASE_HOOK_EVENTS.map((event) => [event, value]));

const HOOK_SCRIPT_EXPORTS = Object.freeze({
  "harness-learn-hook.mjs": "runHookCli",
  "harness-stop-hook.mjs": "runStopHookCli",
  "harness-guard-hook.mjs": "runGuardHookCli",
  "harness-compact-hook.mjs": "runCompactHookCli",
});

function hookScripts(root) {
  for (const [script, exportName] of Object.entries(HOOK_SCRIPT_EXPORTS)) {
    writeFile(join(root, "scripts", script), `export async function ${exportName}() {}\n`);
  }
}

function withoutStop(definition) {
  const copy = JSON.parse(JSON.stringify(definition));
  delete copy.hooks.Stop;
  return copy;
}

function makeFixture(t, {
  claudeVersion = LATEST,
  codexVersion = LATEST,
  serverVersion = LATEST,
  claudeHooks = expectedClaudeHooks,
  codexHooks = expectedCodexHooks,
  codexTrusted = true,
  claudeEnabled = true,
  disableAllHooks = false,
  serverDeps = true,
  withClaude = true,
  withCodex = true,
} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "release-acceptance-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const marketplace = join(home, "plugins", "buzzassist");
  const serverRoot = join(marketplace, "plugin");
  writeFile(join(serverRoot, "package.json"), { name: "buzzassist-canvas-mcp", version: serverVersion });
  writeFile(join(serverRoot, ".codex-plugin", "plugin.json"), { name: "buzzassist", version: codexVersion });
  writeFile(join(serverRoot, "scripts", "start-mcp.mjs"), fakeServerSource);
  if (serverDeps) {
    for (const dependency of MCP_RUNTIME_DEPENDENCIES) mkdirSync(join(serverRoot, "node_modules", ...dependency.split("/")), { recursive: true });
  }
  writeFile(join(marketplace, ".agents", "plugins", "marketplace.json"), { name: "buzzassist", plugins: [{ name: "buzzassist", source: { source: "local", path: "./plugin" } }] });
  // setup と同じく、ホストの置き場の .mcp.json は管理下の置き場の start-mcp.mjs を絶対パスで指す。
  const mcpConfig = {
    mcpServers: {
      buzzassist_mcp: {
        command: process.execPath,
        args: [join(serverRoot, "scripts", "start-mcp.mjs")],
        cwd: serverRoot,
        env: { EXCALIDRAW_PROJECT_DIR: join(root, "operator-project"), EXCALIDRAW_CANVAS_DIR: join(root, "operator-project", "canvas") },
      },
    },
  };

  if (withClaude) {
    const claudeRoot = join(home, ".claude", "plugins", "cache", "buzzassist", "buzzassist", claudeVersion);
    writeFile(join(claudeRoot, ".claude-plugin", "plugin.json"), { name: "buzzassist", version: claudeVersion, hooks: "./hooks/claude-hooks.json", mcpServers: "./.mcp.json" });
    writeFile(join(claudeRoot, "hooks", "claude-hooks.json"), claudeHooks);
    writeFile(join(claudeRoot, ".mcp.json"), mcpConfig);
    hookScripts(claudeRoot);
    writeFile(join(home, ".claude", "plugins", "installed_plugins.json"), {
      version: 2,
      plugins: { "buzzassist@buzzassist": [{ scope: "user", installPath: claudeRoot, version: claudeVersion }] },
    });
    writeFile(join(home, ".claude", "settings.json"), {
      enabledPlugins: { "buzzassist@buzzassist": claudeEnabled },
      ...(disableAllHooks ? { disableAllHooks: true } : {}),
    });
  }
  if (withCodex) {
    const codexRoot = join(home, ".codex", "plugins", "cache", "buzzassist", "buzzassist", codexVersion);
    writeFile(join(codexRoot, ".codex-plugin", "plugin.json"), { name: "buzzassist", version: codexVersion, hooks: "./hooks/codex-hooks.json", mcpServers: "./.mcp.json" });
    writeFile(join(codexRoot, "hooks", "codex-hooks.json"), codexHooks);
    writeFile(join(codexRoot, ".mcp.json"), mcpConfig);
    hookScripts(codexRoot);
    // Windows のパスでも壊れないよう、marketplace の置き場は TOML のリテラル文字列（'...'）で書く。
    const trust = codexTrusted
      ? RELEASE_HOOK_EVENTS.map(codexHookEventKey).map((event) => `[hooks.state."buzzassist@buzzassist:hooks/codex-hooks.json:${event}:0:0"]\ntrusted_hash = "${TRUSTED_HASH}"\n`).join("\n")
      : "";
    writeFile(join(home, ".codex", "config.toml"), [
      "[marketplaces.buzzassist]",
      "source_type = \"local\"",
      `source = '${marketplace}'`,
      "",
      "[plugins.\"buzzassist@buzzassist\"]",
      "enabled = true",
      "",
      trust,
    ].join("\n"));
  }
  const mcpLog = join(root, "mcp.log");
  writeFileSync(mcpLog, "");
  const env = { PATH: process.env.PATH || "", FAKE_MCP_LOG: mcpLog };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return { root, home, serverRoot, marketplace, mcpLog, env };
}

function mcpLaunches(fixture) {
  return readFileSync(fixture.mcpLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function treeDigest(root) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(`${relative(root, full)}/`);
        visit(full);
      } else {
        out.push(`${relative(root, full)}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
      }
    }
  };
  visit(root);
  return out.sort().join("\n");
}

function check(report, host, id) {
  return report.hosts.find((entry) => entry.host === host)?.checks.find((entry) => entry.id === id);
}

async function accept(fixture, options = {}) {
  return runReleaseAcceptance({
    homeDir: fixture.home,
    env: fixture.env,
    fetchLatest: async () => releaseFor(LATEST),
    sourceRoot: repoRoot,
    mcpTimeoutMs: 20_000,
    ...options,
  });
}

test("両ホストに最新の Release が入り、フックと MCP が動けば合格。ホームの中は何も書き換えない", async (t) => {
  const fixture = makeFixture(t);
  const before = treeDigest(fixture.home);
  const report = await accept(fixture);
  assert.equal(report.status, "pass", JSON.stringify(report.hosts, null, 2));
  assert.equal(report.latestRelease.version, LATEST);
  for (const host of ["claude", "codex"]) {
    for (const id of ["version", "enabled", "hooks", "mcp"]) {
      assert.equal(check(report, host, id)?.ok, true, `${host} の ${id}: ${check(report, host, id)?.detail}`);
    }
  }
  assert.deepEqual(check(report, "claude", "hooks").events, [...RELEASE_HOOK_EVENTS]);
  assert.deepEqual(check(report, "codex", "hooks").trust, trustFor("trusted"));
  assert.equal(check(report, "claude", "mcp").toolCount, 3, "ページ送りの2ページ目の道具も数える");
  const launches = mcpLaunches(fixture);
  assert.equal(launches.length, 1, "両ホストが同じ MCP の定義を指すときは1回だけ起動する");
  assert.equal(launches[0].noAutoOpen, "1");
  assert.notEqual(resolve(launches[0].projectDir), resolve(fixture.root, "operator-project"), "運営者の project で MCP を起動した");
  assert.ok(resolve(launches[0].projectDir).startsWith(resolve(realpathSync(tmpdir()))) || resolve(launches[0].projectDir).startsWith(resolve(tmpdir())), "project は一時フォルダ");
  assert.equal(existsSync(launches[0].projectDir), false, "一時の project を片付けていない");
  assert.equal(treeDigest(fixture.home), before, "受け入れ確認がホームの中を書き換えた");
});

test("古い版・Stop の無いフック・古い MCP の置き場を、それぞれ不合格として名指しする", async (t) => {
  const fixture = makeFixture(t, { claudeVersion: "9.0.0", serverVersion: "9.0.0", claudeHooks: withoutStop(expectedClaudeHooks) });
  const report = await accept(fixture);
  assert.equal(report.status, "fail");
  const version = check(report, "claude", "version");
  assert.equal(version.ok, false);
  assert.equal(version.status, "behind");
  assert.match(version.detail, /9\.1\.0 より古い 9\.0\.0/u);
  const hooks = check(report, "claude", "hooks");
  assert.equal(hooks.ok, false);
  assert.deepEqual(hooks.missingEvents, ["Stop"]);
  assert.match(hooks.fix, /update:now/u);
  // ホストの記録は最新でも、.mcp.json が古い置き場を指していれば古い MCP が動く。
  const codexMcp = check(report, "codex", "mcp");
  assert.equal(codexMcp.ok, false);
  assert.equal(codexMcp.status, "server-version-mismatch");
  assert.equal(codexMcp.serverVersion, "9.0.0");
  assert.equal(check(report, "codex", "version").ok, true, "Codex の記録と manifest は最新");
});

test("Codex の /hooks の信頼が無ければ hooks を落とし、信頼の直し方を出す", async (t) => {
  const fixture = makeFixture(t, { codexTrusted: false });
  const report = await accept(fixture, { skipMcp: true });
  const hooks = check(report, "codex", "hooks");
  assert.equal(hooks.ok, false);
  assert.deepEqual(hooks.trust, trustFor("untrusted"));
  assert.match(hooks.fix, /\/hooks/u);
  assert.equal(check(report, "claude", "hooks").ok, true, "Claude Code は信頼の手順なしで動く");
  assert.equal(report.status, "fail");
});

test("Claude Code の disableAllHooks と plugin の無効を落とす", async (t) => {
  const fixture = makeFixture(t, { disableAllHooks: true, claudeEnabled: false, withCodex: false });
  const report = await accept(fixture, { skipMcp: true });
  const hooks = check(report, "claude", "hooks");
  assert.equal(hooks.ok, false);
  assert.match(hooks.detail, /disableAllHooks/u);
  assert.match(hooks.detail, /有効でない/u);
  assert.equal(check(report, "claude", "enabled").status, "disabled");
});

test("フックの起動行が指す script が無い・読み込めない版を落とす", async (t) => {
  const fixture = makeFixture(t, { withCodex: false });
  const claudeRoot = join(fixture.home, ".claude", "plugins", "cache", "buzzassist", "buzzassist", LATEST);
  rmSync(join(claudeRoot, "scripts", "harness-stop-hook.mjs"));
  writeFile(join(claudeRoot, "scripts", "harness-learn-hook.mjs"), "import './missing-module.mjs';\n");
  const report = await accept(fixture, { skipMcp: true });
  const hooks = check(report, "claude", "hooks");
  assert.equal(hooks.ok, false);
  assert.deepEqual(hooks.missingScripts, ["Stop: scripts/harness-stop-hook.mjs"]);
  assert.equal(hooks.loadFailures.length, 1);
  assert.match(hooks.loadFailures[0], /harness-learn-hook\.mjs を読み込めない/u);
});

test("最新の Release を確かめられなければ合格にしない（未確定）", async (t) => {
  const fixture = makeFixture(t);
  const report = await accept(fixture, {
    skipMcp: true,
    fetchLatest: async () => { throw new Error("offline"); },
  });
  assert.equal(report.status, "incomplete");
  assert.equal(report.latestRelease.version, null);
  assert.equal(check(report, "claude", "version").ok, null);
  // --expected-version ならネットワークに出ずに比べる
  const offline = await accept(fixture, {
    skipMcp: true,
    expectedVersion: "v9.1.0",
    fetchLatest: async () => { throw new Error("呼んではいけない"); },
  });
  assert.equal(offline.latestRelease.source, "expected-version");
  assert.equal(check(offline, "claude", "version").ok, true);
  assert.equal(offline.status, "incomplete", "--skip-mcp の MCP は未確認なので合格にしない");
});

test("更新が走っている間は何も確かめない", async (t) => {
  const fixture = makeFixture(t);
  mkdirSync(join(fixture.home, ".buzzassist", "updater", "update.lock"), { recursive: true });
  let fetched = 0;
  const report = await accept(fixture, { fetchLatest: async () => { fetched += 1; return releaseFor(LATEST); } });
  assert.equal(report.status, "busy");
  assert.equal(fetched, 0);
  assert.equal(mcpLaunches(fixture).length, 0, "更新中に MCP を起動した");
});

test("MCP の置き場に依存が無く Release の展開先も無ければ、置き場へ npm install せず未確認にする", async (t) => {
  const fixture = makeFixture(t, { serverDeps: false, withCodex: false });
  const report = await accept(fixture);
  const mcp = check(report, "claude", "mcp");
  assert.equal(mcp.ok, null);
  assert.equal(mcp.status, "dependencies-missing");
  assert.equal(mcpLaunches(fixture).length, 0);
  assert.equal(existsSync(join(fixture.serverRoot, "node_modules")), false, "置き場に依存を入れた");
  assert.equal(report.status, "incomplete");
});

test("同じ版の Release の展開先に依存があれば、一時フォルダの写しにつないで MCP を確かめる", async (t) => {
  const fixture = makeFixture(t, { serverDeps: false, withCodex: false });
  const releaseSource = join(fixture.home, ".buzzassist", "releases", `v${LATEST}`, "source");
  writeFile(join(releaseSource, "package.json"), { name: "buzzassist-canvas-mcp", version: LATEST });
  for (const dependency of MCP_RUNTIME_DEPENDENCIES) mkdirSync(join(releaseSource, "node_modules", ...dependency.split("/")), { recursive: true });
  const report = await accept(fixture);
  const mcp = check(report, "claude", "mcp");
  assert.equal(mcp.ok, true, mcp.detail);
  assert.equal(mcp.mode, "link");
  const [launch] = mcpLaunches(fixture);
  assert.notEqual(resolve(launch.cwd), resolve(fixture.serverRoot), "写しではなく置き場で起動した");
  assert.equal(existsSync(join(fixture.serverRoot, "node_modules")), false, "置き場に依存を作った");
});

test("必須の道具が欠けた MCP を落とす", async (t) => {
  const fixture = makeFixture(t, { withCodex: false });
  const report = await accept(fixture, { env: { ...fixture.env, FAKE_MCP_TOOLS: "read_me,open_buzzassist_canvas" } });
  const mcp = check(report, "claude", "mcp");
  assert.equal(mcp.ok, false);
  assert.equal(mcp.status, "missing-tools");
  assert.deepEqual(mcp.missingTools, ["get_excalidraw_selection"]);
});

test("ホストの無い端末では対象外として出し、入っている方だけで判定する", async (t) => {
  const fixture = makeFixture(t, { withCodex: false });
  const report = await accept(fixture);
  const codex = report.hosts.find((entry) => entry.host === "codex");
  assert.equal(codex.skipped, true);
  assert.equal(codex.status, "host-absent");
  assert.equal(report.status, "pass");
  // ホストの置き場はあるのに BuzzAssist が入っていなければ落とす
  mkdirSync(join(fixture.home, ".codex"), { recursive: true });
  const missing = await accept(fixture, { skipMcp: true });
  assert.equal(check(missing, "codex", "version").status, "not-installed");
  assert.equal(missing.status, "fail");
});

test("CLI: 引数の誤りは 64、--help は何も確かめない、結果は終了コードで返す", async (t) => {
  assert.throws(() => parseAcceptanceArgs(["--hosts", "cursor"]), /未知のホスト/u);
  assert.throws(() => parseAcceptanceArgs(["--mcp-timeout-ms", "5"]), /1000 以上/u);
  const fixture = makeFixture(t, { withCodex: false });
  const capture = () => {
    let text = "";
    return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
  };
  const env = { ...fixture.env, BUZZASSIST_SETUP_HOME: fixture.home };
  const help = capture();
  assert.equal((await runReleaseAcceptanceCli(["--help"], { env, stdout: help, stderr: capture() })).exitCode, 0);
  assert.match(help.text, /受け入れ確認/u);
  const bad = capture();
  assert.equal((await runReleaseAcceptanceCli(["--nope"], { env, stdout: capture(), stderr: bad })).exitCode, 64);
  const out = capture();
  const result = await runReleaseAcceptanceCli(["--json", "--expected-version", LATEST], {
    env,
    stdout: out,
    stderr: capture(),
    fetchLatest: async () => { throw new Error("--expected-version なのにネットワークへ出た"); },
  });
  assert.equal(result.exitCode, 0, out.text);
  assert.equal(JSON.parse(out.text).status, "pass");
  const text = capture();
  const failing = await runReleaseAcceptanceCli(["--expected-version", "9.2.0", "--skip-mcp"], { env, stdout: text, stderr: capture() });
  assert.equal(failing.exitCode, 1);
  assert.match(text.text, /最新の Release 9\.2\.0 より古い 9\.1\.0/u);
  // --update-first は、走っている更新があれば更新器を呼ばずに止まる
  mkdirSync(join(fixture.home, ".buzzassist", "updater", "update.lock"), { recursive: true });
  let updaterCalls = 0;
  const busy = await runReleaseAcceptanceCli(["--update-first"], { env, stdout: capture(), stderr: capture(), runUpdater: async () => { updaterCalls += 1; return { code: 0 }; } });
  assert.equal(busy.exitCode, 3);
  assert.equal(updaterCalls, 0);
});

test("起動行の読み取りと Codex の信頼の鍵の形", () => {
  assert.deepEqual(hookCommandTarget(expectedClaudeHooks.hooks.Stop[0].hooks[0].command), { script: "harness-stop-hook.mjs", exportName: "" });
  assert.deepEqual(hookCommandTarget(expectedCodexHooks.hooks.UserPromptSubmit[0].hooks[0].command), { script: "harness-learn-hook.mjs", exportName: "runHookCli" });
  assert.equal(codexHookEventKey("UserPromptSubmit"), "user_prompt_submit");
  assert.equal(codexHookEventKey("Stop"), "stop");
});

test("doctor の release-currency: 古い版を知らせ、最新が分からなければ黙る", () => {
  const installs = [{ host: "claude", version: "9.0.0" }, { host: "codex", version: "9.1.0" }];
  const behind = probeReleaseCurrency({ installs, latestVersion: "9.1.0", updaterState: { status: "failed", lastError: "verify failed" } });
  assert.equal(behind.ok, false);
  assert.deepEqual(behind.behind, [{ host: "claude", version: "9.0.0" }]);
  assert.match(behind.detail, /前回の自動更新は失敗/u);
  assert.match(behind.fix, /release-acceptance/u);
  const silent = probeReleaseCurrency({ installs });
  assert.equal(silent.ok, true);
  assert.equal(silent.skipped, true);
  // 更新器の記録は3日以内に確かめたものだけ使う
  const now = Date.parse("2026-09-27T00:00:00Z");
  const fresh = probeReleaseCurrency({ installs, updaterState: { latestVersion: "9.1.0", lastCheckedAt: "2026-09-26T00:00:00Z" }, now });
  assert.equal(fresh.ok, false);
  assert.equal(fresh.latestSource, "updater-state");
  const stale = probeReleaseCurrency({ installs, updaterState: { latestVersion: "9.1.0", lastCheckedAt: "2026-09-01T00:00:00Z" }, now });
  assert.equal(stale.skipped, true);
  assert.equal(probeReleaseCurrency({ installs: [{ host: "claude", version: "9.1.0" }], latestVersion: "9.1.0" }).ok, true);
});

test("doctor に advisory の release-currency が出て、本番は止めない", async (t) => {
  const fixture = makeFixture(t, { claudeVersion: "9.0.0" });
  const binary = (command) => ({ ok: true, command, args: [], version: "7.1.1" });
  const report = await runHarnessDoctor({
    runtime: {
      homeDir: fixture.home,
      env: { PATH: process.env.PATH || "" },
      latestRelease: { version: LATEST, source: "test" },
      ffmpegToolchain: { ok: true, ffmpeg: binary("ffmpeg"), ffprobe: binary("ffprobe") },
      runCommand: async (_command, args = []) => {
        if (args.includes("-encoders")) return { stdout: "libx264 aac pcm_s24le", stderr: "" };
        if (args.includes("-filters")) return { stdout: "scale crop overlay fps loudnorm aresample", stderr: "" };
        if (args.includes("-show_streams")) return { stdout: JSON.stringify({ streams: [{ codec_type: "video" }, { codec_type: "audio" }] }), stderr: "" };
        return { stdout: "", stderr: "" };
      },
      pythonRuntime: { ok: true, command: "python", args: [], version: "3.12.2" },
      voiceQualityProbe: async () => true,
      diskFreeBytes: async () => 64 * 1024 ** 3,
      ttsProbe: async () => ({ ok: true, detail: "設定あり", fix: "" }),
      imageModel: "gpt-image-2-codex",
      imageHostProbe: async (model) => ({ ok: true, host: "codex", model, detail: `Codex / ${model}` }),
    },
  });
  const currency = report.checks.find((entry) => entry.id === "release-currency");
  assert.ok(currency, "release-currency の検査が無い");
  assert.equal(currency.required, false);
  assert.equal(currency.ok, false);
  assert.match(currency.detail, /claude 9\.0\.0/u);
  assert.ok(report.advisory.includes("release-currency"));
  assert.equal(report.blocking.includes("release-currency"), false, "古い版で本番を止めた");
  assert.ok(statSync(fixture.home).isDirectory());
});
