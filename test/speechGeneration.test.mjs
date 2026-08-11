import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  DEFAULT_SPEECH_MODEL,
  addElevenLabsSharedVoice,
  generateElevenLabsSpeech,
  getElevenLabsStatus,
  listAllElevenLabsVoices,
  listElevenLabsSharedVoices,
  listElevenLabsVoices,
  saveElevenLabsConfig,
  speechBoundsFromAlignment,
} from "../lib/speechGeneration.mjs";

test("Eleven v3 is the default speech model and timing response is normalized", async () => {
  let request = null;
  const fetchImpl = async (url, options) => {
    request = { url: String(url), options };
    return {
      ok: true,
      headers: { get: (name) => name === "request-id" ? "req-123" : null },
      json: async () => ({
        audio_base64: Buffer.from("fake-mp3").toString("base64"),
        alignment: {
          characters: ["こ", "ん", "に", "ち", "は"],
          character_start_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5],
          character_end_times_seconds: [0.2, 0.3, 0.4, 0.5, 0.7],
        },
      }),
    };
  };

  const result = await generateElevenLabsSpeech({
    text: "こんにちは",
    previousText: "雨が降っていた。",
    nextText: "店へ戻ろう。",
    previousRequestIds: ["req-before"],
    nextRequestIds: ["req-after"],
    voiceId: "voice-default",
    apiKey: "test-key",
    fetchImpl,
  });

  assert.equal(DEFAULT_SPEECH_MODEL, "eleven_v3");
  assert.equal(result.model, "eleven_v3");
  assert.equal(result.durationSeconds, 0.7);
  assert.equal(result.speechStartSeconds, 0.1);
  assert.equal(result.speechEndSeconds, 0.7);
  assert.equal(result.requestId, "req-123");
  assert.match(request.url, /with-timestamps/);
  const body = JSON.parse(request.options.body);
  assert.equal(body.model_id, "eleven_v3");
  assert.equal(body.language_code, "ja");
  assert.equal(body.apply_text_normalization, undefined);
  assert.equal(body.apply_language_text_normalization, undefined);
  assert.equal(body.previous_text, undefined);
  assert.equal(body.next_text, undefined);
  assert.equal(body.previous_request_ids, undefined);
  assert.equal(body.next_request_ids, undefined);
  assert.equal(body.voice_settings.speed, 1);
});

test("Japanese text normalization and context are enabled for compatible ElevenLabs models", async () => {
  let body = null;
  await generateElevenLabsSpeech({
    text: "翌週、展示を開く。",
    previousText: "準備が終わった。",
    nextText: "客が集まった。",
    previousRequestIds: ["req-before"],
    nextRequestIds: ["req-after"],
    voiceId: "voice-default",
    model: "eleven_multilingual_v2",
    apiKey: "test-key",
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          audio_base64: Buffer.from("fake-mp3").toString("base64"),
          alignment: {
            characters: ["声"],
            character_start_times_seconds: [0],
            character_end_times_seconds: [0.5],
          },
        }),
      };
    },
  });

  assert.equal(body.apply_text_normalization, "on");
  assert.equal(body.apply_language_text_normalization, true);
  assert.equal(body.previous_text, "準備が終わった。");
  assert.equal(body.next_text, "客が集まった。");
  assert.deepEqual(body.previous_request_ids, ["req-before"]);
  assert.deepEqual(body.next_request_ids, ["req-after"]);
});

test("voice list requests ElevenLabs default voices and keeps preview metadata", async () => {
  let requestedUrl = "";
  const result = await listElevenLabsVoices({
    apiKey: "test-key",
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return {
        ok: true,
        json: async () => ({
          voices: [{
            voice_id: "liam",
            name: "Liam",
            category: "premade",
            description: "Energetic",
            preview_url: "https://example.test/liam.mp3",
            labels: { gender: "male" },
          }],
          has_more: false,
          total_count: 1,
        }),
      };
    },
  });

  assert.match(requestedUrl, /voice_type=default/);
  assert.equal(result.voices[0].id, "liam");
  assert.equal(result.voices[0].previewUrl, "https://example.test/liam.mp3");
});

test("all-voice discovery omits the default-only filter, follows pagination, and can keep Japanese voices", async () => {
  const requestedUrls = [];
  const pages = [
    {
      voices: [{
        voice_id: "jp-calm",
        name: "Asahi",
        labels: { language: "ja", gender: "male", descriptive: "calm" },
      }],
      has_more: true,
      next_page_token: "page-2",
      total_count: 3,
    },
    {
      voices: [
        {
          voice_id: "jp-verified",
          name: "Verified Japanese",
          labels: { language: "en", gender: "female" },
          verified_languages: [{ language: "ja", locale: "ja-JP" }],
        },
        { voice_id: "en-only", name: "English", labels: { language: "en" } },
      ],
      has_more: false,
      total_count: 3,
    },
  ];
  const result = await listAllElevenLabsVoices({
    apiKey: "test-key",
    japaneseOnly: true,
    fetchImpl: async (url) => {
      const requested = new URL(String(url));
      requestedUrls.push(requested);
      const page = requested.searchParams.get("next_page_token") ? pages[1] : pages[0];
      return { ok: true, json: async () => page };
    },
  });

  assert.equal(requestedUrls.length, 2);
  assert.ok(requestedUrls.every((url) => !url.searchParams.has("voice_type")));
  assert.equal(requestedUrls[1].searchParams.get("next_page_token"), "page-2");
  assert.deepEqual(result.voices.map((voice) => voice.id), ["jp-calm", "jp-verified"]);
  assert.equal(result.unfilteredTotalCount, 3);
  assert.equal(result.pageCount, 2);
  assert.equal(result.scope, "all-account-voices");
});

