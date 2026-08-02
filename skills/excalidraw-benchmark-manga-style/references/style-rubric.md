# Benchmark style rubric

Score each category from 0 to 5 at native resolution. Pass requires at least 45/50, with no fatal failure and at least 4/5 in categories 1–4.

## 1. Linework

- 5: mostly uniform thin charcoal/black contour, visually equivalent to about 1–2 px at 640×360; only small emphasis changes.
- 3: generally clean but some thick or highly varied contours.
- 0: gritty, sketchy, cross-hatched, brushy, or thick action-manga ink.

Fatal: heavy black contour or cross-hatching dominates the face or clothing.

## 2. Face grammar

- 5: smooth simple contour; eyes made from few clean strokes; nose is one minimal line/mark; mouth is small and simple; no facial-plane modeling.
- 3: mostly simple but visible cheekbone, detailed lips, deep eye sockets, or excess wrinkle lines.
- 0: realistic, game-like, yakuza-like, or gritty seinen face.

Fatal: a benchmark person's identity is reproduced, or different cast members share one face.

## 3. Hair

- 5: a few broad graphic masses with one or two flat highlight bands.
- 3: correct silhouette but too many strand lines or glossy highlights.
- 0: photoreal strands, dense texture, or sculpted 3D hair.

## 4. Shading and material

- 5: pale flat skin, at most one restrained cel-shadow shape; clothing uses broad flat fills and very few folds.
- 3: extra gradients or material texture, but the image still reads as flat anime.
- 0: realistic skin, pores, stubble, fabric texture, strong rim light, or cinematic rendering.

Fatal: 3D or photoreal appearance.

## 5. Palette

- 5: light, clean, slightly pastel cream/blue/green/pink/brown palette with restrained contrast.
- 3: mostly correct but too dark, saturated, glossy, or orange-teal.
- 0: gritty, neon, crushed-black, or cinematic color grade.

## 6. Background density

- 5: believable room/street with correct scale but visibly simpler and lower-detail than the character.
- 3: correct location with too much texture or blur.
- 0: photoreal environment, empty generic gradient, or unrelated world.

## 7. Character distinction

- 5: every cast member differs in face, eyes, brows, hair silhouette, age, build, and wardrobe while sharing the same drawing style.
- 3: two characters share several features but remain distinguishable.
- 0: duplicated identity or attribute transfer.

Fatal: same face for two named characters.

## 8. Identity continuity

- 5: the same approved character keeps face, hair, age, build, clothing, glasses, and accessories across all views/cuts.
- 3: small drift that does not change recognition.
- 0: identity changes across angles or scenes.

## 9. Composition and bubble space

- 5: simple eye-level close-up/medium/wide matching the reference rhythm, clear silhouettes, and clean outer negative space for a later vertical balloon.
- 3: readable but centered, crowded, or overly cinematic.
- 0: collage, extreme lens, cropped face, or critical hand/prop hidden.

## 10. Delivery quality

- 5: one full-bleed 16:9 frame, native resolution at least 1280×720, no baked text/bubble/logo/watermark, independent canvas element.
- 3: correct frame with minor cleanup needed.
- 0: contact sheet used as a scene, low-resolution export, or embedded typography.

Fatal: generated dialogue text, subtitles, or speech bubbles are baked into the artwork.

## Correction map

| Failure | Change before regenerating |
|---|---|
| Too realistic/cinematic | Remove identity images created in the wrong style; add `fewest possible strokes`, `one flat shadow`, and `no facial planes`; attach a close benchmark face. |
| Too shonen/gritty | Add `no action-hero anatomy`, `no yakuza face`, `emotion from posture, not wrinkles or muscles`; use a calm dialogue reference. |
| Hair too detailed | Add `broad graphic masses, one flat highlight band, no individual strands`; attach a hair/profile crop. |
| Background too detailed | Attach an environment-only crop and require lower detail than the character. |
| Character copied from benchmark | Remove that frame from identity refs, place STYLE-ONLY refs last, and explicitly forbid its face/hair/clothes/body. |
| Different cast members look alike | Generate separately; strengthen written identity deltas; approve candidates before multi-character scenes. |
| Scene drifts after a good sheet | Use the approved sheet as reference 1 and attach two benchmark frames last; repeat the full scene contract instead of a short style label. |
| Model ignores style after two attempts | Change the benchmark crop to a closer shot type and rebuild the identity sheet; do not keep rerunning the same request. |
