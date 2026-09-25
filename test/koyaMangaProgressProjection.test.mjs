// 漫画の Job の途中の成果物（本編の画・人物の候補と設定画・採用テイク・工程の DAG）を Canvas へ出す投影。
// Job・作業場・画像・音声はすべて合成（test/fixtures/koyaProgressFixture.mjs）。
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startAssetQualityLoop, recordAssetQualityRound } from "../lib/assetQualityLoop.mjs";
import {
  buildCanvasRunProgressProjection,
  CANVAS_RUN_PROGRESS_ORIGIN,
  CANVAS_RUN_PROGRESS_TAG,
  projectCanvasRunProgress,
  resolveCanvasRunProgressStateFile,
  stableCanvasProgressId,
} from "../lib/canvasRunProgressProjection.mjs";
import {
  createKoyaSceneImageAssetQualityGate,
  createKoyaVoiceTakeAssetQualityGate,
  koyaAssetQualityWorkDir,
} from "../lib/koyaAssetQualityGate.mjs";
import { koyaSceneImageAssetQualitySubjectId, koyaVoiceTakeAssetQualitySubjectId } from "../lib/koyaAssetQualityGatePolicy.mjs";
import {
  deriveKoyaProgressDag,
  isInsideKoyaWorkspace,
  readKoyaMangaProgressSnapshot,
  resolveKoyaWorkspacePath,
  wavSummary,
} from "../lib/koyaMangaProgressSnapshot.mjs";
import { _testing as adapterTesting, projectVideoHarnessJob } from "../lib/videoHarnessCanvasAdapter.mjs";
import { MAKER, now, png, reviewFor, stageInputs, synthVideo, writeReview } from "./fixtures/assetQualityFixtures.mjs";
import { makeGradientPng } from "./fixtures/operatorImageFixture.mjs";
import { currentKoyaContract, passKoyaAssetQualityLoop } from "./helpers/koyaAssetQualityFixture.mjs";
import {
  approveNewCharacter,
  createKoyaProgressJob,
  EPISODE_ID,
  FIXED_NAME,
  JOB_ID,
  koyaPaths,
  makeWav,
  NEW_CAST_ID,
  NEW_NAME,
  sha256,
  writeCharacterApprovalPending,
  writeMidProduction,
} from "./fixtures/koyaProgressFixture.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

async function project(t, prefix = "koya-progress-") {
  const projectDir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await mkdir(join(projectDir, "canvas"), { recursive: true });
  return projectDir;
}

async function readScene(projectDir) {
  return JSON.parse(await readFile(join(projectDir, "canvas", "excalidraw-canvas.json"), "utf8"));
}

function progressElements(scene) {
  return scene.elements.filter((element) => element.customData?.[CANVAS_RUN_PROGRESS_TAG] === true && !element.isDeleted);
}

