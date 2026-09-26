// 途中の成果物の品質ループの、ページ単位の人の確認（verify-pages）。人の確認が要る対象を数枚ずつのページ画像に
// 並べ、運営者がページごとに答える。守ること: 対話端末と --human-verified が要る・各画は短い辺 720px 以上で拡大と
// 承認済みの設定画も並べる・短すぎる答えは受け付けない・記録は対象ごとで1つの否は他の可を消さない・途中でやめても
// 答えたページまで残り残りから続く・画が変わった対象は記録しない。
// 対話端末（ask）・ページを開く（openPage）・タイルの画素（renderTile）・時計（now）は差し替える（壁時計は使わない）。
// 人物・会話 id・対象 id・所見はすべて合成の値。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path, { join } from "node:path";
import test from "node:test";

import {
  APPROVED_REFERENCES_VERSION,
  assetQualityPaths,
  assetQualityStatus,
  createAssetQualityContract,
  recordAssetPageVerification,
  recordAssetQualityRound,
  startAssetQualityLoop,
} from "../lib/assetQualityLoop.mjs";
import {
  ASSET_VERIFY_PAGE_DIR,
  ASSET_VERIFY_PAGE_MAX_ITEMS,
  ASSET_VERIFY_PAGE_STAGES,
  ASSET_VERIFY_TARGETS_VERSION,
  ASSET_VERIFY_ZOOM_CROP,
  assetVerifyPageMinimumSeconds,
  parseRejectedChecks,
  parseVerifyPageAnswer,
  planAssetVerifyPages,
  runAssetVerifyPages,
  verifyZoomCrops,
} from "../lib/assetQualityVerifyPages.mjs";
import { REVIEW_PAGE_TILE_SHORT_SIDE, encodeReviewPagePng } from "../lib/humanReviewPageImage.mjs";
import { decodePngPixels } from "../lib/pngPixelDigest.mjs";
import { runAssetQualityCli } from "../scripts/asset-quality-loop.mjs";
import { MAKER, png, reviewFor, sha, stageInputs, workspace, writeReview } from "./fixtures/assetQualityFixtures.mjs";

const REVIEWER = "synthetic-reviewer";
const NO_LEARNING = { BUZZASSIST_LEARNING_AUTO_CAPTURE: "0" };

/** 試験の時計。advance で進める（壁時計は読まない）。 */
function testClock(start = "2026-09-26T09:00:00.000Z") {
  let at = Date.parse(start);
  return {
    now: () => new Date(at).toISOString(),
    advance: (seconds) => {
      at += seconds * 1000;
    },
  };
}

/** タイルの画素の差し替え: 元の画と切り抜きごとに決まった単色（ページのどこに置いたかを色で確かめる）。 */
function fakeRenderer() {
  const calls = [];
  const colorOf = (source, crop) => [...createHash("sha256").update(`${path.basename(source)}:${crop ? crop.label : "full"}`).digest()].slice(0, 3);
  const render = async ({ source, crop, width, height }) => {
    calls.push({ source, crop, width, height });
    const [r, g, b] = colorOf(source, crop);
    const pixels = Buffer.alloc(width * height * 3);
    for (let index = 0; index < width * height; index += 1) {
      pixels[index * 3] = r;
      pixels[index * 3 + 1] = g;
      pixels[index * 3 + 2] = b;
    }
    return pixels;
  };
  return { render, calls, colorOf };
}

/**
 * 決まった答えを順に返す ask。各答えは { advance: 秒, answer, before?: async () => {} }。答えが尽きたら「q」。
 * 見せた後に時計を進めてから答える（人がページを見ている時間の代わり）。
 */
function scriptedAsk(clock, script) {
  const prompts = [];
  const ask = async (prompt) => {
    prompts.push(prompt);
    const step = script.shift();
    if (!step) return "q";
    clock.advance(step.advance ?? 0);
    if (step.before) await step.before();
    return step.answer;
  };
  return { ask, prompts };
}

