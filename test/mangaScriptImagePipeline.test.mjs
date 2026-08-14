import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createMangaScriptImagePlan,
  executeMangaScriptImagePlan,
  mangaImageQaReferenceCandidates,
  mangaImageQaStructureContract,
  mangaImageQaVisualPrompt,
  normalizeScriptImageConcurrency,
  renderEditorialPlatePng,
  runMangaScriptImagePipeline,
} from "../lib/mangaScriptImagePipeline.mjs";
import { writeCharacterRegistry } from "../lib/characterRegistry.mjs";
import { AdaptiveConcurrencyController } from "../lib/adaptiveConcurrency.mjs";

test("script planner covers strict plates, thought focus, split pages, and camera diversity", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-script-plan-"));
  const scriptText = `タイトル：雨の写真店
【カット1：冒頭】
ナレーション：目が覚めると、見慣れた天井だった。
【カット2：対立】
美緒：絶対に戻らない！
玲司：本当に、それでいいのか？
【カット3：内心】
美緒：どうしよう、本当に私だけなのか……
【カット4：時間経過】
ナレーション：その後、各地を巡り、日々と年月が過ぎた。
【カット5：重い反省】
ナレーション：けれど、約束を失った痛みだけは消えなかった。`;
  const registry = {
    characters: [
      { id: "mio", name: "美緒", kind: "character", status: "approved", referenceImagePaths: [] },
      { id: "reiji", name: "玲司", kind: "character", status: "approved", referenceImagePaths: [] },
    ],
  };
  const plan = createMangaScriptImagePlan({
    scriptText,
    episodeId: "planner-test",
    registry,
    canvasDir: root,
    assetDir: join(root, "assets"),
  });

  assert.ok(plan.editorialDecisions.some((entry) => entry.editorialPlate.type === "white-solid"));
  assert.ok(plan.editorialDecisions.some((entry) => entry.editorialPlate.type === "black-solid"));
  assert.ok(plan.editorialDecisions.some((entry) => entry.thoughtFocus.recommended));
  assert.ok(plan.pages.some((entry) => entry.editorial.split.type === "vertical-2"));
  assert.ok(plan.pages.some((entry) => entry.editorial.split.type === "story-3"));
  assert.ok(plan.pages.every((entry) => !(
    entry.editorial.split.recommended && entry.editorial.editorialPlate.recommended
  )));
  assert.ok(plan.pages.filter((entry) => entry.editorial.split.recommended).every((entry) => (
    entry.flattenBeforeCamera === true && entry.panelCamera === "static" && entry.wholePageCamera === true
  )));
  assert.ok(plan.jobs.filter((entry) => ["scene-image", "split-panel"].includes(entry.kind)).every((entry) => entry.imageCount === 1));
  assert.ok(plan.jobs.filter((entry) => entry.kind === "editorial-plate").every((entry) => entry.imageCount === 0));
  assert.equal(plan.compositionPlan.diagnostics.consecutiveTooSimilarCount, 0);
  assert.equal(plan.policy.splitPageCamera, "single-continuous");
  assert.equal(plan.policy.typographyGeneratedInImage, false);
  const storyPanels = plan.jobs.filter((entry) => entry.kind === "split-panel" && entry.editorial?.split?.type === "story-3");
  assert.ok(storyPanels.length >= 3);
  assert.match(storyPanels[0].prompt, /narrow full-height LEFT panel/u);
  assert.match(storyPanels[1].prompt, /UPPER-RIGHT panel/u);
  assert.match(storyPanels[2].prompt, /LOWER-RIGHT panel/u);
  assert.match(storyPanels[2].prompt, /face center between 58% and 70%/u);
  assert.ok(storyPanels.every((entry) => /same wardrobe across all three panels/u.test(entry.prompt)));
  const montagePage = plan.jobs.find((entry) => entry.kind === "split-page" && entry.montageTimeline === true);
  assert.ok(montagePage);
  assert.ok(montagePage.composition);
  assert.ok(Array.isArray(montagePage.castNames));
  assert.ok(Array.isArray(montagePage.fallbackReferenceImagePaths));
});

test("narration jobs carry the approved protagonist identity into first-person visual beats", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-narration-protagonist-"));
  const registry = {
    characters: [
      { id: "hero-arano", name: "荒野", kind: "character", status: "approved", referenceImagePaths: [] },
      { id: "sakura", name: "花園さくら", kind: "character", status: "approved", referenceImagePaths: [] },
    ],
  };
  const plan = createMangaScriptImagePlan({
    scriptText: "【カット1：大学】\n荒野: ここまで来た。\n花園さくら: 久しぶり。\nナレーション: 俺は大学の教室で英語の資料を開いた。",
    episodeId: "narration-protagonist-test",
    registry,
    canvasDir: root,
    assetDir: join(root, "assets"),
    protagonistSpeakerName: "荒野",
  });
  const narrationJob = plan.jobs.find((entry) => entry.id === "image:cut-01-u03" || entry.id.startsWith("panel:cut-01-u03"));
  assert.ok(narrationJob);
  assert.ok(narrationJob.characterIds.includes("hero-arano"));
  assert.match(narrationJob.prompt, /荒野 is the story protagonist/u);
});

