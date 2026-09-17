// 登録済みキャラの handoff 監査が、正しい記録を落としていた2つの原因の回帰テスト。
//
//   1. 格子の丸め: 切り抜きは Python の round()（偶数丸め）で決まるのに、
//      handoff 側は Math.round で期待値を作っていた。1672x941 の2段シートでは
//      Python が 470、Math.round が 471 を境界にするので、機械が記録した
//      正しい sourceBounds が不一致として落ちた。
//   2. 切り抜きの同一性: 再切り抜きとの一致をファイル SHA-256 で決めていたので、
//      画素が同じでも PNG の圧縮が違うだけで落ちた。
//
// どちらも「緩める」変更なので、本当に違うもの（格子から 1px を超えて外れた
// 境界、1画素でも違う切り抜き）が引き続き落ちることを同じ場所で固定する。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

import {
  identityCropMatchesFreshCrop,
  identitySheetCellBounds,
  prepareIdentityPackReviewDraft,
  REQUIRED_TURNAROUND_VIEWS,
  resolveRecordedIdentitySheetCellBounds,
  roundHalfToEven,
  validateIdentityPackReview,
} from "../lib/characterIdentityReview.mjs";
import { _testing as handoffTesting } from "../lib/koyaHandoffBundle.mjs";
import { decodePngPixels, pngPixelSha256, UnsupportedPngError } from "../lib/pngPixelDigest.mjs";

const IDENTITY_BOOLEANS = ["sameIdentity", "ageConsistent", "hairConsistent", "faceContourConsistent"];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

/**
 * テスト用の独立した PNG エンコーダ。行ごとのフィルタと圧縮レベルを選べるので、
 * 「同じ画素・違うバイト列」を意図して作れる。
 * filter は 0..4 の固定値か、行ごとに 0..4 を巡回する "cycle"。
 */
function encodePng({ width, height, colorType, data, palette = null, transparency = null }, { level = 9, filter = 0, extraChunks = [] } = {}) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const stride = width * channels;
  const rows = Buffer.alloc(height * (stride + 1));
  for (let row = 0; row < height; row += 1) {
    const filterType = filter === "cycle" ? row % 5 : filter;
    const out = row * (stride + 1);
    rows[out] = filterType;
    for (let index = 0; index < stride; index += 1) {
      const current = data[row * stride + index];
      const left = index >= channels ? data[row * stride + index - channels] : 0;
      const up = row > 0 ? data[(row - 1) * stride + index] : 0;
      const upLeft = row > 0 && index >= channels ? data[(row - 1) * stride + index - channels] : 0;
      const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filterType];
      rows[out + 1 + index] = (current - predictor) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    ...extraChunks.map(([type, payload]) => chunk(type, payload)),
    ...(palette ? [chunk("PLTE", palette)] : []),
    ...(transparency ? [chunk("tRNS", transparency)] : []),
    chunk("IDAT", deflateSync(rows, { level })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function patternedRgb(width, height, seed = 1) {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      data[offset] = (x * (seed + 3) + y * 2) % 256;
      data[offset + 1] = (y * (seed + 5) + x) % 256;
      data[offset + 2] = ((x ^ y) * (seed + 7)) % 256;
    }
  }
  return data;
}

async function writeRgbPng(pathname, width, height, seed) {
  const bytes = encodePng({ width, height, colorType: 2, data: patternedRgb(width, height, seed) });
  await mkdir(path.dirname(pathname), { recursive: true });
  await writeFile(pathname, bytes);
  return bytes;
}

function approveCell(cell, label) {
  return {
    ...cell,
    faceRegionReviewed: true,
    manualFaceRegion: [0, 0, 16, 16],
    ...Object.fromEntries(IDENTITY_BOOLEANS.map((key) => [key, true])),
    pass: true,
    note: `${label} ${cell.id} inspected at original scale`,
  };
}

