// 選択カットの動画差し替え工程のテスト。
//
// 有料生成は一度も呼ばない。生成関数は差し替え可能にしてあり、ここでは
// ffmpeg で開始フレームから作る偽クリップを返すモックを渡す。
// 実レンダーと実MP4監査は 640x360 の合成エピソードで行う（外部ツールが
// 無い環境では理由を付けて skip する）。

import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";

import {
  CutVideoSubstitutionBlockedError,
  assertCutVideoSubstitutionsReadyForRender,
  auditCutVideoSubstitutions,
  auditSubstitutedCutReviewCoverage,
  cutVideoSubstitutionPaths,
  runCutVideoSubstitutions,
  verifyCutVideoSubstitutionBindings,
} from "../lib/mangaCutVideoSubstitution.mjs";
import {
  appliedCutVideoBinding,
  buildCutVideoSubstitutionPrompt,
  cutVideoContentIdentity,
  cutVideoRequestIdentity,
  evaluateCutVideoSubstitutionEligibility,
  validateCutVideoSubstitutionContract,
} from "../lib/mangaCutVideoSubstitutionPolicy.mjs";
import { createKoyaRenderedCameraPlan } from "../lib/koyaRenderedCameraAudit.mjs";
import {
  resolveKoyaMangaProductionContract,
  validateKoyaMangaProductionContract,
} from "../lib/koyaMangaProductionContract.mjs";
import {
  assertKoyaFullPreflight,
  runKoyaMangaFullProduction,
  substituteKoyaMangaCutVideos,
} from "../lib/koyaMangaProduction.mjs";
import { createKoyaOuterJobBinding } from "../lib/koyaOuterJobBinding.mjs";
import { renderCutInputHash, renderEpisodeVideo } from "../lib/mangaVideoPipeline.mjs";
import { imageToVideoDurationOptions } from "../lib/mediaGeneration.mjs";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = join(root, "config/koya-manga-production-contract.json");

function toolWorks(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0;
}

const hasFfmpeg = toolWorks("ffmpeg", ["-version"]) && toolWorks("ffprobe", ["-version"]);
const hasPythonCv = toolWorks("python3", ["-c", "import cv2, numpy"]);
// 監査は -l jpn+eng で読む。本体があっても言語データが欠けていれば、監査は
// 「文字の検出器が無い」で落ちるので、起動できるかではなく両方の言語で判定する。
const hasTesseract = (() => {
  const result = spawnSync("tesseract", ["--list-langs"], { encoding: "utf8" });
  const langs = `${result.stdout || ""}\n${result.stderr || ""}`.split(/\r?\n/u).map((line) => line.trim());
  return result.status === 0 && langs.includes("jpn") && langs.includes("eng");
})();
const mediaSkip = hasFfmpeg ? false : "ffmpeg/ffprobe が無い";
const auditSkip = !hasFfmpeg ? "ffmpeg/ffprobe が無い"
  : !hasPythonCv ? "python3 + OpenCV が無い"
  : !hasTesseract ? "tesseract（文字混入の検出器、jpn+eng）が無い"
  : false;

async function baseContract() {
  return JSON.parse(await readFile(contractPath, "utf8"));
}

async function markedContract(cuts = [{ cutId: "cut-01", motionPrompt: "slow drifting light over the scene", reason: "opening beat" }], model = "kling-v2-6") {
  const contract = await baseContract();
  contract.videoSubstitution.model = model;
  contract.videoSubstitution.cuts = cuts;
  return contract;
}

// --- 小さな RGBA PNG 書き出し（テスト用の吹き出しラスタ。Chrome を起動させない） ---
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
async function writeRgbaPng(path, width, height, opaqueRect) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x += 1) {
      const inside = opaqueRect && x >= opaqueRect.x && x < opaqueRect.x + opaqueRect.width
        && y >= opaqueRect.y && y < opaqueRect.y + opaqueRect.height;
      if (inside) row.fill(255, 1 + x * 4, 1 + x * 4 + 4);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  await writeFile(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]));
}

async function ff(args) {
  await execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { maxBuffer: 64 * 1024 * 1024 });
}

const WIDTH = 640;
const HEIGHT = 360;
const PULLOUT = { cameraMode: "pullout-only", zoomStart: 1.3, zoomEnd: 1.0, focusX: 0.4, focusY: 0.5, focusXEnd: 0.4, focusYEnd: 0.5 };

/**
 * 2カットの合成エピソード。cut-01 に保護領域（顔）を左寄りに、
 * 吹き出しを右上に置く。cut-02 は静止画のまま。
 */
