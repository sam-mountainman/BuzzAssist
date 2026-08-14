import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  bubbleSegmentSpeechBoundaries,
  canReuseRenderedCut,
  applySpeechPronunciations,
  acquireMangaRenderLock,
  adoptEpisodeCutImages,
  auditBubbleSegmentNaturalness,
  auditCameraSequencePolicy,
  buildEpisodeAudioMixFilter,
  cameraInterpolationExpression,
  cameraKeyframeExpression,
  cameraProgressExpression,
  compileEpisodeTiming,
  exactCutMediaClock,
  generateEpisodeSpeech,
  mangaBubbleDisplayText,
  naturalBubbleSegmentsForLimit,
  normalizeSpeechPronunciations,
  normalizeEpisodeCamera,
  normalizeCameraShotSequence,
  normalizePanelLayout,
  overlayTranslationFilter,
  parseMangaScript,
  projectFaceBoundsThroughCamera,
  refreshEpisodeBubbleOverlays,
  renderCutInputHash,
  renderThoughtFocusSvg,
  resolveEpisodeImageForCut,
  resolveThoughtFocusForUtterance,
  stripFuriganaAnnotations,
} from "../lib/mangaVideoPipeline.mjs";

test("natural timed segmentation never emits a whitespace-only replacement", () => {
  const source = "今日は晴れ？ 明日も晴れる。";
  const segments = naturalBubbleSegmentsForLimit(source, 7);
  assert.ok(segments.length > 1);
  assert.equal(segments.join(""), source);
  assert.ok(segments.every((segment) => segment.trim().length > 0));
});

test("Koya bubble display text removes only terminal Japanese periods", () => {
  assert.equal(mangaBubbleDisplayText("内側。句点。", { stripTerminalJapanesePeriod: true }), "内側。句点");
  assert.equal(mangaBubbleDisplayText("疑問？", { stripTerminalJapanesePeriod: true }), "疑問？");
  assert.equal(mangaBubbleDisplayText("保持。", { stripTerminalJapanesePeriod: false }), "保持。");
  const timedText = "最初の文です。次の文も続きます";
  assert.equal(auditBubbleSegmentNaturalness(timedText, ["最初の文です。", "次の文も続きます"]).exactText, true);
  assert.equal(mangaBubbleDisplayText(timedText, { stripTerminalJapanesePeriod: true }), timedText);
});

test("Japanese bubble replacement boundaries reject names, compounds, and inflections split mid-word", () => {
  const text = "閉鎖予定の山間バス停で、佐藤誠司は最後の点検に立ち会っていた";
  const bad = auditBubbleSegmentNaturalness(text, ["閉鎖予定の山間バス停で、佐藤誠", "司は最後の点検に立ち会っていた"]);
  assert.equal(bad.pass, false);
  assert.ok(bad.unnaturalBoundaries.length > 0);
  const good = auditBubbleSegmentNaturalness(text, ["閉鎖予定の山間バス停で、", "佐藤誠司は", "最後の点検に立ち会っていた"]);
  assert.equal(good.pass, true);

  assert.equal(auditBubbleSegmentNaturalness(
    "廃止申請には、その便を三か月利用した人はいないと記されていた",
    ["廃止申請には、その便を三か月利", "用した人はいないと記されていた"],
  ).pass, false);
  assert.equal(auditBubbleSegmentNaturalness(
    "翌月、朝の一本は通院する住民のために残された",
    ["翌月、朝の一本は通院す", "る住民のために残された"],
  ).pass, false);
  assert.equal(auditBubbleSegmentNaturalness(
    "この時刻表、午前七時十分の便だけ剥がされていますね",
    ["この時刻表、午前七時十分の", "便だけ剥がされていますね"],
  ).pass, false);
  assert.equal(auditBubbleSegmentNaturalness(
    "けれど、券売機の記録には毎週金曜日、同じ区間の回数券が使われています",
    ["けれど、券売機の記録に", "は毎週金曜日、", "同じ区間の回数券が使われています"],
  ).pass, false);
});

test("manual bubble clearance offsets translate transparent overlays without wraparound", () => {
  assert.equal(overlayTranslationFilter({}), "");
  assert.equal(
    overlayTranslationFilter({ x: 0, y: 120 }),
    "pad=w=iw+0:h=ih+120:x=0:y=120:color=0x00000000,crop=w=iw-0:h=ih-120:x=0:y=0",
  );
  assert.equal(
    overlayTranslationFilter({ x: -20, y: 0 }),
    "pad=w=iw+20:h=ih+0:x=0:y=0:color=0x00000000,crop=w=iw-20:h=ih-0:x=20:y=0",
  );
});

test("exact cut media clock represents 30 fps boundaries by counts instead of rounded seconds", () => {
  assert.deepEqual(exactCutMediaClock(44.46666666666667, 30), {
    frameCount: 1334,
    durationSeconds: 1334 / 30,
    sampleCount: 2_134_400,
  });
});

test("episode audio mix uses absolute sample delays instead of concatenated AAC clocks", () => {
  const mix = buildEpisodeAudioMixFilter([
    { id: "u2", timing: { audioStartSeconds: 1.25 }, audio: { filePath: "/tmp/u2.wav" } },
    { id: "u1", timing: { audioStartSeconds: 0.1 }, audio: { filePath: "/tmp/u1.wav" } },
  ], { inputOffset: 1, sampleRate: 48_000, sampleCount: 96_000 });
  assert.deepEqual(mix.inputPaths, ["/tmp/u1.wav", "/tmp/u2.wav"]);
  assert.match(mix.filterGraph, /\[1:a\].*adelay=4800S:all=1\[episodea0\]/u);
  assert.match(mix.filterGraph, /\[2:a\].*adelay=60000S:all=1\[episodea1\]/u);
  assert.match(mix.filterGraph, /apad=whole_len=96000,atrim=end_sample=96000/u);
});

test("episode render lock is atomic, rejects a live owner, and reclaims a dead owner", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "manga-render-lock-"));
  const lockPath = join(rootDir, ".render.lock");
  const release = await acquireMangaRenderLock(lockPath, {
    pid: 101,
    startedAt: "2026-08-10T00:00:00.000Z",
    isProcessAlive: (pid) => pid === 101,
  });
  await assert.rejects(
    acquireMangaRenderLock(lockPath, {
      pid: 202,
      isProcessAlive: (pid) => pid === 101,
    }),
    /Another render \(pid 101/u,
  );
  await release();
  await writeFile(lockPath, JSON.stringify({ pid: 303, startedAt: "stale", token: "old" }), "utf8");
  const releaseReclaimed = await acquireMangaRenderLock(lockPath, {
    pid: 404,
    isProcessAlive: () => false,
  });
  const reclaimed = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(reclaimed.pid, 404);
  await releaseReclaimed();
  await assert.rejects(readFile(lockPath, "utf8"), { code: "ENOENT" });
});

