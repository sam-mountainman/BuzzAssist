#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createChannelPackEnvelope } from "../lib/channelPackEnvelope.mjs";
import { extractNarratedChannelPackRuntime } from "../lib/harnessChannelPackRuntime.mjs";
import { resolveFfmpegToolchain } from "../lib/harnessRuntimeResolver.mjs";
import {
  OPERATOR_REPLACEMENT_MARKER,
  filmBurnExpression,
  inspectNarratedBookendRenderGraphs,
  judgeBoundaryFrames,
  normalizeNarratedBookendsConfig,
  operatorReplacementSegments,
  packRelativePath,
  partitionNarratedStoryScript,
  planNarratedBookendProgram,
  renderOpeningPart,
  segmentFramePlan,
} from "../lib/narratedStoryBookends.mjs";
import { loadNarratedStoryChannelConfig } from "../lib/narratedStoryPipeline.mjs";
import { planOnlyPreflight } from "../lib/videoHarnessService.mjs";
import { bookendFixtureChannelConfig } from "./fixtures/narratedBookendFixture.mjs";

const toolchain = await resolveFfmpegToolchain();

function validBookends() {
  return structuredClone(bookendFixtureChannelConfig().bookends);
}

test("bookends config: a complete Pack declaration normalizes without blockers and keeps channel values out of Core", () => {
  const { config, blockers } = normalizeNarratedBookendsConfig(validBookends(), { render: { width: 320, height: 180 } });
  assert.deepEqual(blockers, []);
  assert.equal(config.enabled, true);
  assert.equal(config.opening.kind, "title-card");
  assert.equal(config.review.presenter.required, true);
  assert.equal(config.transitions.openingToStory.type, "film-burn");
  assert.deepEqual(config.transitions.openingToStory.leakColors, ["#ff8c2a", "#a0409c"]);
  // outgoing fade は宣言が無ければ転換の長さ（出る側を転換の終わりまでに 0 へ下げる）。
  assert.equal(config.transitions.storyToReview.outgoingFadeSeconds, 0.5);
  assert.deepEqual(normalizeNarratedBookendsConfig(undefined), { config: { enabled: false }, blockers: [] });
  assert.deepEqual(normalizeNarratedBookendsConfig({ enabled: false }).config, { enabled: false });
});

test("bookends config: missing channel values become blockers instead of Core defaults", () => {
  const source = validBookends();
  delete source.transitions.openingToStory.leakColors;
  delete source.transitions.storyToReview.leadInSeconds;
  source.transitions.storyToReview.type = "wipe";
  source.opening.text = "OP";
  delete source.opening.backgroundImage;
  delete source.opening.backgroundColor;
  source.review.presenter = { required: true, video: null };
  source.review.music = "../outside.wav";
  const { blockers } = normalizeNarratedBookendsConfig(source);
  for (const expected of [
    "bookends.transitions.openingToStory.leakColors",
    "bookends.transitions.storyToReview.leadInSeconds",
    "bookends.transitions.storyToReview.type",
    "bookends.opening.backgroundColor",
    "bookends.opening.fontFile-required",
    "bookends.opening.textColor",
    "bookends.review.presenter-media-required",
    "bookends.review.music-invalid-pack-path",
  ]) assert.ok(blockers.includes(expected), `${expected} must block: ${blockers.join(", ")}`);
  const hardCut = normalizeNarratedBookendsConfig({
    enabled: true,
    review: { scriptMarker: "---" },
    transitions: { storyToReview: { type: "hard-cut", durationSeconds: 0.4, leadInSeconds: 0.2 } },
  });
  assert.ok(hardCut.blockers.includes("bookends.transitions.storyToReview.durationSeconds"), "hard-cut has no effect duration");
  // 字幕なし lead-in は保証の一部なので 0 秒は受けない。
  const noLead = normalizeNarratedBookendsConfig({
    enabled: true,
    review: { scriptMarker: "---" },
    transitions: { storyToReview: { type: "hard-cut", leadInSeconds: 0 } },
  });
  assert.ok(noLead.blockers.includes("bookends.transitions.storyToReview.leadInSeconds"));
  assert.ok(normalizeNarratedBookendsConfig({ enabled: true }).blockers.includes("bookends.opening-or-review-required"));
});

