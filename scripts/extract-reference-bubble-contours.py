#!/usr/bin/env python3
"""Extract reusable speech-balloon silhouettes from the supplied reference frames.

The reference videos use hand-drawn, irregular outlines.  This script isolates the
white balloon interior with OpenCV, keeps the exterior contour, simplifies it at
sub-pixel scale, and stores normalized SVG-ready points.  Runtime rendering never
depends on the temporary screenshots; it consumes the generated JSON catalog.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "assets" / "speech-bubble-shape-templates.json"
TEMP = Path("/var/folders/8k/hnpy4g4n0q71xs6yylvmdrvm0000gn/T")

REFERENCES = [
    {
        "id": "reference-frame-30",
        "kind": "shout",
        "path": TEMP / "codex-clipboard-ece1bd0e-d543-4c1a-b5fe-bced979220c3.png",
        "roi": [1050, 0, 1500, 850],
        "sourceVideoId": "awAbZyTeE4g",
        "sourceSecond": 884,
        "characterCount": 23,
    },
    {
        "id": "reference-frame-31",
        "kind": "shout",
        "path": TEMP / "codex-clipboard-b140b2e4-defc-4111-afa9-da2854e90a23.png",
        "roi": [50, 20, 380, 550],
        "sourceVideoId": "awAbZyTeE4g",
        "sourceSecond": 1261,
        "characterCount": 21,
    },
    {
        "id": "reference-frame-32",
        "kind": "shout",
        "path": TEMP / "codex-clipboard-e546f8ff-d07e-413d-94c8-8b9f5bb7b947.png",
        "roi": [450, 0, 850, 750],
        "sourceVideoId": "2ycRncs4CKY",
        "sourceSecond": 1352,
        "characterCount": 27,
    },
    {
        "id": "reference-frame-33",
        "kind": "shout",
        "path": TEMP / "codex-clipboard-6ab9b382-5847-4d6e-be23-6413b4b7994f.png",
        "roi": [450, 0, 850, 650],
        "sourceVideoId": "2ycRncs4CKY",
        "sourceSecond": 1357,
        "characterCount": 22,
    },
    {
        "id": "reference-frame-34",
        "kind": "shout",
        "path": TEMP / "codex-clipboard-9852a303-8fac-40df-9fde-3b43e83ae878.png",
        "roi": [450, 0, 1050, 780],
        "sourceVideoId": "2ycRncs4CKY",
        "sourceSecond": 1363,
        "characterCount": 47,
    },
    {
        "id": "reference-frame-35",
        "kind": "shout",
        "path": TEMP / "codex-clipboard-9fae5877-e1e8-4659-8d55-1900e173d8be.png",
        "roi": [500, 0, 1000, 650],
        "sourceVideoId": "awAbZyTeE4g",
        "sourceSecond": 1152,
        "characterCount": 17,
    },
    {
        "id": "reference-frame-36",
        "kind": "shout",
        "path": TEMP / "codex-clipboard-0c10193e-333a-4e59-80ad-aff308b51e89.png",
        "roi": [950, 0, 1450, 750],
        "sourceVideoId": "awAbZyTeE4g",
        "sourceSecond": 1168,
        "characterCount": 21,
    },
    {
        "id": "reference-frame-37",
        "kind": "tremble",
        "path": TEMP / "codex-clipboard-0d538dbc-1e38-44a1-8669-04aa47e32696.png",
        "roi": [650, 30, 1050, 700],
        "sourceVideoId": "awAbZyTeE4g",
        "sourceSecond": 1448,
        "characterCount": 15,
    },
]


def signed_area(points: np.ndarray) -> float:
    x = points[:, 0]
    y = points[:, 1]
    return float(0.5 * np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


def canonicalize(points: np.ndarray) -> np.ndarray:
    """Use clockwise winding and a stable top-most starting vertex."""
    if signed_area(points) < 0:
        points = points[::-1]
    start = min(range(len(points)), key=lambda index: (points[index, 1], points[index, 0]))
    return np.concatenate([points[start:], points[:start]])


def extract(reference: dict) -> dict:
    image = cv2.imread(str(reference["path"]), cv2.IMREAD_COLOR)
    if image is None:
        raise FileNotFoundError(reference["path"])

    x1, y1, x2, y2 = reference["roi"]
    roi = image[y1:y2, x1:x2]
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    # Balloon interiors are near-neutral white.  Restricting saturation keeps
    # pale sky/window highlights out of the component mask.
    mask = cv2.inRange(hsv, np.array([0, 0, 238]), np.array([179, 32, 255]))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if count <= 1:
        raise RuntimeError(f"No white component found in {reference['id']}")

    component_index = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    component = np.where(labels == component_index, 255, 0).astype(np.uint8)
    component = cv2.morphologyEx(
        component,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)),
    )
    contours, _ = cv2.findContours(component, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    contour = max(contours, key=cv2.contourArea)
    perimeter = cv2.arcLength(contour, True)
    # 0.075% retains the deliberately sharp cusps while reducing camera-scale
    # raster stair-steps.  SVG line joins supply the final inked smoothness.
    simplified = cv2.approxPolyDP(contour, perimeter * 0.00075, True).reshape(-1, 2).astype(float)
    simplified = canonicalize(simplified)

    bx, by, bw, bh = cv2.boundingRect(contour)
    normalized = np.column_stack(
        ((simplified[:, 0] - bx) / max(1, bw - 1), (simplified[:, 1] - by) / max(1, bh - 1))
    )
    normalized = np.clip(normalized, 0.0, 1.0)

    return {
        "id": reference["id"],
        "kind": reference["kind"],
        "source": {
            "videoId": reference["sourceVideoId"],
            "second": reference["sourceSecond"],
            "attachmentFrame": int(reference["id"].rsplit("-", 1)[1]),
        },
        "characterCount": reference["characterCount"],
        "aspectRatio": round(bw / bh, 6),
        "sourceBounds": {"x": int(x1 + bx), "y": int(y1 + by), "width": int(bw), "height": int(bh)},
        "pointCount": len(normalized),
        "points": [[round(float(x), 6), round(float(y), 6)] for x, y in normalized],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    templates = [extract(reference) for reference in REFERENCES]
    payload = {
        "schemaVersion": 1,
        "generator": "OpenCV external-contour extraction",
        "selection": "weighted character-count and aspect-ratio nearest neighbour",
        "templates": templates,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "templates": [{"id": item["id"], "points": item["pointCount"], "aspect": item["aspectRatio"]} for item in templates]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
