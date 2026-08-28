import assert from "node:assert/strict";
import { channelPackPresent, resolveChannelPackPath } from "../lib/channelPackResolver.mjs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  auditKoyaCharacterBootstrap,
  auditKoyaFixedCastReadiness,
  auditKoyaLocationAnchorReview,
  auditKoyaLocationReview,
  auditKoyaStory,
  auditKoyaThumbnailPlan,
  buildKoyaLocationBoardPlan,
  createKoyaLocationAnchorReviewDraft,
  createKoyaLocationReviewDraft,
  createKoyaStoryReviewDraft,
  createKoyaThumbnailPlanDraft,
  generateKoyaLocationBoards,
  readKoyaChannelAuthority,
  registerApprovedKoyaLocation,
  koyaThumbnailCopySha256,
} from "../lib/koyaChannelGovernance.mjs";
import { renderEditorialPlatePng } from "../lib/mangaScriptImagePipeline.mjs";
import { parseMangaScript } from "../lib/mangaVideoPipeline.mjs";
import { auditKoyaCharacterRosterReview, createKoyaCharacterRosterReviewDraft } from "../lib/koyaCharacterRosterReview.mjs";

const root = new URL("..", import.meta.url).pathname;
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function installAuthority(projectDir) {
  await mkdir(join(projectDir, "config/koya-character-styling"), { recursive: true });
  for (const name of ["koya-show-bible.json", "koya-location-bible.json", "koya-thumbnail-contract.json"]) {
    await writeFile(join(projectDir, "config", name), await readFile(resolveChannelPackPath(root, `config/${name}`)));
  }
  const showBible = JSON.parse(await readFile(resolveChannelPackPath(root, "config/koya-show-bible.json"), "utf8"));
  const paths = [...new Set(showBible.cast.flatMap((member) => [member.stylingSpecPath, ...(member.stylingSpecPaths || [])]).filter(Boolean))];
  // styling spec も Channel Pack 側にある。複製元を解決層に探させないと、
  // pack を分離した環境で fixture が組み立てられない。
  for (const relativePath of paths) {
    await writeFile(join(projectDir, relativePath), await readFile(resolveChannelPackPath(root, relativePath)));
  }
}

test("Koya authority is all-or-nothing and validates the three channel contracts", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-authority-"));
  const fallback = await readKoyaChannelAuthority({ projectDir, runtimeRoot: root });
  assert.equal(fallback.source, "runtime-template");
  await mkdir(join(projectDir, "config"), { recursive: true });
  await writeFile(join(projectDir, "config/koya-show-bible.json"), await readFile(resolveChannelPackPath(root, "config/koya-show-bible.json")));
  await assert.rejects(() => readKoyaChannelAuthority({ projectDir, runtimeRoot: root }), /authority is partial/u);
  await installAuthority(projectDir);
  const authority = await readKoyaChannelAuthority({ projectDir, runtimeRoot: root });
  assert.equal(authority.source, "project");
  assert.equal(authority.validation.show.castCount, 11);
  assert.equal(authority.validation.locations.locationCount, 2);
  assert.equal(authority.validation.styling.specCount, 8);
  const brokenShow = structuredClone(authority.showBible);
  brokenShow.cast.find((member) => member.id === "horo").stylingSpecPaths.reverse();
  await writeFile(join(projectDir, "config/koya-show-bible.json"), `${JSON.stringify(brokenShow, null, 2)}\n`);
  await assert.rejects(() => readKoyaChannelAuthority({ projectDir, runtimeRoot: root }), /must start with stylingSpecPath/u);
});

