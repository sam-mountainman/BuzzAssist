/**
 * 戦略ブリーフ（buzzassist-strategy-brief-v1）。企画の判断の結果を制作へ渡す形。
 *
 * 企画の判断（何を作るか・なぜ作るか）は、BuzzAssist の外で運営者が保守する戦略の道具が、ホストの
 * エージェントの中で行う。BuzzAssist はその結果を「ブリーフ」として受け取り、形を検査し、根拠の
 * ファイルを照合し、品質ループ（lib/strategyBriefQualityLoop.mjs）で記録して制作へ渡す。ここには
 * 戦略の道具の中身（手順・文面）を持たない。持つのは形と、ファイルの SHA と、機械で決まる照合だけ。
 *
 * 守ること:
 *   - 根拠は作業フォルダからの相対パスと sha256 で指す。絶対パス・ドライブ名・.. は受けない
 *     （ブリーフは作業フォルダの外へ持ち出されうるので、端末の置き場を書かせない）
 *   - 根拠の状態は verified / provisional / unverified の3つ。verified には確かめ方（verification.method）が要る
 *   - 「動画の問い・見る人・入口の約束」（前提）を変えたら、その前提で集めた根拠は古い（stale）。
 *     日数では決めない。前提の digest の食い違いで決める
 *   - 視聴者の4分析の run は report-manifest.json が現行（今の結果と一致）のときだけ根拠になる
 *   - 数字の解釈はしない。形と照合だけ
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export const STRATEGY_BRIEF_VERSION = "buzzassist-strategy-brief-v1";

/** 根拠の状態。並びは確かさの順（後ろほど確か）。 */
export const EVIDENCE_STATES = Object.freeze(["unverified", "provisional", "verified"]);
/** 根拠の種類。形を機械で確かめられるのは snapshot / audience-run / metrics / referrals。 */
export const EVIDENCE_KINDS = Object.freeze([
  "snapshot",
  "audience-run",
  "metrics",
  "referrals",
  "production-instructions",
  "market-research",
  "other",
]);
export const ENTRY_SURFACES = Object.freeze(["title", "thumbnail", "opening"]);
export const PRODUCTION_FORMATS = Object.freeze(["long", "short", "live"]);
export const BRIEF_HOSTS = Object.freeze(["claude-code", "codex", "antigravity", "cursor", "human", "other"]);
export const METRIC_COMPARATORS = Object.freeze([">=", ">", "<=", "<"]);
/** 前提（これを変えたら、その前提で集めた根拠は古い）。 */
export const PREMISE_FIELDS = Object.freeze(["question", "audience", "entryPromises"]);

/**
 * 公開後に見る指標の名前。取り出し元の JSON の形（analyze_metrics の schema "1.1"、analyze_referrals の
 * schema "1.0"）の欄に対応する。ここに無い名前は受けない（無い欄から推測で数字を作らない）。
 */
export const POST_PUBLISH_METRICS = Object.freeze({
  metrics: Object.freeze({
    group: Object.freeze([
      "views",
      "median_views_observed",
      "impressions",
      "watch_time_hours",
      "estimated_weighted_ctr_pct",
      "end_screen_element_ctr_pct",
    ]),
    video: Object.freeze([
      "views",
      "impressions",
      "ctr_pct",
      "watch_time_hours",
      "end_screen_element_impressions",
      "end_screen_element_clicks",
    ]),
  }),
  referrals: Object.freeze([
    "self_share_pct",
    "external_share_pct",
    "unresolved_share_pct",
    "external_share_excluding_self_pct",
    "observed_all_views",
    "reported_all_views",
    "report_views_covered_pct",
  ]),
});
export const METRICS_COMPARISON_KEYS = Object.freeze(["format", "window", "traffic_source", "metric_definition"]);
export const REFERRALS_CONTEXT_KEYS = Object.freeze([
  "scope_id", "period_start", "period_end", "timezone", "format", "traffic_source", "metric_definition",
]);

/** スキーマ（config/strategy-brief.schema.json）と同じ欄の一覧。試験が突き合わせる。 */
export const STRATEGY_BRIEF_FIELDS = Object.freeze({
  top: Object.freeze(["version", "label", "channel", "question", "audience", "entry", "payoffs", "evidence", "changes", "production", "postPublish", "provenance"]),
  channel: Object.freeze(["id", "designVersion"]),
  audience: Object.freeze(["who", "whyWatch"]),
  entry: Object.freeze(["promises"]),
  promise: Object.freeze(["id", "surface", "text"]),
  payoff: Object.freeze(["promiseId", "where", "locator"]),
  evidence: Object.freeze(["id", "kind", "path", "sha256", "state", "collected", "verification", "premiseBound", "premiseIndependenceReason", "note"]),
  collected: Object.freeze(["at", "conditions", "premise"]),
  collectedPremise: Object.freeze(["digest", "question", "audience", "entryPromises"]),
  verification: Object.freeze(["method", "by"]),
  changes: Object.freeze(["previous", "keep", "change"]),
  previous: Object.freeze(["label", "sha256"]),
  changePoint: Object.freeze(["point", "evidenceIds"]),
  production: Object.freeze(["harnessId", "format", "conditions", "targetDurationSeconds"]),
  postPublish: Object.freeze(["metrics"]),
  metric: Object.freeze(["id", "source", "metric", "comparison", "videoId", "context", "expectation", "expected", "promiseIds"]),
  expected: Object.freeze(["comparator", "value"]),
  provenance: Object.freeze(["host", "contextId", "createdAt", "strategySkill"]),
  strategySkill: Object.freeze(["fingerprint", "fileCount"]),
});

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CONTEXT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const ITEM_ID = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const HARNESS_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/u;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function charLength(value) {
  return Array.from(String(value ?? "")).length;
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// 形の検査

function textIssue(issues, field, value, { min = 4, max = 300, required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) issues.push(`missing:${field}`);
    return;
  }
  if (typeof value !== "string") {
    issues.push(`not-text:${field}`);
    return;
  }
  const length = charLength(value.trim());
  if (length < min) issues.push(`too-short:${field}`);
  if (length > max) issues.push(`too-long:${field}`);
}

