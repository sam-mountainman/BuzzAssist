import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  createPaidMediaJobBroker,
  paidMediaJobReceiptSummary,
  paidMediaRequestIdentity,
  readPaidMediaJobArtifact,
} from "./paidMediaJobBroker.mjs";
import { redactSecrets } from "./paidApiRetry.mjs";
import { resolveFfmpegToolchain } from "./harnessRuntimeResolver.mjs";
import {
  buildNarratedStoryOutcome,
  pendingNarratedStoryAuditChecks,
  receiptSafeMediaJobs,
} from "./narratedStoryOutcome.mjs";
import {
  loadReviewerTrust,
  reviewerTrustFailureCode,
  signNarratedReviewSignoff,
  verifyNarratedReviewSignoff,
} from "./koyaReviewAttestation.mjs";

const execFile = promisify(execFileCallback);

export const NARRATED_STORY_PIPELINE_VERSION = "buzzassist-narrated-story-pipeline-v1";
export const NARRATED_STORY_CHANNEL_CONFIG = "narrated-story.json";
export const NARRATED_STORY_SIGNOFF_VERSION = "buzzassist-narrated-story-contact-sheet-signoff-v1";
export const NARRATED_STORY_RUN_RECEIPT_VERSION = "buzzassist-narrated-story-run-receipt-v1";
export const NARRATED_STORY_AUDIT_VERSION = "buzzassist-narrated-story-audit-v1";
export const NARRATED_STORY_HARNESS_ID = "narrated-story-video";
const SHA256_HEX = /^[a-f0-9]{64}$/u;

const SENSITIVE_KEY = /(?:api[-_]?key|authorization|auth[-_]?token|access[-_]?token|refresh[-_]?token|token|secret|password|credentials?|private[-_]?key|signing[-_]?key|client[-_]?secret|cookie)$/iu;
const TERMINAL_PUNCTUATION = /[。！？!?]/u;
const CLOSING_PUNCTUATION = /[」』）】〉》〕］}]/u;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function finite(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum, fallback) {
  return Math.min(maximum, Math.max(minimum, finite(value, fallback)));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function fileSha256(path) {
  return sha256(await readFile(path));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonIfPresent(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomic(path, value, { json = false, mode = 0o600 } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const body = json ? `${JSON.stringify(value, null, 2)}\n` : value;
  await writeFile(temp, body, { mode });
  await rename(temp, path);
}

async function artifactRecord(path) {
  const absolute = resolve(path);
  const info = await stat(absolute);
  if (!info.isFile() || info.size === 0) throw new Error(`Artifact is missing or empty: ${absolute}`);
  return { path: absolute, sha256: await fileSha256(absolute), bytes: info.size };
}

async function artifactRecordValid(record) {
  if (!record?.path || !/^[a-f0-9]{64}$/u.test(String(record.sha256 || ""))) return false;
  try {
    const info = await stat(record.path);
    return info.isFile() && info.size > 0 && await fileSha256(record.path) === record.sha256;
  } catch {
    return false;
  }
}

function assertNoSensitiveFields(value, path = "channelPack", seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      throw new Error(`${path}.${key} is forbidden; provider secrets must stay on the BuzzAssist server.`);
    }
    assertNoSensitiveFields(child, `${path}.${key}`, seen);
  }
}

function stableId(value, fallback = "job") {
  return nonEmpty(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96) || fallback;
}

function providerConfig(value, label, { voice = false } = {}) {
  const source = value && typeof value === "object" ? value : {};
  const normalized = {
    provider: nonEmpty(source.provider),
    model: nonEmpty(source.model),
    adapterVersion: nonEmpty(source.adapterVersion),
    ...(voice ? { voiceId: nonEmpty(source.voiceId), speed: clamp(source.speed, 0.7, 1.3, 1) } : {}),
  };
  const missing = Object.entries(normalized)
    .filter(([key, item]) => key !== "speed" && !item)
    .map(([key]) => `${label}.${key}`);
  return { normalized, missing };
}

export async function loadNarratedStoryChannelConfig(channelPackDir) {
  const path = join(resolve(channelPackDir), NARRATED_STORY_CHANNEL_CONFIG);
  let source;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("config is not a regular file");
    source = await readJson(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: false, path, blockers: [`channel-pack-${NARRATED_STORY_CHANNEL_CONFIG}-missing`] };
    }
    throw error;
  }
  assertNoSensitiveFields(source);
  const image = providerConfig(source.image, "image");
  const voice = providerConfig(source.voice, "voice", { voice: true });
  const music = providerConfig(source.music, "music");
  const stylePrompt = nonEmpty(source.image?.stylePrompt);
  const musicPrompt = nonEmpty(source.music?.prompt);
  const blockers = [...image.missing, ...voice.missing, ...music.missing];
  const runtimeMetadata = {
    imageModel: nonEmpty(source.runtime?.imageModel),
    ttsProvider: nonEmpty(source.runtime?.ttsProvider),
    imageProvider: image.normalized.provider,
    imageAdapterVersion: image.normalized.adapterVersion,
    ttsModel: voice.normalized.model,
    ttsAdapterVersion: voice.normalized.adapterVersion,
    musicProvider: music.normalized.provider,
    musicModel: music.normalized.model,
    musicAdapterVersion: music.normalized.adapterVersion,
  };
  if (!runtimeMetadata.imageModel) blockers.push("runtime.imageModel");
  if (!runtimeMetadata.ttsProvider) blockers.push("runtime.ttsProvider");
  if (runtimeMetadata.imageModel && runtimeMetadata.imageModel !== image.normalized.model) blockers.push("runtime.imageModel-mismatch");
  if (runtimeMetadata.ttsProvider && runtimeMetadata.ttsProvider !== voice.normalized.provider) blockers.push("runtime.ttsProvider-mismatch");
  if (!stylePrompt) blockers.push("image.stylePrompt");
  if (!musicPrompt) blockers.push("music.prompt");
  const width = Math.round(clamp(source.render?.width, 160, 3840, 1280));
  const height = Math.round(clamp(source.render?.height, 90, 2160, 720));
  const fps = Math.round(clamp(source.render?.fps, 1, 60, 24));
  const config = {
    version: nonEmpty(source.version) || "content-sha",
    runtimeMetadata,
    image: { ...image.normalized, stylePrompt },
    voice: voice.normalized,
    music: {
      ...music.normalized,
      prompt: musicPrompt,
      gain: clamp(source.music?.gain, 0.005, 0.25, 0.04),
    },
    render: {
      width: width % 2 === 0 ? width : width - 1,
      height: height % 2 === 0 ? height : height - 1,
      fps,
    },
    concurrency: Math.round(clamp(source.concurrency, 1, 4, 4)),
    bookends: { enabled: source.bookends?.enabled === true },
  };
  return { ok: blockers.length === 0, path, blockers, config };
}

/** Deterministic Japanese sentence segmentation without ICU-version variance. */
export function splitNarratedStoryScript(raw) {
  const text = String(raw ?? "").replaceAll("\r", "").trim();
  if (!text) return [];
  const output = [];
  for (const line of text.split(/\n+/u).map((entry) => entry.trim()).filter(Boolean)) {
    let current = "";
    let terminalSeen = false;
    for (const character of line) {
      if (terminalSeen && !CLOSING_PUNCTUATION.test(character)) {
        if (current.trim()) output.push(current.trim());
        current = "";
        terminalSeen = false;
      }
      current += character;
      if (TERMINAL_PUNCTUATION.test(character)) terminalSeen = true;
    }
    if (current.trim()) output.push(current.trim());
  }
  return output.map((entry, index) => ({
    id: `s${String(index + 1).padStart(3, "0")}`,
    order: index,
    text: entry,
    textHash: sha256(entry),
    characterCount: [...entry].length,
  }));
}

async function payloadIdentity(root) {
  const absoluteRoot = resolve(String(root || ""));
  const rootInfo = await lstat(absoluteRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("--channel-pack-dir must be the verified payload directory.");
  }
  const files = [];
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error("Verified Channel Pack payload must not contain symlinks.");
      if (info.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!info.isFile()) throw new Error("Verified Channel Pack payload contains an unsupported entry.");
      const bytes = await readFile(path);
      files.push({
        path: `payload/${relative(absoluteRoot, path).split(sep).join("/")}`,
        bytes: info.size,
        sha256: sha256(bytes),
      });
    }
  };
  await walk(absoluteRoot);
  if (files.length === 0) throw new Error("Verified Channel Pack payload is empty.");
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { sha256: sha256(canonicalJson(files)), fileCount: files.length };
}

