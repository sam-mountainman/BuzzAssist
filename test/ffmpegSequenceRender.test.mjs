#!/usr/bin/env node

// 入力の多い FFmpeg の工程を、Windows のコマンド行の上限（32,767 字）を越えない塊に分けて描く共有層
// （lib/ffmpegSequenceRender.mjs）の試験。長い台本に当たる数の場面の画と声を、深いフォルダ（Windows の長い
// path に当たる長さ）に置き、組み立てたコマンド行の長さを測る。合成の画と音だけを使う。

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  FFMPEG_COMMAND_LINE_BUDGET,
  WINDOWS_COMMAND_LINE_MAX,
  ffmpegCommandLineLength,
  windowsCommandLineLength,
  windowsQuotedArgument,
} from "../lib/ffmpegFilterArgs.mjs";
import { concatAudioSequence, planSequenceChunks, renderVideoSequence } from "../lib/ffmpegSequenceRender.mjs";
import { resolveFfmpegToolchain } from "../lib/harnessRuntimeResolver.mjs";
import { planNarratedCameraShots } from "../lib/narratedStoryCamera.mjs";
import { narratedSceneSequence, planNarratedSceneJoins } from "../lib/narratedStorySceneTransitions.mjs";
import { ff, makeTexturedStill } from "./fixtures/narratedVisualFixture.mjs";

const execFile = promisify(execFileCallback);
const toolchain = await resolveFfmpegToolchain();
const RENDER = { width: 64, height: 36, fps: 12 };
// 1回で描いた版と画素まで比べるので、試験では損失の無い符号化にする。
const ENCODE = ["-an", "-c:v", "libx264", "-preset", "veryfast", "-qp", "0", "-pix_fmt", "yuv420p"];
const CAMERA = {
  moves: {
    "slow-push-in": { zoomPerSecond: 0.03, maxZoom: 1.2, focusX: 0.5, focusY: 0.5 },
    "pan-left": { panPerSecond: 0.05, zoom: 1.15, focusY: 0.5 },
  },
  sequence: ["slow-push-in", "pan-left"],
  easing: { kind: "linear", linearShare: 1 },
};

/** Windows の長い path に当たる深いフォルダ（1段 200 字 × levels 段）。 */
async function deepDir(root, levels = 3) {
  const dir = join(root, ...Array.from({ length: levels }, (_, index) => String.fromCharCode(100 + index).repeat(200)));
  await mkdir(dir, { recursive: true });
  return dir;
}

