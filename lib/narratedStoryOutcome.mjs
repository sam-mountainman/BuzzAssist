/**
 * Receipt-safe output shared by narrated-story production stages and the outer
 * narrated-story-video adapter. A stage must never mark a gate as passed
 * merely because that gate belongs to a later stage.
 */

export const NARRATED_STORY_AUDIT_IDS = Object.freeze([
  "audioIntegratedLoudness",
  "narrationBedSeparation",
  "perceptualReviewChecks",
  "duration",
  "frozenV1AndParentHashes",
  "parentAudioPcmPreserved",
  "perceptualReviewBoundToOutput",
  "perceptualEvidenceHashes",
  "contactSheetOriginalDetailReviewed",
  "pixelAudit",
  "sceneTransitionOwnedByParent",
  "audioBoundaryBreathV16",
  "noWholeProgramAcrossfade",
  "avEndSync",
  "bookendTransitionMeasured",
  "operatorReplacementCleared",
  // 品質ループ（lib/narratedStoryQualityLoop.mjs）。独立 signoff の後に判定する。
  "qualityLoopPassed",
  // 監査契約 v4: 語りと台詞の全テイクの音声品質ゲート、役の声の照合、人物の同一性（署名済み独立レビュー）。
  "voiceTakeQuality",
  "voiceCastRouting",
  "characterIdentityReviewed",
  // 監査契約 v5: 場面の画の出どころ（有料の Media Job の受領記録か運営者の画の取り込みの記録と sha256 で照合）と、
  // 途中の成果物の品質ループ（lib/narratedStoryAssetLoops.mjs の NARRATED_ASSET_LOOP_AUDIT_IDS と同じ。試験が一致を見る）。
  "sceneImageProvenance",
  "sceneImageAssetLoopPassed",
  "voiceTakeAssetLoopPassed",
  "characterAssetLoopPassed",
  // 監査契約 v6: 見た目の実測（lib/narratedStoryVisuals.mjs）。焼き込み字幕・カメラの動き・感想パートの配置・
  // 回ごとの OP 映像の来歴。どれも完成 MP4 のフレームを読んで測る。
  "burnedSubtitlesMeasured",
  "cameraMotionMeasured",
  "reviewLayoutMeasured",
  "episodeOpeningProvenance",
  // 監査契約 v7: 回ごとの運営者の動画（OP 映像・感想パートの人物の映像）の途中の成果物の品質ループ（工程 video-clip。
  // lib/narratedStoryAssetLoops.mjs の NARRATED_VIDEO_CLIP_LOOP_AUDIT_ID と同じ）。取り込んだ動画が無い回は合格。
  "operatorVideoAssetLoopPassed",
  // 監査契約 v8: 使う台本が台本の品質ループに合格した版か、人がそのまま使うと認めた版か（lib/narratedStoryScriptQuality.mjs）。
  // 有料の処理の前に問うた答えを残す。
  "scriptQualityAccepted",
  // 監査契約 v9: 本編の場面の切り替え（lib/narratedStorySceneTransitions.mjs）と固定の重ね物
  // （lib/narratedStoryOverlays.mjs）。どちらも完成 MP4 のフレームを読んで測り、宣言が無ければ描いていないことを確かめる。
  "sceneTransitionMeasured",
  "fixedOverlaysMeasured",
  // 監査契約 v10: 場面ごとの焦点（lib/narratedStoryCamera.mjs の measureNarratedCameraFocus）。焦点を指定した場面の
  // ショットを、完成 MP4 のフレームと、場面の画を計画の見せる範囲で切り出した絵とで比べる。指定が無ければ、どの
  // ショットも Pack の型ごとの焦点で計画したことを確かめる。
  "cameraFocusMeasured",
  // 監査契約 v11: 本編の文と文・場面と場面の間（lib/narratedStoryPacing.mjs の measureNarratedPacing）。Pack が pacing を
  // 宣言したら、完成 MP4 と voice stem で、間の区間に語りが無く BGM が流れ、足した無音が宣言どおりの長さで、字幕が
  // 語りの区切りで切り替わり、場面の切り替えが間の中にあることを測る。宣言が無ければ、文が間を空けずに並んでいることを確かめる。
  "narrationPacingMeasured",
]);

