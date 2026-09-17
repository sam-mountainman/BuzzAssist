import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { normalizeCharacterRegistry } from "../lib/characterRegistry.mjs";
import { generateKoyaDialogueSpeech } from "../lib/koyaDialogueSpeech.mjs";
import {
  assertKoyaSpeechVoiceSelections,
  explainKoyaUnvoicedProtagonist,
  koyaEpisodeManifestPipelineOptions,
  koyaEpisodePaths,
  koyaSpeechVoiceSelectionGate,
  recordKoyaRegistryVoiceSelections,
} from "../lib/koyaMangaProduction.mjs";
import {
  applyKoyaNarrationVoicePolicy,
  resolveKoyaMangaProductionContract,
} from "../lib/koyaMangaProductionContract.mjs";
import {
  assertKoyaHumanVoiceSelections,
  auditKoyaVoiceSelections,
  classifyKoyaVoiceCastingRecord,
  KOYA_VOICE_SELECTION_REQUIRED_CODE,
} from "../lib/koyaVoiceSelectionGuard.mjs";
import { createEpisodeManifest } from "../lib/mangaVideoPipeline.mjs";
import { castRegistryVoices } from "../lib/voiceCasting.mjs";
import {
  approveVoiceLibraryCasting,
  createVoiceLibraryAuditionPlan,
} from "../lib/voiceLibraryCasting.mjs";

const EPISODE_ID = "manga-guard-fixture-001";
const JOB_ID = "video-koya-manga-video-0123456789abcdef";
const PROTAGONIST_POLICY = { contract: { audio: { narrationVoicePolicy: "protagonist-voice", model: "eleven_v3" } } };

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function catalogVoice(id, gender, age, descriptive) {
  return {
    id,
    name: `${id} voice`,
    source: "account",
    available: true,
    language: "ja",
    gender,
    age,
    descriptive,
    useCase: "conversational",
    category: "professional",
    previewUrl: `https://example.test/${id}.mp3`,
    description: `Native Japanese ${gender} ${age} voice, ${descriptive}.`,
    labels: { language: "ja", gender, age, descriptive, use_case: "conversational" },
  };
}

const CATALOG = [
  catalogVoice("provider-calm-man", "male", "young", "calm natural gentle trustworthy"),
  catalogVoice("provider-steady-man", "male", "young", "steady sincere conversational"),
  catalogVoice("provider-gentle-woman", "female", "young", "gentle composed sincere"),
  catalogVoice("provider-bright-woman", "female", "young", "bright cheerful natural"),
];

function castMembers() {
  return [
    {
      id: "sato-ken",
      name: "佐藤健",
      kind: "character",
      status: "approved",
      description: "29-year-old Japanese man. Calm, gentle and trustworthy.",
    },
    {
      id: "yamada-hanako",
      name: "山田花子",
      kind: "character",
      status: "approved",
      description: "27-year-old Japanese woman. Composed, gentle and sincere.",
    },
  ];
}

/** Registry exactly as the generic auto-caster leaves it. */
function autoCastRegistry() {
  const characters = castMembers();
  const cast = castRegistryVoices({
    registry: { characters, voices: [] },
    voices: CATALOG,
    characters,
    episodeId: EPISODE_ID,
    includeNarration: false,
  });
  return normalizeCharacterRegistry(cast.registry);
}

/** Registry exactly as the human anonymous audition approval leaves it. */
async function humanSelectedRegistry(characterIds = ["sato-ken", "yamada-hanako"]) {
  const characters = castMembers();
  const plan = createVoiceLibraryAuditionPlan({
    episodeId: "global",
    characters: characters.filter((character) => characterIds.includes(character.id)),
    accountVoices: CATALOG,
    sharedVoices: [],
    includeNarration: false,
  });
  assert.ok(plan.entries.every((entry) => entry.candidates.length >= 2), "fixture must offer two candidates per person");
  const approved = await approveVoiceLibraryCasting({
    plan,
    registry: { characters, voices: [] },
    persist: false,
    confirmedVoiceAdds: true,
    selections: plan.entries.map((entry) => ({
      characterId: entry.characterId,
      winnerLabel: entry.candidates[1].blindLabel,
      previewConfirmed: true,
      selectionReason: "年齢感と落ち着いた話し方が台本の人物像に合う",
      approvedBy: "test-reviewer",
    })),
  });
  return normalizeCharacterRegistry(approved.registry);
}