test("Koya story review binds ordered reversal beats to the exact script and protagonist", async (t) => {
  // この検証は台本の話者名が実際のキャストと一致することに依存している。
  // 合成 fixture では名前が別物なので成立しない——他の6件と違い、
  // 契約の形ではなく実データとの対応を見ているため。
  if (!channelPackPresent(root)) {
    t.skip("channel pack が無い環境（合成 fixture では話者名が一致しない）");
    return;
  }
  const authority = await readKoyaChannelAuthority({ projectDir: root });
  const scriptText = `タイトル: 記録が嘘を崩す

【カット1：攻撃】
対立山: お前には無理だ。
対立山: 証拠などない。
対立山: 俺を誰だと思ってる？

【カット2：逆転】
標本イツキ: 答え合わせ、始めましょうか。
ナレーション: 改ざん前の記録が映し出された。
例示アオイ: 私の仕事は、あなたの嘘では消えません。
標準タカシ: 逃げなさんな。
`;
  const parsed = parseMangaScript(scriptText);
  const ids = parsed.utterances.map((row) => row.id);
  const draft = createKoyaStoryReviewDraft({ showBible: authority.showBible, scriptText, parsed, protagonistSpeakerId: "例示アオイ" });
  assert.equal(draft.scriptSha256, hash(scriptText));
  assert.equal(draft.utteranceInventory.length, 7);
  assert.equal(draft.checks.protagonistAgencyPass, false);
  const review = {
    version: "koya-story-review-v1",
    scriptSha256: hash(scriptText),
    reviewer: { host: "codex", id: "reviewer-1", contextId: "review-task-1" },
    reviewedAt: "2026-08-27T00:00:00.000Z",
    protagonistSpeakerId: "例示アオイ",
    beats: {
      attack1: ids[0], attack2: ids[1], attack3: ids[2], ibukiSignal: ids[3], evidence: ids[4], protagonistFinish: ids[5], tatsuExitBlock: ids[6],
    },
    checks: {
      realPlaceNamesAbsent: true,
      realBrandSignsAbsent: true,
      directViolenceNotGlorified: true,
      villainComedyPresent: true,
      protagonistAgencyPass: true,
      alcoholKeywordsRestrained: true,
    },
  };
  const passed = auditKoyaStory({ scriptText, parsed, showBible: authority.showBible, storyReview: review });
  assert.equal(passed.pass, true, JSON.stringify(passed));
  const allyStealsFinish = structuredClone(review);
  allyStealsFinish.beats.protagonistFinish = ids[3];
  const failed = auditKoyaStory({ scriptText, parsed, showBible: authority.showBible, storyReview: allyStealsFinish });
  assert.equal(failed.pass, false);
  assert.match(failed.failures.join("\n"), /protagonistFinish/u);
});

test("Koya fixed cast cannot be replaced by episode-local candidates and must carry required identity roles", async () => {
  const authority = await readKoyaChannelAuthority({ projectDir: root });
  const parsed = parseMangaScript("もも: ほな、ぼちぼち反撃といこか");
  const baseCharacter = {
    id: "horo",
    name: "もも",
    kind: "character",
    role: "fixed",
    status: "approved",
    aliases: ["仮名ヨシ"],
    referenceAssets: ["identity-face", "turnaround", "expression"].map((role) => ({ id: role, role, path: `${role}.png`, sha256: "a".repeat(64) })),
    approval: { identityReviewPath: "review.json", identityReviewSha256: "b".repeat(64) },
  };
  const missingEyeOpen = auditKoyaFixedCastReadiness({
    showBible: authority.showBible,
    registry: { characters: [baseCharacter] },
    parsed,
    characterBible: { cast: [{ id: "horo", name: "もも" }] },
    enforce: true,
  });
  assert.equal(missingEyeOpen.pass, false);
  assert.match(missingEyeOpen.failures.join("\n"), /eye-open/u);
  const passed = auditKoyaFixedCastReadiness({
    showBible: authority.showBible,
    registry: { characters: [{ ...baseCharacter, referenceAssets: [...baseCharacter.referenceAssets, { id: "eye-open", role: "eye-open", path: "eye.png", sha256: "c".repeat(64) }] }] },
    parsed,
    characterBible: { cast: [{ id: "horo", name: "もも" }] },
    enforce: true,
    rosterReviewAudit: { pass: true, failures: [] },
  });
  assert.equal(passed.pass, true, JSON.stringify(passed));
  const absentSilentHoro = auditKoyaFixedCastReadiness({
    showBible: authority.showBible,
    registry: { characters: [] },
    parsed: parseMangaScript("例示アオイ: 私が証拠を示します"),
    characterBible: { cast: [{ name: "例示アオイ" }] },
    enforce: true,
  });
  assert.equal(absentSilentHoro.pass, false);
  assert.match(absentSilentHoro.failures.join("\n"), /must be declared in every episode/u);
});

