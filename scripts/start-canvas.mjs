#!/usr/bin/env node
// Cross-platform canvas launcher (Windows/macOS/Linux replacement for
// start-canvas.sh). Binds the canvas to a project folder and starts vite.
//
//   node scripts/start-canvas.mjs [/path/to/project] [--port 43219]
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const portIndex = argv.indexOf("--port");
const port = portIndex >= 0 ? argv[portIndex + 1] : process.env.EXCALIDRAW_PORT || "43219";
const projectDir = resolve(argv.find((arg, i) => !arg.startsWith("--") && argv[i - 1] !== "--port") ?? process.cwd());

const env = {
  ...process.env,
  EXCALIDRAW_PROJECT_DIR: projectDir,
  EXCALIDRAW_PORT: String(port),
};

console.log(`[start-canvas] project: ${projectDir}`);
console.log(`[start-canvas] canvas:  ${join(projectDir, "canvas")}`);
console.log(`[start-canvas] url:     http://127.0.0.1:${port}`);

const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev"], {
  cwd: repoRoot,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
child.on("exit", (code) => process.exit(code ?? 0));
