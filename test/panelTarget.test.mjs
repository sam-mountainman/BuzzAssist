import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Hermes route shows zero BuzzAssist credits and exposes setup prompt copy", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  // The route runs on the official Grok CLI now (hermes-grok-tools was
  // renamed to grok-cli-tools); internal ids keep the legacy hermes name.
  assert.match(source, /const HERMES_GROK_SETUP_PROMPT = 'https:\/\/github\.com\/sam-mountainman\/grok-cli-tools\\nセットアップして'/);
  assert.match(source, /function isLocalMediaRoute\(routeId\) \{\s*return routeId === 'codex' \|\| routeId === 'hermes'\s*\}/);
  assert.match(source, /if \(activeFrameKind === 'image'\) \{\s*const model = frameForm\.imageModel\s*if \(isLocalMediaRoute\(activeMediaRouteId\)\) return 0/);
  assert.match(source, /if \(activeFrameKind === 'video'\) \{\s*const model = frameForm\.videoModel\s*if \(isLocalMediaRoute\(activeMediaRouteId\)\) return 0/);
  assert.match(source, /writeTextToClipboard\(HERMES_GROK_SETUP_PROMPT\)/);
  assert.match(source, /canvasFetch\('\/api\/text\/clipboard'/);
  assert.match(source, /setChatSendStatus\('setup-copied'\)/);
  assert.match(source, /handleHermesSetupPromptPointerDown/);
  assert.match(source, /onPointerDown=\{handleHermesSetupPromptPointerDown\}/);
  assert.match(source, /showHermesSetupPromptInline/);
  assert.match(source, /className="lovart-error-actions"/);
  assert.match(source, />\s*セットアッププロンプトをコピー\s*<\/button>/);
  // The route menu no longer embeds its own Hermes setup block (copy prompt +
  // "Claude Code に依頼" / "Codex に依頼") — setup lives solely in the
  // dedicated dialog opened on route selection / generation.
  assert.doesNotMatch(source, /text: HERMES_GROK_SETUP_PROMPT/);
  assert.doesNotMatch(source, /Claude Code に依頼/);
  assert.doesNotMatch(source, /Hermes Grok Toolsのセットアップを依頼します/);
  assert.match(source, /aria-labelledby="hermes-setup-title"/);
  assert.match(source, /className="hermes-setup-prompt"/);
  assert.match(source, /className="hermes-setup-state"/);
  assert.match(source, /className=\{`hermes-setup-chip\$\{hermesSetupDialog\.installed \? ' is-ok' : ''\}`\}/);
  assert.match(source, /className="hermes-setup-steps"/);
  assert.match(source, /className=\{`hermes-setup-copy\$\{chatSendStatus === 'setup-copied' \? ' is-copied' : ''\}`\}/);
  assert.match(source, /'✓ コピーしました' : 'プロンプトをコピー'/);
  assert.match(source, /&& !\/was not found\/i\.test\(hermesSetupDialog\.error\)/);
  assert.match(source, /generationRouteId === 'hermes' && !\(await refreshHermesStatus\(\)\)/);
  assert.match(source, /if \(route\.id === 'hermes'\) await refreshHermesStatus\(\)/);
});

test("ChatGPT and local Grok counts use compact 1-10 range sliders", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  assert.match(source, /if \(resolveGatingImageModel\(model\) === 'gpt-image-2-codex'\) return MAX_CHATGPT_IMAGE_COUNT/);
  assert.match(source, /if \(resolveGatingImageModel\(model\) === 'grok-imagine-image-hermes'\) return MAX_GROK_GENERATION_COUNT/);
  assert.match(source, /usesIndependentImageCount\(imageModel\) \? \(/);
  assert.match(source, /min="1"\s*max=\{maxCount\}\s*step="1"\s*className="lovart-duration-slider"\s*value=\{activeCount\}\s*aria-label="生成枚数"/);
  assert.match(source, /onChange=\{\(event\) => updateFrameForm\('imageCount', Number\(event\.target\.value\)\)\}/);
  assert.match(source, /function getMaxVideoCount\(model\)/);
  assert.match(source, /aria-label="生成本数"/);
  assert.match(source, /onChange=\{\(event\) => updateFrameForm\('videoCount', Number\(event\.target\.value\)\)\}/);
  assert.match(source, /\) : \(\s*<>\s*<div className="lovart-menu-header">枚数<\/div>\s*<div className="lovart-menu-grid count">/);
});

test("Grok CLI video settings expose only 6s and 10s while Grok API keeps 1-15s", async () => {
  const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const mcpSource = await readFile(new URL("../mcp/server.mjs", import.meta.url), "utf8");
  const canvasSource = await readFile(new URL("../lib/canvasScene.mjs", import.meta.url), "utf8");
  const mediaSource = await readFile(new URL("../lib/mediaGeneration.mjs", import.meta.url), "utf8");

  assert.match(appSource, /videoModel: 'grok-imagine-video-hermes'/);
  assert.match(appSource, /duration: '6'/);
  assert.match(appSource, /'grok-imagine-video-hermes': \['6', '10'\]/);
  assert.match(appSource, /if \(model === 'grok-imagine-video-hermes'\) return \{ min: 6, max: 10, step: 4 \}/);
  assert.match(appSource, /if \(model === 'grok-imagine-video-api'\) return \{ min: 1, max: 15, step: 1 \}/);
  assert.match(mcpSource, /Grok CLI 6\/10s only, Grok API 1-15s/);
  assert.match(mcpSource, /Grok CLI accepts only 6 or 10; BuzzAssist\/xAI Grok API accepts 1-15/);
  assert.match(mcpSource, /duration: job\.duration \?\? "6"/);
  assert.match(canvasSource, /videoDuration: frame\.duration \?\? "6"/);
  assert.match(mediaSource, /prompt-only video path is image_gen -> image_to_video/);
  assert.match(mediaSource, /const startImage = await generateHermesGrokImage/);
  assert.doesNotMatch(mcpSource, /Grok Imagine clamps text-to-video to 1-15 seconds/);
});

test("agent setting questions and route menu prefer Lovart above BuzzAssist", async () => {
  const catalogSource = await readFile(new URL("../lib/modelCatalog.mjs", import.meta.url), "utf8");
  const mcpSource = await readFile(new URL("../mcp/server.mjs", import.meta.url), "utf8");

  assert.match(catalogSource, /MEDIA_ROUTES = \[\s*\{ id: "codex"[\s\S]*?\{ id: "hermes"[\s\S]*?\{ id: "lovart"[\s\S]*?\{ id: "buzzassist"/);
  assert.match(catalogSource, /ROUTE_PRIORITY = \["codex", "hermes", "lovart", "buzzassist"\]/);
  assert.match(mcpSource, /show Lovart above BuzzAssist and prefer Lovart when both are viable/);
  assert.match(mcpSource, /Codex\(local\) \/ Grok\(local\) \/ Lovart \/ BuzzAssist API/);
  assert.match(mcpSource, /Grok\(local\) \/ Lovart \/ BuzzAssist API/);
});

test("agent setting confirmation mirrors the BuzzAssist choice-question UX", async () => {
  const mcpSource = await readFile(new URL("../mcp/server.mjs", import.meta.url), "utf8");
  const imageSkill = await readFile(new URL("../skills/excalidraw-image-gen/SKILL.md", import.meta.url), "utf8");
  const videoSkill = await readFile(new URL("../skills/excalidraw-video-gen/SKILL.md", import.meta.url), "utf8");

  assert.match(mcpSource, /Use the host request_user_input \/ AskUserQuestion UI, not a plain-text question/);
  assert.match(mcpSource, /Each dialog may contain 1-3 short questions with 2-3 mutually exclusive options each/);
  assert.match(mcpSource, /Put the recommended option first and suffix its label with （推奨）/);
  assert.match(mcpSource, /Do not add an explicit その他 \/ Other option/);
  assert.match(mcpSource, /never ask a forced setting when only one valid value exists/);
  assert.match(mcpSource, /When an attachment's role is ambiguous, ask whether it is a start frame, style\/subject reference, or motion source/);
  assert.match(mcpSource, /Do not ask Midjourney version or detail rendering/);
  assert.match(mcpSource, /Never combine model and execution route into one option/);
  assert.match(mcpSource, /Stage 1: if model is missing, ask the model only, then wait/);
  assert.match(mcpSource, /Stage 2: after the model is known, ask execution route only when that exact model has multiple routes/);
  assert.match(mcpSource, /Stage 3: only after model and route are known, derive that exact combination's supported settings/);
  assert.match(imageSkill, /ユーザーがすでに指定した項目は再質問しない/);
  assert.match(imageSkill, /一気に全設定を質問してはいけません/);
  assert.match(imageSkill, /モデル名と実行先を1つの選択肢へまとめない/);
  assert.match(videoSkill, /Grok CLIの秒数は6秒・10秒だけ/);
  assert.match(videoSkill, /添付画像・動画の用途が曖昧なら/);
  assert.doesNotMatch(videoSkill, /16:9・5s・720p/);
});

test("agent batch generation defaults to 2 rows x 5 columns with 10 parallel jobs", async () => {
  const mediaSource = await readFile(new URL("../lib/mediaGeneration.mjs", import.meta.url), "utf8");
  const canvasSource = await readFile(new URL("../lib/canvasScene.mjs", import.meta.url), "utf8");
  const mcpSource = await readFile(new URL("../mcp/server.mjs", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const viteSource = await readFile(new URL("../vite.config.js", import.meta.url), "utf8");

  assert.match(mediaSource, /DEFAULT_MEDIA_BATCH_COLUMNS = 5/);
  assert.match(mediaSource, /DEFAULT_MEDIA_BATCH_CONCURRENCY = 10/);
  assert.match(mediaSource, /DEFAULT_MEDIA_BATCH_CHUNK_SIZE = 10/);
  assert.match(mediaSource, /MAX_CODEX_IMAGE_COUNT = DEFAULT_MEDIA_BATCH_CONCURRENCY/);
  assert.match(mediaSource, /Array\.from\(\{ length: count \}[\s\S]*generateImageWithCodexBridge/);
  assert.match(canvasSource, /function newGeneratorFrameRecord[\s\S]*codexGenerating: true/);
  assert.match(canvasSource, /export async function insertGeneratorFrameBatch[\s\S]*finiteNumber\(Number\(args\.columns\), 5\)/);
  assert.match(canvasSource, /const col = i % columns;\s*const row = Math\.floor\(i \/ columns\)/);
  assert.match(mcpSource, /Defaults to 5 \(10-job chunks render as 2 rows × 5 columns\)/);
  assert.match(mcpSource, /const generated = await runWithConcurrency\(chunkJobs, concurrency/);
  assert.match(mcpSource, /requestGeneratingFramesFocus\(args, frames\)/);
  assert.match(mcpSource, /if \(elementIds\.length <= 1\) return null/);
  assert.match(mcpSource, /applySelection: false,\s*applyViewport: true/);
  assert.match(mcpSource, /Single-item jobs never move the viewport/);
  assert.match(appSource, /const columnsPerRow = 5/);
  assert.match(appSource, /Math\.floor\(\(i \+ 1\) \/ columnsPerRow\)/);
  assert.match(appSource, /previousGeneratorFrameIdsRef\.current = new Set\(\s*elementsWithClones\.filter\(isGeneratorFrame\)/);
  assert.match(appSource, /codexGenerating: true/);
  assert.match(appSource, /const setGeneratorFramesRemoteGenerating = useCallback\(\(elementIds = \[\], isGenerating = true\) => \{/);
  assert.match(appSource, /setGeneratorFramesRemoteGenerating\(\[optimisticGenerationId\], true\)/);
  assert.match(appSource, /setGeneratorFramesRemoteGenerating\(\[retryFrameId\], true\)/);
  assert.match(appSource, /const focusGeneratingFrameGrid = useCallback\(\(elementIds = \[\]\) => \{/);
  assert.match(appSource, /function buzzAssistCanvasFocusOffsets\(\)/);
  assert.match(appSource, /buzzAssistRailRect\.right - rootRect\.left \+ GENERATOR_FOCUS_RAIL_GAP/);
  assert.match(appSource, /function focusCanvasElementsWithSafeArea\(api, elements = \[\]\)/);
  assert.match(appSource, /api\.scrollToContent\(elements, \{\s*fitToContent: true,\s*animate: true,\s*duration: GENERATOR_SCROLL_ANIMATION_MS,\s*viewportZoomFactor: GENERATOR_FOCUS_ZOOM_FACTOR,\s*canvasOffsets: buzzAssistCanvasFocusOffsets\(\)\s*\}\)/);
  assert.match(appSource, /focusCanvasElementsWithSafeArea\(api, frames\)/);
  assert.match(appSource, /if \(!isRegeneratingResult && requestedGenerationCount > 1\)[\s\S]*focusGeneratingFrameGrid\(\[anchorElementId, \.\.\.extraFrameIds\]\)/);
  assert.match(appSource, /if \(isRegeneratingResult && requestedGenerationCount > 1\)[\s\S]*focusGeneratingFrameGrid\(\[generationAnchorId, \.\.\.extraFrameIds\]\)/);
  assert.match(appSource, /lastCreatedGeo\?\.id && elements\.some/);
  assert.match(appSource, /element\.id === lastCreatedGeo\.id && !element\.isDeleted && isGeneratorFrame\(element\)/);
  assert.match(appSource, /MAX_CHATGPT_IMAGE_COUNT = 10/);
  assert.match(appSource, /MAX_GROK_GENERATION_COUNT = 10/);
  assert.match(appSource, /resolveGatingImageModel\(model\) === 'gpt-image-2-codex'/);
  assert.match(mcpSource, /GPT Image 2 on the ChatGPT\/Codex route and Grok Imagine on the local Grok route, image count is 1-10/);
  assert.match(mcpSource, /jobs: Array\.from\(\{ length: requestedCount \}/);
  assert.match(appSource, /const requestedGenerationCount = kind === 'image'/);
  assert.match(appSource, /videoCount: requestedGenerationCount/);
  assert.match(appSource, /extraAnchorElementIds: extraFrameIds/);
  assert.match(viteSource, /\[generate\/video\] extra video insert failed/);
});

test("file and canvas attachments pin the original panel without duplicate open notifications", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  assert.match(source, /const openNotifiedRef = useRef\(false\)/);
  assert.match(source, /if \(openNotifiedRef\.current\) return/);
  assert.match(source, /onCancel=\{finishPicker\}/);
  assert.match(source, /const attachmentPanelInteractionRef = useRef\(false\)/);
  assert.match(source, /\(attachmentPanelInteractionRef\.current \|\| canvasPickerRef\.current\) && restoreAttachmentLockedTarget\(\)/);
  assert.match(source, /window\.addEventListener\('focus', releaseAfterNativePicker\)/);
});

test("remote MCP focus events select and center only requested results", async () => {
  const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const viteSource = await readFile(new URL("../vite.config.js", import.meta.url), "utf8");
  const mcpSource = await readFile(new URL("../mcp/server.mjs", import.meta.url), "utf8");

  assert.match(appSource, /const focusElementIds = \[\.\.\.new Set/);
  assert.match(appSource, /Object\.fromEntries\(focusElementIds\.map\(\(id\) => \[id, true\]\)\)/);
  assert.match(appSource, /fingerprint === lastSyncedFingerprintRef\.current && !shouldApplyFocus/);
  assert.match(appSource, /focusElementIds\r?\n\s*\}\)/);
  assert.match(appSource, /focusCanvasElementsWithSafeArea\(api, focusedElements\)/);
  assert.match(viteSource, /FOCUS_REQUEST_FILE_NAME/);
  assert.match(viteSource, /async function consumeCanvasFocusRequest\(\)/);
  assert.match(viteSource, /server\.watcher\.on\('add', scheduleCanvasWatchBroadcast\)/);
  assert.match(viteSource, /broadcastCanvasChanged\(\[canvasFile\], \{ \.\.\.\(focusRequest \|\| \{\}\), fingerprint \}\)/);
  assert.match(mcpSource, /async function requestCanvasFocus\(args = \{\}, result\)/);
  assert.match(mcpSource, /await requestCanvasFocus\(args, result\)/);
});

test("all generation routes require BuzzAssist login through the shared dialog", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  assert.match(source, /const \[buzzAssistLoginDialog, setBuzzAssistLoginDialog\] = useState\(null\)/);
  assert.match(source, /const buzzAssistLoginRequestRef = useRef\(null\)/);
  assert.match(source, /const beginBuzzAssistLogin = useCallback\(async \(\) => \{/);
  assert.match(source, /canvasFetch\('\/api\/buzzassist\/auth-status'\)/);
  assert.match(source, /canvasFetch\('\/api\/buzzassist\/login', \{ method: 'POST' \}\)/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-labelledby="buzzassist-login-title"/);
  assert.doesNotMatch(source, /className="buzzassist-login-modal"[\s\S]{0,500}onClickCapture/);
  assert.doesNotMatch(source, /className="buzzassist-login-modal"[\s\S]{0,500}onPointerDownCapture/);
  assert.match(source, />\s*BuzzAssistにログイン\s*<\/h2>/);
  assert.match(source, /'ログインして続行'/);
  assert.match(source, /Every generation route still needs a BuzzAssist account gate/);
  assert.match(source, /message: `\$\{generationRouteLabel\}で\$\{generationKindLabel\}を続けるにはBuzzAssistへのログインが必要です。`/);
  assert.match(source, /const utilityLabel = kind === 'subtitle' \? 'SRT生成' : '無音カット'/);
  assert.match(source, /message: `\$\{utilityLabel\}を続けるにはBuzzAssistへのログインが必要です。`/);
  assert.doesNotMatch(source, /requiresBuzzAssist/);
  assert.doesNotMatch(source, /needsCloud/);
});

test("uploaded canvas media does not open the generator prompt panel", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const match = source.match(/function isPanelMediaTargetElement\(element\) \{\r?\n([\s\S]*?)\r?\n\}/);
  assert.ok(match, "Missing isPanelMediaTargetElement");
  assert.match(match[1], /isGeneratedResult\(element\)/);
  assert.doesNotMatch(match[1], /isCanvasImageElement\(element\)/);
  assert.doesNotMatch(match[1], /isCanvasVideoElement\(element\)/);
});

test("generated media labels resolve to their backing result for panel selection only", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const helper = source.match(/function panelMediaTargetIdFromSelection\(selectedIds, elementsById\) \{\r?\n([\s\S]*?)\r?\n\}/);
  assert.ok(helper, "Missing panelMediaTargetIdFromSelection");

  assert.match(helper[1], /if \(selectedIds\.length !== 1\) return ''/);
  assert.match(helper[1], /if \(isPanelMediaTargetElement\(direct\)\) return id/);
  assert.match(helper[1], /const labelFor = direct\?\.customData\?\.codexVideoLabelFor/);
  assert.match(helper[1], /if \(isPanelMediaTargetElement\(elementsById\.get\(labelFor\)\)\) return labelFor/);
  assert.match(source, /const selectedResultId = selectedSingleId \? panelMediaTargetIdFromSelection\(selectedIds, elementsById\) : ''/);
  assert.match(source, /const selectedSingleId = selectedIds\.length === 1 \? selectedIds\[0\] : ''/);
  assert.match(source, /selectedSingleId && isGeneratorFrame\(elementsById\.get\(selectedSingleId\)\) \? selectedSingleId : ''/);
  assert.match(source, /if \(selectedIds\.length <= 1 && pending && isGeneratorFrame\(elementsById\.get\(pending\.id\)\)\) \{/);
});

test("canvas picker resolves media labels and keeps picking on invalid asset types", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const helper = source.match(/function selectedCanvasAttachableElementFromScene\(scene\) \{\r?\n([\s\S]*?)\r?\n\}/);
  assert.ok(helper, "Missing selectedCanvasAttachableElementFromScene");

  assert.match(helper[1], /if \(direct && !isGeneratorFrame\(direct\) && isCanvasAttachableElement\(direct\)\) return direct/);
  assert.match(helper[1], /const labelFor = direct\?\.customData\?\.codexVideoLabelFor/);
  assert.match(helper[1], /if \(labeledElement && !isGeneratorFrame\(labeledElement\) && isCanvasAttachableElement\(labeledElement\)\) \{/);
  assert.match(source, /const selected = selectedCanvasAttachableElementFromScene\(scene\)/);
  assert.match(source, /if \(!selected\) return keepPickingWithError\('キャンバス上の画像・動画・ファイルを選択してください。'\)/);
  assert.match(source, /const restorePickerTargetSelection = \(\) => \{/);
  assert.match(source, /const restoreElementId = restoreFrameId \|\| restoreResult\?\.elementId \|\| ''/);
  assert.match(source, /appState: \{ selectedElementIds: \{ \[restoreElementId\]: true \} \}/);
  assert.match(source, /const keepPickingWithError = \(message\) => \{/);
  assert.match(source, /restorePickerTargetSelection\(\)/);
  assert.match(source, /picker\.selectedGeneratedResult\?\.elementId && selected\.id === picker\.selectedGeneratedResult\.elementId/);
  assert.match(source, /return keepPickingWithError\('この生成結果自身は参照に追加できません。'\)/);
  assert.match(source, /return keepPickingWithError\('この欄には画像を選択してください。'\)/);
  assert.match(source, /return keepPickingWithError\('この欄には動画を選択してください。'\)/);
  assert.match(source, /return keepPickingWithError\('この欄には音声を選択してください。'\)/);
  assert.match(source, /return keepPickingWithError\('この欄には台本ファイルを選択してください。'\)/);
  assert.match(source, /return keepPickingWithError\('この欄には音声または動画を選択してください。'\)/);
  assert.match(source, /return keepPickingWithError\('この欄には動画またはPremiere XMLを選択してください。'\)/);
  assert.doesNotMatch(source, /if \(picker\.target === 'imageReferences' && asset\.kind !== 'image'\) return false/);
});

test("selected canvas media exposes clipboard and download controls without the legacy chat popover", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const viteSource = await readFile(new URL("../vite.config.js", import.meta.url), "utf8");

  assert.match(source, /function saveDownloadAssetsWithPicker\(assets = \[\]\) \{/);
  assert.match(source, /async function createAgentAttachmentBundle\(assets = \[\]\) \{/);
  assert.match(source, /async function copyAssetFilesToSystemClipboard\(assets = \[\]\) \{/);
  assert.match(source, /async function writeImageAssetToClipboard\(asset\) \{/);
  assert.match(source, /function isNativeChatFileAsset\(asset\) \{/);
  assert.match(source, /const copySelectedCanvasAssets = useCallback\(async \(assets = \[\]\) => \{/);
  assert.match(source, /copyAssetFilesToSystemClipboard\(items\)/);
  assert.match(source, /function archiveUrlForDownloadAssets\(assets = \[\]\) \{/);
  assert.match(source, /`\/api\/assets\/archive\?\$\{query\}`/);
  assert.match(source, /const selectedCanvasDownloadOverlays = \(\(\) => \{/);
  assert.match(source, /selectedImageOverlays\.filter\(\(item\) => item\.isSelected && item\.assetUrl\)/);
  assert.match(source, /overlay\.kind === 'silenceCut' && overlay\.outputAsset\?\.url/);
  assert.match(source, /className="lovart-selection-toolbar"/);
  assert.match(source, /className="lovart-selection-toolbar-btn"/);
  assert.doesNotMatch(source, /className="lovart-agent-chat-popover"/);
  assert.match(source, /copySelectedCanvasAssets\(selectedCanvasDownloadAssets\)/);
  assert.match(source, /function canvasAssetSelectionKey\(assets = \[\]\)/);
  assert.match(source, /const agentAttachTargetKeyRef = useRef\(''\)/);
  assert.match(source, /const agentAttachCopyTokenRef = useRef\(0\)/);
  assert.match(source, /copiedTargetKey === selectedCanvasCopyTargetKey\) return/);
  assert.match(source, /if \(!isCurrentCopyTarget\(\)\) return/);
  // The toolbar buttons keep their icons after a click — no "copied/started"
  // labels or check marks may replace them. Copy feedback renders as a
  // transient toast under the toolbar instead.
  assert.doesNotMatch(source, /lovart-selection-toolbar-label/);
  assert.doesNotMatch(source, /lovart-selection-toolbar-check/);
  assert.doesNotMatch(source, /コピー済</);
  assert.doesNotMatch(source, /開始済</);
  assert.doesNotMatch(source, /className=\{`lovart-selection-toolbar-btn[^`]*is-success/);
  assert.match(source, /className=\{`lovart-selection-toolbar-status/);
  assert.match(source, /'コピーしました'/);
  assert.match(source, /'コピーに失敗しました'/);
  // Downloads open the browser's native save dialog immediately (filename
  // pre-filled) — no server-side folder dialog and no extra round-trip.
  assert.match(source, /async function saveDownloadAssetsWithPicker\(assets = \[\]\) \{/);
  assert.match(source, /return saveAssetWithPicker\(items\[0\]\.assetUrl, items\[0\]\.fileName\)/);
  assert.match(source, /return saveUrlWithPicker\(archiveUrl, 'excalidraw-assets\.zip', downloadUrlWithAttachment\(archiveUrl\)\)/);
  assert.match(source, /const bulkDownloadInFlightRef = useRef\(false\)/);
  assert.match(source, /if \(bulkDownloadInFlightRef\.current\) return/);
  assert.match(source, /await downloadAssetsViaServerDialog\(selectedCanvasDownloadAssets\)/);
  assert.doesNotMatch(source, /downloadAssetsToLocalFolder/);
  assert.doesNotMatch(viteSource, /api\/assets\/download-local/);
  assert.match(viteSource, /server\.middlewares\.use\('\/api\/assets\/clipboard'/);
  assert.match(viteSource, /server\.middlewares\.use\('\/api\/text\/clipboard'/);
  assert.match(viteSource, /copyTextToSystemClipboard\(text\)/);
  assert.match(viteSource, /BUZZASSIST_CLIPBOARD_TEXT_B64/);
  assert.match(viteSource, /copyFilesToSystemClipboard\(assetPaths\)/);
  assert.match(viteSource, /NSPasteboard\.generalPasteboard/);
  assert.match(viteSource, /mode: 'nspasteboard'/);
  assert.match(viteSource, /SetFileDropList/);
  assert.match(styles, /\.lovart-selection-toolbar/);
  assert.match(styles, /\.lovart-selection-toolbar-btn/);
  assert.doesNotMatch(styles, /\.lovart-selection-toolbar-btn\.is-success/);
  assert.match(styles, /\.lovart-selection-toolbar-status/);
  assert.match(styles, /\.lovart-selection-toolbar-status\.is-success/);
  assert.match(styles, /background: #7c3aed/);
});

test("pure viewport pans translate the overlay layer and own-save echoes skip the scene refetch", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const viteSource = await readFile(new URL("../vite.config.js", import.meta.url), "utf8");

  // Pan fast path: one CSS transform on the shared overlay layer per frame
  // instead of rebuilding every overlay and re-rendering React.
  assert.match(source, /function viewportPanSignature\(elements, appState, zoomValue\) \{/);
  assert.match(source, /const overlayLayerRef = useRef\(null\)/);
  assert.match(source, /const overlayUnderLayerRef = useRef\(null\)/);
  // Two layers: media previews stay under Excalidraw's interactive canvas
  // (z-2) so selection borders paint above them; frame chrome and the
  // selection toolbar stay above it. One flattened layer would hide the
  // attach/download toolbar behind the canvas.
  assert.match(source, /<div ref=\{overlayUnderLayerRef\} className="lovart-canvas-overlay-layer is-under-canvas">/);
  assert.match(source, /<div ref=\{overlayLayerRef\} className="lovart-canvas-overlay-layer is-above-canvas">/);
  assert.match(source, /const panTransform = dx \|\| dy \? `translate\(\$\{dx\}px, \$\{dy\}px\)` : ''/);
  assert.match(source, /for \(const layer of \[overlayLayerRef\.current, overlayUnderLayerRef\.current\]\) \{/);
  assert.match(source, /signature === lastPanSignatureRef\.current/);
  assert.match(styles, /\.lovart-canvas-overlay-layer\.is-under-canvas \{\s*z-index: 1;/);
  assert.match(styles, /\.lovart-canvas-overlay-layer\.is-above-canvas \{\s*z-index: 3;/);
  // The fast path never runs while the generator panel, canvas picker, or a
  // remote scene apply is active, or on the tunnel (clamped panel) runtime.
  assert.match(source, /!activeFrameIdRef\.current &&/);
  assert.match(source, /!selectedGeneratedResultRef\.current &&/);
  assert.match(source, /!pendingPanelFrameRef\.current &&/);
  assert.match(source, /!isTunnelCanvasRuntime\(\)\s*\n\s*if \(panEligible\)/);
  // Baseline adoption + transform reset happen in the same paint as the
  // overlay React commit so overlays never visibly jump.
  assert.match(source, /useLayoutEffect\(\(\) => \{\s*const pending = pendingOverlayViewportRef\.current/);
  assert.match(styles, /\.lovart-canvas-overlay-layer/);
  // Stale-overlay healing: the SRT wheel hit test compensates for the live
  // layer translation, and a settled pan rebuilds overlays to true positions.
  assert.match(source, /const layerDx = translateMatch \? Number\(translateMatch\[1\]\) : 0/);
  assert.match(source, /event\.clientX - rootRect\.left - layerDx/);
  assert.match(source, /panSettleRebuildTimerRef\.current = window\.setTimeout\(/);
  assert.match(source, /if \(settledScene\) scheduleOverlayRefresh\(settledScene\)/);

  // Own-save SSE echoes are recognized from the broadcast fingerprint and
  // skipped BEFORE downloading + parsing the whole scene JSON.
  assert.match(source, /eventPayload\.fingerprint === lastSyncedFingerprintRef\.current/);
  assert.match(viteSource, /function sceneContentFingerprint\(scene\) \{/);
  assert.match(viteSource, /broadcastCanvasChanged\(\[canvasFile\], \{ fingerprint: sceneContentFingerprint\(scene\) \}\)/);
  assert.match(viteSource, /\.then\(\(scene\) => sceneContentFingerprint\(scene\)\)/);

  // Asset etags stay header-safe for Japanese filenames.
  assert.match(viteSource, /createHash\('sha1'\)\.update\(basename\(servePath\)\)/);
});

test("dragging selected media translates overlay nodes instead of rebuilding per frame", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  assert.match(source, /function detectUniformSelectionDrag\(elements, appState, baseline\) \{/);
  // Resize/rotate, extra edits, or a plain click all fall back to the slow path.
  assert.match(source, /if \(element\.width !== base\.width \|\| element\.height !== base\.height \|\| \(element\.angle \|\| 0\) !== base\.angle\) return null/);
  assert.match(source, /if \(dx === null\) return null/);
  // Stationary elements must be byte-stable; grouped companions (video
  // labels, frame members) may move with the same delta and stay fast.
  assert.match(source, /if \(\(element\.version \|\| 0\) !== base\.version\) return null/);
  assert.match(source, /return \{ dx, dy, movedIds \}/);
  // Pointer state flips in capture phase before Excalidraw's pointerup commit.
  assert.match(source, /window\.addEventListener\('pointerdown', handleDown, true\)/);
  assert.match(source, /window\.addEventListener\('pointerup', handleUp, true\)/);
  assert.match(source, /canvasPointerDownRef\.current &&/);
  // Dragged overlays move via CSS `translate` (composes with rotate transforms)
  // and the registry resets whenever overlays rebuild.
  assert.match(source, /const applySelectionDragTranslation = useCallback\(\(dxPx, dyPx, movedIds\) => \{/);
  assert.match(source, /document\.querySelectorAll\('\[data-overlay-anchor\]'\)/);
  assert.match(source, /node\.style\.translate = translate/);
  assert.match(source, /applySelectionDragTranslation\(drag\.dx \* zoomValue, drag\.dy \* zoomValue, drag\.movedIds\)/);
  const anchorCount = (source.match(/data-overlay-anchor=\{/g) || []).length;
  assert.equal(anchorCount, 5, "frame, image preview, video, subtitle, and selected-image overlays each carry an anchor id");
  // The rebuild baseline captures every element's geometry for drag detection.
  assert.match(source, /geometry\.set\(element\.id, \{/);
  assert.match(source, /selectionKey: \[\.\.\.selectedBaselineIds\]\.sort\(\)\.join\(','\)/);
  // Drag-end rebuilds run synchronously (not rAF-deferred) while a drag
  // translate is applied, so the fresh prompt-panel position and the
  // translate reset land in the same paint — no one-frame double offset.
  const overlayScheduler = source.match(/const scheduleOverlayRefresh = useCallback\(\(scene\) => \{([\s\S]*?)\r?\n  \}, \[refreshOverlayStates\]\)/);
  assert.ok(overlayScheduler, "missing scheduleOverlayRefresh");
  assert.match(overlayScheduler[1], /if \(dragOverlayNodesRef\.current\) \{/);
  assert.match(overlayScheduler[1], /refreshOverlayStates\(scene\)\s*\n\s*return/);
});

test("the generation gate answers from a cached server-verified auth status", async () => {
  const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const viteSource = await readFile(new URL("../vite.config.js", import.meta.url), "utf8");

  // Server verification costs a buzzassist.ai round trip on every generate
  // click; the status is cached keyed by the auth file mtime so local
  // login/logout (from any process) invalidates instantly.
  assert.match(viteSource, /let buzzAssistStatusCacheRef = \{ key: '', at: 0, status: null \}/);
  assert.match(viteSource, /stat\(resolveAuthFilePath\(\)\)/);
  assert.match(viteSource, /cached\.key === cacheKey && Date\.now\(\) - cached\.at < 5 \* 60_000/);
  assert.match(viteSource, /buzzAssistStatusCacheRef = \{ key: cacheKey, at: Date\.now\(\), status \}/);

  // Generating must paint before any async preflight (auth / Grok status).
  const optimisticStart = appSource.indexOf("setGeneratingFrameIds((current) => new Set(current).add(optimisticGenerationId))");
  const authAwait = appSource.indexOf("await ensureBuzzAssistLoggedIn", optimisticStart);
  assert.ok(optimisticStart >= 0 && authAwait > optimisticStart);
  assert.match(appSource, /setGeneratingFrameIds\(\(current\) => new Set\(current\)\.add\(optimisticGenerationId\)\)\s*\n\s*lastPointerDownCanvasRef\.current = null\s*\n\s*\/\/ Remove both Excalidraw's native selection border[\s\S]*?applyTransientSelection\(\{\}\)/);
  assert.match(appSource, /const transientScene = createScene\(elements, appState, api\.getFiles\(\)\)\s*\n\s*latestSceneRef\.current = transientScene\s*\n\s*refreshOverlayStates\(transientScene\)/);
  assert.match(appSource, /clearOptimisticGeneration[\s\S]*?applyTransientSelection\(originalSelectedElementIds\)/);
  assert.match(appSource, /clearOptimisticGeneration\(\)\s*\n\s*return/);
});

test("download save dialog opens in the OS Downloads folder", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const viteSource = await readFile(new URL("../vite.config.js", import.meta.url), "utf8");

  // The in-app browser ignores showSaveFilePicker's startIn hint (verified:
  // options reach the API but the panel opens elsewhere), so local operators
  // get a server-driven native save panel defaulting to Downloads instead.
  assert.match(source, /async function downloadAssetsViaServerDialog\(assets = \[\]\) \{/);
  assert.match(source, /canvasFetch\('\/api\/assets\/save-dialog'/);
  assert.match(source, /payload\.ok \|\| payload\.cancelled/);
  assert.match(source, /await downloadAssetsViaServerDialog\(selectedCanvasDownloadAssets\)/);
  assert.match(viteSource, /server\.middlewares\.use\('\/api\/assets\/save-dialog'/);
  assert.match(viteSource, /async function chooseSaveDestination\(fileName\) \{/);
  // NSSavePanel with extensionHidden=false keeps "name.png" fully visible in
  // the Save As field regardless of the Finder hide-extensions preference.
  assert.match(viteSource, /\$\.NSSavePanel\.savePanel/);
  assert.match(viteSource, /panel\.extensionHidden = false/);
  assert.match(viteSource, /panel\.directoryURL = \$\.NSURL\.fileURLWithPath\(\$\(defaultDir\)\)/);
  assert.match(viteSource, /if \(suggestedExt && !extname\(basename\(destination\)\)\) \{/);
  assert.match(viteSource, /New-Object System\.Windows\.Forms\.SaveFileDialog/);
  assert.match(viteSource, /join\(homedir\(\), 'Downloads'\)/);
  assert.match(viteSource, /sendJson\(res, 200, \{ ok: false, cancelled: true \}\)/);
  assert.match(viteSource, /streamZipStore\(entries, out\)\.catch\(rejectZip\)/);

  // Browser-picker fallback still hints at Downloads for real Chrome.
  assert.match(source, /startIn: 'downloads',/);
  assert.match(source, /id: `dl-\$\{Date\.now\(\)\.toString\(36\)\}/);
  assert.match(source, /return saveDownloadAssetsWithPicker\(assets\)/);
});

test("selected SRT cards expose the toolbar plus a host-agent refine action", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  // SRT cards join the attach/download toolbar sources…
  assert.match(source, /const selectedSrtCards = subtitlePreviewOverlays/);
  assert.match(source, /assetType: 'srt'/);
  // …and a single selected .srt gets the AI-refine button, which copies a
  // self-contained request for the host agent (refine_excalidraw_subtitles).
  assert.match(source, /const selectedRefinableSrtAsset = selectedCanvasDownloadAssets\.length === 1 && \/\\\.srt\$\/i\.test/);
  assert.match(source, /function RefineSparkleIcon\(\{ size = 15 \}\)/);
  assert.match(source, /refine_excalidraw_subtitles ツールを呼ぶこと/);
  assert.match(source, /検収依頼をコピーしました — エージェントに貼り付けてください/);
  // One paste hands the agent the request AND the SRT: the file rides along
  // as an agent-attachment bundle (the clipboard cannot carry text + a file).
  assert.match(source, /createAgentAttachmentBundle\(\[selectedRefinableSrtAsset\]\)/);
  assert.match(source, /検収依頼をコピーしました（SRT添付付き） — エージェントに貼り付けてください/);
  assert.match(source, /read_canvas_attachment_bundle で読める/);
  // Silence-cut XML cards get the same agent-review ✨ affordance, backed by
  // the plan sidecar + refine_excalidraw_silence_cut MCP tool.
  assert.match(source, /const selectedRefinableSilenceCutAsset = /);
  assert.match(source, /AIでカット候補を検収（依頼文をコピー）/);
  assert.match(source, /refine_excalidraw_silence_cut/);
});

test("canvas shortcuts clone frames and media, including multi-selection", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  assert.match(source, /function isCanvasShortcutCloneableElement\(element\) \{/);
  assert.match(source, /isGeneratorFrame\(element\) \|\| isCanvasAttachableElement\(element\)/);
  assert.match(source, /const storeCanvasShortcutClipboard = \(\) => \{/);
  assert.match(source, /const pasteCanvasShortcutClipboard = \(\) => \{/);
  assert.match(source, /const selectedElementIds = Object\.fromEntries\(newElements\.map\(\(element\) => \[element\.id, true\]\)\)/);
  assert.match(source, /delete pastedCustomData\.codexGenerating/);
  assert.match(source, /groupIds: Array\.isArray\(copiedElement\.groupIds\) \? copiedElement\.groupIds\.map\(remapGroupId\) : \[\]/);
  assert.match(source, /if \(newElements\.some\(isGeneratorFrame\)\) justCreatedFrameIdRef\.current/);
  assert.match(source, /if \(singleElement && isGeneratorFrame\(singleElement\)\) \{/);
  assert.match(source, /else if \(singleElement && isPanelMediaTargetElement\(singleElement\)\) \{/);
});

test("prompt panel keeps the desktop layout, scaled and kept reachable on phones", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

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
  assert.match(source, /const isCompactViewport = isTunnelCanvasRuntime\(\) && viewportWidth > 0 && viewportWidth <= 900/);
  assert.match(source, /const panelScale = isCompactViewport\s*\?\s*Math\.min\(1, \(viewportWidth - 16\) \/ desiredWidth\)/);
  assert.match(source, /const transformInsetX = \(panelWidth - panelVisualWidth\) \/ 2/);
  assert.match(source, /transform: panelPlacement\.scale && panelPlacement\.scale < 1 \? `scale\(\$\{panelPlacement\.scale\}\)` : 'none'/);
  assert.match(source, /transformOrigin: 'top center'/);
  assert.match(source, /if \(kind === 'subtitle'\) return 300/);
  assert.match(styles, /\.is-memory-constrained-canvas \.lovart-ai-panel/);
  assert.match(styles, /\.is-memory-constrained-canvas \.lovart-ai-prompt/);
  assert.doesNotMatch(styles, /@media \(max-width: 900px\) \{\s*\.lovart-ai-panel/);
});

test("phone tunnel renders images via capped overlays instead of hydrating Excalidraw files", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  assert.match(source, /const CANVAS_ASSET_PLACEHOLDER_DATA_URL = 'data:image\/gif;base64,/);
  assert.match(source, /const MOBILE_IMAGE_PREVIEW_OVERLAY_MAX_ITEMS = 8/);
  assert.match(source, /import \{[^}]*useMemo[^}]*\} from 'react'/s);
  assert.match(source, /function isNarrowCanvasViewport\(\)/);
  assert.match(source, /function isMemoryConstrainedCanvasRuntime\(\) \{\s*return isTunnelCanvasRuntime\(\) && \(isTouchLikeDevice\(\) \|\| isNarrowCanvasViewport\(\)\)\s*\}/);
  assert.match(source, /placeholderAssetBackedFilesByIds\(runtimeScene, assetBackedCanvasImageFileIds\(runtimeScene\)\)/);
  assert.match(source, /function hydrateSceneAssetBackedFilesWithTimeout\(scene, options = \{\}, timeoutMs = 1200\)/);
  assert.match(source, /await hydrateSceneAssetBackedFilesWithTimeout\(runtimeScene, \{ onlyVisible: true \}\)/);
  assert.match(source, /function CanvasImagePreviewOverlay\(\{ image \}\)/);
  assert.match(source, /selectedImageOverlays\.filter\(\(img\) => img\.assetType === 'image' && img\.assetUrl\)/);
  assert.match(source, /MOBILE_IMAGE_PREVIEW_OVERLAY_MAX_ITEMS/);
  assert.match(source, /is-memory-constrained-canvas/);
  assert.match(source, /if \(memoryConstrained\) return/);
  assert.match(source, /if \(isHydratedAssetBackedFile\(file\)\) return false/);
  assert.match(source, /if \(!api \|\| !scene\) return/);
  assert.doesNotMatch(source, /if \(!api \|\| !scene \|\| !isTunnelCanvasRuntime\(\)\) return/);
  assert.match(source, /isTunnelCanvasRuntime\(\) \? 250 : 50/);
  assert.match(source, /concurrency: isTunnelCanvasRuntime\(\) \? 2 : ASSET_HYDRATION_CONCURRENCY/);
  assert.match(source, /isTouchLikeDevice\(\)\s*\|\|\s*!initialScene/);
  assert.match(source, /preload="metadata"/);
  assert.doesNotMatch(source, /preload="auto"/);
});

test("left generator rail keeps requested utility tool order", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const viteSource = await readFile(new URL("../vite.config.js", import.meta.url), "utf8");
  const image = source.indexOf('data-lovart-generator-kind="image"');
  const video = source.indexOf('data-lovart-generator-kind="video"');
  const subtitle = source.indexOf('data-lovart-generator-kind="subtitle"');
  const silenceCut = source.indexOf('data-lovart-generator-kind="silenceCut"');
  const assetsFolder = source.indexOf('data-lovart-action="open-assets-folder"');

  assert.ok(image > 0, "missing image generator button");
  assert.ok(video > image, "video should follow image");
  assert.ok(silenceCut > video, "silence cut should follow video");
  assert.ok(subtitle > silenceCut, "SRT should follow silence cut");
  assert.ok(assetsFolder > subtitle, "assets folder should follow the generator tools");
  assert.match(source, /async function openCanvasAssetsFolder\(\) \{/);
  assert.match(source, /canvasFetch\(ASSET_FOLDER_OPEN_ENDPOINT, \{ method: 'POST' \}\)/);
  assert.match(source, /onPointerDown=\{\(event\) => \{[\s\S]*?openCanvasAssetsFolder\(\)\.catch/);
  assert.match(source, /if \(event\.detail === 0\) \{\s*openCanvasAssetsFolder\(\)\.catch/);
  assert.match(source, /!isTunnelCanvasRuntime\(\) \? \(/);
  assert.match(viteSource, /server\.middlewares\.use\('\/api\/assets\/open-folder'/);
  assert.match(viteSource, /if \(rejectRemoteOperator\(req, res\)\) return/);
  assert.match(viteSource, /await openLocalFolder\(canvasAssetsDir\)/);
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
  assert.match(source, /selectedGeneratedResult: restoreResult/);
  assert.match(source, /const selectedResult = !frameId[\s\S]*?options\.selectedGeneratedResult \|\| selectedGeneratedResultRef\.current/);
  assert.match(source, /const restoreResult = picker\.selectedGeneratedResult \|\| null/);
  assert.match(source, /selectedGeneratedResultRef\.current = restoreResult/);
  assert.match(source, /const restoreElementId = restoreFrameId \|\| restoreResult\?\.elementId \|\| ''/);
  assert.match(source, /appState: \{ selectedElementIds: \{ \[restoreElementId\]: true \} \}/);
  assert.match(source, /const attachmentPanelLockRef = useRef\(null\)/);
  assert.match(source, /const pinAttachmentPanelTarget = useCallback/);
  assert.match(source, /const beginAttachmentPanelLock = useCallback/);
  assert.match(source, /const releaseAttachmentPanelLockSoon = useCallback/);
  assert.match(source, /const attachmentLock = attachmentPanelLockRef\.current/);
  assert.match(source, /if \(attachmentLock\.frameId && isGeneratorFrame\(elementsById\.get\(attachmentLock\.frameId\)\)\)/);
  assert.match(source, /attachmentLock\.selectedGeneratedResult\?\.elementId && isPanelMediaTargetElement/);
  assert.match(source, /const \{ frameId, selectedGeneratedResult \} = beginAttachmentPanelLock\(\)/);
  assert.match(source, /pendingGeneratorUploadResultRef\.current = selectedGeneratedResult/);
  assert.match(source, /releaseAttachmentPanelLockSoon\(\)/);
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

test("aspect ratio changes resize the selected generator frame immediately", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  assert.match(source, /const FRAME_GEOMETRY_FORM_KEYS = new Set\(\[/);
  assert.match(source, /'aspectRatio'/);
  assert.match(source, /'videoAspectRatio'/);
  assert.match(source, /function formPatchAffectsFrameGeometry\(patch = \{\}\) \{/);
  assert.match(source, /const immediateFrameId = FRAME_GEOMETRY_FORM_KEYS\.has\(key\) \? activeFrameIdRef\.current : ''/);
  assert.match(source, /const immediateFrameId = formPatchAffectsFrameGeometry\(patch\) \? activeFrameIdRef\.current : ''/);
  assert.match(source, /updateActiveFrameElementRef\.current\?\.\(nextForm, immediateFrameId\)/);
  assert.match(source, /window\.clearTimeout\(pending\.timer\)/);
  assert.match(source, /updateFrameForm\('aspectRatio', ratio\)/);
  assert.match(source, /updateFrameForm\('videoAspectRatio', ratio\)/);
  assert.match(source, /function centeredGeneratorResize\(frame, size, appState, kind\) \{/);
  assert.match(source, /const x = centerX - size\.width \/ 2/);
  assert.match(source, /const y = centerY - size\.height \/ 2/);
  assert.match(source, /fittedGeneratorZoom\(kind, size, viewportWidth, viewportHeight, currentZoom\)/);
  assert.match(source, /viewportHeight - generatorPanelReserveFor\(kind\) - halfHeight - 8/);
  assert.match(source, /api\.updateScene\(\{\s*elements: nextElements,/);
});

test("programmatic scene echoes do not resync or close the generator panel", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  const suppressedBranch = source.match(/if \(shouldSkipChangeEffects\) \{\r?\n([\s\S]*?)\r?\n      \}/);
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
  const applyRemote = source.match(/const applyRemoteScene = useCallback\(\r?\n([\s\S]*?)\r?\n  const openToolbarMediaPicker/);
  assert.ok(applyRemote, "missing applyRemoteScene block");

  assert.match(applyRemote[1], /const remoteApplyVersion = localChangeVersionRef\.current/);
  assert.match(applyRemote[1], /if \(localChangeVersionRef\.current !== remoteApplyVersion && !options\.force\) return/);
  assert.doesNotMatch(applyRemote[1], /syncGeneratorUi\(normalized\)/);
  assert.match(applyRemote[1], /const requestedSelectedElementIds = options\.applySelection[\s\S]*?: currentAppState\.selectedElementIds \?\? \{\}/);
  assert.match(applyRemote[1], /Object\.entries\(requestedSelectedElementIds\)\.filter\([\s\S]*?!generatingFrameIdsRef\.current\.has\(id\)/);
  assert.match(applyRemote[1], /selectedElementIds: nextSelectedElementIds/);
  assert.match(applyRemote[1], /const nextScene = \{ \.\.\.normalized, appState: nextAppState \}/);
  assert.match(applyRemote[1], /syncGeneratorUi\(nextScene\)/);
});
