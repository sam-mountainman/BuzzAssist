#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { renderSpeechBubbleSvg } from "../lib/speechBubbleRenderer.mjs";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const specPath = args.spec ? resolve(String(args.spec)) : null;
  const outputPath = args.output ? resolve(String(args.output)) : null;
  if (!specPath || !outputPath) {
    throw new Error("Usage: node scripts/render-speech-bubbles.mjs --spec /absolute/spec.json --output /absolute/overlay.svg");
  }
  const spec = JSON.parse(await readFile(specPath, "utf8"));
  const result = renderSpeechBubbleSvg(spec);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, result.svg, "utf8");
  process.stdout.write(`${JSON.stringify({ outputPath, plan: result.plan, quality: result.quality })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});

