import test from "node:test";
import assert from "node:assert/strict";

import { evaluateKoyaRenderedCamera } from "../lib/koyaRenderedCameraAudit.mjs";

test("rendered camera evaluation is fail-closed for missing required families", () => {
  const plan = {
    rows: [{ shotId: "s1", family: "directional", imagePath: "a.png", combinedPhaseContinuous: true }],
    staticRows: [],
  };
  const motion = { rows: [{ shotId: "s1", measured: {
    valid: true,
    inlierRatio: 0.5,
    meanAbsolutePixelDifference: 4,
    zoomPercentPerSecond: 0,
    translationPercentPerSecond: 0.2,
  } }] };
  const audit = evaluateKoyaRenderedCamera({ manifest: {}, plan, motion, fullDecodePass: true });
  assert.equal(audit.pass, false);
  assert.equal(audit.gates.find((gate) => gate.id === "three-camera-families-present").pass, false);
});

test("rendered camera evaluation passes a complete measured family set", () => {
  const rows = [
    { shotId: "d", family: "directional", imagePath: "d.png", combinedPhaseContinuous: true },
    { shotId: "p", family: "pullout", imagePath: "p.png", combinedPhaseContinuous: true },
    { shotId: "c", family: "combined", imagePath: "c.png", combinedPhaseContinuous: true },
  ];
  const measured = (row) => ({
    shotId: row.shotId,
    measured: {
      valid: true,
      inlierRatio: 0.5,
      meanAbsolutePixelDifference: 4,
      zoomPercentPerSecond: row.family === "directional" ? 0 : -0.2,
      translationPercentPerSecond: row.family === "pullout" ? 0 : 0.2,
    },
  });
  const audit = evaluateKoyaRenderedCamera({
    manifest: {}, plan: { rows, staticRows: [] }, motion: { rows: rows.map(measured) }, fullDecodePass: true,
  });
  assert.equal(audit.pass, true);
});
