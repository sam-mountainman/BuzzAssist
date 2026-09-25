// BGM の区分割り当て（lib/narratedStoryMusicPlan.mjs）の試験。区分名・曲・プロンプトはすべて合成。
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { extractNarratedChannelPackRuntime } from "../lib/harnessChannelPackRuntime.mjs";
import { resolveFfmpegToolchain } from "../lib/harnessRuntimeResolver.mjs";
import {
  narratedMusicBedWindow,
  normalizeNarratedMusicPlanConfig,
  planNarratedMusicBlocks,
} from "../lib/narratedStoryMusicPlan.mjs";
import {
  inspectNarratedStoryPlan,
  narratedStoryRunPaths,
  runNarratedStoryPipeline,
} from "../lib/narratedStoryPipeline.mjs";
import { NARRATED_SCRIPT_PACKAGE_FORMAT } from "../lib/narratedStoryScriptPackage.mjs";
import { bookendFixtureAdapters, createBookendFixtureMedia, passingVoiceQualityGate } from "./fixtures/narratedBookendFixture.mjs";
import { runPastAssetLoops } from "./fixtures/narratedAssetLoopFixture.mjs";
import { acceptScriptForTests } from "./helpers/scriptQualityAcceptance.mjs";

const execFile = promisify(execFileCallback);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const toolchain = await resolveFfmpegToolchain();

const PLAN = {
  defaultSection: "calm",
  crossfadeSeconds: 0.2,
  sections: [
    { id: "cold-open", position: "first", maxBlocks: 1, source: { kind: "operator-file", file: "music/cold-open.wav" } },
    { id: "peak", maxBlocks: 1, source: { kind: "generate", prompt: "synthetic rising strings" } },
    { id: "calm", source: { kind: "operator-file", file: "music/calm.wav" }, gain: 0.8 },
    { id: "closing", position: "last", source: { kind: "pending", note: "not delivered yet" } },
    { id: "unused-extra", source: { kind: "operator-file", file: "music/not-here.wav" } },
  ],
};

async function ff(args) {
  return execFile(toolchain.ffmpeg.command, [...(toolchain.ffmpeg.args || []), "-hide_banner", "-loglevel", "error", "-y", ...args], { timeout: 60_000 });
}