test("third-person narration uses the explicitly named character instead of replacing them with the protagonist", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-third-person-narration-"));
  const registry = {
    characters: [
      { id: "hero-arano", name: "荒野", aliases: ["荒野くん"], kind: "character", status: "approved", referenceImagePaths: [] },
      { id: "sakura", name: "花園さくら", aliases: ["さくら", "花園さん"], kind: "character", status: "approved", referenceImagePaths: [] },
    ],
  };
  const plan = createMangaScriptImagePlan({
    scriptText: "【カット1：直前の場面】\n荒野: もう俺とは関係ない。\n【カット2：さくらの転落】\nナレーション: その後、さくらは仕事でミスを重ね、最終的に解雇された。\nナレーション: アルバイト生活に転落した。",
    episodeId: "third-person-narration-test",
    registry,
    canvasDir: root,
    assetDir: join(root, "assets"),
    protagonistSpeakerName: "荒野",
  });
  const sceneJobs = plan.jobs.filter((entry) => ["scene-image", "split-panel"].includes(entry.kind) && entry.composition?.cutId === "cut-02");
  assert.ok(sceneJobs.length > 0);
  assert.ok(sceneJobs.every((entry) => entry.characterIds.includes("sakura")));
  assert.ok(sceneJobs.every((entry) => !entry.characterIds.includes("hero-arano")));
  assert.ok(sceneJobs.every((entry) => /Cast: 花園さくら/u.test(entry.prompt)));
  assert.ok(sceneJobs.every((entry) => !/Narration identity anchor: 荒野/u.test(entry.prompt)));
});

test("multi-year plans make character identity stable while wardrobe follows the explicit age stage", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-age-stage-"));
  const registry = {
    characters: [
      { id: "hero-arano", name: "荒野", kind: "character", status: "approved", referenceImagePaths: [] },
      { id: "sakura", name: "花園さくら", kind: "character", status: "approved", referenceImagePaths: [] },
    ],
  };
  const plan = createMangaScriptImagePlan({
    scriptText: "【カット1：秋の放課後、音楽室での別れ】\n花園さくら: 別れよう\n荒野: 冗談だろ？",
    episodeId: "age-stage-test",
    registry,
    canvasDir: root,
    assetDir: join(root, "assets"),
    characterBible: { cast: [{ name: "荒野", description: "高校では濃紺ブレザー。社会人では濃紺スーツ。", invariants: ["同じ顔"], negativePrompt: "別人化" }] },
  });
  const scene = plan.jobs.find((entry) => entry.kind === "scene-image" || entry.kind === "split-panel");
  assert.match(scene.prompt, /High-school senior stage/u);
  assert.match(scene.prompt, /lock face, hair, body identity/u);
  assert.match(scene.prompt, /高校では濃紺ブレザー/u);
  assert.doesNotMatch(scene.prompt, /preserve approved identity sheets, clothing/u);
});

test("environment atlases explicitly require black gutters and montage locations remain distinct", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-environment-gutters-"));
  const plan = createMangaScriptImagePlan({
    scriptText: "【カット1：社会人生活と夜の電話】\n荒野: 今日も頑張ろう。\nナレーション: 社会人になって数ヶ月。夜はほぼ毎日電話で報告した。",
    episodeId: "environment-gutters-test",
    registry: { characters: [] },
    canvasDir: root,
    assetDir: join(root, "assets"),
  });
  const environment = plan.jobs.find((entry) => entry.kind === "environment-sheet");
  assert.equal(environment.location.multiScene, true);
  assert.match(environment.prompt, /solid, clearly visible black gutters/u);
  assert.match(environment.prompt, /do not blend the separate places into one impossible room/u);
});

test("education and career props are forced blank so generated pseudo-text cannot enter artwork", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-text-free-props-"));
  const plan = createMangaScriptImagePlan({
    scriptText: "【カット1：大学の講義室】\n荒野: 英語を学べる大学を選び、就活で内定をもらった。",
    episodeId: "text-free-props-test",
    registry: { characters: [] },
    canvasDir: root,
    assetDir: join(root, "assets"),
  });
  const scene = plan.jobs.find((entry) => entry.kind === "scene-image" || entry.kind === "split-panel");
  assert.match(scene.prompt, /every book cover, brochure, worksheet, notebook, phone screen, sign, badge, ticket, timetable, log, and document must be blank/u);
  assert.match(scene.prompt, /no letters, pseudo-text, numbers, notation, logos, or glyph-like lines/u);
  assert.equal(scene.textFreeEvidencePolicy, true);
});

