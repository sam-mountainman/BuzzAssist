---
name: manga-video-production
description: Complete production contract for the Koyatani-channel manga videos built in this repo (reference videos awAbZyTeE4g / 2ycRncs4CKY). Covers speech-bubble placement/typography/transitions, ElevenLabs audio and pauses, art style and composition variety, editorial grammar (plates, black split pages, inner-voice spotlight), voice casting, and the script-to-video pipeline. Use for ANY work on manga video generation, review, or fixes. Camera movement has its own skill: manga-page-camera.
---

# Manga Video Production Contract

Every rule in this file was taught explicitly by the user across sessions
`019fd34d-602f-7a93-b28d-b784787a22e3` and `019fe044-aa46-7a83-992d-d5c095a20201`
against the two reference videos. Regressing any of them is a defect, not a
style choice. When code and this file disagree, treat it as a bug and fix the
code (or update this file in the same change with clear evidence).

For camera movement (left/right/top viewpoints, pull-outs, split-page motion)
ALWAYS load the `manga-page-camera` skill; do not restate or improvise camera
rules here.

## 1. Speech bubbles — placement

- The active speaker's face/head is a **hard 0px exclusion for every sampled
  camera position of the interval the bubble is visible** (33 samples). Bubbles
  may cover non-speaking characters' bodies; their faces are strong soft
  avoidance that yields only when no pocket exists.
- Placement annotations MUST be measured on the **actual image shown by the
  assigned camera-sequence shot** — never reuse coordinates from a previous
  image version. Per-shot data lives on the manifest shot:
  `sourceFaceBoundsBySpeakerId`, `sourceAvoidRegions`,
  `speakerOffscreenSpeakerIds`, `speakerAnchorPointBySpeakerId`.
  Face rectangles are the facial area (the engine adds its own head envelope);
  add the full hair silhouette separately as a soft `body` region.
- POV shots where the speaker is off-panel declare the speaker in
  `speakerOffscreenSpeakerIds` plus an on-screen anchor (e.g. their hand); the
  proximity gate is waived only then.
- Sequence variation: never leave consecutive bubbles in the same pocket
  (measured reference: lane change 58.5%, band change 55.3%, same-pocket only
  21.9%). Two previous bubbles stay in placement history across cuts. Safety
  (faces) always outranks variation.
- Prefer negative space near the speaker; alternate left/right sides across a
  scene; lower-third is last resort.
- Implementation: `lib/mangaBubbleCameraPlacement.mjs` +
  `refreshEpisodeBubbleOverlays({ reflowPlacement: true, sequenceAware: true })`
  in `lib/mangaVideoPipeline.mjs`. If placement reports "no collision-free
  placement", the answer is NEVER to cover a face — split the utterance into
  sequential `bubbleSegments` (see §3), or fix a stale/oversized annotation.

## 2. Speech bubbles — typography

- Vertical text, serif Mincho stack, `fontWeight: 400`. The bold/garbled text
  glitch the user rejected comes from raster fallback — every overlay must pass
  `exactTextMatch`, no `overflow`, no `textLoss`, no `tooSmall`.
- No trailing `。` inside a bubble (reference style). `、` mid-line allowed.
  Audio text keeps full punctuation; only the display text drops the final `。`.
- Line breaks must be natural Japanese phrase boundaries (kinsoku enforced;
  max 3 columns). Never break inside a word or before a closing particle.
- Text must never overflow or touch the bubble edge
  (`edgeClearanceRatio >= 1.0`).
- Special shapes (rectangular narration card, thought bubble, shout spike,
  rare special) come from `assets/speech-bubble-shape-templates.json`; use the
  preset (`dialogue`/`narration`/`thought`/`shout`) that matches the line.

## 3. Speech bubbles — transitions & sequences

- One bubble at a time per utterance; a long line is split at `。` into
  sequential `bubbleSegments`, each with its own overlay and timing derived
  from the audio character timestamps. Segments of one utterance never overlap
  on screen and never linger after their interval
  (`bubbleFadeIn/Out = 50ms`, no crossfade).
