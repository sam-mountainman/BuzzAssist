/**
 * 戦略の道具の作業フォルダから、戦略ブリーフの下書きを組み立てる（照合と下書きだけ。モデルを呼ばない）。
 *
 *   node scripts/strategy-brief.mjs draft --from-hyp <戦略の道具の作業フォルダ> --channel <id>
 *        [--previous <前のブリーフ>] [--strategy-skill-dir <戦略の道具の採用版の置き場>] [--work-dir <dir>] [--out <file>]
 *
 * 人が毎回ブリーフを手で書く前提にしないための口。機械で集められるもの（ファイルの SHA・形・4分析の run が現行か・
 * 根拠の表の行）はここで集め、機械で埋められないもの（動画の問い・見る人・入口の約束など、企画の判断そのもの）は
 * needsAuthoring として返す。そこは上位の AI が戦略の道具の文書を読んで埋める（どの欄を、どの成果物から埋めるかを
 * 出力に書く）。戦略の道具のスクリプトは実行せず、文書の中身も読まない（読むのは種類と SHA と、機械が読める
 * 受け渡しファイル・根拠の表・分析の出力の JSON だけ）。
 *
 * 集めるもの（どれも根拠の行。状態は provisional。verified には自動でしない）:
 *   - 視聴者の4分析の run（run.json のあるフォルダ）。report-manifest.json が現行のものだけ。stale などは理由つきで外す
 *   - 指標の集計（schema "1.1"）・関連元の集計（schema "1.0"）・取得スナップショット（schema_version 1）の JSON
 *   - 作業フォルダの作業文書（brief.md・diagnosis.md・content-plan.md・experiments.md・data-dictionary.md）の種類と SHA
 *   - 根拠の表 evidence.csv の行（観測の列は observations[] にも入れる）
 *   - 受け渡しファイル strategy-handoff.json（あれば優先して取り込む。形は docs/strategy-handoff-spec-ja.md）
 * 引き継ぐもの（--previous）: 問い・見る人・入口の約束・回収・制作条件・公開後の指標・仮説・未確認事項と根拠の行
 * （前のブリーフの前提を collected.premise に書く。前提を変えたら、その行は当てはまりの確認待ちになる）。
 * 根拠の表の行は evidence_id で前の版の行と1つにする（前の版の id のまま今の表で置き換える。carryPreviousCsvRow）
 *
 * 守ること:
 *   - 根拠のパスは作業フォルダからの相対（/ 区切り）。作業フォルダの外・シンボリックリンクは使わない
 *   - 埋められない欄は null や空のまま（形の検査を通らない）。推測や仮の文言で埋めない
 *   - 下書きの作った文脈は空欄（仕上げる会話の ID をホストが書く）
 */

import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  STRATEGY_BRIEF_VERSION,
  inspectAudienceRun,
  normalizeEvidenceRelPath,
  sha256Hex,
  strategyBriefPremiseDigests,
  strategySkillFingerprint,
  validateStrategyBrief,
  workDirRelative,
} from "./strategyBrief.mjs";
import { DRAFT_CONTEXT_PLACEHOLDER, nextBriefLabel } from "./strategyBriefNext.mjs";

export const STRATEGY_BRIEF_DRAFT_VERSION = "buzzassist-strategy-brief-draft-v1";
/** 戦略の道具が書く、機械が読める受け渡しファイル（任意）。 */
export const STRATEGY_TOOL_HANDOFF_FILE = "strategy-handoff.json";
export const STRATEGY_TOOL_HANDOFF_VERSION = "buzzassist-strategy-tool-handoff-v1";
export const STRATEGY_TOOL_EVIDENCE_CSV = "evidence.csv";

/**
 * 作業フォルダの作業文書（戦略の道具の作業フォルダの初期化が作る名前）。role は BuzzAssist の側の呼び名で、
 * 文書の中身は読まない。data-dictionary はデータの定義で、企画の前提に依らない。
 */
export const STRATEGY_TOOL_DOCUMENTS = Object.freeze({
  "brief.md": Object.freeze({ role: "decision-premise", label: "今回の判断の前提" }),
  "diagnosis.md": Object.freeze({ role: "diagnosis", label: "観測からの判断の整理" }),
  "content-plan.md": Object.freeze({ role: "content-plan", label: "企画と入口の約束" }),
  "experiments.md": Object.freeze({ role: "experiments", label: "次の検証" }),
  "data-dictionary.md": Object.freeze({ role: "data-dictionary", label: "データの定義", premiseIndependenceReason: "データの定義で、企画の前提に依らない" }),
});

/** 根拠の表（evidence.csv）の列。evidence_id だけ必須。 */
export const STRATEGY_TOOL_EVIDENCE_COLUMNS = Object.freeze([
  "evidence_id", "observation", "source_type", "source_url_or_file", "accessed_at", "period_and_conditions", "limitations",
]);

const SKIP_DIRS = new Set(["quality", ".git", "node_modules", "__pycache__"]);
const MAX_SCAN_DEPTH = 6;
const MAX_SCAN_ENTRIES = 5_000;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_CSV_BYTES = 5 * 1024 * 1024;
const MAX_CSV_ROWS = 500;
const MAX_EVIDENCE = 100;
const MAX_OBSERVATIONS = 50;
const ITEM_ID = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}/u;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clip(text, max = 300) {
  return Array.from(String(text ?? "")).slice(0, max).join("");
}

function inputError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function slug(value, max = 40) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, max).replace(/-+$/u, "");
}

/** 衝突の添字（-2 など）を付ける前の id。同じ元の値からは毎回同じ id になる。 */
function baseItemId(prefix, source) {
  const body = slug(source) || sha256Hex(Buffer.from(String(source ?? ""), "utf8")).slice(0, 8);
  const base = (body === prefix || body.startsWith(`${prefix}-`) ? body : `${prefix}-${body}`).slice(0, 44).replace(/-+$/u, "");
  return ITEM_ID.test(base) ? base : `${prefix}-${sha256Hex(Buffer.from(String(source ?? ""), "utf8")).slice(0, 8)}`;
}

