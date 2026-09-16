import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildCharacterIdentityPrompt,
  eyeOpenVariantId,
  normalizeCharacterRegistry,
  optimizeCharacterBindingsForGeneration,
  readCharacterRegistry,
  resolveCharacterBindings,
  resolveCharacterReferencePaths,
  selectEyeOpenReferenceAsset,
  writeCharacterRegistry,
} from "../lib/characterRegistry.mjs";
import { nextBatchChunkOrigin } from "../lib/mediaGeneration.mjs";

test("normalizeCharacterRegistry fills defaults, validates enums, and dedupes ids", () => {
  const registry = normalizeCharacterRegistry({
    characters: [
      { id: "hero", name: "主人公", kind: "character", role: "per-video", referenceImagePaths: ["assets/hero.png", "", "assets/hero.png"] },
      { id: "hero", name: "duplicate should drop" },
      { id: "sword", kind: "prop", role: "unknown-role", referenceImagePaths: ["assets/sword.png"] },
      { name: "名前だけ" },
      null,
    ],
    voices: [{ id: "narration", elevenLabsVoiceId: "v_123" }, null],
  });

  assert.equal(registry.characters.length, 3);
  const [hero, sword, unnamed] = registry.characters;
  assert.deepEqual(
    { id: hero.id, kind: hero.kind, role: hero.role, referenceImagePaths: hero.referenceImagePaths },
    { id: "hero", kind: "character", role: "per-video", referenceImagePaths: ["assets/hero.png"] },
  );
  assert.deepEqual({ kind: sword.kind, role: sword.role }, { kind: "prop", role: "fixed" });
  assert.equal(unnamed.name, "名前だけ");
  assert.equal(registry.voices.length, 1);
  assert.equal(registry.voices[0].role, "narration");
});

test("resolveCharacterReferencePaths resolves ids and names to absolute deduped paths", () => {
  const canvasDir = path.join(os.tmpdir(), "buzzassist-registry-test", "canvas");
  const registry = normalizeCharacterRegistry({
    characters: [
      { id: "sukketo", name: "助っ人のおじさん", referenceImagePaths: ["assets/characters/sukketo.png"] },
      { id: "hero", referenceImagePaths: [path.join(canvasDir, "assets", "hero.png"), "assets/characters/sukketo.png"] },
    ],
  });

  const paths = resolveCharacterReferencePaths(registry, ["sukketo", "助っ人のおじさん", "hero"], { canvasDir });
  assert.deepEqual(paths, [
    path.resolve(canvasDir, "assets/characters/sukketo.png"),
    path.resolve(canvasDir, "assets/hero.png"),
  ]);
});

test("resolveCharacterReferencePaths lists available ids on an unknown id", () => {
  const registry = normalizeCharacterRegistry({ characters: [{ id: "sukketo" }] });
  assert.throws(
    () => resolveCharacterReferencePaths(registry, ["missing"], { canvasDir: os.tmpdir() }),
    /Unknown or unapproved character id\(s\): missing.*Available ids.*sukketo/s,
  );
  assert.deepEqual(resolveCharacterReferencePaths(registry, [], { canvasDir: os.tmpdir() }), []);
});

test("draft and archived characters cannot be resolved as generation identities", () => {
  const registry = normalizeCharacterRegistry({
    characters: [
      { id: "approved", status: "approved", referenceImagePaths: ["assets/approved.png"] },
      { id: "draft", status: "draft", referenceImagePaths: ["assets/draft.png"] },
      { id: "archived", status: "archived", referenceImagePaths: ["assets/archived.png"] },
    ],
  });

  assert.equal(resolveCharacterBindings(registry, ["approved"], { canvasDir: os.tmpdir() }).length, 1);
  assert.throws(
    () => resolveCharacterBindings(registry, ["draft"], { canvasDir: os.tmpdir() }),
    /Unknown or unapproved character id\(s\): draft.*Available ids.*approved/s,
  );
  assert.throws(
    () => resolveCharacterBindings(registry, ["archived"], { canvasDir: os.tmpdir() }),
    /Unknown or unapproved character id\(s\): archived.*Available ids.*approved/s,
  );
});

