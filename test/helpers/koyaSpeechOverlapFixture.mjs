// 画と重ねる台詞の音声（lib/koyaMangaProduction.mjs の runKoyaOverlappedSpeech）の試験の合成の作業場。
// 人名・台本・声 id・会話 id はすべて合成。有料の呼び出しは偽の cut runner が代わりに受ける。
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeCharacterRegistry } from "../../lib/characterRegistry.mjs";
import { prepareKoyaDialogueCut } from "../../lib/koyaDialogueSpeech.mjs";
import { koyaEpisodePaths } from "../../lib/koyaMangaProduction.mjs";
import { createKoyaOuterJobBinding } from "../../lib/koyaOuterJobBinding.mjs";
import { approveVoiceLibraryCasting, createVoiceLibraryAuditionPlan } from "../../lib/voiceLibraryCasting.mjs";

export const EPISODE_ID = "manga-overlap-fixture-001";
export const JOB_ID = "video-koya-manga-video-0f0f0f0f0f0f0f0f";
export const OUTER_JOB_BINDING = createKoyaOuterJobBinding({
  jobId: JOB_ID,
  identityDigest: `0f0f0f0f0f0f0f0f${"0".repeat(48)}`,
  executionIdentityDigest: "b".repeat(64),
  resolvedProductionContractSha256: "c".repeat(64),
});
export const PROTAGONIST = "試験太郎";

export const SCRIPT = [
  "タイトル：試験の朝",
  "【カット1：開店】",
  "ナレーション：静かな朝。",
  "試験太郎：おはようございます。",
  "試験花子：資料は机の上です。",
  "【カット2：会議】",
  "試験花子：始めましょう。",
  "試験太郎：お願いします。",
].join("\n");

const PAGE_ROWS = [
  ["cut-01", "cut-01-u01", "narration"],
  ["cut-01", "cut-01-u02", "fixture-taro"],
  ["cut-01", "cut-01-u03", "fixture-hanako"],
  ["cut-02", "cut-02-u01", "fixture-hanako"],
  ["cut-02", "cut-02-u02", "fixture-taro"],
];

const FIXTURE_CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "channel-pack", "config");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function catalogVoice(id, gender, descriptive) {
  return {
    id,
    name: `${id} voice`,
    source: "account",
    available: true,
    language: "ja",
    gender,
    age: "young",
    descriptive,
    useCase: "conversational",
    category: "professional",
    previewUrl: `https://example.test/${id}.mp3`,
    description: `Native Japanese ${gender} voice, ${descriptive}.`,
    labels: { language: "ja", gender, age: "young", descriptive, use_case: "conversational" },
  };
}

const CATALOG = [
  catalogVoice("fixture-voice-m1", "male", "calm natural gentle"),
  catalogVoice("fixture-voice-m2", "male", "steady sincere conversational"),
  catalogVoice("fixture-voice-f1", "female", "gentle composed sincere"),
  catalogVoice("fixture-voice-f2", "female", "bright cheerful natural"),
];

function castMembers() {
  return [
    { id: "fixture-taro", name: "試験太郎", kind: "character", status: "approved", description: "30-year-old Japanese man. Calm and gentle." },
    { id: "fixture-hanako", name: "試験花子", kind: "character", status: "approved", description: "28-year-old Japanese woman. Composed and sincere." },
  ];
}

/** 人が匿名の試聴で選んだ声の記録（声の人選の関門を通る形）。 */
export async function humanSelectedRegistry() {
  const characters = castMembers();
  const plan = createVoiceLibraryAuditionPlan({
    episodeId: "global",
    characters,
    accountVoices: CATALOG,
    sharedVoices: [],
    includeNarration: false,
  });
  const approved = await approveVoiceLibraryCasting({
    plan,
    registry: { characters, voices: [] },
    persist: false,
    confirmedVoiceAdds: true,
    selections: plan.entries.map((entry) => ({
      characterId: entry.characterId,
      winnerLabel: entry.candidates[1].blindLabel,
      previewConfirmed: true,
      selectionReason: "落ち着いた話し方が台本の人物像に合う（合成）",
      approvedBy: "fixture-reviewer",
    })),
  });
  return normalizeCharacterRegistry(approved.registry);
}

function minimalPng(width, height) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  header[25] = 6;
  return header;
}

// 顔の検出の代わり。計画の各ページに、話者の顔を左上の小さな枠として返す（吹き出しの配置が話者の顔を守れるように）。
const FAKE_SOURCE_FACE_DETECTOR = [
  "import { mkdirSync, readFileSync, writeFileSync } from \"node:fs\";",
  "import { dirname } from \"node:path\";",
  "const arg = (name) => process.argv[process.argv.indexOf(name) + 1];",
  "const plan = JSON.parse(readFileSync(arg(\"--plan\"), \"utf8\"));",
  "const face = { x: 0.08, y: 0.12, width: 0.12, height: 0.2 };",
  "const rows = (plan.pages || []).map((page) => ({",
  "  utteranceId: page.utteranceId,",
  "  sourceFaceBoundsBySpeakerId: { [page.speakerId]: face },",
  "  sourceAvoidRegions: [{ ...face, id: `${page.speakerId}-face`, kind: \"face\", hardProtection: true }],",
  "}));",
  "mkdirSync(dirname(arg(\"--output\")), { recursive: true });",
  "writeFileSync(arg(\"--output\"), JSON.stringify({ pass: true, rows, knownRemainingIssues: [] }));",
].join("\n");

/**
 * 画像の計画と画（最小の PNG）がある作業場。prepare は偽の顔検出で本物の manifest の組み立てまで進む。
 * 返す plan は、画の工程の後で書き戻される形（production と台本を持つ）と同じ。
 */
