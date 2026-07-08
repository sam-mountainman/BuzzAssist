import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("audio attachments keep the previous audio-specific UI", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  assert.match(source, /function createAudioAttachmentPreviewDataURL\(asset\)/);
  assert.match(source, /<text[^>]*>AUDIO<\/text>/);
  assert.match(source, /if \(kind === 'audio'\) return createAudioAttachmentPreviewDataURL\(asset\)/);
  assert.doesNotMatch(source, /primaryAsset\.kind === 'audio' \? '音声' : truncateMiddle\(primaryAsset\.name \|\| '音声・動画', 12\)/);
  assert.match(source, /className="lovart-utility-tilt-card primary audio-empty"/);
  assert.match(source, /<span className="lovart-add-plus">\+<\/span>\s*\{trayOpen \? <span className="lovart-utility-card-hint">音声<\/span> : null\}/);
  assert.doesNotMatch(source, /className="lovart-utility-asset-card audio empty"/);
});

test("file attachment previews leave the selection border unobstructed", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /stroke="#d7dce5"/);
  assert.doesNotMatch(source, /<rect width="100%" height="100%" rx="14" fill="#ffffff"\/>/);
  assert.match(source, /<rect width="100%" height="100%" fill="#ffffff"\/>/);
  assert.match(source, /const selectedPreviewInset = isSelected \? 5 : 0/);
  assert.match(source, /if \(!\(isCanvasAttachableElement\(element\) \|\| isGeneratorFrame\(element\)\)\) return false/);
});

test("video generator exposes and forwards audio references", async () => {
  const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const mediaSource = await readFile(new URL("../lib/mediaGeneration.mjs", import.meta.url), "utf8");
  const mcpSource = await readFile(new URL("../mcp/server.mjs", import.meta.url), "utf8");

  assert.match(appSource, /function supportsAudioReference\(model\) \{\s*return model === 'seedance-2' \|\| model === 'seedance-2-fast'\s*\}/);
  assert.match(appSource, /videoFrameUploadTargetRef\.current = 'videoReferenceAudios'/);
  assert.match(appSource, /className="lovart-add-frame-btn audio"[\s\S]*accept=\{getUploadTargetAccept\('videoReferenceAudios'\)\}/);
  assert.match(appSource, /if \(kind === 'audio'\) return 'audio\/\*'/);
  assert.match(appSource, /onClick=\{\(event\) => \{ event\.stopPropagation\(\); onOpen\?\.\(\) \}\}/);
  assert.doesNotMatch(appSource, /data-lovart-canvas-pick-target="videoReferenceAudios"/);
  assert.doesNotMatch(appSource, /openCanvasPicker\('videoReferenceAudios'\)/);
  assert.match(appSource, /referenceAudioPaths: savedForm\.videoTab === 'reference'/);
  assert.match(mediaSource, /async function referenceAudioPathsToDataUrls\(paths = \[\]\)/);
  assert.match(mediaSource, /reference_audio_urls: referenceAudioUrls/);
  assert.match(mcpSource, /referenceAudioPaths: args\.referenceAudioPaths \?\? args\.reference_audio_paths/);
});

test("subtitle utility attachments collapse until hover, menu, or attachment", async () => {
  const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  assert.match(appSource, /const utilitySlotMenuOpen = isSilencePanel\s*\? openMenu === 'silence-video-source'\s*: openMenu === 'subtitle-audio-source' \|\| openMenu === 'subtitle-script-source'/);
  assert.match(appSource, /const trayOpen =\s*utilityTrayHovered \|\|\s*Boolean\(primaryAsset\) \|\|\s*utilitySlotMenuOpen \|\|\s*\(!isSilencePanel && !scriptSlotDisabled && hasScriptFile\)/);
  assert.doesNotMatch(appSource, /: true\s*const primaryTarget/);
  assert.match(appSource, /if \(target === 'subtitleScript'\) return \{ \.\.\.form, subtitleScriptText: String\(asset\?\.text \|\| ''\)\.trim\(\), subtitleScriptName: asset\?\.name \|\| 'script\.txt' \}/);
  assert.match(appSource, /if \(picker\.target === 'subtitleScript' && asset\.kind !== 'script'\) \{\s*return keepPickingWithError\('この欄には台本ファイルを選択してください。'\)\s*\}/);
  assert.match(appSource, /data-lovart-canvas-pick-target="subtitleScript"/);
  assert.match(appSource, /openCanvasPicker\('subtitleScript'\)/);
});

test("video mode tabs keep the BuzzAssist disabled secondary segment", async () => {
  const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const cssSource = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(appSource, /return \['keyframe', model === 'kling-v2-6' \|\| model === 'kling-v3' \? 'motion' : 'reference'\]/);
  assert.match(appSource, /function isVideoTabDisabledForModel\(model, tab\) \{\s*model = resolveGatingVideoModel\(model\)\s*return model === 'kling-v3' && tab === 'motion'\s*\}/);
  assert.match(appSource, /disabled=\{tabDisabled\}/);
  assert.match(appSource, /tabDisabled \? 'is-disabled' : ''/);
  assert.match(cssSource, /\.lovart-video-tabs button:disabled,\s*\.lovart-video-tabs button\.is-disabled/);
});
