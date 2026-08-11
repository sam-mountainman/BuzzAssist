#!/usr/bin/env node
import { execFile as execFileCallback, spawn } from "node:child_process";
import { copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const manifestPath = resolve(process.argv[2] || "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const videoPath = resolve(process.argv[3] || manifest.outputs?.reviewVideo?.filePath || "");
const outputDir = resolve(process.argv[4] || join(dirname(manifestPath), "v24-bubble-transition-audit"));
const framesDir = join(outputDir, "frames-ordered");
await mkdir(framesDir, { recursive: true });

const fps = Math.max(12, Number(manifest.video?.fps) || 30);
const frameSeconds = 1 / fps;
const transparentFirstFrame = Number(manifest.video?.bubbleFadeInMilliseconds) > 0;

async function renderedCutFrameCount(cut) {
  const renderedPath = manifest.jobs?.render?.[cut.id]?.outputPath;
  if (renderedPath) {
    try {
      const { stdout } = await execFile("ffprobe", [
        "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=nb_frames",
        "-of", "default=noprint_wrappers=1:nokey=1",
        renderedPath,
      ]);
      const frames = Number(String(stdout).trim());
      if (Number.isInteger(frames) && frames > 0) {
        return { frames, source: renderedPath };
      }
    } catch {
      // Fall through to the authored-duration estimate for old manifests.
    }
  }
  return {
    frames: Math.max(1, Math.round(Number(cut.timing?.durationSeconds || 0) * fps)),
    source: "authored-duration-fallback",
  };
}

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} failed (${code}): ${stderr.slice(-900)}`));
    });
  });
}

const cutById = new Map(manifest.cuts.map((cut) => [cut.id, cut]));
const renderedCutFrames = await Promise.all(manifest.cuts.map(renderedCutFrameCount));
const cutStartFrameById = new Map();
let renderedFrameCursor = 0;
for (const [index, cut] of manifest.cuts.entries()) {
  cutStartFrameById.set(cut.id, renderedFrameCursor);
  renderedFrameCursor += renderedCutFrames[index].frames;
}
const frameAtOrBefore = (seconds) => Math.max(0, Math.floor((seconds + 1e-7) * fps));
const frameAtOrAfter = (seconds) => Math.max(0, Math.ceil((seconds - 1e-7) * fps));
const intervals = manifest.utterances.flatMap((utterance) => {
  const cut = cutById.get(utterance.cutId);
  const cutStart = Number(cut?.timing?.startSeconds) || 0;
  const cutStartFrame = cutStartFrameById.get(utterance.cutId) || 0;
  const baseStartInCut = Number(utterance.timing.bubbleStartInCutSeconds);
  const baseEndInCut = Number(utterance.timing.bubbleEndInCutSeconds);
  const audioStartInCut = Number(utterance.timing.audioStartInCutSeconds);
  const segments = Array.isArray(utterance.bubbleSegments) && utterance.bubbleSegments.length > 0
    ? utterance.bubbleSegments
    : [{ id: utterance.id }];
  return segments.map((segment, segmentIndex) => {
    const startInCut = segment.startOffsetSeconds === undefined
      ? baseStartInCut
      : Math.max(baseStartInCut, Math.min(baseEndInCut, audioStartInCut + Number(segment.startOffsetSeconds)));
    const endInCut = segment.endOffsetSeconds === undefined
      ? baseEndInCut
      : Math.max(baseStartInCut, Math.min(baseEndInCut, audioStartInCut + Number(segment.endOffsetSeconds)));
    return {
      cutId: utterance.cutId,
      utteranceId: utterance.id,
      segmentId: segment.id || `${utterance.id}-s${segmentIndex + 1}`,
      startSeconds: cutStart + startInCut,
      endSeconds: cutStart + endInCut,
      startFrame: cutStartFrame + frameAtOrAfter(startInCut),
      endFrame: cutStartFrame + frameAtOrBefore(endInCut),
    };
  });
}).sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);

const transitions = intervals.slice(0, -1).map((current, index) => {
  const next = intervals[index + 1];
  const oldLastFrame = Math.max(current.startFrame, current.endFrame);
  const newOverlayEnabledFrame = next.startFrame;
  // A positive alpha fade begins at exactly zero opacity, so the first
  // enabled overlay frame is visually clear and the first visible frame is
  // the following encoded frame.
  const newFirstFrame = newOverlayEnabledFrame + (transparentFirstFrame ? 1 : 0);
  const clearFrameCandidates = [];
  for (let frame = oldLastFrame + 1; frame < newFirstFrame; frame += 1) clearFrameCandidates.push(frame);
  const clearFrame = clearFrameCandidates.length > 0
    ? clearFrameCandidates[Math.floor(clearFrameCandidates.length / 2)]
    : null;
  return {
    index: index + 1,
    from: current,
    to: next,
    crossesImageBoundary: current.cutId !== next.cutId,
    gapSeconds: next.startSeconds - current.endSeconds,
    oldLastFrame,
    clearFrame,
    newFirstFrame,
    newOverlayEnabledFrame,
    hasEncodedClearFrame: clearFrame !== null,
  };
});

const failures = transitions.filter((transition) => (
  transition.gapSeconds < frameSeconds - 0.001
  || transition.oldLastFrame >= transition.newFirstFrame
  || !transition.hasEncodedClearFrame
));
if (failures.length > 0) {
  throw new Error(`V24 encoded transition gate failed: ${JSON.stringify(failures, null, 2)}`);
}

const extractionRows = transitions.flatMap((transition) => ([
  { phaseOrder: 1, phase: "old-last", frame: transition.oldLastFrame },
  { phaseOrder: 2, phase: "clear", frame: transition.clearFrame },
  { phaseOrder: 3, phase: "new-first", frame: transition.newFirstFrame },
].map((entry) => {
  const prefix = String(transition.index).padStart(2, "0");
  const framePath = join(framesDir, `${prefix}-${entry.phaseOrder}-${entry.phase}-f${String(entry.frame).padStart(5, "0")}.jpg`);
  return { transitionIndex: transition.index, ...entry, framePath };
})));

// Decode the episode once. Spawning one ffmpeg per proof frame repeatedly
// decoded the full H.264 stream and made this 108-frame audit take ~30 min.
// A single select pass preserves exact frame-number semantics and is also
// safe when several transition rows refer to the same encoded frame.
const uniqueFrames = [...new Set(extractionRows.map((row) => row.frame))].sort((a, b) => a - b);
const selectedPattern = join(framesDir, ".selected-%03d.jpg");
const selectedExpression = uniqueFrames.map((frame) => `eq(n\\,${frame})`).join("+");
await run("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y",
  "-i", videoPath,
  "-vf", `select=${selectedExpression}`,
  "-vsync", "0", "-q:v", "2", selectedPattern,
]);
const selectedPathByFrame = new Map(uniqueFrames.map((frame, index) => [
  frame,
  join(framesDir, `.selected-${String(index + 1).padStart(3, "0")}.jpg`),
]));
for (const row of extractionRows) {
  await copyFile(selectedPathByFrame.get(row.frame), row.framePath);
}
await Promise.all([...selectedPathByFrame.values()].map((path) => unlink(path)));

const audit = {
  version: "v24-exclusive-bubbles-transition-audit",
  videoPath,
  videoFileName: basename(videoPath),
  fps,
  frameSeconds,
  intervalCount: intervals.length,
  transitionCount: transitions.length,
  imageBoundaryTransitionCount: transitions.filter((entry) => entry.crossesImageBoundary).length,
  transitionFailureCount: failures.length,
  everyTransitionHasEncodedClearFrame: failures.length === 0,
  renderedCutFrames: manifest.cuts.map((cut, index) => ({
    cutId: cut.id,
    startFrame: cutStartFrameById.get(cut.id),
    frameCount: renderedCutFrames[index].frames,
    source: renderedCutFrames[index].source,
  })),
  renderedFrameCount: renderedFrameCursor,
  intervals,
  transitions,
  extractionRows,
};
await writeFile(join(outputDir, "bubble-transition-audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  outputDir,
  videoPath,
  intervalCount: audit.intervalCount,
  transitionCount: audit.transitionCount,
  imageBoundaryTransitionCount: audit.imageBoundaryTransitionCount,
  extractedFrameCount: extractionRows.length,
  transitionFailureCount: audit.transitionFailureCount,
  everyTransitionHasEncodedClearFrame: audit.everyTransitionHasEncodedClearFrame,
}, null, 2)}\n`);
