// start と resume の前に、チャンネルの台帳（lib/channelRegistry.mjs）と企画ブリーフで止めるかを決める。
// lib/videoHarnessService.mjs の start / resume が使う（CLI と MCP が同じ判定になる）。
//
// start:
//   - チャンネルは明示の id（--channel / MCP の channelId）か、Pack・作業フォルダが一致するチャンネル。
//     --channel を付け忘れても、台帳のチャンネルの決まり（requireBrief など）を外さない
//   - 作業フォルダ・Pack・ハーネスは台帳の値だけ。渡された値が食い違えば channel-input-conflict
//   - 外部の制作のチャンネルは start しない（channel-production-external。制作はチャンネルの既存の仕組み）
//   - strategy.requireBrief が true なら、合格したブリーフ（verdict が pass）が無ければ有料の処理の前・Job を
//     作る前に止める。理由コードは channel-strategy-brief-required / channel-strategy-brief-not-passed で、
//     plan-request が推奨する工程（hyp-design / hyp-additional-research / strategy-brief-review / reuse-brief）を添える
//   - ブリーフの SHA は options.strategyBriefSha256（Job の識別子に入る）、ファイルの場所は Job の
//     metadata.strategyBrief（識別子に入れない）に残す。resume はこの場所で SHA を比べる
// resume:
//   - start のときのブリーフの SHA と、今の同じファイルの SHA が違う・ファイルが無いなら止める
//     （strategy-brief-changed-since-start / strategy-brief-missing-at-resume）。新しい Job として start する
//   - requireBrief では止めない（再レンダー＝既存の Job の再開は、戦略スキルも採点も回さない）

import path from "node:path";

import {
  CHANNEL_INPUT_CONFLICT_CODE,
  assertChannelInputs,
  findChannel,
  loadChannelRegistry,
  resolveChannelForCall,
} from "./channelRegistry.mjs";
import { CHANNEL_STRATEGY_BRIEF_NOT_PASSED_CODE, CHANNEL_STRATEGY_BRIEF_REQUIRED_CODE } from "./channelNextStep.mjs";
import {
  STRATEGY_BRIEF_CHANNEL_MISMATCH_CODE,
  briefFixStep,
  checkJobStrategyBrief,
  locateChannelStrategyBrief,
  readChannelStrategyBrief,
} from "./channelStrategyBrief.mjs";

