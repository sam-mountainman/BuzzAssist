#!/usr/bin/env python3
"""Measure editorial plates and split-panel camera behavior in both references.

The full videos are sampled at 2 fps. The 20 user-identified reference moments
are also inspected at full resolution with subtitle context and per-panel motion.
Automatic full-video labels remain candidates; only the identified moments are
treated as approved examples.
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


PLATE_MOMENTS = [
    ("awAbZyTeE4g", 668, 1), ("awAbZyTeE4g", 669, 2),
    ("2ycRncs4CKY", 1181, 3), ("awAbZyTeE4g", 674, 4),
    ("2ycRncs4CKY", 1187, 5), ("2ycRncs4CKY", 1191, 6),
    ("2ycRncs4CKY", 1196, 7), ("2ycRncs4CKY", 1720, 8),
    ("2ycRncs4CKY", 1728, 9), ("2ycRncs4CKY", 1734, 10),
    ("2ycRncs4CKY", 1739, 11), ("2ycRncs4CKY", 1742, 12),
    ("2ycRncs4CKY", 1749, 13),
]

SPLIT_MOMENTS = [
    ("awAbZyTeE4g", 233, 14), ("awAbZyTeE4g", 954, 15),
    ("awAbZyTeE4g", 1137, 16), ("awAbZyTeE4g", 1329, 17),
    ("2ycRncs4CKY", 983, 18), ("awAbZyTeE4g", 1530, 19),
    ("2ycRncs4CKY", 648, 20),
]

APPROVED_SPLIT_TYPES = {
    14: "vertical-2", 15: "vertical-2", 16: "vertical-2", 17: "vertical-2",
    18: "vertical-2", 19: "vertical-2", 20: "story-3",
}


def finite(value: float, digits: int = 4) -> float:
    return round(float(value), digits)


def distribution(values: list[float]) -> dict:
    if not values:
        return {"count": 0, "mean": None, "median": None, "p10": None, "p90": None}
    return {
        "count": len(values),
        "mean": finite(statistics.fmean(values)),
        "median": finite(statistics.median(values)),
        "p10": finite(np.percentile(values, 10)),
        "p90": finite(np.percentile(values, 90)),
    }


def ffprobe_duration(path: Path) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, text=True,
    )
    return float(result.stdout.strip())


def read_frame(path: Path, second: float) -> np.ndarray:
    capture = cv2.VideoCapture(str(path))
    capture.set(cv2.CAP_PROP_POS_MSEC, max(0.0, second) * 1000)
    ok, frame = capture.read()
    capture.release()
    if not ok or frame is None:
        raise RuntimeError(f"Could not read {path} at {second:.3f}s")
    return frame


def runs(indices: np.ndarray) -> list[tuple[int, int]]:
    if indices.size == 0:
        return []
    groups = np.split(indices, np.where(np.diff(indices) > 1)[0] + 1)
    return [(int(group[0]), int(group[-1])) for group in groups if group.size]


def separators(gray: np.ndarray) -> dict:
    height, width = gray.shape
    dark = gray < 28
    vertical = [
        run for run in runs(np.flatnonzero(dark.mean(axis=0) > 0.72))
        if width * 0.003 <= run[1] - run[0] + 1 <= width * 0.05
        and width * 0.07 < run[0] < width * 0.93
    ]
    horizontal = [
        run for run in runs(np.flatnonzero(dark.mean(axis=1) > 0.72))
        if height * 0.004 <= run[1] - run[0] + 1 <= height * 0.07
        and height * 0.07 < run[0] < height * 0.93
    ]
    lines = cv2.HoughLinesP(
        cv2.Canny(gray, 45, 110), 1, np.pi / 180, threshold=max(38, width // 7),
        minLineLength=int(width * 0.24), maxLineGap=int(width * 0.025),
    )
    diagonals = []
    if lines is not None:
        for line in lines[:, 0, :]:
            x1, y1, x2, y2 = map(int, line)
            dx, dy = x2 - x1, y2 - y1
            length = math.hypot(dx, dy)
            slope = abs(dy / dx) if dx else 99
            if length >= width * 0.24 and 0.12 <= slope <= 2.2:
                dark_samples = []
                for alpha in np.linspace(0, 1, 60):
                    x = int(round(x1 + dx * alpha))
                    y = int(round(y1 + dy * alpha))
                    dark_samples.append(gray[max(0, y - 2):min(height, y + 3), max(0, x - 2):min(width, x + 3)].mean() < 65)
                if np.mean(dark_samples) >= 0.66:
                    diagonals.append([x1, y1, x2, y2])
    return {"vertical": vertical, "horizontal": horizontal, "diagonal": diagonals[:8]}


def frame_metrics(frame: np.ndarray) -> dict:
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    edges = cv2.Canny(gray, 70, 150)
    sep = separators(gray)
    white_ratio = float((gray >= 242).mean())
    black_ratio = float((gray <= 18).mean())
    edge_density = float((edges > 0).mean())
    saturation = float(hsv[:, :, 1].mean())
    mean_luma = float(gray.mean())
    if white_ratio >= 0.72 and edge_density <= 0.055:
        plate_class = "white-solid"
    elif black_ratio >= 0.72 and edge_density <= 0.055:
        plate_class = "black-solid"
    elif edge_density <= 0.035 and mean_luma >= 135 and saturation <= 90:
        plate_class = "pastel-atmosphere-candidate"
    else:
        plate_class = "illustrated-scene"
    if sep["vertical"] and sep["diagonal"]:
        split_class = "story-3-candidate"
    elif len(sep["vertical"]) >= 2:
        split_class = "vertical-3-candidate"
    elif len(sep["vertical"]) == 1:
        split_class = "vertical-2-candidate"
    elif sep["horizontal"]:
        split_class = "horizontal-2-candidate"
    else:
        split_class = "single-frame"
    return {
        "meanLuma": finite(mean_luma),
        "meanSaturation": finite(saturation),
        "edgeDensity": finite(edge_density, 5),
        "whitePixelRatio": finite(white_ratio),
        "blackPixelRatio": finite(black_ratio),
        "plateClass": plate_class,
        "splitClass": split_class,
        "separators": {
            "vertical": [[finite(a / gray.shape[1]), finite((b - a + 1) / gray.shape[1])] for a, b in sep["vertical"]],
            "horizontal": [[finite(a / gray.shape[0]), finite((b - a + 1) / gray.shape[0])] for a, b in sep["horizontal"]],
            "diagonalCount": len(sep["diagonal"]),
        },
    }


def affine_motion(first: np.ndarray, second: np.ndarray) -> dict:
    if first.size == 0 or second.size == 0:
        return {"valid": False, "reason": "empty-panel"}
    first = cv2.resize(first, (max(160, first.shape[1] // 2), max(120, first.shape[0] // 2)))
    second = cv2.resize(second, (first.shape[1], first.shape[0]))
    gray_a = cv2.cvtColor(first, cv2.COLOR_BGR2GRAY)
    gray_b = cv2.cvtColor(second, cv2.COLOR_BGR2GRAY)
    points = cv2.goodFeaturesToTrack(gray_a, maxCorners=450, qualityLevel=0.012, minDistance=7)
    if points is None or len(points) < 18:
        return {"valid": False, "reason": "insufficient-features"}
    tracked, status, _ = cv2.calcOpticalFlowPyrLK(gray_a, gray_b, points, None)
    if tracked is None or status is None:
        return {"valid": False, "reason": "optical-flow-failed"}
    source = points[status.reshape(-1) == 1].reshape(-1, 2)
    target = tracked[status.reshape(-1) == 1].reshape(-1, 2)
    if len(source) < 14:
        return {"valid": False, "reason": "insufficient-tracks"}
    matrix, inliers = cv2.estimateAffinePartial2D(
        source, target, method=cv2.RANSAC, ransacReprojThreshold=2.2,
        maxIters=3000, confidence=0.995,
    )
    if matrix is None or inliers is None:
        return {"valid": False, "reason": "affine-fit-failed"}
    a, b, tx = matrix[0]
    _c, _d, ty = matrix[1]
    scale = math.sqrt(float(a * a + b * b))
    zoom_percent = (scale - 1) * 100
    translate_x = float(tx) / gray_a.shape[1] * 100
    translate_y = float(ty) / gray_a.shape[0] * 100
    inlier_ratio = float(inliers.mean())
    valid = inlier_ratio >= 0.34 and abs(zoom_percent) <= 10 and math.hypot(translate_x, translate_y) <= 18
    return {
        "valid": valid,
        "trackCount": len(source),
        "inlierRatio": finite(inlier_ratio),
        "zoomPercentPerSecond": finite(zoom_percent),
        "translateXPercentPerSecond": finite(translate_x),
        "translateYPercentPerSecond": finite(translate_y),
        "translationPercentPerSecond": finite(math.hypot(translate_x, translate_y)),
        **({"reason": "probable-shot-change-or-local-character-motion"} if not valid else {}),
    }


def panel_crops(frame: np.ndarray, measured: dict) -> list[np.ndarray]:
    height, width = frame.shape[:2]
    vertical = measured["separators"]["vertical"]
    if not vertical:
        return [frame]
    center_ratio, gutter_ratio = vertical[0]
    x1 = max(1, int((center_ratio - gutter_ratio * 0.5) * width))
    x2 = min(width - 1, int((center_ratio + gutter_ratio * 0.5) * width))
    if measured.get("approvedSplitType") == "story-3" or measured["splitClass"] == "story-3-candidate":
        return [frame[:, :x1], frame[: int(height * 0.58), x2:], frame[int(height * 0.42):, x2:]]
    return [frame[:, :x1], frame[:, x2:]]


def parse_vtt_context(path: Path, second: float) -> list[str]:
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8", errors="replace")
    cue_re = re.compile(
        r"(?P<start>\d\d:\d\d:\d\d\.\d+)\s+-->\s+(?P<end>\d\d:\d\d:\d\d\.\d+)[^\n]*\n(?P<body>.*?)(?=\n\n|\Z)",
        re.S,
    )
    def seconds(value: str) -> float:
        hours, minutes, rest = value.split(":")
        return int(hours) * 3600 + int(minutes) * 60 + float(rest)
    rows = []
    for match in cue_re.finditer(text):
        start, end = seconds(match.group("start")), seconds(match.group("end"))
        if end >= second - 3 and start <= second + 3:
            body = re.sub(r"<[^>]+>", "", match.group("body"))
            body = " ".join(line.strip() for line in body.splitlines() if line.strip())
            if body and body not in rows:
                rows.append(body)
    return rows[-4:]


def make_contact_sheet(rows: list[tuple[np.ndarray, str]], output: Path, columns: int = 4) -> None:
    thumb_width, thumb_height = 384, 216
    row_count = math.ceil(len(rows) / columns)
    sheet = np.full((row_count * thumb_height, columns * thumb_width, 3), 245, np.uint8)
    for index, (frame, label) in enumerate(rows):
        thumb = cv2.resize(frame, (thumb_width, thumb_height), interpolation=cv2.INTER_AREA)
        cv2.rectangle(thumb, (0, 0), (thumb_width, 28), (0, 0, 0), -1)
        cv2.putText(thumb, label, (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.49, (255, 255, 255), 1, cv2.LINE_AA)
        row, column = divmod(index, columns)
        sheet[row * thumb_height:(row + 1) * thumb_height, column * thumb_width:(column + 1) * thumb_width] = thumb
    cv2.imwrite(str(output), sheet, [cv2.IMWRITE_JPEG_QUALITY, 94])


def full_scan(video_path: Path, sample_fps: float) -> dict:
    width, height = 320, 180
    command = [
        "ffmpeg", "-v", "error", "-i", str(video_path),
        "-vf", f"fps={sample_fps},scale={width}:{height}:flags=area",
        "-pix_fmt", "bgr24", "-f", "rawvideo", "-",
    ]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frame_bytes = width * height * 3
    rows = []
    index = 0
    assert process.stdout is not None
    while True:
        data = process.stdout.read(frame_bytes)
        if len(data) != frame_bytes:
            break
        frame = np.frombuffer(data, dtype=np.uint8).reshape(height, width, 3)
        measured = frame_metrics(frame)
        measured["second"] = finite(index / sample_fps, 3)
        rows.append(measured)
        index += 1
    process.stdout.close()
    process.wait()
    plate_counts = {}
    split_counts = {}
    for row in rows:
        plate_counts[row["plateClass"]] = plate_counts.get(row["plateClass"], 0) + 1
        split_counts[row["splitClass"]] = split_counts.get(row["splitClass"], 0) + 1
    return {
        "sampleFps": sample_fps,
        "sampleCount": len(rows),
        "candidateCaveat": "Full-scan classifications are CV candidates, not approved examples; use the 20 matched moments for editorial rules.",
        "plateCandidateCounts": plate_counts,
        "splitCandidateCounts": split_counts,
    }


def inspect_moments(root: Path, videos: dict[str, Path], rows: list[tuple[str, int, int]], kind: str) -> tuple[list[dict], list[tuple[np.ndarray, str]]]:
    inspected = []
    sheet_rows = []
    for video_id, second, attachment in rows:
        video_path = videos[video_id]
        center = read_frame(video_path, second)
        before = read_frame(video_path, max(0, second - 0.5))
        after = read_frame(video_path, min(ffprobe_duration(video_path) - 0.05, second + 0.5))
        measured = frame_metrics(center)
        if kind == "split":
            measured["approvedSplitType"] = APPROVED_SPLIT_TYPES[attachment]
        record = {
            "attachment": attachment,
            "videoId": video_id,
            "second": second,
            "metrics": measured,
            "subtitleContext": parse_vtt_context(root / f"{video_id}.ja-orig.vtt", second),
        }
        if kind == "split":
            crops_before = panel_crops(before, measured)
            crops_after = panel_crops(after, measured)
            record["panelMotion"] = [
                affine_motion(first, last) for first, last in zip(crops_before, crops_after)
            ]
        inspected.append(record)
        sheet_rows.append((center, f"#{attachment:02d} {video_id[:3]} {second}s {measured['plateClass'] if kind == 'plate' else measured['splitClass']}"))
    return inspected, sheet_rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-dir", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--sample-fps", type=float, default=2.0)
    args = parser.parse_args()
    project = Path(args.project_dir).resolve()
    root = project / "canvas/reference-media/love-manga"
    output_dir = root / "analysis/v30-editorial-plates-splits"
    output_dir.mkdir(parents=True, exist_ok=True)
    videos = {video_id: root / f"{video_id}.mp4" for video_id in ["awAbZyTeE4g", "2ycRncs4CKY"]}
    scans = {video_id: full_scan(path, args.sample_fps) for video_id, path in videos.items()}
    plates, plate_sheet = inspect_moments(root, videos, PLATE_MOMENTS, "plate")
    splits, split_sheet = inspect_moments(root, videos, SPLIT_MOMENTS, "split")
    make_contact_sheet(plate_sheet, output_dir / "approved-plate-moments.jpg", 4)
    make_contact_sheet(split_sheet, output_dir / "approved-split-moments.jpg", 3)
    valid_motion = [motion for row in splits for motion in row.get("panelMotion", []) if motion.get("valid")]
    gutter_ratios = [
        gutter for row in splits for _center, gutter in row["metrics"]["separators"]["vertical"]
    ]
    report = {
        "version": "reference-v30-editorial-plates-splits-r1",
        "method": {
            "fullScan": "Both full videos decoded at 2 fps and resized to 320x180 for color/edge/black-separator candidates.",
            "approvedMoments": "Twenty user-identified moments measured at source resolution with subtitle context.",
            "panelMotion": "Each approved split moment compares t-0.5s to t+0.5s with per-panel RANSAC partial-affine optical flow.",
        },
        "sources": [{"id": key, "path": str(value), "durationSeconds": finite(ffprobe_duration(value))} for key, value in videos.items()],
        "fullScans": scans,
        "approvedPlateMoments": plates,
        "approvedSplitMoments": splits,
        "summary": {
            "approvedPlateMomentCount": len(plates),
            "approvedSplitMomentCount": len(splits),
            "plateClassCounts": {
                name: sum(row["metrics"]["plateClass"] == name for row in plates)
                for name in ["white-solid", "black-solid", "pastel-atmosphere-candidate", "illustrated-scene"]
            },
            "splitClassCounts": {
                name: sum(row["metrics"].get("approvedSplitType") == name for row in splits)
                for name in ["vertical-2", "story-3"]
            },
            "verticalGutterWidthRatio": distribution(gutter_ratios),
            "validPanelMotionSampleCount": len(valid_motion),
            "panelZoomPercentPerSecond": distribution([abs(row["zoomPercentPerSecond"]) for row in valid_motion]),
            "panelTranslationPercentPerSecond": distribution([row["translationPercentPerSecond"] for row in valid_motion]),
            "movingPanelRatio": finite(sum(
                abs(row["zoomPercentPerSecond"]) >= 0.08 or row["translationPercentPerSecond"] >= 0.08
                for row in valid_motion
            ) / max(1, len(valid_motion))),
        },
        "editorialRules": {
            "whiteSolid": "Opening premise, neutral exposition, a pause of recognition, or a clean reset; no location or character art.",
            "blackSolid": "Heavier retrospective narration, isolation, withheld reaction, or tonal descent; use less often than white/pastel.",
            "pastelAtmosphere": "Tender memory, promise, emotional release, or epilogue reflection; abstract sky/light only, no literal room.",
            "twoPanel": "Direct contrast, simultaneous reaction, confrontation, before/after, or two people whose relation matters more than geography.",
            "threePanel": "Three distinct beats compressed across time/space; each panel must add new information rather than duplicate one shot.",
            "composition": "Generate each panel as a clean full illustration, then crop/move/mask and draw the black gutter in post. Never ask the image model to draw panel borders or text.",
            "panelCamera": "Camera is evaluated independently inside every panel; subtle pan/push must preserve the panel-safe face and bubble zones.",
        },
        "contactSheets": {
            "plates": str((output_dir / "approved-plate-moments.jpg").resolve()),
            "splits": str((output_dir / "approved-split-moments.jpg").resolve()),
        },
    }
    report_path = output_dir / "reference-editorial-plates-splits-v30.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"reportPath": str(report_path.resolve()), "summary": report["summary"], "contactSheets": report["contactSheets"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
