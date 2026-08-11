#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { normalizeCameraShotSequence } from "../lib/mangaVideoPipeline.mjs";
import { renderSpeechBubbleSvg } from "../lib/speechBubbleRenderer.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const manifestPath = resolve(process.argv[3] || join(
  projectDir,
  "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json",
));
const episodeDir = dirname(manifestPath);
const asset = (name) => join(projectDir, "canvas/assets", name);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const utteranceById = new Map(manifest.utterances.map((utterance) => [utterance.id, utterance]));

const A = {
  renWide: asset("manga-photo-homecoming-001-v16-cut-01-wide-ren.png"),
  renClose: asset("manga-photo-homecoming-001-v16-proof-closeup-ren-r2.png"),
  renTop: asset("manga-photo-homecoming-001-v16-cut-02-top-ren-evidence.png"),
  mioEntry: asset("manga-photo-homecoming-001-v16-proof-medium-ren-mio-r2.png"),
  mioConfession: asset("manga-photo-homecoming-001-v16-cut-03-medium-mio-confession.png"),
  theft: asset("manga-photo-homecoming-001-v16-cut-04-medium-mio-photo-theft.png"),
  evidenceTop: asset("manga-photo-homecoming-001-v16-cut-04-top-evidence.png"),
  mioClose: asset("manga-photo-homecoming-001-v16-cut-04-close-mio-vulnerable.png"),
  confrontation: asset("manga-photo-homecoming-001-v16-cut-05-wide-confrontation.png"),
  reijiClose: asset("manga-photo-homecoming-001-v16-cut-05-close-reiji.png"),
  pressureWide: asset("manga-photo-homecoming-001-v16-cut-06-wide-reiji-pressure.png"),
  proofTop: asset("manga-photo-homecoming-001-v16-cut-07-top-evidence-proof.png"),
  reijiShock: asset("manga-photo-homecoming-001-v16-cut-07-close-reiji-shock.png"),
  mioSend: asset("manga-photo-homecoming-001-v16-cut-08-medium-mio-send.png"),
  consequence: asset("manga-photo-homecoming-001-v16-cut-08-wide-consequence.png"),
  childMio: asset("manga-photo-homecoming-001-v14-cut-09-right-r2.png"),
  childRen: asset("manga-photo-homecoming-001-v14-cut-09-left-r2.png"),
  childTop: asset("manga-photo-homecoming-001-v14-cut-09-top-wide-r2.png"),
  studio: asset("manga-photo-homecoming-001-v16-cut-10-medium-mio-studio.png"),
  mioLove: asset("manga-photo-homecoming-001-v16-cut-10-close-mio-confession.png"),
  closing: asset("manga-photo-homecoming-001-v16-cut-10-wide-closing.png"),
};

function shot(id, utteranceIds, imagePath, angle, shotType, focusX, focusY, focusXEnd, focusYEnd, strength, beat) {
  return {
    id,
    utteranceIds,
    imagePath,
    angle,
    viewpoint: angle.replace(/-wide$/u, ""),
    endView: angle.endsWith("-wide") || angle === "wide" ? angle : `${angle}-wide`,
    shotType,
    transition: "cut",
    motion: "pull-out",
    camera: {
      focusX,
      focusY,
      focusXEnd,
      focusYEnd,
      zoomStart: 1.05,
      zoomEnd: 1,
      motionLeadRatio: 0,
      motionTailRatio: 0,
      easing: "smoothstep",
      saturation: 1,
      contrast: 1,
      brightness: 0,
    },
    motionStrength: strength,
    editorialBeat: beat,
    isSpatialWideShot: shotType === "wide",
    wideShotSource: shotType === "wide" ? "dedicated-camera-asset" : null,
    reason: `${angle} viewpoint chosen for ${beat}; continuous pan-to-pull-out keeps that angle while revealing context`,
  };
}