- A previous utterance's bubble must never remain visible into the next image
  or cut.
- Reference-style multi-bubble accumulation on one image is expressed as
  multiple utterances/segments assigned to the same shot — appearing
  sequentially, placed in different pockets.

## 3.5 Pipeline invariants (violations caused three same-shape regressions)

1. **Any image change (swap, crop, consolidation, recomposition) MUST carry
   re-measured face/region annotations in the same change.** Stale
   coordinates caused the v31, v38-panel and v38-override bubble regressions.
2. **Placement and audit must never share the same coordinate data.** Audits
   run independent detection on RENDERED frames
   (`scripts/audit-manga-bubble-faces-independent.py`: anime-face cascade +
   turnaround-sheet templates — zero shot-annotation input). A
   manifest-vs-manifest check is self-grading and does not count as
   verification.
3. Split-page avoid regions are ALWAYS derived from live panel geometry via
   `scripts/generate-manga-panel-bubble-overrides.mjs` — hand-written
   coordinates are forbidden.
4. Audio regeneration goes through `MANGA_DIALOGUE_VERSION=v25
   scripts/generate-manga-v22-dialogue-audio.mjs` (stage → full apply). The
   legacy `speech` command falls back to single-utterance TTS
   (eleven_multilingual_v2, no performance tags, no pause discipline) and
   produces the flat announcer read the user rejects.
5. No standalone still lead-in inserts: a split page appears as a completed
   page for its whole cut (the reference has no lead-in stills), and
   narration is voiced by the protagonist, never a dedicated narrator.

## 4. Inner voice (心の声)

- Surroundings dim to the reference level; only the speaker's face stays
  bright, face-sized — never enlarged.
- **Compositing order is a hard rule (user-specified after a P0 regression):
  bake the dim + face highlight INTO the shot's source image first, then
  apply the camera move to that completed image**
  (`bakeThoughtSpotlightIntoImage` in `lib/mangaVideoPipeline.mjs`). Any
  screen-space post-camera spotlight compositing is FORBIDDEN — a static
  screen mask drifts off the face the moment the camera pans or zooms, and
  even a camera-projected-but-static position (the v34 approach) is wrong
  during motion.
- Geometry comes from the shot's `sourceFaceBoundsBySpeakerId` in source-image
  coordinates; a thought shot without that annotation must fail the render.
- Verify on RENDERED frames with `scripts/audit-manga-thought-spotlight.py`:
  it reconstructs each sampled camera crop from the original image, builds a
  luminance-ratio map, and requires the face region to stay undimmed
  (ratio ≈ 1.0) at every sampled time while the surroundings are dimmed.
- Thought bubbles use the thought shape template with the dimmed backdrop.

## 5. Audio (ElevenLabs)

- Voices are natural ElevenLabs output — **no OSS voice processing of the
  signal** (OSS is allowed for QA, alignment, join/pause work only).
- Generation: `eleven_v3` text-to-dialogue with timestamps, one take per cut so
  intonation flows; per-line performance tags (e.g. `[sarcastic]`) express the
  scene's emotion. No robotic reading, no misreads — verify readings with the
  pronunciation-correction pass.
- Volume/tone must not jump between lines: two-pass loudnorm per utterance
  (`wav_48000_pcm_s24le_loudnorm_two_pass`), no clicks at joins, never clip
  line onsets (respect `speechStartSeconds` lead-in).
- Pauses: same speaker `sameSpeakerGapSeconds` 0.03, speaker change 0.05,
  emphasis 0.2 — natural tempo, neither dead air nor clipped starts. Audible
  gaps are scene-dependent, not uniform: ~0.2 s normal exchanges, ~0.3-0.4 s
  for hesitation/sadness beats (per-utterance `targetAudibleGapBefore`).
