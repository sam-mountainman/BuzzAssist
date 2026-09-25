#!/usr/bin/env node
// 制作 Job が合格で決着していないのに、エージェントが「完成しました」と言って止まるのを
// 差し止める Stop フック（Claude Code / Codex 共通）。
//
// CLAUDE.md は「最終監査が pass、signoff が有効、knownRemainingIssues が空、MP4 が全部
// デコードできるまで完成と言わない」と書いている。だが書いてあることと、止まる瞬間に
// エージェントがそれを確かめることは別で、確かめないまま「完成」と報告して止まれた。
// ホストは応答の終わりにフックへ最後の発言と会話の記録を渡せるので、ここで Job の記録を
// 読み、合格で決着していなければ止まるのを1回だけ差し戻す。
//
// 判定（どれか1つでも欠けたら何もしない）:
//
//   1. この会話で扱った Job を記録から探す（Job ID、run_video_harness 等の呼び出し、
//      run-video-harness.mjs の実行）。見つからなければ何もしない
//   2. 最後の発言が完成・完了・納品できる・done などを主張している
//   3. その Job が合格で決着していない（completed でない、RunReceipt が pass で確かめられない、
//      knownRemainingIssues・blockers が残る、工程が pass でない、人の確認待ち）
//
// 人の確認待ち（awaiting-human-review）で止まるのは正当なので、そのときは作業を進めさせず、
// 「確認待ちであることを報告する」よう促すだけにする。
//
// このフックがしないこと（どれも意図的）:
//
//   - **Job も Receipt も書き換えない**。読むだけ。数えるのはリポジトリ外（~/.buzzassist）の
//     小さな記録に、会話ごと・Job ごとの差し戻し回数だけ
//   - **無限に差し戻さない**。stop_hook_active（既に Stop フックで続行中）なら何もしない。
//     同じ会話・同じ Job で2回差し戻したら、3回目は通す
//   - **止まらない理由を作らない**。壊れた入力・読めない記録・例外・時間切れはどれも
//     何も出さずに exit 0。`continue: false` は決して出さない（Codex では他のフックの続行を
//     打ち消してしまう）。出すのは `{ decision: "block", reason }` か、何も出さないかだけ
//   - **子エージェントでは何もしない**（BUZZASSIST_LEARNING_WRITE_FORBIDDEN などの子の印）
//   - **有料の再開を勧めない**。「次の工程を進める」は、運営者の明示の確認がある範囲だけ

import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { writeJsonAtomic } from "../lib/atomicJsonFile.mjs";
import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import { learningWritesForbidden } from "../lib/harnessLearningGuard.mjs";

/** 差し戻し回数の置き場。既定はリポジトリ外（~/.buzzassist/hooks/stop-guard/）。 */
export const STOP_HOOK_STATE_DIR_ENV = "BUZZASSIST_STOP_HOOK_STATE_DIR";
/** "off" / "0" でこのフックを止める（運営者の明示の解除）。 */
export const STOP_HOOK_SWITCH_ENV = "BUZZASSIST_STOP_HOOK";
export const MAX_BLOCKS_PER_JOB = 2;
export const STOP_HOOK_REASON_PREFIX = "[BuzzAssist 完成前チェック]";
const STATE_VERSION = "buzzassist-stop-hook-state-v1";
const HARD_TIMEOUT_MS = 5000;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const MAX_JOB_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_NESTED_JSON_CHARS = 2 * 1024 * 1024;
const MAX_WALK_DEPTH = 12;
const MAX_CANDIDATE_DIRS = 32;
const MAX_CANDIDATE_JOBS = 16;
const MAX_ITEM_CHARS = 200;
const MAX_ITEMS_PER_JOB = 8;