export async function inspectNarratedStoryInputs({ scriptPath, channelPackDir } = {}) {
  if (!scriptPath) throw new Error("full requires --script-path.");
  if (!channelPackDir) throw new Error("full requires --channel-pack-dir from the verified outer envelope.");
  const absoluteScript = resolve(String(scriptPath));
  const scriptInfo = await lstat(absoluteScript);
  if (!scriptInfo.isFile() || scriptInfo.isSymbolicLink() || scriptInfo.size === 0) {
    throw new Error("Raw Japanese script must be a non-empty regular file.");
  }
  const scriptBytes = await readFile(absoluteScript);
  if (!scriptBytes.toString("utf8").trim()) throw new Error("Raw Japanese script is blank.");
  return {
    script: { sha256: sha256(scriptBytes), bytes: scriptInfo.size },
    channelPack: await payloadIdentity(channelPackDir),
  };
}

function formatSrtTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) * 1000));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const secs = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

export function buildNarratedStorySrt(segments) {
  return segments.map((segment, index) => [
    String(index + 1),
    `${formatSrtTime(segment.startSeconds)} --> ${formatSrtTime(segment.endSeconds)}`,
    segment.text,
    "",
  ].join("\n")).join("\n");
}

async function runRuntime(spec, args, { cwd, timeout = 10 * 60_000 } = {}) {
  if (!spec?.command) throw new Error("A resolved executable is required.");
  return execFile(spec.command, [...(spec.args || []), ...args], {
    cwd,
    timeout,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function mapLimit(values, limit, worker) {
  const output = new Array(values.length);
  let next = 0;
  let failure = null;
  const run = async () => {
    for (;;) {
      if (failure) return;
      const index = next;
      next += 1;
      if (index >= values.length) return;
      try {
        output[index] = await worker(values[index], index);
      } catch (error) {
        if (!failure) failure = error;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
  if (failure) throw failure;
  return output;
}

function expectedMagic(kind, bytes) {
  if (kind === "image.generation") {
    return bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  return bytes.length > 44 && bytes.subarray(0, 4).toString("ascii") === "RIFF";
}

async function acquireMediaArtifact({ runner, spec, outputPath, mimeType }) {
  const identity = paidMediaRequestIdentity(spec);
  const sidecarPath = `${outputPath}.media-job.json`;
  const previous = await readJsonIfPresent(sidecarPath).catch(() => null);
  if (previous?.requestKey === identity.requestKey
    && previous?.inputHash === identity.inputHash
    && await artifactRecordValid(previous.artifact)
    && resolve(previous.artifact.path) === resolve(outputPath)) {
    return { path: resolve(outputPath), receipt: receiptSafeMediaJobs([previous.receipt])[0], cached: true };
  }
  const requested = { ...spec, requestKey: identity.requestKey };
  const generated = await runner(requested);
  const bytes = Buffer.isBuffer(generated?.bytes)
    ? generated.bytes
    : Buffer.from(generated?.bytes || []);
  if (!expectedMagic(spec.kind, bytes)) {
    throw new Error(`${spec.kind} media job returned an invalid ${mimeType} artifact.`);
  }
  const digest = sha256(bytes);
  const rawReceipt = generated.receipt
    || (generated.job ? paidMediaJobReceiptSummary(generated.job) : null);
  if (!rawReceipt) throw new Error(`${spec.kind} media job did not return a receipt.`);
  for (const [field, expected] of Object.entries({
    kind: spec.kind,
    provider: spec.provider,
    model: spec.model,
    adapterVersion: spec.adapterVersion,
    ...(spec.voiceId ? { voiceId: spec.voiceId } : {}),
  })) {
    if (nonEmpty(rawReceipt[field]) !== nonEmpty(expected)) {
      throw new Error(`${spec.kind} media job receipt has a mismatched ${field}.`);
    }
  }
  if (!nonEmpty(rawReceipt.jobId) || !nonEmpty(rawReceipt.providerJobId)) {
    throw new Error(`${spec.kind} media job receipt must include internal and provider job IDs.`);
  }
  if (rawReceipt.requestKey && rawReceipt.requestKey !== identity.requestKey) {
    throw new Error(`${spec.kind} media job receipt is bound to a different requestKey.`);
  }
  if (rawReceipt.inputHash && rawReceipt.inputHash !== identity.inputHash) {
    throw new Error(`${spec.kind} media job receipt is bound to a different inputHash.`);
  }
  const receipt = receiptSafeMediaJobs([{
    ...rawReceipt,
    requestKey: identity.requestKey,
    inputHash: identity.inputHash,
    adapterVersion: rawReceipt.adapterVersion || spec.adapterVersion,
    status: "completed",
    artifact: { ...rawReceipt.artifact, sha256: digest, mimeType, bytes: bytes.length },
  }])[0];
  await writeAtomic(outputPath, bytes);
  const artifact = await artifactRecord(outputPath);
  await writeAtomic(sidecarPath, {
    version: "buzzassist-narrated-story-media-sidecar-v1",
    requestKey: identity.requestKey,
    inputHash: identity.inputHash,
    artifact,
    receipt,
  }, { json: true });
  return { path: resolve(outputPath), receipt, cached: false };
}

export function createBrokerMediaJobRunner({ apiBase, stateDir, apiFetch, artifactFetch } = {}) {
  const base = nonEmpty(apiBase);
  if (!base) return null;
  const broker = createPaidMediaJobBroker({ stateDir, apiBase: base, apiFetch });
  const runner = async (spec) => {
    let job = await broker.start(spec);
    if (job.status !== "completed") job = await broker.waitFor({ requestKey: job.requestKey });
    if (job.status !== "completed") {
      throw new Error(job.error?.message || `Media job ${job.jobId} stopped in ${job.status}.`);
    }
    return {
      bytes: await readPaidMediaJobArtifact(job, { fetchImpl: artifactFetch }),
      job,
      receipt: broker.receipt(job),
    };
  };
  runner.probeAdapter = (spec, options = {}) => broker.probeAdapter(spec, options);
  return runner;
}

function mediaSpec({ kind, provider, model, adapterVersion, voiceId = "", input, output, reservation }) {
  return { kind, provider, model, adapterVersion, voiceId, input, output, reservation };
}

// Fish Audio's documented WAV sample-rate set currently tops out at 44.1 kHz.
// The render graph resamples every voice stem to the 48 kHz master timeline, so
// request the provider-native lossless rate explicitly rather than sending an
// impossible 48 kHz request or silently changing it server-side.
export function narratedVoiceOutputProfile(provider) {
  return {
    format: "wav",
    sampleRate: String(provider || "").trim().toLowerCase() === "fish-audio" ? 44_100 : 48_000,
    channels: 1,
  };
}

function safeMediaFailure(error) {
  return {
    name: nonEmpty(error?.name) || "Error",
    code: nonEmpty(error?.code),
    status: finite(error?.status),
    charged: error?.charged === true ? true : (error?.charged === false ? false : null),
    mediaJob: error?.job ? receiptSafeMediaJobs([error.job])[0] || null : null,
  };
}

function mediaFailureIssue(error) {
  const safe = safeMediaFailure(error);
  return `media-job-failure:${safe.code || safe.status || safe.name}`;
}

async function probeMedia(ffprobe, path) {
  const { stdout } = await runRuntime(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration:stream=index,codec_type,codec_name,width,height,duration,sample_rate,channels",
    "-of", "json",
    path,
  ]);
  return JSON.parse(stdout);
}

function durationFromProbe(probe) {
  return Math.max(0, finite(probe?.format?.duration, 0));
}

async function makeVoiceStem(ffmpeg, paths, outputPath) {
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const path of paths) args.push("-i", path);
  const inputs = paths.map((_, index) => `[${index}:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono[a${index}]`).join(";");
  const concat = paths.map((_, index) => `[a${index}]`).join("");
  const filterGraph = `${inputs};${concat}concat=n=${paths.length}:v=0:a=1[voice]`;
  args.push(
    "-filter_complex", filterGraph,
    "-map", "[voice]", "-c:a", "pcm_s16le", outputPath,
  );
  await runRuntime(ffmpeg, args);
  return { filterGraph, inputCount: paths.length, outputMap: "[voice]" };
}

async function makeBgmStem(ffmpeg, sourcePath, durationSeconds, gain, outputPath) {
  const filterGraph = `aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${gain.toFixed(5)}`;
  await runRuntime(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-stream_loop", "-1", "-i", sourcePath,
    "-t", durationSeconds.toFixed(6),
    "-af", filterGraph,
    "-c:a", "pcm_s16le", outputPath,
  ]);
  return { filterGraph, inputCount: 1, outputMap: "audio:0" };
}

async function makeMasterAudio(ffmpeg, voicePath, bgmPath, outputPath) {
  const filterGraph = "[0:a]aresample=48000,pan=stereo|c0=c0|c1=c0[voice];"
    + "[1:a]aresample=48000[bed];"
    + "[voice][bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,"
    + "loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[master]";
  await runRuntime(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-i", voicePath, "-i", bgmPath,
    "-filter_complex", filterGraph,
    "-map", "[master]", "-c:a", "pcm_s16le", outputPath,
  ]);
  return { filterGraph, inputCount: 2, outputMap: "[master]" };
}

async function renderPreview(ffmpeg, segments, masterAudioPath, srtPath, config, outputPath) {
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const segment of segments) {
    args.push("-loop", "1", "-framerate", String(config.render.fps), "-i", segment.imagePath);
  }
  const audioIndex = segments.length;
  const subtitleIndex = segments.length + 1;
  args.push("-i", masterAudioPath, "-i", srtPath);
  const filters = segments.map((segment, index) => {
    const frameCount = Math.max(1, Math.round(segment.durationSeconds * config.render.fps));
    const denominator = Math.max(1, frameCount - 1);
    const progress = `on/${denominator}`;
    const horizontal = index % 2 === 0
      ? `(iw-iw/zoom)*(${progress})`
      : `(iw-iw/zoom)*(1-${progress})`;
    return `[${index}:v]scale=${config.render.width}:${config.render.height}:force_original_aspect_ratio=decrease,`
      + `pad=${config.render.width}:${config.render.height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,`
      + `zoompan=z='min(max(pzoom,1.0)+0.002,1.08)':x='${horizontal}':`
      + `y='(ih-ih/zoom)/2':d=1:s=${config.render.width}x${config.render.height}:fps=${config.render.fps},`
      + `trim=end_frame=${frameCount},setpts=N/(${config.render.fps}*TB),format=yuv420p[v${index}]`;
  });
  filters.push(`${segments.map((_, index) => `[v${index}]`).join("")}concat=n=${segments.length}:v=1:a=0[video]`);
  const filterGraph = filters.join(";");
  args.push(
    "-filter_complex", filterGraph,
    "-map", "[video]", "-map", `${audioIndex}:a:0`, "-map", `${subtitleIndex}:s:0`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-b:a", "192k", "-c:s", "mov_text", "-metadata:s:s:0", "language=jpn",
    "-t", segments.at(-1).endSeconds.toFixed(6), "-movflags", "+faststart", outputPath,
  );
  await runRuntime(ffmpeg, args, { timeout: 30 * 60_000 });
  return {
    filterGraph,
    imageInputCount: segments.length,
    videoMap: "[video]",
    audioMap: `${audioIndex}:a:0`,
    subtitleMap: `${subtitleIndex}:s:0`,
  };
}

async function makeContactSheet(ffmpeg, videoPath, durationSeconds, outputPath) {
  const rate = Math.max(0.1, 3 / Math.max(0.1, durationSeconds));
  await runRuntime(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-i", videoPath,
    "-vf", `fps=${rate.toFixed(8)},scale=320:-2,tile=3x1`,
    "-frames:v", "1", outputPath,
  ]);
}

async function measureMeanVolume(ffmpeg, path, interval = null) {
  const trim = interval
    ? `atrim=start=${Number(interval.startSeconds).toFixed(6)}:end=${Number(interval.endSeconds).toFixed(6)},asetpts=PTS-STARTPTS,`
    : "";
  const { stderr } = await runRuntime(ffmpeg, [
    "-hide_banner", "-nostats", "-i", path, "-af", `${trim}volumedetect`, "-f", "null", "-",
  ]);
  const matches = [...String(stderr).matchAll(/mean_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/giu)];
  return matches.length ? finite(matches.at(-1)[1], -Infinity) : -Infinity;
}

async function measureLoudness(ffmpeg, path) {
  const { stderr } = await runRuntime(ffmpeg, [
    "-hide_banner", "-nostats", "-i", path,
    "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-",
  ]);
  const blocks = [...String(stderr).matchAll(/\{[\s\S]*?"input_i"[\s\S]*?\}/gu)];
  if (!blocks.length) return { integratedLufs: null, truePeakDbfs: null };
  const parsed = JSON.parse(blocks.at(-1)[0]);
  return {
    integratedLufs: finite(parsed.input_i),
    truePeakDbfs: finite(parsed.input_tp),
  };
}

async function fullDecode(ffmpeg, path) {
  await runRuntime(ffmpeg, ["-hide_banner", "-v", "error", "-xerror", "-i", path, "-f", "null", "-"], {
    timeout: 30 * 60_000,
  });
  return true;
}

async function frameMd5(ffmpeg, path, seconds) {
  const { stdout } = await runRuntime(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-i", path,
    "-ss", Math.max(0, seconds).toFixed(6), "-frames:v", "1", "-an", "-f", "md5", "-",
  ]);
  const match = String(stdout).match(/MD5=([a-f0-9]{32})/iu);
  return match?.[1]?.toLowerCase() || "";
}

