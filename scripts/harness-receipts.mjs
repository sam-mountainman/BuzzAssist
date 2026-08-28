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

import fs from "node:fs";
import path from "node:path";

import { redactForPlatform } from "../lib/harnessRunReceipt.mjs";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DEFAULT_RECEIPT_DIR = path.join(REPO_ROOT, "docs", "learning", "receipts");

export function loadReceipts(dir = DEFAULT_RECEIPT_DIR) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const full = path.join(dir, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
      if (parsed?.finalized === true) out.push({ file: name, receipt: parsed });
      // finalize していない記録は集計に混ぜない。途中で落ちた実行を
      // 「ゲートが1件も落ちなかった実行」として数えると、失敗率が下がって見える。
    } catch {
      out.push({ file: name, error: "読めない JSON" });
    }
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
  for (const entry of entries) {
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
      const stat = bucket.gates[gateId] || (bucket.gates[gateId] = { pass: 0, fail: 0, skip: 0 });
      if (stat[gate.verdict] !== undefined) stat[gate.verdict] += 1;
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

  return { builds, receiptCount: entries.length, unreadable };
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
  const dir = args.dir ? path.resolve(String(args.dir)) : DEFAULT_RECEIPT_DIR;
  const entries = loadReceipts(dir);

  switch (command) {
    case "list": {
      print({
        dir: path.relative(REPO_ROOT, dir),
        count: entries.length,
        receipts: entries.map((entry) => entry.error
          ? { file: entry.file, error: entry.error }
          : {
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
      const redacted = entries.filter((entry) => !entry.error).map((entry) => redactForPlatform(entry.receipt));
      const payload = { version: "harness-platform-rollup-v1", receiptCount: redacted.length, receipts: redacted };
      if (args.out) {
        const target = path.resolve(String(args.out));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
        print({ wrote: path.relative(REPO_ROOT, target), receiptCount: redacted.length });
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
      ].join("\n"));
      if (command && command !== "help") process.exitCode = 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
