// Koya の声の人選（匿名オーディション → 人の採用）を、台詞音声の提供元に依らずに行う。
//
// これまで人選の入口はベンチマーク専用の scripts/build-manga-video.mjs にしか無く、
// しかも ElevenLabs の Voice Library（無料の試聴URL）前提だった。オトシゴの声は
// 試聴URLを持たないので、候補ごとに「決まった台詞1行」を契約の voice.dialogue
// adapter で実際に合成し、その音を匿名ラベル（A〜E）で聴き比べる。
//
// 流れ:
//   1. 候補ファイル（koya-voice-audition-candidates-v1）: 人物ごとに試聴台詞1行と
//      2〜5個の提供元の声ID。声IDは提供元の声一覧から人が選んで書く。
//   2. createKoyaVoiceAuditionPlan: 候補を決定的に並べ替えて匿名ラベルを振る。
//   3. writeKoyaVoiceAuditionPlan: 有料の試聴音を作る（renderPreview）。
//      公開側の計画・HTML には匿名ラベルと試聴音の SHA-256 しか書かない。
//      声ID・声名との対応表は .private/ にだけ置く。
//   4. approveKoyaVoiceAudition: selections（winnerLabel・理由・previewConfirmed）を
//      先に verdicts へ保存してから対応表を開き、台帳の voice profile と人物へ
//      人間選定記録（selectionVersion 2）を書く。記録は koyaVoiceSelectionGuard が
//      「人が選んだ」と数える形と同じで、書く前に同じ判定にかけて確かめる。
//
// 試聴の有料呼び出しは本番と同じ仲介（paid media job broker）を通る。requestKey は
// 候補集合・ラベル・入力 hash から決まるので、途中で落ちても作り直しで二重課金しない。

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { resolveCanvasDir, writeJsonAtomic } from "./canvasScene.mjs";
import { readCharacterRegistry, writeCharacterRegistry } from "./characterRegistry.mjs";
import { requestKoyaDialogueMediaJob } from "./koyaDialogueSpeech.mjs";
import {
  DEFAULT_KOYA_DIALOGUE_ADAPTER,
  findKoyaDialogueAdapter,
} from "./koyaMangaProductionContract.mjs";
import {
  MINIMUM_VOICE_SELECTION_CANDIDATES,
  MINIMUM_VOICE_SELECTION_REASON_LENGTH,
  classifyKoyaVoiceCastingRecord,
} from "./koyaVoiceSelectionGuard.mjs";

export const KOYA_VOICE_AUDITION_VERSION = "koya-voice-audition-v1";
export const KOYA_VOICE_AUDITION_CANDIDATES_VERSION = "koya-voice-audition-candidates-v1";
export const KOYA_VOICE_AUDITION_SELECTIONS_VERSION = "koya-voice-audition-selections-v1";
export const MAXIMUM_VOICE_AUDITION_CANDIDATES = 5;
export const MAXIMUM_VOICE_AUDITION_SAMPLE_LINE_LENGTH = 120;
// characterRegistry は声を 50 件で黙って切る。採用で溢れる前に止める。
const REGISTRY_VOICE_LIMIT = 50;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableHash(value) {
  return sha256(JSON.stringify(value));
}

