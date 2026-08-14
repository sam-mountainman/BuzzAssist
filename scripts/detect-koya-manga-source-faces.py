#!/usr/bin/env python3
"""Detect source-image faces for Koya bubble placement.

This is a placement input, not the final face audit. The final rendered audit
uses separately extracted MP4 frames so placement and verification never grade
the same coordinates.
"""

import argparse
import hashlib
import json
from pathlib import Path

import cv2


def read_json(path):
    return json.loads(Path(path).read_text())


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized_bounds(value):
    if not isinstance(value, dict):
        return None
    try:
        bounds = {key: float(value[key]) for key in ("x", "y", "width", "height")}
    except (KeyError, TypeError, ValueError):
        return None
    if not all(0 <= bounds[key] <= 1 for key in bounds):
        return None
    if bounds["width"] <= 0 or bounds["height"] <= 0:
        return None
    if bounds["x"] + bounds["width"] > 1.000001 or bounds["y"] + bounds["height"] > 1.000001:
        return None
    return {key: round(value, 6) for key, value in bounds.items()}


def manual_reviews(path, plan):
    if not path:
        return {}, None
    review_path = Path(path).resolve()
    if not review_path.is_file():
        raise SystemExit(f"source face review is missing: {review_path}")
    review = read_json(review_path)
    review_version = review.get("version")
    if review_version not in ("koya-source-face-review-v1", "koya-source-region-review-v2"):
        raise SystemExit(
            "source region review version must be koya-source-face-review-v1 or koya-source-region-review-v2"
        )
    episode_id = str(plan.get("manifest", {}).get("id") or plan.get("episodeId") or "")
    if str(review.get("episodeId") or "") != episode_id:
        raise SystemExit("source face review episodeId does not match the image plan")
    reviewed_by = str(review.get("reviewedBy") or "").strip()
    reviewed_at = str(review.get("reviewedAt") or "").strip()
    if len(reviewed_by) < 3 or len(reviewed_at) < 10:
        raise SystemExit("source face review requires reviewedBy and reviewedAt")
    output = {}
    for index, annotation in enumerate(review.get("annotations") or []):
        utterance_id = str(annotation.get("utteranceId") or "").strip()
        kind = str(annotation.get("kind") or "face").strip()
        if kind not in ("face", "hand", "prop", "evidence", "text"):
            raise SystemExit(f"invalid source region kind at index {index}: {kind}")
        speaker_id = str(annotation.get("speakerId") or "").strip()
        image_sha256 = str(annotation.get("imageSha256") or "").lower()
        note = str(annotation.get("note") or "").strip()
        bounds = normalized_bounds(annotation.get("bounds"))
        if not utterance_id or (kind == "face" and not speaker_id) or len(note) < 8 or not bounds:
            raise SystemExit(f"invalid source region review annotation at index {index}")
        if len(image_sha256) != 64 or any(char not in "0123456789abcdef" for char in image_sha256):
            raise SystemExit(f"invalid source image SHA-256 at annotation {utterance_id}")
        annotation_id = str(annotation.get("id") or f"{utterance_id}-manual-face-{index + 1}").strip()
        if any(row["id"] == annotation_id for rows in output.values() for row in rows):
            raise SystemExit(f"duplicate source face review annotation id: {annotation_id}")
        output.setdefault(utterance_id, []).append({
            "id": annotation_id,
            "kind": kind,
            "speakerId": speaker_id,
            "imageSha256": image_sha256,
            "bounds": bounds,
            "note": note,
        })
    return output, {
        "path": str(review_path),
        "sha256": sha256_file(review_path),
        "reviewedBy": reviewed_by,
        "reviewedAt": reviewed_at,
    }


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