// One visual beat can carry more than one line.  Cuts occur when the speaker,
// evidence, emotional focus, or time/place changes—not for every utterance.
const sequenceByCut = {
  "cut-01": [
    shot("cut-01-v19-left-establish", ["cut-01-u01", "cut-01-u02"], A.renWide, "left-wide", "wide", .22, .46, .37, .45, "reveal", "rainy photo-lab geography and opening narration"),
    shot("cut-01-v19-left-ren", ["cut-01-u03"], A.renClose, "left", "close-up", .34, .40, .40, .41, "subtle", "Ren's quiet work rhythm"),
  ],
  "cut-02": [
    shot("cut-02-v19-top-restoration", ["cut-02-u01", "cut-02-u02"], A.renTop, "top", "medium", .36, .45, .50, .49, "top", "hands, family photo, and restoration evidence"),
  ],
  "cut-03": [
    shot("cut-03-v19-right-reunion", ["cut-03-u01", "cut-03-u02"], A.mioEntry, "right", "medium", .65, .40, .48, .41, "dialogue", "Mio speaks first and the frame glides toward Ren's reaction"),
    shot("cut-03-v19-left-confession", ["cut-03-u03"], A.mioConfession, "left", "close-up", .69, .42, .62, .43, "subtle", "Mio admits she no longer knows where home is"),
  ],
  "cut-04": [
    shot("cut-04-v19-left-theft", ["cut-04-u01", "cut-04-u02"], A.theft, "left", "medium", .70, .42, .52, .43, "dialogue", "Mio explains the theft and the frame transfers toward Ren's evidence question"),
    shot("cut-04-v19-right-vulnerability", ["cut-04-u03"], A.mioClose, "right", "close-up", .55, .39, .61, .40, "subtle", "Mio's trust and vulnerability"),
  ],
  "cut-05": [
    shot("cut-05-v19-right-confrontation", ["cut-05-u01", "cut-05-u02"], A.confrontation, "right-wide", "wide", .69, .47, .51, .49, "dialogue", "Reiji enters from the right and Ren challenges him across the room"),
    shot("cut-05-v19-left-reiji", ["cut-05-u03"], A.reijiClose, "left", "close-up", .34, .40, .40, .41, "dramatic", "Reiji exposes his entitlement"),
  ],
  "cut-06": [
    shot("cut-06-v19-right-pressure", ["cut-06-u01", "cut-06-u02"], A.pressureWide, "right-wide", "wide", .49, .48, .66, .46, "dialogue", "Mio refuses and the frame transfers pressure toward Reiji"),
  ],
  "cut-07": [
    shot("cut-07-v19-top-proof", ["cut-07-u01", "cut-07-u02"], A.proofTop, "top", "medium", .54, .54, .43, .47, "top", "negative, timestamp, and request slip are revealed as proof"),
    shot("cut-07-v19-right-shock", ["cut-07-u03"], A.reijiShock, "right", "close-up", .67, .40, .61, .41, "dramatic", "Reiji loses control of the argument"),
  ],
  "cut-08": [
    shot("cut-08-v19-top-send", ["cut-08-u01"], A.mioSend, "top", "medium", .39, .44, .48, .48, "top", "Mio sends the evidence from the phone"),
    shot("cut-08-v19-top-consequence", ["cut-08-u02", "cut-08-u03"], A.consequence, "top-wide", "wide", .59, .47, .49, .50, "reveal", "the consequence widens beyond the room"),
  ],
  "cut-09": [
    shot("cut-09-v19-right-young-mio", ["cut-09-u01"], A.childMio, "right", "medium", .63, .42, .56, .43, "subtle", "young Mio makes the promise"),
    shot("cut-09-v19-left-young-ren", ["cut-09-u02"], A.childRen, "left", "medium", .34, .42, .42, .43, "subtle", "young Ren answers in reverse angle"),
    shot("cut-09-v19-top-memory", ["cut-09-u03"], A.childTop, "top-wide", "wide", .50, .48, .56, .51, "reveal", "the childhood promise becomes a path seen from above"),
  ],
  "cut-10": [
    shot("cut-10-v19-right-studio", ["cut-10-u01"], A.studio, "right", "medium", .67, .42, .56, .43, "dialogue", "Mio proposes the shared studio"),
    shot("cut-10-v19-left-love", ["cut-10-u02"], A.mioLove, "left", "close-up", .63, .40, .57, .41, "subtle", "Mio's personal confession"),
    shot("cut-10-v19-wide-home", ["cut-10-u03", "cut-10-u04"], A.closing, "wide", "wide", .34, .49, .52, .50, "reveal", "Ren's answer opens into their shared future"),
  ],
};

