// 依頼文からハーネスを選ぶための計画（plan-request）。Claude Code / Codex 共通。
//
//   CLI: node scripts/run-video-harness.mjs plan-request --request "<依頼文>" [--project-dir DIR] ...
//   MCP: plan_video_request（lib/videoHarnessMcp.mjs）
//
// ここは判断しない。判断するのは、この出力を読むホストの LLM（と、その先の運営者）。
// 出すのは材料だけ——候補の順位、各候補の理由（一致した語・否定された語・入力要件・前提・実績・
// Channel Pack の向き先）、決めきれないときの1問（選択肢つき）。
//
// 守ること:
//   - モデルを呼ばない。有料 API を呼ばない。Job を作らない（plan-only）
//   - 順位と「決まる／決まらない」は start の選択（decideVideoHarness）と同じ判定を使う。
//     plan-request が「決まる」と言った依頼で start が止まる、をなくすため
//   - 実績は宣言から読まない。RunReceipt と skill evals の記録から読み、無ければ「実績なし」
//   - Channel Pack は向き先のハーネスだけを言う。Pack の id・中身・ファイル名は出さない
//   - 台本の本文も依頼文も出力に写さない（形式と大きさだけ）
//   - 企画ブリーフ（任意）は verdict の合否と根拠の状態だけを理由に出す。ブリーフの文は写さず、合否で止めない
//
// チャンネル（--channel / MCP の channelId。台帳は lib/channelRegistry.mjs）を渡すと、作業フォルダ・Pack・
// 制作の仕組み・戦略の作業フォルダ・台本の品質ループの設定を台帳から決め、依頼の種類（lib/channelNextStep.mjs）と
// 戦略の作業フォルダのブリーフの状態から、次の工程の推奨と代案（workflow）を返す。--channel が無くても、
// Pack か作業フォルダが台帳のチャンネルに当たればそのチャンネルとして扱う（start の関門と同じ判定）。

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CHANNEL_PACK_ENVELOPE_VERSION,
  CHANNEL_PACK_MANIFEST,
  trustedChannelPackKeyFromEnvironment,
  verifyChannelPackEnvelope,
} from "./channelPackEnvelope.mjs";
import {
  checkHarnessInputs,
  harnessCapabilityView,
  HARNESS_CAPABILITIES_DIR,
  inspectScriptInput,
  loadHarnessCapabilityCard,
  scriptFormatLabel,
  summarizePrerequisites,
} from "./harnessCapabilities.mjs";
import {
  CHANNEL_REGISTRY_INVALID_CODE,
  assertChannelInputs,
  channelView,
  resolveChannelForCall,
} from "./channelRegistry.mjs";
import { loadRuntimeChannelRegistry } from "./channelStartGate.mjs";
import {
  CHANNEL_STRATEGY_BRIEF_NOT_PASSED_CODE,
  CHANNEL_STRATEGY_BRIEF_REQUIRED_CODE,
  channelJobContext,
  decideRequestKind,
  recommendNextSteps,
  requestKindQuestion,
} from "./channelNextStep.mjs";
import {
  briefFixStep,
  inspectChannelStrategySkill,
  locateChannelStrategyBrief,
  nextBriefDraftPath,
  readChannelStrategyBrief,
} from "./channelStrategyBrief.mjs";
import { resolveLearningState } from "./harnessLearningState.mjs";
import { readSkillEvalRecords, resolveSkillEvalsDir, summarizeSkillEvals } from "./skillEvals.mjs";
import { decideVideoHarness } from "./videoHarnessJob.mjs";
import { loadReceipts, rollup } from "../scripts/harness-receipts.mjs";
import { loadHarnesses } from "../scripts/harness-registry.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INVENTORY_PATH = path.join(REPO_ROOT, ".agents", "skills", "inventory.manifest.json");

export const VIDEO_REQUEST_PLAN_VERSION = "buzzassist-video-request-plan-v1";
export const VIDEO_REQUEST_MISSING_CODE = "video-request-missing";
// 選択肢は 2〜3 個（MCP の質問 UI の規則）。ハーネスが増えても上位3つまでにする。
const MAX_QUESTION_OPTIONS = 3;
const MAX_WORST_GATES = 3;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ratio(passed, total) {
  return total > 0 ? Math.round((passed / total) * 1000) / 1000 : null;
}

