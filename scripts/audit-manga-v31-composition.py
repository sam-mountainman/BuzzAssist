#!/usr/bin/env python3
"""Audit V31 composition assets and create an utterance-level proof sheet."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import cv2
import numpy as np


def dhash(image: np.ndarray, width: int = 16, height: int = 9) -> int:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    resized = cv2.resize(gray, (width + 1, height), interpolation=cv2.INTER_AREA)
    bits = resized[:, 1:] > resized[:, :-1]
    value = 0
    for bit in bits.flatten():
        value = (value << 1) | int(bit)
    return value


def hamming(left: int, right: int) -> int:
    return bin(left ^ right).count("1")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def midpoint_seconds(utterance: dict) -> float:
    timing = utterance.get("timing") or {}
    start = float(timing.get("bubbleStartSeconds", timing.get("audioStartSeconds", 0)))
    end = float(timing.get("bubbleEndSeconds", timing.get("audioEndSeconds", start + 0.2)))
    return max(0.0, start + (end - start) * 0.52)


def extract_frame(capture: cv2.VideoCapture, seconds: float) -> np.ndarray:
    capture.set(cv2.CAP_PROP_POS_MSEC, seconds * 1000.0)
    ok, frame = capture.read()
    if not ok or frame is None:
        raise RuntimeError(f"Could not decode proof frame at {seconds:.3f}s")
    return frame


def make_contact_sheet(frames: list[tuple[str, float, np.ndarray]], output_path: Path) -> None:
    tile_width, tile_height, label_height = 480, 270, 34
    columns = 5
    rows = math.ceil(len(frames) / columns)
    sheet = np.full((rows * (tile_height + label_height), columns * tile_width, 3), 246, np.uint8)
    for index, (utterance_id, seconds, frame) in enumerate(frames):
        row, column = divmod(index, columns)
        x, y = column * tile_width, row * (tile_height + label_height)
        tile = cv2.resize(frame, (tile_width, tile_height), interpolation=cv2.INTER_AREA)
        sheet[y : y + tile_height, x : x + tile_width] = tile
        cv2.putText(
            sheet,
            f"{utterance_id}  {seconds:06.2f}s",
            (x + 10, y + tile_height + 24),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.56,
            (22, 22, 22),
            1,
            cv2.LINE_AA,
        )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(output_path), sheet, [cv2.IMWRITE_JPEG_QUALITY, 91]):
        raise RuntimeError(f"Could not write {output_path}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("project_dir", nargs="?", default=".")
    args = parser.parse_args()
    project_dir = Path(args.project_dir).resolve()
    episode_dir = project_dir / "canvas/manga-videos/manga-photo-homecoming-001"
    manifest = read_json(episode_dir / "episode-manifest.json")
    dag = read_json(episode_dir / "production-dag-v31.json")
    generation = read_json(episode_dir / "v31-composition-asset-generation.json")
    video_path = project_dir / "canvas/assets/videos/manga-photo-homecoming-001-v31-semantic-composition-r1.mp4"
    contact_sheet_path = episode_dir / "v31-rendered-utterance-contact-sheet.jpg"
    audit_path = episode_dir / "v31-composition-audit.json"

    asset_rows: list[dict] = []
    hashes: list[int] = []
    failures: list[dict] = []
    applied_image_paths = set()
    for cut in manifest.get("cuts", []):
        for shot in cut.get("cameraSequence", []):
            if shot.get("imagePath"):
                applied_image_paths.add(str(Path(shot["imagePath"])))
        for panel in (cut.get("panelLayout") or {}).get("panels", []):
            if panel.get("imagePath"):
                applied_image_paths.add(str(Path(panel["imagePath"])))
    for result in generation.get("results", []):
        path = Path(result["outputPath"])
        image = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if image is None:
            failures.append({"id": result.get("id"), "reason": "missing-or-undecodable"})
            continue
        height, width = image.shape[:2]
        ratio_error = abs(width / height - 16 / 9)
        # gpt-image-2's native landscape raster is 1456x816 (0.37% wider than
        # mathematical 16:9). The renderer performs a sub-percent center crop.
        if ratio_error > 0.01:
            failures.append({"id": result.get("id"), "reason": "not-wide-aspect-compatible", "width": width, "height": height})
        image_hash = dhash(image)
        hashes.append(image_hash)
        asset_rows.append({
            "id": result.get("id"),
            "path": str(path),
            "width": width,
            "height": height,
            "sha256": sha256(path),
            "dhash": f"{image_hash:036x}",
            "appliedToManifest": str(path) in applied_image_paths,
        })

    unapplied_assets = [row["id"] for row in asset_rows if not row["appliedToManifest"]]
    if unapplied_assets:
        failures.append({"reason": "generated-assets-not-applied", "ids": unapplied_assets})

    pair_distances = [
        {"left": asset_rows[i]["id"], "right": asset_rows[j]["id"], "distance": hamming(hashes[i], hashes[j])}
        for i in range(len(hashes))
        for j in range(i + 1, len(hashes))
    ]
    closest_pair = min(pair_distances, key=lambda item: item["distance"], default=None)
    if closest_pair and closest_pair["distance"] < 10:
        failures.append({"reason": "near-duplicate-generated-assets", **closest_pair})

    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError(f"Could not open {video_path}")
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    video_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    video_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    duration = frame_count / fps if fps > 0 else 0
    proof_frames = []
    for utterance in manifest.get("utterances", []):
        seconds = midpoint_seconds(utterance)
        proof_frames.append((utterance["id"], seconds, extract_frame(capture, seconds)))
    capture.release()
    make_contact_sheet(proof_frames, contact_sheet_path)

    diagnostics = (dag.get("compositionPlan") or {}).get("diagnostics") or {}
    gates = {
        "generatedAssetCount": len(asset_rows) == 14,
        "generatedAssetsApplied": not unapplied_assets,
        "generatedAssetsAreUnique": closest_pair is not None and closest_pair["distance"] >= 10,
        "semanticSetupVariety": int(diagnostics.get("uniqueSetupCount", 0)) >= 12,
        "adjacentCameraAxisChange": int(diagnostics.get("minimumObservedChangedAxes", 0)) >= 3,
        "noConsecutiveSimilarPlan": int(diagnostics.get("consecutiveTooSimilarCount", -1)) == 0,
        "proofFrameCount": len(proof_frames) == len(manifest.get("utterances", [])) == 29,
        "videoDuration": 149.0 <= duration <= 151.0,
        "videoDimensions": video_width == 1920 and video_height == 1080,
    }
    passed = all(gates.values()) and not failures
    audit = {
        "version": "v31-semantic-composition-r1",
        "pass": passed,
        "gates": gates,
        "failures": failures,
        "referenceAnalysis": manifest.get("production", {}).get("v31Composition", {}).get("referenceAnalysis"),
        "compositionDiagnostics": diagnostics,
        "generatedAssets": asset_rows,
        "closestGeneratedAssetPair": closest_pair,
        "renderedVideo": {
            "path": str(video_path),
            "durationSeconds": duration,
            "fps": fps,
            "frameCount": frame_count,
            "width": video_width,
            "height": video_height,
            "sha256": sha256(video_path),
        },
        "proofSheet": str(contact_sheet_path),
    }
    audit_path.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "outputPath": str(audit_path),
        "contactSheetPath": str(contact_sheet_path),
        "pass": passed,
        "gates": gates,
        "closestGeneratedAssetPair": closest_pair,
        "durationSeconds": duration,
    }, ensure_ascii=False, indent=2))
    if not passed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
