// チャンネルと依頼から、上位側の AI（Claude Code / Codex）が次にやる工程を選ぶための材料。
// plan-request（lib/videoRequestPlan.mjs）の --channel で使う。ここは判断しない——推奨と代案と理由を並べ、
// 決めるのはホストの AI と運営者。
//
// 依頼の種類（REQUEST_KINDS）:
//   new-design（新規・大きな再設計）/ next-video（次作）/ script-review（1本の台本の添削）/
//   produce（確定稿から制作）/ rerender（同じ内容の再レンダー）/ post-publish（公開後の改善）/ research（調べるだけ）
// 種類の判定はハーネス選び（lib/videoHarnessJob.mjs の decideVideoHarness）と同じ規則を使う——否定の節の語は
// 減点し、同点・点差が小さい・否定しか残らない・どれにも当たらないときは1つに決めずに1問を返す。
//
// 工程（steps）:
//   戦略スキル（運営者が別に保守する。BuzzAssist には取り込まない）の工程は、工程の名前（新規設計・次作・添削・
//   Analytics からの改善・追加調査・調査）と作業フォルダと、終わったら作るもの（ブリーフ）だけを返す。
//   戦略スキルの文面は持たない・写さない。
//   BuzzAssist の工程（企画の品質ループ・ブリーフの再利用・制作・再レンダー）はコマンドの例を返す。
//
// 守ること:
//   - モデルも有料 API も呼ばない。Job を作らない。依頼文・台本・ブリーフの文を出力に写さない
//   - チャンネルの値は台帳の値だけを使う（Pack・台本の品質ループの設定・学習の宛先・戦略の作業フォルダ）
//   - 推測で1つに決めない。rerender は戦略スキルも採点も回さず、既存の Job の再開だけ

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { STRATEGY_BRIEF_VERSION } from "./strategyBrief.mjs";
import { briefFixStep, checkJobStrategyBrief } from "./channelStrategyBrief.mjs";
import { decideVideoHarness } from "./videoHarnessJob.mjs";

export const REQUEST_KIND_UNKNOWN_CODE = "request-kind-unknown";
export const CHANNEL_STRATEGY_BRIEF_REQUIRED_CODE = "channel-strategy-brief-required";
export const CHANNEL_STRATEGY_BRIEF_NOT_PASSED_CODE = "channel-strategy-brief-not-passed";
const MAX_QUESTION_OPTIONS = 3;
const MAX_JOBS = 200;
const MAX_JOBS_SHOWN = 5;
const NO_MATCH_OPTIONS = Object.freeze(["next-video", "produce", "new-design"]);

/** 依頼の種類。keywords は依頼文に現れるかを見る短い手掛かり（NFKC・小文字で照合）。 */
export const REQUEST_KINDS = Object.freeze([
  {
    id: "new-design",
    displayName: "新規・大きな再設計",
    description: "チャンネルを新しく設計する、または方向を大きく変える",
    keywords: ["新規", "新しいチャンネル", "チャンネル設計", "チャンネルを設計", "チャンネルの設計", "再設計", "設計し直", "設計を見直", "立ち上げ", "ゼロから", "一から", "方向転換", "new channel", "redesign", "channel design"],
  },
  {
    id: "next-video",
    displayName: "次作",
    description: "今の設計のまま次の動画を企画する",
    keywords: ["次作", "次の動画", "次回作", "次の回", "次の企画", "新作", "次のネタ", "next video", "next episode"],
  },
  {
    id: "script-review",
    displayName: "台本の添削",
    description: "1本の台本を直す・点検する",
    keywords: ["添削", "台本を直", "台本の直し", "台本を見て", "台本をレビュー", "台本のレビュー", "台本を改善", "台本の改善", "改稿", "推敲", "script review", "review the script", "review my script"],
  },
  {
    id: "produce",
    displayName: "確定稿から制作",
    description: "確定した台本から動画を作る",
    keywords: ["確定稿", "確定した台本", "この台本で", "この台本から", "台本から動画", "動画にして", "制作に進", "制作へ進", "本番の制作", "制作を始め", "produce", "production run"],
  },
  {
    id: "rerender",
    displayName: "同じ内容の再レンダー",
    description: "内容を変えずに作り直す・書き出し直す",
    keywords: ["再レンダー", "再レンダリング", "レンダーし直", "レンダリングし直", "書き出し直", "出力し直", "同じ内容で", "rerender", "re-render", "re-export"],
  },
  {
    id: "post-publish",
    displayName: "公開後の改善",
    description: "公開した動画の数字から次へ活かす",
    keywords: ["公開後", "公開した動画", "投稿した動画", "アナリティクス", "analytics", "再生数", "クリック率", "維持率", "伸びな", "伸び悩", "post-publish", "after publishing"],
  },
  {
    id: "research",
    displayName: "調べるだけ",
    description: "調査だけをして、制作には進まない",
    keywords: ["調べるだけ", "調査だけ", "リサーチだけ", "調べて", "調査して", "リサーチ", "research", "investigate"],
  },
]);