function text(value) {
  return typeof value === "string" ? value : "";
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function receiptSafeMediaJob(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
  return {
    version: text(receipt.version),
    jobId: text(receipt.jobId),
    requestKey: text(receipt.requestKey),
    status: text(receipt.status),
    kind: text(receipt.kind),
    provider: text(receipt.provider),
    adapterVersion: text(receipt.adapterVersion),
    providerJobId: text(receipt.providerJobId),
    model: text(receipt.model),
    voiceId: text(receipt.voiceId),
    inputHash: text(receipt.inputHash),
    identityHash: text(receipt.identityHash),
    reservation: {
      reservationId: text(receipt.reservation?.reservationId),
      status: text(receipt.reservation?.status),
      requestedAt: text(receipt.reservation?.requestedAt),
      unit: text(receipt.reservation?.unit),
      estimatedSeconds: finite(receipt.reservation?.estimatedSeconds),
      estimatedUnits: finite(receipt.reservation?.estimatedUnits),
      estimatedCost: finite(receipt.reservation?.estimatedCost),
      currency: text(receipt.reservation?.currency),
    },
    usage: {
      seconds: finite(receipt.usage?.seconds),
      units: finite(receipt.usage?.units),
      cost: finite(receipt.usage?.cost),
      currency: text(receipt.usage?.currency),
      freeRegeneration: receipt.usage?.freeRegeneration === true,
    },
    artifact: {
      sha256: text(receipt.artifact?.sha256),
      mimeType: text(receipt.artifact?.mimeType),
      bytes: finite(receipt.artifact?.bytes),
    },
    attempts: {
      total: finite(receipt.attempts?.total) ?? 0,
      retries: Array.isArray(receipt.attempts?.retries)
        ? receipt.attempts.retries.map((retry) => ({
          operation: text(retry?.operation),
          attempt: finite(retry?.attempt),
          status: finite(retry?.status),
          backoffMs: finite(retry?.backoffMs),
        }))
        : [],
    },
    createdAt: text(receipt.createdAt),
    updatedAt: text(receipt.updatedAt),
  };
}

export function receiptSafeMediaJobs(receipts = []) {
  const seen = new Set();
  const output = [];
  for (const raw of Array.isArray(receipts) ? receipts : []) {
    const receipt = receiptSafeMediaJob(raw);
    if (!receipt) continue;
    const identity = receipt.jobId || receipt.requestKey;
    if (identity && seen.has(identity)) continue;
    if (identity) seen.add(identity);
    output.push(receipt);
  }
  return output;
}

export function pendingNarratedStoryAuditChecks(stage = "production-stage") {
  const detail = `not evaluated by ${text(stage) || "production-stage"}`;
  return Object.fromEntries(NARRATED_STORY_AUDIT_IDS.map((id) => [id, { pass: false, detail }]));
}

export function buildNarratedStoryOutcome({
  status,
  artifacts = {},
  knownRemainingIssues = [],
  mediaJobs = [],
  auditChecks = null,
  runReceiptPath = null,
  ...details
} = {}) {
  if (!text(status)) throw new Error("Narrated-story outcome requires status.");
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) {
    throw new Error("Narrated-story outcome artifacts must be an object.");
  }
  if (!Array.isArray(knownRemainingIssues)) {
    throw new Error("Narrated-story outcome knownRemainingIssues must be an array.");
  }
  return {
    ...details,
    status,
    artifacts,
    knownRemainingIssues: knownRemainingIssues.map(String),
    mediaJobs: receiptSafeMediaJobs(mediaJobs),
    auditChecks: auditChecks && typeof auditChecks === "object" && !Array.isArray(auditChecks)
      ? auditChecks
      : pendingNarratedStoryAuditChecks(status),
    runReceiptPath: text(runReceiptPath) || null,
  };
}
