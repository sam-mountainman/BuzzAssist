#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const projectDir = resolve(process.argv[2] || process.cwd());
const manifestPath = resolve(
  process.argv[3]
    || join(projectDir, "canvas", "manga-videos", "manga-photo-homecoming-001", "episode-manifest.json"),
);

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

const voiceProfiles = {
  narration: { stability: 0.55, similarityBoost: 0.82, speed: 0.98, useSpeakerBoost: true },
  ren: { stability: 0.50, similarityBoost: 0.82, speed: 0.98, useSpeakerBoost: true },
  mio: { stability: 0.50, similarityBoost: 0.82, speed: 0.98, useSpeakerBoost: true },
  reiji: { stability: 0.56, similarityBoost: 0.84, speed: 0.97, useSpeakerBoost: true },
};

const performanceByUtterance = {
  "cut-01-u01": "[calm]",
  "cut-01-u02": "[reflective]",
  "cut-01-u03": "[quietly]",
  "cut-02-u01": "[calm]",
  "cut-02-u02": "[warmly]",
  "cut-03-u01": "[softly]",
  "cut-03-u02": "[surprised]",
  "cut-03-u03": "[sad]",
  "cut-04-u01": "[sad]",
  "cut-04-u02": "[concerned]",
  "cut-04-u03": "[quietly]",
  "cut-05-u01": "[controlled]",
  "cut-05-u02": "[firmly]",
  "cut-05-u03": "[coldly]",
  "cut-06-u01": "[firmly]",
  "cut-06-u02": "[coldly]",
  "cut-07-u01": "[firmly]",
  "cut-07-u02": "[calm]",
  "cut-07-u03": "[uneasy]",
  "cut-08-u01": "[determined]",
  "cut-08-u02": "[calm]",
  "cut-08-u03": "[reflective]",
  "cut-09-u01": "[softly]",
  "cut-09-u02": "[warmly]",
  "cut-09-u03": "[reflective]",
  "cut-10-u01": "[hopeful]",
  "cut-10-u02": "[tenderly]",
  "cut-10-u03": "[warmly]",
  "cut-10-u04": "[reflective]",
};

const pauseBeforeByUtterance = {
  "cut-01-u02": 0.28,
  "cut-01-u03": 0.46,
  "cut-02-u02": 0.46,
  "cut-03-u02": 0.52,
  "cut-03-u03": 0.48,
  "cut-04-u02": 0.44,
  "cut-04-u03": 0.44,
  "cut-05-u02": 0.44,
  "cut-05-u03": 0.44,
  "cut-06-u02": 0.46,
  "cut-07-u02": 0.28,
  "cut-07-u03": 0.46,
  "cut-08-u02": 0.60,
  "cut-08-u03": 0.32,
  "cut-09-u02": 0.44,
  "cut-09-u03": 0.52,
  "cut-10-u02": 0.34,
  "cut-10-u03": 0.56,
  "cut-10-u04": 0.62,
};

const profileForUtterance = (utterance) => {
  if (utterance.speakerId === "narration") return voiceProfiles.narration;
  if (/神谷/u.test(utterance.speakerName || "")) return voiceProfiles.reiji;
  if (/澪/u.test(utterance.speakerName || "")) return voiceProfiles.mio;
  return voiceProfiles.ren;
};

const pronunciationPairs = [
  ["作成日時", "さくせいにちじ"],
  ["撮影者", "さつえいしゃ"],
  ["撮影", "さつえい"],
  ["現像", "げんぞう"],
  ["補修", "ほしゅう"],
  ["元データ", "もとデータ"],
  ["依頼票", "いらいひょう"],
  ["複製", "ふくせい"],
  ["主催者", "しゅさいしゃ"],
  ["契約", "けいやく"],
  ["解除", "かいじょ"],
  ["一枚目", "いちまいめ"],
  ["商店街", "しょうてんがい"],
  ["祖母", "そぼ"],
  ["蓮", "れん"],
  ["澪", "みお"],
  ["神谷", "かみや"],
  ["写真", "しゃしん"],
  ["展示", "てんじ"],
  ["感情", "かんじょう"],
  ["捨てない", "すてない"],
  ["翌週", "よくしゅう"],
  ["その先", "そのさき"],
];

