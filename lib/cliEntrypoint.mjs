import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Cross-platform ESM main-module check.
 *
 * Building `file://${process.argv[1]}` by hand breaks on Windows drive letters
 * and on paths containing spaces or URL-sensitive characters.  Converting the
 * normalized native path through pathToFileURL gives Node the same URL form as
 * import.meta.url on macOS, Windows, and Linux.
 *
 * Node resolves the main module through realpath before it builds
 * import.meta.url, while argv[1] stays exactly as typed.  On macOS `/tmp` and
 * `/var/folders/...` are symlinks into `/private/...`, so `node /tmp/x/cli.mjs`
 * compared argv-as-typed against a realpath'd module URL, never matched, and
 * the CLI exited 0 without running main().  Both the as-typed and the
 * realpath'd href are therefore accepted.  When Node was started with
 * `--preserve-symlinks-main` it does NOT realpath the main module, so the
 * as-typed form is the one that matches and realpath is skipped.
 */
export function preservesSymlinksMain(execArgv = process.execArgv, nodeOptions = process.env.NODE_OPTIONS) {
  const flag = "--preserve-symlinks-main";
  if (Array.isArray(execArgv) && execArgv.some((arg) => arg === flag || arg.startsWith(`${flag}=`))) return true;
  if (typeof nodeOptions === "string" && nodeOptions.split(/\s+/u).some((arg) => arg === flag || arg.startsWith(`${flag}=`))) return true;
  return false;
}

export function candidateEntrypointHrefs(argvPath, { preserveSymlinks = preservesSymlinksMain() } = {}) {
  if (typeof argvPath !== "string" || !argvPath.trim()) return [];
  const resolved = resolve(argvPath);
  const hrefs = [pathToFileURL(resolved).href];
  if (!preserveSymlinks) {
    try {
      const real = realpathSync.native(resolved);
      const realHref = pathToFileURL(real).href;
      if (!hrefs.includes(realHref)) hrefs.push(realHref);
    } catch {
      // Missing file, permission error, or a platform without realpath.native
      // semantics: fall back to the as-typed comparison only.
    }
  }
  return hrefs;
}

export function isDirectCli(moduleUrl, argvPath = process.argv[1], options = {}) {
  const hrefs = candidateEntrypointHrefs(argvPath, options);
  if (hrefs.length === 0) return false;
  const moduleHref = new URL(moduleUrl).href;
  return hrefs.includes(moduleHref);
}
