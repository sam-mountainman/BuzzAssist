// 自己改善（harness-learn）の可変状態を、どこに置くかを1か所で決める。
//
// 以前は台帳・overlay・Receipt の置き場を、スクリプト自身の置き場（REPO_ROOT）から
// 決めていた。開発用のチェックアウトではそれで正しい（台帳は git で追跡され、commit を
// 人が読む）。だが運営者の端末では、フックが案内するスクリプトはホストごとの版別キャッシュ
// （Claude Code: ~/.claude/plugins/cache/...<版>、Codex: ~/.codex/plugins/cache/...<版>）に
// あり、MCP は ~/plugins/buzzassist/plugin から動く。**同じ人の指摘が、ホストごとに別の
// 台帳へ入り、版が上がるとキャッシュごと消え、setup と自動更新のたびに配布元も丸ごと
// 置き換わっていた。** 学習が溜まらない。
//
// ここで決めること:
//
//   - 開発用チェックアウト（.git と .claude/skills と .codex/skills がある。
//     lib/hostSkillSync.mjs の readsCanonicalDirectly と同じ定義）: 従来どおり
//     リポジトリの docs/learning
//   - それ以外（配布された写し）: ~/.buzzassist/learning/（BUZZASSIST_LEARNING_DIR で上書き可）
//
// 移すのは可変のものだけ（提案台帳・公開 catalog・applied・archived・Receipt の索引・
// フックの記録・sync の状態・この端末の overlay）。リリースと一緒に配る設定
// （docs/learning/targets.json など）は写しの側から読む。

import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { readsCanonicalDirectly, resolveHostPluginInstalls } from "./hostSkillSync.mjs";

export const LEARNING_DIR_ENV = "BUZZASSIST_LEARNING_DIR";
export const LEARNING_STATE_LAYOUT_VERSION = "buzzassist-learning-state-v1";
export const LEARNING_MIGRATION_VERSION = "buzzassist-learning-migration-v1";
export const LEARNING_SYNC_STATE_VERSION = "buzzassist-learning-sync-state-v1";
export const RECEIPT_INDEX_VERSION = "buzzassist-receipt-index-v1";
export const LEARNING_LEDGER_KINDS = Object.freeze(["proposals", "applied", "archived"]);

/** ホストが読むスキルの写しの中で、SKILL.md が「作業前に読む」と書いている overlay の位置。 */
export const OVERLAY_RELATIVE_PARTS = Object.freeze(["references", "learned-auto.md"]);
export const OVERLAY_STATE_FILE = "learned-auto.md";
export const ARCHIVE_STATE_FILE = "learned-archive.md";

// 運営者の端末の overlay は「配布物に同梱された項目」＋「この端末で積み上がった項目」。
// 後者はこの印で囲み、配り直すたびに丸ごと差し替える（同梱部分には触らない）。
// overlay に載る本文は sanitizeForOverlay が <!-- と --> を消すので、本文から印は偽装できない。
export const LOCAL_OVERLAY_BEGIN = "<!-- buzzassist-learning-local:begin";
export const LOCAL_OVERLAY_END = "<!-- buzzassist-learning-local:end -->";

const PACK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SEMVER_DIR = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/u;
const SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;

/** 運営者の端末の状態の置き場。Windows でも homedir（USERPROFILE）から組み立てる。 */
export function operatorLearningStateDir({ env = process.env, homeDir = homedir(), pathApi = path } = {}) {
  const configured = String(env?.[LEARNING_DIR_ENV] ?? "").trim();
  if (configured) return pathApi.resolve(configured);
  return pathApi.join(homeDir, ".buzzassist", "learning");
}

/**
 * 学習の可変状態の置き場を解決する。
 *
 * @param codeRoot  実行中のスクリプトがある写し（リポジトリか、プラグインの写し）
 * @param developmentCheckout 既定は readsCanonicalDirectly(codeRoot)
 */