const strengthRate = { subtle: .42, dialogue: .76, dramatic: .62, top: .88, reveal: .92 };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
for (const cut of manifest.cuts) {
  cut.cameraSequence = sequenceByCut[cut.id];
  if (!cut.cameraSequence) throw new Error(`Missing V19 camera sequence for ${cut.id}`);
  const cutUtterances = cut.utteranceIds.map((id) => utteranceById.get(id)).filter(Boolean);
  const normalized = normalizeCameraShotSequence(cut, cutUtterances, cut.timing?.durationSeconds);
  const durationById = new Map(normalized.map((entry) => [entry.id, entry.durationSeconds]));
  for (const entry of cut.cameraSequence) {
    const duration = durationById.get(entry.id) || 4;
    const rate = strengthRate[entry.motionStrength] || .7;
    const fraction = clamp(rate * duration / 100, .012, .095);
    entry.camera.zoomStart = Number((1 / (1 - fraction)).toFixed(6));
    entry.camera.zoomEnd = 1;
  }
  cut.imagePath = cut.cameraSequence[0].imagePath;
  cut.motion = cut.cameraSequence[0].motion;
  cut.camera = cut.cameraSequence[0].camera;
  if (cut.thoughtFocus) cut.thoughtFocus = { ...cut.thoughtFocus, enabled: false, opacity: 0, faceBrightness: 0 };
}

const normalizedText = (value) => String(value ?? "")
  .replace(/\r?\n/gu, "")
  .replace(/\s+/gu, "")
  .replace(/\.{2,}|…+|⋯+|・{3,}/gu, "︙")
  .replace(/!/gu, "！")
  .replace(/\?/gu, "？");

// Read the approved V16 annotations before replacing any overlay specs.
const oldSpecByUtterance = new Map();
const imagePlanByName = new Map();
for (const utterance of manifest.utterances) {
  const spec = JSON.parse(await readFile(utterance.overlaySpecPath, "utf8"));
  oldSpecByUtterance.set(utterance.id, spec);
  const normalizedRegions = (spec.avoidRegions || spec.plan?.avoidRegions || []).map((region) => ({
    ...region,
    kind: /face$/u.test(region.id || "") || (region.id || "").includes("face") ? "face" : region.kind,
    weight: /face/u.test(region.id || "") ? 1200 : region.weight,
  }));
  if (spec.imagePath) imagePlanByName.set(basename(spec.imagePath), {
    width: spec.imageSize?.width || spec.plan?.width || 1672,
    height: spec.imageSize?.height || spec.plan?.height || 941,
    avoidRegions: normalizedRegions,
  });
}

const speakerFace = {
  "cut-01-u03": "ren-face", "cut-02-u02": "ren-face", "cut-03-u01": "mio-face",
  "cut-03-u02": "ren-face", "cut-03-u03": "mio-face", "cut-04-u01": "mio-face",
  "cut-04-u02": "ren-face", "cut-04-u03": "mio-face", "cut-05-u01": "reiji-face",
  "cut-05-u02": "ren-face", "cut-05-u03": "reiji-face", "cut-06-u01": "mio-face",
  "cut-06-u02": "reiji-face", "cut-07-u01": "ren-face", "cut-07-u02": "ren-face",
  "cut-07-u03": "reiji-face", "cut-08-u01": "mio-face", "cut-09-u01": "young-mio-face",
  "cut-09-u02": "young-ren-face", "cut-10-u01": "mio-face", "cut-10-u02": "mio-face",
  "cut-10-u03": "ren-face",
};
const placementOverrides = {
  "cut-01-u01": "right", "cut-01-u02": "right",
  "cut-02-u01": "right", "cut-02-u02": "right",
  "cut-03-u01": "left", "cut-03-u02": "right",
  "cut-04-u01": "left", "cut-04-u02": "right",
  "cut-05-u01": "left", "cut-05-u02": "right",
  "cut-06-u01": "right", "cut-06-u02": "left",
  "cut-07-u01": "right", "cut-07-u02": "right",
  "cut-08-u02": "left", "cut-08-u03": "right",
  "cut-10-u03": "right", "cut-10-u04": "left",
};
const accumulateShotIds = new Set([
  "cut-03-v19-right-reunion",
  "cut-04-v19-left-theft",
  "cut-05-v19-right-confrontation",
  "cut-06-v19-right-pressure",
  "cut-08-v19-top-consequence",
  "cut-10-v19-wide-home",
]);

