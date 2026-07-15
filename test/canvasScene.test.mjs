import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  insertExcalidrawImage,
  insertExcalidrawMediaBatch,
  insertExcalidrawSilenceCutResult,
  insertExcalidrawSubtitle,
  insertGeneratorFrameBatch,
  isSafeChildPath,
  normalizeScene,
  normalizeSilenceCutTextPreviewCards,
  normalizeSubtitleCards,
  resolveCanvasDir,
  resolveFocusRequestFile,
  sanitizeFileName,
  writeCanvasFocusRequest,
} from "../lib/canvasScene.mjs";

const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

test("resolveCanvasDir prefers explicit canvasDir", () => {
  assert.equal(
    resolveCanvasDir({ canvasDir: "/tmp/custom-canvas", projectDir: "/tmp/project" }),
    resolve("/tmp/custom-canvas"),
  );
});

test("resolveCanvasDir maps projectDir to project canvas directory", () => {
  assert.equal(resolveCanvasDir({ projectDir: "/tmp/project" }), join(resolve("/tmp/project"), "canvas"));
});

test("writeCanvasFocusRequest stores a one-shot selection and viewport request", async () => {
  const canvasDir = await mkdtemp(join(tmpdir(), "excalidraw-focus-"));
  try {
    const result = await writeCanvasFocusRequest({ canvasDir }, ["image-1", "image-1", "video-2"]);
    const stored = JSON.parse(await readFile(resolveFocusRequestFile({ canvasDir }), "utf8"));
    assert.deepEqual(result.elementIds, ["image-1", "video-2"]);
    assert.deepEqual(stored.elementIds, ["image-1", "video-2"]);
    assert.equal(stored.applySelection, true);
    assert.equal(stored.applyViewport, true);
    assert.equal(typeof stored.requestId, "string");
  } finally {
    await rm(canvasDir, { recursive: true, force: true });
  }
});

