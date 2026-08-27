#!/usr/bin/env python3
"""Build hash-bound review artifacts for the Koya character identity gate.

This script deliberately produces a *draft* review with every perceptual check
set to false.  Machine measurements and crops help the independent reviewer,
but never substitute for the original-scale identity judgment.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps


VERSION = "koya-character-identity-review-v2"
TURNAROUND_VIEWS = [
    "front-full-body", "left-profile-full-body", "right-profile-full-body", "back-full-body",
    "front-head", "left-three-quarter-head", "right-three-quarter-head", "top-head",
]
EXPRESSION_CELLS = [f"r{row}c{column}" for row in range(1, 4) for column in range(1, 5)]
OUTFIT_CELLS = ["front", "strict-side", "back", "seated-three-quarter"]
EYE_OPEN_CELLS = ["default-front", "open-front", "default-three-quarter", "open-three-quarter"]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_image(path: Path) -> Image.Image:
    with Image.open(path) as source:
        source.load()
        return source.convert("RGB")


def font(size: int = 24):
    for candidate in (
        "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def contact_sheet(rows: list[tuple[str, Image.Image]], output: Path) -> dict:
    tile_width, tile_height, label_height, gap = 720, 720, 54, 24
    canvas = Image.new("RGB", (gap + len(rows) * (tile_width + gap), tile_height + label_height + 2 * gap), "white")
    draw = ImageDraw.Draw(canvas)
    label_font = font(28)
    for index, (label, source) in enumerate(rows):
        tile = ImageOps.contain(source, (tile_width, tile_height), Image.Resampling.LANCZOS)
        x = gap + index * (tile_width + gap) + (tile_width - tile.width) // 2
        y = gap + label_height + (tile_height - tile.height) // 2
        canvas.paste(tile, (x, y))
        draw.text((gap + index * (tile_width + gap), gap), label, fill="black", font=label_font)
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, "PNG")
    return {"path": str(output.resolve()), "sha256": sha256(output), "width": canvas.width, "height": canvas.height}


def cascade_path(spec: dict) -> Path:
    configured = Path(spec.get("animeFaceCascade", "")) if spec.get("animeFaceCascade") else None
    if configured and configured.exists():
        return configured
    return Path(__file__).resolve().parent / "data" / "lbpcascade_animeface.xml"


def largest_face(image: Image.Image, cascade: cv2.CascadeClassifier):
    rgb = np.asarray(image)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    faces = cascade.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=3, minSize=(24, 24))
    if len(faces) == 0:
        return None
    x, y, width, height = max(faces, key=lambda item: int(item[2]) * int(item[3]))
    return [int(x), int(y), int(width), int(height)]


def crop_box(image: Image.Image, bbox):
    if bbox:
        x, y, width, height = bbox
        return image.crop((x, y, x + width, y + height))
    side = max(1, int(min(image.width, image.height) * 0.55))
    left = (image.width - side) // 2
    top = max(0, int(image.height * 0.08))
    bottom = max(top + 1, min(image.height, top + side))
    return image.crop((left, top, min(image.width, left + side), bottom))


def mean_luma_distance(left: Image.Image, right: Image.Image) -> float:
    a = np.asarray(ImageOps.fit(left.convert("L"), (32, 32), Image.Resampling.LANCZOS), dtype=np.float32) / 255.0
    b = np.asarray(ImageOps.fit(right.convert("L"), (32, 32), Image.Resampling.LANCZOS), dtype=np.float32) / 255.0
    return round(float(np.mean(np.abs(a - b))), 6)


def asset_record(item: dict, cascade: cv2.CascadeClassifier) -> tuple[dict, Image.Image, Image.Image]:
    path = Path(item["path"]).expanduser().resolve()
    image = load_image(path)
    actual_hash = sha256(path)
    expected_hash = item.get("sha256", "")
    if expected_hash and expected_hash != actual_hash:
        raise RuntimeError(f"SHA-256 mismatch: {path}")
    bbox = largest_face(image, cascade)
    return ({
        "label": item.get("label", ""),
        "candidateId": item.get("candidateId", ""),
        "path": str(path),
        "sha256": actual_hash,
        "width": image.width,
        "height": image.height,
        "faceDetection": {"detected": bbox is not None, "bbox": bbox or []},
    }, image, crop_box(image, bbox))


def split_grid(image: Image.Image, columns: int, rows: int, ids: list[str], output_dir: Path, prefix: str, cascade):
    if len(ids) != columns * rows:
        raise RuntimeError(f"Grid id count mismatch for {prefix}: {len(ids)} != {columns * rows}")
    if image.width < columns * 16 or image.height < rows * 16:
        raise RuntimeError(f"Grid source is too small for reliable cell QA: {prefix} {image.width}x{image.height}")
    cells = []
    for row in range(rows):
        for column in range(columns):
            index = row * columns + column
            left = round(column * image.width / columns)
            right = round((column + 1) * image.width / columns)
            top = round(row * image.height / rows)
            bottom = round((row + 1) * image.height / rows)
            cell_image = image.crop((left, top, right, bottom))
            path = output_dir / f"{prefix}-{ids[index]}.png"
            cell_image.save(path, "PNG")
            bbox = largest_face(cell_image, cascade)
            cells.append({
                "id": ids[index], "path": str(path.resolve()), "sha256": sha256(path),
                "width": cell_image.width, "height": cell_image.height,
                "sourceBounds": [left, top, right - left, bottom - top],
                "faceDetection": {"detected": bbox is not None, "bbox": bbox or []},
                "sameIdentity": False, "ageConsistent": False, "hairConsistent": False,
                "faceContourConsistent": False, "pass": False, "note": "",
            })
    return {
        "grid": {
            "columns": columns, "rows": rows,
            "sourceWidth": image.width, "sourceHeight": image.height,
            "coverage": [0, 0, image.width, image.height],
            "alignmentConfirmed": False,
        },
        "cells": cells,
    }


def candidate_review(spec: dict, output: Path) -> dict:
    cascade = cv2.CascadeClassifier(str(cascade_path(spec)))
    records = [asset_record(item, cascade) for item in spec["candidates"]]
    sheet = contact_sheet([(record[0]["label"], record[1]) for record in records], output.parent / "candidate-contact-sheet.png")
    pair_checks = []
    for left_index in range(len(records)):
        for right_index in range(left_index + 1, len(records)):
            left, right = records[left_index], records[right_index]
            pair_checks.append({
                "labels": [left[0]["label"], right[0]["label"]],
                "machine": {
                    "faceDetectedInBoth": bool(left[0]["faceDetection"]["detected"] and right[0]["faceDetection"]["detected"]),
                    "faceCropLumaDistance": mean_luma_distance(left[2], right[2]),
                    "wholeImageLumaDistance": mean_luma_distance(left[1], right[1]),
                },
                "visualAxes": {
                    "faceShapeDistinct": False, "eyesDistinct": False, "browsDistinct": False,
                    "hairSilhouetteDistinct": False, "bodyBuildDistinct": False,
                },
                "pass": False, "note": "",
            })
    return {
        "version": VERSION, "phase": "candidate-diversity", "workflowId": spec["workflowId"],
        "castId": spec["castId"], "generatorContextId": spec.get("generatorContextId", ""),
        "reviewer": {"host": "", "id": "", "contextId": "", "reviewedAt": ""},
        "originalScaleInspected": False,
        "candidates": [record[0] for record in records], "contactSheet": sheet,
        "pairChecks": pair_checks, "pass": False, "notes": "",
    }


def identity_review(spec: dict, output: Path) -> dict:
    cascade = cv2.CascadeClassifier(str(cascade_path(spec)))
    selected, selected_image, selected_face = asset_record(spec["selectedFace"], cascade)
    turnaround, turnaround_image, _ = asset_record(spec["turnaround"], cascade)
    expression, expression_image, _ = asset_record(spec["expression"], cascade)
    cells_dir = output.parent / "cells"
    cells_dir.mkdir(parents=True, exist_ok=True)
    turnaround_split = split_grid(turnaround_image, 4, 2, TURNAROUND_VIEWS, cells_dir, "turnaround", cascade)
    expression_split = split_grid(expression_image, 4, 3, EXPRESSION_CELLS, cells_dir, "expression", cascade)
    for cell in turnaround_split["cells"] + expression_split["cells"]:
        cell_image = load_image(Path(cell["path"]))
        cell_face = crop_box(cell_image, cell["faceDetection"]["bbox"] or None)
        cell["machineFaceCropLumaDistanceToSelected"] = mean_luma_distance(selected_face, cell_face)
    outfits = []
    for item in spec.get("outfitSheets", []):
        record, sheet_image, _ = asset_record(item, cascade)
        split = split_grid(sheet_image, 4, 1, OUTFIT_CELLS, cells_dir, f"outfit-{item.get('storyStage', 'stage')}", cascade)
        for cell in split["cells"]:
            cell_image = load_image(Path(cell["path"]))
            cell_face = crop_box(cell_image, cell["faceDetection"]["bbox"] or None)
            cell["machineFaceCropLumaDistanceToSelected"] = mean_luma_distance(selected_face, cell_face)
            cell["outfitMatchesSpecification"] = False
        outfits.append({
            **record, "storyStage": item.get("storyStage", ""), "sameIdentity": False,
            "outfitMatchesSpecification": False, "grid": split["grid"], "cells": split["cells"],
            "pass": False, "note": "",
        })
    extras = []
    for item in spec.get("extraSheets", []):
        record, sheet_image, _ = asset_record(item, cascade)
        role = item.get("role", "")
        if role != "eye-open":
            raise RuntimeError(f"Unsupported identity differential role: {role}")
        split = split_grid(sheet_image, 2, 2, EYE_OPEN_CELLS, cells_dir, role, cascade)
        for cell in split["cells"]:
            cell_image = load_image(Path(cell["path"]))
            cell_face = crop_box(cell_image, cell["faceDetection"]["bbox"] or None)
            cell["machineFaceCropLumaDistanceToSelected"] = mean_luma_distance(selected_face, cell_face)
            cell["stateMatchesSpecification"] = False
        extras.append({
            **record, "role": role, "sameIdentity": False, "grid": split["grid"],
            "cells": split["cells"], "pass": False, "note": "",
        })
    return {
        "version": VERSION, "phase": "identity-pack", "workflowId": spec["workflowId"],
        "castId": spec["castId"], "generatorContextId": spec.get("generatorContextId", ""),
        "reviewer": {"host": "", "id": "", "contextId": "", "reviewedAt": ""},
        "originalScaleInspected": False, "selectedFace": selected,
        "turnaround": {
            **turnaround, "isRealTurnaround": False, "notCandidateSubstitute": turnaround["sha256"] != selected["sha256"],
            "grid": turnaround_split["grid"], "viewChecks": turnaround_split["cells"], "pass": False, "note": "",
        },
        "expression": {**expression, "grid": expression_split["grid"], "cells": expression_split["cells"], "pass": False, "note": ""},
        "outfitSheets": outfits, "extraSheets": extras, "pass": False, "notes": "",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if spec.get("phase") == "candidate-diversity":
        report = candidate_review(spec, output)
    elif spec.get("phase") == "identity-pack":
        report = identity_review(spec, output)
    else:
        raise RuntimeError("phase must be candidate-diversity or identity-pack")
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "pass": False, "phase": report["phase"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