// Reset the authored hold flag so rerunning this editor remains idempotent.
for (const utterance of manifest.utterances) {
  delete utterance.retainBubbleThroughNext;
  delete utterance.bubbleRetentionPolicy;
}

const overlayAudit = [];
for (const cut of manifest.cuts) {
  for (const cameraShot of cut.cameraSequence) {
    const imagePlan = imagePlanByName.get(basename(cameraShot.imagePath));
    if (!imagePlan) throw new Error(`No approved annotation plan for ${cameraShot.imagePath}`);
    const groupUtterances = cameraShot.utteranceIds.map((id) => utteranceById.get(id));
    const bubbles = groupUtterances.map((utterance) => {
      const oldSpec = oldSpecByUtterance.get(utterance.id);
      const oldBubble = oldSpec.bubble || oldSpec.plan?.bubbles?.[0] || {};
      const activeFace = imagePlan.avoidRegions.find((region) => region.id === speakerFace[utterance.id]);
      return {
        ...oldBubble,
        bounds: undefined,
        id: utterance.bubbleId || `bubble-${utterance.id}`,
        utteranceId: utterance.id,
        order: utterance.order,
        text: utterance.text,
        preset: utterance.preset,
        tail: false,
        placementSide: placementOverrides[utterance.id] || oldBubble.placementSide || "auto",
        // Treat earlier authored line breaks as soft input.  The locked-v3
        // profile reflows natural Japanese phrases into at most three balanced
        // vertical columns, matching the reference videos.
        columns: undefined,
        maxColumns: 3,
        speakerHint: {
          ...(oldBubble.speakerHint || {}),
          position: activeFace ? (activeFace.x + activeFace.width / 2 < .5 ? "left" : "right") : "center",
          faceBand: "upper",
          ...(activeFace ? { faceBounds: activeFace } : {}),
        },
      };
    });
    const plannedById = new Map();
    if (accumulateShotIds.has(cameraShot.id)) {
      const plannedGroup = renderSpeechBubbleSvg({
        width: imagePlan.width,
        height: imagePlan.height,
        bubbles,
        avoidRegions: imagePlan.avoidRegions,
        profileId: "reference-video-locked-v3",
        title: `${manifest.title} ${cameraShot.id} V19 retained-pair plan`,
      });
      for (const plannedBubble of plannedGroup.plan.bubbles) {
        plannedById.set(plannedBubble.utteranceId, plannedBubble);
      }
    } else {
      // The reference videos often keep one illustration across several lines
      // while replacing the balloon.  Plan those sequential balloons one at a
      // time so a non-simultaneous balloon never steals space from evidence.
      for (const bubble of bubbles) {
        const plannedSingle = renderSpeechBubbleSvg({
          width: imagePlan.width,
          height: imagePlan.height,
          bubbles: [bubble],
          avoidRegions: imagePlan.avoidRegions,
          profileId: "reference-video-locked-v3",
          title: `${manifest.title} ${cameraShot.id} ${bubble.utteranceId} V19 sequential plan`,
        });
        plannedById.set(bubble.utteranceId, plannedSingle.plan.bubbles[0]);
      }
    }
    for (const utterance of groupUtterances) {
      const plannedBubble = plannedById.get(utterance.id);
      if (!plannedBubble) throw new Error(`Missing planned V19 bubble for ${utterance.id}`);
      const rendered = renderSpeechBubbleSvg({
        width: imagePlan.width,
        height: imagePlan.height,
        bubbles: [plannedBubble],
        avoidRegions: imagePlan.avoidRegions,
        profileId: "reference-video-locked-v3",
        title: `${manifest.title} ${utterance.id} V19`,
      });
      const quality = rendered.quality[0];
      if (quality.overflow || quality.textLoss || quality.tooSmall || quality.faceOverlapRatio > .005 || quality.importantOverlapRatio > .10) {
        throw new Error(`V19 bubble gate failed for ${utterance.id}: ${JSON.stringify(quality)}`);
      }
      if (quality.columnTexts.join("") !== normalizedText(utterance.text)) {
        throw new Error(`V19 semantic columns changed text for ${utterance.id}`);
      }
      const oldSpec = oldSpecByUtterance.get(utterance.id);
      await writeFile(utterance.overlayPath, rendered.svg, "utf8");
      await writeFile(utterance.overlaySpecPath, `${JSON.stringify({
        ...oldSpec,
        version: "v19-reference-video-locked-v3",
        imagePath: cameraShot.imagePath,
        imageSize: { width: imagePlan.width, height: imagePlan.height },
        cameraShotId: cameraShot.id,
        cameraAngle: cameraShot.angle,
        avoidRegions: imagePlan.avoidRegions,
        bubble: plannedBubble,
        plan: rendered.plan,
        quality: rendered.quality,
        profile: rendered.profile,
        profileId: "reference-video-locked-v3",
        multiBubbleImage: groupUtterances.length > 1,
        groupUtteranceIds: cameraShot.utteranceIds,
        accumulationEnabled: accumulateShotIds.has(cameraShot.id),
        punctuationPolicy: "dialogue-terminal-full-stop-omitted; narration-terminal-full-stop-kept; question-exclamation-ellipsis-preserved",
        lineBreakPolicy: "reference-video-locked-v3; semantic phrases in one to three vertical columns",
        transitionPolicy: "same-image bubble update; 100ms overlap; selected two-bubble groups retain the previous balloon",
        refreshedAt: new Date().toISOString(),
      }, null, 2)}\n`, "utf8");
      delete utterance.rasterizedOverlayPath;
      overlayAudit.push({
        utteranceId: utterance.id,
        shotId: cameraShot.id,
        imagePath: cameraShot.imagePath,
        angle: cameraShot.angle,
        groupSize: groupUtterances.length,
        accumulationEnabled: accumulateShotIds.has(cameraShot.id),
        activeSpeakerFaceId: speakerFace[utterance.id] || null,
        quality,
      });
    }
  }

  const cutUtterances = cut.utteranceIds.map((id) => utteranceById.get(id)).filter(Boolean);
  const normalizedShots = normalizeCameraShotSequence(cut, cutUtterances, cut.timing?.durationSeconds);
  for (const normalizedShot of normalizedShots) {
    if (!accumulateShotIds.has(normalizedShot.id) || normalizedShot.utteranceIds.length < 2) continue;
    const first = utteranceById.get(normalizedShot.utteranceIds[0]);
    first.retainBubbleThroughNext = true;
    first.bubbleRetentionPolicy = "through-next-utterance";
  }
}