/** Python の下書き生成を本物の経路で走らせ、人のレビューを埋めた記録を作る。 */
async function prepareApprovedIdentityReview(root, { turnaroundSize, expressionSize }) {
  const canvasDir = path.join(root, "canvas");
  const assets = path.join(canvasDir, "assets", "cast-fixture");
  const facePath = path.join(assets, "identity-face.png");
  const turnaroundPath = path.join(assets, "turnaround.png");
  const expressionPath = path.join(assets, "expression.png");
  const face = await writeRgbPng(facePath, 128, 128, 11);
  const turnaround = await writeRgbPng(turnaroundPath, turnaroundSize[0], turnaroundSize[1], 3);
  const expression = await writeRgbPng(expressionPath, expressionSize[0], expressionSize[1], 5);
  const workflow = { id: "identity-workflow-fixture" };
  const cast = { id: "cast-fixture", name: "山田花子" };
  const generatorContextId = "identity-generator-context-fixture";
  const identityPack = {
    selectedFace: { assetFile: facePath, sha256: sha256(face) },
    turnaround: { assetFile: turnaroundPath, sha256: sha256(turnaround) },
    expression: { assetFile: expressionPath, sha256: sha256(expression) },
    outfitSheets: [],
    generatorContextId,
  };
  const draft = await prepareIdentityPackReviewDraft({ canvasDir, workflow, cast, identityPack, generatorContextId });
  const review = draft.review;
  review.reviewer = { host: "codex", id: "identity-reviewer-fixture", contextId: "identity-review-context-fixture", reviewedAt: "2026-09-18T00:00:00.000Z" };
  review.originalScaleInspected = true;
  review.turnaround.isRealTurnaround = true;
  review.turnaround.grid.alignmentConfirmed = true;
  review.turnaround.viewChecks = review.turnaround.viewChecks.map((cell) => approveCell(cell, "turnaround"));
  review.turnaround.pass = true;
  review.turnaround.note = "eight views inspected at original scale";
  review.expression.grid.alignmentConfirmed = true;
  review.expression.cells = review.expression.cells.map((cell) => approveCell(cell, "expression"));
  review.expression.pass = true;
  review.expression.note = "twelve cells inspected at original scale";
  review.pass = true;
  review.notes = "provider-free identity fixture";
  await writeFile(draft.path, `${JSON.stringify(review, null, 2)}\n`);
  return { reviewPath: draft.path, review, workflow, cast, identityPack };
}

async function auditTurnaroundGrid(section) {
  const failures = [];
  await handoffTesting.auditSourceReviewGrid({
    section,
    label: "turnaround",
    columns: 4,
    rows: 2,
    ids: REQUIRED_TURNAROUND_VIEWS,
    booleanKeys: IDENTITY_BOOLEANS,
    failures,
  });
  return failures;
}

test("round-half-to-even matches Python round() on the grid values that used to disagree", () => {
  assert.deepEqual([0.5, 1.5, 2.5, 100.5, 470.5, 471.5, 470.49, 470.51].map(roundHalfToEven), [0, 2, 2, 100, 470, 472, 470, 471]);
  // 1672x941 の2段シート: 境界は 941/2 = 470.5。
  assert.equal(Math.round(941 / 2), 471, "Math.round rounds the half up (the old JS expectation)");
  assert.deepEqual(identitySheetCellBounds({ width: 1672, height: 941, columns: 4, rows: 2, index: 0 }), [0, 0, 418, 470]);
  assert.deepEqual(identitySheetCellBounds({ width: 1672, height: 941, columns: 4, rows: 2, index: 5 }), [418, 470, 418, 471]);
  // 幅側の .5: 402/4 = 100.5, 3*402/4 = 301.5
  assert.deepEqual(
    [0, 1, 2, 3].map((index) => identitySheetCellBounds({ width: 402, height: 201, columns: 4, rows: 2, index })),
    [[0, 0, 100, 100], [100, 0, 101, 100], [201, 0, 101, 100], [302, 0, 100, 100]],
  );
});

