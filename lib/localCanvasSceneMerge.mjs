import { reconcileElements } from "./remoteCanvasRelayClient.mjs";

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function isLiveGeneratedReplacement(element) {
  if (!element || element.isDeleted || !isObject(element.customData)) return false;
  const anchorElementId = element.customData.codexAnchorElementId;
  if (typeof anchorElementId !== "string" || !anchorElementId) return false;
  return Boolean(
    element.customData.codexGeneratedImage === true ||
      element.customData.codexGeneratedVideo === true ||
      element.customData.codexGeneratedSubtitle === true ||
      element.customData.codexInsertedImage === true ||
      element.customData.codexInsertedVideo === true ||
      element.customData.codexMediaKind,
  );
}

// Mirrors the generator-frame tags stamped by the app and canvasScene (not
// imported from canvasScene.mjs — that would be a circular dependency).
const GENERATOR_FRAME_TAGS = [
  "buzzassist.imageGenerator.frame",
  "buzzassist.videoGenerator.frame",
  "buzzassist.subtitleGenerator.frame",
  "buzzassist.silenceCutGenerator.frame",
  "buzzassist.lovartGenerator.frame",
];

// Anchor tombstoning may only ever hit disposable generator placeholder
// frames. A generated card also carries codexAnchorElementId when it was
// merely PLACED BESIDE an existing element (e.g. a subtitle card anchored to
// a silence-cut XML card). Deleting such an anchor destroys real content and,
// through the asset-deletion sync, moves its file to assets-trash.
function isGeneratorPlaceholderFrame(element) {
  if (!element || !isObject(element.customData)) return false;
  const customData = element.customData;
  if (customData.role === "frame") return true;
  if (customData.codexGenerating === true) return true;
  return GENERATOR_FRAME_TAGS.some((tag) => customData[tag] === true);
}

// Browser tabs can finish hydrating a generated asset at different times. An
// older tab may then save the still-live placeholder after the server already
// replaced it with the generated result. Excalidraw's element reconciliation
// keeps local-only result elements, while this final pass keeps their anchor
// placeholders deleted. A real Undo still works because it deletes the result
// element with a newer version, so no live replacement protects the anchor.
export function mergeLocalCanvasScenes(currentScene, incomingScene) {
  const current = isObject(currentScene) ? currentScene : {};
  const incoming = isObject(incomingScene) ? incomingScene : {};
  let elements = reconcileElements(current.elements, incoming.elements);

  const protectedAnchors = new Map();
  for (const element of elements) {
    if (!isLiveGeneratedReplacement(element)) continue;
    protectedAnchors.set(element.customData.codexAnchorElementId, element.id);
  }

  const now = Date.now();
  const tombstonedAnchorIds = new Set();
  elements = elements.map((element) => {
    if (!element || element.isDeleted || !protectedAnchors.has(element.id)) return element;
    if (!isGeneratorPlaceholderFrame(element)) return element;
    tombstonedAnchorIds.add(element.id);
    return {
      ...element,
      isDeleted: true,
      version: (Number(element.version) || 1) + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: now,
    };
  });

  const appState = isObject(incoming.appState) ? { ...incoming.appState } : {};
  if (isObject(appState.selectedElementIds)) {
    const selectedElementIds = { ...appState.selectedElementIds };
    let changed = false;
    for (const [anchorId, resultId] of protectedAnchors) {
      if (!tombstonedAnchorIds.has(anchorId)) continue;
      if (!selectedElementIds[anchorId]) continue;
      delete selectedElementIds[anchorId];
      selectedElementIds[resultId] = true;
      changed = true;
    }
    if (changed) appState.selectedElementIds = selectedElementIds;
  }

  return {
    ...current,
    ...incoming,
    elements,
    appState,
    files: {
      ...(isObject(current.files) ? current.files : {}),
      ...(isObject(incoming.files) ? incoming.files : {}),
    },
  };
}

