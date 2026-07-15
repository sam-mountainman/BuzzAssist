import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  compareVersions,
  mergeUpdaterConfig,
  normalizeUpdateHosts,
  releaseVersion,
  renderLaunchAgentPlist,
  renderWindowsUpdateRunner,
  safeReleaseDirectoryName,
} from "../lib/pluginAutoUpdate.mjs";

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
