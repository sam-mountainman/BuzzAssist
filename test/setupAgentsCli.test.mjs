import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function runSetup(agent, envOverrides = {}) {
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/setup-agents.mjs",
    "--dry-run",
    "--skip-install",
    "--skip-build",
    "--skip-plugin-source",
    "--no-launch",
    "--allow-harness-not-ready",
    "--agent",
    agent,
    "--project-dir",
    `/tmp/buzzassist-${agent}-test`,
  ], { cwd: repoRoot, env: { ...process.env, ...envOverrides } });
  return stdout;
}

// reviewer 信頼リスト env をこのテスト自身の環境から消した状態（値は一切渡さない）。
const NO_REVIEWER_TRUST_ENV = {
  BUZZASSIST_REVIEWER_TRUST: "",
  BUZZASSIST_REVIEWER_TRUST_JSON: "",
  BUZZASSIST_KOYA_REVIEWER_TRUST: "",
  BUZZASSIST_KOYA_REVIEWER_TRUST_JSON: "",
};

async function runSetupWithTunnel(agent) {
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/setup-agents.mjs",
    "--dry-run",
    "--skip-install",
    "--skip-build",
    "--skip-plugin-source",
    "--agent",
    agent,
    "--project-dir",
    `/tmp/buzzassist-${agent}-tunnel-test`,
    "--tunnel",
    "--allow-harness-not-ready",
  ], { cwd: repoRoot });
  return stdout;
}

test("setup CLI configures only Cursor when --agent cursor is used", async () => {
  const stdout = await runSetup("cursor");
  assert.match(stdout, /Agent target: Cursor/);
  assert.match(stdout, /Codex: not touched/);
  assert.match(stdout, /Claude Desktop: not touched/);
  assert.match(stdout, /Claude Code: not touched/);
  assert.match(stdout, /Cursor: configured/);
  assert.match(stdout, /Antigravity: not touched/);
});

test("setup dry-run describes auto-update as planned without claiming a registered daily scheduler", async () => {
  const stdout = await runSetup("codex");
  assert.match(stdout, /BUZZASSIST_AUTO_UPDATE=planned/u);
  assert.match(stdout, /BUZZASSIST_AUTO_UPDATE_SCHEDULE=not-registered-dry-run/u);
  assert.doesNotMatch(stdout, /BUZZASSIST_AUTO_UPDATE=enabled/u);
  assert.doesNotMatch(stdout, /Stable GitHub Releases are checked daily/u);
});

test("R6-F2: setup reports the reviewer trust passthrough as env names only and never prints the operator's value", async () => {
  const sentinel = "/secure/operator-only/reviewer-trust-sentinel-9f3c.json";
  for (const agent of ["codex", "claude"]) {
    const unset = await runSetup(agent, NO_REVIEWER_TRUST_ENV);
    assert.match(unset, /BUZZASSIST_REVIEWER_TRUST_PASSTHROUGH=env-name-only/u);
    assert.match(unset, /BUZZASSIST_REVIEWER_TRUST_ENV_VARS=BUZZASSIST_REVIEWER_TRUST,BUZZASSIST_REVIEWER_TRUST_JSON,BUZZASSIST_KOYA_REVIEWER_TRUST,BUZZASSIST_KOYA_REVIEWER_TRUST_JSON/u);
    assert.match(unset, /BUZZASSIST_REVIEWER_TRUST_CONFIGURED=no/u);
    assert.match(unset, /BUZZASSIST_REVIEWER_TRUST_SCOPE=setup-shell-environment/u);
    assert.match(unset, /reviewer-trust-unconfigured/u, "未設定は fail-closed だと運営者に伝える");
    assert.match(unset, /Codex: env_vars passthrough; Claude Code: inherits its process environment/u);

    const set = await runSetup(agent, { ...NO_REVIEWER_TRUST_ENV, BUZZASSIST_REVIEWER_TRUST: sentinel });
    assert.match(set, /BUZZASSIST_REVIEWER_TRUST_CONFIGURED=yes/u);
    assert.doesNotMatch(set, /reviewer-trust-sentinel-9f3c/u, "運営者の信頼リスト path の値を出力に載せない");

    const ambiguous = await runSetup(agent, { ...NO_REVIEWER_TRUST_ENV, BUZZASSIST_REVIEWER_TRUST: sentinel, BUZZASSIST_KOYA_REVIEWER_TRUST: "/secure/other-a1b2.json" });
    assert.match(ambiguous, /BUZZASSIST_REVIEWER_TRUST_CONFIGURED=ambiguous/u);
    assert.match(ambiguous, /env-ambiguous/u);
    assert.doesNotMatch(ambiguous, /sentinel-9f3c|other-a1b2/u);
  }
});

