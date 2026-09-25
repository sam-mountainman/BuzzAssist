import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  STRATEGY_BRIEF_FIELDS,
  STRATEGY_BRIEF_VERSION,
  evidenceStateUpgrades,
  inspectAudienceRun,
  inspectStrategyEvidence,
  normalizeEvidenceRelPath,
  resolveEvidencePath,
  strategySkillFingerprint,
  validateStrategyBrief,
  workDirRelative,
} from "../lib/strategyBrief.mjs";
import {
  evidenceRow,
  metricsOutput,
  referralsOutput,
  sampleBrief,
  snapshotOutput,
  workspace,
  writeAudienceRun,
  writeBytes,
  writeJson,
} from "./helpers/strategyBriefFixture.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("戦略ブリーフの形: 合成の完全なブリーフは通り、欄の誤りと欄どうしの対応の誤りを分けて返す", () => {
  const brief = sampleBrief({
    evidence: [{ id: "e-1", kind: "other", path: "evidence/a.md", sha256: "a".repeat(64), state: "provisional", collected: { at: "2026-09-20", conditions: "合成の条件" } }],
    changes: { previous: null, keep: [{ point: "合成の残す点", evidenceIds: ["e-1"] }], change: [] },
  });
  assert.deepEqual(validateStrategyBrief(brief), { ok: true, issues: [], linkIssues: [] });

  const broken = validateStrategyBrief({ ...brief, version: "v0", extra: 1, question: "短", label: "../r1" });
  assert.equal(broken.ok, false);
  assert.ok(broken.issues.includes("invalid:version"));
  assert.ok(broken.issues.includes("unknown-field:extra"));
  assert.ok(broken.issues.includes("too-short:question"));
  assert.ok(broken.issues.includes("invalid:label"));

  // 回収の無い約束・知らない約束を指す回収・根拠の無い変更点は、欄どうしの対応の誤り。
  const unlinked = validateStrategyBrief({
    ...brief,
    payoffs: [{ promiseId: "p-unknown", where: "合成の回収の箇所" }],
    changes: { previous: null, keep: [], change: [{ point: "合成の変える点", evidenceIds: [] }, { point: "合成の変える点2", evidenceIds: ["e-none"] }] },
  });
  assert.equal(unlinked.ok, false);
  assert.deepEqual(unlinked.issues, []);
  for (const code of [
    "link:payoff-unknown-promise:p-unknown",
    "link:promise-without-payoff:p-title",
    "link:promise-without-payoff:p-opening",
    "link:change-without-evidence:0",
    "link:change-unknown-evidence:e-none",
  ]) assert.ok(unlinked.linkIssues.includes(code), code);
});

test("verified と書く根拠には確かめ方が要り、前提に依らない根拠には理由が要る", () => {
  const base = { id: "e-1", kind: "other", path: "a.md", sha256: "b".repeat(64), collected: { at: "unknown", conditions: "不明" } };
  const verifiedWithout = validateStrategyBrief(sampleBrief({ evidence: [{ ...base, state: "verified" }] }));
  assert.ok(verifiedWithout.issues.includes("missing:evidence[0].verification"));
  const verifiedWith = validateStrategyBrief(sampleBrief({ evidence: [{ ...base, state: "verified", verification: { method: "合成の元データと列を照合した" } }] }));
  assert.deepEqual(verifiedWith.issues, []);
  const independentWithout = validateStrategyBrief(sampleBrief({ evidence: [{ ...base, state: "provisional", premiseBound: false }] }));
  assert.ok(independentWithout.issues.includes("missing:evidence[0].premiseIndependenceReason"));
});

