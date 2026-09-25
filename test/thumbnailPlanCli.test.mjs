// ジャンル共通のサムネの CLI（scripts/thumbnail-plan.mjs）が、漫画とナレーション物語の両方で動くこと。
// 漫画は今の koya-manga-video.mjs thumbnail-* と同じ出力になること。人の名前・文言・画・Job・鍵はすべて合成の値。
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createChannelPackEnvelope } from "../lib/channelPackEnvelope.mjs";
import { renderEditorialPlatePng } from "../lib/mangaScriptImagePipeline.mjs";
import { THUMBNAIL_DEFAULT_FINAL_CHECKS, thumbnailArtworkQualitySubjectId, thumbnailCompositeQualitySubjectId, thumbnailCopySha256 } from "../lib/thumbnailPlan.mjs";
import { koyaThumbnailCopySha256 } from "../lib/koyaChannelGovernance.mjs";
import { parseThumbnailPlanArgs, runThumbnailPlanCli } from "../scripts/thumbnail-plan.mjs";
import { passKoyaAssetQualityLoop } from "./helpers/koyaAssetQualityFixture.mjs";
import { installSyntheticKoyaAuthority } from "./helpers/koyaLocationFixture.mjs";

const execFile = promisify(execFileCallback);
const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(root, "scripts", "thumbnail-plan.mjs");
const koyaCli = path.join(root, "scripts", "koya-manga-video.mjs");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const NARRATED = "narrated-story-video";
const LETTERING = Object.freeze({ typeface: "合成の筆書体", strokeContrast: "太細の差を強く", tracking: "詰め気味", color: "墨色に朱の差し色", carrier: "木の看板" });

/** 開発機の BUZZASSIST_* に引っ張られない子プロセスの環境。 */
function cleanEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BUZZASSIST_")));
  return { ...env, ...extra };
}

async function run(script, args, { cwd, env = cleanEnv() } = {}) {
  try {
    const { stdout, stderr } = await execFile(process.execPath, [script, ...args], { cwd, env, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout || "", stderr: error.stderr || "" };
  }
}

async function tempDir(t, prefix) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeJob(projectDir, { id, harnessId, episodeId = "", status = "completed", videoSha256 = "", channelPackPath = "" }) {
  const file = path.join(projectDir, "canvas", "harness-runs", id, "job.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({
    id,
    status,
    harness: { id: harnessId },
    options: episodeId ? { episodeId } : {},
    channelPack: channelPackPath ? { path: channelPackPath, kind: "directory" } : null,
    artifacts: videoSha256 ? [{ kind: "final-video", path: "final.mp4", sha256: videoSha256 }] : [],
  }));
}

function narratedConfig(thumbnail) {
  return {
    version: "fixture-v1",
    runtime: { imageModel: "image-model-v1", ttsProvider: "fish-audio" },
    image: { provider: "buzzassist", model: "image-model-v1", adapterVersion: "image-adapter-v1", stylePrompt: "soft light" },
    voice: { provider: "fish-audio", model: "s2-pro", adapterVersion: "fish-audio-tts-server-v1", voiceId: "public-voice-id", speed: 1 },
    music: { provider: "buzzassist", model: "music-v1", adapterVersion: "music-adapter-v1", prompt: "quiet", gain: 0.04 },
    render: { width: 1280, height: 720, fps: 24 },
    concurrency: 4,
    bookends: { enabled: false },
    ...(thumbnail ? { thumbnail } : {}),
  };
}

function thumbnailSection(approvedSha) {
  return {
    status: "synthetic-approved",
    rules: { brandTokens: { bandColor: "synthetic-band-v1" } },
    layouts: { single: { panels: 1, default: true }, pair: { panels: 2, reasonRequired: true } },
    text: {
      band: { lines: 2, maxCharactersPerLine: 12 },
      speechBubble: { lines: 2, maxCharactersPerLine: 8, maximumPerPanel: 1 },
      forbiddenTerms: [{ text: "synthetic-brand", kind: "brand" }],
      approval: "when-text",
    },
    approvedReferences: { sha256: [approvedSha] },
  };
}

