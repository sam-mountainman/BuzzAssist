import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  computeHarnessBuild,
  finalizeRunReceipt,
  auditStepsFromCheckMap,
  openRunReceipt,
  recordApproval,
  recordGate,
  recordGatesFromAuditChecks,
  recordImageRetry,
  recordPaidMediaJob,
  recordResumeFromFailed,
  recordRunArtifact,
  redactForPlatform,
  writeRunReceipt,
} from "../lib/harnessRunReceipt.mjs";
import { rollup } from "../scripts/harness-receipts.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const NOW = "2026-08-29T12:00:00.000Z";

function openManga() {
  return openRunReceipt({
    projectDir: root,
    harnessId: "koya-manga-video",
    entrypoint: "scripts/koya-manga-video.mjs",
    action: "render",
    inputs: { script: "台本の本文" },
  });
}

test("ハーネスの指紋は3層を別々に取る", () => {
  const build = computeHarnessBuild({ projectDir: root, harnessId: "koya-manga-video" });
  assert.equal(build.harness.id, "koya-manga-video");
  assert.match(build.harness.declarationDigest, /^[0-9a-f]{64}$/u);
  assert.match(build.productionDependencies.runtime.digest, /^[0-9a-f]{64}$/u);
  assert.match(build.productionDependencies.deployment.digest, /^[0-9a-f]{64}$/u);
  assert.ok(build.productionDependencies.runtime.fileCount > 0);
  assert.ok(build.declaredGates.length > 0, "宣言された保証がゲート一覧になること");
  // キーの有無だけを見ていたせいで、**全スキルの指紋が null のまま**
  // このテストが通っていた。宣言が完全相対パスなのにスキル名として扱って
  // いたのが原因。形ではなく中身を見る。
  const skillNames = Object.keys(build.genreSkills);
  assert.ok(skillNames.length > 0, "ジャンルスキルの指紋が取れること");
  for (const [name, skill] of Object.entries(build.genreSkills)) {
    assert.match(skill.tree || "", /^[0-9a-f]{64}$/u, `${name}: スキル本体の指紋が実体でない`);
    assert.ok(skill.fileCount > 0, `${name}: 0ファイルを畳んだ指紋になっている`);
    assert.equal(name.includes("/"), false, `${name}: 宣言のパスがそのままキーになっている`);
  }
  assert.match(build.platform["lib/harnessRouting.mjs"] || "", /^[0-9a-f]{64}$/u, "プラットフォーム層の指紋が実体であること");
  assert.match(build.platform["lib/paidMediaJobBroker.mjs"] || "", /^[0-9a-f]{64}$/u, "課金brokerの版がReceiptへ入ること");
  assert.match(build.platform["lib/videoHarnessJob.mjs"] || "", /^[0-9a-f]{64}$/u, "durable Jobの版がReceiptへ入ること");
  assert.match(build.platform["lib/canvasRunProjection.mjs"] || "", /^[0-9a-f]{64}$/u, "Canvas投影の版がReceiptへ入ること");
  // 層を混ぜた1つのハッシュだと、どこを直して結果が変わったのか読めない。
  assert.notEqual(
    JSON.stringify(build.genreSkills),
    JSON.stringify(build.platform),
    "ジャンル層とプラットフォーム層が別枠であること",
  );
});

test("記録は入力の本文を持たない", () => {
  const receipt = openManga();
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes("台本の本文"), false, "台本本文が記録に残らないこと");
  assert.match(receipt.inputDigests.script, /^[0-9a-f]{64}$/u);
});

test("承認種別を分け、人間承認の自己申告を受け取らない", () => {
  const receipt = openManga();
  assert.throws(
    () => recordApproval(receipt, { type: "human", scope: "contact-sheet", evidence: { pass: true }, decidedAt: NOW }),
    /reviewer と reviewerContextId/u,
  );
  recordApproval(receipt, {
    type: "independent-agent",
    scope: "contact-sheet",
    evidence: { pass: true, sha256: "a".repeat(64) },
    reviewer: "codex-reviewer",
    reviewerContextId: "task-review",
    decidedAt: NOW,
  });
  for (const id of receipt.harnessBuild.declaredGates) {
    recordGate(receipt, { id, verdict: "pass", evidence: { measured: 1 } });
  }
  const done = finalizeRunReceipt(receipt, { outcome: "pass", timestamp: NOW });
  assert.deepEqual(done.summary.approvalCounts, { "independent-agent": 1 });
  assert.deepEqual(redactForPlatform(done).approvals, [{ type: "independent-agent", scope: "contact-sheet" }]);
});

test("SHA拘束済みsignoff evidenceは二重hashせずReceiptへ保持する", () => {
  const receipt = openManga();
  const evidenceSha256 = "a".repeat(64);
  recordApproval(receipt, {
    type: "independent-agent",
    scope: "contact-sheet",
    evidence: `sha256:${evidenceSha256}`,
    reviewer: "codex-reviewer",
    reviewerContextId: "task-review",
    decidedAt: NOW,
  });
  assert.equal(receipt.approvals[0].evidenceDigest, evidenceSha256);
});

test("成果物・Media Job・費用を本文やpath無しで記録する", () => {
  const receipt = openManga();
  recordRunArtifact(receipt, { kind: "final-video", sha256: "a".repeat(64), bytes: 1234, mimeType: "video/mp4" });
  recordPaidMediaJob(receipt, {
    version: "buzzassist-paid-media-receipt-v1",
    jobId: "job-1",
    providerJobId: "provider-1",
    requestKey: "台本由来かもしれないrequest-key",
    status: "completed",
    kind: "voice.synthesis",
    provider: "fish-audio",
    adapterVersion: "fish-v2",
    model: "speech-1",
    voiceId: "voice-1",
    inputHash: "b".repeat(64),
    reservation: { reservationId: "r-1", estimatedCost: 1.2, currency: "USD" },
    usage: { seconds: 3.5, cost: 0.8, currency: "USD" },
    artifact: { sha256: "c".repeat(64), bytes: 456, mimeType: "audio/wav" },
    attempts: { total: 2, retries: [{ attempt: 1 }] },
  });
  for (const id of receipt.harnessBuild.declaredGates) {
    recordGate(receipt, { id, verdict: "pass", evidence: { measured: true } });
  }
  const done = finalizeRunReceipt(receipt, { outcome: "pass", timestamp: NOW });
  assert.equal(done.outcome, "pass");
  assert.equal(done.summary.artifactCount, 1);
  assert.deepEqual(done.summary.mediaCostByCurrency, { USD: 0.8 });
  const serialized = JSON.stringify(done);
  assert.equal(serialized.includes("台本由来かもしれないrequest-key"), false);
  assert.equal(serialized.includes("/tmp/"), false);
});

test("未完了の課金Media JobがあればRunReceiptをpassにしない", () => {
  const receipt = openManga();
  recordPaidMediaJob(receipt, {
    status: "recovery-required",
    kind: "voice.synthesis",
    provider: "elevenlabs",
    inputHash: "d".repeat(64),
  });
  for (const id of receipt.harnessBuild.declaredGates) {
    recordGate(receipt, { id, verdict: "pass", evidence: { measured: true } });
  }
  const done = finalizeRunReceipt(receipt, { outcome: "pass", timestamp: NOW });
  assert.equal(done.outcome, "fail");
  assert.equal(done.summary.incompleteMediaJobCount, 1);
});