/**
 * 工程の対象を count 件、評価者の採点が合格して人の確認を待つところまで進める。withRefs なら人物が写る版
 * （承認済みの設定画を参照に持つ）で、同一性の確認が要る。
 */
async function prepareAwaiting(root, { stage = "scene-image", harnessId = "narrated-story-video", count, withRefs = true, clock }) {
  const fx = await stageInputs(root, stage);
  const contract = createAssetQualityContract({ harnessId, stage }).contract;
  const subjects = [];
  for (let index = 1; index <= count; index += 1) {
    const subjectId = `synthetic-cut-${String(index).padStart(3, "0")}`;
    const started = await startAssetQualityLoop({ workDir: root, harnessId, stage, subjectId, generatorContextId: MAKER, generatorHost: "claude-code", now: clock.now });
    assert.equal(started.started, true);
    const rel = `assets/${subjectId}.png`;
    const bytes = stage === "thumbnail" ? png(1280, 720, subjectId) : png(1672, 941, subjectId);
    await writeFile(join(root, rel), bytes);
    const assetSha = sha(bytes);
    const review = await writeReview(root, subjectId, reviewFor({ stage, context: `ctx-eval-${index}`, assetSha, refs: withRefs ? fx.refs : [], contract }));
    const recorded = await recordAssetQualityRound({
      workDir: root, stage, subjectId, assetPath: rel, versionLabel: "v1", reviewPath: review, producerContexts: [MAKER],
      producerHost: "claude-code", generationRoute: "codex",
      ...(withRefs
        ? { references: [join(root, "refs", "approved-sheet.png")], approvedReferencesPath: join(root, "refs", "approved.json") }
        : { referenceExemptReason: "人物の写らない背景だけの画" }),
      now: clock.now, env: NO_LEARNING,
    });
    assert.equal(recorded.check.status, "awaiting-human-verification", `${subjectId}: ${recorded.issues.join(", ")}`);
    subjects.push({ subjectId, rel, sha: assetSha });
  }
  return { fx, subjects };
}

function pageInputs(root) {
  return {
    workDir: root,
    reviewer: REVIEWER,
    humanVerified: true,
    isInteractive: true,
    references: [join(root, "refs")],
    approvedReferencesPath: join(root, "refs", "approved.json"),
    output: { write: () => {} },
  };
}

async function stateOf(root, stage, subjectId) {
  return JSON.parse(await readFile(assetQualityPaths(root, stage, subjectId).statePath, "utf8"));
}

async function pageRecord(root, stage, pageId) {
  return JSON.parse(await readFile(join(root, ASSET_VERIFY_PAGE_DIR, `${stage}--${pageId}.json`), "utf8"));
}

test("答えの読み方・最短時間・拡大の切り抜き・ページの工程は宣言どおり", () => {
  assert.deepEqual(parseVerifyPageAnswer("pass", 4), { rejected: [] });
  assert.deepEqual(parseVerifyPageAnswer(" ２、4 2 ", 4), { rejected: [2, 4] }, "全角の数字・読点・重複を受ける");
  assert.deepEqual(parseVerifyPageAnswer("q", 4), { quit: true });
  assert.deepEqual(parseVerifyPageAnswer(null, 4), { quit: true }, "Ctrl-D はやめる");
  for (const bad of ["", "5", "0", "ok", "2 x", "全部"]) assert.ok(parseVerifyPageAnswer(bad, 4).error, bad);
  assert.deepEqual(parseRejectedChecks("h", ["identity", "hand-safety"]), ["hand-safety"]);
  assert.deepEqual(parseRejectedChecks("ih", ["identity", "hand-safety"]), ["identity", "hand-safety"]);
  assert.equal(parseRejectedChecks("i", ["hand-safety"]), null, "その画で見ていない欄は選べない");
  // 4 枚・4 分割の拡大なら 2×4 + 1×16 = 24 秒。1 枚でも 5 秒を下回らない。
  assert.equal(assetVerifyPageMinimumSeconds({ images: 4, zoomTiles: 16 }), 24);
  assert.equal(assetVerifyPageMinimumSeconds({ images: 1, zoomTiles: 0 }), 5);
  const quadrants = verifyZoomCrops({ width: 1672, height: 941 });
  assert.equal(quadrants.kind, "quadrants");
  assert.deepEqual(quadrants.crops.map((crop) => crop.label), ["TL", "TR", "BL", "BR"]);
  for (const crop of quadrants.crops) {
    assert.equal(crop.width, Math.round(1672 * ASSET_VERIFY_ZOOM_CROP));
    assert.ok(crop.x + crop.width <= 1672 && crop.y + crop.height <= 941);
  }
  // 隣どうしが重なる（境目の手や顔が2つのタイルに割れない）。
  assert.ok(quadrants.crops[1].x < quadrants.crops[0].x + quadrants.crops[0].width);
  const regions = verifyZoomCrops({ width: 1000, height: 1000 }, [{ x: 0.5, y: 0.5, width: 0.2, height: 0.4 }]);
  assert.deepEqual(regions.crops, [{ label: "P1", x: 480, y: 460, width: 240, height: 480 }], "人物の範囲に 1 割の余白");
  assert.deepEqual(ASSET_VERIFY_PAGE_STAGES, ["character", "scene-image", "thumbnail"], "動画クリップはページで見ない");
});

