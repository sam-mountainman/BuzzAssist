#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { INLINE_FILTER_GRAPH_MAX, ffmpegMajorVersion, filterComplexArgs } from "../lib/ffmpegFilterArgs.mjs";
import { resolveFfmpegToolchain } from "../lib/harnessRuntimeResolver.mjs";
import { renderSegmentImagesPart } from "../lib/narratedStoryBookends.mjs";
import { ff, makeTexturedStill } from "./fixtures/narratedVisualFixture.mjs";

const execFile = promisify(execFileCallback);
const toolchain = await resolveFfmpegToolchain();

test("filter_complex: 短い graph は引数で、長い graph はファイルで渡し、FFmpeg の版で渡し方を選ぶ", async () => {
  const dir = await mkdtemp(join(os.tmpdir(), "ffmpeg-filter-args-"));
  try {
    assert.deepEqual(await filterComplexArgs({ version: "7.1.1" }, "[0:v]null[v]", dir), ["-filter_complex", "[0:v]null[v]"]);
    const long = `[0:v]${"null,".repeat(INLINE_FILTER_GRAPH_MAX / 4)}null[v]`;
    const modern = await filterComplexArgs({ version: "9.0.2" }, long, dir);
    assert.equal(modern[0], "-/filter_complex");
    assert.equal(await readFile(modern[1], "utf8"), long);
    assert.equal((await filterComplexArgs({ version: "6.1.1-3ubuntu5" }, long, dir))[0], "-filter_complex_script");
    assert.equal((await filterComplexArgs({ version: "N-117000-gabc" }, long, dir))[0], "-/filter_complex", "版が読めない build は新しい方");
    assert.equal(ffmpegMajorVersion({ version: "6.1.1" }), 6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("場面の多い部: カメラの式が引数の上限を越える長さでも、ファイルで渡して描ける", { skip: toolchain.ok ? false : "ffmpeg is unavailable" }, async () => {
  const dir = await mkdtemp(join(os.tmpdir(), "ffmpeg-filter-args-render-"));
  try {
    const still = join(dir, "still.png");
    await makeTexturedStill(toolchain, still, { width: 160, height: 90 });
    const segments = Array.from({ length: 40 }, (_, index) => ({ id: `s${index}`, imageKey: `s${index}`, imagePath: still, partStartFrame: index * 3, frames: 3 }));
    const config = { render: { width: 160, height: 90, fps: 24 } };
    const output = join(dir, "part.mp4");
    const rendered = await renderSegmentImagesPart({ ffmpeg: toolchain.ffmpeg, segments, config, outputPath: output });
    assert.ok(rendered.graph.filterGraph.length > INLINE_FILTER_GRAPH_MAX, `graph ${rendered.graph.filterGraph.length} chars`);
    const { stdout } = await execFile(toolchain.ffprobe.command, [...(toolchain.ffprobe.args || []), "-v", "error", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", output]);
    assert.equal(Number(stdout.trim()), 120);
    await ff(toolchain, ["-i", output, "-f", "null", "-"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
