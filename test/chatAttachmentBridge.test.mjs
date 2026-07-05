import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("selected canvas assets can be sent to Claude or Codex chat", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  assert.match(source, /function collectSelectedChatAttachmentItems\(overlays\)/);
  assert.match(source, /className="lovart-chat-attach-bar"/);
  assert.match(source, /sendSelectedChatAttachments\('claude'\)/);
  assert.match(source, /sendSelectedChatAttachments\('codex'\)/);
  assert.match(source, /assetItems: selectedChatAttachmentItems/);
});

test("chat bridge supports file paste for Codex and keeps Hermes auto-send", async () => {
  const bridge = await readFile(new URL("../lib/chatBridge.mjs", import.meta.url), "utf8");
  const server = await readFile(new URL("../vite.config.js", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  assert.match(bridge, /export async function pasteFilesIntoChatApp/);
  assert.match(bridge, /filePaths = \[\]/);
  assert.match(server, /filePaths: assetPaths/);
  assert.match(app, /autoSend: true,\s+text: 'Hermes Agent で Grok Imagine を使えるようにセットアップして。/);
});
