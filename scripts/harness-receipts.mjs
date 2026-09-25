#!/usr/bin/env node
// RunReceipt の集計（Claude Code / Codex 共通）
//
//   node scripts/harness-receipts.mjs list
//   node scripts/harness-receipts.mjs rollup
//   node scripts/harness-receipts.mjs rollup --harness koya-manga-video
//   node scripts/harness-receipts.mjs rollup --by host
//   node scripts/harness-receipts.mjs rollup --channel <チャンネルの id>
//   node scripts/harness-receipts.mjs export --out docs/learning/platform-rollup.json
//
// なぜ集計が要るか:
// ハーネスを直したかどうかは git を見れば分かるが、直して良くなったかは
// 分からない。ゲートごとの失敗率をハーネスの版で並べて初めて、
// 「あの変更以降ここで落ちなくなった」「別のところで落ちるようになった」が見える。
// 自己改善（harness-learn）が提案を出す面も、本来はここであるべきで、
// 「1セッションで気づいたこと」ではなく「何度も落ちている場所」を狙える。
//
// export が出すのはチャンネル固有のものを一切含まない形。運営者の手元で
// 回った結果をこちら側へ返す道を、返せるものだけで作るため。
//
// チャンネル（運営者の配置表の channels）で作った Job は、索引の行に Job の metadata.channel の id が載る
// （--project-dir で読んだ Receipt は、同じ run のフォルダの job.json から）。rollup はチャンネルごとの内訳を出し、
// --channel で絞れる。チャンネルの無い Job・欄の無い古い索引の行・どの Job か分からない記録は「チャンネルなし」。
// チャンネルの id は運営者の手元の集計にだけ出し、export（プラットフォームへ返す形）には出さない。

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import {
  isGateNotInForce,
  issueCodeOf,
  redactForPlatform,
  runReceiptHostSummary,
  verifyRunReceiptInvocation,
} from "../lib/harnessRunReceipt.mjs";
import { readReceiptIndex, receiptIndexChannelId, resolveLearningState } from "../lib/harnessLearningState.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
const MAX_JOB_BYTES = 8 * 1024 * 1024;

/** チャンネルの無い Job（と、どの Job か分からない記録）を数える見出し。 */
export const NO_CHANNEL_LABEL = "チャンネルなし";
/** チャンネルごとの内訳に出す失敗の理由コードの数。 */
export const CHANNEL_TOP_FAILURE_CODES = 5;

/**
 * 既定の置き場。開発用チェックアウトは docs/learning/receipts、配布された写しは
 * ~/.buzzassist/learning/receipts（lib/harnessLearningState.mjs）。どちらも索引 index.jsonl を持つ。
 */
export function defaultReceiptsDir() {
  return resolveLearningState({ codeRoot: REPO_ROOT }).receiptsDir;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 1件の RunReceipt を読む。finalize していない記録は集計に混ぜない（null）。 */
function readReceiptBytes(full) {
  const info = fs.lstatSync(full, { throwIfNoEntry: false });
  if (!info) return { missing: true };
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECEIPT_BYTES) return { error: "通常の RunReceipt ファイルではない" };
  const bytes = fs.readFileSync(full);
  try {
    return { bytes, digest: sha256(bytes), receipt: JSON.parse(bytes.toString("utf8")) };
  } catch {
    return { bytes, digest: sha256(bytes), error: "読めない JSON" };
  }
}

/**
 * <project>/canvas/harness-runs/<job>/run-receipt.json を読み取り専用で走査する。
 * Job はここに共通 RunReceipt を書く。索引に載る前の Job（索引を作る前の版で決着した Job）も拾う。
 */
