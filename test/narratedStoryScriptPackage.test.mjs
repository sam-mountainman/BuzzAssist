// 台本の受け口（lib/narratedStoryScriptPackage.mjs）の試験。台本・役・声・区切り行はすべて合成。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { extractNarratedChannelPackRuntime } from "../lib/harnessChannelPackRuntime.mjs";
import {
  inspectNarratedStoryPlan,
  planNarratedStoryScript,
} from "../lib/narratedStoryPipeline.mjs";
import {
  NARRATED_SCRIPT_PACKAGE_FIELDS,
  NARRATED_SCRIPT_PACKAGE_FORMAT,
  extractMarkdownSections,
  narratedSegmentManifestFields,
  planNarratedStoryInput,
  splitSpeakerTurns,
  validateNarratedScriptPackage,
} from "../lib/narratedStoryScriptPackage.mjs";
import { acceptScriptForTests } from "./helpers/scriptQualityAcceptance.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const MARKER = "===ふりかえり===";

const baseConfig = (overrides = {}) => ({
  bookends: { enabled: false },
  scriptIntake: { markdown: null },
  ...overrides,
});
const reviewConfig = (overrides = {}) => baseConfig({
  bookends: { enabled: true, review: { scriptMarker: MARKER, presenter: null } },
  ...overrides,
});
const plan = (pkg, config = baseConfig(), options = {}) => planNarratedStoryInput({
  script: JSON.stringify(pkg),
  scriptPath: "/work/input/script.json",
  config,
  planRawScript: planNarratedStoryScript,
  ...options,
});

const samplePackage = (overrides = {}) => ({
  format: NARRATED_SCRIPT_PACKAGE_FORMAT,
  title: "合成の企画",
  sourceMarkdown: { sha256: "c".repeat(64), bytes: 120 },
  story: [
    { id: "s01", text: "雨の朝、店の戸を開けずに待った。", sceneIntent: "雨の商店街、引きの画", musicSection: "calm" },
    { id: "s02", text: "看板には『本日休業』とある。それでも客は来た。", sceneIntent: "店先の看板に寄る" },
  ],
  readings: [{ segmentId: "s01", display: "開けずに", spoken: "ひらけずに" }],
  ...overrides,
});

test("スキーマと検査器の項目が一致する（片方だけ増やさない）", async () => {
  const schema = JSON.parse(await readFile(join(REPO_ROOT, "config", "narrated-story-script-package.schema.json"), "utf8"));
  assert.equal(schema.properties.format.const, NARRATED_SCRIPT_PACKAGE_FORMAT);
  assert.deepEqual(Object.keys(schema.properties).sort(), [...NARRATED_SCRIPT_PACKAGE_FIELDS.top].sort());
  assert.deepEqual(Object.keys(schema.properties.sourceMarkdown.properties).sort(), [...NARRATED_SCRIPT_PACKAGE_FIELDS.sourceMarkdown].sort());
  assert.deepEqual(Object.keys(schema.properties.speakers.items.properties).sort(), [...NARRATED_SCRIPT_PACKAGE_FIELDS.speaker].sort());
  assert.deepEqual(Object.keys(schema.$defs.storySegment.properties).sort(), [...NARRATED_SCRIPT_PACKAGE_FIELDS.storySegment].sort());
  assert.deepEqual(Object.keys(schema.$defs.reviewSegment.properties).sort(), [...NARRATED_SCRIPT_PACKAGE_FIELDS.reviewSegment].sort());
  assert.deepEqual(Object.keys(schema.properties.readings.items.properties).sort(), [...NARRATED_SCRIPT_PACKAGE_FIELDS.reading].sort());
  for (const section of [schema, schema.properties.sourceMarkdown, schema.properties.speakers.items, schema.$defs.storySegment, schema.$defs.reviewSegment, schema.properties.readings.items]) {
    assert.equal(section.additionalProperties, false, "未知の項目は拒否する（黙って捨てない）");
  }
});

