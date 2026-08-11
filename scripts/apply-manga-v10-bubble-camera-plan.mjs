#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { renderSpeechBubbleSvg } from "../lib/speechBubbleRenderer.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const manifestPath = resolve(
  process.argv[3]
    || join(projectDir, "canvas", "manga-videos", "manga-photo-homecoming-001", "episode-manifest.json"),
);
const canvasDir = join(projectDir, "canvas");
const assetPath = (fileName) => join(canvasDir, "assets", fileName);
const rootDir = dirname(manifestPath);

const replacementShots = {
  "cut-07-cut-07-u01+cut-07-u02-top": assetPath("manga-photo-homecoming-001-v10-cut-07-top-bubble-safe-normal.png"),
  "cut-07-cut-07-u03-right": assetPath("manga-photo-homecoming-001-v10-cut-07-right-bubble-safe-normal.png"),
  "cut-08-cut-08-u01-top-wide": assetPath("manga-photo-homecoming-001-v10-cut-08-top-wide-bubble-safe.png"),
  "cut-08-cut-08-u02+cut-08-u03-wide": assetPath("manga-photo-homecoming-001-v10-cut-08-wide-bubble-safe.png"),
  "cut-09-cut-09-u01-right": assetPath("manga-photo-homecoming-001-v10-cut-09-right-bubble-safe-normal.png"),
  "cut-09-cut-09-u02-left": assetPath("manga-photo-homecoming-001-v10-cut-09-left-bubble-safe-normal.png"),
};

