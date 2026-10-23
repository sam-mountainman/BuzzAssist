import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendAdoptionDecision, buildAdoptionDecision, resolveAdoptionPath } from "../lib/optimalConfig/adoption.mjs";
import {
  ADOPTED_CONFIG_CODES,
  adoptedSelectionForJob,
  checkAdoptedAgainstPackRuntime,
  resolveAdoptedConfigForRun,
  resolveAdoptedMediaSelection,
} from "../lib/optimalConfig/adoptedMedia.mjs";
import { loadOptimalConfigCatalog } from "../lib/optimalConfig/catalog.mjs";
import { executeVideoHarnessAdapter } from "../lib/videoHarnessAdapters.mjs";
import { applyAdoptedConfigToStartOptions, createVideoHarnessService } from "../lib/videoHarnessService.mjs";
import { completedTrial, exampleTraits } from "./helpers/optimalConfigTrialFixture.mjs";

const catalog = loadOptimalConfigCatalog();
const human = { reviewer: "operator", attestedBy: "human-verified" };
const agent = { reviewer: "agent", attestedBy: "agent-self-attested", claimedReviewer: "operator" };

function decision({ production = "A", backup = "B", attestation = human } = {}) {
  return buildAdoptionDecision({
    traits: exampleTraits(),
    trial: completedTrial(),
    trialSha256: "b".repeat(64),
    production,
    backup,
    attestation,
    catalog,
    now: () => "2026-10-23T00:00:00.000Z",
  });
}

function catalogWith(modelId, patch) {
  const copy = structuredClone(catalog);
  const index = copy.models.findIndex((model) => model.id === modelId);
  if (patch === null) copy.models.splice(index, 1);
  else copy.models[index] = patch(copy.models[index]);
  return copy;
}

