import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MINIMUM_NODE_MAJOR,
  assertSupportedNodeVersion,
  claudeDesktopConfigPathForPlatform,
  commandNameForPlatform,
  detectSetupAgent,
  normalizeSetupAgentName,
} from "../lib/setupAgents.mjs";

test("setup agent aliases resolve to exactly one intended host", () => {
  assert.equal(normalizeSetupAgentName("codex"), "codex");
  assert.equal(normalizeSetupAgentName("Claude Code"), "claude");
  assert.equal(normalizeSetupAgentName("claude-desktop-app"), "claude-desktop");
  assert.equal(normalizeSetupAgentName("auto"), null);
  assert.throws(() => normalizeSetupAgentName("unknown-host"), /Unsupported agent/);
});

test("host detection prefers explicit BuzzAssist hint over ambient shell markers", () => {
  assert.equal(detectSetupAgent({ env: { BUZZASSIST_SETUP_AGENT: "claude", CODEX: "1" }, argv: [] }), "claude");
  assert.equal(detectSetupAgent({ env: { BUZZASSIST_SETUP_AGENT: "codex", CLAUDE_CODE: "1" }, argv: [] }), "codex");
  assert.equal(detectSetupAgent({ env: { CLAUDE_CODE: "1" }, argv: [] }), "claude");
  assert.equal(detectSetupAgent({ env: { CODEX_THREAD_ID: "thread" }, argv: [] }), "codex");
});

test("platform helpers produce macOS and Windows host paths", () => {
  assert.equal(commandNameForPlatform("claude", "darwin"), "claude");
  assert.equal(commandNameForPlatform("claude", "win32"), "claude.cmd");
  assert.equal(
    claudeDesktopConfigPathForPlatform({ homeDir: "/Users/test", platform: "darwin", env: {} }),
    "/Users/test/Library/Application Support/Claude/claude_desktop_config.json",
  );
  assert.equal(
    claudeDesktopConfigPathForPlatform({
      homeDir: "C:\\Users\\test",
      platform: "win32",
      env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming" },
    }),
    "C:\\Users\\test\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
  );
});

test(`setup rejects Node versions older than ${MINIMUM_NODE_MAJOR}`, () => {
  assert.equal(assertSupportedNodeVersion(`${MINIMUM_NODE_MAJOR}.0.0`), MINIMUM_NODE_MAJOR);
  assert.throws(() => assertSupportedNodeVersion("18.20.0"), /requires Node\.js 20 or newer/);
});

test("repository instructions bind Codex and Claude Code to their own setup target", async () => {
  const [agents, claude, readme] = await Promise.all([
    readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
    readFile(new URL("../CLAUDE.md", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
  ]);
  assert.match(agents, /setup-agents\.mjs --agent codex/);
  assert.doesNotMatch(agents, /setup-agents\.mjs --agent claude --project-dir/);
  assert.match(claude, /setup-agents\.mjs --agent claude/);
  assert.doesNotMatch(claude, /setup-agents\.mjs --agent codex --project-dir/);
  assert.match(readme, /https:\/\/github\.com\/sam-mountainman\/BuzzAssist/);
  assert.match(readme, /macOS でも Windows でも使えます/);
  assert.match(readme, /<現在のプロジェクト>\/canvas\/assets/);
  assert.match(readme, /open_buzzassist_canvas/);
});

test("all canvas skills bind tool calls to the current host project", async () => {
  const skillNames = [
    "excalidraw-open-canvas",
    "excalidraw-image-gen",
    "excalidraw-video-gen",
    "excalidraw-subtitle-gen",
    "excalidraw-silence-cut",
    "excalidraw-official-mcp",
  ];
  for (const skillName of skillNames) {
    const source = await readFile(new URL(`../skills/${skillName}/SKILL.md`, import.meta.url), "utf8");
    assert.match(source, /current/i, `${skillName} must identify the current project`);
    assert.match(source, /projectDir/, `${skillName} must pass projectDir`);
  }
});

test("all distributable host manifests use the package version", async () => {
  const paths = [
    "../package.json",
    "../.codex-plugin/plugin.json",
    "../.claude-plugin/plugin.json",
    "../.antigravity-plugin/plugin.json",
  ];
  const manifests = await Promise.all(
    paths.map(async (relativePath) => JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"))),
  );
  const version = manifests[0].version;
  assert.ok(/^\d+\.\d+\.\d+$/.test(version));
  for (const manifest of manifests.slice(1)) assert.equal(manifest.version, version);

  const marketplace = JSON.parse(
    await readFile(new URL("../.claude-plugin/marketplace.json", import.meta.url), "utf8"),
  );
  assert.equal(marketplace.plugins.find((plugin) => plugin.name === "buzzassist")?.version, version);
});
