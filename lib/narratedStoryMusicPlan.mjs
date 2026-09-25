/**
 * ナレーション物語の BGM の区分割り当て（ジャンル層）。
 *
 * 以前は Channel Pack の music.prompt で1曲を生成し、番組全体で鳴らし続けていた。運営者が用意した
 * 曲を区分（場面の役割）ごとに当てる規則は、運営者の私有側の計画スクリプトにしか無かった。
 *
 * ここでは Pack の `musicPlan` で
 *   - 区分（sections[].id）ごとの曲の出どころ: 運営者が用意した曲（operator-file、Pack 内のファイル）／
 *     生成（generate、Pack の music adapter で有料生成）／未受領（pending）
 *   - 区分の置き方の規則: 番組の最初だけ（position: first）・最後だけ（last）・何ブロックまで（maxBlocks、
 *     山場を1か所に絞るなど）・必ず使う（required）
 * を宣言し、台本の各場面（台本パッケージの story[].musicSection、無ければ defaultSection）から
 * 区分のブロックを作って曲を割り当てる。
 *
 * 使う区分の曲が未受領（pending・Pack にファイルが無い）なら有料生成の前に止める。置き方の規則に
 * 反する台本も止める。区分名・曲・プロンプトはチャンネル固有なので Pack が持ち、ここには書かない。
 * 感想パートの曲は従来どおり bookends.review.music（この計画は本編の区間だけを扱う）。
 *
 * 区分の切り替えは短い等パワーの重ね（afade qsin 同士を amix で足す）で作る。acrossfade は番組全体の
 * 監査（noWholeProgramAcrossfade）が禁じているので使わない。
 */

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { packRelativePath } from "./narratedStoryBookends.mjs";

const execFile = promisify(execFileCallback);

export const NARRATED_MUSIC_PLAN_VERSION = "buzzassist-narrated-story-music-plan-v1";
export const NARRATED_MUSIC_PLAN_FIELDS = Object.freeze({
  top: Object.freeze(["defaultSection", "crossfadeSeconds", "sections"]),
  section: Object.freeze(["id", "position", "maxBlocks", "required", "source", "gain"]),
  source: Object.freeze(["kind", "file", "prompt", "note"]),
});
const SOURCE_KINDS = Object.freeze(["operator-file", "generate", "pending"]);
const POSITIONS = Object.freeze(["any", "first", "last"]);
const SECTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SAMPLE_RATE = 48_000;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const DISABLED = Object.freeze({ enabled: false, sections: [], defaultSection: "", crossfadeSeconds: 1.5 });

/**
 * narrated-story.json の `musicPlan`（任意）を読む。形の誤りは blocker。運営者の曲のファイルは Pack の
 * 中の相対 path だけを受け、実在は `available` として持つ（使う区分だけが未受領で止める。使わない区分の
 * 曲がまだ無いことは止める理由にしない）。
 */
