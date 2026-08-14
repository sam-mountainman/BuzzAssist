import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { readCharacterRegistry } from "./characterRegistry.mjs";
import {
  buildApprovedIdentityPackJobs,
  finalizeApprovedCharacter,
  findWorkflowCandidate,
  findWorkflowCast,
  getCharacterWorkflow,
  readCharacterWorkflowStore,
} from "./characterPipeline.mjs";
import { writeJsonAtomic } from "./canvasScene.mjs";
import { recordBlindCandidateVerdict } from "./mangaBlindCandidateStore.mjs";
import {
  applyKoyaSpeechPronunciations,
  generateKoyaDialogueSpeech,
} from "./koyaDialogueSpeech.mjs";
import {
  applyKoyaContractToManifest,
  applyKoyaNarrationVoicePolicy,
  auditManifestAgainstKoyaContract,
  resolveKoyaProtagonistSpeaker,
  resolveKoyaMangaProductionContract,
} from "./koyaMangaProductionContract.mjs";
import { resolveKoyaAgentProvenance } from "./koyaMangaProvenance.mjs";
import { mergeMangaQualityIncidentLedgers } from "./mangaQualityHarness.mjs";
import {
  applyMangaCameraGrammarToShot,
  applyMangaCameraGrammarToPanelLayout,
  mangaCameraModeFamily,
} from "./mangaPageCameraGrammar.mjs";
import {
  createMangaScriptImagePlan,
  runMangaScriptImagePipeline,
} from "./mangaScriptImagePipeline.mjs";
import { generateImageMedia } from "./mediaGeneration.mjs";
import {
  compileEpisodeTiming,
  createEpisodeManifest,
  refreshEpisodeBubbleOverlays,
  renderEpisodeVideo,
} from "./mangaVideoPipeline.mjs";

const execFile = promisify(execFileCallback);

const nonEmpty = (value) => typeof value === "string" && value.trim() ? value.trim() : "";

export function recommendedKoyaRenderConcurrency({
  requested,
  cameraOversample = 1,
  cpuCount = cpus().length || 1,
  totalMemoryBytes = totalmem(),
} = {}) {
  if (Number.isFinite(Number(requested))) {
    return Math.max(1, Math.min(4, Math.round(Number(requested))));
  }
  const cpuBound = Math.max(1, Math.min(4, Math.floor(Number(cpuCount) || 1)));
  if (Number(cameraOversample) < 3) return cpuBound;
  // A 3x camera pass expands every 1080p source to 5760x3240 before zoompan.
  // Keep roughly 6 GiB of total system memory per concurrent ffmpeg so long
  // episodes do not turn four quality renders into memory-pressure thrashing.
  const memoryBound = Math.max(1, Math.floor(Number(totalMemoryBytes) / (6 * 1024 ** 3)));
  return Math.min(cpuBound, memoryBound);
}

export function koyaSpeechPronunciationsFromCharacterBible(characterBible = {}) {
  const bySource = new Map();
  for (const character of characterBible.cast || []) {
    for (const [from, to] of Object.entries(character.pronunciationMap || {})) {
      if (nonEmpty(from) && nonEmpty(to)) bySource.set(nonEmpty(from), nonEmpty(to));
    }
    if (nonEmpty(character.name) && nonEmpty(character.pronunciation)) {
      bySource.set(nonEmpty(character.name), nonEmpty(character.pronunciation));
    }
  }
  return [...bySource.entries()]
    .sort(([left], [right]) => Array.from(right).length - Array.from(left).length)
    .map(([from, to]) => ({ from, to }));
}

