import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  CHROME_PATH_ENV,
  analyzeVerticalGlyphRaster,
  buildVerticalGlyphProbeSvg,
  chromeExecutableCandidates,
  probeSvgRasterizer,
  probeSvgRasterizerCached,
  rasterizeSvgDetailed,
  resetSvgRasterizerProbeCache,
  resolveChromeExecutable,
} from "../lib/svgRasterizer.mjs";

// --- 小さな PNG エンコーダ（試験用。RGB・フィルタ無し） ---------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodeRgbPng({ width, height, data }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(Buffer.from([0]), data.subarray(y * width * 3, (y + 1) * width * 3));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 白地に、字の位置ごとの図形を塗った画像を作る。painter(cellIndex, dx, dy, size) が true の画素が墨。 */
function paintProbe(layout, painter, { extraInk = [] } = {}) {
  const { width, height, cells } = layout;
  const data = Buffer.alloc(width * height * 3, 255);
  const ink = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    data.fill(17, (y * width + x) * 3, (y * width + x) * 3 + 3);
  };
  cells.forEach((cell, index) => {
    const half = Math.floor(cell.size / 2);
    for (let dy = -half; dy < half; dy += 1) {
      for (let dx = -half; dx < half; dx += 1) {
        if (painter(index, dx, dy, cell.size)) ink(cell.x + dx, cell.y + dy);
      }
    }
  });
  for (const [x, y] of extraInk) ink(x, y);
  return { width, height, channels: "RGB", data };
}

// 字ごとに違う形（横棒・縦棒・斜め）。
const distinctGlyphs = (index, dx, dy, size) => {
  const stroke = Math.max(3, Math.round(size / 10));
  if (index === 0) return Math.abs(dy) < stroke && Math.abs(dx) < size * 0.4;
  if (index === 1) return Math.abs(dx) < stroke && Math.abs(dy) < size * 0.4;
  return Math.abs(dx - dy) < stroke && Math.abs(dx) < size * 0.4;
};
// 豆腐（どの字も同じ四角の枠）。
const tofuBoxes = (_index, dx, dy, size) => {
  const edge = Math.round(size * 0.35);
  const inside = Math.abs(dx) <= edge && Math.abs(dy) <= edge;
  const border = Math.abs(dx) >= edge - 3 || Math.abs(dy) >= edge - 3;
  return inside && border;
};

// --- 探索先 ----------------------------------------------------------------

test("Windows では Program Files / LOCALAPPDATA の Chrome と Edge を探し、PATH はその後ろ", () => {
  const candidates = chromeExecutableCandidates({
    platform: "win32",
    // 素のオブジェクトでは大文字小文字が吸収されない。Windows の流儀どおり区別せずに読むこと。
    env: {
      programfiles: "C:\\Program Files",
      "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
      LocalAppData: "C:\\Users\\example\\AppData\\Local",
      Path: "C:\\Tools;\"C:\\Quoted Dir\";",
    },
    homeDir: "C:\\Users\\example",
  }).map((entry) => entry.path);
  const chromeMachine = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const chromeUser = "C:\\Users\\example\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
  const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  for (const expected of [chromeMachine, chromeUser, edge, "C:\\Tools\\chrome.exe", "C:\\Tools\\msedge.exe", "C:\\Quoted Dir\\msedge.exe"]) {
    assert.ok(candidates.includes(expected), `${expected} を探すこと`);
  }
  assert.ok(candidates.indexOf(chromeMachine) < candidates.indexOf(edge), "Chrome を Edge より先に見る");
  assert.ok(candidates.indexOf(edge) < candidates.indexOf("C:\\Tools\\chrome.exe"), "既定の置き場所を PATH より先に見る");
  assert.equal(candidates.some((entry) => entry.includes("/Applications/")), false, "macOS の置き場所を Windows で探さない");
  assert.equal(new Set(candidates).size, candidates.length, "同じ path を2回探さない");
});

test("Linux では chromium / google-chrome / chromium-browser を既定の置き場所と PATH から探す", () => {
  const candidates = chromeExecutableCandidates({
    platform: "linux",
    env: { PATH: "/opt/custom/bin:/usr/bin" },
    homeDir: "/home/example",
  }).map((entry) => entry.path);
  for (const expected of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/opt/custom/bin/chromium", "/opt/custom/bin/google-chrome"]) {
    assert.ok(candidates.includes(expected), `${expected} を探すこと`);
  }
  assert.ok(candidates.indexOf("/usr/bin/chromium") < candidates.indexOf("/snap/bin/chromium"), "snap 版（/tmp が隔離される）は後ろ");
  assert.equal(candidates.some((entry) => entry.endsWith(".exe")), false);
});

test("macOS では従来の3つに加えて、ホームの Applications も探す", () => {
  const candidates = chromeExecutableCandidates({ platform: "darwin", env: { PATH: "" }, homeDir: "/Users/example" })
    .map((entry) => entry.path);
  assert.equal(candidates[0], "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  for (const expected of [
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Users/example/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ]) assert.ok(candidates.includes(expected), expected);
});

