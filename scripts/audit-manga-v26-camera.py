#!/usr/bin/env python3
"""Frame-level audit for V26 continuous linear camera trajectories."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def frame_at_index(capture: cv2.VideoCapture, index: int) -> np.ndarray:
    capture.set(cv2.CAP_PROP_POS_FRAMES, max(0, index))
    ok, frame = capture.read()
    if not ok or frame is None:
        raise RuntimeError(f"Could not decode frame {index}")
    return frame


def bubble_masks(manifest: dict, width: int, height: int) -> dict[str, list[tuple[int, int, int, int]]]:
    masks: dict[str, list[tuple[int, int, int, int]]] = {}
    for utterance in manifest.get("utterances", []):
        spec_path = Path(utterance.get("overlaySpecPath", ""))
        if not spec_path.is_file():
            continue
        spec = read_json(spec_path)
        image_size = spec.get("imageSize", {})
        scale_x = width / float(image_size.get("width") or width)
        scale_y = height / float(image_size.get("height") or height)
        for bubble in spec.get("plan", {}).get("bubbles", []):
            bounds = bubble.get("bounds", {})
            margin = 52
            x1 = max(0, int(float(bounds.get("x", 0)) * scale_x) - margin)
            y1 = max(0, int(float(bounds.get("y", 0)) * scale_y) - margin)
            x2 = min(width, int((float(bounds.get("x", 0)) + float(bounds.get("width", 0))) * scale_x) + margin)
            y2 = min(height, int((float(bounds.get("y", 0)) + float(bounds.get("height", 0))) * scale_y) + margin)
            masks.setdefault(utterance["cutId"], []).append((x1, y1, x2, y2))
    return masks


def affine_step(first: np.ndarray, second: np.ndarray, excluded: list[tuple[int, int, int, int]]) -> dict:
    gray_a = cv2.cvtColor(first, cv2.COLOR_BGR2GRAY)
    gray_b = cv2.cvtColor(second, cv2.COLOR_BGR2GRAY)
    mask = np.full(gray_a.shape, 255, dtype=np.uint8)
    for x1, y1, x2, y2 in excluded:
        cv2.rectangle(mask, (x1, y1), (x2, y2), 0, -1)
    points = cv2.goodFeaturesToTrack(gray_a, maxCorners=1000, qualityLevel=0.008, minDistance=8, mask=mask)
    if points is None or len(points) < 28:
        return {"valid": False, "reason": "insufficient-features"}
    tracked, status, _ = cv2.calcOpticalFlowPyrLK(gray_a, gray_b, points, None)
    if tracked is None or status is None:
        return {"valid": False, "reason": "optical-flow-failed"}
    source = points[status.reshape(-1) == 1].reshape(-1, 2)
    target = tracked[status.reshape(-1) == 1].reshape(-1, 2)
    keep = np.ones(len(source), dtype=bool)
    for x1, y1, x2, y2 in excluded:
        keep &= ~((target[:, 0] >= x1) & (target[:, 0] <= x2) & (target[:, 1] >= y1) & (target[:, 1] <= y2))
    source = source[keep]
    target = target[keep]
    if len(source) < 24:
        return {"valid": False, "reason": "insufficient-unmasked-tracks"}
    matrix, inliers = cv2.estimateAffinePartial2D(
        source,
        target,
        method=cv2.RANSAC,
        ransacReprojThreshold=2.25,
        maxIters=5000,
        confidence=0.998,
    )
    if matrix is None or inliers is None:
        return {"valid": False, "reason": "affine-fit-failed"}
    a, b, dx = matrix[0]
    _c, _d, dy = matrix[1]
    scale = math.sqrt(float(a * a + b * b))
    height, width = gray_a.shape
    equivalent = math.hypot(float(dx), float(dy), abs(math.log(max(scale, 1e-8))) * math.hypot(width, height) * .5)
    return {
        "valid": True,
        "scale": float(scale),
        "dxPixels": float(dx),
        "dyPixels": float(dy),
        "travelPixels": float(math.hypot(float(dx), float(dy))),
        "equivalentMotionPixels": float(equivalent),
        "inlierRatio": float(inliers.mean()),
    }


def window_steps(
    capture: cv2.VideoCapture,
    indices: list[int],
    excluded: list[tuple[int, int, int, int]],
) -> list[dict]:
    frames = [frame_at_index(capture, index) for index in indices]
    return [
        step
        for step in (affine_step(frames[index], frames[index + 1], excluded) for index in range(len(frames) - 1))
        if step.get("valid")
    ]


def median_speed(steps: list[dict]) -> float:
    return float(np.median([step["equivalentMotionPixels"] for step in steps])) if steps else 0.0


def median_value(steps: list[dict], key: str) -> float:
    return float(np.median([step[key] for step in steps])) if steps else 0.0


def border_black_ratio(frame: np.ndarray) -> float:
    strips = [frame[:3, :, :], frame[-3:, :, :], frame[:, :3, :], frame[:, -3:, :]]
    pixels = np.concatenate([strip.reshape(-1, 3) for strip in strips], axis=0)
    return float(np.mean(np.max(pixels, axis=1) <= 3))


def label_frame(frame: np.ndarray, label: str, width: int = 320, height: int = 180) -> np.ndarray:
    resized = cv2.resize(frame, (width, height), interpolation=cv2.INTER_AREA)
    bar = np.zeros((30, width, 3), dtype=np.uint8)
    cv2.putText(bar, label, (7, 20), cv2.FONT_HERSHEY_SIMPLEX, .43, (245, 245, 245), 1, cv2.LINE_AA)
    return np.vstack([resized, bar])


def padded_grid(cells: list[np.ndarray], columns: int) -> np.ndarray:
    blank = np.zeros_like(cells[0])
    while len(cells) % columns:
        cells.append(blank.copy())
    return np.vstack([np.hstack(cells[index:index + columns]) for index in range(0, len(cells), columns)])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--cut-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--sheet", required=True, type=Path)
    args = parser.parse_args()

    manifest = read_json(args.manifest)
    plan = read_json(args.plan)
    fps = float(manifest.get("video", {}).get("fps") or 30)
    cut_plan_by_id = {entry["cutId"]: entry for entry in plan["cuts"]}
    analytic_violations: list[dict] = []
    segment_results: list[dict] = []
    boundary_results: list[dict] = []
    contact_cells: list[np.ndarray] = []
    repeated_image_count = 0
    downward_segment_count = 0
    stopped_segment_count = 0
    non_linear_count = 0
    maximum_black_edge_ratio = 0.0

    first_capture = cv2.VideoCapture(str(args.cut_dir / "cut-01.mp4"))
    if not first_capture.isOpened():
        raise RuntimeError("Could not open rendered cut-01")
    width = int(first_capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(first_capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    first_capture.release()
    masks = bubble_masks(manifest, width, height)

    for cut in manifest["cuts"]:
        cut_id = cut["id"]
        planned = cut_plan_by_id[cut_id]
        capture = cv2.VideoCapture(str(args.cut_dir / f"{cut_id}.mp4"))
        if not capture.isOpened():
            raise RuntimeError(f"Could not open rendered {cut_id}")
        cut_frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        start_frame = 0
        image_names = [shot["image"] for shot in planned["shots"]]
        repeated_image_count += len(image_names) - len(set(image_names))

        for shot in planned["shots"]:
            shot_frames = max(2, int(math.ceil(float(shot["durationSeconds"]) * fps)))
            end_frame = min(cut_frame_count, start_frame + shot_frames)
            keyframes = shot["keyframes"]
            if shot.get("easing") != "linear":
                non_linear_count += 1
            for segment_index in range(len(keyframes) - 1):
                first = keyframes[segment_index]
                second = keyframes[segment_index + 1]
                segment_start = start_frame + int(round((end_frame - start_frame - 1) * float(first["at"])))
                segment_end = start_frame + int(round((end_frame - start_frame - 1) * float(second["at"])))
                segment_length = max(2, segment_end - segment_start + 1)
                delta_y = float(second["focusY"]) - float(first["focusY"])
                delta_max = max(
                    abs(float(second["zoom"]) - float(first["zoom"])),
                    abs(float(second["focusX"]) - float(first["focusX"])),
                    abs(delta_y),
                )
                if delta_y > 1e-7:
                    downward_segment_count += 1
                if delta_max < 1e-7:
                    stopped_segment_count += 1

                window = max(4, min(10, segment_length // 4))
                early_start = min(segment_end - 2, segment_start + 2)
                early_indices = list(range(early_start, min(segment_end, early_start + window) + 1))
                late_end = max(segment_start + 2, segment_end - 2)
                late_indices = list(range(max(segment_start, late_end - window), late_end + 1))
                early_steps = window_steps(capture, early_indices, masks.get(cut_id, [])) if len(early_indices) >= 2 else []
                late_steps = window_steps(capture, late_indices, masks.get(cut_id, [])) if len(late_indices) >= 2 else []
                early_speed = median_speed(early_steps)
                late_speed = median_speed(late_steps)
                speed_ratio = late_speed / max(early_speed, .03)
                terminal_stop = late_speed < .09

                expected_dx = float(second["focusX"]) - float(first["focusX"])
                expected_dy = float(second["focusY"]) - float(first["focusY"])
                median_dx = median_value(late_steps, "dxPixels")
                median_dy = median_value(late_steps, "dyPixels")
                direction_reversal = False
                if abs(expected_dx) > 1e-7 and abs(median_dx) > .05:
                    direction_reversal = math.copysign(1, median_dx) == math.copysign(1, expected_dx)
                if abs(expected_dy) > 1e-7 and abs(median_dy) > .05:
                    # Moving the crop focus upward makes rendered content move downward.
                    direction_reversal = direction_reversal or math.copysign(1, median_dy) == math.copysign(1, expected_dy)
                if abs(float(second["zoom"]) - float(first["zoom"])) > 1e-7 and late_steps:
                    scale_direction = float(np.median([step["scale"] - 1 for step in late_steps]))
                    expected_scale_direction = math.copysign(1, float(second["zoom"]) - float(first["zoom"]))
                    direction_reversal = direction_reversal or (
                        abs(scale_direction) > .00002
                        and math.copysign(1, scale_direction) != expected_scale_direction
                    )

                result = {
                    "cutId": cut_id,
                    "shotId": shot["id"],
                    "segmentIndex": segment_index,
                    "motion": shot["motion"],
                    "startFrame": segment_start,
                    "endFrame": segment_end,
                    "earlyValidPairCount": len(early_steps),
                    "lateValidPairCount": len(late_steps),
                    "earlyMedianMotionPixelsPerFrame": round(early_speed, 4),
                    "lateMedianMotionPixelsPerFrame": round(late_speed, 4),
                    "lateToEarlySpeedRatio": round(speed_ratio, 4),
                    "terminalStop": terminal_stop,
                    "directionReversal": direction_reversal,
                    "downwardAuthoredMotion": delta_y > 1e-7,
                }
                segment_results.append(result)

                for sample_index in [segment_start + 1, (segment_start + segment_end) // 2, segment_end - 1]:
                    frame = frame_at_index(capture, max(start_frame, min(end_frame - 1, sample_index)))
                    maximum_black_edge_ratio = max(maximum_black_edge_ratio, border_black_ratio(frame))

            for boundary_index in range(1, len(keyframes) - 1):
                boundary_frame = start_frame + int(round((end_frame - start_frame - 1) * float(keyframes[boundary_index]["at"])))
                indices = list(range(max(start_frame, boundary_frame - 5), min(end_frame, boundary_frame + 6)))
                steps = window_steps(capture, indices, masks.get(cut_id, []))
                speeds = [step["equivalentMotionPixels"] for step in steps]
                median = float(np.median(speeds)) if speeds else 0.0
                maximum = max(speeds, default=0.0)
                minimum = min(speeds, default=0.0)
                boundary_results.append({
                    "cutId": cut_id,
                    "shotId": shot["id"],
                    "boundaryIndex": boundary_index,
                    "frame": boundary_frame,
                    "validPairCount": len(steps),
                    "medianMotionPixelsPerFrame": round(median, 4),
                    "minimumMotionPixelsPerFrame": round(minimum, 4),
                    "maximumMotionPixelsPerFrame": round(maximum, 4),
                    "jumpRatio": round(maximum / max(median, .05), 4),
                    "stoppedAtBoundary": minimum < .07,
                    "resetJump": maximum > max(8.0, median * 4.5),
                })

            start_visual = frame_at_index(capture, min(end_frame - 1, start_frame + 2))
            middle_visual = frame_at_index(capture, min(end_frame - 1, (start_frame + end_frame) // 2))
            end_visual = frame_at_index(capture, max(start_frame, end_frame - 2))
            contact_cells.extend([
                label_frame(start_visual, f"{cut_id} {shot['id'][-24:]} START"),
                label_frame(middle_visual, f"{cut_id} {shot['motion'][:22]} MID"),
                label_frame(end_visual, f"{cut_id} {shot['motion'][:22]} END"),
            ])
            start_frame = end_frame
        capture.release()

    terminal_stop_count = sum(1 for row in segment_results if row["terminalStop"])
    direction_reversal_count = sum(1 for row in segment_results if row["directionReversal"])
    speed_ratio_failure_count = sum(
        1 for row in segment_results
        if row["earlyValidPairCount"] >= 2
        and row["lateValidPairCount"] >= 2
        and not (.85 <= row["lateToEarlySpeedRatio"] <= 1.15)
    )
    boundary_stop_count = sum(1 for row in boundary_results if row["stoppedAtBoundary"])
    reset_jump_count = sum(1 for row in boundary_results if row["resetJump"])
    black_edge_failure = maximum_black_edge_ratio > .12

    pass_value = all([
        repeated_image_count == 0,
        downward_segment_count == 0,
        stopped_segment_count == 0,
        non_linear_count == 0,
        terminal_stop_count == 0,
        direction_reversal_count == 0,
        speed_ratio_failure_count == 0,
        boundary_stop_count == 0,
        reset_jump_count == 0,
        not black_edge_failure,
    ])
    output = {
        "version": "v26-camera-frame-audit-r2",
        "pass": pass_value,
        "manifestPath": str(args.manifest.resolve()),
        "planPath": str(args.plan.resolve()),
        "cutDirectory": str(args.cut_dir.resolve()),
        "method": "Per-keyframe-segment early/late adjacent-frame affine tracking with all authored bubble bounds excluded.",
        "gates": {
            "repeatedImageShotCount": repeated_image_count,
            "downwardAuthoredSegmentCount": downward_segment_count,
            "authoredStoppedSegmentCount": stopped_segment_count,
            "nonLinearShotCount": non_linear_count,
            "terminalStopSegmentCount": terminal_stop_count,
            "directionReversalSegmentCount": direction_reversal_count,
            "speedRatioFailureCount": speed_ratio_failure_count,
            "combinationBoundaryStopCount": boundary_stop_count,
            "endpointResetJumpCount": reset_jump_count,
            "maximumBlackEdgeRatio": round(maximum_black_edge_ratio, 6),
            "blackEdgeFailure": black_edge_failure,
        },
        "segmentCount": len(segment_results),
        "combinationBoundaryCount": len(boundary_results),
        "segments": segment_results,
        "boundaries": boundary_results,
        "analyticViolations": analytic_violations,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.sheet.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    cv2.imwrite(str(args.sheet), padded_grid(contact_cells, 6), [cv2.IMWRITE_JPEG_QUALITY, 92])
    print(json.dumps({key: value for key, value in output.items() if key not in {"segments", "boundaries"}}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
