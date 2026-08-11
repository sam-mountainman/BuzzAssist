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

CASCADE = Path("scripts/data/lbpcascade_animeface.xml")
TURNAROUNDS = {
    "character-1": "canvas/assets/manga-photo-homecoming-001-character-1-turnaround.png",
    "character-2": "canvas/assets/manga-photo-homecoming-001-character-2-turnaround.png",
    "character-3": "canvas/assets/manga-photo-homecoming-001-character-3-turnaround.png",
}


def read_json(path):
    return json.loads(Path(path).read_text())


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def detect_faces(cascade, frame):
    gray = cv2.equalizeHist(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
    height = frame.shape[0]
    raw = cascade.detectMultiScale(gray, scaleFactor=1.05, minNeighbors=3, minSize=(56, 56))
    return [
        (int(x), int(y), int(w), int(h)) for (x, y, w, h) in raw
        if h <= 0.45 * height
    ]


def extract_sheet_templates(cascade):
    templates = []
    for character_id, sheet_path in TURNAROUNDS.items():
        sheet = cv2.imread(sheet_path)
        if sheet is None:
            continue
        for (x, y, w, h) in detect_faces(cascade, sheet):
            patch = sheet[y:y + h, x:x + w]
            if patch.size:
                templates.append((character_id, cv2.resize(patch, (96, 96))))
    return templates


def template_faces(templates, frame, threshold=0.62):
    found = []
    gray_frame = frame
    for character_id, template in templates:
        for size in (90, 130, 180, 250, 340):
            resized = cv2.resize(template, (size, size))
            if size >= frame.shape[0] or size >= frame.shape[1]:
                continue
            result = cv2.matchTemplate(gray_frame, resized, cv2.TM_CCOEFF_NORMED)
            _, best, _, loc = cv2.minMaxLoc(result)
            if best >= threshold:
                found.append((loc[0], loc[1], size, size))
    return found


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
    parser.add_argument("--manifest", default="canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json")
    parser.add_argument("--video", default=None)
    parser.add_argument("--max-cover", type=float, default=0.35)
    args = parser.parse_args()
    manifest = read_json(args.manifest)
    video_path = args.video or manifest["outputs"]["finalVideo"]["filePath"]
    episode_dir = Path(args.manifest).parent
    frames_dir = episode_dir / "audits" / "bubble-faces-independent"
    frames_dir.mkdir(parents=True, exist_ok=True)
    cascade = cv2.CascadeClassifier(str(CASCADE))
    if cascade.empty():
        raise SystemExit("anime face cascade missing")
    templates = extract_sheet_templates(cascade)
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
            worst = {"cover": 0.0}
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
                faces = detect_faces(cascade, frame) + template_faces(templates, frame)
                for (x, y, w, h) in faces:
                    ix0, iy0 = max(rect[0], x), max(rect[1], y)
                    ix1, iy1 = min(rect[2], x + w), min(rect[3], y + h)
                    inter = max(0, ix1 - ix0) * max(0, iy1 - iy0)
                    cover = inter / max(1.0, w * h)
                    if cover > worst["cover"]:
                        worst = {"cover": cover, "face": [x, y, w, h], "timeSeconds": round(t, 2)}
                        if cover > args.max_cover:
                            marked = frame.copy()
                            cv2.rectangle(marked, (x, y), (x + w, y + h), (0, 0, 255), 3)
                            cv2.rectangle(marked, (int(rect[0]), int(rect[1])), (int(rect[2]), int(rect[3])), (255, 0, 0), 2)
                            cv2.imwrite(str(frames_dir / f"FAIL-{entry_id}.jpg"), marked, [cv2.IMWRITE_JPEG_QUALITY, 88])
            rows.append({
                "bubbleId": entry_id,
                "utteranceId": utterance["id"],
                "worstFaceCover": round(worst["cover"], 3),
                **({"worstFace": worst.get("face"), "atSeconds": worst.get("timeSeconds")} if worst["cover"] > 0 else {}),
                "pass": worst["cover"] <= args.max_cover,
            })
    capture.release()
    result = {
        "version": "bubble-faces-independent-v1",
        "videoPath": str(video_path),
        "maxCover": args.max_cover,
        "method": "anime cascade + turnaround-sheet templates; no shot annotations used",
        "rows": rows,
        "pass": all(r["pass"] for r in rows),
    }
    (episode_dir / "bubble-faces-independent-audit.json").write_text(json.dumps(result, indent=1))
    print(json.dumps({"pass": result["pass"], "failures": [r for r in rows if not r["pass"]], "checked": len(rows)}, ensure_ascii=False))
    if not result["pass"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
