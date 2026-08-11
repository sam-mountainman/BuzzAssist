#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const projectDir = resolve(process.argv[2] || process.cwd());
const pipelineVersion = process.env.MANGA_DIALOGUE_VERSION === "v25" ? "v25" : "v22";
const manifestPath = resolve(process.argv[3] || join(
  projectDir,
  "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json",
));
const episodeDir = dirname(manifestPath);
const transcriptionPath = join(episodeDir, `${pipelineVersion}-elevenlabs-scribe-transcriptions.json`);
const outputPath = join(episodeDir, `${pipelineVersion}-elevenlabs-scribe-audit-final.json`);
const [manifest, transcription] = await Promise.all([
  readFile(manifestPath, "utf8").then(JSON.parse),
  readFile(transcriptionPath, "utf8").then(JSON.parse),
]);
const utteranceById = new Map(manifest.utterances.map((utterance) => [utterance.id, utterance]));
const cacheByPath = new Map(await Promise.all(transcription.cutReports.map(async (cutReport) => [
  cutReport.cachePath,
  JSON.parse(await readFile(cutReport.cachePath, "utf8")),
])));

const protectedTerms = {
  "cut-01": [["写真"], ["現像"]],
  "cut-02": [["商店街"], ["写真店"], ["蓮", "レン"], ["補修"]],
  "cut-03": [["澪", "ミオ"], ["東京"]],
  "cut-04": [["写真"], ["神谷"]],
  "cut-05": [["連絡"], ["助手"], ["作品"]],
  "cut-06": [["写真"], ["祖母"], ["感情"]],
  "cut-07": [["澪", "ミオ"], ["複製"], ["作成日時"], ["依頼票"]],
  "cut-08": [["展示"], ["主催者"], ["撮影者"], ["神谷"], ["契約"], ["解除"]],
  "cut-09": [["写真"], ["灯り", "明かり"]],
  "cut-10": [["写真"], ["蓮", "レン"], ["商店街"]],
};

function normalize(value) {
  const katakanaToHiragana = (text) => [...text].map((character) => (
    character >= "ァ" && character <= "ヶ"
      ? String.fromCharCode(character.charCodeAt(0) - 0x60)
      : character
  )).join("");
  return katakanaToHiragana(String(value || "").normalize("NFKC"))
    .replaceAll("みお", "澪")
    .replaceAll("れん", "蓮")
    .replaceAll("明かり", "灯り")
    .replaceAll("わから", "分から")
    .replace(/[\s\u3000、。！？!?…・「」『』,.—―:：]/gu, "");
}

function levenshtein(left, right) {
  const a = [...left];
  const b = [...right];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

const rows = transcription.cutReports.map((cutReport) => {
  const cut = manifest.cuts.find((entry) => entry.id === cutReport.cutId);
  const expected = cut.utteranceIds.map((id) => utteranceById.get(id)?.text || "").join("");
  const expectedNormalized = normalize(expected);
  const actualNormalized = normalize(cutReport.text);
  const distance = levenshtein(expectedNormalized, actualNormalized);
  const similarity = 1 - distance / Math.max(1, expectedNormalized.length, actualNormalized.length);
  const missingProtectedTerms = (protectedTerms[cutReport.cutId] || [])
    .filter((aliases) => !aliases.some((alias) => normalize(cutReport.text).includes(normalize(alias))))
    .map((aliases) => aliases[0]);
  const wordRows = (cacheByPath.get(cutReport.cachePath)?.words || [])
    .filter((word) => word.type === "word" && Number.isFinite(Number(word.logprob)));
  const meanWordLogProbability = wordRows.length
    ? wordRows.reduce((sum, word) => sum + Number(word.logprob), 0) / wordRows.length
    : null;
  const pass = similarity >= 0.93 && missingProtectedTerms.length === 0
    && (meanWordLogProbability === null || meanWordLogProbability >= -0.2);
  return {
    cutId: cutReport.cutId,
    expected,
    actual: cutReport.text,
    similarity: Number(similarity.toFixed(4)),
    editDistance: distance,
    missingProtectedTerms,
    meanWordLogProbability: meanWordLogProbability === null
      ? null
      : Number(meanWordLogProbability.toFixed(6)),
    pass,
  };
});

const report = {
  version: `${pipelineVersion}-elevenlabs-scribe-audit-final`,
  episodeId: manifest.id,
  model: "scribe_v2",
  languageCode: "jpn",
  transcriptionPath,
  thresholds: {
    minimumCutSimilarity: 0.93,
    minimumMeanWordLogProbability: -0.2,
    protectedTermsRequired: true,
  },
  cutCount: rows.length,
  passedCount: rows.filter((row) => row.pass).length,
  flaggedCount: rows.filter((row) => !row.pass).length,
  minimumSimilarity: Number(Math.min(...rows.map((row) => row.similarity)).toFixed(4)),
  meanSimilarity: Number((rows.reduce((sum, row) => sum + row.similarity, 0) / rows.length).toFixed(4)),
  pass: rows.every((row) => row.pass),
  rows,
  createdAt: new Date().toISOString(),
};
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
manifest.audioQuality = {
  ...(manifest.audioQuality || {}),
  scribeTranscriptionPath: transcriptionPath,
  scribeAuditPath: outputPath,
  scribeAuditPass: report.pass,
  scribeAuditPassedCutCount: report.passedCount,
  scribeAuditFlaggedCutCount: report.flaggedCount,
  scribeMinimumCutSimilarity: report.minimumSimilarity,
};
manifest.status = report.pass
  ? `${pipelineVersion}-elevenlabs-scribe-audited`
  : `${pipelineVersion}-elevenlabs-scribe-review`;
manifest.updatedAt = new Date().toISOString();
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify({
  outputPath,
  pass: report.pass,
  passedCount: report.passedCount,
  flaggedCount: report.flaggedCount,
  minimumSimilarity: report.minimumSimilarity,
  meanSimilarity: report.meanSimilarity,
}, null, 2) + "\n");
if (!report.pass) process.exitCode = 1;
