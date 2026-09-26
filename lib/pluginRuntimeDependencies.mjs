import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { envWithNodeOnPath, resolveNpmInvocation } from "./npmInvocation.mjs";
import { normalizeVersion, safeReleaseDirectoryName, updaterPaths } from "./pluginAutoUpdate.mjs";

/**
 * 配布した plugin の置き場（~/plugins/buzzassist/plugin）で MCP を動かすのに要る依存。
 *
 * 置き場は依存なしで配る（2026-09-17、v0.1.26 から）。node_modules が置き場にあると、
 * Codex / Claude Code の plugin キャッシュが依存の木を丸ごと写すため。依存は
 * scripts/start-mcp.mjs が初回の起動で入れる。この一覧は start-mcp と、導入後の検証
 * （scripts/verify-plugin-runtime.mjs）が同じものを使う。
 *
 * この module は Node の組み込み（と組み込みだけで書いた lib）しか import しない。
 * 依存の無い置き場から読み込まれるため。
 */
export const MCP_RUNTIME_DEPENDENCIES = Object.freeze([
  "@excalidraw/excalidraw",
  "@modelcontextprotocol/ext-apps",
  "@modelcontextprotocol/sdk",
  "@vitejs/plugin-react",
  "fractional-indexing",
  "kuromoji",
  "react",
  "react-dom",
  "vite",
  "zod",
]);

// 検証用の写しを置く一時フォルダの名前の頭。消し残しの掃除もこの名前で探す。
export const VERIFY_TEMP_PREFIX = "buzzassist-plugin-verify-";
// これより古い写しは、殺された検証（Windows の TerminateProcess など）の消し残しとみなす。
const STALE_VERIFY_TEMP_MS = 60 * 60 * 1000;
// 写しに入れないもの（置き場の直下）。node_modules は依存をつなぐ場所、canvas は運営者のデータ。
const COPY_EXCLUDED_TOP_LEVEL = new Set(["node_modules", "canvas"]);

export function runtimeDependencyDir(root, packageName) {
  return path.join(root, "node_modules", ...packageName.split("/"));
}

export function missingRuntimeDependencies(root, { dependencies = MCP_RUNTIME_DEPENDENCIES, exists = existsSync } = {}) {
  return dependencies.filter((packageName) => !exists(runtimeDependencyDir(root, packageName)));
}

/**
 * start-mcp と同じ `npm install` の呼び方。npm は実行中の Node に同梱のものを使う
 * （ホストが起動する MCP や launchd の PATH に npm があるとは限らない）。
 */
export function npmInstallInvocation({ platform = process.platform, resolveNpm = resolveNpmInvocation } = {}) {
  const npm = resolveNpm();
  if (npm.source === "bundled-npm-cli") return { command: npm.command, args: [...npm.args, "install"], shell: false };
  if (platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", "npm", "install"], shell: false };
  }
  return { command: "npm", args: ["install"], shell: false };
}

/** 自動更新（scripts/update-current.mjs）と同じ HOME の決め方。 */
export function runtimeHomeDir(env = process.env) {
  return path.resolve(env.BUZZASSIST_SETUP_HOME || homedir());
}

/**
 * 自動更新が同じ版の Release を展開し、`npm ci` で依存を入れた場所。
 * update-current.mjs の prepareReleaseSource と同じ決め方（<HOME>/.buzzassist/releases/v<版>/source）。
 */
export function releaseSourceDir({ homeDir, version }) {
  return path.join(updaterPaths(homeDir).releasesDir, safeReleaseDirectoryName(version), "source");
}

function readPackageVersion(root) {
  try {
    return normalizeVersion(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))?.version)?.raw || "";
  } catch {
    return "";
  }
}

/**
 * どこの依存で MCP を確かめるかを決める（ファイルは何も変えない）。
 *
 * - 置き場に必須の依存が全部あれば、今までどおり置き場で確かめる（in-place）。
 * - 無ければ、--deps-root、次に同じ版の Release の展開先を見て、必須の依存が揃い、
 *   版も置き場と同じなら、そこへのリンクを写しに置く（link）。
 * - どれも使えなければ、写しの中で npm install する（install）。理由は reasons に残す。
 */
