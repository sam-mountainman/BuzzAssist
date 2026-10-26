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


def remove_frame_rules(rgb: np.ndarray, columns: int = 1, rows: int = 1) -> tuple[np.ndarray, dict[str, object]]:
    """Whiten thin, long, light-grey straight rules (drawn panel frames).

    The image model sometimes draws grey panel frames into a sheet that must
    have none. They are not part of any view, but a white-threshold mask
    counts them as content, so they are carried into every repacked cell and
    also pull the row-gutter search. Only pixels that are (a) light neutral
    grey, (b) part of a long straight run and (c) thin across the run are
    whitened; character line art is darker or coloured and is never touched.
    """
    height, width = rgb.shape[:2]
    low = rgb.min(axis=2).astype(np.int16)
    high = rgb.max(axis=2).astype(np.int16)
    # Drawn frames are neutral grey (measured chroma median 7-8, value ~190-235).
    # Pale clothing such as lavender or pastel green is visibly more chromatic
    # (median ~26), so it is not a rule candidate.
    grey = (low >= 150) & (low < 248) & ((high - low) <= 14)
    min_horizontal = max(40, width // 12)
    min_vertical = max(40, height // 10)
    thickness = 5

    def extent(mask: np.ndarray, axis: int) -> np.ndarray:
        """Length of the consecutive True run through each pixel along axis."""
        moved = np.moveaxis(mask, axis, 0).astype(np.int32)
        forward = np.zeros_like(moved)
        backward = np.zeros_like(moved)
        for index in range(moved.shape[0]):
            forward[index] = (forward[index - 1] + 1) * moved[index] if index else moved[index]
        for index in range(moved.shape[0] - 1, -1, -1):
            backward[index] = (backward[index + 1] + 1) * moved[index] if index < moved.shape[0] - 1 else moved[index]
        return np.moveaxis(np.where(moved > 0, forward + backward - 1, 0), 0, axis)

    # A rule is thin across its direction: grey that extends further than
    # `thickness` across the run is a region (clothing, shading), not a line.
    vertical_extent = extent(grey, 0)
    horizontal_extent = extent(grey, 1)

    def long_runs(line: np.ndarray, minimum: int) -> list[tuple[int, int]]:
        runs: list[tuple[int, int]] = []
        indices = np.flatnonzero(line)
        if len(indices) == 0:
            return runs
        start = previous = int(indices[0])
        for value in indices[1:]:
            current = int(value)
            if current != previous + 1:
                if previous + 1 - start >= minimum:
                    runs.append((start, previous + 1))
                start = current
            previous = current
        if previous + 1 - start >= minimum:
            runs.append((start, previous + 1))
        return runs

    nonwhite = low < 248
    light = low >= 150

    def beside_white(transposed: bool, first: int, last: int, start: int, end: int, gap: int = 3) -> bool:
        """A drawn frame has open white on at least one side; the inside of a
        figure (a column through a face, a row through a dress) never does.
        Look just past the thickest rule we accept, so a 5px rule is not
        mistaken for its own surroundings."""
        mask = nonwhite.T if transposed else nonwhite
        sides = [line for line in (first - gap, last + gap) if 0 <= line < mask.shape[0]]
        if not sides:
            return True
        return max(float((~mask[line, start:end]).mean()) for line in sides) >= 0.8

    removed = np.zeros((height, width), dtype=bool)
    horizontal: list[list[int]] = []
    vertical: list[list[int]] = []
    for y in range(height):
        for start, end in long_runs(grey[y], min_horizontal):
            if float((vertical_extent[y, start:end] <= thickness).mean()) >= 0.8 and beside_white(False, y, y, start, end, gap=thickness + 1):
                removed[y, start:end] |= grey[y, start:end] & (vertical_extent[y, start:end] <= thickness)
                horizontal.append([y, start, end])
    for x in range(width):
        for start, end in long_runs(grey[:, x], min_vertical):
            if float((horizontal_extent[start:end, x] <= thickness).mean()) >= 0.8 and beside_white(True, x, x, start, end, gap=thickness + 1):
                removed[start:end, x] |= grey[start:end, x] & (horizontal_extent[start:end, x] <= thickness)
                vertical.append([x, start, end])
    # Where a figure was clipped by its frame, the rule's pixels blend with the
    # figure and lose the neutral-grey signature. A panel frame still spans
    # almost a whole cell in one unbroken run and is only a few pixels thick;
    # a figure never does both. Whiten only the light pixels of such a band,
    # so dark line art crossing it stays.
    #
    # The band must look like a frame where it is not covered by a figure: a
    # fair share of its pixels are the frame's own neutral grey, and beside
    # those pixels (not beside the figures that overlap it) there is open
    # white. A column through a face or a row through a dress has almost no
    # neutral-grey pixels, so it is never taken. Only pale, near-neutral
    # pixels are whitened, so light hair or pastel cloth crossing the frame
    # keeps its colour.
    pale = light & ((high - low) <= 24)
    span_bands = 0

    def frame_band(transposed: bool, line: int, first: int, last: int, start: int, end: int, gap: int = 3) -> bool:
        mask = nonwhite.T if transposed else nonwhite
        candidates = (grey.T if transposed else grey)[line, start:end]
        if candidates.sum() < 0.25 * (end - start):
            return False
        sides = [index for index in (first - gap, last + gap) if 0 <= index < mask.shape[0]]
        if not sides:
            return True
        return max(float((~mask[index, start:end][candidates]).mean()) for index in sides) >= 0.6

    def span_rows(mask: np.ndarray, minimum: int) -> dict[int, list[tuple[int, int]]]:
        return {index: runs for index in range(mask.shape[0]) if (runs := long_runs(mask[index], minimum))}

    for transposed, cell_extent in ((False, width / max(1, columns)), (True, height / max(1, rows))):
        mask = nonwhite.T if transposed else nonwhite
        rows_with_spans = span_rows(mask, int(cell_extent * 0.9))
        group: list[int] = []
        for index in sorted(rows_with_spans) + [None]:
            if index is not None and (not group or index == group[-1] + 1):
                group.append(index)
                continue
            if group and len(group) <= thickness:
                for line in group:
                    for start, end in rows_with_spans[line]:
                        if not frame_band(transposed, line, group[0], group[-1], start, end):
                            continue
                        span_bands += 1
                        if transposed:
                            removed[start:end, line] |= pale[start:end, line]
                        else:
                            removed[line, start:end] |= pale[line, start:end]
            group = [index] if index is not None else []

    # The anti-aliased edge of a removed rule is left as a faint 1px line along
    # a clipped figure. Take neutral-grey pixels that touch a removed rule,
    # one pixel deep only.
    neighbours = np.zeros_like(removed)
    neighbours[1:, :] |= removed[:-1, :]
    neighbours[:-1, :] |= removed[1:, :]
    neighbours[:, 1:] |= removed[:, :-1]
    neighbours[:, :-1] |= removed[:, 1:]
    removed |= grey & neighbours
    cleaned = rgb.copy()
    cleaned[removed] = 255
    return cleaned, {
        "mode": "thin-long-light-grey-rules",
        "removedPixels": int(removed.sum()),
        "horizontalRuleRuns": len(horizontal),
        "verticalRuleRuns": len(vertical),
        "fullSpanBands": span_bands,
        "minimumRunLength": [min_horizontal, min_vertical],
    }


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


def label_components(mask: np.ndarray) -> np.ndarray:
    """8-connected component labels (0 = background) using run-length union-find."""
    height = mask.shape[0]
    parent: list[int] = [0]

    def find(value: int) -> int:
        while parent[value] != value:
            parent[value] = parent[parent[value]]
            value = parent[value]
        return value

    row_runs: list[list[tuple[int, int, int]]] = []
    for y in range(height):
        line = mask[y]
        runs: list[tuple[int, int, int]] = []
        if line.any():
            padded = np.concatenate(([False], line, [False])).astype(np.int8)
            edges = np.flatnonzero(np.diff(padded))
            for start, end in zip(edges[0::2], edges[1::2]):
                label = len(parent)
                parent.append(label)
                runs.append((int(start), int(end), label))
        if y > 0:
            previous = row_runs[-1]
            index = 0
            for start, end, label in runs:
                while index < len(previous) and previous[index][1] < start:
                    index += 1
                probe = index
                while probe < len(previous) and previous[probe][0] <= end:
                    root_a, root_b = find(label), find(previous[probe][2])
                    if root_a != root_b:
                        parent[max(root_a, root_b)] = min(root_a, root_b)
                    probe += 1
        row_runs.append(runs)
    labels = np.zeros(mask.shape, dtype=np.int32)
    for y, runs in enumerate(row_runs):
        for start, end, label in runs:
            labels[y, start:end] = find(label)
    return labels


def assign_rows_by_component(
    mask: np.ndarray, boundaries: list[int], majority: float = 0.85,
) -> tuple[np.ndarray, dict[str, int]]:
    """Row index per pixel of one column strip, following drawings across the cut.

    A straight cut slices a view whose hair or feet poke a few pixels past the
    gutter. Each connected drawing goes whole to the row holding most of it.
    A component spread over two rows (two views that touch) keeps the
    straight cut, so nothing is silently moved between views.
    """
    labels = label_components(mask)
    straight = np.zeros(mask.shape, dtype=np.int32)
    for row in range(len(boundaries) - 1):
        straight[boundaries[row]:boundaries[row + 1], :] = row
    row_count = len(boundaries) - 1
    label_count = int(labels.max()) + 1
    inside = labels > 0
    counts = np.bincount(
        labels[inside] * row_count + straight[inside], minlength=label_count * row_count,
    ).reshape(label_count, row_count)
    totals = counts.sum(axis=1)
    best = counts.argmax(axis=1)
    best_counts = counts[np.arange(label_count), best]
    follows = (totals > 0) & (best_counts >= majority * np.maximum(totals, 1))
    target = np.where(follows, best, -1)
    pixel_target = target[labels]
    assigned = np.where(inside & (pixel_target >= 0), pixel_target, straight)
    moved_pixels = int((totals[follows] - best_counts[follows]).sum())
    split_components = int(((~follows) & ((counts > 0).sum(axis=1) > 1)).sum())
    return assigned, {"crossingPixelsReassigned": moved_pixels, "componentsLeftOnStraightCut": split_components}


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

    original_rgb = np.asarray(Image.open(source_path).convert("RGB"))
    rgb, rule_removal = remove_frame_rules(original_rgb, args.columns, args.rows)
    width, height = rgb.shape[1], rgb.shape[0]
    mask = np.min(rgb, axis=2) < 248
    column_bounds = [round(width * index / args.columns) for index in range(args.columns + 1)]
    target = Image.new("RGBA", (width, height), (255, 255, 255, 255))
    target_x = [round(width * index / args.columns) for index in range(args.columns + 1)]
    target_y = [round(height * index / args.rows) for index in range(args.rows + 1)]
    cells: list[dict[str, object]] = []

    # Each column of views gets its own gutter search, and every connected
    # drawing follows the row that holds most of it, so hair or feet that
    # poke a few pixels past the gutter are not sliced into the next view.
    row_bounds_by_column: list[list[int]] = []
    assigned_by_column: list[np.ndarray] = []
    crossing_by_column: list[dict[str, int]] = []
    for column in range(args.columns):
        strip = mask[:, column_bounds[column]:column_bounds[column + 1]]
        bounds = choose_row_boundaries(strip, args.rows)
        assigned, crossing = assign_rows_by_component(strip, bounds)
        row_bounds_by_column.append(bounds)
        assigned_by_column.append(assigned)
        crossing_by_column.append(crossing)

    for row in range(args.rows):
        for column in range(args.columns):
            x0, x1 = column_bounds[column], column_bounds[column + 1]
            bounds = row_bounds_by_column[column]
            member = mask[:, x0:x1] & (assigned_by_column[column] == row)
            occupied_rows = np.flatnonzero(member.any(axis=1))
            region_top, region_bottom = bounds[row], bounds[row + 1]
            if len(occupied_rows):
                region_top = min(region_top, int(occupied_rows[0]))
                region_bottom = max(region_bottom, int(occupied_rows[-1]) + 1)
            cell_rgb = rgb[region_top:region_bottom, x0:x1].copy()
            cell_rgb[~member[region_top:region_bottom]] = 255
            source_cell = Image.fromarray(cell_rgb, "RGB").convert("RGBA")
            source_bounds = (x0, region_top, x1, region_bottom)
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
        "sourceRowBounds": row_bounds_by_column,
        "rowAssignment": crossing_by_column,
        "targetRowBounds": target_y,
        "marginFraction": args.margin_fraction,
        "ruleRemoval": rule_removal,
        "cells": cells,
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
