// Koya 制作ラインの声の人間選定ゲート（readiness-9）。
//
// 正本スキルは「声も最低2候補を匿名ラベルだけで全件実聴し、winnerLabel と理由を
// 先に保存してから対応表を開く」と定めている。ところが汎用パイプラインの
// createEpisodeManifest は、ElevenLabs の鍵があるだけで castRegistryVoices を走らせ、
// 自動で選んだ声を台帳へ書き込む。契約側の検査は voiceId の有無しか見ないので、
// 機械が選んだ声がそのまま有料音声生成へ進んでいた。
//
// ここでは「人が選んだ」と言える台帳記録を、既存の記録形式から一つに定める。
//
// 人間選定記録（voice profile の `casting`）として数えるのは、次をすべて満たすものだけ:
//   - approveVoiceLibraryCasting（匿名オーディション → 人の採用）が書く形式
//     `selectionVersion >= 2`
//   - 匿名ラベル `selectedCandidateLabel`（A, B, C... の1文字）
//   - 具体的な採用理由 `selectionReason`（4文字以上。承認CLI・匿名比較CLIと同じ下限）
//   - 採用者 `approvedBy`（自動を示す値は不可）
//   - 試聴確認 `previewConfirmed === true`
//   - 匿名候補集合 `candidateSetId` と、比較した候補数 `auditionCandidateCount >= 2`
//   - 有効な採用時刻 `selectedAt`
//   - 自動由来の印が無いこと: method / source / route / origin 等が "auto" 系でなく、
//     記録自身の id が "auto-" で始まらないこと
//
// castRegistryVoices の記録（selectionVersion 1、score / reasons / persona だけ）は
// 自動選定であり、何点であっても数えない。voice profile の id が "auto-" で始まるかは
// 判定に使わない。人の採用経路も、既存の声を持たない人物には `auto-<id>-ja` という
// id の profile を作るため、id の接頭辞は「誰が選んだか」を表さない。
//
// 匿名比較CLI（scripts/koya-blind-review.mjs）の decision.json は台帳記録ではない。
// 正本スキルのとおり「アリーナの選択は記録ではない」ので、ここでは読まない。
//
// 引き渡し束（handoff bundle）から復元した台帳には、上の記録をそのまま載せられない。
// 採用理由・採用者・候補集合IDは送り手端末の私的な記録なので、束は人物承認
// （stripPrivateApproval）と同じ形で伏せた「人の選定の証明」だけを運ぶ:
//   { attestation: "koya-handoff-voice-selection-v1", selectionVersion, selectedAt,
//     previewConfirmed: true, auditionCandidateCount, candidateSetId(sha256),
//     winnerLabelRecorded: true, selectionReason(sha256), approvedBy(sha256) }
// 採用ラベル（A〜Eの1文字）は書かない。1文字の hash は何も隠さず、人物承認も
// ラベルを空にして運んでいるため。この形は送り手の export が「上の人の選定記録」
// と判定したものからしか作らず、束全体は Channel Pack の署名で守られる。
// 受け手ではキーの集合と各値の形を厳密に確かめ、それ以外の形は数えない。

import { createHash } from "node:crypto";

export const KOYA_VOICE_SELECTION_GUARD_VERSION = "koya-voice-selection-guard-v1";
export const KOYA_HANDOFF_VOICE_SELECTION_ATTESTATION = "koya-handoff-voice-selection-v1";
export const KOYA_VOICE_SELECTION_REQUIRED_CODE = "KOYA_VOICE_SELECTION_REQUIRED";
export const MINIMUM_VOICE_SELECTION_REASON_LENGTH = 4;
export const MINIMUM_VOICE_SELECTION_CANDIDATES = 2;
export const VALIDATION_CANARY_VOICE_SCOPE = "validation-canary-provisional";