/** Registry where one person was chosen by a human and the other by the auto-caster. */
async function mixedRegistry({ humanId, autoId }) {
  const human = await humanSelectedRegistry([humanId]);
  const auto = autoCastRegistry();
  const autoCharacter = auto.characters.find((entry) => entry.id === autoId);
  const autoProfile = auto.voices.find((entry) => entry.id === autoCharacter.voiceId);
  return normalizeCharacterRegistry({
    ...human,
    characters: human.characters.map((entry) => (entry.id === autoId ? autoCharacter : entry)),
    voices: [...human.voices, autoProfile],
  });
}

function voiceFields(registry, characterId) {
  const character = registry.characters.find((entry) => entry.id === characterId);
  const profile = registry.voices.find((entry) => entry.id === character?.voiceId);
  return {
    voiceProfileId: profile?.id || "",
    voiceId: profile?.providerVoiceId || "",
    voiceName: profile?.name || "",
  };
}

/** A Koya manifest shaped like prepare leaves it: dialogue voices from the registry, narration bound to the protagonist. */
function koyaManifest(registry) {
  const manifest = {
    id: EPISODE_ID,
    utterances: [
      { id: "cut-01-u01", cutId: "cut-01", speakerId: "narration", speakerName: "ナレーション", preset: "narration", text: "喫茶店の朝。", voiceId: "", voiceProfileId: "" },
      { id: "cut-01-u02", cutId: "cut-01", speakerId: "sato-ken", speakerName: "佐藤健", preset: "dialogue", text: "おはようございます。", ...voiceFields(registry, "sato-ken") },
      { id: "cut-02-u01", cutId: "cut-02", speakerId: "yamada-hanako", speakerName: "山田花子", preset: "dialogue", text: "会議室は二階です。", ...voiceFields(registry, "yamada-hanako") },
    ],
    cuts: [
      { id: "cut-01", utteranceIds: ["cut-01-u01", "cut-01-u02"] },
      { id: "cut-02", utteranceIds: ["cut-02-u01"] },
    ],
    production: { koyaContract: { narrationVoicePolicy: "protagonist-voice" } },
  };
  return applyKoyaNarrationVoicePolicy(manifest, PROTAGONIST_POLICY, { protagonistSpeakerId: "sato-ken" });
}

function minimalPng(width, height) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  header[25] = 6;
  return header;
}

async function writeProject(registry) {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-voice-guard-"));
  const canvasDir = join(projectDir, "canvas");
  const imagePath = join(canvasDir, "assets", EPISODE_ID, "page-01.png");
  await mkdir(join(canvasDir, "assets", EPISODE_ID), { recursive: true });
  await writeFile(imagePath, minimalPng(1920, 1080));
  const registryPath = join(canvasDir, "characters.json");
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  return { projectDir, canvasDir, imagePath, registryPath };
}

const SCRIPT = [
  "タイトル：喫茶店の朝",
  "【カット1：開店】",
  "ナレーション：喫茶店の朝。",
  "佐藤健：おはようございます。",
  "山田花子：会議室は二階です。",
].join("\n");

test("record classification: only a complete human blind selection counts", async () => {
  const auto = autoCastRegistry();
  assert.equal(classifyKoyaVoiceCastingRecord(auto.voices[0].casting).kind, "automatic");
  assert.equal(classifyKoyaVoiceCastingRecord(auto.characters[0].voiceCasting).kind, "automatic");

  const human = await humanSelectedRegistry();
  const record = human.voices[0].casting;
  assert.equal(classifyKoyaVoiceCastingRecord(record).kind, "human-selection");
  assert.match(human.voices[0].id, /^auto-/u, "the human approval route also names new profiles auto-*, so the profile id is not evidence");

  for (const marker of [{ method: "auto" }, { source: "auto-cast" }, { route: "automatic" }, { id: "auto-selection-1" }, { approvedBy: "auto" }]) {
    assert.equal(classifyKoyaVoiceCastingRecord({ ...record, ...marker }).kind, "automatic", JSON.stringify(marker));
  }
  for (const [field, value] of [
    ["selectionReason", "良い"],
    ["selectedCandidateLabel", ""],
    ["approvedBy", ""],
    ["previewConfirmed", false],
    ["candidateSetId", ""],
    ["auditionCandidateCount", 1],
    ["selectedAt", "not-a-date"],
  ]) {
    const result = classifyKoyaVoiceCastingRecord({ ...record, [field]: value });
    assert.equal(result.kind, "incomplete", field);
    assert.ok(result.failures.length > 0, field);
  }
  assert.equal(classifyKoyaVoiceCastingRecord({ ...record, selectionVersion: 1 }).kind, "incomplete");
  assert.equal(classifyKoyaVoiceCastingRecord(null).kind, "missing");
  assert.equal(classifyKoyaVoiceCastingRecord({}).kind, "missing");
});

