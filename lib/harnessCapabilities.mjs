// ハーネスの能力カード（プラットフォーム層）
//
// 依頼に合うハーネスを選ぶ側——ホストの LLM と `run-video-harness plan-request`——が読む。
// 何を受け取り、何を出し、何を保証し、何に向いて何に向かないか、費用と所要時間の目安、
// 始める前に揃っている必要のあるもの（doctor の必須項目）を1枚にまとめる。
//
// 置き場は宣言（config/harnesses/<id>.harness.json）の隣の <id>.capabilities.json。
// 宣言の中に入れない理由: 宣言ファイルの SHA は Job の識別子（canonicalIdentity.harnessDeclaration）
// と RunReceipt の declarationDigest に入る。説明文を直しただけで宣言の SHA が変わると、
// 走行中・確定待ちの Job が「計画後に宣言が変わった」で再開できなくなり、実績の集計も
// 版をまたいで分かれる。選ぶための説明は、作るための宣言と別の周期で直せる必要がある。
//
// カードに書かないもの（書けば拒否する）:
//   - 保証の一覧 — 宣言の guarantees から自動で作る。2か所に書くと片方だけ直る
//   - 運営者に要る素材 — 宣言の requiresFromOperator から自動で作る
//   - 実績（RunReceipt の pass 率・落ちやすいゲート、skill evals の合格率）— 宣言した実績は
//     測った実績ではない。選ぶときに記録から読んで添える（lib/videoRequestPlan.mjs）
//   - クライアント名・チャンネル名（宣言と同じ語の表で弾く）

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CLIENT_IDENTIFIERS } from "../scripts/harness-registry.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const HARNESS_CAPABILITIES_DIR = path.join(REPO_ROOT, "config", "harnesses");
export const HARNESS_CAPABILITIES_SCHEMA = "buzzassist-harness-capabilities-v1";
export const HARNESS_CAPABILITIES_SUFFIX = ".capabilities.json";

/** 台本の形式。判定は detectScriptInputFormat（ジャンルに依らない形だけを見る）。 */
export const SCRIPT_INPUT_FORMATS = Object.freeze(["raw-text", "markdown", "script-package"]);
/** doctor の項目をいつ確かめられるか。job-prepare は Job の prepare（署名 Pack の検証）で初めて決まる。 */
export const PREREQUISITE_STAGES = Object.freeze(["before-job", "job-prepare"]);

const ALLOWED_TOP_LEVEL = new Set([
  "schema", "harnessId", "note", "inputs", "outputs", "suitedFor", "notSuitedFor", "estimates", "prerequisites",
]);
const DERIVED_FROM_DECLARATION = Object.freeze({
  guarantees: "保証は宣言の guarantees から自動で作るので、カードに書かない（2か所に書くと片方だけ直る）",
  requiresFromOperator: "運営者に要る素材は宣言の requiresFromOperator から自動で作るので、カードに書かない",
  materials: "運営者に要る素材は宣言の requiresFromOperator から自動で作るので、カードに書かない",
  keywords: "依頼文の手掛かり（keywords）は宣言に置く。選択の判定と同じ場所に1つだけ置く",
});
// 実績を宣言させない。宣言した実績は測った実績ではなく、記録と食い違っても誰も気づかない。
const TRACK_RECORD_KEY = /^(?:passRate|pass_rate|successRate|success_rate|runs|receipts|runReceipts|trackRecord|track_record|worstGates|evals|skillEvals|evalResults|results|history)$/u;
const MAX_SHORT_TEXT = 80;
const MAX_TEXT = 200;
const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function capabilityCardPath(harnessId, dir = HARNESS_CAPABILITIES_DIR) {
  return path.join(dir, `${harnessId}${HARNESS_CAPABILITIES_SUFFIX}`);
}

function findTrackRecordKeys(value, trail = "", out = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findTrackRecordKeys(entry, `${trail}[${index}]`, out));
  } else if (plainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const here = trail ? `${trail}.${key}` : key;
      if (TRACK_RECORD_KEY.test(key)) out.push(here);
      findTrackRecordKeys(entry, here, out);
    }
  }
  return out;
}

