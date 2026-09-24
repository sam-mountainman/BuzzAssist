import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { candidateEntrypointHrefs, isDirectCli, preservesSymlinksMain } from "../lib/cliEntrypoint.mjs";

test("ESM CLI entrypoint comparison handles spaces through URL encoding", () => {
  const path = resolve("fixture with spaces", "command.mjs");
  assert.equal(isDirectCli(pathToFileURL(path).href, path), true);
  assert.equal(isDirectCli(pathToFileURL(path).href, `${path}.other`), false);
  assert.equal(isDirectCli(pathToFileURL(path).href, ""), false);
});

test("percent-encoded module URLs (spaces, Japanese) still match the native argv path", () => {
  const nativePath = resolve("bz テスト dir", "a b", "harness-registry.mjs");
  const href = pathToFileURL(nativePath).href;
  // pathToFileURL must have encoded the space and the non-ASCII characters;
  // the legacy `new URL(...).pathname` comparison broke exactly here.
  assert.match(href, /%20/u);
  assert.doesNotMatch(href, /テスト/u);
  assert.equal(isDirectCli(href, nativePath), true);
  assert.equal(isDirectCli(href, resolve("bz テスト dir", "a b", "other.mjs")), false);
});

test("windows-style drive URLs are compared through URL form, not raw pathname", () => {
  // On Windows import.meta.url looks like file:///C:/Users/example/a%20b/cli.mjs
  // (synthetic placeholder user; the public-surface audit rejects real-looking
  // user directories). A raw `.pathname` yields "/C:/Users/example/a%20b/cli.mjs",
  // which never equals the resolved argv path. Comparing href-to-href avoids
  // that whole class.
  const href = "file:///C:/Users/example/a%20b/cli.mjs";
  assert.equal(new URL(href).href, href);
  if (process.platform === "win32") {
    assert.equal(isDirectCli(href, "C:\\Users\\example\\a b\\cli.mjs"), true);
  }
});

