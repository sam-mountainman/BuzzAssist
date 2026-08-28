import test from "node:test";
import { resolveChannelPackPath } from "../lib/channelPackResolver.mjs";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  exportKoyaHandoffBundle,
  restoreKoyaHandoffBundle,
  verifyKoyaHandoffBundle,
} from "../lib/koyaHandoffBundle.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function copyConfig(sourceProject, targetProject, relativePath) {
  // Channel Pack はリポジトリ直下ではなく channel-packs/ に置かれるので、
  // fixture の元も解決層に探させる。
  const source = resolveChannelPackPath(sourceProject, relativePath);
  const target = path.join(targetProject, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
}

async function prepareProject(root, withData = true) {
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
  const canvas = path.join(root, "canvas");
  await mkdir(path.join(canvas, "assets"), { recursive: true });
  if (!withData) {
    await writeFile(path.join(canvas, "characters.json"), `${JSON.stringify({ version: 1, revision: 0, characters: [], voices: [] }, null, 2)}\n`);
    await writeFile(path.join(canvas, "channel-visual-profiles.json"), `${JSON.stringify({ version: 1, defaultProfileId: "", profiles: [] }, null, 2)}\n`);
    return;
  }
  await writeFile(path.join(canvas, "assets", "horo-face.png"), "approved-horo-face");
  await writeFile(path.join(canvas, "assets", "horo-turnaround.png"), "approved-horo-turnaround");
  await writeFile(path.join(canvas, "assets", "horo-review.json"), `${JSON.stringify({
    version: "koya-character-identity-review-v2",
    phase: "identity-pack",
    selectedFace: { path: path.join(canvas, "assets", "horo-face.png"), sha256: "source-review-asset-sha" },
    reviewer: { host: "codex", id: "reviewer", contextId: "review-context" },
    pass: true,
  }, null, 2)}\n`);
  await writeFile(path.join(canvas, "assets", "other-face.png"), "other-client-face");
  await writeFile(path.join(canvas, "assets", "koya-style.png"), "koya-style");
  const registry = {
    version: 1,
    revision: 0,
    characters: [
      {
        id: "horo",
        name: "もも",
        kind: "character",
        role: "fixed",
        status: "approved",
        voiceId: "voice-horo",
        referenceAssets: [
          { id: "face", role: "identity-face", path: "assets/horo-face.png", sha256: "", sourceReviewPath: "assets/horo-review.json" },
          { id: "turn", role: "turnaround", path: "assets/horo-turnaround.png", sha256: "", sourceReviewPath: "assets/horo-review.json" },
        ],
        approval: {
          route: "anonymous-candidate-selection",
          approvedBy: "human",
          approvedAt: "2026-08-27T00:00:00.000Z",
          selectedCandidateId: "private-internal-id",
          selectedCandidateLabel: "B",
          candidateSetId: "private-set",
          verdictDigest: "private-digest",
          selectedVariationAxis: "private-axis-map",
          reason: "人間が比較して採用",
          identityReviewPath: "assets/horo-review.json",
        },
      },
      { id: "other-client", name: "別案件", kind: "character", role: "fixed", status: "approved", referenceImagePaths: ["assets/other-face.png"] },
      { id: "reiji", name: "対照レン", kind: "character", role: "fixed", status: "draft", referenceImagePaths: ["assets/other-face.png"] },
    ],
    voices: [
      { id: "voice-horo", name: "Horo voice", providerVoiceId: "public-provider-id", status: "approved" },
      { id: "voice-other", name: "Other voice", providerVoiceId: "must-not-export", status: "approved" },
    ],
  };
  await writeFile(path.join(canvas, "characters.json"), `${JSON.stringify(registry, null, 2)}\n`);
  const profiles = {
    version: 1,
    defaultProfileId: "koya",
    profiles: [
      { id: "koya", name: "Koya", status: "locked", referenceImages: [{ id: "style", path: "assets/koya-style.png", role: "style", tags: ["core"] }] },
      { id: "other", name: "Other", status: "locked", referenceImages: [{ id: "other", path: "assets/other-face.png", role: "style" }] },
    ],
  };
  await writeFile(path.join(canvas, "channel-visual-profiles.json"), `${JSON.stringify(profiles, null, 2)}\n`);
}

test("Koya handoff exports only approved scoped data, verifies every file, and restores with portable paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "koya-handoff-"));
  const sourceProject = path.join(root, "source");
  const targetProject = path.join(root, "target");
  const bundleDir = path.join(root, "bundle");
  try {
    await prepareProject(sourceProject, true);
    await prepareProject(targetProject, false);
    const exported = await exportKoyaHandoffBundle({ projectDir: sourceProject, outputDir: bundleDir, bundleId: "handoff-test" });
    assert.equal(exported.manifest.includes.approvedCharacters, 1);
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
    assert.deepEqual(portableRegistry.characters.map((entry) => entry.id), ["horo"]);
    assert.deepEqual(portableRegistry.voices.map((entry) => entry.id), ["voice-horo"]);
    assert.equal(portableRegistry.characters[0].approval.selectedCandidateId, "");
    assert.equal(portableRegistry.characters[0].approval.candidateSetId, "");
    assert.match(portableRegistry.characters[0].referenceImagePaths[0], /^__BUNDLE_CANVAS__\//u);
    assert.match(portableRegistry.characters[0].approval.identityReviewPath, /^__BUNDLE_CANVAS__\//u);
    const attestationPath = path.join(bundleDir, "project", "canvas", portableRegistry.characters[0].approval.identityReviewPath.replace(/^__BUNDLE_CANVAS__\//u, ""));
    const attestationText = await readFile(attestationPath, "utf8");
    const attestation = JSON.parse(attestationText);
    assert.equal(attestation.version, "koya-handoff-review-attestation-v1");
    assert.equal(attestation.sourceReview.version, "koya-character-identity-review-v2");
    assert.match(attestation.snapshot.selectedFace.path, /^source-path-redacted:/u);
    assert.equal(attestationText.includes(sourceProject), false);
    assert.equal(exported.manifest.files.some((entry) => entry.kind === "approved-review-attestation"), true);
    const verified = await verifyKoyaHandoffBundle({ bundleDir });
    assert.equal(verified.ok, true);
    const restored = await restoreKoyaHandoffBundle({ projectDir: targetProject, bundleDir });
    assert.equal(restored.restoredCharacters, 1);
    assert.equal(restored.restoredVisualProfiles, 1);
    const targetRegistry = JSON.parse(await readFile(path.join(targetProject, "canvas", "characters.json"), "utf8"));
    assert.equal(targetRegistry.characters[0].id, "horo");
    assert.match(targetRegistry.characters[0].referenceImagePaths[0], /^koya-handoff-assets\/handoff-test\/assets\//u);
    assert.ok(await readFile(path.join(targetProject, "canvas", targetRegistry.characters[0].referenceImagePaths[0])));
    const targetProfiles = JSON.parse(await readFile(path.join(targetProject, "canvas", "channel-visual-profiles.json"), "utf8"));
    assert.deepEqual(targetProfiles.profiles.map((entry) => entry.id), ["koya"]);
    const evidencePath = path.join(bundleDir, exported.manifest.files.find((entry) => entry.kind === "approved-character-evidence").path);
    await writeFile(evidencePath, "tampered");
    await assert.rejects(() => verifyKoyaHandoffBundle({ bundleDir }), /SHA-256 mismatch|size mismatch/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
