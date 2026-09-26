import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";

import {
  MCP_RUNTIME_DEPENDENCIES,
  VERIFY_TEMP_PREFIX,
  importMcpClientSdk,
  prepareVerificationRuntime,
  releaseSourceDir,
  resolveVerificationDependencies,
  sweepStaleVerifyTemps,
} from "../lib/pluginRuntimeDependencies.mjs";

// 導入後の検証（scripts/verify-plugin-runtime.mjs）を、依存の無い置き場で確かめる。
//
// 2026-09-26、0.1.27 の自動更新が 0.1.29 を入れようとして、setup が作り直した依存の無い置き場
// （~/plugins/buzzassist/plugin）でこの script を起動し、先頭の SDK の静的 import で
// ERR_MODULE_NOT_FOUND になって巻き戻った。ここでは本物の HOME・~/plugins・ホストの設定には
// 触らず、一時フォルダに「setup の staging 検査が通る置き場」と「同じ版の Release の展開先」を作る。

const ROOT = join(import.meta.dirname, "..");
const ROOT_NODE_MODULES = join(ROOT, "node_modules");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const DEPS_READY = MCP_RUNTIME_DEPENDENCIES.every((name) => existsSync(join(ROOT_NODE_MODULES, ...name.split("/"))));
const NEEDS_DEPS = DEPS_READY ? false : "リポジトリに npm ci で依存を入れると走る（MCP を実際に起動して確かめるため）";
// 古い update-current.mjs が verify-plugin-runtime.mjs に与える上限。
const OLD_UPDATER_VERIFY_TIMEOUT_MS = 60_000;

function linkDirectory(target, linkPath) {
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

async function stagePlugin(pluginRoot) {
  // setup-agents の refreshManagedPluginSource と同じ一覧・同じ除外で、依存も canvas も無い置き場を作る
  // （正本スキルの写しと .mcp.json の書き換えは MCP の起動に関わらないので省く）。
  const {
    PLUGIN_SOURCE_DIRECTORIES,
    PLUGIN_SOURCE_FILES,
    isChannelPackPath,
    stagePluginHooks,
    verifyStagedPluginContents,
  } = await import("../scripts/setup-agents.mjs");
  mkdirSync(pluginRoot, { recursive: true });
  for (const name of [...PLUGIN_SOURCE_DIRECTORIES, ...PLUGIN_SOURCE_FILES]) {
    if (!existsSync(join(ROOT, name))) continue;
    cpSync(join(ROOT, name), join(pluginRoot, name), {
      recursive: true,
      dereference: false,
      filter: (source) => !isChannelPackPath(source),
    });
  }
  await stagePluginHooks(ROOT, pluginRoot);
  const staged = await verifyStagedPluginContents(pluginRoot);
  assert.equal(staged.ok, true, "setup の staging 検査が通る置き場を作れていない");
}

// 自動更新が Release を展開し npm ci で依存を入れた場所を真似る（依存はリポジトリのものへつなぐ）。
function makeRelease(homeDir) {
  const sourceDir = releaseSourceDir({ homeDir, version: VERSION });
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, "package.json"), JSON.stringify({ name: "buzzassist-canvas-mcp", version: VERSION }));
  linkDirectory(ROOT_NODE_MODULES, join(sourceDir, "node_modules"));
  return sourceDir;
}

// 置き場の中身を、リンクを辿らずに全部書き出す（パスは node:path の relative で OS に依らない形に）。
function snapshot(root) {
  const entries = {};
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const key = relative(root, absolute).split(/[\\/]/u).join("/");
      const details = lstatSync(absolute);
      if (details.isSymbolicLink()) entries[key] = `link:${readlinkSync(absolute)}`;
      else if (details.isDirectory()) {
        entries[key] = "dir";
        visit(absolute);
      } else entries[key] = `file:${createHash("sha256").update(readFileSync(absolute)).digest("hex")}:${details.mtimeMs}`;
    }
  };
  visit(root);
  return entries;
}

