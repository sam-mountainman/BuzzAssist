import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  canvasAttachmentBundleToMcpResult,
  createCanvasAttachmentBundle,
  listCanvasAttachmentBundles,
} from "../lib/canvasAttachmentBundle.mjs";

test("canvas attachment bundles expose selected assets to MCP content", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "buzzassist-attachments-"));
  const canvasDir = join(projectDir, "canvas");
  const assetsDir = join(canvasDir, "assets");
  await mkdir(assetsDir, { recursive: true });
  await writeFile(join(assetsDir, "cat.png"), Buffer.from("fake-png"));
  await writeFile(join(assetsDir, "cut.xml"), "<xmeml />\n", "utf8");

  const bundle = await createCanvasAttachmentBundle({
    canvasDir,
    assets: [
      { assetUrl: "/excalidraw-assets/cat.png", fileName: "cat.png", kind: "image", mimeType: "image/png" },
      { assetUrl: "/excalidraw-assets/cut.xml", fileName: "cut.xml", kind: "xml", mimeType: "application/xml" },
    ],
  });

  assert.equal(bundle.assets.length, 2);
  assert.equal(bundle.assets[0].name, "cat.png");
  assert.match(bundle.assets[0].uri, /^file:\/\//);

  const result = await canvasAttachmentBundleToMcpResult({ canvasDir, bundleId: bundle.id });
  assert.equal(result.structuredContent.id, bundle.id);
  assert.ok(result.content.some((item) => item.type === "image" && item.mimeType === "image/png"));
  assert.ok(result.content.some((item) => item.type === "resource_link" && item.name === "cut.xml"));
  assert.ok(result.content.some((item) => item.type === "resource" && item.resource.text.includes("<xmeml")));

  const listed = await listCanvasAttachmentBundles({ canvasDir });
  assert.equal(listed[0].id, bundle.id);

  await rm(projectDir, { recursive: true, force: true });
});

test("canvas attachment bundles preserve every supported chat attachment kind", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "buzzassist-all-attachments-"));
  const canvasDir = join(projectDir, "canvas");
  const assetsDir = join(canvasDir, "assets");
  await mkdir(assetsDir, { recursive: true });

  const fixtures = [
    ["image.png", "image", "image/png", Buffer.from("fake-png")],
    ["video.mp4", "video", "video/mp4", Buffer.from("fake-video")],
    ["audio.wav", "audio", "audio/wav", Buffer.from("fake-audio")],
    ["captions.srt", "srt", "application/x-subrip", "1\n00:00:00,000 --> 00:00:01,000\nHello\n"],
    ["timeline.xml", "xml", "application/xml", "<xmeml />\n"],
    ["script.md", "script", "text/markdown", "# Script\nHello\n"],
  ];
  for (const [fileName, , , contents] of fixtures) {
    await writeFile(join(assetsDir, fileName), contents);
  }

  const bundle = await createCanvasAttachmentBundle({
    canvasDir,
    assets: fixtures.map(([fileName, kind, mimeType]) => ({
      assetUrl: `/excalidraw-assets/${fileName}`,
      fileName,
      kind,
      mimeType,
    })),
  });
  assert.deepEqual(bundle.assets.map((asset) => asset.kind), [
    "image",
    "video",
    "audio",
    "srt",
    "xml",
    "script",
  ]);

  const result = await canvasAttachmentBundleToMcpResult({ canvasDir, bundleId: bundle.id });
  const links = result.content.filter((item) => item.type === "resource_link");
  assert.deepEqual(links.map((item) => item.name), fixtures.map(([fileName]) => fileName));
  assert.ok(result.content.some((item) => item.type === "image" && item.mimeType === "image/png"));
  for (const textName of ["captions.srt", "timeline.xml", "script.md"]) {
    assert.ok(
      result.content.some(
        (item) => item.type === "resource" && item.resource.uri.endsWith(`/${textName}`),
      ),
      `${textName} should be inlined as text`,
    );
  }

  await rm(projectDir, { recursive: true, force: true });
});
