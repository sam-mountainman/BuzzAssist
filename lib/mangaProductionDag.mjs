import { access } from "node:fs/promises";
import { cpus } from "node:os";

import { writeJsonAtomic } from "./canvasScene.mjs";
import { runWithConcurrency } from "./mediaGeneration.mjs";
import { auditMangaPreflight, createMangaQualityContract } from "./mangaQualityHarness.mjs";
import { mangaVideoJobInputHash } from "./mangaVideoPipeline.mjs";
import { buildMangaSceneImagePrompt, planMangaSceneCompositions } from "./mangaSceneComposition.mjs";

export const MANGA_PRODUCTION_DAG_VERSION = 4;

const DEFAULT_POOLS = {
  planning: 8,
  image: 10,
  tts: 4,
  svg: Math.max(2, Math.min(8, cpus().length || 2)),
  render: Math.max(2, Math.min(4, cpus().length || 2)),
  audit: 6,
};

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function stableNode(kind, id, dependencies, pool, input, metadata = {}) {
  return {
    id,
    kind,
    dependencies: unique(dependencies),
    pool,
    inputHash: mangaVideoJobInputHash(`dag:${kind}`, input),
    metadata,
  };
}

export function createMangaProductionDag(input = {}) {
  const manifest = input.manifest;
  if (!manifest?.id || !Array.isArray(manifest.cuts) || !Array.isArray(manifest.utterances)) {
    throw new Error("A parsed episode manifest with cuts and utterances is required.");
  }
  const utteranceById = new Map(manifest.utterances.map((entry) => [entry.id, entry]));
  const speakers = unique(manifest.utterances
    .filter((entry) => entry.speakerId && entry.speakerId !== "narration")
    .map((entry) => entry.speakerId))
    .map((speakerId) => {
      const sample = manifest.utterances.find((entry) => entry.speakerId === speakerId);
      return { id: speakerId, name: sample?.speakerName || speakerId };
    });
  const voiceSpeakers = unique(manifest.utterances.map((entry) => entry.speakerId)).map((speakerId) => {
    const sample = manifest.utterances.find((entry) => entry.speakerId === speakerId);
    return { id: speakerId, name: sample?.speakerName || speakerId };
  });
  const nodes = [];
  const add = (...args) => nodes.push(stableNode(...args));
  const compositionPlan = planMangaSceneCompositions({ manifest });
  const compositionByUtteranceId = new Map(compositionPlan.beats.map((beat) => [beat.utteranceId, beat]));
  const scriptId = "script-analysis";
  add("script-analysis", scriptId, [], "planning", {
    episodeId: manifest.id,
    scriptText: manifest.scriptText,
    cuts: manifest.cuts.map((cut) => cut.id),
    utterances: manifest.utterances.map((entry) => ({ id: entry.id, text: entry.text, speakerId: entry.speakerId })),
  });
  const qualityContract = input.qualityContract?.digest
    ? input.qualityContract
    : createMangaQualityContract({
        manifest,
        channelDirectives: input.channelDirectives,
        overrides: input.qualityContractOverrides,
      });
  const qualityContractId = "quality-contract";
  add("quality-contract", qualityContractId, [scriptId], "planning", {
    episodeId: manifest.id,
    contract: qualityContract,
  }, { contractDigest: qualityContract.digest });
  const preflightReport = auditMangaPreflight({
    manifest,
    contract: qualityContract,
    compositionPlan,
    stage: "planning",
  });
  const preflightId = "preflight-hard-gates";
  add("preflight-hard-gates", preflightId, [qualityContractId], "audit", {
    episodeId: manifest.id,
    contractDigest: qualityContract.digest,
    report: preflightReport,
    policy: "fail closed before paid generation when a deterministic gate fails",
  }, { pass: preflightReport.pass, failedGateIds: preflightReport.failedGateIds });

  const identityDependencies = [];
  const characterVariationAxes = ["顔・髪・輪郭の識別性", "年齢感・体格・服装", "表情域・物語上の存在感"];
  for (const speaker of speakers) {
    const candidateIds = [1, 2, 3].map((candidate) => {
      const id = `character-candidate:${speaker.id}:${candidate}`;
      const variationAxis = characterVariationAxes[candidate - 1];
      add("character-candidate", id, [preflightId], "image", { episodeId: manifest.id, speaker, candidate, variationAxis }, { candidate, variationAxis });
      return id;
    });
    const approvalId = `character-approval:${speaker.id}`;
    add("character-approval", approvalId, candidateIds, "planning", {
      episodeId: manifest.id,
      speaker,
      candidateIds,
      route: "human-best-of-n",
      requireSelectionReason: true,
      revealProviderOnlyAfterVerdict: true,
    }, { route: "human-best-of-n", requireSelectionReason: true });
    for (const sheetType of ["turnaround", "expressions"]) {
      const id = `identity-sheet:${speaker.id}:${sheetType}`;
      add("identity-sheet", id, [approvalId], "image", { episodeId: manifest.id, speaker, sheetType }, { sheetType });
      identityDependencies.push(id);
    }
  }

  const voiceDiscoveryId = "voice-library-discovery";
  add("voice-library-discovery", voiceDiscoveryId, [preflightId], "planning", {
    episodeId: manifest.id,
    language: "ja",
    sourcePool: "account-plus-complete-public-voice-library",
    rankingDimensions: ["gender", "voice-age", "personality", "emotional-range", "dialogue-use-case", "operational-risk"],
    policy: "read-only discovery; never bulk-add shared voices",
  }, { previewRequired: true, accountMutation: false });
  const voiceApprovalId = "voice-library-approval";
  add("voice-library-approval", voiceApprovalId, [voiceDiscoveryId], "planning", {
    episodeId: manifest.id,
    policy: "a human must listen to previews; add only explicitly approved shared voices to My Voices",
    route: "human-best-of-n",
    requireSelectionReason: true,
  }, { previewConfirmedRequired: true, explicitApprovalRequired: true, requireSelectionReason: true });

  const voiceProfileIds = new Map();
  for (const speaker of voiceSpeakers) {
    const id = `voice-profile:${speaker.id}`;
    add("voice-profile", id, [voiceApprovalId], "planning", {
      episodeId: manifest.id,
      speaker,
      pronunciations: manifest.speech?.pronunciations || [],
    });
    voiceProfileIds.set(speaker.id, id);
  }

  add("bgm-effect-tags", "bgm-effect-tags", [preflightId], "planning", {
    episodeId: manifest.id,
    cuts: manifest.cuts.map((cut) => ({ id: cut.id, description: cut.description })),
  });

  const cameraPlanIds = new Map();
  const baseImageIds = [];
  const imageQcIds = new Map();
  const angleIdsByCut = new Map();
  const faceRegionIds = new Map();
  for (const cut of manifest.cuts) {
    const speakerIds = unique(cut.utteranceIds.map((id) => utteranceById.get(id)?.speakerId));
    const cameraId = `camera-plan:${cut.id}`;
    const cutCompositionBeats = cut.utteranceIds.map((id) => compositionByUtteranceId.get(id)).filter(Boolean);
    add("camera-plan", cameraId, [preflightId], "planning", {
      episodeId: manifest.id,
      cutId: cut.id,
      utteranceIds: cut.utteranceIds,
      speakerIds,
      panelPolicy: input.panelPolicy || "one-full-bleed-default; two-panel-standard; three-panel-only-for-three-stage-change; no-four-plus",
      compositionPolicy: compositionPlan.policy,
      beats: cutCompositionBeats,
    });
    cameraPlanIds.set(cut.id, cameraId);
    const relevantSheets = identityDependencies.filter((id) => speakerIds.some((speakerId) => id.includes(`:${speakerId}:`)));
    const baseId = `base-image:${cut.id}`;
    add("base-image", baseId, [cameraId, ...relevantSheets], "image", {
      episodeId: manifest.id,
      cutId: cut.id,
      imageModel: input.imageModel || "gpt-image-2",
      description: cut.description,
      speakerIds,
      composition: cutCompositionBeats[0],
      prompt: cutCompositionBeats[0] ? buildMangaSceneImagePrompt(cutCompositionBeats[0], { cast: speakerIds }) : "",
    });
    baseImageIds.push(baseId);
    const qcId = `image-qc:${cut.id}`;
    add("image-qc", qcId, [baseId], "audit", { episodeId: manifest.id, cutId: cut.id, profileId: input.profileId });
    imageQcIds.set(cut.id, qcId);
    const faceId = `face-regions:${cut.id}`;
    add("face-regions", faceId, [qcId], "planning", { episodeId: manifest.id, cutId: cut.id, speakerIds });
    faceRegionIds.set(cut.id, faceId);
    const angleIds = cutCompositionBeats.map((beat) => {
      const id = `camera-asset:${beat.utteranceId}`;
      add("camera-asset", id, [qcId], "image", {
        episodeId: manifest.id,
        cutId: cut.id,
        utteranceId: beat.utteranceId,
        composition: beat,
        prompt: buildMangaSceneImagePrompt(beat, { cast: speakerIds }),
      });
      return id;
    });
    angleIdsByCut.set(cut.id, angleIds);
  }

  const ttsIds = [];
  const prelayoutIds = [];
  const finalBubbleIdsByCut = new Map(manifest.cuts.map((cut) => [cut.id, []]));
  for (const utterance of manifest.utterances) {
    const prelayoutId = `bubble-prelayout:${utterance.id}`;
    add("bubble-prelayout", prelayoutId, [preflightId], "svg", {
      episodeId: manifest.id,
      utteranceId: utterance.id,
      text: utterance.text,
      preset: utterance.preset,
    });
    prelayoutIds.push(prelayoutId);
    const ttsId = `tts:${utterance.id}`;
    add("tts", ttsId, [voiceProfileIds.get(utterance.speakerId)], "tts", {
      episodeId: manifest.id,
      utteranceId: utterance.id,
      text: utterance.speechText || utterance.text,
      speakerId: utterance.speakerId,
      voiceId: utterance.voiceId,
      model: utterance.model,
      settings: utterance.voiceSettings,
    });
    ttsIds.push(ttsId);
  }

  add("fast-preview", "fast-preview", [...baseImageIds, ...ttsIds, ...prelayoutIds], "render", {
    episodeId: manifest.id,
    cutCount: manifest.cuts.length,
    policy: "ten base cuts only; does not wait for 70 camera assets",
  });
  add("timing", "speech-timing", ttsIds, "planning", {
    episodeId: manifest.id,
    sameSpeakerGapSeconds: input.sameSpeakerGapSeconds ?? 0.17,
    speakerChangeGapSeconds: input.speakerChangeGapSeconds ?? 0.3,
    emphasisGapSeconds: input.emphasisGapSeconds ?? 0.5,
  });

  for (const utterance of manifest.utterances) {
    const finalId = `bubble-final:${utterance.id}`;
    add("bubble-final", finalId, [
      `bubble-prelayout:${utterance.id}`,
      "speech-timing",
      faceRegionIds.get(utterance.cutId),
    ], "svg", { episodeId: manifest.id, utteranceId: utterance.id, cutId: utterance.cutId });
    finalBubbleIdsByCut.get(utterance.cutId)?.push(finalId);
  }

  const renderIds = [];
  for (const cut of manifest.cuts) {
    const id = `render-cut:${cut.id}`;
    add("render-cut", id, [
      ...angleIdsByCut.get(cut.id),
      ...finalBubbleIdsByCut.get(cut.id),
      ...cut.utteranceIds.map((utteranceId) => `tts:${utteranceId}`),
      "speech-timing",
    ], "render", { episodeId: manifest.id, cutId: cut.id });
    renderIds.push(id);
  }
  add("final-mp4", "final-mp4", [...renderIds, "bgm-effect-tags"], "render", { episodeId: manifest.id });

  const auditIds = ["materials", "bubbles", "voice", "edit", "camera"].map((category) => {
    const id = `audit:${category}`;
    add("independent-audit", id, ["final-mp4"], "audit", {
      episodeId: manifest.id,
      category,
      maximumScore: 100,
      qualityContractDigest: qualityContract.digest,
      generatorEvaluatorSeparation: true,
      evidenceRequired: true,
    }, { qualityContractDigest: qualityContract.digest, independent: true, evidenceRequired: true });
    return id;
  });
  add("whole-program-audit", "audit:whole", ["final-mp4", ...auditIds], "audit", {
    episodeId: manifest.id,
    category: "whole",
    maximumScore: 100,
    qualityContractDigest: qualityContract.digest,
    policy: "requires reference side-by-side, native-size checks and full-length viewing; automation alone cannot award 100",
  }, { qualityContractDigest: qualityContract.digest, fullLengthViewingRequired: true });
  add("quality-decision", "quality-decision", ["audit:whole", ...auditIds], "audit", {
    episodeId: manifest.id,
    qualityContractDigest: qualityContract.digest,
    targetScore: qualityContract.limits.targetScore,
    maximumReviewRounds: qualityContract.limits.maximumReviewRounds,
    stopConditions: qualityContract.limits,
    candidatePolicy: qualityContract.candidatePolicy,
    policy: "deterministic gates first; fresh blind evaluator second; pass, bounded revision, or human escalation",
  }, {
    qualityContractDigest: qualityContract.digest,
    targetScore: qualityContract.limits.targetScore,
    maximumReviewRounds: qualityContract.limits.maximumReviewRounds,
  });

  return {
    version: MANGA_PRODUCTION_DAG_VERSION,
    episodeId: manifest.id,
    createdAt: new Date().toISOString(),
    pools: {
      ...DEFAULT_POOLS,
      ...(input.pools || {}),
      image: Math.max(1, Math.min(10, Number(input.pools?.image || DEFAULT_POOLS.image))),
      tts: Math.max(4, Math.min(8, Number(input.pools?.tts || DEFAULT_POOLS.tts))),
      render: Math.max(2, Math.min(4, Number(input.pools?.render || DEFAULT_POOLS.render))),
    },
    paths: {
      preview: { terminalNodeId: "fast-preview", waitsForCameraAssets: false },
      final: { terminalNodeId: "quality-decision", cameraAssetCount: compositionPlan.beats.length },
    },
    qualityContract,
    preflightReport,
    compositionPlan,
    nodes,
  };
}

