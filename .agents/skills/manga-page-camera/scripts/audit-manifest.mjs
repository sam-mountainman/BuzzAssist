#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const manifestPath = resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Usage: audit-manifest.mjs /absolute/path/to/episode-manifest.json");
const projectDir = resolve(process.argv[3] || process.cwd());
const grammarPath = resolve(projectDir, "lib/mangaPageCameraGrammar.mjs");
const {
  MANGA_PAGE_CAMERA_GRAMMAR_VERSION,
  auditMangaPanelPageCameraGrammar,
  auditMangaShotCameraGrammar,
  mangaCameraModeFamily,
  normalizeMangaCameraMode,
} = await import(pathToFileURL(grammarPath));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const violations = [];
const rows = [];
const modeCounts = { pullout: 0, directional: 0, combined: 0, static: 0 };

for (const cut of manifest.cuts || []) {
  if (cut.panelLayout?.enabled) {
    violations.push(...auditMangaPanelPageCameraGrammar(cut.panelLayout, cut.id));
    const mode = normalizeMangaCameraMode(
      cut.panelLayout.pageCameraMode ?? cut.panelLayout.pageMotion,
    );
    const family = mangaCameraModeFamily(mode);
    modeCounts[family] += 1;
    rows.push({ cutId: cut.id, shotId: `${cut.id}-flattened-page`, mode, family, splitPage: true });
    continue;
  }
  const imageCounts = new Map();
  for (const shot of cut.cameraSequence || []) {
    const staticPlate = shot.motion === "none"
      && shot.editorialPlate?.characterPolicy === "strictly-none"
      && shot.editorialPlate?.environmentPolicy === "none";
    if (staticPlate) {
      modeCounts.static += 1;
      rows.push({ cutId: cut.id, shotId: shot.id, mode: "none", family: "static", splitPage: false });
      continue;
    }
    imageCounts.set(shot.imagePath, (imageCounts.get(shot.imagePath) || 0) + 1);
    const mode = normalizeMangaCameraMode(shot.cameraMode ?? shot.motion);
    const family = mangaCameraModeFamily(mode);
    modeCounts[family] += 1;
    rows.push({ cutId: cut.id, shotId: shot.id, mode, family, splitPage: false });
    violations.push(...auditMangaShotCameraGrammar(shot));
  }
  for (const [imagePath, count] of imageCounts) {
    if (count > 1) violations.push({ type: "repeated-image-in-cut", cutId: cut.id, imagePath, count });
  }
}

if (modeCounts.pullout === 0 || modeCounts.directional === 0 || modeCounts.combined === 0) {
  violations.push({ type: "missing-required-camera-family", modeCounts });
}
if (manifest.video?.cameraGrammarVersion !== MANGA_PAGE_CAMERA_GRAMMAR_VERSION) {
  violations.push({
    type: "camera-grammar-version-mismatch",
    expected: MANGA_PAGE_CAMERA_GRAMMAR_VERSION,
    actual: manifest.video?.cameraGrammarVersion,
  });
}

const result = {
  manifestPath,
  grammarPath,
  grammarVersion: MANGA_PAGE_CAMERA_GRAMMAR_VERSION,
  modeCounts,
  movingShotCount: modeCounts.pullout + modeCounts.directional + modeCounts.combined,
  splitCutIds: (manifest.cuts || []).filter((cut) => cut.panelLayout?.enabled).map((cut) => cut.id),
  rows,
  violations,
  pass: violations.length === 0,
};
console.log(JSON.stringify(result, null, 2));
if (!result.pass) process.exitCode = 1;
