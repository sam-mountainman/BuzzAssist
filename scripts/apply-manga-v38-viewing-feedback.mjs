#!/usr/bin/env node
// v38: fixes from the user's full watch-through of v37 (requirements ledger
// R51-R55 in docs/koya-channel-requirements-ledger.md).
//
// This script applies the deterministic manifest-level corrections:
//  - R54: cut-08's conditional-panel lead-in image still pointed at the v16
//    three-person lineup (medium-mio-send) while the shot sequence and the
//    v36 bubble/face annotations use the v31 OTS composition. The lead-in now
//    matches the assigned shot image, removing the out-of-context insert at
//    ~1:52 and re-aligning bubble placement with what is actually on screen.
//  - R53: user-specified dialogue viewpoint corrections for the flashback:
//    cut-09-u01 (speaker = young Mio, right of frame; boy behind left)
//    right-only -> left-only so the speaker reads first and the boy stays
//    revealed; cut-09-u02 (speaker = young Ren, left of frame) left-only ->
//    right-only for the mirrored reason.
import { copyFile, readFile, access } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";

const execFile = promisify(execFileCallback);

const projectDir = resolve(process.argv[2] || process.cwd());
const episodeDir = join(projectDir, "canvas/manga-videos/manga-photo-homecoming-001");
const manifestPath = join(episodeDir, "episode-manifest.json");
const backupPath = join(episodeDir, "episode-manifest-pre-v38-viewing-feedback-r1.json");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
let backupExists = false;
try { await access(backupPath); backupExists = true; } catch {}
if (!backupExists) await copyFile(manifestPath, backupPath);

const changes = [];

// R54/R58 — the user rejected the standalone lead-in still twice; the
// conditional lead-in mechanism is removed entirely: cut-08 shows its
// three-panel page for the whole cut and u01 speaks on panel 1 (the OTS
// composition). No other cut uses a conditional panel (checked).
{
  const cut = manifest.cuts.find((entry) => entry.id === "cut-08");
  const otsImage = join(projectDir, "canvas/assets/manga-photo-homecoming-001-v31-cut-08-u01-phone-send-ots.png");
  if (cut.imagePath !== otsImage) cut.imagePath = otsImage;
  if (cut.panelLayout.enableFromUtteranceId || cut.panelLayout.enableThroughUtteranceId) {
    delete cut.panelLayout.enableFromUtteranceId;
    delete cut.panelLayout.enableThroughUtteranceId;
    delete cut.panelLayout.enable_from_utterance_id;
    delete cut.panelLayout.enable_through_utterance_id;
    changes.push({ id: "R58-cut-08-leadin-removed", to: "whole-cut three-panel page; u01 hosted on panel 1" });
  }
}

// R53 — user-specified viewpoint swaps in cut-09.
{
  const cut = manifest.cuts.find((entry) => entry.id === "cut-09");
  const swaps = {
    "cut-09-v26-continuous-right-young-mio": {
      motion: "left-only", angle: "left", viewpoint: "left", endView: "left",
      reason: "speaker-first reading order: start on the speaking girl (right of frame), travel left so the boy behind stays revealed (user-specified)",
    },
    "cut-09-v26-continuous-left-young-ren": {
      motion: "right-only", angle: "right", viewpoint: "right", endView: "right",
      reason: "speaker-first reading order: start on the speaking boy (left of frame), travel right so the girl behind stays revealed (user-specified)",
    },
  };
  for (const shot of cut.cameraSequence || []) {
    const swap = swaps[shot.id];
    if (!swap) continue;
    const keyframes = shot.camera?.keyframes;
    if (Array.isArray(keyframes) && keyframes.length === 2) {
      const [first, last] = keyframes;
      const startX = Math.max(first.focusX, last.focusX);
      const endX = Math.min(first.focusX, last.focusX);
      const goingLeft = swap.motion === "left-only";
      shot.camera = {
        ...shot.camera,
        focusX: goingLeft ? startX : endX,
        focusXEnd: goingLeft ? endX : startX,
        keyframes: [
          { ...first, focusX: goingLeft ? startX : endX },
          { ...last, focusX: goingLeft ? endX : startX },
        ],
      };
    }
    changes.push({ id: `R53-${shot.id}`, from: shot.motion, to: swap.motion });
    shot.motion = swap.motion;
    shot.cameraMode = swap.motion;
    if (shot.camera) shot.camera.cameraMode = swap.motion;
    shot.angle = swap.angle;
    shot.viewpoint = swap.viewpoint;
    shot.endView = swap.endView;
    shot.reason = swap.reason;
  }
}

