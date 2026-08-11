#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";
import {
  auditMangaPanelPageCameraGrammar,
  auditMangaShotCameraGrammar,
} from "../lib/mangaPageCameraGrammar.mjs";

const execFileAsync = promisify(execFile);
const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas/manga-videos/manga-photo-homecoming-001");
const manifestPath = join(episodeDir, "episode-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const reportPath = resolve(
  process.argv[4] || join(episodeDir, "v32-master-quality-audit.json"),
);
const expectedVideoPath = resolve(
  process.argv[3]
    || manifest.outputs?.reviewVideo?.filePath
    || manifest.outputs?.finalVideo?.filePath
    || join(projectDir, "canvas/assets/videos/manga-photo-homecoming-001-v32-whole-page-camera-r1.mp4"),
);

const gate = (id, pass, evidence = {}) => ({ id, pass: Boolean(pass), evidence });
const gates = [];
const overlayAudits = [];
for (const utterance of manifest.utterances || []) {
  const spec = JSON.parse(await readFile(utterance.overlaySpecPath, "utf8"));
  const svg = await readFile(utterance.overlayPath, "utf8");
  const renderedShape = svg.match(/data-shape="([^"]+)"/u)?.[1] || "";
  const qualities = Array.isArray(spec.quality) ? spec.quality : [];
  for (const quality of qualities) {
    overlayAudits.push({
      utteranceId: utterance.id,
      preset: utterance.preset,
      exactTextMatch: quality.exactTextMatch,
      textLoss: quality.textLoss,
      overflow: quality.overflow,
      tooSmall: quality.tooSmall,
      edgeClearanceRatio: quality.edgeClearanceRatio,
      sequenceNearRepeat: quality.sequenceNearRepeat,
      sequenceSamePocket: quality.sequenceSamePocket,
      shapeTemplate: renderedShape,
      explicitVerticalGlyphs: svg.includes('data-layout="explicit-vertical-glyph"'),
      usesWritingMode: svg.includes("writing-mode="),
      narrationHasGradientOrMask: utterance.preset === "narration"
        && /<(?:linearGradient|radialGradient|mask)\b/u.test(svg),
    });
  }
}
const typographyFailures = overlayAudits.filter((entry) => (
  entry.exactTextMatch !== true
  || entry.textLoss
  || entry.overflow
  || entry.tooSmall
  || entry.edgeClearanceRatio < 0.9
  || !entry.explicitVerticalGlyphs
  || entry.usesWritingMode
  || entry.narrationHasGradientOrMask
));
gates.push(gate("speech-text-and-typography", typographyFailures.length === 0, {
  overlayCount: overlayAudits.length,
  exactTextMatchCount: overlayAudits.filter((entry) => entry.exactTextMatch).length,
  failureCount: typographyFailures.length,
  failures: typographyFailures,
}));

const placementFailures = overlayAudits.filter((entry) => entry.sequenceNearRepeat || entry.sequenceSamePocket);
gates.push(gate("sequential-bubble-position-diversity", placementFailures.length === 0, {
  nearRepeatCount: overlayAudits.filter((entry) => entry.sequenceNearRepeat).length,
  samePocketCount: overlayAudits.filter((entry) => entry.sequenceSamePocket).length,
  historicalFinalQa: manifest.production?.bubblePlacementGrammar?.finalQa || null,
}));

const plateShots = (manifest.cuts || []).flatMap((cut) => (cut.cameraSequence || [])
  .filter((shot) => shot.editorialPlate)
  .map((shot) => ({ cutId: cut.id, ...shot })));
const plateTypes = new Set(plateShots.map((shot) => shot.editorialPlate.type));
const invalidPlateShots = plateShots.filter((shot) => (
  shot.editorialPlate.characterPolicy !== "strictly-none"
  || shot.editorialPlate.environmentPolicy !== "none"
  || shot.motion !== "none"
));
gates.push(gate("characterless-editorial-plates", (
  ["white-solid", "black-solid", "pastel-sky"].every((type) => plateTypes.has(type))
  && invalidPlateShots.length === 0
), {
  count: plateShots.length,
  types: [...plateTypes],
  invalid: invalidPlateShots.map((shot) => shot.id),
}));

