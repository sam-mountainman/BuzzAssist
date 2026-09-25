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
 *   - 前提は「動画の問い・見る人・制作条件」。前提を変えたら、その前提で集めた根拠は「当てはまりの確認待ち」
 *     （applicability-review-required）になる。上位の AI が根拠ごとに今の前提へ当てはまるかを理由つきで記録し
 *     （evidence[].applicability）、当てはまるなら再利用、当てはまらないならその根拠だけ取り直す
 *     （strategy-evidence-refresh-required:<id>）。入口の約束（表現）を変えただけでは根拠を古くしない。
 *     日数では決めない。前提の digest の食い違いで決める
 *   - 視聴者の4分析の run は report-manifest.json が現行（今の結果と一致）のときだけ根拠になる
 *   - 観測（observations）は根拠の id に結ぶ。仮説（hypotheses）を supported / weakened と書くなら根拠が要る。
 *     未確認事項（openQuestions）を確認済みにするには確かめた根拠の id が要り、前の版で open だった事項なら
 *     その版で新しく足した根拠を指す（claimChangesSince）。blocksProduction の未確認事項が open のまま残る
 *     ブリーフは制作へ渡さない（verdict が止める）
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
  "planning-document",
  "other",
]);
export const ENTRY_SURFACES = Object.freeze(["title", "thumbnail", "opening"]);
export const PRODUCTION_FORMATS = Object.freeze(["long", "short", "live"]);
export const BRIEF_HOSTS = Object.freeze(["claude-code", "codex", "antigravity", "cursor", "human", "other"]);
export const METRIC_COMPARATORS = Object.freeze([">=", ">", "<=", "<"]);
/**
 * 前提（これを変えたら、その前提で集めた根拠に今の前提への当てはまりの確認が要る）。入口の約束は前提に入れない
 * （タイトルや冒頭の言い方を変えただけで、問い・見る人・制作条件が同じなら調査は無効にならない）。
 */
export const PREMISE_FIELDS = Object.freeze(["question", "audience", "production"]);

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

/** 仮説の状態。untested は根拠なしでよく、supported / weakened は根拠の id が1つ以上要る。 */
export const HYPOTHESIS_STATES = Object.freeze(["untested", "supported", "weakened"]);
/** 未確認事項の状態。resolved には確かめた根拠（resolution.evidenceIds）が要る。既定は open。 */
export const OPEN_QUESTION_STATES = Object.freeze(["open", "resolved"]);