test("明示の環境変数が最優先。指す先が無ければ、別のブラウザーへ黙って逃げずに止める", async () => {
  const everythingExists = async () => true;
  const chosen = await resolveChromeExecutable({
    platform: "linux",
    env: { [CHROME_PATH_ENV]: "/opt/pinned/chrome", PATH: "/usr/bin" },
    exists: everythingExists,
  });
  assert.equal(chosen.path, "/opt/pinned/chrome");
  assert.equal(chosen.source, "env");

  const broken = await resolveChromeExecutable({
    platform: "linux",
    env: { [CHROME_PATH_ENV]: "/opt/missing/chrome", PATH: "/usr/bin" },
    exists: async (candidate) => candidate !== "/opt/missing/chrome",
  });
  assert.equal(broken.path, "", "既定の置き場所にあっても使わない");
  assert.match(broken.error, new RegExp(CHROME_PATH_ENV, "u"));

  const windowsCase = await resolveChromeExecutable({
    platform: "win32",
    env: { buzzassist_chrome_path: "D:\\Portable\\chrome.exe" },
    exists: everythingExists,
  });
  assert.equal(windowsCase.path, "D:\\Portable\\chrome.exe", "Windows では環境変数名の大文字小文字を区別しない");

  const nothing = await resolveChromeExecutable({ platform: "linux", env: { PATH: "/usr/bin" }, exists: async () => false });
  assert.equal(nothing.path, "");
  assert.equal(nothing.error, "");
  assert.ok(nothing.checked > 3, "探した数を返す");
});

test("明示の指定が壊れていれば、描画の段階でも代替経路へ落ちずに止める", async () => {
  await assert.rejects(
    rasterizeSvgDetailed("unused.svg", "unused.png", { env: { [CHROME_PATH_ENV]: path.join("nonexistent-dir", "chrome") }, log: () => {} }),
    new RegExp(CHROME_PATH_ENV, "u"),
  );
});

// --- 読み返しの判定 ------------------------------------------------------------

test("読み返しの判定: 字ごとに違う形なら通し、豆腐・空白・横こぼれ・寸法違いは落とす", () => {
  const layout = buildVerticalGlyphProbeSvg();
  assert.match(layout.svg, /data-layout="explicit-vertical-glyph"/u, "本番と同じ縦組みの書き方を使う");
  assert.match(layout.svg, /'vert' 1,'vrt2' 1/u, "本番と同じ縦組みの字形指定を使う");

  const good = analyzeVerticalGlyphRaster(paintProbe(layout, distinctGlyphs), layout);
  assert.equal(good.ok, true, JSON.stringify(good.failures));
  assert.ok(good.maxGlyphIou < 0.5);

  const tofu = analyzeVerticalGlyphRaster(paintProbe(layout, tofuBoxes), layout);
  assert.equal(tofu.ok, false);
  assert.deepEqual(tofu.failures.map((entry) => entry.code), ["glyphs-indistinct"]);

  const blank = analyzeVerticalGlyphRaster(paintProbe(layout, (index, ...rest) => index !== 1 && distinctGlyphs(index, ...rest)), layout);
  assert.ok(blank.failures.some((entry) => entry.code === "glyph-missing"));

  // 縦に並ばず、横へ1行で出た（字の位置の外に墨がある）。
  const spillInk = [];
  for (let x = 0; x < layout.width; x += 1) for (let y = 4; y < 14; y += 1) spillInk.push([x, y]);
  const spill = analyzeVerticalGlyphRaster(paintProbe(layout, distinctGlyphs, { extraInk: spillInk }), layout);
  assert.ok(spill.failures.some((entry) => entry.code === "glyph-spill"));

  const wrongSize = analyzeVerticalGlyphRaster({ width: 10, height: 10, channels: "RGB", data: Buffer.alloc(300, 255) }, layout);
  assert.deepEqual(wrongSize.failures.map((entry) => entry.code), ["size-mismatch"]);
});

test("描画器が見つからないときは、OS ごとの直し方を返す（有料 API は呼ばない）", async () => {
  const failing = async () => { throw new Error("no rasterizer"); };
  // 既定の置き場所は PATH に依らず見るので、「どこにも無い」端末は exists の差し替えで作る
  // （CI の Ubuntu には Chrome が入っていて、PATH を空にしても見つかる）。
  const nowhere = async () => false;
  const linux = await probeSvgRasterizer({ platform: "linux", env: { PATH: "" }, rasterize: failing, exists: nowhere });
  assert.equal(linux.ok, false);
  assert.equal(linux.code, "browser-missing");
  assert.match(linux.fix, /apt install chromium/u);

  const windows = await probeSvgRasterizer({ platform: "win32", env: { Path: "" }, rasterize: failing, exists: nowhere });
  assert.equal(windows.code, "browser-missing");
  assert.match(windows.fix, /Edge/u);
  assert.match(windows.fix, new RegExp(CHROME_PATH_ENV, "u"));

  const explicit = await probeSvgRasterizer({ platform: "linux", env: { [CHROME_PATH_ENV]: "/opt/missing/chrome" }, rasterize: failing, exists: nowhere });
  assert.equal(explicit.code, "browser-explicit-missing");
});