const AUTOMATIC_ORIGIN_KEYS = Object.freeze([
  "method",
  "source",
  "route",
  "origin",
  "selectionMethod",
  "selectionSource",
  "castingMethod",
]);
const RECORD_ID_KEYS = Object.freeze(["id", "recordId", "selectionId"]);
const AUTOMATIC_VALUE = /^auto(?:matic|mated|cast)?(?:$|[-_:\s])/iu;
const PORTABLE_ATTESTATION_KEYS = Object.freeze([
  "approvedBy",
  "attestation",
  "auditionCandidateCount",
  "candidateSetId",
  "previewConfirmed",
  "selectedAt",
  "selectionReason",
  "selectionVersion",
  "winnerLabelRecorded",
]);
const PORTABLE_DIGEST_PREFIX = Object.freeze({
  approvedBy: "source-approver-sha256",
  candidateSetId: "source-candidate-set-sha256",
  selectionReason: "source-reason-sha256",
});
// A character restored from a handoff bundle carries its approval in this
// hashed form (stripPrivateApproval); a locally approved character never does.
const HANDOFF_APPROVER = /^source-approver-sha256:[a-f0-9]{64}$/u;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function portableDigest(prefix, value) {
  const text = nonEmpty(value);
  return text ? `${prefix}:${createHash("sha256").update(text).digest("hex")}` : "";
}

function isNarrationRow(utterance) {
  return utterance?.speakerId === "narration" || utterance?.preset === "narration";
}

function automaticMarkers(record) {
  const markers = [];
  for (const key of AUTOMATIC_ORIGIN_KEYS) {
    const value = nonEmpty(record[key]);
    if (value && AUTOMATIC_VALUE.test(value)) markers.push(`${key}=${value}`);
  }
  for (const key of RECORD_ID_KEYS) {
    const value = nonEmpty(record[key]);
    if (/^auto-/iu.test(value)) markers.push(`${key}=${value}`);
  }
  const approvedBy = nonEmpty(record.approvedBy);
  if (approvedBy && (AUTOMATIC_VALUE.test(approvedBy) || /^system$/iu.test(approvedBy))) {
    markers.push(`approvedBy=${approvedBy}`);
  }
  return markers;
}

/**
 * Why a value is not exactly the portable handoff voice-selection attestation
 * (see the header). An empty list means it is.
 */
export function portableKoyaVoiceSelectionAttestationFailures(record) {
  if (!isPlainObject(record)) return ["not an object"];
  const failures = [];
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify(PORTABLE_ATTESTATION_KEYS)) {
    failures.push(`fields must be exactly ${PORTABLE_ATTESTATION_KEYS.join(", ")}`);
  }
  if (record.attestation !== KOYA_HANDOFF_VOICE_SELECTION_ATTESTATION) failures.push("unsupported attestation version");
  if (!Number.isSafeInteger(record.selectionVersion) || record.selectionVersion < 2) {
    failures.push("selectionVersion must be an integer of at least 2");
  }
  if (typeof record.selectedAt !== "string" || !Number.isFinite(Date.parse(record.selectedAt))) {
    failures.push("selectedAt must be a valid time");
  }
  if (record.previewConfirmed !== true) failures.push("previewConfirmed must be true");
  if (!Number.isSafeInteger(record.auditionCandidateCount)
    || record.auditionCandidateCount < MINIMUM_VOICE_SELECTION_CANDIDATES) {
    failures.push(`auditionCandidateCount must be an integer of at least ${MINIMUM_VOICE_SELECTION_CANDIDATES}`);
  }
  if (record.winnerLabelRecorded !== true) failures.push("winnerLabelRecorded must be true");
  for (const [key, prefix] of Object.entries(PORTABLE_DIGEST_PREFIX)) {
    if (!new RegExp(`^${prefix}:[a-f0-9]{64}$`, "u").test(typeof record[key] === "string" ? record[key] : "")) {
      failures.push(`${key} must be a ${prefix} digest`);
    }
  }
  return failures;
}

/**
 * The only voice casting data a handoff bundle may carry: the sanitized proof
 * of a complete human selection, or null. An already portable attestation (a
 * registry that was itself restored from a bundle) is carried unchanged.
 */
export function portableKoyaVoiceSelectionAttestation(record) {
  if (!isPlainObject(record) || classifyKoyaVoiceCastingRecord(record).kind !== "human-selection") return null;
  if (record.attestation === KOYA_HANDOFF_VOICE_SELECTION_ATTESTATION) {
    return Object.fromEntries(PORTABLE_ATTESTATION_KEYS.map((key) => [key, record[key]]));
  }
  return {
    approvedBy: portableDigest(PORTABLE_DIGEST_PREFIX.approvedBy, record.approvedBy),
    attestation: KOYA_HANDOFF_VOICE_SELECTION_ATTESTATION,
    auditionCandidateCount: Number(record.auditionCandidateCount),
    candidateSetId: portableDigest(PORTABLE_DIGEST_PREFIX.candidateSetId, record.candidateSetId),
    previewConfirmed: true,
    selectedAt: nonEmpty(record.selectedAt),
    selectionReason: portableDigest(PORTABLE_DIGEST_PREFIX.selectionReason, record.selectionReason),
    selectionVersion: Number(record.selectionVersion),
    winnerLabelRecorded: true,
  };
}

