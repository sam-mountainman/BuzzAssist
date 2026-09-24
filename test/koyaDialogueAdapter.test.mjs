import assert from "node:assert/strict";
import test from "node:test";

import {
  prepareKoyaDialogueCut,
  buildKoyaDialogueRequest,
  normalizeKoyaDialogueMediaJobReceipt,
  requestKoyaDialogueMediaJob,
} from "../lib/koyaDialogueSpeech.mjs";
import {
  DEFAULT_KOYA_DIALOGUE_ADAPTER,
  KOYA_DIALOGUE_ADAPTERS,
  auditManifestAgainstKoyaContract,
  resolveKoyaDialogueAdapter,
  resolveKoyaMangaProductionContract,
  validateKoyaMangaProductionContract,
} from "../lib/koyaMangaProductionContract.mjs";
import { assertKoyaDoctorMeasuredContractAdapter } from "../lib/koyaMangaProduction.mjs";

// 台詞音声の有料アダプタは契約が決める。以前は ElevenLabs の3値を本番コードに
// 30か所近くリテラルで書いていたので、提供元を変えるたびに全部書き換える必要があった。
// ここで確かめるのは3つ:
//   1. 一覧の外の値は契約でも受けない（任意の文字列で任意の有料アダプタを呼べない）
//   2. オトシゴを指す契約なら、計画・要求・受領・照合がすべてオトシゴの識別子で揃う
//   3. ElevenLabs の要求本文は1バイトも変わらない（承認済み音声の再利用が効き続ける）

const OTOSHIGO = KOYA_DIALOGUE_ADAPTERS.find((entry) => entry.provider === "otoshigo");

function manifest() {
  return {
    utterances: [
      { id: "cut-01-u01", text: "おはよう。", speakerId: "a", voiceId: "designed:0123456789abcdef" },
      { id: "cut-01-u02", text: "おはよう。", speakerId: "b", voiceId: "designed:fedcba9876543210" },
    ],
  };
}
const cut = { id: "cut-01", utteranceIds: ["cut-01-u01", "cut-01-u02"] };

async function contractWithAudio(audio) {
  const resolved = await resolveKoyaMangaProductionContract({ projectDir: process.cwd() });
  const contract = structuredClone(resolved.contract);
  Object.assign(contract.audio, audio);
  return contract;
}

test("契約は一覧にある台詞音声アダプタだけを受け、一覧の外は落とす", async () => {
  const otoshigo = await contractWithAudio({ provider: "otoshigo", model: "irodori-tts-v4.1-small" });
  assert.equal(validateKoyaMangaProductionContract(otoshigo).pass, true, "オトシゴの識別子は通る");
  assert.deepEqual(resolveKoyaDialogueAdapter(otoshigo), OTOSHIGO);

  const unknown = await contractWithAudio({ provider: "somevendor", model: "anything" });
  assert.equal(validateKoyaMangaProductionContract(unknown).pass, false, "一覧の外は通さない");
  assert.throws(() => resolveKoyaDialogueAdapter(unknown), /not an allowed voice\.dialogue adapter/u);

  const crossed = await contractWithAudio({ provider: "otoshigo", model: "eleven_v3" });
  assert.throws(() => resolveKoyaDialogueAdapter(crossed), /not an allowed/u, "提供元と型番の取り違えも通さない");

  const wrongVersion = await contractWithAudio({ provider: "otoshigo", model: "irodori-tts-v4.1-small", adapterVersion: "otoshigo-dialogue-server-v0" });
  assert.throws(() => resolveKoyaDialogueAdapter(wrongVersion), /not an allowed/u, "版が違えば通さない");
});

test("オトシゴを指す契約では、計画と要求本文がオトシゴの形になり、ElevenLabs 固有の設定を送らない", () => {
  const plan = prepareKoyaDialogueCut(manifest(), cut, { takeCount: 2, dialogueAdapter: OTOSHIGO });
  assert.equal(plan.model, "irodori-tts-v4.1-small");
  assert.deepEqual(plan.adapter, OTOSHIGO);
  const body = buildKoyaDialogueRequest(plan, 0, [{ pronunciation_dictionary_id: "x", version_id: "y" }]);
  assert.equal(body.model_id, "irodori-tts-v4.1-small");
  assert.equal(body.inputs.length, 2);
  assert.equal(body.inputs[0].voice_id, "designed:0123456789abcdef");
  for (const key of ["settings", "apply_text_normalization", "pronunciation_dictionary_locators"]) {
    assert.equal(Object.hasOwn(body, key), false, `${key} は ElevenLabs 固有なので送らない`);
  }
});

test("ElevenLabs の計画と要求本文は、アダプタを契約から引くようにしても変わらない", () => {
  const implicit = prepareKoyaDialogueCut(manifest(), cut, { takeCount: 2 });
  const explicit = prepareKoyaDialogueCut(manifest(), cut, { takeCount: 2, dialogueAdapter: DEFAULT_KOYA_DIALOGUE_ADAPTER });
  assert.deepEqual(explicit, implicit, "既定を明示しても計画の形は同じ（adapter を載せない）");
  assert.equal(Object.hasOwn(implicit, "adapter"), false);
  const body = buildKoyaDialogueRequest(implicit, 1);
  assert.deepEqual(Object.keys(body), ["inputs", "model_id", "language_code", "settings", "seed", "apply_text_normalization"]);
  assert.equal(body.model_id, "eleven_v3");
  assert.equal(body.settings.stability, 0.52);
  assert.equal(body.seed, 440011);
});

