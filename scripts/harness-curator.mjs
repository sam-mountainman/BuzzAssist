#!/usr/bin/env node
// セッション後にproposalと確定RunReceiptを読むだけのcurator。
// stdoutへ統合候補を返すが、Skill・台帳・applied.jsonlは変更しない。
//
//   node scripts/harness-curator.mjs                       統合候補report（既定）
//   node scripts/harness-curator.mjs export-public --output docs/learning/proposals.public.jsonl
//   node scripts/harness-curator.mjs export-public --check --output docs/learning/proposals.public.jsonl
//
// export-public は共有ledgerから id/kind/target だけの公開catalogを作る。
// ledger本文（運営者名・顧客path・逐語の根拠）は配布物へ入れず、管理側ingestと
// 運営者側 harness-feedback create はこの公開catalogだけを参照する。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import {
  buildHarnessCuratorReport,
  buildPublicProposalCatalog,
  comparePublicProposalCatalog,
  renderPublicProposalCatalog,
} from "../lib/harnessLearningCurator.mjs";
import { loadHarnessFeedbackImportLedger } from "../lib/harnessFeedbackIngest.mjs";
import { createCanonicalReaders } from "./harness-learn.mjs";
import { loadReceipts } from "./harness-receipts.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUBCOMMANDS = new Set(["report", "export-public"]);

function parseArgs(argv) {
  const out = { command: "report" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (index === 0 && !token.startsWith("--")) {
      if (!SUBCOMMANDS.has(token)) throw new Error(`未知のcommand: ${token}（report | export-public）`);
      out.command = token;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`余分な引数: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else { out[key] = next; index += 1; }
  }
  return out;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`${file}:${index + 1}: ${error.message}`); }
  });
}

/**
 * 公開catalogの生成・検査。書くのは --output を明示したときだけで、
 * 書く先は派生物の公開catalogに限る（ledger・SKILL.md・applied.jsonlには触れない）。
 */
function exportPublicCatalog(args, proposalFiles) {
  const rows = proposalFiles.flatMap(readJsonl);
  const catalog = buildPublicProposalCatalog(rows);
  const rendered = renderPublicProposalCatalog(catalog.entries);
  const outputPath = typeof args.output === "string" ? path.resolve(args.output) : "";
  if (args.check === true) {
    if (!outputPath) throw new Error("--check には比較対象の --output FILE が要る。");
    const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
    const comparison = comparePublicProposalCatalog({ ledgerRows: rows, catalogText: current });
    if (!comparison.ok) process.exitCode = 2;
    return {
      ok: comparison.ok,
      command: "export-public",
      mode: "check",
      catalogPath: outputPath,
      counts: catalog.counts,
      ...comparison,
      hint: comparison.ok ? "" : "node scripts/harness-curator.mjs export-public --output <同じFILE> で再生成する",
    };
  }
  if (!outputPath) {
    process.stdout.write(rendered);
    return null;
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, rendered, "utf8");
  fs.renameSync(temporary, outputPath);
  return {
    ok: true,
    command: "export-public",
    mode: "write",
    catalogPath: outputPath,
    version: catalog.version,
    fields: ["id", "kind", "target"],
    counts: catalog.counts,
    writesCanonical: false,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const proposalFiles = [
    path.join(REPO_ROOT, "docs", "learning", "proposals.jsonl"),
    ...(typeof args.proposals === "string" ? String(args.proposals).split(",").map((value) => path.resolve(value)) : []),
  ];
  if (args.command === "export-public") {
    const result = exportPublicCatalog(args, proposalFiles);
    if (result) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const appliedFiles = [
    path.join(REPO_ROOT, "docs", "learning", "applied.jsonl"),
    ...(typeof args.applied === "string" ? String(args.applied).split(",").map((value) => path.resolve(value)) : []),
  ];
  const proposals = proposalFiles.flatMap(readJsonl);
  const applied = appliedFiles.flatMap(readJsonl);
  const receiptsDir = typeof args.receiptsDir === "string"
    ? path.resolve(args.receiptsDir)
    : path.join(REPO_ROOT, "docs", "learning", "receipts");
  // approved だけでなく revokedAfterApproval も渡す（R2-D2-1）。以前は approved
  // だけを読んでいたので、鍵が後に失効した import は報告から消えていた——
  // 観測数へ数えないのは正しいが、「数えなかったものが何件あるか」も
  // 読む人には要る。分離記録は digest/operator/keyId/revokedAt だけを持つ。
  const importLedger = await loadHarnessFeedbackImportLedger({
    rootDir: typeof args.feedbackIngestRoot === "string"
      ? path.resolve(args.feedbackIngestRoot)
      : path.join(REPO_ROOT, "var", "feedback-ingest"),
  });
  const { readCanonical, hashCanonical } = createCanonicalReaders({ repoRoot: REPO_ROOT });
  const report = buildHarnessCuratorReport({
    proposals,
    applied,
    receipts: loadReceipts(receiptsDir),
    approvedFeedbackImports: importLedger.approved,
    revokedFeedbackImports: importLedger.revokedAfterApproval,
    // harness-learn の status と同じ読み手。channel-pack 宛の記録は、promote / apply が
    // 印を探して sha256 を取ったのと同じく Channel Pack 側を先に読む（ops-7）。
    readCanonical,
    hashCanonical,
    similarityThreshold: args.similarityThreshold ? Number(args.similarityThreshold) : undefined,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (isDirectCli(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