test("unseen transit evidence scripts infer their real locations and keep records text-free", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-transit-evidence-"));
  const plan = createMangaScriptImagePlan({
    scriptText: "【カット1：閉鎖予定の山間バス停、早朝】\n佐藤 誠司: この時刻表、午前七時十分の便だけ剥がされていますね\n【カット2：古い駅舎で利用記録を照合する】\n佐藤 誠司: 券売機の記録には毎週金曜日、同じ区間の回数券が使われています",
    episodeId: "transit-evidence-test",
    registry: { characters: [] },
    canvasDir: root,
    assetDir: join(root, "assets"),
  });
  const environments = plan.jobs.filter((entry) => entry.kind === "environment-sheet");
  assert.deepEqual(environments.map((entry) => entry.location.id), ["mountain-bus-stop", "old-station-building"]);
  const evidenceScenes = plan.jobs.filter((entry) => ["scene-image", "split-panel"].includes(entry.kind));
  assert.ok(evidenceScenes.every((entry) => entry.textFreeEvidencePolicy === true));
  assert.ok(evidenceScenes.every((entry) => /Never attempt to write the quoted dates, times, weekdays, route names, or record fields/u.test(entry.prompt)));
  assert.ok(evidenceScenes.every((entry) => !/Location: 主要舞台/u.test(entry.prompt)));
});

test("breakup dialogue receives line-specific close staging instead of relying on generic correction", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-breakup-staging-"));
  const plan = createMangaScriptImagePlan({
    scriptText: "【カット1：音楽室】\n花園さくら: 別れよう\n花園さくら: 冗談なのはそっちでしょ。荒野くんにはがっかりしたわ。",
    episodeId: "breakup-staging-test",
    registry: { characters: [] },
    canvasDir: root,
    assetDir: join(root, "assets"),
  });
  const prompts = plan.jobs.filter((entry) => ["scene-image", "split-panel"].includes(entry.kind)).map((entry) => entry.prompt).join("\n");
  assert.match(prompts, /tight chest-up reaction two-shot/u);
  assert.match(prompts, /unmistakable palm-out stop gesture/u);
  assert.match(prompts, /half-lidded cold eyes/u);
  assert.match(prompts, /clean psychological gap/u);
});

test("blind QA distinguishes standalone split panels from the later flattened split page", () => {
  assert.match(mangaImageQaStructureContract({ kind: "split-panel" }), /exactly one standalone panel/u);
  assert.match(mangaImageQaStructureContract({ kind: "split-panel" }), /gutters are added only by the later split-page job/u);
  assert.match(mangaImageQaStructureContract({ kind: "split-page" }), /solid black dividers/u);
  assert.doesNotMatch(mangaImageQaStructureContract({ kind: "scene-image" }), /Require the authored number of panels/u);
  const panelPrompt = mangaImageQaVisualPrompt({ job: { kind: "split-panel", editorial: { split: { type: "story-3" } } } });
  const pagePrompt = mangaImageQaVisualPrompt({ job: { kind: "split-page", splitType: "story-3" } });
  assert.match(panelPrompt, /only one static source panel/u);
  assert.doesNotMatch(panelPrompt, /result must already be one flattened page/u);
  assert.match(pagePrompt, /final flattened page/u);
});

test("blind QA comparison order keeps one representative sheet for every expected cast member", () => {
  const candidates = mangaImageQaReferenceCandidates({
    fallbackReferenceImagePaths: ["amane-turnaround.png", "sakura-turnaround.png", "arano-turnaround.png"],
    referenceImagePaths: ["amane-turnaround.png", "amane-expressions.png", "sakura-expressions.png", "arano-expressions.png", "street.png"],
  });
  assert.deepEqual(candidates.slice(0, 3), ["amane-turnaround.png", "sakura-turnaround.png", "arano-turnaround.png"]);
  assert.equal(new Set(candidates).size, candidates.length);
});

test("executor respects fixed concurrency, retries only QA failures, and reuses completed jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-script-exec-"));
  const buffer = renderEditorialPlatePng("pastel-sky", 320, 180);
  let active = 0;
  let peak = 0;
  let generated = 0;
  const jobs = Array.from({ length: 13 }, (_, index) => ({
    id: `image:${index + 1}`,
    kind: "scene-image",
    dependencies: [],
    outputPath: join(root, `image-${index + 1}.png`),
    prompt: `scene ${index + 1}`,
    referenceImagePaths: [],
    model: "fake",
    aspectRatio: "16:9",
    imageSize: "2K",
    quality: "high",
    imageCount: 1,
    inputHash: `hash-${index + 1}`,
  }));
  const plan = {
    version: 1,
    episodeId: "executor-test",
    scriptSha256: "script-hash",
    assetDir: root,
    jobs,
  };
  const attempts = new Map();
  const generateImage = async (input) => {
    generated += 1;
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 12));
    active -= 1;
    return { buffer, fileName: input.fileName, mimeType: "image/png" };
  };
  const visualQa = async ({ job, attempt }) => {
    attempts.set(job.id, (attempts.get(job.id) || 0) + 1);
    if (job.id === "image:4" && attempt === 0) return { pass: false, issues: ["subject camera repeats previous frame"] };
    return { pass: true, issues: [] };
  };

  const first = await executeMangaScriptImagePlan(plan, { concurrency: 10, maxRetries: 1, generateImage, visualQa });
  assert.equal(first.ledger.status, "complete");
  assert.ok(peak <= 10);
  assert.ok(peak > 1);
  assert.equal(generated, 14);
  assert.equal(attempts.get("image:4"), 2);
  assert.equal(attempts.get("image:5"), 1);
  assert.equal(first.ledger.jobs["image:4"].retries, 1);

  const beforeReuse = generated;
  const second = await executeMangaScriptImagePlan(plan, { concurrency: 10, maxRetries: 1, generateImage, visualQa });
  assert.equal(second.ledger.status, "complete");
  assert.equal(generated, beforeReuse);
  assert.equal(second.ledger.summary.reused, 13);
  const persisted = JSON.parse(await readFile(second.ledgerPath, "utf8"));
  assert.equal(persisted.summary.complete, 13);
});

