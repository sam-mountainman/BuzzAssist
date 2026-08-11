#!/usr/bin/env python3
"""Objective final-master checks for hum, clicks, silence, and level.

This script is analysis-only. It decodes the AAC master to float PCM in memory
and never alters the ElevenLabs voices or the rendered video.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
from pathlib import Path

import numpy as np
from scipy.signal import welch


def dbfs(value: float) -> float:
    return 20.0 * math.log10(max(value, 1e-12))


parser = argparse.ArgumentParser()
parser.add_argument("video")
parser.add_argument("--output", required=True)
parser.add_argument("--version", default="v22-final-audio-objective-audit")
args = parser.parse_args()

video_path = Path(args.video).resolve()
output_path = Path(args.output).resolve()
pcm = subprocess.run(
    [
        "ffmpeg", "-v", "error", "-i", str(video_path), "-map", "0:a:0",
        "-af", "pan=mono|c0=c0", "-ac", "1", "-ar", "48000", "-f", "f32le", "-",
    ],
    check=True,
    stdout=subprocess.PIPE,
).stdout
audio = np.frombuffer(pcm, dtype="<f4").astype(np.float64)
sample_rate = 48_000

frame_samples = int(0.100 * sample_rate)
usable = audio[: len(audio) // frame_samples * frame_samples]
frames = usable.reshape(-1, frame_samples)
frame_rms = np.sqrt(np.mean(frames * frames, axis=1) + 1e-24)
quiet_frames = frames[(20 * np.log10(frame_rms + 1e-24) < -38.0) & (frame_rms > 1e-10)]

if len(quiet_frames):
    quiet_audio = quiet_frames.reshape(-1)
    frequencies, power = welch(
        quiet_audio,
        fs=sample_rate,
        nperseg=min(16384, len(quiet_audio)),
        noverlap=min(8192, max(0, len(quiet_audio) // 2)),
        scaling="spectrum",
    )
else:
    frequencies = np.array([0.0])
    power = np.array([0.0])


def tone_measure(frequency: float) -> dict[str, float]:
    line = (frequencies >= frequency - 1.5) & (frequencies <= frequency + 1.5)
    local = (
        (frequencies >= frequency - 18.0)
        & (frequencies <= frequency + 18.0)
        & ~((frequencies >= frequency - 4.0) & (frequencies <= frequency + 4.0))
    )
    line_power = float(np.max(power[line])) if np.any(line) else 0.0
    local_power = float(np.median(power[local])) if np.any(local) else 0.0
    return {
        "frequencyHz": frequency,
        "levelDbfs": 10.0 * math.log10(max(line_power, 1e-24)),
        "prominenceDb": 10.0 * math.log10(max(line_power, 1e-24) / max(local_power, 1e-24)),
    }


tones = [tone_measure(value) for value in (50.0, 60.0, 100.0, 120.0, 150.0, 180.0)]
audible_hum = [tone for tone in tones if tone["levelDbfs"] > -55.0 and tone["prominenceDb"] > 10.0]
# A raw derivative threshold mistakes strong consonants for clicks. Flag only
# isolated impulses whose 1 ms neighbourhood is otherwise quiet.
click_candidates = []
half_window = 24
for index in np.flatnonzero(np.abs(audio) > 0.22):
    if index < half_window or index + half_window >= len(audio):
        continue
    neighbourhood = np.concatenate((
        np.abs(audio[index - half_window:index - 2]),
        np.abs(audio[index + 3:index + half_window]),
    ))
    if float(np.percentile(neighbourhood, 90)) < 0.025:
        click_candidates.append(int(index))
sample_deltas = np.abs(np.diff(audio))
report = {
    "version": args.version,
    "videoPath": str(video_path),
    "sampleRate": sample_rate,
    "durationSeconds": len(audio) / sample_rate,
    "peakDbfs": dbfs(float(np.max(np.abs(audio)))),
    "quietFrameCount": int(len(quiet_frames)),
    "quietFrameFraction": float(len(quiet_frames) / max(1, len(frames))),
    "quietRms95Dbfs": dbfs(float(np.percentile(frame_rms[frame_rms < 10 ** (-38 / 20)], 95)))
    if np.any(frame_rms < 10 ** (-38 / 20))
    else -240.0,
    "mainsToneMeasurements": tones,
    "audibleHumCandidates": audible_hum,
    "maximumSampleDelta": float(np.max(sample_deltas)) if len(sample_deltas) else 0.0,
    "isolatedClickCandidateCount": len(click_candidates),
    "isolatedClickCandidateTimesSeconds": [value / sample_rate for value in click_candidates[:20]],
    "pass": len(audible_hum) == 0 and len(click_candidates) == 0,
}
output_path.parent.mkdir(parents=True, exist_ok=True)
output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(report, ensure_ascii=False, indent=2))