test("episode speech runs with bounded concurrency and resumes from input-hash checkpoints", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "manga-speech-dag-"));
  const canvasDir = join(projectDir, "canvas");
  const rootDir = join(canvasDir, "manga-videos", "episode-speech-dag");
  const audioDir = join(canvasDir, "assets", "audio");
  const manifestPath = join(rootDir, "episode-manifest.json");
  await mkdir(rootDir, { recursive: true });
  await mkdir(audioDir, { recursive: true });
  const utterances = Array.from({ length: 6 }, (_, index) => ({
    id: `cut-01-u${String(index + 1).padStart(2, "0")}`,
    cutId: "cut-01",
    order: index + 1,
    speakerName: "話者",
    speakerId: "speaker",
    text: `台詞${index + 1}`,
    speechText: `台詞${index + 1}`,
    voiceId: "voice-test",
    voiceName: "Test Voice",
    model: "eleven_multilingual_v2",
    voiceSettings: { stability: 0.7, similarityBoost: 0.75, speed: 1 },
    audio: null,
    timing: null,
  }));
  utterances[0].performancePrompt = "[thoughtful]";
  utterances[0].audioFileName = "episode-speech-dag-cut-01-u01-v11-raw.mp3";
  utterances[1].speechOverride = "台詞に。";
  const manifest = {
    version: 1,
    id: "episode-speech-dag",
    title: "並列音声テスト",
    status: "planned",
    model: "eleven_multilingual_v2",
    defaultVoiceId: "voice-test",
    defaultVoiceName: "Test Voice",
    video: {},
    speech: { pronunciations: [] },
    cuts: [{ id: "cut-01", utteranceIds: utterances.map((utterance) => utterance.id) }],
    utterances,
    metrics: {},
    outputs: {},
  };
  let active = 0;
  let peak = 0;
  let writeCount = 0;
  const writeSpeechAssetImpl = async (input) => {
    active += 1;
    peak = Math.max(peak, active);
    writeCount += 1;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));
    const fileName = input.fileName;
    const filePath = join(audioDir, fileName);
    await writeFile(filePath, `audio-${input.utteranceId}`);
    active -= 1;
    return {
      inputHash: input.inputHash,
      utteranceId: input.utteranceId,
      provider: "elevenlabs",
      model: input.model,
      voiceId: input.voiceId,
      voiceName: input.voiceName,
      text: input.displayText,
      displayText: input.displayText,
      speechText: input.speechText,
      providerText: input.text,
      performancePrompt: input.performancePrompt,
      durationSeconds: 1,
      speechStartSeconds: 0,
      speechEndSeconds: 1,
      characterCount: [...input.text].length,
      characterCost: [...input.text].length,
      elapsedMs: 15,
      requestId: `request-${input.utteranceId}`,
      fileName,
      filePath,
      assetUrl: `/audio/${fileName}`,
      alignmentFileName: `${fileName}.json`,
      alignmentPath: `${filePath}.json`,
      mimeType: "audio/mpeg",
    };
  };

  const generated = await generateEpisodeSpeech({
    manifest,
    manifestPath,
    canvasDir,
    speechConcurrency: 4,
    writeSpeechAssetImpl,
  });
  assert.equal(generated.failedCount, 0);
  assert.equal(generated.concurrency, 4);
  assert.equal(writeCount, 6);
  assert.equal(peak, 4);
  assert.equal(generated.manifest.utterances[0].audio.speechText, "台詞1");
  assert.equal(generated.manifest.utterances[0].audio.providerText, "[thoughtful] 台詞1");
  assert.equal(generated.manifest.utterances[0].audio.performancePrompt, "[thoughtful]");
  assert.equal(generated.manifest.utterances[0].audio.fileName, "episode-speech-dag-cut-01-u01-v11-raw.mp3");
  assert.equal(generated.manifest.utterances[1].audio.speechText, "台詞に。");
  assert.equal(Object.keys(generated.manifest.jobs.speech).length, 6);
  assert.ok(Object.values(generated.manifest.jobs.speech).every((job) => job.status === "complete" && job.inputHash));

  const resumed = await generateEpisodeSpeech({
    manifest: generated.manifest,
    manifestPath,
    canvasDir,
    speechConcurrency: 4,
    writeSpeechAssetImpl: async () => {
      throw new Error("cache miss");
    },
  });
  assert.equal(resumed.failedCount, 0);
  assert.ok(resumed.results.every((result) => result.reused === true));
  assert.ok(Object.values(resumed.manifest.jobs.speech).every((job) => job.cacheSource === "manifest"));
});

test("episode bubble overrides are rendered and invalidate stale review output", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "manga-bubble-refresh-"));
  const rootDir = join(projectDir, "canvas", "manga-videos", "episode-bubble-test");
  const overlaySpecsDir = join(rootDir, "overlay-specs");
  const overlaysDir = join(rootDir, "overlays");
  await mkdir(overlaySpecsDir, { recursive: true });
  await mkdir(overlaysDir, { recursive: true });
  const manifestPath = join(rootDir, "episode-manifest.json");
  const overlaySpecPath = join(overlaySpecsDir, "cut-01-u01.json");
  const overlayPath = join(overlaysDir, "cut-01-u01.svg");
  await writeFile(overlayPath, "<svg/>");
  await writeFile(overlaySpecPath, JSON.stringify({
    utteranceId: "cut-01-u01",
    imageSize: { width: 1672, height: 941 },
    bubble: { id: "bubble-cut-01-u01", text: "短い台詞", preset: "dialogue", tail: false },
    plan: { avoidRegions: [] },
    profile: { id: "reference-video-locked-v3" },
  }));
  await writeFile(manifestPath, JSON.stringify({
    id: "episode-bubble-test",
    title: "配置テスト",
    status: "rendered",
    video: { width: 1920, height: 1080 },
    cuts: [{ id: "cut-01", camera: { zoomStart: 1.2 } }],
    utterances: [{
      id: "cut-01-u01",
      cutId: "cut-01",
      bubbleId: "bubble-cut-01-u01",
      order: 1,
      text: "短い台詞",
      preset: "dialogue",
      overlaySpecPath,
      overlayPath,
      rasterizedOverlayPath: "/stale.png",
    }],
    outputs: { reviewVideo: { filePath: "/stale.mp4" } },
  }));

  const bounds = { x: 700, y: 60, width: 180, height: 320 };
  const result = await refreshEpisodeBubbleOverlays({
    projectDir,
    manifestPath,
    bubbleOverrides: { "cut-01-u01": { bounds } },
  });
  assert.equal(result.manifest.status, "bubble-layout-ready");
  assert.equal(result.manifest.outputs.reviewVideo, undefined);
  assert.equal(result.manifest.utterances[0].rasterizedOverlayPath, undefined);
  assert.deepEqual(result.refreshed[0].bounds, bounds);
  assert.match(await readFile(overlayPath, "utf8"), /短い台詞/);
});

test("split-page refresh resegments long dialogue for the guaranteed camera-visible window", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "manga-split-bubble-refresh-"));
  const rootDir = join(projectDir, "canvas", "manga-videos", "episode-split-bubble");
  const overlaySpecsDir = join(rootDir, "overlay-specs");
  const overlaysDir = join(rootDir, "overlays");
  await mkdir(overlaySpecsDir, { recursive: true });
  await mkdir(overlaysDir, { recursive: true });
  const manifestPath = join(rootDir, "episode-manifest.json");
  const overlaySpecPath = join(overlaySpecsDir, "cut-01-u01.json");
  const overlayPath = join(overlaysDir, "cut-01-u01.svg");
  const text = "残すべきものは、声の大きさではなく、確かめた事実で決めましょう";
  await writeFile(overlayPath, "<svg/>");
  for (const index of [1, 2]) await writeFile(join(overlaysDir, `cut-01-u01-s${index}.svg`), "<svg/>");
  await writeFile(overlaySpecPath, JSON.stringify({
    utteranceId: "cut-01-u01",
    imageSize: { width: 1672, height: 941 },
    bubble: { id: "bubble-cut-01-u01", text, preset: "dialogue", tail: false },
    plan: { avoidRegions: [] },
    profile: { id: "reference-video-locked-v3" },
  }));
  await writeFile(manifestPath, JSON.stringify({
    id: "episode-split-bubble",
    title: "分割ページ文字組みテスト",
    status: "visuals-ready",
    video: { width: 1920, height: 1080 },
    cuts: [{
      id: "cut-01",
      imagePath: "/tmp/page.png",
      timing: { durationSeconds: 8 },
      panelLayout: {
        enabled: true,
        type: "story-3",
        panels: [{}, {}, {}],
        pageCameraMode: "top-only",
        pageViewpoint: "top",
        pageCamera: { zoomStart: 1.58, zoomEnd: 1.58, focusX: 0.5, focusY: 0.5, focusXEnd: 0.5, focusYEnd: 0.5 },
      },
    }],
    utterances: [{
      id: "cut-01-u01",
      cutId: "cut-01",
      speakerId: "speaker-a",
      order: 1,
      text,
      preset: "dialogue",
      overlaySpecPath,
      overlayPath,
      bubbleSegments: [
        { id: "cut-01-u01-bubble-s1", text: text.slice(0, 16), overlayPath: join(overlaysDir, "cut-01-u01-s1.svg") },
        { id: "cut-01-u01-bubble-s2", text: text.slice(16), overlayPath: join(overlaysDir, "cut-01-u01-s2.svg") },
      ],
    }],
    outputs: {},
  }));
  const result = await refreshEpisodeBubbleOverlays({ projectDir, manifestPath, refreshAll: true, reflowPlacement: true });
  const segments = result.manifest.utterances[0].bubbleSegments;
  assert.equal(segments.length, 3);
  assert.equal(segments.map((segment) => segment.text).join(""), text);
  assert.ok(segments.every((segment) => Array.from(segment.text).length <= 13));
  assert.equal(auditBubbleSegmentNaturalness(text, segments).pass, true);
  assert.match(await readFile(segments[2].overlayPath, "utf8"), /決めましょう/u);
});