export function resolveLearningState({
  codeRoot,
  env = process.env,
  homeDir = homedir(),
  pathApi = path,
  developmentCheckout = undefined,
} = {}) {
  if (!codeRoot) throw new Error("resolveLearningState には codeRoot が要る。");
  const root = pathApi.resolve(codeRoot);
  const development = developmentCheckout ?? readsCanonicalDirectly(root);
  const operatorDir = operatorLearningStateDir({ env, homeDir, pathApi });
  const targetsPath = pathApi.join(root, "docs", "learning", "targets.json");
  if (development) {
    const stateDir = pathApi.join(root, "docs", "learning");
    const receiptsDir = pathApi.join(stateDir, "receipts");
    return {
      version: LEARNING_STATE_LAYOUT_VERSION,
      mode: "development",
      codeRoot: root,
      stateDir,
      sharedLedgerDir: stateDir,
      channelLedgerRoot: pathApi.join(root, "channel-packs"),
      receiptsDir,
      receiptIndexPath: pathApi.join(receiptsDir, "index.jsonl"),
      // 開発用チェックアウトの overlay はリポジトリの .agents/skills/*/references/ が正本。
      overlaysDir: null,
      // フックの記録は従来どおりリポジトリの外（数えるだけの記録を台帳と混ぜない）。
      hookEventLogPath: pathApi.join(operatorDir, "hook-events.jsonl"),
      // 会話ごとの発言回数（振り返りの促し）と自動 sync の記録も、数えるだけの記録なのでリポジトリの外。
      reflectionDir: pathApi.join(operatorDir, "reflection"),
      autoSyncLogPath: pathApi.join(operatorDir, "auto-sync.jsonl"),
      syncStatePath: null,
      migrationRecordPath: null,
      targetsPath,
    };
  }
  const stateDir = operatorDir;
  const receiptsDir = pathApi.join(stateDir, "receipts");
  return {
    version: LEARNING_STATE_LAYOUT_VERSION,
    mode: "installed",
    codeRoot: root,
    stateDir,
    // 共有層の台帳は shared/ に置く。チャンネルの台帳（channel-packs/<id>/）が共有台帳の
    // 置き場の「中」に入らないようにするため（捕捉時の分離検査と同じ規則）。
    sharedLedgerDir: pathApi.join(stateDir, "shared"),
    channelLedgerRoot: pathApi.join(stateDir, "channel-packs"),
    receiptsDir,
    receiptIndexPath: pathApi.join(receiptsDir, "index.jsonl"),
    overlaysDir: pathApi.join(stateDir, "overlays"),
    hookEventLogPath: pathApi.join(stateDir, "hook-events.jsonl"),
    reflectionDir: pathApi.join(stateDir, "reflection"),
    autoSyncLogPath: pathApi.join(stateDir, "auto-sync.jsonl"),
    syncStatePath: pathApi.join(stateDir, "sync-state.json"),
    migrationRecordPath: pathApi.join(stateDir, "migration.json"),
    targetsPath,
  };
}

/** 共有層の台帳（proposals / applied / archived / proposals.public）。 */
export function sharedLedgerPath(state, kind = "proposals", pathApi = path) {
  return pathApi.join(state.sharedLedgerDir, `${kind}.jsonl`);
}

/**
 * 保存先の宣言が無いチャンネルの台帳の置き場。
 * 開発用: <repo>/channel-packs/<id>/docs/learning（従来どおり）。運営者: <state>/channel-packs/<id>。
 */
export function channelLedgerDir(state, packId, pathApi = path) {
  const id = String(packId || "");
  if (!PACK_ID.test(id)) throw new Error(`Channel Pack の id が置き場の名前として使えない: ${JSON.stringify(id).slice(0, 80)}`);
  return state.mode === "development"
    ? pathApi.join(state.channelLedgerRoot, id, "docs", "learning")
    : pathApi.join(state.channelLedgerRoot, id);
}

// ---- 追記と排他 ---------------------------------------------------------------

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

/**
 * 台帳ファイル単位の排他。harness-learn の capture・移行・Receipt の索引が同じ規則で取る。
 * lock の名前は以前の capture と同じ（`<file>.capture.lock`）。
 */