function percent(value) {
  return value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

// ---------------------------------------------------------------------------
// Channel Pack の向き先

/**
 * 署名済み Channel Pack の manifest から、対象ハーネスだけを読む。
 * 信頼鍵（BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY）があれば署名と中身まで照合する。
 * 返すのは向き先と照合の結果だけで、Pack の id・版・ファイル名・中身は返さない。
 */
export async function inspectChannelPackTarget(channelPackPath, { env = process.env, harnessIds = [] } = {}) {
  const given = nonEmpty(channelPackPath);
  if (!given) return { provided: false };
  let bundleDir = path.resolve(given);
  let info;
  try {
    info = await stat(bundleDir);
  } catch {
    return { provided: true, status: "unreadable", detail: "Channel Pack が見つからない" };
  }
  if (info.isFile()) {
    if (path.basename(bundleDir) !== CHANNEL_PACK_MANIFEST) {
      return { provided: true, status: "not-an-envelope", detail: `署名済み Channel Pack（${CHANNEL_PACK_MANIFEST} を持つフォルダー）ではない` };
    }
    bundleDir = path.dirname(bundleDir);
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(bundleDir, CHANNEL_PACK_MANIFEST), "utf8"));
  } catch {
    return { provided: true, status: "not-an-envelope", detail: `署名済み Channel Pack（${CHANNEL_PACK_MANIFEST} を持つフォルダー）ではない` };
  }
  if (!plainObject(manifest) || manifest.version !== CHANNEL_PACK_ENVELOPE_VERSION) {
    return { provided: true, status: "not-an-envelope", detail: "署名済み Channel Pack の封筒の版ではない" };
  }
  const targetHarnessId = nonEmpty(manifest.harnessId);
  let signature = "unverified";
  let trustedKey = null;
  try {
    trustedKey = await trustedChannelPackKeyFromEnvironment(env);
  } catch {
    trustedKey = null;
  }
  if (trustedKey) {
    try {
      await verifyChannelPackEnvelope({ bundleDir, ...trustedKey });
      signature = "verified";
    } catch {
      signature = "invalid";
    }
  }
  return {
    provided: true,
    status: "readable",
    targetHarnessId: targetHarnessId || null,
    knownHarness: Boolean(targetHarnessId) && harnessIds.includes(targetHarnessId),
    signature,
  };
}

function packHint(pack) {
  // 署名の照合に失敗した Pack の記載は信用しない（向き先の手掛かりにも使わない）。
  if (!pack?.provided || pack.status !== "readable" || pack.signature === "invalid" || !pack.knownHarness) return null;
  return pack.targetHarnessId;
}

// ---------------------------------------------------------------------------
// 実績（記録から読む。宣言には書かない）

function receiptsDirFor({ receiptsDir, env }) {
  if (nonEmpty(receiptsDir)) return { dir: path.resolve(receiptsDir), source: "explicit" };
  const state = resolveLearningState({ codeRoot: REPO_ROOT, env });
  return { dir: state.receiptsDir, source: state.mode === "development" ? "development-checkout" : "learning-state" };
}

function aggregateGates(builds) {
  const gates = new Map();
  let runs = 0;
  for (const build of builds) {
    runs += build.runs;
    for (const [id, stat] of Object.entries(build.gates || {})) {
      const total = gates.get(id) || { pass: 0, fail: 0, skip: 0, notInForce: 0 };
      for (const key of Object.keys(total)) total[key] += Number(stat[key]) || 0;
      gates.set(id, total);
    }
  }
  return [...gates.entries()]
    .map(([id, stat]) => ({ id, fail: stat.fail, skip: stat.skip, failRate: ratio(stat.fail, runs) ?? 0 }))
    .filter((gate) => gate.fail > 0 || gate.skip > 0)
    .sort((left, right) => right.failRate - left.failRate || right.skip - left.skip || left.id.localeCompare(right.id))
    .slice(0, MAX_WORST_GATES);
}

/**
 * RunReceipt の集計（scripts/harness-receipts.mjs の loadReceipts / rollup）から、1つのハーネスの
 * 実績を作る。確定（finalized）した記録だけを数える。今の宣言の版の記録を分けて出す——
 * 版をまたいで混ぜると、直したあとも古い失敗が率に残る。
 */
export function readRunReceiptTrackRecord(harness, { entries }) {
  const { builds } = rollup(entries, { harnessId: harness.id });
  if (builds.length === 0) {
    return { status: "none", summary: "実績なし（確定した RunReceipt が無い）" };
  }
  const runs = builds.reduce((sum, build) => sum + build.runs, 0);
  const passed = builds.reduce((sum, build) => sum + build.passed, 0);
  const current = builds.filter((build) => build.harnessVersion === harness.version);
  const currentRuns = current.reduce((sum, build) => sum + build.runs, 0);
  const currentPassed = current.reduce((sum, build) => sum + build.passed, 0);
  const worstGates = aggregateGates(current.length > 0 ? current : builds);
  const result = {
    status: "available",
    runs,
    passed,
    failed: runs - passed,
    passRate: ratio(passed, runs),
    currentVersion: {
      version: harness.version || null,
      runs: currentRuns,
      passed: currentPassed,
      passRate: ratio(currentPassed, currentRuns),
    },
    worstGates,
    worstGatesScope: current.length > 0 ? "current-version" : "all-versions",
  };
  const gateText = worstGates.length > 0 ? `、落ちやすいゲート: ${worstGates.map((gate) => gate.id).join(", ")}` : "";
  result.summary = `RunReceipt ${runs} 件中 ${passed} 件 pass（${percent(result.passRate)}）`
    + (currentRuns > 0 ? `、今の版 ${harness.version} は ${currentPassed}/${currentRuns}` : `、今の版 ${harness.version} の記録なし`)
    + gateText;
  return result;
}

