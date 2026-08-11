import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildChannelVisualStylePrompt,
  inferChannelVisualTags,
  resolveChannelVisualProfileSnapshot,
  selectChannelVisualReferences,
} from "../lib/channelVisualProfile.mjs";
import {
  buildCharacterCandidateJobs,
  buildCharacterStoryboardJobs,
  prepareCharacterWorkflow,
  validateStoryboardVisualProfile,
} from "../lib/characterPipeline.mjs";

async function fixture() {
  const projectDir = await mkdtemp(join(tmpdir(), "buzzassist-visual-profile-"));
  const canvasDir = join(projectDir, "canvas");
  await mkdir(join(canvasDir, "assets", "style-references"), { recursive: true });
  const profile = {
    version: 1,
    defaultProfileId: "channel-lock",
    profiles: [{
      id: "channel-lock",
      name: "Channel lock",
      referenceMeasurements: { version: 1, sampleCount: 80, sourceIds: ["video-a", "video-b"] },
      stylePrompt: "thin charcoal line art and restrained cel shading",
      compositionPrompt: "eye-level dialogue composition",
      shotRhythmPrompt: "alternate medium shots and close-ups",
      continuityPrompt: "lock architecture and lighting",
      outputPrompt: "one 16:9 frame with no text",
      negativePrompt: "3D, photorealistic, speech balloons",
      maxStyleReferences: 2,
      referenceImages: [
        { id: "core", path: "assets/style-references/core.png", role: "style", tags: ["core", "interior", "day"] },
        { id: "night", path: "assets/style-references/night.png", role: "lighting", tags: ["night", "exterior", "closeup"] },
        { id: "dialogue", path: "assets/style-references/dialogue.png", role: "composition", tags: ["interior", "dialogue", "medium"] },
      ],
    }],
  };
  await writeFile(join(canvasDir, "channel-visual-profiles.json"), `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  return { projectDir, canvasDir };
}

test("channel visual profile selects scene-specific style references without treating them as identity", async () => {
  const { projectDir, canvasDir } = await fixture();
  const profile = await resolveChannelVisualProfileSnapshot({ projectDir });
  assert.equal(profile.id, "channel-lock");
  assert.equal(profile.referenceMeasurements.sampleCount, 80);
  assert.deepEqual(profile.referenceMeasurements.sourceIds, ["video-a", "video-b"]);
  assert.equal(profile.referenceImages[0].path, join(canvasDir, "assets/style-references/core.png"));

  const scene = { prompt: "Night street reaction close-up", characterIds: ["hero"] };
  assert.deepEqual(inferChannelVisualTags(scene).filter((tag) => ["night", "exterior", "closeup"].includes(tag)).sort(), ["closeup", "exterior", "night"]);
  const references = selectChannelVisualReferences(profile, scene);
  assert.equal(references.length, 2);
  assert.equal(references[0].id, "night");
  const prompt = buildChannelVisualStylePrompt(profile, scene, references.length);
  assert.match(prompt, /channel visual reference images are STYLE-ONLY/);
  assert.match(prompt, /Create entirely new character identities/);
  assert.match(prompt, /Never copy any reference person's face, hair, clothing/);
  assert.match(prompt, /STRICTLY AVOID: 3D, photorealistic, speech balloons/);
});

test("character candidates and storyboard scenes inherit the locked channel profile", async () => {
  const { projectDir } = await fixture();
  const workflow = await prepareCharacterWorkflow({
    projectDir,
    episodeId: "episode-style-lock",
    scriptText: "主人公：本当なんですか？",
    cast: [{
      name: "主人公",
      description: "20代の日本人男性。黒髪で控えめ。",
      invariants: ["短い黒髪", "紺色のジャケット"],
    }],
  });
  assert.equal(workflow.visualProfileId, "channel-lock");
  assert.equal(workflow.visualProfile.id, "channel-lock");

  const candidates = await buildCharacterCandidateJobs(workflow, { candidateCount: 1 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].referenceImagePaths.length, 2);
  assert.match(candidates[0].prompt, /CHANNEL VISUAL STYLE LOCK \[channel-lock\]/);
  assert.equal(candidates[0].customData.buzzassistChannelVisualProfileId, "channel-lock");

  const readyWorkflow = structuredClone(workflow);
  readyWorkflow.cast = readyWorkflow.cast.map((cast) => ({ ...cast, status: "ready", characterId: cast.id }));
  const jobs = buildCharacterStoryboardJobs(readyWorkflow, [{
    id: "cut-1",
    prompt: "主人公が夜の住宅街で静かに振り返るクローズアップ",
    characterIds: [readyWorkflow.cast[0].id],
    styleTags: ["night", "exterior", "closeup"],
    shotType: "eye-level reaction close-up",
    bubbleSafeZone: "upper right",
  }]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].referenceImagePaths.length, 2);
  assert.match(jobs[0].prompt, /Reserve clean negative space.*upper right/);
  assert.match(jobs[0].prompt, /channel visual reference images are STYLE-ONLY/);
  assert.equal(jobs[0].customData.buzzassistCharacterSceneSourcePrompt, "主人公が夜の住宅街で静かに振り返るクローズアップ");
  assert.equal(jobs[0].customData.buzzassistChannelVisualProfileId, "channel-lock");
  const visualValidation = validateStoryboardVisualProfile(readyWorkflow, jobs);
  assert.equal(visualValidation.ok, true);
  assert.equal(visualValidation.scenes[0].styleReferenceCount, 2);
  assert.ok(Object.values(visualValidation.scenes[0].checks).every(Boolean));

  const crowded = buildCharacterStoryboardJobs(readyWorkflow, [{
    prompt: "Three people confront each other in the office",
    characterIds: ["a", "b", "c"],
    styleTags: ["interior", "dialogue"],
  }]);
  assert.equal(crowded[0].referenceImagePaths.length, 1);

  const oppositeSide = buildCharacterStoryboardJobs(readyWorkflow, [{
    prompt: "主人公が室内で話す",
    characterIds: [readyWorkflow.cast[0].id],
    speakerPosition: "right",
    styleTags: ["interior", "dialogue", "medium"],
  }]);
  assert.equal(oppositeSide[0].customData.buzzassistSpeakerPosition, "right");
  assert.equal(oppositeSide[0].customData.buzzassistBubbleSafeZone, "upper left outer negative space");
  assert.match(oppositeSide[0].prompt, /Shot type: left three-quarter medium two-shot/);
  assert.match(oppositeSide[0].prompt, /Camera: left three-quarter view/);
  assert.match(oppositeSide[0].prompt, /Lighting: soft natural or diffused daytime light/);
});