function slug(value, fallback) {
  const text = String(value || "")
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return text || fallback;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function adapterIdentity(adapter) {
  return { provider: adapter.provider, model: adapter.model, adapterVersion: adapter.adapterVersion };
}

function registryEpisodeScope(character) {
  return nonEmpty(character?.episodeId) || "global";
}

export function koyaVoiceAuditionPaths(input = {}) {
  const canvasDir = resolveCanvasDir(input);
  const episodeId = slug(input.episodeId || "global", "global");
  const rootDir = join(canvasDir, "voice-casting");
  return {
    rootDir,
    candidatesPath: join(rootDir, `${episodeId}-koya-candidates.json`),
    jsonPath: join(rootDir, `${episodeId}-koya-audition.json`),
    privateJsonPath: join(rootDir, ".private", `${episodeId}-koya-audition-private.json`),
    htmlPath: join(rootDir, `${episodeId}-koya-audition.html`),
    selectionsPath: join(rootDir, `${episodeId}-koya-selections.json`),
    verdictsPath: join(rootDir, `${episodeId}-koya-verdicts.json`),
    previewRoot: join(rootDir, "previews", `koya-${episodeId}`),
    mediaJobStateDir: join(rootDir, ".private", "paid-media-jobs"),
  };
}

/**
 * 候補ファイルの雛形。人物名と空の試聴台詞・候補欄だけを書く（声は人が選んで埋める）。
 */
export function createKoyaVoiceAuditionCandidatesTemplate({ registry, episodeId = "global", characterIds = [], dialogueAdapter } = {}) {
  const adapter = findKoyaDialogueAdapter(dialogueAdapter || DEFAULT_KOYA_DIALOGUE_ADAPTER);
  if (!adapter) throw new Error("Koya voice audition requires an allowed voice.dialogue adapter.");
  const ids = (Array.isArray(characterIds) ? characterIds : String(characterIds || "").split(","))
    .map((value) => nonEmpty(value))
    .filter(Boolean);
  if (ids.length === 0) throw new Error("--character-ids is required to draft a voice audition candidates file.");
  return {
    version: KOYA_VOICE_AUDITION_CANDIDATES_VERSION,
    episodeId: nonEmpty(episodeId) || "global",
    adapter: adapterIdentity(adapter),
    instructions: "For every character, write one sampleLine taken from the script (no [tags]) and 2 to 5 candidates with the provider voice id (voiceId) from the provider's voice list. name and description are private notes; they never reach the listening page.",
    entries: ids.map((characterId) => {
      const character = (registry?.characters || []).find((entry) => entry?.id === characterId);
      if (!character) throw new Error(`${characterId} is not in the character registry.`);
      return {
        characterId,
        characterName: nonEmpty(character.name),
        sampleLine: "",
        candidates: [],
      };
    }),
  };
}

function validateSampleLine(sampleLine, adapter, label) {
  const text = nonEmpty(sampleLine);
  if (!text) throw new Error(`${label}: sampleLine is required (one line from the script, read aloud by every candidate).`);
  if (Array.from(text).length > MAXIMUM_VOICE_AUDITION_SAMPLE_LINE_LENGTH) {
    throw new Error(`${label}: sampleLine is longer than ${MAXIMUM_VOICE_AUDITION_SAMPLE_LINE_LENGTH} characters; use one line.`);
  }
  if (adapter !== DEFAULT_KOYA_DIALOGUE_ADAPTER && /\[[^\]]*\]/u.test(text)) {
    throw new Error(`${label}: ${adapter.provider} does not take performance tags such as [angry]; write the line only.`);
  }
  return text;
}

/**
 * 候補ファイルから匿名オーディション計画（非公開の対応表を含む）を作る。
 * 有料呼び出しはしない。
 */
