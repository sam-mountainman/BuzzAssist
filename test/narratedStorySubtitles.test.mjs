#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadFontMetrics, measureTextWidth, missingGlyphs } from "../lib/fontMetrics.mjs";
import { resolveFfmpegToolchain } from "../lib/harnessRuntimeResolver.mjs";
import {
  SUBTITLE_ABSENT_MATCH_MAX,
  SUBTITLE_FILL_MATCH_MIN,
  SUBTITLE_MIN_LUMA_CONTRAST,
  layoutNarratedSubtitles,
  layoutSubtitlePages,
  lineBreakCost,
  measureNarratedBurnedSubtitles,
  narratedSubtitleManifestEntry,
  normalizeNarratedSubtitlesConfig,
  planNarratedSubtitleCues,
  renderNarratedSubtitleOverlay,
  resolveNarratedSubtitleMedia,
  subtitleOverlayGraph,
  subtitleWeight,
} from "../lib/narratedStorySubtitles.mjs";
import {
  bandSubtitleConfig,
  ff,
  findJapaneseFontFile,
  makeTexturedStill,
  outlineSubtitleConfig,
  writeSubtitlePackFont,
} from "./fixtures/narratedVisualFixture.mjs";

const toolchain = await resolveFfmpegToolchain();
const fontPath = await findJapaneseFontFile();
const RENDER = { width: 640, height: 360, fps: 24 };

// 1字 = 1 幅の物差し（書体に依らない改行の規則の試験）。
const unit = () => 10;

test("改行: 行頭・行末の禁則と、英数字の語の中では割らない", () => {
  const characters = [..."物語です。「次」ABC、ー"];
  // 「です|。」 → 行頭に句点は来ない。
  assert.equal(lineBreakCost(characters, 3), null);
  // 「。|「」 → 句点の後ろは最も良い切れ目。
  assert.equal(lineBreakCost(characters, 4), -3);
  // 「「|次」 → 開き括弧で行を終えない。
  assert.equal(lineBreakCost(characters, 5), null);
  // 「A|B」 → 英字の語の中は割らない。
  assert.equal(lineBreakCost(characters, 8), null);
  // 「、|ー」 → 長音は行頭に来ない。
  assert.equal(lineBreakCost(characters, 11), null);
  assert.equal(lineBreakCost([..."……"], 0), null, "2つで1つの記号の間は割らない");
});

test("改行: 1行に入れば1行、入らなければ句読点を優先して行の幅をそろえ、頁に分けて時間を字数で配る", () => {
  const one = layoutSubtitlePages("短い一文です。", { charWidth: unit, maxWidthPx: 100, maxLines: 2 });
  assert.deepEqual(one.pages.map((page) => page.lines), [["短い一文です。"]]);
  const two = layoutSubtitlePages("ある町の商店街に、古い和菓子屋があった。", { charWidth: unit, maxWidthPx: 120, maxLines: 2 });
  assert.deepEqual(two.pages.map((page) => page.lines), [["ある町の商店街に、", "古い和菓子屋があった。"]]);
  // 2行に入らない文は頁に分ける（句点の後ろで切る）。
  const long = layoutSubtitlePages("最初の文は少し長めに書いてある。次の文も同じくらいの長さにしてある。", { charWidth: unit, maxWidthPx: 100, maxLines: 2 });
  assert.equal(long.pages.length, 2);
  assert.equal(long.pages[0].lines.join("").endsWith("。"), true, "頁の切れ目は句点の後ろ");
  for (const page of long.pages) {
    assert.ok(page.lines.length <= 2);
    for (const line of page.lines) assert.ok([...line].length * 10 <= 100, line);
  }
  // 行数の上限と字数の上限。
  const chars = layoutSubtitlePages("あいうえおかきくけこ", { charWidth: unit, maxWidthPx: 1000, maxLines: 2, maxCharsPerLine: 6 });
  assert.ok(chars.pages.every((page) => page.lines.every((line) => [...line].length <= 6)));
  // 1つの語が1行より長いときは止める（中点で割らない）。
  assert.deepEqual(layoutSubtitlePages("ABCDEFGHIJKLMNOP", { charWidth: unit, maxWidthPx: 50, maxLines: 2 }).problems, ["subtitle-line-too-wide"]);
  assert.equal(subtitleWeight("AB あい"), 3);
  const cues = planNarratedSubtitleCues({
    timedSegments: [{ id: "s1", startFrame: 10, frames: 30 }],
    pagesBySegment: new Map([["s1", [{ lines: ["あ"], weight: 1 }, { lines: ["いう"], weight: 2 }]]]),
  });
  assert.deepEqual(cues.cues.map((cue) => [cue.startFrame, cue.endFrame]), [[10, 20], [20, 40]], "頁の時間は字数の重みで分け、合計は文の時間と同じ");
  assert.deepEqual(planNarratedSubtitleCues({ timedSegments: [{ id: "s1", startFrame: 0, frames: 1 }], pagesBySegment: new Map([["s1", [{ lines: ["a"], weight: 1 }, { lines: ["b"], weight: 1 }]]]) }).problems, ["subtitle-segment-too-short-for-pages:s1"]);
});