test("台本パッケージ: 字幕は表記、声は読み。場面ごとに画1枚、文ごとに声と字幕", () => {
  const result = plan(samplePackage());
  assert.deepEqual(result.issues, []);
  assert.equal(result.input.format, NARRATED_SCRIPT_PACKAGE_FORMAT);
  assert.deepEqual(result.input.sourceMarkdown, { sha256: "c".repeat(64), bytes: 120 });
  const [first, second, third] = result.storySegments;
  assert.equal(result.storySegments.length, 3, "s02 は2文なので2つ");
  assert.equal(first.id, "s01");
  assert.equal(first.text, "雨の朝、店の戸を開けずに待った。", "字幕は表記のまま");
  assert.equal(first.spokenText, "雨の朝、店の戸をひらけずに待った。", "声には読みを渡す");
  assert.equal(first.spokenTextHash, sha256(first.spokenText));
  assert.equal(first.textHash, sha256(first.text));
  assert.equal(first.musicSection, "calm");
  assert.equal(first.imageKey, "s01");
  assert.match(first.imagePrompt, /雨の商店街/u);
  assert.equal(second.id, "s02.t1");
  assert.equal(third.id, "s02.t2");
  assert.equal(second.imageKey, "s02");
  assert.equal(third.imageKey, "s02", "同じ場面の文は同じ画");
  assert.equal(second.spokenText, undefined, "読みの指定が無い文は表記のまま読む");
  assert.deepEqual(result.storySegments.map((segment) => segment.order), [0, 1, 2]);
  assert.ok(result.storySegments.every((segment) => segment.castRole === "narrator" && segment.delivery === "narration"));
  // 生成記録には文を残さない（id・役・読みの有無と SHA だけ）。
  const manifest = narratedSegmentManifestFields(first);
  assert.deepEqual(manifest.reading, { spokenTextHash: sha256(first.spokenText), readingsApplied: 1 });
  assert.equal(JSON.stringify(manifest).includes("ひらけずに"), false);
  assert.equal(JSON.stringify(manifest).includes("開けずに"), false);
});

test("台本パッケージ: 見出しを本文に入れない・読みは本文に実在する表記だけ・未知の項目は拒否", () => {
  const invalid = (pkg) => validateNarratedScriptPackage(pkg).problems;
  assert.ok(invalid(samplePackage({ story: [{ id: "s01", text: "# タイトル案" }] })).includes("script-package-invalid:story[0].text-heading-mark"));
  assert.ok(invalid(samplePackage({ readings: [{ segmentId: "s01", display: "閉めずに", spoken: "しめずに" }] }))
    .includes("script-package-invalid:readings[0].display-not-in-segment"));
  assert.ok(invalid(samplePackage({ readings: [{ segmentId: "s09", display: "開けずに", spoken: "ひらけずに" }] }))
    .includes("script-package-invalid:readings[0].segmentId-unknown"));
  assert.ok(invalid(samplePackage({ extraNote: "運営者向けの注記" })).includes("script-package-invalid:extraNote-unknown"));
  assert.ok(invalid(samplePackage({ story: [{ id: "s01", text: "一行目。\n二行目。" }] })).includes("script-package-invalid:story[0].text-line-break"));
  assert.ok(invalid(samplePackage({ story: [{ id: "s01", text: "本文。" }, { id: "s01", text: "重複。" }] })).includes("script-package-invalid:story[1].id-duplicated"));
  assert.ok(invalid(samplePackage({ speakers: [{ id: "narrator", castRole: "other" }] })).includes("script-package-invalid:speakers[0].id-duplicated"));
  assert.ok(invalid(samplePackage({ story: [{ id: "s01", text: "本文。", speaker: "ghost" }] })).includes("script-package-invalid:story[0].speaker-undeclared"));
  assert.deepEqual(invalid({ ...samplePackage(), format: "other-format-v9" }), ["script-package-format-unsupported:other-format-v9"]);
  const broken = planNarratedStoryInput({ script: "{ not json", scriptPath: "script.json", config: baseConfig(), planRawScript: planNarratedStoryScript });
  assert.deepEqual(broken.issues, ["script-package-invalid:json"]);
  assert.equal(broken.stage, "script-package");
});