function checkTextList(errors, value, label, { min = 1, max = 8, maxLength = MAX_SHORT_TEXT } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    errors.push(`${label} は ${min}〜${max} 件の配列にする`);
    return;
  }
  value.forEach((entry, index) => {
    if (!nonEmpty(entry)) errors.push(`${label}[${index}] が空`);
    else if (entry.length > maxLength) errors.push(`${label}[${index}] が長すぎる（${maxLength} 字まで。短く書く）`);
  });
}

function checkEstimate(errors, value, label) {
  if (!plainObject(value)) {
    errors.push(`${label} が要る（分からなければ { "status": "unknown", "reason": "..." } と明記する）`);
    return;
  }
  if (value.status === "unknown") {
    if (!nonEmpty(value.reason)) errors.push(`${label}.reason が要る（なぜ分からないのか）`);
    return;
  }
  if (value.status === "estimate") {
    if (!nonEmpty(value.value)) errors.push(`${label}.value が要る（目安の値）`);
    if (!nonEmpty(value.basis)) errors.push(`${label}.basis が要る（目安の根拠。測った記録を指す）`);
    return;
  }
  errors.push(`${label}.status は unknown か estimate`);
}

/**
 * 能力カードの検査。緩いカードは選ぶ側を誤らせるので、形が違えば読み込まない。
 * harness を渡すと、宣言の id と一致するかも見る。
 */
