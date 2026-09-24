import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  atomicWriteFile,
  downloadVerified,
  extractFilesFromTgz,
  extractZipEntries,
  resolveManagedToolsRoot,
  sha256Hex,
} from "./managedToolDownload.mjs";

/**
 * 動画ハーネスの前提ツールを、管理者権限なしで ~/.buzzassist/tools/ に入れる。
 *
 * - ffmpeg / ffprobe: 配布元の静的ビルドを、版・URL・SHA-256 を固定して取得する。
 *   SHA-256 は各配布元が出しているチェックサムファイル（.sha256）で確かめた値だけを書く。
 * - Python: 既存の Python 3.10+ で ~/.buzzassist/tools/python-venv を作り、
 *   opencv-python-headless<5・numpy・pillow を入れる。使える Python が無ければ、
 *   uv の公式配布（SHA-256 固定）で Python ごと用意する。
 * - 音声品質用の重い依存（torch など）は入れない。tesseract は案内だけ。
 *
 * システムの道具には触らない。PATH にある運営者の ffmpeg / Python が使えるなら、そちらを優先する。
 */

// ---- ffmpeg ------------------------------------------------------------------------------

export const MANAGED_FFMPEG_VERSION = "9.0.2";

// 出典（2026-09-24 に各 .sha256 を取得して照合）:
// - macOS / Linux: Martin Riedl の FFmpeg static builds（https://ffmpeg.martin-riedl.de/）の
//   release 9.0.2。各 zip の隣の <name>.zip.sha256。libx264 と aac encoder を含む（codecs.txt）。
// - Windows: gyan.dev の release essentials 9.0.2（https://www.gyan.dev/ffmpeg/builds/）。
//   packages/ffmpeg-9.0.2-essentials_build.zip.sha256。GitHub の GyanD/codexffmpeg 9.0.2 は同じ中身の mirror。
const MARTIN_RIEDL = "https://ffmpeg.martin-riedl.de/download";
const FFMPEG_ASSETS = Object.freeze({
  "darwin-arm64": {
    provider: "ffmpeg.martin-riedl.de",
    archives: [
      { name: "ffmpeg.zip", urls: [`${MARTIN_RIEDL}/macos/arm64/1789931890_9.0.2/ffmpeg.zip`], sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924", entries: { ffmpeg: "ffmpeg" } },
      { name: "ffprobe.zip", urls: [`${MARTIN_RIEDL}/macos/arm64/1789931890_9.0.2/ffprobe.zip`], sha256: "fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6", entries: { ffprobe: "ffprobe" } },
    ],
  },
  "darwin-x64": {
    provider: "ffmpeg.martin-riedl.de",
    archives: [
      { name: "ffmpeg.zip", urls: [`${MARTIN_RIEDL}/macos/amd64/1789931006_9.0.2/ffmpeg.zip`], sha256: "7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4", entries: { ffmpeg: "ffmpeg" } },
      { name: "ffprobe.zip", urls: [`${MARTIN_RIEDL}/macos/amd64/1789931006_9.0.2/ffprobe.zip`], sha256: "2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd", entries: { ffprobe: "ffprobe" } },
    ],
  },
  "linux-x64": {
    provider: "ffmpeg.martin-riedl.de",
    archives: [
      { name: "ffmpeg.zip", urls: [`${MARTIN_RIEDL}/linux/amd64/1789931100_9.0.2/ffmpeg.zip`], sha256: "fa8ecf4abbd290d98f7d188b8649cc6b391ae209a98452be955a15aab1909d7f", entries: { ffmpeg: "ffmpeg" } },
      { name: "ffprobe.zip", urls: [`${MARTIN_RIEDL}/linux/amd64/1789931100_9.0.2/ffprobe.zip`], sha256: "3f428c49070be3d24ec338602b76d412e401ffcb8a5641ef0e729181a232fc32", entries: { ffprobe: "ffprobe" } },
    ],
  },
  "linux-arm64": {
    provider: "ffmpeg.martin-riedl.de",
    archives: [
      { name: "ffmpeg.zip", urls: [`${MARTIN_RIEDL}/linux/arm64/1789931697_9.0.2/ffmpeg.zip`], sha256: "93a76ae90db5474eecdf951a729857c64f3de23567228d6a7d5e6e8e3cd1021b", entries: { ffmpeg: "ffmpeg" } },
      { name: "ffprobe.zip", urls: [`${MARTIN_RIEDL}/linux/arm64/1789931697_9.0.2/ffprobe.zip`], sha256: "bcbe80fb741c180083327afaf5434812e006b33cacde2016b9aeaf6936128330", entries: { ffprobe: "ffprobe" } },
    ],
  },
  "win32-x64": {
    provider: "gyan.dev",
    archives: [
      {
        name: "ffmpeg-9.0.2-essentials_build.zip",
        urls: [
          "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip",
          "https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip",
        ],
        sha256: "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba",
        entries: {
          ffmpeg: "ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe",
          ffprobe: "ffmpeg-9.0.2-essentials_build/bin/ffprobe.exe",
        },
      },
    ],
  },
});

function exe(name, platform) {
  return platform === "win32" ? `${name}.exe` : name;
}

export function resolveFfmpegAsset({ platform = process.platform, arch = process.arch } = {}) {
  // Windows on ARM は x64 版をエミュレーションで動かせる。
  const normalizedArch = platform === "win32" && arch === "arm64" ? "x64" : arch;
  const asset = FFMPEG_ASSETS[`${platform}-${normalizedArch}`];
  if (!asset) return null;
  return { ...asset, version: MANAGED_FFMPEG_VERSION, key: `${platform}-${normalizedArch}` };
}

export function managedFfmpegPaths({ platform = process.platform, arch = process.arch, env = process.env, homeDir, toolsDir } = {}) {
  const root = resolveManagedToolsRoot({ env, homeDir, toolsDir });
  const binDir = path.join(root, "ffmpeg", MANAGED_FFMPEG_VERSION, `${platform}-${arch}`);
  return {
    root,
    binDir,
    ffmpeg: path.join(binDir, exe("ffmpeg", platform)),
    ffprobe: path.join(binDir, exe("ffprobe", platform)),
    metadataPath: path.join(binDir, "install.json"),
  };
}

function runFile(command, args, { timeoutMs = 30_000, env = process.env } = {}) {
  return new Promise((resolveRun) => {
    execFile(command, args, { timeout: timeoutMs, env, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolveRun({ ok: !error, code: error?.code ?? 0, stdout: String(stdout || ""), stderr: String(stderr || ""), error });
    });
  });
}

async function defaultVerifyBinary(filePath, name) {
  const result = await runFile(filePath, ["-version"], { timeoutMs: 30_000 });
  return result.ok && new RegExp(`${name} version`, "iu").test(`${result.stdout}${result.stderr}`);
}

function readJsonSync(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function cachedFfmpegIsValid(paths, asset, verifyBinary) {
  const metadata = readJsonSync(paths.metadataPath);
  if (metadata?.version !== MANAGED_FFMPEG_VERSION || metadata?.assetKey !== asset.key) return false;
  const expectedArchives = asset.archives.map((archive) => archive.sha256).join(",");
  if ((metadata.archiveSha256 || []).join(",") !== expectedArchives) return false;
  for (const name of ["ffmpeg", "ffprobe"]) {
    const filePath = paths[name];
    try {
      if (!statSync(filePath).isFile()) return false;
      if (sha256Hex(await readFile(filePath)) !== metadata.executables?.[name]) return false;
      if (!(await verifyBinary(filePath, name))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** 固定版の ffmpeg / ffprobe を ~/.buzzassist/tools/ffmpeg/<版>/<platform-arch>/ に用意する。 */
export async function ensureManagedFfmpeg(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const asset = options.asset || resolveFfmpegAsset({ platform, arch });
  if (!asset) {
    return { ok: false, status: "unsupported", detail: `この環境（${platform}/${arch}）向けの固定版 ffmpeg はありません` };
  }
  const paths = managedFfmpegPaths({ platform, arch, env: options.env || process.env, homeDir: options.homeDir, toolsDir: options.toolsDir });
  const verifyBinary = options.verifyBinary || defaultVerifyBinary;
  if (await cachedFfmpegIsValid(paths, asset, verifyBinary)) {
    return { ok: true, status: "managed-cache", ...paths, provider: asset.provider, version: MANAGED_FFMPEG_VERSION };
  }
  await rm(paths.binDir, { recursive: true, force: true });
  await mkdir(paths.binDir, { recursive: true });
  try {
    const executables = {};
    for (const archive of asset.archives) {
      const { bytes } = await downloadVerified({
        urls: archive.urls,
        sha256: archive.sha256,
        label: `ffmpeg ${MANAGED_FFMPEG_VERSION} ${archive.name}`,
        fetchImpl: options.fetchImpl,
        userAgent: `BuzzAssist/ffmpeg-${MANAGED_FFMPEG_VERSION}`,
      });
      const wanted = new Set(Object.values(archive.entries));
      const files = extractZipEntries(bytes, (name) => wanted.has(name));
      for (const [tool, entryName] of Object.entries(archive.entries)) {
        const content = files.get(entryName);
        if (!content?.length) throw new Error(`${archive.name} に ${entryName} が無い`);
        await atomicWriteFile(paths[tool], content, { mode: 0o755 });
        executables[tool] = sha256Hex(content);
      }
    }
    for (const tool of ["ffmpeg", "ffprobe"]) {
      if (!executables[tool]) throw new Error(`${tool} を取り出せなかった`);
      if (!(await verifyBinary(paths[tool], tool))) throw new Error(`取得した ${tool} がこの環境で起動しない`);
    }
    await atomicWriteFile(paths.metadataPath, `${JSON.stringify({
      version: MANAGED_FFMPEG_VERSION,
      assetKey: asset.key,
      provider: asset.provider,
      sources: asset.archives.map((archive) => archive.urls[0]),
      archiveSha256: asset.archives.map((archive) => archive.sha256),
      executables,
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    return { ok: true, status: "managed-download", ...paths, provider: asset.provider, version: MANAGED_FFMPEG_VERSION };
  } catch (error) {
    await rm(paths.binDir, { recursive: true, force: true });
    return { ok: false, status: "failed", detail: String(error?.message || error).slice(0, 400) };
  }
}

/** 入っている管理下の ffmpeg / ffprobe（無ければ null）。解決器の候補に使う。 */
export function installedManagedFfmpeg(options = {}) {
  const paths = managedFfmpegPaths(options);
  return {
    ffmpeg: existsSync(paths.ffmpeg) ? paths.ffmpeg : null,
    ffprobe: existsSync(paths.ffprobe) ? paths.ffprobe : null,
    binDir: paths.binDir,
  };
}

/**
 * 管理下の ffmpeg の置き場所を PATH の**後ろ**に足す（運営者の ffmpeg が先に効く）。
 * パイプラインの多くは ffmpeg を名前で呼ぶので、解決器の候補に入れるだけでは届かない。
 * 入口（start-mcp / run-video-harness / 各ランナー / doctor / setup）で呼ぶ。
 */
export function appendManagedToolsToPath(env = process.env, options = {}) {
  const platform = options.platform || process.platform;
  const installed = installedManagedFfmpeg({ ...options, env, platform });
  if (!installed.ffmpeg && !installed.ffprobe) return { changed: false };
  const separator = platform === "win32" ? ";" : ":";
  const key = Object.keys(env).find((name) => /^path$/iu.test(name)) || "PATH";
  const parts = String(env[key] || "").split(separator).filter(Boolean);
  if (parts.includes(installed.binDir)) return { changed: false, binDir: installed.binDir };
  env[key] = [...parts, installed.binDir].join(separator);
  return { changed: true, binDir: installed.binDir };
}

// ---- Python venv -------------------------------------------------------------------------

export const PYTHON_VENV_REQUIREMENTS = Object.freeze(["opencv-python-headless<5", "numpy", "pillow"]);
export const PYTHON_VENV_MODULES = Object.freeze(["cv2:CascadeClassifier", "numpy", "PIL"]);
export const MANAGED_UV_VERSION = "0.12.18";
export const MANAGED_UV_PYTHON = "3.12";

// 出典: https://github.com/astral-sh/uv/releases/tag/0.12.18 の各 <asset>.sha256（2026-09-24 に取得して照合）。
const UV_ASSETS = Object.freeze({
  "darwin-arm64": { name: "uv-aarch64-apple-darwin.tar.gz", sha256: "cf40e0c6a202190ccd9e0406dcfdd5b2d6668a9a5c779b17948963df32aafe5b" },
  "darwin-x64": { name: "uv-x86_64-apple-darwin.tar.gz", sha256: "2e4108f5395397c8bc5d43bf83d3bdbb2d0e92b90d0efa607756be704905fa33" },
  "linux-x64": { name: "uv-x86_64-unknown-linux-gnu.tar.gz", sha256: "89eadd7c76fc063887959510d5ba0ab1264dfd5f1143b925ddb73021a40acf16" },
  "linux-arm64": { name: "uv-aarch64-unknown-linux-gnu.tar.gz", sha256: "afb6291f3f0a6b4521fc67b947822506c41dde5b60d2189dd8f3695b2ac8c9e7" },
  "win32-x64": { name: "uv-x86_64-pc-windows-msvc.zip", sha256: "cae6a3bc25239f83dffb467a4b180508d9da23986c04639ebfa44e43e6a84bff" },
  "win32-arm64": { name: "uv-aarch64-pc-windows-msvc.zip", sha256: "17f27b1c64eacc757ae603579f116a014881e486c5e79ae81877980d4699e943" },
});

export function resolveUvAsset({ platform = process.platform, arch = process.arch } = {}) {
  const asset = UV_ASSETS[`${platform}-${arch}`];
  if (!asset) return null;
  return {
    ...asset,
    version: MANAGED_UV_VERSION,
    url: `https://github.com/astral-sh/uv/releases/download/${MANAGED_UV_VERSION}/${asset.name}`,
  };
}

export function managedPythonVenvPaths({ platform = process.platform, arch = process.arch, env = process.env, homeDir, toolsDir } = {}) {
  const root = resolveManagedToolsRoot({ env, homeDir, toolsDir });
  const venvDir = path.join(root, "python-venv");
  return {
    root,
    venvDir,
    python: platform === "win32" ? path.join(venvDir, "Scripts", "python.exe") : path.join(venvDir, "bin", "python"),
    uvDir: path.join(root, "uv", MANAGED_UV_VERSION, `${platform}-${arch}`),
    uvPythonDir: path.join(root, "uv-python"),
    uvCacheDir: path.join(root, "uv-cache"),
  };
}

function findAllOnPath(name, env, platform) {
  const separator = platform === "win32" ? ";" : ":";
  const key = Object.keys(env || {}).find((entry) => /^path$/iu.test(entry));
  const extensions = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const found = [];
  for (const dir of String(key ? env[key] : "").split(separator).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${name.toLowerCase().endsWith(extension) ? "" : extension}`);
      try {
        if (statSync(candidate).isFile() && !found.includes(candidate)) found.push(candidate);
      } catch {
        // 次の候補
      }
    }
  }
  return found;
}

/**
 * venv を作れる Python 3.10+ の候補。
 * macOS の /usr/bin/python3 は Command Line Tools が無いと GUI の導入ダイアログを出す
 * 見せかけなので、`xcode-select -p` が通らない端末では起動しない。
 * Windows の python.exe は Microsoft Store を開く見せかけのことがあるが、起動しても
 * 失敗で返るだけなので probe で落とす。
 */
export async function baseVenvPythonCandidates({ env = process.env, platform = process.platform, runCommand = runFile } = {}) {
  const candidates = [];
  if (platform === "win32") {
    candidates.push({ command: "py.exe", args: ["-3"] }, { command: "python.exe", args: [] });
    return candidates;
  }
  let cltReady = true;
  if (platform === "darwin") {
    const clt = await runCommand("xcode-select", ["-p"], { timeoutMs: 10_000, env });
    cltReady = clt.ok;
  }
  for (const name of ["python3.13", "python3.12", "python3.11", "python3.10", "python3", "python"]) {
    for (const found of findAllOnPath(name, env, platform)) {
      if (platform === "darwin" && !cltReady && found.startsWith("/usr/bin/")) continue;
      if (!candidates.some((entry) => entry.command === found)) candidates.push({ command: found, args: [] });
    }
  }
  return candidates;
}

const VERSION_PROBE = "import sys,venv,ensurepip;print('BUZZASSIST_PY=%d.%d' % sys.version_info[:2])";

async function probeVenvCapable(candidate, runCommand, env) {
  const result = await runCommand(candidate.command, [...candidate.args, "-c", VERSION_PROBE], { timeoutMs: 60_000, env });
  const match = `${result.stdout}\n${result.stderr}`.match(/BUZZASSIST_PY=(\d+)\.(\d+)/u);
  if (!result.ok || !match) return null;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 3 || (major === 3 && minor >= 10) ? { ...candidate, version: `${major}.${minor}` } : null;
}

async function probeVenvModules(python, runCommand, env) {
  const script = [
    "import importlib,sys",
    `mods=${JSON.stringify(PYTHON_VENV_MODULES)}`,
    "bad=[]",
    "for m in mods:",
    "    name,_,attr=m.partition(':')",
    "    try:",
    "        mod=importlib.import_module(name)",
    "        ok=(not attr) or hasattr(mod,attr)",
    "    except BaseException:",
    "        ok=False",
    "    if not ok: bad.append(m)",
    "print('BUZZASSIST_VENV_MISSING='+','.join(bad))",
  ].join("\n");
  const result = await runCommand(python, ["-X", "utf8", "-c", script], { timeoutMs: 120_000, env });
  const line = `${result.stdout}`.split(/\r?\n/u).find((entry) => entry.startsWith("BUZZASSIST_VENV_MISSING="));
  if (!result.ok || line === undefined) return { ok: false, missing: [...PYTHON_VENV_MODULES] };
  const missing = line.slice("BUZZASSIST_VENV_MISSING=".length).split(",").filter(Boolean);
  return { ok: missing.length === 0, missing };
}

async function ensureManagedUv({ platform, arch, paths, fetchImpl, asset: injected }) {
  const asset = injected || resolveUvAsset({ platform, arch });
  if (!asset) throw new Error(`この環境（${platform}/${arch}）向けの uv はありません`);
  const uvPath = path.join(paths.uvDir, exe("uv", platform));
  const metadataPath = path.join(paths.uvDir, "install.json");
  const metadata = readJsonSync(metadataPath);
  if (metadata?.assetSha256 === asset.sha256 && existsSync(uvPath)
    && sha256Hex(await readFile(uvPath)) === metadata.executableSha256) {
    return uvPath;
  }
  await rm(paths.uvDir, { recursive: true, force: true });
  const { bytes } = await downloadVerified({ urls: [asset.url], sha256: asset.sha256, label: `uv ${MANAGED_UV_VERSION}`, fetchImpl });
  const wanted = (name) => path.posix.basename(name) === exe("uv", platform);
  const files = asset.name.endsWith(".zip") ? extractZipEntries(bytes, wanted) : extractFilesFromTgz(bytes, wanted);
  const content = [...files.values()][0];
  if (!content?.length) throw new Error(`${asset.name} に uv が無い`);
  await atomicWriteFile(uvPath, content, { mode: 0o755 });
  await atomicWriteFile(metadataPath, `${JSON.stringify({
    version: MANAGED_UV_VERSION,
    assetName: asset.name,
    sourceUrl: asset.url,
    assetSha256: asset.sha256,
    executableSha256: sha256Hex(content),
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  return uvPath;
}

/**
 * ~/.buzzassist/tools/python-venv を用意する。既に要る module がそろっていれば何もしない。
 * 失敗しても例外にしない（{ ok:false, detail } を返す）。前提の判定は doctor が行う。
 */
export async function ensureManagedPythonVenv(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const env = options.env || process.env;
  const runCommand = options.runCommand || runFile;
  const log = options.log || (() => {});
  const paths = managedPythonVenvPaths({ platform, arch, env, homeDir: options.homeDir, toolsDir: options.toolsDir });
  try {
    if (existsSync(paths.python)) {
      const current = await probeVenvModules(paths.python, runCommand, env);
      if (current.ok) return { ok: true, status: "managed-cache", python: paths.python, venvDir: paths.venvDir };
    }
    const pipInstall = async (python) => {
      log(`Installing ${PYTHON_VENV_REQUIREMENTS.join(", ")} into ${paths.venvDir}`);
      const installed = await runCommand(python, [
        "-m", "pip", "install", "--disable-pip-version-check", "--no-input", ...PYTHON_VENV_REQUIREMENTS,
      ], { timeoutMs: 15 * 60 * 1000, env });
      if (!installed.ok) throw new Error(`pip install が失敗した: ${`${installed.stderr || installed.stdout}`.trim().split(/\r?\n/u).slice(-3).join(" / ").slice(0, 300)}`);
    };

    let base = null;
    for (const candidate of options.baseCandidates || await baseVenvPythonCandidates({ env, platform, runCommand })) {
      base = await probeVenvCapable(candidate, runCommand, env);
      if (base) break;
    }
    if (base) {
      log(`Creating ${paths.venvDir} with Python ${base.version} (${base.command})`);
      await rm(paths.venvDir, { recursive: true, force: true });
      await mkdir(path.dirname(paths.venvDir), { recursive: true });
      const created = await runCommand(base.command, [...base.args, "-m", "venv", paths.venvDir], { timeoutMs: 5 * 60 * 1000, env });
      if (!created.ok) throw new Error(`python -m venv が失敗した: ${`${created.stderr || created.stdout}`.trim().slice(0, 300)}`);
      await pipInstall(paths.python);
    } else {
      // 使える Python が無い（真っさらな macOS / Windows）。uv の公式配布で Python ごと用意する。
      log(`No usable Python 3.10+ found; using uv ${MANAGED_UV_VERSION} to provision Python ${MANAGED_UV_PYTHON}`);
      const uv = await ensureManagedUv({ platform, arch, paths, fetchImpl: options.fetchImpl, asset: options.uvAsset });
      const uvEnv = {
        ...env,
        UV_PYTHON_INSTALL_DIR: paths.uvPythonDir,
        UV_CACHE_DIR: paths.uvCacheDir,
        UV_PYTHON_PREFERENCE: "only-managed",
        UV_PYTHON_DOWNLOADS: "automatic",
        UV_NO_PROGRESS: "1",
      };
      await rm(paths.venvDir, { recursive: true, force: true });
      const created = await runCommand(uv, ["venv", "--python", MANAGED_UV_PYTHON, paths.venvDir], { timeoutMs: 10 * 60 * 1000, env: uvEnv });
      if (!created.ok) throw new Error(`uv venv が失敗した: ${`${created.stderr || created.stdout}`.trim().slice(0, 300)}`);
      const installed = await runCommand(uv, ["pip", "install", "--python", paths.python, ...PYTHON_VENV_REQUIREMENTS], { timeoutMs: 15 * 60 * 1000, env: uvEnv });
      if (!installed.ok) throw new Error(`uv pip install が失敗した: ${`${installed.stderr || installed.stdout}`.trim().slice(0, 300)}`);
    }
    const verified = await probeVenvModules(paths.python, runCommand, env);
    if (!verified.ok) throw new Error(`venv に ${verified.missing.join(", ")} が入らなかった`);
    await writeFile(path.join(paths.venvDir, "buzzassist-venv.json"), `${JSON.stringify({
      requirements: PYTHON_VENV_REQUIREMENTS,
      base: base ? { command: base.command, version: base.version } : { uv: MANAGED_UV_VERSION, python: MANAGED_UV_PYTHON },
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`).catch(() => {});
    return { ok: true, status: base ? "venv-created" : "venv-created-with-uv", python: paths.python, venvDir: paths.venvDir };
  } catch (error) {
    return { ok: false, status: "failed", detail: String(error?.message || error).slice(0, 400), venvDir: paths.venvDir };
  }
}

/** 入っている管理下の venv の Python（無ければ null）。解決器の候補に使う。 */
export function installedManagedPython(options = {}) {
  const paths = managedPythonVenvPaths(options);
  return existsSync(paths.python) ? paths.python : null;
}

// ---- tesseract ---------------------------------------------------------------------------

export function tesseractInstallHint(platform = process.platform) {
  if (platform === "darwin") return "brew install tesseract tesseract-lang";
  if (platform === "win32") return "winget install UB-Mannheim.TesseractOCR（導入時に Japanese の言語データを選ぶ）";
  return "sudo apt-get install tesseract-ocr tesseract-ocr-jpn（Debian/Ubuntu）";
}

/** 日本語の tesseract があるか。無ければ導入方法を返すだけで、自動では入れない。 */
export async function probeTesseract({ env = process.env, platform = process.platform, runCommand = runFile } = {}) {
  const command = String(env.TESSERACT_PATH || env.BUZZASSIST_TESSERACT || "").trim() || "tesseract";
  const result = await runCommand(command, ["--list-langs"], { timeoutMs: 30_000, env });
  if (!result.ok && !`${result.stdout}${result.stderr}`.trim()) {
    return { ok: false, status: "missing", hint: tesseractInstallHint(platform) };
  }
  const languages = `${result.stdout}\n${result.stderr}`.split(/\r?\n/u).map((line) => line.trim());
  if (!languages.includes("jpn")) return { ok: false, status: "missing-jpn", hint: tesseractInstallHint(platform) };
  return { ok: true, status: "present" };
}
