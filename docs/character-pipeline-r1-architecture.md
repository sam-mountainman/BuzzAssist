# Character Pipeline R1 Architecture Decision

## Status

Accepted — 2026-07-31

## Context

BuzzAssist needs to turn a YouTube manga script into repeatable image production while keeping recurring helpers, episode-specific leads, enemies, art direction, and facial identity separate. A single turnaround sheet was not sufficient for expression close-ups, and automatically registering unreviewed candidates would allow weak or wrong designs to leak into later scenes.

## Decision

Use a two-store, human-approved pipeline.

- `canvas/character-workflows.json` owns in-progress work: script hash, cast extraction, fixed/per-video scope, three design candidates, selected candidate, expression sheet, and storyboard results.
- `canvas/characters.json` owns only approved identities. Each approved character has an ID, scope, written invariants, and a two-image identity pack: the selected character sheet plus a derived expression/head-angle sheet.
- Candidate generation uses the canonical prompt in `skills/excalidraw-image-gen/reference-sheet-prompts.md` and creates all `Generating...` frames before generation starts.
- Approval is an explicit user action. Only then is the expression sheet generated and the identity pack copied to `canvas/assets/characters/`.
- Storyboard jobs refer to character IDs. The generation backend appends each character's references and a deterministic identity-lock prompt, including reference-image index ownership and anti-mixing instructions for group scenes.
- `role: fixed` can be reused between episodes. `role: per-video` is reusable only inside the same `episodeId`.

## Flow

```text
script
  -> cast extraction and registry match
  -> three candidates for each new character
  -> user approval
  -> expression/head-angle sheet
  -> approved two-image identity pack
  -> character-ID-bound storyboard/main scenes
```

## Consequences

- Unapproved designs cannot silently enter production.
- Fixed cast and episode cast no longer collide merely because names match.
- Group scenes receive explicit reference ownership, reducing face and clothing blending.
- The workflow survives agent restarts because state is stored inside the project canvas directory.
- Two reference sheets and stricter prompts reduce drift but cannot mathematically guarantee model consistency; generated scenes still need visual review.
- Candidate images consume generation time and cost. The default remains three because it gives a meaningful design choice without creating an impractical review grid.

## Rejected alternatives

- Store candidates directly in `characters.json`: rejected because downstream generation could use unapproved identities.
- Use only the selected turnaround sheet: rejected because close-up expressions and head angles drifted more often in testing.
- Reuse every same-name per-video character: rejected because manga episodes commonly use the same role names for visually different people.
