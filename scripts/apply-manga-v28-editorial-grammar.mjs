#!/usr/bin/env node
import { copyFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";
import { auditMangaEditorialPlan } from "../lib/mangaEditorialGrammar.mjs";
import { refreshEpisodeBubbleOverlays } from "../lib/mangaVideoPipeline.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = resolve(projectDir, "canvas/manga-videos/manga-photo-homecoming-001");
const manifestPath = resolve(episodeDir, "episode-manifest.json");
const backupPath = resolve(episodeDir, "episode-manifest-v27-speaker-proximity-bubbles-r1-backup.json");
const asset = (name) => resolve(projectDir, "canvas/assets", name);

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.production?.version === "v27-speaker-proximity-bubbles-r1") {
  await copyFile(manifestPath, backupPath);
}

const cutById = new Map(manifest.cuts.map((cut) => [cut.id, cut]));
const utteranceById = new Map(manifest.utterances.map((utterance) => [utterance.id, utterance]));

const cut01 = cutById.get("cut-01");
cut01.cameraSequence[0] = {
  ...cut01.cameraSequence[0],
  imagePath: asset("manga-photo-homecoming-001-v28-background-empty-photo-shop.png"),
  editorialBeat: "characterless rainy photo-shop exposition",
  reason: "冒頭二文は人物の行為ではなく写真と記憶の主題提示なので、参照動画の背景のみ語りへ切り替える",
  editorialPurpose: "人物を出さず、雨の写真店という物語空間にナレーションを定着させる",
  semanticStartSubject: "雨の写真店と作業机",
  semanticEndSubject: "名前を残さない写真という主題",
};

const cut03 = cutById.get("cut-03");
const dialogueShot = cut03.cameraSequence.find((shot) => shot.utteranceIds?.includes("cut-03-u01")) || cut03.cameraSequence[0];
const confessionShot = cut03.cameraSequence.find((shot) => shot.utteranceIds?.includes("cut-03-u03")) || cut03.cameraSequence.at(-1);
cut03.cameraSequence = [
  {
    ...dialogueShot,
    id: "cut-03-v28-mio-arrival",
    utteranceIds: ["cut-03-u01"],
    editorialBeat: "Mio's arrival line",
    reason: "澪の発話だけを先に見せ、次の心の声を独立した主観ショットにする",
    camera: {
      ...dialogueShot.camera,
      zoomStart: 1.58,
      zoomEnd: 1.58,
      focusX: 0.65,
      focusY: 0.39,
      focusXEnd: 0.52,
      focusYEnd: 0.39,
      keyframes: [
        { at: 0, zoom: 1.58, focusX: 0.65, focusY: 0.39 },
        { at: 1, zoom: 1.58, focusX: 0.52, focusY: 0.39 }
      ]
    }
  },
  {
    ...dialogueShot,
    id: "cut-03-v28-ren-private-thought",
    utteranceIds: ["cut-03-u02"],
    imagePath: asset("manga-photo-homecoming-001-v16-proof-closeup-ren-r2.png"),
    angle: "close-up",
    viewpoint: "front-left",
    endView: "close-up",
    shotType: "close-up",
    motion: "push-in-only-continuous",
    editorialBeat: "Ren privately recognizes Mio",
    reason: "心の声の間だけ蓮の顔へ切り替え、顔サイズの明部が動く被写体を外さないよう純粋な寄りに固定する",
    editorialPurpose: "外部会話と内面反応を参照動画同様に明確に分離する",
    semanticStartSubject: "澪に気づいた蓮の顔",
    semanticEndSubject: "東京にいるはずだという蓮の疑念",
    isSpatialWideShot: false,
    wideShotSource: null,
    camera: {
      zoomStart: 1.32,
      zoomEnd: 1.4,
      focusX: 0.34,
      focusY: 0.31,
      focusXEnd: 0.34,
      focusYEnd: 0.31,
      easing: "linear",
      motionLeadRatio: 0,
      motionTailRatio: 0,
      saturation: 1,
      contrast: 1,
      brightness: 0,
      keyframes: [
        { at: 0, zoom: 1.32, focusX: 0.34, focusY: 0.31 },
        { at: 1, zoom: 1.4, focusX: 0.34, focusY: 0.31 }
      ]
    }
  },
  confessionShot,
];
cut03.thoughtFocus = {
  speakerId: "manga-photo-homecoming-001-character-1",
  enabled: true,
  faceBounds: { x: 0.12, y: 0.07, width: 0.13, height: 0.23 },
  opacity: 0.31,
  faceBrightness: 0.1,
  referenceRule: "attachments-1-8-active-speaker-face-local-radial-thought-v33",
};

const cut06 = cutById.get("cut-06");
cut06.panelLayout = {
  enabled: true,
  type: "vertical-2",
  gutter: 24,
  ratios: [0.42, 0.58],
  editorialReason: "澪の拒絶と礼司の圧力を同時に対置する対立場面",
  panels: [
    {
      imagePath: asset("manga-photo-homecoming-001-v16-cut-06-medium-mio-resolve.png"),
      focusX: 0.72,
      focusY: 0.4,
      zoom: 1.06,
      role: "Mio refuses"
    },
    {
      imagePath: asset("manga-photo-homecoming-001-v16-cut-06-wide-reiji-pressure.png"),
      focusX: 0.82,
      focusY: 0.36,
      zoom: 1.06,
      role: "Reiji applies pressure"
    }
  ]
};
utteranceById.get("cut-06-u01").preset = "shout";
utteranceById.get("cut-06-u01").editorialPresetReason = "強い拒絶を参照30〜36の曲線凹型バーストで示す";

