import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("STT cache cannot reuse stale rows after the same MP4 path receives new PCM", () => {
  const source = String.raw`
import importlib.util
import json
import tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("stt_audit", "scripts/audit-manga-stt-verification.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

with tempfile.TemporaryDirectory() as root:
    output = Path(root) / "stt.json"
    video = Path(root) / "final.mp4"
    video.write_bytes(b"new-container-at-same-path")
    output.write_text(json.dumps({
        "pass": True,
        "videoPath": str(video),
        "audioSha256": "a" * 64,
        "expectedSpeechSha256": "e" * 64,
        "rows": [{"id": "u1", "pass": True}],
    }))
    assert module.reusable_cached_report(output, str(video), "b" * 64, "e" * 64, ["u1"]) is None
    assert module.reusable_cached_report(output, str(video), "a" * 64, "e" * 64, ["u1"])["pass"] is True
    assert module.reusable_cached_report(output, str(video), "a" * 64, "f" * 64, ["u1"]) is None
`;
  const result = spawnSync("python3", ["-c", source], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
