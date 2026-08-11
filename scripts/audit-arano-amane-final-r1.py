#!/usr/bin/env python3
"""Final rendered-audio/STT audit for manga-arano-amane-reversal-001.

The recognizer reads the audio decoded from the actual MP4.  In addition to
script-order recognition, every authored utterance window is checked for
audible energy and safe encoded edges so a successful source-generation job
cannot conceal a dropped or shaved line in the assembled master.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import tempfile
import unicodedata
import wave
from difflib import SequenceMatcher
from pathlib import Path

import numpy as np


NAME_VARIANTS = {
    "荒野": "あらの",
    "花園": "はなぞの",
    "上沢": "かんざわ",
    "天音": "あまね",
    "さくら": "さくら",
    "T大": "てぃーだい",
    "Ｔ大": "てぃーだい",
    "ライン": "らいん",
    "LINE": "らいん",
}


def normalize(text: str) -> str:
    value = unicodedata.normalize("NFKC", text or "")
    value = re.sub(r"\[[^\]]*\]", "", value)
    for source, target in NAME_VARIANTS.items():
        value = value.replace(source, target)
    value = re.sub(r"[\s、。！？!?…‥.,「」『』()（）・/\-—―:：]", "", value)
    return "".join(
        chr(ord(char) - 0x60) if "ァ" <= char <= "ヶ" else char
        for char in value
    )


def dbfs(value: float) -> float:
    return 20.0 * math.log10(max(float(value), 1e-12))


def ordered_coverage(expected: str, heard: str) -> tuple[float, float, list[dict]]:
    matcher = SequenceMatcher(None, expected, heard, autojunk=False)
    blocks = [block for block in matcher.get_matching_blocks() if block.size >= 2]
    coverage = sum(block.size for block in blocks) / max(1, len(expected))
    return matcher.ratio(), coverage, [
        {"expectedIndex": block.a, "heardIndex": block.b, "length": block.size}
        for block in blocks
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--video", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--model", default="tiny")
    args = parser.parse_args()

    manifest_path = args.manifest.resolve()
    video_path = args.video.resolve()
    output_path = args.output.resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temporary:
        wav_path = Path(temporary.name)
    try:
        subprocess.run(
            [
                "ffmpeg", "-v", "error", "-y", "-i", str(video_path),
                "-map", "0:a:0", "-af", "aresample=async=1:first_pts=0",
                "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
                str(wav_path),
            ],
            check=True,
        )
        with wave.open(str(wav_path), "rb") as wav_file:
            sample_rate = wav_file.getframerate()
            pcm = np.frombuffer(wav_file.readframes(wav_file.getnframes()), dtype="<i2").astype(np.float64) / 32768.0

        from faster_whisper import WhisperModel

        model = WhisperModel(args.model, device="cpu", compute_type="int8")
        segment_iter, info = model.transcribe(
            str(wav_path),
            language="ja",
            beam_size=3,
            best_of=3,
            condition_on_previous_text=False,
            vad_filter=False,
        )
        transcript_segments = [
            {"startSeconds": float(segment.start), "endSeconds": float(segment.end), "text": segment.text.strip()}
            for segment in segment_iter
        ]
    finally:
        try:
            os.unlink(wav_path)
        except FileNotFoundError:
            pass

    utterances = manifest.get("utterances", [])
    expected_full = normalize("".join((entry.get("speechText") or entry.get("text") or "") for entry in utterances))
    heard_full = normalize("".join(segment["text"] for segment in transcript_segments))
    global_ratio, global_coverage, matching_blocks = ordered_coverage(expected_full, heard_full)

    cut_rows = []
    utterances_by_cut: dict[str, list[dict]] = {}
    for utterance in utterances:
        utterances_by_cut.setdefault(utterance["cutId"], []).append(utterance)
    for cut in manifest.get("cuts", []):
        start = float(cut["timing"]["startSeconds"])
        end = float(cut["timing"]["endSeconds"])
        expected = normalize("".join(
            entry.get("speechText") or entry.get("text") or ""
            for entry in utterances_by_cut.get(cut["id"], [])
        ))
        heard = normalize("".join(
            segment["text"] for segment in transcript_segments
            if segment["endSeconds"] > start - 0.35 and segment["startSeconds"] < end + 0.35
        ))
        ratio, coverage, _ = ordered_coverage(expected, heard)
        cut_rows.append({
            "cutId": cut["id"],
            "expectedCharacters": len(expected),
            "heardCharacters": len(heard),
            "similarity": round(ratio, 4),
            "orderedCoverage": round(coverage, 4),
            "pass": bool(ratio >= 0.28 or coverage >= 0.36),
        })

    signal_rows = []
    missing_audio = []
    unsafe_edges = []
    for utterance in utterances:
        timing = utterance["timing"]
        start = max(0, int(round(float(timing["audioStartSeconds"]) * sample_rate)))
        end = min(len(pcm), int(round(float(timing["audioEndSeconds"]) * sample_rate)))
        samples = pcm[start:end]
        if len(samples) == 0:
            row = {"id": utterance["id"], "pass": False, "reason": "empty-window"}
            signal_rows.append(row)
            missing_audio.append(utterance["id"])
            continue
        rms = float(np.sqrt(np.mean(samples * samples) + 1e-24))
        peak = float(np.max(np.abs(samples)))
        edge_count = min(len(samples), max(1, int(sample_rate * 0.012)))
        opening_peak = float(np.max(np.abs(samples[:edge_count])))
        closing_peak = float(np.max(np.abs(samples[-edge_count:])))
        audible = dbfs(rms) > -42.0 and dbfs(peak) > -30.0
        # The renderer applies short fades.  AAC may retain low-level pre-echo,
        # but a large encoded boundary impulse remains a meaningful failure.
        edge_safe = opening_peak < 0.36 and closing_peak < 0.36
        row = {
            "id": utterance["id"],
            "rmsDbfs": round(dbfs(rms), 3),
            "peakDbfs": round(dbfs(peak), 3),
            "opening12msPeak": round(opening_peak, 5),
            "closing12msPeak": round(closing_peak, 5),
            "audible": audible,
            "encodedEdgesSafe": edge_safe,
            "pass": bool(audible and edge_safe),
        }
        signal_rows.append(row)
        if not audible:
            missing_audio.append(utterance["id"])
        if not edge_safe:
            unsafe_edges.append(utterance["id"])

    source_audit_path = manifest_path.parent / "audits" / "speech-source-audit-r2.json"
    source_audit = json.loads(source_audit_path.read_text(encoding="utf-8"))
    stt_pass = (
        global_ratio >= 0.42
        and global_coverage >= 0.50
        and all(row["pass"] for row in cut_rows)
    )
    signal_pass = not missing_audio and not unsafe_edges
    result = {
        "version": "arano-amane-final-stt-signal-r1",
        "videoPath": str(video_path),
        "manifestPath": str(manifest_path),
        "recognizer": f"faster-whisper {args.model} int8, actual MP4 audio",
        "languageProbability": float(info.language_probability),
        "transcript": transcript_segments,
        "global": {
            "expectedCharacters": len(expected_full),
            "heardCharacters": len(heard_full),
            "similarity": round(global_ratio, 4),
            "orderedCoverage": round(global_coverage, 4),
            "matchingBlocks": matching_blocks,
            "pass": stt_pass,
        },
        "cuts": cut_rows,
        "signalRows": signal_rows,
        "missingAudioIds": missing_audio,
        "unsafeEncodedEdgeIds": unsafe_edges,
        "sourceAlignmentAudit": {
            "path": str(source_audit_path),
            "pass": source_audit.get("pass") is True,
            "utteranceCount": source_audit.get("utteranceCount", len(utterances)),
        },
        "gates": {
            "sttScriptOrderAndCoverage": stt_pass,
            "allRenderedUtteranceWindowsAudible": not missing_audio,
            "allRenderedUtteranceEdgesSafe": not unsafe_edges,
            "providerAlignmentExact": source_audit.get("pass") is True,
        },
        "pass": bool(stt_pass and signal_pass and source_audit.get("pass") is True),
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "pass": result["pass"],
        "global": result["global"],
        "cutFailures": [row for row in cut_rows if not row["pass"]],
        "missingAudioIds": missing_audio,
        "unsafeEncodedEdgeIds": unsafe_edges,
    }, ensure_ascii=False, indent=2))
    if not result["pass"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
