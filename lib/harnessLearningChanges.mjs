// 正本（SKILL.md・台帳）への変更を、差分の承認キューに通す（harness-learn pending / approve /
// reject / rollback）。
//
// 既存の流れ:
//
//   capture（提案を積む）→ sync（機械が所有する overlay だけを書き直す）→ review（まとめ方の案、
//   dry-run）→ 人が skill-creator で正本を直す → apply / promote（「正本に書いた」ことを人の確認
//   つきで記録する）
//
// apply / promote は正本を1文字も書かない。正本を書き換えるのは人（かエージェント）の直接編集で、
// 「どの版を読んで、どこをどう変え、誰が通したか」は残らなかった（SKILL.md の cx-a3 の未対応）。
// ここはその間に入る:
//
//   - pending: エージェントが正本の書き換え案を作り、差分と「読んだ時点の対象ファイルの sha256
//     （base）」つきでキューに置く。正本には触らない。提案 ID ごとの印と規則本文（apply と同じ
//     反映証跡）が案の中にあることを、置く時点で確かめる
//   - approve: 人の確認（対話端末＋ --human-verified ＋ reviewer 名。apply と同じ）でだけ通る。
//     機械の自己申告（--agent-attested）では通らない。対象の今の sha256 が base と一致するとき
//     だけ差分を当て（読んでから書く）、違えば base-changed で拒否する。当てたら applied 台帳へ
//     「適用した変更」を1行残す（対象・変更前後の sha256・承認者・時刻・元の提案 ID・差分）。
//     この行は提案ごとの反映記録として数えられるので、approve のあとに apply は要らない
//   - reject: キューから外す（記録は消さない）
//   - rollback: 対象の今の sha256 が「変更後」と一致するときだけ変更前へ戻し、戻したことも
//     applied 台帳へ残す。一致しなければ rollback-conflict で拒否する
//
// apply は、人が skill-creator で直接直した変更の記録として残る（キューを通さない経路）。
// 同じ検証（assertPromotableProposal・canonicalHasPromotionEvidence・人の確認）を approve も通す。
//
// 評価の関門: 正本スキル（.agents/skills/<id>/SKILL.md）への approve の前に、lib/skillEvals.mjs の
// 記録から「変更後の版の contentSha256 で両ホストの eval 結果があり、変更前の版より悪化していない」
// かを見る。既定は警告、--require-evals のときだけ止める（skills:check:release と同じ方針）。
// eval の実行そのものはしない（モデルを呼ばない）。

import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectSensitiveSignals } from "../scripts/audit-public-surface.mjs";
import { loadSensitiveVocabulary, SENSITIVE_VOCABULARY_DIGEST_PATH } from "../scripts/audit-package-tarball.mjs";
import {
  HUMAN_VERIFIED,
  PROMOTION_NOTE_MIN_CHARS,
  appendLearningJsonl,
  assertPromotableProposal,
  attestationFor,
  canonicalHasPromotionEvidence,
  channelTermsInSharedEntry,
  createCanonicalReaders,
  ledgerPathFor,
  learningLedgerPaths,
  loadTargets,
  privateTermsInSharedEntry,
  promotionMarker,
  readLearningJsonl,
  requireWritableTarget,
  resolveTarget,
  summarizeProposals,
} from "../scripts/harness-learn.mjs";
import {
  CHANGE_APPLIED,
  CHANGE_ID_PATTERN,
  CHANGE_QUEUED,
  CHANGE_RECORD_VERSION,
  CHANGE_REJECTED,
  CHANGE_ROLLED_BACK,
  addedLines,
  applyLineHunks,
  changeIdFor,
  computeLineHunks,
  diffStats,
  foldLearningChanges,
  renderUnifiedDiff,
  sha256Hex,
  stripPromotionMarkerComments,
  validateHunks,
} from "./harnessLearningChangeRecords.mjs";
import { assertLearningWriteAllowed } from "./harnessLearningGuard.mjs";
import { describeLearningBlockReasons, inspectLearningText } from "./harnessLearningInspection.mjs";
import { channelLedgerDir, resolveLearningState, sharedLedgerPath, withLearningFileLock } from "./harnessLearningState.mjs";
import { SKILL_EVAL_HOSTS, normalizeSkillEvalCases, readSkillEvalRecords, resolveSkillEvalsDir } from "./skillEvals.mjs";

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const MAX_PROPOSED_BYTES = 4 * 1024 * 1024;
const CANONICAL_SKILL_PATH = /^\.agents\/skills\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})\/SKILL\.md$/u;