/** 新しい根拠の id。添字は、本当に別の根拠が同じ id を持っているときだけ付く（同じ根拠は前の版の id を使う）。 */
function makeIdFactory(taken) {
  return (prefix, source) => {
    const base = baseItemId(prefix, source);
    let id = base;
    let index = 2;
    while (taken.has(id)) {
      id = `${base}-${index}`;
      index += 1;
    }
    taken.add(id);
    return id;
  };
}

function parseJson(bytes) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

/** RFC 4180 の CSV（引用符・引用符の中の改行・CRLF・BOM）を行の配列へ。閉じない引用符は例外。 */
export function parseCsv(text) {
  const source = String(text ?? "").replace(/^\uFEFF/u, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === "\"") {
        if (source[index + 1] === "\"") {
          field += "\"";
          index += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === "\"" && field === "") quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (quoted) throw inputError("evidence.csv の引用符が閉じていない。", "strategy-draft-csv-unreadable");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((cell) => cell.trim() !== ""));
}

/** 作業フォルダを読む。4分析の run（run.json のあるフォルダ）の中へは降りない。シンボリックリンクはたどらない。 */
async function scanWorkDir(root) {
  const runs = [];
  const jsonFiles = [];
  let seen = 0;
  const visit = async (dir, depth) => {
    if (depth > MAX_SCAN_DEPTH || seen > MAX_SCAN_ENTRIES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    if (depth > 0 && entries.some((entry) => entry.isFile() && entry.name === "run.json")) {
      runs.push(dir);
      return;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > MAX_SCAN_ENTRIES) return;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await visit(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
        jsonFiles.push(full);
      }
    }
  };
  await visit(root, 0);
  return { runs, jsonFiles, truncated: seen > MAX_SCAN_ENTRIES };
}

function classifyJson(value) {
  if (!plainObject(value)) return null;
  if (value.schema_version === "1.1" && Array.isArray(value.groups)) return "metrics";
  if (value.schema_version === "1.0" && plainObject(value.categories)) return "referrals";
  if (value.schema_version === 1 && nonEmpty(value.video_id) && (plainObject(value.comments) || plainObject(value.transcript))) return "snapshot";
  return null;
}

function dataConditions(kind, value) {
  if (kind === "metrics") {
    return `指標の集計（schema 1.1、区分 ${value.groups.length} 件、行 ${Number(value.row_count) || 0} 件）。取得日と区分の定義は元の書き出しとデータの定義で確かめる`;
  }
  if (kind === "referrals") {
    const context = value.report_context || {};
    return `関連元の集計（schema 1.0）。期間 ${context.period_start || "不明"}〜${context.period_end || "不明"}（${context.timezone || "不明"}）、`
      + `形式 ${context.format || "不明"}、レポート ${context.traffic_source || "不明"}、網羅 ${value.coverage?.completeness || "不明"}`;
  }
  const comments = value.comments || {};
  const transcript = value.transcript || {};
  return `取得スナップショット（動画 ${value.video_id}、コメント ${comments.status || "不明"} ${Array.isArray(comments.records) ? comments.records.length : 0} 件・`
    + `範囲 ${comments.scope?.coverage || "不明"}、字幕 ${transcript.status || "不明"}）`;
}

function isDateLike(value) {
  return DATE_LIKE.test(String(value ?? "")) && Number.isFinite(Date.parse(String(value)));
}

async function safeFileInside(root, rel) {
  const normalized = normalizeEvidenceRelPath(rel);
  if (!normalized.ok) return null;
  const full = path.join(root, ...normalized.segments);
  const inside = workDirRelative(root, full);
  if (!inside) return null;
  try {
    const info = await lstat(full);
    if (info.isSymbolicLink()) return null;
    return { full, rel: inside, isFile: info.isFile(), isDirectory: info.isDirectory() };
  } catch {
    return null;
  }
}

/** 根拠の表の行から作る根拠の行の注記の書き出し。前の版の行を evidence_id で見つけるのにも使う。 */
const CSV_NOTE_HEAD = `${STRATEGY_TOOL_EVIDENCE_CSV} の `;

function csvEvidenceNote(sourceId, sourceType, limitations) {
  return clip(`${CSV_NOTE_HEAD}${sourceId}${sourceType ? `（${sourceType}）` : ""}${limitations ? `。限界: ${limitations}` : ""}`, 300);
}

/**
 * 根拠の表（evidence.csv）を読み、行ごとに根拠の行の材料（指すファイル・SHA・集めた条件・注記・観測）を作る。
 * id はまだ振らない（前の版の行と evidence_id で突き合わせてから決める）。
 */
async function readEvidenceCsv({ root, source, underSource, issues }) {
  const csvFile = await safeFileInside(root, underSource(STRATEGY_TOOL_EVIDENCE_CSV));
  if (!csvFile?.isFile) return { info: { provided: false }, rows: [] };
  const bytes = await readFile(csvFile.full);
  const csvSha256 = sha256Hex(bytes);
  const info = { provided: true, path: csvFile.rel, sha256: csvSha256, rows: 0, used: 0, reused: 0, skipped: [] };
  const rows = [];
  if (bytes.length > MAX_CSV_BYTES) {
    issues.push("strategy-draft-csv-too-large");
    return { info, rows };
  }
  let table = [];
  try {
    table = parseCsv(bytes.toString("utf8"));
  } catch (error) {
    issues.push(error.code || "strategy-draft-csv-unreadable");
  }
  const header = (table[0] || []).map((cell) => cell.trim());
  const column = (name) => header.indexOf(name);
  if (table.length > 0 && column("evidence_id") < 0) {
    issues.push("strategy-draft-csv-evidence-id-column-missing");
    return { info, rows };
  }
  const body = table.slice(1);
  info.rows = body.length;
  if (body.length > MAX_CSV_ROWS) issues.push(`strategy-draft-csv-rows-truncated:${body.length - MAX_CSV_ROWS}`);
  const seen = new Set();
  for (const [index, cells] of body.slice(0, MAX_CSV_ROWS).entries()) {
    const cell = (name) => (column(name) >= 0 ? String(cells[column(name)] ?? "").trim() : "");
    const sourceId = cell("evidence_id");
    if (!sourceId) {
      info.skipped.push({ line: index + 2, reason: "evidence-id-missing" });
      continue;
    }
    // 表の中で evidence_id が重なる行は別々の根拠として残す（id に添字が付く）。一意にするのは表を書く側。
    if (seen.has(sourceId)) issues.push(`strategy-draft-csv-evidence-id-duplicate:${clip(sourceId, 64)}`);
    seen.add(sourceId);
    // 表の行が作業フォルダの中のファイルを指していれば、そのファイルの SHA に結ぶ。無ければ表そのものに結ぶ。
    const pointed = cell("source_url_or_file") && !/^[a-z][a-z0-9+.-]*:\/\//iu.test(cell("source_url_or_file"))
      ? await safeFileInside(source, cell("source_url_or_file"))
      : null;
    const pointedRel = pointed?.isFile ? workDirRelative(root, pointed.full) : null;
    rows.push({
      sourceId,
      baseId: baseItemId("csv", sourceId),
      sourceType: cell("source_type"),
      path: pointedRel || csvFile.rel,
      boundToTable: !pointedRel,
      sha256: pointedRel ? sha256Hex(await readFile(pointed.full)) : csvSha256,
      collected: {
        at: isDateLike(cell("accessed_at")) ? cell("accessed_at") : "unknown",
        conditions: clip(cell("period_and_conditions") || "evidence.csv に条件の記載なし", 500),
      },
      note: csvEvidenceNote(sourceId, cell("source_type"), cell("limitations")),
      statement: cell("observation"),
      id: null,
    });
  }
  return { info, rows };
}