async function readInventory(inventoryPath = INVENTORY_PATH) {
  try {
    const parsed = JSON.parse(await readFile(inventoryPath, "utf8"));
    return Array.isArray(parsed?.skills) ? parsed.skills : [];
  } catch {
    return [];
  }
}

/**
 * skill evals の記録（lib/skillEvals.mjs）から、ハーネスが束縛する正本スキルの今の版
 * （inventory の contentSha256）の合格率をホストごとに出す。前の版の記録しか無ければそう言う。
 */
export function readSkillEvalTrackRecord(harness, { records, inventory }) {
  const skills = [];
  for (const canonicalPath of harness.canonicalSkills || []) {
    const entry = inventory.find((skill) => skill.canonicalPath === canonicalPath);
    const name = path.basename(path.dirname(canonicalPath));
    if (!entry) {
      skills.push({ skill: name, status: "unknown-version", summary: `${name}: 版が inventory に無い` });
      continue;
    }
    const rows = summarizeSkillEvals(records, { skills: [entry.id] }).rows;
    const currentRows = rows.filter((row) => row.contentSha256 === entry.contentSha256 && row.evals > 0);
    if (currentRows.length === 0) {
      const older = rows.some((row) => row.evals > 0);
      skills.push({
        skill: name,
        version: entry.version,
        status: older ? "other-versions-only" : "none",
        summary: older ? `${name} ${entry.version}: 今の版の評価なし（前の版の記録だけある）` : `${name} ${entry.version}: 評価の記録なし`,
      });
      continue;
    }
    const hosts = currentRows.map((row) => ({
      host: row.host,
      evals: row.evals,
      evalsAllPassed: row.evalsAllPassed,
      passRate: ratio(row.evalsAllPassed, row.evals),
    }));
    skills.push({
      skill: name,
      version: entry.version,
      status: "available",
      hosts,
      summary: `${name} ${entry.version}: ${hosts.map((host) => `${host.host} ${host.evalsAllPassed}/${host.evals}`).join("、")}`,
    });
  }
  const available = skills.some((skill) => skill.status === "available");
  return {
    status: available ? "available" : "none",
    skills,
    summary: available
      ? `スキル評価: ${skills.filter((skill) => skill.status === "available").map((skill) => skill.summary).join(" / ")}`
      : "スキル評価の実績なし（今の版の記録が無い）",
  };
}

// ---------------------------------------------------------------------------
// 候補と質問

function rowFor(decision, harnessId) {
  return decision.rows.find((row) => row.harness.id === harnessId) || null;
}

function candidateOrder(decision, harnesses, pack) {
  const hint = packHint(pack);
  const picked = new Map();
  const add = (harness) => { if (harness && !picked.has(harness.id)) picked.set(harness.id, harness); };
  if (decision.status === "selected") add(decision.harness);
  for (const row of decision.rows) {
    if (row.positiveHits.length > 0 || row.negatedHits.length > 0) add(row.harness);
  }
  // 依頼文に手掛かりが無くても、Channel Pack が指すハーネスは候補に並べる（理由に Pack と書く）。
  if (hint) add(harnesses.find((harness) => harness.id === hint));
  const selectedId = decision.status === "selected" ? decision.harness.id : null;
  const scoreOf = (id) => rowFor(decision, id)?.score ?? 0;
  return [...picked.values()].sort((left, right) => {
    if (left.id === selectedId) return -1;
    if (right.id === selectedId) return 1;
    const byScore = scoreOf(right.id) - scoreOf(left.id);
    if (byScore !== 0) return byScore;
    if (left.id === hint) return -1;
    if (right.id === hint) return 1;
    return left.id.localeCompare(right.id);
  });
}

function questionOption(view, recommended) {
  return {
    value: view.harnessId,
    label: `${view.displayName}${recommended ? "（推奨）" : ""}`,
    description: view.produces.description,
    recommended,
  };
}

function buildQuestion({ kind, optionIds, viewsById, hint, reason }) {
  const ordered = [...optionIds];
  if (hint && ordered.includes(hint)) ordered.sort((left, right) => (left === hint ? -1 : right === hint ? 1 : 0));
  const options = ordered.slice(0, MAX_QUESTION_OPTIONS)
    .map((id) => questionOption(viewsById.get(id), id === hint));
  const text = kind === "no-match"
    ? "この依頼に当たるハーネスが見つかりません。どれで作りますか？"
    : kind === "channel-pack-mismatch"
      ? "依頼の内容と Channel Pack の向き先が違います。どちらで作りますか？"
      : options.length > 2 ? "どのハーネスで作りますか？" : "どちらのハーネスで作りますか？";
  return {
    id: "harness-choice",
    header: "ハーネス",
    text,
    reason,
    multiSelect: false,
    options,
    ...(kind === "no-match"
      ? { note: "どれにも当たらないなら新しいハーネスが要る。作る前に node scripts/harness-registry.mjs list で既存の保証を確かめる" }
      : {}),
    answerWith: "答えのハーネス ID を harnessId（CLI は --harness）に入れて plan-request をもう一度呼ぶ",
  };
}

// ---------------------------------------------------------------------------
// 企画ブリーフ（任意。渡されたときだけ verdict を理由に出す。合否で止めない）