test("checks object adapterはtruthy文字列をpassにせず、宣言された全監査を拘束する", () => {
  assert.deepEqual(auditStepsFromCheckMap({ a: true, b: { pass: false, detail: "不合格" }, c: "yes" }), [
    { id: "a", pass: true, detail: "check=true" },
    { id: "b", pass: false, detail: "不合格" },
    { id: "c", pass: false, detail: "booleanまたは{pass,detail}ではない: string" },
  ]);
  const declaration = JSON.parse(readFileSync(
    join(root, "config/harnesses/narrated-story-video.harness.json"),
    "utf8",
  ));
  const receipt = openRunReceipt({
    projectDir: root,
    harnessId: "narrated-story-video",
    entrypoint: "scripts/run-video-harness.mjs",
    action: "audit",
  });
  const auditIds = declaration.guarantees.flatMap((entry) => entry.evidenceAuditIds);
  recordGatesFromAuditChecks(receipt, {
    declaration,
    checks: Object.fromEntries(auditIds.map((id) => [id, true])),
    requiredAuditIds: auditIds,
    contractVersion: "narrated-story-v1",
  });
  assert.equal(finalizeRunReceipt(receipt, { outcome: "pass", timestamp: NOW }).outcome, "pass");
});

test("宣言されたゲートに判定が1つでも欠けていれば finalize できない", () => {
  const receipt = openManga();
  const [first, ...restGates] = receipt.harnessBuild.declaredGates;
  recordGate(receipt, { id: first, verdict: "pass", evidence: { measured: 1 } });
  assert.throws(
    () => finalizeRunReceipt(receipt, { outcome: "pass", timestamp: NOW }),
    /宣言されたゲートに判定が無い/u,
    "判定の欠落を通過として扱わないこと",
  );
  for (const id of restGates) recordGate(receipt, { id, verdict: "pass", evidence: { measured: 1 } });
  const done = finalizeRunReceipt(receipt, { outcome: "pass", timestamp: NOW });
  assert.equal(done.outcome, "pass");
  assert.equal(done.summary.declaredGateCount, done.summary.passed);
});

test("証拠のない判定と、理由のない skip は受け取らない", () => {
  const receipt = openManga();
  const gate = receipt.harnessBuild.declaredGates[0];
  assert.throws(() => recordGate(receipt, { id: gate, verdict: "pass" }), /証拠が要る/u);
  assert.throws(() => recordGate(receipt, { id: gate, verdict: "skip", evidence: { x: 1 } }), /理由が要る/u);
  // 理由を書けば skip は通るが、通過には数えない。
  recordGate(receipt, { id: gate, verdict: "skip", evidence: { x: 1 }, detail: "素材未着のため未実施" });
  for (const id of receipt.harnessBuild.declaredGates.slice(1)) {
    recordGate(receipt, { id, verdict: "pass", evidence: { measured: 1 } });
  }
  const done = finalizeRunReceipt(receipt, { outcome: "pass", timestamp: NOW });
  assert.equal(done.summary.skipped, 1);
  assert.deepEqual(done.summary.skippedGates, [gate]);
  assert.equal(done.summary.passed, done.summary.declaredGateCount - 1, "skip を通過に数えないこと");
  // skip は「測っていない」であって「通った」ではない。全体の判定が
  // skipped を見ていなかったので、測っていない保証があるのに pass に
  // なっていた——欠落を許可として扱う型。
  assert.equal(done.outcome, "fail", "測っていない保証があるのに pass にしないこと");
  assert.equal(done.outcomeOverridden, true);
});

test("落ちたゲートがあれば、pass と申告されても pass にならない", () => {
  // 申告を信じる形にした瞬間、記録は自己申告書になる。
  const receipt = openManga();
  const [failing, ...rest] = receipt.harnessBuild.declaredGates;
  recordGate(receipt, { id: failing, verdict: "fail", evidence: { measuredLufs: -9.2 } });
  for (const id of rest) recordGate(receipt, { id, verdict: "pass", evidence: { measured: 1 } });
  const done = finalizeRunReceipt(receipt, { outcome: "pass", timestamp: NOW });
  assert.equal(done.outcome, "fail");
  assert.equal(done.outcomeRequested, "pass");
  assert.equal(done.outcomeOverridden, true, "申告を上書きしたことが記録に残ること");
  assert.deepEqual(done.summary.failedGates, [failing]);
});

test("knownRemainingIssues が残っていれば pass にしない", () => {
  const receipt = openManga();
  for (const id of receipt.harnessBuild.declaredGates) {
    recordGate(receipt, { id, verdict: "pass", evidence: { measured: 1 } });
  }
  const done = finalizeRunReceipt(receipt, { outcome: "pass", knownRemainingIssues: ["吹き出しの重なりが1箇所"], timestamp: NOW });
  assert.equal(done.outcome, "fail");
  assert.equal(done.outcomeOverridden, true);
});

test("宣言に無いゲートは捨てずに別枠へ残す", () => {
  // 捨てると、宣言の更新漏れが誰にも見えないまま残る。
  const receipt = openManga();
  for (const id of receipt.harnessBuild.declaredGates) {
    recordGate(receipt, { id, verdict: "pass", evidence: { measured: 1 } });
  }
  recordGate(receipt, { id: "宣言されていないゲート", verdict: "pass", evidence: { measured: 1 } });
  const done = finalizeRunReceipt(receipt, { outcome: "pass", timestamp: NOW });
  assert.deepEqual(done.summary.unexpectedGates, ["宣言されていないゲート"]);
});

test("プラットフォームへ返す形にチャンネル固有のものが残らない", () => {
  const receipt = openManga();
  for (const id of receipt.harnessBuild.declaredGates) {
    recordGate(receipt, { id, verdict: "pass", evidence: { measured: 1 } });
  }
  const done = finalizeRunReceipt(receipt, { outcome: "pass", timestamp: NOW });
  const shared = redactForPlatform(done);
  const serialized = JSON.stringify(shared);

  assert.equal(serialized.includes("packId"), false, "pack の id が返らないこと");
  assert.equal("channelPack" in shared, false, "pack の指紋が返らないこと");
  assert.equal("inputDigests" in shared, false, "入力の指紋も返さないこと（台本の同一性が漏れる）");
  assert.equal(typeof shared.channelPackCount, "number", "個数だけは残ること");
  for (const gate of Object.values(shared.gates)) {
    assert.deepEqual(Object.keys(gate), ["verdict"], "証拠の指紋は返さないこと");
  }
  // 返る側に、失敗率を出すのに要る情報は揃っていること。
  assert.ok(shared.harness.version);
  assert.ok(shared.summary.declaredGateCount > 0);
});

test("finalize していない記録は書けないし返せない", () => {
  const receipt = openManga();
  assert.throws(() => redactForPlatform(receipt), /finalize していない/u);
  assert.rejects(() => writeRunReceipt(receipt, join(tmpdir(), "x.json")), /finalize していない/u);
});

test("集計はハーネスの版をまたいで混ぜず、落ちる場所を順に並べる", async () => {
  // 版を混ぜると、直した後も古い失敗が率に残って改善が見えない。
  const build = computeHarnessBuild({ projectDir: root, harnessId: "koya-manga-video" });
  const [gateA, gateB] = build.declaredGates;

  const make = (outcome, failing) => {
    const receipt = openManga();
    for (const id of receipt.harnessBuild.declaredGates) {
      recordGate(receipt, { id, verdict: failing.includes(id) ? "fail" : "pass", evidence: { measured: 1 } });
    }
    return finalizeRunReceipt(receipt, { outcome, timestamp: NOW });
  };

  const entries = [
    { file: "a.json", receipt: make("pass", []) },
    { file: "b.json", receipt: make("fail", [gateA]) },
    { file: "c.json", receipt: make("fail", [gateA, gateB]) },
    { file: "d.json", error: "読めない JSON" },
  ];

  const result = rollup(entries);
  assert.equal(result.unreadable, 1, "読めない記録を黙って落とさないこと");
  assert.equal(result.builds.length, 1);
  const only = result.builds[0];
  assert.equal(only.runs, 3);
  assert.equal(only.passed, 1);
  assert.equal(only.failed, 2);
  assert.equal(only.worstGates[0].id, gateA, "一番よく落ちるゲートが先頭に来ること");
  assert.equal(only.worstGates[0].fail, 2);

  const other = rollup(entries, { harnessId: "narrated-story-video" });
  assert.equal(other.builds.length, 0, "別ハーネスを混ぜないこと");
});

