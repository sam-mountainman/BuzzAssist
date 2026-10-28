// 外側のループ（harness-inbox）。止まっている仕事・人の確認待ち・台帳の食い違いを見つけて、次の仕事として人へ返す。
//
// 品質ループや Job の中は「1つの仕事を合格まで詰める」内側のループ。ここは外側：チャンネルの台帳にある作業場所の
// Job を読み、誰の何待ちで何日止まっているか、再開できる失敗、計画だけで止まっている Job、作業場所が消えたチャンネル、
// 止めた（quarantined）チャンネルを並べ、次の仕事を1〜3件、打つコマンドつきで返す。
//
// 守ること:
//   - 読むだけ。Job・Receipt・台帳を書き換えない。有料の処理を起動しない（コマンドを示すだけ）
//   - 人の承認待ちは「誰の何待ちか」（waitingOn）として出す。自分で承認を作らない
//   - 予定のタスクで定期的に人へ出すかは、運営者が決める（ここは呼ばれたときに読むだけ）

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { loadRuntimeChannelRegistry } from "./channelStartGate.mjs";

export const HARNESS_INBOX_VERSION = "buzzassist-harness-inbox-v1";
export const DEFAULT_STALE_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const JOB_ID = /^video-[a-z0-9_-]+-[a-f0-9]{16}$/u;

/** Job の状態から、誰の何待ちか（人の承認待ちを依存として表す）。 */
export function waitingOnForJob(job) {
  const status = String(job?.status || "");
  const blockers = (Array.isArray(job?.blockers) ? job.blockers : []).map(String);
  if (status === "awaiting-human-review") {
    const signoff = blockers.some((code) => /signoff|human-review|review-signed|reviewer/u.test(code));
    return {
      actor: signoff ? "reviewer" : "operator",
      kind: signoff ? "signoff" : "decision",
      detail: signoff
        ? "生成と別の文脈の reviewer が完成物を見て署名する（signoff）"
        : "運営者が blocker（台本の品質ループ・素材の確認など）を解いてから resume する",
    };
  }
  if (status === "planned") return { actor: "operator", kind: "paid-confirmation", detail: "有料の処理へ進めるかを運営者が確かめて resume --confirmed" };
  if (status === "blocked-preflight") return { actor: "operator", kind: "prerequisites", detail: "doctor の前提（ffmpeg・鍵・Pack など）をそろえてから resume" };
  if (status === "failed") return { actor: "operator", kind: "retry-decision", detail: "失敗の理由を読み、同じ Job を resume するか新しい Job にするかを決める" };
  if (["queued", "running", "preflight-running", "cancel-requested"].includes(status)) {
    return { actor: "system", kind: "in-progress", detail: "実行中のはず。長く動かなければ status で確かめる（止まった実行の取り消しは人が決める）" };
  }
  return null;
}

function readJobFile(file) {
  try {
    const job = JSON.parse(readFileSync(file, "utf8"));
    return job && typeof job === "object" ? job : null;
  } catch {
    return null;
  }
}

/** 作業場所の Job を読む（canvas/harness-runs/<jobId>/job.json）。 */
export function readProjectJobs(projectDir) {
  const root = path.join(path.resolve(projectDir), "canvas", "harness-runs");
  if (!existsSync(root)) return [];
  const jobs = [];
  for (const name of readdirSync(root)) {
    if (!JOB_ID.test(name)) continue;
    const job = readJobFile(path.join(root, name, "job.json"));
    if (job) jobs.push(job);
  }
  return jobs;
}

function ageDays(job, nowMs) {
  const at = Date.parse(String(job?.updatedAt || job?.createdAt || ""));
  return Number.isFinite(at) ? Math.max(0, (nowMs - at) / DAY_MS) : null;
}

function commandsFor(job, projectDir) {
  const base = `--job-id ${job.id} --project-dir "${projectDir}"`;
  const status = `node scripts/run-video-harness.mjs status ${base}`;
  switch (job.status) {
    case "planned":
    case "blocked-preflight":
    case "failed":
      return [status, `node scripts/run-video-harness.mjs resume ${base} --confirmed（有料の処理に進む。運営者が確かめてから）`];
    default:
      return [status];
  }
}

/**
 * 台帳のチャンネルごとに Job を読み、次の仕事を並べる。registry を渡せば台帳を読まない（試験用）。非同期。
 * 戻り値の items は重い順（人の確認待ちの古いもの → 再開できる失敗 → 計画だけ → 台帳の食い違い）。
 */
