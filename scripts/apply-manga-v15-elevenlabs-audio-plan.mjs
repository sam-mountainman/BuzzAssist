#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const projectDir = resolve(process.argv[2] || process.cwd());
const manifestPath = resolve(
  process.argv[3]
    || join(projectDir, "canvas", "manga-videos", "manga-photo-homecoming-001", "episode-manifest.json"),
);
const registryPath = join(projectDir, "canvas", "characters.json");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const registry = JSON.parse(await readFile(registryPath, "utf8"));

const voices = {
  narration: {
    id: "photo-narration-jp-v15",
    name: "Koichi - Japanese Deep Calm Narrator",
    providerVoiceId: "H8ZPDxbrPcks5hEsi2fq",
    role: "narration",
    settings: { stability: 0.5, similarityBoost: 0.82, speed: 1, useSpeakerBoost: true },
  },
  ren: {
    id: "photo-ren-jp-v15",
    name: "Asahi - Calm and Natural",
    providerVoiceId: "GKDaBI8TKSBJVhsCLD6n",
    role: "高瀬 蓮",
    settings: { stability: 0.5, similarityBoost: 0.82, speed: 1, useSpeakerBoost: true },
  },
  mio: {
    id: "photo-mio-jp-v15",
    name: "Chii-chan - Neutral and Clear",
    providerVoiceId: "GxhGYQesaQaYKePCZDEC",
    role: "水野 澪",
    settings: { stability: 0.5, similarityBoost: 0.82, speed: 1, useSpeakerBoost: true },
  },
  reiji: {
    id: "photo-reiji-jp-v15",
    name: "Sawaro - Japanese Actor Voice",
    providerVoiceId: "EbuvaInXUGWtpYRUnKLQ",
    role: "神谷 玲司",
    settings: { stability: 0.5, similarityBoost: 0.84, speed: 1, useSpeakerBoost: true },
  },
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
  "cut-04-u01": "[hurt]",
  "cut-04-u02": "[concerned]",
  "cut-04-u03": "[quietly]",
  "cut-05-u01": "[controlled]",
  "cut-05-u02": "[firmly]",
  "cut-05-u03": "[coldly]",
  "cut-06-u01": "[determined]",
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

const speechOverrideByUtterance = {
  "cut-01-u01": "しゃしんは、光がそこにあったことを証明する。",
  "cut-01-u02": "けれど、写した人の名前まで守ってくれるわけではない。",
  "cut-01-u03": "雨、強くなったな。閉店前に、この現像だけ終わらせよう。",
  "cut-02-u01": "商店街の古い写真店で、/ɾeɴ/は、色あせた家族写真を一枚ずつ補修していた。",
  "cut-02-u02": "思い出は新品にできません。でも、もう一度見える形には戻せます。",
  "cut-03-u01": "その言い方、昔と変わらないね。",
  "cut-03-u02": "みおなのか？　東京にいるはずじゃ……",
  "cut-03-u03": "帰ってきたの。行く場所はあるのに、帰りたい場所が分からなくなって……",
  "cut-04-u01": "私が撮った写真を、恋人だったかみやさんが、自分の作品として発表したの。",
  "cut-04-u02": "元データか、撮影した日を証明できるものは？",
  "cut-04-u03": "全部向こうに預けたまま。信じていたから……",
  "cut-05-u01": "連絡を無視するから迎えに来た。君は僕の助手だ。勝手に帰られると困る。",
  "cut-05-u02": "彼女の作品を、あなたの名前で出したんですか？",
  "cut-05-u03": "世に出したのは僕だ。名前なんて、売れる側のものだろう。",
  "cut-06-u01": "私は戻らない。あの写真は、祖母の最後の夏を撮った、大切な記録なの。",
  "cut-06-u02": "かんじょうで仕事を失うつもりか？　この町に君の居場所なんてない。",
  "cut-07-u01": "ある。みおが十年前に預けたネガです。",
  "cut-07-u02": "去年ふくせいしたデータも、さくせいにちじも、いらいひょうも残っています。",
  "cut-07-u03": "そんな古い記録が、何になる。",
  "cut-08-u01": "てんじのしゅさいしゃへ送る。さつえいしゃが誰か、私の名前で確かめてもらう。",
  "cut-08-u02": "翌週、展示は中止され、かみやとの契約も解除された。",
  "cut-08-u03": "彼が借りた光は、彼自身を照らし返した。",
  "cut-09-u01": "私が遠くに行っても、写真を捨てないでね。",
  "cut-09-u02": "捨てない。いつか帰ってきたら、ちゃんと返す。",
  "cut-09-u03": "子供の約束は未来を縛らず、帰る道に小さな灯りを残すことがある。",
  "cut-10-u01": "店の二階、空いてるよね。ここで写真スタジオを始めたい。",
  "cut-10-u02": "それから……今度は、レンの隣にいたい。",
  "cut-10-u03": "おかえり。仕事も、その先も、ゆっくり一緒に決めよう。",
  "cut-10-u04": "雨上がりの商店街で、二人の新しい一枚目が、静かに写真になっていった。",
};

const pauseBeforeByUtterance = {
  "cut-01-u02": 0.30,
  "cut-01-u03": 0.48,
  "cut-02-u02": 0.48,
  "cut-03-u02": 0.56,
  "cut-03-u03": 0.50,
  "cut-04-u02": 0.46,
  "cut-04-u03": 0.45,
  "cut-05-u02": 0.46,
  "cut-05-u03": 0.46,
  "cut-06-u02": 0.50,
  "cut-07-u02": 0.30,
  "cut-07-u03": 0.48,
  "cut-08-u02": 0.62,
  "cut-08-u03": 0.34,
  "cut-09-u02": 0.46,
  "cut-09-u03": 0.54,
  "cut-10-u02": 0.36,
  "cut-10-u03": 0.58,
  "cut-10-u04": 0.64,
};

const voiceForUtterance = (utterance) => {
  if (utterance.speakerId === "narration") return voices.narration;
  if (/神谷/u.test(utterance.speakerName || "")) return voices.reiji;
  if (/澪/u.test(utterance.speakerName || "")) return voices.mio;
  return voices.ren;
};

for (const utterance of manifest.utterances || []) {
  const voice = voiceForUtterance(utterance);
  const performancePrompt = performanceByUtterance[utterance.id];
  const speechOverride = speechOverrideByUtterance[utterance.id];
  if (!performancePrompt || !speechOverride) throw new Error(`Missing V15 speech plan for ${utterance.id}.`);
  utterance.model = "eleven_v3";
  utterance.voiceProfileId = voice.id;
  utterance.voiceId = voice.providerVoiceId;
  utterance.voiceName = voice.name;
  utterance.voiceSettings = voice.settings;
  utterance.performancePrompt = performancePrompt;
  utterance.speechOverride = speechOverride;
  utterance.speechText = speechOverride;
  utterance.speechAuditText = speechOverride.replaceAll("/ɾeɴ/", "レン");
  utterance.audioFileName = `${manifest.id}-${utterance.id}-v15-elevenlabs.mp3`;
  utterance.pauseBeforeSeconds = pauseBeforeByUtterance[utterance.id];
  if (utterance.pauseBeforeSeconds === undefined) delete utterance.pauseBeforeSeconds;
  utterance.pauseClass = ["cut-03-u02", "cut-08-u02", "cut-10-u04"].includes(utterance.id)
    ? "emphasis"
    : null;
  utterance.audio = null;
  utterance.timing = null;
  delete utterance.provider;
  delete utterance.speechTuning;
  delete utterance.styleBertVoiceKey;
}

manifest.model = "eleven_v3";
manifest.defaultVoiceId = voices.narration.providerVoiceId;
manifest.defaultVoiceName = voices.narration.name;
manifest.video = {
  ...(manifest.video || {}),
  sameSpeakerGapSeconds: 0.30,
  speakerChangeGapSeconds: 0.48,
  emphasisGapSeconds: 0.62,
  cutTailSeconds: 0.46,
  speechConcurrency: 2,
  normalizeVoiceAudio: true,
  voiceTargetLufs: -19,
  voiceLoudnessRange: 7,
  voiceTruePeakDb: -2,
  voiceFadeInMilliseconds: 12,
  voiceFadeOutMilliseconds: 18,
  normalizeMasterAudio: true,
  masterTargetLufs: -14.5,
  masterLoudnessRange: 7,
  masterTruePeakDb: -1.5,
  fileName: "manga-photo-homecoming-001-v15-elevenlabs-final-r1.mp4",
  statusAfterRender: "final-review-candidate-v15-elevenlabs-r1",
};
manifest.speech = {
  ...(manifest.speech || {}),
  auditPolicy: "native-japanese-elevenlabs-v3-plus-whisper-reading-and-edge-audit-v15",
  performancePromptPolicy: {
    provider: "elevenlabs-v3-audio-tags",
    oneRestrainedDirectionPerUtterance: true,
    stabilityPreset: "natural",
    displayTextUnchanged: true,
    voiceIdentityFixedPerCharacter: true,
  },
  masteringPolicy: {
    providerAudioPreserved: true,
    pitchOrTimbreProcessing: false,
    denoiseOrVoiceConversion: false,
    perLineTargetLufs: -19,
    finalTargetLufs: -14.5,
    fadeInMilliseconds: 12,
    fadeOutMilliseconds: 18,
    note: "Only transparent loudness matching, resampling for the video container, and click-safe edge fades are applied.",
  },
};
manifest.status = "speech-performance-planned-v15-elevenlabs";
manifest.outputs = {};
manifest.jobs = { ...(manifest.jobs || {}), speech: {}, render: {} };
manifest.audioQuality = {
  version: "v15-elevenlabs",
  provider: "elevenlabs",
  model: "eleven_v3",
  nativeJapaneseVoices: true,
  voiceProfiles: Object.fromEntries(Object.entries(voices).map(([role, voice]) => [role, {
    voiceProfileId: voice.id,
    voiceName: voice.name,
    voiceId: voice.providerVoiceId,
  }])),
  goals: [
    "native Japanese intonation with restrained emotion",
    "stable character identity and line loudness",
    "locked readings for ambiguous names",
    "click-free joins without voice conversion or timbre processing",
    "natural same-speaker, speaker-change, and emphasis pauses",
  ],
  pauseRanges: {
    sameSpeaker: { min: 0.28, max: 0.38, default: 0.30 },
    speakerSwitch: { min: 0.44, max: 0.58, default: 0.48 },
    emphasis: { min: 0.56, max: 0.68, default: 0.62 },
    cutTail: { min: 0.42, max: 0.52, default: 0.46 },
  },
};
manifest.updatedAt = new Date().toISOString();

const voiceRecords = Object.values(voices).map((voice) => ({
  id: voice.id,
  name: voice.name,
  provider: "elevenlabs",
  providerVoiceId: voice.providerVoiceId,
  elevenLabsVoiceId: voice.providerVoiceId,
  modelId: "eleven_v3",
  role: voice.role,
  status: "approved-v15-native-japanese",
  settings: voice.settings,
}));
const voiceIds = new Set(voiceRecords.map((voice) => voice.id));
registry.voices = [
  ...(registry.voices || []).filter((voice) => !voiceIds.has(voice.id)),
  ...voiceRecords,
];
const characterVoiceIds = {
  "manga-photo-homecoming-001-character-1": voices.ren.id,
  "manga-photo-homecoming-001-character-2": voices.mio.id,
  "manga-photo-homecoming-001-character-3": voices.reiji.id,
  "manga-photo-homecoming-001-child-v7-character-1": voices.mio.id,
  "manga-photo-homecoming-001-child-v7-character-2": voices.ren.id,
};
for (const character of registry.characters || []) {
  if (characterVoiceIds[character.id]) character.voiceId = characterVoiceIds[character.id];
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  manifestPath,
  registryPath,
  utteranceCount: manifest.utterances?.length || 0,
  voiceCount: voiceRecords.length,
  model: manifest.model,
  outputFileName: manifest.video.fileName,
}, null, 2)}\n`);
