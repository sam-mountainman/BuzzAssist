#!/usr/bin/env python3
"""Rendered-video gate for the inner-voice spotlight.

For every thought utterance, samples multiple timestamps across its display
interval, projects the speaker's source-image face rectangle through the
shot camera at that exact time, and verifies on the real frame that:

1. the face region is brighter than its surroundings (the dim must not cover
   the face), and
2. the surroundings are actually dimmed (the effect exists at all).

This gate exists because the earlier screen-space compositing bug (a static
spotlight while the camera moved) passed every prior audit. The spotlight is
now baked into the source image before the camera, so the bright region must
track the face at every sampled camera position by construction — and this
script proves it on the rendered pixels.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np


def read_json(path: Path) -> dict:
    return json.loads(path.read_text())


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def camera_at(camera: dict, progress: float) -> tuple[float, float, float]:
    keyframes = camera.get("keyframes") or []
    if len(keyframes) < 2:
        keyframes = [
            {"at": 0, "zoom": camera.get("zoomStart", 1), "focusX": camera.get("focusX", 0.5), "focusY": camera.get("focusY", 0.5)},
            {"at": 1, "zoom": camera.get("zoomEnd", 1), "focusX": camera.get("focusXEnd", camera.get("focusX", 0.5)), "focusY": camera.get("focusYEnd", camera.get("focusY", 0.5))},
        ]
    keyframes = sorted(keyframes, key=lambda entry: float(entry.get("at", 0)))
    progress = clamp(progress, 0.0, 1.0)
    left, right = keyframes[0], keyframes[-1]
    for index in range(len(keyframes) - 1):
        if progress <= float(keyframes[index + 1].get("at", 1)) + 1e-9:
            left, right = keyframes[index], keyframes[index + 1]
            break
    span = max(1e-9, float(right.get("at", 1)) - float(left.get("at", 0)))
    local = clamp((progress - float(left.get("at", 0))) / span, 0.0, 1.0)
    zoom_left = max(1e-6, float(left.get("zoom", 1)))
    zoom_right = max(1e-6, float(right.get("zoom", 1)))
    zoom = zoom_left * (zoom_right / zoom_left) ** local
    focus_x = float(left.get("focusX", 0.5)) + (float(right.get("focusX", 0.5)) - float(left.get("focusX", 0.5))) * local
    focus_y = float(left.get("focusY", 0.5)) + (float(right.get("focusY", 0.5)) - float(left.get("focusY", 0.5))) * local
    return zoom, focus_x, focus_y


def project_rect(rect: dict, zoom: float, focus_x: float, focus_y: float) -> tuple[float, float, float, float] | None:
    crop = 1.0 / zoom
    origin_x = clamp(focus_x - crop / 2, 0.0, max(0.0, 1.0 - crop))
    origin_y = clamp(focus_y - crop / 2, 0.0, max(0.0, 1.0 - crop))
    left = clamp((rect["x"] - origin_x) * zoom, 0.0, 1.0)
    top = clamp((rect["y"] - origin_y) * zoom, 0.0, 1.0)
    right = clamp((rect["x"] + rect["width"] - origin_x) * zoom, 0.0, 1.0)
    bottom = clamp((rect["y"] + rect["height"] - origin_y) * zoom, 0.0, 1.0)
    if right <= left or bottom <= top:
        return None
    return left, top, right, bottom


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=Path("canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json"))
    parser.add_argument("--video", type=Path, default=None)
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--samples", type=int, default=5)
    parser.add_argument("--min-face-advantage", type=float, default=8.0,
                        help="Face mean luma must exceed surround mean luma by this many 8-bit steps.")
    args = parser.parse_args()
    manifest = read_json(args.manifest)
    video_path = args.video or Path(manifest["outputs"]["finalVideo"]["filePath"])
    episode_dir = args.manifest.parent
    output_path = args.output or episode_dir / "thought-spotlight-rendered-audit.json"
    frames_dir = episode_dir / "audits" / "thought-spotlight-frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    cuts = {cut["id"]: cut for cut in manifest["cuts"]}
    rows = []
    for utterance in manifest["utterances"]:
        if utterance.get("preset") != "thought":
            continue
        cut = cuts[utterance["cutId"]]
        shot = None
        for candidate in cut.get("cameraSequence", []):
            if utterance["id"] in (candidate.get("utteranceIds") or []):
                shot = candidate
                break
        if shot is None:
            rows.append({"utteranceId": utterance["id"], "pass": False, "reason": "no-camera-shot"})
            continue
        face = (shot.get("sourceFaceBoundsBySpeakerId") or {}).get(utterance["speakerId"])
        if not face:
            rows.append({"utteranceId": utterance["id"], "pass": False, "reason": "no-source-face"})
            continue
        source_image = cv2.imread(str(shot.get("imagePath") or cut.get("imagePath")))
        if source_image is None:
            rows.append({"utteranceId": utterance["id"], "pass": False, "reason": "source-image-unreadable"})
            continue
        timing = utterance["timing"]
        start = float(timing["bubbleStartSeconds"])
        end = float(timing["bubbleEndSeconds"])
        cut_start = float(cut["timing"]["startSeconds"])

        spec = read_json(Path(utterance["overlaySpecPath"]))
        bubble_bounds = []
        segs = utterance.get("bubbleSegments") or []
        if segs:
            audio_start = float(timing.get("audioStartSeconds", start))
            for seg in segs:
                if isinstance(seg.get("bounds"), dict):
                    s0 = audio_start + float(seg.get("startOffsetSeconds", start - audio_start))
                    s1 = audio_start + float(seg.get("endOffsetSeconds", end - audio_start))
                    bubble_bounds.append((seg["bounds"], s0, s1))
        else:
            plan_bubble = (spec.get("plan", {}).get("bubbles") or [{}])[0]
            if isinstance(plan_bubble.get("bounds"), dict):
                bubble_bounds.append((plan_bubble["bounds"], start, end))

        def bubble_rects_at(t, margin=30, frame_w=1920, frame_h=1080):
            rects = []
            for bounds, s0, s1 in bubble_bounds:
                if t < s0 - 0.05 or t > s1 + 0.05:
                    continue
                bx0 = int(clamp(float(bounds["x"]) - margin, 0, frame_w))
                by0 = int(clamp(float(bounds["y"]) - margin, 0, frame_h))
                bx1 = int(clamp(float(bounds["x"]) + float(bounds["width"]) + margin, 0, frame_w))
                by1 = int(clamp(float(bounds["y"]) + float(bounds["height"]) + margin, 0, frame_h))
                rects.append((bx0, by0, bx1, by1))
            return rects
        # Shot-local timing to derive the camera progress at each sample.
        shot_start = None
        shot_duration = None
        # Recover shot boundaries the same way the renderer assigns them: the
        # utterance interval is inside the shot, so progress uses the shot's
        # own authored window when available, else the utterance window.
        if shot.get("startSeconds") is not None and shot.get("endSeconds") is not None:
            shot_start = cut_start + float(shot["startSeconds"])
            shot_duration = float(shot["endSeconds"]) - float(shot["startSeconds"])
        samples = []
        capture = cv2.VideoCapture(str(video_path))
        for index in range(args.samples):
            inset = 0.12
            u = inset + (1 - 2 * inset) * index / max(1, args.samples - 1)
            t = start + (end - start) * u
            if shot_start is not None and shot_duration and shot_duration > 0:
                progress = clamp((t - shot_start) / shot_duration, 0.0, 1.0)
            else:
                progress = clamp((t - start) / max(1e-6, end - start), 0.0, 1.0)
            zoom, focus_x, focus_y = camera_at(shot.get("camera") or {}, progress)
            projected = project_rect(
                {"x": float(face["x"]), "y": float(face["y"]), "width": float(face["width"]), "height": float(face["height"])},
                zoom, focus_x, focus_y,
            )
            capture.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
            ok, frame = capture.read()
            if not ok or frame is None or projected is None:
                samples.append({"timeSeconds": round(t, 3), "pass": False, "reason": "frame-or-projection-failed"})
                continue
            height, width = frame.shape[:2]
            # Reconstruct what this camera crop looks like WITHOUT the dim from
            # the original source illustration, then compare per-pixel
            # luminance ratios. Dimmed pixels sit near the authored 0.69
            # multiplier, spotlighted pixels near 1.0, so the ratio map
            # separates the effect from scene content.
            crop_w = 1.0 / zoom
            origin_x = clamp(focus_x - crop_w / 2, 0.0, max(0.0, 1.0 - crop_w))
            origin_y = clamp(focus_y - crop_w / 2, 0.0, max(0.0, 1.0 - crop_w))
            sh, sw = source_image.shape[:2]
            cx0, cy0 = int(origin_x * sw), int(origin_y * sh)
            cx1, cy1 = int((origin_x + crop_w) * sw), int((origin_y + crop_w) * sh)
            expected = cv2.resize(source_image[cy0:cy1, cx0:cx1], (width, height), interpolation=cv2.INTER_AREA)
            rendered_luma = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float32)
            expected_luma = cv2.cvtColor(expected, cv2.COLOR_BGR2GRAY).astype(np.float32)
            ratio = (rendered_luma + 1.0) / (expected_luma + 1.0)
            valid = expected_luma > 24
            for bx0, by0, bx1, by1 in bubble_rects_at(t):
                valid[by0:by1, bx0:bx1] = False
            if valid.sum() < 0.2 * width * height:
                samples.append({"timeSeconds": round(t, 3), "pass": False, "reason": "not-enough-valid-pixels"})
                continue
            dim_fraction = float(((ratio < 0.82) & valid).sum() / max(1, valid.sum()))
            x0, y0, x1, y1 = (int(projected[0] * width), int(projected[1] * height),
                              int(projected[2] * width), int(projected[3] * height))
            face_valid = valid[y0:y1, x0:x1]
            face_ratio_patch = ratio[y0:y1, x0:x1]
            if face_valid.sum() < 40:
                samples.append({"timeSeconds": round(t, 3), "pass": False, "reason": "face-patch-not-measurable"})
                continue
            face_median_ratio = float(np.median(face_ratio_patch[face_valid]))
            fcx0 = max(x0, (x0 + x1) // 2 - (x1 - x0) // 6)
            fcx1 = min(x1, (x0 + x1) // 2 + (x1 - x0) // 6)
            fcy0 = max(y0, (y0 + y1) // 2 - (y1 - y0) // 6)
            fcy1 = min(y1, (y0 + y1) // 2 + (y1 - y0) // 6)
            center_valid = valid[fcy0:fcy1, fcx0:fcx1]
            center_ratio = ratio[fcy0:fcy1, fcx0:fcx1]
            face_center_ratio = float(np.median(center_ratio[center_valid])) if center_valid.sum() >= 9 else face_median_ratio
            dim_exists = dim_fraction >= 0.25
            face_clear = face_center_ratio >= 0.9 and face_median_ratio >= 0.86
            sample_pass = bool(dim_exists and face_clear)
            frame_path = frames_dir / f"{utterance['id']}-{index + 1}.jpg"
            marked = frame.copy()
            cv2.rectangle(marked, (x0, y0), (x1, y1), (0, 255, 0) if sample_pass else (0, 0, 255), 3)
            cv2.imwrite(str(frame_path), marked, [cv2.IMWRITE_JPEG_QUALITY, 90])
            samples.append({
                "timeSeconds": round(t, 3),
                "cameraProgress": round(progress, 4),
                "zoom": round(zoom, 4),
                "projectedFace": [round(v, 4) for v in projected],
                "dimmedPixelFraction": round(dim_fraction, 4),
                "faceMedianRatio": round(face_median_ratio, 4),
                "faceCenterRatio": round(face_center_ratio, 4),
                "framePath": str(frame_path),
                "pass": sample_pass,
                **({} if dim_exists else {"reason": "no-dim-detected"}),
                **({} if face_clear else {"reason": "face-dimmed-or-spot-missed"}),
            })
        capture.release()
        rows.append({
            "utteranceId": utterance["id"],
            "shotId": shot.get("id"),
            "samples": samples,
            "pass": bool(samples) and all(sample["pass"] for sample in samples),
        })

    result = {
        "version": "thought-spotlight-rendered-audit-v1",
        "videoPath": str(video_path),
        "minFaceAdvantage": args.min_face_advantage,
        "rows": rows,
        "pass": bool(rows) and all(row["pass"] for row in rows),
    }
    output_path.write_text(json.dumps(result, indent=1))
    print(json.dumps({"pass": result["pass"], "rows": [{"id": r["utteranceId"], "pass": r["pass"]} for r in rows], "output": str(output_path)}, ensure_ascii=False))
    if not result["pass"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
