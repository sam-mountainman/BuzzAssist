// 最終監査の必須監査 asset-quality-loops（契約 v54 から）: 完成の前に、回が manifest で実際に使っている
// 画・採用テイク・人物と場所の登録・回に含めたサムネを、使ったファイルそのものの SHA で品質ループの合格と
// 照らし直す。v53 の契約では対象外。回・カット・人物・場所・会話 id はすべて合成の値。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { recordAssetHumanVerification } from "../lib/assetQualityLoop.mjs";
import {
  auditKoyaEpisodeAssetQuality,
  KOYA_ASSET_QUALITY_FINAL_AUDIT_REASONS,
  KOYA_EPISODE_THUMBNAIL_PLAN_FILE_NAME,
  koyaAssetQualityFinalAuditStep,
  koyaEpisodeUsedImages,
} from "../lib/koyaAssetQualityFinalAudit.mjs";
import {
  KOYA_ASSET_QUALITY_FINAL_AUDIT_ID,
  koyaAssetQualitySubjectId,
  koyaSceneImageAssetQualitySubjectId,
  koyaVoiceTakeAssetQualitySubjectId,
  validateKoyaAssetQualityGateContract,
} from "../lib/koyaAssetQualityGatePolicy.mjs";
import { evaluateKoyaFinalAuditSteps } from "../lib/koyaMangaFinalAudit.mjs";
import { validateKoyaMangaProductionContract } from "../lib/koyaMangaProductionContract.mjs";
import { renderEditorialPlatePng } from "../lib/mangaScriptImagePipeline.mjs";
import { wav } from "./fixtures/assetQualityFixtures.mjs";
import { currentKoyaContract, legacyKoyaContract, passKoyaAssetQualityLoop } from "./helpers/koyaAssetQualityFixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const EPISODE = "synthetic-ep";
const HERO = "synthetic-hero";
const STREET = "synthetic-street";