export async function writeOverlapProject(registry, label = "koya-overlap") {
  const projectDir = await mkdtemp(join(tmpdir(), `${label}-`));
  const canvasDir = join(projectDir, "canvas");
  const assetDir = join(canvasDir, "assets", EPISODE_ID);
  await mkdir(assetDir, { recursive: true });
  // 1発話に1枚の画（話者の顔は偽の検出器が返す）。
  const pages = [];
  for (const [cutId, utteranceId, speakerId] of PAGE_ROWS) {
    const imagePath = join(assetDir, `${utteranceId}.png`);
    await writeFile(imagePath, minimalPng(1920, 1080));
    pages.push({ cutId, utteranceId, speakerId, outputPath: imagePath });
  }
  await writeFile(join(canvasDir, "characters.json"), `${JSON.stringify(registry, null, 2)}\n`);
  await cp(FIXTURE_CONFIG_DIR, join(projectDir, "config"), { recursive: true });
  const scriptPath = join(projectDir, "script.txt");
  await writeFile(scriptPath, `${SCRIPT}\n`);
  const paths = koyaEpisodePaths(projectDir, EPISODE_ID);
  const plan = {
    sourceScript: { path: scriptPath, text: SCRIPT },
    manifest: { title: "試験の朝" },
    pages,
    production: {
      generatorProvenance: { role: "generator", host: "claude", id: "fixture-generator", contextId: "fixture-generator-context" },
    },
  };
  await writeFile(paths.imagePlanPath, `${JSON.stringify(plan, null, 2)}\n`);
  const detectorPath = join(projectDir, "fake-source-face-detector.mjs");
  await writeFile(detectorPath, `${FAKE_SOURCE_FACE_DETECTOR}\n`);
  return {
    projectDir,
    canvasDir,
    scriptPath,
    paths,
    plan,
    pythonRuntime: { command: process.execPath, args: [detectorPath], ok: true },
  };
}

/** 外側の Job の前検査の結果（doctor が測った台詞の adapter と Job の束縛）。 */
export function overlapPreflight(adapter) {
  return {
    jobId: JOB_ID,
    identityDigest: `0f0f0f0f0f0f0f0f${"0".repeat(48)}`,
    executionIdentityDigest: "b".repeat(64),
    resolvedProductionContractSha256: "c".repeat(64),
    jobProjectDir: "",
    doctor: { ttsAdapter: { provider: adapter.provider, model: adapter.model, adapterVersion: adapter.adapterVersion } },
  };
}

/**
 * 有料の cut の代わり。音はその cut の入力（読みと声）だけで決まる合成のバイト列で、直列と重ねた回で
 * 同じ入力なら同じ音になる。failCutIds に入れた cut は失敗する。
 */
export function fakeCutRunner({ failCutIds = new Set(), delayMs = 0 } = {}) {
  const calls = [];
  const runner = async ({ cut, workerManifest, directories }) => {
    calls.push(cut.id);
    if (delayMs > 0) await new Promise((done) => { setTimeout(done, delayMs); });
    if (failCutIds.has(cut.id)) throw new Error(`fixture provider failed ${cut.id}`);
    const plan = prepareKoyaDialogueCut(workerManifest, cut, { takeCount: 2 });
    const byId = new Map(workerManifest.utterances.map((entry) => [entry.id, entry]));
    await mkdir(directories.audioDir, { recursive: true });
    const sourcePath = join(directories.sourceDir, `${cut.id}-take-1-fixture-dialogue.wav`);
    await mkdir(directories.sourceDir, { recursive: true });
    await writeFile(sourcePath, Buffer.from(`take:${plan.inputs.map((input) => input.providerText).join("|")}`));
    for (const input of plan.inputs) {
      const filePath = join(directories.audioDir, `${workerManifest.id}-${input.utteranceId}-koya-v44.wav`);
      const bytes = Buffer.from(`fixture-audio:${input.voiceId}:${input.providerText}`);
      await writeFile(filePath, bytes);
      Object.assign(byId.get(input.utteranceId), {
        speechText: input.speechText,
        performancePrompt: input.performancePrompt,
        model: plan.model,
        audio: {
          pipeline: "koya-dialogue-v44",
          utteranceId: input.utteranceId,
          displayText: input.displayText,
          speechText: input.speechText,
          providerText: input.providerText,
          performancePrompt: input.performancePrompt,
          voiceId: input.voiceId,
          model: plan.model,
          sha256: sha256(bytes),
          selectedTakeIndex: 0,
          sourceDialoguePath: sourcePath,
          filePath,
        },
      });
    }
    return {
      manifest: workerManifest,
      reportRow: { cutId: cut.id, status: "complete", selectedTakeIndex: 0, sourcePath, utteranceCount: plan.inputs.length, voiceQualityGate: "applied" },
      mediaJobs: [],
    };
  };
  return { runner, calls };
}

/** 再開のときと同じ役の判定（承認済みの音が今の計画の入力と一致するか）を、合成の音の形で行う。 */
export async function fixtureApprovedCheckpoint(plan) {
  const ok = plan.utterances.every((utterance, index) => {
    const input = plan.inputs[index];
    const audio = utterance.audio;
    return audio
      && audio.pipeline === "koya-dialogue-v44"
      && audio.speechText === input.speechText
      && audio.providerText === input.providerText
      && audio.voiceId === input.voiceId
      && audio.model === plan.model;
  });
  return ok ? { selectedTakeIndex: 0, sourcePath: plan.utterances[0].audio.sourceDialoguePath } : null;
}
