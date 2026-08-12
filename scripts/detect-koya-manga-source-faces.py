#!/usr/bin/env python3
"""Detect source-image faces for Koya bubble placement.

This is a placement input, not the final face audit. The final rendered audit
uses separately extracted MP4 frames so placement and verification never grade
the same coordinates.
"""

import argparse
import json
from pathlib import Path

import cv2


def read_json(path):
    return json.loads(Path(path).read_text())


def detect(cascade, image):
    gray = cv2.equalizeHist(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY))
    height, width = image.shape[:2]
    raw = cascade.detectMultiScale(
        gray,
        scaleFactor=1.05,
        minNeighbors=3,
        minSize=(48, 48),
    )
    rows = []
    for x, y, w, h in raw:
        if h > height * 0.58 or w > width * 0.58:
            continue
        rows.append({
            "x": round(float(x) / width, 6),
            "y": round(float(y) / height, 6),
            "width": round(float(w) / width, 6),
            "height": round(float(h) / height, 6),
            "area": float(w * h),
            "centerDistance": abs((x + w / 2) / width - 0.5) + abs((y + h / 2) / height - 0.43),
        })
    rows.sort(key=lambda row: (-row["area"], row["centerDistance"]))
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument(
        "--cascade",
        default="scripts/data/lbpcascade_animeface.xml",
    )
    args = parser.parse_args()
    plan = read_json(args.plan)
    cascade = cv2.CascadeClassifier(str(Path(args.cascade).resolve()))
    if cascade.empty():
        raise SystemExit("anime face cascade is missing")
    utterances = {
        row["id"]: row for row in plan.get("manifest", {}).get("utterances", [])
    }
    rows = []
    failures = []
    for page in plan.get("pages", []):
        utterance = utterances.get(page.get("utteranceId"), {})
        editorial_plate = page.get("editorial", {}).get("editorialPlate", {}).get("recommended") is True
        image_path = str(page.get("outputPath") or "")
        if editorial_plate:
            rows.append({
                "utteranceId": page.get("utteranceId"),
                "cutId": page.get("cutId"),
                "imagePath": image_path,
                "editorialPlate": True,
                "detections": [],
                "sourceFaceBoundsBySpeakerId": {},
                "sourceAvoidRegions": [],
                "pass": True,
            })
            continue
        image = cv2.imread(image_path)
        if image is None:
            failures.append({"utteranceId": page.get("utteranceId"), "reason": "image-unreadable", "imagePath": image_path})
            continue
        faces = detect(cascade, image)
        speaker_id = str(utterance.get("speakerId") or "")
        requires_speaker_face = speaker_id not in ("", "narration")
        primary = faces[0] if faces and requires_speaker_face else None
        speaker_faces = {}
        if primary:
            speaker_faces[speaker_id] = {
                key: primary[key] for key in ("x", "y", "width", "height")
            }
        avoid_regions = []
        for index, face in enumerate(faces):
            is_primary = primary is face
            avoid_regions.append({
                "id": f"{page.get('utteranceId')}-face-{index + 1}",
                "kind": "face" if is_primary else "secondary-head",
                "speakerId": speaker_id if is_primary else "",
                "x": face["x"],
                "y": face["y"],
                "width": face["width"],
                "height": face["height"],
                "weight": 1600 if is_primary else 900,
            })
            avoid_regions.append({
                "id": f"{page.get('utteranceId')}-hair-{index + 1}",
                "kind": "body",
                "x": max(0, round(face["x"] - face["width"] * 0.16, 6)),
                "y": max(0, round(face["y"] - face["height"] * 0.18, 6)),
                "width": min(1, round(face["width"] * 1.32, 6)),
                "height": min(1, round(face["height"] * 1.55, 6)),
                "weight": 360,
            })
        passed = not requires_speaker_face or primary is not None
        if not passed:
            failures.append({
                "utteranceId": page.get("utteranceId"),
                "reason": "active-speaker-face-not-detected",
                "imagePath": image_path,
            })
        rows.append({
            "utteranceId": page.get("utteranceId"),
            "cutId": page.get("cutId"),
            "imagePath": image_path,
            "editorialPlate": False,
            "detections": [
                {key: face[key] for key in ("x", "y", "width", "height")}
                for face in faces
            ],
            "sourceFaceBoundsBySpeakerId": speaker_faces,
            "sourceAvoidRegions": avoid_regions,
            "pass": passed,
        })
    report = {
        "version": "koya-source-face-placement-v1",
        "planPath": str(Path(args.plan).resolve()),
        "method": "anime face cascade on current generated source images",
        "independentFinalAuditRequired": True,
        "rows": rows,
        "failures": failures,
        "pass": len(failures) == 0,
        "knownRemainingIssues": failures,
    }
    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({
        "pass": report["pass"],
        "checked": len(rows),
        "failureCount": len(failures),
        "outputPath": str(output_path),
    }, ensure_ascii=False))
    if not report["pass"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