// Manual, camera-specific regions are deliberately used instead of face ML.
// The regions are normalized to the 1672x941 art and include a conservative
// margin around every visible face. This makes the evidence deterministic and
// keeps the placement decision auditable when the camera angle changes.
const regionsByImage = {
  "manga-photo-homecoming-001-v7-cut-01-left.png": [
    { id: "ren-face", kind: "face", x: 0.27, y: 0.05, width: 0.23, height: 0.35 },
    { id: "family-photo", kind: "evidence", x: 0.57, y: 0.77, width: 0.24, height: 0.23 },
  ],
  "manga-photo-homecoming-001-v7-cut-01-left-wide.png": [
    { id: "ren-face", kind: "face", x: 0.36, y: 0.07, width: 0.12, height: 0.24 },
    { id: "family-photo", kind: "evidence", x: 0.45, y: 0.27, width: 0.12, height: 0.20 },
  ],
  "manga-photo-homecoming-001-v7-cut-01-wide.png": [
    { id: "ren-face", kind: "face", x: 0.38, y: 0.10, width: 0.20, height: 0.30 },
    { id: "family-photo", kind: "evidence", x: 0.45, y: 0.62, width: 0.31, height: 0.30 },
  ],
  "manga-photo-homecoming-001-v7-cut-02-top-wide.png": [
    { id: "ren-face", kind: "face", x: 0.55, y: 0.27, width: 0.15, height: 0.20 },
    { id: "restoration-work", kind: "evidence", x: 0.42, y: 0.43, width: 0.35, height: 0.31 },
  ],
  "manga-photo-homecoming-001-v7-cut-02-top.png": [
    { id: "ren-face", kind: "face", x: 0.48, y: 0.23, width: 0.18, height: 0.23 },
    { id: "restoration-work", kind: "evidence", x: 0.40, y: 0.43, width: 0.40, height: 0.32 },
  ],
  "manga-photo-homecoming-001-v7-cut-03-right.png": [
    { id: "ren-face", kind: "face", x: 0.16, y: 0.08, width: 0.20, height: 0.28 },
    { id: "mio-face", kind: "face", x: 0.70, y: 0.16, width: 0.16, height: 0.25 },
  ],
  "manga-photo-homecoming-001-v7-cut-03-left.png": [
    { id: "ren-face", kind: "face", x: 0.19, y: 0.07, width: 0.18, height: 0.27 },
    { id: "mio-face", kind: "face", x: 0.72, y: 0.15, width: 0.16, height: 0.25 },
  ],
  "manga-photo-homecoming-001-v7-cut-03-right-wide.png": [
    { id: "ren-face", kind: "face", x: 0.28, y: 0.17, width: 0.12, height: 0.17 },
    { id: "mio-face", kind: "face", x: 0.62, y: 0.19, width: 0.11, height: 0.17 },
  ],
  "manga-photo-homecoming-001-v7-cut-04-right.png": [
    { id: "mio-face", kind: "face", x: 0.24, y: 0.07, width: 0.19, height: 0.34 },
    { id: "ren-face", kind: "face", x: 0.61, y: 0.02, width: 0.23, height: 0.36 },
    { id: "authorship-photo", kind: "evidence", x: 0.42, y: 0.74, width: 0.22, height: 0.18 },
  ],
  "manga-photo-homecoming-001-v7-cut-04-left.png": [
    { id: "mio-face", kind: "face", x: 0.26, y: 0.06, width: 0.19, height: 0.32 },
    { id: "ren-face", kind: "face", x: 0.69, y: 0.01, width: 0.23, height: 0.35 },
  ],
  "manga-photo-homecoming-001-v7-cut-04-top.png": [
    { id: "mio-face", kind: "face", x: 0.25, y: 0.08, width: 0.14, height: 0.27 },
    { id: "ren-face", kind: "face", x: 0.50, y: 0.10, width: 0.16, height: 0.27 },
    { id: "authorship-photo", kind: "evidence", x: 0.36, y: 0.54, width: 0.14, height: 0.13 },
  ],
  "manga-photo-homecoming-001-v7-cut-04-right-wide.png": [
    { id: "mio-face", kind: "face", x: 0.39, y: 0.16, width: 0.11, height: 0.18 },
    { id: "ren-face", kind: "face", x: 0.61, y: 0.14, width: 0.10, height: 0.17 },
    { id: "authorship-photo", kind: "evidence", x: 0.47, y: 0.51, width: 0.18, height: 0.18 },
  ],
  "manga-photo-homecoming-001-v7-cut-05-right.png": [
    { id: "ren-face", kind: "face", x: 0.17, y: 0.11, width: 0.15, height: 0.23 },
    { id: "mio-face", kind: "face", x: 0.36, y: 0.17, width: 0.15, height: 0.25 },
    { id: "reiji-face", kind: "face", x: 0.66, y: 0.01, width: 0.18, height: 0.29 },
  ],
  "manga-photo-homecoming-001-v7-cut-05-left.png": [
    { id: "ren-face", kind: "face", x: 0.17, y: 0.10, width: 0.15, height: 0.23 },
    { id: "mio-face", kind: "face", x: 0.38, y: 0.16, width: 0.15, height: 0.25 },
    { id: "reiji-face", kind: "face", x: 0.67, y: 0.02, width: 0.17, height: 0.28 },
  ],
  "manga-photo-homecoming-001-v7-cut-05-right-wide.png": [
    { id: "ren-face", kind: "face", x: 0.29, y: 0.17, width: 0.10, height: 0.16 },
    { id: "mio-face", kind: "face", x: 0.45, y: 0.22, width: 0.09, height: 0.16 },
    { id: "reiji-face", kind: "face", x: 0.61, y: 0.13, width: 0.10, height: 0.16 },
  ],
  "manga-photo-homecoming-001-v7-cut-06-left.png": [
    { id: "mio-face", kind: "face", x: 0.28, y: 0.07, width: 0.19, height: 0.31 },
    { id: "reiji-face", kind: "face", x: 0.69, y: 0.03, width: 0.18, height: 0.30 },
    { id: "photo-records", kind: "evidence", x: 0.40, y: 0.72, width: 0.43, height: 0.26 },
  ],
  "manga-photo-homecoming-001-v7-cut-06-right.png": [
    { id: "mio-face", kind: "face", x: 0.27, y: 0.06, width: 0.19, height: 0.32 },
    { id: "reiji-face", kind: "face", x: 0.66, y: 0.02, width: 0.19, height: 0.31 },
    { id: "photo-records", kind: "evidence", x: 0.38, y: 0.72, width: 0.45, height: 0.26 },
  ],
  "manga-photo-homecoming-001-v7-cut-06-right-wide.png": [
    { id: "mio-face", kind: "face", x: 0.36, y: 0.14, width: 0.11, height: 0.22 },
    { id: "reiji-face", kind: "face", x: 0.64, y: 0.13, width: 0.11, height: 0.23 },
  ],
  "manga-photo-homecoming-001-v10-cut-07-top-bubble-safe-normal.png": [
    { id: "ren-face", kind: "face", x: 0.18, y: 0.12, width: 0.15, height: 0.24 },
    { id: "reiji-head", kind: "face", x: 0.34, y: 0.23, width: 0.19, height: 0.29 },
    { id: "film-negative", kind: "evidence", x: 0.15, y: 0.53, width: 0.51, height: 0.45 },
  ],
  "manga-photo-homecoming-001-v10-cut-07-right-bubble-safe-normal.png": [
    { id: "reiji-face", kind: "face", x: 0.65, y: 0.03, width: 0.27, height: 0.54 },
    { id: "film-negative", kind: "evidence", x: 0.43, y: 0.80, width: 0.31, height: 0.20 },
  ],
  "manga-photo-homecoming-001-v10-cut-08-top-wide-bubble-safe.png": [
    { id: "mio-face", kind: "face", x: 0.17, y: 0.30, width: 0.12, height: 0.18 },
    { id: "archive-staff-faces", kind: "face", x: 0.31, y: 0.12, width: 0.25, height: 0.42 },
    { id: "proof-workstation", kind: "evidence", x: 0.06, y: 0.35, width: 0.29, height: 0.36 },
  ],
  "manga-photo-homecoming-001-v10-cut-08-wide-bubble-safe.png": [
    { id: "reiji-face", kind: "face", x: 0.79, y: 0.32, width: 0.07, height: 0.11 },
    { id: "archive-staff-faces", kind: "face", x: 0.61, y: 0.35, width: 0.11, height: 0.13 },
  ],
  "manga-photo-homecoming-001-v10-cut-09-right-bubble-safe-normal.png": [
    { id: "young-mio-face", kind: "face", x: 0.17, y: 0.17, width: 0.15, height: 0.25 },
    { id: "young-ren-face", kind: "face", x: 0.39, y: 0.18, width: 0.15, height: 0.25 },
    { id: "camera", kind: "evidence", x: 0.20, y: 0.42, width: 0.12, height: 0.27 },
  ],
  "manga-photo-homecoming-001-v10-cut-09-left-bubble-safe-normal.png": [
    { id: "young-mio-face", kind: "face", x: 0.48, y: 0.18, width: 0.14, height: 0.24 },
    { id: "young-ren-face", kind: "face", x: 0.72, y: 0.10, width: 0.15, height: 0.26 },
    { id: "photo-envelope", kind: "evidence", x: 0.61, y: 0.52, width: 0.17, height: 0.17 },
  ],
  "manga-photo-homecoming-001-v7-cut-09-top-wide.png": [
    { id: "children-faces", kind: "face", x: 0.35, y: 0.42, width: 0.30, height: 0.23 },
    { id: "photo-envelope", kind: "evidence", x: 0.42, y: 0.58, width: 0.18, height: 0.18 },
  ],
  "manga-photo-homecoming-001-v7-cut-10-right.png": [
    { id: "ren-face", kind: "face", x: 0.41, y: 0.06, width: 0.14, height: 0.24 },
    { id: "mio-face", kind: "face", x: 0.56, y: 0.13, width: 0.13, height: 0.23 },
  ],
  "manga-photo-homecoming-001-v7-cut-10-left.png": [
    { id: "ren-face", kind: "face", x: 0.43, y: 0.05, width: 0.14, height: 0.24 },
    { id: "mio-face", kind: "face", x: 0.60, y: 0.12, width: 0.13, height: 0.23 },
  ],
  "manga-photo-homecoming-001-v7-cut-10-wide.png": [
    { id: "ren-face", kind: "face", x: 0.49, y: 0.24, width: 0.09, height: 0.14 },
    { id: "mio-face", kind: "face", x: 0.61, y: 0.27, width: 0.08, height: 0.14 },
  ],
};

