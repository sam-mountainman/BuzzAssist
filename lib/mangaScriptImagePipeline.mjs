import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import PQueue from "p-queue";

import {
  AdaptiveConcurrencyController,
  USAGE_LIMIT_SIGNAL,
  classifyGenerationError,
  runWithAdaptiveConcurrency,
} from "./adaptiveConcurrency.mjs";

import {
  getImageDimensionsFromBuffer,
  readJsonIfExists,
  resolveCanvasDir,
  writeJsonAtomic,
} from "./canvasScene.mjs";
import {
  buildCharacterCandidateJobs,
  markCharacterCandidatesGenerating,
  prepareCharacterWorkflow,
  recordCharacterCandidateResults,
} from "./characterPipeline.mjs";
import {
  findCharacter,
  normalizeCharacterRegistry,
  readCharacterRegistry,
  resolveCharacterReferencePaths,
} from "./characterRegistry.mjs";
import { classifyMangaEditorialBeat } from "./mangaEditorialGrammar.mjs";
import {
  DEFAULT_IMAGE_MODEL,
  generateImageMedia,
  normalizeMediaBatchConcurrency,
  runWithConcurrency,
} from "./mediaGeneration.mjs";
import { mangaVideoJobInputHash, parseMangaScript } from "./mangaVideoPipeline.mjs";
import {
  buildMangaSceneImagePrompt,
  MANGA_COMPOSITION_SETUPS,
  planMangaSceneCompositions,
} from "./mangaSceneComposition.mjs";

export const MANGA_SCRIPT_IMAGE_PIPELINE_VERSION = 1;
export const DEFAULT_SCRIPT_IMAGE_CONCURRENCY = "auto";
export const DEFAULT_SCRIPT_QA_CONCURRENCY = 12;
export const DEFAULT_SCRIPT_IMAGE_RETRIES = 1;

const execFileAsync = promisify(execFile);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PLATE_TYPES = new Set(["white-solid", "black-solid", "pastel-sky"]);
const VISUAL_QA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pass", "score", "hardFailures", "issues", "strengths"],
  properties: {
    pass: { type: "boolean" },
    score: { type: "integer", minimum: 0, maximum: 100 },
    hardFailures: { type: "array", items: { type: "string" } },
    issues: { type: "array", items: { type: "string" } },
    strengths: { type: "array", items: { type: "string" } },
  },
};
const LOCATION_RULES = [
  { id: "photo-shop", name: "写真店", pattern: /写真店|写真館|現像|暗室|プリンタ|カウンター/u },
  { id: "home", name: "自宅", pattern: /自宅|家|部屋|寝室|リビング|台所/u },
  { id: "school", name: "学校", pattern: /学校|教室|廊下|校庭/u },
  { id: "office", name: "職場", pattern: /職場|会社|事務所|オフィス/u },
  { id: "street", name: "街路", pattern: /街|路地|商店街|駅前|道路|歩道/u },
  { id: "park", name: "公園", pattern: /公園|遊具|広場/u },
  { id: "restaurant", name: "飲食店", pattern: /飲食店|レストラン|喫茶店|カフェ/u },
];

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function pad2(value) {
  return String(Math.max(0, Math.round(Number(value) || 0))).padStart(2, "0");
}

