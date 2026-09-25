// 漫画の公式経路で、途中の成果物を使う前に品質ループの合格を要求するゲート（契約 v54 から）。
// サムネ・場所・人物の工程ごとに: ループ未合格 → 止まる（理由コード）/ 合格 → 通る /
// 合格した版と SHA が違う → 止まる / 古い契約（v53）→ 従来どおり。人物・場所・回・会話 id・所見はすべて合成の値。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { APPROVED_REFERENCES_VERSION } from "../lib/assetQualityLoop.mjs";
import {
  auditKoyaThumbnailPlan,
  koyaThumbnailAssetQualitySubjectId,
  koyaThumbnailCopySha256,
  readKoyaChannelAuthority,
  registerApprovedKoyaLocation,
} from "../lib/koyaChannelGovernance.mjs";
import { writeKoyaApprovedReferences } from "../lib/koyaAssetQualityGate.mjs";
import { KOYA_ASSET_QUALITY_GATE_IN_FORCE_SINCE, KOYA_ASSET_QUALITY_REQUIRED_CODE } from "../lib/koyaAssetQualityGatePolicy.mjs";
import { koyaIdentityPackAssetQualitySubjects, registerKoyaCharacterIdentity } from "../lib/koyaMangaProduction.mjs";
import { renderEditorialPlatePng } from "../lib/mangaScriptImagePipeline.mjs";
import { legacyKoyaContract, passKoyaAssetQualityLoop } from "./helpers/koyaAssetQualityFixture.mjs";
import { importAndRegisterSyntheticLocation, installSyntheticKoyaAuthority } from "./helpers/koyaLocationFixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const sha = (value) => createHash("sha256").update(value).digest("hex");

