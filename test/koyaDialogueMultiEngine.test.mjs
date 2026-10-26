// 1話の中で人物ごとに声の提供元（ElevenLabs・オトシゴ・Gemini）を選ぶ。確かめるのは:
//   1. 追加の提供元は話の上書き（audio.additionalDialogueAdapters）でだけ足せ、基の契約と
//      1話1提供元の話の計画・要求・テイク名は1バイトも変わらない
//   2. 提供元の混ざるカットは、同じ提供元の続く行ごと（Gemini は1行ごと）に有料 Job を出し、
//      台詞の順に並べた1本の合成テイクにして、採点・切り分け・受領をそのまま通す
//   3. 人選の関門・匿名の人選・doctor・仲介の行き先が、契約に書いた提供元だけを通す
// 有料の呼び出しはしない（仲介は偽物、音は合成のサイン波）。声の名前・ID はすべて試験用の値。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  alignmentSpeechSpan,
  buildKoyaDialogueRequest,
  generateKoyaDialogueSpeech,
  koyaDialogueCutNeedsCompositeTake,
  koyaDialogueJobGroups,
  koyaDialogueVoiceEngines,
  koyaTakeMediaJobReceipts,
  mergeKoyaCompositeTakeTimeline,
  prepareKoyaDialogueCut,
  requestKoyaDialogueMediaJob,
} from "../lib/koyaDialogueSpeech.mjs";
import {
  DEFAULT_KOYA_DIALOGUE_ADAPTER,
  KOYA_DIALOGUE_ADAPTERS,
  resolveKoyaDialogueAdapters,
  resolveKoyaMangaProductionContract,
  validateKoyaMangaProductionContract,
} from "../lib/koyaMangaProductionContract.mjs";
import { assertKoyaDoctorMeasuredContractAdapter } from "../lib/koyaMangaProduction.mjs";
import {
  KOYA_VOICE_AUDITION_CANDIDATES_VERSION,
  approveKoyaVoiceAudition,
  createKoyaVoiceAuditionPlan,
  createKoyaVoiceAuditionPreviewRenderer,
  writeKoyaVoiceAuditionPlan,
} from "../lib/koyaVoiceAudition.mjs";
import { auditKoyaVoiceSelections, classifyKoyaVoiceCastingRecord, formatKoyaVoiceSelectionError } from "../lib/koyaVoiceSelectionGuard.mjs";
import { resolvePaidMediaJobProviderRoute } from "../lib/paidMediaJobBroker.mjs";
import { legacyKoyaContract } from "./helpers/koyaAssetQualityFixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const ELEVEN = DEFAULT_KOYA_DIALOGUE_ADAPTER;
const OTOSHIGO = KOYA_DIALOGUE_ADAPTERS.find((entry) => entry.provider === "otoshigo");
const GEMINI = KOYA_DIALOGUE_ADAPTERS.find((entry) => entry.provider === "gemini");
const STYLE = "Say it curtly, in a low and slightly bored voice";

function humanCasting(label = "A") {
  return {
    selectionVersion: 2,
    selectedCandidateLabel: label,
    selectionReason: "試験の人が聴いて選んだ",
    approvedBy: "試験の承認者",
    previewConfirmed: true,
    candidateSetId: "voice-set-fixture",
    auditionCandidateCount: 2,
    selectedAt: "2026-10-26T00:00:00.000Z",
  };
}

function registry() {
  return {
    version: 1,
    revision: 1,
    characters: [
      { id: "hero", name: "主人公テスト", kind: "character", status: "approved", voiceId: "koya-hero-elevenlabs" },
      { id: "rival", name: "相手役テスト", kind: "character", status: "approved", voiceId: "koya-rival-gemini" },
      { id: "guest", name: "客テスト", kind: "character", status: "approved", voiceId: "koya-guest-otoshigo" },
    ],
    voices: [
      { id: "koya-hero-elevenlabs", provider: "elevenlabs", providerVoiceId: "fixture-eleven-hero", modelId: "eleven_v3", casting: humanCasting("A") },
      { id: "koya-rival-gemini", provider: "gemini", providerVoiceId: "Achird", modelId: GEMINI.model, styleInstruction: STYLE, casting: humanCasting("B") },
      { id: "koya-guest-otoshigo", provider: "otoshigo", providerVoiceId: "vc_fixture_guest", modelId: OTOSHIGO.model, casting: humanCasting("A") },
    ],
  };
}

function mixedContract(base, additional = [
  { provider: "gemini", model: GEMINI.model },
  { provider: "otoshigo", model: OTOSHIGO.model },
]) {
  const contract = structuredClone(base);
  contract.audio.additionalDialogueAdapters = additional;
  return contract;
}

const speakerVoice = {
  hero: { voiceProfileId: "koya-hero-elevenlabs", voiceId: "fixture-eleven-hero" },
  rival: { voiceProfileId: "koya-rival-gemini", voiceId: "Achird" },
  guest: { voiceProfileId: "koya-guest-otoshigo", voiceId: "vc_fixture_guest" },
};

