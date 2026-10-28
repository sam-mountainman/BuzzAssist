// 公開宣言と、運営者が明示した作業木の外の宣言を解決する唯一の入口。
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const PRIVATE_HARNESS_DIRS_ENV = "BUZZASSIST_PRIVATE_HARNESS_DIRS";
const SUFFIX = ".harness.json";
const ID = /^[a-z0-9][a-z0-9-]*$/u;

function inside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

// linked worktree の .git はファイル。共通の作業木とほかの linked worktree も境界に含める。
function worktreeRoots(repoRoot) {
  const root = realpathSync(repoRoot);
  const roots = new Set([resolve(repoRoot), root]);
  const marker = join(root, ".git");
  if (!existsSync(marker)) return [...roots];
  const gitDir = statSync(marker).isDirectory() ? marker
    : resolve(root, readFileSync(marker, "utf8").trim().replace(/^gitdir:\s*/u, ""));
  const commonFile = join(gitDir, "commondir");
  const common = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, "utf8").trim()) : gitDir;
  if (common.endsWith(`${sep}.git`)) roots.add(realpathSync(dirname(common)));
  const linked = join(common, "worktrees");
  if (existsSync(linked)) {
    for (const name of readdirSync(linked)) {
      const pointer = join(linked, name, "gitdir");
      if (!existsSync(pointer)) continue;
      const tree = dirname(readFileSync(pointer, "utf8").trim());
      if (existsSync(tree)) roots.add(realpathSync(tree));
    }
  }
  return [...roots];
}

export function resolveHarnessDeclarationDirs({ repoRoot = REPO_ROOT, publicDir, env = process.env } = {}) {
  const root = resolve(repoRoot);
  const dirs = [{ path: resolve(publicDir || join(root, "config", "harnesses")), layer: "public" }];
  const privateDirs = String(env[PRIVATE_HARNESS_DIRS_ENV] || "").split(delimiter).map((dir) => dir.trim()).filter(Boolean);
  if (!privateDirs.length) return dirs;
  const roots = worktreeRoots(root);
  const seen = new Set();
  for (const dir of privateDirs) {
    if (!isAbsolute(dir)) throw new Error(`${PRIVATE_HARNESS_DIRS_ENV}: 外の宣言フォルダは絶対パスで指定する。`);
    const full = realpathSync(dir);
    if (roots.some((tree) => inside(tree, resolve(dir)) || inside(tree, full))) {
      throw new Error(`${PRIVATE_HARNESS_DIRS_ENV}: リポジトリの作業木の中は指定できない: ${dir}`);
    }
    if (!statSync(full).isDirectory()) throw new Error(`${PRIVATE_HARNESS_DIRS_ENV}: フォルダではない: ${dir}`);
    if (!seen.has(full)) dirs.push({ path: full, layer: "private" });
    seen.add(full);
  }
  return dirs;
}

export function listHarnessDeclarations(options = {}) {
  const dirs = resolveHarnessDeclarationDirs(options);
  const roots = dirs.some((dir) => dir.layer === "private") ? worktreeRoots(options.repoRoot || REPO_ROOT) : [];
  const records = new Map();
  for (const dir of dirs) {
    if (dir.layer === "public" && !existsSync(dir.path)) continue;
    for (const name of readdirSync(dir.path).filter((entry) => entry.endsWith(SUFFIX)).sort()) {
      const file = join(dir.path, name);
      if (dir.layer === "private" && roots.some((root) => inside(root, realpathSync(file)))) {
        throw new Error(`外の宣言がリポジトリの作業木を参照している: ${file}`);
      }
      const bytes = readFileSync(file);
      let declaration;
      try { declaration = JSON.parse(bytes.toString("utf8")); }
      catch (error) { throw new Error(`${name} が壊れています: ${error.message}`); }
      const id = declaration?.id;
      if (!ID.test(String(id || "")) || name !== `${id}${SUFFIX}`) throw new Error(`宣言の id とファイル名が一致しない: ${name}`);
      if (dir.layer === "private" && declaration.layer !== "private") throw new Error(`外の宣言には layer: private が必要: ${name}`);
      if (dir.layer === "public" && declaration.layer !== undefined) throw new Error(`公開の宣言に layer は書けない（private は配布禁止）: ${name}`);
      if (records.has(id)) throw new Error(`ハーネス宣言の id が重複している（上書き禁止）: ${id}`);
      records.set(id, { path: file, bytes, declaration, layer: dir.layer });
    }
  }
  return [...records.values()].sort((a, b) => a.declaration.id.localeCompare(b.declaration.id));
}

export function findHarnessDeclaration(harnessId, options = {}) {
  if (!ID.test(String(harnessId || ""))) return null;
  return listHarnessDeclarations(options).find((record) => record.declaration.id === harnessId) || null;
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
