import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  UPDATE_CHECK_MIN_INTERVAL_MS,
  compareVersions,
  detectInstalledBuzzAssistHosts,
  hostsBehindVersion,
  isUpdaterInstallInvocation,
  mergeUpdaterConfig,
  normalizeUpdateHosts,
  parseSetupInstallReport,
  recentCheckDecision,
  releaseVersion,
  renderLaunchAgentPlist,
  renderWindowsTaskXml,
  renderWindowsUpdateRunner,
  safeReleaseDirectoryName,
  schedulerPathEnv,
  unionUpdateHosts,
  windowsTaskXmlHasCatchUp,
} from "../lib/pluginAutoUpdate.mjs";
import { envWithNodeOnPath, resolveNpmInvocation } from "../lib/npmInvocation.mjs";

test("stable Release versions compare without accepting prerelease drift", () => {
  assert.equal(compareVersions("0.1.17", "0.1.16"), 1);
  assert.equal(compareVersions("v1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.10"), -1);
  assert.equal(safeReleaseDirectoryName("v0.2.23"), "v0.2.23");
});

test("auto updater accepts only stable GitHub API Release archives", () => {
  const release = {
    tag_name: "v0.2.23",
    draft: false,
    prerelease: false,
    zipball_url: "https://api.github.com/repos/sam-mountainman/BuzzAssist/zipball/v0.2.23",
  };
  assert.equal(releaseVersion(release), "0.2.23");
  assert.throws(() => releaseVersion({ ...release, prerelease: true }), /Prereleases/);
  assert.throws(() => releaseVersion({ ...release, zipball_url: "https://example.com/update.zip" }), /untrusted/);
});

test("Codex and Claude Code registrations merge without touching unrelated hosts", () => {
  const config = mergeUpdaterConfig(
    { hosts: ["codex"], projectDir: "/old/project" },
    { hosts: ["claude"], projectDir: "/new/project", pluginRoot: "/plugin" },
  );
  assert.deepEqual(config.hosts, ["codex", "claude"]);
  assert.deepEqual(normalizeUpdateHosts("both"), ["codex", "claude"]);
  assert.equal(config.projectDir, "/new/project");
  assert.equal(config.pluginRoot, "/plugin");
});

test("macOS and Windows schedules invoke the same stable updater without secrets", () => {
  const values = {
    nodePath: "/Applications/Node & Tools/node",
    updaterPath: "/Users/Test/plugins/buzzassist/plugin/scripts/update-current.mjs",
    configPath: "/Users/Test/.buzzassist/updater/config.json",
    logPath: "/Users/Test/.buzzassist/updater/update.log",
  };
  const plist = renderLaunchAgentPlist(values);
  assert.match(plist, /ai\.buzzassist\.plugin-updater/);
  assert.match(plist, /StartCalendarInterval/);
  assert.match(plist, /Node &amp; Tools/);
  assert.doesNotMatch(plist, /token|Authorization/i);

  const cmd = renderWindowsUpdateRunner({
    ...values,
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    updaterPath: "C:\\Users\\Test User\\plugins\\buzzassist\\plugin\\scripts\\update-current.mjs",
    configPath: "C:\\Users\\Test User\\.buzzassist\\updater\\config.json",
    logPath: "C:\\Users\\Test User\\.buzzassist\\updater\\update.log",
  });
  assert.match(cmd, /node\.exe" "C:\\Users\\Test User/);
  assert.match(cmd, /--scheduled --config/);
  assert.doesNotMatch(cmd, /token|Authorization/i);
});

