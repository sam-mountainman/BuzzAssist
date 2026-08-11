#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = {};
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith("--")) continue;
  const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) args[key] = true;
  else {
    args[key] = value;
    index += 1;
  }
}

for (const key of ["video", "manifest", "alignmentReport", "output", "report"]) {
  if (!args[key]) throw new Error(`Missing --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
}

const videoPath = resolve(args.video);
const manifestPath = resolve(args.manifest);
const alignmentReportPath = resolve(args.alignmentReport);
const outputPath = resolve(args.output);
const reportPath = resolve(args.report);
const workDir = resolve(args.workDir || dirname(reportPath));
const mixPath = resolve(workDir, "v25-fixed-gain-dialogue-mix.wav");
const targetLufs = Number(args.targetLufs ?? -16);
const targetPeakDbfs = Number(args.targetPeakDbfs ?? -1.5);
await mkdir(workDir, { recursive: true });
await mkdir(dirname(outputPath), { recursive: true });

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const alignment = JSON.parse(await readFile(alignmentReportPath, "utf8"));
const alignmentById = new Map(alignment.results.map((result) => [result.utteranceId, result]));

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: options.encoding ?? "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.stdio ?? "pipe",
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status})\n${result.stderr || result.stdout || ""}`);
  }
  return result;
}

const probe = JSON.parse(run("ffprobe", [
  "-v", "error", "-select_streams", "v:0",
  "-show_entries", "stream=duration", "-of", "json", videoPath,
]).stdout);
const videoDurationSeconds = Number(probe.streams?.[0]?.duration);
if (!Number.isFinite(videoDurationSeconds) || videoDurationSeconds <= 0) {
  throw new Error("Unable to determine video duration");
}

// The first cut has no concat-boundary drift. Its observed lag is therefore
// the single AAC encoder/decoder lead used as a placement correction.
const firstUtterance = manifest.utterances[0];
const firstAlignment = alignmentById.get(firstUtterance.id);
const encoderLeadCorrectionSeconds = firstAlignment.matchedStartSeconds
  - Number(firstUtterance.timing.audioStartSeconds);

const ffmpegInputs = [];
const filters = [];
const labels = [];
const placements = [];
manifest.utterances.forEach((utterance, index) => {
  const matched = alignmentById.get(utterance.id);
  if (!matched) throw new Error(`Missing alignment for ${utterance.id}`);
  const sourcePath = resolve(utterance.audio.filePath);
  const placementSeconds = Math.max(0, matched.matchedStartSeconds - encoderLeadCorrectionSeconds);
  const delaySamples = Math.round(placementSeconds * 48_000);
  ffmpegInputs.push("-i", sourcePath);
  filters.push(`[${index}:a]aresample=48000,adelay=${delaySamples}S:all=1[a${index}]`);
  labels.push(`[a${index}]`);
  placements.push({
    utteranceId: utterance.id,
    sourcePath,
    placementSeconds,
    delaySamples,
  });
});
filters.push(
  `${labels.join("")}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0,`
  + `apad=whole_dur=${videoDurationSeconds.toFixed(6)},atrim=0:${videoDurationSeconds.toFixed(6)}[mix]`,
);

run("ffmpeg", [
  "-hide_banner", "-y", ...ffmpegInputs,
  "-filter_complex", filters.join(";"), "-map", "[mix]",
  "-ar", "48000", "-ac", "2", "-c:a", "pcm_s24le", mixPath,
], { stdio: "inherit" });

const loudnessResult = run("ffmpeg", [
  "-hide_banner", "-i", mixPath,
  "-af", `loudnorm=I=${targetLufs}:TP=${targetPeakDbfs}:LRA=7:print_format=json`,
  "-f", "null", "-",
]);
const loudnessMatch = loudnessResult.stderr.match(/\{\s*"input_i"[\s\S]*?\}/g)?.at(-1);
if (!loudnessMatch) throw new Error("Unable to parse loudness analysis");
const loudness = JSON.parse(loudnessMatch);
const inputLufs = Number(loudness.input_i);
const inputPeakDbfs = Number(loudness.input_tp);
const loudnessGainDb = targetLufs - inputLufs;
const peakSafeGainDb = targetPeakDbfs - inputPeakDbfs;
const fixedGainDb = Math.min(loudnessGainDb, peakSafeGainDb);

run("ffmpeg", [
  "-hide_banner", "-y", "-i", videoPath, "-i", mixPath,
  "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
  "-af", `volume=${fixedGainDb.toFixed(6)}dB`,
  "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-ac", "2",
  "-t", videoDurationSeconds.toFixed(6), "-movflags", "+faststart", outputPath,
], { stdio: "inherit" });

const report = {
  version: "v25-fixed-gain-audio-remaster",
  inputVideoPath: videoPath,
  outputVideoPath: outputPath,
  manifestPath,
  alignmentReportPath,
  mixPath,
  utteranceCount: placements.length,
  videoDurationSeconds,
  targetLufs,
  targetPeakDbfs,
  inputLufs,
  inputPeakDbfs,
  loudnessGainDb,
  peakSafeGainDb,
  fixedGainDb,
  encoderLeadCorrectionSeconds,
  processing: [
    "sample-accurate placement",
    "amix normalize=0",
    "one constant gain for the entire episode",
    "AAC-LC 256 kbps final encode",
  ],
  excludedProcessing: [
    "dynamic loudness normalization",
    "per-cut gain normalization",
    "denoise",
    "EQ",
    "pitch shift",
    "time stretch",
    "voice conversion",
    "BGM",
  ],
  placements,
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
