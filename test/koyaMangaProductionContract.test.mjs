import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyKoyaContractToManifest,
  applyKoyaNarrationVoicePolicy,
  auditManifestAgainstKoyaContract,
  koyaContractDigest,
  resolveKoyaMangaProductionContract,
  validateKoyaMangaProductionContract,
  validateKoyaMangaProductionSchema,
} from "../lib/koyaMangaProductionContract.mjs";

function leafPaths(value, prefix = []) {
  if (Array.isArray(value)) return value.flatMap((entry, index) => leafPaths(entry, [...prefix, index]));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, entry]) => leafPaths(entry, [...prefix, key]));
  return [prefix];
}

function setAtPath(value, path, replacement) {
  let cursor = value;
  for (const part of path.slice(0, -1)) cursor = cursor[part];
  cursor[path.at(-1)] = replacement;
}

test("the Koya production contract is valid and deterministic", async () => {
  const first = await resolveKoyaMangaProductionContract({ projectDir: process.cwd() });
  const second = await resolveKoyaMangaProductionContract({ projectDir: process.cwd() });
  assert.equal(validateKoyaMangaProductionContract(first.contract).pass, true);
  assert.equal(first.digest, second.digest);
  assert.equal(first.digest, koyaContractDigest(first.contract));
});

test("episode overrides resolve narration policy without mutating the channel base", async () => {
  const base = await resolveKoyaMangaProductionContract({ projectDir: process.cwd() });
  const benchmark = await resolveKoyaMangaProductionContract({
    projectDir: process.cwd(),
    episodeId: "manga-photo-homecoming-001",
  });
  assert.equal(base.contract.audio.narrationVoicePolicy, "protagonist-voice");
  assert.equal(benchmark.contract.audio.narrationVoicePolicy, "approved-original-narrator");
  assert.equal(benchmark.contract.audio.narrationVoiceId, "H8ZPDxbrPcks5hEsi2fq");
  assert.notEqual(base.digest, benchmark.digest);
});

test("manifest application pins fail-closed Koya defaults", async () => {
  const resolved = await resolveKoyaMangaProductionContract({ projectDir: process.cwd() });
  const manifest = applyKoyaContractToManifest({
    id: "demo",
    model: "eleven_multilingual_v2",
    video: { bgmPath: "music.mp3", bgmVolume: 0.5, width: 640, height: 360, fps: 24, statusAfterRender: "final-v12" },
    production: { version: "v12" },
    utterances: [{ id: "cut-01-u01", model: "eleven_multilingual_v2" }],
  }, resolved);
  assert.equal(manifest.model, "eleven_v3");
  assert.equal(manifest.video.bgmVolume, 0);
  assert.equal(manifest.video.frameAlignCutDurations, true);
  assert.equal(manifest.video.forbidPushInCameraMotion, true);
  assert.equal(Object.hasOwn(manifest.video, "statusAfterRender"), false);
  assert.equal(Object.hasOwn(manifest.production, "version"), false);
  assert.equal(manifest.production.pipeline.entrypoint, "scripts/koya-manga-video.mjs");
  assert.equal(manifest.production.qualityPolicy.userFeedbackOverridesMachinePass, true);
  assert.equal(manifest.production.koyaContract.digest, resolved.digest);
  assert.equal(auditManifestAgainstKoyaContract(manifest, resolved).pass, true);
});

