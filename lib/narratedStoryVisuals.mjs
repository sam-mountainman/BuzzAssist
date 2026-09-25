/**
 * ナレーション物語の「見た目」の工程をまとめる入口（ジャンル層）。
 *
 * pipeline（lib/narratedStoryPipeline.mjs）からは、ここの関数を段ごとに1回ずつ呼ぶだけにする:
 *   1. loadNarratedVisualConfig   Channel Pack の宣言を読む（有料生成の前。足りなければ blocker）
 *   2. checkNarratedVisualPlan    台本に当てて、描けない理由を有料生成の前に返す
 *   3. renderNarratedSubtitleLayer など  描く
 *   4. narratedVisualAuditChecks  完成 MP4 を測る監査
 * 中身は機能ごとのモジュールにある（焼き込み字幕は lib/narratedStorySubtitles.mjs）。
 * チャンネル固有の値はここにも1つも書かない。
 */

import { join } from "node:path";

import { loadFontMetrics } from "./fontMetrics.mjs";
import { segmentFramePlan } from "./narratedStoryBookends.mjs";
import {
  NARRATED_CAMERA_AUDIT_ID,
  NARRATED_CAMERA_PLAN_VERSION,
  measureNarratedCameraMotion,
  narratedCameraManifestEntry,
  normalizeNarratedCameraConfig,
  planNarratedCameraShots,
} from "./narratedStoryCamera.mjs";
import {
  NARRATED_SUBTITLE_AUDIT_ID,
  layoutNarratedSubtitles,
  measureNarratedBurnedSubtitles,
  narratedSubtitleManifestEntry,
  normalizeNarratedSubtitlesConfig,
  planNarratedSubtitleCues,
  renderNarratedSubtitleOverlay,
  resolveNarratedSubtitleMedia,
} from "./narratedStorySubtitles.mjs";

export { NARRATED_CAMERA_AUDIT_ID, NARRATED_SUBTITLE_AUDIT_ID };

function check(pass, detail, evidence = {}) {
  return { pass: pass === true, detail: String(detail), ...evidence };
}

/**
 * Channel Pack の見た目の宣言を読む。書体など Pack 内のファイルもここで確かめる。
 * 返す config は pipeline の config へそのまま足す（subtitles）。
 */
export async function loadNarratedVisualConfig(source = {}, { render, channelPackDir }) {
  const blockers = [];
  const subtitles = normalizeNarratedSubtitlesConfig(source?.subtitles, { render });
  blockers.push(...subtitles.blockers);
  // カメラ（lib/narratedStoryCamera.mjs）。Pack に無ければ Core の既定（ゆっくりした寄りだけ）。
  const camera = normalizeNarratedCameraConfig(source?.camera);
  blockers.push(...camera.blockers);
  let subtitleConfig = subtitles.config;
  if (subtitleConfig.burnIn && subtitles.blockers.length === 0) {
    const resolved = await resolveNarratedSubtitleMedia(subtitleConfig, channelPackDir);
    blockers.push(...resolved.blockers);
    subtitleConfig = { ...subtitleConfig, fontPath: resolved.media.fontFile || "" };
  }
  return { config: { subtitles: subtitleConfig, camera: camera.config }, blockers: [...new Set(blockers)] };
}

async function subtitleMetrics(config) {
  if (!config?.subtitles?.burnIn || !config.subtitles.fontPath) return null;
  return loadFontMetrics(config.subtitles.fontPath);
}

/**
 * 台本の文（声と字幕の単位）に見た目の宣言を当て、描けない理由を返す（有料生成の前）。
 * 理由の文字列に台本の字は入れない。
 */
export async function checkNarratedVisualPlan({ config, segments = [] }) {
  const issues = [];
  // 台本パッケージが場面ごとに指定したカメラの型は、Pack が宣言した型でなければならない。
  for (const segment of segments) {
    if (segment.cameraMove && !config?.camera?.moves?.[segment.cameraMove]) issues.push(`camera-move-undeclared:${segment.sourceSegmentId || segment.id}`);
  }
  if (config?.subtitles?.burnIn) {
    const metrics = await subtitleMetrics(config);
    if (!metrics) issues.push("subtitles.fontFile-missing");
    else issues.push(...layoutNarratedSubtitles({ segments, config: config.subtitles, metrics }).issues);
  }
  return { issues: [...new Set(issues)] };
}