function applyKoyaCharacterBiblePronunciations(manifestInput, characterBible) {
  const manifest = structuredClone(manifestInput);
  const merged = new Map((manifest.speech?.pronunciations || []).map((entry) => [entry.from, entry.to]));
  for (const entry of koyaSpeechPronunciationsFromCharacterBible(characterBible)) merged.set(entry.from, entry.to);
  manifest.speech = {
    ...(manifest.speech || {}),
    pronunciations: [...merged.entries()]
      .filter(([from, to]) => nonEmpty(from) && nonEmpty(to))
      .sort(([left], [right]) => Array.from(right).length - Array.from(left).length)
      .map(([from, to]) => ({ from, to })),
  };
  return manifest;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

function episodePaths(projectDir, episodeId) {
  const root = resolve(projectDir);
  const episodeDir = join(root, "canvas/manga-videos", episodeId);
  const assetDir = join(root, "canvas/assets", episodeId);
  return {
    projectDir: root,
    canvasDir: join(root, "canvas"),
    episodeDir,
    assetDir,
    manifestPath: join(episodeDir, "episode-manifest.json"),
    statePath: join(episodeDir, "koya-production-state.json"),
    contractSnapshotPath: join(episodeDir, "koya-contract-resolved.json"),
    imagePlanPath: join(assetDir, "script-image-plan.json"),
    imageLedgerPath: join(assetDir, "script-image-ledger.json"),
    sourceFaceReportPath: join(episodeDir, "source-face-placement.json"),
  };
}

async function updateState(paths, patch) {
  let previous = {};
  try { previous = await readJson(paths.statePath); } catch {}
  const state = {
    version: "koya-production-state-v1",
    episodeId: patch.episodeId || previous.episodeId,
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(paths.episodeDir, { recursive: true });
  await writeJsonAtomic(paths.statePath, state);
  return state;
}

export async function planKoyaMangaProduction(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.scriptPath && !options.scriptText) throw new Error("scriptPath or scriptText is required.");
  const scriptText = nonEmpty(options.scriptText) || await readFile(resolve(options.scriptPath), "utf8");
  const registry = await readCharacterRegistry({ projectDir });
  const preliminary = createMangaScriptImagePlan({
    scriptText,
    title: options.title,
    episodeId: options.episodeId,
    registry,
    canvasDir: join(projectDir, "canvas"),
    model: options.imageModel,
  });
  const episodeId = preliminary.episodeId || preliminary.manifest.id;
  const paths = episodePaths(projectDir, episodeId);
  const plan = preliminary.assetDir === paths.assetDir
    ? preliminary
    : createMangaScriptImagePlan({
        scriptText,
        title: options.title,
        episodeId,
        registry,
        canvasDir: paths.canvasDir,
        assetDir: paths.assetDir,
        model: options.imageModel,
      });
  plan.sourceScript = {
    path: options.scriptPath ? resolve(options.scriptPath) : "",
    text: scriptText,
  };
  const resolved = await resolveKoyaMangaProductionContract({
    projectDir,
    episodeId,
    contractPath: options.contractPath,
    overridePath: options.overridePath,
  });
  const previousPlan = await exists(paths.imagePlanPath) ? await readJson(paths.imagePlanPath) : null;
  const previousState = await exists(paths.statePath) ? await readJson(paths.statePath) : null;
  const generatorProvenance = previousPlan?.production?.generatorProvenance
    || previousState?.generatorProvenance
    || resolveKoyaAgentProvenance({
      role: "generator",
      host: options.generatorHost,
      id: options.generatorId,
      contextId: options.generatorContextId,
    });
  if (previousState?.status === resolved.contract.lifecycle.completionStatus && options.allowCompletedReuse !== true) {
    throw new Error(
      `Episode ID ${episodeId} is already complete. Choose a new episode ID so the approved MP4 and assets remain untouched.`,
    );
  }
  if (previousPlan?.scriptSha256 && previousPlan.scriptSha256 !== plan.scriptSha256) {
    throw new Error(
      `Episode ID ${episodeId} already belongs to a different script. Choose a new episode ID; existing assets were not overwritten.`,
    );
  }
  const requestedCharacterBiblePath = options.characterBiblePath
    || previousPlan?.production?.characterBiblePath
    || previousState?.characterBiblePath
    || "";
  if (requestedCharacterBiblePath) {
    const characterBiblePath = resolve(requestedCharacterBiblePath);
    const characterBible = await readJson(characterBiblePath);
    if (characterBible.episodeId && characterBible.episodeId !== episodeId) {
      throw new Error(`Character bible episode ID mismatch: ${characterBible.episodeId} != ${episodeId}`);
    }
    if (!Array.isArray(characterBible.cast) || characterBible.cast.length === 0) {
      throw new Error("Character bible must contain a non-empty cast array.");
    }
    plan.production = {
      ...(plan.production || {}),
      characterBiblePath,
      characterBibleVersion: characterBible.version || "",
    };
  }
  plan.production = {
    ...(plan.production || {}),
    generatorProvenance,
  };
  const incidentSeedPath = join(projectDir, "config", "koya-manga-quality-incidents.json");
  const incidentLedgerPath = join(paths.canvasDir, "manga-quality-harness", "incident-ledger.json");
  if (await exists(incidentSeedPath) || await exists(incidentLedgerPath)) {
    const incidentLedger = mergeMangaQualityIncidentLedgers(
      await exists(incidentSeedPath) ? await readJson(incidentSeedPath) : { incidents: [] },
      await exists(incidentLedgerPath) ? await readJson(incidentLedgerPath) : { incidents: [] },
    );
    plan.production.channelDirectives = {
      ...(plan.production.channelDirectives || {}),
      knownIncidents: (incidentLedger.incidents || [])
        .filter((incident) => ["instruction", "hard-gate"].includes(incident.promotion))
        .map((incident) => `${incident.promotion}:${incident.rule}:${incident.failure}`),
    };
    plan.production.incidentLedger = {
      seedPath: incidentSeedPath,
      runtimePath: incidentLedgerPath,
      version: incidentLedger.version,
      promotedIncidentCount: plan.production.channelDirectives.knownIncidents.length,
    };
  }
  const hasNarration = (plan.manifest?.utterances || []).some((entry) => (
    entry.speakerId === "narration" || entry.preset === "narration"
  ));
  if (resolved.contract.audio.narrationVoicePolicy === "protagonist-voice" && hasNarration) {
    const protagonist = resolveKoyaProtagonistSpeaker(
      plan.manifest,
      options.protagonistSpeakerId
        || previousPlan?.production?.protagonistSpeakerName
        || previousPlan?.production?.protagonistSpeakerId
        || previousState?.protagonistSpeakerName
        || previousState?.protagonistSpeakerId,
    );
    plan.production = {
      ...(plan.production || {}),
      protagonistSpeakerId: protagonist.speakerId,
      protagonistSpeakerName: protagonist.speakerName,
      narrationVoicePolicy: "protagonist-voice",
    };
  }
  await Promise.all([
    mkdir(paths.assetDir, { recursive: true }),
    mkdir(paths.episodeDir, { recursive: true }),
  ]);
  await Promise.all([
    writeJsonAtomic(paths.imagePlanPath, plan),
    writeJsonAtomic(paths.contractSnapshotPath, {
      version: resolved.contract.version,
      digest: resolved.digest,
      contractPath: resolved.contractPath,
      episodeOverridePath: resolved.episodeOverridePath,
      contract: resolved.contract,
    }),
  ]);
  const state = await updateState(paths, {
    episodeId,
    status: "planned",
    currentStage: "images",
    scriptPath: options.scriptPath ? resolve(options.scriptPath) : "",
    imagePlanPath: paths.imagePlanPath,
    scriptSha256: plan.scriptSha256,
    contractSnapshotPath: paths.contractSnapshotPath,
    contractDigest: resolved.digest,
    protagonistSpeakerId: plan.production?.protagonistSpeakerId || "",
    protagonistSpeakerName: plan.production?.protagonistSpeakerName || "",
    characterBiblePath: plan.production?.characterBiblePath || "",
    generatorProvenance,
    knownRemainingIssues: [],
  });
  return { episodeId, paths, plan, resolved, state };
}

export async function generateKoyaMangaImages(options = {}) {
  const planned = await planKoyaMangaProduction(options);
  const contract = planned.resolved.contract;
  const characterBiblePath = options.characterBiblePath || planned.plan.production?.characterBiblePath || "";
  const characterBible = characterBiblePath ? await readJson(resolve(characterBiblePath)) : null;
  const result = await runMangaScriptImagePipeline({
    projectDir: planned.paths.projectDir,
    scriptPath: options.scriptPath,
    scriptText: options.scriptText,
    episodeId: planned.episodeId,
    title: options.title,
    model: options.imageModel || contract.art.imageModel,
    fallbackImageModel: options.imageFallbackModel ?? contract.art.usageLimitFallbackModel,
    qaFallbackProvider: options.qaFallbackProvider ?? contract.art.qaUsageLimitFallbackProvider,
    concurrency: options.imageConcurrency ?? contract.art.imageConcurrency,
    qaConcurrency: options.qaConcurrency ?? contract.art.qaConcurrency,
    maxRetries: options.maxRetries ?? contract.art.maximumQaRetries,
    candidateCount: options.candidateCount ?? contract.art.candidateCount,
    qaCommand: options.qaCommand,
    qaModel: options.qaModel,
    autoSemanticQa: options.autoSemanticQa !== false,
    cast: characterBible?.cast || options.cast,
    characterBible,
    protagonistSpeakerId: planned.plan.production?.protagonistSpeakerId || options.protagonistSpeakerId,
    protagonistSpeakerName: planned.plan.production?.protagonistSpeakerName || options.protagonistSpeakerName,
    retryFailed: options.retryFailed === true,
  });
  const waiting = result.status === "awaiting-character-approval";
  const failed = result.status === "failed";
  const state = await updateState(planned.paths, {
    status: waiting ? "awaiting-character-approval" : failed ? "failed" : "images-ready",
    currentStage: waiting ? "character-approval" : failed ? "images" : "source-face-placement",
    imagePlanPath: result.planPath || planned.paths.imagePlanPath,
    imageLedgerPath: result.ledgerPath || planned.paths.imageLedgerPath,
    knownRemainingIssues: waiting
      ? [{ id: "character-approval", detail: result.message, cast: result.cast }]
      : failed ? [{ id: "image-generation", detail: "One or more image jobs failed." }] : [],
  });
  if (result.planPath && result.plan) {
    result.plan.production = {
      ...(result.plan.production || {}),
      ...(planned.plan.production || {}),
    };
    result.plan.sourceScript = {
      path: options.scriptPath ? resolve(options.scriptPath) : planned.plan.sourceScript?.path || "",
      text: options.scriptText || planned.plan.sourceScript?.text || "",
    };
    await writeJsonAtomic(result.planPath, result.plan);
  }
  return { ...planned, result, state, waiting, failed };
}

export async function approveKoyaCharacterCandidate(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  if (!options.workflowId) throw new Error("workflowId is required.");
  if (!options.castId) throw new Error("castId is required.");
  if (!options.candidateLabel) throw new Error("candidateLabel is required; private candidate IDs and generation order cannot be used for approval.");
  const approvalReason = String(options.approvalReason || "").trim();
  if (approvalReason.length < 4) throw new Error("approvalReason is required and must explain why this character candidate was selected.");
  const paths = episodePaths(projectDir, options.episodeId);
  const store = await readCharacterWorkflowStore({ projectDir, canvasDir: paths.canvasDir });
  const workflow = getCharacterWorkflow(store, options.workflowId);
  if (!workflow || workflow.episodeId !== options.episodeId) {
    throw new Error(`Unknown workflow for ${options.episodeId}: ${options.workflowId}`);
  }
  const cast = findWorkflowCast(workflow, options.castId);
  if (!cast) throw new Error(`Unknown workflow character: ${options.castId}`);
  const packageCandidate = cast.candidates.find((entry) => entry.blindPublicPacketPath && entry.blindPrivateMappingPath);
  if (!packageCandidate) throw new Error(`Blind candidate package is missing for ${cast.name}.`);
  const approvedBy = options.approvedBy || "human-user";
  const verdictResult = await recordBlindCandidateVerdict({
    publicPath: packageCandidate.blindPublicPacketPath,
    privatePath: packageCandidate.blindPrivateMappingPath,
    winnerLabel: options.candidateLabel,
    decidedBy: approvedBy,
    reason: approvalReason,
  });
  const candidate = findWorkflowCandidate(cast, verdictResult.selected.id);
  if (!candidate?.assetFile) throw new Error(`Selected anonymous candidate is missing its source asset: ${options.candidateLabel}`);
  const jobs = buildApprovedIdentityPackJobs(workflow, cast, candidate, {
    model: options.imageModel,
  });
  const identityPackDir = join(paths.canvasDir, "assets", "characters", options.episodeId, "approved-identity-packs");
  await mkdir(identityPackDir, { recursive: true });
  const generated = await Promise.all(jobs.map(async (job) => {
    const media = await generateImageMedia({ ...job, imageCount: 1 });
    const buffer = media?.buffer instanceof Buffer ? media.buffer : media?.buffer ? Buffer.from(media.buffer) : null;
    if (!buffer) throw new Error(`Identity-pack generation returned no image for ${cast.name}.`);
    const assetFile = join(identityPackDir, job.fileName);
    await writeFile(assetFile, buffer);
    return { assetFile };
  }));
  const finalized = await finalizeApprovedCharacter({
    projectDir,
    canvasDir: paths.canvasDir,
    workflowId: workflow.id,
    castId: cast.id,
    candidateId: candidate.id,
    approvalReason,
    approvedBy,
    candidateLabel: verdictResult.verdict.winnerLabel,
    candidateSetId: verdictResult.verdict.setId,
    verdictDigest: verdictResult.verdict.digest,
    turnaroundResult: generated[0],
    expressionResult: generated[1],
  });
  const state = await updateState(paths, {
    status: "character-approval-in-progress",
    currentStage: "character-approval",
    knownRemainingIssues: [{ id: "character-approval", detail: "Approve every new character before scene generation." }],
  });
  return {
    episodeId: options.episodeId,
    workflowId: workflow.id,
    castId: cast.id,
    candidateLabel: verdictResult.verdict.winnerLabel,
    candidateSetId: verdictResult.verdict.setId,
    verdictPath: verdictResult.verdictPath,
    approvalReason,
    finalized,
    state,
  };
}

function viewpointForComposition(composition = {}, index = 0) {
  const elevation = String(composition.setup?.elevation || "").toLowerCase();
  const azimuth = String(composition.setup?.azimuth || "").toLowerCase();
  const shotSize = String(composition.setup?.shotSize || "").toLowerCase();
  if (/(?:top|overhead|bird)/u.test(elevation) || /(?:top|overhead)/u.test(azimuth)) return "top";
  if (azimuth.includes("left")) return "left";
  if (azimuth.includes("right") || azimuth.includes("reverse")) return "right";
  if (/(?:wide|long)/u.test(shotSize)) return "wide";
  return index % 2 === 0 ? "left" : "right";
}

export function koyaCameraModeForShot(viewpoint, movingIndex) {
  // A wide source has no left/right/top semantic direction. Applying a
  // directional mode to it creates an impossible camera contract (for
  // example, viewpoint=wide with mode=left-then-pullout). Keep the strong
  // reveal as a pure pull-out and reserve directional modes for matching
  // directional source viewpoints.
  if (viewpoint === "wide") return "pullout-only";
  const family = ["directional", "combined", "pullout"][movingIndex % 3];
  const direction = viewpoint;
  if (family === "pullout") return "pullout-only";
  if (family === "combined") return `${direction}-then-pullout`;
  return `${direction}-only`;
}

export function koyaCameraModeForMissingFamily(viewpoint, emittedFamilies, movingIndex = 0, composition = {}) {
  let missingFamily = ["directional", "combined", "pullout"]
    .find((family) => !emittedFamilies.has(family));
  // The normal wide-shot default remains a true pull-out. A wide establishing
  // composition with explicit depth/foreground can, however, scan the spatial
  // relationship it was authored to establish. This is a semantic exception,
  // not a fake left/right label applied to every wide source.
  const semanticWideScan = viewpoint === "wide"
    && missingFamily !== "pullout"
    && nonEmpty(composition?.setup?.depth)
    && nonEmpty(composition?.visibleAction);
  // Prefer the combined family on a roomy establishing illustration. Pure
  // directional travel is then still available to a later flattened split
  // page, whose typography-safe camera window is intentionally tighter.
  if (semanticWideScan && !emittedFamilies.has("directional") && !emittedFamilies.has("combined")) {
    missingFamily = "combined";
  }
  if (viewpoint === "wide" && !semanticWideScan) return "pullout-only";
  const direction = semanticWideScan
    ? (Number(composition.sequenceIndex || movingIndex) % 2 === 0 ? "right" : "left")
    : viewpoint;
  if (missingFamily === "directional") return `${direction}-only`;
  if (missingFamily === "combined") return `${direction}-then-pullout`;
  if (missingFamily === "pullout") return "pullout-only";
  return koyaCameraModeForShot(viewpoint, movingIndex);
}

export function dialogueShotRequiresAnchoredPullout(activeSpeakerFace) {
  if (!activeSpeakerFace) return false;
  const faceCenterX = Number(activeSpeakerFace.x) + Number(activeSpeakerFace.width) / 2;
  const faceCenterY = Number(activeSpeakerFace.y) + Number(activeSpeakerFace.height) / 2;
  return faceCenterX < 0.34 || faceCenterX > 0.66 || faceCenterY < 0.28 || faceCenterY > 0.72;
}

export async function reuseKoyaApprovedAudio(manifest, previousManifest) {
  const previousById = new Map((previousManifest?.utterances || []).map((entry) => [entry.id, entry]));
  const reused = [];
  for (const utterance of manifest.utterances || []) {
    const previous = previousById.get(utterance.id);
    const audio = previous?.audio;
    const sameContractInput = previous
      && previous.cutId === utterance.cutId
      && previous.speakerId === utterance.speakerId
      && previous.text === utterance.text
      && previous.speechText === utterance.speechText
      && previous.voiceId === utterance.voiceId
      && previous.model === utterance.model
      && JSON.stringify(previous.voiceSettings || {}) === JSON.stringify(utterance.voiceSettings || {});
    if (!sameContractInput || !nonEmpty(audio?.filePath) || !await exists(resolve(audio.filePath))) continue;
    utterance.audio = structuredClone(audio);
    reused.push(utterance.id);
  }
  return reused;
}

export async function recoverKoyaApprovedAudioFromAlignments(manifest, canvasDir) {
  const recovered = [];
  for (const utterance of manifest.utterances || []) {
    if (nonEmpty(utterance.audio?.filePath) && await exists(resolve(utterance.audio.filePath))) continue;
    const expectedFileName = `${manifest.id}-${utterance.id}-koya-v44.wav`;
    const alignmentPath = join(resolve(canvasDir), "audio-alignments", `${expectedFileName}.json`);
    let audio;
    try {
      audio = await readJson(alignmentPath);
    } catch {
      continue;
    }
    const exactBoundInput = audio?.pipeline === "koya-dialogue-v44"
      && audio?.utteranceId === utterance.id
      && audio?.displayText === utterance.text
      && audio?.speechText === utterance.speechText
      && audio?.voiceId === utterance.voiceId
      && audio?.model === utterance.model
      && basename(audio?.filePath || "") === expectedFileName
      && resolve(audio?.alignmentPath || "") === alignmentPath
      && await exists(resolve(audio?.filePath || ""));
    if (!exactBoundInput) continue;
    utterance.audio = structuredClone(audio);
    recovered.push(utterance.id);
  }
  return recovered;
}

export function groupPagesForPacing(pages, utteranceById, compositionByUtterance = new Map()) {
  const groups = [];
  for (const page of pages) {
    const utterance = utteranceById.get(page.utteranceId);
    const previous = groups.at(-1);
    const pageIsSpecial = page.editorial?.split?.recommended || page.editorial?.editorialPlate?.recommended;
    const previousPageIsSpecial = previous?.pages?.some((entry) => (
      entry.editorial?.split?.recommended || entry.editorial?.editorialPlate?.recommended
    ));
    const sameSpeakerContinuation = previous
      && previous.cutId === page.cutId
      && previous.pages.length < 2
      && utterance?.speakerId !== "narration"
      && previous.speakerId === utterance?.speakerId
      && !pageIsSpecial
      && !previousPageIsSpecial;
    const narrationRequiresDedicatedVisual = utterance?.speakerId === "narration"
      && (
        /(?:子供|子ども|赤ちゃん|家族|結婚|妊娠|出産|卒業|入学|就職|内定|昇進|解雇|死亡|葬儀|病院|手術|事故|引っ越|転居|到着|出発|出てい|立ち去|去った|翌日|数年後|数ヶ月後|写真|スマホ|地図|賞状|契約書|手紙|証拠)/u.test(utterance?.text || "")
        // A purpose-reflection image expresses an internal choice through a
        // deliberate face/posture/prop composition. Bridging it onto the
        // preceding dialogue image discards that authored evidence and can
        // leave a narration card trapped between unrelated close-up heads.
        || compositionByUtterance.get(page.utteranceId)?.intent === "purpose-reflection"
      );
    const narrationBridge = previous
      && previous.cutId === page.cutId
      && previous.pages.length < 2
      // Keep long narration holds unless the incoming narration explicitly
      // introduces a visible fact (for example children, graduation, a
      // letter, or a location/time transition). Such a line already owns a
      // purpose-built source image and must not be hidden merely to increase
      // hold length. Narration/dialogue bridges keep their existing concrete
      // character-led representative-page behavior.
      && !narrationRequiresDedicatedVisual
      && previous.dedicatedNarrationVisual !== true
      && (previous.speakerId === "narration" || utterance?.speakerId === "narration")
      && !pageIsSpecial
      && !previousPageIsSpecial;
    if (sameSpeakerContinuation || narrationBridge) {
      previous.pages.push(page);
      previous.utteranceIds.push(page.utteranceId);
      // Narration may hold over the concrete dialogue illustration, but a
      // dialogue must never be assigned to a narration-only establishing
      // image that lacks its active speaker.  Preserve utterance order while
      // choosing the non-narration page as the visual/face evidence source.
      if (previous.speakerId === "narration" && utterance?.speakerId !== "narration") {
        previous.representativePage = page;
        previous.speakerId = utterance.speakerId;
      }
    } else {
      groups.push({
        cutId: page.cutId,
        speakerId: utterance?.speakerId || "",
        pages: [page],
        representativePage: page,
        utteranceIds: [page.utteranceId],
        dedicatedNarrationVisual: narrationRequiresDedicatedVisual,
      });
    }
  }
  return groups;
}

export async function runSourceFacePlacement(paths, planPath, sourceFaceReviewPath = "") {
  let exitCode = 0;
  let stderr = "";
  // A failed detector must never inherit a passing report from an earlier
  // invocation. Remove this exact derived artifact before spawning so only a
  // report produced by the current command can be accepted.
  await unlink(paths.sourceFaceReportPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  try {
    const command = [
      join(paths.projectDir, "scripts/detect-koya-manga-source-faces.py"),
      "--plan", planPath,
      "--output", paths.sourceFaceReportPath,
      "--cascade", join(paths.projectDir, "scripts/data/lbpcascade_animeface.xml"),
    ];
    if (nonEmpty(sourceFaceReviewPath)) command.push("--review", resolve(sourceFaceReviewPath));
    await execFile("python3", command, { cwd: paths.projectDir, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    exitCode = error.code || 1;
    stderr = error.stderr || error.message;
  }
  if (!await exists(paths.sourceFaceReportPath)) {
    throw new Error(`Source face placement failed before producing evidence: ${stderr}`);
  }
  const report = await readJson(paths.sourceFaceReportPath);
  return { report, exitCode };
}

export async function createKoyaEpisodeManifest(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  const paths = episodePaths(projectDir, options.episodeId);
  const previousState = await readJson(paths.statePath).catch(() => ({}));
  const previousManifest = await readJson(paths.manifestPath).catch(() => null);
  const planPath = resolve(options.imagePlanPath || paths.imagePlanPath);
  const plan = await readJson(planPath);
  const generatorProvenance = plan.production?.generatorProvenance
    || previousState?.generatorProvenance
    || resolveKoyaAgentProvenance({
      role: "generator",
      host: options.generatorHost,
      id: options.generatorId,
      contextId: options.generatorContextId,
      source: options.generatorProvenanceSource || "legacy-contract-migration",
    });
  plan.production = {
    ...(plan.production || {}),
    generatorProvenance,
  };
  // Older approved plans predate provenance binding. Persist the real legacy
  // generator carried by the production state so subsequent audits never need
  // to invent or silently replace the original generation identity.
  await writeJsonAtomic(planPath, plan);
  for (const page of plan.pages || []) {
    if (!await exists(page.outputPath)) throw new Error(`Generated page is missing: ${page.outputPath}`);
  }
  const resolved = await resolveKoyaMangaProductionContract({
    projectDir,
    episodeId: options.episodeId,
    contractPath: options.contractPath,
    overridePath: options.overridePath,
  });
  const sourceFaceReviewPath = nonEmpty(options.sourceFaceReviewPath) || nonEmpty(previousState.sourceFaceReviewPath);
  const faceResult = await runSourceFacePlacement(paths, planPath, sourceFaceReviewPath);
  if (!faceResult.report.pass) {
    const state = await updateState(paths, {
      status: "awaiting-source-face-review",
      currentStage: "source-face-placement",
      sourceFaceReportPath: paths.sourceFaceReportPath,
      sourceFaceReviewPath,
      knownRemainingIssues: faceResult.report.knownRemainingIssues,
    });
    return { episodeId: options.episodeId, paths, plan, resolved, state, waiting: true, faceReport: faceResult.report };
  }
  const firstPageByCut = new Map();
  for (const page of plan.pages || []) if (!firstPageByCut.has(page.cutId)) firstPageByCut.set(page.cutId, page.outputPath);
  const created = await createEpisodeManifest({
    projectDir,
    scriptPath: options.scriptPath || plan.sourceScript?.path || plan.manifest?.scriptPath,
    scriptText: plan.sourceScript?.text || plan.manifest?.scriptText || plan.scriptText,
    episodeId: options.episodeId,
    title: plan.manifest?.title,
    imagePathByCutId: Object.fromEntries(firstPageByCut),
    model: "eleven_v3",
    motion: "left-only",
    width: resolved.contract.video.width,
    height: resolved.contract.video.height,
    fps: resolved.contract.video.fps,
    bgmPath: "",
    bgmVolume: 0,
    normalizeVoiceAudio: false,
    voiceTargetLufs: resolved.contract.audio.targetLineLufs,
    masterTargetLufs: resolved.contract.audio.masterTargetLufs,
    masterTruePeakDb: resolved.contract.audio.masterTruePeakDb,
    sameSpeakerGapSeconds: resolved.contract.audio.sameSpeakerGapSeconds,
    speakerChangeGapSeconds: resolved.contract.audio.speakerChangeGapSeconds,
    emphasisGapSeconds: resolved.contract.audio.emphasisGapSeconds,
    bubbleFadeInMilliseconds: resolved.contract.bubbles.fadeInMilliseconds,
    bubbleFadeOutMilliseconds: resolved.contract.bubbles.fadeOutMilliseconds,
    bubbleTransitionCrossfadeSeconds: resolved.contract.bubbles.transitionCrossfadeSeconds,
    stripTerminalJapanesePeriod: resolved.contract.bubbles.stripTerminalJapanesePeriod,
  });
  let manifest = applyKoyaContractToManifest(created.manifest, resolved);
  const characterBiblePath = plan.production?.characterBiblePath || "";
  const characterBible = characterBiblePath ? await readJson(resolve(characterBiblePath)) : null;
  if (characterBible) manifest = applyKoyaCharacterBiblePronunciations(manifest, characterBible);
  manifest = applyKoyaNarrationVoicePolicy(manifest, resolved, {
    protagonistSpeakerId: options.protagonistSpeakerId
      || plan.production?.protagonistSpeakerName
      || plan.production?.protagonistSpeakerId,
  });
  for (const utterance of manifest.utterances || []) {
    const authoredSpeechText = utterance.speechOverride || utterance.speechText || utterance.text || "";
    utterance.speechText = applyKoyaSpeechPronunciations(
      authoredSpeechText,
      manifest.speech?.pronunciations,
    ).trim();
  }
  const reusedAudioUtteranceIds = await reuseKoyaApprovedAudio(manifest, previousManifest);
  const recoveredAudioUtteranceIds = await recoverKoyaApprovedAudioFromAlignments(
    manifest,
    paths.canvasDir,
  );
  reusedAudioUtteranceIds.push(...recoveredAudioUtteranceIds);
  const annotationByUtterance = new Map(faceResult.report.rows.map((entry) => [entry.utteranceId, entry]));
  const compositionByUtterance = new Map((plan.compositionPlan?.beats || []).map((entry) => [entry.utteranceId, entry]));
  const imageJobById = new Map((plan.jobs || []).map((entry) => [entry.id, entry]));
  const utteranceById = new Map(manifest.utterances.map((entry) => [entry.id, entry]));
  const groups = groupPagesForPacing(plan.pages || [], utteranceById, compositionByUtterance);
  let movingIndex = 0;
  const emittedCameraFamilies = new Set();
  for (const cut of manifest.cuts) {
    const cutGroups = groups.filter((entry) => entry.cutId === cut.id);
    const cutPages = cutGroups.flatMap((entry) => entry.pages);
    const conflictingPage = cutPages.find((page) => (
      page.editorial?.split?.recommended === true && page.editorial?.editorialPlate?.recommended === true
    ));
    if (conflictingPage) {
      throw new Error(`${conflictingPage.utteranceId}: editorial plate and split page are mutually exclusive; regenerate the image plan.`);
    }
    const splitPage = cutPages.find((page) => page.editorial?.split?.recommended === true);
    if (splitPage) {
      const composition = compositionByUtterance.get(splitPage.utteranceId) || {};
      const viewpoint = viewpointForComposition(composition, movingIndex);
      const diversityMode = koyaCameraModeForMissingFamily(viewpoint, emittedCameraFamilies, movingIndex, composition);
      // A flattened split page has one shared visibility window for every
      // panel and every timed replacement. Directional travel can shrink that
      // window enough to make previously valid Japanese typography impossible.
      // Keep the page centered and reveal it with a deterministic pull-out;
      // still consume the scheduled family so later shots remain stable.
      const mode = "pullout-only";
      emittedCameraFamilies.add(mangaCameraModeFamily(diversityMode));
      movingIndex += 1;
      const panelJobs = (splitPage.panelJobIds || []).map((id) => imageJobById.get(id)).filter(Boolean);
      const expectedPanelCount = splitPage.editorial.split.type === "story-3" ? 3 : 2;
      if (panelJobs.length !== expectedPanelCount) {
        throw new Error(`${splitPage.utteranceId}: ${splitPage.editorial.split.type} requires ${expectedPanelCount} real panel jobs; found ${panelJobs.length}. Regenerate the image plan.`);
      }
      const gutter = Math.max(8, Math.round(1920 * Number(splitPage.editorial.split.separatorWidthRatio || 0.0145)));
      cut.panelLayout = applyMangaCameraGrammarToPanelLayout({
        enabled: true,
        type: splitPage.editorial.split.type,
        gutter,
        ...(splitPage.editorial.split.type === "vertical-2" ? { ratios: [0.47, 0.53] } : {
          splitRatio: 0.39,
          diagonalStart: 0.36,
          diagonalEnd: 0.63,
        }),
        panels: panelJobs.map((job, index) => ({
          imagePath: job.outputPath,
          role: splitPage.editorial.split.type === "story-3"
            ? ["cause", "action", "consequence"][index]
            : ["speaker-or-cause", "listener-or-consequence"][index],
          motion: "none",
          camera: { zoomStart: 1, zoomEnd: 1, focusX: 0.5, focusY: 0.5, focusXEnd: 0.5, focusYEnd: 0.5 },
        })),
        cameraIntensity: "strong",
      }, viewpoint, mode);
      cut.cameraSequence = [];
      cut.imagePath = splitPage.outputPath;
      cut.motion = mode;
      cut.cameraMode = mode;
      cut.camera = cut.panelLayout.pageCamera;
      cut.flattenedSplitPage = {
        enabled: true,
        sourcePagePath: splitPage.outputPath,
        splitType: splitPage.editorial.split.type,
        panelCount: panelJobs.length,
        separatorWidthRatio: splitPage.editorial.split.separatorWidthRatio,
        flattenBeforeCamera: true,
        panelCamera: "static",
        motionPolicy: "whole-page",
      };
      cut.imageGeneration = {
        status: "approved-koya-v44-image-pipeline",
        route: resolved.contract.art.imageModel,
        visualProfileId: resolved.contract.art.visualProfileId,
        planPath,
        adoptedAt: new Date().toISOString(),
      };
      continue;
    }
    const shots = [];
    for (const group of cutGroups) {
      const page = group.representativePage || group.pages[0];
      const composition = compositionByUtterance.get(page.utteranceId) || {};
      const annotation = annotationByUtterance.get(page.utteranceId) || {};
      const isPlate = page.editorial?.editorialPlate?.recommended === true;
      const isDedicatedNarrationInsert = group.speakerId === "narration"
        && composition.intent === "purpose-reflection";
      const viewpoint = isPlate ? "graphic" : viewpointForComposition(composition, movingIndex);
      const activeSpeakerFace = annotation.sourceFaceBoundsBySpeakerId?.[group.speakerId] || null;
      const faceDominatesFrame = Number(activeSpeakerFace?.width) >= 0.16
        && Number(activeSpeakerFace?.height) >= 0.28;
      const faceCenterX = Number(activeSpeakerFace?.x) + Number(activeSpeakerFace?.width) / 2;
      const faceCenterY = Number(activeSpeakerFace?.y) + Number(activeSpeakerFace?.height) / 2;
      const faceNearFrameEdge = activeSpeakerFace && (
        faceCenterX < 0.25 || faceCenterX > 0.75 || faceCenterY < 0.25 || faceCenterY > 0.75
      );
      const faceRequiresAnchoredPullout = faceDominatesFrame || faceNearFrameEdge;
      // Dialogue may never begin with its active speaker outside the crop.
      // Wide source art can still use motion, but an edge-positioned speaker
      // must stay anchored while the shot pulls out rather than traversing
      // from an unrelated side of the frame.
      const dialogueRequiresAnchoredPullout = group.speakerId !== "narration"
        && dialogueShotRequiresAnchoredPullout(activeSpeakerFace);
      const dialogueDiversityMode = dialogueRequiresAnchoredPullout
        ? koyaCameraModeForMissingFamily(viewpoint, emittedCameraFamilies, movingIndex, composition)
        : "";
      // Extreme crops and edge faces stay anchored. A centered medium close-up
      // is allowed to use the missing camera family; the downstream 33-sample
      // face/camera placement gate remains the final authority.
      const mode = isPlate
        ? "none"
        : isDedicatedNarrationInsert
          ? "pullout-only"
        : faceRequiresAnchoredPullout || dialogueRequiresAnchoredPullout
          ? "pullout-only"
          : koyaCameraModeForMissingFamily(viewpoint, emittedCameraFamilies, movingIndex, composition);
      const cameraViewpoint = viewpoint === "wide" && mode !== "pullout-only" && mode !== "none"
        ? (["left", "right", "top"].find((direction) => mode.startsWith(direction)) || viewpoint)
        : viewpoint;
      // A newly retained narration insert must not rotate the global camera
      // family sequence for every later shot. It has a deterministic semantic
      // pull-out and leaves the existing downstream diversity order intact.
      if (!isPlate && !isDedicatedNarrationInsert) {
        // Anchoring an edge speaker is a safety correction, not a request to
        // rotate the diversity schedule of every following shot. Consume the
        // family the unconstrained shot would have occupied.
        emittedCameraFamilies.add(mangaCameraModeFamily(dialogueDiversityMode || mode));
        movingIndex += 1;
      }
      let shot = {
        id: `${cut.id}-${page.utteranceId}-koya-v44`,
        utteranceIds: group.utteranceIds,
        imagePath: page.outputPath,
        transition: "cut",
        motion: mode,
        cameraMode: mode,
        cameraIntensity: "strong",
        semanticStartSubject: composition.purpose || page.utteranceId,
        semanticEndSubject: composition.visibleAction || composition.purpose || page.utteranceId,
        compositionId: composition.id || "",
        sourceCompositionViewpoint: viewpoint,
        sourceFaceBoundsBySpeakerId: annotation.sourceFaceBoundsBySpeakerId || {},
        sourceAvoidRegions: annotation.sourceAvoidRegions || [],
        imagePlanUtteranceIds: group.pages.map((entry) => entry.utteranceId),
        ...(isPlate ? {
          editorialPlate: {
            type: page.editorial.editorialPlate.type,
            characterPolicy: "strictly-none",
            environmentPolicy: "none",
          },
        } : {}),
      };
      shot = isPlate
        ? applyMangaCameraGrammarToShot(shot, "wide", "none")
        : applyMangaCameraGrammarToShot(shot, cameraViewpoint, mode);
      if (!isPlate && (faceRequiresAnchoredPullout || dialogueRequiresAnchoredPullout) && shot.camera) {
        const focusX = Math.max(0, Math.min(1, faceCenterX));
        const focusY = Math.max(0, Math.min(1, faceCenterY));
        shot.camera = {
          ...shot.camera,
          focusX,
          focusY,
          focusXEnd: focusX,
          focusYEnd: focusY,
          keyframes: [
            { at: 0, zoom: shot.camera.zoomStart, focusX, focusY },
            { at: 1, zoom: shot.camera.zoomEnd, focusX, focusY },
          ],
        };
      }
      shots.push(shot);
    }
    cut.cameraSequence = shots;
    const firstMoving = shots.find((entry) => mangaCameraModeFamily(entry.cameraMode) !== "static") || shots[0];
    if (firstMoving) {
      cut.imagePath = firstMoving.imagePath;
      cut.motion = firstMoving.motion;
      cut.cameraMode = firstMoving.cameraMode;
      cut.camera = firstMoving.camera;
    }
    cut.imageGeneration = {
      status: "approved-koya-v44-image-pipeline",
      route: resolved.contract.art.imageModel,
      visualProfileId: resolved.contract.art.visualProfileId,
      planPath,
      adoptedAt: new Date().toISOString(),
    };
  }
  manifest.production = {
    ...(manifest.production || {}),
    provenance: {
      ...(manifest.production?.provenance || {}),
      generator: structuredClone(generatorProvenance),
    },
    channelDirectives: structuredClone(plan.production?.channelDirectives || {}),
    incidentLedger: structuredClone(plan.production?.incidentLedger || {}),
    imagePlan: {
      path: planPath,
      pageCount: plan.pages.length,
      adoptedShotCount: manifest.cuts.reduce((sum, cut) => sum + (cut.panelLayout?.enabled ? 1 : cut.cameraSequence.length), 0),
      sameSpeakerImageGroups: groups.filter((entry) => entry.utteranceIds.length > 1).length,
    },
    approvedAudioReuse: {
      version: "koya-approved-audio-reuse-v1",
      utteranceIds: reusedAudioUtteranceIds,
      reusedCount: reusedAudioUtteranceIds.length,
      recoveredFromAlignmentCount: recoveredAudioUtteranceIds.length,
      complete: reusedAudioUtteranceIds.length === manifest.utterances.length,
      policy: "exact-previous-manifest-or-hash-bound-dialogue-alignment-and-existing-file",
    },
    sourceFacePlacement: {
      path: paths.sourceFaceReportPath,
      pass: true,
      independentFinalAuditRequired: true,
      manualReviewEvidence: structuredClone(faceResult.report.manualReviewEvidence || null),
    },
  };
  for (const cut of manifest.cuts.filter((entry) => entry.panelLayout?.enabled)) {
    const splitPage = (plan.pages || []).find((page) => page.cutId === cut.id && page.editorial?.split?.recommended === true);
    const annotation = annotationByUtterance.get(splitPage?.utteranceId) || {};
    for (const utterance of manifest.utterances.filter((entry) => entry.cutId === cut.id)) {
      const spec = await readJson(utterance.overlaySpecPath);
      // Legacy/source images are not always contract-sized. Placement occurs
      // in the overlay raster's coordinate space, so normalized source faces
      // must be expanded with that exact width/height, not fixed 1920x1080.
      const absoluteAvoidRegions = sourceAvoidRegionsInOverlaySpace(
        annotation.sourceAvoidRegions,
        spec.imageSize,
        resolved.contract.video,
      );
      await writeJsonAtomic(utterance.overlaySpecPath, {
        ...spec,
        imagePath: cut.imagePath,
        plan: { ...(spec.plan || {}), avoidRegions: absoluteAvoidRegions },
        sourceAvoidRegions: annotation.sourceAvoidRegions || [],
        splitPageSource: splitPage?.outputPath || "",
      });
    }
  }
  const contractAudit = auditManifestAgainstKoyaContract(manifest, resolved);
  if (!contractAudit.pass) throw new Error(`Koya manifest contract failed: ${JSON.stringify(contractAudit.failures)}`);
  await writeJsonAtomic(paths.manifestPath, manifest);
  const refreshed = await refreshEpisodeBubbleOverlays({
    projectDir,
    manifestPath: paths.manifestPath,
    refreshAll: true,
    reflowPlacement: true,
    sequenceAware: true,
    stripTerminalJapanesePeriod: resolved.contract.bubbles.stripTerminalJapanesePeriod,
  });
  manifest = refreshed.manifest;
  manifest.production = {
    ...(manifest.production || {}),
    contractManifestAudit: contractAudit,
  };
  await writeJsonAtomic(paths.manifestPath, manifest);
  if (reusedAudioUtteranceIds.length === manifest.utterances.length && manifest.utterances.length > 0) {
    manifest = compileEpisodeTiming(manifest, {
      sameSpeakerGapSeconds: resolved.contract.audio.sameSpeakerGapSeconds,
      speakerChangeGapSeconds: resolved.contract.audio.speakerChangeGapSeconds,
      emphasisGapSeconds: resolved.contract.audio.emphasisGapSeconds,
      bubbleFadeInMilliseconds: resolved.contract.bubbles.fadeInMilliseconds,
      bubbleFadeOutMilliseconds: resolved.contract.bubbles.fadeOutMilliseconds,
      bubbleTransitionCrossfadeSeconds: resolved.contract.bubbles.transitionCrossfadeSeconds,
    });
    await writeJsonAtomic(paths.manifestPath, manifest);
    const timedRefresh = await refreshEpisodeBubbleOverlays({
      projectDir,
      manifestPath: paths.manifestPath,
      refreshAll: true,
      reflowPlacement: true,
      sequenceAware: true,
      stripTerminalJapanesePeriod: resolved.contract.bubbles.stripTerminalJapanesePeriod,
    });
    manifest = timedRefresh.manifest;
    await writeJsonAtomic(paths.manifestPath, manifest);
  }
  const speechReady = reusedAudioUtteranceIds.length === manifest.utterances.length && manifest.utterances.length > 0;
  const state = await updateState(paths, {
    status: speechReady ? "speech-ready" : "manifest-ready",
    currentStage: speechReady ? "render" : "speech",
    manifestPath: paths.manifestPath,
    sourceFaceReportPath: paths.sourceFaceReportPath,
    sourceFaceReviewPath,
    contractAuditPass: true,
    knownRemainingIssues: [],
  });
  return { episodeId: options.episodeId, paths, plan, resolved, state, waiting: false, manifest };
}

export async function generateKoyaMangaSpeech(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  const paths = episodePaths(projectDir, options.episodeId);
  const resolved = await resolveKoyaMangaProductionContract({
    projectDir,
    episodeId: options.episodeId,
    contractPath: options.contractPath,
    overridePath: options.overridePath,
  });
  const productionState = await readJson(paths.statePath).catch(() => ({}));
  const manifestInput = applyKoyaContractToManifest(await readJson(paths.manifestPath), resolved);
  const characterBiblePath = options.characterBiblePath || productionState.characterBiblePath || "";
  const characterBible = characterBiblePath ? await readJson(resolve(characterBiblePath)) : null;
  const manifest = characterBible
    ? applyKoyaCharacterBiblePronunciations(manifestInput, characterBible)
    : manifestInput;
  const result = await generateKoyaDialogueSpeech({
    projectDir,
    canvasDir: paths.canvasDir,
    manifest,
    manifestPath: paths.manifestPath,
    contract: resolved,
    takeCount: options.takeCount || resolved.contract.audio.takeCount,
    cutIds: options.cutIds,
    forcedTakes: options.forcedTakes,
    dryRun: options.dryRun,
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
  });
  if (result.waiting) {
    await updateState(paths, {
      status: "waiting-usage-limit",
      currentStage: "speech",
      knownRemainingIssues: result.report.knownRemainingIssues,
    });
    return { ...result, paths, resolved, waiting: true };
  }
  if (!options.dryRun) {
    const timedManifest = compileEpisodeTiming(result.manifest, {
      sameSpeakerGapSeconds: resolved.contract.audio.sameSpeakerGapSeconds,
      speakerChangeGapSeconds: resolved.contract.audio.speakerChangeGapSeconds,
      emphasisGapSeconds: resolved.contract.audio.emphasisGapSeconds,
      bubbleFadeInMilliseconds: resolved.contract.bubbles.fadeInMilliseconds,
      bubbleFadeOutMilliseconds: resolved.contract.bubbles.fadeOutMilliseconds,
      bubbleTransitionCrossfadeSeconds: resolved.contract.bubbles.transitionCrossfadeSeconds,
    });
    await writeJsonAtomic(paths.manifestPath, timedManifest);
    await refreshEpisodeBubbleOverlays({
      projectDir,
      manifestPath: paths.manifestPath,
      refreshAll: true,
      reflowPlacement: true,
      sequenceAware: true,
      stripTerminalJapanesePeriod: resolved.contract.bubbles.stripTerminalJapanesePeriod,
    });
  }
  const state = await updateState(paths, {
    status: options.dryRun ? "speech-planned" : "speech-ready",
    currentStage: options.dryRun ? "speech" : "render",
    speechReportPath: result.reportPath,
    knownRemainingIssues: [],
  });
  return { ...result, paths, resolved, state, waiting: false };
}

export async function repairKoyaMangaAudioOnset(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  if (!options.utteranceId) throw new Error("utteranceId is required.");
  const paths = episodePaths(projectDir, options.episodeId);
  const resolved = await resolveKoyaMangaProductionContract({
    projectDir,
    episodeId: options.episodeId,
    contractPath: options.contractPath,
    overridePath: options.overridePath,
  });
  const fadeMilliseconds = Number(options.fadeMilliseconds ?? resolved.contract.audio.joinFadeInMilliseconds);
  if (!Number.isFinite(fadeMilliseconds) || fadeMilliseconds < 6 || fadeMilliseconds > 8) {
    throw new Error(`fadeMilliseconds must stay within the contract's 6–8 ms join-fade range; got ${options.fadeMilliseconds}.`);
  }
  const fadeStartSeconds = Number(options.fadeStartSeconds);
  if (!Number.isFinite(fadeStartSeconds) || fadeStartSeconds <= 0) {
    throw new Error("fadeStartSeconds must be a positive number.");
  }
  const manifestInput = await readJson(paths.manifestPath);
  const utterance = (manifestInput.utterances || []).find((entry) => entry.id === options.utteranceId);
  if (!utterance) throw new Error(`Utterance is missing: ${options.utteranceId}`);
  const sourcePath = resolve(options.sourcePath || utterance.audio?.filePath || "");
  if (!sourcePath.startsWith(`${projectDir}/`) || !await exists(sourcePath)) {
    throw new Error(`Repair source must be an existing file inside the project: ${sourcePath}`);
  }
  const outputFileName = basename(options.outputFileName || `${options.episodeId}-${options.utteranceId}-onset-repaired.wav`);
  if (outputFileName !== options.outputFileName && options.outputFileName) {
    throw new Error("outputFileName must not contain directory components.");
  }
  if (!outputFileName.toLowerCase().endsWith(".wav")) throw new Error("outputFileName must end in .wav.");
  const outputDir = join(paths.canvasDir, "assets/audio");
  const outputPath = join(outputDir, outputFileName);
  const fadeDurationSeconds = fadeMilliseconds / 1000;
  await mkdir(outputDir, { recursive: true });
  await execFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath,
    "-af", `afade=t=in:st=${fadeStartSeconds.toFixed(6)}:d=${fadeDurationSeconds.toFixed(6)}:curve=tri`,
    "-ar", String(resolved.contract.video.audioSampleRate), "-ac", "1", "-c:a", "pcm_s24le", outputPath,
  ], { cwd: projectDir, maxBuffer: 16 * 1024 * 1024 });
  const [{ stdout: sourceProbe }, { stdout: outputProbe }] = await Promise.all([
    execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", sourcePath]),
    execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", outputPath]),
  ]);
  const sourceDurationSeconds = Number(JSON.parse(sourceProbe).format.duration);
  const outputDurationSeconds = Number(JSON.parse(outputProbe).format.duration);
  if (!Number.isFinite(outputDurationSeconds) || Math.abs(outputDurationSeconds - sourceDurationSeconds) > 1 / resolved.contract.video.audioSampleRate) {
    throw new Error(`Onset repair changed duration: ${sourceDurationSeconds} -> ${outputDurationSeconds}`);
  }
  let manifest = applyKoyaContractToManifest(manifestInput, resolved);
  const repaired = manifest.utterances.find((entry) => entry.id === options.utteranceId);
  const previousAudio = repaired.audio || {};
  repaired.audio = {
    ...previousAudio,
    fileName: outputFileName,
    filePath: outputPath,
    assetUrl: `/excalidraw-assets/audio/${encodeURIComponent(outputFileName)}`,
    durationSeconds: outputDurationSeconds,
    speechStartSeconds: fadeStartSeconds,
    outputHeadPaddingSeconds: fadeStartSeconds,
    joinFadeRepair: {
      version: "koya-approved-onset-repair-v1",
      sourcePath,
      fadeStartSeconds,
      fadeMilliseconds,
      curve: "linear",
      reason: options.reason || "user-reported onset click",
      repairedAt: new Date().toISOString(),
    },
  };
  if (repaired.audio.acousticSpeechDetection) {
    repaired.audio.acousticSpeechDetection = {
      ...repaired.audio.acousticSpeechDetection,
      startSeconds: fadeStartSeconds,
    };
  }
  repaired.audioFileName = outputFileName;
  repaired.audioFilePath = outputPath;
  repaired.audioAssetUrl = repaired.audio.assetUrl;
  const alignmentFileName = `${outputFileName}.json`;
  const alignmentPath = join(paths.canvasDir, "audio-alignments", alignmentFileName);
  repaired.audio.alignmentFileName = alignmentFileName;
  repaired.audio.alignmentPath = alignmentPath;
  await writeJsonAtomic(alignmentPath, repaired.audio);
  const legacyApprovedAudio = manifest.production?.approvedAudio || null;
  manifest.production = {
    ...(manifest.production || {}),
    audioRepairs: [
      ...(manifest.production?.audioRepairs || []),
      {
        utteranceId: options.utteranceId,
        sourcePath,
        outputPath,
        fadeStartSeconds,
        fadeMilliseconds,
        reason: options.reason || "user-reported onset click",
        repairedAt: new Date().toISOString(),
      },
    ],
    ...(legacyApprovedAudio ? { supersededApprovedAudio: legacyApprovedAudio } : {}),
  };
  delete manifest.production.approvedAudio;
  manifest.status = "audio-repaired-awaiting-render";
  manifest.knownRemainingIssues = [{ id: "audio-click-user-review", detail: `${options.utteranceId} must pass rendered MP4 audit and user listening review.` }];
  await Promise.all([
    writeJsonAtomic(paths.manifestPath, manifest),
    writeJsonAtomic(paths.contractSnapshotPath, {
      version: resolved.contract.version,
      digest: resolved.digest,
      contractPath: resolved.contractPath,
      episodeOverridePath: resolved.episodeOverridePath,
      contract: resolved.contract,
    }),
  ]);
  const contractAudit = auditManifestAgainstKoyaContract(manifest, resolved);
  if (!contractAudit.pass) throw new Error(`Koya manifest contract failed after audio repair: ${JSON.stringify(contractAudit.failures)}`);
  const state = await updateState(paths, {
    episodeId: options.episodeId,
    status: "audio-repaired-awaiting-render",
    currentStage: "render",
    manifestPath: paths.manifestPath,
    contractSnapshotPath: paths.contractSnapshotPath,
    contractDigest: resolved.digest,
    knownRemainingIssues: manifest.knownRemainingIssues,
  });
  return {
    episodeId: options.episodeId,
    utteranceId: options.utteranceId,
    sourcePath,
    outputPath,
    sourceDurationSeconds,
    outputDurationSeconds,
    fadeStartSeconds,
    fadeMilliseconds,
    contractAudit,
    paths,
    state,
  };
}

export async function repairKoyaMangaAudioTail(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  if (!options.utteranceId) throw new Error("utteranceId is required.");
  const paths = episodePaths(projectDir, options.episodeId);
  const resolved = await resolveKoyaMangaProductionContract({
    projectDir,
    episodeId: options.episodeId,
    contractPath: options.contractPath,
    overridePath: options.overridePath,
  });
  const fadeMilliseconds = Number(options.fadeMilliseconds ?? resolved.contract.audio.joinFadeOutMilliseconds);
  if (!Number.isFinite(fadeMilliseconds) || fadeMilliseconds < 6 || fadeMilliseconds > 8) {
    throw new Error(`fadeMilliseconds must stay within the contract's 6–8 ms join-fade range; got ${options.fadeMilliseconds}.`);
  }
  const fadeStartSeconds = Number(options.fadeStartSeconds);
  if (!Number.isFinite(fadeStartSeconds) || fadeStartSeconds <= 0) {
    throw new Error("fadeStartSeconds must be a positive number.");
  }
  const manifestInput = await readJson(paths.manifestPath);
  const utterance = (manifestInput.utterances || []).find((entry) => entry.id === options.utteranceId);
  if (!utterance) throw new Error(`Utterance is missing: ${options.utteranceId}`);
  const sourcePath = resolve(options.sourcePath || utterance.audio?.filePath || "");
  if (!sourcePath.startsWith(`${projectDir}/`) || !await exists(sourcePath)) {
    throw new Error(`Repair source must be an existing file inside the project: ${sourcePath}`);
  }
  const speechEndSeconds = Number(
    options.speechEndSeconds
      ?? utterance.audio?.acousticSpeechDetection?.endSeconds
      ?? utterance.audio?.speechEndSeconds,
  );
  if (!Number.isFinite(speechEndSeconds) || speechEndSeconds <= 0 || speechEndSeconds > fadeStartSeconds) {
    throw new Error(`speechEndSeconds must identify preserved speech at or before the fade; got ${options.speechEndSeconds}.`);
  }
  const fadeDurationSeconds = fadeMilliseconds / 1000;
  if (fadeStartSeconds + fadeDurationSeconds - speechEndSeconds + 1e-9 < resolved.contract.audio.minimumReleasePaddingSeconds) {
    throw new Error(
      `Tail repair must preserve at least ${resolved.contract.audio.minimumReleasePaddingSeconds}s after speech; `
      + `got ${fadeStartSeconds + fadeDurationSeconds - speechEndSeconds}s.`,
    );
  }
  const outputFileName = basename(options.outputFileName || `${options.episodeId}-${options.utteranceId}-tail-repaired.wav`);
  if (outputFileName !== options.outputFileName && options.outputFileName) {
    throw new Error("outputFileName must not contain directory components.");
  }
  if (!outputFileName.toLowerCase().endsWith(".wav")) throw new Error("outputFileName must end in .wav.");
  const outputDir = join(paths.canvasDir, "assets/audio");
  const outputPath = join(outputDir, outputFileName);
  await mkdir(outputDir, { recursive: true });
  await execFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath,
    "-af", `afade=t=out:st=${fadeStartSeconds.toFixed(6)}:d=${fadeDurationSeconds.toFixed(6)}:curve=tri`,
    "-ar", String(resolved.contract.video.audioSampleRate), "-ac", "1", "-c:a", "pcm_s24le", outputPath,
  ], { cwd: projectDir, maxBuffer: 16 * 1024 * 1024 });
  const [{ stdout: sourceProbe }, { stdout: outputProbe }] = await Promise.all([
    execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", sourcePath]),
    execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", outputPath]),
  ]);
  const sourceDurationSeconds = Number(JSON.parse(sourceProbe).format.duration);
  const outputDurationSeconds = Number(JSON.parse(outputProbe).format.duration);
  if (!Number.isFinite(outputDurationSeconds) || Math.abs(outputDurationSeconds - sourceDurationSeconds) > 1 / resolved.contract.video.audioSampleRate) {
    throw new Error(`Tail repair changed duration: ${sourceDurationSeconds} -> ${outputDurationSeconds}`);
  }
  if (fadeStartSeconds + fadeDurationSeconds > outputDurationSeconds + 1e-9) {
    throw new Error(`Tail fade ends after the source duration: ${fadeStartSeconds + fadeDurationSeconds} > ${outputDurationSeconds}`);
  }
  let manifest = applyKoyaContractToManifest(manifestInput, resolved);
  const repaired = manifest.utterances.find((entry) => entry.id === options.utteranceId);
  const repairedAt = new Date().toISOString();
  repaired.audio = {
    ...(repaired.audio || {}),
    fileName: outputFileName,
    filePath: outputPath,
    assetUrl: `/excalidraw-assets/audio/${encodeURIComponent(outputFileName)}`,
    durationSeconds: outputDurationSeconds,
    speechEndSeconds,
    outputTailPaddingSeconds: outputDurationSeconds - speechEndSeconds,
    releasePaddingSeconds: outputDurationSeconds - speechEndSeconds,
    tailTransientRepair: {
      version: "koya-approved-tail-transient-repair-v1",
      sourcePath,
      speechEndSeconds,
      fadeStartSeconds,
      fadeMilliseconds,
      curve: "linear",
      reason: options.reason || "user-reported isolated tail click before next utterance",
      repairedAt,
    },
  };
  if (repaired.audio.acousticSpeechDetection) {
    repaired.audio.acousticSpeechDetection = {
      ...repaired.audio.acousticSpeechDetection,
      endSeconds: speechEndSeconds,
    };
  }
  repaired.audioFileName = outputFileName;
  repaired.audioFilePath = outputPath;
  repaired.audioAssetUrl = repaired.audio.assetUrl;
  const alignmentFileName = `${outputFileName}.json`;
  const alignmentPath = join(paths.canvasDir, "audio-alignments", alignmentFileName);
  repaired.audio.alignmentFileName = alignmentFileName;
  repaired.audio.alignmentPath = alignmentPath;
  await writeJsonAtomic(alignmentPath, repaired.audio);
  const legacyApprovedAudio = manifest.production?.approvedAudio || null;
  manifest.production = {
    ...(manifest.production || {}),
    audioRepairs: [
      ...(manifest.production?.audioRepairs || []),
      {
        type: "tail-transient",
        utteranceId: options.utteranceId,
        sourcePath,
        outputPath,
        speechEndSeconds,
        fadeStartSeconds,
        fadeMilliseconds,
        reason: options.reason || "user-reported isolated tail click before next utterance",
        repairedAt,
      },
    ],
    ...(legacyApprovedAudio ? { supersededApprovedAudio: legacyApprovedAudio } : {}),
  };
  delete manifest.production.approvedAudio;
  manifest.status = "audio-repaired-awaiting-render";
  manifest.knownRemainingIssues = [{ id: "audio-click-user-review", detail: `${options.utteranceId} tail repair must pass rendered MP4 audit and user listening review.` }];
  await Promise.all([
    writeJsonAtomic(paths.manifestPath, manifest),
    writeJsonAtomic(paths.contractSnapshotPath, {
      version: resolved.contract.version,
      digest: resolved.digest,
      contractPath: resolved.contractPath,
      episodeOverridePath: resolved.episodeOverridePath,
      contract: resolved.contract,
    }),
  ]);
  const contractAudit = auditManifestAgainstKoyaContract(manifest, resolved);
  if (!contractAudit.pass) throw new Error(`Koya manifest contract failed after audio repair: ${JSON.stringify(contractAudit.failures)}`);
  const state = await updateState(paths, {
    episodeId: options.episodeId,
    status: "audio-repaired-awaiting-render",
    currentStage: "render",
    manifestPath: paths.manifestPath,
    contractSnapshotPath: paths.contractSnapshotPath,
    contractDigest: resolved.digest,
    knownRemainingIssues: manifest.knownRemainingIssues,
  });
  return {
    episodeId: options.episodeId,
    utteranceId: options.utteranceId,
    sourcePath,
    outputPath,
    sourceDurationSeconds,
    outputDurationSeconds,
    speechEndSeconds,
    fadeStartSeconds,
    fadeMilliseconds,
    contractAudit,
    paths,
    state,
  };
}

