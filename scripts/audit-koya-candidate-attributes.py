#!/usr/bin/env python3
"""Deterministic attribute gates for character candidate/revision images.

Implements the machine-checkable half of ledger rules R187-R190 so that
generation lotteries (vanished fangs, spawned necklaces, drifted hair color,
near-duplicate takes, off-spec side effects) are caught before human review
instead of during it.

Config JSON:
{
  "checks": [
    {"id": "...", "type": "hairColorDelta",
     "image": "a.png", "reference": "b.png",
     "region": [0.55, 0.05, 0.40, 0.40],      // normalized x,y,w,h (defaults to face-zoom hair zone)
     "warnDeltaE": 3.5, "failDeltaE": 8.0},   // calibrated 2026-08-28; mean-Lab distance

    {"id": "...", "type": "unintendedChange",
     "image": "a.png", "base": "b.png",
     "allowedRegions": [[0.5, 0.0, 0.5, 0.5]], // zones where change was requested
     "blockSize": 48, "blockDeltaE": 10.0, "maxChangedRatio": 0.02},

    {"id": "...", "type": "duplicateTakes",
     "images": ["a.png", "b.png", "c.png"],
     "region": [0.24, 0.08, 0.23, 0.70],       // front-head crop used for hashing
     "maxHammingForDuplicate": 36, "warnHamming": 44},

    {"id": "...", "type": "neckOrnament",      // advisory: warns, never fails
     "image": "a.png", "reference": "clean.png",
     "region": [0.56, 0.42, 0.22, 0.26],
     "ratioLimit": 1.5, "absoluteMargin": 150, "standaloneLimit": 500},

    {"id": "...", "type": "wd14Tags",          // ML screening (models/wd14/README.md)
     "image": "a.png", "region": [0.55, 0.05, 0.42, 0.60],
     "requireTags": {"fang": 0.2},             // fail when absent
     "forbidTags": {"necklace": 0.3},          // warn when present
     "reportTags": ["hair_over_one_eye"]}      // tag names use underscores
  ]
}

Output: single-line JSON report on stdout. Every check result carries the
SHA-256 of its input images so a report stays bound to the exact pixels it
judged. Exit 0 when no check failed, 3 when at least one failed.
"""
import hashlib
import json
import sys
from pathlib import Path

import cv2
import numpy as np

DEFAULT_HAIR_REGION = [0.55, 0.05, 0.40, 0.40]
DEFAULT_NECK_REGION = [0.56, 0.42, 0.22, 0.26]


def fail(message):
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def load_bgr(path):
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None:
        fail(f"unreadable image: {path}")
    return image


def crop_region(image, region):
    height, width = image.shape[:2]
    nx, ny, nw, nh = [float(v) for v in region]
    if nx < 0 or ny < 0 or nw <= 0 or nh <= 0 or nx + nw > 1 or ny + nh > 1:
        fail(f"region must stay inside 0..1: {region}")
    x0, y0 = round(nx * width), round(ny * height)
    x1, y1 = max(x0 + 1, round((nx + nw) * width)), max(y0 + 1, round((ny + nh) * height))
    return image[y0:y1, x0:x1]


def mean_hair_lab(image, region):
    crop = crop_region(image, region)
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    non_white = np.any(crop < 235, axis=2)
    not_black = np.any(crop > 30, axis=2)
    mask = non_white & not_black & (hsv[:, :, 1] >= 20)
    if int(mask.sum()) < max(64, int(crop.shape[0] * crop.shape[1] * 0.01)):
        fail(f"hair region does not contain enough chromatic pixels ({int(mask.sum())})")
    lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB)[mask].astype(np.float64)
    mean = lab.mean(axis=0)
    return np.array([mean[0] * 100.0 / 255.0, mean[1] - 128.0, mean[2] - 128.0])


def check_hair_color_delta(check):
    # Calibrated on 2026-08-28 real assets: same-color regenerations score <=2.4,
    # the human-flagged ivory drift scored 4.13, hard color mistakes score >=11.
    region = check.get("region", DEFAULT_HAIR_REGION)
    candidate = mean_hair_lab(load_bgr(check["image"]), region)
    reference = mean_hair_lab(load_bgr(check["reference"]), region)
    delta = float(np.linalg.norm(candidate - reference))
    warn, hard = float(check.get("warnDeltaE", 3.5)), float(check.get("failDeltaE", 8.0))
    status = "pass" if delta < warn else ("warn" if delta < hard else "fail")
    return {"deltaE": round(delta, 2), "warnDeltaE": warn, "failDeltaE": hard, "status": status}


