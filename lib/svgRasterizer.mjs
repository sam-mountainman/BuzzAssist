// 吹き出しの SVG を PNG にする描画器（ブラウザー）と、それが本当に描けるかの検査。
//
// なぜ独立したファイルか:
// 本番の描画（mangaVideoPipeline）と doctor の検査が、同じ探索順・同じ起動引数・
// 同じ代替経路を通るようにするため。doctor が別の書き方で「描けた」と言っても、
// 本番が別のブラウザーや別の引数で落ちるなら、それは確かめたことにならない。
//
// 探索先が macOS の既定の置き場所だけだった（2026-09-25 の外部レビュー）。
// Windows と Linux ではブラウザーが見つからず、rsvg-convert も ImageMagick も
// 無ければ、有料の画像と音声を作り終えたあとの吹き出し合成で止まっていた。
// ここでは次の順に探す。
//
//   1. 環境変数 BUZZASSIST_CHROME_PATH（明示。指す先が無ければ他へ逃げずに止める）
//   2. OS ごとの既定の置き場所（Chrome → Chromium → Edge）
//   3. PATH 上の名前（chrome.exe / msedge.exe、google-chrome / chromium など）
//
// 明示の指定を黙って別のブラウザーへ差し替えないのは、縦組みの字形がブラウザーと
// フォントで変わるから。運営者が選んだものと違う描画器で作った吹き出しを
// 「指定どおり」と見せない。

import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { decodePngPixels } from "./pngPixelDigest.mjs";
import { speechBubbleProfile, VERTICAL_ROTATING_FEATURES } from "./speechBubbleRenderer.mjs";

export const CHROME_PATH_ENV = "BUZZASSIST_CHROME_PATH";
export const SVG_RASTERIZER_PROBE_VERSION = "svg-rasterizer-probe-v1";

const DEFAULT_SVG_WIDTH = 1920;
const DEFAULT_SVG_HEIGHT = 1080;

// PATH から探す名前。macOS はアプリの置き場所が決まっているので PATH は補助。
const PATH_EXECUTABLE_NAMES = Object.freeze({
  win32: Object.freeze(["chrome.exe", "msedge.exe"]),
  darwin: Object.freeze(["google-chrome", "chromium", "microsoft-edge"]),
  linux: Object.freeze([
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "microsoft-edge-stable",
    "microsoft-edge",
  ]),
});

/**
 * Windows の環境変数は大文字小文字を区別しない（`ProgramFiles` と `PROGRAMFILES` は同じ）。
 * process.env はそれを吸収するが、試験や子プロセスへ渡す素のオブジェクトは吸収しない。
 */
function envValue(env, name, platform) {
  if (!env || typeof env !== "object") return "";
  if (Object.hasOwn(env, name)) return String(env[name] ?? "");
  if (platform !== "win32") return "";
  const lower = name.toLowerCase();
  const key = Object.keys(env).find((entry) => entry.toLowerCase() === lower);
  return key ? String(env[key] ?? "") : "";
}

