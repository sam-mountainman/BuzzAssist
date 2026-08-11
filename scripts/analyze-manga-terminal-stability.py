#!/usr/bin/env python3
"""Audit terminal camera motion and build visual camera-proof sheets."""

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
            margin = 42
            x = max(0, int(float(bounds.get("x", 0)) * scale_x) - margin)
            y = max(0, int(float(bounds.get("y", 0)) * scale_y) - margin)
            x2 = min(width, int((float(bounds.get("x", 0)) + float(bounds.get("width", 0))) * scale_x) + margin)
            y2 = min(height, int((float(bounds.get("y", 0)) + float(bounds.get("height", 0))) * scale_y) + margin)
            masks.setdefault(utterance["cutId"], []).append((x, y, x2, y2))
    return masks


def affine_step(first: np.ndarray, second: np.ndarray, excluded: list[tuple[int, int, int, int]]) -> dict:
    gray_a = cv2.cvtColor(first, cv2.COLOR_BGR2GRAY)
    gray_b = cv2.cvtColor(second, cv2.COLOR_BGR2GRAY)
    mask = np.full(gray_a.shape, 255, dtype=np.uint8)
    for x, y, x2, y2 in excluded:
        cv2.rectangle(mask, (x, y), (x2, y2), 0, -1)
    points = cv2.goodFeaturesToTrack(gray_a, maxCorners=900, qualityLevel=0.009, minDistance=8, mask=mask)
    if points is None or len(points) < 30:
        return {"valid": False, "reason": "insufficient-features"}
    tracked, status, _ = cv2.calcOpticalFlowPyrLK(gray_a, gray_b, points, None)
    if tracked is None or status is None:
        return {"valid": False, "reason": "optical-flow-failed"}
    source = points[status.reshape(-1) == 1].reshape(-1, 2)
    target = tracked[status.reshape(-1) == 1].reshape(-1, 2)
    keep = np.ones(len(source), dtype=bool)
    for x, y, x2, y2 in excluded:
        keep &= ~((target[:, 0] >= x) & (target[:, 0] <= x2) & (target[:, 1] >= y) & (target[:, 1] <= y2))
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
    a, b, tx = matrix[0]
    _c, _d, ty = matrix[1]
    scale = math.sqrt(float(a * a + b * b))
    return {
        "valid": True,
        "scale": float(scale),
        "dxPixels": float(tx),
        "dyPixels": float(ty),
        "travelPixels": float(math.hypot(float(tx), float(ty))),
        "inlierRatio": float(inliers.mean()),
    }


def label_frame(frame: np.ndarray, label: str, width: int, height: int) -> np.ndarray:
    resized = cv2.resize(frame, (width, height), interpolation=cv2.INTER_AREA)
    bar = np.zeros((28, width, 3), dtype=np.uint8)
    cv2.putText(bar, label, (7, 19), cv2.FONT_HERSHEY_SIMPLEX, 0.46, (245, 245, 245), 1, cv2.LINE_AA)
    return np.vstack([resized, bar])


