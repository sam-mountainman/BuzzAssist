#!/usr/bin/env python3
"""Compose separate identity cells into the official equal grid without redrawing.

Used when a registered character's approved sheet files were lost and only the
individual views survive (for example, images extracted from the client-facing
PDF). Each source image is trimmed to its non-white content with the same rule
as repack-koya-identity-grid.py and contained, unchanged except for scaling,
inside its own equal cell with explicit white clearance. The manifest binds the
output SHA-256 to every source SHA-256 in grid order, so the recovery map can
prove which pixels came from where.

A cell may instead be cut from a surviving sheet (for example the registered,
approved sheet of the same role, when only one of its cells must be replaced):
give it a "crop" entry instead of "path". The script cuts the rectangle
unchanged, writes it as PNG, uses that crop as the cell source and records
the cut ("cropOf": source path, source SHA-256, bounds) in the manifest. The
rectangle is either explicit "bounds" [x, y, width, height] in source pixels,
or "grid" {"columns", "rows", "cell": "r1c1"} with the same rounding as the
identity review's grid split.

    {"id": "r1c1", "crop": {"source": "registered-expression.png",
                            "sourceSha256": "<optional expected SHA-256>",
                            "bounds": [0, 0, 200, 200],
                            "output": "crops/expression-r1c1.png"}}

A "path" cell may also give "trim": [x, y, width, height] when the source is a
delivered part that carries its own drawn tile frame (for example a single
view extracted unchanged from the client zip). Only that rectangle of the
source is used, unchanged except for scaling, so the frame lines stay out of
the sheet. The cell's sourceSha256 stays the SHA-256 of the untouched source
file and the manifest records "trimBounds".

    {"id": "r3c2", "path": "zip/turnaround_right-profile-full-body.png",
     "trim": [12, 20, 387, 446]}
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

from PIL import Image, ImageOps


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def crop_bounds(cell_id: str, crop: dict, width: int, height: int) -> list[int]:
    bounds = crop.get("bounds")
    grid = crop.get("grid")
    if bounds is not None and grid is not None:
        raise ValueError(f"{cell_id}: crop takes either bounds or grid, not both")
    if grid is not None:
        columns, rows, name = grid.get("columns"), grid.get("rows"), str(grid.get("cell", ""))
        if not (isinstance(columns, int) and isinstance(rows, int) and columns >= 1 and rows >= 1):
            raise ValueError(f"{cell_id}: crop.grid needs positive integer columns and rows")
        try:
            row_text, column_text = name.lstrip("r").split("c")
            row, column = int(row_text) - 1, int(column_text) - 1
        except ValueError as error:
            raise ValueError(f"{cell_id}: crop.grid.cell must look like r1c1") from error
        if not (0 <= row < rows and 0 <= column < columns):
            raise ValueError(f"{cell_id}: crop.grid.cell {name} is outside a {columns}x{rows} grid")
        # Same rounding as scripts/audit-koya-character-identity.py split_grid.
        left = round(column * width / columns)
        right = round((column + 1) * width / columns)
        top = round(row * height / rows)
        bottom = round((row + 1) * height / rows)
        bounds = [left, top, right - left, bottom - top]
    if not (isinstance(bounds, list) and len(bounds) == 4
            and all(isinstance(value, int) and not isinstance(value, bool) for value in bounds)):
        raise ValueError(f"{cell_id}: crop.bounds must be [x, y, width, height] in whole source pixels")
    x, y, box_width, box_height = bounds
    if x < 0 or y < 0 or box_width < 1 or box_height < 1 or x + box_width > width or y + box_height > height:
        raise ValueError(f"{cell_id}: crop bounds {bounds} fall outside the {width}x{height} source")
    return bounds


def cut_crop(cell_id: str, crop: dict) -> tuple[Path, dict[str, object]]:
    """Cut one cell out of a surviving sheet without redrawing it."""
    if not isinstance(crop, dict) or not crop.get("source") or not crop.get("output"):
        raise ValueError(f"{cell_id}: crop needs source and output")
    source_path = Path(crop["source"]).resolve()
    source_sha256 = sha256(source_path)
    expected = crop.get("sourceSha256")
    if expected and expected != source_sha256:
        raise ValueError(f"{cell_id}: crop source {source_path} is not the expected sheet (SHA-256 differs)")
    with Image.open(source_path) as source:
        bounds = crop_bounds(cell_id, crop, source.width, source.height)
        x, y, box_width, box_height = bounds
        piece = source.crop((x, y, x + box_width, y + box_height))
        if piece.mode not in ("RGB", "RGBA", "L", "LA", "P"):
            piece = piece.convert("RGBA")
        output_path = Path(crop["output"]).resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        piece.save(output_path, format="PNG", optimize=False)
        source_size = [source.width, source.height]
    return output_path, {
        "sourcePath": str(source_path),
        "sourceSha256": source_sha256,
        "sourceSize": source_size,
        "bounds": bounds,
        "cropPath": str(output_path),
        "cropSha256": sha256(output_path),
    }


def load_repack_module():
    path = Path(__file__).with_name("repack-koya-identity-grid.py")
    spec = importlib.util.spec_from_file_location("repack_koya_identity_grid", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cells", required=True, help="JSON file: [{\"id\": \"front-full-body\", \"path\": \"...\"} or {\"id\": ..., \"crop\": {\"source\", \"bounds\" | \"grid\", \"output\"}}, ...] in grid order")
    parser.add_argument("--output", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--columns", type=int, required=True)
    parser.add_argument("--rows", type=int, required=True)
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    parser.add_argument("--margin-fraction", type=float, default=0.08)
    args = parser.parse_args()

    if args.columns < 1 or args.rows < 1:
        raise ValueError("columns/rows must be positive")
    if not 0.04 <= args.margin_fraction <= 0.2:
        raise ValueError("margin-fraction must be between 0.04 and 0.2")
    cells_spec = json.loads(Path(args.cells).read_text(encoding="utf-8"))
    if not isinstance(cells_spec, list) or len(cells_spec) != args.columns * args.rows:
        raise ValueError(f"--cells must list exactly {args.columns * args.rows} cells in grid order")
    ids = [str(cell.get("id", "")) for cell in cells_spec]
    if any(not cell_id for cell_id in ids) or len(set(ids)) != len(ids):
        raise ValueError("every cell needs a unique id")

    repack = load_repack_module()
    target = Image.new("RGBA", (args.width, args.height), (255, 255, 255, 255))
    target_x = [round(args.width * index / args.columns) for index in range(args.columns + 1)]
    target_y = [round(args.height * index / args.rows) for index in range(args.rows + 1)]
    cells: list[dict[str, object]] = []
    for index, cell in enumerate(cells_spec):
        row, column = divmod(index, args.columns)
        crop_record = None
        trim_bounds = None
        if cell.get("crop") is not None:
            if cell.get("path") or cell.get("trim") is not None:
                raise ValueError(f"{ids[index]}: give either path (with optional trim) or crop, not both")
            source_path, crop_record = cut_crop(ids[index], cell["crop"])
        else:
            source_path = Path(cell["path"]).resolve()
        source = Image.open(source_path).convert("RGBA")
        source_size = [source.width, source.height]
        if cell.get("trim") is not None:
            trim_bounds = crop_bounds(ids[index], {"bounds": cell["trim"]}, source.width, source.height)
            x, y, box_width, box_height = trim_bounds
            source = source.crop((x, y, x + box_width, y + box_height))
        flattened = Image.new("RGBA", source.size, (255, 255, 255, 255))
        flattened.alpha_composite(source)
        bbox, selection_evidence = repack.content_bbox(flattened)
        if bbox is None:
            raise ValueError(f"No non-white identity content found in {source_path}")
        content = flattened.crop(bbox)
        left, top, right, bottom = target_x[column], target_y[row], target_x[column + 1], target_y[row + 1]
        cell_width, cell_height = right - left, bottom - top
        margin_x = max(8, round(cell_width * args.margin_fraction))
        margin_y = max(8, round(cell_height * args.margin_fraction))
        fitted = ImageOps.contain(content, (cell_width - 2 * margin_x, cell_height - 2 * margin_y), Image.Resampling.LANCZOS)
        paste_x = left + (cell_width - fitted.width) // 2
        paste_y = top + (cell_height - fitted.height) // 2
        target.alpha_composite(fitted, (paste_x, paste_y))
        cells.append({
            "id": ids[index],
            "gridCell": f"r{row + 1}c{column + 1}",
            "sourcePath": str(source_path),
            "sourceSha256": sha256(source_path),
            "sourceSize": source_size,
            **({"trimBounds": trim_bounds} if trim_bounds else {}),
            # Measured inside the trimmed rectangle when trimBounds is present.
            "sourceContentBounds": [bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]],
            "scale": round(fitted.width / max(1, bbox[2] - bbox[0]), 6),
            "targetBounds": [left, top, cell_width, cell_height],
            "placedContentBounds": [paste_x, paste_y, fitted.width, fitted.height],
            "contentSelection": selection_evidence,
            **({"cropOf": crop_record} if crop_record else {}),
        })

    output_path = Path(args.output).resolve()
    manifest_path = Path(args.manifest).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    target.convert("RGB").save(output_path, format="PNG", optimize=False)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest = {
        "version": "koya-identity-grid-compose-v1",
        "outputPath": str(output_path),
        "outputSha256": sha256(output_path),
        "columns": args.columns,
        "rows": args.rows,
        "width": args.width,
        "height": args.height,
        "marginFraction": args.margin_fraction,
        "cells": cells,
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