function line(id, speakerId, text) {
  return { id, cutId: id.slice(0, 6), speakerId, speakerName: speakerId, text, preset: "dialogue", ...speakerVoice[speakerId] };
}

function mixedManifest() {
  return {
    id: "synthetic-mixed",
    utterances: [
      line("cut-01-u01", "hero", "おはよう。"),
      line("cut-01-u02", "hero", "今日も頑張ろう。"),
      line("cut-01-u03", "rival", "勝手にしろ。"),
      line("cut-01-u04", "rival", "知らないよ。"),
      line("cut-01-u05", "guest", "いらっしゃい。"),
      line("cut-02-u01", "hero", "行ってきます。"),
    ],
    cuts: [
      { id: "cut-01", utteranceIds: ["cut-01-u01", "cut-01-u02", "cut-01-u03", "cut-01-u04", "cut-01-u05"] },
      { id: "cut-02", utteranceIds: ["cut-02-u01"] },
    ],
    production: {},
  };
}

/** 16bit モノラルの WAV。台詞ごとに 0.15 秒の無音 + 0.6 秒の音 + 0.15 秒の無音。 */
function syntheticDialogueWav(lineCount, sampleRate, frequency) {
  const perLine = Math.round(0.9 * sampleRate);
  const samples = new Int16Array(perLine * lineCount);
  for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
    const tone = frequency + lineIndex * 40;
    for (let index = Math.round(0.15 * sampleRate); index < Math.round(0.75 * sampleRate); index += 1) {
      samples[lineIndex * perLine + index] = Math.round(Math.sin(2 * Math.PI * tone * index / sampleRate) * 9000);
    }
  }
  const data = Buffer.from(samples.buffer);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** 提供元ごとの偽の仲介。受けた Job を覚え、完了した Job と合成の音を返す。 */
function fakeBrokers() {
  const starts = [];
  const audioByJobId = new Map();
  const rates = { elevenlabs: [44_100, "wav_44100", 330], gemini: [24_000, "wav_24000", 520], otoshigo: [48_000, "wav_48000", 700] };
  const make = (provider) => ({
    start: async (spec) => {
      starts.push(structuredClone(spec));
      const [sampleRate, outputFormat, frequency] = rates[provider];
      const lineCount = spec.input.inputs.length;
      const audio = syntheticDialogueWav(lineCount, sampleRate, frequency);
      const jobId = `job-${provider}-${starts.length}`;
      audioByJobId.set(jobId, audio);
      return {
        jobId,
        providerJobId: `${provider}-provider-${starts.length}`,
        requestKey: spec.requestKey,
        inputHash: sha256(JSON.stringify(spec.input)),
        kind: spec.kind,
        provider: spec.provider,
        model: spec.model,
        adapterVersion: spec.adapterVersion,
        voiceId: spec.voiceId,
        status: "completed",
        reservation: { reservationId: `reservation-${starts.length}`, status: "committed" },
        usage: { units: 10, cost: 1, currency: "BuzzAssistCredits" },
        result: {
          artifact: { url: "https://artifacts.invalid/take.wav", sha256: sha256(audio), mimeType: "audio/wav", bytes: audio.length },
          outputFormat,
          requestId: `request-${starts.length}`,
          voiceSegments: spec.input.inputs.map((entry, index) => ({
            voice_id: entry.voice_id,
            dialogue_input_index: index,
            start_time_seconds: index * 0.9 + 0.15,
            end_time_seconds: index * 0.9 + 0.75,
            character_start_index: 0,
            character_end_index: 0,
          })),
          alignment: null,
        },
      };
    },
  });
  return {
    starts,
    brokers: { elevenlabs: make("elevenlabs"), gemini: make("gemini"), otoshigo: make("otoshigo") },
    artifactReader: async (job) => audioByJobId.get(job.jobId),
  };
}

