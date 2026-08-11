#!/usr/bin/env node
// R56: 「ナレーターみたいな人はいない。ナレーターみたいな音声は、普通に
// 主人公の音声で」— every narration line is voiced by the protagonist (蓮,
// character-1, voice profile photo-ren-jp-v15 / Asahi). The dedicated
// narrator voice (Koichi) must not appear anywhere in the episode.
//
// This script only reassigns the voice/speaker metadata; regenerate the
// affected audio afterwards with:
//   node scripts/build-manga-video.mjs speech --manifest-path <manifest> \
//     --utterance-ids <the printed list> --speech-concurrency 1
import { copyFile, readFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas/manga-videos/manga-photo-homecoming-001");
const manifestPath = join(episodeDir, "episode-manifest.json");
const backupPath = join(episodeDir, "episode-manifest-pre-v38-narration-voice-r1.json");

const PROTAGONIST = {
  speakerId: "manga-photo-homecoming-001-character-1",
  speakerName: "高瀬 蓮",
  voiceProfileId: "photo-ren-jp-v15",
  voiceId: "GKDaBI8TKSBJVhsCLD6n",
  voiceName: "Asahi - Calm and Natural",
};
const FORBIDDEN_NARRATOR_VOICE_ID = "H8ZPDxbrPcks5hEsi2fq";

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
let backupExists = false;
try { await access(backupPath); backupExists = true; } catch {}
if (!backupExists) await copyFile(manifestPath, backupPath);

const reassigned = [];
for (const utterance of manifest.utterances || []) {
  if (utterance.voiceId !== FORBIDDEN_NARRATOR_VOICE_ID) continue;
  utterance.speakerId = PROTAGONIST.speakerId;
  // Keep the caption-card presentation (preset narration) — only the VOICE
  // becomes the protagonist's. speakerName stays ナレーション for the ledger
  // of on-screen typography, but the voice fields switch entirely.
  utterance.voiceProfileId = PROTAGONIST.voiceProfileId;
  utterance.voiceId = PROTAGONIST.voiceId;
  utterance.voiceName = PROTAGONIST.voiceName;
  // Narration read by the protagonist is inner-monologue tone, not a
  // detached announcer: keep the calm performance without narrator styling.
  if (utterance.voiceSettings) utterance.voiceSettings = { ...utterance.voiceSettings };
  reassigned.push(utterance.id);
}
if (manifest.defaultVoiceId === FORBIDDEN_NARRATOR_VOICE_ID) {
  manifest.defaultVoiceId = PROTAGONIST.voiceId;
  manifest.defaultVoiceName = PROTAGONIST.voiceName;
}
manifest.production = {
  ...(manifest.production || {}),
  narrationVoicePolicy: {
    rule: "no dedicated narrator voice; narration is the protagonist's cast voice (user directive, ledger R56)",
    forbiddenVoiceIds: [FORBIDDEN_NARRATOR_VOICE_ID],
    narratorVoiceId: PROTAGONIST.voiceId,
  },
};
manifest.updatedAt = new Date().toISOString();
await writeJsonAtomic(manifestPath, manifest);
process.stdout.write(`${JSON.stringify({ reassigned, regenerateCommand: `node scripts/build-manga-video.mjs speech --manifest-path ${manifestPath} --utterance-ids ${reassigned.join(",")}` }, null, 2)}\n`);
