// ElevenLabs の台詞を声ごとに eleven_v3 / eleven_v4 で作り分ける。確かめるのは:
//   1. 契約の主は v3 のまま、話の上書き（audio.additionalDialogueAdapters）に v4 を足せる。
//      v4 を主にもできる。同じ提供元・型番は重ねられない
//   2. v4 は声の profile の型番（voices[].modelId）で選ばれ、v4 の行は別の Job で
//      model_id: eleven_v4・ElevenLabs の設定（stability・演技タグ・文字正規化）のまま送る
//   3. v3 だけの話の計画・要求本文・テイク名は従来のまま
//   4. v4 を契約に書かずに v4 の声を選んだ話は、人選の関門が有料の前に止める
// 有料の呼び出しはしない（仲介は偽物、音は合成のサイン波）。声の名前・ID はすべて試験用の値。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildKoyaDialogueRequest,
  generateKoyaDialogueSpeech,
  koyaDialogueCutNeedsCompositeTake,
  koyaDialogueJobGroups,
  koyaDialogueVoiceEngines,
  prepareKoyaDialogueCut,
} from "../lib/koyaDialogueSpeech.mjs";
import {
  DEFAULT_KOYA_DIALOGUE_ADAPTER,
  KOYA_DIALOGUE_ADAPTERS,
  isElevenLabsDialogueAdapter,
  resolveKoyaDialogueAdapter,
  resolveKoyaDialogueAdapters,
  resolveKoyaMangaProductionContract,
  validateKoyaMangaProductionContract,
} from "../lib/koyaMangaProductionContract.mjs";
import { auditKoyaVoiceSelections } from "../lib/koyaVoiceSelectionGuard.mjs";
import { legacyKoyaContract } from "./helpers/koyaAssetQualityFixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const V3 = DEFAULT_KOYA_DIALOGUE_ADAPTER;
const V4 = KOYA_DIALOGUE_ADAPTERS.find((entry) => entry.provider === "elevenlabs" && entry.model === "eleven_v4");

function humanCasting(label = "A") {
  return {
    selectionVersion: 2,
    selectedCandidateLabel: label,
    selectionReason: "試験の人が聴いて選んだ",
    approvedBy: "試験の承認者",
    previewConfirmed: true,
    candidateSetId: "voice-set-fixture",
    auditionCandidateCount: 2,
    selectedAt: "2026-10-28T00:00:00.000Z",
  };
}

function registry() {
  return {
    version: 1,
    revision: 1,
    characters: [
      { id: "lead", name: "主役テスト", kind: "character", status: "approved", voiceId: "koya-lead-elevenlabs" },
      { id: "friend", name: "友人テスト", kind: "character", status: "approved", voiceId: "koya-friend-elevenlabs" },
    ],
    voices: [
      { id: "koya-lead-elevenlabs", provider: "elevenlabs", providerVoiceId: "fixture-eleven-lead", modelId: "eleven_v3", casting: humanCasting("A") },
      { id: "koya-friend-elevenlabs", provider: "elevenlabs", providerVoiceId: "fixture-eleven-friend", modelId: "eleven_v4", casting: humanCasting("B") },
    ],
  };
}

const speakerVoice = {
  lead: { voiceProfileId: "koya-lead-elevenlabs", voiceId: "fixture-eleven-lead" },
  friend: { voiceProfileId: "koya-friend-elevenlabs", voiceId: "fixture-eleven-friend" },
};

function line(id, speakerId, text) {
  return { id, cutId: id.slice(0, 6), speakerId, speakerName: speakerId, text, preset: "dialogue", ...speakerVoice[speakerId] };
}

