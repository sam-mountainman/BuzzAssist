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
  NARRATED_SUBTITLE_AUDIT_ID,
  layoutNarratedSubtitles,
  measureNarratedBurnedSubtitles,
  narratedSubtitleManifestEntry,
  normalizeNarratedSubtitlesConfig,
  planNarratedSubtitleCues,
  renderNarratedSubtitleOverlay,
  resolveNarratedSubtitleMedia,
} from "./narratedStorySubtitles.mjs";

export { NARRATED_SUBTITLE_AUDIT_ID };

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
  let subtitleConfig = subtitles.config;
  if (subtitleConfig.burnIn && subtitles.blockers.length === 0) {
    const resolved = await resolveNarratedSubtitleMedia(subtitleConfig, channelPackDir);
    blockers.push(...resolved.blockers);
    subtitleConfig = { ...subtitleConfig, fontPath: resolved.media.fontFile || "" };
  }
  return { config: { subtitles: subtitleConfig }, blockers: [...new Set(blockers)] };
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
  if (config?.subtitles?.burnIn) {
    const metrics = await subtitleMetrics(config);
    if (!metrics) issues.push("subtitles.fontFile-missing");
    else issues.push(...layoutNarratedSubtitles({ segments, config: config.subtitles, metrics }).issues);
  }
  return { issues: [...new Set(issues)] };
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
        id: segment.id,
        text: segment.text,
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
      id: segment.id,
      text: segment.text,
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

/** generation manifest に残す見た目の記録（台本の字は残さない）。 */
export function narratedVisualManifestFields({ config, subtitleLayer }) {
  return {
    subtitles: narratedSubtitleManifestEntry(subtitleLayer, config.subtitles),
  };
}

/**
 * 完成 MP4 を測る見た目の監査（監査 id → 判定）。
 * - burnedSubtitlesMeasured: Pack が焼き込み字幕を宣言したら、全部の頁を MP4 のフレームで測る。
 *   宣言していなければ、焼き込みの層を描いていない（MP4 には字幕のトラックだけがある）ことを確かめる
 */
export async function narratedVisualAuditChecks({ ffmpeg, videoPath, config, subtitleLayer, renderGraphs = {} }) {
  const checks = {};
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
