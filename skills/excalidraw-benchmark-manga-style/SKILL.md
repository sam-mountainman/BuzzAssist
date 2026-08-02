---
name: excalidraw-benchmark-manga-style
description: Generate original manga character sheets and 16:9 story scenes in BuzzAssist/Excalidraw while locking the drawing style and atmosphere to supplied reference videos or images without copying their character identities. Use when the user asks to match a benchmark manga video's character feel, linework, flat coloring, backgrounds, composition, or overall taste; when a generated character looks too realistic, cinematic, shonen, gritty, or unlike the reference; or when building a reusable channel-specific visual harness from YouTube/video/image references.
---

# Benchmark manga style lock

Treat this as a low-freedom production workflow. A written style paragraph alone is not sufficient. Keep high-resolution benchmark frames attached throughout character design and scene generation, and reject outputs that drift.

## Required resources

- Use the BuzzAssist canvas tools. Open the project canvas before generation.
- Read [references/style-rubric.md](references/style-rubric.md) before judging any output.
- Read [references/prompt-contracts.md](references/prompt-contracts.md) before constructing character-sheet or scene prompts.
- Run `node skills/excalidraw-benchmark-manga-style/scripts/verify-style-pack.mjs --project-dir <project-dir> --write` when the project uses the bundled benchmark filenames. Fix every reported missing or low-resolution reference before generation.

Do not bundle or publish frames from a third-party video inside the distributable skill. Keep user-supplied benchmark frames project-local under `canvas/assets/style-references/`.

## 1. Build the style pack

Create at least these independent reference elements on the canvas:

1. male facial close-up/profile;
2. female facial close-up;
3. medium dialogue/composition frame;
4. gesture or prop interaction frame;
5. daylight exterior;
6. night exterior;
7. warm interior;
8. neutral interior.

Use the highest available source resolution. Prefer 1920×1080. Never combine the eight frames into a contact sheet: each frame must remain an independent image element and file. Crop out subtitles, speech bubbles, logos, and UI when possible.

Mark every benchmark frame as STYLE-ONLY. The depicted people are not cast members.

## 2. Separate identity from style

Always order references as:

1. approved character identity sheet;
2. approved expression/angle sheet when needed;
3. benchmark STYLE-ONLY references.

State the reference ranges explicitly in the prompt. Identity references decide who appears. Style references decide only linework, face-drawing grammar, hair treatment, cel shading, palette, background finish, camera language, and visual density.

Never ask the model to preserve a face from a benchmark frame. Never let a benchmark person enter `characters.json`.

For a new character, generate from written traits plus STYLE-ONLY references. For a redesign, do not reuse an old identity sheet whose rendering style already failed; preserve its written age, silhouette, hair, build, clothing, and accessories, then redraw the identity from scratch.

## 3. Generate character candidates

- Generate three candidates per new or redesigned character by default.
- Put every candidate in a separate canvas image element.
- Use GPT Image 2 through the local Codex route at 16:9, High, 2K unless the user specifies another valid route.
- Use the lightweight candidate-card contract from [references/prompt-contracts.md](references/prompt-contracts.md). Do not request garment, skin, shoe, fabric, or material close-ups at this stage; they push the rendering toward game-art realism.
- Attach exactly two facial STYLE-ONLY references for the first candidate round. Use the same two files in the same order for every cast member so the shared style signal remains stable.
- With the bundled pack, use `koutani-style-linework-male-v2.png` first and `koutani-style-linework-female-v2.png` second. Do not change that ordering based on the candidate's gender.
- Keep different cast members visibly different in face shape, eye shape, eyebrows, hair silhouette, age cues, build, and wardrobe.
- A candidate card is intentionally one board containing one full-body view and three head angles. It must not be confused with the eight independent style references.

Inspect all candidates at native resolution. Reject any candidate with a fatal rubric failure. Approve only a candidate scoring at least 45/50 and at least 4/5 in linework, face grammar, hair, and shading.

If every candidate fails, do not repeat the same prompt. Apply the failure-specific correction from the rubric, strengthen the STYLE-ONLY reference contract, and regenerate a new candidate set.

If the first candidate round still shows angular cheek planes, deep wrinkles, oversized brows, muscular anatomy, heavy shadows, cross-hatching, individual hair strands, material texture, glossy/game-art rendering, or a copied benchmark person, stop before scene generation. Correct the candidate stage first.

## 4. Register the identity pack

After approval:

1. generate a clean front/side/back turnaround in the same locked style;
2. generate an expression/head-angle sheet;
3. register the approved turnaround and expression sheet in `canvas/characters.json`;
4. store channel style separately from identity;
5. record the rubric score and benchmark pack id in character notes or workflow metadata.

Do not register an unapproved candidate.

## 5. Generate a scene proof

Before producing a full episode, generate three proof frames:

- one close-up;
- one waist-up dialogue frame;
- one wider environment frame.

Use the scene contract from [references/prompt-contracts.md](references/prompt-contracts.md). Keep the approved identity first and attach two or three scene-relevant STYLE-ONLY frames last. Reserve outer negative space for the later deterministic vertical speech bubble; never draw text or balloons into the image.

Inspect the proof frames against the same rubric. Character-sheet success alone is not enough: scene rendering often drifts back toward realistic or cinematic detail.

## 6. Quality loop

For each failed proof:

1. name the exact mismatched dimensions from the rubric;
2. change references or prompt constraints that control those dimensions;
3. generate a new independent proof frame;
4. compare it side by side with the benchmark at 100% and enlarged view;
5. keep only passing outputs on the final test row.

Do not call an output complete because it is attractive or internally consistent. Complete only when it matches the benchmark's visual information density and every fatal condition is absent.

## Canvas output rules

- Keep style references, candidates, and proof scenes as separate elements.
- Preserve native files at 1280×720 minimum; prefer 1672×941 or 1920×1080.
- Use SVG overlays for speech bubbles. Do not rasterize bubbles into the generated scene.
- Label test rows with character name, native dimensions, profile version, and pass/fail status.
- Delete or clearly mark failed comparison outputs so they cannot be mistaken for approved production assets.

## Long-running generation recovery

Local Codex image jobs can finish after the MCP call reaches its waiting limit. When a generation call times out, do not immediately submit duplicate jobs. First check the requested asset filenames and the canvas JSON for completed image elements. Re-run only missing jobs.