test("harness CLIs copied into a directory with spaces and Japanese run their main() when invoked directly", async () => {
  const { mkdtemp, mkdir, cp, rm, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { join } = await import("node:path");
  const run = promisify(execFile);
  // realpath: on macOS tmpdir() is /var/... -> /private/var/... and Node
  // realpaths the main module (import.meta.url) while argv[1] stays as typed.
  // isDirectCli does not realpath argv, so a symlinked tmp root would fail
  // for a reason unrelated to the space/Japanese encoding under test here.
  const root = await realpath(await mkdtemp(join(tmpdir(), "bz テスト ")));
  try {
    const scripts = [
      "harness-registry.mjs",
      "harness-parallel-run.mjs",
      "harness-parallel-agents.mjs",
      "sanitize-agent-session-secrets.mjs",
    ];
    await mkdir(join(root, "scripts"), { recursive: true });
    await mkdir(join(root, "config"), { recursive: true });
    await cp(resolve("lib", "cliEntrypoint.mjs"), join(root, "lib", "cliEntrypoint.mjs"));
    // harness-parallel-agents は子へ「学習を書かない」印を渡すために読む（2026-09-24）。
    // 複製し忘れると import で落ち、main() に届く前に exit 1 になる。
    await cp(resolve("lib", "harnessLearningGuard.mjs"), join(root, "lib", "harnessLearningGuard.mjs"));
    await cp(resolve("config", "harnesses"), join(root, "config", "harnesses"), { recursive: true });
    for (const name of scripts) await cp(resolve("scripts", name), join(root, "scripts", name));

    // registry: main() runs and lists harnesses from the copied config dir (REPO_ROOT via fileURLToPath).
    const registry = await run(process.execPath, [join(root, "scripts", "harness-registry.mjs"), "list"]);
    assert.match(registry.stdout, /koya-manga-video/u);

    // parallel-run / parallel-agents: without --plan/--tasks main() prints usage and exits 2.
    for (const name of ["harness-parallel-run.mjs", "harness-parallel-agents.mjs"]) {
      const result = await run(process.execPath, [join(root, "scripts", name)]).catch((error) => error);
      assert.equal(result.code, 2, `${name} should reach main() and exit 2`);
    }

    // sanitizer: zero targets is reported through main() as exit code 3.
    const sanitize = await run(process.execPath, [join(root, "scripts", "sanitize-agent-session-secrets.mjs")]).catch((error) => error);
    assert.equal(sanitize.code, 3);
    assert.match(sanitize.stdout, /agent-session-secret-sanitizer-v1/u);

    // Importing (not invoking) the same file must not run main().
    const imported = await run(process.execPath, [
      "--input-type=module",
      "-e",
      `import(${JSON.stringify(pathToFileURL(join(root, "scripts", "harness-registry.mjs")).href)}).then((m) => process.stdout.write(typeof m.loadHarnesses));`,
    ]);
    assert.equal(imported.stdout, "function");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlinked argv path (macOS /tmp -> /private/tmp) still matches the realpath'd module URL", async () => {
  const { mkdtemp, mkdir, rm, realpath, symlink, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, dirname, basename } = await import("node:path");
  // Build our own symlink so the test does not depend on tmpdir() being one.
  const real = await realpath(await mkdtemp(join(tmpdir(), "bz-real-")));
  const link = join(dirname(real), `${basename(real)}-link`);
  await symlink(real, link, "dir");
  try {
    await mkdir(join(real, "scripts"), { recursive: true });
    const file = join(real, "scripts", "cli.mjs");
    await writeFile(file, "export {};\n");
    const viaLink = join(link, "scripts", "cli.mjs");
    const moduleHref = pathToFileURL(file).href; // what Node puts in import.meta.url
    assert.notEqual(pathToFileURL(viaLink).href, moduleHref, "the symlink must actually differ from the realpath");
    assert.equal(isDirectCli(moduleHref, viaLink), true, "symlink argv must be recognized as the main module");
    assert.equal(isDirectCli(moduleHref, file), true, "realpath argv keeps matching");
    assert.equal(isDirectCli(pathToFileURL(join(real, "scripts", "other.mjs")).href, viaLink), false);
    // --preserve-symlinks-main: Node keeps the as-typed URL, so realpath is not consulted.
    assert.deepEqual(candidateEntrypointHrefs(viaLink, { preserveSymlinks: true }), [pathToFileURL(viaLink).href]);
    assert.equal(isDirectCli(moduleHref, viaLink, { preserveSymlinks: true }), false);
    assert.equal(isDirectCli(pathToFileURL(viaLink).href, viaLink, { preserveSymlinks: true }), true);
    // Both hrefs are candidates by default (as-typed first, realpath second).
    assert.deepEqual(candidateEntrypointHrefs(viaLink), [pathToFileURL(viaLink).href, moduleHref]);
  } finally {
    await rm(link, { force: true });
    await rm(real, { recursive: true, force: true });
  }
});

test("a missing argv path falls back to the as-typed comparison instead of throwing", () => {
  const ghost = resolve("definitely", "not", "here", "cli.mjs");
  assert.deepEqual(candidateEntrypointHrefs(ghost), [pathToFileURL(ghost).href]);
  assert.equal(isDirectCli(pathToFileURL(ghost).href, ghost), true);
});

test("--preserve-symlinks-main is read from execArgv and NODE_OPTIONS", () => {
  assert.equal(preservesSymlinksMain([], ""), false);
  assert.equal(preservesSymlinksMain(["--preserve-symlinks-main"], ""), true);
  assert.equal(preservesSymlinksMain(["--preserve-symlinks"], ""), false);
  assert.equal(preservesSymlinksMain([], "--max-old-space-size=100 --preserve-symlinks-main"), true);
  assert.equal(preservesSymlinksMain([], undefined), false);
});

test("real harness CLIs launched through a symlinked path (not realpath'd) run their main()", async () => {
  const { mkdtemp, mkdir, cp, rm, realpath, symlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { join, dirname, basename } = await import("node:path");
  const run = promisify(execFile);
  const real = await realpath(await mkdtemp(join(tmpdir(), "bz-symlink-cli-")));
  const link = join(dirname(real), `${basename(real)}-link`);
  await symlink(real, link, "dir");
  try {
    const scripts = ["harness-registry.mjs", "harness-parallel-run.mjs", "sanitize-agent-session-secrets.mjs"];
    await mkdir(join(real, "scripts"), { recursive: true });
    await mkdir(join(real, "config"), { recursive: true });
    await cp(resolve("lib", "cliEntrypoint.mjs"), join(real, "lib", "cliEntrypoint.mjs"));
    await cp(resolve("config", "harnesses"), join(real, "config", "harnesses"), { recursive: true });
    for (const name of scripts) await cp(resolve("scripts", name), join(real, "scripts", name));

    // argv[1] goes through the symlink; Node's import.meta.url is the realpath.
    const registry = await run(process.execPath, [join(link, "scripts", "harness-registry.mjs"), "list"]);
    assert.match(registry.stdout, /koya-manga-video/u, "main() must run when argv is a symlinked path");

    const parallel = await run(process.execPath, [join(link, "scripts", "harness-parallel-run.mjs")]).catch((error) => error);
    assert.equal(parallel.code, 2, "harness-parallel-run should reach main() and exit 2 (usage)");

    const sanitize = await run(process.execPath, [join(link, "scripts", "sanitize-agent-session-secrets.mjs")]).catch((error) => error);
    assert.equal(sanitize.code, 3, "sanitizer should reach main() and report zero targets");

    // With --preserve-symlinks-main Node keeps the as-typed URL, so it must still match.
    const preserved = await run(process.execPath, ["--preserve-symlinks-main", join(link, "scripts", "harness-registry.mjs"), "list"]);
    assert.match(preserved.stdout, /koya-manga-video/u);

    // Importing (not invoking) through the symlink must not run main().
    const imported = await run(process.execPath, [
      "--input-type=module",
      "-e",
      `import(${JSON.stringify(pathToFileURL(join(link, "scripts", "harness-registry.mjs")).href)}).then((m) => process.stdout.write(typeof m.loadHarnesses));`,
    ]);
    assert.equal(imported.stdout, "function");
  } finally {
    await rm(link, { force: true });
    await rm(real, { recursive: true, force: true });
  }
});
