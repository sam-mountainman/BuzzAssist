#!/usr/bin/env python3
"""Real-MP4 audit for cuts replaced by generated clips (opt-in video substitution).

The JS side (lib/mangaCutVideoSubstitution.mjs) writes an analysis plan that
owns all geometry: which rendered frames belong to each substituted cut, the
exact conform filter the renderer used, the timed bubble rasters, and the
start-frame hard-protection regions projected through the approved camera.
This script only measures pixels.

For every substituted cut it decodes two frame streams in lockstep:

  M  the final MP4, frames [startFrame, startFrame + frameCount)
  C  the generated clip conformed exactly like the renderer (bubble-free)

and checks:

  * decode           both streams decode without error and yield frameCount frames
  * input-sha        clip and start frame bytes match the bound SHA-256
  * clip-in-mp4      outside the rendered bubble alpha, M matches C frame by frame
                     (the MP4 really carries this clip, in this frame range)
  * start-frame      SSIM(C[0], approved start frame) >= contract minimum, using
                     the same ffmpeg graph as generation-time validation
  * motion           the clip is not a still, has no frozen stretch, and is not
                     padded at the tail beyond the allowed shortfall
  * palette          no gross colour/scene drift from the approved still
  * faces            dense samples: no cascade face on the bubble-free clip frame
                     touches an active bubble (0 px), and every start-frame hard
                     region, tracked with optical flow, stays 0 px from bubbles
  * text             OCR on the real MP4 frame (bubbles masked) finds no
                     persistent text that the approved still did not already have

Machine gates catch gross failure only. Whether the characters are still the
same people is decided by the perceptual review of real frames, which the
final audit requires separately for each substituted cut.
"""
import argparse
import hashlib
import importlib.util
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
ANALYSIS_SIZE = (480, 270)
TRACK_SIZE = (960, 540)
# The final MP4 is an x264 re-encode of the conformed clip. Outside the bubble
# alpha the two differ only by coding noise; a wrong clip or a still render
# differs far more.
MAXIMUM_CLIP_BINDING_MAE = 8.0
IDENTICAL_FRAME_MAE = 0.02
MINIMUM_MOTION_ENERGY = 0.08
MAXIMUM_IDENTICAL_RUN = 3
MINIMUM_PALETTE_CORRELATION = 0.5
BUBBLE_MASK_MARGIN = 4
OCR_MINIMUM_CONFIDENCE = 80
OCR_MINIMUM_PERSISTENCE = 2
TRACK_MINIMUM_POINTS = 4
LOST_REGION_MARGIN = 0.25


def load_independent_face_module():
    """Reuse the independent rendered-face detector instead of a second copy."""
    path = HERE / "audit-manga-bubble-faces-independent.py"
    spec = importlib.util.spec_from_file_location("manga_independent_faces", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


FACES = load_independent_face_module()


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class FrameStream:
    """Stream fixed-size BGR frames from ffmpeg without buffering the clip."""

    def __init__(self, args, width, height):
        self.width = width
        self.height = height
        self.frame_bytes = width * height * 3
        self.stderr = tempfile.TemporaryFile()
        self.process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=self.stderr)
        self.count = 0

    def read(self):
        buffer = self.process.stdout.read(self.frame_bytes)
        if len(buffer) < self.frame_bytes:
            return None
        self.count += 1
        return np.frombuffer(buffer, np.uint8).reshape(self.height, self.width, 3)

    def close(self):
        self.process.stdout.close()
        code = self.process.wait()
        self.stderr.seek(0)
        message = self.stderr.read().decode("utf-8", "replace")[-800:]
        self.stderr.close()
        return code, message


def mp4_stream(video_path, start_frame, frame_count, width, height):
    end_frame = start_frame + frame_count - 1
    return FrameStream([
        "ffmpeg", "-hide_banner", "-v", "error", "-xerror", "-i", str(video_path),
        "-vf", f"select=between(n\\,{start_frame}\\,{end_frame})",
        "-fps_mode", "passthrough", "-frames:v", str(frame_count),
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-",
    ], width, height)


