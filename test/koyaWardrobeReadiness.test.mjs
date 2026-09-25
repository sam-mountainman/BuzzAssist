import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeCharacterRegistry } from "../lib/characterRegistry.mjs";
import { finalizeRunReceipt, openRunReceipt, recordGatesFromAuditSteps } from "../lib/harnessRunReceipt.mjs";
import {
  assertKoyaWardrobeReadinessBeforeImages,
  generateKoyaMangaImages,
  koyaEpisodePaths,
  koyaWardrobeReadinessPauseResult,
  runKoyaMangaFullProduction,
  runKoyaWardrobeReadiness,
} from "../lib/koyaMangaProduction.mjs";
import { resolveKoyaMangaProductionContract } from "../lib/koyaMangaProductionContract.mjs";
import { parseMangaScript } from "../lib/mangaVideoPipeline.mjs";
import { executeVideoHarnessAdapter } from "../lib/videoHarnessAdapters.mjs";
import {
  auditKoyaWardrobeReadinessFinal,
  evaluateKoyaWardrobeReadiness,
  KOYA_WARDROBE_READINESS_IN_FORCE_SINCE,
  KOYA_WARDROBE_READINESS_REQUIRED_CODE,
  KOYA_WARDROBE_REVIEW_VERSION,
  koyaWardrobeScriptDigest,
} from "../lib/koyaWardrobeReadiness.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EPISODE_ID = "manga-wardrobe-fixture-001";
const JOB_ID = "video-koya-manga-video-0123456789abcdef";
const GENERATOR_CONTEXT = "generator-session-0001";
const REVIEWER_CONTEXT = "reviewer-session-0002";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** 台帳: チャンネル共通の承認済み人物ひとり、今回限りの人物、場所。 */
function registryWith({ outfits = [] } = {}) {
  return normalizeCharacterRegistry({
    characters: [
      {
        id: "yamada-hanako",
        name: "山田花子",
        kind: "character",
        role: "fixed",
        status: "approved",
        aliases: ["花子"],
        referenceAssets: [
          { id: "identity-face", role: "identity-face", path: "characters/hanako-face.png", sha256: "a".repeat(64) },
          ...outfits,
        ],
      },
      {
        id: "tanaka-ichiro",
        name: "田中一郎",
        kind: "character",
        role: "per-video",
        status: "approved",
        episodeId: EPISODE_ID,
        referenceAssets: [{ id: "identity-face", role: "identity-face", path: "characters/ichiro-face.png", sha256: "b".repeat(64) }],
      },
      {
        id: "shotengai-street",
        name: "商店街",
        kind: "location",
        status: "approved",
        episodeId: EPISODE_ID,
        referenceAssets: [{ id: "board", role: "supplemental", path: "locations/street.png", sha256: "c".repeat(64) }],
      },
    ],
    voices: [],
  });
}

function showBibleWith(wardrobe = undefined, cast = [{ id: "yamada-hanako", name: "山田花子" }]) {
  return { version: "koya-show-bible-v1", cast, ...(wardrobe ? { wardrobe } : {}) };
}

const CAFE_SCENE = [
  "#場面 1 喫茶店・朝",
  "",
  "朝の喫茶店で、山田花子は開店の準備をしていた。",
  "",
  "山田花子：今日もいい天気ですね",
].join("\n");

const POOL_SCENE = [
  "#場面 2 市民プール・昼",
  "",
  "夏の市民プール。花子はプールサイドで友人を待っていた。",
  "",
  "山田花子：ここ、久しぶり",
  "",
  "山田花子：水がきれい",
  "",
  "山田花子：少し休もう",
  "",
  "山田花子：日差しが強いね",
].join("\n");

const DIALOGUE_ONLY_POOL_SCENE = [
  "#場面 3 喫茶店・昼",
  "",
  "山田花子：今度プールに行こうよ",
].join("\n");

function sceneScript(...scenes) {
  return [
    "---",
    "タイトル: 喫茶店の朝",
    "登場人物:",
    "  - 名前: 山田花子",
    "    区分: 常連",
    "    主人公: はい",
    "---",
    "",
    ...scenes,
    "",
  ].join("\n");
}

const LEGACY_SCRIPT = [
  "タイトル：喫茶店の朝",
  "【カット1：開店】",
  "ナレーション：朝の喫茶店で、山田花子は開店の準備をしていた。",
  "山田花子：今日もいい天気ですね",
  "【カット2：プールへ】",
  "ナレーション：夏の市民プール。花子はプールサイドにいた。",
  "山田花子：ここ、久しぶり",
  "",
].join("\n");

function evaluate(scriptText, { registry = registryWith(), showBible = showBibleWith(), review = null, reviewSha256 = "", generatorContexts = [] } = {}) {
  return evaluateKoyaWardrobeReadiness({
    episodeId: EPISODE_ID,
    scriptText,
    parsed: parseMangaScript(scriptText, { registry }),
    registry,
    showBible,
    review,
    reviewSha256,
    generatorContexts,
  });
}

test("特別な場面の無い台本は、照合を通り、全カットの服が記録される", () => {
  const report = evaluate(sceneScript(CAFE_SCENE));
  assert.equal(report.pass, true);
  assert.equal(report.status, "pass");
  assert.deepEqual(report.slots, []);
  assert.deepEqual(report.pendingSlotIds, []);
  // 照合した人物と場面ごとに、何を着るかが残ること。
  assert.deepEqual(report.assignments.map((entry) => [entry.castId, entry.sceneKey, entry.matchedOutfit.kind]), [
    ["yamada-hanako", "scene-1", "base"],
  ]);
  assert.equal(report.assignments[0].matchedOutfit.source, "base-outfit");
  // エピソード専用の人物と場所は照合対象ではない。
  assert.deepEqual(report.checkedCharacters.map((entry) => entry.castId), ["yamada-hanako"]);
});