export function createKoyaVoiceAuditionPlan({ candidates, registry, dialogueAdapter, episodeId = "" } = {}) {
  if (!isPlainObject(candidates) || candidates.version !== KOYA_VOICE_AUDITION_CANDIDATES_VERSION) {
    throw new Error(`Voice audition candidates must be a ${KOYA_VOICE_AUDITION_CANDIDATES_VERSION} file.`);
  }
  const adapter = findKoyaDialogueAdapter(dialogueAdapter || DEFAULT_KOYA_DIALOGUE_ADAPTER);
  if (!adapter) throw new Error("Koya voice audition requires an allowed voice.dialogue adapter.");
  if (isPlainObject(candidates.adapter)
    && (candidates.adapter.provider !== adapter.provider || candidates.adapter.model !== adapter.model)) {
    throw new Error(`The candidates file was written for ${candidates.adapter.provider}/${candidates.adapter.model}, but the contract speaks with ${adapter.provider}/${adapter.model}.`);
  }
  const planEpisodeId = nonEmpty(episodeId) || nonEmpty(candidates.episodeId) || "global";
  if (nonEmpty(candidates.episodeId) && nonEmpty(candidates.episodeId) !== planEpisodeId) {
    throw new Error(`The candidates file is for ${candidates.episodeId}, not ${planEpisodeId}.`);
  }
  const rawEntries = Array.isArray(candidates.entries) ? candidates.entries : [];
  if (rawEntries.length === 0) throw new Error("The candidates file has no entries.");
  const seenCharacters = new Set();
  const entries = rawEntries.map((raw, entryIndex) => {
    const characterId = nonEmpty(raw?.characterId);
    const label = characterId || `entry ${entryIndex + 1}`;
    if (!characterId) throw new Error(`${label}: characterId is required.`);
    if (seenCharacters.has(characterId)) throw new Error(`${characterId} appears twice in the candidates file.`);
    seenCharacters.add(characterId);
    const character = (registry?.characters || []).find((entry) => entry?.id === characterId);
    if (!character || (character.kind && character.kind !== "character") || character.status === "archived") {
      throw new Error(`${characterId} is not an active character in the character registry.`);
    }
    if (registryEpisodeScope(character) !== planEpisodeId) {
      throw new Error(`${characterId} belongs to registry scope ${registryEpisodeScope(character)}, not ${planEpisodeId}; audition it with --episode-id ${registryEpisodeScope(character)}.`);
    }
    const sampleLine = validateSampleLine(raw.sampleLine, adapter, characterId);
    const rawCandidates = Array.isArray(raw.candidates) ? raw.candidates : [];
    if (rawCandidates.length < MINIMUM_VOICE_SELECTION_CANDIDATES) {
      throw new Error(`${characterId}: at least ${MINIMUM_VOICE_SELECTION_CANDIDATES} candidate voices are required.`);
    }
    if (rawCandidates.length > MAXIMUM_VOICE_AUDITION_CANDIDATES) {
      throw new Error(`${characterId}: at most ${MAXIMUM_VOICE_AUDITION_CANDIDATES} candidate voices (A-E).`);
    }
    const voiceIds = new Set();
    const normalized = rawCandidates.map((candidate, index) => {
      const voiceId = nonEmpty(candidate?.voiceId);
      if (!voiceId || /\s/u.test(voiceId)) throw new Error(`${characterId}: candidate ${index + 1} has no provider voiceId.`);
      if (voiceIds.has(voiceId)) throw new Error(`${characterId}: voice ${voiceId} is listed twice.`);
      voiceIds.add(voiceId);
      return {
        voiceId,
        name: nonEmpty(candidate.name),
        description: nonEmpty(candidate.description),
        source: nonEmpty(candidate.source),
      };
    });
    const candidateSetId = `voice-set-${stableHash({
      episodeId: planEpisodeId,
      characterId,
      adapter: adapterIdentity(adapter),
      sampleLine,
      voiceIds: [...voiceIds].sort(),
    }).slice(0, 20)}`;
    // 並びは候補集合と声IDから決まる。書いた順（人が気に入った順になりがち）を
    // そのまま A, B, C にしない。
    const ordered = [...normalized].sort((left, right) => (
      sha256(`${candidateSetId}:${left.voiceId}`).localeCompare(sha256(`${candidateSetId}:${right.voiceId}`))
    ));
    return {
      characterId,
      characterName: nonEmpty(character.name) || characterId,
      role: nonEmpty(character.voiceRole) || nonEmpty(character.name) || characterId,
      sampleLine,
      candidateSetId,
      status: "awaiting-preview",
      candidates: ordered.map((candidate, index) => ({
        ...candidate,
        blindLabel: String.fromCharCode(65 + index),
      })),
    };
  });
  const fingerprint = {
    episodeId: planEpisodeId,
    adapter: adapterIdentity(adapter),
    entries: entries.map((entry) => [entry.characterId, entry.candidateSetId]),
  };
  return {
    version: KOYA_VOICE_AUDITION_VERSION,
    id: `koya-voice-audition-${stableHash(fingerprint).slice(0, 16)}`,
    episodeId: planEpisodeId,
    adapter: adapterIdentity(adapter),
    status: "awaiting-preview",
    policy: {
      language: "ja",
      previewRequired: true,
      explicitApprovalRequired: true,
      verdictBeforeMapping: true,
      paidPreview: true,
    },
    entries,
    createdAt: new Date().toISOString(),
  };
}

