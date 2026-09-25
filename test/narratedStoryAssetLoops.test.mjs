// ナレーション物語の公式経路の関門（lib/narratedStoryAssetLoops.mjs）: 本編の画・人物の設定画・声のテイクは、
// 途中の成果物の品質ループ（lib/assetQualityLoop.mjs）に合格した版でなければ使わない。ループは本物の実装で
// 回し（試験用の差し替えをしない）、画・声・人名・会話 id はすべて合成。有料 API もネットワークも使わない。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  NARRATED_ASSET_LOOP_AUDIT_IDS,
  NARRATED_CHARACTER_LOOP_AUDIT_ID,
  NARRATED_SCENE_IMAGE_LOOP_AUDIT_ID,
  NARRATED_VOICE_TAKE_LOOP_AUDIT_ID,
  brokerSceneLoopSubject,
  gateNarratedAssetLoops,
  narratedAssetLoopsRequired,
  narratedVoiceTakeMeasurementPath,
  operatorSceneLoopSubject,
  reverifyNarratedAssetLoops,
} from "../lib/narratedStoryAssetLoops.mjs";
import { NARRATED_STORY_AUDIT_IDS } from "../lib/narratedStoryOutcome.mjs";
import { narratedVoiceTakeMeasurementReport } from "../lib/narratedStoryVoiceQuality.mjs";
import { recordAssetLoopRound, sha256, verifyAssetLoop, writeApprovedReferences } from "./fixtures/narratedAssetLoopFixture.mjs";
import { makeGradientPng } from "./fixtures/operatorImageFixture.mjs";

const PRODUCTION = "production:video-narrated-story-video-a55e71009a0000a1";

function wav(salt) {
  return Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WAVEfmt ", "ascii"), Buffer.from(`synthetic-take-${salt}`, "utf8")]);
}

async function jobRunDir(t) {
  const runDir = await mkdtemp(path.join(tmpdir(), "narrated-asset-loops-"));
  t.after(() => rm(runDir, { recursive: true, force: true }));
  for (const dir of ["media/images", "media/voice", "quality", "refs"]) await mkdir(path.join(runDir, ...dir.split("/")), { recursive: true });
  return runDir;
}

async function put(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return file;
}

/** 声のテイクの measurement（pipeline が置くのと同じ形。文ごとに1ファイル）を Job の作業フォルダに書く。 */
async function writeMeasurement(runDir, takes) {
  const measurements = takes.map(({ segmentId, take, file, status = "pass" }) => ({
    segmentId, take, path: file, status, metrics: status === "pass" ? { utmos: 4.2, cer: 0.02 } : { utmos: 1.8, cer: 0.4 }, problems: [], warnings: [], unavailable: [],
  }));
  const shaByPath = new Map();
  for (const row of takes) shaByPath.set(row.file, sha256(await readFile(row.file)));
  for (const segmentId of new Set(takes.map((row) => row.segmentId))) {
    const rows = measurements.filter((row) => row.segmentId === segmentId);
    await put(path.join(runDir, ...narratedVoiceTakeMeasurementPath(segmentId).split("/")), `${JSON.stringify(narratedVoiceTakeMeasurementReport(rows, shaByPath), null, 2)}\n`);
  }
}

test("監査の id は outcome の一覧と揃い、関門は監査契約 v5 から効く（読めない版は要る側に倒す）", () => {
  for (const id of NARRATED_ASSET_LOOP_AUDIT_IDS) assert.ok(NARRATED_STORY_AUDIT_IDS.includes(id), `${id} が outcome の監査一覧に無い`);
  assert.equal(narratedAssetLoopsRequired("buzzassist-narrated-story-audit-v4"), false, "当時関門が無かった版は従来どおり");
  assert.equal(narratedAssetLoopsRequired("buzzassist-narrated-story-audit-v5"), true);
  assert.equal(narratedAssetLoopsRequired("buzzassist-narrated-story-audit-v6"), true);
  for (const unreadable of ["", "v4", "other-series-v1", null]) assert.equal(narratedAssetLoopsRequired(unreadable), true, `${unreadable}: 読めない版を免除の理由にしない`);
});