test("executor can explicitly retry only persistent failed jobs without regenerating completed work", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-script-retry-failed-"));
  const buffer = renderEditorialPlatePng("pastel-sky", 320, 180);
  const jobs = [1, 2].map((index) => ({
    id: `image:${index}`,
    kind: "scene-image",
    dependencies: [],
    outputPath: join(root, `image-${index}.png`),
    prompt: `scene ${index}`,
    referenceImagePaths: [],
    model: "fake",
    aspectRatio: "16:9",
    imageSize: "2K",
    quality: "high",
    imageCount: 1,
    inputHash: `hash-${index}`,
  }));
  const plan = { version: 2, episodeId: "retry-failed-test", scriptSha256: "retry-script", assetDir: root, jobs };
  let failSecond = true;
  const generationCounts = new Map();
  const generationPrompts = new Map();
  const generateImage = async ({ fileName, prompt }) => {
    generationCounts.set(fileName, (generationCounts.get(fileName) || 0) + 1);
    generationPrompts.set(fileName, [...(generationPrompts.get(fileName) || []), prompt]);
    return { buffer, fileName, mimeType: "image/png" };
  };
  const visualQa = async ({ job }) => job.id === "image:2" && failSecond
    ? { pass: false, issues: ["repair me"] }
    : { pass: true, issues: [] };
  const first = await executeMangaScriptImagePlan(plan, { maxRetries: 0, generateImage, visualQa });
  assert.equal(first.ledger.status, "failed");
  assert.equal(first.ledger.jobs["image:1"].status, "complete");
  failSecond = false;
  const second = await executeMangaScriptImagePlan(plan, { maxRetries: 0, retryFailed: true, generateImage, visualQa });
  assert.equal(second.ledger.status, "complete");
  assert.equal(generationCounts.get("image-1.png"), 1);
  assert.equal(generationCounts.get("image-2.png"), 2);
  assert.equal(generationPrompts.get("image-2.png")[0], "scene 2");
  assert.match(generationPrompts.get("image-2.png")[1], /CORRECTION PASS: Fix these failures: repair me/);
});

test("semantic replanning does not apply QA feedback from an obsolete input hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-replan-feedback-scope-"));
  const buffer = renderEditorialPlatePng("pastel-sky", 320, 180);
  const outputPath = join(root, "image.png");
  const originalPlan = {
    version: 2,
    episodeId: "replan-feedback-scope-test",
    scriptSha256: "same-script",
    assetDir: root,
    jobs: [{ id: "image:1", kind: "scene-image", dependencies: [], outputPath, prompt: "old macro scene", referenceImagePaths: [], model: "fake", imageCount: 1, inputHash: "old-hash" }],
  };
  const prompts = [];
  const generateImage = async ({ prompt }) => { prompts.push(prompt); return { buffer, mimeType: "image/png" }; };
  const first = await executeMangaScriptImagePlan(originalPlan, {
    maxRetries: 0,
    generateImage,
    visualQa: async () => ({ pass: false, issues: ["old macro crop is wrong"] }),
  });
  assert.equal(first.ledger.status, "failed");
  const replacementPlan = {
    ...originalPlan,
    jobs: [{ ...originalPlan.jobs[0], prompt: "new departure scene", inputHash: "new-hash" }],
  };
  const second = await executeMangaScriptImagePlan(replacementPlan, {
    maxRetries: 0,
    generateImage,
    visualQa: async () => ({ pass: true, issues: [] }),
  });
  assert.equal(second.ledger.status, "complete");
  assert.deepEqual(prompts, ["old macro scene", "new departure scene"]);
});

test("transient semantic QA crashes retry the verdict without regenerating the image", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-qa-infra-retry-"));
  const buffer = renderEditorialPlatePng("pastel-sky", 320, 180);
  const plan = {
    version: 2,
    episodeId: "qa-infra-retry-test",
    scriptSha256: "qa-infra-script",
    assetDir: root,
    jobs: [{ id: "image:1", kind: "scene-image", dependencies: [], outputPath: join(root, "image.png"), prompt: "scene", referenceImagePaths: [], model: "fake", imageCount: 1, inputHash: "qa-infra-hash" }],
  };
  let generated = 0;
  let qaAttempts = 0;
  const result = await executeMangaScriptImagePlan(plan, {
    maxRetries: 0,
    qaInfrastructureRetries: 2,
    generateImage: async () => { generated += 1; return { buffer, mimeType: "image/png" }; },
    visualQa: async () => {
      qaAttempts += 1;
      if (qaAttempts < 3) throw new Error("codex exited 1: transient stream disconnected");
      return { pass: true, issues: [] };
    },
  });
  assert.equal(result.ledger.status, "complete");
  assert.equal(generated, 1);
  assert.equal(qaAttempts, 3);
  assert.equal(result.ledger.jobs["image:1"].qaInfrastructureAttempts, 3);
});