test("Koya character bootstrap status reports the next legal action without inventing approvals", async () => {
  const authority = await readKoyaChannelAuthority({ projectDir: root });
  const empty = await auditKoyaCharacterBootstrap({
    showBible: authority.showBible,
    registry: { characters: [] },
    workflowStore: { workflows: [] },
  });
  assert.equal(empty.pass, false);
  assert.equal(empty.onHoldCount, 0);
  assert.equal(empty.blockingCount, 11);
  assert.equal(empty.rows.find((row) => row.id === "miehara").stage, "workflow-missing");
  assert.equal(empty.rows.find((row) => row.id === "horo").selectedBaseLabel, "A");
  assert.equal(empty.rows.find((row) => row.id === "horo").stage, "workflow-missing");
});

test("Koya roster gate binds all 11 identity faces and requires 55 independent original/thumbnail-scale pair checks", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-roster-review-"));
  await installAuthority(projectDir);
  const authority = await readKoyaChannelAuthority({ projectDir, runtimeRoot: root });
  const characters = [];
  await mkdir(join(projectDir, "canvas", "assets", "roster-fixture"), { recursive: true });
  await mkdir(join(projectDir, "canvas", "reviews", "roster-fixture"), { recursive: true });
  for (const [index, member] of authority.showBible.cast.entries()) {
    const facePath = join(projectDir, "canvas", "assets", "roster-fixture", `${member.id}.png`);
    const reviewPath = join(projectDir, "canvas", "reviews", "roster-fixture", `${member.id}.json`);
    const faceBytes = Buffer.from(`fixture-face-${member.id}-${index}`);
    const reviewBytes = Buffer.from(`${JSON.stringify({ memberId: member.id, pass: true })}\n`);
    await writeFile(facePath, faceBytes);
    await writeFile(reviewPath, reviewBytes);
    characters.push({
      id: `registry-${member.id}`,
      name: member.name,
      kind: "character",
      role: "fixed",
      status: "approved",
      aliases: [member.hiddenName].filter(Boolean),
      referenceAssets: [{ id: "identity-face", role: "identity-face", path: facePath, sha256: hash(faceBytes) }],
      approval: { identityReviewPath: reviewPath, identityReviewSha256: hash(reviewBytes) },
    });
  }
  const draft = await createKoyaCharacterRosterReviewDraft({
    projectDir,
    showBible: authority.showBible,
    registry: { characters },
    generatorHost: "codex",
    generatorId: "deterministic-roster-composer",
    generatorContextId: "roster-composer-context",
  });
  assert.equal(draft.ready, true);
  const review = JSON.parse(await readFile(draft.reviewPath, "utf8"));
  assert.equal(review.members.length, 11);
  assert.equal(review.pairChecks.length, 55);
  assert.equal((await auditKoyaCharacterRosterReview({ projectDir, showBible: authority.showBible, registry: { characters } })).pass, false);
  review.reviewer = { host: "claude", id: "independent-roster-reviewer", contextId: "roster-review-context", reviewedAt: new Date().toISOString() };
  review.originalScaleInspected = true;
  review.thumbnailScaleInspected = true;
  for (const member of review.members) {
    member.checks = { silhouetteReadable: true, ageReadDistinct: true, roleReadDistinct: true, thumbnailScaleReadable: true };
    member.pass = true;
    member.note = "原寸と縮小の両方で役柄を識別できる";
  }
  for (const pair of review.pairChecks) {
    Object.assign(pair, {
      silhouetteDistinct: true,
      faceAgeRoleDistinct: true,
      hairOutfitColorNotConfusing: true,
      thumbnailScaleDistinct: true,
      originalScaleInspected: true,
      thumbnailScaleInspected: true,
      pass: true,
      note: "同時表示でも別人物として即時判別できる",
    });
  }
  review.pass = true;
  review.note = "固定キャスト11人の役割衝突なし";
  await writeFile(draft.reviewPath, `${JSON.stringify(review, null, 2)}\n`);
  const passedAudit = await auditKoyaCharacterRosterReview({ projectDir, showBible: authority.showBible, registry: { characters } });
  assert.equal(passedAudit.pass, true, JSON.stringify(passedAudit));
});