/**
 * 前の版の根拠の行のうち、根拠の表の行（evidence_id）から作られたものを 1 対 1 で見つける。
 *
 * 下書きは表の行の注記を「evidence.csv の <evidence_id>（出典の種類）。限界: …」で書くので、それで見分ける。
 * 強さの順に結ぶ: 3 注記が今の行と同じ / 2 evidence_id と出典の種類が同じ / 1 evidence_id が同じ /
 * 0 注記が書き換えられていて、行の id が表の行から作る id（csv-<evidence_id>）と同じ。同じ強さなら、長い
 * evidence_id（前方が同じ別の id に取られないように）・表の順・添字の無い id・前の版の順を先にする。
 * 結べなかった前の版の行のうち、同じ evidence_id を名乗り、id がその添字の形（csv-<evidence_id>-2 など）の行は、
 * 以前の下書きが同じ根拠を二重にした行として collapsed に返す（結んだ行へまとめる）。
 */
function matchPreviousCsvRows(previousRows, csvRows) {
  const strength = (prev, row) => {
    const note = typeof prev.note === "string" ? prev.note : "";
    if (note === row.note) return 3;
    const head = `${CSV_NOTE_HEAD}${row.sourceId}`;
    if (note.startsWith(head)) {
      const rest = note.slice(head.length);
      if (rest === "" || rest.startsWith("。") || (row.sourceType && rest.startsWith(`（${row.sourceType}）`))) return 2;
      return rest.startsWith("（") ? 1 : -1;
    }
    return !note.startsWith(CSV_NOTE_HEAD) && prev.id === row.baseId ? 0 : -1;
  };
  const pairs = [];
  csvRows.forEach((row, rowIndex) => {
    previousRows.forEach((prev, prevIndex) => {
      const score = strength(prev, row);
      if (score >= 0) pairs.push({ score, rowIndex, prevIndex, idLength: row.sourceId.length, suffixed: prev.id === row.baseId ? 0 : 1 });
    });
  });
  pairs.sort((left, right) => right.score - left.score || right.idLength - left.idLength || left.rowIndex - right.rowIndex
    || left.suffixed - right.suffixed || left.prevIndex - right.prevIndex);
  const rowByPrevious = new Map();
  const matchedRows = new Set();
  for (const pair of pairs) {
    if (matchedRows.has(pair.rowIndex) || rowByPrevious.has(pair.prevIndex)) continue;
    rowByPrevious.set(pair.prevIndex, pair.rowIndex);
    matchedRows.add(pair.rowIndex);
  }
  const collapsed = new Map();
  for (const pair of pairs) {
    if (pair.score < 1 || rowByPrevious.has(pair.prevIndex) || collapsed.has(pair.prevIndex) || !matchedRows.has(pair.rowIndex)) continue;
    const { baseId } = csvRows[pair.rowIndex];
    const id = String(previousRows[pair.prevIndex].id ?? "");
    if (id.startsWith(`${baseId}-`) && /^\d+$/u.test(id.slice(baseId.length + 1))) collapsed.set(pair.prevIndex, pair.rowIndex);
  }
  return { rowByPrevious, collapsed };
}

/**
 * 前の版の行を、根拠の表の同じ evidence_id の今の行で置き換える。id・種類・状態・確かめ方・前提に依らない宣言は
 * 前の版のまま、指すファイル・SHA・集めた条件・注記は今の表から取る。
 *   - 同じ根拠（同じファイルで同じ SHA。表そのものに結ぶ行は、表の SHA が変わっても、その行の日付・条件・注記が
 *     同じなら同じ根拠とみる。ほかの行を足しただけで前提の確認を外さないため）: 集めたときの前提
 *     （collected.premise。無ければ前のブリーフの前提）と当てはまりの判定（applicability）を引き継ぐ。前提を変えた
 *     版では、判定が今の前提へのものでなければ確認待ちになる（evidencePremiseStaleness）
 *   - 取り直した根拠（ファイルか SHA が変わった）: 今の版の前提に結び付く根拠として、前の前提と判定を外す
 *     （作業文書・分析の出力を取り直したときと同じ）
 */
function carryPreviousCsvRow(prev, prevRel, current, previousPremise) {
  const sameFile = prevRel === current.path && prev.sha256 === current.sha256;
  const sameTableRow = current.boundToTable && prevRel === current.path && prev.note === current.note
    && prev.collected?.at === current.collected.at && prev.collected?.conditions === current.collected.conditions;
  const same = sameFile || sameTableRow;
  const row = { ...prev, path: current.path, sha256: current.sha256, collected: { ...current.collected }, note: current.note };
  if (same) {
    if (prev.premiseBound !== false) row.collected.premise = plainObject(prev.collected?.premise) ? prev.collected.premise : previousPremise;
  } else {
    delete row.applicability;
  }
  return { row, refreshed: !same };
}

