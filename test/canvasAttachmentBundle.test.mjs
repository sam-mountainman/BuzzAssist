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