function layoutOf(elements) {
  return elements
    .map((element) => ({ id: element.id, type: element.type, x: element.x, y: element.y, width: element.width, height: element.height, fileId: element.fileId || null }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

const noFeedback = async () => ({ ok: true, captured: 0 });

test("工程の DAG: 止まっている工程と直接の証拠から、pending / running / pass / fail / awaiting-human-review を決める", () => {
  const job = (status, adapterStatus, stages = {}) => ({
    status,
    adapterResult: adapterStatus ? { status: adapterStatus, ...(stages.failedAuditIds ? { failedAuditIds: stages.failedAuditIds } : {}) } : undefined,
    stages: [
      { id: "doctor", status: stages.doctor || "pass" },
      { id: "production", status: "awaiting-human-review" },
      { id: "audit", status: stages.audit || "pending" },
      { id: "canvas-projection", status: stages.canvas || "pending" },
    ],
  });
  const statusOf = (result) => Object.fromEntries(result.nodes.map((node) => [node.id, node.status]));

  // 画の前に声の人選で止まった。
  const voice = statusOf(deriveKoyaProgressDag(job("awaiting-human-review", "awaiting-voice-selection"), {}));
  assert.equal(voice.doctor, "pass");
  assert.equal(voice["voice-selection"], "awaiting-human-review");
  assert.equal(voice.images, "pending");
  assert.equal(voice.receipt, "pending");

  // 画の QA で1枚落ちた（人物・衣装・声はもう済んでいる）。
  const imagesFailed = statusOf(deriveKoyaProgressDag(job("awaiting-human-review", "failed"), {
    state: { status: "failed", currentStage: "images" },
    plan: {},
    ledger: { status: "failed" },
    cast: [{ status: "existing" }],
  }));
  assert.deepEqual(
    [imagesFailed.characters, imagesFailed.wardrobe, imagesFailed["voice-selection"], imagesFailed.images, imagesFailed.layout],
    ["pass", "pass", "pass", "fail", "pending"],
  );

  // 機械の監査は通り、独立レビューだけが残っている。
  const signoff = statusOf(deriveKoyaProgressDag(job("awaiting-human-review", "audit-incomplete", { failedAuditIds: ["agent-contact-sheet-review"] }), {
    plan: {}, ledger: { status: "complete" }, manifest: {}, speechReport: { status: "complete" },
  }));
  assert.deepEqual(
    [signoff.images, signoff.layout, signoff.speech, signoff.render, signoff["final-audit"], signoff.signoff, signoff.receipt],
    ["pass", "pass", "pass", "pass", "pass", "awaiting-human-review", "pending"],
  );
  const auditFailed = statusOf(deriveKoyaProgressDag(job("awaiting-human-review", "audit-incomplete", { failedAuditIds: ["rendered-camera"] }), {
    plan: {}, ledger: { status: "complete" }, manifest: {}, speechReport: { status: "complete" },
  }));
  assert.equal(auditFailed["final-audit"], "fail");

  // 利用上限で止まった音声を再開して走っている間は、記録の「待機」より Job の running を出す。
  const resumed = statusOf(deriveKoyaProgressDag({ ...job("running", "waiting-usage-limit"), status: "running" }, {
    state: { status: "waiting-usage-limit", currentStage: "speech" },
    plan: {}, ledger: { status: "complete" }, manifest: {}, speechReport: { status: "waiting-usage-limit" },
  }));
  assert.equal(resumed.speech, "running");
  assert.equal(resumed.images, "pass");
  assert.equal(resumed.render, "pending");

  // 完成した Job は制作の工程がすべて pass、Receipt と投影は Job の段から。
  const completed = statusOf(deriveKoyaProgressDag(job("completed", "final-koya-audited", { audit: "pass", canvas: "running" }), {}));
  assert.ok(["doctor", "characters", "images", "speech", "render", "final-audit", "signoff", "receipt"].every((id) => completed[id] === "pass"));
  assert.equal(completed["canvas-projection"], "running");

  // 事前点検で落ちた Job は、後ろの工程を pending のまま残す。
  const doctorFailed = statusOf(deriveKoyaProgressDag(job("failed", "", { doctor: "failed" }), {}));
  assert.equal(doctorFailed.doctor, "fail");
  assert.equal(doctorFailed.images, "pending");
});

test("承認前の人物は匿名（人物 N・候補 A〜C）のまま出し、名前・人物 id・説明・作り分けの軸を Canvas に書かない", async (t) => {
  const projectDir = await project(t);
  const job = await createKoyaProgressJob(projectDir);
  const fixture = await writeCharacterApprovalPending(job.executionProjectDir);
  const snapshot = await readKoyaMangaProgressSnapshot(job);
  const characterSection = snapshot.sections.find((section) => section.id === "character");
  const titles = characterSection.items.map((item) => item.title);
  assert.deepEqual(titles, [FIXED_NAME, "顔の設定画", "三面図", "人物 1（承認前）", "候補 A", "候補 B", "候補 C"]);
  assert.equal(snapshot.dag.nodes.find((node) => node.id === "characters").status, "awaiting-human-review");

  const result = await projectCanvasRunProgress({ projectDir }, snapshot, { sourceRoot: job.executionProjectDir });
  assert.equal(result.ok, true);
  const canvasText = await readFile(join(projectDir, "canvas", "excalidraw-canvas.json"), "utf8");
  for (const secret of [NEW_NAME, NEW_CAST_ID, "合成の作り分け", "合成プロンプト", "合成の説明", job.executionProjectDir]) {
    assert.equal(canvasText.includes(secret), false, `承認前の Canvas に出てはいけない: ${secret}`);
  }
  assert.ok(canvasText.includes("候補 A") && canvasText.includes("人物 1（承認前）"));
  assert.ok(canvasText.includes(FIXED_NAME), "承認済みの固定キャストは名前で出す");
  // 匿名の候補画は content-addressed の複製として出る（原本の置き場の名前は出ない）。
  const scene = await readScene(projectDir);
  const candidateImages = progressElements(scene).filter((element) => element.type === "image"
    && element.customData.buzzassistArtifactSha256 === `sha256:${fixture.candidates[0].blindArtifactSha256}`);
  assert.equal(candidateImages.length, 1);
  assert.match(candidateImages[0].customData.codexAssetUrl, new RegExp(`/harness-runs/${JOB_ID}/${fixture.candidates[0].blindArtifactSha256}\\.png\\?w=640$`, "u"));

  // 候補 B を採用して登録すると、名前と承認済みの設定画が出て、匿名の行は消える（墓標）。
  await approveNewCharacter(job.executionProjectDir);
  const approved = await projectCanvasRunProgress({ projectDir }, await readKoyaMangaProgressSnapshot({ ...job, revision: 6 }), { sourceRoot: job.executionProjectDir });
  assert.ok(approved.removed > 0);
  const afterText = JSON.stringify(progressElements(await readScene(projectDir)));
  assert.ok(afterText.includes(NEW_NAME));
  assert.equal(afterText.includes("人物 1（承認前）"), false);
});

test("本編の画はカット順の格子に QA と品質ループの合否のラベルを付け、採用テイクは再生できる音声要素で出す", async (t) => {
  const projectDir = await project(t);
  const job = await createKoyaProgressJob(projectDir, {
    adapterResult: { status: "waiting-usage-limit" },
    knownRemainingIssues: ["usage-limit"],
  });
  const workspace = job.executionProjectDir;
  await writeCharacterApprovalPending(workspace);
  await approveNewCharacter(workspace);
  const mid = await writeMidProduction(workspace);

  // 途中の成果物の品質ループ: 1枚目の画は評価者の採点が通って人の確認待ち、cut-01 のテイクは合格。
  // 置き場と対象 id はゲートと同じ（<作業場>/canvas と koya*AssetQualitySubjectId）。採点ファイル・参照・
  // 声の測定もその中に置く（品質ループの状態は作業フォルダからの相対パスで残る）。
  const qualityDir = koyaAssetQualityWorkDir({ projectDir: workspace });
  for (const dir of ["reviews", "refs", "measure"]) await mkdir(join(qualityDir, dir), { recursive: true });
  const imageSubject = koyaSceneImageAssetQualitySubjectId(EPISODE_ID, "panel:u-0001");
  const imageRel = path.relative(qualityDir, mid.images["panel:u-0001"].path);
  const imageLoop = await startAssetQualityLoop({ workDir: qualityDir, harnessId: "koya-manga-video", stage: "scene-image", subjectId: imageSubject, generatorContextId: MAKER, now });
  const imageInputs = await stageInputs(qualityDir, "scene-image");
  const imageVersion = { rel: imageRel, sha: mid.images["panel:u-0001"].sha256 };
  const imageRound = await recordAssetQualityRound({
    workDir: qualityDir, stage: "scene-image", subjectId: imageSubject, assetPath: imageRel, versionLabel: "v1", now,
    reviewPath: await writeReview(qualityDir, "scene-u-0001", reviewFor({ stage: "scene-image", context: "ctx-eval-1", assetSha: imageVersion.sha, refs: imageInputs.refs, contract: imageLoop.state.asset.contract })),
    ...(await imageInputs.recordExtra(imageVersion)),
  });
  assert.equal(imageRound.recorded, true, JSON.stringify(imageRound.issues));
  const takeSubject = koyaVoiceTakeAssetQualitySubjectId(EPISODE_ID, "cut-01");
  const takeRel = path.relative(qualityDir, mid.takes["cut-01"].path);
  const takeLoop = await startAssetQualityLoop({ workDir: qualityDir, harnessId: "koya-manga-video", stage: "voice-take", subjectId: takeSubject, generatorContextId: MAKER, now });
  const takeInputs = await stageInputs(qualityDir, "voice-take");
  const takeVersion = { rel: takeRel, sha: mid.takes["cut-01"].sha256 };
  const takeRound = await recordAssetQualityRound({
    workDir: qualityDir, stage: "voice-take", subjectId: takeSubject, assetPath: takeRel, versionLabel: "v1", now,
    reviewPath: await writeReview(qualityDir, "take-cut-01", reviewFor({ stage: "voice-take", context: "ctx-eval-2", assetSha: takeVersion.sha, contract: takeLoop.state.asset.contract })),
    ...(await takeInputs.recordExtra(takeVersion)),
  });
  assert.equal(takeRound.recorded, true, JSON.stringify(takeRound.issues));

  const snapshot = await readKoyaMangaProgressSnapshot(job);
  const images = snapshot.sections.find((section) => section.id === "scene-image").items;
  assert.deepEqual(images.map((item) => item.key), ["panel:u-0001", "panel:u-0003", "split-page:u-0004", "panel:u-0005"], "カット順（最初に出た順）");
  assert.deepEqual(images.map((item) => item.title), ["#1 cut-01", "#2 cut-02", "#3 cut-02", "#4 cut-03"]);
  assert.deepEqual(images[0].lines.slice(0, 3), ["発話 u-0001 ほか 1", "QA: 合格", "品質ループ: 人の確認待ち"]);
  assert.equal(images[0].status, "awaiting-approval");
  assert.deepEqual(images[1].lines.slice(1, 3), ["QA: 合格", "品質ループ: 未開始"]);
  assert.equal(images[1].status, "complete");
  assert.equal(images[2].status, "failed");
  assert.equal(images[2].lines[1], "QA: 不合格（指摘 1 件）");
  assert.match(images[2].lines[3], /^指摘: 合成の指摘/u);

  const takes = snapshot.sections.find((section) => section.id === "voice-take").items;
  assert.deepEqual(takes.map((item) => item.key), ["cut-01", "cut-02", "cut-03"], "manifest のカット順（報告の完了順ではない）");
  assert.deepEqual(takes[0].lines, ["採用テイク 2", "声の検査: 合格", "品質ループ: 合格"]);
  assert.equal(takes[0].media.kind, "audio");
  assert.ok(takes[0].media.durationSeconds > 0.9 && takes[0].media.waveform.length === 64);
  assert.equal(takes[2].media, undefined);
  assert.deepEqual(takes[2].lines, ["採用テイクはまだ無い"]);

  const statusOf = Object.fromEntries(snapshot.dag.nodes.map((node) => [node.id, node.status]));
  assert.equal(statusOf.images, "fail");
  assert.equal(statusOf.speech, "awaiting-human-review");
  assert.equal(statusOf.characters, "pass");

  const result = await projectCanvasRunProgress({ projectDir }, snapshot, { sourceRoot: workspace });
  assert.equal(result.ok, true);
  const scene = await readScene(projectDir);
  const elements = progressElements(scene);
  const audio = elements.filter((element) => element.customData.codexMediaKind === "audio");
  assert.equal(audio.length, 2);
  assert.ok(audio.every((element) => element.customData.codexAssetUrl.startsWith(`/excalidraw-assets/harness-runs/${JOB_ID}/`)
    && element.customData.codexAssetUrl.endsWith(".wav")));
  const poster = scene.files[audio[0].fileId];
  assert.equal(poster.mimeType, "image/svg+xml");
  assert.match(Buffer.from(poster.dataURL.split(",")[1], "base64").toString("utf8"), /<rect x="64/u, "波形の棒を描く");
  const imageElements = elements.filter((element) => element.customData.codexMediaKind === "image");
  assert.ok(imageElements.every((element) => /\?w=640$/u.test(element.customData.codexAssetUrl) && !/\?/u.test(element.link)));
  assert.ok(imageElements.every((element) => scene.files[element.fileId].dataURL === element.customData.codexAssetUrl));
  // 投影の中に作業場の絶対パスは出ない。
  assert.equal(JSON.stringify(scene).includes(workspace), false);
  assert.equal(JSON.stringify(scene).includes(projectDir), false);
  // 原本は content-addressed に複製され、SHA が名前と一致する。
  const copied = await readFile(join(projectDir, "canvas", "assets", "harness-runs", JOB_ID, `${mid.images["panel:u-0003"].sha256}.png`));
  assert.equal(sha256(copied), mid.images["panel:u-0003"].sha256);
  // パネルは Run の投影（x >= 40）と重ならない左側。
  assert.ok(elements.every((element) => element.x + element.width <= 0 && element.x >= CANVAS_RUN_PROGRESS_ORIGIN.x));
});

test("品質ループはゲートと同じ置き場（<作業場>/canvas）から読む: ゲートが見る記録は出し、ゲートが見ない作業場直下の記録は出さない", async (t) => {
  const projectDir = await project(t);
  const job = await createKoyaProgressJob(projectDir, {
    adapterResult: { status: "waiting-usage-limit" },
    knownRemainingIssues: ["usage-limit"],
  });
  const workspace = job.executionProjectDir;
  await writeCharacterApprovalPending(workspace);
  await approveNewCharacter(workspace);
  const mid = await writeMidProduction(workspace);
  const contract = await currentKoyaContract(repoRoot);
  const qualityDir = koyaAssetQualityWorkDir({ projectDir: workspace });
  assert.equal(qualityDir, join(workspace, "canvas"));
  const takeGate = createKoyaVoiceTakeAssetQualityGate({ contract, canvasDir: qualityDir, episodeId: EPISODE_ID });
  const imageGate = createKoyaSceneImageAssetQualityGate({ contract, canvasDir: qualityDir, episodeId: EPISODE_ID });
  const take = { cutId: "cut-01", takePath: mid.takes["cut-01"].path };
  const takeSubject = koyaVoiceTakeAssetQualitySubjectId(EPISODE_ID, take.cutId);
  const image = { job: { id: "panel:u-0001", kind: "scene-image" }, outputPath: mid.images["panel:u-0001"].path };
  const imageSubject = koyaSceneImageAssetQualitySubjectId(EPISODE_ID, image.job.id);
  const itemOf = (snapshot, section, key) => snapshot.sections.find((row) => row.id === section).items.find((item) => item.key === key);
  const loopLine = (item) => item.lines.find((line) => line.startsWith("品質ループ: "));

  // 作業場の直下（ゲートが読まない場所）に合格の記録があっても、ゲートは未開始と見る。進捗にも出さない。
  await passKoyaAssetQualityLoop({ workDir: workspace, stage: "voice-take", subjectId: takeSubject, assetPath: take.takePath });
  assert.equal((await takeGate(take)).reason, "loop-not-started");
  assert.equal(loopLine(itemOf(await readKoyaMangaProgressSnapshot(job), "voice-take", "cut-01")), "品質ループ: 未開始");

  // ゲートの置き場に記録すると、ゲートの判定と同じものが進捗に出る（テイクは合格、人物が写る画は人の確認待ち）。
  const reference = join(qualityDir, "refs", "approved-sheet.png");
  await mkdir(path.dirname(reference), { recursive: true });
  await writeFile(reference, png(1024, 1024, "approved-reference"));
  await passKoyaAssetQualityLoop({ workDir: qualityDir, stage: "voice-take", subjectId: takeSubject, assetPath: take.takePath });
  await passKoyaAssetQualityLoop({ workDir: qualityDir, stage: "scene-image", subjectId: imageSubject, assetPath: image.outputPath, references: [reference], stopBefore: "human" });
  const takeCheck = await takeGate(take);
  assert.equal(takeCheck.pass, true, JSON.stringify(takeCheck));
  const imageCheck = await imageGate(image);
  assert.equal(imageCheck.pass, false);
  assert.equal(imageCheck.reason, "not-passed");

  const snapshot = await readKoyaMangaProgressSnapshot(job);
  const takeItem = itemOf(snapshot, "voice-take", "cut-01");
  assert.equal(loopLine(takeItem), "品質ループ: 合格");
  assert.equal(takeItem.status, "complete");
  const imageItem = itemOf(snapshot, "scene-image", "panel:u-0001");
  assert.equal(loopLine(imageItem), "品質ループ: 人の確認待ち");
  assert.equal(imageItem.status, "awaiting-approval");
  assert.equal(snapshot.summaryLines.some((line) => line.includes("品質ループの記録")), false, "記録は読めている");
});

test("品質ループの対象 id はゲートと同じ（回 id つき、分割ページはコマ）: 採点した版を差し替えた成果物は「別の版を採点済み」と出す", async (t) => {
  const projectDir = await project(t);
  const job = await createKoyaProgressJob(projectDir, {
    adapterResult: { status: "waiting-usage-limit" },
    knownRemainingIssues: ["usage-limit"],
  });
  const workspace = job.executionProjectDir;
  await writeCharacterApprovalPending(workspace);
  await approveNewCharacter(workspace);
  const mid = await writeMidProduction(workspace);
  const paths = koyaPaths(workspace);
  const contract = await currentKoyaContract(repoRoot);
  const qualityDir = koyaAssetQualityWorkDir({ projectDir: workspace });
  const takeGate = createKoyaVoiceTakeAssetQualityGate({ contract, canvasDir: qualityDir, episodeId: EPISODE_ID });
  const imageGate = createKoyaSceneImageAssetQualityGate({ contract, canvasDir: qualityDir, episodeId: EPISODE_ID });
  const itemOf = (snapshot, section, key) => snapshot.sections.find((row) => row.id === section).items.find((item) => item.key === key);
  const loopLine = (item) => item.lines.find((line) => line.startsWith("品質ループ: "));

  // 分割ページ u-0004 はコマ2枚から組む。ゲートが見るのは合成の行ではなくコマの行（計画にも台帳にも載る）。
  const panelIds = ["panel:u-0004:1", "panel:u-0004:2"];
  const panels = Object.fromEntries(panelIds.map((id, index) => [id, join(paths.assetDir, `panel-u-0004-${index + 1}.png`)]));
  for (const [index, id] of panelIds.entries()) await writeFile(panels[id], png(160, 90, `synthetic-panel-${index + 1}`));
  const plan = JSON.parse(await readFile(paths.plan, "utf8"));
  plan.pages = plan.pages.map((page) => (page.assetJobId === "split-page:u-0004" ? { ...page, panelJobIds: panelIds } : page));
  plan.jobs.push(...panelIds.map((id) => ({ id, kind: "split-panel", outputPath: panels[id] })));
  await writeFile(paths.plan, JSON.stringify(plan));
  const ledger = JSON.parse(await readFile(paths.ledger, "utf8"));
  const qaPass = { pass: true, issues: [], technical: { pass: true }, semantic: { pass: true } };
  ledger.jobs["split-page:u-0004"] = { ...ledger.jobs["split-page:u-0004"], status: "complete", qa: qaPass };
  for (const id of panelIds) ledger.jobs[id] = { id, status: "complete", outputPath: panels[id], qa: qaPass };
  await writeFile(paths.ledger, JSON.stringify(ledger));

  const take = { cutId: "cut-01", takePath: mid.takes["cut-01"].path };
  const image = { job: { id: "panel:u-0003", kind: "scene-image" }, outputPath: mid.images["panel:u-0003"].path };
  const panel = { job: { id: "panel:u-0004:2", kind: "split-panel" }, outputPath: panels["panel:u-0004:2"] };
  await passKoyaAssetQualityLoop({ workDir: qualityDir, stage: "voice-take", subjectId: koyaVoiceTakeAssetQualitySubjectId(EPISODE_ID, take.cutId), assetPath: take.takePath });
  await passKoyaAssetQualityLoop({ workDir: qualityDir, stage: "scene-image", subjectId: koyaSceneImageAssetQualitySubjectId(EPISODE_ID, image.job.id), assetPath: image.outputPath });
  for (const id of panelIds) {
    await passKoyaAssetQualityLoop({ workDir: qualityDir, stage: "scene-image", subjectId: koyaSceneImageAssetQualitySubjectId(EPISODE_ID, id), assetPath: panels[id] });
  }
  // 前の版の進捗が探していたカット id そのままの記録。ゲートはこの id を読まない。
  await passKoyaAssetQualityLoop({ workDir: qualityDir, stage: "voice-take", subjectId: "cut-02", assetPath: mid.takes["cut-02"].path });
  for (const row of [await takeGate(take), await imageGate(image), await imageGate(panel)]) assert.equal(row.pass, true, JSON.stringify(row));

  // 採点した版のまま: 分割ページは合成の画の SHA ではなく、コマのファイルで合格が出る。
  const before = await readKoyaMangaProgressSnapshot(job);
  assert.equal(loopLine(itemOf(before, "voice-take", "cut-01")), "品質ループ: 合格");
  assert.equal(loopLine(itemOf(before, "scene-image", "panel:u-0003")), "品質ループ: 合格");
  assert.equal(loopLine(itemOf(before, "scene-image", "split-page:u-0004")), "品質ループ: 合格");

  // 採点の後にファイルを差し替えると、ゲートは asset-sha-mismatch で止め、進捗は「別の版を採点済み」と出す。
  await writeFile(take.takePath, makeWav(1.4, 330));
  await writeFile(image.outputPath, png(160, 90, "synthetic-redraw-u-0003"));
  await writeFile(panel.outputPath, png(160, 90, "synthetic-redraw-u-0004-2"));
  await writeFile(mid.takes["cut-02"].path, makeWav(1.7, 350));
  for (const row of [await takeGate(take), await imageGate(image), await imageGate(panel)]) assert.equal(row.reason, "asset-sha-mismatch", JSON.stringify(row));
  assert.equal((await takeGate({ cutId: "cut-02", takePath: mid.takes["cut-02"].path })).reason, "loop-not-started");

  const after = await readKoyaMangaProgressSnapshot(job);
  assert.equal(loopLine(itemOf(after, "voice-take", "cut-01")), "品質ループ: 別の版を採点済み");
  assert.equal(loopLine(itemOf(after, "scene-image", "panel:u-0003")), "品質ループ: 別の版を採点済み");
  assert.equal(loopLine(itemOf(after, "scene-image", "split-page:u-0004")), "品質ループ: 別の版を採点済み", "差し替えたコマが1枚でもあれば分割ページもそう出す");
  assert.equal(loopLine(itemOf(after, "voice-take", "cut-02")), "品質ループ: 未開始", "ゲートが読まない id の記録は進捗にも出さない");
  assert.equal(loopLine(itemOf(after, "scene-image", "panel:u-0005")), "品質ループ: 未開始");
});

test("画の台帳が品質ループの合格まで止めた行（分割ページはコマ）は「人の確認待ち」と出し、画の工程も人待ちにする", async (t) => {
  const projectDir = await project(t);
  const job = await createKoyaProgressJob(projectDir, { adapterResult: { status: "awaiting-human-review" } });
  await writeCharacterApprovalPending(job.executionProjectDir);
  await approveNewCharacter(job.executionProjectDir);
  await writeMidProduction(job.executionProjectDir);
  const paths = koyaPaths(job.executionProjectDir);
  // cut-02 の1枚の画は機械の QA を通ったが品質ループ待ちで止まり、分割ページは合成の行ではなくコマの行が止まった。
  const plan = JSON.parse(await readFile(paths.plan, "utf8"));
  plan.pages = plan.pages.map((page) => (page.assetJobId === "split-page:u-0004" ? { ...page, panelJobIds: ["panel:u-0004:1", "panel:u-0004:2"] } : page));
  await writeFile(paths.plan, JSON.stringify(plan));
  const ledger = JSON.parse(await readFile(paths.ledger, "utf8"));
  const held = { status: "awaiting-human-review", qa: { pass: true, issues: [], technical: { pass: true }, semantic: { pass: true } }, assetQuality: { required: true, pass: false, reason: "loop-not-started" } };
  ledger.jobs["panel:u-0003"] = { ...ledger.jobs["panel:u-0003"], ...held };
  ledger.jobs["split-page:u-0004"] = { ...ledger.jobs["split-page:u-0004"], status: "pending", qa: undefined };
  ledger.jobs["panel:u-0004:1"] = { id: "panel:u-0004:1", status: "complete", qa: { pass: true, issues: [] } };
  ledger.jobs["panel:u-0004:2"] = { id: "panel:u-0004:2", ...held };
  ledger.status = "awaiting-human-review";
  await writeFile(paths.ledger, JSON.stringify(ledger));
  const state = JSON.parse(await readFile(paths.state, "utf8"));
  await writeFile(paths.state, JSON.stringify({ ...state, status: "awaiting-human-review", currentStage: "images" }));

  const snapshot = await readKoyaMangaProgressSnapshot(job);
  const images = snapshot.sections.find((section) => section.id === "scene-image").items;
  const byKey = Object.fromEntries(images.map((item) => [item.key, item]));
  assert.equal(byKey["panel:u-0003"].status, "awaiting-approval");
  assert.deepEqual(byKey["panel:u-0003"].lines.slice(1), ["QA: 合格", "品質ループ: 未開始", "台帳: 人の確認待ち"]);
  assert.equal(byKey["split-page:u-0004"].status, "awaiting-approval", "コマが止まった分割ページも人待ち");
  assert.ok(byKey["split-page:u-0004"].lines.includes("台帳: 人の確認待ち"));
  assert.equal(byKey["panel:u-0001"].status, "complete");
  assert.equal(byKey["panel:u-0001"].lines.includes("台帳: 人の確認待ち"), false);
  const statusOf = Object.fromEntries(snapshot.dag.nodes.map((node) => [node.id, node.status]));
  assert.equal(statusOf.images, "awaiting-human-review");
});

test("要素の一覧は決定的で、2回投影しても増えず、状態の変化では変わった要素だけを更新する", async (t) => {
  const projectDir = await project(t);
  const job = await createKoyaProgressJob(projectDir, { adapterResult: { status: "waiting-usage-limit" } });
  await writeCharacterApprovalPending(job.executionProjectDir);
  await approveNewCharacter(job.executionProjectDir);
  const mid = await writeMidProduction(job.executionProjectDir);

  const first = await readKoyaMangaProgressSnapshot(job);
  const second = await readKoyaMangaProgressSnapshot(structuredClone(job));
  assert.deepEqual(second, first, "同じ作業場からは同じ snapshot");
  const prepared = new Map();
  const built = buildCanvasRunProgressProjection(first, { preparedAssets: prepared });
  assert.deepEqual(buildCanvasRunProgressProjection(structuredClone(first), { preparedAssets: prepared }), built);
  assert.equal(new Set(built.elements.map((element) => element.id)).size, built.elements.length, "要素 ID は重複しない");
  assert.ok(built.elements.every((element) => /^bap_[a-f0-9]{24}$/u.test(element.id)));
  // 要素 ID は Job ID・工程・成果物のキー・SHA から決まる。
  const imageMediaId = stableCanvasProgressId(JOB_ID, "scene-image-media", `panel:u-0003:${mid.images["panel:u-0003"].sha256}`);

  const once = await projectCanvasRunProgress({ projectDir }, first, { sourceRoot: job.executionProjectDir });
  assert.ok(once.added > 0);
  assert.ok(once.changedElementIds.added.includes(imageMediaId));
  const twice = await projectCanvasRunProgress({ projectDir }, first, { sourceRoot: job.executionProjectDir });
  assert.deepEqual([twice.added, twice.updated, twice.removed], [0, 0, 0]);
  assert.equal(twice.unchanged, once.added);
  const scene = await readScene(projectDir);
  assert.equal(new Set(scene.elements.map((element) => element.id)).size, scene.elements.length);
  assert.equal(progressElements(scene).length, once.added);
  // index は scene の並び順と同じ順（新しい要素は末尾で、index も最大の後ろ）。
  const indexes = scene.elements.map((element) => element.index);
  assert.deepEqual([...indexes].sort(), indexes);

  // cut-02 の画（#2）が QA で落ちた。その格子の枠と文字、画の工程の DAG の文字（枚数）、見出しの文字（合格数）
  // だけが更新される。DAG と見出しの枠は状態（色）が変わらないので触らない。
  const paths = koyaPaths(job.executionProjectDir);
  const ledger = JSON.parse(await readFile(paths.ledger, "utf8"));
  ledger.jobs["panel:u-0003"] = { ...ledger.jobs["panel:u-0003"], status: "failed", qa: { pass: false, issues: ["合成の指摘: 背景が違う"] } };
  ledger.summary = { total: 4, complete: 2, failed: 2 };
  await writeFile(paths.ledger, JSON.stringify(ledger));
  const changed = await projectCanvasRunProgress({ projectDir }, await readKoyaMangaProgressSnapshot(job), { sourceRoot: job.executionProjectDir });
  const expected = [
    stableCanvasProgressId(JOB_ID, "scene-image-card", "panel:u-0003"),
    stableCanvasProgressId(JOB_ID, "scene-image-label", "panel:u-0003"),
    stableCanvasProgressId(JOB_ID, "dag-label", "images"),
    stableCanvasProgressId(JOB_ID, "header-label", "header"),
  ].sort();
  assert.deepEqual(changed.changedElementIds.updated, expected);
  assert.deepEqual([changed.added, changed.removed], [0, 0]);
  assert.equal(changed.changedElementIds.updated.includes(imageMediaId), false, "ラベルが変わっても画の要素は動かさない");

  // 画を作り直した（SHA が変わった）ら、古い画の要素は墓標、新しい画の要素が同じ位置に入る。
  const { makeGradientPng } = await import("./fixtures/operatorImageFixture.mjs");
  const regenerated = makeGradientPng(160, 90, 77);
  await writeFile(mid.images["panel:u-0003"].path, regenerated);
  const replaced = await projectCanvasRunProgress({ projectDir }, await readKoyaMangaProgressSnapshot(job), { sourceRoot: job.executionProjectDir });
  assert.deepEqual(replaced.changedElementIds.removed, [imageMediaId]);
  const newId = stableCanvasProgressId(JOB_ID, "scene-image-media", `panel:u-0003:${sha256(regenerated)}`);
  assert.deepEqual(replaced.changedElementIds.added, [newId]);
  const after = await readScene(projectDir);
  const oldElement = after.elements.find((element) => element.id === imageMediaId);
  const newElement = after.elements.find((element) => element.id === newId);
  assert.equal(oldElement.isDeleted, true);
  assert.deepEqual([newElement.x, newElement.y], [oldElement.x, oldElement.y]);
});

test("別の端末・別のホストの作業場（置き場の絶対パスが違う）から投影しても、同じ要素 ID・同じ配置・同じ files になる", async (t) => {
  const firstProject = await project(t, "koya-progress-host-a-");
  const secondProject = await project(t, "koya-progress-host-b-");
  const jobA = await createKoyaProgressJob(firstProject, { adapterResult: { status: "waiting-usage-limit" } });
  await writeCharacterApprovalPending(jobA.executionProjectDir);
  await approveNewCharacter(jobA.executionProjectDir);
  await writeMidProduction(jobA.executionProjectDir);
  // 同じ Job の作業場を、別の場所へそのまま写す（Claude Code と Codex、あるいは別の端末）。
  const jobB = await createKoyaProgressJob(secondProject, { adapterResult: { status: "waiting-usage-limit" } });
  await cp(jobA.executionProjectDir, jobB.executionProjectDir, { recursive: true });
  // 記録の中の絶対パスは写した先を指すように書き換える（本番の handoff の復元と同じ）。
  for (const file of Object.values(koyaPaths(jobB.executionProjectDir))) {
    if (!file.endsWith(".json")) continue;
    let text;
    try { text = await readFile(file, "utf8"); } catch { continue; }
    await writeFile(file, text.replaceAll(JSON.stringify(jobA.executionProjectDir).slice(1, -1), JSON.stringify(jobB.executionProjectDir).slice(1, -1)));
  }
  const resultA = await projectCanvasRunProgress({ projectDir: firstProject }, await readKoyaMangaProgressSnapshot(jobA), { sourceRoot: jobA.executionProjectDir });
  const resultB = await projectCanvasRunProgress({ projectDir: secondProject }, await readKoyaMangaProgressSnapshot(jobB), { sourceRoot: jobB.executionProjectDir });
  assert.equal(resultA.fingerprint, resultB.fingerprint);
  const sceneA = await readScene(firstProject);
  const sceneB = await readScene(secondProject);
  assert.deepEqual(layoutOf(progressElements(sceneB)), layoutOf(progressElements(sceneA)));
  assert.deepEqual(sceneB.files, sceneA.files);
  assert.ok(progressElements(sceneA).some((element) => element.customData.codexMediaKind === "audio"));
});

test("作業場の外を指す記録・作業場の外へ出る symlink は読まず、原本を Canvas に複製しない", async (t) => {
  const projectDir = await project(t);
  const job = await createKoyaProgressJob(projectDir, { adapterResult: { status: "awaiting-character-approval" } });
  const fixture = await writeCharacterApprovalPending(job.executionProjectDir);
  const outside = join(projectDir, "outside-secret.png");
  const { makeGradientPng } = await import("./fixtures/operatorImageFixture.mjs");
  const outsideBytes = makeGradientPng(32, 32, 99);
  await writeFile(outside, outsideBytes);
  const paths = koyaPaths(job.executionProjectDir);
  const registry = JSON.parse(await readFile(paths.registry, "utf8"));
  registry.characters[0].referenceAssets[1] = { id: "turn", role: "turnaround", path: outside, sha256: sha256(outsideBytes) };
  await writeFile(paths.registry, JSON.stringify(registry));
  // 候補 C の匿名画を、作業場の外のファイルへの symlink に差し替える。
  const linkTarget = fixture.candidates[2].blindArtifactFile;
  await rm(linkTarget);
  let symlinked = true;
  try {
    await symlink(outside, linkTarget);
  } catch {
    symlinked = false; // symlink を作れない環境（Windows の権限）では外のパスの検査だけを見る。
  }
  const snapshot = await readKoyaMangaProgressSnapshot(job);
  const items = snapshot.sections.find((section) => section.id === "character").items;
  const turnaround = items.find((item) => item.title === "三面図");
  assert.equal(turnaround.media, null);
  assert.equal(turnaround.status, "failed");
  if (symlinked) assert.equal(items.find((item) => item.title === "候補 C").media, null);
  await projectCanvasRunProgress({ projectDir }, snapshot, { sourceRoot: job.executionProjectDir });
  const copiedNames = await import("node:fs/promises").then(({ readdir }) => readdir(join(projectDir, "canvas", "assets", "harness-runs", JOB_ID)));
  assert.equal(copiedNames.includes(`${sha256(outsideBytes)}.png`), false, "外の原本は複製しない");
});

test("Windows の作業場のパス: 中か外かを区切り文字と前方一致の罠に依らず判定し、相対パスは作業場から解決する", () => {
  const win = path.win32;
  const workspace = win.join("C:\\", "work", "run", "workspace");
  const inside = win.join(workspace, "canvas", "assets", EPISODE_ID, "panel.png");
  assert.equal(isInsideKoyaWorkspace(workspace, inside, { pathApi: win }), true);
  assert.equal(isInsideKoyaWorkspace(workspace, win.join("D:\\", "elsewhere", "panel.png"), { pathApi: win }), false);
  assert.equal(isInsideKoyaWorkspace(workspace, win.join("C:\\", "work", "run", "workspace2", "panel.png"), { pathApi: win }), false);
  assert.equal(isInsideKoyaWorkspace(workspace, workspace, { pathApi: win }), false);
  assert.equal(
    resolveKoyaWorkspacePath(workspace, "assets\\characters\\face.png", { base: win.join(workspace, "canvas"), pathApi: win }),
    win.join(workspace, "canvas", "assets", "characters", "face.png"),
  );
  assert.equal(resolveKoyaWorkspacePath(workspace, "..\\outside.png", { pathApi: win }), "");
  assert.equal(resolveKoyaWorkspacePath(workspace, "", { pathApi: win }), "");
  // 実行中の OS の規則でも同じ（期待値は path.resolve で作る。Windows ではドライブ名が付くので join では合わない）。
  const posixWorkspace = path.join(path.sep, "work", "run", "workspace");
  assert.equal(resolveKoyaWorkspacePath(posixWorkspace, path.join("canvas", "a.png")), path.resolve(posixWorkspace, "canvas", "a.png"));
});

test("WAV の長さと振幅の包絡を読み、読めない形式は null", () => {
  const summary = wavSummary(makeWav(1.5, 200));
  assert.equal(summary.durationSeconds, 1.5);
  assert.equal(summary.waveform.length, 64);
  assert.ok(Math.max(...summary.waveform) === 1 && summary.waveform[0] < 0.2 && summary.waveform[32] > 0.8, "山の形の包絡");
  assert.equal(wavSummary(Buffer.from("not a wav file at all, just some bytes padding padding")), null);
});

test("projectVideoHarnessJob は漫画の Job で途中の成果物も投影し、2回目は何も増やさない。読み取りの失敗は Run の投影を止めない", async (t) => {
  const projectDir = await project(t);
  const job = await createKoyaProgressJob(projectDir, { adapterResult: { status: "waiting-usage-limit" } });
  await writeCharacterApprovalPending(job.executionProjectDir);
  await approveNewCharacter(job.executionProjectDir);
  await writeMidProduction(job.executionProjectDir);
  const first = await projectVideoHarnessJob(job, { feedbackCollector: noFeedback });
  assert.equal(first.progressProjection.ok, true, JSON.stringify(first.progressProjection));
  assert.ok(first.progressProjection.added > 0);
  const second = await projectVideoHarnessJob(job, { feedbackCollector: noFeedback });
  assert.deepEqual([second.added, second.updated], [0, 0]);
  assert.deepEqual([second.progressProjection.added, second.progressProjection.updated, second.progressProjection.removed], [0, 0, 0]);
  const state = JSON.parse(await readFile(resolveCanvasRunProgressStateFile({ projectDir }, JOB_ID), "utf8"));
  assert.equal(state.jobRevision, job.revision);

  // 古い revision の Job の投影は書かずに skip する。
  const stale = await projectVideoHarnessJob({ ...job, revision: 4 }, { feedbackCollector: noFeedback }).catch((error) => error);
  // Run の投影は古い revision を拒否する（既存の規則）。途中の投影は Run が通ったときだけ走る。
  assert.ok(stale instanceof Error);
  const staleProgress = await adapterTesting.projectVideoHarnessJobProgress({ ...job, revision: 4 });
  assert.equal(staleProgress.skipped, true);
  assert.equal(staleProgress.skippedReason, "stale-job-revision");

  const broken = await projectVideoHarnessJob({ ...job, revision: 7 }, {
    feedbackCollector: noFeedback,
    progressSnapshotReader: async () => { throw new Error("合成の読み取り失敗"); },
  });
  assert.equal(broken.progressProjection.ok, false);
  assert.match(broken.progressProjection.error, /合成の読み取り失敗/u);
  assert.ok(broken.added + broken.updated + broken.unchanged > 0, "Run の投影は進む");

  // 途中の成果物の読み取り側が無いハーネスは、何もしない。
  const other = await adapterTesting.projectVideoHarnessJobProgress({ ...job, harness: { id: "narrated-story-video" } });
  assert.deepEqual(other, { ok: true, skipped: true, skippedReason: "no-progress-reader-for-harness" });
});

test("作業場ができる前の Job でも工程の DAG だけを出し、何も読まない", async (t) => {
  const projectDir = await project(t);
  const job = await createKoyaProgressJob(projectDir, {
    executionProjectDir: undefined,
    status: "planned",
    adapterResult: undefined,
    stages: [
      { id: "doctor", status: "pending" },
      { id: "production", status: "pending" },
      { id: "audit", status: "pending" },
      { id: "canvas-projection", status: "pending" },
    ],
  });
  const snapshot = await readKoyaMangaProgressSnapshot(job);
  assert.equal(snapshot.dag.nodes.length, 13, "台本の確認（制作契約 v56 から）を含む");
  assert.ok(snapshot.dag.nodes.every((node) => node.status === "pending"));
  assert.ok(snapshot.sections.every((section) => section.items.length === 1 && section.items[0].key === "empty"));
  const result = await projectCanvasRunProgress({ projectDir }, snapshot);
  assert.equal(result.ok, true);
  assert.equal(result.assetsCopied, 0);
});

test("途中の投影の要素 ID が他の要素と衝突したら、上書きせずに止める", async (t) => {
  const projectDir = await project(t);
  const job = await createKoyaProgressJob(projectDir, { executionProjectDir: undefined, adapterResult: undefined });
  const snapshot = await readKoyaMangaProgressSnapshot(job);
  const headerId = stableCanvasProgressId(JOB_ID, "header-card", "header");
  await writeFile(join(projectDir, "canvas", "excalidraw-canvas.json"), JSON.stringify({
    type: "excalidraw", version: 2, elements: [{ id: headerId, type: "rectangle", x: 0, y: 0, width: 10, height: 10, index: "a0", customData: { mine: true } }], appState: {}, files: {},
  }));
  await assert.rejects(projectCanvasRunProgress({ projectDir }, snapshot), /衝突/u);
  const scene = await readScene(projectDir);
  assert.equal(scene.elements.length, 1, "衝突したら何も書かない");
});

test("カットを動画に差し替えた回は、差し替えのクリップの品質ループ（video-clip）の合否を開始フレームのタイルで出す", async (t) => {
  const projectDir = await project(t);
  const job = await createKoyaProgressJob(projectDir, { adapterResult: { status: "video-substitution-blocked" } });
  const workspace = job.executionProjectDir;
  await writeCharacterApprovalPending(workspace);
  await approveNewCharacter(workspace);
  await writeMidProduction(workspace);
  const paths = koyaPaths(workspace);
  // 差し替えの無い回は section を出さない。
  const before = await readKoyaMangaProgressSnapshot(job);
  assert.equal(before.sections.some((section) => section.id === "video-clip"), false);

  // cut-01 にクリップを結び付ける（開始フレームは画、クリップは合成の短い動画）。
  const cutDir = join(paths.episodeDir, "video-substitution", "cut-01");
  await mkdir(cutDir, { recursive: true });
  const startFrame = join(cutDir, "start-frame.png");
  await writeFile(startFrame, makeGradientPng(160, 90, 77));
  const clip = join(cutDir, "clip-cut-01.mp4");
  await synthVideo(clip, { salt: "progress-clip", seconds: 1 });
  const manifest = JSON.parse(await readFile(paths.manifest, "utf8"));
  manifest.cuts[0].videoSubstitution = { status: "applied", model: "kling-v2-6", clipPath: clip, clipSha256: sha256(await readFile(clip)), startFramePath: startFrame };
  await writeFile(paths.manifest, JSON.stringify(manifest));

  const waiting = await readKoyaMangaProgressSnapshot(job);
  const section = waiting.sections.find((entry) => entry.id === "video-clip");
  assert.ok(section, "差し替えのある回は section を出す");
  assert.deepEqual(section.items.map((item) => [item.key, item.status]), [["cut-01", "awaiting-approval"]]);
  assert.deepEqual(section.items[0].lines, ["クリップ: kling-v2-6", "品質ループ: 未開始"]);
  assert.equal(section.items[0].media.kind, "image", "タイルは開始フレーム（投影は画と音声だけを描く）");
  assert.ok(waiting.summaryLines.includes("動画クリップ: 合格 0 / 1"));

  // Koya の品質ループの作業フォルダ（canvas/）で合格させると、合格と出る。
  await passKoyaAssetQualityLoop({ workDir: paths.canvasDir, stage: "video-clip", subjectId: `${EPISODE_ID}.video.cut-01`, assetPath: clip });
  const passed = await readKoyaMangaProgressSnapshot(job);
  const passedSection = passed.sections.find((entry) => entry.id === "video-clip");
  assert.deepEqual(passedSection.items[0].lines, ["クリップ: kling-v2-6", "品質ループ: 合格"]);
  assert.equal(passedSection.items[0].status, "complete");
  assert.ok(passed.summaryLines.includes("動画クリップ: 合格 1 / 1"));
  const result = await projectCanvasRunProgress({ projectDir }, passed, { sourceRoot: workspace });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(await readScene(projectDir)).includes(workspace), false, "投影の中に作業場の絶対パスは出ない");
});
