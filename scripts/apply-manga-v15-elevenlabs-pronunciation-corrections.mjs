#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const positionalArguments = process.argv.slice(2).filter((value) => !value.startsWith("--"));
const projectDir = resolve(positionalArguments[0] || process.cwd());
const manifestPath = resolve(
  positionalArguments[1]
  || join(projectDir, "canvas", "manga-videos", "manga-photo-homecoming-001", "episode-manifest.json"),
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const cleanupOnly = process.argv.includes("--cleanup-only");
const corrections = {
  "cut-01-u01": "しゃしんは、光がそこにあったことを証明する。",
  "cut-02-u01": "商店街の古い写真店で、/ɾeɴ/は、色あせた家族写真を一枚ずつ補修していた。",
  "cut-06-u02": "かんじょうで仕事を失うつもりか？　この町に君の居場所なんてない。",
  "cut-07-u02": "去年ふくせいしたデータも、さくせいにちじも、いらいひょうも残っています。",
  "cut-08-u01": "てんじのしゅさいしゃへ送る。さつえいしゃが誰か、私の名前で確かめてもらう。",
  "cut-10-u02": "それから……今度は、レンの隣にいたい。",
};

for (const utterance of manifest.utterances || []) {
  delete utterance.provider;
  delete utterance.speechTuning;
  delete utterance.styleBertVoiceKey;
  const authoredSpeech = String(utterance.speechOverride || utterance.speechText || utterance.text || "");
  utterance.speechAuditText = authoredSpeech.replaceAll("/ɾeɴ/", "レン");
  if (cleanupOnly) continue;
  const corrected = corrections[utterance.id];
  if (!corrected) continue;
  utterance.speechOverride = corrected;
  utterance.speechText = corrected;
  utterance.speechAuditText = corrected.replaceAll("/ɾeɴ/", "レン");
  utterance.audio = null;
  utterance.timing = null;
  if (manifest.jobs?.speech) delete manifest.jobs.speech[utterance.id];
}
if (!cleanupOnly) {
  manifest.status = "speech-pronunciation-correction-planned-v15-elevenlabs-r2";
  manifest.audioQuality = {
    ...(manifest.audioQuality || {}),
    pronunciationCorrectionIds: Object.keys(corrections),
    pronunciationCorrectionPolicy: "kana-lock-only-for-whisper-flagged-ambiguous-terms-v15-r2",
  };
}
manifest.updatedAt = new Date().toISOString();
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  manifestPath,
  cleanupOnly,
  corrections: cleanupOnly ? [] : Object.keys(corrections),
}, null, 2)}\n`);
