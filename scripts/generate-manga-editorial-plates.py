#!/usr/bin/env python3
"""Generate deterministic characterless editorial plates measured from references."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np


WIDTH = 1920
HEIGHT = 1080


def pastel_sky(seed: int, clearer: bool = False) -> np.ndarray:
    rng = np.random.default_rng(seed)
    y = np.linspace(0.0, 1.0, HEIGHT, dtype=np.float32)[:, None, None]
    top = np.array([247, 227, 242], dtype=np.float32)[None, None, :]
    middle = np.array([218, 226, 249], dtype=np.float32)[None, None, :]
    bottom = np.array([139, 205, 247], dtype=np.float32)[None, None, :]
    upper_mix = np.clip(y / 0.48, 0, 1)
    lower_mix = np.clip((y - 0.32) / 0.68, 0, 1)
    rgb = top * (1 - upper_mix) + middle * upper_mix
    rgb = rgb * (1 - lower_mix) + bottom * lower_mix
    rgb = np.repeat(rgb, WIDTH, axis=1)

    haze = np.zeros((HEIGHT, WIDTH, 3), dtype=np.float32)
    cloud_specs = [
        (-80, 70, 420, 105, 0.18),
        (510, 155, 360, 92, 0.15),
        (1260, 90, 430, 100, 0.13),
        (50, 1025, 530, 105, 0.22),
        (650, 1055, 430, 80, 0.18),
        (1360, 1015, 590, 92, 0.16),
    ]
    if clearer:
        cloud_specs = [(x, cy, rx, ry, alpha * 0.78) for x, cy, rx, ry, alpha in cloud_specs]
    for cx, cy, rx, ry, alpha in cloud_specs:
        for _ in range(6):
            dx = int(rng.normal(0, rx * 0.18))
            dy = int(rng.normal(0, ry * 0.16))
            local_rx = max(18, int(rx * rng.uniform(0.34, 0.62)))
            local_ry = max(12, int(ry * rng.uniform(0.42, 0.72)))
            cv2.ellipse(
                haze,
                (int(cx + dx), int(cy + dy)),
                (local_rx, local_ry),
                0,
                0,
                360,
                (255 * alpha, 255 * alpha, 255 * alpha),
                -1,
                cv2.LINE_AA,
            )

    # Long, soft cloud streaks reproduce the quiet illustrated-sky cadence
    # without introducing a literal location or any character silhouette.
    for start_x, start_y, end_x, end_y, thickness in [
        (-120, 610, 560, 835, 36),
        (270, 300, 1020, 470, 25),
        (950, 430, 1780, 610, 29),
        (1240, 770, 2050, 860, 24),
    ]:
        cv2.line(haze, (start_x, start_y), (end_x, end_y), (23, 23, 23), thickness, cv2.LINE_AA)
    haze = cv2.GaussianBlur(haze, (0, 0), sigmaX=34, sigmaY=24)
    rgb = np.clip(rgb + haze, 0, 255)

    bokeh = np.zeros((HEIGHT, WIDTH, 3), dtype=np.float32)
    for _ in range(14):
        cx = int(rng.integers(80, WIDTH - 80))
        cy = int(rng.integers(55, HEIGHT - 160))
        radius = int(rng.integers(10, 25))
        color = rng.choice(
            np.array([[177, 249, 255], [230, 241, 255], [255, 228, 247]], dtype=np.float32)
        )
        cv2.circle(bokeh, (cx, cy), radius, tuple(float(v * 0.23) for v in color), -1, cv2.LINE_AA)
    bokeh = cv2.GaussianBlur(bokeh, (0, 0), sigmaX=12, sigmaY=12)
    rgb = np.clip(rgb + bokeh, 0, 255)
    return cv2.cvtColor(rgb.astype(np.uint8), cv2.COLOR_RGB2BGR)


def write_png(path: Path, image: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(path), image, [cv2.IMWRITE_PNG_COMPRESSION, 6]):
        raise RuntimeError(f"Could not write {path}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    assets = {
        "white-solid": output_dir / "manga-editorial-plate-white-v30.png",
        "black-solid": output_dir / "manga-editorial-plate-black-v30.png",
        "pastel-sky-promise": output_dir / "manga-editorial-plate-pastel-sky-promise-v30.png",
        "pastel-sky-closing": output_dir / "manga-editorial-plate-pastel-sky-closing-v30.png",
    }
    write_png(assets["white-solid"], np.full((HEIGHT, WIDTH, 3), 255, dtype=np.uint8))
    write_png(assets["black-solid"], np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8))
    write_png(assets["pastel-sky-promise"], pastel_sky(3009, clearer=False))
    write_png(assets["pastel-sky-closing"], pastel_sky(3010, clearer=True))
    print(json.dumps({"width": WIDTH, "height": HEIGHT, "assets": {k: str(v) for k, v in assets.items()}}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