export function withLearningFileLock(filePath, action, { timeoutMs = 10_000, staleMs = 120_000 } = {}) {
  const lockPath = `${filePath}.capture.lock`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const startedAt = Date.now();
  let handle = null;
  while (handle === null) {
    try {
      handle = fs.openSync(lockPath, "wx");
      fs.writeSync(handle, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(lockPath, "utf8")); } catch { /* stale判定へ */ }
      const age = Date.now() - (fs.statSync(lockPath, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if ((owner && !processIsAlive(Number(owner.pid))) || (!owner && age > staleMs)) {
        try { fs.rmSync(lockPath, { force: true }); } catch { /* 次のloopで再確認 */ }
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) throw new Error("proposal台帳のcapture lockを取得できない。");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return action();
  } finally {
    try { fs.closeSync(handle); } catch { /* cleanupを続ける */ }
    try { fs.rmSync(lockPath, { force: true }); } catch { /* stale recoveryが扱う */ }
  }
}

/** 行を1回の write で追記する（JSON.stringify は改行を含まないので他プロセスと混ざらない）。 */
export function appendJsonlRows(filePath, rows) {
  if (!rows.length) return 0;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
  const fd = fs.openSync(filePath, "a");
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return rows.length;
}

/** 壊れた行で止まらずに読む（古い写しからの取り込み用）。壊れた行の数は返す。 */
function readJsonlTolerant(filePath) {
  if (!fs.existsSync(filePath)) return { rows: [], broken: 0 };
  let broken = 0;
  const rows = [];
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) rows.push(parsed);
      else broken += 1;
    } catch {
      broken += 1;
    }
  }
  return { rows, broken };
}