test("episode-wide bubble refresh carries two placements forward and avoids sequential repetition", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "manga-bubble-sequence-"));
  const rootDir = join(projectDir, "canvas", "manga-videos", "episode-bubble-sequence");
  const overlaySpecsDir = join(rootDir, "overlay-specs");
  const overlaysDir = join(rootDir, "overlays");
  await mkdir(overlaySpecsDir, { recursive: true });
  await mkdir(overlaysDir, { recursive: true });
  const manifestPath = join(rootDir, "episode-manifest.json");
  const utterances = [];
  for (let index = 0; index < 3; index += 1) {
    const id = `cut-01-u0${index + 1}`;
    const overlaySpecPath = join(overlaySpecsDir, `${id}.json`);
    const overlayPath = join(overlaysDir, `${id}.svg`);
    await writeFile(overlayPath, "<svg/>");
    await writeFile(overlaySpecPath, JSON.stringify({
      utteranceId: id,
      imageSize: { width: 1000, height: 600 },
      bubble: {
        id: `bubble-${id}`,
        text: "確認",
        preset: index < 2 ? "narration" : "dialogue",
        speakerPosition: "left",
        bounds: { x: 0.798, y: 0.055, width: 0.157, height: 0.62 },
      },
      plan: { avoidRegions: [] },
      profile: { id: "reference-video-locked-v3" },
    }));
    utterances.push({
      id,
      cutId: "cut-01",
      speakerId: "speaker-a",
      order: index + 1,
      text: "確認",
      preset: index < 2 ? "narration" : "dialogue",
      overlaySpecPath,
      overlayPath,
    });
  }
  await writeFile(manifestPath, JSON.stringify({
    id: "episode-bubble-sequence",
    title: "連続配置テスト",
    status: "rendered",
    video: { width: 1000, height: 600 },
    cuts: [{
      id: "cut-01",
      imagePath: "/test/cut-01.png",
      timing: { durationSeconds: 3 },
      cameraSequence: [{
        id: "cut-01-shot-01",
        imagePath: "/test/cut-01.png",
        utteranceIds: utterances.map((entry) => entry.id),
        startSeconds: 0,
        endSeconds: 3,
        durationSeconds: 3,
        camera: { zoomStart: 1, zoomEnd: 1, focusX: 0.5, focusY: 0.5 },
        sourceFaceBoundsBySpeakerId: {
          "speaker-a": { x: 0.08, y: 0.18, width: 0.14, height: 0.24 },
        },
      }],
    }],
    utterances,
    outputs: {},
  }));

  const result = await refreshEpisodeBubbleOverlays({
    projectDir,
    manifestPath,
    refreshAll: true,
    reflowPlacement: true,
    sequenceAware: true,
  });
  assert.equal(result.refreshed.length, 3);
  assert.equal(result.refreshed[0].sequencePlacement.historyDepth, 0);
  assert.equal(result.refreshed[1].sequencePlacement.historyDepth, 1);
  assert.equal(result.refreshed[2].sequencePlacement.historyDepth, 2);
  assert.ok(result.refreshed.slice(1).every((entry) => entry.sequencePlacement.nearRepeat === false));
  assert.ok(result.refreshed.slice(1).every((entry) => entry.sequencePlacement.immediate.samePocket === false));
});

test("approved cut images can replace visuals without discarding speech timing", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "manga-adopt-"));
  const episodeId = "episode-adopt-test";
  const rootDir = join(projectDir, "canvas", "manga-videos", episodeId);
  const assetsDir = join(projectDir, "canvas", "assets");
  const overlaySpecsDir = join(rootDir, "overlay-specs");
  await mkdir(assetsDir, { recursive: true });
  await mkdir(overlaySpecsDir, { recursive: true });
  const imagePath = join(assetsDir, `${episodeId}-v7-cut-01.png`);
  const overlaySpecPath = join(overlaySpecsDir, "cut-01-u01.json");
  const manifestPath = join(rootDir, "episode-manifest.json");
  const onePixelPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(imagePath, onePixelPng);
  await writeFile(overlaySpecPath, JSON.stringify({ imagePath: "/old.png", imageSize: { width: 9, height: 9 } }));
  await writeFile(manifestPath, JSON.stringify({
    id: episodeId,
    status: "timed",
    cuts: [{ id: "cut-01", number: 1, imagePath: "/old.png", utteranceIds: ["cut-01-u01"] }],
    utterances: [{
      id: "cut-01-u01",
      cutId: "cut-01",
      overlaySpecPath,
      audio: { filePath: "/audio.mp3", durationSeconds: 1.2 },
      timing: { audioStartSeconds: 0.1 },
    }],
    outputs: { reviewVideo: { filePath: "/stale.mp4" } },
  }));

  const result = await adoptEpisodeCutImages({ projectDir, manifestPath });
  assert.equal(result.manifest.status, "visuals-ready");
  assert.equal(result.manifest.cuts[0].imagePath, imagePath);
  assert.deepEqual(result.manifest.cuts[0].imageSize, { width: 1, height: 1 });
  assert.equal(result.manifest.utterances[0].audio.durationSeconds, 1.2);
  assert.equal(result.manifest.utterances[0].timing.audioStartSeconds, 0.1);
  assert.equal(result.manifest.outputs.reviewVideo, undefined);
  const overlaySpec = JSON.parse(await readFile(overlaySpecPath, "utf8"));
  assert.equal(overlaySpec.imagePath, imagePath);
  assert.deepEqual(overlaySpec.imageSize, { width: 1, height: 1 });
});

test("display text can stay in kanji while speech uses deterministic kana aliases", () => {
  const rules = normalizeSpeechPronunciations([
    { from: "蓮", to: "レン" },
    ["澪", "ミオ"],
    { from: "展示", speech: "てんじ" },
  ]);
  assert.deepEqual(rules, [
    { from: "蓮", to: "レン" },
    { from: "澪", to: "ミオ" },
    { from: "展示", to: "てんじ" },
  ]);
  assert.equal(applySpeechPronunciations("蓮は澪の展示を見る", rules), "レンはミオのてんじを見る");
});

test("pronunciation replacement is idempotent when profiles are revised", () => {
  const displayText = "澪、神谷さんに連絡して";
  const firstProfile = [
    { from: "澪", to: "ミオ" },
    { from: "神谷", to: "カミヤ" },
  ];
  const revisedProfile = [
    { from: "澪", to: "みお" },
    { from: "神谷", to: "かみや" },
  ];

  assert.equal(applySpeechPronunciations(displayText, firstProfile), "ミオ、カミヤさんに連絡して");
  assert.equal(applySpeechPronunciations(displayText, revisedProfile), "みお、かみやさんに連絡して");
});

test("legacy camera labels normalize to a strong hold-free pullout", () => {
  const camera = normalizeEpisodeCamera({}, "slow-push");
  assert.equal(camera.zoomStart, 1.542857);
  assert.equal(camera.zoomEnd, 1.08);
  assert.equal(camera.focusXEnd, camera.focusX);
  assert.equal(camera.focusYEnd, camera.focusY);
  const svg = renderThoughtFocusSvg({
    width: 1920,
    height: 1080,
    faceBounds: { x: 0.22, y: 0.1, width: 0.24, height: 0.28 },
  });
  assert.match(svg, /mask id="spotlight"/);
  assert.match(svg, /cx="652\.8"/);
  assert.match(svg, /fill-opacity="0\.310"/);
  assert.match(svg, /rx="192\.0"/);
  assert.match(svg, /stdDeviation="22"/);
  assert.match(svg, /id="face-glow"/);
  assert.match(svg, /stop-opacity="0\.100"/);
});

