#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { GENRE_CANONICAL_ENTRYPOINTS } from "../lib/harnessRouting.mjs";

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
// 旧 CLI の本番工程の台帳と、実際に止めている表（lib/harnessRouting.mjs）が一致すること。
// 台帳だけ直して表を忘れる（またはその逆）と、止めたつもりの工程が素通りする。
const entrypointPolicy = inventory.legacyEntrypointPolicy || {};
const routedActions = GENRE_CANONICAL_ENTRYPOINTS["manga-video"]?.legacyCliProductionActions?.[entrypointPolicy.entrypoint] || [];
const declaredActions = Array.isArray(entrypointPolicy.productionActions) ? entrypointPolicy.productionActions : [];
const sameActions = declaredActions.length > 0
  && JSON.stringify([...declaredActions].sort()) === JSON.stringify([...routedActions].sort());
let legacyCliSource = "";
try {
  legacyCliSource = await readFile(join(projectDir, entrypointPolicy.entrypoint || "scripts/build-manga-video.mjs"), "utf8");
} catch { /* 下の gate が false になる */ }
const gates = {
  inventoryFrozen: inventory.status === "frozen-benchmark-migrations",
  expectedCount: matched.length === inventory.matchedFileCount,
  noUnmatchedVersionedScripts: unmatchedVersioned.length === 0,
  officialPathIsIsolated: forbiddenMentions.length === 0,
  legacyProductionActionsMatchRouting: sameActions,
  legacyCliGuardsProductionActions: entrypointPolicy.productionActionsRequire === "--benchmark-migration"
    && /checkCanonicalRouting\(/u.test(legacyCliSource)
    && /isLegacyCliProductionAction\(/u.test(legacyCliSource),
};
const report = {
  version: "koya-legacy-entrypoint-audit-v1",
  inventoryPath,
  matched,
  unmatchedVersioned,
  forbiddenMentions,
  legacyEntrypoint: {
    entrypoint: entrypointPolicy.entrypoint || "",
    declaredProductionActions: declaredActions,
    routedProductionActions: [...routedActions],
  },
  gates,
  pass: Object.values(gates).every(Boolean),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.pass) process.exitCode = 2;
