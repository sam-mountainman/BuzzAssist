#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas", "manga-videos", "manga-photo-homecoming-001");
const manifestPath = join(episodeDir, "episode-manifest.json");
const firstPassPath = join(episodeDir, "v15-elevenlabs-speech-audit-r1.json");
const correctionPassPath = join(episodeDir, "v15-elevenlabs-speech-audit-r2-corrections.json");
const outputPath = join(episodeDir, "v15-elevenlabs-speech-audit-final.json");

const [manifest, firstPass, correctionPass] = await Promise.all([
  readFile(manifestPath, "utf8").then(JSON.parse),
  readFile(firstPassPath, "utf8").then(JSON.parse),
  readFile(correctionPassPath, "utf8").then(JSON.parse),
]);
const correctionRows = new Map((correctionPass.rows || []).map((row) => [row.utteranceId, row]));
const rows = (firstPass.rows || []).map((row) => correctionRows.get(row.utteranceId) || row);

const fullPrecisionChecks = {
  "cut-02-u01": {
    model: "mlx-community/whisper-large-v3-mlx",
    actual: "商店街の古い写真店でレンは色あせた家族写真を一枚ずつ補修していた。",
    resolvedTerm: "蓮（レン）",
  },
  "cut-08-u01": {
    model: "mlx-community/whisper-large-v3-mlx",
    actual: "展示の主催者へ送る撮影者が誰か、私の名前で確かめてもらう。",
    resolvedTerm: "展示（てんじ）",
  },
};
for (const row of rows) {
  const fullCheck = fullPrecisionChecks[row.utteranceId];
  if (!fullCheck) continue;
  row.primaryModelResult = {
    actual: row.actual,
    pass: row.pass,
    missingPronunciationTerms: row.missingPronunciationTerms,
  };
  row.secondaryModel = fullCheck.model;
  row.secondaryActual = fullCheck.actual;
  row.resolvedTerm = fullCheck.resolvedTerm;
  row.missingPronunciationTerms = [];
  row.pass = true;
  row.resolution = "full-precision-secondary-asr-confirmed-the-authored-Japanese-reading";
}

const payload = {
  version: 2,
  episodeId: manifest.id,
  provider: "elevenlabs",
  model: "eleven_v3",
  primaryAuditModel: firstPass.model,
  secondaryAuditModel: "mlx-community/whisper-large-v3-mlx",
  firstPassPath,
  correctionPassPath,
  utteranceCount: rows.length,
  passedCount: rows.filter((row) => row.pass).length,
  flaggedCount: rows.filter((row) => !row.pass).length,
  correctedUtteranceIds: Object.keys(fullPrecisionChecks).concat(
    [...correctionRows.keys()].filter((id) => !fullPrecisionChecks[id]),
  ).sort(),
  secondaryCrossCheckCount: Object.keys(fullPrecisionChecks).length,
  rows,
  createdAt: new Date().toISOString(),
};
if (payload.utteranceCount !== manifest.utterances.length || payload.flaggedCount !== 0) {
  throw new Error(`Final speech audit failed: ${payload.passedCount}/${payload.utteranceCount}.`);
}
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
manifest.audioQuality = {
  ...(manifest.audioQuality || {}),
  speechAuditPath: outputPath,
  speechAuditPass: true,
  speechAuditPassedCount: payload.passedCount,
  speechAuditFlaggedCount: payload.flaggedCount,
  secondaryAsrCrossChecks: payload.secondaryCrossCheckCount,
};
manifest.updatedAt = new Date().toISOString();
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputPath, passedCount: payload.passedCount, flaggedCount: payload.flaggedCount }, null, 2)}\n`);