test("台本パッケージ: 登場人物の台詞は配役が無ければ有料生成の前に止める（黙って語りの声へ落とさない）", () => {
  const pkg = samplePackage({
    speakers: [{ id: "c-shop", castRole: "shopkeeper" }],
    story: [{ id: "s01", text: "「いらっしゃい」と店主は笑った。", speaker: "c-shop" }],
    readings: [],
  });
  const result = plan(pkg);
  assert.deepEqual(result.issues, ["cast-role-undeclared:shopkeeper"]);
  assert.equal(result.stage, "cast-routing");
  assert.deepEqual(result.storySegments, []);
});

test("話者の区切り: 「」の中は話者、外は地の文。『』は台詞にしない。話者が語り手なら全文が地の文", () => {
  assert.deepEqual(splitSpeakerTurns("「ありがとう」と彼は言った。", { dialogue: true }), [
    { kind: "dialogue", text: "「ありがとう」" },
    { kind: "narration", text: "と彼は言った。" },
  ]);
  assert.deepEqual(splitSpeakerTurns("彼は『閉店』の札を見た。「まだ開いてる」", { dialogue: true }), [
    { kind: "narration", text: "彼は『閉店』の札を見た。" },
    { kind: "dialogue", text: "「まだ開いてる」" },
  ]);
  assert.deepEqual(splitSpeakerTurns("最後までご覧いただきありがとうございました。", { dialogue: true }), [
    { kind: "dialogue", text: "最後までご覧いただきありがとうございました。" },
  ]);
  assert.deepEqual(splitSpeakerTurns("「ありがとう」と彼は言った。"), [{ kind: "narration", text: "「ありがとう」と彼は言った。" }]);
});

test("台本パッケージ: 本編と感想の区切りは Channel Pack の宣言と突き合わせる", () => {
  const withReview = samplePackage({
    reviewMarker: MARKER,
    review: [
      { id: "r01", text: "心に残ったのは雨の場面です。" },
      { id: "r02", text: "実は私も同じ経験があります。", operatorReplacementRequired: true },
    ],
  });
  // Pack が感想を宣言していないのに感想がある。
  assert.deepEqual(plan(withReview).issues, [
    "script-structure-required:script-package-review-marker-mismatch",
    "script-structure-required:script-review-not-declared-by-channel-pack",
  ]);
  assert.deepEqual(plan({ ...withReview, reviewMarker: undefined }).issues, ["script-structure-required:script-review-not-declared-by-channel-pack"]);
  // 区切りの文言が Pack と違う（別チャンネル向けの台本）。
  assert.deepEqual(plan({ ...withReview, reviewMarker: "---別の区切り---" }, reviewConfig()).issues, [
    "script-structure-required:script-package-review-marker-mismatch",
  ]);
  // Pack が感想を宣言しているのに感想が無い。
  assert.deepEqual(plan(samplePackage(), reviewConfig()).issues, ["script-structure-required:script-review-section-empty"]);
  // 差し替え必須の文は声にも字幕にもせず止める。
  const pending = plan(withReview, reviewConfig());
  assert.equal(pending.stage, "operator-replacement");
  assert.deepEqual(pending.issues, ["operator-replacement-required:r02"]);
  const replaced = plan({ ...withReview, review: [withReview.review[0], { id: "r02", text: "私も若い頃に店を手伝いました。" }] }, reviewConfig());
  assert.deepEqual(replaced.issues, []);
  assert.deepEqual(replaced.reviewSegments.map((segment) => [segment.id, segment.part, segment.order]), [["r01", "review", 3], ["r02", "review", 4]]);
});

