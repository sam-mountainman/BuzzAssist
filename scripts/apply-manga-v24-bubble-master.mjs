#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  normalizeCameraShotSequence,
} from "../lib/mangaVideoPipeline.mjs";
import { renderSpeechBubbleSvg } from "../lib/speechBubbleRenderer.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const manifestPath = resolve(process.argv[3] || join(
  projectDir,
  "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json",
));
const episodeDir = dirname(manifestPath);
const rawManifest = await readFile(manifestPath, "utf8");
let manifest = JSON.parse(rawManifest);
const backupPath = join(episodeDir, "episode-manifest-v23-semantic-camera-r1-backup.json");
try {
  await access(backupPath);
} catch {
  await writeFile(backupPath, rawManifest, "utf8");
}

const fps = Math.max(12, Number(manifest.video?.fps) || 30);
const frameSeconds = 1 / fps;
const transitionGapSeconds = frameSeconds;
const profileId = "reference-video-locked-v3";
const sourceCameraHash = createHash("sha256")
  .update(JSON.stringify(manifest.cuts.map((cut) => ({ id: cut.id, cameraSequence: cut.cameraSequence }))))
  .digest("hex");
const sourceAudioHash = createHash("sha256")
  .update(JSON.stringify(manifest.utterances.map((utterance) => ({
    id: utterance.id,
    audio: utterance.audio,
    pauseBeforeSeconds: utterance.pauseBeforeSeconds,
  }))))
  .digest("hex");
const sourceAudioTimingHash = createHash("sha256")
  .update(JSON.stringify(manifest.utterances.map((utterance) => ({
    id: utterance.id,
    audioStartInCutSeconds: utterance.timing?.audioStartInCutSeconds,
    audioEndInCutSeconds: utterance.timing?.audioEndInCutSeconds,
    audioStartSeconds: utterance.timing?.audioStartSeconds,
    audioEndSeconds: utterance.timing?.audioEndSeconds,
  }))))
  .digest("hex");

const stripTerminalFullStop = (value) => String(value ?? "")
  .trim()
  .replace(/[。．]+$/u, "");
const normalizedText = (value) => String(value ?? "")
  .replace(/\r?\n/gu, "")
  .replace(/\s+/gu, "")
  .replace(/\.{2,}|…+|⋯+|・{3,}/gu, "︙")
  .replace(/!/gu, "！")
  .replace(/\?/gu, "？");

// Human-approved vertical columns.  They are semantic phrases, not equal
// character slices: particles stay with their phrase, demonstratives stay
// with their noun, and punctuation never begins a column.
const columnsById = {
  "cut-01-u01": ["写真は、光がそこに", "あったことを証明する"],
  "cut-01-u02": ["けれど、写した人の", "名前まで守ってくれる", "わけではない"],
  "cut-01-u03": ["雨、強くなったな。", "閉店前に、この現像だけ", "終わらせよう"],
  "cut-02-u01": ["商店街の古い写真店で、", "蓮は色あせた家族写真を", "一枚ずつ補修していた"],
  "cut-03-u01": ["その言い方、", "昔と変わらないね"],
  "cut-03-u02": ["澪なのか？", "東京にいるはずじゃ︙"],
  "cut-04-u01": ["私が撮った写真を、", "恋人だった神谷さんが", "自分の作品として発表したの"],
  "cut-04-u02": ["元データか、", "撮影した日を", "証明できるものは？"],
  "cut-05-u02": ["彼女の作品を、", "あなたの名前で", "出したんですか？"],
  "cut-05-u03": ["世に出したのは僕だ。", "名前なんて、", "売れる側のものだろう"],
  "cut-06-u01": ["私は戻らない。", "あの写真は、祖母の最後の", "夏を撮った大切な記録なの"],
  "cut-07-u01": ["ある。", "澪が十年前に", "預けたネガです"],
  "cut-07-u02": ["去年複製したデータも、", "作成日時も、", "依頼票も残っています"],
  "cut-07-u03": ["そんな古い記録が、", "何になる"],
  "cut-08-u01": ["展示の主催者へ送る。", "撮影者が誰か、", "私の名前で確かめてもらう"],
  "cut-08-u02": ["翌週、展示は中止され、", "神谷との契約も", "解除された"],
  "cut-08-u03": ["彼が借りた光は、", "彼自身を照らし返した"],
  "cut-09-u01": ["私が遠くに行っても、", "写真を捨てないでね"],
  "cut-09-u02": ["捨てない。", "いつか帰ってきたら、", "ちゃんと返す"],
  "cut-09-u03": ["子供の約束は未来を縛らず、", "帰る道に小さな灯りを", "残すことがある"],
  "cut-10-u01": ["店の二階、空いてるよね。", "ここで写真スタジオを", "始めたい"],
  "cut-10-u02": ["それから︙", "今度は、蓮の隣にいたい"],
  "cut-10-u03": ["おかえり。", "仕事も、その先も、", "ゆっくり一緒に決めよう"],
  "cut-10-u04": ["雨上がりの商店街で、", "二人の新しい一枚目が", "静かに写真になっていった"],
};

