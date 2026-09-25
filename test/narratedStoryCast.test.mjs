// 役ごとの声（lib/narratedStoryCast.mjs）の試験。役名・声 ID・権利根拠はすべて合成。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { extractNarratedChannelPackRuntime } from "../lib/harnessChannelPackRuntime.mjs";
import {
  auditNarratedVoiceCasting,
  createNarratedRoleResolver,
  narratedVoiceAdapters,
  normalizeNarratedCastConfig,
} from "../lib/narratedStoryCast.mjs";
import { inspectNarratedStoryPlan, planNarratedStoryScript } from "../lib/narratedStoryPipeline.mjs";
import { NARRATED_SCRIPT_PACKAGE_FORMAT, planNarratedStoryInput } from "../lib/narratedStoryScriptPackage.mjs";
import { acceptScriptForTests } from "./helpers/scriptQualityAcceptance.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const NARRATOR_VOICE = { provider: "fixture-voice", model: "fixture-voice-v1", adapterVersion: "fixture-voice-adapter-v1", voiceId: "voice-narrator", speed: 1 };
const role = (voiceId, extra = {}) => ({
  provider: "fixture-voice", model: "fixture-voice-v1", adapterVersion: "fixture-voice-adapter-v1", voiceId, rightsBasis: "operator-owned", ...extra,
});
const CAST = {
  acceptedRightsBases: ["operator-owned", "licensed"],
  roles: {
    "young-woman": role("voice-young-woman"),
    "old-man": role("voice-old-man", { provider: "fixture-voice-alt", model: "fixture-alt-v2", adapterVersion: "fixture-alt-adapter-v1", speed: 0.9 }),
    "small-child": { status: "blocked", blockReason: "権利根拠が未確認", voiceId: "voice-small-child" },
  },
};

test("配役の読み込み: 役ごとの声・blocked の理由・権利根拠を検査し、欠けは有料生成の前に止める材料にする", () => {
  const ok = normalizeNarratedCastConfig(CAST, { narratorVoice: NARRATOR_VOICE });
  assert.deepEqual(ok.blockers, []);
  assert.equal(ok.config.enabled, true);
  assert.equal(ok.config.roles["old-man"].voice.speed, 0.9);
  assert.equal(ok.config.roles["small-child"].status, "blocked");
  const blockersOf = (cast) => normalizeNarratedCastConfig(cast, { narratorVoice: NARRATOR_VOICE }).blockers;
  assert.ok(blockersOf({ roles: { narrator: role("voice-x") } }).includes("cast.roles.narrator-reserved-use-voice"), "語りの声は voice だけ");
  assert.ok(blockersOf({ roles: { a: role("voice-a", { rightsBasis: "" }) } }).includes("cast.roles.a.rightsBasis"));
  assert.ok(blockersOf({ acceptedRightsBases: ["licensed"], roles: { a: role("voice-a") } }).includes("cast.roles.a.rightsBasis-not-accepted"));
  assert.ok(blockersOf({ roles: { a: { status: "blocked" } } }).includes("cast.roles.a.blockReason"));
  assert.ok(blockersOf({ roles: { a: role("voice-a", { voiceId: "" }) } }).includes("cast.roles.a.voiceId"));
  assert.ok(blockersOf({ roles: { a: role("voice-a", { apiKey: "x" }) } }).includes("cast.roles.a.apiKey-forbidden"));
  assert.ok(blockersOf({ roles: { a: role("voice-a", { nickname: "x" }) } }).includes("cast.roles.a.nickname-unknown"));
  assert.ok(blockersOf({ roles: {}, undeclaredRoles: "anyone" }).includes("cast.undeclaredRoles"));
  // 使えない声が、語りや使える役の名前で流れていないか。
  assert.ok(blockersOf({ roles: { a: { status: "blocked", blockReason: "未確認", voiceId: "voice-narrator" } } }).includes("cast.roles.a.blocked-voice-routed"));
  assert.ok(blockersOf({ roles: { a: role("voice-shared"), b: { status: "blocked", blockReason: "未確認", voiceId: "voice-shared" } } })
    .includes("cast.roles.b.blocked-voice-routed"));
  assert.deepEqual(normalizeNarratedCastConfig(undefined).config.enabled, false);
});

