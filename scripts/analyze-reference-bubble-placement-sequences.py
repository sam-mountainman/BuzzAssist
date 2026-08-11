#!/usr/bin/env python3
"""Measure consecutive speech-bubble placement in full reference videos.

The detector is deliberately conservative.  It looks for persistent, bright,
ink-bearing overlay regions and then tracks them through time.  Stable runs are
treated as observed bubble/card placements; all derived labels remain
heuristics and the report keeps that caveat explicit.
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np


def clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, value))


def percentile(values: list[float], value: float) -> float | None:
    if not values:
        return None
    return round(float(np.percentile(np.asarray(values, dtype=np.float64), value)), 4)


def distribution(values: list[float]) -> dict:
    if not values:
        return {"count": 0, "mean": None, "median": None, "p10": None, "p25": None, "p75": None, "p90": None}
    return {
        "count": len(values),
        "mean": round(statistics.fmean(values), 4),
        "median": round(statistics.median(values), 4),
        "p10": percentile(values, 10),
        "p25": percentile(values, 25),
        "p75": percentile(values, 75),
        "p90": percentile(values, 90),
    }


def iou(first: dict, second: dict) -> float:
    left = max(first["x"], second["x"])
    top = max(first["y"], second["y"])
    right = min(first["x"] + first["width"], second["x"] + second["width"])
    bottom = min(first["y"] + first["height"], second["y"] + second["height"])
    intersection = max(0.0, right - left) * max(0.0, bottom - top)
    union = first["width"] * first["height"] + second["width"] * second["height"] - intersection
    return intersection / union if union > 0 else 0.0


def center(rect: dict) -> tuple[float, float]:
    return rect["x"] + rect["width"] / 2, rect["y"] + rect["height"] / 2


def center_distance(first: dict, second: dict) -> float:
    ax, ay = center(first)
    bx, by = center(second)
    return math.hypot(ax - bx, ay - by)


def lane(rect: dict) -> str:
    x, _ = center(rect)
    if x < 0.38:
        return "left"
    if x > 0.62:
        return "right"
    return "center"


def band(rect: dict) -> str:
    _, y = center(rect)
    if y < 0.38:
        return "upper"
    if y > 0.68:
        return "lower"
    return "middle"


def classify(rect: dict) -> str:
    rectangular = rect["extent"] >= 0.86 and rect["solidity"] >= 0.93
    return "narration-card" if rectangular else "speech-bubble"


def candidate_score(candidate: dict) -> float:
    aspect = candidate["width"] / max(candidate["height"], 1e-6)
    tall_affinity = 1.0 - min(1.0, abs(aspect - 0.42) / 0.9)
    ink_affinity = 1.0 - min(1.0, abs(candidate["inkRatio"] - 0.105) / 0.16)
    return (
        candidate["extent"] * 1.1
        + candidate["solidity"] * 0.75
        + ink_affinity * 0.9
        + tall_affinity * 0.45
        + min(candidate["areaRatio"] / 0.05, 1.0) * 0.25
    )


def bubble_candidates(frame: np.ndarray) -> list[dict]:
    source_height, source_width = frame.shape[:2]
    scale = min(1.0, 960.0 / source_width)
    image = cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else frame
    height, width = image.shape[:2]
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    bright = cv2.inRange(hsv, np.array([0, 0, 214]), np.array([179, 72, 255]))
    kernel_size = max(5, int(round(min(width, height) * 0.011)) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    closed = cv2.morphologyEx(bright, cv2.MORPH_CLOSE, kernel, iterations=2)
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    frame_area = float(width * height)
    results = []
    for contour in contours:
        contour_area = cv2.contourArea(contour)
        x, y, candidate_width, candidate_height = cv2.boundingRect(contour)
        box_area = float(candidate_width * candidate_height)
        area_ratio = contour_area / frame_area
        width_ratio = candidate_width / width
        height_ratio = candidate_height / height
        aspect = width_ratio / max(height_ratio, 1e-6)
        extent = contour_area / max(box_area, 1.0)
        hull_area = cv2.contourArea(cv2.convexHull(contour))
        solidity = contour_area / max(hull_area, 1.0)
        if not 0.0035 <= area_ratio <= 0.19:
            continue
        if not 0.045 <= width_ratio <= 0.40 or not 0.075 <= height_ratio <= 0.77:
            continue
        if not 0.13 <= aspect <= 2.20 or extent < 0.47 or solidity < 0.72:
            continue

        inset_x = max(2, int(candidate_width * 0.07))
        inset_y = max(2, int(candidate_height * 0.04))
        patch = gray[y + inset_y:y + candidate_height - inset_y, x + inset_x:x + candidate_width - inset_x]
        if patch.size == 0:
            continue
        ink_ratio = float((patch < 104).mean())
        midtone_ratio = float((patch < 178).mean())
        if not 0.012 <= ink_ratio <= 0.31 or midtone_ratio > 0.48:
            continue

        candidate = {
            "x": round(x / width, 5),
            "y": round(y / height, 5),
            "width": round(width_ratio, 5),
            "height": round(height_ratio, 5),
            "areaRatio": round(area_ratio, 5),
            "extent": round(float(extent), 5),
            "solidity": round(float(solidity), 5),
            "inkRatio": round(ink_ratio, 5),
        }
        candidate["score"] = round(candidate_score(candidate), 5)
        results.append(candidate)
    return sorted(results, key=lambda item: item["score"], reverse=True)[:6]


@dataclass
class Track:
    track_id: int
    observations: list[dict] = field(default_factory=list)
    last_sample: int = -1

    def add(self, observation: dict, sample_index: int) -> None:
        self.observations.append(observation)
        self.last_sample = sample_index

    @property
    def last(self) -> dict:
        return self.observations[-1]


def median_rect(observations: list[dict]) -> dict:
    keys = ["x", "y", "width", "height", "extent", "solidity", "inkRatio", "areaRatio", "score"]
    return {key: round(statistics.median(item[key] for item in observations), 5) for key in keys}


def timestamp(seconds: float) -> str:
    total = max(0, int(round(seconds)))
    return f"{total // 3600:02d}:{(total % 3600) // 60:02d}:{total % 60:02d}"


def draw_event(frame: np.ndarray, event: dict) -> np.ndarray:
    output = frame.copy()
    height, width = output.shape[:2]
    rect = event["bounds"]
    x1, y1 = int(rect["x"] * width), int(rect["y"] * height)
    x2, y2 = int((rect["x"] + rect["width"]) * width), int((rect["y"] + rect["height"]) * height)
    cv2.rectangle(output, (x1, y1), (x2, y2), (40, 220, 40), max(2, width // 640))
    label = f'{event["eventIndex"]:03d} {event["timecode"]} {event["lane"]}/{event["band"]}'
    cv2.rectangle(output, (0, 0), (min(width, 640), 42), (0, 0, 0), -1)
    cv2.putText(output, label, (12, 29), cv2.FONT_HERSHEY_SIMPLEX, 0.72, (255, 255, 255), 2, cv2.LINE_AA)
    return output


def contact_sheet(images: list[np.ndarray], output_path: Path, columns: int = 5) -> None:
    if not images:
        return
    thumb_width, thumb_height = 320, 180
    rows = math.ceil(len(images) / columns)
    sheet = np.zeros((rows * thumb_height, columns * thumb_width, 3), dtype=np.uint8)
    for index, image in enumerate(images):
        thumb = cv2.resize(image, (thumb_width, thumb_height), interpolation=cv2.INTER_AREA)
        row, column = divmod(index, columns)
        sheet[row * thumb_height:(row + 1) * thumb_height, column * thumb_width:(column + 1) * thumb_width] = thumb
    cv2.imwrite(str(output_path), sheet, [cv2.IMWRITE_JPEG_QUALITY, 94])


def analyze_video(video_path: Path, sample_seconds: float, min_run_seconds: float, output_dir: Path) -> dict:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError(f"Could not open {video_path}")
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 30)
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = frame_count / fps if frame_count else 0
    sample_count = max(1, int(math.floor(duration / sample_seconds)))
    tracks: list[Track] = []
    next_track_id = 1
    sampled_frames: dict[int, np.ndarray] = {}

    for sample_index in range(sample_count):
        seconds = min(duration - 0.03, (sample_index + 0.5) * sample_seconds)
        capture.set(cv2.CAP_PROP_POS_MSEC, seconds * 1000)
        ok, frame = capture.read()
        if not ok or frame is None:
            continue
        candidates = bubble_candidates(frame)
        if candidates:
            sampled_frames[sample_index] = frame
        available_tracks = [track for track in tracks if sample_index - track.last_sample <= 2]
        pairs = []
        for candidate_index, candidate in enumerate(candidates):
            for track in available_tracks:
                overlap = iou(candidate, track.last)
                distance = center_distance(candidate, track.last)
                if overlap >= 0.38 or distance <= 0.035:
                    pairs.append((overlap - distance * 0.7, candidate_index, track))
        assigned_candidates: set[int] = set()
        assigned_tracks: set[int] = set()
        for _, candidate_index, track in sorted(pairs, reverse=True, key=lambda item: item[0]):
            if candidate_index in assigned_candidates or track.track_id in assigned_tracks:
                continue
            track.add({**candidates[candidate_index], "sampleIndex": sample_index, "seconds": seconds}, sample_index)
            assigned_candidates.add(candidate_index)
            assigned_tracks.add(track.track_id)
        for candidate_index, candidate in enumerate(candidates):
            if candidate_index in assigned_candidates:
                continue
            track = Track(next_track_id)
            next_track_id += 1
            track.add({**candidate, "sampleIndex": sample_index, "seconds": seconds}, sample_index)
            tracks.append(track)

    capture.release()
    minimum_observations = max(2, math.ceil(min_run_seconds / sample_seconds))
    stable = []
    for track in tracks:
        if len(track.observations) < minimum_observations:
            continue
        sample_indices = [item["sampleIndex"] for item in track.observations]
        span = sample_indices[-1] - sample_indices[0] + 1
        if len(track.observations) / span < 0.58:
            continue
        bounds = median_rect(track.observations)
        stable.append({
            "trackId": track.track_id,
            "startSample": sample_indices[0],
            "endSample": sample_indices[-1],
            "startSeconds": round(track.observations[0]["seconds"], 3),
            "endSeconds": round(track.observations[-1]["seconds"], 3),
            "observationCount": len(track.observations),
            "bounds": bounds,
            "type": classify(bounds),
            "score": bounds["score"],
        })

    # Merge short detector dropouts that resolve back to the same overlay.
    merged = []
    for item in sorted(stable, key=lambda row: (row["startSample"], -row["score"])):
        match = next((previous for previous in reversed(merged[-8:]) if (
            item["startSample"] - previous["endSample"] <= max(5, int(round(2.4 / sample_seconds)))
            and iou(item["bounds"], previous["bounds"]) >= 0.68
        )), None)
        if match:
            match["endSample"] = max(match["endSample"], item["endSample"])
            match["endSeconds"] = max(match["endSeconds"], item["endSeconds"])
            match["observationCount"] += item["observationCount"]
        else:
            merged.append(item)

    # An event is a newly appearing placement.  Simultaneous candidates are
    # retained, while obvious nested duplicates are removed.
    events = []
    for item in sorted(merged, key=lambda row: (row["startSample"], -row["score"])):
        if any(
            abs(item["startSample"] - event["startSample"]) <= 1
            and iou(item["bounds"], event["bounds"]) >= 0.44
            for event in events[-5:]
        ):
            continue
        rect = item["bounds"]
        event = {
            **item,
            "eventIndex": len(events) + 1,
            "timecode": timestamp(item["startSeconds"]),
            "lane": lane(rect),
            "band": band(rect),
            "center": {"x": round(center(rect)[0], 4), "y": round(center(rect)[1], 4)},
        }
        events.append(event)

    transitions = []
    for previous, current in zip(events, events[1:]):
        # Events beginning together are multiple balloons in one frame, not a
        # sequential editorial choice.
        if current["startSample"] - previous["startSample"] <= 1:
            continue
        distance = center_distance(previous["bounds"], current["bounds"])
        transitions.append({
            "fromEvent": previous["eventIndex"],
            "toEvent": current["eventIndex"],
            "gapSeconds": round(current["startSeconds"] - previous["endSeconds"], 3),
            "centerDistance": round(distance, 4),
            "laneChanged": previous["lane"] != current["lane"],
            "bandChanged": previous["band"] != current["band"],
            "samePocket": previous["lane"] == current["lane"] and previous["band"] == current["band"],
            "nearRepeat08": distance < 0.08,
            "nearRepeat12": distance < 0.12,
            "fromType": previous["type"],
            "toType": current["type"],
        })

    proof_images = []
    for event in events[:120]:
        frame = sampled_frames.get(event["startSample"])
        if frame is not None:
            proof_images.append(draw_event(frame, event))
    proof_path = output_dir / f"{video_path.stem}-placement-events.jpg"
    contact_sheet(proof_images, proof_path)
    return {
        "videoPath": str(video_path.resolve()),
        "durationSeconds": round(duration, 3),
        "sampleIntervalSeconds": sample_seconds,
        "sampleCount": sample_count,
        "minimumStableRunSeconds": min_run_seconds,
        "stableTrackCount": len(merged),
        "eventCount": len(events),
        "events": events,
        "transitions": transitions,
        "proofContactSheetPath": str(proof_path.resolve()),
    }


def summarize(videos: list[dict]) -> dict:
    events = [event for video in videos for event in video["events"]]
    transitions = [transition for video in videos for transition in video["transitions"]]
    distances = [transition["centerDistance"] for transition in transitions]
    meaningful = [transition for transition in transitions if transition["centerDistance"] >= 0.08]
    narration = [transition for transition in transitions if transition["fromType"] == "narration-card" or transition["toType"] == "narration-card"]
    ratio = lambda numerator, denominator: round(numerator / denominator, 4) if denominator else None
    return {
        "sampledVideoCount": len(videos),
        "observedPlacementEventCount": len(events),
        "observedSequentialTransitionCount": len(transitions),
        "centerDistance": distribution(distances),
        "centerDistanceExcludingNearRepeats": distribution([item["centerDistance"] for item in meaningful]),
        "laneChangeRate": ratio(sum(item["laneChanged"] for item in transitions), len(transitions)),
        "bandChangeRate": ratio(sum(item["bandChanged"] for item in transitions), len(transitions)),
        "samePocketRate": ratio(sum(item["samePocket"] for item in transitions), len(transitions)),
        "nearRepeatRateBelow08": ratio(sum(item["nearRepeat08"] for item in transitions), len(transitions)),
        "nearRepeatRateBelow12": ratio(sum(item["nearRepeat12"] for item in transitions), len(transitions)),
        "narrationTransitionCount": len(narration),
        "narrationSamePocketRate": ratio(sum(item["samePocket"] for item in narration), len(narration)),
        "observedLaneCounts": {name: sum(event["lane"] == name for event in events) for name in ["left", "center", "right"]},
        "observedBandCounts": {name: sum(event["band"] == name for event in events) for name in ["upper", "middle", "lower"]},
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("videos", nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--sample-seconds", type=float, default=0.4)
    parser.add_argument("--min-run-seconds", type=float, default=0.8)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    videos = [analyze_video(path.resolve(), args.sample_seconds, args.min_run_seconds, args.output.parent) for path in args.videos]
    report = {
        "version": "reference-bubble-placement-sequence-v1",
        "method": {
            "scope": "Both supplied reference videos, sampled across their full durations.",
            "detector": "Persistent bright low-saturation regions containing dark ink, tracked by IoU and normalized center distance.",
            "caveat": "Candidate identity and bubble/card classification are heuristic. Contact sheets are emitted for visual review; derived thresholds use robust distributions rather than treating every detection as ground truth.",
        },
        "videos": videos,
        "summary": summarize(videos),
    }
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"output": str(args.output.resolve()), "summary": report["summary"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
