// 戦略ブリーフの試験の合成データ。チャンネル・動画・文面はすべて合成の値で、実在のものではない。
// 戦略の道具の出力の形（取得スナップショット、4分析の run、指標の集計、関連元の集計）を、欄の形だけ
// 真似て作る。戦略の道具のスクリプトは実行しない。

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const sha = (value) => createHash("sha256").update(value).digest("hex");

function sortedJson(value) {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedJson(value[key])]));
  }
  return value;
}

/** Python の json.dumps(sort_keys=True, indent=2) に近い形（ハッシュは実バイトで取るので厳密一致は要らない）。 */
export function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(sortedJson(value), null, 2)}\n`, "utf8");
}

export async function workspace(t, prefix = "strategy-brief-") {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

export async function writeBytes(root, rel, bytes) {
  const full = path.join(root, ...rel.split("/"));
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, bytes);
  return { rel, full, sha256: sha(bytes) };
}

export async function writeJson(root, rel, value) {
  return writeBytes(root, rel, jsonBytes(value));
}

/** analyze_metrics の出力（schema "1.1"）の形。 */
export function metricsOutput({ groups } = {}) {
  return {
    schema_version: "1.1",
    source_name: "normalized.csv",
    row_count: 3,
    ignored_columns: [],
    groups: groups ?? [
      {
        comparison: { format: "long", window: "first_7d", traffic_source: "browse", metric_definition: "local-views-v1" },
        rows: 2,
        video_ids: ["SYNTHVID001", "SYNTHVID002"],
        videos: [
          { video_id: "SYNTHVID001", format: "long", window: "first_7d", traffic_source: "browse", metric_definition: "local-views-v1", title: "", views: 1200, impressions: 20000, ctr_pct: 6, watch_time_hours: 150, end_screen_element_impressions: null, end_screen_element_clicks: null },
          { video_id: "SYNTHVID002", format: "long", window: "first_7d", traffic_source: "browse", metric_definition: "local-views-v1", title: "", views: 800, impressions: 20000, ctr_pct: 4, watch_time_hours: null, end_screen_element_impressions: null, end_screen_element_clicks: null },
        ],
        views: { sum_observed: 2000, observed_rows: 2, missing_rows: 0 },
        median_views_observed: 1000,
        impressions: { sum_observed: 40000, observed_rows: 2, missing_rows: 0 },
        watch_time_hours: { sum_observed: 150, observed_rows: 1, missing_rows: 1 },
        estimated_weighted_ctr_pct: 5,
        ctr_eligible_rows: 2,
        ctr_eligible_impressions: 40000,
        ctr_excluded_rows: 0,
        end_screen_element_ctr_pct: null,
        end_screen_element_eligible_rows: 0,
        end_screen_element_eligible_impressions: 0,
        end_screen_element_eligible_clicks: 0,
      },
    ],
    limitations: ["synthetic"],
  };
}

/** analyze_referrals の出力（schema "1.0"）の形。 */
export function referralsOutput({ completeness = "all_reported_views_accounted_for" } = {}) {
  const category = (views, share) => ({
    sum_observed_views: views,
    detail_rows: 1,
    observed_view_rows: 1,
    missing_view_rows: 0,
    distinct_known_source_video_ids: 1,
    missing_source_id_rows: 0,
    observed_all_share_pct: share,
    observed_excluding_known_self_share_pct: null,
    observed_contribution_to_report_total_pct: share,
  });
  return {
    schema_version: "1.0",
    source_name: "referrals.csv",
    mapping_source_name: null,
    self_channel_id: "SYNTHCHANNEL",
    report_context: { scope_id: "synthetic-scope", period_start: "2026-09-01", period_end: "2026-09-07", timezone: "UTC", format: "long", traffic_source: "studio_suggested", metric_definition: "local-views-v1" },
    ignored_columns: [],
    mapping_ignored_columns: [],
    ctr_supported: false,
    denominators: { observed_all_views: 1000, observed_excluding_known_self_views: 600, reported_all_views: 1000, reported_excluding_all_self_views: 600 },
    coverage: { report_views_covered_pct: 100, completeness },
    categories: { self: category(400, 40), external: category(600, 60), unresolved: category(0, 0) },
    channels: [],
    details: [],
    limitations: ["synthetic"],
  };
}

/** 取得スナップショットの形（schema_version 1）。 */
export function snapshotOutput() {
  return {
    schema_version: 1,
    video_id: "SYNTHVID001",
    fetched_at: "2026-09-20T00:00:00Z",
    comments: {
      status: "available",
      source: "provided",
      scope: { coverage: "provided_subset", order: "unknown", limit: 2 },
      records: [{ comment_id: "c1", text_original: "合成のコメント", like_count: 1, thread_reply_count: null, parent_comment_id: null, author_id: null }],
    },
    transcript: {
      status: "available",
      source: "provided",
      caption_kind: "provided",
      language: "ja",
      records: [{ segment_id: "s1", start_seconds: 0, end_seconds: 4.5, text: "合成の字幕。" }],
    },
  };
}

const STAGES = ["scenario", "taka", "yako", "emotion"];

/**
 * 視聴者の4分析の run フォルダ（run.json・stages・completed・results・report-manifest.json）を合成する。
 * 戦略の道具の管理処理と同じ置き場と対応（packet の SHA、結果の SHA、レポートの SHA）で作る。
 */
export async function writeAudienceRun(root, rel, { stages = STAGES } = {}) {
  const runDir = path.join(root, ...rel.split("/"));
  const snapshot = snapshotOutput();
  const snapshotBytes = jsonBytes(snapshot);
  const promptHashes = {};
  const rules = Buffer.from("合成の実行ルール\n", "utf8");
  for (const stage of STAGES) promptHashes[stage] = sha(Buffer.from(`合成のプロンプト ${stage}\n`, "utf8"));
  const run = {
    schema_version: 1,
    run_id: "0123456789abcdef0123456789abcdef",
    created_at: "2026-09-20T01:00:00Z",
    source_sha256: sha(snapshotBytes),
    snapshot_sha256: sha(snapshotBytes),
    prompt_hashes: promptHashes,
    rules_sha256: sha(rules),
    max_input_bytes: 600000,
    cross_run_sync: false,
    packet_contract: 2,
  };
  await writeBytes(runDir, "run.json", jsonBytes(run));
  await writeBytes(runDir, "snapshot.json", snapshotBytes);
  const outputs = {};
  const states = {};
  const results = {};
  let counter = 0;
  for (const stage of STAGES) {
    if (!stages.includes(stage)) {
      states[stage] = { status: "ready", note: "packetを作成・検証して実行する" };
      continue;
    }
    const input = stage === "emotion"
      ? { analyses: Object.fromEntries(["scenario", "taka"].map((dependency) => [dependency, { analysis: results[dependency].text, output_sha256: results[dependency].sha256 }])) }
      : { video_id: snapshot.video_id, fetched_at: snapshot.fetched_at, [stage === "scenario" ? "transcript" : "comments"]: snapshot[stage === "scenario" ? "transcript" : "comments"] };
    const files = {
      "input.json": jsonBytes(input),
      "prompt.md": Buffer.from(`合成のプロンプト ${stage}\n`, "utf8"),
      "rules.md": rules,
      "task.md": Buffer.from(`合成の task ${stage}\n`, "utf8"),
    };
    for (const [name, bytes] of Object.entries(files)) await writeBytes(runDir, `stages/${stage}/${name}`, bytes);
    const packet = { schema_version: 1, stage, run_id: run.run_id, files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha(bytes)])) };
    const packetBytes = jsonBytes(packet);
    await writeBytes(runDir, `stages/${stage}/packet.json`, packetBytes);
    const text = `# 合成の${stage}の分析\n合成の本文。\n`;
    const resultBytes = Buffer.from(text, "utf8");
    counter += 1;
    const resultFile = `${stage}-${String(counter).padStart(32, "0")}.md`;
    await writeBytes(runDir, `results/${resultFile}`, resultBytes);
    const receipt = { stage, completed_at: "2026-09-20T02:00:00Z", packet_sha256: sha(packetBytes), output_sha256: sha(resultBytes), result_file: resultFile, execution: { verification: "host_record", access_control: "instruction_only" } };
    await writeBytes(runDir, `completed/${stage}.json`, jsonBytes(receipt));
    results[stage] = { text, sha256: sha(resultBytes) };
    outputs[stage] = sha(resultBytes);
    states[stage] = { status: "complete" };
  }
  const report = Buffer.from("# 合成の視聴者分析レポート\n", "utf8");
  await writeBytes(runDir, "report.md", report);
  const manifestBytes = jsonBytes({ run_id: run.run_id, outputs, stages: states, report_sha256: sha(report) });
  await writeBytes(runDir, "report-manifest.json", manifestBytes);
  return { runDir, rel, reportManifestSha256: sha(manifestBytes), runId: run.run_id };
}