def check_unintended_change(check):
    image = load_bgr(check["image"])
    base = load_bgr(check["base"])
    if image.shape != base.shape:
        base = cv2.resize(base, (image.shape[1], image.shape[0]))
    block = int(check.get("blockSize", 48))
    if block <= 0:
        fail("blockSize must be positive")
    threshold = float(check.get("blockDeltaE", 10.0))
    max_ratio = float(check.get("maxChangedRatio", 0.02))
    lab_a = cv2.cvtColor(image, cv2.COLOR_BGR2LAB).astype(np.float64)
    lab_b = cv2.cvtColor(base, cv2.COLOR_BGR2LAB).astype(np.float64)
    lab_a[:, :, 0] *= 100.0 / 255.0
    lab_b[:, :, 0] *= 100.0 / 255.0
    height, width = image.shape[:2]
    allowed = np.zeros((height, width), dtype=bool)
    regions = check.get("allowedRegions", [])
    if not isinstance(regions, list):
        fail("allowedRegions must be a list of normalized rectangles")
    for region in regions:
        if not isinstance(region, list) or len(region) != 4:
            fail(f"allowedRegions entries must be [x, y, w, h]: {region}")
        nx, ny, nw, nh = [float(v) for v in region]
        if nx < 0 or ny < 0 or nw <= 0 or nh <= 0 or nx + nw > 1 or ny + nh > 1:
            fail(f"allowedRegions entry must stay inside 0..1: {region}")
        allowed[round(ny * height):round((ny + nh) * height), round(nx * width):round((nx + nw) * width)] = True
    changed_blocks = []
    audited_blocks = 0
    # Walk every block including right/bottom edge remainders, and judge each
    # block on its NON-allowed pixels only so allowed zones can never dilute
    # or absorb an off-spec change (Codex review 2026-08-28 findings).
    for by in range(0, height, block):
        for bx in range(0, width, block):
            y1, x1 = min(by + block, height), min(bx + block, width)
            outside = ~allowed[by:y1, bx:x1]
            if not outside.any():
                continue
            audited_blocks += 1
            delta = np.linalg.norm(
                np.median(lab_a[by:y1, bx:x1][outside], axis=0)
                - np.median(lab_b[by:y1, bx:x1][outside], axis=0)
            )
            if delta > threshold:
                changed_blocks.append({"x": bx, "y": by, "deltaE": round(float(delta), 2)})
    ratio = len(changed_blocks) / max(1, audited_blocks)
    status = "pass" if ratio <= max_ratio else "fail"
    changed_blocks.sort(key=lambda item: -item["deltaE"])
    return {"changedBlocks": len(changed_blocks), "auditedBlocks": audited_blocks, "changedRatio": round(ratio, 4),
            "maxChangedRatio": max_ratio, "worst": changed_blocks[:8], "status": status}


DEFAULT_FRONT_HEAD_REGION = [0.24, 0.08, 0.23, 0.70]


def perceptual_hash(path, region, hash_size=16):
    image = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if image is None:
        fail(f"unreadable image: {path}")
    crop = crop_region(image[:, :, None].repeat(3, axis=2), region)[:, :, 0]
    size = hash_size * 4
    resized = cv2.resize(crop, (size, size), interpolation=cv2.INTER_AREA).astype(np.float64)
    dct = cv2.dct(resized)
    low = dct[:hash_size, :hash_size]
    return (low > np.median(low)).flatten()


def check_duplicate_takes(check):
    # Calibrated on 2026-08-28 Reiji take families: the two human-rejected
    # near-duplicate pairs scored 26/30; visually distinct options scored >=44.
    images = check.get("images", [])
    if len(images) < 2:
        fail("duplicateTakes requires at least two images")
    region = check.get("region", DEFAULT_FRONT_HEAD_REGION)
    hashes = {path: perceptual_hash(path, region) for path in images}
    hard = int(check.get("maxHammingForDuplicate", 36))
    soft = int(check.get("warnHamming", 44))
    duplicates, similar = [], []
    for i, a in enumerate(images):
        for b in images[i + 1:]:
            distance = int(np.count_nonzero(hashes[a] != hashes[b]))
            if distance <= hard:
                duplicates.append({"a": a, "b": b, "hamming": distance})
            elif distance <= soft:
                similar.append({"a": a, "b": b, "hamming": distance})
    status = "fail" if duplicates else ("warn" if similar else "pass")
    return {"pairs": duplicates, "similarPairs": similar, "maxHammingForDuplicate": hard, "warnHamming": soft, "status": status}


def gold_pixel_count(image, region):
    crop = crop_region(image, region)
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    gold = (hsv[:, :, 0] >= 10) & (hsv[:, :, 0] <= 35) & (hsv[:, :, 1] >= 70) & (hsv[:, :, 2] >= 120)
    return int(gold.sum())


def check_neck_ornament(check):
    # Gold-tone jewelry raises the chromatic pixel count in the neck window by
    # ~1.6-1.9x versus the same character without it (2026-08-28 calibration),
    # so this gate compares against a known-clean reference when provided.
    region = check.get("region", DEFAULT_NECK_REGION)
    count = gold_pixel_count(load_bgr(check["image"]), region)
    reference_path = check.get("reference")
    if reference_path:
        reference = gold_pixel_count(load_bgr(reference_path), region)
        limit = max(reference * float(check.get("ratioLimit", 1.5)), reference + float(check.get("absoluteMargin", 150)))
        status = "warn" if count > limit else "pass"
        return {"goldPixels": count, "referenceGoldPixels": reference, "limit": round(limit, 1), "status": status}
    limit = float(check.get("standaloneLimit", 500))
    return {"goldPixels": count, "limit": limit, "status": "warn" if count > limit else "pass"}


