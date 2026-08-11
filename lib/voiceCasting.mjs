import { DEFAULT_SPEECH_MODEL, voiceProfileFromElevenLabsVoice } from "./speechGeneration.mjs";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalized(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

const TRAIT_RULES = {
  calm: ["calm", "composed", "quiet", "restrained", "steady", "relaxed", "落ち着", "穏やか", "静か", "冷静"],
  gentle: ["gentle", "soft", "warm", "kind", "comfort", "reassuring", "優し", "柔らか", "温か", "安心"],
  natural: ["natural", "conversational", "ordinary", "relatable", "自然", "普通", "会話"],
  sincere: ["sincere", "honest", "trustworthy", "modest", "誠実", "信頼", "控えめ"],
  timid: ["timid", "shy", "tired", "nervous", "内気", "臆病", "疲れ", "おどおど"],
  confident: ["confident", "self-assured", "assured", "persuasive", "自信", "堂々"],
  authoritative: ["authoritative", "dominant", "firm", "intimidating", "stern", "boss", "威圧", "厳し", "上司", "管理職"],
  intelligent: ["intelligent", "wise", "articulate", "specialist", "strategist", "professional", "知性", "賢", "専門", "理知"],
  mature: ["mature", "deep", "low-mid", "resonant", "veteran", "大人", "低音", "重厚", "渋い"],
  bright: ["bright", "cheerful", "playful", "lively", "energetic", "明る", "元気", "快活"],
  cute: ["cute", "kawaii", "youthful", "girl", "boy", "child", "anime idol", "かわい", "少女", "少年", "子供", "幼い"],
  serious: ["serious", "controlled", "dramatic", "cool", "mysterious", "guttural", "真面目", "抑制", "クール", "神秘"],
};

function textIncludesAny(text, tokens) {
  const searchable = normalized(text);
  const englishWords = ` ${searchable.replace(/[^a-z0-9]+/gu, " ").trim()} `;
  return tokens.some((token) => {
    const value = normalized(token);
    if (!value) return false;
    if (/^[a-z0-9 -]+$/u.test(value)) {
      const phrase = value.replace(/[^a-z0-9]+/gu, " ").trim();
      return phrase ? englishWords.includes(` ${phrase} `) : false;
    }
    return searchable.includes(value);
  });
}

function characterText(character = {}) {
  return normalized([
    character.name,
    character.description,
    character.personality,
    character.voiceDescription,
    character.voice_description,
    ...(Array.isArray(character.invariants) ? character.invariants : []),
    ...(Array.isArray(character.voiceTraits) ? character.voiceTraits : []),
  ].filter(Boolean).join(" "));
}

function voiceText(voice = {}) {
  const labels = voice.labels && typeof voice.labels === "object" ? Object.values(voice.labels) : [];
  return normalized([
    voice.name,
    voice.description,
    voice.language,
    voice.locale,
    voice.accent,
    voice.gender,
    voice.age,
    voice.descriptive,
    voice.useCase,
    voice.use_case,
    ...labels,
  ].filter(Boolean).join(" "));
}

function inferredGender(text, explicit = "") {
  const value = normalized(explicit);
  if (["female", "woman", "girl", "女性", "少女"].some((token) => value.includes(token))) return "female";
  if (["male", "man", "boy", "男性", "少年"].some((token) => value.includes(token))) return "male";
  if (/\b(female|woman|girl)\b/u.test(text) || /(日本人女性|少女|女の子)/u.test(text)) return "female";
  if (/\b(male|man|boy)\b/u.test(text) || /(日本人男性|少年|男の子)/u.test(text)) return "male";
  return "";
}

function inferredAge(text, explicit = "") {
  const value = normalized(explicit).replaceAll("-", "_");
  if (value.includes("child")) return "child";
  if (value.includes("young")) return "young";
  if (value.includes("middle_aged") || value.includes("middle aged")) return "middle_aged";
  if (value.includes("old") || value.includes("senior")) return "old";
  const match = text.match(/(?:\b(\d{1,2})\s*(?:-?year-?old|years? old)\b|(\d{1,2})\s*歳)/u);
  const age = Number(match?.[1] || match?.[2]);
  if (Number.isFinite(age)) {
    if (age < 18) return "child";
    if (age < 35) return "young";
    if (age < 60) return "middle_aged";
    return "old";
  }
  if (/(少女|少年|子供|幼い|児童)/u.test(text)) return "child";
  if (/(若い|若手)/u.test(text)) return "young";
  if (/(中年|壮年|管理職)/u.test(text)) return "middle_aged";
  if (/(高齢|老人|老年)/u.test(text)) return "old";
  return "";
}

export function characterVoicePersona(character = {}, options = {}) {
  const text = characterText(character);
  const role = nonEmptyString(options.role || character.voiceRole || character.role);
  const traits = unique(Object.entries(TRAIT_RULES)
    .filter(([, tokens]) => textIncludesAny(text, tokens))
    .map(([trait]) => trait));
  if (role === "narration" && !traits.includes("calm")) traits.push("calm");
  if (role === "narration" && !traits.includes("intelligent")) traits.push("intelligent");
  return {
    id: nonEmptyString(character.id) || role || "speaker",
    name: nonEmptyString(character.name) || (role === "narration" ? "ナレーション" : "speaker"),
    role,
    gender: inferredGender(text, character.gender),
    age: inferredAge(text, character.age),
    traits,
    sourceText: text,
  };
}

function verifiedJapanese(voice = {}) {
  return (Array.isArray(voice.verifiedLanguages) ? voice.verifiedLanguages : [])
    .some((entry) => normalized(entry?.language) === "ja" || normalized(entry?.locale).startsWith("ja"));
}

export function isNativeJapaneseVoice(voice = {}) {
  const labels = voice.labels && typeof voice.labels === "object" ? voice.labels : {};
  const declared = normalized(voice.language || labels.language);
  const locale = normalized(voice.locale || labels.locale);
  const text = voiceText(voice);
  return declared === "ja" || declared === "japanese" || locale.startsWith("ja")
    || /(?:native japanese|japanese voice|日本語|日本人)/u.test(text);
}

export function isJapaneseCapableVoice(voice = {}) {
  return isNativeJapaneseVoice(voice) || verifiedJapanese(voice);
}

function voiceGender(voice = {}) {
  const labels = voice.labels && typeof voice.labels === "object" ? voice.labels : {};
  return inferredGender(voiceText(voice), voice.gender || labels.gender);
}

function voiceAge(voice = {}) {
  const labels = voice.labels && typeof voice.labels === "object" ? voice.labels : {};
  return inferredAge(voiceText(voice), voice.age || labels.age);
}

function ageCompatibility(personaAge, candidateAge) {
  if (!personaAge || !candidateAge) return { score: 0, label: "年齢情報なし" };
  if (personaAge === candidateAge) return { score: 18, label: `年齢感一致:${candidateAge}` };
  if (personaAge === "child" && candidateAge === "young") return { score: 7, label: "子役候補として若い声" };
  const order = ["child", "young", "middle_aged", "old"];
  const distance = Math.abs(order.indexOf(personaAge) - order.indexOf(candidateAge));
  if (distance === 1) return { score: 2, label: `年齢感近似:${candidateAge}` };
  return { score: -18, label: `年齢感不一致:${candidateAge}` };
}

function useCaseScore(voice, persona) {
  const labels = voice.labels && typeof voice.labels === "object" ? voice.labels : {};
  const useCase = normalized(voice.useCase || voice.use_case || labels.use_case);
  if (persona.role === "narration") {
    if (["narrative_story", "narration", "audiobook"].some((token) => useCase.includes(token))) return 18;
    if (["informative", "educational", "documentary"].some((token) => useCase.includes(token))) return 9;
    return 0;
  }
  if (useCase.includes("characters_animation")) return 16;
  if (useCase.includes("conversational")) return 13;
  if (["entertainment", "video_game", "narrative_story"].some((token) => useCase.includes(token))) return 7;
  return 0;
}

export function scoreVoiceForCharacter(voice = {}, character = {}, options = {}) {
  const persona = options.persona || characterVoicePersona(character, options);
  const reasons = [];
  let score = 0;
  if (isNativeJapaneseVoice(voice)) {
    score += 52;
    reasons.push("日本語ネイティブ表記");
  } else if (verifiedJapanese(voice)) {
    score += 28;
    reasons.push("日本語生成検証済み");
  } else {
    score -= 100;
    reasons.push("日本語適性メタデータなし");
  }

  const candidateGender = voiceGender(voice);
  if (persona.gender && candidateGender) {
    if (persona.gender === candidateGender) {
      score += 28;
      reasons.push(`性別一致:${candidateGender}`);
    } else {
      score -= 80;
      reasons.push(`性別不一致:${candidateGender}`);
    }
  }

  const age = ageCompatibility(persona.age, voiceAge(voice));
  score += age.score;
  reasons.push(age.label);

  const useCase = useCaseScore(voice, persona);
  if (useCase) {
    score += useCase;
    reasons.push(persona.role === "narration" ? "ナレーション用途一致" : "キャラクター/会話用途一致");
  }

  const candidateText = voiceText(voice);
  const matchedTraits = [];
  for (const trait of persona.traits) {
    if (!textIncludesAny(candidateText, TRAIT_RULES[trait] || [trait])) continue;
    matchedTraits.push(trait);
    score += trait === "authoritative" || trait === "cute" ? 11 : 8;
  }
  if (matchedTraits.length > 0) reasons.push(`人格一致:${matchedTraits.join(",")}`);

  const popularity = Number(voice.clonedByCount ?? voice.cloned_by_count);
  if (Number.isFinite(popularity) && popularity > 0) score += Math.min(4, Math.log10(popularity + 1));
  if (voice.category === "professional") score += 3;

  return {
    score: Math.round(score * 100) / 100,
    reasons,
    matchedTraits,
    persona,
    voiceGender: candidateGender,
    voiceAge: voiceAge(voice),
    nativeJapanese: isNativeJapaneseVoice(voice),
    japaneseCapable: isJapaneseCapableVoice(voice),
  };
}

export function selectVoiceForCharacter(input = {}) {
  const excluded = new Set(Array.isArray(input.excludeVoiceIds) ? input.excludeVoiceIds : []);
  const persona = input.persona || characterVoicePersona(input.character, { role: input.role });
  const requireNativeJapanese = input.requireNativeJapanese !== false;
  const candidates = (Array.isArray(input.voices) ? input.voices : [])
    .filter((voice) => voice?.id && !excluded.has(voice.id))
    .filter((voice) => requireNativeJapanese ? isNativeJapaneseVoice(voice) : isJapaneseCapableVoice(voice))
    .map((voice) => ({ voice, ...scoreVoiceForCharacter(voice, input.character, { persona }) }))
    .filter((entry) => !(persona.gender && entry.voiceGender && persona.gender !== entry.voiceGender))
    .sort((left, right) => right.score - left.score
      || left.voice.name.localeCompare(right.voice.name, "ja")
      || left.voice.id.localeCompare(right.voice.id));
  return {
    persona,
    selected: candidates[0] || null,
    candidates: candidates.slice(0, Math.max(1, Math.round(Number(input.candidateLimit) || 5))),
    consideredCount: candidates.length,
  };
}

export function voiceSettingsForPersona(persona = {}) {
  const traits = new Set(persona.traits || []);
  let stability = 0.53;
  let speed = 1;
  if (traits.has("calm") || traits.has("serious")) stability += 0.07;
  if (traits.has("authoritative") || traits.has("mature")) {
    stability += 0.04;
    speed -= 0.04;
  }
  if (traits.has("timid")) {
    stability -= 0.05;
    speed -= 0.02;
  }
  if (traits.has("bright") || traits.has("cute")) {
    stability -= 0.06;
    speed += 0.04;
  }
  if (persona.age === "child") speed += 0.03;
  return {
    stability: Math.min(0.72, Math.max(0.38, Math.round(stability * 100) / 100)),
    similarityBoost: 0.82,
    speed: Math.min(1.1, Math.max(0.9, Math.round(speed * 100) / 100)),
    useSpeakerBoost: true,
  };
}

function profileProviderId(profile = {}) {
  return nonEmptyString(profile.providerVoiceId || profile.elevenLabsVoiceId);
}

function stableProfileId(character, episodeId) {
  const raw = character?.id || character?.name || (episodeId ? `${episodeId}-narration` : "narration");
  return `auto-${normalized(raw).replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/gu, "-").replace(/^-+|-+$/g, "") || "voice"}-ja`;
}

function castingRecord(selection, options = {}) {
  return {
    language: "ja",
    nativeJapaneseRequired: options.requireNativeJapanese !== false,
    score: selection.score,
    reasons: selection.reasons,
    matchedTraits: selection.matchedTraits,
    persona: {
      gender: selection.persona.gender,
      age: selection.persona.age,
      traits: selection.persona.traits,
    },
    consideredCount: options.consideredCount || 0,
    selectedAt: options.selectedAt || new Date().toISOString(),
    selectionVersion: 1,
  };
}

export function castRegistryVoices(input = {}) {
  const sourceRegistry = input.registry && typeof input.registry === "object" ? input.registry : {};
  const voices = Array.isArray(input.voices) ? input.voices : [];
  const characters = (Array.isArray(input.characters) ? input.characters : sourceRegistry.characters || [])
    .filter((character) => character?.kind !== "location" && character?.kind !== "prop" && character?.status !== "archived");
  const registry = {
    ...sourceRegistry,
    characters: (sourceRegistry.characters || []).map((character) => ({ ...character })),
    voices: (sourceRegistry.voices || []).map((voice) => ({ ...voice })),
  };
  const catalogById = new Map(voices.map((voice) => [voice.id, voice]));
  const usedProviderVoiceIds = new Set();
  const assignments = [];
  let changed = false;

  const castOne = (character, options = {}) => {
    const target = character ? registry.characters.find((entry) => entry.id === character.id) : null;
    const persona = characterVoicePersona(character || {
      id: `narration-${input.episodeId || "default"}`,
      name: "ナレーション",
      description: "Calm, intelligent, trustworthy Japanese story narrator with clear controlled delivery.",
    }, { role: options.role });
    const existingProfile = options.existingProfile || registry.voices.find((profile) => profile.id === target?.voiceId);
    const existingProviderId = profileProviderId(existingProfile);
    const existingCatalogVoice = catalogById.get(existingProviderId);
    const existingScore = existingCatalogVoice
      ? scoreVoiceForCharacter(existingCatalogVoice, character || {}, { persona })
      : null;
    const duplicate = existingProviderId && usedProviderVoiceIds.has(existingProviderId);
    const validExisting = input.force !== true
      && input.preserveExisting !== false
      && existingCatalogVoice
      && isNativeJapaneseVoice(existingCatalogVoice)
      && !(persona.gender && existingScore.voiceGender && persona.gender !== existingScore.voiceGender)
      && !duplicate;
    if (validExisting) {
      const record = castingRecord({ ...existingScore, voice: existingCatalogVoice }, {
        requireNativeJapanese: input.requireNativeJapanese,
        // Keep the original audition-pool size for a retained voice. Replacing
        // it with the current catalog size makes an unchanged cast look dirty
        // whenever the account catalog grows or shrinks.
        consideredCount: existingProfile.casting?.consideredCount || voices.length,
        selectedAt: input.selectedAt || existingProfile.casting?.selectedAt,
      });
      const existingIndex = registry.voices.findIndex((entry) => entry.id === existingProfile.id);
      const updatedProfile = {
        ...existingProfile,
        source: nonEmptyString(existingCatalogVoice.source) || existingProfile.source || "account",
        description: nonEmptyString(existingCatalogVoice.description) || existingProfile.description || "",
        labels: existingCatalogVoice.labels && typeof existingCatalogVoice.labels === "object"
          ? existingCatalogVoice.labels
          : existingProfile.labels || {},
        casting: record,
      };
      if (existingIndex >= 0) registry.voices[existingIndex] = updatedProfile;
      const targetCastingChanged = target
        && JSON.stringify(target.voiceCasting || null) !== JSON.stringify(record);
      if (target) target.voiceCasting = record;
      if (targetCastingChanged || JSON.stringify(existingProfile.casting || null) !== JSON.stringify(record)) changed = true;
      usedProviderVoiceIds.add(existingProviderId);
      assignments.push({
        characterId: character?.id || "narration",
        characterName: character?.name || "ナレーション",
        voiceProfileId: existingProfile.id,
        voiceId: existingProviderId,
        voiceName: existingCatalogVoice.name || existingProfile.name,
        retained: true,
        score: existingScore.score,
        reasons: existingScore.reasons,
      });
      return updatedProfile;
    }

    const selection = selectVoiceForCharacter({
      voices,
      character: character || {},
      persona,
      role: options.role,
      excludeVoiceIds: [...usedProviderVoiceIds],
      requireNativeJapanese: input.requireNativeJapanese,
      candidateLimit: input.candidateLimit,
    });
    if (!selection.selected) {
      throw new Error(`日本語音声候補が見つかりません: ${persona.name} (${persona.gender || "gender unknown"}, ${persona.age || "age unknown"}).`);
    }
    const picked = selection.selected;
    // A duplicate provider voice means two characters currently point at the
    // same profile. Never overwrite that shared profile while separating the
    // later character: give the later character its own stable profile id.
    const id = existingProfile && !duplicate
      ? existingProfile.id
      : stableProfileId(character, input.episodeId);
    const settings = voiceSettingsForPersona(persona);
    const profile = {
      ...voiceProfileFromElevenLabsVoice(picked.voice, {
        id,
        name: picked.voice.name,
        role: options.role || character?.name,
        modelId: input.modelId || DEFAULT_SPEECH_MODEL,
        ...settings,
      }),
      episodeId: nonEmptyString(input.episodeId),
      source: nonEmptyString(picked.voice.source) || "account",
      description: nonEmptyString(picked.voice.description),
      labels: picked.voice.labels && typeof picked.voice.labels === "object" ? picked.voice.labels : {},
      casting: castingRecord(picked, {
        requireNativeJapanese: input.requireNativeJapanese,
        consideredCount: selection.consideredCount,
        selectedAt: input.selectedAt,
      }),
    };
    const profileIndex = registry.voices.findIndex((entry) => entry.id === id);
    if (profileIndex >= 0) registry.voices[profileIndex] = profile;
    else registry.voices.push(profile);
    if (target) {
      target.voiceId = id;
      target.voiceCasting = profile.casting;
    }
    usedProviderVoiceIds.add(picked.voice.id);
    assignments.push({
      characterId: character?.id || "narration",
      characterName: character?.name || "ナレーション",
      voiceProfileId: id,
      voiceId: picked.voice.id,
      voiceName: picked.voice.name,
      retained: false,
      replacedDuplicate: Boolean(duplicate),
      previousVoiceId: existingProviderId,
      score: picked.score,
      reasons: picked.reasons,
      topCandidates: selection.candidates.map((candidate) => ({
        voiceId: candidate.voice.id,
        voiceName: candidate.voice.name,
        score: candidate.score,
      })),
    });
    changed = true;
    return profile;
  };

  for (const character of characters) castOne(character);
  if (input.includeNarration !== false) {
    const episodeNarration = registry.voices.find((voice) => voice.role === "narration" && voice.episodeId === input.episodeId);
    castOne(null, { role: "narration", existingProfile: episodeNarration });
  }
  return {
    registry,
    assignments,
    changed,
    catalogCount: voices.length,
    japaneseCandidateCount: voices.filter(isJapaneseCapableVoice).length,
    nativeJapaneseCandidateCount: voices.filter(isNativeJapaneseVoice).length,
  };
}