const layoutByUtterance = {
  "cut-01-u01": { lane: "right" },
  "cut-01-u02": { lane: "right" },
  "cut-01-u03": {
    lane: "right",
    columns: ["雨、強くなったな。", "閉店前に、", "この現像だけ終わらせよう"],
  },
  "cut-02-u01": { lane: "left" },
  "cut-02-u02": { lane: "left" },
  "cut-03-u01": { lane: "center" },
  "cut-03-u02": { lane: "center" },
  "cut-03-u03": { lane: "left" },
  "cut-04-u01": { lane: "right" },
  "cut-04-u02": { lane: "left" },
  "cut-04-u03": { lane: "left" },
  "cut-05-u01": { lane: "right" },
  "cut-05-u02": { lane: "lower-left" },
  "cut-05-u03": { lane: "right" },
  "cut-06-u01": { lane: "left" },
  "cut-06-u02": { lane: "left" },
  "cut-07-u01": { lane: "right" },
  "cut-07-u02": { lane: "right" },
  "cut-07-u03": { lane: "left" },
  "cut-08-u01": { lane: "right" },
  "cut-08-u02": { lane: "left" },
  "cut-08-u03": { lane: "left" },
  "cut-09-u01": { lane: "right" },
  "cut-09-u02": { lane: "left" },
  "cut-09-u03": { lane: "right" },
  "cut-10-u01": { lane: "left" },
  "cut-10-u02": { lane: "left" },
  "cut-10-u03": { lane: "left" },
  "cut-10-u04": { lane: "left" },
};

