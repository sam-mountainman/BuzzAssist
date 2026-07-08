import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("uploaded canvas media does not open the generator prompt panel", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const match = source.match(/function isPanelMediaTargetElement\(element\) \{\n([\s\S]*?)\n\}/);
  assert.ok(match, "Missing isPanelMediaTargetElement");
  assert.match(match[1], /isGeneratedResult\(element\)/);
  assert.doesNotMatch(match[1], /isCanvasImageElement\(element\)/);
  assert.doesNotMatch(match[1], /isCanvasVideoElement\(element\)/);
});

test("prompt panel keeps the desktop layout, scaled and kept reachable on phones", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  // Centering formula (frame center minus half the panel) is still the default
  // desktop placement.
  assert.match(source, /const rawLeft = Math\.round\(\(Number\(target\?\.left\) \|\| 0\) \+ frameViewportWidth \/ 2 - panelWidth \/ 2\)/);
  assert.match(source, /const rawTop = Math\.round\(targetTop \+ frameViewportHeight \+ 4\)/);
  assert.match(source, /const left = isCompactViewport\s*\?\s*clamp\(rawLeft, minLeft, Math\.max\(minLeft, maxLeft\)\)\s*:\s*rawLeft/);
  assert.match(source, /const top = isCompactViewport && viewportHeight > 0\s*\?\s*clamp\(rawTop, minTop, Math\.max\(minTop, maxTop\)\)\s*:\s*rawTop/);
  assert.match(source, /left,\s*top,/);
  // Phones shrink the whole panel with a CSS scale instead of reflowing it, so
  // the mobile UI is pixel-identical to desktop, just smaller. The outer
  // placement is clamped after scaling so it stays reachable while panning.
  assert.match(source, /const panelScale = viewportWidth > 0 && viewportWidth <= 900\s*\?\s*Math\.min\(1, \(viewportWidth - 16\) \/ desiredWidth\)/);
  assert.match(source, /const transformInsetX = \(panelWidth - panelVisualWidth\) \/ 2/);
  assert.match(source, /transform: panelPlacement\.scale && panelPlacement\.scale < 1 \? `scale\(\$\{panelPlacement\.scale\}\)` : 'none'/);
  assert.match(source, /transformOrigin: 'top center'/);
  assert.match(source, /if \(kind === 'subtitle'\) return 300/);
});

test("phone tunnel renders images via capped overlays instead of hydrating Excalidraw files", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  assert.match(source, /const CANVAS_ASSET_PLACEHOLDER_DATA_URL = 'data:image\/gif;base64,/);
  assert.match(source, /const MOBILE_IMAGE_PREVIEW_OVERLAY_MAX_ITEMS = 8/);
  assert.match(source, /import \{[^}]*useMemo[^}]*\} from 'react'/s);
  assert.match(source, /function isNarrowCanvasViewport\(\)/);
  assert.match(source, /function isMemoryConstrainedCanvasRuntime\(\) \{\s*return isTunnelCanvasRuntime\(\) && \(isTouchLikeDevice\(\) \|\| isNarrowCanvasViewport\(\)\)\s*\}/);
  assert.match(source, /placeholderAssetBackedFilesByIds\(runtimeScene, assetBackedCanvasImageFileIds\(runtimeScene\)\)/);
  assert.match(source, /function CanvasImagePreviewOverlay\(\{ image \}\)/);
  assert.match(source, /selectedImageOverlays\.filter\(\(img\) => img\.assetType === 'image' && img\.assetUrl\)/);
  assert.match(source, /MOBILE_IMAGE_PREVIEW_OVERLAY_MAX_ITEMS/);
  assert.match(source, /is-memory-constrained-canvas/);
  assert.match(source, /if \(memoryConstrained\) return/);
  assert.match(source, /isTouchLikeDevice\(\)\s*\|\|\s*!initialScene/);
  assert.match(source, /preload="metadata"/);
  assert.doesNotMatch(source, /preload="auto"/);
});

