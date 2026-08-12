#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { mangaCameraModeFamily, normalizeMangaCameraMode } from "../lib/mangaPageCameraGrammar.mjs";
import { auditCameraSequencePolicy, normalizeCameraShotSequence } from "../lib/mangaVideoPipeline.mjs";

const args = {};
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith("--")) continue;
  const key = token.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
  const next = process.argv[index + 1];
  if (!next || next.startsWith("--")) args[key] = true;
  else { args[key] = next; index += 1; }
}
if (!args.manifestPath) throw new Error("--manifest-path is required.");
const manifestPath = resolve(args.manifestPath);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const utterancesByCut = new Map();
for (const utterance of manifest.utterances || []) {
  if (!utterancesByCut.has(utterance.cutId)) utterancesByCut.set(utterance.cutId, []);
  utterancesByCut.get(utterance.cutId).push(utterance);
}
const familyCounts = { directional: 0, pullout: 0, combined: 0, static: 0 };
const rows = [];
const violations = [];
for (const cut of manifest.cuts || []) {
  if (cut.panelLayout?.enabled) {
    const sequence = [];
    violations.push(...auditCameraSequencePolicy(manifest, cut, sequence).violations);
    const mode = normalizeMangaCameraMode(cut.panelLayout.pageCameraMode || cut.panelLayout.pageMotion, "pullout-only");
    const family = mangaCameraModeFamily(mode);
    familyCounts[family] += 1;
    rows.push({
      cutId: cut.id,
      shotId: `${cut.id}-flattened-page`,
      mode,
      family,
      viewpoint: cut.panelLayout.pageViewpoint,
      endView: cut.panelLayout.pageEndView,
      imagePath: cut.flattenedSplitPage?.sourcePagePath || cut.imagePath,
      durationSeconds: Number(cut.timing?.durationSeconds || 0),
      flattenedSplitPage: cut.flattenedSplitPage || { enabled: true },
    });
    continue;
  }
  const sequence = normalizeCameraShotSequence(
    cut,
    utterancesByCut.get(cut.id) || [],
    Number(cut.timing?.durationSeconds || 0),
  );
  if (sequence.length === 0) violations.push({ type: "cut-has-no-camera-sequence", cutId: cut.id });
  violations.push(...auditCameraSequencePolicy(manifest, cut, sequence).violations);
  const rawById = new Map((cut.cameraSequence || []).map((shot) => [shot.id, shot]));
  for (const shot of sequence) {
    const raw = rawById.get(shot.id) || {};
    const mode = normalizeMangaCameraMode(raw.cameraMode || shot.motion, "pullout-only");
    const family = mangaCameraModeFamily(mode);
    familyCounts[family] += 1;
    rows.push({
      cutId: cut.id,
      shotId: shot.id,
      mode,
      family,
      viewpoint: raw.viewpoint || shot.viewpoint,
      endView: raw.endView || shot.endView,
      imagePath: shot.imagePath,
      durationSeconds: shot.durationSeconds,
      flattenedSplitPage: raw.flattenedSplitPage || null,
    });
  }
}
if (!["directional", "pullout", "combined"].every((family) => familyCounts[family] > 0)) {
  violations.push({ type: "missing-required-camera-family", familyCounts });
}
const result = {
  version: "koya-camera-manifest-audit-v1",
  manifestPath,
  familyCounts,
  rows,
  violations,
  pass: violations.length === 0,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.pass) process.exitCode = 2;
