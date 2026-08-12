import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { writeJsonAtomic } from "./canvasScene.mjs";

const DEFAULT_SILENCE_THRESHOLD_DB = -48;

function finiteNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(`${command} exited with ${code}: ${stderr.slice(-2500)}`));
    });
  });
}

export function parseSilenceDetectLog(logText) {
  const events = [];
  let pendingStart = null;
  for (const line of String(logText ?? "").split("\n")) {
    const start = line.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/u);
    if (start) pendingStart = Math.max(0, finiteNumber(start[1], 0));
    const end = line.match(/silence_end:\s*(-?\d+(?:\.\d+)?)\s*\|\s*silence_duration:\s*(\d+(?:\.\d+)?)/u);
    if (end) {
      const endSeconds = Math.max(0, finiteNumber(end[1], 0));
      const durationSeconds = Math.max(0, finiteNumber(end[2], 0));
      events.push({
        startSeconds: pendingStart ?? Math.max(0, endSeconds - durationSeconds),
        endSeconds,
        durationSeconds,
      });
      pendingStart = null;
    }
  }
  return events;
}

export function parseEbur128Summary(logText) {
  const summary = String(logText ?? "").split("Summary:").at(-1) || "";
  const value = (pattern) => {
    const raw = summary.match(pattern)?.[1];
    return raw === "-inf" ? null : finiteNumber(raw, null);
  };
  return {
    integratedLufs: value(/I:\s*(-inf|-?\d+(?:\.\d+)?)\s*LUFS/u),
    loudnessRangeLu: value(/LRA:\s*(-inf|-?\d+(?:\.\d+)?)\s*LU/u),
    truePeakDbfs: value(/Peak:\s*(-inf|-?\d+(?:\.\d+)?)\s*dBFS/u),
  };
}

function manifestCoverage(manifest) {
  const utteranceById = new Map((manifest.utterances || []).map((entry) => [entry.id, entry]));
  return (manifest.cuts || []).map((cut) => {
    const utterances = (cut.utteranceIds || []).map((id) => utteranceById.get(id)).filter(Boolean);
    const missingAudioIds = utterances
      .filter((utterance) => !utterance.audio?.filePath || !(finiteNumber(utterance.audio?.durationSeconds, 0) > 0))
      .map((utterance) => utterance.id);
    return {
      cutId: cut.id,
      utteranceCount: utterances.length,
      missingAudioIds,
      pass: utterances.length > 0 && missingAudioIds.length === 0,
    };
  });
}

export async function auditMangaVideoQuality(options = {}) {
  const videoPath = resolve(String(options.videoPath || ""));
  const manifestPath = resolve(String(options.manifestPath || ""));
  if (!options.videoPath || !options.manifestPath) throw new Error("videoPath and manifestPath are required.");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const probeResult = await run(options.ffprobePath || "ffprobe", [
    "-v", "error", "-show_entries", "format=duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels",
    "-of", "json", videoPath,
  ]);
  const probe = JSON.parse(probeResult.stdout);
  const audioResult = await run(options.ffmpegPath || "ffmpeg", [
    "-hide_banner", "-nostats", "-i", videoPath,
    "-af", `ebur128=peak=true,silencedetect=noise=${options.silenceThresholdDb ?? DEFAULT_SILENCE_THRESHOLD_DB}dB:d=${options.minimumSilenceSeconds ?? 0.6}`,
    "-f", "null", "-",
  ]);
  const durationSeconds = finiteNumber(probe.format?.duration, 0);
  const expectedDurationSeconds = finiteNumber(manifest.metrics?.videoDurationSeconds, 0);
  const durationDeltaSeconds = Math.abs(durationSeconds - expectedDurationSeconds);
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const videoStream = streams.find((stream) => stream.codec_type === "video") || null;
  const audioStream = streams.find((stream) => stream.codec_type === "audio") || null;
  const expectedWidth = finiteNumber(options.expectedWidth ?? manifest.video?.width, 1920);
  const expectedHeight = finiteNumber(options.expectedHeight ?? manifest.video?.height, 1080);
  const silenceEvents = parseSilenceDetectLog(audioResult.stderr);
  const maxAllowedSilenceSeconds = finiteNumber(options.maxAllowedSilenceSeconds, 1);
  const longSilences = silenceEvents.filter((event) => event.durationSeconds > maxAllowedSilenceSeconds);
  const loudness = parseEbur128Summary(audioResult.stderr);
  const cuts = manifestCoverage(manifest);
  const gates = {
    format: Boolean(videoStream && audioStream),
    resolution: videoStream?.width === expectedWidth && videoStream?.height === expectedHeight,
    duration: durationDeltaSeconds <= finiteNumber(options.durationToleranceSeconds, 0.25),
    cutAudioCoverage: cuts.every((cut) => cut.pass),
    longSilence: longSilences.length === 0,
    integratedLoudness: loudness.integratedLufs !== null
      && loudness.integratedLufs >= finiteNumber(options.minimumIntegratedLufs, -24)
      && loudness.integratedLufs <= finiteNumber(options.maximumIntegratedLufs, -12),
    truePeak: loudness.truePeakDbfs !== null
      && loudness.truePeakDbfs <= finiteNumber(options.maximumTruePeakDbfs, -1),
  };
  const report = {
    version: 1,
    episodeId: manifest.id,
    videoPath,
    manifestPath,
    generatedAt: new Date().toISOString(),
    pass: Object.values(gates).every(Boolean),
    gates,
    media: {
      durationSeconds,
      expectedDurationSeconds,
      durationDeltaSeconds,
      expectedWidth,
      expectedHeight,
      sizeBytes: finiteNumber(probe.format?.size, 0),
      bitRate: finiteNumber(probe.format?.bit_rate, 0),
      video: videoStream,
      audio: audioStream,
    },
    loudness,
    silence: {
      thresholdDb: finiteNumber(options.silenceThresholdDb, DEFAULT_SILENCE_THRESHOLD_DB),
      minimumEventSeconds: finiteNumber(options.minimumSilenceSeconds, 0.6),
      maxAllowedSilenceSeconds,
      events: silenceEvents,
      longSilences,
    },
    cuts,
  };
  if (options.outputPath) {
    await writeJsonAtomic(resolve(options.outputPath), report);
  }
  return report;
}