export const REQUEST_KIND_IDS = Object.freeze(REQUEST_KINDS.map((entry) => entry.id));

/** 工程の一覧。strategy-skill の工程は、戦略スキルの工程の名前（hypProcess）だけを持つ。 */
export const NEXT_STEPS = Object.freeze({
  "hyp-design": { owner: "strategy-skill", title: "戦略スキルで新規設計", hypProcess: "新規設計" },
  "hyp-next-video": { owner: "strategy-skill", title: "戦略スキルで次作", hypProcess: "次作" },
  "hyp-additional-research": { owner: "strategy-skill", title: "足りない根拠だけ追加で調べる", hypProcess: "追加調査" },
  "hyp-script-review": { owner: "strategy-skill", title: "戦略スキルで台本を添削し、共通の台本の品質ループへ", hypProcess: "添削" },
  "hyp-post-publish": { owner: "strategy-skill", title: "公開後の数字から次のブリーフの下書きへ", hypProcess: "Analytics からの改善" },
  "hyp-research": { owner: "strategy-skill", title: "調べるだけ（ブリーフは作らない）", hypProcess: "調査" },
  "strategy-brief-review": { owner: "buzzassist", title: "企画の品質ループでブリーフを採点する" },
  "reuse-brief": { owner: "buzzassist", title: "合格したブリーフを使う（戦略スキルを回さない）" },
  produce: { owner: "buzzassist", title: "制作" },
  rerender: { owner: "buzzassist", title: "同じ内容の再レンダー（既存の Job の再開だけ）" },
});

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function q(value) {
  return `"${value}"`;
}

function kindEntry(id) {
  return REQUEST_KINDS.find((entry) => entry.id === id) || null;
}

// ---------------------------------------------------------------------------
// 依頼の種類

function kindRow(row) {
  return { kind: row.harness.id, score: row.score, matchedTerms: [...row.positiveHits], negatedTerms: [...row.negatedHits] };
}

/**
 * 依頼文から種類を決める。判定は decideVideoHarness と同じ（否定の節の減点・同点・点差・否定だけ）。
 * requestKind を明示すればそれを使う（宣言に無い種類は例外）。
 */
export function decideRequestKind({ request = "", requestKind = "" } = {}) {
  const explicit = nonEmpty(requestKind);
  const decision = decideVideoHarness({ harnesses: REQUEST_KINDS, harnessId: explicit, want: typeof request === "string" ? request : "" });
  if (decision.status === "unknown-harness") {
    const error = new Error(`${REQUEST_KIND_UNKNOWN_CODE}: 依頼の種類 ${explicit} は無い。使える種類: ${REQUEST_KIND_IDS.join(", ")}。`);
    error.code = REQUEST_KIND_UNKNOWN_CODE;
    throw error;
  }
  const candidates = decision.rows
    .filter((row) => row.positiveHits.length > 0 || row.negatedHits.length > 0)
    .sort((left, right) => right.score - left.score || REQUEST_KIND_IDS.indexOf(left.harness.id) - REQUEST_KIND_IDS.indexOf(right.harness.id))
    .map(kindRow);
  if (decision.status === "selected") {
    const row = decision.rows.find((entry) => entry.harness.id === decision.harness.id);
    return {
      status: "selected",
      kind: decision.harness.id,
      displayName: decision.harness.displayName,
      selectedBy: decision.selectedBy,
      matchedTerms: decision.selectedBy === "explicit" ? [] : [...(row?.positiveHits || [])],
      negatedTerms: decision.selectedBy === "explicit" ? [] : [...(row?.negatedHits || [])],
      candidates,
    };
  }
  const choiceIds = decision.status === "choice-required"
    ? decision.choiceRows.map((row) => row.harness.id)
    : [...NO_MATCH_OPTIONS];
  return {
    status: decision.status,
    kind: null,
    reason: decision.status === "no-match" ? "どの種類の手掛かりの語も依頼に無い" : decision.reason,
    reasonCode: decision.status === "no-match" ? "no-match" : decision.reasonCode,
    candidates,
    choiceIds,
  };
}

