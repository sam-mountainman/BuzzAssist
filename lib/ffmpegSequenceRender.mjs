/**
 * 入力の多い FFmpeg の工程を、コマンド行の上限を越えない塊に分けて描く（共有層。ジャンルに依らない）。
 *
 * 場面ごとに `-loop 1 -i <画>`、文ごとに `-i <声>` を並べる工程は、台本が長いほどコマンド行が伸び、
 * Windows のコマンド行の上限（32,767 字、lib/ffmpegFilterArgs.mjs）に当たる。filter graph はファイルで
 * 渡せるが、入力の path は渡せない。そこで
 *
 * - 映像: 区間（unit）の列を、組み立てたコマンド行を測りながら塊（chunk）に分けて描き、塊を concat
 *   demuxer（一覧のファイル）で stream copy してつなぐ。塊の中の区間は concat（cut）か xfade の fade
 *   （crossfade）でつなぐ。crossfade の境目で塊を切ることになったら、手前の区間を2つに分けて
 *   （unit.split）、塊の境目を転換の外へ出す。
 * - 音声: 声のファイルの列を同じく塊に分けて 48kHz の PCM に揃えてつなぎ、塊の WAV を concat demuxer で
 *   つなぐ。
 * - 音の重ね（mixAudioPieces。BGM の区分の曲をつなぐ工程）: 時刻の決まった断片の列を塊に分け、塊ごとに
 *   その塊が鳴る区間だけを 32bit float の WAV に描き、塊の WAV を元の位置に置いて amix で足す。
 *
 * 音声の2つの工程は、塊の分け方（groupWithinCommandLine）を共有する。
 *
 * 1つの塊で収まるときは、今までどおり1回の呼び出しで描く（graph の形も同じ）。塊の境目は入力の path の
 * 長さで決まるので端末ごとに変わり得るが、描く絵と音は同じ（stream copy のつなぎはフレームも標本も
 * 足し引きしない。2026-09-26 実測: 37+41+29 フレームの塊が 107 フレームのまま、全フレームが元と一致）。
 */

import { execFile as execFileCallback } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { promisify } from "node:util";

import {
  FFMPEG_COMMAND_LINE_BUDGET,
  ffmpegCommandLineLength,
  filterComplexPlan,
  writeFilterComplexPlan,
} from "./ffmpegFilterArgs.mjs";

const execFile = promisify(execFileCallback);

export const FFMPEG_SEQUENCE_RENDER_VERSION = "buzzassist-ffmpeg-sequence-render-v1";

