#!/usr/bin/env node
// Direct user instruction (2026-08-11): 「元々のナレーションがあったやつで
// やってほしい」 — restore the ORIGINAL narrator narrations (Koichi, exactly
// as approved in v37) for all 7 narration lines. Supersedes R56/R63's
// protagonist-voiced narration for this build. Extraction from the v37
// final video (audio PCM == approved master), same per-line loudnorm as
// every other utterance.
import { readFile, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";

const execFile = promisify(execFileCallback);
const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas/manga-videos/manga-photo-homecoming-001");
const manifestPath = join(episodeDir, "episode-manifest.json");
const backupManifestPath = join(episodeDir, "episode-manifest-pre-v38-narration-voice-r1.json");
const approvedVideoPath = join(projectDir, "canvas/assets/videos/manga-photo-homecoming-001-v37-thought-spotlight-baked-r1.mp4");
const assetsDir = join(projectDir, "canvas/assets/audio");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const backup = JSON.parse(await readFile(backupManifestPath, "utf8"));
const results = [];
for (const oldUtterance of backup.utterances) {
  if (oldUtterance.preset !== "narration") continue;
  const current = manifest.utterances.find((entry) => entry.id === oldUtterance.id);
  if (!current) throw new Error(`Utterance ${oldUtterance.id} missing from current manifest`);
  const oldAudio = oldUtterance.audio;
  const start = Number(oldUtterance.timing.audioStartSeconds);
  const duration = Number(oldAudio.durationSeconds);
  const fileName = `manga-photo-homecoming-001-${oldUtterance.id}-v43-original-narration.wav`;
  const filePath = join(assetsDir, fileName);
  const rawPath = `${filePath}.extract-raw.wav`;
  await execFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", start.toFixed(6), "-t", duration.toFixed(6),
    "-i", approvedVideoPath,
    "-vn", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s24le",
    rawPath,
  ]);
  const { stderr } = await execFile("ffmpeg", [
    "-hide_banner", "-nostats", "-i", rawPath,
    "-af", "loudnorm=I=-19:LRA=7:TP=-2:print_format=json",
    "-f", "null", "-",
  ]);
  const measured = JSON.parse(stderr.match(/\{[\s\S]*?\}/gu).at(-1));
  await execFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", rawPath,
    "-af", [
      "loudnorm=I=-19", "LRA=7", "TP=-2",
      `measured_I=${measured.input_i}`,
      `measured_LRA=${measured.input_lra}`,
      `measured_TP=${measured.input_tp}`,
      `measured_thresh=${measured.input_thresh}`,
      `offset=${measured.target_offset}`,
      "linear=true",
    ].join(":"),
    "-ar", "48000", "-ac", "1", "-c:a", "pcm_s24le",
    filePath,
  ]);
  await execFile("rm", ["-f", rawPath]);
  const { stdout } = await execFile("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "json", filePath,
  ]);
  if (Math.abs(Number(JSON.parse(stdout).format.duration) - duration) > 0.02) {
    throw new Error(`${oldUtterance.id}: extraction duration mismatch`);
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
    restoredFrom: "v37-final-video-extraction (original approved narrator)",
    restoredAt: new Date().toISOString(),
  };
  await writeFile(alignmentPath, `${JSON.stringify(restoredAudio, null, 2)}\n`, "utf8");
  current.audio = restoredAudio;
  current.voiceId = oldUtterance.voiceId;
  current.voiceName = oldUtterance.voiceName;
  current.voiceProfileId = oldUtterance.voiceProfileId;
  current.performancePrompt = oldUtterance.performancePrompt;
  current.speechText = oldUtterance.speechText ?? oldAudio.speechText;
  current.timing = null;
  results.push({ id: oldUtterance.id, fileName, durationSeconds: duration });
}
// The narrator ban (R56/R63) is superseded by the user's direct revert
// instruction; keep the policy object but clear the ban so gates agree.
manifest.production = {
  ...(manifest.production || {}),
  narrationVoicePolicy: {
    rule: "user reverted to the ORIGINAL approved narrator narrations (direct instruction, 2026-08-11)",
    forbiddenVoiceIds: [],
  },
};
for (const utterance of manifest.utterances) utterance.timing = utterance.timing ?? null;
manifest.updatedAt = new Date().toISOString();
await writeJsonAtomic(manifestPath, manifest);
process.stdout.write(`${JSON.stringify({ restored: results.map((r) => r.id) }, null, 2)}\n`);
