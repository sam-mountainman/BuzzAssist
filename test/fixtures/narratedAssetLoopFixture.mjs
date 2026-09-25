/**
 * ナレーション物語の公式経路の試験で、途中の成果物の品質ループ（lib/assetQualityLoop.mjs）を本物の実装で回す
 * 合成の手順。ループの判定を差し替えず、start → 別文脈の評価者の採点 → record → 人の確認（要る欄だけ）を
 * 実際に書く。評価者・人の名前・会話 id・所見はすべて合成の値。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  APPROVED_REFERENCES_VERSION,
  assetQualityStage,
  assetQualityStatus,
  recordAssetHumanVerification,
  recordAssetQualityRound,
  startAssetQualityLoop,
} from "../../lib/assetQualityLoop.mjs";
import { VIDEO_CLIP_DECLARATION_VERSION, writeVideoClipMeasurement } from "../../lib/videoClipMeasurement.mjs";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const IDENTITY_NOTES = { face: "輪郭と目の形を参照と並べて見た", hair: "分け目と前髪の形を並べて見た", body: "頭身と肩幅を並べて見た" };

let evaluatorCounter = 0;
/** 回ごとに新しい評価文脈（作った文脈とも前の回とも違う）。 */
export function freshEvaluatorContext(label = "fixture-asset-eval") {
  evaluatorCounter += 1;
  return `${label}-${process.pid}-${evaluatorCounter}`;
}

