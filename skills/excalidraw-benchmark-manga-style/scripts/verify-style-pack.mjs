#!/usr/bin/env node

import { mkdir, open, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const REQUIRED_REFERENCES = [
  { id: "linework-male", file: "manga-channel-style-linework-male-v2.png", role: "character-style", tags: ["male", "profile", "linework", "hair"] },
  { id: "linework-female", file: "manga-channel-style-linework-female-v2.png", role: "character-style", tags: ["female", "closeup", "linework", "face"] },
  { id: "group-composition", file: "manga-channel-style-group-composition-v2.png", role: "composition", tags: ["dialogue", "medium", "interior"] },
  { id: "action-prop", file: "manga-channel-style-action-prop-v2.png", role: "composition", tags: ["action", "hands", "prop", "interior"] },
  { id: "day-background", file: "manga-channel-style-day-background-v2.png", role: "background", tags: ["exterior", "day", "wide"] },
  { id: "night-background", file: "manga-channel-style-night-background-v2.png", role: "background", tags: ["exterior", "night", "wide"] },
  { id: "warm-interior", file: "manga-channel-style-warm-interior-v2.png", role: "background", tags: ["interior", "warm", "day"] },
  { id: "neutral-interior", file: "manga-channel-style-soft-interior-v2.png", role: "background", tags: ["interior", "neutral"] },
];

function parseArgs(argv) {
  const options = { projectDir: "", referenceDir: "", write: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--project-dir") options.projectDir = argv[++index] || "";
    else if (value === "--reference-dir") options.referenceDir = argv[++index] || "";
    else if (value === "--write") options.write = true;
    else if (value === "--check-only") options.write = false;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

async function pngDimensions(filePath) {
  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(24);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 24 || header.toString("hex", 0, 8) !== "89504e470d0a1a0a") {
      throw new Error("not a PNG file");
    }
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } finally {
    await handle.close();
  }
}

function usage() {
  return [
    "Usage: node verify-style-pack.mjs --project-dir <dir> [--reference-dir <dir>] [--write|--check-only]",
    "",
    "Checks the eight independent benchmark frames and optionally writes",
    "canvas/visual-profiles/benchmark-manga-style-pack.json.",
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.projectDir) throw new Error("--project-dir is required.");

  const projectDir = resolve(options.projectDir);
  const referenceDir = options.referenceDir
    ? (isAbsolute(options.referenceDir) ? resolve(options.referenceDir) : resolve(projectDir, options.referenceDir))
    : join(projectDir, "canvas", "assets", "style-references");
  const checked = [];
  const failures = [];

  for (const reference of REQUIRED_REFERENCES) {
    const path = join(referenceDir, reference.file);
    try {
      const dimensions = await pngDimensions(path);
      const aspect = dimensions.width / dimensions.height;
      const highResolution = dimensions.width >= 1280 && dimensions.height >= 720;
      const landscape16x9 = Math.abs(aspect - (16 / 9)) <= 0.08;
      const ok = highResolution && landscape16x9;
      checked.push({
        ...reference,
        path,
        width: dimensions.width,
        height: dimensions.height,
        styleOnly: true,
        identityCopyForbidden: true,
        ok,
      });
      if (!ok) failures.push(`${reference.id}: expected at least 1280x720 and approximately 16:9, received ${dimensions.width}x${dimensions.height}`);
    } catch (error) {
      failures.push(`${reference.id}: ${error.message} (${path})`);
    }
  }

  const manifest = {
    version: 1,
    id: "benchmark-manga-style-pack-v1",
    identityPolicy: "Character identity comes only from approved character sheets; every benchmark frame is STYLE-ONLY.",
    passed: failures.length === 0,
    references: checked,
    failures,
  };

  if (options.write && failures.length === 0) {
    const outputDir = join(projectDir, "canvas", "visual-profiles");
    const outputPath = join(outputDir, "benchmark-manga-style-pack.json");
    await mkdir(outputDir, { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    manifest.outputPath = outputPath;
  }

  console.log(JSON.stringify(manifest, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  console.error(usage());
  process.exitCode = 1;
});