export async function normalizeNarratedMusicPlanConfig(source, { channelPackDir = "" } = {}) {
  if (source === undefined || source === null) return { config: { ...DISABLED, sections: [] }, blockers: [] };
  if (!plainObject(source)) return { config: { ...DISABLED, sections: [] }, blockers: ["musicPlan"] };
  const blockers = [];
  for (const key of Object.keys(source)) if (!NARRATED_MUSIC_PLAN_FIELDS.top.includes(key)) blockers.push(`musicPlan.${key}-unknown`);
  let crossfadeSeconds = 1.5;
  if (source.crossfadeSeconds !== undefined) {
    const value = Number(source.crossfadeSeconds);
    if (typeof source.crossfadeSeconds !== "number" || !Number.isFinite(value) || value < 0 || value > 5) blockers.push("musicPlan.crossfadeSeconds");
    else crossfadeSeconds = value;
  }
  const sections = [];
  const ids = new Set();
  if (!Array.isArray(source.sections) || source.sections.length === 0) blockers.push("musicPlan.sections");
  else {
    for (const [index, entry] of source.sections.entries()) {
      const at = `musicPlan.sections[${index}]`;
      if (!plainObject(entry)) { blockers.push(at); continue; }
      for (const key of Object.keys(entry)) if (!NARRATED_MUSIC_PLAN_FIELDS.section.includes(key)) blockers.push(`${at}.${key}-unknown`);
      const id = nonEmpty(entry.id);
      if (!SECTION_ID.test(id)) { blockers.push(`${at}.id`); continue; }
      if (ids.has(id)) { blockers.push(`musicPlan.sections.${id}-duplicated`); continue; }
      ids.add(id);
      const label = `musicPlan.sections.${id}`;
      const position = entry.position === undefined ? "any" : nonEmpty(entry.position);
      if (!POSITIONS.includes(position)) blockers.push(`${label}.position`);
      let maxBlocks = null;
      if (entry.maxBlocks !== undefined) {
        if (!Number.isInteger(entry.maxBlocks) || entry.maxBlocks < 1) blockers.push(`${label}.maxBlocks`);
        else maxBlocks = entry.maxBlocks;
      }
      if (entry.required !== undefined && typeof entry.required !== "boolean") blockers.push(`${label}.required`);
      let gain = 1;
      if (entry.gain !== undefined) {
        if (typeof entry.gain !== "number" || !Number.isFinite(entry.gain) || entry.gain < 0.05 || entry.gain > 4) blockers.push(`${label}.gain`);
        else gain = entry.gain;
      }
      const sourceEntry = entry.source;
      let track = null;
      if (!plainObject(sourceEntry)) blockers.push(`${label}.source`);
      else {
        for (const key of Object.keys(sourceEntry)) if (!NARRATED_MUSIC_PLAN_FIELDS.source.includes(key)) blockers.push(`${label}.source.${key}-unknown`);
        const kind = nonEmpty(sourceEntry.kind);
        if (!SOURCE_KINDS.includes(kind)) blockers.push(`${label}.source.kind`);
        else if (kind === "operator-file") {
          const parts = packRelativePath(sourceEntry.file);
          if (!parts) blockers.push(`${label}.source.file`);
          else {
            const path = join(resolve(String(channelPackDir || "")), ...parts);
            let available = false;
            try {
              const info = await lstat(path);
              available = info.isFile() && !info.isSymbolicLink() && info.size > 0;
            } catch {
              available = false;
            }
            track = { kind, file: parts.join("/"), path, available };
          }
        } else if (kind === "generate") {
          const prompt = nonEmpty(sourceEntry.prompt);
          if (!prompt) blockers.push(`${label}.source.prompt`);
          track = { kind, prompt, available: Boolean(prompt) };
        } else {
          track = { kind, available: false };
        }
      }
      sections.push({ id, position: POSITIONS.includes(position) ? position : "any", maxBlocks, required: entry.required === true, gain, track });
    }
  }
  const defaultSection = source.defaultSection === undefined ? "" : nonEmpty(source.defaultSection);
  if (source.defaultSection !== undefined && !ids.has(defaultSection)) blockers.push("musicPlan.defaultSection");
  return { config: { enabled: true, sections, defaultSection, crossfadeSeconds }, blockers: [...new Set(blockers)] };
}

/**
 * 本編の segment に区分を当て、連続する同じ区分をブロックにまとめ、置き方の規則と曲の受領を検査する。
 * issues が空でなければ有料生成の前に止める。
 */
export function planNarratedMusicBlocks(storySegments = [], musicPlan = DISABLED) {
  if (!musicPlan?.enabled) return { blocks: [], issues: [] };
  const byId = new Map(musicPlan.sections.map((section) => [section.id, section]));
  const issues = new Set();
  const blocks = [];
  for (const segment of storySegments) {
    const sectionId = nonEmpty(segment.musicSection) || musicPlan.defaultSection;
    if (!sectionId) { issues.add("music-section-required"); continue; }
    if (!byId.has(sectionId)) { issues.add(`music-section-undeclared:${sectionId}`); continue; }
    const last = blocks.at(-1);
    if (last && last.sectionId === sectionId) last.segmentIds.push(segment.id);
    else blocks.push({ index: blocks.length, sectionId, segmentIds: [segment.id] });
  }
  for (const section of musicPlan.sections) {
    const used = blocks.filter((block) => block.sectionId === section.id);
    if (used.length === 0) {
      if (section.required) issues.add(`music-section-required-unused:${section.id}`);
      continue;
    }
    if (section.position === "first" && (used.length !== 1 || used[0].index !== 0)) issues.add(`music-section-placement:${section.id}:first`);
    if (section.position === "last" && (used.length !== 1 || used[0].index !== blocks.length - 1)) issues.add(`music-section-placement:${section.id}:last`);
    if (section.maxBlocks !== null && used.length > section.maxBlocks) issues.add(`music-section-placement:${section.id}:max-blocks-${section.maxBlocks}`);
    if (!section.track) continue;
    if (section.track.kind === "pending") issues.add(`music-section-pending:${section.id}`);
    else if (section.track.kind === "operator-file" && !section.track.available) issues.add(`music-section-file-missing:${section.id}`);
  }
  return { blocks, issues: [...issues].sort() };
}

