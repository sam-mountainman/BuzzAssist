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

import { execFile as execFileCallback } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { loadFontMetrics } from "./fontMetrics.mjs";
import { EPISODE_OPENING_VIDEO_SLOT, segmentFramePlan } from "./narratedStoryBookends.mjs";
import {
  checkOperatorVideoImport,
  materializeOperatorVideos,
  operatorVideoFileSha256,
  readOperatorVideoManifest,
} from "./operatorVideoImport.mjs";
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

const execFile = promisify(execFileCallback);

/** 回ごとの OP 映像の来歴と、完成 MP4 の OP がその映像であることの監査の id。 */
export const NARRATED_OPENING_AUDIT_ID = "episodeOpeningProvenance";

/**
 * 回ごとの OP 映像の MP4 のフレームと、取り込んだ動画を同じ合わせ方で読んだフレームの差の上限
 * （64x36 の輝度の平均絶対差、フレームごとの最大）。test/narratedStoryEpisodeOpening.test.mjs の fixture
 * （30fps の動く試験映像を 24fps の番組へ入れる）で、基準版 0.4（再エンコードの差）、別の動画に差し替えた版 91.6
 * （2026-09-25、ffmpeg 7.1.1）。
 */
export const OPENING_FRAME_MAX_DIFF = 8;

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
 * Pack の宣言から、運営者の動画の取り込みの枠の決まりを作る。枠は Pack が使うと宣言したものだけ。
 * - episode-opening: bookends.opening.kind が episode-video のとき（必須）
 */
export function narratedOperatorVideoSlots(config) {
  const slots = {};
  const { width, height } = config.render;
  const opening = config?.bookends?.enabled ? config.bookends.opening : null;
  if (opening?.kind === "episode-video") {
    slots[EPISODE_OPENING_VIDEO_SLOT] = {
      required: true,
      minSeconds: opening.minSeconds,
      maxSeconds: opening.maxSeconds,
      aspect: width / height,
      aspectTolerance: 0.02,
      requireAudio: opening.useEmbeddedAudio === true,
    };
  }
  return slots;
}

/**
 * 運営者の動画の取り込み（lib/operatorVideoImport.mjs）を、有料生成の前に読んで検査し、Job の作業フォルダへ
 * 写す。materialize が false なら検査だけ（plan-only）。
 * 戻り値: issues（止める理由）、inputs（入力の指紋に入れる manifest と digest）、clips（枠 → 写しの path）、
 * publicRecord（生成記録へ出す sha256 と数値だけ）。
 */
export async function prepareNarratedOperatorVideos({ config, manifestPath = "", ffprobe, runDir = "", materialize = true, now = () => new Date().toISOString() }) {
  const slots = narratedOperatorVideoSlots(config);
  const needed = Object.keys(slots).length > 0;
  const empty = { issues: [], inputs: null, clips: new Map(), publicRecord: null };
  if (!needed && !String(manifestPath || "").trim()) return empty;
  if (!needed) return { ...empty, issues: ["operator-video-manifest-unexpected"] };
  if (!String(manifestPath || "").trim()) return { ...empty, issues: ["operator-video-manifest-required"] };
  const manifest = await readOperatorVideoManifest({ manifestPath, ffprobe, now: new Date(now()) });
  const inputs = { manifestSha256: manifest.manifestSha256 || null, digest: manifest.digest || null };
  const checked = checkOperatorVideoImport({ manifest, slots });
  if (!checked.ok || !materialize) return { ...empty, issues: checked.issues, inputs };
  const materialized = await materializeOperatorVideos({
    manifest,
    outputDir: join(runDir, "media", "operator-videos"),
    // 私有の Job フォルダ（会話の URL・注記の本文・プロンプトの写しはここにだけ置く）。
    privateDir: join(runDir, "operator-videos"),
    now,
  });
  if (!materialized.ok) return { ...empty, issues: materialized.issues, inputs };
  return { issues: [], inputs, clips: materialized.clips, publicRecord: materialized.publicRecord };
}

function fitGraph(render, backgroundColor) {
  const pad = backgroundColor ? `0x${backgroundColor.slice(1)}` : "black";
  return `scale=${render.width}:${render.height}:force_original_aspect_ratio=decrease,pad=${render.width}:${render.height}:(ow-iw)/2:(oh-ih)/2:${pad},setsar=1,fps=${render.fps}`;
}