test("引数: 知らない引数・値の無い引数は誤りにし、既定値で本処理を走らせない", async () => {
  assert.deepEqual(parseThumbnailPlanArgs(["audit", "--harness", NARRATED, "--plan-path", "a.json", "--plan-path", "b.json"]).planPath, ["a.json", "b.json"]);
  assert.throws(() => parseThumbnailPlanArgs(["audit", "--harnes", NARRATED]), /知らない引数: --harnes/u);
  assert.throws(() => parseThumbnailPlanArgs(["audit", "--harness"]), /--harness に値が要る/u);
  const lines = [];
  const stdout = { write: (text) => lines.push(text) };
  assert.equal((await runThumbnailPlanCli({ argv: ["--help"], stdout })).exitCode, 0, "--help は使い方だけ");
  assert.equal((await runThumbnailPlanCli({ argv: [], stdout })).exitCode, 1, "アクションが無ければ使い方と誤り");
  assert.equal((await runThumbnailPlanCli({ argv: ["audit", "--help"], stdout })).exitCode, 0);
  assert.equal((await runThumbnailPlanCli({ argv: ["audit", "--harness", "other-harness"], stdout })).exitCode, 1);
  assert.match(lines.join(""), /usage:/u);
});

test("漫画: 共通の CLI の draft と audit は、koya-manga-video.mjs thumbnail-* と同じ出力・終了コードになる", async (t) => {
  const projectDir = await tempDir(t, "thumbnail-cli-koya-");
  await installSyntheticKoyaAuthority(projectDir);
  for (const layout of [[], ["--layout", "threePanel"]]) {
    const legacy = await run(koyaCli, ["thumbnail-plan-draft", "--project-dir", projectDir, ...layout], { cwd: projectDir });
    const common = await run(cli, ["draft", "--harness", "koya-manga-video", "--project-dir", projectDir, ...layout], { cwd: projectDir });
    assert.equal(legacy.code, 0, legacy.stderr);
    assert.equal(common.code, 0, common.stderr);
    assert.equal(common.stdout, legacy.stdout);
  }
  const plan = {
    version: "koya-thumbnail-plan-v1",
    stage: "preflight",
    layout: "twoPanel",
    bandLines: ["合成の見出し", "二行目の合成"],
    speechBubbles: [{ panelId: "left", lines: ["合成台詞"] }],
    telops: [{ text: "合成語", concreteNounReviewPassed: true }],
    exactTextApproved: true,
  };
  plan.textApproval = { approvedBy: "synthetic-approver", approvedAt: "2026-09-25T00:00:00.000Z", copySha256: koyaThumbnailCopySha256(plan) };
  const planPath = path.join(projectDir, "canvas", "thumbnail-plan.json");
  await writeFile(planPath, JSON.stringify(plan));
  const legacy = await run(koyaCli, ["thumbnail-audit", "--project-dir", projectDir, "--thumbnail-plan-path", planPath], { cwd: projectDir });
  const common = await run(cli, ["audit", "--harness", "koya-manga-video", "--project-dir", projectDir, "--plan-path", planPath], { cwd: projectDir });
  assert.equal(common.code, legacy.code);
  assert.equal(common.code, 2, "合成の契約はブランドの語が未承認なので落ちる");
  assert.equal(common.stdout, legacy.stdout);
  assert.match(common.stdout, /Thumbnail brand tokens are pending/u);

  // draft --job-id: Job の id・回の id を結び付けに入れる。別ハーネスの Job は拒否する。
  const jobId = "video-koya-manga-video-00000000000000a1";
  await writeJob(projectDir, { id: jobId, harnessId: "koya-manga-video", episodeId: "manga-synthetic-001", status: "running" });
  const bound = await run(cli, ["draft", "--harness", "koya-manga-video", "--project-dir", projectDir, "--job-id", jobId], { cwd: projectDir });
  assert.equal(bound.code, 0, bound.stderr);
  assert.deepEqual(JSON.parse(bound.stdout).jobBinding, { jobId, episodeId: "manga-synthetic-001", videoSha256: "" });
  const narratedJob = "video-narrated-story-video-00000000000000a2";
  await writeJob(projectDir, { id: narratedJob, harnessId: NARRATED });
  const refused = await run(cli, ["draft", "--harness", "koya-manga-video", "--project-dir", projectDir, "--job-id", narratedJob], { cwd: projectDir });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /narrated-story-video の Job/u);
  const packRefused = await run(cli, ["draft", "--harness", "koya-manga-video", "--project-dir", projectDir, "--channel-pack", projectDir], { cwd: projectDir });
  assert.equal(packRefused.code, 1);
  assert.match(packRefused.stderr, /thumbnail contract から読む/u);
});

