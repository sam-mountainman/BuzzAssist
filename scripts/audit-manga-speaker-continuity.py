#!/usr/bin/env python3
"""R134 gate: no utterance may open or close with a different character's voice.

The cut-level dialogue take holds every speaker of a cut in one waveform, and
the provider's per-segment `start_time_seconds` is an approximation. When a
split lands inside the previous speaker's still-sounding tail, the residue is
prepended to the next line: the audience hears one character's voice for a
fraction of a second at the head of another character's balloon, and the
truncated line sounds clipped. Neither STT similarity, onset-shape checks, nor
click detection catches this, because none of them asks *whose* voice is
sounding.

Speaker identity here is measured from the spectral envelope, not from pitch.
Autocorrelation pitch is unusable for this gate: a weak fundamental at a line's
onset makes a low male voice measure at two or three times its true frequency,
and the obvious octave correction then drags female voices down onto their own
subharmonics. A cepstral-mean-normalised log-mel envelope compares vocal tract
timbre instead, which is what actually distinguishes two performers.

Speaker pairs that are genuinely the same voice — this channel narrates in the
protagonist's own approved voice — are not separable and are reported as
`skipped` with the reason, never silently passed.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

SAMPLE_RATE = 48_000
FFT_SIZE = 2048
MEL_BANDS = 26
MEL_MIN_HZ = 80.0
MEL_MAX_HZ = 7000.0
HOP_SECONDS = 0.010
VOICED_RMS = 0.012
HEAD_SECONDS = 0.40
TAIL_SECONDS = 0.30
MIN_PROFILE_FRAMES = 4
MIN_REFERENCE_FRAMES = 2
# Two references closer than this are the same performer (narration shares the
# protagonist's voice), so no boundary between them can be attributed.
MIN_REFERENCE_DISTANCE = 0.05
# A window is a leak when it sits materially closer to the neighbour than to
# its own speaker; the margin keeps ordinary onset colouring from tripping it.
LEAK_RATIO = 0.7


def mel_filterbank():
    def to_mel(hz):
        return 2595.0 * np.log10(1.0 + hz / 700.0)

    def to_hz(mel):
        return 700.0 * (10.0 ** (mel / 2595.0) - 1.0)

    points = to_hz(np.linspace(to_mel(MEL_MIN_HZ), to_mel(MEL_MAX_HZ), MEL_BANDS + 2))
    bins = np.floor((FFT_SIZE + 1) * points / SAMPLE_RATE).astype(int)
    bank = np.zeros((MEL_BANDS, FFT_SIZE // 2 + 1))
    for band in range(1, MEL_BANDS + 1):
        left, centre, right = bins[band - 1], bins[band], bins[band + 1]
        centre = max(centre, left + 1)
        right = min(max(right, centre + 1), FFT_SIZE // 2)
        for index in range(left, centre):
            bank[band - 1, index] = (index - left) / (centre - left)
        for index in range(centre, right):
            bank[band - 1, index] = (right - index) / (right - centre)
    return bank


FILTERBANK = mel_filterbank()
WINDOW = np.hanning(FFT_SIZE)


def decode_audio(path):
    process = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-vn",
         "-ar", str(SAMPLE_RATE), "-ac", "1", "-f", "f32le", "-"],
        check=True, capture_output=True,
    )
    return np.frombuffer(process.stdout, dtype=np.float32)


def voice_profile(samples, from_seconds, to_seconds):
    """Mean log-mel envelope of the voiced frames, mean-normalised.

    Subtracting the vector mean removes per-line loudness normalisation and
    channel colouring, leaving the speaker-dependent spectral shape.
    """
    hop = int(SAMPLE_RATE * HOP_SECONDS)
    first = max(0, int(from_seconds * SAMPLE_RATE))
    last = min(len(samples), int(to_seconds * SAMPLE_RATE))
    frames = []
    for start in range(first, max(first, last - FFT_SIZE) + 1, hop):
        frame = samples[start:start + FFT_SIZE].astype(np.float64)
        if len(frame) < FFT_SIZE:
            break
        if np.sqrt(float(np.mean(frame ** 2))) < VOICED_RMS:
            continue
        spectrum = np.abs(np.fft.rfft(frame * WINDOW)) ** 2
        frames.append(np.log(FILTERBANK @ spectrum + 1e-10))
    if len(frames) < 2:
        return None, len(frames)
    envelope = np.mean(frames, axis=0)
    return envelope - float(np.mean(envelope)), len(frames)


def distance(left, right):
    denominator = float(np.linalg.norm(left) * np.linalg.norm(right)) + 1e-12
    return float(1.0 - float(np.dot(left, right)) / denominator)


def utterance_windows(manifest):
    cut_start = {cut["id"]: float(cut["timing"]["startSeconds"]) for cut in manifest["cuts"]}
    rows = []
    for utterance in manifest["utterances"]:
        timing = utterance.get("timing") or {}
        audio = utterance.get("audio") or {}
        base = cut_start[utterance["cutId"]] + float(timing["audioStartInCutSeconds"])
        rows.append({
            "id": utterance["id"],
            "speaker": utterance.get("speakerName") or utterance.get("speakerId") or "",
            "speechStartSeconds": base + float(audio["speechStartSeconds"]),
            "speechEndSeconds": base + float(audio["speechEndSeconds"]),
        })
    rows.sort(key=lambda row: row["speechStartSeconds"])
    return rows


def build_references(samples, rows):
    """Reference timbre per speaker, measured away from both line boundaries."""
    collected = {}
    for row in rows:
        duration = row["speechEndSeconds"] - row["speechStartSeconds"]
        if duration <= 0.6:
            continue
        envelope, frames = voice_profile(
            samples,
            row["speechStartSeconds"] + duration * 0.35,
            row["speechStartSeconds"] + duration * 0.95,
        )
        if envelope is not None and frames >= MIN_REFERENCE_FRAMES:
            collected.setdefault(row["speaker"], []).append(envelope)
    return {speaker: np.mean(values, axis=0) for speaker, values in collected.items() if values}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--video", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    manifest = json.loads(Path(args.manifest).read_text())
    samples = decode_audio(Path(args.video))
    rows = utterance_windows(manifest)
    references = build_references(samples, rows)

    findings = []
    for index, row in enumerate(rows):
        neighbours = (
            ("head", rows[index - 1] if index > 0 else None),
            ("tail", rows[index + 1] if index + 1 < len(rows) else None),
        )
        for side, neighbour in neighbours:
            if neighbour is None or neighbour["speaker"] == row["speaker"]:
                continue
            own_reference = references.get(row["speaker"])
            other_reference = references.get(neighbour["speaker"])
            if own_reference is None or other_reference is None:
                findings.append({"id": row["id"], "side": side, "pass": True,
                                 "skipped": "missing speaker reference"})
                continue
            separation = distance(own_reference, other_reference)
            if separation < MIN_REFERENCE_DISTANCE:
                findings.append({"id": row["id"], "side": side, "pass": True,
                                 "skipped": "speakers share one approved voice",
                                 "referenceDistance": round(separation, 4)})
                continue
            if side == "head":
                from_seconds = row["speechStartSeconds"]
                to_seconds = min(row["speechStartSeconds"] + HEAD_SECONDS, row["speechEndSeconds"])
            else:
                from_seconds = max(row["speechEndSeconds"] - TAIL_SECONDS, row["speechStartSeconds"])
                to_seconds = row["speechEndSeconds"]
            envelope, frames = voice_profile(samples, from_seconds, to_seconds)
            if envelope is None or frames < MIN_PROFILE_FRAMES:
                findings.append({"id": row["id"], "side": side, "pass": True,
                                 "skipped": "no sustained voiced frames in window"})
                continue
            own_distance = distance(envelope, own_reference)
            other_distance = distance(envelope, other_reference)
            findings.append({
                "id": row["id"],
                "side": side,
                "speaker": row["speaker"],
                "neighbourSpeaker": neighbour["speaker"],
                "ownDistance": round(own_distance, 4),
                "neighbourDistance": round(other_distance, 4),
                "referenceDistance": round(separation, 4),
                "voicedFrames": frames,
                "pass": not (other_distance < own_distance * LEAK_RATIO),
            })

    evaluated = [row for row in findings if "skipped" not in row]
    failures = [row for row in findings if not row["pass"]]
    result = {
        "version": "speaker-continuity-timbre-v1",
        "videoPath": str(Path(args.video).resolve()),
        "speakerReferenceDistances": {
            f"{left}|{right}": round(distance(references[left], references[right]), 4)
            for position, left in enumerate(sorted(references))
            for right in sorted(references)[position + 1:]
        },
        "thresholds": {
            "headSeconds": HEAD_SECONDS,
            "tailSeconds": TAIL_SECONDS,
            "minimumReferenceDistance": MIN_REFERENCE_DISTANCE,
            "leakRatio": LEAK_RATIO,
            "minimumProfileFrames": MIN_PROFILE_FRAMES,
        },
        "rows": findings,
        "evaluatedBoundaries": len(evaluated),
        "skippedBoundaries": len(findings) - len(evaluated),
        "pass": len(failures) == 0,
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=1))
    print(json.dumps({
        "pass": result["pass"],
        "evaluated": len(evaluated),
        "skipped": result["skippedBoundaries"],
        "failures": failures,
    }, ensure_ascii=False))
    if not result["pass"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
