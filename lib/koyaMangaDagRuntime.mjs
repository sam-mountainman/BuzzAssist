import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { sha256File } from "./mangaQualityEvidence.mjs";

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

async function existing(paths) {
  const output = [];
  for (const path of [...new Set(paths.filter(Boolean).map((entry) => resolve(entry)))]) {
    await access(path);
    output.push(path);
  }
  return output;
}

function cutFor(manifest, node) {
  return (manifest.cuts || []).find((entry) => entry.id === node.input?.cutId);
}

function utteranceFor(manifest, node) {
  return (manifest.utterances || []).find((entry) => entry.id === node.input?.utteranceId);
}

function cutImages(cut) {
  return [
    cut?.imagePath,
    ...(cut?.cameraSequence || []).map((entry) => entry.imagePath),
    ...(cut?.shots || []).map((entry) => entry.imagePath),
  ].filter(Boolean);
}

/**
 * Official hydrated-artifact adapter for the checkpoint DAG. Artifact nodes
 * verify the real files produced by the Koya entrypoint; deterministic
 * planning nodes preserve their DAG input hash instead of inventing output.
 */
export function createKoyaMangaDagRuntime({ manifestPath } = {}) {
  const absoluteManifestPath = resolve(manifestPath);
  let cachedManifest;
  const manifest = async () => {
    cachedManifest ||= JSON.parse(await readFile(absoluteManifestPath, "utf8"));
    return cachedManifest;
  };
  const requireValue = (value, message) => {
    if (!value) throw new Error(message);
    return value;
  };
  const planning = async ({ node }) => ({ value: { verified: true, nodeId: node.id, inputHash: node.inputHash } });
  const image = async ({ node }) => {
    const current = await manifest();
    const cut = cutFor(current, node);
    const paths = cutImages(cut);
    if (node.kind === "character-candidate" || node.kind === "identity-sheet") {
      const approved = current.production?.characterBiblePath || current.production?.characterRegistryPath
        || (current.cuts || []).some((entry) => cutImages(entry).length > 0);
      requireValue(approved, `${node.id}: approved character/image evidence is missing; resume the official images stage.`);
      return { value: { verified: true, approvedCharacterEvidence: true } };
    }
    requireValue(cut && paths.length > 0, `${node.id}: generated cut images are missing; resume the official images stage.`);
    return { outputs: await existing(paths), value: { verified: true, cutId: cut.id } };
  };
  const tts = async ({ node }) => {
    const utterance = utteranceFor(await manifest(), node);
    const audioPath = nonEmpty(utterance?.audio?.filePath);
    requireValue(audioPath, `${node.id}: utterance audio is missing; resume the official speech stage.`);
    return { outputs: await existing([audioPath]), value: { verified: true, utteranceId: utterance.id } };
  };
  const bubble = async ({ node }) => {
    const utterance = utteranceFor(await manifest(), node);
    requireValue(utterance && Array.isArray(utterance.bubbleSegments) && utterance.bubbleSegments.length > 0,
      `${node.id}: compiled bubble segments are missing; resume the official prepare stage.`);
    return { value: { verified: true, segmentCount: utterance.bubbleSegments.length } };
  };
  const renderCut = async ({ node }) => {
    const current = await manifest();
    const path = current.jobs?.render?.[node.input?.cutId]?.outputPath
      || current.jobs?.render?.[node.input?.cutId]?.filePath;
    requireValue(path, `${node.id}: rendered cut artifact is missing; resume the official render stage.`);
    return { outputs: await existing([path]), value: { verified: true } };
  };
  const finalMp4 = async ({ node }) => {
    const current = await manifest();
    const path = current.outputs?.finalVideo?.filePath || current.outputs?.reviewVideo?.filePath;
    requireValue(path, `${node.id}: final/review MP4 is missing; resume the official render stage.`);
    const outputs = await existing([path]);
    const actualSha256 = await sha256File(path);
    const expectedSha256 = nonEmpty(current.outputs?.finalVideo?.sha256);
    if (expectedSha256) requireValue(actualSha256 === expectedSha256, `${node.id}: final MP4 digest does not match the audited manifest.`);
    return { outputs, value: { verified: true, sha256: actualSha256 } };
  };
  const independentAudit = async ({ node }) => {
    const current = await manifest();
    const reportPath = current.production?.finalKoyaAudit?.path || current.outputs?.finalVideo?.auditReportPath;
    requireValue(reportPath, `${node.id}: official final-audit evidence is missing.`);
    const report = JSON.parse(await readFile(resolve(reportPath), "utf8"));
    const finalVideoPath = nonEmpty(current.outputs?.finalVideo?.filePath || current.outputs?.reviewVideo?.filePath);
    const finalVideoSha256 = finalVideoPath ? await sha256File(finalVideoPath) : "";
    requireValue(report.videoPath === finalVideoPath, `${node.id}: final audit is bound to another MP4 path.`);
    requireValue(report.videoSha256 === finalVideoSha256, `${node.id}: final audit is bound to another MP4 digest.`);
    const category = node.input?.category;
    if (category === "whole" || node.kind === "quality-decision") {
      requireValue(report.pass === true && report.knownRemainingIssues?.length === 0, `${node.id}: final audit has not passed cleanly.`);
    } else {
      const failed = new Set(report.failedAuditIds || []);
      const categoryMap = {
        materials: ["contract-manifest", "editorial-quality", "split-page-integrity"],
        bubbles: ["bubble-midpoint-frames", "bubble-transition-clear-frames", "bubble-camera-sweep", "bubble-typography"],
        voice: ["stt-verification", "audio-onset", "audio-speaker-continuity", "audio-waveform-sync", "audio-click-hum-level"],
        edit: ["editorial-quality", "agent-contact-sheet-review", "full-decode"],
        camera: ["rendered-camera", "independent-rendered-face", "thought-spotlight"],
      };
      requireValue((categoryMap[category] || []).every((id) => !failed.has(id)), `${node.id}: category audit failed.`);
    }
    return { outputs: await existing([reportPath]), value: { verified: true, category, reportPath } };
  };
  return {
    "script-analysis": planning,
    "character-candidate": image,
    "character-approval": planning,
    "identity-sheet": image,
    "voice-library-discovery": planning,
    "voice-library-approval": planning,
    "voice-profile": async ({ node }) => {
      const current = await manifest();
      const speakerId = node.input?.speaker?.id;
      const speakerUtterances = (current.utterances || []).filter((entry) => entry.speakerId === speakerId);
      requireValue(speakerUtterances.length > 0 && speakerUtterances.every((entry) => entry.voiceId), `${node.id}: approved voice is missing.`);
      return { value: { verified: true, speakerId } };
    },
    "bgm-effect-tags": planning,
    "camera-plan": planning,
    "base-image": image,
    "image-qc": image,
    "face-regions": planning,
    "camera-asset": image,
    "bubble-prelayout": bubble,
    tts,
    "fast-preview": finalMp4,
    timing: planning,
    "bubble-final": bubble,
    "render-cut": renderCut,
    "final-mp4": finalMp4,
    "independent-audit": independentAudit,
    "whole-program-audit": independentAudit,
    "quality-decision": independentAudit,
  };
}
