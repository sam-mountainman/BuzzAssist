#!/usr/bin/env python3
"""Measure full-length manga-video references from deterministic samples.

The report intentionally separates direct measurements from heuristic labels.
It never treats automatic bubble/panel candidates as human approval.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import statistics
import subprocess
from pathlib import Path

import cv2
import numpy as np


def percentile(values: list[float], value: float) -> float | None:
    if not values:
        return None
    return round(float(np.percentile(np.asarray(values, dtype=np.float64), value)), 4)


def distribution(values: list[float]) -> dict:
    if not values:
        return {"count": 0, "mean": None, "median": None, "p10": None, "p90": None}
    return {
        "count": len(values),
        "mean": round(statistics.fmean(values), 4),
        "median": round(statistics.median(values), 4),
        "p10": percentile(values, 10),
        "p90": percentile(values, 90),
    }


def timestamp(seconds: float) -> str:
    total = max(0, int(round(seconds)))
    return f"{total // 3600:02d}:{(total % 3600) // 60:02d}:{total % 60:02d}"


def find_runs(indices: np.ndarray) -> list[tuple[int, int]]:
    if indices.size == 0:
        return []
    splits = np.where(np.diff(indices) > 1)[0] + 1
    return [(int(group[0]), int(group[-1])) for group in np.split(indices, splits) if group.size]


def panel_separators(gray: np.ndarray) -> tuple[list[tuple[int, int]], list[tuple[int, int]]]:
    height, width = gray.shape
    dark = gray < 28
    vertical_ratio = dark.mean(axis=0)
    horizontal_ratio = dark.mean(axis=1)
    vertical = [
        run for run in find_runs(np.flatnonzero(vertical_ratio > 0.78))
        if 2 <= run[1] - run[0] + 1 <= max(4, int(width * 0.045))
        and run[0] > width * 0.08 and run[1] < width * 0.92
    ]
    horizontal = [
        run for run in find_runs(np.flatnonzero(horizontal_ratio > 0.78))
        if 2 <= run[1] - run[0] + 1 <= max(4, int(height * 0.06))
        and run[0] > height * 0.08 and run[1] < height * 0.92
    ]
    return vertical, horizontal


def bubble_candidates(frame: np.ndarray) -> list[dict]:
    height, width = frame.shape[:2]
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, np.array([0, 0, 224]), np.array([179, 58, 255]))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates = []
    frame_area = float(width * height)
    for contour in contours:
        area = cv2.contourArea(contour)
        x, y, candidate_width, candidate_height = cv2.boundingRect(contour)
        area_ratio = area / frame_area
        extent = area / max(1.0, candidate_width * candidate_height)
        if not 0.004 <= area_ratio <= 0.18:
            continue
        if not width * 0.045 <= candidate_width <= width * 0.42:
            continue
        if not height * 0.07 <= candidate_height <= height * 0.72:
            continue
        if extent < 0.48:
            continue
        candidates.append({
            "xRatio": round(x / width, 4),
            "yRatio": round(y / height, 4),
            "widthRatio": round(candidate_width / width, 4),
            "heightRatio": round(candidate_height / height, 4),
            "areaRatio": round(area_ratio, 4),
            "extent": round(extent, 4),
        })
    return sorted(candidates, key=lambda item: item["areaRatio"], reverse=True)[:5]


def motion_measure(first: np.ndarray, second: np.ndarray) -> dict:
    gray_a = cv2.cvtColor(first, cv2.COLOR_BGR2GRAY)
    gray_b = cv2.cvtColor(second, cv2.COLOR_BGR2GRAY)
    points = cv2.goodFeaturesToTrack(gray_a, maxCorners=350, qualityLevel=0.015, minDistance=9)
    if points is None or len(points) < 20:
        return {"valid": False, "reason": "insufficient-features"}
    tracked, status, _ = cv2.calcOpticalFlowPyrLK(gray_a, gray_b, points, None)
    if tracked is None or status is None:
        return {"valid": False, "reason": "optical-flow-failed"}
    source = points[status.reshape(-1) == 1].reshape(-1, 2)
    target = tracked[status.reshape(-1) == 1].reshape(-1, 2)
    if len(source) < 16:
        return {"valid": False, "reason": "insufficient-tracks"}
    matrix, inliers = cv2.estimateAffinePartial2D(
        source,
        target,
        method=cv2.RANSAC,
        ransacReprojThreshold=2.5,
        maxIters=2500,
        confidence=0.995,
    )
    if matrix is None or inliers is None:
        return {"valid": False, "reason": "affine-fit-failed"}
    inlier_ratio = float(inliers.mean())
    a, b, tx = matrix[0]
    _c, _d, ty = matrix[1]
    scale = math.sqrt(float(a * a + b * b))
    height, width = gray_a.shape
    zoom_percent = (scale - 1.0) * 100.0
    translation_percent = math.hypot(float(tx) / width, float(ty) / height) * 100.0
    valid = inlier_ratio >= 0.42 and abs(zoom_percent) <= 6 and translation_percent <= 12
    return {
        "valid": valid,
        "inlierRatio": round(inlier_ratio, 4),
        "zoomPercentPerSecond": round(zoom_percent, 4),
        "translationPercentPerSecond": round(translation_percent, 4),
        "translateXPercentPerSecond": round(float(tx) / width * 100.0, 4),
        "translateYPercentPerSecond": round(float(ty) / height * 100.0, 4),
        **({"reason": "probable-shot-change-or-local-motion"} if not valid else {}),
    }


def frame_measure(frame: np.ndarray) -> dict:
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    edges = cv2.Canny(gray, 70, 150)
    quantized = (frame // 32).reshape(-1, 3)
    colors = len(np.unique(quantized, axis=0))
    histogram = cv2.calcHist([gray], [0], None, [64], [0, 256]).reshape(-1)
    probabilities = histogram[histogram > 0] / histogram.sum()
    entropy = float(-(probabilities * np.log2(probabilities)).sum())
    vertical, horizontal = panel_separators(gray)
    bubbles = bubble_candidates(frame)
    return {
        "meanLuma": round(float(gray.mean()), 4),
        "lumaContrastStd": round(float(gray.std()), 4),
        "meanSaturation": round(float(hsv[:, :, 1].mean()), 4),
        "edgeDensity": round(float((edges > 0).mean()), 5),
        "quantizedColorCount": colors,
        "grayEntropyBits": round(entropy, 4),
        "bubbleCandidates": bubbles,
        "verticalPanelSeparators": vertical,
        "horizontalPanelSeparators": horizontal,
        "heuristicPanelCount": max(1, len(vertical) + 1, len(horizontal) + 1),
    }


def audio_measure(video_path: Path) -> dict:
    process = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-nostats", "-i", str(video_path),
            "-af", "ebur128=peak=true,silencedetect=noise=-38dB:d=0.08",
            "-map", "0:a:0", "-vn", "-f", "null", "-",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    silence_durations = [float(value) for value in re.findall(r"silence_duration:\s*(\d+(?:\.\d+)?)", process.stderr)]
    summary = process.stderr.split("Summary:")[-1]
    integrated = re.search(r"I:\s*(-inf|-?\d+(?:\.\d+)?)\s*LUFS", summary)
    loudness_range = re.search(r"LRA:\s*(-inf|-?\d+(?:\.\d+)?)\s*LU", summary)
    peak = re.search(r"Peak:\s*(-inf|-?\d+(?:\.\d+)?)\s*dBFS", summary)

    def parsed(match: re.Match | None) -> float | None:
        if not match or match.group(1) == "-inf":
            return None
        return float(match.group(1))

    return {
        "mixedTrackCaveat": "BGM masks some dialogue pauses; silence detection is a lower bound, not a voice-only pause profile.",
        "silenceThresholdDb": -38,
        "minimumSilenceSeconds": 0.08,
        "silenceDurationSeconds": distribution(silence_durations),
        "silenceBuckets": {
            "80To219ms": sum(0.08 <= value < 0.22 for value in silence_durations),
            "220To399ms": sum(0.22 <= value < 0.4 for value in silence_durations),
            "400To699ms": sum(0.4 <= value < 0.7 for value in silence_durations),
            "700msOrMore": sum(value >= 0.7 for value in silence_durations),
        },
        "integratedLufs": parsed(integrated),
        "loudnessRangeLu": parsed(loudness_range),
        "truePeakDbfs": parsed(peak),
    }


def metadata_for(video_path: Path, capture: cv2.VideoCapture) -> dict:
    info_path = video_path.with_suffix(".info.json")
    info = json.loads(info_path.read_text()) if info_path.exists() else {}
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = frame_count / fps if fps > 0 else float(info.get("duration") or 0)
    return {
        "id": info.get("id") or video_path.stem,
        "title": info.get("title") or video_path.stem,
        "channel": info.get("channel") or info.get("uploader"),
        "sourceUrl": info.get("webpage_url") or info.get("original_url"),
        "uploadDate": info.get("upload_date"),
        "videoPath": str(video_path.resolve()),
        "durationSeconds": round(duration, 4),
        "width": int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0),
        "height": int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0),
        "fps": round(fps, 6),
    }


def contact_sheet(frames: list[np.ndarray], labels: list[str], output_path: Path, columns: int = 5) -> None:
    thumb_width, thumb_height = 256, 144
    rows = math.ceil(len(frames) / columns)
    sheet = np.zeros((rows * thumb_height, columns * thumb_width, 3), dtype=np.uint8)
    for index, (frame, label) in enumerate(zip(frames, labels)):
        thumb = cv2.resize(frame, (thumb_width, thumb_height), interpolation=cv2.INTER_AREA)
        cv2.rectangle(thumb, (0, thumb_height - 25), (135, thumb_height), (0, 0, 0), -1)
        cv2.putText(thumb, label, (7, thumb_height - 7), cv2.FONT_HERSHEY_SIMPLEX, 0.48, (255, 255, 255), 1, cv2.LINE_AA)
        row, column = divmod(index, columns)
        sheet[row * thumb_height:(row + 1) * thumb_height, column * thumb_width:(column + 1) * thumb_width] = thumb
    cv2.imwrite(str(output_path), sheet, [cv2.IMWRITE_JPEG_QUALITY, 92])


def analyze_video(video_path: Path, output_dir: Path, sample_count: int) -> dict:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError(f"Could not open {video_path}")
    metadata = metadata_for(video_path, capture)
    duration = metadata["durationSeconds"]
    sample_dir = output_dir / "samples" / metadata["id"]
    sample_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    frames = []
    labels = []
    for index in range(sample_count):
        seconds = duration * (index + 0.5) / sample_count
        capture.set(cv2.CAP_PROP_POS_MSEC, seconds * 1000)
        ok, frame = capture.read()
        if not ok or frame is None:
            continue
        capture.set(cv2.CAP_PROP_POS_MSEC, min(duration - 0.05, seconds + 1.0) * 1000)
        motion_ok, motion_frame = capture.read()
        measured = frame_measure(frame)
        measured.update({
            "index": index + 1,
            "timestampSeconds": round(seconds, 3),
            "timestamp": timestamp(seconds),
            "motion": motion_measure(frame, motion_frame) if motion_ok and motion_frame is not None else {"valid": False, "reason": "second-frame-missing"},
        })
        frame_path = sample_dir / f"{index + 1:02d}-{int(round(seconds)):04d}.jpg"
        cv2.imwrite(str(frame_path), frame, [cv2.IMWRITE_JPEG_QUALITY, 91])
        measured["framePath"] = str(frame_path.resolve())
        rows.append(measured)
        frames.append(frame)
        labels.append(f"{index + 1:02d}  {timestamp(seconds)}")
    capture.release()
    contact_path = output_dir / f"{metadata['id']}-contact-{len(frames)}.jpg"
    contact_sheet(frames, labels, contact_path)
    valid_motion = [row["motion"] for row in rows if row["motion"].get("valid")]
    bubble_rows = [bubble for row in rows for bubble in row["bubbleCandidates"]]
    return {
        **metadata,
        "sampleCount": len(rows),
        "samplingMethod": "uniform midpoint samples across the full duration; motion compares each sample with +1.0 seconds",
        "contactSheetPath": str(contact_path.resolve()),
        "visual": {
            "meanLuma": distribution([row["meanLuma"] for row in rows]),
            "lumaContrastStd": distribution([row["lumaContrastStd"] for row in rows]),
            "meanSaturation": distribution([row["meanSaturation"] for row in rows]),
            "edgeDensity": distribution([row["edgeDensity"] for row in rows]),
            "quantizedColorCount": distribution([row["quantizedColorCount"] for row in rows]),
            "grayEntropyBits": distribution([row["grayEntropyBits"] for row in rows]),
        },
        "cameraMotion": {
            "validSampleCount": len(valid_motion),
            "zoomPercentPerSecond": distribution([abs(row["zoomPercentPerSecond"]) for row in valid_motion]),
            "translationPercentPerSecond": distribution([row["translationPercentPerSecond"] for row in valid_motion]),
            "movingSampleRatio": round(sum(
                abs(row["zoomPercentPerSecond"]) >= 0.08 or row["translationPercentPerSecond"] >= 0.08
                for row in valid_motion
            ) / max(1, len(valid_motion)), 4),
        },
        "bubbleHeuristic": {
            "caveat": "White-region geometry proposes review candidates; it is not OCR or human approval.",
            "samplesWithCandidateRatio": round(sum(bool(row["bubbleCandidates"]) for row in rows) / max(1, len(rows)), 4),
            "candidateCount": len(bubble_rows),
            "widthRatio": distribution([row["widthRatio"] for row in bubble_rows]),
            "heightRatio": distribution([row["heightRatio"] for row in bubble_rows]),
            "areaRatio": distribution([row["areaRatio"] for row in bubble_rows]),
        },
        "panelHeuristic": {
            "caveat": "Full-height/width dark gutters are detected; artistic borders require human review.",
            "onePanelSamples": sum(row["heuristicPanelCount"] == 1 for row in rows),
            "twoPanelSamples": sum(row["heuristicPanelCount"] == 2 for row in rows),
            "threeOrMorePanelSamples": sum(row["heuristicPanelCount"] >= 3 for row in rows),
        },
        "audio": audio_measure(video_path),
        "samples": rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("videos", nargs="+", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--sample-count", type=int, default=40)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    reports = [analyze_video(path.resolve(), args.output_dir.resolve(), max(5, args.sample_count)) for path in args.videos]
    all_samples = [sample for report in reports for sample in report["samples"]]
    valid_motion = [sample["motion"] for sample in all_samples if sample["motion"].get("valid")]
    aggregate = {
        "version": 1,
        "videoCount": len(reports),
        "sampleCount": len(all_samples),
        "sourceIds": [report["id"] for report in reports],
        "visual": {
            "meanLuma": distribution([row["meanLuma"] for row in all_samples]),
            "lumaContrastStd": distribution([row["lumaContrastStd"] for row in all_samples]),
            "meanSaturation": distribution([row["meanSaturation"] for row in all_samples]),
            "edgeDensity": distribution([row["edgeDensity"] for row in all_samples]),
            "quantizedColorCount": distribution([row["quantizedColorCount"] for row in all_samples]),
            "grayEntropyBits": distribution([row["grayEntropyBits"] for row in all_samples]),
        },
        "cameraMotion": {
            "validSampleCount": len(valid_motion),
            "zoomPercentPerSecond": distribution([abs(row["zoomPercentPerSecond"]) for row in valid_motion]),
            "translationPercentPerSecond": distribution([row["translationPercentPerSecond"] for row in valid_motion]),
        },
        "reports": reports,
    }
    output_path = args.output_dir / "reference-video-measurements.json"
    output_path.write_text(json.dumps(aggregate, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({
        "outputPath": str(output_path.resolve()),
        "videoCount": len(reports),
        "sampleCount": len(all_samples),
        "contactSheets": [report["contactSheetPath"] for report in reports],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
