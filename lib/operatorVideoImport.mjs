/**
 * 運営者が用意した短い動画を、来歴つきで公式経路へ取り込む（共有層。ジャンルに依存しない）。
 *
 * lib/operatorImageImport.mjs（運営者の画の取り込み）と同じ考え方の、動画の版。回ごとに運営者が外で作る・
 * 撮る動画（例: 冒頭の数秒の映像を Grok Imagine で作る、感想パートの人物を撮る）を、
 * 「どこで・どのモデルで・どのプロンプトで・いつ作ったか」と一緒に取り込む。費用は有料の Media Job に
 * 数えず「運営者の外部の契約」として記録する。
 *
 * 取り込みの記録（manifest、運営者が書く）の形:
 *
 *   {
 *     "version": "buzzassist-operator-video-manifest-v1",
 *     "clips": [{
 *       "slot": "episode-opening",                        // どこに使うか（ジャンルが決めた枠の名前）
 *       "video": { "path": "clips/opening.mp4", "sha256": "<64桁>" },
 *       "route": "grok",                                   // grok / chatgpt-web / codex / local-model / recorded / other
 *       "routeNote": "…",                                  // route が other のときだけ必須
 *       "modelLabel": "…",                                 // 生成した経路では必須（recorded は任意）
 *       "prompt": { "path": "prompts/opening.txt", "sha256": "<64桁>" },   // 生成した経路では必須
 *       "generatedAt": "2026-09-25T10:00:00+09:00",
 *       "conversationUrl": "https://…"                     // 任意。私有の Job フォルダにだけ残す
 *     }]
 *   }
 *
 * パスは manifest のあるフォルダからの相対（区切りは "/"）。フォルダの外・絶対パス・"\\"・".." は受けない。
 *
 * 守ること:
 *   - 検査は全部、有料の処理の前に理由コードつきで止める（sha256 の不一致・枠の過不足・尺・解像度・
 *     フレームレート・音の有無が枠の決まりに合わない）
 *   - 会話の URL・経路の注記の本文は、私有の Job フォルダの記録にだけ残す。公開面（生成記録・監査・
 *     RunReceipt・Canvas）へ出すのは sha256 と数値だけ
 *   - 取り込んだ動画は Job の作業フォルダへ写し、写しの sha256 を確かめてから描く（検査のあとで元の
 *     ファイルが差し替わっても、別の動画を黙って使わない）
 */

import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { renameWithRetry } from "./atomicJsonFile.mjs";
import {
  boundedText,
  conversationUrlOf,
  lowerSha,
  normalizedTimestamp,
  resolveManifestRelativePath,
} from "./operatorImageImport.mjs";

const execFile = promisify(execFileCallback);

export const OPERATOR_VIDEO_MANIFEST_VERSION = "buzzassist-operator-video-manifest-v1";
export const OPERATOR_VIDEO_IMPORT_VERSION = "buzzassist-operator-video-import-v1";
export const OPERATOR_VIDEO_PRIVATE_RECORD_VERSION = "buzzassist-operator-video-private-record-v1";
/** 経路。recorded は人が撮った映像（プロンプトもモデルも無い）。 */
export const OPERATOR_VIDEO_ROUTES = Object.freeze(["grok", "chatgpt-web", "codex", "local-model", "recorded", "other"]);
export const OPERATOR_VIDEO_COST_BASIS = "operator-external-contract";
export const OPERATOR_VIDEO_MANIFEST_FIELDS = Object.freeze({
  top: Object.freeze(["version", "clips", "note"]),
  clip: Object.freeze(["slot", "video", "route", "routeNote", "modelLabel", "prompt", "generatedAt", "conversationUrl"]),
  video: Object.freeze(["path", "sha256"]),
  prompt: Object.freeze(["path", "sha256"]),
});

const SLOT = /^[a-z][a-z0-9-]{0,47}$/u;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_PROMPT_BYTES = 1024 * 1024;
const MAX_CLIPS = 16;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

