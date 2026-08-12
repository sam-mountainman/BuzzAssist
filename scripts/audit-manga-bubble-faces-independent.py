#!/usr/bin/env python3
"""R59 independent bubble/face audit.

Principle (pipeline invariant): placement and auditing must NOT share the
same face-coordinate data. This gate finds faces in the RENDERED frames with
two sources that are independent of the shot annotations used for placement:

  A. lbpcascade_animeface (scripts/data/lbpcascade_animeface.xml) run on the
     frame itself, with size sanity filters.
  B. Character face templates auto-extracted (by the same cascade) from each
     character's TURNAROUND sheet — an asset lineage separate from shot
     annotations — multi-scale template-matched against the frame.

Every bubble is sampled at its display midpoint (and quarter points). For a
non-panel cut the bubble rect is post-camera screen space; for a split page
it is projected through the page camera at the sampled time. A detected face
covered more than --max-cover (default 0.35) by a bubble fails the gate
(the user permits grazing non-speaker overlap; direct covering of any face
is a defect).
"""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

DEFAULT_CASCADE = Path("scripts/data/lbpcascade_animeface.xml")


def read_json(path):
    return json.loads(Path(path).read_text())


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def rendered_detection_is_overlay_artifact(face, cover):
    """A fully bubble-contained cascade hit cannot be an underlying face.

    The detector runs after an opaque white bubble has been composited. When
    every pixel of the candidate box lies inside that bubble, the cascade saw
    bubble glyphs or decoration—not a face hidden behind opaque pixels. Keep
    partial intersections strict because a real face remains visibly testable.
    """
    return face.get("method") == "anime-cascade" and cover >= 0.98


def visible_detection_evidence(frame, face_box, bubble_rect):
    """Measure only candidate pixels that remain visible outside the bubble."""
    x, y, w, h = face_box
    crop = frame[y:y + h, x:x + w]
    if crop.size == 0:
        return {"visibleFraction": 0.0, "grayStd": 0.0, "edgeFraction": 0.0, "darkFraction": 0.0}
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 50, 150)
    yy, xx = np.mgrid[y:y + h, x:x + w]
    visible = ~(
        (xx >= bubble_rect[0]) & (xx < bubble_rect[2])
        & (yy >= bubble_rect[1]) & (yy < bubble_rect[3])
    )
    pixels = gray[visible]
    if pixels.size == 0:
        return {"visibleFraction": 0.0, "grayStd": 0.0, "edgeFraction": 0.0, "darkFraction": 0.0}
    return {
        "visibleFraction": float(pixels.size / gray.size),
        "grayStd": float(pixels.std()),
        "edgeFraction": float(np.count_nonzero(edges[visible]) / pixels.size),
        "darkFraction": float(np.count_nonzero(pixels < 80) / pixels.size),
    }


def rendered_detection_is_flat_visible_background(face, cover, evidence):
    """Reject a cascade box whose bubble-exposed area contains no face detail.

    A genuine partial face intersection still leaves visible eye/hair/contour
    structure outside the opaque bubble. This gate is deliberately strict and
    applies only when a large exposed region is simultaneously flat, edgeless,
    and free of dark facial linework.
    """
    return (
        face.get("method") == "anime-cascade"
        and 0 < cover < 0.98
        and evidence["visibleFraction"] >= 0.2
        and evidence["grayStd"] < 12.0
        and evidence["edgeFraction"] < 0.01
        and evidence["darkFraction"] < 0.02
    )


