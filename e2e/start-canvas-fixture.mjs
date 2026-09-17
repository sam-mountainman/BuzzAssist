import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { projectCanvasRunMedia } from "../lib/canvasRunMediaProjection.mjs";
import { projectCanvasRun } from "../lib/canvasRunProjection.mjs";
import { sha256Hex } from "../lib/canvasRunState.mjs";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const TINY_MP4 = Buffer.from(
  "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMsbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAZAAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAld0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAZAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAAAkAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAGQAAAAAAABAAAAAAHPbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAAEABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABem1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAATpzdGJsAAAAunN0c2QAAAAAAAAAAQAAAKphdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAJABIAAAASAAAAAAAAAABFUxhdmM2MS4xOS4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAMGF2Y0MBQsAK/+EAGGdCwArZBH+fARAAAAMAEAAAAwCg8SJkgAEABWjLg8sgAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAANGwAAAAAAAAAGHN0dHMAAAAAAAAAAQAAAAIAAAgAAAAAFHN0c3MAAAAAAAAAAQAAAAEAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAIAAAABAAAAHHN0c3oAAAAAAAAAAAAAAAIAAAKVAAAACgAAABRzdGNvAAAAAAAAAAEAAANcAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2MS43LjEwMAAAAAhmcmVlAAACp21kYXQAAAJwBgX//2zcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDIzIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgxOjB4MTExIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj01IHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWRfPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMABAgAAAAB1liIQEPEYoAAvjxwABYQjgACGzJycnXXXJXXfXXQAAAABkGaOB/jYA==",
  "base64",
);

function pcmWav({ sampleRate = 44_100, seconds = 2 } = {}) {
  const samples = Math.ceil(sampleRate * seconds);
  const dataBytes = samples * 2;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + dataBytes, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataBytes, 40);
  return bytes;
}

const sha = (value) => `sha256:${sha256Hex(value)}`;
let fixtureProjectDir = "";
let cleaning = false;

async function cleanup(exitCode) {
  if (cleaning) return;
  cleaning = true;
  const temporaryRoot = `${tmpdir()}${sep}`;
  if (fixtureProjectDir.startsWith(temporaryRoot)) {
    await rm(fixtureProjectDir, { recursive: true, force: true }).catch(() => {});
  }
  process.exit(exitCode);
}

process.once("SIGINT", () => void cleanup(0));
process.once("SIGTERM", () => void cleanup(0));

fixtureProjectDir = await mkdtemp(join(tmpdir(), "buzzassist-browser-canvas-"));
const fixtureMarker = String(process.env.BUZZASSIST_E2E_FIXTURE_MARKER || "");
if (fixtureMarker) {
  if (!fixtureMarker.startsWith(`${tmpdir()}${sep}`)) {
    throw new Error("Playwright fixture marker must stay inside the OS temporary directory.");
  }
  await writeFile(fixtureMarker, `${JSON.stringify({ fixtureProjectDir })}\n`, { flag: "wx" });
}
const incomingDir = join(fixtureProjectDir, "canvas", "assets", "incoming");
await mkdir(incomingDir, { recursive: true });

const audio = pcmWav();
const media = {
  image: { name: "selected-image.png", bytes: ONE_PIXEL_PNG, mimeType: "image/png" },
  video: { name: "final-video.mp4", bytes: TINY_MP4, mimeType: "video/mp4" },
  audio: { name: "approved-voice.wav", bytes: audio, mimeType: "audio/wav" },
};
for (const item of Object.values(media)) {
  await writeFile(join(incomingDir, item.name), item.bytes);
}

const script = "Playwright real-browser Canvas Run fixture。";
const run = {
  schemaVersion: 1,
  runId: "browser-smoke-run-001",
  revision: 1,
  status: "running",
  title: "Real browser media smoke",
  updatedAt: "2026-09-01T00:00:00.000Z",
  script: { id: "script", title: "入力台本", language: "ja", text: script, sha256: sha(script) },
  scenes: [],
  jobs: [],
  artifacts: [
    { id: "selected-image", kind: "image-selected", title: "採用画像", status: "approved", sha256: sha(media.image.bytes), canvasAssetUrl: `/excalidraw-assets/incoming/${media.image.name}`, mimeType: media.image.mimeType },
    { id: "final-video", kind: "final-mp4", title: "完成動画", status: "complete", sha256: sha(media.video.bytes), canvasAssetUrl: `/excalidraw-assets/incoming/${media.video.name}`, mimeType: media.video.mimeType, durationSeconds: 0.4 },
    { id: "approved-voice", kind: "audio", title: "承認音声", status: "complete", sha256: sha(media.audio.bytes), canvasAssetUrl: `/excalidraw-assets/incoming/${media.audio.name}`, mimeType: media.audio.mimeType, durationSeconds: 2 },
  ],
  audits: [],
  signoffs: [],
  knownRemainingIssues: [],
  versions: {
    harness: { id: "browser-smoke", version: "1", sha256: sha("browser-smoke-harness") },
    skills: [],
    channelPack: { id: "browser-smoke-pack", version: "1", sha256: sha("browser-smoke-pack") },
    providers: [],
  },
};

await projectCanvasRun({ projectDir: fixtureProjectDir }, run);
await projectCanvasRunMedia({ projectDir: fixtureProjectDir }, run);

// Keep the projected media row in the initial browser viewport so this test
// exercises real overlay DOM without clicking or scrolling the Excalidraw
// canvas into a synthetic state first.
const canvasFile = join(fixtureProjectDir, "canvas", "excalidraw-canvas.json");
const scene = JSON.parse(await readFile(canvasFile, "utf8"));
scene.appState = {
  ...(scene.appState ?? {}),
  viewBackgroundColor: "#ffffff",
  scrollX: 0,
  scrollY: -500,
  zoom: { value: 1 },
};
await writeFile(canvasFile, `${JSON.stringify(scene, null, 2)}\n`);

process.env.EXCALIDRAW_PROJECT_DIR = fixtureProjectDir;
process.env.EXCALIDRAW_CANVAS_DIR = join(fixtureProjectDir, "canvas");
process.env.EXCALIDRAW_AUTO_BUILD = "0";

console.log(`Canvas browser fixture: ${fixtureProjectDir}`);
await import("../scripts/serve-canvas.mjs");
