import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CHANNEL_PACK_RUNTIME_VERSION,
  channelPackRuntimeAdapterSpecs,
  extractNarratedChannelPackRuntime,
  validateChannelPackRuntime,
} from "../lib/harnessChannelPackRuntime.mjs";

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
