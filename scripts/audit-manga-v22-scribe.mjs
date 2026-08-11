#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { requireElevenLabsApiKey } from "../lib/speechGeneration.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const pipelineVersion = process.env.MANGA_DIALOGUE_VERSION === "v25" ? "v25" : "v22";
const manifestPath = resolve(process.argv[3] || join(
  projectDir,
  "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json",
));
const episodeDir = dirname(manifestPath);
const generationReportPath = join(episodeDir, `${pipelineVersion}-elevenlabs-dialogue-generation.json`);
const cacheDir = join(episodeDir, `.${pipelineVersion}-scribe`);
const outputPath = join(episodeDir, `${pipelineVersion}-elevenlabs-scribe-transcriptions.json`);

const [manifest, generationReport] = await Promise.all([
  readFile(manifestPath, "utf8").then(JSON.parse),
  readFile(generationReportPath, "utf8").then(JSON.parse),
]);
const utteranceById = new Map(manifest.utterances.map((utterance) => [utterance.id, utterance]));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function transcribeCut(cutReport) {
  const audioBytes = await readFile(cutReport.sourcePath);
  const inputHash = sha256(audioBytes);
  const cachePath = join(cacheDir, cutReport.cutId + "-scribe-v2.json");
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    if (cached.inputHash === inputHash && cached.model === "scribe_v2") {
      return { ...cached, cachePath, reused: true };
    }
  } catch {}

  const apiKey = await requireElevenLabsApiKey();
  const body = new FormData();
  body.append("file", new Blob([audioBytes], { type: "audio/wav" }), cutReport.cutId + ".wav");
  body.append("model_id", "scribe_v2");
  body.append("language_code", "jpn");
  body.append("tag_audio_events", "false");
  body.append("diarize", "false");
  body.append("timestamps_granularity", "word");
  body.append("no_verbatim", "false");
  body.append("seed", String((pipelineVersion === "v25" ? 250000 : 220000) + Number(cutReport.cutId.replace(/\D/gu, ""))));
  const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.detail?.message || payload?.detail || payload?.message || response.statusText;
    throw new Error(
      "ElevenLabs Scribe failed for " + cutReport.cutId + " (" + response.status + "): "
      + (typeof detail === "string" ? detail : JSON.stringify(detail)),
    );
  }
  const result = {
    version: 1,
    cutId: cutReport.cutId,
    inputHash,
    model: "scribe_v2",
    languageCode: payload?.language_code || "",
    languageProbability: payload?.language_probability ?? null,
    text: payload?.text || "",
    words: Array.isArray(payload?.words) ? payload.words : [],
    createdAt: new Date().toISOString(),
  };
  await writeFile(cachePath, JSON.stringify(result, null, 2) + "\n", "utf8");
  return { ...result, cachePath, reused: false };
}

function actualForBounds(words, startSeconds, endSeconds) {
  return words
    .filter((word) => word.type === "word")
    .filter((word) => {
      const start = Number(word.start);
      const end = Number(word.end);
      const midpoint = (start + end) / 2;
      return Number.isFinite(midpoint) && midpoint >= startSeconds - 0.08 && midpoint <= endSeconds + 0.08;
    })
    .map((word) => String(word.text || ""))
    .join("")
    .trim();
}

await mkdir(cacheDir, { recursive: true });
const cutReports = [];
const rows = [];
for (const cutReport of generationReport.cutReports) {
  const transcript = await transcribeCut(cutReport);
  const utteranceRows = cutReport.rows.map((row) => {
    const utterance = utteranceById.get(row.utteranceId);
    const actual = actualForBounds(
      transcript.words,
      Number(row.sourceDialogueSegmentStartSeconds ?? row.sourceDialogueStartSeconds),
      Number(row.sourceDialogueSegmentEndSeconds ?? row.sourceDialogueEndSeconds),
    );
    const mapped = {
      utteranceId: row.utteranceId,
      speakerName: utterance?.speakerName || "",
      expected: utterance?.text || "",
      speechText: utterance?.speechAuditText || utterance?.speechText || utterance?.text || "",
      actual,
      sourceDialogueStartSeconds: row.sourceDialogueStartSeconds,
      sourceDialogueEndSeconds: row.sourceDialogueEndSeconds,
      sourceDialogueSegmentStartSeconds: row.sourceDialogueSegmentStartSeconds,
      sourceDialogueSegmentEndSeconds: row.sourceDialogueSegmentEndSeconds,
      cutId: cutReport.cutId,
    };
    rows.push(mapped);
    return mapped;
  });
  cutReports.push({
    cutId: cutReport.cutId,
    reused: transcript.reused,
    languageCode: transcript.languageCode,
    languageProbability: transcript.languageProbability,
    text: transcript.text,
    cachePath: transcript.cachePath,
    rows: utteranceRows,
  });
  process.stdout.write(JSON.stringify({
    cutId: cutReport.cutId,
    reused: transcript.reused,
    languageCode: transcript.languageCode,
    languageProbability: transcript.languageProbability,
    transcript: transcript.text,
  }, null, 0) + "\n");
}

const report = {
  version: `${pipelineVersion}-elevenlabs-scribe-v2`,
  episodeId: manifest.id,
  model: "scribe_v2",
  languageCode: "jpn",
  generationReportPath,
  utteranceCount: rows.length,
  cutCount: cutReports.length,
  cutReports,
  rows,
  createdAt: new Date().toISOString(),
};
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify({ outputPath, utteranceCount: rows.length, cutCount: cutReports.length }) + "\n");
