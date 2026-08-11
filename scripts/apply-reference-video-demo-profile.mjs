#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { applySpeechPronunciations } from "../lib/mangaVideoPipeline.mjs";
import { getImageDimensionsFromBuffer, writeJsonAtomic } from "../lib/canvasScene.mjs";

const manifestPath = resolve(process.argv[2] || "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

const pronunciations = [
  { from: "蓮", to: "レン" },
  { from: "澪", to: "ミオ" },
  { from: "神谷", to: "カミヤ" },
  { from: "写真", to: "しゃしん" },
  { from: "展示", to: "てんじ" },
  { from: "感情", to: "かんじょう" },
  { from: "連絡", to: "れんらく" },
  { from: "捨てない", to: "すてない" },
];

const cameraByCutId = {
  "cut-01": { zoomStart: 1.2, zoomEnd: 1.27, focusX: 0.34, focusY: 0.38, focusXEnd: 0.37, focusYEnd: 0.38 },
  "cut-02": { zoomStart: 1.18, zoomEnd: 1.25, focusX: 0.43, focusY: 0.42, focusXEnd: 0.46, focusYEnd: 0.42 },
  "cut-03": { zoomStart: 1.12, zoomEnd: 1.18, focusX: 0.49, focusY: 0.37, focusXEnd: 0.51, focusYEnd: 0.37 },
  "cut-04": { zoomStart: 1.05, zoomEnd: 1.1, focusX: 0.49, focusY: 0.35, focusXEnd: 0.53, focusYEnd: 0.35 },
  "cut-05": { zoomStart: 1.05, zoomEnd: 1.1, focusX: 0.52, focusY: 0.36, focusXEnd: 0.55, focusYEnd: 0.36 },
  "cut-06": { zoomStart: 1.14, zoomEnd: 1.21, focusX: 0.51, focusY: 0.35, focusXEnd: 0.54, focusYEnd: 0.35 },
  "cut-07": { zoomStart: 1.12, zoomEnd: 1.2, focusX: 0.49, focusY: 0.36, focusXEnd: 0.45, focusYEnd: 0.36 },
  "cut-08": { zoomStart: 1, zoomEnd: 1, focusX: 0.5, focusY: 0.42 },
  "cut-09": { zoomStart: 1.28, zoomEnd: 1.35, focusX: 0.51, focusY: 0.42, focusXEnd: 0.49, focusYEnd: 0.42 },
  "cut-10": { zoomStart: 1.17, zoomEnd: 1.24, focusX: 0.48, focusY: 0.37, focusXEnd: 0.51, focusYEnd: 0.37 },
};

// Never promote generation candidates from this migration script.  The v4
// candidate set was rejected during visual review because its drawing grammar
// drifted toward polished modern anime.  Keep the last known baseline active
// until a separately audited v5 image map is explicitly approved.
const imageByCutId = {
  "cut-01": "canvas/assets/manga-photo-homecoming-001/cut-01.png",
  "cut-02": "canvas/assets/manga-photo-homecoming-001/cut-02.png",
  "cut-03": "canvas/assets/manga-photo-homecoming-001/cut-03.png",
  "cut-04": "canvas/assets/manga-photo-homecoming-001/cut-04.png",
  "cut-05": "canvas/assets/manga-photo-homecoming-001/cut-05.png",
  "cut-06": "canvas/assets/manga-photo-homecoming-001/cut-06.png",
  "cut-07": "canvas/assets/manga-photo-homecoming-001/cut-07.png",
  "cut-08": "canvas/assets/manga-photo-homecoming-001/cut-08.png",
  "cut-09": "canvas/assets/manga-photo-homecoming-001/cut-09.png",
  "cut-10": "canvas/assets/manga-photo-homecoming-001/cut-10.png",
};

manifest.model = "eleven_multilingual_v2";
manifest.speech = {
  ...(manifest.speech || {}),
  pronunciations,
  auditPolicy: "display-kanji-speak-kana-and-asr-check-v1",
};
manifest.video = {
  ...(manifest.video || {}),
  preRollSeconds: 0.1,
  interUtteranceGapSeconds: 0.14,
  bubbleLeadSeconds: 0.08,
  bubbleHoldSeconds: 0.18,
  bubbleTransitionGapSeconds: 1 / 30,
  cutTailSeconds: 0.25,
};

for (const utterance of manifest.utterances || []) {
  utterance.speechText = applySpeechPronunciations(utterance.text, pronunciations);
  utterance.model = "eleven_multilingual_v2";
  utterance.voiceSettings = {
    ...(utterance.voiceSettings || {}),
    stability: utterance.speakerId === "narration" ? 0.7 : utterance.voiceProfileId === "photo-reiji-default" ? 0.74 : 0.72,
  };
}

for (const cut of manifest.cuts || []) {
  if (imageByCutId[cut.id]) {
    cut.imagePath = resolve(imageByCutId[cut.id]);
    cut.imageSize = getImageDimensionsFromBuffer(await readFile(cut.imagePath), cut.imagePath);
    cut.imageGeneration = {
      status: "baseline-active-v5-style-calibration-pending",
      route: "baseline",
      visualProfileId: "koutani-reference-video-v1",
    };
  }
  cut.camera = { ...(cameraByCutId[cut.id] || cameraByCutId["cut-03"]), saturation: 1.1, contrast: 1.04, brightness: 0.012 };
  delete cut.panelLayout;
  delete cut.thoughtFocus;
  if (cut.id === "cut-03") {
    cut.thoughtFocus = { focusX: 0.34, focusY: 0.25, radiusX: 0.14, radiusY: 0.23, opacity: 0.73 };
  }
  if (cut.id === "cut-08") {
    cut.motion = "none";
    cut.panelLayout = {
      enabled: true,
      type: "vertical-2",
      gutter: 28,
      enableFromUtteranceId: "cut-08-u02",
      panels: [
        { focusX: 0.35, focusY: 0.34, zoom: 1.55 },
        { focusX: 0.96, focusY: 0.34, zoom: 1.78 },
      ],
    };
  }
}

manifest.referenceVideoProfile = {
  id: "koutani-reference-video-v1",
  revision: "v5-style-calibration",
  framing: "face-height-18-to-30-percent-medium-30-to-45-percent-close",
  thoughtFocus: "deterministic-dark-mask-bright-face",
  panelPolicy: "explicit-story-moment-only",
  backgroundPolicy: "match-direct-reference-density-and-abstraction-without-modern-anime-polish",
};
manifest.status = "visual-style-calibration-pending";
manifest.updatedAt = new Date().toISOString();

await writeJsonAtomic(manifestPath, manifest);
process.stdout.write(`${JSON.stringify({ manifestPath, status: manifest.status, cuts: manifest.cuts.length, utterances: manifest.utterances.length }, null, 2)}\n`);