test("shared Voice Library discovery is paginated and remains read-only/unavailable until added to the account", async () => {
  const requestedUrls = [];
  const result = await listElevenLabsSharedVoices({
    apiKey: "test-key",
    language: "ja",
    pageSize: 1,
    gender: "female",
    age: "young",
    accent: "japanese",
    locale: "ja-JP",
    category: "professional",
    useCases: ["characters_animation", "conversational"],
    descriptives: ["gentle", "natural"],
    featured: true,
    minNoticePeriodDays: 30,
    includeCustomRates: false,
    includeLiveModerated: false,
    sort: "usage_character_count_1y",
    fetchImpl: async (url) => {
      const requested = new URL(String(url));
      requestedUrls.push(requested);
      const page = Number(requested.searchParams.get("page"));
      return {
        ok: true,
        json: async () => ({
          voices: [{
            voice_id: `shared-${page}`,
            public_owner_id: `owner-${page}`,
            name: `Japanese shared ${page}`,
            language: "ja",
          }],
          has_more: page === 0,
        }),
      };
    },
  });

  assert.equal(requestedUrls.length, 2);
  assert.equal(requestedUrls[0].searchParams.get("language"), "ja");
  assert.equal(requestedUrls[0].searchParams.get("gender"), "female");
  assert.equal(requestedUrls[0].searchParams.get("age"), "young");
  assert.equal(requestedUrls[0].searchParams.get("accent"), "japanese");
  assert.equal(requestedUrls[0].searchParams.get("locale"), "ja-JP");
  assert.equal(requestedUrls[0].searchParams.get("category"), "professional");
  assert.deepEqual(requestedUrls[0].searchParams.getAll("use_cases"), ["characters_animation", "conversational"]);
  assert.deepEqual(requestedUrls[0].searchParams.getAll("descriptives"), ["gentle", "natural"]);
  assert.equal(requestedUrls[0].searchParams.get("featured"), "true");
  assert.equal(requestedUrls[0].searchParams.get("min_notice_period_days"), "30");
  assert.equal(requestedUrls[0].searchParams.get("include_custom_rates"), "false");
  assert.equal(requestedUrls[0].searchParams.get("include_live_moderated"), "false");
  assert.equal(requestedUrls[0].searchParams.get("sort"), "usage_character_count_1y");
  assert.deepEqual(result.voices.map((voice) => voice.id), ["shared-0", "shared-1"]);
  assert.ok(result.voices.every((voice) => voice.source === "shared-library" && voice.available === false));
  assert.equal(result.scope, "shared-library");
});

test("adding a shared Voice Library candidate requires explicit confirmation and sends only the approved voice", async () => {
  await assert.rejects(() => addElevenLabsSharedVoice({
    apiKey: "test-key",
    voiceId: "shared-jp",
    publicOwnerId: "owner-jp",
    newName: "採用音声",
  }), /confirmedSettings=true/u);

  let request = null;
  const result = await addElevenLabsSharedVoice({
    apiKey: "test-key",
    voiceId: "shared-jp",
    publicOwnerId: "owner-jp",
    newName: "採用音声",
    confirmedVoiceAdd: true,
    skipExistingCheck: true,
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return { ok: true, json: async () => ({ voice_id: "shared-jp" }) };
    },
  });

  assert.match(request.url, /\/v1\/voices\/add\/owner-jp\/shared-jp$/u);
  assert.equal(request.options.method, "POST");
  assert.deepEqual(JSON.parse(request.options.body), { new_name: "採用音声", bookmarked: true });
  assert.equal(result.added, true);
  assert.equal(result.voiceId, "shared-jp");
});

test("ElevenLabs config is stored outside the repository without exposing the key in status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buzzassist-elevenlabs-test-"));
  const configPath = join(directory, "elevenlabs.json");
  const previous = process.env.BUZZASSIST_ELEVENLABS_CONFIG;
  process.env.BUZZASSIST_ELEVENLABS_CONFIG = configPath;
  try {
    await saveElevenLabsConfig({ apiKey: "private-test-key", defaultVoiceId: "liam", defaultVoiceName: "Liam" });
    const status = await getElevenLabsStatus();
    assert.equal(status.configured, true);
    assert.equal(status.defaultVoiceId, "liam");
    assert.equal("apiKey" in status, false);
    const stored = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(stored.apiKey, "private-test-key");
  } finally {
    if (previous === undefined) delete process.env.BUZZASSIST_ELEVENLABS_CONFIG;
    else process.env.BUZZASSIST_ELEVENLABS_CONFIG = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("speech bounds ignore leading and trailing whitespace timing", () => {
  assert.deepEqual(speechBoundsFromAlignment({
    characters: [" ", "声", " "],
    characterStartTimesSeconds: [0, 0.2, 0.5],
    characterEndTimesSeconds: [0.2, 0.5, 0.8],
  }), { startSeconds: 0.2, endSeconds: 0.5 });
});