test("記録は原子的に書かれ、読み戻せる", async () => {
  const dir = await mkdtemp(join(tmpdir(), "receipt-"));
  const receipt = openManga();
  for (const id of receipt.harnessBuild.declaredGates) {
    recordGate(receipt, { id, verdict: "pass", evidence: { measured: 1 } });
  }
  finalizeRunReceipt(receipt, { outcome: "pass", timestamp: NOW });
  const target = await writeRunReceipt(receipt, join(dir, "run.json"));
  const reloaded = JSON.parse(await readFile(target, "utf8"));
  assert.equal(reloaded.finalized, true);
  assert.equal(reloaded.outcome, "pass");
  assert.equal(reloaded.finalizedAt, NOW);
  await rm(dir, { recursive: true, force: true });
});

test("保証は、紐づいた実測監査が全て通ったときだけ通る", async () => {
  const { readFileSync } = await import("node:fs");
  const { recordGatesFromAuditSteps } = await import("../lib/harnessRunReceipt.mjs");
  const declaration = JSON.parse(readFileSync(join(root, "config/harnesses/koya-manga-video.harness.json"), "utf8"));
  const allAuditIds = declaration.guarantees.flatMap((g) => g.evidenceAuditIds);

  // 全部通れば保証も通る。
  const good = openManga();
  recordGatesFromAuditSteps(good, { declaration, steps: allAuditIds.map((id) => ({ id, pass: true })) });
  const donePass = finalizeRunReceipt(good, { outcome: "pass", timestamp: NOW });
  assert.equal(donePass.outcome, "pass");
  assert.equal(donePass.summary.failed, 0);

  // 1件でも走っていなければ、その保証は落ちる——欠落を通過として扱わない。
  const skipped = openManga();
  recordGatesFromAuditSteps(skipped, {
    declaration,
    steps: allAuditIds.filter((id) => id !== "full-decode").map((id) => ({ id, pass: true })),
  });
  const doneMissing = finalizeRunReceipt(skipped, { outcome: "pass", timestamp: NOW });
  assert.equal(doneMissing.outcome, "fail");
  assert.deepEqual(doneMissing.summary.failedGates, ["final-audit"]);
  assert.match(doneMissing.gates["final-audit"].detail, /未実施: full-decode/u);

  // 1件でも落ちれば、その保証は落ちる。
  const failing = openManga();
  recordGatesFromAuditSteps(failing, {
    declaration,
    steps: allAuditIds.map((id) => ({ id, pass: id !== "audio-onset", detail: id === "audio-onset" ? "頭切れ 40ms" : "" })),
  });
  const doneFail = finalizeRunReceipt(failing, { outcome: "pass", timestamp: NOW });
  assert.deepEqual(doneFail.summary.failedGates, ["voice-quality-gate"]);
});

test("何を測れば通ったことになるのかを書かない保証は受け取らない", async () => {
  const { recordGatesFromAuditSteps } = await import("../lib/harnessRunReceipt.mjs");
  const receipt = openManga();
  assert.throws(
    () => recordGatesFromAuditSteps(receipt, { declaration: { guarantees: [{ id: "何か", what: "..." }] }, steps: [] }),
    /evidenceAuditIds が無い/u,
  );
});

test("契約の必須監査は、いずれかの保証に必ず割り当てられている", async () => {
  // どこにも紐づかない監査は、落ちても誰の保証も傷つけない。
  const { readFileSync } = await import("node:fs");
  const declaration = JSON.parse(readFileSync(join(root, "config/harnesses/koya-manga-video.harness.json"), "utf8"));
  const contract = JSON.parse(readFileSync(join(root, "config/koya-manga-production-contract.json"), "utf8"));
  const covered = new Set(declaration.guarantees.flatMap((g) => g.evidenceAuditIds || []));
  const orphaned = contract.requiredAudits.filter((id) => !covered.has(id));
  assert.deepEqual(orphaned, [], `どの保証にも紐づかない必須監査: ${orphaned.join(", ")}`);
  const unknown = [...covered].filter((id) => !contract.requiredAudits.includes(id));
  assert.deepEqual(unknown, [], `契約に存在しない監査を保証が参照している: ${unknown.join(", ")}`);
});

test("効力のあった契約で測る——当時存在しない監査を未実施と数えない", async () => {
  // v50 のエピソードを v51 の契約で測って、その版に存在しなかった
  // audio-speaker-continuity のぶんだけ過去作が一斉に落ちた。
  const { readFileSync } = await import("node:fs");
  const { recordGatesFromAuditSteps } = await import("../lib/harnessRunReceipt.mjs");
  const declaration = JSON.parse(readFileSync(join(root, "config/harnesses/koya-manga-video.harness.json"), "utf8"));
  const allIds = declaration.guarantees.flatMap((g) => g.evidenceAuditIds);
  const older = allIds.filter((id) => id !== "audio-speaker-continuity");

  const receipt = openManga();
  recordGatesFromAuditSteps(receipt, {
    declaration,
    steps: older.map((id) => ({ id, pass: true })),
    requiredAuditIds: older,
    contractVersion: "koya-manga-production-v50",
  });
  const done = finalizeRunReceipt(receipt, { outcome: "pass", timestamp: NOW });
  assert.equal(done.outcome, "pass", "当時の契約を満たしていれば通ること");
  assert.match(done.gates["voice-quality-gate"].detail, /対象外: audio-speaker-continuity/u, "対象外だったことが記録に残ること");

  // 契約が現行なら、同じ steps では落ちる。
  const strict = openManga();
  recordGatesFromAuditSteps(strict, {
    declaration,
    steps: older.map((id) => ({ id, pass: true })),
    requiredAuditIds: allIds,
    contractVersion: "koya-manga-production-v51",
  });
  const doneStrict = finalizeRunReceipt(strict, { outcome: "pass", timestamp: NOW });
  assert.equal(doneStrict.outcome, "fail");
  assert.deepEqual(doneStrict.summary.failedGates, ["voice-quality-gate"]);
});

test("契約から保証の裏づけが全部消えたら pass ではなく skip にする", async () => {
  // 契約が縮んだことで保証が黙って無効になるのが、この種の穴の入口。
  const { readFileSync } = await import("node:fs");
  const { recordGatesFromAuditSteps } = await import("../lib/harnessRunReceipt.mjs");
  const declaration = JSON.parse(readFileSync(join(root, "config/harnesses/koya-manga-video.harness.json"), "utf8"));
  const voiceIds = declaration.guarantees.find((g) => g.id === "voice-quality-gate").evidenceAuditIds;
  const withoutVoice = declaration.guarantees.flatMap((g) => g.evidenceAuditIds).filter((id) => !voiceIds.includes(id));

  const receipt = openManga();
  recordGatesFromAuditSteps(receipt, {
    declaration,
    steps: withoutVoice.map((id) => ({ id, pass: true })),
    requiredAuditIds: withoutVoice,
    contractVersion: "縮んだ契約",
  });
  const done = finalizeRunReceipt(receipt, { outcome: "pass", timestamp: NOW });
  assert.equal(done.gates["voice-quality-gate"].verdict, "skip", "測られていない保証を pass にしないこと");
  assert.equal(done.summary.skipped, 1);
  assert.equal(done.summary.passed, done.summary.declaredGateCount - 1);
  assert.equal(done.outcome, "fail", "契約が縮んで測れなくなった保証を、全体 pass に飲み込まないこと");
});

