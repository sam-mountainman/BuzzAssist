/**
 * 公開後の数字から次のブリーフの下書きを作る（照合と下書きだけ。モデルを呼ばない）。
 *
 *   node scripts/strategy-brief.mjs next --from <前のブリーフ> --metrics <指標の集計 JSON>
 *        [--referrals <関連元の集計 JSON>] [--audience-run <4分析の run フォルダ>] [--out <下書きの置き場>]
 *
 * 前のブリーフの「公開後に見る指標」を、指標の集計（schema "1.1"）と関連元の集計（schema "1.0"）の実際の数字と
 * 照らす。期待の数値（expected）が書かれていれば、満たしたか満たさなかったかを機械で比べ、残す点・変える点の
 * 候補にして、その数字の入ったファイルを根拠として結び付ける。数字の解釈と次の企画の判断はしない
 * （ホストのエージェントと運営者がする）。
 *
 * 守ること:
 *   - 無い数字は「無い」と書く（status: missing と理由コード）。推測で埋めない。欠けた行を含む合計や、除外行の
 *     ある推計は partial として比べない
 *   - 複数動画をまとめた区分の値は pooled と印を付ける（1本の動画の値として読まない）
 *   - 4分析の run は report-manifest.json が現行（stale でない）ものだけを根拠にする。stale は理由つきで外す
 *   - 根拠のパスは作業フォルダからの相対。作業フォルダの外のファイルは使わない（理由つきで外す）
 *   - 下書きの作った文脈は空欄（仕上げる会話の ID をホストが書く）。そのままでは形の検査を通らない
 */

import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  POST_PUBLISH_METRICS,
  STRATEGY_BRIEF_VERSION,
  inspectAudienceRun,
  normalizeEvidenceRelPath,
  sha256Hex,
  strategyBriefPremiseDigests,
  validateStrategyBrief,
  workDirRelative,
} from "./strategyBrief.mjs";

export const STRATEGY_BRIEF_NEXT_VERSION = "buzzassist-strategy-brief-next-v1";
export const DRAFT_CONTEXT_PLACEHOLDER = "<この下書きを仕上げる会話・タスクの ID>";

