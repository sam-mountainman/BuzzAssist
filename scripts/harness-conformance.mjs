#!/usr/bin/env node
// ジャンル別ハーネスが上位ハーネスの条件をそろえているかを表にする（読むだけ）。
//
//   node scripts/harness-conformance.mjs            表（Markdown）と、そろっていない所の一覧
//   node scripts/harness-conformance.mjs --json     同じ中身を JSON で
//   node scripts/harness-conformance.mjs --strict   必須の条件が × のハーネスがあれば終了コード 1
//
// 条件と判定の決め方は lib/harnessConformance.mjs。直す順は docs/harness-upgrade-audit-2026-10-29-ja.md。

import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import { conformanceMarkdown, harnessConformanceReport } from "../lib/harnessConformance.mjs";

export async function runHarnessConformanceCli(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const flags = new Set(argv);
  for (const flag of flags) {
    if (!["--json", "--strict", "--help", "-h"].includes(flag)) throw new Error(`知らない引数: ${flag}`);
  }
  if (flags.has("--help") || flags.has("-h")) {
    stdout.write("node scripts/harness-conformance.mjs [--json] [--strict]\n");
    return 0;
  }
  const report = await harnessConformanceReport();
  if (flags.has("--json")) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const lines = [conformanceMarkdown(report), ""];
    for (const row of report.rows) {
      if (row.gaps.length === 0) continue;
      lines.push(`${row.harnessId}${row.conforms ? "" : "（必須の条件が欠けている）"}:`);
      for (const gap of row.gaps) lines.push(`  ${gap.mark} ${gap.label}${gap.required ? "" : "（任意）"}: ${gap.detail}`);
    }
    stdout.write(`${lines.join("\n")}\n`);
  }
  return flags.has("--strict") && !report.conforms ? 1 : 0;
}

if (isDirectCli(import.meta.url)) {
  runHarnessConformanceCli().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
