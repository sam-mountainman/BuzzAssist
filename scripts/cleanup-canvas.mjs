#!/usr/bin/env node
// Remove empty generator frames left over from testing: frames with no
// prompt, no attachments, and no asset references. Backs up the canvas file
// before writing. Usage: node scripts/cleanup-canvas.mjs [--dry-run]
import { copyFile } from "node:fs/promises";
import { loadScene, saveScene, resolveCanvasFile } from "../lib/canvasScene.mjs";

const dryRun = process.argv.includes("--dry-run");
const frameTagPattern = /^buzzassist\..*Generator\.frame$/;

function isEmptyGeneratorFrame(element) {
  if (!element || element.isDeleted) return false;
  const customData = element.customData ?? {};
  if (!Object.keys(customData).some((key) => frameTagPattern.test(key))) return false;
  if (element.fileId) return false;
  if (typeof customData.generatorPrompt === "string" && customData.generatorPrompt.trim()) return false;
  const json = JSON.stringify(customData);
  if (json.includes("/excalidraw-assets/") || json.includes("assets/")) return false;
  for (const [key, value] of Object.entries(customData)) {
    if (!key.startsWith("generator")) continue;
    if (Array.isArray(value) && value.length > 0) return false;
  }
  return true;
}

const scene = await loadScene({});
const emptyFrames = scene.elements.filter(isEmptyGeneratorFrame);
const emptyIds = new Set(emptyFrames.map((element) => element.id));

console.log(`generator frames total: ${scene.elements.filter((el) => !el.isDeleted && Object.keys(el.customData ?? {}).some((key) => frameTagPattern.test(key))).length}`);
console.log(`empty frames to remove: ${emptyFrames.length}`);

if (dryRun || emptyFrames.length === 0) {
  console.log(dryRun ? "dry run — no changes written" : "nothing to do");
  process.exit(0);
}

const canvasFile = resolveCanvasFile({});
const backupPath = `${canvasFile}.bak-cleanup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
await copyFile(canvasFile, backupPath);
console.log(`backup: ${backupPath}`);

scene.elements = scene.elements.filter((element) => !emptyIds.has(element.id));
if (scene.appState?.selectedElementIds) {
  for (const id of emptyIds) delete scene.appState.selectedElementIds[id];
}
await saveScene({}, scene);
console.log(`removed ${emptyFrames.length} empty generator frames`);
