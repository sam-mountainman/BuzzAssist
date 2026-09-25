import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveFfmpegToolchain } from "../lib/harnessRuntimeResolver.mjs";
import {
  OPERATOR_IMAGE_COST_BASIS,
  OPERATOR_IMAGE_FIT,
  OPERATOR_IMAGE_IMPORT_VERSION,
  OPERATOR_IMAGE_ROUTES,
  checkOperatorImageImport,
  loadDefaultAssetLoopVerifier,
  materializeOperatorImages,
  normalizeOperatorImageSourceConfig,
  operatorImageFit,
  operatorImageImportKey,
  operatorImageInfo,
  readOperatorImageManifest,
  resolveApprovedReferenceSha256s,
  resolveManifestRelativePath,
} from "../lib/operatorImageImport.mjs";
import {
  FIXTURE_REFERENCE_SHA256,
  fixtureConversationUrl,
  makeGradientPng,
  replaceImage,
  sha256,
  writeManifest,
  writeOperatorImageFolder,
} from "./fixtures/operatorImageFixture.mjs";

const RENDER = { width: 320, height: 180 };
const policyOf = (overrides = {}) => normalizeOperatorImageSourceConfig({
  source: "operator-file",
  operatorFile: {
    manifest: { location: "job-option" },
    approvedReferences: { sha256: [FIXTURE_REFERENCE_SHA256] },
    ...overrides,
  },
}, { render: RENDER }).config;