async function tempRoot(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("サムネ: final の専用画は thumbnail 工程のループ合格が要る（未合格・合格・SHA 違い・古い契約）", async (t) => {
  const projectDir = await tempRoot(t, "koya-thumb-gate-");
  const authority = await readKoyaChannelAuthority({ allowFixture: true, projectDir, runtimeRoot: root });
  const thumbnailContract = structuredClone(authority.thumbnailContract);
  thumbnailContract.visual.bandColorToken = "band-red-v1";
  thumbnailContract.visual.bandFontToken = "font-gothic-v1";
  const dir = join(projectDir, "canvas", "thumbs");
  await mkdir(dir, { recursive: true });
  const artworkA = join(dir, "idea-a-v1.png");
  const artworkB = join(dir, "idea-b-v1.png");
  const frame = join(dir, "frame.png");
  await writeFile(artworkA, renderEditorialPlatePng("black-solid", 1280, 720));
  await writeFile(artworkB, renderEditorialPlatePng("white-solid", 1280, 720));
  await writeFile(frame, renderEditorialPlatePng("pastel-sky", 1280, 720));
  const plan = {
    version: "koya-thumbnail-plan-v1",
    stage: "final",
    layout: "twoPanel",
    bandLines: ["合成の見出し", "合成の二行目"],
    speechBubbles: [{ panelId: "left", lines: ["合成の台詞"] }],
    telops: [{ text: "合成語", concreteNounReviewPassed: true }],
    exactTextApproved: true,
    artworkPaths: [artworkA, artworkB],
    artworkQualitySubjectIds: ["synthetic-thumb-a", ""],
    mainVideoFramePaths: [frame],
    checks: { original1280x720: true, mobile320x180: true, textCropZero: true, faceCropZero: true, primaryEmotionReadable: true, approvedCharacterReferencesOnly: true, realLogoZero: true },
  };
  plan.textApproval = { approvedBy: "synthetic-approver", approvedAt: "2026-09-25T00:00:00.000Z", copySha256: koyaThumbnailCopySha256(plan) };
  const subjectA = koyaThumbnailAssetQualitySubjectId(plan, 0, artworkA);
  const subjectB = koyaThumbnailAssetQualitySubjectId(plan, 1, artworkB);
  assert.equal(subjectA, "synthetic-thumb-a");
  assert.equal(subjectB, "thumbnail.idea-b-v1");

  const blocked = await auditKoyaThumbnailPlan({ projectDir, thumbnailContract, plan });
  assert.equal(blocked.pass, false);
  assert.ok(blocked.failures.some((line) => line.startsWith(`asset-quality-required:thumbnail:${subjectA}:loop-not-started`)));
  assert.ok(blocked.failures.some((line) => line.startsWith(`asset-quality-required:thumbnail:${subjectB}:loop-not-started`)));
  assert.deepEqual(blocked.failures.filter((line) => !line.startsWith("asset-quality-required:")), [], "ほかの検査は通っている");

  // 評価者の採点は合格でも、手指の安全の人の確認が無ければまだ使えない。
  await passKoyaAssetQualityLoop({ workDir: join(projectDir, "canvas"), stage: "thumbnail", subjectId: subjectA, assetPath: artworkA, stopBefore: "human" });
  await passKoyaAssetQualityLoop({ workDir: join(projectDir, "canvas"), stage: "thumbnail", subjectId: subjectB, assetPath: artworkB });
  const awaitingHuman = await auditKoyaThumbnailPlan({ projectDir, thumbnailContract, plan });
  assert.deepEqual(awaitingHuman.assetQuality.filter((row) => !row.pass).map((row) => [row.subjectId, row.reason]), [[subjectA, "not-passed"]]);

  const { recordAssetHumanVerification } = await import("../lib/assetQualityLoop.mjs");
  await recordAssetHumanVerification({
    workDir: join(projectDir, "canvas"), stage: "thumbnail", subjectId: subjectA, assetPath: artworkA, checks: ["hand-safety"],
    verdict: "pass", reviewer: "synthetic-reviewer", note: "手元を拡大して見た（合成）", humanVerified: true, isInteractive: true,
  });
  const passed = await auditKoyaThumbnailPlan({ projectDir, thumbnailContract, plan });
  assert.equal(passed.pass, true, passed.failures.join("\n"));
  assert.ok(passed.assetQuality.every((row) => row.pass));

  // 合格した後で画を差し替えると、その合格は今のファイルを保証しない。
  await writeFile(artworkB, Buffer.concat([renderEditorialPlatePng("white-solid", 1280, 720), Buffer.from("synthetic-edit")]));
  const changed = await auditKoyaThumbnailPlan({ projectDir, thumbnailContract, plan });
  assert.equal(changed.pass, false);
  assert.ok(changed.failures.some((line) => line.startsWith(`asset-quality-required:thumbnail:${subjectB}:asset-sha-mismatch`)));

  // 古い契約（v53）では従来どおり、ループを見ない。
  const legacy = await auditKoyaThumbnailPlan({ projectDir, thumbnailContract, plan, productionContract: await legacyKoyaContract(root) });
  assert.equal(legacy.pass, true, legacy.failures.join("\n"));
  assert.deepEqual(legacy.assetQuality, []);
});

test("場所: 登録は4枚のボードそれぞれの location 工程のループ合格が要る（未合格・SHA 違い・合格・古い契約）", async (t) => {
  const base = await tempRoot(t, "koya-location-gate-");
  const projectDir = join(base, "project");
  const authority = await installSyntheticKoyaAuthority(projectDir);
  const locationId = "sample-street";
  const staged = await importAndRegisterSyntheticLocation({
    projectDir, authority, locationId, sourceDir: join(base, "downloads"), passAssetQuality: false, register: false,
  });
  const register = () => registerApprovedKoyaLocation({ authority, projectDir, locationId, reviewPath: staged.reviewPath });
  await assert.rejects(register, (error) => {
    assert.equal(error.code, KOYA_ASSET_QUALITY_REQUIRED_CODE);
    assert.equal(error.assetQuality.length, 4);
    assert.ok(error.assetQuality.every((row) => row.stage === "location" && row.reason === "loop-not-started"));
    assert.match(error.message, /asset-quality-required:location:sample-street\.board-1-view-1:loop-not-started/u);
    return true;
  });

  // 1枚だけ、合格した版が今のボードと違う（採点の後にバイト列が戻された）。
  const [first, ...rest] = staged.audit.rows;
  const original = await readFile(first.path);
  await writeFile(first.path, Buffer.concat([original, Buffer.from("synthetic-other-version")]));
  await passKoyaAssetQualityLoop({ workDir: join(projectDir, "canvas"), stage: "location", subjectId: `${locationId}.${first.boardId}`, assetPath: first.path });
  await writeFile(first.path, original);
  for (const row of rest) {
    await passKoyaAssetQualityLoop({ workDir: join(projectDir, "canvas"), stage: "location", subjectId: `${locationId}.${row.boardId}`, assetPath: row.path });
  }
  await assert.rejects(register, (error) => {
    assert.deepEqual(error.assetQuality.map((row) => [row.subjectId, row.reason]), [[`${locationId}.${first.boardId}`, "asset-sha-mismatch"]]);
    return true;
  });

  // 合格の経路（全ボードの合格を登録簿の承認に残し、承認一覧を書き出す）。
  const other = await importAndRegisterSyntheticLocation({
    projectDir, authority, locationId: "sample-cafe", sourceDir: join(base, "downloads-cafe"),
  });
  const approval = other.registered.location.approval;
  assert.equal(approval.assetQuality.contractVersion, KOYA_ASSET_QUALITY_GATE_IN_FORCE_SINCE);
  assert.deepEqual(approval.assetQuality.rows.map((row) => row.assetSha256), other.registered.location.referenceAssets.map((row) => row.sha256));
  const approved = JSON.parse(await readFile(other.registered.approvedReferences.path, "utf8"));
  assert.equal(approved.version, APPROVED_REFERENCES_VERSION);
  for (const asset of other.registered.location.referenceAssets) {
    assert.ok(approved.references.some((row) => row.sha256 === asset.sha256), "登録したボードは承認一覧に載る");
  }

  // 古い契約（v53）: ループなしで従来どおり登録でき、承認に assetQuality を書かない。
  const legacyBase = await tempRoot(t, "koya-location-legacy-");
  const legacyProject = join(legacyBase, "project");
  const legacyAuthority = await installSyntheticKoyaAuthority(legacyProject);
  const legacyStaged = await importAndRegisterSyntheticLocation({
    projectDir: legacyProject, authority: legacyAuthority, locationId, sourceDir: join(legacyBase, "downloads"), passAssetQuality: false, register: false,
  });
  const legacy = await registerApprovedKoyaLocation({
    authority: legacyAuthority, projectDir: legacyProject, locationId, reviewPath: legacyStaged.reviewPath, productionContract: await legacyKoyaContract(root),
  });
  assert.equal(legacy.location.status, "approved");
  assert.equal(Object.hasOwn(legacy.location.approval, "assetQuality"), false);
  assert.equal(Object.hasOwn(legacy, "approvedReferences"), false);
});

async function stageSyntheticIdentityPack(projectDir) {
  const canvasDir = join(projectDir, "canvas");
  const packDir = join(canvasDir, "assets", "characters", "synthetic-ep", "approved-identity-packs");
  await mkdir(packDir, { recursive: true });
  const file = async (name, type) => {
    const path = join(packDir, name);
    const bytes = Buffer.concat([renderEditorialPlatePng(type, 1024, 1024), Buffer.from(`synthetic:${name}`)]);
    await writeFile(path, bytes);
    return { assetFile: path, sha256: sha(bytes) };
  };
  const selectedFace = await file("face.png", "white-solid");
  const turnaround = await file("turnaround.png", "pastel-sky");
  const expression = await file("expression.png", "black-solid");
  const cast = {
    id: "cast-synthetic",
    name: "合成の人物",
    status: "awaiting-identity-qa",
    selectedCandidateId: "candidate-1",
    candidates: [{ id: "candidate-1", index: 1, assetFile: selectedFace.assetFile, variationAxis: "faceShape", status: "selected" }],
    approval: { route: "human-best-of-n", verdictDigest: "d".repeat(64), reason: "合成の承認理由" },
    identityPack: { selectedFace, turnaround, expression, eyeOpenSheets: [], outfitSheets: [] },
  };
  await writeFile(join(canvasDir, "character-workflows.json"), `${JSON.stringify({
    version: 1,
    revision: 1,
    workflows: [{ id: "workflow-synthetic", title: "合成", episodeId: "synthetic-ep", status: "awaiting-identity-qa", cast: [cast] }],
  }, null, 2)}\n`);
  const reviewPath = join(canvasDir, "character-reviews", "identity.json");
  await mkdir(join(canvasDir, "character-reviews"), { recursive: true });
  await writeFile(reviewPath, "{}\n");
  return { canvasDir, cast, reviewPath, selectedFace, turnaround, expression };
}

test("人物: 登録は identity pack の各シートの character 工程のループ合格が要る。承認一覧は人が選んだ顔を載せる", async (t) => {
  const projectDir = await tempRoot(t, "koya-character-gate-");
  const staged = await stageSyntheticIdentityPack(projectDir);
  const register = (extra = {}) => registerKoyaCharacterIdentity({
    projectDir, episodeId: "synthetic-ep", workflowId: "workflow-synthetic", castId: "cast-synthetic", identityReviewPath: staged.reviewPath, ...extra,
  });
  const subjects = koyaIdentityPackAssetQualitySubjects(staged.cast);
  assert.deepEqual(subjects.map((row) => row.subjectId), ["cast-synthetic.turnaround", "cast-synthetic.expression"], "選ばれた顔はシートの参照なのでループの対象に入れない");

  await assert.rejects(() => register(), (error) => {
    assert.equal(error.code, KOYA_ASSET_QUALITY_REQUIRED_CODE);
    assert.deepEqual(error.assetQuality.map((row) => [row.subjectId, row.reason]), [
      ["cast-synthetic.turnaround", "loop-not-started"],
      ["cast-synthetic.expression", "loop-not-started"],
    ]);
    return true;
  });

  // 参照の照合に使う承認一覧: 候補の判定を持つ、人が選んだ顔の SHA が載る。
  const approved = await writeKoyaApprovedReferences({ projectDir });
  const body = JSON.parse(await readFile(approved.path, "utf8"));
  assert.equal(body.version, APPROVED_REFERENCES_VERSION);
  assert.deepEqual(body.references.map((row) => [row.sha256, row.kind]), [[staged.selectedFace.sha256, "character:selected-face"]]);

  for (const subject of subjects) {
    await passKoyaAssetQualityLoop({
      workDir: staged.canvasDir, stage: "character", subjectId: subject.subjectId, assetPath: subject.assetFile,
      references: [staged.selectedFace.assetFile], approvedReferencesPath: approved.path,
    });
  }
  // ゲートは通り、その先の独立レビューの検査（合成の空レビュー）で止まる。
  await assert.rejects(() => register(), (error) => {
    assert.notEqual(error.code, KOYA_ASSET_QUALITY_REQUIRED_CODE);
    assert.doesNotMatch(error.message, /asset-quality-required/u);
    return true;
  });

  // 合格の後でシートを差し替えると止まる。
  await writeFile(staged.turnaround.assetFile, Buffer.concat([await readFile(staged.turnaround.assetFile), Buffer.from("edit")]));
  await assert.rejects(() => register(), (error) => {
    assert.deepEqual(error.assetQuality.map((row) => [row.subjectId, row.reason]), [["cast-synthetic.turnaround", "asset-sha-mismatch"]]);
    return true;
  });

  // 古い契約（v53）: ゲートを見ず、従来どおり登録の検査へ進む。
  const legacyProject = await tempRoot(t, "koya-character-legacy-");
  const legacyStaged = await stageSyntheticIdentityPack(legacyProject);
  const legacyContract = await legacyKoyaContract(root);
  await assert.rejects(() => registerKoyaCharacterIdentity({
    projectDir: legacyProject, episodeId: "synthetic-ep", workflowId: "workflow-synthetic", castId: "cast-synthetic",
    identityReviewPath: legacyStaged.reviewPath, productionContract: legacyContract,
  }), (error) => {
    assert.notEqual(error.code, KOYA_ASSET_QUALITY_REQUIRED_CODE);
    return true;
  });
});
