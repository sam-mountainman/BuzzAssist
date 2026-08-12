#!/usr/bin/env python3
import argparse
import json
import subprocess
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from scipy import signal


SAMPLE_RATE = 48_000


def decode_mono(path: Path) -> np.ndarray:
    result = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path),
            "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "pipe:1",
        ],
        check=True,
        capture_output=True,
    )
    return np.frombuffer(result.stdout, dtype="<f4").astype(np.float64)


def sustained_onset(samples: np.ndarray) -> float:
    window = max(1, round(SAMPLE_RATE * 0.002))
    power = np.convolve(samples * samples, np.ones(window) / window, mode="same")
    rms = np.sqrt(power)
    threshold = max(0.0015, float(np.percentile(rms[: round(SAMPLE_RATE * 0.08)], 99.5)) * 2.5)
    sustained = max(1, round(SAMPLE_RATE * 0.012))
    active = rms >= threshold
    runs = np.convolve(active.astype(np.int16), np.ones(sustained, dtype=np.int16), mode="same")
    hits = np.flatnonzero(runs >= sustained)
    return float(hits[0] / SAMPLE_RATE) if hits.size else 0.0


def top_events(values: np.ndarray, *, minimum_distance_ms: float, count: int = 12):
    distance = max(1, round(SAMPLE_RATE * minimum_distance_ms / 1000))
    peaks, _ = signal.find_peaks(values, distance=distance)
    ranked = sorted(peaks, key=lambda index: float(values[index]), reverse=True)[:count]
    return [
        {"seconds": round(float(index / SAMPLE_RATE), 6), "value": round(float(values[index]), 9)}
        for index in ranked
    ]


def analyze(samples: np.ndarray, limit_seconds: float = 0.45):
    samples = samples[: round(SAMPLE_RATE * limit_seconds)]
    difference = np.abs(np.diff(samples, prepend=samples[0]))
    highpassed = signal.sosfilt(
        signal.butter(4, 4_000, btype="highpass", fs=SAMPLE_RATE, output="sos"),
        samples,
    )
    highpassed_envelope = np.sqrt(
        np.convolve(highpassed * highpassed, np.ones(96) / 96, mode="same")
    )
    onset_seconds = sustained_onset(samples)
    onset_index = round(onset_seconds * SAMPLE_RATE)
    before = samples[:onset_index] if onset_index else samples[: round(0.12 * SAMPLE_RATE)]
    return {
        "sampleCount": int(samples.size),
        "sustainedOnsetSeconds": round(onset_seconds, 6),
        "preOnsetPeak": round(float(np.max(np.abs(before))) if before.size else 0.0, 9),
        "preOnsetRms": round(float(np.sqrt(np.mean(before * before))) if before.size else 0.0, 9),
        "maximumStep": round(float(np.max(difference)), 9),
        "maximumStepSeconds": round(float(np.argmax(difference) / SAMPLE_RATE), 6),
        "topSampleSteps": top_events(difference, minimum_distance_ms=0.4),
        "topHighFrequencyBursts": top_events(highpassed_envelope, minimum_distance_ms=2.0),
    }