test("Pack の subtitles: 書体・大きさ・色・縁か帯・位置・余白・行数が無ければ有料生成の前に止める", () => {
  assert.deepEqual(normalizeNarratedSubtitlesConfig(undefined), { config: { burnIn: false }, blockers: [] });
  assert.deepEqual(normalizeNarratedSubtitlesConfig({ burnIn: false }).config, { burnIn: false });
  const { blockers } = normalizeNarratedSubtitlesConfig({ burnIn: true, fontFile: "../outside.ttf", colour: "#fff" }, { render: RENDER });
  for (const expected of [
    "subtitles.colour-unknown",
    "subtitles.fontFile-invalid-pack-path",
    "subtitles.fontSizeRatio",
    "subtitles.textColor",
    "subtitles.outline-or-band-required",
    "subtitles.position",
    "subtitles.sideMarginRatio",
    "subtitles.maxLines",
  ]) assert.ok(blockers.includes(expected), `${expected}: ${blockers.join(", ")}`);
  const ok = normalizeNarratedSubtitlesConfig(outlineSubtitleConfig("fonts/a.ttf"), { render: RENDER });
  assert.deepEqual(ok.blockers, []);
  assert.equal(ok.config.fontSizePx, 36);
  assert.equal(ok.config.maxLineWidthPx, 640 - 2 * 38);
});

test("書体の寸法: cmap に無い字を数え、送り幅で行の幅を測る", async () => {
  assert.ok(fontPath, "日本語の書体が見つからない（Linux は fonts-noto-cjk、Windows は日本語の補助フォント）。焼き込み字幕の試験は書体なしでは確かめられない");
  const metrics = await loadFontMetrics(fontPath);
  assert.deepEqual(missingGlyphs(metrics, "物語です。"), []);
  assert.deepEqual(missingGlyphs(metrics, "\u{10FFFD}"), ["\u{10FFFD}"], "私用面の字は無い");
  const full = measureTextWidth(metrics, "あ", 100);
  assert.ok(full > 80 && full <= 110, `全角の仮名は約 1em: ${full}`);
  assert.ok(measureTextWidth(metrics, "ii", 100) < full, "半角の英字は全角より狭い");
  await assert.rejects(loadFontMetrics(Buffer.from("not a font at all")), /font-/u);
});

async function renderBase(dir, frames) {
  const still = join(dir, "still.png");
  await makeTexturedStill(toolchain, still, RENDER);
  const base = join(dir, "base.mp4");
  await ff(toolchain, [
    "-loop", "1", "-framerate", String(RENDER.fps), "-i", still,
    "-filter_complex", `[0:v]format=yuv420p,trim=end_frame=${frames},setpts=N/(${RENDER.fps}*TB),fps=${RENDER.fps}[v]`,
    "-map", "[v]", "-frames:v", String(frames), "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", base,
  ]);
  return base;
}

async function burn(dir, base, overlay, name, { x = 0 } = {}) {
  const output = join(dir, name);
  const graph = subtitleOverlayGraph({ inputIndex: 1, input: "0:v", output: "video" }).replace("overlay=x=0", `overlay=x=${x}`);
  await ff(toolchain, [
    "-i", base, "-f", "concat", "-i", overlay.listPath,
    "-filter_complex", graph, "-map", "[video]", "-frames:v", String(overlay.totalFrames),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", output,
  ]);
  return output;
}

