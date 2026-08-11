#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const projectDir = resolve(process.argv[2] || process.cwd());
const manifestPath = resolve(process.argv[3] || join(
  projectDir,
  "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json",
));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const rows = [];

// Keep the measured non-speaker head annotation soft. The user's placement
// rule permits a balloon over a non-speaking person when the active speaker
// and text remain clear; only active-speaker heads are the 0px hard gate.
const cut04 = (manifest.cuts || []).find((cut) => cut.id === "cut-04");
const theftShot = (cut04?.cameraSequence || []).find((shot) => shot.id === "cut-04-v38-shared-theft");
const backgroundHead = (theftShot?.sourceAvoidRegions || []).find((region) => (
  region.id === "manga-photo-homecoming-001-character-1-face-background"
));
if (!backgroundHead) throw new Error("cut-04 measured background head annotation is missing");
delete backgroundHead.hard;

// Each cut is quantized to whole frames before concat. Reserve two frame
// periods even with a non-zero fade so one decoded frame is guaranteed to be
// free of both the old fade-out and the new alpha-zero overlay.
const fps = Math.max(12, Number(manifest.video?.fps) || 30);
manifest.video = {
  ...(manifest.video || {}),
  bubbleTransitionGapSeconds: 2 / fps,
};

for (const utterance of manifest.utterances || []) {
  if (utterance.preset !== "narration") continue;
  const audio = utterance.audio || {};
  const sourceMetadataPath = String(audio.sourceDialogueMetadataPath || "");
  const alignmentPath = String(audio.alignmentPath || "");
  if (!sourceMetadataPath || !alignmentPath) {
    throw new Error(`${utterance.id} lacks source/alignment metadata paths`);
  }
  const source = JSON.parse(await readFile(sourceMetadataPath, "utf8"));
  const inputIndex = Number(audio.dialogueInputIndex);
  const providerText = String(source.inputs?.[inputIndex]?.text || "").trim();
  if (!providerText) throw new Error(`${utterance.id} source metadata has no provider input`);
  if (/^\s*\[[^\]]+\]/u.test(providerText)) {
    throw new Error(`${utterance.id} still contains a narration performance tag: ${providerText}`);
  }

  const sidecar = JSON.parse(await readFile(alignmentPath, "utf8"));
  sidecar.providerText = providerText;
  sidecar.performancePrompt = "";
  sidecar.metadataCorrection = {
    reason: "R64b/R65 exact plain-narration provider input synchronization",
    sourceMetadataPath,
    correctedAt: new Date().toISOString(),
  };
  await writeFile(alignmentPath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");

  utterance.performancePrompt = "";
  delete utterance.semanticPerformanceIntent;
  utterance.audio = { ...audio, ...sidecar };
  rows.push({ utteranceId: utterance.id, providerText, sourceMetadataPath, alignmentPath });
}

// R65: v41 final-master correlation measured two audible gaps outside their
// authored targets. Overlap only the click-safe silent padding; the approved
// WAV samples themselves remain byte-for-byte unchanged.
const rhythmCorrections = {
  "cut-05-u02": {
    pauseBeforeSeconds: -0.075187,
    v41ActualGapSeconds: 0.235187,
    targetGapSeconds: 0.16,
  },
  "cut-10-u02": {
    pauseBeforeSeconds: 0.06,
    v41ActualGapSeconds: 0.38,
    targetGapSeconds: 0.32,
  },
};
for (const [utteranceId, correction] of Object.entries(rhythmCorrections)) {
  const utterance = (manifest.utterances || []).find((entry) => entry.id === utteranceId);
  if (!utterance?.audio) throw new Error(`${utteranceId} audio is missing for rhythm correction`);
  utterance.pauseBeforeSeconds = correction.pauseBeforeSeconds;
  utterance.audio.authoredGapBeforeSeconds = correction.pauseBeforeSeconds;
  utterance.audio.rhythmCorrection = {
    sourceAudit: "v41-master-assembly-audit.json",
    method: "silent-padding overlap; approved PCM preserved",
    ...correction,
  };
  const alignmentPath = String(utterance.audio.alignmentPath || "");
  if (alignmentPath) {
    const alignment = JSON.parse(await readFile(alignmentPath, "utf8"));
    alignment.authoredGapBeforeSeconds = correction.pauseBeforeSeconds;
    alignment.rhythmCorrection = utterance.audio.rhythmCorrection;
    await writeFile(alignmentPath, `${JSON.stringify(alignment, null, 2)}\n`, "utf8");
  }
}

manifest.speech = {
  ...(manifest.speech || {}),
  performancePromptPolicy: {
    ...(manifest.speech?.performancePromptPolicy || {}),
    oneContextualVoiceTagPerUtterance: "dialogue-only",
    semanticClauseFocusAndBreathIntent: false,
    plainNarrationMatchesOrdinaryDialogue: true,
  },
};
manifest.updatedAt = new Date().toISOString();
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const reportPath = join(dirname(manifestPath), "v42-audio-metadata-repair.json");
await writeFile(reportPath, `${JSON.stringify({
  version: "v42-audio-metadata-repair",
  manifestPath,
  narrationCount: rows.length,
  allPlainProviderText: rows.every((row) => !/^\s*\[/u.test(row.providerText)),
  rows,
  rhythmCorrections,
  createdAt: new Date().toISOString(),
}, null, 2)}\n`, "utf8");

process.stdout.write(`${JSON.stringify({ reportPath, narrationCount: rows.length })}\n`);