async function grayFrames(ffmpeg, file, graph, count) {
  const { stdout } = await execFile(ffmpeg.command, [...(ffmpeg.args || []),
    "-hide_banner", "-loglevel", "error", "-i", file, "-frames:v", String(count), "-vf", `${graph}scale=64:36:flags=area,format=gray`, "-f", "rawvideo", "-",
  ], { encoding: "buffer", timeout: 10 * 60_000, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  const size = 64 * 36;
  const frames = [];
  for (let offset = 0; offset + size <= stdout.length; offset += size) frames.push(stdout.subarray(offset, offset + size));
  return frames;
}

/**
 * 回ごとの OP 映像の監査。Pack が episode-video を宣言したら:
 * - 取り込みの記録（sha256・経路・プロンプトの sha256）があり、描いた写しを読み直した sha256 が元の動画と同じ
 * - 尺が Pack の範囲の中で、番組の OP の部のフレーム数が映像の尺から決まる数と同じ
 * - 完成 MP4 の OP の部の全フレームが、取り込んだ動画を同じ合わせ方で読んだフレームと同じ絵（別の動画ではない）
 * 宣言していなければ、回ごとの OP 映像を取り込んでいないこと（OP が2つにならない）を確かめる。
 */
export async function narratedEpisodeOpeningCheck({ ffmpeg, videoPath, config, operatorVideos, bookendPlan }) {
  const opening = config?.bookends?.enabled ? config.bookends.opening : null;
  const clip = operatorVideos?.clips?.get(EPISODE_OPENING_VIDEO_SLOT) || null;
  if (opening?.kind !== "episode-video") {
    return check(!clip, clip
      ? "a per-episode opening video was imported although the Channel Pack does not declare an episode-video opening"
      : `Channel Pack declares ${opening ? `a ${opening.kind} opening` : "no opening"}; no per-episode opening video was imported (one opening at most)`);
  }
  const problems = [];
  if (!clip) return check(false, "Channel Pack declares an episode-video opening but no operator video was imported for it");
  const record = operatorVideos.publicRecord?.clips?.find((entry) => entry.slot === EPISODE_OPENING_VIDEO_SLOT) || null;
  if (!record) problems.push("opening-provenance-record-missing");
  let copySha = "";
  try { copySha = await operatorVideoFileSha256(clip.path); } catch { copySha = ""; }
  if (!copySha || copySha !== record?.source?.sha256) problems.push("opening-copy-sha256-mismatch");
  if (record && record.route !== "recorded" && !record.promptSha256) problems.push("opening-prompt-provenance-missing");
  const duration = clip.probe?.durationSeconds || 0;
  if (duration < opening.minSeconds || duration > opening.maxSeconds) problems.push("opening-duration-outside-declared-range");
  const part = bookendPlan?.parts?.find((entry) => entry.id === "opening") || null;
  const fps = config.render.fps;
  const expectedFrames = Math.floor(duration * fps + 1e-6);
  if (!part || part.frames !== expectedFrames) problems.push("opening-part-frames-differ-from-video");
  let maxDiff = null;
  if (part && part.frames > 0) {
    const [program, source] = await Promise.all([
      grayFrames(ffmpeg, videoPath, "", part.frames),
      grayFrames(ffmpeg, clip.path, `${fitGraph(config.render, opening.backgroundColor)},`, part.frames),
    ]);
    if (program.length < part.frames || source.length < part.frames) problems.push("opening-frames-unavailable");
    else {
      maxDiff = 0;
      for (let frame = 0; frame < part.frames; frame += 1) {
        let sum = 0;
        for (let index = 0; index < program[frame].length; index += 1) sum += Math.abs(program[frame][index] - source[frame][index]);
        maxDiff = Math.max(maxDiff, sum / program[frame].length);
      }
      if (maxDiff > OPENING_FRAME_MAX_DIFF) problems.push("opening-frames-differ-from-imported-video");
    }
  }
  return check(
    problems.length === 0,
    problems.length === 0
      ? `per-episode opening video (${record.route}, ${duration.toFixed(3)}s, ${clip.probe.width}x${clip.probe.height}) is SHA-256-bound to its import record and every opening frame of the MP4 matches it (max frame diff ${maxDiff?.toFixed(2)})`
      : `per-episode opening failed: ${problems.join(", ")}`,
    { problems, maxFrameDiff: maxDiff === null ? null : Math.round(maxDiff * 100) / 100, frames: part?.frames ?? null, record },
  );
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
export function narratedVisualManifestFields({ config, subtitleLayer, cameraPlan = null, operatorVideos = null }) {
  return {
    subtitles: narratedSubtitleManifestEntry(subtitleLayer, config.subtitles),
    ...(cameraPlan ? { camera: narratedCameraManifestEntry(cameraPlan, config.camera) } : {}),
    // 運営者の動画の来歴（sha256・経路・尺と寸法だけ。会話の URL などの本文は私有の Job フォルダにだけある）。
    ...(operatorVideos?.publicRecord ? { operatorVideos: operatorVideos.publicRecord } : {}),
  };
}

/**
 * 完成 MP4 を測る見た目の監査（監査 id → 判定）。
 * - burnedSubtitlesMeasured: Pack が焼き込み字幕を宣言したら、全部の頁を MP4 のフレームで測る。
 *   宣言していなければ、焼き込みの層を描いていない（MP4 には字幕のトラックだけがある）ことを確かめる
 */
export async function narratedVisualAuditChecks({ ffmpeg, videoPath, config, subtitleLayer, renderGraphs = {}, cameraPlan = null, operatorVideos = null, bookendPlan = null }) {
  const checks = {};
  checks[NARRATED_OPENING_AUDIT_ID] = await narratedEpisodeOpeningCheck({ ffmpeg, videoPath, config, operatorVideos, bookendPlan });
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