def merge_manual_faces(faces, manual_face_rows, speaker_id, requires_speaker_face):
    """Merge reviewed faces while preserving every automatic hit as an obstacle."""
    merged = list(faces)
    primary = merged[0] if merged and requires_speaker_face else None
    applied_review_ids = set()
    primary_review = next(
        (row for row in manual_face_rows if row["speakerId"] == speaker_id),
        None,
    )
    # A hash-bound human review is authoritative for speaker identity even
    # when the cascade returned a plausible face. The cascade cannot identify
    # characters, so its largest hit remains only an additional hard obstacle.
    if requires_speaker_face and primary_review:
        primary = {
            **primary_review["bounds"],
            "area": 0,
            "centerDistance": 0,
            "manual": True,
            "manualSpeakerId": primary_review["speakerId"],
            "manualReviewId": primary_review["id"],
        }
        merged.insert(0, primary)
        applied_review_ids.add(primary_review["id"])
    for manual_review in manual_face_rows:
        if manual_review["id"] in applied_review_ids:
            continue
        merged.append({
            **manual_review["bounds"],
            "area": 0,
            "centerDistance": 0,
            "manual": True,
            "manualSpeakerId": manual_review["speakerId"],
            "manualReviewId": manual_review["id"],
        })
        applied_review_ids.add(manual_review["id"])
    return merged, primary, applied_review_ids


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument(
        "--cascade",
        default="scripts/data/lbpcascade_animeface.xml",
    )
    parser.add_argument("--review", default="")
    args = parser.parse_args()
    plan = read_json(args.plan)
    reviews, review_evidence = manual_reviews(args.review, plan)
    cascade = cv2.CascadeClassifier(str(Path(args.cascade).resolve()))
    if cascade.empty():
        raise SystemExit("anime face cascade is missing")
    utterances = {
        row["id"]: row for row in plan.get("manifest", {}).get("utterances", [])
    }
    rows = []
    failures = []
    applied_review_ids = set()
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
        manual_review_rows = reviews.get(str(page.get("utteranceId") or ""), [])
        for manual_review in manual_review_rows:
            if manual_review["imageSha256"] != sha256_file(image_path):
                raise SystemExit(f"manual face image digest mismatch: {page.get('utteranceId')} / {manual_review['id']}")
        manual_face_rows = [row for row in manual_review_rows if row["kind"] == "face"]
        manual_region_rows = [row for row in manual_review_rows if row["kind"] != "face"]
        faces, primary, applied_face_review_ids = merge_manual_faces(
            faces,
            manual_face_rows,
            speaker_id,
            requires_speaker_face,
        )
        applied_review_ids.update(applied_face_review_ids)
        speaker_faces = {}
        if primary:
            speaker_faces[speaker_id] = {
                key: primary[key] for key in ("x", "y", "width", "height")
            }
        for face in faces:
            manual_speaker_id = str(face.get("manualSpeakerId") or "")
            if manual_speaker_id and manual_speaker_id not in speaker_faces:
                speaker_faces[manual_speaker_id] = {
                    key: face[key] for key in ("x", "y", "width", "height")
                }
        avoid_regions = []
        for index, face in enumerate(faces):
            is_primary = primary is face
            # Every cascade/manual source-image face is a hard placement
            # obstacle. Downgrading non-speakers to a soft "secondary-head"
            # lets a visually valid score trade a clipped face for proximity.
            is_confirmed_face = True
            avoid_regions.append({
                "id": f"{page.get('utteranceId')}-face-{index + 1}",
                "kind": "face" if is_confirmed_face else "secondary-head",
                "speakerId": speaker_id if is_primary else str(face.get("manualSpeakerId") or ""),
                "x": face["x"],
                "y": face["y"],
                "width": face["width"],
                "height": face["height"],
                "weight": 1600 if is_confirmed_face else 900,
                "hardProtection": True,
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
        for manual_review in manual_region_rows:
            avoid_regions.append({
                "id": manual_review["id"],
                "kind": manual_review["kind"],
                "speakerId": manual_review["speakerId"],
                **manual_review["bounds"],
                "weight": 1600,
                "hardProtection": True,
                "manualReviewId": manual_review["id"],
            })
            applied_review_ids.add(manual_review["id"])
        is_split_page = bool(page.get("panelJobIds"))
        passed = (not requires_speaker_face or primary is not None) and (not is_split_page or len(faces) > 0)
        if requires_speaker_face and primary is None:
            failures.append({
                "utteranceId": page.get("utteranceId"),
                "reason": "active-speaker-face-not-detected",
                "imagePath": image_path,
            })
        if is_split_page and not faces:
            failures.append({
                "utteranceId": page.get("utteranceId"),
                "reason": "split-page-face-inventory-required",
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
            "manualReviewApplied": bool(manual_review_rows),
            "manualReviewIds": [row["id"] for row in manual_review_rows],
            "manualReviewNotes": [row["note"] for row in manual_review_rows],
        })
    all_review_ids = {row["id"] for review_rows in reviews.values() for row in review_rows}
    unused_reviews = sorted(all_review_ids - applied_review_ids)
    if unused_reviews:
        raise SystemExit(f"unused source face review annotations: {', '.join(unused_reviews)}")
    report = {
        "version": "koya-source-region-placement-v3",
        "planPath": str(Path(args.plan).resolve()),
        "method": "anime face cascade plus image-hash-bound manual face and story-critical region review",
        "independentFinalAuditRequired": True,
        "manualReviewEvidence": review_evidence,
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