// ---------------------------------------------------------------------------
// R55 — image-switch pacing. Reference measurement (v38-image-hold):
// bubbles-per-image conditional median 2 / mean 2.69, hold median 8.9 s,
// 43.3% of illustrations host >=2 bubbles. The v31 one-image-per-utterance
// layout regressed the v19 multibubble behaviour the user taught; consecutive
// same-beat utterances now share one illustration as sequential shots or one
// multi-utterance shot. Only existing generated images are used.
// ---------------------------------------------------------------------------
const P = "manga-photo-homecoming-001-character-";
const C1 = `${P}1`;
const C2 = `${P}2`;
const C3 = `${P}3`;
const asset = (name) => join(projectDir, "canvas/assets", name);
const face = (id, x, y, width, height) => ({ id, kind: "face", x, y, width, height, weight: 1600 });
const body = (id, x, y, width, height) => ({ id, kind: "body", x, y, width, height, weight: 300 });

const linearCamera = (overrides) => ({
  zoomStart: 1.4, zoomEnd: 1.4,
  focusX: 0.5, focusY: 0.5, focusXEnd: 0.5, focusYEnd: 0.5,
  easing: "linear", motionLeadRatio: 0, motionTailRatio: 0,
  saturation: 1, contrast: 1, brightness: 0,
  ...overrides,
});
const twoKeyframes = (camera) => ({
  ...camera,
  keyframes: [
    { at: 0, zoom: camera.zoomStart, focusX: camera.focusX, focusY: camera.focusY },
    { at: 1, zoom: camera.zoomEnd, focusX: camera.focusXEnd, focusY: camera.focusYEnd },
  ],
});

// Face/avoid data mirrors the v36 per-shot measurements for each host image.
const OTS_REACTION_FACES = {
  [C1]: { x: 0.18612637362637363, y: 0.1482843137254902, width: 0.10782967032967034, height: 0.19240196078431374 },
  [C2]: { x: 0.63, y: 0.02, width: 0.35, height: 0.75 },
};
const OTS_REACTION_REGIONS = [
  face(`${C1}-face`, 0.15, 0.08, 0.155, 0.32),
  body(`${C1}-body`, 0.12, 0.08, 0.3, 0.92),
  face(`${C2}-head-foreground`, 0.62, 0.0, 0.38, 0.88),
  body(`${C2}-body`, 0.6, 0.0, 0.4, 1.0),
];
const THEFT_FACES = {
  [C2]: { x: 0.24, y: 0.12, width: 0.18, height: 0.32 },
  [C1]: { x: 0.655, y: 0.295, width: 0.1, height: 0.18 },
};
const THEFT_REGIONS = [
  face(`${C2}-face`, 0.24, 0.12, 0.18, 0.32),
  body(`${C2}-head-hair`, 0.17, 0.03, 0.28, 0.44),
  body(`${C2}-body`, 0.1, 0.03, 0.4, 0.72),
  face(`${C1}-face-background`, 0.655, 0.295, 0.1, 0.18),
  body(`${C1}-body-background`, 0.615, 0.295, 0.19, 0.4),
  { id: "photo-album-foreground", kind: "evidence", x: 0.0, y: 0.6, width: 0.55, height: 0.4, weight: 700 },
];
const DOORWAY_FACES = {
  [C3]: { x: 0.595, y: 0.015, width: 0.075, height: 0.13 },
  [C1]: { x: 0.02, y: 0.2, width: 0.26, height: 0.55 },
  [C2]: { x: 0.755, y: 0.19, width: 0.245, height: 0.68 },
};
const DOORWAY_REGIONS = [
  face(`${C3}-face`, 0.595, 0.015, 0.075, 0.13),
  body(`${C3}-body`, 0.575, 0.015, 0.145, 0.82),
  face(`${C1}-head-foreground`, 0.02, 0.2, 0.26, 0.55),
  body(`${C1}-body`, 0.0, 0.2, 0.3, 0.8),
  face(`${C2}-head-foreground`, 0.755, 0.19, 0.245, 0.68),
  body(`${C2}-body`, 0.74, 0.19, 0.26, 0.81),
];
const PROOF_SET_FACES = {
  [C1]: { x: 0.13, y: 0.235, width: 0.17, height: 0.28 },
  [C3]: { x: 0.555, y: 0.0, width: 0.115, height: 0.21 },
  [C2]: { x: 0.815, y: 0.385, width: 0.17, height: 0.28 },
};
const PROOF_SET_REGIONS = [
  face(`${C1}-face`, 0.13, 0.235, 0.17, 0.28),
  body(`${C1}-body`, 0.06, 0.235, 0.36, 0.765),
  face(`${C3}-face`, 0.555, 0.0, 0.115, 0.21),
  body(`${C3}-body`, 0.49, 0.0, 0.29, 0.44),
  face(`${C2}-face`, 0.815, 0.385, 0.17, 0.28),
  body(`${C2}-body`, 0.8, 0.385, 0.2, 0.615),
  { id: "table-evidence", kind: "evidence", x: 0.35, y: 0.4, width: 0.48, height: 0.55, weight: 700 },
];
const STAIRCASE_FACES = {
  [C2]: { x: 0.065, y: 0.115, width: 0.115, height: 0.185 },
  [C1]: { x: 0.29, y: 0.5, width: 0.075, height: 0.135 },
};
const STAIRCASE_REGIONS = [
  face(`${C2}-face`, 0.065, 0.115, 0.115, 0.185),
  body(`${C2}-body`, 0.05, 0.115, 0.28, 0.885),
  face(`${C1}-face`, 0.29, 0.5, 0.075, 0.135),
  body(`${C1}-body`, 0.255, 0.5, 0.135, 0.5),
];

