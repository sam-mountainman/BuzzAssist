#!/usr/bin/env node
// Generic single-attribute revision runner for character candidate assets.
// Jobs file format (JSON):
// {
//   "outputDir": "canvas/assets/appare-revisions",
//   "manifest": "canvas/assets/appare-revisions/generation-manifest.jsonl",
//   "defaults": {"model": "gpt-image-2-codex", "aspectRatio": "16:9", "imageSize": "2K", "quality": "high"},
//   "jobs": [{"out": "x.png", "refs": ["canvas/assets/..png"], "prompt": "..."}]
// }
// Runs jobs sequentially, fail-soft per job, and appends provenance
// (prompt, refs+SHA, output SHA, model, timestamps) to the manifest so every
// revision stays traceable without a live session context.
import { createHash } from "node:crypto";
import {
  AdaptiveConcurrencyController,
  runWithAdaptiveConcurrency,
} from "../lib/adaptiveConcurrency.mjs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";

import { disposeMediaGenerationResources, generateImageMedia } from "../lib/mediaGeneration.mjs";

function usage() {
  console.error("usage: node scripts/koya-generate-revision.mjs --jobs <jobs.json> [--project-dir <dir>]");
  process.exit(1);
}

function parseArgs(argv) {
  const args = { projectDir: process.cwd() };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--jobs") args.jobsPath = argv[++i];
    else if (argv[i] === "--project-dir") args.projectDir = argv[++i];
    else usage();
  }
  if (!args.jobsPath) usage();
  return args;
}

function absolutize(root, value) {
  return isAbsolute(value) ? value : resolve(root, value);
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

const { jobsPath, projectDir } = parseArgs(process.argv);
const spec = JSON.parse(await readFile(absolutize(projectDir, jobsPath), "utf8"));
const outputDir = absolutize(projectDir, spec.outputDir ?? "canvas/assets/appare-revisions");
const manifestPath = absolutize(projectDir, spec.manifest ?? join(spec.outputDir ?? "canvas/assets/appare-revisions", "generation-manifest.jsonl"));
const defaults = { model: "gpt-image-2-codex", aspectRatio: "16:9", imageSize: "2K", quality: "high", ...(spec.defaults ?? {}) };
if (!Array.isArray(spec.jobs) || spec.jobs.length === 0) {
  console.error("spec.jobs must be a non-empty array");
  process.exit(1);
}
await mkdir(outputDir, { recursive: true });
await mkdir(dirname(manifestPath), { recursive: true });

function containedOutputPath(name) {
  if (typeof name !== "string" || !name) throw new Error("job.out is required");
  const outPath = resolve(outputDir, name);
  if (outPath !== outputDir && !outPath.startsWith(`${outputDir}/`)) {
    throw new Error(`job.out escapes the output directory: ${name}`);
  }
  if (outPath === resolve(manifestPath)) throw new Error("job.out must not overwrite the manifest");
  return outPath;
}

let failures = 0;
const seenOutputs = new Set();

// job.out の重複検査は、生成を始める前に全件まとめて済ませる。
// 並列にすると Set への追加順が実行順に依存してしまい、
// 「どちらが重複と判定されるか」が実行のたびに変わるため。
for (const job of spec.jobs) {
  if (job && typeof job === "object" && typeof job.out === "string") {
    const outPath = containedOutputPath(job.out);
    if (seenOutputs.has(outPath)) throw new Error(`duplicate job.out: ${job.out}`);
    seenOutputs.add(outPath);
  }
}

// 修正ラウンドは1回で複数枚を出し直す。1枚ずつ待つと、直したい枚数に
// 比例してそのまま待ち時間が伸びる。台数制御は画像生成用のAIMD（R62）
// に任せ、429と使用上限もそこで面倒を見る。
const revisionConcurrency = new AdaptiveConcurrencyController({
  mode: "auto",
  initial: Math.max(1, Number(process.env.KOYA_REVISION_CONCURRENCY) || 4),
});

// マニフェストは追記ファイル。並列のワーカーから直接 appendFile すると
// 行が混ざるので、書き込みだけは直列に流す。
let manifestWrite = Promise.resolve();
const appendManifest = (entry) => {
  const write = async () => {
    try {
      await appendFile(manifestPath, `${JSON.stringify(entry)}\n`);
    } catch (manifestError) {
      console.error("MANIFEST-WRITE-FAILED", String(manifestError).slice(0, 200));
    }
  };
  manifestWrite = manifestWrite.then(write, write);
  return manifestWrite;
};

const runRevisionJob = (job) => async () => {
  const startedAt = new Date().toISOString();
  let refs = [];
  try {
    if (!job || typeof job !== "object") throw new Error("every job must be an object");
    if (!job.prompt) throw new Error("job.prompt is required");
    const outPath = containedOutputPath(job.out);
    if (job.refs !== undefined && !Array.isArray(job.refs)) throw new Error("job.refs must be an array");
    refs = (job.refs ?? []).map((ref) => absolutize(projectDir, ref));
    if (refs.includes(outPath)) throw new Error(`job.out must not overwrite a reference image: ${job.out}`);
    const refDigests = [];
    for (const ref of refs) refDigests.push({ path: ref, sha256: await sha256(ref) });
    const media = await generateImageMedia({
      prompt: job.prompt,
      model: job.model ?? defaults.model,
      aspectRatio: job.aspectRatio ?? defaults.aspectRatio,
      imageSize: job.imageSize ?? defaults.imageSize,
      quality: job.quality ?? defaults.quality,
      referenceImagePaths: refs,
      fileName: job.out,
    });
    const entry = {
      out: outPath,
      outSha256: createHash("sha256").update(media.buffer).digest("hex"),
      refs: refDigests,
      prompt: job.prompt,
      requestedModel: job.model ?? defaults.model,
      model: media.model ?? job.model ?? defaults.model,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "ok",
    };
    // Provenance first, pixels second: an image must never exist without its
    // manifest row, while a row without its file is a visible, harmless gap.
    await appendManifest(entry);
    await writeFile(outPath, media.buffer);
    console.log("ok", job.out);
  } catch (error) {
    failures += 1;
    const entry = {
      out: typeof job?.out === "string" ? job.out : "",
      refs,
      prompt: typeof job?.prompt === "string" ? job.prompt : "",
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "failed",
      error: String(error).slice(0, 300),
    };
    await appendManifest(entry);
    console.error("FAIL", job?.out ?? "(missing out)", String(error).slice(0, 300));
  }
};

await runWithAdaptiveConcurrency(
  spec.jobs.map((job) => runRevisionJob(job)),
  revisionConcurrency,
);
// 追記を全て流し切ってから終了コードを決める。
await manifestWrite;
await disposeMediaGenerationResources();
process.exit(failures === 0 ? 0 : 2);