async function writeTone(path, frequency, seconds = 3) {
  await mkdir(dirname(path), { recursive: true });
  await ff(["-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=${seconds}:sample_rate=48000`, "-af", "volume=0.3", "-ac", "2", "-c:a", "pcm_s16le", path]);
}

test("区分の読み込み: 形の誤りは止める。運営者の曲は Pack の中だけ、実在は使う区分でだけ問う", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "narrated-music-normalize-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "music"), { recursive: true });
  await writeFile(join(root, "music", "cold-open.wav"), "RIFFfixture");
  await writeFile(join(root, "music", "calm.wav"), "RIFFfixture");
  const ok = await normalizeNarratedMusicPlanConfig(PLAN, { channelPackDir: root });
  assert.deepEqual(ok.blockers, [], "使わないかもしれない区分の曲が無いことは読み込みでは止めない");
  const byId = Object.fromEntries(ok.config.sections.map((section) => [section.id, section]));
  assert.equal(byId["cold-open"].track.available, true);
  assert.equal(byId["unused-extra"].track.available, false);
  assert.equal(byId.calm.gain, 0.8);
  const blockersOf = async (plan) => (await normalizeNarratedMusicPlanConfig(plan, { channelPackDir: root })).blockers;
  assert.ok((await blockersOf({ sections: [{ id: "a", source: { kind: "operator-file", file: "../outside.wav" } }] })).includes("musicPlan.sections.a.source.file"));
  assert.ok((await blockersOf({ sections: [{ id: "a", source: { kind: "generate" } }] })).includes("musicPlan.sections.a.source.prompt"));
  assert.ok((await blockersOf({ sections: [{ id: "a", source: { kind: "stream" } }] })).includes("musicPlan.sections.a.source.kind"));
  assert.ok((await blockersOf({ sections: [{ id: "a", position: "middle", source: { kind: "pending" } }] })).includes("musicPlan.sections.a.position"));
  assert.ok((await blockersOf({ sections: [{ id: "a", source: { kind: "pending" } }, { id: "a", source: { kind: "pending" } }] })).includes("musicPlan.sections.a-duplicated"));
  assert.ok((await blockersOf({ defaultSection: "ghost", sections: [{ id: "a", source: { kind: "pending" } }] })).includes("musicPlan.defaultSection"));
  assert.ok((await blockersOf({ sections: [] })).includes("musicPlan.sections"));
  assert.ok((await blockersOf({ sections: [{ id: "a", source: { kind: "pending" } }], tempo: 120 })).includes("musicPlan.tempo-unknown"));
});

test("区分の割り当て: 置き方の規則（最初だけ・最後だけ・ブロック数）と、使う区分の曲の未受領で止める", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "narrated-music-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "music"), { recursive: true });
  await writeFile(join(root, "music", "cold-open.wav"), "RIFFfixture");
  await writeFile(join(root, "music", "calm.wav"), "RIFFfixture");
  const { config } = await normalizeNarratedMusicPlanConfig(PLAN, { channelPackDir: root });
  const segs = (...sections) => sections.map((musicSection, index) => ({ id: `s${index + 1}`, ...(musicSection ? { musicSection } : {}) }));
  const good = planNarratedMusicBlocks(segs("cold-open", "", "peak", "peak", ""), config);
  assert.deepEqual(good.issues, []);
  assert.deepEqual(good.blocks.map((block) => [block.sectionId, block.segmentIds]), [
    ["cold-open", ["s1"]], ["calm", ["s2"]], ["peak", ["s3", "s4"]], ["calm", ["s5"]],
  ]);
  assert.deepEqual(planNarratedMusicBlocks(segs("calm", "cold-open"), config).issues, ["music-section-placement:cold-open:first"]);
  assert.deepEqual(planNarratedMusicBlocks(segs("peak", "calm", "peak"), config).issues, ["music-section-placement:peak:max-blocks-1"]);
  assert.deepEqual(planNarratedMusicBlocks(segs("calm", "closing", "calm"), config).issues.sort(), [
    "music-section-pending:closing", "music-section-placement:closing:last",
  ]);
  assert.deepEqual(planNarratedMusicBlocks(segs("calm", "closing"), config).issues, ["music-section-pending:closing"], "未受領の曲を使うなら止める");
  assert.deepEqual(planNarratedMusicBlocks(segs("unused-extra"), config).issues, ["music-section-file-missing:unused-extra"]);
  assert.deepEqual(planNarratedMusicBlocks(segs("ghost"), config).issues, ["music-section-undeclared:ghost"]);
  const noDefault = { ...config, defaultSection: "" };
  assert.deepEqual(planNarratedMusicBlocks(segs(""), noDefault).issues, ["music-section-required"]);
  const required = { ...config, sections: config.sections.map((section) => (section.id === "peak" ? { ...section, required: true } : section)) };
  assert.deepEqual(planNarratedMusicBlocks(segs("calm"), required).issues, ["music-section-required-unused:peak"]);
});

test("本編の曲の起点: bookends の番組では OP→本編の転換の始まりから", () => {
  assert.deepEqual(narratedMusicBedWindow(null, 12.5), { bedStartSeconds: 0, lengthSeconds: 12.5 });
  const window = narratedMusicBedWindow({ sampleRate: 48_000, totalSeconds: 20, boundaries: [{ id: "openingToStory", effectStartSample: 72_000 }] }, 0);
  assert.deepEqual(window, { bedStartSeconds: 1.5, lengthSeconds: 18.5 });
});