test("thought focus follows the active speaker face for the current camera shot", async () => {
  const speakerId = "ren";
  const focus = await resolveThoughtFocusForUtterance({
    thoughtFocus: {
      focusX: 0.7,
      focusY: 0.7,
      radiusX: 0.17,
      radiusY: 0.22,
      faceBounds: { x: 0.6, y: 0.5, width: 0.2, height: 0.3 },
    },
    cameraSequence: [{
      utteranceIds: ["u-thought"],
      imagePath: "/current-shot.png",
      screenFaceBoundsBySpeakerId: {
        [speakerId]: { x: 0.12, y: 0.07, width: 0.13, height: 0.23 },
      },
    }],
  }, {
    id: "u-thought",
    speakerId,
    preset: "thought",
  }, 1920, 1080);
  assert.equal(focus.resolvedSource, "active-camera-shot");
  assert.deepEqual(focus.faceBounds, { x: 0.12, y: 0.07, width: 0.13, height: 0.23 });
  assert.equal(focus.focusX, undefined);
  assert.equal(focus.radiusX, undefined);
  const svg = renderThoughtFocusSvg(focus);
  assert.match(svg, /cx="355\.2"/);
  assert.match(svg, /cy="199\.8"/);
  assert.match(svg, /rx="172\.2"/);
  assert.match(svg, /ry="173\.9"/);
});

test("thought focus projects source-face bounds through the same pull-out crop", async () => {
  const sourceFace = { x: 0.15, y: 0.06, width: 0.125, height: 0.3 };
  const camera = {
    zoomStart: 1.12,
    zoomEnd: 1.04,
    focusX: 0.3,
    focusY: 0.34,
  };
  const projected = projectFaceBoundsThroughCamera(sourceFace, camera, "pull-out", 0.5);
  assert.ok(Math.abs(projected.x - 0.09825) < 0.0002);
  assert.ok(Math.abs(projected.y - 0) < 0.0002);
  assert.ok(Math.abs(projected.width - 0.14912) < 0.0002);
  assert.ok(Math.abs(projected.height - 0.35789) < 0.0002);

  const focus = await resolveThoughtFocusForUtterance({
    thoughtFocus: { faceBounds: { x: 0.01, y: 0.01, width: 0.1, height: 0.2 } },
    cameraSequence: [{
      utteranceIds: ["u-thought"],
      imagePath: "/current-shot.png",
      motion: "pull-out",
      camera,
      sourceFaceBoundsBySpeakerId: { ren: sourceFace },
      screenFaceBoundsBySpeakerId: { ren: { x: 0.12, y: 0.07, width: 0.13, height: 0.23 } },
    }],
  }, {
    id: "u-thought",
    speakerId: "ren",
    preset: "thought",
  }, 1920, 1080);
  assert.equal(focus.resolvedSource, "active-camera-projected-source-face");
  assert.deepEqual(focus.sourceFaceBounds, sourceFace);
  assert.deepEqual(focus.faceBounds, projected);
  const centerX = focus.faceBounds.x + focus.faceBounds.width / 2;
  const centerY = focus.faceBounds.y + focus.faceBounds.height / 2;
  assert.ok(Math.abs(centerX - 0.17281) < 0.0002);
  assert.ok(Math.abs(centerY - 0.17894) < 0.0002);
});

test("unequal two-panel layouts preserve the requested ratios and black gutter", () => {
  const layout = normalizePanelLayout({
    enabled: true,
    type: "vertical-2",
    gutter: 24,
    ratios: [0.42, 0.58],
    panels: [{ imagePath: "/a.png" }, { imagePath: "/b.png" }],
  }, 1920, 1080, "/fallback.png");
  assert.equal(layout.type, "vertical-2");
  assert.equal(layout.gutter, 24);
  assert.deepEqual(layout.slots.map((slot) => slot.x), [0, 820]);
  assert.equal(layout.slots[0].width + layout.slots[1].width + layout.gutter, 1920);
  assert.ok(layout.slots[0].width < layout.slots[1].width);
});

