#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { requireElevenLabsApiKey } from "../lib/speechGeneration.mjs";

const execFile = promisify(execFileCallback);
const projectDir = resolve(process.argv[2] || process.cwd());
const pipelineVersion = process.env.MANGA_DIALOGUE_VERSION === "v25" ? "v25" : "v22";
const isV25 = pipelineVersion === "v25";
const manifestPath = resolve(process.argv[3] || join(
  projectDir,
  "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json",
));
const episodeDir = dirname(manifestPath);
const assetsDir = join(projectDir, "canvas/assets/audio");
const alignmentsDir = join(projectDir, "canvas/audio-alignments");
const sourceDir = join(episodeDir, isV25 ? ".v25-dialogue-source" : ".v22-dialogue-source");
const reportPath = join(episodeDir, `${pipelineVersion}-elevenlabs-dialogue-generation.json`);
const backupPath = join(
  episodeDir,
  isV25
    ? "episode-manifest-v24-exclusive-bubbles-r1-backup.json"
    : "episode-manifest-v21-camera-master-r2-backup.json",
);
const stageOnly = process.argv.includes("--stage-only");
const requestedCutIds = new Set(
  (process.argv.find((value) => value.startsWith("--cut-ids=")) || "")
    .replace(/^--cut-ids=/u, "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const requestedTakeCount = Math.max(
  1,
  Math.min(8, Number((process.argv.find((value) => value.startsWith("--take-count=")) || "").split("=")[1]) || 2),
);

const manifestText = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(manifestText);
const utteranceById = new Map(manifest.utterances.map((utterance) => [utterance.id, utterance]));

const v22PerformanceByUtterance = {
  "cut-01-u01": "[thoughtful]",
  "cut-01-u02": "[thoughtful]",
  "cut-01-u03": "[softly]",
  "cut-02-u01": "[thoughtful]",
  "cut-02-u02": "[warm]",
  "cut-03-u01": "[softly]",
  "cut-03-u02": "[surprised]",
  "cut-03-u03": "[sad]",
  "cut-04-u01": "[hurt]",
  "cut-04-u02": "[concerned]",
  "cut-04-u03": "[sad]",
  "cut-05-u01": "[cold]",
  "cut-05-u02": "[angry]",
  "cut-05-u03": "[sarcastic]",
  "cut-06-u01": "[angry]",
  "cut-06-u02": "[angry]",
  "cut-07-u01": "[confident]",
  "cut-07-u02": "[confident]",
  "cut-07-u03": "[nervous]",
  "cut-08-u01": "[determined]",
  "cut-08-u02": "[thoughtful]",
  "cut-08-u03": "[thoughtful]",
  "cut-09-u01": "[softly]",
  "cut-09-u02": "[warm]",
  "cut-09-u03": "[thoughtful]",
  "cut-10-u01": "[hopeful]",
  "cut-10-u02": "[softly]",
  "cut-10-u03": "[warm]",
  "cut-10-u04": "[thoughtful]",
};

// V25 directions describe the dramatic intention and semantic focus, not just
// a generic emotion.  This prevents a syntactically valid reading from implying
// the wrong relationship between clauses.  The bracketed directions are native
// Eleven v3 performance tags and are not part of the spoken script.
const semanticIntentByUtterance = {
  "cut-01-u01": "[calm reflective narration, one unhurried thought, gently emphasize 光]",
  "cut-01-u02": "[slow calm reflective narration, make けれど a clear contrast, take one natural breath, and lower slightly on 名前]",
  "cut-01-u03": "[quietly focused, speaking to himself, natural breath after なったな]",
  "cut-02-u01": "[measured warm narration, observational rather than dramatic, breathe after 写真店で]",
  "cut-02-u02": "[gentle and reassuring, contrast できません with 戻せます, finish with quiet confidence]",
  "cut-03-u01": "[soft nostalgic recognition, a faint smile, warmly emphasize 昔]",
  "cut-03-u02": "[genuinely surprised but controlled, first call her name, then trail off in disbelief]",
  "cut-03-u03": "[slow vulnerable and tired delivery, state the return plainly, take a natural breath, then reveal the deeper uncertainty more softly]",
  "cut-04-u01": "[hurt but composed, emphasize 私が撮った and 自分の作品, no melodrama]",
  "cut-04-u02": "[concerned and practical, one precise question, slight emphasis on 証明]",
  "cut-04-u03": "[ashamed sadness held in, a short breath between the facts and 信じていたから]",
  "cut-05-u01": "[cold controlling politeness, clipped certainty, progressively more possessive without shouting]",
  "cut-05-u02": "[firm disbelief and restrained anger, stress 彼女の作品 and あなたの名前]",
  "cut-05-u03": "[dismissive arrogance, matter of fact first sentence, contempt on 売れる側]",
  "cut-06-u01": "[steady resolve through pain, decisive on 戻らない, tender emphasis on 祖母の最後の夏]",
  "cut-06-u02": "[controlled intimidation, rhetorical first question, colder and slower on 居場所なんてない]",
  "cut-07-u01": "[calm decisive interruption, brief emphasis on ある, then present the evidence clearly]",
  "cut-07-u02": "[precise and confident, enumerate each piece of evidence evenly, no rushing]",
  "cut-07-u03": "[defensive contempt masking unease, challenge the evidence without shouting]",
  "cut-08-u01": "[newly determined, state the action first, then claim 私の名前 with grounded confidence]",
  "cut-08-u02": "[measured narrative transition, factual and restrained, one clean breath at the comma]",
  "cut-08-u03": "[quiet reflective narration, poetic but natural, gently land on 照らし返した]",
  "cut-09-u01": "[young and softly earnest, slow natural pace, make the request intimate and sincere, do not sound childish or singsong]",
  "cut-09-u02": "[young but dependable, immediate reassurance on 捨てない, warm promise after the breath]",
  "cut-09-u03": "[tender reflective narration, let 約束 lead naturally to 帰る道, hopeful ending]",
  "cut-10-u01": "[hopeful and slightly nervous, confirm the room first, then gather courage for the proposal]",
  "cut-10-u02": "[hesitant affection, the ellipsis is a deliberate breath before the confession, softly emphasize 隣]",
  "cut-10-u03": "[warm relief, welcome her home first, then offer a calm shared future without rushing]",
  "cut-10-u04": "[gentle closing narration, serene after rain, quietly hopeful final cadence]",
};

// Keep the provider-facing tags deliberately short.  Longer prose inside an
// audio tag can occasionally be vocalized by a generative model.  Semantic
// intent remains recorded separately above and is expressed through Japanese
// punctuation and clause structure below.
const v25PerformanceByUtterance = {
  "cut-01-u01": "[thoughtful]",
  "cut-01-u02": "[thoughtful]",
  "cut-01-u03": "[softly]",
  "cut-02-u01": "[thoughtful]",
  "cut-02-u02": "[warm]",
  "cut-03-u01": "[softly]",
  "cut-03-u02": "[surprised]",
  "cut-03-u03": "[sad]",
  "cut-04-u01": "[hurt]",
  "cut-04-u02": "[concerned]",
  "cut-04-u03": "[sad]",
  "cut-05-u01": "[cold]",
  "cut-05-u02": "[angry]",
  "cut-05-u03": "[sarcastic]",
  "cut-06-u01": "[determined]",
  "cut-06-u02": "[cold]",
  "cut-07-u01": "[confident]",
  "cut-07-u02": "[confident]",
  "cut-07-u03": "[nervous]",
  "cut-08-u01": "[determined]",
  "cut-08-u02": "[thoughtful]",
  "cut-08-u03": "[thoughtful]",
  "cut-09-u01": "[softly]",
  "cut-09-u02": "[warm]",
  "cut-09-u03": "[thoughtful]",
  "cut-10-u01": "[hopeful]",
  "cut-10-u02": "[softly]",
  "cut-10-u03": "[warm]",
  "cut-10-u04": "[thoughtful]",
};

const performanceByUtterance = isV25
  ? v25PerformanceByUtterance
  : v22PerformanceByUtterance;

const v22SpeechByUtterance = {
  "cut-01-u01": "しゃしんは、光がそこにあったことを証明する。",
  "cut-01-u02": "けれど、写した人の名前まで守ってくれるわけではない。",
  "cut-01-u03": "雨、強くなったな。閉店前に、このげんぞうだけ終わらせよう。",
  "cut-02-u01": "商店街の古い写真店で、/ɾeɴ/は色あせた家族しゃしんを、一枚ずつほしゅうしていた。",
  "cut-02-u02": "思い出は新品にできません。でも、もう一度見える形には戻せます。",
  "cut-03-u01": "その言い方、昔と変わらないね。",
  "cut-03-u02": "みおなのか？　東京にいるはずじゃ……。",
  "cut-03-u03": "帰ってきたの。行く場所はあるのに、帰りたい場所が分からなくなって……。",
  "cut-04-u01": "私が撮ったしゃしんを、恋人だったかみやさんが、自分の作品として発表したの。",
  "cut-04-u02": "元データか、撮影した日を証明できるものは？",
  "cut-04-u03": "全部向こうに預けたまま。信じていたから……。",
  "cut-05-u01": "れんらくを無視するから、迎えに来た。君は僕の助手だ。勝手に帰られると困る。",
  "cut-05-u02": "彼女の作品を、あなたの名前で出したんですか？",
  "cut-05-u03": "世に出したのは僕だ。名前なんて、売れる側のものだろう。",
  "cut-06-u01": "私は戻らない。あのしゃしんは、そぼの最後の夏を撮った、大切な記録なの。",
  "cut-06-u02": "かんじょうで仕事を失うつもりか？　この町に、君の居場所なんてない。",
  "cut-07-u01": "ある。みおが十年前に預けたネガです。",
  "cut-07-u02": "去年ふくせいしたデータも、さくせい日時も、いらい票も残っています。",
  "cut-07-u03": "そんな古い記録が、何になる。",
  "cut-08-u01": "てんじのしゅさいしゃへ送る。さつえいしゃが誰か、私の名前で確かめてもらう。",
  "cut-08-u02": "翌週、てんじは中止され、かみやとの契約も解除された。",
  "cut-08-u03": "彼が借りた光は、彼自身を照らし返した。",
  "cut-09-u01": "私が遠くに行っても、しゃしんを捨てないでね。",
  "cut-09-u02": "捨てない。いつか帰ってきたら、ちゃんと返す。",
  "cut-09-u03": "子供の約束は未来を縛らず、帰る道に小さな灯りを残すことがある。",
  "cut-10-u01": "店の二階、空いてるよね。ここで、しゃしんスタジオを始めたい。",
  "cut-10-u02": "それから……今度は、/ɾeɴ/の隣にいたい。",
  "cut-10-u03": "おかえり。仕事も、その先も、ゆっくり一緒に決めよう。",
  "cut-10-u04": "雨上がりの商店街で、二人の新しい一枚目が、静かにしゃしんになっていった。",
};

const speechByUtterance = isV25 ? {
  ...v22SpeechByUtterance,
  "cut-01-u02": "けれど……写した人の名前まで、守ってくれるわけではない。",
  "cut-02-u01": "商店街の古い写真店で、れんは、色あせた家族しゃしんを、一枚ずつほしゅうしていた。",
  "cut-02-u02": "思い出は、新品にはできません。でも……もう一度見える形には、戻せます。",
  "cut-03-u02": "みおなのか？……東京にいるはずじゃ……。",
  "cut-03-u03": "帰ってきたの。行く場所はあるのに……帰りたい場所が、分からなくなって……。",
  "cut-04-u01": "私が撮ったしゃしんを、恋人だったかみやさんが……自分の作品として発表したの。",
  "cut-04-u03": "全部、向こうに預けたまま。……信じていたから。",
  "cut-05-u01": "れんらくを無視するから、迎えに来た。君は、僕の助手だ。勝手に帰られると困る。",
  "cut-05-u02": "彼女の作品を……あなたの名前で出したんですか？",
  "cut-06-u01": "私は、戻らない。あのしゃしんは、そぼの最後の夏を撮った……大切な記録なの。",
  "cut-06-u02": "かんじょうで、仕事を失うつもりか？……この町に、君の居場所なんてない。",
  "cut-07-u01": "ある。……みおが十年前に預けたネガです。",
  "cut-07-u02": "去年ふくせいしたデータも、さくせい日時も、いらい票も……残っています。",
  "cut-08-u01": "てんじのしゅさいしゃへ送る。さつえいしゃが誰か……私の名前で確かめてもらう。",
  "cut-09-u01": "私が遠くに行っても……しゃしんを捨てないでね。",
  "cut-09-u02": "捨てない。……いつか帰ってきたら、ちゃんと返す。",
  "cut-10-u01": "店の二階、空いてるよね。……ここで、しゃしんスタジオを始めたい。",
  "cut-10-u02": "それから……今度は、れんの隣にいたい。",
  "cut-10-u03": "おかえり。……仕事も、その先も、ゆっくり一緒に決めよう。",
} : v22SpeechByUtterance;

// These pauses are editorial beats, not a single global delay. Fast
// confrontations answer in 140-180 ms, normal replies in 210-300 ms, and only
// genuine emotional/temporal turns receive a longer 300-400 ms breath.
const v22PauseBeforeByUtterance = {
  "cut-01-u02": 0.16,
  "cut-01-u03": 0.28,
  "cut-02-u02": 0.26,
  "cut-03-u02": 0.16,
  "cut-03-u03": 0.22,
  "cut-04-u02": 0.24,
  "cut-04-u03": 0.23,
  "cut-05-u02": 0.14,
  "cut-05-u03": 0.14,
  "cut-06-u02": 0.16,
  "cut-07-u02": 0.13,
  "cut-07-u03": 0.17,
  "cut-08-u02": 0.40,
  "cut-08-u03": 0.17,
  "cut-09-u02": 0.21,
  "cut-09-u03": 0.30,
  "cut-10-u02": 0.27,
  "cut-10-u03": 0.34,
  "cut-10-u04": 0.30,
};

// These are desired *audible speech-to-speech* gaps.  V25 subtracts the safe
// head/tail padding embedded in the split WAVs before writing the actual edit
// gap, so the listener hears these values rather than a doubled pause.
const v25AudibleGapBeforeByUtterance = {
  "cut-01-u02": 0.18,
  "cut-01-u03": 0.32,
  "cut-02-u02": 0.24,
  "cut-03-u02": 0.18,
  "cut-03-u03": 0.26,
  "cut-04-u02": 0.25,
  "cut-04-u03": 0.28,
  "cut-05-u02": 0.16,
  "cut-05-u03": 0.18,
  "cut-06-u02": 0.19,
  "cut-07-u02": 0.16,
  "cut-07-u03": 0.18,
  "cut-08-u02": 0.38,
  "cut-08-u03": 0.20,
  "cut-09-u02": 0.23,
  "cut-09-u03": 0.34,
  "cut-10-u02": 0.32,
  "cut-10-u03": 0.36,
  "cut-10-u04": 0.32,
};

const pauseBeforeByUtterance = isV25
  ? v25AudibleGapBeforeByUtterance
  : v22PauseBeforeByUtterance;

const pauseClassByUtterance = {
  "cut-08-u02": "emphasis",
  "cut-09-u03": "reflection",
  "cut-10-u02": "hesitation",
  "cut-10-u03": "emotional-response",
  "cut-10-u04": "reflection",
};

// Eleven v3 is allowed to perform each line freely, but a few generations
// contain multi-second punctuation holds. Those feel like broken edits once
// the lines are assembled. We only shorten literal digital silence; voiced
// audio is never time-stretched, pitch-shifted, denoised, or re-synthesized.
const internalSilenceCapByPrompt = {
  "[thoughtful]": 0.68,
  "[softly]": 0.80,
  "[warm]": 0.68,
  "[surprised]": 0.60,
  "[sad]": 0.85,
  "[hurt]": 0.75,
  "[concerned]": 0.60,
  "[cold]": 0.55,
  "[angry]": 0.50,
  "[sarcastic]": 0.55,
  "[confident]": 0.45,
  "[nervous]": 0.65,
  "[determined]": 0.55,
  "[hopeful]": 0.60,
};

const internalSilenceCapByUtterance = {
  // The written hesitation is intentional; keep a longer but still natural beat.
  "cut-10-u02": 0.95,
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function jsonFromFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function ffprobeDuration(filePath) {
  const { stdout } = await execFile("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "json", filePath,
  ]);
  return Number(JSON.parse(stdout).format.duration);
}

async function detectAcousticSpeechBounds(filePath) {
  const { stdout } = await execFile("ffmpeg", [
    "-v", "error", "-i", filePath,
    "-vn", "-ar", "48000", "-ac", "1", "-f", "f32le", "-",
  ], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
  const samples = new Float32Array(
    stdout.buffer,
    stdout.byteOffset,
    Math.floor(stdout.byteLength / Float32Array.BYTES_PER_ELEMENT),
  );
  const sampleRate = 48_000;
  const windowSamples = Math.round(sampleRate * 0.005);
  const active = [];
  for (let start = 0; start < samples.length; start += windowSamples) {
    const end = Math.min(samples.length, start + windowSamples);
    let sumSquares = 0;
    let peak = 0;
    for (let index = start; index < end; index += 1) {
      const value = Math.abs(samples[index]);
      sumSquares += value * value;
      peak = Math.max(peak, value);
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, end - start));
    active.push(rms >= 0.001 || peak >= 0.008);
  }
  const minimumRun = 3;
  let firstWindow = -1;
  let lastWindow = -1;
  for (let index = 0; index <= active.length - minimumRun; index += 1) {
    if (active.slice(index, index + minimumRun).every(Boolean)) {
      firstWindow = index;
      break;
    }
  }
  for (let index = active.length - minimumRun; index >= 0; index -= 1) {
    if (active.slice(index, index + minimumRun).every(Boolean)) {
      lastWindow = index + minimumRun;
      break;
    }
  }
  const durationSeconds = samples.length / sampleRate;
  if (firstWindow < 0 || lastWindow <= firstWindow) {
    throw new Error(`No sustained speech energy detected in ${filePath}`);
  }
  return {
    startSeconds: firstWindow * windowSamples / sampleRate,
    endSeconds: Math.min(durationSeconds, lastWindow * windowSamples / sampleRate),
    durationSeconds,
    detector: {
      sampleRate,
      windowMilliseconds: 5,
      minimumSustainedMilliseconds: minimumRun * 5,
      rmsThreshold: 0.001,
      peakThreshold: 0.008,
    },
  };
}

async function loudnessNormalizeLine(inputPath, outputPath) {
  const targetI = -19;
  const targetLra = 7;
  const targetTp = -2;
  const { stderr } = await execFile("ffmpeg", [
    "-hide_banner", "-nostats", "-i", inputPath,
    "-af", "loudnorm=I=" + targetI + ":LRA=" + targetLra + ":TP=" + targetTp + ":print_format=json",
    "-f", "null", "-",
  ]);
  const jsonMatch = stderr.match(/\{[\s\S]*?\}/gu)?.at(-1);
  if (!jsonMatch) throw new Error("Could not measure loudness for " + inputPath);
  const measured = JSON.parse(jsonMatch);
  const filter = [
    "loudnorm=I=" + targetI,
    "LRA=" + targetLra,
    "TP=" + targetTp,
    "measured_I=" + measured.input_i,
    "measured_LRA=" + measured.input_lra,
    "measured_TP=" + measured.input_tp,
    "measured_thresh=" + measured.input_thresh,
    "offset=" + measured.target_offset,
    "linear=true",
    "print_format=summary",
  ].join(":");
  await execFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
    "-af", filter,
    "-ar", "48000", "-ac", "1", "-c:a", "pcm_s24le",
    outputPath,
  ]);
}