test("Koya guard rejects auto-cast voices and names every character plus the recording command", () => {
  const registry = autoCastRegistry();
  const manifest = koyaManifest(registry);
  assert.ok(manifest.utterances.every((entry) => entry.voiceId), "auto-cast voices look assigned to the old voiceId-only check");
  let caught = null;
  try {
    assertKoyaHumanVoiceSelections({
      manifest,
      registry,
      narrationVoicePolicy: "protagonist-voice",
      projectDir: "/work/project",
      jobId: JOB_ID,
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "auto-cast voices must stop paid speech");
  assert.equal(caught.code, KOYA_VOICE_SELECTION_REQUIRED_CODE);
  assert.deepEqual(caught.characterIds, ["sato-ken", "yamada-hanako"]);
  assert.match(caught.message, /sato-ken \(佐藤健\) \[protagonist; narration uses this voice\]/u);
  assert.match(caught.message, /yamada-hanako \(山田花子\)/u);
  assert.match(caught.message, /automatic/u);
  assert.match(caught.message, /node scripts\/build-manga-video\.mjs voice-library-audition --project-dir \/work\/project --episode-id global --character-ids sato-ken,yamada-hanako/u);
  assert.match(caught.message, /voice-library-approve --project-dir \/work\/project --plan-path canvas\/voice-casting\/global-elevenlabs-audition\.json/u);
  assert.match(caught.message, /run-video-harness\.mjs resume --job-id video-koya-manga-video-0123456789abcdef --project-dir \/work\/project --confirmed/u);
  assert.equal(caught.audit.pass, false);
  assert.ok(caught.audit.speakers.every((entry) => entry.selectionKind === "automatic"));
});

test("Koya guard passes human-selected voices, including the protagonist voice narration uses", async () => {
  const registry = await humanSelectedRegistry();
  const manifest = koyaManifest(registry);
  const audit = assertKoyaHumanVoiceSelections({ manifest, registry, narrationVoicePolicy: "protagonist-voice" });
  assert.equal(audit.pass, true);
  assert.deepEqual(audit.pendingCharacterIds, []);
  assert.equal(audit.protagonistSpeakerId, "sato-ken");
  const protagonist = audit.speakers.find((entry) => entry.characterId === "sato-ken");
  assert.equal(protagonist.protagonist, true);
  assert.equal(protagonist.selectionKind, "human-selection");
});

test("Koya guard checks each person separately and flags the protagonist behind narration", async () => {
  const onlyOtherAuto = await mixedRegistry({ humanId: "sato-ken", autoId: "yamada-hanako" });
  const otherAudit = auditKoyaVoiceSelections({ manifest: koyaManifest(onlyOtherAuto), registry: onlyOtherAuto });
  assert.equal(otherAudit.pass, false);
  assert.deepEqual(otherAudit.pendingCharacterIds, ["yamada-hanako"]);

  const protagonistAuto = await mixedRegistry({ humanId: "yamada-hanako", autoId: "sato-ken" });
  const protagonistAudit = auditKoyaVoiceSelections({ manifest: koyaManifest(protagonistAuto), registry: protagonistAuto });
  assert.deepEqual(protagonistAudit.pendingCharacterIds, ["sato-ken"]);
  assert.equal(protagonistAudit.speakers.find((entry) => entry.characterId === "sato-ken").protagonist, true);
});

test("Koya guard refuses stale, missing, unregistered and mirrored-auto voices", async () => {
  const registry = await humanSelectedRegistry();

  const stale = koyaManifest(registry);
  stale.utterances.find((entry) => entry.speakerId === "yamada-hanako").voiceId = "provider-replaced";
  assert.match(
    auditKoyaVoiceSelections({ manifest: stale, registry }).speakers.find((entry) => entry.characterId === "yamada-hanako").failures.join(" "),
    /differs from registry profile/u,
  );

  const unassigned = koyaManifest(registry);
  Object.assign(unassigned.utterances.find((entry) => entry.speakerId === "yamada-hanako"), { voiceId: "", voiceProfileId: "" });
  assert.deepEqual(auditKoyaVoiceSelections({ manifest: unassigned, registry }).pendingCharacterIds, ["yamada-hanako"]);

  const guest = koyaManifest(registry);
  guest.utterances.push({ id: "cut-02-u02", cutId: "cut-02", speakerId: "guest-suzuki", speakerName: "鈴木", preset: "dialogue", text: "こんにちは。", ...voiceFields(registry, "yamada-hanako") });
  let guestError = null;
  try {
    assertKoyaHumanVoiceSelections({ manifest: guest, registry });
  } catch (error) {
    guestError = error;
  }
  assert.deepEqual(guestError?.characterIds, ["guest-suzuki"]);
  assert.match(guestError.message, /Register these speakers in the character registry first \(character-register\): guest-suzuki/u);

  const mirrored = normalizeCharacterRegistry(structuredClone(registry));
  mirrored.characters.find((entry) => entry.id === "yamada-hanako").voiceCasting = autoCastRegistry().characters[1].voiceCasting;
  assert.match(
    auditKoyaVoiceSelections({ manifest: koyaManifest(mirrored), registry: mirrored }).speakers.find((entry) => entry.characterId === "yamada-hanako").failures.join(" "),
    /automatic casting record/u,
  );

  const noBinding = koyaManifest(registry);
  delete noBinding.production.narrationVoiceBinding;
  delete noBinding.production.protagonistSpeakerId;
  const noBindingAudit = auditKoyaVoiceSelections({ manifest: noBinding, registry, narrationVoicePolicy: "protagonist-voice" });
  assert.deepEqual(noBindingAudit.pendingCharacterIds, ["narration"]);
});

test("only a passing non-public validation canary may speak with its declared provisional profiles", () => {
  const registry = autoCastRegistry();
  const manifest = koyaManifest(registry);
  const provisional = Object.fromEntries(["sato-ken", "yamada-hanako"].map((id) => [id, voiceFields(registry, id).voiceProfileId]));
  for (const utterance of manifest.utterances) {
    if (utterance.speakerId !== "narration") utterance.voiceApprovalScope = "validation-canary-provisional";
  }
  const canary = {
    active: true,
    pass: true,
    publicationEligible: false,
    provisionalVoiceProfileByCastId: provisional,
  };
  const passing = auditKoyaVoiceSelections({ manifest, registry, validationCanary: canary });
  assert.equal(passing.pass, true);
  assert.ok(passing.speakers.every((entry) => entry.selectionKind === "validation-canary-provisional"));

  assert.equal(auditKoyaVoiceSelections({ manifest, registry }).pass, false, "the manifest's own scope label is not enough");
  assert.equal(auditKoyaVoiceSelections({ manifest, registry, validationCanary: { ...canary, publicationEligible: true } }).pass, false);
  assert.equal(auditKoyaVoiceSelections({ manifest, registry, validationCanary: { ...canary, pass: false } }).pass, false);
  assert.equal(
    auditKoyaVoiceSelections({ manifest, registry, validationCanary: { ...canary, provisionalVoiceProfileByCastId: { "sato-ken": provisional["sato-ken"] } } })
      .pendingCharacterIds.join(","),
    "yamada-hanako",
  );
});

test("the speech-stage assertion reads the project registry, refuses auto-cast voices and never writes the registry", async () => {
  const autoProject = await writeProject(autoCastRegistry());
  const humanRegistry = await humanSelectedRegistry();
  const humanProject = await writeProject(humanRegistry);
  try {
    const resolved = { contract: { audio: { narrationVoicePolicy: "protagonist-voice" } }, episodeOverride: null };
    const autoBefore = await readFile(autoProject.registryPath);
    await assert.rejects(
      assertKoyaSpeechVoiceSelections({
        projectDir: autoProject.projectDir,
        episodeId: EPISODE_ID,
        manifest: koyaManifest(autoCastRegistry()),
        resolved,
        jobId: JOB_ID,
      }),
      (error) => {
        assert.equal(error.code, KOYA_VOICE_SELECTION_REQUIRED_CODE);
        assert.deepEqual(error.characterIds, ["sato-ken", "yamada-hanako"]);
        assert.ok(error.message.includes(join(autoProject.canvasDir, "voice-casting", "global-elevenlabs-audition.json")));
        return true;
      },
    );
    assert.equal(sha256(await readFile(autoProject.registryPath)), sha256(autoBefore));

    const humanBefore = await readFile(humanProject.registryPath);
    const audit = await assertKoyaSpeechVoiceSelections({
      projectDir: humanProject.projectDir,
      episodeId: EPISODE_ID,
      manifest: koyaManifest(humanRegistry),
      resolved,
    });
    assert.equal(audit.pass, true);
    assert.equal(sha256(await readFile(humanProject.registryPath)), sha256(humanBefore));
  } finally {
    await rm(autoProject.projectDir, { recursive: true, force: true });
    await rm(humanProject.projectDir, { recursive: true, force: true });
  }
});

test("Koya manifest preparation never auto-casts or writes the registry, even with a usable voice catalog", async () => {
  const uncast = normalizeCharacterRegistry({ characters: castMembers(), voices: [] });
  const project = await writeProject(uncast);
  try {
    const resolved = await resolveKoyaMangaProductionContract({ projectDir: project.projectDir });
    const options = koyaEpisodeManifestPipelineOptions({
      projectDir: project.projectDir,
      episodeId: EPISODE_ID,
      plan: { sourceScript: { text: SCRIPT }, manifest: { title: "喫茶店の朝" } },
      firstPageByCut: new Map([["cut-01", project.imagePath]]),
      resolved,
    });
    assert.equal(options.autoCastVoices, false);
    assert.equal(options.persistVoiceCasting, false);
    const before = await readFile(project.registryPath);
    // A provided catalog lets the generic builder cast without any network or
    // key, so a regression that re-enabled casting would show up here.
    const created = await createEpisodeManifest({ ...options, voiceCatalog: CATALOG });
    assert.equal(sha256(await readFile(project.registryPath)), sha256(before), "the Koya path must not write the registry");
    assert.equal(created.manifest.speech.voiceCasting.status, "disabled");
    assert.ok(created.manifest.utterances.every((entry) => entry.voiceId === ""), "no voice may be invented");

    const summarized = recordKoyaRegistryVoiceSelections(created.manifest, {
      registry: uncast,
      narrationVoicePolicy: "protagonist-voice",
    });
    assert.equal(summarized.speech.voiceCasting.status, "human-selection-required");
    assert.equal(summarized.speech.voiceCasting.autoCast, "disabled");
    assert.deepEqual(summarized.speech.voiceCasting.pendingCharacterIds, ["narration", "sato-ken", "yamada-hanako"]);
  } finally {
    await rm(project.projectDir, { recursive: true, force: true });
  }
});

test("prepare explains an unvoiced protagonist with the guided selection error and leaves other refusals alone", async () => {
  const uncast = normalizeCharacterRegistry({ characters: castMembers(), voices: [] });
  const project = await writeProject(uncast);
  try {
    const resolved = await resolveKoyaMangaProductionContract({ projectDir: project.projectDir });
    assert.equal(resolved.contract.audio.narrationVoicePolicy, "protagonist-voice", "fixture assumes the production narration policy");
    const created = await createEpisodeManifest(koyaEpisodeManifestPipelineOptions({
      projectDir: project.projectDir,
      episodeId: EPISODE_ID,
      plan: { sourceScript: { text: SCRIPT }, manifest: { title: "喫茶店の朝" } },
      firstPageByCut: new Map([["cut-01", project.imagePath]]),
      resolved,
    }));
    const paths = koyaEpisodePaths(project.projectDir, EPISODE_ID);
    let policyError = null;
    try {
      applyKoyaNarrationVoicePolicy(created.manifest, resolved, { protagonistSpeakerId: "佐藤健" });
    } catch (error) {
      policyError = error;
    }
    assert.match(policyError?.message || "", /has no approved voice/u);

    const context = {
      manifest: created.manifest,
      resolved,
      protagonistRequest: "佐藤健",
      registry: uncast,
      validationCanary: { active: false },
      paths,
      episodeId: EPISODE_ID,
      jobId: JOB_ID,
    };
    const explained = await explainKoyaUnvoicedProtagonist(policyError, context);
    assert.notEqual(explained, policyError);
    assert.equal(explained.code, KOYA_VOICE_SELECTION_REQUIRED_CODE);
    assert.deepEqual(explained.characterIds, ["sato-ken", "yamada-hanako"]);
    assert.match(explained.message, /sato-ken \(佐藤健\) \[protagonist; narration uses this voice\]: .*no voice is assigned/u);
    assert.match(explained.message, /voice-library-audition/u);
    const state = JSON.parse(await readFile(paths.statePath, "utf8"));
    assert.equal(state.status, "awaiting-voice-selection");
    assert.equal(state.currentStage, "prepare");
    assert.deepEqual(state.knownRemainingIssues[0].characterIds, ["sato-ken", "yamada-hanako"]);

    const ambiguous = new Error("ambiguous protagonist");
    assert.equal(await explainKoyaUnvoicedProtagonist(ambiguous, { ...context, protagonistRequest: "" }), ambiguous);
    const otherPolicy = new Error("frozen narrator");
    assert.equal(await explainKoyaUnvoicedProtagonist(otherPolicy, {
      ...context,
      resolved: { contract: { audio: { narrationVoicePolicy: "approved-original-narrator" } } },
    }), otherPolicy);
    const voiced = structuredClone(created.manifest);
    for (const row of voiced.utterances) if (row.speakerId === "sato-ken") row.voiceId = "provider-calm-man";
    const unrelated = new Error("unrelated refusal");
    assert.equal(await explainKoyaUnvoicedProtagonist(unrelated, { ...context, manifest: voiced }), unrelated);
  } finally {
    await rm(project.projectDir, { recursive: true, force: true });
  }
});

test("Koya manifest preparation uses human-selected registry voices unchanged", async () => {
  const registry = await humanSelectedRegistry();
  const project = await writeProject(registry);
  try {
    const resolved = await resolveKoyaMangaProductionContract({ projectDir: project.projectDir });
    const before = await readFile(project.registryPath);
    const created = await createEpisodeManifest({
      ...koyaEpisodeManifestPipelineOptions({
        projectDir: project.projectDir,
        episodeId: EPISODE_ID,
        plan: { sourceScript: { text: SCRIPT }, manifest: { title: "喫茶店の朝" } },
        firstPageByCut: new Map([["cut-01", project.imagePath]]),
        resolved,
      }),
      voiceCatalog: CATALOG,
    });
    assert.equal(sha256(await readFile(project.registryPath)), sha256(before));
    const bound = applyKoyaNarrationVoicePolicy(created.manifest, PROTAGONIST_POLICY, { protagonistSpeakerId: "sato-ken" });
    for (const id of ["sato-ken", "yamada-hanako"]) {
      const row = bound.utterances.find((entry) => entry.speakerId === id);
      assert.equal(row.voiceProfileId, voiceFields(registry, id).voiceProfileId);
      assert.equal(row.voiceId, voiceFields(registry, id).voiceId);
    }
    const summarized = recordKoyaRegistryVoiceSelections(bound, { registry, narrationVoicePolicy: "protagonist-voice" });
    assert.equal(summarized.speech.voiceCasting.status, "human-selected");
    assert.deepEqual(summarized.speech.voiceCasting.pendingCharacterIds, []);

    const canaryManifest = structuredClone(bound);
    canaryManifest.production.validationCanary = { active: true };
    canaryManifest.speech.voiceCasting = { status: "validation-canary-provisional" };
    assert.deepEqual(
      recordKoyaRegistryVoiceSelections(canaryManifest, { registry }).speech.voiceCasting,
      { status: "validation-canary-provisional" },
      "a canary keeps its own provisional casting summary",
    );
  } finally {
    await rm(project.projectDir, { recursive: true, force: true });
  }
});

test("generic manifest building still auto-casts and persists voices by default", async () => {
  const uncast = normalizeCharacterRegistry({ characters: castMembers(), voices: [] });
  const project = await writeProject(uncast);
  try {
    const created = await createEpisodeManifest({
      projectDir: project.projectDir,
      scriptText: SCRIPT,
      episodeId: "generic-guard-fixture",
      imagePathByCutId: { "cut-01": project.imagePath },
      voiceCatalog: CATALOG,
    });
    assert.equal(created.manifest.speech.voiceCasting.status, "updated");
    assert.equal(created.manifest.speech.voiceCasting.source, "provided-catalog");
    const written = JSON.parse(await readFile(project.registryPath, "utf8"));
    assert.equal(written.revision, uncast.revision + 1, "the generic path still persists its casting");
    assert.deepEqual(written.characters.map((entry) => entry.voiceId), ["auto-sato-ken-ja", "auto-yamada-hanako-ja"]);
    assert.ok(written.voices.some((entry) => entry.id === "auto-generic-guard-fixture-narration-ja"), "generic default still casts a narrator");
    const dialogue = created.manifest.utterances.filter((entry) => entry.speakerId !== "narration");
    assert.ok(dialogue.every((entry) => entry.voiceId.startsWith("provider-")));
    assert.equal(classifyKoyaVoiceCastingRecord(written.voices[0].casting).kind, "automatic");
  } finally {
    await rm(project.projectDir, { recursive: true, force: true });
  }
});

async function writeSpeechManifest(projectDir) {
  const episodeDir = join(projectDir, "episode");
  const manifestPath = join(episodeDir, "manifest.json");
  await mkdir(episodeDir, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify({
    id: "speech-gate-fixture",
    utterances: [
      { id: "u1", text: "一。", speakerId: "a", voiceId: "voice-a" },
      { id: "u2", text: "二。", speakerId: "a", voiceId: "voice-a" },
    ],
    cuts: [
      { id: "cut-01", utteranceIds: ["u1"] },
      { id: "cut-02", utteranceIds: ["u2"] },
    ],
    production: {},
  }, null, 2)}\n`);
  return { manifestPath, reportPath: join(episodeDir, "koya-dialogue-generation.json") };
}

const speechOptions = (projectDir, manifestPath) => ({
  projectDir,
  canvasDir: join(projectDir, "canvas"),
  manifestPath,
  contract: { audio: { takeCount: 2 } },
  voiceQualityGate: false,
  speechConcurrency: 1,
});

test("paid Koya speech runs the caller gate first, and a refusal starts no cut and writes nothing", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-speech-gate-"));
  try {
    const { manifestPath, reportPath } = await writeSpeechManifest(projectDir);
    const before = await readFile(manifestPath);
    const gateCalls = [];
    let runnerCalls = 0;
    await assert.rejects(
      generateKoyaDialogueSpeech({
        ...speechOptions(projectDir, manifestPath),
        approvedCheckpointImpl: async () => null,
        beforePaidSpeech: async ({ manifest, pendingCutIds }) => {
          gateCalls.push({ pendingCutIds, utterances: manifest.utterances.length });
          throw Object.assign(new Error("voice selection required"), { code: KOYA_VOICE_SELECTION_REQUIRED_CODE });
        },
        cutRunner: async () => {
          runnerCalls += 1;
          return {};
        },
      }),
      /voice selection required/u,
    );
    assert.deepEqual(gateCalls, [{ pendingCutIds: ["cut-01", "cut-02"], utterances: 2 }]);
    assert.equal(runnerCalls, 0);
    assert.equal(sha256(await readFile(manifestPath)), sha256(before));
    await assert.rejects(access(reportPath), { code: "ENOENT" });

    let passedGateRunnerCalls = 0;
    const passed = await generateKoyaDialogueSpeech({
      ...speechOptions(projectDir, manifestPath),
      approvedCheckpointImpl: async () => null,
      beforePaidSpeech: async () => {},
      cutRunner: async ({ cut, workerManifest }) => {
        passedGateRunnerCalls += 1;
        return { manifest: workerManifest, reportRow: { cutId: cut.id, status: "complete" } };
      },
    });
    assert.equal(passed.partial, false);
    assert.equal(passedGateRunnerCalls, 2);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("the Koya speech gate blocks auto-cast voices before any cut runs and records who needs a selection", async () => {
  const autoRegistry = autoCastRegistry();
  const autoProject = await writeProject(autoRegistry);
  const humanRegistry = await humanSelectedRegistry();
  const humanProject = await writeProject(humanRegistry);
  const resolved = { contract: { audio: { narrationVoicePolicy: "protagonist-voice", takeCount: 2 } }, episodeOverride: null };
  try {
    const paths = koyaEpisodePaths(autoProject.projectDir, EPISODE_ID);
    await mkdir(paths.episodeDir, { recursive: true });
    await writeFile(paths.manifestPath, `${JSON.stringify(koyaManifest(autoRegistry), null, 2)}\n`);
    const manifestBefore = await readFile(paths.manifestPath);
    const registryBefore = await readFile(autoProject.registryPath);
    let runnerCalls = 0;
    await assert.rejects(
      generateKoyaDialogueSpeech({
        projectDir: autoProject.projectDir,
        canvasDir: autoProject.canvasDir,
        manifestPath: paths.manifestPath,
        contract: resolved,
        voiceQualityGate: false,
        speechConcurrency: 1,
        approvedCheckpointImpl: async () => null,
        beforePaidSpeech: koyaSpeechVoiceSelectionGate({
          projectDir: autoProject.projectDir,
          episodeId: EPISODE_ID,
          resolved,
          jobId: JOB_ID,
        }),
        cutRunner: async () => {
          runnerCalls += 1;
          return {};
        },
      }),
      (error) => error.code === KOYA_VOICE_SELECTION_REQUIRED_CODE,
    );
    assert.equal(runnerCalls, 0, "no paid cut may start");
    assert.equal(sha256(await readFile(paths.manifestPath)), sha256(manifestBefore));
    assert.equal(sha256(await readFile(autoProject.registryPath)), sha256(registryBefore));
    const state = JSON.parse(await readFile(paths.statePath, "utf8"));
    assert.equal(state.episodeId, EPISODE_ID);
    assert.equal(state.status, "awaiting-voice-selection");
    assert.equal(state.currentStage, "speech");
    assert.equal(state.knownRemainingIssues[0].id, "voice-selection-required");
    assert.deepEqual(state.knownRemainingIssues[0].characterIds, ["sato-ken", "yamada-hanako"]);
    assert.deepEqual(state.knownRemainingIssues[0].pendingCutIds, ["cut-01", "cut-02"]);
    assert.match(state.knownRemainingIssues[0].detail, /voice-library-audition/u);

    const humanGate = koyaSpeechVoiceSelectionGate({ projectDir: humanProject.projectDir, episodeId: EPISODE_ID, resolved });
    const audit = await humanGate({ manifest: koyaManifest(humanRegistry), pendingCutIds: ["cut-01"] });
    assert.equal(audit.pass, true);
    await assert.rejects(access(koyaEpisodePaths(humanProject.projectDir, EPISODE_ID).statePath), { code: "ENOENT" });
  } finally {
    await rm(autoProject.projectDir, { recursive: true, force: true });
    await rm(humanProject.projectDir, { recursive: true, force: true });
  }
});

test("the paid-speech gate is skipped when nothing would be paid for", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-speech-gate-skip-"));
  try {
    const { manifestPath } = await writeSpeechManifest(projectDir);
    const refuse = async () => {
      throw new Error("the gate must not run");
    };
    const dryRun = await generateKoyaDialogueSpeech({
      ...speechOptions(projectDir, manifestPath),
      dryRun: true,
      approvedCheckpointImpl: async () => null,
      beforePaidSpeech: refuse,
    });
    assert.equal(dryRun.planned, true);

    const allReused = await generateKoyaDialogueSpeech({
      ...speechOptions(projectDir, manifestPath),
      approvedCheckpointImpl: async (plan) => ({ selectedTakeIndex: 0, sourcePath: `/fixture/${plan.cutId}.wav` }),
      beforePaidSpeech: refuse,
      cutRunner: refuse,
    });
    assert.equal(allReused.partial, false);

    const gateCalls = [];
    await generateKoyaDialogueSpeech({
      ...speechOptions(projectDir, manifestPath),
      approvedCheckpointImpl: async (plan) => (plan.cutId === "cut-01"
        ? { selectedTakeIndex: 0, sourcePath: "/fixture/cut-01.wav" }
        : null),
      beforePaidSpeech: async ({ pendingCutIds }) => { gateCalls.push(pendingCutIds); },
      cutRunner: async ({ cut, workerManifest }) => ({ manifest: workerManifest, reportRow: { cutId: cut.id, status: "complete" } }),
    });
    assert.deepEqual(gateCalls, [["cut-02"]], "the gate sees only the cuts that would be generated");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
