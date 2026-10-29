// ジャンル別ハーネスのそろい具合（lib/harnessConformance.mjs）の試験。宣言とリポジトリの実物だけを読む。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { CONFORMANCE_CONDITIONS, evaluateHarnessConformance, harnessConformanceReport } from "../lib/harnessConformance.mjs";
import { runHarnessConformanceCli } from "../scripts/harness-conformance.mjs";

test("宣言のある全ハーネスが、上位ハーネスの必須の条件を全部そろえている（△ も無い）", async () => {
  const report = await harnessConformanceReport();
  assert.ok(report.rows.length >= 2);
  for (const row of report.rows) {
    const required = row.gaps.filter((gap) => gap.required);
    assert.deepEqual(required.map((gap) => `${gap.condition}: ${gap.detail}`), [], row.harnessId);
    assert.equal(row.conforms, true, row.harnessId);
    // 署名済みの Channel Pack は、宣言の要件と Core の中身の検査の両方がそろっている。
    assert.equal(row.results["signed-channel-pack"].status, "ok", `${row.harnessId}: ${row.results["signed-channel-pack"].detail}`);
  }
});

test("Core に adapter の無いハーネス・宣言の欠けは × と理由で出る（新しいジャンルを足したときに表が教える）", () => {
  const support = { upperAdapters: ["synthetic-a"], packPayloads: ["synthetic-a"], signoffSubjects: ["synthetic-a"], canvasProgress: [] };
  // 試験のファイルにも現れない id（試験の実在の判定に、この試験自身を数えないため）。
  const harnessId = `synthetic-${randomUUID()}`;
  const row = evaluateHarnessConformance({
    harnessId,
    declaration: { id: harnessId, requiresFromOperator: [{ id: "signed-channel-pack" }], guarantees: [{ id: "final-audit", evidenceAuditIds: [] }] },
    capabilities: { harnessId },
    support,
    inventory: { skills: [] },
    learningTargets: {},
  });
  assert.equal(row.conforms, false);
  assert.equal(row.results["upper-adapter"].status, "missing");
  assert.equal(row.results["signed-channel-pack"].status, "partial");
  assert.equal(row.results["script-quality"].status, "missing");
  assert.equal(row.results["guarantee-evidence"].status, "partial");
  assert.equal(row.results["separate-signoff"].status, "missing");
  assert.equal(row.results["canonical-skills"].status, "missing");
  assert.equal(row.results.tests.status, "missing");
  assert.deepEqual(Object.keys(row.results).sort(), CONFORMANCE_CONDITIONS.map((condition) => condition.id).sort());
});

test("CLI: 表を出し、--strict は必須の条件がそろっていれば 0", async () => {
  let out = "";
  const code = await runHarnessConformanceCli(["--strict"], { stdout: { write: (text) => { out += text; } } });
  assert.equal(code, 0, out);
  assert.match(out, /\| 条件 \|/u);
  assert.match(out, /koya-manga-video/u);
  await assert.rejects(runHarnessConformanceCli(["--bogus"], { stdout: { write() {} } }), /知らない引数/u);
});

test("必須の条件の △（署名の照合が Receipt に無い・保証に証拠が無い）でも、そろっていないと判定する", async () => {
  const { readFileSync } = await import("node:fs");
  const declaration = JSON.parse(readFileSync(new URL("../config/harnesses/narrated-story-video.harness.json", import.meta.url), "utf8"));
  const capabilities = JSON.parse(readFileSync(new URL("../config/harnesses/narrated-story-video.capabilities.json", import.meta.url), "utf8"));
  const support = { upperAdapters: ["narrated-story-video"], packPayloads: ["narrated-story-video"], signoffSubjects: ["narrated-story-video"], canvasProgress: [] };
  const broken = structuredClone(declaration);
  broken.reviewAttestation = { subject: "synthetic-unsupported" };
  broken.guarantees = broken.guarantees.map((row) => ({ ...row, evidenceAuditIds: [] }));
  const row = evaluateHarnessConformance({ harnessId: "narrated-story-video", declaration: broken, capabilities, support });
  assert.equal(row.results["separate-signoff"].status, "partial");
  assert.equal(row.results["guarantee-evidence"].status, "partial");
  assert.equal(row.conforms, false);
});
