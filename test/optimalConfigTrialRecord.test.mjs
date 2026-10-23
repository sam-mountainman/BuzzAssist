import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { finalizeRunReceipt, openRunReceipt, recordGate, redactForPlatform } from "../lib/harnessRunReceipt.mjs";
import { selectConfig } from "../lib/optimalConfig/selectConfig.mjs";
import {
  TRIAL_RESULT_FIELDS,
  addTrialResult,
  attachTrialToRunReceipt,
  computeTrialMetrics,
  createTrialPlan,
  recommendFromTrial,
  validateTrialResult,
} from "../lib/optimalConfig/trialRecord.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const traits = JSON.parse(readFileSync(new URL("../examples/optimal-config/traits/fixed-cast-manga.json", import.meta.url), "utf8"));

function result(cutId, candidateId, overrides = {}) {
  return {
    cutId,
    candidateId,
    purpose: "2人の掛け合い",
    style: "flat-2d-manga",
    inputAssetIds: ["ref-a", "ref-b"],
    inputMode: "multi-ref",
    fixedConditions: ["顔", "衣装", "場所"],
    dialogueAudio: { dialogue: true, audio: false },
    model: { id: "gpt-image", checkpointVersion: null },
    runtime: { name: "codex", version: "unknown", place: "operator-service" },
    hardware: { gpu: "Apple M3", vramGiB: null, ramGiB: 16 },
    output: { resolution: "1920x1080", durationSeconds: 6, fps: null },
    params: { steps: null, cfg: null, quantization: null, loras: [] },
    setupMinutes: 0,
    waitSeconds: 40,
    humanMinutes: 3,
    cashCostJpy: 0,
    generatedSeconds: 6,
    adoptedSeconds: 6,
    rejectionReason: null,
    fixMinutes: 0,
    rightsCheckSource: "optimal-config catalog 2026-10-22",
    dataDestination: "OpenAI",
    ...overrides,
  };
}

function fullTrial() {
  const selection = selectConfig(traits);
  const trial = createTrialPlan({ channelId: traits.channelId, candidates: selection.candidates.slice(0, 2), createdAt: "2026-10-22T00:00:00.000Z" });
  for (const cut of trial.cuts) {
    addTrialResult(trial, result(cut.cutId, "A", { cashCostJpy: 10 }));
    addTrialResult(trial, result(cut.cutId, "B", {
      model: { id: "flux2-klein-4b", checkpointVersion: "FLUX.2-klein-4B" },
      runtime: { name: "ollama", version: "unknown", place: "operator-mac" },
      dataDestination: "local",
      adoptedSeconds: cut.kind === "hard" ? 0 : 6,
      rejectionReason: cut.kind === "hard" ? "顔が別人になる" : null,
      fixMinutes: 2,
    }));
  }
  return trial;
}

test("段取りは典型5＋難しい5の10カットで、結果の欄は p18 の最小項目どおり", () => {
  const trial = createTrialPlan({ channelId: "fixed-cast-manga", candidates: [{ id: "A" }, { id: "B" }] });
  assert.equal(trial.cuts.length, 10);
  assert.equal(trial.cuts.filter((cut) => cut.kind === "typical").length, 5);
  assert.equal(trial.cuts.filter((cut) => cut.kind === "hard").length, 5);
  assert.equal(TRIAL_RESULT_FIELDS.length, 23);
  for (const field of ["cutId", "purpose", "style", "inputAssetIds", "inputMode", "fixedConditions", "dialogueAudio", "model", "runtime", "hardware", "output", "params", "setupMinutes", "waitSeconds", "humanMinutes", "cashCostJpy", "generatedSeconds", "adoptedSeconds", "rejectionReason", "fixMinutes", "rightsCheckSource", "dataDestination"]) {
    assert.ok(TRIAL_RESULT_FIELDS.includes(field), field);
  }
});

