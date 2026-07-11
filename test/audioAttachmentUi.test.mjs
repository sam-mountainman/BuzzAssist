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
  const lovartSource = await readFile(new URL("../lib/lovartMediaGeneration.mjs", import.meta.url), "utf8");
  const mcpSource = await readFile(new URL("../mcp/server.mjs", import.meta.url), "utf8");

  assert.match(appSource, /function supportsAudioReference\(model\) \{\s*const lovart = getLovartVideoSettings\(model\)\s*if \(lovart\) return lovart\.maxReferenceAudios > 0\s*const family = videoFamilyForModel\(model\)\s*return family\?\.id === 'seedance-2' \|\| family\?\.id === 'seedance-2-fast'\s*\}/);
  assert.match(appSource, /function FileUploadLabel\(\{ accept, multiple = false, className = '', title, onOpen, onChange, children, \.\.\.labelProps \}\)/);
  assert.match(appSource, /<label\s*\{\.\.\.labelProps\}/);
  assert.match(appSource, /data-lovart-trigger="video-frame-audio"/);
  assert.match(appSource, /accept=\{getUploadTargetAccept\('videoReferenceAudios'\)\}/);
  assert.match(appSource, /const VIDEO_FILE_EXTENSIONS = new Set\(\['avi', 'm4v', 'mkv', 'mov', 'mp4', 'webm'\]\)/);
  assert.match(appSource, /const AUDIO_FILE_EXTENSIONS = new Set\(\['aac', 'flac', 'm4a', 'mp3', 'ogg', 'opus', 'wav'\]\)/);
  assert.match(appSource, /const AUDIO_REFERENCE_ACCEPT = '\.aac,\.flac,\.m4a,\.mp3,\.ogg,\.opus,\.wav,/);
  assert.match(appSource, /if \(VIDEO_FILE_EXTENSIONS\.has\(ext\)\) return 'video'/);
  assert.match(appSource, /if \(AUDIO_FILE_EXTENSIONS\.has\(ext\)\) return 'audio'/);
  assert.match(appSource, /function isAudioReferenceUploadFile\(file\) \{\s*const ext = fileExtensionFromName\(file\?\.name\)\s*if \(VIDEO_FILE_EXTENSIONS\.has\(ext\)\) return false\s*if \(AUDIO_FILE_EXTENSIONS\.has\(ext\)\) return true/);
  assert.match(appSource, /if \(target === 'videoReferenceAudios'\) return AUDIO_REFERENCE_ACCEPT/);
  assert.match(appSource, /if \(target === 'videoReferenceAudios'\) return isAudioReferenceUploadFile\(file\)/);
  assert.match(appSource, /videoFrameUploadTargetRef\.current = 'videoReferenceAudios'/);
  assert.match(appSource, /if \(target === 'videoReferenceAudios'\) \{\s*setGenerationError\('音声リファレンスは音声ファイルを直接アップロードしてください。'\)/);
  assert.match(appSource, /const uploadableFiles = files\.filter\(\(file\) => \{\s*const fileKind = getFileAssetKind\(file\)/);
  assert.match(appSource, /const uploaded = await Promise\.all\(uploadableFiles\.map\(uploadAssetFile\)\)/);
  assert.doesNotMatch(appSource, /setOpenMenu\(\(current\) => \(current === 'videoReferenceAudios' \? null : 'videoReferenceAudios'\)\)/);
  assert.doesNotMatch(appSource, /openMenu === 'videoReferenceAudios'/);
  assert.doesNotMatch(appSource, /data-lovart-canvas-pick-target="videoReferenceAudios"/);
  assert.doesNotMatch(appSource, /openCanvasPicker\('videoReferenceAudios'\)/);
  assert.match(appSource, /if \(kind === 'audio'\) return 'audio\/\*'/);
  assert.match(appSource, /onClick=\{\(event\) => \{ event\.stopPropagation\(\); notifyOpen\(\) \}\}/);
  assert.match(appSource, /const openNotifiedRef = useRef\(false\)/);
  assert.match(appSource, /referenceAudioPaths: savedForm\.videoTab === 'reference'/);
  assert.match(mediaSource, /async function referenceAudioPathsToDataUrls\(paths = \[\]\)/);
  assert.match(mediaSource, /reference_audio_urls: referenceAudioUrls/);
  assert.match(lovartSource, /for \(const path of Array\.isArray\(input\.referenceVideoPaths\) \? input\.referenceVideoPaths : \[\]\)/);
  assert.match(lovartSource, /for \(const path of Array\.isArray\(input\.referenceAudioPaths\) \? input\.referenceAudioPaths : \[\]\)/);
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
  assert.match(appSource, /onOpen=\{rememberGeneratorUploadFrame\}[\s\S]*?onChange=\{handleScriptFileChange\}/);
  assert.match(appSource, /const uploadSelectedResult = pendingGeneratorUploadResultRef\.current/);
  assert.match(appSource, /const uploadFrameId = restoreGeneratorUploadFrame\(\) \|\| activeFrameIdRef\.current/);
  assert.match(appSource, /addAssetToFrame\('subtitleScript', \{/);
  assert.match(appSource, /selectedGeneratedResult: uploadFrameId \? null : uploadSelectedResult/);
});

test("generator attachment slots support upload and canvas-pick paths", async () => {
  const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  for (const target of [
    "imageReferences",
    "subtitleAudio",
    "subtitleScript",
    "silenceCutVideo"
  ]) {
    assert.match(appSource, new RegExp(`openCanvasPicker\\('${target}'\\)`), `${target} canvas picker`);
  }

  assert.match(appSource, /onImageUploadChange/);
  assert.match(appSource, /onVideoFrameUploadChange/);
  assert.match(appSource, /slot === 'start' \? 'videoReferenceVideos' : 'videoReferenceImages'/);
  assert.match(appSource, /slot === 'start' \? 'videoStartFrame' : 'videoEndFrame'/);
  assert.match(appSource, /data-lovart-canvas-pick-target=\{target\}/);
  assert.match(appSource, /openCanvasPicker\(target\)/);
  assert.match(appSource, /accept=\{getUploadTargetAccept\(target\)\}/);
  assert.match(appSource, /accept=\{getUploadTargetAccept\('videoReferenceAudios'\)\}/);
  assert.match(appSource, /data-lovart-trigger="video-frame-audio"/);
  assert.match(appSource, /videoFrameUploadTargetRef\.current = 'videoReferenceAudios'/);
  assert.doesNotMatch(appSource, /data-lovart-canvas-pick-target="videoReferenceAudios"/);
  assert.doesNotMatch(appSource, /openCanvasPicker\('videoReferenceAudios'\)/);
  assert.match(appSource, /accept=\{getUploadTargetAccept\('subtitleAudio'\)\}/);
  assert.match(appSource, /data-lovart-canvas-pick-target="subtitleAudio"/);
  assert.match(appSource, /data-lovart-canvas-pick-target="silenceCutVideo"/);
  assert.match(appSource, /accept="video\/\*"/);
  assert.match(appSource, /accept="\.xml,application\/xml,text\/xml"/);
  assert.match(appSource, /accept="\.txt,\.md,\.markdown,text\/plain,text\/markdown"/);
  assert.match(appSource, /multiple=\{frameForm\.videoTab === 'reference'\}/);
  assert.match(appSource, /multiple\s*[\r\n]+\s*onOpen=\{\(\) => \{/);
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
