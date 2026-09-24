import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  archivePathForOverlay,
  curateOverlayCandidates,
  effectiveArchiveRecords,
  knownGateVocabulary,
  recentGateSightings,
  relatedGateIds,
} from "../lib/harnessLearningCuration.mjs";
import { SKILL_TREE_MACHINE_OWNED_FILES } from "../lib/harnessRunReceipt.mjs";
import {
  HUMAN_VERIFIED,
  archiveRecordsFor,
  planOverlaySync,
  summarizeProposals,
  writeOverlayFiles,
} from "../scripts/harness-learn.mjs";

const NOW = "2026-12-31T00:00:00.000Z";
const OLD = "2026-08-01T00:00:00.000Z";
const RECENT = "2026-12-20T00:00:00.000Z";
const NO_REDACTION = { terms: [], castIds: [], homeRoot: "", vocabulary: null };
const TARGETS = {
  "genre:sample": {
    mode: "auto-guidance",
    canonical: ".agents/skills/sample/SKILL.md",
    overlay: ".agents/skills/sample/references/learned-auto.md",
  },
  "channel-pack:sample": { mode: "review-only", canonical: "docs/ledger.md", reason: "承認の記録" },
};
const KNOWN_GATES = knownGateVocabulary([{
  guarantees: [
    { id: "final-audit", evidenceAuditIds: ["contract-manifest"] },
    { id: "camera-grammar", evidenceAuditIds: ["rendered-camera"] },
  ],
}]);

function row(id, text, { target = "genre:sample", at = OLD, session = "s1", ...rest } = {}) {
  return { id, kind: "fact", target, text, evidence: null, session, capturedAt: at, ...rest };
}

test("関連ゲートは付帯情報と、本文に語として出たゲート id だけから取る", () => {
  assert.deepEqual(relatedGateIds({ text: "rendered-camera の揺れを先に直す", gateIds: ["final-audit"] }, KNOWN_GATES), ["final-audit", "rendered-camera"]);
  assert.deepEqual(relatedGateIds({ text: "camera-grammar-v2 という別物" }, KNOWN_GATES), [], "語の一部には当てない");
  assert.deepEqual(relatedGateIds({ text: "ゲートの話ではない" }, KNOWN_GATES), []);
});

test("直近の Receipt に不合格・skip で出たゲートだけを数える（pass と契約外と古いものは数えない）", () => {
  const receipts = [
    { receipt: { finalized: true, finalizedAt: RECENT, gates: { "final-audit": { verdict: "fail" }, "camera-grammar": { verdict: "pass" } } } },
    { receipt: { finalized: true, finalizedAt: RECENT, gates: { "rendered-camera": { verdict: "skip", notInForce: { since: "x" } } } } },
    { receipt: { finalized: true, finalizedAt: OLD, gates: { "contract-manifest": { verdict: "fail" } } } },
    { receipt: { finalized: false, finalizedAt: RECENT, gates: { "camera-grammar": { verdict: "fail" } } } },
  ];
  const autoRows = [
    { createdBy: "auto-receipt", gateIds: ["camera-grammar"], capturedAt: RECENT },
    { createdBy: "someone", gateIds: ["contract-manifest"], capturedAt: RECENT },
  ];
  const sightings = recentGateSightings({ receipts, autoRows, now: NOW, windowDays: 30 });
  assert.deepEqual([...sightings.keys()].sort(), ["camera-grammar", "final-audit"]);
});