test("Koya location registration requires four SHA-bound, independently reviewed boards", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-location-"));
  await installAuthority(projectDir);
  const authority = await readKoyaChannelAuthority({ projectDir, runtimeRoot: root });
  const plan = buildKoyaLocationBoardPlan({ projectDir, locationBible: authority.locationBible, locationId: "yamatani" });
  const emptyDraft = await createKoyaLocationReviewDraft({ projectDir, locationBible: authority.locationBible, locationId: "yamatani" });
  assert.ok(emptyDraft.boards.every((row) => row.sha256 === "" && row.checks.originalScalePass === false));
  const png = renderEditorialPlatePng("white-solid", 1280, 720);
  const generationCalls = [];
  const generator = async (input) => {
    generationCalls.push(input);
    return { buffer: Buffer.concat([png, Buffer.from(`koya-test-view-${generationCalls.length}`)]) };
  };
  await assert.rejects(() => generateKoyaLocationBoards({
    projectDir,
    locationId: "yamatani",
    stage: "all",
    generator: { host: "codex", id: "location-generator", contextId: "session-generator" },
    generateImage: generator,
  }), /combined all-stage generation is forbidden/u);
  const anchorGenerated = await generateKoyaLocationBoards({
    projectDir,
    locationId: "yamatani",
    stage: "anchor",
    generator: { host: "codex", id: "location-generator", contextId: "session-generator" },
    generateImage: generator,
  });
  assert.equal(anchorGenerated.complete, false);
  const anchorReviewPath = join(projectDir, "canvas/reviews/yamatani-anchor.json");
  await mkdir(join(projectDir, "canvas/reviews"), { recursive: true });
  const anchorReview = await createKoyaLocationAnchorReviewDraft({ projectDir, locationBible: authority.locationBible, locationId: "yamatani" });
  anchorReview.reviewer = { host: "claude", id: "anchor-reviewer", contextId: "session-anchor-reviewer" };
  anchorReview.reviewedAt = "2026-08-27T00:00:00.000Z";
  anchorReview.anchor.checks = {
    containsPeopleFalse: true,
    readableTextAbsent: true,
    realBrandsAbsent: true,
    architectureLockPass: true,
    originalScalePass: true,
    continuitySourceApproved: true,
  };
  await writeFile(anchorReviewPath, `${JSON.stringify(anchorReview, null, 2)}\n`);
  const anchorAudit = await auditKoyaLocationAnchorReview({ projectDir, locationBible: authority.locationBible, locationId: "yamatani", review: anchorReview });
  assert.equal(anchorAudit.pass, true, JSON.stringify(anchorAudit));
  await assert.rejects(() => generateKoyaLocationBoards({
    projectDir,
    locationId: "yamatani",
    stage: "continuity",
    generator: { host: "codex", id: "location-generator", contextId: "session-generator" },
    generateImage: generator,
  }), /anchor review path is required/u);
  const generated = await generateKoyaLocationBoards({
    projectDir,
    locationId: "yamatani",
    stage: "continuity",
    anchorReviewPath,
    generator: { host: "codex", id: "location-generator", contextId: "session-generator" },
    generateImage: generator,
  });
  assert.equal(generated.complete, true);
  assert.equal(generationCalls[0].referenceImagePaths.length, 0);
  assert.ok(generationCalls.slice(1).every((call) => call.referenceImagePaths.length === 1 && call.referenceImagePaths[0] === plan.jobs[0].outputPath));
  const manifestBytesBeforeReuse = await readFile(generated.manifestPath);
  const reused = await generateKoyaLocationBoards({
    projectDir,
    locationId: "yamatani",
    stage: "continuity",
    anchorReviewPath,
    generator: { host: "codex", id: "location-generator", contextId: "session-generator" },
    generateImage: generator,
  });
  assert.equal(reused.manifestRewritten, false);
  assert.equal(generationCalls.length, 4);
  assert.deepEqual(await readFile(generated.manifestPath), manifestBytesBeforeReuse);
  const reviewPath = join(projectDir, "canvas/reviews/yamatani.json");
  await mkdir(join(projectDir, "canvas/reviews"), { recursive: true });
  const review = await createKoyaLocationReviewDraft({ projectDir, locationBible: authority.locationBible, locationId: "yamatani" });
  review.reviewer = { host: "claude", id: "location-reviewer", contextId: "session-reviewer" };
  review.reviewedAt = "2026-08-27T00:00:00.000Z";
  review.checks = { crossViewArchitectureContinuity: true, originalScaleReview: true };
  for (const board of review.boards) board.checks = { containsPeopleFalse: true, readableTextAbsent: true, realBrandsAbsent: true, architectureLockPass: true, originalScalePass: true };
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
  await assert.rejects(
    () => registerApprovedKoyaLocation({ projectDir, locationId: "yamatani", review }),
    /reviewPath is required/u,
  );
  const audit = await auditKoyaLocationReview({ projectDir, locationBible: authority.locationBible, locationId: "yamatani", review });
  assert.equal(audit.pass, true, JSON.stringify(audit));
  const selfReviewed = structuredClone(review);
  selfReviewed.reviewer.contextId = "session-generator";
  const rejected = await auditKoyaLocationReview({ projectDir, locationBible: authority.locationBible, locationId: "yamatani", review: selfReviewed });
  assert.equal(rejected.pass, false);
  assert.match(rejected.failures.join("\n"), /different from its generator/u);
  const registered = await registerApprovedKoyaLocation({ projectDir, locationId: "yamatani", reviewPath });
  assert.equal(registered.location.kind, "location");
  assert.equal(registered.location.status, "approved");
  assert.equal(registered.location.referenceAssets.length, 4);
});

