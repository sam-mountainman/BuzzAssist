// 学習の自動の捕捉（Job の確定時・品質ループの不合格の回）を、どのチャンネル（運営者の配置表の channels）の
// 保存先へ積むかを決める。保存先そのものは lib/channelRegistry.mjs が決め、scripts/harness-learn.mjs の
// captureLearningProposal（channelId）が書く。ここはチャンネルの id を決めるだけ。
//
// 決め方（上ほど強い）:
//   1. 呼び出しが明示したチャンネル（channelId。ループの CLI の --channel <id> と、--job <id> の Job の
//      metadata.channel）。明示は下の 2〜4 の手がかりと照らし、別のチャンネルを指せば決めない
//      （channel-learning-channel-ambiguous）。明示どうしが食い違うときも同じ
//   2. 制作の Job の metadata.channel（start が台帳のチャンネルで作ったときに残す）
//   3. 品質ループの作業フォルダが、台帳のチャンネルの Job（metadata.channel のあるもの）の
//      options.scriptQualityWorkDir と同じか、その中（制作の Job の台本の作業フォルダ。Job のチャンネルを優先する）
//   4. 企画ブリーフの channel.id が台帳のチャンネルの id / 作業フォルダが台帳のチャンネルの strategy.workDir・
//      projectDir と同じか、その中。4 の中で別々のチャンネルを指したら決めない（channel-learning-channel-ambiguous）
//   5. どれにも当たらなければ、チャンネルの無い従来の捕捉（ハーネス単位の Channel Pack の台帳）
//
// 台帳を読めなければ推測で決めない（channel-registry-unreadable。積まない）。チャンネルが決まったのに保存先を
// 決められないとき（台帳に無い・そのチャンネルの宛先に無い）は、捕捉が channel-learning-store-unresolved で止める。
// 読むだけ。ファイルを作らない・書かない。

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  CHANNEL_LEARNING_SCOPE_ERROR,
  CHANNEL_LEARNING_STORE_ERROR,
} from "../scripts/harness-learn.mjs";
import { findChannel, loadChannelRegistry, pathOverlap } from "./channelRegistry.mjs";
import { SCRIPT_QUALITY_WORK_DIR_OPTION } from "./scriptQualityUseGate.mjs";

/** 作業フォルダが、別々のチャンネルを指す手がかりに当たった（どちらかへ寄せない）。 */
export const LEARNING_CHANNEL_AMBIGUOUS = "channel-learning-channel-ambiguous";
/** 台帳を読めないので、チャンネルがあるかどうかを決められない（積まない）。 */
export const LEARNING_CHANNEL_REGISTRY_UNREADABLE = "channel-registry-unreadable";
/** チャンネルは決まったが、その保存先を決められない（積まない。チャンネルの無い保存先へ落とさない）。 */
export const LEARNING_CHANNEL_STORE_UNRESOLVED = "channel-learning-store-unresolved";

/** ループの CLI の --job の Job が、台帳のチャンネルの作業フォルダ（projectDir の canvas/harness-runs）に無い。 */
export const LEARNING_CHANNEL_JOB_NOT_FOUND = "learning-channel-job-not-found";
/** ループの CLI の --job の Job に、チャンネル（metadata.channel）が無い。 */
export const LEARNING_CHANNEL_JOB_WITHOUT_CHANNEL = "learning-channel-job-without-channel";

const CHANNEL_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
// 制作の Job の ID の形（lib/videoHarnessJob.mjs の videoHarnessJobPath と同じ）。path を組み立てる前に確かめる。
const JOB_ID = /^video-[a-z0-9_-]+-[a-f0-9]{16}$/u;
const MAX_JOBS_PER_CHANNEL = 500;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/** 明示の手がかり（1つの id か、その一覧）を、重複を除いた id の一覧にする。 */
function explicitChannelIds(value) {
  return [...new Set((Array.isArray(value) ? value : [value]).map(nonEmpty).filter(Boolean))];
}

function ambiguous(ids) {
  return { channelId: "", selectedBy: null, skippedReason: LEARNING_CHANNEL_AMBIGUOUS, candidates: [...new Set(ids)].sort() };
}

function codedError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

/** Job を作ったチャンネル（start が metadata.channel に残した台帳の id）。無ければ ""（チャンネルの無い従来の Job）。 */
export function jobChannelId(job) {
  const id = nonEmpty(job?.metadata?.channel?.id);
  return CHANNEL_ID.test(id) ? id : "";
}