def best_alignment(reference: np.ndarray, candidate: np.ndarray):
    reference_start = round(0.22 * SAMPLE_RATE)
    template = reference[reference_start:round(1.22 * SAMPLE_RATE)]
    search = candidate[:round(2.2 * SAMPLE_RATE)]
    template = template - np.mean(template)
    search = search - np.mean(search)
    numerator = signal.correlate(search, template, mode="valid", method="fft")
    template_energy = float(np.sum(template * template))
    window_energy = np.convolve(search * search, np.ones(template.size), mode="valid")
    normalized = numerator / np.sqrt(np.maximum(window_energy * template_energy, 1e-18))
    index = int(np.argmax(normalized))
    candidate_window = search[index:index + template.size]
    gain = float(np.dot(template, candidate_window) / max(np.dot(candidate_window, candidate_window), 1e-18))
    return {
        "referenceWindowStartSeconds": reference_start / SAMPLE_RATE,
        "candidateWindowStartSeconds": round(index / SAMPLE_RATE, 6),
        "candidateMinusReferenceSeconds": round(index / SAMPLE_RATE - reference_start / SAMPLE_RATE, 6),
        "normalizedCorrelation": round(float(normalized[index]), 9),
        "gainCandidateToReference": round(gain, 9),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest-path", required=True)
    parser.add_argument("--video-path", required=True)
    parser.add_argument("--utterance-id", required=True)
    parser.add_argument("--candidate", action="append", default=[])
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    manifest_path = Path(args.manifest_path).resolve()
    manifest = json.loads(manifest_path.read_text())
    utterance = next(row for row in manifest["utterances"] if row["id"] == args.utterance_id)
    absolute_start = float(utterance["timing"]["audioStartSeconds"])
    ordered = sorted(manifest["utterances"], key=lambda row: float(row.get("timing", {}).get("audioStartSeconds", 0)))
    utterance_index = next(index for index, row in enumerate(ordered) if row["id"] == args.utterance_id)
    previous = ordered[utterance_index - 1] if utterance_index > 0 else None
    sources = [("current-wav", Path(utterance["audio"]["filePath"]).resolve())]
    for raw in args.candidate:
        label, separator, path = raw.partition("=")
        if not separator:
            raise ValueError("--candidate must use LABEL=/absolute/path")
        sources.append((label, Path(path).resolve()))

    video_samples = decode_mono(Path(args.video_path).resolve())
    start_index = round(absolute_start * SAMPLE_RATE)
    sources.append(("final-mp4-aac", Path(args.video_path).resolve()))
    decoded = {}
    for label, path in sources:
        if label == "final-mp4-aac":
            samples = video_samples[start_index:]
        else:
            samples = decode_mono(path)
        decoded[label] = samples

    previous_samples = decode_mono(Path(previous["audio"]["filePath"]).resolve()) if previous else np.empty(0)
    previous_tail = previous_samples[-round(0.3 * SAMPLE_RATE):] if previous_samples.size else np.empty(0)
    previous_tail_difference = np.abs(np.diff(previous_tail, prepend=previous_tail[0])) if previous_tail.size else np.empty(0)
    join_window_start = max(0, start_index - round(0.3 * SAMPLE_RATE))
    join_window = video_samples[join_window_start:start_index + round(0.4 * SAMPLE_RATE)]
    join_difference = np.abs(np.diff(join_window, prepend=join_window[0]))

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "version": "koya-click-region-analysis-v1",
        "utteranceId": args.utterance_id,
        "absoluteAudioStartSeconds": absolute_start,
        "sampleRate": SAMPLE_RATE,
        "previousUtterance": {
            "utteranceId": previous["id"] if previous else "",
            "audioPath": previous["audio"]["filePath"] if previous else "",
            "lastSample": round(float(previous_samples[-1]), 9) if previous_samples.size else 0.0,
            "last10msPeak": round(float(np.max(np.abs(previous_samples[-round(0.01 * SAMPLE_RATE):]))), 9) if previous_samples.size else 0.0,
            "last50msRms": round(float(np.sqrt(np.mean(previous_samples[-round(0.05 * SAMPLE_RATE):] ** 2))), 9) if previous_samples.size else 0.0,
            "directPcmJoinStepToCurrentWav": round(float(abs(decoded["current-wav"][0] - previous_samples[-1])), 9) if previous_samples.size else 0.0,
            "topTailSampleSteps": [
                {
                    "secondsFromFileStart": round((previous_samples.size - previous_tail.size) / SAMPLE_RATE + row["seconds"], 6),
                    "millisecondsBeforeFileEnd": round(((previous_tail.size / SAMPLE_RATE) - row["seconds"]) * 1000, 3),
                    "value": row["value"],
                }
                for row in top_events(previous_tail_difference, minimum_distance_ms=0.4, count=20)
            ] if previous_tail.size else [],
        },
        "finalMp4JoinWindow": {
            "windowStartSeconds": round(join_window_start / SAMPLE_RATE, 6),
            "topSampleSteps": [
                {
                    "absoluteSeconds": round(join_window_start / SAMPLE_RATE + row["seconds"], 6),
                    "relativeToUtteranceStartSeconds": round(join_window_start / SAMPLE_RATE + row["seconds"] - absolute_start, 6),
                    "value": row["value"],
                }
                for row in top_events(join_difference, minimum_distance_ms=0.4, count=20)
            ],
        },
        "sources": {label: analyze(samples) for label, samples in decoded.items()},
        "alignmentsToCurrentWav": {
            label: best_alignment(decoded["current-wav"], samples)
            for label, samples in decoded.items()
            if label != "current-wav"
        },
    }

    figure, axes = plt.subplots(len(decoded), 2, figsize=(15, max(3, 2.8 * len(decoded))), squeeze=False)
    for row, (label, samples) in enumerate(decoded.items()):
        visible = samples[: round(SAMPLE_RATE * 0.35)]
        times_ms = np.arange(visible.size) / SAMPLE_RATE * 1000
        axes[row, 0].plot(times_ms, visible, linewidth=0.65)
        axes[row, 0].axvline(report["sources"][label]["sustainedOnsetSeconds"] * 1000, color="red", linewidth=0.8)
        axes[row, 0].set(xlim=(0, 350), ylabel=label, title="waveform")
        axes[row, 0].grid(alpha=0.2)
        frequencies, times, spectrum = signal.spectrogram(visible, fs=SAMPLE_RATE, nperseg=512, noverlap=480)
        axes[row, 1].pcolormesh(times * 1000, frequencies, 10 * np.log10(np.maximum(spectrum, 1e-14)), shading="auto", cmap="magma", vmin=-120, vmax=-25)
        axes[row, 1].set(xlim=(0, 350), ylim=(0, 20_000), title="spectrogram", ylabel="Hz")
    axes[-1, 0].set_xlabel("milliseconds from utterance WAV start")
    axes[-1, 1].set_xlabel("milliseconds from utterance WAV start")
    figure.tight_layout()
    plot_path = output_dir / "click-region-waveform-spectrogram.png"
    figure.savefig(plot_path, dpi=180)
    plt.close(figure)
    report["plotPath"] = str(plot_path)
    join_figure, join_axis = plt.subplots(figsize=(15, 4.5))
    join_times_ms = (np.arange(join_window.size) + join_window_start - start_index) / SAMPLE_RATE * 1000
    join_axis.plot(join_times_ms, join_window, linewidth=0.65)
    join_axis.axvline(0, color="black", linewidth=1, label="u02 WAV start")
    join_axis.axvline(report["sources"]["final-mp4-aac"]["sustainedOnsetSeconds"] * 1000, color="red", linewidth=1, label="measured u02 onset")
    join_axis.set(xlim=(-300, 400), title="final MP4 decoded PCM around u01 → u02 join", xlabel="milliseconds relative to u02 WAV start")
    join_axis.grid(alpha=0.2)
    join_axis.legend()
    join_figure.tight_layout()
    join_plot_path = output_dir / "final-mp4-join-waveform.png"
    join_figure.savefig(join_plot_path, dpi=180)
    plt.close(join_figure)
    report["joinPlotPath"] = str(join_plot_path)
    if previous_tail.size:
        tail_figure, tail_axes = plt.subplots(2, 1, figsize=(15, 7), sharex=True)
        tail_times_ms = (np.arange(previous_tail.size) - previous_tail.size) / SAMPLE_RATE * 1000
        tail_axes[0].plot(tail_times_ms, previous_tail, linewidth=0.65)
        tail_axes[0].set(title=f"{previous['id']} final 300 ms", ylabel="amplitude")
        frequencies, times, spectrum = signal.spectrogram(previous_tail, fs=SAMPLE_RATE, nperseg=512, noverlap=480)
        tail_axes[1].pcolormesh(times * 1000 - 300, frequencies, 10 * np.log10(np.maximum(spectrum, 1e-14)), shading="auto", cmap="magma", vmin=-120, vmax=-25)
        tail_axes[1].set(xlim=(-300, 0), ylim=(0, 20_000), xlabel="milliseconds before previous WAV end", ylabel="Hz")
        tail_figure.tight_layout()
        tail_plot_path = output_dir / "previous-utterance-tail.png"
        tail_figure.savefig(tail_plot_path, dpi=180)
        plt.close(tail_figure)
        report["previousTailPlotPath"] = str(tail_plot_path)
    report_path = output_dir / "click-region-analysis.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
