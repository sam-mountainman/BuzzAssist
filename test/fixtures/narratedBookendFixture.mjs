/**
 * bookends（OP → 本編 → 感想）の合成 fixture。外部素材・ネットワーク・有料 API を使わず、
 * FFmpeg の lavfi だけで絵・声・曲・人物素材を作り、in-process の fixture adapter で
 * narrated-story の公開 Core を実際に走らせる。
 *
 * 閾値の較正（lib/narratedStoryBookends.mjs の定数コメント）はこの fixture の実測値に基づく。
 * 声は TTS に近い形（先頭 30ms 無音 → 0.6s の発話相当 → 0.2s 減衰 → 120ms 無音）にしてあり、
 * `truncatedLastStoryVoice` は本編最後の声を「発話の途中で切れたテイク」（減衰も無音も無い）に差し替える。
 */

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { paidMediaRequestIdentity } from "../../lib/paidMediaJobBroker.mjs";

const execFile = promisify(execFileCallback);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function ff(toolchain, args) {
  return execFile(toolchain.ffmpeg.command, [...(toolchain.ffmpeg.args || []), "-hide_banner", "-loglevel", "error", "-y", ...args], {
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

export const BOOKEND_FIXTURE_SCRIPT = [
  "最初の物語です。",
  "次の場面です。",
  "終わりの場面です。",
  "---感想---",
  "感想の一文目です。",
  "感想の二文目です。",
].join("\n");

export async function createBookendFixtureMedia(root, toolchain) {
  await mkdir(root, { recursive: true });
  const paths = {
    image: join(root, "fixture-scene.png"),
    voice: join(root, "fixture-voice.wav"),
    truncatedVoice: join(root, "fixture-voice-truncated.wav"),
    music: join(root, "fixture-music.wav"),
  };
  await ff(toolchain, ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=1:duration=0.1", "-frames:v", "1", paths.image]);
  await ff(toolchain, [
    "-f", "lavfi", "-i", "sine=frequency=440:duration=0.6:sample_rate=48000",
    "-af", "volume=0.2,afade=t=in:d=0.02,afade=t=out:st=0.4:d=0.2,adelay=30,apad=pad_dur=0.12",
    "-ac", "1", "-c:a", "pcm_s16le", paths.voice,
  ]);
  await ff(toolchain, [
    "-f", "lavfi", "-i", "sine=frequency=440:duration=0.75:sample_rate=48000",
    "-af", "volume=0.2,adelay=30", "-ac", "1", "-c:a", "pcm_s16le", paths.truncatedVoice,
  ]);
  await ff(toolchain, [
    "-f", "lavfi", "-i", "sine=frequency=196:duration=3:sample_rate=48000",
    "-af", "volume=0.2", "-ac", "2", "-c:a", "pcm_s16le", paths.music,
  ]);
  return {
    image: await readFile(paths.image),
    voice: await readFile(paths.voice),
    truncatedVoice: await readFile(paths.truncatedVoice),
    music: await readFile(paths.music),
  };
}

/** Pack が供給する bookend 素材（OP 背景・OP の音・人物素材・感想の曲）。 */
export async function writeBookendPackAssets(payloadDir, toolchain) {
  const assets = join(payloadDir, "assets");
  await mkdir(assets, { recursive: true });
  await ff(toolchain, ["-f", "lavfi", "-i", "smptebars=size=320x180:rate=1:duration=0.1", "-frames:v", "1", join(assets, "opening-background.png")]);
  await ff(toolchain, [
    "-f", "lavfi", "-i", "sine=frequency=262:duration=4:sample_rate=48000",
    "-af", "volume=0.05", "-ac", "2", "-c:a", "pcm_s16le", join(assets, "opening-audio.wav"),
  ]);
  await ff(toolchain, [
    "-f", "lavfi", "-i", "testsrc=size=240x180:rate=24:duration=2",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", join(assets, "presenter.mp4"),
  ]);
  await ff(toolchain, [
    "-f", "lavfi", "-i", "sine=frequency=330:duration=3:sample_rate=48000",
    "-af", "volume=0.2", "-ac", "2", "-c:a", "pcm_s16le", join(assets, "review-bed.wav"),
  ]);
}

export function bookendFixtureChannelConfig({ storyToReviewType = "film-burn", presenter = "assets/presenter.mp4", blockers } = {}) {
  return {
    version: "fixture-bookend-channel-pack-v1",
    runtime: { imageModel: "fixture-image-v1", ttsProvider: "fixture-voice" },
    image: { provider: "fixture-image", model: "fixture-image-v1", adapterVersion: "fixture-image-adapter-v1", stylePrompt: "flat fixture illustration" },
    voice: { provider: "fixture-voice", model: "fixture-voice-v1", adapterVersion: "fixture-voice-adapter-v1", voiceId: "fixture-ja", speed: 1 },
    music: { provider: "fixture-music", model: "fixture-music-v1", adapterVersion: "fixture-music-adapter-v1", prompt: "quiet fixture bed", gain: 0.03 },
    render: { width: 320, height: 180, fps: 24 },
    concurrency: 2,
    bookends: {
      enabled: true,
      opening: {
        kind: "title-card",
        durationSeconds: 1.5,
        backgroundImage: "assets/opening-background.png",
        backgroundColor: "#101820",
        audio: "assets/opening-audio.wav",
      },
      review: {
        scriptMarker: "---感想---",
        presenter: { required: true, video: presenter, backgroundColor: "#202020" },
        music: "assets/review-bed.wav",
        musicGain: 0.03,
      },
      transitions: {
        openingToStory: { type: "film-burn", durationSeconds: 0.5, leadInSeconds: 0.25, leakColors: ["#ff8c2a", "#a0409c"] },
        storyToReview: {
          type: storyToReviewType,
          durationSeconds: storyToReviewType === "hard-cut" ? 0 : 0.5,
          leadInSeconds: 0.25,
          ...(storyToReviewType === "film-burn" ? { leakColors: ["#ff8c2a", "#a0409c"] } : {}),
        },
      },
    },
    ...(blockers ? { blockers } : {}),
  };
}

export async function writeBookendPack(payloadDir, toolchain, options = {}) {
  await mkdir(payloadDir, { recursive: true });
  await writeBookendPackAssets(payloadDir, toolchain);
  await writeFile(join(payloadDir, "narrated-story.json"), `${JSON.stringify(bookendFixtureChannelConfig(options), null, 2)}\n`, "utf8");
}

/** in-process の fixture adapter（有料 API もネットワークも使わない）。 */
export function bookendFixtureAdapters(fixture, { truncatedLastStoryVoice = false, lastStoryTextHash = "" } = {}) {
  const calls = { generation: 0, probe: 0, kinds: [] };
  const mediaJobProbe = async (adapter) => {
    calls.probe += 1;
    return { ok: true, status: "ready", ...adapter, httpStatus: 200, serverVersion: "fixture-media-server-v1", detail: "in-process fixture adapter" };
  };
  const mediaJobRunner = async (spec) => {
    calls.generation += 1;
    calls.kinds.push(spec.kind);
    const identity = paidMediaRequestIdentity(spec);
    let bytes = spec.kind === "image.generation" ? fixture.image : (spec.kind === "voice.synthesis" ? fixture.voice : fixture.music);
    if (truncatedLastStoryVoice && spec.kind === "voice.synthesis" && sha256(spec.input?.text || "") === lastStoryTextHash) {
      bytes = fixture.truncatedVoice;
    }
    const ordinal = calls.generation;
    return {
      bytes,
      receipt: {
        version: "fixture-paid-media-receipt-v1",
        jobId: `fixture-job-${identity.identityHash.slice(0, 20)}`,
        requestKey: identity.requestKey,
        status: "completed",
        kind: spec.kind,
        provider: spec.provider,
        adapterVersion: spec.adapterVersion,
        providerJobId: `fixture-provider-job-${ordinal}`,
        model: spec.model,
        voiceId: spec.voiceId || "",
        inputHash: identity.inputHash,
        identityHash: identity.identityHash,
        reservation: { reservationId: `fixture-reservation-${ordinal}`, status: "captured", requestedAt: "2026-09-24T00:00:00.000Z", unit: spec.reservation?.unit || "", estimatedCost: 0, currency: "USD" },
        usage: { seconds: spec.kind === "image.generation" ? null : 0.75, units: 1, cost: 0, currency: "USD", freeRegeneration: false },
        artifact: { sha256: sha256(bytes), mimeType: spec.output?.format, bytes: bytes.length },
        attempts: { total: 1, retries: [] },
      },
    };
  };
  return { calls, mediaJobProbe, mediaJobRunner };
}

export const fixtureSha256 = sha256;

/**
 * 声の品質ゲートの合成（python の QA 実行系を使わない）。全テイクを合格にする。本物のゲートの判定は
 * test/narratedStoryVoiceQuality.test.mjs と test/voiceQualityGate.test.mjs が見る。
 */
export const passingVoiceQualityGate = Object.freeze({
  available: async () => true,
  audit: async ({ checks }) => ({
    checks: checks.map((check) => ({
      id: check.id,
      type: check.type,
      status: "pass",
      metrics: { utmos: 4.2, cer: 0.01, durationSec: 0.75 },
      problems: [],
      warnings: [],
      unavailable: [],
    })),
  }),
});
