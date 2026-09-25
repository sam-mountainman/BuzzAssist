import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CHANNEL_PACK_RUNTIME_VERSION,
  channelPackRuntimeAdapterSpecs,
  extractNarratedChannelPackRuntime,
  readNarratedThumbnailSection,
  validateChannelPackRuntime,
} from "../lib/harnessChannelPackRuntime.mjs";
import { thumbnailRulesFromChannelSection } from "../lib/thumbnailPlan.mjs";

const payloadSha256 = "a".repeat(64);

function narratedConfig(overrides = {}) {
  return {
    version: "fixture-v1",
    runtime: { imageModel: "image-model-v1", ttsProvider: "fish-audio" },
    image: { provider: "buzzassist", model: "image-model-v1", adapterVersion: "image-adapter-v1", stylePrompt: "soft light" },
    voice: { provider: "fish-audio", model: "s2-pro", adapterVersion: "fish-audio-tts-server-v1", voiceId: "public-voice-id", speed: 1 },
    music: { provider: "buzzassist", model: "music-v1", adapterVersion: "music-adapter-v1", prompt: "quiet", gain: 0.04 },
    render: { width: 1280, height: 720, fps: 24 },
    concurrency: 4,
    bookends: { enabled: false },
    ...overrides,
  };
}

test("signed narrated runtime metadata persists only exact non-secret adapter identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "narrated-channel-runtime-"));
  try {
    await writeFile(join(root, "narrated-story.json"), `${JSON.stringify(narratedConfig())}\n`);
    const runtime = await extractNarratedChannelPackRuntime({
      payloadDir: root,
      evidence: { harnessId: "narrated-story-video", payloadSha256 },
    });
    assert.equal(runtime.version, CHANNEL_PACK_RUNTIME_VERSION);
    assert.equal(runtime.imageModel, "image-model-v1");
    assert.equal(runtime.ttsProvider, "fish-audio");
    assert.equal(runtime.imageProvider, "buzzassist");
    assert.equal(runtime.ttsModel, "s2-pro");
    assert.equal(runtime.musicProvider, "buzzassist");
    assert.equal(runtime.musicModel, "music-v1");
    assert.equal(JSON.stringify(runtime).includes("stylePrompt"), false);
    assert.equal(JSON.stringify(runtime).includes("voiceId"), false);
    assert.deepEqual(channelPackRuntimeAdapterSpecs(runtime, {
      harnessId: "narrated-story-video",
      payloadSha256,
    }), {
      image: { kind: "image.generation", provider: "buzzassist", model: "image-model-v1", adapterVersion: "image-adapter-v1" },
      tts: { kind: "voice.synthesis", provider: "fish-audio", model: "s2-pro", adapterVersion: "fish-audio-tts-server-v1" },
      music: { kind: "music.generation", provider: "buzzassist", model: "music-v1", adapterVersion: "music-adapter-v1" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("narrated runtime metadata rejects secret, arbitrary, mismatched and unbound fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "narrated-channel-runtime-invalid-"));
  try {
    const path = join(root, "narrated-story.json");
    await writeFile(path, JSON.stringify(narratedConfig({ apiKey: "must-never-persist" })));
    await assert.rejects(
      () => extractNarratedChannelPackRuntime({ payloadDir: root, evidence: { harnessId: "narrated-story-video", payloadSha256 } }),
      /forbidden/u,
    );
    await writeFile(path, JSON.stringify(narratedConfig({ unexpected: true })));
    await assert.rejects(
      () => extractNarratedChannelPackRuntime({ payloadDir: root, evidence: { harnessId: "narrated-story-video", payloadSha256 } }),
      /unsupported fields/u,
    );
    await writeFile(path, JSON.stringify(narratedConfig({ runtime: { imageModel: "wrong", ttsProvider: "fish-audio" } })));
    await assert.rejects(
      () => extractNarratedChannelPackRuntime({ payloadDir: root, evidence: { harnessId: "narrated-story-video", payloadSha256 } }),
      /imageModel must equal/u,
    );
    assert.throws(
      () => validateChannelPackRuntime({
        version: CHANNEL_PACK_RUNTIME_VERSION,
        harnessId: "narrated-story-video",
        payloadSha256,
        configSha256: "b".repeat(64),
        imageModel: "image-model-v1",
        ttsProvider: "fish-audio",
        imageProvider: "buzzassist",
        imageAdapterVersion: "image-adapter-v1",
        ttsModel: "s2-pro",
        ttsAdapterVersion: "fish-audio-tts-server-v1",
        musicProvider: "buzzassist",
        musicModel: "music-v1",
        musicAdapterVersion: "music-adapter-v1",
      }, { harnessId: "narrated-story-video", payloadSha256: "c".repeat(64) }),
      /payload SHA-256/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// サムネの決まり（任意の thumbnail 節）。値はすべて合成。
function thumbnailSection(overrides = {}) {
  return {
    status: "synthetic-approved",
    rules: { decidedSize: { width: 320, height: 180 }, brandTokens: { bandColor: "PENDING_HUMAN_APPROVAL" } },
    layouts: { single: { panels: 1, default: true } },
    text: {
      band: { lines: 2, maxCharactersPerLine: 12 },
      speechBubble: { lines: 2, maxCharactersPerLine: 8, maximumPerPanel: 1 },
      forbiddenTerms: [{ text: "synthetic-brand", kind: "brand" }],
      approval: "when-text",
    },
    approvedReferences: { sha256: ["b".repeat(64)], characterRegistry: true },
    ...overrides,
  };
}

test("narrated-story.json の thumbnail 節は任意で、runtime metadata には入らず、読み口から形を検査して返す", async () => {
  const root = await mkdtemp(join(tmpdir(), "narrated-thumbnail-section-"));
  try {
    const path = join(root, "narrated-story.json");
    await writeFile(path, `${JSON.stringify(narratedConfig({ thumbnail: thumbnailSection() }))}\n`);
    const runtime = await extractNarratedChannelPackRuntime({ payloadDir: root, evidence: { harnessId: "narrated-story-video", payloadSha256 } });
    assert.equal(JSON.stringify(runtime).includes("thumbnail"), false, "サムネは Job の runtime metadata に載せない");
    const fromPayload = await readNarratedThumbnailSection({ payloadDir: root });
    assert.deepEqual(fromPayload.thumbnail, thumbnailSection());
    assert.equal(fromPayload.configSha256, runtime.configSha256);
    assert.equal(fromPayload.configPath, path);
    const fromFile = await readNarratedThumbnailSection({ configPath: path });
    assert.deepEqual(fromFile.thumbnail, fromPayload.thumbnail);
    const rules = thumbnailRulesFromChannelSection(fromFile.thumbnail, { harnessId: "narrated-story-video" });
    assert.equal(rules.harnessId, "narrated-story-video");
    assert.deepEqual(rules.brandTokens, [{ id: "bandColor", value: "PENDING_HUMAN_APPROVAL" }]);

    await writeFile(path, JSON.stringify(narratedConfig()));
    assert.equal((await readNarratedThumbnailSection({ payloadDir: root })).thumbnail, null, "節が無い Pack は null");

    for (const [section, pattern] of [
      [thumbnailSection({ rules: { skipChecks: true } }), /thumbnail\.rules contains unsupported fields: skipChecks/u],
      [thumbnailSection({ text: { band: { lines: 2, maxCharactersPerLine: 12, fontFile: "x.ttf" } } }), /thumbnail\.text\.band contains unsupported fields: fontFile/u],
      [thumbnailSection({ layouts: { single: { panels: 1, crop: "center" } } }), /thumbnail\.layouts\.single contains unsupported fields: crop/u],
      [thumbnailSection({ approvedReferences: { sha256: [], paths: ["a.png"] } }), /approvedReferences contains unsupported fields: paths/u],
      [thumbnailSection({ rules: { brandTokens: { bandColor: 3 } } }), /brandTokens\.bandColor must be a string/u],
      [thumbnailSection({ rules: { brandTokens: { accessToken: "x" } } }), /forbidden/u],
      [thumbnailSection({ extra: true }), /thumbnail contains unsupported fields: extra/u],
    ]) {
      await writeFile(path, JSON.stringify(narratedConfig({ thumbnail: section })));
      await assert.rejects(() => readNarratedThumbnailSection({ payloadDir: root }), pattern);
      await assert.rejects(() => extractNarratedChannelPackRuntime({ payloadDir: root, evidence: { harnessId: "narrated-story-video", payloadSha256 } }), pattern);
    }
    await assert.rejects(() => readNarratedThumbnailSection({}), /exactly one/u);
    await assert.rejects(() => readNarratedThumbnailSection({ payloadDir: root, configPath: path }), /exactly one/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