test("character aliases resolve to an identity pack with explicit multi-character separation", () => {
  const canvasDir = path.join(os.tmpdir(), "buzzassist-registry-bindings", "canvas");
  const registry = normalizeCharacterRegistry({
    characters: [
      {
        id: "helper",
        name: "助っ人",
        aliases: ["佐藤さん"],
        description: "50代の落ち着いた男性。",
        invariants: ["銀縁眼鏡", "短い白髪"],
        negativePrompt: "若返り",
        referenceImagePaths: ["assets/characters/helper-identity.png", "assets/characters/helper-expressions.png"],
      },
      {
        id: "hero",
        name: "田中",
        referenceImagePaths: ["assets/characters/hero.png"],
      },
    ],
  });

  const bindings = resolveCharacterBindings(registry, ["佐藤さん", "田中"], { canvasDir });
  assert.deepEqual(bindings.map((binding) => binding.id), ["helper", "hero"]);
  const prompt = buildCharacterIdentityPrompt(bindings, { startReferenceIndex: 2 });
  assert.match(prompt, /助っ人 \[helper\]: use reference images 2-3 only/);
  assert.match(prompt, /田中 \[hero\]: use reference image 4 only/);
  assert.match(prompt, /Never blend faces, hair, clothing/);
  assert.match(prompt, /Must preserve: 銀縁眼鏡; 短い白髪/);
});

test("multi-character generation keeps only one face lock per character", () => {
  const bindings = ["hero", "manager", "helper"].map((id) => ({
    id,
    referenceImagePaths: [`/${id}-identity.png`, `/${id}-expressions.png`],
  }));

  const optimized = optimizeCharacterBindingsForGeneration(bindings);
  assert.deepEqual(optimized.map((binding) => binding.referenceImagePaths), [
    ["/hero-identity.png"],
    ["/manager-identity.png"],
    ["/helper-identity.png"],
  ]);
  assert.deepEqual(optimizeCharacterBindingsForGeneration(bindings.slice(0, 2)).map((binding) => binding.referenceImagePaths), [
    ["/hero-identity.png"],
    ["/manager-identity.png"],
  ]);
});

test("single-character references route by scene role and story stage", () => {
  const binding = {
    id: "hero",
    referenceImagePaths: ["/face.png", "/turnaround.png", "/expressions.png", "/winter.png"],
    referenceAssets: [
      { role: "identity-face", path: "/face.png" },
      { role: "turnaround", path: "/turnaround.png" },
      { role: "expression", path: "/expressions.png" },
      { role: "outfit", storyStage: "winter", path: "/winter.png" },
    ],
  };
  assert.deepEqual(optimizeCharacterBindingsForGeneration([binding], { referenceIntent: "closeup" })[0].referenceImagePaths, ["/face.png", "/expressions.png"]);
  assert.deepEqual(optimizeCharacterBindingsForGeneration([binding], { referenceIntent: "profile" })[0].referenceImagePaths, ["/face.png", "/turnaround.png"]);
  assert.deepEqual(optimizeCharacterBindingsForGeneration([binding], { storyStage: "winter" })[0].referenceImagePaths, ["/face.png", "/winter.png"]);
  assert.throws(() => optimizeCharacterBindingsForGeneration([binding], { storyStage: "missing" }), /no approved outfit sheet/u);
  assert.throws(
    () => optimizeCharacterBindingsForGeneration([binding], { referenceIntent: "closeup", providerReferenceLimit: 1 }),
    /require 2 images.*accepts 1/u,
  );
});