async function prepareOverlay(dir, packConfig, segments, totalFrames) {
  const payload = join(dir, "pack");
  const fontFile = await writeSubtitlePackFont(payload, fontPath);
  const normalized = normalizeNarratedSubtitlesConfig(packConfig(fontFile), { render: RENDER });
  assert.deepEqual(normalized.blockers, []);
  const resolved = await resolveNarratedSubtitleMedia(normalized.config, payload);
  assert.deepEqual(resolved.blockers, []);
  const layout = layoutNarratedSubtitles({ segments, config: normalized.config, metrics: resolved.metrics });
  assert.deepEqual(layout.issues, []);
  const planned = planNarratedSubtitleCues({ timedSegments: segments, pagesBySegment: layout.bySegment });
  assert.deepEqual(planned.problems, []);
  const overlay = await renderNarratedSubtitleOverlay({
    ffmpeg: toolchain.ffmpeg,
    cues: planned.cues,
    config: normalized.config,
    fontPath: resolved.media.fontFile,
    fps: RENDER.fps,
    totalFrames,
    workDir: join(dir, "subtitles"),
  });
  return { overlay, config: normalized.config };
}

const SEGMENTS = [
  { id: "s001", text: "最初の物語です、次の場面へ。", startFrame: 6, frames: 20 },
  { id: "s002", text: "「感想」を話します！", startFrame: 26, frames: 18 },
  { id: "s003", text: "終わり", startFrame: 50, frames: 12 },
];
const TOTAL_FRAMES = 66;

