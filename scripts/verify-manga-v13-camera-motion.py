#!/usr/bin/env python3
"""Verify that every authored shot visibly pulls out in the rendered cuts."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np


def frame_at(capture: cv2.VideoCapture, seconds: float) -> np.ndarray:
    capture.set(cv2.CAP_PROP_POS_MSEC, max(0.0, seconds) * 1000.0)
    ok, frame = capture.read()
    if not ok or frame is None:
        raise RuntimeError(f"Could not read frame at {seconds:.3f}s")
    return frame


def background_feature_mask(frame: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    # Speech bubbles and caption cards are bright, low-saturation overlays that
    # stay locked to the screen. Excluding them lets RANSAC measure the moving
    # artwork instead of mistakenly reporting a static camera.
    overlay = cv2.inRange(hsv, np.array([0, 0, 210]), np.array([179, 72, 255]))
    overlay = cv2.dilate(overlay, np.ones((11, 11), np.uint8), iterations=2)
    return cv2.bitwise_not(overlay)


def affine_scale(first: np.ndarray, second: np.ndarray) -> dict:
    gray_a = cv2.cvtColor(first, cv2.COLOR_BGR2GRAY)
    gray_b = cv2.cvtColor(second, cv2.COLOR_BGR2GRAY)
    points = cv2.goodFeaturesToTrack(
        gray_a,
        maxCorners=900,
        qualityLevel=0.01,
        minDistance=8,
        mask=background_feature_mask(first),
    )
    if points is None or len(points) < 24:
        return {"valid": False, "reason": "insufficient-features"}
    tracked, status, _ = cv2.calcOpticalFlowPyrLK(
        gray_a,
        gray_b,
        points,
        None,
        winSize=(31, 31),
        maxLevel=4,
        criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 40, 0.01),
    )
    if tracked is None or status is None:
        return {"valid": False, "reason": "optical-flow-failed"}
    source = points[status.reshape(-1) == 1].reshape(-1, 2)
    target = tracked[status.reshape(-1) == 1].reshape(-1, 2)
    if len(source) < 20:
        return {"valid": False, "reason": "insufficient-tracks"}
    matrix, inliers = cv2.estimateAffinePartial2D(
        source,
        target,
        method=cv2.RANSAC,
        ransacReprojThreshold=3.0,
        maxIters=4000,
        confidence=0.995,
    )
    if matrix is None or inliers is None:
        return {"valid": False, "reason": "affine-fit-failed"}
    a, b = float(matrix[0, 0]), float(matrix[0, 1])
    scale = math.sqrt(a * a + b * b)
    inlier_ratio = float(inliers.mean())
    return {
        "valid": inlier_ratio >= 0.34,
        "scale": scale,
        "scaleChangePercent": (scale - 1.0) * 100.0,
        "inlierRatio": inlier_ratio,
        **({"reason": "low-inlier-ratio"} if inlier_ratio < 0.34 else {}),
    }


def make_contact_sheet(items: list[tuple[np.ndarray, str]], output_path: Path) -> None:
    width, height = 384, 216
    columns = 9
    rows = math.ceil(len(items) / columns)
    sheet = np.zeros((rows * height, columns * width, 3), dtype=np.uint8)
    for index, (frame, label) in enumerate(items):
        thumb = cv2.resize(frame, (width, height), interpolation=cv2.INTER_AREA)
        cv2.rectangle(thumb, (0, height - 27), (width, height), (0, 0, 0), -1)
        cv2.putText(thumb, label, (7, height - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.48, (255, 255, 255), 1, cv2.LINE_AA)
        row, column = divmod(index, columns)
        sheet[row * height:(row + 1) * height, column * width:(column + 1) * width] = thumb
    cv2.imwrite(str(output_path), sheet, [cv2.IMWRITE_JPEG_QUALITY, 91])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--episode-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--plan", type=Path)
    parser.add_argument("--label", default="v13")
    args = parser.parse_args()

    episode_dir = args.episode_dir.resolve()
    manifest = json.loads((episode_dir / "episode-manifest.json").read_text())
    plan_path = (args.plan or episode_dir / "v13-camera-motion-plan.json").resolve()
    plan = json.loads(plan_path.read_text())
    plan_by_cut: dict[str, list[dict]] = {}
    for row in plan["rows"]:
        plan_by_cut.setdefault(row["cutId"], []).append(row)

    checks: list[dict] = []
    contact_items: list[tuple[np.ndarray, str]] = []
    for cut in manifest["cuts"]:
        video_path = episode_dir / ".render-work" / f"{cut['id']}.mp4"
        capture = cv2.VideoCapture(str(video_path))
        if not capture.isOpened():
            raise RuntimeError(f"Could not open {video_path}")
        cursor = 0.0
        for row in plan_by_cut.get(cut["id"], []):
            duration = float(row["durationSeconds"])
            fractions = (0.18, 0.50, 0.82)
            frames = [frame_at(capture, cursor + duration * fraction) for fraction in fractions]
            first_half = affine_scale(frames[0], frames[1])
            second_half = affine_scale(frames[1], frames[2])
            valid_parts = [part for part in (first_half, second_half) if part.get("valid")]
            measured_total = None
            if len(valid_parts) == 2:
                measured_total = ((first_half["scale"] * second_half["scale"]) - 1.0) * 100.0
            elif len(valid_parts) == 1:
                measured_total = valid_parts[0]["scaleChangePercent"] * 2.0
            pass_pull = measured_total is not None and measured_total <= -1.2
            checks.append({
                **row,
                "renderedCutPath": str(video_path),
                "firstHalf": first_half,
                "secondHalf": second_half,
                "measuredScaleChange18To82Percent": measured_total,
                "pass": pass_pull,
            })
            labels = ("START", "MID", "END")
            for frame, label in zip(frames, labels):
                contact_items.append((frame, f"{cut['id']} {row['angle']} {label}"))
            cursor += duration
        capture.release()

    output_path = (args.output or episode_dir / f"{args.label}-camera-motion-evidence.json").resolve()
    contact_path = output_path.with_name(f"{args.label}-camera-motion-contact-75.jpg")
    make_contact_sheet(contact_items, contact_path)
    pass_count = sum(check["pass"] for check in checks)
    measured = [check["measuredScaleChange18To82Percent"] for check in checks if check["measuredScaleChange18To82Percent"] is not None]
    report = {
        "version": f"{args.label}-rendered-camera-motion-evidence",
        "videoPath": manifest.get("outputs", {}).get("reviewVideo", {}).get("filePath"),
        "shotCount": len(checks),
        "passCount": pass_count,
        "failedCount": len(checks) - pass_count,
        "pass": pass_count == len(checks) == 25,
        "renderedMeasuredPullPercent": {
            "minimumMagnitude": min(abs(value) for value in measured) if measured else None,
            "maximumMagnitude": max(abs(value) for value in measured) if measured else None,
            "medianMagnitude": float(np.median(np.abs(measured))) if measured else None,
        },
        "contactSheetPath": str(contact_path),
        "checks": checks,
    }
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({
        "outputPath": str(output_path),
        "contactSheetPath": str(contact_path),
        "shotCount": len(checks),
        "passCount": pass_count,
        "failedCount": len(checks) - pass_count,
        "pass": report["pass"],
        "renderedMeasuredPullPercent": report["renderedMeasuredPullPercent"],
    }, ensure_ascii=False, indent=2))
    if not report["pass"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
