#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, extname, join } from "node:path";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SERVICE_NAME = "excalidraw-codex-image-bridge";

function nonEmptyString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function parseDataUrl(value) {
  const match = String(value || "").match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/s);
  if (!match) return null;
  return {
    mimeType: match[1] || "image/png",
    base64: match[2].replace(/\s+/g, ""),
  };
}

function extForMimeType(mimeType) {
  const raw = String(mimeType || "").toLowerCase();
  if (raw.includes("jpeg") || raw.includes("jpg")) return ".jpg";
  if (raw.includes("webp")) return ".webp";
  if (raw.includes("gif")) return ".gif";
  return ".png";
}

function mimeTypeForPath(filePath) {
  const ext = extname(filePath || "").toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function normalizeFileName(fileName, mimeType) {
  const fallback = `codex-image-${Date.now()}${extForMimeType(mimeType)}`;
  const raw = basename(nonEmptyString(fileName) || fallback).replace(/[^\w .()[\]-]+/g, "-").trim();
  const name = raw || fallback;
  return extname(name) ? name : `${name}${extForMimeType(mimeType)}`;
}

function buildImagePrompt(payload) {
  const prompt = nonEmptyString(payload.prompt);
  if (!prompt) throw new Error("prompt is required.");

  const lines = [`$imagegen ${prompt}`];
  const aspectRatio = nonEmptyString(payload.aspectRatio || payload.aspect_ratio);
  const quality = nonEmptyString(payload.quality);
  const imageSize = nonEmptyString(payload.imageSize || payload.size || payload.resolution);

  if (aspectRatio) lines.push(`Aspect ratio: ${aspectRatio}.`);
  if (imageSize) lines.push(`Image size: ${imageSize}.`);
  if (quality && quality.toLowerCase() !== "auto") lines.push(`Quality: ${quality}.`);
  if (hasReferenceImages(payload)) lines.push("Use the attached reference image inputs when they help.");
  return lines.join("\n");
}

function hasReferenceImages(payload) {
  return (
    (Array.isArray(payload.referenceImages) && payload.referenceImages.length > 0) ||
    (Array.isArray(payload.referenceImagePaths) && payload.referenceImagePaths.length > 0)
  );
}

async function writeReferenceInputs(tempDir, payload) {
  const inputs = [];
  const items = [];
  if (Array.isArray(payload.referenceImages)) items.push(...payload.referenceImages);
  if (Array.isArray(payload.referenceImagePaths)) items.push(...payload.referenceImagePaths);

  let index = 0;
  for (const item of items) {
    const value = typeof item === "string"
      ? item
      : nonEmptyString(item?.dataURL || item?.dataUrl || item?.url || item?.path || item?.filePath);
    const source = nonEmptyString(value);
    if (!source) continue;

    const inline = parseDataUrl(source);
    if (inline) {
      const filePath = join(tempDir, `reference-${String(index + 1).padStart(2, "0")}${extForMimeType(inline.mimeType)}`);
      await writeFile(filePath, Buffer.from(inline.base64, "base64"));
      inputs.push({ type: "localImage", path: filePath });
      index += 1;
      continue;
    }

    if (/^https?:\/\//i.test(source)) {
      inputs.push({ type: "image", url: source });
      index += 1;
      continue;
    }

    const filePath = source.startsWith("file://") ? new URL(source).pathname : source;
    inputs.push({ type: "localImage", path: filePath });
    index += 1;
  }

  return inputs;
}

async function readImageFile(filePath, fileNameHint, mimeTypeHint) {
  const buffer = await readFile(filePath);
  const mimeType = nonEmptyString(mimeTypeHint).startsWith("image/") ? nonEmptyString(mimeTypeHint) : mimeTypeForPath(filePath);
  return {
    mimeType,
    base64: buffer.toString("base64"),
    fileName: normalizeFileName(fileNameHint || basename(filePath), mimeType),
  };
}

async function resolveImageSource(source, fileNameHint, mimeTypeHint) {
  const raw = nonEmptyString(source);
  if (!raw) throw new Error("Codex image generation returned an empty source.");

  const inline = parseDataUrl(raw);
  if (inline) {
    return {
      mimeType: inline.mimeType,
      base64: inline.base64,
      fileName: normalizeFileName(fileNameHint, inline.mimeType),
    };
  }

  if (/^https?:\/\//i.test(raw)) {
    const response = await fetch(raw);
    if (!response.ok) throw new Error(`Failed to download Codex image result: ${response.status} ${response.statusText}`);
    const mimeType = response.headers.get("content-type")?.split(";")[0] || mimeTypeHint || "image/png";
    return {
      mimeType,
      base64: Buffer.from(await response.arrayBuffer()).toString("base64"),
      fileName: normalizeFileName(fileNameHint || basename(new URL(raw).pathname), mimeType),
    };
  }

  const filePath = raw.startsWith("file://") ? new URL(raw).pathname : raw;
  return readImageFile(filePath, fileNameHint, mimeTypeHint);
}

async function extractImageResult(item) {
  const fileNameHint = typeof item?.fileName === "string" ? item.fileName : undefined;
  const mimeTypeHint = typeof item?.mimeType === "string" ? item.mimeType : undefined;
  const savedPath = nonEmptyString(item?.savedPath);
  if (savedPath) return readImageFile(savedPath, fileNameHint, mimeTypeHint);

  const result = item?.result;
  if (typeof result === "string" && result.trim()) {
    return resolveImageSource(result, fileNameHint, mimeTypeHint);
  }
  if (result && typeof result === "object") {
    for (const key of ["savedPath", "path", "url", "dataURL", "dataUrl", "image", "result"]) {
      const value = nonEmptyString(result[key]);
      if (!value) continue;
      if (key === "savedPath" || key === "path") {
        return readImageFile(
          value,
          fileNameHint || (typeof result.fileName === "string" ? result.fileName : undefined),
          mimeTypeHint || (typeof result.mimeType === "string" ? result.mimeType : undefined),
        );
      }
      return resolveImageSource(
        value,
        fileNameHint || (typeof result.fileName === "string" ? result.fileName : undefined),
        mimeTypeHint || (typeof result.mimeType === "string" ? result.mimeType : undefined),
      );
    }
  }
  throw new Error("Codex image generation completed without an image payload.");
}

class CodexAppServerClient {
  constructor({ cwd, timeoutMs }) {
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = new Set();
    this.stderr = "";
  }

  async start() {
    const command = process.env.CODEX_COMMAND || "codex";
    this.child = spawn(command, ["app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const reader = createInterface({ input: this.child.stdout });
    reader.on("line", (line) => this.handleLine(line));
    this.reader = reader;

    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-16_384);
    });

    this.child.on("close", (code, signal) => {
      const error = new Error(`Codex app-server exited unexpectedly (code: ${code ?? "unknown"}, signal: ${signal ?? "none"}).`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });

    await new Promise((resolve, reject) => {
      this.child.once("spawn", resolve);
      this.child.once("error", reject);
    });

    await this.request("initialize", {
      clientInfo: {
        name: "excalidraw_codex_image_bridge",
        title: "Excalidraw Codex Image Bridge",
        version: "1.0.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized");
  }

  handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this.stderr = `${this.stderr}\n${trimmed}`.slice(-16_384);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "id") && !Object.prototype.hasOwnProperty.call(message, "method")) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (typeof message.method === "string" && !Object.prototype.hasOwnProperty.call(message, "id")) {
      for (const listener of this.notifications) listener(message);
    }
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Codex app-server response to ${method}.`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      const message = params === undefined ? { method, id } : { method, id, params };
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  notify(method, params) {
    const message = params === undefined ? { method } : { method, params };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  onNotification(listener) {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  dispose() {
    this.reader?.close();
    if (this.child && !this.child.killed) this.child.kill();
  }
}

async function generateWithCodex(payload) {
  const timeoutMs = Number.parseInt(process.env.CODEX_IMAGE_BRIDGE_TIMEOUT_MS || "", 10) || DEFAULT_TIMEOUT_MS;
  const cwd = process.env.CODEX_IMAGE_BRIDGE_CWD || process.cwd();
  const model = nonEmptyString(process.env.CODEX_IMAGE_BRIDGE_MODEL);
  const tempDir = await mkdtemp(join(os.tmpdir(), "excalidraw-codex-image-"));
  const client = new CodexAppServerClient({ cwd, timeoutMs });
  let threadId = "";

  try {
    await mkdir(tempDir, { recursive: true });
    await client.start();
    const created = await client.request("thread/start", {
      cwd,
      ...(model ? { model } : {}),
      serviceName: DEFAULT_SERVICE_NAME,
    });
    threadId = created?.thread?.id || "";
    if (!threadId) throw new Error("Codex app-server did not return a thread id.");

    const input = [
      { type: "text", text: buildImagePrompt(payload) },
      ...(await writeReferenceInputs(tempDir, payload)),
    ];

    let expectedTurnId = "";
    let settled = false;
    const resultPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("Timed out waiting for Codex image generation."));
        }
      }, timeoutMs);

      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        disposeListener();
        if (error) reject(error);
        else resolve(result);
      };

      const disposeListener = client.onNotification((message) => {
        if (message.method === "item/completed") {
          const params = message.params || {};
          if (params.threadId !== threadId) return;
          if (expectedTurnId && params.turnId !== expectedTurnId) return;
          if (params.item?.type !== "imageGeneration") return;
          extractImageResult(params.item).then((result) => finish(undefined, result), finish);
          return;
        }

        if (message.method === "turn/completed") {
          const params = message.params || {};
          if (params.threadId !== threadId) return;
          if (expectedTurnId && params.turn?.id !== expectedTurnId) return;
          const imageItem = Array.isArray(params.turn?.items)
            ? params.turn.items.find((item) => item?.type === "imageGeneration")
            : undefined;
          if (imageItem) {
            extractImageResult(imageItem).then((result) => finish(undefined, result), finish);
            return;
          }
          if (params.turn?.error?.message) finish(new Error(params.turn.error.message));
        }
      });
    });

    const started = await client.request("turn/start", {
      threadId,
      input,
      cwd,
      ...(model ? { model } : {}),
      effort: process.env.CODEX_IMAGE_BRIDGE_EFFORT || "medium",
    });
    expectedTurnId = started?.turn?.id || "";
    const initialImageItem = Array.isArray(started?.turn?.items)
      ? started.turn.items.find((item) => item?.type === "imageGeneration")
      : undefined;
    if (initialImageItem) return extractImageResult(initialImageItem);
    if (started?.turn?.error?.message) throw new Error(started.turn.error.message);
    return await resultPromise;
  } finally {
    if (threadId) {
      await client.request("thread/archive", { threadId }).catch(() => undefined);
    }
    client.dispose();
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main() {
  const raw = await readStdin();
  const payload = JSON.parse(raw || "{}");
  const result = await generateWithCodex(payload);
  process.stdout.write(`${JSON.stringify({ success: true, ...result })}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    success: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