export function projectReceiptPaths(projectDir) {
  const runs = path.join(path.resolve(projectDir), "canvas", "harness-runs");
  let names = [];
  try {
    names = fs.readdirSync(runs, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
  return names.map((name) => path.join(runs, name, "run-receipt.json")).filter((file) => fs.existsSync(file));
}

/** project の run のフォルダの job.json から、Job を作ったチャンネルの id（無い・読めなければ ""）。 */
function projectJobChannel(receiptFile) {
  const file = path.join(path.dirname(receiptFile), "job.json");
  try {
    const info = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_JOB_BYTES) return "";
    return receiptIndexChannelId(JSON.parse(fs.readFileSync(file, "utf8"))?.metadata?.channel?.id);
  } catch {
    return "";
  }
}

/**
 * RunReceipt を集める。読むのは3か所で、同じ中身（sha256）は1件に数える。
 *
 *   1. dir 直下の *.json（従来の置き場）
 *   2. dir/index.jsonl（Job の決着時に積んだ索引）が指す RunReceipt。索引の sha256 と
 *      一致しないものは数えない（書き換わった記録を、決着時の記録として扱わない）
 *   3. projectDirs の canvas/harness-runs/<job>/run-receipt.json（読み取り専用）
 *
 * 索引が指す先が消えていた（canvas を片づけた）ものは missing として数え、unreadable に混ぜない。
 *
 * 各件の channel は Job を作ったチャンネルの id（索引の行の channel か、project の job.json の metadata.channel）。
 * 分からなければ付けない（「チャンネルなし」）。同じ中身を先にチャンネルの分からない所（dir）で読んでいたら、
 * 後から読んだ索引・Job のチャンネルを足す。
 */
export function loadReceipts(dir = defaultReceiptsDir(), { projectDirs = [], includeIndex = true } = {}) {
  const out = [];
  const seen = new Map();
  const push = (file, loaded, source, channel = "") => {
    const scoped = channel ? { channel } : {};
    if (loaded.missing) { out.push({ file, source, missing: true, ...scoped }); return; }
    if (loaded.digest && seen.has(loaded.digest)) {
      const first = seen.get(loaded.digest);
      if (channel && first && !first.channel) first.channel = channel;
      return;
    }
    const record = (entry) => {
      if (loaded.digest) seen.set(loaded.digest, entry);
      if (entry) out.push(entry);
    };
    if (loaded.error) { record({ file, source, error: loaded.error, ...scoped }); return; }
    // finalize していない記録は集計に混ぜない。途中で落ちた実行を
    // 「ゲートが1件も落ちなかった実行」として数えると、失敗率が下がって見える。
    if (loaded.receipt?.finalized !== true) { record(null); return; }
    // ホストの欄（invocation）が digest と合わない記録は、書き出した後に書き換わっている。
    // 集計に混ぜると「どのホストで落ちたか」が改変された値で数えられる。
    const invocation = verifyRunReceiptInvocation(loaded.receipt);
    if (!invocation.ok) {
      record({ file, source, invalid: true, error: `invocation の検証に失敗: ${invocation.failures.join(", ")}`, ...scoped });
      return;
    }
    record({ file, source, receipt: loaded.receipt, sha256: loaded.digest, ...scoped });
  };
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith(".json")) continue;
      push(name, readReceiptBytes(path.join(dir, name)), "dir");
    }
    const indexPath = path.join(dir, "index.jsonl");
    if (includeIndex && fs.existsSync(indexPath)) {
      for (const row of readReceiptIndex(indexPath).rows) {
        if (typeof row?.receiptPath !== "string" || !row.receiptPath) continue;
        const file = row.receiptPath;
        const loaded = readReceiptBytes(file);
        // channel の欄の無い古い行は「チャンネルなし」（落とさない）。
        const channel = receiptIndexChannelId(row.channel);
        if (!loaded.missing && loaded.digest && row.receiptSha256 && loaded.digest !== row.receiptSha256) {
          out.push({ file, source: "index", error: "索引の sha256 と一致しない（決着後に書き換わった）", ...(channel ? { channel } : {}) });
          continue;
        }
        push(file, loaded, "index", channel);
      }
    }
  }
  for (const projectDir of projectDirs) {
    for (const file of projectReceiptPaths(projectDir)) push(file, readReceiptBytes(file), "project", projectJobChannel(file));
  }
  return out;
}