/** 種類を決めきれないときの1問（選択肢は 2〜3 個。ほかの種類は allKinds から選べる）。 */
export function requestKindQuestion(decision) {
  if (decision.status === "selected") return null;
  // 推奨の印は付けない（どれが合うかは依頼をした人にしか分からない）。
  const options = decision.choiceIds.slice(0, MAX_QUESTION_OPTIONS).map((id) => {
    const entry = kindEntry(id);
    return { value: id, label: entry.displayName, description: entry.description };
  });
  return {
    id: "request-kind",
    header: "依頼の種類",
    text: decision.status === "no-match" ? "どの作業をしますか？" : options.length > 2 ? "どの作業にしますか？" : "どちらの作業にしますか？",
    reason: decision.reason,
    multiSelect: false,
    options,
    allKinds: REQUEST_KINDS.map((entry) => ({ value: entry.id, label: entry.displayName })),
    answerWith: "答えの種類を requestKind（CLI は --request-kind）に入れて plan-request をもう一度呼ぶ",
  };
}

// ---------------------------------------------------------------------------
// チャンネルの Job（読むだけ）

/** チャンネルの projectDir の Job を読む。台本・options の中身は返さず、状態とブリーフの SHA だけ。 */
export async function readChannelJobs(projectDir, { limit = MAX_JOBS } = {}) {
  const root = path.join(path.resolve(projectDir), "canvas", "harness-runs");
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const jobs = [];
  for (const entry of entries.filter((item) => item.isDirectory() && item.name.startsWith("video-")).slice(0, limit)) {
    try {
      const job = JSON.parse(await readFile(path.join(root, entry.name, "job.json"), "utf8"));
      jobs.push({
        jobId: String(job.id || entry.name),
        harnessId: String(job.harness?.id || ""),
        status: String(job.status || ""),
        updatedAt: String(job.updatedAt || ""),
        strategyBriefSha256: nonEmpty(job.options?.strategyBriefSha256) || null,
        job,
      });
    } catch {
      // 1つの壊れた Job で一覧を止めない。
    }
  }
  return jobs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.jobId.localeCompare(right.jobId));
}

// ---------------------------------------------------------------------------
// 工程

function workDirOf(ctx) {
  return ctx.channel.strategy.workDir;
}

function planAgainCommand(ctx) {
  return { what: "終わったら、もう一度次の工程を選ぶ", cli: `node scripts/run-video-harness.mjs plan-request --channel ${ctx.channel.id} --request "<依頼文>"` };
}

function briefLoopCommands(ctx, { briefFile = "<ブリーフのファイル（戦略の作業フォルダの中）>", withValidate = true } = {}) {
  const workDir = workDirOf(ctx);
  const loop = ctx.brief?.loop?.status || "not-started";
  const brief = briefFile.startsWith("<") ? briefFile : q(briefFile);
  const commands = [];
  if (ctx.skill?.status === "readable") {
    commands.push({ what: "ブリーフの provenance.strategySkill に書く戦略スキルの版の指紋", cli: `node scripts/strategy-brief.mjs fingerprint --skill-dir ${q(ctx.skill.dir)}` });
  }
  if (withValidate) commands.push({ what: "ブリーフの形を確かめる", cli: `node scripts/strategy-brief.mjs validate --brief ${brief}` });
  if (loop === "not-started") {
    commands.push({ what: "企画の品質ループを始める", cli: `node scripts/strategy-brief.mjs start --work-dir ${q(workDir)} --generator-context <ブリーフを書いた会話・タスクの ID>` });
  } else if (loop !== "active") {
    commands.push({ what: "止まったループを始め直す（前の状態は history に残る）", cli: `node scripts/strategy-brief.mjs start --work-dir ${q(workDir)} --generator-context <ブリーフを書いた会話・タスクの ID> --restart --reason "<何を変えたか>"` });
  }
  commands.push({ what: "評価シートを作り、ブリーフを書いた文脈とは別の文脈で採点する", cli: `node scripts/strategy-brief.mjs sheet --brief ${brief} --work-dir ${q(workDir)}` });
  commands.push({ what: "採点を1回として記録する", cli: `node scripts/strategy-brief.mjs record --brief ${brief} --review <採点ファイル> --work-dir ${q(workDir)}` });
  commands.push({ what: "制作へ渡す前の判定", cli: `node scripts/strategy-brief.mjs verdict --brief ${brief} --work-dir ${q(workDir)} --require-pass` });
  commands.push(planAgainCommand(ctx));
  return commands;
}

