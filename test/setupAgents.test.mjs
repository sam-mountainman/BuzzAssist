import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  MINIMUM_NODE_MAJOR,
  assertSupportedNodeVersion,
  claudeDesktopConfigPathForPlatform,
  commandNameForPlatform,
  resolveHostCommandForPlatform,
  detectSetupAgent,
  normalizeSetupAgentName,
} from "../lib/setupAgents.mjs";

const execFile = promisify(execFileCallback);

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

test("Windows host commands resolve to the native claude.exe before a claude.cmd shim, in PATH order", () => {
  const present = new Set([
    "C:\\Users\\Op\\.local\\bin\\claude.exe",
    "C:\\npm\\claude.cmd",
    "C:\\npm\\codex.cmd",
  ]);
  const exists = (candidate) => present.has(candidate);
  // ネイティブインストーラの claude.exe は PATH の ~/.local/bin にある（PATH に無くても探す）。
  assert.equal(
    resolveHostCommandForPlatform("claude", { platform: "win32", env: { Path: "C:\\Windows;C:\\Users\\Op\\.local\\bin", USERPROFILE: "C:\\Users\\Op" }, exists }),
    "C:\\Users\\Op\\.local\\bin\\claude.exe",
  );
  assert.equal(
    resolveHostCommandForPlatform("claude", { platform: "win32", env: { Path: "C:\\npm;C:\\Users\\Op\\.local\\bin", USERPROFILE: "C:\\Users\\Op" }, exists }),
    "C:\\npm\\claude.cmd",
    "the first PATH directory wins, as in Windows itself",
  );
  assert.equal(
    resolveHostCommandForPlatform("claude", { platform: "win32", env: { Path: "C:\\Windows", USERPROFILE: "C:\\Users\\Op" }, exists }),
    "C:\\Users\\Op\\.local\\bin\\claude.exe",
    "the native installer location is found even when it is missing from PATH",
  );
  assert.equal(resolveHostCommandForPlatform("codex", { platform: "win32", env: { PATH: "C:\\npm" }, exists }), "C:\\npm\\codex.cmd");
  assert.equal(resolveHostCommandForPlatform("claude", { platform: "win32", env: { PATH: "" }, exists: () => false }), "claude.cmd");
  assert.equal(resolveHostCommandForPlatform("claude", { platform: "darwin", env: {}, exists }), "claude");
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
    "excalidraw-speech-bubbles",
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

test("plugin staging ships the public learning catalog, never the full proposals ledger", async () => {
  // 2026-09-05 独立レビュー D-2: setup-agents が本文つきの
  // docs/learning/proposals.jsonl を plugin へコピーしていた。共有層宛でも
  // evidence に顧客識別子・端末 path が残るので、配布するのは
  // harness-curator export-public が作る proposals.public.jsonl だけ。
  const source = await readFile(new URL("../scripts/setup-agents.mjs", import.meta.url), "utf8");
  assert.match(source, /"docs\/learning\/proposals\.public\.jsonl"/u);
  assert.doesNotMatch(source, /"docs\/learning\/proposals\.jsonl"/u, "本文つき台帳がコピー一覧に残っている");
  assert.doesNotMatch(source, /"docs\/learning\/applied\.jsonl"/u);
});

test("配布物へのコピーは、Windows の名前空間つきパスでも許可していない設定ファイルを入れない", async () => {
  // Node 20 の fs.cp は、Windows で filter に "\\?\D:\..." 形式のパスを渡す。リポジトリの
  // ルートとの前方一致で見ていたので一致せず、skip や公開面の許可リストまで配布物へ入り、
  // 同梱物の検査がセットアップを止めた（Windows の CI、Node 20 だけ）。
  const { win32 } = await import("node:path");
  const { isChannelPackPath } = await import("../scripts/setup-agents.mjs");
  const root = "D:\\a\\BuzzAssist\\BuzzAssist";
  for (const [source, excluded] of [
    ["D:\\a\\BuzzAssist\\BuzzAssist\\config\\ci-test-skip-allowlist.json", true],
    ["\\\\?\\D:\\a\\BuzzAssist\\BuzzAssist\\config\\ci-test-skip-allowlist.json", true],
    ["\\\\?\\D:\\a\\BuzzAssist\\BuzzAssist\\config\\public-surface-allowlist.json", true],
    ["\\\\?\\D:\\a\\BuzzAssist\\BuzzAssist\\config\\harnesses\\koya-manga-video.harness.json", false],
    ["\\\\?\\D:\\a\\BuzzAssist\\BuzzAssist\\config", false],
    ["\\\\?\\D:\\a\\BuzzAssist\\BuzzAssist\\lib\\narratedStoryPipeline.mjs", false],
    ["d:\\a\\buzzassist\\BuzzAssist\\config\\public-surface-allowlist.json", true],
    ["\\\\?\\D:\\a\\BuzzAssist\\BuzzAssist\\docs\\learning\\proposals.jsonl", true],
  ]) {
    assert.equal(isChannelPackPath(source, root, win32), excluded, source);
  }
  assert.equal(isChannelPackPath("/repo/config/ci-test-skip-allowlist.json", "/repo"), true);
  assert.equal(isChannelPackPath("/repo/config/harnesses", "/repo"), false);
  assert.equal(isChannelPackPath("/elsewhere/config/ci-test-skip-allowlist.json", "/repo"), false, "リポジトリの外は config 規則の対象外");
});

test("staged plugin verification rejects a tree that contains the full proposals ledger", async () => {
  // コピー一覧を直しても、誰かが書き戻せば同じ穴が開く。staging 検査が
  // fail-closed に止めることを、実際の一時ディレクトリで確かめる。
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { verifyStagedPluginContents } = await import("../scripts/setup-agents.mjs");
  const stagedRoot = await mkdtemp(join(tmpdir(), "buzzassist-staged-learning-"));
  try {
    for (const relative of [
      "package.json",
      "package-lock.json",
      ".mcp.json",
      ".codex-plugin/plugin.json",
      ".claude-plugin/plugin.json",
      "mcp/server.mjs",
      "config/harness-deployments.example.json",
      "lib/harnessDeploymentResolver.mjs",
      "lib/mcpClientSdk.mjs",
      "lib/narratedStoryBookends.mjs",
      "lib/narratedStoryOutcome.mjs",
      "lib/narratedStoryPipeline.mjs",
      "lib/narratedStoryVideo.mjs",
      "lib/pluginRuntimeDependencies.mjs",
      "scripts/narrated-story-video.mjs",
      "scripts/start-mcp.mjs",
      "scripts/verify-plugin-runtime.mjs",
      "docs/learning/targets.json",
      "docs/learning/proposals.public.jsonl",
    ]) {
      const target = join(stagedRoot, relative);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, relative.endsWith(".json") ? "{}\n" : "");
    }
    const clean = await verifyStagedPluginContents(stagedRoot);
    assert.equal(clean.ok, true, "公開 catalog だけの tree は通ること");

    await writeFile(join(stagedRoot, "docs", "learning", "proposals.jsonl"), "{\"text\":\"本文\"}\n");
    await assert.rejects(
      verifyStagedPluginContents(stagedRoot),
      /Forbidden path entered staged BuzzAssist plugin: docs[\\/]learning[\\/]proposals\.jsonl/u,
      "本文つき台帳が staged tree に入っても検査が通った",
    );
    await rm(join(stagedRoot, "docs", "learning", "proposals.jsonl"));

    await writeFile(join(stagedRoot, "docs", "learning", "applied.jsonl"), "{}\n");
    await assert.rejects(verifyStagedPluginContents(stagedRoot), /Forbidden path/u);
  } finally {
    await rm(stagedRoot, { recursive: true, force: true });
  }
});

test("plugin refresh preserves active process working directories", async () => {
  const source = await readFile(new URL("../scripts/setup-agents.mjs", import.meta.url), "utf8");
  assert.match(source, /replaceDirectoryChildrenPreservingRoot\(tmpPluginRoot, managedPluginRoot\)/);
  assert.doesNotMatch(source, /rm\(managedPluginDir, \{ recursive: true/);
  assert.doesNotMatch(source, /\["plugin", "remove", codexSelector\]/);
  assert.match(source, /claudeInstalled \? "update" : "install"/);
});

test("importing setup exports never executes setup or writes a plugin root", async () => {
  const isolatedHome = await mkdtemp(join(tmpdir(), "buzzassist-setup-import-"));
  const moduleUrl = new URL("../scripts/setup-agents.mjs", import.meta.url).href;
  const source = [
    "process.argv.push('--agent','codex','--skip-install','--skip-build','--no-launch')",
    `const loaded = await import(${JSON.stringify(moduleUrl)})`,
    "if (typeof loaded.runSetupAgents !== 'function' || typeof loaded.verifyStagedPluginContents !== 'function') process.exit(7)",
    "console.log('IMPORT_OK')",
  ].join(";");
  try {
    const { stdout, stderr } = await execFile(process.execPath, ["--input-type=module", "--eval", source], {
      env: {
        ...process.env,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        BUZZASSIST_SETUP_HOME: isolatedHome,
      },
      timeout: 30_000,
    });
    assert.equal(stdout.trim(), "IMPORT_OK");
    assert.equal(stderr.trim(), "");
    await assert.rejects(access(join(isolatedHome, "plugins", "buzzassist")), { code: "ENOENT" });
  } finally {
    await rm(isolatedHome, { recursive: true, force: true });
  }
});

test("R6-F2: MCP server configs name the reviewer trust env vars for host passthrough and never embed their values", async () => {
  const {
    REVIEWER_TRUST_ENV_PASSTHROUGH,
    REVIEWER_TRUST_PASSTHROUGH_NOTE,
    reviewerTrustEnvStatus,
    withReviewerTrustEnvPassthrough,
  } = await import("../scripts/setup-agents.mjs");
  assert.deepEqual([...REVIEWER_TRUST_ENV_PASSTHROUGH], [
    "BUZZASSIST_REVIEWER_TRUST",
    "BUZZASSIST_REVIEWER_TRUST_JSON",
    "BUZZASSIST_KOYA_REVIEWER_TRUST",
    "BUZZASSIST_KOYA_REVIEWER_TRUST_JSON",
  ], "新名と互換の旧名を両方通す（片方だけ通すと CLI と MCP で見える env が食い違う）");

  const base = { command: "/usr/bin/node", args: ["/plugin/scripts/start-mcp.mjs"], env: { EXCALIDRAW_PROJECT_DIR: "/p" } };
  const config = withReviewerTrustEnvPassthrough(base);
  assert.deepEqual(config.env_vars, [...REVIEWER_TRUST_ENV_PASSTHROUGH], "Codex 形式の env_vars に env 名だけを載せる");
  assert.deepEqual(config.env, { EXCALIDRAW_PROJECT_DIR: "/p" }, "env の値は増やさない（Claude Code は process env を継承する）");
  assert.equal(base.env_vars, undefined, "入力を書き換えない");
  const merged = withReviewerTrustEnvPassthrough({ ...base, env_vars: ["OTHER", "BUZZASSIST_REVIEWER_TRUST"] });
  assert.deepEqual(merged.env_vars, ["OTHER", ...REVIEWER_TRUST_ENV_PASSTHROUGH], "既存 env_vars は保持し重複させない");
  assert.match(REVIEWER_TRUST_PASSTHROUGH_NOTE, /never stores their values/u);
  assert.match(REVIEWER_TRUST_PASSTHROUGH_NOTE, /shell\/launcher that starts Codex or Claude Code/u);

  // 値・path・本文・鍵を設定ファイルへ書く経路は fail-closed。
  for (const name of REVIEWER_TRUST_ENV_PASSTHROUGH) {
    assert.throws(
      () => withReviewerTrustEnvPassthrough({ ...base, env: { ...base.env, [name]: "/secure/trust.json" } }),
      /^Error: reviewer-trust-in-config: MCP server config must not embed/u,
      name,
    );
  }
  assert.throws(
    () => withReviewerTrustEnvPassthrough({ ...base, note: '{"version":"koya-reviewer-trust-v1","reviewers":[]}' }),
    /reviewer-trust-in-config: .*trust-list or key material/u,
  );
  assert.throws(
    () => withReviewerTrustEnvPassthrough({ ...base, env: { ...base.env, X: "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----" } }),
    /reviewer-trust-in-config/u,
  );

  // 起動シェルの状態は値を印字せずに yes / no / ambiguous で報告する。
  assert.deepEqual(reviewerTrustEnvStatus({}), { configured: "no", source: "none" });
  assert.deepEqual(reviewerTrustEnvStatus({ BUZZASSIST_REVIEWER_TRUST: "/secure/trust.json" }), { configured: "yes", source: "path" });
  assert.deepEqual(reviewerTrustEnvStatus({ BUZZASSIST_KOYA_REVIEWER_TRUST: "/secure/trust.json" }), { configured: "yes", source: "path" });
  assert.deepEqual(reviewerTrustEnvStatus({ BUZZASSIST_REVIEWER_TRUST_JSON: "{}" }), { configured: "yes", source: "inline-json" });
  const ambiguous = reviewerTrustEnvStatus({ BUZZASSIST_REVIEWER_TRUST: "/a.json", BUZZASSIST_KOYA_REVIEWER_TRUST: "/b.json" });
  assert.equal(ambiguous.configured, "ambiguous");
  assert.doesNotMatch(JSON.stringify(ambiguous), /\/a\.json|\/b\.json/u, "報告に path の値を載せない");
});

test("setup trusts auto-update enabled output only with a verified concrete scheduler", async () => {
  const { parseAutoUpdateRegistrationOutput } = await import("../scripts/setup-agents.mjs");
  const verified = parseAutoUpdateRegistrationOutput([
    "BUZZASSIST_AUTO_UPDATE=enabled",
    "BUZZASSIST_AUTO_UPDATE_SCHEDULER=systemd-user",
    "BUZZASSIST_AUTO_UPDATE_SCHEDULER_CHECK=ok",
    "BUZZASSIST_AUTO_UPDATE_SCHEDULE=daily-03:17-local-time",
  ].join("\n"));
  assert.equal(verified.enabled, true);

  const unverified = parseAutoUpdateRegistrationOutput([
    "BUZZASSIST_AUTO_UPDATE=enabled",
    "BUZZASSIST_AUTO_UPDATE_SCHEDULER=systemd-user",
    "BUZZASSIST_AUTO_UPDATE_SCHEDULE=daily-03:17-local-time",
  ].join("\n"));
  assert.equal(unverified.enabled, false, "missing scheduler verification must fail closed");

  const manual = parseAutoUpdateRegistrationOutput([
    "BUZZASSIST_AUTO_UPDATE=manual",
    "BUZZASSIST_AUTO_UPDATE_SCHEDULER=systemd-user",
    "BUZZASSIST_AUTO_UPDATE_SCHEDULER_CHECK=manual",
    "BUZZASSIST_AUTO_UPDATE_SCHEDULE=manual",
  ].join("\n"));
  assert.equal(manual.enabled, false);
  assert.equal(manual.manual, true);
});
