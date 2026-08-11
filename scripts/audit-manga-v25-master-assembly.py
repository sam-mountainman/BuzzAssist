#!/usr/bin/env python3
"""Verify that every mastered ElevenLabs line survives final AAC assembly intact.

Analysis only: decodes the final master and source WAV assets, then measures
alignment and correlation, including a dedicated probe at each speech onset.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

import numpy as np
from scipy.signal import correlate


SAMPLE_RATE = 48_000
SEARCH_PADDING_SECONDS = 0.50


def decode_mono(path: Path) -> np.ndarray:
    pcm = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0",
            "-af", "pan=mono|c0=c0", "-ac", "1", "-ar", str(SAMPLE_RATE),
            "-f", "f32le", "-",
        ],
        check=True,
        stdout=subprocess.PIPE,
    ).stdout
    return np.frombuffer(pcm, dtype="<f4").astype(np.float64)


def normalized_similarity(left: np.ndarray, right: np.ndarray) -> float:
    length = min(len(left), len(right))
    if length == 0:
        return 0.0
    left = left[:length]
    right = right[:length]
    denominator = float(np.linalg.norm(left) * np.linalg.norm(right))
    return float(np.dot(left, right) / denominator) if denominator > 1e-12 else 0.0


def speech_onset(audio: np.ndarray) -> int:
    window = int(0.005 * SAMPLE_RATE)
    frame_count = len(audio) // window
    if frame_count == 0:
        return 0
    frames = audio[: frame_count * window].reshape(-1, window)
    rms = np.sqrt(np.mean(frames * frames, axis=1) + 1e-24)
    peak = np.max(np.abs(frames), axis=1)
    active = (rms >= 0.001) | (peak >= 0.008)
    for index in range(max(0, len(active) - 2)):
        if bool(np.all(active[index:index + 3])):
            return index * window
    active_indexes = np.flatnonzero(active)
    return int(active_indexes[0] * window) if len(active_indexes) else 0


parser = argparse.ArgumentParser()
parser.add_argument("--video", required=True)
parser.add_argument("--manifest", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()

video_path = Path(args.video).resolve()
manifest_path = Path(args.manifest).resolve()
output_path = Path(args.output).resolve()
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
master = decode_mono(video_path)
padding = int(SEARCH_PADDING_SECONDS * SAMPLE_RATE)
results = []

for utterance in manifest["utterances"]:
    source_path = Path(utterance["audio"]["filePath"]).resolve()
    source = decode_mono(source_path)
    expected_start = float(utterance["timing"]["audioStartSeconds"])
    expected_sample = int(round(expected_start * SAMPLE_RATE))
    segment_start = max(0, expected_sample - padding)
    segment_end = min(len(master), expected_sample + len(source) + padding)
    segment = master[segment_start:segment_end]
    if len(segment) < len(source):
        raise RuntimeError(f"Master segment too short for {utterance['id']}")

    scores = correlate(segment, source, mode="valid", method="fft")
    best_offset = int(np.argmax(scores))
    matched = segment[best_offset:best_offset + len(source)]
    actual_start_sample = segment_start + best_offset
    lag_seconds = (actual_start_sample - expected_sample) / SAMPLE_RATE
    overall_similarity = normalized_similarity(source, matched)

    onset = speech_onset(source)
    probe_length = min(int(0.22 * SAMPLE_RATE), len(source) - onset)
    source_head = source[onset:onset + probe_length]
    master_head = matched[onset:onset + probe_length]
    head_similarity = normalized_similarity(source_head, master_head)
    source_head_rms = float(np.sqrt(np.mean(source_head * source_head) + 1e-24))
    master_head_rms = float(np.sqrt(np.mean(master_head * master_head) + 1e-24))
    head_rms_ratio = master_head_rms / max(source_head_rms, 1e-12)

    passed = overall_similarity >= 0.97 and head_similarity >= 0.90
    results.append({
        "utteranceId": utterance["id"],
        "cutId": utterance["cutId"],
        "expectedStartSeconds": expected_start,
        "matchedStartSeconds": actual_start_sample / SAMPLE_RATE,
        "lagSeconds": lag_seconds,
        "sourceSpeechOnsetSeconds": onset / SAMPLE_RATE,
        "overallSimilarity": overall_similarity,
        "speechOnsetSimilarity": head_similarity,
        "speechOnsetRmsRatio": head_rms_ratio,
        "sourceSpeechEndSeconds": float(utterance["audio"]["speechEndSeconds"]),
        "targetAudibleGapBeforeSeconds": float(
            utterance["audio"].get("targetAudibleGapBeforeSeconds", 0)
        ),
        "pass": passed,
    })

cut_lag_residuals = []
audible_gaps = []
for cut in manifest["cuts"]:
    cut_results = [result for result in results if result["cutId"] == cut["id"]]
    if not cut_results:
        continue
    median_lag = float(np.median([result["lagSeconds"] for result in cut_results]))
    for result in cut_results:
        residual = result["lagSeconds"] - median_lag
        result["cutMedianLagSeconds"] = median_lag
        result["cutLagResidualSeconds"] = residual
        cut_lag_residuals.append(abs(residual))
    for previous, current in zip(cut_results, cut_results[1:]):
        previous_end = (
            previous["matchedStartSeconds"] + previous["sourceSpeechEndSeconds"]
        )
        current_start = (
            current["matchedStartSeconds"] + current["sourceSpeechOnsetSeconds"]
        )
        actual_gap = current_start - previous_end
        target_gap = current["targetAudibleGapBeforeSeconds"]
        audible_gaps.append({
            "previousUtteranceId": previous["utteranceId"],
            "utteranceId": current["utteranceId"],
            "actualGapSeconds": actual_gap,
            "targetGapSeconds": target_gap,
            "absoluteDeltaSeconds": abs(actual_gap - target_gap),
            "pass": abs(actual_gap - target_gap) <= 0.04,
        })

gain_ratios = [result["speechOnsetRmsRatio"] for result in results]
gain_spread_ratio = max(gain_ratios) / max(min(gain_ratios), 1e-12)
waveform_pass = all(result["pass"] for result in results)
timing_pass = max(cut_lag_residuals, default=0) <= 0.005
gain_pass = gain_spread_ratio <= 1.12
gap_pass = all(gap["pass"] for gap in audible_gaps)
report = {
    "version": "v25-master-assembly-audit",
    "videoPath": str(video_path),
    "manifestPath": str(manifest_path),
    "sampleRate": SAMPLE_RATE,
    "utteranceCount": len(results),
    "passedCount": sum(1 for result in results if result["pass"]),
    "maximumAbsoluteLagSeconds": max(abs(result["lagSeconds"]) for result in results),
    "maximumWithinCutLagResidualSeconds": max(cut_lag_residuals, default=0),
    "minimumOverallSimilarity": min(result["overallSimilarity"] for result in results),
    "minimumSpeechOnsetSimilarity": min(result["speechOnsetSimilarity"] for result in results),
    "minimumSpeechOnsetRmsRatio": min(result["speechOnsetRmsRatio"] for result in results),
    "maximumSpeechOnsetRmsRatio": max(result["speechOnsetRmsRatio"] for result in results),
    "speechOnsetGainSpreadRatio": gain_spread_ratio,
    "audibleGaps": audible_gaps,
    "gates": {
        "waveformIntegrity": waveform_pass,
        "withinCutTiming": timing_pass,
        "consistentGain": gain_pass,
        "audibleGaps": gap_pass,
    },
    "results": results,
    "pass": waveform_pass and timing_pass and gain_pass and gap_pass,
}
output_path.parent.mkdir(parents=True, exist_ok=True)
output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(report, ensure_ascii=False, indent=2))
raise SystemExit(0 if report["pass"] else 2)
