#!/usr/bin/env node
// RunReceipt の集計（Claude Code / Codex 共通）
//
//   node scripts/harness-receipts.mjs list
//   node scripts/harness-receipts.mjs rollup
//   node scripts/harness-receipts.mjs rollup --harness koya-manga-video
//   node scripts/harness-receipts.mjs export --out docs/learning/platform-rollup.json
//
// なぜ集計が要るか:
// ハーネスを直したかどうかは git を見れば分かるが、直して良くなったかは
// 分からない。ゲートごとの失敗率をハーネスの版で並べて初めて、
// 「あの変更以降ここで落ちなくなった」「別のところで落ちるようになった」が見える。
// 自己改善（harness-learn）が提案を出す面も、本来はここであるべきで、
// 「1セッションで気づいたこと」ではなく「何度も落ちている場所」を狙える。
//
// export が出すのはチャンネル固有のものを一切含まない形。運営者の手元で
// 回った結果をこちら側へ返す道を、返せるものだけで作るため。

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import { isGateNotInForce, redactForPlatform } from "../lib/harnessRunReceipt.mjs";
import { readReceiptIndex, resolveLearningState } from "../lib/harnessLearningState.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;

/**
 * 既定の置き場。開発用チェックアウトは docs/learning/receipts、配布された写しは
 * ~/.buzzassist/learning/receipts（lib/harnessLearningState.mjs）。どちらも索引 index.jsonl を持つ。
 */
export function defaultReceiptsDir() {
  return resolveLearningState({ codeRoot: REPO_ROOT }).receiptsDir;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 1件の RunReceipt を読む。finalize していない記録は集計に混ぜない（null）。 */
function readReceiptBytes(full) {
  const info = fs.lstatSync(full, { throwIfNoEntry: false });
  if (!info) return { missing: true };
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECEIPT_BYTES) return { error: "通常の RunReceipt ファイルではない" };
  const bytes = fs.readFileSync(full);
  try {
    return { bytes, digest: sha256(bytes), receipt: JSON.parse(bytes.toString("utf8")) };
  } catch {
    return { bytes, digest: sha256(bytes), error: "読めない JSON" };
  }
}

/**
 * <project>/canvas/harness-runs/<job>/run-receipt.json を読み取り専用で走査する。
 * Job はここに共通 RunReceipt を書く。索引に載る前の Job（索引を作る前の版で決着した Job）も拾う。
 */
export function projectReceiptPaths(projectDir) {
  const runs = path.join(path.resolve(projectDir), "canvas", "harness-runs");
  let names = [];
  try {
    names = fs.readdirSync(runs, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
  return names.map((name) => path.join(runs, name, "run-receipt.json")).filter((file) => fs.existsSync(file));
}

/**
 * RunReceipt を集める。読むのは3か所で、同じ中身（sha256）は1件に数える。
 *
 *   1. dir 直下の *.json（従来の置き場）
 *   2. dir/index.jsonl（Job の決着時に積んだ索引）が指す RunReceipt。索引の sha256 と
 *      一致しないものは数えない（書き換わった記録を、決着時の記録として扱わない）
 *   3. projectDirs の canvas/harness-runs/<job>/run-receipt.json（読み取り専用）
 *
 * 索引が指す先が消えていた（canvas を片づけた）ものは missing として数え、unreadable に混ぜない。
 */
export function loadReceipts(dir = defaultReceiptsDir(), { projectDirs = [], includeIndex = true } = {}) {
  const out = [];
  const seen = new Set();
  const push = (file, loaded, source) => {
    if (loaded.missing) { out.push({ file, source, missing: true }); return; }
    if (loaded.digest && seen.has(loaded.digest)) return;
    if (loaded.digest) seen.add(loaded.digest);
    if (loaded.error) { out.push({ file, source, error: loaded.error }); return; }
    // finalize していない記録は集計に混ぜない。途中で落ちた実行を
    // 「ゲートが1件も落ちなかった実行」として数えると、失敗率が下がって見える。
    if (loaded.receipt?.finalized === true) out.push({ file, source, receipt: loaded.receipt, sha256: loaded.digest });
  };
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith(".json")) continue;
      push(name, readReceiptBytes(path.join(dir, name)), "dir");
    }
    const indexPath = path.join(dir, "index.jsonl");
    if (includeIndex && fs.existsSync(indexPath)) {
      for (const row of readReceiptIndex(indexPath).rows) {
        if (typeof row?.receiptPath !== "string" || !row.receiptPath) continue;
        const file = row.receiptPath;
        const loaded = readReceiptBytes(file);
        if (!loaded.missing && loaded.digest && row.receiptSha256 && loaded.digest !== row.receiptSha256) {
          out.push({ file, source: "index", error: "索引の sha256 と一致しない（決着後に書き換わった）" });
          continue;
        }
        push(file, loaded, "index");
      }
    }
  }
  for (const projectDir of projectDirs) {
    for (const file of projectReceiptPaths(projectDir)) push(file, readReceiptBytes(file), "project");
  }
  return out;
}

/**
 * ハーネスの版ごとに、ゲートの落ち方を並べる。
 * 版をまたいで混ぜない——混ぜると、直した後も古い失敗が率に残り、
 * 改善したことも悪化したことも見えなくなる。
 */
