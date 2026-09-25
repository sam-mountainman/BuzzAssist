// 声の品質ゲート（lib/narratedStoryVoiceQuality.mjs）と人物の同一性の監査の試験。台本・声はすべて合成。
// python の QA 実行系は使わず、ゲートと同じ形の判定を差し込む（本物のゲートは test/voiceQualityGate.test.mjs）。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { resolveFfmpegToolchain } from "../lib/harnessRuntimeResolver.mjs";
import { narratedStoryRunPaths, runNarratedStoryPipeline } from "../lib/narratedStoryPipeline.mjs";
import {
  NARRATED_CHARACTER_IDENTITY_AUDIT_ID,
  createNarratedQualityContract,
  narratedCharacterIdentityCheck,
} from "../lib/narratedStoryQualityLoop.mjs";
import {
  NARRATED_VOICE_QUALITY_AUDIT_ID,
  NARRATED_VOICE_TAKE_MEASUREMENT_VERSION,
  gateNarratedVoiceTakes,
  narratedVoiceTakeMeasurementReport,
  normalizeNarratedVoiceQualityConfig,
} from "../lib/narratedStoryVoiceQuality.mjs";
import { bookendFixtureAdapters, createBookendFixtureMedia } from "./fixtures/narratedBookendFixture.mjs";
import { runPastAssetLoops } from "./fixtures/narratedAssetLoopFixture.mjs";

/** 指定した id（segment#take）だけを落とす合成のゲート。受け取った checks を記録する。 */
function scriptedGate({ failing = new Set(), dropMetric = new Set(), missing = new Set(), available = true } = {}) {
  const seen = [];
  return {
    seen,
    available: async () => available,
    audit: async ({ checks }) => {
      seen.push(...checks);
      return {
        checks: checks.filter((check) => !missing.has(check.id)).map((check) => ({
          id: check.id,
          type: check.type,
          status: failing.has(check.id) ? "fail" : "pass",
          metrics: {
            ...(dropMetric.has(check.id) ? {} : { utmos: failing.has(check.id) ? 1.9 : 4.1 }),
            cer: failing.has(check.id) ? 0.4 : 0.02,
            transcript: "合成の文字起こし（報告に残してはいけない）",
          },
          problems: failing.has(check.id) ? ["cer 0.400 > 0.13"] : [],
          warnings: [],
          unavailable: [],
        })),
      };
    },
  };
}

const receipt = (id, take = 1) => ({ jobId: `job-${id}-${take}`, artifact: { sha256: `${take}`.repeat(64).slice(0, 64) } });

test("撮り直しの上限は Pack で決め、範囲外は止める", () => {
  assert.deepEqual(normalizeNarratedVoiceQualityConfig(undefined), { config: { maxTakesPerTurn: 2 }, blockers: [] });
  assert.equal(normalizeNarratedVoiceQualityConfig({ maxTakesPerTurn: 3 }).config.maxTakesPerTurn, 3);
  assert.deepEqual(normalizeNarratedVoiceQualityConfig({ maxTakesPerTurn: 9 }).blockers, ["voiceQuality.maxTakesPerTurn"]);
  assert.deepEqual(normalizeNarratedVoiceQualityConfig({ maxTakesPerTurn: 2, skip: true }).blockers, ["voiceQuality.skip-unknown"]);
});

test("ゲートに落ちたテイクは採用せず撮り直す。読み（spokenText）を基準に測り、報告に文字起こしを残さない", async () => {
  const segments = [
    { id: "s01", text: "戸を開けずに待った。", spokenText: "戸をひらけずに待った。" },
    { id: "s02", text: "「おかえり」" },
  ];
  const gate = scriptedGate({ failing: new Set(["s02#1"]) });
  const retakes = [];
  const result = await gateNarratedVoiceTakes({
    segments,
    takesBySegment: new Map(segments.map((segment) => [segment.id, [{ take: 1, path: `/work/${segment.id}.wav`, receipt: receipt(segment.id) }]])),
    retake: async (segment, take) => { retakes.push([segment.id, take]); return { path: `/work/${segment.id}.take${take}.wav`, receipt: receipt(segment.id, take) }; },
    maxTakes: 2,
    gate,
  });
  assert.deepEqual(retakes, [["s02", 2]], "落ちた文だけを撮り直す");
  assert.equal(result.check.pass, true, result.check.detail);
  assert.equal(result.selected.get("s02").take, 2);
  assert.equal(result.selected.get("s01").take, 1);
  assert.equal(result.extraReceipts.length, 1);
  assert.equal(gate.seen.find((check) => check.id === "s01#1").expectedText, "戸をひらけずに待った。", "CER は声に渡した読みで測る");
  assert.equal(JSON.stringify(result.report).includes("文字起こし"), false, "報告に文字起こしを残さない");
  assert.equal(JSON.stringify(result.report).includes("おかえり"), false, "報告に台本の文を残さない");
  assert.equal(result.report.segments.find((row) => row.segmentId === "s02").takes[0].hardFail, true);
});