test("setup CLI configures only Claude Desktop when --agent claude-desktop is used", async () => {
  const stdout = await runSetup("claude-desktop");
  assert.match(stdout, /Agent target: Claude Desktop/);
  assert.match(stdout, /Configuring Claude Desktop/);
  assert.match(stdout, /Would write .*claude_desktop_config\.json/);
  assert.match(stdout, /BUZZASSIST_WIDGET_TOOL=render_buzzassist_canvas_widget/);
  assert.match(stdout, /Codex: not touched/);
  assert.match(stdout, /Claude Desktop: configured/);
  assert.match(stdout, /Claude Code: not touched/);
  assert.match(stdout, /Cursor: not touched/);
  assert.match(stdout, /Antigravity: not touched/);
});

test("setup CLI configures only Antigravity when --agent antigravity is used", async () => {
  const stdout = await runSetup("antigravity");
  assert.match(stdout, /Agent target: Antigravity/);
  assert.match(stdout, /Codex: not touched/);
  assert.match(stdout, /Claude Desktop: not touched/);
  assert.match(stdout, /Claude Code: not touched/);
  assert.match(stdout, /Cursor: not touched/);
  assert.match(stdout, /Antigravity: configured/);
});

test("setup CLI can include Canvas Tunnel output when --tunnel is used", async () => {
  const stdout = await runSetupWithTunnel("codex");
  assert.match(stdout, /Starting the BuzzAssist Canvas Tunnel/);
  assert.doesNotMatch(stdout, /BUZZASSIST_WIDGET_TOOL=render_buzzassist_canvas_widget/);
  assert.match(stdout, /first open BUZZASSIST_CANVAS_URL in the host in-app browser/);
  assert.match(stdout, /Only when that Browser capability is unavailable, use Chrome\/the external-browser fallback/);
  assert.match(stdout, /BUZZASSIST_TUNNEL_URL=https:\/\/example\.ngrok-free\.dev/);
  assert.match(stdout, /BUZZASSIST_TUNNEL_ACCESS_URL=https:\/\/example\.ngrok-free\.dev\/\?t=<generated>/);
  assert.match(stdout, /BUZZASSIST_TUNNEL_CHECK=ok/);
  assert.doesNotMatch(stdout, /BUZZASSIST_TUNNEL_PASSWORD=/);
});

test("normal setup fails closed when the canonical harness doctor is not ready", async () => {
  const { access, mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const isolatedHome = await mkdtemp(join(tmpdir(), "buzzassist-setup-fail-closed-"));
  try {
    await assert.rejects(
      () => execFileAsync(process.execPath, [
        "scripts/setup-agents.mjs",
        "--skip-install",
        "--skip-build",
        "--skip-plugin-source",
        "--no-launch",
        "--no-auto-update",
        "--agent",
        "codex",
        "--project-dir",
        isolatedHome,
      ], {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: isolatedHome,
          USERPROFILE: isolatedHome,
          BUZZASSIST_SETUP_HOME: isolatedHome,
          PATH: "",
          CODEX_COMMAND: "",
          ELEVENLABS_API_KEY: "",
          XI_API_KEY: "",
          LOVART_ACCESS_KEY: "",
          LOVART_SECRET_KEY: "",
          BUZZASSIST_MEDIA_TOKEN: "",
          BUZZASSIST_TOKEN: "",
          // 前提ツールの自動導入（ffmpeg の取得など）は、この試験の対象外。
          BUZZASSIST_INSTALL_PREREQUISITES: "0",
        },
      }),
      (error) => {
        assert.equal(error.code, 2);
        assert.match(String(error.stdout), /BUZZASSIST_HARNESS_READY=no/);
        assert.match(String(error.stdout), /fail-closed/u);
        return true;
      },
    );
    await assert.rejects(
      access(join(isolatedHome, "plugins", "buzzassist")),
      { code: "ENOENT" },
      "fail-closed preflight must stop before staging or configuring a host plugin",
    );
  } finally {
    await rm(isolatedHome, { recursive: true, force: true });
  }
});