test("プール場面に出る固定キャストに水着が無ければ、該当カットを並べた pending スロットになる", () => {
  const report = evaluate(sceneScript(CAFE_SCENE, POOL_SCENE));
  assert.equal(report.pass, false);
  assert.equal(report.status, "pending");
  assert.equal(report.slots.length, 1);
  const [slot] = report.slots;
  assert.equal(slot.slotId, `wardrobe-${EPISODE_ID}-yamada-hanako-swim`);
  assert.equal(slot.castId, "yamada-hanako");
  assert.deepEqual(slot.sceneTags, ["swim"]);
  assert.equal(slot.status, "pending");
  assert.equal(slot.matchedOutfit, null);
  // 1つの場面が複数カットに割れても、スロットは1つで、カットを列挙する。
  assert.equal(slot.sceneKeys.length, 1);
  assert.ok(slot.sceneRef.length > 1, "分割された場面の全カットが sceneRef に並ぶこと");
  assert.deepEqual(slot.sceneRef, report.scenes.filter((scene) => scene.sceneKey === "scene-2").flatMap((scene) => scene.cutIds));
  assert.match(slot.requirement, /swim/u);
  assert.ok(slot.evidence.some((entry) => entry.keyword === "プール"), "根拠のキーワードが残ること");
  assert.deepEqual(report.pendingSlotIds, [slot.slotId]);
});

test("sceneTags に swim を持つ登録済みの衣装があれば、生成なしで適合する", () => {
  const registry = registryWith({
    outfits: [{
      id: "outfit-poolside",
      role: "outfit",
      path: "characters/hanako-swimwear.png",
      storyStage: "poolside",
      sceneTags: ["swim"],
      sha256: "d".repeat(64),
    }],
  });
  const report = evaluate(sceneScript(CAFE_SCENE, POOL_SCENE), { registry });
  assert.equal(report.pass, true);
  assert.deepEqual(report.pendingSlotIds, []);
  const [slot] = report.slots;
  assert.equal(slot.status, "matched");
  assert.deepEqual(slot.matchedOutfit, {
    kind: "outfit",
    assetId: "outfit-poolside",
    storyStage: "poolside",
    sha256: "d".repeat(64),
    sceneTags: ["swim"],
    source: "outfit-scene-tags",
  });
  const poolAssignment = report.assignments.find((entry) => entry.sceneTags.includes("swim"));
  assert.equal(poolAssignment.matchedOutfit.assetId, "outfit-poolside");
  // タグの無い場面はベース衣装のまま。
  assert.equal(report.assignments.find((entry) => entry.sceneKey === "scene-1").matchedOutfit.kind, "base");
});

test("台詞の中のプールは場面の属性にならない", () => {
  const report = evaluate(sceneScript(CAFE_SCENE, DIALOGUE_ONLY_POOL_SCENE));
  assert.equal(report.pass, true);
  assert.deepEqual(report.slots, []);
  const scene = report.scenes.find((entry) => entry.sceneKey === "scene-3");
  assert.deepEqual(scene.sceneTags, []);
  assert.deepEqual(scene.evidence, []);
});

test("Channel Pack は語彙とキーワードを足せる（daily/work/home も、足したときだけスロットになる）", () => {
  const registry = registryWith({
    outfits: [{
      id: "outfit-tea-ceremony",
      role: "outfit",
      path: "characters/hanako-kimono.png",
      storyStage: "tea-ceremony",
      sha256: "e".repeat(64),
    }],
  });
  const showBible = showBibleWith(
    {
      sceneTagVocabulary: ["tea-ceremony"],
      sceneTagKeywords: { "tea-ceremony": ["お茶会"], work: ["オフィス"] },
    },
    [{
      id: "yamada-hanako",
      name: "山田花子",
      // ベース衣装は普段着と家だけ。職場は別の服が要る番組。
      baseOutfitSceneTags: ["daily", "home"],
      outfitStages: [{ id: "tea-ceremony", label: "茶席", description: "茶席の和装", sceneTags: ["tea-ceremony"] }],
    }],
  );
  const script = sceneScript(
    CAFE_SCENE,
    ["#場面 2 茶室・昼", "", "お茶会の支度が進んでいた。山田花子も席に入る。", "", "山田花子：よろしくお願いします"].join("\n"),
    ["#場面 3 オフィス・夕", "", "夕方のオフィスで、花子は書類を抱えていた。", "", "山田花子：もう少しで終わります"].join("\n"),
  );
  const report = evaluate(script, { registry, showBible });
  // 追加した語彙は show bible の outfitStages 側のタグ付けで覆える。
  const teaSlot = report.slots.find((slot) => slot.sceneTags.includes("tea-ceremony"));
  assert.equal(teaSlot.status, "matched");
  assert.equal(teaSlot.matchedOutfit.assetId, "outfit-tea-ceremony");
  // work は Channel Pack がキーワードを足して初めて検出され、ベース衣装が
  // 覆わないと宣言されているのでスロットになる。
  const workSlot = report.slots.find((slot) => slot.sceneTags.includes("work"));
  assert.equal(workSlot.status, "pending");
  assert.equal(report.pass, false);
  // 既定（Channel Pack の宣言なし）では work は検出されない。
  const plain = evaluate(script, { registry });
  assert.deepEqual(plain.slots.map((slot) => slot.sceneTags), []);
  assert.equal(plain.pass, true);
});

test("レビュー記録はスロットを解決し、生成と同じコンテキストのレビューは受け取らない", () => {
  const generatorContexts = [{ role: "gate-invocation", host: "claude", id: `claude:${GENERATOR_CONTEXT}`, contextId: GENERATOR_CONTEXT }];
  const script = sceneScript(CAFE_SCENE, POOL_SCENE);
  const pending = evaluate(script, { generatorContexts });
  const [slot] = pending.slots;
  const review = {
    version: KOYA_WARDROBE_REVIEW_VERSION,
    episodeId: EPISODE_ID,
    scriptDigest: pending.scriptDigest,
    inventoryDigest: pending.inventoryDigest,
    reviewer: { host: "claude", id: `claude:${REVIEWER_CONTEXT}`, contextId: REVIEWER_CONTEXT },
    reviewedAt: "2026-09-18T01:00:00.000Z",
    decisions: [{ slotId: slot.slotId, decision: "fits", outfit: "base", reason: "プールサイドの見学で、水には入らない場面のため" }],
  };
  const resolved = evaluate(script, { generatorContexts, review, reviewSha256: "f".repeat(64) });
  assert.equal(resolved.pass, true);
  assert.equal(resolved.slots[0].status, "resolved");
  assert.equal(resolved.slots[0].matchedOutfit.kind, "base");
  assert.equal(resolved.slots[0].matchedOutfit.source, "review");
  assert.equal(resolved.slots[0].resolution.reason, review.decisions[0].reason);
  assert.equal(resolved.review.reviewer.contextId, REVIEWER_CONTEXT);
  assert.equal(
    resolved.assignments.find((entry) => entry.sceneTags.includes("swim")).matchedOutfit.source,
    "review",
    "解決したスロットの場面は、レビューが認めた服で記録されること",
  );

  // 生成と同じコンテキストが書いたレビューは、理由が書いてあっても数えない。
  const sameContext = structuredClone(review);
  sameContext.reviewer = { host: "claude", id: `claude:${GENERATOR_CONTEXT}`, contextId: GENERATOR_CONTEXT };
  assert.throws(
    () => evaluate(script, { generatorContexts, review: sameContext, reviewSha256: "f".repeat(64) }),
    /not independent/u,
  );
  // 台本や在庫が変わった後の古いレビューも受け取らない。
  const staleDigest = structuredClone(review);
  staleDigest.inventoryDigest = "0".repeat(64);
  assert.throws(() => evaluate(script, { generatorContexts, review: staleDigest, reviewSha256: "f".repeat(64) }), /inventoryDigest/u);
  // 「合わない」判定はスロットを残す（理由だけが記録される）。
  const rejected = structuredClone(review);
  rejected.decisions = [{ slotId: slot.slotId, decision: "does-not-fit", reason: "泳ぐ場面なので水着が要る" }];
  const stillPending = evaluate(script, { generatorContexts, review: rejected, reviewSha256: "f".repeat(64) });
  assert.equal(stillPending.pass, false);
  assert.equal(stillPending.slots[0].status, "pending");
  assert.equal(stillPending.slots[0].resolution.decision, "does-not-fit");
});

