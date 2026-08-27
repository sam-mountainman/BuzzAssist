# Character Pipeline R1 Architecture Decision

## Status

Accepted — 2026-07-31; fail-closed identity-review amendment — 2026-08-26

## Context

BuzzAssist needs to turn a YouTube manga script into repeatable image production while keeping recurring helpers, episode-specific leads, enemies, art direction, and facial identity separate. A single turnaround sheet was not sufficient for expression close-ups, and automatically registering unreviewed candidates would allow weak or wrong designs to leak into later scenes.

## Decision

Use a two-store, human-approved pipeline with an explicit post-selection styling stage.

- `canvas/character-workflows.json` owns in-progress work: script hash, cast extraction, fixed/per-video scope, three design candidates, selected candidate, expression sheet, and storyboard results.
- `canvas/characters.json` owns only fully reviewed identities. Each approved character stores role-tagged references (`identity-face`, `turnaround`, `expression`, optional `eye-open` and `outfit`) with SHA-256 and review provenance.
- Candidate generation writes an anonymous A/B/C contact sheet and a machine-measurement review draft. Approval is blocked until every real-image pair has face/whole-image measurements plus original-scale judgments for face shape, eyes, brows, hair silhouette, and build.
- A legacy candidate set that was already shown to the client may be migrated only with `generatorHost=legacy-migration`, an explicit active A–E label list, an explicit retired-label list, and a concrete reason. The migration preserves the published labels, records conflicts with any stale private mapping, and never promotes a retired image or infers a new winner.
- Candidate selection and character registration are separate actions. Selection generates a pending identity pack and moves the cast to `awaiting-identity-qa`; it never writes `characters.json`.
- If the selected design needs hair, color, outfit, build, or detail refinement, each option is generated as a separate complete one-identity sheet from one approved face reference. A different context reviews every option at original scale; only passing options enter a deterministic comparison sheet. Human selection binds one individual asset, never the comparison sheet, before the identity pack is generated.
- Registration requires a different task/session to pass all eight real turnaround views, all twelve 4×3 expression cells, and every required story-stage outfit sheet. Candidate bytes cannot substitute for the turnaround.
- Paid identity-pack generation is checkpointed per character before each image call. The input digest binds the selected candidate bytes, prompt, model settings, reference bytes, output name, and generator provenance; only a byte-valid output with the same digest can be resumed after interruption.
- Storyboard jobs refer to character IDs and route the smallest role-specific set: selected face + expression for close-ups, selected face + turnaround for full-body/profile, selected face + the matching outfit for a story stage, and one selected face per person for multi-character scenes. Character scenes do not add channel style-image references.
- `role: fixed` can be reused between episodes. `role: per-video` is reusable only inside the same `episodeId`.

## Flow

```text
script
  -> cast extraction and registry match
  -> three candidates for each new character
  -> anonymous real-image diversity review
  -> user selection + reason
  -> optional independent styling options + per-option QA + deterministic comparison
  -> user styling selection + reason
  -> pending turnaround + expression/head-angle (+ required outfit) sheets
  -> independent eight-view + twelve-cell identity review
  -> SHA-bound approved identity pack
  -> character-ID-bound storyboard/main scenes
```

## Consequences

- Unapproved designs cannot silently enter production.
- Fixed cast and episode cast no longer collide merely because names match.
- Group scenes receive explicit reference ownership, reducing face and clothing blending.
- The workflow survives agent restarts because state is stored inside the project canvas directory.
- Cell-level review and minimal reference routing reduce drift but cannot mathematically guarantee model consistency; generated scenes still need visual review.
- Candidate images consume generation time and cost. The default remains three because it gives a meaningful design choice without creating an impractical review grid.
- Styling axes are deliberately sequential. For example, select Horo's hair color first and jersey color second; a combinatorial color matrix would obscure identity drift and inflate paid generation.

## Rejected alternatives

- Store candidates directly in `characters.json`: rejected because downstream generation could use unapproved identities.
- Use only the selected turnaround sheet: rejected because close-up expressions and head angles drifted more often in testing.
- Ask the image model to draw a labeled comparison grid: rejected because it can blend identities, change unrequested traits between cells, and render unreliable labels. Labels and layout are added deterministically after per-option QA.
- Reuse every same-name per-video character: rejected because manga episodes commonly use the same role names for visually different people.