def clip_stream(clip_path, conform_filter, frame_count, width, height):
    return FrameStream([
        "ffmpeg", "-hide_banner", "-v", "error", "-xerror", "-i", str(clip_path),
        "-vf", f"{conform_filter},format=bgr24",
        # rawvideo would otherwise default to 25 fps and silently drop frames.
        "-fps_mode", "passthrough",
        "-frames:v", str(frame_count), "-f", "rawvideo", "-pix_fmt", "bgr24", "-",
    ], width, height)


def start_frame_ssim(clip_path, start_frame_path, graph):
    result = subprocess.run([
        "ffmpeg", "-hide_banner", "-i", str(clip_path), "-i", str(start_frame_path),
        "-lavfi", graph, "-f", "null", "-",
    ], capture_output=True, text=True)
    match = re.search(r"All:([0-9.]+)", result.stderr or "")
    return float(match.group(1)) if result.returncode == 0 and match else None


def bubble_rects(bubbles, width, height):
    rows = []
    for bubble in bubbles:
        geometry = FACES.rendered_overlay_geometry(bubble.get("rasterPath"))
        if not geometry:
            rows.append({**bubble, "rect": None})
            continue
        bounds = geometry["bounds"]
        size = geometry["imageSize"]
        scale_x = width / float(size["width"] or width)
        scale_y = height / float(size["height"] or height)
        offset = bubble.get("renderOffset") or {}
        x0 = bounds["x"] * scale_x + float(offset.get("x") or 0)
        y0 = bounds["y"] * scale_y + float(offset.get("y") or 0)
        rows.append({
            **bubble,
            "rect": [x0, y0, x0 + bounds["width"] * scale_x, y0 + bounds["height"] * scale_y],
        })
    return rows


def active_bubbles(rows, seconds):
    # Same inclusive window as the renderer's between(t,start,end).
    return [row for row in rows if row["rect"] and row["startInCut"] - 1e-6 <= seconds <= row["endInCut"] + 1e-6]


def rect_intersection_area(rect, box):
    x, y, w, h = box
    ix0, iy0 = max(rect[0], x), max(rect[1], y)
    ix1, iy1 = min(rect[2], x + w), min(rect[3], y + h)
    return max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)


def bubble_mask(active, width, height):
    mask = np.zeros((height, width), dtype=np.uint8)
    for row in active:
        x0, y0, x1, y1 = row["rect"]
        cv2.rectangle(
            mask,
            (int(max(0, x0 - BUBBLE_MASK_MARGIN)), int(max(0, y0 - BUBBLE_MASK_MARGIN))),
            (int(min(width - 1, x1 + BUBBLE_MASK_MARGIN)), int(min(height - 1, y1 + BUBBLE_MASK_MARGIN))),
            255,
            thickness=-1,
        )
    return mask


def masked_mae(left, right, mask):
    a = cv2.resize(left, ANALYSIS_SIZE, interpolation=cv2.INTER_AREA).astype(np.int16)
    b = cv2.resize(right, ANALYSIS_SIZE, interpolation=cv2.INTER_AREA).astype(np.int16)
    # Downscaling blends pixels across the bubble edge; shrink the compared
    # area by one analysis pixel so only clean background is compared.
    clear = (cv2.resize(mask, ANALYSIS_SIZE, interpolation=cv2.INTER_NEAREST) == 0).astype(np.uint8)
    keep = cv2.erode(clear, np.ones((3, 3), np.uint8)) > 0
    if not keep.any():
        return None
    return float(np.abs(a - b)[keep].mean())


def gray_small(frame):
    return cv2.cvtColor(cv2.resize(frame, ANALYSIS_SIZE, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)


def palette_correlation(frame, reference, mask=None):
    def histogram(image, image_mask):
        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], image_mask, [30, 16], [0, 180, 0, 256])
        return cv2.normalize(hist, hist).flatten()
    inverse = None if mask is None else cv2.bitwise_not(mask)
    return float(cv2.compareHist(histogram(frame, inverse), histogram(reference, None), cv2.HISTCMP_CORREL))