export async function adjustKoyaMangaUtteranceGap(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  if (!options.utteranceId) throw new Error("utteranceId is required.");
  const targetAudibleGapSeconds = Number(options.targetAudibleGapSeconds);
  if (!Number.isFinite(targetAudibleGapSeconds) || targetAudibleGapSeconds < 0 || targetAudibleGapSeconds > 3) {
    throw new Error(`targetAudibleGapSeconds must be between 0 and 3; got ${options.targetAudibleGapSeconds}.`);
  }

  const paths = episodePaths(projectDir, options.episodeId);
  const resolved = await resolveKoyaMangaProductionContract({
    projectDir,
    episodeId: options.episodeId,
    contractPath: options.contractPath,
    overridePath: options.overridePath,
  });
  const manifestInput = await readJson(paths.manifestPath);
  let manifest = applyKoyaContractToManifest(manifestInput, resolved);
  const utterance = (manifest.utterances || []).find((entry) => entry.id === options.utteranceId);
  if (!utterance) throw new Error(`Utterance is missing: ${options.utteranceId}`);
  const cut = (manifest.cuts || []).find((entry) => (entry.utteranceIds || []).includes(options.utteranceId));
  const utteranceIndex = cut?.utteranceIds?.indexOf(options.utteranceId) ?? -1;
  if (!cut || utteranceIndex <= 0) {
    throw new Error(`Utterance must follow another utterance in the same cut: ${options.utteranceId}`);
  }
  const previousUtteranceId = cut.utteranceIds[utteranceIndex - 1];
  const previousUtterance = manifest.utterances.find((entry) => entry.id === previousUtteranceId);
  if (!previousUtterance) throw new Error(`Previous utterance is missing: ${previousUtteranceId}`);

  const previousDurationSeconds = Number(previousUtterance.audio?.durationSeconds);
  const previousSpeechEndSeconds = Number(previousUtterance.audio?.speechEndSeconds);
  const speechStartSeconds = Number(utterance.audio?.speechStartSeconds);
  if (
    !Number.isFinite(previousDurationSeconds)
    || !Number.isFinite(previousSpeechEndSeconds)
    || !Number.isFinite(speechStartSeconds)
  ) {
    throw new Error(`Speech-bound metadata is incomplete around ${previousUtteranceId} -> ${options.utteranceId}.`);
  }
  const embeddedPaddingGapSeconds = Math.max(0, previousDurationSeconds - previousSpeechEndSeconds)
    + Math.max(0, speechStartSeconds);
  const authoredGapBeforeSeconds = targetAudibleGapSeconds - embeddedPaddingGapSeconds;
  if (authoredGapBeforeSeconds < -0.25 || authoredGapBeforeSeconds > 3) {
    throw new Error(
      `Target audible gap requires an unsupported authored gap: ${authoredGapBeforeSeconds}s `
      + `(embedded padding ${embeddedPaddingGapSeconds}s).`,
    );
  }

  const previousTargetAudibleGapSeconds = Math.max(
    0,
    Number(utterance.pauseBeforeSeconds || 0) + embeddedPaddingGapSeconds,
  );
  utterance.pauseBeforeSeconds = authoredGapBeforeSeconds;
  utterance.audio = {
    ...(utterance.audio || {}),
    targetAudibleGapBeforeSeconds: targetAudibleGapSeconds,
    embeddedPaddingGapSeconds,
    authoredGapBeforeSeconds,
  };
  const adjustedAt = new Date().toISOString();
  manifest.production = {
    ...(manifest.production || {}),
    timingAdjustments: [
      ...(manifest.production?.timingAdjustments || []),
      {
        version: "koya-user-audible-gap-v1",
        previousUtteranceId,
        utteranceId: options.utteranceId,
        previousTargetAudibleGapSeconds,
        targetAudibleGapSeconds,
        embeddedPaddingGapSeconds,
        authoredGapBeforeSeconds,
        reason: options.reason || "user-requested more natural pause",
        adjustedAt,
      },
    ],
  };
  manifest = compileEpisodeTiming(manifest, {
    sameSpeakerGapSeconds: resolved.contract.audio.sameSpeakerGapSeconds,
    speakerChangeGapSeconds: resolved.contract.audio.speakerChangeGapSeconds,
    emphasisGapSeconds: resolved.contract.audio.emphasisGapSeconds,
    bubbleFadeInMilliseconds: resolved.contract.bubbles.fadeInMilliseconds,
    bubbleFadeOutMilliseconds: resolved.contract.bubbles.fadeOutMilliseconds,
    bubbleTransitionCrossfadeSeconds: resolved.contract.bubbles.transitionCrossfadeSeconds,
  });
  manifest.status = "timing-adjusted-awaiting-render";
  manifest.knownRemainingIssues = [{
    id: "timing-gap-user-review",
    detail: `${previousUtteranceId} -> ${options.utteranceId} must pass rendered MP4 timing and visual review.`,
  }];
  await Promise.all([
    writeJsonAtomic(paths.manifestPath, manifest),
    writeJsonAtomic(paths.contractSnapshotPath, {
      version: resolved.contract.version,
      digest: resolved.digest,
      contractPath: resolved.contractPath,
      episodeOverridePath: resolved.episodeOverridePath,
      contract: resolved.contract,
    }),
  ]);
  const contractAudit = auditManifestAgainstKoyaContract(manifest, resolved);
  if (!contractAudit.pass) {
    throw new Error(`Koya manifest contract failed after timing adjustment: ${JSON.stringify(contractAudit.failures)}`);
  }
  const state = await updateState(paths, {
    episodeId: options.episodeId,
    status: "timing-adjusted-awaiting-render",
    currentStage: "render",
    manifestPath: paths.manifestPath,
    contractSnapshotPath: paths.contractSnapshotPath,
    contractDigest: resolved.digest,
    knownRemainingIssues: manifest.knownRemainingIssues,
  });
  return {
    episodeId: options.episodeId,
    cutId: cut.id,
    previousUtteranceId,
    utteranceId: options.utteranceId,
    previousTargetAudibleGapSeconds,
    targetAudibleGapSeconds,
    embeddedPaddingGapSeconds,
    authoredGapBeforeSeconds,
    contractAudit,
    paths,
    state,
  };
}