/**
 * --channel の絞り込み。channelId が null / undefined なら絞らない。"" は「チャンネルなし」の記録だけ。
 */
export function entriesForChannel(entries, channelId = null) {
  if (channelId === null || channelId === undefined) return entries;
  return entries.filter((entry) => (entry.channel || "") === channelId);
}

/**
 * 1件の Receipt の失敗の理由コード（重複なし）。落ちたゲートの id と、knownRemainingIssues をコードへ丸めたもの
 * （lib/harnessRunReceipt.mjs の issueCodeOf。自由文は運ばず、形の合わないものは unclassified）。
 */
export function receiptFailureCodes(receipt) {
  const gates = receipt?.gates || {};
  const gateIds = new Set([...Object.keys(gates), ...(receipt?.harnessBuild?.declaredGates || []).map(String)]);
  const failedGates = Array.isArray(receipt?.summary?.failedGates)
    ? receipt.summary.failedGates.map(String)
    : Object.entries(gates).filter(([, gate]) => gate?.verdict === "fail").map(([id]) => id);
  const issues = (Array.isArray(receipt?.knownRemainingIssues) ? receipt.knownRemainingIssues : [])
    .map((issue) => issueCodeOf(issue, { gateIds, auditToGate: new Map() }));
  return [...new Set([...failedGates.filter((id) => gateIds.has(id)), ...issues])];
}

/**
 * チャンネルごとの内訳: Receipt 数・合否・pass 率・失敗の理由コードの上位（そのコードが出た Receipt の数）。
 * チャンネルの無い記録は channel: null（label は「チャンネルなし」）の1行にまとめ、最後に並べる。
 */
export function rollupByChannel(entries, { harnessId = null, top = CHANNEL_TOP_FAILURE_CODES } = {}) {
  const groups = new Map();
  const groupFor = (channel) => {
    const key = channel || "";
    if (!groups.has(key)) {
      groups.set(key, { channel: key || null, label: key || NO_CHANNEL_LABEL, receipts: 0, passed: 0, failed: 0, missing: 0, unreadable: 0, invalid: 0, codes: new Map() });
    }
    return groups.get(key);
  };
  for (const entry of entries) {
    if (entry.missing) { groupFor(entry.channel).missing += 1; continue; }
    if (entry.invalid) { groupFor(entry.channel).invalid += 1; continue; }
    if (entry.error) { groupFor(entry.channel).unreadable += 1; continue; }
    const receipt = entry.receipt;
    const harness = receipt?.harnessBuild?.harness;
    if (!harness) { groupFor(entry.channel).unreadable += 1; continue; }
    if (!verifyRunReceiptInvocation(receipt).ok) { groupFor(entry.channel).invalid += 1; continue; }
    if (harnessId && harness.id !== harnessId) continue;
    const group = groupFor(entry.channel);
    group.receipts += 1;
    if (receipt.outcome === "pass") group.passed += 1; else group.failed += 1;
    for (const code of receiptFailureCodes(receipt)) group.codes.set(code, (group.codes.get(code) || 0) + 1);
  }
  return [...groups.values()]
    .sort((a, b) => (a.channel === null) - (b.channel === null) || String(a.channel).localeCompare(String(b.channel)))
    .map(({ codes, ...group }) => ({
      ...group,
      passRate: rate(group.passed, group.receipts),
      topFailureCodes: [...codes]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
        .slice(0, top),
    }));
}

/**
 * ハーネスの版ごとに、ゲートの落ち方を並べる。
 * 版をまたいで混ぜない——混ぜると、直した後も古い失敗が率に残り、
 * 改善したことも悪化したことも見えなくなる。
 */