/** まとめた根拠の id を、観測・仮説・残す点と変える点・未確認事項の確かめた根拠から付け替える。 */
function remapEvidenceIds(brief, remap) {
  if (remap.size === 0) return;
  const fix = (entry, key) => {
    if (plainObject(entry) && Array.isArray(entry[key])) entry[key] = [...new Set(entry[key].map((id) => remap.get(id) || id))];
  };
  for (const entry of [...brief.changes.keep, ...brief.changes.change, ...(brief.observations || []), ...(brief.hypotheses || [])]) fix(entry, "evidenceIds");
  for (const entry of brief.openQuestions || []) fix(entry?.resolution, "evidenceIds");
}

async function readJsonInput(file, label, code) {
  const bytes = await readFile(file);
  const value = parseJson(bytes);
  if (value === undefined) throw inputError(`${label} が JSON として読めない。`, code);
  return { bytes, sha256: sha256Hex(bytes), value };
}

/** 受け渡しファイルの形（欄の名前と型）だけを確かめる。中身の正しさはブリーフの検査と品質ループが見る。 */
function handoffShapeIssues(handoff) {
  const issues = [];
  const allowed = new Set([
    "version", "channel", "strategySkill", "producedBy", "question", "audience", "entry", "payoffs", "production",
    "changes", "observations", "hypotheses", "openQuestions", "evidence", "postPublish", "steps",
  ]);
  for (const key of Object.keys(handoff)) if (!allowed.has(key)) issues.push(`strategy-handoff-unknown-field:${key}`);
  for (const key of ["payoffs", "observations", "hypotheses", "openQuestions", "evidence", "steps"]) {
    if (handoff[key] !== undefined && !Array.isArray(handoff[key])) issues.push(`strategy-handoff-invalid:${key}`);
  }
  for (const key of ["audience", "entry", "production", "changes", "postPublish", "strategySkill", "producedBy"]) {
    if (handoff[key] !== undefined && !plainObject(handoff[key])) issues.push(`strategy-handoff-invalid:${key}`);
  }
  return issues;
}

/**
 * 下書きを組み立てる。書くのは outPath を渡したときだけ（作業フォルダの中・既存のファイルは上書きしない）。
 */