async function fileSha256Stream(file) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", () => resolvePromise(hash.digest("hex")));
  });
}

/** manifest のフォルダの中の普通のファイルか（シンボリックリンク・フォルダの外・大きすぎるものは受けない）。 */
async function insideFile(realBaseDir, full, maximumBytes) {
  let info;
  try {
    info = await lstat(full);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { ok: false, reason: "missing" };
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) return { ok: false, reason: "not-a-regular-file" };
  if (info.size === 0) return { ok: false, reason: "empty" };
  if (info.size > maximumBytes) return { ok: false, reason: "too-large" };
  const real = await realpath(full);
  const rel = path.relative(realBaseDir, real);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return { ok: false, reason: "outside-manifest-folder" };
  return { ok: true, realPath: real, bytes: info.size };
}

function frameRateOf(value) {
  const [numerator, denominator] = String(value || "").split("/").map(Number);
  if (!Number.isFinite(numerator) || numerator <= 0) return null;
  const rate = denominator ? numerator / denominator : numerator;
  return Number.isFinite(rate) && rate > 0 ? Math.round(rate * 1000) / 1000 : null;
}

/** ffprobe で動画の尺・寸法・フレームレート・音の有無を測る。読めなければ null。 */
export async function probeOperatorVideo(ffprobe, file) {
  try {
    const { stdout } = await execFile(ffprobe.command, [...(ffprobe.args || []),
      "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate",
      "-of", "json", file,
    ], { timeout: 60_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    const probe = JSON.parse(stdout);
    const video = (probe.streams || []).find((stream) => stream.codec_type === "video");
    if (!video) return null;
    return {
      durationSeconds: Math.max(0, Number(probe.format?.duration) || 0),
      width: Number(video.width) || 0,
      height: Number(video.height) || 0,
      frameRate: frameRateOf(video.avg_frame_rate) || frameRateOf(video.r_frame_rate),
      videoCodec: nonEmpty(video.codec_name),
      hasAudio: (probe.streams || []).some((stream) => stream.codec_type === "audio"),
    };
  } catch {
    return null;
  }
}

/**
 * manifest と、それが指すファイルを読み、実測の sha256 と動画の寸法を持った行を返す。枠の決まり（尺など）は
 * checkOperatorVideoImport が見る。digest は実測の sha256 から作る（動画を差し替えれば再開が気づく）。
 */
export async function readOperatorVideoManifest({ manifestPath, ffprobe, now = new Date() } = {}) {
  const base = { ok: false, manifestPath: "", manifestDir: "", manifestSha256: "", clips: [], bytes: null, digest: "" };
  if (!nonEmpty(manifestPath)) return { ...base, problems: ["operator-video-manifest-required"] };
  const absolute = path.resolve(nonEmpty(manifestPath));
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { ...base, manifestPath: absolute, problems: ["operator-video-manifest-missing"] };
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size === 0 || info.size > MAX_MANIFEST_BYTES) {
    return { ...base, manifestPath: absolute, problems: ["operator-video-manifest-unreadable"] };
  }
  const bytes = await readFile(absolute);
  const manifestSha256 = sha256(bytes);
  const manifestDir = await realpath(path.dirname(absolute));
  const result = { ...base, manifestPath: absolute, manifestDir, manifestSha256, bytes };
  let body;
  try {
    body = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { ...result, problems: ["operator-video-manifest-invalid:json"], digest: sha256(canonicalJson({ manifestSha256 })) };
  }
  if (!plainObject(body) || body.version !== OPERATOR_VIDEO_MANIFEST_VERSION) {
    return { ...result, problems: ["operator-video-manifest-version-unsupported"], digest: sha256(canonicalJson({ manifestSha256 })) };
  }
  const problems = [];
  for (const key of Object.keys(body)) if (!OPERATOR_VIDEO_MANIFEST_FIELDS.top.includes(key)) problems.push(`operator-video-manifest-invalid:${key}-unknown`);
  if (!Array.isArray(body.clips) || body.clips.length === 0 || body.clips.length > MAX_CLIPS) problems.push("operator-video-manifest-invalid:clips");
  const clips = [];
  const seen = new Set();
  for (const [index, entry] of (Array.isArray(body.clips) ? body.clips.slice(0, MAX_CLIPS) : []).entries()) {
    const at = `clips[${index}]`;
    if (!plainObject(entry)) { problems.push(`operator-video-manifest-invalid:${at}`); continue; }
    for (const key of Object.keys(entry)) if (!OPERATOR_VIDEO_MANIFEST_FIELDS.clip.includes(key)) problems.push(`operator-video-manifest-invalid:${at}.${key}-unknown`);
    const slot = nonEmpty(entry.slot);
    if (!SLOT.test(slot)) { problems.push(`operator-video-slot-invalid:${at}`); continue; }
    if (seen.has(slot)) { problems.push(`operator-video-slot-duplicated:${slot}`); continue; }
    seen.add(slot);
    const add = (code) => problems.push(`${code}:${slot}`);
    const clip = { slot, video: { sha256: "", declaredSha256: "", full: "", rel: "", bytes: 0 }, probe: null };
    if (!plainObject(entry.video)) add("operator-video-file-required");
    else {
      for (const key of Object.keys(entry.video)) if (!OPERATOR_VIDEO_MANIFEST_FIELDS.video.includes(key)) problems.push(`operator-video-manifest-invalid:${at}.video.${key}-unknown`);
      const resolved = resolveManifestRelativePath(manifestDir, entry.video.path);
      clip.video.declaredSha256 = lowerSha(entry.video.sha256);
      if (!clip.video.declaredSha256) add("operator-video-sha256-required");
      if (!resolved) add("operator-video-path-invalid");
      else {
        const read = await insideFile(manifestDir, resolved.full, MAX_VIDEO_BYTES);
        if (!read.ok) add(read.reason === "missing" ? "operator-video-file-missing" : "operator-video-file-unreadable");
        else {
          clip.video.full = read.realPath;
          clip.video.rel = resolved.rel;
          clip.video.bytes = read.bytes;
          clip.video.sha256 = await fileSha256Stream(read.realPath);
          if (clip.video.declaredSha256 && clip.video.declaredSha256 !== clip.video.sha256) add("operator-video-sha256-mismatch");
          clip.probe = ffprobe ? await probeOperatorVideo(ffprobe, read.realPath) : null;
          if (ffprobe && !clip.probe) add("operator-video-unprobeable");
        }
      }
    }
    clip.route = nonEmpty(entry.route);
    if (!OPERATOR_VIDEO_ROUTES.includes(clip.route)) add("operator-video-route-invalid");
    clip.routeNote = entry.routeNote === undefined ? "" : boundedText(entry.routeNote);
    if (entry.routeNote !== undefined && !clip.routeNote) add("operator-video-route-note-invalid");
    if (clip.route === "other" && !clip.routeNote) add("operator-video-route-note-required");
    const generated = clip.route !== "recorded";
    clip.modelLabel = entry.modelLabel === undefined ? "" : boundedText(entry.modelLabel, 120);
    if (generated && !clip.modelLabel) add("operator-video-model-label-required");
    clip.prompt = { sha256: "", declaredSha256: "", full: "", rel: "" };
    if (entry.prompt !== undefined || generated) {
      if (!plainObject(entry.prompt)) add("operator-video-prompt-required");
      else {
        for (const key of Object.keys(entry.prompt)) if (!OPERATOR_VIDEO_MANIFEST_FIELDS.prompt.includes(key)) problems.push(`operator-video-manifest-invalid:${at}.prompt.${key}-unknown`);
        const resolved = resolveManifestRelativePath(manifestDir, entry.prompt.path);
        clip.prompt.declaredSha256 = lowerSha(entry.prompt.sha256);
        if (!clip.prompt.declaredSha256) add("operator-video-prompt-sha256-required");
        if (!resolved) add("operator-video-prompt-path-invalid");
        else {
          const read = await insideFile(manifestDir, resolved.full, MAX_PROMPT_BYTES);
          if (!read.ok) add(read.reason === "missing" ? "operator-video-prompt-missing" : "operator-video-prompt-unreadable");
          else {
            const text = await readFile(read.realPath);
            clip.prompt.full = read.realPath;
            clip.prompt.rel = resolved.rel;
            clip.prompt.sha256 = sha256(text);
            if (!text.toString("utf8").trim()) add("operator-video-prompt-empty");
            if (clip.prompt.declaredSha256 && clip.prompt.declaredSha256 !== clip.prompt.sha256) add("operator-video-prompt-sha256-mismatch");
          }
        }
      }
    }
    const time = normalizedTimestamp(entry.generatedAt, now);
    clip.generatedAt = time.ok ? time.value : "";
    if (!time.ok) add("operator-video-generated-at-invalid");
    else if (time.future) add("operator-video-generated-at-in-future");
    const url = conversationUrlOf(entry.conversationUrl);
    clip.conversationUrl = url.ok ? url.value : "";
    clip.conversationUrlSha256 = url.ok ? url.sha256 : "";
    if (url.present && !url.ok) add("operator-video-conversation-url-invalid");
    clips.push(clip);
  }
  const digest = sha256(canonicalJson({
    version: OPERATOR_VIDEO_IMPORT_VERSION,
    manifestSha256,
    files: clips.map((clip) => ({ slot: clip.slot, video: clip.video.sha256, prompt: clip.prompt.sha256 })),
  }));
  return { ...result, ok: problems.length === 0, clips, problems: [...new Set(problems)], digest };
}

/**
 * 枠ごとの決まり（ジャンルが Pack の宣言から作る）に当てて、止める理由を返す。
 * slots: { <slot>: { required, minSeconds, maxSeconds, minWidth, minHeight, aspect, aspectTolerance, requireAudio } }
 * 決まりの無い枠の動画は止める（どこに使うつもりか分からない動画を黙って捨てない）。
 */
export function checkOperatorVideoImport({ manifest, slots = {} }) {
  const issues = [...(manifest?.problems || [])];
  const bySlot = new Map((manifest?.clips || []).map((clip) => [clip.slot, clip]));
  for (const [slot, rule] of Object.entries(slots)) {
    const clip = bySlot.get(slot);
    if (!clip) {
      if (rule.required) issues.push(`operator-video-slot-missing:${slot}`);
      continue;
    }
    const probe = clip.probe;
    if (!probe) continue;
    if (rule.minSeconds !== undefined && probe.durationSeconds < rule.minSeconds) issues.push(`operator-video-too-short:${slot}`);
    if (rule.maxSeconds !== undefined && probe.durationSeconds > rule.maxSeconds) issues.push(`operator-video-too-long:${slot}`);
    if (rule.minWidth && probe.width < rule.minWidth) issues.push(`operator-video-too-small:${slot}`);
    if (rule.minHeight && probe.height < rule.minHeight) issues.push(`operator-video-too-small:${slot}`);
    if (rule.aspect && probe.width && probe.height && Math.abs(probe.width / probe.height - rule.aspect) / rule.aspect > (rule.aspectTolerance ?? 0.02)) {
      issues.push(`operator-video-aspect-mismatch:${slot}`);
    }
    if (!probe.frameRate || probe.frameRate < 10 || probe.frameRate > 120) issues.push(`operator-video-frame-rate-unsupported:${slot}`);
    if (rule.requireAudio && !probe.hasAudio) issues.push(`operator-video-audio-required:${slot}`);
  }
  for (const slot of bySlot.keys()) if (!slots[slot]) issues.push(`operator-video-slot-unexpected:${slot}`);
  return { ok: issues.length === 0, issues: [...new Set(issues)] };
}

/** 公開面へ出す取り込みの記録（sha256・数値・経路だけ）。 */
function publicClip(clip, copy) {
  return {
    slot: clip.slot,
    route: clip.route,
    modelLabel: clip.modelLabel || null,
    generatedAt: clip.generatedAt,
    source: { sha256: clip.video.sha256, bytes: clip.video.bytes },
    probe: clip.probe,
    promptSha256: clip.prompt.sha256 || null,
    conversationUrlSha256: clip.conversationUrlSha256 || null,
    routeNoteSha256: clip.routeNote ? sha256(clip.routeNote) : null,
    copySha256: copy.sha256,
    paidMediaJob: false,
    costBasis: OPERATOR_VIDEO_COST_BASIS,
  };
}

/**
 * 検査を通った取り込みを、Job の作業フォルダへ写す（outputDir）。会話の URL・注記の本文と manifest・
 * プロンプトの写しは privateDir（私有の Job フォルダ）にだけ置く。写しの sha256 を確かめてから返す。
 */
export async function materializeOperatorVideos({ manifest, outputDir, privateDir, now = () => new Date().toISOString() }) {
  const issues = [];
  const clips = new Map();
  await mkdir(outputDir, { recursive: true });
  await mkdir(path.join(privateDir, "prompts"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(privateDir, "manifest.json"), manifest.bytes, { mode: 0o600 });
  const privateClips = [];
  for (const clip of manifest.clips) {
    const extension = path.extname(clip.video.full).toLowerCase() || ".mp4";
    const target = path.join(outputDir, `${clip.slot}${extension}`);
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp${extension}`;
    try {
      await copyFile(clip.video.full, temp);
      const copied = await fileSha256Stream(temp);
      if (copied !== clip.video.sha256) {
        issues.push(`operator-video-changed-during-import:${clip.slot}`);
        continue;
      }
      await renameWithRetry(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
    if (clip.prompt.full) await copyFile(clip.prompt.full, path.join(privateDir, "prompts", `${clip.slot}.txt`));
    const copy = { path: target, sha256: clip.video.sha256 };
    clips.set(clip.slot, { ...copy, probe: clip.probe, public: publicClip(clip, copy) });
    privateClips.push({
      slot: clip.slot,
      conversationUrl: clip.conversationUrl || null,
      routeNote: clip.routeNote || null,
      source: { sha256: clip.video.sha256, relativePath: clip.video.rel },
      prompt: clip.prompt.sha256 ? { sha256: clip.prompt.sha256, relativePath: clip.prompt.rel } : null,
    });
  }
  if (issues.length > 0) return { ok: false, issues, clips, publicRecord: null };
  const publicRecord = {
    version: OPERATOR_VIDEO_IMPORT_VERSION,
    manifestSha256: manifest.manifestSha256,
    digest: manifest.digest,
    paidMediaJobs: 0,
    costBasis: OPERATOR_VIDEO_COST_BASIS,
    clips: [...clips.values()].map((entry) => entry.public),
  };
  await writeFile(path.join(privateDir, "import-record.json"), `${JSON.stringify({
    version: OPERATOR_VIDEO_PRIVATE_RECORD_VERSION,
    note: "私有の Job フォルダの記録。会話の URL・注記の本文はここにだけ残す（公開面は sha256 だけ）。",
    importedAt: now(),
    manifestSha256: manifest.manifestSha256,
    digest: manifest.digest,
    publicRecordSha256: sha256(canonicalJson(publicRecord)),
    clips: privateClips,
  }, null, 2)}\n`, { mode: 0o600 });
  return { ok: true, issues: [], clips, publicRecord };
}

export { fileSha256Stream as operatorVideoFileSha256 };