test("測定は声のテイクの工程の measurement になる: 全テイクの判定と数値の指標を、テイクの sha256 に結び付けて文を持たずに残す", async () => {
  const segments = [
    { id: "s01", text: "戸を開けずに待った。", spokenText: "戸をひらけずに待った。" },
    { id: "s02", text: "「おかえり」" },
  ];
  const result = await gateNarratedVoiceTakes({
    segments,
    takesBySegment: new Map(segments.map((segment) => [segment.id, [{ take: 1, path: `/work/${segment.id}.wav`, receipt: receipt(segment.id) }]])),
    retake: async (segment, take) => ({ path: `/work/${segment.id}.take${take}.wav`, receipt: receipt(segment.id, take) }),
    maxTakes: 2,
    gate: scriptedGate({ failing: new Set(["s02#1"]) }),
  });
  // 候補: 文ごとの全テイクと、ゲートに通ったか（品質ループが採用するテイクをこの中から選ぶ）。
  assert.deepEqual(result.candidates.get("s02").map((row) => [row.take, row.machinePass]), [[1, false], [2, true]]);
  assert.deepEqual(result.candidates.get("s01").map((row) => [row.take, row.machinePass]), [[1, true]]);
  assert.deepEqual(result.measurements.map((row) => `${row.segmentId}#${row.take}:${row.status}`), ["s01#1:pass", "s02#1:fail", "s02#2:pass"]);

  const sha = (seed) => seed.repeat(64);
  const shaByPath = new Map([["/work/s01.wav", sha("a")], ["/work/s02.wav", sha("b")], ["/work/s02.take2.wav", sha("c")]]);
  const report = narratedVoiceTakeMeasurementReport(result.measurements, shaByPath);
  assert.equal(report.version, NARRATED_VOICE_TAKE_MEASUREMENT_VERSION);
  assert.deepEqual(report.requiredMetrics, ["utmos", "cer"]);
  assert.deepEqual(report.checks.map((row) => [row.id, row.status, row.inputSha256.audio]), [
    ["s01#1", "pass", sha("a")],
    ["s02#1", "fail", sha("b")],
    ["s02#2", "pass", sha("c")],
  ]);
  assert.deepEqual(report.checks[0].metrics, { utmos: 4.1, cer: 0.02 }, "数値の指標だけを残す");
  const text = JSON.stringify(report);
  for (const forbidden of ["文字起こし", "おかえり", "ひらけずに", "/work/"]) assert.equal(text.includes(forbidden), false, `measurement leaked: ${forbidden}`);
  // ループの機械ゲートと同じ判定（voiceQualityPenalty）で、落ちたテイクは落ち、通ったテイクは通る。
  const { voiceQualityPenalty } = await import("../lib/voiceQualityGate.mjs");
  const verdict = (id) => voiceQualityPenalty(report.checks.find((row) => row.id === id), { requiredMetrics: report.requiredMetrics }).hardFail;
  assert.deepEqual(["s01#1", "s02#1", "s02#2"].map(verdict), [false, true, false]);
  // sha256 を読めなかったテイクは載せない（載っていないテイクはループの機械ゲートに通らない）。
  assert.deepEqual(narratedVoiceTakeMeasurementReport(result.measurements, new Map([["/work/s01.wav", sha("a")]])).checks.map((row) => row.id), ["s01#1"]);
});

