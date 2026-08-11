#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const manifestPath = resolve(process.argv[2] || "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const videoPath = resolve(process.argv[3] || manifest.outputs?.reviewVideo?.filePath || "");
const outputDir = resolve(process.argv[4] || join(dirname(manifestPath), "bubble-camera-sweep-audit"));
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
      else rejectPromise(new Error(`${command} failed (${code}): ${stderr.slice(-800)}`));
    });
  });
}

const rows = [];
for (const utterance of manifest.utterances) {
  const spec = JSON.parse(await readFile(utterance.overlaySpecPath, "utf8"));
  const sampleCount = Number(spec.bubble?.speakerProximityTargets?.length) || 0;
  if (utterance.preset === "narration" || sampleCount === 0) continue;
  const start = Number(utterance.timing?.bubbleStartSeconds);
  const end = Number(utterance.timing?.bubbleEndSeconds);
  const inset = Math.min(0.12, Math.max(0.04, (end - start) * 0.08));
  const phases = [
    ["start", Math.min(end, start + inset)],
    ["middle", (start + end) / 2],
    ["end", Math.max(start, end - inset)],
  ];
  for (const [phase, seconds] of phases) {
    rows.push({
      utteranceId: utterance.id,
      phase,
      seconds,
      speakerProximitySampleCount: sampleCount,
      expectedBounds: spec.bubble.bounds,
      framePath: join(framesDir, `${String(rows.length + 1).padStart(2, "0")}-${utterance.id}-${phase}.jpg`),
    });
  }
}

let cursor = 0;
const worker = async () => {
  while (cursor < rows.length) {
    const row = rows[cursor++];
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", row.seconds.toFixed(6),
      "-i", videoPath,
      "-frames:v", "1", "-q:v", "2", row.framePath,
    ]);
  }
};
await Promise.all(Array.from({ length: 4 }, () => worker()));

const report = {
  version: "camera-sweep-speaker-proximity-v1",
  videoPath,
  videoFileName: basename(videoPath),
  utteranceCount: rows.length / 3,
  frameCount: rows.length,
  phases: ["start", "middle", "end"],
  rows,
};
await writeFile(join(outputDir, "bubble-camera-sweep-audit.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputDir, utteranceCount: report.utteranceCount, frameCount: report.frameCount }, null, 2)}\n`);
