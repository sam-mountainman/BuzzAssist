#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const projectDir = resolve(process.argv[2] || process.cwd());
const manifestPath = resolve(
  process.argv[3]
    || join(projectDir, "canvas", "manga-videos", "manga-photo-homecoming-001", "episode-manifest.json"),
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const seedSalt = process.env.V11_CORRECTION_SEED_SALT || "r4";
const renTestVoice = process.env.V11_REN_TEST_VOICE || "";
const corrections = {
  "cut-02-u01": "しょうてんがいの古いしゃしん店で、れんは、色あせた家族しゃしんを一枚ずつ、ほしゅうしていた。",
  "cut-03-u01": "その言い方、昔と変わらないね。",
  "cut-06-u01": "私は戻らない。あの写真は、祖母の最後の夏を撮った、大切な記録なの。",
  "cut-07-u02": "去年ふくせいしたデータも、さくせい、にちじも、いらいひょうも残っています。",
  "cut-08-u01": "展示の主催者へ送る。撮影者が誰か、私の名前で確かめてもらう。",
  "cut-08-u02": "よくしゅう、てんじ、は中止され、かみやとのけいやくもかいじょされた。",
  "cut-10-u02": "それから……今度は、れーんの隣にいたい。",
  "cut-10-u04": "雨上がりの商店街で、二人の新しい一枚目が、静かに写真になっていった。",
};
const displayCorrections = {
  "cut-03-u01": "その言い方、昔と変わらないね",
  "cut-10-u04": "雨上がりの商店街で、二人の新しい一枚目が静かに写真になっていった。",
};
for (const utterance of manifest.utterances || []) {
  if (!corrections[utterance.id]) continue;
  if (displayCorrections[utterance.id]) utterance.text = displayCorrections[utterance.id];
  utterance.speechOverride = corrections[utterance.id];
  utterance.speechTuning = {
    sdpRatio: 0.18,
    noise: ["cut-03-u01", "cut-06-u01", "cut-08-u01", "cut-08-u02", "cut-10-u02", "cut-10-u04"].includes(utterance.id) ? 0.25 : 0.35,
    noiseW: ["cut-03-u01", "cut-06-u01", "cut-08-u01", "cut-08-u02", "cut-10-u02", "cut-10-u04"].includes(utterance.id) ? 0.45 : 0.55,
    intonationScale: utterance.id === "cut-03-u01" ? 1.08 : utterance.id === "cut-10-u02" ? 0.98 : 1,
    length: ["cut-03-u01", "cut-10-u02"].includes(utterance.id) ? 1.1 : 1.07,
    seedSalt,
    reason: "Whisper-v11 pronunciation clarification candidate",
  };
  if (["cut-03-u01", "cut-10-u02"].includes(utterance.id) && renTestVoice) {
    utterance.styleBertVoiceKey = renTestVoice;
  } else {
    delete utterance.styleBertVoiceKey;
  }
}
manifest.audioQuality = {
  ...(manifest.audioQuality || {}),
  pronunciationCorrectionIds: Object.keys(corrections),
  pronunciationCorrectionPolicy: "lower-stochasticity-plus-natural-phrase-boundaries-v11",
};
manifest.status = "speech-pronunciation-correction-planned-v11";
manifest.updatedAt = new Date().toISOString();
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ manifestPath, corrections: Object.keys(corrections), seedSalt, renTestVoice }, null, 2)}\n`);
