#!/usr/bin/env python3
"""Render one proof frame for every visible V29 bubble/segment."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--video", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    cuts = {cut["id"]: cut for cut in manifest["cuts"]}
    samples = []
    for utterance in manifest["utterances"]:
        timing = utterance["timing"]
        cut_start = float(cuts[utterance["cutId"]]["timing"]["startSeconds"])
        bubble_start = float(timing["bubbleStartInCutSeconds"])
        bubble_end = float(timing["bubbleEndInCutSeconds"])
        audio_start = float(timing["audioStartInCutSeconds"])
        segments = utterance.get("bubbleSegments") or []
        if segments:
            for segment in segments:
                start = max(bubble_start, audio_start + float(segment["startOffsetSeconds"]))
                end = min(bubble_end, audio_start + float(segment["endOffsetSeconds"]))
                samples.append({
                    "id": segment["id"],
                    "seconds": cut_start + (start + end) / 2,
                    "bounds": segment["bounds"],
                    "width": 1672,
                    "height": 941,
                })
        else:
            spec = json.loads(Path(utterance["overlaySpecPath"]).read_text())
            bounds = spec["plan"]["bubbles"][0]["bounds"]
            samples.append({
                "id": utterance["id"],
                "seconds": cut_start + (bubble_start + bubble_end) / 2,
                "bounds": bounds,
                "width": float(spec.get("imageSize", {}).get("width", 1672)),
                "height": float(spec.get("imageSize", {}).get("height", 941)),
            })

    capture = cv2.VideoCapture(str(args.video))
    if not capture.isOpened():
        raise RuntimeError(f"Could not open {args.video}")
    thumbs = []
    for index, sample in enumerate(samples, start=1):
        capture.set(cv2.CAP_PROP_POS_MSEC, sample["seconds"] * 1000)
        ok, frame = capture.read()
        if not ok or frame is None:
            raise RuntimeError(f"Could not read {sample['id']} at {sample['seconds']:.3f}s")
        height, width = frame.shape[:2]
        bounds = sample["bounds"]
        x1 = int(float(bounds["x"]) / sample["width"] * width)
        y1 = int(float(bounds["y"]) / sample["height"] * height)
        x2 = int((float(bounds["x"]) + float(bounds["width"])) / sample["width"] * width)
        y2 = int((float(bounds["y"]) + float(bounds["height"])) / sample["height"] * height)
        cv2.rectangle(frame, (x1, y1), (x2, y2), (40, 230, 40), 3)
        label = f"{index:02d} {sample['id']} {sample['seconds']:.2f}s"
        cv2.rectangle(frame, (0, 0), (min(width, 820), 58), (0, 0, 0), -1)
        cv2.putText(frame, label, (14, 39), cv2.FONT_HERSHEY_SIMPLEX, 0.88, (255, 255, 255), 2, cv2.LINE_AA)
        thumbs.append(cv2.resize(frame, (384, 216), interpolation=cv2.INTER_AREA))
    capture.release()

    columns = 5
    rows = math.ceil(len(thumbs) / columns)
    sheet = np.full((rows * 216, columns * 384, 3), 245, dtype=np.uint8)
    for index, thumb in enumerate(thumbs):
        row, column = divmod(index, columns)
        sheet[row * 216:(row + 1) * 216, column * 384:(column + 1) * 384] = thumb
    args.output.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(args.output), sheet, [cv2.IMWRITE_JPEG_QUALITY, 94])
    print(json.dumps({
        "output": str(args.output.resolve()),
        "sampleCount": len(samples),
        "video": str(args.video.resolve()),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