export function validateHarnessCapabilityCard(card, harness = null) {
  const errors = [];
  if (!plainObject(card)) return ["オブジェクトではない"];
  if (card.schema !== HARNESS_CAPABILITIES_SCHEMA) errors.push(`schema は ${HARNESS_CAPABILITIES_SCHEMA}`);
  if (!nonEmpty(card.harnessId)) errors.push("harnessId が要る");
  else if (harness && card.harnessId !== harness.id) errors.push(`harnessId が宣言と違う（宣言: ${harness.id}）`);
  for (const key of Object.keys(card)) {
    if (DERIVED_FROM_DECLARATION[key]) errors.push(`${key}: ${DERIVED_FROM_DECLARATION[key]}`);
    else if (!ALLOWED_TOP_LEVEL.has(key) && !TRACK_RECORD_KEY.test(key)) errors.push(`知らない項目 ${key}`);
  }
  for (const where of findTrackRecordKeys(card)) {
    errors.push(`${where}: 実績はカードに書かない（選ぶときに RunReceipt と skill evals の記録から読む）`);
  }

  const inputs = card.inputs;
  if (!plainObject(inputs)) {
    errors.push("inputs が要る（受け取る台本の形式と、start の時点で要る引数）");
  } else {
    const formats = inputs.scriptFormats;
    if (!Array.isArray(formats) || formats.length === 0) {
      errors.push("inputs.scriptFormats が要る（受け取れる台本の形式。1つ以上）");
    } else {
      const seen = new Set();
      formats.forEach((entry, index) => {
        const label = `inputs.scriptFormats[${index}]`;
        if (!plainObject(entry)) { errors.push(`${label} はオブジェクト`); return; }
        if (!SCRIPT_INPUT_FORMATS.includes(entry.id)) errors.push(`${label}.id は ${SCRIPT_INPUT_FORMATS.join(" / ")} のどれか`);
        if (seen.has(entry.id)) errors.push(`${label}.id が重複`);
        seen.add(entry.id);
        if (entry.id === "script-package" && !nonEmpty(entry.packageFormat)) {
          errors.push(`${label}.packageFormat が要る（台本パッケージの format の値）`);
        }
        if (!nonEmpty(entry.what)) errors.push(`${label}.what が要る`);
        else if (entry.what.length > MAX_TEXT) errors.push(`${label}.what が長すぎる（${MAX_TEXT} 字まで）`);
      });
    }
    if (!Array.isArray(inputs.startOptions)) {
      errors.push("inputs.startOptions は配列（start の時点で要る引数。無ければ []）");
    } else {
      inputs.startOptions.forEach((entry, index) => {
        const label = `inputs.startOptions[${index}]`;
        if (!plainObject(entry)) { errors.push(`${label} はオブジェクト`); return; }
        if (!/^[a-z][A-Za-z0-9]*$/u.test(String(entry.key || ""))) errors.push(`${label}.key は camelCase（MCP / --options-json の名前）`);
        if (!/^--[a-z0-9][a-z0-9-]*$/u.test(String(entry.cliFlag || ""))) errors.push(`${label}.cliFlag は --kebab-case`);
        if (!nonEmpty(entry.what)) errors.push(`${label}.what が要る`);
      });
    }
  }

  if (!Array.isArray(card.outputs) || card.outputs.length === 0) {
    errors.push("outputs が要る（何を出すのか）");
  } else {
    card.outputs.forEach((entry, index) => {
      if (!plainObject(entry) || !nonEmpty(entry.id) || !nonEmpty(entry.what)) errors.push(`outputs[${index}] に id と what が要る`);
    });
  }
  checkTextList(errors, card.suitedFor, "suitedFor");
  checkTextList(errors, card.notSuitedFor, "notSuitedFor");

  if (!plainObject(card.estimates)) {
    errors.push("estimates が要る（費用と所要時間。分からなければ unknown と明記する）");
  } else {
    checkEstimate(errors, card.estimates.cost, "estimates.cost");
    checkEstimate(errors, card.estimates.duration, "estimates.duration");
  }

  if (!Array.isArray(card.prerequisites) || card.prerequisites.length === 0) {
    errors.push("prerequisites が要る（doctor の必須項目。harness-doctor.mjs --harness <id> が必須にする項目と同じ id）");
  } else {
    const seen = new Set();
    card.prerequisites.forEach((entry, index) => {
      const label = `prerequisites[${index}]`;
      if (!plainObject(entry)) { errors.push(`${label} はオブジェクト`); return; }
      if (!/^[a-z0-9][a-z0-9-]*$/u.test(String(entry.doctorCheckId || ""))) errors.push(`${label}.doctorCheckId は doctor の項目 id`);
      if (seen.has(entry.doctorCheckId)) errors.push(`${label}.doctorCheckId が重複`);
      seen.add(entry.doctorCheckId);
      if (!PREREQUISITE_STAGES.includes(entry.checkedAt)) errors.push(`${label}.checkedAt は ${PREREQUISITE_STAGES.join(" / ")}`);
      if (entry.conditional !== undefined && typeof entry.conditional !== "boolean") errors.push(`${label}.conditional は true / false`);
      if (!nonEmpty(entry.what)) errors.push(`${label}.what が要る`);
    });
  }

  const text = JSON.stringify(card);
  for (const banned of CLIENT_IDENTIFIERS) {
    if (text.includes(banned)) errors.push(`クライアントを特定できる語が入っている: ${banned}`);
  }
  return errors;
}

/**
 * 宣言1つぶんの能力カードを読む。無い・壊れている・検査に落ちたカードは例外にせず状態で返す——
 * 選ぶ道具が1枚のカードの不備で止まると、ほかのハーネスも選べなくなる。登録漏れは試験
 * （test/harnessCapabilities.test.mjs）が全宣言について落とす。
 */
export async function loadHarnessCapabilityCard(harness, { dir = HARNESS_CAPABILITIES_DIR } = {}) {
  const file = capabilityCardPath(harness.id, dir);
  const relativePath = path.relative(REPO_ROOT, file) || file;
  let card;
  try {
    card = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", path: relativePath, card: null, errors: ["能力カードが無い"] };
    return { status: "invalid", path: relativePath, card: null, errors: [`読めない: ${error.message}`] };
  }
  const errors = validateHarnessCapabilityCard(card, harness);
  if (errors.length > 0) return { status: "invalid", path: relativePath, card: null, errors };
  return { status: "ok", path: relativePath, card, errors: [] };
}

