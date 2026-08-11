#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) result[key] = true;
    else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} exited with ${code}`));
    });
  });
}

const args = parseArgs(process.argv.slice(2));
const outputPath = resolve(args.output || "canvas/assets/audio/reference-video-rainy-photo-shop-bgm.wav");
const duration = Math.max(10, Number(args.duration) || 132);
const sampleRate = 48_000;
const chordDuration = 8;
const crossfade = 1.25;
const progressionDuration = chordDuration * 4 - crossfade * 3;
const loopSamples = Math.round(progressionDuration * sampleRate);
const fadeOutStart = Math.max(0, duration - 4);
const chords = [
  [110, 164.81, 220],
  [87.31, 130.81, 174.61],
  [130.81, 196, 261.63],
  [98, 146.83, 196],
];
const ffmpegArgs = ["-hide_banner", "-y"];
for (const chord of chords) {
  for (const frequency of chord) {
    ffmpegArgs.push(
      "-f", "lavfi",
      "-i", `sine=frequency=${frequency}:sample_rate=${sampleRate}:duration=${chordDuration}`,
    );
  }
}
ffmpegArgs.push(
  "-f", "lavfi",
  "-i", `anoisesrc=color=pink:amplitude=0.018:sample_rate=${sampleRate}:duration=${duration}`,
);
const filters = [];
for (let index = 0; index < chords.length; index += 1) {
  const offset = index * 3;
  filters.push(
    `[${offset}:a][${offset + 1}:a][${offset + 2}:a]`
      + `amix=inputs=3:normalize=0,volume=0.18,lowpass=f=1800[c${index}]`,
  );
}
filters.push(`[c0][c1]acrossfade=d=${crossfade}:c1=tri:c2=tri[x1]`);
filters.push(`[x1][c2]acrossfade=d=${crossfade}:c1=tri:c2=tri[x2]`);
filters.push(`[x2][c3]acrossfade=d=${crossfade}:c1=tri:c2=tri[x3]`);
filters.push(
  `[x3]aecho=0.8:0.88:180|360:0.14|0.08,`
    + `aloop=loop=-1:size=${loopSamples},atrim=0:${duration.toFixed(3)}[music]`,
);
filters.push(`[12:a]highpass=f=140,lowpass=f=1500,volume=0.15[texture]`);
filters.push(
  `[music][texture]amix=inputs=2:duration=first:normalize=0,`
    + `afade=t=in:st=0:d=2,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=4,`
    + "loudnorm=I=-18:LRA=5:TP=-2[aout]",
);
await mkdir(dirname(outputPath), { recursive: true });
ffmpegArgs.push(
  "-filter_complex", filters.join(";"),
  "-map", "[aout]", "-ar", String(sampleRate), "-ac", "2",
  "-c:a", "pcm_s16le", outputPath,
);
await run(args.ffmpeg || "ffmpeg", ffmpegArgs);
process.stdout.write(`${JSON.stringify({ outputPath, duration, sampleRate }, null, 2)}\n`);