async function writePack(dir, extra = {}) {
  await mkdir(dir, { recursive: true });
  await writeTone(join(dir, "music", "cold-open.wav"), 220);
  await writeTone(join(dir, "music", "calm.wav"), 440);
  const config = {
    version: "fixture-pack-v1",
    runtime: { imageModel: "fixture-image-v1", ttsProvider: "fixture-voice" },
    image: { provider: "fixture-image", model: "fixture-image-v1", adapterVersion: "fixture-image-adapter-v1", stylePrompt: "flat fixture" },
    voice: { provider: "fixture-voice", model: "fixture-voice-v1", adapterVersion: "fixture-voice-adapter-v1", voiceId: "fixture-narrator", speed: 1 },
    music: { provider: "fixture-music", model: "fixture-music-v1", adapterVersion: "fixture-music-adapter-v1", prompt: "unused single bed", gain: 0.03 },
    render: { width: 320, height: 180, fps: 12 },
    bookends: { enabled: false },
    musicPlan: PLAN,
    ...extra,
  };
  const bytes = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(join(dir, "narrated-story.json"), bytes, "utf8");
  return { payloadSha256: sha256(bytes) };
}

const packagedScript = (story) => JSON.stringify({ format: NARRATED_SCRIPT_PACKAGE_FORMAT, story });