test("欠けた欄・矛盾した数字は日本語の理由で止める", () => {
  const broken = result("typical-1", "A");
  delete broken.dataDestination;
  broken.adoptedSeconds = 3;
  const { ok, errors } = validateTrialResult(broken);
  assert.equal(ok, false);
  assert.ok(errors.some((item) => /素材の送信先/u.test(item.message)));
  assert.ok(errors.some((item) => /不採用の理由/u.test(item.message)), "採用しなかった秒があるのに理由が無い");
  assert.equal(validateTrialResult(result("x", "A", { adoptedSeconds: 9 })).ok, false, "生成した秒数より多くは採用できない");
  const trial = createTrialPlan({ channelId: "fixed-cast-manga", candidates: [{ id: "A" }] });
  assert.throws(() => addTrialResult(trial, result("unknown-cut", "A")), /段取りに無いカット/u);
  addTrialResult(trial, result("typical-1", "A"));
  assert.throws(() => addTrialResult(trial, result("typical-1", "A")), /既にある/u);
});

test("採用秒率・採用1秒あたりの現金・採用1秒あたりの人の時間を候補ごとに出す", () => {
  const trial = fullTrial();
  const [a, b] = computeTrialMetrics(trial);
  assert.equal(a.complete, true);
  assert.equal(a.adoptedSecondRate, 1);
  assert.equal(a.cashPerAdoptedSecondJpy, Math.round((100 / 60) * 10_000) / 10_000);
  assert.equal(a.humanMinutesPerAdoptedSecond, 0.5);
  assert.equal(b.adoptedSecondRate, 0.5);
  assert.equal(b.cashPerAdoptedSecondJpy, 0);
  assert.equal(b.humanMinutesPerAdoptedSecond, Math.round((50 / 30) * 10_000) / 10_000);
  assert.deepEqual(b.rejectionReasons, { "顔が別人になる": 5 });
  assert.deepEqual(recommendFromTrial(trial), { production: "A", fallback: "B", note: recommendFromTrial(trial).note });
  const partial = createTrialPlan({ channelId: "fixed-cast-manga", candidates: [{ id: "A" }] });
  addTrialResult(partial, result("typical-1", "A"));
  assert.equal(computeTrialMetrics(partial)[0].complete, false);
  assert.equal(recommendFromTrial(partial).production, null, "10カットそろわない候補は提案しない");
});

function openReceipt() {
  return openRunReceipt({ projectDir: root, harnessId: "koya-manga-video", entrypoint: "scripts/optimal-config.mjs", action: "trial", inputs: {} });
}

test("RunReceipt には任意の configTrial 欄として足し、素材 ID は digest にする。欄の無い記録は今までどおり", () => {
  const receipt = openReceipt();
  attachTrialToRunReceipt(receipt, fullTrial());
  assert.equal(receipt.configTrial.version, "optimal-config-trial-v1");
  assert.equal(receipt.configTrial.results.length, 20);
  assert.equal(JSON.stringify(receipt.configTrial).includes("\"ref-a\""), false, "素材 ID の生値は残さない");
  assert.equal(receipt.configTrial.results[0].inputAssetIds[0], createHash("sha256").update("ref-a").digest("hex"));
  for (const id of receipt.harnessBuild.declaredGates) recordGate(receipt, { id, verdict: "pass", evidence: { measured: 1 } });
  const done = finalizeRunReceipt(receipt, { outcome: "pass", timestamp: "2026-10-22T00:00:00.000Z" });
  const platform = redactForPlatform(done);
  assert.equal(platform.configTrial.candidateCount, 2);
  assert.equal(platform.configTrial.cutCount, 10);
  assert.equal(JSON.stringify(platform.configTrial).includes("顔が別人"), false, "不採用の理由の本文は返さない");
  assert.throws(() => attachTrialToRunReceipt(done, fullTrial()), /finalize 済み/u);

  const plain = openReceipt();
  for (const id of plain.harnessBuild.declaredGates) recordGate(plain, { id, verdict: "pass", evidence: { measured: 1 } });
  const plainDone = finalizeRunReceipt(plain, { outcome: "pass", timestamp: "2026-10-22T00:00:00.000Z" });
  assert.equal(plainDone.configTrial, undefined);
  assert.equal(redactForPlatform(plainDone).configTrial, null);
});