function assertNormalizedSourceRegion(region, label) {
  const values = [region?.x, region?.y, region?.width, region?.height].map(Number);
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error(`${label} must contain finite x/y/width/height values.`);
  }
  const [x, y, width, height] = values;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
    throw new Error(`${label} must stay inside normalized source-image coordinates.`);
  }
}

export function sourceAvoidRegionsInOverlaySpace(regions = [], imageSize = {}, fallbackSize = {}) {
  const width = Number(imageSize?.width || fallbackSize?.width);
  const height = Number(imageSize?.height || fallbackSize?.height);
  if (!(width > 0) || !(height > 0)) throw new Error("Overlay image size is required for source face projection.");
  return (Array.isArray(regions) ? regions : []).map((region) => ({
    ...region,
    x: Number(region.x) * width,
    y: Number(region.y) * height,
    width: Number(region.width) * width,
    height: Number(region.height) * height,
  }));
}

export async function standardizeKoyaMangaCut(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  if (!options.cutId) throw new Error("cutId is required.");
  if (!options.planPath) throw new Error("planPath is required.");
  const paths = episodePaths(projectDir, options.episodeId);
  const planPath = resolve(options.planPath);
  if (!planPath.startsWith(`${projectDir}/`) || !await exists(planPath)) {
    throw new Error(`Standard-cut plan must be an existing JSON file inside the project: ${planPath}`);
  }
  const plan = await readJson(planPath);
  if (plan.episodeId !== options.episodeId || plan.cutId !== options.cutId) {
    throw new Error(`Standard-cut plan target mismatch: ${plan.episodeId}/${plan.cutId}.`);
  }
  if (!nonEmpty(plan.revision)) throw new Error("Standard-cut plan revision is required.");

  const resolved = await resolveKoyaMangaProductionContract({
    projectDir,
    episodeId: options.episodeId,
    contractPath: options.contractPath,
    overridePath: options.overridePath,
  });
  const manifestInput = await readJson(paths.manifestPath);
  let manifest = applyKoyaContractToManifest(manifestInput, resolved);
  const cut = (manifest.cuts || []).find((entry) => entry.id === options.cutId);
  if (!cut) throw new Error(`Cut is missing: ${options.cutId}`);
  const shots = Array.isArray(plan.shots) ? plan.shots : [];
  if (shots.length === 0) throw new Error("Standard-cut plan must contain at least one shot.");
  const coveredUtteranceIds = shots.flatMap((shot) => shot.utteranceIds || []);
  if (JSON.stringify(coveredUtteranceIds) !== JSON.stringify(cut.utteranceIds || [])) {
    throw new Error(`Standard-cut shots must cover cut utterances exactly once and in order: ${options.cutId}.`);
  }

  const normalizedShots = [];
  for (const [shotIndex, sourceShot] of shots.entries()) {
    const imagePath = resolve(sourceShot.imagePath || "");
    if (!imagePath.startsWith(`${projectDir}/`) || !await exists(imagePath)) {
      throw new Error(`Shot image must be an existing file inside the project: ${imagePath}`);
    }
    const sourceAvoidRegions = Array.isArray(sourceShot.sourceAvoidRegions)
      ? sourceShot.sourceAvoidRegions
      : [];
    if (!sourceAvoidRegions.some((region) => region?.kind === "face")) {
      throw new Error(`Shot ${sourceShot.id || shotIndex} requires remeasured face regions from its actual source image.`);
    }
    sourceAvoidRegions.forEach((region, regionIndex) => (
      assertNormalizedSourceRegion(region, `${sourceShot.id || shotIndex}.sourceAvoidRegions[${regionIndex}]`)
    ));
    const sourceFaceBoundsBySpeakerId = sourceShot.sourceFaceBoundsBySpeakerId
      && typeof sourceShot.sourceFaceBoundsBySpeakerId === "object"
      ? sourceShot.sourceFaceBoundsBySpeakerId
      : {};
    for (const [speakerId, region] of Object.entries(sourceFaceBoundsBySpeakerId)) {
      assertNormalizedSourceRegion(region, `${sourceShot.id || shotIndex}.sourceFaceBoundsBySpeakerId.${speakerId}`);
    }
    const viewpoint = nonEmpty(sourceShot.viewpoint || sourceShot.angle) || "wide";
    const cameraMode = nonEmpty(sourceShot.cameraMode || sourceShot.motion)
      || (viewpoint === "wide" ? "pullout-only" : `${viewpoint}-only`);
    const shot = applyMangaCameraGrammarToShot({
      ...sourceShot,
      imagePath,
      sourceAvoidRegions,
      sourceFaceBoundsBySpeakerId,
      transition: nonEmpty(sourceShot.transition) || "cut",
    }, viewpoint, cameraMode);
    delete shot.metadataOnlyUnderWholePageCamera;
    normalizedShots.push(shot);
  }

  const utteranceById = new Map((manifest.utterances || []).map((utterance) => [utterance.id, utterance]));
  for (const [utteranceId, segmentPlan] of Object.entries(plan.bubbleSegmentTimings || {})) {
    const utterance = utteranceById.get(utteranceId);
    if (!utterance || utterance.cutId !== cut.id) {
      throw new Error(`Bubble timing target is not in ${cut.id}: ${utteranceId}`);
    }
    const segments = Array.isArray(utterance.bubbleSegments) ? utterance.bubbleSegments : [];
    const timingById = new Map((segmentPlan.segments || []).map((segment) => [segment.id, segment]));
    if (segments.length === 0 || timingById.size !== segments.length) {
      throw new Error(`Bubble timing plan must cover every existing segment for ${utteranceId}.`);
    }
    let previousEnd = -Infinity;
    for (const segment of segments) {
      const timing = timingById.get(segment.id);
      const start = Number(timing?.startOffsetSeconds);
      const end = Number(timing?.endOffsetSeconds);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || start < -0.25) {
        throw new Error(`Invalid bubble timing for ${segment.id}.`);
      }
      if (start < previousEnd) throw new Error(`Bubble segments overlap for ${utteranceId}.`);
      if (end > Number(utterance.audio?.durationSeconds || 0) + 0.5) {
        throw new Error(`Bubble segment exceeds approved audio for ${segment.id}.`);
      }
      Object.assign(segment, {
        startOffsetSeconds: start,
        endOffsetSeconds: end,
        timingPolicy: nonEmpty(segmentPlan.timingPolicy) || "provider-character-timestamps+waveform-pause-v1",
        alignmentEvidence: segmentPlan.alignmentEvidence || null,
      });
      previousEnd = end;
    }
  }
  for (const [utteranceId, bounds] of Object.entries(plan.bubbleSpeechBounds || {})) {
    const utterance = utteranceById.get(utteranceId);
    if (!utterance || utterance.cutId !== cut.id) {
      throw new Error(`Visual speech-bound target is not in ${cut.id}: ${utteranceId}`);
    }
    const speechStartSeconds = Number(bounds?.speechStartSeconds);
    const speechEndSeconds = Number(bounds?.speechEndSeconds);
    const durationSeconds = Number(utterance.audio?.durationSeconds);
    if (
      !Number.isFinite(speechStartSeconds)
      || !Number.isFinite(speechEndSeconds)
      || !Number.isFinite(durationSeconds)
      || speechStartSeconds < 0
      || speechEndSeconds <= speechStartSeconds
      || speechEndSeconds > durationSeconds
    ) {
      throw new Error(`Invalid visual speech bounds for ${utteranceId}.`);
    }
    utterance.bubbleTiming = {
      speechStartSeconds,
      speechEndSeconds,
      timingPolicy: nonEmpty(bounds.timingPolicy) || "waveform-audible-bounds-v1",
      evidence: bounds.evidence || null,
    };
  }

  const backupPath = join(paths.episodeDir, `episode-manifest-pre-${plan.revision}.json`);
  if (!await exists(backupPath)) await writeJsonAtomic(backupPath, manifestInput);
  delete cut.panelLayout;
  delete cut.flattenedSplitPage;
  cut.cameraSequence = normalizedShots;
  cut.imagePath = normalizedShots[0].imagePath;
  cut.imageSize = plan.shots[0].imageSize || cut.imageSize;
  cut.motion = normalizedShots[0].motion;
  cut.cameraMode = normalizedShots[0].cameraMode;
  cut.camera = normalizedShots[0].camera;
  cut.cameraAssetInventory = {
    version: plan.revision,
    shotCount: normalizedShots.length,
    uniqueImageCount: new Set(normalizedShots.map((shot) => shot.imagePath)).size,
    repeatedImages: [],
  };
  cut.imageGeneration = {
    ...(cut.imageGeneration || {}),
    status: "approved-standard-single-image-shots",
    standardLayoutRevision: plan.revision,
    standardLayoutPlanPath: planPath,
    adoptedAt: new Date().toISOString(),
  };

  for (const shot of normalizedShots) {
    for (const utteranceId of shot.utteranceIds || []) {
      const utterance = utteranceById.get(utteranceId);
      const overlaySpecPath = nonEmpty(utterance?.overlaySpecPath);
      if (!overlaySpecPath || !await exists(overlaySpecPath)) {
        throw new Error(`Overlay spec is missing for ${utteranceId}.`);
      }
      const overlaySpec = await readJson(overlaySpecPath);
      delete overlaySpec.splitPageSource;
      await writeJsonAtomic(overlaySpecPath, {
        ...overlaySpec,
        imagePath: shot.imagePath,
        imageSize: sourceShotImageSize(plan, shot.id, overlaySpec.imageSize),
        sourceAvoidRegions: shot.sourceAvoidRegions,
        plan: { ...(overlaySpec.plan || {}), avoidRegions: [] },
      });
    }
  }

  manifest = compileEpisodeTiming(manifest, {
    sameSpeakerGapSeconds: resolved.contract.audio.sameSpeakerGapSeconds,
    speakerChangeGapSeconds: resolved.contract.audio.speakerChangeGapSeconds,
    emphasisGapSeconds: resolved.contract.audio.emphasisGapSeconds,
    bubbleFadeInMilliseconds: resolved.contract.bubbles.fadeInMilliseconds,
    bubbleFadeOutMilliseconds: resolved.contract.bubbles.fadeOutMilliseconds,
    bubbleTransitionCrossfadeSeconds: resolved.contract.bubbles.transitionCrossfadeSeconds,
  });
  const adjustedAt = new Date().toISOString();
  manifest.production = {
    ...(manifest.production || {}),
    layoutAdjustments: [
      ...(manifest.production?.layoutAdjustments || []),
      {
        version: "koya-standard-single-image-cut-v1",
        cutId: cut.id,
        revision: plan.revision,
        planPath,
        removedPanelLayout: true,
        shotIds: normalizedShots.map((shot) => shot.id),
        bubbleTimingEvidence: plan.bubbleSegmentTimings || {},
        reason: options.reason || plan.reason || "user requested ordinary single-image shots",
        adjustedAt,
      },
    ],
  };
  manifest.status = "layout-adjusted-awaiting-render";
  manifest.knownRemainingIssues = [{
    id: "standard-cut-user-review",
    detail: `${cut.id} must pass rendered MP4 bubble timing, face, camera, and visual review.`,
  }];
  await writeJsonAtomic(paths.manifestPath, manifest);
  const refreshed = await refreshEpisodeBubbleOverlays({
    projectDir,
    manifestPath: paths.manifestPath,
    bubbleOverrides: Object.fromEntries((cut.utteranceIds || []).map((utteranceId) => [utteranceId, {}])),
    reflowPlacement: true,
    sequenceAware: true,
    stripTerminalJapanesePeriod: resolved.contract.bubbles.stripTerminalJapanesePeriod,
  });
  manifest = refreshed.manifest;
  manifest.status = "layout-adjusted-awaiting-render";
  manifest.knownRemainingIssues = [{
    id: "standard-cut-user-review",
    detail: `${cut.id} must pass rendered MP4 bubble timing, face, camera, and visual review.`,
  }];
  const contractAudit = auditManifestAgainstKoyaContract(manifest, resolved);
  if (!contractAudit.pass) {
    throw new Error(`Koya manifest contract failed after standard-cut adjustment: ${JSON.stringify(contractAudit.failures)}`);
  }
  await Promise.all([
    writeJsonAtomic(paths.manifestPath, manifest),
    writeJsonAtomic(paths.contractSnapshotPath, {
      version: resolved.contract.version,
      digest: resolved.digest,
      contractPath: resolved.contractPath,
      episodeOverridePath: resolved.episodeOverridePath,
      contract: resolved.contract,
    }),
  ]);
  const state = await updateState(paths, {
    episodeId: options.episodeId,
    status: "layout-adjusted-awaiting-render",
    currentStage: "render",
    manifestPath: paths.manifestPath,
    contractSnapshotPath: paths.contractSnapshotPath,
    contractDigest: resolved.digest,
    knownRemainingIssues: manifest.knownRemainingIssues,
  });
  return {
    episodeId: options.episodeId,
    cutId: cut.id,
    revision: plan.revision,
    planPath,
    backupPath,
    shotIds: normalizedShots.map((shot) => shot.id),
    refreshedBubbleCount: refreshed.refreshed.length,
    contractAudit,
    paths,
    state,
  };
}

