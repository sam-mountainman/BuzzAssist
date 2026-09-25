// 声のテイク（voice-take）: 採用するテイクは品質ループの合格が要る（契約 v54 から）。未合格のカットは
// 撮り直さずに止まり、合格した版と違うテイクでは通らず、古い契約では従来どおり採用する。
// 取得済みのテイクだけを使い、有料の呼び出しはしない。回・カット・声 id はすべて合成の値。
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { koyaVoiceTakeAssetQualitySubjectId } from "../lib/koyaAssetQualityGatePolicy.mjs";
import {
  buildKoyaDialogueRequest,
  generateKoyaDialogueSpeech,
  prepareKoyaDialogueCut,
} from "../lib/koyaDialogueSpeech.mjs";
import { resolveKoyaDialogueAdapter } from "../lib/koyaMangaProductionContract.mjs";
import { currentKoyaContract, legacyKoyaContract, passKoyaAssetQualityLoop } from "./helpers/koyaAssetQualityFixture.mjs";

const execFile = promisify(execFileCallback);
const root = fileURLToPath(new URL("..", import.meta.url));
const sha = (value) => createHash("sha256").update(value).digest("hex");

async function tempRoot(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function voiceProject(t, prefix, frequencies = [440, 660]) {
  const projectDir = await tempRoot(t, prefix);
  const canvasDir = join(projectDir, "canvas");
  const episodeDir = join(canvasDir, "manga-videos", "synthetic-ep");
  const sourceDir = join(episodeDir, ".koya-dialogue-source");
  await mkdir(sourceDir, { recursive: true });
  const manifest = {
    id: "synthetic-ep",
    utterances: [{ id: "cut-01-u01", text: "こんにちは。", speakerId: "speaker-a", voiceId: "voice-a" }],
    cuts: [{ id: "cut-01", utteranceIds: ["cut-01-u01"] }],
    production: {},
  };
  const manifestPath = join(episodeDir, "episode-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const contract = await currentKoyaContract(root);
  const cutPlan = prepareKoyaDialogueCut({ ...manifest, speech: { pronunciations: [] } }, manifest.cuts[0], {
    takeCount: 2,
    dialogueAdapter: resolveKoyaDialogueAdapter(contract),
  });
  // 取得済みのテイク（有料の呼び出しは起きない）。0.3秒の無音＋1秒の音＋0.3秒の無音。
  const takes = [];
  for (const [takeIndex, frequency] of frequencies.entries()) {
    const body = buildKoyaDialogueRequest(cutPlan, takeIndex, null);
    const inputHash = sha(JSON.stringify(body));
    const sourcePath = join(sourceDir, `cut-01-take-${takeIndex + 1}-${inputHash.slice(0, 12)}-eleven-v3-dialogue.wav`);
    await execFile("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=1`,
      "-af", "adelay=300:all=1,apad=pad_dur=0.3,volume=0.5", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", sourcePath,
    ]);
    const bytes = await readFile(sourcePath);
    await writeFile(`${sourcePath}.json`, JSON.stringify({
      version: 1,
      pipeline: "koya-dialogue-v44",
      cutId: "cut-01",
      takeIndex,
      inputHash,
      model: "eleven_v3",
      languageCode: "ja",
      requestId: `synthetic-request-${takeIndex + 1}`,
      mediaJobReceipt: {
        version: "synthetic",
        status: "completed",
        kind: "voice.dialogue",
        provider: "elevenlabs",
        model: "eleven_v3",
        adapterVersion: "elevenlabs-dialogue-server-v1",
        jobId: `synthetic-job-${takeIndex + 1}`,
        requestKey: `synthetic-request-key-${takeIndex + 1}`,
        inputHash,
        artifact: { sha256: sha(bytes), mimeType: "audio/wav", bytes: bytes.length },
      },
      sourcePath,
      sourceDurationSeconds: 1.6,
      inputs: cutPlan.inputs,
      providerInputs: cutPlan.providerInputs || cutPlan.inputs,
      voiceSegments: [{ dialogue_input_index: 0, start_time_seconds: 0.3, end_time_seconds: 1.3 }],
      alignment: null,
    }));
    takes.push(sourcePath);
  }
  return { projectDir, canvasDir, manifestPath, contract, takes };
}

function speak(project, contract = project.contract) {
  return generateKoyaDialogueSpeech({
    projectDir: project.projectDir,
    canvasDir: project.canvasDir,
    manifestPath: project.manifestPath,
    contract,
    voiceQualityGate: false,
    speechConcurrency: 1,
    fetchImpl: async () => { throw new Error("no paid call is expected in this test"); },
  });
}

test("声のテイク: 採用するテイクは voice-take 工程のループ合格が要り、未合格のカットは撮り直さずに止まる", async (t) => {
  const project = await voiceProject(t, "koya-voice-gate-");
  const subjectId = koyaVoiceTakeAssetQualitySubjectId("synthetic-ep", "cut-01");

  const held = await speak(project);
  assert.equal(held.awaitingAssetQuality, true);
  assert.equal(held.report.status, "awaiting-human-review");
  assert.equal(held.assetQualityAwaiting.length, 1);
  const row = held.assetQualityAwaiting[0];
  assert.equal(row.code, `asset-quality-required:voice-take:${subjectId}:loop-not-started`);
  assert.ok(project.takes.includes(row.takePath));
  const savedHeld = JSON.parse(await readFile(project.manifestPath, "utf8"));
  assert.equal(savedHeld.utterances[0].audio, undefined, "未合格のテイクは台帳へ書かない");
  assert.equal(savedHeld.status, "speech-awaiting-review");

  // 採用されないほうのテイクで合格しても、採用するテイクの合格にはならない。
  const otherTake = project.takes.find((path) => path !== row.takePath);
  await passKoyaAssetQualityLoop({ workDir: project.canvasDir, stage: "voice-take", subjectId, assetPath: otherTake });
  const mismatch = await speak(project);
  assert.equal(mismatch.assetQualityAwaiting[0].reason, "asset-sha-mismatch");

  // 採用するテイクで合格させ直すと通り、同じテイクが台帳へ書かれる（撮り直しは無い）。
  const restartProject = await voiceProject(t, "koya-voice-gate-pass-");
  const heldAgain = await speak(restartProject);
  await passKoyaAssetQualityLoop({ workDir: restartProject.canvasDir, stage: "voice-take", subjectId, assetPath: heldAgain.assetQualityAwaiting[0].takePath });
  const passed = await speak(restartProject);
  assert.equal(passed.awaitingAssetQuality, undefined);
  assert.equal(passed.report.status, "complete");
  const saved = JSON.parse(await readFile(restartProject.manifestPath, "utf8"));
  assert.equal(saved.utterances[0].audio.sourceDialoguePath, heldAgain.assetQualityAwaiting[0].takePath);

  // 古い契約（v53）: ループを見ずに従来どおり採用する。
  const legacyProject = await voiceProject(t, "koya-voice-legacy-");
  const legacy = await speak(legacyProject, await legacyKoyaContract(root));
  assert.equal(legacy.report.status, "complete");
});
