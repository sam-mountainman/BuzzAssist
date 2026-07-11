#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDirIndex = process.argv.indexOf("--outDir");
const outDir = outDirIndex >= 0 ? process.argv[outDirIndex + 1] : "dist-widget";

const viteBin = resolve(
  repoRoot,
  "node_modules",
  "vite",
  "bin",
  "vite.js",
);

const args = [viteBin, "build", "--outDir", outDir, "--emptyOutDir"];
const child = spawn(process.execPath, args, {
  cwd: repoRoot,
  env: {
    ...process.env,
    BUZZASSIST_WIDGET_BUILD: "1",
    BUZZASSIST_WIDGET_OUT_DIR: outDir,
  },
  stdio: "inherit",
  shell: false,
});

child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
