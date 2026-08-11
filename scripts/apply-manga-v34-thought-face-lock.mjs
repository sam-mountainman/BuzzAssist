#!/usr/bin/env node
import { copyFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";
import { resolveThoughtFocusForUtterance } from "../lib/mangaVideoPipeline.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const manifestPath = resolve(process.argv[3] || join(
  projectDir,
  "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json",
));
const episodeDir = dirname(manifestPath);
const backupPath = join(episodeDir, "episode-manifest-pre-v34-thought-face-lock-r1.json");
const auditPath = join(episodeDir, "v34-thought-face-coordinate-audit.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

if (!Array.isArray(manifest.cuts) || !Array.isArray(manifest.utterances)) {
  throw new Error("Episode manifest is missing cuts or utterances.");
}
if (manifest.production?.version !== "v34-thought-face-lock-r1") {
  await copyFile(manifestPath, backupPath);
}

const cut = manifest.cuts.find((entry) => entry.id === "cut-03");
const utterance = manifest.utterances.find((entry) => entry.id === "cut-03-u02");
const shot = cut?.cameraSequence?.find((entry) => entry.utteranceIds?.includes(utterance?.id));
if (!cut || !utterance || !shot) throw new Error("Thought cut, utterance, or active shot is missing.");

// OpenCV Haar frontal-face detection on the approved 1456x816 source plate
// returns Ren's facial plane at px(271,121,157,157).  Do not substitute a
// hair/head box here: its centre sits visibly above and left of the eyes,
// nose, mouth, and chin that viewers perceive as "the face".
const sourceFaceBounds = {
  x: 271 / 1456,
  y: 121 / 816,
  width: 157 / 1456,
  height: 157 / 816,
};
shot.sourceFaceBoundsBySpeakerId = {
  ...(shot.sourceFaceBoundsBySpeakerId || {}),
  [utterance.speakerId]: sourceFaceBounds,
};
// The old screen-space annotation was authored before the V33 page camera and
// placed the bright center roughly 4.4 percentage points above/left of Ren.
delete shot.screenFaceBoundsBySpeakerId;
cut.thoughtFocus = {
  ...(cut.thoughtFocus || {}),
  enabled: true,
  speakerId: utterance.speakerId,
  opacity: 0.31,
  faceBrightness: 0.1,
  referenceRule: "attachments-1-8-opencv-facial-plane-projected-v34",
};
delete cut.thoughtFocus.faceBounds;

manifest.video = {
  ...(manifest.video || {}),
  fileName: "manga-photo-homecoming-001-v34-thought-face-lock-r1.mp4",
  statusAfterRender: "final-v34-thought-face-lock-r1",
  cameraRendererRevision: "v34-source-face-through-camera-r1",
};
manifest.status = "v34-thought-face-lock-ready";
manifest.production = {
  ...(manifest.production || {}),
  version: "v34-thought-face-lock-r1",
  thoughtFocusPolicy: {
    version: "source-face-camera-projection-r1",
    speakerRule: "only the active inner-monologue speaker receives the clear face spot",
    coordinateRule: "detect the facial plane (not the full hair/head box) on the approved source plate, then project it through the same zoom and crop as the rendered camera",
    compositionRule: "darken the complete frame by 31%; keep one compact face-sized clear ellipse with a restrained 10% feathered lift",
    forbidden: [
      "reuse stale screen coordinates after camera changes",
      "light the non-speaking character",
      "use a full-body or room-sized spotlight",
      "accept metadata-only QA without checking the projected center",
    ],
  },
};

const width = manifest.video?.width || 1920;
const height = manifest.video?.height || 1080;
const resolved = await resolveThoughtFocusForUtterance(cut, utterance, width, height);
const center = resolved.faceBounds
  ? {
      x: resolved.faceBounds.x + resolved.faceBounds.width / 2,
      y: resolved.faceBounds.y + resolved.faceBounds.height / 2,
    }
  : null;
const expectedCenter = { x: 0.25906663617305487, y: 0.263862955280862 };
const centerError = center
  ? Math.hypot(center.x - expectedCenter.x, center.y - expectedCenter.y)
  : Number.POSITIVE_INFINITY;
const audit = {
  version: "v34-thought-face-coordinate-audit-r1",
  manifestPath,
  cutId: cut.id,
  utteranceId: utterance.id,
  speakerId: utterance.speakerId,
  activeShotId: shot.id,
  sourceImagePath: shot.imagePath,
  faceDetection: {
    engine: "OpenCV 4.12 Haar frontal-face default",
    sourcePixelSize: { width: 1456, height: 816 },
    sourcePixelBounds: { x: 271, y: 121, width: 157, height: 157 },
    semanticTarget: "facial plane containing eyes, nose, mouth, and chin; excludes hair silhouette",
  },
  sourceFaceBounds,
  projectionProgress: resolved.projectionProgress,
  projectedFaceBounds: resolved.faceBounds,
  projectedCenter: center,
  expectedMeasuredCenter: expectedCenter,
  centerError,
  previousStaleCenter: { x: 0.2293425385749447, y: 0.22664439106229828 },
  previousCenterError: Math.hypot(
    0.2293425385749447 - expectedCenter.x,
    0.22664439106229828 - expectedCenter.y,
  ),
  resolvedSource: resolved.resolvedSource,
  gates: [
    {
      id: "source-face-wins",
      pass: resolved.resolvedSource === "active-camera-projected-source-face",
    },
    {
      id: "projected-center-matches-measured-face",
      threshold: 0.005,
      value: centerError,
      pass: centerError <= 0.005,
    },
    {
      id: "spot-remains-face-sized",
      pass: resolved.faceBounds?.width <= 0.15 && resolved.faceBounds?.height <= 0.34,
    },
  ],
};
audit.pass = audit.gates.every((gate) => gate.pass);
if (!audit.pass) throw new Error(`V34 thought-face coordinate audit failed: ${JSON.stringify(audit.gates)}`);

await Promise.all([
  writeJsonAtomic(manifestPath, manifest),
  writeJsonAtomic(auditPath, audit),
]);

process.stdout.write(`${JSON.stringify({ manifestPath, backupPath, auditPath, pass: true, projectedCenter: center }, null, 2)}\n`);