async function grayFrames(file) {
  const { stdout } = await execFile(toolchain.ffmpeg.command, [...(toolchain.ffmpeg.args || []), "-hide_banner", "-loglevel", "error", "-i", file, "-vf", "format=gray", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  const size = RENDER.width * RENDER.height;
  const frames = [];
  for (let offset = 0; offset + size <= stdout.length; offset += size) frames.push(stdout.subarray(offset, offset + size));
  return frames;
}

function maxFrameDiff(left, right) {
  let worst = 0;
  for (let index = 0; index < left.length; index += 1) {
    let sum = 0;
    for (let pixel = 0; pixel < left[index].length; pixel += 1) sum += Math.abs(left[index][pixel] - right[index][pixel]);
    worst = Math.max(worst, sum / left[index].length);
  }
  return worst;
}

test("Windows のコマンド行: libuv と同じ規則で引数を quote し、長さを数える", () => {
  assert.equal(windowsQuotedArgument("abc"), "abc");
  assert.equal(windowsQuotedArgument(""), "\"\"");
  assert.equal(windowsQuotedArgument("a b"), "\"a b\"");
  assert.equal(windowsQuotedArgument("C:\\Program Files\\x"), "\"C:\\Program Files\\x\"");
  assert.equal(windowsQuotedArgument("a b\\"), "\"a b\\\\\"", "末尾の \\ は閉じる \" の前で二重にする");
  assert.equal(windowsQuotedArgument("a\"b"), "\"a\\\"b\"");
  assert.equal(windowsQuotedArgument("C:\\x\\y.png"), "C:\\x\\y.png", "空白の無い path はそのまま");
  assert.equal(windowsCommandLineLength("ffmpeg", ["-i", "a b"]), "ffmpeg -i \"a b\"".length);
  assert.equal(ffmpegCommandLineLength({ command: "ffmpeg", args: ["-nostdin"] }, ["-y"]), "ffmpeg -nostdin -y".length);
  assert.ok(FFMPEG_COMMAND_LINE_BUDGET < WINDOWS_COMMAND_LINE_MAX);
});

test("塊の計画: 長い path の区間を足していき上限の手前で閉じ、crossfade の境目では手前の区間を分けて転換を次の塊へ送る", () => {
  const path = `C:\\${"x".repeat(900)}\\scene.png`;
  const unit = (index, frames = 10) => ({
    id: `u${index}`,
    frames,
    inputs: ["-loop", "1", "-framerate", "12", "-i", path],
    chain: (input, label) => `[${input}:v]null,trim=end_frame=${frames}[${label}]`,
    split: () => [
      { ...unit(index, 5), id: `u${index}#a` },
      { ...unit(index, frames - 5), id: `u${index}#b` },
    ],
  });
  const units = Array.from({ length: 100 }, (_, index) => unit(index));
  const cuts = planSequenceChunks({ ffmpeg: { command: "ffmpeg", args: [] }, units, joins: units.slice(1).map(() => ({ type: "cut" })), fps: 12, encode: ENCODE, outputPath: "C:\\out\\story.mp4", workDir: "C:\\out\\chunks" });
  assert.ok(cuts.length >= 3, `${cuts.length} chunks`);
  assert.ok(cuts.every((chunk) => chunk.commandLength <= FFMPEG_COMMAND_LINE_BUDGET));
  assert.equal(cuts.reduce((sum, chunk) => sum + chunk.units.length, 0), 100);
  const fades = planSequenceChunks({ ffmpeg: { command: "ffmpeg", args: [] }, units, joins: units.slice(1).map(() => ({ type: "crossfade", frames: 4 })), fps: 12, encode: ENCODE, outputPath: "C:\\out\\story.mp4", workDir: "C:\\out\\chunks" });
  assert.ok(fades.length >= 3);
  for (const [index, chunk] of fades.entries()) {
    assert.ok(chunk.commandLength <= FFMPEG_COMMAND_LINE_BUDGET);
    if (index > 0) assert.match(chunk.units[0].id, /#b$/u, "塊の頭は前の塊で分けた区間の後ろ半分");
    if (index < fades.length - 1) assert.match(chunk.units.at(-1).id, /#a$/u);
    assert.equal(chunk.joins.length, chunk.units.length - 1);
  }
  // 区間を足し引きしていない（分けた区間は前半と後半で1つ）。長さも同じ。
  const frames = fades.reduce((sum, chunk) => sum + chunk.built.frames, 0);
  assert.equal(frames, 100 * 10 - 99 * 4);
});

test("長い台本の場面の列（深いフォルダの画 60 枚、crossfade つき）: 1回の呼び出しでは上限を越える長さでも、塊に分けて描き、1回で描いた版と画素まで同じ絵・同じフレーム数になる", {
  skip: toolchain.ok ? false : "ffmpeg is unavailable",
}, async () => {
  const root = await mkdtemp(join(os.tmpdir(), "ffmpeg-sequence-"));
  try {
    const dir = await deepDir(root, 4);
    const stills = [];
    for (let index = 0; index < 3; index += 1) {
      const still = join(dir, `scene-${index}.png`);
      await makeTexturedStill(toolchain, still, { width: 128, height: 72, phase: index * 17 });
      stills.push(still);
    }
    const segments = Array.from({ length: 60 }, (_, index) => ({ id: `s${index}`, imageKey: `s${index}`, imagePath: stills[index % 3], startFrame: index * 8, frames: 8 }));
    const plan = planNarratedCameraShots({ segments, camera: CAMERA, fps: RENDER.fps });
    const joins = planNarratedSceneJoins({ shots: plan.shots, transition: { type: "crossfade", frames: 4 } });
    const sequence = narratedSceneSequence({ shots: plan.shots, joins, render: RENDER });
    const single = await renderVideoSequence({ ffmpeg: toolchain.ffmpeg, units: sequence.units, joins: sequence.joins, fps: RENDER.fps, outputPath: join(dir, "single.mp4"), encode: ENCODE, budget: 10_000_000 });
    assert.equal(single.assembly, "single");
    assert.ok(single.maxCommandLength > WINDOWS_COMMAND_LINE_MAX, `1回で描くと ${single.maxCommandLength} 字（上限 ${WINDOWS_COMMAND_LINE_MAX}）`);
    const chunked = await renderVideoSequence({ ffmpeg: toolchain.ffmpeg, units: sequence.units, joins: sequence.joins, fps: RENDER.fps, outputPath: join(dir, "chunked.mp4"), encode: ENCODE });
    assert.equal(chunked.assembly, "concat-demuxer");
    assert.ok(chunked.chunks.length >= 2, `${chunked.chunks.length} chunks`);
    assert.ok(chunked.maxCommandLength <= FFMPEG_COMMAND_LINE_BUDGET, `最長 ${chunked.maxCommandLength} 字`);
    assert.ok(chunked.chunks.every((chunk) => chunk.commandLength < WINDOWS_COMMAND_LINE_MAX));
    assert.equal(chunked.frames, 480);
    const [left, right] = await Promise.all([grayFrames(join(dir, "single.mp4")), grayFrames(join(dir, "chunked.mp4"))]);
    assert.equal(left.length, 480);
    assert.equal(right.length, 480);
    const diff = maxFrameDiff(left, right);
    assert.equal(diff, 0, `1回で描いた版との差 ${diff}（塊の境目でも、分けた場面の後ろ半分でも同じ絵）`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("長い台本の声（深いフォルダの声 160 本、44.1kHz と 48kHz が混ざる）: 塊に分けてつないでも、1回でつないだ版と標本が同じ", {
  skip: toolchain.ok ? false : "ffmpeg is unavailable",
}, async () => {
  const root = await mkdtemp(join(os.tmpdir(), "ffmpeg-audio-sequence-"));
  try {
    const dir = await deepDir(root);
    const paths = [];
    for (let index = 0; index < 4; index += 1) {
      const path = join(dir, `voice-${index}.wav`);
      await ff(toolchain, ["-f", "lavfi", "-i", `sine=frequency=${300 + index * 60}:duration=0.05:sample_rate=${index % 2 ? 44100 : 48000}`, "-ac", "1", "-c:a", "pcm_s16le", path]);
      paths.push(path);
    }
    const list = Array.from({ length: 160 }, (_, index) => paths[index % 4]);
    const single = await concatAudioSequence({ ffmpeg: toolchain.ffmpeg, paths: list, outputPath: join(dir, "single.wav"), budget: 10_000_000 });
    assert.ok(single.maxCommandLength > WINDOWS_COMMAND_LINE_MAX);
    const chunked = await concatAudioSequence({ ffmpeg: toolchain.ffmpeg, paths: list, outputPath: join(dir, "chunked.wav") });
    assert.ok(chunked.chunks.length >= 2);
    assert.ok(chunked.maxCommandLength <= FFMPEG_COMMAND_LINE_BUDGET);
    assert.equal(chunked.inputCount, 160);
    const pcm = async (file) => {
      const { stdout } = await execFile(toolchain.ffmpeg.command, [...(toolchain.ffmpeg.args || []), "-hide_banner", "-loglevel", "error", "-i", file, "-f", "s16le", "-"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    };
    const [left, right] = await Promise.all([pcm(join(dir, "single.wav")), pcm(join(dir, "chunked.wav"))]);
    assert.ok(left.length > 0);
    assert.equal(Buffer.compare(left, right), 0, "標本が1つも違わない");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