function writeFileAtomic(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.partial`;
  fs.writeFileSync(temporary, text, "utf8");
  fs.renameSync(temporary, filePath);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function realOrResolved(value) {
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

// ---- 古い写しからの取り込み ------------------------------------------------------

/**
 * 以前の版が台帳を書いていた写し。どれも setup・自動更新・ホストの更新で消えうる場所。
 * 取り込みは読むだけで、元のファイルは消さない。
 */
export function legacyLearningSources({ homeDir = homedir(), codeRoot = null, stateDir = null } = {}) {
  const roots = [];
  const push = (root, label) => {
    if (root && fs.existsSync(root)) roots.push({ root: path.resolve(root), label });
  };
  push(path.join(homeDir, "plugins", "buzzassist", "plugin"), "managed-plugin");
  for (const [host, base] of [
    ["claude", path.join(homeDir, ".claude", "plugins", "cache", "buzzassist", "buzzassist")],
    ["codex", path.join(homeDir, ".codex", "plugins", "cache", "buzzassist", "buzzassist")],
  ]) {
    for (const version of listDirs(base).filter((name) => SEMVER_DIR.test(name))) push(path.join(base, version), `${host}-cache-${version}`);
  }
  // 自動更新が置き換える前に取った控え（~/.buzzassist/backups/<名前>/plugin）。
  const backups = path.join(homeDir, ".buzzassist", "backups");
  for (const name of listDirs(backups)) push(path.join(backups, name, "plugin"), `updater-backup-${name}`);
  if (codeRoot) push(codeRoot, "running-copy");
  const seen = new Set(stateDir ? [realOrResolved(stateDir)] : []);
  return roots.filter((entry) => {
    const key = realOrResolved(entry.root);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 台帳の行が同じ記録か。提案は (id, session)、反映・退避は (id, 記録時刻)。 */
export function learningRowKey(kind, row) {
  const id = typeof row?.id === "string" && row.id ? row.id : `sha:${sha256(JSON.stringify(row))}`;
  if (kind === "proposals") return `${id}\u001f${row?.session ?? row?.capturedAt ?? ""}`;
  // 差分の承認キューの行（適用した変更・巻き戻し）は同じ変更 ID を持つので、行の種類でも見分ける。
  // 巻き戻しの行は appliedAt を持たないので、巻き戻した時刻を使う。種類の無い従来の行の鍵は変えない。
  if (kind === "applied") {
    const recordType = typeof row?.recordType === "string" && row.recordType ? `\u001f${row.recordType}` : "";
    return `${id}\u001f${row?.appliedAt ?? row?.promotedAt ?? row?.rolledBackAt ?? ""}\u001f${row?.attestedBy ?? ""}${recordType}`;
  }
  return `${id}\u001f${row?.archivedAt ?? ""}`;
}

function stateLedgerFiles(state) {
  const files = LEARNING_LEDGER_KINDS.map((kind) => ({ kind, file: sharedLedgerPath(state, kind) }));
  for (const packId of listDirs(state.channelLedgerRoot).filter((name) => PACK_ID.test(name))) {
    for (const kind of LEARNING_LEDGER_KINDS) files.push({ kind, file: path.join(channelLedgerDir(state, packId), `${kind}.jsonl`) });
  }
  return files;
}

function stateHasLedgerRows(state) {
  return stateLedgerFiles(state).some(({ file }) => readJsonlTolerant(file).rows.length > 0);
}

function readMigrationRecord(state) {
  if (!state.migrationRecordPath || !fs.existsSync(state.migrationRecordPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(state.migrationRecordPath, "utf8"));
  } catch {
    return { version: "unreadable" };
  }
}

/**
 * 状態の置き場が空で、古い写しに台帳が残っていれば取り込む（ID で重複を除く・元は消さない）。
 *
 * 1回だけ走る（migration.json を残す）。状態の置き場に既に台帳があって印が無い場合は、
 * 取り込まずに印だけ残す——運営者が BUZZASSIST_LEARNING_DIR で既存の置き場を指したとき、
 * 古い写しの行を後から混ぜると、どちらが新しいのか読めなくなる。
 */
export function migrateLegacyLearningState({
  state,
  homeDir = homedir(),
  sources = undefined,
  now = () => new Date().toISOString(),
  dryRun = false,
} = {}) {
  const empty = { imported: 0, byKind: { proposals: 0, applied: 0, archived: 0, receipts: 0 }, sources: [] };
  if (!state || state.mode !== "installed") return { ...empty, skippedReason: "development-checkout" };
  const existing = readMigrationRecord(state);
  if (existing) return { ...empty, skippedReason: "already-migrated", record: existing };
  const candidates = sources ?? legacyLearningSources({ homeDir, codeRoot: state.codeRoot, stateDir: state.stateDir });
  if (stateHasLedgerRows(state)) {
    const record = { version: LEARNING_MIGRATION_VERSION, at: now(), skippedReason: "state-not-empty", ...empty };
    if (!dryRun) writeFileAtomic(state.migrationRecordPath, `${JSON.stringify(record, null, 2)}\n`);
    return { ...empty, skippedReason: "state-not-empty" };
  }

  // 宛先ファイル → 取り込む行（重複を除いたもの）
  const planned = new Map();
  const byKind = { proposals: 0, applied: 0, archived: 0, receipts: 0 };
  const sourceReports = [];
  let brokenLines = 0;
  const plan = (kind, from, to, sourceCounts) => {
    const { rows, broken } = readJsonlTolerant(from);
    brokenLines += broken;
    if (rows.length === 0) return;
    if (!planned.has(to)) planned.set(to, { kind, keys: new Set(readJsonlTolerant(to).rows.map((row) => learningRowKey(kind, row))), rows: [] });
    const bucket = planned.get(to);
    for (const row of rows) {
      const key = learningRowKey(kind, row);
      if (bucket.keys.has(key)) continue;
      bucket.keys.add(key);
      bucket.rows.push(row);
      byKind[kind] += 1;
      sourceCounts[kind] = (sourceCounts[kind] || 0) + 1;
    }
  };
  const receiptCopies = [];
  for (const source of candidates) {
    const counts = {};
    const learning = path.join(source.root, "docs", "learning");
    for (const kind of LEARNING_LEDGER_KINDS) plan(kind, path.join(learning, `${kind}.jsonl`), sharedLedgerPath(state, kind), counts);
    const packs = path.join(source.root, "channel-packs");
    for (const packId of listDirs(packs).filter((name) => PACK_ID.test(name))) {
      for (const kind of LEARNING_LEDGER_KINDS) {
        plan(kind, path.join(packs, packId, "docs", "learning", `${kind}.jsonl`), path.join(channelLedgerDir(state, packId), `${kind}.jsonl`), counts);
      }
    }
    const receipts = path.join(learning, "receipts");
    let names = [];
    try { names = fs.readdirSync(receipts).filter((name) => name.endsWith(".json")).sort(); } catch { names = []; }
    for (const name of names) {
      const destination = path.join(state.receiptsDir, name);
      if (fs.existsSync(destination) || receiptCopies.some((entry) => entry.destination === destination)) continue;
      receiptCopies.push({ from: path.join(receipts, name), destination });
      byKind.receipts += 1;
      counts.receipts = (counts.receipts || 0) + 1;
    }
    if (Object.keys(counts).length > 0) sourceReports.push({ label: source.label, root: portableLabel(source.root, homeDir), counts });
  }
  const imported = byKind.proposals + byKind.applied + byKind.archived + byKind.receipts;
  if (!dryRun) {
    for (const [file, bucket] of planned) {
      if (bucket.rows.length === 0) continue;
      withLearningFileLock(file, () => appendJsonlRows(file, bucket.rows));
    }
    for (const { from, destination } of receiptCopies) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(from, destination, fs.constants.COPYFILE_EXCL);
    }
    const record = {
      version: LEARNING_MIGRATION_VERSION,
      at: now(),
      imported,
      byKind,
      brokenLines,
      sources: sourceReports,
      note: "古い写しの台帳は消していない。取り込みは1回だけで、以後は状態の置き場だけに書く。",
    };
    writeFileAtomic(state.migrationRecordPath, `${JSON.stringify(record, null, 2)}\n`);
  }
  return { imported, byKind, brokenLines, sources: sourceReports, dryRun };
}

/** 記録に端末の絶対パスをなるべく残さない（home からの相対にする）。 */
function portableLabel(root, homeDir) {
  const rel = path.relative(homeDir, root);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? ["~", ...rel.split(path.sep)].join("/") : "(home の外)";
}

// ---- overlay をホストが読む写しへ届ける -------------------------------------------------

/**
 * ホストが実際にスキルを読む写し。Claude Code は installed_plugins.json の installPath、
 * Codex は使用中（一番新しい）版、それに配布元（~/plugins/buzzassist/plugin）。
 * 運営者の端末で動いている写し（まだ古い版を読んでいるセッションのもの）も含められる。
 */
export function learningOverlayCopies({ homeDir = homedir(), extraRoots = [] } = {}) {
  const copies = resolveHostPluginInstalls({ homeDir }).map((install) => ({
    root: install.root,
    label: `${install.host} ${install.version || "版不明"}`,
  }));
  copies.push({ root: path.join(homeDir, "plugins", "buzzassist", "plugin"), label: "managed-plugin" });
  for (const root of extraRoots) if (root) copies.push({ root: path.resolve(root), label: "running-copy" });
  const seen = new Set();
  return copies.filter((copy) => {
    if (!fs.existsSync(copy.root)) return false;
    const key = realOrResolved(copy.root);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 印で囲んだ区画を取り除く。区画の前の空行も戻す（届ける前の同梱の形に戻る）。 */
export function stripLocalOverlayBlock(text) {
  const source = String(text ?? "");
  const begin = source.indexOf(LOCAL_OVERLAY_BEGIN);
  if (begin < 0) return source;
  const endAt = source.indexOf(LOCAL_OVERLAY_END, begin);
  const tail = endAt < 0 ? "" : source.slice(endAt + LOCAL_OVERLAY_END.length).replace(/^\r?\n/u, "");
  const head = source.slice(0, begin).replace(/\s+$/u, "");
  const rest = `${head}${head && tail ? "\n\n" : ""}${tail.replace(/^\s+/u, "")}`;
  return rest ? `${rest.replace(/\s+$/u, "")}\n` : "";
}

/** 同梱の overlay に、この端末の区画を足した形。区画が空なら同梱の形そのもの。 */
export function composeOverlay(base, block) {
  const stripped = stripLocalOverlayBlock(base);
  const local = String(block ?? "").trim();
  if (!local) return stripped;
  const head = stripped.replace(/\s+$/u, "");
  return `${head ? `${head}\n\n` : ""}${local}\n`;
}

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

/** 状態の置き場にある、この端末の overlay 区画（skill id → 区画の本文）。 */
export function readStateOverlayBlocks(overlaysDir) {
  const blocks = new Map();
  if (!overlaysDir) return blocks;
  for (const skill of listDirs(overlaysDir).filter((name) => SKILL_ID.test(name))) {
    const text = readText(path.join(overlaysDir, skill, OVERLAY_STATE_FILE));
    if (text && text.includes(LOCAL_OVERLAY_BEGIN)) blocks.set(skill, text);
  }
  return blocks;
}

/**
 * 状態の置き場の overlay 区画を、各写しの `skills/<id>/references/learned-auto.md`
 * （ホストが読む配布形）と `.agents/skills/<id>/references/learned-auto.md`（写しの中の正本形。
 * doctor の比較と RunReceipt の overlay 指紋はこちらを読む）へ書き出す。
 *
 * 区画が無いスキルは、以前に届けた区画だけを取り除く（同梱部分は変えない）。
 * SKILL.md の無いスキルの置き場には書かない（読む指示が無いところへ置いても効かない）。
 */
export function deliverLearningOverlays({ overlaysDir, copies = [], dryRun = false } = {}) {
  const blocks = readStateOverlayBlocks(overlaysDir);
  const written = [];
  let examined = 0;
  for (const copy of copies) {
    for (const base of [path.join(copy.root, "skills"), path.join(copy.root, ".agents", "skills")]) {
      for (const skill of listDirs(base).filter((name) => SKILL_ID.test(name))) {
        const skillDir = path.join(base, skill);
        if (!fs.existsSync(path.join(skillDir, "SKILL.md"))) continue;
        const target = path.join(skillDir, ...OVERLAY_RELATIVE_PARTS);
        const current = readText(target);
        const block = blocks.get(skill) || "";
        if (current === null && !block) continue;
        examined += 1;
        const next = composeOverlay(current ?? "", block);
        if (next === current) continue;
        if (!dryRun) writeFileAtomic(target, next);
        written.push({ copy: copy.label, skill, file: target });
      }
    }
  }
  return {
    copies: copies.map((copy) => copy.label),
    skillsWithLocalBlock: [...blocks.keys()].sort(),
    examined,
    written,
    dryRun,
  };
}

/** sync の状態（最後に何を書き、どこへ届けたか）。運営者の端末でだけ残す。 */
export function writeLearningSyncState(state, record) {
  if (!state?.syncStatePath) return null;
  const payload = { version: LEARNING_SYNC_STATE_VERSION, ...record };
  writeFileAtomic(state.syncStatePath, `${JSON.stringify(payload, null, 2)}\n`);
  return state.syncStatePath;
}

// overlay と退避ファイルの最終更新の行。sync は毎回いまの時刻を書くので、項目が変わっていないのに
// この行だけ違う書き直しは差分にしない（自動 sync が Job のたびに正本の隣のファイルを揺らさないように）。
const OVERLAY_TIMESTAMP_LINE = /^_(?:最終更新|この端末での最終更新): [^_\n]*_$/gmu;

/** 最終更新の行だけが違うなら同じとみなす。片方が無ければ厳密に比べる。 */
export function sameIgnoringOverlayTimestamp(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return left === right;
  return String(left).replace(OVERLAY_TIMESTAMP_LINE, "") === String(right).replace(OVERLAY_TIMESTAMP_LINE, "");
}

/** 状態の置き場へ、この端末の overlay 区画を書く（空なら消す。機械が丸ごと所有する派生物）。 */
export function writeStateOverlayFile(overlaysDir, skill, fileName, text) {
  if (!SKILL_ID.test(String(skill || ""))) throw new Error(`skill id が不正: ${String(skill).slice(0, 80)}`);
  const file = path.join(overlaysDir, skill, fileName);
  const current = readText(file);
  if (!text) {
    if (current === null) return false;
    fs.rmSync(file, { force: true });
    return true;
  }
  if (sameIgnoringOverlayTimestamp(current, text)) return false;
  writeFileAtomic(file, text);
  return true;
}

// ---- RunReceipt の索引 ------------------------------------------------------------

/**
 * Job の決着を索引へ1行残す。rollup はこの索引から RunReceipt を読む
 * （Job は <project>/canvas/harness-runs/<job>/ に RunReceipt を書くので、以前の
 * docs/learning/receipts だけを読む rollup は常に0件だった）。
 * 同じ Job の同じ Receipt（または同じ決着状態）は二重に積まない。
 */
export function appendReceiptIndexRow(indexPath, row) {
  if (!indexPath) return { appended: false, reason: "no-index-path" };
  const entry = { version: RECEIPT_INDEX_VERSION, ...row };
  const key = `${entry.jobId}\u001f${entry.receiptSha256 || entry.stateDigest || ""}`;
  return withLearningFileLock(indexPath, () => {
    const duplicate = readJsonlTolerant(indexPath).rows
      .some((existing) => `${existing.jobId}\u001f${existing.receiptSha256 || existing.stateDigest || ""}` === key);
    if (duplicate) return { appended: false, reason: "duplicate", indexPath };
    appendJsonlRows(indexPath, [entry]);
    return { appended: true, indexPath };
  });
}

export function readReceiptIndex(indexPath) {
  return readJsonlTolerant(indexPath);
}