function strategySkillView(ctx) {
  if (!ctx.skill?.configured) return { configured: false, note: "台帳に strategy.strategySkillDir が無い（戦略スキルの版をブリーフへ記録できない）" };
  if (ctx.skill.status !== "readable") return { configured: true, dir: ctx.skill.dir, status: ctx.skill.status };
  return { configured: true, dir: ctx.skill.dir, fingerprint: ctx.skill.fingerprint, fileCount: ctx.skill.fileCount };
}

function hypStep(id, ctx, { reason, reasonCodes = [], then = null, extra = {} }) {
  const def = NEXT_STEPS[id];
  const produces = id === "hyp-research"
    ? { kind: "research-files", where: workDirOf(ctx), note: "調べた結果のファイルを作業フォルダに置く。ブリーフは作らない（制作へ進むなら後で hyp-design か hyp-next-video）" }
    : { kind: "strategy-brief", version: STRATEGY_BRIEF_VERSION, where: workDirOf(ctx) };
  return {
    id,
    owner: def.owner,
    title: def.title,
    hypProcess: def.hypProcess,
    reason,
    reasonCodes,
    workDir: workDirOf(ctx),
    strategySkill: strategySkillView(ctx),
    produces,
    instructions: `ホストの AI が戦略スキルの「${def.hypProcess}」の工程を実行し、作業のファイルを戦略の作業フォルダに置く。`
      + "BuzzAssist が返すのは工程の名前・作業フォルダ・終わったら作るものだけで、戦略スキルの文面は持たない。",
    ...extra,
    then: then ?? (id === "hyp-research" ? [planAgainCommand(ctx)] : briefLoopCommands(ctx)),
  };
}

function scriptQualityCommands(ctx) {
  const genre = nonEmpty(ctx.channel.scriptQuality?.genre);
  const workDir = nonEmpty(ctx.scriptPath) ? q(path.dirname(path.resolve(ctx.scriptPath))) : "<台本の作業フォルダ>";
  const config = nonEmpty(ctx.channel.scriptQuality?.channelConfig)
    ? ` --channel-config ${q(ctx.channel.scriptQuality.channelConfig)}`
    : ctx.scriptGenreHarnessId && ctx.channel.production.kind === "harness" && ctx.scriptGenreHarnessId === ctx.channel.production.harnessId
      ? ` --channel-pack ${q(ctx.channel.channelPack)}`
      : "";
  const genreFlag = genre ? ` --genre ${genre}` : " --genre <台帳の scriptQuality.genre>";
  return [
    { what: "台本の品質ループを始める（チャンネルの台帳のジャンルと設定）", cli: `node scripts/script-quality-loop.mjs start --work-dir ${workDir} --generator-context <初稿を書いた会話・タスクの ID>${genreFlag}${config}` },
    { what: "評価シートを作り、版を作った文脈とは別の文脈で採点する", cli: `node scripts/script-quality-loop.mjs sheet --work-dir ${workDir} --script <版のファイル> --stage <工程>` },
    { what: "採点を1回として記録する", cli: `node scripts/script-quality-loop.mjs record --work-dir ${workDir} --script <版のファイル> --version <版の名前> --stage <工程> --review <採点ファイル>` },
    { what: "制作側が使ってよい台本かを確かめる", cli: `node scripts/script-quality-loop.mjs verdict --work-dir ${workDir} --script <台本のファイル>` },
    planAgainCommand(ctx),
  ];
}

function briefArgument(ctx) {
  return ctx.brief?.provided && ctx.brief.state === "passed" ? ctx.brief.path : "";
}

