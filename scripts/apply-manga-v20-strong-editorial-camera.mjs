#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { normalizeCameraShotSequence } from "../lib/mangaVideoPipeline.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const manifestPath = resolve(process.argv[3] || join(
  projectDir,
  "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json",
));
const episodeDir = dirname(manifestPath);
const planPath = join(episodeDir, "v20-strong-editorial-camera-plan.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const v19Plan = JSON.parse(await readFile(join(episodeDir, "v19-editorial-camera-multibubble-plan.json"), "utf8"));
const utteranceById = new Map(manifest.utterances.map((utterance) => [utterance.id, utterance]));
const groupKey = (cutId, utteranceIds) => `${cutId}:${utteranceIds.join(",")}`;
const approvedTargetFocus = new Map(v19Plan.cameraRows.map((row) => [
  groupKey(row.cutId, row.utteranceIds),
  {
    focusX: row.focusX,
    focusY: row.focusY,
    focusXEnd: row.focusXEnd,
    focusYEnd: row.focusYEnd,
  },
]));
const semanticShotRules = new Map([
  [groupKey("cut-01", ["cut-01-u01", "cut-01-u02"]), { angle: "wide", viewMode: "wide-pullout", purpose: "写真店と雨の状況を先に理解させる" }],
  [groupKey("cut-01", ["cut-01-u03"]), { angle: "left", viewMode: "left-pullout", purpose: "蓮の独り言と作業姿勢を左側から捉える" }],
  [groupKey("cut-02", ["cut-02-u01", "cut-02-u02"]), { angle: "top", viewMode: "top-pullout", purpose: "補修する手元・家族写真・作業机を見せる" }],
  [groupKey("cut-03", ["cut-03-u01", "cut-03-u02"]), { angle: "right", viewMode: "right-to-left-pullout", useReplyTarget: true, purpose: "右側の澪から左側の蓮の反応へ渡す" }],
  [groupKey("cut-03", ["cut-03-u03"]), { angle: "right", viewMode: "right-pullout", purpose: "澪の帰る場所への迷いを寄りで見せる" }],
  [groupKey("cut-04", ["cut-04-u01", "cut-04-u02"]), { angle: "right", viewMode: "right-to-left-pullout", useReplyTarget: true, purpose: "写真を持つ澪から証拠を問う蓮へ渡す" }],
  [groupKey("cut-04", ["cut-04-u03"]), { angle: "right", viewMode: "right-pullout", purpose: "澪の脆さと信頼の告白を保つ" }],
  [groupKey("cut-05", ["cut-05-u01", "cut-05-u02"]), { angle: "right-wide", viewMode: "right-to-left-pullout", useReplyTarget: true, purpose: "右から入る礼司の圧力から蓮の追及へ渡す" }],
  [groupKey("cut-05", ["cut-05-u03"]), { angle: "right", viewMode: "right-pullout", purpose: "礼司の傲慢さを単独で強調する" }],
  [groupKey("cut-06", ["cut-06-u01", "cut-06-u02"]), { angle: "right-wide", viewMode: "left-to-right-pullout", useReplyTarget: true, purpose: "澪の拒絶から右側の礼司の反撃へ渡す" }],
  [groupKey("cut-07", ["cut-07-u01", "cut-07-u02"]), { angle: "top", viewMode: "top-pullout", purpose: "ネガ・日時・依頼票という証拠関係を俯瞰する" }],
  [groupKey("cut-07", ["cut-07-u03"]), { angle: "right", viewMode: "right-pullout", purpose: "証拠を突きつけられた礼司の反応を捉える" }],
  [groupKey("cut-08", ["cut-08-u01"]), { angle: "top", viewMode: "top-pullout", purpose: "澪の送信操作と証拠を見せる" }],
  [groupKey("cut-08", ["cut-08-u02", "cut-08-u03"]), { angle: "wide", viewMode: "wide-pullout", purpose: "展示中止と契約解除を個人から社会的結果へ広げる" }],
  [groupKey("cut-09", ["cut-09-u01"]), { angle: "right", viewMode: "right-pullout", purpose: "幼い澪の約束を右側から捉える" }],
  [groupKey("cut-09", ["cut-09-u02"]), { angle: "left", viewMode: "left-pullout", purpose: "幼い蓮の返答を逆側から捉える" }],
  [groupKey("cut-09", ["cut-09-u03"]), { angle: "top-wide", viewMode: "top-pullout", purpose: "二人の約束と帰る道を俯瞰の記憶として見せる" }],
  [groupKey("cut-10", ["cut-10-u01"]), { angle: "right", viewMode: "right-pullout", purpose: "澪のスタジオ提案を澪側から見せる" }],
  [groupKey("cut-10", ["cut-10-u02"]), { angle: "right", viewMode: "right-pullout", purpose: "澪の個人的な告白を同じ側で保つ" }],
  [groupKey("cut-10", ["cut-10-u03", "cut-10-u04"]), { angle: "wide", viewMode: "subject-to-wide-pullout", purpose: "蓮の返答から二人の新しい生活へ開く" }],
]);

const angleFamily = (angle) => String(angle || "wide").replace(/-wide$/u, "");
const zoomRevealFraction = (shot) => {
  const family = angleFamily(shot.angle);
  // A plain left/right/top label receives the same large pull-out as its
  // “-wide” variant.  The suffix describes the source composition, not a
  // weaker animation tier.
  if (family === "top") return .38;
  if (family === "left" || family === "right") return .36;
  return .30;
};

function strongDirectionalCamera(shot, targetFocus, semanticRule) {
  const family = angleFamily(shot.angle);
  const original = shot.camera || {};
  const revealFraction = zoomRevealFraction(shot);
  if (!targetFocus) throw new Error(`Missing approved target focus for ${shot.id}`);
  // Start on the actual story target (face, hands, evidence, or keepsake),
  // while the source artwork supplies the left/right/top viewpoint.  The
  // camera then expands around that subject into the full angled wide shot.
  const focusX = targetFocus.focusX;
  const focusY = targetFocus.focusY;
  const defaultFocusXEnd = family === "left"
    ? .54
    : family === "right"
      ? .46
      : .50;
  const defaultFocusYEnd = family === "top" ? .52 : .48;
  const focusXEnd = semanticRule?.useReplyTarget ? targetFocus.focusXEnd : defaultFocusXEnd;
  const focusYEnd = semanticRule?.useReplyTarget ? targetFocus.focusYEnd : defaultFocusYEnd;
  return {
    ...original,
    focusX,
    focusY,
    focusXEnd,
    focusYEnd,
    zoomStart: Number((1 / (1 - revealFraction)).toFixed(6)),
    zoomEnd: 1,
    motionLeadRatio: 0,
    motionTailRatio: 0,
    easing: "linear",
    saturation: 1,
    contrast: 1,
    brightness: 0,
  };
}

for (const cut of manifest.cuts) {
  if (!Array.isArray(cut.cameraSequence) || cut.cameraSequence.length === 0) {
    throw new Error(`V20 requires the approved V19 camera sequence for ${cut.id}`);
  }
  cut.cameraSequence = cut.cameraSequence.map((shot) => {
    const key = groupKey(cut.id, shot.utteranceIds || []);
    const semanticRule = semanticShotRules.get(key);
    if (!semanticRule) throw new Error(`Missing semantic camera rule for ${key}`);
    const semanticShot = { ...shot, angle: semanticRule.angle };
    return {
      ...semanticShot,
      id: String(shot.id).replace(/-v19-/u, "-v20-strong-"),
      motion: "pull-out",
      camera: strongDirectionalCamera(
        semanticShot,
        approvedTargetFocus.get(key),
        semanticRule,
      ),
      motionIntensity: "strong-reference-upper-band",
      startFraming: "subject-locked semantically selected view",
      viewMode: semanticRule.viewMode,
      editorialPurpose: semanticRule.purpose,
      reason: `${semanticRule.purpose}; starts on the story target and completes only the authored ${semanticRule.viewMode}`,
    };
  });
  cut.imagePath = cut.cameraSequence[0].imagePath;
  cut.motion = "pull-out";
  cut.camera = cut.cameraSequence[0].camera;
  if (cut.thoughtFocus) cut.thoughtFocus = { ...cut.thoughtFocus, enabled: false, opacity: 0, faceBrightness: 0 };
}

const cameraRows = [];
for (const cut of manifest.cuts) {
  const cutUtterances = cut.utteranceIds.map((id) => utteranceById.get(id)).filter(Boolean);
  const normalized = normalizeCameraShotSequence(cut, cutUtterances, cut.timing?.durationSeconds);
  for (const shot of normalized) {
    const source = cut.cameraSequence.find((entry) => entry.id === shot.id);
    const revealFraction = 1 - shot.camera.zoomEnd / shot.camera.zoomStart;
    const directionalTravel = Math.hypot(
      shot.camera.focusXEnd - shot.camera.focusX,
      shot.camera.focusYEnd - shot.camera.focusY,
    );
    cameraRows.push({
      cutId: cut.id,
      shotId: shot.id,
      utteranceIds: shot.utteranceIds,
      angle: source.angle,
      angleFamily: angleFamily(source.angle),
      shotType: source.shotType,
      editorialBeat: source.editorialBeat,
      viewMode: source.viewMode,
      editorialPurpose: source.editorialPurpose,
      durationSeconds: Number(shot.durationSeconds.toFixed(4)),
      motion: source.motion,
      zoomStart: shot.camera.zoomStart,
      zoomEnd: shot.camera.zoomEnd,
      totalFrameRevealPercent: Number((revealFraction * 100).toFixed(2)),
      authoredZoomPercentPerSecond: Number((revealFraction * 100 / shot.durationSeconds).toFixed(4)),
      focusX: shot.camera.focusX,
      focusY: shot.camera.focusY,
      focusXEnd: shot.camera.focusXEnd,
      focusYEnd: shot.camera.focusYEnd,
      startsOnApprovedStoryTarget: true,
      authoredDirectionalTravelPercent: Number((directionalTravel * 100).toFixed(2)),
      authoredTranslationPercentPerSecond: Number((directionalTravel * 100 / shot.durationSeconds).toFixed(4)),
      sameImageBubbleCount: shot.utteranceIds.length,
      simultaneousBubbleRetention: shot.utteranceIds.some((id) => utteranceById.get(id)?.retainBubbleThroughNext === true),
      imagePath: shot.imagePath,
    });
  }
}

const familyCounts = Object.fromEntries(["left", "right", "top", "wide"].map((family) => [
  family,
  cameraRows.filter((row) => row.angleFamily === family).length,
]));
const revealValues = cameraRows.map((row) => row.totalFrameRevealPercent);
const travelValues = cameraRows.map((row) => row.authoredDirectionalTravelPercent);
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const plan = {
  version: "v20-strong-editorial-camera",
  referenceVideoIds: ["awAbZyTeE4g", "2ycRncs4CKY"],
  calibration: {
    referenceP90ZoomPercentPerSecond: 1.7509,
    referenceP90TranslationPercentPerSecond: 1.3825,
    note: "V20 targets the visibly strong reference band and intentionally amplifies total crop reveal after V19 was judged too subtle.",
  },
  shotCount: cameraRows.length,
  pullOutCount: cameraRows.filter((row) => row.motion === "pull-out").length,
  staticCount: cameraRows.filter((row) => row.motion === "static").length,
  pushInCount: cameraRows.filter((row) => row.motion === "push-in").length,
  angleFamilyCounts: familyCounts,
  totalFrameRevealPercent: {
    min: Math.min(...revealValues),
    mean: Number(mean(revealValues).toFixed(2)),
    max: Math.max(...revealValues),
  },
  authoredDirectionalTravelPercent: {
    min: Math.min(...travelValues),
    mean: Number(mean(travelValues).toFixed(2)),
    max: Math.max(...travelValues),
  },
  sameImageMultiUtteranceShotCount: cameraRows.filter((row) => row.sameImageBubbleCount > 1).length,
  accumulatedTwoBubbleShotCount: cameraRows.filter((row) => row.simultaneousBubbleRetention).length,
  cameraRows,
};

if (plan.shotCount !== 20 || plan.pullOutCount !== 20 || plan.staticCount !== 0 || plan.pushInCount !== 0) {
  throw new Error(`V20 camera gate failed: ${JSON.stringify(plan)}`);
}
if (familyCounts.left !== 2 || familyCounts.right !== 11 || familyCounts.top !== 4 || familyCounts.wide !== 3) {
  throw new Error(`V20 angle gate failed: ${JSON.stringify(familyCounts)}`);
}
if (plan.sameImageMultiUtteranceShotCount !== 9 || plan.accumulatedTwoBubbleShotCount !== 6) {
  throw new Error("V20 must preserve the approved same-image/multiple-balloon structure");
}

manifest.video = {
  ...(manifest.video || {}),
  fileName: "manga-photo-homecoming-001-v20-strong-editorial-camera-r1.mp4",
  statusAfterRender: "final-review-candidate-v20-strong-editorial-camera-r1",
  bgmPath: "",
  bgmVolume: 0,
  cameraOversample: 2,
};
manifest.status = "v20-strong-editorial-camera-plan-ready";
manifest.production = {
  ...(manifest.production || {}),
  version: "v20-strong-editorial-camera",
  cameraPolicy: {
    referenceVideoIds: plan.referenceVideoIds,
    referenceBand: "p90 strong motion",
    continuousMotionRequired: true,
    staticAllowed: false,
    pushInAllowed: false,
    pullOutRequired: true,
    totalFrameRevealPercent: plan.totalFrameRevealPercent,
    authoredDirectionalTravelPercent: plan.authoredDirectionalTravelPercent,
    angleFamilyCounts: plan.angleFamilyCounts,
  },
};
manifest.updatedAt = new Date().toISOString();
await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ manifestPath, planPath, ...plan, cameraRows: undefined }, null, 2)}\n`);
