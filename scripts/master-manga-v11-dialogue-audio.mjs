#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const projectDir = resolve(process.argv[2] || process.cwd());
const manifestPath = resolve(
  process.argv[3]
    || join(projectDir, "canvas", "manga-videos", "manga-photo-homecoming-001", "episode-manifest.json"),
);
const canvasDir = join(projectDir, "canvas");
const outputDir = join(canvasDir, "assets", "audio", "mastered-v11");
const reportPath = join(
  canvasDir,
  "manga-videos",
  "manga-photo-homecoming-001",
  "v11-audio-mastering-report.json",
);

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(`${command} exited with ${code}: ${stderr.slice(-4000)}`));
    });
  });
}

function readPcm24EdgeStats(buffer, sampleRate = 48000) {
  let offset = 12;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      dataOffset = offset + 8;
      dataSize = Math.min(chunkSize, buffer.length - dataOffset);
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (dataOffset < 0 || dataSize < 3) throw new Error("No PCM data chunk in mastered WAV.");
  const sampleCount = Math.floor(dataSize / 3);
  const fadeSampleCount = Math.min(sampleCount, Math.max(1, Math.round(sampleRate * 0.02)));
  const sampleAt = (index) => {
    const valueOffset = dataOffset + index * 3;
    let value = buffer[valueOffset] | (buffer[valueOffset + 1] << 8) | (buffer[valueOffset + 2] << 16);
    if (value & 0x800000) value |= 0xff000000;
    return value / 8388608;
  };
  const first = sampleAt(0);
  const last = sampleAt(sampleCount - 1);
  let edgePeak = 0;
  for (let index = 0; index < fadeSampleCount; index += 1) {
    edgePeak = Math.max(edgePeak, Math.abs(sampleAt(index)), Math.abs(sampleAt(sampleCount - 1 - index)));
  }
  return {
    firstSample: Number(first.toFixed(8)),
    lastSample: Number(last.toFixed(8)),
    absoluteBoundaryPeak: Number(Math.max(Math.abs(first), Math.abs(last)).toFixed(8)),
    firstAndLast20msPeak: Number(edgePeak.toFixed(6)),
    sampleCount,
  };
}

function parseLoudness(stderr) {
  const integratedMatches = [...stderr.matchAll(/\bI:\s*(-?\d+(?:\.\d+)?)\s+LUFS/gu)];
  const truePeakMatches = [...stderr.matchAll(/\bPeak:\s*(-?\d+(?:\.\d+)?)\s+dBFS/gu)];
  return {
    integratedLufs: integratedMatches.length
      ? Number(integratedMatches.at(-1)[1])
      : null,
    truePeakDbfs: truePeakMatches.length
      ? Number(truePeakMatches.at(-1)[1])
      : null,
  };
}

function parseLoudnormAnalysis(stderr) {
  const matches = [...stderr.matchAll(/\{\s*"input_i"[\s\S]*?\}/gu)];
  if (matches.length === 0) throw new Error(`FFmpeg loudnorm analysis returned no JSON: ${stderr.slice(-2000)}`);
  const payload = JSON.parse(matches.at(-1)[0]);
  const required = ["input_i", "input_lra", "input_tp", "input_thresh", "target_offset"];
  for (const key of required) {
    if (!Number.isFinite(Number(payload[key]))) throw new Error(`Invalid loudnorm ${key}: ${payload[key]}`);
  }
  return payload;
}

await mkdir(outputDir, { recursive: true });
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const mastering = manifest.speech?.masteringPolicy || {};
const targetLufs = Number(mastering.targetIntegratedLufs ?? -20);
const targetLra = Number(mastering.targetLoudnessRange ?? 7);
const targetPeak = Number(mastering.truePeakDb ?? -2);
const fadeInSeconds = Number(mastering.fadeInMilliseconds ?? 12) / 1000;
const fadeOutSeconds = Number(mastering.fadeOutMilliseconds ?? 18) / 1000;
const rows = [];