test("executor retires stale ledger jobs when semantic replanning changes the active DAG", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-script-retire-stale-"));
  const buffer = renderEditorialPlatePng("pastel-sky", 320, 180);
  const originalPlan = {
    version: 2,
    episodeId: "retire-stale-test",
    scriptSha256: "same-script",
    assetDir: root,
    jobs: [{ id: "image:old", kind: "scene-image", dependencies: [], outputPath: join(root, "old.png"), prompt: "old", referenceImagePaths: [], model: "fake", imageCount: 1, inputHash: "old-hash" }],
  };
  const options = { generateImage: async () => ({ buffer, mimeType: "image/png" }), visualQa: async () => ({ pass: true, issues: [] }) };
  await executeMangaScriptImagePlan(originalPlan, options);
  const replacementPlan = {
    ...originalPlan,
    jobs: [{ id: "image:new", kind: "scene-image", dependencies: [], outputPath: join(root, "new.png"), prompt: "new", referenceImagePaths: [], model: "fake", imageCount: 1, inputHash: "new-hash" }],
  };
  const result = await executeMangaScriptImagePlan(replacementPlan, options);
  assert.equal(result.ledger.status, "complete");
  assert.equal(result.ledger.summary.complete, 1);
  assert.equal(result.ledger.jobs["image:old"], undefined);
  assert.equal(result.ledger.retiredJobs["image:old"].retiredReason, "not-present-in-current-plan");
});

test("usage limits persist a waiting checkpoint and resume the unfinished image without duplication", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-script-park-"));
  const ledgerPath = join(root, "image-generation-ledger.json");
  const outputPath = join(root, "image-1.png");
  const plan = {
    version: 1,
    episodeId: "park-test",
    scriptSha256: "park-script-hash",
    assetDir: root,
    jobs: [{
      id: "image:1",
      kind: "scene-image",
      dependencies: [],
      outputPath,
      prompt: "scene",
      referenceImagePaths: [],
      model: "fake",
      aspectRatio: "16:9",
      imageSize: "2K",
      quality: "high",
      imageCount: 1,
      inputHash: "park-input-hash",
    }],
  };
  const buffer = renderEditorialPlatePng("pastel-sky", 320, 180);
  let attempts = 0;
  let clockMs = 0;
  let parkedCheckpoint;
  const adaptiveController = new AdaptiveConcurrencyController({
    initial: 1,
    min: 1,
    max: 1,
    usageLimitPauseMs: 100,
    now: () => clockMs,
  });
  const result = await executeMangaScriptImagePlan(plan, {
    concurrency: "auto",
    ledgerPath,
    maxRetries: 0,
    adaptiveController,
    generateImage: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("usage limit reached");
      return { buffer, fileName: "image-1.png", mimeType: "image/png" };
    },
    visualQa: async () => ({ pass: true, issues: [] }),
    adaptiveRunOptions: {
      sleep: async (ms) => { clockMs += ms; },
      onPark: async () => { parkedCheckpoint = JSON.parse(await readFile(ledgerPath, "utf8")); },
    },
  });
  assert.equal(parkedCheckpoint.status, "waiting");
  assert.equal(parkedCheckpoint.jobs["image:1"].status, "waiting");
  assert.equal(result.ledger.status, "complete");
  assert.equal(result.ledger.jobs["image:1"].status, "complete");
  assert.equal(attempts, 2);
});

test("fixed image concurrency also parks the whole pool on a usage limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-script-fixed-park-"));
  const outputPath = join(root, "image-1.png");
  const plan = {
    version: 1,
    episodeId: "fixed-park-test",
    scriptSha256: "fixed-park-script-hash",
    assetDir: root,
    jobs: [1, 2].map((index) => ({
      id: `image:${index}`,
      kind: "scene-image",
      dependencies: [],
      outputPath: join(root, `image-${index}.png`),
      prompt: `scene ${index}`,
      referenceImagePaths: [],
      model: "fake",
      aspectRatio: "16:9",
      imageSize: "2K",
      quality: "high",
      imageCount: 1,
      inputHash: `fixed-park-input-hash-${index}`,
    })),
  };
  const buffer = renderEditorialPlatePng("pastel-sky", 320, 180);
  let attempts = 0;
  const attemptOrder = [];
  let clockMs = 0;
  let parked = 0;
  const adaptiveController = new AdaptiveConcurrencyController({
    mode: "fixed",
    fixedLimit: 1,
    usageLimitPauseMs: 100,
    now: () => clockMs,
  });
  const result = await executeMangaScriptImagePlan(plan, {
    concurrency: 1,
    adaptiveController,
    generateImage: async ({ fileName }) => {
      attempts += 1;
      attemptOrder.push(fileName);
      if (attempts === 1) throw new Error("生成上限に達しました");
      return { buffer, fileName, mimeType: "image/png" };
    },
    visualQa: async () => ({ pass: true, issues: [] }),
    adaptiveRunOptions: {
      sleep: async (ms) => { clockMs += ms; },
      onPark: async () => { parked += 1; },
    },
  });
  assert.equal(parked, 1);
  assert.equal(attempts, 3);
  assert.deepEqual(attemptOrder, ["image-1.png", "image-1.png", "image-2.png"]);
  assert.equal(result.ledger.status, "complete");
  assert.equal(result.ledger.summary.concurrency, "1");
});

