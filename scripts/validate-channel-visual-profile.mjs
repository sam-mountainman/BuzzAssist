#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { resolveCanvasDir } from "../lib/canvasScene.mjs";
import {
  buildCharacterStoryboardJobs,
  getCharacterWorkflow,
  readCharacterWorkflowStore,
  validateStoryboardCharacterBindings,
  validateStoryboardVisualProfile,
} from "../lib/characterPipeline.mjs";

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : "";
}

const projectDir = resolve(valueAfter("--project-dir") || process.cwd());
const scenesPath = resolve(projectDir, valueAfter("--scenes") || "examples/manga-character-pipeline/scenes.json");
const workflowId = valueAfter("--workflow");
const args = { projectDir };
const store = await readCharacterWorkflowStore(args);
const workflow = workflowId
  ? getCharacterWorkflow(store, workflowId)
  : store.workflows.at(-1);
if (!workflow) throw new Error(`Character workflow was not found${workflowId ? `: ${workflowId}` : ""}.`);

const scenes = JSON.parse(await readFile(scenesPath, "utf8"));
const jobs = buildCharacterStoryboardJobs(workflow, scenes, args);
const character = validateStoryboardCharacterBindings(workflow, jobs);
const visual = validateStoryboardVisualProfile(workflow, jobs);
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  projectDir,
  workflowId: workflow.id,
  episodeId: workflow.episodeId,
  profileId: workflow.visualProfile?.id || "",
  scenesFile: basename(scenesPath),
  summary: {
    total: jobs.length,
    visualPassed: visual.scenes.filter((scene) => scene.ok).length,
    visualFailed: visual.scenes.filter((scene) => !scene.ok).length,
    characterWarnings: character.warnings.length,
    visualWarnings: visual.warnings.length,
  },
  character,
  visual,
  jobs: jobs.map((job) => ({
    id: job.customData.buzzassistCharacterSceneId,
    characterIds: job.characterIds,
    styleTags: job.customData.buzzassistStyleTags,
    styleReferencePaths: job.customData.buzzassistStyleReferencePaths,
    bubbleSafeZone: job.customData.buzzassistBubbleSafeZone,
    speakerPosition: job.customData.buzzassistSpeakerPosition,
    aspectRatio: job.aspectRatio,
  })),
};

const reportDir = join(resolveCanvasDir(args), "visual-profiles");
await mkdir(reportDir, { recursive: true });
const reportPath = join(reportDir, `${workflow.visualProfile?.id || "unprofiled"}-quality-report.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ reportPath, ...report.summary }));
if (!visual.ok) process.exitCode = 1;