for (const utterance of manifest.utterances || []) {
  const rawAudio = utterance.audio;
  if (!rawAudio?.filePath) throw new Error(`Missing raw V11 audio for ${utterance.id}.`);
  const rawPath = resolve(rawAudio.rawSource?.filePath || rawAudio.filePath);
  const outputName = `${manifest.id}-${utterance.id}-v11-mastered.wav`;
  const outputPath = join(outputDir, outputName);
  const durationResult = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    rawPath,
  ]);
  const rawDuration = Number(durationResult.stdout.trim());
  if (!Number.isFinite(rawDuration) || rawDuration <= fadeOutSeconds) {
    throw new Error(`Invalid raw audio duration for ${utterance.id}: ${durationResult.stdout}`);
  }
  const fadeOutStart = Math.max(0, rawDuration - fadeOutSeconds);
  const analysisFilter = [
    "aresample=48000:resampler=soxr:precision=28",
    "highpass=f=45",
    "lowpass=f=15000",
    `loudnorm=I=${targetLufs}:LRA=${targetLra}:TP=${targetPeak}:print_format=json`,
  ].join(",");
  const analysis = await run("ffmpeg", [
    "-hide_banner", "-nostats", "-i", rawPath,
    "-af", analysisFilter, "-f", "null", "-",
  ]);
  const measured = parseLoudnormAnalysis(analysis.stderr);
  const filter = [
    "aresample=48000:resampler=soxr:precision=28",
    "highpass=f=45",
    "lowpass=f=15000",
    [
      `loudnorm=I=${targetLufs}:LRA=${targetLra}:TP=${targetPeak}`,
      `measured_I=${measured.input_i}`,
      `measured_LRA=${measured.input_lra}`,
      `measured_TP=${measured.input_tp}`,
      `measured_thresh=${measured.input_thresh}`,
      `offset=${measured.target_offset}`,
      "linear=true",
      "print_format=summary",
    ].join(":"),
    `afade=t=in:st=0:d=${fadeInSeconds}`,
    `afade=t=out:st=${fadeOutStart}:d=${fadeOutSeconds}`,
  ].join(",");
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", rawPath,
    "-vn", "-af", filter,
    "-ar", "48000", "-ac", "1", "-c:a", "pcm_s24le",
    outputPath,
  ]);
  const masteredDurationResult = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    outputPath,
  ]);
  const masteredDuration = Number(masteredDurationResult.stdout.trim());
  const loudnessResult = await run("ffmpeg", [
    "-hide_banner", "-nostats", "-i", outputPath,
    "-filter_complex", "ebur128=peak=true", "-f", "null", "-",
  ]);
  const loudness = parseLoudness(loudnessResult.stderr);
  const edgeStats = readPcm24EdgeStats(await readFile(outputPath));
  const pass = Number.isFinite(loudness.integratedLufs)
    && Math.abs(loudness.integratedLufs - targetLufs) <= 1.2
    && (loudness.truePeakDbfs === null || loudness.truePeakDbfs <= -1.5)
    && edgeStats.absoluteBoundaryPeak <= 0.001;
  const row = {
    utteranceId: utterance.id,
    speakerName: utterance.speakerName,
    performancePrompt: utterance.performancePrompt,
    rawPath,
    masteredPath: outputPath,
    durationSeconds: Number(masteredDuration.toFixed(6)),
    ...loudness,
    edgeStats,
    pass,
  };
  rows.push(row);
  utterance.audio = {
    ...rawAudio,
    rawSource: {
      fileName: rawAudio.rawSource?.fileName || rawAudio.fileName || basename(rawPath),
      filePath: rawPath,
      assetUrl: rawAudio.rawSource?.assetUrl || rawAudio.assetUrl,
      mimeType: rawAudio.rawSource?.mimeType || rawAudio.mimeType,
      outputFormat: rawAudio.rawSource?.outputFormat || rawAudio.outputFormat,
      requestId: rawAudio.rawSource?.requestId || rawAudio.requestId,
    },
    fileName: outputName,
    filePath: outputPath,
    assetUrl: `/excalidraw-assets/audio/mastered-v11/${encodeURIComponent(outputName)}`,
    mimeType: "audio/wav",
    outputFormat: "pcm_s24le_48000_mono",
    durationSeconds: masteredDuration,
    speechEndSeconds: Math.min(masteredDuration, Number(rawAudio.speechEndSeconds ?? masteredDuration)),
    mastering: {
      version: "v11-click-free-dialogue-master",
      targetIntegratedLufs: targetLufs,
      targetLoudnessRange: targetLra,
      truePeakDb: targetPeak,
      fadeInMilliseconds: fadeInSeconds * 1000,
      fadeOutMilliseconds: fadeOutSeconds * 1000,
      highpassHz: 45,
      lowpassHz: 15000,
      resampler: "soxr-precision-28",
      measuredIntegratedLufs: loudness.integratedLufs,
      measuredTruePeakDbfs: loudness.truePeakDbfs,
      edgeStats,
    },
  };
  process.stdout.write(`${JSON.stringify({ utteranceId: utterance.id, integratedLufs: loudness.integratedLufs, boundaryPeak: edgeStats.absoluteBoundaryPeak, pass })}\n`);
}

const loudnessValues = rows.map((row) => row.integratedLufs).filter(Number.isFinite);
const report = {
  version: 1,
  manifestPath,
  targetIntegratedLufs: targetLufs,
  targetTruePeakDb: targetPeak,
  utteranceCount: rows.length,
  passedCount: rows.filter((row) => row.pass).length,
  failedCount: rows.filter((row) => !row.pass).length,
  loudnessSpreadLu: loudnessValues.length
    ? Number((Math.max(...loudnessValues) - Math.min(...loudnessValues)).toFixed(3))
    : null,
  maximumBoundaryPeak: Number(Math.max(...rows.map((row) => row.edgeStats.absoluteBoundaryPeak)).toFixed(8)),
  pass: rows.every((row) => row.pass)
    && loudnessValues.length === rows.length
    && Math.max(...loudnessValues) - Math.min(...loudnessValues) <= 2.5,
  rows,
};

manifest.status = report.pass ? "speech-mastered-v11" : "speech-mastering-review-v11";
manifest.audioQuality = {
  ...(manifest.audioQuality || {}),
  masteringReportPath: reportPath,
  masteringPass: report.pass,
  loudnessSpreadLu: report.loudnessSpreadLu,
  maximumBoundaryPeak: report.maximumBoundaryPeak,
};
manifest.metrics = {
  ...(manifest.metrics || {}),
  failedCount: 0,
  retryCount: 0,
  audioDurationSeconds: Number(rows.reduce((total, row) => total + row.durationSeconds, 0).toFixed(6)),
  masteredUtteranceCount: rows.length,
};
manifest.outputs = {};
manifest.updatedAt = new Date().toISOString();

await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ reportPath, pass: report.pass, passedCount: report.passedCount, failedCount: report.failedCount, loudnessSpreadLu: report.loudnessSpreadLu }, null, 2)}\n`);
if (!report.pass) process.exitCode = 1;