function platformPath(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * 既定の置き場所と PATH から作る候補（明示の環境変数は含めない）。順番が優先順。
 * 同じ path は1回だけ。
 */
export function chromeExecutableCandidates({
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
} = {}) {
  const p = platformPath(platform);
  const candidates = [];
  const push = (value, source) => {
    const candidate = String(value || "").trim();
    if (!candidate || !p.isAbsolute(candidate)) return;
    if (candidates.some((entry) => entry.path === candidate)) return;
    candidates.push({ path: candidate, source });
  };

  if (platform === "darwin") {
    for (const app of ["Google Chrome", "Chromium", "Microsoft Edge"]) {
      push(`/Applications/${app}.app/Contents/MacOS/${app}`, "default");
      if (homeDir) push(p.join(homeDir, "Applications", `${app}.app`, "Contents", "MacOS", app), "default");
    }
  } else if (platform === "win32") {
    const programFiles = envValue(env, "ProgramFiles", platform);
    const programFilesX86 = envValue(env, "ProgramFiles(x86)", platform);
    const localAppData = envValue(env, "LOCALAPPDATA", platform);
    const under = (root, ...segments) => (root ? p.join(root, ...segments) : "");
    // Chrome は machine-wide（Program Files）と per-user（LOCALAPPDATA）の両方がある。
    push(under(programFiles, "Google", "Chrome", "Application", "chrome.exe"), "default");
    push(under(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"), "default");
    push(under(localAppData, "Google", "Chrome", "Application", "chrome.exe"), "default");
    push(under(localAppData, "Chromium", "Application", "chrome.exe"), "default");
    // Edge は Windows 10/11 に標準で入っている（既定は Program Files (x86)）。
    push(under(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"), "default");
    push(under(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"), "default");
    push(under(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"), "default");
  } else {
    for (const fixed of [
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/opt/google/chrome/chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge-stable",
      "/usr/bin/microsoft-edge",
      // snap 版は /tmp が隔離されていて描けないことがある。最後に回し、描けるかは doctor が実際に確かめる。
      "/snap/bin/chromium",
    ]) push(fixed, "default");
  }

  const names = PATH_EXECUTABLE_NAMES[platform] || PATH_EXECUTABLE_NAMES.linux;
  const delimiter = platform === "win32" ? ";" : ":";
  for (const dir of envValue(env, "PATH", platform).split(delimiter)) {
    const trimmed = dir.trim().replace(/^"(.*)"$/u, "$1");
    if (!trimmed) continue;
    for (const name of names) push(p.join(trimmed, name), "path");
  }
  return candidates;
}

async function isExecutableFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * 使うブラウザーを1つ決める。
 *
 * 戻り値の `error` が空でなければ、明示の指定が壊れている（黙って別のブラウザーへ
 * 逃げない）。`path` が空で `error` も空なら、どこにも見つからなかった。
 */
export async function resolveChromeExecutable({
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  exists = isExecutableFile,
} = {}) {
  const explicit = envValue(env, CHROME_PATH_ENV, platform).trim();
  if (explicit) {
    if (await exists(explicit)) return { path: explicit, source: "env", explicit: true, error: "", checked: 1 };
    return {
      path: "",
      source: "env",
      explicit: true,
      error: `${CHROME_PATH_ENV} が指す先に実行ファイルが無い（${explicit}）。指定を直すか外すこと。別のブラウザーへは黙って切り替えない`,
      checked: 1,
    };
  }
  const candidates = chromeExecutableCandidates({ env, platform, homeDir });
  for (const candidate of candidates) {
    if (await exists(candidate.path)) {
      return { path: candidate.path, source: candidate.source, explicit: false, error: "", checked: candidates.length };
    }
  }
  return { path: "", source: "", explicit: false, error: "", checked: candidates.length };
}

function runTool(command, args, { env = process.env, timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message || error).slice(-3000);
        rejectPromise(new Error(`${command} failed: ${detail}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function terminateBrowserTree(child, signal, detached) {
  try {
    if (detached) {
      process.kill(-child.pid, signal);
      return;
    }
    if (process.platform === "win32" && child.pid) {
      // Windows の child.kill は親だけを止め、描画用の子プロセスが user-data-dir を
      // 掴んだまま残る。木ごと止める。
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      return;
    }
    child.kill(signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

async function runChromeScreenshot(chromePath, args, pngPath, { env = process.env, timeoutMs = 45_000 } = {}) {
  await unlink(pngPath).catch(() => {});
  const detached = process.platform !== "win32";
  const child = spawn(chromePath, args, {
    env,
    stdio: ["ignore", "ignore", "ignore"],
    detached,
    windowsHide: true,
  });
  let spawnError = null;
  let closed = false;
  const closedPromise = new Promise((resolvePromise) => {
    child.once("error", (error) => {
      spawnError = error;
      resolvePromise();
    });
    child.once("close", resolvePromise);
  }).finally(() => { closed = true; });
  const startedAt = Date.now();
  let previousSize = -1;
  let stableChecks = 0;
  while (Date.now() - startedAt < timeoutMs) {
    if (spawnError) throw spawnError;
    let size = 0;
    try {
      size = (await stat(pngPath)).size;
    } catch {
      size = 0;
    }
    if (size > 0 && size === previousSize) stableChecks += 1;
    else stableChecks = 0;
    previousSize = size;
    if (stableChecks >= 2) {
      // Chrome can expose the screenshot file before SVG vertical-writing and
      // local Japanese font shaping have completed.  Give the headless page
      // its virtual-time budget before terminating a lingering browser;
      // otherwise the partially painted fallback looks like horizontal text
      // spilling out of the balloon.
      await Promise.race([closedPromise, new Promise((resolvePromise) => setTimeout(resolvePromise, 2_500))]);
      // Chrome can leave its browser process alive after the launcher has
      // reported a completed screenshot. Isolating the job in its own process
      // group lets us clean up the complete browser tree deterministically.
      if (!closed) terminateBrowserTree(child, "SIGTERM", detached);
      await Promise.race([closedPromise, new Promise((resolvePromise) => setTimeout(resolvePromise, 500))]);
      if (!closed && child.exitCode === null) terminateBrowserTree(child, "SIGKILL", detached);
      return pngPath;
    }
    if (closed && size === 0) throw new Error(`${chromePath} exited before writing ${pngPath}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
  }
  terminateBrowserTree(child, "SIGTERM", detached);
  await Promise.race([closedPromise, new Promise((resolvePromise) => setTimeout(resolvePromise, 500))]);
  if (!closed && child.exitCode === null) {
    terminateBrowserTree(child, "SIGKILL", detached);
    await Promise.race([closedPromise, new Promise((resolvePromise) => setTimeout(resolvePromise, 500))]);
  }
  throw new Error(`${chromePath} did not finish screenshot ${pngPath} within ${timeoutMs}ms`);
}

function svgDimension(source, attribute, fallback) {
  const match = source.match(new RegExp(`<svg[^>]*\\b${attribute}=["']([0-9.]+)`, "i"));
  const parsed = Number(match?.[1]);
  return Math.max(1, Math.round(Number.isFinite(parsed) ? parsed : fallback));
}

async function rasterizeSvgWithChrome(chromePath, svgPath, pngPath, { env = process.env } = {}) {
  const source = await readFile(svgPath, "utf8");
  const width = svgDimension(source, "width", DEFAULT_SVG_WIDTH);
  const height = svgDimension(source, "height", DEFAULT_SVG_HEIGHT);
  const profileDir = path.join(path.dirname(pngPath), `.chrome-${process.pid}-${path.basename(pngPath)}`);
  try {
    // NOTE: --run-all-compositor-stages-before-draw makes Chrome 151+
    // hang at exit after the screenshot is written, which stalled whole
    // renders and silently degraded typography via the sips fallback
    // (ledger R64). Never re-add it.
    // Plain --headless (not =new): on Chrome 151 the =new mode never
    // exits after writing the screenshot and its helper tree escapes the
    // process-group kill, so zombies accumulate until fresh launches time
    // out mid-render. Plain --headless exits cleanly by itself.
    // file URL は pathToFileURL で作る。`file://${path}` は Windows の
    // `C:\...` を URL にできず、日本語や空白を含む path も壊す。
    await runChromeScreenshot(chromePath, [
      "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
      "--no-first-run", "--disable-extensions", "--virtual-time-budget=1500",
      `--user-data-dir=${profileDir}`,
      "--default-background-color=00000000", `--window-size=${width},${height}`,
      `--screenshot=${pngPath}`, pathToFileURL(path.resolve(svgPath)).href,
    ], pngPath, { env });
    if ((await stat(pngPath)).size > 0) return pngPath;
    throw new Error(`${chromePath} wrote an empty screenshot ${pngPath}`);
  } finally {
    // 1枚ごとの使い捨てプロファイル。残すと吹き出しの枚数ぶん作業フォルダに溜まる。
    await rm(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
}

/**
 * SVG を PNG にする。どの描画器を使ったかも返す（doctor が報告に使う）。
 *
 * 順番: ブラウザー（Chrome / Chromium / Edge）→ rsvg-convert → ImageMagick →
 * （macOS だけ）sips。sips は縦組みの1字ずつの配置を描けないので、
 * 縦組みの吹き出しでは使わずに止める。
 */
export async function rasterizeSvgDetailed(svgPath, pngPath, {
  env = process.env,
  platform = process.platform,
  log = (message) => console.error(message),
} = {}) {
  const chrome = await resolveChromeExecutable({ env, platform });
  if (chrome.error) throw new Error(chrome.error);
  let chromeFailure = "";
  if (chrome.path) {
    try {
      await rasterizeSvgWithChrome(chrome.path, svgPath, pngPath, { env });
      return { pngPath, backend: "chrome", browserPath: chrome.path, browserSource: chrome.source, chromeFailure: "" };
    } catch (error) {
      // Surface the actual Chrome failure before falling through — silent
      // fallbacks hid the R64 regression for a whole render cycle.
      chromeFailure = error instanceof Error ? error.message : String(error);
      log(`[rasterizeSvg] chrome failed for ${path.basename(svgPath)}: ${chromeFailure}`);
    }
  }
  const base = { pngPath, browserPath: chrome.path, browserSource: chrome.source, chromeFailure };
  try {
    await runTool("rsvg-convert", ["-o", pngPath, svgPath], { env });
    return { ...base, backend: "rsvg-convert" };
  } catch {
    try {
      await runTool("magick", [svgPath, pngPath], { env });
      return { ...base, backend: "magick" };
    } catch {
      if (platform === "darwin") {
        // sips cannot render the per-glyph vertical typography (no
        // dominant-baseline / vert feature support) — glyph columns come out
        // skewed and overlapping. Failing loudly beats shipping broken text.
        const source = await readFile(svgPath, "utf8");
        if (source.includes("explicit-vertical-glyph")) {
          throw new Error(
            `No capable SVG rasterizer for vertical-glyph overlay ${svgPath}: `
            + "Chrome headless failed and rsvg-convert/magick are unavailable. "
            + "Fix Chrome or `brew install librsvg` — sips output is not acceptable for speech bubbles.",
          );
        }
        await runTool("sips", ["-s", "format", "png", svgPath, "--out", pngPath], { env });
        return { ...base, backend: "sips" };
      }
      throw new Error(
        "SVG rasterization requires Chrome/Chromium/Edge, rsvg-convert, or ImageMagick"
        + (chrome.path ? ` (browser ${chrome.path} failed: ${chromeFailure.slice(0, 200)})` : ` (no browser found; set ${CHROME_PATH_ENV})`)
        + ".",
      );
    }
  }
}

export async function rasterizeSvg(svgPath, pngPath, options = {}) {
  const result = await rasterizeSvgDetailed(svgPath, pngPath, options);
  return result.pngPath;
}

// --- 描けるかの検査（doctor の svg-rasterizer） ---------------------------------

// 別々の字。豆腐（フォントが無いときの四角）は字が違っても同じ形になるので、
// 形が互いに違うことを「日本語の字形が出た」ことの証拠にする。
const PROBE_GLYPHS = Object.freeze(["縦", "書", "き"]);
const PROBE_FONT_SIZE = 64;
const PROBE_CELL_ADVANCE = 104;
const PROBE_WIDTH = 320;
const PROBE_MARGIN_TOP = 72;

function escapeXml(value) {
  return String(value).replace(/[&<>"']/gu, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;",
  })[char]);
}

/**
 * 本番の吹き出しと同じ書き方（1字ずつ座標を置く explicit-vertical-glyph、同じフォント
 * スタック、同じ vert/vrt2 指定）で、1列の縦書きを作る。字の中心座標も返す。
 */
export function buildVerticalGlyphProbeSvg({ glyphs = PROBE_GLYPHS, fontFamily = speechBubbleProfile().fontFamily } = {}) {
  const fontSize = PROBE_FONT_SIZE;
  const columnX = PROBE_WIDTH / 2;
  const height = PROBE_MARGIN_TOP * 2 + PROBE_CELL_ADVANCE * (glyphs.length - 1);
  const cells = glyphs.map((char, index) => ({ char, x: columnX, y: PROBE_MARGIN_TOP + index * PROBE_CELL_ADVANCE, size: fontSize }));
  const text = cells.map((cell) => `<text x="${cell.x}" y="${cell.y}" fill="#111111" data-layout="explicit-vertical-glyph" data-glyph-kind="character" xml:lang="ja" text-anchor="middle" dominant-baseline="central" alignment-baseline="central" font-family="${escapeXml(fontFamily)}" font-size="${fontSize}" font-weight="400" style="${VERTICAL_ROTATING_FEATURES}">${escapeXml(cell.char)}</text>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PROBE_WIDTH}" height="${height}" viewBox="0 0 ${PROBE_WIDTH} ${height}"><rect x="0" y="0" width="${PROBE_WIDTH}" height="${height}" fill="#ffffff"/>${text}</svg>`;
  return { svg, width: PROBE_WIDTH, height, cells };
}

function cellBounds(cell, width, height, scale = 0.62) {
  const half = cell.size * scale;
  return {
    left: Math.max(0, Math.floor(cell.x - half)),
    right: Math.min(width, Math.ceil(cell.x + half)),
    top: Math.max(0, Math.floor(cell.y - half)),
    bottom: Math.min(height, Math.ceil(cell.y + half)),
  };
}

/**
 * 読み返した PNG を、字の位置ごとに見る。
 *
 * - 寸法が SVG と同じ
 * - どの字の位置にも墨がある（空白で終わっていない）
 * - 字の位置の外に墨がほとんど無い（横へこぼれていない＝縦に並んでいる）
 * - 字どうしの形が違う（豆腐＝フォント無しの四角が並んでいない）
 */
export function analyzeVerticalGlyphRaster(decoded, { width, height, cells }) {
  const failures = [];
  if (!decoded || decoded.width !== width || decoded.height !== height) {
    failures.push({ code: "size-mismatch", detail: `PNG ${decoded?.width}x${decoded?.height} / 期待 ${width}x${height}` });
    return { ok: false, failures, cells: [] };
  }
  const channelCount = decoded.channels === "RGBA" ? 4 : 3;
  const isInk = (x, y) => {
    const offset = (y * width + x) * channelCount;
    const alpha = channelCount === 4 ? decoded.data[offset + 3] : 255;
    if (alpha < 128) return false;
    const luminance = 0.299 * decoded.data[offset] + 0.587 * decoded.data[offset + 1] + 0.114 * decoded.data[offset + 2];
    return luminance < 128;
  };
  const bounds = cells.map((cell) => cellBounds(cell, width, height));
  const insideAnyCell = (x, y) => bounds.some((box) => x >= box.left && x < box.right && y >= box.top && y < box.bottom);
  let totalInk = 0;
  let outsideInk = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isInk(x, y)) continue;
      totalInk += 1;
      if (!insideAnyCell(x, y)) outsideInk += 1;
    }
  }
  const masks = bounds.map((box) => {
    const w = box.right - box.left;
    const h = box.bottom - box.top;
    const mask = new Uint8Array(w * h);
    let ink = 0;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (isInk(box.left + x, box.top + y)) {
          mask[y * w + x] = 1;
          ink += 1;
        }
      }
    }
    return { w, h, mask, ink, ratio: ink / Math.max(1, w * h) };
  });
  const cellReport = masks.map((entry, index) => ({ char: cells[index].char, inkRatio: Number(entry.ratio.toFixed(4)) }));
  const blank = cellReport.filter((entry) => entry.inkRatio < 0.02);
  if (blank.length > 0) failures.push({ code: "glyph-missing", detail: `字が描かれていない位置がある（${blank.map((entry) => entry.char).join("")}）` });
  const filled = cellReport.filter((entry) => entry.inkRatio > 0.75);
  if (filled.length > 0) failures.push({ code: "glyph-filled", detail: `字の位置が塗りつぶされている（${filled.map((entry) => entry.char).join("")}）` });
  const outsideRatio = totalInk > 0 ? outsideInk / totalInk : 0;
  if (totalInk > 0 && outsideRatio > 0.03) {
    failures.push({ code: "glyph-spill", detail: `字の位置の外に墨が ${(outsideRatio * 100).toFixed(1)}% ある（縦に並ばず横へこぼれている）` });
  }
  // 字どうしの一致度（IoU）。豆腐なら全部ほぼ同じ形になる。
  let maxIou = 0;
  for (let a = 0; a < masks.length; a += 1) {
    for (let b = a + 1; b < masks.length; b += 1) {
      const left = masks[a];
      const right = masks[b];
      if (left.w !== right.w || left.h !== right.h) continue;
      let intersection = 0;
      let union = 0;
      for (let index = 0; index < left.mask.length; index += 1) {
        const l = left.mask[index];
        const r = right.mask[index];
        if (l && r) intersection += 1;
        if (l || r) union += 1;
      }
      if (union > 0) maxIou = Math.max(maxIou, intersection / union);
    }
  }
  if (blank.length === 0 && maxIou > 0.8) {
    failures.push({ code: "glyphs-indistinct", detail: `違う字が同じ形で描かれた（一致度 ${(maxIou * 100).toFixed(0)}%）。日本語フォントが無く豆腐になっている` });
  }
  return {
    ok: failures.length === 0,
    failures,
    cells: cellReport,
    outsideInkRatio: Number(outsideRatio.toFixed(4)),
    maxGlyphIou: Number(maxIou.toFixed(4)),
  };
}

function rasterizerFix(platform, { codes = [], browserMissing = false, explicitError = "" } = {}) {
  if (explicitError) return `${CHROME_PATH_ENV} を、実在する Chrome / Edge / Chromium の実行ファイルへ直すか、外して既定の探索に任せる`;
  if (browserMissing) {
    if (platform === "win32") {
      return "Microsoft Edge か Google Chrome を入れる（Windows 10/11 には Edge が標準で入っている）。別の場所にあるなら "
        + `${CHROME_PATH_ENV} に msedge.exe / chrome.exe のフルパスを入れる`;
    }
    if (platform === "darwin") {
      return `Google Chrome を入れる（/Applications に置く）か、${CHROME_PATH_ENV} に Chrome / Edge / Chromium の実行ファイルのパスを入れる。`
        + "`brew install librsvg`（rsvg-convert）でも描けるが、字形は Chrome と同じにならない";
    }
    return "Chromium か Google Chrome を入れる（例: `sudo apt install chromium` / Google の .deb）。"
      + `別の場所にあるなら ${CHROME_PATH_ENV} に実行ファイルのパスを入れる`;
  }
  if (codes.includes("glyphs-indistinct") || codes.includes("glyph-missing")) {
    if (platform === "linux") return "日本語フォントが無い。`sudo apt install fonts-noto-cjk`（Fedora は google-noto-serif-cjk-jp-fonts）を入れてから doctor をやり直す";
    if (platform === "win32") return "日本語フォントが無い。設定 → 時刻と言語 → 言語 で「日本語」を追加し、日本語の補助フォントを入れてから doctor をやり直す";
    return "日本語フォント（ヒラギノ明朝）が使えない。フォントを無効にしていないか Font Book で確かめる";
  }
  return "描画器の版を確かめる（Chrome を更新する、または別のブラウザーを "
    + `${CHROME_PATH_ENV} で指定する）。縦組みの吹き出しが崩れたまま有料生成を始めない`;
}

// 合格だけを、同じブラウザーの実行ファイル（path・大きさ・更新時刻）に限って短時間覚える。
// ブラウザーの起動は1回5秒前後かかり、MCP サーバーのように長く生きるプロセスでは
// doctor が何度も呼ばれる。不合格は覚えない（フォントを入れた直後のやり直しを
// 古い結果で止めない）。ブラウザーが更新されれば大きさか更新時刻が変わり、測り直す。
const PROBE_CACHE_TTL_MS = 10 * 60 * 1000;
const probeCache = new Map();

async function browserIdentity(browserPath) {
  if (!browserPath) return "";
  try {
    const info = await stat(browserPath);
    return `${browserPath}\n${info.size}\n${info.mtimeMs}`;
  } catch {
    return "";
  }
}

export function resetSvgRasterizerProbeCache() {
  probeCache.clear();
}

/**
 * probeSvgRasterizer の結果を、同じブラウザーについて10分だけ再利用する。
 * 再利用したときは `reusedFromMs` と detail に「何秒前の実測か」を書く（測っていない
 * 今回を「測った」とは書かない）。
 */
export async function probeSvgRasterizerCached(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const now = typeof options.now === "function" ? options.now() : Date.now();
  const resolved = await resolveChromeExecutable({ env, platform });
  const identity = resolved.error ? "" : await browserIdentity(resolved.path);
  const key = identity ? `${platform}\n${identity}` : "";
  const cached = key ? probeCache.get(key) : null;
  if (cached && now - cached.measuredAt < PROBE_CACHE_TTL_MS) {
    const ageSeconds = Math.max(0, Math.round((now - cached.measuredAt) / 1000));
    return {
      ...cached.result,
      reusedFromMs: cached.measuredAt,
      detail: `${cached.result.detail}（同じブラウザーで ${ageSeconds} 秒前に実測した結果を再利用）`,
    };
  }
  const result = await probeSvgRasterizer({ ...options, env, platform });
  if (key && result.ok) probeCache.set(key, { measuredAt: now, result });
  return result;
}

/**
 * 縦書きの小さな SVG を本番と同じ rasterizeSvg で PNG にし、読み返して確かめる。
 * 有料 API は呼ばない。ブラウザーを1回起動するだけ。
 */
export async function probeSvgRasterizer({
  env = process.env,
  platform = process.platform,
  glyphs = PROBE_GLYPHS,
  workDir = "",
  rasterize = rasterizeSvgDetailed,
  // 試験で「この OS の既定の置き場所にブラウザーが無い端末」を作るための差し替え口。
  // 既定の置き場所は PATH に依らず見るので、PATH を空にしただけでは CI の Ubuntu（Chrome 入り）で見つかる。
  exists = undefined,
} = {}) {
  const resolved = await resolveChromeExecutable({ env, platform, ...(exists ? { exists } : {}) });
  const base = {
    version: SVG_RASTERIZER_PROBE_VERSION,
    browserPath: resolved.path || null,
    browserSource: resolved.source || null,
  };
  if (resolved.error) {
    return { ...base, ok: false, code: "browser-explicit-missing", detail: resolved.error, fix: rasterizerFix(platform, { explicitError: resolved.error }) };
  }
  const dir = workDir || await mkdtemp(path.join(tmpdir(), "buzzassist-svg-probe-"));
  const svgPath = path.join(dir, "vertical-probe.svg");
  const pngPath = path.join(dir, "vertical-probe.png");
  try {
    const probe = buildVerticalGlyphProbeSvg({ glyphs });
    await writeFile(svgPath, probe.svg, "utf8");
    let result;
    try {
      result = await rasterize(svgPath, pngPath, { env, platform, log: () => {} });
    } catch (error) {
      const message = String(error?.message || error).slice(0, 240);
      return {
        ...base,
        ok: false,
        code: resolved.path ? "rasterize-failed" : "browser-missing",
        detail: resolved.path
          ? `縦書きの試しの SVG を PNG にできない: ${message}`
          : `SVG を PNG にする描画器が無い（Chrome / Edge / Chromium を ${resolved.checked} か所探した）: ${message}`,
        fix: rasterizerFix(platform, { browserMissing: !resolved.path }),
      };
    }
    let decoded;
    try {
      decoded = decodePngPixels(await readFile(pngPath));
    } catch (error) {
      return {
        ...base,
        ok: false,
        code: "png-unreadable",
        backend: result.backend,
        detail: `描画器（${result.backend}）の PNG を読み返せない: ${String(error?.message || error).slice(0, 160)}`,
        fix: rasterizerFix(platform),
      };
    }
    const analysis = analyzeVerticalGlyphRaster(decoded, probe);
    const backendLabel = result.backend === "chrome" ? `${result.backend}: ${result.browserPath}` : result.backend;
    // 本番はブラウザーを先に使う。ブラウザーが見つかったのに代替経路で描けたのなら、
    // 本番も毎枚ブラウザーで失敗してから代替経路へ落ちる。字形も変わるので通さない。
    const chromeFellBack = Boolean(resolved.path) && result.backend !== "chrome";
    const ok = analysis.ok && !chromeFellBack;
    const codes = analysis.failures.map((entry) => entry.code);
    return {
      ...base,
      ok,
      backend: result.backend,
      ...(ok ? {} : { code: chromeFellBack ? "browser-failed-fallback" : codes[0] }),
      measurements: {
        cells: analysis.cells,
        outsideInkRatio: analysis.outsideInkRatio,
        maxGlyphIou: analysis.maxGlyphIou,
      },
      detail: ok
        ? `縦書き ${glyphs.length} 字の SVG を PNG にして読み返した（${backendLabel}、字の一致度 ${Math.round((analysis.maxGlyphIou || 0) * 100)}%）`
        : chromeFellBack
          ? `ブラウザー（${resolved.path}）で描けず ${result.backend} に落ちた: ${result.chromeFailure.slice(0, 160)}`
          : `縦書きの読み返しが通らない（${backendLabel}）: ${analysis.failures.map((entry) => entry.detail).join(" / ")}`,
      fix: ok ? "" : rasterizerFix(platform, { codes }),
    };
  } finally {
    if (!workDir) await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
}