async function compactLiteralSilence(inputPath, outputPath, maximumPauseSeconds) {
  let stderr = "";
  try {
    ({ stderr } = await execFile("ffmpeg", [
      "-hide_banner", "-nostats", "-i", inputPath,
      "-af", "silencedetect=noise=-42dB:d=0.35",
      "-f", "null", "-",
    ]));
  } catch (error) {
    stderr = String(error?.stderr || "");
  }
  const starts = [...stderr.matchAll(/silence_start: ([0-9.]+)/gu)].map((match) => Number(match[1]));
  const endings = [...stderr.matchAll(/silence_end: ([0-9.]+) \| silence_duration: ([0-9.]+)/gu)]
    .map((match) => ({ end: Number(match[1]), duration: Number(match[2]) }));
  const durationSeconds = await ffprobeDuration(inputPath);
  const edits = endings.map((ending, index) => ({
    start: starts[index],
    end: ending.end,
    duration: ending.duration,
  })).filter((silence) => (
    Number.isFinite(silence.start)
    && silence.start > 0.06
    && silence.end < durationSeconds - 0.06
    && silence.duration > maximumPauseSeconds + 0.04
  ));
  if (edits.length === 0) {
    await execFile("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
      "-ar", "48000", "-ac", "1", "-c:a", "pcm_s24le", outputPath,
    ]);
    return { edits: [], durationBeforeSeconds: durationSeconds, durationAfterSeconds: durationSeconds };
  }

  const segments = [];
  let cursor = 0;
  for (const silence of edits) {
    if (silence.start > cursor) segments.push({ start: cursor, end: silence.start });
    // Retain the final part of the quiet interval immediately before the next
    // phrase, so the resulting beat is exactly the requested natural pause.
    cursor = silence.end - maximumPauseSeconds;
  }
  if (cursor < durationSeconds) segments.push({ start: cursor, end: durationSeconds });
  const chains = segments.map((segment, index) => (
    `[0:a]atrim=start=${segment.start.toFixed(6)}:end=${segment.end.toFixed(6)},`
      + `asetpts=PTS-STARTPTS[a${index}]`
  ));
  const inputs = segments.map((_, index) => `[a${index}]`).join("");
  const filter = chains.join(";") + `;${inputs}concat=n=${segments.length}:v=0:a=1[out]`;
  await execFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
    "-filter_complex", filter, "-map", "[out]",
    "-ar", "48000", "-ac", "1", "-c:a", "pcm_s24le", outputPath,
  ]);
  return {
    edits: edits.map((silence) => ({
      ...silence,
      retainedSeconds: maximumPauseSeconds,
      removedSeconds: silence.duration - maximumPauseSeconds,
    })),
    durationBeforeSeconds: durationSeconds,
    durationAfterSeconds: await ffprobeDuration(outputPath),
  };
}