export async function harnessInbox({
  registry = null,
  deploymentPath = "",
  env = process.env,
  now = () => new Date().toISOString(),
  staleDays = DEFAULT_STALE_DAYS,
  readJobs = readProjectJobs,
} = {}) {
  const nowMs = Date.parse(String(now()));
  const items = [];
  let loaded = registry;
  if (!loaded) {
    try {
      // start / resume と同じ読み方（宣言のハーネスと台本のジャンルで照合し、削除したハーネスを指す行は止める）。
      loaded = await loadRuntimeChannelRegistry({ env, deploymentPath });
    } catch (error) {
      items.push({
        kind: "registry-invalid",
        priority: 0,
        actor: "operator",
        title: "チャンネルの台帳が読めない",
        detail: String(error?.message || error).slice(0, 400),
        commands: ["node scripts/harness-doctor.mjs"],
      });
      return { version: HARNESS_INBOX_VERSION, generatedAt: String(now()), items, next: items.slice(0, 3), channels: [] };
    }
  }
  for (const dormant of loaded.quarantined || []) {
    items.push({
      kind: "channel-quarantined",
      priority: 3,
      actor: "operator",
      channel: dormant.id,
      title: `チャンネル ${dormant.id} は止めてある（削除したハーネス・ジャンルを指している）`,
      detail: `${dormant.issues.map((entry) => entry.code).join(", ")}。運営者が config/harness-deployments.json のこの行を、今あるハーネスへ書き換えるか消す`,
      commands: [],
    });
  }
  const channels = [];
  for (const channel of loaded.channels || []) {
    const row = { id: channel.id, projectDir: channel.projectDir, jobs: 0 };
    channels.push(row);
    if (channel.production?.kind === "external") continue;
    let exists = false;
    try { exists = Boolean(channel.projectDir) && statSync(channel.projectDir).isDirectory(); } catch { exists = false; }
    if (!exists) {
      items.push({
        kind: "project-missing",
        priority: 3,
        actor: "operator",
        channel: channel.id,
        title: `チャンネル ${channel.id} の作業場所が無い`,
        detail: `${channel.projectDir} が見つからない。消したのか移したのかを確かめ、台帳を直す（Job と Receipt は作業場所の中にあった）`,
        commands: [],
      });
      continue;
    }
    const jobs = readJobs(channel.projectDir);
    row.jobs = jobs.length;
    for (const job of jobs) {
      const waitingOn = waitingOnForJob(job);
      if (!waitingOn || (waitingOn.actor === "system" && (ageDays(job, nowMs) ?? 0) < 1)) continue;
      const days = ageDays(job, nowMs);
      const stale = days !== null && days >= staleDays;
      const priority = job.status === "awaiting-human-review" ? (stale ? 0 : 1)
        : job.status === "failed" ? 1
          : job.status === "planned" ? 2
            : 2;
      items.push({
        kind: `job-${job.status}`,
        priority,
        actor: waitingOn.actor,
        channel: channel.id,
        jobId: job.id,
        harnessId: job.harness?.id || "",
        status: job.status,
        ageDays: days === null ? null : Number(days.toFixed(1)),
        stale,
        waitingOn,
        blockers: (Array.isArray(job.blockers) ? job.blockers : []).map(String).slice(0, 8),
        title: `${channel.id} の Job ${job.id} は ${job.status}${days === null ? "" : `（${Math.floor(days)} 日）`}`,
        detail: waitingOn.detail,
        commands: commandsFor(job, channel.projectDir),
      });
    }
  }
  items.sort((a, b) => a.priority - b.priority || (b.ageDays ?? 0) - (a.ageDays ?? 0));
  return { version: HARNESS_INBOX_VERSION, generatedAt: String(now()), staleDays, channels, items, next: items.slice(0, 3) };
}

/** 人へ見せる短い文。 */
export function harnessInboxText(report) {
  if (report.items.length === 0) return "止まっている仕事・人の確認待ちは無い。";
  const lines = [`次の仕事（${report.items.length} 件中 ${report.next.length} 件）:`];
  for (const [index, item] of report.next.entries()) {
    lines.push(`${index + 1}. ${item.title}（${item.actor} の番）`);
    lines.push(`   ${item.detail}`);
    for (const command of item.commands) lines.push(`   $ ${command}`);
  }
  const rest = report.items.length - report.next.length;
  if (rest > 0) lines.push(`ほかに ${rest} 件（--json で全部）。`);
  return lines.join("\n");
}
