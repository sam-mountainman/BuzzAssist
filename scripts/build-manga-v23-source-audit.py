#!/usr/bin/env python3
"""Build a normalized-grid review sheet for V23 camera source images."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-dir", type=Path, default=Path.cwd())
    args = parser.parse_args()
    project_dir = args.project_dir.resolve()
    episode_dir = project_dir / "canvas/manga-videos/manga-photo-homecoming-001"
    manifest = json.loads((episode_dir / "episode-manifest.json").read_text(encoding="utf-8"))
    utterance_by_id = {utterance["id"]: utterance for utterance in manifest["utterances"]}
    cascade = cv2.CascadeClassifier(str(
        project_dir / "canvas/.camera-tools/animeface/lbpcascade_animeface.xml"
    ))
    tiles = []
    for cut in manifest["cuts"]:
        for shot in cut.get("cameraSequence", []):
            frame = cv2.imread(shot["imagePath"])
            if frame is None:
                continue
            frame = cv2.resize(frame, (640, 360), interpolation=cv2.INTER_AREA)
            height, width = frame.shape[:2]
            for index in range(1, 10):
                x = round(width * index / 10)
                y = round(height * index / 10)
                cv2.line(frame, (x, 0), (x, height), (230, 230, 230), 1, cv2.LINE_AA)
                cv2.line(frame, (0, y), (width, y), (230, 230, 230), 1, cv2.LINE_AA)
                cv2.putText(frame, f".{index}", (x + 3, 18), cv2.FONT_HERSHEY_SIMPLEX, .36, (255, 255, 255), 1, cv2.LINE_AA)
                cv2.putText(frame, f".{index}", (3, y - 3), cv2.FONT_HERSHEY_SIMPLEX, .36, (255, 255, 255), 1, cv2.LINE_AA)
            gray = cv2.equalizeHist(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
            faces = cascade.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=4, minSize=(32, 32))
            for face_index, (x, y, face_width, face_height) in enumerate(faces, start=1):
                cv2.rectangle(frame, (x, y), (x + face_width, y + face_height), (40, 220, 255), 2)
                cv2.putText(
                    frame, f"F{face_index} ({(x + face_width / 2) / width:.2f},{(y + face_height / 2) / height:.2f})",
                    (x, max(14, y - 5)), cv2.FONT_HERSHEY_SIMPLEX, .38, (40, 220, 255), 1, cv2.LINE_AA,
                )
            utterances = [utterance_by_id[utterance_id] for utterance_id in shot.get("utteranceIds", [])]
            speaker_ids = [utterance.get("speakerId", "") for utterance in utterances]
            title = f"{cut['id']}  {','.join(shot.get('utteranceIds', []))}  speakers={','.join(speaker_ids)}"
            footer = np.zeros((62, width, 3), dtype=np.uint8)
            cv2.putText(footer, title, (8, 23), cv2.FONT_HERSHEY_SIMPLEX, .47, (255, 255, 255), 1, cv2.LINE_AA)
            texts = " / ".join(utterance.get("text", "") for utterance in utterances)
            cv2.putText(footer, texts[:115], (8, 49), cv2.FONT_HERSHEY_SIMPLEX, .42, (225, 225, 225), 1, cv2.LINE_AA)
            tiles.append(np.vstack([frame, footer]))
    columns = 2
    rows = math.ceil(len(tiles) / columns)
    tile_height, tile_width = tiles[0].shape[:2]
    canvas = np.zeros((rows * tile_height, columns * tile_width, 3), dtype=np.uint8)
    for index, tile in enumerate(tiles):
        row, column = divmod(index, columns)
        canvas[row * tile_height:(row + 1) * tile_height, column * tile_width:(column + 1) * tile_width] = tile
    output_path = project_dir / "canvas/assets/review/manga-photo-homecoming-001-v23-source-grid.jpg"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output_path), canvas, [cv2.IMWRITE_JPEG_QUALITY, 94])
    print(json.dumps({"outputPath": str(output_path), "tileCount": len(tiles)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
