import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  HARNESS_FEEDBACK_PUBLIC_CATALOG_RELATIVE_PATH,
  parseHarnessFeedbackProposalCatalog,
} from "../lib/harnessFeedbackBundle.mjs";
import {
  PUBLIC_PROPOSAL_CATALOG_KEYS,
  comparePublicProposalCatalog,
} from "../lib/harnessLearningCurator.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function readJsonl(path) {
  return readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

// 公開catalogはledgerからの派生物。ledgerに提案が増えたのにcatalogを再生成
// し忘れると、運営者側では既知のはずの提案が「未登録」になり、管理側では
// 正当なbundleが422で落ちる。乖離をここで止める。
test("同梱する公開catalogは共有ledgerと一致し、本文・根拠・sessionを持たない", () => {
  const catalogPath = join(ROOT, HARNESS_FEEDBACK_PUBLIC_CATALOG_RELATIVE_PATH);
  const ledgerPath = join(ROOT, "docs/learning/proposals.jsonl");
  assert.ok(existsSync(catalogPath), `${HARNESS_FEEDBACK_PUBLIC_CATALOG_RELATIVE_PATH} が無い（export-publicで生成する）`);
  const catalogText = readFileSync(catalogPath, "utf8");
  const ledgerRows = existsSync(ledgerPath) ? readJsonl(ledgerPath) : [];
  const comparison = comparePublicProposalCatalog({ ledgerRows, catalogText });
  assert.deepEqual(
    { missing: comparison.missing, extra: comparison.extra, drift: comparison.drift, renderedMatches: comparison.renderedMatches },
    { missing: [], extra: [], drift: [], renderedMatches: true },
    "node scripts/harness-curator.mjs export-public --output docs/learning/proposals.public.jsonl で再生成すること",
  );
  for (const row of readJsonl(catalogPath)) {
    assert.deepEqual(Object.keys(row), [...PUBLIC_PROPOSAL_CATALOG_KEYS]);
    assert.match(row.target, /^(?:platform|genre):/u);
  }
  // ingestが読む形と同じparserで読めること（IDだけの照合に必要な意味情報が揃っている）。
  const parsed = parseHarnessFeedbackProposalCatalog(catalogText);
  assert.equal(parsed.size, comparison.expectedCount);
  assert.ok(parsed.size > 0);
});

test("export-public --check はledgerとの乖離を非0で報告し、ledger本文を出力へ出さない", () => {
  const run = spawnSync(process.execPath, [
    join(ROOT, "scripts/harness-curator.mjs"), "export-public", "--check",
    "--output", join(ROOT, HARNESS_FEEDBACK_PUBLIC_CATALOG_RELATIVE_PATH),
  ], { cwd: ROOT, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.mode, "check");
  const ledgerRows = readJsonl(join(ROOT, "docs/learning/proposals.jsonl"));
  const sampleText = String(ledgerRows[0]?.text || "").slice(0, 12);
  if (sampleText) assert.equal(run.stdout.includes(sampleText), false);
});

test("package.jsonは公開catalogだけを配布し、本文つきledgerを配布一覧から外している", () => {
  const files = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).files;
  assert.ok(files.includes(HARNESS_FEEDBACK_PUBLIC_CATALOG_RELATIVE_PATH));
  assert.equal(files.includes("docs/learning/proposals.jsonl"), false);
  assert.equal(files.includes("docs/learning/applied.jsonl"), false);
});