/** スキーマ（config/strategy-brief.schema.json）と同じ欄の一覧。試験が突き合わせる。 */
export const STRATEGY_BRIEF_FIELDS = Object.freeze({
  top: Object.freeze([
    "version", "label", "channel", "question", "audience", "entry", "payoffs", "evidence", "changes", "production", "postPublish", "provenance",
    "observations", "hypotheses", "openQuestions",
  ]),
  observation: Object.freeze(["id", "statement", "evidenceIds", "note"]),
  hypothesis: Object.freeze(["id", "statement", "evidenceIds", "status", "note"]),
  openQuestion: Object.freeze(["id", "question", "blocksProduction", "plannedCheck", "status", "resolution"]),
  resolution: Object.freeze(["evidenceIds", "note"]),
  channel: Object.freeze(["id", "designVersion"]),
  audience: Object.freeze(["who", "whyWatch"]),
  entry: Object.freeze(["promises"]),
  promise: Object.freeze(["id", "surface", "text"]),
  payoff: Object.freeze(["promiseId", "where", "locator"]),
  evidence: Object.freeze(["id", "kind", "path", "sha256", "state", "collected", "verification", "premiseBound", "premiseIndependenceReason", "applicability", "note"]),
  collected: Object.freeze(["at", "conditions", "premise"]),
  // entryPromises は前の版の記録（入口の約束を前提に数えていた頃）を読むためだけに受ける。比べない。
  collectedPremise: Object.freeze(["digest", "question", "audience", "production", "entryPromises"]),
  verification: Object.freeze(["method", "by"]),
  applicability: Object.freeze(["premiseDigest", "applies", "reason", "decidedBy", "decidedAt"]),
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
        for (const key of [...PREMISE_FIELDS, "entryPromises"]) {
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
  if (row.applicability !== undefined) {
    const decision = row.applicability;
    if (!plainObject(decision)) issues.push(`invalid:${field}.applicability`);
    else {
      unknownKeys(issues, `${field}.applicability`, decision, STRATEGY_BRIEF_FIELDS.applicability);
      patternIssue(issues, `${field}.applicability.premiseDigest`, decision.premiseDigest, SHA256);
      if (typeof decision.applies !== "boolean") issues.push(`${decision.applies === undefined ? "missing" : "invalid"}:${field}.applicability.applies`);
      textIssue(issues, `${field}.applicability.reason`, decision.reason);
      patternIssue(issues, `${field}.applicability.decidedBy`, decision.decidedBy, CONTEXT_ID, { required: false });
      if (decision.decidedAt !== undefined) timestampIssue(issues, `${field}.applicability.decidedAt`, decision.decidedAt);
    }
    // 前提に依らない根拠には当てはまりの判定を書かない（書くと、前提に依るのか依らないのかが読めない）。
    if (row.premiseBound === false) issues.push(`unexpected:${field}.applicability`);
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

function evidenceIdList(issues, field, value, { min = 0 } = {}) {
  if (!Array.isArray(value)) {
    issues.push(`missing:${field}`);
    return;
  }
  if (value.length < min) issues.push(`missing:${field}`);
  if (value.length > 30) issues.push(`too-many:${field}`);
  value.forEach((id, index) => patternIssue(issues, `${field}[${index}]`, id, ITEM_ID));
}

/** 観測・仮説・未確認事項（どれも任意の欄。書くなら配列）。 */
function validateClaims(brief, issues) {
  if (brief.observations !== undefined) {
    if (!Array.isArray(brief.observations)) issues.push("invalid:observations");
    else {
      if (brief.observations.length > 50) issues.push("too-many:observations");
      brief.observations.forEach((row, index) => {
        const field = `observations[${index}]`;
        if (!plainObject(row)) {
          issues.push(`invalid:${field}`);
          return;
        }
        unknownKeys(issues, field, row, STRATEGY_BRIEF_FIELDS.observation);
        patternIssue(issues, `${field}.id`, row.id, ITEM_ID);
        textIssue(issues, `${field}.statement`, row.statement);
        // 観測は根拠のファイルに結ぶ（何を見てそう言えるか）。
        evidenceIdList(issues, `${field}.evidenceIds`, row.evidenceIds, { min: 1 });
        textIssue(issues, `${field}.note`, row.note, { min: 1, max: 300, required: false });
      });
    }
  }
  if (brief.hypotheses !== undefined) {
    if (!Array.isArray(brief.hypotheses)) issues.push("invalid:hypotheses");
    else {
      if (brief.hypotheses.length > 30) issues.push("too-many:hypotheses");
      brief.hypotheses.forEach((row, index) => {
        const field = `hypotheses[${index}]`;
        if (!plainObject(row)) {
          issues.push(`invalid:${field}`);
          return;
        }
        unknownKeys(issues, field, row, STRATEGY_BRIEF_FIELDS.hypothesis);
        patternIssue(issues, `${field}.id`, row.id, ITEM_ID);
        textIssue(issues, `${field}.statement`, row.statement);
        if (!HYPOTHESIS_STATES.includes(row.status)) issues.push(`invalid:${field}.status`);
        // 支持された・弱まったと書くなら、それを示す根拠が要る。untested だけは根拠なしでよい。
        evidenceIdList(issues, `${field}.evidenceIds`, row.evidenceIds, { min: row.status === "untested" ? 0 : 1 });
        textIssue(issues, `${field}.note`, row.note, { min: 1, max: 300, required: false });
      });
    }
  }
  if (brief.openQuestions !== undefined) {
    if (!Array.isArray(brief.openQuestions)) issues.push("invalid:openQuestions");
    else {
      if (brief.openQuestions.length > 30) issues.push("too-many:openQuestions");
      brief.openQuestions.forEach((row, index) => {
        const field = `openQuestions[${index}]`;
        if (!plainObject(row)) {
          issues.push(`invalid:${field}`);
          return;
        }
        unknownKeys(issues, field, row, STRATEGY_BRIEF_FIELDS.openQuestion);
        patternIssue(issues, `${field}.id`, row.id, ITEM_ID);
        textIssue(issues, `${field}.question`, row.question);
        if (typeof row.blocksProduction !== "boolean") issues.push(`${row.blocksProduction === undefined ? "missing" : "invalid"}:${field}.blocksProduction`);
        textIssue(issues, `${field}.plannedCheck`, row.plannedCheck);
        const status = row.status === undefined ? "open" : row.status;
        if (!OPEN_QUESTION_STATES.includes(status)) issues.push(`invalid:${field}.status`);
        if (status === "resolved") {
          // 確認済みにするなら、何で確かめたか（根拠の id）が要る。
          if (!plainObject(row.resolution)) issues.push(`missing:${field}.resolution`);
          else {
            unknownKeys(issues, `${field}.resolution`, row.resolution, STRATEGY_BRIEF_FIELDS.resolution);
            evidenceIdList(issues, `${field}.resolution.evidenceIds`, row.resolution.evidenceIds, { min: 1 });
            textIssue(issues, `${field}.resolution.note`, row.resolution.note);
          }
        } else if (row.resolution !== undefined) {
          issues.push(`unexpected:${field}.resolution`);
        }
      });
    }
  }
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
  validateClaims(brief, issues);
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
  const observations = Array.isArray(brief.observations) ? brief.observations : [];
  const hypotheses = Array.isArray(brief.hypotheses) ? brief.hypotheses : [];
  const questions = Array.isArray(brief.openQuestions) ? brief.openQuestions : [];
  for (const id of duplicates(observations.map((row) => row.id))) issues.push(`link:duplicate-observation-id:${id}`);
  for (const id of duplicates(hypotheses.map((row) => row.id))) issues.push(`link:duplicate-hypothesis-id:${id}`);
  for (const id of duplicates(questions.map((row) => row.id))) issues.push(`link:duplicate-open-question-id:${id}`);
  for (const row of observations) for (const id of row.evidenceIds) if (!evidence.has(id)) issues.push(`link:observation-unknown-evidence:${row.id}:${id}`);
  for (const row of hypotheses) for (const id of row.evidenceIds) if (!evidence.has(id)) issues.push(`link:hypothesis-unknown-evidence:${row.id}:${id}`);
  for (const row of questions) {
    for (const id of row.resolution?.evidenceIds || []) if (!evidence.has(id)) issues.push(`link:open-question-unknown-evidence:${row.id}:${id}`);
  }
  return [...new Set(issues)];
}

// ---------------------------------------------------------------------------
// 観測・仮説・未確認事項

function questionStatus(row) {
  return row?.status === undefined ? "open" : String(row.status);
}

/** 未確認事項の数と、制作を止める未確認事項の id。 */
export function openQuestionSummary(brief) {
  const rows = Array.isArray(brief?.openQuestions) ? brief.openQuestions : [];
  const open = rows.filter((row) => questionStatus(row) === "open");
  return {
    total: rows.length,
    open: open.length,
    resolved: rows.length - open.length,
    blocking: open.filter((row) => row?.blocksProduction === true).map((row) => String(row.id ?? "")),
  };
}

/** 品質ループの版の記録に残す、未確認事項と仮説の状態（本文は持たない）。 */
export function claimRecords(brief) {
  return {
    openQuestions: (Array.isArray(brief?.openQuestions) ? brief.openQuestions : []).map((row) => ({
      id: String(row?.id ?? ""),
      status: questionStatus(row),
      blocksProduction: row?.blocksProduction === true,
    })),
    hypotheses: (Array.isArray(brief?.hypotheses) ? brief.hypotheses : []).map((row) => ({
      id: String(row?.id ?? ""),
      status: String(row?.status ?? ""),
    })),
  };
}

/**
 * 前の版（品質ループに記録した版、またはブリーフ）から、未確認事項と仮説の状態をどう変えたか。
 *
 * 未確認を確認済みにする・仮説を支持された／弱まったに変えるには、前の版に無かった根拠（新しい id か、
 * 同じ id でファイルや SHA が変わったもの）を指す必要がある（ok: false なら新しい根拠なし）。未確認事項を
 * 黙って消すのも ok: false。制作を止める印を外したことは unblocked として名指しする（判断は評価者がする）。
 */
export function claimChangesSince(previous, brief) {
  if (!previous) return [];
  const priorEvidence = new Map((Array.isArray(previous.evidence) ? previous.evidence : []).map((row) => [String(row?.id ?? ""), row]));
  const isNew = (id) => {
    const prior = priorEvidence.get(id);
    if (!prior) return true;
    const row = (Array.isArray(brief?.evidence) ? brief.evidence : []).find((entry) => entry?.id === id);
    if (!row) return false;
    const samePath = normalizeEvidenceRelPath(prior.path).rel === normalizeEvidenceRelPath(row.path).rel;
    return !(samePath && String(prior.sha256 ?? "") === String(row.sha256 ?? ""));
  };
  const changes = [];
  const currentQuestions = new Map((Array.isArray(brief?.openQuestions) ? brief.openQuestions : []).map((row) => [String(row?.id ?? ""), row]));
  for (const prior of Array.isArray(previous.openQuestions) ? previous.openQuestions : []) {
    const id = String(prior?.id ?? "");
    if (questionStatus(prior) !== "open") continue;
    const now = currentQuestions.get(id);
    if (!now) {
      changes.push({ kind: "open-question", id, change: "dropped", from: "open", to: null, newEvidenceIds: [], ok: false });
      continue;
    }
    if (questionStatus(now) === "resolved") {
      const cited = Array.isArray(now.resolution?.evidenceIds) ? now.resolution.evidenceIds : [];
      const fresh = cited.filter(isNew);
      changes.push({ kind: "open-question", id, change: "resolved", from: "open", to: "resolved", newEvidenceIds: fresh, ok: fresh.length > 0 });
    } else if (prior.blocksProduction === true && now.blocksProduction === false) {
      changes.push({ kind: "open-question", id, change: "unblocked", from: "blocking", to: "not-blocking", newEvidenceIds: [], ok: true });
    }
  }
  const currentHypotheses = new Map((Array.isArray(brief?.hypotheses) ? brief.hypotheses : []).map((row) => [String(row?.id ?? ""), row]));
  for (const prior of Array.isArray(previous.hypotheses) ? previous.hypotheses : []) {
    const id = String(prior?.id ?? "");
    const now = currentHypotheses.get(id);
    if (!now || now.status === prior.status || now.status === "untested") continue;
    const cited = Array.isArray(now.evidenceIds) ? now.evidenceIds : [];
    const fresh = cited.filter(isNew);
    changes.push({ kind: "hypothesis", id, change: "status-changed", from: String(prior.status ?? ""), to: String(now.status ?? ""), newEvidenceIds: fresh, ok: fresh.length > 0 });
  }
  return changes;
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
// 前提（動画の問い・見る人・制作条件）

function normalizeText(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

/**
 * 前提の欄だけを取り出して正規化する（全角・半角、空白の揺れ、制作条件の並び順では変わらない）。
 * 制作条件は形式・条件・尺。ハーネスの id は制作の経路で、内容の前提ではないので入れない。
 */
export function strategyBriefPremise(brief) {
  const production = plainObject(brief?.production) ? brief.production : {};
  const duration = production.targetDurationSeconds;
  return {
    question: normalizeText(brief?.question),
    audience: {
      who: normalizeText(brief?.audience?.who),
      whyWatch: normalizeText(brief?.audience?.whyWatch),
    },
    production: {
      format: normalizeText(production.format),
      conditions: (Array.isArray(production.conditions) ? production.conditions : []).map(normalizeText).sort(),
      targetDurationSeconds: typeof duration === "number" && Number.isFinite(duration) ? duration : null,
    },
  };
}

/** 入口の約束（表現）だけの digest。前提には入れず、変わったことを評価者へ見せるためだけに使う。 */
export function strategyBriefEntryDigest(brief) {
  const promises = [...(Array.isArray(brief?.entry?.promises) ? brief.entry.promises : [])]
    .map((row) => ({ id: String(row?.id ?? ""), surface: String(row?.surface ?? ""), text: normalizeText(row?.text) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return sha256Hex(canonicalJson(promises));
}

/** 前提の digest。欄ごとと、全体（digest）。 */
export function strategyBriefPremiseDigests(brief) {
  const premise = strategyBriefPremise(brief);
  return {
    digest: sha256Hex(canonicalJson(premise)),
    question: sha256Hex(canonicalJson(premise.question)),
    audience: sha256Hex(canonicalJson(premise.audience)),
    production: sha256Hex(canonicalJson(premise.production)),
  };
}

/**
 * 2つの前提の digest の組から、変わった欄の名前。全体の digest が同じなら変わっていない。違うときは欄ごとに
 * 比べ、片方に欄の digest が無い欄は「分からない」ので変わったと数える（前の記録に制作条件の digest が無い
 * など。分からないことを「変わっていない」にしない）。
 */
export function premiseChangedFields(before, after) {
  if (!before || !after) return [];
  if (before.digest && after.digest && before.digest === after.digest) return [];
  return PREMISE_FIELDS.filter((key) => !before[key] || !after[key] || before[key] !== after[key]);
}

/** 前提を変えた後、根拠ごとに今の前提へ当てはまるかの判定がまだ無い。 */
export const APPLICABILITY_REVIEW_REQUIRED_CODE = "strategy-evidence-applicability-review-required";
/** 今の前提へ当てはまらないと判定した根拠。その根拠だけ取り直す。 */
export const EVIDENCE_REFRESH_REQUIRED_CODE = "strategy-evidence-refresh-required";
/** 今の前提へ当てはまると判定した根拠（再利用する）。 */
export const EVIDENCE_REUSED_CODE = "strategy-evidence-reused-after-applicability-review";
export const EVIDENCE_APPLICABILITY_STATES = Object.freeze(["applicability-review-required", "refresh-required", "reusable"]);

function boundPremiseOf(row, boundPremiseFor) {
  const explicit = plainObject(row?.collected?.premise) && SHA256.test(String(row.collected.premise.digest || ""))
    ? row.collected.premise
    : null;
  const bound = explicit || boundPremiseFor(row) || null;
  return { bound, boundBy: explicit ? "collected.premise" : "quality-loop-history" };
}

/**
 * 前提の変更で、今の前提への当てはまりを確かめる必要がある根拠。日数では決めない。
 *
 * 根拠の行は、集めたときの前提に結び付く:
 *   1. 行に書かれた collected.premise（前のブリーフから引き継いだ行など）
 *   2. 無ければ boundPremiseFor(row)（品質ループの記録で、この行が最初に現れた版の前提）
 *   3. どちらも無ければ、今の版の前提（この版で集めた新しい根拠）
 * premiseBound: false の行（公開済みの動画の実測など、前提に依らないと理由つきで宣言した行）は対象外。
 *
 * 結び付いた前提が今の前提と違う行は、行の applicability（今の前提の digest に対する判定）で分かれる:
 *   - 判定が無い・前の前提への判定しか無い → applicability-review-required（上位の AI が判定を記録する）
 *   - applies: false → refresh-required（その根拠だけ取り直す）
 *   - applies: true  → reusable（そのまま使える）
 * stale には、そのままでは使えない行（確認待ちと取り直し）を入れる。
 */
export function evidencePremiseStaleness(brief, { boundPremiseFor = () => null } = {}) {
  const current = strategyBriefPremiseDigests(brief);
  const rows = [];
  for (const row of Array.isArray(brief?.evidence) ? brief.evidence : []) {
    if (row?.premiseBound === false) continue;
    const { bound, boundBy } = boundPremiseOf(row, boundPremiseFor);
    if (!bound) continue;
    const changedFields = premiseChangedFields(bound, current);
    if (changedFields.length === 0) continue;
    const decision = plainObject(row.applicability) && row.applicability.premiseDigest === current.digest
      && typeof row.applicability.applies === "boolean" ? row.applicability : null;
    const status = !decision ? "applicability-review-required" : decision.applies ? "reusable" : "refresh-required";
    rows.push({
      id: String(row.id ?? ""),
      kind: String(row.kind ?? ""),
      path: String(row.path ?? ""),
      status,
      reasonCode: status === "applicability-review-required" ? APPLICABILITY_REVIEW_REQUIRED_CODE
        : status === "refresh-required" ? EVIDENCE_REFRESH_REQUIRED_CODE : EVIDENCE_REUSED_CODE,
      boundPremiseDigest: bound.digest,
      boundBy,
      changedFields,
      ...(decision ? { applicability: { applies: decision.applies, reason: String(decision.reason ?? "") } } : {}),
    });
  }
  const reviewRequired = rows.filter((row) => row.status === "applicability-review-required");
  const refresh = rows.filter((row) => row.status === "refresh-required");
  const reused = rows.filter((row) => row.status === "reusable");
  return {
    premise: current,
    rows,
    stale: [...reviewRequired, ...refresh],
    reviewRequired,
    refresh,
    reused,
    applicabilityReviewRequired: reviewRequired.length > 0,
    refreshRequired: refresh.length > 0,
    ...(reviewRequired.length > 0
      ? { reasonCode: APPLICABILITY_REVIEW_REQUIRED_CODE }
      : refresh.length > 0 ? { reasonCode: EVIDENCE_REFRESH_REQUIRED_CODE } : {}),
  };
}

function applicabilityError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 根拠の行に、今の前提へ当てはまるかの判定を書いた新しいブリーフを返す（元のブリーフは変えない）。
 * 判定が要らない行（前提に依らない行・前提が変わっていない行）には書かない（例外）。
 */
export function recordEvidenceApplicability(brief, { evidenceId, applies, reason, decidedBy = "", decidedAt = "", boundPremiseFor = () => null } = {}) {
  if (typeof applies !== "boolean") throw applicabilityError("--applies は yes か no にする。", "strategy-evidence-applicability-invalid");
  const text = String(reason ?? "").trim();
  const length = Array.from(text).length;
  if (length < 4 || length > 300) {
    throw applicabilityError("--reason に、今の前提に当てはまる／当てはまらない理由を 4〜300 字で書く。", "strategy-evidence-applicability-invalid");
  }
  const context = String(decidedBy ?? "").trim();
  if (context && !CONTEXT_ID.test(context)) {
    throw applicabilityError("--context は会話・タスクの ID（英数字と . _ : @ -）にする。", "strategy-evidence-applicability-invalid");
  }
  const evidence = Array.isArray(brief?.evidence) ? brief.evidence : [];
  const index = evidence.findIndex((row) => row?.id === evidenceId);
  if (index < 0) throw applicabilityError(`根拠 ${evidenceId} がブリーフに無い。`, "strategy-evidence-applicability-unknown-evidence");
  const staleness = evidencePremiseStaleness(brief, { boundPremiseFor });
  const target = staleness.rows.find((row) => row.id === evidenceId);
  if (!target) {
    throw applicabilityError(
      `根拠 ${evidenceId} は前提が変わっていない（または前提に依らない）ので、当てはまりの判定は要らない。`,
      "strategy-evidence-applicability-not-required",
    );
  }
  const applicability = {
    premiseDigest: staleness.premise.digest,
    applies,
    reason: text,
    ...(context ? { decidedBy: context } : {}),
    ...(decidedAt ? { decidedAt } : {}),
  };
  const next = structuredClone(brief);
  next.evidence[index] = { ...next.evidence[index], applicability };
  return { brief: next, row: { id: evidenceId, changedFields: target.changedFields, applies, status: applies ? "reusable" : "refresh-required" } };
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