- Per-line recipe that produced the approved sound (apply to every NEW
  script the same way):
  - one voice per character, never changed mid-episode;
  - short v3 acting tags matched to the line's meaning (`[softly]` `[sad]`
    `[cold]` …); narration = plain text, no tag, same treatment as dialogue;
  - words that risk misreading are kana-ized in the SPEECH text only (display
    text keeps kanji); insert 、 and …… at meaning boundaries to induce
    intonation and breathing;
  - multiple takes per cut (2-8, `--take-count`), pick the natural one
    (technical scorer + prosody measurement; `MANGA_DIALOGUE_FORCE_TAKE` for
    editorial override);
  - slice by timestamps + acoustic onset detection keeping ~80-100 ms before
    the first phoneme and >=45 ms release after the last;
  - no speed/pitch/denoise/voice-conversion on the signal; only 6-8 ms
    micro-fades at joins to kill clicks;
  - every line normalized to ~-19 LUFS (two-pass), then one uniform gain at
    the episode master — never a compressor;
  - BGM/ambience fully off (the rejected "ブー" hum came from BGM);
  - final ASR (faster-whisper) audit for misreads, clipped onsets, gaps,
    level jumps and clicks (`scripts/audit-manga-stt-verification.py`,
    `audit-manga-audio-onset.py`).
- Once the user approves an episode's audio it becomes a FROZEN master:
  later camera/bubble work must never regenerate it (pipeline invariant 5);
  restore from the approved master by extraction if anything drifts.
- Casting: every character gets a Japanese-native voice scored against their
  profile (gender, age, personality, emotional range). Catalog = account
  voices PLUS the public Voice Library flow
  (`voice-library-audition` → preview → `voice-library-approve
  --confirmed-voice-adds`); adding library voices requires explicit user
  confirmation. Implementation: `lib/voiceCasting.mjs`,
  `lib/voiceLibraryCasting.mjs`, `lib/speechGeneration.mjs`.

## 6. Art style & composition

- Character/background taste is locked to the approved reference-touch assets
  (`lib/channelVisualProfile.mjs`, benchmark commits "lock benchmark manga
  visual style"). Adult scenes use the same touch.
- Composition follows the reference: subject size on screen, camera distance,
  and viewpoint must VARY between consecutive cuts — never the same or similar
  camera position twice in a row, even in the same location. Plan every cut's
  viewpoint before generation and forbid duplicate compositions
  (`lib/mangaSceneComposition.mjs`, `lib/mangaScriptImagePipeline.mjs`).
- Leave negative space for bubbles when composing shots.

## 7. Editorial grammar

- Background-only cuts (no characters) and white/black solid **plates** with a
  bubble are used at script-appropriate beats (`lib/mangaEditorialGrammar.mjs`).
- Black-gutter 2/3-panel split pages: panels are cropped statics, gutters are
  drawn separators, bubbles composited, then the WHOLE page is flattened and
  moved by exactly one camera per the `manga-page-camera` skill. Panel
  interiors never move independently.

## 8. Pipeline & verification

- Script → shot plan → character/environment sheets → per-cut image jobs (10
  parallel workers, wave scheduling) → auto QA → regenerate failures only:
  `lib/mangaProductionDag.mjs`, `lib/mediaGeneration.mjs`,
  `scripts/build-manga-video.mjs` (plan / adopt-images / refresh-bubbles /
  speech / render / full).
- Quality harness gates (masao integration): `lib/mangaQualityHarness.mjs`,
  `lib/mangaVideoQuality.mjs`, `docs/masao-quality-harness-integration.md`.
- NEVER report completion from settings alone. Always verify the rendered
  MP4: rendered-camera audit, bubble frame audit
  (`scripts/audit-manga-bubble-frames.mjs`,
  `scripts/audit-manga-bubble-camera-sweep.mjs`), audio PCM hash comparison
  when audio must not change, and `node --test test/*.test.mjs`.
- When a change only touches video, prove audio is untouched (PCM md5 match).

## Working episode

`canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json` is the
current benchmark episode; `episode-manifest-pre-*.json` files are stage
backups. Version history (v9→v36) lives in `scripts/apply-manga-v*.mjs` — read
the latest apply/finalize pair before changing conventions.