const cameraRows = [];
for (const cut of manifest.cuts) {
  const cutUtterances = cut.utteranceIds.map((id) => utteranceById.get(id)).filter(Boolean);
  for (const normalizedShot of normalizeCameraShotSequence(cut, cutUtterances, cut.timing?.durationSeconds)) {
    const source = cut.cameraSequence.find((entry) => entry.id === normalizedShot.id);
    const zoomRate = ((normalizedShot.camera.zoomStart - normalizedShot.camera.zoomEnd) / normalizedShot.camera.zoomStart) * 100 / normalizedShot.durationSeconds;
    const translationRate = Math.hypot(
      normalizedShot.camera.focusXEnd - normalizedShot.camera.focusX,
      normalizedShot.camera.focusYEnd - normalizedShot.camera.focusY,
    ) * 100 / normalizedShot.durationSeconds;
    cameraRows.push({
      cutId: cut.id,
      shotId: normalizedShot.id,
      utteranceIds: normalizedShot.utteranceIds,
      sameImageBubbleCount: normalizedShot.utteranceIds.length,
      simultaneousBubbleRetention: accumulateShotIds.has(normalizedShot.id),
      angle: source.angle,
      viewpoint: source.viewpoint,
      endView: source.endView,
      editorialBeat: source.editorialBeat,
      shotType: source.shotType,
      durationSeconds: Number(normalizedShot.durationSeconds.toFixed(4)),
      motion: source.motion,
      zoomStart: normalizedShot.camera.zoomStart,
      zoomEnd: normalizedShot.camera.zoomEnd,
      focusX: normalizedShot.camera.focusX,
      focusY: normalizedShot.camera.focusY,
      focusXEnd: normalizedShot.camera.focusXEnd,
      focusYEnd: normalizedShot.camera.focusYEnd,
      authoredZoomPercentPerSecond: Number(zoomRate.toFixed(4)),
      authoredTranslationPercentPerSecond: Number(translationRate.toFixed(4)),
      imagePath: normalizedShot.imagePath,
    });
  }
}

