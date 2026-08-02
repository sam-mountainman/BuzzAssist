# Prompt contracts

Replace bracketed values. Keep the reference-role language intact.

## Lightweight candidate-card contract

```text
Create one simple 2D manga CHARACTER CANDIDATE CARD for an original [gender/role] character. Landscape 16:9, pure white background, generous spacing. Show one front-facing full-body view plus exactly three head studies: front, 3/4, and profile. Keep every view recognizably the same original character. No material swatches, fabric close-ups, skin close-ups, shoe close-ups, captions, or readable text.

REFERENCE CONTRACT: [identity range or "There is no identity image for this new character"]. Reference images [style range] are CHANNEL STYLE-ONLY. Match only their simple flat Japanese YouTube web-manga grammar: mostly uniform thin black outlines; smooth uncomplicated face contour; eyes made from a few clean strokes; a minimal single-line nose; small simple mouth; pale flat skin; at most one restrained cel-shadow shape; hair as broad graphic masses with one flat highlight band; clothes as broad fills with very few fold lines. The people shown in STYLE-ONLY references are not cast. Never copy their face, hair, clothes, age, body, pose, text, balloon, or exact composition.

ORIGINAL CHARACTER: [age, face, eyes, brows, hair, build, clothing, accessories, personality cues].

CAST SEPARATION: This character must be visibly different from [other cast] in face shape, eye shape, eyebrows, hair silhouette, age cues, build, and wardrobe. Share only the rendering style.

STRICTLY AVOID: realistic facial planes, cheekbones, pores, stubble, detailed lips, deep wrinkles, gritty seinen rendering, muscular shonen or yakuza-game anatomy, thick aggressive ink, cross-hatching, dense fabric texture, many hair strands, glossy cinematic lighting, 3D, text, logo, watermark, UI.
```

For a redesign, use the old sheet only as a written-trait source unless it already passes the style rubric. If it must be attached, say it supplies silhouette/clothing identity only and must be completely redrawn in the STYLE-ONLY grammar.

## Approved turnaround contract

Use this only after one candidate card passes the rubric and the user approves the identity.

```text
Reference image 1 is the approved CHARACTER IDENTITY. Preserve this exact original face, hair, age, build, clothing, and accessories. Reference images 2-3 are CHANNEL STYLE-ONLY and determine rendering style only.

Create one clean 2D manga CHARACTER TURNAROUND on a pure white 16:9 canvas. Show front, left profile, and back full-body standing views of the exact same approved character, plus front, 3/4, and profile head views. Use mostly uniform thin black outlines, smooth simple face contours, a minimal single-line nose, small mouth, broad graphic hair masses, pale flat skin, at most one restrained cel-shadow shape, broad clothing fills, and very few fold lines. No material studies, no realistic texture, no labels, no text, no logo, no watermark.
```

## Expression-sheet contract

```text
Reference images 1-[N] are the approved identity pack. Keep this exact original identity in every cell. Reference images [M]-[K] are STYLE-ONLY and must never determine identity.

Create a clean 16:9 expression and head-angle sheet on white. Include neutral, worried, relieved, angry, surprised, sad, speaking, and listening expressions plus front, profile, 3/4, slight high, and slight low angles. Preserve the same simple line density, flat palette, minimal nose/mouth, broad hair masses, and one-shadow cel treatment as the approved turnaround. No text or labels.
```

## Scene contract

```text
Reference images 1-[N] are the only CHARACTER IDENTITY sources. Preserve each named character's exact approved face, hair, age, build, clothing, glasses, and accessories. Keep the cast visibly distinct.

Reference images [M]-[K] are CHANNEL STYLE-ONLY. Copy only their linework, face-drawing grammar, hair treatment, flat cel shading, light palette, simplified background finish, camera language, and visual information density. Never reproduce any person, face, hair, clothes, age, body, pose, text, balloon, or exact composition from them.

Render [scene]. Use mostly uniform thin black outlines, the fewest necessary facial strokes, a minimal nose and mouth, pale flat skin, one restrained shadow shape, broad flat hair highlights, minimal clothing folds, and a simplified lower-detail environment. It must look like a clean frame from the same 640×360 YouTube web-manga production, delivered at [resolution].

Composition: [shot type/camera]. Place [subject] on [side]. Reserve [opposite outer zone] as clean negative space for a later deterministic vertical speech bubble. Do not draw any bubble or text.

STRICTLY AVOID: realistic facial planes, pores, stubble, detailed lips, deep wrinkles, muscular shonen/yakuza rendering, thick aggressive ink, cross-hatching, dense texture, glossy cinematic light, 3D, captions, speech bubbles, logos, watermark, collage, split screen.
```

## Reference counts

- New character candidate: exactly 2 facial STYLE-ONLY references, no identity image. Keep the files and ordering identical across the first round for every cast member.
- Redesign candidate: written traits plus the same exactly 2 facial STYLE-ONLY references. Exclude the failed old sheet from image inputs; read its clothing/silhouette as text only.
- Approved turnaround: 1 approved candidate identity image, then the same 2 facial STYLE-ONLY references.
- Single-character scene: 1–2 approved identity images, then 2 STYLE-ONLY references.
- Multi-character scene: one optimized identity image per character, then 1 STYLE-ONLY reference. Generate single-character proofs first.

Prefer a style reference matching the requested shot type: close-up for faces, medium dialogue for two-shots, and environment-only for wide shots.