test("旧形式（カット見出し）の台本でも、カット目的とナレーションから同じ判定になる", () => {
  const report = evaluate(LEGACY_SCRIPT);
  assert.equal(report.pass, false);
  assert.equal(report.slots.length, 1);
  assert.deepEqual(report.slots[0].sceneRef, ["cut-02"]);
  assert.deepEqual(report.slots[0].sceneTags, ["swim"]);
  assert.deepEqual(report.scenes.map((scene) => scene.sceneKey), ["cut-01", "cut-02"]);
});

test("矛盾する2つの場面タグは、機械で決めず undecidable にする", () => {
  const script = sceneScript(
    ["#場面 1 斎場・昼", "", "雪の降る日、葬儀の会場に山田花子が立っていた。", "", "山田花子：お世話になりました"].join("\n"),
  );
  const report = evaluate(script);
  assert.equal(report.pass, false);
  const [slot] = report.slots;
  assert.deepEqual(slot.sceneTags, ["formal", "winter-out"]);
  assert.equal(slot.status, "undecidable");
  assert.match(slot.requirement, /機械では決められない/u);
});

// ---------------------------------------------------------------------------
// 実際の作業場（台帳・show bible・レポートのファイル）を通した経路

function minimalPng() {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(1920, 16);
  header.writeUInt32BE(1080, 20);
  header[24] = 8;
  header[25] = 6;
  return header;
}

async function writeProject({ registry = registryWith(), script = sceneScript(CAFE_SCENE, POOL_SCENE) } = {}) {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-wardrobe-"));
  const canvasDir = join(projectDir, "canvas");
  await mkdir(join(canvasDir, "assets", EPISODE_ID), { recursive: true });
  await writeFile(join(canvasDir, "assets", EPISODE_ID, "page-01.png"), minimalPng());
  await writeFile(join(canvasDir, "characters.json"), `${JSON.stringify(registry, null, 2)}\n`);
  const scriptPath = join(projectDir, "script.txt");
  await writeFile(scriptPath, script);
  return { projectDir, canvasDir, scriptPath, paths: koyaEpisodePaths(projectDir, EPISODE_ID) };
}

