#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";

function parseArgs(argv) {
  const values = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    values[key] = argv[index + 1];
    index += 1;
  }
  return values;
}

const args = parseArgs(process.argv);
const jobPath = resolve(args.jobPath || "");
const cliArgs = JSON.parse(args.cliArgsJson || "[]");
if (!jobPath || !Array.isArray(cliArgs) || cliArgs.length < 2) throw new Error("job-path and cli-args-json are required.");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let job = JSON.parse(await readFile(jobPath, "utf8"));
job = { ...job, status: "running", runnerPid: process.pid, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
await writeJsonAtomic(jobPath, job);

const stdout = await open(job.stdoutPath, "a");
const stderr = await open(job.stderrPath, "a");
const child = spawn(process.execPath, cliArgs, { cwd: repoRoot, stdio: ["ignore", stdout.fd, stderr.fd] });
job = { ...job, childPid: child.pid, updatedAt: new Date().toISOString() };
await writeJsonAtomic(jobPath, job);

// 割り込みで死ぬと status が running のまま残り、記録だけからは
// 「走っている」のか「落ちた」のか分からなくなる。中断されたことを残す。
let interrupting = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (interrupting) return;
    interrupting = true;
    try { child.kill("SIGTERM"); } catch { /* すでに終了 */ }
    try {
      writeFileSync(jobPath, `${JSON.stringify({
        ...job,
        status: "interrupted",
        signal,
        interruptedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        interruptedReason: `${signal} を受けて中断した`,
      }, null, 2)}\n`);
    } catch { /* 書けなければ、上位が PID 死亡から再分類する */ }
    process.exit(130);
  });
}
const exitCode = await new Promise((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolveExit({ code, signal }));
});
await stdout.close();
await stderr.close();
job = {
  ...job,
  status: exitCode.code === 0 ? "completed" : "failed",
  exitCode: exitCode.code,
  signal: exitCode.signal || "",
  completedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
await writeJsonAtomic(jobPath, job);