test("setup and updater ship the rollback and MCP smoke-verification path", async () => {
  const setup = await readFile(new URL("../scripts/setup-agents.mjs", import.meta.url), "utf8");
  const updater = await readFile(new URL("../scripts/update-current.mjs", import.meta.url), "utf8");
  const verifier = await readFile(new URL("../scripts/verify-plugin-runtime.mjs", import.meta.url), "utf8");
  assert.match(setup, /--no-auto-update/);
  assert.match(setup, /Registering safe automatic updates/);
  assert.match(updater, /createBackup/);
  assert.match(updater, /restoreBackup/);
  assert.match(updater, /BUZZASSIST_HOST_RESTART_REQUIRED=yes/);
  assert.match(verifier, /client\.callTool\(\{ name: "read_me"/);
});

test("the updater passes the harness-not-ready override and keeps the MCP verification mandatory", async () => {
  const updater = await readFile(new URL("../scripts/update-current.mjs", import.meta.url), "utf8");
  assert.match(updater, /"--allow-harness-not-ready"/u);
  assert.match(updater, /\[UPDATER_INSTALL_ENV\]: "1"/u);
  // 前提の欠けで止めない代わりに、導入後の MCP 実呼び出し検証は外さない。
  assert.match(updater, /logInstallWarnings\(result\.report\);\n\s*await verifyRuntime\(/u);
});

test("導入後の検証には、依存を入れた Release の展開先を渡し、写しで npm install にまわっても収まる上限にする", async () => {
  // 置き場（config.pluginRoot）は依存なしで配る。検証はそこへ node_modules を作らず、写しに
  // Release の展開先の依存をつなぐ（scripts/verify-plugin-runtime.mjs）。
  const updater = await readFile(new URL("../scripts/update-current.mjs", import.meta.url), "utf8");
  assert.match(updater, /await verifyRuntime\(config\.pluginRoot, config\.projectDir, config\.canvasDir, \{ depsRoot: sourceDir \}\);/u);
  assert.match(updater, /\.\.\.\(depsRoot \? \["--deps-root", depsRoot\] : \[\]\)/u);
  assert.match(updater, /timeoutMs: VERIFY_RUNTIME_TIMEOUT_MS/u);
});

test("setup-agents recognizes both the new and the already-deployed updater invocations, and nothing else", () => {
  const legacyArgs = ["--agents", "claude", "--project-dir", "/p", "--canvas-dir", "/p/canvas", "--skip-install", "--skip-build", "--no-launch", "--no-auto-update"];
  assert.deepEqual(isUpdaterInstallInvocation({ argv: ["--agents", "claude"], env: { BUZZASSIST_UPDATER_INSTALL: "1" } }), { updater: true, signal: "env" });
  assert.deepEqual(
    isUpdaterInstallInvocation({ argv: legacyArgs, env: { BUZZASSIST_AUTO_UPDATE_SKIP_REGISTER: "1" } }),
    { updater: true, signal: "legacy-updater-arguments" },
  );
  // 対話の setup（--agent 1つ、SKIP_REGISTER なし）は更新器ではない。
  assert.equal(isUpdaterInstallInvocation({ argv: legacyArgs, env: {} }).updater, false);
  assert.equal(isUpdaterInstallInvocation({ argv: ["--agent", "claude", "--no-auto-update"], env: { BUZZASSIST_AUTO_UPDATE_SKIP_REGISTER: "1" } }).updater, false);
  assert.equal(isUpdaterInstallInvocation({ argv: [], env: { BUZZASSIST_UPDATER_INSTALL: "0" } }).updater, false);
});

test("scheduled checks short-circuit for 20 hours after a completed check, manual and explicit runs never do", () => {
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  const recent = { lastCompletedCheckAt: "2026-09-24T03:17:00.000Z", lastCheckedAt: "2026-09-24T03:17:00.000Z" };
  assert.equal(UPDATE_CHECK_MIN_INTERVAL_MS, 20 * 60 * 60 * 1000);
  assert.equal(recentCheckDecision({ state: recent, now, scheduled: true }).skip, true);
  assert.equal(recentCheckDecision({ state: recent, now, scheduled: false }).skip, false, "manual run");
  assert.equal(recentCheckDecision({ state: recent, now, scheduled: true, force: true }).skip, false, "--force");
  assert.equal(recentCheckDecision({ state: recent, now, scheduled: true, noThrottle: true }).skip, false, "--no-throttle");
  const old = { lastCompletedCheckAt: "2026-09-23T15:59:00.000Z" };
  assert.equal(recentCheckDecision({ state: old, now, scheduled: true }).skip, false, "older than 20h");
  // 失敗した回は lastCompletedCheckAt を進めないので、次の定刻起動で再試行する。
  assert.equal(recentCheckDecision({ state: { lastCheckedAt: "2026-09-24T11:00:00.000Z", status: "failed" }, now, scheduled: true }).skip, false);
  assert.equal(recentCheckDecision({ state: { lastCompletedCheckAt: "2026-09-25T00:00:00.000Z" }, now, scheduled: true }).skip, false, "clock skew");
});

test("setup output from the updater becomes warnings, not a failure", () => {
  const report = parseSetupInstallReport([
    "BUZZASSIST_HARNESS_READY=no",
    "BUZZASSIST_HARNESS_BLOCKING=ffmpeg,voice-quality-python",
    "BUZZASSIST_HARNESS_READY_OVERRIDE=updater-install",
    "BUZZASSIST_HOST_SKIPPED=codex",
    "Claude Code: configured",
  ].join("\n"));
  assert.equal(report.harnessReady, "no");
  assert.deepEqual(report.blocking, ["ffmpeg", "voice-quality-python"]);
  assert.equal(report.harnessOverride, "updater-install");
  assert.deepEqual(report.warnings, ["harness-not-ready:no:ffmpeg,voice-quality-python", "host-skipped:codex"]);
  assert.deepEqual(parseSetupInstallReport("BUZZASSIST_HARNESS_READY=yes\n").warnings, []);
  assert.deepEqual(parseSetupInstallReport("").warnings, ["harness-not-ready:unreported"]);
});

test("installed BuzzAssist hosts are detected from each host's own records and merged into the update hosts", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "buzzassist-installed-hosts-"));
  try {
    assert.deepEqual(detectInstalledBuzzAssistHosts({ homeDir }), []);
    await mkdir(join(homeDir, ".claude", "plugins"), { recursive: true });
    await writeFile(join(homeDir, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: { "buzzassist@buzzassist": [{ scope: "user", installPath: join(homeDir, "cache"), version: "0.1.25" }] },
    }));
    assert.deepEqual(detectInstalledBuzzAssistHosts({ homeDir }), ["claude"]);
    await mkdir(join(homeDir, ".codex", "plugins", "cache", "buzzassist", "buzzassist", "0.1.25"), { recursive: true });
    assert.deepEqual(detectInstalledBuzzAssistHosts({ homeDir }), ["codex", "claude"]);
    // 別の plugin だけが入っている Claude Code は対象外。
    await writeFile(join(homeDir, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "other@market": [{}] } }));
    assert.deepEqual(detectInstalledBuzzAssistHosts({ homeDir }), ["codex"]);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
  assert.deepEqual(unionUpdateHosts(["claude"], ["codex", "claude"], "codex,cursor"), ["claude", "codex"]);
  assert.deepEqual(unionUpdateHosts([], "", undefined), []);
});

