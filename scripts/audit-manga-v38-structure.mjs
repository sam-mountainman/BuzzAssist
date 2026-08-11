#!/usr/bin/env node
// v38 structural gates (requirements ledger R52/R53/R55/R56):
//  - image pacing vs the measured reference distribution
//  - no narrator voice anywhere (narration = protagonist's cast voice)
//  - dialogue visibility: the speaker's face stays inside the camera crop
//    through their line, and for two-person shots the partner is inside the
//    crop by the final stretch of the shot (user-taught viewpoint rule)
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { normalizeCameraShotSequence, normalizePanelLayout } from "../lib/mangaVideoPipeline.mjs";
import { cameraAtProgress } from "../lib/mangaBubbleCameraPlacement.mjs";
import { writeJsonAtomic } from "../lib/canvasScene.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas/manga-videos/manga-photo-homecoming-001");
const manifestPath = join(episodeDir, "episode-manifest.json");
const outputPath = join(episodeDir, "v38-structure-audit.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

const FORBIDDEN_VOICE_IDS = new Set(
  manifest.production?.narrationVoicePolicy?.forbiddenVoiceIds || ["H8ZPDxbrPcks5hEsi2fq"],
);

// ---- R56: narrator voice ban -------------------------------------------------
const narratorViolations = (manifest.utterances || [])
  .filter((utterance) => FORBIDDEN_VOICE_IDS.has(utterance.voiceId)
    || FORBIDDEN_VOICE_IDS.has(utterance.audio?.voiceId))
  .map((utterance) => utterance.id);

// ---- R55: image pacing -------------------------------------------------------
// Group utterances by the illustration that hosts them (shot image; split
// pages count as one page illustration).
const utterancesById = new Map(manifest.utterances.map((u) => [u.id, u]));
const imageSegments = [];
for (const cut of manifest.cuts) {
  const utterances = cut.utteranceIds.map((id) => utterancesById.get(id)).filter(Boolean);
  const layout = normalizePanelLayout(cut.panelLayout, 1920, 1080, cut.imagePath);
  if (layout && !cut.panelLayout.enableFromUtteranceId) {
    imageSegments.push({
      cutId: cut.id,
      image: `${cut.id}-split-page`,
      utteranceCount: utterances.length,
      holdSeconds: Number(cut.timing?.durationSeconds || 0),
    });
    continue;
  }
  const shots = normalizeCameraShotSequence(cut, utterances, Number(cut.timing?.durationSeconds || 0));
  if (layout && cut.panelLayout.enableFromUtteranceId) {
    // Conditional page: lead-in shots up to the enabling utterance, then the page.
    const startId = cut.panelLayout.enableFromUtteranceId;
    const pageUtterances = [];
    let inPage = false;
    for (const utterance of utterances) {
      if (utterance.id === startId) inPage = true;
      if (inPage) pageUtterances.push(utterance);
    }
    const leadUtterances = utterances.filter((u) => !pageUtterances.includes(u));
    const pageStart = Math.min(...pageUtterances.map((u) => u.timing.bubbleStartInCutSeconds));
    imageSegments.push({
      cutId: cut.id,
      image: `${cut.id}-lead-in`,
      utteranceCount: leadUtterances.length,
      holdSeconds: pageStart,
    });
    imageSegments.push({
      cutId: cut.id,
      image: `${cut.id}-split-page`,
      utteranceCount: pageUtterances.length,
      holdSeconds: Number(cut.timing?.durationSeconds || 0) - pageStart,
    });
    continue;
  }
  // Merge consecutive shots that reuse the same illustration (e.g. the
  // thought continuation) into one hold.
  let current = null;
  for (const shot of shots) {
    const image = shot.imagePath;
    if (current && current.imagePath === image) {
      current.utteranceCount += (shot.utteranceIds || []).length;
      current.holdSeconds += shot.durationSeconds;
      continue;
    }
    if (current) imageSegments.push(current);
    current = {
      cutId: cut.id,
      image: image.split("/").pop(),
      imagePath: image,
      utteranceCount: (shot.utteranceIds || []).length,
      holdSeconds: shot.durationSeconds,
    };
  }
  if (current) imageSegments.push(current);
}
const dialogueSegments = imageSegments.filter((segment) => segment.utteranceCount > 0);
const multiShare = dialogueSegments.filter((segment) => segment.utteranceCount >= 2).length / dialogueSegments.length;
const holds = dialogueSegments.map((segment) => segment.holdSeconds).sort((a, b) => a - b);
const medianHold = holds[Math.floor(holds.length / 2)];
// Reference (v38-image-hold): conditional median 2 bubbles/image, hold median
// 8.9 s (p25 5.9). Gate: >=35% multi-bubble illustrations and median hold
// >=6 s, with no illustration held longer than the reference max (69.6 s).
const pacingGate = {
  id: "image-pacing-within-reference-range",
  multiBubbleShare: Number(multiShare.toFixed(3)),
  medianHoldSeconds: Number(medianHold.toFixed(2)),
  maxHoldSeconds: Number(Math.max(...holds).toFixed(2)),
  pass: multiShare >= 0.35 && medianHold >= 6 && Math.max(...holds) <= 69.6,
};

// ---- R52/R53: dialogue visibility -------------------------------------------
const visibilityRows = [];
for (const cut of manifest.cuts) {
  if (cut.panelLayout?.enabled && !cut.panelLayout.enableFromUtteranceId) continue;
  const utterances = cut.utteranceIds.map((id) => utterancesById.get(id)).filter(Boolean);
  const duration = Number(cut.timing?.durationSeconds || 0);
  const shots = normalizeCameraShotSequence(cut, utterances, duration);
  for (const shot of shots) {
    const faces = shot.sourceFaceBoundsBySpeakerId || {};
    for (const utteranceId of shot.utteranceIds || []) {
      const utterance = utterancesById.get(utteranceId);
      if (!utterance || utterance.preset === "narration") continue;
      const speakerFace = faces[utterance.speakerId];
      const offscreen = Array.isArray(shot.speakerOffscreenSpeakerIds)
        && shot.speakerOffscreenSpeakerIds.includes(utterance.speakerId);
      if (offscreen) continue;
      if (!speakerFace) {
        visibilityRows.push({ shotId: shot.id, utteranceId, pass: false, reason: "no-speaker-face" });
        continue;
      }
      const start = Math.max(shot.startSeconds, utterance.timing.bubbleStartInCutSeconds);
      const end = Math.min(shot.endSeconds, utterance.timing.bubbleEndInCutSeconds);
      const shotDuration = Math.max(1e-6, shot.durationSeconds);
      let visibleSamples = 0;
      const samples = 11;
      for (let index = 0; index < samples; index += 1) {
        const t = start + (end - start) * index / (samples - 1);
        const progress = Math.min(1, Math.max(0, (t - shot.startSeconds) / shotDuration));
        const state = cameraAtProgress(shot.camera, progress);
        const crop = 1 / state.zoom;
        const originX = Math.min(Math.max(state.focusX - crop / 2, 0), Math.max(0, 1 - crop));
        const originY = Math.min(Math.max(state.focusY - crop / 2, 0), Math.max(0, 1 - crop));
        const cx = speakerFace.x + speakerFace.width / 2;
        const cy = speakerFace.y + speakerFace.height / 2;
        if (cx >= originX && cx <= originX + crop && cy >= originY && cy <= originY + crop) visibleSamples += 1;
      }
      // Partner visibility over the final 40% of the shot.
      const partnerIds = Object.keys(faces).filter((id) => id !== utterance.speakerId);
      let partnerVisible = partnerIds.length === 0;
      for (const partnerId of partnerIds) {
        const partner = faces[partnerId];
        let seen = 0;
        for (let index = 0; index < 5; index += 1) {
          const progress = 0.6 + 0.4 * index / 4;
          const state = cameraAtProgress(shot.camera, progress);
          const crop = 1 / state.zoom;
          const originX = Math.min(Math.max(state.focusX - crop / 2, 0), Math.max(0, 1 - crop));
          const originY = Math.min(Math.max(state.focusY - crop / 2, 0), Math.max(0, 1 - crop));
          const px = partner.x + partner.width / 2;
          const py = partner.y + partner.height / 2;
          if (px >= originX - 0.02 && px <= originX + crop + 0.02 && py >= originY - 0.02 && py <= originY + crop + 0.02) seen += 1;
        }
        if (seen >= 3) partnerVisible = true;
      }
      visibilityRows.push({
        shotId: shot.id,
        utteranceId,
        speakerVisibleSamples: visibleSamples,
        speakerVisibleRatio: Number((visibleSamples / samples).toFixed(2)),
        partnerVisibleFinalStretch: partnerVisible,
        pass: visibleSamples / samples >= 0.8 && partnerVisible,
      });
    }
  }
}

// R57/R64b: keep the approved v3 dialogue chain, while narration deliberately
// uses the same protagonist voice with plain provider text. The user rejected
// semantic acting tags on narration, so requiring a non-empty performance
// prompt here would turn the repaired v42 metadata into a false failure.
const audioPerformanceViolations = (manifest.utterances || [])
  .filter((utterance) => {
    const audio = utterance.audio || {};
    const narration = utterance.preset === "narration";
    const narrationPolicyViolation = narration
      ? Boolean(String(utterance.performancePrompt || "").trim())
        || /^\s*\[[^\]]+\]/u.test(String(audio.providerText || ""))
      : !String(utterance.performancePrompt || "").trim();
    return audio.model !== "eleven_v3"
      || audio.generationMode !== "text-to-dialogue-with-timestamps"
      || narrationPolicyViolation
      || !Number.isFinite(Number(audio.maximumInternalPauseSeconds));
  })
  .map((utterance) => utterance.id);

const gates = [
  { id: "no-narrator-voice", pass: narratorViolations.length === 0, violations: narratorViolations },
  { id: "audio-performance-settings", pass: audioPerformanceViolations.length === 0, violations: audioPerformanceViolations },
  pacingGate,
  {
    id: "dialogue-speaker-and-partner-visibility",
    pass: visibilityRows.every((row) => row.pass),
    failures: visibilityRows.filter((row) => !row.pass),
  },
];
const result = {
  version: "v38-structure-audit-v1",
  imageSegments,
  visibilityRows,
  gates,
  pass: gates.every((gate) => gate.pass),
};
await writeJsonAtomic(outputPath, result);
process.stdout.write(`${JSON.stringify({ pass: result.pass, gates: gates.map((g) => ({ id: g.id, pass: g.pass })), pacing: pacingGate, outputPath }, null, 2)}\n`);
if (!result.pass) process.exitCode = 1;
