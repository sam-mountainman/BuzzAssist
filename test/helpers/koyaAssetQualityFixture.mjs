// 漫画の公式経路の試験で、途中の成果物の品質ループを合格させる（または途中で止める）ための合成の手順。
// 評価者の文脈 id・人の名前・所見はすべて合成の値。本物の評価者も人の確認も使わない。
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  APPROVED_REFERENCES_VERSION,
  assetQualityStage,
  recordAssetHumanVerification,
  recordAssetQualityRound,
  requiredHumanChecks,
  startAssetQualityLoop,
} from "../../lib/assetQualityLoop.mjs";
import { reviewFor } from "../fixtures/assetQualityFixtures.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
let clock = Date.parse("2026-09-25T00:00:00.000Z");
const now = () => {
  clock += 60_000;
  return new Date(clock).toISOString();
};
let counter = 0;

/**
 * 1つの成果物のループを、合成の評価者の採点（全項目が下限以上）と人の確認で合格させる。
 * references: 参照にした承認済みの画のファイル（人物の設定画・本編の画・サムネで人物が写るとき）。
 * approvedReferencesPath を渡さなければ、references の SHA だけを載せた承認一覧を作業フォルダに書く。
 * stopBefore: "review"（start だけ）/ "human"（評価者の採点は合格、人の確認なし）/ "failing-review"（不合格の採点）
 */
export async function passKoyaAssetQualityLoop({
  workDir,
  stage,
  subjectId,
  assetPath,
  references = [],
  approvedReferencesPath = "",
  measurementPath = "",
  stopBefore = "",
} = {}) {
  const spec = assetQualityStage(stage);
  counter += 1;
  const tag = `${stage}-${counter}`;
  const started = await startAssetQualityLoop({
    workDir,
    harnessId: "koya-manga-video",
    stage,
    subjectId,
    generatorContextId: `ctx-synthetic-maker-${tag}`,
    generatorHost: "claude-code",
    now,
  });
  if (!started.started) throw new Error(`loop did not start: ${started.issues.join(", ")}`);
  if (stopBefore === "review") return { started };
  const contract = started.state.asset.contract;
  const assetFile = path.resolve(workDir, assetPath);
  const assetSha = sha(await readFile(assetFile));
  const refShas = [];
  for (const reference of references) refShas.push(sha(await readFile(reference)));
  let approved = approvedReferencesPath;
  if (refShas.length > 0 && !approved) {
    approved = path.join(workDir, "quality", "fixture", `approved-${tag}.json`);
    await mkdir(path.dirname(approved), { recursive: true });
    await writeFile(approved, JSON.stringify({ version: APPROVED_REFERENCES_VERSION, references: refShas.map((value) => ({ sha256: value, kind: "fixture" })) }));
  }
  let measurement = measurementPath;
  if (spec.media === "audio" && !measurement) {
    measurement = path.join(workDir, "quality", "fixture", `measure-${tag}.json`);
    await mkdir(path.dirname(measurement), { recursive: true });
    await writeFile(measurement, JSON.stringify({
      checks: [{ id: "take", type: "voiceQuality", inputSha256: { [assetFile]: assetSha }, checkDigest: "synthetic", status: "pass", metrics: { utmos: 3.4, cer: 0.04 }, problems: [], warnings: [] }],
    }));
  }
  const failing = stopBefore === "failing-review";
  const review = reviewFor({
    stage,
    context: `ctx-synthetic-evaluator-${tag}`,
    assetSha,
    refs: refShas,
    contract,
    overrides: failing ? { [contract.rubric[0].id]: 10 } : {},
  });
  const reviewPath = path.join(workDir, "quality", "fixture", `review-${tag}.json`);
  await mkdir(path.dirname(reviewPath), { recursive: true });
  await writeFile(reviewPath, JSON.stringify(review));
  const recorded = await recordAssetQualityRound({
    workDir,
    stage,
    subjectId,
    assetPath: assetFile,
    versionLabel: "v1",
    reviewPath,
    producerContexts: [`ctx-synthetic-maker-${tag}`],
    producerHost: "claude-code",
    generationRoute: spec.media === "audio" ? "broker" : "codex",
    references,
    referenceExemptReason: refShas.length === 0 && spec.referencePolicy === "required-or-exempt" ? "人物が写らない合成の画" : "",
    approvedReferencesPath: approved,
    measurementPath: measurement,
    now,
  });
  if (!recorded.recorded) throw new Error(`round was not recorded: ${recorded.issues.join(", ")}`);
  if (failing || stopBefore === "human") return { started, recorded };
  const checks = requiredHumanChecks(stage, recorded.version);
  if (checks.length > 0) {
    await recordAssetHumanVerification({
      workDir,
      stage,
      subjectId,
      assetPath: assetFile,
      checks,
      verdict: "pass",
      reviewer: "synthetic-reviewer",
      note: "原寸で参照と並べ、手元を拡大して見た（合成）",
      humanVerified: true,
      isInteractive: true,
      now,
    });
  }
  return { started, recorded };
}

/** v54 より前の契約（ゲートの効力の外）。今の契約の写しから版を戻し、節を外す。 */
export async function legacyKoyaContract(root) {
  const contract = JSON.parse(await readFile(path.join(root, "config/koya-manga-production-contract.json"), "utf8"));
  contract.version = "koya-manga-production-v53";
  delete contract.assetQualityGate;
  return contract;
}

export async function currentKoyaContract(root) {
  return JSON.parse(await readFile(path.join(root, "config/koya-manga-production-contract.json"), "utf8"));
}