// Viewpoint choices follow the user-taught dialogue rule (R53): the speaker
// sits at the reading entrance and the partner is revealed and stays visible
// through the move.
const CONSOLIDATIONS = [
  {
    cutId: "cut-02",
    keepShotIds: [],
    newShots: [
      {
        id: "cut-02-v38-shared-closeup",
        imagePath: asset("manga-photo-homecoming-001-v16-proof-closeup-ren.png"),
        utteranceIds: ["cut-02-u01", "cut-02-u02"],
        angle: "wide", viewpoint: "wide", endView: "wide", motion: "pull-out",
        reason: "R55/R56 shared illustration: the narration is now Ren's own inner voice, so it opens on his face with the photograph and pulls out while he answers",
        camera: twoKeyframes(linearCamera({ zoomStart: 1.45, zoomEnd: 1.12, focusX: 0.45, focusXEnd: 0.45, focusY: 0.45, focusYEnd: 0.45 })),
        sourceFaceBoundsBySpeakerId: { [C1]: { x: 0.28, y: 0.14, width: 0.2, height: 0.41 } },
        sourceAvoidRegions: [
          face(`${C1}-face`, 0.28, 0.14, 0.2, 0.41),
          body(`${C1}-head-hair`, 0.21, 0.0, 0.32, 0.56),
          body(`${C1}-body`, 0.0, 0.45, 0.55, 0.55),
          { id: "held-photo", kind: "evidence", x: 0.42, y: 0.7, width: 0.22, height: 0.3, weight: 700 },
        ],
        transition: "cut",
      },
    ],
  },
  {
    cutId: "cut-03",
    keepShotIds: ["cut-03-v31-mio-rain-reflection"],
    newShots: [
      {
        id: "cut-03-v38-shared-ots-mio-entry",
        imagePath: asset("manga-photo-homecoming-001-v31-cut-03-u02-mio-ots-ren-reaction.png"),
        utteranceIds: ["cut-03-u01"],
        angle: "left", viewpoint: "left", endView: "left", motion: "left-only",
        reason: "R55 shared illustration: Mio (back to camera, right foreground) speaks first; travel left reveals Ren listening",
        camera: twoKeyframes(linearCamera({ zoomStart: 1.5, zoomEnd: 1.5, focusX: 0.655, focusXEnd: 0.495, focusY: 0.465, focusYEnd: 0.465 })),
        sourceFaceBoundsBySpeakerId: OTS_REACTION_FACES,
        sourceAvoidRegions: OTS_REACTION_REGIONS,
        transition: "cut",
      },
      {
        id: "cut-03-v38-shared-ots-ren-thought",
        imagePath: asset("manga-photo-homecoming-001-v31-cut-03-u02-mio-ots-ren-reaction.png"),
        utteranceIds: ["cut-03-u02"],
        angle: "left-wide", viewpoint: "left", endView: "left-wide", motion: "pull-out",
        reason: "R55: same illustration continues; thought dim bakes onto this shot and pulls out from the reached focus (no reset)",
        camera: twoKeyframes(linearCamera({ zoomStart: 1.5, zoomEnd: 1.14, focusX: 0.495, focusXEnd: 0.495, focusY: 0.465, focusYEnd: 0.465 })),
        sourceFaceBoundsBySpeakerId: OTS_REACTION_FACES,
        sourceAvoidRegions: OTS_REACTION_REGIONS,
        transition: "cut",
      },
    ],
  },
  {
    cutId: "cut-04",
    keepShotIds: ["cut-04-v31-mio-high-vulnerable"],
    newShots: [
      {
        id: "cut-04-v38-shared-theft",
        imagePath: asset("manga-photo-homecoming-001-v31-cut-04-u01-photo-foreground-theft.png"),
        utteranceIds: ["cut-04-u01", "cut-04-u02"],
        angle: "right", viewpoint: "right", endView: "right", motion: "right-only",
        reason: "R55 shared illustration: speaker Mio reads first (left, large), travel right reveals Ren who answers",
        camera: twoKeyframes(linearCamera({ focusX: 0.39, focusXEnd: 0.61, focusY: 0.363143, focusYEnd: 0.363143 })),
        sourceFaceBoundsBySpeakerId: THEFT_FACES,
        sourceAvoidRegions: THEFT_REGIONS,
        transition: "cut",
      },
    ],
  },
  {
    cutId: "cut-05",
    keepShotIds: ["cut-05-v31-reiji-low-dominant"],
    newShots: [
      {
        id: "cut-05-v38-shared-doorway",
        imagePath: asset("manga-photo-homecoming-001-v31-cut-05-u01-low-doorway-intrusion.png"),
        utteranceIds: ["cut-05-u01", "cut-05-u02"],
        angle: "left", viewpoint: "left", endView: "left", motion: "left-only",
        reason: "R55 shared illustration: intruding Reiji (door, right of centre) speaks first; travel left reveals Ren who challenges him",
        camera: twoKeyframes(linearCamera({ focusX: 0.61, focusXEnd: 0.39, focusY: 0.363143, focusYEnd: 0.363143 })),
        sourceFaceBoundsBySpeakerId: DOORWAY_FACES,
        sourceAvoidRegions: DOORWAY_REGIONS,
        transition: "cut",
      },
    ],
  },
  {
    cutId: "cut-07",
    keepShotIds: ["cut-07-v31-negative-proof-macro"],
    newShots: [
      {
        id: "cut-07-v38-shared-proof-set",
        imagePath: asset("manga-photo-homecoming-001-v16-cut-07-top-evidence-proof.png"),
        utteranceIds: ["cut-07-u02", "cut-07-u03"],
        angle: "top", viewpoint: "top", endView: "top", motion: "top-only",
        reason: "R55 shared overhead evidence table: speaker Ren (bottom) first, upward travel reaches Reiji who reacts",
        camera: twoKeyframes(linearCamera({ zoomStart: 1.3, zoomEnd: 1.3, focusX: 0.5, focusXEnd: 0.5, focusY: 0.57, focusYEnd: 0.405 })),
        sourceFaceBoundsBySpeakerId: PROOF_SET_FACES,
        sourceAvoidRegions: PROOF_SET_REGIONS,
        transition: "cut",
      },
    ],
  },
  {
    cutId: "cut-10",
    keepShotIds: ["cut-10-v31-ren-answer", "cut-10-v30-pastel-closing"],
    newShots: [
      {
        id: "cut-10-v38-shared-staircase",
        imagePath: asset("manga-photo-homecoming-001-v31-cut-10-u01-staircase-studio.png"),
        utteranceIds: ["cut-10-u01", "cut-10-u02"],
        angle: "top", viewpoint: "top", endView: "top-wide", motion: "pull-out",
        reason: "R55 shared staircase two-shot: BOTH lines are Mio's, so the camera starts on her face (upper left) and pulls out to reveal Ren listening — her face never leaves the crop",
        camera: twoKeyframes(linearCamera({ zoomStart: 1.45, zoomEnd: 1.1, focusX: 0.46, focusXEnd: 0.46, focusY: 0.47, focusYEnd: 0.47 })),
        sourceFaceBoundsBySpeakerId: STAIRCASE_FACES,
        sourceAvoidRegions: STAIRCASE_REGIONS,
        transition: "cut",
      },
    ],
  },
];

