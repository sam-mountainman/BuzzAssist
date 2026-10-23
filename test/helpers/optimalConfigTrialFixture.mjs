// 最適構成エンジンのテスト用の10カット試験（全部そろった記録）。生成はしない。
import { readFileSync } from "node:fs";

import { selectConfig } from "../../lib/optimalConfig/selectConfig.mjs";
import { addTrialResult, createTrialPlan } from "../../lib/optimalConfig/trialRecord.mjs";

export function exampleTraits(name = "fixed-cast-manga") {
  return JSON.parse(readFileSync(new URL(`../../examples/optimal-config/traits/${name}.json`, import.meta.url), "utf8"));
}

export function trialResult(cutId, candidateId, overrides = {}) {
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

/** 候補 A・B の10カットがそろった試験。completeCandidates に無い候補は1カットだけ。 */
export function completedTrial(traits = exampleTraits(), { candidateCount = 2, completeCandidates = ["A", "B"] } = {}) {
  const selection = selectConfig(traits);
  const trial = createTrialPlan({ channelId: traits.channelId, candidates: selection.candidates.slice(0, candidateCount), createdAt: "2026-10-22T00:00:00.000Z" });
  for (const candidate of trial.candidates) {
    const cuts = completeCandidates.includes(candidate.candidateId) ? trial.cuts : trial.cuts.slice(0, 1);
    for (const cut of cuts) {
      addTrialResult(trial, trialResult(cut.cutId, candidate.candidateId, candidate.candidateId === "A"
        ? { cashCostJpy: 10 }
        : { adoptedSeconds: cut.kind === "hard" ? 0 : 6, rejectionReason: cut.kind === "hard" ? "顔が別人になる" : null, fixMinutes: 2 }));
    }
  }
  return trial;
}