def detect_faces(cascade, frame):
    gray = cv2.equalizeHist(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
    height = frame.shape[0]
    raw = cascade.detectMultiScale(gray, scaleFactor=1.05, minNeighbors=3, minSize=(56, 56))
    return [
        (int(x), int(y), int(w), int(h)) for (x, y, w, h) in raw
        if h <= 0.45 * height
    ]


def extract_sheet_templates(cascade, turnaround_paths):
    templates = []
    for character_id, sheet_path in turnaround_paths:
        sheet = cv2.imread(str(sheet_path))
        if sheet is None:
            continue
        for (x, y, w, h) in detect_faces(cascade, sheet):
            patch = sheet[y:y + h, x:x + w]
            if patch.size:
                templates.append((character_id, cv2.resize(patch, (96, 96))))
    return templates


def registry_turnarounds(manifest_path, manifest):
    """Resolve approved references without using shot-placement annotations."""
    project_dir = manifest_path.parents[3]
    registry_path = project_dir / "canvas" / "characters.json"
    if not registry_path.is_file():
        return []
    registry = read_json(registry_path)
    episode_id = manifest.get("id", "")
    speaker_ids = {row.get("speakerId") for row in manifest.get("utterances", [])}
    rows = []
    for character in registry.get("characters", []):
        if character.get("status") != "approved":
            continue
        if character.get("episodeId") != episode_id and character.get("id") not in speaker_ids:
            continue
        for reference in character.get("referenceImagePaths", []):
            path = Path(reference)
            if not path.is_absolute():
                path = project_dir / "canvas" / path
            if path.is_file():
                rows.append((character.get("id", path.stem), path))
    return rows


def template_faces(templates, frame, threshold=0.72, analysis_scale=0.5):
    """Match only the active speaker's approved templates.

    Registry-wide matching made bubble glyphs look like unrelated character
    faces (30–48 false detections per frame). Matching the active identity is
    both stricter and faster; cascade detections remain the identity-agnostic
    protection for visible non-speaker faces.
    """
    found = []
    scaled_frame = cv2.resize(frame, None, fx=analysis_scale, fy=analysis_scale, interpolation=cv2.INTER_AREA)
    for character_id, template in templates:
        for size in (90, 130, 180, 250, 340):
            scaled_size = max(32, int(round(size * analysis_scale)))
            resized = cv2.resize(template, (scaled_size, scaled_size))
            if scaled_size >= scaled_frame.shape[0] or scaled_size >= scaled_frame.shape[1]:
                continue
            result = cv2.matchTemplate(scaled_frame, resized, cv2.TM_CCOEFF_NORMED)
            _, best, _, loc = cv2.minMaxLoc(result)
            if best >= threshold:
                found.append({
                    "box": [int(round(loc[0] / analysis_scale)), int(round(loc[1] / analysis_scale)), size, size],
                    "characterId": character_id,
                    "score": float(best),
                    "method": "active-speaker-template",
                })
    if not found:
        return []
    indices = cv2.dnn.NMSBoxes(
        [row["box"] for row in found],
        [row["score"] for row in found],
        score_threshold=threshold,
        nms_threshold=0.3,
    )
    keep = {int(index) for index in np.array(indices).reshape(-1)} if len(indices) else set()
    return [row for index, row in enumerate(found) if index in keep]


def page_camera_at(camera, progress):
    keyframes = sorted(camera.get("keyframes") or [], key=lambda k: k.get("at", 0))
    if len(keyframes) < 2:
        keyframes = [
            {"at": 0, "zoom": camera.get("zoomStart", 1), "focusX": camera.get("focusX", 0.5), "focusY": camera.get("focusY", 0.5)},
            {"at": 1, "zoom": camera.get("zoomEnd", 1), "focusX": camera.get("focusXEnd", 0.5), "focusY": camera.get("focusYEnd", 0.5)},
        ]
    progress = clamp(progress, 0, 1)
    left, right = keyframes[0], keyframes[-1]
    for i in range(len(keyframes) - 1):
        if progress <= keyframes[i + 1].get("at", 1) + 1e-9:
            left, right = keyframes[i], keyframes[i + 1]
            break
    span = max(1e-9, right.get("at", 1) - left.get("at", 0))
    local = clamp((progress - left.get("at", 0)) / span, 0, 1)
    zl, zr = max(1e-6, left.get("zoom", 1)), max(1e-6, right.get("zoom", 1))
    zoom = zl * (zr / zl) ** local
    fx = left.get("focusX", 0.5) + (right.get("focusX", 0.5) - left.get("focusX", 0.5)) * local
    fy = left.get("focusY", 0.5) + (right.get("focusY", 0.5) - left.get("focusY", 0.5)) * local
    return zoom, fx, fy


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--video", default=None)
    parser.add_argument("--cascade", type=Path, default=DEFAULT_CASCADE)
    parser.add_argument("--turnaround", action="append", default=[], help="Optional CHARACTER_ID=PATH template source")
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--max-cover", type=float, default=0.35)
    parser.add_argument("--generic-max-cover", type=float, default=0.35)
    parser.add_argument("--template-threshold", type=float, default=0.72)
    parser.add_argument("--template-analysis-scale", type=float, default=0.5)
    args = parser.parse_args()
    manifest_path = args.manifest.resolve()
    manifest = read_json(manifest_path)
    video_path = args.video or manifest.get("outputs", {}).get("reviewVideo", {}).get("filePath") or manifest["outputs"]["finalVideo"]["filePath"]
    episode_dir = manifest_path.parent
    output_path = args.output.resolve() if args.output else episode_dir / "bubble-faces-independent-audit.json"
    frames_dir = episode_dir / "audits" / "bubble-faces-independent"
    frames_dir.mkdir(parents=True, exist_ok=True)
    cascade = cv2.CascadeClassifier(str(args.cascade))
    if cascade.empty():
        raise SystemExit("anime face cascade missing")
    explicit = []
    for value in args.turnaround:
        character_id, separator, raw_path = value.partition("=")
        if not separator:
            raise SystemExit(f"--turnaround must be CHARACTER_ID=PATH: {value}")
        explicit.append((character_id, Path(raw_path).resolve()))
    turnaround_paths = explicit or registry_turnarounds(manifest_path, manifest)
    templates = extract_sheet_templates(cascade, turnaround_paths)
    cuts = {c["id"]: c for c in manifest["cuts"]}
    capture = cv2.VideoCapture(str(video_path))
    rows = []
    for utterance in manifest["utterances"]:
        cut = cuts[utterance["cutId"]]
        is_panel = bool(cut.get("panelLayout", {}).get("enabled"))
        timing = utterance["timing"]
        audio_start = float(timing.get("audioStartSeconds", timing["bubbleStartSeconds"]))
        spec = read_json(utterance["overlaySpecPath"])
        overlay_w = float(spec.get("imageSize", {}).get("width") or 1920)
        overlay_h = float(spec.get("imageSize", {}).get("height") or 1080)
        entries = []
        segments = [s for s in (utterance.get("bubbleSegments") or []) if isinstance(s.get("bounds"), dict)]
        if segments:
            for segment in segments:
                s0 = audio_start + float(segment.get("startOffsetSeconds", 0))
                s1 = audio_start + float(segment.get("endOffsetSeconds", 0))
                entries.append((segment["id"], segment["bounds"], max(s0, float(timing["bubbleStartSeconds"])), min(s1, float(timing["bubbleEndSeconds"]))))
        else:
            bubble = (spec.get("plan", {}).get("bubbles") or [{}])[0]
            if isinstance(bubble.get("bounds"), dict):
                entries.append((utterance["id"], bubble["bounds"], float(timing["bubbleStartSeconds"]), float(timing["bubbleEndSeconds"])))
        for entry_id, bounds, start, end in entries:
            worst_active = {"cover": 0.0}
            worst_generic = {"cover": 0.0}
            detected_face_count = 0
            ignored_overlay_artifact_count = 0
            ignored_flat_background_count = 0
            active_speaker_id = utterance.get("speakerId") if utterance.get("preset") != "narration" else None
            active_templates = [row for row in templates if row[0] == active_speaker_id]
            for u in (0.3, 0.5, 0.75):
                t = start + (end - start) * u
                capture.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
                ok, frame = capture.read()
                if not ok or frame is None:
                    continue
                fh, fw = frame.shape[:2]
                # bubble rect on SCREEN at time t
                bx0 = float(bounds["x"]) / overlay_w
                by0 = float(bounds["y"]) / overlay_h
                bx1 = (float(bounds["x"]) + float(bounds["width"])) / overlay_w
                by1 = (float(bounds["y"]) + float(bounds["height"])) / overlay_h
                if is_panel:
                    camera = cut["panelLayout"].get("pageCamera") or {}
                    duration = float(cut["timing"]["durationSeconds"])
                    progress = clamp((t - float(cut["timing"]["startSeconds"])) / max(1e-6, duration), 0, 1)
                    zoom, fx, fy = page_camera_at(camera, progress)
                    crop = 1.0 / zoom
                    ox = clamp(fx - crop / 2, 0, max(0, 1 - crop))
                    oy = clamp(fy - crop / 2, 0, max(0, 1 - crop))
                    bx0, bx1 = (bx0 - ox) * zoom, (bx1 - ox) * zoom
                    by0, by1 = (by0 - oy) * zoom, (by1 - oy) * zoom
                rect = (bx0 * fw, by0 * fh, bx1 * fw, by1 * fh)
                faces = [
                    {"box": [x, y, w, h], "characterId": None, "score": 1.0, "method": "anime-cascade"}
                    for (x, y, w, h) in detect_faces(cascade, frame)
                ] + template_faces(
                    active_templates,
                    frame,
                    threshold=args.template_threshold,
                    analysis_scale=args.template_analysis_scale,
                )
                detected_face_count += len(faces)
                for face in faces:
                    x, y, w, h = face["box"]
                    ix0, iy0 = max(rect[0], x), max(rect[1], y)
                    ix1, iy1 = min(rect[2], x + w), min(rect[3], y + h)
                    inter = max(0, ix1 - ix0) * max(0, iy1 - iy0)
                    cover = inter / max(1.0, w * h)
                    if rendered_detection_is_overlay_artifact(face, cover):
                        ignored_overlay_artifact_count += 1
                        continue
                    visible_evidence = visible_detection_evidence(frame, face["box"], rect)
                    if rendered_detection_is_flat_visible_background(face, cover, visible_evidence):
                        ignored_flat_background_count += 1
                        continue
                    is_active = face.get("characterId") == active_speaker_id and active_speaker_id is not None
                    worst = worst_active if is_active else worst_generic
                    limit = args.max_cover if is_active else args.generic_max_cover
                    if cover > worst["cover"]:
                        worst.update({
                            "cover": cover,
                            "face": [x, y, w, h],
                            "timeSeconds": round(t, 2),
                            "method": face.get("method"),
                            "characterId": face.get("characterId"),
                            "score": round(float(face.get("score", 0)), 4),
                        })
                        if cover > limit:
                            marked = frame.copy()
                            cv2.rectangle(marked, (x, y), (x + w, y + h), (0, 0, 255), 3)
                            cv2.rectangle(marked, (int(rect[0]), int(rect[1])), (int(rect[2]), int(rect[3])), (255, 0, 0), 2)
                            cv2.imwrite(str(frames_dir / f"FAIL-{entry_id}.jpg"), marked, [cv2.IMWRITE_JPEG_QUALITY, 88])
            rows.append({
                "bubbleId": entry_id,
                "utteranceId": utterance["id"],
                "activeSpeakerId": active_speaker_id,
                "activeTemplateCount": len(active_templates),
                "worstActiveSpeakerFaceCover": round(worst_active["cover"], 3),
                "worstGenericFaceCover": round(worst_generic["cover"], 3),
                "detectedFaceCount": detected_face_count,
                "ignoredFullyContainedOverlayArtifactCount": ignored_overlay_artifact_count,
                "ignoredFlatVisibleBackgroundCount": ignored_flat_background_count,
                **({"worstActiveSpeakerFace": worst_active} if worst_active["cover"] > 0 else {}),
                **({"worstGenericFace": worst_generic} if worst_generic["cover"] > 0 else {}),
                "pass": worst_active["cover"] <= args.max_cover and worst_generic["cover"] <= args.generic_max_cover,
            })
    capture.release()
    result = {
        "version": "bubble-faces-independent-v3-visible-face-evidence",
        "videoPath": str(video_path),
        "maxCover": args.max_cover,
        "genericMaxCover": args.generic_max_cover,
        "activeTemplateThreshold": args.template_threshold,
        "method": "rendered-frame anime cascade for any face + active-speaker-only approved registry templates; no shot annotations used; fully opaque-bubble-contained glyph hits and partial cascade hits with a large flat/edgeless/dark-free visible remainder excluded",
        "turnaroundPaths": [str(path) for _, path in turnaround_paths],
        "templateCount": len(templates),
        "rows": rows,
        "pass": all(r["pass"] for r in rows),
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=1))
    print(json.dumps({"pass": result["pass"], "failures": [r for r in rows if not r["pass"]], "checked": len(rows)}, ensure_ascii=False))
    if not result["pass"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