function sourceShotImageSize(plan, shotId, fallback) {
  const shot = (plan.shots || []).find((entry) => entry.id === shotId);
  return shot?.imageSize || fallback;
}

export async function syncKoyaMangaContract(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  const paths = episodePaths(projectDir, options.episodeId);
  const resolved = await resolveKoyaMangaProductionContract({
    projectDir,
    episodeId: options.episodeId,
    contractPath: options.contractPath,
    overridePath: options.overridePath,
  });
  const manifestInput = await readJson(paths.manifestPath);
  const existingGenerator = manifestInput.production?.provenance?.generator;
  const generatorProvenance = existingGenerator?.contextId
    ? existingGenerator
    : resolveKoyaAgentProvenance({
      role: "generator",
      host: options.generatorHost,
      id: options.generatorId,
      contextId: options.generatorContextId,
      source: options.generatorProvenanceSource || "legacy-contract-migration",
    });
  const manifest = applyKoyaContractToManifest(manifestInput, resolved);
  manifest.production = {
    ...(manifest.production || {}),
    provenance: {
      ...(manifest.production?.provenance || {}),
      generator: generatorProvenance,
    },
  };
  const contractAudit = auditManifestAgainstKoyaContract(manifest, resolved);
  if (!contractAudit.pass) {
    throw new Error(`Koya manifest contract failed after contract sync: ${JSON.stringify(contractAudit.failures)}`);
  }
  await Promise.all([
    writeJsonAtomic(paths.manifestPath, manifest),
    writeJsonAtomic(paths.contractSnapshotPath, {
      version: resolved.contract.version,
      digest: resolved.digest,
      contractPath: resolved.contractPath,
      episodeOverridePath: resolved.episodeOverridePath,
      contract: resolved.contract,
    }),
  ]);
  const state = await updateState(paths, {
    episodeId: options.episodeId,
    status: "rendered-awaiting-audit",
    currentStage: "audit",
    manifestPath: paths.manifestPath,
    contractSnapshotPath: paths.contractSnapshotPath,
    contractDigest: resolved.digest,
    generatorProvenance,
    knownRemainingIssues: manifest.knownRemainingIssues || [],
  });
  return { episodeId: options.episodeId, contractAudit, paths, resolved, state };
}