function unknownKeys(issues, field, value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`unknown-field:${field ? `${field}.` : ""}${key}`);
  }
}

function patternIssue(issues, field, value, pattern, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) issues.push(`missing:${field}`);
    return;
  }
  if (typeof value !== "string" || !pattern.test(value)) issues.push(`invalid:${field}`);
}

function timestampIssue(issues, field, value, { allowUnknown = false } = {}) {
  if (value === undefined || value === null) {
    issues.push(`missing:${field}`);
    return;
  }
  if (typeof value !== "string") {
    issues.push(`invalid:${field}`);
    return;
  }
  if (allowUnknown && value === "unknown") return;
  if (!(DATE_ONLY.test(value) || /T/u.test(value)) || !Number.isFinite(Date.parse(value))) issues.push(`invalid:${field}`);
}

/**
 * 根拠のパス（作業フォルダからの相対）を検査して、`/` 区切りの形へそろえる。Windows の `\` 区切りは
 * 受けて `/` へ直す。絶対パス（POSIX・Windows のドライブ名・UNC）と `..` は受けない。
 */
export function normalizeEvidenceRelPath(value) {
  if (typeof value !== "string") return { ok: false, reason: "not-text" };
  const raw = value.trim();
  if (!raw || raw.includes("\u0000")) return { ok: false, reason: "empty" };
  if (path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw) || /^[A-Za-z]:/u.test(raw) || raw.startsWith("\\\\")) {
    return { ok: false, reason: "absolute" };
  }
  const segments = raw.replace(/\\/gu, "/").split("/").filter((segment) => segment && segment !== ".");
  if (segments.length === 0) return { ok: false, reason: "empty" };
  if (segments.some((segment) => segment === "..")) return { ok: false, reason: "escapes-work-dir" };
  return { ok: true, rel: segments.join("/"), segments };
}

/** 作業フォルダの中の実体のパス。外へ出るものは例外にする。 */
export function resolveEvidencePath(workDir, relPath) {
  const normalized = normalizeEvidenceRelPath(relPath);
  if (!normalized.ok) {
    const error = new Error(`根拠のパスは作業フォルダからの相対パスにする（${normalized.reason}）: ${String(relPath).slice(0, 200)}`);
    error.code = "strategy-evidence-path-invalid";
    throw error;
  }
  const root = path.resolve(workDir);
  const full = path.join(root, ...normalized.segments);
  const rel = path.relative(root, full);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    const error = new Error(`根拠のパスが作業フォルダの外を指している: ${normalized.rel}`);
    error.code = "strategy-evidence-path-invalid";
    throw error;
  }
  return { full, rel: normalized.rel };
}