manifest.speech = {
  ...(manifest.speech || {}),
  pronunciations: pronunciationPairs.map(([from, to]) => ({ from, to })),
  auditPolicy: "display-kanji-speak-kana-performance-prompt-asr-and-edge-audit-v11",
  performancePromptPolicy: {
    provider: "elevenlabs-v3-audio-tags",
    displayTextUnchanged: true,
    oneRestrainedDirectionPerUtterance: true,
    voiceIdentityFixedPerCharacter: true,
  },
  masteringPolicy: {
    sampleRateHz: 48000,
    channelLayout: "mono-per-line-stereo-master",
    targetIntegratedLufs: -20,
    targetLoudnessRange: 7,
    truePeakDb: -2,
    fadeInMilliseconds: 12,
    fadeOutMilliseconds: 18,
  },
};

manifest.video = {
  ...(manifest.video || {}),
  sameSpeakerGapSeconds: 0.28,
  speakerChangeGapSeconds: 0.44,
  emphasisGapSeconds: 0.60,
  cutTailSeconds: 0.42,
  speechConcurrency: 2,
  fileName: "manga-photo-homecoming-001-v11-final-r1.mp4",
  statusAfterRender: "final-review-candidate-v11-r1",
};

for (const utterance of manifest.utterances || []) {
  const performancePrompt = performanceByUtterance[utterance.id];
  if (!performancePrompt) throw new Error(`Missing V11 performance direction for ${utterance.id}.`);
  utterance.model = "eleven_v3";
  utterance.performancePrompt = performancePrompt;
  utterance.voiceSettings = profileForUtterance(utterance);
  utterance.audioFileName = `${manifest.id}-${utterance.id}-v11-raw.mp3`;
  if (pauseBeforeByUtterance[utterance.id] !== undefined) {
    utterance.pauseBeforeSeconds = pauseBeforeByUtterance[utterance.id];
  } else {
    delete utterance.pauseBeforeSeconds;
  }
  utterance.pauseClass = ["cut-03-u02", "cut-08-u02", "cut-10-u04"].includes(utterance.id)
    ? "emphasis"
    : null;
  utterance.audio = null;
  utterance.timing = null;
}

manifest.model = "eleven_v3";
manifest.status = "speech-performance-planned-v11";
manifest.outputs = {};
manifest.audioQuality = {
  version: "v11",
  pauseRanges: {
    sameSpeaker: { min: 0.24, max: 0.38, default: 0.28 },
    speakerSwitch: { min: 0.40, max: 0.60, default: 0.44 },
    emphasis: { min: 0.50, max: 0.70, default: 0.60 },
    cutTail: { min: 0.40, max: 0.50, default: 0.42 },
    note: "V11 keeps natural Japanese phrase release while making speaker changes perceptibly longer than same-speaker continuation.",
  },
  goals: [
    "natural Japanese intonation and emotion",
    "stable voice identity and line loudness",
    "pronunciation-locked names and technical terms",
    "click-free joins",
    "different natural pauses for same-speaker, speaker-change, and emphasis",
  ],
  ossStack: ["FFmpeg loudnorm", "FFmpeg soxr resampler", "FFmpeg fades", "Whisper large-v3 audit", "SudachiPy reading comparison"],
};
manifest.updatedAt = new Date().toISOString();

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  manifestPath,
  utteranceCount: manifest.utterances?.length || 0,
  performanceDirections: Object.keys(performanceByUtterance).length,
  pronunciationRules: pronunciationPairs.length,
  videoTiming: {
    sameSpeakerGapSeconds: manifest.video.sameSpeakerGapSeconds,
    speakerChangeGapSeconds: manifest.video.speakerChangeGapSeconds,
    emphasisGapSeconds: manifest.video.emphasisGapSeconds,
    cutTailSeconds: manifest.video.cutTailSeconds,
  },
}, null, 2)}\n`);