/** 承認済みの参照の一覧（buzzassist-approved-references-v1）を書く。 */
export async function writeApprovedReferences(file, shas) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ version: APPROVED_REFERENCES_VERSION, references: shas.map((sha) => ({ sha256: sha, kind: "character-identity" })) }, null, 2)}\n`);
  return file;
}

function scoresFor(contract, overrides = {}) {
  // 二値の安全項目（下限 100）は満点、ほかは 95（目標 90 を越え、どの下限も割らない）。
  return Object.fromEntries(contract.rubric.map((row) => [row.id, overrides[row.id] ?? (row.minimumScore >= 100 ? 100 : 95)]));
}

/**
 * 1つの対象のループを、1回の採点で進める。scores を渡すと低い点で不合格の回も作れる。
 * humanVerdict: "pass"（要る欄を全部可にする）/ "reject" / null（人の確認をしない）
 */
export async function recordAssetLoopRound({
  workDir,
  stage,
  subjectId,
  assetPath,
  harnessId = "narrated-story-video",
  generatorContextId = "fixture-asset-maker",
  producerHost = "buzzassist",
  route = "broker",
  references = [],
  approvedReferencesPath = "",
  measurementPath = "",
  charactersVisible = null,
  referenceExemptReason = "",
  scores = {},
  versionLabel = "",
  humanVerdict = "pass",
  evaluatorContextId = "",
  revisionDelta = "",
}) {
  const spec = assetQualityStage(stage);
  const before = await assetQualityStatus({ workDir, stage, subjectId });
  if (!before.started) {
    const started = await startAssetQualityLoop({ workDir, harnessId, stage, subjectId, generatorContextId, generatorHost: producerHost });
    if (!started.started) throw new Error(`fixture could not start the ${stage} loop: ${started.issues.join(", ")}`);
  } else if (before.state?.status !== "active") {
    // 合格・人待ちで止まったループに、直した版を採点させるときは始め直す（前の状態は history に残る）。
    const restarted = await startAssetQualityLoop({
      workDir, harnessId, stage, subjectId, generatorContextId, generatorHost: producerHost,
      restart: true, restartReason: "差し替えた版を採点する（合成）",
    });
    if (!restarted.started) throw new Error(`fixture could not restart the ${stage} loop: ${restarted.issues.join(", ")}`);
  }
  const state = (await assetQualityStatus({ workDir, stage, subjectId })).state;
  const contract = state.asset.contract;
  const absoluteAsset = path.resolve(workDir, assetPath);
  const assetSha = sha256(await readFile(absoluteAsset));
  const refs = references.map((value) => (/^[a-f0-9]{64}$/u.test(value) ? value : null)).filter(Boolean);
  const context = evaluatorContextId || freshEvaluatorContext();
  const visible = charactersVisible ?? refs.length > 0;
  const review = {
    evaluatorId: "fixture-evaluator",
    evaluatorContextId: context,
    evaluatorHost: "codex",
    assetSha256: assetSha,
    ...(spec.reviewRequirements.includes("charactersVisible") ? { charactersVisible: visible } : {}),
    ...(spec.reviewRequirements.includes("viewedAtDecidedSize") ? { viewedAtDecidedSize: true } : {}),
    ...(refs.length > 0 ? { comparedReferenceSha256s: refs, identityComparison: IDENTITY_NOTES } : {}),
    ...(spec.reviewRequirements.includes("framesReviewed")
      ? { framesReviewed: { start: `始まりのフレームを見た（${context}）`, middle: `中ほどのフレームを見た（${context}）`, end: `終わりのフレームを見た（${context}）` } }
      : {}),
    rubricScores: scoresFor(contract, scores),
    notes: `原寸で全体を見て（声は前後と続けて聞いて）判断した（合成の所見・${context}）`,
    findings: [],
  };
  const reviewRel = path.posix.join("review", "asset-loop", `${stage}--${subjectId}--${context}.json`);
  await mkdir(path.join(workDir, "review", "asset-loop"), { recursive: true });
  await writeFile(path.join(workDir, ...reviewRel.split("/")), `${JSON.stringify(review, null, 2)}\n`);
  const rounds = state.rounds?.length || 0;
  const previousFailure = rounds > 0 ? state.rounds[rounds - 1].failureFingerprint : "";
  const recorded = await recordAssetQualityRound({
    workDir,
    stage,
    subjectId,
    assetPath: absoluteAsset,
    versionLabel: versionLabel || `v${rounds + 1}`,
    reviewPath: path.join(workDir, ...reviewRel.split("/")),
    producerContexts: [generatorContextId],
    producerHost,
    generationRoute: route,
    references: refs,
    ...(refs.length === 0 && spec.referencePolicy === "required-or-exempt"
      ? { referenceExemptReason: referenceExemptReason || "人物が写らない合成の場面" }
      : {}),
    ...(approvedReferencesPath ? { approvedReferencesPath } : {}),
    ...(measurementPath ? { measurementPath: path.resolve(workDir, measurementPath) } : {}),
    ...(previousFailure ? { previousFailureFingerprint: previousFailure, revisionDelta: revisionDelta || "指摘された点を直した（合成）" } : {}),
  });
  if (!recorded.recorded) throw new Error(`fixture could not record the ${stage} round for ${subjectId}: ${recorded.issues.join(", ")}`);
  const missing = recorded.check?.humanVerification?.missing || [];
  if (humanVerdict && missing.length > 0) {
    await verifyAssetLoop({ workDir, stage, subjectId, assetPath: absoluteAsset, checks: missing, verdict: humanVerdict });
  }
  return assetQualityStatus({ workDir, stage, subjectId, assetPath: absoluteAsset });
}

/** 人の確認（対話端末＋--human-verified と同じ記録）。 */
export function verifyAssetLoop({ workDir, stage, subjectId, assetPath, checks, verdict = "pass" }) {
  return recordAssetHumanVerification({
    workDir,
    stage,
    subjectId,
    assetPath: path.resolve(workDir, assetPath),
    checks,
    verdict,
    reviewer: "fixture-human-reviewer",
    note: "原寸で参照と並べ、手元を拡大して見た（合成）",
    humanVerified: true,
    isInteractive: true,
  });
}

/**
 * 運営者の画のフォルダ（取り込みの記録のあるフォルダ＝品質ループの作業フォルダ）で、記録の全部の場面の
 * 本編の画のループと、記録が宣言した参照の人物の設定画のループを合格させ、記録に assetLoop を書く。
 * referenceSheets: sha256 → 設定画のバイト列（記録が参照する承認済みの設定画そのもの）
 */
export async function passOperatorImageLoops({ folder, manifestPath, manifest, referenceSheets = new Map(), writeManifest }) {
  const anchor = Buffer.concat([Buffer.from("fixture-anchor-sheet-"), Buffer.from(String(referenceSheets.size))]);
  const anchorPath = path.join(folder, "refs", "anchor.png");
  await mkdir(path.dirname(anchorPath), { recursive: true });
  // 設定画の参照に使う基準画（PNG として読める最小の形。中身は合成）。
  await writeFile(anchorPath, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), anchor]));
  const anchorSha = sha256(await readFile(anchorPath));
  const approved = await writeApprovedReferences(path.join(folder, "refs", "approved.json"), [anchorSha, ...referenceSheets.keys()]);
  let index = 0;
  for (const [sheetSha, bytes] of referenceSheets) {
    index += 1;
    const sheetPath = path.join(folder, "refs", `sheet-${index}.png`);
    await writeFile(sheetPath, bytes);
    if (sha256(bytes) !== sheetSha) throw new Error("fixture reference sheet bytes do not match their sha256");
    await recordAssetLoopRound({
      workDir: folder, stage: "character", subjectId: `c${String(index).padStart(2, "0")}`, assetPath: sheetPath,
      generatorContextId: "fixture-sheet-maker", route: "chatgpt-web", references: [anchorSha], approvedReferencesPath: approved,
    });
  }
  for (const scene of manifest.scenes) {
    const imagePath = path.join(folder, ...scene.image.path.split("/"));
    const refs = scene.referenceSha256s || [];
    const status = await recordAssetLoopRound({
      workDir: folder, stage: "scene-image", subjectId: scene.sceneId, assetPath: imagePath,
      generatorContextId: "fixture-operator-maker", route: "chatgpt-web",
      references: refs, approvedReferencesPath: approved, charactersVisible: refs.length > 0,
    });
    if (status.pass !== true) throw new Error(`fixture scene loop did not pass for ${scene.sceneId}: ${status.issues.join(", ")}`);
    scene.assetLoop = { statePath: `quality/assets/scene-image--${scene.sceneId}.json`, passedSha256: sha256(await readFile(imagePath)) };
  }
  await writeManifest(manifestPath, manifest);
  return { approvedReferencesPath: approved };
}

/**
 * 運営者の動画の取り込みの記録（buzzassist-operator-video-manifest-v1）のフォルダ（＝品質ループの作業フォルダ）で、
 * 記録の全部の動画の工程 video-clip のループを合格させ、記録に assetLoop を書く。測定は measure-video と同じ
 * writeVideoClipMeasurement で、宣言は declarations[枠]（無ければ広い範囲）。参照は付けず、人物が写らない版として
 * 採点する（合成の動画は色と図形だけ）。
 */
export async function passOperatorVideoLoops({ folder, manifestPath, declarations = {} }) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const clip of manifest.clips) {
    const videoPath = path.join(folder, ...clip.video.path.split("/"));
    const measurementRel = path.posix.join("quality", "measure", `${clip.slot}.json`);
    await writeVideoClipMeasurement({
      assetPath: videoPath,
      outputPath: path.join(folder, ...measurementRel.split("/")),
      declaration: declarations[clip.slot] || {
        version: VIDEO_CLIP_DECLARATION_VERSION,
        durationSeconds: { min: 0.04, max: 3600 },
        frameRate: { min: 1, max: 240 },
        width: { min: 16 },
        height: { min: 16 },
        audio: "optional",
      },
    });
    const status = await recordAssetLoopRound({
      workDir: folder, stage: "video-clip", subjectId: clip.slot, assetPath: videoPath,
      generatorContextId: "fixture-operator-video-maker", route: clip.route === "recorded" ? "recorded" : "grok",
      charactersVisible: false, referenceExemptReason: "人物の写らない合成の動画", measurementPath: measurementRel,
    });
    if (status.pass !== true) throw new Error(`fixture video loop did not pass for ${clip.slot}: ${status.issues.join(", ")}`);
    clip.assetLoop = { statePath: `quality/assets/video-clip--${clip.slot}.json`, passedSha256: sha256(await readFile(videoPath)) };
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

/**
 * pipeline が返した assetQualityLoop.pending のうち、Job の作業フォルダで回せるもの（broker の本編の画と
 * 声のテイク）を合格させる。運営者の画と人物の設定画は、運営者の作業フォルダで前もって回しておく。
 */
export async function passPendingNarratedAssetLoops(outcome) {
  const pending = outcome?.assetQualityLoop?.pending || [];
  for (const item of pending) {
    if (item.stage === "scene-image" && item.source === "broker") {
      await recordAssetLoopRound({
        workDir: item.workDir,
        stage: "scene-image",
        subjectId: item.subjectId,
        assetPath: item.assetPath,
        generatorContextId: item.generatorContextId,
        route: "broker",
      });
    } else if (item.stage === "voice-take" && item.reason !== "voice-quality-gate-failed") {
      await recordAssetLoopRound({
        workDir: item.workDir,
        stage: "voice-take",
        subjectId: item.subjectId,
        assetPath: item.assetPath,
        generatorContextId: item.generatorContextId,
        route: "broker",
        measurementPath: item.measurementPath,
      });
    }
  }
  return pending;
}

/**
 * pipeline を回し、途中の成果物の品質ループで止まったら pending を合格させてもう一度回す（運営者の画は
 * 有料の処理の前に1回、声のテイクは生成の後に1回止まり得るので、最大2回）。
 */
export async function runPastAssetLoops(run, { onStop = null } = {}) {
  let outcome = await run();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pending = outcome?.assetQualityLoop?.pending || [];
    if (outcome?.assetQualityLoop?.pass !== false || pending.length === 0) break;
    if (typeof onStop === "function") await onStop(outcome);
    await passPendingNarratedAssetLoops(outcome);
    outcome = await run();
  }
  return outcome;
}
