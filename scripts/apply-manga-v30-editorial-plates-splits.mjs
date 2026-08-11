#!/usr/bin/env node
import { copyFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";
import { auditMangaEditorialPlan, MANGA_EDITORIAL_GRAMMAR_VERSION } from "../lib/mangaEditorialGrammar.mjs";
import { refreshEpisodeBubbleOverlays } from "../lib/mangaVideoPipeline.mjs";
import { REFERENCE_SEQUENCE_PLACEMENT_POLICY } from "../lib/speechBubbleRenderer.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas/manga-videos/manga-photo-homecoming-001");
const manifestPath = join(episodeDir, "episode-manifest.json");
const backupPath = join(episodeDir, "episode-manifest-v29-bubble-sequence-grammar-r1-backup.json");
const referenceAnalysisPath = join(
  projectDir,
  "canvas/reference-media/love-manga/analysis/v30-editorial-plates-splits/reference-editorial-plates-splits-v30.json",
);
const asset = (name) => join(projectDir, "canvas/assets", name);

const [manifest, referenceAnalysis] = await Promise.all([
  readFile(manifestPath, "utf8").then(JSON.parse),
  readFile(referenceAnalysisPath, "utf8").then(JSON.parse),
]);
if (
  referenceAnalysis?.summary?.approvedPlateMomentCount !== 13
  || referenceAnalysis?.summary?.approvedSplitMomentCount !== 7
  || referenceAnalysis?.summary?.splitClassCounts?.["story-3"] !== 1
  || referenceAnalysis?.summary?.movingPanelRatio !== 1
) {
  throw new Error("The full reference plate/split analysis is missing or incomplete.");
}
if (manifest.production?.version === "v29-bubble-sequence-grammar-r1") {
  await copyFile(manifestPath, backupPath);
}

const cutById = new Map(manifest.cuts.map((cut) => [cut.id, cut]));
const plateAssets = {
  white: asset("manga-editorial-plate-white-v30.png"),
  black: asset("manga-editorial-plate-black-v30.png"),
  promise: asset("manga-editorial-plate-pastel-sky-promise-v30.png"),
  closing: asset("manga-editorial-plate-pastel-sky-closing-v30.png"),
};
const editorialPlateShot = ({ id, utteranceId, imagePath, plateType, reason }) => ({
  id,
  utteranceIds: [utteranceId],
  imagePath,
  angle: "editorial-plate",
  viewpoint: "graphic",
  endView: "graphic",
  shotType: "characterless-editorial-plate",
  transition: "cut",
  motion: "none",
  camera: {
    zoomStart: 1,
    zoomEnd: 1,
    focusX: 0.5,
    focusY: 0.5,
    focusXEnd: 0.5,
    focusYEnd: 0.5,
    easing: "linear",
    motionLeadRatio: 0,
    motionTailRatio: 0,
    saturation: 1,
    contrast: 1,
    brightness: 0,
    keyframes: [],
  },
  motionStrength: "none",
  editorialBeat: `${plateType} characterless narration plate`,
  editorialPurpose: reason,
  semanticStartSubject: "narration caption only",
  semanticEndSubject: "narration caption only",
  isSpatialWideShot: false,
  wideShotSource: null,
  editorialPlate: {
    type: plateType,
    characterPolicy: "strictly-none",
    environmentPolicy: "none",
    referenceAnalysisPath,
  },
});

const cut01 = cutById.get("cut-01");
const cut01CharacterShot = cut01.cameraSequence.find((shot) => shot.utteranceIds?.includes("cut-01-u03"));
cut01.cameraSequence = [
  editorialPlateShot({
    id: "cut-01-v30-white-premise",
    utteranceId: "cut-01-u01",
    imagePath: plateAssets.white,
    plateType: "white-solid",
    reason: "写真という主題の第一文を、参照の冒頭白プレートと同じ無場所の静けさで提示する",
  }),
  editorialPlateShot({
    id: "cut-01-v30-black-counterpoint",
    utteranceId: "cut-01-u02",
    imagePath: plateAssets.black,
    plateType: "black-solid",
    reason: "守れない名前という否定と重さを、参照の黒プレートへ切り替えて分離する",
  }),
  cut01CharacterShot,
];

