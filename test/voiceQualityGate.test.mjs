import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

// 判定は本体と同じ関数に聞く。ここが独自に PATH の python3 と別のモジュール
// 集合を調べていたので、「本体は動くのにテストは skip」「本体は動かないのに
// テストは走る」のどちらも起こりえた。可用性の定義が3つあった
// （本体 / doctor / このテスト）のを1つに寄せる。
async function voiceDepsAvailable() {
  const { voiceQualityAvailable } = await import("../lib/voiceQualityGate.mjs");
  return voiceQualityAvailable();
}

test("voice quality gate reports metrics and honest unavailability", async (t) => {
  if (!(await voiceDepsAvailable())) {
    const { DEFAULT_VOICE_QA_PYTHON } = await import("../lib/voiceQualityGate.mjs");
    t.skip(`音声QA環境が無い（${DEFAULT_VOICE_QA_PYTHON} に numpy/soundfile/pyworld/torch/faster_whisper/fugashi と UTMOS キャッシュが要る）`);
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "voice-gate-"));
  try {
    const makeWav = `
import numpy as np, soundfile as sf, sys
sr = 16000
t = np.arange(sr * 3) / sr
# amplitude-modulated tone with pitch movement so f0 extraction has content
wave = 0.3 * np.sin(2 * np.pi * (140 + 30 * np.sin(2 * np.pi * 0.7 * t)) * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 3 * t))
sf.write(sys.argv[1], wave, sr)
print("ok")
`;
    const wav = join(dir, "synthetic.wav");
    await execFile("python3", ["-c", makeWav, wav]);
    const config = {
      checks: [{
        id: "synthetic",
        type: "voiceQuality",
        audio: wav,
        // lenient thresholds: this test asserts structure, not quality
        minUtmos: 0.0,
        minF0SemitoneStd: 0.0,
        maxEdgeSilenceSec: 5.0,
      }],
    };
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify(config));
    const { stdout } = await execFile("python3", ["scripts/audit-voice-quality.py", configPath], {
      maxBuffer: 8 * 1024 * 1024,
    });
    const report = JSON.parse(stdout);
    assert.equal(report.checks.length, 1);
    const check = report.checks[0];
    assert.equal(check.id, "synthetic");
    assert.ok(["pass", "warn"].includes(check.status), `unexpected status ${check.status}`);
    assert.ok(typeof check.metrics.durationSec === "number");
    assert.ok(typeof check.metrics.peak === "number");
    assert.ok(Array.isArray(check.metrics.edgeSilenceSec));
    assert.ok(Object.keys(check.inputSha256).length === 1);
    // every skipped metric must be declared, never silently passed
    for (const entry of check.unavailable) assert.ok(typeof entry === "string" && entry.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