function produceStep(ctx, { reason, reasonCodes = [], blocked = null }) {
  const channel = ctx.channel;
  const base = { id: "produce", owner: "buzzassist", title: NEXT_STEPS.produce.title, reason, reasonCodes, ...(blocked ? { blocked } : {}) };
  if (channel.production.kind === "external") {
    return {
      ...base,
      production: "external",
      productionNote: channel.production.note,
      instructions: "制作はチャンネルの既存の仕組みで行う（BuzzAssist の Job は作らない。run-video-harness start --channel は止まる）。",
    };
  }
  const briefPath = briefArgument(ctx);
  const parts = ["node scripts/run-video-harness.mjs start", `--channel ${channel.id}`];
  parts.push(`--script-path ${nonEmpty(ctx.scriptPath) ? q(path.resolve(ctx.scriptPath)) : "<台本のファイル>"}`);
  if (briefPath) parts.push(`--strategy-brief ${q(briefPath)}`);
  for (const option of ctx.startOptions || []) parts.push(`${option.cliFlag} ${nonEmpty(ctx.options?.[option.key]) ? q(ctx.options[option.key]) : `<${option.what}>`}`);
  const optionArgs = Object.fromEntries((ctx.startOptions || []).map((option) => [option.key, nonEmpty(ctx.options?.[option.key]) || `<${option.key}>`]));
  return {
    ...base,
    production: "harness",
    harnessId: channel.production.harnessId,
    cli: parts.join(" "),
    mcp: {
      tool: "run_video_harness",
      arguments: {
        channelId: channel.id,
        scriptPath: nonEmpty(ctx.scriptPath) ? path.resolve(ctx.scriptPath) : "<台本のファイル>",
        ...(briefPath ? { strategyBriefPath: briefPath } : {}),
        ...(Object.keys(optionArgs).length > 0 ? { options: optionArgs } : {}),
      },
    },
    note: "--channel で作業フォルダ・署名済み Channel Pack・ハーネスが台帳から決まる。--confirmed を付けない start は計画だけを保存し、有料 API を呼ばない。"
      + (channel.strategy.requireBrief ? " このチャンネルは合格したブリーフ（--strategy-brief）が無いと start が有料の処理の前に止まる。" : ""),
  };
}

function rerenderStep(ctx, { reason, reasonCodes = [] }) {
  const channel = ctx.channel;
  const base = { id: "rerender", owner: "buzzassist", title: NEXT_STEPS.rerender.title, reason, reasonCodes };
  if (channel.production.kind === "external") {
    return { ...base, production: "external", productionNote: channel.production.note, instructions: "再レンダーもチャンネルの既存の仕組みで行う（BuzzAssist の Job は無い）。" };
  }
  const jobs = ctx.rerenderJobs || [];
  const target = jobs[0] || null;
  return {
    ...base,
    production: "harness",
    harnessId: channel.production.harnessId,
    jobs: jobs.slice(0, MAX_JOBS_SHOWN).map((job) => ({ jobId: job.jobId, status: job.status, updatedAt: job.updatedAt, strategyBrief: job.briefCheck.status })),
    ...(target
      ? {
          cli: `node scripts/run-video-harness.mjs resume --job-id ${target.jobId} --project-dir ${q(channel.projectDir)} --confirmed`,
          mcp: { tool: "resume_video_harness_job", arguments: { projectDir: channel.projectDir, jobId: target.jobId, confirmed: true } },
        }
      : { blocked: { code: "channel-no-job", detail: "このチャンネルに再開できる Job が無い。再レンダーする元が無いので produce を使う" } }),
    note: "戦略スキルも台本・企画の採点も回さず、既存の Job を再開するだけ（完成済みの有料の成果物は再課金しない）。"
      + "resume は有料へ進み得るので、運営者の明示の確認のあとに。start のときのブリーフが変わっていれば resume は止まる（新しい Job として start する）。",
  };
}

function buzzassistStep(id, ctx, { reason, reasonCodes = [], extra = {} }) {
  const def = NEXT_STEPS[id];
  return { id, owner: def.owner, title: def.title, reason, reasonCodes, ...extra };
}

function reviewStep(ctx, { reason, reasonCodes }) {
  return buzzassistStep("strategy-brief-review", ctx, {
    reason,
    reasonCodes,
    extra: {
      brief: { path: ctx.brief.path, label: ctx.brief.label || null },
      workDir: workDirOf(ctx),
      then: briefLoopCommands(ctx, { briefFile: ctx.brief.path }),
    },
  });
}

