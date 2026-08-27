#!/usr/bin/env python3
import json
import math
import sys

import cv2
import numpy as np


def fail(message):
    raise ValueError(message)


def measure(entry, region):
    image = cv2.imread(str(entry.get("path", "")), cv2.IMREAD_COLOR)
    if image is None:
        fail(f"Unreadable styling image: {entry.get('id', '')}")
    height, width = image.shape[:2]
    if not isinstance(region, list) or len(region) != 4:
        fail("normalizedRegion must contain x, y, width, height")
    nx, ny, nw, nh = [float(value) for value in region]
    if nx < 0 or ny < 0 or nw <= 0 or nh <= 0 or nx + nw > 1 or ny + nh > 1:
        fail("normalizedRegion must stay inside 0..1")
    x = max(0, min(width - 1, round(nx * width)))
    y = max(0, min(height - 1, round(ny * height)))
    right = max(x + 1, min(width, round((nx + nw) * width)))
    bottom = max(y + 1, min(height, round((ny + nh) * height)))
    crop = image[y:bottom, x:right]
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    # Ignore white canvas, pale skin, near-black outlines, and gray clothing.
    non_white = np.any(crop < 242, axis=2)
    chromatic = hsv[:, :, 1] >= 35
    lit = hsv[:, :, 2] >= 28
    mask = non_white & chromatic & lit
    if int(mask.sum()) < max(32, int(crop.shape[0] * crop.shape[1] * 0.01)):
        fail(f"Color region for {entry.get('id', '')} does not contain enough chromatic pixels")
    lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB)[mask]
    median = np.median(lab.astype(np.float64), axis=0)
    cie = [float(median[0] * 100.0 / 255.0), float(median[1] - 128.0), float(median[2] - 128.0)]
    return {
        "id": str(entry.get("id", "")),
        "path": str(entry.get("path", "")),
        "imageWidth": int(width),
        "imageHeight": int(height),
        "pixelBounds": [int(x), int(y), int(right - x), int(bottom - y)],
        "sampledPixelCount": int(mask.sum()),
        "medianLab": [round(value, 4) for value in cie],
    }


def main():
    payload = json.loads(sys.argv[1]) if len(sys.argv) > 1 else json.load(sys.stdin)
    entries = payload.get("entries", [])
    region = payload.get("normalizedRegion", [])
    threshold = float(payload.get("minimumDeltaE76", 12.0))
    if len(entries) < 2:
        fail("At least two styling images are required")
    rows = [measure(entry, region) for entry in entries]
    pairs = []
    for left_index, left in enumerate(rows):
        for right in rows[left_index + 1:]:
            distance = math.sqrt(sum((a - b) ** 2 for a, b in zip(left["medianLab"], right["medianLab"])))
            pairs.append({
                "pairId": "::".join(sorted([left["id"], right["id"]])),
                "optionIds": sorted([left["id"], right["id"]]),
                "deltaE76": round(distance, 4),
                "minimumDeltaE76": threshold,
                "pass": distance >= threshold,
            })
    json.dump({
        "version": "koya-styling-color-measurement-v1",
        "normalizedRegion": region,
        "minimumDeltaE76": threshold,
        "candidates": rows,
        "pairChecks": pairs,
        "pass": all(pair["pass"] for pair in pairs),
    }, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        json.dump({"error": str(error)}, sys.stdout, ensure_ascii=False)
        sys.exit(2)
