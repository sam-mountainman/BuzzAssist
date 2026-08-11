#!/usr/bin/env python3
"""R61 gate: no utterance may start with a shaved consonant attack.

Checks, for every utterance wav:
 1. head margin: audio.speechStartSeconds >= 0.06 (approved restores keep
    their approved 0.07; freshly sliced lines get the widened 0.10 margin);
 2. the first 40 ms of the wav sit at noise-floor level (if the file began
    mid-phoneme there would be immediate speech energy);
 3. take-side proof where a source take exists: the 60 ms of take audio just
    BEFORE the final slice start are at floor level (nothing audible was cut
    off).
"""
import json
import math
import struct
import subprocess
import sys
from pathlib import Path

MANIFEST = Path("canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json")


def rms(path, start, dur):
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", str(max(0, start)), "-t", str(dur),
         "-i", str(path), "-f", "s16le", "-ac", "1", "-ar", "16000", "-"],
        capture_output=True).stdout
    if len(out) < 32:
        return 0.0
    n = len(out) // 2
    vals = struct.unpack("<%dh" % n, out[:n * 2])
    return math.sqrt(sum(v * v for v in vals) / n)


def main():
    manifest = json.loads(MANIFEST.read_text())
    rows = []
    for u in manifest["utterances"]:
        a = u["audio"]
        head_margin = float(a.get("speechStartSeconds") or 0)
        head_rms = rms(a["filePath"], 0, 0.04)
        body_rms = rms(a["filePath"], head_margin, 0.25)
        head_quiet = head_rms < max(180.0, body_rms * 0.12)
        take_ok = True
        take = a.get("sourceDialoguePath")
        # A line restored from the approved master is not sliced from any
        # currently existing take file; the wav-side checks are the proof.
        if a.get("restoredFrom"):
            take = None
        if take and Path(take).is_file() and a.get("acousticTrimStartSeconds") is not None:
            char_start = a["dialogueSourceStartSeconds"]
            trim_start = char_start - a["sourceHeadPaddingSeconds"]
            abs_start = trim_start + a["acousticTrimStartSeconds"]
            pre = rms(take, abs_start - 0.06, 0.06)
            floor = rms(take, max(0, trim_start - 0.3), 0.25)
            take_ok = pre <= max(150.0, floor * 2.0)
        ok = head_margin >= 0.06 and head_quiet and take_ok
        rows.append({
            "id": u["id"],
            "headMarginSeconds": round(head_margin, 3),
            "first40msRms": round(head_rms, 1),
            "bodyRms": round(body_rms, 1),
            "takePreSliceQuiet": take_ok,
            "pass": bool(ok),
        })
    result = {
        "version": "audio-onset-integrity-v1",
        "rows": rows,
        "pass": all(r["pass"] for r in rows),
    }
    (MANIFEST.parent / "audio-onset-integrity-audit.json").write_text(json.dumps(result, indent=1))
    print(json.dumps({"pass": result["pass"], "failures": [r for r in rows if not r["pass"]], "checked": len(rows)}, ensure_ascii=False))
    if not result["pass"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