test("公開後の指標は取り出し元の欄の名前だけを受ける（無い欄から数字を作らない）", () => {
  const bad = validateStrategyBrief(sampleBrief({
    postPublish: { metrics: [{ id: "m-1", source: "metrics", metric: "avd_seconds", comparison: { format: "long", window: "first_7d", traffic_source: "browse", metric_definition: "x" }, expectation: "合成の期待" }] },
  }));
  assert.ok(bad.issues.includes("invalid:postPublish.metrics[0].metric"));
  const video = validateStrategyBrief(sampleBrief({
    postPublish: { metrics: [{ id: "m-1", source: "metrics", metric: "ctr_pct", videoId: "SYNTHVID001", comparison: { format: "long", window: "first_7d", traffic_source: "browse", metric_definition: "x" }, expectation: "合成の期待" }] },
  }));
  assert.deepEqual(video.issues, []);
  const referrals = validateStrategyBrief(sampleBrief({
    postPublish: { metrics: [{ id: "m-1", source: "referrals", metric: "external_share_pct", context: { format: "long" }, expectation: "合成の期待" }] },
  }));
  assert.deepEqual(referrals.issues, []);
});

test("スキーマの欄と検査の欄が一致する", async () => {
  const schema = JSON.parse(await readFile(path.join(REPO_ROOT, "config", "strategy-brief.schema.json"), "utf8"));
  assert.equal(schema.properties.version.const, STRATEGY_BRIEF_VERSION);
  const keys = (object) => Object.keys(object.properties).sort();
  assert.deepEqual(keys(schema), [...STRATEGY_BRIEF_FIELDS.top].sort());
  assert.deepEqual(keys(schema.properties.channel), [...STRATEGY_BRIEF_FIELDS.channel].sort());
  assert.deepEqual(keys(schema.properties.audience), [...STRATEGY_BRIEF_FIELDS.audience].sort());
  assert.deepEqual(keys(schema.properties.entry), [...STRATEGY_BRIEF_FIELDS.entry].sort());
  assert.deepEqual(keys(schema.properties.entry.properties.promises.items), [...STRATEGY_BRIEF_FIELDS.promise].sort());
  assert.deepEqual(keys(schema.properties.payoffs.items), [...STRATEGY_BRIEF_FIELDS.payoff].sort());
  assert.deepEqual(keys(schema.$defs.evidence), [...STRATEGY_BRIEF_FIELDS.evidence].sort());
  assert.deepEqual(keys(schema.$defs.evidence.properties.collected), [...STRATEGY_BRIEF_FIELDS.collected].sort());
  assert.deepEqual(keys(schema.$defs.evidence.properties.collected.properties.premise), [...STRATEGY_BRIEF_FIELDS.collectedPremise].sort());
  assert.deepEqual(keys(schema.$defs.evidence.properties.verification), [...STRATEGY_BRIEF_FIELDS.verification].sort());
  assert.deepEqual(keys(schema.properties.changes), [...STRATEGY_BRIEF_FIELDS.changes].sort());
  assert.deepEqual(keys(schema.properties.changes.properties.previous.oneOf[1]), [...STRATEGY_BRIEF_FIELDS.previous].sort());
  assert.deepEqual(keys(schema.$defs.changePoint), [...STRATEGY_BRIEF_FIELDS.changePoint].sort());
  assert.deepEqual(keys(schema.properties.production), [...STRATEGY_BRIEF_FIELDS.production].sort());
  assert.deepEqual(keys(schema.properties.postPublish), [...STRATEGY_BRIEF_FIELDS.postPublish].sort());
  assert.deepEqual(keys(schema.$defs.metric), [...STRATEGY_BRIEF_FIELDS.metric].sort());
  assert.deepEqual(keys(schema.$defs.metric.properties.expected), [...STRATEGY_BRIEF_FIELDS.expected].sort());
  assert.deepEqual(keys(schema.properties.provenance), [...STRATEGY_BRIEF_FIELDS.provenance].sort());
  assert.deepEqual(keys(schema.properties.provenance.properties.strategySkill), [...STRATEGY_BRIEF_FIELDS.strategySkill].sort());
});

