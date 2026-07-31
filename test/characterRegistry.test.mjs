import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildCharacterIdentityPrompt,
  normalizeCharacterRegistry,
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
    /Unknown character id\(s\): missing.*Available ids.*sukketo/s,
  );
  assert.deepEqual(resolveCharacterReferencePaths(registry, [], { canvasDir: os.tmpdir() }), []);
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
    assert.deepEqual(empty, { characters: [], voices: [] });
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