test("振り分け: blocked は止める・宣言の無い役は既定で止める・明示したときだけ語りの声で読む", () => {
  const config = { voice: NARRATOR_VOICE, cast: normalizeNarratedCastConfig(CAST, { narratorVoice: NARRATOR_VOICE }).config };
  const resolve = createNarratedRoleResolver(config);
  assert.deepEqual(resolve("narrator"), { ok: true, role: "narrator", voice: null, routedBy: "narrator" });
  assert.equal(resolve("young-woman").voice.voiceId, "voice-young-woman");
  assert.equal(resolve("young-woman").routedBy, "cast-role");
  assert.deepEqual(resolve("small-child"), { ok: false, issue: "cast-role-blocked:small-child" });
  assert.deepEqual(resolve("stranger"), { ok: false, issue: "cast-role-undeclared:stranger" });
  const fallback = createNarratedRoleResolver({ ...config, cast: { ...config.cast, undeclaredRoles: "narrator" } });
  assert.deepEqual(fallback("stranger"), { ok: true, role: "narrator", voice: null, routedBy: "fallback-narrator" });
  assert.deepEqual(fallback("small-child"), { ok: false, issue: "cast-role-blocked:small-child" }, "blocked は明示の既定でも語りへ落とさない");
});

const castConfig = () => ({
  bookends: { enabled: false },
  scriptIntake: { markdown: null },
  voice: NARRATOR_VOICE,
  cast: normalizeNarratedCastConfig(CAST, { narratorVoice: NARRATOR_VOICE }).config,
});
const castPackage = (story) => ({
  format: NARRATED_SCRIPT_PACKAGE_FORMAT,
  speakers: [
    { id: "c-aoi", castRole: "young-woman" },
    { id: "c-gen", castRole: "old-man" },
    { id: "c-kid", castRole: "small-child" },
  ],
  story,
});
const planPackage = (pkg, config = castConfig()) => planNarratedStoryInput({
  script: JSON.stringify(pkg), scriptPath: "script.json", config, planRawScript: planNarratedStoryScript,
});

test("引用台詞は語りと話者に分け、話者の台詞は役の声、地の文は語りの声で読む", () => {
  const result = planPackage(castPackage([
    { id: "s01", text: "「おかえり」と娘は笑った。父は黙って頷いた。", speaker: "c-aoi" },
    { id: "s02", text: "「わしの店だ」", speaker: "c-gen" },
    { id: "s03", text: "子どもの頃の話は、ここまでにしよう。" },
  ]));
  assert.deepEqual(result.issues, []);
  const rows = result.storySegments.map((segment) => [segment.id, segment.delivery, segment.castRole, segment.voice?.voiceId || "(narrator)"]);
  assert.deepEqual(rows, [
    ["s01.t1", "dialogue", "young-woman", "voice-young-woman"],
    ["s01.t2", "narration", "narrator", "(narrator)"],
    ["s01.t3", "narration", "narrator", "(narrator)"],
    ["s02", "dialogue", "old-man", "voice-old-man"],
    ["s03", "narration", "narrator", "(narrator)"],
  ]);
  assert.equal(result.storySegments[0].text, "「おかえり」");
  assert.equal(result.storySegments[1].text, "と娘は笑った。");
  // 役の声の adapter も有料生成の前に probe する。
  const adapters = narratedVoiceAdapters(castConfig(), result.storySegments);
  assert.deepEqual(adapters.map((adapter) => adapter.provider).sort(), ["fixture-voice", "fixture-voice-alt"]);
});

test("blocked の役に台詞があれば有料生成の前に止める。宣言しただけで台詞が無ければ止めない", () => {
  const blocked = planPackage(castPackage([
    { id: "s01", text: "「ぼくもいく」と少年は言った。", speaker: "c-kid" },
  ]));
  assert.equal(blocked.stage, "cast-routing");
  assert.deepEqual(blocked.issues, ["cast-role-blocked:small-child"]);
  const unused = planPackage(castPackage([{ id: "s01", text: "少年は黙っていた。" }]));
  assert.deepEqual(unused.issues, []);
});