test("Koya thumbnail preflight blocks pending tokens and final audit rejects reused video frames", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-thumbnail-"));
  const authority = await readKoyaChannelAuthority({ projectDir, runtimeRoot: root });
  const plan = {
    version: "koya-thumbnail-plan-v1",
    stage: "preflight",
    layout: "twoPanel",
    bandLines: ["消された記録", "本人が逆転"],
    speechBubbles: [{ panelId: "left", lines: ["証拠は？"] }],
    telops: [{ text: "改ざん", concreteNounReviewPassed: true }],
    exactTextApproved: true,
  };
  const template = createKoyaThumbnailPlanDraft({ thumbnailContract: authority.thumbnailContract });
  assert.equal(template.layout, "twoPanel");
  assert.equal(template.exactTextApproved, false);
  plan.textApproval = { approvedBy: "koya-team", approvedAt: "2026-08-27T00:00:00.000Z", copySha256: koyaThumbnailCopySha256(plan) };
  const pending = await auditKoyaThumbnailPlan({ projectDir, thumbnailContract: authority.thumbnailContract, plan });
  assert.equal(pending.pass, false);
  assert.match(pending.failures.join("\n"), /tokens are pending/u);

  const approvedContract = structuredClone(authority.thumbnailContract);
  approvedContract.visual.bandColorToken = "band-red-v1";
  approvedContract.visual.bandFontToken = "font-gothic-v1";
  const assetDir = join(projectDir, "canvas/thumbs");
  await mkdir(assetDir, { recursive: true });
  const same = renderEditorialPlatePng("white-solid", 1280, 720);
  const other = renderEditorialPlatePng("black-solid", 1280, 720);
  const artworkA = join(assetDir, "a.png");
  const artworkB = join(assetDir, "b.png");
  const frame = join(assetDir, "frame.png");
  await Promise.all([writeFile(artworkA, same), writeFile(artworkB, other), writeFile(frame, same)]);
  const finalAudit = await auditKoyaThumbnailPlan({
    projectDir,
    thumbnailContract: approvedContract,
    plan: {
      ...plan,
      stage: "final",
      artworkPaths: [artworkA, artworkB],
      mainVideoFramePaths: [frame],
      checks: { original1280x720: true, mobile320x180: true, textCropZero: true, faceCropZero: true, primaryEmotionReadable: true, approvedCharacterReferencesOnly: true, realLogoZero: true },
    },
  });
  assert.equal(finalAudit.pass, false);
  assert.match(finalAudit.failures.join("\n"), /reuses a main-video frame/u);
});