function check(pass, detail, evidence = {}) {
  return { pass: pass === true, detail: String(detail), ...evidence };
}

/**
 * Inspect the exact FFmpeg filter graphs that were handed to the runtime.
 * Keeping this pure makes the negative cases testable: an `xfade` or
 * `acrossfade` mutation must turn the corresponding audit red.
 */
export function inspectNarratedStoryRenderGraphs(renderGraphs = {}, segmentCount = 0) {
  const renderFilterGraph = nonEmpty(renderGraphs?.preview?.filterGraph);
  const graphEvidence = Object.fromEntries(Object.entries(renderGraphs || {}).map(([name, value]) => [name, {
    filterGraphSha256: sha256(String(value?.filterGraph || "")),
    inputCount: finite(value?.inputCount ?? value?.imageInputCount, 0),
    outputMap: nonEmpty(value?.outputMap ?? value?.videoMap),
  }]));
  const expectedVideoConcat = `concat=n=${segmentCount}:v=1:a=0[video]`;
  const transitionFilterPresent = /(?:^|[;,])\s*(?:x?fade|blend|tblend)(?:=|[;,])/iu.test(renderFilterGraph);
  const requiredGraphNames = ["voiceStem", "bgmStem", "masterAudio", "preview"];
  const allFilterGraphs = requiredGraphNames.map((name) => String(renderGraphs?.[name]?.filterGraph || ""));
  const acrossfadeEvidenceComplete = allFilterGraphs.every(Boolean);
  const acrossfadeGraphs = Object.entries(renderGraphs || {})
    .filter(([, value]) => /(?:^|[;,])\s*acrossfade(?:=|[;,])/iu.test(String(value?.filterGraph || "")))
    .map(([name]) => name);
  return {
    graphEvidence,
    expectedVideoConcat,
    expectedAudioMap: `${segmentCount}:a:0`,
    transitionFilterPresent,
    sceneTransitionOwnedByParent: Boolean(renderFilterGraph)
      && renderGraphs?.preview?.imageInputCount === segmentCount
      && renderGraphs?.preview?.videoMap === "[video]"
      && renderFilterGraph.includes(expectedVideoConcat)
      && !transitionFilterPresent,
    parentAudioMapped: Boolean(renderGraphs?.voiceStem?.filterGraph)
      && renderGraphs.voiceStem.inputCount === segmentCount
      && renderGraphs.voiceStem.outputMap === "[voice]"
      && renderGraphs.voiceStem.filterGraph.includes(`concat=n=${segmentCount}:v=0:a=1[voice]`)
      && Boolean(renderGraphs?.masterAudio?.filterGraph)
      && renderGraphs.masterAudio.inputCount === 2
      && renderGraphs.masterAudio.outputMap === "[master]"
      && renderGraphs.masterAudio.filterGraph.includes("[voice][bed]amix=inputs=2")
      && renderGraphs?.preview?.audioMap === `${segmentCount}:a:0`,
    acrossfadeEvidenceComplete,
    acrossfadeGraphs,
    noWholeProgramAcrossfade: acrossfadeEvidenceComplete && acrossfadeGraphs.length === 0,
  };
}