function reuseStep(ctx, { reason, reasonCodes = [] }) {
  const produce = produceStep(ctx, { reason: "合格したブリーフで制作する" });
  return buzzassistStep("reuse-brief", ctx, {
    reason,
    reasonCodes,
    extra: {
      brief: { path: ctx.brief.path, label: ctx.brief.label || null, sha256: ctx.brief.briefSha256 },
      then: [produce],
    },
  });
}

function researchStep(ctx, { reason }) {
  const gaps = ctx.brief?.researchGaps || [];
  const fields = ctx.brief?.premiseChangedFields || [];
  const detail = [
    gaps.length > 0 ? `取り直し・足りない根拠: ${gaps.map((gap) => `${gap.evidenceId}（${gap.reasonCode}）`).join(", ")}` : "",
    fields.length > 0 ? `変わった前提: ${fields.join("・")}` : "",
  ].filter(Boolean).join(" / ");
  return hypStep("hyp-additional-research", ctx, {
    reason: detail ? `${reason}（${detail}）` : reason,
    reasonCodes: ctx.brief?.reasonCodes?.filter((code) => code.startsWith("strategy-evidence-") || code.startsWith("strategy-brief-evidence-")) || [],
    extra: {
      brief: ctx.brief?.provided ? { path: ctx.brief.path, label: ctx.brief.label || null } : null,
      gaps,
      premiseChangedFields: fields,
      reuse: "当てはまる根拠は再利用し、上の根拠と前提だけを取り直す。古いという理由だけで全部を取り直さない",
    },
    then: briefLoopCommands(ctx, { briefFile: ctx.brief?.path || undefined }),
  });
}

function fixStepFor(ctx, reason) {
  const fix = briefFixStep(ctx.brief?.state || "none");
  if (fix === "hyp-additional-research") return researchStep(ctx, { reason });
  if (fix === "strategy-brief-review") return reviewStep(ctx, { reason, reasonCodes: ctx.brief.reasonCodes });
  return hypStep("hyp-design", ctx, {
    reason,
    reasonCodes: ctx.brief?.reasonCodes || [],
    extra: { reuse: "有効な根拠は再利用し、不足は補う" },
  });
}

function briefStateReason(brief) {
  if (!brief?.provided) return "このチャンネルの戦略の作業フォルダに使えるブリーフが無い";
  if (brief.state === "unusable") return `見つかったブリーフは使えない（${brief.reasonCodes.slice(0, 3).join(", ")}）`;
  if (brief.state === "needs-research") return `ブリーフ（${brief.label || "?"}）の根拠の取り直し・不足がある`;
  if (brief.state === "needs-review") return `ブリーフ（${brief.label || "?"}）は企画の品質ループで合格していない（${brief.reasonCodes.slice(0, 3).join(", ")}）`;
  return `ブリーフ（${brief.label || "?"}）は合格していて、根拠は今の前提に当てはまる`;
}

/**
 * 依頼の種類とブリーフの状態から、推奨と代案を決める。blockers は制作（produce）を止める理由。
 */