manifest.video = {
  ...(manifest.video || {}),
  fileName: "manga-photo-homecoming-001-v19-editorial-camera-multibubble-r1.mp4",
  statusAfterRender: "final-review-candidate-v19-editorial-camera-multibubble-r1",
  bgmPath: "",
  bgmVolume: 0,
  bubbleTransitionGapSeconds: 0,
  bubbleTransitionCrossfadeSeconds: .1,
  bubbleFadeInMilliseconds: 90,
  bubbleFadeOutMilliseconds: 90,
};
manifest.status = "v19-editorial-camera-multibubble-plan-ready";
manifest.production = {
  ...(manifest.production || {}),
  version: "v19-editorial-camera-multibubble",
  bubblePolicy: {
    ...(manifest.production?.bubblePolicy || {}),
    profileId: "reference-video-locked-v3",
    sameImageMultiUtteranceShotCount: cameraRows.filter((row) => row.sameImageBubbleCount > 1).length,
    accumulatedTwoBubbleShotCount: cameraRows.filter((row) => row.simultaneousBubbleRetention).length,
    activeSpeakerFaceOverlapAllowed: false,
    artificialBackgroundDarkening: false,
    transition: "same-image sequential update with selected two-bubble retention",
  },
  cameraPolicy: {
    version: "v19-script-semantic-left-right-top",
    hardStaticShotCount: 0,
    shotCount: cameraRows.length,
    semanticAngles: ["left", "right", "top"],
    angleFamiliesRequired: { left: true, right: true, top: true },
    pullOutPreservesViewpoint: true,
    subjectDrivenFocusTransfer: true,
    cutOnEditorialBeatNotEveryUtterance: true,
    referenceSceneHoldSeconds: {
      detector: "PySceneDetect AdaptiveDetector 0.6.7.1",
      awAbZyTeE4g: { sceneCount: 124, median: 8.042, mean: 13.55 },
      "2ycRncs4CKY": { sceneCount: 125, median: 9.61, mean: 14.263 },
    },
    referenceShotMix: { environmentWide: .325, mediumTwoShot: .40, closeUp: .275 },
    actualShotMix: {
      environmentWide: Number((cameraRows.filter((row) => row.shotType === "wide").length / cameraRows.length).toFixed(3)),
      mediumTwoShot: Number((cameraRows.filter((row) => row.shotType === "medium").length / cameraRows.length).toFixed(3)),
      closeUp: Number((cameraRows.filter((row) => row.shotType === "close-up").length / cameraRows.length).toFixed(3)),
      multiUtterance: Number((cameraRows.filter((row) => row.sameImageBubbleCount > 1).length / cameraRows.length).toFixed(3)),
    },
  },
  ossStack: [
    { name: "PySceneDetect 0.6.7.1", role: "adaptive shot-boundary and reference hold-duration analysis" },
    { name: "OpenCV 4.12", role: "optical-flow/RANSAC camera motion measurement and rendered-direction QA" },
    { name: "FFmpeg 7.1", role: "script-driven zoompan, focus transfer, bubble compositing, H.264/AAC render" },
    { name: "SVG/Chromium", role: "deterministic reference-video-locked-v3 vertical Japanese bubbles" },
  ],
};
if (manifest.outputs?.reviewVideo) delete manifest.outputs.reviewVideo;
if (manifest.outputs?.finalVideo) delete manifest.outputs.finalVideo;
manifest.updatedAt = new Date().toISOString();

