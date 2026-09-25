// 正本（SKILL.md・台帳）への変更候補の、差分と記録の形。副作用の無い部品だけを置く。
//
// 差分の承認キュー（harness-learn pending / approve / reject / rollback、
// lib/harnessLearningChanges.mjs）が使う。ここに置くのは:
//
//   - 行単位の差分（hunk）と、その適用・逆適用。適用は「読んだ時点の版（base）」に対してだけ
//     行い、文脈の行が1つでも違えば適用しない。base の sha256 を照合してから当てるので、
//     当たらないのは記録が壊れているときだけ
//   - 台帳の行の種類（キューに置いた・却下した・適用した・巻き戻した）と、その畳み込み
//   - applied 台帳の「適用した変更」の行を、提案ごとの反映記録へ展開する関数
//     （status・review・curator が使う summarizeProposals がこれを通す）
//
// 行は "\n" で分け、"\n" で繋ぐ。末尾の改行は最後の空の要素として残るので、CRLF も
// 末尾改行の有無も元のバイト列どおりに戻る（照合は適用後の sha256 で行う）。

import { createHash } from "node:crypto";

export const CHANGE_RECORD_VERSION = "buzzassist-learning-change-v1";
/** キュー（<台帳の置き場>/changes.jsonl）に置く行 */
export const CHANGE_QUEUED = "canonical-change-queued";
export const CHANGE_REJECTED = "canonical-change-rejected";
/** applied 台帳に置く行 */
export const CHANGE_APPLIED = "canonical-change";
export const CHANGE_ROLLED_BACK = "canonical-rollback";

export const CHANGE_ID_PATTERN = /^chg-[a-f0-9]{12}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const PROPOSAL_ID = /^[a-f0-9]{12}$/u;
const DEFAULT_CONTEXT_LINES = 3;
// 共通の前後を除いた中央部分の表の大きさの上限。超えたら中央を丸ごと置き換える差分にする。
const MAX_DIFF_CELLS = 4_000_000;

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function splitLines(text) {
  return String(text ?? "").split("\n");
}

/** 行の列の差分を、" "（共通）・"-"（前だけ）・"+"（後だけ）の並びにする。 */
function diffOps(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const ops = [];
  for (let index = 0; index < start; index += 1) ops.push([" ", a[index]]);
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n > 0 && m > 0 && (n + 1) * (m + 1) <= MAX_DIFF_CELLS) {
    // 最長共通部分列（後ろから埋める表）。
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i * width + j] = midA[i] === midB[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push([" ", midA[i]]);
        i += 1;
        j += 1;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        ops.push(["-", midA[i]]);
        i += 1;
      } else {
        ops.push(["+", midB[j]]);
        j += 1;
      }
    }
    for (; i < n; i += 1) ops.push(["-", midA[i]]);
    for (; j < m; j += 1) ops.push(["+", midB[j]]);
  } else {
    for (const line of midA) ops.push(["-", line]);
    for (const line of midB) ops.push(["+", line]);
  }
  for (let index = endA; index < a.length; index += 1) ops.push([" ", a[index]]);
  return ops;
}

/**
 * 前後の本文から hunk の列を作る。hunk は { oldStart, newStart, oldLines, newLines }
 * （位置は0始まりの行番号、oldLines / newLines は文脈の行を含む）。
 */
export function computeLineHunks(beforeText, afterText, { context = DEFAULT_CONTEXT_LINES } = {}) {
  const ops = diffOps(splitLines(beforeText), splitLines(afterText));
  const positions = [];
  let aIndex = 0;
  let bIndex = 0;
  for (const [op] of ops) {
    positions.push([aIndex, bIndex]);
    if (op !== "+") aIndex += 1;
    if (op !== "-") bIndex += 1;
  }
  const changed = [];
  ops.forEach(([op], index) => { if (op !== " ") changed.push(index); });
  if (changed.length === 0) return [];
  const ranges = [];
  let rangeStart = changed[0];
  let rangeEnd = changed[0];
  for (const index of changed.slice(1)) {
    if (index - rangeEnd - 1 <= context * 2) rangeEnd = index;
    else {
      ranges.push([rangeStart, rangeEnd]);
      rangeStart = index;
      rangeEnd = index;
    }
  }
  ranges.push([rangeStart, rangeEnd]);
  return ranges.map(([first, last]) => {
    const from = Math.max(0, first - context);
    const to = Math.min(ops.length, last + context + 1);
    const slice = ops.slice(from, to);
    return {
      oldStart: positions[from][0],
      newStart: positions[from][1],
      oldLines: slice.filter(([op]) => op !== "+").map(([, line]) => line),
      newLines: slice.filter(([op]) => op !== "-").map(([, line]) => line),
    };
  });
}

