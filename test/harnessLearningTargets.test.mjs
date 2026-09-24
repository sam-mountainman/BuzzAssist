import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  HARNESS_LEARNING_ROUTES,
  LEARNING_TARGET_ALIASES,
  resolveLearningTarget,
} from "../lib/harnessLearningTargets.mjs";
import { normalizeHarnessFeedbackTarget } from "../lib/harnessFeedbackBundle.mjs";
import { buildPublicProposalCatalog } from "../lib/harnessLearningCurator.mjs";
import {
  TARGET_ALIASES,
  clusterForConsolidation,
  loadTargets,
  planOverlaySync,
  resolveTarget,
  summarizeProposals,
} from "../scripts/harness-learn.mjs";

const repoFile = (relative) => fileURLToPath(new URL(`../${relative}`, import.meta.url));

function readLedger(relative) {
  return readFileSync(repoFile(relative), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

test("旧名の対応表は harness-learn と feedback bundle で同じ1つの定義を読む", () => {
  // 以前は同じ表が2か所に別々に書かれていた。片方だけ直すと、同じ提案が
  // 台帳側と bundle 側で別の宛先に数えられる。
  assert.equal(TARGET_ALIASES, LEARNING_TARGET_ALIASES, "harness-learn が別の表を持っている");
  assert.ok(Object.isFrozen(LEARNING_TARGET_ALIASES));
  for (const [legacy, current] of Object.entries(LEARNING_TARGET_ALIASES)) {
    assert.equal(resolveTarget(legacy), current);
    assert.equal(resolveLearningTarget(legacy), current);
    assert.equal(normalizeHarnessFeedbackTarget(legacy), current, `${legacy} を bundle 側が別に解決した`);
    assert.ok(current in loadTargets(), `${legacy} の解決先 ${current} が targets.json に無い`);
  }
  // 表をソースに二重に書き戻していないこと（書き戻すと片方だけ古くなる）。
  for (const file of ["lib/harnessFeedbackBundle.mjs", "scripts/harness-learn.mjs", "lib/canvasFeedbackCollector.mjs"]) {
    const source = readFileSync(repoFile(file), "utf8");
    assert.equal(source.includes('"skill:manga-video-production"'), false, `${file} に旧名の表が残っている`);
  }
  // Canvas feedback の既定宛先も同じ定義を読む。
  const collector = readFileSync(repoFile("lib/canvasFeedbackCollector.mjs"), "utf8");
  assert.match(collector, /HARNESS_ROUTES = HARNESS_LEARNING_ROUTES/u);
  assert.equal(HARNESS_LEARNING_ROUTES["koya-manga-video"].channel, "channel-pack:koya");
});

test("未知の名前は推測で別の宛先へ寄せない", () => {
  assert.equal(resolveLearningTarget("skill:does-not-exist"), "skill:does-not-exist");
  assert.equal(resolveLearningTarget("toString"), "toString", "prototype の名前を対応表として読まない");
  assert.equal(resolveLearningTarget(undefined), "");
  assert.throws(() => normalizeHarnessFeedbackTarget("skill:does-not-exist"), /既知のlearning target/u);
});

test("旧名で記録した提案も、status と sync では新しい宛先に数えられる", () => {
  const now = "2026-09-24T00:00:00.000Z";
  const rows = [
    { id: "aaaaaaaaaaa1", kind: "fact", target: "skill:manga-video-production", text: "旧名の提案その一", session: "s1", capturedAt: now },
    { id: "aaaaaaaaaaa2", kind: "fact", target: "genre:manga-video-production", text: "新名の提案その二", session: "s1", capturedAt: now },
    { id: "aaaaaaaaaaa3", kind: "fact", target: "skill:harness-parallel-execution", text: "旧名の提案その三", session: "s1", capturedAt: now },
    { id: "aaaaaaaaaaa4", kind: "fact", target: "ledger:koya", text: "チャンネル宛の旧名", session: "s1", capturedAt: now },
  ];
  const summary = summarizeProposals(rows, []);
  assert.deepEqual(
    summary.map((entry) => [entry.id, entry.target, entry.recordedTarget ?? null]).sort(),
    [
      ["aaaaaaaaaaa1", "genre:manga-video-production", "skill:manga-video-production"],
      ["aaaaaaaaaaa2", "genre:manga-video-production", null],
      ["aaaaaaaaaaa3", "platform:harness-parallel-execution", "skill:harness-parallel-execution"],
      ["aaaaaaaaaaa4", "channel-pack:koya", "ledger:koya"],
    ],
  );
  // review の束ね方: 同じ正本に溜まった2件は1つの束になり、「まとめて書く」合図が出る。
  const clusters = clusterForConsolidation(summary);
  const manga = clusters.find((cluster) => cluster.target === "genre:manga-video-production");
  assert.equal(manga.entries.length, 2);
  assert.equal(clusters.some((cluster) => cluster.target.startsWith("skill:")), false);

  const plan = planOverlaySync(summary, loadTargets());
  const overlayFor = (target) => plan.overlays.find((entry) => entry.target === target);
  assert.deepEqual(overlayFor("genre:manga-video-production").entries.map((entry) => entry.id).sort(), ["aaaaaaaaaaa1", "aaaaaaaaaaa2"]);
  assert.deepEqual(overlayFor("platform:harness-parallel-execution").entries.map((entry) => entry.id), ["aaaaaaaaaaa3"]);
  // チャンネル宛は旧名でも review-only のまま保留になる。
  assert.deepEqual(plan.held.map((entry) => [entry.target, entry.count]), [["channel-pack:koya", 1]]);
});

test("共有台帳に残る旧名の提案（2026-09-24 時点で 10 件）が全部、新しい宛先に数えられる", () => {
  // 台帳は追記のみで行を消さないので、旧名の行は増えることはあっても減らない。
  const rows = readLedger("docs/learning/proposals.jsonl");
  const legacyRows = rows.filter((row) => resolveTarget(row.target) !== row.target);
  assert.ok(legacyRows.length >= 10, `旧名の行が想定より少ない: ${legacyRows.length}`);
  const legacyIds = new Set(legacyRows.map((row) => row.id));

  const summary = summarizeProposals(rows, []);
  assert.equal(summary.some((entry) => /^(?:skill|ledger|doc):/u.test(entry.target)), false, "旧名が宛先として残っている");
  for (const entry of summary.filter((item) => legacyIds.has(item.id))) {
    assert.ok(entry.recordedTarget, `${entry.id} の元の宛先が失われた`);
    assert.equal(entry.target, resolveTarget(entry.recordedTarget));
  }

  const plan = planOverlaySync(summary, loadTargets());
  const counted = new Set(plan.overlays.flatMap((overlay) => overlay.entries.map((entry) => entry.id)));
  for (const id of legacyIds) assert.ok(counted.has(id), `${id} が sync のどの overlay にも数えられていない`);

  // 台帳の行そのものは書き換えない（ID は kind+target+text 由来で、書き換えると apply 記録と切れる）。
  assert.equal(legacyRows.every((row) => /^(?:skill|ledger|doc):/u.test(row.target)), true);
  // 公開 catalog は従来どおり解決後の宛先で出る。
  const catalog = buildPublicProposalCatalog(rows);
  for (const id of legacyIds) {
    const entry = catalog.entries.find((item) => item.id === id);
    assert.ok(entry && !entry.target.startsWith("skill:"), `${id} が catalog で旧名のまま`);
  }
});