test("an explicitly contracted fallback model handles a primary usage limit and records provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-script-model-fallback-"));
  const outputPath = join(root, "image-1.png");
  const plan = {
    version: 1,
    episodeId: "model-fallback-test",
    scriptSha256: "model-fallback-script-hash",
    assetDir: root,
    jobs: [{
      id: "image:1",
      kind: "scene-image",
      dependencies: [],
      outputPath,
      prompt: "scene",
      referenceImagePaths: ["one.png", "two.png", "three.png", "four.png"],
      fallbackReferenceImagePaths: ["one.png", "three.png", "four.png"],
      model: "primary-image-model",
      aspectRatio: "16:9",
      imageSize: "2K",
      quality: "high",
      imageCount: 1,
      inputHash: "model-fallback-input-hash",
    }],
  };
  const buffer = renderEditorialPlatePng("pastel-sky", 320, 180);
  const calls = [];
  const result = await executeMangaScriptImagePlan(plan, {
    concurrency: 1,
    fallbackImageModel: "fallback-image-model",
    generateImage: async (input) => {
      calls.push({ model: input.model, refs: input.referenceImagePaths });
      if (input.model === "primary-image-model") throw new Error("生成上限に達しました");
      return { buffer, fileName: "image-1.png", mimeType: "image/png" };
    },
    visualQa: async () => ({ pass: true, issues: [] }),
  });
  assert.equal(result.ledger.status, "complete");
  assert.deepEqual(calls, [
    { model: "primary-image-model", refs: ["one.png", "two.png", "three.png", "four.png"] },
    { model: "fallback-image-model", refs: ["one.png", "three.png", "four.png"] },
  ]);
  assert.equal(result.ledger.jobs["image:1"].generationModel, "fallback-image-model");
  assert.equal(result.ledger.jobs["image:1"].fallbackFromModel, "primary-image-model");
  assert.equal(result.ledger.summary.fallbackGenerated, 1);
});

test("a contracted visual-QA fallback evaluates the same generated image after Codex usage exhaustion", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-script-qa-fallback-"));
  const outputPath = join(root, "image-1.png");
  const plan = {
    version: 1,
    episodeId: "qa-fallback-test",
    scriptSha256: "qa-fallback-script-hash",
    assetDir: root,
    jobs: [{
      id: "image:1",
      kind: "scene-image",
      dependencies: [],
      outputPath,
      prompt: "scene",
      referenceImagePaths: [],
      model: "fake",
      aspectRatio: "16:9",
      imageSize: "2K",
      quality: "high",
      imageCount: 1,
      inputHash: "qa-fallback-input-hash",
    }],
  };
  const buffer = renderEditorialPlatePng("pastel-sky", 320, 180);
  let generated = 0;
  let primaryQa = 0;
  let fallbackQa = 0;
  const result = await executeMangaScriptImagePlan(plan, {
    concurrency: 1,
    qaFallbackProvider: "grok",
    generateImage: async () => { generated += 1; return { buffer, mimeType: "image/png" }; },
    visualQa: async () => { primaryQa += 1; throw new Error("You've hit your usage limit"); },
    fallbackVisualQa: async () => {
      fallbackQa += 1;
      return { pass: true, score: 94, hardFailures: [], issues: [], evaluator: "grok-headless-blind-vision" };
    },
  });
  assert.equal(result.ledger.status, "complete");
  assert.equal(generated, 1);
  assert.equal(primaryQa, 1);
  assert.equal(fallbackQa, 1);
  assert.equal(result.ledger.jobs["image:1"].qa.semantic.evaluator, "grok-headless-blind-vision");
  assert.equal(result.ledger.summary.qaFallbackApproved, 1);
});

