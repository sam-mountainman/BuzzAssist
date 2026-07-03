import { access } from "node:fs/promises";
import { extractVideoPosterDataURL, loadScene, saveScene } from "../lib/canvasScene.mjs";

const args = { projectDir: process.argv[2] || process.cwd() };
const scene = await loadScene(args);
let updated = 0;
let skipped = 0;

for (const element of scene.elements) {
  if (element?.isDeleted || element?.customData?.codexMediaKind !== "video" || !element.fileId) continue;
  const assetPath = element.customData?.codexAssetPath;
  const fileRecord = scene.files?.[element.fileId];
  if (!assetPath || !fileRecord) {
    skipped += 1;
    continue;
  }
  try {
    await access(assetPath);
  } catch {
    skipped += 1;
    continue;
  }
  const posterDataURL = await extractVideoPosterDataURL({ path: assetPath });
  if (!posterDataURL) {
    console.warn(`poster extraction failed: ${assetPath}`);
    skipped += 1;
    continue;
  }
  fileRecord.dataURL = posterDataURL;
  fileRecord.mimeType = "image/jpeg";
  fileRecord.lastRetrieved = Date.now();
  updated += 1;
  console.log(`updated poster for ${element.id} (${assetPath.split("/").pop()})`);
}

if (updated > 0) await saveScene(args, scene);
console.log(`done: ${updated} updated, ${skipped} skipped`);
