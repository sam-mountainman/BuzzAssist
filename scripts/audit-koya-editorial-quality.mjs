#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";
import { auditKoyaEditorialQuality } from "../lib/koyaEditorialQualityAudit.mjs";
import { resolveKoyaMangaProductionContract } from "../lib/koyaMangaProductionContract.mjs";

const { values } = parseArgs({
  options: {
    "manifest-path": { type: "string" },
    "output-path": { type: "string" },
    "project-dir": { type: "string" },
    "contract-path": { type: "string" },
  },
});

if (!values["manifest-path"]) throw new Error("--manifest-path is required.");
const projectDir = resolve(values["project-dir"] || process.cwd());
const manifestPath = resolve(values["manifest-path"]);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const resolvedContract = await resolveKoyaMangaProductionContract({
  projectDir,
  episodeId: manifest.id,
  contractPath: values["contract-path"] ? resolve(values["contract-path"]) : undefined,
});
const report = auditKoyaEditorialQuality(manifest, resolvedContract.contract);
const outputPath = resolve(values["output-path"] || join(dirname(manifestPath), "audits/koya-final/editorial-quality.json"));
await writeJsonAtomic(outputPath, report);
process.stdout.write(`${JSON.stringify({ outputPath, ...report }, null, 2)}\n`);
if (!report.pass) process.exitCode = 1;
