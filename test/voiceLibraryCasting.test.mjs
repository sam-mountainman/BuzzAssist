import test from "node:test";
import assert from "node:assert/strict";

import {
  approveVoiceLibraryCasting,
  createVoiceLibraryAuditionPlan,
  rankVoiceLibraryCandidates,
} from "../lib/voiceLibraryCasting.mjs";
import { characterVoicePersona } from "../lib/voiceCasting.mjs";

function sharedVoice(overrides = {}) {
  return {
    id: "shared-gentle-young-woman",
    publicOwnerId: "owner-1",
    name: "やわらかな若い女性",
    source: "shared-library",
    available: false,
    language: "ja",
    locale: "ja-JP",
    gender: "female",
    age: "young",
    descriptive: "gentle natural sincere conversational",
    useCase: "characters_animation",
    category: "professional",
    previewUrl: "https://example.test/gentle.mp3",
    noticePeriodDays: 90,
    ...overrides,
  };
}

const character = {
  id: "mio",
  name: "水野澪",
  kind: "character",
  status: "approved",
  episodeId: "episode-voice",
  gender: "female",
  age: "young",
  description: "24歳の日本人女性。穏やかで優しく、誠実だが少し内気。自然な会話をする。",
};

test("personality ranking keeps native Japanese gender/age matches and promotes suitable public voices", () => {
  const mismatched = sharedVoice({
    id: "shared-authoritative-man",
    name: "威圧的な男性",
    gender: "male",
    age: "middle_aged",
    descriptive: "authoritative stern",
  });
  const ranking = rankVoiceLibraryCandidates({
    character,
    voices: [mismatched, sharedVoice()],
    candidateLimit: 5,
  });

  assert.equal(ranking.persona.gender, "female");
  assert.equal(ranking.persona.age, "young");
  assert.deepEqual(ranking.candidates.map((entry) => entry.voiceId), ["shared-gentle-young-woman"]);
  assert.ok(ranking.candidates[0].matchedTraits.includes("gentle"));
  assert.ok(ranking.candidates[0].matchedTraits.includes("natural"));
  assert.equal(ranking.candidates[0].recommended, true);
});

test("English personality tokens use word boundaries so intimidating does not become timid", () => {
  const persona = characterVoicePersona({
    id: "manager",
    name: "部長",
    description: "45-year-old Japanese male manager with an intimidating authoritative presence.",
  });
  assert.ok(persona.traits.includes("authoritative"));
  assert.equal(persona.traits.includes("timid"), false);
});

test("audition planning is read-only and records preview-before-approval policy", () => {
  const plan = createVoiceLibraryAuditionPlan({
    episodeId: "episode-voice",
    characters: [character],
    accountVoices: [],
    sharedVoices: [sharedVoice()],
    includeNarration: false,
  });

  assert.equal(plan.status, "awaiting-preview");
  assert.equal(plan.policy.previewRequired, true);
  assert.equal(plan.policy.accountMutationDuringDiscovery, false);
  assert.equal(plan.catalog.sharedLibraryCount, 1);
  assert.equal(plan.entries[0].candidates[0].previewUrl, "https://example.test/gentle.mp3");
});

test("approval refuses unlistened candidates and adds only the explicitly confirmed shared voice", async () => {
  const plan = createVoiceLibraryAuditionPlan({
    episodeId: "episode-voice",
    characters: [character],
    accountVoices: [],
    sharedVoices: [sharedVoice()],
    includeNarration: false,
  });
  const registry = { characters: [character], voices: [] };

  await assert.rejects(() => approveVoiceLibraryCasting({
    plan: structuredClone(plan),
    registry,
    persist: false,
    confirmedVoiceAdds: true,
    selections: [{ characterId: "mio", voiceId: "shared-gentle-young-woman" }],
  }), /previewConfirmed=true/u);

  let addRequests = 0;
  const approved = await approveVoiceLibraryCasting({
    plan: structuredClone(plan),
    registry,
    persist: false,
    confirmedVoiceAdds: true,
    skipExistingCheck: true,
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      addRequests += 1;
      assert.match(String(url), /\/v1\/voices\/add\/owner-1\/shared-gentle-young-woman$/u);
      assert.equal(options.method, "POST");
      return { ok: true, json: async () => ({ voice_id: "shared-gentle-young-woman" }) };
    },
    selections: [{
      characterId: "mio",
      voiceId: "shared-gentle-young-woman",
      previewConfirmed: true,
    }],
  });

  assert.equal(addRequests, 1);
  assert.equal(approved.approvals.length, 1);
  assert.equal(approved.approvals[0].addedToMyVoices, true);
  assert.equal(approved.registry.characters[0].voiceId, "auto-mio-ja");
  assert.equal(approved.registry.voices[0].providerVoiceId, "shared-gentle-young-woman");
  assert.equal(approved.registry.voices[0].casting.previewConfirmed, true);
  assert.equal(approved.plan.status, "approved");
});
