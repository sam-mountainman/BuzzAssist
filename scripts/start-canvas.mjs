#!/usr/bin/env node
// Cross-platform canvas launcher (Windows/macOS/Linux replacement for
// start-canvas.sh). Binds the canvas to a project folder and serves the
// production bundle plus local API/MCP endpoints.
//
//   node scripts/start-canvas.mjs [/path/to/project] [--port 43219]
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, ["scripts/serve-canvas.mjs", ...process.argv.slice(2)], {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
  shell: false,
});
child.on("exit", (code) => process.exit(code ?? 0));