export function rollup(allEntries, { harnessId = null, channelId = null, minRuns = DEFAULT_HOST_MIN_RUNS, gap = DEFAULT_HOST_PASS_RATE_GAP } = {}) {
  const entries = entriesForChannel(allEntries, channelId);
  const byBuild = new Map();
  let unreadable = 0;
  let missing = 0;
  let invalid = 0;
  for (const entry of entries) {
    if (entry.missing) { missing += 1; continue; }
    if (entry.invalid) { invalid += 1; continue; }
    if (entry.error) { unreadable += 1; continue; }
    const receipt = entry.receipt;
    const harness = receipt.harnessBuild?.harness;
    if (!harness) { unreadable += 1; continue; }
    if (!verifyRunReceiptInvocation(receipt).ok) { invalid += 1; continue; }
    if (harnessId && harness.id !== harnessId) continue;
    const key = `${harness.id}@${harness.version}+${harness.declarationDigest.slice(0, 12)}`;
    if (!byBuild.has(key)) {
      byBuild.set(key, {
        harnessId: harness.id,
        harnessVersion: harness.version,
        declarationDigest: harness.declarationDigest.slice(0, 12),
        runs: 0,
        passed: 0,
        failed: 0,
        outcomeOverridden: 0,
        gates: {},
        skillOverlays: new Set(),
      });
    }
    const bucket = byBuild.get(key);
    bucket.runs += 1;
    if (receipt.outcome === "pass") bucket.passed += 1; else bucket.failed += 1;
    if (receipt.outcomeOverridden) bucket.outcomeOverridden += 1;
    for (const [gateId, gate] of Object.entries(receipt.gates || {})) {
      const stat = bucket.gates[gateId] || (bucket.gates[gateId] = { pass: 0, fail: 0, skip: 0, notInForce: 0 });
      // 当時の契約にまだ無かった保証は、この版の弱点ではない。skip に混ぜると、
      // 過去作を記録し直しただけで「測れていないゲート」の上位に並ぶ。
      const key = isGateNotInForce(gate) ? "notInForce" : gate.verdict;
      if (stat[key] !== undefined) stat[key] += 1;
    }
    for (const skill of Object.values(receipt.harnessBuild?.genreSkills || {})) {
      if (skill.learnedOverlay) bucket.skillOverlays.add(skill.learnedOverlay.slice(0, 12));
    }
  }

  const builds = [...byBuild.values()].map((bucket) => ({
    ...bucket,
    skillOverlays: [...bucket.skillOverlays],
    // 落ちる場所の順位。ここが自己改善の狙い先になる。
    worstGates: Object.entries(bucket.gates)
      .map(([id, stat]) => ({ id, ...stat, failRate: bucket.runs > 0 ? stat.fail / bucket.runs : 0 }))
      .filter((gate) => gate.fail > 0 || gate.skip > 0)
      .sort((a, b) => b.failRate - a.failRate || b.skip - a.skip),
  }));

  // ホスト別の小計（rollup --by host と同じ数え方）。版ごとの表の横に並べておくと、
  // 「この版で落ちるのは片方のホストだけか」が同じ出力の中で読める。
  const byHost = rollupByHost(entries, { harnessId, minRuns, gap });
  return {
    ...(channelId === null || channelId === undefined ? {} : { channel: channelId }),
    builds,
    hostSubtotals: byHost.groups.map(({ harnessId: id, host, buzzassistVersion, receipts, passed, passRate, medianDurationSeconds }) => ({
      harnessId: id, host, buzzassistVersion, receipts, passed, passRate, medianDurationSeconds,
    })),
    hostWarnings: byHost.warnings,
    // チャンネルごとの内訳（Job の metadata.channel。無い Job は「チャンネルなし」）。
    channels: rollupByChannel(entries, { harnessId }),
    receiptCount: entries.filter((entry) => !entry.missing).length,
    unreadable,
    missing,
    invalid,
  };
}

/** 片方のホストだけ pass 率が低いと警告する既定の下限（各ホストの Receipt 数）と差。 */
export const DEFAULT_HOST_MIN_RUNS = 3;
export const DEFAULT_HOST_PASS_RATE_GAP = 0.2;
// 比べる相手にしないホスト。記録の無い過去の版と、判定できなかった呼び出しは、
// どちらのホストの品質とも言えない。混在（claude-code+codex）も片方の品質ではない。
const NOT_COMPARABLE_HOSTS = new Set(["unrecorded", "unknown"]);

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function rate(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 1000 : 0;
}

