import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { KOYA_DIALOGUE_ADAPTERS, DEFAULT_KOYA_DIALOGUE_ADAPTER } from "../lib/koyaMangaProductionContract.mjs";
import {
  KOYA_VOICE_AUDITION_CANDIDATES_VERSION,
  approveKoyaVoiceAudition,
  createKoyaVoiceAuditionCandidatesTemplate,
  createKoyaVoiceAuditionPlan,
  createKoyaVoiceAuditionPreviewRenderer,
  koyaVoiceAuditionPaths,
  writeKoyaVoiceAuditionPlan,
} from "../lib/koyaVoiceAudition.mjs";
import {
  auditKoyaVoiceSelections,
  classifyKoyaVoiceCastingRecord,
  formatKoyaVoiceSelectionError,
} from "../lib/koyaVoiceSelectionGuard.mjs";

// 声の人選を提供元に依らず Koya の CLI で行う。確かめるのは:
//   1. 候補は2〜5声、試聴台詞は1行、オトシゴには演技タグを付けない
//   2. 有料の試聴は明示の確認が無ければ1件も作らず、作った分は SHA が合えば使い回す
//   3. 公開側（計画・HTML）に声IDが出ない
//   4. 採用は理由・試聴確認・同じ auditionPlanId が揃ったときだけで、書いた記録は
//      音声ゲートが「人が選んだ」と数える形になる
//   5. 契約と違う提供元の声は音声ゲートが止め、案内は Koya の voice-audition を指す

const OTOSHIGO = KOYA_DIALOGUE_ADAPTERS.find((entry) => entry.provider === "otoshigo");

function registry() {
  return {
    version: 1,
    revision: 3,
    characters: [
      { id: "hero", name: "主人公テスト", kind: "character", role: "fixed", status: "approved" },
      { id: "rival", name: "相手役テスト", kind: "character", role: "fixed", status: "approved" },
      { id: "guest", name: "客", kind: "character", role: "per-video", status: "approved", episodeId: "ep-9" },
    ],
    voices: [],
  };
}

function candidates(overrides = {}) {
  return {
    version: KOYA_VOICE_AUDITION_CANDIDATES_VERSION,
    episodeId: "global",
    entries: [
      {
        characterId: "hero",
        sampleLine: "今日から、ここが俺の店だ。",
        candidates: [
          { voiceId: "vc_hero_one", name: "低め" },
          { voiceId: "vc_hero_two", name: "明るめ" },
          { voiceId: "vc_hero_three", name: "かすれ" },
        ],
      },
      {
        characterId: "rival",
        sampleLine: "へえ、やってみろよ。",
        candidates: [
          { voiceId: "vc_rival_one" },
          { voiceId: "vc_rival_two" },
        ],
      },
    ],
    ...overrides,
  };
}

async function makeProject() {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-voice-audition-"));
  await mkdir(join(projectDir, "canvas"), { recursive: true });
  await writeFile(join(projectDir, "canvas", "characters.json"), `${JSON.stringify(registry(), null, 2)}\n`);
  return projectDir;
}

function fakeRenderer(calls) {
  return async ({ entry, candidate }) => {
    calls.push(`${entry.characterId}:${candidate.voiceId}`);
    return { audioBuffer: Buffer.from(`RIFF-${candidate.voiceId}`), extension: "wav", mediaJobId: `job-${calls.length}` };
  };
}

async function auditionReadyProject() {
  const projectDir = await makeProject();
  const plan = createKoyaVoiceAuditionPlan({ candidates: candidates(), registry: registry(), dialogueAdapter: OTOSHIGO });
  const calls = [];
  const written = await writeKoyaVoiceAuditionPlan({ projectDir, plan, confirmPaidPreview: true, renderPreview: fakeRenderer(calls) });
  return { projectDir, plan, written, calls };
}

function selectionsFor(planId, entries) {
  return { auditionPlanId: planId, selections: entries };
}