test("durable Job へ持ち込む Pack の形: musicPlan を受け、区分の未知の項目は拒否する。preflight は未受領の区分を示す", async (t) => {
  if (!toolchain.ok) { t.skip("ffmpeg/ffprobe is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "narrated-music-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ok = await writePack(join(root, "ok"));
  await extractNarratedChannelPackRuntime({ payloadDir: join(root, "ok"), evidence: { harnessId: "narrated-story-video", payloadSha256: ok.payloadSha256 } });
  const bad = await writePack(join(root, "bad"), { musicPlan: { sections: [{ id: "a", source: { kind: "pending" }, mood: "sad" }] } });
  await assert.rejects(
    extractNarratedChannelPackRuntime({ payloadDir: join(root, "bad"), evidence: { harnessId: "narrated-story-video", payloadSha256: bad.payloadSha256 } }),
    /musicPlan\.sections\[0\] contains unsupported fields: mood/u,
  );
  const scriptPath = join(root, "script.json");
  await writeFile(scriptPath, packagedScript([
    { id: "s01", text: "静かな朝だった。" },
    { id: "s02", text: "物語はここで終わる。", musicSection: "closing" },
  ]), "utf8");
  // 台本の関門（監査契約 v8 から）はこの試験の対象外。台本を人がそのまま使うと認めた記録を置く。
  await acceptScriptForTests(scriptPath);
  const inspected = await inspectNarratedStoryPlan({ scriptPath, channelPackDir: join(root, "ok") });
  assert.deepEqual(inspected.blockers, ["music-section-pending:closing"]);
  assert.equal(inspected.paidCallsAttempted, false);
});

async function bandDb(path, startSeconds, endSeconds, frequency) {
  const { stderr } = await execFile(toolchain.ffmpeg.command, [
    ...(toolchain.ffmpeg.args || []), "-hide_banner", "-nostats", "-i", path,
    "-af", `atrim=start=${startSeconds}:end=${endSeconds},asetpts=PTS-STARTPTS,bandpass=f=${frequency}:width_type=h:w=40,volumedetect`,
    "-f", "null", "-",
  ], { timeout: 60_000 });
  const match = /mean_volume:\s*(-?[\d.]+|-inf)\s*dB/u.exec(String(stderr));
  return match ? Number(match[1]) : -Infinity;
}

test("公式経路: 区分ごとに運営者の曲と生成した曲を当ててつなぎ、未受領の区分があれば1円も使わずに止まる", async (t) => {
  if (!toolchain.ok) { t.skip("ffmpeg/ffprobe is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "narrated-music-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pack = join(root, "pack");
  await writePack(pack);
  const fixture = await createBookendFixtureMedia(join(root, "media"), toolchain);
  const run = async (story, jobId) => {
    const scriptPath = join(root, jobId, "script.json");
    await mkdir(dirname(scriptPath), { recursive: true });
    await writeFile(scriptPath, packagedScript(story), "utf8");
    // 台本の関門（監査契約 v8 から）はこの試験の対象外。台本を人がそのまま使うと認めた記録を置く。
    await acceptScriptForTests(scriptPath);
    const adapters = bookendFixtureAdapters(fixture);
    const specs = [];
    // 途中の成果物の品質ループ（本編の画・声のテイク）で止まったら、本物のループで合格させて再開する。
    const outcome = await runPastAssetLoops(() => runNarratedStoryPipeline({
      scriptPath,
      channelPackDir: pack,
      jobId,
      deploymentRoot: root,
      mediaJobRunner: async (spec) => { specs.push(spec); return adapters.mediaJobRunner(spec); },
      mediaJobProbe: adapters.mediaJobProbe,
      ffmpegToolchain: toolchain,
      voiceQualityGate: passingVoiceQualityGate,
      jobIdentityDigest: "f".repeat(64),
      env: {},
    }));
    return { outcome, specs, runDir: narratedStoryRunPaths({ deploymentRoot: root, jobId }).runDir };
  };
  const pending = await run([
    { id: "s01", text: "静かな朝だった。" },
    { id: "s02", text: "物語はここで終わる。", musicSection: "closing" },
  ], "video-narrated-story-video-00000000000000c1");
  assert.equal(pending.outcome.status, "awaiting-operator-input");
  assert.deepEqual(pending.outcome.knownRemainingIssues, ["music-section-pending:closing"]);
  assert.equal(pending.specs.length, 0);

  const ok = await run([
    { id: "s01", text: "雨の朝だった。", musicSection: "cold-open" },
    { id: "s02", text: "店は静かだった。" },
    { id: "s03", text: "そして奇跡が起きた。", musicSection: "peak" },
  ], "video-narrated-story-video-00000000000000c2");
  assert.equal(ok.outcome.status, "awaiting-human-review", ok.outcome.knownRemainingIssues.join(", "));
  const musicSpecs = ok.specs.filter((spec) => spec.kind === "music.generation");
  assert.equal(musicSpecs.length, 1, "生成は peak の区分だけ（運営者の曲は生成しない）");
  assert.equal(musicSpecs[0].input.section, "peak");
  assert.equal(musicSpecs[0].input.prompt, "synthetic rising strings");
  assert.ok(ok.outcome.mediaJobs.some((job) => job.kind === "music.generation"));
  const manifest = JSON.parse(await readFile(join(ok.runDir, "generation-manifest.json"), "utf8"));
  const blocks = manifest.channelConfig.musicPlan.blocks;
  assert.deepEqual(blocks.map((block) => [block.sectionId, block.source]), [["cold-open", "operator-file"], ["calm", "operator-file"], ["peak", "generate"]]);
  assert.equal(blocks[0].trackSha256, sha256(await readFile(join(pack, "music", "cold-open.wav"))));
  assert.equal(ok.outcome.auditChecks.noWholeProgramAcrossfade.pass, true, "区分のつなぎに acrossfade を使わない");
  const bed = join(ok.runDir, "media", "music", "story-bed.wav");
  const mid = (block) => [block.startSeconds + 0.15, Math.max(block.startSeconds + 0.3, block.endSeconds - 0.15)];
  const [a0, a1] = mid(blocks[0]);
  const [c0, c1] = mid(blocks[1]);
  assert.ok(await bandDb(bed, a0, a1, 220) > await bandDb(bed, a0, a1, 440) + 10, "最初の区分は運営者の最初の曲");
  assert.ok(await bandDb(bed, c0, c1, 440) > await bandDb(bed, c0, c1, 220) + 10, "2つ目の区分は既定の区分の曲");
});