export async function draftStrategyBriefFromTool({
  fromDir,
  channelId,
  previousPath = "",
  strategySkillDir = "",
  workDir = "",
  outPath = "",
  now = () => new Date().toISOString(),
} = {}) {
  if (!nonEmpty(fromDir)) throw inputError("--from-hyp に戦略の道具の作業フォルダが要ります。", "strategy-draft-from-missing");
  const channel = nonEmpty(channelId);
  if (!LABEL.test(channel)) throw inputError("--channel にチャンネルの id（英数字と . _ -、64文字まで）が要ります。", "strategy-draft-channel-invalid");
  const source = path.resolve(fromDir);
  const sourceInfo = await lstat(source).catch(() => null);
  if (!sourceInfo?.isDirectory()) throw inputError("--from-hyp は戦略の道具の作業フォルダ（ディレクトリ）にする。", "strategy-draft-from-not-directory");
  const root = nonEmpty(workDir) ? path.resolve(workDir) : source;
  if (root !== source && !workDirRelative(root, source)) {
    throw inputError("--work-dir は --from-hyp のフォルダを含むフォルダにする（根拠は作業フォルダからの相対パスで書く）。", "strategy-draft-outside-work-dir");
  }
  const sourceRel = root === source ? "" : workDirRelative(root, source);
  const underSource = (rel) => (sourceRel ? `${sourceRel}/${rel}` : rel);
  let outFull = "";
  if (nonEmpty(outPath)) {
    outFull = path.resolve(outPath);
    if (!workDirRelative(root, outFull)) {
      throw inputError("--out は作業フォルダの中に置く（品質ループと verdict は作業フォルダからの相対パスで根拠を読む）。", "strategy-draft-out-outside-work-dir");
    }
    if (await lstat(outFull).then(() => true, () => false)) {
      throw inputError(`--out のファイルが既にある（上書きしない）: ${path.basename(outFull)}`, "strategy-draft-out-exists");
    }
  }

  const issues = [];
  const excludedEvidence = [];
  const refreshedEvidence = [];
  const taken = new Set();
  const newId = makeIdFactory(taken);
  const evidence = [];
  const byPath = new Map();
  const pushEvidence = (row, { dedupe = true } = {}) => {
    if (dedupe && byPath.has(row.path)) return byPath.get(row.path);
    evidence.push(row);
    if (dedupe) byPath.set(row.path, row);
    return row;
  };

  // --- 受け渡しファイル（あれば優先） ---
  let handoff = null;
  let handoffInfo = { provided: false };
  const handoffFull = path.join(source, STRATEGY_TOOL_HANDOFF_FILE);
  const handoffStat = await lstat(handoffFull).catch(() => null);
  if (handoffStat?.isFile()) {
    const bytes = await readFile(handoffFull);
    const value = parseJson(bytes);
    handoffInfo = { provided: true, path: underSource(STRATEGY_TOOL_HANDOFF_FILE), sha256: sha256Hex(bytes) };
    if (!plainObject(value)) issues.push("strategy-handoff-unreadable");
    else if (value.version !== STRATEGY_TOOL_HANDOFF_VERSION) issues.push(`strategy-handoff-version-unknown:${String(value.version ?? "").slice(0, 60)}`);
    else {
      const shape = handoffShapeIssues(value);
      issues.push(...shape);
      if (nonEmpty(value.channel?.id) && value.channel.id !== channel) {
        throw inputError(`受け渡しファイルのチャンネル（${value.channel.id}）が --channel と違う。別のチャンネルの判断を混ぜない。`, "strategy-draft-channel-mismatch");
      }
      if (shape.every((code) => !code.startsWith("strategy-handoff-invalid"))) {
        handoff = value;
        handoffInfo.version = value.version;
        if (Array.isArray(value.steps)) {
          handoffInfo.steps = value.steps.slice(0, 50).map((step) => ({
            id: clip(step?.id, 64),
            status: clip(step?.status, 32),
            outputs: (Array.isArray(step?.outputs) ? step.outputs : []).slice(0, 20).map((entry) => clip(entry, 200)),
            ...(nonEmpty(step?.note) ? { note: clip(step.note, 300) } : {}),
          }));
        }
      }
    }
  }

  // --- 前のブリーフ ---
  let previous = null;
  if (nonEmpty(previousPath)) {
    const full = path.resolve(previousPath);
    const read = await readJsonInput(full, "前のブリーフ", "strategy-draft-previous-unreadable");
    const validation = validateStrategyBrief(read.value);
    if (validation.issues.length > 0) {
      throw inputError(`前のブリーフの形が合っていない（${validation.issues.slice(0, 5).join(", ")}）。validate で直してから使う。`, "strategy-draft-previous-invalid");
    }
    if (read.value.channel.id !== channel) {
      throw inputError(`前のブリーフのチャンネル（${read.value.channel.id}）が --channel と違う。`, "strategy-draft-channel-mismatch");
    }
    previous = { full, dir: path.dirname(full), sha256: read.sha256, brief: read.value, premise: strategyBriefPremiseDigests(read.value) };
  }

  // 受け渡しファイルの根拠の行（形は受け渡しの仕様。SHA はここで計算する）。
  if (handoff && Array.isArray(handoff.evidence)) {
    for (const [index, row] of handoff.evidence.entries()) {
      const id = nonEmpty(row?.id);
      if (!ITEM_ID.test(id) || taken.has(id)) {
        excludedEvidence.push({ source: "handoff", index, reasonCode: "strategy-handoff-evidence-id-invalid" });
        continue;
      }
      const relFromSource = normalizeEvidenceRelPath(row?.path);
      if (!relFromSource.ok) {
        excludedEvidence.push({ source: "handoff", id, reasonCode: "strategy-evidence-path-invalid" });
        continue;
      }
      const file = await safeFileInside(root, underSource(relFromSource.rel));
      if (!file) {
        excludedEvidence.push({ source: "handoff", id, reasonCode: "strategy-evidence-missing" });
        continue;
      }
      let sha256 = "";
      if (row.kind === "audience-run") {
        if (!file.isDirectory) {
          excludedEvidence.push({ source: "handoff", id, path: file.rel, reasonCode: "strategy-evidence-audience-run-invalid" });
          continue;
        }
        const run = await inspectAudienceRun(file.full);
        if (run.status !== "current") {
          excludedEvidence.push({ source: "handoff", id, path: file.rel, reasonCode: `strategy-evidence-audience-run-${run.status}`, reasons: run.reasons });
          continue;
        }
        sha256 = run.reportManifestSha256;
      } else {
        if (!file.isFile) {
          excludedEvidence.push({ source: "handoff", id, path: file.rel, reasonCode: "strategy-evidence-missing" });
          continue;
        }
        sha256 = sha256Hex(await readFile(file.full));
      }
      if (nonEmpty(row.sha256) && row.sha256 !== sha256) {
        excludedEvidence.push({ source: "handoff", id, path: file.rel, reasonCode: "strategy-handoff-evidence-changed" });
        continue;
      }
      const verified = row.state === "verified" && plainObject(row.verification) && nonEmpty(row.verification.method);
      if (row.state === "verified" && !verified) issues.push(`strategy-handoff-evidence-state-downgraded:${id}`);
      taken.add(id);
      pushEvidence({
        id,
        kind: row.kind,
        path: file.rel,
        sha256,
        state: verified ? "verified" : (row.state === "unverified" ? "unverified" : "provisional"),
        collected: plainObject(row.collected)
          ? { at: nonEmpty(row.collected.at) || "unknown", conditions: clip(nonEmpty(row.collected.conditions) || "受け渡しファイルに条件の記載なし", 500) }
          : { at: "unknown", conditions: "受け渡しファイルに条件の記載なし" },
        ...(verified ? { verification: { method: clip(row.verification.method, 300), ...(nonEmpty(row.verification.by) ? { by: clip(row.verification.by, 128) } : {}) } } : {}),
        ...(row.premiseBound === false ? { premiseBound: false, premiseIndependenceReason: clip(nonEmpty(row.premiseIndependenceReason) || "受け渡しファイルで前提に依らないと宣言された根拠", 300) } : {}),
        ...(nonEmpty(row.note) ? { note: clip(row.note, 300) } : {}),
      });
    }
  }

  // 根拠の表は先に読む（前のブリーフの行と evidence_id で突き合わせてから id を決める）。
  const csvTable = await readEvidenceCsv({ root, source, underSource, issues });
  const evidenceCsv = csvTable.info;
  const collapsedRows = [];

  // 前のブリーフの根拠の行。前提に結び付く行には、集めたときの前提（前のブリーフの前提）を書く。
  // 根拠の表の行から作った行は、表の同じ evidence_id の行と1つにする（前の版の id を保ち、今の表で置き換える）。
  // 表から消えた evidence_id の行・表以外の行は今までどおり引き継ぐ。
  if (previous) {
    const previousRows = previous.brief.evidence;
    const matched = matchPreviousCsvRows(previousRows, csvTable.rows);
    for (const [prevIndex, row] of previousRows.entries()) {
      const normalized = normalizeEvidenceRelPath(row.path);
      const rel = normalized.ok ? workDirRelative(root, path.join(previous.dir, ...normalized.segments)) : null;
      if (matched.collapsed.has(prevIndex)) {
        // 以前の下書きが同じ evidence_id を二重にした行。id は別の根拠に使わせない。
        taken.add(row.id);
        collapsedRows.push({ id: row.id, rowIndex: matched.collapsed.get(prevIndex) });
        continue;
      }
      if (matched.rowByPrevious.has(prevIndex)) {
        if (taken.has(row.id)) {
          // 受け渡しファイルの別の根拠が同じ id を持つ。表の行は新しい id で作る。
          excludedEvidence.push({ source: "previous", id: row.id, reasonCode: "strategy-draft-evidence-id-taken" });
          continue;
        }
        const current = csvTable.rows[matched.rowByPrevious.get(prevIndex)];
        taken.add(row.id);
        current.id = row.id;
        const carried = carryPreviousCsvRow(row, rel, current, previous.premise);
        evidence.push(carried.row);
        if (carried.refreshed) refreshedEvidence.push({ id: row.id, path: current.path, ...(rel && rel !== current.path ? { previousPath: rel } : {}) });
        continue;
      }
      if (!rel) {
        excludedEvidence.push({ source: "previous", id: row.id, kind: row.kind, reasonCode: "strategy-draft-outside-work-dir" });
        continue;
      }
      if (taken.has(row.id)) {
        excludedEvidence.push({ source: "previous", id: row.id, reasonCode: "strategy-draft-evidence-id-taken" });
        continue;
      }
      if (byPath.has(rel)) {
        excludedEvidence.push({ source: "previous", id: row.id, path: rel, reasonCode: "strategy-draft-evidence-duplicate-path", keptId: byPath.get(rel).id });
        continue;
      }
      taken.add(row.id);
      const collected = row.premiseBound === false || plainObject(row.collected?.premise)
        ? row.collected
        : { ...row.collected, premise: previous.premise };
      pushEvidence({ ...row, path: rel, collected });
    }
  }

  // --- 作業フォルダを読む ---
  const scan = await scanWorkDir(source);
  if (scan.truncated) issues.push("strategy-draft-scan-truncated");
  const audienceRuns = [];
  for (const dir of scan.runs) {
    const rel = workDirRelative(root, dir);
    if (!rel) continue;
    const run = await inspectAudienceRun(dir);
    audienceRuns.push({ path: rel, status: run.status, reasons: run.reasons, completeStages: run.completeStages || [], videoId: run.videoId || null });
    if (run.status !== "current") {
      // stale・none・invalid の run は根拠にしない（取り直すかレポートを作り直す）。
      excludedEvidence.push({ source: "scan", kind: "audience-run", path: rel, reasonCode: `strategy-evidence-audience-run-${run.status}`, reasons: run.reasons });
      continue;
    }
    const existing = byPath.get(rel);
    if (existing) {
      if (existing.sha256 !== run.reportManifestSha256) {
        // 同じ run のレポートを作り直した（SHA が変わった）。行の id は保ち、今の SHA で取り直した根拠にする。
        existing.sha256 = run.reportManifestSha256;
        existing.collected = { at: nonEmpty(run.createdAt) || "unknown", conditions: clip(`視聴者の4分析（完了: ${(run.completeStages || []).join(", ") || "なし"}）。動画 ${run.videoId || "不明"}`, 500) };
        delete existing.applicability;
        refreshedEvidence.push({ id: existing.id, path: rel });
      }
      continue;
    }
    pushEvidence({
      id: newId("run", path.basename(dir)),
      kind: "audience-run",
      path: rel,
      sha256: run.reportManifestSha256,
      state: "provisional",
      collected: { at: nonEmpty(run.createdAt) || "unknown", conditions: clip(`視聴者の4分析（完了: ${(run.completeStages || []).join(", ") || "なし"}）。動画 ${run.videoId || "不明"}`, 500) },
    });
  }
  const dataFiles = [];
  const ignoredJson = [];
  for (const file of scan.jsonFiles) {
    const rel = workDirRelative(root, file);
    if (!rel || file === handoffFull || file === outFull) continue;
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() || info.size > MAX_JSON_BYTES) {
      ignoredJson.push({ path: rel, reason: "too-large-or-unreadable" });
      continue;
    }
    const bytes = await readFile(file);
    const value = parseJson(bytes);
    if (plainObject(value) && value.version === STRATEGY_BRIEF_VERSION) continue;
    const kind = classifyJson(value);
    if (!kind) {
      ignoredJson.push({ path: rel, reason: "not-a-known-output" });
      continue;
    }
    const sha256 = sha256Hex(bytes);
    dataFiles.push({ path: rel, kind, sha256 });
    const existing = byPath.get(rel);
    if (existing) {
      if (existing.sha256 !== sha256) {
        existing.sha256 = sha256;
        existing.collected = { at: kind === "snapshot" && nonEmpty(value.fetched_at) ? value.fetched_at : "unknown", conditions: clip(dataConditions(kind, value), 500) };
        delete existing.applicability;
        refreshedEvidence.push({ id: existing.id, path: rel });
      }
      continue;
    }
    const measured = kind === "metrics" || kind === "referrals";
    pushEvidence({
      id: newId(kind, path.basename(file, ".json")),
      kind,
      path: rel,
      sha256,
      state: "provisional",
      collected: { at: kind === "snapshot" && isDateLike(value.fetched_at) ? value.fetched_at : "unknown", conditions: clip(dataConditions(kind, value), 500) },
      ...(measured ? { premiseBound: false, premiseIndependenceReason: "所有者の実測の集計。企画の前提に依らない" } : {}),
    });
  }

  // 作業文書（中身は読まない。種類と SHA だけ）。
  const documents = [];
  for (const [name, spec] of Object.entries(STRATEGY_TOOL_DOCUMENTS)) {
    const file = await safeFileInside(root, underSource(name));
    if (!file?.isFile) continue;
    const sha256 = sha256Hex(await readFile(file.full));
    documents.push({ name, role: spec.role, path: file.rel, sha256 });
    const existing = byPath.get(file.rel);
    if (existing) {
      if (existing.sha256 !== sha256) {
        // 文書を書き直した。行の id は保ち、今の版で集めた根拠にする（前の前提との結び付きは外す）。
        existing.sha256 = sha256;
        existing.collected = { at: "unknown", conditions: `戦略の道具の作業文書 ${name}（${spec.label}）。中身は上位の AI が読む` };
        delete existing.applicability;
        refreshedEvidence.push({ id: existing.id, path: file.rel });
      }
      continue;
    }
    pushEvidence({
      id: newId("doc", spec.role),
      kind: "planning-document",
      path: file.rel,
      sha256,
      state: "provisional",
      collected: { at: "unknown", conditions: `戦略の道具の作業文書 ${name}（${spec.label}）。中身は上位の AI が読む` },
      ...(spec.premiseIndependenceReason ? { premiseBound: false, premiseIndependenceReason: spec.premiseIndependenceReason } : {}),
    });
  }

  // 根拠の表（evidence.csv）。前の版の行と結んだ行はその id のまま（上で置き換え済み）、結べなかった行だけ
  // 新しい根拠の行を作る。観測の列は observations[] にも入れ、行の id（前の版の id を含む）に結ぶ。
  const handoffObservations = Array.isArray(handoff?.observations) ? structuredClone(handoff.observations) : [];
  for (const row of handoffObservations) if (nonEmpty(row?.id)) taken.add(row.id);
  const observations = [];
  for (const row of csvTable.rows) {
    if (row.id) evidenceCsv.reused += 1;
    else {
      row.id = newId("csv", row.sourceId);
      evidence.push({ id: row.id, kind: "other", path: row.path, sha256: row.sha256, state: "provisional", collected: { ...row.collected }, note: row.note });
    }
    evidenceCsv.used += 1;
    if (Array.from(row.statement).length >= 4 && observations.length < MAX_OBSERVATIONS) {
      observations.push({ id: newId("obs", row.sourceId), statement: clip(row.statement, 300), evidenceIds: [row.id] });
    }
  }
  const evidenceIdRemap = new Map();
  for (const { id, rowIndex } of collapsedRows) {
    const keptId = csvTable.rows[rowIndex].id;
    excludedEvidence.push({ source: "previous", id, reasonCode: "strategy-draft-evidence-duplicate-csv-row", keptId });
    evidenceIdRemap.set(id, keptId);
  }

  if (evidence.length > MAX_EVIDENCE) {
    const dropped = evidence.splice(MAX_EVIDENCE);
    issues.push(`strategy-draft-evidence-truncated:${dropped.length}`);
    for (const row of dropped) excludedEvidence.push({ source: "limit", id: row.id, path: row.path, reasonCode: "strategy-draft-evidence-over-limit" });
    const kept = new Set(evidence.map((row) => row.id));
    for (let index = observations.length - 1; index >= 0; index -= 1) {
      if (!observations[index].evidenceIds.every((id) => kept.has(id))) observations.splice(index, 1);
    }
  }

  // --- 使った戦略の道具の版 ---
  let strategySkill = null;
  if (nonEmpty(strategySkillDir)) {
    const measured = await strategySkillFingerprint(path.resolve(strategySkillDir));
    strategySkill = { fingerprint: measured.fingerprint, fileCount: measured.fileCount };
  } else issues.push("strategy-skill-version-unrecorded");
  const declared = nonEmpty(handoff?.strategySkill?.fingerprint);
  if (declared && strategySkill && declared !== strategySkill.fingerprint) issues.push("strategy-skill-fingerprint-mismatch-with-handoff");
  const previousSkill = nonEmpty(previous?.brief?.provenance?.strategySkill?.fingerprint);
  if (previousSkill && strategySkill && previousSkill !== strategySkill.fingerprint) issues.push("strategy-skill-changed-from-previous");

  // --- 組み立て（受け渡しファイル > 前のブリーフ > 空） ---
  const prev = previous?.brief || null;
  const pick = (key) => (handoff && handoff[key] !== undefined ? { value: structuredClone(handoff[key]), from: "handoff" }
    : prev && prev[key] !== undefined ? { value: structuredClone(prev[key]), from: "previous-brief" } : { value: undefined, from: null });
  const filled = {};
  const take = (key, fallback) => {
    const picked = pick(key);
    if (picked.from) filled[key] = picked.from;
    return picked.value === undefined ? fallback : picked.value;
  };
  const audience = take("audience", { who: null, whyWatch: null });
  const handoffChanges = plainObject(handoff?.changes) ? handoff.changes : {};
  const briefDraft = {
    version: STRATEGY_BRIEF_VERSION,
    label: prev ? nextBriefLabel(prev.label) : "r1",
    channel: { id: channel, designVersion: nonEmpty(handoff?.channel?.designVersion) || prev?.channel?.designVersion || null },
    question: take("question", null),
    audience: plainObject(audience) ? audience : { who: null, whyWatch: null },
    entry: take("entry", { promises: [] }),
    payoffs: take("payoffs", []),
    evidence,
    changes: {
      previous: prev ? { label: prev.label, sha256: previous.sha256 } : null,
      keep: Array.isArray(handoffChanges.keep) ? structuredClone(handoffChanges.keep) : [],
      change: Array.isArray(handoffChanges.change) ? structuredClone(handoffChanges.change) : [],
    },
    production: take("production", { format: null, conditions: [] }),
    postPublish: take("postPublish", { metrics: [] }),
    provenance: {
      host: null,
      contextId: DRAFT_CONTEXT_PLACEHOLDER,
      createdAt: new Date(now()).toISOString(),
      ...(strategySkill ? { strategySkill } : {}),
    },
  };
  if (handoffChanges.keep || handoffChanges.change) filled.changes = "handoff";
  if (nonEmpty(handoff?.channel?.designVersion)) filled["channel.designVersion"] = "handoff";
  else if (prev) filled["channel.designVersion"] = "previous-brief";
  const allObservations = [...handoffObservations, ...observations].slice(0, MAX_OBSERVATIONS);
  if (allObservations.length > 0) briefDraft.observations = allObservations;
  const hypotheses = take("hypotheses", undefined);
  if (Array.isArray(hypotheses)) briefDraft.hypotheses = hypotheses;
  const openQuestions = take("openQuestions", undefined);
  if (Array.isArray(openQuestions)) briefDraft.openQuestions = openQuestions;
  remapEvidenceIds(briefDraft, evidenceIdRemap);

  const draftValidation = validateStrategyBrief(briefDraft);
  const needsAuthoring = strategyDraftNeedsAuthoring(briefDraft, { documents, audienceRuns, dataFiles, filled, evidenceCsv });

  let written = null;
  if (outFull) {
    await writeFile(outFull, `${JSON.stringify(briefDraft, null, 2)}\n`, { flag: "wx" });
    written = { path: workDirRelative(root, outFull), sha256: sha256Hex(await readFile(outFull)) };
  }

  return {
    version: STRATEGY_BRIEF_DRAFT_VERSION,
    modelCallsAttempted: false,
    strategyToolScriptsRun: false,
    workDir: { sourceRel: sourceRel || "." },
    sources: {
      handoff: handoffInfo,
      documents,
      audienceRuns,
      dataFiles,
      evidenceCsv,
      ignoredJson: ignoredJson.slice(0, 50),
    },
    strategySkill,
    previous: previous ? { label: prev.label, sha256: previous.sha256 } : null,
    filledFrom: filled,
    briefDraft,
    needsAuthoring,
    excludedEvidence,
    refreshedEvidence,
    issues: [...new Set(issues)],
    draftIssues: [...draftValidation.issues, ...draftValidation.linkIssues],
    written,
    nextSteps: [
      "needsAuthoring の required を、from に挙げた戦略の道具の成果物を開いて埋める（上位の AI がする。推測で埋めない。確かめられないことは openQuestions に書き、制作を止めるなら blocksProduction: true）",
      "provenance.host と provenance.contextId に、埋めた会話のホストと ID を書く（その文脈はこのブリーフを採点できない）",
      "node scripts/strategy-brief.mjs validate --brief <下書き> で形と対応を確かめる",
      "前のブリーフから問い・見る人・制作条件を変えたら、node scripts/strategy-brief.mjs applicability --brief <下書き> で当てはまりの判定が要る根拠を出し、根拠ごとに --evidence <id> --applies yes|no --reason \"...\" で記録する",
      "node scripts/strategy-brief.mjs start → sheet → 別の文脈で採点 → record で企画の品質ループを回す",
      "node scripts/strategy-brief.mjs verdict --brief <下書き> --require-pass が通ったら、run-video-harness の plan-request / start に --strategy-brief で渡す",
    ],
  };
}