test("ページ画像の PNG は並べた画素そのまま読める（node:zlib だけで書く）", async () => {
  const rgb = Buffer.from([...Array(4 * 3 * 3).keys()].map((value) => (value * 37) % 256));
  const bytes = await encodeReviewPagePng({ width: 4, height: 3, rgb });
  const decoded = decodePngPixels(bytes);
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 3);
  assert.equal(decoded.channels, "RGB");
  const pixels = decoded.data;
  const channels = 3;
  for (let index = 0; index < 12; index += 1) {
    assert.deepEqual([...pixels.subarray(index * channels, index * channels + 3)], [...rgb.subarray(index * 3, index * 3 + 3)]);
  }
});

test("対話端末と --human-verified が無ければ、ページを作らず何も記録しない（機械は人の確認を記録できない）", async (t) => {
  const root = await workspace(t);
  const clock = testClock();
  const { subjects } = await prepareAwaiting(root, { count: 2, clock });
  const renderer = fakeRenderer();
  const base = { ...pageInputs(root), stage: "scene-image", renderTile: renderer.render, now: clock.now, ask: async () => "pass", openPage: async () => {} };
  await assert.rejects(runAssetVerifyPages({ ...base, isInteractive: false }), /対話端末/u);
  await assert.rejects(runAssetVerifyPages({ ...base, humanVerified: false }), /--human-verified/u);
  await assert.rejects(runAssetVerifyPages({ ...base, agentAttested: true }), /--agent-attested は使えない/u);
  await assert.rejects(runAssetVerifyPages({ ...base, reviewer: "" }), /reviewer/u);
  await assert.rejects(runAssetVerifyPages({ ...base, perPage: ASSET_VERIFY_PAGE_MAX_ITEMS + 1 }), /--per-page/u);
  await assert.rejects(runAssetVerifyPages({ ...base, stage: "video-clip" }), /動画クリップはページで確かめない/u);
  assert.equal(renderer.calls.length, 0);
  await assert.rejects(stat(join(root, ASSET_VERIFY_PAGE_DIR)), /ENOENT/u, "ページ画像を作らない");
  for (const { subjectId } of subjects) assert.deepEqual((await stateOf(root, "scene-image", subjectId)).asset.humanVerifications, []);
  // 記録の口そのものも、human-verified でなければ記録しない（--agent-attested の道は無い）。
  const page = { id: "0123456789abcdef", sha256: "a".repeat(64), path: "p.png", slot: 1, shownAt: clock.now(), answeredAt: clock.now() };
  await assert.rejects(recordAssetPageVerification({
    workDir: root, stage: "scene-image", subjectId: subjects[0].subjectId, expectedAssetSha256: subjects[0].sha,
    verdicts: [{ check: "identity", verdict: "pass", note: "並べて見た" }], reviewer: REVIEWER, humanVerified: true, isInteractive: false, page,
  }), /対話端末/u);
  await assert.rejects(recordAssetPageVerification({
    workDir: root, stage: "scene-image", subjectId: subjects[0].subjectId, expectedAssetSha256: subjects[0].sha,
    verdicts: [{ check: "identity", verdict: "pass", note: "並べて見た" }], reviewer: REVIEWER, humanVerified: false, isInteractive: true, page,
  }), /--human-verified/u);
  // CLI も同じ。batch の一覧では人の確認を受けない。
  const stdout = { write: () => {} };
  const cli = ["verify-pages", "--work-dir", root, "--stage", "scene-image", "--reviewer", REVIEWER];
  await assert.rejects(runAssetQualityCli([...cli, "--human-verified"], { stdout, isInteractive: false, renderTile: renderer.render }), /対話端末/u);
  await assert.rejects(runAssetQualityCli([...cli, "--human-verified", "--batch", "x.json"], { stdout, isInteractive: true }), /--batch は使えない/u);
  await assert.rejects(runAssetQualityCli([...cli, "--human-verified", "--subject", "x"], { stdout, isInteractive: true }), /verify-pages では --subject/u);
  await assert.rejects(runAssetQualityCli(["status", "--work-dir", root, "--per-page", "4"], { stdout }), /verify-pages でだけ/u);
});