async function runRuntime(spec, args) {
  return execFile(spec.command, [...(spec.args || []), ...args], { timeout: 10 * 60_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
}

async function fileSha256(path) {
  return sha256(await readFile(path));
}

/**
 * 区分ごとの曲をつないだ本編の BGM（倍率 1 の素の曲。番組の gain は既存の BGM stem が掛ける）を作る。
 *
 * - `segments` は時刻の付いた本編の segment（番組時刻）。`bedStartSeconds` は BGM stem が本編の曲を
 *   鳴らし始める番組時刻（bookends なら OP→本編の転換の始まり、無ければ 0）
 * - 生成の区分は `acquireTrack(spec, outputPath)`（Core の Media Job 経路）で取る。受領記録を返す
 * - ブロックの境目は crossfadeSeconds の等パワーの重ね。最初のブロックは 0 から、最後は lengthSeconds まで
 */
export async function buildNarratedMusicBed({
  ffmpeg,
  musicPlan,
  blocks,
  segments,
  bedStartSeconds = 0,
  lengthSeconds,
  musicAdapter,
  scriptHash = "",
  acquireTrack,
  workDir,
  outputPath,
}) {
  if (!musicPlan?.enabled || !Array.isArray(blocks) || blocks.length === 0) throw new Error("buildNarratedMusicBed requires a planned music block list.");
  if (!(lengthSeconds > 0)) throw new Error("buildNarratedMusicBed requires a positive bed length.");
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  const timed = blocks.map((block, index) => {
    const first = segmentById.get(block.segmentIds[0]);
    if (!first) throw new Error(`music block ${block.index} refers to an unknown segment.`);
    return { ...block, startSeconds: index === 0 ? 0 : Math.max(0, first.startSeconds - bedStartSeconds) };
  });
  timed.forEach((block, index) => {
    block.endSeconds = index === timed.length - 1 ? lengthSeconds : timed[index + 1].startSeconds;
  });
  const sections = new Map(musicPlan.sections.map((section) => [section.id, section]));
  const tracks = new Map();
  const receipts = [];
  for (const sectionId of [...new Set(timed.map((block) => block.sectionId))]) {
    const section = sections.get(sectionId);
    if (section.track.kind === "operator-file") {
      if (!section.track.available) throw new Error(`music-section-file-missing:${sectionId}`);
      tracks.set(sectionId, { path: section.track.path, source: "operator-file", sha256: await fileSha256(section.track.path) });
      continue;
    }
    if (section.track.kind !== "generate") throw new Error(`music-section-pending:${sectionId}`);
    const longest = Math.max(...timed.filter((block) => block.sectionId === sectionId).map((block) => block.endSeconds - block.startSeconds));
    const durationSeconds = Math.min(600, Math.ceil(longest + musicPlan.crossfadeSeconds));
    const acquired = await acquireTrack({
      kind: "music.generation",
      provider: musicAdapter.provider,
      model: musicAdapter.model,
      adapterVersion: musicAdapter.adapterVersion,
      voiceId: "",
      input: { prompt: section.track.prompt, durationSeconds, scriptHash, section: sectionId },
      output: { format: "wav", sampleRate: SAMPLE_RATE, channels: 2 },
      reservation: { unit: "seconds", estimatedSeconds: durationSeconds },
    }, join(workDir, `section-${sectionId}.wav`));
    receipts.push(acquired.receipt);
    tracks.set(sectionId, { path: acquired.path, source: "generate", sha256: acquired.receipt?.artifact?.sha256 || await fileSha256(acquired.path) });
  }
  const totalSamples = Math.round(lengthSeconds * SAMPLE_RATE);
  const crossfade = musicPlan.crossfadeSeconds;
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  const filters = [];
  timed.forEach((block, index) => {
    const track = tracks.get(block.sectionId);
    args.push("-stream_loop", "-1", "-i", track.path);
    const half = crossfade / 2;
    const start = index === 0 ? 0 : Math.max(0, block.startSeconds - half);
    const end = index === timed.length - 1 ? lengthSeconds : Math.min(lengthSeconds, block.endSeconds + half);
    const pieceSeconds = Math.max(0.01, end - start);
    const fade = Math.min(crossfade, pieceSeconds / 2);
    const pieceSamples = Math.max(1, Math.round(pieceSeconds * SAMPLE_RATE));
    const gain = sections.get(block.sectionId).gain;
    const chain = [
      `[${index}:a]aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo`,
      `atrim=end_sample=${pieceSamples}`,
      `apad=whole_len=${pieceSamples}`,
      `volume=${gain.toFixed(5)}`,
    ];
    if (index > 0 && fade > 0) chain.push(`afade=t=in:st=0:d=${fade.toFixed(6)}:curve=qsin`);
    if (index < timed.length - 1 && fade > 0) chain.push(`afade=t=out:st=${(pieceSeconds - fade).toFixed(6)}:d=${fade.toFixed(6)}:curve=qsin`);
    const delay = Math.round(start * SAMPLE_RATE);
    if (delay > 0) chain.push(`adelay=delays=${delay}S:all=1`);
    chain.push(`apad=whole_len=${totalSamples}`, `atrim=end_sample=${totalSamples}[m${index}]`);
    filters.push(chain.join(","));
    block.pieceStartSeconds = start;
    block.pieceEndSeconds = start + pieceSeconds;
  });
  filters.push(timed.length === 1
    ? "[m0]anull[bed]"
    : `${timed.map((_, index) => `[m${index}]`).join("")}amix=inputs=${timed.length}:duration=longest:dropout_transition=0:normalize=0[bed]`);
  const filterGraph = filters.join(";");
  await runRuntime(ffmpeg, [...args, "-filter_complex", filterGraph, "-map", "[bed]", "-c:a", "pcm_s16le", outputPath]);
  return {
    path: outputPath,
    receipts,
    graph: { filterGraph, inputCount: timed.length, outputMap: "[bed]" },
    manifest: {
      version: NARRATED_MUSIC_PLAN_VERSION,
      crossfadeSeconds: crossfade,
      bedStartSeconds,
      lengthSeconds,
      blocks: timed.map((block) => ({
        index: block.index,
        sectionId: block.sectionId,
        segmentIds: [...block.segmentIds],
        startSeconds: block.startSeconds,
        endSeconds: block.endSeconds,
        source: tracks.get(block.sectionId).source,
        trackSha256: tracks.get(block.sectionId).sha256,
      })),
      filterGraphSha256: sha256(filterGraph),
    },
  };
}

/**
 * 本編の曲が BGM stem のどこから鳴るか（番組時刻）と、つないだ曲の長さ。bookends の番組では
 * BGM stem（makeBookendBedStem）が OP→本編の転換の始まりから本編の曲を鳴らすので、そこを 0 にする。
 */
export function narratedMusicBedWindow(bookendPlan = null, totalSeconds = 0) {
  if (!bookendPlan) return { bedStartSeconds: 0, lengthSeconds: totalSeconds };
  const opening = (bookendPlan.boundaries || []).find((boundary) => boundary.id === "openingToStory");
  const rate = Number(bookendPlan.sampleRate) || SAMPLE_RATE;
  const bedStartSeconds = opening ? opening.effectStartSample / rate : 0;
  return { bedStartSeconds, lengthSeconds: Math.max(0.01, bookendPlan.totalSeconds - bedStartSeconds) };
}