async function buildEpisode({ withMedia = true, thoughtInCut1 = false } = {}) {
  const projectDir = await mkdtemp(join(tmpdir(), "cut-video-substitution-"));
  const canvasDir = join(projectDir, "canvas");
  const episodeDir = join(canvasDir, "manga-videos", "synthetic-ep");
  const assetDir = join(canvasDir, "assets", "synthetic-ep");
  await mkdir(join(episodeDir, ".render-work"), { recursive: true });
  await mkdir(assetDir, { recursive: true });
  const stills = [join(assetDir, "cut-01.png"), join(assetDir, "cut-02.png")];
  const wavs = [join(assetDir, "u1.wav"), join(assetDir, "u2.wav")];
  const svgs = [join(episodeDir, "u1.svg"), join(episodeDir, "u2.svg")];
  if (withMedia) {
    await ff(["-f", "lavfi", "-i", `mandelbrot=size=${WIDTH}x${HEIGHT}`, "-frames:v", "1", "-update", "1", stills[0]]);
    await ff(["-f", "lavfi", "-i", `cellauto=size=${WIDTH}x${HEIGHT}:rule=110`, "-frames:v", "1", "-update", "1", stills[1]]);
    for (const wav of wavs) await ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=1.2", "-ar", "48000", "-ac", "1", wav]);
  } else {
    for (const path of [...stills, ...wavs]) await writeFile(path, `placeholder ${path}`);
  }
  for (const svg of svgs) await writeFile(svg, "<svg xmlns='http://www.w3.org/2000/svg'/>");
  const past = new Date(Date.now() - 60_000);
  for (const svg of svgs) await utimes(svg, past, past);
  await writeRgbaPng(join(episodeDir, ".render-work", "u1.png"), WIDTH, HEIGHT, { x: 500, y: 20, width: 100, height: 160 });
  await writeRgbaPng(join(episodeDir, ".render-work", "u2.png"), WIDTH, HEIGHT, { x: 40, y: 20, width: 100, height: 160 });
  const manifest = {
    id: "synthetic-ep",
    status: "timed",
    defaultVoiceId: "voice-hero",
    video: { width: WIDTH, height: HEIGHT, fps: 30, cameraOversample: 1, normalizeMasterAudio: false, encodePreset: "ultrafast" },
    production: { qualityHarness: { hardGates: ["episode-structure", "utterance-coverage"] } },
    metrics: { videoDurationSeconds: 4 },
    cuts: ["cut-01", "cut-02"].map((id, index) => ({
      id,
      imagePath: stills[index],
      utteranceIds: [`u${index + 1}`],
      motion: "pullout-only",
      camera: PULLOUT,
      cameraSequence: [{
        id: `${id}-shot-1`,
        imagePath: stills[index],
        utteranceIds: [`u${index + 1}`],
        motion: "pullout-only",
        cameraMode: "pullout-only",
        camera: PULLOUT,
        sourceAvoidRegions: index === 0
          ? [{ id: "hero-face", kind: "face", hardProtection: true, x: 0.3, y: 0.3, width: 0.1, height: 0.2 }]
          : [],
      }],
      timing: { startSeconds: index * 2, durationSeconds: 2 },
    })),
    utterances: [0, 1].map((index) => ({
      id: `u${index + 1}`,
      cutId: `cut-0${index + 1}`,
      speakerId: "hero",
      text: "テストの台詞",
      preset: index === 0 && thoughtInCut1 ? "thought" : "speech",
      voiceId: "voice-hero",
      overlayPath: svgs[index],
      audio: { filePath: wavs[index], durationSeconds: 1.2, inputHash: `audio-${index}` },
      timing: {
        startSeconds: index * 2 + 0.3,
        audioStartSeconds: index * 2 + 0.3,
        bubbleStartSeconds: index * 2 + 0.3,
        bubbleEndSeconds: index * 2 + 1.6,
        audioStartInCutSeconds: 0.3,
        bubbleStartInCutSeconds: 0.3,
        bubbleEndInCutSeconds: 1.6,
      },
    })),
  };
  const manifestPath = join(episodeDir, "episode-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { projectDir, canvasDir, episodeDir, manifestPath, stills };
}

/** 開始フレームからゆっくり寄る偽クリップ（有料生成の代わり）。 */
function mockGenerator({ variant = "motion", calls = [], ledgerPath = "", fontFile = "" } = {}) {
  return async (input) => {
    calls.push({ ...input, ledgerAtCall: ledgerPath ? JSON.parse(await readFile(ledgerPath, "utf8")) : null });
    if (variant === "throws") throw new Error("provider said no (HTTP status unknown) key=sk-test-secret");
    const out = join(dirname(input.startFramePath), `mock-${calls.length}.mp4`);
    const source = variant === "other-image"
      ? ["-f", "lavfi", "-i", "color=c=0x2266aa:s=854x480"]
      : ["-loop", "1", "-i", input.startFramePath];
    const motion = variant === "static"
      ? "scale=854:480"
      : "scale=854:480,zoompan=z='1+0.002*on':d=1:s=854x480:fps=24";
    const text = variant === "text"
      ? `,drawtext=fontfile='${fontFile}':text='SALE 2026':fontsize=64:fontcolor=black:box=1:boxcolor=white:x=40:y=260`
      : "";
    await ff([...source, "-vf", `${motion}${text},format=yuv420p`, "-r", "24", "-t", String(input.duration), "-c:v", "libx264", "-preset", "ultrafast", out]);
    return {
      buffer: await readFile(out),
      mimeType: "video/mp4",
      model: variant === "wrong-model" ? "grok-imagine-video-hermes" : input.model,
      fileName: "clip.mp4",
      source: "https://provider.example/clip.mp4",
    };
  };
}

function findFontFile() {
  for (const candidate of [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "C:/Windows/Fonts/arial.ttf",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

// ---------------------------------------------------------------------------
// 契約

test("contract ships the substitution stage switched off with a hard cap of two cuts", async () => {
  const contract = await baseContract();
  assert.deepEqual(contract.videoSubstitution.cuts, []);
  assert.equal(contract.videoSubstitution.maximumCutsPerEpisode, 2);
  assert.equal(contract.videoSubstitution.requireOperatorPaidConfirmation, true);
  assert.ok(contract.requiredAudits.includes("video-substitution"));
  assert.equal(validateKoyaMangaProductionContract(contract).pass, true);
});

test("contract rejects a third cut, a raised cap, an unnamed or unlisted model, and lip-sync or text prompts", async () => {
  const failing = async (mutate, pattern) => {
    const contract = await baseContract();
    mutate(contract.videoSubstitution);
    const result = validateKoyaMangaProductionContract(contract);
    assert.equal(result.pass, false);
    assert.match(JSON.stringify(result.failures), pattern);
  };
  const cut = (cutId, motionPrompt = "a gentle breeze moves the hair") => ({ cutId, motionPrompt, reason: "client beat" });
  await failing((section) => { section.model = "kling-v3"; section.cuts = [cut("cut-01"), cut("cut-02"), cut("cut-03")]; }, /cuts/u);
  await failing((section) => { section.maximumCutsPerEpisode = 3; }, /maximumCutsPerEpisode/u);
  await failing((section) => { section.cuts = [cut("cut-01")]; }, /must name the image-to-video model/u);
  await failing((section) => { section.model = "lovart-veo-3-1"; section.cuts = [cut("cut-01")]; }, /allowedModels|not in allowedModels/u);
  await failing((section) => { section.model = "kling-v3"; section.cuts = [cut("cut-01", "the hero is talking with lip sync")]; }, /lip-sync/u);
  await failing((section) => { section.model = "kling-v3"; section.cuts = [cut("cut-01", "a neon sign with glowing text flickers")]; }, /must not request text/u);
  await failing((section) => { section.model = "kling-v3"; section.cuts = [cut("cut-01"), cut("cut-01")]; }, /duplicates cut-01/u);
  await failing((section) => { section.requireOperatorPaidConfirmation = false; }, /requireOperatorPaidConfirmation/u);
});

test("an episode override marks cuts and changes the contract digest", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "cut-video-override-"));
  const base = await resolveKoyaMangaProductionContract({ projectDir, contractPath });
  const overridePath = join(projectDir, "override.json");
  await writeFile(overridePath, JSON.stringify({
    schemaVersion: 1,
    episodeId: "synthetic-ep",
    contractVersion: base.contract.version,
    reason: "client asked for a moving opening",
    override: {
      videoSubstitution: {
        model: "kling-v3",
        cuts: [{ cutId: "cut-01", motionPrompt: "steam rises from the cup", reason: "opening beat" }],
      },
    },
  }));
  const resolved = await resolveKoyaMangaProductionContract({ projectDir, contractPath, episodeId: "synthetic-ep", overridePath });
  assert.equal(resolved.contract.videoSubstitution.cuts[0].cutId, "cut-01");
  assert.equal(resolved.contract.videoSubstitution.maximumCutsPerEpisode, 2, "the cap stays from the base contract");
  assert.notEqual(resolved.digest, base.digest, "marking a cut must invalidate earlier audits");
});

test("duration options come from the provider layer and never from a silent model fallback", () => {
  assert.deepEqual(imageToVideoDurationOptions("grok-imagine-video-hermes"), [6, 10]);
  assert.deepEqual(imageToVideoDurationOptions("kling-v2-6"), [5, 10]);
  assert.deepEqual(imageToVideoDurationOptions("seedance-2"), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.deepEqual(imageToVideoDurationOptions("lovart-kling-v3"), [], "duration is only a prompt hint on Lovart routes");
  assert.deepEqual(imageToVideoDurationOptions("no-such-model"), []);
});

// ---------------------------------------------------------------------------
// 純粋な規則

test("eligibility refuses split pages, thought cuts, multi-image cuts and clips that cannot cover the cut", () => {
  const cut = { id: "cut-01", imagePath: "/a.png", timing: { durationSeconds: 4.2 } };
  const shot = (imagePath) => ({ imagePath });
  const base = { cutId: "cut-01", fps: 30, durationOptions: [5, 10], maximumClipShortfallFrames: 1 };
  const ok = evaluateCutVideoSubstitutionEligibility({ ...base, cut, shots: [shot("/a.png")] });
  assert.equal(ok.eligible, true);
  assert.equal(ok.requestDurationSeconds, 5);
  assert.equal(ok.frameCount, 126);
  const ids = (result) => result.failures.map((row) => row.id);
  assert.deepEqual(ids(evaluateCutVideoSubstitutionEligibility({ ...base, cut: { ...cut, panelLayout: { enabled: true } }, shots: [] })), ["split-page-not-eligible"]);
  assert.deepEqual(ids(evaluateCutVideoSubstitutionEligibility({ ...base, cut, utterances: [{ id: "u1", preset: "thought" }], shots: [shot("/a.png")] })), ["thought-spotlight-not-eligible"]);
  assert.deepEqual(ids(evaluateCutVideoSubstitutionEligibility({ ...base, cut, shots: [shot("/a.png"), shot("/b.png")] })), ["single-source-image-required"]);
  assert.deepEqual(ids(evaluateCutVideoSubstitutionEligibility({ ...base, cut: { ...cut, timing: { durationSeconds: 10.2 } }, shots: [shot("/a.png")] })), ["cut-longer-than-model-maximum"]);
  // 1フレームの丸め不足は許容の内側。
  assert.equal(evaluateCutVideoSubstitutionEligibility({ ...base, cut: { ...cut, timing: { durationSeconds: 10.02 } }, shots: [shot("/a.png")] }).requestDurationSeconds, 10);
  assert.deepEqual(ids(evaluateCutVideoSubstitutionEligibility({ ...base, durationOptions: [], cut, shots: [shot("/a.png")] })), ["model-has-no-exact-duration"]);
  assert.deepEqual(ids(evaluateCutVideoSubstitutionEligibility({ ...base, cut: null, shots: [] })), ["cut-not-found"]);
});

test("the generation prompt always carries the identity, no-text and no-lip-sync guard", () => {
  const prompt = buildCutVideoSubstitutionPrompt("wind moves the curtains");
  assert.match(prompt, /first frame must be identical/u);
  assert.match(prompt, /no lip-sync/u);
  assert.match(prompt, /text, letters, numbers/u);
  assert.match(prompt, /Motion: wind moves the curtains$/u);
  assert.throws(() => buildCutVideoSubstitutionPrompt(" "), /motionPrompt is required/u);
});

test("content identity ignores the requested duration but tracks model, prompt and start frame", () => {
  const input = { model: "kling-v3", resolution: "720p", aspectRatio: "16:9", prompt: "p", startFrameSpecDigest: "a".repeat(64) };
  const content = cutVideoContentIdentity(input);
  assert.notEqual(cutVideoRequestIdentity({ contentIdentity: content, durationSeconds: 5 }), cutVideoRequestIdentity({ contentIdentity: content, durationSeconds: 6 }));
  assert.notEqual(content, cutVideoContentIdentity({ ...input, model: "kling-o3" }));
  assert.notEqual(content, cutVideoContentIdentity({ ...input, prompt: "q" }));
  assert.notEqual(content, cutVideoContentIdentity({ ...input, startFrameSpecDigest: "b".repeat(64) }));
});

test("render bindings fail closed instead of silently falling back to the still", () => {
  assert.equal(appliedCutVideoBinding({ id: "cut-01" }), null);
  const fallback = { version: "manga-cut-video-binding-v1", status: "still-fallback", fallback: { reason: "clip drifted twice", decidedBy: "operator" } };
  assert.equal(appliedCutVideoBinding({ id: "cut-01", videoSubstitution: fallback }), null);
  assert.throws(() => appliedCutVideoBinding({ id: "cut-01", videoSubstitution: { ...fallback, fallback: { reason: "" } } }), /reason and name/u);
  assert.throws(() => appliedCutVideoBinding({ id: "cut-01", videoSubstitution: { version: "manga-cut-video-binding-v1", status: "pending" } }), /cannot be rendered/u);
  assert.throws(() => appliedCutVideoBinding({ id: "cut-01", videoSubstitution: { version: "manga-cut-video-binding-v1", status: "applied", clipPath: "relative.mp4" } }), /missing clipPath/u);
  assert.throws(() => appliedCutVideoBinding({ id: "cut-01", videoSubstitution: { version: "old", status: "applied" } }), /unsupported/u);
});

test("the review must look inside every substituted cut from start to end", () => {
  const manifest = { cuts: [
    { id: "cut-01", timing: { startSeconds: 10, durationSeconds: 6 }, videoSubstitution: { status: "applied" } },
    { id: "cut-02", timing: { startSeconds: 16, durationSeconds: 6 } },
  ] };
  const frame = (timestampSeconds, checkIds = ["characterContinuity", "bubblePlacement", "generatedTextArtifacts"]) => ({ timestampSeconds, checkIds });
  const notes = (frames) => ({ evidence: { representativeFramesReviewed: { frames } } });
  assert.equal(auditSubstitutedCutReviewCoverage({ manifest: { cuts: [manifest.cuts[1]] }, reviewNotes: notes([]) }).applicable, false);
  assert.equal(auditSubstitutedCutReviewCoverage({ manifest, reviewNotes: notes([frame(10.5), frame(13), frame(15.5)]) }).pass, true);
  assert.match(auditSubstitutedCutReviewCoverage({ manifest, reviewNotes: notes([frame(10.5), frame(11), frame(17)]) }).failures.join(), /frames-not-reviewed:cut-01/u);
  assert.match(auditSubstitutedCutReviewCoverage({ manifest, reviewNotes: notes([frame(10.5, ["composition"]), frame(13, ["camera"]), frame(15.5, ["bubblePlacement"])]) }).failures.join(), /checks-missing:cut-01:characterContinuity\+generatedTextArtifacts/u);
});

test("still cuts keep their render cache key; a bound clip changes only its own cut", async () => {
  const episode = await buildEpisode({ withMedia: false });
  const manifest = JSON.parse(await readFile(episode.manifestPath, "utf8"));
  const [cut, still] = manifest.cuts;
  const utterances = [manifest.utterances[0]];
  const before = await renderCutInputHash(manifest, cut, utterances);
  const clipPath = join(episode.episodeDir, "clip.mp4");
  await writeFile(clipPath, "clip bytes");
  const binding = {
    version: "manga-cut-video-binding-v1",
    status: "applied",
    clipPath,
    clipSha256: "c".repeat(64),
    startFrameSha256: "d".repeat(64),
    startFrameSpecDigest: "e".repeat(64),
    contentIdentity: "f".repeat(64),
    requestIdentity: "0".repeat(64),
    clipDurationSeconds: 5,
    maximumClipShortfallFrames: 1,
  };
  const withClip = await renderCutInputHash(manifest, { ...cut, videoSubstitution: binding }, utterances);
  assert.notEqual(withClip, before);
  const fallback = { version: "manga-cut-video-binding-v1", status: "still-fallback", fallback: { reason: "operator chose still", decidedBy: "operator" } };
  assert.equal(await renderCutInputHash(manifest, { ...cut, videoSubstitution: fallback }, utterances), before, "a still fallback renders the same pixels");
  assert.equal(
    await renderCutInputHash(manifest, still, [manifest.utterances[1]]),
    await renderCutInputHash({ ...manifest, cuts: [{ ...cut, videoSubstitution: binding }, still] }, still, [manifest.utterances[1]]),
  );
  const plan = createKoyaRenderedCameraPlan({ ...manifest, cuts: [{ ...cut, videoSubstitution: binding }, still] });
  assert.deepEqual(plan.videoSubstitutedCuts.map((row) => row.cutId), ["cut-01"]);
  assert.deepEqual([...new Set(plan.rows.map((row) => row.cutId))], ["cut-02"], "camera optical flow is measured on stills only");
});

// ---------------------------------------------------------------------------
// 工程（モック生成 + 実 ffmpeg）

test("without paid confirmation the stage only prepares the start frame and stops", { skip: mediaSkip }, async () => {
  const episode = await buildEpisode();
  const before = JSON.parse(await readFile(episode.manifestPath, "utf8"));
  const calls = [];
  const result = await runCutVideoSubstitutions({ manifestPath: episode.manifestPath, contract: await markedContract(), generateVideo: mockGenerator({ calls }) });
  assert.equal(result.status, "waiting");
  assert.equal(calls.length, 0, "no paid call without confirmation");
  assert.deepEqual(result.blocked.map((row) => row.reason), ["awaiting-paid-confirmation"]);
  assert.match(result.blocked[0].detail, /kling-v2-6 5s 720p \(attempt 1\/2\)/u);
  assert.ok(existsSync(result.rows[0].startFramePath));
  assert.deepEqual(JSON.parse(await readFile(episode.manifestPath, "utf8")), before, "nothing is bound yet");
  await assert.rejects(
    assertCutVideoSubstitutionsReadyForRender({ manifest: before, manifestPath: episode.manifestPath, contract: await markedContract() }),
    (error) => error instanceof CutVideoSubstitutionBlockedError && /clip-not-ready/u.test(error.message),
  );
});

test("a confirmed run records the attempt before calling, binds hashes, and resume skips the finished clip", { skip: mediaSkip }, async () => {
  const episode = await buildEpisode();
  const contract = await markedContract();
  const before = JSON.parse(await readFile(episode.manifestPath, "utf8"));
  const { ledgerPath } = cutVideoSubstitutionPaths(episode.episodeDir);
  const calls = [];
  const generateVideo = mockGenerator({ calls, ledgerPath });
  const result = await runCutVideoSubstitutions({ manifestPath: episode.manifestPath, contract, generateVideo, confirmPaidGeneration: true });
  assert.equal(result.status, "ready", JSON.stringify(result.blocked));
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.model, "kling-v2-6");
  assert.equal(call.duration, "5");
  assert.equal(call.generateAudio, false);
  assert.equal(call.videoCount, 1);
  assert.equal(call.startFramePath, result.rows[0].startFramePath);
  assert.equal(call.ledgerAtCall.cuts["cut-01"].attempts[0].status, "submitted", "the attempt is on disk before the paid call");

  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const attempt = ledger.cuts["cut-01"].attempts[0];
  assert.equal(attempt.status, "completed");
  assert.equal(attempt.chargeState, "charged");
  assert.match(attempt.clip.sha256, /^[a-f0-9]{64}$/u);
  assert.match(attempt.startFrameSha256, /^[a-f0-9]{64}$/u);
  assert.match(attempt.sourceImageSha256, /^[a-f0-9]{64}$/u);
  assert.ok(attempt.validation.startFrameSimilarity >= contract.videoSubstitution.minimumStartFrameSimilarity);

  const after = JSON.parse(await readFile(episode.manifestPath, "utf8"));
  const binding = after.cuts[0].videoSubstitution;
  assert.equal(binding.status, "applied");
  assert.equal(binding.clipSha256, attempt.clip.sha256);
  assert.equal(after.cuts[1].videoSubstitution, undefined);
  // 音声・吹き出し・尺は触らない。
  assert.deepEqual(after.utterances, before.utterances);
  assert.deepEqual(after.cuts.map((cut) => cut.timing), before.cuts.map((cut) => cut.timing));
  assert.deepEqual(after.cuts[0].cameraSequence, before.cuts[0].cameraSequence);

  const verified = await assertCutVideoSubstitutionsReadyForRender({ manifest: after, manifestPath: episode.manifestPath, contract });
  assert.equal(verified.pass, true);

  const resumed = await runCutVideoSubstitutions({ manifestPath: episode.manifestPath, contract, generateVideo, confirmPaidGeneration: true });
  assert.equal(resumed.status, "ready");
  assert.equal(resumed.rows[0].reused, true);
  assert.equal(calls.length, 1, "a finished clip is never paid for twice");
  // 再開は確認フラグが無くても完了済みクリップを結び直せる（課金しないので）。
  const unconfirmed = await runCutVideoSubstitutions({ manifestPath: episode.manifestPath, contract, generateVideo });
  assert.equal(unconfirmed.status, "ready");

  await writeFile(attempt.clip.path, "altered bytes");
  const altered = await runCutVideoSubstitutions({ manifestPath: episode.manifestPath, contract, generateVideo, confirmPaidGeneration: true });
  assert.equal(altered.blocked[0].reason, "completed-clip-missing-or-altered");
  assert.equal(calls.length, 1, "a vanished clip is not silently re-bought");
  assert.equal(JSON.parse(await readFile(episode.manifestPath, "utf8")).cuts[0].videoSubstitution, undefined);
});

test("failures stop with a checkpoint, retries are explicit, and the attempt budget is enforced", { skip: mediaSkip }, async () => {
  const episode = await buildEpisode();
  const contract = await markedContract();
  const calls = [];
  const failing = mockGenerator({ variant: "throws", calls });
  const first = await runCutVideoSubstitutions({ manifestPath: episode.manifestPath, contract, generateVideo: failing, confirmPaidGeneration: true });
  assert.equal(first.status, "blocked");
  assert.equal(first.blocked[0].reason, "generation-failed");
  assert.doesNotMatch(first.blocked[0].detail, /sk-test-secret/u, "secrets never reach the checkpoint");
  const ledger = JSON.parse(await readFile(first.ledgerPath, "utf8"));
  assert.equal(ledger.cuts["cut-01"].attempts[0].status, "failed");
  assert.equal(ledger.cuts["cut-01"].attempts[0].chargeState, "unknown");

  const noRetry = await runCutVideoSubstitutions({ manifestPath: episode.manifestPath, contract, generateVideo: failing, confirmPaidGeneration: true });
  assert.equal(noRetry.blocked[0].reason, "previous-attempt-failed");
  assert.equal(calls.length, 1, "no silent re-send");

  await runCutVideoSubstitutions({ manifestPath: episode.manifestPath, contract, generateVideo: failing, confirmPaidGeneration: true, retryFailed: true });
  assert.equal(calls.length, 2);
  const exhausted = await runCutVideoSubstitutions({ manifestPath: episode.manifestPath, contract, generateVideo: failing, confirmPaidGeneration: true, retryFailed: true });
  assert.equal(exhausted.blocked[0].reason, "attempt-budget-exhausted");
  assert.equal(calls.length, 2, "the contract cap bounds spend even with --retry-failed");
  const manifest = JSON.parse(await readFile(episode.manifestPath, "utf8"));
  assert.equal(manifest.cuts[0].videoSubstitution, undefined, "nothing is bound after failures");
});

test("an attempt left in flight by a crashed process is treated as possibly charged", { skip: mediaSkip }, async () => {
  const episode = await buildEpisode();
  const contract = await markedContract();
  const { ledgerPath } = cutVideoSubstitutionPaths(episode.episodeDir);
  const calls = [];
  await runCutVideoSubstitutions({ manifestPath: episode.manifestPath, contract, generateVideo: mockGenerator({ variant: "throws", calls, ledgerPath }), confirmPaidGeneration: true });
  // クラッシュしたプロセスが残す状態 = 呼び出し時点の台帳。
  await writeFile(ledgerPath, JSON.stringify(calls[0].ledgerAtCall));
  const working = mockGenerator({ calls });
  const blocked = await runCutVideoSubstitutions({ manifestPath: episode.manifestPath, contract, generateVideo: working, confirmPaidGeneration: true });
  assert.equal(blocked.blocked[0].reason, "charge-unknown-in-flight");
  assert.equal(calls.length, 1);
  const retried = await runCutVideoSubstitutions({ manifestPath: episode.manifestPath, contract, generateVideo: working, confirmPaidGeneration: true, retryFailed: true });
  assert.equal(retried.status, "ready");
  assert.equal(calls.length, 2);
});

test("a clip that drifts from the start frame or comes from another model is kept but rejected", { skip: mediaSkip }, async () => {
  for (const variant of ["other-image", "wrong-model"]) {
    const episode = await buildEpisode();
    const contract = await markedContract();
    const calls = [];
    const result = await runCutVideoSubstitutions({ manifestPath: episode.manifestPath, contract, generateVideo: mockGenerator({ variant, calls }), confirmPaidGeneration: true });
    assert.equal(result.status, "blocked", variant);
    const ledger = JSON.parse(await readFile(result.ledgerPath, "utf8"));
    const attempt = ledger.cuts["cut-01"].attempts[0];
    assert.equal(attempt.status, "rejected", variant);
    assert.equal(attempt.chargeState, "charged", `${variant}: bytes arrived, so the call was billed`);
    if (variant === "other-image") {
      assert.match(JSON.stringify(attempt.validation.failures), /start-frame-drift/u);
      assert.ok(existsSync(attempt.clip.path), "the paid clip is preserved for inspection");
    } else {
      assert.match(attempt.error, /instead of kling-v2-6/u);
    }
    const again = await runCutVideoSubstitutions({ manifestPath: episode.manifestPath, contract, generateVideo: mockGenerator({ calls }), confirmPaidGeneration: true });
    assert.equal(again.blocked[0].reason, "previous-attempt-rejected");
    assert.equal(calls.length, 1, `${variant}: no automatic regeneration`);
  }
});

test("a still fallback needs the operator's reason and name and is verified against the ledger", { skip: mediaSkip }, async () => {
  const episode = await buildEpisode();
  const contract = await markedContract();
  await assert.rejects(
    runCutVideoSubstitutions({ manifestPath: episode.manifestPath, contract, stillFallback: { cutIds: ["cut-01"], reason: "", decidedBy: "operator" } }),
    /concrete reason/u,
  );
  await assert.rejects(
    runCutVideoSubstitutions({ manifestPath: episode.manifestPath, contract, stillFallback: { cutIds: ["cut-02"], reason: "clip drifted twice", decidedBy: "operator" } }),
    /not marked/u,
  );
  const calls = [];
  const result = await runCutVideoSubstitutions({
    manifestPath: episode.manifestPath,
    contract,
    generateVideo: mockGenerator({ calls }),
    stillFallback: { cutIds: ["cut-01"], reason: "clip drifted twice", decidedBy: "operator" },
  });
  assert.equal(result.status, "ready");
  assert.equal(calls.length, 0);
  const manifest = JSON.parse(await readFile(episode.manifestPath, "utf8"));
  assert.equal(manifest.cuts[0].videoSubstitution.status, "still-fallback");
  assert.equal((await verifyCutVideoSubstitutionBindings({ manifest, manifestPath: episode.manifestPath, contract })).pass, true);
  const forged = structuredClone(manifest);
  forged.cuts[0].videoSubstitution.fallback.reason = "edited by hand later";
  const verdict = await verifyCutVideoSubstitutionBindings({ manifest: forged, manifestPath: episode.manifestPath, contract });
  assert.deepEqual(verdict.failures.map((row) => row.reason), ["still-fallback-not-recorded"]);
});

test("render readiness rejects hand-made, altered, stale, unmarked and ineligible bindings", { skip: mediaSkip }, async () => {
  const episode = await buildEpisode();
  const contract = await markedContract();
  const result = await runCutVideoSubstitutions({ manifestPath: episode.manifestPath, contract, generateVideo: mockGenerator(), confirmPaidGeneration: true });
  assert.equal(result.status, "ready");
  const manifest = JSON.parse(await readFile(episode.manifestPath, "utf8"));
  const reasons = async (candidate, candidateContract = contract) => (
    await verifyCutVideoSubstitutionBindings({ manifest: candidate, manifestPath: episode.manifestPath, contract: candidateContract })
  ).failures.map((row) => row.reason);

  const handMade = structuredClone(manifest);
  handMade.cuts[0].videoSubstitution.attemptId = "cut-01-a9-forged";
  assert.deepEqual(await reasons(handMade), ["binding-without-completed-attempt"]);

  const unmarked = structuredClone(manifest);
  unmarked.cuts[1].videoSubstitution = structuredClone(manifest.cuts[0].videoSubstitution);
  assert.ok((await reasons(unmarked)).includes("binding-without-contract-mark"));

  const reprompted = await markedContract([{ cutId: "cut-01", motionPrompt: "clouds pass quickly overhead", reason: "opening beat" }]);
  assert.deepEqual(await reasons(manifest, reprompted), ["request-stale"]);

  const reframed = structuredClone(manifest);
  reframed.cuts[0].cameraSequence[0].camera = { ...PULLOUT, focusX: 0.6, focusXEnd: 0.6 };
  assert.deepEqual(await reasons(reframed), ["start-frame-stale", "request-stale"]);

  const thought = structuredClone(manifest);
  thought.utterances[0].preset = "thought";
  assert.deepEqual(await reasons(thought), ["cut-not-eligible"]);

  await writeFile(manifest.cuts[0].videoSubstitution.clipPath, "tampered");
  assert.deepEqual(await reasons(manifest), ["clip-bytes-changed"]);
});

test("an ineligible marked cut stops before any paid call", { skip: mediaSkip }, async () => {
  const episode = await buildEpisode({ thoughtInCut1: true });
  const calls = [];
  const result = await runCutVideoSubstitutions({ manifestPath: episode.manifestPath, contract: await markedContract(), generateVideo: mockGenerator({ calls }), confirmPaidGeneration: true });
  assert.equal(result.status, "blocked");
  assert.equal(result.blocked[0].reason, "cut-not-eligible");
  assert.equal(calls.length, 0);
});

test("a second concurrent run for the same episode fails fast instead of double-submitting", { skip: mediaSkip }, async () => {
  const episode = await buildEpisode();
  const { ledgerPath } = cutVideoSubstitutionPaths(episode.episodeDir);
  await mkdir(dirname(ledgerPath), { recursive: true });
  await writeFile(`${ledgerPath}.lock`, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  await assert.rejects(
    runCutVideoSubstitutions({ manifestPath: episode.manifestPath, contract: await markedContract(), generateVideo: mockGenerator(), confirmPaidGeneration: true }),
    /Timed out waiting/u,
  );
});

test("unmarked episodes are not applicable and stale bindings are removed", { skip: mediaSkip }, async () => {
  const episode = await buildEpisode();
  const contract = await markedContract();
  await runCutVideoSubstitutions({ manifestPath: episode.manifestPath, contract, generateVideo: mockGenerator(), confirmPaidGeneration: true });
  const unmarked = await baseContract();
  const result = await runCutVideoSubstitutions({ manifestPath: episode.manifestPath, contract: unmarked });
  assert.equal(result.status, "not-applicable");
  assert.deepEqual(result.removedUnmarkedBindings, ["cut-01"]);
  const manifest = JSON.parse(await readFile(episode.manifestPath, "utf8"));
  assert.equal(manifest.cuts[0].videoSubstitution, undefined);
  const audit = await auditCutVideoSubstitutions({ manifestPath: episode.manifestPath, videoPath: episode.stills[0], contract: unmarked, outputDir: join(episode.episodeDir, "audit") });
  assert.equal(audit.report.applicable, false);
  assert.equal(audit.report.pass, true);
});

test("an episode without marks is left byte-for-byte untouched", { skip: mediaSkip }, async () => {
  const episode = await buildEpisode();
  const before = await readFile(episode.manifestPath);
  const result = await runCutVideoSubstitutions({ manifestPath: episode.manifestPath, contract: await baseContract(), generateVideo: mockGenerator() });
  assert.equal(result.status, "not-applicable");
  assert.deepEqual(await readFile(episode.manifestPath), before);
  assert.equal(existsSync(cutVideoSubstitutionPaths(episode.episodeDir).root), false, "no ledger, report or lock directory");
  await assert.rejects(
    runCutVideoSubstitutions({ manifestPath: episode.manifestPath, contract: await baseContract(), cutIds: "cut-01" }),
    /not marked/u,
  );
  const koya = await substituteKoyaMangaCutVideos({ projectDir: episode.projectDir, episodeId: "synthetic-ep", contractPath });
  assert.equal(koya.status, "not-applicable");
  assert.equal(existsSync(join(episode.episodeDir, "koya-production-state.json")), false, "the production state is not touched");
});

// 有料工程は外側の Video Harness Job に拘束される。テストでは測定済み doctor の
// テスト専用経路で同じ拘束を作り、manifest に書き込む。
function measuredDoctorReport(projectDir) {
  const files = ["show.json", "locations.json", "thumbnail.json"].map((path, index) => ({
    role: ["show", "locations", "thumbnail"][index],
    path,
    sha256: String(index + 1).repeat(64),
    bytes: 2,
  }));
  const payload = { version: "koya-channel-authority-fingerprint-v1", fileCount: files.length, files };
  const authorityFingerprint = { ...payload, sha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
  return {
    version: "harness-doctor-v1",
    projectDir,
    harnessId: "koya-manga-video",
    ready: true,
    blocking: [],
    checks: [
      "harness-production-route", "node", "ffmpeg", "ffprobe", "ffmpeg-capability",
      "voice-quality-python", "tts-key", "image-key", "channel-pack",
    ].map((id) => ({
      id,
      required: true,
      ok: true,
      ...(id === "tts-key" ? { kind: "voice.dialogue", provider: "elevenlabs", model: "eleven_v3", adapterVersion: "elevenlabs-dialogue-server-v1", status: "ready" } : {}),
      ...(id === "image-key" ? { host: "codex", model: "gpt-image-2-codex" } : {}),
      ...(id === "channel-pack" ? { authorityFingerprint } : {}),
    })),
  };
}

async function bindEpisodeToDirectTestJob(episode) {
  const runtime = {
    allowDirectMeasuredDoctorForTests: true,
    runDoctor: async () => measuredDoctorReport(episode.projectDir),
    // The direct test preflight stamps checkedAt into its identity; pin it.
    now: () => Date.parse("2026-09-16T00:00:00.000Z"),
  };
  const preflight = await assertKoyaFullPreflight({ projectDir: episode.projectDir, episodeId: "synthetic-ep" }, runtime);
  const manifest = JSON.parse(await readFile(episode.manifestPath, "utf8"));
  manifest.production = {
    ...manifest.production,
    outerJobBinding: createKoyaOuterJobBinding({
      jobId: preflight.jobId,
      identityDigest: preflight.identityDigest,
      executionIdentityDigest: preflight.executionIdentityDigest,
      resolvedProductionContractSha256: preflight.resolvedProductionContractSha256,
    }),
  };
  await writeFile(episode.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return runtime;
}

test("the production wrapper keeps the image retry flag away from paid clip re-sends", { skip: mediaSkip }, async () => {
  const episode = await buildEpisode();
  const runtime = await bindEpisodeToDirectTestJob(episode);
  const base = await resolveKoyaMangaProductionContract({ projectDir: episode.projectDir, contractPath });
  const overridePath = join(episode.projectDir, "override.json");
  await writeFile(overridePath, JSON.stringify({
    schemaVersion: 1,
    episodeId: "synthetic-ep",
    contractVersion: base.contract.version,
    reason: "moving opening for the client",
    override: { videoSubstitution: { model: "kling-v2-6", cuts: [{ cutId: "cut-01", motionPrompt: "slow drifting light over the scene", reason: "opening beat" }] } },
  }));
  const calls = [];
  const options = { projectDir: episode.projectDir, episodeId: "synthetic-ep", contractPath, overridePath, confirmPaidVideoGeneration: true };
  // 外側の Job に拘束されていない呼び出しは、有料の生成に進まない。
  await assert.rejects(
    substituteKoyaMangaCutVideos({ ...options, generateVideo: mockGenerator({ calls }) }),
    (error) => error?.code === "KOYA_OUTER_JOB_REQUIRED",
  );
  assert.equal(calls.length, 0);
  const failed = await substituteKoyaMangaCutVideos({ ...options, generateVideo: mockGenerator({ variant: "throws", calls }) }, runtime);
  assert.equal(failed.blocked, true);
  assert.equal(failed.state.status, "video-substitution-blocked");
  assert.equal(failed.state.currentStage, "video-substitution");
  assert.match(failed.state.knownRemainingIssues[0].id, /video-substitution:cut-01:generation-failed/u);
  assert.deepEqual(failed.blockedCuts.map((row) => row.reason), ["generation-failed"], "the per-cut reasons survive the wrapper");
  const imageRetry = await substituteKoyaMangaCutVideos({ ...options, retryFailed: true, generateVideo: mockGenerator({ calls }) }, runtime);
  assert.equal(imageRetry.blocked, true);
  assert.equal(calls.length, 1, "--retry-failed for images must not re-send a paid clip");
  const videoRetry = await substituteKoyaMangaCutVideos({ ...options, retryFailedVideo: true, generateVideo: mockGenerator({ calls }) }, runtime);
  assert.equal(videoRetry.status, "ready");
  assert.equal(videoRetry.state.currentStage, "render");
  assert.equal(calls.length, 2);
});

function fullRuntime(projectDir, calls, substituteVideos) {
  return {
    allowDirectMeasuredDoctorForTests: true,
    runDoctor: async () => measuredDoctorReport(projectDir),
    generateImages: async (options) => ({ episodeId: options.episodeId, waiting: false, failed: false }),
    prepareManifest: async () => ({ waiting: false }),
    generateSpeech: async () => { calls.push("speech"); return { waiting: false, partial: false, report: { mediaJobs: [] } }; },
    ...(substituteVideos ? { substituteVideos } : {}),
    renderVideo: async () => { calls.push("render"); return { outputPath: "/fixture/final.mp4", paths: { manifestPath: "/fixture/manifest.json" } }; },
    auditFinal: async () => ({ report: { pass: true, failedAuditIds: [], knownRemainingIssues: [] }, reportPath: "/fixture/report.json" }),
  };
}

test("full runs the stage between speech and render and stops before render when clips are not ready", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "cut-video-full-"));
  const calls = [];
  const waiting = await runKoyaMangaFullProduction(
    { projectDir, episodeId: "synthetic-ep", scriptPath: "/fixture/script.txt", confirmPaidVideoGeneration: false },
    fullRuntime(projectDir, calls, async (options) => {
      calls.push(`substitute:${options.confirmPaidVideoGeneration === true}`);
      return {
        status: "waiting",
        waiting: true,
        blocked: false,
        blockedCuts: [{ cutId: "cut-01", reason: "awaiting-paid-confirmation" }],
        rows: [],
        stageReportPath: "/fixture/stage-report.json",
        ledgerPath: "/fixture/ledger.json",
        paths: { statePath: "/fixture/state.json" },
        state: { status: "waiting-paid-video-confirmation", knownRemainingIssues: [{ id: "video-substitution:cut-01:awaiting-paid-confirmation" }] },
      };
    }),
  );
  assert.equal(waiting.exitCode, 3);
  assert.deepEqual(calls, ["speech", "substitute:false"], "render must not start while a marked clip is missing");
  assert.equal(waiting.payload.status, "waiting-paid-video-confirmation");
  assert.deepEqual(waiting.payload.videoSubstitution.blockedCuts.map((row) => row.reason), ["awaiting-paid-confirmation"]);

  const unmarkedCalls = [];
  // 印の無い回は本物の工程を通り、何もせずにレンダーへ進む。
  const unmarked = await runKoyaMangaFullProduction(
    { projectDir, episodeId: "unmarked-ep", scriptPath: "/fixture/script.txt" },
    fullRuntime(projectDir, unmarkedCalls),
  );
  assert.equal(unmarked.exitCode, 0);
  assert.deepEqual(unmarkedCalls, ["speech", "render"]);
  assert.equal(unmarked.payload.videoSubstitution, undefined, "the default payload is unchanged");
  assert.equal(existsSync(join(projectDir, "canvas", "manga-videos", "unmarked-ep")), false, "nothing is written for an unmarked episode");
});

// ---------------------------------------------------------------------------
// 実レンダー + 実MP4監査

async function renderSubstitutedEpisode({ variant = "motion", fontFile = "" } = {}) {
  const episode = await buildEpisode();
  const contract = await markedContract();
  const stage = await runCutVideoSubstitutions({
    manifestPath: episode.manifestPath,
    contract,
    generateVideo: mockGenerator({ variant, fontFile }),
    confirmPaidGeneration: true,
  });
  assert.equal(stage.status, "ready", JSON.stringify(stage.blocked));
  const manifest = JSON.parse(await readFile(episode.manifestPath, "utf8"));
  await assertCutVideoSubstitutionsReadyForRender({ manifest, manifestPath: episode.manifestPath, contract });
  const rendered = await renderEpisodeVideo({ manifestPath: episode.manifestPath, canvasDir: episode.canvasDir, fileName: "synthetic.mp4" });
  const audit = await auditCutVideoSubstitutions({
    projectDir: episode.projectDir,
    manifestPath: episode.manifestPath,
    videoPath: rendered.outputPath,
    contract,
    outputDir: join(episode.episodeDir, "audits", "video-substitution"),
  });
  return { episode, contract, rendered, audit };
}

function failedGates(audit) {
  return (audit.report.analysis?.cuts || []).flatMap((cut) => cut.gates.filter((gate) => !gate.pass).map((gate) => gate.id));
}

test("the real MP4 carries the clip only in the marked cut, passes the audit, and catches a bubble over a tracked face", { skip: auditSkip }, async () => {
  const { episode, rendered, audit, contract } = await renderSubstitutedEpisode();
  assert.equal(audit.report.pass, true, JSON.stringify({ failures: audit.report.failures, gates: failedGates(audit) }));
  assert.deepEqual(audit.report.substitutedCutIds, ["cut-01"]);
  const [cut] = audit.report.analysis.cuts;
  assert.ok(cut.metrics.faceSamplesWithBubbles > 0, "dense samples ran while the bubble was on screen");
  assert.deepEqual(cut.metrics.trackedRegions.map((row) => row.id), ["hero-face"]);
  assert.deepEqual(cut.evidenceFrames.map((row) => row.role), ["start", "middle", "end"]);
  for (const frame of cut.evidenceFrames) assert.match(frame.sha256, /^[a-f0-9]{64}$/u);
  // 尺: 全体のフレーム数はカットのフレーム数の和のまま。
  const { stdout } = await execFile("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", rendered.outputPath]);
  assert.equal(Number(stdout.trim()), 120);
  const manifest = JSON.parse(await readFile(episode.manifestPath, "utf8"));
  assert.equal(manifest.jobs.render["cut-01"].status, "complete");
  assert.equal(manifest.cuts[1].videoSubstitution, undefined);

  // 同じ実MP4で、吹き出しが顔の保護領域（左寄り）に掛かる配置の誤りを模す。
  await writeRgbaPng(join(episode.episodeDir, ".render-work", "u1.png"), WIDTH, HEIGHT, { x: 190, y: 100, width: 60, height: 60 });
  const overlap = await auditCutVideoSubstitutions({
    projectDir: episode.projectDir,
    manifestPath: episode.manifestPath,
    videoPath: rendered.outputPath,
    contract,
    outputDir: join(episode.episodeDir, "audits", "video-substitution-overlap"),
  });
  assert.equal(overlap.report.pass, false);
  assert.ok(failedGates(overlap).includes("protected-regions-clear-of-bubbles"), failedGates(overlap).join());
  assert.ok(overlap.report.analysis.cuts[0].evidenceFrames.some((row) => row.role === "region-overlap"));
});