test("square narration rows keep narration styling but inherit the protagonist voice", async () => {
  const resolved = await resolveKoyaMangaProductionContract({ projectDir: process.cwd() });
  const manifest = applyKoyaContractToManifest({
    id: "narration-protagonist-test",
    model: "eleven_v3",
    video: {},
    utterances: [
      {
        id: "cut-01-u01",
        speakerId: "narration",
        speakerName: "ナレーション",
        preset: "narration",
        voiceProfileId: "dedicated-narrator",
        voiceId: "narrator-voice",
        model: "eleven_v3",
      },
      {
        id: "cut-01-u02",
        speakerId: "hero",
        speakerName: "悠斗",
        preset: "dialogue",
        voiceProfileId: "hero-profile",
        voiceId: "hero-voice",
        voiceName: "Hero Voice",
        voiceSettings: { stability: 0.5 },
        model: "eleven_v3",
      },
      {
        id: "cut-01-u03",
        speakerId: "friend",
        speakerName: "美咲",
        preset: "dialogue",
        voiceProfileId: "friend-profile",
        voiceId: "friend-voice",
        model: "eleven_v3",
      },
    ],
  }, resolved);
  const bound = applyKoyaNarrationVoicePolicy(manifest, resolved, { protagonistSpeakerId: "悠斗" });
  const narration = bound.utterances[0];
  assert.equal(narration.speakerId, "narration");
  assert.equal(narration.preset, "narration");
  assert.equal(narration.voiceId, "hero-voice");
  assert.equal(narration.voiceProfileId, "hero-profile");
  assert.equal(narration.voiceSourceSpeakerId, "hero");
  assert.equal(bound.production.protagonistSpeakerId, "hero");
  assert.equal(auditManifestAgainstKoyaContract(bound, resolved).pass, true);
  const broken = structuredClone(bound);
  broken.utterances[0].voiceId = "dedicated-narrator";
  const brokenAudit = auditManifestAgainstKoyaContract(broken, resolved);
  assert.equal(brokenAudit.pass, false);
  assert.ok(brokenAudit.failures.some((entry) => entry.id === "narration-voice-is-protagonist"));
});

test("protagonist narration policy fails closed instead of guessing among multiple speakers", async () => {
  const resolved = await resolveKoyaMangaProductionContract({ projectDir: process.cwd() });
  const manifest = {
    utterances: [
      { speakerId: "narration", speakerName: "ナレーション", preset: "narration" },
      { speakerId: "a", speakerName: "明", preset: "dialogue", voiceId: "voice-a" },
      { speakerId: "b", speakerName: "葵", preset: "dialogue", voiceId: "voice-b" },
    ],
  };
  assert.throws(
    () => applyKoyaNarrationVoicePolicy(manifest, resolved),
    /protagonist is ambiguous/u,
  );
});

test("contract validation rejects safety regressions", async () => {
  const resolved = await resolveKoyaMangaProductionContract({ projectDir: process.cwd() });
  const broken = structuredClone(resolved.contract);
  broken.camera.forbidPushIn = false;
  broken.audio.model = "eleven_multilingual_v2";
  broken.art.requireNaturalAnatomyAndPropScale = false;
  const report = validateKoyaMangaProductionContract(broken);
  assert.equal(report.pass, false);
  assert.deepEqual(report.failures.map((entry) => entry.path), ["art.requireNaturalAnatomyAndPropScale", "audio.model", "camera.forbidPushIn"]);
});

test("contract validation rejects a missing final audit even when list length is unchanged", async () => {
  const resolved = await resolveKoyaMangaProductionContract({ projectDir: process.cwd() });
  const contract = structuredClone(resolved.contract);
  contract.requiredAudits = contract.requiredAudits.map((id) => id === "agent-contact-sheet-review" ? "fake-audit" : id);
  const result = validateKoyaMangaProductionContract(contract);
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((failure) => failure.message.includes("agent-contact-sheet-review")));
});

test("the JSON Schema closes every contract object and validates every leaf", async () => {
  const resolved = await resolveKoyaMangaProductionContract({ projectDir: process.cwd() });
  assert.equal(validateKoyaMangaProductionSchema(resolved.contract).pass, true);

  const unknownTopLevel = structuredClone(resolved.contract);
  unknownTopLevel.unreviewedEscapeHatch = true;
  assert.equal(validateKoyaMangaProductionSchema(unknownTopLevel).pass, false);
  const unknownNested = structuredClone(resolved.contract);
  unknownNested.editorial.unreviewedEscapeHatch = true;
  assert.equal(validateKoyaMangaProductionSchema(unknownNested).pass, false);

  const mutations = [];
  for (const path of leafPaths(resolved.contract)) {
    const broken = structuredClone(resolved.contract);
    setAtPath(broken, path, { invalidType: true });
    const report = validateKoyaMangaProductionSchema(broken);
    mutations.push({ path: path.join("."), pass: report.pass });
  }
  assert.equal(mutations.length > 100, true);
  assert.deepEqual(mutations.filter((row) => row.pass), []);
});
