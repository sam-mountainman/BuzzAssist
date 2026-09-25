// doctor: Channel Pack の image.source が operator-file（運営者の画を取り込む）なら、画の有料 Media Job を
// 使わないので画の adapter を probe しない。声と BGM は従来どおり probe する。合成の Pack の記録だけを使い、
// ネットワークも有料 API も使わない。
import assert from "node:assert/strict";
import test from "node:test";

import { runHarnessDoctor } from "../scripts/harness-doctor.mjs";

function deterministicDoctorRuntime(overrides = {}) {
  const binary = (command) => ({ ok: true, command, args: [], version: "7.1.1" });
  return {
    ffmpegToolchain: { ok: true, ffmpeg: binary("ffmpeg"), ffprobe: binary("ffprobe") },
    runCommand: async (_command, args = []) => {
      if (args.includes("-encoders")) return { stdout: "libx264 aac pcm_s24le", stderr: "" };
      if (args.includes("-filters")) return { stdout: "scale crop overlay fps loudnorm aresample", stderr: "" };
      if (args.includes("-show_streams")) {
        return { stdout: JSON.stringify({ streams: [{ codec_type: "video" }, { codec_type: "audio" }] }), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    pythonRuntime: { ok: true, command: "python", args: [], version: "3.12.2" },
    voiceQualityProbe: async () => true,
    diskFreeBytes: async () => 64 * 1024 ** 3,
    svgRasterizerProbe: async () => ({ ok: true, backend: "chrome", detail: "fixture", fix: "" }),
    resolveProductionRoute: async () => ({
      command: "fixture-node",
      args: ["internal.mjs", "help"],
      cwd: "/fixture/deployment",
      label: "production/internal.mjs",
      mcpTool: "run_video_harness",
    }),
    ...overrides,
  };
}

const PAYLOAD_SHA256 = "c".repeat(64);
const evidence = {
  envelopeVersion: "buzzassist-channel-pack-envelope-v1",
  id: "narrated-operator-image-fixture",
  version: "1.0.0",
  harnessId: "narrated-story-video",
  payloadSha256: PAYLOAD_SHA256,
  fileCount: 2,
  signerKeyId: "operator-key",
  trustedPublicKeyId: "ed25519:trusted",
};

function runtimeMetadata({ operatorFile }) {
  return {
    version: "buzzassist-channel-pack-runtime-v1",
    harnessId: "narrated-story-video",
    payloadSha256: PAYLOAD_SHA256,
    configSha256: "d".repeat(64),
    imageModel: "fixture-image-model",
    ttsProvider: "fixture-voice",
    imageProvider: "fixture-image",
    imageAdapterVersion: "fixture-image-adapter-v1",
    ttsModel: "fixture-voice-model",
    ttsAdapterVersion: "fixture-voice-adapter-v1",
    musicProvider: "fixture-music",
    musicModel: "fixture-music-model",
    musicAdapterVersion: "fixture-music-adapter-v1",
    ...(operatorFile ? { imageSource: "operator-file" } : {}),
  };
}

async function doctor({ operatorFile, probe = null, mediaJobApiBase = undefined }) {
  const probed = [];
  const report = await runHarnessDoctor({
    harnessId: "narrated-story-video",
    job: { channelPackVerification: evidence },
    runtime: deterministicDoctorRuntime({
      channelPackRuntime: runtimeMetadata({ operatorFile }),
      ...(probe ? {
        mediaAdapterProbe: async (spec) => {
          probed.push(spec.kind);
          return probe(spec);
        },
      } : {}),
      ...(mediaJobApiBase !== undefined ? { mediaJobApiBase } : {}),
    }),
  });
  return { report, probed, check: (id) => report.checks.find((entry) => entry.id === id) };
}

test("operator-file の Pack では画の adapter を probe せず「使わない」とし、声と BGM は probe する", async () => {
  const { probed, check } = await doctor({ operatorFile: true, probe: async (spec) => ({ ok: true, status: "ready", ...spec }) });
  assert.deepEqual(probed.sort(), ["music.generation", "voice.synthesis"], "画の adapter は probe しない");
  const image = check("image-key");
  assert.equal(image.required, true);
  assert.equal(image.ok, true, image.detail);
  assert.equal(image.status, "not-used");
  assert.equal(image.host, "operator-file");
  assert.match(image.detail, /operator-file/u);
  assert.equal(check("tts-key").ok, true);
  assert.equal(check("music-key").ok, true);
});

test("operator-file の Pack でも、画の adapter が落ちていることで doctor は止まらない（声と BGM が落ちれば止まる）", async () => {
  const imageDown = await doctor({
    operatorFile: true,
    probe: async (spec) => (spec.kind === "image.generation"
      ? { ok: false, status: "unreachable", ...spec, detail: "must not be asked" }
      : { ok: true, status: "ready", ...spec }),
  });
  assert.equal(imageDown.check("image-key").ok, true);
  assert.equal(imageDown.report.blocking.includes("image-key"), false);

  const voiceDown = await doctor({
    operatorFile: true,
    probe: async (spec) => (spec.kind === "voice.synthesis"
      ? { ok: false, status: "unreachable", ...spec, detail: "fixture voice adapter disconnected" }
      : { ok: true, status: "ready", ...spec }),
  });
  assert.equal(voiceDown.check("tts-key").ok, false);
  assert.ok(voiceDown.report.blocking.includes("tts-key"));
  assert.equal(voiceDown.check("image-key").ok, true);
});

test("operator-file の Pack で Media Job の経路が無いとき、画は「使わない」のまま、声と BGM は route-missing で止まる", async () => {
  const { check, report, probed } = await doctor({ operatorFile: true, mediaJobApiBase: "" });
  assert.deepEqual(probed, []);
  assert.equal(check("image-key").ok, true);
  assert.equal(check("image-key").status, "not-used");
  assert.equal(check("tts-key").status, "route-missing");
  assert.equal(check("music-key").status, "route-missing");
  assert.ok(report.blocking.includes("tts-key"));
  assert.ok(report.blocking.includes("music-key"));
});

test("broker（既定）の Pack では従来どおり画の adapter を probe し、落ちていれば止まる", async () => {
  const ready = await doctor({ operatorFile: false, probe: async (spec) => ({ ok: true, status: "ready", ...spec }) });
  assert.deepEqual(ready.probed.sort(), ["image.generation", "music.generation", "voice.synthesis"]);
  assert.equal(ready.check("image-key").host, "buzzassist-media-job");
  const down = await doctor({
    operatorFile: false,
    probe: async (spec) => (spec.kind === "image.generation"
      ? { ok: false, status: "unreachable", ...spec, detail: "fixture image adapter disconnected" }
      : { ok: true, status: "ready", ...spec }),
  });
  assert.equal(down.check("image-key").ok, false);
  assert.ok(down.report.blocking.includes("image-key"));
});
