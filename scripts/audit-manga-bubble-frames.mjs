#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const manifestPath = resolve(process.argv[2] || "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const videoPath = resolve(process.argv[3] || manifest.outputs?.reviewVideo?.filePath || "");
const outputDir = resolve(process.argv[4] || join(dirname(manifestPath), "v10-bubble-frame-audit"));
const framesDir = join(outputDir, "frames");
await mkdir(framesDir, { recursive: true });

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} failed (${code}): ${stderr.slice(-600)}`));
    });
  });
}

const rows = manifest.utterances.flatMap((utterance) => {
  const baseStart = Number(utterance.timing.bubbleStartSeconds);
  const baseEnd = Number(utterance.timing.bubbleEndSeconds);
  const audioStart = Number(utterance.timing.audioStartSeconds);
  const segments = Array.isArray(utterance.bubbleSegments) && utterance.bubbleSegments.length > 0
    ? utterance.bubbleSegments
    : [{ id: utterance.id, text: utterance.bubbleDisplayText || utterance.text }];
  return segments.map((segment, segmentIndex) => {
    const startSeconds = segment.startOffsetSeconds === undefined
      ? baseStart
      : Math.max(baseStart, Math.min(baseEnd, audioStart + Number(segment.startOffsetSeconds)));
    const endSeconds = segment.endOffsetSeconds === undefined
      ? baseEnd
      : Math.max(baseStart, Math.min(baseEnd, audioStart + Number(segment.endOffsetSeconds)));
    return {
      utteranceId: utterance.id,
      segmentId: segment.id || `${utterance.id}-s${segmentIndex + 1}`,
      segmentIndex: segmentIndex + 1,
      speakerId: utterance.speakerId,
      speakerName: utterance.speakerName,
      text: segment.text || utterance.bubbleDisplayText || utterance.text,
      startSeconds,
      endSeconds,
      midpointSeconds: (startSeconds + endSeconds) / 2,
    };
  });
}).map((row, index) => ({
  ...row,
  index: index + 1,
  framePath: join(framesDir, `${String(index + 1).padStart(2, "0")}-${row.segmentId}.jpg`),
}));

let cursor = 0;
const worker = async () => {
  while (cursor < rows.length) {
    const row = rows[cursor++];
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", row.midpointSeconds.toFixed(6),
      "-i", videoPath,
      "-frames:v", "1", "-q:v", "2", row.framePath,
    ]);
  }
};
await Promise.all(Array.from({ length: 4 }, () => worker()));
await writeFile(join(outputDir, "bubble-frame-audit.json"), `${JSON.stringify({
  version: 1,
  videoPath,
  videoFileName: basename(videoPath),
  frameCount: rows.length,
  rows,
}, null, 2)}\n`, "utf8");

process.stdout.write(`${JSON.stringify({ outputDir, videoPath, frameCount: rows.length }, null, 2)}\n`);