// Lines called out by the review cannot be broken cleanly inside a single
// three-column balloon.  Replace the balloon at a measured sentence pause;
// the two SVGs never coexist on the same frame.
const segmentPlans = {
  "cut-02-u02": {
    splitEnd: 2.02,
    splitStart: 2.09,
    segments: [
      { text: "思い出は新品にできません", columns: ["思い出は", "新品にできません"] },
      { text: "でも、もう一度見える形には戻せます", columns: ["でも、もう一度", "見える形には戻せます"] },
    ],
  },
  "cut-03-u03": {
    splitEnd: 0.93,
    splitStart: 1.00,
    segments: [
      { text: "帰ってきたの", columns: ["帰ってきたの"] },
      { text: "行く場所はあるのに、帰りたい場所が分からなくなって", columns: ["行く場所はあるのに、", "帰りたい場所が", "分からなくなって"] },
    ],
  },
  "cut-04-u03": {
    splitEnd: 1.73,
    splitStart: 1.80,
    segments: [
      { text: "全部向こうに預けたまま", columns: ["全部向こうに", "預けたまま"] },
      { text: "信じていたから", columns: ["信じていたから"] },
    ],
  },
  "cut-05-u01": {
    splitEnd: 2.57,
    splitStart: 2.64,
    segments: [
      { text: "連絡を無視するから迎えに来た", columns: ["連絡を無視するから", "迎えに来た"] },
      { text: "君は僕の助手だ。勝手に帰られると困る", columns: ["君は僕の助手だ。", "勝手に帰られると困る"] },
    ],
  },
  "cut-06-u02": {
    splitEnd: 2.31,
    splitStart: 2.38,
    segments: [
      { text: "感情で仕事を失うつもりか？", columns: ["感情で仕事を失う", "つもりか？"] },
      { text: "この町に君の居場所なんてない", columns: ["この町に君の", "居場所なんてない"] },
    ],
  },
  "cut-08-u01": {
    splitEnd: 1.75,
    splitStart: 1.82,
    segments: [
      { text: "展示の主催者へ送る", columns: ["展示の主催者へ", "送る"] },
      { text: "撮影者が誰か、私の名前で確かめてもらう", columns: ["撮影者が誰か、", "私の名前で", "確かめてもらう"] },
    ],
  },
};

const preferredSide = {
  "cut-01-u01": "right", "cut-01-u02": "right", "cut-01-u03": "right",
  "cut-02-u01": "right", "cut-02-u02": "right",
  "cut-03-u01": "left", "cut-03-u02": "right", "cut-03-u03": "left",
  "cut-04-u01": "left", "cut-04-u02": "right", "cut-04-u03": "left",
  "cut-05-u01": "left", "cut-05-u02": "right", "cut-05-u03": "right",
  "cut-06-u01": "right", "cut-06-u02": "left",
  "cut-07-u01": "right", "cut-07-u02": "right", "cut-07-u03": "left",
  "cut-08-u01": "right", "cut-08-u02": "left", "cut-08-u03": "right",
  "cut-09-u01": "left", "cut-09-u02": "right", "cut-09-u03": "right",
  "cut-10-u01": "left", "cut-10-u02": "left", "cut-10-u03": "right", "cut-10-u04": "left",
};
const strictPlacementSide = new Set(["cut-09-u01", "cut-09-u02"]);
// This evidence/phone shot has faces on both outer upper lanes.  Its approved
// lower-right box is the clean negative space; a blind top-lane replan would
// cover Reiji even though the active speaker is Mio.
const preserveApprovedBounds = new Set();
// The cut-10 source spec inherited viewport-space coordinates from an older
// camera pass. Lock the active speaker to her actual source-image head/hair
// envelope so the opening right-angle close-up cannot put the balloon over
// Mio's face during the 50 ms fade-in.
const sourceSpeakerFaceOverrides = {
  "cut-10-u01": {
    id: "mio-face",
    kind: "face",
    x: 0.59,
    y: 0.02,
    width: 0.28,
    height: 0.47,
    weight: 1600,
  },
};

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, Number(value) || 0));

function cameraAtProgress(camera, rawProgress) {
  const progress = clamp(rawProgress, 0, 1);
  const keyframes = Array.isArray(camera?.keyframes) && camera.keyframes.length >= 2
    ? camera.keyframes
    : [
        { at: 0, zoom: camera?.zoomStart || 1, focusX: camera?.focusX ?? 0.5, focusY: camera?.focusY ?? 0.5 },
        { at: 1, zoom: camera?.zoomEnd || camera?.zoomStart || 1, focusX: camera?.focusXEnd ?? camera?.focusX ?? 0.5, focusY: camera?.focusYEnd ?? camera?.focusY ?? 0.5 },
      ];
  let left = keyframes[0];
  let right = keyframes.at(-1);
  for (let index = 0; index < keyframes.length - 1; index += 1) {
    if (progress <= keyframes[index + 1].at + 1e-9) {
      left = keyframes[index];
      right = keyframes[index + 1];
      break;
    }
  }
  const span = Math.max(1e-9, right.at - left.at);
  const local = clamp((progress - left.at) / span, 0, 1);
  const startZoom = Math.max(1e-6, Number(left.zoom) || 1);
  const endZoom = Math.max(1e-6, Number(right.zoom) || startZoom);
  return {
    zoom: startZoom * Math.pow(endZoom / startZoom, local),
    focusX: Number(left.focusX) + (Number(right.focusX) - Number(left.focusX)) * local,
    focusY: Number(left.focusY) + (Number(right.focusY) - Number(left.focusY)) * local,
  };
}

function normalizedSourceRect(region, width, height) {
  if (!region || typeof region !== "object") return null;
  const rawWidth = Number(region.width);
  const rawHeight = Number(region.height);
  if (!(rawWidth > 0) || !(rawHeight > 0)) return null;
  const normalized = Math.abs(Number(region.x)) <= 1
    && Math.abs(Number(region.y)) <= 1
    && rawWidth <= 1
    && rawHeight <= 1;
  return {
    x: normalized ? Number(region.x) : Number(region.x) / width,
    y: normalized ? Number(region.y) : Number(region.y) / height,
    width: normalized ? rawWidth : rawWidth / width,
    height: normalized ? rawHeight : rawHeight / height,
    id: region.id,
    kind: String(region.kind || "unknown"),
    weight: Number(region.weight) || undefined,
  };
}