test("eye-open references route by requested variant and fail closed", () => {
  const legacy = {
    id: "legacy",
    referenceImagePaths: ["/legacy-face.png", "/legacy-eyes.png"],
    referenceAssets: [
      { role: "identity-face", path: "/legacy-face.png" },
      { role: "eye-open", path: "/legacy-eyes.png", storyStage: "" },
    ],
  };
  const route = (binding, options) => optimizeCharacterBindingsForGeneration([binding], options)[0].referenceImagePaths;
  // A single unkeyed sheet keeps working exactly as before.
  assert.deepEqual(route(legacy, { referenceIntent: "eye-open" }), ["/legacy-face.png", "/legacy-eyes.png"]);
  assert.throws(() => route(legacy, { eyeOpenVariant: "open-calm" }), /no approved eye-open sheet for variant 'open-calm'.*No keyed eye-open variant/u);

  const keyed = {
    id: "keyed",
    referenceImagePaths: ["/face.png", "/calm.png", "/angry.png", "/expressions.png"],
    referenceAssets: [
      { role: "identity-face", path: "/face.png" },
      { role: "eye-open", path: "/calm.png", storyStage: "open-calm" },
      { role: "eye-open", path: "/angry.png", storyStage: "open-angry" },
      { role: "expression", path: "/expressions.png" },
    ],
  };
  assert.throws(
    () => route(keyed, { referenceIntent: "eye-open" }),
    /Character keyed has 2 eye-open sheets \(open-calm, open-angry\); request one with eyeOpenVariant/u,
    "two or more variants never fall back to a default",
  );
  assert.deepEqual(route(keyed, { referenceIntent: "eye-open", eyeOpenVariant: "open-calm" }), ["/face.png", "/calm.png"]);
  assert.deepEqual(route(keyed, { referenceIntent: "eye-open", eyeOpenVariant: "open-angry" }), ["/face.png", "/angry.png"]);
  assert.deepEqual(route(keyed, { eyeOpenVariant: "open-angry" }), ["/face.png", "/angry.png"], "a variant implies the eye-open intent");
  assert.throws(() => route(keyed, { eyeOpenVariant: "open-sad" }), /variant 'open-sad'.*Registered variants: open-calm, open-angry/u);
  assert.throws(() => route(keyed, { referenceIntent: "closeup", eyeOpenVariant: "open-angry" }), /referenceIntent is 'closeup'/u);
  assert.throws(() => route(keyed, { storyStage: "winter", eyeOpenVariant: "open-angry" }), /select different sheets/u);
  assert.throws(
    () => optimizeCharacterBindingsForGeneration([keyed, legacy], { eyeOpenVariant: "open-angry" }),
    /exactly one character, but this generation binds 2/u,
  );
  assert.throws(() => optimizeCharacterBindingsForGeneration([], { eyeOpenVariant: "open-angry" }), /binds 0/u);

  const mixed = {
    ...keyed,
    referenceAssets: [...keyed.referenceAssets, { role: "eye-open", path: "/unkeyed.png" }],
  };
  assert.throws(() => route(mixed, { referenceIntent: "eye-open" }), /3 eye-open sheets \(open-calm, open-angry, \(unkeyed\)\)/u);

  const singleKeyed = {
    id: "single",
    referenceImagePaths: ["/single-face.png", "/single-calm.png"],
    referenceAssets: [
      { role: "identity-face", path: "/single-face.png" },
      { role: "eye-open", path: "/single-calm.png", storyStage: "open-calm" },
    ],
  };
  assert.deepEqual(route(singleKeyed, { referenceIntent: "eye-open" }), ["/single-face.png", "/single-calm.png"], "one keyed sheet is still the default");

  const duplicated = {
    ...keyed,
    referenceAssets: [...keyed.referenceAssets, { role: "eye-open", path: "/angry-2.png", storyStage: "open-angry" }],
  };
  assert.throws(() => route(duplicated, { eyeOpenVariant: "open-angry" }), /Character keyed registers eye-open variant 'open-angry' 2 times/u);

  assert.equal(selectEyeOpenReferenceAsset(keyed.referenceAssets, "open-calm").path, "/calm.png");
  assert.equal(selectEyeOpenReferenceAsset([], ""), null);
  assert.throws(() => selectEyeOpenReferenceAsset(keyed.referenceAssets, ""), /This character has 2 eye-open sheets/u);
  assert.equal(eyeOpenVariantId({ role: "outfit", storyStage: "winter" }), "", "outfit stages are not eye-open variants");

  // The variant key survives registry normalization (older normalizers keep storyStage too).
  const normalized = normalizeCharacterRegistry({ characters: [{ id: "keyed", referenceAssets: keyed.referenceAssets }] });
  assert.deepEqual(
    normalized.characters[0].referenceAssets.filter((asset) => asset.role === "eye-open").map((asset) => asset.storyStage),
    ["open-calm", "open-angry"],
  );
});