function leftoverVerifyTemps(baseDir) {
  return existsSync(baseDir) ? readdirSync(baseDir).filter((name) => name.startsWith(VERIFY_TEMP_PREFIX)) : [];
}

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "verify-plugin-runtime-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const homeDir = join(base, "home");
  const pluginRoot = join(homeDir, "plugins", "buzzassist", "plugin");
  const projectDir = join(base, "project");
  const tempBase = join(base, "tmp");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(tempBase, { recursive: true });
  return { base, homeDir, pluginRoot, projectDir, tempBase };
}

// 古い update-current.mjs と同じ呼び方（置き場の中の script を、--deps-root なしで）で走らせる。
function runVerifier({ homeDir, pluginRoot, projectDir, tempBase }, { args = [], env = {} } = {}) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [
    join(pluginRoot, "scripts", "verify-plugin-runtime.mjs"),
    "--plugin-root", pluginRoot,
    "--project-dir", projectDir,
    "--canvas-dir", join(projectDir, "canvas"),
    ...args,
  ], {
    cwd: pluginRoot,
    encoding: "utf8",
    timeout: OLD_UPDATER_VERIFY_TIMEOUT_MS,
    env: {
      ...process.env,
      BUZZASSIST_SETUP_HOME: homeDir,
      EXCALIDRAW_NO_AUTO_OPEN: "1",
      // 写しの置き先（os.tmpdir()）を試験の中へ向け、消し残しを数えられるようにする。
      TMPDIR: tempBase,
      TEMP: tempBase,
      TMP: tempBase,
      ...env,
    },
  });
  return { ...result, elapsedMs: Date.now() - startedAt };
}