test("recorded sourceBounds are authoritative only while every edge stays within 1px of the grid", () => {
  const grid = { width: 1672, height: 941, columns: 4, rows: 2 };
  // Python の記録（偶数丸め）と、Math.round 流の記録のどちらも格子と矛盾しない。
  assert.deepEqual(resolveRecordedIdentitySheetCellBounds({ ...grid, index: 4, recorded: [0, 470, 418, 471] }),
    { bounds: [0, 470, 418, 471], source: "recorded", failure: "" });
  assert.deepEqual(resolveRecordedIdentitySheetCellBounds({ ...grid, index: 4, recorded: [0, 471, 418, 470] }),
    { bounds: [0, 471, 418, 470], source: "recorded", failure: "" });
  // 1px を超えて外れた辺は落ちる。
  for (const recorded of [[0, 472, 418, 469], [0, 468, 418, 473], [2, 470, 416, 471], [0, 470, 420, 471]]) {
    const result = resolveRecordedIdentitySheetCellBounds({ ...grid, index: 4, recorded });
    assert.equal(result.failure, "off-grid", JSON.stringify(recorded));
    assert.deepEqual(result.bounds, [0, 470, 418, 471], "falls back to the Python-compatible grid");
  }
  assert.equal(resolveRecordedIdentitySheetCellBounds({ ...grid, index: 4, recorded: undefined }).failure, "missing");
  assert.equal(resolveRecordedIdentitySheetCellBounds({ ...grid, index: 4, recorded: [0, 470.5, 418, 470.5] }).failure, "malformed");
  assert.equal(resolveRecordedIdentitySheetCellBounds({ ...grid, index: 4, recorded: ["0", "470", "418", "471"] }).failure, "malformed");
  assert.equal(resolveRecordedIdentitySheetCellBounds({ ...grid, index: 7, recorded: [1254, 470, 419, 471] }).failure, "outside-parent-sheet");
  assert.equal(resolveRecordedIdentitySheetCellBounds({ ...grid, width: Number.NaN, index: 4, recorded: [0, 470, 418, 471] }).failure, "invalid-grid");
});

