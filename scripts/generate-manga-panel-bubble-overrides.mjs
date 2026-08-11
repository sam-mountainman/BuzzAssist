#!/usr/bin/env node
// R59 invariant: bubble placement regions for split pages are DERIVED from
// the current panel geometry + per-panel-source face annotations on every
// run — never hand-copied coordinates that can go stale when a panel image
// or crop changes. Output: v39-panel-bubble-overrides.json in the episode
// dir, consumed by refresh-manga-v38-bubbles.mjs.
import { readFile, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { join, resolve, basename } from "node:path";
import { promisify } from "node:util";

import { normalizePanelLayout } from "../lib/mangaVideoPipeline.mjs";

const execFile = promisify(execFileCallback);
const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas/manga-videos/manga-photo-homecoming-001");
const manifestPath = join(episodeDir, "episode-manifest.json");
const outputPath = join(episodeDir, "v39-panel-bubble-overrides.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

// Character/face annotations per PANEL SOURCE image (normalized to that
// image). Measured on the actual current files; any new panel image must be
// added here in the same change that introduces it.
const PANEL_IMAGE_FACES = {
  "manga-photo-homecoming-001-v38-panelcrop-cut06-mio-face.png": [
    { id: "mio-face", speakerId: "manga-photo-homecoming-001-character-2", x: 0.26, y: 0.02, width: 0.3, height: 0.3 },
  ],
  "manga-photo-homecoming-001-v38-panelcrop-cut06-reiji-face.png": [
    { id: "reiji-face", speakerId: "manga-photo-homecoming-001-character-3", x: 0.27, y: 0.1, width: 0.45, height: 0.45 },
  ],
  "manga-photo-homecoming-001-v31-cut-08-u01-phone-send-ots.png": [
    { id: "ren-face", speakerId: "manga-photo-homecoming-001-character-1", x: 0.495, y: 0.035, width: 0.105, height: 0.17 },
    { id: "mio-head", speakerId: "manga-photo-homecoming-001-character-2", x: 0.62, y: 0.0, width: 0.33, height: 0.62 },
  ],
  "manga-photo-homecoming-001-v38-panelcrop-cut08-reiji-gallery.png": [
    { id: "reiji-gallery-face", speakerId: "manga-photo-homecoming-001-character-3", x: 0.42, y: 0.25, width: 0.18, height: 0.26 },
  ],
  "manga-photo-homecoming-001-v38-panelcrop-cut08-reiji-shock.png": [
    { id: "reiji-shock-face", speakerId: "manga-photo-homecoming-001-character-3", x: 0.39, y: 0.28, width: 0.29, height: 0.5 },
  ],
};

const imageSize = async (imagePath) => {
  const { stdout } = await execFile("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "json", imagePath,
  ]);
  const stream = JSON.parse(stdout).streams[0];
  return { width: stream.width, height: stream.height };
};

const overrides = {};
for (const cut of manifest.cuts || []) {
  if (!cut.panelLayout?.enabled) continue;
  const layout = normalizePanelLayout(cut.panelLayout, 1920, 1080, cut.imagePath);
  // Overlay canvases for panel cuts are authored at the spec image size;
  // read it from any utterance spec of the cut.
  const utterances = (manifest.utterances || []).filter((u) => u.cutId === cut.id);
  const spec = JSON.parse(await readFile(utterances[0].overlaySpecPath, "utf8"));
  const overlayWidth = Number(spec.imageSize?.width) || 1920;
  const overlayHeight = Number(spec.imageSize?.height) || 1080;
  const scaleX = overlayWidth / 1920;
  const scaleY = overlayHeight / 1080;

  const pageFaces = [];
  for (const [index, panel] of layout.panels.entries()) {
    const slot = layout.slots[index];
    const faces = PANEL_IMAGE_FACES[basename(panel.imagePath)];
    if (!faces) throw new Error(`No face annotation registered for panel image ${basename(panel.imagePath)} (${cut.id} panel ${index}); annotate it before rendering.`);
    const { width: iw, height: ih } = await imageSize(panel.imagePath);
    const zoom = Number(panel.camera?.zoomStart) || 1;
    const focusX = Number(panel.camera?.focusX ?? 0.5);
    const focusY = Number(panel.camera?.focusY ?? 0.5);
    const scale = Math.max(slot.width / iw, slot.height / ih);
    const coverWidth = slot.width / scale;
    const coverHeight = slot.height / scale;
    const coverX = (iw - coverWidth) / 2;
    const coverY = (ih - coverHeight) / 2;
    const windowWidth = coverWidth / zoom;
    const windowHeight = coverHeight / zoom;
    const windowX = coverX + Math.max(0, Math.min(coverWidth - windowWidth, coverWidth * focusX - windowWidth / 2));
    const windowY = coverY + Math.max(0, Math.min(coverHeight - windowHeight, coverHeight * focusY - windowHeight / 2));
    for (const face of faces) {
      const fx0 = face.x * iw;
      const fy0 = face.y * ih;
      const fx1 = (face.x + face.width) * iw;
      const fy1 = (face.y + face.height) * ih;
      let px0 = slot.x + (fx0 - windowX) / windowWidth * slot.width;
      let py0 = slot.y + (fy0 - windowY) / windowHeight * slot.height;
      let px1 = slot.x + (fx1 - windowX) / windowWidth * slot.width;
      let py1 = slot.y + (fy1 - windowY) / windowHeight * slot.height;
      // Clip to the panel slot: content outside it is not on the page.
      px0 = Math.max(px0, slot.x); py0 = Math.max(py0, slot.y);
      px1 = Math.min(px1, slot.x + slot.width); py1 = Math.min(py1, slot.y + slot.height);
      if (px1 - px0 < 8 || py1 - py0 < 8) continue;
      pageFaces.push({
        id: face.id,
        speakerId: face.speakerId,
        x: px0 * scaleX, y: py0 * scaleY,
        width: (px1 - px0) * scaleX, height: (py1 - py0) * scaleY,
      });
    }
  }
  for (const utterance of utterances) {
    const regions = pageFaces.map((pageFace) => (
      pageFace.speakerId === utterance.speakerId
        ? { id: pageFace.id, kind: "face", x: pageFace.x, y: pageFace.y, width: pageFace.width, height: pageFace.height, weight: 1600 }
        : { id: pageFace.id, kind: "secondary-head", x: pageFace.x, y: pageFace.y, width: pageFace.width, height: pageFace.height, weight: 720 }
    ));
    // Narration cards: protect every face softly-strong (no active speaker on
    // screen, but the reference keeps narration boxes off faces).
    if (utterance.preset === "narration") {
      for (const region of regions) { region.kind = "secondary-head"; region.weight = 900; }
    }
    overrides[utterance.id] = { avoidRegions: regions };
  }
}
await writeFile(outputPath, JSON.stringify({ version: "v39-panel-bubble-overrides-r1", generatedAt: new Date().toISOString(), overrides }, null, 1));
process.stdout.write(`${JSON.stringify({ outputPath, utteranceCount: Object.keys(overrides).length }, null, 2)}\n`);