function publicKoyaAuditionPlan(plan) {
  return {
    version: plan.version,
    id: plan.id,
    episodeId: plan.episodeId,
    status: plan.status,
    policy: plan.policy,
    entries: plan.entries.map((entry) => ({
      characterId: entry.characterId,
      characterName: entry.characterName,
      sampleLine: entry.sampleLine,
      candidateSetId: entry.candidateSetId,
      status: entry.status,
      candidates: entry.candidates.map((candidate) => ({
        label: candidate.blindLabel,
        previewUrl: nonEmpty(candidate.previewUrl),
        previewSha256: nonEmpty(candidate.previewSha256),
      })),
    })),
    createdAt: plan.createdAt,
  };
}

function koyaAuditionHtml(publicPlan) {
  const sections = publicPlan.entries.map((entry) => `
    <section>
      <h2>${escapeHtml(entry.characterName)}</h2>
      <p class="line">「${escapeHtml(entry.sampleLine)}」</p>
      <ol>${entry.candidates.map((candidate) => `
        <li>
          <strong>候補 ${escapeHtml(candidate.label)}</strong>
          ${candidate.previewUrl ? `<audio controls preload="none" src="${escapeHtml(candidate.previewUrl)}"></audio>` : "<em>試聴音がまだありません</em>"}
        </li>`).join("")}</ol>
    </section>`).join("");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>声の人選 ${escapeHtml(publicPlan.episodeId)}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;max-width:900px;margin:32px auto;padding:0 16px;background:#f6f4ef;color:#171717}section{background:#fff;padding:20px 24px;border-radius:16px;margin:18px 0;box-shadow:0 4px 20px #0001}.line{font-size:1.1em}ol{padding:0;list-style:none}li{display:grid;gap:8px;padding:14px 0;border-top:1px solid #ddd}audio{width:100%}</style></head><body><h1>声の人選（匿名）</h1><p>どの候補も同じ台詞を読んでいます。全部聴いてから、selections の winnerLabel・selectionReason・previewConfirmed を埋めてください。候補の声の名前や出所は、採用を記録するまで見ないでください。</p>${sections}</body></html>`;
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function fileSha256OrEmpty(filePath) {
  try {
    return sha256(await readFile(filePath));
  } catch {
    return "";
  }
}

function isAuditionPreviewPath(value) {
  const text = nonEmpty(value);
  return text.startsWith("./previews/") && !text.split("/").includes("..");
}

function previewRelativePath(plan, entry, candidate, extension) {
  return `./previews/koya-${slug(plan.episodeId, "global")}/${slug(entry.characterId, "character")}/${candidate.blindLabel}.${extension}`;
}

/**
 * 契約の voice.dialogue adapter で「候補1声 × 試聴台詞1行」を合成する既定の renderPreview。
 * 本番の台詞と同じ仲介を通り、requestKey は候補集合・ラベル・入力から決まる。
 */
export function createKoyaVoiceAuditionPreviewRenderer(options = {}) {
  return async ({ plan, entry, candidate }) => {
    const adapter = findKoyaDialogueAdapter(plan.adapter);
    if (!adapter) throw new Error(`${plan.id}: the audition adapter is not allowed.`);
    const text = entry.sampleLine;
    const input = {
      utteranceId: `${entry.characterId}-${candidate.blindLabel}`,
      displayText: text,
      speechText: text,
      expectedReading: "",
      performancePrompt: "",
      providerText: text,
      voiceId: candidate.voiceId,
      apiInput: { text, voice_id: candidate.voiceId },
      providerInputIndices: [0],
    };
    const cutPlan = {
      cutId: `audition-${candidate.blindLabel}`,
      utterances: [],
      inputs: [input],
      providerInputs: [{ ...input, logicalInputIndex: 0, providerInputIndex: 0, parentUtteranceId: input.utteranceId }],
      takeCount: 1,
      model: adapter.model,
      ...(adapter === DEFAULT_KOYA_DIALOGUE_ADAPTER ? {} : { adapter }),
      languageCode: "ja",
    };
    const inputHash = stableHash({ adapter: adapterIdentity(adapter), text, voiceId: candidate.voiceId });
    const media = await requestKoyaDialogueMediaJob(cutPlan, 0, {
      ...options,
      sourceDir: options.sourceDir || options.mediaJobStateDir,
      requestKey: `koya-voice-audition:${entry.candidateSetId}:${candidate.blindLabel}:${inputHash.slice(0, 24)}`,
    });
    return {
      audioBuffer: media.audioBuffer,
      extension: "wav",
      mediaJobId: nonEmpty(media.job?.jobId),
      requestKey: nonEmpty(media.job?.requestKey),
      outputFormat: nonEmpty(media.outputFormat),
      characterCost: media.characterCost,
    };
  };
}

/** 試聴音がまだ無い（または壊れている）候補の数。有料確認の前に見せる。 */
export async function pendingKoyaVoiceAuditionPreviews({ plan, projectDir } = {}) {
  const paths = koyaVoiceAuditionPaths({ projectDir, episodeId: plan.episodeId });
  const previous = await readJsonOrNull(paths.privateJsonPath);
  const reusable = previous?.id === plan.id ? previous : null;
  const pending = [];
  let characters = 0;
  for (const entry of plan.entries) {
    const prior = reusable?.entries?.find((item) => item.characterId === entry.characterId);
    for (const candidate of entry.candidates) {
      const priorCandidate = prior?.candidates?.find((item) => item.blindLabel === candidate.blindLabel && item.voiceId === candidate.voiceId);
      const recorded = nonEmpty(priorCandidate?.previewSha256);
      const onDisk = recorded && priorCandidate?.previewUrl
        ? await fileSha256OrEmpty(resolve(paths.rootDir, priorCandidate.previewUrl))
        : "";
      if (recorded && onDisk === recorded) continue;
      pending.push({ characterId: entry.characterId, label: candidate.blindLabel });
      characters += Array.from(entry.sampleLine).length;
    }
  }
  return { pending, estimatedCharacters: characters };
}

/**
 * 試聴音を作り（既にある分は SHA を確かめて使い回す）、公開計画・HTML・非公開の対応表・
 * selections の雛形を書く。confirmPaidPreview が true でなければ有料呼び出しをせずに止まる。
 */
export async function writeKoyaVoiceAuditionPlan(input = {}) {
  const plan = input.plan;
  if (!plan?.id || plan.version !== KOYA_VOICE_AUDITION_VERSION) throw new Error("A Koya voice audition plan is required.");
  const paths = koyaVoiceAuditionPaths({ ...input, episodeId: plan.episodeId });
  const { pending, estimatedCharacters } = await pendingKoyaVoiceAuditionPreviews({ plan, projectDir: input.projectDir });
  if (pending.length > 0 && input.confirmPaidPreview !== true) {
    return {
      status: "awaiting-paid-confirmation",
      planId: plan.id,
      adapter: plan.adapter,
      pendingPreviews: pending.length,
      estimatedCharacters,
      ...paths,
    };
  }
  await Promise.all([
    mkdir(join(paths.rootDir, ".private"), { recursive: true }),
    mkdir(paths.previewRoot, { recursive: true }),
  ]);
  const previous = await readJsonOrNull(paths.privateJsonPath);
  const reusable = previous?.id === plan.id ? previous : null;
  const renderPreview = typeof input.renderPreview === "function"
    ? input.renderPreview
    : createKoyaVoiceAuditionPreviewRenderer({ ...input.previewOptions, mediaJobStateDir: paths.mediaJobStateDir });
  let rendered = 0;
  let reused = 0;
  for (const entry of plan.entries) {
    const prior = reusable?.entries?.find((item) => item.characterId === entry.characterId);
    await mkdir(join(paths.previewRoot, slug(entry.characterId, "character")), { recursive: true });
    for (const candidate of entry.candidates) {
      const priorCandidate = prior?.candidates?.find((item) => item.blindLabel === candidate.blindLabel && item.voiceId === candidate.voiceId);
      const recorded = nonEmpty(priorCandidate?.previewSha256);
      if (recorded && priorCandidate?.previewUrl
        && await fileSha256OrEmpty(resolve(paths.rootDir, priorCandidate.previewUrl)) === recorded) {
        Object.assign(candidate, {
          previewUrl: priorCandidate.previewUrl,
          previewSha256: recorded,
          previewMediaJobId: nonEmpty(priorCandidate.previewMediaJobId),
          previewRequestKey: nonEmpty(priorCandidate.previewRequestKey),
        });
        reused += 1;
        continue;
      }
      const preview = await renderPreview({ plan, entry, candidate });
      const audioBuffer = preview?.audioBuffer;
      if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
        throw new Error(`${entry.characterId} candidate ${candidate.blindLabel}: the preview renderer returned no audio.`);
      }
      const extension = /^[a-z0-9]{2,5}$/u.test(nonEmpty(preview.extension)) ? preview.extension : "wav";
      const previewUrl = previewRelativePath(plan, entry, candidate, extension);
      await writeFile(resolve(paths.rootDir, previewUrl), audioBuffer);
      Object.assign(candidate, {
        previewUrl,
        previewSha256: sha256(audioBuffer),
        previewMediaJobId: nonEmpty(preview.mediaJobId),
        previewRequestKey: nonEmpty(preview.requestKey),
      });
      rendered += 1;
      // 1件ごとに対応表を書く。途中で落ちても、作った試聴音の SHA は残る。
      await writeJsonAtomic(paths.privateJsonPath, plan);
    }
  }
  plan.status = "awaiting-selection";
  for (const entry of plan.entries) entry.status = "awaiting-selection";
  const publicPlan = publicKoyaAuditionPlan(plan);
  await Promise.all([
    writeJsonAtomic(paths.privateJsonPath, plan),
    writeJsonAtomic(paths.jsonPath, publicPlan),
    writeFile(paths.htmlPath, koyaAuditionHtml(publicPlan), "utf8"),
  ]);
  const existingSelections = await readJsonOrNull(paths.selectionsPath);
  const writeTemplate = input.resetSelections === true || existingSelections?.auditionPlanId !== plan.id;
  if (writeTemplate) {
    await writeJsonAtomic(paths.selectionsPath, {
      version: KOYA_VOICE_AUDITION_SELECTIONS_VERSION,
      auditionPlanId: plan.id,
      instructions: "Listen to every candidate in the audition page, then fill winnerLabel (A-E), selectionReason (what you heard) and previewConfirmed=true. Leave a character blank to decide later. Do not open the private mapping before approval.",
      selections: plan.entries.map((entry) => ({
        characterId: entry.characterId,
        characterName: entry.characterName,
        winnerLabel: "",
        selectionReason: "",
        previewConfirmed: false,
      })),
    });
  }
  return {
    status: "awaiting-selection",
    planId: plan.id,
    adapter: plan.adapter,
    rendered,
    reused,
    plan: publicPlan,
    ...paths,
  };
}

