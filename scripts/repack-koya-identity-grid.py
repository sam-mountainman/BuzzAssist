#!/usr/bin/env python3
"""Deterministically repack an existing white-background identity sheet.

The image model often draws correct views but lets a tall subject cross the
nominal equal-height row boundary. This script finds the real white gutters,
extracts each existing view without redrawing it, and contains it inside the
official equal grid with explicit white clearance.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def choose_row_boundaries(mask: np.ndarray, rows: int) -> list[int]:
    height = mask.shape[0]
    occupancy = mask.sum(axis=1).astype(np.float64)
    window = max(5, height // 120)
    smoothed = np.convolve(occupancy, np.ones(window), mode="same")
    boundaries = [0]
    for index in range(1, rows):
        expected = height * index / rows
        radius = height * 0.16
        start = max(boundaries[-1] + height // 12, int(expected - radius))
        end = min(height - (rows - index) * height // 12, int(expected + radius))
        if end <= start:
            raise ValueError("Could not establish a monotonic source row search interval")
        candidates = np.arange(start, end)
        minimum = smoothed[candidates].min()
        best = candidates[smoothed[candidates] == minimum]
        boundary = int(best[np.argmin(np.abs(best - expected))])
        boundaries.append(boundary)
    boundaries.append(height)
    return boundaries


def content_bbox(
    image: Image.Image,
    threshold: int = 248,
) -> tuple[tuple[int, int, int, int] | None, dict[str, object]]:
    rgb = np.asarray(image.convert("RGB"))
    mask = np.min(rgb, axis=2) < threshold
    total_pixels = int(mask.sum())
    occupied_columns = np.flatnonzero(mask.any(axis=0))
    if len(occupied_columns) == 0:
        return None, {
            "mode": "largest-horizontal-content-run",
            "totalNonWhitePixels": 0,
            "selectedNonWhitePixels": 0,
            "discardedNonWhitePixels": 0,
            "discardedFraction": 0.0,
        }

    # A neighboring view may protrude a small disconnected fragment across an
    # equal-width source window. Keep the dominant horizontal ink run and leave
    # the discarded count in the manifest for independent QA. Short anti-aliased
    # white gaps inside one figure are merged; a genuinely separate edge fragment
    # remains a separate run.
    max_internal_gap = max(3, image.width // 140)
    runs: list[tuple[int, int]] = []
    start = int(occupied_columns[0])
    previous = start
    for value in occupied_columns[1:]:
        current = int(value)
        if current - previous - 1 > max_internal_gap:
            runs.append((start, previous + 1))
            start = current
        previous = current
    runs.append((start, previous + 1))
    center = image.width / 2
    selected_left, selected_right = max(
        runs,
        key=lambda bounds: (
            int(mask[:, bounds[0]:bounds[1]].sum()),
            -abs(((bounds[0] + bounds[1]) / 2) - center),
        ),
    )
    selected_mask = np.zeros_like(mask)
    selected_mask[:, selected_left:selected_right] = mask[:, selected_left:selected_right]
    selected_pixels = int(selected_mask.sum())
    ys, xs = np.where(selected_mask)
    if len(xs) == 0:
        return None, {
            "mode": "largest-horizontal-content-run",
            "totalNonWhitePixels": total_pixels,
            "selectedNonWhitePixels": 0,
            "discardedNonWhitePixels": total_pixels,
            "discardedFraction": 1.0,
        }
    pad = max(2, min(image.size) // 100)
    left = max(0, int(xs.min()) - pad)
    top = max(0, int(ys.min()) - pad)
    right = min(image.width, int(xs.max()) + 1 + pad)
    bottom = min(image.height, int(ys.max()) + 1 + pad)
    discarded_pixels = total_pixels - selected_pixels
    return (left, top, right, bottom), {
        "mode": "largest-horizontal-content-run",
        "runCount": len(runs),
        "maxInternalGap": max_internal_gap,
        "selectedRun": [selected_left, selected_right],
        "totalNonWhitePixels": total_pixels,
        "selectedNonWhitePixels": selected_pixels,
        "discardedNonWhitePixels": discarded_pixels,
        "discardedFraction": round(discarded_pixels / total_pixels, 6) if total_pixels else 0.0,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--columns", type=int, required=True)
    parser.add_argument("--rows", type=int, required=True)
    parser.add_argument("--margin-fraction", type=float, default=0.08)
    args = parser.parse_args()

    source_path = Path(args.input).resolve()
    output_path = Path(args.output).resolve()
    manifest_path = Path(args.manifest).resolve()
    if args.columns < 1 or args.rows < 1:
        raise ValueError("columns/rows must be positive")
    if not 0.04 <= args.margin_fraction <= 0.2:
        raise ValueError("margin-fraction must be between 0.04 and 0.2")

    source = Image.open(source_path).convert("RGBA")
    rgb = np.asarray(source.convert("RGB"))
    mask = np.min(rgb, axis=2) < 248
    row_bounds = choose_row_boundaries(mask, args.rows)
    column_bounds = [round(source.width * index / args.columns) for index in range(args.columns + 1)]
    target = Image.new("RGBA", source.size, (255, 255, 255, 255))
    target_x = [round(source.width * index / args.columns) for index in range(args.columns + 1)]
    target_y = [round(source.height * index / args.rows) for index in range(args.rows + 1)]
    cells: list[dict[str, object]] = []

    for row in range(args.rows):
        for column in range(args.columns):
            source_bounds = (
                column_bounds[column],
                row_bounds[row],
                column_bounds[column + 1],
                row_bounds[row + 1],
            )
            source_cell = source.crop(source_bounds)
            bbox, selection_evidence = content_bbox(source_cell)
            if bbox is None:
                raise ValueError(f"No non-white identity content found in source cell r{row + 1}c{column + 1}")
            content = source_cell.crop(bbox)
            left, top, right, bottom = (
                target_x[column], target_y[row], target_x[column + 1], target_y[row + 1]
            )
            cell_width, cell_height = right - left, bottom - top
            margin_x = max(8, round(cell_width * args.margin_fraction))
            margin_y = max(8, round(cell_height * args.margin_fraction))
            fitted = ImageOps.contain(
                content,
                (cell_width - 2 * margin_x, cell_height - 2 * margin_y),
                Image.Resampling.LANCZOS,
            )
            paste_x = left + (cell_width - fitted.width) // 2
            paste_y = top + (cell_height - fitted.height) // 2
            target.alpha_composite(fitted, (paste_x, paste_y))
            cells.append({
                "id": f"r{row + 1}c{column + 1}",
                "sourceBounds": list(source_bounds),
                "sourceContentBounds": [
                    source_bounds[0] + bbox[0], source_bounds[1] + bbox[1],
                    bbox[2] - bbox[0], bbox[3] - bbox[1],
                ],
                "targetBounds": [left, top, cell_width, cell_height],
                "placedContentBounds": [paste_x, paste_y, fitted.width, fitted.height],
                "contentSelection": selection_evidence,
            })

    output_path.parent.mkdir(parents=True, exist_ok=True)
    target.convert("RGB").save(output_path, format="PNG", optimize=False)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest = {
        "version": "koya-identity-grid-repack-v1",
        "sourcePath": str(source_path),
        "sourceSha256": sha256(source_path),
        "outputPath": str(output_path),
        "outputSha256": sha256(output_path),
        "columns": args.columns,
        "rows": args.rows,
        "sourceRowBounds": row_bounds,
        "targetRowBounds": target_y,
        "marginFraction": args.margin_fraction,
        "cells": cells,
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