test("a frozen clip is caught in the real MP4", { skip: auditSkip }, async () => {
  const { audit } = await renderSubstitutedEpisode({ variant: "static" });
  assert.equal(audit.report.pass, false);
  assert.ok(failedGates(audit).includes("clip-has-motion"), failedGates(audit).join());
});

const fontFile = findFontFile();
test("text drawn into the clip is caught even though the still had none", { skip: auditSkip || (fontFile ? false : "文字を描くフォントが見つからない") }, async () => {
  const { audit } = await renderSubstitutedEpisode({ variant: "text", fontFile });
  assert.equal(audit.report.pass, false);
  assert.ok(failedGates(audit).includes("no-generated-text"), failedGates(audit).join());
});

test("official CLI advertises the opt-in stage and its paid confirmation", () => {
  const result = spawnSync("node", ["scripts/koya-manga-video.mjs", "help"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /video-substitute/u);
  assert.match(result.stdout, /--confirm-paid-generation/u);
  assert.match(result.stdout, /--allow-still-fallback/u);
  assert.match(result.stdout, /--confirm-paid-video-generation/u);
});

test("validateCutVideoSubstitutionContract reports a missing section", () => {
  assert.deepEqual(validateCutVideoSubstitutionContract({}).map((row) => row.path), ["videoSubstitution"]);
});