export async function refreshKoyaMangaBubbles(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  const paths = episodePaths(projectDir, options.episodeId);
  const resolved = await resolveKoyaMangaProductionContract({
    projectDir,
    episodeId: options.episodeId,
    contractPath: options.contractPath,
    overridePath: options.overridePath,
  });
  const refreshed = await refreshEpisodeBubbleOverlays({
    projectDir,
    manifestPath: paths.manifestPath,
    refreshAll: true,
    reflowPlacement: options.reflowPlacement !== false,
    sequenceAware: true,
    stripTerminalJapanesePeriod: resolved.contract.bubbles.stripTerminalJapanesePeriod,
  });
  const manifest = applyKoyaContractToManifest(refreshed.manifest, resolved);
  manifest.status = "bubble-layout-ready";
  manifest.outputs = {};
  manifest.knownRemainingIssues = [{
    id: "fresh-render-required",
    detail: "Bubble SVG artifacts changed and the real MP4 must be rendered and audited again.",
  }];
  manifest.production = {
    ...(manifest.production || {}),
    bubbleDisplayPolicy: {
      preserveAuthoredSpeechText: true,
      stripTerminalJapanesePeriod: resolved.contract.bubbles.stripTerminalJapanesePeriod === true,
      refreshedAt: new Date().toISOString(),
    },
  };
  const contractAudit = auditManifestAgainstKoyaContract(manifest, resolved);
  if (!contractAudit.pass) {
    throw new Error(`Koya manifest contract failed after bubble refresh: ${JSON.stringify(contractAudit.failures)}`);
  }
  await writeJsonAtomic(paths.manifestPath, manifest);
  const state = await updateState(paths, {
    status: "bubble-layout-ready",
    currentStage: "render",
    manifestPath: paths.manifestPath,
    knownRemainingIssues: manifest.knownRemainingIssues,
  });
  return { episodeId: options.episodeId, paths, resolved, manifest, refreshed: refreshed.refreshed, contractAudit, state };
}

