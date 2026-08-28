#!/usr/bin/env node
// LLM判断の並列実行（Claude Code / Codex 共通の入口）
//
// レビュー・QA・監査のように「モデルの判断が要る」作業を、複数のCLIエージェント
// に同時に投げる。ホスト固有のサブエージェント機能を使わずシェル越しに起動する
// ので、Claude Code のセッションからでも Codex のセッションからでも同じ結果になる。
//
//   node scripts/harness-parallel-agents.mjs --tasks <tasks.json> [--engine auto]
//
// なぜホスト内蔵のサブエージェントを使わないか:
// Claude Code の並列上限は min(16, CPU-2) でマシンのコア数に縛られる（8コア機で6体）。
// 一方 codex exec はプロセス並列なのでコア数に縛られず、実測で16体が同時に完走した。
// 同じ台数を両ホストで出すには、両方が同じ外部CLIを呼ぶ形にするのが唯一の方法。

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const ENGINES = {
  codex: {
    id: "codex",
    // ChatGPT.app 同梱の codex を優先。PATH 上のものは版が古いことがある。
    candidates: [
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "codex",
    ],
    buildArgs(task, { outputPath, disableMcp }) {
      const args = ["exec", "--skip-git-repo-check"];
      // MCPサーバの読み込みは並列度が上がるとタイムアウトしやすく、
      // 判断だけが欲しいタスクでは不要な待ち時間になる。既定で切る。
      if (disableMcp) args.push("-c", "mcp_servers={}");
      if (task.model) args.push("-c", `model=${JSON.stringify(task.model)}`);
      args.push("-o", outputPath, task.prompt);
      return args;
    },
  },
  claude: {
    id: "claude",
    candidates: ["claude"],
    buildArgs(task) {
      const args = ["-p", task.prompt];
      if (task.model) args.push("--model", task.model);
      return args;
    },
    // claude -p は最終応答を標準出力に出すので、stdout をそのまま結果にする。
    resultFromStdout: true,
  },
};

function which(command) {
  if (command.includes("/")) return fs.existsSync(command) ? command : null;
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of dirs) {
    const full = path.join(dir, command);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* 次の候補へ */
    }
  }
  return null;
}

function resolveBinary(engine) {
  for (const candidate of engine.candidates) {
    const resolved = which(candidate);
    if (resolved) return resolved;
  }
  return null;
}

// エンジンが「実際に使えるか」は、存在するかではなく認証が通っているかで決まる。
// claude CLI は入っていてもログインしていないと即座に失敗する。存在だけを見て
// 選ぶと、全タスクが同じエラーで落ちてから気づくことになる。
export async function probeEngine(engineId, { timeoutMs = 60_000 } = {}) {
  const engine = ENGINES[engineId];
  if (!engine) return { engineId, available: false, reason: `未知のエンジン: ${engineId}` };
  const binary = resolveBinary(engine);
  if (!binary) return { engineId, available: false, reason: "実行ファイルが見つかりません" };

  const probeTask = { prompt: "Reply with exactly: PROBE-OK" };
  const outputPath = path.join(
    os.tmpdir(),
    `harness-agent-probe-${engineId}-${process.pid}.txt`,
  );
  const args = engine.buildArgs(probeTask, { outputPath, disableMcp: true });

  const outcome = await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(binary, args, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        resolve({ ok: false, reason: "プローブがタイムアウトしました" });
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let text = stdout;
      if (!engine.resultFromStdout) {
        try { text = fs.readFileSync(outputPath, "utf8"); } catch { /* 出力なし */ }
      }
      const combined = `${text}\n${stderr}`;
      if (/not logged in|please run \/login|unauthorized|401/i.test(combined)) {
        resolve({ ok: false, reason: "未ログイン（認証が必要）" });
        return;
      }
      if (code !== 0) {
        resolve({ ok: false, reason: `終了コード ${code}: ${stderr.trim().slice(0, 120)}` });
        return;
      }
      resolve({ ok: /PROBE-OK/.test(text), reason: /PROBE-OK/.test(text) ? null : "応答が想定と違います" });
    });
  });

  try { fs.unlinkSync(outputPath); } catch { /* 消えていれば良い */ }
  return { engineId, binary, available: outcome.ok, reason: outcome.reason ?? null };
}