_WD14_SESSIONS = {}


def wd14_session(model_path):
    if model_path not in _WD14_SESSIONS:
        try:
            import onnxruntime
        except ImportError:
            fail("wd14Tags requires onnxruntime (pip install onnxruntime)")
        _WD14_SESSIONS[model_path] = onnxruntime.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    return _WD14_SESSIONS[model_path]


def wd14_scores(image_bgr, model_path, tags_path):
    session = wd14_session(model_path)
    size = session.get_inputs()[0].shape[1]
    height, width = image_bgr.shape[:2]
    side = max(height, width)
    canvas = np.full((side, side, 3), 255, dtype=np.uint8)
    top, left = (side - height) // 2, (side - width) // 2
    canvas[top:top + height, left:left + width] = image_bgr
    resized = cv2.resize(canvas, (size, size), interpolation=cv2.INTER_AREA).astype(np.float32)
    logits = session.run(None, {session.get_inputs()[0].name: resized[None, :, :, :]})[0][0]
    names = []
    with open(tags_path, encoding="utf-8") as handle:
        next(handle)
        for line in handle:
            names.append(line.split(",")[1])
    return dict(zip(names, [float(v) for v in logits]))


WD14_MODEL_SHA256 = "e6774bff34d43bd49f75a47db4ef217dce701c9847b546523eb85ff6dbba1db1"
WD14_TAGS_SHA256 = "298633d94d0031d2081c0893f29c82eab7f0df00b08483ba8f29d1e979441217"
_WD14_VERIFIED = False


def check_wd14_tags(check):
    # ML screening for attributes the deterministic gates cannot see
    # (fang presence, jewelry on bright jackets, hair-over-one-eye). WD14
    # cannot tell WHICH eye is covered; the side check stays geometric/human.
    global _WD14_VERIFIED
    model_path = Path(check.get("model", "models/wd14/model.onnx"))
    tags_path = Path(check.get("tags", "models/wd14/selected_tags.csv"))
    if not model_path.exists() or not tags_path.exists():
        fail(f"wd14Tags model files missing: {model_path}, {tags_path}")
    if not _WD14_VERIFIED:
        # Pinned-SHA verification at runtime, not just in the README (Codex
        # review 2026-08-28): a swapped model silently changes every verdict.
        expected_model = check.get("modelSha256", WD14_MODEL_SHA256)
        expected_tags = check.get("tagsSha256", WD14_TAGS_SHA256)
        actual_model = hashlib.sha256(model_path.read_bytes()).hexdigest()
        actual_tags = hashlib.sha256(tags_path.read_bytes()).hexdigest()
        if actual_model != expected_model or actual_tags != expected_tags:
            fail(f"wd14Tags model SHA mismatch: {actual_model[:16]}/{actual_tags[:16]}")
        _WD14_VERIFIED = True
    image = load_bgr(check["image"])
    if check.get("region"):
        image = crop_region(image, check["region"])
    scores = wd14_scores(image, model_path, tags_path)
    observed = {}
    status = "pass"
    for tag, threshold in (check.get("requireTags") or {}).items():
        score = scores.get(tag, 0.0)
        observed[tag] = round(score, 4)
        if score < float(threshold):
            status = "fail"
    for tag, threshold in (check.get("forbidTags") or {}).items():
        score = scores.get(tag, 0.0)
        observed[tag] = round(score, 4)
        if score >= float(threshold) and status != "fail":
            status = "warn"
    for tag in check.get("reportTags") or []:
        observed[tag] = round(scores.get(tag, 0.0), 4)
    return {"tags": observed, "status": status}


HANDLERS = {
    "hairColorDelta": check_hair_color_delta,
    "unintendedChange": check_unintended_change,
    "duplicateTakes": check_duplicate_takes,
    "neckOrnament": check_neck_ornament,
    "wd14Tags": check_wd14_tags,
}


def input_digests(check):
    paths = [check[key] for key in ("image", "reference", "base") if check.get(key)]
    paths.extend(check.get("images", []))
    digests = {}
    for path in paths:
        digests[str(path)] = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    return digests


def main():
    if len(sys.argv) != 2:
        fail("usage: audit-koya-candidate-attributes.py <config.json>")
    config = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    checks = config.get("checks", [])
    if not checks:
        fail("config.checks must not be empty")
    results = []
    for check in checks:
        handler = HANDLERS.get(check.get("type"))
        if handler is None:
            fail(f"unknown check type: {check.get('type')}")
        outcome = handler(check)
        results.append({"id": check.get("id", ""), "type": check["type"],
                        "inputSha256": input_digests(check), **outcome})
    overall = "fail" if any(r["status"] == "fail" for r in results) else (
        "warn" if any(r["status"] == "warn" for r in results) else "pass")
    print(json.dumps({"overall": overall, "checks": results}, ensure_ascii=False))
    sys.exit(0 if overall != "fail" else 3)


if __name__ == "__main__":
    main()
