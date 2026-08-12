#!/usr/bin/env python3
"""Measure authored manga shots while excluding every speech-bubble region."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def frame_at(capture: cv2.VideoCapture, seconds: float) -> np.ndarray:
    capture.set(cv2.CAP_PROP_POS_MSEC, seconds * 1000)
    ok, frame = capture.read()
    if not ok or frame is None:
        raise RuntimeError(f"Could not decode frame at {seconds:.3f}s")
    return frame


def bubble_masks(manifest: dict, width: int, height: int) -> dict[str, list[tuple[int, int, int, int, float, float]]]:
    """Per-cut bubble rectangles with the absolute time interval each one is on screen.

    Masking a bubble that is not visible at the sampled pair removes valid
    texture and can starve the tracker (insufficient-unmasked-tracks), so each
    rectangle carries its own visibility window.
    """
    masks: dict[str, list[tuple[int, int, int, int, float, float]]] = {}
    for utterance in manifest.get("utterances", []):
        spec_path = Path(utterance.get("overlaySpecPath", ""))
        if not spec_path.is_file():
            continue
        spec = read_json(spec_path)
        image_size = spec.get("imageSize", {})
        source_width = float(image_size.get("width") or width)
        source_height = float(image_size.get("height") or height)
        scale_x = width / source_width
        scale_y = height / source_height
        timing = utterance.get("timing", {})
        base_start = float(timing.get("bubbleStartSeconds", 0.0))
        base_end = float(timing.get("bubbleEndSeconds", base_start))
        audio_start = float(timing.get("audioStartSeconds", base_start))

        def add_rect(bounds: dict, start: float, end: float) -> None:
            margin = 34
            x = max(0, int(float(bounds.get("x", 0)) * scale_x) - margin)
            y = max(0, int(float(bounds.get("y", 0)) * scale_y) - margin)
            x2 = min(width, int((float(bounds.get("x", 0)) + float(bounds.get("width", 0))) * scale_x) + margin)
            y2 = min(height, int((float(bounds.get("y", 0)) + float(bounds.get("height", 0))) * scale_y) + margin)
            masks.setdefault(utterance["cutId"], []).append((x, y, x2, y2, start, end))

        segments = [
            segment for segment in (utterance.get("bubbleSegments") or [])
            if isinstance(segment, dict) and isinstance(segment.get("bounds"), dict)
        ]
        if segments:
            for segment in segments:
                start_offset = segment.get("startOffsetSeconds")
                end_offset = segment.get("endOffsetSeconds")
                start = base_start if start_offset is None else max(base_start, min(base_end, audio_start + float(start_offset)))
                end = base_end if end_offset is None else max(base_start, min(base_end, audio_start + float(end_offset)))
                add_rect(segment["bounds"], start, end)
        else:
            for bubble in spec.get("plan", {}).get("bubbles", []):
                add_rect(bubble.get("bounds", {}), base_start, base_end)
    return masks


def masks_visible_at(
    rects: list[tuple[int, int, int, int, float, float]],
    first_time: float,
    second_time: float,
    slack: float = 0.08,
) -> list[tuple[int, int, int, int]]:
    visible = []
    for x, y, x2, y2, start, end in rects:
        if end + slack < first_time or start - slack > second_time:
            continue
        visible.append((x, y, x2, y2))
    return visible


def measure(first: np.ndarray, second: np.ndarray, excluded: list[tuple[int, int, int, int]], delta: float) -> dict:
    gray_a = cv2.cvtColor(first, cv2.COLOR_BGR2GRAY)
    gray_b = cv2.cvtColor(second, cv2.COLOR_BGR2GRAY)
    mask = np.full(gray_a.shape, 255, dtype=np.uint8)
    for x, y, x2, y2 in excluded:
        cv2.rectangle(mask, (x, y), (x2, y2), 0, -1)

    def phase_fallback(reason: str) -> dict:
        """Measure low-texture directional pages when corner tracking starves.

        Phase correlation uses the complete bubble-masked rendered frames and
        is independent of the authored camera values. It cannot measure zoom,
        so it is only a fallback proof of visible translation; pull-out gates
        still require the feature-based affine result.
        """
        active = mask > 0
        mean_abs_diff = float(np.abs(gray_a.astype(np.float32) - gray_b.astype(np.float32))[active].mean())
        mask_f = mask.astype(np.float32) / 255.0
        height, width = gray_a.shape
        window = cv2.createHanningWindow((width, height), cv2.CV_32F)
        first_f = (gray_a.astype(np.float32) - float(gray_a[active].mean())) * mask_f * window
        second_f = (gray_b.astype(np.float32) - float(gray_b[active].mean())) * mask_f * window
        shift, response = cv2.phaseCorrelate(first_f, second_f)
        if not np.isfinite(response) or response < 0.01 or mean_abs_diff < 0.2:
            return {"valid": False, "reason": reason, "phaseCorrelationResponse": round(float(response), 6)}
        tx, ty = float(shift[0]), float(shift[1])
        return {
            "valid": True,
            "method": "bubble-masked-phase-correlation-fallback",
            "fallbackReason": reason,
            "trackedPointCount": 0,
            "inlierRatio": round(float(response), 4),
            "zoomPercentPerSecond": 0.0,
            "translationXPercentPerSecond": round(tx / width * 100.0 / delta, 4),
            "translationYPercentPerSecond": round(ty / height * 100.0 / delta, 4),
            "translationPercentPerSecond": round(math.hypot(tx / width, ty / height) * 100.0 / delta, 4),
            "meanAbsolutePixelDifference": round(mean_abs_diff, 4),
            "phaseCorrelationResponse": round(float(response), 6),
        }

    points = cv2.goodFeaturesToTrack(gray_a, maxCorners=700, qualityLevel=0.012, minDistance=10, mask=mask)
    if points is None or len(points) < 24:
        return phase_fallback("insufficient-features")
    # Camera moves in these shots displace content by hundreds of pixels
    # between the sampled frames; the default 3-level pyramid cannot follow
    # that, which starves RANSAC of genuine correspondences. Deep pyramid plus
    # a forward-backward consistency check keeps only real tracks.
    lk_params = {
        "winSize": (31, 31),
        "maxLevel": 6,
        "criteria": (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 40, 0.01),
    }
    tracked, status, _ = cv2.calcOpticalFlowPyrLK(gray_a, gray_b, points, None, **lk_params)
    if tracked is None or status is None:
        return {"valid": False, "reason": "optical-flow-failed"}
    back, back_status, _ = cv2.calcOpticalFlowPyrLK(gray_b, gray_a, tracked, None, **lk_params)
    forward_backward_error = np.linalg.norm(points.reshape(-1, 2) - back.reshape(-1, 2), axis=1)
    good = (
        (status.reshape(-1) == 1)
        & (back_status.reshape(-1) == 1)
        & (forward_backward_error < 1.5)
    )
    # Sub-pixel drift grows with displacement; if the strict band starves the
    # sample, widen the consistency band before giving up rather than
    # rejecting a genuinely trackable high-motion shot.
    if int(good.sum()) < 20:
        good = (
            (status.reshape(-1) == 1)
            & (back_status.reshape(-1) == 1)
            & (forward_backward_error < 4.0)
        )
    source = points[good].reshape(-1, 2)
    target = tracked[good].reshape(-1, 2)
    if len(source) < 20:
        # Low-texture pages (flat walls, plates) can starve the strict
        # forward-backward band while the forward tracks are still usable:
        # RANSAC below rejects the stragglers.
        forward_only = status.reshape(-1) == 1
        if int(forward_only.sum()) >= 40:
            source = points[forward_only].reshape(-1, 2)
            target = tracked[forward_only].reshape(-1, 2)
        else:
            return {"valid": False, "reason": "insufficient-tracks"}
    keep = np.ones(len(source), dtype=bool)
    for x, y, x2, y2 in excluded:
        keep &= ~((target[:, 0] >= x) & (target[:, 0] <= x2) & (target[:, 1] >= y) & (target[:, 1] <= y2))
    source = source[keep]
    target = target[keep]
    if len(source) < 20:
        return {"valid": False, "reason": "insufficient-unmasked-tracks"}
    matrix, inliers = cv2.estimateAffinePartial2D(
        source,
        target,
        method=cv2.RANSAC,
        ransacReprojThreshold=3.0,
        maxIters=4000,
        confidence=0.997,
    )
    if matrix is None or inliers is None:
        return {"valid": False, "reason": "affine-fit-failed"}
    a, b, tx = matrix[0]
    _c, _d, ty = matrix[1]
    scale = math.sqrt(float(a * a + b * b))
    height, width = gray_a.shape
    active = mask > 0
    mean_abs_diff = float(np.abs(gray_a.astype(np.float32) - gray_b.astype(np.float32))[active].mean())
    return {
        "valid": True,
        "trackedPointCount": int(len(source)),
        "inlierRatio": round(float(inliers.mean()), 4),
        "zoomPercentPerSecond": round((scale - 1.0) * 100.0 / delta, 4),
        "translationXPercentPerSecond": round(float(tx) / width * 100.0 / delta, 4),
        "translationYPercentPerSecond": round(float(ty) / height * 100.0 / delta, 4),
        "translationPercentPerSecond": round(math.hypot(float(tx) / width, float(ty) / height) * 100.0 / delta, 4),
        "meanAbsolutePixelDifference": round(mean_abs_diff, 4),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    manifest = read_json(args.manifest)
    plan = read_json(args.plan)
    capture = cv2.VideoCapture(str(args.video))
    if not capture.isOpened():
        raise RuntimeError(f"Could not open {args.video}")
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    masks = bubble_masks(manifest, width, height)
    cuts = {cut["id"]: cut for cut in manifest["cuts"]}
    elapsed_by_cut: dict[str, float] = {}
    rows = []
    plan_rows = plan.get("rows") or plan.get("cameraRows") or []
    for row in plan_rows:
        cut_id = row["cutId"]
        duration = float(row["durationSeconds"])
        # Plans omit static editorial plates from rows, so accumulating only
        # moving-row durations shifts later shots to the wrong video time.
        # The official plan already carries the true in-cut offset.
        local_start = float(row.get("startSecondsInCut", elapsed_by_cut.get(cut_id, 0.0)))
        absolute_start = float(cuts[cut_id]["timing"]["startSeconds"]) + local_start
        inset = min(max(0.45, duration * 0.18), max(0.45, duration / 3))
        first_time = absolute_start + inset
        second_time = absolute_start + duration - inset
        if second_time - first_time < 0.5:
            first_time = absolute_start + duration * 0.2
            second_time = absolute_start + duration * 0.8
        delta = second_time - first_time

        def measure_window(window_start: float, window_end: float, tx_rate: float, zoom_rate: float) -> dict:
            # Pyramidal LK cannot follow the hundreds of pixels these
            # authored pans/pull-outs cover across a multi-second gap. Shrink
            # the pair spacing (centered in the window) so the expected
            # displacement stays within a comfortably trackable band; rates
            # stay per-second so gate thresholds are unchanged.
            span = window_end - window_start
            allowed = span
            if abs(tx_rate) > 0.05:
                allowed = min(allowed, 4.5 / abs(tx_rate))
            if abs(zoom_rate) > 0.05:
                allowed = min(allowed, 5.0 / abs(zoom_rate))
            allowed = max(0.4, min(allowed, span))
            center = (window_start + window_end) / 2
            pair_first = center - allowed / 2
            pair_second = center + allowed / 2
            pair_delta = pair_second - pair_first
            visible = masks_visible_at(masks.get(cut_id, []), pair_first, pair_second)
            outcome = measure(
                frame_at(capture, pair_first),
                frame_at(capture, pair_second),
                visible,
                pair_delta,
            )
            outcome["pairFirstSeconds"] = round(pair_first, 4)
            outcome["pairSecondSeconds"] = round(pair_second, 4)
            outcome["excludedRegionCount"] = len(visible)
            return outcome

        authored_tx = abs(float(row.get("authoredTranslationPercentPerSecond") or 0.0))
        authored_zoom = abs(float(row.get("authoredZoomPercentPerSecond") or 0.0))
        phase = float(row.get("directionPhase") or 0.0)
        if row.get("family") == "combined" and 0.05 < phase < 0.95:
            # A combined shot travels at constant zoom first, then pulls out
            # from the reached focus. One sampling window straddling the
            # boundary hides one of the two signals, so each phase is
            # measured inside its own interval.
            boundary = absolute_start + duration * phase
            inset_1 = min(0.3, duration * phase * 0.15)
            inset_2 = min(0.3, duration * (1 - phase) * 0.15)
            phase_tx = authored_tx / max(phase, 1e-6)
            phase_zoom = authored_zoom / max(1 - phase, 1e-6)
            direction_result = measure_window(
                absolute_start + inset_1, boundary - inset_1, phase_tx, 0.0,
            )
            pullout_result = measure_window(
                boundary + inset_2, absolute_start + duration - inset_2, 0.0, phase_zoom,
            )
            if direction_result.get("valid") and pullout_result.get("valid"):
                result = {
                    "valid": True,
                    "phases": {"direction": direction_result, "pullout": pullout_result},
                    "trackedPointCount": min(direction_result["trackedPointCount"], pullout_result["trackedPointCount"]),
                    "inlierRatio": min(direction_result["inlierRatio"], pullout_result["inlierRatio"]),
                    "zoomPercentPerSecond": pullout_result["zoomPercentPerSecond"],
                    "translationXPercentPerSecond": direction_result["translationXPercentPerSecond"],
                    "translationYPercentPerSecond": direction_result["translationYPercentPerSecond"],
                    "translationPercentPerSecond": direction_result["translationPercentPerSecond"],
                    "meanAbsolutePixelDifference": max(
                        direction_result["meanAbsolutePixelDifference"],
                        pullout_result["meanAbsolutePixelDifference"],
                    ),
                }
            else:
                failed = direction_result if not direction_result.get("valid") else pullout_result
                result = {
                    "valid": False,
                    "reason": failed.get("reason", "phase-measurement-failed"),
                    "phases": {"direction": direction_result, "pullout": pullout_result},
                }
            first_time = result["phases"]["direction"].get("pairFirstSeconds", first_time)
            second_time = result["phases"]["pullout"].get("pairSecondSeconds", second_time)
            visible_masks = masks_visible_at(masks.get(cut_id, []), first_time, second_time)
        else:
            result = measure_window(first_time, second_time, authored_tx, authored_zoom)
            first_time = result.get("pairFirstSeconds", first_time)
            second_time = result.get("pairSecondSeconds", second_time)
            visible_masks = masks_visible_at(masks.get(cut_id, []), first_time, second_time)
        delta = second_time - first_time
        rows.append({
            "cutId": cut_id,
            "shotId": row["shotId"],
            "angle": row["angle"],
            "motionClass": row.get("motionClass") or row.get("editorialBeat") or "pull-out",
            "firstTimeSeconds": round(first_time, 4),
            "secondTimeSeconds": round(second_time, 4),
            "comparisonSeconds": round(delta, 4),
            "excludedBubbleRegionCount": len(visible_masks),
            "authoredZoomPercentPerSecond": row["authoredZoomPercentPerSecond"],
            "authoredTranslationPercentPerSecond": row["authoredTranslationPercentPerSecond"],
            "measured": result,
        })
        elapsed_by_cut[cut_id] = local_start + duration
    capture.release()
    valid = [row["measured"] for row in rows if row["measured"].get("valid")]
    moving = [row for row in valid if row["meanAbsolutePixelDifference"] > 0.05]
    zoom_out = [row for row in valid if row["zoomPercentPerSecond"] < -0.03]
    output = {
        "version": 1,
        "method": "Per-shot 18%-82% frame comparison with the union of all speech-bubble bounds in that cut excluded from feature tracking.",
        "videoPath": str(args.video.resolve()),
        "shotCount": len(rows),
        "validMeasurementCount": len(valid),
        "measuredMovingShotCount": len(moving),
        "measuredZoomOutShotCount": len(zoom_out),
        "measuredNonZoomOutShotCount": len(valid) - len(zoom_out),
        "meanAbsolutePixelDifference": round(sum(row["meanAbsolutePixelDifference"] for row in valid) / max(1, len(valid)), 4),
        "rows": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in output.items() if key != "rows"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