test("provider reference budgets never silently drop a character identity", () => {
  const bindings = ["a", "b", "c", "d"].map((id) => ({
    id,
    referenceImagePaths: [`/${id}.png`],
    referenceAssets: [{ role: "identity-face", path: `/${id}.png` }],
  }));
  assert.throws(
    () => optimizeCharacterBindingsForGeneration(bindings, { providerReferenceLimit: 3 }),
    /require 4 images.*accepts 3.*Do not drop an identity-face/u,
  );
});

test("character registry round-trips through canvas/characters.json", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-registry-"));
  try {
    const written = await writeCharacterRegistry(
      { projectDir },
      { characters: [{ id: "sukketo", kind: "character", referenceImagePaths: ["assets/sukketo.png"] }] },
    );
    assert.equal(written.characters.length, 1);
    const readBack = await readCharacterRegistry({ projectDir });
    assert.deepEqual(readBack, written);
    const empty = await readCharacterRegistry({ projectDir: path.join(projectDir, "nope") });
    assert.deepEqual(empty, { version: 1, revision: 0, characters: [], voices: [] });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("character registry rejects corruption and stale concurrent writes", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-registry-lock-"));
  try {
    const first = await writeCharacterRegistry({ projectDir }, { characters: [], voices: [] });
    assert.equal(first.revision, 1);
    const snapshotA = await readCharacterRegistry({ projectDir });
    const snapshotB = await readCharacterRegistry({ projectDir });
    snapshotA.characters.push({ id: "a", name: "A" });
    const second = await writeCharacterRegistry({ projectDir }, snapshotA);
    assert.equal(second.revision, 2);
    snapshotB.characters.push({ id: "b", name: "B" });
    await assert.rejects(() => writeCharacterRegistry({ projectDir }, snapshotB), /Stale character registry revision/u);

    const file = path.join(projectDir, "canvas", "characters.json");
    await writeFile(file, "{broken\n");
    await assert.rejects(() => readCharacterRegistry({ projectDir }), /JSON/u);
    await writeFile(file, "\n");
    await assert.rejects(() => readCharacterRegistry({ projectDir }), /registry is empty/u);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("nextBatchChunkOrigin continues the grid below the previous chunk", () => {
  const frames = [
    { bounds: { x: 100, y: 50, width: 200, height: 150 } },
    { bounds: { x: 324, y: 50, width: 200, height: 150 } },
    { bounds: { x: 100, y: 224, width: 200, height: 150 } },
  ];
  const origin = nextBatchChunkOrigin(frames, 24, null);
  assert.deepEqual(origin, { x: 100, y: 224 + 150 + 24 });

  const next = nextBatchChunkOrigin(
    [{ bounds: { x: 140, y: origin.y, width: 200, height: 150 } }],
    24,
    origin,
  );
  assert.deepEqual(next, { x: 100, y: origin.y + 150 + 24 });

  assert.deepEqual(nextBatchChunkOrigin([], 24, origin), origin);
  assert.equal(nextBatchChunkOrigin([], 24, null), null);
});
