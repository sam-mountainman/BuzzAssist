import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auditKoyaRenderedCamera, evaluateKoyaRenderedCamera } from "../lib/koyaRenderedCameraAudit.mjs";

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

test("rendered camera audit preserves Windows Python launcher arguments", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-camera-python-runtime-"));
  try {
    const manifestPath = join(projectDir, "manifest.json");
    const videoPath = join(projectDir, "video.mp4");
    const outputDir = join(projectDir, "audit");
    await writeFile(manifestPath, `${JSON.stringify({ cuts: [], utterances: [] })}\n`);
    await writeFile(videoPath, "fixture");
    const calls = [];
    const result = await auditKoyaRenderedCamera({
      projectDir,
      manifestPath,
      videoPath,
      outputDir,
      pythonRuntime: { ok: true, command: "py.exe", args: ["-3"], version: "3.12.1" },
      runCommand: async (command, args) => {
        calls.push({ command, args });
        if (command === "py.exe") {
          const outputIndex = args.indexOf("--output");
          await writeFile(args[outputIndex + 1], `${JSON.stringify({ rows: [] })}\n`);
        }
        return { stdout: "", stderr: "" };
      },
    });
    assert.equal(calls[0].command, "py.exe");
    assert.deepEqual(calls[0].args.slice(0, 2), ["-3", join(projectDir, "scripts/analyze-manga-shot-motion.py")]);
    assert.equal(result.audit.gates.find((gate) => gate.id === "full-video-decode").pass, true);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