const cut06 = cutById.get("cut-06");
cut06.panelLayout = {
  enabled: true,
  type: "vertical-2",
  composition: "post-composite",
  separatorColor: "black",
  gutter: 28,
  ratios: [0.42, 0.58],
  editorialReason: "澪の拒絶と礼司の圧力を、非均等の対置カメラで同時に読ませる対立場面",
  referenceRule: "vertical-2; measured separator median 1.45% of frame width; every panel moves independently",
  panels: [
    {
      imagePath: asset("manga-photo-homecoming-001-v16-cut-06-medium-mio-resolve.png"),
      role: "Mio refuses",
      motion: "independent-continuous",
      camera: {
        zoomStart: 1.07,
        zoomEnd: 1.13,
        focusX: 0.7,
        focusY: 0.4,
        focusXEnd: 0.73,
        focusYEnd: 0.395,
        easing: "linear",
      },
    },
    {
      imagePath: asset("manga-photo-homecoming-001-v16-cut-06-wide-reiji-pressure.png"),
      role: "Reiji applies pressure",
      motion: "independent-continuous",
      camera: {
        zoomStart: 1.15,
        zoomEnd: 1.08,
        focusX: 0.79,
        focusY: 0.36,
        focusXEnd: 0.72,
        focusYEnd: 0.36,
        easing: "linear",
      },
    },
  ],
};

const cut08 = cutById.get("cut-08");
cut08.panelLayout = {
  enabled: true,
  type: "story-3",
  composition: "post-composite",
  separatorColor: "black",
  gutter: 28,
  splitRatio: 0.38,
  diagonalStart: 0.36,
  diagonalEnd: 0.63,
  enableFromUtteranceId: "cut-08-u02",
  enableThroughUtteranceId: "cut-08-u03",
  editorialReason: "証拠送信・契約の崩壊・礼司への反照を、左の主場面と右上下の因果へ圧縮する",
  referenceRule: "story-3; one full-height panel plus two diagonal story panels; every panel moves independently",
  panels: [
    {
      imagePath: asset("manga-photo-homecoming-001-v16-cut-08-medium-mio-send.png"),
      role: "evidence sent",
      motion: "independent-continuous",
      camera: {
        zoomStart: 1.08,
        zoomEnd: 1.08,
        focusX: 0.48,
        focusY: 0.56,
        focusXEnd: 0.46,
        focusYEnd: 0.38,
        easing: "linear",
      },
    },
    {
      imagePath: asset("manga-photo-homecoming-001-v16-cut-08-wide-consequence.png"),
      role: "contract consequence",
      motion: "independent-continuous",
      camera: {
        zoomStart: 1.12,
        zoomEnd: 1.18,
        focusX: 0.74,
        focusY: 0.34,
        focusXEnd: 0.68,
        focusYEnd: 0.34,
        easing: "linear",
      },
    },
    {
      imagePath: asset("manga-photo-homecoming-001-v16-cut-07-close-reiji-shock.png"),
      role: "borrowed light returns to Reiji",
      motion: "independent-continuous",
      camera: {
        zoomStart: 1.17,
        zoomEnd: 1.24,
        focusX: 0.36,
        focusY: 0.32,
        focusXEnd: 0.39,
        focusYEnd: 0.31,
        easing: "linear",
      },
    },
  ],
};

const cut09 = cutById.get("cut-09");
cut09.cameraSequence = cut09.cameraSequence.map((shot) => (
  shot.utteranceIds?.includes("cut-09-u03")
    ? editorialPlateShot({
        id: "cut-09-v30-pastel-promise",
        utteranceId: "cut-09-u03",
        imagePath: plateAssets.promise,
        plateType: "pastel-sky",
        reason: "子供の約束と帰る道の余韻を、参照の淡い桃空・青空プレートで解放する",
      })
    : shot
));

const cut10 = cutById.get("cut-10");
const cut10DialogueShot = cut10.cameraSequence.find((shot) => shot.utteranceIds?.includes("cut-10-u01"));
const cut10ClosingShot = cut10.cameraSequence.find((shot) => shot.utteranceIds?.includes("cut-10-u03"));
cut10.cameraSequence = [
  cut10DialogueShot,
  { ...cut10ClosingShot, id: "cut-10-v30-ren-answer", utteranceIds: ["cut-10-u03"] },
  editorialPlateShot({
    id: "cut-10-v30-pastel-closing",
    utteranceId: "cut-10-u04",
    imagePath: plateAssets.closing,
    plateType: "pastel-sky",
    reason: "二人の新しい一枚目という結語を人物から離し、参照の淡い空だけで着地させる",
  }),
];