function spokenCharacterCount(value) {
  return [...String(value || "").replace(/[\s\u3000、。！？!?…・「」『』,.—―:：/]/gu, "")].length;
}

const targetCpsByUtterance = {
  "cut-03-u03": 4.8,
  "cut-04-u03": 4.7,
  "cut-05-u01": 5.8,
  "cut-05-u02": 5.8,
  "cut-05-u03": 5.7,
  "cut-06-u01": 5.2,
  "cut-06-u02": 5.5,
  "cut-07-u02": 5.8,
  "cut-08-u01": 5.4,
  "cut-09-u01": 5.0,
  "cut-09-u02": 5.1,
  "cut-10-u02": 4.4,
  "cut-10-u03": 4.9,
  "cut-10-u04": 5.0,
};

function scoreDialogueCandidate(metadata, utterances) {
  const bounds = utterances.map((_, index) => boundsForInput(metadata, index));
  const rows = [];
  let score = 0;
  for (const [index, utterance] of utterances.entries()) {
    const current = bounds[index];
    const duration = current.endSeconds - current.startSeconds;
    const cps = spokenCharacterCount(speechByUtterance[utterance.id]) / Math.max(0.001, duration);
    const targetCps = targetCpsByUtterance[utterance.id] ?? 5.4;
    const cpsError = Math.abs(cps - targetCps) / targetCps;
    const headRoom = current.startSeconds - (index === 0 ? 0 : bounds[index - 1].endSeconds);
    const tailRoom = (bounds[index + 1]?.startSeconds ?? metadata.sourceDurationSeconds) - current.endSeconds;
    const edgePenalty = (headRoom < 0.12 ? (0.12 - headRoom) * 8 : 0)
      + (tailRoom < 0.08 ? (0.08 - tailRoom) * 8 : 0);
    const pacePenalty = cps < 3.2 ? (3.2 - cps) * 1.4 : cps > 8.2 ? (cps - 8.2) * 1.4 : 0;
    const durationPenalty = duration < 0.45 ? (0.45 - duration) * 4 : 0;
    const rowScore = cpsError + edgePenalty + pacePenalty + durationPenalty;
    score += rowScore;
    rows.push({
      utteranceId: utterance.id,
      speechDurationSeconds: Number(duration.toFixed(4)),
      charactersPerSecond: Number(cps.toFixed(3)),
      targetCharactersPerSecond: targetCps,
      availableHeadRoomSeconds: Number(headRoom.toFixed(4)),
      availableTailRoomSeconds: Number(tailRoom.toFixed(4)),
      score: Number(rowScore.toFixed(5)),
    });
  }
  return { score: Number(score.toFixed(6)), rows };
}

