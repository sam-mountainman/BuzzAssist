// 動画ハーネスで使う・使わない OSS・モデルの重み・素材の入手先・手元のスキルの採否（OSS の台帳）。
// 既定は config/oss-catalog.json。
//
// 決まり:
//   - 足す前に台帳を見る。無ければライセンスを確かめて行を足す（確かめるのは model-route の license-check の回し先）
//   - reject の物は依存に入れない。package.json と Python の依存の宣言に名前が出たら check が止める
//   - in-use の行は、使い所のファイル（evidence）が実在すること。書いただけの「使っている」を残さない
//   - private-only の物は顧客に渡す土台に入れない（customerKit は never）
//   - ここは台帳を読んで照らすだけ。何も取りに行かない・入れない

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OSS_CATALOG_PATH = path.join(MODULE_ROOT, "config", "oss-catalog.json");
export const OSS_CATALOG_VERSION = "buzzassist-oss-catalog-v1";
export const OSS_CATALOG_STATUSES = Object.freeze(["in-use", "adopt", "hold", "private-only", "reject"]);
export const OSS_CUSTOMER_KIT_VALUES = Object.freeze(["bundle", "install-on-demand", "call-installed", "operator-downloads", "never"]);
export const OSS_REJECTED_DEPENDENCY_CODE = "oss-catalog-rejected-dependency";

const ID = /^[a-z][a-z0-9-]{0,63}$/u;
const COMMERCIAL = new Set(["yes", "no", "conditional", "unknown"]);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 台帳の形を確かめる。直せない値は例外（黙って読み飛ばすと、書いた側は効いているつもりになる）。
 * rootDir を渡すと、in-use の evidence が実在するかも見る。
 */
export function validateOssCatalog(catalog, { rootDir = MODULE_ROOT } = {}) {
  const problems = [];
  if (!plainObject(catalog) || catalog.version !== OSS_CATALOG_VERSION) problems.push(`version は ${OSS_CATALOG_VERSION}`);
  const entries = Array.isArray(catalog?.entries) ? catalog.entries : [];
  if (entries.length === 0) problems.push("entries が要る");
  const ids = new Set();
  const packageOwners = new Map();
  for (const entry of entries) {
    const id = String(entry?.id || "");
    if (!ID.test(id)) { problems.push(`id ${id || "(空)"} の形`); continue; }
    if (ids.has(id)) problems.push(`id ${id} が重複`);
    ids.add(id);
    if (!nonEmpty(entry.name)) problems.push(`${id}: name が要る`);
    if (!nonEmpty(entry.area)) problems.push(`${id}: area が要る`);
    if (!nonEmpty(entry.license)) problems.push(`${id}: license が要る（確かめていない物は足さない）`);
    if (!nonEmpty(entry.source)) problems.push(`${id}: source（ライセンスの出典）が要る`);
    if (!nonEmpty(entry.reason)) problems.push(`${id}: reason（採る・採らない理由）が要る`);
    if (!OSS_CATALOG_STATUSES.includes(entry.status)) problems.push(`${id}: status は ${OSS_CATALOG_STATUSES.join(" / ")}`);
    if (!OSS_CUSTOMER_KIT_VALUES.includes(entry.customerKit)) problems.push(`${id}: customerKit は ${OSS_CUSTOMER_KIT_VALUES.join(" / ")}`);
    if (!COMMERCIAL.has(entry.commercialUse)) problems.push(`${id}: commercialUse は yes / no / conditional / unknown`);
    // 商用で使えない・顧客に渡せない物が、土台の採用の側に紛れ込まないように。
    if (entry.commercialUse === "no" && entry.status !== "reject") problems.push(`${id}: 商用で使えない物は reject`);
    if ((entry.status === "reject" || entry.status === "private-only") && entry.customerKit !== "never") {
      problems.push(`${id}: ${entry.status} の物の customerKit は never`);
    }
    if (entry.status === "adopt" && !nonEmpty(entry.wireWhen)) problems.push(`${id}: adopt の物は wireWhen（どの工程で使うか）が要る`);
    if (entry.status === "in-use") {
      const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
      if (evidence.length === 0) problems.push(`${id}: in-use の物は evidence（使い所のファイル）が要る`);
      for (const file of evidence) {
        if (!nonEmpty(file) || path.isAbsolute(file) || file.split(/[\\/]/u).includes("..")) problems.push(`${id}: evidence ${file} はリポジトリ内の相対パス`);
        else if (rootDir && !existsSync(path.join(rootDir, file))) problems.push(`${id}: evidence ${file} が無い`);
      }
    }
    for (const name of Array.isArray(entry.packageNames) ? entry.packageNames : []) {
      const key = normalizePackageName(name);
      if (!key) { problems.push(`${id}: packageNames の ${name} の形`); continue; }
      if (packageOwners.has(key) && packageOwners.get(key) !== id) problems.push(`${id}: パッケージ ${name} が ${packageOwners.get(key)} と重複`);
      packageOwners.set(key, id);
    }
  }
  if (problems.length > 0) throw new Error(`OSS の台帳が使えない: ${problems.join(" / ")}`);
  return catalog;
}

