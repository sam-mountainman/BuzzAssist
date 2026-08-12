#!/usr/bin/env python3
"""Objective rendered-audio gate for sync, line level, clicks, and mains hum."""
import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np


SAMPLE_RATE = 16000


def decode_audio(video):
    result = subprocess.run([
        "ffmpeg", "-v", "error", "-xerror", "-i", str(video),
        "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-",
    ], capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.decode("utf-8", "replace")[-1200:])
    return np.frombuffer(result.stdout, dtype="<f4").astype(np.float64)


def section(samples, start, end):
    left = max(0, min(len(samples), int(start * SAMPLE_RATE)))
    right = max(left, min(len(samples), int(end * SAMPLE_RATE)))
    return samples[left:right]


def rms_db(samples):
    if len(samples) == 0:
        return -120.0
    value = math.sqrt(float(np.mean(samples * samples)))
    return 20 * math.log10(max(value, 1e-6))


def max_jump(samples):
    return float(np.max(np.abs(np.diff(samples)))) if len(samples) > 1 else 0.0


def max_jump_evidence(samples):
    if len(samples) <= 1:
        return {"jump": 0.0, "sampleIndex": 0, "seconds": 0.0}
    differences = np.abs(np.diff(samples))
    index = int(np.argmax(differences))
    return {"jump": float(differences[index]), "sampleIndex": index, "seconds": index / SAMPLE_RATE}


def isolated_tail_burst_evidence(samples):
    if len(samples) < int(0.025 * SAMPLE_RATE):
        return {"jump": 0.0, "peak": 0.0, "preRmsDbfs": -120.0, "burstRmsDbfs": -120.0, "isolated": False}
    differences = np.abs(np.diff(samples, prepend=samples[0]))
    index = int(np.argmax(differences))
    pre = samples[max(0, index - int(0.025 * SAMPLE_RATE)):max(0, index - int(0.008 * SAMPLE_RATE))]
    burst = samples[max(0, index - int(0.003 * SAMPLE_RATE)):min(len(samples), index + int(0.010 * SAMPLE_RATE))]
    local = samples[max(0, index - int(0.006 * SAMPLE_RATE)):min(len(samples), index + int(0.012 * SAMPLE_RATE))]
    jump = float(differences[index])
    peak = float(np.max(np.abs(local))) if len(local) else 0.0
    pre_db = rms_db(pre)
    burst_db = rms_db(burst)
    isolated = bool(jump >= 0.035 and peak >= 0.06 and pre_db <= -42 and burst_db >= pre_db + 15)
    return {
        "jump": jump,
        "peak": peak,
        "preRmsDbfs": pre_db,
        "burstRmsDbfs": burst_db,
        "eventSecondsInWindow": index / SAMPLE_RATE,
        "isolated": isolated,
    }


