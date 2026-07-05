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

test("setup CLI configures only Cursor when --agent cursor is used", async () => {
  const stdout = await runSetup("cursor");
  assert.match(stdout, /Agent target: Cursor/);
  assert.match(stdout, /Codex: not touched/);
  assert.match(stdout, /Claude Code: not touched/);
  assert.match(stdout, /Cursor: configured/);
  assert.match(stdout, /Antigravity: not touched/);
});

test("setup CLI configures only Antigravity when --agent antigravity is used", async () => {
  const stdout = await runSetup("antigravity");
  assert.match(stdout, /Agent target: Antigravity/);
  assert.match(stdout, /Codex: not touched/);
  assert.match(stdout, /Claude Code: not touched/);
  assert.match(stdout, /Cursor: not touched/);
  assert.match(stdout, /Antigravity: configured/);
});