async function projectWith(t, decisions) {
  const dir = await mkdtemp(join(tmpdir(), "optimal-harness-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const item of decisions) await appendAdoptionDecision({ filePath: resolveAdoptionPath(dir), decision: item });
  return dir;
}

test("採用の記録が無ければ none（今までどおり既定の経路）", async (t) => {
  const dir = await projectWith(t, []);
  assert.deepEqual(await resolveAdoptedConfigForRun({ projectDir: dir, harnessId: "koya-manga-video" }), { status: "none" });
});

test("採用した本番の画像・動画を、生成層の id と経路に解く", async (t) => {
  const dir = await projectWith(t, [decision()]);
  const adopted = await resolveAdoptedConfigForRun({ projectDir: dir, channelId: "fixed-cast-manga", harnessId: "koya-manga-video" });
  assert.equal(adopted.status, "adopted");
  assert.deepEqual(
    { model: adopted.selection.image.generationModelId, route: adopted.selection.image.mediaRoute, executor: adopted.selection.image.executor },
    { model: "gpt-image-2-codex", route: "codex", executor: "media-broker" },
  );
  assert.equal(adopted.selection.video.generationModelId, "grok-imagine-video-hermes");
  assert.equal(adopted.selection.video.mediaRoute, "hermes");
  assert.equal(adopted.selection.backup.image.executor, "ollama-local", "予備の klein 4B は Mac の Ollama");
  assert.equal(adopted.jobOption.adoptionSha256, adopted.selection.adoptionSha256);
});

test("止める: 人の確認がまだ・別のチャンネル・構成表に無い・生成層が知らない・権利で止まる・このハーネスで使えない経路", async (t) => {
  const pending = await projectWith(t, [decision({ attestation: agent })]);
  await assert.rejects(resolveAdoptedConfigForRun({ projectDir: pending }), (error) => error.code === ADOPTED_CONFIG_CODES.NOT_HUMAN_VERIFIED && /人の確認がまだ/u.test(error.message));

  const dir = await projectWith(t, [decision()]);
  await assert.rejects(resolveAdoptedConfigForRun({ projectDir: dir, channelId: "other-channel" }), { code: ADOPTED_CONFIG_CODES.CHANNEL_MISMATCH });

  assert.throws(() => resolveAdoptedMediaSelection(decision(), { catalog: catalogWith("gpt-image", null) }), (error) => error.code === ADOPTED_CONFIG_CODES.UNKNOWN_MODEL && /置き換えない/u.test(error.message));
  assert.throws(
    () => resolveAdoptedMediaSelection(decision(), { catalog: catalogWith("gpt-image", (model) => ({ ...model, mediaGenerationIds: ["gpt-image-99"] })) }),
    { code: ADOPTED_CONFIG_CODES.UNKNOWN_MODEL },
  );
  assert.throws(
    () => resolveAdoptedMediaSelection(decision(), { catalog: catalogWith("gpt-image", (model) => ({ ...model, rights: { ...model.rights, outputs: { commercialUse: "forbidden" } } })) }),
    { code: ADOPTED_CONFIG_CODES.RIGHTS_BLOCKED },
  );

  const local = await projectWith(t, [decision({ production: "B", backup: "A" })]);
  await assert.rejects(resolveAdoptedConfigForRun({ projectDir: local, harnessId: "koya-manga-video" }), (error) => error.code === ADOPTED_CONFIG_CODES.ROUTE_UNSUPPORTED && /漫画/u.test(error.message));
  const narrated = await resolveAdoptedConfigForRun({ projectDir: local, harnessId: "narrated-story-video" });
  assert.equal(narrated.selection.image.executor, "ollama-local");
});

test("start: 採用の記録があれば Job の options に入れ、決められなければ Job を作る前に止める", async (t) => {
  const dir = await projectWith(t, [decision()]);
  const created = [];
  const service = createVideoHarnessService({
    createJob: async (input) => {
      created.push(input);
      return { job: { id: "video-fixture-0123456789abcdef", status: "planned", projectDir: dir, harness: { id: "koya-manga-video" }, options: input.options, blockers: [], knownRemainingIssues: [] }, attached: false };
    },
    projectCanvas: async () => ({ ok: true }),
    productionProfile: async () => ({ profileId: "operator-production" }),
    planPreflight: async () => null,
    selectHarness: ({ harnessId }) => ({ harness: { id: harnessId } }),
    captureRunLearning: async () => null,
    env: {},
  });
  const koyaOptions = { episodeId: "ep-1", protagonistSpeakerId: "p", characterBiblePath: join(dir, "bible.json"), storyReviewPath: join(dir, "review.json") };
  const result = await service.start({ projectDir: dir, scriptPath: join(dir, "script.md"), channelPackPath: join(dir, "pack"), harnessId: "koya-manga-video", options: koyaOptions });
  assert.equal(result.optimalConfig.status, "adopted");
  assert.equal(result.optimalConfig.image.generationModelId, "gpt-image-2-codex");
  assert.equal(created[0].options.optimalConfig.image.generationModelId, "gpt-image-2-codex");

  // 要求側が違う経路を押し込めない
  await assert.rejects(
    service.start({ projectDir: dir, scriptPath: join(dir, "script.md"), channelPackPath: join(dir, "pack"), harnessId: "koya-manga-video", options: { ...koyaOptions, optimalConfig: { image: { generationModelId: "gpt-image-2" } } } }),
    { code: ADOPTED_CONFIG_CODES.OPTIONS_CONFLICT },
  );
  // 手元の画像を採用したチャンネルの漫画は、Job を作らずに止まる
  const local = await projectWith(t, [decision({ production: "B", backup: "A" })]);
  const before = created.length;
  await assert.rejects(
    service.start({ projectDir: local, scriptPath: join(local, "script.md"), channelPackPath: join(local, "pack"), harnessId: "koya-manga-video", options: koyaOptions }),
    { code: ADOPTED_CONFIG_CODES.ROUTE_UNSUPPORTED },
  );
  assert.equal(created.length, before, "Job を作っていない");
});

test("start: 採用の記録が無ければ options は今までどおりで、optimalConfig を要求側から渡せない", async (t) => {
  const dir = await projectWith(t, []);
  const unchanged = await applyAdoptedConfigToStartOptions({ projectDir: dir, harnessId: "narrated-story-video", options: { episodeId: "e" } });
  assert.deepEqual(unchanged, { options: { episodeId: "e" }, optimalConfig: null });
  await assert.rejects(applyAdoptedConfigToStartOptions({ projectDir: dir, options: { optimalConfig: {} } }), { code: ADOPTED_CONFIG_CODES.OPTIONS_CONFLICT });
});

test("Koya の adapter は採用した本番の画像のモデルを --image-model で渡す（無ければ渡さない）", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "koya-adopted-image-model-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["script.txt", "character-bible.json", "story-review.json"]) await writeFile(join(root, name), "{}\n");
  const seen = [];
  const run = (options) => executeVideoHarnessAdapter({
    job: {
      id: "video-koya-manga-video-0123456789abcdef",
      harness: { id: "koya-manga-video" },
      projectDir: root,
      script: { path: join(root, "script.txt") },
      options: {
        episodeId: "episode-1",
        protagonistSpeakerId: "protagonist",
        characterBiblePath: join(root, "character-bible.json"),
        storyReviewPath: join(root, "story-review.json"),
        ...options,
      },
    },
    runChild: async (_command, args) => {
      seen.push(args);
      return { code: 3, signal: null, stderr: "", stdout: JSON.stringify({ status: "awaiting-human-review", knownRemainingIssues: ["fixture"] }) };
    },
  });
  const selection = resolveAdoptedMediaSelection(decision(), { catalog });
  await run({ optimalConfig: adoptedSelectionForJob(selection) });
  await run({});
  const valueOf = (args) => (args.includes("--image-model") ? args[args.indexOf("--image-model") + 1] : null);
  assert.equal(valueOf(seen[0]), "gpt-image-2-codex");
  assert.equal(valueOf(seen[1]), null);
});

test("ナレーション物語: 署名済み Pack の画像の宣言と採用した構成が違えば、どちらにも黙ってそろえず止める", () => {
  const service = adoptedSelectionForJob(resolveAdoptedMediaSelection(decision(), { catalog }));
  const local = adoptedSelectionForJob(resolveAdoptedMediaSelection(decision({ production: "B", backup: "A" }), { catalog }));
  const pack = (overrides = {}) => ({ imageProvider: "fal-ai", imageModel: "gpt-image-2", ...overrides });
  assert.equal(checkAdoptedAgainstPackRuntime(service, pack()), null, "Pack の gpt-image-2 は採用した GPT Image の生成の id の1つ");
  assert.equal(checkAdoptedAgainstPackRuntime(service, pack({ imageModel: "seedream-v5-lite" })).code, ADOPTED_CONFIG_CODES.PACK_CONFLICT);
  assert.equal(checkAdoptedAgainstPackRuntime(local, pack()).code, ADOPTED_CONFIG_CODES.PACK_CONFLICT);
  assert.equal(checkAdoptedAgainstPackRuntime(local, pack({ imageSource: "operator-file" })), null, "手元で作った画は運営者の画の取り込みで入れる");
  assert.equal(checkAdoptedAgainstPackRuntime(null, pack()), null, "採用の記録が無ければ今までどおり");
});