test("後から入った保証は、それより前の契約で測るとき不合格に数えない", async () => {
  // カット単位の動画差し替え（v52）を宣言に足したとき、v50 の合格作が後から
  // 不合格に変わった。監査単位の「当時無かった監査は対象外」が保証単位には無く、
  // 下の実レポート照合（運営者の手元でしか走らない）だけが気づいた。
  const { recordGatesFromAuditSteps, isGateNotInForce } = await import("../lib/harnessRunReceipt.mjs");
  const declaration = JSON.parse(readFileSync(join(root, "config/harnesses/koya-manga-video.harness.json"), "utf8"));
  const contract = JSON.parse(readFileSync(join(root, "config/koya-manga-production-contract.json"), "utf8"));
  const introduced = declaration.guarantees.filter((g) => g.inForceSince);
  assert.ok(introduced.length > 0, "後から足した保証に inForceSince が書かれていること");
  const series = (version) => String(version).replace(/-v\d+$/u, "");
  for (const g of introduced) {
    // 系列が違う版を書くと比べられず、書いていないのと同じになる。
    assert.equal(series(g.inForceSince), series(contract.version), `${g.id}: inForceSince の系列が現行契約と違う`);
    // 現行の契約がその版より前だと、新しい回でもこの保証が測られない。
    assert.equal(
      isGateNotInForce({ verdict: "skip", notInForce: { since: g.inForceSince, contractVersion: contract.version } }),
      false,
      `${g.id}: 現行契約 ${contract.version} がまだ ${g.inForceSince} に達していない`,
    );
  }

  const later = introduced[0];
  const laterIds = new Set(later.evidenceAuditIds);
  const olderIds = declaration.guarantees.flatMap((g) => g.evidenceAuditIds).filter((id) => !laterIds.has(id));
  const olderVersion = later.inForceSince.replace(/\d+$/u, (n) => String(Number(n) - 1));
  const measure = (contractVersion) => {
    const receipt = openManga();
    recordGatesFromAuditSteps(receipt, {
      declaration,
      steps: olderIds.map((id) => ({ id, pass: true })),
      requiredAuditIds: olderIds,
      contractVersion,
    });
    return finalizeRunReceipt(receipt, { outcome: "pass", timestamp: NOW });
  };

  const past = measure(olderVersion);
  assert.equal(past.outcome, "pass", "当時の契約を満たした過去作は、後から足した保証で落ちないこと");
  assert.equal(past.gates[later.id].verdict, "skip", "測っていないものを pass と書かないこと");
  assert.match(past.gates[later.id].detail, /存在しなかった/u);
  assert.deepEqual(past.summary.notInForceGates, [later.id]);
  assert.equal(past.summary.skipped, 0);
  assert.equal(past.summary.passed, past.summary.declaredGateCount - 1, "対象外を通過に数えないこと");
  const shared = redactForPlatform(past);
  assert.deepEqual(shared.gates[later.id], { verdict: "skip", notInForce: true });
  assert.equal(JSON.stringify(shared.gates).includes(olderVersion), false, "契約の版の文字列は返さないこと");

  // 保証が入った版以降の契約で裏づけが消えていたら、それは「縮んだ」であって対象外ではない。
  for (const version of [later.inForceSince, later.inForceSince.replace(/\d+$/u, (n) => String(Number(n) + 1))]) {
    const shrunk = measure(version);
    assert.equal(shrunk.outcome, "fail", `${version}: 契約が縮んで測れなくなった保証を対象外にしないこと`);
    assert.deepEqual(shrunk.summary.skippedGates, [later.id]);
    assert.equal(shrunk.summary.notInForce, 0);
  }
  // 系列が違う・版が読めない——比べられないものを「古い」とは扱わない。
  for (const version of ["other-series-v1", "版不明", ""]) {
    assert.equal(measure(version).outcome, "fail", `${version || "(空)"}: 比べられない版で対象外にしないこと`);
  }

  // 印だけ付けても、版の比較が通らなければ免除しない。
  const forged = openManga();
  for (const id of forged.harnessBuild.declaredGates) {
    recordGate(forged, id === later.id
      ? { id, verdict: "skip", evidence: { x: 1 }, detail: "後から付けた印" }
      : { id, verdict: "pass", evidence: { measured: 1 } });
  }
  forged.gates[later.id].notInForce = { since: olderVersion, contractVersion: later.inForceSince };
  const forgedDone = finalizeRunReceipt(forged, { outcome: "pass", timestamp: NOW });
  assert.equal(forgedDone.outcome, "fail");
  assert.deepEqual(forgedDone.summary.skippedGates, [later.id]);

  // 集計でも、過去作の対象外を「この版で測れていないゲート」に並べない。
  const result = rollup([{ file: "past.json", receipt: past }, { file: "shrunk.json", receipt: measure(later.inForceSince) }]);
  const stat = result.builds[0].gates[later.id];
  assert.deepEqual({ skip: stat.skip, notInForce: stat.notInForce }, { skip: 1, notInForce: 1 });

  // 版として読めない inForceSince は、黙って無視せず宣言の誤りとして止める。
  const broken = structuredClone(declaration);
  broken.guarantees.find((g) => g.id === later.id).inForceSince = "v52";
  assert.throws(
    () => recordGatesFromAuditSteps(openManga(), { declaration: broken, steps: [], requiredAuditIds: olderIds, contractVersion: olderVersion }),
    /inForceSince が契約の版として読めない/u,
  );
});

test("過去の契約の必須監査を全て満たした回は、今の宣言で記録しても合格のまま", async () => {
  // 下の実レポート照合は運営者の手元でしか走らず、CI では飛ぶ。保証を足して
  // 過去作を後から落とす退行（v52 の動画差し替え）もそこでしか見えなかった。
  // 契約ごとの必須監査一覧だけを持ち込んで、同じことを CI でも見る。
  const { recordGatesFromAuditSteps } = await import("../lib/harnessRunReceipt.mjs");
  const declaration = JSON.parse(readFileSync(join(root, "config/harnesses/koya-manga-video.harness.json"), "utf8"));
  const contract = JSON.parse(readFileSync(join(root, "config/koya-manga-production-contract.json"), "utf8"));
  const fixture = JSON.parse(readFileSync(join(root, "test/fixtures/koya-past-contract-audits.json"), "utf8"));
  const parse = (version) => {
    const match = /^(.+)-v(\d+)$/u.exec(version);
    return match ? { series: match[1], number: Number(match[2]) } : null;
  };
  const current = parse(contract.version);
  const previous = `${current.series}-v${current.number - 1}`;
  assert.ok(
    fixture.contracts.some((entry) => entry.version === previous),
    `契約を ${contract.version} に上げたら、${previous} の必須監査を test/fixtures/koya-past-contract-audits.json に足すこと`,
  );

  for (const entry of fixture.contracts) {
    const past = parse(entry.version);
    assert.ok(past && past.series === current.series && past.number < current.number, `${entry.version}: 現行契約より前の同じ系列であること`);
    const record = (failing = "") => {
      const receipt = openManga();
      recordGatesFromAuditSteps(receipt, {
        declaration,
        steps: entry.requiredAudits.map((id) => ({ id, pass: id !== failing })),
        requiredAuditIds: entry.requiredAudits,
        contractVersion: entry.version,
      });
      return finalizeRunReceipt(receipt, { outcome: "pass", timestamp: NOW });
    };
    const done = record();
    assert.equal(
      done.outcome,
      "pass",
      `${entry.version}: 当時の必須監査を全て満たした回が、今の宣言では不合格になる`
      + `（不合格 ${done.summary.failedGates.join(", ") || "なし"} / 未測定 ${done.summary.skippedGates.join(", ") || "なし"}）。`
      + "後から足した保証なら inForceSince を書くこと",
    );
    // 対象外の扱いが緩すぎないか——当時の必須監査が1つでも落ちたら不合格。
    for (const id of entry.requiredAudits) {
      assert.equal(record(id).outcome, "fail", `${entry.version}: ${id} が落ちても合格になる`);
    }
  }
});