/** 作業フォルダの中の実体のパスを、作業フォルダからの相対（`/` 区切り）へ。外なら null。 */
export function workDirRelative(workDir, fullPath) {
  const rel = path.relative(path.resolve(workDir), path.resolve(fullPath));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

function validateEvidenceRow(row, index, issues) {
  const field = `evidence[${index}]`;
  if (!plainObject(row)) {
    issues.push(`invalid:${field}`);
    return;
  }
  unknownKeys(issues, field, row, STRATEGY_BRIEF_FIELDS.evidence);
  patternIssue(issues, `${field}.id`, row.id, ITEM_ID);
  if (!EVIDENCE_KINDS.includes(row.kind)) issues.push(`invalid:${field}.kind`);
  const normalized = normalizeEvidenceRelPath(row.path);
  if (!normalized.ok) issues.push(`invalid:${field}.path:${normalized.reason}`);
  patternIssue(issues, `${field}.sha256`, row.sha256, SHA256);
  if (!EVIDENCE_STATES.includes(row.state)) issues.push(`invalid:${field}.state`);
  if (!plainObject(row.collected)) issues.push(`missing:${field}.collected`);
  else {
    unknownKeys(issues, `${field}.collected`, row.collected, STRATEGY_BRIEF_FIELDS.collected);
    timestampIssue(issues, `${field}.collected.at`, row.collected.at, { allowUnknown: true });
    textIssue(issues, `${field}.collected.conditions`, row.collected.conditions, { min: 2, max: 500 });
    if (row.collected.premise !== undefined) {
      const premise = row.collected.premise;
      if (!plainObject(premise)) issues.push(`invalid:${field}.collected.premise`);
      else {
        unknownKeys(issues, `${field}.collected.premise`, premise, STRATEGY_BRIEF_FIELDS.collectedPremise);
        patternIssue(issues, `${field}.collected.premise.digest`, premise.digest, SHA256);
        for (const key of PREMISE_FIELDS) {
          patternIssue(issues, `${field}.collected.premise.${key}`, premise[key], SHA256, { required: false });
        }
      }
    }
  }
  if (row.verification !== undefined) {
    if (!plainObject(row.verification)) issues.push(`invalid:${field}.verification`);
    else {
      unknownKeys(issues, `${field}.verification`, row.verification, STRATEGY_BRIEF_FIELDS.verification);
      textIssue(issues, `${field}.verification.method`, row.verification.method);
      textIssue(issues, `${field}.verification.by`, row.verification.by, { min: 1, max: 128, required: false });
    }
  }
  // verified と書くなら、何をどう確かめたかが要る。書けないなら provisional のまま。
  if (row.state === "verified" && !plainObject(row.verification)) issues.push(`missing:${field}.verification`);
  if (row.premiseBound !== undefined && typeof row.premiseBound !== "boolean") issues.push(`invalid:${field}.premiseBound`);
  if (row.premiseBound === false) {
    textIssue(issues, `${field}.premiseIndependenceReason`, row.premiseIndependenceReason);
  } else if (row.premiseIndependenceReason !== undefined) {
    issues.push(`unexpected:${field}.premiseIndependenceReason`);
  }
  textIssue(issues, `${field}.note`, row.note, { min: 1, max: 300, required: false });
}

function validateChangePoints(list, field, issues) {
  if (!Array.isArray(list)) {
    issues.push(`missing:${field}`);
    return;
  }
  if (list.length > 30) issues.push(`too-many:${field}`);
  list.forEach((entry, index) => {
    const item = `${field}[${index}]`;
    if (!plainObject(entry)) {
      issues.push(`invalid:${item}`);
      return;
    }
    unknownKeys(issues, item, entry, STRATEGY_BRIEF_FIELDS.changePoint);
    textIssue(issues, `${item}.point`, entry.point);
    if (!Array.isArray(entry.evidenceIds)) issues.push(`missing:${item}.evidenceIds`);
    else entry.evidenceIds.forEach((id, idIndex) => patternIssue(issues, `${item}.evidenceIds[${idIndex}]`, id, ITEM_ID));
  });
}

function validateMetricRow(row, index, issues) {
  const field = `postPublish.metrics[${index}]`;
  if (!plainObject(row)) {
    issues.push(`invalid:${field}`);
    return;
  }
  unknownKeys(issues, field, row, STRATEGY_BRIEF_FIELDS.metric);
  patternIssue(issues, `${field}.id`, row.id, ITEM_ID);
  if (!["metrics", "referrals"].includes(row.source)) issues.push(`invalid:${field}.source`);
  if (row.source === "metrics") {
    const allowed = nonEmpty(row.videoId) ? POST_PUBLISH_METRICS.metrics.video : POST_PUBLISH_METRICS.metrics.group;
    if (!allowed.includes(row.metric)) issues.push(`invalid:${field}.metric`);
    if (!plainObject(row.comparison)) issues.push(`missing:${field}.comparison`);
    else {
      unknownKeys(issues, `${field}.comparison`, row.comparison, METRICS_COMPARISON_KEYS);
      for (const key of METRICS_COMPARISON_KEYS) textIssue(issues, `${field}.comparison.${key}`, row.comparison[key], { min: 1, max: 200 });
    }
    if (row.context !== undefined) issues.push(`unexpected:${field}.context`);
  } else if (row.source === "referrals") {
    if (!POST_PUBLISH_METRICS.referrals.includes(row.metric)) issues.push(`invalid:${field}.metric`);
    if (row.comparison !== undefined) issues.push(`unexpected:${field}.comparison`);
    if (row.videoId !== undefined) issues.push(`unexpected:${field}.videoId`);
    if (row.context !== undefined) {
      if (!plainObject(row.context)) issues.push(`invalid:${field}.context`);
      else {
        unknownKeys(issues, `${field}.context`, row.context, REFERRALS_CONTEXT_KEYS);
        for (const [key, value] of Object.entries(row.context)) textIssue(issues, `${field}.context.${key}`, value, { min: 1, max: 200 });
      }
    }
  }
  if (row.videoId !== undefined) textIssue(issues, `${field}.videoId`, row.videoId, { min: 1, max: 64 });
  textIssue(issues, `${field}.expectation`, row.expectation);
  if (row.expected !== undefined) {
    if (!plainObject(row.expected)) issues.push(`invalid:${field}.expected`);
    else {
      unknownKeys(issues, `${field}.expected`, row.expected, STRATEGY_BRIEF_FIELDS.expected);
      if (!METRIC_COMPARATORS.includes(row.expected.comparator)) issues.push(`invalid:${field}.expected.comparator`);
      if (typeof row.expected.value !== "number" || !Number.isFinite(row.expected.value)) issues.push(`invalid:${field}.expected.value`);
    }
  }
  if (row.promiseIds !== undefined) {
    if (!Array.isArray(row.promiseIds)) issues.push(`invalid:${field}.promiseIds`);
    else row.promiseIds.forEach((id, idIndex) => patternIssue(issues, `${field}.promiseIds[${idIndex}]`, id, ITEM_ID));
  }
}

/**
 * 形の検査。issues は欄の形の誤り、linkIssues は欄どうしの対応の誤り（約束と回収、変更と根拠など）。
 * どちらも空のときだけ ok。例外は投げない。
 */
export function validateStrategyBrief(brief) {
  const issues = [];
  if (!plainObject(brief)) return { ok: false, issues: ["not-an-object"], linkIssues: [] };
  unknownKeys(issues, "", brief, STRATEGY_BRIEF_FIELDS.top);
  if (brief.version !== STRATEGY_BRIEF_VERSION) issues.push("invalid:version");
  patternIssue(issues, "label", brief.label, LABEL);

  if (!plainObject(brief.channel)) issues.push("missing:channel");
  else {
    unknownKeys(issues, "channel", brief.channel, STRATEGY_BRIEF_FIELDS.channel);
    patternIssue(issues, "channel.id", brief.channel.id, LABEL);
    patternIssue(issues, "channel.designVersion", brief.channel.designVersion, LABEL);
  }
  textIssue(issues, "question", brief.question, { max: 400 });
  if (!plainObject(brief.audience)) issues.push("missing:audience");
  else {
    unknownKeys(issues, "audience", brief.audience, STRATEGY_BRIEF_FIELDS.audience);
    textIssue(issues, "audience.who", brief.audience.who);
    textIssue(issues, "audience.whyWatch", brief.audience.whyWatch);
  }
  if (!plainObject(brief.entry)) issues.push("missing:entry");
  else {
    unknownKeys(issues, "entry", brief.entry, STRATEGY_BRIEF_FIELDS.entry);
    if (!Array.isArray(brief.entry.promises) || brief.entry.promises.length === 0) issues.push("missing:entry.promises");
    else {
      if (brief.entry.promises.length > 12) issues.push("too-many:entry.promises");
      brief.entry.promises.forEach((promise, index) => {
        const field = `entry.promises[${index}]`;
        if (!plainObject(promise)) {
          issues.push(`invalid:${field}`);
          return;
        }
        unknownKeys(issues, field, promise, STRATEGY_BRIEF_FIELDS.promise);
        patternIssue(issues, `${field}.id`, promise.id, ITEM_ID);
        if (!ENTRY_SURFACES.includes(promise.surface)) issues.push(`invalid:${field}.surface`);
        textIssue(issues, `${field}.text`, promise.text, { min: 2, max: 200 });
      });
    }
  }
  if (!Array.isArray(brief.payoffs) || brief.payoffs.length === 0) issues.push("missing:payoffs");
  else {
    brief.payoffs.forEach((payoff, index) => {
      const field = `payoffs[${index}]`;
      if (!plainObject(payoff)) {
        issues.push(`invalid:${field}`);
        return;
      }
      unknownKeys(issues, field, payoff, STRATEGY_BRIEF_FIELDS.payoff);
      patternIssue(issues, `${field}.promiseId`, payoff.promiseId, ITEM_ID);
      textIssue(issues, `${field}.where`, payoff.where);
      textIssue(issues, `${field}.locator`, payoff.locator, { min: 1, max: 200, required: false });
    });
  }
  if (!Array.isArray(brief.evidence)) issues.push("missing:evidence");
  else {
    if (brief.evidence.length > 100) issues.push("too-many:evidence");
    brief.evidence.forEach((row, index) => validateEvidenceRow(row, index, issues));
  }
  if (!plainObject(brief.changes)) issues.push("missing:changes");
  else {
    unknownKeys(issues, "changes", brief.changes, STRATEGY_BRIEF_FIELDS.changes);
    if (brief.changes.previous === undefined) issues.push("missing:changes.previous");
    else if (brief.changes.previous !== null) {
      if (!plainObject(brief.changes.previous)) issues.push("invalid:changes.previous");
      else {
        unknownKeys(issues, "changes.previous", brief.changes.previous, STRATEGY_BRIEF_FIELDS.previous);
        patternIssue(issues, "changes.previous.label", brief.changes.previous.label, LABEL);
        patternIssue(issues, "changes.previous.sha256", brief.changes.previous.sha256, SHA256);
      }
    }
    validateChangePoints(brief.changes.keep, "changes.keep", issues);
    validateChangePoints(brief.changes.change, "changes.change", issues);
  }
  if (!plainObject(brief.production)) issues.push("missing:production");
  else {
    unknownKeys(issues, "production", brief.production, STRATEGY_BRIEF_FIELDS.production);
    patternIssue(issues, "production.harnessId", brief.production.harnessId, HARNESS_ID, { required: false });
    if (!PRODUCTION_FORMATS.includes(brief.production.format)) issues.push("invalid:production.format");
    if (!Array.isArray(brief.production.conditions) || brief.production.conditions.length === 0) issues.push("missing:production.conditions");
    else {
      if (brief.production.conditions.length > 30) issues.push("too-many:production.conditions");
      brief.production.conditions.forEach((entry, index) => textIssue(issues, `production.conditions[${index}]`, entry, { min: 2, max: 300 }));
    }
    const duration = brief.production.targetDurationSeconds;
    if (duration !== undefined && (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0)) {
      issues.push("invalid:production.targetDurationSeconds");
    }
  }
  if (!plainObject(brief.postPublish)) issues.push("missing:postPublish");
  else {
    unknownKeys(issues, "postPublish", brief.postPublish, STRATEGY_BRIEF_FIELDS.postPublish);
    if (!Array.isArray(brief.postPublish.metrics) || brief.postPublish.metrics.length === 0) issues.push("missing:postPublish.metrics");
    else brief.postPublish.metrics.forEach((row, index) => validateMetricRow(row, index, issues));
  }
  if (!plainObject(brief.provenance)) issues.push("missing:provenance");
  else {
    unknownKeys(issues, "provenance", brief.provenance, STRATEGY_BRIEF_FIELDS.provenance);
    if (!BRIEF_HOSTS.includes(brief.provenance.host)) issues.push("invalid:provenance.host");
    patternIssue(issues, "provenance.contextId", brief.provenance.contextId, CONTEXT_ID);
    timestampIssue(issues, "provenance.createdAt", brief.provenance.createdAt);
    if (brief.provenance.strategySkill !== undefined) {
      const skill = brief.provenance.strategySkill;
      if (!plainObject(skill)) issues.push("invalid:provenance.strategySkill");
      else {
        unknownKeys(issues, "provenance.strategySkill", skill, STRATEGY_BRIEF_FIELDS.strategySkill);
        patternIssue(issues, "provenance.strategySkill.fingerprint", skill.fingerprint, FINGERPRINT);
        if (skill.fileCount !== undefined && (!Number.isInteger(skill.fileCount) || skill.fileCount < 1)) {
          issues.push("invalid:provenance.strategySkill.fileCount");
        }
      }
    }
  }
  const linkIssues = issues.length === 0 ? strategyBriefLinkIssues(brief) : [];
  return { ok: issues.length === 0 && linkIssues.length === 0, issues, linkIssues };
}

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

/**
 * 欄どうしの対応。形の検査が通った brief にだけ意味がある。
 *   - 入口の約束には本文の回収が1つ以上あり、回収は知られた約束を指す
 *   - 残す点・変える点は1つ以上の根拠を指し、指した根拠はこの brief にある
 *   - 公開後の指標が指す約束はこの brief にある
 */
export function strategyBriefLinkIssues(brief) {
  const issues = [];
  const promiseIds = brief.entry.promises.map((row) => row.id);
  const evidenceIds = brief.evidence.map((row) => row.id);
  const metricIds = brief.postPublish.metrics.map((row) => row.id);
  for (const id of duplicates(promiseIds)) issues.push(`link:duplicate-promise-id:${id}`);
  for (const id of duplicates(evidenceIds)) issues.push(`link:duplicate-evidence-id:${id}`);
  for (const id of duplicates(metricIds)) issues.push(`link:duplicate-metric-id:${id}`);
  const promises = new Set(promiseIds);
  const evidence = new Set(evidenceIds);
  const paidOff = new Set();
  for (const payoff of brief.payoffs) {
    if (!promises.has(payoff.promiseId)) issues.push(`link:payoff-unknown-promise:${payoff.promiseId}`);
    else paidOff.add(payoff.promiseId);
  }
  for (const id of promiseIds) if (!paidOff.has(id)) issues.push(`link:promise-without-payoff:${id}`);
  for (const [kind, list] of [["keep", brief.changes.keep], ["change", brief.changes.change]]) {
    list.forEach((entry, index) => {
      if (entry.evidenceIds.length === 0) issues.push(`link:${kind}-without-evidence:${index}`);
      for (const id of entry.evidenceIds) if (!evidence.has(id)) issues.push(`link:${kind}-unknown-evidence:${id}`);
    });
  }
  for (const row of brief.postPublish.metrics) {
    for (const id of row.promiseIds || []) if (!promises.has(id)) issues.push(`link:metric-unknown-promise:${row.id}:${id}`);
  }
  return [...new Set(issues)];
}

/** ブリーフのファイルを読む。JSON として読めなければ parsed は null。 */
export async function readStrategyBrief(file) {
  const bytes = await readFile(path.resolve(file));
  let brief = null;
  let parseError = "";
  try {
    brief = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    parseError = String(error?.message || error).slice(0, 200);
  }
  return { bytes, sha256: sha256Hex(bytes), brief, parseError };
}

// ---------------------------------------------------------------------------
// 前提（動画の問い・見る人・入口の約束）

function normalizeText(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

/** 前提の欄だけを取り出して正規化する（全角・半角、空白の揺れでは変わらない）。 */
export function strategyBriefPremise(brief) {
  return {
    question: normalizeText(brief?.question),
    audience: {
      who: normalizeText(brief?.audience?.who),
      whyWatch: normalizeText(brief?.audience?.whyWatch),
    },
    entryPromises: [...(Array.isArray(brief?.entry?.promises) ? brief.entry.promises : [])]
      .map((row) => ({ id: String(row?.id ?? ""), surface: String(row?.surface ?? ""), text: normalizeText(row?.text) }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

/** 前提の digest。欄ごとと、全体（digest）。 */
export function strategyBriefPremiseDigests(brief) {
  const premise = strategyBriefPremise(brief);
  return {
    digest: sha256Hex(canonicalJson(premise)),
    question: sha256Hex(canonicalJson(premise.question)),
    audience: sha256Hex(canonicalJson(premise.audience)),
    entryPromises: sha256Hex(canonicalJson(premise.entryPromises)),
  };
}

/** 2つの前提の digest の組から、変わった欄の名前。片方に欄の digest が無ければ、全体が違うとき全部と見なす。 */
export function premiseChangedFields(before, after) {
  if (!before || !after) return [];
  if (before.digest && after.digest && before.digest === after.digest) return [];
  const fields = PREMISE_FIELDS.filter((key) => before[key] && after[key] && before[key] !== after[key]);
  if (fields.length > 0) return fields;
  const comparable = PREMISE_FIELDS.some((key) => before[key] && after[key]);
  return comparable ? [] : [...PREMISE_FIELDS];
}

export const STALE_PREMISE_REASON_CODE = "strategy-evidence-stale-premise";
export const EVIDENCE_REFRESH_REQUIRED_CODE = "strategy-evidence-refresh-required";

/**
 * 前提が変わって古くなった根拠。日数では決めない。
 *
 * 根拠の行は、集めたときの前提に結び付く:
 *   1. 行に書かれた collected.premise（前のブリーフから引き継いだ行など）
 *   2. 無ければ boundPremiseFor(row)（品質ループの記録で、この行が最初に現れた版の前提）
 *   3. どちらも無ければ、今の版の前提（この版で集めた新しい根拠）
 * premiseBound: false の行（公開済みの動画の実測など、前提に依らないと理由つきで宣言した行）は古くならない。
 */
export function evidencePremiseStaleness(brief, { boundPremiseFor = () => null } = {}) {
  const current = strategyBriefPremiseDigests(brief);
  const stale = [];
  for (const row of Array.isArray(brief?.evidence) ? brief.evidence : []) {
    if (row?.premiseBound === false) continue;
    const explicit = plainObject(row?.collected?.premise) && SHA256.test(String(row.collected.premise.digest || ""))
      ? row.collected.premise
      : null;
    const bound = explicit || boundPremiseFor(row) || null;
    if (!bound || bound.digest === current.digest) continue;
    stale.push({
      id: String(row.id ?? ""),
      kind: String(row.kind ?? ""),
      path: String(row.path ?? ""),
      reasonCode: STALE_PREMISE_REASON_CODE,
      boundPremiseDigest: bound.digest,
      boundBy: explicit ? "collected.premise" : "quality-loop-history",
      changedFields: premiseChangedFields(bound, current),
    });
  }
  return {
    premise: current,
    stale,
    refreshRequired: stale.length > 0,
    ...(stale.length > 0 ? { reasonCode: EVIDENCE_REFRESH_REQUIRED_CODE } : {}),
  };
}

/** 前の版から確かさが上がった根拠（同じ id）。unverified < provisional < verified。 */
export function evidenceStateUpgrades(previousBrief, nextBrief) {
  const rank = (state) => EVIDENCE_STATES.indexOf(state);
  const before = new Map((Array.isArray(previousBrief?.evidence) ? previousBrief.evidence : []).map((row) => [row?.id, row]));
  const upgrades = [];
  for (const row of Array.isArray(nextBrief?.evidence) ? nextBrief.evidence : []) {
    const prior = before.get(row?.id);
    if (!prior) continue;
    if (rank(row.state) > rank(prior.state)) {
      upgrades.push({
        id: String(row.id),
        from: prior.state,
        to: row.state,
        sameFile: prior.sha256 === row.sha256 && normalizeEvidenceRelPath(prior.path).rel === normalizeEvidenceRelPath(row.path).rel,
      });
    }
  }
  return upgrades;
}

// ---------------------------------------------------------------------------
// 根拠のファイルの照合

async function readIfExists(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "EISDIR") return null;
    throw error;
  }
}

function parseJsonBytes(bytes) {
  if (!bytes) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
}

function deepEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

const AUDIENCE_STAGES = Object.freeze(["scenario", "taka", "yako", "emotion"]);
const AUDIENCE_PACKET_FILES = Object.freeze(["input.json", "prompt.md", "rules.md", "task.md"]);

/**
 * 視聴者の4分析の run フォルダ（run.json・completed/*.json・report-manifest.json）が、今の結果と一致した
 * レポートを持つか。戦略の道具のスクリプトは実行せず、ファイルとハッシュだけで確かめる。
 *
 *   current  report-manifest.json が今の入力・結果と一致（根拠に使える）
 *   stale    どこかが食い違う（結果の登録し直し・再分析の後にレポートを作り直していない等）
 *   none     レポートがまだ無い
 *   invalid  run フォルダとして読めない
 */
export async function inspectAudienceRun(runDir) {
  const root = path.resolve(runDir);
  const reasons = [];
  const runBytes = await readIfExists(path.join(root, "run.json"));
  const run = parseJsonBytes(runBytes);
  if (!plainObject(run) || run.schema_version !== 1 || !nonEmpty(run.run_id)) {
    return { status: "invalid", reasons: ["audience-run-manifest-unreadable"] };
  }
  const base = { runId: run.run_id, createdAt: nonEmpty(run.created_at) || null };
  const snapshotBytes = await readIfExists(path.join(root, "snapshot.json"));
  const snapshot = parseJsonBytes(snapshotBytes);
  if (!snapshotBytes || sha256Hex(snapshotBytes) !== run.snapshot_sha256 || !plainObject(snapshot)) {
    return { ...base, status: "stale", reasons: ["audience-run-snapshot-changed"] };
  }
  const videoId = nonEmpty(snapshot.video_id) || null;
  const reportBytes = await readIfExists(path.join(root, "report.md"));
  const manifestBytes = await readIfExists(path.join(root, "report-manifest.json"));
  if (!reportBytes && !manifestBytes) return { ...base, videoId, status: "none", reasons: ["audience-run-report-missing"] };
  if (!reportBytes || !manifestBytes) return { ...base, videoId, status: "stale", reasons: ["audience-run-report-incomplete"] };
  const manifest = parseJsonBytes(manifestBytes);
  const reportManifestSha256 = sha256Hex(manifestBytes);
  const result = { ...base, videoId, reportManifestSha256, reportSha256: sha256Hex(reportBytes) };
  if (!plainObject(manifest) || manifest.run_id !== run.run_id || !plainObject(manifest.outputs) || !plainObject(manifest.stages)) {
    return { ...result, status: "stale", reasons: ["audience-run-report-manifest-mismatch"] };
  }
  if (manifest.report_sha256 !== result.reportSha256) reasons.push("audience-run-report-changed");

  const completeStages = AUDIENCE_STAGES.filter((stage) => manifest.stages?.[stage]?.status === "complete");
  const outputStages = Object.keys(manifest.outputs).sort();
  if (!deepEqual(outputStages, [...completeStages].sort())) reasons.push("audience-run-report-outputs-mismatch");

  const verified = new Map();
  for (const stage of AUDIENCE_STAGES) {
    const receiptBytes = await readIfExists(path.join(root, "completed", `${stage}.json`));
    const complete = completeStages.includes(stage);
    if (!complete) {
      // レポートの後に完了を登録した分析がある（レポートは今の結果を載せていない）。
      if (receiptBytes) reasons.push(`audience-run-stage-completed-after-report:${stage}`);
      continue;
    }
    const receipt = parseJsonBytes(receiptBytes);
    if (!plainObject(receipt)) {
      reasons.push(`audience-run-stage-receipt-missing:${stage}`);
      continue;
    }
    if (receipt.output_sha256 !== manifest.outputs[stage]) reasons.push(`audience-run-stage-output-mismatch:${stage}`);
    const resultFile = String(receipt.result_file || "");
    if (!new RegExp(`^${stage}-[a-f0-9]{32}\\.md$`, "u").test(resultFile)) {
      reasons.push(`audience-run-stage-result-name-invalid:${stage}`);
      continue;
    }
    const resultBytes = await readIfExists(path.join(root, "results", resultFile));
    if (!resultBytes || !resultBytes.toString("utf8").trim() || sha256Hex(resultBytes) !== receipt.output_sha256) {
      reasons.push(`audience-run-stage-result-changed:${stage}`);
      continue;
    }
    const stageDir = path.join(root, "stages", stage);
    const packetBytes = await readIfExists(path.join(stageDir, "packet.json"));
    const packet = parseJsonBytes(packetBytes);
    if (!plainObject(packet) || sha256Hex(packetBytes) !== receipt.packet_sha256
      || packet.run_id !== run.run_id || packet.stage !== stage || !plainObject(packet.files)
      || !deepEqual(Object.keys(packet.files).sort(), [...AUDIENCE_PACKET_FILES])) {
      reasons.push(`audience-run-stage-packet-mismatch:${stage}`);
      continue;
    }
    let packetOk = true;
    const files = {};
    for (const name of AUDIENCE_PACKET_FILES) {
      const bytes = await readIfExists(path.join(stageDir, name));
      if (!bytes || sha256Hex(bytes) !== packet.files[name]) {
        packetOk = false;
        break;
      }
      files[name] = bytes;
    }
    if (!packetOk || packet.files["prompt.md"] !== run.prompt_hashes?.[stage] || packet.files["rules.md"] !== run.rules_sha256) {
      reasons.push(`audience-run-stage-packet-changed:${stage}`);
      continue;
    }
    // 入力の中身が今の取得スナップショット（感情は今のシナリオ・たかの結果）と同じか。
    const input = parseJsonBytes(files["input.json"]);
    let inputOk = plainObject(input);
    if (inputOk && stage === "emotion") {
      for (const dependency of ["scenario", "taka"]) {
        const expected = verified.get(dependency);
        const given = input.analyses?.[dependency];
        if (!expected || !plainObject(given) || given.output_sha256 !== expected
          || sha256Hex(Buffer.from(String(given.analysis ?? ""), "utf8")) !== expected) inputOk = false;
      }
    } else if (inputOk) {
      const block = stage === "scenario" ? "transcript" : "comments";
      inputOk = input.video_id === snapshot.video_id && input.fetched_at === snapshot.fetched_at && deepEqual(input[block], snapshot[block]);
    }
    if (!inputOk) {
      reasons.push(`audience-run-stage-input-stale:${stage}`);
      continue;
    }
    verified.set(stage, receipt.output_sha256);
  }
  return {
    ...result,
    completeStages,
    status: reasons.length === 0 ? "current" : "stale",
    reasons,
  };
}

function formatCheck(kind, parsed) {
  if (kind === "metrics") {
    return plainObject(parsed) && parsed.schema_version === "1.1" && Array.isArray(parsed.groups)
      ? { format: "ok", schemaVersion: "1.1" }
      : { format: "unreadable", reasonCode: "strategy-evidence-metrics-format" };
  }
  if (kind === "referrals") {
    return plainObject(parsed) && parsed.schema_version === "1.0" && plainObject(parsed.categories)
      ? { format: "ok", schemaVersion: "1.0" }
      : { format: "unreadable", reasonCode: "strategy-evidence-referrals-format" };
  }
  if (kind === "snapshot") {
    return plainObject(parsed) && parsed.schema_version === 1 && nonEmpty(parsed.video_id)
      ? { format: "ok", schemaVersion: 1 }
      : { format: "unreadable", reasonCode: "strategy-evidence-snapshot-format" };
  }
  return { format: "not-checked" };
}

/**
 * 1つの根拠の行を、作業フォルダの実体と照合する。視聴者の4分析の run（kind: audience-run）は、
 * path が run フォルダ、sha256 が report-manifest.json の SHA で、レポートが現行であることまで見る。
 */
export async function inspectStrategyEvidence(workDir, row) {
  const out = { id: String(row?.id ?? ""), kind: String(row?.kind ?? ""), state: String(row?.state ?? ""), reasonCodes: [] };
  let resolved;
  try {
    resolved = resolveEvidencePath(workDir, row?.path);
  } catch {
    return { ...out, exists: false, sha256Matches: false, reasonCodes: ["strategy-evidence-path-invalid"] };
  }
  out.path = resolved.rel;
  if (row.kind === "audience-run") {
    const manifestBytes = await readIfExists(path.join(resolved.full, "report-manifest.json"));
    if (!manifestBytes) {
      const info = await stat(resolved.full).catch(() => null);
      return { ...out, exists: Boolean(info), sha256Matches: false, reasonCodes: [info ? "strategy-evidence-audience-run-report-missing" : "strategy-evidence-missing"] };
    }
    const audienceRun = await inspectAudienceRun(resolved.full);
    out.exists = true;
    out.sha256Matches = sha256Hex(manifestBytes) === row.sha256;
    out.audienceRun = { status: audienceRun.status, reasons: audienceRun.reasons, completeStages: audienceRun.completeStages || [] };
    out.format = audienceRun.status === "invalid" ? "unreadable" : "ok";
    if (!out.sha256Matches) out.reasonCodes.push("strategy-evidence-changed");
    if (audienceRun.status === "invalid") out.reasonCodes.push("strategy-evidence-audience-run-unreadable");
    else if (audienceRun.status !== "current") out.reasonCodes.push("strategy-evidence-audience-run-stale");
    return out;
  }
  const bytes = await readIfExists(resolved.full);
  if (!bytes) return { ...out, exists: false, sha256Matches: false, reasonCodes: ["strategy-evidence-missing"] };
  out.exists = true;
  out.sha256Matches = sha256Hex(bytes) === row.sha256;
  if (!out.sha256Matches) out.reasonCodes.push("strategy-evidence-changed");
  const check = formatCheck(row.kind, ["metrics", "referrals", "snapshot"].includes(row.kind) ? parseJsonBytes(bytes) : null);
  out.format = check.format;
  if (check.reasonCode) out.reasonCodes.push(check.reasonCode);
  return out;
}

/** 根拠の行を全部照合する。 */
export async function inspectStrategyEvidenceRows(workDir, brief) {
  const rows = [];
  for (const row of Array.isArray(brief?.evidence) ? brief.evidence : []) rows.push(await inspectStrategyEvidence(workDir, row));
  return rows;
}

/** 根拠の状態の数。 */
export function evidenceStateCounts(brief) {
  const counts = Object.fromEntries(EVIDENCE_STATES.map((state) => [state, 0]));
  for (const row of Array.isArray(brief?.evidence) ? brief.evidence : []) {
    if (Object.hasOwn(counts, row?.state)) counts[row.state] += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// 戦略の道具の版の指紋（任意）

/** 指紋に入れるファイル（スキルのフォルダからの相対）。評価の記録・キャッシュは入れない。 */
export const STRATEGY_SKILL_FINGERPRINT_INCLUDE = Object.freeze(["SKILL.md", "scripts/", "references/", "assets/"]);
const FINGERPRINT_EXCLUDED_SEGMENTS = new Set(["__pycache__", ".git", "node_modules", ".DS_Store"]);

async function listFiles(root, dir = root, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (FINGERPRINT_EXCLUDED_SEGMENTS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listFiles(root, full, out);
    else if (entry.isFile() && !entry.name.endsWith(".pyc")) out.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return out;
}

/**
 * 戦略の道具のフォルダの、実行に使うファイルの sha256 の集合から作る版の指紋。中身は読んでハッシュに
 * するだけで、BuzzAssist には何も写さない（返すのは相対パスと sha256 と指紋）。
 */
export async function strategySkillFingerprint(skillDir, { include = STRATEGY_SKILL_FINGERPRINT_INCLUDE } = {}) {
  const root = path.resolve(skillDir);
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error("--skill-dir にはスキルのフォルダを渡す。");
  const selected = (await listFiles(root))
    .filter((rel) => include.some((entry) => (entry.endsWith("/") ? rel.startsWith(entry) : rel === entry)))
    .sort();
  if (selected.length === 0) throw new Error("指紋に入れるファイルが1つも無い（SKILL.md・scripts/・references/・assets/）。");
  const files = [];
  for (const rel of selected) files.push({ path: rel, sha256: sha256Hex(await readFile(path.join(root, ...rel.split("/")))) });
  const body = files.map((row) => `${row.path}\t${row.sha256}\n`).join("");
  return { fingerprint: `sha256:${sha256Hex(body)}`, fileCount: files.length, include: [...include], files };
}
