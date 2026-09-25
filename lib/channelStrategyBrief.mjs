// チャンネルの戦略の作業フォルダ（台帳の strategy.workDir）から、使うブリーフを見つけて状態を決める。
// plan-request（lib/videoRequestPlan.mjs）と start / resume の関門（lib/channelStartGate.mjs）が同じ判定を使う。
//
// 見つけ方（規約。作業フォルダの置き方は docs/strategy-handoff-spec-ja.md の 2）:
//   1. 明示のブリーフ（--strategy-brief / strategyBriefPath）。チャンネルの作業フォルダの中に限る
//   2. 作業フォルダの直下の下書き strategy-brief-r<N>.json（draft --from-hyp / next の出力）のうち N が最大のものが、
//      まだ企画の品質ループで採点していない（その SHA の版が記録に無い）なら、それ（新しい作業）
//   3. 企画の品質ループの記録（quality/strategy-brief-loop.json）の最後の版のブリーフ
//      （sha256 を渡したときは、その SHA の版だけを探す）
//   4. どれも無ければ「ブリーフなし」
// 状態は企画の品質ループの verdict（lib/strategyBriefQualityLoop.mjs）から決める。モデルは呼ばない。
// ブリーフの文（問い・約束）は出力に写さない。返すのは版の名前・SHA・合否・根拠の状態・理由コードだけ。

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { readJsonIfExists } from "./atomicJsonFile.mjs";
import { pathOverlap } from "./channelRegistry.mjs";
import { sha256Hex, strategySkillFingerprint } from "./strategyBrief.mjs";
import {
  STRATEGY_BRIEF_NOT_A_BRIEF_CODE,
  strategyBriefHandoff,
  strategyBriefQualityPaths,
  strategyBriefVerdict,
} from "./strategyBriefQualityLoop.mjs";

export const STRATEGY_BRIEF_OUTSIDE_CHANNEL_CODE = "strategy-brief-outside-channel-workdir";
export const STRATEGY_BRIEF_CHANNEL_MISMATCH_CODE = "strategy-brief-channel-mismatch";
export const STRATEGY_BRIEF_CHANGED_SINCE_START_CODE = "strategy-brief-changed-since-start";
export const STRATEGY_BRIEF_MISSING_AT_RESUME_CODE = "strategy-brief-missing-at-resume";
export const STRATEGY_BRIEF_PATH_NOT_RECORDED_CODE = "strategy-brief-path-not-recorded";
export const STRATEGY_SKILL_CHANGED_CODE = "strategy-skill-fingerprint-changed";

/** ブリーフの状態。none → 無い / unusable → ブリーフとして使えない / needs-research → 根拠の取り直し・不足 /
 *  needs-review → 企画の品質ループで合格していない / passed → 合格していて根拠が今の前提に当てはまる */
export const BRIEF_STATES = Object.freeze(["none", "unusable", "needs-research", "needs-review", "passed"]);

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function codedError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

/**
 * 根拠の取り直し・当てはまりの確認・不足を表す理由コードか（企画の品質ループの verdict の語彙）。
 * 制作を止める未確認事項と、新しい根拠なしに確かさを上げた書き換えも、確かめる（調べる）工程へ回す。
 */
export function isResearchReasonCode(code) {
  const value = String(code || "").split(":")[0];
  return value.startsWith("strategy-evidence-")
    || value === "strategy-brief-evidence-upgraded-without-review"
    || value === "strategy-brief-open-question-blocks-production"
    || value.endsWith("-without-new-evidence");
}

const DRAFT_NAME = /^strategy-brief-r(\d{1,6})\.json$/u;

