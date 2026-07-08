import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { requireBuzzAssistToken, resolveBuzzAssistApiBase } from "./buzzassistApi.mjs";

const DEFAULT_POLL_MS = 2500;
const DEFAULT_EDITOR_PAYLOAD_MAX_BYTES = 750_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(value) {
  const raw = String(value || resolveBuzzAssistApiBase()).trim();
  if (!raw) return resolveBuzzAssistApiBase();
  try {
    const parsed = new URL(raw);
    return parsed.origin.replace(/\/+$/, "");
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

function compactError(error) {
  return error instanceof Error ? error.message : String(error);
}

function jsonHash(value) {
  return createHash("sha1").update(JSON.stringify(value ?? null)).digest("hex");
}

function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

function withTimeout(promise, ms, label) {
  let timeout;
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(timeout));
}

async function readJsonIfExists(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function readAssetManifest(canvasDir) {
  const assetsDir = join(canvasDir, "assets");
  let entries = [];
  try {
    entries = await readdir(assetsDir);
  } catch (error) {
    if (error?.code === "ENOENT") return { assets: [] };
    throw error;
  }

  const assets = [];
  for (const name of entries) {
    const filePath = join(assetsDir, name);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat?.isFile()) continue;
    assets.push({
      name,
      size: fileStat.size,
      ext: extname(name).slice(1).toLowerCase(),
      updatedAt: fileStat.mtime.toISOString(),
    });
  }
  assets.sort((a, b) => a.name.localeCompare(b.name));
  return { assets };
}

function toPublicScene(scene) {
  const elements = Array.isArray(scene?.elements) ? scene.elements : [];
  return {
    elements: elements.map((element) => ({
      id: typeof element?.id === "string" ? element.id : undefined,
      type: typeof element?.type === "string" ? element.type : undefined,
      x: Number.isFinite(Number(element?.x)) ? Number(element.x) : 0,
      y: Number.isFinite(Number(element?.y)) ? Number(element.y) : 0,
      width: Number.isFinite(Number(element?.width)) ? Number(element.width) : 1,
      height: Number.isFinite(Number(element?.height)) ? Number(element.height) : 1,
      angle: Number.isFinite(Number(element?.angle)) ? Number(element.angle) : 0,
      text: typeof element?.text === "string" ? element.text.slice(0, 500) : undefined,
      backgroundColor: typeof element?.backgroundColor === "string" ? element.backgroundColor : undefined,
      strokeColor: typeof element?.strokeColor === "string" ? element.strokeColor : undefined,
    })),
  };
}

const ASSETS_ROUTE = "/excalidraw-assets/";
// Inline base64 file records (drag-dropped images, video posters) are shipped
// as-is only when small; large bitmaps are always asset-backed and travel as an
// asset reference the viewer resolves through the relay/Cloud instead.
const INLINE_FILE_MAX_BYTES = 256 * 1024;

// Viewport-only appState: never leak local selection or collaborator cursors to
// the mobile viewer, but carry scroll/zoom so the phone opens on the same view.
function toViewerAppState(appState) {
  const src = appState && typeof appState === "object" ? appState : {};
  const out = {
    viewBackgroundColor: typeof src.viewBackgroundColor === "string" ? src.viewBackgroundColor : "#ffffff",
  };
  if (Number.isFinite(Number(src.scrollX))) out.scrollX = Number(src.scrollX);
  if (Number.isFinite(Number(src.scrollY))) out.scrollY = Number(src.scrollY);
  const zoom = Number(src.zoom?.value ?? src.zoom);
  if (Number.isFinite(zoom) && zoom > 0) out.zoom = { value: zoom };
  return out;
}

function assetNameFromUrl(url) {
  const raw = String(url || "");
  if (!raw.startsWith(ASSETS_ROUTE)) return "";
  try {
    return decodeURIComponent(raw.slice(ASSETS_ROUTE.length).split(/[?#]/)[0]);
  } catch {
    return raw.slice(ASSETS_ROUTE.length).split(/[?#]/)[0];
  }
}

// Full-fidelity scene for a real Excalidraw viewer: every non-deleted element
// with render/edit-critical props (so the mobile canvas matches the desktop),
// plus a files map that references heavy bitmaps by asset name (resolved to a
// Cloud URL out of band) and inlines only small base64 records. App metadata in
// customData can be very large and is desktop-owned, so it stays out of the
// mobile payload and is preserved again when mobile edits are reconciled.
function toEditorElement(element) {
  const { customData: _customData, ...rest } = element;
  return rest;
}

export function toEditorScene(scene) {
  const elements = (Array.isArray(scene?.elements) ? scene.elements : []).filter(
    (element) => element && !element.isDeleted,
  ).map(toEditorElement);
  const referencedFileIds = new Set(
    elements.map((element) => element?.fileId).filter((id) => typeof id === "string" && id),
  );
  const rawFiles = scene?.files && typeof scene.files === "object" ? scene.files : {};
  const files = {};
  const assetNames = new Set();
  for (const [fileId, file] of Object.entries(rawFiles)) {
    if (!referencedFileIds.has(fileId) || !file || typeof file !== "object") continue;
    const mimeType = typeof file.mimeType === "string" ? file.mimeType : "application/octet-stream";
    const dataURL = typeof file.dataURL === "string" ? file.dataURL : "";
    const assetUrl = typeof file.codexAssetUrl === "string" && file.codexAssetUrl.startsWith(ASSETS_ROUTE)
      ? file.codexAssetUrl
      : (dataURL.startsWith(ASSETS_ROUTE) ? dataURL : "");
    if (assetUrl) {
      const assetName = assetNameFromUrl(assetUrl);
      if (assetName) assetNames.add(assetName);
      files[fileId] = { id: fileId, mimeType, assetName };
    } else if (dataURL.startsWith("data:") && dataURL.length <= INLINE_FILE_MAX_BYTES) {
      files[fileId] = { id: fileId, mimeType, dataURL };
    } else {
      // Oversized inline record with no asset backing: reference by id so the
      // viewer shows a placeholder rather than bloating every snapshot.
      files[fileId] = { id: fileId, mimeType };
    }
  }
  return {
    scene: { elements, appState: toViewerAppState(scene?.appState) },
    files,
    assetNames: [...assetNames].sort(),
  };
}

// Element-level last-writer-wins merge, matching Excalidraw's own
// reconciliation: the higher `version` wins, ties broken by the larger
// `versionNonce`. Incoming (mobile) elements that don't exist locally are
// added; local-only elements are kept. Deletions travel as elements flagged
// isDeleted with a bumped version, so they win over a stale live copy.
export function reconcileElements(localElements, incomingElements) {
  const byId = new Map();
  for (const element of Array.isArray(localElements) ? localElements : []) {
    if (element && typeof element.id === "string") byId.set(element.id, element);
  }
  function preserveDesktopOwnedMetadata(current, incoming) {
    if (!current || !incoming || typeof current !== "object" || typeof incoming !== "object") {
      return incoming;
    }
    const next = { ...incoming };
    if (!("customData" in incoming) && current.customData !== undefined) {
      next.customData = current.customData;
    } else if (
      current.customData &&
      typeof current.customData === "object" &&
      incoming.customData &&
      typeof incoming.customData === "object" &&
      !Array.isArray(current.customData) &&
      !Array.isArray(incoming.customData)
    ) {
      next.customData = { ...current.customData, ...incoming.customData };
    }
    return next;
  }
  for (const incoming of Array.isArray(incomingElements) ? incomingElements : []) {
    if (!incoming || typeof incoming.id !== "string") continue;
    const current = byId.get(incoming.id);
    if (!current) {
      byId.set(incoming.id, incoming);
      continue;
    }
    const curV = Number(current.version) || 0;
    const incV = Number(incoming.version) || 0;
    if (incV > curV) {
      byId.set(incoming.id, preserveDesktopOwnedMetadata(current, incoming));
    } else if (incV === curV && (Number(incoming.versionNonce) || 0) > (Number(current.versionNonce) || 0)) {
      byId.set(incoming.id, preserveDesktopOwnedMetadata(current, incoming));
    }
  }
  return [...byId.values()];
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }
  return payload;
}

export async function createRemoteCanvasSession(options = {}) {
  const relayBaseUrl = normalizeBaseUrl(options.relayBaseUrl);
  const token = options.authToken || await requireBuzzAssistToken();
  return await fetchJson(`${relayBaseUrl}/api/remote-canvas/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      title: options.title || "BuzzAssist Remote Canvas",
      mode: options.mode === "view" ? "view" : "generate",
      expiresInHours: options.expiresInHours || 24,
    }),
  });
}

export function createRemoteCanvasRelayClient(options = {}) {
  const relayBaseUrl = normalizeBaseUrl(options.relayBaseUrl);
  const sessionId = String(options.sessionId || "").trim();
  const desktopToken = String(options.desktopToken || "").trim();
  const canvasDir = options.canvasDir;
  const localBaseUrl = String(options.localBaseUrl || "").replace(/\/+$/, "");
  const pollMs = Math.max(1000, Number(options.pollMs) || DEFAULT_POLL_MS);
  const editorPayloadMaxBytes = Math.max(
    0,
    Number(options.editorPayloadMaxBytes ?? process.env.REMOTE_CANVAS_EDITOR_PAYLOAD_MAX_BYTES) ||
      DEFAULT_EDITOR_PAYLOAD_MAX_BYTES,
  );
  const processedSequences = new Set();
  let latestSequence = 0;
  let stopped = false;
  let lastSnapshotHash = "";

  if (!sessionId || !desktopToken || !canvasDir || !localBaseUrl) {
    throw new Error("Remote canvas relay requires sessionId, desktopToken, canvasDir, and localBaseUrl.");
  }

  function remoteUrl(pathname, params = {}) {
    const url = new URL(pathname, relayBaseUrl);
    url.searchParams.set("role", "desktop");
    url.searchParams.set("token", desktopToken);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async function postRemote(type, body = {}, target = "viewer") {
    return await fetchJson(remoteUrl(`/api/remote-canvas/sessions/${encodeURIComponent(sessionId)}/messages`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, target, body }),
    });
  }

  async function callLocalJson(endpoint, payload) {
    const response = await fetch(`${localBaseUrl}${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) {
      throw new Error(body?.error || `Local ${endpoint} failed with HTTP ${response.status}`);
    }
    return body;
  }

  // Apply a mobile edit to the authoritative local canvas: reconcile the
  // incoming elements against the on-disk scene (element-level LWW) and PUT the
  // merged scene back through the local server, which fans it out to the
  // desktop editor over SSE. appState and files stay desktop-owned.
  async function applyRemoteEdit(incomingElements) {
    if (!Array.isArray(incomingElements) || incomingElements.length === 0) return false;
    const scene = await readJsonIfExists(join(canvasDir, "excalidraw-canvas.json"), {
      elements: [],
      appState: {},
      files: {},
    });
    const merged = reconcileElements(scene.elements, incomingElements);
    const nextScene = { ...scene, elements: merged };
    const response = await fetch(`${localBaseUrl}/api/canvas`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(nextScene),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.error) {
      throw new Error(body?.error || `Local canvas write failed with HTTP ${response.status}`);
    }
    return true;
  }

  async function uploadRemoteAttachment(storageId) {
    const metadata = await fetchJson(remoteUrl(
      `/api/remote-canvas/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(storageId)}`,
    ));
    const attachment = metadata.attachment;
    if (!attachment?.url) throw new Error("Attachment download URL is missing.");
    const source = await fetch(attachment.url);
    if (!source.ok || !source.body) {
      throw new Error(`Attachment download failed with HTTP ${source.status}`);
    }
    const upload = await fetch(`${localBaseUrl}/api/assets/upload`, {
      method: "POST",
      headers: {
        "content-type": attachment.type || "application/octet-stream",
        "x-upload-filename": encodeURIComponent(attachment.name || basename(String(storageId))),
      },
      body: source.body,
      duplex: "half",
    });
    const payload = await upload.json().catch(() => ({}));
    if (!upload.ok || payload?.ok === false) {
      throw new Error(payload?.error || `Local attachment upload failed with HTTP ${upload.status}`);
    }
    return payload;
  }

  const uploadedAssets = new Map(); // assetName -> { url, size }
  let assetUploadDisabled = false;

  function mimeForAssetName(name) {
    const ext = extname(name).slice(1).toLowerCase();
    const map = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
      gif: "image/gif", svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm",
      mov: "video/quicktime", srt: "application/x-subrip",
    };
    return map[ext] || "application/octet-stream";
  }

  async function uploadOneAsset(assetName) {
    const filePath = join(canvasDir, "assets", assetName);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat?.isFile()) return null;
    const cached = uploadedAssets.get(assetName);
    if (cached && cached.size === fileStat.size) return { url: cached.url, uploaded: false };

    const type = mimeForAssetName(assetName);
    const { uploadUrl } = await fetchJson(
      remoteUrl(`/api/remote-canvas/sessions/${encodeURIComponent(sessionId)}/assets/upload-url`),
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: assetName, type }) },
    );
    const bytes = await readFile(filePath);
    const put = await fetch(uploadUrl, { method: "POST", headers: { "content-type": type }, body: bytes });
    const putBody = await put.json().catch(() => ({}));
    if (!put.ok || !putBody?.storageId) throw new Error(`asset upload PUT failed (HTTP ${put.status})`);
    const registered = await fetchJson(
      remoteUrl(`/api/remote-canvas/sessions/${encodeURIComponent(sessionId)}/assets`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ storageId: putBody.storageId, name: assetName, type, size: fileStat.size }),
      },
    );
    const url = registered?.url;
    if (!url) throw new Error("asset register returned no url");
    uploadedAssets.set(assetName, { url, size: fileStat.size });
    return { url, uploaded: true };
  }

  async function ensureAssetsUploaded(assetNames) {
    if (assetUploadDisabled || !Array.isArray(assetNames) || assetNames.length === 0) return {};
    const map = {};
    let freshUploads = 0;
    let nextIndex = 0;
    const workerCount = Math.min(4, assetNames.length);
    async function uploadNext() {
      while (!assetUploadDisabled) {
        const name = assetNames[nextIndex++];
        if (!name) return;
        await uploadAndRecord(name);
      }
    }

    async function uploadAndRecord(name) {
      try {
        const result = await withTimeout(uploadOneAsset(name), 60_000, `asset upload timed out for ${name}`);
        if (result?.url) {
          map[name] = result.url;
          if (result.uploaded) freshUploads += 1;
        }
      } catch (error) {
        const message = compactError(error);
        // Cloud asset endpoints not deployed yet: stop trying (no per-poll spam).
        if (/HTTP 404|HTTP 501/.test(message)) {
          assetUploadDisabled = true;
          console.warn("[remote-canvas] asset upload disabled (Cloud endpoint unavailable); scene ships without hosted bitmaps.");
          return;
        }
        console.warn(`[remote-canvas] asset upload failed for ${name}:`, message);
      }
    }
    await Promise.all(Array.from({ length: workerCount }, uploadNext));
    if (freshUploads > 0) {
      console.warn(`[remote-canvas] uploaded ${freshUploads} new canvas assets for mobile viewer (${Object.keys(map).length}/${assetNames.length} available).`);
    }
    const orderedMap = {};
    for (const name of assetNames) {
      if (map[name]) orderedMap[name] = map[name];
    }
    return orderedMap;
  }

  async function sendSnapshot({ force = false } = {}) {
    const scene = await readJsonIfExists(join(canvasDir, "excalidraw-canvas.json"), {
      elements: [],
      appState: {},
      files: {},
    });
    const assetManifest = await readAssetManifest(canvasDir);
    const publicScene = toPublicScene(scene);
    const editor = toEditorScene(scene);
    // Resolve the asset names the editor scene needs into viewer-reachable URLs
    // (uploading to Cloud storage on demand). Optional: when no uploader is
    // configured or an upload fails, the snapshot still carries the full scene
    // and the viewer degrades to placeholders for those bitmaps.
    const assetUrls = await ensureAssetsUploaded(editor.assetNames);
    const editorPayload = {
      editorScene: editor.scene,
      files: editor.files,
      assetUrls,
    };
    const editorPayloadBytes = jsonByteLength(editorPayload);
    const includeEditorPayload = editorPayloadBytes <= editorPayloadMaxBytes;
    if (!includeEditorPayload) {
      console.warn(
        `[remote-canvas] full editor payload omitted (${editorPayloadBytes} bytes > ${editorPayloadMaxBytes}); legacy preview only.`,
      );
    }
    const snapshotCore = {
      // Skeleton scene kept for the legacy snapshot-preview viewer.
      scene: publicScene,
      // Full-fidelity scene + file map for a real Excalidraw viewer. Omit when
      // it would exceed the Cloud/session payload budget; the legacy preview
      // still lets the viewer load instead of failing the relay.
      ...(includeEditorPayload
        ? editorPayload
        : {
            editorOmitted: {
              reason: "payload_too_large",
              bytes: editorPayloadBytes,
              maxBytes: editorPayloadMaxBytes,
            },
          }),
      assetManifest,
      elementCount: editor.scene.elements.length,
      assetCount: assetManifest.assets.length,
    };
    const hash = jsonHash(snapshotCore);
    if (!force && hash === lastSnapshotHash) return;
    lastSnapshotHash = hash;
    const snapshot = {
      ...snapshotCore,
      localUpdatedAt: new Date().toISOString(),
    };
    await postRemote("scene.snapshot", snapshot, "viewer");
  }

  async function executeJob(message) {
    const body = message.body && typeof message.body === "object" ? message.body : {};
    const jobId = String(body.jobId || `remote_${message.sequence}`);
    const kind = String(body.kind || "");
    const endpoint = String(body.endpoint || "");
    const payload = body.payload && typeof body.payload === "object" ? { ...body.payload } : {};
    await postRemote("job.status", { jobId, kind, status: "running" }, "viewer");
    try {
      if (body.attachmentStorageId) {
        const localAsset = await uploadRemoteAttachment(String(body.attachmentStorageId));
        if (kind === "subtitle") payload.audioPath = localAsset.path;
        else if (kind === "silence-cut") payload.videoPath = localAsset.path;
        else payload.sourcePath = localAsset.path;
        payload.customData = {
          ...(payload.customData && typeof payload.customData === "object" ? payload.customData : {}),
          remoteCanvasAttachmentName: localAsset.name,
        };
      }
      const result = await callLocalJson(endpoint || endpointForKind(kind), payload);
      await postRemote("job.result", { jobId, kind, status: "completed", result }, "viewer");
      await sendSnapshot({ force: true });
    } catch (error) {
      await postRemote("job.result", { jobId, kind, status: "failed", error: compactError(error) }, "viewer");
    }
  }

  function endpointForKind(kind) {
    switch (kind) {
      case "image":
        return "/api/generate/image";
      case "image-batch":
        return "/api/generate/images/batch";
      case "video":
        return "/api/generate/video";
      case "video-batch":
        return "/api/generate/videos/batch";
      case "subtitle":
        return "/api/generate/subtitles";
      case "silence-cut":
        return "/api/video/silence-cut";
      default:
        throw new Error(`Unsupported remote canvas job kind: ${kind || "(missing)"}`);
    }
  }

  async function handleMessages(messages) {
    for (const message of messages) {
      if (!message?.sequence || processedSequences.has(message.sequence)) continue;
      processedSequences.add(message.sequence);
      if (processedSequences.size > 500) {
        const ordered = [...processedSequences].sort((a, b) => a - b);
        for (const sequence of ordered.slice(0, ordered.length - 250)) processedSequences.delete(sequence);
      }
      if (message.type === "job.create") {
        await executeJob(message);
      } else if (message.type === "scene.edit") {
        await handleSceneEdit(message);
      }
    }
  }

  async function handleSceneEdit(message) {
    const body = message.body && typeof message.body === "object" ? message.body : {};
    const editId = String(body.editId || `edit_${message.sequence}`);
    try {
      const applied = await applyRemoteEdit(body.elements);
      if (applied) {
        await postRemote("scene.edit.ack", { editId, status: "applied" }, "viewer");
        await sendSnapshot({ force: true });
      }
    } catch (error) {
      await postRemote("scene.edit.ack", { editId, status: "failed", error: compactError(error) }, "viewer");
    }
  }

  async function pollOnce() {
    const payload = await fetchJson(remoteUrl(
      `/api/remote-canvas/sessions/${encodeURIComponent(sessionId)}/events`,
      { after: latestSequence, limit: 50 },
    ));
    latestSequence = Math.max(latestSequence, Number(payload.latestSequence || latestSequence) || 0);
    if (Array.isArray(payload.messages)) {
      await handleMessages(payload.messages);
    }
  }

  async function loop() {
    await postRemote("desktop.connected", {
      sessionId,
      localBaseUrl,
      connectedAt: new Date().toISOString(),
    }, "viewer");
    await sendSnapshot({ force: true });
    while (!stopped) {
      try {
        await pollOnce();
        await sendSnapshot();
      } catch (error) {
        console.warn("[remote-canvas] relay poll failed:", compactError(error));
      }
      await sleep(pollMs);
    }
  }

  const running = loop();
  return {
    sessionId,
    relayBaseUrl,
    localBaseUrl,
    stop() {
      stopped = true;
    },
    done: running,
    sendSnapshot,
  };
}