async function automaticAudit({ ffmpeg, ffprobe, previewPath, voiceStemPath, bgmStemPath, expectedDuration, segments, config, hashes, renderGraphs }) {
  const beforeVoiceHash = await fileSha256(voiceStemPath);
  const probe = await probeMedia(ffprobe, previewPath);
  await fullDecode(ffmpeg, previewPath);
  const afterVoiceHash = await fileSha256(voiceStemPath);
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const video = streams.find((entry) => entry.codec_type === "video");
  const audio = streams.find((entry) => entry.codec_type === "audio");
  const subtitle = streams.find((entry) => entry.codec_type === "subtitle");
  const duration = durationFromProbe(probe);
  const videoDuration = finite(video?.duration, duration);
  const audioDuration = finite(audio?.duration, duration);
  const loudness = await measureLoudness(ffmpeg, previewPath);
  const intervalSeparation = await mapLimit(segments, Math.min(4, segments.length), async (segment) => {
    const interval = { startSeconds: segment.startSeconds, endSeconds: segment.endSeconds };
    const voiceMeanDb = await measureMeanVolume(ffmpeg, voiceStemPath, interval);
    const bgmMeanDb = await measureMeanVolume(ffmpeg, bgmStemPath, interval);
    return {
      id: segment.id,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      voiceMeanDb,
      bgmMeanDb,
      separationDb: voiceMeanDb - bgmMeanDb,
    };
  });
  const separationDb = Math.min(...intervalSeparation.map((entry) => entry.separationDb));
  const cameraFrames = await mapLimit(segments, Math.min(4, segments.length), async (segment, index) => {
    const frameSeconds = 1 / config.render.fps;
    const startSeconds = segment.startSeconds + Math.min(frameSeconds * 0.25, segment.endSeconds - segment.startSeconds);
    const middleSeconds = (segment.startSeconds + segment.endSeconds) / 2;
    const endSeconds = Math.max(startSeconds, segment.endSeconds - frameSeconds * 1.25);
    const hashes = await Promise.all([
      frameMd5(ffmpeg, previewPath, startSeconds),
      frameMd5(ffmpeg, previewPath, middleSeconds),
      frameMd5(ffmpeg, previewPath, endSeconds),
    ]);
    return {
      id: segment.id,
      direction: index % 2 === 0 ? "left-to-right" : "right-to-left",
      startSeconds,
      middleSeconds,
      endSeconds,
      frameMd5: { start: hashes[0], middle: hashes[1], end: hashes[2] },
      motionObserved: hashes.every(Boolean) && new Set(hashes).size >= 2,
    };
  });
  const graphAudit = inspectNarratedStoryRenderGraphs(renderGraphs, segments.length);
  const checks = pendingNarratedStoryAuditChecks("automatic-audit");
  checks.audioIntegratedLoudness = check(
    loudness.integratedLufs !== null
      && Math.abs(loudness.integratedLufs - (-14)) <= 0.5
      && loudness.truePeakDbfs !== null
      && loudness.truePeakDbfs <= -1.5,
    `I=${loudness.integratedLufs} LUFS, TP=${loudness.truePeakDbfs} dBFS`,
    loudness,
  );
  checks.narrationBedSeparation = check(
    intervalSeparation.length > 0
      && intervalSeparation.every((entry) => Number.isFinite(entry.separationDb) && entry.separationDb >= 6),
    `minimum per-utterance voice/bed separation ${separationDb} dB across ${intervalSeparation.length} intervals`,
    { minimumSeparationDb: separationDb, intervals: intervalSeparation },
  );
  checks.duration = check(
    Math.abs(duration - expectedDuration) <= Math.max(1 / config.render.fps, expectedDuration * 0.03),
    `actual=${duration}s expected=${expectedDuration}s`,
    { actualSeconds: duration, expectedSeconds: expectedDuration },
  );
  checks.frozenV1AndParentHashes = check(
    Object.values(hashes).every((value) => /^[a-f0-9]{64}$/u.test(String(value || ""))),
    "script, Channel Pack and generated parent artifacts are SHA-256-bound",
  );
  checks.parentAudioPcmPreserved = check(
    beforeVoiceHash === afterVoiceHash
      && beforeVoiceHash === hashes.voiceStem
      && graphAudit.parentAudioMapped,
    `voice stem remained ${afterVoiceHash}; master audio map=${graphAudit.graphEvidence.preview?.outputMap || "missing"}/${renderGraphs?.preview?.audioMap || "missing"}`,
    {
      voiceStemSha256: afterVoiceHash,
      expectedVoiceStemSha256: hashes.voiceStem,
      expectedAudioMap: graphAudit.expectedAudioMap,
      renderGraphs: graphAudit.graphEvidence,
    },
  );
  checks.pixelAudit = check(
    video?.width === config.render.width
      && video?.height === config.render.height
      && Boolean(subtitle)
      && cameraFrames.length === segments.length
      && cameraFrames.every((entry) => entry.motionObserved),
    `video=${video?.width || 0}x${video?.height || 0}, subtitle=${subtitle?.codec_name || "missing"}, `
      + `moving segments=${cameraFrames.filter((entry) => entry.motionObserved).length}/${cameraFrames.length}, fullDecode=pass`,
    { cameraPlan: "monotonic-zoom-with-alternating-horizontal-pan", frames: cameraFrames },
  );
  checks.sceneTransitionOwnedByParent = check(
    graphAudit.sceneTransitionOwnedByParent,
    `parent graph=${graphAudit.graphEvidence.preview?.filterGraphSha256 || "missing"}, concat=${graphAudit.expectedVideoConcat}, transitionFilter=${graphAudit.transitionFilterPresent}`,
    { renderGraphs: graphAudit.graphEvidence },
  );
  checks.audioBoundaryBreathV16 = check(
    config.bookends.enabled === false,
    config.bookends.enabled
      ? "bookend transitions require a dedicated measured boundary audit"
      : "Channel Pack disables bookends; no OP/review boundary exists",
  );
  checks.noWholeProgramAcrossfade = check(
    graphAudit.noWholeProgramAcrossfade,
    graphAudit.acrossfadeEvidenceComplete
      ? `four executed filter graphs contain no acrossfade filter (${Object.values(graphAudit.graphEvidence).map((entry) => entry.filterGraphSha256).join(",")})`
      : "executed filter-graph evidence is incomplete",
    { renderGraphs: graphAudit.graphEvidence, acrossfadeGraphs: graphAudit.acrossfadeGraphs },
  );
  const avDelta = Math.abs(videoDuration - audioDuration);
  checks.avEndSync = check(avDelta <= 0.12, `video=${videoDuration}s audio=${audioDuration}s delta=${avDelta}s`, { avDeltaSeconds: avDelta });
  return { checks, probe, loudness, separationDb, durationSeconds: duration };
}

function validateExternalSignoff(signoff, { jobId, videoSha256, contactSheetSha256 }) {
  const problems = [];
  if (signoff?.version !== NARRATED_STORY_SIGNOFF_VERSION) problems.push("signoff-version");
  if (!nonEmpty(signoff?.reviewer)) problems.push("signoff-reviewer");
  const context = nonEmpty(signoff?.reviewerContextId);
  if (!context || context === jobId || context === `production:${jobId}`) problems.push("independent-reviewer-context");
  if (signoff?.approved !== true) problems.push("signoff-not-approved");
  if (signoff?.videoSha256 !== videoSha256) problems.push("signoff-video-sha");
  if (signoff?.contactSheetSha256 !== contactSheetSha256) problems.push("signoff-contact-sheet-sha");
  if (signoff?.originalDetailReviewed !== true) problems.push("original-detail-review-required");
  if (!Array.isArray(signoff?.findings) || signoff.findings.length > 0) problems.push("signoff-findings");
  if (!Array.isArray(signoff?.knownRemainingIssues) || signoff.knownRemainingIssues.length > 0) problems.push("signoff-known-issues");
  return { ok: problems.length === 0, problems, reviewer: nonEmpty(signoff?.reviewer), reviewerContextId: context };
}

/**
 * ジャンル側 finalizer でも reviewer attestation を検証する（R3-5）。共通 Receipt と
 * 同じ verifyNarratedReviewSignoff を、Job の真値（jobId / identityDigest）と disk から
 * 計算した MP4・contact sheet の SHA で呼ぶ。信頼リストが読めない、identityDigest が
 * 渡っていない、といった監査側の欠落も理由コードとして残し、pass にしない。
 * signoff file がまだ無い場合は attestation 段へ進まない（本文検査の問題だけ残す）。
 */