async function generateCutDialogueTake(cut, utterances, takeIndex) {
  // R63 (supersedes the R60 intent experiment, user-rejected as
  // over-directed): a narration line is the protagonist simply talking, the
  // same as any ordinary bubble line — no narration-specific direction of
  // any kind. Plain speech text only; ordinary dialogue lines keep the
  // short tags that produced their approved takes.
  const inputs = utterances.map((utterance) => ({
    text: utterance.preset === "narration" && isV25
      ? speechByUtterance[utterance.id]
      : performanceByUtterance[utterance.id] + " " + speechByUtterance[utterance.id],
    voice_id: utterance.voiceId,
  }));
  if (inputs.some((input) => !input.voice_id || !input.text.trim())) {
    throw new Error(`Missing ${pipelineVersion.toUpperCase()} voice or text in ${cut.id}`);
  }
  const cutNumber = Number(cut.id.replace(/\D/gu, ""));
  const stability = isV25
    ? takeIndex === 0 ? 0.46 : takeIndex === 1 ? 0.52 : 0.49
    : 0.5;
  const body = {
    inputs,
    model_id: "eleven_v3",
    language_code: "ja",
    settings: { stability },
    seed: isV25 ? 250000 + cutNumber * 10 + takeIndex : 220000 + cutNumber,
    apply_text_normalization: "auto",
  };
  const inputHash = sha256(JSON.stringify(body));
  const inputDigest = createHash("sha256").update(JSON.stringify(inputs.map((input) => [input.voice_id, input.text]))).digest("hex").slice(0, 8);
  // Take files are content-addressed by input digest so a later regeneration
  // can never overwrite an approved take (R60 invariant).
  const takeSuffix = isV25 ? `-take-${takeIndex + 1}-${inputDigest}` : "";
  const sourcePath = join(sourceDir, cut.id + takeSuffix + "-eleven-v3-dialogue.wav");
  const metadataPath = join(sourceDir, cut.id + takeSuffix + "-eleven-v3-dialogue.json");
  const cached = await jsonFromFile(metadataPath);
  if (cached?.inputHash === inputHash) {
    try {
      await stat(sourcePath);
      return { ...cached, sourcePath, metadataPath, reused: true };
    } catch {}
  }
  const apiKey = await requireElevenLabsApiKey();
  let response;
  let payload;
  let outputFormat = isV25 ? "wav_44100" : "wav_24000";
  for (const candidateFormat of isV25 ? ["wav_44100", "wav_24000"] : ["wav_24000"]) {
    const url = new URL("https://api.elevenlabs.io/v1/text-to-dialogue/with-timestamps");
    url.searchParams.set("output_format", candidateFormat);
    url.searchParams.set("enable_logging", "true");
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "xi-api-key": apiKey },
      body: JSON.stringify(body),
    });
    payload = await response.json().catch(() => null);
    if (response.ok) {
      outputFormat = candidateFormat;
      break;
    }
    const formatTierRejection = response.status === 403
      && JSON.stringify(payload || {}).includes("Output format")
      && JSON.stringify(payload || {}).includes("Pro tier");
    if (!([400, 422].includes(response.status) || formatTierRejection) || candidateFormat === "wav_24000") break;
  }
  if (!response?.ok) {
    const detail = payload?.detail?.message || payload?.detail || payload?.message || response?.statusText;
    throw new Error(
      `ElevenLabs dialogue generation failed for ${cut.id} take ${takeIndex + 1} (${response?.status}): `
      + (typeof detail === "string" ? detail : JSON.stringify(detail)),
    );
  }
  const audioBase64 = String(payload?.audio_base64 || "");
  const voiceSegments = Array.isArray(payload?.voice_segments) ? payload.voice_segments : [];
  if (!audioBase64 || voiceSegments.length < utterances.length) {
    throw new Error("Incomplete dialogue response for " + cut.id);
  }
  const audioBuffer = Buffer.from(audioBase64, "base64");
  await writeFile(sourcePath, audioBuffer);
  const sourceDurationSeconds = await ffprobeDuration(sourcePath);
  const metadata = {
    version: isV25 ? 2 : 1,
    cutId: cut.id,
    takeIndex,
    inputHash,
    model: "eleven_v3",
    languageCode: "ja",
    seed: body.seed,
    stability,
    outputFormat,
    requestId: response.headers.get("request-id") || response.headers.get("x-request-id") || "",
    characterCost: Number(response.headers.get("character-cost")) || null,
    sourcePath,
    sourceDurationSeconds,
    inputs,
    voiceSegments,
    alignment: payload?.normalized_alignment || payload?.alignment || null,
    createdAt: new Date().toISOString(),
  };
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + "\n", "utf8");
  return { ...metadata, metadataPath, reused: false };
}

