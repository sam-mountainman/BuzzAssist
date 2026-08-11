# Static Manga Page Camera Contract v2

## Recovered semantic model

The episode uses three distinct families, recovered from task `019fd34d-602f-7a93-b28d-b784787a22e3`:

| Family | Canonical modes | Transform |
| --- | --- | --- |
| Directional only | `left-only`, `right-only`, `top-only` | Constant zoom; substantial single-axis travel |
| Pull-out only | `pullout-only` | Fixed focus; visibly decreasing zoom |
| Direction then pull-out | `left-then-pullout`, `right-then-pullout`, `top-then-pullout` | Directional keyframe, then pull out from the reached focus |

The source illustration owns the real viewpoint:

| Source viewpoint | Meaning | Direction-only end | Pull-out/combined end |
| --- | --- | --- | --- |
| `left` | Left-side source view | `left` | `left-wide` |
| `right` | Right-side source view | `right` | `right-wide` |
| `top` | Overhead/top source view | `top` | `top-wide` |
| `wide` | Spatial wide source | — | `wide` |

Do not fake source viewpoint with crop travel. Do not delete crop travel merely because the source viewpoint is authored: the source view and page transform are separate fields.

## Transform invariants

Common:

```text
easing = linear
motionLeadRatio = 0
motionTailRatio = 0
no down
no push-in
no reversal or terminal fallback
every keyframe inside legal crop range
```

Directional only:

```text
zoomStart = zoomEnd
left:  focusXEnd < focusX, travel >= 0.14
right: focusXEnd > focusX, travel >= 0.14
top:   focusYEnd < focusY, travel >= 0.12
no cross-axis drift
```

Pull-out only:

```text
zoomStart > zoomEnd
focusXEnd = focusX
focusYEnd = focusY
minimum reveal = 24%; preferred reveal ~= 30%
```

Direction then pull-out uses exactly three semantic keyframes:

```text
K0: opening target, close zoom
K1: reached directional target, same close zoom
K2: same reached target, wider zoom
```

`K1.focus == K2.focus` is mandatory. Returning to `K0.focus` before K2 is a phase-reset regression.

## Intensity tiers

| Tier | Horizontal | Top |
| --- | ---: | ---: |
| subtle (exception) | 0.14 | 0.12 |
| standard | 0.18 | 0.16 |
| strong (default) | 0.22 | 0.19 |

Use the strongest safe travel supported by the crop. The renderer must not hit a clamp wall.

## Split-page invariant

```text
static panel crops
  -> deterministic black gutters
  -> bubbles and overlays
  -> flattened completed page
  -> exactly one page-level camera using any canonical mode
```

Required metadata:

```text
composition = post-composite-then-flatten
motionPolicy = whole-page
flattenBeforeCamera = true
panelCamera = static
pageCameraMode = canonical mode
pageMotion = pageCameraMode
```

Every panel transform has identical start/end zoom and focus. The one page transform moves panels, gutters, and speech graphics together.

## Static exception

Only a locationless editorial plate with `motion: none`, `characterPolicy: strictly-none`, and `environmentPolicy: none` may remain static.

## Regression signals

Reject:

- an episode whose moving shots were normalized to pull-out-only;
- a direction-only shot with changing zoom;
- a pull-out-only shot with moving focus;
- combined motion performed simultaneously or restarted from the opening crop;
- weak directional amplitude or weak reveal;
- any `down`, `push-in`, positive zoom segment, easing, lead/tail hold, stop, reversal, or edge clamp;
- a mode/viewpoint mismatch;
- a split page whose panels move separately or whose page camera runs before flattening.