function visualSegmentFields(segment) {
  return {
    id: segment.id,
    text: segment.text,
    imageKey: segment.imageKey || segment.id,
    imagePath: segment.imagePath || "",
    ...(segment.cameraMove ? { cameraMove: segment.cameraMove } : {}),
    // 人物素材の感想パートは画を動かさない（カメラのショットにしない）。
    ...(segment.camera === "presenter-video" ? { presenterVideo: true } : {}),
  };
}

/**
 * 声と字幕の単位（文）の、番組のフレームでの時刻。bookends があればその時間割（部の頭＋部の中の位置）、
 * 無ければ声の実尺の累積を丸めた時間割（lib/narratedStoryBookends.mjs の segmentFramePlan と同じ）。
 */
export function narratedProgramFrames({ bookendPlan = null, segments = [], fps }) {
  if (bookendPlan) {
    const partStart = new Map(bookendPlan.parts.map((part) => [part.id, part.startFrame]));
    return {
      totalFrames: bookendPlan.totalFrames,
      segments: bookendPlan.segments.map((segment) => ({
        ...visualSegmentFields(segment),
        part: segment.part,
        startFrame: partStart.get(segment.part) + segment.partStartFrame,
        frames: segment.frames,
      })),
    };
  }
  const plan = segmentFramePlan(segments.map((segment) => segment.durationSeconds), fps);
  return {
    totalFrames: plan.reduce((sum, entry) => sum + entry.frames, 0),
    segments: segments.map((segment, index) => ({
      ...visualSegmentFields(segment),
      part: segment.part || "story",
      startFrame: plan[index].startFrame,
      frames: plan[index].frames,
    })),
  };
}

/**
 * 焼き込み字幕の層を描く。timedSegments は番組のフレームで時刻を持つ文
 * （{ id, text, startFrame, frames }）。宣言が無ければ null。
 */
export async function renderNarratedSubtitleLayer({ ffmpeg, config, timedSegments, totalFrames, workDir }) {
  if (!config?.subtitles?.burnIn) return null;
  const metrics = await subtitleMetrics(config);
  const layout = layoutNarratedSubtitles({ segments: timedSegments, config: config.subtitles, metrics });
  if (layout.issues.length > 0) throw new Error(`subtitle layout failed after preflight: ${layout.issues.join(", ")}`);
  const planned = planNarratedSubtitleCues({ timedSegments, pagesBySegment: layout.bySegment });
  if (planned.problems.length > 0) throw new Error(`subtitle cue plan failed: ${planned.problems.join(", ")}`);
  return renderNarratedSubtitleOverlay({
    ffmpeg,
    cues: planned.cues,
    config: config.subtitles,
    fontPath: config.subtitles.fontPath,
    fps: config.render.fps,
    totalFrames,
    workDir: join(workDir, "subtitles"),
  });
}

/**
 * 焼き込み字幕が描かれる範囲（描く寸法の px）。境目の転換の実測（lib/narratedStoryBookends.mjs）は字幕の
 * 出入りを転換と取り違えないように、この範囲を外して測る。帯があれば帯の全体、無ければ全部の頁の字の範囲。
 */