// videoHarnessJob.mjs の videoHarnessJobPath と同じ形（video-<harness>-<16桁hex>）。
const JOB_ID_SOURCE = "video-[a-z0-9_-]{1,120}?-[a-f0-9]{16}";
const JOB_ID_PATTERN = new RegExp(`(?<![a-z0-9_-])${JOB_ID_SOURCE}(?![a-z0-9_-])`, "gu");
const JOB_ID_EXACT = /^video-[a-z0-9_-]+-[a-f0-9]{16}$/u;
// <projectDir>/canvas/harness-runs/<jobId> を含むパス。区切りは / と \ の両方。
const RUN_PATH_PATTERN = new RegExp(`((?:[A-Za-z]:)?[\\\\/][^"'\`\\n\\r<>|?*]*?)[\\\\/]canvas[\\\\/]harness-runs[\\\\/](${JOB_ID_SOURCE})(?![a-z0-9_-])`, "gu");
const PROJECT_DIR_FLAG = /--project-dir(?:=|\s+)(?:"([^"\n\r]+)"|'([^'\n\r]+)'|([^\s"'`;&|]+))/gu;
const PROJECT_DIR_KEY = /^project[_-]?dir$/iu;

// ---------------------------------------------------------------------------
// 最後の発言が「完成した」と言っているか
// ---------------------------------------------------------------------------