for (const plan of CONSOLIDATIONS) {
  const cut = manifest.cuts.find((entry) => entry.id === plan.cutId);
  const kept = (cut.cameraSequence || []).filter((shot) => plan.keepShotIds.includes(shot.id));
  const orderedUtteranceIds = manifest.utterances
    .filter((utterance) => utterance.cutId === plan.cutId)
    .map((utterance) => utterance.id);
  const sequence = [...plan.newShots, ...kept].sort((a, b) => (
    orderedUtteranceIds.indexOf(a.utteranceIds[0]) - orderedUtteranceIds.indexOf(b.utteranceIds[0])
  ));
  changes.push({
    id: `R55-${plan.cutId}`,
    from: (cut.cameraSequence || []).map((shot) => shot.id),
    to: sequence.map((shot) => shot.id),
  });
  cut.cameraSequence = sequence;
}

// ---------------------------------------------------------------------------
// R51 — split-page panel readability. Reference measurement
// (v38-split-panel-content): 13/15 panels contain a readable face, every
// split moment has at least one, medium size (20-50% of panel height) is
// typical and the speaker's face is readable in 6/7. Panel cameras only
// allow ±0.02 focus play at page zoom, so each panel gets a PRE-CROPPED
// derivative of its source illustration whose centre IS the meaningful
// subject (face + action), generated deterministically with ffmpeg.
// ---------------------------------------------------------------------------
const PANEL_CROPS = [
  {
    source: asset("manga-photo-homecoming-001-v31-cut-06-u01-mio-memory-photo.png"),
    out: asset("manga-photo-homecoming-001-v38-panelcrop-cut06-mio-face.png"),
    xFrac: 0.06, wFrac: 0.5,
    role: "Mio's face and the grandmother photograph she protects",
    faceLocal: { x: 0.26, y: 0.02, width: 0.3, height: 0.3 },
  },
  {
    source: asset("manga-photo-homecoming-001-v31-cut-06-u02-reiji-pressure-profile.png"),
    out: asset("manga-photo-homecoming-001-v38-panelcrop-cut06-reiji-face.png"),
    xFrac: 0.4, wFrac: 0.55,
    role: "Reiji's cold profile through the glass",
    faceLocal: { x: 0.27, y: 0.1, width: 0.45, height: 0.45 },
  },
  {
    source: asset("manga-photo-homecoming-001-v16-cut-08-wide-consequence.png"),
    out: asset("manga-photo-homecoming-001-v38-panelcrop-cut08-reiji-gallery.png"),
    xFrac: 0.42, wFrac: 0.56, yFrac: 0.02, hFrac: 0.55,
    role: "Reiji alone in the emptied gallery",
    faceLocal: { x: 0.42, y: 0.25, width: 0.18, height: 0.26 },
  },
  {
    source: asset("manga-photo-homecoming-001-v16-cut-07-close-reiji-shock.png"),
    out: asset("manga-photo-homecoming-001-v38-panelcrop-cut08-reiji-shock.png"),
    xFrac: 0.38, wFrac: 0.56,
    role: "Reiji's shocked profile",
    faceLocal: { x: 0.39, y: 0.28, width: 0.29, height: 0.5 },
  },
];
for (const crop of PANEL_CROPS) {
  await execFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", crop.source,
    "-vf", `crop=iw*${crop.wFrac}:ih*${crop.hFrac ?? 1}:iw*${crop.xFrac}:ih*${crop.yFrac ?? 0}`,
    "-frames:v", "1", crop.out,
  ]);
}
{
  const cut = manifest.cuts.find((entry) => entry.id === "cut-06");
  const [panel1, panel2] = cut.panelLayout.panels;
  panel1.imagePath = PANEL_CROPS[0].out;
  panel1.role = PANEL_CROPS[0].role;
  panel1.subjectFaceBounds = PANEL_CROPS[0].faceLocal;
  panel2.imagePath = PANEL_CROPS[1].out;
  panel2.role = PANEL_CROPS[1].role;
  panel2.subjectFaceBounds = PANEL_CROPS[1].faceLocal;
  changes.push({ id: "R51-cut-06-panel-crops", to: "panels use face-centred pre-crops (Mio face+photo / Reiji profile)" });
}
{
  const cut = manifest.cuts.find((entry) => entry.id === "cut-08");
  const [panel1, panel2, panel3] = cut.panelLayout.panels;
  panel1.role = "Mio sends the proof; Ren's face visible beyond the phone";
  panel1.subjectFaceBounds = { x: 0.495, y: 0.035, width: 0.105, height: 0.17 };
  panel2.imagePath = PANEL_CROPS[2].out;
  panel2.role = PANEL_CROPS[2].role;
  panel2.subjectFaceBounds = PANEL_CROPS[2].faceLocal;
  panel3.imagePath = PANEL_CROPS[3].out;
  panel3.role = PANEL_CROPS[3].role;
  panel3.subjectFaceBounds = PANEL_CROPS[3].faceLocal;
  changes.push({ id: "R51-cut-08-panel-crops", to: "panel2/panel3 use face-centred pre-crops; panel1 keeps OTS with Ren face annotated" });
}