test("a 1672x941 two-row turnaround recorded by the Python draft now passes the handoff grid check", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-grid-rounding-"));
  try {
    const { review } = await prepareApprovedIdentityReview(root, { turnaroundSize: [1672, 941], expressionSize: [400, 300] });
    const cells = review.turnaround.viewChecks;
    // Python が実際に記録した境界（偶数丸め）。Math.round なら 471 だった。
    assert.deepEqual(cells[0].sourceBounds, [0, 0, 418, 470]);
    assert.deepEqual(cells[4].sourceBounds, [0, 470, 418, 471]);
    assert.equal(cells[0].height, 470);
    assert.notEqual(Math.round(941 / 2), cells[4].sourceBounds[1], "the fixture reproduces the 470 vs 471 disagreement");
    assert.deepEqual(await auditTurnaroundGrid(review.turnaround), []);

    const offGrid = structuredClone(review.turnaround);
    offGrid.viewChecks[4].sourceBounds = [0, 472, 418, 469];
    const offGridFailures = await auditTurnaroundGrid(offGrid);
    assert.ok(offGridFailures.some((line) => /front-head\.sourceBounds does not match its required parent-sheet cell \(off-grid/u.test(line)), offGridFailures.join("\n"));

    const missing = structuredClone(review.turnaround);
    delete missing.viewChecks[1].sourceBounds;
    const missingFailures = await auditTurnaroundGrid(missing);
    assert.ok(missingFailures.some((line) => /left-profile-full-body\.sourceBounds is missing/u.test(line)), missingFailures.join("\n"));

    const wrongSize = structuredClone(review.turnaround);
    wrongSize.viewChecks[4].height = 470;
    const wrongSizeFailures = await auditTurnaroundGrid(wrongSize);
    assert.ok(wrongSizeFailures.some((line) => /front-head dimensions do not match/u.test(line)), wrongSizeFailures.join("\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PNG pixel digest ignores compression and filters but not pixels or channel layout", () => {
  const width = 23;
  const height = 17;
  const data = patternedRgb(width, height, 2);
  const digests = new Set();
  const files = new Set();
  for (const filter of [0, 1, 2, 3, 4, "cycle"]) {
    for (const level of [0, 1, 9]) {
      const bytes = encodePng({ width, height, colorType: 2, data }, { level, filter, extraChunks: level === 1 ? [["tEXt", Buffer.from("Comment\0re-encoded")]] : [] });
      const decoded = decodePngPixels(bytes);
      assert.equal(decoded.channels, "RGB");
      assert.ok(decoded.data.equals(data), `filter ${filter} level ${level} round-trips`);
      digests.add(pngPixelSha256(bytes));
      files.add(sha256(bytes));
    }
  }
  assert.equal(digests.size, 1, "identical pixels give one digest");
  assert.ok(files.size > 1, "the encodings really differ as files");

  const changed = Buffer.from(data);
  changed[3 * (5 * width + 7) + 1] ^= 1;
  assert.notEqual(pngPixelSha256(encodePng({ width, height, colorType: 2, data: changed })), [...digests][0]);

  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let index = 0; index < width * height; index += 1) data.copy(rgba, index * 4, index * 3, index * 3 + 3);
  assert.notEqual(pngPixelSha256(encodePng({ width, height, colorType: 6, data: rgba })), [...digests][0], "RGBA is a different channel layout");
  assert.equal(decodePngPixels(encodePng({ width, height, colorType: 6, data: rgba }, { filter: "cycle" })).data.equals(rgba), true);
});

test("PNG pixel decoder expands grey and palette images and refuses what it cannot decode", () => {
  const grey = encodePng({ width: 3, height: 2, colorType: 0, data: Buffer.from([0, 64, 128, 192, 250, 255]) }, { filter: "cycle" });
  assert.deepEqual([...decodePngPixels(grey).data], [0, 0, 0, 64, 64, 64, 128, 128, 128, 192, 192, 192, 250, 250, 250, 255, 255, 255]);
  const greyAlpha = encodePng({ width: 2, height: 1, colorType: 4, data: Buffer.from([10, 20, 30, 40]) });
  assert.deepEqual(decodePngPixels(greyAlpha), { width: 2, height: 1, channels: "RGBA", data: Buffer.from([10, 10, 10, 20, 30, 30, 30, 40]) });
  const palette = Buffer.from([1, 2, 3, 4, 5, 6]);
  const indexed = encodePng({ width: 2, height: 1, colorType: 3, data: Buffer.from([1, 0]), palette });
  assert.deepEqual(decodePngPixels(indexed), { width: 2, height: 1, channels: "RGB", data: Buffer.from([4, 5, 6, 1, 2, 3]) });
  const indexedAlpha = encodePng({ width: 2, height: 1, colorType: 3, data: Buffer.from([1, 0]), palette, transparency: Buffer.from([0]) });
  assert.deepEqual(decodePngPixels(indexedAlpha), { width: 2, height: 1, channels: "RGBA", data: Buffer.from([4, 5, 6, 255, 1, 2, 3, 0]) });

  assert.throws(() => decodePngPixels(Buffer.from("not a png")), UnsupportedPngError);
  const truncated = encodePng({ width: 4, height: 4, colorType: 2, data: patternedRgb(4, 4) });
  assert.throws(() => decodePngPixels(truncated.subarray(0, truncated.length - 20)), UnsupportedPngError);
  const sixteenBit = Buffer.from(truncated);
  sixteenBit[24] = 16;
  assert.throws(() => decodePngPixels(sixteenBit), /bit depth 16/u);
});

test("crop equality: same file, same pixels re-encoded, one changed pixel, and unbound bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-crop-equality-"));
  try {
    const width = 31;
    const height = 29;
    const data = patternedRgb(width, height, 4);
    const write = async (name, bytes) => {
      const pathname = path.join(root, name);
      await writeFile(pathname, bytes);
      return { path: pathname, sha256: sha256(bytes) };
    };
    const fresh = await write("fresh.png", encodePng({ width, height, colorType: 2, data }, { level: 9, filter: 4 }));
    const sameFile = await write("same-file.png", await readFile(fresh.path));
    const reencoded = await write("reencoded.png", encodePng({ width, height, colorType: 2, data }, { level: 1, filter: "cycle" }));
    const changedData = Buffer.from(data);
    changedData[0] ^= 1;
    const onePixel = await write("one-pixel.png", encodePng({ width, height, colorType: 2, data: changedData }, { level: 1, filter: "cycle" }));

    assert.notEqual(reencoded.sha256, fresh.sha256);
    assert.equal(await identityCropMatchesFreshCrop(sameFile, fresh), true);
    assert.equal(await identityCropMatchesFreshCrop(reencoded, fresh), true);
    assert.equal(await identityCropMatchesFreshCrop(onePixel, fresh), false);
    // 記録より前の書き方（ファイル一致）は、パスが無くてもそのまま通る。
    assert.equal(await identityCropMatchesFreshCrop({ sha256: fresh.sha256 }, fresh), true);
    assert.equal(await identityCropMatchesFreshCrop({ sha256: reencoded.sha256 }, fresh), false);
    // 読んだバイト列が記録の SHA-256 と違えば、画素が同じでも一致を名乗らせない。
    assert.equal(await identityCropMatchesFreshCrop({ path: reencoded.path, sha256: onePixel.sha256 }, fresh), false);
    assert.equal(await identityCropMatchesFreshCrop(reencoded, { path: fresh.path, sha256: onePixel.sha256 }), false);
    const notPng = await write("not-png.png", Buffer.from("not a png"));
    assert.equal(await identityCropMatchesFreshCrop(notPng, fresh), false);
    assert.equal(await identityCropMatchesFreshCrop({ path: path.join(root, "missing.png"), sha256: reencoded.sha256 }, fresh), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the canonical fresh recheck accepts a re-encoded crop with identical pixels and rejects a one-pixel change", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-crop-recheck-"));
  try {
    const fixture = await prepareApprovedIdentityReview(root, { turnaroundSize: [402, 201], expressionSize: [400, 300] });
    const recheckPath = (name) => path.join(root, "recheck", name, "identity-pack-review.json");
    const validate = (name) => validateIdentityPackReview({ ...fixture, machineRecheckPath: recheckPath(name) });
    await validate("unchanged");

    const reviewText = await readFile(fixture.reviewPath, "utf8");
    const target = JSON.parse(reviewText).turnaround.viewChecks[5];
    // .5 に当たるセル（x=100, 幅101）を、別の圧縮で書き直した記録にする。
    assert.deepEqual(target.sourceBounds, [100, 100, 101, 101]);
    const decoded = decodePngPixels(await readFile(target.path));
    const rewriteCrop = async (name, pixels) => {
      const bytes = encodePng({ width: decoded.width, height: decoded.height, colorType: 2, data: pixels }, { level: 1, filter: "cycle" });
      const cropPath = path.join(path.dirname(target.path), name);
      await writeFile(cropPath, bytes);
      const review = JSON.parse(reviewText);
      review.turnaround.viewChecks[5].path = cropPath;
      review.turnaround.viewChecks[5].sha256 = sha256(bytes);
      await writeFile(fixture.reviewPath, `${JSON.stringify(review, null, 2)}\n`);
      return sha256(bytes);
    };

    const reencodedSha256 = await rewriteCrop("reencoded-crop.png", decoded.data);
    assert.notEqual(reencodedSha256, target.sha256, "the re-encoded crop really is a different file");
    await validate("reencoded");

    const changed = Buffer.from(decoded.data);
    changed[changed.length - 1] ^= 1;
    await rewriteCrop("one-pixel-crop.png", changed);
    await assert.rejects(() => validate("one-pixel"), /turnaround\.viewChecks\.left-three-quarter-head\.sha256 does not match a fresh crop from the current parent sheet/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