test("上限まで撮り直しても合格のテイクが無い・必須の指標が測れない・結果が返らないテイクは監査を落とす", async () => {
  const segments = [{ id: "s01", text: "一文目。" }, { id: "s02", text: "二文目。" }, { id: "s03", text: "三文目。" }];
  const takes = () => new Map(segments.map((segment) => [segment.id, [{ take: 1, path: `/work/${segment.id}.wav`, receipt: receipt(segment.id) }]]));
  const noRetake = await gateNarratedVoiceTakes({
    segments,
    takesBySegment: takes(),
    retake: async () => { throw new Error("must not retake when maxTakes is 1"); },
    maxTakes: 1,
    gate: scriptedGate({ failing: new Set(["s01#1"]), dropMetric: new Set(["s02#1"]), missing: new Set(["s03#1"]) }),
  });
  assert.equal(noRetake.check.pass, false);
  assert.deepEqual(noRetake.check.failedSegmentIds, ["s01", "s02", "s03"]);
  assert.deepEqual(noRetake.report.segments.find((row) => row.segmentId === "s02").takes[0].missingRequiredMetrics, ["utmos"]);
  assert.equal(noRetake.selected.get("s01").take, 1, "落ちても番組は描ける（reviewer が聴ける）が、監査は通さない");
  const empty = await gateNarratedVoiceTakes({ segments: [], gate: scriptedGate() });
  assert.equal(empty.check.pass, false, "測る物が無いのは合格ではない");
});

test("人物の同一性: 承認・署名済みの独立レビューが下限以上で採点し、合格した回と同じ signoff のときだけ通す", () => {
  const contract = createNarratedQualityContract();
  const signoff = (score, digest = contract.digest) => ({
    reviewerContextId: "review-context-001",
    qualityReview: { contractDigest: digest, rubricScores: { "character-identity": score } },
  });
  const passedLoop = { pass: true, signoffSha256: "a".repeat(64) };
  const base = { contract, qualityCheck: passedLoop, signoffSha256: "a".repeat(64), video: { sha256: "b".repeat(64) }, contactSheet: { sha256: "c".repeat(64) } };
  const ok = narratedCharacterIdentityCheck({ ...base, signoff: signoff(88) });
  assert.equal(ok.pass, true, ok.detail);
  assert.equal(ok.minimumScore, 80);
  assert.equal(ok.signoffSha256, "a".repeat(64));
  assert.equal(ok.videoSha256, "b".repeat(64));
  assert.equal(narratedCharacterIdentityCheck({ ...base, signoff: signoff(79) }).pass, false, "下限割れ");
  assert.equal(narratedCharacterIdentityCheck({ ...base, signoff: null }).pass, false, "承認された署名済みレビューが無い");
  assert.equal(narratedCharacterIdentityCheck({ ...base, signoff: signoff(90, "d".repeat(64)) }).pass, false, "別の契約の採点");
  assert.equal(narratedCharacterIdentityCheck({ ...base, qualityCheck: { pass: false } , signoff: signoff(95) }).pass, false, "ループが合格していない");
  assert.equal(narratedCharacterIdentityCheck({ ...base, qualityCheck: { pass: true, signoffSha256: "e".repeat(64) }, signoff: signoff(95) }).pass, false, "別の回の合格を転用しない");
  assert.equal(NARRATED_CHARACTER_IDENTITY_AUDIT_ID, "characterIdentityReviewed");
});

async function writePack(dir, extra = {}) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "narrated-story.json"), JSON.stringify({
    version: "fixture-pack-v1",
    runtime: { imageModel: "fixture-image-v1", ttsProvider: "fixture-voice" },
    image: { provider: "fixture-image", model: "fixture-image-v1", adapterVersion: "fixture-image-adapter-v1", stylePrompt: "flat fixture" },
    voice: { provider: "fixture-voice", model: "fixture-voice-v1", adapterVersion: "fixture-voice-adapter-v1", voiceId: "fixture-narrator", speed: 1 },
    music: { provider: "fixture-music", model: "fixture-music-v1", adapterVersion: "fixture-music-adapter-v1", prompt: "quiet", gain: 0.03 },
    render: { width: 320, height: 180, fps: 12 },
    bookends: { enabled: false },
    ...extra,
  }), "utf8");
}