test("依存の無い置き場は、写しに同じ版の Release の依存をつないで確かめ、置き場にも一時フォルダにも何も残さない", { skip: NEEDS_DEPS, timeout: 120_000 }, async (t) => {
  const paths = fixture(t);
  await stagePlugin(paths.pluginRoot);
  const releaseDir = makeRelease(paths.homeDir);
  const before = snapshot(paths.pluginRoot);

  const result = runVerifier(paths);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ""}`);
  assert.match(result.stdout, /BUZZASSIST_MCP_VERIFY=ok/u);
  assert.match(result.stdout, /BUZZASSIST_MCP_VERIFY_DEPS=link/u);
  assert.ok(result.elapsedMs < OLD_UPDATER_VERIFY_TIMEOUT_MS, `古い更新の仕組みの上限に収まっていない: ${result.elapsedMs}ms`);

  assert.equal(existsSync(join(paths.pluginRoot, "node_modules")), false, "置き場に node_modules を作った");
  assert.deepEqual(snapshot(paths.pluginRoot), before, "置き場のファイルが変わった");
  assert.deepEqual(leftoverVerifyTemps(paths.tempBase), [], "検証用の一時フォルダが残った");
  assert.ok(
    existsSync(join(releaseDir, "node_modules", "@modelcontextprotocol", "sdk", "package.json")),
    "写しを消すときに Release の展開先の依存まで消した",
  );
});

test("新しい update-current が --deps-root で渡した Release の展開先を使う（HOME の下に無くてもよい）", { skip: NEEDS_DEPS, timeout: 120_000 }, async (t) => {
  const paths = fixture(t);
  await stagePlugin(paths.pluginRoot);
  const elsewhere = join(paths.base, "elsewhere", "source");
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, "package.json"), JSON.stringify({ name: "buzzassist-canvas-mcp", version: VERSION }));
  linkDirectory(ROOT_NODE_MODULES, join(elsewhere, "node_modules"));
  const before = snapshot(paths.pluginRoot);

  const result = runVerifier(paths, { args: ["--deps-root", elsewhere] });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /BUZZASSIST_MCP_VERIFY_DEPS=link/u);
  assert.match(result.stdout, /--deps-root/u);
  assert.deepEqual(snapshot(paths.pluginRoot), before);
  assert.deepEqual(leftoverVerifyTemps(paths.tempBase), []);
});

test("依存が置き場にある従来の形では、今までどおり置き場で確かめ、写しを作らない", { skip: NEEDS_DEPS, timeout: 120_000 }, async (t) => {
  const paths = fixture(t);
  await stagePlugin(paths.pluginRoot);
  linkDirectory(ROOT_NODE_MODULES, join(paths.pluginRoot, "node_modules"));

  const result = runVerifier(paths);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /BUZZASSIST_MCP_VERIFY=ok/u);
  assert.match(result.stdout, /BUZZASSIST_MCP_VERIFY_DEPS=in-place/u);
  assert.deepEqual(leftoverVerifyTemps(paths.tempBase), []);
});

test("Release の展開先が無ければ写しの中の npm install にまわり、理由をログに出し、失敗しても一時フォルダを残さない", { timeout: 120_000 }, async (t) => {
  const paths = fixture(t);
  await stagePlugin(paths.pluginRoot);
  const before = snapshot(paths.pluginRoot);
  const npmCache = join(paths.base, "npm-cache");
  mkdirSync(npmCache, { recursive: true });

  // ネットワークに出さない: offline と空のキャッシュで、npm install は取得の手前で失敗する。
  const result = runVerifier(paths, {
    env: {
      npm_config_offline: "true",
      npm_config_cache: npmCache,
      npm_config_registry: "http://127.0.0.1:9/",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    },
  });
  assert.notEqual(result.status, 0, "依存を用意できないのに通った");
  assert.match(result.stdout, /npm install します/u);
  assert.match(result.stdout, /Release の展開先 .* に node_modules が無い/u, "install にまわった理由が出ていない");
  assert.match(`${result.stdout}\n${result.stderr}`, /npm install が(?:失敗した|.*終わらなかった)/u);
  assert.doesNotMatch(result.stdout, /BUZZASSIST_MCP_VERIFY=ok/u);
  assert.equal(existsSync(join(paths.pluginRoot, "node_modules")), false, "置き場に node_modules を作った");
  assert.deepEqual(snapshot(paths.pluginRoot), before, "置き場のファイルが変わった");
  assert.deepEqual(leftoverVerifyTemps(paths.tempBase), [], "失敗したのに一時フォルダが残った");
});

test("古い更新の仕組みが時間切れで SIGTERM を送っても、npm install を止めて一時フォルダを消してから終わる", {
  skip: process.platform === "win32" ? "Windows の kill は TerminateProcess で後片付けの処理が走らない（消し残しは次の検証が掃除する）" : false,
  timeout: 60_000,
}, async (t) => {
  const paths = fixture(t);
  await stagePlugin(paths.pluginRoot);
  const before = snapshot(paths.pluginRoot);
  // 返事をしない registry（手元の TCP）で、npm install を取得の途中に止めておく。外へは出ない。
  const sockets = [];
  const server = createServer((socket) => sockets.push(socket));
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  const npmCache = join(paths.base, "npm-cache");
  mkdirSync(npmCache, { recursive: true });
  const child = spawn(process.execPath, [
    join(paths.pluginRoot, "scripts", "verify-plugin-runtime.mjs"),
    "--plugin-root", paths.pluginRoot,
    "--project-dir", paths.projectDir,
  ], {
    cwd: paths.pluginRoot,
    env: {
      ...process.env,
      BUZZASSIST_SETUP_HOME: paths.homeDir,
      TMPDIR: paths.tempBase,
      npm_config_cache: npmCache,
      npm_config_registry: `http://127.0.0.1:${server.address().port}/`,
      npm_config_fetch_retries: "0",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  const exited = new Promise((resolveExit) => child.on("close", (code, signal) => resolveExit({ code, signal })));
  await new Promise((resolveStarted, rejectStarted) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("npm install します")) resolveStarted();
    });
    child.on("close", () => rejectStarted(new Error(`install の経路に入る前に終わった:\n${stdout}`)));
  });
  // npm が registry へ取りに行き、写しの中で止まっている間に、古い update-current と同じく SIGTERM を送る。
  await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  assert.equal(leftoverVerifyTemps(paths.tempBase).length, 1, "install の最中の写しが無い");
  child.kill("SIGTERM");
  const { code } = await exited;
  assert.equal(code, 143, stdout);
  assert.match(stdout, /SIGTERM を受けたので、検証用の一時フォルダ .* を消して終わります/u);
  assert.deepEqual(leftoverVerifyTemps(paths.tempBase), [], "SIGTERM で止めたのに一時フォルダが残った");
  assert.deepEqual(snapshot(paths.pluginRoot), before, "置き場のファイルが変わった");
});