test("本編の画（broker）: 未開始・採点待ち・直し待ち・合格・合格の後の差し替えを、場面 ID と理由コードで返す", async (t) => {
  const runDir = await jobRunDir(t);
  const image = await put(path.join(runDir, "media", "images", "s001.png"), makeGradientPng(64, 36, 1));
  const gate = () => gateNarratedAssetLoops({
    runDir,
    generatorContextId: PRODUCTION,
    scenes: [brokerSceneLoopSubject("s001", { runDir, imagePath: image })],
  });

  const notStarted = await gate();
  assert.equal(notStarted.pass, false);
  assert.deepEqual(notStarted.issues, ["scene-image-asset-loop-not-passed:s001:loop-not-started"]);
  assert.equal(notStarted.checks[NARRATED_SCENE_IMAGE_LOOP_AUDIT_ID].pass, false);
  assert.equal(notStarted.checks[NARRATED_CHARACTER_LOOP_AUDIT_ID].pass, false, "本編の画が通るまで人物の参照は確かめられない");
  assert.equal(NARRATED_VOICE_TAKE_LOOP_AUDIT_ID in notStarted.checks, false, "声を渡していなければ声は見ない");
  const [pending] = notStarted.summary.pending;
  assert.deepEqual(
    { stage: pending.stage, subjectId: pending.subjectId, assetPath: pending.assetPath, generatorContextId: pending.generatorContextId, reason: pending.reason },
    { stage: "scene-image", subjectId: "s001", assetPath: "media/images/s001.png", generatorContextId: PRODUCTION, reason: "loop-not-started" },
    "評価者が回す対象（作業フォルダからの相対の画・作った文脈）を示す",
  );

  // 低い点の回 → 直しと新しい評価文脈が要る。
  await recordAssetLoopRound({ workDir: runDir, stage: "scene-image", subjectId: "s001", assetPath: image, generatorContextId: PRODUCTION, scores: { "scene-intent-match": 40 } });
  assert.deepEqual((await gate()).issues, ["scene-image-asset-loop-not-passed:s001:revision-required"]);

  // 直した画を別の評価文脈で採点して合格。
  await put(image, makeGradientPng(64, 36, 2));
  await recordAssetLoopRound({ workDir: runDir, stage: "scene-image", subjectId: "s001", assetPath: image, generatorContextId: PRODUCTION });
  const passed = await gate();
  assert.equal(passed.pass, true, passed.issues.join(", "));
  assert.equal(passed.checks[NARRATED_SCENE_IMAGE_LOOP_AUDIT_ID].pass, true);
  assert.equal(passed.checks[NARRATED_CHARACTER_LOOP_AUDIT_ID].pass, true, "人物の参照が無い場面（写らない）では人物のループは要らない");
  assert.equal(passed.plan.scenes[0].assetSha256, sha256(makeGradientPng(64, 36, 2)));

  // 合格の後で画が差し替わった（同じ場面 ID でも合格した版ではない）→ 描かない。
  await put(image, makeGradientPng(64, 36, 3));
  assert.deepEqual((await gate()).issues, ["scene-image-asset-loop-not-passed:s001:sha256-mismatch"]);
  // 確定の前の再照合も同じ理由で止める（production で記録した sha256 と今のファイルが違う）。
  const reverified = await reverifyNarratedAssetLoops({ runDir, plan: { ...passed.plan, voices: [{ segmentId: "x", machineTake: 1, candidates: [] }] } });
  assert.ok(reverified.issues.includes("scene-image-asset-loop-not-passed:s001:sha256-mismatch"), reverified.issues.join(", "));
});

