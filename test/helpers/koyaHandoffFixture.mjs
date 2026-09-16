import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { resolveChannelPackPath } from "../../lib/channelPackResolver.mjs";
import { prepareIdentityPackReviewDraft } from "../../lib/characterIdentityReview.mjs";
import { createKoyaCharacterRosterReviewDraft } from "../../lib/koyaCharacterRosterReview.mjs";
import { renderEditorialPlatePng } from "../../lib/mangaScriptImagePipeline.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeFixtureAsset(path, label, width = 64, height = 64) {
  const bytes = renderEditorialPlatePng("pastel-sky", width, height);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return { path, sha256: sha256(bytes) };
}

function approveCell(cell, label, extraBoolean = "") {
  return {
    ...cell,
    faceRegionReviewed: true,
    manualFaceRegion: [0, 0, 16, 16],
    sameIdentity: true,
    ageConsistent: true,
    hairConsistent: true,
    faceContourConsistent: true,
    ...(extraBoolean ? { [extraBoolean]: true } : {}),
    pass: true,
    note: `${label} ${cell.id} independently inspected`,
  };
}

/**
 * Provider-free, synthetic evidence for delivery-path tests. It intentionally
 * derives the cast from the selected Channel Pack instead of publishing a
 * second fixed-cast list in the test suite.
 */
