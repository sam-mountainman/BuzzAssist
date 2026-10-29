// 公開宣言と、運営者が明示した作業木の外の宣言を解決する唯一の入口。
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const PRIVATE_HARNESS_DIRS_ENV = "BUZZASSIST_PRIVATE_HARNESS_DIRS";
const SUFFIX = ".harness.json";
const ID = /^[a-z0-9][a-z0-9-]*$/u;

const identity = (path) => { const info = statSync(path); return `${info.dev}:${info.ino}`; };

// Git の管理ディレクトリの場所に依存しない。cache から起動していても対象の祖先を調べる。
// native realpath だけでは macOS の firmlink が同じ字面になるとは限らないので dev/ino も照合する。
export function assertOutsideRepositoryWorktrees(target, { repoRoot = REPO_ROOT } = {}) {
  const full = realpathSync.native(target);
  const rootIdentity = identity(realpathSync.native(repoRoot));
  for (const start of new Set([resolve(target), full])) {
    for (let current = start; ; current = dirname(current)) {
      const info = statSync(current);
      if (info.isDirectory()) {
        let gitMarker = false;
        try { lstatSync(join(current, ".git")); gitMarker = true; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (gitMarker || identity(realpathSync.native(current)) === rootIdentity) {
          throw new Error(`${PRIVATE_HARNESS_DIRS_ENV}: リポジトリの作業木の中は指定できない: ${target}`);
        }
      }
      if (dirname(current) === current) break;
    }
  }
  return full;
}

export function reportPrivateHarnessFailure(error, source, { onDiagnostic = console.warn } = {}) {
  onDiagnostic(`${PRIVATE_HARNESS_DIRS_ENV}: ${source}: ${error.message}`);
}

export function resolveHarnessDeclarationDirs({ repoRoot = REPO_ROOT, publicDir, env = process.env,
  includePrivate = true, toleratePrivateErrors = false, onDiagnostic } = {}) {
  const root = resolve(repoRoot);
  const dirs = [{ path: resolve(publicDir || join(root, "config", "harnesses")), layer: "public" }];
  const privateDirs = includePrivate ? String(env[PRIVATE_HARNESS_DIRS_ENV] || "").split(delimiter).map((dir) => dir.trim()).filter(Boolean) : [];
  if (!privateDirs.length) return dirs;
  const seen = new Set();
  for (const dir of privateDirs) {
    try {
      if (!isAbsolute(dir)) throw new Error(`${PRIVATE_HARNESS_DIRS_ENV}: 外の宣言フォルダは絶対パスで指定する。`);
      const full = assertOutsideRepositoryWorktrees(dir, { repoRoot: root });
      if (!statSync(full).isDirectory()) throw new Error(`${PRIVATE_HARNESS_DIRS_ENV}: フォルダではない: ${dir}`);
      const key = identity(full);
      if (!seen.has(key)) dirs.push({ path: full, layer: "private" });
      seen.add(key);
    } catch (error) {
      if (!toleratePrivateErrors) throw new Error(`${PRIVATE_HARNESS_DIRS_ENV}: ${dir}: ${error.message}`);
      reportPrivateHarnessFailure(error, dir, { onDiagnostic });
    }
  }
  return dirs;
}

export function listHarnessDeclarations(options = {}) {
  const dirs = resolveHarnessDeclarationDirs(options);
  const records = new Map();
  const conflicted = new Set();
  for (const dir of dirs) {
    if (dir.layer === "public" && !existsSync(dir.path)) continue;
    let names;
    try { names = readdirSync(dir.path).filter((entry) => entry.endsWith(SUFFIX)).sort(); }
    catch (error) {
      if (dir.layer !== "private" || !options.toleratePrivateErrors) throw error;
      reportPrivateHarnessFailure(error, dir.path, options); continue;
    }
    for (const name of names) {
      const file = join(dir.path, name);
      try {
        if (dir.layer === "private") assertOutsideRepositoryWorktrees(file, options);
        const bytes = readFileSync(file);
        let declaration;
        try { declaration = JSON.parse(bytes.toString("utf8")); }
        catch (error) { throw new Error(`${name} が壊れています: ${error.message}`); }
        const id = declaration?.id;
        if (!ID.test(String(id || "")) || name !== `${id}${SUFFIX}`) throw new Error(`宣言の id とファイル名が一致しない: ${name}`);
        if (dir.layer === "private" && declaration.layer !== "private") throw new Error(`外の宣言には layer: private が必要: ${name}`);
        if (dir.layer === "public" && declaration.layer !== undefined) throw new Error(`公開の宣言に layer は書けない（private は配布禁止）: ${name}`);
        if (records.has(id) || conflicted.has(id)) {
          if (records.get(id)?.layer === "private") records.delete(id);
          conflicted.add(id);
          throw new Error(`ハーネス宣言の id が重複している（上書き禁止）: ${id}`);
        }
        records.set(id, { path: file, bytes, declaration, layer: dir.layer });
      } catch (error) {
        if (dir.layer !== "private" || !options.toleratePrivateErrors) throw error;
        reportPrivateHarnessFailure(error, file, options);
      }
    }
  }
  return [...records.values()].sort((a, b) => a.declaration.id.localeCompare(b.declaration.id));
}

export function findHarnessDeclaration(harnessId, options = {}) {
  if (!ID.test(String(harnessId || ""))) return null;
  const publicRecord = listHarnessDeclarations({ ...options, includePrivate: false }).find((record) => record.declaration.id === harnessId);
  if (publicRecord) return publicRecord;
  return listHarnessDeclarations({ toleratePrivateErrors: true, ...options }).find((record) => record.declaration.id === harnessId) || null;
}

export function requireHarnessDeclaration(harnessId, options = {}) {
  const record = findHarnessDeclaration(harnessId, options);
  if (!record) throw new Error(`ハーネス宣言が見つからない: ${harnessId}`);
  return record;
}

export function harnessCapabilityPath(harnessId, options = {}) {
  if (!ID.test(String(harnessId || ""))) throw new Error("能力カードの harness id が不正。");
  const record = findHarnessDeclaration(harnessId, options);
  const dir = record ? dirname(record.path) : resolveHarnessDeclarationDirs(options)[0].path;
  return join(dir, `${harnessId}.capabilities.json`);
}
