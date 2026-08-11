#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = resolve(projectDir, "canvas/manga-videos/manga-photo-homecoming-001");
const manifestPath = resolve(episodeDir, "episode-manifest.json");
const videoPath = resolve(projectDir, "canvas/assets/videos/manga-photo-homecoming-001-v25-natural-dialogue-r2.mp4");
const paths = {
  assembly: resolve(episodeDir, "v25-master-assembly-audit-r2.json"),
  objective: resolve(episodeDir, "v25-final-audio-objective-audit-r2.json"),
  video: resolve(episodeDir, "v25-final-video-audit-r2.json"),
  remaster: resolve(episodeDir, "v25-fixed-gain-audio-remaster.json"),
  scribe: resolve(episodeDir, "v25-elevenlabs-scribe-audit-final.json"),
  lineAudio: resolve(episodeDir, "v25-elevenlabs-dialogue-audio-audit.json"),
};

const load = async (path) => JSON.parse(await readFile(path, "utf8"));
const [manifest, assembly, objective, videoAudit, remaster, scribe, lineAudio] = await Promise.all([
  load(manifestPath), load(paths.assembly), load(paths.objective), load(paths.video),
  load(paths.remaster), load(paths.scribe), load(paths.lineAudio),
]);
if (![assembly.pass, objective.pass, videoAudit.pass, scribe.pass, lineAudio.pass].every(Boolean)) {
  throw new Error("Cannot finalize: one or more V25 audio gates failed");
}

const videoBytes = await readFile(videoPath);
const videoStat = await stat(videoPath);
const sha256 = createHash("sha256").update(videoBytes).digest("hex");
const finalVideo = {
  fileName: basename(videoPath),
  filePath: videoPath,
  assetUrl: `/excalidraw-assets/videos/${encodeURIComponent(basename(videoPath))}`,
  durationSeconds: videoAudit.media.durationSeconds,
  width: videoAudit.media.video.width,
  height: videoAudit.media.video.height,
  fps: 30,
  sampleRate: Number(videoAudit.media.audio.sample_rate),
  channels: videoAudit.media.audio.channels,
  sizeBytes: videoStat.size,
  sha256,
  createdAt: new Date().toISOString(),
};

manifest.status = "final-v25-natural-dialogue-r2";
manifest.video = {
  ...(manifest.video || {}),
  normalizeVoiceAudio: false,
  normalizeMasterAudio: false,
  masterTargetLufs: remaster.targetLufs,
  bgmPath: "",
};
manifest.audioQuality = {
  ...(manifest.audioQuality || {}),
  version: "v25-elevenlabs-dialogue-r2-fixed-gain-master",
  speechAuditPath: paths.scribe,
  speechAuditPass: true,
  speechAuditPassedCount: scribe.passedCutCount ?? scribe.cuts?.length ?? 10,
  speechAuditFlaggedCount: 0,
  finalMaster: {
    mode: "sample-accurate-fixed-gain",
    dynamicNormalization: false,
    perCutGainNormalization: false,
    fixedGainDb: remaster.fixedGainDb,
    integratedLufs: videoAudit.loudness.integratedLufs,
    loudnessRangeLu: videoAudit.loudness.loudnessRangeLu,
    truePeakDbfs: videoAudit.loudness.truePeakDbfs,
    waveformIntegrityPass: assembly.gates.waveformIntegrity,
    utteranceCount: assembly.utteranceCount,
    utterancePassedCount: assembly.passedCount,
    minimumOverallSimilarity: assembly.minimumOverallSimilarity,
    minimumSpeechOnsetSimilarity: assembly.minimumSpeechOnsetSimilarity,
    speechOnsetGainSpreadRatio: assembly.speechOnsetGainSpreadRatio,
    pauseCount: assembly.audibleGaps.length,
    pausePass: assembly.gates.audibleGaps,
    maximumWithinCutLagResidualSeconds: assembly.maximumWithinCutLagResidualSeconds,
    audibleHumCandidateCount: objective.audibleHumCandidates.length,
    isolatedClickCandidateCount: objective.isolatedClickCandidateCount,
    noBackgroundBuzzTrack: true,
    fullVideoAuditPass: videoAudit.pass,
    assemblyAuditPath: paths.assembly,
    objectiveAuditPath: paths.objective,
    videoAuditPath: paths.video,
    remasterReportPath: paths.remaster,
  },
};
manifest.outputs = {
  ...(manifest.outputs || {}),
  reviewVideo: finalVideo,
  finalVideo,
};
manifest.updatedAt = new Date().toISOString();
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ manifestPath, status: manifest.status, finalVideo }, null, 2)}\n`);