export async function prepareCompleteKoyaHandoffEvidence({ projectDir, canvasDir = join(projectDir, "canvas") } = {}) {
  const showBible = JSON.parse(await readFile(resolveChannelPackPath(projectDir, "config/koya-show-bible.json"), "utf8"));
  await mkdir(join(canvasDir, "assets"), { recursive: true });
  const characters = [];
  const workflows = [];
  for (const [index, member] of showBible.cast.entries()) {
    const characterRoot = join(canvasDir, "assets", member.id);
    const faceRelativePath = `assets/${member.id}/identity-face.png`;
    const facePath = join(canvasDir, faceRelativePath);
    const faceWidth = 128 + index;
    const face = await writeFixtureAsset(facePath, `${member.id}:identity-face:${index}`, faceWidth, 128);
    const turnaround = await writeFixtureAsset(join(characterRoot, "turnaround.png"), `${member.id}:turnaround`, 400, 200);
    const expression = await writeFixtureAsset(join(characterRoot, "expression.png"), `${member.id}:expression`, 400, 300);
    const declaredOutfits = Array.isArray(member.outfitStages) ? member.outfitStages : [];
    const identityOutfits = [];
    for (const stage of declaredOutfits) {
      const storyStage = stage.id;
      const outfit = await writeFixtureAsset(join(characterRoot, `outfit-${storyStage}.png`), `${member.id}:outfit:${storyStage}`, 400, 100);
      identityOutfits.push({ ...outfit, assetFile: outfit.path, storyStage });
    }
    const needsEyeOpen = (member.requiredReferenceRoles || []).includes("eye-open");
    // One sheet per declared eye-open variant (storyStage = variant id); a
    // member without a declaration keeps the single unkeyed sheet.
    const declaredEyeOpenVariants = (Array.isArray(member.eyeOpenVariants) ? member.eyeOpenVariants : [])
      .map((variant) => variant?.id)
      .filter(Boolean);
    const eyeOpenSheets = [];
    if (needsEyeOpen) {
      for (const [variantIndex, variant] of (declaredEyeOpenVariants.length > 0 ? declaredEyeOpenVariants : [""]).entries()) {
        const fileName = variant ? `eye-open-${variant}.png` : "eye-open.png";
        const sheet = await writeFixtureAsset(join(characterRoot, fileName), `${member.id}:eye-open:${variant}`, 200 + variantIndex * 2, 200);
        eyeOpenSheets.push({ ...sheet, fileName, storyStage: variant });
      }
    }
    const eyeOpen = eyeOpenSheets[0] || null;
    const workflowId = `identity-workflow-${member.id}`;
    const generatorContextId = `identity-generator-context-${member.id}`;
    const identityPack = {
      selectedFace: { assetFile: face.path, sha256: face.sha256 },
      turnaround: { assetFile: turnaround.path, sha256: turnaround.sha256 },
      expression: { assetFile: expression.path, sha256: expression.sha256 },
      eyeOpen: eyeOpen ? { assetFile: eyeOpen.path, sha256: eyeOpen.sha256 } : null,
      ...(declaredEyeOpenVariants.length > 0 ? {
        eyeOpenSheets: eyeOpenSheets.map((sheet) => ({ assetFile: sheet.path, sha256: sheet.sha256, storyStage: sheet.storyStage })),
      } : {}),
      outfitSheets: identityOutfits.map(({ assetFile, sha256: digest, storyStage }) => ({ assetFile, sha256: digest, storyStage })),
      generatorContextId,
    };
    const draft = await prepareIdentityPackReviewDraft({
      projectDir,
      canvasDir,
      workflow: { id: workflowId },
      cast: { id: member.id, name: member.name },
      identityPack,
      generatorContextId,
    });
    const review = draft.review;
    review.reviewer = {
      host: "codex",
      id: `identity-reviewer-${member.id}`,
      contextId: `identity-review-context-${member.id}`,
      reviewedAt: "2026-08-27T00:00:00.000Z",
    };
    review.originalScaleInspected = true;
    review.turnaround.isRealTurnaround = true;
    review.turnaround.notCandidateSubstitute = true;
    review.turnaround.grid.alignmentConfirmed = true;
    review.turnaround.viewChecks = review.turnaround.viewChecks.map((cell) => approveCell(cell, "turnaround"));
    review.turnaround.pass = true;
    review.turnaround.note = "eight required turnaround views independently inspected";
    review.expression.grid.alignmentConfirmed = true;
    review.expression.cells = review.expression.cells.map((cell) => approveCell(cell, "expression"));
    review.expression.pass = true;
    review.expression.note = "twelve expression cells independently inspected";
    review.outfitSheets = review.outfitSheets.map((sheet) => ({
      ...sheet,
      sameIdentity: true,
      outfitMatchesSpecification: true,
      grid: { ...sheet.grid, alignmentConfirmed: true },
      cells: sheet.cells.map((cell) => approveCell(cell, `outfit-${sheet.storyStage}`, "outfitMatchesSpecification")),
      pass: true,
      note: `${sheet.storyStage} outfit independently inspected`,
    }));
    review.extraSheets = review.extraSheets.map((sheet) => ({
      ...sheet,
      sameIdentity: true,
      grid: { ...sheet.grid, alignmentConfirmed: true },
      cells: sheet.cells.map((cell) => approveCell(cell, "eye-open", "stateMatchesSpecification")),
      pass: true,
      note: "eye-open states independently inspected",
    }));
    review.pass = true;
    review.notes = "complete provider-free identity evidence fixture";
    await writeFile(draft.path, `${JSON.stringify(review, null, 2)}\n`);
    const reviewRelativePath = relative(canvasDir, draft.path);
    const outfitAssets = identityOutfits.map(({ sha256: digest, storyStage }) => ({
      id: `${member.id}-outfit-${storyStage}`,
      role: "outfit",
      path: `assets/${member.id}/outfit-${storyStage}.png`,
      sha256: digest,
      storyStage,
      sourceReviewPath: reviewRelativePath,
    }));
    const eyeOpenAssets = eyeOpenSheets.map((sheet) => ({
      id: sheet.storyStage ? `${member.id}-eye-open-${sheet.storyStage}` : `${member.id}-eye-open`,
      role: "eye-open",
      path: `assets/${member.id}/${sheet.fileName}`,
      sha256: sheet.sha256,
      ...(sheet.storyStage ? { storyStage: sheet.storyStage } : {}),
      sourceReviewPath: reviewRelativePath,
    }));
    characters.push({
      id: member.id,
      name: member.name,
      kind: "character",
      role: "fixed",
      status: "approved",
      sourceWorkflowId: workflowId,
      sourceCandidateId: `private-candidate-${member.id}`,
      voiceId: index === 0 ? "voice-fixture-primary" : "",
      referenceAssets: [
        { id: `${member.id}-face`, role: "identity-face", path: faceRelativePath, sha256: face.sha256, sourceReviewPath: reviewRelativePath },
        { id: `${member.id}-turnaround`, role: "turnaround", path: `assets/${member.id}/turnaround.png`, sha256: turnaround.sha256, sourceReviewPath: reviewRelativePath },
        { id: `${member.id}-expression`, role: "expression", path: `assets/${member.id}/expression.png`, sha256: expression.sha256, sourceReviewPath: reviewRelativePath },
        ...outfitAssets,
        ...eyeOpenAssets,
      ],
      approval: {
        route: "anonymous-candidate-selection",
        approvedBy: "human",
        approvedAt: "2026-08-27T00:00:00.000Z",
        selectedCandidateId: `private-${member.id}`,
        selectedCandidateLabel: "B",
        candidateSetId: `private-set-${member.id}`,
        verdictDigest: `private-digest-${member.id}`,
        selectedVariationAxis: `private-axis-${member.id}`,
        reason: "Human fixture approval",
        identityReviewPath: reviewRelativePath,
        identityReviewSha256: sha256(await readFile(draft.path)),
      },
    });
    workflows.push({
      id: workflowId,
      title: `${member.name} identity fixture`,
      episodeId: "fixed-cast-bootstrap",
      status: "ready",
      cast: [{
        id: member.id,
        name: member.name,
        role: "fixed",
        status: "ready",
        identityPack,
        identityReviewPath: draft.path,
      }],
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
  }
  await writeFile(join(canvasDir, "assets", "other-face.png"), "other-client-face");
  await writeFile(join(canvasDir, "assets", "channel-style.png"), "channel-style");
  const registry = {
    version: 1,
    revision: 0,
    characters: [
      ...characters,
      { id: "other-client", name: "Other project", kind: "character", role: "fixed", status: "approved", referenceImagePaths: ["assets/other-face.png"] },
      { id: "other-draft", name: "Other draft", kind: "character", role: "fixed", status: "draft", referenceImagePaths: ["assets/other-face.png"] },
    ],
    voices: [
      { id: "voice-fixture-primary", name: "Fixture voice", providerVoiceId: "public-provider-id", status: "approved" },
      { id: "voice-other", name: "Other voice", providerVoiceId: "must-not-export", status: "approved" },
    ],
  };
  await writeFile(join(canvasDir, "characters.json"), `${JSON.stringify(registry, null, 2)}\n`);
  await writeFile(join(canvasDir, "character-workflows.json"), `${JSON.stringify({ version: 1, revision: 0, workflows }, null, 2)}\n`);
  await writeFile(join(canvasDir, "channel-visual-profiles.json"), `${JSON.stringify({
    version: 1,
    defaultProfileId: "fixture-channel",
    profiles: [{
      id: "fixture-channel",
      name: "Fixture channel",
      status: "locked",
      referenceImages: [{ id: "style", path: "assets/channel-style.png", role: "style", tags: ["core"] }],
    }],
  }, null, 2)}\n`);
  const draft = await createKoyaCharacterRosterReviewDraft({
    projectDir,
    canvasDir,
    showBible,
    registry,
    generatorHost: "codex",
    generatorId: "fixture-roster-composer",
    generatorContextId: "fixture-roster-compose-context",
  });
  if (!draft.ready) throw new Error(`Synthetic Koya roster fixture is incomplete:\n- ${(draft.blockers || []).join("\n- ")}`);
  const rosterReview = JSON.parse(await readFile(draft.reviewPath, "utf8"));
  rosterReview.reviewer = {
    host: "claude-code",
    id: "fixture-independent-roster-reviewer",
    contextId: "fixture-independent-review-context",
    reviewedAt: "2026-08-31T00:00:00.000Z",
  };
  rosterReview.originalScaleInspected = true;
  rosterReview.thumbnailScaleInspected = true;
  rosterReview.members = rosterReview.members.map((member) => ({
    ...member,
    checks: {
      silhouetteReadable: true,
      ageReadDistinct: true,
      roleReadDistinct: true,
      thumbnailScaleReadable: true,
    },
    pass: true,
    note: `${member.showCharacterId} inspected at original and thumbnail scale`,
  }));
  rosterReview.pairChecks = rosterReview.pairChecks.map((pair) => ({
    ...pair,
    silhouetteDistinct: true,
    faceAgeRoleDistinct: true,
    hairOutfitColorNotConfusing: true,
    thumbnailScaleDistinct: true,
    originalScaleInspected: true,
    thumbnailScaleInspected: true,
    pass: true,
    note: `${pair.pairId} independently distinguished at both scales`,
  }));
  rosterReview.pass = true;
  rosterReview.note = "All 11 fixture members and all 55 pairs independently inspected at both scales";
  await writeFile(draft.reviewPath, `${JSON.stringify(rosterReview, null, 2)}\n`);
  return { canvasDir, showBible, registry, rosterReviewPath: draft.reviewPath, rosterSheetPath: draft.sheetPath };
}
