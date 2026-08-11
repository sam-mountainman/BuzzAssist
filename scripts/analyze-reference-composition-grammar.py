#!/usr/bin/env python3
"""Measure full-length composition changes in the two locked reference videos.

This deliberately measures image layout rather than trying to infer story semantics
from pixels. The JSON combines those deterministic measurements with an explicitly
labelled, human-reviewed camera grammar derived from viewing the reference contact
sheets and representative change frames.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


GRID_ROWS = 4
GRID_COLS = 6


@dataclass
class Sample:
    source: str
    time_seconds: float
    frame: np.ndarray
    signature: np.ndarray
    mass_col: int
    mass_row: int
    bubble_fraction: float
    edge_density: float


def composition_signature(frame: np.ndarray) -> tuple[np.ndarray, int, int, float, float]:
    small = cv2.resize(frame, (240, 135), interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    # Speech bubbles are bright, nearly un-saturated islands. Excluding them keeps
    # the metric focused on character/prop/environment placement.
    bubble = ((hsv[:, :, 1] < 42) & (hsv[:, :, 2] > 218)).astype(np.uint8)
    bubble = cv2.morphologyEx(bubble, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    valid = 1.0 - bubble.astype(np.float32)
    edges = cv2.Canny(gray, 55, 135).astype(np.float32) / 255.0
    ink = np.clip((155.0 - gray.astype(np.float32)) / 155.0, 0.0, 1.0)
    feature = (edges * 0.62 + ink * 0.38) * valid
    blocks = []
    mass = np.zeros((GRID_ROWS, GRID_COLS), dtype=np.float32)
    height, width = feature.shape
    for row in range(GRID_ROWS):
        for col in range(GRID_COLS):
            y0, y1 = round(row * height / GRID_ROWS), round((row + 1) * height / GRID_ROWS)
            x0, x1 = round(col * width / GRID_COLS), round((col + 1) * width / GRID_COLS)
            block = feature[y0:y1, x0:x1]
            value = float(block.mean())
            mass[row, col] = value
            blocks.append(value)
    vector = np.asarray(blocks, dtype=np.float32)
    norm = float(np.linalg.norm(vector))
    if norm > 1e-7:
        vector /= norm
    max_row, max_col = np.unravel_index(int(np.argmax(mass)), mass.shape)
    return vector, int(max_col), int(max_row), float(bubble.mean()), float(edges.mean())


def cosine_distance(left: np.ndarray, right: np.ndarray) -> float:
    return float(1.0 - np.clip(np.dot(left, right), -1.0, 1.0))


def sample_video(path: Path, interval_seconds: float) -> list[Sample]:
    width, height = 640, 360
    sampling_fps = 1.0 / interval_seconds
    process = subprocess.Popen([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path),
        "-vf", f"fps={sampling_fps:.8f},scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1",
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    samples: list[Sample] = []
    frame_bytes = width * height * 3
    index = 0
    while True:
        payload = process.stdout.read(frame_bytes) if process.stdout else b""
        if len(payload) != frame_bytes:
            break
        frame = np.frombuffer(payload, dtype=np.uint8).reshape((height, width, 3)).copy()
        time_seconds = index * interval_seconds
        signature, mass_col, mass_row, bubble_fraction, edge_density = composition_signature(frame)
        samples.append(Sample(path.name, time_seconds, frame, signature, mass_col, mass_row, bubble_fraction, edge_density))
        index += 1
    return_code = process.wait()
    if return_code != 0:
        error = process.stderr.read().decode("utf-8", errors="replace") if process.stderr else ""
        raise RuntimeError(f"ffmpeg sampling failed for {path}: {error}")
    return samples


def detect_editorial_changes(samples: list[Sample], minimum_gap_seconds: float = 1.0) -> tuple[list[int], float, list[float]]:
    if len(samples) < 2:
        return [0] if samples else [], 0.0, []
    distances = [cosine_distance(samples[index - 1].signature, samples[index].signature) for index in range(1, len(samples))]
    threshold = max(0.055, float(np.quantile(distances, 0.78)))
    changes = [0]
    last_time = samples[0].time_seconds
    for index, distance in enumerate(distances, start=1):
        current = samples[index]
        lane_change = (current.mass_col != samples[index - 1].mass_col) or (current.mass_row != samples[index - 1].mass_row)
        if distance >= threshold and lane_change and current.time_seconds - last_time >= minimum_gap_seconds:
            changes.append(index)
            last_time = current.time_seconds
    return changes, threshold, distances


def lane_name(sample: Sample) -> str:
    horizontal = ["far-left", "left", "left-center", "right-center", "right", "far-right"][sample.mass_col]
    vertical = ["top", "upper-middle", "lower-middle", "bottom"][sample.mass_row]
    return f"{horizontal}/{vertical}"


def summarize_video(samples: list[Sample], changes: list[int], threshold: float, distances: list[float]) -> dict:
    sequence = [samples[index] for index in changes]
    transitions = []
    for index in range(1, len(sequence)):
        previous, current = sequence[index - 1], sequence[index]
        transitions.append({
            "fromSeconds": round(previous.time_seconds, 3),
            "toSeconds": round(current.time_seconds, 3),
            "fromMassLane": lane_name(previous),
            "toMassLane": lane_name(current),
            "massLaneChanged": lane_name(previous) != lane_name(current),
            "compositionDistance": round(cosine_distance(previous.signature, current.signature), 5),
        })
    repeat_count = sum(
        1 for index in range(1, len(sequence))
        if cosine_distance(sequence[index - 1].signature, sequence[index].signature) < 0.035
        and lane_name(sequence[index - 1]) == lane_name(sequence[index])
    )
    holds = [sequence[index].time_seconds - sequence[index - 1].time_seconds for index in range(1, len(sequence))]
    lane_counts: dict[str, int] = {}
    for sample in sequence:
        lane_counts[lane_name(sample)] = lane_counts.get(lane_name(sample), 0) + 1
    return {
        "source": samples[0].source if samples else "",
        "sampleCount": len(samples),
        "durationSeconds": round(samples[-1].time_seconds, 3) if samples else 0,
        "detectedEditorialChangeCount": len(changes),
        "changeThreshold": round(threshold, 5),
        "medianSampleToSampleCompositionDistance": round(float(np.median(distances)), 5) if distances else 0,
        "medianDetectedHoldSeconds": round(float(np.median(holds)), 3) if holds else None,
        "consecutiveNearRepeatCount": repeat_count,
        "consecutiveNearRepeatRate": round(repeat_count / max(1, len(sequence) - 1), 4),
        "massLaneCounts": dict(sorted(lane_counts.items(), key=lambda item: (-item[1], item[0]))),
        "transitions": transitions,
    }


def representative_indices(samples: list[Sample], changes: list[int], maximum: int) -> list[int]:
    if len(changes) <= maximum:
        return changes
    selected = [changes[0]]
    candidates = changes[1:]
    while candidates and len(selected) < maximum:
        best = max(
            candidates,
            key=lambda index: min(cosine_distance(samples[index].signature, samples[chosen].signature) for chosen in selected),
        )
        selected.append(best)
        candidates.remove(best)
    return sorted(selected)


def make_contact_sheet(samples: list[Sample], indices: list[int], output_path: Path, columns: int = 6) -> None:
    thumb_w, thumb_h, label_h = 320, 180, 28
    rows = math.ceil(len(indices) / columns)
    sheet = np.full((rows * (thumb_h + label_h), columns * thumb_w, 3), 245, dtype=np.uint8)
    for cell, index in enumerate(indices):
        sample = samples[index]
        thumb = cv2.resize(sample.frame, (thumb_w, thumb_h), interpolation=cv2.INTER_AREA)
        row, col = divmod(cell, columns)
        x, y = col * thumb_w, row * (thumb_h + label_h)
        sheet[y:y + thumb_h, x:x + thumb_w] = thumb
        label = f"{sample.source[:4]} {sample.time_seconds:07.1f}s {lane_name(sample)}"
        cv2.putText(sheet, label, (x + 6, y + thumb_h + 19), cv2.FONT_HERSHEY_SIMPLEX, 0.43, (20, 20, 20), 1, cv2.LINE_AA)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output_path), sheet)


def analyze_assets(asset_dir: Path) -> dict:
    paths = sorted(
        path for path in asset_dir.glob("manga-photo-homecoming-001-v*-cut-*.png")
        if re.search(r"-v(?:14|16)-cut-", path.name)
    )
    samples: list[Sample] = []
    for path in paths:
        frame = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if frame is None:
            continue
        signature, mass_col, mass_row, bubble_fraction, edge_density = composition_signature(frame)
        samples.append(Sample(path.name, float(len(samples)), frame, signature, mass_col, mass_row, bubble_fraction, edge_density))
    nearest = []
    for index, sample in enumerate(samples):
        others = [(cosine_distance(sample.signature, other.signature), other.source) for other_index, other in enumerate(samples) if other_index != index]
        if others:
            distance, name = min(others)
            nearest.append({"asset": sample.source, "nearest": name, "distance": round(distance, 5), "nearRepeat": distance < 0.025})
    lane_counts: dict[str, int] = {}
    for sample in samples:
        lane_counts[lane_name(sample)] = lane_counts.get(lane_name(sample), 0) + 1
    return {
        "assetCount": len(samples),
        "uniqueMassLaneCount": len(lane_counts),
        "massLaneCounts": dict(sorted(lane_counts.items(), key=lambda item: (-item[1], item[0]))),
        "nearRepeatPairCount": sum(1 for entry in nearest if entry["nearRepeat"]),
        "nearestComposition": nearest,
    }


HUMAN_REVIEWED_GRAMMAR = {
    "reviewBasis": "Full-video deterministic sampling plus visual review of supplied stills and early/middle/late reference contact sheets. Semantic labels below are human-reviewed; numeric transition statistics are automated.",
    "observedCameraFamilies": [
        "environmental establishing frames with characters small or absent",
        "single-character profile and three-quarter reaction close-ups",
        "speaker over-shoulder followed by listener reaction rather than repeated two-shots",
        "foreground-occluded depth staging with a face, shoulder, door, or object crossing the frame",
        "object and hand inserts for evidence, phones, photographs, food, and work actions",
        "high, overhead, counter-level, child-eye, and occasional low-angle viewpoints",
        "unequal two-panel and three-panel layouts that use independent source views",
        "wide-to-close scale changes at emotional or evidentiary turns",
    ],
    "sceneUseRules": [
        {"when": "location/time reset or narration", "use": "environment, prop, or empty-space establishing image; a speaking face is optional"},
        {"when": "arrival or intrusion", "use": "doorway depth, foreground witnesses, low or long-lens compression"},
        {"when": "recognition or private thought", "use": "listener reaction, profile, reflection, or foreground occlusion"},
        {"when": "confession or vulnerability", "use": "single profile/three-quarter close-up with averted eyeline and negative space"},
        {"when": "evidence or concrete action", "use": "hands/object insert, overhead work surface, or object-led counter-level view"},
        {"when": "power conflict", "use": "opposed profiles, triangular depth, asymmetric scale, or low dominant close-up"},
        {"when": "memory", "use": "child-eye/exterior/overhead compositions and distinct light; do not reuse present-day eye-level shop framing"},
        {"when": "resolution/intimacy", "use": "layered side two-shot or architecture-led wide before the close emotional reply"},
    ],
    "continuityRules": [
        "Preserve screen direction and shop geography, but change at least three of shot size, azimuth, elevation, arrangement, lens, and depth between adjacent beats.",
        "Do not repeat the same setup inside a six-beat rolling window unless the story intentionally returns to the exact same evidence or reaction.",
        "A dialogue exchange should include speaker view, listener reaction, and a concrete object/environment view; do not render every line as a centered eye-level two-shot.",
        "Reference images lock identity and place, not camera position or pose.",
    ],
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", action="append", required=True)
    parser.add_argument("--asset-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--interval", type=float, default=0.5)
    parser.add_argument("--representatives", type=int, default=72)
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    video_summaries = []
    all_samples: list[Sample] = []
    all_representatives: list[int] = []
    for video_value in args.video:
        samples = sample_video(Path(video_value).resolve(), args.interval)
        changes, threshold, distances = detect_editorial_changes(samples)
        video_summaries.append(summarize_video(samples, changes, threshold, distances))
        reps = representative_indices(samples, changes, max(12, args.representatives // len(args.video)))
        offset = len(all_samples)
        all_samples.extend(samples)
        all_representatives.extend(offset + index for index in reps)

    make_contact_sheet(all_samples, all_representatives, output_dir / "reference-composition-representatives-v31.jpg")
    report = {
        "schemaVersion": 1,
        "method": {
            "sampleIntervalSeconds": args.interval,
            "grid": f"{GRID_COLS}x{GRID_ROWS}",
            "bubbleExclusion": "bright low-saturation mask before edge/ink spatial signature",
            "changeDetection": "adaptive 78th-percentile cosine distance with spatial mass-lane change and one-second debounce",
            "limitations": "Numeric image-layout features do not name characters or understand story intent; semantic camera rules are explicitly human-reviewed below.",
        },
        "videos": video_summaries,
        "currentAssetBaseline": analyze_assets(Path(args.asset_dir).resolve()),
        "humanReviewedGrammar": HUMAN_REVIEWED_GRAMMAR,
        "artifacts": {"representativeContactSheet": "reference-composition-representatives-v31.jpg"},
    }
    output_path = output_dir / "reference-composition-grammar-v31.json"
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "outputPath": str(output_path),
        "contactSheet": str(output_dir / "reference-composition-representatives-v31.jpg"),
        "videos": [{"source": item["source"], "sampleCount": item["sampleCount"], "detectedChanges": item["detectedEditorialChangeCount"], "nearRepeatRate": item["consecutiveNearRepeatRate"]} for item in video_summaries],
        "currentAssetBaseline": {key: report["currentAssetBaseline"][key] for key in ["assetCount", "uniqueMassLaneCount", "nearRepeatPairCount"]},
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
