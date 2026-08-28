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