export function resolveVerificationDependencies({ pluginRoot, depsRoot = "", homeDir = runtimeHomeDir(), exists = existsSync } = {}) {
  const root = path.resolve(pluginRoot);
  const inPlaceMissing = missingRuntimeDependencies(root, { exists });
  if (inPlaceMissing.length === 0) return { mode: "in-place", dependencyRoot: root, reasons: [] };

  const version = readPackageVersion(root);
  const reasons = [`置き場 ${root} に依存が無い（足りない: ${inPlaceMissing.join(", ")}）`];
  const candidates = [];
  if (depsRoot) candidates.push({ root: path.resolve(depsRoot), source: "--deps-root" });
  if (version) {
    const release = releaseSourceDir({ homeDir, version });
    if (!candidates.some((candidate) => candidate.root === release)) candidates.push({ root: release, source: `同じ版 ${version} の Release の展開先` });
  } else {
    reasons.push(`置き場の package.json から版を読めないので、Release の展開先を決められない`);
  }

  for (const candidate of candidates) {
    if (!exists(path.join(candidate.root, "node_modules"))) {
      reasons.push(`${candidate.source} ${candidate.root} に node_modules が無い`);
      continue;
    }
    const candidateVersion = readPackageVersion(candidate.root);
    if (!candidateVersion || candidateVersion !== version) {
      reasons.push(`${candidate.source} ${candidate.root} の版（${candidateVersion || "不明"}）が置き場の版（${version || "不明"}）と違う`);
      continue;
    }
    const missing = missingRuntimeDependencies(candidate.root, { exists });
    if (missing.length > 0) {
      reasons.push(`${candidate.source} ${candidate.root} に必須の依存が揃っていない（足りない: ${missing.join(", ")}）`);
      continue;
    }
    return { mode: "link", dependencyRoot: candidate.root, source: candidate.source, version, reasons };
  }
  return { mode: "install", dependencyRoot: "", version, reasons };
}

/**
 * 依存へのリンク（Windows は junction）を外す。中身は消さない。
 * recursive の rm にリンクを渡さないのは、万一リンク先の Release の依存を消すと
 * 次の更新と巻き戻しの材料まで無くなるため。
 */
function removeDependencyLinkSync(linkPath) {
  let details;
  try {
    details = lstatSync(linkPath);
  } catch {
    return;
  }
  if (!details.isSymbolicLink()) return;
  try {
    unlinkSync(linkPath);
  } catch {
    // Windows の junction はディレクトリとして外す。
    rmdirSync(linkPath);
  }
}

function removeVerifyTempSync(tempDir) {
  if (!tempDir) return;
  removeDependencyLinkSync(path.join(tempDir, "plugin", "node_modules"));
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

/** 殺された検証が残した写しを掃除する（best-effort。1時間より新しいものは触らない）。 */
export function sweepStaleVerifyTemps({ baseDir = tmpdir(), now = Date.now(), log = () => {} } = {}) {
  let entries = [];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(VERIFY_TEMP_PREFIX)) continue;
    const target = path.join(baseDir, entry.name);
    try {
      if (now - statSync(target).mtimeMs < STALE_VERIFY_TEMP_MS) continue;
      removeVerifyTempSync(target);
      removed.push(target);
    } catch (error) {
      log(`以前の検証の一時フォルダを消せませんでした: ${target}（${error?.message || error}）`);
    }
  }
  return removed;
}

async function copyPluginRoot(pluginRoot, runtimeRoot) {
  await mkdir(runtimeRoot, { recursive: true });
  // 直下を1つずつ写す（fs.cp の filter は Windows の Node 20 で名前空間つきのパスを渡すので使わない）。
  for (const entry of await readdir(pluginRoot, { withFileTypes: true })) {
    if (COPY_EXCLUDED_TOP_LEVEL.has(entry.name)) continue;
    await cp(path.join(pluginRoot, entry.name), path.join(runtimeRoot, entry.name), {
      recursive: true,
      force: true,
      dereference: false,
    });
  }
}

function runNpmInstallAsync({ cwd, timeoutMs, stderr, track }) {
  const { command, args, shell } = npmInstallInvocation();
  return new Promise((resolveInstall, rejectInstall) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...envWithNodeOnPath(process.env), FORCE_COLOR: "0" },
      shell,
      stdio: ["ignore", "pipe", "pipe"],
    });
    track(child);
    child.stdout.on("data", (chunk) => stderr.write(chunk));
    child.stderr.on("data", (chunk) => stderr.write(chunk));
    let timedOut = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs)
      : null;
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      track(null);
      rejectInstall(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      track(null);
      if (code === 0) resolveInstall();
      else rejectInstall(new Error(timedOut
        ? `npm install が ${timeoutMs}ms で終わらなかった（検証用の写し ${cwd}）。`
        : `npm install が失敗した（exit ${code}、検証用の写し ${cwd}）。`));
    });
  });
}