test("契約: 追加の提供元は話の上書きでだけ足せ、基の契約の digest と1提供元の解決は変わらない", async (t) => {
  const base = await resolveKoyaMangaProductionContract({ projectDir: root });
  assert.equal(Object.hasOwn(base.contract.audio, "additionalDialogueAdapters"), false, "基の契約には書かない");
  assert.deepEqual(resolveKoyaDialogueAdapters(base), [ELEVEN]);

  const dir = await mkdtemp(join(tmpdir(), "koya-multi-engine-override-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const overridePath = join(dir, "synthetic-mixed.json");
  const writeOverride = (audio) => writeFile(overridePath, JSON.stringify({
    episodeId: "synthetic-mixed",
    contractVersion: base.contract.version,
    override: { audio },
  }));
  await writeOverride({ additionalDialogueAdapters: [{ provider: "gemini", model: GEMINI.model }, { provider: "otoshigo", model: OTOSHIGO.model }] });
  const mixed = await resolveKoyaMangaProductionContract({ projectDir: root, episodeId: "synthetic-mixed", overridePath });
  assert.deepEqual(resolveKoyaDialogueAdapters(mixed), [ELEVEN, GEMINI, OTOSHIGO]);
  assert.notEqual(mixed.digest, base.digest);

  await writeOverride({ additionalDialogueAdapters: [{ provider: "elevenlabs", model: "eleven_v3" }] });
  await assert.rejects(
    resolveKoyaMangaProductionContract({ projectDir: root, episodeId: "synthetic-mixed", overridePath }),
    /repeats provider elevenlabs/u,
    "主と同じ提供元を重ねない",
  );
  await writeOverride({ additionalDialogueAdapters: [{ provider: "otoshigo", model: "irodori-tts-v4.1-large" }] });
  await assert.rejects(
    resolveKoyaMangaProductionContract({ projectDir: root, episodeId: "synthetic-mixed", overridePath }),
    /Invalid Koya contract/u,
    "一覧に無い型番（large）は通さない",
  );
  await writeOverride({ dialogueEngines: [] });
  await assert.rejects(
    resolveKoyaMangaProductionContract({ projectDir: root, episodeId: "synthetic-mixed", overridePath }),
    /Unknown contract override key: contract\.audio\.dialogueEngines/u,
    "ほかの未知の欄は今までどおり止める",
  );

  const geminiPrimary = structuredClone(base.contract);
  Object.assign(geminiPrimary.audio, { provider: "gemini", model: GEMINI.model });
  assert.equal(validateKoyaMangaProductionContract(geminiPrimary).pass, true, "Gemini を主の提供元にもできる");
});

test("1提供元の話では声の提供元の表は作らず、計画・要求本文は従来と同じ", async () => {
  const base = await resolveKoyaMangaProductionContract({ projectDir: root });
  assert.equal(koyaDialogueVoiceEngines({ registry: registry(), contract: base }), null, "契約に無い提供元の声は表に入れない");
  const otoshigoOnly = structuredClone(base.contract);
  Object.assign(otoshigoOnly.audio, { provider: "otoshigo", model: OTOSHIGO.model });
  assert.equal(koyaDialogueVoiceEngines({ registry: registry(), contract: otoshigoOnly }), null);

  const manifest = mixedManifest();
  for (const adapter of [ELEVEN, OTOSHIGO]) {
    const plain = prepareKoyaDialogueCut(manifest, manifest.cuts[0], { takeCount: 2, dialogueAdapter: adapter });
    const withNull = prepareKoyaDialogueCut(manifest, manifest.cuts[0], { takeCount: 2, dialogueAdapter: adapter, voiceEngines: null });
    assert.deepEqual(withNull, plain);
    assert.equal(plain.inputs.some((entry) => Object.hasOwn(entry, "voiceEngine")), false);
    assert.equal(koyaDialogueJobGroups(plain).length, 1, "1提供元のカットは1 Job のまま");
    assert.equal(koyaDialogueCutNeedsCompositeTake(plain), false);
    assert.deepEqual(buildKoyaDialogueRequest(plain, 1).inputs.map((entry) => Object.keys(entry)), plain.inputs.map(() => ["text", "voice_id"]));
  }
});

test("提供元の混ざるカットは、同じ提供元が続く行（Gemini は1行）ごとの Job に分かれ、行ごとの形で送る", () => {
  const voiceEngines = koyaDialogueVoiceEngines({ registry: registry(), contract: mixedContract({ audio: { provider: "elevenlabs", model: "eleven_v3" } }) });
  assert.deepEqual(Object.keys(voiceEngines).sort(), ["koya-guest-otoshigo", "koya-rival-gemini"]);
  assert.equal(voiceEngines["koya-rival-gemini"].styleInstruction, STYLE);

  const manifest = mixedManifest();
  const plan = prepareKoyaDialogueCut(manifest, manifest.cuts[0], { takeCount: 2, dialogueAdapter: ELEVEN, voiceEngines });
  assert.equal(plan.model, "eleven_v3", "カットの model は契約の台詞の型番のまま");
  assert.equal(Object.hasOwn(plan.inputs[0], "voiceEngine"), false, "主の提供元の行は従来の形");
  assert.match(plan.inputs[0].providerText, /^\[[a-z]+\] /u, "ElevenLabs の行には演技タグ");
  assert.deepEqual(plan.inputs[2].voiceEngine, {
    provider: "gemini", model: GEMINI.model, adapterVersion: GEMINI.adapterVersion, styleInstruction: STYLE,
  });
  assert.equal(plan.inputs[2].performancePrompt, "", "Gemini には演技タグを付けない（話し方は styleInstruction）");
  assert.deepEqual(plan.inputs[2].apiInput, { text: "勝手にしろ。", voice_id: "Achird", style_instruction: STYLE });
  assert.equal(plan.inputs[4].performancePrompt, "", "オトシゴにも付けない");
  assert.deepEqual(plan.inputs[4].apiInput, { text: "いらっしゃい。", voice_id: "vc_fixture_guest" });

  const groups = koyaDialogueJobGroups(plan);
  assert.deepEqual(groups.map((group) => [group.adapter.provider, group.providerInputIndices]), [
    ["elevenlabs", [0, 1]],
    ["gemini", [2]],
    ["gemini", [3]],
    ["otoshigo", [4]],
  ]);
  assert.equal(koyaDialogueCutNeedsCompositeTake(plan, groups), true);

  const geminiOnly = prepareKoyaDialogueCut(manifest, { id: "cut-09", utteranceIds: ["cut-01-u03"] }, { dialogueAdapter: ELEVEN, voiceEngines });
  assert.equal(koyaDialogueCutNeedsCompositeTake(geminiOnly), true, "主以外の提供元だけのカットも、その提供元へ出す");
});

test("合成テイクの時間軸: 区間は台詞の番号と位置へ移り、文字の時刻の無い部分は区間で切る", () => {
  const timeline = mergeKoyaCompositeTakeTimeline([
    {
      partIndex: 0,
      offsetSeconds: 0,
      providerInputIndices: [0, 1],
      alignment: {
        characters: [..."あいうえお"],
        character_start_times_seconds: [0.1, 0.2, 0.3, 1.1, 1.2],
        character_end_times_seconds: [0.2, 0.3, 0.4, 1.2, 1.3],
      },
      voiceSegments: [
        { dialogue_input_index: 0, start_time_seconds: 0.1, end_time_seconds: 0.4, character_start_index: 0, character_end_index: 3 },
        { dialogue_input_index: 1, start_time_seconds: 1.1, end_time_seconds: 1.3, character_start_index: 3, character_end_index: 5 },
      ],
    },
    {
      partIndex: 1,
      offsetSeconds: 1.6,
      providerInputIndices: [2],
      alignment: null,
      voiceSegments: [{ dialogue_input_index: 0, start_time_seconds: 0, end_time_seconds: 0.8, character_start_index: 0, character_end_index: 4 }],
    },
  ]);
  assert.deepEqual(timeline.voiceSegments.map((segment) => [
    segment.dialogue_input_index, segment.start_time_seconds, segment.end_time_seconds, segment.character_start_index, segment.character_end_index,
  ]), [
    [0, 0.1, 0.4, 0, 3],
    [1, 1.1, 1.3, 3, 5],
    [2, 1.6, 2.4, 5, 5],
  ]);
  const cutPlan = {
    inputs: [
      { speechText: "あいう", providerInputIndices: [0] },
      { speechText: "えお", providerInputIndices: [1] },
      { speechText: "かきくけ", providerInputIndices: [2] },
    ],
  };
  const metadata = { ...timeline };
  assert.deepEqual(alignmentSpeechSpan(metadata, cutPlan, 0), { startSeconds: 0.1, endSeconds: 0.4 });
  assert.deepEqual(alignmentSpeechSpan(metadata, cutPlan, 1), { startSeconds: 1.1, endSeconds: 1.3 });
  assert.equal(alignmentSpeechSpan(metadata, cutPlan, 2), null, "Gemini の行は区間（provider-segment）で切る");
  assert.throws(() => mergeKoyaCompositeTakeTimeline([
    { partIndex: 0, offsetSeconds: 0, providerInputIndices: [0], voiceSegments: [{ dialogue_input_index: 3, start_time_seconds: 0, end_time_seconds: 1 }] },
  ]), /unknown line/u);
  assert.throws(
    () => koyaTakeMediaJobReceipts({ cutId: "cut-01", composite: { parts: [{}, {}] }, mediaJobReceipts: [{}] }),
    /receipt for every part/u,
    "受領の欠けた合成テイクは使わない",
  );
});

test("提供元の混ざる話の音声: 合成テイクを作り、受領・行ごとの記録・テイク名がそろい、作り直しで払い直さない", async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-multi-engine-speech-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const canvasDir = join(projectDir, "canvas");
  const episodeDir = join(canvasDir, "manga-videos", "synthetic-mixed");
  await mkdir(episodeDir, { recursive: true });
  const manifestPath = join(episodeDir, "episode-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(mixedManifest(), null, 2)}\n`);
  const contract = mixedContract(await legacyKoyaContract(root));
  const voiceEngines = koyaDialogueVoiceEngines({ registry: registry(), contract });
  const fake = fakeBrokers();
  const speak = () => generateKoyaDialogueSpeech({
    projectDir,
    canvasDir,
    manifestPath,
    contract,
    takeCount: 2,
    voiceQualityGate: false,
    speechConcurrency: 1,
    voiceEngines,
    mediaJobBrokers: fake.brokers,
    artifactReader: fake.artifactReader,
    fetchImpl: async () => { throw new Error("no direct provider call is expected"); },
  });

  const result = await speak();
  assert.equal(result.report.status, "complete", JSON.stringify(result.report.knownRemainingIssues));
  const byProvider = (provider) => fake.starts.filter((spec) => spec.provider === provider);
  // cut-01: ElevenLabs（2行で1 Job）・Gemini（1行ずつ2 Job）・オトシゴ（1 Job）を2テイク。cut-02 は ElevenLabs 1 Job を2テイク。
  assert.equal(byProvider("elevenlabs").length, 4);
  assert.equal(byProvider("gemini").length, 4);
  assert.equal(byProvider("otoshigo").length, 2);

  for (const spec of byProvider("gemini")) {
    assert.equal(spec.input.inputs.length, 1);
    assert.deepEqual(spec.output.acceptedFormats, ["wav_24000"]);
    assert.equal(spec.input.model_id, GEMINI.model);
    assert.equal(spec.input.inputs[0].voice_id, "Achird");
    assert.equal(spec.input.inputs[0].style_instruction, STYLE);
    assert.equal(Object.hasOwn(spec.input, "settings"), false);
    assert.match(spec.requestKey, /^koya:cut-01:take:[12]:part:[23]:[a-f0-9]{64}$/u);
  }
  const elevenMixed = byProvider("elevenlabs").filter((spec) => spec.requestKey.startsWith("koya:cut-01:"));
  assert.equal(elevenMixed.length, 2);
  for (const spec of elevenMixed) {
    assert.equal(spec.input.inputs.length, 2);
    assert.match(spec.requestKey, /^koya:cut-01:take:[12]:part:1:[a-f0-9]{64}$/u);
    assert.ok(spec.input.settings, "ElevenLabs の設定は従来どおり");
  }
  for (const spec of byProvider("otoshigo")) {
    assert.match(spec.requestKey, /^koya:cut-01:take:[12]:part:4:[a-f0-9]{64}$/u);
    assert.equal(/\[[a-z]+\]/u.test(spec.input.inputs[0].text), false);
  }
  const elevenPlain = byProvider("elevenlabs").filter((spec) => spec.requestKey.startsWith("koya:cut-02:"));
  assert.equal(elevenPlain.length, 2);
  for (const spec of elevenPlain) {
    assert.match(spec.requestKey, /^koya:cut-02:take:[12]:[a-f0-9]{64}$/u, "ElevenLabs だけのカットは従来の requestKey");
  }

  assert.equal(result.report.mediaJobs.length, 10, "テイクごと・部分ごとの受領が全部 RunReceipt へ渡る");
  assert.deepEqual([...new Set(result.report.mediaJobs.map((row) => row.provider))].sort(), ["elevenlabs", "gemini", "otoshigo"]);

  const saved = JSON.parse(await readFile(manifestPath, "utf8"));
  const audioOf = (id) => saved.utterances.find((entry) => entry.id === id).audio;
  assert.equal(audioOf("cut-01-u01").provider, "elevenlabs");
  assert.equal(Object.hasOwn(audioOf("cut-01-u01"), "voiceEngine"), false);
  assert.equal(audioOf("cut-01-u03").provider, "gemini");
  assert.deepEqual(audioOf("cut-01-u03").voiceEngine, {
    provider: "gemini", model: GEMINI.model, adapterVersion: GEMINI.adapterVersion, styleInstruction: STYLE,
  });
  assert.equal(audioOf("cut-01-u05").provider, "otoshigo");
  assert.ok(saved.utterances.every((entry) => entry.model === contract.audio.model), "manifest の model は契約の型番のまま");
  for (const entry of saved.utterances) {
    assert.ok((await stat(entry.audio.filePath)).size > 44, `${entry.id} の音がある`);
    assert.ok(entry.audio.durationSeconds > 0.4 && entry.audio.durationSeconds < 2, `${entry.id} は1行ぶんの長さ`);
  }

  const takePath = audioOf("cut-01-u01").sourceDialoguePath;
  assert.match(takePath, /cut-01-take-[12]-[a-f0-9]{12}-multi-engine-dialogue\.wav$/u);
  assert.match(audioOf("cut-02-u01").sourceDialoguePath, /cut-02-take-[12]-[a-f0-9]{12}-eleven-v3-dialogue\.wav$/u, "1提供元のカットのテイク名は従来どおり");
  const take = JSON.parse(await readFile(`${takePath}.json`, "utf8"));
  assert.equal(take.composite.version, "koya-dialogue-composite-take-v1");
  assert.deepEqual(take.composite.parts.map((part) => part.adapter.provider), ["elevenlabs", "gemini", "gemini", "otoshigo"]);
  assert.equal(take.mediaJobReceipts.length, 4);
  assert.deepEqual(take.voiceSegments.map((segment) => segment.dialogue_input_index), [0, 1, 2, 3, 4]);
  const offsets = take.composite.parts.map((part) => part.offsetSeconds);
  assert.ok(offsets.every((value, index) => index === 0 || value > offsets[index - 1]), "部分は台詞の順に並ぶ");
  assert.ok(Math.abs(take.sourceDurationSeconds - (1.8 + 0.9 * 3 + 0.3 * 3)) < 0.01, "部分の長さと間の無音の合計");

  const before = fake.starts.length;
  const again = await speak();
  assert.equal(again.report.status, "complete");
  assert.equal(fake.starts.length, before, "作り直しは取得済みのテイクと部分を使い、有料の Job を出し直さない");
});

test("提供元ごとの仲介: 専用の住所の Job はその鍵だけで送り、他所の仲介へ共有の鍵や BuzzAssist のログインを送らない", async (t) => {
  assert.deepEqual(resolvePaidMediaJobProviderRoute("otoshigo", {}).dedicated, false, "書いていなければ従来どおり共有の住所");
  const missingKey = resolvePaidMediaJobProviderRoute("otoshigo", {
    BUZZASSIST_MEDIA_JOB_API_BASE_OTOSHIGO: "https://api.otoshigo.invalid/v1/media/jobs",
    BUZZASSIST_MEDIA_JOB_API_KEY: "shared-key-fixture",
  });
  assert.match(missingKey.error, /BUZZASSIST_MEDIA_JOB_API_KEY_OTOSHIGO/u);
  assert.equal(missingKey.apiKey, "", "共有の鍵は流用しない");
  const official = resolvePaidMediaJobProviderRoute("gemini", { BUZZASSIST_MEDIA_JOB_API_BASE_GEMINI: "https://buzzassist.ai/api/media/jobs" });
  assert.equal(official.error, "");
  assert.equal(official.stateSubdir, join("routes", "gemini"));

  const dir = await mkdtemp(join(tmpdir(), "koya-multi-engine-route-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifest = mixedManifest();
  const voiceEngines = koyaDialogueVoiceEngines({ registry: registry(), contract: mixedContract({ audio: { provider: "elevenlabs", model: "eleven_v3" } }) });
  const plan = prepareKoyaDialogueCut(manifest, { id: "cut-05", utteranceIds: ["cut-01-u05"] }, { dialogueAdapter: OTOSHIGO, voiceEngines });
  const urls = [];
  const mediaJobFetch = async (url, options) => {
    urls.push(url);
    const body = JSON.parse(options.body);
    return new Response(JSON.stringify({ job: {
      jobId: `mj_${"a".repeat(24)}`,
      requestKey: body.requestKey,
      inputHash: body.inputHash,
      kind: "voice.dialogue",
      ...OTOSHIGO,
      voiceId: body.voiceId,
      status: "completed",
      result: {
        artifact: { url: "https://api.otoshigo.invalid/v1/files/media/a.wav", sha256: "a".repeat(64), mimeType: "audio/wav", bytes: 64 },
        outputFormat: "wav_48000",
        voiceSegments: [{ dialogue_input_index: 0, start_time_seconds: 0, end_time_seconds: 1 }],
      },
    } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await requestKoyaDialogueMediaJob(plan, 0, {
    sourceDir: dir,
    mediaJobEnv: {
      BUZZASSIST_MEDIA_JOB_API_BASE_OTOSHIGO: "https://api.otoshigo.invalid/v1/media/jobs",
      BUZZASSIST_MEDIA_JOB_API_KEY_OTOSHIGO: "otoshigo-key-fixture",
    },
    mediaJobFetch,
    artifactReader: async () => Buffer.from("RIFF-otoshigo"),
    sleepFn: async () => {},
  });
  assert.equal(result.job.status, "completed");
  assert.ok(urls.length > 0 && urls.every((url) => String(url).startsWith("https://api.otoshigo.invalid/v1/media/jobs")));
  assert.ok((await stat(join(dir, "paid-media-jobs", "routes", "otoshigo", "jobs"))).isDirectory(), "journal は提供元ごとの置き場");

  await assert.rejects(requestKoyaDialogueMediaJob(plan, 1, {
    sourceDir: dir,
    mediaJobEnv: { BUZZASSIST_MEDIA_JOB_API_BASE_OTOSHIGO: "https://api.otoshigo.invalid/v1/media/jobs" },
    mediaJobFetch: async () => { throw new Error("must not be called"); },
  }), /BUZZASSIST_MEDIA_JOB_API_KEY_OTOSHIGO/u, "鍵が無ければ何も送らずに止まる");
});

test("人選の関門: 契約に書いた提供元・型番の声だけを通し、1提供元の話の止め方は変えない", () => {
  const manifest = mixedManifest();
  const audit = (options) => auditKoyaVoiceSelections({ manifest, registry: registry(), ...options });
  const single = audit({ dialogueAdapter: ELEVEN });
  assert.equal(single.pass, false);
  const rival = single.speakers.find((entry) => entry.speakerId === "rival");
  assert.match(rival.failures.join("\n"), /is a gemini voice, but the contract speaks with elevenlabs/u, "従来の文言のまま止める");

  const mixed = audit({ dialogueAdapter: ELEVEN, dialogueAdapters: [ELEVEN, GEMINI, OTOSHIGO] });
  assert.equal(mixed.pass, true, JSON.stringify(mixed.speakers.map((entry) => entry.failures)));

  const geminiOnly = audit({ dialogueAdapter: ELEVEN, dialogueAdapters: [ELEVEN, GEMINI] });
  assert.equal(geminiOnly.pass, false);
  const guest = geminiOnly.speakers.find((entry) => entry.speakerId === "guest");
  assert.match(guest.failures.join("\n"), /otoshigo\/irodori-tts-v4\.1-small voice, but this episode speaks only with elevenlabs, gemini\/gemini-3\.8-flash-tts/u);
  const message = formatKoyaVoiceSelectionError(geminiOnly, { dialogueAdapter: ELEVEN, dialogueAdapters: [ELEVEN, GEMINI] });
  assert.match(message, /koya-manga-video\.mjs voice-audition/u, "提供元を混ぜる話は Koya の人選へ案内する");

  const wrongModel = registry();
  wrongModel.voices.find((voice) => voice.provider === "gemini").modelId = "gemini-other-tts";
  const wrong = auditKoyaVoiceSelections({ manifest, registry: wrongModel, dialogueAdapter: ELEVEN, dialogueAdapters: [ELEVEN, GEMINI, OTOSHIGO] });
  assert.equal(wrong.speakers.find((entry) => entry.speakerId === "rival").pass, false, "型番が違えば通さない");
});

test("匿名の人選: 候補ごとに提供元と話し方を選べ、聴く頁には出さず、採用した声の profile に残す", async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-multi-engine-audition-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await mkdir(join(projectDir, "canvas"), { recursive: true });
  const people = {
    version: 1,
    revision: 1,
    characters: [{ id: "rival", name: "相手役テスト", kind: "character", role: "fixed", status: "approved" }],
    voices: [],
  };
  await writeFile(join(projectDir, "canvas", "characters.json"), `${JSON.stringify(people, null, 2)}\n`);
  const candidates = {
    version: KOYA_VOICE_AUDITION_CANDIDATES_VERSION,
    episodeId: "global",
    entries: [{
      characterId: "rival",
      sampleLine: "勝手にしろ。",
      candidates: [
        { voiceId: "fixture-eleven-rival" },
        { provider: "gemini", model: GEMINI.model, voiceId: "Achird", styleInstruction: STYLE },
        { provider: "gemini", model: GEMINI.model, voiceId: "Achird", styleInstruction: "Say it warmly" },
        { provider: "gemini", model: GEMINI.model, voiceId: "Laomedeia" },
      ],
    }],
  };
  const plan = createKoyaVoiceAuditionPlan({ candidates, registry: people, dialogueAdapter: ELEVEN });
  const entry = plan.entries[0];
  assert.equal(entry.candidates.length, 4, "同じ声でも話し方が違えば別の候補");
  const styled = entry.candidates.find((candidate) => candidate.styleInstruction === STYLE);
  assert.deepEqual(styled.adapter, { provider: "gemini", model: GEMINI.model, adapterVersion: GEMINI.adapterVersion });
  assert.equal(Object.hasOwn(entry.candidates.find((candidate) => candidate.voiceId === "fixture-eleven-rival"), "adapter"), false);

  const bad = structuredClone(candidates);
  bad.entries[0].candidates[0] = { provider: "otoshigo", model: "irodori-tts-v4.1-large", voiceId: "vc_x" };
  assert.throws(() => createKoyaVoiceAuditionPlan({ candidates: bad, registry: people, dialogueAdapter: ELEVEN }), /not an allowed voice\.dialogue adapter/u);
  const styleOnEleven = structuredClone(candidates);
  styleOnEleven.entries[0].candidates[0].styleInstruction = "calm";
  assert.throws(() => createKoyaVoiceAuditionPlan({ candidates: styleOnEleven, registry: people, dialogueAdapter: ELEVEN }), /does not take a styleInstruction/u);
  const tagged = structuredClone(candidates);
  tagged.entries[0].sampleLine = "[angry] 勝手にしろ。";
  assert.throws(() => createKoyaVoiceAuditionPlan({ candidates: tagged, registry: people, dialogueAdapter: ELEVEN }), /gemini does not take performance tags/u);

  // 試聴: Gemini の候補は Gemini の Job（話し方の指示つき1行）で作る。
  const submitted = [];
  const renderer = createKoyaVoiceAuditionPreviewRenderer({
    mediaJobBroker: {
      start: async (spec) => {
        submitted.push(spec);
        return {
          ...(spec.provider === "gemini" ? GEMINI : ELEVEN),
          kind: "voice.dialogue",
          jobId: `job-${submitted.length}`,
          requestKey: spec.requestKey,
          status: "completed",
          usage: { units: 6 },
          result: { outputFormat: "wav_24000", voiceSegments: [{ dialogue_input_index: 0, start_time_seconds: 0, end_time_seconds: 1 }] },
        };
      },
    },
    artifactReader: async () => Buffer.from(`RIFF-preview-${submitted.length}`),
  });
  await renderer({ plan, entry, candidate: styled });
  assert.equal(submitted[0].provider, "gemini");
  assert.deepEqual(submitted[0].input.inputs, [{ text: "勝手にしろ。", voice_id: "Achird", style_instruction: STYLE }]);
  assert.deepEqual(submitted[0].output.acceptedFormats, ["wav_24000"]);

  const written = await writeKoyaVoiceAuditionPlan({
    projectDir,
    plan,
    confirmPaidPreview: true,
    renderPreview: async ({ candidate }) => ({ audioBuffer: Buffer.from(`RIFF-${candidate.voiceId}-${candidate.styleInstruction || ""}`), extension: "wav" }),
  });
  const publicText = JSON.stringify(written.plan) + await readFile(written.htmlPath, "utf8");
  for (const hidden of ["Achird", "Laomedeia", "gemini", STYLE, "fixture-eleven-rival"]) {
    assert.equal(publicText.includes(hidden), false, `聴く頁と公開の計画に ${hidden} を出さない`);
  }
  const result = await approveKoyaVoiceAudition({
    projectDir,
    approvedBy: "試験の承認者",
    selections: {
      auditionPlanId: plan.id,
      selections: [{ characterId: "rival", winnerLabel: styled.blindLabel, selectionReason: "低く気だるい話し方が役に合う", previewConfirmed: true }],
    },
  });
  assert.deepEqual(result.approvals.map((row) => [row.provider, row.model]), [["gemini", GEMINI.model]]);
  const saved = JSON.parse(await readFile(join(projectDir, "canvas", "characters.json"), "utf8"));
  const profile = saved.voices.find((voice) => voice.id === saved.characters[0].voiceId);
  assert.equal(profile.id, "koya-rival-gemini");
  assert.equal(profile.provider, "gemini");
  assert.equal(profile.providerVoiceId, "Achird");
  assert.equal(profile.modelId, GEMINI.model);
  assert.equal(profile.styleInstruction, STYLE);
  assert.equal(classifyKoyaVoiceCastingRecord(profile.casting).kind, "human-selection");
});

test("doctor: 契約が人物ごとに使う提供元を全部非課金で測り、本番は測っていない提供元に入らない", async () => {
  const { runHarnessDoctor } = await import("../scripts/harness-doctor.mjs");
  const probed = [];
  const run = (unavailable = "") => runHarnessDoctor({
    projectDir: root,
    harnessId: "koya-manga-video",
    runtime: {
      koyaDialogueAdapters: [ELEVEN, GEMINI],
      diskFreeBytes: async () => 64 * 1024 ** 3,
      resolveProductionRoute: async () => ({ command: "fixture-node", args: ["koya-manga-video.mjs", "help"], cwd: root, label: "scripts/koya-manga-video.mjs", mcpTool: "run_video_harness" }),
      mediaAdapterProbe: async (spec) => {
        probed.push(spec);
        return spec.provider === unavailable
          ? { ok: false, status: "unavailable", ...spec, detail: "fixture unavailable" }
          : { ok: true, status: "ready", ...spec };
      },
    },
  });
  const ready = (await run()).checks.find((check) => check.id === "tts-key");
  assert.equal(ready.ok, true);
  assert.equal(ready.provider, "elevenlabs", "主の提供元は従来の欄のまま");
  assert.deepEqual(ready.additionalAdapters.map((entry) => [entry.provider, entry.status]), [["gemini", "ready"]]);
  assert.ok(probed.some((spec) => spec.provider === "gemini" && spec.kind === "voice.dialogue"));
  const blocked = (await run("gemini")).checks.find((check) => check.id === "tts-key");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, "unavailable");

  const contract = mixedContract((await resolveKoyaMangaProductionContract({ projectDir: root })).contract, [{ provider: "gemini", model: GEMINI.model }]);
  const primaryOnly = { doctor: { ttsAdapter: { ...ELEVEN, status: "ready" } } };
  assert.throws(() => assertKoyaDoctorMeasuredContractAdapter(primaryOnly, { contract }), /also speaks with gemini/u);
  const both = { doctor: { ttsAdapter: { ...ELEVEN, status: "ready" }, ttsAdditionalAdapters: [{ ...GEMINI, status: "ready" }] } };
  assert.deepEqual(assertKoyaDoctorMeasuredContractAdapter(both, { contract }), ELEVEN);
  const base = (await resolveKoyaMangaProductionContract({ projectDir: root })).contract;
  assert.deepEqual(assertKoyaDoctorMeasuredContractAdapter(primaryOnly, { contract: base }), ELEVEN, "1提供元の話は従来どおり");
});