const speakerFaceIdByUtterance = {
  "cut-01-u03": "ren-face",
  "cut-02-u02": "ren-face",
  "cut-03-u01": "mio-face",
  "cut-03-u02": "ren-face",
  "cut-03-u03": "mio-face",
  "cut-04-u01": "mio-face",
  "cut-04-u02": "ren-face",
  "cut-04-u03": "mio-face",
  "cut-05-u01": "reiji-face",
  "cut-05-u02": "ren-face",
  "cut-05-u03": "reiji-face",
  "cut-06-u01": "mio-face",
  "cut-06-u02": "reiji-face",
  "cut-07-u01": "ren-face",
  "cut-07-u02": "ren-face",
  "cut-07-u03": "reiji-face",
  "cut-08-u01": "mio-face",
  "cut-09-u01": "young-mio-face",
  "cut-09-u02": "young-ren-face",
  "cut-10-u01": "mio-face",
  "cut-10-u02": "mio-face",
  "cut-10-u03": "ren-face",
};

function denormalize(region, width, height) {
  return {
    x: region.x * width,
    y: region.y * height,
    width: region.width * width,
    height: region.height * height,
  };
}

function inferredSpeakerPosition(faceRegion) {
  if (!faceRegion) return "center";
  return faceRegion.x + faceRegion.width / 2 < 0.5 ? "left" : "right";
}

function normalizeForVerticalDisplay(value) {
  return String(value ?? "")
    .replace(/\r?\n/gu, "")
    .replace(/\s+/gu, "")
    .replace(/\.{2,}|…+|⋯+|・{3,}/gu, "︙")
    .replace(/[0-9]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) + 0xfee0))
    .replace(/!/g, "！")
    .replace(/\?/g, "？");
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

for (const cut of manifest.cuts || []) {
  if (cut.thoughtFocus && typeof cut.thoughtFocus === "object") {
    cut.thoughtFocus = {
      ...cut.thoughtFocus,
      enabled: false,
      opacity: 0,
      faceBrightness: 0,
      disabledReason: "User requested the original frame brightness with no artificial darkening.",
    };
  }
  for (const shot of cut.cameraSequence || []) {
    const replacement = replacementShots[shot.id];
    if (!replacement) continue;
    shot.imagePath = replacement;
    shot.imageGeneration = {
      status: "approved-v10-bubble-safe",
      route: "gpt-image-2-codex-edit",
      purpose: "single continuous camera view with a protected dialogue lane",
      adoptedAt: new Date().toISOString(),
    };
    const inventory = (cut.cameraAssetInventory || []).find((entry) => entry.selectedShotId === shot.id);
    if (inventory) inventory.imagePath = replacement;
  }
}

const cutsById = new Map((manifest.cuts || []).map((cut) => [cut.id, cut]));
const layoutAudit = [];
const punctuationAudit = [];