test("ナレーション物語: 署名済み Pack の thumbnail 節で draft・audit が動き、品質ループ未合格の final は落ち、合格すれば通る", async (t) => {
  const base = await tempDir(t, "thumbnail-cli-narrated-");
  const projectDir = path.join(base, "project");
  const workDir = path.join(projectDir, "canvas");
  const thumbs = path.join(workDir, "thumbs");
  await mkdir(thumbs, { recursive: true });
  const reference = path.join(workDir, "refs", "sheet-a.png");
  await mkdir(path.dirname(reference), { recursive: true });
  await writeFile(reference, renderEditorialPlatePng("pastel-sky", 64, 64));
  const approvedSha = sha(await readFile(reference));
  const source = path.join(base, "pack-source");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "narrated-story.json"), JSON.stringify(narratedConfig(thumbnailSection(approvedSha))));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const bundle = path.join(base, "signed-pack");
  await createChannelPackEnvelope({
    sourceDir: source, outputDir: bundle, id: "synthetic-channel", version: "1.0.0", harnessId: NARRATED,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  });
  const env = { BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY_PEM: publicKey.export({ type: "spki", format: "pem" }) };
  const lines = [];
  const stdout = { write: (text) => lines.push(text) };
  const cliRun = async (argv, extraEnv = env) => {
    lines.length = 0;
    const outcome = await runThumbnailPlanCli({ argv: [...argv, "--project-dir", projectDir], stdout, env: extraEnv, cwd: base });
    return { ...outcome, output: JSON.parse(lines.join("")) };
  };

  const draft = await cliRun(["draft", "--harness", NARRATED, "--channel-pack", bundle, "--layout", "pair"]);
  assert.equal(draft.exitCode, 0);
  assert.equal(draft.output.version, "buzzassist-thumbnail-plan-v1");
  assert.equal(draft.output.harnessId, NARRATED);
  assert.equal(draft.output.layoutReason, "");
  assert.deepEqual(Object.keys(draft.output.lettering), ["band", "speechBubble"]);
  await assert.rejects(() => runThumbnailPlanCli({ argv: ["draft", "--harness", NARRATED, "--channel-pack", bundle, "--project-dir", projectDir], stdout, env: {}, cwd: base }), /公開鍵が未設定/u);

  const artwork = path.join(thumbs, "idea-a-v1.png");
  const composite = path.join(thumbs, "composite-a-v1.png");
  const frame = path.join(thumbs, "frame.png");
  await writeFile(artwork, renderEditorialPlatePng("black-solid", 1280, 720));
  await writeFile(composite, renderEditorialPlatePng("white-solid", 1280, 720));
  await writeFile(frame, renderEditorialPlatePng("pastel-sky", 1280, 720));
  const jobId = "video-narrated-story-video-00000000000000b1";
  const videoSha256 = "f".repeat(64);
  await writeJob(projectDir, { id: jobId, harnessId: NARRATED, episodeId: "ep-12", videoSha256, channelPackPath: bundle });
  const plan = {
    ...draft.output,
    layout: "single",
    idea: { setId: "synthetic-set", id: "a", scene: "合成の店先", composition: "寄りの二人", beat: "発覚の瞬間", payload: ["人物A", "封筒"] },
    bandLines: ["合成の見出し", "二行目"],
    lettering: { band: { ...LETTERING } },
    charactersVisible: true,
    characterReferences: [{ characterId: "synthetic-a", sha256: approvedSha }],
  };
  delete plan.layoutReason;
  Object.assign(plan, { exactTextApproved: true, textApproval: { approvedBy: "synthetic-approver", approvedAt: "2026-09-25T00:00:00.000Z", copySha256: thumbnailCopySha256(plan) } });
  const planPath = path.join(projectDir, "canvas", "plan-a.json");
  await writeFile(planPath, JSON.stringify(plan));
  const preflight = await cliRun(["audit", "--harness", NARRATED, "--channel-pack", bundle, "--plan-path", planPath]);
  assert.equal(preflight.exitCode, 0, preflight.output.failures?.join("\n"));
  assert.equal(preflight.output.readyForGeneration, true);
  assert.equal(preflight.output.rulesProvenance.kind, "signed-channel-pack");
  assert.equal(preflight.output.rulesProvenance.packId, "synthetic-channel");

  const compositeSha = sha(await readFile(composite));
  const finalPlan = {
    ...plan,
    stage: "final",
    artworkPaths: [artwork],
    mainVideoFramePaths: [frame],
    compositePath: path.relative(projectDir, composite),
    checks: { ...Object.fromEntries(THUMBNAIL_DEFAULT_FINAL_CHECKS.map((key) => [key, true])), compositeSha256: compositeSha },
    jobBinding: { jobId, episodeId: "ep-12", videoSha256 },
  };
  const finalPath = path.join(projectDir, "canvas", "plan-a-final.json");
  await writeFile(finalPath, JSON.stringify(finalPlan));
  // --job-id だけでも、その Job の Pack から決まりを読む。
  const unpassed = await cliRun(["audit", "--harness", NARRATED, "--job-id", jobId, "--plan-path", finalPath]);
  assert.equal(unpassed.exitCode, 2);
  assert.equal(unpassed.output.rulesProvenance.via, "job-channel-pack");
  const artworkSubject = thumbnailArtworkQualitySubjectId(finalPlan, 0, artwork);
  const compositeSubject = thumbnailCompositeQualitySubjectId(finalPlan, composite);
  assert.deepEqual(unpassed.output.failures.map((line) => line.split("（")[0]), [
    `asset-quality-required:thumbnail:${artworkSubject}:loop-not-started`,
    `asset-quality-required:thumbnail:${compositeSubject}:loop-not-started`,
  ]);
  assert.equal(unpassed.output.jobBinding.verified, true);

  await passKoyaAssetQualityLoop({ harnessId: NARRATED, workDir, stage: "thumbnail", subjectId: artworkSubject, assetPath: artwork, references: [reference] });
  await passKoyaAssetQualityLoop({ harnessId: NARRATED, workDir, stage: "thumbnail", subjectId: compositeSubject, assetPath: composite, references: [reference] });
  const passed = await cliRun(["audit", "--harness", NARRATED, "--channel-pack", bundle, "--plan-path", finalPath]);
  assert.equal(passed.exitCode, 0, passed.output.failures?.join("\n"));
  assert.equal(passed.output.readyForPublish, true);
  assert.deepEqual(passed.output.assetQuality.map((row) => row.pass), [true, true]);

  // 署名の無い設定ファイルの決まりでは公開できない。
  const unsigned = await cliRun(["audit", "--harness", NARRATED, "--channel-config", path.join(source, "narrated-story.json"), "--plan-path", finalPath]);
  assert.equal(unsigned.exitCode, 2);
  assert.ok(unsigned.output.failures.some((line) => line.startsWith("thumbnail-rules-unsigned")));

  // 2案を渡すと、案どうしの検査も見る（同じ軸の2案は別アイデアとして読めない）。
  const twinPath = path.join(projectDir, "canvas", "plan-b.json");
  const twin = { ...plan, idea: { ...plan.idea, id: "b" } };
  await writeFile(twinPath, JSON.stringify(twin));
  const set = await cliRun(["audit", "--harness", NARRATED, "--channel-pack", bundle, "--plan-path", planPath, "--plan-path", twinPath]);
  assert.equal(set.exitCode, 2);
  assert.equal(set.output.version, "buzzassist-thumbnail-plan-cli-v1");
  assert.deepEqual(set.output.plans.map((entry) => entry.result.pass), [true, true]);
  assert.ok(set.output.ideaSet.failures.some((line) => line.startsWith("thumbnail-ideas-not-distinct:a:b:")));
  await writeFile(twinPath, JSON.stringify({ ...twin, idea: { ...twin.idea, scene: "合成の駅前" } }));
  const distinct = await cliRun(["audit", "--harness", NARRATED, "--channel-pack", bundle, "--plan-path", planPath, "--plan-path", twinPath]);
  assert.equal(distinct.exitCode, 0, JSON.stringify(distinct.output.ideaSet.failures));

  // 実際の入口（子プロセス）でも同じ結果になる。
  const child = await run(cli, ["audit", "--harness", NARRATED, "--channel-pack", bundle, "--project-dir", projectDir, "--plan-path", finalPath], {
    cwd: base,
    env: cleanEnv({ BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY_PEM: env.BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY_PEM }),
  });
  assert.equal(child.code, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).readyForPublish, true);
  const noSection = path.join(base, "no-section.json");
  await writeFile(noSection, JSON.stringify(narratedConfig(null)));
  const missing = await run(cli, ["draft", "--harness", NARRATED, "--channel-config", noSection, "--project-dir", projectDir], { cwd: base });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no thumbnail section/u);
});