test("host plugin caches behind the managed version are found; unknown versions are left alone", () => {
  const installs = [
    { host: "claude", version: "0.1.25" },
    { host: "codex", version: "0.1.26" },
  ];
  assert.deepEqual(hostsBehindVersion({ installs, hosts: ["claude", "codex"], version: "0.1.26" }), [{ host: "claude", version: "0.1.25" }]);
  assert.deepEqual(hostsBehindVersion({ installs, hosts: ["codex"], version: "0.1.26" }), [], "only registered hosts");
  assert.deepEqual(hostsBehindVersion({ installs: [{ host: "claude", version: "" }], hosts: ["claude"], version: "0.1.26" }), []);
});

test("scheduler PATH keeps the registering shell's order and adds the Node and usual CLI locations without relative entries", () => {
  const value = schedulerPathEnv({
    nodePath: "/Users/Test/.buzzassist/tools/node/node-v22/bin/node",
    env: { PATH: "/opt/tools/bin:relative/bin:/usr/bin" },
    platform: "darwin",
    homeDir: "/Users/Test",
  });
  const parts = value.split(":");
  // 対話で使っている claude / codex と同じものが選ばれるよう、シェルの PATH が先。
  assert.deepEqual(parts.slice(0, 3), ["/opt/tools/bin", "/usr/bin", "/Users/Test/.buzzassist/tools/node/node-v22/bin"]);
  assert.ok(parts.includes("/Users/Test/.local/bin"), "Claude Code native installer location");
  assert.ok(parts.includes("/opt/homebrew/bin"));
  assert.equal(parts.includes("relative/bin"), false);
  assert.equal(new Set(parts).size, parts.length);
  const windows = schedulerPathEnv({ nodePath: "C:\\Tools\\node\\node.exe", env: { Path: "C:\\Windows;C:\\Tools\\node" }, platform: "win32" });
  assert.equal(windows, "C:\\Windows;C:\\Tools\\node");
  // launchd の最小 PATH（env が空）でも、登録した Node の置き場所は必ず入る。
  assert.equal(schedulerPathEnv({ nodePath: "/n/bin/node", env: {}, platform: "linux" }).split(":")[0], "/n/bin");
});

