import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("rendered face audit rejects bubble-only cascade hits absent from adjacent clear frames", () => {
  const source = String.raw`
import importlib.util
import numpy as np
import cv2
import tempfile

spec = importlib.util.spec_from_file_location("audit_faces", "scripts/audit-manga-bubble-faces-independent.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Capture:
    def set(self, *_):
        return True
    def read(self):
        return True, np.zeros((1080, 1920, 3), dtype=np.uint8)

reference = (558, 729, 60, 60)
original = module.detect_faces
module.detect_faces = lambda _cascade, _frame: []
assert module.cascade_face_exists_in_clear_frame(None, Capture(), reference, [1.0, 2.0]) is False
module.detect_faces = lambda _cascade, _frame: [(560, 731, 58, 58)]
assert module.cascade_face_exists_in_clear_frame(None, Capture(), reference, [1.0, 2.0]) is True

camera = {
    "keyframes": [
        {"at": 0, "zoom": 1.5, "focusX": 0.5, "focusY": 0.5},
        {"at": 1, "zoom": 1.0, "focusX": 0.5, "focusY": 0.5},
    ]
}
moved = module.page_camera_box_at_clear_time([960, 540, 120, 120], (1920, 1080), camera, 0, 1)
assert moved == [960, 540, 80, 80], moved
assert module.box_matches(reference, (560, 731, 58, 58)) is True
assert module.box_matches(reference, (1200, 100, 60, 60)) is False
module.detect_faces = original

class WeightedCascade:
    def detectMultiScale3(self, *_args, **_kwargs):
        return (
            np.array([[10, 10, 60, 60], [100, 100, 80, 80]]),
            np.array([1, 1]),
            np.array([0.2, 2.4]),
        )

weighted = module.detect_faces(WeightedCascade(), np.zeros((1080, 1920, 3), dtype=np.uint8))
assert weighted == [(100, 100, 80, 80)]

with tempfile.NamedTemporaryFile(suffix=".png") as target:
    # The production raster can be 1920x1080 even when the SVG placement spec
    # was authored at 1672x941. Alpha coordinates must use the real PNG size.
    overlay = np.zeros((1080, 1920, 4), dtype=np.uint8)
    overlay[216:864, 288:1440, 3] = 255
    cv2.imwrite(target.name, overlay)
    assert module.rendered_overlay_bounds(target.name) == {
        "x": 288, "y": 216, "width": 1152, "height": 648
    }
    geometry = module.rendered_overlay_geometry(target.name)
    assert geometry["imageSize"] == {"width": 1920, "height": 1080}
    normalized = (
        geometry["bounds"]["x"] / geometry["imageSize"]["width"],
        geometry["bounds"]["y"] / geometry["imageSize"]["height"],
        geometry["bounds"]["width"] / geometry["imageSize"]["width"],
        geometry["bounds"]["height"] / geometry["imageSize"]["height"],
    )
    assert normalized == (0.15, 0.2, 0.6, 0.6)
`;
  const result = spawnSync("python3", ["-c", source], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("thought spotlight audit projects through the renderer-normalized pullout crop", () => {
  const source = String.raw`
import importlib.util

spec = importlib.util.spec_from_file_location("thought_audit", "scripts/audit-manga-thought-spotlight.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

camera = {
    "zoomStart": 1.542857,
    "zoomEnd": 1.08,
    "focusX": 0.68,
    "focusY": 0.195,
    "focusXEnd": 0.68,
    "focusYEnd": 0.195,
    "keyframes": [
        {"at": 0, "zoom": 1.542857, "focusX": 0.68, "focusY": 0.195},
        {"at": 1, "zoom": 1.08, "focusX": 0.68, "focusY": 0.195},
    ],
}
zoom, focus_x, focus_y = module.camera_at(camera, 0.5, "pullout-only")
assert round(zoom, 6) == 1.290847, zoom
assert round(focus_x, 6) == 0.531037, focus_x
assert round(focus_y, 6) == 0.468963, focus_y
projected = module.project_rect({"x": 0.585, "y": 0.015, "width": 0.19, "height": 0.36}, zoom, focus_x, focus_y)
assert [round(v, 4) for v in projected] == [0.5697, 0.0, 0.8149, 0.3787], projected
`;
  const result = spawnSync("python3", ["-c", source], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
