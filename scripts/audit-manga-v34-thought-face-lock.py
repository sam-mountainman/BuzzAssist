#!/usr/bin/env python3
"""Pixel-audit the V34 inner-monologue face spotlight with OpenCV."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import cv2


project_dir = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
episode_dir = project_dir / "canvas/manga-videos/manga-photo-homecoming-001"
audit_dir = episode_dir / "audits/v34-thought-face-lock"
coordinate_audit_path = episode_dir / "v34-thought-face-coordinate-audit.json"
output_path = episode_dir / "v34-thought-face-frame-audit.json"

coordinate_audit = json.loads(coordinate_audit_path.read_text(encoding="utf-8"))
projected_center = coordinate_audit["projectedCenter"]
spot_center = (projected_center["x"] * 1920, projected_center["y"] * 1080)
cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")

rows = []
for frame_name in ("start.png", "mid.png", "end.png"):
    frame_path = audit_dir / frame_name
    image = cv2.imread(str(frame_path))
    if image is None:
        raise RuntimeError(f"Missing audit frame: {frame_path}")
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    detections = cascade.detectMultiScale(
        gray,
        scaleFactor=1.03,
        minNeighbors=2,
        minSize=(160, 160),
        maxSize=(280, 280),
    )
    candidates = [box.tolist() for box in detections if box[0] < image.shape[1] * 0.5]
    if not candidates:
        raise RuntimeError(f"No active-speaker face detected in {frame_path}")
    x, y, width, height = min(
        candidates,
        key=lambda box: abs(box[0] + box[2] / 2 - spot_center[0])
        + abs(box[1] + box[3] / 2 - spot_center[1]),
    )
    face_center = (x + width / 2, y + height / 2)
    error_px = math.hypot(face_center[0] - spot_center[0], face_center[1] - spot_center[1])
    normalized_error = error_px / max(1, min(width, height))
    rows.append(
        {
            "frame": frame_name,
            "framePath": str(frame_path),
            "faceBoundsPx": {"x": x, "y": y, "width": width, "height": height},
            "faceCenterPx": {"x": face_center[0], "y": face_center[1]},
            "spotCenterPx": {"x": spot_center[0], "y": spot_center[1]},
            "centerErrorPx": error_px,
            "normalizedCenterError": normalized_error,
            "pass": normalized_error <= 0.12,
        }
    )

mid = next(row for row in rows if row["frame"] == "mid.png")
gates = [
    {
        "id": "midpoint-pixel-lock",
        "thresholdPx": 8,
        "valuePx": mid["centerErrorPx"],
        "pass": mid["centerErrorPx"] <= 8,
    },
    {
        "id": "full-thought-camera-drift-contained-inside-face",
        "thresholdFaceFraction": 0.12,
        "maxValue": max(row["normalizedCenterError"] for row in rows),
        "pass": all(row["pass"] for row in rows),
    },
]
payload = {
    "version": "v34-thought-face-frame-audit-r1",
    "engine": f"OpenCV {cv2.__version__} Haar frontal-face default",
    "coordinateAuditPath": str(coordinate_audit_path),
    "contactSheetPath": str(audit_dir / "contact-sheet.png"),
    "frames": rows,
    "gates": gates,
    "pass": all(gate["pass"] for gate in gates),
}
output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
if not payload["pass"]:
    raise RuntimeError(f"V34 thought-face frame audit failed: {gates}")
print(json.dumps({"auditPath": str(output_path), "pass": True, "frames": rows}, ensure_ascii=False, indent=2))