def padded_grid(cells: list[np.ndarray], columns: int) -> np.ndarray:
    if not cells:
        raise RuntimeError("No contact-sheet cells")
    blank = np.zeros_like(cells[0])
    while len(cells) % columns:
        cells.append(blank.copy())
    return np.vstack([
        np.hstack(cells[index:index + columns])
        for index in range(0, len(cells), columns)
    ])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--cut-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--camera-sheet", type=Path)
    parser.add_argument("--terminal-sheet", type=Path)
    args = parser.parse_args()

    manifest = read_json(args.manifest)
    plan = read_json(args.plan)
    rows = plan.get("cameraRows") or plan.get("rows") or []
    cuts = {cut["id"]: cut for cut in manifest["cuts"]}
    master_capture = cv2.VideoCapture(str(args.video))
    if not master_capture.isOpened():
        raise RuntimeError(f"Could not open {args.video}")
    fps = float(manifest.get("video", {}).get("fps") or master_capture.get(cv2.CAP_PROP_FPS))
    width = int(master_capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(master_capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    master_capture.release()
    masks = bubble_masks(manifest, width, height)
    last_shot_by_cut = {row["cutId"]: row["shotId"] for row in rows}
    frame_by_cut: dict[str, int] = {}
    captures: dict[str, cv2.VideoCapture] = {}
    results: list[dict] = []
    camera_cells: list[np.ndarray] = []
    representative_rows: dict[str, tuple[dict, int, int]] = {}

    for row in rows:
        cut_id = row["cutId"]
        duration = float(row["durationSeconds"])
        if cut_id not in captures:
            cut_path = args.cut_dir / f"{cut_id}.mp4"
            captures[cut_id] = cv2.VideoCapture(str(cut_path))
            if not captures[cut_id].isOpened():
                raise RuntimeError(f"Could not open rendered cut {cut_path}")
        capture = captures[cut_id]
        cut_frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        start_frame = frame_by_cut.get(cut_id, 0)
        shot_frame_count = max(1, int(math.ceil(duration * fps)))
        end_frame = min(cut_frame_count, start_frame + shot_frame_count)
        # FFmpeg's duration trim may assign the boundary frame to either side
        # of a concatenated shot. Stay two frames inside non-final shots so a
        # deliberate edit is never misreported as terminal camera overshoot.
        audit_end_frame = end_frame if last_shot_by_cut[cut_id] == row["shotId"] else max(start_frame + 2, end_frame - 2)
        terminal_start = max(start_frame, audit_end_frame - 10)
        frames = [frame_at_index(capture, index) for index in range(terminal_start, audit_end_frame)]
        steps = [affine_step(frames[index], frames[index + 1], masks.get(cut_id, [])) for index in range(len(frames) - 1)]
        valid = [step for step in steps if step.get("valid")]
        median_dx = float(np.median([step["dxPixels"] for step in valid])) if valid else 0.0
        median_dy = float(np.median([step["dyPixels"] for step in valid])) if valid else 0.0
        median_travel = float(np.median([step["travelPixels"] for step in valid])) if valid else 0.0
        scale_reversals = sum(1 for step in valid if step["scale"] > 1.00035)
        direction_reversals = 0
        median_vector_length = math.hypot(median_dx, median_dy)
        if median_vector_length > 0.04:
            for step in valid:
                dot = step["dxPixels"] * median_dx + step["dyPixels"] * median_dy
                cosine = dot / max(step["travelPixels"] * median_vector_length, 1e-6)
                if step["travelPixels"] > max(0.25, median_travel * 1.5) and cosine < -0.5:
                    direction_reversals += 1
        max_travel = max((step["travelPixels"] for step in valid), default=0.0)
        jump_ratio = max_travel / max(median_travel, 0.12)
        terminal_jump = bool(max_travel > 2.25 and jump_ratio > 5.0)
        terminal_overshoot = bool(scale_reversals or direction_reversals)
        jitter_failure = bool(terminal_overshoot or terminal_jump)
        result = {
            "cutId": cut_id,
            "shotId": row["shotId"],
            "angleFamily": row.get("angleFamily") or row.get("angle"),
            "cameraMode": row.get("cameraMode") or row.get("viewMode"),
            "editorialPurpose": row.get("editorialPurpose"),
            "startFrame": start_frame,
            "endFrameExclusive": end_frame,
            "auditEndFrameExclusive": audit_end_frame,
            "terminalPairCount": len(steps),
            "validTerminalPairCount": len(valid),
            "scaleReversalCount": scale_reversals,
            "directionReversalCount": direction_reversals,
            "medianTravelPixelsPerFrame": round(median_travel, 4),
            "maxTravelPixelsPerFrame": round(max_travel, 4),
            "terminalJumpRatio": round(jump_ratio, 4),
            "terminalOvershoot": terminal_overshoot,
            "jitterFailure": jitter_failure,
        }
        results.append(result)

        first = frame_at_index(capture, min(end_frame - 1, start_frame + 2))
        last = frame_at_index(capture, max(start_frame, audit_end_frame - 1))
        pair = np.hstack([
            cv2.resize(first, (224, 126), interpolation=cv2.INTER_AREA),
            cv2.resize(last, (224, 126), interpolation=cv2.INTER_AREA),
        ])
        mode = str(row.get("cameraMode") or row.get("viewMode") or "")
        camera_cells.append(label_frame(pair, f"{cut_id} {mode}  start -> end", 448, 126))

        representative_key = (
            "combined-right" if mode == "pullout-plus-right" else
            "combined-top" if mode == "pullout-plus-top" else
            "left-only" if mode == "left-only" else
            "right-only" if mode == "right-only" else
            "top-only" if mode == "top-only" else
            "pullout-only" if mode == "pullout-only" else ""
        )
        if representative_key and representative_key not in representative_rows:
            representative_rows[representative_key] = (row, terminal_start, audit_end_frame)
        frame_by_cut[cut_id] = end_frame

    combination_count = sum(
        1 for row in rows
        if str(row.get("cameraMode") or row.get("viewMode") or "").startswith("pullout-plus-")
        or str(row.get("viewMode") or "").startswith(("right-to-left", "left-to-right"))
    )
    overshoot_count = sum(1 for row in results if row["terminalOvershoot"])
    jitter_count = sum(1 for row in results if row["jitterFailure"])
    output = {
        "version": 1,
        "method": "Nine adjacent terminal frame pairs per shot; union of speech-bubble bounds excluded from RANSAC affine tracking.",
        "videoPath": str(args.video.resolve()),
        "shotCount": len(rows),
        "singleModeShotCount": len(rows) - combination_count,
        "semanticCombinationShotCount": combination_count,
        "terminalOvershootShotCount": overshoot_count,
        "jitterFailureShotCount": jitter_count,
        "cameraOversample": manifest.get("video", {}).get("cameraOversample"),
        "rows": results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if args.camera_sheet:
        args.camera_sheet.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(args.camera_sheet), padded_grid(camera_cells, 4), [cv2.IMWRITE_JPEG_QUALITY, 91])

    if args.terminal_sheet:
        terminal_cells: list[np.ndarray] = []
        for key in ["left-only", "right-only", "top-only", "pullout-only", "combined-right", "combined-top"]:
            if key not in representative_rows:
                continue
            row, terminal_start, end_frame = representative_rows[key]
            capture = captures[row["cutId"]]
            indices = list(range(max(terminal_start, end_frame - 6), end_frame))
            frames = [cv2.resize(frame_at_index(capture, index), (240, 135), interpolation=cv2.INTER_AREA) for index in indices]
            strip = np.hstack(frames)
            mode = row.get("cameraMode") or row.get("viewMode") or ""
            terminal_cells.append(label_frame(strip, f"{key}: {row['cutId']} {mode}", strip.shape[1], 135))
        args.terminal_sheet.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(args.terminal_sheet), np.vstack(terminal_cells), [cv2.IMWRITE_JPEG_QUALITY, 93])

    for capture in captures.values():
        capture.release()
    print(json.dumps({key: value for key, value in output.items() if key != "rows"}, ensure_ascii=False, indent=2))
    if overshoot_count or jitter_count:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