const splitCuts = (manifest.cuts || []).filter((cut) => cut.panelLayout?.enabled);
const splitTypes = new Set(splitCuts.map((cut) => cut.panelLayout.type));
const invalidSplitCuts = splitCuts.filter((cut) => {
  const layout = cut.panelLayout;
  return auditMangaPanelPageCameraGrammar(layout, cut.id).length > 0;
});
gates.push(gate("split-pages-flatten-before-single-camera", (
  splitTypes.has("vertical-2")
  && splitTypes.has("story-3")
  && invalidSplitCuts.length === 0
), {
  splitCutIds: splitCuts.map((cut) => cut.id),
  types: [...splitTypes],
  invalid: invalidSplitCuts.map((cut) => cut.id),
  renderOrder: manifest.production?.splitPagePolicy?.renderOrder || null,
}));

const cameraGrammarViolations = (manifest.cuts || []).flatMap((cut) => (
  cut.panelLayout?.enabled
    ? auditMangaPanelPageCameraGrammar(cut.panelLayout, cut.id)
    : (cut.cameraSequence || []).flatMap((shot) => auditMangaShotCameraGrammar(shot))
));
gates.push(gate("semantic-viewpoint-pullout-camera-grammar", cameraGrammarViolations.length === 0, {
  version: manifest.production?.cameraPolicy?.version || null,
  violations: cameraGrammarViolations,
  sourceViewpoints: manifest.production?.cameraPolicy?.sourceViewpoints || null,
}));

const thoughtUtterances = (manifest.utterances || []).filter((utterance) => utterance.preset === "thought");
const thoughtFailures = thoughtUtterances.filter((utterance) => {
  const cut = manifest.cuts.find((entry) => entry.id === utterance.cutId);
  const focus = cut?.thoughtFocus;
  const shot = (cut?.cameraSequence || []).find((entry) => entry.utteranceIds?.includes(utterance.id));
  const activeSpeakerFace = shot?.screenFaceBoundsBySpeakerId?.[utterance.speakerId]
    || shot?.speakerFaceBoundsById?.[utterance.speakerId]
    || focus?.faceBounds;
  return !focus?.enabled
    || Math.abs(focus.opacity - 0.31) > 0.001
    || Math.abs(focus.faceBrightness - 0.1) > 0.001
    || (focus.radiusX != null && focus.radiusX > 0.18)
    || (focus.radiusY != null && focus.radiusY > 0.23)
    || !activeSpeakerFace;
});
gates.push(gate("thought-face-spotlight", thoughtUtterances.length > 0 && thoughtFailures.length === 0, {
  thoughtIds: thoughtUtterances.map((utterance) => utterance.id),
  invalid: thoughtFailures.map((utterance) => utterance.id),
  referenceOpacity: 0.31,
  referenceFaceBrightness: 0.1,
}));

const presetCounts = Object.fromEntries(["dialogue", "narration", "thought", "shout", "tremble"]
  .map((preset) => [preset, (manifest.utterances || []).filter((utterance) => utterance.preset === preset).length]));