test("Pack paths stay inside the verified payload", () => {
  assert.deepEqual(packRelativePath("assets/op.png"), ["assets", "op.png"]);
  for (const bad of ["/abs/op.png", "../op.png", "assets/../op.png", "assets\\op.png", "C:/op.png", "", "assets//op.png"]) {
    assert.equal(packRelativePath(bad), null, bad);
  }
});

test("loadNarratedStoryChannelConfig fails closed on missing Pack media, short film-burn and declared blockers", async () => {
  const dir = await mkdtemp(join(os.tmpdir(), "narrated-bookend-config-"));
  try {
    const source = bookendFixtureChannelConfig({ blockers: [{ id: "review-bed-not-received", what: "the review song has not been delivered" }] });
    source.bookends.transitions.openingToStory.durationSeconds = 0.2; // 24fps で 5 フレーム < 8
    await writeFile(join(dir, "narrated-story.json"), JSON.stringify(source), "utf8");
    const loaded = await loadNarratedStoryChannelConfig(dir);
    assert.equal(loaded.ok, false);
    for (const expected of [
      "bookends.opening.backgroundImage-missing",
      "bookends.opening.audio-missing",
      "bookends.review.presenter.video-missing",
      "bookends.review.music-missing",
      "bookends.transitions.openingToStory.durationSeconds-too-short-for-fps",
    ]) assert.ok(loaded.blockers.includes(expected), `${expected}: ${loaded.blockers.join(", ")}`);
    assert.deepEqual(loaded.config.declaredBlockers, ["review-bed-not-received"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the durable Job runtime extraction accepts the bookends schema and rejects unknown nested fields", async () => {
  const dir = await mkdtemp(join(os.tmpdir(), "narrated-bookend-runtime-"));
  try {
    const source = bookendFixtureChannelConfig({ blockers: [{ id: "x", what: "y" }] });
    const bytes = Buffer.from(JSON.stringify(source));
    await writeFile(join(dir, "narrated-story.json"), bytes);
    const evidence = { harnessId: "narrated-story-video", payloadSha256: createHash("sha256").update("payload").digest("hex") };
    const runtime = await extractNarratedChannelPackRuntime({ payloadDir: dir, evidence });
    assert.equal(runtime.imageModel, "fixture-image-v1");
    source.bookends.transitions.storyToReview.colour = "#ffffff";
    await writeFile(join(dir, "narrated-story.json"), JSON.stringify(source));
    await assert.rejects(extractNarratedChannelPackRuntime({ payloadDir: dir, evidence }), /unsupported fields: colour/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("script partition: the review section starts after exactly one Pack marker line", () => {
  const bookends = { enabled: true, review: { scriptMarker: "---感想---" } };
  const ok = partitionNarratedStoryScript("本編です。\n---感想---\n感想です。", bookends);
  assert.deepEqual(ok, { bodyText: "本編です。", reviewText: "感想です。", blockers: [] });
  assert.deepEqual(partitionNarratedStoryScript("本編です。", bookends).blockers, ["script-review-marker-missing"]);
  assert.deepEqual(partitionNarratedStoryScript("a\n---感想---\nb\n---感想---\nc", bookends).blockers, ["script-review-marker-duplicated"]);
  assert.deepEqual(partitionNarratedStoryScript("---感想---\n感想です。", bookends).blockers, ["script-story-section-empty"]);
  // bookends 無効なら台本全体が本編（従来どおり）。
  assert.equal(partitionNarratedStoryScript("a\n---感想---\nb").bodyText, "a\n---感想---\nb");
});

test("operator replacement markers are detected from the Core token and a Pack-declared token", () => {
  const segments = [
    { id: "s001", text: "本編の文です。" },
    { id: "r001", text: `${OPERATOR_REPLACEMENT_MARKER}実は私も同じ経験があります。` },
    { id: "r002", text: "〔要確認〕昔の話です。" },
  ];
  assert.deepEqual(operatorReplacementSegments(segments), ["r001"]);
  assert.deepEqual(operatorReplacementSegments(segments, { extraMarker: "〔要確認〕" }), ["r001", "r002"]);
});

test("program plan: frames never cut a part's voice, lead-in follows the effect, next narration starts at the lead end", () => {
  const plan = planNarratedBookendProgram({
    fps: 24,
    openingFrames: 36,
    story: [{ id: "s001", durationSeconds: 0.75 }, { id: "s002", durationSeconds: 0.781 }],
    review: [{ id: "r001", durationSeconds: 0.75 }],
    reviewPresenter: true,
    transitions: {
      openingToStory: { type: "film-burn", durationSeconds: 0.5, leadInSeconds: 0.25, outgoingFadeSeconds: 0.5, leakColors: ["#ffffff", "#000000"] },
      storyToReview: { type: "hard-cut", durationSeconds: 0, leadInSeconds: 0.25, outgoingFadeSeconds: 0 },
    },
  });
  const [opening, story, review] = plan.parts;
  const [toStory, toReview] = plan.boundaries;
  assert.equal(opening.frames, 36);
  assert.equal(toStory.effectStartFrame, 36);
  assert.equal(toStory.effectFrames, 12);
  assert.equal(toStory.leadFrames, 6);
  assert.equal(story.startFrame, 54);
  assert.equal(toStory.incomingStartSeconds, story.startSeconds);
  // 本編の声 1.531s → ceil(36.74) = 37 フレーム。映像が声より短くならない。
  assert.equal(story.frames, 37);
  assert.ok(story.frames / 24 >= 0.75 + 0.781);
  assert.equal(toReview.effectFrames, 0);
  assert.equal(review.startFrame, story.endFrame + 6);
  assert.equal(plan.segments.find((segment) => segment.id === "r001").camera, "presenter-video");
  assert.equal(plan.segments.find((segment) => segment.id === "s002").startSeconds, story.startSeconds + 0.75);
  assert.equal(plan.totalFrames, review.endFrame);
  assert.equal(plan.totalSamples, plan.totalFrames * 2000);
  assert.deepEqual(segmentFramePlan([0.4, 0.4, 0.41], 10).map((entry) => entry.frames), [4, 4, 5]);
});

test("film-burn is a procedural xfade expression that takes its colors from the Pack", () => {
  const expression = filmBurnExpression(["#ff8000", "#8000ff"]);
  assert.match(expression, /255\*\(1-ld\(2\)\)\+128\*ld\(2\)/u, "red channel mixes the two declared colors");
  assert.doesNotMatch(expression, /[,:]\s*$/u);
});

function frame(value) {
  return Buffer.alloc(64 * 36 * 3, value);
}

test("boundary frame judge: a declared film-burn needs both lobes and the white gate inside the window", () => {
  const boundary = { type: "film-burn", effectStartFrame: 10, effectFrames: 6, effectEndFrame: 16, incomingStartFrame: 18 };
  const outgoing = frame(80);
  const incoming = frame(160);
  const sequence = [outgoing, outgoing, frame(120), frame(200), frame(255), frame(210), frame(190), frame(170), incoming, incoming, incoming];
  const pass = judgeBoundaryFrames(boundary, sequence);
  assert.equal(pass.pass, true, pass.problems.join(", "));
  const frozen = [outgoing, outgoing, outgoing, outgoing, outgoing, outgoing, outgoing, outgoing, incoming, incoming, incoming];
  const removed = judgeBoundaryFrames(boundary, frozen);
  assert.equal(removed.pass, false);
  assert.ok(removed.problems.includes("transition-effect-not-observed"));
  assert.ok(removed.problems.includes("film-burn-white-gate-not-observed"));
  const early = judgeBoundaryFrames(boundary, [outgoing, frame(120), ...sequence.slice(2)]);
  assert.ok(early.problems.includes("transition-starts-before-declared-window"));
  const unavailable = judgeBoundaryFrames(boundary, sequence.slice(0, 4));
  assert.deepEqual(unavailable.problems, ["boundary-frames-unavailable"]);
});

test("bookend render-graph inspection rejects undeclared transitions and a mismatched boundary clip", () => {
  const plan = planNarratedBookendProgram({
    fps: 24,
    openingFrames: 24,
    story: [{ id: "s001", durationSeconds: 1 }],
    review: [],
    transitions: { openingToStory: { type: "fade-through-black", durationSeconds: 0.5, leadInSeconds: 0.25, outgoingFadeSeconds: 0.5 } },
  });
  const graphs = {
    openingVideo: { filterGraph: "[0:v]setsar=1,format=yuv420p[video]", inputCount: 1, outputMap: "[video]" },
    storyVideo: { filterGraph: "[0:v]format=yuv420p[v0];[v0]concat=n=1:v=1:a=0[video]", imageInputCount: 1, videoMap: "[video]" },
    "transition:openingToStory": { filterGraph: "[a][b]xfade=transition=fadeblack:duration=0.5:offset=0,format=yuv420p[video]", inputCount: 2, outputMap: "[video]" },
    voiceStem: { filterGraph: "[0:a]anull[a0];[a0]concat=n=1:v=0:a=1[story];[g0][story]concat=n=2:v=0:a=1[voice]", inputCount: 1, outputMap: "[voice]" },
    bgmStem: { filterGraph: "[0:a]anull[bed]", inputCount: 1, outputMap: "[bed]" },
    masterAudio: { filterGraph: "[voice][bed]amix=inputs=2[master]", inputCount: 2, outputMap: "[master]" },
    preview: { filterGraph: "[0:v][1:v][2:v]concat=n=3:v=1:a=0[video]", imageInputCount: 3, videoMap: "[video]", audioMap: "3:a:0" },
  };
  const clean = inspectNarratedBookendRenderGraphs(graphs, plan);
  assert.deepEqual(clean.problems, []);
  assert.equal(clean.parentAudioMapped, true);
  assert.equal(clean.noWholeProgramAcrossfade, true);
  const sneaky = inspectNarratedBookendRenderGraphs({
    ...graphs,
    storyVideo: { ...graphs.storyVideo, filterGraph: `${graphs.storyVideo.filterGraph};[x][y]xfade=duration=1` },
  }, plan);
  assert.ok(sneaky.problems.includes("story-scene-transitions-not-owned-by-parent"));
  const wrongType = inspectNarratedBookendRenderGraphs({
    ...graphs,
    "transition:openingToStory": { ...graphs["transition:openingToStory"], filterGraph: "[0:v]format=yuv420p[video]" },
  }, plan);
  assert.ok(wrongType.problems.includes("transition-graph-mismatch:openingToStory"));
  const acrossfade = inspectNarratedBookendRenderGraphs({
    ...graphs,
    bgmStem: { ...graphs.bgmStem, filterGraph: "[0:a][1:a]acrossfade=d=1[bed]" },
  }, plan);
  assert.deepEqual(acrossfade.acrossfadeGraphs, ["bgmStem"]);
  assert.equal(acrossfade.noWholeProgramAcrossfade, false);
});

// 書体は Pack が供給する。CI の OS に依らないよう、見つかる書体があるときだけ drawtext を実際に通す。
const FONT_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "C:\\Windows\\Fonts\\arial.ttf",
];
const fontPath = FONT_CANDIDATES.find((candidate) => existsSync(candidate)) || "";

test("title card renders the Pack text with the Pack font through a relative textfile", {
  skip: !toolchain.ok ? "ffmpeg is unavailable" : (!fontPath ? "no font available on this host" : false),
}, async () => {
  const dir = await mkdtemp(join(os.tmpdir(), "narrated-title-card-"));
  try {
    await mkdir(join(dir, "work"));
    const result = await renderOpeningPart({
      ffmpeg: toolchain.ffmpeg,
      ffprobe: toolchain.ffprobe,
      opening: { kind: "title-card", durationSeconds: 0.5, text: "Title: 100% 'quoted'\n2nd line", textColor: "#ffffff", fontSize: 18, backgroundColor: "#203040" },
      media: { "opening.fontFile": fontPath },
      config: { render: { width: 320, height: 180, fps: 24 } },
      workDir: join(dir, "work"),
      outputPath: join(dir, "opening.mp4"),
    });
    assert.equal(result.frames, 12);
    assert.match(result.graph.filterGraph, /drawtext=fontfile=opening-font\.ttf:textfile=opening-card\.txt:expansion=none:/u);
    assert.doesNotMatch(result.graph.filterGraph, /quoted/u, "the card text never enters the filter graph");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("plan-only preflight verifies the signed Pack and lists every stop reason without paid calls", async () => {
  const dir = await mkdtemp(join(os.tmpdir(), "narrated-plan-preflight-"));
  try {
    const source = join(dir, "pack-source");
    await mkdir(source);
    await writeFile(join(source, "narrated-story.json"), JSON.stringify(bookendFixtureChannelConfig({
      presenter: null,
      blockers: [{ id: "review-bed-not-received", what: "the review song has not been delivered" }],
    })), "utf8");
    const signer = generateKeyPairSync("ed25519");
    const privateKeyPem = signer.privateKey.export({ type: "pkcs8", format: "pem" });
    const publicKeyPem = signer.publicKey.export({ type: "spki", format: "pem" });
    const bundle = join(dir, "signed");
    await createChannelPackEnvelope({
      sourceDir: source,
      outputDir: bundle,
      id: "fixture-narrated-pack",
      version: "1.0.0",
      harnessId: "narrated-story-video",
      payloadKind: "narrated-story-channel-pack",
      privateKeyPem,
      publicKeyPem,
    });
    const scriptPath = join(dir, "script.txt");
    await writeFile(scriptPath, "本編です。\n---感想---\n[[operator-replace]]実は私もそうでした。\n", "utf8");
    const job = { harness: { id: "narrated-story-video" } };
    const result = await planOnlyPreflight({ job, scriptPath, channelPackPath: bundle, env: { BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY_PEM: publicKeyPem } });
    assert.equal(result.ok, false);
    assert.equal(result.paidCallsAttempted, false);
    for (const expected of [
      "channel-pack-config-required:bookends.review.presenter-media-required",
      "channel-pack-config-required:bookends.opening.backgroundImage-missing",
      "channel-pack-declared-blocker:review-bed-not-received",
      "operator-replacement-required:r001",
    ]) assert.ok(result.blockers.includes(expected), `${expected}: ${result.blockers.join(", ")}`);
    assert.deepEqual(result.segments, { story: 1, review: 1 });
    // 信頼していない鍵で署名された Pack は、中身を読む前に止める。
    const stranger = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
    const untrusted = await planOnlyPreflight({ job, scriptPath, channelPackPath: bundle, env: { BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY_PEM: stranger } });
    assert.deepEqual(untrusted.blockers, ["channel-pack-unverified"]);
    // narrated 以外のハーネスは検査を持たない（結果に載せない）。
    assert.equal(await planOnlyPreflight({ job: { harness: { id: "koya-manga-video" } }, scriptPath, channelPackPath: bundle }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