export const CHANNEL_PRODUCTION_EXTERNAL_CODE = "channel-production-external";
export const STRATEGY_BRIEF_SHA_MISMATCH_CODE = "strategy-brief-sha256-mismatch";
export const STRATEGY_BRIEF_NOT_IN_CHANNEL_CODE = "strategy-brief-not-in-channel";
export { CHANNEL_INPUT_CONFLICT_CODE, CHANNEL_STRATEGY_BRIEF_NOT_PASSED_CODE, CHANNEL_STRATEGY_BRIEF_REQUIRED_CODE };

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function codedError(code, message, extra = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/**
 * start / resume / plan-request が同じ形で読む台帳。宣言のハーネスと台本の品質ループのジャンルで検査する
 * （plan-request が通した台帳を start が拒む・その逆、をなくすため）。
 */
export async function loadRuntimeChannelRegistry({ env = process.env, deploymentPath = "", harnessIds = null } = {}) {
  const ids = harnessIds ?? (await import("../scripts/harness-registry.mjs")).loadHarnesses().map((harness) => harness.id);
  const { SCRIPT_QUALITY_GENRES } = await import("./scriptQualityLoop.mjs");
  return loadChannelRegistry({ env, deploymentPath, harnessIds: ids, genres: Object.keys(SCRIPT_QUALITY_GENRES) });
}

function briefOut(brief) {
  if (!brief?.provided) return { provided: false, state: brief?.state || "none" };
  return {
    provided: true,
    source: brief.source,
    label: brief.label || null,
    briefSha256: brief.briefSha256 || null,
    pass: brief.pass === true,
    state: brief.state,
    reasonCodes: [...(brief.reasonCodes || [])],
    summary: brief.summary,
  };
}

async function strategyBriefWithoutChannel({ strategyBriefPath, options }) {
  const { strategyBriefHandoff } = await import("./strategyBriefQualityLoop.mjs");
  const full = path.resolve(strategyBriefPath);
  const handoff = await strategyBriefHandoff({ briefPath: full });
  if (options.strategyBriefSha256 !== undefined && options.strategyBriefSha256 !== handoff.briefSha256) {
    throw codedError(STRATEGY_BRIEF_SHA_MISMATCH_CODE, "options.strategyBriefSha256 が strategyBriefPath のブリーフの SHA-256 と違う。");
  }
  return {
    options: { ...options, strategyBriefSha256: handoff.briefSha256 },
    metadata: { strategyBrief: { path: full, sha256: handoff.briefSha256 } },
    strategyBrief: { provided: true, source: "explicit", label: handoff.label, briefSha256: handoff.briefSha256, pass: handoff.pass, reasonCodes: [...handoff.reasonCodes], summary: handoff.summary },
  };
}

/**
 * start の前の準備。チャンネルが決まらない呼び出しは従来どおり（ブリーフを渡されたときだけ SHA と場所を残す）。
 * 返す値: { channel, projectDir?, channelPackPath?, harnessId?, options, metadata, strategyBrief }
 * （projectDir などが undefined なら呼び出し側の値を使う）。止めるときは理由コードつきの例外で、Job は作らない。
 */
export async function prepareHarnessStart({
  registry,
  channelId = "",
  projectDir = undefined,
  channelPackPath = "",
  harnessId = "",
  options = {},
  strategyBriefPath = "",
} = {}) {
  const baseOptions = { ...(options || {}) };
  const loaded = typeof registry === "function" ? await registry() : registry;
  const resolved = resolveChannelForCall(loaded, {
    channelId,
    channelPackPath: nonEmpty(channelPackPath) ? path.resolve(channelPackPath) : "",
    projectDir: nonEmpty(projectDir) ? path.resolve(projectDir) : "",
  });
  if (!resolved) {
    if (!nonEmpty(strategyBriefPath)) return { channel: null, options: baseOptions, metadata: {}, strategyBrief: null };
    return { channel: null, ...(await strategyBriefWithoutChannel({ strategyBriefPath, options: baseOptions })) };
  }
  const { channel, selectedBy } = resolved;
  assertChannelInputs(channel, {
    harnessId,
    channelPackPath: nonEmpty(channelPackPath) ? path.resolve(channelPackPath) : "",
    projectDir: nonEmpty(projectDir) ? path.resolve(projectDir) : "",
  });
  if (channel.production.kind !== "harness") {
    throw codedError(
      CHANNEL_PRODUCTION_EXTERNAL_CODE,
      `チャンネル ${channel.id} の制作はチャンネルの既存の仕組みで行う（${channel.production.note}）。BuzzAssist の Job は作らない。`,
      { channelId: channel.id },
    );
  }

  // ブリーフは台帳の戦略の作業フォルダの中だけ。MCP は SHA だけを渡せるので、その SHA の版を品質ループの記録から探す。
  const givenSha = nonEmpty(baseOptions.strategyBriefSha256);
  let located = { source: "none" };
  if (nonEmpty(strategyBriefPath)) located = await locateChannelStrategyBrief({ channel, strategyBriefPath });
  else if (givenSha) {
    located = await locateChannelStrategyBrief({ channel, sha256: givenSha });
    if (located.source === "none") {
      throw codedError(
        STRATEGY_BRIEF_NOT_IN_CHANNEL_CODE,
        `options.strategyBriefSha256 のブリーフが、チャンネル ${channel.id} の戦略の作業フォルダの企画の品質ループの記録に無い。strategyBriefPath（CLI は --strategy-brief）でブリーフのファイルを渡す。`,
        { channelId: channel.id },
      );
    }
  }
  const brief = await readChannelStrategyBrief({ channel, located });
  if (givenSha && brief.provided && brief.briefSha256 && givenSha !== brief.briefSha256) {
    throw codedError(STRATEGY_BRIEF_SHA_MISMATCH_CODE, "options.strategyBriefSha256 が渡したブリーフの SHA-256 と違う。");
  }
  if (brief.provided && brief.channelMatches === false) {
    throw codedError(
      STRATEGY_BRIEF_CHANNEL_MISMATCH_CODE,
      `ブリーフの channel.id がチャンネル ${channel.id} と違う。別のチャンネルの企画では作らない。`,
      { channelId: channel.id },
    );
  }
  if (channel.strategy.requireBrief && brief.state !== "passed") {
    // ブリーフを渡さなかったときは、作業フォルダの最後のブリーフの状態で直す工程を選ぶ（合格していれば渡し忘れ）。
    const latest = brief.provided ? brief : await readChannelStrategyBrief({ channel, located: await locateChannelStrategyBrief({ channel }) });
    const recommendedStep = latest.state === "passed" && !brief.provided ? "reuse-brief" : briefFixStep(latest.state);
    const code = brief.provided ? CHANNEL_STRATEGY_BRIEF_NOT_PASSED_CODE : CHANNEL_STRATEGY_BRIEF_REQUIRED_CODE;
    const hint = recommendedStep === "reuse-brief"
      ? `戦略の作業フォルダに合格したブリーフ（${latest.label || "?"}）がある。--strategy-brief "${latest.path}"（MCP は strategyBriefPath）を付けて start し直す`
      : `plan-request が推奨する工程: ${recommendedStep}（node scripts/run-video-harness.mjs plan-request --channel ${channel.id} --request "<依頼文>" で推奨と代案を見る）`;
    throw codedError(
      code,
      `チャンネル ${channel.id} は制作の前に合格したブリーフが要る（strategy.requireBrief）。${brief.provided ? brief.summary : "ブリーフが渡されていない"}。`
        + `有料の処理の前に止めた。Job は作っていない。${hint}。`,
      { channelId: channel.id, reasonCodes: [...(brief.reasonCodes || [])], recommendedStep, briefState: brief.state },
    );
  }
  const sha = brief.provided ? brief.briefSha256 : "";
  return {
    channel,
    projectDir: channel.projectDir,
    channelPackPath: channel.channelPack,
    harnessId: channel.production.harnessId,
    options: sha ? { ...baseOptions, strategyBriefSha256: sha } : baseOptions,
    metadata: {
      channel: { id: channel.id, selectedBy },
      ...(sha ? { strategyBrief: { path: brief.path, sha256: sha } } : {}),
    },
    strategyBrief: brief.provided ? briefOut(brief) : null,
  };
}

/**
 * resume の前に、start のときのブリーフが変わっていないかを確かめる。変わった・無くなったなら例外（Job は変えない）。
 * start がファイルの場所を残していない Job（SHA だけ）は not-verifiable として返す（止めない。結果に出す）。
 */
export async function checkResumeStrategyBrief({ job, registry = null } = {}) {
  if (!nonEmpty(job?.options?.strategyBriefSha256)) return { status: "no-brief" };
  let channel = null;
  const channelId = nonEmpty(job?.metadata?.channel?.id);
  if (channelId && !nonEmpty(job?.metadata?.strategyBrief?.path) && registry) {
    try {
      channel = findChannel(typeof registry === "function" ? await registry() : registry, channelId);
    } catch {
      channel = null;
    }
  }
  const check = await checkJobStrategyBrief({ job, channel });
  if (check.status === "changed" || check.status === "missing") {
    throw codedError(
      check.reasonCode,
      `${check.status === "changed" ? "ブリーフが変わった" : "ブリーフのファイルが無い"}（start のときのブリーフと同じ SHA ではない）。`
        + "この Job は再開しない。新しい Job として start する（今のブリーフを --strategy-brief / strategyBriefPath に渡す）。",
      { jobId: job?.id || null, strategyBriefCheck: check },
    );
  }
  return check;
}
