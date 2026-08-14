import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function sha256File(filePath) {
  return sha256Buffer(await readFile(resolve(filePath)));
}

async function fileInfo(filePath) {
  const absolutePath = resolve(filePath);
  const details = await stat(absolutePath);
  if (!details.isFile()) throw new Error(`Evidence path is not a file: ${absolutePath}`);
  return { absolutePath, size: details.size };
}

export async function verifyMangaEvidenceRows(rows = [], { required = true } = {}) {
  if (!Array.isArray(rows) || (required && rows.length === 0)) {
    throw new Error("At least one evidence file is required.");
  }
  const verified = [];
  for (const [index, row] of rows.entries()) {
    const path = nonEmptyString(row?.path);
    const expectedSha256 = nonEmptyString(row?.sha256).toLowerCase();
    const note = nonEmptyString(row?.note);
    if (!path || !/^[a-f0-9]{64}$/u.test(expectedSha256) || note.length < 4) {
      throw new Error(`Evidence row ${index + 1} requires path, SHA-256, and a concrete note.`);
    }
    const { absolutePath, size } = await fileInfo(path);
    const actualSha256 = await sha256File(absolutePath);
    if (actualSha256 !== expectedSha256) {
      throw new Error(`Evidence digest mismatch: ${absolutePath}`);
    }
    verified.push({ path: absolutePath, sha256: actualSha256, size, note });
  }
  return verified;
}

function collectPathStrings(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) collectPathStrings(entry, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && /(?:path|file|output|source|video|image|frame|audio)/iu.test(key)) {
      if (entry.startsWith("/")) output.add(resolve(entry));
    } else {
      collectPathStrings(entry, output);
    }
  }
  return output;
}

async function referencedFilesFromJson(filePath) {
  try {
    const source = JSON.parse(await readFile(filePath, "utf8"));
    const referenced = [...collectPathStrings(source)];
    const files = [];
    for (const candidate of referenced) {
      try {
        const details = await stat(candidate);
        if (details.isFile()) files.push(candidate);
      } catch {}
    }
    return files;
  } catch {
    return [];
  }
}

async function filesBelow(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesBelow(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

function merkleRoot(leaves) {
  if (leaves.length === 0) return sha256Buffer("");
  let level = leaves.map((leaf) => Buffer.from(leaf, "hex"));
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] || left;
      next.push(Buffer.from(sha256Buffer(Buffer.concat([left, right])), "hex"));
    }
    level = next;
  }
  return level[0].toString("hex");
}

export async function createMangaEvidenceManifest({
  episodeId,
  projectDir,
  artifacts = [],
  excludePaths = [],
  includeReferencedJsonFiles = true,
  includeDirectories = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const root = resolve(projectDir || process.cwd());
  const excluded = new Set((excludePaths || []).filter(Boolean).map((entry) => resolve(entry)));
  const paths = new Set((artifacts || []).filter(Boolean).map((entry) => resolve(entry)));
  for (const directory of includeDirectories || []) {
    try {
      for (const path of await filesBelow(resolve(directory))) paths.add(path);
    } catch {}
  }
  if (includeReferencedJsonFiles) {
    for (const path of [...paths]) {
      if (path.toLowerCase().endsWith(".json")) {
        for (const referenced of await referencedFilesFromJson(path)) paths.add(referenced);
      }
    }
  }
  for (const path of excluded) paths.delete(path);
  const entries = [];
  for (const path of [...paths].sort()) {
    try {
      const { absolutePath, size } = await fileInfo(path);
      const sha256 = await sha256File(absolutePath);
      const relativePath = relative(root, absolutePath).split("\\").join("/");
      entries.push({
        path: absolutePath,
        relativePath: relativePath && !relativePath.startsWith("../") ? relativePath : absolutePath,
        sha256,
        size,
      });
    } catch {}
  }
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const leaves = entries.map((entry) => sha256Buffer(`${entry.relativePath}\0${entry.sha256}\0${entry.size}`));
  return {
    version: "koya-evidence-merkle-v1",
    episodeId: nonEmptyString(episodeId),
    entryCount: entries.length,
    entries,
    merkleRoot: merkleRoot(leaves),
    generatedAt: new Date(generatedAt).toISOString(),
  };
}

export async function verifyMangaEvidenceManifest(manifest = {}) {
  const failures = [];
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  if (manifest.entryCount !== entries.length) failures.push("entry-count-mismatch");
  const seenPaths = new Set();
  const expectedOrder = entries.map((entry) => entry.relativePath).sort((left, right) => left.localeCompare(right));
  if (entries.some((entry, index) => entry.relativePath !== expectedOrder[index])) failures.push("entry-order-invalid");
  for (const entry of entries) {
    if (!nonEmptyString(entry.path) || !nonEmptyString(entry.relativePath) || !/^[a-f0-9]{64}$/u.test(entry.sha256 || "")) {
      failures.push(`invalid-entry:${entry.relativePath || entry.path || "unknown"}`);
      continue;
    }
    if (seenPaths.has(resolve(entry.path))) failures.push(`duplicate-path:${entry.relativePath || entry.path}`);
    seenPaths.add(resolve(entry.path));
    try {
      const details = await stat(resolve(entry.path));
      if (!details.isFile()) {
        failures.push(`not-a-file:${entry.relativePath || entry.path}`);
        continue;
      }
      if (details.size !== entry.size) failures.push(`size-mismatch:${entry.relativePath || entry.path}`);
      const actual = await sha256File(entry.path);
      if (actual !== entry.sha256) failures.push(`digest-mismatch:${entry.relativePath || entry.path}`);
    } catch {
      failures.push(`missing:${entry.relativePath || entry.path}`);
    }
  }
  const leaves = entries.map((entry) => sha256Buffer(`${entry.relativePath}\0${entry.sha256}\0${entry.size}`));
  if (merkleRoot(leaves) !== manifest.merkleRoot) failures.push("merkle-root-mismatch");
  return { pass: failures.length === 0, failures, entryCount: entries.length };
}