test("声の配役の照合: 受領記録の声が宣言と違う・blocked の声が使われたら落とす", () => {
  const config = castConfig();
  const plan = planPackage(castPackage([
    { id: "s01", text: "「おかえり」", speaker: "c-aoi" },
    { id: "s02", text: "静かな朝だった。" },
  ]), config);
  const receiptFor = (voice) => ({ provider: voice.provider, model: voice.model, adapterVersion: voice.adapterVersion, voiceId: voice.voiceId });
  const good = new Map(plan.storySegments.map((segment) => [segment.id, receiptFor(segment.voice || NARRATOR_VOICE)]));
  const pass = auditNarratedVoiceCasting({ segments: plan.storySegments, voiceReceipts: good, config });
  assert.equal(pass.pass, true, pass.detail);
  assert.deepEqual(pass.byRole, { "young-woman": 1, narrator: 1 });
  const swapped = new Map(good);
  swapped.set("s01", receiptFor(NARRATOR_VOICE));
  const wrong = auditNarratedVoiceCasting({ segments: plan.storySegments, voiceReceipts: swapped, config });
  assert.equal(wrong.pass, false);
  assert.ok(wrong.problems.includes("s01:voiceId-mismatch"));
  const leaked = new Map(good);
  leaked.set("s02", { ...receiptFor(NARRATOR_VOICE), voiceId: "voice-small-child" });
  assert.ok(auditNarratedVoiceCasting({ segments: plan.storySegments, voiceReceipts: leaked, config }).problems.includes("s02:blocked-voice-used"));
  assert.equal(auditNarratedVoiceCasting({ segments: [], voiceReceipts: new Map(), config }).pass, false, "照合する物が無いのは pass ではない");
});

async function writePack(dir, extra = {}) {
  await mkdir(dir, { recursive: true });
  const config = {
    version: "fixture-pack-v1",
    runtime: { imageModel: "fixture-image-v1", ttsProvider: "fixture-voice" },
    image: { provider: "fixture-image", model: "fixture-image-v1", adapterVersion: "fixture-image-adapter-v1", stylePrompt: "flat fixture" },
    voice: NARRATOR_VOICE,
    music: { provider: "fixture-music", model: "fixture-music-v1", adapterVersion: "fixture-music-adapter-v1", prompt: "quiet", gain: 0.03 },
    render: { width: 320, height: 180, fps: 12 },
    bookends: { enabled: false },
    cast: CAST,
    ...extra,
  };
  const bytes = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(join(dir, "narrated-story.json"), bytes, "utf8");
  return { payloadSha256: sha256(bytes) };
}

test("durable Job へ持ち込む Pack の形: cast を受け、役の未知の項目は拒否する。preflight は blocked の役を示す", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "narrated-cast-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ok = await writePack(join(root, "ok"));
  await extractNarratedChannelPackRuntime({ payloadDir: join(root, "ok"), evidence: { harnessId: "narrated-story-video", payloadSha256: ok.payloadSha256 } });
  const bad = await writePack(join(root, "bad"), { cast: { roles: { a: { ...role("voice-a"), mood: "calm" } } } });
  await assert.rejects(
    extractNarratedChannelPackRuntime({ payloadDir: join(root, "bad"), evidence: { harnessId: "narrated-story-video", payloadSha256: bad.payloadSha256 } }),
    /cast\.roles\.a contains unsupported fields: mood/u,
  );
  const scriptPath = join(root, "script.json");
  await writeFile(scriptPath, JSON.stringify(castPackage([{ id: "s01", text: "「ぼくもいく」", speaker: "c-kid" }])), "utf8");
  // 台本の関門（監査契約 v8 から）はこの試験の対象外。台本を人がそのまま使うと認めた記録を置く。
  await acceptScriptForTests(scriptPath);
  const inspected = await inspectNarratedStoryPlan({ scriptPath, channelPackDir: join(root, "ok") });
  assert.deepEqual(inspected.blockers, ["cast-role-blocked:small-child"]);
  const brokenCast = await writePack(join(root, "broken"), { cast: { roles: { a: { status: "blocked", blockReason: "未確認", voiceId: "voice-narrator" } } } });
  assert.ok(brokenCast.payloadSha256);
  const inspectedBroken = await inspectNarratedStoryPlan({ scriptPath, channelPackDir: join(root, "broken") });
  assert.ok(inspectedBroken.blockers.includes("channel-pack-config-required:cast.roles.a.blocked-voice-routed"));
});