test("人物が写る本編の画: 人の確認が揃うまで通さず、参照した設定画は人物の設定画のループで合格した版でなければ通さない", async (t) => {
  const runDir = await jobRunDir(t);
  const sheet = await put(path.join(runDir, "refs", "sheet-c01.png"), makeGradientPng(48, 64, 11));
  await put(path.join(runDir, "refs", "anchor-c01.png"), makeGradientPng(48, 64, 12));
  const sheetSha = sha256(makeGradientPng(48, 64, 11));
  const anchorSha = sha256(makeGradientPng(48, 64, 12));
  const approved = await writeApprovedReferences(path.join(runDir, "refs", "approved.json"), [sheetSha, anchorSha]);
  const image = await put(path.join(runDir, "media", "images", "s001.png"), makeGradientPng(64, 36, 21));
  const gate = () => gateNarratedAssetLoops({ runDir, scenes: [brokerSceneLoopSubject("s001", { runDir, imagePath: image })] });

  await recordAssetLoopRound({
    workDir: runDir, stage: "scene-image", subjectId: "s001", assetPath: image, generatorContextId: PRODUCTION,
    references: [sheetSha], approvedReferencesPath: approved, humanVerdict: null,
  });
  assert.deepEqual((await gate()).issues, ["scene-image-asset-loop-not-passed:s001:human-verification-required:identity"]);
  await verifyAssetLoop({ workDir: runDir, stage: "scene-image", subjectId: "s001", assetPath: image, checks: ["identity"] });

  const noCharacterLoop = await gate();
  assert.equal(noCharacterLoop.checks[NARRATED_SCENE_IMAGE_LOOP_AUDIT_ID].pass, true);
  assert.deepEqual(noCharacterLoop.issues, [`character-asset-loop-not-passed:${sheetSha.slice(0, 12)}:loop-not-started`]);
  const characterPending = noCharacterLoop.summary.pending.find((row) => row.stage === "character");
  assert.deepEqual(characterPending.usedBy, ["s001"]);
  assert.equal(characterPending.referenceSha256, sheetSha);

  // 設定画のループ（参照は承認済みの基準画）。採点は通っても人の確認（同一性・手指の安全）が揃うまで通さない。
  await recordAssetLoopRound({
    workDir: runDir, stage: "character", subjectId: "c01", assetPath: sheet, generatorContextId: "fixture-sheet-maker",
    route: "chatgpt-web", references: [anchorSha], approvedReferencesPath: approved, humanVerdict: null,
  });
  assert.deepEqual((await gate()).issues, [`character-asset-loop-not-passed:${sheetSha.slice(0, 12)}:human-verification-required:identity+hand-safety`]);
  await verifyAssetLoop({ workDir: runDir, stage: "character", subjectId: "c01", assetPath: sheet, checks: ["identity", "hand-safety"] });
  const passed = await gate();
  assert.equal(passed.pass, true, passed.issues.join(", "));
  assert.deepEqual(passed.checks[NARRATED_CHARACTER_LOOP_AUDIT_ID].references.map((row) => [row.subjectId, row.pass]), [["c01", true]]);

  // 人が本編の画を否とした → 合格しない（確定の前の再照合でも止まる）。
  await verifyAssetLoop({ workDir: runDir, stage: "scene-image", subjectId: "s001", assetPath: image, checks: ["identity"], verdict: "reject" });
  assert.deepEqual((await gate()).issues, ["scene-image-asset-loop-not-passed:s001:human-rejected:identity"]);
});

test("運営者の画: 取り込みの記録に assetLoop が無い・置き場が規則と違う・宣言した参照が設定画のループで合格していないと止める", async (t) => {
  const folder = await jobRunDir(t);
  const image = await put(path.join(folder, "images", "s001.png"), makeGradientPng(64, 36, 31));
  const imageSha = sha256(makeGradientPng(64, 36, 31));
  const referenceSha = "e".repeat(64);
  const row = (assetLoop) => ({ image: { full: image, sha256: imageSha }, referenceSha256s: [referenceSha], ...(assetLoop ? { assetLoop } : {}) });
  const missing = await gateNarratedAssetLoops({ scenes: [operatorSceneLoopSubject("s001", row(null))] });
  assert.deepEqual(missing.issues, ["scene-image-asset-loop-not-passed:s001:record-required"]);
  const moved = await gateNarratedAssetLoops({ scenes: [operatorSceneLoopSubject("s001", row({ full: path.join(folder, "elsewhere", "scene-image--s001.json") }))] });
  assert.deepEqual(moved.issues, ["scene-image-asset-loop-not-passed:s001:asset-loop-state-path-layout"]);

  // 運営者の作業フォルダでループを回した（人物は写らない場面として採点）。記録が宣言した参照は、それでも
  // 人物の設定画のループで合格した版でなければ通さない（Pack で承認済みと書いてあるだけの参照を信じない）。
  await recordAssetLoopRound({ workDir: folder, stage: "scene-image", subjectId: "s001", assetPath: image, generatorContextId: "fixture-operator-maker", route: "chatgpt-web" });
  const statePath = path.join(folder, "quality", "assets", "scene-image--s001.json");
  const subject = operatorSceneLoopSubject("s001", row({ full: statePath }));
  const gated = await gateNarratedAssetLoops({ scenes: [subject] });
  assert.equal(gated.checks[NARRATED_SCENE_IMAGE_LOOP_AUDIT_ID].pass, true, gated.issues.join(", "));
  assert.deepEqual([gated.plan.scenes[0].workDir, gated.plan.scenes[0].subjectId], [folder, "s001"], "状態の置き場から作業フォルダと対象 id を戻して記録する");
  assert.deepEqual(gated.issues, [`character-asset-loop-not-passed:${referenceSha.slice(0, 12)}:loop-not-started`]);
  // 記録の sha256 と今の画が違えば、ループの照合より先に止める。
  const swapped = await gateNarratedAssetLoops({ scenes: [{ ...subject, assetSha256: "f".repeat(64) }] });
  assert.ok(swapped.issues.includes("scene-image-asset-loop-not-passed:s001:sha256-mismatch"));
});