test("候補は2声以上・5声以下、キャラは台帳の現役人物、オトシゴの試聴台詞に演技タグは付けない", () => {
  const base = { registry: registry(), dialogueAdapter: OTOSHIGO };
  const one = candidates();
  one.entries[1].candidates = [{ voiceId: "vc_only" }];
  assert.throws(() => createKoyaVoiceAuditionPlan({ ...base, candidates: one }), /at least 2 candidate voices/u);
  const six = candidates();
  six.entries[1].candidates = Array.from({ length: 6 }, (_, index) => ({ voiceId: `vc_${index}` }));
  assert.throws(() => createKoyaVoiceAuditionPlan({ ...base, candidates: six }), /at most 5/u);
  const unknown = candidates();
  unknown.entries[0].characterId = "nobody";
  assert.throws(() => createKoyaVoiceAuditionPlan({ ...base, candidates: unknown }), /not an active character/u);
  const tagged = candidates();
  tagged.entries[0].sampleLine = "[angry] ふざけるな。";
  assert.throws(() => createKoyaVoiceAuditionPlan({ ...base, candidates: tagged }), /performance tags/u);
  const otherScope = candidates();
  otherScope.entries[0].characterId = "guest";
  assert.throws(() => createKoyaVoiceAuditionPlan({ ...base, candidates: otherScope }), /--episode-id ep-9/u);
  const wrongAdapter = candidates({ adapter: { provider: "elevenlabs", model: "eleven_v3" } });
  assert.throws(() => createKoyaVoiceAuditionPlan({ ...base, candidates: wrongAdapter }), /written for elevenlabs/u);
});

test("匿名ラベルは書いた順ではなく候補集合から決まり、計画IDも入力の並びに依らない", () => {
  const forward = createKoyaVoiceAuditionPlan({ candidates: candidates(), registry: registry(), dialogueAdapter: OTOSHIGO });
  const reversedInput = candidates();
  reversedInput.entries[0].candidates.reverse();
  const reversed = createKoyaVoiceAuditionPlan({ candidates: reversedInput, registry: registry(), dialogueAdapter: OTOSHIGO });
  assert.equal(forward.id, reversed.id);
  assert.deepEqual(
    forward.entries[0].candidates.map((entry) => [entry.blindLabel, entry.voiceId]),
    reversed.entries[0].candidates.map((entry) => [entry.blindLabel, entry.voiceId]),
  );
  assert.deepEqual(forward.entries[0].candidates.map((entry) => entry.blindLabel), ["A", "B", "C"]);
  assert.deepEqual(forward.adapter, { provider: "otoshigo", model: OTOSHIGO.model, adapterVersion: OTOSHIGO.adapterVersion });
});