test("ナレーション物語: 過去の監査契約を満たした回は保証を足した宣言でも合格のまま、今の契約では足した保証の合格が要る", async () => {
  // 品質ループ（qualityLoopPassed）は監査契約 v3、声の監査（voiceTakeQuality・voiceCastRouting）と
  // 人物の同一性（characterIdentityReviewed）は v4、途中の成果物の品質ループ（sceneImageAssetLoopPassed・
  // voiceTakeAssetLoopPassed・characterAssetLoopPassed）と場面の画の出どころ（sceneImageProvenance）は v5、
  // 見た目の実測（焼き込み字幕・カメラの動き・感想パートの配置・回ごとの OP 映像の来歴）は v6、
  // 回ごとの運営者の動画の品質ループ（operatorVideoAssetLoopPassed）は v7、
  // 台本の品質ループの合格（scriptQualityAccepted）は v8、本編の場面の切り替え（sceneTransitionMeasured）と
  // 固定の重ね物（fixedOverlaysMeasured）は v9、場面ごとの焦点（cameraFocusMeasured）は v10、本編の間
  // （narrationPacingMeasured）は v11 から。
  // 当時の必須監査を全て満たした過去の回を、保証を足した今の宣言で記録しても、当時無かった保証のぶんだけ
  // 後から不合格にしない。
  const { isGateNotInForce } = await import("../lib/harnessRunReceipt.mjs");
  const { NARRATED_STORY_AUDIT_CONTRACT_VERSION } = await import("../lib/narratedStoryPipeline.mjs");
  const { NARRATED_STORY_AUDIT_IDS } = await import("../lib/narratedStoryOutcome.mjs");
  const declaration = JSON.parse(readFileSync(join(root, "config/harnesses/narrated-story-video.harness.json"), "utf8"));
  const fixture = JSON.parse(readFileSync(join(root, "test/fixtures/narrated-past-contract-audits.json"), "utf8"));
  const parse = (version) => {
    const match = /^(.+)-v(\d+)$/u.exec(version);
    return match ? { series: match[1], number: Number(match[2]) } : null;
  };
  const current = parse(NARRATED_STORY_AUDIT_CONTRACT_VERSION);
  const previous = `${current.series}-v${current.number - 1}`;
  assert.ok(
    fixture.contracts.some((entry) => entry.version === previous),
    `監査契約を ${NARRATED_STORY_AUDIT_CONTRACT_VERSION} に上げたら、${previous} の必須監査を test/fixtures/narrated-past-contract-audits.json に足すこと`,
  );
  // 今の契約が出す監査と、宣言の証拠が一対一（対応付けの漏れが無い）。
  assert.deepEqual([...NARRATED_STORY_AUDIT_IDS].sort(), declaration.guarantees.flatMap((g) => g.evidenceAuditIds).sort());
  for (const guarantee of declaration.guarantees.filter((g) => g.inForceSince)) {
    assert.equal(parse(guarantee.inForceSince)?.series, current.series, `${guarantee.id}: inForceSince の系列が監査契約と違う`);
    assert.equal(
      isGateNotInForce({ verdict: "skip", notInForce: { since: guarantee.inForceSince, contractVersion: NARRATED_STORY_AUDIT_CONTRACT_VERSION } }),
      false,
      `${guarantee.id}: 今の監査契約がまだ ${guarantee.inForceSince} に達していない`,
    );
  }
  const quality = declaration.guarantees.find((g) => g.id === "quality-loop");
  assert.deepEqual(quality.evidenceAuditIds, ["qualityLoopPassed"]);
  assert.equal(quality.inForceSince, `${current.series}-v3`, "品質ループの保証は、それが入った監査契約の版から");
  const voice = declaration.guarantees.find((g) => g.id === "voice-quality");
  assert.deepEqual(voice.evidenceAuditIds, ["voiceTakeQuality", "voiceCastRouting"]);
  const identity = declaration.guarantees.find((g) => g.id === "character-identity");
  assert.deepEqual(identity.evidenceAuditIds, ["characterIdentityReviewed"]);
  for (const added of [voice, identity]) {
    assert.equal(added.inForceSince, `${current.series}-v4`, `${added.id}: それが入った監査契約の版から`);
  }
  const { NARRATED_ASSET_LOOP_AUDIT_IDS, NARRATED_ASSET_LOOP_SINCE } = await import("../lib/narratedStoryAssetLoops.mjs");
  const assetLoop = declaration.guarantees.find((g) => g.id === "asset-quality-loop");
  assert.deepEqual(assetLoop.evidenceAuditIds, [...NARRATED_ASSET_LOOP_AUDIT_IDS]);
  const provenance = declaration.guarantees.find((g) => g.id === "scene-image-provenance");
  assert.deepEqual(provenance.evidenceAuditIds, ["sceneImageProvenance"]);
  for (const added of [assetLoop, provenance]) {
    assert.equal(added.inForceSince, `${current.series}-v5`, `${added.id}: それが入った監査契約の版から`);
  }
  assert.equal(NARRATED_ASSET_LOOP_SINCE, assetLoop.inForceSince, "関門が効力を持つ版と宣言の inForceSince が同じ");
  const visual = {
    "burned-subtitles-legible": ["burnedSubtitlesMeasured"],
    "camera-motion-declared": ["cameraMotionMeasured"],
    "review-layout": ["reviewLayoutMeasured"],
    "episode-opening-provenance": ["episodeOpeningProvenance"],
  };
  for (const [id, evidence] of Object.entries(visual)) {
    const added = declaration.guarantees.find((g) => g.id === id);
    assert.deepEqual(added?.evidenceAuditIds, evidence, `${id}: 見た目の実測の監査`);
    assert.equal(added.inForceSince, `${current.series}-v6`, `${id}: それが入った監査契約の版から`);
  }
  const { NARRATED_VIDEO_CLIP_LOOP_AUDIT_ID, NARRATED_VIDEO_CLIP_LOOP_SINCE } = await import("../lib/narratedStoryAssetLoops.mjs");
  const videoLoop = declaration.guarantees.find((g) => g.id === "operator-video-asset-loop");
  assert.deepEqual(videoLoop?.evidenceAuditIds, [NARRATED_VIDEO_CLIP_LOOP_AUDIT_ID]);
  assert.equal(videoLoop.inForceSince, `${current.series}-v7`, "動画の品質ループの保証は、それが入った監査契約の版から");
  assert.equal(NARRATED_VIDEO_CLIP_LOOP_SINCE, videoLoop.inForceSince, "関門が効力を持つ版と宣言の inForceSince が同じ");
  const { NARRATED_SCRIPT_QUALITY_AUDIT_ID, NARRATED_SCRIPT_QUALITY_SINCE } = await import("../lib/narratedStoryScriptQuality.mjs");
  const scriptQuality = declaration.guarantees.find((g) => g.id === "script-quality-accepted");
  assert.deepEqual(scriptQuality?.evidenceAuditIds, [NARRATED_SCRIPT_QUALITY_AUDIT_ID]);
  assert.equal(scriptQuality.inForceSince, `${current.series}-v8`, "台本の品質ループの合格は、それが入った監査契約の版から");
  assert.equal(NARRATED_SCRIPT_QUALITY_SINCE, scriptQuality.inForceSince, "関門が効力を持つ版と宣言の inForceSince が同じ");
  const addedV9 = {
    "scene-transition-declared": ["sceneTransitionMeasured"],
    "fixed-overlays-declared": ["fixedOverlaysMeasured"],
  };
  for (const [id, evidence] of Object.entries(addedV9)) {
    const added = declaration.guarantees.find((g) => g.id === id);
    assert.deepEqual(added?.evidenceAuditIds, evidence, `${id}: 見た目の実測の監査`);
    assert.equal(added.inForceSince, `${current.series}-v9`, `${id}: それが入った監査契約の版から`);
  }
  const { NARRATED_CAMERA_FOCUS_AUDIT_ID } = await import("../lib/narratedStoryCamera.mjs");
  const focusGuarantee = declaration.guarantees.find((g) => g.id === "camera-focus-declared");
  assert.deepEqual(focusGuarantee?.evidenceAuditIds, [NARRATED_CAMERA_FOCUS_AUDIT_ID], "場面ごとの焦点の実測の監査");
  assert.equal(focusGuarantee.inForceSince, `${current.series}-v10`, "場面ごとの焦点は、それが入った監査契約の版から");
  const { NARRATED_PACING_AUDIT_ID } = await import("../lib/narratedStoryPacing.mjs");
  const pacingGuarantee = declaration.guarantees.find((g) => g.id === "narration-pacing-declared");
  assert.deepEqual(pacingGuarantee?.evidenceAuditIds, [NARRATED_PACING_AUDIT_ID], "本編の間の実測の監査");
  assert.equal(pacingGuarantee.inForceSince, NARRATED_STORY_AUDIT_CONTRACT_VERSION, "本編の間は、それが入った監査契約の版から");
  // 人の判断に依存する保証は、何を人が判断するのかを宣言に書く。
  for (const id of ["external-visual-signoff", "quality-loop", "character-identity", "asset-quality-loop", "operator-video-asset-loop", "script-quality-accepted"]) {
    assert.ok(String(declaration.guarantees.find((g) => g.id === id)?.human || "").length > 10, `${id}: human が無い`);
  }
  const sinceNumber = (guarantee) => parse(guarantee.inForceSince || `${current.series}-v1`).number;

  const record = (requiredAudits, contractVersion, failing = "") => {
    const receipt = openRunReceipt({ projectDir: root, harnessId: "narrated-story-video", entrypoint: "scripts/run-video-harness.mjs", action: "audit" });
    recordGatesFromAuditChecks(receipt, {
      declaration,
      checks: Object.fromEntries(requiredAudits.map((id) => [id, id !== failing])),
      requiredAuditIds: requiredAudits,
      contractVersion,
    });
    return finalizeRunReceipt(receipt, { outcome: "pass", timestamp: NOW });
  };
  for (const entry of fixture.contracts) {
    const past = parse(entry.version);
    assert.ok(past && past.series === current.series && past.number < current.number, `${entry.version}: 今の監査契約より前の同じ系列であること`);
    const done = record(entry.requiredAudits, entry.version);
    assert.equal(done.outcome, "pass", `${entry.version}: 当時の必須監査を全て満たした回が不合格になる（未測定 ${done.summary.skippedGates.join(", ") || "なし"}）`);
    const laterGuarantees = declaration.guarantees.filter((g) => sinceNumber(g) > past.number).map((g) => g.id).sort();
    assert.ok(laterGuarantees.length > 0);
    assert.deepEqual([...done.summary.notInForceGates].sort(), laterGuarantees, "当時無かった保証だけを対象外に数える");
    for (const id of laterGuarantees) assert.equal(done.gates[id].verdict, "skip", "測っていないものを pass と書かない");
    for (const id of entry.requiredAudits) {
      assert.equal(record(entry.requiredAudits, entry.version, id).outcome, "fail", `${entry.version}: ${id} が落ちても合格になる`);
    }
  }
  // 今の契約では、足した保証の監査が無い（縮んだ）・落ちた回は不合格、合格した回だけが合格。
  const previousRoster = fixture.contracts.find((entry) => entry.version === previous).requiredAudits;
  const shrunk = record(previousRoster, NARRATED_STORY_AUDIT_CONTRACT_VERSION);
  assert.equal(shrunk.outcome, "fail");
  assert.deepEqual([...shrunk.summary.skippedGates].sort(), ["narration-pacing-declared"]);
  for (const id of [
    "qualityLoopPassed", "voiceTakeQuality", "voiceCastRouting", "characterIdentityReviewed",
    "sceneImageProvenance", "sceneImageAssetLoopPassed", "voiceTakeAssetLoopPassed", "characterAssetLoopPassed",
    "burnedSubtitlesMeasured", "cameraMotionMeasured", "reviewLayoutMeasured", "episodeOpeningProvenance",
    "operatorVideoAssetLoopPassed", "scriptQualityAccepted", "sceneTransitionMeasured", "fixedOverlaysMeasured",
    "cameraFocusMeasured", "narrationPacingMeasured",
  ]) {
    assert.equal(record([...NARRATED_STORY_AUDIT_IDS], NARRATED_STORY_AUDIT_CONTRACT_VERSION, id).outcome, "fail", `${id} が落ちても合格になる`);
  }
  assert.equal(record([...NARRATED_STORY_AUDIT_IDS], NARRATED_STORY_AUDIT_CONTRACT_VERSION).outcome, "pass");
});