test("声のテイク: 品質ゲートに通ったテイクだけが候補で、ループが合格させたテイクを採用する（機械の順位で上書きしない）", async (t) => {
  const runDir = await jobRunDir(t);
  const take1 = await put(path.join(runDir, "media", "voice", "s001.wav"), wav("s001-1"));
  const take2 = await put(path.join(runDir, "media", "voice", "s001.take2.wav"), wav("s001-2"));
  const s002 = await put(path.join(runDir, "media", "voice", "s002.wav"), wav("s002-1"));
  const s003 = await put(path.join(runDir, "media", "voice", "s003.wav"), wav("s003-1"));
  await writeMeasurement(runDir, [
    { segmentId: "s001", take: 1, file: take1 },
    { segmentId: "s001", take: 2, file: take2 },
    { segmentId: "s002", take: 1, file: s002 },
    { segmentId: "s003", take: 1, file: s003, status: "fail" },
  ]);
  const voices = [
    { segmentId: "s001", machineTake: 1, candidates: [{ take: 1, path: take1, receipt: { jobId: "r1" }, machinePass: true }, { take: 2, path: take2, receipt: { jobId: "r2" }, machinePass: true }] },
    { segmentId: "s002", machineTake: 1, candidates: [{ take: 1, path: s002, receipt: { jobId: "r3" }, machinePass: true }] },
    { segmentId: "s003", machineTake: 1, candidates: [{ take: 1, path: s003, receipt: { jobId: "r4" }, machinePass: false }] },
  ];
  const gate = () => gateNarratedAssetLoops({ runDir, generatorContextId: PRODUCTION, voices });

  const first = await gate();
  assert.deepEqual(first.issues, [
    "voice-take-asset-loop-not-passed:s001:loop-not-started",
    "voice-take-asset-loop-not-passed:s002:loop-not-started",
    "voice-take-asset-loop-not-passed:s003:voice-quality-gate-failed",
  ]);
  assert.equal(sceneChecksAbsent(first), true, "画を渡していなければ画と人物は見ない");
  const pendingS002 = first.summary.pending.find((row) => row.subjectId === "s002");
  assert.equal(pendingS002.assetPath, "media/voice/s002.wav");
  assert.equal(pendingS002.measurementPath, "quality/voice-take-measurements/s002.json", "measurement は文ごと（別の文の同じバイト列のテイクの判定を拾わない）");
  assert.equal(pendingS002.contextAssetPath, "media/voice/s001.wav", "直前の地の文と続けて聞けるように前のテイクを示す");

  // 評価者は機械の1番（take1）ではなく take2 を合格させた → take2 を採用する。
  await recordAssetLoopRound({ workDir: runDir, stage: "voice-take", subjectId: "s001", assetPath: take2, generatorContextId: PRODUCTION, measurementPath: narratedVoiceTakeMeasurementPath("s001") });
  await recordAssetLoopRound({ workDir: runDir, stage: "voice-take", subjectId: "s002", assetPath: s002, generatorContextId: PRODUCTION, measurementPath: narratedVoiceTakeMeasurementPath("s002") });
  const second = await gate();
  assert.deepEqual(second.issues, ["voice-take-asset-loop-not-passed:s003:voice-quality-gate-failed"], "品質ゲートに通ったテイクが無い文は、ループでは救えない");
  assert.equal(second.adoptedTakes.get("s001").take, 2);
  assert.equal(second.adoptedTakes.get("s001").receipt.jobId, "r2");
  assert.equal(second.checks[NARRATED_VOICE_TAKE_LOOP_AUDIT_ID].pass, false);

  // 品質ゲートに落ちたテイクは、measurement の機械ゲートでループも合格できない。
  await assert.rejects(
    recordAssetLoopRound({ workDir: runDir, stage: "voice-take", subjectId: "s003", assetPath: s003, generatorContextId: PRODUCTION, measurementPath: narratedVoiceTakeMeasurementPath("s003"), humanVerdict: null }).then((status) => {
      if (status.pass !== true) throw new Error(`not passed: ${status.check.failedGateIds.join(",")}`);
    }),
    /voice-metrics-pass/u,
  );

  const twoOnly = await gateNarratedAssetLoops({ runDir, voices: voices.slice(0, 2) });
  assert.equal(twoOnly.pass, true, twoOnly.issues.join(", "));
  assert.deepEqual(twoOnly.plan.voices.map((row) => [row.segmentId, row.machineTake]), [["s001", 2], ["s002", 1]]);

  // 合格の後で、採用したテイクのファイルが差し替わった → 確定の前の再照合で止める。
  await put(take2, wav("s001-2-replaced"));
  const plan = { ...twoOnly.plan, scenes: [{ sceneId: "s001", source: "broker", workDir: runDir, subjectId: "s001", assetPath: path.join(runDir, "media", "images", "missing.png"), assetSha256: "", extraReferenceSha256s: [] }] };
  const reverified = await reverifyNarratedAssetLoops({ runDir, plan });
  assert.ok(reverified.issues.includes("voice-take-asset-loop-not-passed:s001:sha256-mismatch"), reverified.issues.join(", "));
  assert.ok(reverified.issues.includes("scene-image-asset-loop-not-passed:s001:asset-missing"));
});