test("story-three layout exposes a left panel and two diagonal alpha masks", () => {
  const layout = normalizePanelLayout({
    enabled: true,
    type: "story-3",
    gutter: 24,
    splitRatio: 0.38,
    diagonalStart: 0.36,
    diagonalEnd: 0.63,
    panels: [{}, {}, {}],
  }, 1920, 1080, "/fallback.png");
  assert.equal(layout.panels.length, 3);
  assert.equal(layout.slots[0].x, 0);
  assert.equal(layout.slots[0].height, 1080);
  assert.equal(layout.slots[1].x, layout.slots[2].x);
  assert.match(layout.slots[1].alphaExpression, /^if\(lte/);
  assert.match(layout.slots[2].alphaExpression, /^if\(gte/);
  assert.ok(layout.slots[1].height < 1080);
  assert.ok(layout.slots[2].y > 0);
});

test("split panels freeze their crops, flatten once, and use one whole-page camera", () => {
  const layout = normalizePanelLayout({
    enabled: true,
    type: "vertical-2",
    panels: [
      {
        imagePath: "/a.png",
        motion: "independent-continuous",
        camera: {
          zoomStart: 1.07,
          zoomEnd: 1.13,
          focusX: 0.7,
          focusXEnd: 0.73,
          focusY: 0.4,
          focusYEnd: 0.395,
        },
      },
      {
        imagePath: "/b.png",
        motion: "independent-continuous",
        camera: {
          zoomStart: 1.15,
          zoomEnd: 1.08,
          focusX: 0.79,
          focusXEnd: 0.72,
          focusY: 0.36,
          focusYEnd: 0.36,
        },
      },
    ],
    pageMotion: "slow-push",
    pageCamera: {
      zoomStart: 1.02,
      zoomEnd: 1.08,
      focusX: 0.5,
      focusY: 0.51,
      focusXEnd: 0.52,
      focusYEnd: 0.47,
    },
  }, 1920, 1080, "/fallback.png");
  assert.equal(layout.composition, "post-composite-then-flatten");
  assert.equal(layout.motionPolicy, "whole-page");
  assert.equal(layout.flattenBeforeCamera, true);
  assert.equal(layout.panelCamera, "static");
  assert.equal(layout.separatorColor, "black");
  assert.equal(layout.gutter, 28);
  assert.ok(Math.abs(layout.separatorWidthRatio - 0.0145) < 0.0002);
  assert.equal(layout.panels[0].motion, "none");
  assert.equal(layout.panels[0].camera.zoomStart, 1.07);
  assert.equal(layout.panels[0].camera.zoomEnd, 1.07);
  assert.equal(layout.panels[0].camera.focusXEnd, layout.panels[0].camera.focusX);
  assert.equal(layout.panels[1].camera.zoomStart, 1.15);
  assert.equal(layout.panels[1].camera.zoomEnd, 1.15);
  assert.equal(layout.pageMotion, "pullout-only");
  assert.equal(layout.pageCameraMode, "pullout-only");
  assert.equal(layout.pageViewpoint, "wide");
  assert.equal(layout.pageEndView, "wide");
  assert.equal(layout.pageCamera.zoomStart, 1.421053);
  assert.equal(layout.pageCamera.zoomEnd, 1.08);
  assert.equal(layout.pageCamera.focusYEnd, 0.51);
});

test("pull-out cameras preserve descending zoom at constant speed without holds", () => {
  const camera = normalizeEpisodeCamera({
    zoomStart: 1.18,
    zoomEnd: 1,
    motionLeadRatio: 0.08,
    motionTailRatio: 0.12,
  }, "pull-out");
  assert.equal(camera.zoomStart, 1.342105);
  assert.equal(camera.zoomEnd, 1.02);
  assert.equal(camera.easing, "linear");
  assert.equal(camera.motionLeadRatio, 0);
  assert.equal(camera.motionTailRatio, 0);
});

test("camera progress clamps terminal frames instead of overshooting into another direction", () => {
  assert.equal(cameraProgressExpression(300, "linear"), "max(0,min(1,on/299))");
  assert.match(cameraProgressExpression(300, "soft-linear"), /0\.82\*\(max\(0,min\(1,on\/299\)\)\)/);
  assert.match(cameraProgressExpression(300, "smoothstep"), /max\(0,min\(1,on\/299\)\)/);
  assert.match(cameraProgressExpression(300, "ease-in-cubic"), /pow\(max\(0,min\(1,on\/299\)\),3\)/);
  assert.match(cameraProgressExpression(300, "ease-out-cubic"), /max\(0,min\(1,on\/299\)\)/);
  assert.equal(
    cameraInterpolationExpression(1.72, 1.16, "1-pow(1-p,3)"),
    "1.72000+(1.16000-1.72000)*(1-pow(1-p,3))",
  );
});

test("camera keyframes create one continuous piecewise-linear trajectory", () => {
  const keyframes = [
    { at: 0, zoom: 1.7, focusX: 0.7, focusY: 0.55 },
    { at: 0.6, zoom: 1.7, focusX: 0.45, focusY: 0.45 },
    { at: 1, zoom: 1.2, focusX: 0.45, focusY: 0.45 },
  ];
  const zoom = cameraKeyframeExpression(keyframes, "zoom", "p");
  const focusX = cameraKeyframeExpression(keyframes, "focusX", "p");
  assert.match(zoom, /if\(lte\(p,0\.60000\)/);
  assert.match(zoom, /1\.70000\*pow\(1\.20000\/1\.70000/);
  assert.match(focusX, /0\.70000\+\(0\.45000-0\.70000\)/);
  assert.doesNotMatch(zoom, /smoothstep/);
});

test("camera policy rejects easing, down travel, stops, and repeated source images", () => {
  const manifest = {
    video: {
      requireConstantCameraSpeed: true,
      forbidDownwardCameraMotion: true,
      forbidRepeatedCameraImages: true,
      forbidCameraStops: true,
    },
  };
  const cut = { id: "cut-01" };
  const shots = [
    {
      id: "bad-a",
      imagePath: "/tmp/repeated.png",
      angle: "down",
      motion: "down-only",
      transition: "cut",
      camera: {
        easing: "smoothstep",
        motionLeadRatio: 0,
        motionTailRatio: 0.1,
        keyframes: [
          { at: 0, zoom: 1.5, focusX: 0.5, focusY: 0.4 },
          { at: 0.5, zoom: 1.5, focusX: 0.5, focusY: 0.5 },
          { at: 1, zoom: 1.5, focusX: 0.5, focusY: 0.5 },
        ],
      },
    },
    {
      id: "bad-b",
      imagePath: "/tmp/repeated.png",
      angle: "right",
      motion: "none",
      transition: "cut",
      camera: {
        easing: "linear",
        motionLeadRatio: 0,
        motionTailRatio: 0,
        zoomStart: 1.5,
        zoomEnd: 1.5,
        focusX: 0.5,
        focusXEnd: 0.5,
        focusY: 0.4,
        focusYEnd: 0.4,
      },
    },
  ];
  const audit = auditCameraSequencePolicy(manifest, cut, shots);
  assert.equal(audit.pass, false);
  assert.deepEqual(new Set(audit.violations.map((entry) => entry.type)), new Set([
    "non-linear-easing",
    "camera-lead-or-tail-hold",
    "down-camera-label",
    "downward-focus-travel",
    "stopped-camera-segment",
    "motion-none",
    "repeated-image-in-cut",
  ]));
});

test("camera policy permits only strict locationless editorial plates to remain static", () => {
  const audit = auditCameraSequencePolicy({
    video: { forbidCameraStops: true },
  }, { id: "cut-plate" }, [{
    id: "plate",
    imagePath: "/tmp/white.png",
    angle: "editorial-plate",
    motion: "none",
    transition: "cut",
    editorialPlate: {
      type: "white-solid",
      characterPolicy: "strictly-none",
      environmentPolicy: "none",
    },
    camera: {
      easing: "linear",
      motionLeadRatio: 0,
      motionTailRatio: 0,
      zoomStart: 1,
      zoomEnd: 1,
      focusX: 0.5,
      focusXEnd: 0.5,
      focusY: 0.5,
      focusYEnd: 0.5,
    },
  }]);
  assert.equal(audit.pass, true);
});

test("semantic camera policy rejects push-ins and treats left/right/top as source viewpoints", () => {
  const manifest = {
    video: {
      requireSemanticCameraViews: true,
      forbidPushInCameraMotion: true,
    },
  };
  const good = auditCameraSequencePolicy(manifest, { id: "cut-good" }, [{
    id: "top-pullout",
    imagePath: "/tmp/top.png",
    angle: "top",
    viewpoint: "top",
    endView: "top-wide",
    viewFamily: "top",
    motion: "pullout-only",
    cameraMode: "pullout-only",
    transition: "cut",
    camera: {
      easing: "linear",
      motionLeadRatio: 0,
      motionTailRatio: 0,
      zoomStart: 1.5,
      zoomEnd: 1.08,
      focusX: 0.5,
      focusXEnd: 0.5,
      focusY: 0.5,
      focusYEnd: 0.5,
    },
  }]);
  assert.equal(good.pass, true);

  const bad = auditCameraSequencePolicy(manifest, { id: "cut-bad" }, [{
    id: "left-is-not-a-pan",
    imagePath: "/tmp/left.png",
    angle: "left",
    viewpoint: "left",
    endView: "right-wide",
    motion: "slow-push",
    transition: "cut",
    camera: {
      easing: "linear",
      motionLeadRatio: 0,
      motionTailRatio: 0,
      zoomStart: 1.02,
      zoomEnd: 1.12,
      focusX: 0.3,
      focusXEnd: 0.7,
      focusY: 0.44,
      focusYEnd: 0.44,
    },
  }]);
  assert.equal(bad.pass, false);
  const badTypes = new Set(bad.violations.map((entry) => entry.type));
  assert.ok(badTypes.has("camera-end-view-mismatch"));
  assert.ok(badTypes.has("push-in-zoom"));
});

test("split-page camera policy audits the flattened page instead of its panels", () => {
  const cut = {
    id: "cut-split",
    panelLayout: {
      enabled: true,
      composition: "post-composite-then-flatten",
      motionPolicy: "whole-page",
      flattenBeforeCamera: true,
      panelCamera: "static",
      pageViewpoint: "right",
      pageEndView: "right-wide",
      pageMotion: "pullout-only",
      pageCameraMode: "pullout-only",
      pageCamera: {
        easing: "linear",
        motionLeadRatio: 0,
        motionTailRatio: 0,
        zoomStart: 1.5,
        zoomEnd: 1.08,
        focusX: 0.5,
        focusXEnd: 0.5,
        focusY: 0.5,
        focusYEnd: 0.5,
      },
      panels: [
        { motion: "none", camera: { zoomStart: 1.05, zoomEnd: 1.05, focusX: 0.4, focusXEnd: 0.4, focusY: 0.45, focusYEnd: 0.45 } },
        { motion: "none", camera: { zoomStart: 1.05, zoomEnd: 1.05, focusX: 0.6, focusXEnd: 0.6, focusY: 0.45, focusYEnd: 0.45 } },
      ],
    },
  };
  const audit = auditCameraSequencePolicy({
    video: { requireWholePageSplitCamera: true },
  }, cut, []);
  assert.equal(audit.pass, true);
  assert.equal(audit.shotCount, 0);
});

test("camera shot sequences split at humanized speaker-gap midpoints and keep editorial reasons", () => {
  const utterances = [
    { id: "u1", timing: { audioStartInCutSeconds: 0.1, gapBeforeSeconds: 0 } },
    { id: "u2", timing: { audioStartInCutSeconds: 3.4, gapBeforeSeconds: 0.3 } },
  ];
  const shots = normalizeCameraShotSequence({
    id: "cut-01",
    imagePath: "/tmp/base.png",
    cameraSequence: [
      { imagePath: "/tmp/wide.png", utteranceIds: ["u1"], angle: "wide", reason: "establish location" },
      { imagePath: "/tmp/right.png", utteranceIds: ["u2"], angle: "right", reason: "speaker change" },
    ],
  }, utterances, 7);
  assert.equal(shots.length, 2);
  assert.equal(shots[0].endSeconds, 3.25);
  assert.equal(shots[1].startSeconds, 3.25);
  assert.equal(shots[1].reason, "speaker change");
  assert.equal(shots[1].camera.zoomStart, 1.542857);
});

test("camera shot normalization preserves semantic viewpoint metadata", () => {
  const shots = normalizeCameraShotSequence({
    id: "cut-view",
    imagePath: "/tmp/base.png",
    cameraSequence: [{
      id: "left-wide",
      imagePath: "/tmp/left.png",
      utteranceIds: ["u1"],
      angle: "left",
      viewpoint: "left",
      endView: "left-wide",
      viewFamily: "left",
      shotType: "left-wide",
      motion: "pull-out",
    }],
  }, [{ id: "u1", timing: { audioStartInCutSeconds: 0 } }], 3);
  assert.equal(shots[0].viewpoint, "left");
  assert.equal(shots[0].endView, "left-wide");
  assert.equal(shots[0].viewFamily, "left");
  assert.equal(shots[0].shotType, "left-wide");
  assert.ok(shots[0].camera.zoomStart > shots[0].camera.zoomEnd);
});

test("camera shot sequences can subdivide one utterance without duplicating its duration", () => {
  const cut = {
    id: "cut-01",
    imagePath: "/tmp/base.png",
    cameraSequence: [
      { imagePath: "/tmp/wide.png", utteranceIds: ["u1"], utteranceProgress: 0, angle: "wide" },
      { imagePath: "/tmp/top.png", utteranceIds: ["u1"], utteranceProgress: 0.5, angle: "top" },
      { imagePath: "/tmp/right.png", utteranceIds: ["u2"], utteranceProgress: 0, angle: "right" },
    ],
  };
  const utterances = [
    { id: "u1", audio: { durationSeconds: 4 }, timing: { audioStartInCutSeconds: 0.1, gapBeforeSeconds: 0 } },
    { id: "u2", audio: { durationSeconds: 3 }, timing: { audioStartInCutSeconds: 4.4, gapBeforeSeconds: 0.3 } },
  ];
  const sequence = normalizeCameraShotSequence(cut, utterances, 7.7);
  assert.deepEqual(sequence.map((entry) => Number(entry.startSeconds.toFixed(2))), [0, 2.1, 4.25]);
  assert.equal(Number(sequence.reduce((total, entry) => total + entry.durationSeconds, 0).toFixed(2)), 7.7);
  assert.equal(sequence[1].utteranceProgress, 0.5);
});

test("camera shot sequences can hold one view across consecutive utterances", () => {
  const cut = {
    id: "cut-01",
    imagePath: "/tmp/base.png",
    cameraSequence: [
      {
        imagePath: "/tmp/wide.png",
        utteranceIds: ["u1", "u2"],
        angle: "wide",
        reason: "hold the establishing view while only the bubble changes",
      },
      {
        imagePath: "/tmp/left.png",
        utteranceIds: ["u3"],
        angle: "left",
        reason: "change only when the visual speaker beat changes",
      },
    ],
  };
  const utterances = [
    { id: "u1", audio: { durationSeconds: 3 }, timing: { audioStartInCutSeconds: 0.1, gapBeforeSeconds: 0 } },
    { id: "u2", audio: { durationSeconds: 3 }, timing: { audioStartInCutSeconds: 3.27, gapBeforeSeconds: 0.17 } },
    { id: "u3", audio: { durationSeconds: 4 }, timing: { audioStartInCutSeconds: 6.57, gapBeforeSeconds: 0.3 } },
  ];
  const sequence = normalizeCameraShotSequence(cut, utterances, 10.89);
  assert.equal(sequence.length, 2);
  assert.deepEqual(sequence[0].utteranceIds, ["u1", "u2"]);
  assert.equal(sequence[0].endSeconds, 6.42);
  assert.equal(sequence[1].startSeconds, 6.42);
  assert.equal(sequence[0].reason, "hold the establishing view while only the bubble changes");
});

test("V4 artwork is preferred over earlier cut assets", async () => {
  const canvasDir = resolve("canvas");
  assert.match(await resolveEpisodeImageForCut(canvasDir, "cut-01"), /e2e-v4-cut-01\.png$/);
  assert.match(await resolveEpisodeImageForCut(canvasDir, "cut-10"), /e2e-v4-cut-10\.png$/);
});

test("manga script is parsed into ten visual cuts and stable utterance ids", async () => {
  const script = await readFile(resolve("examples/manga-character-pipeline/script.txt"), "utf8");
  const registry = {
    characters: [
      { id: "tanaka", name: "田中 悠斗", aliases: ["田中"], status: "approved" },
      { id: "kurokawa", name: "黒川 部長", aliases: ["黒川"], status: "approved" },
      { id: "sato", name: "佐藤 誠司", aliases: ["佐藤"], status: "approved" },
    ],
    voices: [],
  };
  const parsed = parseMangaScript(script, { registry });
  assert.equal(parsed.cuts.length, 10);
  assert.equal(parsed.cuts[0].id, "cut-01");
  assert.equal(parsed.cuts[9].id, "cut-10");
  assert.equal(parsed.utterances[0].id, "cut-01-u01");
  assert.equal(parsed.utterances[0].speakerId, "narration");
  assert.equal(parsed.cuts[1].utterances[0].speakerId, "kurokawa");
  assert.equal(parsed.cuts[7].utterances.length, 3);
});

test("Markdown frontmatter is metadata, not dialogue", () => {
  const script = `---
title: 雨の写真店
kind: production-script
target_cuts: 1
---

# 雨の写真店

【カット1：再会】
ナレーション：雨が降っていた。
高瀬 蓮：「おかえり」`;
  const parsed = parseMangaScript(script, { registry: { characters: [], voices: [] } });
  assert.equal(parsed.title, "雨の写真店");
  assert.equal(parsed.cuts.length, 1);
  assert.equal(parsed.utterances.length, 2);
  assert.equal(parsed.utterances[0].speakerName, "ナレーション");
  assert.equal(parsed.utterances[1].text, "おかえり");
});

test("narration preserves leading quoted terms while spoken dialogue unwraps outer quotation marks", () => {
  const parsed = parseMangaScript(`【カット1：転落】
ナレーション：「会議」という言葉すら知らなかったらしい。
花園さくら：「そんなはずないわ」`, { registry: { characters: [], voices: [] } });
  assert.equal(parsed.utterances[0].text, "「会議」という言葉すら知らなかったらしい。");
  assert.equal(parsed.utterances[1].text, "そんなはずないわ");
});

test("unregistered Japanese speaker names receive distinct deterministic ids", () => {
  const parsed = parseMangaScript(`【カット1：会話】
悠斗：行こう
美咲：うん`, { registry: { characters: [], voices: [] } });
  const [first, second] = parsed.utterances.map((entry) => entry.speakerId);
  assert.match(first, /^speaker-[a-f0-9]{10}$/u);
  assert.match(second, /^speaker-[a-f0-9]{10}$/u);
  assert.notEqual(first, second);
  assert.deepEqual(
    parseMangaScript(`悠斗：行こう
美咲：うん`, { registry: { characters: [], voices: [] } }).utterances.map((entry) => entry.speakerId),
    [first, second],
  );
});

test("exact child character names do not inherit the adult character voices", () => {
  const script = `# 回想

【カット1：子ども時代】
少女の澪：「また明日ね」
少年の蓮：「うん、約束」`;
  const registry = {
    characters: [
      { id: "adult-mio", name: "水野 澪", aliases: ["澪"], status: "approved" },
      { id: "adult-ren", name: "高瀬 蓮", aliases: ["蓮"], status: "approved" },
      { id: "child-mio", name: "少女の澪", aliases: ["幼少期の澪"], status: "approved" },
      { id: "child-ren", name: "少年の蓮", aliases: ["幼少期の蓮"], status: "approved" },
    ],
    voices: [],
  };
  const parsed = parseMangaScript(script, { registry });
  assert.deepEqual(
    parsed.utterances.map(({ speakerId }) => speakerId),
    ["child-mio", "child-ren"],
  );
});

test("audio duration becomes cut timing and bubble visibility without manual timestamps", () => {
  const manifest = {
    video: {
      preRollSeconds: 0.1,
      interUtteranceGapSeconds: 0.2,
      bubbleLeadSeconds: 0.1,
      bubbleHoldSeconds: 0.25,
      cutTailSeconds: 0.35,
    },
    cuts: [
      { id: "cut-01", utteranceIds: ["cut-01-u01", "cut-01-u02"] },
      { id: "cut-02", utteranceIds: ["cut-02-u01"] },
    ],
    utterances: [
      {
        id: "cut-01-u01",
        audio: { filePath: "/tmp/u1.mp3", durationSeconds: 1, speechStartSeconds: 0.05, speechEndSeconds: 0.9 },
      },
      {
        id: "cut-01-u02",
        audio: { filePath: "/tmp/u2.mp3", durationSeconds: 2, speechStartSeconds: 0.1, speechEndSeconds: 1.8 },
      },
      {
        id: "cut-02-u01",
        audio: { filePath: "/tmp/u3.mp3", durationSeconds: 1.5, speechStartSeconds: 0, speechEndSeconds: 1.4 },
      },
    ],
    metrics: {},
  };
  const compiled = compileEpisodeTiming(manifest);
  assert.equal(compiled.cuts[0].timing.durationSeconds, 3.65);
  assert.equal(compiled.utterances[0].timing.audioStartInCutSeconds, 0.1);
  assert.ok(Math.abs(compiled.utterances[0].timing.bubbleStartInCutSeconds - 0.05) < 1e-9);
  assert.equal(compiled.utterances[1].timing.audioStartInCutSeconds, 1.3);
  assert.ok(
    compiled.utterances[0].timing.bubbleEndInCutSeconds
      < compiled.utterances[1].timing.bubbleStartInCutSeconds,
  );
  assert.ok(
    compiled.utterances[1].timing.bubbleStartInCutSeconds
      - compiled.utterances[0].timing.bubbleEndInCutSeconds
      >= (2 / 30) - 1e-9,
  );
  const oldLastFrame = Math.floor(compiled.utterances[0].timing.bubbleEndInCutSeconds * 30 + 1e-7);
  const newFirstFrame = Math.ceil(compiled.utterances[1].timing.bubbleStartInCutSeconds * 30 - 1e-7);
  assert.ok(newFirstFrame - oldLastFrame >= 2, "one encoded clear frame must exist between bubbles");
  assert.equal(compiled.cuts[1].timing.startSeconds, 3.65);
  assert.equal(compiled.metrics.videoDurationSeconds, 5.6);
});

test("visual speech bounds align bubbles to measured waveform without changing approved audio timing", () => {
  const manifest = compileEpisodeTiming({
    video: {
      preRollSeconds: 0.1,
      bubbleLeadSeconds: 0.08,
      bubbleHoldSeconds: 0.18,
      cutTailSeconds: 0.34,
    },
    cuts: [{ id: "cut-waveform", utteranceIds: ["u1"] }],
    utterances: [{
      id: "u1",
      cutId: "cut-waveform",
      speakerId: "speaker",
      audio: {
        filePath: "/tmp/approved.wav",
        durationSeconds: 2,
        speechStartSeconds: 0.07,
        speechEndSeconds: 1.93,
      },
      bubbleTiming: {
        speechStartSeconds: 0.18325,
        speechEndSeconds: 1.8,
      },
    }],
  });
  const utterance = manifest.utterances[0];
  assert.equal(utterance.timing.audioStartInCutSeconds, 0.1);
  assert.equal(utterance.timing.audioEndInCutSeconds, 2.1);
  assert.equal(utterance.timing.bubbleStartInCutSeconds, 0.20325);
  assert.equal(utterance.timing.bubbleEndInCutSeconds, 2.08);
});

test("frame-aligned timing prevents cumulative concat drift between independently encoded cuts", () => {
  const manifest = {
    video: {
      fps: 30,
      frameAlignCutDurations: true,
      preRollSeconds: 0.1,
      cutTailSeconds: 0.1,
      sameSpeakerGapSeconds: 0.2,
    },
    cuts: [
      { id: "cut-01", utteranceIds: ["u1"] },
      { id: "cut-02", utteranceIds: ["u2"] },
    ],
    utterances: [
      { id: "u1", audio: { filePath: "/tmp/u1.wav", durationSeconds: 1.01 } },
      { id: "u2", audio: { filePath: "/tmp/u2.wav", durationSeconds: 1.02 } },
    ],
    metrics: {},
  };
  const compiled = compileEpisodeTiming(manifest);
  assert.equal(compiled.cuts[0].timing.durationSeconds * 30, 37);
  assert.equal(compiled.cuts[1].timing.durationSeconds * 30, 37);
  assert.equal(compiled.cuts[1].timing.startSeconds, 37 / 30);
  assert.equal(compiled.metrics.videoDurationSeconds, 74 / 30);
});

test("transient raster cache paths do not invalidate a completed cut hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "manga-render-hash-"));
  const imagePath = join(root, "image.png");
  const overlayPath = join(root, "bubble.svg");
  const audioPath = join(root, "speech.wav");
  await Promise.all([
    writeFile(imagePath, "image"),
    writeFile(overlayPath, "overlay"),
    writeFile(audioPath, "audio"),
  ]);
  const segment = {
    id: "u1-bubble-s1",
    text: "台詞",
    overlayPath,
    startOffsetSeconds: 0,
    endOffsetSeconds: 1,
  };
  const utterance = {
    id: "u1",
    overlayPath,
    bubbleSegments: [segment],
    audio: { filePath: audioPath, durationSeconds: 1 },
    timing: { audioStartInCutSeconds: 0.1, bubbleStartInCutSeconds: 0.1, bubbleEndInCutSeconds: 1.1 },
  };
  const manifest = { video: { width: 1920, height: 1080, fps: 30 } };
  const cut = { id: "cut-01", imagePath, motion: "none", timing: { durationSeconds: 1.2 } };
  const before = await renderCutInputHash(manifest, cut, [utterance]);
  segment.rasterizedOverlayPath = join(root, "cache-a.png");
  const after = await renderCutInputHash(manifest, cut, [utterance]);
  assert.equal(after, before);
});

test("interrupted, undecodable, or stale unselected cut files are never reused", () => {
  const complete = { status: "complete", inputHash: "same" };
  assert.equal(canReuseRenderedCut({
    existingCut: true,
    decodableCut: true,
    previousJob: { status: "running", inputHash: "same" },
    inputHash: "same",
  }), false);
  assert.equal(canReuseRenderedCut({
    existingCut: true,
    decodableCut: false,
    previousJob: complete,
    inputHash: "same",
  }), false);
  assert.equal(canReuseRenderedCut({
    existingCut: true,
    decodableCut: true,
    previousJob: complete,
    inputHash: "same",
  }), true);
  assert.equal(canReuseRenderedCut({
    existingCut: true,
    decodableCut: true,
    previousJob: complete,
    inputHash: "changed",
    excludedBySelection: true,
  }), false);
  assert.equal(canReuseRenderedCut({
    existingCut: true,
    decodableCut: true,
    previousJob: { status: "queued", inputHash: "changed" },
    inputHash: "changed-again",
    excludedBySelection: true,
  }), false);
  assert.equal(canReuseRenderedCut({
    existingCut: true,
    decodableCut: true,
    previousJob: complete,
    inputHash: "same",
    excludedBySelection: true,
  }), true);
  assert.equal(canReuseRenderedCut({
    existingCut: true,
    decodableCut: true,
    previousJob: complete,
    inputHash: "same",
    explicitlySelected: true,
  }), false);
});

test("non-zero bubble fades still reserve two frame periods for a decoded clear frame", () => {
  const manifest = {
    video: {
      fps: 30,
      preRollSeconds: 0.1,
      sameSpeakerGapSeconds: 0.2,
      bubbleLeadSeconds: 0.1,
      bubbleHoldSeconds: 0.25,
      bubbleTransitionGapSeconds: 0,
      bubbleFadeInMilliseconds: 50,
      bubbleFadeOutMilliseconds: 50,
      cutTailSeconds: 0.3,
    },
    cuts: [{ id: "cut-01", utteranceIds: ["u1", "u2"] }],
    utterances: [
      { id: "u1", audio: { filePath: "/tmp/u1.wav", durationSeconds: 1 } },
      { id: "u2", audio: { filePath: "/tmp/u2.wav", durationSeconds: 1 } },
    ],
  };
  const compiled = compileEpisodeTiming(manifest);
  const first = compiled.utterances[0].timing;
  const second = compiled.utterances[1].timing;
  assert.ok(second.bubbleStartInCutSeconds - first.bubbleEndInCutSeconds >= (2 / 30) - 1e-9);
  assert.equal(compiled.video.bubbleTransitionGapSeconds, 2 / 30);
});

test("speaker changes and emphasis receive humanized pauses without changing same-speaker cadence", () => {
  const audio = (filePath) => ({ filePath, durationSeconds: 1, speechStartSeconds: 0, speechEndSeconds: 1 });
  const manifest = {
    video: {
      preRollSeconds: 0.1,
      sameSpeakerGapSeconds: 0.17,
      speakerChangeGapSeconds: 0.3,
      emphasisGapSeconds: 0.5,
      cutTailSeconds: 0.3,
    },
    cuts: [{ id: "cut-01", utteranceIds: ["u1", "u2", "u3", "u4"] }],
    utterances: [
      { id: "u1", speakerId: "a", audio: audio("/tmp/u1.mp3") },
      { id: "u2", speakerId: "a", audio: audio("/tmp/u2.mp3") },
      { id: "u3", speakerId: "b", audio: audio("/tmp/u3.mp3") },
      { id: "u4", speakerId: "a", pauseClass: "emphasis", audio: audio("/tmp/u4.mp3") },
    ],
    metrics: {},
  };
  const compiled = compileEpisodeTiming(manifest);
  assert.equal(compiled.utterances[0].timing.audioStartInCutSeconds, 0.1);
  assert.equal(compiled.utterances[1].timing.gapBeforeSeconds, 0.17);
  assert.equal(compiled.utterances[2].timing.gapBeforeSeconds, 0.3);
  assert.equal(compiled.utterances[3].timing.gapBeforeSeconds, 0.5);
  assert.ok(Math.abs(compiled.cuts[0].timing.durationSeconds - 5.37) < 1e-9);
});

test("approved WAV padding may overlap slightly to hit an audible speech-gap target", () => {
  const manifest = {
    video: { preRollSeconds: 0.1, cutTailSeconds: 0.3 },
    cuts: [{ id: "cut-01", utteranceIds: ["u1", "u2"] }],
    utterances: [
      { id: "u1", speakerId: "a", audio: { filePath: "/tmp/u1.wav", durationSeconds: 1, speechStartSeconds: 0.07, speechEndSeconds: 0.93 } },
      { id: "u2", speakerId: "b", pauseBeforeSeconds: -0.075, audio: { filePath: "/tmp/u2.wav", durationSeconds: 1, speechStartSeconds: 0.165, speechEndSeconds: 0.93 } },
    ],
  };
  const compiled = compileEpisodeTiming(manifest);
  assert.equal(compiled.utterances[1].timing.gapBeforeSeconds, -0.075);
  const audibleGap = compiled.utterances[1].timing.audioStartInCutSeconds + 0.165
    - (compiled.utterances[0].timing.audioStartInCutSeconds + 0.93);
  assert.ok(Math.abs(audibleGap - 0.16) < 1e-9);
});

test("speech bubbles overlap by the authored crossfade instead of flashing a blank frame", () => {
  const manifest = {
    video: {
      fps: 30,
      preRollSeconds: 0.1,
      sameSpeakerGapSeconds: 0.3,
      bubbleLeadSeconds: 0.08,
      bubbleHoldSeconds: 0.18,
      bubbleTransitionGapSeconds: 0,
      bubbleTransitionCrossfadeSeconds: 0.1,
      bubbleFadeInMilliseconds: 90,
      bubbleFadeOutMilliseconds: 90,
      cutTailSeconds: 0.3,
    },
    cuts: [{ id: "cut-01", utteranceIds: ["u1", "u2"] }],
    utterances: [
      { id: "u1", speakerId: "a", audio: { filePath: "/tmp/u1.mp3", durationSeconds: 1 } },
      { id: "u2", speakerId: "a", audio: { filePath: "/tmp/u2.mp3", durationSeconds: 1 } },
    ],
    metrics: {},
  };
  const compiled = compileEpisodeTiming(manifest);
  const first = compiled.utterances[0].timing;
  const second = compiled.utterances[1].timing;
  assert.ok(Math.abs(first.bubbleEndInCutSeconds - second.bubbleStartInCutSeconds - 0.1) < 1e-9);
  assert.equal(compiled.video.bubbleFadeInMilliseconds, 90);
  assert.equal(compiled.video.bubbleFadeOutMilliseconds, 90);
});

test("an authored bubble can remain visible throughout the next utterance on the same image", () => {
  const manifest = {
    video: {
      fps: 30,
      preRollSeconds: 0.1,
      sameSpeakerGapSeconds: 0.3,
      bubbleLeadSeconds: 0.08,
      bubbleHoldSeconds: 0.18,
      bubbleTransitionGapSeconds: 0,
      bubbleTransitionCrossfadeSeconds: 0.1,
      cutTailSeconds: 0.3,
    },
    cuts: [{ id: "cut-01", utteranceIds: ["u1", "u2"] }],
    utterances: [
      {
        id: "u1",
        speakerId: "a",
        retainBubbleThroughNext: true,
        audio: { filePath: "/tmp/u1.mp3", durationSeconds: 1 },
      },
      { id: "u2", speakerId: "b", audio: { filePath: "/tmp/u2.mp3", durationSeconds: 1 } },
    ],
    metrics: {},
  };
  const compiled = compileEpisodeTiming(manifest);
  const first = compiled.utterances[0].timing;
  const second = compiled.utterances[1].timing;
  assert.ok(first.bubbleEndInCutSeconds >= second.bubbleEndInCutSeconds);
  assert.equal(compiled.utterances[0].retainBubbleThroughNext, true);
});

test("undefined adapter options never erase authored pause rules", () => {
  const audio = (filePath) => ({ filePath, durationSeconds: 1, speechStartSeconds: 0, speechEndSeconds: 1 });
  const manifest = {
    status: "speech-ready",
    video: {
      sameSpeakerGapSeconds: 0.17,
      speakerChangeGapSeconds: 0.3,
      emphasisGapSeconds: 0.5,
      cutTailSeconds: 0.32,
    },
    cuts: [{ id: "cut-01", utteranceIds: ["u1", "u2"] }],
    utterances: [
      { id: "u1", speakerId: "a", audio: audio("/tmp/u1.mp3") },
      { id: "u2", speakerId: "b", audio: audio("/tmp/u2.mp3") },
    ],
  };
  const compiled = compileEpisodeTiming(manifest, {
    sameSpeakerGapSeconds: undefined,
    speakerChangeGapSeconds: undefined,
    emphasisGapSeconds: undefined,
    encodePreset: "ultrafast",
  });
  assert.equal(compiled.utterances[1].timing.gapBeforeSeconds, 0.3);
  assert.equal(compiled.video.speakerChangeGapSeconds, 0.3);
});

test("R136 balloons print plain kanji names, not the script's reading gloss", () => {
  assert.equal(
    mangaBubbleDisplayText("高校3年生の俺、荒野（あらの）は呼び出された。"),
    "高校3年生の俺、荒野は呼び出された。",
  );
  assert.equal(
    mangaBubbleDisplayText("上沢天音（かんざわ あまね）です。ライン交換しよ"),
    "上沢天音です。ライン交換しよ",
  );
  // Ordinary parenthetical dialogue is not a reading gloss and must survive.
  assert.equal(stripFuriganaAnnotations("それは（たぶん）違うと思う"), "それは（たぶん）違うと思う");
  assert.equal(stripFuriganaAnnotations("東京（明日出発）へ行く"), "東京（明日出発）へ行く");
  // Stripping composes with the terminal-period rule rather than replacing it.
  assert.equal(
    mangaBubbleDisplayText("荒野（あらの）だ。", { stripTerminalJapanesePeriod: true }),
    "荒野だ",
  );
});

test("R137 balloon segments follow the measured voice, not a constant speaking rate", () => {
  // Six spoken characters where the voice pauses after the third: a
  // character-count split would put the boundary at the halfway point in time,
  // which is 0.4 s before the speaker actually reaches the fourth character.
  const utterance = {
    audio: {
      characterTimeline: [
        { char: "あ", startSeconds: 0.10, endSeconds: 0.25 },
        { char: "い", startSeconds: 0.25, endSeconds: 0.40 },
        { char: "う", startSeconds: 0.40, endSeconds: 0.55 },
        { char: "え", startSeconds: 1.30, endSeconds: 1.45 },
        { char: "お", startSeconds: 1.45, endSeconds: 1.60 },
        { char: "か", startSeconds: 1.60, endSeconds: 1.80 },
      ],
    },
  };
  const segments = [{ text: "あいう" }, { text: "えおか" }];
  const measured = bubbleSegmentSpeechBoundaries(utterance, segments);
  assert.deepEqual(measured, [
    { startSeconds: 0.10, endSeconds: 0.55 },
    { startSeconds: 1.30, endSeconds: 1.80 },
  ]);

  // Without a timeline the caller must be told so it can fall back.
  assert.equal(bubbleSegmentSpeechBoundaries({ audio: {} }, segments), null);
});
