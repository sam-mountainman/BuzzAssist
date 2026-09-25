// 学習の自動の捕捉（Job の確定時・品質ループの不合格の回）を、どのチャンネル（運営者の配置表の channels）の
// 保存先へ積むかを決める。保存先そのものは lib/channelRegistry.mjs が決め、scripts/harness-learn.mjs の
// captureLearningProposal（channelId）が書く。ここはチャンネルの id を決めるだけ。
//
// 決め方（上ほど強い）:
//   1. 呼び出しが明示したチャンネル（channelId）
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
import { loadChannelRegistry, pathOverlap } from "./channelRegistry.mjs";
import { SCRIPT_QUALITY_WORK_DIR_OPTION } from "./scriptQualityUseGate.mjs";

/** 作業フォルダが、別々のチャンネルを指す手がかりに当たった（どちらかへ寄せない）。 */
export const LEARNING_CHANNEL_AMBIGUOUS = "channel-learning-channel-ambiguous";
/** 台帳を読めないので、チャンネルがあるかどうかを決められない（積まない）。 */
export const LEARNING_CHANNEL_REGISTRY_UNREADABLE = "channel-registry-unreadable";
/** チャンネルは決まったが、その保存先を決められない（積まない。チャンネルの無い保存先へ落とさない）。 */
export const LEARNING_CHANNEL_STORE_UNRESOLVED = "channel-learning-store-unresolved";

const CHANNEL_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const MAX_JOBS_PER_CHANNEL = 500;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
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
  const explicit = nonEmpty(channelId);
  if (explicit) return { channelId: explicit, selectedBy: "explicit" };
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
  const ambiguous = (ids) => ({ channelId: "", selectedBy: null, skippedReason: LEARNING_CHANNEL_AMBIGUOUS, candidates: [...ids].sort() });

  // 制作の Job の台本の作業フォルダ（Job の metadata.channel を優先する）。
  if (dir) {
    const fromJobs = new Set();
    for (const channel of channels) {
      if (!channel.projectDir) continue;
      for (const row of await channelJobWorkDirs(channel.projectDir)) {
        if (within(row.workDir)) fromJobs.add(row.channelId);
      }
    }
    if (fromJobs.size > 1) return ambiguous(fromJobs);
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
  if (candidates.size > 1) return ambiguous(candidates.keys());
  if (candidates.size === 1) {
    const [[id, selectedBy]] = candidates;
    return { channelId: id, selectedBy };
  }
  return { channelId: "", selectedBy: null };
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