const AUTHORING_SOURCES = Object.freeze({
  question: ["decision-premise", "content-plan", "diagnosis"],
  "audience.who": ["decision-premise", "content-plan", "audience-run"],
  "audience.whyWatch": ["decision-premise", "content-plan", "audience-run"],
  "entry.promises": ["content-plan"],
  payoffs: ["content-plan"],
  "production.format": ["decision-premise", "content-plan"],
  "production.conditions": ["decision-premise", "content-plan"],
  "postPublish.metrics": ["experiments", "data-dictionary", "metrics", "referrals"],
  changes: ["diagnosis", "experiments", "audience-run", "metrics", "referrals", "evidence-csv"],
  hypotheses: ["diagnosis", "experiments", "evidence-csv"],
  openQuestions: ["decision-premise", "diagnosis", "experiments"],
  "channel.designVersion": [],
  "provenance.host": [],
  "provenance.contextId": [],
});

const AUTHORING_HOW = Object.freeze({
  question: "動画が答える問いを1つだけ書く（企画の判断そのもの。成果物に無ければ埋めずに openQuestions へ）",
  "audience.who": "誰が見るか（状況・前提の知識）を、ほかの動画と区別できる具体さで書く",
  "audience.whyWatch": "なぜこの動画を選んで最後まで見るのかを書く",
  "entry.promises": "タイトル・サムネ・冒頭で約束することを surface（title / thumbnail / opening）ごとに書く",
  payoffs: "それぞれの約束を本文のどこで回収するかを書く（約束ごとに1つ以上）",
  "production.format": "long / short / live のどれで作るか",
  "production.conditions": "作れる範囲の条件（尺・声・素材・体制・費用の上限など）を書く",
  "postPublish.metrics": "公開後に見る指標を、指標の集計・関連元の集計の欄の名前で書く（期待の数値は任意）",
  changes: "前の回から残す点・変える点を、それを支える根拠の id に結び付けて書く（前の回が無ければ新しく決めた点）",
  hypotheses: "観測からの解釈を仮説として分けて書く（確かめる前は untested）",
  openQuestions: "まだ確かめていないことと確かめ方を書く。制作の前に確かめないといけないものは blocksProduction: true",
  "channel.designVersion": "チャンネル設計の版の名前を書く（設計の成果物の版）",
  "provenance.host": "この下書きを仕上げたホスト（claude-code / codex など）",
  "provenance.contextId": "この下書きを仕上げた会話・タスクの ID",
});