test("ナレーション物語: 宣言の inForceSince から導いた効力のある必須監査は、過去の各監査契約の必須監査と一致し、宣言の版は今の監査契約", async () => {
  // 共通 Receipt（lib/videoHarnessReceipt.mjs）は、制作契約を Job に固定しないハーネスでは、この導出で
  // 「その Job に効いている契約の必須監査」を決める。過去の契約と一致しなければ、確定待ちの Job を落とすか、
  // 当時あった監査を免除してしまう。
  const { declaredAuditIdsInForce, declarationContractVersionFloor, contractVersionPredates } = await import("../lib/harnessRunReceipt.mjs");
  const { NARRATED_STORY_AUDIT_CONTRACT_VERSION } = await import("../lib/narratedStoryPipeline.mjs");
  const { NARRATED_STORY_AUDIT_IDS } = await import("../lib/narratedStoryOutcome.mjs");
  const declaration = JSON.parse(readFileSync(join(root, "config/harnesses/narrated-story-video.harness.json"), "utf8"));
  const fixture = JSON.parse(readFileSync(join(root, "test/fixtures/narrated-past-contract-audits.json"), "utf8"));
  for (const entry of fixture.contracts) {
    const derived = declaredAuditIdsInForce(declaration, entry.version);
    assert.deepEqual([...derived.requiredAuditIds].sort(), [...entry.requiredAudits].sort(), `${entry.version}: 宣言から導いた必須監査が当時の契約と違う`);
    assert.deepEqual(
      [...derived.notInForceAuditIds].sort(),
      NARRATED_STORY_AUDIT_IDS.filter((id) => !entry.requiredAudits.includes(id)).sort(),
      `${entry.version}: 効力の外の監査は当時無かったものだけ`,
    );
  }
  assert.deepEqual([...declaredAuditIdsInForce(declaration, NARRATED_STORY_AUDIT_CONTRACT_VERSION).requiredAuditIds].sort(), [...NARRATED_STORY_AUDIT_IDS].sort());
  // 読めない・別系列の版は比べられないので全部効力あり（古いとは扱わない）。
  for (const version of ["", "fixture-v1", "koya-manga-production-v1", "buzzassist-narrated-story-audit"]) {
    assert.deepEqual(declaredAuditIdsInForce(declaration, version).notInForceAuditIds, [], `${version || "(空)"}: 比べられない版で監査を免除しない`);
  }
  assert.equal(declarationContractVersionFloor(declaration), NARRATED_STORY_AUDIT_CONTRACT_VERSION, "宣言の版（inForceSince の最新）は今の監査契約");
  assert.equal(contractVersionPredates("buzzassist-narrated-story-audit-v4", declarationContractVersionFloor(declaration)), true);
  // 漫画の宣言の版は、漫画の制作契約の系列（漫画は Job に固定した契約の requiredAudits で測る）。
  const koya = JSON.parse(readFileSync(join(root, "config/harnesses/koya-manga-video.harness.json"), "utf8"));
  assert.match(declarationContractVersionFloor(koya), /^koya-manga-production-v\d+$/u);
  // 系列が混ざった宣言は、宣言の版を決められない（""）。
  assert.equal(declarationContractVersionFloor({ guarantees: [{ id: "a", inForceSince: "x-v2", evidenceAuditIds: ["a"] }, { id: "b", inForceSince: "y-v3", evidenceAuditIds: ["b"] }] }), "");
  assert.throws(() => declaredAuditIdsInForce({ guarantees: [{ id: "a", inForceSince: "v5", evidenceAuditIds: ["a"] }] }, "x-v1"), /inForceSince が契約の版として読めない/u);
});