function manifest() {
  return {
    id: "synthetic-v4",
    utterances: [
      line("cut-01-u01", "lead", "久しぶりだな。"),
      line("cut-01-u02", "friend", "元気だった？"),
      line("cut-01-u03", "friend", "また会えてうれしい。"),
      line("cut-02-u01", "lead", "乾杯しよう。"),
      line("cut-03-u01", "friend", "うん、乾杯。"),
    ],
    cuts: [
      { id: "cut-01", utteranceIds: ["cut-01-u01", "cut-01-u02", "cut-01-u03"] },
      { id: "cut-02", utteranceIds: ["cut-02-u01"] },
      { id: "cut-03", utteranceIds: ["cut-03-u01"] },
    ],
    production: {},
  };
}

function withV4(base) {
  const contract = structuredClone(base);
  contract.audio.additionalDialogueAdapters = [{ provider: "elevenlabs", model: "eleven_v4" }];
  return contract;
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

/** ElevenLabs の偽の仲介。受けた Job を覚え、完了した Job と合成の音を返す。 */
function fakeElevenBroker() {
  const starts = [];
  const audioByJobId = new Map();
  const broker = {
    start: async (spec) => {
      starts.push(structuredClone(spec));
      const audio = syntheticDialogueWav(spec.input.inputs.length, 44_100, spec.model === "eleven_v4" ? 420 : 330);
      const jobId = `job-elevenlabs-${starts.length}`;
      audioByJobId.set(jobId, audio);
      return {
        jobId,
        providerJobId: `elevenlabs-provider-${starts.length}`,
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
          outputFormat: "wav_44100",
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
  };
  return { starts, brokers: { elevenlabs: broker }, artifactReader: async (job) => audioByJobId.get(job.jobId) };
}

test("契約: v4 は一覧にあり、主を v3 のまま話の上書きで足せ、主にもでき、同じ型番は重ねられない", async (t) => {
  assert.ok(V4, "eleven_v4 は台詞アダプタの一覧にある");
  assert.equal(V4.adapterVersion, "elevenlabs-dialogue-server-v1", "サーバーの v4 と同じ adapter");
  assert.equal(DEFAULT_KOYA_DIALOGUE_ADAPTER.model, "eleven_v3", "既定は v3 のまま");
  assert.equal(isElevenLabsDialogueAdapter(V4), true);

  const base = await resolveKoyaMangaProductionContract({ projectDir: root });
  assert.deepEqual(resolveKoyaDialogueAdapters(base), [V3], "基の契約は v3 だけ");

  const dir = await mkdtemp(join(tmpdir(), "koya-eleven-v4-override-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const overridePath = join(dir, "synthetic-v4.json");
  const writeOverride = (audio) => writeFile(overridePath, JSON.stringify({
    episodeId: "synthetic-v4",
    contractVersion: base.contract.version,
    override: { audio },
  }));
  await writeOverride({ additionalDialogueAdapters: [{ provider: "elevenlabs", model: "eleven_v4" }] });
  const mixed = await resolveKoyaMangaProductionContract({ projectDir: root, episodeId: "synthetic-v4", overridePath });
  assert.deepEqual(resolveKoyaDialogueAdapters(mixed), [V3, V4]);
  assert.notEqual(mixed.digest, base.digest);

  await writeOverride({ additionalDialogueAdapters: [{ provider: "elevenlabs", model: "eleven_v4" }, { provider: "elevenlabs", model: "eleven_v4" }] });
  await assert.rejects(
    resolveKoyaMangaProductionContract({ projectDir: root, episodeId: "synthetic-v4", overridePath }),
    /repeats elevenlabs\/eleven_v4/u,
  );

  const v4Primary = structuredClone(base.contract);
  Object.assign(v4Primary.audio, { model: "eleven_v4" });
  assert.equal(validateKoyaMangaProductionContract(v4Primary).pass, true, "v4 を主にもできる");
  assert.equal(resolveKoyaDialogueAdapter(v4Primary), V4);
});

test("v3 だけの話は声の表を作らず、計画・要求本文は従来のまま", async () => {
  const base = await legacyKoyaContract(root);
  const v3Only = registry();
  v3Only.voices[1].modelId = "eleven_v3";
  assert.equal(koyaDialogueVoiceEngines({ registry: v3Only, contract: withV4(base) }), null, "v4 の声が無ければ表は作らない");

  const plan = prepareKoyaDialogueCut(manifest(), manifest().cuts[0], { takeCount: 2, dialogueAdapter: V3 });
  assert.equal(Object.hasOwn(plan, "adapter"), false, "v3 の計画の形は変えない");
  assert.equal(koyaDialogueJobGroups(plan).length, 1);
  assert.equal(koyaDialogueCutNeedsCompositeTake(plan), false);
  const request = buildKoyaDialogueRequest(plan, 1);
  assert.deepEqual(Object.keys(request), ["inputs", "model_id", "language_code", "settings", "seed", "apply_text_normalization"]);
  assert.equal(request.model_id, "eleven_v3");
  assert.deepEqual(request.settings, { stability: 0.52 });
  assert.equal(request.seed, 440011);
  assert.equal(request.apply_text_normalization, "auto");
});

test("声の型番で v4 を選び、v4 の行は別の Job で ElevenLabs の設定のまま model_id: eleven_v4 で送る", async () => {
  const contract = withV4(await legacyKoyaContract(root));
  const voiceEngines = koyaDialogueVoiceEngines({ registry: registry(), contract });
  assert.deepEqual(voiceEngines, {
    "koya-friend-elevenlabs": { provider: "elevenlabs", model: "eleven_v4", adapterVersion: V4.adapterVersion },
  }, "v3 の声は主のまま、v4 の声だけ表に入る");

  const plan = prepareKoyaDialogueCut(manifest(), manifest().cuts[0], { takeCount: 2, dialogueAdapter: V3, voiceEngines });
  assert.match(plan.inputs[1].providerText, /^\[[a-z]+\] /u, "v4 の行にも演技タグ（ElevenLabs）");
  const groups = koyaDialogueJobGroups(plan);
  assert.deepEqual(groups.map((group) => [group.adapter.model, group.providerInputIndices]), [
    ["eleven_v3", [0]],
    ["eleven_v4", [1, 2]],
  ]);
  assert.equal(koyaDialogueCutNeedsCompositeTake(plan, groups), true);

  const v4Only = prepareKoyaDialogueCut(manifest(), manifest().cuts[2], { takeCount: 2, dialogueAdapter: V3, voiceEngines });
  assert.equal(koyaDialogueCutNeedsCompositeTake(v4Only), true, "v4 だけのカットも v4 で出す");

  const v4Plan = prepareKoyaDialogueCut(manifest(), manifest().cuts[2], { takeCount: 2, dialogueAdapter: V4 });
  const v4Request = buildKoyaDialogueRequest(v4Plan, 0, [{ pronunciation_dictionary_id: "dict-fixture", version_id: "v1" }]);
  assert.equal(v4Request.model_id, "eleven_v4");
  assert.deepEqual(v4Request.settings, { stability: 0.46 });
  assert.equal(v4Request.apply_text_normalization, "auto");
  assert.equal(v4Request.pronunciation_dictionary_locators.length, 1, "発音辞書も v4 で使う");
});

test("v3 と v4 の混ざる話の音声: v4 の Job は v4 として送られ、受領と記録がそろい、作り直しで払い直さない", async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-eleven-v4-speech-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const canvasDir = join(projectDir, "canvas");
  const episodeDir = join(canvasDir, "manga-videos", "synthetic-v4");
  await mkdir(episodeDir, { recursive: true });
  const manifestPath = join(episodeDir, "episode-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest(), null, 2)}\n`);
  const contract = withV4(await legacyKoyaContract(root));
  const voiceEngines = koyaDialogueVoiceEngines({ registry: registry(), contract });
  const fake = fakeElevenBroker();
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
  // cut-01: v3（1行）と v4（2行）の2 Job、cut-02: v3 の1 Job、cut-03: v4 の1 Job。それぞれ2テイク。
  const byModel = (model) => fake.starts.filter((spec) => spec.model === model);
  assert.equal(byModel("eleven_v3").length, 4);
  assert.equal(byModel("eleven_v4").length, 4);
  for (const spec of fake.starts) {
    assert.equal(spec.provider, "elevenlabs");
    assert.equal(spec.adapterVersion, "elevenlabs-dialogue-server-v1");
    assert.equal(spec.input.model_id, spec.model, "要求本文の model_id は Job の型番と同じ");
    assert.deepEqual(spec.output.acceptedFormats, ["wav_44100", "wav_24000"]);
    assert.ok(spec.input.settings, "ElevenLabs の設定はどちらの型番でも送る");
  }
  for (const spec of byModel("eleven_v4")) {
    assert.ok(spec.input.inputs.every((entry) => entry.voice_id === "fixture-eleven-friend"), "v4 の Job には v4 の声だけ");
  }
  const plainV3 = byModel("eleven_v3").filter((spec) => spec.requestKey.startsWith("koya:cut-02:"));
  for (const spec of plainV3) {
    assert.match(spec.requestKey, /^koya:cut-02:take:[12]:[a-f0-9]{64}$/u, "v3 だけのカットは従来の requestKey");
  }
  assert.equal(result.report.mediaJobs.length, 8);
  assert.deepEqual([...new Set(result.report.mediaJobs.map((row) => row.model))].sort(), ["eleven_v3", "eleven_v4"]);

  const saved = JSON.parse(await readFile(manifestPath, "utf8"));
  const audioOf = (id) => saved.utterances.find((entry) => entry.id === id).audio;
  assert.equal(Object.hasOwn(audioOf("cut-01-u01"), "voiceEngine"), false, "v3 の行は従来の形");
  assert.deepEqual(audioOf("cut-01-u02").voiceEngine, { provider: "elevenlabs", model: "eleven_v4", adapterVersion: V4.adapterVersion });
  assert.match(audioOf("cut-02-u01").sourceDialoguePath, /cut-02-take-[12]-[a-f0-9]{12}-eleven-v3-dialogue\.wav$/u, "v3 だけのカットのテイク名は従来どおり");

  const before = fake.starts.length;
  const again = await speak();
  assert.equal(again.report.status, "complete");
  assert.equal(fake.starts.length, before, "作り直しは取得済みのテイクを使い、有料の Job を出し直さない");
});

test("人選の関門: v4 を契約に書かずに v4 の声を選んだ話は止め、書いた話は通す", () => {
  const audit = (options) => auditKoyaVoiceSelections({ manifest: manifest(), registry: registry(), ...options });
  const v3Only = audit({ dialogueAdapter: V3 });
  assert.equal(v3Only.pass, false);
  const friend = v3Only.speakers.find((entry) => entry.speakerId === "friend");
  assert.match(friend.failures.join("\n"), /elevenlabs\/eleven_v4 voice, but this episode speaks elevenlabs only with eleven_v3; add .*audio\.additionalDialogueAdapters/u);
  assert.equal(v3Only.speakers.find((entry) => entry.speakerId === "lead").pass, true, "v3 の声は従来どおり通す");

  const mixed = audit({ dialogueAdapter: V3, dialogueAdapters: [V3, V4] });
  assert.equal(mixed.pass, true, JSON.stringify(mixed.speakers.map((entry) => entry.failures)));

  const legacyModel = registry();
  legacyModel.voices[1].modelId = "eleven_multilingual_v2";
  const legacy = auditKoyaVoiceSelections({ manifest: manifest(), registry: legacyModel, dialogueAdapter: V3 });
  assert.equal(legacy.pass, true, "台詞の一覧に無い古い型番の声は従来どおり主の型番で通す");
});