// 完成・完了・納品できる・合格の主張。否定形（〜していません）はここに当たらない形だけを書く。
const CLAIM_PATTERNS = Object.freeze([
  /完成(?:しました|しております|しています|です|でした|済み|となりました|させました)/u,
  /完了(?:しました|しております|しています|です|でした|済み)/u,
  /仕上(?:がりました|げました|がっています)|出来上がりました|できあがりました/u,
  /納品(?:できます|できる状態|可能です|可能な状態|しました|の準備が(?:でき|整|完了)|準備完了)/u,
  /(?:公開|投稿|アップロード|入稿)(?:できます|できる状態|可能です)/u,
  // 「パス」単独は path（「MP4 のパスです」）と区別できないので、合格・通過と「パスしました」だけ。
  /(?:合格|通過)(?:しました|しています|です)|パスしました/u,
  /\b(?:is|are|was|were|has been|have been|now)\s+(?:all\s+)?(?:done|complete|completed|finished|ready)\b/iu,
  /^(?:all\s+)?(?:done|finished|completed)\b/iu,
  /\b(?:successfully|fully)\s+(?:completed|finished|rendered|produced|generated|delivered)\b/iu,
  /\bready\s+(?:to|for)\s+(?:deliver|delivery|ship|publish|upload|release|hand-?off)\b/iu,
  /\ball\s+(?:the\s+)?(?:gates|checks|audits)\s+(?:have\s+)?pass(?:ed)?\b/iu,
]);
// 主張の直前にあれば否定・疑問・伝聞として数えない。
const ENGLISH_NEGATION_BEFORE = /(?:\bnot\b|n't\b|\bnever\b|\byet to\b|\bbefore\b|\bonce\b|\bif\b|\buntil\b|\bwhen\b)[^.!?]{0,30}$/iu;
const JAPANESE_NEGATION_BEFORE = /(?:未|まだ)$/u;
// 伝聞（「完成しました」とは言えない）・疑問（完成しましたか）・仮定（完成しましたら）。
const REPORTED_SPEECH_AFTER = /^[」』"'”]?\s*(?:と(?:は|も)?(?:言|い|書|報告|主張|断定|判断)|とは|か(?:[。？?]|$)|ら|\?)/u;
// 完成品そのものについての主張（これを含む文の主張は、状態を併記していても主張として扱う）。
const DELIVERABLE_WORDS = /動画|映像|本編|MP4|mp4|納品|完成品|完成版|エピソード|第\s*\d+\s*話|最終版|video|footage|deliverable|final\s+cut|final\s+render/iu;
// 制作の文脈（弱い主張は、発言全体にこれが無ければ数えない）。
const CONTEXT_WORDS = /動画|映像|本編|MP4|mp4|納品|完成品|完成版|エピソード|Job|job|ジョブ|ハーネス|harness|Receipt|レシート|監査|制作|レンダ|書き出し|生成|video|render|deliverable/iu;
const HUMAN_WAIT_WORDS = /確認待ち|レビュー待ち|サインオフ待ち|署名待ち|承認待ち|人の確認|人が確認|signoff\s*待ち|human[\s-]+review|awaiting\s+review|pending\s+review/iu;

const STATUS_LABELS = Object.freeze({
  planned: /計画(?:のみ|だけ)|plan-only|有料生成(?:は)?(?:まだ|未)|未開始/u,
  "preflight-running": /事前検査(?:の)?(?:途中|中)/u,
  "blocked-preflight": /事前検査で止|doctor\s*で止|前提が(?:足り|そろ|揃)って(?:い)?ない/u,
  "awaiting-human-review": HUMAN_WAIT_WORDS,
  queued: /実行待ち|待機中|キュー/u,
  running: /実行中|処理中|進行中|生成中|確定前/u,
  "cancel-requested": /取り消し(?:要求|を要求)|キャンセル(?:要求|待ち)/u,
  cancelled: /取り消し(?:まし|済|され)|キャンセル(?:しまし|済|され)/u,
  failed: /失敗(?:しました|しています|で止|のまま|した)/u,
});

function splitSentences(text) {
  return String(text || "")
    .split(/\r?\n+/u)
    .flatMap((line) => line.split(/(?<=[。！？!?])|(?<=\.)\s+/u))
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function claimInSentence(sentence) {
  for (const pattern of CLAIM_PATTERNS) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const match of sentence.matchAll(global)) {
      const before = sentence.slice(0, match.index);
      const after = sentence.slice(match.index + match[0].length);
      if (JAPANESE_NEGATION_BEFORE.test(before)) continue;
      if (ENGLISH_NEGATION_BEFORE.test(before)) continue;
      if (REPORTED_SPEECH_AFTER.test(after)) continue;
      return true;
    }
  }
  return false;
}

/**
 * 最後の発言が完成を主張しているか。
 * strong = 完成品（動画・MP4・納品…）についての主張。weak = 文の中に完成品の語は無いが、
 * 発言全体は制作の話をしている主張（「完了しました。Job は…」）。
 */
export function detectCompletionClaim(message) {
  const text = typeof message === "string" ? message.slice(0, 200_000) : "";
  if (!text.trim()) return { claimed: false, strong: false, weak: false };
  const claimSentences = splitSentences(text).filter(claimInSentence);
  if (claimSentences.length === 0) return { claimed: false, strong: false, weak: false };
  const jobIdInText = new RegExp(JOB_ID_SOURCE, "u");
  const strong = claimSentences.some((sentence) => DELIVERABLE_WORDS.test(sentence) || jobIdInText.test(sentence));
  const weak = !strong && CONTEXT_WORDS.test(text);
  return { claimed: strong || weak, strong, weak };
}

export function mentionsHumanReviewWait(message) {
  return HUMAN_WAIT_WORDS.test(String(message || ""));
}

/** 発言が Job の実際の状態を書いているか（status=planned、「確認待ち」など）。 */
export function reportsJobStatus(message, status) {
  const text = String(message || "");
  const value = String(status || "");
  // completed は状態そのものが完成を意味するので、書いてあっても報告の印にしない。
  if (!value || value === "completed") return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (value.includes("-") && new RegExp(`(?<![a-z-])${escaped}(?![a-z-])`, "u").test(text)) return true;
  if (new RegExp(`status\\s*[=:：]\\s*["'\`]?${escaped}(?![a-z-])|\`${escaped}\`|[（(「]${escaped}[）)」]`, "iu").test(text)) return true;
  return Boolean(STATUS_LABELS[value]?.test(text));
}

// ---------------------------------------------------------------------------
// 会話の記録から Job を探す
// ---------------------------------------------------------------------------

function isAbsoluteAnywhere(value) {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function trimTrailingSeparators(value) {
  const trimmed = String(value || "").trim();
  if (/^[A-Za-z]:[\\/]?$/u.test(trimmed) || trimmed === "/" || trimmed === "\\") return trimmed;
  return trimmed.replace(/[\\/]+$/u, "");
}

/**
 * 記録の文字列群から Job ID とプロジェクトの候補を集める。記録の形（Claude Code の JSONL、
 * Codex の rollout）に依らないよう、JSON を再帰的に歩いて文字列と projectDir キーだけを見る。
 * Codex は記録の形を安定した接点としていないため、形を決め打ちしない。
 */
export function createReferenceCollector({ cwd = "" } = {}) {
  let order = 0;
  const jobOrder = new Map();
  const dirs = new Map();
  const addDir = (value, rank) => {
    const raw = trimTrailingSeparators(value);
    if (!raw || raw.length > 1024 || /[\n\r\0]/u.test(raw)) return;
    let resolved = raw;
    if (!isAbsoluteAnywhere(raw)) {
      if (!cwd) return;
      resolved = (path.win32.isAbsolute(cwd) && !path.posix.isAbsolute(cwd) ? path.win32 : path).resolve(cwd, raw);
    }
    const previous = dirs.get(resolved);
    order += 1;
    if (!previous || previous.rank > rank || (previous.rank === rank && previous.order < order)) dirs.set(resolved, { rank, order });
  };
  const scanString = (text) => {
    if (!text || text.length < 8) return;
    if (text.includes("video-")) {
      for (const match of text.matchAll(JOB_ID_PATTERN)) {
        order += 1;
        jobOrder.set(match[0], order);
      }
      if (text.includes("harness-runs")) {
        for (const match of text.matchAll(RUN_PATH_PATTERN)) {
          const prefix = match[1];
          addDir(prefix, 0);
          // "cd /a && cat /a/canvas/..." のように前に別のパスがあると、最初の / から拾ってしまう。
          // 空白・引用符・= の直後から始まる絶対パスも候補にする（実在で確かめるので害は無い）。
          for (let index = 1; index < prefix.length; index += 1) {
            if (/[\s"'=(]/u.test(prefix[index - 1]) && /^(?:[A-Za-z]:)?[\\/]/u.test(prefix.slice(index))) addDir(prefix.slice(index), 0);
          }
        }
      }
    }
    if (text.includes("--project-dir")) {
      for (const match of text.matchAll(PROJECT_DIR_FLAG)) addDir(match[1] || match[2] || match[3] || "", 2);
    }
  };
  const walk = (value, depth = 0) => {
    if (depth > MAX_WALK_DEPTH || value === null || value === undefined) return;
    if (typeof value === "string") {
      scanString(value);
      const trimmed = value.trimStart();
      if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && value.length <= MAX_NESTED_JSON_CHARS) {
        try { walk(JSON.parse(value), depth + 1); } catch { /* JSON でない文字列 */ }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (PROJECT_DIR_KEY.test(key) && typeof child === "string") addDir(child, 1);
        walk(child, depth + 1);
      }
    }
  };
  return {
    /** 記録の1行（JSON でなければ文字列として）を読む。 */
    addLine(line) {
      if (typeof line !== "string" || !line) return;
      if (!line.includes("video-") && !line.includes("roject") && !line.includes("harness-runs")) return;
      let parsed;
      try { parsed = JSON.parse(line); } catch { parsed = line; }
      walk(parsed);
    },
    addText(text) { walk(String(text || "")); },
    addDir,
    result() {
      const jobIds = [...jobOrder.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id).slice(0, MAX_CANDIDATE_JOBS);
      const projectDirs = [...dirs.entries()]
        .sort((a, b) => a[1].rank - b[1].rank || b[1].order - a[1].order)
        .map(([dir]) => dir)
        .slice(0, MAX_CANDIDATE_DIRS);
      return { jobIds, projectDirs };
    },
  };
}

function expandHome(value, home) {
  const text = String(value || "");
  if (text === "~") return home;
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(home, text.slice(2));
  return text;
}

/** 記録を読む。大きすぎるときは末尾だけ（新しい Job ほど末尾にある）。 */
export function readTranscriptLines(transcriptPath, { home = homedir(), maxBytes = MAX_TRANSCRIPT_BYTES, fsApi = fs } = {}) {
  const file = expandHome(transcriptPath, home);
  if (!file) return [];
  const size = fsApi.statSync(file).size;
  if (size <= maxBytes) return fsApi.readFileSync(file, "utf8").split(/\r?\n/u);
  const fd = fsApi.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const read = fsApi.readSync(fd, buffer, 0, maxBytes, size - maxBytes);
    const lines = buffer.subarray(0, read).toString("utf8").split(/\r?\n/u);
    return lines.slice(1); // 途中から読んだ最初の1行は欠けている
  } finally {
    fsApi.closeSync(fd);
  }
}

function assistantTextOf(entry) {
  if (!entry || typeof entry !== "object") return "";
  const joinTexts = (content) => (Array.isArray(content)
    ? content.filter((block) => block && typeof block.text === "string" && (!block.type || /text/u.test(block.type))).map((block) => block.text).join("\n")
    : (typeof content === "string" ? content : ""));
  // Claude Code: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }
  if (entry.type === "assistant" && entry.message) return joinTexts(entry.message.content);
  // Codex: { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } }
  const payload = entry.payload;
  if (payload && payload.type === "message" && payload.role === "assistant") return joinTexts(payload.content);
  if (entry.type === "event_msg" && payload?.type === "agent_message" && typeof payload.message === "string") return payload.message;
  if (entry.role === "assistant") return joinTexts(entry.content);
  return "";
}

/** ホストが last_assistant_message を渡さないときだけ、記録の末尾から最後の発言を取る。 */
export function lastAssistantMessageFromLines(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line || (!line.includes("assistant") && !line.includes("agent_message"))) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const text = assistantTextOf(entry);
    if (text.trim()) return text;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Job の記録を読んで、合格で決着しているか確かめる
// ---------------------------------------------------------------------------

export function jobRecordPath(projectDir, jobId, pathApi = path) {
  return pathApi.join(projectDir, "canvas", "harness-runs", jobId, "job.json");
}

function readBoundedFile(file, fsApi, maxBytes) {
  const size = fsApi.statSync(file).size;
  if (size > maxBytes) throw new Error("record too large");
  return fsApi.readFileSync(file);
}

/**
 * 候補のプロジェクトから Job の記録を探す。見つからなければ null、壊れていれば { unreadable }。
 */
export function locateJob(jobId, projectDirs, { fsApi = fs, pathApi = path } = {}) {
  if (!JOB_ID_EXACT.test(jobId)) return null;
  for (const projectDir of projectDirs) {
    const file = jobRecordPath(projectDir, jobId, pathApi);
    let bytes;
    try {
      bytes = readBoundedFile(file, fsApi, MAX_JOB_RECORD_BYTES);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "EINVAL") continue;
      return { unreadable: true, jobId, projectDir };
    }
    try {
      const job = JSON.parse(bytes.toString("utf8"));
      if (!job || typeof job !== "object" || job.id !== jobId) return { unreadable: true, jobId, projectDir };
      return { job, jobId, projectDir, runDir: pathApi.dirname(file) };
    } catch {
      return { unreadable: true, jobId, projectDir };
    }
  }
  return null;
}

function bounded(value, limit = MAX_ITEM_CHARS) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function listItems(label, values) {
  const list = (Array.isArray(values) ? values : []).map((value) => bounded(value, 160)).filter(Boolean);
  if (list.length === 0) return [];
  const shown = list.slice(0, 3);
  const more = list.length > shown.length ? `（他${list.length - shown.length}件）` : "";
  return [`${label}: ${shown.join(" ／ ")}${more}`];
}

/**
 * Job が合格で決着しているか。category は pass / human（人の確認待ち）/ unsettled。
 * 合格は、completed・blockers と knownRemainingIssues が空・全工程 pass・Job に記録された
 * RunReceipt が現物と SHA 一致・その Receipt が確定済みで outcome=pass・Receipt の
 * knownRemainingIssues も空、のすべて。
 */
export function evaluateJobSettlement(job, { runDir, fsApi = fs, pathApi = path } = {}) {
  const status = String(job?.status || "");
  const remaining = [];
  remaining.push(...listItems("blockers", job?.blockers));
  remaining.push(...listItems("knownRemainingIssues", job?.knownRemainingIssues));
  const stages = Array.isArray(job?.stages) ? job.stages : null;
  if (!stages) {
    remaining.push("工程（doctor / production / audit / canvas-projection）の記録が無い");
  } else {
    const open = stages.filter((stage) => stage?.status !== "pass").map((stage) => `${bounded(stage?.id, 40)}=${bounded(stage?.status || "(なし)", 40)}`);
    if (open.length > 0) remaining.push(`pass でない工程: ${open.join(", ")}`);
    const audit = stages.find((stage) => stage?.id === "audit");
    if (!audit || audit.status !== "pass") remaining.push("最終監査（audit）が pass で終わっていない");
  }
  if (job?.pendingReceiptFinalization) {
    const lastError = job.pendingReceiptFinalization.lastError ? `（${bounded(job.pendingReceiptFinalization.lastError, 120)}）` : "";
    remaining.push(`RunReceipt の確定待ち${lastError}`);
  }
  let receiptPass = false;
  const receiptArtifacts = (Array.isArray(job?.artifacts) ? job.artifacts : []).filter((artifact) => artifact?.kind === "run-receipt");
  const receiptArtifact = receiptArtifacts[receiptArtifacts.length - 1];
  if (!receiptArtifact) {
    remaining.push("RunReceipt が無い（最終監査の記録が確定していない）");
  } else if (runDir) {
    // Job に書かれた path は信じず、Job のディレクトリの正規の位置だけを読む。
    const receiptFile = pathApi.join(runDir, "run-receipt.json");
    let bytes = null;
    try {
      bytes = readBoundedFile(receiptFile, fsApi, MAX_JOB_RECORD_BYTES);
    } catch {
      remaining.push("RunReceipt（run-receipt.json）を読めない");
    }
    if (bytes) {
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (String(receiptArtifact.sha256 || "").toLowerCase() !== digest) {
        remaining.push("RunReceipt の SHA-256 が Job の記録と一致しない（確定後に変わった）");
      } else {
        let receipt = null;
        try { receipt = JSON.parse(bytes.toString("utf8")); } catch { remaining.push("RunReceipt が JSON として読めない"); }
        if (receipt) {
          if (receipt.finalized !== true) remaining.push("RunReceipt が確定していない");
          if (receipt.outcome !== "pass") remaining.push(`RunReceipt の outcome=${bounded(receipt.outcome || "(なし)", 40)}`);
          remaining.push(...listItems("RunReceipt の knownRemainingIssues", receipt.knownRemainingIssues));
          receiptPass = receipt.finalized === true && receipt.outcome === "pass"
            && !(Array.isArray(receipt.knownRemainingIssues) && receipt.knownRemainingIssues.length > 0);
        }
      }
    }
  }
  const settled = status === "completed" && receiptPass && remaining.length === 0;
  const category = settled ? "pass" : (status === "awaiting-human-review" ? "human" : "unsettled");
  return { settled, category, status, remaining: remaining.slice(0, MAX_ITEMS_PER_JOB) };
}

const STATE_LABELS = Object.freeze({
  planned: "計画だけで、有料生成はまだ始まっていない",
  "preflight-running": "事前検査の途中",
  "blocked-preflight": "事前検査で止まっている",
  "awaiting-human-review": "人の確認待ち",
  queued: "実行待ち",
  running: "実行中（または完成の確定前）",
  "cancel-requested": "取り消しを要求中",
  cancelled: "取り消し済み",
  failed: "失敗で止まっている",
  completed: "completed と記録されているが、合格を確かめられない",
});

export function buildStopReason(evaluations) {
  const lines = [];
  const human = evaluations.filter((entry) => entry.evaluation.category === "human");
  const unsettled = evaluations.filter((entry) => entry.evaluation.category === "unsettled");
  for (const { jobId, evaluation } of [...unsettled, ...human]) {
    const label = STATE_LABELS[evaluation.status] || "合格で決着していない";
    const items = evaluation.remaining.length > 0 ? evaluation.remaining.join("。") : "（記録に項目なし）";
    lines.push(`${STOP_HOOK_REASON_PREFIX} Job ${jobId} は${label}（status=${evaluation.status || "不明"}）。残っている項目: ${items}。`);
  }
  if (unsettled.length > 0) {
    lines.push(
      "完成と言わずに状態を報告するか、次の工程を進める。完成と言えるのは、Job が completed・RunReceipt が pass・knownRemainingIssues が空のときだけ。"
      + "有料の実行・再開は、運営者の明示の確認があるときだけ（無ければ状態と残りを報告して止まる）。",
    );
  } else {
    lines.push(
      "人の確認待ちで止まるのは正当なので、作業を進めなくてよい。完成とは書かず、確認待ちであること、"
      + "誰が何を確認すれば進むか（signoff、RunReceipt の確定など）を報告して終える。",
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 差し戻し回数（会話ごと・Job ごと）
// ---------------------------------------------------------------------------

export function stopHookStateDir(env = process.env, home = homedir()) {
  const configured = String(env?.[STOP_HOOK_STATE_DIR_ENV] ?? "").trim();
  if (configured) return path.resolve(configured);
  return path.join(home, ".buzzassist", "hooks", "stop-guard");
}

export function stopHookStateFile(sessionKey, { env = process.env, home = homedir() } = {}) {
  const key = createHash("sha256").update(String(sessionKey), "utf8").digest("hex").slice(0, 32);
  return path.join(stopHookStateDir(env, home), `${key}.json`);
}

function readBlockState(file, fsApi = fs) {
  try {
    const parsed = JSON.parse(fsApi.readFileSync(file, "utf8"));
    if (parsed && parsed.version === STATE_VERSION && parsed.jobs && typeof parsed.jobs === "object") return parsed;
  } catch { /* 無い・壊れている＝まだ数えていない */ }
  return { version: STATE_VERSION, jobs: {} };
}

// ---------------------------------------------------------------------------
// 判定の本体
// ---------------------------------------------------------------------------

function hookSwitchedOff(env) {
  const value = String(env?.[STOP_HOOK_SWITCH_ENV] ?? "").trim().toLowerCase();
  return value === "off" || value === "0" || value === "false";
}

/**
 * Stop フックの判定。副作用なし（回数の記録は呼び出し側が行う）。
 * 戻り値の action は "none" か "block"。none のときも why に理由の短い印を残す（試験・ログ用）。
 */
export function evaluateStop(input, { env = process.env, home = homedir(), fsApi = fs, pathApi = path } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { action: "none", why: "no-input" };
  const event = String(input.hook_event_name ?? "Stop");
  if (event !== "Stop") return { action: "none", why: "not-stop" };
  if (hookSwitchedOff(env)) return { action: "none", why: "switched-off" };
  if (learningWritesForbidden(env)) return { action: "none", why: "child-agent" };
  if (input.agent_id) return { action: "none", why: "subagent" };
  if (input.stop_hook_active === true || input.stop_hook_active === "true") return { action: "none", why: "stop-hook-active" };

  const sessionKey = String(input.session_id || input.transcript_path || "").trim();
  if (!sessionKey) return { action: "none", why: "no-session" };

  let lines = [];
  const transcriptPath = typeof input.transcript_path === "string" ? input.transcript_path : "";
  if (transcriptPath) {
    try { lines = readTranscriptLines(transcriptPath, { home, fsApi }); } catch { lines = []; }
  }
  const message = typeof input.last_assistant_message === "string" && input.last_assistant_message.trim()
    ? input.last_assistant_message
    : lastAssistantMessageFromLines(lines);
  const claim = detectCompletionClaim(message);
  if (!claim.claimed) return { action: "none", why: "no-claim" };

  const cwd = typeof input.cwd === "string" ? input.cwd : "";
  const collector = createReferenceCollector({ cwd });
  for (const line of lines) collector.addLine(line);
  const mentioned = createReferenceCollector({ cwd });
  mentioned.addText(message);
  collector.addText(message);
  if (cwd) collector.addDir(cwd, 3);
  for (const name of ["CLAUDE_PROJECT_DIR", "EXCALIDRAW_PROJECT_DIR"]) {
    if (typeof env?.[name] === "string" && env[name].trim()) collector.addDir(env[name], 4);
  }
  const { jobIds, projectDirs } = collector.result();
  if (jobIds.length === 0) return { action: "none", why: "no-job" };

  const located = [];
  for (const jobId of jobIds) {
    const found = locateJob(jobId, projectDirs, { fsApi, pathApi });
    if (found) located.push(found);
  }
  if (located.length === 0) return { action: "none", why: "job-not-found" };

  // 発言が Job を名指ししていればその Job を、していなければこの会話で最後に扱った Job を見る。
  // 最後の Job の記録が壊れているときに、古い別の Job へ乗り換えて判定しない（読めない＝止めない）。
  const named = new Set(mentioned.result().jobIds);
  const chosen = named.size > 0 ? located.filter((entry) => named.has(entry.jobId)) : [located[0]];
  const targets = chosen.filter((entry) => !entry.unreadable);
  if (targets.length === 0) return { action: "none", why: chosen.length > 0 ? "job-unreadable" : "named-job-not-found" };

  const stateFile = stopHookStateFile(sessionKey, { env, home });
  const state = readBlockState(stateFile, fsApi);
  const evaluations = [];
  for (const target of targets) {
    let evaluation;
    try {
      evaluation = evaluateJobSettlement(target.job, { runDir: target.runDir, fsApi, pathApi });
    } catch {
      continue;
    }
    if (evaluation.category === "pass") continue;
    // 実際の状態を書いている発言は、完成品についての主張でない限り、状態の報告として通す。
    if (!claim.strong && reportsJobStatus(message, evaluation.status)) continue;
    // 人の確認待ちは正当な停止。確認待ちだと書いていれば通す。
    if (evaluation.category === "human" && mentionsHumanReviewWait(message)) continue;
    const blocks = Number(state.jobs?.[target.jobId]?.blocks || 0);
    if (blocks >= MAX_BLOCKS_PER_JOB) continue;
    evaluations.push({ jobId: target.jobId, evaluation, blocks });
  }
  if (evaluations.length === 0) return { action: "none", why: "settled-or-reported" };
  return {
    action: "block",
    reason: buildStopReason(evaluations),
    jobIds: evaluations.map((entry) => entry.jobId),
    stateFile,
    state,
  };
}

/** 差し戻した回数を1つ足して書く。書けなければ false（呼び出し側は差し戻さない）。 */
export async function recordBlocks(decision, { now = () => new Date().toISOString() } = {}) {
  try {
    const next = { version: STATE_VERSION, updatedAt: String(now()), jobs: { ...(decision.state?.jobs || {}) } };
    for (const jobId of decision.jobIds) {
      const previous = Number(next.jobs[jobId]?.blocks || 0);
      next.jobs[jobId] = { blocks: previous + 1, lastBlockedAt: String(now()) };
    }
    await writeJsonAtomic(decision.stateFile, next);
    return true;
  } catch {
    return false;
  }
}

function readStdin(stream, limit = MAX_INPUT_BYTES) {
  return new Promise((resolve) => {
    if (!stream || stream.isTTY) { resolve(""); return; }
    const chunks = [];
    let size = 0;
    stream.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      size += bytes.length;
      if (size <= limit) chunks.push(bytes);
    });
    stream.on("end", () => {
      try { resolve(size <= limit ? Buffer.concat(chunks).toString("utf8") : ""); } catch { resolve(""); }
    });
    stream.on("error", () => resolve(""));
  });
}

function logError(stderr, error) {
  // exit 0 の stderr はホストのデバッグログにだけ行く（会話には出ない）。本文は書かない。
  try { stderr?.write?.(`[buzzassist stop-hook] ${bounded(error?.code || error?.name || "error", 60)}\n`); } catch { /* 何もしない */ }
}

/**
 * CLI 本体。どの経路でも exit 0 で終わる。差し戻すときだけ `{ decision, reason }` を1行出す。
 * Codex のフックは `node -e` の起動子からこの関数を呼ぶ（シェルに依らず plugin root を解決するため）。
 */
export async function runStopHookCli({
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  home = homedir(),
  exit = (code) => process.exit(code),
  timeoutMs = HARD_TIMEOUT_MS,
} = {}) {
  // 入力が閉じない・記録が大きすぎて遅いときは、何も出さずに打ち切る（止めない側に倒す）。
  const guard = setTimeout(() => exit(0), timeoutMs);
  try {
    const raw = await readStdin(stdin);
    let input = null;
    try { input = raw.trim() ? JSON.parse(raw) : null; } catch { input = null; }
    const decision = evaluateStop(input, { env, home });
    if (decision.action === "block" && await recordBlocks(decision)) {
      stdout.write(`${JSON.stringify({ decision: "block", reason: decision.reason })}\n`);
    }
  } catch (error) {
    logError(stderr, error);
  } finally {
    clearTimeout(guard);
  }
  // 正常経路では process.exit を呼ばない（パイプへの stdout が途中で切れるため）。
  return 0;
}

if (isDirectCli(import.meta.url)) {
  process.on("uncaughtException", () => process.exit(0));
  process.on("unhandledRejection", () => process.exit(0));
  runStopHookCli();
}