/** 捕捉が止まった理由のコード（本文やパスは返さない）。Job の確定時の捕捉と品質ループの捕捉が同じものを使う。 */
export function learningCaptureFailureReason(error, channelId = "") {
  if (error?.code === "LEARNING_WRITE_FORBIDDEN_IN_CHILD_AGENT") return "child-agent";
  if (channelId && (error?.code === CHANNEL_LEARNING_SCOPE_ERROR || error?.code === CHANNEL_LEARNING_STORE_ERROR)) {
    return LEARNING_CHANNEL_STORE_UNRESOLVED;
  }
  if (/分離されていない/u.test(String(error?.message || ""))) return "ledger-not-isolated";
  return "capture-failed";
}

/** 台帳のチャンネルの作業フォルダにある Job のうち、チャンネルと台本の作業フォルダを持つもの（壊れた Job は飛ばす）。 */
async function channelJobWorkDirs(projectDir) {
  const root = path.join(path.resolve(projectDir), "canvas", "harness-runs");
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows = [];
  const dirs = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("video-")).slice(0, MAX_JOBS_PER_CHANNEL);
  for (const entry of dirs) {
    try {
      const job = JSON.parse(await readFile(path.join(root, entry.name, "job.json"), "utf8"));
      const channelId = jobChannelId(job);
      const workDir = nonEmpty(job?.options?.[SCRIPT_QUALITY_WORK_DIR_OPTION]);
      if (channelId && workDir && path.isAbsolute(workDir)) rows.push({ channelId, workDir });
    } catch {
      // 1つの壊れた Job で決め方を止めない。
    }
  }
  return rows;
}

/**
 * 学習を積むチャンネルを決める。返す値: { channelId, selectedBy, skippedReason?, candidates? }。
 * channelId が "" で skippedReason が無ければ、チャンネルの無い従来の捕捉。
 *
 * channelId は明示の手がかりで、1つの id か id の一覧（ループの CLI の --channel と、--job の Job のチャンネル）。
 * 明示は、ほかの手がかり（Job・作業フォルダ・ブリーフの channel.id）を今までの決め方で決めた答えと照らす。
 * 答えが別のチャンネル・決まらない（食い違い）なら、どちらへも寄せずに channel-learning-channel-ambiguous。
 * ほかの手がかりが何も指さなければ明示のチャンネル。
 */
export async function resolveLearningChannel({
  workDir = "",
  job = null,
  channelId = "",
  briefChannelId = "",
  env = process.env,
  repoRoot = undefined,
  registry = undefined,
} = {}) {
  const explicit = explicitChannelIds(channelId);
  if (explicit.length > 1) return ambiguous(explicit);
  if (explicit.length === 1) {
    const others = await resolveLearningChannel({ workDir, job, briefChannelId, env, repoRoot, registry });
    if (others.skippedReason === LEARNING_CHANNEL_AMBIGUOUS) return ambiguous([...explicit, ...(others.candidates || [])]);
    // 台帳を読めないときは、明示がほかの手がかりと合うかを確かめられない（積まない）。
    if (others.skippedReason) return others;
    if (others.channelId && others.channelId !== explicit[0]) return ambiguous([explicit[0], others.channelId]);
    return { channelId: explicit[0], selectedBy: "explicit" };
  }
  const fromJob = jobChannelId(job);
  if (fromJob) return { channelId: fromJob, selectedBy: "job" };
  const dir = nonEmpty(workDir) ? path.resolve(workDir) : "";
  const brief = nonEmpty(briefChannelId);
  if (!dir && !brief) return { channelId: "", selectedBy: null };

  let channels;
  try {
    channels = (registry ?? loadChannelRegistry({ ...(repoRoot ? { repoRoot } : {}), env }))?.channels || [];
  } catch {
    return { channelId: "", selectedBy: null, skippedReason: LEARNING_CHANNEL_REGISTRY_UNREADABLE };
  }
  if (channels.length === 0) return { channelId: "", selectedBy: null };
  const within = (target) => Boolean(target) && ["same", "inside"].includes(pathOverlap(dir, target));

  // 制作の Job の台本の作業フォルダ（Job の metadata.channel を優先する）。
  if (dir) {
    const fromJobs = new Set();
    for (const channel of channels) {
      if (!channel.projectDir) continue;
      for (const row of await channelJobWorkDirs(channel.projectDir)) {
        if (within(row.workDir)) fromJobs.add(row.channelId);
      }
    }
    if (fromJobs.size > 1) return ambiguous([...fromJobs]);
    if (fromJobs.size === 1) return { channelId: [...fromJobs][0], selectedBy: "job-work-dir" };
  }

  const candidates = new Map();
  if (brief && channels.some((channel) => channel.id === brief)) candidates.set(brief, "brief");
  if (dir) {
    for (const channel of channels) {
      if (candidates.has(channel.id)) continue;
      if (within(channel.strategy?.workDir)) candidates.set(channel.id, "strategy-work-dir");
      else if (within(channel.projectDir)) candidates.set(channel.id, "project-dir");
    }
  }
  if (candidates.size > 1) return ambiguous([...candidates.keys()]);
  if (candidates.size === 1) {
    const [[id, selectedBy]] = candidates;
    return { channelId: id, selectedBy };
  }
  return { channelId: "", selectedBy: null };
}