const rendererSource = await readFile(join(projectDir, "lib/speechBubbleRenderer.mjs"), "utf8");
const renderedShapeTemplates = new Set(overlayAudits.flatMap((entry) => entry.shapeTemplate || []));
gates.push(gate("reference-balloon-shape-system", (
  presetCounts.narration > 0
  && presetCounts.thought > 0
  && presetCounts.shout > 0
  && /tremble/u.test(rendererSource)
  && /function referenceBubbleContour\(/u.test(rendererSource)
  && overlayAudits.some((entry) => entry.shapeTemplate === "shout-irregular")
  && overlayAudits.some((entry) => entry.shapeTemplate === "thought-radial")
), {
  presetCounts,
  renderedShapeTemplates: [...renderedShapeTemplates],
  trembleAvailableButRare: presetCounts.tremble === 0,
}));

const compositionAudit = JSON.parse(await readFile(
  manifest.production?.v31Composition?.auditPath || join(episodeDir, "v31-composition-audit.json"),
  "utf8",
));
const compositionQa = manifest.production?.v31Composition?.finalQa || {};
gates.push(gate("camera-and-composition-variety", (
  compositionQa.uniqueSetupCount >= 16
  && compositionQa.minimumAdjacentChangedAxes >= 3
  && compositionQa.consecutiveTooSimilarCount === 0
  && compositionAudit.pass !== false
), { ...compositionQa, auditPass: compositionAudit.pass !== false }));

const voiceAudition = JSON.parse(await readFile(
  join(projectDir, "canvas/voice-casting/manga-photo-homecoming-001-elevenlabs-audition.json"),
  "utf8",
));
const audioUtterances = (manifest.utterances || []).filter((utterance) => utterance.audio);
const audioFailures = audioUtterances.filter((utterance) => (
  utterance.audio.provider !== "elevenlabs"
  || utterance.audio.model !== "eleven_v3"
  || !utterance.audio.voiceId
  || !utterance.audio.voiceName
));
const auditionFailures = (voiceAudition.entries || []).filter((entry) => (
  (!entry.persona?.gender && entry.role !== "narration")
  || (!entry.persona?.age && entry.role !== "narration")
  || !Array.isArray(entry.persona?.traits)
  || entry.persona.traits.length === 0
  || (entry.role === "narration" && !entry.persona.traits.includes("calm"))
  || (entry.role === "narration" && !entry.persona.traits.includes("intelligent"))
  || !Array.isArray(entry.candidates)
  || entry.candidates.length === 0
  || entry.candidates.some((candidate) => candidate.source !== "shared-library" && candidate.source !== "account")
));
gates.push(gate("elevenlabs-persona-casting-and-public-library-search", (
  audioFailures.length === 0
  && audioUtterances.length === manifest.utterances.length
  && voiceAudition.catalog?.sharedLibraryCount > 0
  && auditionFailures.length === 0
), {
  audioUtteranceCount: audioUtterances.length,
  voiceNames: [...new Set(audioUtterances.map((utterance) => utterance.audio.voiceName))],
  publicLibraryCandidateCount: voiceAudition.catalog?.sharedLibraryCount || 0,
  auditionRoleCount: voiceAudition.entries?.length || 0,
  auditionStatus: voiceAudition.status,
  accountMutationDuringDiscovery: voiceAudition.policy?.accountMutationDuringDiscovery,
  invalidAudioIds: audioFailures.map((utterance) => utterance.id),
  invalidAuditionRoles: auditionFailures.map((entry) => entry.characterId),
}));

const { stdout: probeStdout } = await execFileAsync("ffprobe", [
  "-v", "error",
  "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate",
  "-of", "json",
  expectedVideoPath,
], { maxBuffer: 2_000_000 });
const probe = JSON.parse(probeStdout);
const videoStream = probe.streams?.find((stream) => stream.codec_type === "video");
const audioStream = probe.streams?.find((stream) => stream.codec_type === "audio");
const [fpsNumerator, fpsDenominator] = String(videoStream?.r_frame_rate || "0/1").split("/").map(Number);
const actualFps = fpsDenominator ? fpsNumerator / fpsDenominator : 0;
await execFileAsync("ffmpeg", [
  "-hide_banner", "-v", "error", "-i", expectedVideoPath, "-f", "null", "-",
], { maxBuffer: 4_000_000 });
gates.push(gate("final-video-container-and-full-decode", (
  videoStream?.width === manifest.video.width
  && videoStream?.height === manifest.video.height
  && Math.abs(actualFps - manifest.video.fps) < 0.01
  && Boolean(audioStream)
), {
  filePath: expectedVideoPath,
  durationSeconds: Number(probe.format?.duration || 0),
  width: videoStream?.width,
  height: videoStream?.height,
  fps: actualFps,
  audioPresent: Boolean(audioStream),
  fullDecodePassed: true,
}));

const report = {
  version: "master-quality-r2",
  createdAt: new Date().toISOString(),
  manifestPath,
  videoPath: expectedVideoPath,
  pass: gates.every((entry) => entry.pass),
  passedGateCount: gates.filter((entry) => entry.pass).length,
  gateCount: gates.length,
  gates,
};
await writeJsonAtomic(reportPath, report);
if (!report.pass) {
  throw new Error(`V32 master QA failed: ${gates.filter((entry) => !entry.pass).map((entry) => entry.id).join(", ")}`);
}
process.stdout.write(`${JSON.stringify({ reportPath, pass: report.pass, gateCount: report.gateCount }, null, 2)}\n`);
