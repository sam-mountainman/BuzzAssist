import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createReviewerTrustEntry, generateReviewerKeyPair } from "../lib/koyaReviewAttestation.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 子プロセスの env から reviewer 信頼アンカーを外す（開発機の設定に依存しない）。
function envWithoutReviewerTrust(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const name of ["BUZZASSIST_REVIEWER_TRUST", "BUZZASSIST_REVIEWER_TRUST_JSON", "BUZZASSIST_KOYA_REVIEWER_TRUST", "BUZZASSIST_KOYA_REVIEWER_TRUST_JSON"]) {
    if (!(name in extra)) delete env[name];
  }
  return env;
}

function trustListJson(label) {
  const pair = generateReviewerKeyPair();
  return JSON.stringify({ version: "koya-reviewer-trust-v1", reviewers: [createReviewerTrustEntry({ publicKeyPem: pair.publicKeyPem, label })] });
}

test("official Koya CLI exposes a validated read-only contract command", () => {
  const result = spawnSync("node", ["scripts/koya-manga-video.mjs", "contract", "--project-dir", root], {
    cwd: root, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.version, "koya-manga-production-v51");
  assert.equal(parsed.validation.pass, true);
});

test("official Koya CLI advertises the bounded onset-repair action", () => {
  const result = spawnSync("node", ["scripts/koya-manga-video.mjs", "help"], {
    cwd: root, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /repair-onset/u);
  assert.match(result.stdout, /repair-tail/u);
  assert.match(result.stdout, /adjust-gap/u);
  assert.match(result.stdout, /standard-cut/u);
  assert.match(result.stdout, /plan-path JSON/u);
  assert.match(result.stdout, /target-audible-gap-seconds N/u);
  assert.match(result.stdout, /sync-contract/u);
  assert.match(result.stdout, /refresh-bubbles/u);
  assert.match(result.stdout, /fade-milliseconds 6\.\.8/u);
  assert.match(result.stdout, /protagonist-speaker-id/u);
  assert.match(result.stdout, /character-bible-path/u);
  assert.match(result.stdout, /source-face-review-path JSON/u);
  assert.match(result.stdout, /koya-source-region-review-v2/u);
  assert.match(result.stdout, /character-approve/u);
  assert.match(result.stdout, /character-review-refresh/u);
  assert.match(result.stdout, /character-style-generate/u);
  assert.match(result.stdout, /character-style-record-failure/u);
  assert.match(result.stdout, /character-style-compose/u);
  assert.match(result.stdout, /character-style-select/u);
  assert.match(result.stdout, /handoff-export/u);
  assert.match(result.stdout, /handoff-verify/u);
  assert.match(result.stdout, /handoff-restore/u);
  assert.match(result.stdout, /image-concurrency N\|auto/u);
  assert.match(result.stdout, /qa-concurrency N/u);
  assert.match(result.stdout, /image-fallback-model MODEL/u);
  assert.match(result.stdout, /qa-fallback-provider grok/u);
});

test("F-5: official Koya CLI help names the generic reviewer trust env as the only anchor and the KOYA name as a legacy alias", () => {
  const result = spawnSync("node", ["scripts/koya-manga-video.mjs", "help"], {
    cwd: root, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /BUZZASSIST_REVIEWER_TRUST \(legacy alias BUZZASSIST_KOYA_REVIEWER_TRUST/u);
  assert.match(result.stdout, /--reviewer-trust-path is a cross-check/u);
  assert.match(result.stdout, /reviewer-trust-conflict/u);
  assert.match(result.stdout, /reviewer-trust-unconfigured/u);
  assert.doesNotMatch(result.stdout, /trust list from --reviewer-trust-path or/u, "明示 path が env の代わりになる案内を残さない");
  assert.doesNotMatch(result.stdout, /otherwise comes from BUZZASSIST_KOYA_REVIEWER_TRUST/u, "旧 env 名だけの案内を残さない");
});

test("standalone quality preflight cannot self-certify final quality", () => {
  const result = spawnSync("node", [
    "scripts/audit-manga-quality-harness.mjs",
    "--manifest-path",
    "config/koya-manga-production-contract.json",
    "--stage",
    "final",
  ], { cwd: root, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot self-certify final quality/u);
});

test("R6-F1 / R6-1: Koya full consumes --reviewer-trust-path and stops before any paid generation when the operator trust anchor is missing or conflicts", (t) => {
  const project = mkdtempSync(join(tmpdir(), "koya-cli-full-trust-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const script = join(project, "script.txt");
  writeFileSync(script, "ナレーション: テスト\n", "utf8");
  const operatorTrust = join(project, "operator-trust.json");
  const selfMinted = join(project, "self-minted.json");
  writeFileSync(operatorTrust, trustListJson("operator"), "utf8");
  writeFileSync(selfMinted, trustListJson("self-minted"), "utf8");
  const base = ["scripts/koya-manga-video.mjs", "full", "--project-dir", project, "--episode-id", "ep-trust", "--script-path", script];
  const outerJobMarker = /canonical outer Video Harness Job/u;

  // env 未設定: 明示 path があっても無くても reviewer-trust-unconfigured で止まり、production runner には入らない。
  for (const extra of [[], ["--reviewer-trust-path", operatorTrust]]) {
    const result = spawnSync(process.execPath, [...base, ...extra], { cwd: root, encoding: "utf8", env: envWithoutReviewerTrust() });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /reviewer-trust-unconfigured/u, result.stderr);
    assert.doesNotMatch(result.stderr, outerJobMarker, "有料 production runner（outer Job 検査）へ到達していない");
    assert.doesNotMatch(result.stderr, new RegExp(operatorTrust.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), "拒否理由に path を載せない");
  }
  // env 設定あり + 別内容の --reviewer-trust-path → reviewer-trust-conflict（黙って捨てない・黙ってどちらかを採らない）。
  const conflict = spawnSync(process.execPath, [...base, "--reviewer-trust-path", selfMinted], {
    cwd: root, encoding: "utf8", env: envWithoutReviewerTrust({ BUZZASSIST_REVIEWER_TRUST: operatorTrust }),
  });
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /reviewer-trust-conflict/u, conflict.stderr);
  assert.doesNotMatch(conflict.stderr, outerJobMarker);
  // 新旧 env の食い違いは env-ambiguous。
  const ambiguous = spawnSync(process.execPath, base, {
    cwd: root, encoding: "utf8", env: envWithoutReviewerTrust({ BUZZASSIST_REVIEWER_TRUST: operatorTrust, BUZZASSIST_KOYA_REVIEWER_TRUST: selfMinted }),
  });
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stderr, /reviewer-trust-invalid:env-ambiguous/u, ambiguous.stderr);
  // 整った env + 一致する path: 信頼アンカー preflight は通り、次の（既存の）outer Job 必須検査で止まる。
  // これが「--reviewer-trust-path を消費して照合した」ことの実測。
  const matched = spawnSync(process.execPath, [...base, "--reviewer-trust-path", operatorTrust], {
    cwd: root, encoding: "utf8", env: envWithoutReviewerTrust({ BUZZASSIST_REVIEWER_TRUST: operatorTrust }),
  });
  assert.notEqual(matched.status, 0);
  assert.doesNotMatch(matched.stderr, /reviewer-trust-/u, matched.stderr);
  assert.match(matched.stderr, outerJobMarker, matched.stderr);
});

test("R6-3: unknown Koya CLI flags are reported on stderr instead of being silently accepted", () => {
  const result = spawnSync(process.execPath, ["scripts/koya-manga-video.mjs", "help", "--reviewer-trust-pth", "/x.json", "--bogus"], {
    cwd: root, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /warning: unknown option\(s\) --reviewer-trust-pth, --bogus/u);
  assert.match(result.stdout, /full: --episode-id ID --script-path FILE \[--reviewer-trust-path JSON\]/u, "full の usage に照合用 flag が載る");
  const clean = spawnSync(process.execPath, ["scripts/koya-manga-video.mjs", "help", "--project-dir", root, "--upstream-job-id", "x"], { cwd: root, encoding: "utf8" });
  assert.equal(clean.status, 0);
  assert.doesNotMatch(clean.stderr, /unknown option/u, "既知 flag（usage 外の実装 flag・upstream binding を含む）には警告しない");
});