function guaranteeView(guarantee) {
  return {
    id: guarantee.id,
    what: guarantee.what,
    ...(guarantee.human ? { human: guarantee.human } : {}),
    ...(guarantee.inForceSince ? { inForceSince: guarantee.inForceSince } : {}),
  };
}

/**
 * 選ぶ側に見せる形。カードの記述に、宣言から自動で作る部分（保証・素材・入口・状態）を足す。
 * カードが無いときも宣言から作れる部分は返し、card.status でそれを知らせる。
 */
export function harnessCapabilityView(harness, cardResult = { status: "missing", card: null, errors: [] }) {
  const card = cardResult.card;
  return {
    harnessId: harness.id,
    displayName: harness.displayName || harness.id,
    declarationVersion: harness.version || null,
    status: harness.status,
    ...(harness.statusNote ? { statusNote: harness.statusNote } : {}),
    produces: {
      kind: harness.produces?.kind || null,
      description: harness.produces?.description || "",
      ...(Array.isArray(harness.produces?.aspectRatios) ? { aspectRatios: [...harness.produces.aspectRatios] } : {}),
      ...(Array.isArray(harness.produces?.typicalLengthSeconds) ? { typicalLengthSeconds: [...harness.produces.typicalLengthSeconds] } : {}),
    },
    // 運営者の入口は全ハーネス共通の上位 Job（run-video-harness）。ジャンルの runner はその中で動く。
    entrypoint: {
      cli: `node scripts/run-video-harness.mjs start --harness ${harness.id}`,
      mcpTool: "run_video_harness",
    },
    inputs: {
      scriptFormats: card ? card.inputs.scriptFormats.map((entry) => ({ ...entry })) : [],
      startOptions: card ? card.inputs.startOptions.map((entry) => ({ ...entry })) : [],
      // start は全ハーネスで署名済み Channel Pack を要る（run-video-harness の契約）。
      channelPack: { required: true, what: "署名済み Channel Pack（start の --channel-pack / MCP の channelPackPath）" },
      materials: (harness.requiresFromOperator || []).map((entry) => ({
        id: entry.id,
        what: entry.what,
        blocking: entry.blocking === true,
      })),
    },
    outputs: card ? card.outputs.map((entry) => ({ ...entry })) : [],
    guarantees: (harness.guarantees || []).map(guaranteeView),
    suitedFor: card ? [...card.suitedFor] : [],
    notSuitedFor: card ? [...card.notSuitedFor] : [],
    estimates: card ? structuredClone(card.estimates) : {
      cost: { status: "unknown", reason: "能力カードが無い" },
      duration: { status: "unknown", reason: "能力カードが無い" },
    },
    prerequisites: card ? card.prerequisites.map((entry) => ({ ...entry })) : [],
    card: {
      status: cardResult.status,
      path: cardResult.path || null,
      ...(cardResult.errors?.length ? { errors: [...cardResult.errors] } : {}),
    },
  };
}

/**
 * 台本の形式をジャンルに依らない形だけで見分ける（中身の妥当性はジャンルの検査が見る）。
 *   script-package — .json か "{" で始まり、format を持つ JSON オブジェクト
 *   markdown       — .md / .markdown か、Markdown の見出し行がある
 *   raw-text       — それ以外
 * JSON だが format を持たないものは json-unknown（どのハーネスも受け取ると宣言していない）。
 */
