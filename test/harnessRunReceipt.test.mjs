import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  computeHarnessBuild,
  finalizeRunReceipt,
  openRunReceipt,
  recordGate,
  redactForPlatform,
  writeRunReceipt,
} from "../lib/harnessRunReceipt.mjs";
import { rollup } from "../scripts/harness-receipts.mjs";

const root = new URL("..", import.meta.url).pathname;
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
  assert.ok(build.declaredGates.length > 0, "宣言された保証がゲート一覧になること");
  assert.ok(Object.keys(build.genreSkills).length > 0, "ジャンルスキルの指紋が取れること");
  assert.ok(build.platform["lib/harnessRouting.mjs"], "プラットフォーム層の指紋が取れること");
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
    // 記録に載せられないハーネスは、その理由が宣言に書かれていること。
    if (declaration.receiptAdapter) {
      assert.ok(declaration.receiptAdapter.reason, `${file}: receiptAdapter に reason が無い`);
      assert.ok(declaration.receiptAdapter.requiredWork, `${file}: receiptAdapter に requiredWork が無い`);
      assert.equal(declaration.receiptAdapter.status, "pending");
    }
  }
});
