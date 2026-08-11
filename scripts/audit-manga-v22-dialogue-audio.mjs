#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const projectDir = resolve(process.argv[2] || process.cwd());
const pipelineVersion = process.env.MANGA_DIALOGUE_VERSION === "v25" ? "v25" : "v22";
const isV25 = pipelineVersion === "v25";
const manifestPath = resolve(process.argv[3] || join(
  projectDir,
  "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json",
));
const episodeDir = dirname(manifestPath);
const reportPath = join(episodeDir, `${pipelineVersion}-elevenlabs-dialogue-audio-audit.json`);

function run(command, args, { binaryStdout = false } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(new Error(command + " exited with " + code + ": " + stderr.slice(-4000)));
        return;
      }
      const output = Buffer.concat(stdout);
      resolvePromise({ stdout: binaryStdout ? output : output.toString(), stderr });
    });
  });
}

function parseLoudness(stderr) {
  const integrated = [...stderr.matchAll(/\bI:\s*(-?\d+(?:\.\d+)?)\s+LUFS/gu)];
  const peaks = [...stderr.matchAll(/\bPeak:\s*(-?\d+(?:\.\d+)?)\s+dBFS/gu)];
  return {
    integratedLufs: integrated.length ? Number(integrated.at(-1)[1]) : null,
    truePeakDbfs: peaks.length ? Number(peaks.at(-1)[1]) : null,
  };
}

function edgeStats(floatBuffer, sampleRate = 48_000) {
  const sampleCount = Math.floor(floatBuffer.length / 4);
  const sampleAt = (index) => floatBuffer.readFloatLE(index * 4);
  const firstSample = sampleCount ? sampleAt(0) : 0;
  const lastSample = sampleCount ? sampleAt(sampleCount - 1) : 0;
  const edgeWindow = Math.min(sampleCount, Math.max(1, Math.round(sampleRate * 0.02)));
  let first20msPeak = 0;
  let last20msPeak = 0;
  for (let index = 0; index < edgeWindow; index += 1) {
    first20msPeak = Math.max(first20msPeak, Math.abs(sampleAt(index)));
    last20msPeak = Math.max(last20msPeak, Math.abs(sampleAt(sampleCount - 1 - index)));
  }
  return {
    firstSample: Number(firstSample.toFixed(9)),
    lastSample: Number(lastSample.toFixed(9)),
    absoluteBoundaryPeak: Number(Math.max(Math.abs(firstSample), Math.abs(lastSample)).toFixed(9)),
    first20msPeak: Number(first20msPeak.toFixed(6)),
    last20msPeak: Number(last20msPeak.toFixed(6)),
    sampleCount,
  };
}

