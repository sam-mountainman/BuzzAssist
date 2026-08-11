import test from "node:test";
import assert from "node:assert/strict";

import {
  castRegistryVoices,
  characterVoicePersona,
  isNativeJapaneseVoice,
  scoreVoiceForCharacter,
  selectVoiceForCharacter,
  voiceSettingsForPersona,
} from "../lib/voiceCasting.mjs";

const voices = [
  {
    id: "jp-calm-man",
    name: "Asahi - Calm and Natural",
    category: "professional",
    description: "Native Japanese young man with a calm, natural, gentle and trustworthy conversational delivery.",
    labels: { language: "ja", gender: "male", age: "young", descriptive: "calm", use_case: "conversational" },
  },
  {
    id: "jp-boss",
    name: "Gendo - Firm Manager",
    category: "professional",
    description: "Native Japanese authoritative, dominant, firm and stern middle aged boss voice.",
    labels: { language: "ja", gender: "male", age: "middle_aged", descriptive: "authoritative", use_case: "characters_animation" },
  },
  {
    id: "jp-gentle-woman",
    name: "Sakura - Gentle Japanese Woman",
    category: "professional",
    description: "Native Japanese young woman with a gentle, composed, sincere conversational tone.",
    labels: { language: "ja", gender: "female", age: "young", descriptive: "gentle", use_case: "conversational" },
  },
  {
    id: "jp-child-girl",
    name: "Hina - Cute Character",
    category: "professional",
    description: "Native Japanese cute youthful anime girl character voice, bright and soft.",
    labels: { language: "ja", gender: "female", age: "young", descriptive: "cute", use_case: "characters_animation" },
  },
  {
    id: "en-calm-man",
    name: "English Calm Man",
    category: "professional",
    description: "Calm and natural male voice.",
    labels: { language: "en", gender: "male", age: "young", descriptive: "calm", use_case: "conversational" },
  },
];

test("voice persona extracts Japanese character gender, age, and personality", () => {
  const persona = characterVoicePersona({
    id: "hero",
    name: "蓮",
    description: "29-year-old Japanese man. Ordinary, gentle, calm and trustworthy.",
    invariants: ["穏やかで誠実"],
  });
  assert.equal(persona.gender, "male");
  assert.equal(persona.age, "young");
  assert.ok(persona.traits.includes("calm"));
  assert.ok(persona.traits.includes("gentle"));
  assert.ok(persona.traits.includes("sincere"));
});

test("voice casting prioritizes native Japanese, gender, age, use case, and personality", () => {
  const character = {
    id: "manager",
    name: "黒川 部長",
    description: "45-year-old Japanese male department manager with an intimidating, stern and authoritative presence.",
  };
  const selected = selectVoiceForCharacter({ voices, character });
  assert.equal(selected.selected.voice.id, "jp-boss");
  assert.ok(selected.selected.reasons.some((reason) => reason.startsWith("人格一致:")));
  assert.equal(isNativeJapaneseVoice(voices.at(-1)), false);
  assert.ok(scoreVoiceForCharacter(voices[1], character).score > scoreVoiceForCharacter(voices[0], character).score);
});

test("registry casting preserves a good unique assignment but replaces duplicate adult voices for a child", () => {
  const registry = {
    characters: [
      {
        id: "adult-mio",
        name: "水野 澪",
        kind: "character",
        status: "approved",
        description: "27-year-old Japanese woman. Composed and gentle.",
        voiceId: "mio-existing",
      },
      {
        id: "child-mio",
        name: "少女の澪",
        kind: "character",
        status: "approved",
        description: "Ten-year-old Japanese girl. Cute, bright and soft.",
        voiceId: "child-duplicate",
      },
    ],
    voices: [
      { id: "mio-existing", name: "Sakura", providerVoiceId: "jp-gentle-woman", role: "水野 澪", settings: {} },
      { id: "child-duplicate", name: "Sakura again", providerVoiceId: "jp-gentle-woman", role: "少女の澪", settings: {} },
    ],
  };
  const cast = castRegistryVoices({
    registry,
    voices,
    characters: registry.characters,
    episodeId: "episode-1",
    includeNarration: false,
  });

  assert.equal(cast.assignments[0].retained, true);
  assert.equal(cast.assignments[1].retained, false);
  assert.equal(cast.assignments[1].replacedDuplicate, true);
  assert.equal(cast.assignments[1].voiceId, "jp-child-girl");
  assert.equal(cast.registry.voices.find((voice) => voice.id === "mio-existing").providerVoiceId, "jp-gentle-woman");
  assert.equal(cast.registry.characters[1].voiceId, "auto-child-mio-ja");
  assert.equal(cast.registry.voices.find((voice) => voice.id === "auto-child-mio-ja").providerVoiceId, "jp-child-girl");
  assert.notEqual(cast.registry.characters[0].voiceId, cast.registry.characters[1].voiceId);
  assert.ok(cast.registry.characters[1].voiceCasting.reasons.includes("日本語ネイティブ表記"));
});

test("personality-derived voice settings stay restrained and reflect performance style", () => {
  const calm = voiceSettingsForPersona({ age: "middle_aged", traits: ["calm", "authoritative"] });
  const brightChild = voiceSettingsForPersona({ age: "child", traits: ["bright", "cute"] });
  assert.ok(calm.stability > brightChild.stability);
  assert.ok(calm.speed < brightChild.speed);
  assert.equal(calm.useSpeakerBoost, true);
});