test("根拠のパスは作業フォルダからの相対だけ。Windows の区切りは / へそろえ、ドライブ名と .. は拒む", () => {
  assert.deepEqual(normalizeEvidenceRelPath("evidence\\metrics.json").rel, "evidence/metrics.json");
  assert.deepEqual(normalizeEvidenceRelPath("./evidence/./metrics.json").rel, "evidence/metrics.json");
  for (const value of ["C:\\work\\metrics.json", "c:/work/metrics.json", "/work/metrics.json", "\\\\server\\share\\m.json", "../outside.json", "evidence/../../x.json", ""]) {
    assert.equal(normalizeEvidenceRelPath(value).ok, false, value);
  }
  const root = path.resolve("work-root");
  const resolved = resolveEvidencePath(root, "evidence\\run-001\\report-manifest.json");
  assert.equal(resolved.full, path.join(root, "evidence", "run-001", "report-manifest.json"));
  assert.equal(resolved.rel, "evidence/run-001/report-manifest.json");
  assert.throws(() => resolveEvidencePath(root, "..\\x.json"), { code: "strategy-evidence-path-invalid" });
  assert.equal(workDirRelative(root, path.join(root, "evidence", "m.json")), "evidence/m.json");
  assert.equal(workDirRelative(root, path.join(path.dirname(root), "m.json")), null);
});

test("根拠のファイルを sha256 と形で照合する（指標・関連元・取得スナップショット）", async (t) => {
  const root = await workspace(t);
  const metrics = await writeJson(root, "evidence/metrics.json", metricsOutput());
  const referrals = await writeJson(root, "evidence/referrals.json", referralsOutput());
  const snapshot = await writeJson(root, "evidence/snapshot.json", snapshotOutput());
  const notMetrics = await writeJson(root, "evidence/not-metrics.json", { schema_version: "9" });

  const ok = await inspectStrategyEvidence(root, evidenceRow(metrics, { kind: "metrics" }));
  assert.equal(ok.sha256Matches, true);
  assert.equal(ok.format, "ok");
  assert.deepEqual(ok.reasonCodes, []);
  assert.deepEqual((await inspectStrategyEvidence(root, evidenceRow(referrals, { kind: "referrals" }))).reasonCodes, []);
  assert.deepEqual((await inspectStrategyEvidence(root, evidenceRow(snapshot, { kind: "snapshot" }))).reasonCodes, []);
  assert.deepEqual((await inspectStrategyEvidence(root, evidenceRow(notMetrics, { kind: "metrics" }))).reasonCodes, ["strategy-evidence-metrics-format"]);

  const changed = await inspectStrategyEvidence(root, { ...evidenceRow(metrics, { kind: "metrics" }), sha256: "0".repeat(64) });
  assert.deepEqual(changed.reasonCodes, ["strategy-evidence-changed"]);
  const missing = await inspectStrategyEvidence(root, { ...evidenceRow(metrics, { kind: "metrics" }), path: "evidence/none.json" });
  assert.deepEqual(missing.reasonCodes, ["strategy-evidence-missing"]);
  const escaped = await inspectStrategyEvidence(root, { ...evidenceRow(metrics, { kind: "metrics" }), path: "..\\metrics.json" });
  assert.deepEqual(escaped.reasonCodes, ["strategy-evidence-path-invalid"]);
});

test("4分析の run は report-manifest.json が今の結果と一致するときだけ current", async (t) => {
  const root = await workspace(t);
  const run = await writeAudienceRun(root, "evidence/run-001");
  const current = await inspectAudienceRun(run.runDir);
  assert.equal(current.status, "current", JSON.stringify(current.reasons));
  assert.deepEqual(current.completeStages, ["scenario", "taka", "yako", "emotion"]);
  assert.equal(current.reportManifestSha256, run.reportManifestSha256);

  const row = { id: "e-run", kind: "audience-run", path: "evidence/run-001", sha256: run.reportManifestSha256, state: "provisional", collected: { at: "2026-09-20", conditions: "合成" } };
  assert.deepEqual((await inspectStrategyEvidence(root, row)).reasonCodes, []);

  // シナリオの結果を差し替えた（再分析の後にレポートを作り直していない）→ stale。
  const receipt = JSON.parse(await readFile(path.join(run.runDir, "completed", "scenario.json"), "utf8"));
  await writeFile(path.join(run.runDir, "results", receipt.result_file), "# 差し替えた合成の本文\n");
  const stale = await inspectAudienceRun(run.runDir);
  assert.equal(stale.status, "stale");
  assert.ok(stale.reasons.some((reason) => reason.startsWith("audience-run-stage-result-changed:scenario")));
  const staleRow = await inspectStrategyEvidence(root, row);
  assert.ok(staleRow.reasonCodes.includes("strategy-evidence-audience-run-stale"));
});