async function generateCutDialogue(cut, utterances) {
  const candidates = [];
  const takeCount = isV25 ? requestedTakeCount : 1;
  for (let takeIndex = 0; takeIndex < takeCount; takeIndex += 1) {
    const metadata = await generateCutDialogueTake(cut, utterances, takeIndex);
    const quality = scoreDialogueCandidate(metadata, utterances);
    candidates.push({ ...metadata, quality });
  }
  candidates.sort((left, right) => left.quality.score - right.quality.score);
  // Deterministic override for editorial take choice (e.g. prosody-range
  // fit judged outside the technical scorer): MANGA_DIALOGUE_FORCE_TAKE=
  // '{"cut-08":1}' selects takeIndex 1 for that cut. Recorded in metadata.
  let forced = null;
  try {
    forced = JSON.parse(process.env.MANGA_DIALOGUE_FORCE_TAKE || "null");
  } catch {}
  const forcedIndex = forced && Number.isInteger(forced[cut.id]) ? forced[cut.id] : null;
  const selected = forcedIndex !== null
    ? (candidates.find((candidate) => candidate.takeIndex === forcedIndex) ?? candidates[0])
    : candidates[0];
  return {
    ...selected,
    candidateSelection: {
      method: "alignment-completeness-edge-room-and-scene-paced-cps",
      selectedTakeIndex: selected.takeIndex,
      candidates: candidates.map((candidate) => ({
        takeIndex: candidate.takeIndex,
        sourcePath: candidate.sourcePath,
        requestId: candidate.requestId,
        reused: candidate.reused,
        stability: candidate.stability,
        outputFormat: candidate.outputFormat,
        quality: candidate.quality,
      })),
    },
  };
}

function boundsForInput(metadata, inputIndex) {
  const matching = metadata.voiceSegments.filter(
    (segment) => Number(segment.dialogue_input_index) === inputIndex,
  );
  if (matching.length === 0) throw new Error(
    "No dialogue voice segment for " + metadata.cutId + " input " + inputIndex,
  );
  const segmentStartSeconds = Math.min(...matching.map((segment) => Number(segment.start_time_seconds)));
  const segmentEndSeconds = Math.max(...matching.map((segment) => Number(segment.end_time_seconds)));
  const characterStartIndex = Math.min(...matching.map((segment) => Number(segment.character_start_index)));
  const characterEndIndex = Math.max(...matching.map((segment) => Number(segment.character_end_index)));
  const inputText = String(metadata.inputs?.[inputIndex]?.text || "");
  const tagEndIndex = inputText.indexOf("]");
  const spokenOffset = tagEndIndex >= 0 ? tagEndIndex + 1 : 0;
  const characters = metadata.alignment?.characters || [];
  const starts = metadata.alignment?.character_start_times_seconds || [];
  const ends = metadata.alignment?.character_end_times_seconds || [];
  let firstSpokenIndex = characterStartIndex + spokenOffset;
  while (firstSpokenIndex < characterEndIndex && /\s/u.test(String(characters[firstSpokenIndex] || ""))) {
    firstSpokenIndex += 1;
  }
  let lastSpokenIndex = characterEndIndex - 1;
  // Terminal punctuation often owns the entire dramatic pause in ElevenLabs'
  // character alignment. The pause is authored explicitly in the edit, so it
  // must not also be baked into the line asset.
  while (
    lastSpokenIndex >= firstSpokenIndex
    && /[\s。、，．！？!?…・]/u.test(String(characters[lastSpokenIndex] || ""))
  ) {
    lastSpokenIndex -= 1;
  }
  const spokenStartSeconds = Number(starts[firstSpokenIndex]);
  const spokenEndSeconds = Number(ends[lastSpokenIndex]);
  if (Number.isFinite(spokenStartSeconds) && Number.isFinite(spokenEndSeconds) && spokenEndSeconds > spokenStartSeconds) {
    return {
      startSeconds: spokenStartSeconds,
      endSeconds: spokenEndSeconds,
      segmentStartSeconds,
      segmentEndSeconds,
      firstSpokenIndex,
      lastSpokenIndex,
      characterStartIndex,
      characterEndIndex,
    };
  }
  return {
    startSeconds: segmentStartSeconds,
    endSeconds: segmentEndSeconds,
    segmentStartSeconds,
    segmentEndSeconds,
    firstSpokenIndex: characterStartIndex,
    lastSpokenIndex: Math.max(characterStartIndex, characterEndIndex - 1),
    characterStartIndex,
    characterEndIndex,
  };
}

function mapTrimmedSourceOffset(rawOffsetSeconds, silenceCompaction) {
  let mapped = rawOffsetSeconds;
  for (const edit of silenceCompaction.edits || []) {
    const start = Number(edit.start);
    const removed = Number(edit.removedSeconds) || 0;
    const removedEnd = start + removed;
    if (rawOffsetSeconds >= removedEnd) mapped -= removed;
    else if (rawOffsetSeconds > start) mapped -= rawOffsetSeconds - start;
  }
  return Math.max(0, mapped);
}

function firstSentenceBoundaryOffset(metadata, bounds, trimStart, silenceCompaction) {
  const characters = metadata.alignment?.characters || [];
  const starts = metadata.alignment?.character_start_times_seconds || [];
  const ends = metadata.alignment?.character_end_times_seconds || [];
  let stopIndex = -1;
  for (let index = bounds.firstSpokenIndex; index <= bounds.lastSpokenIndex; index += 1) {
    if (/[。！？!?]/u.test(String(characters[index] || ""))) {
      stopIndex = index;
      break;
    }
  }
  if (stopIndex < 0) return null;
  let previousIndex = stopIndex - 1;
  while (previousIndex >= bounds.firstSpokenIndex && /[\s。、，．！？!?…・]/u.test(String(characters[previousIndex] || ""))) {
    previousIndex -= 1;
  }
  let nextIndex = stopIndex + 1;
  while (nextIndex <= bounds.lastSpokenIndex && /[\s。、，．！？!?…・]/u.test(String(characters[nextIndex] || ""))) {
    nextIndex += 1;
  }
  const left = Number(ends[previousIndex]);
  const right = Number(starts[nextIndex]);
  if (!Number.isFinite(left)) return null;
  const sourceBoundary = Number.isFinite(right) && right > left ? (left + right) / 2 : left;
  return mapTrimmedSourceOffset(sourceBoundary - trimStart, silenceCompaction);
}