/**
 * MCP の検証に使う置き場を用意する。
 *
 * 依存が置き場にあればそのまま使う。無ければ、置き場そのものには node_modules を作らず、
 * 一時フォルダへ置き場を写し（node_modules・canvas を除く）、その写しに依存をつなぐ。
 * 返す cleanup() は一時フォルダを消す（何度呼んでもよい）。SIGTERM・SIGINT・異常終了でも消す。
 *
 * installDependencies は試験用の差し替え口（ネットワークに出ずに install の経路を通すため）。
 */
export async function prepareVerificationRuntime({
  pluginRoot,
  depsRoot = "",
  homeDir = runtimeHomeDir(),
  installTimeoutMs = 5 * 60 * 1000,
  log = (message) => console.log(message),
  stderr = process.stderr,
  installDependencies = null,
  tempBaseDir = tmpdir(),
} = {}) {
  const root = path.resolve(pluginRoot);
  const plan = resolveVerificationDependencies({ pluginRoot: root, depsRoot, homeDir });
  if (plan.mode === "in-place") {
    return { runtimeRoot: root, mode: "in-place", plan, cleanup: async () => {} };
  }

  sweepStaleVerifyTemps({ baseDir: tempBaseDir, log });
  const tempDir = await mkdtemp(path.join(tempBaseDir, VERIFY_TEMP_PREFIX));
  const runtimeRoot = path.join(tempDir, "plugin");
  let installChild = null;
  let cleaned = false;
  const cleanupSync = () => {
    if (cleaned) return;
    cleaned = true;
    detach();
    try {
      installChild?.kill("SIGTERM");
    } catch {
      // 既に終わっている
    }
    try {
      removeVerifyTempSync(tempDir);
    } catch (error) {
      // 検証の結果を後片付けの失敗で覆わない。残った写しは次の検証が1時間後から掃除する。
      log(`検証用の一時フォルダ ${tempDir} を消せませんでした（${error?.message || error}）。`);
    }
  };
  const onSignal = (signal) => {
    log(`${signal} を受けたので、検証用の一時フォルダ ${tempDir} を消して終わります。`);
    try {
      cleanupSync();
    } finally {
      process.exit(signal === "SIGINT" ? 130 : 143);
    }
  };
  const signals = process.platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, onSignal);
  process.on("exit", cleanupSync);
  function detach() {
    for (const signal of signals) process.off(signal, onSignal);
    process.off("exit", cleanupSync);
  }
  const cleanup = async () => {
    cleanupSync();
  };

  try {
    const copyStartedAt = Date.now();
    await copyPluginRoot(root, runtimeRoot);
    const linkPath = path.join(runtimeRoot, "node_modules");
    if (plan.mode === "link") {
      const target = path.join(plan.dependencyRoot, "node_modules");
      await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
      log(`置き場に依存が無いので、写し ${runtimeRoot} に ${target}（${plan.source}）をつないで確かめます（写しに ${Date.now() - copyStartedAt}ms）。`);
    } else {
      for (const reason of plan.reasons) log(`依存を使えない理由: ${reason}`);
      log(`使える依存が無いので、写し ${runtimeRoot} の中で npm install します。`
        + "ネットワークと npm の状態によっては数十秒〜数分かかり、古い更新の仕組み（上限 60 秒）では時間切れになることがあります。");
      const installStartedAt = Date.now();
      if (installDependencies) {
        await installDependencies(runtimeRoot);
      } else {
        await runNpmInstallAsync({
          cwd: runtimeRoot,
          timeoutMs: installTimeoutMs,
          stderr,
          track: (child) => { installChild = child; },
        });
      }
      const stillMissing = missingRuntimeDependencies(runtimeRoot);
      if (stillMissing.length > 0) {
        throw new Error(`写しに npm install しても必須の依存が揃わなかった（足りない: ${stillMissing.join(", ")}）。`);
      }
      log(`写しへの npm install が終わりました（${Date.now() - installStartedAt}ms）。`);
    }
  } catch (error) {
    cleanupSync();
    throw error;
  }
  return { runtimeRoot, mode: plan.mode, plan, tempDir, cleanup };
}

/**
 * MCP の client SDK を、用意した置き場（runtimeRoot）の依存から読み込む。
 * bare specifier は import する側のファイルの場所から解決されるので、runtimeRoot の中の
 * lib/mcpClientSdk.mjs を経由する（写しの node_modules は置き場の外の依存へつないである）。
 */
export async function importMcpClientSdk(runtimeRoot) {
  const loader = await import(pathToFileURL(path.join(runtimeRoot, "lib", "mcpClientSdk.mjs")).href);
  return loader.loadMcpClientSdk();
}