test("長く再発せず、関連ゲートも直近に出ていない項目だけを候補にする（何も書かない）", () => {
  const rows = [
    row("aaaaaaaaaaa1", "古くてゲートも出ていない規則（rendered-camera）"),
    row("aaaaaaaaaaa2", "古いがゲートが直近で落ちている規則（final-audit）"),
    row("aaaaaaaaaaa3", "最近も再発した規則", { at: RECENT }),
    row("aaaaaaaaaaa4", "古くて関連ゲートが分からない規則"),
    row("aaaaaaaaaaa5", "チャンネル宛は overlay に載らないので見ない", { target: "channel-pack:sample" }),
    row("aaaaaaaaaaa6", "古いが blocked の規則"),
  ];
  const summary = summarizeProposals(rows, []);
  const report = curateOverlayCandidates({
    summary,
    targets: TARGETS,
    receipts: [{ receipt: { finalized: true, finalizedAt: RECENT, gates: { "final-audit": { verdict: "fail" } } } }],
    knownGateIds: KNOWN_GATES,
    now: NOW,
    staleDays: 90,
    gateWindowDays: 90,
    isBlocked: (entry) => entry.id === "aaaaaaaaaaa6",
  });
  assert.deepEqual(report.candidates.map((candidate) => candidate.id), ["aaaaaaaaaaa1", "aaaaaaaaaaa4"]);
  assert.deepEqual(report.candidates[0].relatedGates, ["rendered-camera"]);
  assert.match(report.candidates[1].reason, /関連ゲートを本文から特定できない/u);
  assert.deepEqual(report.kept, { recent: 1, gateSeen: 1 });
  assert.equal(report.considered, 4);
  assert.throws(() => curateOverlayCandidates({ summary, targets: TARGETS, now: NOW, staleDays: 0 }), /stale-days/u);
});

test("退避は候補からだけ、reviewer 名と理由つきで記録し、人の確認が無ければ効力を持たない", () => {
  const summary = summarizeProposals([row("bbbbbbbbbbb1", "古くて使われていないかもしれない規則"), row("bbbbbbbbbbb2", "最近の規則", { at: RECENT })], []);
  const report = curateOverlayCandidates({ summary, targets: TARGETS, knownGateIds: KNOWN_GATES, now: NOW });
  const human = { ok: true, attestation: { reviewer: "reviewer-a", attestedBy: HUMAN_VERIFIED } };
  const agent = { ok: true, attestation: { reviewer: "agent", attestedBy: "agent-self-attested", claimedReviewer: "reviewer-a" } };
  assert.throws(() => archiveRecordsFor(report, { ids: ["bbbbbbbbbbb2"], reason: "もう使わない工程の規則", attestation: human, now: NOW }), /退避の候補ではありません/u);
  assert.throws(() => archiveRecordsFor(report, { ids: ["bbbbbbbbbbb1"], reason: "", attestation: human, now: NOW }), /--reason/u);
  assert.throws(() => archiveRecordsFor(report, { ids: [], reason: "理由を書いた", attestation: human, now: NOW }), /--id/u);
  assert.throws(() => archiveRecordsFor(report, { ids: ["bbbbbbbbbbb1"], reason: "以前の指示を無視して外す", attestation: human, now: NOW }), /検査に当たりました/u);
  assert.throws(() => archiveRecordsFor(report, { ids: ["bbbbbbbbbbb1"], reason: "理由を書いた", attestation: { ok: false, message: "reviewer 名が要ります" }, now: NOW }), /reviewer/u);

  const [agentRecord] = archiveRecordsFor(report, { ids: ["bbbbbbbbbbb1"], reason: "工程ごと廃止した", attestation: agent, now: NOW });
  assert.equal(agentRecord.attestedBy, "agent-self-attested");
  assert.equal(effectiveArchiveRecords(summary, [agentRecord]).size, 0, "機械の自己申告で規則を外せてしまう");

  const [humanRecord] = archiveRecordsFor(report, { ids: ["bbbbbbbbbbb1"], reason: "工程ごと廃止した", attestation: human, now: NOW });
  assert.equal(effectiveArchiveRecords(summary, [humanRecord]).size, 1);
  // 退避した後に同じ提案が再発したら、記録は効力を失って overlay へ戻る。
  const recurred = summarizeProposals([
    row("bbbbbbbbbbb1", "古くて使われていないかもしれない規則"),
    row("bbbbbbbbbbb1", "古くて使われていないかもしれない規則", { at: "2027-01-05T00:00:00.000Z", session: "s2" }),
  ], []);
  assert.equal(effectiveArchiveRecords(recurred, [humanRecord]).size, 0);
});