async function verifySignoffAttestation(signoff, {
  jobId,
  identityDigest,
  videoSha256,
  contactSheetSha256,
  reviewerTrust = null,
  reviewerTrustPath = "",
  env = process.env,
}) {
  const result = { pass: false, failures: [], signerKeyId: "", reviewerLabel: "", trustSha256: "" };
  if (!signoff || typeof signoff !== "object" || Array.isArray(signoff)) {
    result.failures.push("signoff-missing");
    return result;
  }
  let trust = null;
  try {
    trust = await loadReviewerTrust({ trust: reviewerTrust, trustPath: reviewerTrustPath, env });
  } catch (error) {
    result.failures.push(reviewerTrustFailureCode(error));
  }
  const digest = nonEmpty(identityDigest);
  if (!SHA256_HEX.test(digest)) {
    // 期待 subject の材料が無い: 署名 subject の不正とは別コード（R2-S5）。
    result.failures.push("reviewer-attestation-expected-subject-unavailable:identityDigest");
  }
  const verified = verifyNarratedReviewSignoff(signoff, {
    jobId,
    identityDigest: digest,
    videoSha256,
    contactSheetSha256,
    trust,
  });
  result.signerKeyId = verified.signerKeyId;
  result.reviewerLabel = verified.reviewerLabel;
  result.trustSha256 = verified.trustSha256;
  result.failures = [...new Set([...result.failures, ...verified.failures])];
  result.pass = result.failures.length === 0;
  return result;
}

function applyPerceptualChecks(checks, validation, evidence) {
  const detail = validation.ok
    ? `independent SHA-bound signoff: ${validation.reviewer} (${validation.reviewerContextId})`
    : `pending/invalid independent signoff: ${validation.problems.join(", ") || "missing"}`;
  return {
    ...checks,
    perceptualReviewChecks: check(validation.ok, detail, evidence),
    perceptualReviewBoundToOutput: check(validation.ok, detail, evidence),
    perceptualEvidenceHashes: check(validation.ok, detail, evidence),
    contactSheetOriginalDetailReviewed: check(validation.ok, detail, evidence),
  };
}

function failedAuditIds(checks) {
  return Object.entries(checks).filter(([, value]) => value?.pass !== true).map(([id]) => id);
}

async function collectArtifacts(paths) {
  const output = {};
  for (const [kind, path] of Object.entries(paths)) output[kind] = await artifactRecord(path);
  return output;
}

async function collectCachedMediaJobs(runDir) {
  const receipts = [];
  const walk = async (directory) => {
    let entries = [];
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".media-job.json")) {
        const sidecar = await readJsonIfPresent(path).catch(() => null);
        if (sidecar?.receipt) receipts.push(sidecar.receipt);
      }
    }
  };
  await walk(join(runDir, "media"));
  return receiptSafeMediaJobs(receipts);
}

async function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

async function withPipelineLock(runDir, action, recovery = 0) {
  const path = join(runDir, ".pipeline.lock");
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
  } catch (error) {
    if (error?.code === "EEXIST" && recovery === 0) {
      const owner = await readJsonIfPresent(path).catch(() => null);
      if (owner && !await processAlive(Number(owner.pid))) {
        await rm(path, { force: true });
        return withPipelineLock(runDir, action, recovery + 1);
      }
    }
    throw new Error("The same narrated-story job is already running; duplicate media submission is blocked.");
  }
  let heartbeat = null;
  const timer = setInterval(() => {
    if (heartbeat) return;
    heartbeat = writeFile(path, `${JSON.stringify({ pid: process.pid, heartbeatAt: new Date().toISOString() })}\n`, { mode: 0o600 })
      .catch(() => {})
      .finally(() => { heartbeat = null; });
  }, 5_000);
  timer.unref?.();
  try {
    return await action();
  } finally {
    clearInterval(timer);
    if (heartbeat) await heartbeat;
    await handle?.close();
    await rm(path, { force: true });
  }
}

function outcomeFromReadyState(state, { knownRemainingIssues, auditChecks, runReceiptPath = null, status = "awaiting-human-review", artifacts = state.artifacts } = {}) {
  return buildNarratedStoryOutcome({
    version: NARRATED_STORY_PIPELINE_VERSION,
    status,
    jobId: state.jobId,
    inputs: state.inputs,
    runtimeMetadata: state.runtimeMetadata,
    adapterProbes: state.adapterProbes,
    execution: state.execution,
    review: state.review,
    artifacts,
    knownRemainingIssues,
    mediaJobs: state.mediaJobs,
    auditChecks,
    runReceiptPath,
  });
}

async function finalizeReadyState({
  state,
  statePath,
  signoffPath,
  ffmpeg,
  identityDigest = "",
  reviewerTrust = null,
  reviewerTrustPath = "",
  env = process.env,
}) {
  const video = state.artifacts?.previewVideo;
  const sheet = state.artifacts?.contactSheet;
  const signoff = await readJsonIfPresent(signoffPath).catch(() => null);
  const validation = validateExternalSignoff(signoff, {
    jobId: state.jobId,
    videoSha256: video?.sha256,
    contactSheetSha256: sheet?.sha256,
  });
  // 本文検査が通っても、信頼リスト上の active な reviewer 鍵で Job・成果物へ結合された
  // 署名が無ければ pass にしない。共通 Receipt と同じ検証器を使い、判定を 2 箇所で
  // 食い違わせない（audit report は pass・Receipt は拒否、という状態を作らない）。
  const attestation = await verifySignoffAttestation(signoff, {
    jobId: state.jobId,
    identityDigest,
    videoSha256: video?.sha256,
    contactSheetSha256: sheet?.sha256,
    reviewerTrust,
    reviewerTrustPath,
    env,
  });
  if (!attestation.pass) {
    validation.ok = false;
    validation.problems = [...new Set([...validation.problems, ...attestation.failures])];
  }
  const signoffSha256 = validation.ok ? await fileSha256(signoffPath) : "";
  const auditChecks = applyPerceptualChecks(state.auditChecks, validation, {
    signoffPath: resolve(signoffPath),
    signoffSha256,
    videoSha256: video?.sha256 || "",
    contactSheetSha256: sheet?.sha256 || "",
  });
  const failures = failedAuditIds(auditChecks);
  if (failures.length > 0) {
    // 失敗理由を audit report にも残す（outcome の detail だけに置かない）。
    // report の SHA が変わるので state の artifact 記録も同時に更新する。
    const artifacts = await recordSignoffRejectionInAuditReport(state, statePath, {
      signoffPath,
      signoffPresent: Boolean(signoff),
      problems: validation.problems,
    });
    return outcomeFromReadyState(state, {
      knownRemainingIssues: failures.map((id) => `audit-${id}-pending-or-failed`),
      auditChecks,
      artifacts,
    });
  }
  const finalPath = join(dirname(video.path), "final-audited.mp4");
  const finalTemp = `${finalPath}.${process.pid}.${randomUUID()}.tmp.mp4`;
  await copyFile(video.path, finalTemp);
  await fullDecode(ffmpeg, finalTemp);
  await rm(finalPath, { force: true });
  await rename(finalTemp, finalPath);
  const artifacts = { ...state.artifacts, finalVideo: await artifactRecord(finalPath) };
  const auditPath = state.artifacts.auditReport.path;
  await writeAtomic(auditPath, {
    version: NARRATED_STORY_AUDIT_VERSION,
    status: "pass",
    jobId: state.jobId,
    videoSha256: artifacts.finalVideo.sha256,
    contactSheetSha256: artifacts.contactSheet.sha256,
    auditChecks,
    knownRemainingIssues: [],
    independentSignoff: {
      path: resolve(signoffPath),
      sha256: signoffSha256,
      reviewer: validation.reviewer,
      reviewerContextId: validation.reviewerContextId,
      reviewerAttestation: {
        signerKeyId: attestation.signerKeyId,
        reviewerLabel: attestation.reviewerLabel,
        trustSha256: attestation.trustSha256,
      },
    },
  }, { json: true });
  artifacts.auditReport = await artifactRecord(auditPath);
  const receiptPath = join(dirname(auditPath), "run-receipt.json");
  await writeAtomic(receiptPath, {
    version: NARRATED_STORY_RUN_RECEIPT_VERSION,
    status: "final-audited",
    jobId: state.jobId,
    inputs: state.inputs,
    runtimeMetadata: state.runtimeMetadata,
    adapterProbes: state.adapterProbes,
    providerVersions: [...new Map(state.mediaJobs.map((receipt) => [
      `${receipt.provider}:${receipt.adapterVersion}`,
      { provider: receipt.provider, adapterVersion: receipt.adapterVersion, model: receipt.model },
    ])).values()],
    mediaJobs: receiptSafeMediaJobs(state.mediaJobs),
    auditChecks,
    artifacts: Object.fromEntries(Object.entries(artifacts).map(([kind, artifact]) => [kind, {
      path: artifact.path,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    }])),
    reviewerAttestation: {
      signerKeyId: attestation.signerKeyId,
      trustSha256: attestation.trustSha256,
    },
    knownRemainingIssues: [],
  }, { json: true });
  artifacts.runReceipt = await artifactRecord(receiptPath);
  const completed = {
    ...state,
    phase: "final-audited",
    auditChecks,
    artifacts,
    runReceiptPath: receiptPath,
    completedAt: new Date().toISOString(),
  };
  await writeAtomic(statePath, completed, { json: true });
  return outcomeFromReadyState(completed, {
    status: "final-audited",
    artifacts,
    knownRemainingIssues: [],
    auditChecks,
    runReceiptPath: receiptPath,
  });
}

