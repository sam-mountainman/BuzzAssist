import test from "node:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { resolveChannelPackPath } from "../lib/channelPackResolver.mjs";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditKoyaCharacterRosterReview,
  resolveKoyaCharacterRosterReviewPaths,
} from "../lib/koyaCharacterRosterReview.mjs";
import { createChannelPackEnvelope, verifyChannelPackEnvelope } from "../lib/channelPackEnvelope.mjs";
import { prepareCompleteKoyaHandoffEvidence } from "./helpers/koyaHandoffFixture.mjs";
import {
  CHAT_CONTEXT,
  IMPORTER,
  importAndRegisterSyntheticLocation,
  readSyntheticKoyaAuthority,
  syntheticLocationBible,
} from "./helpers/koyaLocationFixture.mjs";
import { createMangaScriptImagePlan } from "../lib/mangaScriptImagePipeline.mjs";
import {
  exportKoyaHandoffBundle,
  restoreKoyaHandoffBundle,
  verifyKoyaHandoffBundle,
  _testing,
} from "../lib/koyaHandoffBundle.mjs";
import {
  auditKoyaVoiceSelections,
  classifyKoyaVoiceCastingRecord,
  KOYA_HANDOFF_VOICE_SELECTION_ATTESTATION,
} from "../lib/koyaVoiceSelectionGuard.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function writeJson(pathname, value) {
  await mkdir(path.dirname(pathname), { recursive: true });
  await writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`);
}

async function copyConfig(sourceProject, targetProject, relativePath) {
  // Channel Pack はリポジトリ直下ではなく channel-packs/ に置かれるので、
  // fixture の元も解決層に探させる。
  const source = resolveChannelPackPath(sourceProject, relativePath);
  const target = path.join(targetProject, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
}

async function prepareProject(root, withData = true, mutateShowBible = null) {
  const configFiles = [
    "config/koya-show-bible.json",
    "config/koya-location-bible.json",
    "config/koya-thumbnail-contract.json",
    "config/koya-manga-production-contract.json",
    "config/koya-manga-production-contract.schema.json",
    "config/koya-manga-quality-incidents.json",
  ];
  for (const relativePath of configFiles) await copyConfig(repoRoot, root, relativePath);
  const stylingDirectory = resolveChannelPackPath(repoRoot, "config/koya-character-styling");
  for (const name of (await readdir(stylingDirectory)).filter((entry) => entry.endsWith(".json")).sort()) {
    await copyConfig(repoRoot, root, path.join("config", "koya-character-styling", name));
  }
  if (mutateShowBible) {
    const showBiblePath = path.join(root, "config", "koya-show-bible.json");
    const showBible = JSON.parse(await readFile(showBiblePath, "utf8"));
    mutateShowBible(showBible);
    await writeJson(showBiblePath, showBible);
  }
  const canvas = path.join(root, "canvas");
  await mkdir(path.join(canvas, "assets"), { recursive: true });
  if (!withData) {
    await writeJson(path.join(canvas, "characters.json"), { version: 1, revision: 0, characters: [], voices: [] });
    await writeJson(path.join(canvas, "channel-visual-profiles.json"), { version: 1, defaultProfileId: "", profiles: [] });
    return;
  }
  await prepareCompleteKoyaHandoffEvidence({ projectDir: root, canvasDir: canvas });
}

test("Koya handoff exports only approved scoped data, verifies every file, and restores with portable paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "koya-handoff-"));
  const sourceProject = path.join(root, "source");
  const targetProject = path.join(root, "target");
  const bundleDir = path.join(root, "bundle");
  try {
    await prepareProject(sourceProject, true);
    await prepareProject(targetProject, false);
    const sourceRegistryPath = path.join(sourceProject, "canvas", "characters.json");
    const sourceRegistry = JSON.parse(await readFile(sourceRegistryPath, "utf8"));
    sourceRegistry.characters[0].voiceCasting = { candidateSetId: "private-voice-candidate-set" };
    sourceRegistry.characters[0].approval.approvedBy = "private-person-name";
    sourceRegistry.characters[0].approval.reason = "private operator note https://private.invalid/review";
    sourceRegistry.voices[0].previewUrl = "https://private.invalid/signed-preview";
    sourceRegistry.voices[0].labels = { internalOwner: "private-voice-owner" };
    sourceRegistry.voices[0].casting = { candidateSetId: "private-voice-candidate-set" };
    await writeJson(sourceRegistryPath, sourceRegistry);
    const exported = await exportKoyaHandoffBundle({ projectDir: sourceProject, outputDir: bundleDir, bundleId: "handoff-test" });
    assert.equal(exported.manifest.includes.approvedCharacters, 11);
    assert.equal(exported.manifest.includes.rosterReviewAttestation, true);
    assert.equal(exported.manifest.includes.rosterMembers, 11);
    assert.equal(exported.manifest.includes.rosterPairs, 55);
    assert.equal(exported.manifest.includes.pendingApprovalRows, 11);
    assert.equal(exported.manifest.includes.privateCandidateMapping, false);
    assert.ok(!exported.manifest.files.some((entry) => entry.path.includes("character-workflows")));
    const pendingApprovalsText = await readFile(path.join(bundleDir, "project", "koya-pending-approvals.json"), "utf8");
    const pendingApprovals = JSON.parse(pendingApprovalsText);
    assert.equal(pendingApprovals.version, "koya-handoff-pending-approvals-v1");
    assert.equal(pendingApprovals.rows.length, 11);
    assert.equal(pendingApprovalsText.includes(sourceProject), false);
    assert.equal(Object.hasOwn(pendingApprovals.rows[0], "workflowId"), false);
    const portableRegistry = JSON.parse(await readFile(path.join(bundleDir, "project", "canvas", "characters.json"), "utf8"));
    const showBible = JSON.parse(await readFile(path.join(sourceProject, "config", "koya-show-bible.json"), "utf8"));
    assert.deepEqual(portableRegistry.characters.map((entry) => entry.id), showBible.cast.map((entry) => entry.id));
    assert.deepEqual(portableRegistry.voices.map((entry) => entry.id), ["voice-fixture-primary"]);
    assert.equal(portableRegistry.characters[0].sourceWorkflowId, "");
    assert.equal(portableRegistry.characters[0].sourceCandidateId, "");
    assert.equal(portableRegistry.characters[0].voiceCasting, null);
    assert.match(portableRegistry.characters[0].approval.approvedBy, /^source-approver-sha256:[a-f0-9]{64}$/u);
    assert.match(portableRegistry.characters[0].approval.reason, /^source-reason-sha256:[a-f0-9]{64}$/u);
    assert.equal(portableRegistry.characters[0].approval.selectedCandidateLabel, "");
    assert.equal(portableRegistry.voices[0].previewUrl, "");
    assert.deepEqual(portableRegistry.voices[0].labels, {});
    assert.equal(portableRegistry.voices[0].casting, null);
    assert.equal(portableRegistry.characters[0].approval.selectedCandidateId, "");
    assert.equal(portableRegistry.characters[0].approval.candidateSetId, "");
    assert.match(portableRegistry.characters[0].referenceImagePaths[0], /^__BUNDLE_CANVAS__\//u);
    assert.match(portableRegistry.characters[0].approval.identityReviewPath, /^__BUNDLE_CANVAS__\//u);
    const attestationPath = path.join(bundleDir, "project", "canvas", portableRegistry.characters[0].approval.identityReviewPath.replace(/^__BUNDLE_CANVAS__\//u, ""));
    const attestationText = await readFile(attestationPath, "utf8");
    const attestation = JSON.parse(attestationText);
    assert.equal(attestation.version, "koya-handoff-review-attestation-v1");
    assert.equal(attestation.sourceReview.version, "koya-character-identity-review-v2");
    assert.match(attestation.snapshot.selectedFace.path, /^source-path-sha256:[a-f0-9]{64}$/u);
    assert.match(attestation.snapshot.reviewer.host, /^source-host-sha256:[a-f0-9]{64}$/u);
    assert.match(attestation.snapshot.reviewer.id, /^source-agent-sha256:[a-f0-9]{64}$/u);
    assert.match(attestation.snapshot.reviewer.contextId, /^source-context-sha256:[a-f0-9]{64}$/u);
    assert.equal(attestationText.includes(sourceProject), false);
    for (const privateValue of [
      "identity-workflow-",
      "private-candidate-",
      "private-voice-candidate-set",
      "private-voice-owner",
      "private-person-name",
      "private operator note",
      "identity-reviewer-",
      "identity-review-context-",
      "identity-generator-context-",
    ]) assert.equal((await readFile(path.join(bundleDir, "project", "canvas", "characters.json"), "utf8") + attestationText).includes(privateValue), false);
    assert.equal(exported.manifest.files.some((entry) => entry.kind === "approved-review-attestation"), true);
    assert.equal(exported.manifest.files.some((entry) => entry.kind === "approved-roster-review-sheet"), true);
    assert.equal(exported.manifest.files.some((entry) => entry.kind === "approved-roster-review-attestation"), true);
    const rosterAttestationPath = path.join(bundleDir, exported.manifest.rosterReview.attestation.path);
    const rosterAttestationText = await readFile(rosterAttestationPath, "utf8");
    const rosterAttestation = JSON.parse(rosterAttestationText);
    assert.equal(rosterAttestation.scope.episodeId, null);
    assert.equal(rosterAttestation.snapshot.members.length, 11);
    assert.equal(rosterAttestation.snapshot.pairChecks.length, 55);
    assert.match(rosterAttestation.snapshot.generator.contextId, /^source-context-sha256:[a-f0-9]{64}$/u);
    assert.match(rosterAttestation.snapshot.reviewer.contextId, /^source-context-sha256:[a-f0-9]{64}$/u);
    assert.equal(rosterAttestationText.includes(sourceProject), false);
    assert.equal(rosterAttestationText.includes("fixture-roster-compose-context"), false);
    const verified = await verifyKoyaHandoffBundle({ bundleDir });
    assert.equal(verified.ok, true);
    assert.equal(verified.rosterReview.memberCount, 11);
    assert.equal(verified.rosterReview.pairCount, 55);
    const restored = await restoreKoyaHandoffBundle({ projectDir: targetProject, bundleDir });
    assert.equal(restored.restoredCharacters, 11);
    assert.equal(restored.restoredVisualProfiles, 1);
    assert.equal(restored.restoredRosterMembers, 11);
    assert.equal(restored.restoredRosterPairs, 55);
    const targetRegistry = JSON.parse(await readFile(path.join(targetProject, "canvas", "characters.json"), "utf8"));
    assert.equal(targetRegistry.characters[0].id, "horo");
    assert.match(targetRegistry.characters[0].referenceImagePaths[0], /^koya-handoff-assets\/handoff-test\/assets\//u);
    assert.ok(await readFile(path.join(targetProject, "canvas", targetRegistry.characters[0].referenceImagePaths[0])));
    const targetProfiles = JSON.parse(await readFile(path.join(targetProject, "canvas", "channel-visual-profiles.json"), "utf8"));
    assert.deepEqual(targetProfiles.profiles.map((entry) => entry.id), ["fixture-channel"]);
    const restoredRoster = resolveKoyaCharacterRosterReviewPaths({ projectDir: targetProject });
    assert.ok(await readFile(restoredRoster.sheetPath));
    assert.ok(await readFile(path.join(restoredRoster.root, "roster-review-attestation.json")));
    const rosterAudit = await auditKoyaCharacterRosterReview({
      projectDir: targetProject,
      showBible,
      registry: targetRegistry,
    });
    assert.equal(rosterAudit.pass, true, rosterAudit.failures.join("\n"));
    const evidencePath = path.join(bundleDir, exported.manifest.files.find((entry) => entry.kind === "approved-character-evidence").path);
    await writeFile(evidencePath, "tampered");
    await assert.rejects(() => verifyKoyaHandoffBundle({ bundleDir }), /SHA-256 mismatch|size mismatch/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Koya handoff carries a human voice selection only as a sanitized record the receiving speech gate accepts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "koya-handoff-voice-selection-"));
  const sourceProject = path.join(root, "source");
  const targetProject = path.join(root, "target");
  const bundleDir = path.join(root, "bundle");
  try {
    await prepareProject(sourceProject, true);
    await prepareProject(targetProject, false);
    const sourceRegistryPath = path.join(sourceProject, "canvas", "characters.json");
    const sourceRegistry = JSON.parse(await readFile(sourceRegistryPath, "utf8"));
    const voice = sourceRegistry.voices.find((entry) => entry.id === "voice-fixture-primary");
    const speaker = sourceRegistry.characters.find((entry) => entry.voiceId === voice.id);
    // The shape the anonymous audition approval writes (selectionVersion 2).
    voice.casting = {
      language: "ja",
      auditionPlanId: "private-voice-audition-plan",
      candidateSetId: "private-voice-candidate-set",
      selectedCandidateLabel: "B",
      auditionCandidateCount: 3,
      score: 71,
      persona: { name: "private persona" },
      previewUrl: "https://private.invalid/voice-preview.mp3",
      previewConfirmed: true,
      selectionReason: "private voice selection reason",
      approvedBy: "private-voice-approver",
      selectedAt: "2026-09-10T00:00:00.000Z",
      selectionVersion: 2,
    };
    speaker.voiceCasting = structuredClone(voice.casting);
    await writeJson(sourceRegistryPath, sourceRegistry);

    await exportKoyaHandoffBundle({ projectDir: sourceProject, outputDir: bundleDir, bundleId: "handoff-voice-selection" });
    const bundleRegistryPath = path.join(bundleDir, "project", "canvas", "characters.json");
    const bundleRegistryText = await readFile(bundleRegistryPath, "utf8");
    const portable = JSON.parse(bundleRegistryText).voices.find((entry) => entry.id === voice.id).casting;
    assert.deepEqual(Object.keys(portable).sort(), [
      "approvedBy", "attestation", "auditionCandidateCount", "candidateSetId", "previewConfirmed",
      "selectedAt", "selectionReason", "selectionVersion", "winnerLabelRecorded",
    ]);
    assert.equal(portable.attestation, KOYA_HANDOFF_VOICE_SELECTION_ATTESTATION);
    assert.equal(portable.auditionCandidateCount, 3);
    assert.equal(portable.selectedAt, "2026-09-10T00:00:00.000Z");
    assert.match(portable.approvedBy, /^source-approver-sha256:[a-f0-9]{64}$/u);
    assert.match(portable.selectionReason, /^source-reason-sha256:[a-f0-9]{64}$/u);
    assert.match(portable.candidateSetId, /^source-candidate-set-sha256:[a-f0-9]{64}$/u);
    for (const privateValue of [
      "private-voice-audition-plan",
      "private-voice-candidate-set",
      "private persona",
      "private.invalid/voice-preview",
      "private voice selection reason",
      "private-voice-approver",
    ]) assert.equal(bundleRegistryText.includes(privateValue), false, privateValue);
    assert.equal(JSON.parse(bundleRegistryText).characters.find((entry) => entry.id === speaker.id).voiceCasting, null);

    assert.equal((await verifyKoyaHandoffBundle({ bundleDir })).ok, true);
    await restoreKoyaHandoffBundle({ projectDir: targetProject, bundleDir });
    const targetRegistry = JSON.parse(await readFile(path.join(targetProject, "canvas", "characters.json"), "utf8"));
    const restoredVoice = targetRegistry.voices.find((entry) => entry.id === voice.id);
    assert.equal(classifyKoyaVoiceCastingRecord(restoredVoice.casting).kind, "human-selection");
    const line = {
      id: "cut-01-u01",
      cutId: "cut-01",
      speakerId: speaker.id,
      speakerName: speaker.name,
      preset: "dialogue",
      text: "おはようございます。",
      voiceProfileId: restoredVoice.id,
      voiceId: restoredVoice.providerVoiceId,
    };
    const audit = auditKoyaVoiceSelections({ manifest: { utterances: [line] }, registry: targetRegistry });
    assert.equal(audit.pass, true, JSON.stringify(audit.speakers));
    assert.equal(audit.speakers[0].registrySource, "handoff-bundle");

    // Raw private data smuggled back into the record is refused even after the
    // manifest is rehashed to match the edited registry.
    const tampered = JSON.parse(bundleRegistryText);
    tampered.voices.find((entry) => entry.id === voice.id).casting.selectionReason = "private voice selection reason";
    await writeJson(bundleRegistryPath, tampered);
    const manifestPath = path.join(bundleDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const row = manifest.files.find((entry) => entry.path === "project/canvas/characters.json");
    row.size = (await stat(bundleRegistryPath)).size;
    row.sha256 = sha256(await readFile(bundleRegistryPath));
    delete manifest.digest;
    manifest.digest = sha256(JSON.stringify(manifest));
    await writeJson(manifestPath, manifest);
    await assert.rejects(
      () => verifyKoyaHandoffBundle({ bundleDir }),
      /casting data other than a sanitized human voice-selection attestation/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Koya handoff carries every declared eye-open variant under one identity review and refuses a missing one", async () => {
  // The variant declaration lives in the temporary project's show bible, so a
  // developer pack exposed through the environment must not shadow it.
  const savedPack = process.env.BUZZASSIST_CHANNEL_PACK;
  delete process.env.BUZZASSIST_CHANNEL_PACK;
  const root = await mkdtemp(path.join(os.tmpdir(), "koya-handoff-eye-open-"));
  const sourceProject = path.join(root, "source");
  const targetProject = path.join(root, "target");
  let memberId = "";
  // The member is picked by rule (an occasional eye-open member), never by name.
  const declareVariants = (showBible) => {
    const recurringId = showBible.storyGrammar?.castSemantics?.recurringEyeOpen?.castId;
    const member = showBible.cast.find((entry) => entry.id !== recurringId && entry.requiredReferenceRoles?.includes("eye-open"));
    assert.ok(member, "fixture needs an occasional member with a required eye-open sheet");
    memberId = member.id;
    member.eyeOpenVariants = [
      { id: "open-calm", label: "calm", description: "gently open eyes" },
      { id: "open-angry", label: "angry", description: "hard glare" },
    ];
  };
  try {
    await prepareProject(sourceProject, true, declareVariants);
    await prepareProject(targetProject, false);
    const bundleDir = path.join(root, "bundle");
    await exportKoyaHandoffBundle({ projectDir: sourceProject, outputDir: bundleDir, bundleId: "handoff-eye-open" });
    assert.equal((await verifyKoyaHandoffBundle({ bundleDir })).ok, true);
    await restoreKoyaHandoffBundle({ projectDir: targetProject, bundleDir });
    const targetRegistry = JSON.parse(await readFile(path.join(targetProject, "canvas", "characters.json"), "utf8"));
    const restored = targetRegistry.characters.find((entry) => entry.id === memberId);
    const eyeOpenAssets = restored.referenceAssets.filter((asset) => asset.role === "eye-open");
    assert.deepEqual(eyeOpenAssets.map((asset) => asset.storyStage), ["open-calm", "open-angry"]);
    assert.equal(new Set(eyeOpenAssets.map((asset) => asset.path)).size, 2);
    for (const asset of eyeOpenAssets) {
      assert.equal(sha256(await readFile(path.join(targetProject, "canvas", asset.path))), asset.sha256);
      assert.equal(asset.sourceReviewPath, restored.approval.identityReviewPath);
    }

    // A registry that lost one declared variant is not exportable.
    const sourceRegistryPath = path.join(sourceProject, "canvas", "characters.json");
    const sourceRegistry = JSON.parse(await readFile(sourceRegistryPath, "utf8"));
    const character = sourceRegistry.characters.find((entry) => entry.id === memberId);
    character.referenceAssets = character.referenceAssets.filter((asset) => asset.storyStage !== "open-angry");
    await writeJson(sourceRegistryPath, sourceRegistry);
    await assert.rejects(
      () => exportKoyaHandoffBundle({ projectDir: sourceProject, outputDir: path.join(root, "bundle-missing"), bundleId: "handoff-eye-open-missing" }),
      (error) => /missing declared eye-open variant\(s\): open-angry/u.test(error.message)
        && /extraSheets must exactly cover every distinct registered eye-open variant/u.test(error.message),
    );
  } finally {
    if (savedPack === undefined) delete process.env.BUZZASSIST_CHANNEL_PACK;
    else process.env.BUZZASSIST_CHANNEL_PACK = savedPack;
    await rm(root, { recursive: true, force: true });
  }
});

test("Koya handoff refuses a missing, stale, partial, or episode-bound fixed-cast roster", async (t) => {
  const cases = [
    {
      name: "missing",
      mutate: async ({ project }) => rm(resolveKoyaCharacterRosterReviewPaths({ projectDir: project }).reviewPath),
      match: /roster review.*missing|11-member\/55-pair/u,
    },
    {
      name: "stale",
      mutate: async ({ project }) => {
        const registryPath = path.join(project, "canvas", "characters.json");
        const registry = JSON.parse(await readFile(registryPath, "utf8"));
        const character = registry.characters.find((entry) => entry.id === "horo");
        const facePath = path.join(project, "canvas", character.referenceAssets[0].path);
        await writeFile(facePath, "changed-after-roster-review");
        character.referenceAssets[0].sha256 = sha256(await readFile(facePath));
        await writeJson(registryPath, registry);
      },
      match: /source identity review|roster member evidence does not match|11-member\/55-pair/u,
    },
    {
      name: "partial",
      args: { characterIds: ["horo"] },
      match: /portable roster cannot bind|complete fixed-cast/u,
    },
    {
      name: "episode-bound",
      mutate: async ({ project }) => {
        const registryPath = path.join(project, "canvas", "characters.json");
        const registry = JSON.parse(await readFile(registryPath, "utf8"));
        registry.characters.find((entry) => entry.id === "horo").episodeId = "wrong-episode";
        await writeJson(registryPath, registry);
      },
      match: /episode-bound|channel-wide|11-member\/55-pair/u,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), `koya-handoff-${scenario.name}-`));
      const project = path.join(root, "project");
      try {
        await prepareProject(project, true);
        await scenario.mutate?.({ project });
        await assert.rejects(
          () => exportKoyaHandoffBundle({
            projectDir: project,
            outputDir: path.join(root, "bundle"),
            bundleId: `handoff-${scenario.name}`,
            ...scenario.args,
          }),
          scenario.match,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("Koya handoff refuses rehashed minimal identity-review booleans that omit the canonical machine evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "koya-handoff-fake-identity-pass-"));
  const project = path.join(root, "project");
  try {
    await prepareProject(project, true);
    const registryPath = path.join(project, "canvas", "characters.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    const character = registry.characters.find((entry) => entry.id === "horo");
    const face = character.referenceAssets.find((asset) => asset.role === "identity-face");
    const reviewPath = path.join(project, "canvas", character.approval.identityReviewPath);
    await writeJson(reviewPath, {
      version: "koya-character-identity-review-v2",
      phase: "identity-pack",
      workflowId: character.sourceWorkflowId,
      castId: character.id,
      generatorContextId: "fake-generator-context",
      reviewer: {
        host: "codex",
        id: "fake-reviewer",
        contextId: "fake-reviewer-context",
        reviewedAt: "2026-08-31T00:00:00.000Z",
      },
      originalScaleInspected: true,
      selectedFace: {
        path: path.join(project, "canvas", face.path),
        sha256: face.sha256,
      },
      turnaround: { pass: true, viewChecks: [] },
      expression: { pass: true, cells: [] },
      outfitSheets: [],
      extraSheets: [],
      pass: true,
    });
    const fakeReviewSha256 = sha256(await readFile(reviewPath));
    character.approval.identityReviewSha256 = fakeReviewSha256;
    await writeJson(registryPath, registry);
    const rosterPath = resolveKoyaCharacterRosterReviewPaths({ projectDir: project }).reviewPath;
    const roster = JSON.parse(await readFile(rosterPath, "utf8"));
    roster.members.find((member) => member.showCharacterId === "horo").identityReview.sha256 = fakeReviewSha256;
    await writeJson(rosterPath, roster);
    await assert.rejects(
      () => exportKoyaHandoffBundle({ projectDir: project, outputDir: path.join(root, "bundle") }),
      /source identity review is not exportable|required machine-bound cells|registered asset bytes/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Koya handoff fresh recheck rejects a rehashed same-size crop taken from the wrong parent-sheet cell", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "koya-handoff-fake-crop-"));
  const project = path.join(root, "project");
  try {
    await prepareProject(project, true);
    const registryPath = path.join(project, "canvas", "characters.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    const character = registry.characters.find((entry) => entry.id === "horo");
    const reviewPath = path.join(project, "canvas", character.approval.identityReviewPath);
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    const targetCell = review.turnaround.viewChecks[0];
    const unrelatedCell = review.turnaround.viewChecks[4];
    assert.equal(targetCell.width, unrelatedCell.width);
    assert.equal(targetCell.height, unrelatedCell.height);
    const fakeCropPath = path.join(path.dirname(reviewPath), "same-size-unrelated-crop.png");
    await copyFile(unrelatedCell.path, fakeCropPath);
    targetCell.path = fakeCropPath;
    targetCell.sha256 = sha256(await readFile(fakeCropPath));
    targetCell.machineFaceCropLumaDistanceToSelected = 0.123456;
    await writeJson(reviewPath, review);
    const fakeReviewSha256 = sha256(await readFile(reviewPath));
    character.approval.identityReviewSha256 = fakeReviewSha256;
    await writeJson(registryPath, registry);
    const rosterPath = resolveKoyaCharacterRosterReviewPaths({ projectDir: project }).reviewPath;
    const roster = JSON.parse(await readFile(rosterPath, "utf8"));
    roster.members.find((member) => member.showCharacterId === "horo").identityReview.sha256 = fakeReviewSha256;
    await writeJson(rosterPath, roster);
    await assert.rejects(
      () => exportKoyaHandoffBundle({ projectDir: project, outputDir: path.join(root, "bundle") }),
      /canonical fresh machine recheck|does not match a fresh crop|machine face detection was edited/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Koya handoff rejects semantically tampered 55-pair evidence even after attacker rehashes both manifests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "koya-handoff-roster-tamper-"));
  const project = path.join(root, "project");
  const bundleDir = path.join(root, "bundle");
  try {
    await prepareProject(project, true);
    const exported = await exportKoyaHandoffBundle({ projectDir: project, outputDir: bundleDir, bundleId: "handoff-tamper" });
    const attestationPath = path.join(bundleDir, exported.manifest.rosterReview.attestation.path);
    const attestation = JSON.parse(await readFile(attestationPath, "utf8"));
    attestation.snapshot.pairChecks[0].pass = false;
    attestation.evidenceDigest = sha256(canonicalJson({
      scope: attestation.scope,
      sourceReview: attestation.sourceReview,
      authority: attestation.authority,
      snapshot: attestation.snapshot,
    }));
    await writeJson(attestationPath, attestation);
    const manifestPath = path.join(bundleDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const row = manifest.files.find((entry) => entry.path === exported.manifest.rosterReview.attestation.path);
    const info = await stat(attestationPath);
    row.size = info.size;
    row.sha256 = sha256(await readFile(attestationPath));
    manifest.rosterReview.attestation.sha256 = row.sha256;
    manifest.rosterReview.evidenceDigest = attestation.evidenceDigest;
    delete manifest.digest;
    manifest.digest = sha256(JSON.stringify(manifest));
    await writeJson(manifestPath, manifest);
    await assert.rejects(
      () => verifyKoyaHandoffBundle({ bundleDir }),
      /\.pass must be true|requires pass/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the signed Koya Channel Pack envelope covers the roster sheet and complete attestation bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "koya-handoff-signed-roster-"));
  const project = path.join(root, "project");
  const bundleDir = path.join(root, "bundle");
  const envelopeDir = path.join(root, "signed-envelope");
  try {
    await prepareProject(project, true);
    const exported = await exportKoyaHandoffBundle({ projectDir: project, outputDir: bundleDir, bundleId: "handoff-signed" });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    const signed = await createChannelPackEnvelope({
      sourceDir: bundleDir,
      outputDir: envelopeDir,
      id: "koya-handoff-signed-fixture",
      version: "1.0.0",
      harnessId: "koya-manga-video",
      payloadKind: "koya-handoff",
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
      publicKeyPem,
    });
    assert.equal(signed.ok, true);
    assert.ok(signed.manifest.files.some((row) => row.path === `payload/${exported.manifest.rosterReview.sheet.path}`));
    assert.ok(signed.manifest.files.some((row) => row.path === `payload/${exported.manifest.rosterReview.attestation.path}`));
    assert.equal((await verifyChannelPackEnvelope({
      bundleDir: envelopeDir,
      trustedPublicKeyPem: publicKeyPem,
      expectedHarnessId: "koya-manga-video",
    })).ok, true);
    await writeFile(path.join(envelopeDir, "payload", exported.manifest.rosterReview.attestation.path), "tampered");
    await assert.rejects(
      () => verifyChannelPackEnvelope({
        bundleDir: envelopeDir,
        trustedPublicKeyPem: publicKeyPem,
        expectedHarnessId: "koya-manga-video",
      }),
      /SHA-256|byte/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Koya handoff restore transaction rolls every installed target back when post-install audit fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "koya-handoff-rollback-"));
  const sourceRoot = path.join(root, "source");
  const targetRoot = path.join(root, "target");
  try {
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(targetRoot, { recursive: true });
    const firstSource = path.join(sourceRoot, "first.json");
    const secondSource = path.join(sourceRoot, "second.json");
    const firstTarget = path.join(targetRoot, "first.json");
    const secondTarget = path.join(targetRoot, "second.json");
    await writeFile(firstSource, "new-first");
    await writeFile(secondSource, "new-second");
    await writeFile(firstTarget, "old-first");
    await writeFile(secondTarget, "old-second");
    const operations = [
      { source: firstSource, target: firstTarget, targetRoot, expectedTargetFingerprint: await _testing.pathFingerprint(firstTarget) },
      { source: secondSource, target: secondTarget, targetRoot, expectedTargetFingerprint: await _testing.pathFingerprint(secondTarget) },
    ];
    await assert.rejects(
      () => _testing.commitRestoreOperations(operations, {
        transactionParent: root,
        afterInstall: async () => { throw new Error("canonical post-install audit failed"); },
      }),
      /canonical post-install audit failed/u,
    );
    assert.equal(await readFile(firstTarget, "utf8"), "old-first");
    assert.equal(await readFile(secondTarget, "utf8"), "old-second");
    assert.equal((await readdir(root)).some((name) => name.startsWith(".koya-handoff-restore-backup-")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable identity review privacy guard is schema-allowlisted and rejects unknown keys and numeric identifiers", () => {
  const failures = _testing.portableReviewPrivacyFailures({
    reviewer: { id: "raw-reviewer", contextId: "raw-context" },
    sourceWorkflowId: "raw-workflow",
    selectedCandidateId: "raw-candidate",
    note: "raw note",
    operator: "raw operator name",
    owner: "raw owner name",
    artifactUrl: "https://private.invalid/artifact",
    "secret-owner@example.com": true,
    phoneNumber: 819012345678,
    nested: { "private-session-raw": false },
  });
  assert.ok(failures.length >= 11);
  assert.deepEqual(_testing.portableReviewPrivacyFailures({
    version: "koya-character-identity-review-v2",
    phase: "identity-pack",
    selectedFace: {
      path: `source-path-sha256:${"9".repeat(64)}`,
      sha256: "8".repeat(64),
    },
    reviewer: {
      host: `source-host-sha256:${"0".repeat(64)}`,
      id: `source-agent-sha256:${"a".repeat(64)}`,
      contextId: `source-context-sha256:${"b".repeat(64)}`,
      reviewedAt: "2026-08-31T00:00:00.000Z",
    },
    generatorContextId: `source-context-sha256:${"c".repeat(64)}`,
    checks: Object.fromEntries([
      "originalScaleInspected",
      "turnaroundPass",
      "turnaroundViewsPass",
      "expressionPass",
      "expressionCellsPass",
      "outfitSheetsPass",
      "extraSheetsPass",
    ].map((key) => [key, true])),
    pass: true,
  }), []);
});

test("Koya handoff restore transaction rechecks each target immediately before mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "koya-handoff-concurrent-restore-"));
  const sourceRoot = path.join(root, "source");
  const targetRoot = path.join(root, "target");
  try {
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(targetRoot, { recursive: true });
    const firstSource = path.join(sourceRoot, "first.json");
    const secondSource = path.join(sourceRoot, "second.json");
    const firstTarget = path.join(targetRoot, "first.json");
    const secondTarget = path.join(targetRoot, "second.json");
    await writeFile(firstSource, "new-first");
    await writeFile(secondSource, "new-second");
    await writeFile(firstTarget, "old-first");
    await writeFile(secondTarget, "old-second");
    const operations = [
      { source: firstSource, target: firstTarget, targetRoot, expectedTargetFingerprint: await _testing.pathFingerprint(firstTarget) },
      { source: secondSource, target: secondTarget, targetRoot, expectedTargetFingerprint: await _testing.pathFingerprint(secondTarget) },
    ];
    await assert.rejects(
      () => _testing.commitRestoreOperations(operations, {
        transactionParent: root,
        beforeOperation: async ({ index }) => {
          if (index === 1) await writeFile(secondTarget, "concurrent-writer-value");
        },
      }),
      /changed immediately before commit/u,
    );
    assert.equal(await readFile(firstTarget, "utf8"), "old-first", "already-applied target must roll back");
    assert.equal(await readFile(secondTarget, "utf8"), "concurrent-writer-value", "concurrent writer must not be overwritten");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Koya handoff restore transaction rejects a staged source changed after preflight", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "koya-handoff-concurrent-source-"));
  const sourceRoot = path.join(root, "source");
  const targetRoot = path.join(root, "target");
  try {
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(targetRoot, { recursive: true });
    const firstSource = path.join(sourceRoot, "first.json");
    const secondSource = path.join(sourceRoot, "second.json");
    const firstTarget = path.join(targetRoot, "first.json");
    const secondTarget = path.join(targetRoot, "second.json");
    await writeFile(firstSource, "new-first");
    await writeFile(secondSource, "new-second");
    await writeFile(firstTarget, "old-first");
    await writeFile(secondTarget, "old-second");
    const operations = [
      { source: firstSource, target: firstTarget, targetRoot, expectedTargetFingerprint: await _testing.pathFingerprint(firstTarget) },
      { source: secondSource, target: secondTarget, targetRoot, expectedTargetFingerprint: await _testing.pathFingerprint(secondTarget) },
    ];
    await assert.rejects(
      () => _testing.commitRestoreOperations(operations, {
        transactionParent: root,
        beforeOperation: async ({ index }) => {
          if (index === 1) await writeFile(secondSource, "changed-staged-source");
        },
      }),
      /source changed immediately before commit/u,
    );
    assert.equal(await readFile(firstTarget, "utf8"), "old-first", "already-applied target must roll back");
    assert.equal(await readFile(secondTarget, "utf8"), "old-second", "unapplied target must stay untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Koya handoff rollback preserves an external write made after an earlier target was installed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "koya-handoff-concurrent-rollback-"));
  const sourceRoot = path.join(root, "source");
  const targetRoot = path.join(root, "target");
  try {
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(targetRoot, { recursive: true });
    const firstSource = path.join(sourceRoot, "first.json");
    const secondSource = path.join(sourceRoot, "second.json");
    const firstTarget = path.join(targetRoot, "first.json");
    const secondTarget = path.join(targetRoot, "second.json");
    await writeFile(firstSource, "new-first");
    await writeFile(secondSource, "new-second");
    await writeFile(firstTarget, "old-first");
    await writeFile(secondTarget, "old-second");
    const operations = [
      { source: firstSource, target: firstTarget, targetRoot, expectedTargetFingerprint: await _testing.pathFingerprint(firstTarget) },
      { source: secondSource, target: secondTarget, targetRoot, expectedTargetFingerprint: await _testing.pathFingerprint(secondTarget) },
    ];
    await assert.rejects(
      () => _testing.commitRestoreOperations(operations, {
        transactionParent: root,
        beforeOperation: async ({ index }) => {
          if (index === 1) {
            await writeFile(firstTarget, "external-write-after-install");
            await writeFile(secondTarget, "concurrent-trigger");
          }
        },
      }),
      /rollback failed|external writer/u,
    );
    assert.equal(await readFile(firstTarget, "utf8"), "external-write-after-install");
    assert.equal(await readFile(secondTarget, "utf8"), "concurrent-trigger");
    assert.equal((await readdir(root)).some((name) => name.startsWith(".koya-handoff-restore-backup-")), true, "manual recovery backup must be preserved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Koya handoff restore refuses an existing symlink anywhere below the destination root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "koya-handoff-symlink-"));
  const project = path.join(root, "project");
  const outside = path.join(root, "outside");
  await mkdir(project, { recursive: true });
  await mkdir(outside, { recursive: true });
  const linked = path.join(project, "config");
  await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    () => _testing.assertNoSymlinkAncestors(project, path.join(linked, "channel.json")),
    /refuses a symlink ancestor/u,
  );
});

async function rehashBundleManifest(bundleDir) {
  const manifestPath = path.join(bundleDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const files = [];
  for (const row of manifest.files) {
    const filePath = path.join(bundleDir, row.path);
    try {
      const info = await stat(filePath);
      files.push({ ...row, size: info.size, sha256: sha256(await readFile(filePath)) });
    } catch { /* 攻撃者が消したファイルは行ごと落とす */ }
  }
  manifest.files = files;
  delete manifest.digest;
  manifest.digest = sha256(JSON.stringify(manifest));
  await writeJson(manifestPath, manifest);
  return manifest;
}

async function bundleRegistryPath(bundleDir) {
  return path.join(bundleDir, "project", "canvas", "characters.json");
}

test("Koya handoff carries an approved location with its boards and a portable review attestation", async () => {
  // ロケーション正本はテスト用プロジェクトの側にあるので、開発機の pack に隠されないようにする。
  const savedPack = process.env.BUZZASSIST_CHANNEL_PACK;
  const savedPackId = process.env.BUZZASSIST_CHANNEL_PACK_ID;
  delete process.env.BUZZASSIST_CHANNEL_PACK;
  delete process.env.BUZZASSIST_CHANNEL_PACK_ID;
  const root = await mkdtemp(path.join(os.tmpdir(), "koya-handoff-location-"));
  const sourceProject = path.join(root, "source");
  const targetProject = path.join(root, "target");
  const bundleDir = path.join(root, "bundle");
  try {
    await prepareProject(sourceProject, true);
    await prepareProject(targetProject, false);
    await writeJson(path.join(sourceProject, "config", "koya-location-bible.json"), syntheticLocationBible());
    const authority = await readSyntheticKoyaAuthority(sourceProject);
    const approved = await importAndRegisterSyntheticLocation({
      projectDir: sourceProject,
      authority,
      locationId: "sample-street",
      sourceDir: path.join(root, "downloads"),
    });
    const exported = await exportKoyaHandoffBundle({ projectDir: sourceProject, outputDir: bundleDir, bundleId: "handoff-location" });
    assert.equal(exported.manifest.includes.approvedCharacters, 11);
    assert.equal(exported.manifest.includes.approvedLocations, 1);
    const portableRegistry = JSON.parse(await readFile(await bundleRegistryPath(bundleDir), "utf8"));
    const portableLocation = portableRegistry.characters.find((entry) => entry.kind === "location");
    assert.equal(portableLocation.id, "sample-street");
    assert.deepEqual(portableLocation.aliases, ["商店街", "駅前の商店街"]);
    assert.equal(portableLocation.referenceAssets.length, 4);
    assert.ok(portableLocation.referenceAssets.every((asset) => asset.path.startsWith("__BUNDLE_CANVAS__/assets/locations/")));
    assert.equal(portableLocation.approval.route, "koya-location-review-v3");
    assert.match(portableLocation.approval.approvedBy, /^source-approver-sha256:[a-f0-9]{64}$/u);
    const attestationPath = path.join(bundleDir, "project", "canvas", portableLocation.approval.identityReviewPath.replace(/^__BUNDLE_CANVAS__\//u, ""));
    const attestationText = await readFile(attestationPath, "utf8");
    const attestation = JSON.parse(attestationText);
    assert.equal(attestation.version, "koya-handoff-location-review-attestation-v1");
    assert.equal(attestation.sourceReview.version, "koya-location-review-v3");
    assert.equal(attestation.snapshot.textPolicy, "fictional-signage-allowed");
    assert.equal(attestation.snapshot.boards.length, 4);
    assert.ok(attestation.snapshot.boards.every((board) => board.provenance === "external-import" && board.checks.readableTextFictionalOnly === true));
    assert.match(attestation.snapshot.anchorReview.reviewerContextId, /^source-context-sha256:[a-f0-9]{64}$/u);
    for (const privateValue of [sourceProject, IMPORTER.contextId, CHAT_CONTEXT, "session-final-reviewer", "session-anchor-reviewer", "anchor-reviewer"]) {
      assert.equal(attestationText.includes(privateValue), false, privateValue);
      assert.equal(JSON.stringify(portableLocation).includes(privateValue), false, privateValue);
    }
    assert.ok(exported.manifest.files.some((row) => row.kind === "approved-location-evidence"));
    assert.ok(exported.manifest.files.some((row) => row.kind === "approved-location-review-attestation"));
    assert.equal((await verifyKoyaHandoffBundle({ bundleDir })).ok, true);

    const restored = await restoreKoyaHandoffBundle({ projectDir: targetProject, bundleDir });
    assert.equal(restored.restoredCharacters, 11);
    assert.equal(restored.restoredLocations, 1);
    const targetRegistry = JSON.parse(await readFile(path.join(targetProject, "canvas", "characters.json"), "utf8"));
    const restoredLocation = targetRegistry.characters.find((entry) => entry.kind === "location");
    assert.deepEqual(restoredLocation.aliases, ["商店街", "駅前の商店街"]);
    assert.equal(restoredLocation.referenceAssets.length, 4);
    for (const [index, asset] of restoredLocation.referenceAssets.entries()) {
      assert.match(asset.path, /^koya-handoff-assets\/handoff-location\/assets\/locations\/sample-street\//u);
      assert.equal(sha256(await readFile(path.join(targetProject, "canvas", asset.path))), asset.sha256);
      assert.equal(asset.sha256, approved.review.boards[index].sha256);
    }
    // 復元した作業場で、場面見出しの場所名（別名）が登録ボードに結び付く。
    const targetCanvas = path.join(targetProject, "canvas");
    const imagePlan = createMangaScriptImagePlan({
      scriptText: [
        "---",
        "タイトル: 商店街の落とし物",
        "登場人物:",
        "  - 名前: 山田花子",
        "    主人公: はい",
        "---",
        "",
        "#場面 1 駅前の商店街・夜",
        "山田花子：この財布、誰のだろう",
      ].join("\n"),
      registry: targetRegistry,
      assetDir: path.join(targetCanvas, "assets", "sample-episode"),
      canvasDir: targetCanvas,
    });
    const anchorBoardPath = path.join(targetCanvas, restoredLocation.referenceAssets[0].path);
    const sceneJobs = imagePlan.jobs.filter((job) => ["scene-image", "split-panel"].includes(job.kind));
    assert.ok(sceneJobs.length > 0);
    assert.ok(sceneJobs.every((job) => job.referenceImagePaths.includes(anchorBoardPath)));
    assert.equal(imagePlan.jobs.some((job) => job.kind === "environment-sheet"), false);

    // 改ざん: ボードのバイト列を差し替えて両 manifest と登録簿を作り直しても、attestation が拒む。
    const tamperedBoard = path.join(bundleDir, exported.manifest.files.find((row) => row.kind === "approved-location-evidence").path);
    await writeFile(tamperedBoard, await readFile(path.join(sourceProject, "canvas", "characters.json")));
    const registryPath = await bundleRegistryPath(bundleDir);
    const bundledRegistry = JSON.parse(await readFile(registryPath, "utf8"));
    const bundledLocation = bundledRegistry.characters.find((entry) => entry.kind === "location");
    // 束の中の path は常に "/" 区切りのトークン。relative() の区切りは OS 依存なので揃える。
    const tamperedToken = `__BUNDLE_CANVAS__/${path.relative(path.join(bundleDir, "project", "canvas"), tamperedBoard).split(path.sep).join("/")}`;
    const tamperedAsset = bundledLocation.referenceAssets.find((asset) => asset.path === tamperedToken);
    tamperedAsset.sha256 = sha256(await readFile(tamperedBoard));
    await writeJson(registryPath, bundledRegistry);
    await rehashBundleManifest(bundleDir);
    await assert.rejects(() => verifyKoyaHandoffBundle({ bundleDir }), /reviewed SHA-256 differs from the bundled board|bundled board is unreadable/u);
  } finally {
    if (savedPack === undefined) delete process.env.BUZZASSIST_CHANNEL_PACK; else process.env.BUZZASSIST_CHANNEL_PACK = savedPack;
    if (savedPackId === undefined) delete process.env.BUZZASSIST_CHANNEL_PACK_ID; else process.env.BUZZASSIST_CHANNEL_PACK_ID = savedPackId;
    await rm(root, { recursive: true, force: true });
  }
});

test("Koya handoff rejects a location whose board or attestation is missing or altered", async () => {
  const savedPack = process.env.BUZZASSIST_CHANNEL_PACK;
  const savedPackId = process.env.BUZZASSIST_CHANNEL_PACK_ID;
  delete process.env.BUZZASSIST_CHANNEL_PACK;
  delete process.env.BUZZASSIST_CHANNEL_PACK_ID;
  const root = await mkdtemp(path.join(os.tmpdir(), "koya-handoff-location-tamper-"));
  const sourceProject = path.join(root, "source");
  try {
    await prepareProject(sourceProject, true);
    await writeJson(path.join(sourceProject, "config", "koya-location-bible.json"), syntheticLocationBible());
    const authority = await readSyntheticKoyaAuthority(sourceProject);
    await importAndRegisterSyntheticLocation({
      projectDir: sourceProject,
      authority,
      locationId: "sample-street",
      sourceDir: path.join(root, "downloads"),
    });
    const scenarios = [
      {
        name: "missing board",
        mutate: async ({ bundleDir, registry, location }) => {
          const dropped = location.referenceAssets.pop();
          location.referenceImagePaths = location.referenceAssets.map((asset) => asset.path);
          await rm(path.join(bundleDir, "project", "canvas", dropped.path.replace(/^__BUNDLE_CANVAS__\//u, "")));
          return registry;
        },
        match: /must carry exactly the planned boards/u,
      },
      {
        name: "altered attestation judgment",
        mutate: async ({ bundleDir, registry, location }) => {
          const attestationPath = path.join(bundleDir, "project", "canvas", location.approval.identityReviewPath.replace(/^__BUNDLE_CANVAS__\//u, ""));
          const attestation = JSON.parse(await readFile(attestationPath, "utf8"));
          attestation.snapshot.boards[1].checks.readableTextFictionalOnly = false;
          await writeJson(attestationPath, attestation);
          location.approval.identityReviewSha256 = sha256(await readFile(attestationPath));
          return registry;
        },
        match: /check 'readableTextFictionalOnly' must be true/u,
      },
      {
        name: "reviewer context equal to the importer",
        mutate: async ({ bundleDir, registry, location }) => {
          const attestationPath = path.join(bundleDir, "project", "canvas", location.approval.identityReviewPath.replace(/^__BUNDLE_CANVAS__\//u, ""));
          const attestation = JSON.parse(await readFile(attestationPath, "utf8"));
          attestation.snapshot.reviewer.contextId = attestation.snapshot.boards[0].importerContextId;
          await writeJson(attestationPath, attestation);
          location.approval.identityReviewSha256 = sha256(await readFile(attestationPath));
          return registry;
        },
        match: /must differ from every generator and importer context/u,
      },
      {
        name: "missing attestation",
        mutate: async ({ bundleDir, registry, location }) => {
          await rm(path.join(bundleDir, "project", "canvas", location.approval.identityReviewPath.replace(/^__BUNDLE_CANVAS__\//u, "")));
          return registry;
        },
        match: /location review attestation/u,
      },
      {
        name: "location not declared by the bundled location bible",
        mutate: async ({ bundleDir, registry, location }) => {
          const biblePath = path.join(bundleDir, "project", "config", "koya-location-bible.json");
          const bible = JSON.parse(await readFile(biblePath, "utf8"));
          bible.locations = bible.locations.filter((entry) => entry.id !== location.id);
          await writeJson(biblePath, bible);
          return registry;
        },
        match: /bundled location bible does not declare/u,
      },
    ];
    for (const scenario of scenarios) {
      const bundleDir = path.join(root, `bundle-${scenario.name.replace(/\s+/gu, "-")}`);
      await exportKoyaHandoffBundle({ projectDir: sourceProject, outputDir: bundleDir, bundleId: "handoff-location-tamper" });
      const registryPath = await bundleRegistryPath(bundleDir);
      const registry = JSON.parse(await readFile(registryPath, "utf8"));
      const location = registry.characters.find((entry) => entry.kind === "location");
      await scenario.mutate({ bundleDir, registry, location });
      await writeJson(registryPath, registry);
      await rehashBundleManifest(bundleDir);
      await assert.rejects(() => verifyKoyaHandoffBundle({ bundleDir }), scenario.match, scenario.name);
    }
  } finally {
    if (savedPack === undefined) delete process.env.BUZZASSIST_CHANNEL_PACK; else process.env.BUZZASSIST_CHANNEL_PACK = savedPack;
    if (savedPackId === undefined) delete process.env.BUZZASSIST_CHANNEL_PACK_ID; else process.env.BUZZASSIST_CHANNEL_PACK_ID = savedPackId;
    await rm(root, { recursive: true, force: true });
  }
});

test("a bundle exported before locations travelled still verifies", async () => {
  const savedPack = process.env.BUZZASSIST_CHANNEL_PACK;
  delete process.env.BUZZASSIST_CHANNEL_PACK;
  const root = await mkdtemp(path.join(os.tmpdir(), "koya-handoff-no-location-"));
  const project = path.join(root, "project");
  const bundleDir = path.join(root, "bundle");
  try {
    await prepareProject(project, true);
    const exported = await exportKoyaHandoffBundle({ projectDir: project, outputDir: bundleDir, bundleId: "handoff-no-location" });
    assert.equal(exported.manifest.includes.approvedLocations, 0);
    // 旧版の束には approvedLocations というキー自体が無い。
    const manifestPath = path.join(bundleDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.includes.approvedLocations;
    delete manifest.digest;
    manifest.digest = sha256(JSON.stringify(manifest));
    await writeJson(manifestPath, manifest);
    assert.equal((await verifyKoyaHandoffBundle({ bundleDir })).ok, true);
  } finally {
    if (savedPack === undefined) delete process.env.BUZZASSIST_CHANNEL_PACK; else process.env.BUZZASSIST_CHANNEL_PACK = savedPack;
    await rm(root, { recursive: true, force: true });
  }
});