/**
 * ハーネス × ホスト × BuzzAssist の版ごとに、Receipt 数・pass 率・落ちるゲート・所要時間の中央値。
 *
 * ホストは「実行した呼び出し」のホスト（lib/harnessHostProvenance.mjs の hostKey）。
 * Claude Code で始めて Codex で再開した Job は "claude-code+codex" として別に数え、
 * どちらの品質にも混ぜない。host を残す前の版の Receipt は "unrecorded"。
 *
 * 警告: 同じハーネス・同じ版で、Receipt が minRuns 件以上ある単独ホストどうしを比べ、
 * 最も高いホストより gap 以上 pass 率が低いホストを挙げる。件数が足りない比較は警告しない
 * （少数の偶然を「ホストの差」と言わない）が、比べられなかった組は skippedComparisons に残す。
 */
export function rollupByHost(allEntries, { harnessId = null, channelId = null, minRuns = DEFAULT_HOST_MIN_RUNS, gap = DEFAULT_HOST_PASS_RATE_GAP } = {}) {
  const entries = entriesForChannel(allEntries, channelId);
  const groups = new Map();
  let unreadable = 0;
  let missing = 0;
  let invalid = 0;
  for (const entry of entries) {
    if (entry.missing) { missing += 1; continue; }
    if (entry.invalid) { invalid += 1; continue; }
    if (entry.error) { unreadable += 1; continue; }
    const receipt = entry.receipt;
    const harness = receipt?.harnessBuild?.harness;
    if (!harness) { unreadable += 1; continue; }
    if (!verifyRunReceiptInvocation(receipt).ok) { invalid += 1; continue; }
    if (harnessId && harness.id !== harnessId) continue;
    const host = runReceiptHostSummary(receipt);
    const key = `${harness.id}\u001f${host.hostKey}\u001f${host.buzzassistVersion}`;
    if (!groups.has(key)) {
      groups.set(key, {
        harnessId: harness.id,
        host: host.hostKey,
        buzzassistVersion: host.buzzassistVersion,
        receipts: 0,
        passed: 0,
        failed: 0,
        durations: [],
        gates: {},
        models: {},
        hostVersions: new Set(),
      });
    }
    const group = groups.get(key);
    group.receipts += 1;
    if (receipt.outcome === "pass") group.passed += 1; else group.failed += 1;
    const duration = receipt.timing?.durationSeconds;
    if (Number.isFinite(duration) && receipt.timing?.receiptOnlyRetry !== true) group.durations.push(duration);
    for (const [gateId, gate] of Object.entries(receipt.gates || {})) {
      const stat = group.gates[gateId] || (group.gates[gateId] = { pass: 0, fail: 0, skip: 0, notInForce: 0 });
      const verdict = isGateNotInForce(gate) ? "notInForce" : gate.verdict;
      if (stat[verdict] !== undefined) stat[verdict] += 1;
    }
    for (const model of host.models.length ? host.models : ["unknown"]) group.models[model] = (group.models[model] || 0) + 1;
    for (const version of host.hostVersions) group.hostVersions.add(version);
  }

  const rows = [...groups.values()].map((group) => ({
    harnessId: group.harnessId,
    host: group.host,
    buzzassistVersion: group.buzzassistVersion,
    receipts: group.receipts,
    passed: group.passed,
    failed: group.failed,
    passRate: rate(group.passed, group.receipts),
    medianDurationSeconds: median(group.durations),
    durationSamples: group.durations.length,
    worstGates: Object.entries(group.gates)
      .map(([id, stat]) => ({ id, ...stat, failRate: rate(stat.fail, group.receipts) }))
      .filter((gate) => gate.fail > 0 || gate.skip > 0)
      .sort((a, b) => b.failRate - a.failRate || b.skip - a.skip || a.id.localeCompare(b.id)),
    models: group.models,
    hostVersions: [...group.hostVersions].sort(),
  })).sort((a, b) => a.harnessId.localeCompare(b.harnessId)
    || a.buzzassistVersion.localeCompare(b.buzzassistVersion)
    || a.host.localeCompare(b.host));

  const warnings = [];
  const skippedComparisons = [];
  const byCell = new Map();
  for (const row of rows) {
    if (NOT_COMPARABLE_HOSTS.has(row.host) || row.host.includes("+")) continue;
    const cell = `${row.harnessId}\u001f${row.buzzassistVersion}`;
    if (!byCell.has(cell)) byCell.set(cell, []);
    byCell.get(cell).push(row);
  }
  for (const cellRows of byCell.values()) {
    if (cellRows.length < 2) continue;
    const enough = cellRows.filter((row) => row.receipts >= minRuns);
    const tooFew = cellRows.filter((row) => row.receipts < minRuns);
    if (tooFew.length > 0) {
      skippedComparisons.push({
        harnessId: cellRows[0].harnessId,
        buzzassistVersion: cellRows[0].buzzassistVersion,
        reason: "receipts-below-min-runs",
        minRuns,
        hosts: tooFew.map((row) => ({ host: row.host, receipts: row.receipts })),
      });
    }
    if (enough.length < 2) continue;
    const best = enough.reduce((top, row) => (row.passRate > top.passRate ? row : top), enough[0]);
    for (const row of enough) {
      const difference = Math.round((best.passRate - row.passRate) * 1000) / 1000;
      if (row === best || difference < gap) continue;
      warnings.push({
        code: "host-pass-rate-gap",
        harnessId: row.harnessId,
        buzzassistVersion: row.buzzassistVersion,
        lowHost: row.host,
        lowPassRate: row.passRate,
        lowReceipts: row.receipts,
        highHost: best.host,
        highPassRate: best.passRate,
        highReceipts: best.receipts,
        gap: difference,
        lowWorstGates: row.worstGates.slice(0, 3).map((gate) => gate.id),
      });
    }
  }

  return {
    by: "host",
    ...(channelId === null || channelId === undefined ? {} : { channel: channelId }),
    thresholds: { minRuns, gap },
    groups: rows,
    warnings,
    skippedComparisons,
    receiptCount: entries.filter((entry) => !entry.missing).length,
    unreadable,
    missing,
    invalid,
  };
}