/**
 * ループの CLI（scripts/script-quality-loop.mjs・asset-quality-loop.mjs・strategy-brief.mjs）の --channel <id> と
 * --job <id> を、学習を積むチャンネルの明示の手がかりにする。回を記録する前に呼ぶ。
 *
 * - --channel: 台帳（運営者の配置表の channels）に無ければ channel-unknown で止める
 * - --job: 台帳のチャンネルの作業フォルダ（projectDir の canvas/harness-runs/<id>/job.json）から Job を探し、その
 *   metadata.channel を使う。見つからなければ learning-channel-job-not-found、チャンネルの無い Job は
 *   learning-channel-job-without-channel、Job のチャンネルが台帳に無ければ channel-unknown で止める
 * - 台帳を読めなければ channel-registry-unreadable で止める
 *
 * どれも「黙ってチャンネルの無い保存先へ積む」を防ぐため。止めずに回を記録すると、運営者が明示したチャンネルとは
 * 別の台帳へ学習が積まれたことに気付かない。
 * 返す値: { channelIds, captureInput }。captureInput は捕捉の関数（captureScriptRoundLearning など）の引数へ
 * そのまま足す（明示が無ければ空）。--channel と Job のチャンネルが違えば両方を渡し、決め方が食い違いとして積まない。
 */
export async function learningChannelCliHints({
  channelId = "",
  jobId = "",
  env = process.env,
  repoRoot = undefined,
  registry = undefined,
} = {}) {
  const channel = nonEmpty(channelId);
  const jobRef = nonEmpty(jobId);
  if (!channel && !jobRef) return { channelIds: [], captureInput: {} };
  let loaded;
  try {
    loaded = registry ?? loadChannelRegistry({ ...(repoRoot ? { repoRoot } : {}), env });
  } catch (error) {
    throw codedError(LEARNING_CHANNEL_REGISTRY_UNREADABLE, `チャンネルの台帳を読めない（${String(error?.message || error).slice(0, 300)}）。`);
  }
  const ids = [];
  if (channel) ids.push(findChannel(loaded, channel).id);
  if (jobRef) {
    if (!JOB_ID.test(jobRef)) throw codedError(LEARNING_CHANNEL_JOB_NOT_FOUND, `Job の ID の形ではない: ${jobRef.slice(0, 80)}`);
    const found = [];
    for (const entry of loaded?.channels || []) {
      if (!entry.projectDir) continue;
      try {
        found.push(JSON.parse(await readFile(path.join(path.resolve(entry.projectDir), "canvas", "harness-runs", jobRef, "job.json"), "utf8")));
      } catch {
        // このチャンネルの作業フォルダには無い（読めない Job も使わない）。
      }
    }
    if (found.length === 0) {
      throw codedError(LEARNING_CHANNEL_JOB_NOT_FOUND, `Job ${jobRef} が台帳のチャンネルの作業フォルダ（projectDir の canvas/harness-runs）に無い。`);
    }
    for (const job of found) {
      const fromJob = jobChannelId(job);
      if (!fromJob) throw codedError(LEARNING_CHANNEL_JOB_WITHOUT_CHANNEL, `Job ${jobRef} はチャンネルで作った Job ではない（metadata.channel が無い）。`);
      ids.push(findChannel(loaded, fromJob).id);
    }
  }
  return { channelIds: [...new Set(ids)], captureInput: { channelId: ids } };
}

/**
 * 品質ループの捕捉の前に、積むチャンネルを決めて captureLearningProposal の options にする。
 * 返す値: { channel（resolveLearningChannel の結果）, captureOptions, skippedReason? }。
 */
export async function learningChannelCaptureOptions({
  captureOptions = {},
  env = process.env,
  resolveChannel = resolveLearningChannel,
  ...where
} = {}) {
  const channel = await resolveChannel({ ...where, env });
  if (channel?.skippedReason) return { channel, captureOptions, skippedReason: channel.skippedReason };
  if (!channel?.channelId) return { channel, captureOptions };
  return { channel, captureOptions: { env, ...captureOptions, channelId: channel.channelId } };
}

/** 結果に足すチャンネルの欄（チャンネルが決まったときだけ）。 */
export function learningChannelFields(channel) {
  return channel?.channelId ? { channelId: channel.channelId, channelSelectedBy: channel.selectedBy } : {};
}