test("実在する過去の監査レポートで、記録とレポートの判定が一致する", async (t) => {
  // 合成データだけで検証すると、実際の監査ステップ ID と対応表のずれを見逃す。
  const { readFileSync, existsSync } = await import("node:fs");
  const { recordGatesFromAuditSteps } = await import("../lib/harnessRunReceipt.mjs");
  const declaration = JSON.parse(readFileSync(join(root, "config/harnesses/koya-manga-video.harness.json"), "utf8"));
  const reports = [
    "canvas/manga-videos/manga-v50-unseen-canary-001/audits/koya-final/final-audit.json",
    "canvas/manga-videos/manga-arano-amane-effort-001/audits/koya-final/final-audit.json",
    "canvas/manga-videos/manga-photo-homecoming-001/audits/koya-final/final-audit.json",
  ].filter((rel) => existsSync(join(root, rel)));
  if (reports.length === 0) {
    // 過去の成果物は運営者の手元にしかない。clone しただけの環境では
    // この照合はできないので飛ばす——合成データ側の検証は上の2件が見ている。
    t.skip("過去の監査レポートが無い環境");
    return;
  }

  for (const rel of reports) {
    const report = JSON.parse(readFileSync(join(root, rel), "utf8"));
    const receipt = openManga();
    recordGatesFromAuditSteps(receipt, {
      declaration,
      steps: report.steps,
      requiredAuditIds: report.requiredAuditIds,
      contractVersion: report.contractVersion,
    });
    const done = finalizeRunReceipt(receipt, {
      outcome: report.pass ? "pass" : "fail",
      knownRemainingIssues: (report.knownRemainingIssues || []).map((issue) => `${issue.id}: ${issue.detail}`),
      timestamp: report.generatedAt,
    });
    assert.equal(done.outcome, report.pass ? "pass" : "fail", `${rel}: 記録とレポートの判定が食い違う`);
    assert.deepEqual(done.summary.unexpectedGates, [], `${rel}: 宣言外のゲートが出た`);
  }
});

test("どのハーネス宣言も、保証の裏づけを書くか、書けない理由を明示している", async () => {
  // 「あとで紐づける」は忘れられる。忘れられたまま保証だけ並ぶと、
  // 1つも走っていない状態で「全部通った」と書ける宣言が残る。
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = join(root, "config/harnesses");
  const files = readdirSync(dir).filter((name) => name.endsWith(".harness.json"));
  assert.ok(files.length > 0);

  for (const file of files) {
    const declaration = JSON.parse(readFileSync(join(dir, file), "utf8"));
    for (const guarantee of declaration.guarantees || []) {
      assert.ok(
        Array.isArray(guarantee.evidenceAuditIds) && guarantee.evidenceAuditIds.length > 0,
        `${file}: 保証 ${guarantee.id} に evidenceAuditIds が無い`,
      );
    }
    // adapterは pending なら理由、ready なら実装位置を必須にする。
    if (declaration.receiptAdapter) {
      assert.ok(["pending", "ready"].includes(declaration.receiptAdapter.status));
      if (declaration.receiptAdapter.status === "pending") {
        assert.ok(declaration.receiptAdapter.reason, `${file}: receiptAdapter に reason が無い`);
        assert.ok(declaration.receiptAdapter.requiredWork, `${file}: receiptAdapter に requiredWork が無い`);
      } else {
        assert.ok(declaration.receiptAdapter.implementation, `${file}: ready adapter の実装位置が無い`);
        assert.equal(declaration.receiptAdapter.failClosed, true);
      }
    }
  }
});

test("Channel Pack の指紋は解決層と同じ探索順で取る", async (t) => {
  // `<project>/channel-packs` だけを見ていたので、BUZZASSIST_CHANNEL_PACK で
  // 外を指した pack が記録に残らなかった。版ずれを辿るのが記録の目的なのに、
  // どの pack で走ったかが落ちていた。
  const { channelPackPresent } = await import("../lib/channelPackResolver.mjs");
  if (!channelPackPresent(root)) {
    t.skip("channel pack が無い環境");
    return;
  }
  const build = computeHarnessBuild({ projectDir: root, harnessId: "koya-manga-video" });
  assert.ok(Array.isArray(build.channelPack) && build.channelPack.length > 0, "pack の指紋が取れること");
  for (const pack of build.channelPack) {
    assert.match(pack.digest || "", /^[0-9a-f]{64}$/u, `${pack.packId}: 指紋が実体でない`);
    assert.ok(pack.fileCount > 0, `${pack.packId}: 0ファイルを畳んだ指紋`);
    assert.ok(["pack", "env"].includes(pack.source), `${pack.packId}: 出所が記録されていない`);
    // pack の内部ディレクトリが pack ID として並ぶ不具合の再発防止。
    assert.equal(["config", "docs", "scripts"].includes(pack.packId), false, `pack の中身を pack ID にしている: ${pack.packId}`);
  }
});

test("契約に監査が増えて対応付けを忘れたら、記録は作れない", async () => {
  // これが最終監査と記録の食い違いの正体だった。契約に必須監査が増えたのに
  // 宣言への対応付けを忘れると、最終監査は落ちるのに**記録だけが pass**に
  // なる。テストでは捕まえていたが、それは「対応表の更新漏れと同時に
  // テストの更新漏れも起きない」前提に乗っていて、実行時には何も守っていなかった。
  const { readFileSync } = await import("node:fs");
  const { recordGatesFromAuditSteps } = await import("../lib/harnessRunReceipt.mjs");
  const declaration = JSON.parse(readFileSync(join(root, "config/harnesses/koya-manga-video.harness.json"), "utf8"));
  const mapped = declaration.guarantees.flatMap((g) => g.evidenceAuditIds);

  const receipt = openManga();
  assert.throws(
    () => recordGatesFromAuditSteps(receipt, {
      declaration,
      steps: [...mapped, "brand-new-audit"].map((id) => ({ id, pass: true })),
      requiredAuditIds: [...mapped, "brand-new-audit"],   // 契約には在るが、宣言には無い
      contractVersion: "koya-manga-production-v99",
    }),
    /どの保証にも紐づいていない: brand-new-audit/u,
    "対応付け漏れを実行時に落とすこと",
  );

  // 同じ監査を2つの保証に紐づけるのも落とす（どちらが裏づけたのか曖昧になる）。
  const duplicated = structuredClone(declaration);
  duplicated.guarantees[1].evidenceAuditIds = [...duplicated.guarantees[1].evidenceAuditIds, duplicated.guarantees[0].evidenceAuditIds[0]];
  assert.throws(
    () => recordGatesFromAuditSteps(openManga(), {
      declaration: duplicated,
      steps: mapped.map((id) => ({ id, pass: true })),
      requiredAuditIds: mapped,
      contractVersion: "koya-manga-production-v51",
    }),
    /複数の保証に紐づいている/u,
  );
});

