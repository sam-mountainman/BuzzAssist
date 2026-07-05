import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("audio attachments keep the previous audio-specific UI", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  assert.match(source, /function createAudioAttachmentPreviewDataURL\(asset\)/);
  assert.match(source, /<text[^>]*>AUDIO<\/text>/);
  assert.match(source, /if \(kind === 'audio'\) return createAudioAttachmentPreviewDataURL\(asset\)/);
  assert.match(source, /primaryAsset\.kind === 'audio' \? '音声' : truncateMiddle\(primaryAsset\.name \|\| '音声・動画', 12\)/);
});
