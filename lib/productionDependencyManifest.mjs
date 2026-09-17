// Production dependency identity for durable Video Harness Jobs.
//
// Hashing only the declared entrypoint is not sufficient: an unchanged
// entrypoint can import a changed helper immediately after doctor passes.  The
// durable Job therefore binds a deterministic tree of executable/configuration
// inputs both for the shared BuzzAssist runtime and for the selected deployed
// harness.  Generated output, caches and tests are deliberately excluded.

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const PRODUCTION_DEPENDENCY_TREE_VERSION = "buzzassist-production-dependency-tree-v1";

const FIELD_SEPARATOR = "\u001f";
const RUNTIME_ROOTS = Object.freeze(["lib", "scripts"]);
const TOP_LEVEL_FILES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
const INCLUDED_EXTENSIONS = new Set([
  ".cjs", ".cmd", ".js", ".json", ".jsx", ".md", ".mjs", ".ps1",
  ".py", ".sh", ".toml", ".ts", ".tsx", ".txt", ".wasm", ".xml",
  ".yaml", ".yml",
]);
const EXCLUDED_DIRECTORIES = new Set([
  ".agent-attachments", ".cache", ".git", ".next", ".turbo",
  "build", "canvas", "coverage", "dist", "node_modules", "test", "tests",
]);

function canonicalRelative(root, path) {
  const value = relative(root, path);
  if (!value || value === "." || isAbsolute(value)
    || value.startsWith(`..${sep}`) || value === "..") {
    throw new Error(`Production dependency path escaped its root: ${path}`);
  }
  return value.split(sep).join("/");
}

function stableReadRegularFile(root, path) {
  const before = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`Production dependency must be a regular non-symlink file: ${path}`);
  }
  const bytes = readFileSync(path);
  const after = lstatSync(path, { bigint: true });
  if (!after.isFile() || after.isSymbolicLink()
    || before.dev !== after.dev || before.ino !== after.ino
    || before.size !== after.size || before.mtimeNs !== after.mtimeNs
    || BigInt(bytes.length) !== after.size) {
    throw new Error(`Production dependency changed while it was being fingerprinted: ${path}`);
  }
  canonicalRelative(root, path);
  return bytes;
}

function shouldIncludeFile(path) {
  return TOP_LEVEL_FILES.has(basename(path)) || INCLUDED_EXTENSIONS.has(extname(path).toLowerCase());
}

function collectTreeFiles(root, start, output) {
  const startInfo = lstatSync(start);
  if (startInfo.isSymbolicLink()) {
    throw new Error(`Production dependency tree contains a symlink: ${start}`);
  }
  if (startInfo.isFile()) {
    if (shouldIncludeFile(start)) output.push(start);
    return;
  }
  if (!startInfo.isDirectory()) return;
  const entries = readdirSync(start, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const path = join(start, entry.name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      throw new Error(`Production dependency tree contains a symlink: ${path}`);
    }
    if (info.isDirectory()) collectTreeFiles(root, path, output);
    else if (info.isFile() && shouldIncludeFile(path)) output.push(path);
  }
}

/**
 * Return a path-free manifest summary suitable for a Job/receipt.  `runtime`
 * scans only shared executable roots; `deployment` scans the selected deployed
 * harness root so transitively imported helpers are covered as well.
 */
export function snapshotProductionDependencyTree(rootInput, { scope = "deployment" } = {}) {
  const requestedRoot = resolve(rootInput || "");
  if (!rootInput || !existsSync(requestedRoot)) throw new Error(`Production dependency root does not exist: ${rootInput || "(empty)"}`);
  const rootInfo = lstatSync(requestedRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`Production dependency root must be a regular non-symlink directory: ${requestedRoot}`);
  }
  // macOS commonly exposes /var through a canonical /private/var ancestor.  A
  // final path component symlink is forbidden above, but canonicalizing its
  // ancestors keeps containment/digest ordering identical across callers.
  const root = realpathSync(requestedRoot);
  if (!["runtime", "deployment"].includes(scope)) throw new Error(`Unknown production dependency scope: ${scope}`);

  const files = [];
  if (scope === "runtime") {
    for (const relativeRoot of RUNTIME_ROOTS) {
      const start = join(root, relativeRoot);
      if (existsSync(start)) collectTreeFiles(root, start, files);
    }
    for (const fileName of TOP_LEVEL_FILES) {
      const path = join(root, fileName);
      if (existsSync(path)) collectTreeFiles(root, path, files);
    }
  } else {
    collectTreeFiles(root, root, files);
  }
  files.sort((left, right) => canonicalRelative(root, left).localeCompare(canonicalRelative(root, right)));
  if (files.length === 0) throw new Error(`Production dependency tree is empty: ${root}`);

  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(canonicalRelative(root, path));
    hash.update(FIELD_SEPARATOR);
    hash.update(stableReadRegularFile(root, path));
    hash.update(FIELD_SEPARATOR);
  }
  return {
    version: PRODUCTION_DEPENDENCY_TREE_VERSION,
    scope,
    digest: hash.digest("hex"),
    fileCount: files.length,
  };
}

export function productionDependencyIdentity({ runtimeRoot, deploymentRoot } = {}) {
  const runtimePath = resolve(runtimeRoot || "");
  const deploymentPath = resolve(deploymentRoot || "");
  const runtime = snapshotProductionDependencyTree(runtimePath, { scope: "runtime" });
  const deployment = deploymentPath === runtimePath
    ? { ...runtime, scope: "deployment" }
    : snapshotProductionDependencyTree(deploymentPath, { scope: "deployment" });
  return {
    version: PRODUCTION_DEPENDENCY_TREE_VERSION,
    runtime,
    deployment,
  };
}