/**
 * Classify one voice casting record.
 *
 * kind:
 *   - "human-selection": a complete human blind selection (see the header), or
 *     its exact portable handoff attestation (form "handoff-attestation").
 *   - "automatic": an automatic casting record, or a record carrying an automatic marker.
 *   - "incomplete": some human fields are present but the record is not complete.
 *   - "missing": no casting record at all (for example a handoff registry
 *     exported before bundles carried the attestation).
 */
export function classifyKoyaVoiceCastingRecord(record) {
  if (!isPlainObject(record) || Object.keys(record).length === 0) {
    return { kind: "missing", failures: ["no casting record"] };
  }
  const markers = automaticMarkers(record);
  if (markers.length > 0) {
    return { kind: "automatic", failures: [`automatic casting marker (${markers.join(", ")})`] };
  }
  if (Object.hasOwn(record, "attestation")) {
    const failures = portableKoyaVoiceSelectionAttestationFailures(record);
    return failures.length === 0
      ? { kind: "human-selection", form: "handoff-attestation", failures }
      : { kind: "incomplete", failures: failures.map((failure) => `handoff voice selection attestation: ${failure}`) };
  }
  const label = nonEmpty(record.selectedCandidateLabel);
  const reason = nonEmpty(record.selectionReason);
  const approvedBy = nonEmpty(record.approvedBy);
  const candidateSetId = nonEmpty(record.candidateSetId);
  const failures = [];
  if (!(Number(record.selectionVersion) >= 2)) {
    failures.push("not a human blind-selection record (selectionVersion < 2)");
  }
  if (!/^[A-Z]$/u.test(label)) failures.push("no anonymous winner label (selectedCandidateLabel)");
  if (Array.from(reason).length < MINIMUM_VOICE_SELECTION_REASON_LENGTH) {
    failures.push("no concrete selection reason (selectionReason)");
  }
  if (!approvedBy) failures.push("no human approver (approvedBy)");
  if (record.previewConfirmed !== true) failures.push("candidates were not confirmed as heard (previewConfirmed)");
  if (!candidateSetId) failures.push("no anonymous candidate set (candidateSetId)");
  if (!(Number(record.auditionCandidateCount) >= MINIMUM_VOICE_SELECTION_CANDIDATES)) {
    failures.push(`fewer than ${MINIMUM_VOICE_SELECTION_CANDIDATES} compared candidates (auditionCandidateCount)`);
  }
  if (!Number.isFinite(Date.parse(nonEmpty(record.selectedAt)))) failures.push("no valid selection time (selectedAt)");
  if (failures.length === 0) return { kind: "human-selection", form: "blind-selection", failures };
  const hasHumanField = Boolean(label || reason || approvedBy || candidateSetId || record.previewConfirmed === true);
  if (!hasHumanField) {
    return {
      kind: "automatic",
      failures: ["automatic casting record (no anonymous winner label, selection reason or human approver)"],
    };
  }
  return { kind: "incomplete", failures };
}

export function isHumanKoyaVoiceSelection(record) {
  return classifyKoyaVoiceCastingRecord(record).kind === "human-selection";
}

function findRegisteredCharacter(registry, speakerId) {
  const characters = Array.isArray(registry?.characters) ? registry.characters : [];
  const requested = nonEmpty(speakerId);
  if (!requested) return null;
  return characters.find((character) => character?.id === requested)
    || characters.find((character) => character?.name === requested)
    || characters.find((character) => Array.isArray(character?.aliases) && character.aliases.includes(requested))
    || null;
}