const explicitPlateByUtterance = {
  "cut-01-u01": "white-solid",
  "cut-01-u02": "black-solid",
  "cut-09-u03": "pastel-sky",
  "cut-10-u04": "pastel-sky",
};
const editorialAudit = auditMangaEditorialPlan(manifest.utterances.map((utterance) => ({
  utterance,
  editorialPlateType: explicitPlateByUtterance[utterance.id],
  openingExposition: utterance.id === "cut-01-u01",
  visibleParticipantCount: utterance.cutId === "cut-06" ? 2 : 1,
  montageBeatCount: utterance.id === "cut-08-u02" ? 3 : 0,
})));

manifest.video = {
  ...(manifest.video || {}),
  fileName: "manga-photo-homecoming-001-v30-editorial-plates-splits-r1.mp4",
  statusAfterRender: "final-v30-editorial-plates-splits-r1",
  cutIds: "",
  cameraRendererRevision: "v30-post-composite-independent-panel-cameras-r1",
};
manifest.status = "v30-editorial-plates-splits-ready";
manifest.production = {
  ...(manifest.production || {}),
  version: "v30-editorial-plates-splits-r1",
  editorialGrammar: {
    version: MANGA_EDITORIAL_GRAMMAR_VERSION,
    referenceAnalysisPath,
    measured: referenceAnalysis.summary,
    platePolicy: {
      definition: "a characterless, locationless white, black, or pastel-sky graphic field with caption/bubble",
      forbiddenSubstitute: "an empty illustrated room, shop, gallery, street, or other literal environment",
      white: "neutral premise, recognition pause, clean opening reset",
      black: "negative counterpoint, loss, consequence, isolation, or heavy reflection",
      pastelSky: "tender promise, future, emotional release, or epilogue",
    },
    splitPolicy: {
      generation: "generate borderless full illustrations; add black separators and masks in deterministic post-composite",
      separatorWidthRatio: 0.0145,
      twoPanel: "conflict, reaction contrast, parallel action, or two simultaneous viewpoints",
      storyThree: "three causally distinct beats compressed across time or space",
      panelCamera: "every panel has its own continuous zoom/pan; never animate only the assembled composite",
    },
    plateAssetPaths: Object.values(plateAssets),
    applied: {
      whitePlate: ["cut-01-u01"],
      blackPlate: ["cut-01-u02"],
      pastelSkyPlate: ["cut-09-u03", "cut-10-u04"],
      unequalTwoPanel: ["cut-06-u01", "cut-06-u02"],
      diagonalStoryThree: ["cut-08-u02", "cut-08-u03"],
    },
    audit: editorialAudit,
  },
};
manifest.updatedAt = new Date().toISOString();
if (manifest.outputs?.reviewVideo) delete manifest.outputs.reviewVideo;
await writeJsonAtomic(manifestPath, manifest);

const plateBubbleOverrides = Object.fromEntries(
  Object.keys(explicitPlateByUtterance).map((utteranceId) => [utteranceId, { clearAvoidRegions: true }]),
);
const refreshed = await refreshEpisodeBubbleOverlays({
  projectDir,
  manifestPath,
  bubbleOverrides: plateBubbleOverrides,
  refreshAll: true,
  reflowPlacement: true,
  sequenceAware: true,
  placementHistoryDepth: REFERENCE_SEQUENCE_PLACEMENT_POLICY.historyDepth,
  status: "v30-editorial-plates-splits-ready",
});
const finalManifest = refreshed.manifest;
finalManifest.status = "v30-editorial-plates-splits-ready";
finalManifest.production.version = "v30-editorial-plates-splits-r1";
finalManifest.production.editorialGrammar.refreshAudit = {
  refreshedOverlayCount: refreshed.refreshed.length,
  nearRepeatCount: refreshed.refreshed.filter((entry) => entry.sequencePlacement?.nearRepeat).length,
  samePocketCount: refreshed.refreshed.filter((entry) => entry.sequencePlacement?.immediate?.samePocket).length,
};
finalManifest.updatedAt = new Date().toISOString();
await writeJsonAtomic(manifestPath, finalManifest);

process.stdout.write(`${JSON.stringify({
  manifestPath,
  backupPath,
  status: finalManifest.status,
  outputFileName: finalManifest.video.fileName,
  referenceSummary: referenceAnalysis.summary,
  applied: finalManifest.production.editorialGrammar.applied,
  refreshAudit: finalManifest.production.editorialGrammar.refreshAudit,
}, null, 2)}\n`);