/** 合成のブリーフ。evidence は呼び出し側が作業フォルダに置いたファイルの行を渡す。 */
export function sampleBrief(overrides = {}) {
  return {
    version: "buzzassist-strategy-brief-v1",
    label: "r1",
    channel: { id: "sample-channel", designVersion: "design-v1" },
    question: "合成の問い: 小さな店の再建は何から始めるべきか",
    audience: { who: "合成の視聴者像: 家業を継ぐか迷う30代", whyWatch: "合成の理由: 自分の決断の材料がほしい" },
    entry: {
      promises: [
        { id: "p-title", surface: "title", text: "合成のタイトルの約束" },
        { id: "p-opening", surface: "opening", text: "合成の冒頭の約束" },
      ],
    },
    payoffs: [
      { promiseId: "p-title", where: "合成の本文の中盤で回収する", locator: "chapter-2" },
      { promiseId: "p-opening", where: "合成の本文の終盤で回収する" },
    ],
    evidence: [],
    changes: { previous: null, keep: [], change: [] },
    production: { harnessId: "narrated-story-video", format: "long", conditions: ["合成の制作条件: 既存の声を使う"], targetDurationSeconds: 3600 },
    postPublish: {
      metrics: [
        {
          id: "m-ctr",
          source: "metrics",
          metric: "estimated_weighted_ctr_pct",
          comparison: { format: "long", window: "first_7d", traffic_source: "browse", metric_definition: "local-views-v1" },
          expectation: "合成の期待: クリック率が前作以上",
          expected: { comparator: ">=", value: 4.5 },
          promiseIds: ["p-title"],
        },
      ],
    },
    provenance: { host: "claude-code", contextId: "ctx-planner-1", createdAt: "2026-09-21T00:00:00Z" },
    ...overrides,
  };
}

export function evidenceRow(file, overrides = {}) {
  return {
    id: overrides.id ?? "e-1",
    kind: overrides.kind ?? "other",
    path: file.rel,
    sha256: file.sha256,
    state: overrides.state ?? "provisional",
    collected: overrides.collected ?? { at: "2026-09-20", conditions: "合成の取得条件" },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !["id", "kind", "state", "collected"].includes(key))),
  };
}