test("the launchd agent catches up at login and the Windows task runs after a missed start", () => {
  const plist = renderLaunchAgentPlist({
    nodePath: "/n/node", updaterPath: "/u.mjs", configPath: "/c.json", logPath: "/l.log", pathEnv: "/n:/usr/bin",
  });
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/u);
  assert.match(plist, /<key>PATH<\/key><string>\/n:\/usr\/bin<\/string>/u);
  assert.doesNotMatch(renderLaunchAgentPlist({ nodePath: "/n", updaterPath: "/u", configPath: "/c", logPath: "/l" }), /EnvironmentVariables/u);
  const xml = renderWindowsTaskXml({ runnerPath: "C:\\Users\\A & B\\run-update.cmd", startDate: "2026-09-24" });
  assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/u);
  assert.match(xml, /<StartBoundary>2026-09-24T03:17:00<\/StartBoundary>/u);
  assert.match(xml, /A &amp; B/u);
  assert.equal(windowsTaskXmlHasCatchUp(xml), true);
  assert.equal(windowsTaskXmlHasCatchUp(xml.replace("<StartWhenAvailable>true", "<StartWhenAvailable>false")), false);
  assert.throws(() => renderWindowsTaskXml({ runnerPath: "x", startDate: "24/09/2026" }), /start date/u);
});

test("npm runs through the npm-cli.js bundled with the running Node, with that Node first on PATH", () => {
  const unix = resolveNpmInvocation({
    execPath: "/opt/node/bin/node",
    platform: "linux",
    exists: (candidate) => candidate === "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
  });
  assert.deepEqual(unix, { command: "/opt/node/bin/node", args: ["/opt/node/lib/node_modules/npm/bin/npm-cli.js"], shell: false, source: "bundled-npm-cli" });
  const windows = resolveNpmInvocation({
    execPath: "C:\\node\\node.exe",
    platform: "win32",
    exists: (candidate) => candidate === "C:\\node\\node_modules\\npm\\bin\\npm-cli.js",
  });
  assert.equal(windows.command, "C:\\node\\node.exe");
  assert.equal(windows.shell, false);
  assert.equal(resolveNpmInvocation({ execPath: "/x/node", platform: "darwin", exists: () => false }).command, "npm");
  assert.equal(resolveNpmInvocation({ execPath: "C:\\x\\node.exe", platform: "win32", exists: () => false }).command, "npm.cmd");
  assert.equal(envWithNodeOnPath({ PATH: "/usr/bin" }, { execPath: "/opt/node/bin/node", platform: "linux" }).PATH, "/opt/node/bin:/usr/bin");
  const merged = envWithNodeOnPath({ Path: "C:\\A", PATH: "C:\\B" }, { execPath: "C:\\node\\node.exe", platform: "win32" });
  assert.equal(merged.Path, "C:\\node;C:\\A;C:\\B");
  assert.equal(Object.hasOwn(merged, "PATH"), false);
});