function spokenCharacterCount(value) {
  return [...String(value || "").replace(/[\s\u3000、。！？!?…・「」『』,.—―:：/]/gu, "")].length;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const targetLufs = Number(manifest.video?.voiceTargetLufs ?? -19);
const targetLra = Number(manifest.video?.voiceLoudnessRange ?? 7);
const targetPeak = Number(manifest.video?.voiceTruePeakDb ?? -2);
const rows = [];

for (const utterance of manifest.utterances || []) {
  const audioPath = resolve(utterance.audio?.filePath || "");
  const duration = Number(utterance.audio?.durationSeconds || 0);
  if (!audioPath || !Number.isFinite(duration) || duration <= 0) {
    throw new Error("Missing V22 ElevenLabs audio for " + utterance.id);
  }
  const transparentFilter = [
    "aresample=48000",
    manifest.video?.normalizeVoiceAudio !== false
      ? "loudnorm=I=" + targetLufs.toFixed(1) + ":LRA=" + targetLra.toFixed(1) + ":TP=" + targetPeak.toFixed(1)
      : "",
  ].filter(Boolean).join(",");
  const decoded = await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", audioPath,
    "-vn", "-af", transparentFilter,
    "-ar", "48000", "-ac", "1", "-f", "f32le", "-",
  ], { binaryStdout: true });
  const loudnessOutput = await run("ffmpeg", [
    "-hide_banner", "-nostats", "-i", audioPath,
    "-filter_complex", transparentFilter + ",ebur128=peak=true", "-f", "null", "-",
  ]);
  const loudness = parseLoudness(loudnessOutput.stderr);
  const edges = edgeStats(decoded.stdout);
  const speechDuration = Math.max(
    0.001,
    Number(utterance.audio.speechEndSeconds ?? duration) - Number(utterance.audio.speechStartSeconds ?? 0),
  );
  const charactersPerSecond = spokenCharacterCount(utterance.speechAuditText || utterance.speechText || utterance.text)
    / speechDuration;
  const onsetMarginSeconds = Number(utterance.audio.speechStartSeconds ?? 0);
  const releaseMarginSeconds = Math.max(0, duration - Number(utterance.audio.speechEndSeconds ?? duration));
  const safeProviderEdges = !isV25 || (
    onsetMarginSeconds >= 0.055
    && releaseMarginSeconds >= 0.045
    && utterance.audio.fadeInEndsBeforeSpeech === true
    && utterance.audio.fadeOutStartsAfterSpeech === true
    && edges.first20msPeak <= 0.005
    && edges.last20msPeak <= 0.005
  );
  const pass = Number.isFinite(loudness.integratedLufs)
    && Math.abs(loudness.integratedLufs - targetLufs) <= 1.2
    && (loudness.truePeakDbfs === null || loudness.truePeakDbfs <= -1.5)
    && edges.absoluteBoundaryPeak <= 0.001
    && safeProviderEdges
    && charactersPerSecond >= 3
    && charactersPerSecond <= 8.5;
  const row = {
    utteranceId: utterance.id,
    speakerName: utterance.speakerName,
    performancePrompt: utterance.performancePrompt,
    audioPath,
    durationSeconds: duration,
    speechDurationSeconds: Number(speechDuration.toFixed(4)),
    spokenCharacterCount: spokenCharacterCount(utterance.speechAuditText || utterance.speechText || utterance.text),
    charactersPerSecond: Number(charactersPerSecond.toFixed(3)),
    ...loudness,
    edges,
    onsetMarginSeconds: Number(onsetMarginSeconds.toFixed(4)),
    releaseMarginSeconds: Number(releaseMarginSeconds.toFixed(4)),
    fadeInEndsBeforeSpeech: utterance.audio.fadeInEndsBeforeSpeech === true,
    fadeOutStartsAfterSpeech: utterance.audio.fadeOutStartsAfterSpeech === true,
    safeProviderEdges,
    pass,
  };
  rows.push(row);
  process.stdout.write(JSON.stringify({
    utteranceId: row.utteranceId,
    integratedLufs: row.integratedLufs,
    truePeakDbfs: row.truePeakDbfs,
    charactersPerSecond: row.charactersPerSecond,
    boundaryPeak: row.edges.absoluteBoundaryPeak,
    pass,
  }) + "\n");
}

const pauseRows = [];
for (const cut of manifest.cuts) {
  const cutUtterances = cut.utteranceIds.map((id) => manifest.utterances.find((utterance) => utterance.id === id));
  for (let index = 1; index < cutUtterances.length; index += 1) {
    const previous = cutUtterances[index - 1];
    const current = cutUtterances[index];
    const authoredFileGapSeconds = Number(current.pauseBeforeSeconds);
    const previousTailPaddingSeconds = Math.max(
      0,
      Number(previous.audio?.durationSeconds || 0) - Number(previous.audio?.speechEndSeconds || 0),
    );
    const currentHeadPaddingSeconds = Number(current.audio?.speechStartSeconds || 0);
    const audibleGapSeconds = previousTailPaddingSeconds + authoredFileGapSeconds + currentHeadPaddingSeconds;
    const targetAudibleGapSeconds = Number(current.audio?.targetAudibleGapBeforeSeconds);
    const gapSeconds = isV25 ? audibleGapSeconds : authoredFileGapSeconds;
    const category = current.pauseClass === "emphasis" || current.pauseClass === "hesitation"
      ? current.pauseClass
      : previous.speakerId === current.speakerId
        ? "sameSpeaker"
        : "speakerSwitch";
    const range = manifest.audioQuality?.pauseRanges?.[category] || {};
    const pass = isV25
      ? Number.isFinite(targetAudibleGapSeconds) && Math.abs(audibleGapSeconds - targetAudibleGapSeconds) <= 0.012
      : Number.isFinite(gapSeconds)
        && gapSeconds >= Number(range.min) - 1e-6
        && gapSeconds <= Number(range.max) + 1e-6;
    pauseRows.push({
      cutId: cut.id,
      utteranceId: current.id,
      previousUtteranceId: previous.id,
      category,
      gapSeconds,
      authoredFileGapSeconds,
      previousTailPaddingSeconds,
      currentHeadPaddingSeconds,
      audibleGapSeconds: Number(audibleGapSeconds.toFixed(4)),
      targetAudibleGapSeconds,
      minimumSeconds: isV25 ? targetAudibleGapSeconds - 0.012 : Number(range.min),
      maximumSeconds: isV25 ? targetAudibleGapSeconds + 0.012 : Number(range.max),
      pass,
    });
  }
}