export function validateMangaProductionDag(dag) {
  const ids = new Set(dag.nodes.map((node) => node.id));
  if (ids.size !== dag.nodes.length) throw new Error("DAG node IDs must be unique.");
  for (const node of dag.nodes) {
    for (const dependency of node.dependencies) {
      if (!ids.has(dependency)) throw new Error(`${node.id} depends on unknown node ${dependency}.`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(dag.nodes.map((node) => [node.id, node]));
  const visit = (id) => {
    if (visiting.has(id)) throw new Error(`DAG cycle detected at ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of dag.nodes) visit(node.id);
  return true;
}

async function defaultOutputsExist(outputs = []) {
  const paths = Array.isArray(outputs) ? outputs : [];
  if (paths.length === 0) return true;
  try {
    await Promise.all(paths.map((path) => access(path)));
    return true;
  } catch {
    return false;
  }
}

function builtInDagHandler(node) {
  if (node.kind === "quality-contract") {
    return async () => ({ value: { qualityContractDigest: node.metadata.qualityContractDigest } });
  }
  if (node.kind === "preflight-hard-gates") {
    return async () => {
      if (node.metadata.pass !== true) {
        throw new Error(`Preflight hard gates failed: ${(node.metadata.failedGateIds || []).join(", ") || "unknown"}`);
      }
      return { value: { pass: true, failedGateIds: [] } };
    };
  }
  return null;
}

export async function executeMangaProductionDag({
  dag,
  handlers = {},
  state: initialState,
  statePath = "",
  force = false,
  retryFailed = true,
  maximumAttemptsPerRun = 2,
  outputsExist = defaultOutputsExist,
} = {}) {
  validateMangaProductionDag(dag);
  const state = initialState || { version: 1, episodeId: dag.episodeId, jobs: {}, metrics: { byKind: {} } };
  state.jobs ||= {};
  state.metrics ||= { byKind: {} };
  state.metrics.byKind ||= {};
  let checkpointChain = Promise.resolve();
  const checkpoint = () => {
    if (!nonEmptyString(statePath)) return Promise.resolve();
    checkpointChain = checkpointChain.then(() => writeJsonAtomic(statePath, state));
    return checkpointChain;
  };
  for (const node of dag.nodes) {
    const previous = state.jobs[node.id];
    const sameInput = previous?.inputHash === node.inputHash;
    const reusable = !force && sameInput && previous?.status === "complete" && await outputsExist(previous.outputs || [], node);
    state.jobs[node.id] = reusable
      ? { ...previous, reused: true, elapsedMs: 0 }
      : {
          id: node.id,
          kind: node.kind,
          pool: node.pool,
          inputHash: node.inputHash,
          status: previous?.status === "failed" && retryFailed ? "pending" : "pending",
          attempts: sameInput ? Number(previous?.attempts || 0) : 0,
          retryCount: sameInput ? Number(previous?.retryCount || 0) : 0,
          outputs: sameInput ? previous?.outputs || [] : [],
          cost: sameInput ? Number(previous?.cost || 0) : 0,
          reused: false,
        };
  }
  await checkpoint();

  const nodeById = new Map(dag.nodes.map((node) => [node.id, node]));
  while (true) {
    const ready = dag.nodes.filter((node) => {
      const job = state.jobs[node.id];
      if (job.status !== "pending") return false;
      if (typeof handlers[node.kind] !== "function" && typeof handlers[node.id] !== "function" && !builtInDagHandler(node)) return false;
      return node.dependencies.every((dependency) => state.jobs[dependency]?.status === "complete");
    });
    if (ready.length === 0) break;
    const groups = Object.groupBy
      ? Object.groupBy(ready, (node) => node.pool)
      : ready.reduce((output, node) => ({ ...output, [node.pool]: [...(output[node.pool] || []), node] }), {});
    await Promise.all(Object.entries(groups).map(async ([pool, poolNodes]) => {
      const concurrency = Math.max(1, Math.round(Number(dag.pools?.[pool] || 1)));
      await runWithConcurrency(poolNodes, concurrency, async (node) => {
        const job = state.jobs[node.id];
        const handler = handlers[node.id] || handlers[node.kind] || builtInDagHandler(node);
        job.status = "running";
        job.startedAt = new Date().toISOString();
        job.error = "";
        await checkpoint();
        const startedAt = Date.now();
        let result;
        let lastError;
        const attemptsThisRun = node.kind === "preflight-hard-gates"
          ? 1
          : Math.max(1, Math.round(Number(maximumAttemptsPerRun || 1)));
        for (let attempt = 0; attempt < attemptsThisRun; attempt += 1) {
          job.attempts += 1;
          try {
            result = await handler({ node, dag, state, job, dependencyJobs: node.dependencies.map((id) => state.jobs[id]) });
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            if (attempt + 1 < attemptsThisRun) job.retryCount += 1;
          }
        }
        const elapsedMs = Date.now() - startedAt;
        if (lastError) {
          job.status = "failed";
          job.error = lastError?.message || String(lastError);
        } else {
          job.status = "complete";
          job.outputs = Array.isArray(result?.outputs) ? result.outputs : [];
          job.cost = Number(result?.cost || 0);
          job.value = result?.value;
        }
        job.elapsedMs = elapsedMs;
        job.finishedAt = new Date().toISOString();
        const kindMetrics = state.metrics.byKind[node.kind] || { elapsedMs: 0, cost: 0, retryCount: 0, completed: 0, failed: 0 };
        kindMetrics.elapsedMs += elapsedMs;
        kindMetrics.cost += Number(job.cost || 0);
        kindMetrics.retryCount += Number(job.retryCount || 0);
        kindMetrics[job.status === "complete" ? "completed" : "failed"] += 1;
        state.metrics.byKind[node.kind] = kindMetrics;
        await checkpoint();
        return job;
      }, { jobId: (node) => node.id });
    }));
  }
  state.updatedAt = new Date().toISOString();
  state.summary = {
    complete: Object.values(state.jobs).filter((job) => job.status === "complete").length,
    failed: Object.values(state.jobs).filter((job) => job.status === "failed").length,
    pending: Object.values(state.jobs).filter((job) => job.status === "pending").length,
    blocked: dag.nodes.filter((node) => (
      state.jobs[node.id].status === "pending"
      && node.dependencies.some((dependency) => state.jobs[dependency]?.status !== "complete")
    )).map((node) => node.id),
    withoutHandler: dag.nodes.filter((node) => (
      state.jobs[node.id].status === "pending"
      && typeof handlers[node.kind] !== "function"
      && typeof handlers[node.id] !== "function"
      && !builtInDagHandler(node)
    )).map((node) => node.id),
  };
  await checkpoint();
  return state;
}