function patchError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

/** 記録から読んだ hunk の形を確かめる（台帳の行は信用しない）。 */
export function validateHunks(hunks) {
  if (!Array.isArray(hunks) || hunks.length === 0 || hunks.length > 5_000) throw patchError("change-record-invalid", "hunk の列が不正");
  let previousOld = -1;
  let previousNew = -1;
  for (const hunk of hunks) {
    const ok = hunk && typeof hunk === "object"
      && Number.isSafeInteger(hunk.oldStart) && hunk.oldStart >= 0
      && Number.isSafeInteger(hunk.newStart) && hunk.newStart >= 0
      && Array.isArray(hunk.oldLines) && hunk.oldLines.every((line) => typeof line === "string")
      && Array.isArray(hunk.newLines) && hunk.newLines.every((line) => typeof line === "string");
    if (!ok) throw patchError("change-record-invalid", "hunk の形が不正");
    if (hunk.oldStart < previousOld || hunk.newStart < previousNew) throw patchError("change-record-invalid", "hunk の順序が不正");
    previousOld = hunk.oldStart + hunk.oldLines.length;
    previousNew = hunk.newStart + hunk.newLines.length;
  }
  return hunks;
}

/**
 * hunk を当てる。reverse なら後 → 前へ戻す。文脈の行が1つでも違えば patch-mismatch。
 */
export function applyLineHunks(text, hunks, { reverse = false } = {}) {
  validateHunks(hunks);
  const lines = splitLines(text);
  const out = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const start = reverse ? hunk.newStart : hunk.oldStart;
    const from = reverse ? hunk.newLines : hunk.oldLines;
    const to = reverse ? hunk.oldLines : hunk.newLines;
    if (start < cursor || start + from.length > lines.length) throw patchError("patch-mismatch", "hunk の位置が本文と合わない");
    for (let index = 0; index < from.length; index += 1) {
      if (lines[start + index] !== from[index]) throw patchError("patch-mismatch", `${start + index + 1} 行目が差分の記録と違う`);
    }
    for (let index = cursor; index < start; index += 1) out.push(lines[index]);
    out.push(...to);
    cursor = start + from.length;
  }
  for (let index = cursor; index < lines.length; index += 1) out.push(lines[index]);
  return out.join("\n");
}

/** 人が読む unified diff の形（記録には hunk を持ち、表示のときだけ作る）。 */
export function renderUnifiedDiff(hunks, { label = "canonical" } = {}) {
  const lines = [`--- ${label}（base）`, `+++ ${label}（提案）`];
  for (const hunk of hunks) {
    lines.push(`@@ -${hunk.oldStart + 1},${hunk.oldLines.length} +${hunk.newStart + 1},${hunk.newLines.length} @@`);
    const ops = diffOps(hunk.oldLines, hunk.newLines);
    for (const [op, line] of ops) lines.push(`${op}${line}`);
  }
  return `${lines.join("\n")}\n`;
}

/** 追加された行（検査にかける本文）。 */
export function addedLines(hunks) {
  const out = [];
  for (const hunk of hunks) {
    for (const [op, line] of diffOps(hunk.oldLines, hunk.newLines)) if (op === "+") out.push(line);
  }
  return out;
}

export function diffStats(hunks) {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const [op] of diffOps(hunk.oldLines, hunk.newLines)) {
      if (op === "+") added += 1;
      else if (op === "-") removed += 1;
    }
  }
  return { hunks: hunks.length, added, removed };
}

/** 変更の ID。同じ差分を別の時刻にキューへ置いたら別の ID になる（承認と巻き戻しの記録を混ぜない）。 */
export function changeIdFor({ target, targetPath, baseSha256, afterSha256, proposalIds, queuedAt }) {
  const material = [
    CHANGE_RECORD_VERSION,
    String(target),
    String(targetPath).replaceAll("\\", "/"),
    String(baseSha256),
    String(afterSha256),
    [...proposalIds].sort().join(","),
    String(queuedAt),
  ].join("\u001f");
  return `chg-${sha256Hex(material).slice(0, 12)}`;
}