export function rollup(entries, { harnessId = null } = {}) {
  const byBuild = new Map();
  let unreadable = 0;
  let missing = 0;
  for (const entry of entries) {
    if (entry.missing) { missing += 1; continue; }
    if (entry.error) { unreadable += 1; continue; }
    const receipt = entry.receipt;
    const harness = receipt.harnessBuild?.harness;
    if (!harness) { unreadable += 1; continue; }
    if (harnessId && harness.id !== harnessId) continue;
    const key = `${harness.id}@${harness.version}+${harness.declarationDigest.slice(0, 12)}`;
    if (!byBuild.has(key)) {
      byBuild.set(key, {
        harnessId: harness.id,
        harnessVersion: harness.version,
        declarationDigest: harness.declarationDigest.slice(0, 12),
        runs: 0,
        passed: 0,
        failed: 0,
        outcomeOverridden: 0,
        gates: {},
        skillOverlays: new Set(),
      });
    }
    const bucket = byBuild.get(key);
    bucket.runs += 1;
    if (receipt.outcome === "pass") bucket.passed += 1; else bucket.failed += 1;
    if (receipt.outcomeOverridden) bucket.outcomeOverridden += 1;
    for (const [gateId, gate] of Object.entries(receipt.gates || {})) {
      const stat = bucket.gates[gateId] || (bucket.gates[gateId] = { pass: 0, fail: 0, skip: 0, notInForce: 0 });
      // 当時の契約にまだ無かった保証は、この版の弱点ではない。skip に混ぜると、
      // 過去作を記録し直しただけで「測れていないゲート」の上位に並ぶ。
      const key = isGateNotInForce(gate) ? "notInForce" : gate.verdict;
      if (stat[key] !== undefined) stat[key] += 1;
    }
    for (const skill of Object.values(receipt.harnessBuild?.genreSkills || {})) {
      if (skill.learnedOverlay) bucket.skillOverlays.add(skill.learnedOverlay.slice(0, 12));
    }
  }

  const builds = [...byBuild.values()].map((bucket) => ({
    ...bucket,
    skillOverlays: [...bucket.skillOverlays],
    // 落ちる場所の順位。ここが自己改善の狙い先になる。
    worstGates: Object.entries(bucket.gates)
      .map(([id, stat]) => ({ id, ...stat, failRate: bucket.runs > 0 ? stat.fail / bucket.runs : 0 }))
      .filter((gate) => gate.fail > 0 || gate.skip > 0)
      .sort((a, b) => b.failRate - a.failRate || b.skip - a.skip),
  }));

  return { builds, receiptCount: entries.filter((entry) => !entry.missing).length, unreadable, missing };
}

function displayPath(value) {
  const rel = path.relative(REPO_ROOT, value);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : value;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { args[key] = next; i += 1; } else { args[key] = true; }
  }
  return args;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const dir = args.dir ? path.resolve(String(args.dir)) : defaultReceiptsDir();
  const projectDirs = typeof args["project-dir"] === "string" ? [path.resolve(String(args["project-dir"]))] : [];
  const entries = loadReceipts(dir, { projectDirs });

  switch (command) {
    case "list": {
      print({
        dir: displayPath(dir),
        ...(projectDirs.length ? { projectDirs: projectDirs.map(displayPath) } : {}),
        count: entries.length,
        receipts: entries.map((entry) => entry.missing
          ? { file: entry.file, source: entry.source, missing: true }
          : entry.error
          ? { file: entry.file, source: entry.source, error: entry.error }
          : {
            source: entry.source,
            file: entry.file,
            harness: entry.receipt.harnessBuild.harness.id,
            version: entry.receipt.harnessBuild.harness.version,
            outcome: entry.receipt.outcome,
            overridden: entry.receipt.outcomeOverridden,
            failedGates: entry.receipt.summary?.failedGates || [],
          }),
      });
      break;
    }
    case "rollup": {
      print(rollup(entries, { harnessId: args.harness ? String(args.harness) : null }));
      break;
    }
    case "export": {
      // プラットフォームへ返す形。1件でも redact に失敗したら書かない——
      // 部分的に伏せた記録を返すより、返さない方が安全。
      const redacted = entries.filter((entry) => entry.receipt).map((entry) => redactForPlatform(entry.receipt));
      const payload = { version: "harness-platform-rollup-v1", receiptCount: redacted.length, receipts: redacted };
      if (args.out) {
        const target = path.resolve(String(args.out));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
        print({ wrote: displayPath(target), receiptCount: redacted.length });
      } else {
        print(payload);
      }
      break;
    }
    default:
      process.stdout.write([
        "使い方:",
        "  node scripts/harness-receipts.mjs list                    記録の一覧",
        "  node scripts/harness-receipts.mjs rollup [--harness ID]   版ごとのゲート失敗率",
        "  node scripts/harness-receipts.mjs export [--out PATH]     プラットフォームへ返す形",
        "",
        "  既定の置き場: 学習の状態の置き場の receipts/（索引 index.jsonl が指す RunReceipt も読む）",
        "  --dir DIR           置き場を指定する",
        "  --project-dir DIR   DIR/canvas/harness-runs/*/run-receipt.json も読む（読み取り専用）",
        "",
      ].join("\n"));
      if (command && command !== "help") process.exitCode = 2;
  }
}

if (isDirectCli(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