export function recommendNextSteps(ctx) {
  const { kind, brief, channel } = ctx;
  const state = brief?.state || "none";
  const briefReason = briefStateReason(brief);
  const requireBrief = channel.strategy.requireBrief === true;
  const alternatives = [];
  let recommended;
  switch (kind) {
    case "new-design": {
      recommended = hypStep("hyp-design", ctx, {
        reason: `新規・大きな再設計の依頼。${briefReason}`,
        reasonCodes: brief?.reasonCodes || [],
        extra: { reuse: "有効な根拠は再利用し、不足は補う" },
      });
      if (brief?.provided && state !== "unusable") alternatives.push(researchStep(ctx, { reason: "大きく変えないなら、今のブリーフの前提に足りない根拠だけ調べる" }));
      else alternatives.push(hypStep("hyp-research", ctx, { reason: "設計の前に、調べるだけにする" }));
      break;
    }
    case "next-video": {
      if (state === "passed") {
        const usedBy = ctx.briefJobs || [];
        if (channel.production.kind === "harness" && usedBy.length > 0) {
          recommended = hypStep("hyp-next-video", ctx, {
            reason: `${briefReason}。ただしこのブリーフで作った Job がある（${usedBy.slice(0, 3).map((job) => job.jobId).join(", ")}）ので前作のブリーフ。次作のブリーフを作る`,
          });
          alternatives.push(hypStep("hyp-post-publish", ctx, { reason: "前作の公開後の数字があるなら、そこから次のブリーフの下書きを作る", then: postPublishCommands(ctx) }));
          alternatives.push(reuseStep(ctx, { reason: "同じ企画をもう1本作るなら、このブリーフをそのまま使う" }));
        } else {
          recommended = reuseStep(ctx, {
            reason: `${briefReason}。${channel.production.kind === "harness" ? "このブリーフで作った Job はまだ無い" : "制作は外部の仕組みなので、このブリーフで既に作ったかは運営者が確かめる"}。戦略スキルを回さずに制作へ進める`,
          });
          alternatives.push(hypStep("hyp-next-video", ctx, { reason: "このブリーフが前作のものなら、次作の工程で次のブリーフを作る" }));
        }
      } else if (state === "needs-research") {
        recommended = researchStep(ctx, { reason: `次作の依頼。${briefReason}` });
        alternatives.push(hypStep("hyp-next-video", ctx, { reason: "設計ごと見直すなら次作の工程から" }));
      } else if (state === "needs-review") {
        recommended = reviewStep(ctx, { reason: `次作の依頼。${briefReason}`, reasonCodes: brief.reasonCodes });
        alternatives.push(hypStep("hyp-next-video", ctx, { reason: "ブリーフを作り直すなら次作の工程から" }));
      } else {
        recommended = hypStep("hyp-design", ctx, { reason: `次作の依頼。${briefReason}。次作の元になる設計が作業フォルダに無い`, reasonCodes: brief?.reasonCodes || [], extra: { reuse: "有効な根拠は再利用し、不足は補う" } });
        alternatives.push(hypStep("hyp-next-video", ctx, { reason: "設計が戦略スキルの側に既にあるなら、次作の工程から" }));
      }
      break;
    }
    case "script-review": {
      recommended = hypStep("hyp-script-review", ctx, {
        reason: `1本の台本の添削の依頼。添削のあとは共通の台本の品質ループ（チャンネルの台帳の設定）で採点する。${briefReason}`,
        extra: {
          scriptPath: nonEmpty(ctx.scriptPath) ? path.resolve(ctx.scriptPath) : null,
          scriptQuality: ctx.channel.scriptQuality ? { ...ctx.channel.scriptQuality } : { status: "not-configured", note: "台帳に scriptQuality.genre が無い（台本の品質ループのジャンルが決まらない）" },
          produces: { kind: "script-revision", where: nonEmpty(ctx.scriptPath) ? path.dirname(path.resolve(ctx.scriptPath)) : "<台本の作業フォルダ>" },
        },
        then: scriptQualityCommands(ctx),
      });
      if (state === "needs-research") alternatives.push(researchStep(ctx, { reason: "題材・対象・入口を変える添削なら、先に足りない根拠を調べる" }));
      else if (state === "none" || state === "unusable") alternatives.push(hypStep("hyp-design", ctx, { reason: "題材・対象・入口から見直すなら、先に設計してブリーフを作る" }));
      break;
    }
    case "produce": {
      if (state === "passed") {
        recommended = produceStep(ctx, { reason: `確定稿から制作する依頼。${briefReason}` });
      } else if (requireBrief) {
        recommended = fixStepFor(ctx, `このチャンネルは制作の前に合格したブリーフが要る（strategy.requireBrief）。${briefReason}`);
        alternatives.push(produceStep(ctx, {
          reason: "ブリーフが合格してから",
          blocked: { code: brief?.provided ? CHANNEL_STRATEGY_BRIEF_NOT_PASSED_CODE : CHANNEL_STRATEGY_BRIEF_REQUIRED_CODE, detail: briefReason },
        }));
      } else {
        recommended = produceStep(ctx, { reason: `確定稿から制作する依頼。${briefReason}（このチャンネルはブリーフを必須にしていない）`, reasonCodes: brief?.reasonCodes || [] });
        alternatives.push(fixStepFor(ctx, `先に企画を固めるなら。${briefReason}`));
      }
      break;
    }
    case "rerender": {
      recommended = rerenderStep(ctx, { reason: "同じ内容の再レンダーの依頼。戦略スキルも採点も回さない" });
      alternatives.push(produceStep(ctx, { reason: "台本・Channel Pack・ブリーフのどれかが変わったなら同じ Job にならないので、新しい Job として start する" }));
      break;
    }
    case "post-publish": {
      recommended = hypStep("hyp-post-publish", ctx, {
        reason: brief?.provided && state !== "unusable"
          ? `公開後の改善の依頼。前のブリーフ（${brief.label || "?"}）の公開後の確かめ方と実際の数字を照らし、次のブリーフの下書きを作る`
          : `公開後の改善の依頼。${briefReason}（前のブリーフが無いので、次のブリーフは新規設計の手順で組み立てる）`,
        then: postPublishCommands(ctx),
      });
      alternatives.push(hypStep("hyp-next-video", ctx, { reason: "数字の照合より先に次の企画を決めるなら" }));
      break;
    }
    case "research": {
      if (state === "needs-research") {
        recommended = researchStep(ctx, { reason: `調べるだけの依頼。${briefReason}` });
        alternatives.push(hypStep("hyp-research", ctx, { reason: "ブリーフに関係なく調べるなら" }));
      } else {
        recommended = hypStep("hyp-research", ctx, { reason: "調べるだけの依頼（ブリーフは作らない・制作へは進まない）" });
        if (brief?.provided && state !== "unusable") alternatives.push(researchStep(ctx, { reason: "今のブリーフの前提に足りない根拠を調べるなら" }));
        else alternatives.push(hypStep("hyp-design", ctx, { reason: "調べたあと設計まで進めるなら" }));
      }
      break;
    }
    default:
      throw new Error(`${REQUEST_KIND_UNKNOWN_CODE}: ${kind}`);
  }
  const warnings = [];
  if (ctx.skill?.matches === false) {
    warnings.push({ code: ctx.skill.reasonCode, detail: "戦略スキルの今の版の指紋が、ブリーフを作ったときの指紋と違う。同じ版で続けるか、今の版で作り直すかを決める（途中で黙って版を切り替えない）" });
  }
  if (ctx.skill?.configured && ctx.skill.status !== "readable") warnings.push({ code: "strategy-skill-unreadable", detail: "台帳の strategySkillDir を読めない" });
  if (brief?.provided && brief.state === "passed" && (brief.evidence?.unverified || 0) > 0) {
    warnings.push({ code: "strategy-evidence-unverified", detail: `未確認の根拠が ${brief.evidence.unverified} 件ある。制作側で確認済みへ変えない（変えるなら新しい根拠と採点が要る）` });
  }
  for (const entry of channel.learning || []) {
    if (entry.sharedWith.length > 0) warnings.push({ code: "channel-learning-target-shared", detail: `学習の宛先 ${entry.target} を別のチャンネル（${entry.sharedWith.join(", ")}）も使う（宛先はハーネス単位なので、学習が混ざる）` });
  }
  return { recommended, alternatives, warnings };
}

