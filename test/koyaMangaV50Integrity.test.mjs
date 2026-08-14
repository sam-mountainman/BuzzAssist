import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createKoyaMangaDagRuntime } from "../lib/koyaMangaDagRuntime.mjs";
import { assertKoyaIndependentEvaluator, resolveKoyaAgentProvenance } from "../lib/koyaMangaProvenance.mjs";
import { recordBlindCandidateVerdict, writeBlindCandidatePackage } from "../lib/mangaBlindCandidateStore.mjs";
import { createMangaEvidenceManifest, sha256File, verifyMangaEvidenceManifest } from "../lib/mangaQualityEvidence.mjs";
import { executeMangaProductionDag } from "../lib/mangaProductionDag.mjs";

test("v50 provenance rejects a renamed reviewer in the generator context", () => {
  const generator = resolveKoyaAgentProvenance({ role: "generator", host: "codex", id: "generator", contextId: "task-context-1", env: {} });
  const renamed = resolveKoyaAgentProvenance({ role: "evaluator", host: "claude", id: "reviewer", contextId: "task-context-1", env: {} });
  assert.deepEqual(assertKoyaIndependentEvaluator(generator, renamed).failures, ["generator-evaluator-context-reused"]);
  const fresh = resolveKoyaAgentProvenance({ role: "evaluator", host: "claude", id: "reviewer", contextId: "task-context-2", env: {} });
  assert.equal(assertKoyaIndependentEvaluator(generator, fresh).pass, true);
});

test("v50 evidence manifest detects artifact mutation through its Merkle-bound entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "koya-evidence-v50-"));
  const first = join(root, "a.json");
  const second = join(root, "b.bin");
  await writeFile(first, JSON.stringify({ evidencePath: second }));
  await writeFile(second, "approved-bytes");
  const manifest = await createMangaEvidenceManifest({ episodeId: "episode", projectDir: root, artifacts: [first] });
  assert.equal(manifest.entryCount, 2);
  assert.equal((await verifyMangaEvidenceManifest(manifest)).pass, true);
  await writeFile(second, "mutated-bytes");
  const changed = await verifyMangaEvidenceManifest(manifest);
  assert.equal(changed.pass, false);
  assert.ok(changed.failures.some((entry) => entry.startsWith("digest-mismatch:")));
});

test("v50 evidence manifest excludes its own prior file and validates entry metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "koya-evidence-self-v50-"));
  const outputPath = join(root, "evidence-manifest.json");
  const reviewPath = join(root, "review.json");
  await writeFile(outputPath, JSON.stringify({ version: "prior" }));
  await writeFile(reviewPath, JSON.stringify({ evidenceManifestPath: outputPath }));
  const manifest = await createMangaEvidenceManifest({
    episodeId: "episode",
    projectDir: root,
    artifacts: [reviewPath],
    excludePaths: [outputPath],
  });
  assert.deepEqual(manifest.entries.map((entry) => entry.path), [reviewPath]);
  assert.equal((await verifyMangaEvidenceManifest(manifest)).pass, true);
  const wrongSize = structuredClone(manifest);
  wrongSize.entries[0].size += 1;
  const changed = await verifyMangaEvidenceManifest(wrongSize);
  assert.ok(changed.failures.some((entry) => entry.startsWith("size-mismatch:")));
  assert.ok(changed.failures.includes("merkle-root-mismatch"));
});

test("v50 blind package exposes only labels and verifies artifact bytes before reveal", async () => {
  const root = await mkdtemp(join(tmpdir(), "koya-blind-v50-"));
  const a = join(root, "source-a.png");
  const b = join(root, "source-b.png");
  await writeFile(a, "image-a");
  await writeFile(b, "image-b");
  const output = await writeBlindCandidatePackage([
    { id: "internal-a", provider: "provider-a", source: a, artifact: a, artifactSha256: await sha256File(a), variationAxis: "近景" },
    { id: "internal-b", provider: "provider-b", source: b, artifact: b, artifactSha256: await sha256File(b), variationAxis: "引き" },
  ], { rootDir: join(root, "package"), salt: "fixed-v50-test-salt" });
  const publicText = await readFile(output.publicPath, "utf8");
  assert.doesNotMatch(publicText, /internal-|provider-|source-a|source-b|近景|引き/u);
  const verdict = await recordBlindCandidateVerdict({
    publicPath: output.publicPath,
    privatePath: output.privatePath,
    winnerLabel: "A",
    decidedBy: "human-test",
    reason: "物語の感情と構図が最も明確だった",
  });
  assert.match(verdict.verdict.digest, /^[a-f0-9]{64}$/u);
  const publicPacket = JSON.parse(publicText);
  await writeFile(publicPacket.candidates[0].artifactRef, "tampered");
  await assert.rejects(() => recordBlindCandidateVerdict({
    publicPath: output.publicPath,
    privatePath: output.privatePath,
    winnerLabel: "B",
    decidedBy: "human-test",
    reason: "別候補を改めて選択した",
  }), /artifact digest mismatch/u);
});

