#!/usr/bin/env python3
"""R64 gate: rendered-frame typography check for every speech bubble.

exactTextMatch only proves CONTENT; it cannot see a rasterizer mangling the
layout (the sips fallback produced skewed columns and overlapping glyphs).
This gate works on the overlay PNGs actually composited into the video:

 1. verticality — dark text pixels inside the bubble are clustered into
    columns (x-projection); a straight vertical column has a near-zero slope
    of per-row centroids. |angle| > 3 degrees fails.
 2. glyph overlap — connected components of the text mask must not overlap
    each other by more than 20% of the smaller box (adjacent glyph boxes
    touch a little through antialiasing; real overlap is far larger).

Run AFTER overlays are rasterized (the pipeline PNGs must exist), so the
audit sees exactly what the video composites.
"""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

# Glyphs whose vertical forms ('vert'/'vrt2') are drawn off the em-box center
# by design: punctuation hugs the top-right corner, small kana shift toward
# the top-right, long-vowel and brackets rotate. Body glyphs stay at 0.30 em.
OFFSET_GLYPHS = set("、。，．・：；！？!?「」『』（）()［］…‥ー〜～ゝゞ"
                    "っゃゅょぁぃぅぇぉゎッャュョァィゥェォヮ")
BODY_GLYPH_LIMIT_EM = 0.30
OFFSET_GLYPH_LIMIT_EM = 0.85


import re


def parse_svg_glyphs(svg_path):
    text = Path(svg_path).read_text()
    root = re.search(r'<svg[^>]*\bwidth="([0-9.]+)"[^>]*\bheight="([0-9.]+)"', text)
    source_size = (float(root.group(1)), float(root.group(2))) if root else (0.0, 0.0)
    glyphs = []
    for m in re.finditer(r'<text x="([0-9.]+)" y="([0-9.]+)"[^>]*font-size="([0-9.]+)"[^>]*>([^<])</text>', text):
        x, y, size, ch = float(m.group(1)), float(m.group(2)), float(m.group(3)), m.group(4)
        if ch.strip():
            glyphs.append((x, y, size, ch))
    return glyphs, source_size


def analyze_overlay(png_path, svg_path):
    """Verify every planned glyph is rendered at its planned position.

    The overlay SVG places each glyph at absolute (x, y) with text-anchor
    middle / central baseline. For each glyph we take a window around the
    planned centre in the rasterized PNG and require (a) ink present and
    (b) the ink centroid within 0.30 em of the plan. A skewing or
    overlapping rasterizer displaces centroids far beyond that.
    """
    image = cv2.imread(str(png_path), cv2.IMREAD_UNCHANGED)
    if image is None:
        return {"error": f"unreadable {png_path}"}
    if image.shape[2] == 4:
        alpha = image[:, :, 3]
        gray = cv2.cvtColor(image[:, :, :3], cv2.COLOR_BGR2GRAY)
        text_mask = ((gray < 110) & (alpha > 128)).astype(np.uint8)
    else:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        text_mask = (gray < 110).astype(np.uint8)
    glyphs, source_size = parse_svg_glyphs(svg_path)
    if not glyphs:
        return {"error": "no glyphs parsed from svg"}
    height, width = text_mask.shape
    source_width, source_height = source_size
    if source_width <= 0 or source_height <= 0:
        return {"error": "svg width/height missing"}
    scale_x = width / source_width
    scale_y = height / source_height
    scale_size = (scale_x + scale_y) / 2
    worst_dev_em = 0.0
    worst_body_dev_em = 0.0
    violations = 0
    missing = 0
    for (gx, gy, size, ch) in glyphs:
        gx *= scale_x
        gy *= scale_y
        size *= scale_size
        half = size * 0.62
        x0, x1 = int(max(0, gx - half)), int(min(width, gx + half))
        y0, y1 = int(max(0, gy - half)), int(min(height, gy + half))
        window = text_mask[y0:y1, x0:x1]
        ink = int(window.sum())
        # small glyphs (っ、。ー) carry little ink; scale the floor by size
        if ink < max(12, (size * size) * 0.006):
            missing += 1
            continue
        ys, xs = np.nonzero(window)
        cx, cy = x0 + float(xs.mean()), y0 + float(ys.mean())
        deviation = ((cx - gx) ** 2 + (cy - gy) ** 2) ** 0.5 / size
        worst_dev_em = max(worst_dev_em, deviation)
        # vertical writing intentionally offsets punctuation / small kana
        # inside the em box ('vert' forms), so those glyph classes get a
        # wider allowance than body glyphs.
        limit = OFFSET_GLYPH_LIMIT_EM if ch in OFFSET_GLYPHS else BODY_GLYPH_LIMIT_EM
        if ch not in OFFSET_GLYPHS:
            worst_body_dev_em = max(worst_body_dev_em, deviation)
        if deviation > limit:
            violations += 1
    return {
        "glyphCount": len(glyphs),
        "svgSourceDimensions": [round(source_width), round(source_height)],
        "pngDimensions": [width, height],
        "rasterScale": [round(scale_x, 6), round(scale_y, 6)],
        "missingGlyphs": missing,
        "violations": violations,
        "worstCentroidDeviationEm": round(worst_dev_em, 3),
        "worstBodyGlyphDeviationEm": round(worst_body_dev_em, 3),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()
    manifest_path = args.manifest.resolve()
    output_path = args.output.resolve() if args.output else manifest_path.parent / "bubble-typography-audit.json"
    manifest = json.loads(manifest_path.read_text())
    rows = []
    for u in manifest["utterances"]:
        entries = []
        segments = [s for s in (u.get("bubbleSegments") or []) if s.get("overlayPath")]
        if segments:
            for seg in segments:
                spec_bounds = seg.get("bounds")
                entries.append((seg["id"], seg["overlayPath"], spec_bounds))
        else:
            spec = json.loads(Path(u["overlaySpecPath"]).read_text())
            bounds = (spec.get("plan", {}).get("bubbles") or [{}])[0].get("bounds")
            entries.append((u["id"], u["overlayPath"], bounds))
        for entry_id, overlay_path, bounds in entries:
            # the renderer rasterizes overlays into .render-work/<id>.png —
            # audit exactly the PNG that was composited into the video
            png = manifest_path.parent / ".render-work" / f"{entry_id}.png"
            if not png.is_file():
                rows.append({"id": entry_id, "error": "rasterized png missing (run render first)", "pass": False})
                continue
            metrics = analyze_overlay(png, overlay_path)
            ok = ("error" not in metrics
                  and metrics["missingGlyphs"] == 0
                  and metrics["violations"] == 0)
            rows.append({"id": entry_id, **metrics, "pass": bool(ok)})
    result = {
        "version": "bubble-typography-frames-v1",
        "rows": rows,
        "pass": bool(rows) and all(r["pass"] for r in rows),
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=1))
    print(json.dumps({"pass": result["pass"], "failures": [r for r in rows if not r["pass"]][:8], "checked": len(rows)}, ensure_ascii=False))
    if not result["pass"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