export async function renderKoyaMangaVideo(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  if (!options.episodeId) throw new Error("episodeId is required.");
  const paths = episodePaths(projectDir, options.episodeId);
  const resolved = await resolveKoyaMangaProductionContract({
    projectDir,
    episodeId: options.episodeId,
    contractPath: options.contractPath,
    overridePath: options.overridePath,
  });
  const manifestBeforeRender = await readJson(paths.manifestPath);
  if (!manifestBeforeRender.production?.provenance?.generator?.contextId) {
    throw new Error("Render is blocked: generator task/session provenance is missing. Run plan or sync-contract with a real generator context first.");
  }
  const result = await renderEpisodeVideo({
    projectDir,
    manifestPath: paths.manifestPath,
    renderConcurrency: recommendedKoyaRenderConcurrency({
      requested: options.renderConcurrency,
      cameraOversample: resolved.contract.camera.cameraOversample,
    }),
    cutIds: options.cutIds,
    reuseRenderedCuts: options.reuseRenderedCuts !== false,
    force: options.force === true,
    fileName: options.fileName || `${options.episodeId}-${resolved.contract.version}.mp4`,
    bgmPath: "",
    bgmVolume: 0,
    masterTargetLufs: resolved.contract.audio.masterTargetLufs,
    masterTruePeakDb: resolved.contract.audio.masterTruePeakDb,
  });
  const state = await updateState(paths, {
    status: "rendered-awaiting-audit",
    currentStage: "audit",
    reviewVideoPath: result.outputPath || result.manifest?.outputs?.reviewVideo?.filePath || "",
    knownRemainingIssues: [],
  });
  return { ...result, paths, resolved, state };
}

export async function readKoyaProductionState(options = {}) {
  const paths = episodePaths(resolve(options.projectDir || process.cwd()), options.episodeId);
  return { paths, state: await readJson(paths.statePath) };
}

export { episodePaths as koyaEpisodePaths };