test("公式経路: QA 実行系が無ければ有料生成の前に止まり、落ちたテイクは撮り直して監査に残す", async (t) => {
  const toolchain = await resolveFfmpegToolchain();
  if (!toolchain.ok) { t.skip("ffmpeg/ffprobe is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "narrated-voice-quality-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pack = join(root, "pack");
  await writePack(pack);
  const fixture = await createBookendFixtureMedia(join(root, "media"), toolchain);
  const scriptPath = join(root, "input", "script.txt");
  await mkdir(dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, "最初の物語です。次の場面です。\n", "utf8");
  const run = async (jobId, gate) => {
    const adapters = bookendFixtureAdapters(fixture);
    const specs = [];
    const probes = [];
    // 途中の成果物の品質ループ（本編の画・声のテイク）で止まったら、本物のループで合格させて再開する。
    const outcome = await runPastAssetLoops(() => runNarratedStoryPipeline({
      scriptPath,
      channelPackDir: pack,
      jobId,
      deploymentRoot: root,
      mediaJobRunner: async (spec) => {
        specs.push(spec);
        const made = await adapters.mediaJobRunner(spec);
        // 撮り直しは本物と同じく別の音（別のバイト列）になる。最後の標本の1バイトだけ変えた有効な WAV。
        if (spec.kind === "voice.synthesis" && spec.input?.take > 1) {
          const bytes = Buffer.from(made.bytes);
          bytes[bytes.length - 1] ^= spec.input.take;
          return { ...made, bytes };
        }
        return made;
      },
      mediaJobProbe: async (adapter) => { probes.push(adapter); return adapters.mediaJobProbe(adapter); },
      ffmpegToolchain: toolchain,
      voiceQualityGate: gate,
      jobIdentityDigest: "b2".repeat(32),
      env: {},
    }));
    return { outcome, specs, probes, runDir: narratedStoryRunPaths({ deploymentRoot: root, jobId }).runDir };
  };
  const unavailable = await run("video-narrated-story-video-00000000000000e1", scriptedGate({ available: false }));
  assert.equal(unavailable.outcome.status, "awaiting-media");
  assert.deepEqual(unavailable.outcome.knownRemainingIssues, ["voice-quality-gate-unavailable"]);
  assert.equal(unavailable.specs.length, 0, "課金してから止まらない");
  assert.equal(unavailable.probes.length, 0);

  // s002 の1本目だけを落とす（id は segment#take）。既定の上限 2 で撮り直す。
  const retaken = await run("video-narrated-story-video-00000000000000e2", scriptedGate({ failing: new Set(["s002#1"]) }));
  assert.equal(retaken.outcome.status, "awaiting-human-review", retaken.outcome.knownRemainingIssues.join(", "));
  assert.equal(retaken.outcome.auditChecks[NARRATED_VOICE_QUALITY_AUDIT_ID].pass, true, retaken.outcome.auditChecks[NARRATED_VOICE_QUALITY_AUDIT_ID].detail);
  assert.equal(retaken.outcome.auditChecks[NARRATED_VOICE_QUALITY_AUDIT_ID].retakes, 1);
  assert.equal(retaken.outcome.auditChecks.voiceCastRouting.pass, true, retaken.outcome.auditChecks.voiceCastRouting.detail);
  const voiceSpecs = retaken.specs.filter((spec) => spec.kind === "voice.synthesis");
  assert.equal(voiceSpecs.length, 3, "2文 + 撮り直し1本");
  assert.equal(voiceSpecs.filter((spec) => spec.input.take === 2).length, 1, "撮り直しは別の requestKey（take を入力に足す）");
  assert.equal(retaken.outcome.mediaJobs.filter((job) => job.kind === "voice.synthesis").length, 3, "撮り直しも課金の記録に残す");
  const manifest = JSON.parse(await readFile(join(retaken.runDir, "generation-manifest.json"), "utf8"));
  assert.equal(manifest.voiceQuality.segments.find((row) => row.segmentId === "s002").selectedTake, 2);

  // 上限まで撮り直しても品質ゲートに通るテイクが無い文は、声のテイクの品質ループでも救えない。
  // ほかの対象のループが合格しても、描かず（BGM も依頼せず）に人待ちで止まり、理由を文の ID で返す。
  const failed = await run("video-narrated-story-video-00000000000000e3", scriptedGate({ failing: new Set(["s001#1", "s001#2"]) }));
  assert.equal(failed.outcome.status, "awaiting-human-review");
  assert.deepEqual(failed.outcome.knownRemainingIssues, ["voice-take-asset-loop-not-passed:s001:voice-quality-gate-failed"]);
  assert.equal(failed.outcome.auditChecks[NARRATED_VOICE_QUALITY_AUDIT_ID].pass, false);
  assert.equal(failed.outcome.auditChecks.voiceTakeAssetLoopPassed.pass, false);
  assert.equal(failed.outcome.artifacts.previewVideo, undefined, "描かない");
  assert.equal(failed.specs.filter((spec) => spec.kind === "music.generation").length, 0, "合格の前に曲の代金を払わない");
  const measurement = JSON.parse(await readFile(join(failed.runDir, "quality", "voice-take-measurements", "s001.json"), "utf8"));
  assert.deepEqual(measurement.checks.map((row) => [row.id, row.status]), [["s001#1", "fail"], ["s001#2", "fail"]], "落ちたテイクの測定も、その文の measurement に残す");
});