test("generator batches fill five columns before starting the second row", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "excalidraw-generator-grid-"));
  try {
    const results = await insertGeneratorFrameBatch({
      projectDir,
      frames: Array.from({ length: 6 }, (_, index) => ({
        kind: "image",
        prompt: `image ${index + 1}`,
        aspectRatio: "1:1",
      })),
      columns: 5,
      gap: 24,
    });

    assert.equal(results.length, 6);
    assert.deepEqual(
      results.slice(0, 5).map((result) => result.bounds.x),
      results.slice(0, 5).map((_, index) => results[0].bounds.x + index * (results[0].bounds.width + 24)),
    );
    assert.deepEqual(results.slice(0, 5).map((result) => result.bounds.y), Array(5).fill(results[0].bounds.y));
    assert.equal(results[5].bounds.x, results[0].bounds.x);
    assert.equal(results[5].bounds.y, results[0].bounds.y + results[0].bounds.height + 24);

    const saved = JSON.parse(await readFile(join(projectDir, "canvas", "excalidraw-canvas.json"), "utf8"));
    const placeholders = saved.elements.filter((element) => element.customData?.codexGenerating === true);
    assert.equal(placeholders.length, 6);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("sanitizeFileName preserves BuzzAssist-style display names", () => {
  assert.equal(sanitizeFileName("../bad name?.png", "fallback.png"), "bad name?.png");
  assert.equal(sanitizeFileName("2026年はPodcastの時代になる理由.mp4", "fallback.mp4"), "2026年はPodcastの時代になる理由.mp4");
  assert.equal(sanitizeFileName("folder\\clip.mp4", "fallback.mp4"), "folder_clip.mp4");
});

test("isSafeChildPath rejects parent traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "excalidraw-safe-"));
  try {
    assert.equal(isSafeChildPath(root, join(root, "assets", "image.png")), true);
    assert.equal(isSafeChildPath(root, join(root, "..", "image.png")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizeScene fills missing Excalidraw shape", () => {
  const scene = normalizeScene(null);
  assert.equal(scene.type, "excalidraw");
  assert.deepEqual(scene.elements, []);
  assert.deepEqual(scene.files, {});
});

test("SRT cards use the BuzzAssist portrait footprint instead of matching the anchor", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "excalidraw-srt-footprint-"));
  try {
    const canvasDir = join(projectDir, "canvas");
    await mkdir(canvasDir, { recursive: true });
    const scene = {
      type: "excalidraw",
      version: 2,
      source: "test",
      elements: [
        {
          id: "video-anchor",
          type: "image",
          x: 10,
          y: 20,
          width: 364,
          height: 205,
          isDeleted: false,
          customData: { codexMediaKind: "video" },
        },
      ],
      appState: { selectedElementIds: { "video-anchor": true } },
      files: {},
    };
    await writeFile(join(canvasDir, "excalidraw-selection.json"), JSON.stringify({ selectedElementIds: ["video-anchor"] }));
    await writeFile(join(canvasDir, "excalidraw-canvas.json"), JSON.stringify(scene));

    const result = await insertExcalidrawSubtitle({
      projectDir,
      srtText: "1\n00:00:00,000 --> 00:00:01,000\nテスト\n",
      fileName: "SRT1.srt",
    });

    assert.equal(result.bounds.width, 205);
    assert.equal(result.bounds.height, 364);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("generated images persist BuzzAssist-style numbered file names", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "excalidraw-image-name-"));
  try {
    const result = await insertExcalidrawImage({
      projectDir,
      mediaBuffer: ONE_BY_ONE_PNG,
      mimeType: "image/png",
    });
    const saved = JSON.parse(await readFile(join(projectDir, "canvas", "excalidraw-canvas.json"), "utf8"));
    const element = saved.elements.find((item) => item.id === result.elementId);

    assert.equal(result.fileName, "Image1.png");
    assert.equal(element.customData.codexMediaKind, "image");
    assert.equal(element.customData.codexFileName, "Image1.png");
    assert.equal(saved.files[result.fileId].name, "Image1.png");
    assert.equal(saved.files[result.fileId].dataURL, "/excalidraw-assets/Image1.png");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("batch images persist the same numbered file names in element and file metadata", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "excalidraw-batch-name-"));
  try {
    const [result] = await insertExcalidrawMediaBatch({
      projectDir,
      items: [{ kind: "image", mediaBuffer: ONE_BY_ONE_PNG, mimeType: "image/png" }],
    });
    const saved = JSON.parse(await readFile(join(projectDir, "canvas", "excalidraw-canvas.json"), "utf8"));
    const element = saved.elements.find((item) => item.id === result.elementId);

    assert.equal(result.fileName, "Image1.png");
    assert.equal(element.customData.codexMediaKind, "image");
    assert.equal(element.customData.codexFileName, "Image1.png");
    assert.equal(saved.files[result.fileId].name, "Image1.png");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("silence-cut XML results replace generators with SRT-style text preview cards", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "excalidraw-silence-cut-result-"));
  try {
    const canvasDir = join(projectDir, "canvas");
    const assetsDir = join(canvasDir, "assets");
    await mkdir(assetsDir, { recursive: true });
    const xmlPath = join(assetsDir, "cut.xml");
    await writeFile(xmlPath, "<xmeml version=\"4\"></xmeml>\n");
    const anchor = {
      id: "silence-generator",
      type: "rectangle",
      x: 120,
      y: 80,
      width: 364,
      height: 205,
      isDeleted: false,
      customData: { "buzzassist.silenceCutGenerator.frame": true },
    };
    await writeFile(join(canvasDir, "excalidraw-canvas.json"), JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "test",
      elements: [anchor],
      appState: { selectedElementIds: { [anchor.id]: true } },
      files: {},
    }));

    const result = await insertExcalidrawSilenceCutResult({
      projectDir,
      assetPath: xmlPath,
      fileName: "cut.xml",
      model: "ffmpeg-local",
      inputDuration: 120,
      outputDuration: 100,
      cutDuration: 20,
      cutCount: 3,
      clipCount: 4,
      anchorElementId: anchor.id,
      replaceAnchor: true,
      matchAnchor: false,
    });

    const saved = JSON.parse(await readFile(join(canvasDir, "excalidraw-canvas.json"), "utf8"));
    const element = saved.elements.find((item) => item.id === result.elementId);
    const replacedAnchor = saved.elements.find((item) => item.id === anchor.id);

    assert.equal(replacedAnchor.isDeleted, true);
    assert.equal(result.replacedAnchor, true);
    assert.equal(element.type, "rectangle");
    assert.equal(element.customData["buzzassist.silenceCutGenerator.frame"], undefined);
    assert.equal(element.customData["buzzassist.imageGenerator.frame"], undefined);
    assert.equal(element.customData.codexMediaKind, "xml");
    assert.equal(element.customData.codexTextPreview, true);
    assert.equal(element.customData.codexAssetPath, xmlPath);
    assert.equal(element.customData.codexAssetUrl, "/excalidraw-assets/cut.xml");
    assert.equal(element.customData.silenceCutOutputAsset.name, "cut.xml");
    assert.equal(element.customData.silenceCutOutputAsset.kind, "xml");
    assert.equal(element.customData.silenceCutOutputAsset.path, xmlPath);
    assert.deepEqual(saved.files, {});
    assert.deepEqual(result.bounds, { x: 199.5, y: 0.5, width: 205, height: 364 });
    assert.equal(saved.appState.selectedElementIds[result.elementId], true);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("legacy landscape silence-cut cards migrate once to the portrait SRT footprint", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "excalidraw-silence-cut-migrate-"));
  try {
    const canvasDir = join(projectDir, "canvas");
    await mkdir(canvasDir, { recursive: true });
    await writeFile(join(canvasDir, "excalidraw-canvas.json"), JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "test",
      elements: [{
        id: "legacy-xml",
        type: "image",
        x: 120,
        y: 80,
        width: 364,
        height: 205,
        isDeleted: false,
        customData: {
          codexGeneratedSilenceCut: true,
          codexMediaKind: "xml",
          codexAssetUrl: "/excalidraw-assets/JetCut1.xml",
        },
      }],
      appState: {},
      files: {},
    }));

    assert.deepEqual(await normalizeSilenceCutTextPreviewCards({ projectDir }), { normalized: 1 });
    const saved = JSON.parse(await readFile(join(canvasDir, "excalidraw-canvas.json"), "utf8"));
    const element = saved.elements[0];
    assert.equal(element.x, 199.5);
    assert.equal(element.y, 0.5);
    assert.equal(element.width, 205);
    assert.equal(element.height, 364);
    assert.equal(element.customData.codexTextPreview, true);
    assert.deepEqual(await normalizeSilenceCutTextPreviewCards({ projectDir }), { normalized: 0 });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("normalizeSubtitleCards fixes saved landscape and square SRT cards", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "excalidraw-srt-normalize-"));
  try {
    const canvasDir = join(projectDir, "canvas");
    await mkdir(canvasDir, { recursive: true });
    const scene = {
      type: "excalidraw",
      version: 2,
      source: "test",
      elements: [
        {
          id: "landscape-srt",
          type: "rectangle",
          x: 100,
          y: 200,
          width: 364,
          height: 205,
          isDeleted: false,
          customData: { codexGeneratedSubtitle: true, codexMediaKind: "subtitle" },
        },
        {
          id: "square-srt",
          type: "rectangle",
          x: 400,
          y: 600,
          width: 512,
          height: 512,
          isDeleted: false,
          customData: { codexGeneratedSubtitle: true, codexMediaKind: "subtitle" },
        },
      ],
      appState: {},
      files: {},
    };
    await writeFile(join(canvasDir, "excalidraw-canvas.json"), JSON.stringify(scene));

    const result = await normalizeSubtitleCards({ projectDir });
    const saved = JSON.parse(await readFile(join(canvasDir, "excalidraw-canvas.json"), "utf8"));

    assert.equal(result.normalized, 2);
    for (const element of saved.elements) {
      assert.equal(element.width, 205);
      assert.equal(element.height, 364);
      assert.equal(element.backgroundColor, "#ffffff");
      assert.equal(element.strokeColor, "#d9d9d9");
      assert.equal(element.roundness, null);
    }
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