async function splitUtteranceAudio(cut, utterances, metadata) {
  const bounds = utterances.map((_, index) => boundsForInput(metadata, index));
  const rows = [];
  for (let index = 0; index < utterances.length; index += 1) {
    const utterance = utterances[index];
    const current = bounds[index];
    const previous = bounds[index - 1] || null;
    const next = bounds[index + 1] || null;
    const measuredGapBeforeSeconds = previous
      ? Math.max(0, current.startSeconds - previous.endSeconds)
      : 0;
    const measuredGapAfterSeconds = next
      ? Math.max(0, next.startSeconds - current.endSeconds)
      : Math.max(0, metadata.sourceDurationSeconds - current.endSeconds);
    const previousSpeechBoundary = previous
      ? (previous.endSeconds + current.startSeconds) / 2
      : 0;
    const nextSpeechBoundary = next
      ? (current.endSeconds + next.startSeconds) / 2
      : metadata.sourceDurationSeconds;
    const desiredSafePadding = isV25 ? 0.45 : 0.08;
    const trimStart = isV25
      ? Math.max(0, previousSpeechBoundary, current.startSeconds - desiredSafePadding)
      : Math.max(0, current.startSeconds - Math.min(0.012, measuredGapBeforeSeconds * 0.25));
    const trimEnd = isV25
      ? Math.min(metadata.sourceDurationSeconds, nextSpeechBoundary, current.endSeconds + desiredSafePadding)
      : Math.min(
        metadata.sourceDurationSeconds,
        current.endSeconds + Math.min(0.024, measuredGapAfterSeconds * 0.25),
      );
    const sourceHeadPaddingSeconds = Math.max(0, current.startSeconds - trimStart);
    const sourceTailPaddingSeconds = Math.max(0, trimEnd - current.endSeconds);
    const syntheticTailPaddingSeconds = isV25
      ? Math.max(0, desiredSafePadding - sourceTailPaddingSeconds) + 0.15
      : 0;
    const trimDuration = trimEnd - trimStart;
    if (!(trimDuration > 0.1)) throw new Error("Invalid trim duration for " + utterance.id);
    if (isV25 && sourceHeadPaddingSeconds < 0.12 && previous) {
      // A mid-take slice with no head room risks cutting the consonant
      // attack. The FIRST line of a take has nothing before it: the take
      // simply starts on the phrase, and the acoustic stage below prepends
      // synthetic head padding — so index 0 is exempt (R63: untagged inputs
      // legitimately start speaking immediately).
      throw new Error(`${utterance.id} has only ${sourceHeadPaddingSeconds.toFixed(4)}s broad onset window`);
    }
    if (isV25 && sourceTailPaddingSeconds + syntheticTailPaddingSeconds < 0.12) {
      throw new Error(`${utterance.id} has insufficient release margin`);
    }
    const fileName = manifest.id + "-" + utterance.id + `-${pipelineVersion}-elevenlabs-dialogue.wav`;
    const filePath = join(assetsDir, fileName);
    const sourceRawFilePath = filePath + ".source-raw.wav";
    const safeRawFilePath = filePath + ".acoustic-safe.wav";
    const compactFilePath = filePath + ".compact.wav";
    const rawFilePath = filePath + ".split-raw.wav";
    const sourceFilters = [
      "aresample=48000",
      `atrim=duration=${trimDuration.toFixed(6)}`,
      "asetpts=PTS-STARTPTS",
    ];
    if (syntheticTailPaddingSeconds > 0.0005) {
      sourceFilters.push(`apad=pad_dur=${syntheticTailPaddingSeconds.toFixed(6)}`);
    }
    await execFile("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", trimStart.toFixed(6),
      "-i", metadata.sourcePath,
      "-vn",
      "-af", sourceFilters.join(","),
      "-ar", "48000", "-ac", "1", "-c:a", "pcm_s24le",
      sourceRawFilePath,
    ]);
    const acousticBounds = isV25
      ? await detectAcousticSpeechBounds(sourceRawFilePath)
      : {
        startSeconds: Math.max(0, current.startSeconds - trimStart),
        endSeconds: Math.max(0, current.endSeconds - trimStart),
        durationSeconds: await ffprobeDuration(sourceRawFilePath),
        detector: null,
      };
    // R61: guarantee a wider onset-safe head margin so no consonant attack can
// ever be shaved by the acoustic trim (user-reported perceived head clipping).
const acousticSafetyPaddingSeconds = isV25 ? 0.1 : 0;
    const acousticTrimStartSeconds = isV25
      ? Math.max(0, acousticBounds.startSeconds - acousticSafetyPaddingSeconds)
      : 0;
    const acousticTrimEndSeconds = isV25
      ? Math.min(
        acousticBounds.durationSeconds,
        acousticBounds.endSeconds + acousticSafetyPaddingSeconds,
      )
      : acousticBounds.durationSeconds;
    const acousticTrimDurationSeconds = acousticTrimEndSeconds - acousticTrimStartSeconds;
    const syntheticHeadPaddingSeconds = isV25
      ? Math.max(
        0,
        acousticSafetyPaddingSeconds - (acousticBounds.startSeconds - acousticTrimStartSeconds),
      )
      : 0;
    if (isV25) {
      const acousticFilters = [
        `atrim=duration=${acousticTrimDurationSeconds.toFixed(6)}`,
        "asetpts=PTS-STARTPTS",
      ];
      if (syntheticHeadPaddingSeconds > 0.0005) {
        acousticFilters.push(`adelay=${Math.round(syntheticHeadPaddingSeconds * 1000)}:all=1`);
      }
      await execFile("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-ss", acousticTrimStartSeconds.toFixed(6),
        "-i", sourceRawFilePath,
        "-af", acousticFilters.join(","),
        "-ar", "48000", "-ac", "1", "-c:a", "pcm_s24le",
        safeRawFilePath,
      ]);
    }
    const preCompactionPath = isV25 ? safeRawFilePath : sourceRawFilePath;
    const maximumInternalPauseSeconds = internalSilenceCapByUtterance[utterance.id]
      ?? internalSilenceCapByPrompt[performanceByUtterance[utterance.id]]
      ?? 0.68;
    const silenceCompaction = await compactLiteralSilence(
      preCompactionPath,
      compactFilePath,
      maximumInternalPauseSeconds,
    );
    const compactDuration = await ffprobeDuration(compactFilePath);
    const rawSpeechStartSeconds = Math.max(
      0,
      acousticBounds.startSeconds - acousticTrimStartSeconds + syntheticHeadPaddingSeconds,
    );
    const rawSpeechEndSeconds = Math.max(
      rawSpeechStartSeconds,
      acousticBounds.endSeconds - acousticTrimStartSeconds + syntheticHeadPaddingSeconds,
    );
    const removedBeforeSpeechEndSeconds = (silenceCompaction.edits || [])
      .filter((edit) => Number(edit.end) <= rawSpeechEndSeconds + 0.001)
      .reduce((sum, edit) => sum + Math.max(0, Number(edit.removedSeconds) || 0), 0);
    const speechStartSeconds = rawSpeechStartSeconds;
    const speechEndSeconds = Math.min(
      compactDuration,
      Math.max(speechStartSeconds, rawSpeechEndSeconds - removedBeforeSpeechEndSeconds),
    );
    const outputTailPaddingSeconds = Math.max(0, compactDuration - speechEndSeconds);
    if (isV25 && speechStartSeconds < 0.055) {
      throw new Error(`${utterance.id} acoustic onset margin is only ${speechStartSeconds.toFixed(4)}s`);
    }
    if (isV25 && outputTailPaddingSeconds < 0.045) {
      throw new Error(`${utterance.id} acoustic release margin is only ${outputTailPaddingSeconds.toFixed(4)}s`);
    }
    const fadeIn = isV25
      ? Math.min(0.006, speechStartSeconds * 0.45)
      : Math.min(0.012, compactDuration / 8);
    const fadeOut = isV25
      ? Math.min(0.008, outputTailPaddingSeconds * 0.45)
      : Math.min(0.018, compactDuration / 8);
    const fadeOutStart = Math.max(0, compactDuration - fadeOut);
    const edgeFilters = [];
    if (fadeIn > 0.0005) edgeFilters.push(`afade=t=in:st=0:d=${fadeIn.toFixed(6)}`);
    if (fadeOut > 0.0005) edgeFilters.push(`afade=t=out:st=${fadeOutStart.toFixed(6)}:d=${fadeOut.toFixed(6)}`);
    await execFile("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-i", compactFilePath,
      ...(edgeFilters.length ? ["-af", edgeFilters.join(",")] : []),
      "-ar", "48000", "-ac", "1", "-c:a", "pcm_s24le", rawFilePath,
    ]);
    await loudnessNormalizeLine(rawFilePath, filePath);
    await unlink(sourceRawFilePath);
    if (isV25) await unlink(safeRawFilePath);
    await unlink(compactFilePath);
    await unlink(rawFilePath);
    const durationSeconds = await ffprobeDuration(filePath);
    const previousRow = rows.at(-1) || null;
    const targetAudibleGapBeforeSeconds = isV25
      ? Number(v25AudibleGapBeforeByUtterance[utterance.id] ?? 0)
      : Number(pauseBeforeByUtterance[utterance.id] ?? 0);
    const embeddedPaddingGapSeconds = previousRow
      ? Math.max(0, previousRow.durationSeconds - previousRow.speechEndSeconds) + speechStartSeconds
      : 0;
    const authoredGapBeforeSeconds = previousRow && isV25
      ? Math.max(-0.25, targetAudibleGapBeforeSeconds - embeddedPaddingGapSeconds)
      : Number(pauseBeforeByUtterance[utterance.id] ?? 0);
    let bubbleSegmentBoundarySeconds = null;
    if (isV25 && Array.isArray(utterance.bubbleSegments) && utterance.bubbleSegments.length === 2) {
      bubbleSegmentBoundarySeconds = firstSentenceBoundaryOffset(
        metadata,
        current,
        trimStart + acousticTrimStartSeconds,
        silenceCompaction,
      );
      if (Number.isFinite(bubbleSegmentBoundarySeconds)) {
        bubbleSegmentBoundarySeconds += syntheticHeadPaddingSeconds;
      }
      if (Number.isFinite(bubbleSegmentBoundarySeconds)) {
        const clearHalfGapSeconds = 0.04;
        const firstEnd = Math.max(
          speechStartSeconds + 0.18,
          bubbleSegmentBoundarySeconds - clearHalfGapSeconds,
        );
        const secondStart = Math.min(
          speechEndSeconds - 0.18,
          bubbleSegmentBoundarySeconds + clearHalfGapSeconds,
        );
        utterance.bubbleSegments[0].startOffsetSeconds = -0.08;
        utterance.bubbleSegments[0].endOffsetSeconds = Number(firstEnd.toFixed(4));
        utterance.bubbleSegments[1].startOffsetSeconds = Number(secondStart.toFixed(4));
        utterance.bubbleSegments[1].endOffsetSeconds = Number((durationSeconds + 0.18).toFixed(4));
      }
    }
    const sidecar = {
      version: isV25 ? 5 : 4,
      utteranceId: utterance.id,
      provider: "elevenlabs",
      generationMode: "text-to-dialogue-with-timestamps",
      model: "eleven_v3",
      voiceId: utterance.voiceId,
      voiceName: utterance.voiceName,
      text: utterance.text,
      displayText: utterance.text,
      speechText: speechByUtterance[utterance.id],
      // Record the exact provider input. V41 changed narration to ordinary
      // untagged dialogue, but the old derived fields kept claiming that a
      // [thoughtful] tag was sent. That made the manifest impossible to audit.
      providerText: String(metadata.inputs?.[index]?.text || speechByUtterance[utterance.id]),
      performancePrompt: utterance.preset === "narration" && isV25
        ? ""
        : performanceByUtterance[utterance.id],
      durationSeconds,
      speechStartSeconds,
      speechEndSeconds,
      outputFormat: "wav_48000_pcm_s24le_loudnorm_two_pass",
      sourceDialoguePath: metadata.sourcePath,
      sourceDialogueMetadataPath: metadata.metadataPath,
      sourceDialogueRequestId: metadata.requestId,
      dialogueInputIndex: index,
      dialogueSourceStartSeconds: current.startSeconds,
      dialogueSourceEndSeconds: current.endSeconds,
      dialogueSourceSegmentStartSeconds: current.segmentStartSeconds,
      dialogueSourceSegmentEndSeconds: current.segmentEndSeconds,
      measuredDialogueGapBeforeSeconds: measuredGapBeforeSeconds,
      sourceHeadPaddingSeconds,
      sourceTailPaddingSeconds,
      syntheticTailPaddingSeconds,
      outputHeadPaddingSeconds: speechStartSeconds,
      outputTailPaddingSeconds: Math.max(0, durationSeconds - speechEndSeconds),
      acousticSpeechDetection: acousticBounds,
      acousticTrimStartSeconds,
      acousticTrimEndSeconds,
      acousticSafetyPaddingSeconds,
      syntheticHeadPaddingSeconds,
      splitFadeInMilliseconds: Number((fadeIn * 1000).toFixed(3)),
      splitFadeOutMilliseconds: Number((fadeOut * 1000).toFixed(3)),
      fadeInEndsBeforeSpeech: fadeIn <= speechStartSeconds + 1e-6,
      fadeOutStartsAfterSpeech: fadeOutStart >= speechEndSeconds - 1e-6,
      targetAudibleGapBeforeSeconds,
      embeddedPaddingGapSeconds,
      authoredGapBeforeSeconds,
      bubbleSegmentBoundarySeconds,
      maximumInternalPauseSeconds,
      literalSilenceCompaction: silenceCompaction,
      createdAt: new Date().toISOString(),
    };
    const alignmentFileName = fileName + ".json";
    const alignmentPath = join(alignmentsDir, alignmentFileName);
    await writeFile(alignmentPath, JSON.stringify(sidecar, null, 2) + "\n", "utf8");
    rows.push({
      utteranceId: utterance.id,
      speakerName: utterance.speakerName,
      fileName,
      filePath,
      alignmentFileName,
      alignmentPath,
      durationSeconds,
      speechStartSeconds,
      speechEndSeconds,
      measuredDialogueGapBeforeSeconds: measuredGapBeforeSeconds,
      targetAudibleGapBeforeSeconds,
      embeddedPaddingGapSeconds,
      authoredGapBeforeSeconds,
      maximumInternalPauseSeconds,
      literalSilenceCompaction: silenceCompaction,
      sourceDialogueStartSeconds: current.startSeconds,
      sourceDialogueEndSeconds: current.endSeconds,
      sourceDialogueSegmentStartSeconds: current.segmentStartSeconds,
      sourceDialogueSegmentEndSeconds: current.segmentEndSeconds,
      audio: {
        ...sidecar,
        fileName,
        filePath,
        alignmentFileName,
        alignmentPath,
        assetUrl: "/excalidraw-assets/audio/" + encodeURIComponent(fileName),
        mimeType: "audio/wav",
      },
    });
  }
  return rows;
}

