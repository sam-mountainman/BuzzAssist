#!/usr/bin/env python3
"""Measure the twenty user-supplied manga reference stills.

Pixel measurements and heuristic candidates are kept separate from the human
annotations that describe story function, framing and stylized face regions.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import statistics
from pathlib import Path

import cv2
import numpy as np


def distribution(values: list[float]) -> dict:
    if not values:
        return {"count": 0, "mean": None, "median": None, "p10": None, "p90": None}
    data = np.asarray(values, dtype=np.float64)
    return {
        "count": len(values),
        "mean": round(statistics.fmean(values), 5),
        "median": round(statistics.median(values), 5),
        "p10": round(float(np.percentile(data, 10)), 5),
        "p90": round(float(np.percentile(data, 90)), 5),
    }


def runs(indices: np.ndarray) -> list[tuple[int, int]]:
    if indices.size == 0:
        return []
    groups = np.split(indices, np.where(np.diff(indices) > 1)[0] + 1)
    return [(int(group[0]), int(group[-1])) for group in groups if group.size]


def panel_measure(gray: np.ndarray) -> dict:
    height, width = gray.shape
    dark = gray < 32
    vertical = [
        pair for pair in runs(np.flatnonzero(dark.mean(axis=0) > 0.72))
        if 2 <= pair[1] - pair[0] + 1 <= max(5, round(width * 0.055))
        and width * 0.06 < pair[0] < width * 0.94
    ]
    horizontal = [
        pair for pair in runs(np.flatnonzero(dark.mean(axis=1) > 0.72))
        if 2 <= pair[1] - pair[0] + 1 <= max(5, round(height * 0.065))
        and height * 0.06 < pair[0] < height * 0.94
    ]
    return {
        "verticalSeparatorRatios": [[round(a / width, 4), round(b / width, 4)] for a, b in vertical],
        "horizontalSeparatorRatios": [[round(a / height, 4), round(b / height, 4)] for a, b in horizontal],
        "heuristicPanelCount": max(1, len(vertical) + 1, len(horizontal) + 1),
    }


def bubble_candidates(image: np.ndarray) -> list[dict]:
    height, width = image.shape[:2]
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, np.array([0, 0, 218]), np.array([179, 64, 255]))
    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)),
        iterations=2,
    )
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    frame_area = float(width * height)
    output = []
    for contour in contours:
        x, y, candidate_width, candidate_height = cv2.boundingRect(contour)
        area = cv2.contourArea(contour)
        area_ratio = area / frame_area
        extent = area / max(1, candidate_width * candidate_height)
        if not 0.003 <= area_ratio <= 0.24 or extent < 0.42:
            continue
        if candidate_width < width * 0.04 or candidate_height < height * 0.055:
            continue
        output.append({
            "xRatio": round(x / width, 4),
            "yRatio": round(y / height, 4),
            "widthRatio": round(candidate_width / width, 4),
            "heightRatio": round(candidate_height / height, 4),
            "areaRatio": round(area_ratio, 5),
            "extent": round(extent, 4),
        })
    return sorted(output, key=lambda entry: entry["areaRatio"], reverse=True)[:6]


def measure(path: Path, annotation: dict) -> tuple[dict, np.ndarray]:
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not read {path}")
    height, width = image.shape[:2]
    scale = min(1.0, 960.0 / max(width, height))
    analysis = image if scale == 1.0 else cv2.resize(
        image,
        (max(1, round(width * scale)), max(1, round(height * scale))),
        interpolation=cv2.INTER_AREA,
    )
    analysis_height, analysis_width = analysis.shape[:2]
    gray = cv2.cvtColor(analysis, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(analysis, cv2.COLOR_BGR2HSV)
    edges = cv2.Canny(gray, 70, 150)
    quantized = (analysis // 32).reshape(-1, 3)
    center = gray[
        round(analysis_height * 0.15):round(analysis_height * 0.85),
        round(analysis_width * 0.15):round(analysis_width * 0.85),
    ]
    border = np.concatenate([
        gray[:round(analysis_height * 0.12), :].reshape(-1),
        gray[-round(analysis_height * 0.12):, :].reshape(-1),
        gray[:, :round(analysis_width * 0.12)].reshape(-1),
        gray[:, -round(analysis_width * 0.12):].reshape(-1),
    ])
    candidates = bubble_candidates(analysis)
    face = annotation.get("faceBounds") if isinstance(annotation.get("faceBounds"), dict) else None
    face_contrast = None
    if face:
        x1 = max(0, min(analysis_width - 1, round(float(face.get("x", 0)) * analysis_width)))
        y1 = max(0, min(analysis_height - 1, round(float(face.get("y", 0)) * analysis_height)))
        x2 = max(x1 + 1, min(analysis_width, round((float(face.get("x", 0)) + float(face.get("width", 0))) * analysis_width)))
        y2 = max(y1 + 1, min(analysis_height, round((float(face.get("y", 0)) + float(face.get("height", 0))) * analysis_height)))
        mask = np.ones(gray.shape, dtype=bool)
        mask[y1:y2, x1:x2] = False
        face_gray = gray[y1:y2, x1:x2]
        face_edges = edges[y1:y2, x1:x2]
        background_gray = gray[mask]
        background_edges = edges[mask]
        face_contrast = {
            "faceLuma": round(float(face_gray.mean()), 4),
            "backgroundLuma": round(float(background_gray.mean()), 4),
            "absoluteLumaDelta": round(abs(float(face_gray.mean() - background_gray.mean())), 4),
            "faceEdgeDensity": round(float((face_edges > 0).mean()), 5),
            "backgroundEdgeDensity": round(float((background_edges > 0).mean()), 5),
            "faceMinusBackgroundEdgeDensity": round(float((face_edges > 0).mean() - (background_edges > 0).mean()), 5),
        }
    return ({
        "index": int(annotation.get("index") or int(path.stem.split("-")[-1])),
        "filePath": str(path.resolve()),
        "width": width,
        "height": height,
        "pixelMeasurements": {
            "meanLuma": round(float(gray.mean()), 4),
            "lumaContrastStd": round(float(gray.std()), 4),
            "meanSaturation": round(float(hsv[:, :, 1].mean()), 4),
            "edgeDensity": round(float((edges > 0).mean()), 5),
            "quantizedColorCount": int(len(np.unique(quantized, axis=0))),
            "darkPixelRatio": round(float((gray < 48).mean()), 5),
            "centerMinusBorderLuma": round(float(center.mean() - border.mean()), 4),
            "annotatedFaceVsBackground": face_contrast,
        },
        "analysisScale": round(scale, 5),
        "panelHeuristic": panel_measure(gray),
        "bubbleHeuristic": {
            "caveat": "White-region candidates require human confirmation.",
            "candidateCount": len(candidates),
            "candidates": candidates,
        },
        "humanAnnotation": annotation,
    }, image)


def contact_sheet(rows: list[tuple[dict, np.ndarray]], output: Path) -> None:
    thumb_width, thumb_height = 384, 216
    columns = 4
    sheet = np.zeros((math.ceil(len(rows) / columns) * thumb_height, columns * thumb_width, 3), np.uint8)
    for position, (row, image) in enumerate(rows):
        thumb = cv2.resize(image, (thumb_width, thumb_height), interpolation=cv2.INTER_AREA)
        cv2.rectangle(thumb, (0, thumb_height - 30), (155, thumb_height), (0, 0, 0), -1)
        cv2.putText(thumb, f"{row['index']:02d}  {row['width']}x{row['height']}", (8, thumb_height - 9), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
        y, x = divmod(position, columns)
        sheet[y * thumb_height:(y + 1) * thumb_height, x * thumb_width:(x + 1) * thumb_width] = thumb
    cv2.imwrite(str(output), sheet, [cv2.IMWRITE_JPEG_QUALITY, 94])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("images", nargs="+", type=Path)
    parser.add_argument("--annotations", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    annotations = {}
    if args.annotations and args.annotations.exists():
        document = json.loads(args.annotations.read_text())
        annotations = {int(entry["index"]): entry for entry in document.get("images", [])}
    def natural_key(path: Path) -> list[object]:
        return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", path.name)]

    rows = []
    for index, path in enumerate(sorted(args.images, key=natural_key), start=1):
        rows.append(measure(path.resolve(), {"index": index, **annotations.get(index, {})}))
    contact_path = args.output_dir / f"reference-images-contact-{len(rows)}.jpg"
    contact_sheet(rows, contact_path)
    measurements = [row for row, _ in rows]
    human = [entry["humanAnnotation"] for entry in measurements]
    report = {
        "version": 1,
        "imageCount": len(measurements),
        "measurementPolicy": "Pixel statistics and heuristic candidates are automatic; framing, subject occupancy, story function and bubble typography are human annotations.",
        "contactSheetPath": str(contact_path.resolve()),
        "aggregate": {
            "edgeDensity": distribution([entry["pixelMeasurements"]["edgeDensity"] for entry in measurements]),
            "quantizedColorCount": distribution([entry["pixelMeasurements"]["quantizedColorCount"] for entry in measurements]),
            "meanSaturation": distribution([entry["pixelMeasurements"]["meanSaturation"] for entry in measurements]),
            "darkPixelRatio": distribution([entry["pixelMeasurements"]["darkPixelRatio"] for entry in measurements]),
            "subjectHeightRatio": distribution([float(entry["subjectHeightRatio"]) for entry in human if entry.get("subjectHeightRatio") is not None]),
            "faceHeightRatio": distribution([float(entry["faceHeightRatio"]) for entry in human if entry.get("faceHeightRatio") is not None]),
            "characterBackgroundLumaDelta": distribution([
                float(entry["pixelMeasurements"]["annotatedFaceVsBackground"]["absoluteLumaDelta"])
                for entry in measurements if entry["pixelMeasurements"]["annotatedFaceVsBackground"] is not None
            ]),
            "storyPropCount": distribution([float(entry["storyPropCount"]) for entry in human if entry.get("storyPropCount") is not None]),
            "bubbleWidthRatio": distribution([float(bubble["widthRatio"]) for entry in human for bubble in entry.get("bubbles", [])]),
            "bubbleHeightRatio": distribution([float(bubble["heightRatio"]) for entry in human for bubble in entry.get("bubbles", [])]),
            "bubbleColumnCount": distribution([float(bubble["columns"]) for entry in human for bubble in entry.get("bubbles", [])]),
        },
        "images": measurements,
    }
    output_path = args.output_dir / "reference-image-measurements.json"
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({
        "outputPath": str(output_path.resolve()),
        "contactSheetPath": str(contact_path.resolve()),
        "imageCount": len(measurements),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