async function runFfmpeg(ffmpeg, args, { timeout = 30 * 60_000 } = {}) {
  if (!ffmpeg?.command) throw new Error("A resolved ffmpeg executable is required.");
  return execFile(ffmpeg.command, [...(ffmpeg.args || []), ...args], { timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
}

function seconds(frames, fps) {
  return (frames / fps).toFixed(6);
}

function inputCount(args) {
  return args.filter((token) => token === "-i").length;
}

/** 既定の塊の置き場（出力の隣の `<名前>-chunks/`）。 */
function defaultWorkDir(outputPath) {
  return join(dirname(outputPath), `${basename(outputPath, extname(outputPath))}-chunks`);
}

/**
 * 1つの塊の graph。units[k].chain(inputOffset, label) は [label] に units[k].frames フレームを出す鎖。
 * joins[k] は units[k] と units[k+1] の間: { type: "cut" } は concat、{ type: "crossfade", frames } は
 * xfade=transition=fade（F フレームの間、出る側から入る側へ線形に混ぜる。長さは足し引きしない側で数える:
 * 塊の長さ = 区間の長さの和 − crossfade のフレームの和）。最後の出力は必ず [video]。cut だけの塊は
 * `concat=n=K:v=1:a=0[video]`（K=1 でも同じ形）。
 */
export function sequenceChunkGraph(units, joins, fps) {
  if (units.length === 0) throw new Error("sequence chunk needs at least one unit");
  if (joins.length !== units.length - 1) throw new Error("sequence chunk needs one join between each pair of units");
  const inputs = [];
  const chains = [];
  let offset = 0;
  units.forEach((unit, index) => {
    chains.push(unit.chain(offset, `u${index}`));
    inputs.push(...unit.inputs);
    offset += inputCount(unit.inputs);
  });
  const runs = [[0]];
  joins.forEach((join, index) => {
    if (join?.type === "crossfade") runs.push([index + 1]);
    else if (join?.type === "cut") runs.at(-1).push(index + 1);
    else throw new Error(`unknown sequence join: ${join?.type}`);
  });
  const runFrames = runs.map((run) => run.reduce((sum, index) => sum + units[index].frames, 0));
  // xfade へ入れる前に時間の単位を 1/fps に揃える。concat の出力は百万分の1秒の単位で、xfade の混ぜ具合
  // （フレームの時刻と offset の差）が丸めでわずかにずれ、塊の分け方で混ぜた画素が1段違った
  // （2026-09-26 実測: 1回で描いた版との差が重なりのフレームだけ 0.57）。
  const operations = runs.map((run, index) => (runs.length === 1
    ? `${run.map((unit) => `[u${unit}]`).join("")}concat=n=${run.length}:v=1:a=0[video]`
    : `${run.map((unit) => `[u${unit}]`).join("")}concat=n=${run.length}:v=1:a=0,settb=1/${fps}[run${index}]`));
  let accumulated = "run0";
  let frames = runFrames[0];
  for (let index = 1; index < runs.length; index += 1) {
    const join = joins[runs[index][0] - 1];
    if (!Number.isInteger(join.frames) || join.frames < 2) throw new Error("crossfade join needs at least 2 frames");
    if (join.frames > frames || join.frames > runFrames[index]) throw new Error("crossfade is longer than the units it joins");
    const output = index === runs.length - 1 ? "video" : `x${index}`;
    operations.push(`[${accumulated}][run${index}]xfade=transition=fade:duration=${seconds(join.frames, fps)}:offset=${seconds(frames - join.frames, fps)}[${output}]`);
    frames += runFrames[index] - join.frames;
    accumulated = output;
  }
  return {
    graph: [...chains, ...operations].join(";"),
    inputs,
    frames,
    inputCount: offset,
    crossfades: joins.filter((join) => join.type === "crossfade").map((join) => join.frames),
  };
}

/**
 * 区間の列を、コマンド行が budget を越えない塊に分ける（書き込まない）。区間を前から足していき、足すと越える
 * ところで塊を閉じる。閉じる境目が crossfade なら、手前の区間を split() で2つに分け、後ろ半分を次の塊の
 * 頭に置く（転換は次の塊の中で描く）。
 */
export function planSequenceChunks({ ffmpeg, units, joins, fps, encode, outputPath, workDir, budget = FFMPEG_COMMAND_LINE_BUDGET }) {
  const probePath = [outputPath, join(workDir, "sequence-chunk-00000.mp4")].sort((left, right) => right.length - left.length)[0];
  const measure = (candidate) => {
    const built = sequenceChunkGraph(candidate.units, candidate.joins, fps);
    const graphPlan = filterComplexPlan(ffmpeg, built.graph, workDir);
    const args = ["-hide_banner", "-loglevel", "error", "-y", ...built.inputs, ...graphPlan.args, "-map", "[video]", "-frames:v", String(built.frames), ...encode, probePath];
    return { built, graphPlan, commandLength: ffmpegCommandLineLength(ffmpeg, args) };
  };
  const chunks = [];
  let current = { units: [], joins: [] };
  const close = (chunk) => {
    const measured = measure(chunk);
    if (measured.commandLength > budget) throw new Error(`sequence chunk exceeds the command-line budget (${measured.commandLength} > ${budget})`);
    chunks.push({ ...chunk, ...measured });
  };
  units.forEach((unit, index) => {
    const joinBefore = index > 0 ? joins[index - 1] : null;
    const candidate = current.units.length > 0
      ? { units: [...current.units, unit], joins: [...current.joins, joinBefore] }
      : { units: [unit], joins: [] };
    if (measure(candidate).commandLength <= budget) {
      current = candidate;
      return;
    }
    if (current.units.length === 0) throw new Error("a single sequence unit exceeds the command-line budget");
    if (joinBefore.type === "crossfade") {
      const last = current.units.at(-1);
      if (typeof last.split !== "function") throw new Error("a crossfade falls on a chunk boundary and the unit before it cannot be split");
      const [first, second] = last.split();
      close({ units: [...current.units.slice(0, -1), first], joins: current.joins });
      current = { units: [second, unit], joins: [joinBefore] };
    } else {
      close(current);
      current = { units: [unit], joins: [] };
    }
    if (measure(current).commandLength > budget) throw new Error("sequence units around a chunk boundary exceed the command-line budget");
  });
  close(current);
  return chunks;
}

/**
 * 区間の列を1本の動画に描く。戻り値の graph は監査に渡す証拠（塊ごとの graph・入力の数・フレーム数・
 * 区間の id とつなぎ方・組み立てたコマンド行の長さ）。filterGraph は塊の graph を改行でつないだもの。
 */
export async function renderVideoSequence({ ffmpeg, units, joins = [], fps, outputPath, workDir = "", encode, budget = FFMPEG_COMMAND_LINE_BUDGET, timeout = 30 * 60_000 }) {
  const dir = workDir || defaultWorkDir(outputPath);
  const chunks = planSequenceChunks({ ffmpeg, units, joins, fps, encode, outputPath, workDir: dir, budget });
  const single = chunks.length === 1;
  const paths = chunks.map((_, index) => (single ? outputPath : join(dir, `sequence-chunk-${String(index + 1).padStart(5, "0")}.mp4`)));
  if (!single) await mkdir(dir, { recursive: true });
  const commandLengths = [];
  for (const [index, chunk] of chunks.entries()) {
    await writeFilterComplexPlan(chunk.graphPlan);
    const args = ["-hide_banner", "-loglevel", "error", "-y", ...chunk.built.inputs, ...chunk.graphPlan.args, "-map", "[video]", "-frames:v", String(chunk.built.frames), ...encode, paths[index]];
    commandLengths.push(ffmpegCommandLineLength(ffmpeg, args));
    await runFfmpeg(ffmpeg, args, { timeout });
  }
  const frames = chunks.reduce((sum, chunk) => sum + chunk.built.frames, 0);
  if (!single) {
    const listPath = join(dir, "sequence.ffconcat");
    await writeFile(listPath, `ffconcat version 1.0\n${paths.map((path) => `file '${basename(path)}'\n`).join("")}`, "utf8");
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-map", "0:v:0", "-c", "copy", outputPath];
    commandLengths.push(ffmpegCommandLineLength(ffmpeg, args));
    await runFfmpeg(ffmpeg, args, { timeout });
    await Promise.all(paths.map((path) => rm(path, { force: true })));
  }
  return {
    version: FFMPEG_SEQUENCE_RENDER_VERSION,
    frames,
    assembly: single ? "single" : "concat-demuxer",
    filterGraph: chunks.map((chunk) => chunk.built.graph).join("\n"),
    inputCount: chunks.reduce((sum, chunk) => sum + chunk.built.inputCount, 0),
    chunks: chunks.map((chunk, index) => ({
      filterGraph: chunk.built.graph,
      inputCount: chunk.built.inputCount,
      frames: chunk.built.frames,
      unitIds: chunk.units.map((unit) => unit.id),
      joins: chunk.joins.map((join) => (join.type === "crossfade" ? { type: "crossfade", frames: join.frames } : { type: "cut" })),
      commandLength: commandLengths[index],
    })),
    maxCommandLength: Math.max(...commandLengths),
  };
}

/** 映像の証拠（renderVideoSequence の graph か、塊を持たない旧い形）の塊ごとの graph。 */
export function sequenceEvidenceGraphs(evidence) {
  if (Array.isArray(evidence?.chunks) && evidence.chunks.length > 0) return evidence.chunks.map((chunk) => String(chunk?.filterGraph || ""));
  return [String(evidence?.filterGraph || "")];
}

/**
 * 入力の列を、組み立てたコマンド行が budget を越えない塊に前から分ける（書き込まない）。足すと越えるところで
 * 塊を閉じる。lengthOf(group, index) は、その塊を index 番目の塊として1回で描く呼び出しのコマンド行の長さ。
 * 音声の工程が共有する分け方。
 */
function groupWithinCommandLine(items, lengthOf, budget, what) {
  const groups = [];
  let current = [];
  for (const item of items) {
    if (current.length > 0 && lengthOf([...current, item], groups.length) > budget) {
      groups.push(current);
      current = [];
    }
    current.push(item);
    if (lengthOf(current, groups.length) > budget) throw new Error(`a single ${what} exceeds the command-line budget`);
  }
  groups.push(current);
  return groups;
}

function audioConcatGraph(count, { sampleRate, channelLayout, label }) {
  const inputs = Array.from({ length: count }, (_, index) => `[${index}:a]aresample=${sampleRate},aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=${channelLayout}[a${index}]`).join(";");
  return `${inputs};${Array.from({ length: count }, (_, index) => `[a${index}]`).join("")}concat=n=${count}:v=0:a=1[${label}]`;
}

/**
 * 音声のファイルの列を、48kHz（sampleRate）の PCM に揃えて1本につなぐ。1回の呼び出しで収まれば
 * 今までと同じ graph（入力ごとに aresample と aformat、concat=n=N:v=0:a=1[label]）。収まらなければ塊ごとに
 * 同じ graph で WAV を作り、concat demuxer の stream copy でつなぐ（標本は足し引きしない）。
 */
export async function concatAudioSequence({ ffmpeg, paths, outputPath, workDir = "", sampleRate = 48_000, channelLayout = "mono", label = "voice", budget = FFMPEG_COMMAND_LINE_BUDGET }) {
  if (paths.length === 0) throw new Error("audio sequence needs at least one input");
  const dir = workDir || defaultWorkDir(outputPath);
  const encode = ["-map", `[${label}]`, "-c:a", "pcm_s16le"];
  const commandFor = (list, output) => {
    const args = ["-hide_banner", "-loglevel", "error", "-y"];
    for (const path of list) args.push("-i", path);
    const filterGraph = audioConcatGraph(list.length, { sampleRate, channelLayout, label });
    const graphPlan = filterComplexPlan(ffmpeg, filterGraph, dir);
    args.push(...graphPlan.args, ...encode, output);
    return { args, filterGraph, graphPlan, commandLength: ffmpegCommandLineLength(ffmpeg, args) };
  };
  const probePath = [outputPath, join(dir, "audio-chunk-00000.wav")].sort((left, right) => right.length - left.length)[0];
  const groups = groupWithinCommandLine(paths, (list) => commandFor(list, probePath).commandLength, budget, "audio input");
  const single = groups.length === 1;
  const outputs = groups.map((_, index) => (single ? outputPath : join(dir, `audio-chunk-${String(index + 1).padStart(5, "0")}.wav`)));
  if (!single) await mkdir(dir, { recursive: true });
  const chunks = [];
  for (const [index, group] of groups.entries()) {
    const command = commandFor(group, outputs[index]);
    await writeFilterComplexPlan(command.graphPlan);
    await runFfmpeg(ffmpeg, command.args);
    chunks.push({ filterGraph: command.filterGraph, inputCount: group.length, commandLength: command.commandLength });
  }
  if (single) return { filterGraph: chunks[0].filterGraph, inputCount: paths.length, outputMap: `[${label}]`, maxCommandLength: chunks[0].commandLength };
  const listPath = join(dir, "audio.ffconcat");
  await writeFile(listPath, `ffconcat version 1.0\n${outputs.map((path) => `file '${basename(path)}'\n`).join("")}`, "utf8");
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-map", "0:a:0", "-c", "copy", outputPath];
  await runFfmpeg(ffmpeg, args);
  await Promise.all(outputs.map((path) => rm(path, { force: true })));
  return {
    filterGraph: chunks.map((chunk) => chunk.filterGraph).join("\n"),
    inputCount: paths.length,
    outputMap: `[${label}]`,
    assembly: "concat-demuxer",
    chunks,
    maxCommandLength: Math.max(...chunks.map((chunk) => chunk.commandLength), ffmpegCommandLineLength(ffmpeg, args)),
  };
}

/**
 * 音声の証拠が、N 個の入力を1本につないだものか（1回の graph の concat=n=N、または塊ごとの concat の和が N）。
 */
export function audioSequenceConcatenates(evidence, count) {
  if (!evidence) return false;
  if (Array.isArray(evidence.chunks) && evidence.chunks.length > 0) {
    return evidence.chunks.reduce((sum, chunk) => sum + Number(chunk?.inputCount || 0), 0) === count
      && evidence.chunks.every((chunk) => String(chunk?.filterGraph || "").includes(`concat=n=${chunk.inputCount}:v=0:a=1`));
  }
  return String(evidence.filterGraph || "").includes(`concat=n=${count}:v=0:a=1`);
}

export const AUDIO_PIECE_MIX_ASSEMBLY = "chunked-mix";

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * 断片の列を、区間 [windowStart, windowStart + windowSamples) の1本に足す graph。断片 k は chain(入力の番号) の本体を
 * 置く位置まで遅らせ（adelay。位置が区間の頭なら付けない）、区間の長さに揃えて（apad・atrim）[m<k>] に出す。
 * 1つなら [m0]anull、2つ以上なら amix（normalize=0。入力を順に足すだけで倍率を掛けない）で [label] に出す。
 */
function audioPiecesGraph(pieces, { windowStart, windowSamples, label }) {
  const chains = [];
  const inputs = [];
  let offset = 0;
  pieces.forEach((piece, index) => {
    const delay = piece.startSample - windowStart;
    chains.push(`${piece.chain(offset)}${delay > 0 ? `,adelay=delays=${delay}S:all=1` : ""},apad=whole_len=${windowSamples},atrim=end_sample=${windowSamples}[m${index}]`);
    inputs.push(...piece.inputs);
    offset += inputCount(piece.inputs);
  });
  chains.push(pieces.length === 1
    ? `[m0]anull[${label}]`
    : `${pieces.map((_, index) => `[m${index}]`).join("")}amix=inputs=${pieces.length}:duration=longest:dropout_transition=0:normalize=0[${label}]`);
  return { filterGraph: chains.join(";"), inputs, inputCount: offset };
}

/**
 * 時刻の決まった音の断片（piece）を、長さ totalSamples 標本の1本に足し合わせる（BGM の区分の曲をつなぐ工程など）。
 *
 * pieces[k] = { id, inputs: [..., "-i", <path>], startSample, samples, chain(input) }
 *   chain(input) は、入力の番号 input の音から断片の本体（samples 標本。前後の fade を含む）を作る鎖で、
 *   `[<input>:a]` で始まり出力の label を付けない。置く位置（startSample）へ遅らせて長さを揃えるのはここでする。
 *
 * 1回の呼び出しで収まれば、今までどおり全部を1つの graph で描く（区間は番組全体 [0, totalSamples)）。
 * 収まらなければ断片の列を前から塊に分け（groupWithinCommandLine）、塊ごとにその塊の断片が鳴る区間だけを同じ形の
 * graph で 32bit float の WAV に描き、塊の WAV を区間の頭へ遅らせて同じ amix で足す。amix は入力を順に足すだけで、
 * 塊の外は無音（0 を足しても値は変わらない）なので、同じ時刻に3つ以上の断片が重ならない限り1回で描いた版と
 * 標本まで同じになる（塊の途中の値を 16bit に丸めないのもそのため）。
 */
export async function mixAudioPieces({
  ffmpeg,
  pieces,
  totalSamples,
  outputPath,
  workDir = "",
  sampleRate = 48_000,
  channelLayout = "stereo",
  label = "mix",
  codec = "pcm_s16le",
  budget = FFMPEG_COMMAND_LINE_BUDGET,
  timeout = 30 * 60_000,
}) {
  if (!Array.isArray(pieces) || pieces.length === 0) throw new Error("audio piece mix needs at least one piece");
  if (!Number.isSafeInteger(totalSamples) || totalSamples < 1) throw new Error("audio piece mix needs a positive total length in samples");
  for (const piece of pieces) {
    if (!nonNegativeInteger(piece?.startSample) || !Number.isSafeInteger(piece?.samples) || piece.samples < 1 || typeof piece.chain !== "function") {
      throw new Error(`audio piece ${piece?.id ?? "?"} needs an integer startSample, a positive sample count and a chain`);
    }
  }
  const dir = workDir || defaultWorkDir(outputPath);
  const header = ["-hide_banner", "-loglevel", "error", "-y"];
  const commandFor = (group, window, output, groupCodec) => {
    const built = audioPiecesGraph(group, { ...window, label });
    const graphPlan = filterComplexPlan(ffmpeg, built.filterGraph, dir);
    const args = [...header, ...built.inputs, ...graphPlan.args, "-map", `[${label}]`, "-c:a", groupCodec, output];
    return { ...built, graphPlan, args, commandLength: ffmpegCommandLineLength(ffmpeg, args) };
  };
  // 塊の区間: 最初の塊は 0 から、最後の塊（最後の断片を含む塊）は番組の終わりまで。間の塊は、その塊の断片が
  // 鳴るところだけ。1つの塊で収まるときは番組全体 [0, totalSamples) で、1回で描く graph と同じになる。
  // 分けるときに測る区間と描く区間は同じ（塊の番号と最後の断片を含むかで決まる）なので、測った長さのまま描ける。
  const windowFor = (group, index) => {
    const windowStart = index === 0 ? 0 : Math.min(...group.map((piece) => piece.startSample));
    const windowEnd = group.at(-1) === pieces.at(-1)
      ? totalSamples
      : Math.min(totalSamples, Math.max(...group.map((piece) => piece.startSample + piece.samples)));
    return { windowStart, windowSamples: Math.max(1, windowEnd - windowStart) };
  };
  const chunkPath = (index) => join(dir, `audio-mix-chunk-${String(index + 1).padStart(5, "0")}.wav`);
  const probePath = [outputPath, chunkPath(0)].sort((left, right) => right.length - left.length)[0];
  const groups = groupWithinCommandLine(pieces, (group, index) => commandFor(group, windowFor(group, index), probePath, "pcm_f32le").commandLength, budget, "audio piece");
  if (groups.length === 1) {
    const command = commandFor(pieces, { windowStart: 0, windowSamples: totalSamples }, outputPath, codec);
    await writeFilterComplexPlan(command.graphPlan);
    await runFfmpeg(ffmpeg, command.args, { timeout });
    return { filterGraph: command.filterGraph, inputCount: command.inputCount, outputMap: `[${label}]`, maxCommandLength: command.commandLength };
  }
  await mkdir(dir, { recursive: true });
  const chunks = [];
  for (const [index, group] of groups.entries()) {
    const window = windowFor(group, index);
    const command = commandFor(group, window, chunkPath(index), "pcm_f32le");
    if (command.commandLength > budget) throw new Error(`audio piece chunk exceeds the command-line budget (${command.commandLength} > ${budget})`);
    await writeFilterComplexPlan(command.graphPlan);
    await runFfmpeg(ffmpeg, command.args, { timeout });
    chunks.push({ ...window, path: chunkPath(index), filterGraph: command.filterGraph, inputCount: command.inputCount, pieceIds: group.map((piece) => piece.id), commandLength: command.commandLength });
  }
  const finalGraph = [
    ...chunks.map((chunk, index) => `[${index}:a]aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=${channelLayout}`
      + `${chunk.windowStart > 0 ? `,adelay=delays=${chunk.windowStart}S:all=1` : ""},apad=whole_len=${totalSamples},atrim=end_sample=${totalSamples}[c${index}]`),
    `${chunks.map((_, index) => `[c${index}]`).join("")}amix=inputs=${chunks.length}:duration=longest:dropout_transition=0:normalize=0[${label}]`,
  ].join(";");
  const finalPlan = filterComplexPlan(ffmpeg, finalGraph, dir);
  const finalArgs = [...header, ...chunks.flatMap((chunk) => ["-i", chunk.path]), ...finalPlan.args, "-map", `[${label}]`, "-c:a", codec, outputPath];
  const finalLength = ffmpegCommandLineLength(ffmpeg, finalArgs);
  if (finalLength > budget) throw new Error(`audio piece mix of the chunks exceeds the command-line budget (${finalLength} > ${budget})`);
  await writeFilterComplexPlan(finalPlan);
  await runFfmpeg(ffmpeg, finalArgs, { timeout });
  await Promise.all(chunks.map((chunk) => rm(chunk.path, { force: true })));
  return {
    filterGraph: [...chunks.map((chunk) => chunk.filterGraph), finalGraph].join("\n"),
    inputCount: chunks.reduce((sum, chunk) => sum + chunk.inputCount, 0),
    outputMap: `[${label}]`,
    assembly: AUDIO_PIECE_MIX_ASSEMBLY,
    chunks: chunks.map((chunk) => ({
      pieceIds: chunk.pieceIds,
      windowStart: chunk.windowStart,
      windowSamples: chunk.windowSamples,
      filterGraph: chunk.filterGraph,
      inputCount: chunk.inputCount,
      commandLength: chunk.commandLength,
    })),
    mixFilterGraph: finalGraph,
    maxCommandLength: Math.max(...chunks.map((chunk) => chunk.commandLength), finalLength),
  };
}
