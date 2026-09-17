import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { promisify } from "node:util";

import { projectCanvasRun } from "../lib/canvasRunProjection.mjs";
import {
  CANVAS_RUN_MEDIA_TAG,
  CanvasRunMediaProjectionError,
  prepareCanvasRunMediaAssets,
  projectCanvasRunMedia,
} from "../lib/canvasRunMediaProjection.mjs";
import { canvasRunFingerprint, sha256Hex } from "../lib/canvasRunState.mjs";
import { resolveFfmpegToolchain } from "../lib/harnessRuntimeResolver.mjs";

const execFile = promisify(execFileCallback);
const sha = (value) => `sha256:${sha256Hex(value)}`;
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const mediaToolchain = await resolveFfmpegToolchain();

async function runMediaTool(spec, args, timeout = 60_000) {
  return execFile(spec.command, [...(spec.args ?? []), ...args], {
    timeout,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function probeMedia(filePath) {
  const { stdout } = await runMediaTool(mediaToolchain.ffprobe, [
    "-v", "error",
    "-show_streams",
    "-show_format",
    "-of", "json",
    filePath,
  ], 20_000);
  return JSON.parse(stdout || "{}");
}

async function fullyDecodeMedia(filePath) {
  await runMediaTool(mediaToolchain.ffmpeg, [
    "-hide_banner",
    "-loglevel", "error",
    "-xerror",
    "-i", filePath,
    "-map", "0",
    "-f", "null",
    "-",
  ]);
}

function fixtureRun(artifacts, overrides = {}) {
  const script = "Canvas media projection fixture。";
  return {
    schemaVersion: 1,
    runId: "media-fixture-001",
    revision: 1,
    status: "running",
    title: "media fixture",
    updatedAt: "2026-09-01T00:00:00.000Z",
    script: { id: "script", title: "入力台本", language: "ja", text: script, sha256: sha(script) },
    scenes: [],
    jobs: [],
    artifacts,
    audits: [],
    signoffs: [],
    knownRemainingIssues: [],
    versions: {
      harness: { id: "fixture", version: "1", sha256: sha("harness") },
      skills: [],
      channelPack: { id: "fixture-pack", version: "1", sha256: sha("pack") },
      providers: [],
    },
    ...overrides,
  };
}

async function mediaFixture() {
  const projectDir = await mkdtemp(join(tmpdir(), "canvas-media-projection-"));
  const incoming = join(projectDir, "canvas", "assets", "incoming");
  await mkdir(incoming, { recursive: true });
  const files = {
    image: { name: "image.png", bytes: ONE_PIXEL_PNG },
    contact: { name: "contact-sheet.png", bytes: Buffer.concat([ONE_PIXEL_PNG, Buffer.from("contact-sheet")]) },
    video: { name: "final.mp4", bytes: Buffer.from("\u0000\u0000\u0000\u0018ftypmp42fixture-video") },
    audio: { name: "voice.wav", bytes: Buffer.from("RIFFfixture-audio-WAVEfmt ") },
    bgm: { name: "bgm.mp3", bytes: Buffer.from("ID3fixture-bgm") },
    subtitle: { name: "subtitles.srt", bytes: Buffer.from("1\n00:00:00,000 --> 00:00:01,000\nテスト\n", "utf8") },
  };
  for (const file of Object.values(files)) await writeFile(join(incoming, file.name), file.bytes);
  const artifacts = [
    { id: "image", kind: "image-selected", title: "採用画像", status: "approved", sha256: sha(files.image.bytes), canvasAssetUrl: "/excalidraw-assets/incoming/image.png", mimeType: "image/png" },
    { id: "contact", kind: "contact-sheet", title: "最終contact sheet", status: "complete", sha256: sha(files.contact.bytes), canvasAssetUrl: "/excalidraw-assets/incoming/contact-sheet.png", mimeType: "image/png" },
    { id: "video", kind: "final-mp4", title: "完成動画", status: "complete", sha256: sha(files.video.bytes), canvasAssetUrl: "/excalidraw-assets/incoming/final.mp4", mimeType: "video/mp4" },
    { id: "voice", kind: "audio", title: "音声", status: "complete", sha256: sha(files.audio.bytes), canvasAssetUrl: "/excalidraw-assets/incoming/voice.wav", mimeType: "audio/wav" },
    { id: "bgm", kind: "bgm", title: "BGM", status: "complete", sha256: sha(files.bgm.bytes), canvasAssetUrl: "/excalidraw-assets/incoming/bgm.mp3", mimeType: "audio/mpeg" },
    { id: "subtitle", kind: "subtitle", title: "字幕", status: "complete", sha256: sha(files.subtitle.bytes), canvasAssetUrl: "/excalidraw-assets/incoming/subtitles.srt", mimeType: "application/x-subrip" },
  ];
  return { projectDir, files, run: fixtureRun(artifacts) };
}

test("SHA-bound media assets become real image/video/audio/subtitle elements idempotently", async () => {
  const fixture = await mediaFixture();
  try {
    await projectCanvasRun({ projectDir: fixture.projectDir }, fixture.run);
    const prepared = await prepareCanvasRunMediaAssets({ projectDir: fixture.projectDir }, fixture.run);
    assert.equal(prepared.copied, 6);
    const first = await projectCanvasRunMedia(
      { projectDir: fixture.projectDir },
      fixture.run,
      { preparedAssets: prepared },
    );
    assert.equal(first.added, 6);
    assert.equal(first.projectedMedia, 6);

    const canvasFile = join(fixture.projectDir, "canvas", "excalidraw-canvas.json");
    const scene = JSON.parse(await readFile(canvasFile, "utf8"));
    const media = scene.elements.filter((element) => element.customData?.[CANVAS_RUN_MEDIA_TAG] === true && !element.isDeleted);
    assert.equal(media.length, 6);
    assert.equal(new Set(media.map((element) => element.id)).size, 6);
    assert.equal(media.find((element) => element.customData.buzzassistEntityId === "image").type, "image");
    assert.equal(media.find((element) => element.customData.buzzassistEntityId === "contact").customData.buzzassistArtifactKind, "contact-sheet");
    assert.equal(media.find((element) => element.customData.buzzassistEntityId === "video").customData.codexMediaKind, "video");
    assert.equal(media.find((element) => element.customData.buzzassistEntityId === "voice").customData.codexMediaKind, "audio");
    assert.equal(media.find((element) => element.customData.buzzassistEntityId === "subtitle").customData.codexGeneratedSubtitle, true);
    assert.equal(media.find((element) => element.customData.buzzassistEntityId === "subtitle").customData.subtitleCueCount, 1);

    for (const element of media) {
      assert.match(element.customData.codexAssetUrl, /^\/excalidraw-assets\/harness-runs\/media-fixture-001\/[a-f0-9]{64}\./u);
      assert.ok(scene.elements.some((candidate) => candidate.id === element.customData.buzzassistArtifactCardId));
      assert.equal(Object.hasOwn(element.customData, "codexAssetPath"), false);
    }
    assert.equal(JSON.stringify(scene).includes(fixture.projectDir), false);

    for (const artifact of fixture.run.artifacts) {
      const digest = artifact.sha256.slice("sha256:".length);
      const sourceExtension = artifact.canvasAssetUrl.split(".").at(-1);
      const normalizedExtension = sourceExtension === "jpeg" ? "jpg" : sourceExtension;
      const copied = await readFile(join(fixture.projectDir, "canvas", "assets", "harness-runs", fixture.run.runId, `${digest}.${normalizedExtension}`));
      assert.equal(sha(copied), artifact.sha256);
    }

    const preparedAgain = await prepareCanvasRunMediaAssets({ projectDir: fixture.projectDir }, fixture.run);
    const second = await projectCanvasRunMedia(
      { projectDir: fixture.projectDir },
      fixture.run,
      { preparedAssets: preparedAgain },
    );
    assert.equal(preparedAgain.reused, 6);
    assert.equal(second.added, 0);
    assert.equal(second.updated, 0);
    assert.equal(second.removed, 0);
  } finally {
    await rm(fixture.projectDir, { recursive: true, force: true });
  }
});

test("concurrent divergent media precommits at one revision allow exactly one fingerprint", async () => {
  const fixture = await mediaFixture();
  try {
    await projectCanvasRun({ projectDir: fixture.projectDir }, fixture.run);
    const runA = fixtureRun(fixture.run.artifacts, {
      revision: 2,
      title: "candidate A",
      updatedAt: "2026-09-01T00:01:00.000Z",
    });
    const runB = fixtureRun(fixture.run.artifacts, {
      revision: 2,
      title: "candidate B",
      updatedAt: "2026-09-01T00:01:00.000Z",
    });
    const [preparedA, preparedB] = await Promise.all([
      prepareCanvasRunMediaAssets({ projectDir: fixture.projectDir }, runA),
      prepareCanvasRunMediaAssets({ projectDir: fixture.projectDir }, runB),
    ]);
    const outcomes = await Promise.allSettled([
      projectCanvasRunMedia({ projectDir: fixture.projectDir }, runA, { preparedAssets: preparedA, allowRunStateLag: true }),
      projectCanvasRunMedia({ projectDir: fixture.projectDir }, runB, { preparedAssets: preparedB, allowRunStateLag: true }),
    ]);
    assert.equal(outcomes.filter((row) => row.status === "fulfilled").length, 1);
    const rejected = outcomes.find((row) => row.status === "rejected");
    assert.equal(rejected.reason.code, "CANVAS_RUN_MEDIA_REVISION_CONFLICT");

    const winner = outcomes[0].status === "fulfilled" ? runA : runB;
    const canvasFile = join(fixture.projectDir, "canvas", "excalidraw-canvas.json");
    const scene = JSON.parse(await readFile(canvasFile, "utf8"));
    const fingerprints = new Set(scene.elements
      .filter((element) => element.customData?.[CANVAS_RUN_MEDIA_TAG] === true && !element.isDeleted)
      .map((element) => element.customData.buzzassistRunFingerprint));
    assert.deepEqual([...fingerprints], [canvasRunFingerprint(winner)]);
  } finally {
    await rm(fixture.projectDir, { recursive: true, force: true });
  }
});

test("content-addressed projected MP4, WAV, and MP3 assets probe and fully decode", {
  skip: mediaToolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "canvas-valid-media-projection-"));
  try {
    const incoming = join(projectDir, "canvas", "assets", "incoming");
    await mkdir(incoming, { recursive: true });
    const paths = {
      image: join(incoming, "image.png"),
      video: join(incoming, "final.mp4"),
      voice: join(incoming, "voice.wav"),
      bgm: join(incoming, "bgm.mp3"),
      subtitle: join(incoming, "subtitles.srt"),
    };

    await runMediaTool(mediaToolchain.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=0.2",
      "-frames:v", "1", "-c:v", "png", "-threads", "1",
      paths.image,
    ]);
    await runMediaTool(mediaToolchain.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-threads", "1",
      "-c:a", "aac", "-b:a", "64k", "-shortest", "-movflags", "+faststart",
      paths.video,
    ]);
    await runMediaTool(mediaToolchain.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=0.5",
      "-ac", "1", "-c:a", "pcm_s16le",
      paths.voice,
    ]);
    await runMediaTool(mediaToolchain.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=196:sample_rate=48000:duration=0.5",
      "-ac", "2", "-c:a", "libmp3lame", "-b:a", "64k",
      paths.bgm,
    ]);
    await writeFile(paths.subtitle, "1\n00:00:00,000 --> 00:00:01,000\n投影テスト\n", "utf8");

    const files = Object.fromEntries(await Promise.all(
      Object.entries(paths).map(async ([id, filePath]) => [id, await readFile(filePath)]),
    ));
    const artifacts = [
      { id: "image", kind: "image-selected", title: "採用画像", status: "approved", sha256: sha(files.image), canvasAssetUrl: "/excalidraw-assets/incoming/image.png", mimeType: "image/png" },
      { id: "video", kind: "final-mp4", title: "完成動画", status: "complete", sha256: sha(files.video), canvasAssetUrl: "/excalidraw-assets/incoming/final.mp4", mimeType: "video/mp4" },
      { id: "voice", kind: "audio", title: "音声", status: "complete", sha256: sha(files.voice), canvasAssetUrl: "/excalidraw-assets/incoming/voice.wav", mimeType: "audio/wav" },
      { id: "bgm", kind: "bgm", title: "BGM", status: "complete", sha256: sha(files.bgm), canvasAssetUrl: "/excalidraw-assets/incoming/bgm.mp3", mimeType: "audio/mpeg" },
      { id: "subtitle", kind: "subtitle", title: "字幕", status: "complete", sha256: sha(files.subtitle), canvasAssetUrl: "/excalidraw-assets/incoming/subtitles.srt", mimeType: "application/x-subrip" },
    ];
    const run = fixtureRun(artifacts, { runId: "valid-media-fixture-001" });
    await projectCanvasRun({ projectDir }, run);
    const prepared = await prepareCanvasRunMediaAssets({ projectDir }, run);
    const projected = await projectCanvasRunMedia({ projectDir }, run, { preparedAssets: prepared });
    assert.equal(prepared.copied, 5);
    assert.equal(projected.added, 5);

    const projectedPath = (artifact, extension) => join(
      projectDir,
      "canvas",
      "assets",
      "harness-runs",
      run.runId,
      `${artifact.sha256.slice("sha256:".length)}.${extension}`,
    );
    const videoPath = projectedPath(artifacts.find((artifact) => artifact.id === "video"), "mp4");
    const voicePath = projectedPath(artifacts.find((artifact) => artifact.id === "voice"), "wav");
    const bgmPath = projectedPath(artifacts.find((artifact) => artifact.id === "bgm"), "mp3");

    const videoProbe = await probeMedia(videoPath);
    assert.ok(videoProbe.streams?.some((stream) => stream.codec_type === "video" && stream.codec_name === "h264"));
    assert.ok(videoProbe.streams?.some((stream) => stream.codec_type === "audio" && stream.codec_name === "aac"));
    assert.ok(Number(videoProbe.format?.duration) > 0);

    const voiceProbe = await probeMedia(voicePath);
    assert.ok(voiceProbe.streams?.some((stream) => stream.codec_type === "audio" && stream.codec_name === "pcm_s16le"));
    assert.ok(Number(voiceProbe.format?.duration) > 0);

    const bgmProbe = await probeMedia(bgmPath);
    assert.ok(bgmProbe.streams?.some((stream) => stream.codec_type === "audio" && stream.codec_name === "mp3"));
    assert.ok(Number(bgmProbe.format?.duration) > 0);

    await fullyDecodeMedia(videoPath);
    await fullyDecodeMedia(voicePath);
    await fullyDecodeMedia(bgmPath);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("removed media is tombstoned, user placement survives revision changes, and bytes are retained", async () => {
  const fixture = await mediaFixture();
  try {
    await projectCanvasRun({ projectDir: fixture.projectDir }, fixture.run);
    await projectCanvasRunMedia({ projectDir: fixture.projectDir }, fixture.run);
    const canvasFile = join(fixture.projectDir, "canvas", "excalidraw-canvas.json");
    const scene = JSON.parse(await readFile(canvasFile, "utf8"));
    const video = scene.elements.find((element) => element.customData?.buzzassistEntityId === "video" && element.customData?.[CANVAS_RUN_MEDIA_TAG]);
    const image = scene.elements.find((element) => element.customData?.buzzassistEntityId === "image" && element.customData?.[CANVAS_RUN_MEDIA_TAG]);
    video.x = 991;
    video.y = 733;
    await writeFile(canvasFile, `${JSON.stringify(scene, null, 2)}\n`);

    const changed = fixtureRun(
      fixture.run.artifacts.filter((artifact) => artifact.id !== "image"),
      { revision: 2, updatedAt: "2026-09-01T00:01:00.000Z" },
    );
    await projectCanvasRun({ projectDir: fixture.projectDir }, changed);
    const result = await projectCanvasRunMedia({ projectDir: fixture.projectDir }, changed);
    assert.equal(result.removed, 1);
    const next = JSON.parse(await readFile(canvasFile, "utf8"));
    assert.equal(next.elements.find((element) => element.id === image.id).isDeleted, true);
    assert.equal(next.elements.find((element) => element.id === video.id).x, 991);
    assert.equal(next.elements.find((element) => element.id === video.id).y, 733);

    const imageDigest = fixture.run.artifacts.find((artifact) => artifact.id === "image").sha256.slice(7);
    assert.equal(sha(await readFile(join(fixture.projectDir, "canvas", "assets", "harness-runs", fixture.run.runId, `${imageDigest}.png`))), `sha256:${imageDigest}`);
    assert.ok(next.files[image.fileId], "tombstone用file recordも保持する");
  } finally {
    await rm(fixture.projectDir, { recursive: true, force: true });
  }
});

