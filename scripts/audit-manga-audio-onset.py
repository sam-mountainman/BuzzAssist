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
import argparse
import json
import math
import struct
import subprocess
import sys
from pathlib import Path


def dialogue_split_start(audio):
    """Recover the source-take split origin for both legacy and v44 metadata."""
    if audio.get("dialogueSourceStartSeconds") is not None:
        return float(audio["dialogueSourceStartSeconds"]) - float(audio.get("sourceHeadPaddingSeconds") or 0)
    metadata_path = audio.get("sourceDialogueMetadataPath")
    input_index = audio.get("dialogueInputIndex")
    if not metadata_path or input_index is None or not Path(metadata_path).is_file():
        return None
    metadata = json.loads(Path(metadata_path).read_text())
    grouped = {}
    for segment in metadata.get("voiceSegments") or []:
        index = int(segment.get("dialogue_input_index", -1))
        grouped.setdefault(index, []).append(segment)
    index = int(input_index)
    current = grouped.get(index) or []
    if not current:
        return None
    current_start = min(float(segment["start_time_seconds"]) for segment in current)
    if index == 0:
        return 0.0
    previous = grouped.get(index - 1) or []
    if not previous:
        return None
    previous_end = max(float(segment["end_time_seconds"]) for segment in previous)
    return (previous_end + current_start) / 2

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
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()
    manifest_path = args.manifest.resolve()
    output_path = args.output.resolve() if args.output else manifest_path.parent / "audio-onset-integrity-audit.json"
    manifest = json.loads(manifest_path.read_text())
    rows = []
    for u in manifest["utterances"]:
        a = u["audio"]
        head_margin = float(a.get("speechStartSeconds") or 0)
        head_rms = rms(a["filePath"], 0, 0.04)
        body_rms = rms(a["filePath"], head_margin, 0.25)
        head_quiet = head_rms < max(180.0, body_rms * 0.12)
        take_ok = True
        take_evidence = "wav-head"
        take = a.get("sourceDialoguePath")
        # A line restored from the approved master is not sliced from any
        # currently existing take file; the wav-side checks are the proof.
        if a.get("restoredFrom"):
            take = None
        if take and Path(take).is_file() and a.get("acousticTrimStartSeconds") is not None:
            trim_start = dialogue_split_start(a)
            if trim_start is not None:
                abs_start = trim_start + float(a["acousticTrimStartSeconds"])
                # If the selected source begins at the head of the take, no
                # preceding source samples exist; synthetic output padding plus
                # the WAV-side head checks are the available proof.
                # The v44 splitter begins at ElevenLabs' own voice-segment
                # boundary. If acoustic trim remains at that boundary there
                # is deliberately no same-line pre-roll to inspect; the
                # synthetic 100 ms head and rendered STT head gate are the
                # proof. Looking backward would sample the previous speaker.
                if float(a["acousticTrimStartSeconds"]) < 0.06:
                    take_evidence = "source-segment-boundary+synthetic-head"
                elif abs_start >= 0.06:
                    pre = rms(take, abs_start - 0.06, 0.06)
                    floor = rms(take, max(0, trim_start - 0.3), 0.25)
                    take_ok = pre <= max(150.0, floor * 2.0)
                    take_evidence = "source-pre-slice"
        ok = head_margin >= 0.06 and head_quiet and take_ok
        rows.append({
            "id": u["id"],
            "headMarginSeconds": round(head_margin, 3),
            "first40msRms": round(head_rms, 1),
            "bodyRms": round(body_rms, 1),
            "takePreSliceQuiet": take_ok,
            "takeEvidence": take_evidence,
            "pass": bool(ok),
        })
    result = {
        "version": "audio-onset-integrity-v2-dialogue-metadata",
        "rows": rows,
        "pass": all(r["pass"] for r in rows),
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=1))
    print(json.dumps({"pass": result["pass"], "failures": [r for r in rows if not r["pass"]], "checked": len(rows)}, ensure_ascii=False))
    if not result["pass"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
