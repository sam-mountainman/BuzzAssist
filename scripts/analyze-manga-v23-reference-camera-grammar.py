#!/usr/bin/env python3
"""Extract camera-start and reveal grammar from the two authored references.

The report keeps measured motion, face detections, and caption timing separate
from editorial inferences.  Face detection is deliberately treated as a
review aid: the bundled LBP cascade misses stylized/profile faces.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
from pathlib import Path

import cv2
import numpy as np


def rounded(value: float, digits: int = 5) -> float:
    return round(float(value), digits)


def percentile(values: list[float], point: int) -> float | None:
    if not values:
        return None
    return rounded(np.percentile(np.asarray(values, dtype=np.float64), point))


def distribution(values: list[float]) -> dict:
    if not values:
        return {"count": 0, "median": None, "p10": None, "p90": None}
    return {
        "count": len(values),
        "median": rounded(statistics.median(values)),
        "p10": percentile(values, 10),
        "p90": percentile(values, 90),
    }


def parse_scene_csv(path: Path) -> list[dict]:
    rows = list(csv.reader(path.open(newline="", encoding="utf-8-sig")))
    header_index = next(index for index, row in enumerate(rows) if row and row[0] == "Scene Number")
    scenes = []
    for row in csv.DictReader([",".join(item) for item in rows[header_index:]]):
        scenes.append({
            "number": int(row["Scene Number"]),
            "start": float(row["Start Time (seconds)"]),
            "end": float(row["End Time (seconds)"]),
            "duration": float(row["Length (seconds)"]),
        })
    return scenes


def parse_captions(path: Path) -> list[dict]:
    source = json.loads(path.read_text(encoding="utf-8"))
    captions = []
    for event in source.get("events", []):
        segments = event.get("segs") or []
        text = "".join(segment.get("utf8", "") for segment in segments).replace("\n", " ").strip()
        if not text:
            continue
        start = float(event.get("tStartMs", 0)) / 1000
        duration = float(event.get("dDurationMs", 0)) / 1000
        captions.append({"start": start, "end": start + duration, "text": text})
    return captions


def read_frame(capture: cv2.VideoCapture, seconds: float) -> np.ndarray | None:
    capture.set(cv2.CAP_PROP_POS_MSEC, max(0, seconds) * 1000)
    ok, frame = capture.read()
    return frame if ok and frame is not None else None


def motion_measure(first: np.ndarray, second: np.ndarray) -> dict:
    gray_a = cv2.cvtColor(first, cv2.COLOR_BGR2GRAY)
    gray_b = cv2.cvtColor(second, cv2.COLOR_BGR2GRAY)
    points = cv2.goodFeaturesToTrack(gray_a, maxCorners=700, qualityLevel=0.012, minDistance=7)
    if points is None or len(points) < 28:
        return {"valid": False, "reason": "insufficient-features"}
    tracked, status, _ = cv2.calcOpticalFlowPyrLK(
        gray_a, gray_b, points, None,
        winSize=(31, 31), maxLevel=4,
        criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 40, 0.001),
    )
    if tracked is None or status is None:
        return {"valid": False, "reason": "optical-flow-failed"}
    keep = status.reshape(-1) == 1
    source = points[keep].reshape(-1, 2)
    target = tracked[keep].reshape(-1, 2)
    if len(source) < 22:
        return {"valid": False, "reason": "insufficient-tracks"}
    matrix, inliers = cv2.estimateAffinePartial2D(
        source, target, method=cv2.RANSAC,
        ransacReprojThreshold=2.8, maxIters=4000, confidence=0.997,
    )
    if matrix is None or inliers is None:
        return {"valid": False, "reason": "affine-fit-failed"}
    a, b, tx = matrix[0]
    _c, _d, ty = matrix[1]
    scale = math.sqrt(float(a * a + b * b))
    height, width = gray_a.shape
    dx = float(tx) / width
    dy = float(ty) / height
    scale_delta = scale - 1
    inlier_ratio = float(inliers.mean())
    valid = inlier_ratio >= 0.37 and abs(scale_delta) <= 0.28 and math.hypot(dx, dy) <= 0.32
    return {
        "valid": valid,
        "inlierRatio": rounded(inlier_ratio, 4),
        "contentScaleDelta": rounded(scale_delta),
        "contentTranslateX": rounded(dx),
        "contentTranslateY": rounded(dy),
        "cameraPullOut": bool(scale_delta < -0.008),
        "cameraPushIn": bool(scale_delta > 0.008),
        "horizontalTravel": bool(abs(dx) >= 0.012 and abs(dx) >= abs(dy) * 1.15),
        "verticalTravel": bool(abs(dy) >= 0.012 and abs(dy) > abs(dx) * 1.15),
        **({"reason": "probable-local-motion-or-transition"} if not valid else {}),
    }


def face_detections(frame: np.ndarray, cascade: cv2.CascadeClassifier) -> list[dict]:
    if cascade.empty():
        return []
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)
    height, width = gray.shape
    faces = cascade.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=4, minSize=(42, 42))
    output = []
    for x, y, face_width, face_height in faces:
        output.append({
            "x": rounded(x / width, 4),
            "y": rounded(y / height, 4),
            "width": rounded(face_width / width, 4),
            "height": rounded(face_height / height, 4),
            "centerX": rounded((x + face_width / 2) / width, 4),
            "centerY": rounded((y + face_height / 2) / height, 4),
            "area": rounded(face_width * face_height / (width * height), 5),
        })
    return sorted(output, key=lambda face: face["area"], reverse=True)


def classify_motion(motion: dict) -> str:
    if not motion.get("valid"):
        return "unresolved"
    pull = motion["cameraPullOut"]
    push = motion["cameraPushIn"]
    horizontal = motion["horizontalTravel"]
    vertical = motion["verticalTravel"]
    if pull and horizontal:
        return "pullout-plus-horizontal"
    if pull and vertical:
        return "pullout-plus-top"
    if pull:
        return "pullout-only"
    if push and horizontal:
        return "pushin-plus-horizontal"
    if push and vertical:
        return "pushin-plus-top"
    if push:
        return "pushin-only"
    if horizontal:
        return "horizontal-only"
    if vertical:
        return "top-only"
    return "near-hold"


def caption_events_for(captions: list[dict], start: float, end: float) -> list[dict]:
    return [caption for caption in captions if caption["start"] < end and caption["end"] > start]


def triptych(frames: list[np.ndarray], labels: list[str], path: Path) -> None:
    thumb_width, thumb_height = 480, 270
    canvas = np.zeros((thumb_height + 36, thumb_width * len(frames), 3), dtype=np.uint8)
    for index, (frame, label) in enumerate(zip(frames, labels)):
        thumb = cv2.resize(frame, (thumb_width, thumb_height), interpolation=cv2.INTER_AREA)
        canvas[:thumb_height, index * thumb_width:(index + 1) * thumb_width] = thumb
        cv2.putText(
            canvas, label, (index * thumb_width + 10, thumb_height + 25),
            cv2.FONT_HERSHEY_SIMPLEX, 0.54, (255, 255, 255), 1, cv2.LINE_AA,
        )
    cv2.imwrite(str(path), canvas, [cv2.IMWRITE_JPEG_QUALITY, 93])


def contact_page(rows: list[dict], path: Path, columns: int = 3) -> None:
    if not rows:
        return
    tile_width, tile_height = 450, 290
    page_rows = math.ceil(len(rows) / columns)
    canvas = np.full((page_rows * tile_height, columns * tile_width, 3), 19, dtype=np.uint8)
    for index, row in enumerate(rows):
        image = cv2.imread(row["triptychPath"])
        if image is None:
            continue
        image = cv2.resize(image, (tile_width, 96), interpolation=cv2.INTER_AREA)
        row_index, column_index = divmod(index, columns)
        x, y = column_index * tile_width, row_index * tile_height
        canvas[y:y + 96, x:x + tile_width] = image
        lines = [
            f"{row['videoId']} scene {row['sceneNumber']}  {row['start']:.2f}-{row['end']:.2f}s",
            f"{row['classification']}  duration={row['duration']:.2f}s captions={row['captionStartCount']}",
            f"scale={row['motion'].get('contentScaleDelta')} dx={row['motion'].get('contentTranslateX')} dy={row['motion'].get('contentTranslateY')}",
            f"faces {len(row['faces']['start'])}->{len(row['faces']['end'])}  switch={row['dominantFaceSwitchCandidate']}",
        ]
        for line_index, line in enumerate(lines):
            cv2.putText(
                canvas, line, (x + 8, y + 125 + line_index * 28),
                cv2.FONT_HERSHEY_SIMPLEX, 0.47, (235, 235, 235), 1, cv2.LINE_AA,
            )
    cv2.imwrite(str(path), canvas, [cv2.IMWRITE_JPEG_QUALITY, 92])


def analyze_video(video_id: str, video_path: Path, scene_path: Path, caption_path: Path,
                  cascade: cv2.CascadeClassifier, output_dir: Path) -> dict:
    scenes = parse_scene_csv(scene_path)
    captions = parse_captions(caption_path)
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError(f"Could not open {video_path}")
    scene_rows = []
    triptych_dir = output_dir / "triptychs" / video_id
    triptych_dir.mkdir(parents=True, exist_ok=True)
    for scene in scenes:
        if scene["duration"] < 1.45:
            continue
        inset = min(0.18, scene["duration"] * 0.06)
        sample_times = [
            scene["start"] + inset,
            scene["start"] + scene["duration"] * 0.5,
            scene["end"] - inset,
        ]
        frames = [read_frame(capture, second) for second in sample_times]
        if any(frame is None for frame in frames):
            continue
        start_frame, mid_frame, end_frame = frames
        motion = motion_measure(start_frame, end_frame)
        first_motion = motion_measure(start_frame, mid_frame)
        last_motion = motion_measure(mid_frame, end_frame)
        scene_captions = caption_events_for(captions, scene["start"], scene["end"])
        caption_starts = [caption for caption in scene_captions if scene["start"] <= caption["start"] < scene["end"]]
        faces_start = face_detections(start_frame, cascade)
        faces_mid = face_detections(mid_frame, cascade)
        faces_end = face_detections(end_frame, cascade)
        start_dominant = faces_start[0] if faces_start else None
        end_dominant = faces_end[0] if faces_end else None
        face_switch = bool(
            start_dominant and end_dominant
            and abs(start_dominant["centerX"] - end_dominant["centerX"]) >= 0.16
        )
        classification = classify_motion(motion)
        triptych_path = triptych_dir / f"scene-{scene['number']:03d}.jpg"
        triptych(
            frames,
            [f"START {sample_times[0]:.2f}s", f"MID {sample_times[1]:.2f}s", f"END {sample_times[2]:.2f}s"],
            triptych_path,
        )
        scene_rows.append({
            "videoId": video_id,
            "sceneNumber": scene["number"],
            "start": rounded(scene["start"], 3),
            "end": rounded(scene["end"], 3),
            "duration": rounded(scene["duration"], 3),
            "classification": classification,
            "motion": motion,
            "firstHalfMotion": first_motion,
            "lastHalfMotion": last_motion,
            "captionOverlapCount": len(scene_captions),
            "captionStartCount": len(caption_starts),
            "captionStarts": [rounded(caption["start"], 3) for caption in caption_starts],
            "captionTexts": [caption["text"][:90] for caption in caption_starts[:8]],
            "faces": {"start": faces_start, "mid": faces_mid, "end": faces_end},
            "dominantFaceSwitchCandidate": face_switch,
            "triptychPath": str(triptych_path.resolve()),
        })
    capture.release()
    valid = [row for row in scene_rows if row["motion"].get("valid")]
    counts: dict[str, int] = {}
    for row in valid:
        counts[row["classification"]] = counts.get(row["classification"], 0) + 1
    return {
        "videoId": video_id,
        "videoPath": str(video_path.resolve()),
        "sceneCsvPath": str(scene_path.resolve()),
        "captionPath": str(caption_path.resolve()),
        "analyzedSceneCount": len(scene_rows),
        "validMotionCount": len(valid),
        "classificationCounts": counts,
        "durationSeconds": distribution([row["duration"] for row in scene_rows]),
        "captionStartsPerScene": distribution([row["captionStartCount"] for row in scene_rows]),
        "multiCaptionSceneCount": sum(row["captionStartCount"] >= 2 for row in scene_rows),
        "dominantFaceSwitchCandidateCount": sum(row["dominantFaceSwitchCandidate"] for row in scene_rows),
        "scenes": scene_rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-dir", type=Path, default=Path.cwd())
    args = parser.parse_args()
    project_dir = args.project_dir.resolve()
    media_dir = project_dir / "canvas/reference-media/love-manga"
    analysis_dir = media_dir / "analysis"
    output_dir = analysis_dir / "v23-reference-camera-grammar"
    output_dir.mkdir(parents=True, exist_ok=True)
    cascade_path = project_dir / "canvas/.camera-tools/animeface/lbpcascade_animeface.xml"
    cascade = cv2.CascadeClassifier(str(cascade_path))
    configs = [
        (
            "awAbZyTeE4g", media_dir / "awAbZyTeE4g.mp4",
            analysis_dir / "v23-scenes-aw/awAbZyTeE4g-Scenes.csv",
            analysis_dir / "v23-awAbZyTeE4g.ja-orig.json3",
        ),
        (
            "2ycRncs4CKY", media_dir / "2ycRncs4CKY.mp4",
            analysis_dir / "v23-scenes-2yc/2ycRncs4CKY-Scenes.csv",
            analysis_dir / "v23-2ycRncs4CKY.ja-orig.json3",
        ),
    ]
    videos = [
        analyze_video(video_id, video_path, scene_path, caption_path, cascade, output_dir)
        for video_id, video_path, scene_path, caption_path in configs
    ]
    all_rows = [row for video in videos for row in video["scenes"]]
    valid = [row for row in all_rows if row["motion"].get("valid")]
    representative = sorted(
        [row for row in valid if row["captionStartCount"] >= 2 and row["duration"] >= 4.0],
        key=lambda row: (
            row["dominantFaceSwitchCandidate"],
            row["captionStartCount"],
            abs(row["motion"].get("contentScaleDelta", 0))
            + abs(row["motion"].get("contentTranslateX", 0))
            + abs(row["motion"].get("contentTranslateY", 0)),
            row["duration"],
        ),
        reverse=True,
    )[:24]
    representative_path = output_dir / "representative-multicaption-camera-grammar.jpg"
    contact_page(representative, representative_path)
    report = {
        "version": "v23-reference-camera-grammar",
        "referenceVideoIds": [config[0] for config in configs],
        "method": {
            "sceneBoundary": "PySceneDetect adaptive detector; analyzed scenes >= 1.45 seconds",
            "motion": "start/mid/end optical flow plus RANSAC partial-affine fit",
            "captions": "YouTube Japanese auto-caption event starts overlapping each detected visual beat",
            "faceCaveat": "LBP anime-face detections are candidates only; editorial speaker identity requires manual image/script review.",
        },
        "aggregate": {
            "analyzedSceneCount": len(all_rows),
            "validMotionCount": len(valid),
            "movingSceneRatio": rounded(sum(row["classification"] != "near-hold" for row in valid) / max(1, len(valid)), 4),
            "multiCaptionSceneCount": sum(row["captionStartCount"] >= 2 for row in all_rows),
            "multiCaptionSceneRatio": rounded(sum(row["captionStartCount"] >= 2 for row in all_rows) / max(1, len(all_rows)), 4),
            "dominantFaceSwitchCandidateCount": sum(row["dominantFaceSwitchCandidate"] for row in all_rows),
            "classificationCounts": {
                label: sum(row["classification"] == label for row in valid)
                for label in sorted(set(row["classification"] for row in valid))
            },
            "sceneDurationSeconds": distribution([row["duration"] for row in all_rows]),
            "captionStartsPerScene": distribution([row["captionStartCount"] for row in all_rows]),
        },
        "representativeContactSheetPath": str(representative_path.resolve()),
        "representativeSceneKeys": [f"{row['videoId']}:{row['sceneNumber']}" for row in representative],
        "videos": videos,
    }
    report_path = output_dir / "reference-camera-grammar.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "reportPath": str(report_path.resolve()),
        "representativeContactSheetPath": str(representative_path.resolve()),
        "aggregate": report["aggregate"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