// R51/R55 — the cut-08 aftermath narration card is taller than the split
// page's guaranteed-visible window during its interval, so it becomes two
// sequential reference-style cards split at the measured pause after
// 「中止され、」 (silencedetect: 0.47 s pause at 3.234-3.707 s).
{
  const utterance = manifest.utterances.find((entry) => entry.id === "cut-08-u02");
  if (utterance && !(Array.isArray(utterance.bubbleSegments) && utterance.bubbleSegments.length === 2)) {
    const duration = Number(utterance.audio?.durationSeconds) || 0;
    const boundary = 3.47;
    utterance.bubbleSegments = [
      {
        id: "cut-08-u02-bubble-s1",
        text: "翌週、展示は中止され",
        overlayPath: join(episodeDir, "overlays", "cut-08-u02-s1.svg"),
        startOffsetSeconds: -0.08,
        endOffsetSeconds: Number((boundary - 0.04).toFixed(4)),
      },
      {
        id: "cut-08-u02-bubble-s2",
        text: "神谷との契約も解除された",
        overlayPath: join(episodeDir, "overlays", "cut-08-u02-s2.svg"),
        startOffsetSeconds: Number((boundary + 0.04).toFixed(4)),
        endOffsetSeconds: Number((duration + 0.18).toFixed(4)),
      },
    ];
    if (utterance.audio) utterance.audio.bubbleSegmentBoundarySeconds = boundary;
    changes.push({ id: "R51-cut-08-u02-segments", to: "2 sequential narration cards split at 3.47s" });
  }
}

manifest.production = {
  ...(manifest.production || {}),
  version: "v38-viewing-feedback-r1",
  imagePacingPolicy: {
    reference: "canvas/reference-media/love-manga/analysis/v38-image-hold/reference-image-hold-v38.json",
    bubblesPerImageConditionalMedian: 2,
    holdSecondsMedian: 8.9,
    multiBubbleImageShare: 0.433,
  },
  splitPanelPolicy: {
    reference: "canvas/reference-media/love-manga/analysis/v38-split-panel-content/reference-split-panel-content-v38.json",
    rule: "every split moment shows at least one readable face; panels frame faces (medium size), speaker's face readable; whole-page camera per user directive R25",
  },
};
manifest.updatedAt = new Date().toISOString();
await writeJsonAtomic(manifestPath, manifest);
process.stdout.write(`${JSON.stringify({ changes }, null, 2)}\n`);