function canaryProfileIds(validationCanary) {
  if (validationCanary?.active !== true || validationCanary.pass !== true
    || validationCanary.publicationEligible !== false) {
    return null;
  }
  const mapping = isPlainObject(validationCanary.provisionalVoiceProfileByCastId)
    ? validationCanary.provisionalVoiceProfileByCastId
    : {};
  return new Set(Object.values(mapping).map(nonEmpty).filter(Boolean));
}

/**
 * Audit every speaking character of a Koya manifest (and the protagonist, whose
 * voice narration uses) against the registry's human selection records.
 *
 * `validationCanary` must be the policy recomputed from the frozen episode
 * override (resolveKoyaValidationCanary), never the manifest's own copy: only a
 * passing, non-publication-eligible canary may speak with its declared
 * provisional profiles, and only on lines the canary bound to them.
 */
export function auditKoyaVoiceSelections(input = {}) {
  const manifest = input.manifest || {};
  const registry = input.registry || {};
  const narrationVoicePolicy = nonEmpty(input.narrationVoicePolicy)
    || nonEmpty(manifest.production?.koyaContract?.narrationVoicePolicy);
  const voices = Array.isArray(registry.voices) ? registry.voices : [];
  const voiceById = new Map(voices.map((voice) => [voice?.id, voice]));
  const canaryProfiles = canaryProfileIds(input.validationCanary);
  const utterances = Array.isArray(manifest.utterances) ? manifest.utterances : [];
  // 契約の台詞 adapter が分かるときは、声の提供元も合っていなければ通さない。
  // ElevenLabs の声IDをオトシゴへ（またはその逆へ）送ると、有料の依頼が必ず失敗する。
  const dialogueProvider = nonEmpty(input.dialogueAdapter?.provider);

  const groups = new Map();
  for (const utterance of utterances) {
    if (isNarrationRow(utterance)) continue;
    const speakerId = nonEmpty(utterance?.speakerId);
    if (!speakerId) continue;
    if (!groups.has(speakerId)) {
      groups.set(speakerId, {
        speakerId,
        speakerName: nonEmpty(utterance.speakerName),
        dialogueRows: [],
        narrationRows: [],
        protagonist: false,
      });
    }
    groups.get(speakerId).dialogueRows.push(utterance);
  }

  const narrationRows = utterances.filter(isNarrationRow);
  const protagonistSpeakerId = nonEmpty(manifest.production?.narrationVoiceBinding?.protagonistSpeakerId)
    || nonEmpty(manifest.production?.protagonistSpeakerId);
  const speakers = [];
  if (narrationRows.length > 0 && narrationVoicePolicy === "protagonist-voice") {
    const protagonist = protagonistSpeakerId ? groups.get(protagonistSpeakerId) : null;
    if (protagonist) {
      protagonist.protagonist = true;
      protagonist.narrationRows = narrationRows;
    } else {
      speakers.push({
        characterId: protagonistSpeakerId || "narration",
        speakerId: protagonistSpeakerId || "narration",
        speakerName: "",
        protagonist: true,
        registered: false,
        registrySource: "",
        registryEpisodeId: "",
        voiceProfileId: "",
        voiceId: "",
        selectionKind: "missing",
        pass: false,
        failures: [protagonistSpeakerId
          ? `narration is bound to protagonist ${protagonistSpeakerId}, who has no dialogue line in this manifest`
          : "narration has no protagonist voice binding; pass --protagonist-speaker-id and rerun prepare"],
      });
    }
  }

  for (const group of groups.values()) {
    const character = findRegisteredCharacter(registry, group.speakerId);
    const characterId = nonEmpty(character?.id) || group.speakerId;
    const failures = [];
    const allRows = [...group.dialogueRows, ...group.narrationRows];
    const profileIds = [...new Set(allRows.map((row) => nonEmpty(row.voiceProfileId)))];
    const providerIds = [...new Set(allRows.map((row) => nonEmpty(row.voiceId)))];
    const voiceProfileId = profileIds.length === 1 ? profileIds[0] : "";
    const voiceId = providerIds.length === 1 ? providerIds[0] : "";
    let selectionKind = "missing";
    if (!character) failures.push("not registered in the character registry");
    if (profileIds.includes("") || providerIds.includes("")) {
      failures.push("no voice is assigned to every line");
    } else if (profileIds.length > 1 || providerIds.length > 1) {
      failures.push(`lines use different voices (${profileIds.join(", ")})`);
    }
    const canaryBound = Boolean(canaryProfiles)
      && group.dialogueRows.length > 0
      && group.dialogueRows.every((row) => row.voiceApprovalScope === VALIDATION_CANARY_VOICE_SCOPE)
      && Boolean(voiceProfileId)
      && canaryProfiles.has(voiceProfileId);
    const profile = voiceProfileId ? voiceById.get(voiceProfileId) : null;
    if (voiceProfileId && !profile) {
      failures.push(`voice profile ${voiceProfileId} is not in the character registry`);
    } else if (profile) {
      const providerVoiceId = nonEmpty(profile.providerVoiceId) || nonEmpty(profile.elevenLabsVoiceId);
      if (voiceId && providerVoiceId !== voiceId) {
        failures.push(`manifest voice ${voiceId} differs from registry profile ${voiceProfileId} (${providerVoiceId || "none"}); rerun prepare`);
      }
      const profileProvider = nonEmpty(profile.provider) || "elevenlabs";
      if (dialogueProvider && profileProvider !== dialogueProvider) {
        failures.push(`voice profile ${voiceProfileId} is a ${profileProvider} voice, but the contract speaks with ${dialogueProvider}; select a ${dialogueProvider} voice for this character`);
      }
      if (canaryBound) {
        // The frozen canary override named this provisional profile for a
        // non-public preview; it is reported as such, never as a selection.
        selectionKind = VALIDATION_CANARY_VOICE_SCOPE;
      } else {
        if (character && nonEmpty(character.voiceId) !== voiceProfileId) {
          failures.push(`registry character now uses voice profile ${nonEmpty(character.voiceId) || "(none)"}, not ${voiceProfileId}; rerun prepare`);
        }
        const selection = classifyKoyaVoiceCastingRecord(profile.casting);
        selectionKind = selection.kind;
        if (selection.kind !== "human-selection") {
          failures.push(`voice profile ${voiceProfileId} has no human selection record (${selection.failures.join("; ")})`);
        }
        if (isPlainObject(character?.voiceCasting) && Object.keys(character.voiceCasting).length > 0) {
          const mirror = classifyKoyaVoiceCastingRecord(character.voiceCasting);
          if (mirror.kind === "automatic") {
            failures.push("registry character voiceCasting is an automatic casting record");
          }
        }
      }
    }
    speakers.push({
      characterId,
      speakerId: group.speakerId,
      speakerName: group.speakerName,
      protagonist: group.protagonist,
      registered: Boolean(character),
      registrySource: !character ? "" : HANDOFF_APPROVER.test(nonEmpty(character.approval?.approvedBy)) ? "handoff-bundle" : "local",
      registryEpisodeId: nonEmpty(character?.episodeId),
      voiceProfileId,
      voiceId,
      selectionKind,
      pass: failures.length === 0,
      failures,
    });
  }

  const pending = speakers.filter((entry) => !entry.pass);
  return {
    version: KOYA_VOICE_SELECTION_GUARD_VERSION,
    pass: pending.length === 0,
    narrationVoicePolicy,
    protagonistSpeakerId,
    speakers,
    pendingCharacterIds: [...new Set(pending.map((entry) => entry.characterId))],
  };
}

