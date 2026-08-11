#!/usr/bin/env node
import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas", "manga-videos", "manga-photo-homecoming-001");
const manifestPath = join(episodeDir, "episode-manifest.json");
const paths = {
  media: join(episodeDir, "v15-final-media-audit.json"),
  speech: join(episodeDir, "v15-elevenlabs-speech-audit-final.json"),
  transparentAudio: join(episodeDir, "v15-elevenlabs-transparent-audio-audit.json"),
  camera: join(episodeDir, "v15-camera-motion-evidence.json"),
  cameraPlan: join(episodeDir, "v15-camera-motion-plan.json"),
  visual: join(episodeDir, "v14-final-evidence.json"),
  bubbles: join(episodeDir, "v14-r2-bubble-manual-audit.json"),
  output: join(episodeDir, "v15-final-evidence.json"),
};
const readJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));
const [manifest, media, speech, transparentAudio, camera, cameraPlan, visual, bubbles] = await Promise.all([
  readJson(manifestPath),
  readJson(paths.media),
  readJson(paths.speech),
  readJson(paths.transparentAudio),
  readJson(paths.camera),
  readJson(paths.cameraPlan),
  readJson(paths.visual),
  readJson(paths.bubbles),
]);
const videoPath = resolve(manifest.outputs?.reviewVideo?.filePath || "");
let videoExists = true;
try { await access(videoPath); } catch { videoExists = false; }
const utterances = manifest.utterances || [];
const nativeVoiceIds = new Set(utterances.map((utterance) => utterance.voiceId).filter(Boolean));
const checks = [
  { id: "final-video-exists", pass: videoExists, value: videoPath },
  { id: "v15-file-name", pass: videoPath.endsWith("manga-photo-homecoming-001-v15-elevenlabs-final-r1.mp4"), value: videoPath },
  { id: "final-media-pass", pass: media.pass === true, value: media.gates },
  { id: "speech-reading-29-of-29", pass: speech.passedCount === 29 && speech.flaggedCount === 0, value: { passedCount: speech.passedCount, flaggedCount: speech.flaggedCount } },
  { id: "transparent-audio-29-of-29", pass: transparentAudio.pass === true && transparentAudio.passedCount === 29, value: { loudnessSpreadLu: transparentAudio.loudnessSpreadLu, maximumBoundaryPeak: transparentAudio.maximumBoundaryPeak } },
  { id: "native-japanese-elevenlabs-only", pass: utterances.length === 29 && utterances.every((utterance) => utterance.audio?.provider === "elevenlabs" && utterance.model === "eleven_v3") && nativeVoiceIds.size === 4, value: { utteranceCount: utterances.length, nativeVoiceCount: nativeVoiceIds.size } },
  { id: "camera-plan-25-pull-outs", pass: cameraPlan.shotCount === 25 && cameraPlan.animatedPullOutCount === 25 && cameraPlan.spatialWideSourceCount === 9, value: { shotCount: cameraPlan.shotCount, spatialWideSourceCount: cameraPlan.spatialWideSourceCount, angleCounts: cameraPlan.angleCounts } },
  { id: "rendered-camera-motion-25-of-25", pass: camera.pass === true && camera.passCount === 25, value: camera.renderedMeasuredPullPercent },
  { id: "v14-visual-quality-preserved", pass: visual.pass === true, value: visual.summary },
  { id: "bubble-layout-preserved", pass: bubbles.pass === true && bubbles.reviewedFrameCount === 29 && bubbles.activeSpeakerFaceOverlapAfterFix === 0, value: { reviewedFrameCount: bubbles.reviewedFrameCount, activeSpeakerFaceOverlapAfterFix: bubbles.activeSpeakerFaceOverlapAfterFix } },
  { id: "no-artificial-darkening", pass: manifest.production?.bubblePolicy?.artificialBackgroundDarkening === false, value: manifest.production?.bubblePolicy?.artificialBackgroundDarkening },
  { id: "final-loudness", pass: media.loudness?.integratedLufs >= -16 && media.loudness?.integratedLufs <= -14 && media.loudness?.truePeakDbfs <= -1, value: media.loudness },
];
const passCount = checks.filter((check) => check.pass).length;
const report = {
  version: "v15-native-japanese-elevenlabs-final-evidence",
  episodeId: manifest.id,
  videoPath,
  pass: passCount === checks.length,
  summary: { passCount, totalCount: checks.length, failedCount: checks.length - passCount },
  checks,
  artifacts: paths,
  generatedAt: new Date().toISOString(),
};
await writeFile(paths.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (!report.pass) {
  process.stderr.write(`${JSON.stringify(report.summary, null, 2)}\n`);
  process.exit(2);
}

for (const key of ["action", "manifestPath", "cutIds", "projectDir", "model", "motion", "force", "reuseRenderedCuts", "episodeId"]) {
  delete manifest.video?.[key];
}
manifest.status = "final-review-candidate-v15-elevenlabs-r1";
manifest.production = {
  ...(manifest.production || {}),
  finalEvidencePath: paths.output,
  audioUpgrade: {
    version: "v15-native-japanese-elevenlabs-final-r1",
    provider: "elevenlabs",
    model: "eleven_v3",
    nativeJapaneseVoiceCount: nativeVoiceIds.size,
    utteranceCount: utterances.length,
    voiceConversionOrTimbreProcessing: false,
    speechAuditPath: paths.speech,
    transparentAudioAuditPath: paths.transparentAudio,
    mediaAuditPath: paths.media,
    cameraEvidencePath: paths.camera,
  },
};
manifest.updatedAt = new Date().toISOString();
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputPath: paths.output, ...report.summary, pass: report.pass, status: manifest.status }, null, 2)}\n`);