async function planStrategyBrief(briefPath) {
  if (!nonEmpty(briefPath)) return { provided: false };
  const { strategyBriefHandoff } = await import("./strategyBriefQualityLoop.mjs");
  try {
    return await strategyBriefHandoff({ briefPath: path.resolve(briefPath) });
  } catch (error) {
    const code = error?.code === "ENOENT" ? "strategy-brief-missing" : nonEmpty(error?.code) || "strategy-brief-unreadable";
    return { provided: true, pass: false, reasonCodes: [code], summary: `企画ブリーフ: 読めない（${code}）` };
  }
}

function reasonLines(candidate, strategyBrief = null) {
  const lines = [];
  if (candidate.matchedTerms.length > 0) lines.push(`一致した語: ${candidate.matchedTerms.join(", ")}`);
  if (candidate.negatedTerms.length > 0) lines.push(`否定の節で減点した語: ${candidate.negatedTerms.join(", ")}`);
  if (candidate.matchedTerms.length === 0 && candidate.negatedTerms.length === 0 && !candidate.explicit) {
    lines.push("依頼文に手掛かりの語は無い");
  }
  if (candidate.explicit) lines.push("ハーネスが明示された");
  lines.push(`台本: ${candidate.inputs.script.detail}`);
  if (candidate.inputs.startOptions.missing.length > 0) {
    const flags = candidate.inputs.startOptions.required
      .filter((entry) => candidate.inputs.startOptions.missing.includes(entry.key))
      .map((entry) => entry.cliFlag);
    lines.push(`start で要る引数が足りない: ${flags.join(", ")}`);
  }
  for (const option of candidate.inputs.startOptions.conditional.filter((entry) => !entry.provided)) {
    lines.push(`条件つきの引数: ${option.cliFlag}（${option.requiredWhen}）`);
  }
  lines.push(`Channel Pack: ${candidate.inputs.channelPack.detail}`);
  if (strategyBrief?.provided) {
    lines.push(strategyBrief.summary);
    if (strategyBrief.harnessId && strategyBrief.harnessId !== candidate.harnessId) lines.push(`企画ブリーフの制作条件は ${strategyBrief.harnessId} 向け`);
  }
  lines.push(`前提: ${candidate.prerequisites.detail}`);
  lines.push(`実績: ${candidate.trackRecord.runReceipts.summary}`);
  lines.push(candidate.trackRecord.skillEvals.summary);
  // 状態の注記（statusNote）は長いので理由の行には載せない。capability.statusNote にある。
  if (candidate.capability.status !== "in-production") lines.push(`状態: ${candidate.capability.status}`);
  if (candidate.capability.card.status !== "ok") lines.push(`能力カード: ${candidate.capability.card.status}`);
  return lines;
}

// 表示用。シェルごとの引用規則の違い（PowerShell は \ を逃がさない）に踏み込まず、二重引用符で囲むだけ。
function quoted(value) {
  return `"${value}"`;
}

// start に載せる引数: 必須のものは値か置き場所の印で、条件つきのものは渡されたときだけ。
function startOptionsToShow(view, options) {
  return view.inputs.startOptions.filter((entry) => !nonEmpty(entry.requiredWhen) || nonEmpty(options?.[entry.key]));
}

function startCommand(view, { scriptPath, channelPackPath, options, strategyBriefPath = "" }) {
  const parts = ["node scripts/run-video-harness.mjs start", `--harness ${view.harnessId}`];
  parts.push(`--script-path ${nonEmpty(scriptPath) ? quoted(path.resolve(scriptPath)) : "<台本のファイル>"}`);
  parts.push(`--channel-pack ${nonEmpty(channelPackPath) ? quoted(path.resolve(channelPackPath)) : "<署名済み Channel Pack>"}`);
  if (nonEmpty(strategyBriefPath)) parts.push(`--strategy-brief ${quoted(path.resolve(strategyBriefPath))}`);
  for (const option of startOptionsToShow(view, options)) {
    const value = nonEmpty(options?.[option.key]);
    parts.push(`${option.cliFlag} ${value ? quoted(value) : `<${option.what}>`}`);
  }
  return parts.join(" ");
}

function mcpStartArguments(view, { scriptPath, channelPackPath, options, strategyBriefSha256 = "" }) {
  const optionKeys = startOptionsToShow(view, options).map((entry) => entry.key);
  const given = Object.fromEntries(optionKeys.map((key) => [key, nonEmpty(options?.[key]) || `<${key}>`]));
  // MCP にはブリーフの path の引数が無いので、SHA を options に載せる（Job の識別子に入る）。
  if (nonEmpty(strategyBriefSha256)) given.strategyBriefSha256 = strategyBriefSha256;
  return {
    harnessId: view.harnessId,
    scriptPath: nonEmpty(scriptPath) ? path.resolve(scriptPath) : "<台本のファイル>",
    channelPackPath: nonEmpty(channelPackPath) ? path.resolve(channelPackPath) : "<署名済み Channel Pack>",
    ...(Object.keys(given).length > 0 ? { options: given } : {}),
  };
}