def fill_masked(frame, mask):
    if not mask.any():
        return frame
    filled = frame.copy()
    visible = frame[mask == 0]
    color = np.median(visible, axis=0) if visible.size else np.array([255, 255, 255])
    filled[mask > 0] = color.astype(np.uint8)
    return filled


OCR_TOKEN = re.compile(r"[0-9A-Za-z぀-ヿ一-鿿]")


def ocr_tokens(image):
    """Return normalised high-confidence OCR tokens, or None if OCR is unavailable."""
    binary = shutil.which("tesseract")
    if not binary:
        return None
    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        return None
    result = subprocess.run(
        [binary, "stdin", "stdout", "-l", "jpn+eng", "--psm", "11", "tsv"],
        input=encoded.tobytes(), capture_output=True,
    )
    if result.returncode != 0:
        return None
    tokens = set()
    for line in result.stdout.decode("utf-8", "replace").splitlines()[1:]:
        columns = line.split("\t")
        if len(columns) < 12:
            continue
        try:
            confidence = float(columns[10])
        except ValueError:
            continue
        text = "".join(OCR_TOKEN.findall(columns[11]))
        if confidence >= OCR_MINIMUM_CONFIDENCE and len(text) >= 2:
            tokens.add(text)
    return tokens


class RegionTracker:
    """Follow a start-frame protection box through the clip with sparse LK flow."""

    def __init__(self, region, width, height):
        self.id = region["id"]
        self.kind = region.get("kind", "region")
        self.scale = (TRACK_SIZE[0] / width, TRACK_SIZE[1] / height)
        self.box = [
            region["x"] * self.scale[0], region["y"] * self.scale[1],
            region["width"] * self.scale[0], region["height"] * self.scale[1],
        ]
        self.lost_at = None
        self.last_box = list(self.box)

    def full_box(self, box=None):
        x, y, w, h = box or self.box
        return [x / self.scale[0], y / self.scale[1], w / self.scale[0], h / self.scale[1]]

    def points(self, gray):
        x, y, w, h = [int(round(value)) for value in self.box]
        mask = np.zeros_like(gray)
        cv2.rectangle(mask, (max(0, x), max(0, y)), (min(gray.shape[1] - 1, x + w), min(gray.shape[0] - 1, y + h)), 255, -1)
        return cv2.goodFeaturesToTrack(gray, maxCorners=40, qualityLevel=0.01, minDistance=3, mask=mask)

    def step(self, previous_gray, gray, frame_index):
        if self.lost_at is not None:
            return
        points = self.points(previous_gray)
        if points is None or len(points) < TRACK_MINIMUM_POINTS:
            self.lost_at = frame_index
            return
        moved, status, _ = cv2.calcOpticalFlowPyrLK(previous_gray, gray, points, None, winSize=(21, 21), maxLevel=3)
        good = status.reshape(-1) == 1
        if good.sum() < TRACK_MINIMUM_POINTS:
            self.lost_at = frame_index
            return
        before = points.reshape(-1, 2)[good]
        after = moved.reshape(-1, 2)[good]
        dx, dy = np.median(after - before, axis=0)
        spread_before = np.linalg.norm(before - before.mean(axis=0), axis=1).mean()
        spread_after = np.linalg.norm(after - after.mean(axis=0), axis=1).mean()
        scale = float(np.clip(spread_after / spread_before, 0.8, 1.25)) if spread_before > 1e-3 else 1.0
        x, y, w, h = self.box
        cx, cy = x + w / 2 + float(dx), y + h / 2 + float(dy)
        w, h = w * scale, h * scale
        self.box = [cx - w / 2, cy - h / 2, w, h]
        self.last_box = list(self.box)

    def guard_box(self):
        """Box to test against bubbles; a lost region is widened, not dropped."""
        if self.lost_at is None:
            return self.full_box()
        x, y, w, h = self.full_box(self.last_box)
        return [x - w * LOST_REGION_MARGIN, y - h * LOST_REGION_MARGIN, w * (1 + 2 * LOST_REGION_MARGIN), h * (1 + 2 * LOST_REGION_MARGIN)]