test("left generator rail keeps requested utility tool order", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const image = source.indexOf('data-lovart-generator-kind="image"');
  const video = source.indexOf('data-lovart-generator-kind="video"');
  const subtitle = source.indexOf('data-lovart-generator-kind="subtitle"');
  const silenceCut = source.indexOf('data-lovart-generator-kind="silenceCut"');

  assert.ok(image > 0, "missing image generator button");
  assert.ok(video > image, "video should follow image");
  assert.ok(silenceCut > video, "silence cut should follow video");
  assert.ok(subtitle > silenceCut, "SRT should follow silence cut");
});

test("tunnel generation requests use async responses to avoid Cloudflare timeouts", async () => {
  const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const viteSource = await readFile(new URL("../vite.config.js", import.meta.url), "utf8");

  assert.match(appSource, /const useAsyncGeneration = isTunnelCanvasRuntime\(\)/);
  assert.match(appSource, /\.\.\.\(useAsyncGeneration \? \{ prefer: 'respond-async' \} : \{\}\)/);
  assert.match(appSource, /JSON\.stringify\(useAsyncGeneration \? \{ \.\.\.body, async: true \} : body\)/);
  assert.match(appSource, /if \(payload\.async\) \{/);

  assert.match(viteSource, /function wantsAsyncGeneration\(req, body = \{\}\) \{/);
  assert.match(viteSource, /prefer\.includes\('respond-async'\) \|\| body\.async === true/);
  assert.match(viteSource, /sendJson\(res, 202, \{ ok: true, async: true, jobId, kind: 'image' \}\)/);
  assert.match(viteSource, /sendJson\(res, 202, \{ ok: true, async: true, jobId, kind: 'video' \}\)/);
  assert.match(viteSource, /runBackgroundGeneration\(jobId, runImageGeneration\)/);
  assert.match(viteSource, /runBackgroundGeneration\(jobId, runVideoGeneration\)/);
});

test("generator creation keeps a moved viewport instead of focusing every new frame", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  assert.match(source, /after the user pans\/zooms elsewhere, create\s*\/\/ the frame in that current viewport and do not pull the camera back/);
  assert.doesNotMatch(source, /Math\.abs\(curZoom - fitZoom\) > 0\.01/);
  assert.match(source, /if \(viewportMoved\) \{\s*\/\/ BuzzAssist behavior:[\s\S]*?if \(wasOverlapping\) \{/);
  assert.match(source, /targetScrollX = targetScreenX \/ targetZoom - frameCenterX/);
  assert.match(source, /targetScrollY = targetScreenY \/ targetZoom - frameCenterY/);
});

test("attachments from a generated result panel do not fall back to another frame", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  assert.match(source, /const getAttachmentDestinationFrameId = useCallback\(\(\) => \{/);
  assert.match(source, /if \(activeFrameIdRef\.current\) return activeFrameIdRef\.current/);
  assert.match(source, /if \(selectedGeneratedResultRef\.current\) return ''/);
  assert.match(source, /return lastFocusedFrameIdRef\.current \|\| ''/);
  assert.match(source, /const frameId = getAttachmentDestinationFrameId\(\)/);
  assert.match(source, /function snapshotSelectedGeneratedResult\(result\)/);
  assert.match(source, /const selectedGeneratedResult = frameId \? null : snapshotSelectedGeneratedResult\(selectedGeneratedResultRef\.current\)/);
  assert.match(source, /canvasPickerRef\.current = \{ target, frameId, selectedGeneratedResult \}/);
  assert.match(source, /selectedGeneratedResult: picker\.selectedGeneratedResult \|\| null/);
  assert.match(source, /pendingGeneratorUploadResultRef\.current = frameId \? null : snapshotSelectedGeneratedResult\(selectedGeneratedResultRef\.current\)/);
  assert.match(source, /const selectedResult = !frameId[\s\S]*?options\.selectedGeneratedResult \|\| selectedGeneratedResultRef\.current/);
  assert.match(source, /const updateGeneratedResultElement = useCallback/);
  assert.match(source, /isGeneratedResult\(resultElement\)/);
  assert.match(source, /frameCustomDataFromForm\(kind, nextForm\)/);
  assert.match(source, /updateGeneratedResultElement\(nextForm, selectedResult\)/);
  assert.doesNotMatch(source, /const frameId = activeFrameIdRef\.current \|\| lastFocusedFrameIdRef\.current \|\| ''/);
});

test("generated result settings are written to the result element", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  assert.match(source, /const result = frameId \? null : snapshotSelectedGeneratedResult\(selectedGeneratedResultRef\.current\)/);
  assert.match(source, /pendingFrameFormWriteRef\.current = \{ timer, form, frameId, result \}/);
  assert.match(source, /updateGeneratedResultElementRef\.current\?\.\(form, result\)/);
  assert.match(source, /const customData = \{\s*\.\.\.\(resultElement\.customData \?\? \{\}\),\s*\.\.\.frameCustomDataFromForm\(kind, nextForm\)\s*\}/);
});

test("programmatic scene echoes do not resync or close the generator panel", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  const suppressedBranch = source.match(/if \(shouldSkipChangeEffects\) \{\n([\s\S]*?)\n      \}/);
  assert.ok(suppressedBranch, "missing suppressed change branch");
  assert.match(suppressedBranch[1], /scheduleOverlayRefresh\(scene\)/);
  assert.match(suppressedBranch[1], /scheduleSelectionSave\(scene\)/);
  assert.match(suppressedBranch[1], /scheduleCanvasSave\(scene\)/);
  assert.match(suppressedBranch[1], /return/);
  assert.doesNotMatch(suppressedBranch[1], /syncGeneratorUi/);
  assert.doesNotMatch(suppressedBranch[1], /setOpenMenu\(null\)/);
});

test("stale saves cannot mark newer canvas changes as synced", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  assert.match(source, /const localChangeVersionRef = useRef\(0\)/);
  assert.match(source, /const saveVersion = Number\.isFinite\(options\.changeVersion\)[\s\S]*?: localChangeVersionRef\.current/);
  assert.match(source, /if \(localChangeVersionRef\.current === saveVersion\) \{\s*hasLocalChangesRef\.current = false\s*\}/);
  assert.match(source, /const changeVersion = localChangeVersionRef\.current \+ 1/);
  assert.match(source, /localChangeVersionRef\.current = changeVersion/);
  assert.match(source, /saveCanvas\(latestSceneRef\.current \?\? scene, \{ changeVersion \}\)/);
});

test("deferred internal scene updates only suppress the updateScene echo", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /suppressNextChangeRef\.current = true\s*window\.setTimeout\(\(\) => \{\s*api\.updateScene/);
  assert.match(source, /window\.setTimeout\(\(\) => \{\s*suppressNextChangeRef\.current = true\s*api\.updateScene/);
});

test("remote scene application preserves current selection before syncing UI", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const applyRemote = source.match(/const applyRemoteScene = useCallback\(\n([\s\S]*?)\n  const openToolbarMediaPicker/);
  assert.ok(applyRemote, "missing applyRemoteScene block");

  assert.match(applyRemote[1], /const remoteApplyVersion = localChangeVersionRef\.current/);
  assert.match(applyRemote[1], /if \(localChangeVersionRef\.current !== remoteApplyVersion && !options\.force\) return/);
  assert.doesNotMatch(applyRemote[1], /syncGeneratorUi\(normalized\)/);
  assert.match(applyRemote[1], /selectedElementIds: options\.applySelection[\s\S]*?: currentAppState\.selectedElementIds \?\? \{\}/);
  assert.match(applyRemote[1], /const nextScene = \{ \.\.\.normalized, appState: nextAppState \}/);
  assert.match(applyRemote[1], /syncGeneratorUi\(nextScene\)/);
});