const cut08 = cutById.get("cut-08");
cut08.panelLayout = {
  enabled: true,
  type: "story-3",
  gutter: 24,
  splitRatio: 0.38,
  diagonalStart: 0.36,
  diagonalEnd: 0.63,
  enableFromUtteranceId: "cut-08-u02",
  enableThroughUtteranceId: "cut-08-u03",
  editorialReason: "翌週までの因果を送信・契約解除・空になった展示の三つへ圧縮する時間経過モンタージュ",
  panels: [
    {
      imagePath: asset("manga-photo-homecoming-001-v16-cut-08-medium-mio-send.png"),
      focusX: 0.48,
      focusY: 0.45,
      zoom: 1.05,
      role: "evidence sent"
    },
    {
      imagePath: asset("manga-photo-homecoming-001-v16-cut-08-wide-consequence.png"),
      focusX: 0.76,
      focusY: 0.34,
      zoom: 1.12,
      role: "contract consequence"
    },
    {
      imagePath: asset("manga-photo-homecoming-001-v28-background-empty-gallery.png"),
      focusX: 0.5,
      focusY: 0.55,
      zoom: 1.02,
      role: "empty cancelled gallery"
    }
  ]
};

const grammarEntries = manifest.utterances.map((utterance) => ({
  utterance,
  openingExposition: ["cut-01-u01", "cut-01-u02"].includes(utterance.id),
  visibleParticipantCount: utterance.cutId === "cut-06" ? 2 : 1,
  montageBeatCount: utterance.id === "cut-08-u02" ? 3 : 0,
}));
const editorialAudit = auditMangaEditorialPlan(grammarEntries);

manifest.video.fileName = "manga-photo-homecoming-001-v28-editorial-grammar-r1.mp4";
manifest.video.statusAfterRender = "final-v28-editorial-grammar-r1";
manifest.video.cutIds = "cut-01,cut-03,cut-06,cut-08";
manifest.video.cameraRendererRevision = "v28-editorial-panels-thought-bubbles-r1";
manifest.status = "v28-editorial-grammar-ready";
manifest.production = {
  ...(manifest.production || {}),
  version: "v28-editorial-grammar-r1",
  bubblePolicy: {
    ...(manifest.production?.bubblePolicy || {}),
    artificialBackgroundDarkening: true,
    thoughtShape: "104-line radial oval",
    thoughtLighting: "31% full-frame dim with a compact active-speaker face spotlight and 10% feathered face lift",
    shoutShape: "eight-tip curved concave burst matching attachments 30-36",
    trembleShape: "soft dense wavy apology/panic outline matching attachment 37; rare semantic gate only"
  },
  editorialGrammar: {
    version: "reference-v28-r1",
    referenceAnalysisPath: resolve(projectDir, "canvas/reference-media/love-manga/analysis/reference-editorial-grammar-v28.json"),
    rulesModulePath: resolve(projectDir, "lib/mangaEditorialGrammar.mjs"),
    backgroundOnlyAssetPaths: [
      asset("manga-photo-homecoming-001-v28-background-empty-photo-shop.png"),
      asset("manga-photo-homecoming-001-v28-background-empty-gallery.png")
    ],
    applied: {
      backgroundOnly: ["cut-01-u01", "cut-01-u02", "cut-08-u02:panel-3"],
      unequalTwoPanel: ["cut-06-u01", "cut-06-u02"],
      diagonalThreePanel: ["cut-08-u02", "cut-08-u03"],
      thoughtFocus: ["cut-03-u02"],
      curvedBurst: ["cut-06-u01"],
      tremble: []
    },
    trembleNonUseReason: "この台本には参照37と同等の吃音を伴う泣き謝罪がないため、機能のみ追加し誤用しない",
    audit: editorialAudit
  }
};
manifest.updatedAt = new Date().toISOString();
if (manifest.outputs?.reviewVideo) delete manifest.outputs.reviewVideo;
await writeJsonAtomic(manifestPath, manifest);

await refreshEpisodeBubbleOverlays({
  projectDir,
  manifestPath,
  bubbleOverrides: {
    "cut-03-u02": {},
    "cut-06-u01": {
      bounds: { x: 0.405, y: 0.055, width: 0.18, height: 0.72 },
      tail: false,
    },
  },
  status: "v28-editorial-grammar-ready",
});

const finalManifest = JSON.parse(await readFile(manifestPath, "utf8"));
finalManifest.status = "v28-editorial-grammar-ready";
finalManifest.production.version = "v28-editorial-grammar-r1";
finalManifest.updatedAt = new Date().toISOString();
await writeJsonAtomic(manifestPath, finalManifest);

process.stdout.write(`${JSON.stringify({
  manifestPath,
  backupPath,
  status: finalManifest.status,
  outputFileName: finalManifest.video.fileName,
  applied: finalManifest.production.editorialGrammar.applied,
}, null, 2)}\n`);