// ---------------------------------------------------------------------------
// チャンネル（台帳の値だけを使う）

async function scriptQualityGenres() {
  const { SCRIPT_QUALITY_GENRES } = await import("./scriptQualityLoop.mjs");
  return SCRIPT_QUALITY_GENRES;
}

/**
 * 呼び出しのチャンネルを台帳から決める。--channel を渡したのに台帳が読めない・チャンネルが無いなら例外。
 * --channel が無く台帳が壊れているときは、台帳の状態を記録して従来の計画を続ける（start は同じ理由で止まる）。
 */
async function resolvePlanChannel({ channelId, channelRegistry, channelRegistryPath, env, harnessIds, projectDir, channelPackPath }) {
  const explicit = nonEmpty(channelId);
  let registry;
  try {
    // start の関門（lib/channelStartGate.mjs）と同じ読み方・同じ検査。
    registry = channelRegistry ?? await loadRuntimeChannelRegistry({ deploymentPath: channelRegistryPath, env, harnessIds });
  } catch (error) {
    if (explicit || error?.code !== CHANNEL_REGISTRY_INVALID_CODE) throw error;
    return { channel: null, registry: { status: "invalid", issues: (error.issues || []).map((issue) => issue.code) } };
  }
  const info = { status: "ok", source: registry.source || "provided", channels: (registry.channels || []).length };
  const resolved = resolveChannelForCall(registry, { channelId: explicit, channelPackPath, projectDir });
  return resolved ? { ...resolved, registry: info } : { channel: null, registry: info };
}