test("公式経路: 役の声で台詞を作り、blocked の役があれば1円も使わずに止まる", async (t) => {
  const { resolveFfmpegToolchain } = await import("../lib/harnessRuntimeResolver.mjs");
  const toolchain = await resolveFfmpegToolchain();
  if (!toolchain.ok) {
    t.skip("ffmpeg/ffprobe is unavailable");
    return;
  }
  const { runNarratedStoryPipeline, narratedStoryRunPaths } = await import("../lib/narratedStoryPipeline.mjs");
  const { bookendFixtureAdapters, createBookendFixtureMedia, passingVoiceQualityGate } = await import("./fixtures/narratedBookendFixture.mjs");
  const { runPastAssetLoops } = await import("./fixtures/narratedAssetLoopFixture.mjs");
  const root = await mkdtemp(join(tmpdir(), "narrated-cast-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pack = join(root, "pack");
  await writePack(pack);
  const fixture = await createBookendFixtureMedia(join(root, "media"), toolchain);
  const run = async (story, jobId) => {
    const scriptPath = join(root, jobId, "script.json");
    await mkdir(dirname(scriptPath), { recursive: true });
    await writeFile(scriptPath, JSON.stringify(castPackage(story)), "utf8");
    // 台本の関門（監査契約 v8 から）はこの試験の対象外。台本を人がそのまま使うと認めた記録を置く。
    await acceptScriptForTests(scriptPath);
    const adapters = bookendFixtureAdapters(fixture);
    const specs = [];
    const probes = [];
    // 途中の成果物の品質ループ（本編の画・声のテイク）で止まったら、本物のループで合格させて再開する。
    const outcome = await runPastAssetLoops(() => runNarratedStoryPipeline({
      scriptPath,
      channelPackDir: pack,
      jobId,
      deploymentRoot: root,
      mediaJobRunner: async (spec) => { specs.push(spec); return adapters.mediaJobRunner(spec); },
      mediaJobProbe: async (adapter) => { probes.push(adapter); return adapters.mediaJobProbe(adapter); },
      ffmpegToolchain: toolchain,
      voiceQualityGate: passingVoiceQualityGate,
      jobIdentityDigest: "e".repeat(64),
      env: {},
    }));
    return { outcome, specs, probes, runDir: narratedStoryRunPaths({ deploymentRoot: root, jobId }).runDir };
  };
  const blocked = await run([{ id: "s01", text: "「ぼくもいく」", speaker: "c-kid" }], "video-narrated-story-video-00000000000000b1");
  assert.equal(blocked.outcome.status, "awaiting-operator-input");
  assert.deepEqual(blocked.outcome.knownRemainingIssues, ["cast-role-blocked:small-child"]);
  assert.equal(blocked.specs.length, 0, "有料生成へ進んでいない");
  assert.equal(blocked.probes.length, 0);

  const ok = await run([
    { id: "s01", text: "「おかえり」と娘は笑った。", speaker: "c-aoi" },
    { id: "s02", text: "「わしの店だ」", speaker: "c-gen" },
  ], "video-narrated-story-video-00000000000000b2");
  assert.equal(ok.outcome.status, "awaiting-human-review", ok.outcome.knownRemainingIssues.join(", "));
  const voices = ok.specs.filter((spec) => spec.kind === "voice.synthesis");
  assert.deepEqual(voices.map((spec) => spec.voiceId).sort(), ["voice-narrator", "voice-old-man", "voice-young-woman"]);
  assert.equal(voices.find((spec) => spec.voiceId === "voice-old-man").provider, "fixture-voice-alt");
  assert.equal(voices.find((spec) => spec.voiceId === "voice-old-man").input.speed, 0.9);
  assert.ok(ok.probes.some((probe) => probe.kind === "voice.synthesis" && probe.provider === "fixture-voice-alt"), "役の声の adapter も probe");
  const manifest = JSON.parse(await readFile(join(ok.runDir, "generation-manifest.json"), "utf8"));
  assert.equal(manifest.voiceCasting.pass, true, manifest.voiceCasting.problems.join(", "));
  assert.deepEqual(manifest.voiceCasting.byRole, { "young-woman": 1, narrator: 1, "old-man": 1 });
  assert.equal(manifest.channelConfig.cast.roles["small-child"].status, "blocked");
  assert.equal(JSON.stringify(manifest.channelConfig.cast).includes("権利根拠が未確認"), false, "理由の文は残さない");
  assert.equal(manifest.segments.find((segment) => segment.id === "s02").castRole, "old-man");
});