function wardrobeRuntime(showBible = showBibleWith(), extra = {}) {
  return {
    env: {},
    readKoyaChannelAuthority: async () => ({ source: "project", showBible }),
    ...extra,
  };
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("wardrobe-readiness は在庫を画像計画の隣へ書き、pending なら終了コード2で止める", async () => {
  const project = await writeProject();
  try {
    const pending = await runKoyaWardrobeReadiness({
      projectDir: project.projectDir,
      episodeId: EPISODE_ID,
      scriptPath: project.scriptPath,
      generatorHost: "claude",
      generatorContextId: GENERATOR_CONTEXT,
    }, wardrobeRuntime());
    assert.equal(pending.exitCode, 2);
    assert.equal(pending.reportPath, project.paths.wardrobeReadinessPath);
    assert.equal(pending.report.pendingSlotIds.length, 1);
    const written = await readJsonFile(project.paths.wardrobeReadinessPath);
    assert.equal(written.episodeId, EPISODE_ID);
    assert.equal(written.scriptDigest, koyaWardrobeScriptDigest(await readFile(project.scriptPath, "utf8")));
    assert.ok(written.generatedAt, "generatedAt が入ること");
    const state = await readJsonFile(project.paths.statePath);
    assert.equal(state.wardrobeReadiness.status, "pending");
    assert.deepEqual(state.wardrobeReadiness.pendingSlotIds, written.pendingSlotIds);
    // 照合だけでは制作状態（本体）を動かさない。
    assert.equal(state.status, undefined);

    // 水着を登録し直せば、同じ台本がそのまま通る。
    const registry = registryWith({
      outfits: [{ id: "outfit-poolside", role: "outfit", path: "characters/hanako-swimwear.png", storyStage: "poolside", sceneTags: ["swim"], sha256: "d".repeat(64) }],
    });
    await writeFile(join(project.canvasDir, "characters.json"), `${JSON.stringify(registry, null, 2)}\n`);
    const passed = await runKoyaWardrobeReadiness({
      projectDir: project.projectDir,
      episodeId: EPISODE_ID,
      scriptPath: project.scriptPath,
      generatorHost: "claude",
      generatorContextId: GENERATOR_CONTEXT,
    }, wardrobeRuntime());
    assert.equal(passed.exitCode, 0);
    assert.equal(passed.report.slots[0].matchedOutfit.assetId, "outfit-poolside");
  } finally {
    await rm(project.projectDir, { recursive: true, force: true });
  }
});

test("有料の画像生成は、pass レポートが無い・古い・台本が変わったときに始まらない", async () => {
  const project = await writeProject();
  const options = {
    projectDir: project.projectDir,
    episodeId: EPISODE_ID,
    scriptPath: project.scriptPath,
    generatorHost: "claude",
    generatorContextId: GENERATOR_CONTEXT,
  };
  const runtime = wardrobeRuntime();
  try {
    // 1. レポートが無い
    const missing = await assert.rejects(
      assertKoyaWardrobeReadinessBeforeImages(options, { runtime }),
      (error) => error.code === KOYA_WARDROBE_READINESS_REQUIRED_CODE && error.wardrobeStatus === "missing",
    );
    assert.equal(missing, undefined);
    const paused = await readJsonFile(project.paths.statePath);
    assert.equal(paused.status, "awaiting-wardrobe-readiness");
    assert.equal(paused.currentStage, "wardrobe-readiness");
    assert.equal(paused.knownRemainingIssues[0].id, "wardrobe-readiness-required");

    // 2. pending のレポートがある
    await runKoyaWardrobeReadiness(options, runtime);
    await assert.rejects(
      assertKoyaWardrobeReadinessBeforeImages(options, { runtime }),
      (error) => error.code === KOYA_WARDROBE_READINESS_REQUIRED_CODE
        && error.wardrobeStatus === "pending"
        && error.slotIds.length === 1,
    );

    // 3. 適合する衣装を登録して pass
    const registry = registryWith({
      outfits: [{ id: "outfit-poolside", role: "outfit", path: "characters/hanako-swimwear.png", storyStage: "poolside", sceneTags: ["swim"], sha256: "d".repeat(64) }],
    });
    await writeFile(join(project.canvasDir, "characters.json"), `${JSON.stringify(registry, null, 2)}\n`);
    // 台帳が変わったので、古いレポートはそのままでは使えない。
    await assert.rejects(
      assertKoyaWardrobeReadinessBeforeImages(options, { runtime }),
      (error) => error.code === KOYA_WARDROBE_READINESS_REQUIRED_CODE && error.wardrobeStatus === "pending",
    );
    await runKoyaWardrobeReadiness(options, runtime);
    const ok = await assertKoyaWardrobeReadinessBeforeImages(options, { runtime });
    assert.equal(ok.pass, true);
    assert.equal(ok.status, "pass");
    const state = await readJsonFile(project.paths.statePath);
    assert.equal(state.wardrobeReadiness.status, "pass");
    assert.equal(state.wardrobeReadiness.reportSha256, ok.binding.reportSha256);

    // 4. 台本を書き換えるとレポートは無効になる
    await writeFile(project.scriptPath, `${await readFile(project.scriptPath, "utf8")}\n山田花子：おつかれさま\n`);
    await assert.rejects(
      assertKoyaWardrobeReadinessBeforeImages(options, { runtime }),
      (error) => error.code === KOYA_WARDROBE_READINESS_REQUIRED_CODE
        && error.wardrobeStatus === "stale"
        && /scriptDigest/u.test(error.message),
    );
  } finally {
    await rm(project.projectDir, { recursive: true, force: true });
  }
});

test("台帳の変化で pass が壊れたら、古いレポートを合格として使わない", async () => {
  const registry = registryWith({
    outfits: [{ id: "outfit-poolside", role: "outfit", path: "characters/hanako-swimwear.png", storyStage: "poolside", sceneTags: ["swim"], sha256: "d".repeat(64) }],
  });
  const project = await writeProject({ registry });
  const options = {
    projectDir: project.projectDir,
    episodeId: EPISODE_ID,
    scriptPath: project.scriptPath,
    generatorHost: "claude",
    generatorContextId: GENERATOR_CONTEXT,
  };
  const runtime = wardrobeRuntime();
  try {
    assert.equal((await runKoyaWardrobeReadiness(options, runtime)).exitCode, 0);
    assert.equal((await assertKoyaWardrobeReadinessBeforeImages(options, { runtime })).pass, true);
    // 水着の登録を外す（台帳から消える／別の服に差し替わる）。
    await writeFile(join(project.canvasDir, "characters.json"), `${JSON.stringify(registryWith(), null, 2)}\n`);
    await assert.rejects(
      assertKoyaWardrobeReadinessBeforeImages(options, { runtime }),
      (error) => error.code === KOYA_WARDROBE_READINESS_REQUIRED_CODE && /登録|registry|show bible/u.test(error.message),
    );
  } finally {
    await rm(project.projectDir, { recursive: true, force: true });
  }
});

test("運営者のオーバーライドは理由が要り、在庫・制作状態・最終監査に残る", async () => {
  const project = await writeProject();
  const options = {
    projectDir: project.projectDir,
    episodeId: EPISODE_ID,
    scriptPath: project.scriptPath,
    generatorHost: "claude",
    generatorContextId: GENERATOR_CONTEXT,
  };
  const runtime = wardrobeRuntime();
  try {
    await assert.rejects(
      assertKoyaWardrobeReadinessBeforeImages({ ...options, wardrobeReadinessOverrideReason: "…" }, { runtime }),
      /concrete reason/u,
      "空に近い理由ではゲートを外せないこと",
    );
    const overridden = await assertKoyaWardrobeReadinessBeforeImages(
      { ...options, wardrobeReadinessOverrideReason: "プール場面は後ろ姿だけで衣装が映らないと運営者が判断した" },
      { runtime },
    );
    assert.equal(overridden.pass, true);
    assert.equal(overridden.status, "overridden");
    const report = await readJsonFile(project.paths.wardrobeReadinessPath);
    assert.equal(report.operatorOverride.reason, "プール場面は後ろ姿だけで衣装が映らないと運営者が判断した");
    assert.equal(report.operatorOverride.refusedStatus, "missing");
    assert.equal(report.status, "pending", "レポート自体は嘘をつかない（スロットは pending のまま）");
    const state = await readJsonFile(project.paths.statePath);
    assert.equal(state.wardrobeReadiness.status, "overridden");
    assert.equal(state.wardrobeReadiness.overrideHistory.length, 1);

    // 最終監査は、オーバーライドを合格として飲み込まず必ず表に出す。
    const audit = auditKoyaWardrobeReadinessFinal({
      state,
      report,
      reportPath: project.paths.wardrobeReadinessPath,
      reportSha256: sha256(await readFile(project.paths.wardrobeReadinessPath)),
      episodeId: EPISODE_ID,
      scriptDigest: report.scriptDigest,
    });
    assert.equal(audit.pass, true);
    assert.equal(audit.status, "overridden");
    assert.equal(audit.overrides.length, 1);
    assert.match(audit.detail, /override/u);
    // 別の台本のオーバーライドは、この回の合格にならない。
    const otherScript = auditKoyaWardrobeReadinessFinal({
      state,
      report,
      episodeId: EPISODE_ID,
      scriptDigest: "9".repeat(64),
    });
    assert.equal(otherScript.pass, false);
    assert.equal(otherScript.status, "override-stale");
  } finally {
    await rm(project.projectDir, { recursive: true, force: true });
  }
});

test("最終監査は、pass レポートを合格にし、記録の無い回（ゲート導入前）は測定対象外にする", async () => {
  const registry = registryWith({
    outfits: [{ id: "outfit-poolside", role: "outfit", path: "characters/hanako-swimwear.png", storyStage: "poolside", sceneTags: ["swim"], sha256: "d".repeat(64) }],
  });
  const project = await writeProject({ registry });
  try {
    const options = {
      projectDir: project.projectDir,
      episodeId: EPISODE_ID,
      scriptPath: project.scriptPath,
      generatorHost: "claude",
      generatorContextId: GENERATOR_CONTEXT,
    };
    await runKoyaWardrobeReadiness(options, wardrobeRuntime());
    await assertKoyaWardrobeReadinessBeforeImages(options, { runtime: wardrobeRuntime() });
    const state = await readJsonFile(project.paths.statePath);
    const report = await readJsonFile(project.paths.wardrobeReadinessPath);
    const passed = auditKoyaWardrobeReadinessFinal({
      state,
      report,
      reportPath: project.paths.wardrobeReadinessPath,
      episodeId: EPISODE_ID,
      scriptDigest: report.scriptDigest,
    });
    assert.equal(passed.pass, true);
    assert.equal(passed.applicable, true);
    assert.equal(passed.status, "pass");

    // 手で書き換えたレポートは合格にしない。
    const forged = structuredClone(report);
    forged.slots = [];
    const tampered = auditKoyaWardrobeReadinessFinal({ state, report: forged, episodeId: EPISODE_ID, scriptDigest: report.scriptDigest });
    assert.equal(tampered.pass, false);
    assert.match(tampered.detail, /outcomeDigest/u);

    // ゲートより前に画像を作った回（記録が一つも無い）は測定対象外。
    const legacy = auditKoyaWardrobeReadinessFinal({ state: { episodeId: EPISODE_ID }, report: null, episodeId: EPISODE_ID, scriptDigest: report.scriptDigest });
    assert.equal(legacy.applicable, false);
    assert.equal(legacy.pass, true);
    assert.equal(legacy.status, "not-in-force");
    assert.match(legacy.detail, new RegExp(KOYA_WARDROBE_READINESS_IN_FORCE_SINCE, "u"));
  } finally {
    await rm(project.projectDir, { recursive: true, force: true });
  }
});

/** Koya 本番テストと同じ、テスト専用の直接 preflight 用 doctor レポート。 */
function measuredDoctorReport(projectDir) {
  const ids = [
    "harness-production-route", "node", "ffmpeg", "ffprobe", "ffmpeg-capability",
    "voice-quality-python", "tts-key", "image-key", "channel-pack",
  ];
  const files = ["show.json", "locations.json", "thumbnail.json"].map((path, index) => ({
    role: ["show", "locations", "thumbnail"][index],
    path,
    sha256: String(index + 1).repeat(64),
    bytes: 2,
  }));
  const fingerprint = { version: "koya-channel-authority-fingerprint-v1", fileCount: files.length, files };
  return {
    version: "harness-doctor-v1",
    projectDir,
    harnessId: "koya-manga-video",
    ready: true,
    blocking: [],
    checks: ids.map((id) => ({
      id,
      required: true,
      ok: true,
      ...(id === "tts-key" ? {
        kind: "voice.dialogue",
        provider: "elevenlabs",
        model: "eleven_v3",
        adapterVersion: "elevenlabs-dialogue-server-v1",
        status: "ready",
      } : {}),
      ...(id === "image-key" ? { host: "codex", model: "gpt-image-2-codex" } : {}),
      ...(id === "channel-pack" ? { authorityFingerprint: { ...fingerprint, sha256: sha256(JSON.stringify(fingerprint)) } } : {}),
    })),
  };
}

function directRuntime(projectDir, extra = {}) {
  return {
    allowDirectMeasuredDoctorForTests: true,
    runDoctor: async () => measuredDoctorReport(projectDir),
    now: () => Date.parse("2026-09-18T00:00:00.000Z"),
    ...wardrobeRuntime(showBibleWith(), extra),
  };
}

test("画像工程は、照合を計画より前に走らせ、pass のときだけ生成へ進む", async () => {
  const project = await writeProject();
  const calls = [];
  const runtime = directRuntime(project.projectDir, {
    planProduction: async (options) => {
      calls.push("plan");
      return {
        episodeId: options.episodeId,
        paths: project.paths,
        plan: { production: {} },
        resolved: await resolveKoyaMangaProductionContract({ projectDir: root, episodeId: options.episodeId }),
        state: {},
      };
    },
    runImagePipeline: async () => {
      calls.push("images");
      return { status: "complete", planPath: "", plan: null, ledgerPath: "" };
    },
  });
  const options = {
    projectDir: project.projectDir,
    episodeId: EPISODE_ID,
    scriptPath: project.scriptPath,
    generatorHost: "claude",
    generatorContextId: GENERATOR_CONTEXT,
  };
  try {
    await assert.rejects(
      generateKoyaMangaImages(options, runtime),
      (error) => error.code === KOYA_WARDROBE_READINESS_REQUIRED_CODE,
    );
    assert.deepEqual(calls, [], "照合が通るまで、計画も有料生成も始まらないこと");

    const registry = registryWith({
      outfits: [{ id: "outfit-poolside", role: "outfit", path: "characters/hanako-swimwear.png", storyStage: "poolside", sceneTags: ["swim"], sha256: "d".repeat(64) }],
    });
    await writeFile(join(project.canvasDir, "characters.json"), `${JSON.stringify(registry, null, 2)}\n`);
    await runKoyaWardrobeReadiness(options, wardrobeRuntime());
    const result = await generateKoyaMangaImages(options, runtime);
    assert.deepEqual(calls, ["plan", "images"]);
    assert.equal(result.state.status, "images-ready");
    const state = await readJsonFile(project.paths.statePath);
    assert.equal(state.wardrobeReadiness.status, "pass");
  } finally {
    await rm(project.projectDir, { recursive: true, force: true });
  }
});

test("full は照合待ちで Job を失敗にせず、終了コード3で再開できる形に止める", async () => {
  const project = await writeProject();
  try {
    const result = await runKoyaMangaFullProduction({
      projectDir: project.projectDir,
      episodeId: EPISODE_ID,
      scriptPath: project.scriptPath,
      protagonistSpeakerId: "山田花子",
      generatorHost: "claude",
      generatorContextId: GENERATOR_CONTEXT,
    }, directRuntime(project.projectDir, {
      // 声のゲートと台本の関門はこのテストの対象外（先に通ったことにする）。
      checkScriptQuality: async () => ({ pass: true }),
      checkVoiceSelectionsBeforeImages: async () => ({ pass: true }),
      generateSpeech: async () => { throw new Error("speech must not start"); },
    }));
    assert.equal(result.exitCode, 3);
    assert.equal(result.payload.status, "awaiting-wardrobe-readiness");
    assert.equal(result.payload.waiting, true);
    assert.equal(result.payload.stage, "before-images");
    assert.equal(result.payload.checkpoint, project.paths.statePath);
    assert.equal(result.payload.wardrobeReadiness.status, "missing");
    assert.match(result.payload.knownRemainingIssues[0], /^wardrobe-readiness-required: missing/u);
    await assert.rejects(access(project.paths.imagePlanPath), { code: "ENOENT" }, "画像計画は作られないこと");

    // 上位 Job は awaiting-human-review（終端ではない）で待つ。
    const outcome = await executeVideoHarnessAdapter({
      job: {
        id: JOB_ID,
        harness: { id: "koya-manga-video" },
        projectDir: project.projectDir,
        script: { path: project.scriptPath },
        options: {
          episodeId: EPISODE_ID,
          protagonistSpeakerId: "yamada-hanako",
          characterBiblePath: join(project.projectDir, "character-bible.json"),
          storyReviewPath: join(project.projectDir, "story-review.json"),
        },
        stages: [],
      },
      runChild: async () => ({ code: result.exitCode, signal: null, stdout: `${JSON.stringify(result.payload, null, 2)}\n`, stderr: "" }),
    });
    assert.equal(outcome.status, "awaiting-human-review");
    assert.match(outcome.knownRemainingIssues[0], /wardrobe-readiness-required/u);
  } finally {
    await rm(project.projectDir, { recursive: true, force: true });
  }
});

test("Job の option で渡した理由だけが、子の CLI へオーバーライドとして届く", async () => {
  let invokedArgs = [];
  const job = {
    id: JOB_ID,
    harness: { id: "koya-manga-video" },
    projectDir: root,
    script: { path: join(root, "script.txt") },
    options: {
      episodeId: EPISODE_ID,
      protagonistSpeakerId: "yamada-hanako",
      characterBiblePath: join(root, "character-bible.json"),
      storyReviewPath: join(root, "story-review.json"),
    },
    stages: [],
  };
  const runChild = async (_command, args) => {
    invokedArgs = args;
    return { code: 3, signal: null, stdout: JSON.stringify({ status: "awaiting-wardrobe-readiness", knownRemainingIssues: ["wardrobe-readiness-required: missing"] }), stderr: "" };
  };
  await executeVideoHarnessAdapter({ job, runChild });
  assert.equal(invokedArgs.includes("--wardrobe-readiness-override-reason"), false);
  await executeVideoHarnessAdapter({
    job: { ...job, options: { ...job.options, wardrobeReadinessOverrideReason: "導入前に画像を作った回のため" } },
    runChild,
  });
  assert.equal(invokedArgs[invokedArgs.indexOf("--wardrobe-readiness-override-reason") + 1], "導入前に画像を作った回のため");
});

test("パウス結果は wardrobe 以外の失敗を飲み込まない", () => {
  assert.equal(koyaWardrobeReadinessPauseResult(new Error("other"), { projectDir: root, episodeId: EPISODE_ID }), null);
  const paused = koyaWardrobeReadinessPauseResult(
    Object.assign(new Error("fixture"), { code: KOYA_WARDROBE_READINESS_REQUIRED_CODE, wardrobeStatus: "pending", slotIds: ["slot-1"], inventoryPath: "/tmp/inventory.json" }),
    { preflight: null, projectDir: root, episodeId: EPISODE_ID, stage: "before-images" },
  );
  assert.equal(paused.exitCode, 3);
  assert.deepEqual(paused.payload.wardrobeReadiness, { status: "pending", inventoryPath: "/tmp/inventory.json", pendingSlotIds: ["slot-1"] });
});

test("契約へ足したゲートで、前の版の契約で合格した回が後から落ちない", async () => {
  const declaration = JSON.parse(await readFile(join(root, "config/harnesses/koya-manga-video.harness.json"), "utf8"));
  const contract = JSON.parse(await readFile(join(root, "config/koya-manga-production-contract.json"), "utf8"));
  const guarantee = declaration.guarantees.find((entry) => entry.id === "wardrobe-readiness");
  assert.equal(guarantee.inForceSince, KOYA_WARDROBE_READINESS_IN_FORCE_SINCE);
  assert.equal(contract.wardrobeReadiness.inForceSince, KOYA_WARDROBE_READINESS_IN_FORCE_SINCE);
  assert.ok(contract.requiredAudits.includes("wardrobe-readiness"));

  const previous = KOYA_WARDROBE_READINESS_IN_FORCE_SINCE.replace(/\d+$/u, (value) => String(Number(value) - 1));
  const olderAudits = contract.requiredAudits.filter((id) => id !== "wardrobe-readiness");
  const measure = (contractVersion, requiredAuditIds) => {
    const receipt = openRunReceipt({ projectDir: root, harnessId: "koya-manga-video", entrypoint: "scripts/koya-manga-video.mjs", action: "audit", inputs: {} });
    recordGatesFromAuditSteps(receipt, {
      declaration,
      steps: requiredAuditIds.map((id) => ({ id, pass: true })),
      requiredAuditIds,
      contractVersion,
    });
    return finalizeRunReceipt(receipt, { outcome: "pass", timestamp: "2026-09-18T00:00:00.000Z" });
  };
  const past = measure(previous, olderAudits);
  assert.equal(past.outcome, "pass", "当時の契約を満たした過去作が、足した保証で落ちないこと");
  assert.deepEqual(past.summary.notInForceGates, ["wardrobe-readiness"]);
  assert.equal(past.gates["wardrobe-readiness"].verdict, "skip");
  // 現行の契約では、この監査が無ければ記録は通らない。
  const now = measure(contract.version, olderAudits);
  assert.equal(now.outcome, "fail");
  assert.deepEqual(now.summary.skippedGates, ["wardrobe-readiness"]);
  assert.equal(measure(contract.version, contract.requiredAudits).outcome, "pass");
});

// --- 修正round: レビュー指摘への回帰テスト ---------------------------------

/** 台帳には人物のほかに場所・小物も入る（この経路は location-register が書く）。 */
function registryWithSetPieces() {
  return normalizeCharacterRegistry({
    characters: [
      {
        id: "yamada-hanako",
        name: "山田花子",
        kind: "character",
        role: "fixed",
        status: "approved",
        aliases: ["花子"],
        referenceAssets: [{ id: "identity-face", role: "identity-face", path: "characters/hanako-face.png", sha256: "a".repeat(64) }],
      },
      {
        id: "yukimura-midori",
        name: "雪村みどり",
        kind: "character",
        role: "fixed",
        status: "approved",
        referenceAssets: [{ id: "identity-face", role: "identity-face", path: "characters/midori-face.png", sha256: "b".repeat(64) }],
      },
      {
        id: "shimin-pool",
        name: "市民プール",
        kind: "location",
        status: "approved",
        referenceAssets: [{ id: "board", role: "supplemental", path: "locations/pool.png", sha256: "c".repeat(64) }],
      },
      {
        id: "yukata-prop",
        name: "浴衣",
        kind: "prop",
        status: "approved",
        referenceAssets: [{ id: "board", role: "supplemental", path: "props/yukata.png", sha256: "e".repeat(64) }],
      },
    ],
    voices: [],
  });
}

test("登録済みの場所や小物の名前は、場面の根拠を消さない（伏せるのは人の名前だけ）", () => {
  const registry = registryWithSetPieces();
  const showBible = showBibleWith(undefined, [{ id: "yamada-hanako", name: "山田花子" }, { id: "yukimura-midori", name: "雪村みどり" }]);

  // 場所「市民プール」が登録されていても、プール場面は swim のまま。
  const pool = evaluate(sceneScript([
    "#場面 1 市民プール・昼",
    "",
    "夏の市民プール。山田花子は友人を待っていた。",
    "",
    "山田花子：久しぶり",
  ].join("\n")), { registry, showBible });
  assert.equal(pool.pass, false, "場所名がキーワードを含んでも、ゲートは黙って開かないこと");
  assert.deepEqual(pool.scenes[0].sceneTags, ["swim"]);
  assert.equal(pool.slots.length, 1);
  assert.equal(pool.slots[0].castId, "yamada-hanako");

  // 小物「浴衣」が登録されていても、浴衣の場面は summer-out のまま。
  const festival = evaluate(sceneScript([
    "#場面 1 商店街・夜",
    "",
    "山田花子は浴衣で通りを歩いていた。",
    "",
    "山田花子：涼しいね",
  ].join("\n")), { registry, showBible });
  assert.deepEqual(festival.scenes[0].sceneTags, ["summer-out"]);
  assert.equal(festival.slots.length, 1);

  // 人の名前は今までどおり伏せる（「雪村みどり」が冬の場面を作らない）。
  // ただし黙って落とさず、伏せたせいで消えたキーワードを在庫に残す。
  const person = evaluate(sceneScript([
    "#場面 1 喫茶店・朝",
    "",
    "雪村みどりは喫茶店の扉を開けた。",
    "",
    "雪村みどり：おはよう",
  ].join("\n")), { registry, showBible });
  assert.equal(person.pass, true);
  assert.deepEqual(person.scenes[0].sceneTags, []);
  assert.deepEqual(person.scenes[0].maskedKeywordHits, [
    { tag: "winter-out", keyword: "雪", source: "narration:cut-01-u01", maskedBy: ["雪村みどり"] },
  ]);
  assert.equal(person.summary.maskedKeywordHitCount, 1);
});

test("この回の判定に関係の無い台帳の書き込みでは、pass レポートが無効にならない", async () => {
  const registry = registryWith({
    outfits: [{ id: "outfit-poolside", role: "outfit", path: "characters/hanako-swimwear.png", storyStage: "poolside", sceneTags: ["swim"], sha256: "d".repeat(64) }],
  });
  const project = await writeProject({ registry });
  const options = {
    projectDir: project.projectDir,
    episodeId: EPISODE_ID,
    scriptPath: project.scriptPath,
    generatorHost: "claude",
    generatorContextId: GENERATOR_CONTEXT,
  };
  const runtime = wardrobeRuntime();
  try {
    assert.equal((await runKoyaWardrobeReadiness(options, runtime)).exitCode, 0);
    assert.equal((await assertKoyaWardrobeReadinessBeforeImages(options, { runtime })).pass, true);

    // 来期のキャストを1人登録する（この回の台本には出ない）。在庫の digest は
    // 変わるが、この回の判定は1文字も変わらないので Job は止まらない。
    const widened = structuredClone(registry);
    widened.characters.push({
      id: "suzuki-jiro",
      name: "鈴木次郎",
      kind: "character",
      role: "fixed",
      status: "approved",
      referenceAssets: [{ id: "identity-face", role: "identity-face", path: "characters/jiro-face.png", sha256: "f".repeat(64) }],
    });
    await writeFile(join(project.canvasDir, "characters.json"), `${JSON.stringify(normalizeCharacterRegistry(widened), null, 2)}\n`);
    const still = await assertKoyaWardrobeReadinessBeforeImages(options, { runtime });
    assert.equal(still.pass, true, "関係の無い登録で pass レポートを捨てないこと");

    const report = await readJsonFile(project.paths.wardrobeReadinessPath);
    const fresh = await runKoyaWardrobeReadiness(options, runtime);
    assert.notEqual(fresh.report.inventoryDigest, report.inventoryDigest, "在庫そのものは変わること");
    assert.equal(fresh.report.verdictDigest, report.verdictDigest, "判定は変わらないこと");

    // この回に効く変更（着る予定の服が台帳から消える）は、今までどおり止める。
    await writeFile(join(project.canvasDir, "characters.json"), `${JSON.stringify(registryWith(), null, 2)}\n`);
    await assert.rejects(
      assertKoyaWardrobeReadinessBeforeImages(options, { runtime }),
      (error) => error.code === KOYA_WARDROBE_READINESS_REQUIRED_CODE,
    );
  } finally {
    await rm(project.projectDir, { recursive: true, force: true });
  }
});

test("verdictDigest に結び付けたレビューは、関係の無い登録では失効しない", () => {
  const generatorContexts = [{ role: "gate-invocation", host: "claude", id: `claude:${GENERATOR_CONTEXT}`, contextId: GENERATOR_CONTEXT }];
  const script = sceneScript(CAFE_SCENE, POOL_SCENE);
  const pending = evaluate(script, { generatorContexts });
  const review = {
    version: KOYA_WARDROBE_REVIEW_VERSION,
    episodeId: EPISODE_ID,
    scriptDigest: pending.scriptDigest,
    verdictDigest: pending.verdictDigest,
    reviewer: { host: "claude", id: `claude:${REVIEWER_CONTEXT}`, contextId: REVIEWER_CONTEXT },
    reviewedAt: "2026-09-18T01:00:00.000Z",
    decisions: [{ slotId: pending.slots[0].slotId, decision: "fits", outfit: "base", reason: "プールサイドの見学で、水には入らない場面のため" }],
  };
  assert.equal(evaluate(script, { generatorContexts, review, reviewSha256: "f".repeat(64) }).pass, true);

  // 別の人物を登録しても（在庫は変わる）、この回の判定は同じなのでレビューは生きている。
  const widened = structuredClone(registryWith());
  widened.characters.push({
    id: "suzuki-jiro",
    name: "鈴木次郎",
    kind: "character",
    role: "fixed",
    status: "approved",
    referenceAssets: [{ id: "identity-face", role: "identity-face", path: "characters/jiro-face.png", sha256: "f".repeat(64) }],
  });
  const registry = normalizeCharacterRegistry(widened);
  const later = evaluate(script, { registry, generatorContexts, review, reviewSha256: "f".repeat(64) });
  assert.equal(later.pass, true);
  assert.equal(later.slots[0].status, "resolved");

  // 判定そのものが変わった後の古いレビューは、今までどおり受け取らない。
  const stale = structuredClone(review);
  stale.verdictDigest = "0".repeat(64);
  assert.throws(() => evaluate(script, { generatorContexts, review: stale, reviewSha256: "f".repeat(64) }), /verdictDigest/u);
});

test("照合待ちの記録は、進行中の回のチェックポイントを壊さない", async () => {
  const project = await writeProject();
  const options = {
    projectDir: project.projectDir,
    episodeId: EPISODE_ID,
    scriptPath: project.scriptPath,
    generatorHost: "claude",
    generatorContextId: GENERATOR_CONTEXT,
  };
  const runtime = wardrobeRuntime();
  try {
    // 画像を作り終えて音声・レンダー待ちの回を再開したとき。
    await mkdir(dirname(project.paths.statePath), { recursive: true });
    await writeFile(project.paths.statePath, `${JSON.stringify({
      version: "koya-production-state-v1",
      episodeId: EPISODE_ID,
      status: "speech-ready",
      currentStage: "render",
      knownRemainingIssues: [{ id: "bubble-typography", detail: "縦組みの追い込みを目視で確認する" }],
    }, null, 2)}\n`);
    await assert.rejects(
      assertKoyaWardrobeReadinessBeforeImages(options, { runtime }),
      (error) => error.code === KOYA_WARDROBE_READINESS_REQUIRED_CODE,
    );
    const paused = await readJsonFile(project.paths.statePath);
    assert.equal(paused.status, "speech-ready", "再開位置を上書きしないこと");
    assert.equal(paused.currentStage, "render");
    assert.deepEqual(paused.knownRemainingIssues.map((entry) => entry.id), ["bubble-typography", "wardrobe-readiness-required"]);
    assert.equal(paused.wardrobeReadiness.status, "missing");

    // 画像より前の回は、今までどおり照合待ちへ移り、通れば元の位置へ戻る。
    await writeFile(project.paths.statePath, `${JSON.stringify({
      version: "koya-production-state-v1",
      episodeId: EPISODE_ID,
      status: "planned",
      currentStage: "images",
      knownRemainingIssues: [],
    }, null, 2)}\n`);
    await assert.rejects(
      assertKoyaWardrobeReadinessBeforeImages(options, { runtime }),
      (error) => error.code === KOYA_WARDROBE_READINESS_REQUIRED_CODE,
    );
    const waiting = await readJsonFile(project.paths.statePath);
    assert.equal(waiting.status, "awaiting-wardrobe-readiness");
    assert.equal(waiting.currentStage, "wardrobe-readiness");
    assert.deepEqual(waiting.wardrobeReadiness.interrupted, { status: "planned", currentStage: "images" });

    const registry = registryWith({
      outfits: [{ id: "outfit-poolside", role: "outfit", path: "characters/hanako-swimwear.png", storyStage: "poolside", sceneTags: ["swim"], sha256: "d".repeat(64) }],
    });
    await writeFile(join(project.canvasDir, "characters.json"), `${JSON.stringify(registry, null, 2)}\n`);
    await runKoyaWardrobeReadiness(options, runtime);
    assert.equal((await assertKoyaWardrobeReadinessBeforeImages(options, { runtime })).pass, true);
    const resumed = await readJsonFile(project.paths.statePath);
    assert.equal(resumed.status, "planned", "通ったら元の位置へ戻すこと");
    assert.equal(resumed.currentStage, "images");
    assert.deepEqual(resumed.knownRemainingIssues, []);
  } finally {
    await rm(project.projectDir, { recursive: true, force: true });
  }
});

test("別の台本が持っている episode id には、照合の記録を書かない", async () => {
  const project = await writeProject();
  const options = {
    projectDir: project.projectDir,
    episodeId: EPISODE_ID,
    scriptPath: project.scriptPath,
    generatorHost: "claude",
    generatorContextId: GENERATOR_CONTEXT,
  };
  try {
    await mkdir(dirname(project.paths.imagePlanPath), { recursive: true });
    await mkdir(dirname(project.paths.statePath), { recursive: true });
    await writeFile(project.paths.imagePlanPath, `${JSON.stringify({ scriptSha256: "9".repeat(64), pages: [] }, null, 2)}\n`);
    await writeFile(project.paths.statePath, `${JSON.stringify({
      version: "koya-production-state-v1",
      episodeId: EPISODE_ID,
      status: "images-ready",
      currentStage: "source-face-placement",
      knownRemainingIssues: [],
    }, null, 2)}\n`);
    const skipped = await assertKoyaWardrobeReadinessBeforeImages(options, { runtime: wardrobeRuntime() });
    assert.deepEqual(skipped, { skipped: "episode-owns-another-script" }, "所有権の誤りは計画が自分の言葉で断ること");
    const state = await readJsonFile(project.paths.statePath);
    assert.equal(state.status, "images-ready");
    assert.equal(state.wardrobeReadiness, undefined, "他の台本の回の記録を書き換えないこと");
  } finally {
    await rm(project.projectDir, { recursive: true, force: true });
  }
});
