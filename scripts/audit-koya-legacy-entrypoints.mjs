#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const projectDir = resolve(process.argv[2] || process.cwd());
const inventoryPath = join(projectDir, "config/koya-manga-legacy-migrations.json");
const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
const rules = inventory.rules.map((rule) => ({ ...rule, regex: new RegExp(rule.pattern, "u") }));
const scripts = (await readdir(join(projectDir, "scripts")))
  .filter((name) => name.endsWith(".mjs"))
  .map((name) => `scripts/${name}`)
  .sort();
const matched = scripts.filter((path) => rules.some((rule) => rule.regex.test(path)));
const unmatchedVersioned = scripts.filter((path) => /scripts\/(?:apply|finalize|generate)-manga-v\d/iu.test(path) && !matched.includes(path));
const officialPaths = [
  "scripts/koya-manga-video.mjs",
  "lib/koyaMangaProduction.mjs",
  "lib/koyaDialogueSpeech.mjs",
  "lib/koyaMangaFinalAudit.mjs",
];
const forbiddenMentions = [];
for (const relativePath of officialPaths) {
  const source = await readFile(join(projectDir, relativePath), "utf8");
  if (/(?:apply|finalize|generate)-manga-v\d/iu.test(source)) forbiddenMentions.push(relativePath);
}
const gates = {
  inventoryFrozen: inventory.status === "frozen-benchmark-migrations",
  expectedCount: matched.length === inventory.matchedFileCount,
  noUnmatchedVersionedScripts: unmatchedVersioned.length === 0,
  officialPathIsIsolated: forbiddenMentions.length === 0,
};
const report = {
  version: "koya-legacy-entrypoint-audit-v1",
  inventoryPath,
  matched,
  unmatchedVersioned,
  forbiddenMentions,
  gates,
  pass: Object.values(gates).every(Boolean),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.pass) process.exitCode = 2;
