import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildCharacterIdentityPrompt,
  normalizeCharacterRegistry,
  optimizeCharacterBindingsForGeneration,
  readCharacterRegistry,
  resolveCharacterBindings,
  resolveCharacterReferencePaths,
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
