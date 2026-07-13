import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}
function localPathFromValue(value) {
  const raw = nonEmptyString(value);
  if (!raw) return "";
  if (/^file:/i.test(raw)) {
    try {
      return fileURLToPath(new URL(raw));
    } catch {
      return "";
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return "";
  return raw;
}

function firstLocalPath(values = []) {
  for (const value of values) {
    const localPath = localPathFromValue(value);
    if (localPath) return resolve(localPath);
  }
  return "";
}

// Request metadata is intentionally loose in MCP. Codex and Claude Code may
// attach their active workspace under different keys, so accept the common
// spellings while keeping MCP roots as the standards-based fallback.
export function projectDirFromRequestMeta(meta = {}) {
  if (!meta || typeof meta !== "object") return "";
  return firstLocalPath([
    meta.projectDir,
    meta.project_dir,
    meta.workspaceRoot,
    meta.workspace_root,
    meta.cwd,
    meta["io.codex.projectDir"],
    meta["io.codex.cwd"],
    meta["io.claude.projectDir"],
    meta.workspace?.root,
    meta.workspace?.uri,
  ]);
}

export function projectDirFromRoots(roots = []) {
  if (!Array.isArray(roots)) return "";
  return firstLocalPath(roots.flatMap((root) => [root?.uri, root?.path]));
}

export function applyProjectContext(args = {}, { requestMeta = {}, roots = [] } = {}) {
  const input = args && typeof args === "object" ? { ...args } : {};
  // Explicit caller choices always win. canvasDir may intentionally live
  // outside <project>/canvas, so do not infer a competing projectDir for it.
  if (nonEmptyString(input.projectDir) || nonEmptyString(input.canvasDir)) return input;

  const projectDir = projectDirFromRequestMeta(requestMeta) || projectDirFromRoots(roots);
  return projectDir ? { ...input, projectDir } : input;
}