function fieldValue(brief, field) {
  return field.split(".").reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), brief);
}

function isFilled(brief, field) {
  if (field === "changes") return brief.changes.keep.length + brief.changes.change.length > 0;
  if (field === "provenance.contextId") return brief.provenance.contextId !== DRAFT_CONTEXT_PLACEHOLDER && nonEmpty(brief.provenance.contextId) !== "";
  const value = fieldValue(brief, field);
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim() !== "";
  return value !== null && value !== undefined;
}

/** 機械で埋められなかった欄と、埋めるときに開く成果物（作業フォルダにあるものだけ）。 */
export function strategyDraftNeedsAuthoring(brief, { documents = [], audienceRuns = [], dataFiles = [], filled = {}, evidenceCsv = { provided: false } } = {}) {
  const sourcesFor = (field) => {
    const out = [];
    for (const role of AUTHORING_SOURCES[field] || []) {
      if (role === "audience-run") {
        for (const run of audienceRuns.filter((entry) => entry.status === "current")) out.push({ path: run.path, role });
      } else if (role === "metrics" || role === "referrals") {
        for (const file of dataFiles.filter((entry) => entry.kind === role)) out.push({ path: file.path, role });
      } else if (role === "evidence-csv") {
        if (evidenceCsv.provided) out.push({ path: evidenceCsv.path, role });
      } else {
        for (const doc of documents.filter((entry) => entry.role === role)) out.push({ path: doc.path, role });
      }
    }
    return out;
  };
  const required = [
    "question", "audience.who", "audience.whyWatch", "entry.promises", "payoffs", "production.format", "production.conditions",
    "postPublish.metrics", "channel.designVersion", "provenance.host", "provenance.contextId",
  ];
  const recommended = ["changes", "hypotheses", "openQuestions"];
  const topKey = (field) => field.split(".")[0];
  const rows = [];
  for (const [priority, list] of [["required", required], ["recommended", recommended]]) {
    for (const field of list) {
      const from = sourcesFor(field);
      const origin = filled[field] || filled[topKey(field)] || null;
      if (isFilled(brief, field)) {
        if (origin) rows.push({ field, priority, action: "confirm", filledFrom: origin, from, how: `${origin === "handoff" ? "受け渡しファイル" : "前のブリーフ"}から入れた。今回の判断として正しいか、from の成果物と照らして確かめる` });
        continue;
      }
      rows.push({
        field,
        priority,
        action: "author",
        from,
        how: from.length > 0 || AUTHORING_SOURCES[field]?.length === 0
          ? AUTHORING_HOW[field]
          : `${AUTHORING_HOW[field]}。該当する成果物が作業フォルダに無い。戦略の道具の工程を実行してから埋める（推測で埋めない）`,
      });
    }
  }
  return rows;
}
