#!/usr/bin/env node
// ハーネス並列実行ランナー（Claude Code / Codex 共通）
//
// 目的: 漫画動画ハーネス・マイク両ハーネスの残作業を、依存関係と共有状態の排他を守った
// まま最大並列で流す。ホストのサブエージェント機能に依存しないので、
// Claude Code からでも Codex からでも同じコマンド・同じ結果になる。
//
//   node scripts/harness-parallel-run.mjs --plan <plan.json> [--concurrency N]
//
// 設計上の約束（ハーネス全体の方針に合わせる）:
// - fail-closed: 依存が落ちたジョブは走らせず skipped にする。1件でも
//   失敗・スキップがあれば終了コードは非0。「並列にしたら通った」を作らない。
// - 排他: locks に同じパスを宣言したジョブは決して同時に走らない。
//   canvas/character-workflows.json のような共有台帳の破壊を防ぐ。
// - 証跡: 実行計画のダイジェスト、各ジョブの終了コード・所要時間・
//   ログのパスをレポートJSONに残す。後から「何を並列で流したか」を再現できる。

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function parseArgs(argv) {
  const out = { concurrency: null, dryRun: false, plan: null, report: null, logDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} には値が必要です`);
      i += 1;
      return value;
    };
    if (arg === "--plan") out.plan = next();
    else if (arg === "--concurrency") out.concurrency = next();
    else if (arg === "--report") out.report = next();
    else if (arg === "--log-dir") out.logDir = next();
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`不明な引数: ${arg}`);
  }
  return out;
}

// 既定の並列数。CLIジョブ自体が内側で子プロセスやAPI並列を持つので、
// コア数いっぱいには張らない。16GB機で ffmpeg / python が同時に走ると
// スワップして遅くなるため、上限は控えめに置く。
export function defaultConcurrency(cpuCount = os.cpus().length) {
  return Math.max(1, Math.min(8, cpuCount - 2));
}

export function resolveConcurrency(raw, cpuCount = os.cpus().length) {
  if (raw === null || raw === undefined || raw === "auto") return defaultConcurrency(cpuCount);
  const text = String(raw).trim();
  // "3junk" や "1.5" を 3 や 1 として受け取らない。
  const parsed = /^\d+$/u.test(text) ? Number.parseInt(text, 10) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`--concurrency は 1 以上の整数か auto を指定してください: ${raw}`);
  }
  return parsed;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function planDigest(plan) {
  return createHash("sha256").update(stableStringify(plan)).digest("hex");
}

// 11人のキャストや30セグメントのように同じ形のジョブが並ぶとき、
// 計画JSONを手で並べるとコピペ間違いが必ず混ざる。`expand` を使うと
// 1ブロックから対象ごとのジョブを機械的に起こせる。
//
//   { "expand": [ { "over": ["horo", "tatsu"],
//                   "id": "gate-{item}",
//                   "args": ["...", "canvas/attribute-gates/{item}.json"] } ] }
//
// over の要素は文字列でもオブジェクトでもよく、オブジェクトなら {key} で
// 各フィールドを差し込める。{item} は文字列そのもの（オブジェクトなら
// その `item` フィールド）を指す。
export function expandPlanJobs(plan) {
  const expanded = [...(plan.jobs ?? [])];
  for (const template of plan.expand ?? []) {
    const items = template.over ?? [];
    if (!Array.isArray(items)) {
      throw new Error("expand[].over は配列にしてください");
    }
    const { over, ...rest } = template;
    for (const [index, rawItem] of items.entries()) {
      const fields = typeof rawItem === "object" && rawItem !== null
        ? { ...rawItem, index: String(index) }
        : { item: String(rawItem), index: String(index) };
      const substitute = (value) => {
        if (typeof value === "string") {
          return value.replace(/\{(\w+)\}/gu, (match, key) => {
            // key in fields だと {constructor} や {toString} が継承側に
            // 当たって関数の文字列に化ける。自分のプロパティだけを見る。
            if (!Object.hasOwn(fields, key)) {
              throw new Error(`expand: 差し込む値 {${key}} が over の要素にありません`);
            }
            const field = fields[key];
            if (field === null || typeof field === "object" || typeof field === "function") {
              throw new Error(`expand: {${key}} に差し込めるのは文字列・数値・真偽値だけです`);
            }
            return String(field);
          });
        }
        if (Array.isArray(value)) return value.map(substitute);
        if (value && typeof value === "object") {
          return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v)]));
        }
        return value;
      };
      expanded.push(substitute(rest));
    }
  }
  return { ...plan, jobs: expanded, expand: undefined };
}

// 計画の検証。ここで落とすものは実行時に落とすと片方だけ走った状態になり
// 後始末が面倒なので、1件でも壊れていれば1つも走らせない。
export function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== "object") return ["plan がオブジェクトではありません"];
  const jobs = Array.isArray(plan.jobs) ? plan.jobs : null;
  if (!jobs || jobs.length === 0) return ["plan.jobs が空です"];

  const seen = new Set();
  for (const job of jobs) {
    const id = job?.id;
    if (typeof id !== "string" || id.trim() === "") {
      errors.push(`id の無いジョブがあります: ${JSON.stringify(job)?.slice(0, 80)}`);
      continue;
    }
    if (seen.has(id)) errors.push(`id が重複しています: ${id}`);
    seen.add(id);
    if (!SAFE_JOB_ID.test(id)) {
      errors.push(`${id}: id に使えるのは英数字と . _ - だけです（ログのファイル名になるため）`);
    }
    if (job.timeoutMs !== undefined
      && (typeof job.timeoutMs !== "number" || !Number.isFinite(job.timeoutMs) || job.timeoutMs <= 0)) {
      errors.push(`${id}: timeoutMs は正の有限数にしてください`);
    }
    if (job.expectExitCode !== undefined && !Number.isInteger(job.expectExitCode)) {
      errors.push(`${id}: expectExitCode は整数にしてください`);
    }
    // 品質ゲートの不合格（非0終了）を「期待どおり」に付け替えると、
    // 下流の needs が走って「並列にしたら通った」ができてしまう。
    // ゲートを呼ぶジョブでは非0の expectExitCode を認めない。
    if (job.expectExitCode !== undefined && job.expectExitCode !== 0) {
      const commandLine = `${job.command} ${(job.args ?? []).join(" ")}`;
      if (/\bgate\b|\baudit\b|audit-|-gate\b/u.test(commandLine)) {
        errors.push(
          `${id}: 品質ゲートに expectExitCode: ${job.expectExitCode} は指定できません`
          + "（不合格を成功として記録することになります）",
        );
      }
    }
    if (job.env !== undefined && (typeof job.env !== "object" || job.env === null || Array.isArray(job.env))) {
      errors.push(`${id}: env はオブジェクトにしてください`);
    }
    if (job.cwd !== undefined && typeof job.cwd !== "string") {
      errors.push(`${id}: cwd は文字列にしてください`);
    }
    if (typeof job.command !== "string" || job.command.trim() === "") {
      errors.push(`${id}: command が必要です`);
    }
    if (job.args !== undefined && !Array.isArray(job.args)) {
      errors.push(`${id}: args は配列にしてください`);
    }
    if (job.needs !== undefined && !Array.isArray(job.needs)) {
      errors.push(`${id}: needs は配列にしてください`);
    }
    if (job.locks !== undefined && !Array.isArray(job.locks)) {
      errors.push(`${id}: locks は配列にしてください`);
    }
  }

  for (const job of jobs) {
    for (const need of job?.needs ?? []) {
      if (!seen.has(need)) errors.push(`${job.id}: needs に存在しないジョブ ${need} を指しています`);
    }
  }

  // 依存の循環。見つけたら実行不能なので計画ごと拒否する。
  const byId = new Map(jobs.filter((j) => typeof j?.id === "string").map((j) => [j.id, j]));
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    const status = state.get(id);
    if (status === "done") return;
    if (status === "visiting") {
      const cycleStart = stack.indexOf(id);
      errors.push(`依存が循環しています: ${[...stack.slice(cycleStart), id].join(" -> ")}`);
      return;
    }
    state.set(id, "visiting");
    stack.push(id);
    for (const need of byId.get(id)?.needs ?? []) {
      if (byId.has(need)) visit(need);
    }
    stack.pop();
    state.set(id, "done");
  };
  for (const id of byId.keys()) visit(id);

  return errors;
}

// ロックは「同じファイルを指す別表記」を同じキーに畳まないと意味がない。
// state.json と ./state.json と絶対パスが別ロック扱いになると、排他を
// 宣言したつもりのジョブが平然と同時に走る。
export function normalizeLockKey(lock, baseDir) {
  // ロックは必ずパスとして解決する。「/ を含むものだけパス扱い」にすると
  // state.json と ./state.json が別の鍵になり、排他を宣言したつもりの
  // ジョブが同時に走る。実際の計画は全てパスを渡しているので、
  // 論理名が要るときも名前空間を持つパス表記（locks/bgm-approval）で書く。
  return `path:${path.resolve(baseDir, String(lock))}`;
}

function normalizeLocks(job, baseDir) {
  // 正規化したうえでソートして取る。取得順を全ジョブで揃えることが、
  // 2つのジョブが互いのロックを待ち合うデッドロックを防ぐ唯一の方法。
  return [...new Set((job.locks ?? []).map((lock) => normalizeLockKey(lock, baseDir)))].sort();
}

// ジョブIDはログのファイル名になる。`../../x` を許すと logDir の外に
// 書けてしまい、`a` と `b/../a` が同じログを上書きして証跡が混ざる。
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

async function runJob(job, { logDir, defaults, dryRun }) {
  const cwd = path.resolve(job.cwd ?? defaults.cwd ?? REPO_ROOT);
  const args = job.args ?? [];
  const startedAt = Date.now();

  if (dryRun) {
    return {
      id: job.id,
      status: "dry-run",
      exitCode: 0,
      durationMs: 0,
      command: `${job.command} ${args.join(" ")}`.trim(),
      cwd,
    };
  }

  const stdoutPath = path.join(logDir, `${job.id}.stdout.log`);
  const stderrPath = path.join(logDir, `${job.id}.stderr.log`);
  const stdoutStream = fs.createWriteStream(stdoutPath);
  const stderrStream = fs.createWriteStream(stderrPath);
  let timedOut = false;

  const result = await new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const child = spawn(job.command, args, {
      cwd,
      env: { ...process.env, ...(defaults.env ?? {}), ...(job.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      // 独立したプロセスグループで起動する。こうしないと、タイムアウトで
      // 子だけを殺しても孫（codex exec や ffmpeg が産むもの）が生き残り、
      // ロックを解放したあとも共有ファイルを書き続ける。
      detached: process.platform !== "win32",
    });
    child.stdout.pipe(stdoutStream);
    child.stderr.pipe(stderrStream);

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(payload);
    };

    const killTree = () => {
      if (process.platform === "win32") {
        child.kill("SIGKILL");
        return;
      }
      try {
        // 負のPIDはプロセスグループ全体を指す。孫までまとめて止める。
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* すでに終了している */ }
      }
    };

    if (job.timeoutMs) {
      timer = setTimeout(() => {
        killTree();
        // ここでは resolve しない。close を待って初めて確定させる。
        // 先に確定するとロックが解放され、まだ死にきっていないプロセスと
        // 次のジョブが同じファイルを触る。
        timedOut = true;
      }, job.timeoutMs);
    }

    child.on("error", (error) => finish({ exitCode: null, spawnError: error.message }));
    child.on("close", (code, signal) => finish({ exitCode: code, signal, timedOut }));
  });

  await new Promise((resolve) => stdoutStream.end(resolve));
  await new Promise((resolve) => stderrStream.end(resolve));

  const expected = job.expectExitCode ?? 0;
  const passed = result.exitCode === expected;
  return {
    id: job.id,
    title: job.title ?? null,
    status: passed ? "passed" : "failed",
    exitCode: result.exitCode,
    signal: result.signal ?? null,
    timedOut: Boolean(result.timedOut),
    spawnError: result.spawnError ?? null,
    durationMs: Date.now() - startedAt,
    command: `${job.command} ${args.join(" ")}`.trim(),
    // 空白で連結した command だけでは引数の境界が復元できない。
    // 何を流したかを後から正確に再現できるよう、構造のまま残す。
    argv: [job.command, ...args],
    cwd,
    needs: job.needs ?? [],
    locks: job.locks ?? [],
    envKeys: Object.keys(job.env ?? {}),
    timeoutMs: job.timeoutMs ?? null,
    expectExitCode: expected,
    stdoutPath,
    stderrPath,
  };
}

export async function executePlan(plan, options = {}) {
  const concurrency = options.concurrency ?? defaultConcurrency();
  const dryRun = Boolean(options.dryRun);
  const logDir = options.logDir ?? path.join(REPO_ROOT, "canvas", "parallel-runs", `run-${Date.now()}`);
  if (!dryRun) fs.mkdirSync(logDir, { recursive: true });

  const defaults = plan.defaults ?? {};
  const jobs = plan.jobs;
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const results = new Map();
  const heldLocks = new Set();
  const running = new Set();
  const pending = new Set(jobs.map((job) => job.id));
  const startedAt = Date.now();

  const dependencyBlocked = (job) => {
    for (const need of job.needs ?? []) {
      const result = results.get(need);
      if (result && result.status !== "passed" && result.status !== "dry-run") return need;
    }
    return null;
  };

  const dependenciesSettled = (job) =>
    (job.needs ?? []).every((need) => results.has(need));

  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};

  while (pending.size > 0 || running.size > 0) {
    let launched = false;

    for (const id of [...pending]) {
      if (running.size >= concurrency) break;
      const job = byId.get(id);
      if (!dependenciesSettled(job)) continue;

      const blocker = dependencyBlocked(job);
      if (blocker) {
        // 依存が落ちた先には進まない。ここを「とりあえず走らせる」に
        // すると、前工程が失敗した資産の上に後工程の成功記録が乗る。
        pending.delete(id);
        results.set(id, {
          id,
          title: job.title ?? null,
          status: "skipped",
          reason: `依存ジョブ ${blocker} が成功しなかったため実行しませんでした`,
          durationMs: 0,
        });
        onProgress({ type: "skipped", id, blocker });
        launched = true;
        continue;
      }

      const locks = normalizeLocks(job, path.resolve(job.cwd ?? defaults.cwd ?? REPO_ROOT));
      if (locks.some((lock) => heldLocks.has(lock))) continue;

      for (const lock of locks) heldLocks.add(lock);
      pending.delete(id);
      const task = runJob(job, { logDir, defaults, dryRun })
        .catch((error) => ({
          // spawn 前の失敗（cwd が不正など）もジョブ1件の失敗として扱う。
          // 例外のまま投げると計画全体が落ちて証跡が残らない。
          id,
          title: job.title ?? null,
          status: "failed",
          exitCode: null,
          runnerError: error?.message ?? String(error),
          durationMs: 0,
        }))
        .then((result) => {
          results.set(id, result);
          onProgress({ type: "finished", id, result });
        })
        .finally(() => {
          for (const lock of locks) heldLocks.delete(lock);
          running.delete(task);
        });
      running.add(task);
      onProgress({ type: "started", id, title: job.title ?? null });
      launched = true;
    }

    if (running.size > 0) {
      await Promise.race(running);
    } else if (!launched && pending.size > 0) {
      // ここに来るのは検証を通ったのに進めなくなった場合だけ。
      // 黙って無限ループするより、状態を出して止める方が直しやすい。
      throw new Error(
        `実行できないジョブが残りました（ロック待ちの循環の可能性）: ${[...pending].join(", ")}`,
      );
    }
  }

  const ordered = jobs.map((job) => results.get(job.id)).filter(Boolean);
  const summary = {
    planId: plan.planId ?? null,
    planDigest: planDigest(plan),
    concurrency,
    dryRun,
    host: options.host ?? process.env.HARNESS_PARALLEL_HOST ?? "unspecified",
    cpuCount: os.cpus().length,
    totalDurationMs: Date.now() - startedAt,
    counts: {
      total: ordered.length,
      passed: ordered.filter((r) => r.status === "passed").length,
      failed: ordered.filter((r) => r.status === "failed").length,
      skipped: ordered.filter((r) => r.status === "skipped").length,
      dryRun: ordered.filter((r) => r.status === "dry-run").length,
    },
    logDir: dryRun ? null : logDir,
    jobs: ordered,
  };
  summary.ok = summary.counts.failed === 0 && summary.counts.skipped === 0;
  return summary;
}

function printHelp() {
  process.stdout.write(`ハーネス並列実行ランナー

  node scripts/harness-parallel-run.mjs --plan <plan.json> [options]

  --plan <path>          実行計画JSON（必須）
  --concurrency <n|auto> 同時実行数（既定 auto = min(8, CPU-2)）
  --report <path>        レポートJSONの出力先
  --log-dir <path>       各ジョブのログ出力先
  --dry-run              実行せず計画の検証と順序だけ確認する

  計画JSONの形:
    {
      "planId": "koya-2026-08-28",
      "defaults": { "cwd": "/path/to/repo" },
      "jobs": [
        { "id": "gate-horo", "title": "もも 属性ゲート",
          "command": "node", "args": ["scripts/koya-manga-video.mjs", "..."],
          "needs": [], "locks": ["canvas/character-workflows.json"],
          "timeoutMs": 600000 }
      ]
    }

  locks に同じパスを書いたジョブは同時に走りません。needs の依存が
  失敗した場合そのジョブは skipped になり、終了コードは非0になります。
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

  if (options.help || !options.plan) {
    printHelp();
    process.exit(options.plan ? 0 : 2);
  }

  const planPath = path.resolve(options.plan);
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  } catch (error) {
    process.stderr.write(`計画JSONを読めませんでした (${planPath}): ${error.message}\n`);
    process.exit(2);
  }

  try {
    plan = expandPlanJobs(plan);
  } catch (error) {
    process.stderr.write(`計画の展開に失敗しました: ${error.message}\n`);
    process.exit(2);
  }

  const errors = validatePlan(plan);
  if (errors.length > 0) {
    process.stderr.write(`計画に問題があります:\n${errors.map((e) => `  - ${e}`).join("\n")}\n`);
    process.exit(2);
  }

  let concurrency;
  try {
    concurrency = resolveConcurrency(options.concurrency);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }

  const summary = await executePlan(plan, {
    concurrency,
    dryRun: options.dryRun,
    logDir: options.logDir ? path.resolve(options.logDir) : undefined,
    onProgress: (event) => {
      if (event.type === "started") {
        process.stdout.write(`▶ ${event.id}${event.title ? ` — ${event.title}` : ""}\n`);
      } else if (event.type === "finished") {
        const mark = event.result.status === "passed" || event.result.status === "dry-run" ? "✅" : "❌";
        const secs = (event.result.durationMs / 1000).toFixed(1);
        process.stdout.write(`${mark} ${event.id} (${event.result.status}, ${secs}秒)\n`);
      } else if (event.type === "skipped") {
        process.stdout.write(`⏭  ${event.id} — 依存 ${event.blocker} が失敗したためスキップ\n`);
      }
    },
  });

  if (options.report) {
    const reportPath = path.resolve(options.report);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`レポート: ${reportPath}\n`);
  }

  const { counts } = summary;
  process.stdout.write(
    `\n合計 ${counts.total} 件 / 成功 ${counts.passed} / 失敗 ${counts.failed} / スキップ ${counts.skipped}`
      + ` / 同時 ${summary.concurrency} / 所要 ${(summary.totalDurationMs / 1000).toFixed(1)}秒\n`,
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