test("同じ id の重複を、黙って後勝ちにしない", async () => {
  // Map は同じ id を黙って上書きする。fail のあとに pass が来れば pass に
  // なり、順序ひとつで判定が変わる。どちらが正しいか決められない入力は、
  // 黙って片方を選ぶより落とす方がいい。
  const { readFileSync } = await import("node:fs");
  const { recordGatesFromAuditSteps } = await import("../lib/harnessRunReceipt.mjs");
  const declaration = JSON.parse(readFileSync(join(root, "config/harnesses/koya-manga-video.harness.json"), "utf8"));
  const mapped = declaration.guarantees.flatMap((g) => g.evidenceAuditIds);
  const target = mapped[0];

  // 同じ監査が fail → pass の順で2度来る。
  assert.throws(
    () => recordGatesFromAuditSteps(openManga(), {
      declaration,
      steps: [{ id: target, pass: false }, ...mapped.map((id) => ({ id, pass: true }))],
      requiredAuditIds: mapped,
      contractVersion: "koya-manga-production-v51",
    }),
    /監査結果 .+ が重複|同じ id が重複/u,
    "重複した監査結果を落とすこと",
  );

  // 保証の id が重複。
  const dupGuarantee = structuredClone(declaration);
  dupGuarantee.guarantees.push({ ...dupGuarantee.guarantees[0], evidenceAuditIds: ["contract-manifest"] });
  assert.throws(
    () => recordGatesFromAuditSteps(openManga(), {
      declaration: dupGuarantee,
      steps: mapped.map((id) => ({ id, pass: true })),
      requiredAuditIds: mapped,
      contractVersion: "koya-manga-production-v51",
    }),
    /同じ id が重複/u,
    "重複した保証を落とすこと",
  );

  // 契約の必須監査が重複。
  assert.throws(
    () => recordGatesFromAuditSteps(openManga(), {
      declaration,
      steps: mapped.map((id) => ({ id, pass: true })),
      requiredAuditIds: [...mapped, target],
      contractVersion: "koya-manga-production-v51",
    }),
    /同じ id が重複/u,
  );
});

test("指紋の取れない層があれば、記録を作らない", async () => {
  // null の指紋を受理していたせいで「全スキルの指紋が null」が長く残った。
  // 同じ故障は別環境でいつでも再発する——空の pack、配置替え、パスの取り違え。
  const { computeHarnessBuild } = await import("../lib/harnessRunReceipt.mjs");
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const sandbox = await mkdtemp(join(tmpdir(), "empty-pack-"));
  await mkdir(join(sandbox, "channel-packs", "hollow"), { recursive: true });
  await writeFile(join(sandbox, "channel-packs", "hollow", "README.txt"), "json が1つも無い pack\n");
  assert.throws(
    () => computeHarnessBuild({ projectDir: sandbox, harnessId: "koya-manga-video" }),
    /指紋を取れなかった層がある/u,
    "空の pack を受理しないこと",
  );
  await rm(sandbox, { recursive: true, force: true });
});

test("failed からの再開は Receipt に前回の失敗と Media Job の再利用/再発行を digest で残し、platform export は件数だけ返す", () => {
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const receipt = openManga();
  recordResumeFromFailed(receipt, {
    attempts: 2,
    resumedAt: NOW,
    previousFailure: { failedAt: NOW, failedStage: "production", error: "render crashed", blockers: ["ffmpeg"], knownRemainingIssues: ["render crashed"] },
    mediaJobRecovery: [{ requestKey: "req-r", jobId: "media-r", before: "recovery-required", after: "completed" }],
    mediaJobs: {
      reused: [{ requestKey: "req-a", jobId: "media-a", kind: "image", provider: "fixture", artifactSha256: "a".repeat(64) }],
      recovered: [{ requestKey: "req-r", jobId: "media-r", kind: "voice.synthesis", provider: "fixture", artifactSha256: "c".repeat(64) }],
      reissued: [],
      issued: [{ requestKey: "req-b", jobId: "media-b", kind: "image", provider: "fixture", artifact: { sha256: "b".repeat(64) } }],
      carried: [],
    },
  });
  assert.equal(receipt.resumeFromFailed.attempts, 2);
  assert.equal(receipt.resumeFromFailed.previousFailure.failedStage, "production");
  assert.equal(receipt.resumeFromFailed.previousFailure.error, "render crashed");
  assert.deepEqual(receipt.resumeFromFailed.previousFailure.blockers, ["ffmpeg"]);
  assert.equal(receipt.resumeFromFailed.mediaJobs.reused[0].requestKeyDigest, digest("req-a"));
  assert.equal(receipt.resumeFromFailed.mediaJobs.issued[0].artifactSha256, "b".repeat(64), "artifact.sha256 形でも受ける");
  assert.deepEqual(receipt.resumeFromFailed.mediaJobRecovery, [{ requestKeyDigest: digest("req-r"), jobId: "media-r", before: "recovery-required", after: "completed" }]);
  const serialized = JSON.stringify(receipt);
  for (const raw of ["req-a", "req-b", "req-r"]) assert.equal(serialized.includes(`"${raw}"`), false, `${raw}: requestKey の生値を残さない`);
  for (const id of receipt.harnessBuild.declaredGates) recordGate(receipt, { id, verdict: "pass", evidence: { measured: 1 } });
  const done = finalizeRunReceipt(receipt, { outcome: "pass", timestamp: NOW });
  assert.deepEqual(redactForPlatform(done).resumeFromFailed, {
    attempts: 2, failedStage: "production", reusedCount: 1, recoveredCount: 1, reissuedCount: 0, issuedCount: 1,
  });
  assert.equal(JSON.stringify(redactForPlatform(done)).includes("render crashed"), false, "失敗本文は platform へ返さない");
  assert.throws(() => recordResumeFromFailed(done, { attempts: 3 }), /finalize 済み/u);

  const plain = openManga();
  for (const id of plain.harnessBuild.declaredGates) recordGate(plain, { id, verdict: "pass", evidence: { measured: 1 } });
  const plainDone = finalizeRunReceipt(plain, { outcome: "pass", timestamp: NOW });
  assert.equal(plainDone.resumeFromFailed, undefined, "再開していない Receipt に再開記録は無い");
  assert.equal(redactForPlatform(plainDone).resumeFromFailed, null);
});

test("指紋迂回で作り直した画像行は Receipt に digest と回数で残り、platform export は件数だけ、ゲート判定には触れない", () => {
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const receipt = openManga();
  recordImageRetry(receipt, { requested: true, jobIds: ["image:2", "image:7"], count: 2, attempts: 3, completed: 2 });
  assert.deepEqual(receipt.imageRetry, {
    requested: true, jobIdDigests: [digest("image:2"), digest("image:7")], count: 2, attempts: 3, completed: 2,
  });
  assert.equal(JSON.stringify(receipt).includes("image:2"), false, "画像行 id の生値は残さない");
  assert.deepEqual(receipt.gates, {}, "記録はゲート判定に触れない");
  for (const id of receipt.harnessBuild.declaredGates) recordGate(receipt, { id, verdict: "pass", evidence: { measured: 1 } });
  const done = finalizeRunReceipt(receipt, { outcome: "pass", timestamp: NOW });
  assert.deepEqual(redactForPlatform(done).imageRetry, { requested: true, count: 2, attempts: 3, completed: 2 });
  assert.equal("jobIdDigests" in redactForPlatform(done).imageRetry, false);
  assert.throws(() => recordImageRetry(done, { requested: true }), /finalize 済み/u);
  const plain = openManga();
  for (const id of plain.harnessBuild.declaredGates) recordGate(plain, { id, verdict: "pass", evidence: { measured: 1 } });
  const plainDone = finalizeRunReceipt(plain, { outcome: "pass", timestamp: NOW });
  assert.equal(plainDone.imageRetry, undefined);
  assert.equal(redactForPlatform(plainDone).imageRetry, null);
});