function channelSummaryLines(channelPlan) {
  const lines = [];
  const { channel, selectedBy, requestKind, workflow, strategyBrief } = channelPlan;
  lines.push(`チャンネル: ${channel.id}（${selectedBy === "explicit" ? "明示" : selectedBy === "channel-pack" ? "Channel Pack から" : "作業フォルダから"}）・制作: ${channel.production.kind === "harness" ? channel.production.harnessId : "外部の仕組み"}`);
  if (requestKind.status === "selected") {
    lines.push(`依頼の種類: ${requestKind.kind}（${requestKind.selectedBy === "explicit" ? "明示" : `一致した語: ${requestKind.matchedTerms.join(", ")}`}）`);
  } else {
    lines.push(`依頼の種類: 1つに決めない（${requestKind.reason}）`);
  }
  lines.push(strategyBrief.summary);
  if (workflow) {
    lines.push(`推奨: ${workflow.recommended.id}（${workflow.recommended.reason}）`);
    for (const alternative of workflow.alternatives) lines.push(`代案: ${alternative.id}（${alternative.reason}）`);
    for (const warning of workflow.warnings) lines.push(`注意: ${warning.code}（${warning.detail}）`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 本体

/**
 * 依頼文から候補ハーネスの順位・理由・1問を作る。モデルも有料 API も呼ばず、Job も作らない。
 *
 * checkPrerequisites=true のときだけ doctor を候補ごとに走らせる（ffmpeg の試し書き出しや
 * 非課金の adapter 確認をするので、既定では走らせない）。doctor・記録の置き場は試験用に差し替えられる。
 */
export async function planVideoRequest({
  request = "",
  harnessId = "",
  projectDir = null,
  scriptPath = "",
  channelPackPath = "",
  strategyBriefPath = "",
  channelId = "",
  requestKind = "",
  channelRegistry = null,
  channelRegistryPath = "",
  options = {},
  checkPrerequisites = false,
  env = process.env,
  harnesses = null,
  capabilitiesDir = HARNESS_CAPABILITIES_DIR,
  receiptsDir = "",
  skillEvalsDir = "",
  inventoryPath = INVENTORY_PATH,
  doctor = null,
} = {}) {
  const want = typeof request === "string" ? request : "";
  const missingRequest = () => {
    const error = new Error(`${VIDEO_REQUEST_MISSING_CODE}: 依頼文（--request / MCP の request）が要る。`);
    error.code = VIDEO_REQUEST_MISSING_CODE;
    return error;
  };
  if (!nonEmpty(want) && !nonEmpty(harnessId) && !nonEmpty(requestKind)) throw missingRequest();
  if (options !== undefined && options !== null && !plainObject(options)) throw new Error("options は JSON object であること。");
  const declared = harnesses ?? loadHarnesses();
  const harnessIds = declared.map((harness) => harness.id);

  // チャンネル。台帳の値（作業フォルダ・Pack・ハーネス・戦略の作業フォルダ）だけを使い、渡された値が食い違えば止める。
  const channelPlan = await resolvePlanChannel({
    channelId,
    channelRegistry,
    channelRegistryPath,
    env,
    harnessIds,
    projectDir: nonEmpty(projectDir) ? path.resolve(projectDir) : "",
    channelPackPath: nonEmpty(channelPackPath) ? path.resolve(channelPackPath) : "",
  });
  const channel = channelPlan.channel;
  if (channel) assertChannelInputs(channel, { harnessId, channelPackPath: nonEmpty(channelPackPath) ? path.resolve(channelPackPath) : "" });
  else if (!nonEmpty(want) && !nonEmpty(harnessId)) throw missingRequest();
  const external = channel?.production.kind === "external";
  const effectiveHarnessId = channel ? (external ? "" : channel.production.harnessId) : harnessId;
  const effectivePackPath = channel ? channel.channelPack : channelPackPath;
  const project = channel ? channel.projectDir : nonEmpty(projectDir) ? path.resolve(projectDir) : null;

  const decision = external
    ? { status: "external-production", rows: [] }
    : decideVideoHarness({ harnesses: declared, harnessId: effectiveHarnessId, want });
  const script = await inspectScriptInput(scriptPath);
  const pack = await inspectChannelPackTarget(effectivePackPath, { env, harnessIds });
  const hint = packHint(pack);
  let channelBrief = null;
  if (channel) {
    // ブリーフは台帳の戦略の作業フォルダからだけ探す（明示のブリーフもその中に限る）。
    channelBrief = await readChannelStrategyBrief({ channel, located: await locateChannelStrategyBrief({ channel, strategyBriefPath }) });
  }
  const strategyBrief = channelBrief ?? await planStrategyBrief(strategyBriefPath);

  const receipts = receiptsDirFor({ receiptsDir, env });
  const receiptEntries = loadReceipts(receipts.dir, { projectDirs: project ? [project] : [] });
  const evalsDir = nonEmpty(skillEvalsDir) ? path.resolve(skillEvalsDir) : resolveSkillEvalsDir({ repoRoot: REPO_ROOT, env }).dir;
  const { records: evalRecords } = readSkillEvalRecords(evalsDir);
  const inventory = await readInventory(inventoryPath);

  const viewsById = new Map();
  for (const harness of declared) {
    viewsById.set(harness.id, harnessCapabilityView(harness, await loadHarnessCapabilityCard(harness, { dir: capabilitiesDir })));
  }

  // 決めた結果と Channel Pack の向き先が食い違えば、そのまま start すると Pack の検証で止まる。
  // ここで1問にする（どちらを採るかは人が決める）。チャンネルの Pack は台帳の値なので、食い違いは
  // 1問ではなく台帳の直し（blockers）にする。
  let status = decision.status;
  let reason = decision.reason || null;
  let reasonCode = decision.reasonCode || null;
  let questionIds = null;
  let questionKind = null;
  const packMismatch = decision.status === "selected" && hint && hint !== decision.harness.id;
  if (external) {
    reason = "制作はチャンネルの既存の仕組み（BuzzAssist のハーネスは使わない）";
    reasonCode = "channel-production-external";
  } else if (packMismatch && !channel) {
    status = "choice-required";
    reason = `依頼は ${decision.harness.id}、Channel Pack は ${hint} 向け`;
    reasonCode = "channel-pack-mismatch";
    questionIds = [decision.harness.id, hint];
    questionKind = "channel-pack-mismatch";
  } else if (decision.status === "choice-required") {
    questionIds = decision.choiceRows.map((row) => row.harness.id);
    questionKind = "choice";
  } else if (decision.status === "no-match" || decision.status === "unknown-harness") {
    questionIds = [...harnessIds];
    if (hint) questionIds.sort((left, right) => (left === hint ? -1 : right === hint ? 1 : 0));
    questionKind = "no-match";
    reason = decision.status === "no-match" ? "どのハーネスの手掛かりの語も依頼に無い" : `宣言に無いハーネス ${decision.harnessId}`;
    reasonCode = decision.status;
  }

  // doctor を走らせるのは、決まったハーネスか、質問の選択肢に出すハーネスだけ。
  const doctorTargets = new Set(
    status === "selected" ? [decision.harness.id] : status === "choice-required" ? questionIds : [],
  );
  const runDoctor = checkPrerequisites === true
    ? (doctor ?? (await import("../scripts/harness-doctor.mjs")).runHarnessDoctor)
    : null;

  const ordered = external
    ? []
    : decision.status === "no-match" || decision.status === "unknown-harness"
      ? (hint ? declared.filter((harness) => harness.id === hint) : [])
      : candidateOrder(decision, declared, pack);
  const selectedId = status === "selected" ? decision.harness.id : null;

  const candidates = [];
  for (const [index, harness] of ordered.entries()) {
    const view = viewsById.get(harness.id);
    const row = rowFor(decision, harness.id);
    const inputs = checkHarnessInputs(view, { script, options: options || {}, channelPack: pack });
    const doctorReport = runDoctor && doctorTargets.has(harness.id)
      ? await runDoctor({ projectDir: project ?? REPO_ROOT, harnessId: harness.id })
      : null;
    const prerequisites = summarizePrerequisites(view, doctorReport);
    const trackRecord = {
      runReceipts: readRunReceiptTrackRecord(harness, { entries: receiptEntries }),
      skillEvals: readSkillEvalTrackRecord(harness, { records: evalRecords, inventory }),
    };
    const explicit = decision.status === "selected" && decision.selectedBy === "explicit" && decision.harness.id === harness.id;
    const candidate = {
      rank: index + 1,
      harnessId: harness.id,
      displayName: view.displayName,
      selected: harness.id === selectedId,
      explicit,
      score: row?.score ?? 0,
      matchedTerms: [...(row?.positiveHits || [])],
      negatedTerms: [...(row?.negatedHits || [])],
      channelPackTarget: hint === harness.id,
      inputs,
      prerequisites,
      trackRecord,
      capability: view,
    };
    candidate.reasons = reasonLines(candidate, strategyBrief);
    candidates.push(candidate);
  }

  const selected = candidates.find((candidate) => candidate.selected) || null;
  const blockers = selected
    ? [
        ...selected.inputs.blockers,
        ...(selected.prerequisites.status === "missing"
          ? selected.prerequisites.missing.map((entry) => ({ code: `prerequisite-missing:${entry.id}`, detail: entry.fix || entry.detail }))
          : []),
      ]
    : [];
  if (channel && packMismatch) {
    blockers.push({ code: "channel-pack-harness-mismatch", detail: `チャンネル ${channel.id} の台帳の Channel Pack は ${hint} 向けで、台帳のハーネス ${decision.harness.id} と違う（台帳を直す）` });
  }
  if (channel && !external && channel.strategy.requireBrief && channelBrief.state !== "passed") {
    // start の関門（lib/channelStartGate.mjs）と同じ理由コード。直す工程も同じ対応（briefFixStep）。
    blockers.push({
      code: channelBrief.provided ? CHANNEL_STRATEGY_BRIEF_NOT_PASSED_CODE : CHANNEL_STRATEGY_BRIEF_REQUIRED_CODE,
      detail: `このチャンネルは制作の前に合格したブリーフが要る（strategy.requireBrief）。${channelBrief.summary}`,
      recommendedStep: briefFixStep(channelBrief.state),
    });
  }
  if (!channel && channelPlan.registry.status === "invalid") {
    blockers.push({ code: CHANNEL_REGISTRY_INVALID_CODE, detail: `チャンネルの台帳（config/harness-deployments.json の channels）が壊れていて、start はこの理由で止まる: ${channelPlan.registry.issues.join(", ")}` });
  }

  // チャンネルの工程（依頼の種類 → 推奨と代案）。
  let requestKindOut = null;
  let workflow = null;
  let kindQuestion = null;
  let channelOut = null;
  if (channel) {
    const kindDecision = decideRequestKind({ request: want, requestKind });
    const skill = await inspectChannelStrategySkill({ channel, briefFingerprint: channelBrief.briefStrategySkillFingerprint });
    if (kindDecision.status === "selected") {
      const jobs = await channelJobContext({ channel, brief: channelBrief });
      const genres = await scriptQualityGenres();
      // 台本の品質ループ: start が Job の options.scriptQualityWorkDir に入れるのと同じ規則で作業フォルダを決め、
      // ジャンルは制作のハーネスが有料の処理の前に問うもの（lib/scriptQualityUseGate.mjs）にそろえる。
      const { scriptQualityGenreForHarness, scriptQualityWorkDirFor } = await import("./scriptQualityUseGate.mjs");
      const scriptGateGenre = channel.production.kind === "harness" ? scriptQualityGenreForHarness(channel.production.harnessId) : "";
      let scriptQualityWorkDir = null;
      if (nonEmpty(scriptPath) || nonEmpty(options?.scriptQualityWorkDir)) {
        try {
          scriptQualityWorkDir = scriptQualityWorkDirFor({ options: options || {}, scriptPath, baseDir: channel.projectDir });
        } catch {
          scriptQualityWorkDir = null;
        }
      }
      const scriptGenre = nonEmpty(channel.scriptQuality?.genre) || scriptGateGenre;
      workflow = recommendNextSteps({
        kind: kindDecision.kind,
        channel,
        brief: channelBrief,
        skill,
        scriptPath,
        options: options || {},
        startOptions: selected ? startOptionsToShow(selected.capability, options) : [],
        briefJobs: jobs.briefJobs,
        rerenderJobs: jobs.rerenderJobs,
        scriptGenreHarnessId: genres[scriptGenre]?.harnessId ?? null,
        scriptGateGenre,
        scriptQualityWorkDir,
        nextDraftPath: await nextBriefDraftPath(channel.strategy.workDir),
      });
    } else {
      kindQuestion = requestKindQuestion(kindDecision);
    }
    const { choiceIds: _choiceIds, ...kindOut } = kindDecision;
    requestKindOut = kindOut;
    channelOut = {
      ...channelView(channel),
      selectedBy: channelPlan.selectedBy,
      strategySkill: skill.configured
        ? { configured: true, dir: skill.dir, status: skill.status, ...(skill.fingerprint ? { fingerprint: skill.fingerprint, fileCount: skill.fileCount, briefFingerprint: skill.briefFingerprint, matches: skill.matches } : {}) }
        : { configured: false },
    };
  }

  const question = channel
    ? kindQuestion
    : questionIds
      ? buildQuestion({ kind: questionKind, optionIds: questionIds, viewsById, hint, reason })
      : null;

  let nextStep;
  if (channel) {
    const recommended = workflow?.recommended || null;
    const runnable = recommended?.id === "reuse-brief" ? recommended.then?.[0] : recommended;
    nextStep = kindQuestion
      ? { action: "ask", note: "question（依頼の種類）を1回だけ聞き、答えを requestKind（CLI は --request-kind）に入れて plan-request をもう一度呼ぶ。Job はまだ作らない。" }
      : {
          action: recommended.id,
          ...(runnable?.cli ? { cli: runnable.cli } : {}),
          ...(runnable?.mcp ? { mcp: runnable.mcp } : {}),
          note: "推奨は workflow.recommended、代案は workflow.alternatives。どれを実行するかはホストの AI と運営者が決める。"
            + "戦略スキルの工程はホストの AI が戦略スキルで実行する（BuzzAssist は工程の名前・作業フォルダ・終わったら作るものだけを返す）。"
            + "有料の実行・再開は運営者の明示の確認のあとに（confirmed=true）。",
        };
  } else {
    nextStep = selected
      ? {
          action: blockers.length > 0 ? "resolve-blockers" : "start-plan-only",
          cli: startCommand(selected.capability, { scriptPath, channelPackPath, options, strategyBriefPath: strategyBrief.briefSha256 ? strategyBriefPath : "" }),
          mcp: { tool: "run_video_harness", arguments: mcpStartArguments(selected.capability, { scriptPath, channelPackPath, options, strategyBriefSha256: strategyBrief.briefSha256 || "" }) },
          note: "--confirmed を付けない start は計画だけを保存し、有料 API を呼ばない。有料生成へ進めるのは運営者が明示して承認したあと（confirmed=true）。"
            + (blockers.length > 0 ? " 先に blockers を解消する。" : ""),
        }
      : {
          action: "ask",
          note: "question を1回だけ聞き、答えのハーネス ID で plan-request をもう一度呼ぶ。Job はまだ作らない。",
        };
  }

  const decisionOut = {
    status,
    harnessId: selectedId,
    selectedBy: status === "selected" ? decision.selectedBy : null,
    reason,
    reasonCode,
    blockers,
    startable: status === "selected" && blockers.length === 0,
  };

  const summaryLines = [];
  if (channel) {
    summaryLines.push(...channelSummaryLines({ channel, selectedBy: channelPlan.selectedBy, requestKind: requestKindOut, workflow, strategyBrief: channelBrief }));
    if (kindQuestion) summaryLines.push(`質問: ${kindQuestion.text} 選択肢: ${kindQuestion.options.map((option) => option.label).join(" / ")}`);
  }
  if (status === "selected") {
    summaryLines.push(`判定: ${selectedId} に決まった（${decision.selectedBy === "explicit" ? (channel ? "チャンネルの台帳" : "明示") : `一致した語: ${selected.matchedTerms.join(", ")}`}）`);
    if (blockers.length > 0) summaryLines.push(`始める前に要るもの: ${blockers.map((entry) => entry.code).join(", ")}`);
  } else if (external) {
    summaryLines.push(`判定: ${reason}`);
  } else {
    summaryLines.push(`判定: 1つに決めない（${reason}）`);
    if (question) summaryLines.push(`質問: ${question.text} 選択肢: ${question.options.map((option) => option.label).join(" / ")}`);
  }
  if (strategyBrief.provided && !channel) summaryLines.push(strategyBrief.summary);
  for (const candidate of candidates) {
    summaryLines.push(`${candidate.rank}. ${candidate.harnessId}（点 ${candidate.score}）: ${candidate.reasons.join(" / ")}`);
  }
  if (candidates.length === 0 && !external) summaryLines.push("候補なし");

  return {
    version: VIDEO_REQUEST_PLAN_VERSION,
    ok: true,
    operation: "plan-request",
    planOnly: true,
    paidCallsAttempted: false,
    modelCallsAttempted: false,
    jobCreated: false,
    projectDir: project,
    harnessesConsidered: harnessIds,
    input: {
      script: script.provided
        ? { provided: true, status: script.status, ...(script.format ? { format: script.format, formatLabel: scriptFormatLabel(script.format, script.packageFormat) } : {}), ...(script.packageFormat ? { packageFormat: script.packageFormat } : {}), ...(script.bytes !== undefined ? { bytes: script.bytes } : {}) }
        : { provided: false },
      channelPack: pack.provided
        ? { provided: true, status: pack.status, ...(pack.status === "readable" ? { targetHarnessId: pack.targetHarnessId, knownHarness: pack.knownHarness, signature: pack.signature } : { detail: pack.detail }) }
        : { provided: false },
      optionKeys: Object.keys(options || {}).sort(),
      strategyBrief,
    },
    channel: channelOut,
    requestKind: requestKindOut,
    workflow,
    decision: decisionOut,
    candidates,
    question,
    nextStep,
    records: {
      runReceipts: { source: receipts.source, count: receiptEntries.filter((entry) => entry.receipt).length },
      skillEvals: { count: evalRecords.length },
      prerequisites: checkPrerequisites === true ? "checked" : "not-checked",
      channelRegistry: channelPlan.registry,
    },
    summaryLines,
  };
}
