import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} should exist`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} should exist after ${startMarker}`);
  return source.slice(start, end);
}

test("uploaded .srt files become subtitle cards, not generic attachments", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const inserter = sliceBetween(source, "const insertMediaFiles", "const onToolbarMediaInputChange");
  const srtBranch = sliceBetween(inserter, "} else if (fileKind === 'srt') {", "} else {");

  assert.match(srtBranch, /codexGeneratedSubtitle: true/, "SRT preview overlay keys off codexGeneratedSubtitle");
  assert.match(srtBranch, /codexMediaKind: 'subtitle'/, "card must carry the subtitle media kind");
  assert.match(srtBranch, /SUBTITLE_CARD_WIDTH/, "card must use the shared subtitle footprint");
  assert.match(srtBranch, /subtitleCueCount/, "cue count should be derived from the uploaded file");
  assert.match(srtBranch, /backgroundColor: '#ffffff'/, "selected card inset should reveal a white backing");
  assert.match(srtBranch, /roundness: null/, "selected card corners should remain square");
});

test("subtitle card footprint matches the server-side constant (205x364 portrait)", async () => {
  const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(appSource, /const SUBTITLE_CARD_WIDTH = 205/);
  assert.match(appSource, /const SUBTITLE_CARD_HEIGHT = 364/);
});

test("toolbar upload input and drag-drop both accept .srt", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const toolbarInput = sliceBetween(source, 'data-lovart-upload-input="toolbar-media"', "onChange");
  assert.match(toolbarInput, /accept="[^"]*\.srt[^"]*"/, "toolbar file input should accept .srt");
  const dragCheck = sliceBetween(source, "const hasMediaFiles", "const onDragOver");
  assert.match(dragCheck, /application\/x-subrip/, "drag-over detection should recognize SRT MIME type");
});
