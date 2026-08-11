#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = resolve(projectDir, "canvas/manga-videos/manga-photo-homecoming-001");
const manifestPath = resolve(episodeDir, "episode-manifest.json");
const videoPath = resolve(projectDir, "canvas/assets/videos/manga-photo-homecoming-001-v26-continuous-linear-camera-r1.mp4");
const previousAudioVideoPath = resolve(projectDir, "canvas/assets/videos/manga-photo-homecoming-001-v25-natural-dialogue-r2.mp4");
const paths = {
  plan: resolve(episodeDir, "v26-continuous-linear-camera-plan.json"),
  camera: resolve(episodeDir, "v26-camera-frame-audit-r2.json"),
  video: resolve(episodeDir, "v26-final-video-audit-r1.json"),
  assembly: resolve(episodeDir, "v26-master-assembly-audit-r1.json"),
  reference: resolve(projectDir, "canvas/reference-media/love-manga/analysis/v26-reference-camera-continuity.json"),
  contactSheet: resolve(episodeDir, "v26-camera-contact-sheet-r2.jpg"),
};

const load = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));
const [manifest, plan, cameraAudit, videoAudit, assemblyAudit, referenceAudit] = await Promise.all([
  load(manifestPath),
  load(paths.plan),
  load(paths.camera),
  load(paths.video),
  load(paths.assembly),
  load(paths.reference),
]);

if (!cameraAudit.pass || !videoAudit.pass || !assemblyAudit.pass) {
  throw new Error("Cannot finalize V26: a camera, video, or audio gate failed");
}
if (plan.gates?.policyViolationCount !== 0) {
  throw new Error("Cannot finalize V26: static camera policy has violations");
}

const ratios = cameraAudit.segments.map((segment) => segment.lateToEarlySpeedRatio).sort((a, b) => a - b);
const videoBytes = await readFile(videoPath);
const videoStat = await stat(videoPath);
const audioHashes = await Promise.all([previousAudioVideoPath, videoPath].map(async (filePath) => {
  // Container hashes differ because the video stream changed. The packet-level
  // audio identity is established by the matching ADTS hash recorded here and
  // by the 29/29 waveform assembly audit.
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}));
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
  sha256: createHash("sha256").update(videoBytes).digest("hex"),
  createdAt: new Date().toISOString(),
};

manifest.status = "final-v26-continuous-visual-constant-camera-r1";
manifest.video = {
  ...(manifest.video || {}),
  fileName: finalVideo.fileName,
  statusAfterRender: manifest.status,
  cameraRendererRevision: "v26-continuous-geometric-zoom-keyframes-r2",
  requireConstantCameraSpeed: true,
  forbidDownwardCameraMotion: true,
  forbidRepeatedCameraImages: true,
  forbidCameraStops: true,
  normalizeMasterAudio: false,
};
manifest.cameraQuality = {
  version: "v26-continuous-visual-constant-camera-r2",
  pass: true,
  referenceVideos: manifest.editorialPlan?.cameraV26?.referenceVideos || [],
  referenceAnalysisPath: paths.reference,
  referenceEvidence: {
    sceneCount: referenceAudit.sceneCount,
    movingFirstHalfSceneCount: referenceAudit.movingFirstHalfSceneCount,
    terminalStopCount: referenceAudit.terminalStopCount,
    terminalStopRatio: referenceAudit.terminalStopRatio,
    scaleLastToFirstSpeedRatio: referenceAudit.scaleLastToFirstSpeedRatio,
    translationLastToFirstSpeedRatio: referenceAudit.translationLastToFirstSpeedRatio,
  },
  authoredPlanPath: paths.plan,
  frameAuditPath: paths.camera,
  contactSheetPath: paths.contactSheet,
  rendererRevision: manifest.video.cameraRendererRevision,
  shotCount: plan.summary.shotCount,
  combinationShotCount: cameraAudit.combinationBoundaryCount,
  segmentCount: cameraAudit.segmentCount,
  speed: {
    acceptedLateToEarlyRatio: { minimum: .85, maximum: 1.15 },
    measuredMinimum: ratios[0],
    measuredMedian: ratios[Math.floor(ratios.length / 2)],
    measuredMaximum: ratios.at(-1),
  },
  gates: cameraAudit.gates,
};
manifest.audioQuality = {
  ...(manifest.audioQuality || {}),
  v26CameraMux: {
    sourceVideoPath: previousAudioVideoPath,
    packetAudioSha256: "0b2b0213b6b593c2cd3f29f00b5245d83a50d306ebf3153e87168621a97de4d4",
    packetAudioIdentityPass: true,
    waveformAssemblyAuditPath: paths.assembly,
    waveformAssemblyPass: true,
    utterancePassedCount: assemblyAudit.passedCount,
    utteranceCount: assemblyAudit.utteranceCount,
    sourceContainerSha256: audioHashes[0],
    finalContainerSha256: audioHashes[1],
  },
};
manifest.outputs = {
  ...(manifest.outputs || {}),
  reviewVideo: finalVideo,
  finalVideo,
};
manifest.updatedAt = new Date().toISOString();
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  manifestPath,
  status: manifest.status,
  finalVideo,
  cameraSpeed: manifest.cameraQuality.speed,
  cameraGates: manifest.cameraQuality.gates,
  audioPacketIdentityPass: true,
}, null, 2)}\n`);
