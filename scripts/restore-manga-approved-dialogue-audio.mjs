#!/usr/bin/env node
// R60: the v39 re-staging replaced the takes of five cuts, which also
// replaced the USER-APPROVED performances of the ordinary dialogue lines in
// those cuts (and the original take files were overwritten — fixed going
// forward by digest-named takes). The approved audio still exists verbatim
// inside the v37 final video (audio PCM == the approved v35 master), so the
// dialogue lines are restored by exact extraction on the v37 timeline.
// Narration lines keep their new protagonist-voiced takes.
import { readFile, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { join, resolve, basename } from "node:path";
import { promisify } from "node:util";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";

const execFile = promisify(execFileCallback);
const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas/manga-videos/manga-photo-homecoming-001");
const manifestPath = join(episodeDir, "episode-manifest.json");
const backupManifestPath = join(episodeDir, "episode-manifest-pre-v38-narration-voice-r1.json");
const approvedVideoPath = join(projectDir, "canvas/assets/videos/manga-photo-homecoming-001-v37-thought-spotlight-baked-r1.mp4");
const assetsDir = join(projectDir, "canvas/assets/audio");

// R60 follow-up: quantitative comparison showed the re-sliced lines in the
// untouched cuts also drifted from the approved internal pacing (duration
// deltas up to -411 ms from silence-compaction differences), so EVERY
// non-narration line is restored from the approved master. Narration lines
// (protagonist-voiced, R56) keep their newly directed takes.
const backupForIds = JSON.parse(await readFile(backupManifestPath, "utf8"));
const RESTORE_IDS = backupForIds.utterances
  .filter((utterance) => utterance.preset !== "narration")
  .map((utterance) => utterance.id);

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const backup = JSON.parse(await readFile(backupManifestPath, "utf8"));
const results = [];
for (const id of RESTORE_IDS) {
  const oldUtterance = backup.utterances.find((entry) => entry.id === id);
  const current = manifest.utterances.find((entry) => entry.id === id);
  if (!oldUtterance || !current) throw new Error(`Utterance ${id} missing`);
  const oldAudio = oldUtterance.audio;
  const start = Number(oldUtterance.timing.audioStartSeconds);
  const duration = Number(oldAudio.durationSeconds);
  const fileName = `manga-photo-homecoming-001-${id}-v40-approved-restored.wav`;
  const filePath = join(assetsDir, fileName);
  const rawPath = `${filePath}.extract-raw.wav`;
  await execFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", start.toFixed(6), "-t", duration.toFixed(6),
    "-i", approvedVideoPath,
    "-vn", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s24le",
    rawPath,
  ]);
  // Same two-pass line loudnorm as every other utterance (R28: no
  // line-to-line loudness variation), since the extraction carries the v37
  // episode master gain.
  const { stderr } = await execFile("ffmpeg", [
    "-hide_banner", "-nostats", "-i", rawPath,
    "-af", "loudnorm=I=-19:LRA=7:TP=-2:print_format=json",
    "-f", "null", "-",
  ]);
  const measuredLoudness = JSON.parse(stderr.match(/\{[\s\S]*?\}/gu).at(-1));
  await execFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", rawPath,
    "-af", [
      "loudnorm=I=-19", "LRA=7", "TP=-2",
      `measured_I=${measuredLoudness.input_i}`,
      `measured_LRA=${measuredLoudness.input_lra}`,
      `measured_TP=${measuredLoudness.input_tp}`,
      `measured_thresh=${measuredLoudness.input_thresh}`,
      `offset=${measuredLoudness.target_offset}`,
      "linear=true",
    ].join(":"),
    "-ar", "48000", "-ac", "1", "-c:a", "pcm_s24le",
    filePath,
  ]);
  await execFile("rm", ["-f", rawPath]);
  const { stdout } = await execFile("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "json", filePath,
  ]);
  const measured = Number(JSON.parse(stdout).format.duration);
  if (Math.abs(measured - duration) > 0.02) {
    throw new Error(`${id}: extracted ${measured}s but expected ${duration}s`);
  }
  const alignmentFileName = `${fileName}.json`;
  const alignmentPath = join(projectDir, "canvas/audio-alignments", alignmentFileName);
  const restoredAudio = {
    ...oldAudio,
    fileName,
    filePath,
    assetUrl: `/excalidraw-assets/audio/${encodeURIComponent(fileName)}`,
    alignmentFileName,
    alignmentPath,
    restoredFrom: "v37-final-video-extraction (approved PCM)",
    restoredAt: new Date().toISOString(),
  };
  await writeFile(alignmentPath, `${JSON.stringify(restoredAudio, null, 2)}\n`, "utf8");
  current.audio = restoredAudio;
  current.voiceId = oldUtterance.voiceId;
  current.voiceName = oldUtterance.voiceName;
  current.voiceProfileId = oldUtterance.voiceProfileId;
  current.performancePrompt = oldUtterance.performancePrompt;
  current.speechText = oldUtterance.speechText ?? oldUtterance.audio?.speechText;
  current.timing = null;
  results.push({ id, fileName, durationSeconds: duration });
}
for (const utterance of manifest.utterances) utterance.timing = utterance.timing ?? null;
manifest.updatedAt = new Date().toISOString();
await writeJsonAtomic(manifestPath, manifest);
process.stdout.write(`${JSON.stringify({ restored: results }, null, 2)}\n`);
