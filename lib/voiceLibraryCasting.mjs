import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { resolveCanvasDir, writeJsonAtomic } from "./canvasScene.mjs";
import { readCharacterRegistry, writeCharacterRegistry } from "./characterRegistry.mjs";
import {
  DEFAULT_SPEECH_MODEL,
  addElevenLabsSharedVoice,
  getElevenLabsStatus,
  listAllElevenLabsVoices,
  listElevenLabsSharedVoices,
  voiceProfileFromElevenLabsVoice,
} from "./speechGeneration.mjs";
import {
  characterVoicePersona,
  isNativeJapaneseVoice,
  scoreVoiceForCharacter,
  voiceSettingsForPersona,
} from "./voiceCasting.mjs";

export const VOICE_LIBRARY_CASTING_VERSION = 1;
export const DEFAULT_VOICE_LIBRARY_CANDIDATE_LIMIT = 5;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function slug(value, fallback = "voice-casting") {
  const result = nonEmptyString(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return result || fallback;
}

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function candidateRiskAdjustments(voice = {}) {
  const reasons = [];
  let score = 0;
  if (voice.previewUrl) {
    score += 2;
    reasons.push("試聴サンプルあり");
  } else {
    score -= 30;
    reasons.push("試聴サンプルなし");
  }
  if (voice.category === "high_quality") {
    score += 7;
    reasons.push("Studio Quality");
  } else if (voice.category === "professional") {
    score += 4;
    reasons.push("Professional Voice Clone");
  }
  if (voice.liveModerationEnabled) {
    score -= 3;
    reasons.push("Live Moderationによる遅延可能性");
  }
  const rate = finiteNumber(voice.rate, 1);
  if (rate > 1) {
    score -= Math.min(18, (rate - 1) * 9);
    reasons.push(`カスタム料金倍率:${rate}`);
  }
  const notice = finiteNumber(voice.noticePeriodDays, null);
  if (notice !== null && notice >= 90) {
    score += 3;
    reasons.push(`削除予告期間:${notice}日`);
  } else if (notice !== null && notice < 30) {
    score -= 5;
    reasons.push(`短い削除予告期間:${notice}日`);
  }
  const usage = finiteNumber(voice.usageCharacterCount1y, 0);
  if (usage > 0) score += Math.min(3, Math.log10(usage + 1));
  return { score: Math.round(score * 100) / 100, reasons };
}

export function rankVoiceLibraryCandidates(input = {}) {
  const character = input.character || {};
  const persona = input.persona || characterVoicePersona(character, { role: input.role });
  const candidateLimit = Math.max(2, Math.min(12, Math.round(finiteNumber(
    input.candidateLimit,
    DEFAULT_VOICE_LIBRARY_CANDIDATE_LIMIT,
  ))));
  const excluded = new Set(Array.isArray(input.excludeVoiceIds) ? input.excludeVoiceIds : []);
  const ranked = (Array.isArray(input.voices) ? input.voices : [])
    .filter((voice) => voice?.id && !excluded.has(voice.id) && isNativeJapaneseVoice(voice))
    .map((voice) => {
      const semantic = scoreVoiceForCharacter(voice, character, { persona });
      const risk = candidateRiskAdjustments(voice);
      return {
        voice,
        semanticScore: semantic.score,
        operationalScore: risk.score,
        score: Math.round((semantic.score + risk.score) * 100) / 100,
        reasons: [...semantic.reasons, ...risk.reasons],
        matchedTraits: semantic.matchedTraits,
        voiceGender: semantic.voiceGender,
        voiceAge: semantic.voiceAge,
      };
    })
    .filter((entry) => !(persona.gender && entry.voiceGender && persona.gender !== entry.voiceGender))
    .sort((left, right) => right.score - left.score
      || left.voice.name.localeCompare(right.voice.name, "ja")
      || left.voice.id.localeCompare(right.voice.id));

  const minimumShared = Math.min(candidateLimit, Math.max(1, Math.round(finiteNumber(input.minimumSharedCandidates, 3))));
  const shared = ranked.filter((entry) => entry.voice.source === "shared-library").slice(0, minimumShared);
  const chosenIds = new Set(shared.map((entry) => entry.voice.id));
  const shortlist = [...shared];
  for (const entry of ranked) {
    if (shortlist.length >= candidateLimit) break;
    if (chosenIds.has(entry.voice.id)) continue;
    chosenIds.add(entry.voice.id);
    shortlist.push(entry);
  }
  shortlist.sort((left, right) => right.score - left.score
    || left.voice.name.localeCompare(right.voice.name, "ja"));
  return {
    persona,
    consideredCount: ranked.length,
    candidates: shortlist.map((entry, index) => ({
      rank: index + 1,
      voiceId: entry.voice.id,
      publicOwnerId: entry.voice.publicOwnerId || "",
      name: entry.voice.name,
      source: entry.voice.source || "account",
      alreadyAvailable: entry.voice.available !== false,
      previewUrl: entry.voice.previewUrl || "",
      score: entry.score,
      semanticScore: entry.semanticScore,
      operationalScore: entry.operationalScore,
      reasons: entry.reasons,
      matchedTraits: entry.matchedTraits,
      gender: entry.voiceGender,
      age: entry.voiceAge,
      accent: entry.voice.accent || "",
      useCase: entry.voice.useCase || "",
      category: entry.voice.category || "",
      description: entry.voice.description || "",
      rate: finiteNumber(entry.voice.rate, null),
      freeUsersAllowed: entry.voice.freeUsersAllowed === true,
      liveModerationEnabled: entry.voice.liveModerationEnabled === true,
      noticePeriodDays: finiteNumber(entry.voice.noticePeriodDays, null),
      recommended: index === 0,
    })),
  };
}

export function createVoiceLibraryAuditionPlan(input = {}) {
  const accountVoices = Array.isArray(input.accountVoices) ? input.accountVoices : [];
  const sharedVoices = Array.isArray(input.sharedVoices) ? input.sharedVoices : [];
  const catalogById = new Map();
  for (const voice of [...sharedVoices, ...accountVoices]) {
    if (voice?.id) catalogById.set(voice.id, voice);
  }
  const episodeId = nonEmptyString(input.episodeId) || "global";
  const characters = (Array.isArray(input.characters) ? input.characters : [])
    .filter((character) => character?.kind !== "location" && character?.kind !== "prop" && character?.status !== "archived");
  const targets = characters.map((character) => ({ character, role: nonEmptyString(character.voiceRole) }));
  if (input.includeNarration !== false) {
    targets.push({
      role: "narration",
      character: {
        id: "narration",
        name: "ナレーション",
        description: nonEmptyString(input.narrationDescription)
          || "Calm, intelligent, trustworthy native Japanese story narrator with clear controlled emotional delivery.",
      },
    });
  }
  const entries = targets.map(({ character, role }) => {
    const ranking = rankVoiceLibraryCandidates({
      character,
      role,
      voices: [...catalogById.values()],
      candidateLimit: input.candidateLimit,
      minimumSharedCandidates: input.minimumSharedCandidates,
    });
    return {
      characterId: character.id,
      characterName: character.name,
      role: role || character.name,
      persona: ranking.persona,
      consideredCount: ranking.consideredCount,
      candidates: ranking.candidates,
      status: ranking.candidates.length > 0 ? "awaiting-preview" : "no-candidate",
    };
  });
  const fingerprint = {
    episodeId,
    entries: entries.map((entry) => ({
      characterId: entry.characterId,
      persona: entry.persona,
      candidates: entry.candidates.map((candidate) => [candidate.voiceId, candidate.score]),
    })),
  };
  return {
    version: VOICE_LIBRARY_CASTING_VERSION,
    id: `voice-audition-${stableHash(fingerprint).slice(0, 16)}`,
    episodeId,
    status: entries.every((entry) => entry.candidates.length > 0) ? "awaiting-preview" : "incomplete",
    policy: {
      language: "ja",
      nativeJapaneseRequired: input.requireNativeJapanese !== false,
      previewRequired: true,
      explicitApprovalRequired: true,
      addOnlyApprovedSharedVoices: true,
      doNotBulkAddLibrary: true,
      accountMutationDuringDiscovery: false,
    },
    catalog: {
      accountCount: accountVoices.length,
      sharedLibraryCount: sharedVoices.length,
      uniqueCount: catalogById.size,
    },
    entries,
    createdAt: new Date().toISOString(),
  };
}

export function voiceLibraryAuditionPaths(input = {}) {
  const canvasDir = resolveCanvasDir(input);
  const episodeId = slug(input.episodeId || "global", "global");
  const rootDir = join(canvasDir, "voice-casting");
  return {
    rootDir,
    jsonPath: join(rootDir, `${episodeId}-elevenlabs-audition.json`),
    htmlPath: join(rootDir, `${episodeId}-elevenlabs-audition.html`),
    selectionsPath: join(rootDir, `${episodeId}-elevenlabs-selections.json`),
  };
}

function auditionHtml(plan) {
  const sections = plan.entries.map((entry) => `
    <section>
      <h2>${escapeHtml(entry.characterName)}</h2>
      <p>${escapeHtml([entry.persona.gender, entry.persona.age, ...(entry.persona.traits || [])].filter(Boolean).join(" / "))}</p>
      <ol>${entry.candidates.map((candidate) => `
        <li>
          <strong>${escapeHtml(candidate.name)}</strong>
          <span>score ${escapeHtml(candidate.score)} / ${escapeHtml(candidate.source)}</span>
          ${candidate.previewUrl ? `<audio controls preload="none" src="${escapeHtml(candidate.previewUrl)}"></audio>` : "<em>preview unavailable</em>"}
          <small>${escapeHtml(candidate.reasons.join("・"))}</small>
          <code>${escapeHtml(candidate.voiceId)}</code>
        </li>`).join("")}</ol>
    </section>`).join("");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ElevenLabs audition ${escapeHtml(plan.episodeId)}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;max-width:1100px;margin:32px auto;padding:0 20px;background:#f6f4ef;color:#171717}section{background:#fff;padding:20px 24px;border-radius:16px;margin:18px 0;box-shadow:0 4px 20px #0001}li{display:grid;grid-template-columns:minmax(220px,1fr) auto;gap:8px 16px;padding:14px 0;border-top:1px solid #ddd}audio,small,code{grid-column:1/-1;width:100%}small{line-height:1.55}code{overflow-wrap:anywhere}@media(max-width:650px){li{grid-template-columns:1fr}}</style></head><body><h1>ElevenLabs 日本語音声オーディション</h1><p>候補をすべて試聴し、採用するものだけ previewConfirmed=true で承認してください。検索だけではMy Voicesを変更しません。</p>${sections}</body></html>`;
}

export async function writeVoiceLibraryAuditionPlan(input = {}) {
  const plan = input.plan;
  if (!plan?.id) throw new Error("Voice Library audition plan is required.");
  const paths = voiceLibraryAuditionPaths({ ...input, episodeId: plan.episodeId });
  await mkdir(paths.rootDir, { recursive: true });
  await writeJsonAtomic(paths.jsonPath, plan);
  await writeFile(paths.htmlPath, auditionHtml(plan), "utf8");
  let writeSelectionsTemplate = input.resetSelections === true;
  if (!writeSelectionsTemplate) {
    try {
      await readFile(paths.selectionsPath, "utf8");
    } catch {
      writeSelectionsTemplate = true;
    }
  }
  if (writeSelectionsTemplate) {
    await writeJsonAtomic(paths.selectionsPath, {
      auditionPlanId: plan.id,
      instructions: "Listen to every relevant preview, then fill voiceId/newName and change previewConfirmed to true only for adopted voices. Leave voiceId blank for any role that should keep its current voice.",
      selections: plan.entries.map((entry) => ({
        characterId: entry.characterId,
        characterName: entry.characterName,
        voiceId: "",
        newName: "",
        previewConfirmed: false,
      })),
    });
  }
  return { ...paths, plan };
}

export async function discoverVoiceLibraryCasting(input = {}) {
  const status = await getElevenLabsStatus();
  if (!status.configured) throw new Error("ElevenLabs API key is not configured.");
  const registry = input.registry || await readCharacterRegistry(input);
  const requestedIds = new Set(Array.isArray(input.characterIds)
    ? input.characterIds
    : nonEmptyString(input.characterIds).split(",").map((value) => value.trim()).filter(Boolean));
  const characters = registry.characters.filter((character) => character.kind === "character"
    && (requestedIds.size === 0 || requestedIds.has(character.id))
    && (!input.episodeId || (input.episodeId === "global"
      ? !character.episodeId
      : character.episodeId === input.episodeId)));
  const [account, shared] = await Promise.all([
    listAllElevenLabsVoices({ ...input, japaneseOnly: true }),
    listElevenLabsSharedVoices({
      ...input,
      language: "ja",
      pageSize: 100,
      maxPages: finiteNumber(input.maxPages, 100),
      sort: nonEmptyString(input.sort) || "usage_character_count_1y",
    }),
  ]);
  const plan = createVoiceLibraryAuditionPlan({
    ...input,
    characters,
    accountVoices: account.voices,
    sharedVoices: shared.voices,
  });
  const written = input.persist === false ? null : await writeVoiceLibraryAuditionPlan({ ...input, plan });
  return {
    status,
    plan,
    jsonPath: written?.jsonPath || "",
    htmlPath: written?.htmlPath || "",
    selectionsPath: written?.selectionsPath || "",
  };
}

export async function readVoiceLibraryAuditionPlan(input = {}) {
  const filePath = nonEmptyString(input.planPath)
    ? resolve(input.planPath)
    : voiceLibraryAuditionPaths(input).jsonPath;
  return { plan: JSON.parse(await readFile(filePath, "utf8")), filePath };
}

function stableProfileId(characterId, episodeId) {
  return `auto-${slug(characterId || `${episodeId}-narration`, "voice")}-ja`;
}

export async function approveVoiceLibraryCasting(input = {}) {
  if (input.confirmedSettings !== true && input.confirmedVoiceAdds !== true) {
    throw new Error("Voice Library採用には confirmedVoiceAdds=true が必要です。");
  }
  const { plan, filePath } = input.plan?.id
    ? { plan: input.plan, filePath: nonEmptyString(input.planPath) }
    : await readVoiceLibraryAuditionPlan(input);
  const selections = (Array.isArray(input.selections) ? input.selections : [])
    .filter((entry) => nonEmptyString(entry?.characterId) && nonEmptyString(entry?.voiceId));
  if (selections.length === 0) throw new Error("採用する音声 selections が必要です。");
  const duplicateIds = selections.map((entry) => nonEmptyString(entry.voiceId)).filter(Boolean);
  if (new Set(duplicateIds).size !== duplicateIds.length) {
    throw new Error("異なるキャラクターに同じvoiceIdを重複採用できません。");
  }
  const registry = input.registry || await readCharacterRegistry(input);
  const mutable = {
    ...registry,
    characters: (registry.characters || []).map((entry) => ({ ...entry })),
    voices: (registry.voices || []).map((entry) => ({ ...entry })),
  };
  const results = [];
  for (const selection of selections) {
    if (selection.previewConfirmed !== true && input.previewConfirmed !== true) {
      throw new Error(`${selection.characterId || "character"}: プレビュー確認には previewConfirmed=true が必要です。`);
    }
    const planEntry = plan.entries.find((entry) => entry.characterId === selection.characterId);
    if (!planEntry) throw new Error(`オーディション計画に characterId=${selection.characterId} がありません。`);
    const candidate = planEntry.candidates.find((entry) => entry.voiceId === selection.voiceId);
    if (!candidate) throw new Error(`${planEntry.characterName}: 選択音声はオーディション候補に含まれていません。`);
    let addResult = { added: false, alreadyAvailable: candidate.alreadyAvailable, voiceId: candidate.voiceId };
    if (!candidate.alreadyAvailable) {
      addResult = await addElevenLabsSharedVoice({
        ...input,
        voiceId: candidate.voiceId,
        publicOwnerId: candidate.publicOwnerId,
        newName: nonEmptyString(selection.newName) || `BuzzAssist ${planEntry.characterName} - ${candidate.name}`,
        confirmedSettings: true,
      });
    }
    const target = mutable.characters.find((entry) => entry.id === planEntry.characterId);
    const existingProfile = planEntry.characterId === "narration"
      ? mutable.voices.find((entry) => entry.role === "narration" && entry.episodeId === plan.episodeId)
      : mutable.voices.find((entry) => entry.id === target?.voiceId);
    const profileId = existingProfile?.id || stableProfileId(planEntry.characterId, plan.episodeId);
    const providerVoice = {
      id: candidate.voiceId,
      name: candidate.name,
      previewUrl: candidate.previewUrl,
    };
    const profile = {
      ...voiceProfileFromElevenLabsVoice(providerVoice, {
        id: profileId,
        name: candidate.name,
        role: planEntry.role,
        modelId: nonEmptyString(input.modelId) || DEFAULT_SPEECH_MODEL,
        ...voiceSettingsForPersona(planEntry.persona),
      }),
      episodeId: plan.episodeId,
      source: candidate.source,
      description: candidate.description,
      labels: {
        language: "ja",
        gender: candidate.gender,
        age: candidate.age,
        accent: candidate.accent,
        use_case: candidate.useCase,
      },
      status: "approved-after-preview",
      casting: {
        language: "ja",
        nativeJapaneseRequired: true,
        sourcePool: "account-plus-public-voice-library",
        auditionPlanId: plan.id,
        auditionCandidateCount: planEntry.consideredCount,
        score: candidate.score,
        reasons: candidate.reasons,
        persona: planEntry.persona,
        previewUrl: candidate.previewUrl,
        previewConfirmed: true,
        selectedAt: new Date().toISOString(),
        selectionVersion: 2,
      },
    };
    const profileIndex = mutable.voices.findIndex((entry) => entry.id === profileId);
    if (profileIndex >= 0) mutable.voices[profileIndex] = profile;
    else mutable.voices.push(profile);
    if (target) {
      target.voiceId = profileId;
      target.voiceCasting = profile.casting;
    }
    planEntry.status = "approved";
    planEntry.approvedVoiceId = candidate.voiceId;
    planEntry.approvedAt = profile.casting.selectedAt;
    results.push({
      characterId: planEntry.characterId,
      characterName: planEntry.characterName,
      voiceProfileId: profileId,
      voiceId: candidate.voiceId,
      voiceName: candidate.name,
      addedToMyVoices: addResult.added === true,
      alreadyAvailable: addResult.alreadyAvailable === true,
    });
  }
  plan.status = plan.entries.every((entry) => entry.status === "approved") ? "approved" : "partially-approved";
  plan.updatedAt = new Date().toISOString();
  const writtenRegistry = input.persist === false ? mutable : await writeCharacterRegistry(input, mutable);
  if (input.persist !== false && filePath) await writeJsonAtomic(filePath, plan);
  return { plan, registry: writtenRegistry, approvals: results, planPath: filePath };
}
