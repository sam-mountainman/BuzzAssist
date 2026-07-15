#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const expected = String(process.argv[2] || process.env.GITHUB_REF_NAME || "").replace(/^v/, "");

if (!/^\d+\.\d+\.\d+$/.test(expected)) {
  throw new Error("Pass a stable Release tag such as v0.1.18.");
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(resolve(rootDir, relativePath), "utf8"));
}

const manifests = [
  ["package.json", await readJson("package.json")],
  [".codex-plugin/plugin.json", await readJson(".codex-plugin/plugin.json")],
  [".claude-plugin/plugin.json", await readJson(".claude-plugin/plugin.json")],
  [".antigravity-plugin/plugin.json", await readJson(".antigravity-plugin/plugin.json")],
];

const claudeMarketplace = await readJson(".claude-plugin/marketplace.json");
const marketplacePlugin = claudeMarketplace.plugins?.find((plugin) => plugin.name === "buzzassist");
manifests.push([".claude-plugin/marketplace.json#buzzassist", marketplacePlugin]);

for (const [label, manifest] of manifests) {
  if (manifest?.version !== expected) {
    throw new Error(`${label} has version ${manifest?.version || "missing"}; expected ${expected}.`);
  }
}

console.log(`BUZZASSIST_RELEASE_VERSION_CHECK=ok`);
console.log(`BUZZASSIST_RELEASE_VERSION=${expected}`);