test("tampered, traversing, mismatched, and symlink media inputs fail before Canvas mutation", async (t) => {
  const fixture = await mediaFixture();
  try {
    const canvasFile = join(fixture.projectDir, "canvas", "excalidraw-canvas.json");
    await projectCanvasRun({ projectDir: fixture.projectDir }, fixture.run);
    const original = await readFile(canvasFile, "utf8");

    await writeFile(join(fixture.projectDir, "canvas", "assets", "incoming", "image.png"), Buffer.from("tampered"));
    await assert.rejects(
      prepareCanvasRunMediaAssets({ projectDir: fixture.projectDir }, fixture.run),
      (error) => error instanceof CanvasRunMediaProjectionError && error.code === "CANVAS_RUN_MEDIA_SHA_MISMATCH",
    );
    assert.equal(await readFile(canvasFile, "utf8"), original);

    const traversal = fixtureRun([{
      ...fixture.run.artifacts[0],
      canvasAssetUrl: "/excalidraw-assets/..%2Fprivate.png",
    }], { runId: "media-traversal-001" });
    await assert.rejects(
      prepareCanvasRunMediaAssets({ projectDir: fixture.projectDir }, traversal),
      (error) => error instanceof CanvasRunMediaProjectionError && error.code === "CANVAS_RUN_MEDIA_SOURCE_INVALID",
    );

    const mismatched = fixtureRun([{
      ...fixture.run.artifacts[1],
      mimeType: "video/webm",
    }], { runId: "media-mime-001" });
    await assert.rejects(
      prepareCanvasRunMediaAssets({ projectDir: fixture.projectDir }, mismatched),
      (error) => error instanceof CanvasRunMediaProjectionError && error.code === "CANVAS_RUN_MEDIA_FORMAT_MISMATCH",
    );

    const realAudio = join(fixture.projectDir, "real.wav");
    const linkedAudio = join(fixture.projectDir, "linked.wav");
    await writeFile(realAudio, fixture.files.audio.bytes);
    try {
      await symlink(realAudio, linkedAudio, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
        t.diagnostic("symlink creation unavailable on this host");
        return;
      }
      throw error;
    }
    const linked = fixtureRun([{
      id: "linked-audio",
      kind: "audio",
      title: "linked",
      status: "complete",
      path: linkedAudio,
      sha256: sha(fixture.files.audio.bytes),
      mimeType: "audio/wav",
    }], { runId: "media-link-001" });
    await assert.rejects(
      prepareCanvasRunMediaAssets({ projectDir: fixture.projectDir }, linked),
      (error) => error instanceof CanvasRunMediaProjectionError && error.code === "CANVAS_RUN_MEDIA_SYMLINK_REJECTED",
    );
  } finally {
    await rm(fixture.projectDir, { recursive: true, force: true });
  }
});

test("media projection rejects a stale prepared revision and dry-run writes no asset", async () => {
  const fixture = await mediaFixture();
  try {
    const oldPrepared = await prepareCanvasRunMediaAssets({ projectDir: fixture.projectDir }, fixture.run, { dryRun: true });
    const advanced = fixtureRun(fixture.run.artifacts, { revision: 2, updatedAt: "2026-09-01T00:01:00.000Z" });
    await projectCanvasRun({ projectDir: fixture.projectDir }, advanced);
    await assert.rejects(
      projectCanvasRunMedia({ projectDir: fixture.projectDir }, fixture.run, { preparedAssets: oldPrepared }),
      (error) => error instanceof CanvasRunMediaProjectionError && error.code === "CANVAS_RUN_MEDIA_STALE_REVISION",
    );

    const dryProject = await projectCanvasRunMedia(
      { projectDir: fixture.projectDir },
      advanced,
      { dryRun: true },
    );
    assert.equal(dryProject.dryRun, true);
    const digest = advanced.artifacts[0].sha256.slice(7);
    await assert.rejects(
      readFile(join(fixture.projectDir, "canvas", "assets", "harness-runs", advanced.runId, `${digest}.png`)),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await rm(fixture.projectDir, { recursive: true, force: true });
  }
});