for (const [label, packConfig] of [["縁", outlineSubtitleConfig], ["帯", bandSubtitleConfig]]) {
  test(`焼き込み字幕（${label}）: 完成 MP4 のフレームで、計画した位置・フレームに読める字幕が出て、字幕の無い間には出ない`, {
    skip: toolchain.ok ? false : "ffmpeg is unavailable",
  }, async () => {
    assert.ok(fontPath, "日本語の書体が見つからない（Linux は fonts-noto-cjk、Windows は日本語の補助フォント）");
    const dir = await mkdtemp(join(os.tmpdir(), "narrated-subtitles-"));
    try {
      const base = await renderBase(dir, TOTAL_FRAMES);
      const { overlay, config } = await prepareOverlay(dir, packConfig, SEGMENTS, TOTAL_FRAMES);
      assert.equal(overlay.cues.length, 3);
      for (const cue of overlay.cues) {
        assert.ok(cue.inkBox.x >= config.sideMarginPx && cue.inkBox.x + cue.inkBox.width <= RENDER.width - config.sideMarginPx, `${cue.id} inside margins`);
      }
      const manifest = narratedSubtitleManifestEntry(overlay, config);
      assert.equal(JSON.stringify(manifest).includes("物語"), false, "manifest には台本の字を残さない");

      const good = await measureNarratedBurnedSubtitles({ ffmpeg: toolchain.ffmpeg, videoPath: await burn(dir, base, overlay, "good.mp4"), overlay, config, fps: RENDER.fps });
      assert.equal(good.pass, true, JSON.stringify(good.cues.map((row) => [row.id, row.problems, row.metrics])));
      assert.ok(good.minimumFillMatch >= SUBTITLE_FILL_MATCH_MIN);
      assert.ok(good.minimumContrast >= SUBTITLE_MIN_LUMA_CONTRAST);

      // 壊した版 1: 焼き込みを抜いた MP4。
      const none = await measureNarratedBurnedSubtitles({ ffmpeg: toolchain.ffmpeg, videoPath: base, overlay, config, fps: RENDER.fps });
      assert.equal(none.pass, false);
      assert.ok(none.problems.includes("subtitle-not-observed-at-start"));
      assert.ok(none.cues.every((row) => row.metrics.fillMatch < SUBTITLE_FILL_MATCH_MIN));

      // 壊した版 2: 字幕を 12px 横へずらした MP4（計画した位置に出ていない）。
      const shifted = await measureNarratedBurnedSubtitles({ ffmpeg: toolchain.ffmpeg, videoPath: await burn(dir, base, overlay, "shifted.mp4", { x: 12 }), overlay, config, fps: RENDER.fps });
      assert.equal(shifted.pass, false);

      // 壊した版 3: 1フレーム早く出る一覧（頁の切り替えがずれた MP4）。
      const early = { ...overlay, listPath: join(dir, "subtitles", "early.ffconcat") };
      const list = await readFile(overlay.listPath, "utf8");
      await writeFile(early.listPath, list.replace(/^duration ([0-9.]+)$/mu, (match, value) => `duration ${(Number(value) - 1 / RENDER.fps).toFixed(6)}`), "utf8");
      const earlyResult = await measureNarratedBurnedSubtitles({ ffmpeg: toolchain.ffmpeg, videoPath: await burn(dir, base, early, "early.mp4"), overlay, config, fps: RENDER.fps });
      assert.equal(earlyResult.pass, false);
      assert.ok(earlyResult.problems.includes("subtitle-appears-before-its-start"), earlyResult.problems.join(", "));
      assert.ok(earlyResult.cues[0].metrics.previousFrameFillMatch > SUBTITLE_ABSENT_MATCH_MAX);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("焼き込み字幕: 字と縁を同じ明るさにした読めない字幕は、字が出ていても明るさの差で落ちる", {
  skip: toolchain.ok ? false : "ffmpeg is unavailable",
}, async () => {
  assert.ok(fontPath, "日本語の書体が見つからない");
  const dir = await mkdtemp(join(os.tmpdir(), "narrated-subtitles-illegible-"));
  try {
    const base = await renderBase(dir, TOTAL_FRAMES);
    const { overlay, config } = await prepareOverlay(dir, (fontFile) => outlineSubtitleConfig(fontFile, { textColor: "#101010", outline: { color: "#000000", widthRatio: 0.12 } }), SEGMENTS, TOTAL_FRAMES);
    const result = await measureNarratedBurnedSubtitles({ ffmpeg: toolchain.ffmpeg, videoPath: await burn(dir, base, overlay, "illegible.mp4"), overlay, config, fps: RENDER.fps });
    assert.equal(result.pass, false);
    assert.ok(result.problems.includes("subtitle-contrast-too-low"), result.problems.join(", "));
    assert.ok(result.minimumContrast < SUBTITLE_MIN_LUMA_CONTRAST);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pack の書体に無い字・画面に収まらない配置は、描く前に止める", { skip: toolchain.ok ? false : "ffmpeg is unavailable" }, async () => {
  assert.ok(fontPath, "日本語の書体が見つからない");
  const dir = await mkdtemp(join(os.tmpdir(), "narrated-subtitles-preflight-"));
  try {
    await mkdir(join(dir, "pack"), { recursive: true });
    const fontFile = await writeSubtitlePackFont(join(dir, "pack"), fontPath);
    const normalized = normalizeNarratedSubtitlesConfig(outlineSubtitleConfig(fontFile), { render: RENDER });
    const resolved = await resolveNarratedSubtitleMedia(normalized.config, join(dir, "pack"));
    const layout = layoutNarratedSubtitles({ segments: [{ id: "s001", text: "物語\u{10FFFD}です" }], config: normalized.config, metrics: resolved.metrics });
    assert.ok(layout.issues.some((issue) => issue.startsWith("subtitle-font-missing-glyphs:1:U+10FFFD")), layout.issues.join(", "));
    assert.equal(layout.issues.join(",").includes("物語"), false, "理由に台本の字を入れない");
    const low = normalizeNarratedSubtitlesConfig(outlineSubtitleConfig(fontFile, { position: { anchor: "bottom", baselineRatio: 0.98 } }), { render: RENDER });
    assert.ok((await resolveNarratedSubtitleMedia(low.config, join(dir, "pack"))).blockers.includes("subtitles.position-outside-frame"));
    const band = normalizeNarratedSubtitlesConfig(bandSubtitleConfig(fontFile, { band: { color: "#ffffff", opacity: 0.6, topRatio: 0.9 } }), { render: RENDER });
    assert.ok((await resolveNarratedSubtitleMedia(band.config, join(dir, "pack"))).blockers.includes("subtitles.band.topRatio-below-text"));
    assert.deepEqual((await resolveNarratedSubtitleMedia({ ...normalized.config, fontFile: "fonts/missing.ttf" }, join(dir, "pack"))).blockers, ["subtitles.fontFile-missing"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