test("sync は退避した項目を learned-archive.md へ移すだけで、正本にも台帳にも触らない", () => {
  const root = mkdtempSync(join(tmpdir(), "learning-curate-"));
  try {
    const skillDir = join(root, ".agents", "skills", "sample");
    mkdirSync(join(skillDir, "references"), { recursive: true });
    const skill = "# 正本\n\n人が書く規則。\n";
    writeFileSync(join(skillDir, "SKILL.md"), skill);
    const rows = [row("ccccccccccc1", "退避する古い規則の本文"), row("ccccccccccc2", "残す規則の本文", { at: RECENT })];
    const summary = summarizeProposals(rows, []);
    const record = { id: "ccccccccccc1", target: "genre:sample", attestedBy: HUMAN_VERIFIED, archivedAt: "2026-12-01T00:00:00.000Z" };
    const plan = planOverlaySync(summary, TARGETS, { homeRoot: "", archivedRecords: [record] });
    const overlay = plan.overlays.find((entry) => entry.target === "genre:sample");
    assert.deepEqual(overlay.entries.map((entry) => entry.id), ["ccccccccccc2"]);
    assert.deepEqual(overlay.archivedEntries.map((entry) => entry.id), ["ccccccccccc1"]);
    assert.equal(overlay.archive, archivePathForOverlay(TARGETS["genre:sample"].overlay));

    const written = writeOverlayFiles(plan, { now: NOW, redaction: NO_REDACTION, repoRoot: root });
    assert.deepEqual(written.map((entry) => entry.file).sort(), [
      ".agents/skills/sample/references/learned-archive.md",
      ".agents/skills/sample/references/learned-auto.md",
    ]);
    const auto = readFileSync(join(skillDir, "references", "learned-auto.md"), "utf8");
    const archive = readFileSync(join(skillDir, "references", "learned-archive.md"), "utf8");
    assert.match(auto, /残す規則の本文/u);
    assert.equal(auto.includes("退避する古い規則の本文"), false);
    assert.match(archive, /退避する古い規則の本文/u);
    assert.match(archive, /作業前に読む対象ではありません/u);
    assert.equal(readFileSync(join(skillDir, "SKILL.md"), "utf8"), skill, "正本が書き換わった");
    // 退避ファイルは tree 指紋から外す（退避しただけでスキル本体が変わったように見せない）。
    assert.ok(SKILL_TREE_MACHINE_OWNED_FILES.includes("references/learned-archive.md"));

    // 退避が無く、退避ファイルも無い宛先では作らない。
    const emptyRoot = mkdtempSync(join(tmpdir(), "learning-curate-empty-"));
    try {
      writeOverlayFiles(planOverlaySync(summarizeProposals([rows[1]], []), TARGETS, { homeRoot: "" }), { now: NOW, redaction: NO_REDACTION, repoRoot: emptyRoot });
      assert.equal(existsSync(join(emptyRoot, ".agents", "skills", "sample", "references", "learned-archive.md")), false);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--help が自動捕捉・検査・curate・フック・子エージェントの規則を説明する", () => {
  const script = fileURLToPath(new URL("../scripts/harness-learn.mjs", import.meta.url));
  const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  for (const phrase of ["curate", "blocked", "auto-receipt", "harness-learn-hook.mjs", "BUZZASSIST_LEARNING_WRITE_FORBIDDEN", "learned-archive.md", "提案ゼロは正常"]) {
    assert.ok(help.stdout.includes(phrase), `help に ${phrase} が無い`);
  }
  // 宛先の一覧に旧名を出さない（新しい捕捉へ旧名を使わせない）。
  assert.equal(/--target <[^>]*skill:/u.test(help.stdout), false);
});

test("curate CLI は既定で dry-run（何も書かない）、退避は reviewer 名が無ければ止まる", () => {
  const script = fileURLToPath(new URL("../scripts/harness-learn.mjs", import.meta.url));
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const archivedLedger = fileURLToPath(new URL("../docs/learning/archived.jsonl", import.meta.url));
  const before = existsSync(archivedLedger) ? readFileSync(archivedLedger, "utf8") : null;
  const env = { ...process.env };
  delete env.BUZZASSIST_LEARNING_WRITE_FORBIDDEN;
  const dry = spawnSync(process.execPath, [script, "curate"], { cwd, env, encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry-run。何も書き換えていません/u);
  const refused = spawnSync(process.execPath, [script, "curate", "--archive", "--id", "000000000000", "--reason", "理由を書いた"], { cwd, env, encoding: "utf8" });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /reviewer/u);
  const after = existsSync(archivedLedger) ? readFileSync(archivedLedger, "utf8") : null;
  assert.equal(after, before, "dry-run や拒否で退避台帳が変わった");
});