function slug(value, fallback = "episode") {
  const normalized = nonEmptyString(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return normalized || fallback;
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

async function fileExists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function normalizeScriptImageConcurrency(value = DEFAULT_SCRIPT_IMAGE_CONCURRENCY) {
  const raw = String(value ?? DEFAULT_SCRIPT_IMAGE_CONCURRENCY).trim().toLowerCase();
  if (!raw || raw === "auto") return { mode: "auto", initial: 16, label: "auto" };
  if (raw === "unlimited") return { mode: "unlimited", initial: 64, label: "unlimited" };
  const limit = normalizeMediaBatchConcurrency(Number(raw), 16);
  return { mode: "fixed", fixedLimit: limit, initial: limit, label: String(limit) };
}

async function runGenerationJobs(items, concurrencySpec, worker, options = {}) {
  if (concurrencySpec.mode === "fixed") {
    return runWithConcurrency(items, concurrencySpec.fixedLimit, worker, { jobId: options.jobId });
  }
  const controller = options.controller || new AdaptiveConcurrencyController({ mode: concurrencySpec.mode });
  const outcomes = await runWithAdaptiveConcurrency(
    items.map((item, index) => () => worker(item, index)),
    controller,
    options.adaptiveRunOptions,
  );
  return outcomes.map((outcome) => outcome?.ok
    ? outcome
    : { ...outcome, error: outcome?.error instanceof Error ? outcome.error.message : String(outcome?.error || "Unknown generation failure") });
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** Deterministic characterless graphic plates; no model can accidentally add a person. */
export function renderEditorialPlatePng(type, width = 1920, height = 1080) {
  if (!PLATE_TYPES.has(type)) throw new Error(`Unsupported editorial plate type: ${type}`);
  const w = Math.max(16, Math.round(Number(width) || 1920));
  const h = Math.max(16, Math.round(Number(height) || 1080));
  const rows = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const row = y * (w * 4 + 1);
    rows[row] = 0;
    const t = h <= 1 ? 0 : y / (h - 1);
    for (let x = 0; x < w; x += 1) {
      const index = row + 1 + x * 4;
      let r = type === "black-solid" ? 0 : 255;
      let g = r;
      let b = r;
      if (type === "pastel-sky") {
        const top = [251, 230, 244];
        const bottom = [150, 210, 249];
        r = Math.round(top[0] * (1 - t) + bottom[0] * t);
        g = Math.round(top[1] * (1 - t) + bottom[1] * t);
        b = Math.round(top[2] * (1 - t) + bottom[2] * t);
        const glow = Math.max(0, 1 - Math.hypot((x / w - 0.22) / 0.22, (t - 0.1) / 0.16));
        r = Math.min(255, Math.round(r + glow * 16));
        g = Math.min(255, Math.round(g + glow * 20));
        b = Math.min(255, Math.round(b + glow * 18));
      }
      rows[index] = r;
      rows[index + 1] = g;
      rows[index + 2] = b;
      rows[index + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(rows, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function inferLocation(cut = {}) {
  const source = `${cut.purpose || ""} ${cut.utterances?.map((entry) => entry.text).join(" ") || ""}`;
  const explicit = source.match(/(?:場所|ロケーション|location)\s*[：:]\s*([^、。\n]{1,40})/iu)?.[1]?.trim();
  if (explicit) return { id: slug(explicit, `location-${cut.number}`), name: explicit };
  return LOCATION_RULES.find((rule) => rule.pattern.test(source)) || { id: "primary-location", name: "主要舞台" };
}

function registryCharacterForSpeaker(registry, utterance) {
  return findCharacter(registry, utterance.speakerId) || findCharacter(registry, utterance.speakerName);
}

function compositionForPanel(base, panelIndex, recentIds = []) {
  const baseIndex = Math.max(0, MANGA_COMPOSITION_SETUPS.findIndex((entry) => entry.id === base.setup.id));
  const offsets = [0, 7, 13];
  let setup = MANGA_COMPOSITION_SETUPS[(baseIndex + offsets[panelIndex % offsets.length]) % MANGA_COMPOSITION_SETUPS.length];
  if (recentIds.includes(setup.id)) {
    setup = MANGA_COMPOSITION_SETUPS[(baseIndex + offsets[panelIndex % offsets.length] + 3) % MANGA_COMPOSITION_SETUPS.length];
  }
  return {
    ...base,
    id: `${base.id}:panel-${panelIndex + 1}`,
    setup,
    bubbleReserve: "reserve a clean interior pocket, but generate no bubble or readable text",
  };
}

function editorialClassification(utterance, cut, index) {
  const visibleParticipantCount = unique(cut.utterances
    .map((entry) => entry.speakerId)
    .filter((id) => id && id !== "narration")).length;
  return classifyMangaEditorialBeat({
    utterance,
    openingExposition: index < 2 && utterance.preset === "narration",
    allowNeutralPlate: true,
    allowThoughtInference: true,
    visibleParticipantCount,
    montageBeatCount: /(?:翌|その後|それから|各地|日々|年月)/u.test(utterance.text) ? 3 : 0,
  });
}

function visualBeatPrompt(beat, context, editorial, panelRole = "") {
  const additions = [
    buildMangaSceneImagePrompt(beat, context),
    panelRole ? `Panel story role: ${panelRole}. Make it a distinct viewpoint and moment, not a duplicate pose.` : "",
    editorial.thoughtFocus.recommended
      ? "Private-thought staging: keep the whole scene normally illustrated; post-production will dim the surroundings and reveal only a face-sized spotlight. Keep the thinking face unobstructed."
      : "",
    "Do not draw speech balloons or lettering. Typography and bubbles are deterministic overlays added after generation.",
  ];
  return additions.filter(Boolean).join("\n");
}

/**
 * Converts one parsed script into every required visual job before generation.
 * Every paid image job is exactly one image; the worker pool controls concurrency.
 */
export function createMangaScriptImagePlan(input = {}) {
  const scriptText = String(input.scriptText ?? "");
  const registry = normalizeCharacterRegistry(input.registry && typeof input.registry === "object" ? input.registry : null);
  const parsed = input.parsed || parseMangaScript(scriptText, { title: input.title, registry });
  if (parsed.utterances.length === 0) throw new Error("The script contains no dialogue/narration lines in 'name: text' form.");
  const episodeId = nonEmptyString(input.episodeId) || slug(parsed.title, `episode-${sha256(scriptText).slice(0, 8)}`);
  const manifest = {
    id: episodeId,
    title: parsed.title,
    scriptText,
    cuts: parsed.cuts.map((cut) => ({
      ...cut,
      description: cut.purpose,
      utteranceIds: cut.utterances.map((entry) => entry.id),
    })),
    utterances: parsed.utterances,
  };
  const compositionPlan = planMangaSceneCompositions({ manifest });
  const compositionByUtterance = new Map(compositionPlan.beats.map((entry) => [entry.utteranceId, entry]));
  const assetDir = resolve(nonEmptyString(input.assetDir) || join(process.cwd(), "canvas", "assets", slug(episodeId)));
  const canvasDir = resolve(nonEmptyString(input.canvasDir) || dirname(dirname(assetDir)));
  const jobs = [];
  const pages = [];
  const editorialDecisions = [];
  const environmentJobByLocation = new Map();
  let globalIndex = 0;

  for (const cut of parsed.cuts) {
    const location = inferLocation(cut);
    const registryLocation = registry.characters?.find((entry) => entry.kind === "location" && (
      entry.id === location.id || entry.name === location.name || entry.aliases?.includes(location.name)
    ));
    let locationRefs = registryLocation
      ? resolveCharacterReferencePaths(registry, [registryLocation.id], { canvasDir })
      : [];
    let environmentDependency = "";
    const cutCharacterIds = unique(cut.utterances.map((entry) => registryCharacterForSpeaker(registry, entry)?.id));
    const characterRefs = resolveCharacterReferencePaths(registry, cutCharacterIds, { canvasDir });
    const castNames = unique(cut.utterances
      .filter((entry) => entry.speakerId !== "narration")
      .map((entry) => entry.speakerName));

    for (const utterance of cut.utterances) {
      const beat = compositionByUtterance.get(utterance.id);
      const editorial = editorialClassification(utterance, cut, globalIndex);
      editorialDecisions.push(editorial);
      const stem = `${cut.id}-${utterance.id.replace(`${cut.id}-`, "")}`;
      if (editorial.editorialPlate.recommended) {
        const outputPath = join(assetDir, `${stem}-${editorial.editorialPlate.type}.png`);
        jobs.push({
          id: `plate:${utterance.id}`,
          kind: "editorial-plate",
          dependencies: [],
          outputPath,
          plateType: editorial.editorialPlate.type,
          imageCount: 0,
          inputHash: mangaVideoJobInputHash("editorial-plate", { type: editorial.editorialPlate.type, width: 1920, height: 1080 }),
          editorial,
        });
        pages.push({ utteranceId: utterance.id, cutId: cut.id, assetJobId: `plate:${utterance.id}`, editorial, wholePageCamera: true });
        globalIndex += 1;
        continue;
      }

      if (locationRefs.length === 0) {
        let environmentJob = environmentJobByLocation.get(location.id);
        if (!environmentJob) {
          const outputPath = join(assetDir, `reference-environment-${slug(location.id, "primary-location")}.png`);
          environmentJob = {
            id: `environment-sheet:${location.id}`,
            kind: "environment-sheet",
            dependencies: [],
            outputPath,
            prompt: [
              "Create one original 16:9 Japanese motion-comic ENVIRONMENT REFERENCE ATLAS, 1920x1080.",
              `Location: ${location.name}. Episode context: ${parsed.title}.`,
              "Show four clean panels of exactly the same place: establishing view, reverse view, side view, and important prop/detail view.",
              "Lock architecture, doors, windows, furniture, permanent props, palette, material finish, time-of-day baseline, and light direction across all four panels.",
              "No people, no character silhouettes, no speech bubbles, no captions, no readable signs, no logo, no watermark.",
              "This is a continuity atlas, not a dramatic story frame. Keep useful empty space and complete environmental coverage.",
            ].join("\n"),
            referenceImagePaths: [],
            model: nonEmptyString(input.model) || DEFAULT_IMAGE_MODEL,
            aspectRatio: "16:9",
            imageSize: "2K",
            quality: "high",
            imageCount: 1,
            location,
          };
          environmentJob.inputHash = mangaVideoJobInputHash("environment-sheet", {
            prompt: environmentJob.prompt,
            model: environmentJob.model,
            location,
            imageCount: 1,
          });
          environmentJobByLocation.set(location.id, environmentJob);
          jobs.push(environmentJob);
        }
        environmentDependency = environmentJob.id;
        locationRefs = [environmentJob.outputPath];
      }

      const splitCount = editorial.split.type === "story-3" ? 3 : editorial.split.type === "vertical-2" ? 2 : 1;
      const panelJobs = [];
      const panelRoles = splitCount === 3 ? ["cause / earlier moment", "action / intermediate moment", "consequence / later moment"] : ["speaker or cause", "listener reaction or consequence"];
      for (let panelIndex = 0; panelIndex < splitCount; panelIndex += 1) {
        const panelBeat = splitCount > 1 ? compositionForPanel(beat, panelIndex, panelJobs.map((job) => job.composition.setup.id)) : beat;
        const id = splitCount > 1 ? `panel:${utterance.id}:${panelIndex + 1}` : `image:${utterance.id}`;
        const outputPath = join(assetDir, splitCount > 1 ? `${stem}-panel-${panelIndex + 1}.png` : `${stem}.png`);
        const prompt = visualBeatPrompt(panelBeat, {
          location: location.name,
          cast: castNames,
          continuity: "preserve approved identity sheets, clothing, props, time of day, and the established geography; vary viewpoint and blocking from adjacent images",
        }, editorial, splitCount > 1 ? panelRoles[panelIndex] : "");
        const referenceImagePaths = unique([...characterRefs, ...locationRefs]).slice(0, 8);
        const job = {
          id,
          kind: splitCount > 1 ? "split-panel" : "scene-image",
          dependencies: environmentDependency ? [environmentDependency] : [],
          outputPath,
          prompt,
          referenceImagePaths,
          model: nonEmptyString(input.model) || DEFAULT_IMAGE_MODEL,
          aspectRatio: "16:9",
          imageSize: "2K",
          quality: "high",
          imageCount: 1,
          composition: panelBeat,
          editorial,
          location,
          characterIds: cutCharacterIds,
        };
        job.inputHash = mangaVideoJobInputHash(job.kind, {
          prompt: job.prompt,
          referenceImagePaths: job.referenceImagePaths,
          model: job.model,
          imageCount: 1,
        });
        jobs.push(job);
        panelJobs.push(job);
      }
      if (splitCount > 1) {
        const pageId = `split-page:${utterance.id}`;
        const outputPath = join(assetDir, `${stem}-${editorial.split.type}.png`);
        const pageJob = {
          id: pageId,
          kind: "split-page",
          dependencies: panelJobs.map((entry) => entry.id),
          panelPaths: panelJobs.map((entry) => entry.outputPath),
          referenceImagePaths: unique(panelJobs.flatMap((entry) => entry.referenceImagePaths || [])).slice(0, 4),
          outputPath,
          splitType: editorial.split.type,
          separatorWidthRatio: editorial.split.separatorWidthRatio,
          imageCount: 0,
          editorial,
          inputHash: mangaVideoJobInputHash("split-page", {
            inputs: panelJobs.map((entry) => entry.inputHash),
            splitType: editorial.split.type,
            separatorWidthRatio: editorial.split.separatorWidthRatio,
            flattenBeforeCamera: true,
          }),
        };
        jobs.push(pageJob);
        pages.push({
          utteranceId: utterance.id,
          cutId: cut.id,
          assetJobId: pageId,
          editorial,
          panelJobIds: panelJobs.map((entry) => entry.id),
          panelCamera: "static",
          flattenBeforeCamera: true,
          wholePageCamera: true,
        });
      } else {
        pages.push({ utteranceId: utterance.id, cutId: cut.id, assetJobId: panelJobs[0].id, editorial, wholePageCamera: true });
      }
      globalIndex += 1;
    }
  }
  const jobById = new Map(jobs.map((entry) => [entry.id, entry]));
  return {
    version: MANGA_SCRIPT_IMAGE_PIPELINE_VERSION,
    episodeId,
    title: parsed.title,
    scriptSha256: sha256(scriptText),
    assetDir,
    manifest,
    compositionPlan,
    editorialDecisions,
    jobs,
    pages: pages.map((entry) => ({ ...entry, outputPath: jobById.get(entry.assetJobId)?.outputPath })),
    policy: {
      allJobsSubmittedUpFront: true,
      paidImageCountPerJob: 1,
      maximumConcurrency: 10,
      adjacentCompositionMinimumChangedAxes: 3,
      repeatedSetupLookback: 6,
      typographyGeneratedInImage: false,
      splitComposition: "generate-panels-independently; deterministic-black-gutters; flatten-page-before-camera",
      splitPanelCamera: "static",
      splitPageCamera: "single-continuous",
      editorialPlateCharacterPolicy: "strictly-none",
    },
  };
}

async function composeSplitPage(job) {
  const gutter = Math.max(8, Math.round(1920 * Number(job.separatorWidthRatio || 0.0145)));
  const inputs = job.panelPaths.flatMap((path) => ["-i", path]);
  let filter;
  if (job.splitType === "story-3") {
    const leftW = Math.round(1920 * 0.39);
    const rightX = leftW + gutter;
    const rightW = 1920 - rightX;
    const topH = Math.round((1080 - gutter) * 0.52);
    const bottomY = topH + gutter;
    const bottomH = 1080 - bottomY;
    filter = [
      `[0:v]scale=${leftW}:1080:force_original_aspect_ratio=increase,crop=${leftW}:1080[p0]`,
      `[1:v]scale=${rightW}:${topH}:force_original_aspect_ratio=increase,crop=${rightW}:${topH}[p1]`,
      `[2:v]scale=${rightW}:${bottomH}:force_original_aspect_ratio=increase,crop=${rightW}:${bottomH}[p2]`,
      `color=c=black:s=1920x1080[base]`,
      `[base][p0]overlay=0:0[b1]`,
      `[b1][p1]overlay=${rightX}:0[b2]`,
      `[b2][p2]overlay=${rightX}:${bottomY}[out]`,
    ].join(";");
  } else {
    const leftW = Math.round((1920 - gutter) * 0.47);
    const rightX = leftW + gutter;
    const rightW = 1920 - rightX;
    filter = [
      `[0:v]scale=${leftW}:1080:force_original_aspect_ratio=increase,crop=${leftW}:1080[p0]`,
      `[1:v]scale=${rightW}:1080:force_original_aspect_ratio=increase,crop=${rightW}:1080[p1]`,
      `color=c=black:s=1920x1080[base]`,
      `[base][p0]overlay=0:0[b1]`,
      `[b1][p1]overlay=${rightX}:0[out]`,
    ].join(";");
  }
  await mkdir(dirname(job.outputPath), { recursive: true });
  await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", filter, "-map", "[out]", "-frames:v", "1", job.outputPath]);
  return { outputPath: job.outputPath };
}

async function defaultTechnicalQa(job) {
  const buffer = await readFile(job.outputPath);
  const dimensions = getImageDimensionsFromBuffer(buffer, job.outputPath);
  const aspect = dimensions.width / dimensions.height;
  const issues = [];
  if (buffer.length < 1024) issues.push("image file is unexpectedly small");
  if (Math.abs(aspect - 16 / 9) > 0.04) issues.push(`aspect ratio is ${aspect.toFixed(3)}, expected 16:9`);
  if (job.kind === "split-page" && (dimensions.width !== 1920 || dimensions.height !== 1080)) issues.push("flattened split page is not 1920x1080");
  return { pass: issues.length === 0, issues, dimensions, checks: ["decode", "file-size", "aspect-ratio", "split-page-size"] };
}

async function runQaCommand(command, payload) {
  if (!nonEmptyString(command)) return null;
  const { stdout } = await execFileAsync("/bin/sh", ["-lc", command], {
    env: { ...process.env, BUZZASSIST_IMAGE_QA_INPUT: JSON.stringify(payload) },
    maxBuffer: 10 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout.trim());
  return { pass: parsed.pass === true, issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [], evaluator: "external-command" };
}

function spawnToCompletion(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Process timed out after ${options.timeoutMs}ms: ${command}`));
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) reject(new Error(`${command} exited ${code}: ${errorOutput || output}`.slice(0, 16_000)));
      else resolvePromise({ stdout: output, stderr: errorOutput });
    });
    child.stdin.end();
  });
}

async function runCodexVisualQa(payload, options = {}) {
  const qaDir = resolve(nonEmptyString(options.qaDir) || join(dirname(payload.outputPath), ".qa"));
  await mkdir(qaDir, { recursive: true });
  const schemaPath = join(qaDir, "visual-qa-schema.json");
  const outputPath = join(qaDir, `${slug(payload.job.id, "image")}-attempt-${payload.attempt + 1}.json`);
  if (!await fileExists(schemaPath)) await writeFile(schemaPath, `${JSON.stringify(VISUAL_QA_SCHEMA, null, 2)}\n`, "utf8");
  const expected = payload.job.kind === "editorial-plate"
    ? `A strict ${payload.job.plateType} characterless editorial plate. No room, scenery, person, silhouette, text, logo, or watermark.`
    : payload.job.kind === "split-page"
      ? `A finished ${payload.job.splitType} manga page with intentional black gutters. Judge the entire page as one composition; panel contents must be coherent and distinct.`
      : payload.job.kind === "environment-sheet"
        ? `A consistent four-view environment atlas for ${payload.job.location?.name || "the location"}, with no people or readable text.`
        : [
            payload.job.composition?.purpose,
            payload.job.composition?.visibleAction,
            payload.job.composition?.setup ? `Camera: ${JSON.stringify(payload.job.composition.setup)}` : "",
            payload.job.editorial?.thoughtFocus?.recommended ? "The face must remain clear for a compact post-production thought spotlight." : "",
          ].filter(Boolean).join(" ");
  const prompt = [
    "You are a fresh blind visual quality evaluator. The FIRST attached image is the generated candidate. Any later attached images are approved identity/environment references used only for consistency comparison.",
    "Do not edit files, do not generate an image, do not browse, and do not infer credit for invisible intentions.",
    `Job kind: ${payload.job.kind}. Expected result: ${expected}`,
    "Hard-fail any: unreadable or generated text, speech bubble baked into artwork, wrong number of panels, missing black divider, character on a strict editorial plate, broken anatomy/hand/face, duplicated body parts, wrong cast count, severe identity drift, obvious reference-camera copying, incoherent environment, or requested action/camera not visibly delivered.",
    "Also penalize generic centered eye-level staging, excessive empty accidental space, repeated-looking poses, weak subject hierarchy, and panel-to-panel inconsistency.",
    "For split pages, the panel images themselves must remain static and the result must already be one flattened page; do not request separate panel motion.",
    "Set pass=true only at score 88 or higher with zero hardFailures. Return concise, actionable Japanese issue strings so a correction prompt can fix them.",
  ].join("\n");
  const comparisonReferences = [];
  for (const candidate of payload.job.referenceImagePaths || []) {
    if (comparisonReferences.length >= 4) break;
    if (candidate !== payload.outputPath && await fileExists(candidate)) comparisonReferences.push(candidate);
  }
  const cliArgs = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox", "read-only",
    "--skip-git-repo-check",
    "--image", payload.outputPath, ...comparisonReferences,
    "--output-schema", schemaPath,
    "--output-last-message", outputPath,
    "--color", "never",
    "--json",
    ...(nonEmptyString(options.model) ? ["--model", options.model] : []),
    prompt,
  ];
  const processResult = await spawnToCompletion(nonEmptyString(options.codexCommand) || "codex", cliArgs, {
    cwd: resolve(nonEmptyString(options.projectDir) || process.cwd()),
    timeoutMs: Math.max(30_000, Number(options.timeoutMs) || 10 * 60_000),
  });
  let rawResult = await fileExists(outputPath) ? await readFile(outputPath, "utf8") : "";
  if (!rawResult.trim()) {
    const events = processResult.stdout.split("\n").map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    rawResult = [...events].reverse().find((event) => event.type === "item.completed" && event.item?.type === "agent_message")?.item?.text || "";
  }
  if (!rawResult.trim()) throw new Error("Codex visual QA completed without a structured verdict.");
  const parsed = JSON.parse(rawResult);
  const hardFailures = Array.isArray(parsed.hardFailures) ? parsed.hardFailures.map(String) : [];
  const issues = Array.isArray(parsed.issues) ? parsed.issues.map(String) : [];
  const rawScore = Number(parsed.score);
  const score = rawScore >= 0 && rawScore <= 1 && parsed.pass === true ? rawScore * 100 : rawScore;
  return {
    pass: parsed.pass === true && Number.isFinite(score) && score >= 88 && hardFailures.length === 0,
    score,
    hardFailures,
    issues: [...hardFailures, ...issues],
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.map(String) : [],
    evaluator: "codex-ephemeral-blind-vision",
  };
}

function correctivePrompt(job, qa) {
  const issues = qa?.issues?.length ? qa.issues.join("; ") : "the previous image failed the visual quality contract";
  return `${job.prompt}\n\nCORRECTION PASS: Fix these failures: ${issues}. Preserve identity and story meaning. Do not repeat the previous defect. No speech balloon, captions, readable text, logo, or watermark.`;
}

function ledgerState(plan, previous = {}) {
  const jobs = previous.jobs && typeof previous.jobs === "object" ? previous.jobs : {};
  return {
    version: MANGA_SCRIPT_IMAGE_PIPELINE_VERSION,
    episodeId: plan.episodeId,
    scriptSha256: plan.scriptSha256,
    planFile: previous.planFile || "",
    status: "running",
    startedAt: previous.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    jobs,
    summary: {},
  };
}

async function writeGeneratedMedia(media, outputPath) {
  const buffer = media?.buffer instanceof Buffer ? media.buffer : media?.buffer ? Buffer.from(media.buffer) : null;
  if (!buffer) throw new Error("Image generator returned no buffer.");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, buffer);
}

/** Executes a complete plan with a persistent ledger and retry-only-failures semantics. */
export async function executeMangaScriptImagePlan(plan, options = {}) {
  const concurrencySpec = normalizeScriptImageConcurrency(options.concurrency);
  const generationController = concurrencySpec.mode === "fixed"
    ? null
    : options.adaptiveController || new AdaptiveConcurrencyController({ mode: concurrencySpec.mode });
  const qaConcurrency = normalizeMediaBatchConcurrency(options.qaConcurrency, DEFAULT_SCRIPT_QA_CONCURRENCY);
  const qaQueue = new PQueue({ concurrency: qaConcurrency });
  const maxRetries = Math.max(0, Math.min(3, Math.round(Number(options.maxRetries ?? DEFAULT_SCRIPT_IMAGE_RETRIES))));
  const ledgerPath = resolve(nonEmptyString(options.ledgerPath) || join(plan.assetDir, "image-generation-ledger.json"));
  const prior = await readJsonIfExists(ledgerPath, {});
  const ledger = ledgerState(plan, prior.scriptSha256 === plan.scriptSha256 ? prior : {});
  let checkpoint = Promise.resolve();
  const save = () => {
    ledger.updatedAt = new Date().toISOString();
    checkpoint = checkpoint.then(() => writeJsonAtomic(ledgerPath, ledger));
    return checkpoint;
  };
  const generator = typeof options.generateImage === "function" ? options.generateImage : generateImageMedia;
  const semanticQa = typeof options.visualQa === "function"
    ? options.visualQa
    : nonEmptyString(options.qaCommand)
      ? (payload) => runQaCommand(options.qaCommand, payload)
      : options.autoSemanticQa === false
        ? null
        : (payload) => runCodexVisualQa(payload, {
            qaDir: join(plan.assetDir, ".qa"),
            projectDir: options.projectDir,
            model: options.qaModel,
            codexCommand: options.codexCommand,
            timeoutMs: options.qaTimeoutMs,
          });
  const byId = new Map(plan.jobs.map((entry) => [entry.id, entry]));
  const completed = new Set();

  for (const job of plan.jobs) {
    const state = ledger.jobs[job.id];
    if (state?.status === "complete" && state.inputHash === job.inputHash && await fileExists(job.outputPath)) completed.add(job.id);
    else if (state?.status === "running") state.status = "pending";
  }
  await mkdir(plan.assetDir, { recursive: true });
  await save();

  while (completed.size < plan.jobs.length) {
    const ready = plan.jobs.filter((job) => !completed.has(job.id)
      && job.dependencies.every((dependency) => completed.has(dependency))
      && ledger.jobs[job.id]?.status !== "failed");
    if (ready.length === 0) break;
    const outcomes = await runGenerationJobs(ready, concurrencySpec, async (job) => {
      const old = ledger.jobs[job.id];
      if (old?.status === "complete" && old.inputHash === job.inputHash && await fileExists(job.outputPath)) return { job, reused: true };
      const state = ledger.jobs[job.id] = {
        id: job.id,
        kind: job.kind,
        inputHash: job.inputHash,
        outputPath: job.outputPath,
        status: "running",
        attempts: 0,
        retries: 0,
        startedAt: new Date().toISOString(),
      };
      await save();
      let lastError = "";
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        state.attempts += 1;
        state.retries = attempt;
        try {
          if (job.kind === "editorial-plate") {
            await mkdir(dirname(job.outputPath), { recursive: true });
            await writeFile(job.outputPath, renderEditorialPlatePng(job.plateType));
          } else if (job.kind === "split-page") {
            await composeSplitPage(job);
          } else {
            const media = await generator({
              prompt: attempt === 0 ? job.prompt : correctivePrompt(job, state.qa),
              model: job.model,
              aspectRatio: job.aspectRatio,
              imageSize: job.imageSize,
              quality: job.quality,
              referenceImagePaths: job.referenceImagePaths,
              imageCount: 1,
              fileName: basename(job.outputPath),
            });
            await writeGeneratedMedia(media, job.outputPath);
          }
          const technical = await defaultTechnicalQa(job);
          const semantic = semanticQa
            ? await qaQueue.add(
                () => semanticQa({ job, outputPath: job.outputPath, technical, attempt }),
                { id: `qa:${job.id}:${attempt}` },
              )
            : null;
          const qa = {
            pass: technical.pass && (semantic ? semantic.pass : true),
            issues: [...technical.issues, ...(semantic?.issues || [])],
            technical,
            semantic: semantic || { pass: null, evaluator: "not-configured" },
          };
          state.qa = qa;
          if (!qa.pass) throw new Error(qa.issues.join("; ") || "visual QA failed");
          state.status = "complete";
          state.completedAt = new Date().toISOString();
          await save();
          return { job, reused: false };
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          state.error = lastError;
          if (classifyGenerationError(error) === USAGE_LIMIT_SIGNAL) {
            state.status = "waiting";
            state.waitingSince = new Date().toISOString();
            state.waitingReason = "usage-limit";
            await save();
            // Let the adaptive pool park this exact unfinished job. Do not
            // consume a QA retry or turn the persistent checkpoint red.
            throw error;
          }
          await save();
        }
      }
      state.status = "failed";
      state.failedAt = new Date().toISOString();
      await save();
      throw new Error(lastError || `Job failed: ${job.id}`);
    }, {
      jobId: (job) => job.id,
      controller: generationController,
      adaptiveRunOptions: {
        ...(options.adaptiveRunOptions || {}),
        onPark: async (event) => {
          ledger.status = "waiting";
          ledger.parkedAt = new Date().toISOString();
          ledger.waitingReason = event.verdict?.signal || "usage-limit";
          ledger.generationControllerHistory = event.controller?.history || [];
          await save();
          await options.adaptiveRunOptions?.onPark?.(event);
        },
        onResume: async (event) => {
          ledger.status = "running";
          ledger.resumedAt = new Date().toISOString();
          delete ledger.waitingReason;
          await save();
          await options.adaptiveRunOptions?.onResume?.(event);
        },
      },
    });
    for (const outcome of outcomes) {
      if (outcome.ok) completed.add(outcome.value.job.id);
    }
    if (outcomes.every((entry) => !entry.ok)) break;
  }

  const states = Object.values(ledger.jobs);
  ledger.summary = {
    total: plan.jobs.length,
    complete: states.filter((entry) => entry.status === "complete").length,
    failed: states.filter((entry) => entry.status === "failed").length,
    reused: plan.jobs.filter((job) => prior.jobs?.[job.id]?.status === "complete" && ledger.jobs[job.id]?.status === "complete").length,
    paidImages: plan.jobs.filter((job) => job.imageCount === 1).length,
    attempts: states.reduce((sum, entry) => sum + Number(entry.attempts || 0), 0),
    concurrency: concurrencySpec.label,
    generationMode: concurrencySpec.mode,
    generationFinalLimit: generationController?.limit ?? concurrencySpec.fixedLimit,
    generationControllerHistory: generationController?.history || [],
    qaConcurrency,
  };
  const hasWaitingJobs = states.some((entry) => entry.status === "waiting");
  ledger.status = ledger.summary.complete === plan.jobs.length
    ? "complete"
    : hasWaitingJobs
      ? "waiting"
      : "failed";
  if (ledger.status === "complete") ledger.completedAt = new Date().toISOString();
  await save();
  await checkpoint;
  return { ledgerPath, ledger };
}

async function generateCharacterCandidates(workflow, args, options) {
  const jobs = await buildCharacterCandidateJobs(workflow, {
    model: options.model,
    candidateCount: options.candidateCount,
  });
  if (jobs.length === 0) return workflow;
  await markCharacterCandidatesGenerating(args, workflow.id, jobs);
  const generator = typeof options.generateImage === "function" ? options.generateImage : generateImageMedia;
  const assetDir = join(resolveCanvasDir(args), "assets", "characters", slug(workflow.episodeId));
  await mkdir(assetDir, { recursive: true });
  const concurrencySpec = normalizeScriptImageConcurrency(options.concurrency);
  const outcomes = await runGenerationJobs(jobs, concurrencySpec, async (job) => {
    try {
      const media = await generator({ ...job, imageCount: 1 });
      const assetFile = join(assetDir, job.fileName);
      await writeGeneratedMedia(media, assetFile);
      return { assetFile };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
  return recordCharacterCandidateResults(args, workflow.id, jobs, outcomes.map((entry) => entry.ok ? entry.value : { error: entry.error }));
}

/** One-call entrypoint: character gate -> full planning -> generation -> QA ledger. */
export async function runMangaScriptImagePipeline(args = {}) {
  const scriptText = nonEmptyString(args.scriptText) || await readFile(resolve(args.scriptPath), "utf8");
  const canvasDir = resolveCanvasDir(args);
  const parsedWithoutRegistry = parseMangaScript(scriptText, { title: args.title });
  const episodeId = nonEmptyString(args.episodeId) || slug(parsedWithoutRegistry.title, `episode-${sha256(scriptText).slice(0, 8)}`);
  const concurrency = args.concurrency ?? DEFAULT_SCRIPT_IMAGE_CONCURRENCY;
  let workflow = await prepareCharacterWorkflow({
    ...args,
    canvasDir,
    episodeId,
    scriptText,
    model: args.model || DEFAULT_IMAGE_MODEL,
    candidateCount: args.candidateCount ?? 3,
  });
  if (workflow.cast.some((entry) => ["needs-candidates", "failed"].includes(entry.status))) {
    workflow = await generateCharacterCandidates(workflow, { ...args, canvasDir }, {
      model: args.model || DEFAULT_IMAGE_MODEL,
      candidateCount: args.candidateCount ?? 3,
      concurrency,
      generateImage: args.generateImage,
    });
  }
  const blockingCast = workflow.cast.filter((entry) => !["existing", "ready"].includes(entry.status));
  if (blockingCast.length > 0) {
    return {
      status: "awaiting-character-approval",
      episodeId,
      workflowId: workflow.id,
      cast: blockingCast.map((entry) => ({ id: entry.id, name: entry.name, status: entry.status, candidates: entry.candidates })),
      message: "Approve one candidate per new character, then run the same command again. Existing characters run without this pause.",
    };
  }
  const registry = await readCharacterRegistry({ ...args, canvasDir });
  const assetDir = join(canvasDir, "assets", slug(episodeId));
  const plan = createMangaScriptImagePlan({ scriptText, title: args.title, episodeId, registry, canvasDir, assetDir, model: args.model });
  const planPath = join(assetDir, "script-image-plan.json");
  await mkdir(assetDir, { recursive: true });
  await writeJsonAtomic(planPath, plan);
  const execution = await executeMangaScriptImagePlan(plan, {
    concurrency,
    maxRetries: args.maxRetries,
    qaCommand: args.qaCommand,
    autoSemanticQa: args.autoSemanticQa,
    qaModel: args.qaModel,
    qaTimeoutMs: args.qaTimeoutMs,
    qaConcurrency: args.qaConcurrency,
    adaptiveController: args.adaptiveController,
    adaptiveRunOptions: args.adaptiveRunOptions,
    projectDir: args.projectDir,
    visualQa: args.visualQa,
    generateImage: args.generateImage,
  });
  return { status: execution.ledger.status, episodeId, workflowId: workflow.id, planPath, plan, ...execution };
}