test("official DAG runtime validates real hydrated artifacts for every exercised node", async () => {
  const root = await mkdtemp(join(tmpdir(), "koya-dag-v50-"));
  const imagePath = join(root, "image.png");
  const audioPath = join(root, "audio.wav");
  const cutPath = join(root, "cut.mp4");
  const videoPath = join(root, "final.mp4");
  const auditPath = join(root, "final-audit.json");
  for (const [path, contents] of [[imagePath, "image"], [audioPath, "audio"], [cutPath, "cut"], [videoPath, "video"]]) await writeFile(path, contents);
  const videoSha256 = await sha256File(videoPath);
  await writeFile(auditPath, JSON.stringify({
    pass: true,
    failedAuditIds: [],
    knownRemainingIssues: [],
    videoPath,
    videoSha256,
  }));
  const manifestPath = join(root, "episode-manifest.json");
  await writeFile(manifestPath, JSON.stringify({
    id: "episode",
    cuts: [{ id: "cut-1", imagePath, utteranceIds: ["u1"] }],
    utterances: [{ id: "u1", cutId: "cut-1", voiceId: "voice", audio: { filePath: audioPath }, bubbleSegments: [{ text: "声" }] }],
    jobs: { render: { "cut-1": { outputPath: cutPath } } },
    outputs: { finalVideo: { filePath: videoPath, sha256: videoSha256, auditReportPath: auditPath } },
    production: { finalKoyaAudit: { path: auditPath } },
  }));
  const nodes = [
    ["script", "script-analysis", {}, []],
    ["image", "base-image", { cutId: "cut-1" }, ["script"]],
    ["tts", "tts", { utteranceId: "u1" }, ["script"]],
    ["bubble", "bubble-final", { utteranceId: "u1" }, ["script"]],
    ["cut", "render-cut", { cutId: "cut-1" }, ["image", "tts", "bubble"]],
    ["video", "final-mp4", {}, ["cut"]],
    ["audit", "whole-program-audit", { category: "whole" }, ["video"]],
    ["decision", "quality-decision", {}, ["audit"]],
  ].map(([id, kind, input, dependencies]) => ({ id, kind, input, dependencies, pool: "planning", inputHash: `${id}-hash` }));
  const state = await executeMangaProductionDag({
    dag: { version: 4, episodeId: "episode", pools: { planning: 4 }, nodes },
    handlers: createKoyaMangaDagRuntime({ manifestPath }),
    maximumAttemptsPerRun: 1,
  });
  assert.deepEqual(state.summary, { complete: 8, failed: 0, pending: 0, blocked: [], withoutHandler: [] });
});

test("official DAG runtime rejects a mutated final MP4 and a nonexistent voice speaker", async () => {
  const root = await mkdtemp(join(tmpdir(), "koya-dag-integrity-v50-"));
  const videoPath = join(root, "final.mp4");
  const auditPath = join(root, "final-audit.json");
  await writeFile(videoPath, "approved-video");
  const approvedSha256 = await sha256File(videoPath);
  await writeFile(auditPath, JSON.stringify({
    pass: true,
    failedAuditIds: [],
    knownRemainingIssues: [],
    videoPath,
    videoSha256: approvedSha256,
  }));
  const manifestPath = join(root, "episode-manifest.json");
  await writeFile(manifestPath, JSON.stringify({
    utterances: [{ id: "u1", speakerId: "hero", voiceId: "voice" }],
    outputs: { finalVideo: { filePath: videoPath, sha256: approvedSha256, auditReportPath: auditPath } },
    production: { finalKoyaAudit: { path: auditPath } },
  }));
  const handlers = createKoyaMangaDagRuntime({ manifestPath });
  await assert.rejects(
    () => handlers["voice-profile"]({ node: { id: "voice-profile:missing", input: { speaker: { id: "missing" } } } }),
    /approved voice is missing/u,
  );
  await writeFile(videoPath, "mutated-video");
  await assert.rejects(
    () => handlers["final-mp4"]({ node: { id: "final-mp4", input: {} } }),
    /digest does not match/u,
  );
});