export function detectScriptInputFormat({ text = "", filePath = "" } = {}) {
  const trimmed = String(text ?? "").replace(/^﻿/u, "").trim();
  const extension = path.extname(String(filePath || "")).toLowerCase();
  if (extension === ".json" || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (plainObject(parsed) && nonEmpty(parsed.format)) return { format: "script-package", packageFormat: parsed.format.trim() };
    } catch {
      // 下で json-unknown
    }
    return { format: "json-unknown", packageFormat: null };
  }
  if (extension === ".md" || extension === ".markdown") return { format: "markdown", packageFormat: null };
  if (trimmed.split(/\r?\n/u).some((line) => /^#{1,6}[ \t]+\S/u.test(line.trim()))) return { format: "markdown", packageFormat: null };
  return { format: "raw-text", packageFormat: null };
}

/** 台本ファイルを読み、形式だけを返す。本文は返さない。 */
export async function inspectScriptInput(scriptPath) {
  const file = nonEmpty(scriptPath);
  if (!file) return { provided: false, status: "missing" };
  const resolved = path.resolve(file);
  let bytes;
  try {
    bytes = await readFile(resolved);
  } catch (error) {
    return {
      provided: true,
      status: "unreadable",
      detail: error?.code === "ENOENT" ? "台本のファイルが見つからない" : error?.code === "EISDIR" ? "台本の path がフォルダーを指している" : "台本のファイルを読めない",
    };
  }
  if (bytes.length === 0 || !bytes.toString("utf8").trim()) return { provided: true, status: "empty", bytes: bytes.length, detail: "台本が空" };
  if (bytes.length > MAX_SCRIPT_BYTES) return { provided: true, status: "too-large", bytes: bytes.length, detail: "台本が大きすぎる（8 MiB まで）" };
  const detected = detectScriptInputFormat({ text: bytes.toString("utf8"), filePath: resolved });
  return { provided: true, status: "readable", bytes: bytes.length, ...detected };
}

const FORMAT_LABELS = Object.freeze({
  "raw-text": "生テキスト",
  markdown: "Markdown",
  "script-package": "台本パッケージ",
  "json-unknown": "format の無い JSON",
});

export function scriptFormatLabel(format, packageFormat = null) {
  const label = FORMAT_LABELS[format] || format;
  return format === "script-package" && packageFormat ? `${label}（${packageFormat}）` : label;
}

/**
 * 1つのハーネスについて、手元の入力が start の要件を満たすかを見る。
 * 返す blockers は「このまま start すると止まる／作った Job が宙に浮く」理由だけ。
 */
export function checkHarnessInputs(view, { script = { provided: false, status: "missing" }, options = {}, channelPack = { provided: false } } = {}) {
  const blockers = [];
  const accepted = view.inputs.scriptFormats;
  let scriptResult;
  if (!script.provided) {
    scriptResult = { status: "missing", detail: "台本のファイルが未指定（start には --script-path / MCP の scriptPath が要る）" };
    blockers.push({ code: "script-missing", detail: scriptResult.detail });
  } else if (script.status !== "readable") {
    scriptResult = { status: "missing", detail: script.detail || "台本を読めない" };
    blockers.push({ code: "script-unreadable", detail: scriptResult.detail });
  } else if (accepted.length === 0) {
    scriptResult = { status: "unknown", format: script.format, detail: "能力カードが無く、受け取れる形式が分からない" };
    blockers.push({ code: "capability-card-missing", detail: scriptResult.detail });
  } else {
    const match = accepted.find((entry) => entry.id === script.format
      && (entry.id !== "script-package" || entry.packageFormat === script.packageFormat));
    const label = scriptFormatLabel(script.format, script.packageFormat);
    if (match) {
      scriptResult = { status: "ok", format: script.format, ...(script.packageFormat ? { packageFormat: script.packageFormat } : {}), detail: `${label}（受け取れる）` };
    } else {
      const acceptedLabels = accepted.map((entry) => scriptFormatLabel(entry.id, entry.packageFormat)).join("・");
      scriptResult = {
        status: "unsupported",
        format: script.format,
        ...(script.packageFormat ? { packageFormat: script.packageFormat } : {}),
        detail: `${label} は受け取れると宣言していない（受け取れる形式: ${acceptedLabels}）`,
      };
      blockers.push({ code: "script-format-not-accepted", detail: scriptResult.detail });
    }
  }

  const given = plainObject(options) ? options : {};
  const missingOptions = view.inputs.startOptions.filter((entry) => !nonEmpty(given[entry.key]));
  if (missingOptions.length > 0) {
    blockers.push({
      code: "start-options-missing",
      detail: `start の時点で要る引数が足りない: ${missingOptions.map((entry) => `${entry.cliFlag}（${entry.what}）`).join("、")}。Job の識別子に入るので後から足せない`,
      missing: missingOptions.map((entry) => ({ key: entry.key, cliFlag: entry.cliFlag })),
    });
  }

  let packResult;
  if (!channelPack.provided) {
    packResult = { status: "missing", detail: "署名済み Channel Pack が未指定（start には --channel-pack / MCP の channelPackPath が要る）" };
    blockers.push({ code: "channel-pack-missing", detail: packResult.detail });
  } else if (channelPack.status !== "readable") {
    packResult = { status: "unreadable", detail: channelPack.detail || "Channel Pack を読めない" };
    blockers.push({ code: "channel-pack-unreadable", detail: packResult.detail });
  } else if (channelPack.signature === "invalid") {
    packResult = { status: "signature-invalid", detail: "Channel Pack の署名または中身の照合に失敗した" };
    blockers.push({ code: "channel-pack-signature-invalid", detail: packResult.detail });
  } else if (channelPack.targetHarnessId !== view.harnessId) {
    packResult = { status: "other-harness", detail: `この Channel Pack は ${channelPack.targetHarnessId || "(対象の記載なし)"} 向けなので、このハーネスでは使えない` };
    blockers.push({ code: "channel-pack-other-harness", detail: packResult.detail });
  } else {
    packResult = {
      status: "ok",
      detail: `この Channel Pack は ${view.harnessId} 向け（${channelPack.signature === "verified" ? "署名確認済み" : "署名は未確認。信頼鍵 BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY が無い"}）`,
    };
  }

  return {
    status: blockers.length === 0 ? "ok" : "blocked",
    script: scriptResult,
    startOptions: {
      required: view.inputs.startOptions.map((entry) => ({ key: entry.key, cliFlag: entry.cliFlag })),
      missing: missingOptions.map((entry) => entry.key),
    },
    channelPack: packResult,
    blockers,
  };
}

/**
 * doctor の結果を、能力カードの前提と突き合わせて要約する。
 * job-prepare の項目は Job の prepare（署名 Pack の検証）で初めて決まるので、Job の前の doctor で
 * 落ちていても「足りない」とは数えず、prepare で確かめる項目として分けて返す。
 */
export function summarizePrerequisites(view, doctorReport = null) {
  const required = view.prerequisites.filter((entry) => entry.conditional !== true).map((entry) => entry.doctorCheckId);
  const conditional = view.prerequisites.filter((entry) => entry.conditional === true).map((entry) => entry.doctorCheckId);
  const howToCheck = `node scripts/harness-doctor.mjs --harness ${view.harnessId} --json`;
  if (!doctorReport) {
    return {
      status: "not-checked",
      required,
      conditional,
      howToCheck,
      detail: "未確認（plan-request --doctor / MCP の checkPrerequisites: true で確かめる。start でも doctor が必ず走る）",
    };
  }
  const stageOf = new Map(view.prerequisites.map((entry) => [entry.doctorCheckId, entry.checkedAt]));
  const checks = new Map((doctorReport.checks || []).map((check) => [check.id, check]));
  const blocking = Array.isArray(doctorReport.blocking) ? doctorReport.blocking : [];
  const missing = blocking
    .filter((id) => stageOf.get(id) !== "job-prepare")
    .map((id) => ({ id, detail: String(checks.get(id)?.detail || ""), fix: String(checks.get(id)?.fix || "") }));
  const deferred = blocking.filter((id) => stageOf.get(id) === "job-prepare");
  return {
    status: missing.length > 0 ? "missing" : "ready",
    required,
    conditional,
    missing,
    checkedAtJobPrepare: deferred,
    howToCheck,
    detail: missing.length > 0
      ? `足りない: ${missing.map((entry) => entry.id).join(", ")}`
      : deferred.length > 0
        ? `Job の前に確かめられる項目は揃っている（${deferred.join(", ")} は Job の prepare で確かめる）`
        : "揃っている",
  };
}