function projectSourceRect(region, camera) {
  const cropWidth = 1 / camera.zoom;
  const cropHeight = 1 / camera.zoom;
  const originX = clamp(camera.focusX - cropWidth / 2, 0, 1 - cropWidth);
  const originY = clamp(camera.focusY - cropHeight / 2, 0, 1 - cropHeight);
  const left = clamp((region.x - originX) * camera.zoom, 0, 1);
  const top = clamp((region.y - originY) * camera.zoom, 0, 1);
  const right = clamp((region.x + region.width - originX) * camera.zoom, 0, 1);
  const bottom = clamp((region.y + region.height - originY) * camera.zoom, 0, 1);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function sampledProgresses(shot, intervalStart, intervalEnd) {
  const start = clamp((intervalStart - shot.startSeconds) / Math.max(1e-9, shot.durationSeconds), 0, 1);
  const end = clamp((intervalEnd - shot.startSeconds) / Math.max(1e-9, shot.durationSeconds), 0, 1);
  const values = Array.from({ length: 33 }, (_, index) => start + (end - start) * index / 32);
  for (const keyframe of shot.camera?.keyframes || []) {
    if (keyframe.at >= start - 1e-9 && keyframe.at <= end + 1e-9) values.push(keyframe.at);
  }
  return [...new Set(values.map((value) => value.toFixed(9)))].map(Number).sort((a, b) => a - b);
}

function sweptViewportRegion(region, shot, progressValues) {
  const projections = progressValues
    .map((progress) => projectSourceRect(region, cameraAtProgress(shot.camera, progress)))
    .filter(Boolean);
  if (projections.length === 0) return null;
  const left = Math.min(...projections.map((entry) => entry.x));
  const top = Math.min(...projections.map((entry) => entry.y));
  const right = Math.max(...projections.map((entry) => entry.x + entry.width));
  const bottom = Math.max(...projections.map((entry) => entry.y + entry.height));
  return {
    id: region.id ? `${region.id}-camera-sweep` : undefined,
    kind: region.kind,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    weight: region.weight,
  };
}

const forbiddenColumnStart = /^[、。！？）］】」』〉》〕〗〙〛ぁぃぅぇぉゃゅょっァィゥェォャュョッー]/u;
const forbiddenColumnEnd = /[（［【「『〈《〔〖〘〚]$/u;
const utteranceById = new Map(manifest.utterances.map((utterance) => [utterance.id, utterance]));
const oldSpecById = new Map();
for (const utterance of manifest.utterances) {
  oldSpecById.set(utterance.id, JSON.parse(await readFile(utterance.overlaySpecPath, "utf8")));
  delete utterance.retainBubbleThroughNext;
  delete utterance.retain_bubble_through_next;
  delete utterance.bubbleRetentionPolicy;
  delete utterance.bubbleSegments;
  delete utterance.rasterizedOverlayPath;
  utterance.bubbleDisplayText = stripTerminalFullStop(utterance.text);
}

const placementContextById = new Map();
for (const cut of manifest.cuts) {
  const cutUtterances = cut.utteranceIds
    .map((id) => utteranceById.get(id))
    .filter(Boolean);
  const shots = normalizeCameraShotSequence(cut, cutUtterances, cut.timing?.durationSeconds);
  for (const utterance of cutUtterances) {
    const oldSpec = oldSpecById.get(utterance.id);
    const width = oldSpec.imageSize?.width || oldSpec.plan?.width || 1672;
    const height = oldSpec.imageSize?.height || oldSpec.plan?.height || 941;
    const oldBubble = oldSpec.bubble || oldSpec.plan?.bubbles?.[0] || {};
    const shot = shots.find((entry) => entry.utteranceIds.includes(utterance.id));
    if (!shot) throw new Error(`V27 camera-aware placement has no shot for ${utterance.id}`);
    const intervalStart = Math.max(shot.startSeconds, Number(utterance.timing?.bubbleStartInCutSeconds) || shot.startSeconds);
    const intervalEnd = Math.min(shot.endSeconds, Number(utterance.timing?.bubbleEndInCutSeconds) || shot.endSeconds);
    const progressValues = sampledProgresses(shot, intervalStart, intervalEnd);
    const rawSourceRegions = oldSpec.sourceAvoidRegions || oldSpec.avoidRegions || [];
    let sourceRegions = rawSourceRegions
      .map((region) => normalizedSourceRect(region, width, height))
      .filter(Boolean)
      .filter((region, index, rows) => rows.findIndex((candidate) => (
        candidate.kind === region.kind
        && Math.abs(candidate.x - region.x) < 1e-6
        && Math.abs(candidate.y - region.y) < 1e-6
        && Math.abs(candidate.width - region.width) < 1e-6
        && Math.abs(candidate.height - region.height) < 1e-6
      )) === index);
    const sourceSpeakerFaceOverride = sourceSpeakerFaceOverrides[utterance.id];
    if (sourceSpeakerFaceOverride) {
      sourceRegions = sourceRegions
        .filter((region) => region.id !== sourceSpeakerFaceOverride.id)
        .concat(sourceSpeakerFaceOverride);
    }
    const faceSourceRegions = sourceRegions.filter((region) => region.kind === "face" || region.kind === "mouth");
    const midProgress = (progressValues[0] + progressValues.at(-1)) / 2;
    let sourceSpeakerFace = sourceSpeakerFaceOverride
      || normalizedSourceRect(oldBubble.speakerHint?.faceBounds, width, height);
    // V27 overlay specs intentionally omit faceBounds from the public bubble
    // hint. On a repeatable rebuild, recover the active face by projecting all
    // authored face regions at the interval midpoint and matching the stored
    // mouth anchor. This keeps the active face hard-protected on every run.
    const previousTarget = oldBubble.target || oldSpec.cameraAwarePlacement?.target;
    if (!sourceSpeakerFace && utterance.preset !== "narration" && previousTarget && faceSourceRegions.length > 0) {
      const targetX = Math.abs(Number(previousTarget.x)) <= 1
        ? Number(previousTarget.x)
        : Number(previousTarget.x) / width;
      const targetY = Math.abs(Number(previousTarget.y)) <= 1
        ? Number(previousTarget.y)
        : Number(previousTarget.y) / height;
      const midpointCamera = cameraAtProgress(shot.camera, midProgress);
      sourceSpeakerFace = faceSourceRegions
        .map((region) => {
          const projected = projectSourceRect(region, midpointCamera);
          if (!projected) return null;
          const mouth = {
            x: projected.x + projected.width / 2,
            y: projected.y + projected.height * 0.69,
          };
          return { region, distance: Math.hypot(targetX - mouth.x, targetY - mouth.y) };
        })
        .filter(Boolean)
        .sort((left, right) => left.distance - right.distance)[0]?.region || null;
    }
    const cameraAwareAvoidRegions = sourceRegions
      .map((region) => sweptViewportRegion(region, shot, progressValues))
      .filter(Boolean)
      .map((region) => {
        const isSpeakerFace = sourceSpeakerFace && sourceRegions.some((sourceRegion) => (
          sourceRegion.id === region.id?.replace(/-camera-sweep$/u, "")
          && Math.abs(sourceRegion.x - sourceSpeakerFace.x) < 1e-6
          && Math.abs(sourceRegion.y - sourceSpeakerFace.y) < 1e-6
          && Math.abs(sourceRegion.width - sourceSpeakerFace.width) < 1e-6
          && Math.abs(sourceRegion.height - sourceSpeakerFace.height) < 1e-6
        ));
        if ((region.kind === "face" || region.kind === "mouth") && !isSpeakerFace) {
          return { ...region, kind: "body", weight: 80 };
        }
        return region.kind === "face" || region.kind === "mouth"
          ? {
            ...region,
            x: clamp(region.x - 0.012, 0, 1),
            y: clamp(region.y - 0.012, 0, 1),
            width: clamp(region.width + 0.024, 0, 1 - clamp(region.x - 0.012, 0, 1)),
            height: clamp(region.height + 0.024, 0, 1 - clamp(region.y - 0.012, 0, 1)),
            weight: 1600,
          }
          : region;
      });
    const projectedSpeakerFace = sourceSpeakerFace
      ? projectSourceRect(sourceSpeakerFace, cameraAtProgress(shot.camera, midProgress))
      : null;
    const target = projectedSpeakerFace
      ? {
          x: (projectedSpeakerFace.x + projectedSpeakerFace.width / 2) * width,
          y: (projectedSpeakerFace.y + projectedSpeakerFace.height * 0.69) * height,
        }
      : previousTarget;
    const speakerProximityProgresses = [...new Set(Array.from({ length: 9 }, (_, index) => (
      progressValues[Math.round(index * (progressValues.length - 1) / 8)]
    )))];
    const speakerProximityTargets = sourceSpeakerFace
      ? speakerProximityProgresses
        .map((progress) => projectSourceRect(sourceSpeakerFace, cameraAtProgress(shot.camera, progress)))
        .filter(Boolean)
        .map((face) => ({
          x: (face.x + face.width / 2) * width,
          y: (face.y + face.height * 0.69) * height,
        }))
      : [];
    placementContextById.set(utterance.id, {
      shotId: shot.id,
      shotAngle: shot.angle,
      intervalStart,
      intervalEnd,
      sampledCameraPositions: progressValues.length,
      sourceAvoidRegions: rawSourceRegions,
      cameraAwareAvoidRegions,
      sourceSpeakerFace,
      projectedSpeakerFace,
      target,
      multiPersonFaceCount: faceSourceRegions.length,
      speakerProximityTargets,
    });
  }
}

function bubbleInput(utterance, oldSpec, text, columns, suffix = "") {
  const oldBubble = oldSpec.bubble || oldSpec.plan?.bubbles?.[0] || {};
  const context = placementContextById.get(utterance.id);
  const { faceBounds: _discardedFaceBounds, ...speakerHint } = oldBubble.speakerHint || {};
  return {
    id: `${utterance.bubbleId || `bubble-${utterance.id}`}${suffix}`,
    utteranceId: utterance.id,
    order: utterance.order,
    text,
    columns,
    maxColumns: Math.max(1, Math.min(3, columns.length)),
    preset: utterance.preset,
    tail: false,
    fontWeight: 400,
    fontFamily: "'Hiragino Mincho ProN','Yu Mincho','YuMincho','Noto Serif JP',serif",
    profileId,
    placementSide: preferredSide[utterance.id] || oldBubble.placementSide,
    lockPlacementSide: strictPlacementSide.has(utterance.id),
    speakerHint,
    target: context?.target,
    speakerProximityTargets: utterance.preset !== "narration" && context?.multiPersonFaceCount >= 2
      ? context.speakerProximityTargets
      : [],
  };
}

function renderOne(utterance, oldSpec, bubble, bounds, title) {
  const width = oldSpec.imageSize?.width || oldSpec.plan?.width || 1672;
  const height = oldSpec.imageSize?.height || oldSpec.plan?.height || 941;
  const avoidRegions = placementContextById.get(utterance.id)?.cameraAwareAvoidRegions || [];
  return renderSpeechBubbleSvg({
    width,
    height,
    bubbles: [{ ...bubble, ...(bounds ? { bounds } : {}) }],
    avoidRegions,
    profileId,
    title,
  });
}

const overlayRows = [];
for (const utterance of manifest.utterances) {
  const oldSpec = oldSpecById.get(utterance.id);
  const split = segmentPlans[utterance.id];
  if (split) {
    const probes = split.segments.map((segment, index) => renderOne(
      utterance,
      oldSpec,
      bubbleInput(utterance, oldSpec, segment.text, segment.columns, `-s${index + 1}`),
      null,
      `${manifest.title} ${utterance.id} segment ${index + 1} probe`,
    ));
    const sharedBounds = probes
      .map((probe) => probe.plan.bubbles[0].bounds)
      .sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const renderedSegments = split.segments.map((segment, index) => {
      const rendered = renderOne(
        utterance,
        oldSpec,
        bubbleInput(utterance, oldSpec, segment.text, segment.columns, `-s${index + 1}`),
        sharedBounds,
        `${manifest.title} ${utterance.id} segment ${index + 1} V27 camera-aware`,
      );
      const quality = rendered.quality[0];
      if (quality.overflow || quality.textLoss || quality.tooSmall || quality.faceOverlapRatio > 0.005 || quality.importantOverlapRatio > 0.75) {
        throw new Error(`V27 segment bubble gate failed for ${utterance.id} s${index + 1}: ${JSON.stringify(quality)}`);
      }
      if (quality.columnTexts.join("") !== normalizedText(segment.text)) {
        throw new Error(`V27 segment columns changed text for ${utterance.id} s${index + 1}`);
      }
      if (quality.columnTexts.some((column) => forbiddenColumnStart.test(column) || forbiddenColumnEnd.test(column))) {
        throw new Error(`V27 kinsoku failed for ${utterance.id} s${index + 1}`);
      }
      return { segment, rendered, quality, index };
    });
    const duration = Number(utterance.audio?.durationSeconds) || 0;
    utterance.bubbleSegments = renderedSegments.map(({ segment, rendered, quality, index }) => {
      const overlayPath = join(episodeDir, "overlays", `${utterance.id}-s${index + 1}.svg`);
      return {
        id: `${utterance.id}-bubble-s${index + 1}`,
        text: segment.text,
        columns: segment.columns,
        overlayPath,
        startOffsetSeconds: index === 0 ? -0.08 : split.splitStart,
        endOffsetSeconds: index === renderedSegments.length - 1 ? duration + 0.18 : split.splitEnd,
        quality,
        bounds: rendered.plan.bubbles[0].bounds,
      };
    });
    for (const [index, entry] of renderedSegments.entries()) {
      await writeFile(utterance.bubbleSegments[index].overlayPath, entry.rendered.svg, "utf8");
    }
    await writeFile(utterance.overlayPath, renderedSegments[0].rendered.svg, "utf8");
    await writeFile(utterance.overlaySpecPath, `${JSON.stringify({
      ...oldSpec,
      version: "v27-reference-video-regular-camera-aware",
      sourceAvoidRegions: placementContextById.get(utterance.id).sourceAvoidRegions,
      cameraAwarePlacement: placementContextById.get(utterance.id),
      bubble: renderedSegments[0].rendered.plan.bubbles[0],
      plan: renderedSegments[0].rendered.plan,
      quality: renderedSegments.map((entry) => entry.quality),
      bubbleSegments: utterance.bubbleSegments,
      profile: renderedSegments[0].rendered.profile,
      profileId,
      displayText: utterance.bubbleDisplayText,
      punctuationPolicy: "all-terminal-full-stops-omitted; internal-punctuation-preserved; comma-and-full-stop-optically-offset-upper-right",
      lineBreakPolicy: "human-approved-semantic-columns; 1-3 columns; long clauses replaced sequentially at measured sentence pauses",
      transitionPolicy: "exclusive one-bubble timeline; no retained balloon; no crossfade; one-frame clear gap",
      typographyPolicy: "Mincho regular 400 only; synthetic bold and emphasis bold disabled",
      placementPolicy: "dialogue uses the nearest clean pocket beside the active speaker across the full camera move; authored strict sides remain locked; narration stays edge-composed",
      refreshedAt: new Date().toISOString(),
    }, null, 2)}\n`, "utf8");
    overlayRows.push(...renderedSegments.map((entry) => ({
      utteranceId: utterance.id,
      segment: entry.index + 1,
      displayText: entry.segment.text,
      columns: entry.quality.columnTexts,
      quality: entry.quality,
      placementSide: preferredSide[utterance.id],
      preset: utterance.preset,
      bounds: entry.rendered.plan.bubbles[0].bounds,
      frameWidth: entry.rendered.plan.width,
      frameHeight: entry.rendered.plan.height,
      shotId: placementContextById.get(utterance.id).shotId,
    })));
    continue;
  }

  const displayText = utterance.bubbleDisplayText;
  const columns = columnsById[utterance.id];
  if (!columns || normalizedText(columns.join("")) !== normalizedText(displayText)) {
    throw new Error(`Missing or stale V27 semantic columns for ${utterance.id}`);
  }
  const approvedBounds = preserveApprovedBounds.has(utterance.id)
    ? (oldSpec.bubble || oldSpec.plan?.bubbles?.[0] || {}).bounds
    : null;
  const probe = renderOne(utterance, oldSpec, bubbleInput(utterance, oldSpec, displayText, columns), approvedBounds, `${manifest.title} ${utterance.id} probe`);
  const rendered = renderOne(
    utterance,
    oldSpec,
    bubbleInput(utterance, oldSpec, displayText, columns),
    probe.plan.bubbles[0].bounds,
    `${manifest.title} ${utterance.id} V27 camera-aware`,
  );
  const quality = rendered.quality[0];
  if (quality.overflow || quality.textLoss || quality.tooSmall || quality.faceOverlapRatio > 0.005 || quality.importantOverlapRatio > 0.75) {
    throw new Error(`V27 bubble gate failed for ${utterance.id}: ${JSON.stringify(quality)}`);
  }
  if (quality.columnTexts.some((column) => forbiddenColumnStart.test(column) || forbiddenColumnEnd.test(column))) {
    throw new Error(`V27 kinsoku failed for ${utterance.id}`);
  }
  await writeFile(utterance.overlayPath, rendered.svg, "utf8");
  await writeFile(utterance.overlaySpecPath, `${JSON.stringify({
    ...oldSpec,
    version: "v27-reference-video-regular-camera-aware",
    sourceAvoidRegions: placementContextById.get(utterance.id).sourceAvoidRegions,
    cameraAwarePlacement: placementContextById.get(utterance.id),
    bubble: rendered.plan.bubbles[0],
    plan: rendered.plan,
    quality: rendered.quality,
    bubbleSegments: [],
    profile: rendered.profile,
    profileId,
    displayText,
    punctuationPolicy: "all-terminal-full-stops-omitted; internal-punctuation-preserved; comma-and-full-stop-optically-offset-upper-right",
    lineBreakPolicy: "human-approved-semantic-columns; 1-3 columns; no stranded particles/determiners/punctuation",
    transitionPolicy: "exclusive one-bubble timeline; no retained balloon; no crossfade; one-frame clear gap",
    typographyPolicy: "Mincho regular 400 only; synthetic bold and emphasis bold disabled",
    placementPolicy: "dialogue uses the nearest clean pocket beside the active speaker across the full camera move; authored strict sides remain locked; narration stays edge-composed",
    refreshedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  overlayRows.push({
    utteranceId: utterance.id,
    segment: 1,
    displayText,
    columns: quality.columnTexts,
    quality,
    placementSide: preferredSide[utterance.id],
    preset: utterance.preset,
    bounds: rendered.plan.bubbles[0].bounds,
    frameWidth: rendered.plan.width,
    frameHeight: rendered.plan.height,
    shotId: placementContextById.get(utterance.id).shotId,
  });
}

manifest.video = {
  ...(manifest.video || {}),
  fileName: "manga-photo-homecoming-001-v27-camera-aware-regular-bubbles-r1.mp4",
  statusAfterRender: "final-v27-camera-aware-regular-bubbles-r1",
  bubbleTransitionGapSeconds: transitionGapSeconds,
  bubbleTransitionCrossfadeSeconds: 0,
  bubbleFadeInMilliseconds: 50,
  bubbleFadeOutMilliseconds: 50,
};

// Bubble-only boundary correction: audio and camera timing stay untouched,
// while the outgoing balloon clears one frame before an illustration changes.
for (const cut of manifest.cuts) {
  const cutUtterances = cut.utteranceIds.map((id) => utteranceById.get(id)).filter(Boolean);
  const shots = normalizeCameraShotSequence(cut, cutUtterances, cut.timing?.durationSeconds);
  for (const utterance of cutUtterances) {
    const shot = shots.find((entry) => entry.utteranceIds.includes(utterance.id));
    if (!shot) throw new Error(`No V27 camera shot owns ${utterance.id}`);
    utterance.timing.bubbleStartInCutSeconds = Math.max(
      Number(utterance.timing.bubbleStartInCutSeconds) || 0,
      shot.startSeconds,
    );
    utterance.timing.bubbleEndInCutSeconds = Math.min(
      Number(utterance.timing.bubbleEndInCutSeconds) || shot.endSeconds,
      Math.max(shot.startSeconds, shot.endSeconds - frameSeconds),
    );
    utterance.timing.bubbleStartSeconds = cut.timing.startSeconds + utterance.timing.bubbleStartInCutSeconds;
    utterance.timing.bubbleEndSeconds = cut.timing.startSeconds + utterance.timing.bubbleEndInCutSeconds;
  }
  for (let index = 0; index < cutUtterances.length - 1; index += 1) {
    const current = cutUtterances[index];
    const next = cutUtterances[index + 1];
    current.timing.bubbleEndInCutSeconds = Math.min(
      current.timing.bubbleEndInCutSeconds,
      Math.max(current.timing.bubbleStartInCutSeconds, next.timing.bubbleStartInCutSeconds - frameSeconds * 2),
    );
    current.timing.bubbleEndSeconds = cut.timing.startSeconds + current.timing.bubbleEndInCutSeconds;
  }
}

const intervalRows = [];
for (const cut of manifest.cuts) {
  const cutUtterances = cut.utteranceIds.map((id) => manifest.utterances.find((entry) => entry.id === id)).filter(Boolean);
  const shots = normalizeCameraShotSequence(cut, cutUtterances, cut.timing?.durationSeconds);
  for (const utterance of cutUtterances) {
    const baseStart = utterance.timing.bubbleStartInCutSeconds;
    const baseEnd = utterance.timing.bubbleEndInCutSeconds;
    const audioStart = utterance.timing.audioStartInCutSeconds;
    const shot = shots.find((entry) => entry.utteranceIds.includes(utterance.id));
    const segments = Array.isArray(utterance.bubbleSegments) && utterance.bubbleSegments.length > 0
      ? utterance.bubbleSegments
      : [{ id: utterance.id, startOffsetSeconds: baseStart - audioStart, endOffsetSeconds: baseEnd - audioStart }];
    for (const segment of segments) {
      intervalRows.push({
        cutId: cut.id,
        utteranceId: utterance.id,
        segmentId: segment.id,
        start: Math.max(baseStart, Math.min(baseEnd, audioStart + Number(segment.startOffsetSeconds))),
        end: Math.max(baseStart, Math.min(baseEnd, audioStart + Number(segment.endOffsetSeconds))),
        shotId: shot.id,
        shotStart: shot.startSeconds,
        shotEnd: shot.endSeconds,
      });
    }
  }
}
const overlaps = [];
for (let left = 0; left < intervalRows.length; left += 1) {
  for (let right = left + 1; right < intervalRows.length; right += 1) {
    const a = intervalRows[left];
    const b = intervalRows[right];
    if (a.cutId !== b.cutId) continue;
    if (a.start < b.end - 1e-9 && b.start < a.end - 1e-9) overlaps.push([a.segmentId, b.segmentId]);
  }
}
const shotBleeds = intervalRows.filter((entry) => (
  entry.start < entry.shotStart - 1e-9 || entry.end > entry.shotEnd - frameSeconds + 1e-9
));
const terminalFullStops = overlayRows.filter((entry) => /[。．]$/u.test(entry.displayText));
const invalidColumns = overlayRows.filter((entry) => (
  entry.columns.length > 3
  || entry.columns.some((column) => forbiddenColumnStart.test(column) || forbiddenColumnEnd.test(column))
));
const placementSideViolations = overlayRows.filter((entry) => {
  if (!strictPlacementSide.has(entry.utteranceId)) return false;
  const centerX = entry.bounds.x + entry.bounds.width / 2;
  return entry.placementSide === "left" ? centerX >= entry.frameWidth / 2 : centerX < entry.frameWidth / 2;
});
const speakerProximityRows = overlayRows.filter((entry) => entry.quality.speakerProximitySampleCount > 0);
const speakerProximityMeanRatio = speakerProximityRows.length > 0
  ? speakerProximityRows.reduce((sum, entry) => sum + entry.quality.speakerProximityMeanRatio, 0)
    / speakerProximityRows.length
  : null;
const speakerProximityMaxRatio = speakerProximityRows.length > 0
  ? Math.max(...speakerProximityRows.map((entry) => entry.quality.speakerProximityMaxRatio))
  : null;
const overlayAssetPaths = [...new Set(manifest.utterances.flatMap((utterance) => (
  Array.isArray(utterance.bubbleSegments) && utterance.bubbleSegments.length > 0
    ? utterance.bubbleSegments.map((segment) => segment.overlayPath)
    : [utterance.overlayPath]
)))];
const regularWeightViolations = [];
const dialogueShapeViolations = [];
const narrationShapeViolations = [];
const syntheticBoldViolations = [];
for (const overlayPath of overlayAssetPaths) {
  const svg = await readFile(overlayPath, "utf8");
  const weights = [...svg.matchAll(/font-weight="(\d+)"/gu)].map((match) => Number(match[1]));
  if (weights.length === 0 || weights.some((weight) => weight !== 400)) {
    regularWeightViolations.push({ overlayPath, weights: [...new Set(weights)] });
  }
  const narration = /data-preset="narration"/u.test(svg);
  if (narration && !/data-shape="rectangle"/u.test(svg)) narrationShapeViolations.push(overlayPath);
  if (!narration && !/data-shape="ellipse"/u.test(svg)) dialogueShapeViolations.push(overlayPath);
  if (/font-synthesis:(?!none)/u.test(svg) || /font-weight="(?:[5-9]\d\d)"/u.test(svg)) syntheticBoldViolations.push(overlayPath);
}
if (
  overlaps.length > 0
  || shotBleeds.length > 0
  || terminalFullStops.length > 0
  || invalidColumns.length > 0
  || placementSideViolations.length > 0
  || regularWeightViolations.length > 0
  || dialogueShapeViolations.length > 0
  || narrationShapeViolations.length > 0
  || syntheticBoldViolations.length > 0
) {
  throw new Error(`V27 bubble QA failed: ${JSON.stringify({
    overlaps,
    shotBleeds,
    terminalFullStops,
    invalidColumns,
    placementSideViolations,
    regularWeightViolations,
    dialogueShapeViolations,
    narrationShapeViolations,
    syntheticBoldViolations,
  })}`);
}

const finalCameraHash = createHash("sha256")
  .update(JSON.stringify(manifest.cuts.map((cut) => ({ id: cut.id, cameraSequence: cut.cameraSequence }))))
  .digest("hex");
const finalAudioHash = createHash("sha256")
  .update(JSON.stringify(manifest.utterances.map((utterance) => ({
    id: utterance.id,
    audio: utterance.audio,
    pauseBeforeSeconds: utterance.pauseBeforeSeconds,
  }))))
  .digest("hex");
const finalAudioTimingHash = createHash("sha256")
  .update(JSON.stringify(manifest.utterances.map((utterance) => ({
    id: utterance.id,
    audioStartInCutSeconds: utterance.timing?.audioStartInCutSeconds,
    audioEndInCutSeconds: utterance.timing?.audioEndInCutSeconds,
    audioStartSeconds: utterance.timing?.audioStartSeconds,
    audioEndSeconds: utterance.timing?.audioEndSeconds,
  }))))
  .digest("hex");
if (sourceCameraHash !== finalCameraHash || sourceAudioHash !== finalAudioHash || sourceAudioTimingHash !== finalAudioTimingHash) {
  throw new Error("V27 changed the locked V26 camera, approved audio metadata, or approved audio timing.");
}

manifest.status = "timed";
manifest.production = {
  ...(manifest.production || {}),
  version: "v27-camera-aware-regular-bubbles",
  bubblePolicy: {
    profileId,
    visibleBubbleMaximumPerFrame: 1,
    terminalFullStop: "omit",
    internalPunctuation: "preserve",
    punctuationPosition: "vertical-upper-right",
    fontWeight: 400,
    syntheticBold: false,
    transition: "50ms fade with one-frame clear gap; never crossfade or retain previous balloon",
    dialogueShape: "smooth oval only",
    narrationShape: "rectangle only",
    placement: "each face/prop is projected through all 33 camera samples; in multi-person dialogue choose the nearest active-speaker-safe outer or central pocket using nine speaker samples; only explicitly authored sides are locked; narration remains edge-composed",
    activeSpeakerFaceOverlapAllowed: false,
    inactiveSpeakerOverlap: "allowed only when it is the cleanest negative-space solution",
  },
  referenceBubbleAnalysis: {
    sourceIds: ["awAbZyTeE4g", "2ycRncs4CKY"],
    exactLocalSources: [
      join(projectDir, "canvas/reference-media/love-manga/awAbZyTeE4g.mp4"),
      join(projectDir, "canvas/reference-media/love-manga/2ycRncs4CKY.mp4"),
    ],
    sampledFrames: 80,
    whiteRegionCandidates: 102,
    medianBubbleWidthRatio: 0.1438,
    medianBubbleHeightRatio: 0.3083,
    medianBubbleAreaRatio: 0.0248,
    multiPersonDialoguePlacement: "nearest clean negative-space pocket adjacent to the active speaker; central actor gap is preferred over a distant outer edge when it stays face-safe",
    caveat: "Geometry is measured automatically; punctuation, semantic columns, placement and replacement timing were visually reviewed on the exact local source frames.",
  },
};
if (manifest.outputs?.reviewVideo) delete manifest.outputs.reviewVideo;
if (manifest.outputs?.finalVideo) delete manifest.outputs.finalVideo;
manifest.updatedAt = new Date().toISOString();

const audit = {
  version: "v27-camera-aware-regular-bubbles",
  sourceVersion: "v26-continuous-linear-camera-r1",
  referenceSources: manifest.production.referenceBubbleAnalysis,
  rules: manifest.production.bubblePolicy,
  utteranceCount: manifest.utterances.length,
  renderedBubbleAssetCount: overlayRows.length,
  splitUtteranceCount: Object.keys(segmentPlans).length,
  intervalCount: intervalRows.length,
  simultaneousOverlapCount: overlaps.length,
  shotBoundaryBleedCount: shotBleeds.length,
  terminalFullStopCount: terminalFullStops.length,
  invalidColumnCount: invalidColumns.length,
  placementSideViolationCount: placementSideViolations.length,
  speakerProximityDialogueAssetCount: speakerProximityRows.length,
  speakerProximityMeanRatio,
  speakerProximityMaxRatio,
  regularWeightViolationCount: regularWeightViolations.length,
  dialogueShapeViolationCount: dialogueShapeViolations.length,
  narrationShapeViolationCount: narrationShapeViolations.length,
  syntheticBoldViolationCount: syntheticBoldViolations.length,
  overflowCount: overlayRows.filter((entry) => entry.quality.overflow).length,
  textLossCount: overlayRows.filter((entry) => entry.quality.textLoss).length,
  tooSmallCount: overlayRows.filter((entry) => entry.quality.tooSmall).length,
  activeFaceCollisionCount: overlayRows.filter((entry) => entry.quality.faceOverlapRatio > 0.005).length,
  importantPropCollisionCount: overlayRows.filter((entry) => entry.quality.importantOverlapRatio > 0.75).length,
  cameraHashPreserved: sourceCameraHash === finalCameraHash,
  audioMetadataHashPreserved: sourceAudioHash === finalAudioHash,
  audioTimingHashPreserved: sourceAudioTimingHash === finalAudioTimingHash,
  sourceCameraHash,
  sourceAudioHash,
  sourceAudioTimingHash,
  placementDistribution: Object.fromEntries([...new Set(overlayRows.map((entry) => entry.placementSide))].map((side) => [
    side,
    overlayRows.filter((entry) => entry.placementSide === side).length,
  ])),
  distinctPlacementAnchorCount: new Set(overlayRows.map((entry) => [
    entry.placementSide,
    Math.round(entry.bounds.x / entry.frameWidth * 20),
    Math.round(entry.bounds.y / entry.frameHeight * 20),
  ].join(":"))).size,
  intervalRows,
  overlayRows,
};
const auditPath = join(episodeDir, "v27-camera-aware-bubble-audit.json");
await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  manifestPath,
  backupPath,
  auditPath,
  utteranceCount: audit.utteranceCount,
  renderedBubbleAssetCount: audit.renderedBubbleAssetCount,
  splitUtteranceCount: audit.splitUtteranceCount,
  simultaneousOverlapCount: audit.simultaneousOverlapCount,
  shotBoundaryBleedCount: audit.shotBoundaryBleedCount,
  terminalFullStopCount: audit.terminalFullStopCount,
  invalidColumnCount: audit.invalidColumnCount,
  placementSideViolationCount: audit.placementSideViolationCount,
  speakerProximityDialogueAssetCount: audit.speakerProximityDialogueAssetCount,
  speakerProximityMeanRatio: audit.speakerProximityMeanRatio,
  speakerProximityMaxRatio: audit.speakerProximityMaxRatio,
  regularWeightViolationCount: audit.regularWeightViolationCount,
  dialogueShapeViolationCount: audit.dialogueShapeViolationCount,
  narrationShapeViolationCount: audit.narrationShapeViolationCount,
  syntheticBoldViolationCount: audit.syntheticBoldViolationCount,
  distinctPlacementAnchorCount: audit.distinctPlacementAnchorCount,
  overflowCount: audit.overflowCount,
  textLossCount: audit.textLossCount,
  cameraHashPreserved: audit.cameraHashPreserved,
  audioMetadataHashPreserved: audit.audioMetadataHashPreserved,
  audioTimingHashPreserved: audit.audioTimingHashPreserved,
}, null, 2)}\n`);