function postPublishCommands(ctx) {
  const workDir = workDirOf(ctx);
  const from = ctx.brief?.provided && ctx.brief.state !== "unusable" ? q(ctx.brief.path) : null;
  if (!from) return [...briefLoopCommands(ctx)];
  return [
    {
      what: "公開後の数字と前のブリーフを照らし、次のブリーフの下書きを作る（数字のファイルは作業フォルダの中に置く）",
      cli: `node scripts/strategy-brief.mjs next --from ${from} --metrics <指標の集計 JSON> --work-dir ${q(workDir)} --out <次のブリーフの下書き>`,
    },
    ...briefLoopCommands(ctx, { briefFile: "<次のブリーフ（下書きを仕上げたもの）>" }),
  ];
}

/** ブリーフで作った Job（同じ SHA）と、再レンダーの候補の Job を読む。 */
export async function channelJobContext({ channel, brief }) {
  if (channel.production.kind !== "harness") return { briefJobs: [], rerenderJobs: [] };
  const jobs = (await readChannelJobs(channel.projectDir)).filter((job) => job.harnessId === channel.production.harnessId);
  const briefJobs = brief?.provided && brief.briefSha256 ? jobs.filter((job) => job.strategyBriefSha256 === brief.briefSha256) : [];
  const rerenderJobs = [];
  for (const job of jobs.filter((entry) => entry.status !== "cancelled").slice(0, MAX_JOBS_SHOWN)) {
    rerenderJobs.push({ ...job, briefCheck: await checkJobStrategyBrief({ job: job.job, channel }).catch(() => ({ status: "unreadable" })) });
  }
  return {
    briefJobs: briefJobs.map(({ job: _job, ...rest }) => rest),
    rerenderJobs: rerenderJobs.map(({ job: _job, ...rest }) => rest),
  };
}