test("Markdown: 見出し・注記は声にしない。どの見出しが本編かは Pack の宣言だけで決め、推測しない", () => {
  const markdown = [
    "# 合成の企画",
    "",
    "## タイトル案",
    "",
    "雨の日の奇跡",
    "",
    "想定尺: 約10分",
    "",
    "## 本編",
    "",
    "「待っていたよ」",
    "",
    "<!-- 運営者向けの注記 -->",
    "> 注記: ここは後で直す",
    "雨の朝、店の戸を開けた。",
    "### 場面2",
    "客がひとり入ってきた。",
    "",
    "## 振り返り",
    "",
    "心に残ったのは最初の一言です。",
  ].join("\n");
  const undeclared = planNarratedStoryInput({ script: markdown, scriptPath: "script.md", config: baseConfig(), planRawScript: planNarratedStoryScript });
  assert.deepEqual(undeclared.issues, ["script-markdown-structure-undeclared"]);
  const sections = extractMarkdownSections(markdown, { storyHeading: "本編", reviewHeading: "振り返り" });
  assert.deepEqual(sections.story, ["「待っていたよ」", "雨の朝、店の戸を開けた。", "客がひとり入ってきた。"]);
  assert.deepEqual(sections.review, ["心に残ったのは最初の一言です。"]);
  const declared = planNarratedStoryInput({
    script: markdown,
    scriptPath: "script.md",
    config: reviewConfig({ scriptIntake: { markdown: { storyHeading: "本編", reviewHeading: "振り返り" } } }),
    planRawScript: planNarratedStoryScript,
  });
  assert.deepEqual(declared.issues, []);
  assert.equal(declared.input.format, "markdown");
  const spoken = [...declared.storySegments, ...declared.reviewSegments].map((segment) => segment.text).join("|");
  for (const heading of ["タイトル案", "想定尺", "雨の日の奇跡", "注記", "場面2", "#"]) {
    assert.equal(spoken.includes(heading), false, `${heading} が声になっている`);
  }
  assert.equal(declared.reviewSegments.length, 1);
  // 感想を宣言した Pack で、感想の見出しを宣言していない・見つからない。
  const noReviewHeading = planNarratedStoryInput({
    script: markdown, scriptPath: "script.md", config: reviewConfig({ scriptIntake: { markdown: { storyHeading: "本編", reviewHeading: "" } } }), planRawScript: planNarratedStoryScript,
  });
  assert.deepEqual(noReviewHeading.issues, ["script-markdown-review-heading-undeclared"]);
  // .txt でも見出しらしい行があれば、生テキストとして声にせず止める。
  const headingInText = planNarratedStoryInput({ script: "## 本編\n最初の文です。", scriptPath: "script.txt", config: baseConfig(), planRawScript: planNarratedStoryScript });
  assert.deepEqual(headingInText.issues, ["script-markdown-structure-undeclared"]);
});

test("生テキストは従来どおり（segment も requestKey の材料も変えない）", () => {
  const raw = "最初の物語です。次の場面です。";
  const before = planNarratedStoryScript(raw, baseConfig());
  const after = planNarratedStoryInput({ script: raw, scriptPath: "script.txt", config: baseConfig(), planRawScript: planNarratedStoryScript });
  assert.deepEqual(after.storySegments, before.storySegments);
  assert.deepEqual(after.issues, before.issues);
  assert.equal(after.input.format, "raw-text");
  assert.deepEqual(narratedSegmentManifestFields(after.storySegments[0]), {});
});