function shellArgument(value) {
  const text = String(value ?? "");
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

const HANDOFF_SOURCE_PROJECT = "<channel-pack source project>";

function auditionCommands(byRegistryEpisode, { projectFlag, pathsFor, koyaRoute = false }) {
  const commands = [];
  for (const [registryEpisodeId, ids] of byRegistryEpisode) {
    const { planPath, selectionsPath, candidatesPath } = pathsFor(registryEpisodeId);
    if (koyaRoute) {
      const episodeFlag = `--episode-id ${shellArgument(registryEpisodeId)}`;
      commands.push(
        `node scripts/koya-manga-video.mjs voice-audition${projectFlag} ${episodeFlag} --character-ids ${shellArgument([...ids].join(","))} --candidates-path ${candidatesPath}`,
        `node scripts/koya-manga-video.mjs voice-audition${projectFlag} ${episodeFlag} --candidates-path ${candidatesPath} --confirm-paid-preview`,
        `node scripts/koya-manga-video.mjs voice-approve${projectFlag} ${episodeFlag} --selections-path ${selectionsPath} --approved-by <your name>`,
      );
      continue;
    }
    commands.push(
      `node scripts/build-manga-video.mjs voice-library-audition${projectFlag} --episode-id ${shellArgument(registryEpisodeId)} --character-ids ${shellArgument([...ids].join(","))}`,
      `node scripts/build-manga-video.mjs voice-library-approve${projectFlag} --plan-path ${planPath} --selections-path ${selectionsPath} --confirmed-voice-adds`,
    );
  }
  return commands;
}

/**
 * ElevenLabs 以外の台詞 adapter（オトシゴ等）は Voice Library を持たないので、
 * Koya CLI の voice-audition / voice-approve（候補ファイル → 有料の試聴 → 人の採用）へ案内する。
 */
function isKoyaAuditionRoute(options = {}) {
  const provider = nonEmpty(options.dialogueAdapter?.provider);
  return Boolean(provider) && provider !== "elevenlabs";
}

/**
 * Commands that record a human selection with the existing human route
 * (anonymous ElevenLabs audition, then approval with winnerLabel + reason),
 * grouped by the registry episode the characters belong to.
 *
 * A character restored from a signed handoff bundle is replaced from that
 * bundle on every Job run, so its selection has to be recorded where the
 * Channel Pack is built; those commands are returned separately
 * (`handoffCommands`) and point at that project instead of this one.
 */
export function koyaVoiceSelectionCommands(audit, options = {}) {
  const projectDir = nonEmpty(options.projectDir);
  const projectFlag = projectDir ? ` --project-dir ${shellArgument(projectDir)}` : "";
  const auditionPaths = typeof options.auditionPaths === "function" ? options.auditionPaths : null;
  const local = new Map();
  const handoff = new Map();
  const unregistered = [];
  for (const entry of audit?.speakers || []) {
    if (entry.pass) continue;
    if (!entry.registered) {
      unregistered.push(entry.characterId);
      continue;
    }
    const target = entry.registrySource === "handoff-bundle" ? handoff : local;
    const key = entry.registryEpisodeId || "global";
    if (!target.has(key)) target.set(key, new Set());
    target.get(key).add(entry.characterId);
  }
  const koyaRoute = isKoyaAuditionRoute(options);
  const koyaAuditionPaths = typeof options.koyaAuditionPaths === "function" ? options.koyaAuditionPaths : null;
  const commands = auditionCommands(local, {
    projectFlag,
    koyaRoute,
    pathsFor: (registryEpisodeId) => {
      if (koyaRoute) {
        const paths = koyaAuditionPaths ? koyaAuditionPaths(registryEpisodeId) : null;
        return {
          candidatesPath: shellArgument(paths?.candidatesPath || `canvas/voice-casting/${registryEpisodeId}-koya-candidates.json`),
          selectionsPath: shellArgument(paths?.selectionsPath || `canvas/voice-casting/${registryEpisodeId}-koya-selections.json`),
        };
      }
      const paths = auditionPaths ? auditionPaths(registryEpisodeId) : null;
      return {
        planPath: shellArgument(paths?.jsonPath || `canvas/voice-casting/${registryEpisodeId}-elevenlabs-audition.json`),
        selectionsPath: shellArgument(paths?.selectionsPath || `canvas/voice-casting/${registryEpisodeId}-elevenlabs-selections.json`),
      };
    },
  });
  const handoffCommands = auditionCommands(handoff, {
    projectFlag: ` --project-dir ${HANDOFF_SOURCE_PROJECT}`,
    koyaRoute,
    pathsFor: (registryEpisodeId) => ({
      planPath: `${HANDOFF_SOURCE_PROJECT}/canvas/voice-casting/${shellArgument(registryEpisodeId)}-elevenlabs-audition.json`,
      selectionsPath: `${HANDOFF_SOURCE_PROJECT}/canvas/voice-casting/${shellArgument(registryEpisodeId)}-${koyaRoute ? "koya" : "elevenlabs"}-selections.json`,
      candidatesPath: `${HANDOFF_SOURCE_PROJECT}/canvas/voice-casting/${shellArgument(registryEpisodeId)}-koya-candidates.json`,
    }),
  });
  if (handoffCommands.length > 0) {
    handoffCommands.push(
      `node scripts/koya-manga-video.mjs handoff-export --project-dir ${HANDOFF_SOURCE_PROJECT} --output-dir <new handoff bundle>`,
      "node scripts/channel-pack.mjs sign --source-dir <new handoff bundle> --output-dir <new signed envelope> --harness koya-manga-video --payload-kind koya-handoff ...",
      "node scripts/run-video-harness.mjs start --harness koya-manga-video --channel-pack <new signed envelope> ...",
    );
  }
  return {
    commands,
    handoffCommands,
    localCharacterIds: [...local.values()].flatMap((ids) => [...ids]),
    handoffCharacterIds: [...handoff.values()].flatMap((ids) => [...ids]),
    unregisteredCharacterIds: unregistered,
  };
}

export function formatKoyaVoiceSelectionError(audit, options = {}) {
  const pending = (audit?.speakers || []).filter((entry) => !entry.pass);
  const lines = [
    `Koya speech stopped before any paid request: ${pending.length} speaking character(s) have no human-selected voice.`,
    `Characters needing a voice selection: ${(audit?.pendingCharacterIds || []).join(", ")}`,
  ];
  for (const entry of pending) {
    const label = entry.speakerName && entry.speakerName !== entry.characterId
      ? `${entry.characterId} (${entry.speakerName})`
      : entry.characterId;
    lines.push(`- ${label}${entry.protagonist ? " [protagonist; narration uses this voice]" : ""}: ${entry.failures.join("; ")}`);
  }
  const {
    commands,
    handoffCommands,
    localCharacterIds,
    handoffCharacterIds,
    unregisteredCharacterIds,
  } = koyaVoiceSelectionCommands(audit, options);
  if (unregisteredCharacterIds.length > 0) {
    lines.push(`Register these speakers in the character registry first (character-register): ${unregisteredCharacterIds.join(", ")}`);
  }
  const howToSelect = isKoyaAuditionRoute(options)
    ? `write the candidates file (one sampleLine from the script and 2 to 5 ${nonEmpty(options.dialogueAdapter?.provider)} voice ids per character), make the paid previews, listen to every anonymous candidate, fill winnerLabel, selectionReason and previewConfirmed=true in the selections file, then approve with your name.`
    : "listen to every anonymous candidate (at least two), fill winnerLabel, selectionReason, approvedBy and previewConfirmed=true in the selections file, then approve. These two casting actions only write the voice record; the rest of that legacy script stays benchmark-only.";
  if (commands.length > 0) {
    lines.push(
      `Record a human selection in this project for ${localCharacterIds.join(", ")}: ${howToSelect}`,
      ...commands.map((command) => `  ${command}`),
    );
  }
  if (commands.length > 0 || unregisteredCharacterIds.length > 0) {
    const jobProjectDir = nonEmpty(options.jobProjectDir);
    const resume = [
      "node scripts/run-video-harness.mjs resume",
      `--job-id ${nonEmpty(options.jobId) ? shellArgument(options.jobId) : "<job id>"}`,
      `--project-dir ${jobProjectDir ? shellArgument(jobProjectDir) : "<project that holds the Job>"}`,
      "--confirmed",
    ].join(" ");
    lines.push(`Then resume the same Video Harness Job so prepare rebuilds the manifest from the registry: ${resume}`);
  }
  if (handoffCommands.length > 0) {
    lines.push(
      `These characters come from the signed handoff bundle: ${handoffCharacterIds.join(", ")}. Every Job run restores them from that bundle, so a selection recorded in this workspace is replaced and resuming this Job cannot pass.`
        + ` On the machine that builds the Channel Pack, ${howToSelect} Then export the handoff bundle again (it carries a sanitized record of the selection), sign it, and start a new Video Harness Job with the new pack:`,
      ...handoffCommands.map((command) => `  ${command}`),
    );
  }
  lines.push("Automatic voice casting never counts as a selection on the Koya path.");
  return lines.join("\n");
}

export function assertKoyaHumanVoiceSelections(input = {}) {
  const audit = auditKoyaVoiceSelections(input);
  if (audit.pass) return audit;
  const error = new Error(formatKoyaVoiceSelectionError(audit, input));
  error.code = KOYA_VOICE_SELECTION_REQUIRED_CODE;
  error.characterIds = [...audit.pendingCharacterIds];
  error.audit = audit;
  throw error;
}