export async function selectEngine(requested, options = {}) {
  if (requested && requested !== "auto") {
    const probe = await probeEngine(requested, options);
    if (!probe.available) {
      throw new Error(`エンジン ${requested} は使えません: ${probe.reason}`);
    }
    return probe;
  }
  const probes = [];
  for (const id of ["codex", "claude"]) {
    const probe = await probeEngine(id, options);
    probes.push(probe);
    if (probe.available) return probe;
  }
  const detail = probes.map((p) => `${p.engineId}: ${p.reason}`).join(" / ");
  throw new Error(`使えるエージェントCLIがありません（${detail}）`);
}

async function runTask(task, { engine, binary, outDir, disableMcp, defaultTimeoutMs }) {
  const startedAt = Date.now();
  const outputPath = path.join(outDir, `${task.id}.result.txt`);
  const logPath = path.join(outDir, `${task.id}.log`);
  const args = engine.buildArgs(task, { outputPath, disableMcp });
  const timeoutMs = task.timeoutMs ?? defaultTimeoutMs;

  const outcome = await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(binary, args, {
      cwd: path.resolve(task.cwd ?? REPO_ROOT),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) { settled = true; resolve({ code: null, stdout, stderr, timedOut: true }); }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ code: null, stdout, stderr, spawnError: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

  fs.writeFileSync(logPath, `--- stdout ---\n${outcome.stdout}\n--- stderr ---\n${outcome.stderr}\n`);

  let result = "";
  if (engine.resultFromStdout) {
    result = outcome.stdout.trim();
    fs.writeFileSync(outputPath, `${result}\n`);
  } else {
    try { result = fs.readFileSync(outputPath, "utf8").trim(); } catch { result = ""; }
  }

  const ok = outcome.code === 0 && result.length > 0 && !outcome.timedOut;
  return {
    id: task.id,
    title: task.title ?? null,
    status: ok ? "passed" : "failed",
    exitCode: outcome.code,
    timedOut: Boolean(outcome.timedOut),
    spawnError: outcome.spawnError ?? null,
    durationMs: Date.now() - startedAt,
    resultPath: outputPath,
    logPath,
    resultPreview: result.slice(0, 400),
  };
}

export async function runAgentTasks(tasks, options = {}) {
  const engineInfo = options.engineInfo ?? (await selectEngine(options.engine ?? "auto"));
  const engine = ENGINES[engineInfo.engineId];
  const concurrency = options.concurrency ?? 8;
  const outDir = options.outDir
    ?? path.join(REPO_ROOT, "canvas", "parallel-runs", `agents-${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });
  const startedAt = Date.now();

  const queue = [...tasks];
  const results = [];
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};

  const worker = async () => {
    while (queue.length > 0) {
      const task = queue.shift();
      onProgress({ type: "started", id: task.id, title: task.title ?? null });
      const result = await runTask(task, {
        engine,
        binary: engineInfo.binary,
        outDir,
        disableMcp: options.disableMcp ?? true,
        defaultTimeoutMs: options.timeoutMs ?? 900_000,
      });
      results.push(result);
      onProgress({ type: "finished", id: task.id, result });
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));

  const byId = new Map(results.map((r) => [r.id, r]));
  const ordered = tasks.map((t) => byId.get(t.id)).filter(Boolean);
  const summary = {
    engine: engineInfo.engineId,
    binary: engineInfo.binary,
    concurrency,
    cpuCount: os.cpus().length,
    host: options.host ?? process.env.HARNESS_PARALLEL_HOST ?? "unspecified",
    tasksDigest: createHash("sha256")
      .update(JSON.stringify(tasks.map((t) => [t.id, t.prompt])))
      .digest("hex"),
    totalDurationMs: Date.now() - startedAt,
    outDir,
    counts: {
      total: ordered.length,
      passed: ordered.filter((r) => r.status === "passed").length,
      failed: ordered.filter((r) => r.status === "failed").length,
    },
    tasks: ordered,
  };
  summary.ok = summary.counts.failed === 0;
  return summary;
}

function parseArgs(argv) {
  const out = { tasks: null, engine: "auto", concurrency: null, report: null, outDir: null, mcp: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} には値が必要です`);
      i += 1;
      return value;
    };
    if (arg === "--tasks") out.tasks = next();
    else if (arg === "--engine") out.engine = next();
    else if (arg === "--concurrency") out.concurrency = Number.parseInt(next(), 10);
    else if (arg === "--report") out.report = next();
    else if (arg === "--out-dir") out.outDir = next();
    else if (arg === "--with-mcp") out.mcp = true;
    else if (arg === "--probe") out.probe = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`不明な引数: ${arg}`);
  }
  return out;
}