/** 作業フォルダの直下の下書き strategy-brief-r<N>.json（N の大きい順）。 */
export async function listBriefDrafts(workDir) {
  let entries = [];
  try {
    entries = await readdir(workDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && DRAFT_NAME.test(entry.name))
    .map((entry) => ({ n: Number(entry.name.match(DRAFT_NAME)[1]), path: path.join(workDir, entry.name) }))
    .sort((left, right) => right.n - left.n);
}

/** 次の下書きの置き場（strategy-brief-r<最大の N + 1>.json）。既存のファイルは上書きしない名前にする。 */
export async function nextBriefDraftPath(workDir) {
  const drafts = await listBriefDrafts(workDir);
  return path.join(workDir, `strategy-brief-r${(drafts[0]?.n || 0) + 1}.json`);
}

/**
 * 使うブリーフを見つける。明示のブリーフが作業フォルダの外なら例外（別のチャンネルのブリーフを混ぜない）。
 * sha256 を渡すと、品質ループの記録からその SHA の版のブリーフを探す。
 */
export async function locateChannelStrategyBrief({ channel, strategyBriefPath = "", sha256 = "" } = {}) {
  const workDir = channel?.strategy?.workDir;
  if (!nonEmpty(workDir)) throw new Error("チャンネルの strategy.workDir が無い。");
  const explicit = nonEmpty(strategyBriefPath);
  if (explicit) {
    const full = path.resolve(explicit);
    if (pathOverlap(full, workDir) !== "inside") {
      throw codedError(
        STRATEGY_BRIEF_OUTSIDE_CHANNEL_CODE,
        `ブリーフはチャンネル ${channel.id} の戦略の作業フォルダ（strategy.workDir）の中のものを渡す。別の場所のブリーフは使わない（別のチャンネルの企画を混ぜない）。`,
      );
    }
    return { source: "explicit", path: full };
  }
  const { statePath } = strategyBriefQualityPaths(workDir);
  const state = await readJsonIfExists(statePath, null).catch(() => null);
  const versions = Array.isArray(state?.strategy?.versions) ? state.strategy.versions : [];
  const wanted = nonEmpty(sha256);
  if (!wanted) {
    // まだ採点していない新しい下書きがあれば、それが今の作業（採点した版より新しい）。
    const [top] = await listBriefDrafts(workDir);
    if (top) {
      let topSha = "";
      try { topSha = sha256Hex(await readFile(top.path)); } catch { topSha = ""; }
      if (topSha && !versions.some((row) => row?.briefSha256 === topSha)) return { source: "draft", path: top.path, label: null };
    }
  }
  const version = wanted ? versions.find((row) => row?.briefSha256 === wanted) : versions[versions.length - 1];
  if (!version || !nonEmpty(version.briefPath)) return { source: "none" };
  const full = path.resolve(workDir, ...String(version.briefPath).split("/"));
  if (pathOverlap(full, workDir) !== "inside") return { source: "none" };
  return { source: "quality-loop", path: full, label: nonEmpty(version.label) || null, recordedSha256: version.briefSha256 || null };
}

/**
 * 調べ直す対象。根拠（evidenceId）・制作を止める未確認事項（openQuestionId）・新しい根拠なしに変えた主張（claimId）を
 * 理由コードつきで返す。どの前提を変えたかは changedFields。
 */
function researchGaps(verdict) {
  const gaps = new Map();
  const add = (field, id, entry) => {
    const key = `${field}\u0000${id}\u0000${entry.reasonCode}`;
    if (!gaps.has(key)) gaps.set(key, { [field]: id, ...entry });
  };
  for (const row of verdict?.evidence?.stale || []) add("evidenceId", row.id, { reasonCode: row.reasonCode, changedFields: [...(row.changedFields || [])] });
  for (const row of verdict?.evidence?.upgradedWithoutReview || []) add("evidenceId", String(row.id ?? ""), { reasonCode: "strategy-brief-evidence-upgraded-without-review" });
  for (const code of verdict?.reasonCodes || []) {
    if (!isResearchReasonCode(code)) continue;
    const [reasonCode, id = ""] = String(code).split(":");
    if (!id) continue;
    const field = reasonCode === "strategy-brief-open-question-blocks-production"
      ? "openQuestionId"
      : reasonCode.endsWith("-without-new-evidence") ? "claimId" : "evidenceId";
    add(field, id, { reasonCode });
  }
  return [...gaps.values()];
}

/**
 * 見つけたブリーフを読み、状態を決める。ブリーフの文は返さない。
 * brief.channel.id が台帳のチャンネルと違うブリーフは unusable（別のチャンネルの企画を使わない）。
 */
export async function readChannelStrategyBrief({ channel, located } = {}) {
  if (!located || located.source === "none") {
    return { provided: false, source: "none", state: "none", reasonCodes: [], summary: "企画ブリーフ: 戦略の作業フォルダに無い" };
  }
  const workDir = channel.strategy.workDir;
  const base = { provided: true, source: located.source, path: located.path };
  let bytes;
  try {
    bytes = await readFile(located.path);
  } catch (error) {
    const code = error?.code === "ENOENT" ? "strategy-brief-missing" : "strategy-brief-unreadable";
    return { ...base, state: "unusable", pass: false, reasonCodes: [code], summary: `企画ブリーフ: 読めない（${code}）` };
  }
  let handoff;
  try {
    handoff = await strategyBriefHandoff({ briefPath: located.path, workDir });
  } catch (error) {
    const code = error?.code === STRATEGY_BRIEF_NOT_A_BRIEF_CODE ? STRATEGY_BRIEF_NOT_A_BRIEF_CODE : "strategy-brief-unreadable";
    return { ...base, briefSha256: sha256Hex(bytes), state: "unusable", pass: false, reasonCodes: [code], summary: `企画ブリーフ: ブリーフとして読めない（${code}）` };
  }
  const verdict = await strategyBriefVerdict({ workDir, briefPath: located.path });
  let brief = null;
  try { brief = JSON.parse(bytes.toString("utf8")); } catch { brief = null; }
  const briefChannelId = nonEmpty(brief?.channel?.id) || null;
  const channelMatches = briefChannelId === channel.id;
  const reasonCodes = [...handoff.reasonCodes];
  if (!channelMatches) reasonCodes.unshift(STRATEGY_BRIEF_CHANNEL_MISMATCH_CODE);
  const gaps = researchGaps(verdict);
  const state = !channelMatches
    ? "unusable"
    : handoff.pass
      ? "passed"
      : handoff.refreshRequired || verdict.applicabilityReviewRequired === true || gaps.length > 0 || reasonCodes.some(isResearchReasonCode)
        ? "needs-research"
        : "needs-review";
  return {
    ...handoff,
    ...base,
    reasonCodes,
    state,
    channelMatches,
    loop: { status: verdict.loop?.status || "not-started", rounds: verdict.loop?.rounds || 0, reviewedLabel: verdict.loop?.reviewedLabel || null, latestLabel: verdict.loop?.latestLabel || null },
    researchGaps: gaps,
    premiseChangedFields: [...new Set(gaps.flatMap((gap) => gap.changedFields || []))],
    briefStrategySkillFingerprint: nonEmpty(brief?.provenance?.strategySkill?.fingerprint) || null,
    summary: channelMatches
      ? handoff.summary
      : `企画ブリーフ（${handoff.label || "?"}）: チャンネル ${channel.id} のブリーフではない（${STRATEGY_BRIEF_CHANNEL_MISMATCH_CODE}）`,
  };
}

/** 台帳の strategySkillDir（戦略スキルの採用版）の指紋。中身は写さず、指紋とファイル数だけ。 */
export async function inspectChannelStrategySkill({ channel, briefFingerprint = null } = {}) {
  const dir = nonEmpty(channel?.strategy?.strategySkillDir);
  if (!dir) return { configured: false };
  let fingerprint;
  try {
    fingerprint = await strategySkillFingerprint(dir);
  } catch (error) {
    return { configured: true, dir, status: "unreadable", detail: String(error?.message || error).slice(0, 200) };
  }
  const matches = briefFingerprint ? briefFingerprint === fingerprint.fingerprint : null;
  return {
    configured: true,
    dir,
    status: "readable",
    fingerprint: fingerprint.fingerprint,
    fileCount: fingerprint.fileCount,
    briefFingerprint,
    matches,
    ...(matches === false ? { reasonCode: STRATEGY_SKILL_CHANGED_CODE } : {}),
  };
}

/** ブリーフの状態から、制作の前に要る工程（合格なら null）。plan-request と start の関門が同じ対応を使う。 */
export function briefFixStep(state) {
  if (state === "passed") return null;
  if (state === "needs-research") return "hyp-additional-research";
  if (state === "needs-review") return "strategy-brief-review";
  return "hyp-design";
}

/**
 * Job に残したブリーフの SHA（options.strategyBriefSha256）と、今の同じファイルの SHA を比べる。
 * ファイルは Job の metadata.strategyBrief.path、無ければチャンネルの品質ループの記録から SHA で探す。
 * status: no-brief / unchanged / changed / missing / not-verifiable（start がファイルを記録していない）。
 */
export async function checkJobStrategyBrief({ job, channel = null } = {}) {
  const sha256 = nonEmpty(job?.options?.strategyBriefSha256);
  if (!sha256) return { status: "no-brief" };
  let briefPath = nonEmpty(job?.metadata?.strategyBrief?.path);
  let source = briefPath ? "job-metadata" : "";
  if (!briefPath && channel?.strategy?.workDir) {
    const located = await locateChannelStrategyBrief({ channel, sha256 }).catch(() => ({ source: "none" }));
    if (located.source !== "none") {
      briefPath = located.path;
      source = "quality-loop";
    }
  }
  if (!briefPath) return { status: "not-verifiable", sha256, reasonCode: STRATEGY_BRIEF_PATH_NOT_RECORDED_CODE };
  let current;
  try {
    current = sha256Hex(await readFile(briefPath));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { status: "missing", sha256, path: briefPath, source, reasonCode: STRATEGY_BRIEF_MISSING_AT_RESUME_CODE };
  }
  if (current === sha256) return { status: "unchanged", sha256, path: briefPath, source };
  return { status: "changed", sha256, currentSha256: current, path: briefPath, source, reasonCode: STRATEGY_BRIEF_CHANGED_SINCE_START_CODE };
}