test("usage-limit fallbacks stay open for the rest of one image pipeline run", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-script-fallback-circuit-"));
  const plan = {
    version: 1,
    episodeId: "fallback-circuit-test",
    scriptSha256: "fallback-circuit-script-hash",
    assetDir: root,
    jobs: [1, 2].map((index) => ({
      id: `image:${index}`,
      kind: "scene-image",
      dependencies: [],
      outputPath: join(root, `image-${index}.png`),
      prompt: `scene ${index}`,
      referenceImagePaths: [],
      model: "primary-image-model",
      aspectRatio: "16:9",
      imageSize: "2K",
      quality: "high",
      imageCount: 1,
      inputHash: `fallback-circuit-input-hash-${index}`,
    })),
  };
  const buffer = renderEditorialPlatePng("pastel-sky", 320, 180);
  let primaryImages = 0;
  let fallbackImages = 0;
  let primaryQa = 0;
  let fallbackQa = 0;
  const result = await executeMangaScriptImagePlan(plan, {
    concurrency: 1,
    fallbackImageModel: "fallback-image-model",
    qaFallbackProvider: "grok",
    generateImage: async (input) => {
      if (input.model === "primary-image-model") {
        primaryImages += 1;
        throw new Error("You've hit your usage limit");
      }
      fallbackImages += 1;
      return { buffer, mimeType: "image/png" };
    },
    visualQa: async () => {
      primaryQa += 1;
      throw new Error("You've hit your usage limit");
    },
    fallbackVisualQa: async () => {
      fallbackQa += 1;
      return { pass: true, score: 94, hardFailures: [], issues: [], evaluator: "grok-headless-blind-vision" };
    },
  });
  assert.equal(result.ledger.status, "complete");
  assert.equal(primaryImages, 1);
  assert.equal(fallbackImages, 2);
  assert.equal(primaryQa, 1);
  assert.equal(fallbackQa, 2);
  assert.equal(result.ledger.jobs["image:2"].primaryGenerationSkippedReason, "usage-limit-circuit-open");
});

test("usage-limit fallback circuits resume from the persistent ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-script-fallback-resume-"));
  const makeJob = (index) => ({
    id: `image:${index}`,
    kind: "scene-image",
    dependencies: [],
    outputPath: join(root, `image-${index}.png`),
    prompt: `scene ${index}`,
    referenceImagePaths: [],
    model: "primary-image-model",
    aspectRatio: "16:9",
    imageSize: "2K",
    quality: "high",
    imageCount: 1,
    inputHash: `fallback-resume-input-hash-${index}`,
  });
  const basePlan = {
    version: 1,
    episodeId: "fallback-resume-test",
    scriptSha256: "fallback-resume-script-hash",
    assetDir: root,
  };
  const buffer = renderEditorialPlatePng("pastel-sky", 320, 180);
  let primaryImages = 0;
  let fallbackImages = 0;
  let primaryQa = 0;
  let fallbackQa = 0;
  const options = {
    concurrency: 1,
    fallbackImageModel: "fallback-image-model",
    qaFallbackProvider: "grok",
    generateImage: async (input) => {
      if (input.model === "primary-image-model") {
        primaryImages += 1;
        throw new Error("You've hit your usage limit");
      }
      fallbackImages += 1;
      return { buffer, mimeType: "image/png" };
    },
    visualQa: async () => {
      primaryQa += 1;
      throw new Error("You've hit your usage limit");
    },
    fallbackVisualQa: async () => {
      fallbackQa += 1;
      return {
        pass: true,
        score: 94,
        hardFailures: [],
        issues: [],
        evaluator: "grok-headless-blind-vision",
        fallbackFromEvaluator: "codex-ephemeral-blind-vision",
      };
    },
  };
  await executeMangaScriptImagePlan({ ...basePlan, jobs: [makeJob(1)] }, options);
  const result = await executeMangaScriptImagePlan({ ...basePlan, jobs: [makeJob(1), makeJob(2)] }, options);
  assert.equal(result.ledger.status, "complete");
  assert.equal(primaryImages, 1);
  assert.equal(fallbackImages, 2);
  assert.equal(primaryQa, 1);
  assert.equal(fallbackQa, 2);
  assert.equal(result.ledger.jobs["image:2"].primaryGenerationSkippedReason, "usage-limit-circuit-open");
});

test("retry-failed rechecks an image after pure QA infrastructure failure without regenerating it", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-script-qa-only-retry-"));
  const outputPath = join(root, "image-1.png");
  const plan = {
    version: 1,
    episodeId: "qa-only-retry-test",
    scriptSha256: "qa-only-retry-script-hash",
    assetDir: root,
    jobs: [{ id: "image:1", kind: "scene-image", dependencies: [], outputPath, prompt: "scene", referenceImagePaths: [], model: "fake", aspectRatio: "16:9", imageSize: "2K", quality: "high", imageCount: 1, inputHash: "qa-only-retry-hash" }],
  };
  const buffer = renderEditorialPlatePng("pastel-sky", 320, 180);
  let generated = 0;
  const first = await executeMangaScriptImagePlan(plan, {
    concurrency: 1,
    maxRetries: 0,
    qaInfrastructureRetries: 0,
    generateImage: async () => { generated += 1; return { buffer, mimeType: "image/png" }; },
    visualQa: async () => { throw new Error("vision transport crashed"); },
  });
  assert.equal(first.ledger.status, "failed");
  assert.equal(generated, 1);
  const second = await executeMangaScriptImagePlan(plan, {
    concurrency: 1,
    maxRetries: 0,
    retryFailed: true,
    generateImage: async () => { generated += 1; return { buffer, mimeType: "image/png" }; },
    visualQa: async () => ({ pass: true, score: 95, hardFailures: [], issues: [], evaluator: "recovered-vision" }),
  });
  assert.equal(second.ledger.status, "complete");
  assert.equal(generated, 1);
  assert.equal(second.ledger.jobs["image:1"].reusedGeneratedForQa, true);
});

