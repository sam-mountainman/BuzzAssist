#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { normalizeCameraShotSequence } from "../lib/mangaVideoPipeline.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const manifestPath = resolve(process.argv[3] || join(
  projectDir,
  "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json",
));
const episodeDir = dirname(manifestPath);
const planPath = join(episodeDir, "v21-camera-master-plan.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const baselinePlan = JSON.parse(await readFile(join(episodeDir, "v20-strong-editorial-camera-plan.json"), "utf8"));
const utteranceById = new Map(manifest.utterances.map((utterance) => [utterance.id, utterance]));

const groupKey = (cutId, utteranceIds) => `${cutId}:${utteranceIds.join(",")}`;
const baselineFocusByGroup = new Map(baselinePlan.cameraRows.map((row) => [
  groupKey(row.cutId, row.utteranceIds),
  { focusX: row.focusX, focusY: row.focusY },
]));
const profiles = new Map([
  [groupKey("cut-01", ["cut-01-u01", "cut-01-u02"]), { kind: "pullout", purpose: "雨の写真店と物語の舞台を静かに開く" }],
  [groupKey("cut-01", ["cut-01-u03"]), { kind: "directional", axis: "x", sign: 1, travel: .18, purpose: "蓮から作業台へ左側面のまま視線を流す" }],
  [groupKey("cut-02", ["cut-02-u01", "cut-02-u02"]), { kind: "combined", axis: "y", sign: -1, purpose: "補修する手元から机全体へトップのまま引く" }],
  [groupKey("cut-03", ["cut-03-u01", "cut-03-u02"]), { kind: "directional", axis: "x", sign: -1, travel: .18, purpose: "右側の澪から左側の蓮へ会話の視線を渡す" }],
  [groupKey("cut-03", ["cut-03-u03"]), { kind: "directional", axis: "x", sign: -1, travel: .15, purpose: "澪の表情から帰る場所の空間へ右側面のまま流す" }],
  [groupKey("cut-04", ["cut-04-u01", "cut-04-u02"]), { kind: "directional", axis: "x", sign: -1, travel: .18, purpose: "澪の写真から証拠を問う蓮へ会話の視線を渡す" }],
  [groupKey("cut-04", ["cut-04-u03"]), { kind: "pullout", purpose: "澪の脆さを壊さず、呼吸する余白だけを広げる" }],
  [groupKey("cut-05", ["cut-05-u01", "cut-05-u02"]), { kind: "combined", axis: "x", sign: -1, purpose: "礼司の圧力から蓮の追及へ右側面の引きを組み合わせる" }],
  [groupKey("cut-05", ["cut-05-u03"]), { kind: "directional", axis: "x", sign: 1, travel: .16, purpose: "礼司の傲慢さを右側面の横移動だけで見せる" }],
  [groupKey("cut-06", ["cut-06-u01", "cut-06-u02"]), { kind: "combined", axis: "x", sign: 1, terminalStable: true, zoomEnd: 1.20, purpose: "澪の拒絶から礼司の反撃へ右方向の引きを組み合わせる" }],
  [groupKey("cut-07", ["cut-07-u01", "cut-07-u02"]), { kind: "combined", axis: "y", sign: -1, terminalStable: true, purpose: "ネガ・日時・依頼票の関係をトップのまま引いて見せる" }],
  [groupKey("cut-07", ["cut-07-u03"]), { kind: "pullout", purpose: "礼司の反応から状況の崩れへ純粋に引く" }],
  [groupKey("cut-08", ["cut-08-u01"]), { kind: "directional", axis: "y", sign: -1, travel: .14, purpose: "送信操作と証拠をトップ移動だけで追う" }],
  [groupKey("cut-08", ["cut-08-u02", "cut-08-u03"]), { kind: "pullout", purpose: "個人の争いから展示中止という社会的結果へ純粋に引く" }],
  [groupKey("cut-09", ["cut-09-u01"]), { kind: "directional", axis: "x", sign: -1, travel: .17, purpose: "幼い澪の約束を右側面のまま辿る" }],
  [groupKey("cut-09", ["cut-09-u02"]), { kind: "directional", axis: "x", sign: 1, travel: .17, purpose: "幼い蓮の返答を左側面のまま辿る" }],
  [groupKey("cut-09", ["cut-09-u03"]), { kind: "directional", axis: "y", sign: -1, travel: .14, purpose: "短い回想の結びはトップ移動だけで帰る道を辿る" }],
  [groupKey("cut-10", ["cut-10-u01"]), { kind: "directional", axis: "x", sign: -1, travel: .15, purpose: "澪の提案を右側面の横移動だけで受ける" }],
  [groupKey("cut-10", ["cut-10-u02"]), { kind: "pullout", purpose: "澪の告白を急かさず、純粋な引きで余白を作る" }],
  [groupKey("cut-10", ["cut-10-u03", "cut-10-u04"]), { kind: "pullout", purpose: "蓮の返答から二人の新生活へ純粋に開く" }],
]);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const rounded = (value) => Number(value.toFixed(6));
const safeRange = (zoom, padding = .008) => {
  const edge = 1 / (2 * zoom) + padding;
  return [edge, 1 - edge];
};
const safeFocus = (value, zoom) => {
  const [min, max] = safeRange(zoom);
  return clamp(Number(value), min, max);
};
const angleFamily = (angle) => String(angle || "wide").replace(/-wide$/u, "");

function cameraForProfile(shot, profile, baselineFocus) {
  const original = shot.camera || {};
  const originalX = Number(baselineFocus?.focusX ?? original.focusX ?? .5);
  const originalY = Number(baselineFocus?.focusY ?? original.focusY ?? .46);
  const common = {
    saturation: 1,
    contrast: 1,
    brightness: 0,
    easing: "smoothstep",
    motionLeadRatio: 0,
    motionTailRatio: 0,
  };

  if (profile.kind === "pullout") {
    const zoomEnd = 1.08;
    const reveal = angleFamily(shot.angle) === "wide" ? .30 : .32;
    const zoomStart = zoomEnd / (1 - reveal);
    // A pull-out must not secretly become a pan. Keeping the authored focus
    // inside the endpoint's legal crop range removes edge-clamp "wall hits".
    const focusX = safeFocus(originalX, zoomEnd);
    const focusY = safeFocus(originalY, zoomEnd);
    return {
      ...common,
      zoomStart: rounded(zoomStart),
      zoomEnd,
      focusX: rounded(focusX),
      focusY: rounded(focusY),
      focusXEnd: rounded(focusX),
      focusYEnd: rounded(focusY),
    };
  }

  if (profile.kind === "directional") {
    const zoom = profile.axis === "y" ? 1.52 : 1.48;
    const focusX = safeFocus(originalX, zoom);
    const focusY = safeFocus(originalY, zoom);
    let focusXEnd = focusX;
    let focusYEnd = focusY;
    if (profile.axis === "x") focusXEnd = safeFocus(focusX + profile.sign * profile.travel, zoom);
    if (profile.axis === "y") focusYEnd = safeFocus(focusY + profile.sign * profile.travel, zoom);
    return {
      ...common,
      zoomStart: zoom,
      zoomEnd: zoom,
      focusX: rounded(focusX),
      focusY: rounded(focusY),
      focusXEnd: rounded(focusXEnd),
      focusYEnd: rounded(focusYEnd),
    };
  }

  const zoomStart = angleFamily(shot.angle) === "top" ? 1.64 : 1.60;
  const zoomEnd = profile.zoomEnd ?? 1.12;
  let startX = safeFocus(originalX, zoomStart);
  // A top combination begins on the lower story target (hands, evidence,
  // path) and travels upward. This guarantees that "top" can never resolve
  // into a small downward fallback as the legal crop range narrows.
  let startY = safeFocus(
    profile.axis === "y" && profile.sign < 0 ? Math.max(originalY, .58) : originalY,
    zoomStart,
  );
  let endX = safeFocus(startX, zoomEnd);
  let endY = safeFocus(startY, zoomEnd);
  const [endMin, endMax] = safeRange(zoomEnd);
  if (profile.axis === "x") {
    // Horizontal combination: no hidden vertical component.
    // Long dialogue scenes deliberately begin on the first speaker's side
    // and cross a substantial distance to the respondent.
    startX = safeFocus(profile.sign < 0 ? Math.max(originalX, .64) : Math.min(originalX, .36), zoomStart);
    startY = safeFocus(originalY, zoomEnd);
    endY = startY;
    endX = profile.sign < 0 ? endMin : endMax;
  }
  if (profile.axis === "y") {
    // Top combination: no hidden left/right component.
    startX = safeFocus(originalX, zoomEnd);
    endX = startX;
    endY = profile.sign < 0 ? endMin : endMax;
  }
  return {
    ...common,
    easing: profile.terminalStable ? "soft-linear" : common.easing,
    zoomStart,
    zoomEnd,
    focusX: rounded(startX),
    focusY: rounded(startY),
    focusXEnd: rounded(endX),
    focusYEnd: rounded(endY),
  };
}

for (const cut of manifest.cuts) {
  if (!Array.isArray(cut.cameraSequence) || cut.cameraSequence.length === 0) {
    throw new Error(`V21 requires an authored camera sequence for ${cut.id}`);
  }
  cut.cameraSequence = cut.cameraSequence.map((shot) => {
    const key = groupKey(cut.id, shot.utteranceIds || []);
    const profile = profiles.get(key);
    if (!profile) throw new Error(`Missing V21 camera profile for ${key}`);
    const camera = cameraForProfile(shot, profile, baselineFocusByGroup.get(key));
    const mode = profile.kind === "pullout"
      ? "pullout-only"
      : profile.kind === "directional"
        ? `${angleFamily(shot.angle)}-only`
        : `pullout-plus-${angleFamily(shot.angle)}`;
    return {
      ...shot,
      id: String(shot.id).replace(/v20-strong/u, "v21-master"),
      motion: mode,
      camera,
      cameraMode: mode,
      editorialPurpose: profile.purpose,
      reason: `${profile.purpose}。終端で別方向へフォールバックせず、この軌道だけを完走する`,
    };
  });
  cut.imagePath = cut.cameraSequence[0].imagePath;
  cut.motion = cut.cameraSequence[0].motion;
  cut.camera = cut.cameraSequence[0].camera;
}

const rows = [];
for (const cut of manifest.cuts) {
  const cutUtterances = cut.utteranceIds.map((id) => utteranceById.get(id)).filter(Boolean);
  const normalized = normalizeCameraShotSequence(cut, cutUtterances, cut.timing?.durationSeconds);
  for (const shot of normalized) {
    const source = cut.cameraSequence.find((entry) => entry.id === shot.id);
    const zoomDelta = shot.camera.zoomEnd - shot.camera.zoomStart;
    const dx = shot.camera.focusXEnd - shot.camera.focusX;
    const dy = shot.camera.focusYEnd - shot.camera.focusY;
    const startXRange = safeRange(shot.camera.zoomStart, 0);
    const startYRange = safeRange(shot.camera.zoomStart, 0);
    const endXRange = safeRange(shot.camera.zoomEnd, 0);
    const endYRange = safeRange(shot.camera.zoomEnd, 0);
    const within = (value, [min, max]) => value >= min - 1e-6 && value <= max + 1e-6;
    rows.push({
      cutId: cut.id,
      shotId: shot.id,
      utteranceIds: shot.utteranceIds,
      angle: source.angle,
      cameraMode: source.cameraMode,
      editorialPurpose: source.editorialPurpose,
      startSeconds: Number(shot.startSeconds.toFixed(4)),
      endSeconds: Number(shot.endSeconds.toFixed(4)),
      durationSeconds: Number(shot.durationSeconds.toFixed(4)),
      zoomStart: shot.camera.zoomStart,
      zoomEnd: shot.camera.zoomEnd,
      zoomDelta: Number(zoomDelta.toFixed(6)),
      focusX: shot.camera.focusX,
      focusY: shot.camera.focusY,
      focusXEnd: shot.camera.focusXEnd,
      focusYEnd: shot.camera.focusYEnd,
      dx: Number(dx.toFixed(6)),
      dy: Number(dy.toFixed(6)),
      safeFromCropClamp: within(shot.camera.focusX, startXRange)
        && within(shot.camera.focusY, startYRange)
        && within(shot.camera.focusXEnd, endXRange)
        && within(shot.camera.focusYEnd, endYRange),
      terminalFallbackAllowed: false,
      oversample: 3,
    });
  }
}

const counts = {
  pulloutOnly: rows.filter((row) => row.cameraMode === "pullout-only").length,
  directionalOnly: rows.filter((row) => row.cameraMode.endsWith("-only") && row.cameraMode !== "pullout-only").length,
  combined: rows.filter((row) => row.cameraMode.startsWith("pullout-plus-")).length,
};
if (rows.length !== 20 || counts.pulloutOnly !== 6 || counts.directionalOnly !== 10 || counts.combined !== 4) {
  throw new Error(`V21 mode gate failed: ${JSON.stringify({ rows: rows.length, counts })}`);
}
for (const row of rows) {
  const changesZoom = Math.abs(row.zoomDelta) > 1e-6;
  const changesDirection = Math.hypot(row.dx, row.dy) > 1e-6;
  if (row.cameraMode === "pullout-only" && (!changesZoom || changesDirection)) {
    throw new Error(`Pullout-only shot contains a hidden directional move: ${row.shotId}`);
  }
  if (row.cameraMode.endsWith("-only") && row.cameraMode !== "pullout-only" && (changesZoom || !changesDirection)) {
    throw new Error(`Directional-only shot contains a hidden zoom: ${row.shotId}`);
  }
  if (row.cameraMode.startsWith("pullout-plus-") && (!changesZoom || !changesDirection)) {
    throw new Error(`Combined shot is missing one of its authored motions: ${row.shotId}`);
  }
  if (row.cameraMode.startsWith("pullout-plus-") && (row.durationSeconds < 8 || row.utteranceIds.length < 2)) {
    throw new Error(`Combined motion is reserved for a long, sustained scene: ${row.shotId}`);
  }
  if (row.dy > 1e-6) throw new Error(`Unauthorized downward motion: ${row.shotId}`);
  if (!row.safeFromCropClamp) throw new Error(`Camera path can collide with a crop boundary: ${row.shotId}`);
}

const plan = {
  version: "v21-camera-master",
  referenceVideoIds: ["awAbZyTeE4g", "2ycRncs4CKY"],
  referenceCalibration: {
    medianZoomPercentPerSecond: .3121,
    p90ZoomPercentPerSecond: 1.7509,
    medianTranslationPercentPerSecond: .4564,
    p90TranslationPercentPerSecond: 1.3825,
    policy: "Use one semantically selected motion grammar per shot; ease continuously to the endpoint without a terminal fallback.",
  },
  counts,
  terminalFallbackCount: 0,
  downwardFallbackCount: 0,
  cropBoundaryCollisionCount: rows.filter((row) => !row.safeFromCropClamp).length,
  cameraOversample: 3,
  rows,
};

manifest.video = {
  ...(manifest.video || {}),
  fileName: "manga-photo-homecoming-001-v21-camera-master-r2.mp4",
  statusAfterRender: "final-review-candidate-v21-camera-master-r2",
  cameraOversample: 3,
};
manifest.status = "v21-camera-master-plan-ready";
manifest.production = {
  ...(manifest.production || {}),
  version: "v21-camera-master",
  cameraPolicy: {
    referenceVideoIds: plan.referenceVideoIds,
    cameraModeCounts: counts,
    terminalFallbackAllowed: false,
    downwardFallbackAllowed: false,
    cropBoundaryCollisionAllowed: false,
    continuousSubpixelMotion: true,
    oversample: 3,
  },
};
manifest.updatedAt = new Date().toISOString();

await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ manifestPath, planPath, ...plan, rows: undefined }, null, 2)}\n`);