test("4分析の run: レポートの後に完了した分析・取得スナップショットの変更・レポートの欠落を見分ける", async (t) => {
  const root = await workspace(t);
  const partial = await writeAudienceRun(root, "runs/partial", { stages: ["scenario", "taka"] });
  assert.equal((await inspectAudienceRun(partial.runDir)).status, "current");
  await writeJson(partial.runDir, "completed/yako.json", { stage: "yako" });
  const late = await inspectAudienceRun(partial.runDir);
  assert.equal(late.status, "stale");
  assert.ok(late.reasons.includes("audience-run-stage-completed-after-report:yako"));

  const snap = await writeAudienceRun(root, "runs/snap");
  await writeBytes(snap.runDir, "snapshot.json", Buffer.from("{}\n"));
  assert.deepEqual((await inspectAudienceRun(snap.runDir)).reasons, ["audience-run-snapshot-changed"]);

  const none = await writeAudienceRun(root, "runs/none");
  await rm(path.join(none.runDir, "report.md"));
  await rm(path.join(none.runDir, "report-manifest.json"));
  assert.equal((await inspectAudienceRun(none.runDir)).status, "none");
  assert.equal((await inspectAudienceRun(path.join(root, "runs", "missing"))).status, "invalid");
});

test("前の版から確かさが上がった根拠を見つける", () => {
  const row = { id: "e-1", kind: "other", path: "a.md", sha256: "c".repeat(64), state: "provisional", collected: { at: "unknown", conditions: "不明" } };
  const before = sampleBrief({ evidence: [row] });
  const after = sampleBrief({ evidence: [{ ...row, state: "verified", verification: { method: "合成の照合" } }] });
  assert.deepEqual(evidenceStateUpgrades(before, after), [{ id: "e-1", from: "provisional", to: "verified", sameFile: true }]);
  assert.deepEqual(evidenceStateUpgrades(after, before), []);
});

test("戦略の道具の版の指紋は実行に使うファイルの sha256 の集合から作り、キャッシュと評価の記録は入れない", async (t) => {
  const root = await workspace(t, "strategy-skill-");
  await writeBytes(root, "SKILL.md", Buffer.from("合成のスキル\n"));
  await writeBytes(root, "scripts/tool.py", Buffer.from("print('synthetic')\n"));
  await writeBytes(root, "references/a.md", Buffer.from("合成の参照\n"));
  await writeBytes(root, "evals/case.json", Buffer.from("{}\n"));
  await writeBytes(root, "scripts/__pycache__/tool.cpython-311.pyc", Buffer.from("x"));
  const first = await strategySkillFingerprint(root);
  assert.match(first.fingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(first.fileCount, 3);
  assert.deepEqual(first.files.map((row) => row.path), ["SKILL.md", "references/a.md", "scripts/tool.py"]);
  // 評価の記録を変えても指紋は変わらず、実行に使うファイルを変えると変わる。
  await writeBytes(root, "evals/case.json", Buffer.from("{\"changed\":true}\n"));
  assert.equal((await strategySkillFingerprint(root)).fingerprint, first.fingerprint);
  await writeBytes(root, "scripts/tool.py", Buffer.from("print('changed')\n"));
  assert.notEqual((await strategySkillFingerprint(root)).fingerprint, first.fingerprint);
});
