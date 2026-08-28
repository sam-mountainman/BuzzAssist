import test from "node:test";
import assert from "node:assert/strict";

import { auditMangaVideoQuality, parseEbur128Summary, parseSilenceDetectLog } from "../lib/mangaVideoQuality.mjs";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";

test("ffmpeg silence detection events are paired with measured durations", () => {
  const log = `
[silencedetect @ 0x1] silence_start: 2.4
[silencedetect @ 0x1] silence_end: 3.75 | silence_duration: 1.35
[silencedetect @ 0x1] silence_start: 7
[silencedetect @ 0x1] silence_end: 7.6 | silence_duration: 0.6`;
  assert.deepEqual(parseSilenceDetectLog(log), [
    { startSeconds: 2.4, endSeconds: 3.75, durationSeconds: 1.35 },
    { startSeconds: 7, endSeconds: 7.6, durationSeconds: 0.6 },
  ]);
});

test("EBU R128 final summary is parsed instead of frame-by-frame readings", () => {
  const log = `I: -70.0 LUFS
Summary:
  Integrated loudness:
    I:         -18.2 LUFS
  Loudness range:
    LRA:         5.6 LU
  True peak:
    Peak:       -1.7 dBFS`;
  assert.deepEqual(parseEbur128Summary(log), {
    integratedLufs: -18.2,
    loudnessRangeLu: 5.6,
    truePeakDbfs: -1.7,
  });
});

const runFf = promisify(execFile);
async function ffmpegAvailable() {
  try { await runFf("ffmpeg", ["-version"]); return true; } catch { return false; }
}

// 最終監査はこのステップを "full-decode" という名前で呼ぶ。以前は ffprobe で
// メタデータを読み音声を1回解析するだけで、映像を一度もデコードしていなかった。
// 壊れたフレームを含むMP4がそのまま合格しうる状態だった。
test("full-decode は壊れた動画を落とす", async (t) => {
  if (!await ffmpegAvailable()) { t.skip("ffmpeg が無い"); return; }
  const dir = await mkdtemp(join(tmpdir(), "decode-gate-"));
  try {
    const ok = join(dir, "ok.mp4");
    const broken = join(dir, "broken.mp4");
    await runFf("ffmpeg", [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-c:a", "aac", "-shortest", ok,
    ]);
    const bytes = await readFile(ok);
    const mid = Math.floor(bytes.length / 2);
    await writeFile(broken, Buffer.concat([
      bytes.subarray(0, mid), Buffer.alloc(3000), bytes.subarray(mid + 3000),
    ]));

    const manifest = join(dir, "manifest.json");
    await writeFile(manifest, JSON.stringify({
      id: "t", metrics: { videoDurationSeconds: 2 },
      video: { width: 320, height: 240 }, cuts: [],
    }));

    const healthy = await auditMangaVideoQuality({ videoPath: ok, manifestPath: manifest });
    assert.equal(healthy.gates.fullDecode, true, "健全な動画が落ちた");
    assert.equal(healthy.fullDecode.pass, true);

    const damaged = await auditMangaVideoQuality({ videoPath: broken, manifestPath: manifest });
    assert.equal(damaged.gates.fullDecode, false, "壊れた動画が全デコードを通った");
    assert.equal(damaged.pass, false, "壊れた動画が総合合格になった");
    assert.ok(damaged.fullDecode.detail.length > 0, "失敗の詳細が残っていない");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