for (const utterance of manifest.utterances || []) {
  const cut = cutsById.get(utterance.cutId);
  const shot = (cut?.cameraSequence || []).find((entry) => entry.utteranceIds?.includes(utterance.id));
  if (!shot) throw new Error(`No selected camera shot for ${utterance.id}.`);
  const imagePath = shot.imagePath;
  const imageName = basename(imagePath);
  const annotatedRegions = regionsByImage[imageName];
  if (!annotatedRegions?.some((region) => region.kind === "face")) {
    throw new Error(`No manual face annotation for ${utterance.id} on ${imageName}.`);
  }
  const layout = layoutByUtterance[utterance.id];
  if (!layout) throw new Error(`No V10 layout decision for ${utterance.id}.`);

  const speakerFaceId = speakerFaceIdByUtterance[utterance.id];
  // Reference-video rule: the active speaker's eyes and mouth are the hard
  // exclusion. A listener may sit under a balloon when the composition needs
  // it, but still receives a light preference so clean background wins first.
  const avoidRegions = annotatedRegions.map((region) => (
    region.kind === "face"
      && speakerFaceId
      && region.id !== speakerFaceId
      ? { ...region, kind: "listener", weight: 35 }
      : region
  ));

  const spec = JSON.parse(await readFile(utterance.overlaySpecPath, "utf8"));
  const speakerFace = annotatedRegions.find((region) => region.id === speakerFaceId);
  const { bounds: _oldBounds, columns: _oldColumns, placementSide: _oldPlacementSide, ...oldBubble } = spec.bubble || {};
  let bubble = {
    ...oldBubble,
    id: utterance.bubbleId || oldBubble.id || `bubble-${utterance.id}`,
    order: utterance.order,
    text: utterance.text,
    preset: utterance.preset,
    utteranceId: utterance.id,
    tail: false,
    ...(layout.lane === "left" || layout.lane === "right" ? { placementSide: layout.lane } : {}),
    ...(layout.columns ? { columns: layout.columns } : {}),
    speakerHint: {
      ...(oldBubble.speakerHint || {}),
      position: inferredSpeakerPosition(speakerFace),
      faceBand: "upper",
      ...(speakerFace ? { faceBounds: speakerFace } : {}),
    },
  };

  const render = (candidateBubble) => renderSpeechBubbleSvg({
    width: spec.imageSize?.width || manifest.video?.width || 1672,
    height: spec.imageSize?.height || manifest.video?.height || 941,
    bubbles: [candidateBubble],
    avoidRegions,
    profileId: spec.profile?.id,
    title: `${manifest.title} ${utterance.id} V10`,
  });

  let rendered = render(bubble);
  if (layout.lane === "center" || layout.lane === "lower-left") {
    const frameWidth = rendered.plan.width;
    const frameHeight = rendered.plan.height;
    const natural = rendered.plan.bubbles[0].bounds;
    bubble = {
      ...bubble,
      bounds: {
        x: layout.lane === "center" ? (frameWidth - natural.width) / 2 : frameWidth * 0.045,
        y: layout.lane === "center" ? frameHeight * 0.055 : frameHeight - frameHeight * 0.055 - natural.height,
        width: natural.width,
        height: natural.height,
      },
    };
    rendered = render(bubble);
  }

  const quality = rendered.quality[0];
  if (
    quality.overflow
    || quality.textLoss
    || quality.tooSmall
    || quality.faceOverlapRatio > 0
    || quality.importantOverlapRatio > 0
  ) {
    throw new Error(`V10 bubble gate failed for ${utterance.id}: ${JSON.stringify({ quality, bounds: rendered.plan.bubbles[0].bounds, avoidRegions: rendered.plan.avoidRegions })}`);
  }
  const renderedText = quality.columnTexts.join("");
  const sourceText = utterance.text.replace(/\r?\n/gu, "");
  const visuallyComparableSourceText = normalizeForVerticalDisplay(sourceText);
  if (renderedText !== visuallyComparableSourceText) {
    throw new Error(`Dialogue text changed during V10 layout for ${utterance.id}: ${JSON.stringify({ sourceText, visuallyComparableSourceText, renderedText, columns: quality.columnTexts })}`);
  }

  await writeFile(utterance.overlayPath, rendered.svg, "utf8");
  await writeFile(utterance.overlaySpecPath, `${JSON.stringify({
    ...spec,
    version: "v10-reference-safe",
    imagePath,
    imageSize: { width: rendered.plan.width, height: rendered.plan.height },
    cameraShotId: shot.id,
    cameraAngle: shot.angle,
    avoidRegions,
    bubble,
    plan: rendered.plan,
    quality: rendered.quality,
    profile: rendered.profile,
    placementOverride: {
      lane: layout.lane,
      bounds: rendered.plan.bubbles[0].bounds,
      columns: quality.columnTexts,
    },
    punctuationPolicy: "source-exact-reference-video-v1",
    refreshedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  delete utterance.rasterizedOverlayPath;

  layoutAudit.push({
    utteranceId: utterance.id,
    cameraShotId: shot.id,
    cameraAngle: shot.angle,
    imagePath,
    lane: layout.lane,
    bounds: rendered.plan.bubbles[0].bounds,
    speakerFaceRegionCount: avoidRegions.filter((region) => region.kind === "face").length,
    listenerRegionCount: avoidRegions.filter((region) => region.kind === "listener").length,
    importantRegionCount: avoidRegions.filter((region) => region.kind !== "face").length,
    quality,
  });
  punctuationAudit.push({
    utteranceId: utterance.id,
    preset: utterance.preset,
    sourceText,
    renderedText,
    sourceExactAfterVisualWhitespaceNormalization: renderedText === visuallyComparableSourceText,
    terminalMark: sourceText.match(/[。！？…]+$/u)?.[0] || "",
    finalFullStopPreserved: sourceText.endsWith("。") === renderedText.endsWith("。"),
    columns: quality.columnTexts,
  });
}

manifest.status = "v10-bubble-camera-plan-ready";
manifest.production = {
  ...(manifest.production || {}),
  version: "v10-reference-safe",
  referenceVideos: [
    "https://www.youtube.com/watch?v=awAbZyTeE4g",
    "https://www.youtube.com/watch?v=2ycRncs4CKY",
  ],
  bubblePolicy: {
    priority: ["active speaker face", "story evidence", "hands", "natural background lane", "actor gap", "non-speaking listener"],
    activeSpeakerFaceOverlapAllowed: false,
    listenerOverlapAllowedWhenNeeded: true,
    cameraSpecificAnnotations: true,
    manualRegionsInsteadOfFaceMl: true,
    artificialBackgroundDarkening: false,
  },
  dialogueEditorialPolicy: {
    punctuation: "Preserve authored punctuation exactly; completed narration retains 。, questions/exclamations/ellipses retain their authored marks, and casual open endings do not receive a synthetic 。.",
    lineBreaks: "Break vertical columns at semantic phrase boundaries; never strand a Japanese demonstrative away from its noun.",
  },
  cameraPolicy: {
    angles: ["left", "right", "top", "wide", "left-wide", "right-wide", "top-wide"],
    singleContinuousFrameRequired: true,
    wideMeansSpatiallyWiderShotNotDigitalCrop: true,
  },
  ossStack: [
    { name: "FFmpeg", role: "camera motion, compositing, audio mastering and final H.264/AAC render" },
    { name: "OpenCV", role: "panel-separator, edge-density and pixel-statistics camera QA" },
    { name: "NumPy", role: "reference distribution and percentile measurement" },
    { name: "Chromium/rsvg/ImageMagick", role: "deterministic SVG speech-balloon rasterization fallback chain" },
  ],
};
if (manifest.outputs?.reviewVideo) delete manifest.outputs.reviewVideo;
manifest.updatedAt = new Date().toISOString();

await writeFile(join(rootDir, "v10-bubble-layout-audit.json"), `${JSON.stringify({
  version: "v10-reference-safe",
  overlayCount: layoutAudit.length,
  zeroFaceOverlapCount: layoutAudit.filter((row) => row.quality.faceOverlapRatio === 0).length,
  zeroImportantOverlapCount: layoutAudit.filter((row) => row.quality.importantOverlapRatio === 0).length,
  rows: layoutAudit,
}, null, 2)}\n`, "utf8");
await writeFile(join(rootDir, "v10-dialogue-editorial-audit.json"), `${JSON.stringify({
  version: "source-exact-reference-video-v1",
  utteranceCount: punctuationAudit.length,
  sourceExactCount: punctuationAudit.filter((row) => row.sourceExactAfterVisualWhitespaceNormalization).length,
  finalFullStopPreservedCount: punctuationAudit.filter((row) => row.finalFullStopPreserved).length,
  rows: punctuationAudit,
}, null, 2)}\n`, "utf8");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

process.stdout.write(`${JSON.stringify({
  manifestPath,
  status: manifest.status,
  replacementShotCount: Object.keys(replacementShots).length,
  overlayCount: layoutAudit.length,
  zeroFaceOverlapCount: layoutAudit.filter((row) => row.quality.faceOverlapRatio === 0).length,
  zeroImportantOverlapCount: layoutAudit.filter((row) => row.quality.importantOverlapRatio === 0).length,
  sourceExactDialogueCount: punctuationAudit.filter((row) => row.sourceExactAfterVisualWhitespaceNormalization).length,
}, null, 2)}\n`);
