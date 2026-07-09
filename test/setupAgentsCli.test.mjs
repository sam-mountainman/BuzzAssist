import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function runSetup(agent) {
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/setup-agents.mjs",
    "--dry-run",
    "--skip-install",
    "--skip-build",
    "--skip-plugin-source",
    "--no-launch",
    "--agent",
    agent,
    "--project-dir",
    `/tmp/buzzassist-${agent}-test`,
  ], { cwd: repoRoot });
  return stdout;
}

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
  assert.match(stdout, /For Codex, Claude Code, Cursor, or Antigravity, open BUZZASSIST_CANVAS_URL in the host in-app browser/);
  assert.match(stdout, /BUZZASSIST_TUNNEL_URL=https:\/\/example\.ngrok-free\.dev/);
  assert.match(stdout, /BUZZASSIST_TUNNEL_ACCESS_URL=https:\/\/example\.ngrok-free\.dev\/\?t=<generated>/);
  assert.match(stdout, /BUZZASSIST_TUNNEL_CHECK=ok/);
  assert.doesNotMatch(stdout, /BUZZASSIST_TUNNEL_PASSWORD=/);
});