test("ブラウザーがあるのに代替経路で描けたときは通さない（本番は毎枚ブラウザーで失敗してから落ちる）", async () => {
  const env = { [CHROME_PATH_ENV]: process.execPath };
  const probe = await probeSvgRasterizer({
    env,
    rasterize: async (_svgPath, pngPath) => {
      const layout = buildVerticalGlyphProbeSvg();
      await writeFile(pngPath, encodeRgbPng(paintProbe(layout, distinctGlyphs)));
      return { pngPath, backend: "rsvg-convert", browserPath: process.execPath, chromeFailure: "screenshot timed out" };
    },
  });
  assert.equal(probe.ok, false);
  assert.equal(probe.code, "browser-failed-fallback");
  assert.match(probe.detail, /rsvg-convert/u);
});

test("合格は同じブラウザーについて短時間だけ再利用し、再利用したと書く。不合格は覚えない", async () => {
  resetSvgRasterizerProbeCache();
  // 実行ファイルの識別（大きさ・更新時刻）を取るために、実在するファイルを「ブラウザー」に見立てる。
  const env = { [CHROME_PATH_ENV]: process.execPath };
  let calls = 0;
  let fail = true;
  const rasterize = async (_svgPath, pngPath) => {
    calls += 1;
    const layout = buildVerticalGlyphProbeSvg();
    await writeFile(pngPath, encodeRgbPng(paintProbe(layout, fail ? tofuBoxes : distinctGlyphs)));
    return { pngPath, backend: "chrome", browserPath: process.execPath, chromeFailure: "" };
  };
  let clock = 1_000_000;
  const now = () => clock;

  const failed = await probeSvgRasterizerCached({ env, rasterize, now });
  assert.equal(failed.ok, false);
  await probeSvgRasterizerCached({ env, rasterize, now });
  assert.equal(calls, 2, "不合格は覚えず、毎回測り直す");

  fail = false;
  const measured = await probeSvgRasterizerCached({ env, rasterize, now });
  assert.equal(measured.ok, true, measured.detail);
  assert.equal(measured.reusedFromMs, undefined);
  clock += 30_000;
  const reused = await probeSvgRasterizerCached({ env, rasterize, now });
  assert.equal(calls, 3, "合格は再利用する");
  assert.equal(reused.reusedFromMs, 1_000_000);
  assert.match(reused.detail, /30 秒前に実測した結果を再利用/u);

  clock += 11 * 60 * 1000;
  await probeSvgRasterizerCached({ env, rasterize, now });
  assert.equal(calls, 4, "10分を過ぎたら測り直す");
  resetSvgRasterizerProbeCache();
});

// --- 実機（CI の各 OS で必ず走る） ----------------------------------------------

function commandWorks(command, args) {
  try {
    execFileSync(command, args, { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

test("この端末の描画器で、縦書きの SVG を PNG にして読み返せる（豆腐は見抜く）", { timeout: 180_000 }, async (t) => {
  const browser = await resolveChromeExecutable();
  const fallback = commandWorks("rsvg-convert", ["--version"]) || commandWorks("magick", ["-version"]);
  if (!browser.path && !fallback) {
    // CI の skip 許可リストには載せない。CI の各 OS ではブラウザーが入っているので、
    // ここで skip したら CI は落ちる（＝ブラウザーの探索が壊れた）。
    t.skip(`SVG を描けるブラウザーも rsvg-convert / ImageMagick も無い（${browser.error || `${browser.checked} か所を探した`}）`);
    return;
  }
  const probe = await probeSvgRasterizer();
  assert.equal(probe.ok, true, `${probe.detail}\n→ ${probe.fix}`);
  if (browser.path) {
    assert.equal(probe.backend, "chrome", "ブラウザーがあるなら本番と同じくブラウザーで描く");
    assert.equal(probe.browserPath, browser.path);
  }
  assert.ok(probe.measurements.maxGlyphIou < 0.8, "違う字が違う形で描かれている");

  // 私用領域（面15）の字はどのフォントにも無い。豆腐か空白になり、判定が落とすこと。
  // 検査が「何でも通す」状態になっていないことを、実物の描画で確かめる。
  const tofu = await probeSvgRasterizer({ glyphs: ["\u{F0000}", "\u{F0001}", "\u{F0002}"] });
  assert.equal(tofu.ok, false, `フォントの無い字を通した: ${tofu.detail}`);
  assert.ok(["glyphs-indistinct", "glyph-missing"].includes(tofu.code), tofu.code);
});