test("声のテイクの measurement は文ごと: 別の文に同じバイト列のテイクがあっても、その文の判定だけでループの機械ゲートを通す", async (t) => {
  const runDir = await jobRunDir(t);
  const same = wav("identical-bytes");
  const a = await put(path.join(runDir, "media", "voice", "a01.wav"), same);
  const b = await put(path.join(runDir, "media", "voice", "b01.wav"), same);
  // a01 は品質ゲートに落ち（読みが違えば同じ音でも CER は違う）、b01 は通った。
  await writeMeasurement(runDir, [{ segmentId: "a01", take: 1, file: a, status: "fail" }, { segmentId: "b01", take: 1, file: b }]);
  const passed = await recordAssetLoopRound({ workDir: runDir, stage: "voice-take", subjectId: "b01", assetPath: b, generatorContextId: PRODUCTION, measurementPath: narratedVoiceTakeMeasurementPath("b01") });
  assert.equal(passed.pass, true, passed.issues.join(", "));
  const gated = await gateNarratedAssetLoops({ runDir, voices: [{ segmentId: "b01", machineTake: 1, candidates: [{ take: 1, path: b, machinePass: true }] }] });
  assert.equal(gated.pass, true, gated.issues.join(", "));
});

test("確定の前の再照合: production の記録（plan）が無い state は通さない", async (t) => {
  const runDir = await jobRunDir(t);
  for (const plan of [null, { version: "other" }, { version: "buzzassist-narrated-asset-loop-gate-v1", scenes: [], voices: [] }]) {
    const result = await reverifyNarratedAssetLoops({ runDir, plan });
    assert.equal(result.pass, false);
    assert.deepEqual(result.issues, ["asset-quality-loop-plan-missing"]);
    for (const id of NARRATED_ASSET_LOOP_AUDIT_IDS) assert.equal(result.checks[id].pass, false);
  }
  // 見る物が無い関門は合格ではなく、理由の無い停止にもならない。
  const empty = await gateNarratedAssetLoops({ runDir, scenes: [], voices: [] });
  assert.equal(empty.pass, false);
  assert.deepEqual(empty.issues, ["scene-image-asset-loop-not-passed:none:no-scene-images", "voice-take-asset-loop-not-passed:none:no-voice-takes"]);
});

function sceneChecksAbsent(result) {
  return !(NARRATED_SCENE_IMAGE_LOOP_AUDIT_ID in result.checks) && !(NARRATED_CHARACTER_LOOP_AUDIT_ID in result.checks);
}