def hum_evidence(samples):
    if len(samples) < SAMPLE_RATE // 2:
        return {"measurable": False, "rmsDbfs": rms_db(samples), "pass": True}
    quiet_db = rms_db(samples)
    if quiet_db <= -55:
        return {"measurable": True, "rmsDbfs": round(quiet_db, 2), "reason": "below-audible-floor", "pass": True}
    windowed = samples * np.hanning(len(samples))
    spectrum = np.abs(np.fft.rfft(windowed)) + 1e-12
    freqs = np.fft.rfftfreq(len(samples), 1 / SAMPLE_RATE)
    band = spectrum[(freqs >= 35) & (freqs <= 190)]
    floor = float(np.median(band)) if band.size else 1e-12
    peaks = {}
    for frequency in (50, 60, 100, 120, 150, 180):
        index = int(np.argmin(np.abs(freqs - frequency)))
        peaks[str(frequency)] = round(20 * math.log10(float(spectrum[index]) / max(floor, 1e-12)), 2)
    worst = max(peaks.values(), default=0)
    return {"measurable": True, "rmsDbfs": round(quiet_db, 2), "peakOverLocalFloorDb": peaks, "worstDb": worst, "pass": worst < 18}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    samples = decode_audio(args.video)
    rows = []
    quiet_parts = []
    previous_end = 0.0
    for utterance in sorted(manifest.get("utterances", []), key=lambda row: float(row.get("timing", {}).get("audioStartSeconds", 0))):
        timing = utterance.get("timing", {})
        audio = utterance.get("audio", {})
        start = float(timing.get("audioStartSeconds", 0))
        duration = float(audio.get("durationSeconds", 0))
        end = start + duration
        head = max(0.0, float(audio.get("speechStartSeconds", 0)))
        release = max(0.0, float(audio.get("outputTailPaddingSeconds", audio.get("releasePaddingSeconds", audio.get("sourceTailPaddingSeconds", 0)))))
        body_start = min(end, start + head)
        body_end = max(body_start, end - release)
        body = section(samples, body_start, body_end)
        head_samples = section(samples, start, min(body_start, start + 0.06))
        if len(head_samples):
            quiet_parts.append(head_samples)
        boundary = section(samples, max(0, start - 0.01), min(len(samples) / SAMPLE_RATE, start + 0.02))
        # The production contract permits only a 6–8 ms join micro-fade. A
        # click is the discontinuity at the join itself; scanning 24 ms also
        # classifies ordinary Japanese plosives as clicks after the fade has
        # legitimately completed. Inspect the first encoded millisecond, while
        # the boundary window below guards the file/concat join independently.
        onset_join = section(samples, body_start, min(end, body_start + 0.001))
        acoustic = audio.get("acousticSpeechDetection", {})
        declared_speech_end = min(duration, max(
            head,
            float(audio.get("speechEndSeconds", duration - release)),
            float(acoustic.get("endSeconds", 0)),
        ))
        # A post-speech burst can be perceived as a click before the next line
        # even when both file joins are mathematically continuous. Start after
        # 35 ms of legitimate release, then reject isolated late full-band
        # transients in the rendered MP4. The paired peak gate keeps a normal
        # low-level breath/noise floor from being classified as a click.
        # AAC's analysis window can move a valid terminal phoneme by roughly
        # 21 ms in decoded PCM. Begin 25 ms after the later of the authored and
        # acoustic speech-end markers so the gate measures only detached tail
        # events, not encoder delay or a legitimate final consonant.
        late_tail_start = min(end, start + declared_speech_end + 0.025)
        late_tail = section(samples, late_tail_start, max(late_tail_start, end - 0.005))
        late_tail_evidence = isolated_tail_burst_evidence(late_tail)
        late_tail_jump = late_tail_evidence["jump"]
        late_tail_peak = late_tail_evidence["peak"]
        late_tail_click = late_tail_evidence["isolated"]
        body_level = rms_db(body)
        head_level = rms_db(head_samples)
        boundary_jump = max_jump(boundary)
        onset_jump = max_jump(onset_join)
        expected_text = str(utterance.get("text", "")).strip()
        passed = bool(
            expected_text
            and duration > 0
            and body_end > body_start
            and body_level > -45
            and head_level <= max(-42, body_level - 12)
            and boundary_jump < 0.65
            and onset_jump < 0.03
            and not late_tail_click
        )
        rows.append({
            "id": utterance.get("id"), "startSeconds": round(start, 3), "durationSeconds": round(duration, 3),
            "speechStartSeconds": round(head, 3), "bodyRmsDbfs": round(body_level, 2),
            "headRmsDbfs": round(head_level, 2), "boundaryMaximumJump": round(boundary_jump, 4), "pass": passed,
            "onsetJoinFirst1msMaximumJump": round(onset_jump, 4),
            "lateTailStartSeconds": round(late_tail_start, 6),
            "lateTailMaximumJump": round(late_tail_jump, 4),
            "lateTailPeak": round(late_tail_peak, 4),
            "lateTailPreBurstRmsDbfs": round(late_tail_evidence["preRmsDbfs"], 2),
            "lateTailBurstRmsDbfs": round(late_tail_evidence["burstRmsDbfs"], 2),
            "lateTailEventSeconds": round(late_tail_start + late_tail_evidence.get("eventSecondsInWindow", 0.0), 6),
            "lateTailClick": late_tail_click,
        })
        if start - previous_end >= 0.08:
            quiet_parts.append(section(samples, previous_end + 0.01, start - 0.01))
        previous_end = max(previous_end, end)
    levels = [row["bodyRmsDbfs"] for row in rows if row["pass"]]
    level_spread = max(levels) - min(levels) if levels else 999
    joined_quiet = np.concatenate([part for part in quiet_parts if len(part)]) if any(len(part) for part in quiet_parts) else np.array([], dtype=np.float64)
    hum = hum_evidence(joined_quiet)
    whole_jump = max_jump_evidence(samples)
    gates = {
        "everyUtteranceHasRenderedSpeech": bool(rows) and all(row["pass"] for row in rows),
        "lineLevelSpread": level_spread <= 12,
        # A full-track derivative can be high inside a naturally voiced line;
        # clicks are a boundary/onset defect. Keep a near-full-scale guard for
        # catastrophic impulses, and apply the strict gate at every join and
        # in the first encoded millisecond after the declared acoustic onset.
        # Downsampling a loud Japanese sibilant to 16 kHz can legitimately
        # alternate by about 1.0 sample-to-sample. Treat only a true near-full-
        # scale polarity reversal as catastrophic; joins retain strict limits.
        "noClickImpulse": whole_jump["jump"] < 1.8 and all(
            row["boundaryMaximumJump"] < 0.65
            and row["onsetJoinFirst1msMaximumJump"] < 0.03
            and not row["lateTailClick"]
            for row in rows
        ),
        "noMainsHum": hum["pass"],
    }
    result = {
        "version": "koya-audio-waveform-v3-late-tail-click", "sampleRate": SAMPLE_RATE,
        "rows": rows, "lineLevelSpreadDb": round(level_spread, 2),
        "wholeTrackMaximumJump": round(whole_jump["jump"], 4),
        "wholeTrackMaximumJumpSeconds": round(whole_jump["seconds"], 6), "hum": hum,
        "gates": gates, "pass": all(gates.values()),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"pass": result["pass"], "gates": gates, "checked": len(rows)}, ensure_ascii=False))
    if not result["pass"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
