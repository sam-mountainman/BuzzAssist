---
name: manga-page-camera
description: Enforce the complete camera grammar for static manga videos: left/right/top viewpoint travel, pull-out-only shots, sequential direction-then-pull-out shots, motion amplitude, and flattened whole-page motion for black-gutter two- or three-panel pages. Use when planning, implementing, reviewing, or fixing manga camera movement.
---

# Manga Page Camera

Use this skill whenever a completed manga image or page is animated. It restores the full camera language recovered from task `019fd34d-602f-7a93-b28d-b784787a22e3`; it must never collapse the whole episode into pull-outs.

Read [references/camera-contract.md](references/camera-contract.md) completely before changing planning, rendering, or audit code.

## Three required camera families

Plan a deliberate mix of all three families. Do not substitute one family for another.

1. **Directional only** — `left-only`, `right-only`, or `top-only`.
   - The source illustration must actually use the corresponding left-side, right-side, or overhead/top viewpoint.
   - The page crop travels substantially in that direction at constant zoom.
   - This is not a pull-out.
2. **Pull-out only** — `pullout-only`.
   - Start on the first important target or speaker and reveal a visibly wider composition.
   - Keep the focus anchor fixed. This is not a directional pan.
3. **Direction then pull-out** — `left-then-pullout`, `right-then-pullout`, or `top-then-pullout`.
   - Phase 1 travels in the chosen direction at constant zoom.
   - Phase 2 starts at the exact reached focus and pulls out from there.
   - Never reset to the opening crop before the pull-out.

No normal episode may consist only of pull-outs. Choose the family from the scene's dramatic function, speaker hand-off, geography, evidence, and next important target.

## Motion strength and timing

- Default to `strong`: horizontal travel about `0.22` of normalized frame space and top travel about `0.19` where crop safety permits.
- Never accept less than `0.14` horizontal or `0.12` top travel for a directional phase.
- A pull-out must reveal at least 24% more page area; the preferred authored reveal is about 30%.
- Use `linear` motion, `motionLeadRatio = 0`, and `motionTailRatio = 0`.
- The camera must keep moving for the whole authored phase. Do not slow down, stop near the end, bounce, reverse, or fall back after reaching an edge.
- `down`, `push-in`, `zoom-in`, `slow-push`, and positive zoom segments are forbidden.
- Do not repeat the same source image from its opening position to fake a multi-stage move.
- Keep every keyframe inside the legal crop range so FFmpeg never clamps against a page edge.

## Source viewpoint versus page transform

`left`, `right`, and `top` first describe the generated source image's real camera/viewpoint: left side, right side, and top/overhead. The video transform then moves within that completed image using the selected mode. A horizontal crop of a frontal image does not qualify as a left/right source viewpoint.

The start focus belongs on the current speaker or first important story object. Directional movement may hand the frame to the respondent or later important object. The mode and source viewpoint must agree.

## Split-page workflow

For black two- or three-panel compositions:

1. Crop each source panel to its authored static framing.
2. Freeze every panel camera; never animate a panel interior independently.
3. Assemble deterministic black gutters.
4. Composite exact speech bubbles and page graphics.
5. Flatten the result into one completed page.
6. Apply any one of the same seven moving modes to that completed page.

The black separators, balloons, and all panels move together as one page. A split page may be directional-only, pull-out-only, or direction-then-pull-out; it is not forced to be a pull-out.

## Viewpoint × scene-context rules (measured, v38)

Source: `canvas/reference-media/love-manga/analysis/v38-viewpoint-rules/reference-viewpoint-rules-v38.json`
(99 classified reference scenes) and `v38-split-panel-content/` (7 split moments). Counts are the rule's evidence.

- **Establishing / scene change → wide with pull-out** (6/6 reference scenes).
- **Emotional peak → frontal closeup** (8/10).
- **Solo-speaker dialogue → frontal, listener-POV** (7/8).
- **Two-person dialogue rotates** left / right / frontal / wide — no fixed side rail (n=53). Side views put the camera over the LISTENER's shoulder ~62% of the time (speaker faces camera); near-OTS on the speaker is legitimate variety.
- **USER-BINDING dialogue rule (overrides the tendency when they conflict)**: choose the side whose reading order reaches the speaker first, and keep BOTH characters' faces inside the crop through the whole camera move — never let the partner slide out in the back half (ledger R53; machine-checked by `scripts/audit-manga-v38-structure.mjs`).
- **Top view never LEADS a scene** in the reference; use it for overhead-evidence inserts and split-page motion, not as a scene opener.
- Viewpoint changes at ~63% of scene boundaries; frontal is the transition hub; wide→side is the standard establish→conversation entry. Plan roughly one composition per 15–25 s of audio.
- **Image pacing (R55)**: one illustration hosts multiple sequential bubbles — reference conditional median 2/image (43% of illustrations host ≥2), hold median 8.9 s. Do not give every utterance its own image.
- **Same-image continuation is legal**: a following shot on the same illustration that starts at the exact reached focus/zoom (no reset, no zoom-in) implements the taught direction-then-hold grammar; only resets or non-consecutive reuse violate the no-repeat rule.

## Project procedure

1. Use `lib/mangaPageCameraGrammar.mjs` (`manga-page-camera-v2` or later) as the source of truth.
2. Set `video.requireSemanticCameraViews`, `video.forbidPushInCameraMotion`, `video.requireWholePageSplitCamera`, `video.requireConstantCameraSpeed`, `video.forbidCameraStops`, `video.forbidDownwardCameraMotion`, and `video.forbidRepeatedCameraImages` to `true`.
3. Store the canonical mode in both `cameraMode` and `motion`.
4. Normalize ordinary shots with `applyMangaCameraGrammarToShot`.
5. Normalize split pages with `applyMangaCameraGrammarToPanelLayout`.
6. Run:

```bash
node .claude/skills/manga-page-camera/scripts/audit-manifest.mjs /absolute/path/to/episode-manifest.json
node --test test/mangaPageCameraGrammar.test.mjs test/mangaVideoPipeline.test.mjs
```

Do not report completion while a shot has a weak/wrong directional phase, hidden zoom, push-in, down motion, phase reset, crop collision, hold, non-linear easing, repeated image, moving split panel, or pre-flatten split camera.

## Required evidence

Report:

- counts for pull-out-only, directional-only, and combined modes;
- directional amplitude and pull-out reveal gates;
- zero push-in, down, reset, reversal, hold, repeat, and boundary violations;
- split page IDs, static panel confirmation, and exactly one page-level camera per page;
- tests, deterministic manifest audit, and rendered-camera audit.