async function tempFolder(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function check(folder, { sceneIds = ["s001", "s002"], policy = policyOf(), approved = null, assetLoopVerifier = null } = {}) {
  const manifest = await readOperatorImageManifest({ manifestPath: join(folder, "operator-images.json") });
  const approvedReferences = approved || (await resolveApprovedReferenceSha256s({ policy })).approved;
  return { manifest, checked: await checkOperatorImageImport({ manifest, sceneIds, target: RENDER, policy, approvedReferences, assetLoopVerifier }) };
}

test("Pack の宣言: 既定は broker、operator-file は置き場・寸法・許容・参照を読み、範囲外は blocker", () => {
  assert.deepEqual(normalizeOperatorImageSourceConfig({ provider: "x" }, { render: RENDER }), { config: { source: "broker" }, blockers: [] });
  assert.deepEqual(normalizeOperatorImageSourceConfig({ source: "somewhere" }, { render: RENDER }).blockers, ["image.source"]);
  assert.deepEqual(
    normalizeOperatorImageSourceConfig({ source: "broker", operatorFile: {} }, { render: RENDER }).blockers,
    ["image.operatorFile-requires-operator-file-source"],
    "broker の Pack に取り込みの宣言があれば、どちらのつもりか分からないので止める",
  );
  const ok = normalizeOperatorImageSourceConfig({ source: "operator-file", operatorFile: { manifest: { location: "job-option" } } }, { render: RENDER });
  assert.deepEqual(ok.blockers, []);
  assert.deepEqual(ok.config.expectedSize, RENDER, "寸法の宣言が無ければ描く寸法");
  assert.equal(ok.config.tolerancePx, 2);
  assert.equal(ok.config.fit, OPERATOR_IMAGE_FIT);
  assert.deepEqual(ok.config.approvedReferences, { sha256: [], characterRegistry: false });
  assert.equal(ok.config.requireAssetLoopPass, false);
  const bad = normalizeOperatorImageSourceConfig({
    source: "operator-file",
    operatorFile: {
      manifest: { location: "channel-pack" },
      tolerancePx: 40,
      fit: "stretch",
      approvedReferences: { sha256: ["not-a-sha"], characterRegistry: "yes", extra: 1 },
      requireAssetLoopPass: "true",
      mixedScenes: true,
    },
  }, { render: RENDER });
  for (const code of [
    "image.operatorFile.manifest.location",
    "image.operatorFile.tolerancePx",
    "image.operatorFile.fit",
    "image.operatorFile.approvedReferences.sha256",
    "image.operatorFile.approvedReferences.characterRegistry",
    "image.operatorFile.approvedReferences.extra-unknown",
    "image.operatorFile.requireAssetLoopPass",
    "image.operatorFile.mixedScenes-unknown",
  ]) assert.ok(bad.blockers.includes(code), `${code}: ${bad.blockers.join(", ")}`);
  // ChatGPT の web 画面は解像度を選べない（3:2 の 1536x1024 など）。16:9 へは切り取りで合わせられるが、
  // 縦長や小さすぎる宣言は Pack の段階で止める。
  const landscape = normalizeOperatorImageSourceConfig({ source: "operator-file", operatorFile: { manifest: { location: "job-option" }, expectedSize: { width: 1536, height: 1024 } } }, { render: { width: 1280, height: 720 } });
  assert.deepEqual(landscape.blockers, []);
  const portrait = normalizeOperatorImageSourceConfig({ source: "operator-file", operatorFile: { manifest: { location: "job-option" }, expectedSize: { width: 1024, height: 1536 } } }, { render: { width: 1280, height: 720 } });
  assert.ok(portrait.blockers.includes("image.operatorFile.expectedSize-crop-too-large"));
  const tiny = normalizeOperatorImageSourceConfig({ source: "operator-file", operatorFile: { manifest: { location: "job-option" }, expectedSize: { width: 480, height: 270 } } }, { render: { width: 1920, height: 1080 } });
  assert.ok(tiny.blockers.includes("image.operatorFile.expectedSize-upscale-too-large"));
});

test("寸法の合わせ方: 1px 違いは中央を切り取り、方法と切り取った画素を記録する", () => {
  const exact = operatorImageFit({ width: 320, height: 180 }, RENDER);
  assert.equal(exact.method, "none");
  assert.equal(exact.scale, 1);
  const wide = operatorImageFit({ width: 321, height: 180 }, RENDER);
  assert.equal(wide.method, OPERATOR_IMAGE_FIT);
  assert.deepEqual(wide.scaled, { width: 321, height: 180 });
  assert.deepEqual(wide.crop, { x: 0, y: 0, width: 320, height: 180 });
  const short = operatorImageFit({ width: 320, height: 179 }, RENDER);
  assert.ok(short.scale > 1);
  assert.equal(short.scaled.height, 180);
  assert.equal(short.crop.width, 320);
  const chatgpt = operatorImageFit({ width: 1536, height: 1024 }, { width: 1280, height: 720 });
  assert.deepEqual(chatgpt.scaled, { width: 1280, height: 853 });
  assert.deepEqual(chatgpt.crop, { x: 0, y: 66, width: 1280, height: 720 });
});

test("Windows のパス: manifest の相対パスは / 区切りだけ、フォルダの外・ドライブ・\\ は受けない", () => {
  const win = "C:\\Operator Files\\episode-01";
  assert.deepEqual(resolveManifestRelativePath(win, "images/p001.png", { pathApi: path.win32 }), {
    full: path.win32.join(win, "images", "p001.png"),
    rel: "images/p001.png",
  });
  for (const value of ["images\\p001.png", "..\\secret.png", "C:/x.png", "C:\\x.png", "\\\\server\\share\\x.png", "/abs/x.png", "images/../../x.png", "./x.png", "images//x.png", ""]) {
    assert.equal(resolveManifestRelativePath(win, value, { pathApi: path.win32 }), null, `win32: ${value}`);
    assert.equal(resolveManifestRelativePath("/operator/episode-01", value, { pathApi: path.posix }), null, `posix: ${value}`);
  }
  assert.equal(resolveManifestRelativePath("/operator/episode-01", "images/p001.png", { pathApi: path.posix }).full, path.posix.join("/operator/episode-01", "images", "p001.png"));
});

test("読む: 実測の sha256 と寸法を持った行を返し、会話の URL は私有の欄にしか持たない", async (t) => {
  const folder = await tempFolder(t, "operator-image-read-");
  await writeOperatorImageFolder(folder, [
    { sceneId: "s001", width: 321, height: 180 },
    { sceneId: "s002", width: 320, height: 180 },
  ]);
  const { manifest, checked } = await check(folder);
  assert.equal(manifest.ok, true, manifest.problems.join(", "));
  assert.equal(checked.ok, true, checked.issues.join(", "));
  assert.equal(manifest.rows[0].image.width, 321);
  assert.equal(manifest.rows[0].image.format, "png");
  const publicText = JSON.stringify(checked.publicScenes);
  assert.equal(publicText.includes(fixtureConversationUrl("s001")), false, "公開面の行に会話の URL を載せない");
  assert.equal(checked.publicScenes[0].conversationUrlSha256, sha256(fixtureConversationUrl("s001")));
  assert.equal(checked.publicScenes[0].fit.method, OPERATOR_IMAGE_FIT);
  assert.equal(checked.publicScenes[1].fit.method, "none");
  assert.equal(checked.publicScenes[0].costBasis, OPERATOR_IMAGE_COST_BASIS);
  assert.equal(checked.publicScenes[0].paidMediaJob, false);
  assert.deepEqual(checked.publicScenes[0].referenceApprovals, [{ sha256: FIXTURE_REFERENCE_SHA256, source: "channel-pack" }]);
  assert.deepEqual(OPERATOR_IMAGE_ROUTES, ["chatgpt-web", "codex", "local-model", "grok", "other"]);
  // manifest を直さずに画だけ差し替えると、digest が変わる（再開が気づく）。
  const before = manifest.digest;
  await replaceImage(folder, "s002", 320, 180, 77);
  const after = await readOperatorImageManifest({ manifestPath: join(folder, "operator-images.json") });
  assert.notEqual(after.digest, before);
  assert.ok(after.problems.includes("operator-image-sha256-mismatch:s002"));
});

test("検査: sha256 の不一致・場面の過不足・理由の無い使い回し・未承認の参照・寸法・来歴の欠けを理由コードで止める", async (t) => {
  const folder = await tempFolder(t, "operator-image-check-");
  const { manifestPath, manifest } = await writeOperatorImageFolder(folder, [
    { sceneId: "s001", width: 320, height: 180 },
    { sceneId: "s002", width: 320, height: 180, reuseOf: "s001" },
    { sceneId: "s009", width: 330, height: 180, referenceSha256s: ["b".repeat(64)] },
  ]);
  const { checked } = await check(folder, { sceneIds: ["s001", "s002", "s003", "s009"] });
  assert.equal(checked.ok, false);
  for (const code of [
    "operator-image-scene-missing:s003",
    "operator-image-reused-without-reason:s002:s001",
    `operator-image-reference-unapproved:s009:${"b".repeat(12)}`,
    "operator-image-size-out-of-tolerance:s009:330x180",
  ]) assert.ok(checked.issues.includes(code), `${code}: ${checked.issues.join(", ")}`);
  assert.deepEqual(checked.publicScenes, [], "止まる検査は公開の記録を作らない");
  const extra = await check(folder, { sceneIds: ["s001", "s002"] });
  assert.ok(extra.checked.issues.includes("operator-image-scene-unknown:s009"));

  // 意図的な使い回しは理由があれば通る（どの場面の画か記録する。理由の本文は sha256 だけ）。
  manifest.scenes[1].reuseReason = "fixture: the same establishing shot returns";
  manifest.scenes.pop();
  await writeManifest(manifestPath, manifest);
  const reused = await check(folder, { sceneIds: ["s001", "s002"] });
  assert.equal(reused.checked.ok, true, reused.checked.issues.join(", "));
  assert.deepEqual(reused.checked.publicScenes[1].reuse, { of: "s001", reasonSha256: sha256("fixture: the same establishing shot returns") });

  // 来歴の欠け・書き間違い。
  const broken = structuredClone(manifest);
  broken.scenes[0].image.sha256 = "c".repeat(64);
  broken.scenes[0].image.width = 400;
  delete broken.scenes[0].conversationUrl;
  broken.scenes[0].generatedAt = "2026-09-20";
  broken.scenes[0].prompt.sha256 = "d".repeat(64);
  broken.scenes[1].route = "fax";
  broken.scenes[1].modelLabel = "";
  broken.scenes[1].conversationUrl = "http://chat.example.invalid/c/plain-http";
  broken.scenes.push({ ...structuredClone(manifest.scenes[0]), sceneId: "s001" });
  broken.scenes.push({ ...structuredClone(manifest.scenes[0]), sceneId: "s003", route: "other", generatedAt: "2099-01-01T00:00:00Z", image: { ...manifest.scenes[0].image, path: "../outside.png" } });
  await writeManifest(manifestPath, broken);
  const read = await readOperatorImageManifest({ manifestPath });
  for (const code of [
    "operator-image-sha256-mismatch:s001",
    "operator-image-declared-size-mismatch:s001",
    "operator-image-conversation-url-required:s001",
    "operator-image-generated-at-invalid:s001",
    "operator-image-prompt-sha256-mismatch:s001",
    "operator-image-route-invalid:s002",
    "operator-image-model-label-required:s002",
    "operator-image-conversation-url-invalid:s002",
    "operator-image-scene-duplicated:s001",
    "operator-image-route-note-required:s003",
    "operator-image-generated-at-in-future:s003",
    "operator-image-path-invalid:s003",
  ]) assert.ok(read.problems.includes(code), `${code}: ${read.problems.join(", ")}`);

  // manifest そのものの欠け。
  assert.deepEqual((await readOperatorImageManifest({ manifestPath: "" })).problems, ["operator-image-manifest-required"]);
  assert.deepEqual((await readOperatorImageManifest({ manifestPath: join(folder, "absent.json") })).problems, ["operator-image-manifest-missing"]);
  await writeFile(manifestPath, JSON.stringify({ version: "some-other-v9", scenes: [] }));
  assert.deepEqual((await readOperatorImageManifest({ manifestPath })).problems, ["operator-image-manifest-version-unsupported:some-other-v9"]);
});

test("検査: フォルダの外を指すシンボリックリンクの画は読まない", async (t) => {
  const folder = await tempFolder(t, "operator-image-link-");
  const outside = await tempFolder(t, "operator-image-outside-");
  const { manifestPath, manifest } = await writeOperatorImageFolder(folder, [{ sceneId: "s001", width: 320, height: 180 }]);
  const outsidePng = join(outside, "elsewhere.png");
  await writeFile(outsidePng, makeGradientPng(320, 180, 5));
  try {
    await symlink(outsidePng, join(folder, "images", "linked.png"));
  } catch (error) {
    t.skip(`symlink unavailable: ${error.code}`);
    return;
  }
  manifest.scenes[0].image.path = "images/linked.png";
  await writeManifest(manifestPath, manifest);
  const read = await readOperatorImageManifest({ manifestPath });
  assert.ok(read.problems.includes("operator-image-file-unreadable:s001"), read.problems.join(", "));
});

test("承認済みの参照: Pack の sha256 と、宣言が許したときだけ人物の登録簿（承認のある人物）を数える", async (t) => {
  const project = await tempFolder(t, "operator-image-registry-");
  await mkdir(join(project, "canvas"), { recursive: true });
  const approvedSheet = "e".repeat(64);
  const unapprovedSheet = "f".repeat(64);
  await writeFile(join(project, "canvas", "characters.json"), JSON.stringify({
    version: 1,
    characters: [
      {
        id: "fixture-lead",
        name: "Fixture Lead",
        kind: "character",
        status: "approved",
        approval: { route: "fixture", approvedBy: "fixture-reviewer", approvedAt: "2026-09-01T00:00:00Z" },
        referenceAssets: [{ id: "face", role: "identity-face", path: "characters/lead.png", sha256: approvedSheet }],
      },
      {
        id: "fixture-draft",
        name: "Fixture Draft",
        kind: "character",
        referenceAssets: [{ id: "face", role: "identity-face", path: "characters/draft.png", sha256: unapprovedSheet }],
      },
    ],
  }));
  const packOnly = await resolveApprovedReferenceSha256s({ policy: policyOf(), projectDir: project });
  assert.deepEqual([...packOnly.approved.keys()], [FIXTURE_REFERENCE_SHA256], "登録簿は宣言が無ければ数えない");
  const withRegistry = await resolveApprovedReferenceSha256s({
    policy: policyOf({ approvedReferences: { sha256: [FIXTURE_REFERENCE_SHA256], characterRegistry: true } }),
    projectDir: project,
  });
  assert.equal(withRegistry.approved.get(approvedSheet), "character-registry");
  assert.equal(withRegistry.approved.has(unapprovedSheet), false, "承認（approval）の無い人物の参照は数えない");
  const noProject = await resolveApprovedReferenceSha256s({ policy: policyOf({ approvedReferences: { characterRegistry: true } }) });
  assert.deepEqual(noProject.problems, ["operator-image-character-registry-unavailable"]);
});

test("途中の成果物の品質ループ: 宣言があれば、本体が無い間は『ループ未導入』で止め、ある間は合格した版の sha256 との一致を見る", async (t) => {
  const folder = await tempFolder(t, "operator-image-loop-");
  const { manifestPath, manifest } = await writeOperatorImageFolder(folder, [{ sceneId: "s001", width: 320, height: 180 }]);
  const policy = policyOf({ requireAssetLoopPass: true });
  const notInstalled = await loadDefaultAssetLoopVerifier({
    importModule: async () => { const error = new Error("Cannot find module '/x/lib/assetQualityLoop.mjs'"); error.code = "ERR_MODULE_NOT_FOUND"; throw error; },
  });
  assert.deepEqual(notInstalled, { available: false, reason: "not-installed" });
  assert.deepEqual(await loadDefaultAssetLoopVerifier({ importModule: async () => ({ assetQualityStatus() {} }) }), { available: false, reason: "verifier-missing" });
  // 実物の読み込み: 本体が main に無い間は「未導入」。入った後は、検査口の関数があるときだけ使える。
  const real = await loadDefaultAssetLoopVerifier();
  if (!existsSync(fileURLToPath(new URL("../lib/assetQualityLoop.mjs", import.meta.url)))) {
    assert.deepEqual(real, { available: false, reason: "not-installed" });
  } else {
    assert.ok(real.available === true || real.reason === "verifier-missing", JSON.stringify(real));
  }
  const unavailable = await check(folder, { sceneIds: ["s001"], policy, assetLoopVerifier: notInstalled });
  assert.ok(unavailable.checked.issues.includes("operator-image-asset-loop-not-installed"));
  assert.ok(unavailable.checked.issues.includes("operator-image-asset-loop-record-required:s001"));

  const imageSha = manifest.scenes[0].image.sha256;
  await mkdir(join(folder, "quality"), { recursive: true });
  await writeFile(join(folder, "quality", "s001.json"), JSON.stringify({ fixture: "loop state" }));
  const calls = [];
  const verifier = { available: true, verify: async (args) => { calls.push(args); return { pass: true, passedSha256: imageSha }; } };
  manifest.scenes[0].assetLoop = { statePath: "quality/s001.json", passedSha256: "a".repeat(64) };
  await writeManifest(manifestPath, manifest);
  const mismatch = await check(folder, { sceneIds: ["s001"], policy, assetLoopVerifier: verifier });
  assert.ok(mismatch.checked.issues.includes("operator-image-asset-loop-pass-mismatch:s001"), mismatch.checked.issues.join(", "));
  manifest.scenes[0].assetLoop.passedSha256 = imageSha;
  await writeManifest(manifestPath, manifest);
  const passed = await check(folder, { sceneIds: ["s001"], policy, assetLoopVerifier: verifier });
  assert.equal(passed.checked.ok, true, passed.checked.issues.join(", "));
  assert.equal(calls.at(-1).stage, "scene-image");
  assert.equal(calls.at(-1).subjectId, "s001");
  assert.equal(passed.checked.publicScenes[0].assetLoop.passedSha256, imageSha);
  assert.match(passed.checked.publicScenes[0].assetLoop.stateSha256, /^[a-f0-9]{64}$/u);
  const rejected = await check(folder, { sceneIds: ["s001"], policy, assetLoopVerifier: { available: true, verify: async () => ({ pass: false }) } });
  assert.ok(rejected.checked.issues.includes("operator-image-asset-loop-not-passed:s001"));
});

test("途中の成果物の品質ループ（本体）: 本編の画の工程で合格し人の確認が揃った版だけを取り込み、別の版・置き場の違う状態は止める", async (t) => {
  if (!existsSync(fileURLToPath(new URL("../lib/assetQualityLoop.mjs", import.meta.url)))) {
    t.skip("lib/assetQualityLoop.mjs is not on this branch");
    return;
  }
  const { recordAssetQualityRound, startAssetQualityLoop } = await import("../lib/assetQualityLoop.mjs");
  const loopFixtures = await import("./fixtures/assetQualityFixtures.mjs");
  const folder = await tempFolder(t, "operator-image-real-loop-");
  // 取り込みの記録のフォルダ＝品質ループの作業フォルダ。参照と承認一覧は本体の fixture で作る。
  const fx = await (async () => {
    for (const dir of ["reviews", "refs"]) await mkdir(join(folder, dir), { recursive: true });
    return loopFixtures.stageInputs(folder, "scene-image");
  })();
  const { manifestPath, manifest } = await writeOperatorImageFolder(folder, [{ sceneId: "s001", width: 320, height: 180, referenceSha256s: fx.refs }]);
  const imageRel = manifest.scenes[0].image.path;
  const imageSha = manifest.scenes[0].image.sha256;
  const started = await startAssetQualityLoop({
    workDir: folder, harnessId: "narrated-story-video", stage: "scene-image", subjectId: "s001",
    generatorContextId: loopFixtures.MAKER, generatorHost: "claude-code", now: loopFixtures.now,
  });
  const contract = started.state.asset.contract;
  const reviewPath = await loopFixtures.writeReview(folder, "scene-s001", loopFixtures.reviewFor({
    stage: "scene-image", context: "ctx-operator-import-eval-1", assetSha: imageSha, refs: fx.refs, contract,
  }));
  const round = await recordAssetQualityRound({
    workDir: folder, stage: "scene-image", subjectId: "s001", assetPath: imageRel, versionLabel: "v1", reviewPath,
    now: loopFixtures.now, ...(await fx.recordExtra({ rel: imageRel, sha: imageSha }, "chatgpt-web")),
  });
  assert.equal(round.recorded, true, JSON.stringify(round.issues));
  manifest.scenes[0].assetLoop = { statePath: "quality/assets/scene-image--s001.json", passedSha256: imageSha };
  await writeManifest(manifestPath, manifest);
  const policy = policyOf({ requireAssetLoopPass: true, approvedReferences: { sha256: fx.refs } });
  const real = await loadDefaultAssetLoopVerifier();
  assert.equal(real.available, true, JSON.stringify(real));
  // 採点は通ったが、人物の同一性の人の確認がまだ無い → 取り込まない。
  const awaitingHuman = await check(folder, { sceneIds: ["s001"], policy, assetLoopVerifier: real });
  assert.deepEqual(awaitingHuman.checked.issues, ["operator-image-asset-loop-not-passed:s001"]);
  await loopFixtures.verify(folder, "scene-image", "s001", imageRel, ["identity"]);
  const passed = await check(folder, { sceneIds: ["s001"], policy, assetLoopVerifier: real });
  assert.equal(passed.checked.ok, true, passed.checked.issues.join(", "));
  assert.equal(passed.checked.publicScenes[0].assetLoop.passedSha256, imageSha);

  // 状態ファイルを本体の置き場の外へ写して指しても、推測で読まずに止める。
  await mkdir(join(folder, "elsewhere"), { recursive: true });
  await writeFile(join(folder, "elsewhere", "scene-image--s001.json"), await readFile(join(folder, "quality", "assets", "scene-image--s001.json")));
  manifest.scenes[0].assetLoop.statePath = "elsewhere/scene-image--s001.json";
  await writeManifest(manifestPath, manifest);
  const moved = await check(folder, { sceneIds: ["s001"], policy, assetLoopVerifier: real });
  assert.deepEqual(moved.checked.issues, ["operator-image-asset-loop-not-passed:s001"]);

  // 合格した版の後で画を差し替え、manifest の sha256 だけ揃えても、合格した版そのものではないので止める。
  const replaced = await replaceImage(folder, "s001", 320, 180, 23);
  manifest.scenes[0].image.sha256 = sha256(replaced);
  manifest.scenes[0].assetLoop = { statePath: "quality/assets/scene-image--s001.json", passedSha256: sha256(replaced) };
  await writeManifest(manifestPath, manifest);
  const swapped = await check(folder, { sceneIds: ["s001"], policy, assetLoopVerifier: real });
  assert.deepEqual(swapped.checked.issues, ["operator-image-asset-loop-not-passed:s001"]);
});

test("取り込み: 決まった寸法の PNG にし、同じ鍵なら作り直さず、検査の後で差し替わった画は使わない", async (t) => {
  const toolchain = await resolveFfmpegToolchain();
  if (!toolchain.ok) { t.skip("ffmpeg/ffprobe is unavailable"); return; }
  const folder = await tempFolder(t, "operator-image-materialize-");
  const work = await tempFolder(t, "operator-image-work-");
  await writeOperatorImageFolder(folder, [
    { sceneId: "s001", width: 321, height: 180 },
    { sceneId: "s002", width: 320, height: 180 },
  ]);
  const { manifest, checked } = await check(folder);
  const run = () => materializeOperatorImages({
    ffmpeg: toolchain.ffmpeg,
    manifest,
    checked,
    target: RENDER,
    outputDir: join(work, "media", "images"),
    privateDir: join(work, "operator-images"),
    now: () => "2026-09-25T00:00:00.000Z",
  });
  const first = await run();
  assert.equal(first.ok, true, first.issues.join(", "));
  for (const sceneId of ["s001", "s002"]) {
    const image = first.images.get(sceneId);
    const info = operatorImageInfo(await readFile(image.path));
    assert.deepEqual([info.width, info.height], [320, 180], `${sceneId} must be normalized to the render size`);
    assert.equal(image.cached, false);
  }
  // 寸法が同じ PNG は画素に手を入れない（元の画と同じ sha256）。
  assert.equal(first.images.get("s002").sha256, manifest.rows[1].image.sha256);
  assert.equal(first.publicRecord.version, OPERATOR_IMAGE_IMPORT_VERSION);
  assert.equal(first.publicRecord.paidMediaJobs, 0);
  assert.deepEqual(first.publicRecord.routes, { "chatgpt-web": 2 });
  assert.equal(first.publicRecord.scenes[0].normalized.sha256, first.images.get("s001").sha256);
  assert.equal(JSON.stringify(first.publicRecord).includes("chat.example.invalid"), false);
  const privateRecord = await readFile(first.privateRecordPath, "utf8");
  assert.ok(privateRecord.includes(fixtureConversationUrl("s001")), "会話の URL は私有の記録にだけ残る");
  const sourceCopy = await stat(join(work, "operator-images", "source", "s001.png"));
  assert.ok(sourceCopy.size > 0, "元の画の写しを私有の Job フォルダに置く");
  assert.equal(first.images.get("s001").importKey, operatorImageImportKey({ sceneId: "s001", sourceSha256: manifest.rows[0].image.sha256, fit: checked.scenes[0].fit }));

  const second = await run();
  assert.equal(second.images.get("s001").cached, true, "同じ鍵の取り込みは作り直さない");
  assert.equal(second.images.get("s001").sha256, first.images.get("s001").sha256);

  // 検査の後で画が差し替わったら、取り込まずに止める。
  await replaceImage(folder, "s001", 321, 180, 44);
  const changed = await run();
  assert.equal(changed.ok, false);
  assert.deepEqual(changed.issues, ["operator-image-changed-during-import:s001"]);
});