test("有料の試聴は --confirm-paid-preview が無ければ1件も作らず、ファイルも書かない", async () => {
  const projectDir = await makeProject();
  try {
    const plan = createKoyaVoiceAuditionPlan({ candidates: candidates(), registry: registry(), dialogueAdapter: OTOSHIGO });
    const calls = [];
    const result = await writeKoyaVoiceAuditionPlan({ projectDir, plan, renderPreview: fakeRenderer(calls) });
    assert.equal(result.status, "awaiting-paid-confirmation");
    assert.equal(result.pendingPreviews, 5);
    assert.equal(result.estimatedCharacters, 3 * Array.from("今日から、ここが俺の店だ。").length + 2 * Array.from("へえ、やってみろよ。").length);
    assert.equal(calls.length, 0);
    await assert.rejects(readFile(koyaVoiceAuditionPaths({ projectDir }).jsonPath, "utf8"), /ENOENT/u);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("試聴を作ると公開側には匿名ラベルと SHA だけが載り、作り直しでは SHA が合う分を払い直さない", async () => {
  const { projectDir, plan, written, calls } = await auditionReadyProject();
  try {
    assert.equal(written.status, "awaiting-selection");
    assert.equal(calls.length, 5);
    const paths = koyaVoiceAuditionPaths({ projectDir });
    const publicText = await readFile(paths.jsonPath, "utf8");
    const html = await readFile(paths.htmlPath, "utf8");
    for (const voiceId of ["vc_hero_one", "vc_hero_two", "vc_hero_three", "vc_rival_one", "vc_rival_two", "低め"]) {
      assert.equal(publicText.includes(voiceId), false, `公開計画に ${voiceId} が出ない`);
      assert.equal(html.includes(voiceId), false, `HTML に ${voiceId} が出ない`);
    }
    const publicPlan = JSON.parse(publicText);
    assert.match(publicPlan.entries[0].candidates[0].previewSha256, /^[a-f0-9]{64}$/u);
    assert.equal(publicPlan.entries[0].candidates[0].previewUrl, "./previews/koya-global/hero/A.wav");
    const privatePlan = JSON.parse(await readFile(paths.privateJsonPath, "utf8"));
    assert.equal(privatePlan.entries[0].candidates.every((entry) => entry.voiceId.startsWith("vc_")), true);
    const selections = JSON.parse(await readFile(paths.selectionsPath, "utf8"));
    assert.equal(selections.auditionPlanId, plan.id);
    assert.deepEqual(selections.selections.map((entry) => entry.winnerLabel), ["", ""]);

    const again = createKoyaVoiceAuditionPlan({ candidates: candidates(), registry: registry(), dialogueAdapter: OTOSHIGO });
    const pending = await writeKoyaVoiceAuditionPlan({ projectDir, plan: again, renderPreview: fakeRenderer(calls) });
    assert.equal(pending.status, "awaiting-selection", "全部そろっていれば確認なしでも有料呼び出しは起きない");
    assert.equal(pending.reused, 5);
    assert.equal(calls.length, 5);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("採用は試聴確認・理由・同じ auditionPlanId がそろったときだけ台帳へ書く", async () => {
  const { projectDir, plan } = await auditionReadyProject();
  try {
    const good = { characterId: "hero", winnerLabel: "B", selectionReason: "低くて落ち着いた声が店主らしい", previewConfirmed: true };
    await assert.rejects(
      approveKoyaVoiceAudition({ projectDir, selections: selectionsFor(plan.id, [good]) }),
      /--approved-by is required/u,
    );
    await assert.rejects(
      approveKoyaVoiceAudition({ projectDir, approvedBy: "承認者テスト", selections: selectionsFor(plan.id, [{ ...good, previewConfirmed: false }]) }),
      /previewConfirmed must be true/u,
    );
    await assert.rejects(
      approveKoyaVoiceAudition({ projectDir, approvedBy: "承認者テスト", selections: selectionsFor(plan.id, [{ ...good, selectionReason: "良い" }]) }),
      /selectionReason/u,
    );
    await assert.rejects(
      approveKoyaVoiceAudition({ projectDir, approvedBy: "承認者テスト", selections: selectionsFor("koya-voice-audition-old", [good]) }),
      /not the current audition/u,
    );
    await assert.rejects(
      approveKoyaVoiceAudition({ projectDir, approvedBy: "auto", selections: selectionsFor(plan.id, [good]) }),
      /would not count as a human selection/u,
    );
    const before = JSON.parse(await readFile(join(projectDir, "canvas", "characters.json"), "utf8"));
    assert.equal(before.voices.length, 0, "拒否された採用は台帳に何も書かない");

    const result = await approveKoyaVoiceAudition({ projectDir, approvedBy: "承認者テスト", selections: selectionsFor(plan.id, [good]) });
    assert.equal(result.status, "partially-approved");
    const saved = JSON.parse(await readFile(join(projectDir, "canvas", "characters.json"), "utf8"));
    const hero = saved.characters.find((entry) => entry.id === "hero");
    const profile = saved.voices.find((entry) => entry.id === hero.voiceId);
    const winner = plan.entries[0].candidates.find((entry) => entry.blindLabel === "B");
    assert.equal(profile.provider, "otoshigo");
    assert.equal(profile.providerVoiceId, winner.voiceId);
    assert.equal(profile.modelId, OTOSHIGO.model);
    assert.equal(profile.previewUrl, "");
    assert.deepEqual(profile.labels, {});
    assert.equal(classifyKoyaVoiceCastingRecord(profile.casting).kind, "human-selection");
    assert.equal(profile.casting.auditionCandidateCount, 3);
    assert.equal(profile.casting.selectedCandidateLabel, "B");
    assert.equal(saved.revision, 4);
    const verdicts = JSON.parse(await readFile(koyaVoiceAuditionPaths({ projectDir }).verdictsPath, "utf8"));
    assert.equal(verdicts.verdicts[0].winnerLabel, "B");
    assert.equal(JSON.stringify(verdicts).includes(winner.voiceId), false, "verdicts は対応表を開く前の記録なので声IDを持たない");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("聴いた試聴音が差し替わっていたら採用しない", async () => {
  const { projectDir, plan } = await auditionReadyProject();
  try {
    const paths = koyaVoiceAuditionPaths({ projectDir });
    await writeFile(join(paths.rootDir, "previews", "koya-global", "hero", "C.wav"), Buffer.from("different"));
    await assert.rejects(
      approveKoyaVoiceAudition({
        projectDir,
        approvedBy: "承認者テスト",
        selections: selectionsFor(plan.id, [{ characterId: "hero", winnerLabel: "A", selectionReason: "一番自然に聞こえた", previewConfirmed: true }]),
      }),
      /candidate C changed/u,
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("別の人物に同じ声は採用できない", async () => {
  const { projectDir, plan } = await auditionReadyProject();
  try {
    const heroWinner = plan.entries[0].candidates[0];
    const saved = JSON.parse(await readFile(join(projectDir, "canvas", "characters.json"), "utf8"));
    saved.voices.push({ id: "rival-old", provider: "otoshigo", providerVoiceId: heroWinner.voiceId, modelId: OTOSHIGO.model });
    saved.characters.find((entry) => entry.id === "rival").voiceId = "rival-old";
    await writeFile(join(projectDir, "canvas", "characters.json"), JSON.stringify(saved));
    await assert.rejects(
      approveKoyaVoiceAudition({
        projectDir,
        approvedBy: "承認者テスト",
        selections: selectionsFor(plan.id, [{ characterId: "hero", winnerLabel: heroWinner.blindLabel, selectionReason: "一番自然に聞こえた", previewConfirmed: true }]),
      }),
      /already the voice of rival/u,
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("既定の試聴は契約の adapter で「1声×1行」の voice.dialogue を仲介へ出す", async () => {
  const plan = createKoyaVoiceAuditionPlan({ candidates: candidates(), registry: registry(), dialogueAdapter: OTOSHIGO });
  let submitted = null;
  const render = createKoyaVoiceAuditionPreviewRenderer({
    mediaJobBroker: {
      start: async (spec) => {
        submitted = spec;
        return {
          ...OTOSHIGO,
          kind: "voice.dialogue",
          jobId: "job-1",
          requestKey: spec.requestKey,
          status: "completed",
          usage: { units: 13 },
          result: {
            outputFormat: "wav_48000",
            voiceSegments: [{ dialogue_input_index: 0, start_time_seconds: 0, end_time_seconds: 1.2 }],
          },
        };
      },
    },
    artifactReader: async () => Buffer.from("RIFF-preview"),
  });
  const entry = plan.entries[0];
  const result = await render({ plan, entry, candidate: entry.candidates[1] });
  assert.equal(result.audioBuffer.toString(), "RIFF-preview");
  assert.equal(submitted.kind, "voice.dialogue");
  assert.equal(submitted.provider, "otoshigo");
  assert.equal(submitted.model, OTOSHIGO.model);
  assert.deepEqual(submitted.input.inputs, [{ text: entry.sampleLine, voice_id: entry.candidates[1].voiceId }]);
  assert.equal(submitted.input.model_id, OTOSHIGO.model);
  assert.match(submitted.requestKey, new RegExp(`^koya-voice-audition:${entry.candidateSetId}:B:`, "u"));
});

test("雛形は台帳の人物名と空欄だけを書き、知らない人物では止まる", () => {
  const template = createKoyaVoiceAuditionCandidatesTemplate({ registry: registry(), characterIds: "hero,rival", dialogueAdapter: OTOSHIGO });
  assert.equal(template.version, KOYA_VOICE_AUDITION_CANDIDATES_VERSION);
  assert.deepEqual(template.entries.map((entry) => [entry.characterId, entry.characterName, entry.sampleLine, entry.candidates.length]), [
    ["hero", "主人公テスト", "", 0],
    ["rival", "相手役テスト", "", 0],
  ]);
  assert.throws(() => createKoyaVoiceAuditionCandidatesTemplate({ registry: registry(), characterIds: "ghost" }), /not in the character registry/u);
});

function manifestFor(voiceProfileId, voiceId) {
  return {
    utterances: [{ id: "cut-01-u01", speakerId: "hero", speakerName: "主人公テスト", text: "よし。", voiceProfileId, voiceId }],
  };
}

function humanCasting() {
  return {
    selectionVersion: 2,
    selectedCandidateLabel: "A",
    selectionReason: "落ち着いた低い声",
    approvedBy: "承認者テスト",
    previewConfirmed: true,
    candidateSetId: "voice-set-1",
    auditionCandidateCount: 2,
    selectedAt: "2026-09-24T00:00:00.000Z",
  };
}

test("契約と違う提供元の声は音声ゲートが止め、オトシゴなら Koya の voice-audition を案内する", () => {
  const eleven = {
    ...registry(),
    characters: registry().characters.map((entry) => (entry.id === "hero" ? { ...entry, voiceId: "hero-eleven" } : entry)),
    voices: [{ id: "hero-eleven", provider: "elevenlabs", providerVoiceId: "EL123", modelId: "eleven_v3", casting: humanCasting() }],
  };
  const manifest = manifestFor("hero-eleven", "EL123");
  assert.equal(auditKoyaVoiceSelections({ manifest, registry: eleven }).pass, true, "adapter を渡さない呼び出しは従来どおり");
  assert.equal(auditKoyaVoiceSelections({ manifest, registry: eleven, dialogueAdapter: DEFAULT_KOYA_DIALOGUE_ADAPTER }).pass, true);
  const audit = auditKoyaVoiceSelections({ manifest, registry: eleven, dialogueAdapter: OTOSHIGO });
  assert.equal(audit.pass, false);
  assert.match(audit.speakers[0].failures.join("\n"), /is a elevenlabs voice, but the contract speaks with otoshigo/u);
  const message = formatKoyaVoiceSelectionError(audit, { dialogueAdapter: OTOSHIGO, projectDir: "/work/project" });
  assert.match(message, /node scripts\/koya-manga-video\.mjs voice-audition --project-dir \/work\/project --episode-id global --character-ids hero --candidates-path canvas\/voice-casting\/global-koya-candidates\.json/u);
  assert.match(message, /voice-approve --project-dir \/work\/project --episode-id global --selections-path canvas\/voice-casting\/global-koya-selections\.json --approved-by/u);
  assert.equal(message.includes("build-manga-video.mjs"), false);
  const elevenMessage = formatKoyaVoiceSelectionError(
    auditKoyaVoiceSelections({ manifest: manifestFor("", ""), registry: registry() }),
    { dialogueAdapter: DEFAULT_KOYA_DIALOGUE_ADAPTER },
  );
  assert.match(elevenMessage, /build-manga-video\.mjs voice-library-audition/u, "ElevenLabs の契約では従来の Voice Library の案内のまま");
});