const COMPLETE_REFERRALS = "all_reported_views_accounted_for";
const LABEL_MAX = 64;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function inputError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function readJsonFile(file, label) {
  const bytes = await readFile(file);
  try {
    return { bytes, sha256: sha256Hex(bytes), value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    throw inputError(`${label} が JSON として読めない。`, "strategy-next-input-unreadable");
  }
}

function insideWorkDirOrThrow(workDir, file, label) {
  const rel = workDirRelative(workDir, file);
  if (!rel) throw inputError(`${label} は作業フォルダの中に置いてください（根拠は作業フォルダからの相対パスで書く）。`, "strategy-next-outside-work-dir");
  return rel;
}

/** 版の名前の次。末尾が数字なら1つ進め、そうでなければ -next を付ける。 */
export function nextBriefLabel(label) {
  const match = /^(.*?)(\d+)$/u.exec(String(label || ""));
  const next = match ? `${match[1]}${Number(match[2]) + 1}` : `${label}-next`;
  return next.slice(0, LABEL_MAX);
}

function comparisonLabel(row) {
  if (row.source === "metrics") {
    const c = row.comparison || {};
    return `${c.format}/${c.window}/${c.traffic_source}/${c.metric_definition}${row.videoId ? `/動画 ${row.videoId}` : ""}`;
  }
  return "関連元";
}

function metricGroup(metrics, comparison) {
  return (metrics.groups || []).find((group) => {
    const c = group?.comparison || {};
    return c.format === comparison.format
      && c.window === comparison.window
      && String(c.traffic_source || "").toLowerCase() === String(comparison.traffic_source || "").toLowerCase()
      && c.metric_definition === comparison.metric_definition;
  }) || null;
}

/** 指標の集計（schema "1.1"）から1つの値を取る。取れなければ理由つきで missing。 */
export function observeMetricsValue(metrics, row) {
  const group = metricGroup(metrics, row.comparison || {});
  if (!group) return { status: "missing", observed: null, reasonCode: "metrics-group-not-found" };
  if (nonEmpty(row.videoId)) {
    const video = (group.videos || []).find((entry) => entry?.video_id === row.videoId);
    if (!video) return { status: "missing", observed: null, reasonCode: "metrics-video-not-found" };
    const value = finiteOrNull(video[row.metric]);
    return value === null
      ? { status: "missing", observed: null, reasonCode: "metrics-value-missing" }
      : { status: "observed", observed: value, coverage: "full" };
  }
  const pooled = Number(group.rows) > 1 ? { pooledVideoCount: Number(group.rows), caution: "pooled-group" } : {};
  let value = null;
  let partial = false;
  if (["views", "impressions", "watch_time_hours"].includes(row.metric)) {
    const summary = group[row.metric];
    value = finiteOrNull(summary?.sum_observed);
    partial = Number(summary?.missing_rows) > 0;
  } else if (row.metric === "median_views_observed") {
    value = finiteOrNull(group.median_views_observed);
    partial = Number(group.views?.missing_rows) > 0;
  } else if (row.metric === "estimated_weighted_ctr_pct") {
    value = finiteOrNull(group.estimated_weighted_ctr_pct);
    partial = Number(group.ctr_excluded_rows) > 0;
  } else if (row.metric === "end_screen_element_ctr_pct") {
    value = finiteOrNull(group.end_screen_element_ctr_pct);
    partial = Number(group.end_screen_element_eligible_rows) < Number(group.rows);
  }
  if (value === null) return { status: "missing", observed: null, reasonCode: "metrics-value-missing", ...pooled };
  return partial
    ? { status: "partial", observed: value, coverage: "partial", reasonCode: "metrics-partial-coverage", ...pooled }
    : { status: "observed", observed: value, coverage: "full", ...pooled };
}

const REFERRAL_VALUE = Object.freeze({
  self_share_pct: (report) => report.categories?.self?.observed_all_share_pct,
  external_share_pct: (report) => report.categories?.external?.observed_all_share_pct,
  unresolved_share_pct: (report) => report.categories?.unresolved?.observed_all_share_pct,
  external_share_excluding_self_pct: (report) => report.categories?.external?.observed_excluding_known_self_share_pct,
  observed_all_views: (report) => report.denominators?.observed_all_views,
  reported_all_views: (report) => report.denominators?.reported_all_views,
  report_views_covered_pct: (report) => report.coverage?.report_views_covered_pct,
});

/** 関連元の集計（schema "1.0"）から1つの値を取る。 */
export function observeReferralsValue(referrals, row) {
  const context = plainObject(row.context) ? row.context : {};
  for (const [key, value] of Object.entries(context)) {
    if (referrals.report_context?.[key] !== value) return { status: "missing", observed: null, reasonCode: "referrals-context-mismatch" };
  }
  const read = REFERRAL_VALUE[row.metric];
  const value = read ? finiteOrNull(read(referrals)) : null;
  if (value === null) return { status: "missing", observed: null, reasonCode: "referrals-value-missing" };
  const completeness = String(referrals.coverage?.completeness || "");
  return completeness === COMPLETE_REFERRALS
    ? { status: "observed", observed: value, coverage: "full" }
    : { status: "partial", observed: value, coverage: "partial", reasonCode: `referrals-${completeness || "completeness-unknown"}` };
}

function compare(observed, expected) {
  switch (expected.comparator) {
    case ">=": return observed >= expected.value;
    case ">": return observed > expected.value;
    case "<=": return observed <= expected.value;
    case "<": return observed < expected.value;
    default: return null;
  }
}

function clip(text, max = 300) {
  return Array.from(text).slice(0, max).join("");
}

function uniqueEvidenceId(base, taken) {
  let id = base;
  let index = 2;
  while (taken.has(id)) {
    id = `${base}-${index}`;
    index += 1;
  }
  taken.add(id);
  return id;
}

/**
 * 前のブリーフと公開後の数字から、次のブリーフの下書きを作る。書くのは outPath を渡したときだけ（既存の
 * ファイルは上書きしない）。
 */
export async function draftNextStrategyBrief({
  fromPath,
  metricsPath,
  referralsPath = "",
  audienceRunPath = "",
  workDir = "",
  outPath = "",
  now = () => new Date().toISOString(),
} = {}) {
  if (!nonEmpty(fromPath)) throw inputError("--from に前のブリーフが要ります。", "strategy-next-from-missing");
  if (!nonEmpty(metricsPath)) throw inputError("--metrics に指標の集計（analyze_metrics の出力 JSON）が要ります。", "strategy-next-metrics-missing");
  const fromFull = path.resolve(fromPath);
  const root = nonEmpty(workDir) ? path.resolve(workDir) : path.dirname(fromFull);
  const fromDir = path.dirname(fromFull);

  const previous = await readJsonFile(fromFull, "前のブリーフ");
  const prev = previous.value;
  const validation = validateStrategyBrief(prev);
  if (validation.issues.length > 0) {
    throw inputError(`前のブリーフの形が合っていない（${validation.issues.slice(0, 5).join(", ")}）。validate で直してから使う。`, "strategy-next-from-invalid");
  }
  const prevPremise = strategyBriefPremiseDigests(prev);

  const metricsFull = path.resolve(metricsPath);
  const metricsRel = insideWorkDirOrThrow(root, metricsFull, "--metrics");
  const metrics = await readJsonFile(metricsFull, "--metrics");
  if (!plainObject(metrics.value) || metrics.value.schema_version !== "1.1" || !Array.isArray(metrics.value.groups)) {
    throw inputError("--metrics は指標の集計の出力（schema_version \"1.1\"）にする。", "strategy-next-metrics-format");
  }
  let referrals = null;
  let referralsRel = "";
  if (nonEmpty(referralsPath)) {
    const full = path.resolve(referralsPath);
    referralsRel = insideWorkDirOrThrow(root, full, "--referrals");
    referrals = await readJsonFile(full, "--referrals");
    if (!plainObject(referrals.value) || referrals.value.schema_version !== "1.0" || !plainObject(referrals.value.categories)) {
      throw inputError("--referrals は関連元の集計の出力（schema_version \"1.0\"）にする。", "strategy-next-referrals-format");
    }
  }

  const taken = new Set(prev.evidence.map((row) => row.id));
  const newEvidence = [];
  const excludedEvidence = [];
  const metricsEvidenceId = uniqueEvidenceId("post-metrics", taken);
  newEvidence.push({
    id: metricsEvidenceId,
    kind: "metrics",
    path: metricsRel,
    sha256: metrics.sha256,
    state: "provisional",
    collected: {
      at: "unknown",
      conditions: clip(`指標の集計（schema 1.1、区分 ${metrics.value.groups.length} 件、行 ${Number(metrics.value.row_count) || 0} 件）。取得日と区分の定義は出力に無いので元の書き出しで確かめる`, 500),
    },
    premiseBound: false,
    premiseIndependenceReason: "公開済みの動画の実測。次の企画の前提に依らない",
  });
  let referralsEvidenceId = "";
  if (referrals) {
    referralsEvidenceId = uniqueEvidenceId("post-referrals", taken);
    const context = referrals.value.report_context || {};
    newEvidence.push({
      id: referralsEvidenceId,
      kind: "referrals",
      path: referralsRel,
      sha256: referrals.sha256,
      state: "provisional",
      collected: {
        at: "unknown",
        conditions: clip(`関連元の集計（schema 1.0）。期間 ${context.period_start || "不明"}〜${context.period_end || "不明"}（${context.timezone || "不明"}）、形式 ${context.format || "不明"}、レポート ${context.traffic_source || "不明"}、網羅 ${referrals.value.coverage?.completeness || "不明"}`, 500),
      },
      premiseBound: false,
      premiseIndependenceReason: "公開済みの動画の実測。次の企画の前提に依らない",
    });
  }
  let audienceRun = { provided: false };
  if (nonEmpty(audienceRunPath)) {
    const full = path.resolve(audienceRunPath);
    const rel = workDirRelative(root, full);
    const inspected = await inspectAudienceRun(full);
    audienceRun = { provided: true, path: rel, status: inspected.status, reasons: inspected.reasons, completeStages: inspected.completeStages || [] };
    if (!rel) excludedEvidence.push({ kind: "audience-run", reasonCode: "strategy-next-outside-work-dir" });
    else if (inspected.status !== "current") {
      // stale・none・invalid の run は根拠にしない（取り直すかレポートを作り直す）。
      excludedEvidence.push({ kind: "audience-run", path: rel, reasonCode: `strategy-evidence-audience-run-${inspected.status}`, reasons: inspected.reasons });
    } else {
      newEvidence.push({
        id: uniqueEvidenceId("post-audience-run", taken),
        kind: "audience-run",
        path: rel,
        sha256: inspected.reportManifestSha256,
        state: "provisional",
        collected: {
          at: nonEmpty(inspected.createdAt) || "unknown",
          conditions: clip(`視聴者の4分析（完了: ${(inspected.completeStages || []).join(", ") || "なし"}）。前のブリーフの前提で集めた`, 500),
          premise: prevPremise,
        },
      });
    }
  }

  // 前のブリーフの根拠を引き継ぐ。前提に結び付く行には、集めたときの前提（前のブリーフの前提）を書く。
  const carried = [];
  for (const row of prev.evidence) {
    const normalized = normalizeEvidenceRelPath(row.path);
    const rel = normalized.ok ? workDirRelative(root, path.join(fromDir, ...normalized.segments)) : null;
    if (!rel) {
      excludedEvidence.push({ id: row.id, kind: row.kind, reasonCode: "strategy-next-outside-work-dir" });
      continue;
    }
    const collected = row.premiseBound === false || plainObject(row.collected?.premise)
      ? row.collected
      : { ...row.collected, premise: prevPremise };
    carried.push({ ...row, path: rel, collected });
  }

  const observations = [];
  const candidates = { keep: [], change: [], undetermined: [] };
  for (const row of prev.postPublish.metrics) {
    let observed;
    let evidenceId = "";
    if (row.source === "metrics") {
      observed = observeMetricsValue(metrics.value, row);
      evidenceId = metricsEvidenceId;
    } else if (!referrals) {
      observed = { status: "source-not-provided", observed: null, reasonCode: "referrals-not-provided" };
    } else {
      observed = observeReferralsValue(referrals.value, row);
      evidenceId = referralsEvidenceId;
    }
    const expected = plainObject(row.expected) ? { comparator: row.expected.comparator, value: row.expected.value } : null;
    let judgement = null;
    let judgementReason = observed.reasonCode || "";
    if (observed.status === "observed") {
      if (expected) judgement = compare(observed.observed, expected) ? "met" : "not-met";
      else judgementReason = "no-expected-value";
    }
    const label = `指標 ${row.id}（${row.metric}、${comparisonLabel(row)}）`;
    const promises = (row.promiseIds || []).length > 0 ? `。関係する約束: ${row.promiseIds.join(", ")}` : "";
    const observation = {
      metricId: row.id,
      source: row.source,
      metric: row.metric,
      ...(row.comparison ? { comparison: { ...row.comparison } } : {}),
      ...(row.videoId ? { videoId: row.videoId } : {}),
      status: observed.status,
      observed: observed.observed,
      ...(observed.coverage ? { coverage: observed.coverage } : {}),
      ...(observed.pooledVideoCount ? { pooledVideoCount: observed.pooledVideoCount, caution: observed.caution } : {}),
      expected,
      judgement,
      ...(judgementReason ? { reasonCode: judgementReason } : {}),
      evidenceId: observed.status === "observed" || observed.status === "partial" ? evidenceId : null,
      promiseIds: [...(row.promiseIds || [])],
    };
    observations.push(observation);
    const pooledNote = observed.pooledVideoCount ? `（${observed.pooledVideoCount} 本をまとめた値）` : "";
    if (judgement === "met") {
      candidates.keep.push({ metricId: row.id, point: clip(`${label}は期待（${expected.comparator} ${expected.value}）を満たした（観測 ${observed.observed}${pooledNote}）${promises}`), evidenceIds: [evidenceId] });
    } else if (judgement === "not-met") {
      candidates.change.push({ metricId: row.id, point: clip(`${label}は期待（${expected.comparator} ${expected.value}）に届かなかった（観測 ${observed.observed}${pooledNote}）${promises}`), evidenceIds: [evidenceId] });
    } else {
      const why = observed.status === "observed"
        ? `観測 ${observed.observed}${pooledNote}。期待の数値が無いので照合だけ`
        : observed.status === "partial"
          ? `観測 ${observed.observed} は一部の行だけの値（${observed.reasonCode}）なので比べない`
          : `数字が無い（${observed.reasonCode}）。推測で埋めない`;
      candidates.undetermined.push({ metricId: row.id, point: clip(`${label}: ${why}${promises}`), reasonCode: judgementReason || observed.status, ...(observation.evidenceId ? { evidenceIds: [observation.evidenceId] } : {}) });
    }
  }

  const briefDraft = {
    version: STRATEGY_BRIEF_VERSION,
    label: nextBriefLabel(prev.label),
    channel: { ...prev.channel },
    question: prev.question,
    audience: { ...prev.audience },
    entry: { promises: prev.entry.promises.map((row) => ({ ...row })) },
    payoffs: prev.payoffs.map((row) => ({ ...row })),
    evidence: [...carried, ...newEvidence],
    changes: {
      previous: { label: prev.label, sha256: previous.sha256 },
      keep: candidates.keep.map(({ point, evidenceIds }) => ({ point, evidenceIds })),
      change: candidates.change.map(({ point, evidenceIds }) => ({ point, evidenceIds })),
    },
    production: structuredClone(prev.production),
    postPublish: structuredClone(prev.postPublish),
    provenance: { host: prev.provenance.host, contextId: DRAFT_CONTEXT_PLACEHOLDER, createdAt: new Date(now()).toISOString() },
  };
  const draftValidation = validateStrategyBrief(briefDraft);

  let written = null;
  if (nonEmpty(outPath)) {
    const outFull = path.resolve(outPath);
    const exists = await access(outFull).then(() => true, () => false);
    if (exists) throw inputError(`--out のファイルが既にある（上書きしない）: ${path.basename(outFull)}`, "strategy-next-out-exists");
    await writeFile(outFull, `${JSON.stringify(briefDraft, null, 2)}\n`, { flag: "wx" });
    written = { path: workDirRelative(root, outFull) || path.basename(outFull), sha256: sha256Hex(await readFile(outFull)) };
  }

  return {
    version: STRATEGY_BRIEF_NEXT_VERSION,
    modelCallsAttempted: false,
    from: { label: prev.label, sha256: previous.sha256 },
    sources: {
      metrics: { path: metricsRel, sha256: metrics.sha256, schemaVersion: "1.1", groups: metrics.value.groups.length },
      referrals: referrals ? { path: referralsRel, sha256: referrals.sha256, schemaVersion: "1.0", completeness: referrals.value.coverage?.completeness || null } : { provided: false },
      audienceRun,
    },
    observations,
    candidates,
    excludedEvidence,
    briefDraft,
    draftIssues: [...draftValidation.issues, ...draftValidation.linkIssues],
    written,
    notes: [
      "照合と下書きだけ。数字の解釈と次の企画の判断はホストのエージェントと運営者がする",
      "新しい根拠は provisional。確かめたら verification.method を書いて verified にし、品質ループで採点を受ける",
      "provenance.contextId は空欄。下書きを仕上げる会話の ID を書く（そのままでは形の検査を通らない）",
      `使える指標の名前: metrics（区分）${POST_PUBLISH_METRICS.metrics.group.join(", ")} / metrics（動画）${POST_PUBLISH_METRICS.metrics.video.join(", ")} / referrals ${POST_PUBLISH_METRICS.referrals.join(", ")}`,
    ],
  };
}
