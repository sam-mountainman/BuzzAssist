#!/usr/bin/env python3
"""Build a client-facing candidate PDF from a page-spec JSON.

Spec format (config/koya-candidate-pdf-spec-*.json):
{
  "output": "/absolute/or/repo-relative.pdf",
  "pageWidth": 2400,
  "bandColor": "#1E2761",
  "noteColor": "#6B7280",
  "fonts": ["/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc", "/Library/Fonts/Arial Unicode.ttf"],
  "pages": [{"title": "...", "note": "...", "file": "canvas/assets/.../x.png"}]
}

Every page is one full candidate sheet (1案=1ページ). Titles and notes are
rendered deterministically after generation; image models never draw labels.
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BAND_HEIGHT = 96
HEADER_HEIGHT = 150


def fail(message):
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def load_fonts(paths):
    for path in paths:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, 56), ImageFont.truetype(path, 34)
            except OSError:
                continue
    return None, None


def build_page(spec, page, big_font, note_font):
    source = Path(page["file"])
    if not source.exists():
        fail(f"page image not found: {source}")
    image = Image.open(source).convert("RGB")
    width = int(spec.get("pageWidth", 2400))
    image = image.resize((width, int(image.height * width / image.width)))
    canvas = Image.new("RGB", (width, image.height + HEADER_HEIGHT), "white")
    draw = ImageDraw.Draw(canvas)
    draw.rectangle([0, 0, width, BAND_HEIGHT], fill=spec.get("bandColor", "#1E2761"))
    draw.text((36, 18), page.get("title", ""), fill="white", font=big_font)
    draw.text((36, 104), page.get("note", ""), fill=spec.get("noteColor", "#6B7280"), font=note_font)
    canvas.paste(image, (0, HEADER_HEIGHT))
    return canvas


def main():
    if len(sys.argv) != 2:
        fail("usage: build-koya-candidate-pdf.py <spec.json>")
    spec_path = Path(sys.argv[1])
    if not spec_path.exists():
        fail(f"spec not found: {spec_path}")
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    pages = spec.get("pages", [])
    if not pages:
        fail("spec.pages must not be empty")
    big_font, note_font = load_fonts(spec.get("fonts", []))
    needs_cjk = any(not (page.get("title", "") + page.get("note", "")).isascii() for page in pages)
    if big_font is None and needs_cjk:
        fail("no usable font from spec.fonts; refusing to render Japanese titles with the bitmap default")
    rendered = [build_page(spec, page, big_font, note_font) for page in pages]
    output = Path(spec["output"])
    output.parent.mkdir(parents=True, exist_ok=True)
    rendered[0].save(output, save_all=True, append_images=rendered[1:], resolution=150)
    size_mb = output.stat().st_size / 1e6
    print(json.dumps({"output": str(output), "pages": len(rendered), "sizeMb": round(size_mb, 1)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
