// 漫画の Job の「途中の成果物」の投影の試験で共有する合成の Job と作業場。
// 人物名・話数・会話 id・カット id はすべて合成の値。画像と音声は試験の中で作る。
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { makeGradientPng } from "./operatorImageFixture.mjs";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export const EPISODE_ID = "ep-synthetic-01";
export const JOB_ID = "video-koya-manga-video-0123456789abcdef";
export const FIXED_NAME = "合成人物甲";
export const NEW_NAME = "合成人物乙";
export const NEW_CAST_ID = "cast-synthetic-otsu";
export const WORKFLOW_ID = "workflow-synthetic-01";

/** 16bit モノラルの WAV。振幅が山になるので波形が平らにならない。 */
export function makeWav(seconds = 1.2, frequency = 220, sampleRate = 8000) {
  const frames = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(frames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    const envelope = Math.sin((Math.PI * frame) / frames);
    const value = Math.round(Math.sin((2 * Math.PI * frequency * frame) / sampleRate) * envelope * 30000);
    data.writeInt16LE(value, frame * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeBytes(file, bytes) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return { path: file, sha256: sha256(bytes) };
}

export function koyaPaths(workspace) {
  const canvasDir = join(workspace, "canvas");
  const episodeDir = join(canvasDir, "manga-videos", EPISODE_ID);
  const assetDir = join(canvasDir, "assets", EPISODE_ID);
  return {
    canvasDir,
    episodeDir,
    assetDir,
    state: join(episodeDir, "koya-production-state.json"),
    plan: join(assetDir, "script-image-plan.json"),
    ledger: join(assetDir, "image-generation-ledger.json"),
    workflows: join(canvasDir, "character-workflows.json"),
    registry: join(canvasDir, "characters.json"),
    manifest: join(episodeDir, "episode-manifest.json"),
    speech: join(episodeDir, "koya-dialogue-generation.json"),
    sourceDir: join(episodeDir, ".koya-dialogue-source"),
  };
}

/** 固定キャスト1人（登録簿で承認済み）と、話ごとの新しい人物1人（候補 A〜C を選ぶ前）。 */
export async function writeCharacterApprovalPending(workspace) {
  const paths = koyaPaths(workspace);
  const face = await writeBytes(join(paths.canvasDir, "assets", "characters", "fixed-synthetic-face.png"), makeGradientPng(64, 64, 1));
  const turnaround = await writeBytes(join(paths.canvasDir, "assets", "characters", "fixed-synthetic-turnaround.png"), makeGradientPng(96, 54, 2));
  const candidates = [];
  for (const [index, label] of ["A", "B", "C"].entries()) {
    const file = await writeBytes(
      join(paths.canvasDir, "assets", `blind-${WORKFLOW_ID}-${NEW_CAST_ID}`, `${label}.png`),
      makeGradientPng(80, 45, 10 + index),
    );
    candidates.push({
      id: `${NEW_CAST_ID}-candidates-${index + 1}`,
      index: index + 1,
      status: "generated",
      prompt: `${NEW_NAME} の合成プロンプト ${index + 1}`,
      variationAxis: `合成の作り分け ${index + 1}`,
      blindLabel: label,
      candidateSetId: "set-synthetic-01",
      blindArtifactFile: file.path,
      blindArtifactSha256: file.sha256,
      assetFile: file.path,
    });
  }
  await writeJson(paths.registry, {
    version: 1,
    revision: 1,
    characters: [{
      id: "fixed-synthetic",
      name: FIXED_NAME,
      kind: "character",
      role: "fixed",
      status: "approved",
      referenceAssets: [
        // 相対パスは canvas/ から（登録簿の既存の書き方）。
        { id: "face", role: "identity-face", path: "assets/characters/fixed-synthetic-face.png", sha256: face.sha256 },
        { id: "turn", role: "turnaround", path: turnaround.path, sha256: turnaround.sha256 },
      ],
    }],
    voices: [],
  });
  await writeJson(paths.workflows, {
    version: 1,
    revision: 3,
    workflows: [{
      id: WORKFLOW_ID,
      title: "合成の話",
      episodeId: EPISODE_ID,
      status: "awaiting-approval",
      createdAt: "2026-09-25T00:00:00.000Z",
      cast: [
        { id: "cast-synthetic-kou", name: FIXED_NAME, role: "fixed", status: "existing", matchedCharacterId: "fixed-synthetic", candidates: [] },
        { id: NEW_CAST_ID, name: NEW_NAME, role: "per-video", status: "awaiting-approval", description: `${NEW_NAME}の合成の説明`, candidates },
      ],
    }],
  });
  await writeJson(paths.state, {
    version: "koya-production-state-v1",
    episodeId: EPISODE_ID,
    status: "awaiting-character-approval",
    currentStage: "character-approval",
  });
  return { paths, face, turnaround, candidates };
}

/** 候補 B の採用と、設定画の登録まで済ませる（承認後）。 */
export async function approveNewCharacter(workspace) {
  const paths = koyaPaths(workspace);
  const sheet = await writeBytes(join(paths.canvasDir, "assets", "characters", "new-synthetic-face.png"), makeGradientPng(64, 64, 21));
  const workflows = JSON.parse(await readFile(paths.workflows, "utf8"));
  const cast = workflows.workflows[0].cast[1];
  cast.status = "ready";
  cast.characterId = "new-synthetic";
  cast.selectedCandidateId = cast.candidates[1].id;
  cast.approval = { route: "anonymous-candidate-selection", approvedBy: "synthetic-reviewer", selectedCandidateId: cast.candidates[1].id, selectedCandidateLabel: "B", reason: "合成の理由" };
  await writeJson(paths.workflows, workflows);
  const registry = JSON.parse(await readFile(paths.registry, "utf8"));
  registry.characters.push({
    id: "new-synthetic",
    name: NEW_NAME,
    kind: "character",
    role: "per-video",
    status: "approved",
    episodeId: EPISODE_ID,
    referenceAssets: [{ id: "face", role: "identity-face", path: sheet.path, sha256: sheet.sha256 }],
  });
  await writeJson(paths.registry, registry);
  return { sheet };
}

/**
 * 画の工程の途中から音声の途中まで進んだ作業場。4枚のうち 3枚が合格・1枚が QA 不合格、
 * 3カットのうち 2カットで採用テイクが決まり、利用上限で止まっている。
 */
export async function writeMidProduction(workspace) {
  const paths = koyaPaths(workspace);
  const pages = [
    { cutId: "cut-01", utteranceId: "u-0001", assetJobId: "panel:u-0001" },
    { cutId: "cut-01", utteranceId: "u-0002", assetJobId: "panel:u-0001" },
    { cutId: "cut-02", utteranceId: "u-0003", assetJobId: "panel:u-0003" },
    { cutId: "cut-02", utteranceId: "u-0004", assetJobId: "split-page:u-0004" },
    { cutId: "cut-03", utteranceId: "u-0005", assetJobId: "panel:u-0005" },
  ];
  const images = {};
  const jobs = [];
  const ledgerJobs = {};
  for (const [index, assetJobId] of ["panel:u-0001", "panel:u-0003", "split-page:u-0004", "panel:u-0005"].entries()) {
    const file = join(paths.assetDir, `${assetJobId.replace(/[^a-z0-9-]+/gu, "-")}.png`);
    images[assetJobId] = await writeBytes(file, makeGradientPng(160, 90, 30 + index));
    jobs.push({ id: assetJobId, kind: assetJobId.startsWith("split") ? "split-page" : "panel", outputPath: file });
    ledgerJobs[assetJobId] = {
      id: assetJobId,
      status: index === 2 ? "failed" : "complete",
      outputPath: file,
      qa: index === 2
        ? { pass: false, issues: ["合成の指摘: 右の人物の手が欠けている"], technical: { pass: true }, semantic: { pass: false } }
        : { pass: true, issues: [], technical: { pass: true }, semantic: { pass: true } },
    };
  }
  await writeJson(paths.plan, {
    version: "synthetic-plan",
    episodeId: EPISODE_ID,
    pages: pages.map((page) => ({ ...page, outputPath: images[page.assetJobId].path })),
    jobs,
  });
  await writeJson(paths.ledger, {
    version: "synthetic-ledger",
    episodeId: EPISODE_ID,
    status: "failed",
    jobs: ledgerJobs,
    summary: { total: 4, complete: 3, failed: 1 },
  });
  await writeJson(paths.manifest, { id: EPISODE_ID, cuts: [{ id: "cut-01" }, { id: "cut-02" }, { id: "cut-03" }] });
  const takes = {};
  for (const [index, cutId] of ["cut-01", "cut-02"].entries()) {
    takes[cutId] = await writeBytes(join(paths.sourceDir, `${cutId}-take-2-synthetic-dialogue.wav`), makeWav(1 + index * 0.5, 180 + index * 40));
    await writeJson(join(paths.sourceDir, `${cutId}-voice-quality.json`), {
      cutId,
      selectedTakeIndex: 1,
      byTake: { 0: { hardFail: true, problems: ["合成の問題"], unavailable: [] }, 1: { hardFail: false, problems: [], unavailable: [] } },
    });
  }
  await writeJson(paths.speech, {
    version: "synthetic-speech",
    status: "waiting-usage-limit",
    cuts: [
      { cutId: "cut-02", status: "complete", selectedTakeIndex: 1, sourcePath: takes["cut-02"].path, voiceQualityGate: "applied" },
      { cutId: "cut-01", status: "complete", selectedTakeIndex: 1, sourcePath: takes["cut-01"].path, voiceQualityGate: "applied" },
    ],
  });
  await writeJson(paths.state, {
    version: "koya-production-state-v1",
    episodeId: EPISODE_ID,
    status: "waiting-usage-limit",
    currentStage: "speech",
    imagePlanPath: paths.plan,
    imageLedgerPath: paths.ledger,
  });
  return { paths, images, takes };
}

/** 合成の Job（本番の配置と同じく、作業場は <project>/canvas/harness-runs/<jobId>/workspace）。 */
export async function createKoyaProgressJob(projectDir, overrides = {}) {
  const runDir = join(projectDir, "canvas", "harness-runs", JOB_ID);
  const workspace = join(runDir, "workspace");
  await mkdir(workspace, { recursive: true });
  const scriptPath = join(runDir, "input", "script.txt");
  const script = "合成の台本。\n";
  await mkdir(join(runDir, "input"), { recursive: true });
  await writeFile(scriptPath, script);
  return {
    id: JOB_ID,
    revision: 5,
    status: "awaiting-human-review",
    projectDir,
    runDir,
    executionProjectDir: workspace,
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:10:00.000Z",
    harness: { id: "koya-manga-video", declarationVersion: "1", declarationSha256: "1".repeat(64), canonicalSkills: [] },
    channelPack: { id: "pack-synthetic", version: "1", sha256: "3".repeat(64) },
    script: { path: scriptPath, sha256: sha256(script) },
    options: { episodeId: EPISODE_ID, title: "合成の話" },
    stages: [
      { id: "doctor", status: "pass" },
      { id: "production", status: "awaiting-human-review" },
      { id: "audit", status: "pending" },
      { id: "canvas-projection", status: "pending" },
    ],
    adapterResult: { status: "awaiting-character-approval" },
    artifacts: [],
    knownRemainingIssues: ["character-approval"],
    ...overrides,
  };
}