async function writePack(dir, extra = {}) {
  await mkdir(dir, { recursive: true });
  const config = {
    version: "fixture-pack-v1",
    runtime: { imageModel: "fixture-image-v1", ttsProvider: "fixture-voice" },
    image: { provider: "fixture-image", model: "fixture-image-v1", adapterVersion: "fixture-image-adapter-v1", stylePrompt: "flat fixture" },
    voice: { provider: "fixture-voice", model: "fixture-voice-v1", adapterVersion: "fixture-voice-adapter-v1", voiceId: "fixture-narrator", speed: 1 },
    music: { provider: "fixture-music", model: "fixture-music-v1", adapterVersion: "fixture-music-adapter-v1", prompt: "quiet", gain: 0.03 },
    render: { width: 320, height: 180, fps: 12 },
    bookends: { enabled: false },
    ...extra,
  };
  const bytes = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(join(dir, "narrated-story.json"), bytes, "utf8");
  return { config, payloadSha256: sha256(bytes) };
}

test("plan-only の preflight は台本パッケージを読み、止まる理由をまとめて返す（有料 API は呼ばない）", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "narrated-script-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pack = join(root, "pack");
  await writePack(pack, { scriptIntake: { markdown: { storyHeading: "本編" } } });
  const packagePath = join(root, "script.json");
  await writeFile(packagePath, JSON.stringify(samplePackage({
    speakers: [{ id: "c-shop", castRole: "shopkeeper" }],
    story: [{ id: "s01", text: "「いらっしゃい」", speaker: "c-shop" }],
    readings: [],
  })), "utf8");
  // 台本の関門（監査契約 v8 から）はこの試験の対象外。台本を人がそのまま使うと認めた記録を置く（SHA ごと）。
  await acceptScriptForTests(packagePath);
  const blocked = await inspectNarratedStoryPlan({ scriptPath: packagePath, channelPackDir: pack });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.blockers, ["cast-role-undeclared:shopkeeper"]);
  assert.equal(blocked.paidCallsAttempted, false);
  await writeFile(packagePath, JSON.stringify(samplePackage()), "utf8");
  await acceptScriptForTests(packagePath);
  const ready = await inspectNarratedStoryPlan({ scriptPath: packagePath, channelPackDir: pack });
  assert.equal(ready.ok, true, ready.blockers.join(", "));
  assert.deepEqual(ready.segments, { story: 3, review: 0 });
  assert.equal(ready.scriptInput.format, NARRATED_SCRIPT_PACKAGE_FORMAT);
});

test("durable Job へ持ち込む Pack の形の検査: scriptIntake と qualityLoop を受け、未知の下位項目は拒否する", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "narrated-script-intake-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = (payloadSha256) => ({ harnessId: "narrated-story-video", payloadSha256 });
  const ok = await writePack(join(root, "ok"), { scriptIntake: { markdown: { storyHeading: "本編", reviewHeading: "振り返り" } }, qualityLoop: { maximumReviewRounds: 2 } });
  const runtime = await extractNarratedChannelPackRuntime({ payloadDir: join(root, "ok"), evidence: evidence(ok.payloadSha256) });
  assert.equal(runtime.ttsProvider, "fixture-voice");
  const bad = await writePack(join(root, "bad"), { scriptIntake: { markdown: { storyHeading: "本編", guessHeadings: true } } });
  await assert.rejects(
    extractNarratedChannelPackRuntime({ payloadDir: join(root, "bad"), evidence: evidence(bad.payloadSha256) }),
    /scriptIntake\.markdown contains unsupported fields: guessHeadings/u,
  );
});