async function tempRoot(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeBytes(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return file;
}

/**
 * 合成の回: cut-01 は1枚の画＋決定論の板、cut-02 は分割ページ（2コマ）。人物1人（登録時の合格の記録あり）と
 * 場所1つ（記録の無い旧登録）。採用テイクはカットごとに1本。
 */
async function episodeProject(t, prefix = "koya-final-asset-quality-") {
  const projectDir = await tempRoot(t, prefix);
  const canvasDir = join(projectDir, "canvas");
  const assetDir = join(canvasDir, "assets", EPISODE);
  const episodeDir = join(canvasDir, "manga-videos", EPISODE);
  const sourceDir = join(episodeDir, ".koya-dialogue-source");
  const location = { id: STREET, name: "合成の通り" };
  const images = {
    scene: await writeBytes(join(assetDir, "cut-01-u01.png"), renderEditorialPlatePng("pastel-sky", 320, 180)),
    plate: await writeBytes(join(assetDir, "cut-01-u02-white-solid.png"), renderEditorialPlatePng("white-solid", 320, 180)),
    panelA: await writeBytes(join(assetDir, "cut-02-u03-p1.png"), renderEditorialPlatePng("black-solid", 320, 180)),
    panelB: await writeBytes(join(assetDir, "cut-02-u03-p2.png"), Buffer.concat([renderEditorialPlatePng("black-solid", 320, 180), Buffer.from("synthetic-panel-b")])),
    page: await writeBytes(join(assetDir, "cut-02-u03-vertical-2.png"), renderEditorialPlatePng("pastel-sky", 1920, 1080)),
  };
  const plan = {
    version: "synthetic-plan",
    episodeId: EPISODE,
    assetDir,
    jobs: [
      { id: "image:cut-01-u01", kind: "scene-image", outputPath: images.scene, characterIds: [HERO], location },
      { id: "plate:cut-01-u02", kind: "editorial-plate", outputPath: images.plate },
      { id: "panel:cut-02-u03:1", kind: "split-panel", outputPath: images.panelA, characterIds: [HERO], location },
      { id: "panel:cut-02-u03:2", kind: "split-panel", outputPath: images.panelB, characterIds: [], location },
      { id: "split-page:cut-02-u03", kind: "split-page", outputPath: images.page, panelPaths: [images.panelA, images.panelB] },
    ],
  };
  const planPath = join(assetDir, "script-image-plan.json");
  await writeJson(planPath, plan);
  const ledgerPath = join(assetDir, "image-generation-ledger.json");
  await writeJson(ledgerPath, {
    status: "complete",
    jobs: Object.fromEntries(plan.jobs.map((job) => [job.id, { id: job.id, status: "complete", outputPath: job.outputPath }])),
  });
  const takes = {
    "cut-01": await writeBytes(join(sourceDir, "cut-01-take-2-synthetic.wav"), wav("take-cut-01")),
    "cut-02": await writeBytes(join(sourceDir, "cut-02-take-1-synthetic.wav"), wav("take-cut-02")),
  };
  const speechReportPath = join(episodeDir, "koya-dialogue-generation.json");
  await writeJson(speechReportPath, {
    status: "complete",
    cuts: Object.entries(takes).map(([cutId, file]) => ({ cutId, status: "complete", sourcePath: file })),
  });
  const utterance = (id, cutId) => ({ id, cutId, text: "合成の台詞", audio: { sourceDialoguePath: takes[cutId] } });
  const manifest = {
    id: EPISODE,
    utterances: [utterance("cut-01-u01", "cut-01"), utterance("cut-01-u02", "cut-01"), utterance("cut-02-u03", "cut-02")],
    cuts: [
      {
        id: "cut-01",
        utteranceIds: ["cut-01-u01", "cut-01-u02"],
        imagePath: images.scene,
        cameraSequence: [{ id: "shot-1", imagePath: images.scene }, { id: "shot-2", imagePath: images.plate }],
      },
      {
        id: "cut-02",
        utteranceIds: ["cut-02-u03"],
        imagePath: images.page,
        cameraSequence: [],
        panelLayout: { enabled: true, panels: [{ imagePath: images.panelA }, { imagePath: images.panelB }] },
      },
    ],
    production: {
      imagePlan: { path: planPath },
      audioPipeline: { reportPath: speechReportPath },
    },
  };
  const manifestPath = join(episodeDir, "episode-manifest.json");
  await writeJson(manifestPath, manifest);
  await writeJson(join(episodeDir, "koya-production-state.json"), { status: "rendered-awaiting-audit", imageLedgerPath: ledgerPath });

  // 登録簿: 人物は登録の時点で三面図・表情の品質ループの合格を記録済み（選ばれた顔は対象外）。
  // 場所は合格の記録を持たない旧登録。
  const heroDir = join(canvasDir, "characters", HERO);
  const heroFiles = {
    face: await writeBytes(join(heroDir, "face.png"), renderEditorialPlatePng("pastel-sky", 256, 256)),
    turnaround: await writeBytes(join(heroDir, "turnaround.png"), renderEditorialPlatePng("white-solid", 640, 360)),
    expression: await writeBytes(join(heroDir, "expression.png"), renderEditorialPlatePng("black-solid", 640, 360)),
  };
  const streetBoard = await writeBytes(join(canvasDir, "locations", STREET, "board-1.png"), renderEditorialPlatePng("white-solid", 320, 180));
  const heroAssets = [];
  for (const [id, role, file] of [["selected-face", "identity-face", heroFiles.face], ["turnaround", "turnaround", heroFiles.turnaround], ["expression", "expression", heroFiles.expression]]) {
    heroAssets.push({ id, role, path: path.relative(canvasDir, file), sha256: sha(await readFile(file)) });
  }
  const registry = {
    version: 1,
    revision: 0,
    characters: [
      {
        id: HERO,
        name: "合成の主人公",
        kind: "character",
        role: "fixed",
        status: "approved",
        referenceAssets: heroAssets,
        approval: {
          route: "synthetic",
          assetQuality: {
            version: "koya-asset-quality-gate-v1",
            contractVersion: "koya-manga-production-v54",
            rows: heroAssets.filter((row) => row.role !== "identity-face").map((row) => ({
              stage: "character",
              subjectId: koyaAssetQualitySubjectId(HERO, row.role),
              assetSha256: row.sha256,
            })),
          },
        },
      },
      {
        id: STREET,
        name: "合成の通り",
        kind: "location",
        role: "fixed",
        status: "approved",
        referenceAssets: [{ id: "board-1", role: "supplemental", path: path.relative(canvasDir, streetBoard), sha256: sha(await readFile(streetBoard)) }],
        approval: { route: "synthetic-before-gate" },
      },
    ],
  };
  await writeJson(join(canvasDir, "characters.json"), registry);
  return { projectDir, canvasDir, assetDir, episodeDir, manifest, manifestPath, plan, planPath, ledgerPath, speechReportPath, images, takes, heroFiles };
}

const subjects = {
  scene: koyaSceneImageAssetQualitySubjectId(EPISODE, "image:cut-01-u01"),
  panelA: koyaSceneImageAssetQualitySubjectId(EPISODE, "panel:cut-02-u03:1"),
  panelB: koyaSceneImageAssetQualitySubjectId(EPISODE, "panel:cut-02-u03:2"),
  take1: koyaVoiceTakeAssetQualitySubjectId(EPISODE, "cut-01"),
  take2: koyaVoiceTakeAssetQualitySubjectId(EPISODE, "cut-02"),
};

async function passAllLoops(fixture) {
  const workDir = fixture.canvasDir;
  await passKoyaAssetQualityLoop({ workDir, stage: "scene-image", subjectId: subjects.scene, assetPath: fixture.images.scene });
  await passKoyaAssetQualityLoop({ workDir, stage: "scene-image", subjectId: subjects.panelA, assetPath: fixture.images.panelA });
  await passKoyaAssetQualityLoop({ workDir, stage: "scene-image", subjectId: subjects.panelB, assetPath: fixture.images.panelB });
  await passKoyaAssetQualityLoop({ workDir, stage: "voice-take", subjectId: subjects.take1, assetPath: fixture.takes["cut-01"] });
  await passKoyaAssetQualityLoop({ workDir, stage: "voice-take", subjectId: subjects.take2, assetPath: fixture.takes["cut-02"] });
}

async function audit(fixture, contract, extra = {}) {
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  return auditKoyaEpisodeAssetQuality({ contract, manifest, manifestPath: fixture.manifestPath, projectDir: fixture.projectDir, ...extra });
}

function codesOf(report) {
  return report.failures.map((row) => row.code).sort();
}

test("契約: v54 は最終監査の必須監査に asset-quality-loops を要り、v53 の一覧はそのまま通る", async () => {
  const current = await currentKoyaContract(root);
  assert.ok(current.requiredAudits.includes(KOYA_ASSET_QUALITY_FINAL_AUDIT_ID));
  assert.equal(validateKoyaMangaProductionContract(current).pass, true);

  const dropped = structuredClone(current);
  dropped.requiredAudits = dropped.requiredAudits.filter((id) => id !== KOYA_ASSET_QUALITY_FINAL_AUDIT_ID);
  assert.ok(validateKoyaAssetQualityGateContract(dropped).some((row) => row.path === "requiredAudits" && row.message.includes(KOYA_ASSET_QUALITY_FINAL_AUDIT_ID)));
  assert.equal(validateKoyaMangaProductionContract(dropped).pass, false, "v54 から監査を外して黙って完成させる道を残さない");

  const legacy = await legacyKoyaContract(root);
  legacy.requiredAudits = legacy.requiredAudits.filter((id) => id !== KOYA_ASSET_QUALITY_FINAL_AUDIT_ID);
  const legacyValidation = validateKoyaMangaProductionContract(legacy);
  assert.equal(legacyValidation.pass, true, JSON.stringify(legacyValidation.failures));

  // v54 の契約で監査の結果が無ければ、最終監査は確定しない。
  const steps = current.requiredAudits.filter((id) => id !== KOYA_ASSET_QUALITY_FINAL_AUDIT_ID).map((id) => ({ id, pass: true }));
  const evaluation = evaluateKoyaFinalAuditSteps(current, steps);
  assert.equal(evaluation.pass, false);
  assert.deepEqual(evaluation.missingAuditIds, [KOYA_ASSET_QUALITY_FINAL_AUDIT_ID]);
  assert.equal(evaluateKoyaFinalAuditSteps(legacy, steps).pass, true, "v53 の回は従来どおり確定できる");
});

test("RunReceipt: 保証 asset-quality-loops は v54 から。v53 の回は対象外のまま合格、v54 の回はこの監査が落ちれば不合格", async () => {
  const { finalizeRunReceipt, openRunReceipt, recordGatesFromAuditSteps } = await import("../lib/harnessRunReceipt.mjs");
  const declaration = JSON.parse(await readFile(join(root, "config/harnesses/koya-manga-video.harness.json"), "utf8"));
  const guarantee = declaration.guarantees.find((row) => row.id === KOYA_ASSET_QUALITY_FINAL_AUDIT_ID);
  assert.deepEqual([guarantee?.inForceSince, guarantee?.evidenceAuditIds], ["koya-manga-production-v54", [KOYA_ASSET_QUALITY_FINAL_AUDIT_ID]]);
  const current = await currentKoyaContract(root);
  const v53Roster = current.requiredAudits.filter((id) => id !== KOYA_ASSET_QUALITY_FINAL_AUDIT_ID);
  const measure = (requiredAuditIds, contractVersion, failing = "") => {
    const receipt = openRunReceipt({ projectDir: root, harnessId: "koya-manga-video", entrypoint: "scripts/koya-manga-video.mjs", action: "audit", inputs: { synthetic: true } });
    recordGatesFromAuditSteps(receipt, {
      declaration,
      steps: requiredAuditIds.map((id) => ({ id, pass: id !== failing })),
      requiredAuditIds,
      contractVersion,
    });
    return finalizeRunReceipt(receipt, { outcome: "pass", timestamp: "2026-09-25T00:00:00.000Z" });
  };
  const past = measure(v53Roster, "koya-manga-production-v53");
  assert.equal(past.outcome, "pass");
  assert.deepEqual(past.summary.notInForceGates, [KOYA_ASSET_QUALITY_FINAL_AUDIT_ID]);
  assert.equal(measure(current.requiredAudits, current.version).outcome, "pass");
  const failed = measure(current.requiredAudits, current.version, KOYA_ASSET_QUALITY_FINAL_AUDIT_ID);
  assert.equal(failed.outcome, "fail");
  assert.deepEqual(failed.summary.failedGates, [KOYA_ASSET_QUALITY_FINAL_AUDIT_ID]);
  assert.equal(measure(v53Roster, current.version).outcome, "fail", "v54 の契約で監査が無い（縮んだ）なら合格にしない");
});

test("v53 の契約では対象外（合格・applicable=false）。何も読まずに従来どおり確定できる", async (t) => {
  const fixture = await episodeProject(t);
  const report = await audit(fixture, await legacyKoyaContract(root));
  assert.equal(report.applicable, false);
  assert.equal(report.pass, true);
  assert.deepEqual(report.failures, []);
  const step = koyaAssetQualityFinalAuditStep(report, "evidence.json");
  assert.deepEqual([step.id, step.pass, step.extra.applicable], [KOYA_ASSET_QUALITY_FINAL_AUDIT_ID, true, false]);
});

test("画と声: 使った画（分割ページの各コマ）と採用テイクのループが無ければ落ち、合格すれば通る。板と合成ページは対象外", async (t) => {
  const fixture = await episodeProject(t);
  const contract = await currentKoyaContract(root);
  assert.deepEqual(koyaEpisodeUsedImages(fixture.manifest).map((row) => path.basename(row.path)).sort(), [
    "cut-01-u01.png", "cut-01-u02-white-solid.png", "cut-02-u03-p1.png", "cut-02-u03-p2.png", "cut-02-u03-vertical-2.png",
  ]);

  const blocked = await audit(fixture, contract);
  assert.equal(blocked.applicable, true);
  assert.equal(blocked.pass, false);
  assert.deepEqual(codesOf(blocked), [
    `asset-quality-required:scene-image:${subjects.scene}:loop-not-started`,
    `asset-quality-required:scene-image:${subjects.panelA}:loop-not-started`,
    `asset-quality-required:scene-image:${subjects.panelB}:loop-not-started`,
    `asset-quality-required:voice-take:${subjects.take1}:loop-not-started`,
    `asset-quality-required:voice-take:${subjects.take2}:loop-not-started`,
  ].sort());
  const deterministic = blocked.sceneImages.filter((row) => row.required === false).map((row) => row.jobKind).sort();
  assert.deepEqual(deterministic, ["editorial-plate", "split-page"]);
  assert.match(koyaAssetQualityFinalAuditStep(blocked).detail, /^5 件: asset-quality-required:/u);

  await passAllLoops(fixture);
  const passed = await audit(fixture, contract);
  assert.equal(passed.pass, true, JSON.stringify(passed.failures, null, 2));
  assert.deepEqual(passed.counts, { sceneImages: 3, voiceTakes: 2, videoClips: 0, registryEntries: 2, outOfForce: 1, unregisteredLocations: 0, thumbnailIncluded: false });
  assert.deepEqual(passed.outOfForce, [{ kind: "location", id: STREET, reason: "registered-before-gate" }], "記録の無い旧登録は落とさず表に出す");
  assert.equal(passed.registry.find((row) => row.id === HERO).pass, true);
  assert.match(passed.detail, /^passed（画 3・声 2・人物\/場所 2、効力の外の旧登録 1）$/u);

  // 合格の後に画が別のバイト列へ差し替わった（再利用の行・汎用の経路）→ その合格は今のファイルを保証しない。
  await writeFile(fixture.images.panelB, Buffer.concat([renderEditorialPlatePng("black-solid", 320, 180), Buffer.from("synthetic-swapped")]));
  const swapped = await audit(fixture, contract);
  assert.deepEqual(codesOf(swapped), [`asset-quality-required:scene-image:${subjects.panelB}:asset-sha-mismatch`]);

  // 採用テイクの記録が無い発話（承認済みの声の再利用で記録が落ちた等）は、テイクの合格を確かめられない。
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  delete manifest.utterances[1].audio.sourceDialoguePath;
  await writeJson(fixture.manifestPath, manifest);
  const unrecorded = await audit(fixture, contract);
  assert.ok(codesOf(unrecorded).includes(`asset-quality-required:voice-take:${subjects.take1}:take-unrecorded`));
});

test("計画に無い画（汎用の経路・standard-cut で入った画）は、その画の対象 id のループが要る", async (t) => {
  const fixture = await episodeProject(t);
  const contract = await currentKoyaContract(root);
  await passAllLoops(fixture);
  const outside = await writeBytes(join(fixture.canvasDir, "assets", "manual", "replacement.png"), renderEditorialPlatePng("white-solid", 320, 180));
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  manifest.cuts[0].cameraSequence[0].imagePath = outside;
  await writeJson(fixture.manifestPath, manifest);
  const unplannedSubject = koyaSceneImageAssetQualitySubjectId(EPISODE, "unplanned.replacement");
  const blocked = await audit(fixture, contract);
  assert.deepEqual(codesOf(blocked), [`asset-quality-required:scene-image:${unplannedSubject}:loop-not-started`]);
  assert.match(blocked.failures[0].detail, /画像計画に無い画/u);
  await passKoyaAssetQualityLoop({ workDir: fixture.canvasDir, stage: "scene-image", subjectId: unplannedSubject, assetPath: outside });
  assert.equal((await audit(fixture, contract)).pass, true);

  // 画像計画が読めない回は、どの画がどの行か決められないので落とす。
  await rm(fixture.planPath);
  const planless = await audit(fixture, contract);
  assert.equal(planless.pass, false);
  assert.ok(planless.failures.some((row) => row.reason === "asset-missing" && /画像計画を読めない/u.test(row.detail)));
});

test("人物・場所: 登録時に合格した版と今の参照画の SHA・ファイルが一致しなければ落とす。記録の無い旧登録は効力の外", async (t) => {
  const fixture = await episodeProject(t);
  const contract = await currentKoyaContract(root);
  await passAllLoops(fixture);
  const registryPath = join(fixture.canvasDir, "characters.json");
  const original = JSON.parse(await readFile(registryPath, "utf8"));

  // 登録の後に三面図が差し替わった（ゲートを通らない refresh 等）。登録簿の SHA も新しい版に書き換わっている。
  const refreshed = structuredClone(original);
  const newTurnaround = await writeBytes(join(fixture.canvasDir, "characters", HERO, "turnaround-v2.png"), renderEditorialPlatePng("pastel-sky", 640, 360));
  const turnaround = refreshed.characters[0].referenceAssets.find((row) => row.id === "turnaround");
  turnaround.path = path.relative(fixture.canvasDir, newTurnaround);
  turnaround.sha256 = sha(await readFile(newTurnaround));
  await writeJson(registryPath, refreshed);
  const mismatch = await audit(fixture, contract);
  assert.deepEqual(codesOf(mismatch), [
    `asset-quality-required:character:${koyaAssetQualitySubjectId(HERO, "turnaround")}:registered-sha-mismatch`,
    `asset-quality-required:character:${koyaAssetQualitySubjectId(HERO, "turnaround")}:registered-sha-mismatch`,
  ], "今の版は合格の記録に無く、合格した版は今の参照画に無い（両方向）");

  // 登録簿はそのままで、参照画のファイルだけが別のバイト列になった。
  await writeJson(registryPath, original);
  await writeFile(fixture.heroFiles.expression, Buffer.concat([await readFile(fixture.heroFiles.expression), Buffer.from("synthetic-edit")]));
  const drift = await audit(fixture, contract);
  assert.deepEqual(codesOf(drift), [`asset-quality-required:character:${koyaAssetQualitySubjectId(HERO, "expression")}:reference-file-changed`]);

  // 画に出る人物が登録簿に無い。
  const removed = structuredClone(original);
  removed.characters = removed.characters.filter((row) => row.id !== HERO);
  await writeJson(registryPath, removed);
  const missing = await audit(fixture, contract);
  assert.deepEqual(codesOf(missing), [`asset-quality-required:character:${koyaAssetQualitySubjectId(HERO)}:registry-entry-missing`]);

  // 登録の無い場所（環境アトラスで描き起こした場所）は落とさず、見える所に出す。
  const withoutStreet = structuredClone(original);
  withoutStreet.characters = withoutStreet.characters.filter((row) => row.id !== STREET);
  await writeJson(registryPath, withoutStreet);
  await writeFile(fixture.heroFiles.expression, renderEditorialPlatePng("black-solid", 640, 360));
  const noLocation = await audit(fixture, contract);
  assert.equal(noLocation.pass, true, JSON.stringify(noLocation.failures));
  assert.deepEqual(noLocation.unregisteredLocations, [{ id: STREET, name: "合成の通り" }]);
  assert.match(noLocation.detail, /登録の無い場所 1/u);
});

test("人の確認待ち: 画の台帳・音声の報告に awaiting-human-review が残っていれば落とす", async (t) => {
  const fixture = await episodeProject(t);
  const contract = await currentKoyaContract(root);
  await passAllLoops(fixture);
  const ledger = JSON.parse(await readFile(fixture.ledgerPath, "utf8"));
  ledger.jobs["image:cut-01-u01"] = { ...ledger.jobs["image:cut-01-u01"], status: "awaiting-human-review", assetQuality: { subjectId: subjects.scene, code: "synthetic-code" } };
  await writeJson(fixture.ledgerPath, ledger);
  const report = JSON.parse(await readFile(fixture.speechReportPath, "utf8"));
  report.status = "awaiting-human-review";
  report.cuts[1] = { ...report.cuts[1], status: "awaiting-human-review", assetQuality: { subjectId: subjects.take2 } };
  await writeJson(fixture.speechReportPath, report);
  const held = await audit(fixture, contract);
  assert.deepEqual(codesOf(held), [
    `asset-quality-required:scene-image:${subjects.scene}:awaiting-human-review`,
    `asset-quality-required:voice-take:${subjects.take2}:awaiting-human-review`,
  ]);
  assert.equal(held.awaitingHumanReview.imageLedgerPath, fixture.ledgerPath);
});

test("サムネ: 回に含めたときだけ final の監査の合格が要る（無し・preflight・品質ループ未合格・合格）", async (t) => {
  const fixture = await episodeProject(t);
  const contract = await currentKoyaContract(root);
  await passAllLoops(fixture);
  assert.equal((await audit(fixture, contract)).thumbnail.included, false, "含めていなければ見ない");

  const planPath = join(fixture.episodeDir, KOYA_EPISODE_THUMBNAIL_PLAN_FILE_NAME);
  const artwork = await writeBytes(join(fixture.canvasDir, "thumbs", "idea-a.png"), renderEditorialPlatePng("white-solid", 1280, 720));
  await writeJson(planPath, { version: "koya-thumbnail-plan-v1", stage: "preflight", artworkPaths: [artwork] });
  const planSubject = koyaAssetQualitySubjectId(EPISODE, "thumbnail");
  const preflight = await audit(fixture, contract, { thumbnailContract: { synthetic: true }, auditThumbnailPlan: async () => ({ pass: true, assetQuality: [] }) });
  assert.deepEqual(codesOf(preflight), [`asset-quality-required:thumbnail:${planSubject}:thumbnail-not-final`]);

  await writeJson(planPath, { version: "koya-thumbnail-plan-v1", stage: "final", artworkPaths: [artwork] });
  const calls = [];
  const thumbnailAudit = (loopPass, otherFailures = []) => async (options) => {
    calls.push(options);
    const row = { stage: "thumbnail", subjectId: "thumbnail.idea-a", assetPath: artwork, pass: loopPass, reason: loopPass ? "passed" : "loop-not-started", code: loopPass ? "" : "asset-quality-required:thumbnail:thumbnail.idea-a:loop-not-started" };
    return { pass: loopPass && otherFailures.length === 0, readyForPublish: loopPass && otherFailures.length === 0, assetQuality: [row], failures: [...(loopPass ? [] : [row.code]), ...otherFailures] };
  };
  const loopMissing = await audit(fixture, contract, { thumbnailContract: { synthetic: true }, auditThumbnailPlan: thumbnailAudit(false) });
  assert.deepEqual(codesOf(loopMissing), ["asset-quality-required:thumbnail:thumbnail.idea-a:loop-not-started"]);
  assert.equal(calls.at(-1).productionContract, contract, "サムネの監査は同じ制作契約で走らせる");

  const otherFailure = await audit(fixture, contract, { thumbnailContract: { synthetic: true }, auditThumbnailPlan: thumbnailAudit(true, ["Thumbnail brand tokens are pending"]) });
  assert.deepEqual(codesOf(otherFailure), [`asset-quality-required:thumbnail:${planSubject}:thumbnail-audit-failed`]);

  const passed = await audit(fixture, contract, { thumbnailContract: { synthetic: true }, auditThumbnailPlan: thumbnailAudit(true) });
  assert.equal(passed.pass, true, JSON.stringify(passed.failures));
  assert.equal(passed.thumbnail.included, true);
  assert.equal(passed.counts.thumbnailIncluded, true);
});

test("サムネ: 実際の final 監査（auditKoyaThumbnailPlan）で専用画のループの合格まで見る", async (t) => {
  const fixture = await episodeProject(t);
  const contract = await currentKoyaContract(root);
  await passAllLoops(fixture);
  const { koyaThumbnailCopySha256, readKoyaChannelAuthority } = await import("../lib/koyaChannelGovernance.mjs");
  const authority = await readKoyaChannelAuthority({ allowFixture: true, projectDir: fixture.projectDir, runtimeRoot: root });
  const thumbnailContract = structuredClone(authority.thumbnailContract);
  thumbnailContract.visual.bandColorToken = "band-red-v1";
  thumbnailContract.visual.bandFontToken = "font-gothic-v1";
  const dir = join(fixture.canvasDir, "thumbs");
  const artworkA = await writeBytes(join(dir, "idea-a-v1.png"), renderEditorialPlatePng("black-solid", 1280, 720));
  const artworkB = await writeBytes(join(dir, "idea-b-v1.png"), renderEditorialPlatePng("white-solid", 1280, 720));
  const frame = await writeBytes(join(dir, "frame.png"), renderEditorialPlatePng("pastel-sky", 1280, 720));
  const plan = {
    version: "koya-thumbnail-plan-v1",
    stage: "final",
    layout: "twoPanel",
    bandLines: ["合成の見出し", "合成の二行目"],
    speechBubbles: [{ panelId: "left", lines: ["合成の台詞"] }],
    telops: [{ text: "合成語", concreteNounReviewPassed: true }],
    exactTextApproved: true,
    artworkPaths: [artworkA, artworkB],
    mainVideoFramePaths: [frame],
    checks: { original1280x720: true, mobile320x180: true, textCropZero: true, faceCropZero: true, primaryEmotionReadable: true, approvedCharacterReferencesOnly: true, realLogoZero: true },
  };
  plan.textApproval = { approvedBy: "synthetic-approver", approvedAt: "2026-09-25T00:00:00.000Z", copySha256: koyaThumbnailCopySha256(plan) };
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  const planPath = join(fixture.episodeDir, "thumbnail", "final-plan.json");
  await writeJson(planPath, plan);
  manifest.outputs = { thumbnail: { planPath } };
  await writeJson(fixture.manifestPath, manifest);

  const blocked = await audit(fixture, contract, { thumbnailContract });
  assert.deepEqual(codesOf(blocked), [
    "asset-quality-required:thumbnail:thumbnail.idea-a-v1:loop-not-started",
    "asset-quality-required:thumbnail:thumbnail.idea-b-v1:loop-not-started",
  ]);
  await passKoyaAssetQualityLoop({ workDir: fixture.canvasDir, stage: "thumbnail", subjectId: "thumbnail.idea-a-v1", assetPath: artworkA });
  await passKoyaAssetQualityLoop({ workDir: fixture.canvasDir, stage: "thumbnail", subjectId: "thumbnail.idea-b-v1", assetPath: artworkB, stopBefore: "human" });
  const awaitingHuman = await audit(fixture, contract, { thumbnailContract });
  assert.deepEqual(codesOf(awaitingHuman), ["asset-quality-required:thumbnail:thumbnail.idea-b-v1:not-passed"]);
  await recordAssetHumanVerification({
    workDir: fixture.canvasDir, stage: "thumbnail", subjectId: "thumbnail.idea-b-v1", assetPath: artworkB, checks: ["hand-safety"],
    verdict: "pass", reviewer: "synthetic-reviewer", note: "手元を拡大して見た（合成）", humanVerified: true, isInteractive: true,
  });
  const passed = await audit(fixture, contract, { thumbnailContract });
  assert.equal(passed.pass, true, JSON.stringify(passed.failures));
  assert.equal(passed.thumbnail.readyForPublish, true);
});

test("最終監査（auditKoyaMangaFinal）は asset-quality-loops を必須監査として記録し、証拠のファイルを残す", async (t) => {
  const { execFile: execFileCallback } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFile = promisify(execFileCallback);
  try {
    await execFile("ffprobe", ["-version"]);
  } catch {
    t.skip("ffmpeg/ffprobe が無い環境");
    return;
  }
  const { auditKoyaMangaFinal } = await import("../lib/koyaMangaFinalAudit.mjs");
  const { createKoyaOuterJobBinding } = await import("../lib/koyaOuterJobBinding.mjs");
  const fixture = await episodeProject(t, "koya-final-asset-quality-e2e-");
  const identityDigest = sha("synthetic-identity");
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  manifest.production.outerJobBinding = createKoyaOuterJobBinding({
    jobId: `video-koya-manga-video-${identityDigest.slice(0, 16)}`,
    identityDigest,
    executionIdentityDigest: sha("synthetic-execution"),
    resolvedProductionContractSha256: sha("synthetic-contract"),
  });
  // 画と声を使わない回にして、最終監査の配線だけを見る（画像計画が無いので asset-quality-loops は落ちる）。
  manifest.cuts = [];
  manifest.utterances = [];
  delete manifest.production.imagePlan;
  await writeJson(fixture.manifestPath, manifest);
  await rm(fixture.planPath);
  const videoPath = join(fixture.episodeDir, "review.mp4");
  await execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x36:d=1", "-pix_fmt", "yuv420p", videoPath]);
  const result = await auditKoyaMangaFinal({
    projectDir: fixture.projectDir,
    manifestPath: fixture.manifestPath,
    videoPath,
    dryRun: true,
    env: {},
  });
  assert.ok(result.report.requiredAuditIds.includes(KOYA_ASSET_QUALITY_FINAL_AUDIT_ID));
  const step = result.report.steps.find((row) => row.id === KOYA_ASSET_QUALITY_FINAL_AUDIT_ID);
  assert.ok(step, "asset-quality-loops の結果が監査の steps にあること");
  assert.equal(step.pass, false);
  assert.equal(step.applicable, true);
  assert.equal(path.basename(step.evidencePath), `${KOYA_ASSET_QUALITY_FINAL_AUDIT_ID}.json`);
  const evidence = JSON.parse(await readFile(step.evidencePath, "utf8"));
  assert.equal(evidence.auditId, KOYA_ASSET_QUALITY_FINAL_AUDIT_ID);
  assert.ok(evidence.failures.some((row) => /画像計画を読めない/u.test(row.detail)));
  assert.ok(result.report.failedAuditIds.includes(KOYA_ASSET_QUALITY_FINAL_AUDIT_ID));
  assert.ok(result.report.knownRemainingIssues.some((issue) => issue.id === KOYA_ASSET_QUALITY_FINAL_AUDIT_ID));
});

test("理由コードの一覧は1つの成果物のループの理由を含み、重複しない", () => {
  for (const reason of ["loop-not-started", "not-passed", "asset-sha-mismatch", "asset-missing", "outside-work-dir", "take-unrecorded", "registered-sha-mismatch", "awaiting-human-review"]) {
    assert.ok(KOYA_ASSET_QUALITY_FINAL_AUDIT_REASONS.includes(reason), reason);
  }
  assert.equal(new Set(KOYA_ASSET_QUALITY_FINAL_AUDIT_REASONS).size, KOYA_ASSET_QUALITY_FINAL_AUDIT_REASONS.length);
});