function printHelp() {
  process.stdout.write(`LLM判断の並列実行

  node scripts/harness-parallel-agents.mjs --tasks <tasks.json> [options]
  node scripts/harness-parallel-agents.mjs --probe

  --tasks <path>       タスクJSON（必須）
  --engine <id|auto>   codex / claude / auto（既定 auto。認証が通る方を選ぶ）
  --concurrency <n>    同時実行数（既定 8。codex は16まで実測済み）
  --report <path>      レポートJSONの出力先
  --out-dir <path>     各タスクの結果の出力先
  --with-mcp           MCPサーバを読み込む（既定は切る。並列時に不安定なため）
  --probe              使えるエンジンを調べて終了する

  タスクJSONの形:
    { "tasks": [ { "id": "review-horo", "title": "もも同一性QA",
                   "prompt": "...", "timeoutMs": 900000 } ] }
`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }

  if (options.help) { printHelp(); process.exit(0); }

  if (options.probe) {
    for (const id of ["codex", "claude"]) {
      const probe = await probeEngine(id);
      const mark = probe.available ? "✅" : "❌";
      process.stdout.write(`${mark} ${id}: ${probe.available ? probe.binary : probe.reason}\n`);
    }
    process.exit(0);
  }

  if (!options.tasks) { printHelp(); process.exit(2); }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(path.resolve(options.tasks), "utf8"));
  } catch (error) {
    process.stderr.write(`タスクJSONを読めませんでした: ${error.message}\n`);
    process.exit(2);
  }

  const tasks = Array.isArray(payload) ? payload : payload.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    process.stderr.write("tasks が空です\n");
    process.exit(2);
  }
  const ids = new Set();
  for (const task of tasks) {
    if (typeof task?.id !== "string" || !task.id.trim()) {
      process.stderr.write(`id の無いタスクがあります\n`); process.exit(2);
    }
    if (ids.has(task.id)) { process.stderr.write(`id が重複: ${task.id}\n`); process.exit(2); }
    ids.add(task.id);
    if (typeof task?.prompt !== "string" || !task.prompt.trim()) {
      process.stderr.write(`${task.id}: prompt が必要です\n`); process.exit(2);
    }
  }

  let engineInfo;
  try {
    engineInfo = await selectEngine(options.engine);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  process.stdout.write(`エンジン: ${engineInfo.engineId} (${engineInfo.binary})\n`);

  const summary = await runAgentTasks(tasks, {
    engineInfo,
    concurrency: options.concurrency ?? 8,
    outDir: options.outDir ? path.resolve(options.outDir) : undefined,
    disableMcp: !options.mcp,
    onProgress: (event) => {
      if (event.type === "started") {
        process.stdout.write(`▶ ${event.id}${event.title ? ` — ${event.title}` : ""}\n`);
      } else {
        const mark = event.result.status === "passed" ? "✅" : "❌";
        process.stdout.write(
          `${mark} ${event.id} (${(event.result.durationMs / 1000).toFixed(1)}秒)\n`,
        );
      }
    },
  });

  if (options.report) {
    const reportPath = path.resolve(options.report);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`レポート: ${reportPath}\n`);
  }

  process.stdout.write(
    `\n合計 ${summary.counts.total} 件 / 成功 ${summary.counts.passed} / 失敗 ${summary.counts.failed}`
      + ` / 同時 ${summary.concurrency} / 所要 ${(summary.totalDurationMs / 1000).toFixed(1)}秒\n`
      + `結果: ${summary.outDir}\n`,
  );
  process.exit(summary.ok ? 0 : 1);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