/**
 * signoff が無い／拒否された理由を automatic-audit.json の independentSignoff に残す。
 * status は pass にしない。内容が前回と同じなら書き直さない（SHA の無駄な揺れを防ぐ）。
 */
async function recordSignoffRejectionInAuditReport(state, statePath, { signoffPath, signoffPresent, problems }) {
  const auditPath = state.artifacts?.auditReport?.path;
  if (!auditPath) return state.artifacts;
  const report = await readJsonIfPresent(auditPath).catch(() => null);
  if (!report || typeof report !== "object" || report.status === "pass") return state.artifacts;
  const independentSignoff = {
    path: resolve(signoffPath),
    status: signoffPresent ? "rejected" : "pending",
    problems: [...problems],
  };
  if (canonicalJson(report.independentSignoff || null) === canonicalJson(independentSignoff)) return state.artifacts;
  await writeAtomic(auditPath, { ...report, independentSignoff }, { json: true });
  const artifacts = { ...state.artifacts, auditReport: await artifactRecord(auditPath) };
  state.artifacts = artifacts;
  await writeAtomic(statePath, state, { json: true });
  return artifacts;
}

async function readyStateIsReusable(state, inputs) {
  if (state?.version !== NARRATED_STORY_PIPELINE_VERSION
    || state.inputs?.script?.sha256 !== inputs.script.sha256
    || state.inputs?.channelPack?.sha256 !== inputs.channelPack.sha256
    || !["awaiting-human-review", "final-audited"].includes(state.phase)) return false;
  const artifacts = Object.values(state.artifacts || {});
  if (artifacts.length === 0) return false;
  return (await Promise.all(artifacts.map(artifactRecordValid))).every(Boolean);
}

/**
 * Job workspace の配置。production と reviewer CLI（signoff）が同じ場所を指すための
 * 唯一の定義。signoffPath を明示すればそれを優先する。
 */
export function narratedStoryRunPaths({ deploymentRoot = process.cwd(), jobId, signoffPath = "" } = {}) {
  const id = stableId(jobId, "narrated-story-job");
  const runDir = join(resolve(deploymentRoot), ".media", NARRATED_STORY_HARNESS_ID, id);
  return {
    runDir,
    statePath: join(runDir, "pipeline-state.json"),
    signoffPath: nonEmpty(signoffPath) ? resolve(signoffPath) : join(runDir, "review", "contact-sheet-signoff.json"),
  };
}

/**
 * 独立 reviewer が contact sheet を確認した後に、署名付き signoff を書く。生成側は
 * これを呼ばない。署名ロジックは lib/koyaReviewAttestation.mjs の
 * signNarratedReviewSignoff だけで、ここでは本文を組み、MP4 / contact sheet の SHA を
 * disk から計算し、書き出すだけ。identityDigest は呼び出し側（CLI）が durable Job から
 * 読んで渡す。既存 signoff は force 無しで上書きしない。
 */
export async function writeNarratedReviewSignoff({
  deploymentRoot = process.cwd(),
  jobId,
  identityDigest,
  reviewerHost = "",
  reviewerId = "",
  reviewerContextId,
  videoPath = "",
  contactSheetPath = "",
  signoffPath = "",
  outputPath = "",
  reviewerPrivateKeyPath = "",
  reviewerPrivateKeyPem = "",
  reviewerTrust = null,
  reviewerTrustPath = "",
  env = process.env,
  pass = false,
  force = false,
  signedAt = new Date().toISOString(),
} = {}) {
  const id = nonEmpty(jobId);
  if (!id) throw new Error("signoff requires --job-id of the durable outer Job.");
  if (!SHA256_HEX.test(nonEmpty(identityDigest))) {
    throw new Error("reviewer-attestation-expected-subject-unavailable:identityDigest — signoff requires the durable Job's identityDigest (read from the Job, not typed by hand).");
  }
  if (pass !== true) throw new Error("Signoff requires --pass after the contact sheet has actually been inspected at original detail.");
  const host = nonEmpty(reviewerHost).toLowerCase();
  if (host && !["claude", "codex"].includes(host)) throw new Error("--reviewer must be claude or codex.");
  const contextId = nonEmpty(reviewerContextId);
  if (!contextId || contextId.length < 8) {
    throw new Error("--reviewer-context-id must identify the real reviewer Codex task / Claude session (8+ chars).");
  }
  if (contextId === id || contextId === `production:${id}`) {
    throw new Error("independent-reviewer-context: the reviewer context must differ from the production Job.");
  }
  const reviewer = nonEmpty(reviewerId) || (host ? `${host}:${contextId}` : "");
  if (!reviewer) throw new Error("signoff requires --reviewer claude|codex or --reviewer-id ID.");
  const paths = narratedStoryRunPaths({ deploymentRoot, jobId: id, signoffPath: nonEmpty(outputPath) || signoffPath });
  const state = await readJsonIfPresent(paths.statePath).catch(() => null);
  if (state && state.jobId !== id) throw new Error("The narrated-story workspace belongs to another Job.");
  const resolvedVideoPath = nonEmpty(videoPath) ? resolve(videoPath) : nonEmpty(state?.artifacts?.previewVideo?.path);
  const resolvedSheetPath = nonEmpty(contactSheetPath) ? resolve(contactSheetPath) : nonEmpty(state?.artifacts?.contactSheet?.path);
  if (!resolvedVideoPath || !resolvedSheetPath) {
    throw new Error("signoff needs the reviewed MP4 and contact sheet: run production first or pass --video-path and --contact-sheet-path.");
  }
  const [videoRecord, sheetRecord] = await Promise.all([artifactRecord(resolvedVideoPath), artifactRecord(resolvedSheetPath)]);
  if (!force && await readJsonIfPresent(paths.signoffPath).catch(() => ({}))) {
    throw new Error(`signoff-exists: ${paths.signoffPath} already exists; pass --force to replace it after a new review.`);
  }
  const trust = await loadReviewerTrust({ trust: reviewerTrust, trustPath: reviewerTrustPath, env });
  const body = {
    version: NARRATED_STORY_SIGNOFF_VERSION,
    jobId: id,
    reviewer,
    ...(host ? { reviewerHost: host } : {}),
    reviewerContextId: contextId,
    approved: true,
    originalDetailReviewed: true,
    videoPath: videoRecord.path,
    videoSha256: videoRecord.sha256,
    contactSheetPath: sheetRecord.path,
    contactSheetSha256: sheetRecord.sha256,
    findings: [],
    knownRemainingIssues: [],
    reviewedAt: new Date(signedAt).toISOString(),
  };
  const signoff = await signNarratedReviewSignoff({
    signoff: body,
    jobId: id,
    identityDigest: nonEmpty(identityDigest),
    privateKeyPath: reviewerPrivateKeyPath,
    privateKeyPem: reviewerPrivateKeyPem,
    trust,
    signedAt,
  });
  await writeAtomic(paths.signoffPath, signoff, { json: true, mode: 0o644 });
  return {
    outputPath: paths.signoffPath,
    signoff,
    signerKeyId: signoff.reviewerAttestation?.signer?.keyId || "",
    videoSha256: videoRecord.sha256,
    contactSheetSha256: sheetRecord.sha256,
  };
}