def save_evidence(path, frame, boxes=(), rects=()):
    path.parent.mkdir(parents=True, exist_ok=True)
    marked = frame.copy()
    for box in boxes:
        x, y, w, h = [int(round(value)) for value in box]
        cv2.rectangle(marked, (x, y), (x + w, y + h), (0, 0, 255), 3)
    for rect in rects:
        cv2.rectangle(marked, (int(rect[0]), int(rect[1])), (int(rect[2]), int(rect[3])), (255, 0, 0), 2)
    cv2.imwrite(str(path), marked, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return {"path": str(path), "sha256": sha256_file(path)}


def audit_cut(plan, cut, cascade):
    fps = float(plan["fps"])
    width, height = int(plan["width"]), int(plan["height"])
    frame_count = int(cut["frameCount"])
    frames_dir = Path(plan["framesDir"]) / cut["cutId"]
    gates = []

    def gate(gate_id, passed, detail=""):
        gates.append({"id": gate_id, "pass": bool(passed), "detail": detail})
    evidence_frames = []

    clip_path = Path(cut["clipPath"])
    start_path = Path(cut["startFramePath"])
    inputs_ok = clip_path.is_file() and start_path.is_file() \
        and sha256_file(clip_path) == cut["clipSha256"] and sha256_file(start_path) == cut["startFrameSha256"]
    gate("input-sha-verified", inputs_ok, "" if inputs_ok else "clip or start frame bytes differ from the binding")
    if not inputs_ok:
        return {"cutId": cut["cutId"], "gates": gates, "metrics": {}, "evidenceFrames": []}

    start_image = cv2.imread(str(start_path), cv2.IMREAD_COLOR)
    if start_image is None or start_image.shape[:2] != (height, width):
        gate("start-frame-readable", False, "start frame is unreadable or not the render size")
        return {"cutId": cut["cutId"], "gates": gates, "metrics": {}, "evidenceFrames": []}

    similarity = start_frame_ssim(clip_path, start_path, cut["startFrameSimilarityGraph"])
    gate(
        "start-frame-similarity",
        similarity is not None and similarity >= float(cut["minimumStartFrameSimilarity"]),
        f"ssim={similarity} minimum={cut['minimumStartFrameSimilarity']}",
    )

    rects = bubble_rects(cut["bubbles"], width, height)
    missing_rasters = [row["id"] for row in rects if row["rect"] is None]
    gate("bubble-rasters-measured", not missing_rasters, ",".join(missing_rasters))

    trackers = [RegionTracker(region, width, height) for region in cut.get("hardRegionsAtStart") or []]
    sample_step = max(1, int(round(fps / float(cut["denseFaceSamplesPerSecond"]))))
    bubble_edges = set()
    for row in rects:
        if row["rect"]:
            bubble_edges.add(max(0, min(frame_count - 1, int(np.ceil(row["startInCut"] * fps - 1e-6)))))
            bubble_edges.add(max(0, min(frame_count - 1, int(np.floor(row["endInCut"] * fps + 1e-6)))))
    face_samples = set(range(0, frame_count, sample_step)) | bubble_edges | {frame_count - 1}
    ocr_step = max(1, int(round(fps)))
    ocr_samples = set(range(0, frame_count, ocr_step)) | {frame_count - 1}

    baseline_tokens = ocr_tokens(start_image)
    ocr_available = baseline_tokens is not None
    token_hits = {}

    mp4 = mp4_stream(plan["videoPath"], int(cut["startFrame"]), frame_count, width, height)
    clip = clip_stream(clip_path, cut["conformFilter"], frame_count, width, height)
    binding_mae = []
    motion = []
    identical_run = 0
    longest_identical_run = 0
    palette = []
    face_overlaps = []
    region_overlaps = []
    face_samples_checked = 0
    previous_small = None
    previous_track = None
    for index in range(frame_count):
        mp4_frame = mp4.read()
        clip_frame = clip.read()
        if mp4_frame is None or clip_frame is None:
            break
        seconds = index / fps
        active = active_bubbles(rects, seconds)
        mask = bubble_mask(active, width, height)
        mae = masked_mae(mp4_frame, clip_frame, mask)
        if mae is not None:
            binding_mae.append(mae)

        small = gray_small(clip_frame)
        if previous_small is not None:
            difference = float(np.abs(small.astype(np.int16) - previous_small.astype(np.int16)).mean())
            motion.append(difference)
            identical_run = identical_run + 1 if difference < IDENTICAL_FRAME_MAE else 0
            longest_identical_run = max(longest_identical_run, identical_run)
        previous_small = small

        track_gray = cv2.cvtColor(cv2.resize(clip_frame, TRACK_SIZE, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
        if previous_track is not None:
            for tracker in trackers:
                tracker.step(previous_track, track_gray, index)
        previous_track = track_gray
        if active:
            hits = [
                (tracker, row) for tracker in trackers for row in active
                if rect_intersection_area(row["rect"], tracker.guard_box()) > 0
            ]
            if hits and not region_overlaps:
                evidence_frames.append({
                    "role": "region-overlap", "frameIndex": index, "timestampInCutSeconds": round(seconds, 4),
                    **save_evidence(frames_dir / f"FAIL-region-{index:05d}.jpg", mp4_frame,
                                    [tracker.guard_box() for tracker, _ in hits], [row["rect"] for row in active]),
                })
            region_overlaps.extend({
                "frameIndex": index, "regionId": tracker.id, "kind": tracker.kind,
                "bubbleId": row["id"], "lost": tracker.lost_at is not None,
            } for tracker, row in hits)

        if index in face_samples and active:
            face_samples_checked += 1
            faces = FACES.detect_faces(cascade, clip_frame)
            hits = [
                {"frameIndex": index, "bubbleId": row["id"], "face": list(face)}
                for face in faces for row in active
                if rect_intersection_area(row["rect"], face) > 0
            ]
            if hits:
                face_overlaps.extend(hits)
                evidence_frames.append({
                    "role": "face-overlap", "frameIndex": index, "timestampInCutSeconds": round(seconds, 4),
                    **save_evidence(frames_dir / f"FAIL-face-{index:05d}.jpg", mp4_frame,
                                    [hit["face"] for hit in hits], [row["rect"] for row in active]),
                })

        if index in ocr_samples:
            palette.append(palette_correlation(mp4_frame, start_image, mask))
            if ocr_available:
                tokens = ocr_tokens(fill_masked(mp4_frame, mask))
                if tokens is None:
                    ocr_available = False
                else:
                    for token in tokens - baseline_tokens:
                        token_hits.setdefault(token, []).append(index)

        if index in (0, frame_count // 2, frame_count - 1):
            role = {0: "start", frame_count // 2: "middle", frame_count - 1: "end"}[index]
            evidence_frames.append({
                "role": role, "frameIndex": index, "timestampInCutSeconds": round(seconds, 4),
                **save_evidence(frames_dir / f"{role}-{index:05d}.jpg", mp4_frame),
            })

    mp4_code, mp4_error = mp4.close()
    clip_code, clip_error = clip.close()
    gate("mp4-interval-decodes", mp4_code == 0 and mp4.count == frame_count,
         f"frames={mp4.count}/{frame_count} exit={mp4_code} {mp4_error}".strip())
    gate("clip-conform-decodes", clip_code == 0 and clip.count == frame_count,
         f"frames={clip.count}/{frame_count} exit={clip_code} {clip_error}".strip())
    gate("clip-in-mp4",
         bool(binding_mae) and max(binding_mae) <= MAXIMUM_CLIP_BINDING_MAE,
         f"maxMae={max(binding_mae) if binding_mae else None} limit={MAXIMUM_CLIP_BINDING_MAE}")
    motion_energy = float(np.mean(motion)) if motion else 0.0
    gate("clip-has-motion", motion_energy >= MINIMUM_MOTION_ENERGY,
         f"energy={motion_energy:.4f} minimum={MINIMUM_MOTION_ENERGY}")
    gate("clip-no-frozen-stretch", longest_identical_run <= MAXIMUM_IDENTICAL_RUN,
         f"longestIdenticalRun={longest_identical_run} limit={MAXIMUM_IDENTICAL_RUN}")
    allowed_tail = int(cut["maximumClipShortfallFrames"]) + 1
    gate("clip-tail-not-padded", identical_run <= allowed_tail,
         f"tailIdenticalRun={identical_run} limit={allowed_tail}")
    gate("palette-consistent-with-still",
         bool(palette) and min(palette) >= MINIMUM_PALETTE_CORRELATION,
         f"minCorrelation={min(palette) if palette else None} minimum={MINIMUM_PALETTE_CORRELATION}")
    gate("faces-clear-of-bubbles", not face_overlaps, json.dumps(face_overlaps[:5]))
    gate("protected-regions-clear-of-bubbles", not region_overlaps, json.dumps(region_overlaps[:5]))
    persistent = {token: frames for token, frames in token_hits.items() if len(frames) >= OCR_MINIMUM_PERSISTENCE}
    gate("text-detector-available", ocr_available, "" if ocr_available else "tesseract (jpn+eng) is required")
    gate("no-generated-text", ocr_available and not persistent, json.dumps(persistent, ensure_ascii=False)[:400])
    metrics = {
        "startFrameSimilarity": similarity,
        "maxClipBindingMae": max(binding_mae) if binding_mae else None,
        "meanClipBindingMae": float(np.mean(binding_mae)) if binding_mae else None,
        "motionEnergy": motion_energy,
        "longestIdenticalRun": longest_identical_run,
        "tailIdenticalRun": identical_run,
        "minimumPaletteCorrelation": min(palette) if palette else None,
        "faceSamplesWithBubbles": face_samples_checked,
        "trackedRegions": [
            {"id": tracker.id, "kind": tracker.kind, "lostAtFrame": tracker.lost_at} for tracker in trackers
        ],
        "ocrBaselineTokens": sorted(baseline_tokens or []),
        "ocrNewTokens": token_hits,
    }
    return {"cutId": cut["cutId"], "gates": gates, "metrics": metrics, "evidenceFrames": evidence_frames}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cascade", type=Path, default=HERE / "data" / "lbpcascade_animeface.xml")
    args = parser.parse_args()
    plan = json.loads(args.plan.read_text())
    cascade = cv2.CascadeClassifier(str(args.cascade))
    if cascade.empty():
        raise SystemExit("anime face cascade missing")
    cuts = [audit_cut(plan, cut, cascade) for cut in plan.get("cuts", [])]
    report = {
        "version": "manga-cut-video-analysis-v1",
        "videoPath": plan["videoPath"],
        "videoSha256": plan.get("videoSha256"),
        "thresholds": {
            "maximumClipBindingMae": MAXIMUM_CLIP_BINDING_MAE,
            "minimumMotionEnergy": MINIMUM_MOTION_ENERGY,
            "maximumIdenticalRun": MAXIMUM_IDENTICAL_RUN,
            "minimumPaletteCorrelation": MINIMUM_PALETTE_CORRELATION,
            "ocrMinimumConfidence": OCR_MINIMUM_CONFIDENCE,
            "ocrMinimumPersistence": OCR_MINIMUM_PERSISTENCE,
        },
        "cuts": cuts,
        "pass": bool(cuts) and all(all(row["pass"] for row in cut["gates"]) for cut in cuts),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=1, ensure_ascii=False))
    print(json.dumps({"pass": report["pass"], "cuts": [
        {"cutId": cut["cutId"], "failed": [row["id"] for row in cut["gates"] if not row["pass"]]} for cut in cuts
    ]}, ensure_ascii=False))
    if not report["pass"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