test("オトシゴの計画は、仲介へオトシゴの識別子で Job を出す", async () => {
  const plan = prepareKoyaDialogueCut(manifest(), cut, { takeCount: 2, dialogueAdapter: OTOSHIGO });
  let submitted;
  const completed = {
    jobId: "job-otoshigo-1",
    requestKey: `koya:cut-01:take:1:${"1".repeat(64)}`,
    inputHash: "1".repeat(64),
    kind: "voice.dialogue",
    ...OTOSHIGO,
    voiceId: "dialogue-hash",
    status: "completed",
    reservation: { reservationId: "r1", status: "committed" },
    usage: { units: 12 },
    result: {
      artifact: { url: "https://artifacts.invalid/a.wav", sha256: "a".repeat(64), bytes: 1024 },
      outputFormat: "wav_44100",
      voiceSegments: [
        { dialogue_input_index: 0, start_time_seconds: 0, end_time_seconds: 1 },
        { dialogue_input_index: 1, start_time_seconds: 1, end_time_seconds: 2 },
      ],
    },
  };
  await requestKoyaDialogueMediaJob(plan, 0, {
    sourceDir: "/unused",
    mediaJobBroker: {
      start: async (spec) => { submitted = spec; return { ...completed, status: "queued", result: null }; },
      waitFor: async () => completed,
    },
    artifactReader: async () => Buffer.from("RIFF-otoshigo"),
  });
  assert.equal(submitted.kind, "voice.dialogue");
  assert.equal(submitted.provider, "otoshigo");
  assert.equal(submitted.model, "irodori-tts-v4.1-small");
  assert.equal(submitted.adapterVersion, "otoshigo-dialogue-server-v1");
  assert.equal(JSON.stringify(submitted).includes("eleven"), false, "ElevenLabs の名前を1つも送らない");
});

test("受領は一覧の3値がぴったり揃うときだけ受け、取り違えた組は落とす", () => {
  const base = {
    status: "completed",
    kind: "voice.dialogue",
    jobId: "j",
    requestKey: "k",
    inputHash: "b".repeat(64),
    artifact: { sha256: "c".repeat(64), bytes: 10, mimeType: "audio/wav" },
  };
  const ok = normalizeKoyaDialogueMediaJobReceipt({ ...base, ...OTOSHIGO });
  assert.equal(ok.provider, "otoshigo");
  assert.equal(ok.model, "irodori-tts-v4.1-small");
  assert.throws(
    () => normalizeKoyaDialogueMediaJobReceipt({ ...base, ...OTOSHIGO, model: "eleven_v3" }),
    /not the completed exact paid adapter/u,
  );
});

test("doctor が測ったアダプタと契約のアダプタが違えば、有料の音声に入らない", async () => {
  const otoshigo = await contractWithAudio({ provider: "otoshigo", model: "irodori-tts-v4.1-small" });
  const measuredEleven = { doctor: { ttsAdapter: { ...DEFAULT_KOYA_DIALOGUE_ADAPTER, status: "ready" } } };
  assert.throws(
    () => assertKoyaDoctorMeasuredContractAdapter(measuredEleven, { contract: otoshigo }),
    /doctor measured elevenlabs\/eleven_v3\/.*contract names otoshigo/u,
  );
  const measuredOtoshigo = { doctor: { ttsAdapter: { ...OTOSHIGO, status: "ready" } } };
  assert.deepEqual(assertKoyaDoctorMeasuredContractAdapter(measuredOtoshigo, { contract: otoshigo }), OTOSHIGO);
  assert.throws(() => assertKoyaDoctorMeasuredContractAdapter({}, { contract: otoshigo }), /no measured/u);
});

test("最終監査は、契約が指す型番で manifest と各台詞を照合する", async () => {
  const otoshigo = await contractWithAudio({ provider: "otoshigo", model: "irodori-tts-v4.1-small" });
  const report = auditManifestAgainstKoyaContract({
    model: "eleven_v3",
    utterances: [{ id: "u1", model: "eleven_v3" }],
    video: {},
    production: { koyaContract: {} },
  }, { contract: otoshigo });
  const ids = (report.failures || []).map((entry) => entry.id);
  assert.ok(ids.includes("audio-model"), "契約がオトシゴなら eleven_v3 の manifest は落ちる");
  assert.ok(ids.includes("utterance-models"));
});

test("doctor は契約が指す台詞音声アダプタを測る（ElevenLabs に固定しない）", async () => {
  const { runHarnessDoctor } = await import("../scripts/harness-doctor.mjs");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const probed = [];
  const report = await runHarnessDoctor({
    projectDir: root,
    harnessId: "koya-manga-video",
    runtime: {
      koyaDialogueAdapter: OTOSHIGO,
      diskFreeBytes: async () => 64 * 1024 ** 3,
      resolveProductionRoute: async () => ({ command: "fixture-node", args: ["koya-manga-video.mjs", "help"], cwd: root, label: "scripts/koya-manga-video.mjs", mcpTool: "run_video_harness" }),
      mediaAdapterProbe: async (spec) => {
        probed.push(spec);
        return { ok: true, status: "ready", ...spec };
      },
    },
  });
  const tts = report.checks.find((check) => check.id === "tts-key");
  assert.ok(probed.some((spec) => spec.provider === "otoshigo" && spec.kind === "voice.dialogue"), "オトシゴの識別子で非課金 probe を出す");
  assert.equal(probed.some((spec) => spec.kind === "voice.dialogue" && spec.provider === "elevenlabs"), false, "契約がオトシゴなら ElevenLabs を測らない");
  assert.equal(tts.ok, true);
  assert.equal(tts.provider, "otoshigo");
  assert.equal(tts.model, "irodori-tts-v4.1-small");
  assert.equal(tts.adapterVersion, "otoshigo-dialogue-server-v1");
});