function stableProfileId(characterId, adapter) {
  return `koya-${slug(characterId, "character")}-${slug(adapter.provider, "voice")}`;
}

/**
 * 人の採用を台帳へ書く。verdicts（ラベル・理由・採用者）を先に保存してから
 * 非公開の対応表で声IDへ引き直す。
 */
export async function approveKoyaVoiceAudition(input = {}) {
  const projectDir = input.projectDir;
  const episodeId = nonEmpty(input.episodeId) || "global";
  const paths = koyaVoiceAuditionPaths({ projectDir, episodeId });
  const approvedBy = nonEmpty(input.approvedBy);
  if (!approvedBy) throw new Error("--approved-by is required: the person who listened and chose.");
  const selectionsFile = input.selections;
  if (!isPlainObject(selectionsFile) || !Array.isArray(selectionsFile.selections)) {
    throw new Error("A voice audition selections file is required.");
  }
  const plan = await readJsonOrNull(paths.privateJsonPath);
  const publicPlan = await readJsonOrNull(paths.jsonPath);
  if (!plan?.id || !publicPlan?.id) throw new Error(`No Koya voice audition for ${episodeId}; run voice-audition first.`);
  if (publicPlan.id !== plan.id) throw new Error("The public audition plan and the private mapping are from different auditions; run voice-audition again.");
  if (nonEmpty(selectionsFile.auditionPlanId) !== plan.id) {
    throw new Error(`The selections file is for audition ${selectionsFile.auditionPlanId || "(none)"}, not the current audition ${plan.id}.`);
  }
  const adapter = findKoyaDialogueAdapter(plan.adapter);
  if (!adapter) throw new Error(`${plan.id}: the audition adapter is not allowed.`);

  const chosen = selectionsFile.selections.filter((entry) => nonEmpty(entry?.winnerLabel));
  if (chosen.length === 0) throw new Error("No winnerLabel is filled in the selections file.");
  const chosenIds = chosen.map((entry) => nonEmpty(entry.characterId));
  if (new Set(chosenIds).size !== chosenIds.length) throw new Error("A character has more than one selection.");

  // 1) 対応表を開く前に、ラベル・理由・試聴確認・試聴音の SHA を確かめて verdicts へ保存する。
  const selectedAt = new Date().toISOString();
  const verdicts = [];
  for (const selection of chosen) {
    const characterId = nonEmpty(selection.characterId);
    const publicEntry = publicPlan.entries.find((entry) => entry.characterId === characterId);
    if (!publicEntry) throw new Error(`${characterId} is not in audition ${plan.id}.`);
    if ((publicEntry.candidates || []).length < MINIMUM_VOICE_SELECTION_CANDIDATES) {
      throw new Error(`${characterId}: a selection needs at least ${MINIMUM_VOICE_SELECTION_CANDIDATES} compared candidates.`);
    }
    if (selection.previewConfirmed !== true) {
      throw new Error(`${characterId}: previewConfirmed must be true (every candidate was heard).`);
    }
    const reason = nonEmpty(selection.selectionReason);
    if (Array.from(reason).length < MINIMUM_VOICE_SELECTION_REASON_LENGTH) {
      throw new Error(`${characterId}: selectionReason must say what you heard (${MINIMUM_VOICE_SELECTION_REASON_LENGTH}+ characters).`);
    }
    const winnerLabel = nonEmpty(selection.winnerLabel).toUpperCase();
    const publicCandidate = publicEntry.candidates.find((entry) => entry.label === winnerLabel);
    if (!publicCandidate) throw new Error(`${characterId}: candidate ${winnerLabel} is not in this audition.`);
    for (const candidate of publicEntry.candidates) {
      if (!/^[a-f0-9]{64}$/u.test(nonEmpty(candidate.previewSha256)) || !isAuditionPreviewPath(candidate.previewUrl)) {
        throw new Error(`${characterId}: candidate ${candidate.label} has no preview; every candidate must be heard.`);
      }
      const onDisk = await fileSha256OrEmpty(resolve(paths.rootDir, candidate.previewUrl));
      if (onDisk !== candidate.previewSha256) {
        throw new Error(`${characterId}: the preview of candidate ${candidate.label} changed after the audition was written.`);
      }
    }
    const verdict = {
      characterId,
      candidateSetId: publicEntry.candidateSetId,
      winnerLabel,
      previewSha256: publicCandidate.previewSha256,
      approvedBy,
      reason,
      decidedAt: selectedAt,
    };
    verdict.digest = stableHash({ auditionPlanId: plan.id, ...verdict });
    verdicts.push(verdict);
  }
  const verdictStore = (await readJsonOrNull(paths.verdictsPath)) || {};
  const priorVerdicts = verdictStore.auditionPlanId === plan.id && Array.isArray(verdictStore.verdicts)
    ? verdictStore.verdicts
    : [];
  await writeJsonAtomic(paths.verdictsPath, {
    version: 1,
    auditionPlanId: plan.id,
    verdicts: [
      ...priorVerdicts.filter((entry) => !chosenIds.includes(entry.characterId)),
      ...verdicts,
    ],
  });

  // 2) 対応表で声IDへ引き直し、台帳へ書く。
  const registry = input.registry || await readCharacterRegistry({ projectDir });
  const mutable = {
    ...registry,
    characters: (registry.characters || []).map((entry) => ({ ...entry })),
    voices: (registry.voices || []).map((entry) => ({ ...entry })),
  };
  const selectedVoiceIds = new Map();
  const approvals = [];
  for (const verdict of verdicts) {
    const entry = plan.entries.find((item) => item.characterId === verdict.characterId);
    const candidate = entry?.candidates?.find((item) => item.blindLabel === verdict.winnerLabel);
    if (!candidate || nonEmpty(candidate.previewSha256) !== verdict.previewSha256) {
      throw new Error(`${verdict.characterId}: the private mapping does not match the heard preview ${verdict.winnerLabel}.`);
    }
    const owner = selectedVoiceIds.get(candidate.voiceId);
    if (owner) throw new Error(`${owner} and ${verdict.characterId} chose the same voice; each character needs its own voice.`);
    selectedVoiceIds.set(candidate.voiceId, verdict.characterId);
    const character = mutable.characters.find((item) => item.id === verdict.characterId);
    if (!character) throw new Error(`${verdict.characterId} is no longer in the character registry.`);
    const profileId = stableProfileId(verdict.characterId, adapter);
    const otherUser = mutable.characters.find((item) => {
      if (item.id === verdict.characterId || !nonEmpty(item.voiceId)) return false;
      const voice = mutable.voices.find((profile) => profile.id === item.voiceId);
      return voice && (nonEmpty(voice.provider) || "elevenlabs") === adapter.provider
        && nonEmpty(voice.providerVoiceId) === candidate.voiceId;
    });
    if (otherUser) {
      throw new Error(`${verdict.characterId}: voice ${verdict.winnerLabel} is already the voice of ${otherUser.id}; each character needs its own voice.`);
    }
    const casting = {
      language: "ja",
      nativeJapaneseRequired: true,
      sourcePool: `${adapter.provider}-voice-catalog`,
      auditionPlanId: plan.id,
      candidateSetId: entry.candidateSetId,
      selectedCandidateLabel: verdict.winnerLabel,
      auditionCandidateCount: entry.candidates.length,
      sampleLineSha256: sha256(entry.sampleLine),
      previewSha256: verdict.previewSha256,
      previewConfirmed: true,
      selectionReason: verdict.reason,
      approvedBy,
      selectedAt,
      selectionVersion: 2,
    };
    // 書く前に、音声ゲートと同じ判定で「人が選んだ」と数えられるか確かめる。
    const classification = classifyKoyaVoiceCastingRecord(casting);
    if (classification.kind !== "human-selection") {
      throw new Error(`${verdict.characterId}: this selection would not count as a human selection (${classification.failures.join("; ")}).`);
    }
    const profile = {
      id: profileId,
      name: candidate.name || `${entry.characterName} (${adapter.provider})`,
      provider: adapter.provider,
      providerVoiceId: candidate.voiceId,
      modelId: adapter.model,
      role: entry.role,
      episodeId: plan.episodeId === "global" ? "" : plan.episodeId,
      previewUrl: "",
      source: candidate.source || `${adapter.provider}-catalog`,
      description: candidate.description,
      labels: {},
      casting,
      status: "approved-after-preview",
    };
    const profileIndex = mutable.voices.findIndex((item) => item.id === profileId);
    if (profileIndex >= 0) mutable.voices[profileIndex] = profile;
    else mutable.voices.push(profile);
    character.voiceId = profileId;
    character.voiceCasting = casting;
    entry.status = "approved";
    entry.approval = { approvedBy, selectedCandidateLabel: verdict.winnerLabel, selectedAt, voiceProfileId: profileId };
    approvals.push({
      characterId: verdict.characterId,
      characterName: entry.characterName,
      voiceProfileId: profileId,
      selectedCandidateLabel: verdict.winnerLabel,
      provider: adapter.provider,
      model: adapter.model,
    });
  }
  if (mutable.voices.length > REGISTRY_VOICE_LIMIT) {
    throw new Error(`The character registry can hold ${REGISTRY_VOICE_LIMIT} voices; this approval would make ${mutable.voices.length}. Remove unused voice profiles first.`);
  }
  const written = input.persist === false ? mutable : await writeCharacterRegistry({ projectDir }, mutable);
  plan.status = plan.entries.every((item) => item.status === "approved") ? "approved" : "partially-approved";
  plan.updatedAt = selectedAt;
  await writeJsonAtomic(paths.privateJsonPath, plan);
  return {
    status: plan.status,
    planId: plan.id,
    adapter: plan.adapter,
    approvals,
    registryRevision: written.revision,
    verdictsPath: paths.verdictsPath,
  };
}