test("既定 4 枚ずつのページに、短い辺 720px の全体・4分割の拡大・承認済みの設定画を並べ、ページと画の sha256 を記録に結ぶ", async (t) => {
  const root = await workspace(t);
  const clock = testClock();
  const { subjects } = await prepareAwaiting(root, { count: 5, clock });
  const renderer = fakeRenderer();
  const opened = [];
  const script = scriptedAsk(clock, [{ advance: 30, answer: "pass" }, { advance: 30, answer: "pass" }]);
  const out = [];
  const run = await runAssetQualityCli([
    "verify-pages", "--work-dir", root, "--stage", "scene-image", "--reviewer", REVIEWER, "--human-verified",
    "--reference", join(root, "refs"), "--approved-references", join(root, "refs", "approved.json"),
  ], {
    stdout: { write: (text) => out.push(text) }, isInteractive: true, now: clock.now, env: NO_LEARNING,
    ask: script.ask, openPage: async (file) => opened.push(file), renderTile: renderer.render,
  });
  assert.equal(run.exitCode, 0, out.join(""));
  assert.equal(run.result.complete, true);
  assert.equal(run.result.pagesAnswered, 2, "5 件は 4 + 1 の2ページ");
  assert.equal(opened.length, 2);
  assert.match(out.join(""), /24 秒より早い答えを受け付けない/u);

  const firstState = await stateOf(root, "scene-image", subjects[0].subjectId);
  const pageId = firstState.asset.humanVerifications[0].page.id;
  const record = await pageRecord(root, "scene-image", pageId);
  assert.equal(record.items.length, 4);
  assert.deepEqual(record.items.map((item) => item.subjectId), subjects.slice(0, 4).map((row) => row.subjectId));
  assert.deepEqual(record.items.map((item) => item.assetSha256), subjects.slice(0, 4).map((row) => row.sha));
  assert.equal(record.minimumSeconds, 24);
  assert.deepEqual(record.shows.map((show) => show.outcome), ["answered"]);
  const pageBytes = await readFile(path.resolve(root, record.pagePath));
  assert.equal(sha(pageBytes), record.pageSha256);
  assert.equal(opened[0], path.resolve(root, record.pagePath));

  // どのタイルも短い辺 720px 以上。対象ごとに全体1・設定画1・拡大4（4分割）。置いた場所の画素が、その画・切り抜きの色。
  const decoded = decodePngPixels(pageBytes);
  assert.equal(decoded.width, record.size.width);
  assert.equal(decoded.height, record.size.height);
  assert.equal(decoded.channels, "RGB");
  const pixels = decoded.data;
  const channels = 3;
  for (const slot of [1, 2, 3, 4]) {
    const tiles = record.tiles.filter((tile) => tile.slot === slot);
    assert.deepEqual(tiles.map((tile) => tile.kind), ["full", "reference", "zoom", "zoom", "zoom", "zoom"]);
    assert.deepEqual(tiles.filter((tile) => tile.kind === "zoom").map((tile) => tile.label), ["TL", "TR", "BL", "BR"].map((label) => `${slot} ZOOM ${label}`));
  }
  for (const tile of record.tiles) {
    assert.ok(Math.min(tile.width, tile.height) >= REVIEW_PAGE_TILE_SHORT_SIDE, `${tile.label} の短い辺 ${Math.min(tile.width, tile.height)}`);
    const source = tile.kind === "reference" ? "approved-sheet.png" : `${record.items[tile.slot - 1].subjectId}.png`;
    const expected = renderer.colorOf(source, tile.kind === "zoom" ? { label: tile.label.split(" ").pop() } : null);
    const at = ((tile.y + Math.floor(tile.height / 2)) * decoded.width + tile.x + Math.floor(tile.width / 2)) * channels;
    assert.deepEqual([...pixels.subarray(at, at + 3)], expected, tile.label);
  }
  // 設定画は承認済みの一覧の SHA のもの。
  const approved = JSON.parse(await readFile(join(root, "refs", "approved.json"), "utf8")).references.map((row) => row.sha256);
  for (const tile of record.tiles.filter((row) => row.kind === "reference")) assert.ok(approved.includes(tile.sourceSha256));

  // 記録は対象ごとの verify と同じ形に、ページの id・ページ画像の sha256・見せた時刻・答えた時刻を足したもの。
  for (const [index, subject] of subjects.entries()) {
    const state = await stateOf(root, "scene-image", subject.subjectId);
    assert.equal(state.asset.humanVerifications.length, 1);
    const row = state.asset.humanVerifications[0];
    assert.equal(row.check, "identity");
    assert.equal(row.verdict, "pass");
    assert.equal(row.assetSha256, subject.sha);
    assert.equal(row.assetPath, subject.rel);
    assert.equal(row.reviewer, REVIEWER);
    assert.equal(row.attestedBy, "human-verified");
    assert.match(row.note, /承認済みの設定画 1 枚と並べて見た/u);
    assert.equal(row.page.slot, index < 4 ? index + 1 : 1);
    assert.match(row.page.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(Date.parse(row.page.answeredAt) - Date.parse(row.page.shownAt) >= 24_000);
    if (index < 4) assert.deepEqual([row.page.id, row.page.sha256, row.page.path], [pageId, record.pageSha256, record.pagePath]);
    assert.equal((await assetQualityStatus({ workDir: root, stage: "scene-image", subjectId: subject.subjectId })).pass, true);
  }

  // 済んだ対象はページに載らない（もう一度打っても何も見せない）。
  const again = await runAssetVerifyPages({ ...pageInputs(root), stage: "scene-image", renderTile: renderer.render, now: clock.now, ask: async () => "pass", openPage: async () => assert.fail("開かない") });
  assert.equal(again.pagesPlanned, 0);
  assert.equal(again.complete, true);
  assert.ok(again.excluded.every((row) => row.reason === "already-verified"));
});

test("短すぎる答えは受け付けずに開き直す。落とす画は欄と理由を聞き、1つの否は同じページの他の可を消さない", async (t) => {
  const root = await workspace(t);
  const clock = testClock();
  const { subjects } = await prepareAwaiting(root, { stage: "thumbnail", count: 3, clock });
  const renderer = fakeRenderer();
  const opened = [];
  const captured = [];
  const script = scriptedAsk(clock, [
    { advance: 3, answer: "pass" }, // 18 秒より早い → 受け付けない
    { advance: 40, answer: "2" },
    { advance: 1, answer: "x" }, // 欄の答えが読めない → 聞き直す
    { advance: 1, answer: "h" },
    { advance: 1, answer: "指" }, // 理由が短い → 聞き直す
    { advance: 1, answer: "右手の指が6本" },
  ]);
  const result = await runAssetVerifyPages({
    ...pageInputs(root), stage: "thumbnail", renderTile: renderer.render, now: clock.now, ask: script.ask,
    openPage: async (file) => opened.push(file), captureLearning: async (input) => {
      captured.push(input);
      return { captured: 0, skippedReason: "synthetic" };
    },
  });
  assert.equal(result.complete, true);
  assert.equal(opened.length, 2, "短すぎた答えの後にページを開き直す");
  const [one, two, three] = subjects;
  const pageId = (await stateOf(root, "thumbnail", one.subjectId)).asset.humanVerifications[0].page.id;
  const record = await pageRecord(root, "thumbnail", pageId);
  // サムネは人物が写れば同一性と手指の両方。3 枚・4 分割: 2×3 + 1×12 = 18 秒。
  assert.equal(record.minimumSeconds, 18);
  assert.deepEqual(record.shows.map((show) => show.outcome), ["too-fast", "answered"]);
  assert.equal(record.shows[0].elapsedMs, 3000);
  assert.equal(record.answers.length, 1);
  assert.deepEqual(record.answers[0].recorded.map((row) => [row.subjectId, row.verdict, row.checks]), [
    [one.subjectId, "pass", ["identity", "hand-safety"]],
    [two.subjectId, "reject", ["hand-safety"]],
    [three.subjectId, "pass", ["identity", "hand-safety"]],
  ]);
  const rejected = (await stateOf(root, "thumbnail", two.subjectId)).asset.humanVerifications;
  assert.deepEqual(rejected.map((row) => [row.check, row.verdict]), [["hand-safety", "reject"]]);
  assert.match(rejected[0].note, /右手の指が6本/u);
  // 答えた時刻は、受け付けた答えの時刻（見せ直した時刻から 40 秒）。
  assert.equal(Date.parse(rejected[0].page.answeredAt) - Date.parse(rejected[0].page.shownAt), 40_000);
  assert.equal((await assetQualityStatus({ workDir: root, stage: "thumbnail", subjectId: two.subjectId })).check.status, "human-rejected");
  for (const subject of [one, three]) {
    assert.equal((await assetQualityStatus({ workDir: root, stage: "thumbnail", subjectId: subject.subjectId })).pass, true, subject.subjectId);
  }
  // 学習の捕捉は否の記録だけ（可の記録は渡さない）。
  assert.equal(captured.length, 1);
  assert.equal(captured[0].event, "human-rejection");
  assert.deepEqual(captured[0].verifications.map((row) => [row.check, row.verdict]), [["hand-safety", "reject"]]);
});

test("途中でやめても答えたページまでは記録され、同じコマンドで残りから続く", async (t) => {
  const root = await workspace(t);
  const clock = testClock();
  const { subjects } = await prepareAwaiting(root, { count: 6, clock });
  const renderer = fakeRenderer();
  const opened = [];
  const inputs = { ...pageInputs(root), stage: "scene-image", perPage: 2, renderTile: renderer.render, now: clock.now, openPage: async (file) => opened.push(file) };
  // 2ページ目は 2 番を落とそうとして、理由を聞かれたところでやめる（そのページは何も記録しない）。
  const first = await runAssetVerifyPages({
    ...inputs, ask: scriptedAsk(clock, [{ advance: 20, answer: "pass" }, { advance: 20, answer: "2" }, { advance: 1, answer: "q" }]).ask,
  });
  assert.equal(first.quit, true);
  assert.equal(first.complete, false);
  assert.equal(first.pagesPlanned, 3);
  assert.equal(first.pagesAnswered, 1);
  const statuses = async () => Promise.all(subjects.map(async ({ subjectId }) => (await assetQualityStatus({ workDir: root, stage: "scene-image", subjectId })).check.status));
  assert.deepEqual(await statuses(), ["passed", "passed", ...Array(4).fill("awaiting-human-verification")]);
  const quitPage = path.basename(opened[1], ".png").split("--")[1];

  const second = await runAssetVerifyPages({ ...inputs, ask: scriptedAsk(clock, [{ advance: 20, answer: "pass" }, { advance: 20, answer: "pass" }]).ask });
  assert.equal(second.complete, true);
  assert.equal(second.pagesPlanned, 2, "残りの 4 件だけ");
  assert.deepEqual(second.items.map((row) => row.subjectId), subjects.slice(2).map((row) => row.subjectId));
  assert.deepEqual(await statuses(), Array(6).fill("passed"));
  // やめたページと同じ中身のページは同じ id で、見せた記録が続く。
  assert.equal(opened[2], opened[1]);
  const resumed = await pageRecord(root, "scene-image", quitPage);
  assert.deepEqual(resumed.shows.map((show) => show.outcome), ["quit-during-reasons", "answered"]);
  // 見出しの番号（2/3 → 1/2）が変わったのでページ画像は別物。見せた記録ごとに、そのときのページ画像の sha256 が残る。
  assert.notEqual(resumed.shows[0].pageSha256, resumed.shows[1].pageSha256);
  assert.equal(resumed.shows[1].pageSha256, resumed.pageSha256);
  assert.equal(resumed.answers.length, 1);
});

test("ページに並べた後で画が変わった対象は記録しない（他の対象は記録する）。ページ画像が変わればそのページは記録しない", async (t) => {
  const root = await workspace(t);
  const clock = testClock();
  const { subjects } = await prepareAwaiting(root, { count: 3, clock });
  const renderer = fakeRenderer();
  const changed = subjects[1];
  const result = await runAssetVerifyPages({
    ...pageInputs(root), stage: "scene-image", renderTile: renderer.render, now: clock.now, openPage: async () => {},
    ask: scriptedAsk(clock, [{ advance: 30, answer: "pass", before: () => writeFile(join(root, changed.rel), png(1672, 941, "edited-after-page")) }]).ask,
  });
  assert.equal(result.complete, false);
  const byId = Object.fromEntries(result.items.map((row) => [row.subjectId, row]));
  assert.equal(byId[changed.subjectId].recorded, false);
  assert.deepEqual(byId[changed.subjectId].issues, ["asset-quality-asset-changed-since-page"]);
  assert.deepEqual((await stateOf(root, "scene-image", changed.subjectId)).asset.humanVerifications, []);
  for (const subject of [subjects[0], subjects[2]]) assert.equal(byId[subject.subjectId].recorded, true);
  // 次の回は、採点した版と違うファイルを載せず、直すまで進まない理由として出す。
  const rerun = await planAssetVerifyPages({ workDir: root, stage: "scene-image", references: [join(root, "refs")], approvedReferencesPath: join(root, "refs", "approved.json") });
  assert.equal(rerun.pages.length, 0);
  assert.deepEqual(rerun.blocked, [{ subjectId: changed.subjectId, reason: "asset-changed-after-review", blocking: true }]);

  const other = await workspace(t);
  const otherClock = testClock();
  const second = await prepareAwaiting(other, { count: 2, clock: otherClock });
  let shownPage = "";
  const tampered = await runAssetVerifyPages({
    ...pageInputs(other), stage: "scene-image", renderTile: renderer.render, now: otherClock.now, openPage: async (file) => {
      shownPage = file;
    },
    ask: scriptedAsk(otherClock, [{ advance: 30, answer: "pass", before: () => writeFile(shownPage, png(10, 10, "not-the-page")) }]).ask,
  });
  assert.equal(tampered.complete, false);
  assert.ok(tampered.items.every((row) => !row.recorded && row.issues.includes("asset-quality-page-image-changed")));
  for (const { subjectId } of second.subjects) assert.deepEqual((await stateOf(other, "scene-image", subjectId)).asset.humanVerifications, []);

  // ページに分けた後、ページを作る前に画が変わったら、そのページは作らずに止める（前のページの記録は残る）。
  const third = await workspace(t);
  const thirdClock = testClock();
  const prepared = await prepareAwaiting(third, { count: 2, clock: thirdClock });
  const [kept, edited] = prepared.subjects;
  let editedOnce = false;
  const editingRenderer = async (input) => {
    if (!editedOnce) {
      editedOnce = true;
      await writeFile(join(third, edited.rel), png(1672, 941, "edited-before-build"));
    }
    return renderer.render(input);
  };
  await assert.rejects(runAssetVerifyPages({
    ...pageInputs(third), stage: "scene-image", perPage: 1, renderTile: editingRenderer, now: thirdClock.now, openPage: async () => {},
    ask: scriptedAsk(thirdClock, [{ advance: 30, answer: "pass" }, { advance: 30, answer: "pass" }]).ask,
  }), /作る前に .* のファイルが変わった/u);
  assert.equal((await stateOf(third, "scene-image", kept.subjectId)).asset.humanVerifications.length, 1);
  assert.deepEqual((await stateOf(third, "scene-image", edited.subjectId)).asset.humanVerifications, []);
});

test("同一性は承認済みの一覧にある設定画を並べられるときだけ載せ、人物の範囲の記録があれば拡大はその範囲、手指だけの画は設定画を並べない", async (t) => {
  const root = await workspace(t);
  const clock = testClock();
  const { subjects } = await prepareAwaiting(root, { count: 2, clock });
  // 承認済みの一覧が無い・設定画のファイルが無い・一覧に無い設定画は、並べられないので載せない（直すまで進まない）。
  const noList = await planAssetVerifyPages({ workDir: root, stage: "scene-image", references: [join(root, "refs")] });
  assert.deepEqual(noList.blocked.map((row) => row.reason), ["approved-references-required", "approved-references-required"]);
  const noFile = await planAssetVerifyPages({ workDir: root, stage: "scene-image", approvedReferencesPath: join(root, "refs", "approved.json") });
  assert.ok(noFile.blocked.every((row) => row.reason.startsWith("reference-file-missing:")));
  const otherList = join(root, "refs", "other-approved.json");
  await writeFile(otherList, JSON.stringify({ version: APPROVED_REFERENCES_VERSION, references: ["b".repeat(64)] }));
  const notApproved = await planAssetVerifyPages({ workDir: root, stage: "scene-image", references: [join(root, "refs")], approvedReferencesPath: otherList });
  assert.ok(notApproved.blocked.every((row) => row.reason.startsWith("reference-not-approved:")));

  // --targets: 並べる順と人物の範囲。範囲があれば拡大はその範囲だけ（4分割はしない）。
  const targets = join(root, "targets.json");
  await writeFile(targets, JSON.stringify({
    version: ASSET_VERIFY_TARGETS_VERSION,
    stage: "scene-image",
    referenceFiles: ["refs/approved-sheet.png"],
    items: [
      { subjectId: subjects[1].subjectId, regions: [{ x: 0.1, y: 0.2, width: 0.2, height: 0.6 }, { x: 0.6, y: 0.1, width: 0.3, height: 0.8 }] },
      { subjectId: subjects[0].subjectId },
    ],
  }));
  const plan = await planAssetVerifyPages({ workDir: root, stage: "scene-image", targetsPath: targets, approvedReferencesPath: join(root, "refs", "approved.json") });
  assert.deepEqual(plan.pages[0].items.map((item) => [item.subjectId, item.zoom.kind, item.zoom.crops.length]), [
    [subjects[1].subjectId, "regions", 2],
    [subjects[0].subjectId, "quadrants", 4],
  ]);
  assert.equal(plan.pages[0].minimumSeconds, assetVerifyPageMinimumSeconds({ images: 2, zoomTiles: 6 }));
  await assert.rejects(planAssetVerifyPages({ workDir: root, stage: "thumbnail", targetsPath: targets }), /--stage/u);

  // 人物の写らないサムネは手指だけを見る（設定画を並べない）。
  const thumbs = await workspace(t);
  const thumbClock = testClock();
  await prepareAwaiting(thumbs, { stage: "thumbnail", count: 1, withRefs: false, clock: thumbClock });
  const handOnly = await planAssetVerifyPages({ workDir: thumbs, stage: "thumbnail" });
  assert.deepEqual(handOnly.pages[0].items.map((item) => [item.checks, item.references.length]), [[["hand-safety"], 0]]);
});