await mkdir(sourceDir, { recursive: true });
await mkdir(assetsDir, { recursive: true });
await mkdir(alignmentsDir, { recursive: true });

const selectedCuts = manifest.cuts.filter(
  (cut) => requestedCutIds.size === 0 || requestedCutIds.has(cut.id),
);
if (selectedCuts.length === 0) throw new Error(`No cuts selected for ${pipelineVersion.toUpperCase()} dialogue generation.`);
const cutReports = [];
for (const cut of selectedCuts) {
  const utterances = cut.utteranceIds.map((id) => utteranceById.get(id)).filter(Boolean);
  const metadata = await generateCutDialogue(cut, utterances);
  const rows = stageOnly ? [] : await splitUtteranceAudio(cut, utterances, metadata);
  cutReports.push({
    cutId: cut.id,
    reused: metadata.reused,
    requestId: metadata.requestId,
    sourcePath: metadata.sourcePath,
    sourceDurationSeconds: metadata.sourceDurationSeconds,
    selectedTakeIndex: metadata.takeIndex ?? 0,
    candidateSelection: metadata.candidateSelection,
    utteranceCount: utterances.length,
    rows,
  });
  process.stdout.write(JSON.stringify({
    cutId: cut.id,
    reused: metadata.reused,
    sourceDurationSeconds: metadata.sourceDurationSeconds,
    utteranceCount: utterances.length,
    stageOnly,
  }) + "\n");
}