const loudnessValues = rows.map((row) => row.integratedLufs).filter(Number.isFinite);
const loudnessSpreadLu = loudnessValues.length
  ? Number((Math.max(...loudnessValues) - Math.min(...loudnessValues)).toFixed(3))
  : null;
const pauseValues = pauseRows.map((row) => row.gapSeconds);
const pauseMedianSeconds = Number(median(pauseValues).toFixed(3));
const report = {
  version: `${pipelineVersion}-elevenlabs-dialogue-audio-audit`,
  manifestPath,
  provider: "elevenlabs",
  model: "eleven_v3",
  generationMode: "text-to-dialogue-with-timestamps",
  referenceVideoIds: ["awAbZyTeE4g", "2ycRncs4CKY"],
  referenceSilenceMedianSeconds: [0.1577, 0.1753],
  referenceMixedTrackCaveat: "Reference BGM masks some pauses, so its silence median is a lower bound.",
  policy: {
    pitchOrTimbreProcessing: false,
    denoiseOrVoiceConversion: false,
    sourceSplitFormat: "pcm_s24le_48000",
    targetIntegratedLufs: targetLufs,
    targetLoudnessRange: targetLra,
    truePeakDb: targetPeak,
    splitFadeInMilliseconds: isV25 ? 6 : 12,
    splitFadeOutMilliseconds: isV25 ? 8 : 18,
    minimumOnsetMarginSeconds: isV25 ? 0.055 : null,
    minimumReleaseMarginSeconds: isV25 ? 0.045 : null,
    minimumCharactersPerSecond: 3,
    maximumCharactersPerSecond: 8.5,
  },
  utteranceCount: rows.length,
  passedUtteranceCount: rows.filter((row) => row.pass).length,
  failedUtteranceCount: rows.filter((row) => !row.pass).length,
  pauseCount: pauseRows.length,
  passedPauseCount: pauseRows.filter((row) => row.pass).length,
  failedPauseCount: pauseRows.filter((row) => !row.pass).length,
  pauseMinimumSeconds: Number(Math.min(...pauseValues).toFixed(3)),
  pauseMedianSeconds,
  pauseMaximumSeconds: Number(Math.max(...pauseValues).toFixed(3)),
  loudnessSpreadLu,
  maximumBoundaryPeak: Number(Math.max(...rows.map((row) => row.edges.absoluteBoundaryPeak)).toFixed(9)),
  backgroundMusicPath: manifest.video?.bgmPath || "",
  backgroundMusicVolume: Number(manifest.video?.bgmVolume || 0),
  noBackgroundBuzzTrack: !manifest.video?.bgmPath && Number(manifest.video?.bgmVolume || 0) === 0,
  rows,
  pauseRows,
  pass: rows.every((row) => row.pass)
    && pauseRows.every((row) => row.pass)
    && loudnessSpreadLu <= 2.5
    && pauseMedianSeconds >= 0.15
    && pauseMedianSeconds <= 0.30
    && !manifest.video?.bgmPath
    && Number(manifest.video?.bgmVolume || 0) === 0,
  createdAt: new Date().toISOString(),
};
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
manifest.audioQuality = {
  ...(manifest.audioQuality || {}),
  transparentAudioAuditPath: reportPath,
  transparentAudioAuditPass: report.pass,
  loudnessSpreadLu: report.loudnessSpreadLu,
  maximumBoundaryPeak: report.maximumBoundaryPeak,
  authoredPauseMedianSeconds: report.pauseMedianSeconds,
  noBackgroundBuzzTrack: report.noBackgroundBuzzTrack,
};
manifest.status = report.pass
  ? `${pipelineVersion}-elevenlabs-dialogue-audited`
  : `${pipelineVersion}-elevenlabs-dialogue-review`;
manifest.updatedAt = new Date().toISOString();
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify({
  reportPath,
  pass: report.pass,
  passedUtteranceCount: report.passedUtteranceCount,
  failedUtteranceCount: report.failedUtteranceCount,
  passedPauseCount: report.passedPauseCount,
  failedPauseCount: report.failedPauseCount,
  pauseMedianSeconds: report.pauseMedianSeconds,
  loudnessSpreadLu: report.loudnessSpreadLu,
  maximumBoundaryPeak: report.maximumBoundaryPeak,
  noBackgroundBuzzTrack: report.noBackgroundBuzzTrack,
}, null, 2) + "\n");
if (!report.pass) process.exitCode = 1;