export function isChangeRecord(row) {
  return [CHANGE_QUEUED, CHANGE_REJECTED, CHANGE_APPLIED, CHANGE_ROLLED_BACK].includes(row?.recordType);
}

function validChangeRow(row) {
  return row && typeof row === "object" && CHANGE_ID_PATTERN.test(String(row.changeId || ""));
}

/**
 * キューの行と applied 台帳の行を、変更 ID ごとの状態へ畳む。
 * 状態: pending（置いただけ）/ rejected / approved / rolled-back。
 * 記録は消さないので、同じ変更の行が複数あれば後の状態が勝つ（却下と承認の両方があれば承認が勝つ）。
 */
export function foldLearningChanges(queueRows = [], appliedRows = []) {
  const changes = new Map();
  for (const row of queueRows) {
    if (!validChangeRow(row) || row.recordType !== CHANGE_QUEUED) continue;
    if (!SHA256_HEX.test(String(row.baseSha256 || "")) || !SHA256_HEX.test(String(row.afterSha256 || ""))) continue;
    if (!changes.has(row.changeId)) changes.set(row.changeId, { changeId: row.changeId, queued: row, status: "pending", rejected: null, applied: null, rolledBack: null });
  }
  for (const row of queueRows) {
    if (!validChangeRow(row) || row.recordType !== CHANGE_REJECTED) continue;
    const change = changes.get(row.changeId);
    if (change && change.status === "pending") {
      change.status = "rejected";
      change.rejected = row;
    }
  }
  for (const row of appliedRows) {
    if (!validChangeRow(row)) continue;
    if (row.recordType === CHANGE_APPLIED) {
      const change = changes.get(row.changeId) || { changeId: row.changeId, queued: null, status: "pending", rejected: null, applied: null, rolledBack: null };
      change.status = "approved";
      change.applied = row;
      changes.set(row.changeId, change);
    }
  }
  for (const row of appliedRows) {
    if (!validChangeRow(row) || row.recordType !== CHANGE_ROLLED_BACK) continue;
    const change = changes.get(row.changeId);
    if (change && change.applied) {
      change.status = "rolled-back";
      change.rolledBack = row;
    }
  }
  return changes;
}

/**
 * applied 台帳の行を、提案ごとの反映記録へ展開する。
 *
 * approve が書く「適用した変更」の行（1変更に1行、提案 ID の列を持つ）は、提案ごとの
 * 反映記録（apply が書くのと同じ形）として数える。巻き戻した変更は数えない。
 * 巻き戻しの行そのものは反映記録ではないので外す。それ以外の行はそのまま返す。
 */
export function expandAppliedRecords(applied = []) {
  const rolledBack = new Set(applied.filter((row) => row?.recordType === CHANGE_ROLLED_BACK).map((row) => row.changeId));
  const out = [];
  for (const row of applied) {
    if (row?.recordType === CHANGE_ROLLED_BACK) continue;
    if (row?.recordType === CHANGE_APPLIED) {
      if (rolledBack.has(row.changeId)) continue;
      for (const id of Array.isArray(row.proposalIds) ? row.proposalIds : []) {
        if (!PROPOSAL_ID.test(String(id))) continue;
        out.push({
          id,
          target: row.target,
          targetPath: row.targetPath,
          targetSha256: row.afterSha256,
          ...(row.targetSource ? { targetSource: row.targetSource } : {}),
          reviewer: row.reviewer,
          attestedBy: row.attestedBy,
          note: row.note,
          evidenceVersion: 2,
          promotionMarker: `buzzassist-learning:${id}`,
          appliedAt: row.appliedAt,
          changeId: row.changeId,
          via: "approve",
        });
      }
      continue;
    }
    out.push(row);
  }
  return out;
}

/** 正本の差分に入る印（buzzassist-learning:<提案ID>）の HTML コメントの行。検査の前に外す。 */
export function stripPromotionMarkerComments(text) {
  return String(text ?? "").replace(/<!--\s*buzzassist-learning:[a-f0-9]{12}\s*-->/gu, "");
}