if (!stageOnly) {
  if (selectedCuts.length !== manifest.cuts.length) {
    throw new Error(`Partial ${pipelineVersion.toUpperCase()} application is not allowed; rerun without --cut-ids after staging.`);
  }
  try {
    await stat(backupPath);
  } catch {
    await writeFile(backupPath, manifestText, "utf8");
  }
  const rowByUtteranceId = new Map(
    cutReports.flatMap((cut) => cut.rows).map((row) => [row.utteranceId, row]),
  );
  for (const utterance of manifest.utterances) {
    const row = rowByUtteranceId.get(utterance.id);
    if (!row) throw new Error(`Missing generated ${pipelineVersion.toUpperCase()} utterance ${utterance.id}`);
    utterance.model = "eleven_v3";
    const plainNarration = isV25 && utterance.preset === "narration";
    utterance.performancePrompt = plainNarration ? "" : performanceByUtterance[utterance.id];
    if (plainNarration) delete utterance.semanticPerformanceIntent;
    else if (isV25) utterance.semanticPerformanceIntent = semanticIntentByUtterance[utterance.id];
    utterance.speechOverride = speechByUtterance[utterance.id];
    utterance.speechText = speechByUtterance[utterance.id];
    utterance.speechAuditText = speechByUtterance[utterance.id].replaceAll("/ɾeɴ/", "レン");
    utterance.audioFileName = row.fileName;
    utterance.pauseBeforeSeconds = isV25
      ? row.authoredGapBeforeSeconds
      : pauseBeforeByUtterance[utterance.id];
    if (utterance.pauseBeforeSeconds === undefined) delete utterance.pauseBeforeSeconds;
    utterance.pauseClass = pauseClassByUtterance[utterance.id] || null;
    utterance.audio = row.audio;
    utterance.timing = null;
  }
  manifest.video = {
    ...(manifest.video || {}),
    sameSpeakerGapSeconds: isV25 ? 0.03 : 0.17,
    speakerChangeGapSeconds: isV25 ? 0.05 : 0.27,
    emphasisGapSeconds: isV25 ? 0.20 : 0.40,
    cutTailSeconds: 0.34,
    normalizeVoiceAudio: false,
    voiceTargetLufs: -19,
    voiceLoudnessRange: 7,
    voiceTruePeakDb: -2,
    // The dialogue source is already split with 12/18 ms click-safe edges.
    // Do not add a longer processing envelope that would soften consonants.
    voiceFadeInMilliseconds: 0,
    voiceFadeOutMilliseconds: 0,
    normalizeMasterAudio: true,
    masterTargetLufs: -14.5,
    masterLoudnessRange: 7,
    masterTruePeakDb: -1.5,
    bgmPath: "",
    bgmVolume: 0,
    fileName: isV25
      ? "manga-photo-homecoming-001-v25-natural-dialogue-r1.mp4"
      : "manga-photo-homecoming-001-v22-natural-dialogue-r1.mp4",
    statusAfterRender: isV25
      ? "final-review-candidate-v25-natural-dialogue-r1"
      : "final-review-candidate-v22-natural-dialogue-r1",
  };
  manifest.speech = {
    ...(manifest.speech || {}),
    auditPolicy: `elevenlabs-v3-dialogue-plus-japanese-asr-semantic-prosody-and-safe-edge-audit-${pipelineVersion}`,
    performancePromptPolicy: {
      provider: "elevenlabs-v3-text-to-dialogue",
      oneContextualVoiceTagPerUtterance: isV25 ? "dialogue-only" : true,
      semanticClauseFocusAndBreathIntent: false,
      plainNarrationMatchesOrdinaryDialogue: isV25,
      multipleTakesPerCut: isV25 ? 2 : 1,
      nonVerbalAudioTagsAllowed: false,
      stability: 0.5,
      displayTextUnchanged: true,
      voiceIdentityFixedPerCharacter: true,
      cutContextUsedForTurnTaking: true,
    },
    masteringPolicy: {
      providerAudioPreserved: true,
      pitchOrTimbreProcessing: false,
      denoiseOrVoiceConversion: false,
      sourceSplitFormat: "pcm_s24le_48000",
      perLineTargetLufs: -19,
      finalTargetLufs: -14.5,
      minimumOnsetSafetyMarginMilliseconds: isV25 ? 55 : 0,
      targetOnsetSafetyMarginMilliseconds: isV25 ? 80 : 12,
      targetReleaseSafetyMarginMilliseconds: isV25 ? 80 : 24,
      splitFadeInMilliseconds: isV25 ? 6 : 12,
      splitFadeOutMilliseconds: isV25 ? 8 : 18,
      literalSilenceOnlyPauseCompaction: true,
      note: isV25
        ? "ElevenLabs source performance is preserved. Each line retains pre-phoneme and post-phoneme source margin; fades end before speech begins and start after speech ends. Only literal-silence pause compaction, transparent loudness matching, resampling, and edge fades are applied."
        : "Only source splitting, literal-silence pause compaction, transparent loudness matching, resampling, and click-safe edge fades are applied. Voiced samples are not time-stretched.",
    },
  };
  manifest.audioQuality = {
    ...(manifest.audioQuality || {}),
    version: `${pipelineVersion}-elevenlabs-dialogue`,
    provider: "elevenlabs",
    model: "eleven_v3",
    generationMode: "text-to-dialogue-with-timestamps",
    referenceVideoIds: ["awAbZyTeE4g", "2ycRncs4CKY"],
    referenceSilenceMedianSeconds: [0.1577, 0.1753],
    referenceCaveat: "Reference measurements include BGM and are used as a lower-bound calibration.",
    nativeJapaneseVoices: true,
    voiceProcessing: {
      pitchShift: false,
      timeStretch: false,
      denoise: false,
      voiceConversion: false,
      equalization: false,
      transparentLoudnessMatching: true,
      twoPassPerLineLoudnessMatching: true,
      clickSafeEdgeFadesOnly: true,
    },
    pauseDefinition: isV25 ? "audible-speech-end-to-next-speech-start" : "authored-file-gap",
    pauseRanges: {
      sameSpeaker: { min: 0.13, max: 0.17, default: 0.17 },
      speakerSwitch: { min: 0.14, max: 0.34, default: 0.27 },
      hesitation: { min: 0.25, max: 0.32, default: 0.27 },
      emphasis: { min: 0.30, max: 0.40, default: 0.40 },
      cutTail: { min: 0.30, max: 0.38, default: 0.34 },
    },
    generationReportPath: reportPath,
  };
  manifest.status = `${pipelineVersion}-elevenlabs-dialogue-generated`;
  manifest.jobs = { ...(manifest.jobs || {}), speech: {}, render: {} };
  manifest.outputs = { ...(manifest.outputs || {}) };
  manifest.updatedAt = new Date().toISOString();
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

const report = {
  version: `${pipelineVersion}-elevenlabs-dialogue`,
  manifestPath,
  backupPath,
  stageOnly,
  selectedCutIds: selectedCuts.map((cut) => cut.id),
  cutCount: cutReports.length,
  utteranceCount: cutReports.reduce((sum, cut) => sum + cut.utteranceCount, 0),
  reusedCutCount: cutReports.filter((cut) => cut.reused).length,
  newCutCount: cutReports.filter((cut) => !cut.reused).length,
  cutReports,
  createdAt: new Date().toISOString(),
};
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify({
  reportPath,
  manifestPath,
  stageOnly,
  cutCount: report.cutCount,
  utteranceCount: report.utteranceCount,
  reusedCutCount: report.reusedCutCount,
  newCutCount: report.newCutCount,
}) + "\n");