export function subtitleExclusionRegion(subtitleLayer, subtitleConfig) {
  if (!subtitleLayer || !subtitleConfig?.burnIn) return null;
  const { width, height } = subtitleConfig.render;
  const boxes = subtitleLayer.cues.map((cue) => cue.inkBox).filter(Boolean);
  if (subtitleConfig.band) boxes.push({ x: 0, y: subtitleConfig.band.topPx, width, height: height - subtitleConfig.band.topPx });
  if (boxes.length === 0) return null;
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * 番組のカメラのショットの計画（番組のフレームで）。描く側（lib/narratedStoryBookends.mjs の
 * partCameraShots）と同じまとめ方・同じ型の当て方で、監査はこの計画と MP4 を比べる。
 */
export function planNarratedVisualCamera({ config, programFrames }) {
  const segments = programFrames.segments.filter((segment) => !segment.presenterVideo);
  const byPart = new Map();
  for (const segment of segments) {
    if (!byPart.has(segment.part)) byPart.set(segment.part, []);
    byPart.get(segment.part).push(segment);
  }
  const shots = [];
  const problems = [];
  for (const list of byPart.values()) {
    const planned = planNarratedCameraShots({ segments: list, camera: config.camera, fps: config.render.fps });
    shots.push(...planned.shots);
    problems.push(...planned.problems);
  }
  shots.sort((left, right) => left.startFrame - right.startFrame);
  return { version: NARRATED_CAMERA_PLAN_VERSION, shots, problems };
}

/** generation manifest に残す見た目の記録（台本の字は残さない）。 */
export function narratedVisualManifestFields({ config, subtitleLayer, cameraPlan = null }) {
  return {
    subtitles: narratedSubtitleManifestEntry(subtitleLayer, config.subtitles),
    ...(cameraPlan ? { camera: narratedCameraManifestEntry(cameraPlan, config.camera) } : {}),
  };
}

/**
 * 完成 MP4 を測る見た目の監査（監査 id → 判定）。
 * - burnedSubtitlesMeasured: Pack が焼き込み字幕を宣言したら、全部の頁を MP4 のフレームで測る。
 *   宣言していなければ、焼き込みの層を描いていない（MP4 には字幕のトラックだけがある）ことを確かめる
 */
export async function narratedVisualAuditChecks({ ffmpeg, videoPath, config, subtitleLayer, renderGraphs = {}, cameraPlan = null }) {
  const checks = {};
  // カメラ: 計画した全部のショットを、完成 MP4 のフレームから推定した拡大と移動で計画と比べる（字幕の範囲は外す）。
  if (!cameraPlan || cameraPlan.problems.length > 0) {
    checks[NARRATED_CAMERA_AUDIT_ID] = check(false, `camera plan unavailable: ${(cameraPlan?.problems || ["missing"]).join(", ")}`);
  } else if (cameraPlan.shots.length === 0) {
    checks[NARRATED_CAMERA_AUDIT_ID] = check(false, "no image shot was planned for the camera");
  } else {
    const measured = await measureNarratedCameraMotion({
      ffmpeg,
      videoPath,
      shots: cameraPlan.shots,
      camera: config.camera,
      render: config.render,
      exclude: [subtitleExclusionRegion(subtitleLayer, config.subtitles)].filter(Boolean),
    });
    const moves = [...new Set(cameraPlan.shots.map((shot) => shot.move))].join(", ");
    checks[NARRATED_CAMERA_AUDIT_ID] = check(
      measured.pass,
      measured.pass
        ? `${measured.shotCount} camera shots (${moves}) measured on the MP4 frames match their planned zoom and pan in every section and across every speaker cut of the same image (no stop, reversal or restart) and stay within the declared speeds`
        : `camera motion differs from the plan on ${measured.failedShotIds.length}/${measured.shotCount} shots: ${measured.problems.slice(0, 12).join(", ")}`,
      { measurement: measured },
    );
  }
  if (config?.subtitles?.burnIn) {
    if (!subtitleLayer) {
      checks[NARRATED_SUBTITLE_AUDIT_ID] = check(false, "Channel Pack declares burned-in subtitles but no subtitle layer was rendered");
    } else {
      const measured = await measureNarratedBurnedSubtitles({ ffmpeg, videoPath, overlay: subtitleLayer, config: config.subtitles, fps: config.render.fps });
      checks[NARRATED_SUBTITLE_AUDIT_ID] = check(
        measured.pass,
        measured.pass
          ? `${measured.cueCount} burned subtitle pages observed in the MP4 frames at their planned frames and positions inside the safe area (minimum fill match ${measured.minimumFillMatch}, minimum luma contrast ${measured.minimumContrast}); none shows before its start or after its end`
          : `burned subtitles failed on ${measured.failedCueIds.length}/${measured.cueCount} pages: ${measured.problems.join(", ")}`,
        { measurement: { ...measured, cues: measured.cues.map(({ id, segmentId, startFrame, endFrame, pass, problems, inkBox, metrics }) => ({ id, segmentId, startFrame, endFrame, pass, problems, inkBox, metrics })) } },
      );
    }
  } else {
    const burned = Object.values(renderGraphs || {}).some((graph) => /subtitlelayer/u.test(String(graph?.filterGraph || "")));
    checks[NARRATED_SUBTITLE_AUDIT_ID] = check(
      !subtitleLayer && !burned,
      !subtitleLayer && !burned
        ? "Channel Pack does not declare burned-in subtitles; no subtitle layer was burned (the MP4 carries the soft subtitle track only)"
        : "a subtitle layer was burned although the Channel Pack does not declare burned-in subtitles",
    );
  }
  return checks;
}