export async function runNarratedStoryPipeline({
  scriptPath,
  channelPackDir,
  jobId,
  deploymentRoot = process.cwd(),
  mediaJobRunner = null,
  mediaJobProbe = null,
  mediaJobApiBase = process.env.BUZZASSIST_MEDIA_JOB_API_BASE,
  mediaJobFetch,
  artifactFetch,
  signoffPath = "",
  ffmpegToolchain = null,
  jobIdentityDigest = "",
  reviewerTrust = null,
  reviewerTrustPath = "",
  env = process.env,
} = {}) {
  if (!nonEmpty(jobId)) throw new Error("Narrated-story production requires the durable outer jobId.");
  const paths = narratedStoryRunPaths({ deploymentRoot, jobId, signoffPath });
  const runDir = paths.runDir;
  await mkdir(runDir, { recursive: true });
  const finalizeOptions = {
    identityDigest: nonEmpty(jobIdentityDigest),
    reviewerTrust,
    reviewerTrustPath: nonEmpty(reviewerTrustPath),
    env,
  };
  return withPipelineLock(runDir, async () => {
    const inputs = await inspectNarratedStoryInputs({ scriptPath, channelPackDir });
    const statePath = paths.statePath;
    const reviewSignoffPath = paths.signoffPath;
    const loadedConfig = await loadNarratedStoryChannelConfig(channelPackDir);
    if (!loadedConfig.ok) {
      return buildNarratedStoryOutcome({
        version: NARRATED_STORY_PIPELINE_VERSION,
        status: "awaiting-media",
        jobId,
        inputs,
        runtimeMetadata: loadedConfig.config?.runtimeMetadata || null,
        execution: { paidGenerationAttempted: false, providerCallsAttempted: false, legacyAssetFallbackUsed: false },
        artifacts: {},
        knownRemainingIssues: loadedConfig.blockers.map((item) => `channel-pack-config-required:${item}`),
        mediaJobs: [],
        auditChecks: pendingNarratedStoryAuditChecks("channel-pack-preflight"),
      });
    }
    const config = loadedConfig.config;
    const toolchain = ffmpegToolchain || await resolveFfmpegToolchain();
    if (!toolchain?.ok) {
      return buildNarratedStoryOutcome({
        version: NARRATED_STORY_PIPELINE_VERSION,
        status: "awaiting-media",
        jobId,
        inputs,
        runtimeMetadata: config.runtimeMetadata,
        execution: { paidGenerationAttempted: false, providerCallsAttempted: false, legacyAssetFallbackUsed: false },
        artifacts: {},
        knownRemainingIssues: ["ffmpeg-toolchain-unavailable"],
        mediaJobs: [],
        auditChecks: pendingNarratedStoryAuditChecks("ffmpeg-preflight"),
      });
    }
    const previousState = await readJsonIfPresent(statePath).catch(() => null);
    if (await readyStateIsReusable(previousState, inputs)) {
      if (previousState.phase === "final-audited") {
        return outcomeFromReadyState(previousState, {
          status: "final-audited",
          artifacts: previousState.artifacts,
          knownRemainingIssues: [],
          auditChecks: previousState.auditChecks,
          runReceiptPath: previousState.runReceiptPath,
        });
      }
      return finalizeReadyState({ state: previousState, statePath, signoffPath: reviewSignoffPath, ffmpeg: toolchain.ffmpeg, ...finalizeOptions });
    }
    const script = (await readFile(resolve(scriptPath), "utf8")).replaceAll("\r", "").trim();
    const segments = splitNarratedStoryScript(script);
    if (segments.length === 0) throw new Error("Raw Japanese script did not produce any deterministic segment.");
    const runner = mediaJobRunner || createBrokerMediaJobRunner({
      apiBase: mediaJobApiBase,
      stateDir: join(runDir, "broker-journal"),
      apiFetch: mediaJobFetch,
      artifactFetch,
    });
    if (!runner) {
      return buildNarratedStoryOutcome({
        version: NARRATED_STORY_PIPELINE_VERSION,
        status: "awaiting-media",
        jobId,
        inputs,
        runtimeMetadata: config.runtimeMetadata,
        execution: { paidGenerationAttempted: false, providerCallsAttempted: false, legacyAssetFallbackUsed: false },
        artifacts: {},
        knownRemainingIssues: ["BUZZASSIST_MEDIA_JOB_API_BASE-required"],
        mediaJobs: [],
        auditChecks: pendingNarratedStoryAuditChecks("paid-media-preflight"),
      });
    }
    const probeAdapter = typeof mediaJobProbe === "function"
      ? mediaJobProbe
      : (typeof runner.probeAdapter === "function" ? runner.probeAdapter : null);
    if (!probeAdapter) {
      return buildNarratedStoryOutcome({
        version: NARRATED_STORY_PIPELINE_VERSION,
        status: "awaiting-media",
        jobId,
        inputs,
        runtimeMetadata: config.runtimeMetadata,
        execution: { paidGenerationAttempted: false, providerCallsAttempted: false, legacyAssetFallbackUsed: false },
        artifacts: {},
        knownRemainingIssues: ["typed-media-adapter-probe-required"],
        mediaJobs: [],
        auditChecks: pendingNarratedStoryAuditChecks("paid-media-probe"),
      });
    }
    const adapterProbes = await Promise.all([
      { kind: "image.generation", provider: config.image.provider, model: config.image.model, adapterVersion: config.image.adapterVersion },
      { kind: "voice.synthesis", provider: config.voice.provider, model: config.voice.model, adapterVersion: config.voice.adapterVersion },
      { kind: "music.generation", provider: config.music.provider, model: config.music.model, adapterVersion: config.music.adapterVersion },
    ].map(async (adapter) => {
      try {
        const result = await probeAdapter(adapter);
        return {
          ok: result?.ok === true,
          status: nonEmpty(result?.status) || "unavailable",
          ...adapter,
          httpStatus: finite(result?.httpStatus),
          serverVersion: nonEmpty(result?.serverVersion),
          detail: redactSecrets(result?.detail || "adapter did not report ready"),
        };
      } catch (error) {
        return {
          ok: false,
          status: "unreachable",
          ...adapter,
          httpStatus: finite(error?.status),
          serverVersion: "",
          detail: redactSecrets(error?.message || String(error)),
        };
      }
    }));
    const unavailableAdapters = adapterProbes.filter((probe) => !probe.ok);
    if (unavailableAdapters.length > 0) {
      return buildNarratedStoryOutcome({
        version: NARRATED_STORY_PIPELINE_VERSION,
        status: "awaiting-media",
        jobId,
        inputs,
        runtimeMetadata: config.runtimeMetadata,
        adapterProbes,
        execution: { paidGenerationAttempted: false, providerCallsAttempted: false, legacyAssetFallbackUsed: false },
        artifacts: {},
        knownRemainingIssues: unavailableAdapters.map((probe) => (
          `media-adapter-unavailable:${probe.kind}:${probe.provider}:${probe.model}:${probe.adapterVersion}`
        )),
        mediaJobs: [],
        auditChecks: pendingNarratedStoryAuditChecks("paid-media-probe"),
      });
    }

    const imageDir = join(runDir, "media", "images");
    const voiceDir = join(runDir, "media", "voice");
    const musicDir = join(runDir, "media", "music");
    const renderDir = join(runDir, "render");
    const auditDir = join(runDir, "audit");
    await Promise.all([imageDir, voiceDir, musicDir, renderDir, auditDir, dirname(reviewSignoffPath)].map((path) => mkdir(path, { recursive: true })));
    const tasks = segments.flatMap((segment) => ([
      { type: "image", segment },
      { type: "voice", segment },
    ]));
    let generated;
    try {
      generated = await mapLimit(tasks, config.concurrency, async ({ type, segment }) => {
        if (type === "image") {
          return {
            type,
            segmentId: segment.id,
            ...(await acquireMediaArtifact({
              runner,
              spec: mediaSpec({
                kind: "image.generation",
                ...config.image,
                input: {
                  prompt: `${config.image.stylePrompt}\nScene ${segment.id}: ${segment.text}`,
                  scriptHash: inputs.script.sha256,
                  segmentId: segment.id,
                },
                output: { format: "png", width: config.render.width, height: config.render.height },
                reservation: { unit: "images", estimatedUnits: 1 },
              }),
              outputPath: join(imageDir, `${segment.id}.png`),
              mimeType: "image/png",
            })),
          };
        }
        return {
          type,
          segmentId: segment.id,
          ...(await acquireMediaArtifact({
            runner,
            spec: mediaSpec({
              kind: "voice.synthesis",
              ...config.voice,
              input: { text: segment.text, language: "ja", speed: config.voice.speed },
              output: narratedVoiceOutputProfile(config.voice.provider),
              reservation: {
                unit: "characters",
                estimatedUnits: segment.characterCount,
                estimatedSeconds: Math.max(0.5, segment.characterCount / 6),
              },
            }),
            outputPath: join(voiceDir, `${segment.id}.wav`),
            mimeType: "audio/wav",
          })),
        };
      });
    } catch (error) {
      const mediaJobs = await collectCachedMediaJobs(runDir);
      await writeAtomic(statePath, {
        version: NARRATED_STORY_PIPELINE_VERSION,
        phase: "awaiting-media",
        jobId,
        inputs,
        runtimeMetadata: config.runtimeMetadata,
        mediaJobs,
        error: safeMediaFailure(error),
      }, { json: true });
      return buildNarratedStoryOutcome({
        version: NARRATED_STORY_PIPELINE_VERSION,
        status: "awaiting-media",
        jobId,
        inputs,
        runtimeMetadata: config.runtimeMetadata,
        adapterProbes,
        execution: { paidGenerationAttempted: true, providerCallsAttempted: true, legacyAssetFallbackUsed: false },
        artifacts: {},
        knownRemainingIssues: ["typed-media-generation-incomplete", mediaFailureIssue(error)],
        mediaJobs,
        auditChecks: pendingNarratedStoryAuditChecks("media-generation"),
      });
    }
    const byKey = new Map(generated.map((entry) => [`${entry.type}:${entry.segmentId}`, entry]));
    const measuredSegments = [];
    let cursor = 0;
    for (const segment of segments) {
      const voicePath = byKey.get(`voice:${segment.id}`).path;
      const voiceProbe = await probeMedia(toolchain.ffprobe, voicePath);
      const durationSeconds = durationFromProbe(voiceProbe);
      if (!(durationSeconds > 0)) throw new Error(`${segment.id} voice artifact has no measurable duration.`);
      measuredSegments.push({
        ...segment,
        imagePath: byKey.get(`image:${segment.id}`).path,
        voicePath,
        durationSeconds,
        startSeconds: cursor,
        endSeconds: cursor + durationSeconds,
      });
      cursor += durationSeconds;
    }
    const totalDuration = cursor;
    let music;
    try {
      music = await acquireMediaArtifact({
        runner,
        spec: mediaSpec({
          kind: "music.generation",
          ...config.music,
          input: { prompt: config.music.prompt, durationSeconds: totalDuration, scriptHash: inputs.script.sha256 },
          output: { format: "wav", sampleRate: 48_000, channels: 2 },
          reservation: { unit: "seconds", estimatedSeconds: totalDuration },
        }),
        outputPath: join(musicDir, "generated-bed.wav"),
        mimeType: "audio/wav",
      });
    } catch (error) {
      const mediaJobs = await collectCachedMediaJobs(runDir);
      return buildNarratedStoryOutcome({
        version: NARRATED_STORY_PIPELINE_VERSION,
        status: "awaiting-media",
        jobId,
        inputs,
        runtimeMetadata: config.runtimeMetadata,
        adapterProbes,
        execution: { paidGenerationAttempted: true, providerCallsAttempted: true, legacyAssetFallbackUsed: false },
        artifacts: {},
        knownRemainingIssues: ["typed-music-generation-incomplete", mediaFailureIssue(error)],
        mediaJobs,
        auditChecks: pendingNarratedStoryAuditChecks("music-generation"),
      });
    }
    const srtPath = join(renderDir, "subtitles.srt");
    await writeAtomic(srtPath, buildNarratedStorySrt(measuredSegments), { mode: 0o600 });
    const voiceStemPath = join(renderDir, "voice-stem.wav");
    const bgmStemPath = join(renderDir, "bgm-stem.wav");
    const masterAudioPath = join(renderDir, "master-audio.wav");
    const previewPath = join(renderDir, "preview.mp4");
    const previewTemp = `${previewPath}.${process.pid}.${randomUUID()}.tmp.mp4`;
    const contactSheetPath = join(auditDir, "contact-sheet.png");
    const renderGraphs = {
      voiceStem: await makeVoiceStem(toolchain.ffmpeg, measuredSegments.map((segment) => segment.voicePath), voiceStemPath),
      bgmStem: await makeBgmStem(toolchain.ffmpeg, music.path, totalDuration, config.music.gain, bgmStemPath),
      masterAudio: await makeMasterAudio(toolchain.ffmpeg, voiceStemPath, bgmStemPath, masterAudioPath),
      preview: await renderPreview(toolchain.ffmpeg, measuredSegments, masterAudioPath, srtPath, config, previewTemp),
    };
    await rm(previewPath, { force: true });
    await rename(previewTemp, previewPath);
    const previewProbe = await probeMedia(toolchain.ffprobe, previewPath);
    await makeContactSheet(toolchain.ffmpeg, previewPath, durationFromProbe(previewProbe), contactSheetPath);

    const generationManifestPath = join(runDir, "generation-manifest.json");
    const mediaJobs = receiptSafeMediaJobs([...generated.map((entry) => entry.receipt), music.receipt]);
    await writeAtomic(generationManifestPath, {
      version: "buzzassist-narrated-story-generation-manifest-v1",
      jobId,
      inputs,
      channelConfig: {
        version: config.version,
        runtimeMetadata: config.runtimeMetadata,
        image: { provider: config.image.provider, model: config.image.model, adapterVersion: config.image.adapterVersion },
        voice: { provider: config.voice.provider, model: config.voice.model, adapterVersion: config.voice.adapterVersion, voiceId: config.voice.voiceId },
        music: { provider: config.music.provider, model: config.music.model, adapterVersion: config.music.adapterVersion },
        render: config.render,
      },
      segments: measuredSegments.map((segment) => ({
        id: segment.id,
        order: segment.order,
        textHash: segment.textHash,
        characterCount: segment.characterCount,
        durationSeconds: segment.durationSeconds,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        camera: {
          mode: "monotonic-zoom-with-horizontal-pan",
          direction: segment.order % 2 === 0 ? "left-to-right" : "right-to-left",
          frameCount: Math.max(1, Math.round(segment.durationSeconds * config.render.fps)),
        },
        imageSha256: byKey.get(`image:${segment.id}`).receipt.artifact.sha256,
        voiceSha256: byKey.get(`voice:${segment.id}`).receipt.artifact.sha256,
      })),
      mediaJobs,
      adapterProbes,
    }, { json: true });
    const audit = await automaticAudit({
      ffmpeg: toolchain.ffmpeg,
      ffprobe: toolchain.ffprobe,
      previewPath,
      voiceStemPath,
      bgmStemPath,
      expectedDuration: totalDuration,
      segments: measuredSegments.map((segment) => ({
        id: segment.id,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
      })),
      config,
      hashes: {
        script: inputs.script.sha256,
        channelPack: inputs.channelPack.sha256,
        generationManifest: await fileSha256(generationManifestPath),
        voiceStem: await fileSha256(voiceStemPath),
        bgmStem: await fileSha256(bgmStemPath),
      },
      renderGraphs,
    });
    const auditReportPath = join(auditDir, "automatic-audit.json");
    const perceptualAuditIds = new Set([
      "perceptualReviewChecks",
      "perceptualReviewBoundToOutput",
      "perceptualEvidenceHashes",
      "contactSheetOriginalDetailReviewed",
    ]);
    const automaticFailures = failedAuditIds(audit.checks).filter((auditId) => !perceptualAuditIds.has(auditId));
    await writeAtomic(auditReportPath, {
      version: NARRATED_STORY_AUDIT_VERSION,
      status: automaticFailures.length ? "failed" : "automatic-pass-awaiting-independent-signoff",
      jobId,
      auditChecks: audit.checks,
      probe: audit.probe,
      knownRemainingIssues: [
        ...automaticFailures.map((auditId) => `audit-${auditId}-failed`),
        "independent-contact-sheet-signoff-required",
      ],
    }, { json: true });
    const artifacts = await collectArtifacts({
      previewVideo: previewPath,
      subtitles: srtPath,
      voiceStem: voiceStemPath,
      bgmStem: bgmStemPath,
      masterAudio: masterAudioPath,
      generationManifest: generationManifestPath,
      auditReport: auditReportPath,
      contactSheet: contactSheetPath,
    });
    const state = {
      version: NARRATED_STORY_PIPELINE_VERSION,
      phase: "awaiting-human-review",
      jobId,
      inputs,
      runtimeMetadata: config.runtimeMetadata,
      adapterProbes,
      execution: { paidGenerationAttempted: true, providerCallsAttempted: true, legacyAssetFallbackUsed: false },
      mediaJobs,
      auditChecks: audit.checks,
      artifacts,
      review: {
        signoffPath: reviewSignoffPath,
        requiredVersion: NARRATED_STORY_SIGNOFF_VERSION,
        videoSha256: artifacts.previewVideo.sha256,
        contactSheetSha256: artifacts.contactSheet.sha256,
      },
    };
    await writeAtomic(statePath, state, { json: true });
    return finalizeReadyState({ state, statePath, signoffPath: reviewSignoffPath, ffmpeg: toolchain.ffmpeg, ...finalizeOptions });
  });
}