function displayPath(value) {
  const rel = path.relative(REPO_ROOT, value);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : value;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function positiveInteger(value, flag) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${flag} は1以上の整数: ${String(value)}`);
  return number;
}

function unitInterval(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1) throw new Error(`${flag} は 0 より大きく 1 以下の数: ${String(value)}`);
  return number;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { args[key] = next; i += 1; } else { args[key] = true; }
  }
  return args;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const dir = args.dir ? path.resolve(String(args.dir)) : defaultReceiptsDir();
  const projectDirs = typeof args["project-dir"] === "string" ? [path.resolve(String(args["project-dir"]))] : [];
  let channelId = null;
  if (args.channel !== undefined) {
    // プラットフォームへ返す形はチャンネルを区別しない（redactForPlatform はチャンネル固有のものを含めない）。
    if (command === "export") throw new Error("export は --channel を受け付けない（プラットフォームへ返す形はチャンネルを区別しない）。");
    channelId = receiptIndexChannelId(args.channel);
    if (!channelId) throw new Error(`--channel はチャンネルの id（英小文字・数字・_・- の64文字まで）: ${String(args.channel).slice(0, 80)}`);
  }
  const entries = entriesForChannel(loadReceipts(dir, { projectDirs }), channelId);

  switch (command) {
    case "list": {
      print({
        dir: displayPath(dir),
        ...(projectDirs.length ? { projectDirs: projectDirs.map(displayPath) } : {}),
        ...(channelId ? { channel: channelId } : {}),
        count: entries.length,
        receipts: entries.map((entry) => entry.missing
          ? { file: entry.file, source: entry.source, channel: entry.channel || null, missing: true }
          : entry.error
          ? { file: entry.file, source: entry.source, channel: entry.channel || null, ...(entry.invalid ? { invalid: true } : {}), error: entry.error }
          : {
            source: entry.source,
            file: entry.file,
            channel: entry.channel || null,
            harness: entry.receipt.harnessBuild.harness.id,
            version: entry.receipt.harnessBuild.harness.version,
            host: runReceiptHostSummary(entry.receipt).hostKey,
            outcome: entry.receipt.outcome,
            overridden: entry.receipt.outcomeOverridden,
            failedGates: entry.receipt.summary?.failedGates || [],
          }),
      });
      break;
    }
    case "rollup": {
      const options = {
        harnessId: args.harness ? String(args.harness) : null,
        minRuns: args["min-runs"] === undefined ? DEFAULT_HOST_MIN_RUNS : positiveInteger(args["min-runs"], "--min-runs"),
        gap: args.gap === undefined ? DEFAULT_HOST_PASS_RATE_GAP : unitInterval(args.gap, "--gap"),
      };
      if (args.by !== undefined && args.by !== "host" && args.by !== "build") {
        throw new Error(`--by は host か build: ${String(args.by)}`);
      }
      // entries は --channel で絞ってある。出力にも絞ったチャンネルを残す。
      const scoped = { ...options, ...(channelId ? { channelId } : {}) };
      print(args.by === "host" ? rollupByHost(entries, scoped) : rollup(entries, scoped));
      break;
    }
    case "export": {
      // プラットフォームへ返す形。1件でも redact に失敗したら書かない——
      // 部分的に伏せた記録を返すより、返さない方が安全。
      const redacted = entries.filter((entry) => entry.receipt).map((entry) => redactForPlatform(entry.receipt));
      const payload = { version: "harness-platform-rollup-v1", receiptCount: redacted.length, receipts: redacted };
      if (args.out) {
        const target = path.resolve(String(args.out));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
        print({ wrote: displayPath(target), receiptCount: redacted.length });
      } else {
        print(payload);
      }
      break;
    }
    default:
      process.stdout.write([
        "使い方:",
        "  node scripts/harness-receipts.mjs list                    記録の一覧（Job を作ったチャンネルつき）",
        "  node scripts/harness-receipts.mjs rollup [--harness ID]   版ごとのゲート失敗率（ホスト別の小計と警告、",
        "                                                           チャンネルごとの内訳つき）",
        "  node scripts/harness-receipts.mjs rollup --by host        ハーネス × ホスト × BuzzAssist の版ごとの pass 率・",
        "                                                           落ちるゲート・所要時間の中央値と、片方のホストだけ低い組の警告",
        "      [--min-runs N]  警告に使う各ホストの最少 Receipt 数（既定 3）",
        "      [--gap X]       警告にする pass 率の差（既定 0.2）",
        "  list / rollup の --channel ID",
        "                      そのチャンネル（運営者の配置表の channels の id）で作った Job の記録だけを数える。",
        "                      チャンネルは索引の行（Job の metadata.channel）か、--project-dir の job.json から読む。",
        `                      チャンネルの無い Job・欄の無い古い索引の行は「${NO_CHANNEL_LABEL}」として内訳に出る`,
        "  node scripts/harness-receipts.mjs export [--out PATH]     プラットフォームへ返す形（チャンネルは出さない。",
        "                                                           --channel は受け付けない）",
        "",
        "  既定の置き場: 学習の状態の置き場の receipts/（索引 index.jsonl が指す RunReceipt も読む）",
        "  --dir DIR           置き場を指定する",
        "  --project-dir DIR   DIR/canvas/harness-runs/*/run-receipt.json も読む（読み取り専用）",
        "",
      ].join("\n"));
      if (command && command !== "help") process.exitCode = 2;
  }
}

if (isDirectCli(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