export const LEARNING_CHANGE_ERROR_CODES = Object.freeze([
  "base-changed",
  "rollback-conflict",
  "human-verification-required",
  "change-not-found",
  "change-not-pending",
  "change-not-applied",
  "target-moved",
  "patch-mismatch",
  "evals-gate-failed",
  "no-change",
  "shared-canonical-read-only-here",
  "change-content-blocked",
]);

function changeError(code, message, extra = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function isChannelPackTarget(target) {
  return String(target || "").startsWith("channel-pack:");
}

function samePathText(left, right) {
  return path.normalize(String(left || "")) === path.normalize(String(right || ""));
}

function posixRel(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//u, "");
}

/**
 * 台帳の置き場と、正本を読む規則をまとめる。既定（このリポジトリの写し）は harness-learn と
 * 同じ関数を使う。別の root（試験の合成リポジトリなど）を渡したときは、その root から
 * 学習の置き場を解決し、共有台帳と Channel Pack の既定の台帳だけを読む（本物の台帳へ書かない）。
 */
export function learningChangeContext({
  repoRoot = DEFAULT_REPO_ROOT,
  targets = undefined,
  env = process.env,
  homeDir = homedir(),
  now = () => new Date().toISOString(),
  ledgerPath = undefined,
  readLedger = undefined,
} = {}) {
  const root = path.resolve(repoRoot);
  const targetMap = targets ?? loadTargets(path.join(root, "docs", "learning", "targets.json"));
  const state = resolveLearningState({ codeRoot: root, env, homeDir });
  let resolveLedger = ledgerPath;
  let readAll = readLedger;
  if (root === DEFAULT_REPO_ROOT) {
    resolveLedger ??= ledgerPathFor;
    readAll ??= (kind) => learningLedgerPaths(kind).flatMap(readLearningJsonl);
  } else {
    resolveLedger ??= (target, kind) => {
      const resolved = resolveTarget(String(target || ""));
      if (isChannelPackTarget(resolved)) {
        const packId = targetMap[resolved]?.packId || resolved.slice("channel-pack:".length);
        return path.join(channelLedgerDir(state, packId), `${kind}.jsonl`);
      }
      return sharedLedgerPath(state, kind);
    };
    readAll ??= (kind) => {
      const files = new Set([sharedLedgerPath(state, kind)]);
      for (const [target, definition] of Object.entries(targetMap)) {
        if (definition?.scope === "channel-pack") files.add(resolveLedger(target, kind));
      }
      return [...files].flatMap(readLearningJsonl);
    };
  }
  const readers = createCanonicalReaders({ repoRoot: root, targets: targetMap });
  return {
    repoRoot: root,
    targets: targetMap,
    state,
    env,
    homeDir,
    now,
    ledgerPath: resolveLedger,
    readLedger: readAll,
    readers,
  };
}

function summary(context) {
  return summarizeProposals(
    context.readLedger("proposals"),
    context.readLedger("applied"),
    context.readers.readCanonical,
    context.readers.hashCanonical,
  );
}

function changesState(context) {
  return foldLearningChanges(context.readLedger("changes"), context.readLedger("applied"));
}

function resolveWritable(context, target) {
  const resolved = requireWritableTarget(target, { repoRoot: context.repoRoot, targets: context.targets });
  // 配布された写しの中の共有層の正本（プラグインのキャッシュ）は、更新で置き換わる。そこへ書いても
  // 次の版で黙って消えるので書かない。共有層の正本は開発用チェックアウトで直す。
  if (context.state.mode === "installed" && !isChannelPackTarget(resolved.target)) {
    throw changeError(
      "shared-canonical-read-only-here",
      `${resolved.target} の正本はこの写し（配布されたプラグイン）の中にあり、更新で置き換わります。`
        + "共有層の正本は開発用チェックアウトで直し、ここからは capture と feedback で返してください。",
    );
  }
  return resolved;
}

function readCanonicalBytes(full) {
  const real = fs.realpathSync(full);
  const bytes = fs.readFileSync(real);
  return { real, bytes, text: bytes.toString("utf8"), sha256: sha256Hex(bytes) };
}

/** 正本を書き換える。symlink は辿った先を書く（橋渡しのリンクを通常ファイルへ変えない）。 */
function writeCanonicalAtomic(real, text) {
  const mode = fs.statSync(real).mode & 0o777;
  const temporary = path.join(path.dirname(real), `.${path.basename(real)}.${process.pid}.learning-change.partial`);
  fs.writeFileSync(temporary, text, { encoding: "utf8", mode });
  fs.renameSync(temporary, real);
}

function requireAttestation(input, { humanOnly }) {
  const attested = attestationFor({
    reviewer: input.reviewer,
    isInteractive: Boolean(input.isInteractive),
    agentAttested: input.agentAttested === true,
    humanVerified: input.humanVerified === true,
  });
  if (!attested.ok) throw changeError("human-verification-required", attested.message);
  if (humanOnly && attested.attestation.attestedBy !== HUMAN_VERIFIED) {
    throw changeError(
      "human-verification-required",
      "正本を書き換える操作は人の確認でだけ通します。人が差分を読んだ端末から --reviewer <名前> --human-verified で実行してください"
        + "（機械の自己申告 --agent-attested では承認も巻き戻しもできません）。",
    );
  }
  return attested.attestation;
}

function inspectChangeText(text, { target, context, signals, privateVocabulary }) {
  const body = stripPromotionMarkerComments(text);
  const reasons = inspectLearningText(body, { homeRoot: context.homeDir });
  if (reasons.length > 0) {
    throw changeError("change-content-blocked", `追加する本文が書き込み前の検査に当たりました: ${describeLearningBlockReasons(reasons)}`);
  }
  if (isChannelPackTarget(target)) return;
  // 共有層の正本は公開リポジトリで追跡される。チャンネル固有語と検査語彙に一致する語を入れない。
  const entry = { target, text: body, evidence: "" };
  const channel = channelTermsInSharedEntry(entry, signals);
  if (!channel.ok) throw changeError("change-content-blocked", channel.message);
  const privateVerdict = privateTermsInSharedEntry(entry, privateVocabulary);
  if (!privateVerdict.ok) throw changeError("change-content-blocked", privateVerdict.message);
}

function defaultSignals(repoRoot) {
  try { return collectSensitiveSignals(repoRoot); } catch { return { terms: [], castIds: [] }; }
}

function defaultPrivateVocabulary(repoRoot) {
  try {
    return loadSensitiveVocabulary(path.join(repoRoot, SENSITIVE_VOCABULARY_DIGEST_PATH), { projectDir: repoRoot }).vocabulary;
  } catch {
    return null;
  }
}

function proposalEntries(context, proposalIds, note) {
  const ids = [...new Set(proposalIds.map((id) => String(id).trim()).filter(Boolean))];
  if (ids.length === 0) throw new Error("--id <提案ID>[,<提案ID>...] が必要です（この変更で反映する提案）");
  const all = summary(context);
  return ids.map((id) => {
    const entry = all.find((item) => item.id === id);
    if (!entry) throw changeError("change-not-found", `提案が見つかりません: ${id}`);
    if (entry.applied) throw changeError("change-not-pending", `${id} は既に反映済みです`);
    assertPromotableProposal(entry, note, { homeRoot: context.homeDir });
    return entry;
  });
}

function assertEvidence(entries, note, afterText, rel) {
  for (const entry of entries) {
    if (!canonicalHasPromotionEvidence({ id: entry.id, note }, afterText)) {
      throw new Error(
        `提案 ${entry.id} の反映証跡が、書き換え案（${rel}）にありません。\n`
          + `  ${promotionMarker(entry.id)}\n`
          + `という一意マーカーと、${PROMOTION_NOTE_MIN_CHARS}文字以上の規則本文（--note に完全一致）を、同じ節に書いてください。`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// pending（キューに置く・一覧・表示）

/**
 * 正本の書き換え案をキューに置く。正本には触らない。
 *
 * @param proposedText 書き換え後の正本の全文（エージェントが写しを直して作ったもの）
 * @param baseSha256   その案を作るときに読んだ正本の sha256。渡せば今の正本と照合し、違えば base-changed
 */
export function enqueueLearningChange({
  proposalIds = [],
  proposedText,
  baseSha256 = "",
  note = "",
  target = "",
  signals = undefined,
  privateVocabulary = undefined,
  ...options
} = {}) {
  const context = learningChangeContext(options);
  assertLearningWriteAllowed(context.env, "pending");
  if (typeof proposedText !== "string") throw new Error("--proposed <書き換え後の正本のファイル> が必要です");
  if (Buffer.byteLength(proposedText, "utf8") > MAX_PROPOSED_BYTES) throw new Error("書き換え案が大きすぎます（4MB まで）");
  const noteText = String(note || "").trim();
  if (Array.from(noteText).length < PROMOTION_NOTE_MIN_CHARS) {
    throw new Error(`--note に、正本へ書いた ${PROMOTION_NOTE_MIN_CHARS} 文字以上の規則本文を完全一致で渡してください`);
  }
  const entries = proposalEntries(context, proposalIds, noteText);
  const resolvedTargets = [...new Set(entries.map((entry) => resolveTarget(entry.target)))];
  if (resolvedTargets.length !== 1) throw new Error(`1つの変更で直せる正本は1つです（提案の宛先: ${resolvedTargets.join(", ")}）`);
  const changeTarget = resolvedTargets[0];
  if (target && resolveTarget(target) !== changeTarget) throw new Error(`--target ${target} と提案の宛先 ${changeTarget} が違います`);
  const resolved = resolveWritable(context, changeTarget);
  const base = readCanonicalBytes(resolved.full);
  const expectedBase = String(baseSha256 || "").trim().toLowerCase().replace(/^sha256:/u, "");
  if (expectedBase && !SHA256_HEX.test(expectedBase)) throw new Error("--base は sha256（64桁の16進）にしてください");
  if (expectedBase && expectedBase !== base.sha256) {
    throw changeError("base-changed", `案を作るときに読んだ版（${expectedBase.slice(0, 12)}）と今の正本（${base.sha256.slice(0, 12)}）が違います。今の正本を読み直して案を作り直してください。`);
  }
  const afterSha256 = sha256Hex(Buffer.from(proposedText, "utf8"));
  if (afterSha256 === base.sha256) throw changeError("no-change", "書き換え案が今の正本と同じです");
  assertEvidence(entries, noteText, proposedText, resolved.rel);
  const hunks = computeLineHunks(base.text, proposedText);
  if (applyLineHunks(base.text, hunks) !== proposedText) throw changeError("patch-mismatch", "差分を当てても書き換え案に戻らない");
  inspectChangeText(addedLines(hunks).join("\n"), {
    target: changeTarget,
    context,
    signals: signals ?? defaultSignals(context.repoRoot),
    privateVocabulary: privateVocabulary === undefined ? defaultPrivateVocabulary(context.repoRoot) : privateVocabulary,
  });
  const queuedAt = String(context.now());
  const proposalIdList = entries.map((entry) => entry.id).sort();
  const changeId = changeIdFor({
    target: changeTarget, targetPath: resolved.rel, baseSha256: base.sha256, afterSha256, proposalIds: proposalIdList, queuedAt,
  });
  const row = {
    version: CHANGE_RECORD_VERSION,
    recordType: CHANGE_QUEUED,
    id: changeId,
    changeId,
    target: changeTarget,
    targetPath: resolved.rel,
    ...(resolved.source ? { targetSource: resolved.source } : {}),
    baseSha256: base.sha256,
    afterSha256,
    proposalIds: proposalIdList,
    note: noteText,
    stats: diffStats(hunks),
    hunks,
    queuedAt,
  };
  const queuePath = context.ledgerPath(changeTarget, "changes");
  withLearningFileLock(queuePath, () => {
    const open = [...changesState(context).values()].find((change) => change.status === "pending"
      && change.queued?.target === changeTarget
      && change.queued?.baseSha256 === base.sha256
      && change.queued?.afterSha256 === afterSha256);
    if (open) throw changeError("change-not-pending", `同じ差分が既にキューにあります: ${open.changeId}`);
    appendLearningJsonl(queuePath, row);
  });
  return { change: row, queuePath };
}

/** キューの一覧。pending は今の正本と base を照合し、変わっていれば stale（base-changed）と示す。 */
export function listLearningChanges({ includeClosed = false, ...options } = {}) {
  const context = learningChangeContext(options);
  const out = [];
  for (const change of changesState(context).values()) {
    if (!includeClosed && change.status !== "pending") continue;
    const record = change.queued || change.applied;
    let current = null;
    if (record?.target) {
      try {
        const resolved = requireWritableTarget(record.target, { repoRoot: context.repoRoot, targets: context.targets });
        current = readCanonicalBytes(resolved.full).sha256;
      } catch {
        current = null;
      }
    }
    out.push({
      changeId: change.changeId,
      status: change.status,
      target: record?.target ?? null,
      targetPath: record?.targetPath ?? null,
      proposalIds: record?.proposalIds ?? [],
      baseSha256: change.queued?.baseSha256 ?? change.applied?.beforeSha256 ?? null,
      afterSha256: change.queued?.afterSha256 ?? change.applied?.afterSha256 ?? null,
      stats: change.queued?.stats ?? null,
      queuedAt: change.queued?.queuedAt ?? null,
      currentSha256: current,
      stale: change.status === "pending" && current !== null && current !== change.queued?.baseSha256,
    });
  }
  return out.sort((left, right) => String(left.queuedAt).localeCompare(String(right.queuedAt)));
}

function findChange(context, changeId) {
  const id = String(changeId || "").trim();
  if (!CHANGE_ID_PATTERN.test(id)) throw new Error("--change <chg-で始まる変更ID> が必要です（pending で確認）");
  const change = changesState(context).get(id);
  if (!change) throw changeError("change-not-found", `変更が見つかりません: ${id}`);
  return change;
}

/** 差分を人が読む形で返す。out を渡せば、書き換え後の全文を別のファイルへ書く（eval を流す写しを作るため）。 */
export function showLearningChange({ changeId, out = "", ...options } = {}) {
  const context = learningChangeContext(options);
  const change = findChange(context, changeId);
  const record = change.queued || change.applied;
  const hunks = validateHunks(record.hunks);
  const diff = renderUnifiedDiff(hunks, { label: posixRel(record.targetPath) });
  let written = null;
  if (out) {
    const resolved = requireWritableTarget(record.target, { repoRoot: context.repoRoot, targets: context.targets });
    const destination = path.resolve(out);
    if (fs.existsSync(destination) && fs.realpathSync(destination) === fs.realpathSync(resolved.full)) {
      throw new Error("--out に正本そのものは指定できません（書き換えは approve だけが行う）");
    }
    const base = readCanonicalBytes(resolved.full);
    const baseSha = change.queued?.baseSha256 ?? change.applied?.beforeSha256;
    if (base.sha256 !== baseSha) throw changeError("base-changed", "今の正本が差分の base と違うので、書き換え後の全文を作れません");
    const text = applyLineHunks(base.text, hunks);
    if (sha256Hex(Buffer.from(text, "utf8")) !== (change.queued?.afterSha256 ?? change.applied?.afterSha256)) {
      throw changeError("patch-mismatch", "差分を当てた結果が記録の sha256 と違う");
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, text, "utf8");
    written = destination;
  }
  return { change: { changeId: change.changeId, status: change.status, record }, diff, written };
}

// ---------------------------------------------------------------------------
// 評価の関門

function latestGraded(records, contentSha256) {
  const map = new Map();
  for (const record of records) {
    if (record.contentSha256 !== contentSha256) continue;
    const key = `${record.evalId}\u0000${record.host}`;
    const previous = map.get(key);
    const newer = !previous
      || String(record.recordedAt || "") > String(previous.recordedAt || "")
      || (String(record.recordedAt || "") === String(previous.recordedAt || "") && record._order > previous._order);
    if (newer) map.set(key, record);
  }
  return map;
}

/**
 * 正本スキルの変更前後の eval の記録を比べる（読むだけ。モデルは呼ばない）。
 * 見ること: 変更後の版（contentSha256）で両ホストの結果があるか・変更前の版の結果があるか・
 * 同じ eval とホストで変更前より合格の割合が下がっていないか。
 * 比べられないこと（変更前の結果が無い）は「悪化していない」ではないので、ok にしない。
 */
export function evaluateChangeEvalGate({
  repoRoot = DEFAULT_REPO_ROOT,
  targetPath,
  beforeSha256,
  afterSha256,
  env = process.env,
  homeDir = homedir(),
  evalsDir = "",
} = {}) {
  const rel = posixRel(targetPath);
  const match = CANONICAL_SKILL_PATH.exec(rel);
  if (!match) return { applicable: false, ok: true, reason: "not-a-canonical-skill" };
  const skill = match[1];
  const evalsPath = path.join(repoRoot, ".agents", "skills", skill, "evals", "evals.json");
  if (!fs.existsSync(evalsPath)) return { applicable: false, ok: true, reason: "no-evals", skill };
  let cases;
  try {
    cases = normalizeSkillEvalCases(JSON.parse(fs.readFileSync(evalsPath, "utf8")), { label: `${skill} evals.json` });
  } catch (error) {
    return { applicable: true, ok: false, reason: "evals-unreadable", skill, detail: String(error?.message || error).slice(0, 200), evals: 0, missing: {}, baselineMissing: {}, regressions: [] };
  }
  let skillId = null;
  try {
    const inventory = JSON.parse(fs.readFileSync(path.join(repoRoot, ".agents", "skills", "inventory.manifest.json"), "utf8"));
    skillId = (inventory.skills || []).find((entry) => posixRel(entry.canonicalPath) === rel)?.id ?? null;
  } catch { /* 在庫が無い写しでは名前で照合する */ }
  const dir = evalsDir ? path.resolve(evalsDir) : resolveSkillEvalsDir({ repoRoot, env, homeDir }).dir;
  const records = readSkillEvalRecords(dir).records.filter((record) => record.status === "graded"
    && (skillId ? record.skillId === skillId : record.skillName === skill || record.skillId === skill || String(record.skillId).endsWith(`:${skill}`)));
  const after = latestGraded(records, `sha256:${afterSha256}`);
  const before = latestGraded(records, `sha256:${beforeSha256}`);
  const missing = {};
  const baselineMissing = {};
  const regressions = [];
  for (const host of SKILL_EVAL_HOSTS) {
    for (const evalCase of cases) {
      const key = `${evalCase.id}\u0000${host}`;
      const now = after.get(key);
      const old = before.get(key);
      if (!now) (missing[host] ??= []).push(evalCase.id);
      if (!old) (baselineMissing[host] ??= []).push(evalCase.id);
      if (now && old && now.total && old.total && now.passed / now.total < old.passed / old.total) {
        regressions.push({ evalId: evalCase.id, host, before: { passed: old.passed, total: old.total }, after: { passed: now.passed, total: now.total } });
      }
    }
  }
  const ok = Object.keys(missing).length === 0 && Object.keys(baselineMissing).length === 0 && regressions.length === 0;
  return { applicable: true, ok, skill, skillId, evals: cases.length, missing, baselineMissing, regressions };
}

/** 台帳へ残す形（パスや本文を持たない）。 */
function evalGateRecord(gate, required) {
  if (!gate.applicable) return { applicable: false, reason: gate.reason, required };
  const count = (map) => Object.fromEntries(Object.entries(map).map(([host, ids]) => [host, ids.length]));
  return {
    applicable: true,
    ok: gate.ok,
    required,
    evals: gate.evals,
    missing: count(gate.missing || {}),
    baselineMissing: count(gate.baselineMissing || {}),
    regressions: (gate.regressions || []).map(({ evalId, host, before, after }) => ({ evalId, host, before, after })),
    ...(gate.reason ? { reason: gate.reason } : {}),
  };
}

export function formatEvalGate(gate, { required = false } = {}) {
  if (!gate.applicable) {
    return gate.reason === "no-evals"
      ? `評価の関門: ${gate.skill} に evals が無いので見ていません。\n`
      : "";
  }
  const mode = required ? "--require-evals のため止めます" : "警告のみ。止めるには --require-evals";
  if (gate.ok) return `評価の関門: ${gate.skill} の変更後の版で両ホストの eval 結果があり、変更前より悪化していません（${gate.evals} 件）。\n`;
  const lines = [`評価の関門（${mode}）: ${gate.skill} の変更後の版を、変更前の版と比べられません・または悪化しています。`];
  if (gate.reason === "evals-unreadable") lines.push(`  - evals.json を読めません: ${gate.detail}`);
  const list = (ids) => `${ids.slice(0, 8).join(", ")}${ids.length > 8 ? ` ほか ${ids.length - 8} 件` : ""}`;
  for (const [host, ids] of Object.entries(gate.missing || {})) lines.push(`  - 変更後の版に ${host} の結果が無い eval: ${list(ids)}`);
  for (const [host, ids] of Object.entries(gate.baselineMissing || {})) lines.push(`  - 変更前の版に ${host} の結果が無い eval（比べられない）: ${list(ids)}`);
  for (const entry of gate.regressions || []) {
    lines.push(`  - 悪化: ${entry.evalId} ${entry.host} ${entry.before.passed}/${entry.before.total} → ${entry.after.passed}/${entry.after.total}`);
  }
  lines.push("  流し方: harness-learn pending --show <変更ID> --out <写しの SKILL.md> で変更後の全文を写しへ書き、その写しで");
  lines.push("          node scripts/skill-evals.mjs run --execute --skill <id> --project-dir <写し>（変更前の版は今の正本で流す）");
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// approve / reject / rollback

/**
 * キューの変更を人の確認つきで正本へ当てる。
 * 対象の今の sha256 が base と一致するときだけ書く（違えば base-changed）。
 */
export function approveLearningChange({
  changeId,
  reviewer,
  humanVerified = false,
  agentAttested = false,
  isInteractive = false,
  requireEvals = false,
  evalsDir = "",
  ...options
} = {}) {
  const context = learningChangeContext(options);
  assertLearningWriteAllowed(context.env, "approve");
  const attestation = requireAttestation({ reviewer, humanVerified, agentAttested, isInteractive }, { humanOnly: true });
  const change = findChange(context, changeId);
  if (change.status !== "pending") throw changeError("change-not-pending", `${change.changeId} は ${change.status} です（承認できるのは pending だけ）`);
  const queued = change.queued;
  const hunks = validateHunks(queued.hunks);
  const resolved = resolveWritable(context, queued.target);
  if (!samePathText(resolved.rel, queued.targetPath) || (queued.targetSource && resolved.source !== queued.targetSource)) {
    throw changeError("target-moved", `正本の置き場がキューに置いたときと違います（${posixRel(queued.targetPath)} → ${posixRel(resolved.rel)}）。pending を作り直してください。`);
  }
  // 反映する提案は、今も反映待ちで昇格できるものでなければならない。
  const entries = proposalEntries(context, queued.proposalIds, queued.note);
  const gate = evaluateChangeEvalGate({
    repoRoot: context.repoRoot,
    targetPath: queued.targetPath,
    beforeSha256: queued.baseSha256,
    afterSha256: queued.afterSha256,
    env: context.env,
    homeDir: context.homeDir,
    evalsDir,
  });
  if (gate.applicable && !gate.ok && requireEvals) {
    throw changeError("evals-gate-failed", `評価の関門を通りません（--require-evals）。\n${formatEvalGate(gate, { required: true })}`, { gate });
  }
  const appliedPath = context.ledgerPath(queued.target, "applied");
  const record = withLearningFileLock(appliedPath, () => {
    // 読んでから書く: 錠の中で今の正本を読み直し、base と照合する。
    if (changesState(context).get(change.changeId)?.status !== "pending") {
      throw changeError("change-not-pending", `${change.changeId} は別の操作で処理済みです`);
    }
    const current = readCanonicalBytes(resolved.full);
    if (current.sha256 !== queued.baseSha256) {
      throw changeError("base-changed", `正本（${posixRel(queued.targetPath)}）がキューに置いたあとに変わりました（base ${queued.baseSha256.slice(0, 12)} → 今 ${current.sha256.slice(0, 12)}）。今の正本を読み直して pending を作り直してください。`);
    }
    const afterText = applyLineHunks(current.text, hunks);
    if (sha256Hex(Buffer.from(afterText, "utf8")) !== queued.afterSha256) {
      throw changeError("patch-mismatch", "差分を当てた結果が、キューに置いた変更後の sha256 と違います");
    }
    assertEvidence(entries, queued.note, afterText, resolved.rel);
    const row = {
      version: CHANGE_RECORD_VERSION,
      recordType: CHANGE_APPLIED,
      id: change.changeId,
      changeId: change.changeId,
      target: queued.target,
      targetPath: queued.targetPath,
      ...(queued.targetSource ? { targetSource: queued.targetSource } : {}),
      beforeSha256: queued.baseSha256,
      afterSha256: queued.afterSha256,
      targetSha256: queued.afterSha256,
      proposalIds: queued.proposalIds,
      note: queued.note,
      reviewer: attestation.reviewer,
      attestedBy: attestation.attestedBy,
      evidenceVersion: 2,
      evals: evalGateRecord(gate, Boolean(requireEvals)),
      hunks,
      appliedAt: String(context.now()),
    };
    writeCanonicalAtomic(current.real, afterText);
    try {
      if (readCanonicalBytes(resolved.full).sha256 !== queued.afterSha256) throw changeError("patch-mismatch", "書いた正本の sha256 が変更後の値と違う");
      appendLearningJsonl(appliedPath, row);
    } catch (error) {
      // 記録を残せないなら、正本を変更前へ戻す（記録の無い書き換えを残さない）。
      writeCanonicalAtomic(current.real, current.text);
      throw error;
    }
    return row;
  });
  return { record, gate, targetRel: resolved.rel, canonicalSkill: CANONICAL_SKILL_PATH.test(posixRel(resolved.rel)) };
}

/** キューから外す（記録は消さない）。正本は書き換えないので、機械の自己申告でも記録として残す。 */
export function rejectLearningChange({
  changeId,
  reviewer,
  reason = "",
  humanVerified = false,
  agentAttested = false,
  isInteractive = false,
  ...options
} = {}) {
  const context = learningChangeContext(options);
  assertLearningWriteAllowed(context.env, "reject");
  const attestation = requireAttestation({ reviewer, humanVerified, agentAttested, isInteractive }, { humanOnly: false });
  const text = String(reason || "").trim();
  if (Array.from(text).length < 5) throw new Error("--reason に却下の理由を書いてください（何を見て外したか）");
  const reasonFindings = inspectLearningText(text, { homeRoot: context.homeDir });
  if (reasonFindings.length > 0) throw new Error(`--reason が書き込み前の検査に当たりました: ${describeLearningBlockReasons(reasonFindings)}`);
  const change = findChange(context, changeId);
  if (change.status !== "pending") throw changeError("change-not-pending", `${change.changeId} は ${change.status} です（却下できるのは pending だけ）`);
  const row = {
    version: CHANGE_RECORD_VERSION,
    recordType: CHANGE_REJECTED,
    id: change.changeId,
    changeId: change.changeId,
    target: change.queued.target,
    reviewer: attestation.reviewer,
    attestedBy: attestation.attestedBy,
    ...(attestation.claimedReviewer ? { claimedReviewer: attestation.claimedReviewer } : {}),
    reason: text,
    rejectedAt: String(context.now()),
  };
  // approve と同じ錠の中で状態を見直してから書く（承認と却下が同時に走っても片方だけが効く）。
  withLearningFileLock(context.ledgerPath(change.queued.target, "applied"), () => {
    if (changesState(context).get(change.changeId)?.status !== "pending") {
      throw changeError("change-not-pending", `${change.changeId} は別の操作で処理済みです`);
    }
    appendLearningJsonl(context.ledgerPath(change.queued.target, "changes"), row);
  });
  return { record: row };
}

/**
 * 適用した変更を巻き戻す。対象の今の sha256 が「変更後」と一致するときだけ変更前へ戻す
 * （一致しなければ rollback-conflict）。巻き戻したことも applied 台帳へ残す。
 */
export function rollbackLearningChange({
  changeId,
  reviewer,
  reason = "",
  humanVerified = false,
  agentAttested = false,
  isInteractive = false,
  ...options
} = {}) {
  const context = learningChangeContext(options);
  assertLearningWriteAllowed(context.env, "rollback");
  const attestation = requireAttestation({ reviewer, humanVerified, agentAttested, isInteractive }, { humanOnly: true });
  const text = String(reason || "").trim();
  if (Array.from(text).length < 5) throw new Error("--reason に巻き戻す理由を書いてください（何を見て戻すと決めたか）");
  const reasonFindings = inspectLearningText(text, { homeRoot: context.homeDir });
  if (reasonFindings.length > 0) throw new Error(`--reason が書き込み前の検査に当たりました: ${describeLearningBlockReasons(reasonFindings)}`);
  const change = findChange(context, changeId);
  if (change.status === "rolled-back") throw changeError("change-not-applied", `${change.changeId} は既に巻き戻しています`);
  if (change.status !== "approved" || !change.applied) throw changeError("change-not-applied", `${change.changeId} は ${change.status} です（巻き戻せるのは approve した変更だけ）`);
  const applied = change.applied;
  const hunks = validateHunks(applied.hunks);
  const resolved = resolveWritable(context, applied.target);
  if (!samePathText(resolved.rel, applied.targetPath) || (applied.targetSource && resolved.source !== applied.targetSource)) {
    throw changeError("target-moved", `正本の置き場が適用したときと違います（${posixRel(applied.targetPath)} → ${posixRel(resolved.rel)}）`);
  }
  const appliedPath = context.ledgerPath(applied.target, "applied");
  const record = withLearningFileLock(appliedPath, () => {
    if (changesState(context).get(change.changeId)?.status !== "approved") {
      throw changeError("change-not-applied", `${change.changeId} は別の操作で処理済みです`);
    }
    const current = readCanonicalBytes(resolved.full);
    if (current.sha256 !== applied.afterSha256) {
      throw changeError("rollback-conflict", `正本（${posixRel(applied.targetPath)}）が、この変更を当てたあとに変わっています（変更後 ${applied.afterSha256.slice(0, 12)} → 今 ${current.sha256.slice(0, 12)}）。後の変更を先に巻き戻すか、人が直接直してください。`);
    }
    const beforeText = applyLineHunks(current.text, hunks, { reverse: true });
    if (sha256Hex(Buffer.from(beforeText, "utf8")) !== applied.beforeSha256) {
      throw changeError("patch-mismatch", "差分を逆に当てた結果が、変更前の sha256 と違います");
    }
    const row = {
      version: CHANGE_RECORD_VERSION,
      recordType: CHANGE_ROLLED_BACK,
      id: change.changeId,
      changeId: change.changeId,
      target: applied.target,
      targetPath: applied.targetPath,
      ...(applied.targetSource ? { targetSource: applied.targetSource } : {}),
      fromSha256: applied.afterSha256,
      toSha256: applied.beforeSha256,
      proposalIds: applied.proposalIds,
      reviewer: attestation.reviewer,
      attestedBy: attestation.attestedBy,
      reason: text,
      rolledBackAt: String(context.now()),
    };
    writeCanonicalAtomic(current.real, beforeText);
    try {
      if (readCanonicalBytes(resolved.full).sha256 !== applied.beforeSha256) throw changeError("patch-mismatch", "書いた正本の sha256 が変更前の値と違う");
      appendLearningJsonl(appliedPath, row);
    } catch (error) {
      writeCanonicalAtomic(current.real, current.text);
      throw error;
    }
    return row;
  });
  return { record, targetRel: resolved.rel, canonicalSkill: CANONICAL_SKILL_PATH.test(posixRel(resolved.rel)) };
}