test("依存の在りかは、置き場 → --deps-root → 同じ版の Release の展開先の順に、版と必須の依存を見て決める", () => {
  // node_modules の有無だけを差し替え、版の読み取りは実ファイルで試す。
  const base = mkdtempSync(join(tmpdir(), "verify-resolution-"));
  try {
    const plugin = join(base, "plugin");
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(plugin, "package.json"), JSON.stringify({ version: "1.2.3" }));
    const release = releaseSourceDir({ homeDir: base, version: "1.2.3" });
    mkdirSync(release, { recursive: true });
    writeFileSync(join(release, "package.json"), JSON.stringify({ version: "1.2.3" }));
    const allDeps = (root) => (target) => target === join(root, "node_modules")
      || MCP_RUNTIME_DEPENDENCIES.some((name) => target === join(root, "node_modules", ...name.split("/")));

    assert.equal(resolveVerificationDependencies({ pluginRoot: plugin, homeDir: base, exists: allDeps(plugin) }).mode, "in-place");

    const linked = resolveVerificationDependencies({ pluginRoot: plugin, homeDir: base, exists: allDeps(release) });
    assert.equal(linked.mode, "link");
    assert.equal(linked.dependencyRoot, release);

    const other = join(base, "other");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "package.json"), JSON.stringify({ version: "1.2.3" }));
    const explicit = resolveVerificationDependencies({ pluginRoot: plugin, depsRoot: other, homeDir: base, exists: allDeps(other) });
    assert.equal(explicit.mode, "link");
    assert.equal(explicit.dependencyRoot, other);

    // 版が違う展開先の依存は使わない（別の版の依存で通っても、入れた版を確かめたことにならない）。
    writeFileSync(join(release, "package.json"), JSON.stringify({ version: "1.2.2" }));
    const mismatched = resolveVerificationDependencies({ pluginRoot: plugin, homeDir: base, exists: allDeps(release) });
    assert.equal(mismatched.mode, "install");
    assert.ok(mismatched.reasons.some((reason) => /版（1\.2\.2）が置き場の版（1\.2\.3）と違う/u.test(reason)), mismatched.reasons.join("\n"));

    // 必須の依存が1つでも欠けていれば使わない。
    writeFileSync(join(release, "package.json"), JSON.stringify({ version: "1.2.3" }));
    const partial = resolveVerificationDependencies({
      pluginRoot: plugin,
      homeDir: base,
      exists: (target) => allDeps(release)(target) && !target.endsWith(join("node_modules", "vite")),
    });
    assert.equal(partial.mode, "install");
    assert.ok(partial.reasons.some((reason) => /足りない: vite/u.test(reason)), partial.reasons.join("\n"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("install の経路で依存が入れば、その写しから SDK を読み込め、後片付けで置き場の外の依存は消さない", { skip: NEEDS_DEPS, timeout: 60_000 }, async (t) => {
  const paths = fixture(t);
  await stagePlugin(paths.pluginRoot);
  const before = snapshot(paths.pluginRoot);
  const installedInto = [];
  const runtime = await prepareVerificationRuntime({
    pluginRoot: paths.pluginRoot,
    homeDir: paths.homeDir,
    tempBaseDir: paths.tempBase,
    log: () => {},
    // ネットワークに出ない差し替え: 入れたことにして、依存をつなぐ。
    installDependencies: async (runtimeRoot) => {
      installedInto.push(runtimeRoot);
      linkDirectory(ROOT_NODE_MODULES, join(runtimeRoot, "node_modules"));
    },
  });
  try {
    assert.equal(runtime.mode, "install");
    assert.deepEqual(installedInto, [runtime.runtimeRoot]);
    assert.notEqual(runtime.runtimeRoot, paths.pluginRoot);
    assert.equal(existsSync(join(runtime.runtimeRoot, "canvas")), false);
    const { Client, StdioClientTransport } = await importMcpClientSdk(runtime.runtimeRoot);
    assert.equal(typeof Client, "function");
    assert.equal(typeof StdioClientTransport, "function");
  } finally {
    await runtime.cleanup();
  }
  assert.deepEqual(leftoverVerifyTemps(paths.tempBase), []);
  assert.deepEqual(snapshot(paths.pluginRoot), before);
  assert.ok(existsSync(join(ROOT_NODE_MODULES, "@modelcontextprotocol", "sdk", "package.json")), "後片付けがリンク先を消した");
});

test("依存の無い置き場やホストの plugin キャッシュで起動される入口は、Node の組み込みしか import しない", () => {
  // 置き場（~/plugins/buzzassist/plugin）とホストのキャッシュには node_modules が無い。そこで起動される
  // 入口が npm の依存を（推移的にでも）import すると、起動した瞬間に ERR_MODULE_NOT_FOUND で落ちる。
  // - update-current.mjs: 定刻の起動（launchd / systemd / タスク スケジューラ）が置き場から走らせる
  // - auto-update.mjs: setup が置き場から登録に走らせる
  // - verify-plugin-runtime.mjs: 更新の仕組みが置き場で走らせる（SDK は依存をつないだ後に読む）
  // - start-mcp.mjs: 依存を入れる前の部分
  // - harness-learn-hook.mjs / harness-stop-hook.mjs: ホストがキャッシュから走らせるフック
  // 文字列で書いた動的 import（update-current の hostSkillSync など）も辿る。
  const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
  const importPattern = /(?:^|\n|;)\s*(?:import|export)\s+(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"'\n]+)["']|\bimport\(\s*["']([^"'\n]+)["']\s*\)/gu;
  const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:"'`\\])\/\/.*$/gmu, "$1");
  for (const entry of [
    "scripts/update-current.mjs",
    "scripts/auto-update.mjs",
    "scripts/verify-plugin-runtime.mjs",
    "scripts/start-mcp.mjs",
    "scripts/harness-learn-hook.mjs",
    "scripts/harness-stop-hook.mjs",
  ]) {
    const seen = new Set();
    const stack = [[join(ROOT, entry), entry]];
    const offenders = [];
    while (stack.length > 0) {
      const [file, chain] = stack.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      for (const match of stripComments(readFileSync(file, "utf8")).matchAll(importPattern)) {
        const specifier = match[1] || match[2];
        if (specifier.startsWith(".")) {
          const next = join(dirname(file), specifier);
          stack.push([next, `${chain} -> ${relative(ROOT, next).split(/[\\/]/u).join("/")}`]);
        } else if (!builtins.has(specifier)) {
          offenders.push(`${specifier}（${chain}）`);
        }
      }
    }
    assert.deepEqual(offenders, [], `${entry} が依存の無い置き場で読めないものを import している`);
  }
});

test("殺された検証の消し残しは、1時間を過ぎたものだけ、リンク先を消さずに掃除する", (t) => {
  const base = mkdtempSync(join(tmpdir(), "verify-sweep-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const sentinel = join(base, "release-node_modules");
  mkdirSync(join(sentinel, "pkg"), { recursive: true });
  writeFileSync(join(sentinel, "pkg", "keep.txt"), "keep");
  const stale = join(base, `${VERIFY_TEMP_PREFIX}stale`);
  const fresh = join(base, `${VERIFY_TEMP_PREFIX}fresh`);
  for (const dir of [stale, fresh]) {
    mkdirSync(join(dir, "plugin"), { recursive: true });
    linkDirectory(sentinel, join(dir, "plugin", "node_modules"));
  }
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(stale, old, old);

  const removed = sweepStaleVerifyTemps({ baseDir: base });
  assert.deepEqual(removed, [stale]);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true, "動いているかもしれない新しい写しを消した");
  assert.equal(readFileSync(join(sentinel, "pkg", "keep.txt"), "utf8"), "keep", "リンク先の中身を消した");
});