const movingRows = cameraRows.filter((row) => row.zoomStart > row.zoomEnd);
const audit = {
  version: "v19-editorial-camera-multibubble",
  shotCount: cameraRows.length,
  utteranceCount: manifest.utterances.length,
  sameImageMultiUtteranceShotCount: cameraRows.filter((row) => row.sameImageBubbleCount > 1).length,
  accumulatedTwoBubbleShotCount: cameraRows.filter((row) => row.simultaneousBubbleRetention).length,
  singleUtteranceShotCount: cameraRows.filter((row) => row.sameImageBubbleCount === 1).length,
  pullOutCount: movingRows.length,
  staticCount: cameraRows.filter((row) => row.zoomStart === row.zoomEnd).length,
  pushInCount: cameraRows.filter((row) => row.zoomStart < row.zoomEnd).length,
  angleFamilyCounts: {
    left: cameraRows.filter((row) => row.angle.startsWith("left")).length,
    right: cameraRows.filter((row) => row.angle.startsWith("right")).length,
    top: cameraRows.filter((row) => row.angle.startsWith("top")).length,
    wide: cameraRows.filter((row) => row.angle === "wide").length,
  },
  meanShotDurationSeconds: Number((cameraRows.reduce((sum, row) => sum + row.durationSeconds, 0) / cameraRows.length).toFixed(4)),
  referenceSceneHoldSeconds: {
    awAbZyTeE4g: { sceneCount: 124, median: 8.042, mean: 13.55 },
    "2ycRncs4CKY": { sceneCount: 125, median: 9.61, mean: 14.263 },
  },
  authoredZoomPercentPerSecond: {
    min: Math.min(...movingRows.map((row) => row.authoredZoomPercentPerSecond)),
    mean: Number((movingRows.reduce((sum, row) => sum + row.authoredZoomPercentPerSecond, 0) / movingRows.length).toFixed(4)),
    max: Math.max(...movingRows.map((row) => row.authoredZoomPercentPerSecond)),
  },
  authoredTranslationPercentPerSecond: {
    min: Math.min(...movingRows.map((row) => row.authoredTranslationPercentPerSecond)),
    mean: Number((movingRows.reduce((sum, row) => sum + row.authoredTranslationPercentPerSecond, 0) / movingRows.length).toFixed(4)),
    max: Math.max(...movingRows.map((row) => row.authoredTranslationPercentPerSecond)),
  },
  overlayQuality: {
    count: overlayAudit.length,
    activeSpeakerFaceSafeCount: overlayAudit.filter((row) => row.quality.faceOverlapRatio <= .005).length,
    textExactCount: overlayAudit.filter((row) => row.quality.columnTexts.join("") === normalizedText(utteranceById.get(row.utteranceId)?.text)).length,
    overflowCount: overlayAudit.filter((row) => row.quality.overflow).length,
  },
  cameraRows,
  overlayRows: overlayAudit,
};
const auditPath = join(episodeDir, "v19-editorial-camera-multibubble-plan.json");
await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  manifestPath,
  auditPath,
  shotCount: audit.shotCount,
  sameImageMultiUtteranceShotCount: audit.sameImageMultiUtteranceShotCount,
  accumulatedTwoBubbleShotCount: audit.accumulatedTwoBubbleShotCount,
  pullOutCount: audit.pullOutCount,
  staticCount: audit.staticCount,
  pushInCount: audit.pushInCount,
  angleFamilyCounts: audit.angleFamilyCounts,
  overlayQuality: audit.overlayQuality,
}, null, 2)}\n`);
