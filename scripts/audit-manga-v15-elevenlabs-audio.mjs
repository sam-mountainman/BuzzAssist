#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const projectDir = resolve(process.argv[2] || process.cwd());
const manifestPath = resolve(
  process.argv[3]
  || join(projectDir, "canvas", "manga-videos", "manga-photo-homecoming-001", "episode-manifest.json"),
);
const reportPath = join(
  projectDir,
  "canvas",
  "manga-videos",
  "manga-photo-homecoming-001",
  "v15-elevenlabs-transparent-audio-audit.json",
);

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
        rejectPromise(new Error(`${command} exited with ${code}: ${stderr.slice(-4000)}`));
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

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const targetLufs = Number(manifest.video?.voiceTargetLufs ?? -19);
const targetLra = Number(manifest.video?.voiceLoudnessRange ?? 7);
const targetPeak = Number(manifest.video?.voiceTruePeakDb ?? -2);
const fadeIn = Number(manifest.video?.voiceFadeInMilliseconds ?? 12) / 1000;
const fadeOut = Number(manifest.video?.voiceFadeOutMilliseconds ?? 18) / 1000;
const rows = [];

for (const utterance of manifest.utterances || []) {
  const audioPath = resolve(utterance.audio?.filePath || "");
  const duration = Number(utterance.audio?.durationSeconds || 0);
  if (!audioPath || !Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Missing ElevenLabs audio for ${utterance.id}.`);
  }
  const fadeOutStart = Math.max(0, duration - fadeOut);
  const transparentFilter = [
    "aresample=48000",
    `loudnorm=I=${targetLufs.toFixed(1)}:LRA=${targetLra.toFixed(1)}:TP=${targetPeak.toFixed(1)}`,
    `afade=t=in:st=0:d=${fadeIn.toFixed(6)}`,
    `afade=t=out:st=${fadeOutStart.toFixed(6)}:d=${fadeOut.toFixed(6)}`,
  ].join(",");
  const decoded = await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", audioPath,
    "-vn", "-af", transparentFilter,
    "-ar", "48000", "-ac", "1", "-f", "f32le", "-",
  ], { binaryStdout: true });
  const loudnessOutput = await run("ffmpeg", [
    "-hide_banner", "-nostats", "-i", audioPath,
    "-filter_complex", `${transparentFilter},ebur128=peak=true`, "-f", "null", "-",
  ]);
  const loudness = parseLoudness(loudnessOutput.stderr);
  const edges = edgeStats(decoded.stdout);
  const pass = Number.isFinite(loudness.integratedLufs)
    && Math.abs(loudness.integratedLufs - targetLufs) <= 1.2
    && (loudness.truePeakDbfs === null || loudness.truePeakDbfs <= -1.5)
    && edges.absoluteBoundaryPeak <= 0.001;
  const row = {
    utteranceId: utterance.id,
    speakerName: utterance.speakerName,
    audioPath,
    durationSeconds: duration,
    ...loudness,
    edges,
    pass,
  };
  rows.push(row);
  process.stdout.write(`${JSON.stringify({
    utteranceId: row.utteranceId,
    integratedLufs: row.integratedLufs,
    truePeakDbfs: row.truePeakDbfs,
    boundaryPeak: row.edges.absoluteBoundaryPeak,
    pass,
  })}\n`);
}

const loudnessValues = rows.map((row) => row.integratedLufs).filter(Number.isFinite);
const loudnessSpreadLu = loudnessValues.length
  ? Number((Math.max(...loudnessValues) - Math.min(...loudnessValues)).toFixed(3))
  : null;
const report = {
  version: 1,
  manifestPath,
  provider: "elevenlabs",
  model: "eleven_v3",
  policy: {
    pitchOrTimbreProcessing: false,
    denoiseOrVoiceConversion: false,
    targetIntegratedLufs: targetLufs,
    targetLoudnessRange: targetLra,
    truePeakDb: targetPeak,
    fadeInMilliseconds: fadeIn * 1000,
    fadeOutMilliseconds: fadeOut * 1000,
  },
  utteranceCount: rows.length,
  passedCount: rows.filter((row) => row.pass).length,
  failedCount: rows.filter((row) => !row.pass).length,
  loudnessSpreadLu,
  maximumBoundaryPeak: Number(Math.max(...rows.map((row) => row.edges.absoluteBoundaryPeak)).toFixed(9)),
  pass: rows.every((row) => row.pass) && loudnessSpreadLu <= 2.5,
  rows,
  createdAt: new Date().toISOString(),
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
manifest.audioQuality = {
  ...(manifest.audioQuality || {}),
  transparentAudioAuditPath: reportPath,
  transparentAudioAuditPass: report.pass,
  loudnessSpreadLu: report.loudnessSpreadLu,
  maximumBoundaryPeak: report.maximumBoundaryPeak,
};
manifest.status = report.pass ? "speech-audited-v15-elevenlabs" : "speech-audio-review-v15-elevenlabs";
manifest.updatedAt = new Date().toISOString();
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  reportPath,
  pass: report.pass,
  passedCount: report.passedCount,
  failedCount: report.failedCount,
  loudnessSpreadLu: report.loudnessSpreadLu,
  maximumBoundaryPeak: report.maximumBoundaryPeak,
}, null, 2)}\n`);
if (!report.pass) process.exitCode = 1;