test("pipeline concurrency parser supports auto, arbitrary fixed limits, and validation-only unlimited", () => {
  assert.deepEqual(normalizeScriptImageConcurrency(), { mode: "auto", initial: 16, label: "auto" });
  assert.deepEqual(normalizeScriptImageConcurrency("37"), { mode: "fixed", fixedLimit: 37, initial: 37, label: "37" });
  assert.deepEqual(normalizeScriptImageConcurrency("unlimited"), { mode: "unlimited", initial: 64, label: "unlimited" });
});

test("editorial plate renderer emits exact PNG dimensions for every supported plate", () => {
  for (const type of ["white-solid", "black-solid", "pastel-sky"]) {
    const png = renderEditorialPlatePng(type, 640, 360);
    assert.equal(png.toString("ascii", 1, 4), "PNG");
    assert.equal(png.readUInt32BE(16), 640);
    assert.equal(png.readUInt32BE(20), 360);
  }
});

test("split panels are flattened into one 1920x1080 page before camera motion", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-split-page-"));
  const buffer = renderEditorialPlatePng("pastel-sky", 640, 360);
  const panel1 = join(root, "panel-1.png");
  const panel2 = join(root, "panel-2.png");
  const page = join(root, "page.png");
  const plan = {
    version: 1,
    episodeId: "split-page-test",
    scriptSha256: "split-script",
    assetDir: root,
    jobs: [
      { id: "panel:1", kind: "split-panel", dependencies: [], outputPath: panel1, prompt: "left", referenceImagePaths: [], model: "fake", imageCount: 1, inputHash: "p1" },
      { id: "panel:2", kind: "split-panel", dependencies: [], outputPath: panel2, prompt: "right", referenceImagePaths: [], model: "fake", imageCount: 1, inputHash: "p2" },
      { id: "split-page:1", kind: "split-page", dependencies: ["panel:1", "panel:2"], panelPaths: [panel1, panel2], outputPath: page, splitType: "vertical-2", separatorWidthRatio: 0.0145, imageCount: 0, inputHash: "page" },
    ],
  };
  const result = await executeMangaScriptImagePlan(plan, {
    generateImage: async () => ({ buffer, mimeType: "image/png" }),
    visualQa: async () => ({ pass: true, issues: [] }),
  });
  assert.equal(result.ledger.status, "complete");
  const flattened = await readFile(page);
  assert.equal(flattened.readUInt32BE(16), 1920);
  assert.equal(flattened.readUInt32BE(20), 1080);
  assert.equal(result.ledger.jobs["split-page:1"].attempts, 1);
});

test("one-call pipeline pauses after generating candidates for a genuinely new character", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-new-character-"));
  const buffer = renderEditorialPlatePng("pastel-sky", 320, 180);
  let generated = 0;
  const result = await runMangaScriptImagePipeline({
    projectDir: root,
    episodeId: "new-character-test",
    scriptText: "【カット1：部屋】\n新田：ここから始めよう。",
    candidateCount: 3,
    concurrency: 10,
    generateImage: async () => {
      generated += 1;
      return { buffer, mimeType: "image/png" };
    },
  });
  assert.equal(result.status, "awaiting-character-approval");
  assert.equal(result.cast.length, 1);
  assert.equal(result.cast[0].candidates.length, 3);
  assert.deepEqual(result.cast[0].candidates.map((entry) => entry.label).sort(), ["A", "B", "C"]);
  assert.equal(result.cast[0].candidates.some((entry) => entry.id || entry.variationAxis), false);
  assert.equal(generated, 3);
});

test("one-call pipeline finishes all image jobs for approved cast without intermediate input", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-approved-character-"));
  await writeCharacterRegistry({ projectDir: root }, {
    characters: [{ id: "nitta", name: "新田", kind: "character", role: "per-video", episodeId: "approved-test", status: "approved", referenceImagePaths: [] }],
    voices: [],
  });
  const buffer = renderEditorialPlatePng("pastel-sky", 320, 180);
  let generated = 0;
  const result = await runMangaScriptImagePipeline({
    projectDir: root,
    episodeId: "approved-test",
    scriptText: "【カット1：写真店】\n新田：この写真を確かめよう。",
    concurrency: 10,
    autoSemanticQa: false,
    generateImage: async () => {
      generated += 1;
      return { buffer, mimeType: "image/png" };
    },
  });
  assert.equal(result.status, "complete");
  assert.equal(result.ledger.summary.complete, result.plan.jobs.length);
  assert.ok(result.plan.jobs.some((entry) => entry.kind === "environment-sheet"));
  assert.ok(result.plan.jobs.some((entry) => entry.kind === "scene-image"));
  assert.equal(generated, 2);
});