export function loadOssCatalog({ catalogPath = OSS_CATALOG_PATH, rootDir = MODULE_ROOT } = {}) {
  return validateOssCatalog(JSON.parse(readFileSync(catalogPath, "utf8")), { rootDir });
}

/** npm と PyPI の名前を同じ形にそろえる（PyPI は大文字小文字と - _ . を区別しない）。 */
export function normalizePackageName(name) {
  const text = String(name || "").trim().toLowerCase();
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(text)) return "";
  return text.replace(/[._]+/gu, "-");
}

/** requirements.txt・pyproject.toml の依存の行から名前だけを取る（版の指定・extras・コメントは外す）。 */
export function pythonRequirementNames(text) {
  const names = [];
  for (const raw of String(text || "").split(/\r?\n/u)) {
    const line = raw.replace(/#.*/u, "").trim().replace(/^["']|["'],?$/gu, "");
    if (!line || line.startsWith("-") || line.startsWith("[")) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(?:[<>=!~;]|$)/u.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

/**
 * 依存の宣言に reject の物が入っていないかを見る。sources は { label, names }（名前の配列）の一覧。
 * 当たれば { id, packageName, source, reason } の一覧を返す（空なら問題なし）。
 */
export function findRejectedDependencies(catalog, sources = []) {
  const rejected = new Map();
  for (const entry of catalog.entries) {
    if (entry.status !== "reject") continue;
    for (const name of entry.packageNames || []) rejected.set(normalizePackageName(name), entry);
  }
  const hits = [];
  for (const source of sources) {
    for (const name of source.names || []) {
      const entry = rejected.get(normalizePackageName(name));
      if (entry) hits.push({ id: entry.id, packageName: name, source: source.label, reason: entry.reason });
    }
  }
  return hits;
}

const PYTHON_DEPENDENCY_FILE = /^(?:requirements[\w.-]*\.txt|pyproject\.toml)$/u;
const SKIP_DIRS = new Set(["node_modules", ".git", "canvas", "dist", "dist-widget", "release", "channel-packs", "client-work"]);

/** リポジトリの依存の宣言（package.json と Python の requirements・pyproject）を集める。 */
export function collectDependencySources(rootDir = MODULE_ROOT, { maxDepth = 3 } = {}) {
  const sources = [];
  const packageJsonPath = path.join(rootDir, "package.json");
  if (existsSync(packageJsonPath)) {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      if (plainObject(pkg[field])) sources.push({ label: `package.json ${field}`, names: Object.keys(pkg[field]) });
    }
  }
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let items = [];
    try { items = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      if (item.isDirectory()) {
        if (!SKIP_DIRS.has(item.name) && !item.name.startsWith(".")) walk(path.join(dir, item.name), depth + 1);
      } else if (PYTHON_DEPENDENCY_FILE.test(item.name)) {
        const file = path.join(dir, item.name);
        // 表示はどの OS でも / で区切る（Windows の \ のままだと、同じ違反の報告が OS で違って見える）。
        sources.push({ label: path.relative(rootDir, file).split(path.sep).join("/"), names: pythonRequirementNames(readFileSync(file, "utf8")) });
      }
    }
  };
  walk(rootDir, 0);
  return sources;
}

/** 台帳の検査（形・evidence・reject の依存）。問題の一覧を返す（空なら合格）。 */
export function checkOssCatalog({ catalogPath = OSS_CATALOG_PATH, rootDir = MODULE_ROOT } = {}) {
  let catalog;
  try {
    catalog = loadOssCatalog({ catalogPath, rootDir });
  } catch (error) {
    return { ok: false, problems: [String(error.message || error)], rejectedDependencies: [] };
  }
  const rejectedDependencies = findRejectedDependencies(catalog, collectDependencySources(rootDir));
  const problems = rejectedDependencies.map((hit) => `${OSS_REJECTED_DEPENDENCY_CODE}: ${hit.source} の ${hit.packageName}（台帳 ${hit.id}: ${hit.reason}）`);
  return { ok: problems.length === 0, problems, rejectedDependencies, entries: catalog.entries.length };
}

/** 一覧の行（分野・状態で絞る）。 */
export function ossCatalogRows(catalog, { area = "", status = "" } = {}) {
  return catalog.entries.filter((entry) => (!area || entry.area === area) && (!status || entry.status === status));
}

function cell(value) {
  return String(value ?? "").replace(/\|/gu, "／").replace(/\r?\n/gu, " ");
}

/** Markdown の表（PR の本文・人が読む一覧）。表は台帳から毎回作る（文章で別に持たない）。 */
export function ossCatalogMarkdown(rows) {
  const lines = [
    "| 状態 | 分野 | 名前 | ライセンス | 商用 | 顧客の仕組み | 理由 |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const entry of rows) {
    lines.push(`| ${cell(entry.status)} | ${cell(entry.area)} | ${cell(entry.name)} | ${cell(entry.license)} | ${cell(entry.commercialUse)} | ${cell(entry.customerKit)} | ${cell(entry.reason)}${entry.wireWhen ? `（使い所: ${cell(entry.wireWhen)}）` : ""}${entry.caution ? `（注意: ${cell(entry.caution)}）` : ""} |`);
  }
  return `${lines.join("\n")}\n`;
}
