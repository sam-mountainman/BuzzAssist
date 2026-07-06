import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { requireBuzzAssistToken, resolveBuzzAssistApiBase } from "./buzzassistApi.mjs";

const DEFAULT_POLL_MS = 2500;

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

  async function sendSnapshot({ force = false } = {}) {
    const scene = await readJsonIfExists(join(canvasDir, "excalidraw-canvas.json"), {
      elements: [],
      appState: {},
      files: {},
    });
    const assetManifest = await readAssetManifest(canvasDir);
    const publicScene = toPublicScene(scene);
    const snapshot = {
      scene: publicScene,
      assetManifest,
      elementCount: publicScene.elements.length,
      assetCount: assetManifest.assets.length,
      localUpdatedAt: new Date().toISOString(),
    };
    const hash = jsonHash(snapshot);
    if (!force && hash === lastSnapshotHash) return;
    lastSnapshotHash = hash;
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
      }
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