test("公式経路: 台本パッケージから、字幕は表記・声は読み・画は場面ごとに1枚で作る", async (t) => {
  const { resolveFfmpegToolchain } = await import("../lib/harnessRuntimeResolver.mjs");
  const toolchain = await resolveFfmpegToolchain();
  if (!toolchain.ok) {
    t.skip("ffmpeg/ffprobe is unavailable");
    return;
  }
  const { runNarratedStoryPipeline, narratedStoryRunPaths } = await import("../lib/narratedStoryPipeline.mjs");
  const { bookendFixtureAdapters, createBookendFixtureMedia, passingVoiceQualityGate } = await import("./fixtures/narratedBookendFixture.mjs");
  const { runPastAssetLoops } = await import("./fixtures/narratedAssetLoopFixture.mjs");
  const root = await mkdtemp(join(tmpdir(), "narrated-script-package-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pack = join(root, "pack");
  await writePack(pack);
  const scriptPath = join(root, "input", "script.json");
  await mkdir(dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, JSON.stringify(samplePackage()), "utf8");
  // 台本の関門（監査契約 v8 から）はこの試験の対象外。台本を人がそのまま使うと認めた記録を置く。
  await acceptScriptForTests(scriptPath);
  const fixture = await createBookendFixtureMedia(join(root, "media"), toolchain);
  const adapters = bookendFixtureAdapters(fixture);
  const specs = [];
  const jobId = "video-narrated-story-video-00000000000000aa";
  let loopStop = null;
  const outcome = await runPastAssetLoops(() => runNarratedStoryPipeline({
    scriptPath,
    channelPackDir: pack,
    jobId,
    deploymentRoot: root,
    mediaJobRunner: async (spec) => { specs.push(spec); return adapters.mediaJobRunner(spec); },
    mediaJobProbe: adapters.mediaJobProbe,
    ffmpegToolchain: toolchain,
    voiceQualityGate: passingVoiceQualityGate,
    jobIdentityDigest: "d".repeat(64),
    env: {},
  }), { onStop: (stopped) => { loopStop = stopped; } });
  // 途中の成果物の品質ループは、画は場面ごと（imageKey）に1つ、声は話者の区切りごとに1つ。
  assert.ok(loopStop, "生成の後、描く前に品質ループの合格を待って止まる");
  const pendingOf = (stage) => loopStop.assetQualityLoop.pending.filter((row) => row.stage === stage).map((row) => row.subjectId).sort();
  assert.deepEqual(pendingOf("scene-image"), ["s01", "s02"]);
  assert.equal(pendingOf("voice-take").length, 3);
  assert.equal(outcome.status, "awaiting-human-review", outcome.knownRemainingIssues.join(", "));
  assert.ok(outcome.artifacts.previewVideo, "合格の後に描く");
  const images = specs.filter((spec) => spec.kind === "image.generation");
  const voices = specs.filter((spec) => spec.kind === "voice.synthesis");
  assert.equal(images.length, 2, "場面は2つ");
  assert.deepEqual(images.map((spec) => spec.input.segmentId).sort(), ["s01", "s02"]);
  assert.match(images.find((spec) => spec.input.segmentId === "s01").input.prompt, /雨の商店街/u);
  assert.equal(voices.length, 3);
  assert.ok(voices.some((spec) => spec.input.text === "雨の朝、店の戸をひらけずに待った。"), "声には読み");
  assert.equal(voices.some((spec) => spec.input.text.includes("開けずに")), false, "声に表記を渡していない");
  const runDir = narratedStoryRunPaths({ deploymentRoot: root, jobId }).runDir;
  const srt = await readFile(join(runDir, "render", "subtitles.srt"), "utf8");
  assert.match(srt, /開けずに/u, "字幕は表記");
  assert.equal(srt.includes("ひらけずに"), false);
  const manifest = JSON.parse(await readFile(join(runDir, "generation-manifest.json"), "utf8"));
  assert.equal(manifest.scriptInput.format, NARRATED_SCRIPT_PACKAGE_FORMAT);
  assert.equal(manifest.scriptInput.sourceMarkdown.sha256, "c".repeat(64));
  const s01 = manifest.segments.find((segment) => segment.id === "s01");
  assert.equal(s01.reading.readingsApplied, 1);
  assert.equal(s01.sourceSegmentId, "s01");
  const s02 = manifest.segments.filter((segment) => segment.sourceSegmentId === "s02");
  assert.equal(s02.length, 2);
  assert.equal(new Set(s02.map((segment) => segment.imageSha256)).size, 1, "同じ場面は同じ画");
  assert.equal(JSON.stringify(manifest).includes("ひらけずに"), false, "生成記録に台本の文を残さない");
});
