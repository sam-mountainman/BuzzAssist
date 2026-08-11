#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, copyFile, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  auditCameraSequencePolicy,
  normalizeCameraShotSequence,
} from "../lib/mangaVideoPipeline.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const manifestPath = resolve(process.argv[3] || join(
  projectDir,
  "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json",
));
const episodeDir = dirname(manifestPath);
const backupPath = join(episodeDir, "episode-manifest-v25-natural-dialogue-r2-backup.json");
const planPath = join(episodeDir, "v26-continuous-linear-camera-plan.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

try {
  await access(backupPath);
} catch {
  await copyFile(manifestPath, backupPath);
}

const baselineManifest = JSON.parse(await readFile(backupPath, "utf8"));

const rounded = (value, digits = 6) => Number(value.toFixed(digits));
const hashJson = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cutById = new Map(manifest.cuts.map((cut) => [cut.id, cut]));
const baselineCutById = new Map(baselineManifest.cuts.map((cut) => [cut.id, cut]));
const utteranceById = new Map(manifest.utterances.map((utterance) => [utterance.id, utterance]));
const existingShot = (cutId, index) => {
  const shot = baselineCutById.get(cutId)?.cameraSequence?.[index];
  if (!shot) throw new Error(`Missing ${cutId} camera shot ${index}`);
  return structuredClone(shot);
};
const utteranceStart = (utteranceId) => {
  const utterance = utteranceById.get(utteranceId);
  if (!utterance) throw new Error(`Missing utterance ${utteranceId}`);
  return Number(utterance.timing.audioStartInCutSeconds);
};
const shotBoundaryBefore = (utteranceId) => {
  const utterance = utteranceById.get(utteranceId);
  if (!utterance) throw new Error(`Missing utterance ${utteranceId}`);
  return Number(utterance.timing.audioStartInCutSeconds) - Number(utterance.timing.gapBeforeSeconds || 0) / 2;
};
const ratio = (numerator, denominator, fallback = .5) => {
  const value = denominator > 0 ? numerator / denominator : fallback;
  return rounded(Math.max(.18, Math.min(.82, value)));
};
const k = (at, zoom, focusX, focusY) => ({
  at: rounded(at),
  zoom: rounded(zoom),
  focusX: rounded(focusX),
  focusY: rounded(focusY),
});
const linearCamera = (keyframes) => {
  if (!Array.isArray(keyframes) || keyframes.length < 2) throw new Error("Camera needs at least two keyframes");
  const first = keyframes[0];
  const last = keyframes.at(-1);
  return {
    zoomStart: first.zoom,
    zoomEnd: last.zoom,
    focusX: first.focusX,
    focusY: first.focusY,
    focusXEnd: last.focusX,
    focusYEnd: last.focusY,
    easing: "linear",
    motionLeadRatio: 0,
    motionTailRatio: 0,
    saturation: 1,
    contrast: 1,
    brightness: 0,
    keyframes,
  };
};
const revisedShot = (base, input) => ({
  ...base,
  id: input.id,
  utteranceIds: input.utteranceIds,
  angle: input.angle,
  viewpoint: input.viewpoint,
  endView: input.endView,
  transition: "cut",
  motion: input.motion,
  cameraMode: input.cameraMode,
  viewMode: input.viewMode,
  reason: input.reason,
  editorialPurpose: input.reason,
  startFraming: input.startFraming,
  semanticStartSubject: input.semanticStartSubject,
  semanticEndSubject: input.semanticEndSubject,
  motionIntensity: "reference-matched-continuous-linear",
  camera: linearCamera(input.keyframes),
});

const beforeInvariant = {
  utterances: hashJson(manifest.utterances),
  nonCameraCuts: hashJson(manifest.cuts.map((cut) => {
    const copy = structuredClone(cut);
    delete copy.camera;
    delete copy.cameraSequence;
    delete copy.cameraAssetInventory;
    delete copy.motion;
    return copy;
  })),
};

const cut02Duration = cutById.get("cut-02").timing.durationSeconds;
const cut05FirstDuration = shotBoundaryBefore("cut-05-u03");
const cut06Duration = cutById.get("cut-06").timing.durationSeconds;
const cut07Duration = cutById.get("cut-07").timing.durationSeconds;
const cut10FirstDuration = shotBoundaryBefore("cut-10-u03");

const sequences = new Map([
  ["cut-01", [
    revisedShot(existingShot("cut-01", 0), {
      id: "cut-01-v26-continuous-opening-pullout",
      utteranceIds: ["cut-01-u01", "cut-01-u02"],
      angle: "wide", viewpoint: "left", endView: "left-wide",
      motion: "pullout-only-continuous", cameraMode: "pullout-only", viewMode: "wide-pullout",
      keyframes: [k(0, 1.48, .46, .49), k(1, 1.18, .46, .49)],
      startFraming: "補修中の蓮と写真を最初に見せる",
      semanticStartSubject: "補修中の蓮と写真", semanticEndSubject: "雨の写真店全景",
      reason: "補修中の蓮と写真を起点に、速度を落とさず店内全景へ引き続ける",
    }),
    revisedShot(existingShot("cut-01", 1), {
      id: "cut-01-v26-continuous-left-ren",
      utteranceIds: ["cut-01-u03"],
      angle: "left", viewpoint: "left", endView: "left-wide",
      motion: "left-only-continuous", cameraMode: "left-only", viewMode: "left-travel",
      keyframes: [k(0, 1.44, .52, .38), k(1, 1.44, .60, .38)],
      startFraming: "話している蓮を最初に見せる",
      semanticStartSubject: "話している蓮", semanticEndSubject: "蓮と現像写真",
      reason: "蓮から現像写真へ左側面の関係を保ったまま一定速度で移動する",
    }),
  ]],
  ["cut-02", [
    revisedShot(existingShot("cut-02", 0), {
      id: "cut-02-v26-continuous-top-then-pullout",
      utteranceIds: ["cut-02-u01", "cut-02-u02"],
      angle: "top", viewpoint: "top", endView: "top-wide",
      motion: "top-then-pullout-continuous", cameraMode: "top-then-pullout", viewMode: "top-to-wide-continuous",
      keyframes: [
        k(0, 1.65, .50, .58),
        k(ratio(utteranceStart("cut-02-u02"), cut02Duration), 1.65, .50, .48),
        k(1, 1.18, .50, .48),
      ],
      startFraming: "補修する手元と家族写真を先に見せる",
      semanticStartSubject: "蓮の手元と家族写真", semanticEndSubject: "補修台と証拠の全体",
      reason: "手元からトップ方向へ移動し、その到達地点を一切リセットせず机全体へ引く",
    }),
  ]],
  ["cut-03", [
    revisedShot(existingShot("cut-03", 0), {
      id: "cut-03-v26-continuous-right-dialogue",
      utteranceIds: ["cut-03-u01", "cut-03-u02"],
      angle: "right", viewpoint: "right", endView: "right-wide",
      motion: "right-only-continuous", cameraMode: "right-only", viewMode: "speaker-transfer-right",
      keyframes: [k(0, 1.58, .65, .39), k(1, 1.58, .35, .39)],
      startFraming: "最初に話す澪を先に見せる",
      semanticStartSubject: "最初に話す澪", semanticEndSubject: "次に話す蓮",
      reason: "澪から蓮への話者交代を右側面の一定速度移動で追う",
    }),
    revisedShot(existingShot("cut-03", 1), {
      id: "cut-03-v26-continuous-confession-pullout",
      utteranceIds: ["cut-03-u03"],
      angle: "right", viewpoint: "right", endView: "right-wide",
      motion: "pullout-only-continuous", cameraMode: "pullout-only", viewMode: "right-pullout",
      keyframes: [k(0, 1.72, .60, .40), k(1, 1.36, .60, .40)],
      startFraming: "帰る場所を語る澪を最初に見せる",
      semanticStartSubject: "帰る場所を語る澪", semanticEndSubject: "澪と聞く蓮",
      reason: "澪の告白から聞く蓮まで、停止せず純粋な引きだけで含める",
    }),
  ]],
  ["cut-04", [
    revisedShot(existingShot("cut-04", 0), {
      id: "cut-04-v26-continuous-right-confession",
      utteranceIds: ["cut-04-u01", "cut-04-u02"],
      angle: "right", viewpoint: "right", endView: "right-wide",
      motion: "right-only-continuous", cameraMode: "right-only", viewMode: "speaker-transfer-right",
      keyframes: [k(0, 1.58, .65, .38), k(1, 1.58, .35, .38)],
      startFraming: "盗用を告白する澪を先に見せる",
      semanticStartSubject: "盗用を告白する澪", semanticEndSubject: "証拠を尋ねる蓮",
      reason: "告白する澪から尋ねる蓮へ、右側面の一定速度移動で渡す",
    }),
    revisedShot(existingShot("cut-04", 1), {
      id: "cut-04-v26-continuous-vulnerability-pullout",
      utteranceIds: ["cut-04-u03"],
      angle: "right", viewpoint: "right", endView: "right-wide",
      motion: "pullout-only-continuous", cameraMode: "pullout-only", viewMode: "right-pullout",
      keyframes: [k(0, 1.54, .53, .43), k(1, 1.22, .53, .43)],
      startFraming: "傷ついた澪の表情を最初に見せる",
      semanticStartSubject: "傷ついた澪", semanticEndSubject: "澪と雨の余白",
      reason: "澪の表情を保ち、感情の余白へ速度を落とさず引き続ける",
    }),
  ]],
  ["cut-05", [
    revisedShot(existingShot("cut-05", 0), {
      id: "cut-05-v26-continuous-right-then-pullout",
      utteranceIds: ["cut-05-u01", "cut-05-u02"],
      angle: "right", viewpoint: "right", endView: "right-wide",
      motion: "right-then-pullout-continuous", cameraMode: "right-then-pullout", viewMode: "right-to-wide-continuous",
      keyframes: [
        k(0, 1.72, .69, .43),
        k(ratio(utteranceStart("cut-05-u02"), cut05FirstDuration), 1.72, .45, .43),
        k(1, 1.16, .45, .43),
      ],
      startFraming: "先に圧力をかける礼司を見せる",
      semanticStartSubject: "先に圧力をかける礼司", semanticEndSubject: "問い返す蓮を含む三者",
      reason: "礼司から蓮へ右側面を移動し、その到達地点から三者全景へ連続して引く",
    }),
    revisedShot(existingShot("cut-05", 1), {
      id: "cut-05-v26-continuous-right-reiji",
      utteranceIds: ["cut-05-u03"],
      angle: "right", viewpoint: "right", endView: "right-wide",
      motion: "right-only-continuous", cameraMode: "right-only", viewMode: "right-travel",
      keyframes: [k(0, 1.65, .34, .39), k(1, 1.65, .40, .39)],
      startFraming: "傲慢に言い切る礼司を見せる",
      semanticStartSubject: "傲慢に言い切る礼司", semanticEndSubject: "礼司の横顔と空間",
      reason: "礼司の横顔を外さず右側面を一定速度で移動する",
    }),
  ]],
  ["cut-06", [
    revisedShot(existingShot("cut-06", 0), {
      id: "cut-06-v26-continuous-right-then-pullout",
      utteranceIds: ["cut-06-u01", "cut-06-u02"],
      angle: "right", viewpoint: "right", endView: "right-wide",
      motion: "right-then-pullout-continuous", cameraMode: "right-then-pullout", viewMode: "right-to-wide-continuous",
      keyframes: [
        k(0, 1.64, .50, .44),
        k(ratio(utteranceStart("cut-06-u02"), cut06Duration), 1.64, .59, .44),
        k(1, 1.30, .59, .44),
      ],
      startFraming: "拒絶する澪を先に見せる",
      semanticStartSubject: "拒絶する澪", semanticEndSubject: "反撃する礼司と三者の距離",
      reason: "澪から礼司へ右移動し、その場所から三者の距離へ連続して引く",
    }),
  ]],
  ["cut-07", [
    revisedShot(existingShot("cut-07", 0), {
      id: "cut-07-v26-single-image-top-then-pullout",
      utteranceIds: ["cut-07-u01", "cut-07-u02", "cut-07-u03"],
      angle: "top", viewpoint: "top", endView: "top-wide",
      motion: "top-then-pullout-continuous", cameraMode: "top-then-pullout", viewMode: "top-to-wide-continuous",
      keyframes: [
        k(0, 1.72, .31, .64),
        k(ratio(utteranceStart("cut-07-u03"), cut07Duration), 1.72, .50, .50),
        k(1, 1.18, .50, .50),
      ],
      startFraming: "蓮とネガを先に見せる",
      semanticStartSubject: "話す蓮とネガ", semanticEndSubject: "礼司を含む証拠全体",
      reason: "同一画像を再生し直さず、証拠へのトップ移動の終点からそのまま全体へ引く",
    }),
  ]],
  ["cut-08", [
    revisedShot(existingShot("cut-08", 0), {
      id: "cut-08-v26-continuous-top-send",
      utteranceIds: ["cut-08-u01"],
      angle: "top", viewpoint: "top", endView: "top",
      motion: "top-only-continuous", cameraMode: "top-only", viewMode: "top-travel",
      keyframes: [k(0, 1.55, .47, .56), k(1, 1.55, .45, .36)],
      startFraming: "送信する手元を先に見せる",
      semanticStartSubject: "送信するスマートフォン", semanticEndSubject: "決意を語る澪",
      reason: "ダウンを使わず、送信する手元から話す澪へトップ方向に一定速度で移動する",
    }),
    revisedShot(existingShot("cut-08", 1), {
      id: "cut-08-v26-continuous-consequence-pullout",
      utteranceIds: ["cut-08-u02", "cut-08-u03"],
      angle: "wide", viewpoint: "wide", endView: "wide",
      motion: "pullout-only-continuous", cameraMode: "pullout-only", viewMode: "wide-pullout",
      keyframes: [k(0, 1.52, .53, .48), k(1, 1.16, .53, .48)],
      startFraming: "契約を失った礼司を先に見せる",
      semanticStartSubject: "契約を失った礼司", semanticEndSubject: "中止された展示空間",
      reason: "礼司の結果から展示空間全体へ、停止せず引きだけを続ける",
    }),
  ]],
  ["cut-09", [
    revisedShot(existingShot("cut-09", 0), {
      id: "cut-09-v26-continuous-right-young-mio",
      utteranceIds: ["cut-09-u01"],
      angle: "right", viewpoint: "right", endView: "right-wide",
      motion: "right-only-continuous", cameraMode: "right-only", viewMode: "right-travel",
      keyframes: [k(0, 1.55, .55, .39), k(1, 1.55, .38, .39)],
      startFraming: "先に話す幼い澪を見せる",
      semanticStartSubject: "先に話す幼い澪", semanticEndSubject: "約束を受け取る幼い蓮",
      reason: "幼い澪から蓮へ右側面の一定速度移動で視線を送る",
    }),
    revisedShot(existingShot("cut-09", 1), {
      id: "cut-09-v26-continuous-left-young-ren",
      utteranceIds: ["cut-09-u02"],
      angle: "left", viewpoint: "left", endView: "left-wide",
      motion: "left-only-continuous", cameraMode: "left-only", viewMode: "left-travel",
      keyframes: [k(0, 1.58, .43, .39), k(1, 1.58, .66, .39)],
      startFraming: "返事をする幼い蓮を見せる",
      semanticStartSubject: "返事をする幼い蓮", semanticEndSubject: "返事を聞く幼い澪",
      reason: "幼い蓮から澪へ左側面の一定速度移動で視線を返す",
    }),
    revisedShot(existingShot("cut-09", 2), {
      id: "cut-09-v26-continuous-top-then-pullout",
      utteranceIds: ["cut-09-u03"],
      angle: "top", viewpoint: "top", endView: "top-wide",
      motion: "top-then-pullout-continuous", cameraMode: "top-then-pullout", viewMode: "top-to-wide-continuous",
      keyframes: [k(0, 1.60, .52, .56), k(.46, 1.60, .50, .46), k(1, 1.12, .50, .46)],
      startFraming: "約束を交わした二人を先に見せる",
      semanticStartSubject: "約束を交わした二人", semanticEndSubject: "雨上がりの帰り道",
      reason: "二人へトップ移動し、その到達地点から帰り道全体へ連続して引く",
    }),
  ]],
  ["cut-10", [
    revisedShot(existingShot("cut-10", 0), {
      id: "cut-10-v26-single-image-right-then-pullout",
      utteranceIds: ["cut-10-u01", "cut-10-u02"],
      angle: "right", viewpoint: "right", endView: "right-wide",
      motion: "right-then-pullout-continuous", cameraMode: "right-then-pullout", viewMode: "right-to-wide-continuous",
      keyframes: [
        k(0, 1.66, .65, .38),
        k(ratio(utteranceStart("cut-10-u02"), cut10FirstDuration), 1.66, .49, .38),
        k(1, 1.34, .49, .38),
      ],
      startFraming: "提案する澪を先に見せる",
      semanticStartSubject: "提案する澪", semanticEndSubject: "告白を受け止める蓮とスタジオ",
      reason: "同一画像を寄り直さず、澪から右移動した終点を保って蓮とスタジオへ引く",
    }),
    revisedShot(existingShot("cut-10", 2), {
      id: "cut-10-v26-continuous-closing-pullout",
      utteranceIds: ["cut-10-u03", "cut-10-u04"],
      angle: "wide", viewpoint: "wide", endView: "wide",
      motion: "pullout-only-continuous", cameraMode: "pullout-only", viewMode: "wide-pullout",
      keyframes: [k(0, 1.68, .46, .42), k(1, 1.16, .46, .42)],
      startFraming: "先に返事をする蓮を見せる",
      semanticStartSubject: "先に返事をする蓮", semanticEndSubject: "二人と新しい写真店",
      reason: "蓮の返事から二人と新しい店全体へ、方向を変えず引き続ける",
    }),
  ]],
]);

manifest.video = {
  ...(manifest.video || {}),
  fileName: "manga-photo-homecoming-001-v26-continuous-linear-camera-r1.mp4",
  statusAfterRender: "final-review-candidate-v26-continuous-linear-camera-r1",
  cameraOversample: 3,
  cameraRendererRevision: "v26-continuous-geometric-zoom-keyframes-r2",
  requireConstantCameraSpeed: true,
  forbidDownwardCameraMotion: true,
  forbidRepeatedCameraImages: true,
  forbidCameraStops: true,
  normalizeMasterAudio: false,
};

for (const cut of manifest.cuts) {
  const sequence = sequences.get(cut.id);
  if (!sequence) throw new Error(`No V26 camera sequence for ${cut.id}`);
  cut.cameraSequence = sequence;
  cut.imagePath = sequence[0].imagePath;
  cut.motion = sequence[0].motion;
  cut.camera = sequence[0].camera;
  cut.cameraAssetInventory = {
    version: "v26-continuous-visual-constant-camera-r2",
    shotCount: sequence.length,
    uniqueImageCount: new Set(sequence.map((shot) => shot.imagePath)).size,
    repeatedImages: [],
  };
}

manifest.status = "camera-planned-v26-continuous-linear-r1";
manifest.editorialPlan = {
  ...(manifest.editorialPlan || {}),
  cameraV26: {
    version: "v26-continuous-visual-constant-camera-r2",
    referenceVideos: [
      "https://www.youtube.com/watch?v=awAbZyTeE4g",
      "https://www.youtube.com/watch?v=2ycRncs4CKY",
    ],
    rules: [
      "every camera segment is linear and moves through its final frame",
      "left, right, and top are permitted; down is forbidden",
      "a source image appears at most once within a cut",
      "combination shots share one continuous keyframed trajectory",
      "pullout begins at the exact endpoint of the preceding side/top move",
    ],
  },
};
manifest.production = {
  ...(manifest.production || {}),
  cameraPolicy: {
    version: "v26-continuous-linear-camera-r1",
    constantSpeed: true,
    terminalStopsAllowed: false,
    downwardMotionAllowed: false,
    repeatedImageShotsAllowed: false,
    endpointResetAllowed: false,
  },
};
manifest.updatedAt = new Date().toISOString();

const afterInvariant = {
  utterances: hashJson(manifest.utterances),
  nonCameraCuts: hashJson(manifest.cuts.map((cut) => {
    const copy = structuredClone(cut);
    delete copy.camera;
    delete copy.cameraSequence;
    delete copy.cameraAssetInventory;
    delete copy.motion;
    return copy;
  })),
};
if (beforeInvariant.utterances !== afterInvariant.utterances) {
  throw new Error("V26 camera plan unexpectedly changed utterances/audio/bubbles");
}
if (beforeInvariant.nonCameraCuts !== afterInvariant.nonCameraCuts) {
  throw new Error("V26 camera plan unexpectedly changed non-camera cut data");
}

const audits = manifest.cuts.map((cut) => {
  const utterances = cut.utteranceIds.map((id) => utteranceById.get(id)).filter(Boolean);
  const normalized = normalizeCameraShotSequence(cut, utterances, cut.timing.durationSeconds);
  const audit = auditCameraSequencePolicy(manifest, cut, normalized);
  return {
    ...audit,
    shots: normalized.map((shot) => ({
      id: shot.id,
      image: basename(shot.imagePath),
      startSeconds: rounded(shot.startSeconds),
      endSeconds: rounded(shot.endSeconds),
      durationSeconds: rounded(shot.durationSeconds),
      motion: shot.motion,
      easing: shot.camera.easing,
      keyframes: shot.camera.keyframes,
    })),
  };
});
const violations = audits.flatMap((audit) => audit.violations);
if (violations.length > 0) throw new Error(`V26 camera policy violations: ${JSON.stringify(violations)}`);

const plan = {
  version: "v26-continuous-visual-constant-camera-r2",
  createdAt: new Date().toISOString(),
  manifestPath,
  backupPath,
  referenceAnalysisPath: join(
    projectDir,
    "canvas/reference-media/love-manga/analysis/v26-reference-camera-continuity.json",
  ),
  invariants: {
    utterancesAudioBubblesUnchanged: beforeInvariant.utterances === afterInvariant.utterances,
    nonCameraCutDataUnchanged: beforeInvariant.nonCameraCuts === afterInvariant.nonCameraCuts,
    before: beforeInvariant,
    after: afterInvariant,
  },
  gates: {
    allEasingLinear: true,
    allLeadTailHoldsZero: true,
    terminalStopsForbidden: true,
    downwardMotionCount: 0,
    repeatedImageShotCount: 0,
    endpointResetCount: 0,
    policyViolationCount: violations.length,
  },
  summary: {
    cutCount: audits.length,
    shotCount: audits.reduce((sum, audit) => sum + audit.shotCount, 0),
    combinationShotCount: audits.flatMap((audit) => audit.shots)
      .filter((shot) => shot.keyframes.length > 2).length,
    uniqueImageCount: new Set(audits.flatMap((audit) => audit.shots.map((shot) => shot.image))).size,
  },
  cuts: audits,
};

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ manifestPath, planPath, status: manifest.status, ...plan.summary, gates: plan.gates }, null, 2)}\n`);
