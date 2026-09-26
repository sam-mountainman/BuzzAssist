// 解説動画のハーネス（explainer-video）の試験。チャンネル名・人名は合成、動画・字幕・サムネは ffmpeg で作る小さな合成。
// 取り込み（import-delivery）は制作のスクリプトを起動せず、有料の呼び出しの関所の中で監査して Job と RunReceipt に残す。
// 制作の実行（produce）は合成のダミーの制作スクリプトで、3つのパスを明示して起動することだけを確かめる。

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createChannelPackEnvelope } from "../lib/channelPackEnvelope.mjs";
import { validateChannelRegistry } from "../lib/channelRegistry.mjs";
import {
  EXPLAINER_CHANNEL_PACK_FILE,
  EXPLAINER_PAYLOAD_KIND,
  assertExplainerStartOptions,
  resolveExplainerSteps,
  validateExplainerChannelPack,
} from "../lib/explainerChannelPack.mjs";
import {
  EXPLAINER_AUDIT_IDS,
  EXPLAINER_HUMAN_REVIEW_ISSUE,
  _testing as explainerTesting,
  auditExplainerDelivery,
  parseSrt,
  planExplainerVideo,
  runExplainerVideo,
} from "../lib/explainerVideo.mjs";
import { resolveFfmpegToolchain } from "../lib/harnessRuntimeResolver.mjs";
import { _testing as adapterTesting, executeVideoHarnessAdapter, prepareVideoHarnessJob } from "../lib/videoHarnessAdapters.mjs";
import { createVideoHarnessJob, runVideoHarnessJob } from "../lib/videoHarnessJob.mjs";
import { runHarnessDoctor } from "../scripts/harness-doctor.mjs";
import { loadHarnesses } from "../scripts/harness-registry.mjs";
import { acceptScriptForTests } from "./helpers/scriptQualityAcceptance.mjs";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toolchain = await resolveFfmpegToolchain();
const needsFfmpeg = { skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable" };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const CHANNEL = "sample-explainer";
const SCRIPT_TEXT = "# 合成の解説\n\n合成の台本の一文目。\n\n合成の台本の二文目。\n";

async function ffmpeg(args) {
  await execFile(toolchain.ffmpeg.command, [...(toolchain.ffmpeg.args || []), "-hide_banner", "-loglevel", "error", "-y", ...args]);
}

/** 声だけ（文の間に無音）の3秒の動画。bgm: true なら低い持続音を敷く。 */
async function makeVideo(file, { bgm = false } = {}) {
  const voice = "if(lt(mod(t\\,1)\\,0.6)\\,0.3*sin(2*PI*440*t)\\,0)";
  const expression = bgm ? `${voice}+0.03*sin(2*PI*220*t)` : voice;
  await ffmpeg([
    "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=3",
    "-f", "lavfi", "-i", `aevalsrc=${expression}:s=48000:d=3`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file,
  ]);
}

async function probe(file) {
  const { stdout } = await execFile(toolchain.ffprobe.command, [...(toolchain.ffprobe.args || []), "-v", "error",
    "-show_entries", "stream=codec_type,width,height,nb_frames:format=duration", "-of", "json", file]);
  const parsed = JSON.parse(stdout);
  const video = parsed.streams.find((stream) => stream.codec_type === "video");
  return { duration: Number(parsed.format.duration), width: video.width, height: video.height, frames: Number(video.nb_frames) };
}

const DUMMY_PRODUCER = `// 合成のダミーの制作スクリプト（試験用）。受け取った引数を記録し、用意済みの成果物で納品の記録を書き直す。
import { createHash } from "node:crypto";
import { copyFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
writeFileSync(path.join(root, "producer-ran.json"), JSON.stringify({ args }));
const output = value("--output-dir");
for (const name of ["final.mp4", "captions.srt", "thumbnail.jpg", "UPLOAD.md", "DELIVERY.json"]) {
  copyFileSync(path.join(root, "prepared", name), path.join(output, name));
}
`;

/**
 * 合成の制作のフォルダ（videoRoot）: production/SCRIPT.md、out/ の完成版と DELIVERY.json、prepared/ に同じ写し、
 * scripts/produce.mjs（ダミーの制作）。captions / bgm で字幕と音を差し替えられる。
 */
async function createFixture({ captions = "1\n00:00:00,100 --> 00:00:00,900\n合成の字幕1\n\n2\n00:00:01,100 --> 00:00:02,500\n\n合成の字幕2 20ページ\n", bgm = false } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), "explainer-video-"));
  const videoRoot = path.join(base, "video-root");
  const out = path.join(videoRoot, "out");
  const production = path.join(videoRoot, "production");
  const prepared = path.join(videoRoot, "prepared");
  for (const dir of [out, production, prepared, path.join(videoRoot, "visuals"), path.join(videoRoot, "scripts")]) await mkdir(dir, { recursive: true });
  const scriptPath = path.join(production, "SCRIPT.md");
  await writeFile(scriptPath, SCRIPT_TEXT);
  const video = path.join(out, "final.mp4");
  await makeVideo(video, { bgm });
  const facts = await probe(video);
  await writeFile(path.join(out, "captions.srt"), captions);
  await ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=1280x720", "-frames:v", "1", path.join(out, "thumbnail.jpg")]);
  await writeFile(path.join(out, "UPLOAD.md"), "# 合成の投稿用情報\n");
  const shaOf = async (file) => sha256(await readFile(file));
  const scriptSha256 = await shaOf(scriptPath);
  const videoBytes = (await readFile(video)).length;
  const delivery = {
    script_sha256: scriptSha256,
    video: {
      script_sha256: scriptSha256,
      file: video,
      sha256: await shaOf(video),
      bytes: videoBytes,
      duration_seconds: facts.duration,
      width: facts.width,
      height: facts.height,
      fps: 30,
      frames: String(facts.frames),
      bgm,
    },
    captions: path.join(out, "captions.srt"),
    captions_sha256: await shaOf(path.join(out, "captions.srt")),
    thumbnail: path.join(out, "thumbnail.jpg"),
    thumbnail_sha256: await shaOf(path.join(out, "thumbnail.jpg")),
    upload_metadata: path.join(out, "UPLOAD.md"),
    script: scriptPath,
  };
  await writeFile(path.join(out, "DELIVERY.json"), `${JSON.stringify(delivery, null, 2)}\n`);
  for (const name of ["final.mp4", "captions.srt", "thumbnail.jpg", "UPLOAD.md", "DELIVERY.json"]) {
    await writeFile(path.join(prepared, name), await readFile(path.join(out, name)));
  }
  await writeFile(path.join(videoRoot, "scripts", "produce.mjs"), DUMMY_PRODUCER);
  const pins = {
    deliverySha256: await shaOf(path.join(out, "DELIVERY.json")),
    scriptSha256,
    videoSha256: delivery.video.sha256,
    captionsSha256: delivery.captions_sha256,
    thumbnailSha256: delivery.thumbnail_sha256,
    uploadMetadataSha256: await shaOf(path.join(out, "UPLOAD.md")),
  };
  return { base, videoRoot, scriptPath, delivery, pins };
}

function packPayload(fixture, overrides = {}) {
  return {
    version: "buzzassist-explainer-channel-pack-v1",
    channelId: CHANNEL,
    harnessId: "explainer-video",
    videoRoot: fixture.videoRoot,
    paths: { productionDir: "production", visualsDir: "visuals", outputDir: "out" },
    delivery: { file: "out/DELIVERY.json" },
    release: fixture.pins,
    scriptQuality: { genre: "explainer", workDir: "production" },
    assetQuality: { workDir: ".", stages: ["thumbnail"] },
    display: { bgm: "none", numerals: "arabic" },
    production: {
      steps: [{ id: "produce", argv: ["node", "scripts/produce.mjs", "--production-dir", "{productionDir}", "--visuals-dir", "{visualsDir}", "--output-dir", "{outputDir}"] }],
    },
    ...overrides,
  };
}

function keyPair() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }),
  };
}

async function signPack(fixture, payload, name = "pack") {
  const source = path.join(fixture.base, `${name}-source`);
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, EXPLAINER_CHANNEL_PACK_FILE), `${JSON.stringify(payload, null, 2)}\n`);
  const key = keyPair();
  const bundleDir = path.join(fixture.base, name);
  await createChannelPackEnvelope({
    sourceDir: source,
    outputDir: bundleDir,
    id: "synthetic-explainer-pack",
    version: "1.0.0",
    harnessId: "explainer-video",
    payloadKind: EXPLAINER_PAYLOAD_KIND,
    privateKeyPem: key.privateKeyPem,
  });
  return { bundleDir, publicKeyPem: key.publicKeyPem };
}

const passingGates = {
  scriptQualityCheck: async () => ({ pass: true, reasonCode: "script-quality-passed", acceptedBy: "quality-loop", issues: [], next: [], evidence: { genre: "explainer" } }),
  assetQualityCheck: async ({ stage }) => ({ stage, pass: true, code: "", detail: "合成の合格" }),
};

test("宣言の監査 id と runner の監査 id が一致し、どの保証も監査に結び付いている", () => {
  const declaration = loadHarnesses().find((harness) => harness.id === "explainer-video");
  assert.ok(declaration, "宣言が読める");
  const declared = declaration.guarantees.flatMap((guarantee) => guarantee.evidenceAuditIds);
  assert.deepEqual([...declared].sort(), [...EXPLAINER_AUDIT_IDS].sort());
  assert.ok(declaration.guarantees.every((guarantee) => guarantee.inForceSince === "buzzassist-explainer-audit-v1"));
  assert.equal(declaration.reviewAttestation, undefined, "完成へ確定する検証器が無い間は subject を名乗らない");
  assert.equal(declaration.completion.status, "pending");
  assert.ok(declaration.completion.reason && declaration.completion.requiredWork);
});

test("Channel Pack の形: パスは制作のフォルダの中だけ、シェル・知らない欄・3つのパスの無い雛形は受けない", async () => {
  const fixture = await createFixture();
  try {
    const pack = validateExplainerChannelPack(packPayload(fixture));
    assert.equal(pack.paths.productionDir, path.join(fixture.videoRoot, "production"));
    assert.equal(pack.production.declared, true);
    const cases = [
      [{ paths: { productionDir: "../elsewhere", visualsDir: "visuals", outputDir: "out" } }, /相対パス/u],
      [{ paths: { productionDir: path.join(fixture.videoRoot, "production"), visualsDir: "visuals", outputDir: "out" } }, /相対パス/u],
      [{ scriptText: "本文" }, /知らない欄 scriptText/u],
      [{ production: { steps: [{ id: "x", argv: ["bash", "-c", "echo {productionDir} {visualsDir} {outputDir}"] }] } }, /argv\[0\]/u],
      [{ production: { steps: [{ id: "x", argv: ["node", "scripts/produce.mjs", "--production-dir", "{productionDir}"] }] } }, /\{visualsDir\} が無い/u],
      [{ production: { status: "not-declared" } }, /reason/u],
      [{ release: { videoSha256: "a".repeat(64) } }, /deliverySha256・scriptSha256・videoSha256/u],
      [{ display: { bgm: "none" } }, /display\.numerals/u],
      [{ scriptQuality: { genre: "narrated-story", workDir: "production" } }, /explainer/u],
      [{ videoRoot: "relative/root" }, /絶対パス/u],
    ];
    for (const [override, pattern] of cases) {
      assert.throws(() => validateExplainerChannelPack(packPayload(fixture, override)), (error) => error.code === "explainer-channel-pack-invalid" && pattern.test(error.message), JSON.stringify(override));
    }
    const notDeclared = validateExplainerChannelPack(packPayload(fixture, { production: { status: "not-declared", reason: "合成の理由" } }));
    assert.equal(notDeclared.production.declared, false);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("start の options: 既定は取り込み、手元の URL は produce のときだけ", () => {
  assert.equal(assertExplainerStartOptions({}), "import-delivery");
  assert.equal(assertExplainerStartOptions({ explainerMode: "produce", explainerRendererUrl: "http://127.0.0.1:8779/visuals/index.html?render=1" }), "produce");
  assert.throws(() => assertExplainerStartOptions({ explainerMode: "render" }), /explainer-start-options-invalid/u);
  assert.throws(() => assertExplainerStartOptions({ explainerRendererUrl: "http://127.0.0.1:8779/" }), /produce のときだけ/u);
  assert.throws(() => assertExplainerStartOptions({ explainerMode: "produce", explainerRendererUrl: "https://example.invalid/x" }), /手元の HTTP サーバー/u);
});

test("制作のコマンドの雛形は3つのパスを絶対パスで明示し、{rendererUrl} が無ければ名前を返す", async () => {
  const fixture = await createFixture();
  try {
    const payload = packPayload(fixture, {
      production: { steps: [
        { id: "render", argv: ["node", "scripts/render.mjs", "--production-dir", "{productionDir}", "--visuals-dir", "{visualsDir}", "--output-dir", "{outputDir}", "--url", "{rendererUrl}"] },
        { id: "package", argv: ["python3", "scripts/package.py", "--production-dir", "{productionDir}", "--output-dir", "{outputDir}"] },
      ] },
    });
    const pack = validateExplainerChannelPack(payload);
    const missing = resolveExplainerSteps(pack);
    assert.deepEqual(missing.missing, ["rendererUrl"]);
    const resolved = resolveExplainerSteps(pack, { rendererUrl: "http://127.0.0.1:9000/visuals/index.html" });
    assert.deepEqual(resolved.missing, []);
    assert.equal(resolved.steps[0].command, process.execPath);
    assert.deepEqual(resolved.steps[0].args, [
      path.join(fixture.videoRoot, "scripts", "render.mjs"),
      "--production-dir", path.join(fixture.videoRoot, "production"),
      "--visuals-dir", path.join(fixture.videoRoot, "visuals"),
      "--output-dir", path.join(fixture.videoRoot, "out"),
      "--url", "http://127.0.0.1:9000/visuals/index.html",
    ]);
    assert.equal(resolved.steps[1].command, "python3");
    assert.equal(resolved.steps[0].cwd, fixture.videoRoot);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("SRT: 本文の中の空行で字幕を切らず、時刻の行の直後の空行を数える", () => {
  const cues = parseSrt(String.fromCharCode(0xfeff) + "1\r\n00:00:00,300 --> 00:00:02,398\r\n一行目\r\n\r\n2\r\n00:00:02,398 --> 00:00:06,580\r\n\r\n二行目\r\n\r\n");
  assert.equal(cues.length, 2);
  assert.deepEqual(cues.map((cue) => cue.blankFirstLine), [false, true]);
  assert.equal(cues[1].text, "二行目");
  assert.equal(cues[1].end, 6.58);
});

test("音の区間: 無音の区間の数と、音の途切れない最長の区間", () => {
  const stderr = [
    "[silencedetect @ 0x1] silence_start: 0.6",
    "[silencedetect @ 0x1] silence_end: 1 | silence_duration: 0.4",
    "[silencedetect @ 0x1] silence_start: 1.6",
    "[silencedetect @ 0x1] silence_end: 2 | silence_duration: 0.4",
    "[silencedetect @ 0x1] silence_start: 2.6",
  ].join("\n");
  assert.deepEqual(explainerTesting.soundRunsFromSilencedetect(stderr, 3), { silenceCount: 3, longestSoundRunSeconds: 0.6 });
  assert.deepEqual(explainerTesting.soundRunsFromSilencedetect("", 90), { silenceCount: 0, longestSoundRunSeconds: 90 });
});

test("取り込みの監査: 一致すれば全部の監査が通り、壊した版はそれぞれの理由で落ちる", needsFfmpeg, async () => {
  const fixture = await createFixture();
  try {
    const pack = validateExplainerChannelPack(packPayload(fixture));
    const job = { script: { path: fixture.scriptPath, sha256: sha256(await readFile(fixture.scriptPath)) }, options: {} };
    const guardPath = path.join(fixture.base, "guard.jsonl");
    const good = await auditExplainerDelivery({ job, pack, mode: "import-delivery", guardPath }, passingGates);
    for (const id of EXPLAINER_AUDIT_IDS) assert.equal(good.checks[id]?.pass, true, `${id}: ${good.checks[id]?.detail}`);
    assert.deepEqual(good.issues, []);
    assert.deepEqual(good.artifacts.map((row) => row.kind).sort(), ["final-video", "subtitle", "thumbnail", "upload-metadata"]);
    assert.deepEqual(good.observations.map((row) => row.id), ["captions-blank-line-after-timing"], "時刻の直後の空行は観察として残し、合否には使わない");

    // 台本が違う。
    const otherScript = path.join(fixture.base, "other.md");
    await writeFile(otherScript, "合成の別の台本\n");
    const wrongScript = await auditExplainerDelivery({ job: { ...job, script: { path: otherScript, sha256: sha256(await readFile(otherScript)) } }, pack, mode: "import-delivery", guardPath }, passingGates);
    assert.equal(wrongScript.checks.scriptBoundToDelivery.pass, false);
    assert.ok(wrongScript.issues.some((issue) => issue.startsWith("explainer-script-not-bound-to-delivery")));

    // 字幕が納品の記録と違う（Pack の版の SHA とも違う）。
    await writeFile(path.join(fixture.videoRoot, "out", "captions.srt"), "1\n00:00:00,100 --> 00:00:00,900\n差し替え\n");
    const tampered = await auditExplainerDelivery({ job, pack, mode: "import-delivery", guardPath }, passingGates);
    assert.equal(tampered.checks.deliveryArtifactsBound.pass, false);
    assert.ok(tampered.issues.includes("explainer-delivery-artifact:subtitle:delivery-sha-mismatch"), tampered.issues.join(", "));
    assert.ok(tampered.issues.includes("explainer-delivery-artifact:subtitle:release-pin-mismatch"));
    assert.equal(tampered.checks.captionsTimingInRange.pass, false, "一致しない字幕は測らない");

    // 関所が止めた呼び出しがあれば落ちる。
    await writeFile(path.join(fixture.videoRoot, "out", "captions.srt"), await readFile(path.join(fixture.videoRoot, "prepared", "captions.srt")));
    await writeFile(guardPath, `${JSON.stringify({ version: "buzzassist-paid-call-guard-v1", route: "paid-media-broker", kind: "speech" })}\n`);
    const refused = await auditExplainerDelivery({ job, pack, mode: "import-delivery", guardPath }, passingGates);
    assert.equal(refused.checks.noBuzzAssistPaidCalls.pass, false);
    assert.ok(refused.issues.includes("explainer-paid-call-refused"));
    const unguarded = await auditExplainerDelivery({ job, pack, mode: "import-delivery", guardPath: "", env: {} }, passingGates);
    assert.equal(unguarded.checks.noBuzzAssistPaidCalls.pass, false, "取り込みで関所が効いていなければ合格にしない");

    // 品質ループの答えは、そのまま理由コードで残す（点数を作らない）。
    const loopsPending = await auditExplainerDelivery({ job, pack, mode: "import-delivery", guardPath: path.join(fixture.base, "empty.jsonl") }, {
      scriptQualityCheck: async () => ({ pass: false, reasonCode: "script-quality-loop-not-started", issues: ["script-quality-required:script-quality-loop-not-started"], next: [] }),
      assetQualityCheck: async ({ stage, subjectId }) => ({ stage, pass: false, code: `asset-quality-required:${stage}:${subjectId}:loop-not-started`, detail: "合成" }),
    });
    assert.ok(loopsPending.issues.includes("script-quality-required:script-quality-loop-not-started"));
    assert.ok(loopsPending.issues.includes("asset-quality-required:thumbnail:thumbnail:loop-not-started"));
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("表示の決まり: 漢数字の数量と、敷いた BGM を完成版から見つける", needsFfmpeg, async () => {
  const kanji = await createFixture({ captions: "1\n00:00:00,100 --> 00:00:00,900\n毎晩二十ページ読む\n\n2\n00:00:01,000 --> 00:00:02,000\n一方で、一人で読む\n" });
  const withBgm = await createFixture({ bgm: true });
  try {
    for (const fixture of [kanji, withBgm]) {
      fixture.pack = validateExplainerChannelPack(packPayload(fixture));
      fixture.job = { script: { path: fixture.scriptPath, sha256: sha256(await readFile(fixture.scriptPath)) }, options: {} };
    }
    const numerals = await auditExplainerDelivery({ job: kanji.job, pack: kanji.pack, mode: "import-delivery", guardPath: path.join(kanji.base, "g.jsonl") }, passingGates);
    assert.equal(numerals.checks.displayNumeralsArabic.pass, false);
    assert.deepEqual(numerals.checks.displayNumeralsArabic.flaggedCueNumbers, [1], "「一方」「一人で」は拾わない");
    const anyNumerals = await auditExplainerDelivery({ job: kanji.job, pack: { ...kanji.pack, display: { bgm: "none", numerals: "any" } }, mode: "import-delivery", guardPath: path.join(kanji.base, "g.jsonl") }, passingGates);
    assert.equal(anyNumerals.checks.displayNumeralsArabic.pass, true);

    const bgm = await auditExplainerDelivery({ job: withBgm.job, pack: withBgm.pack, mode: "import-delivery", guardPath: path.join(withBgm.base, "g.jsonl") }, passingGates);
    assert.equal(bgm.checks.bgmAbsentMeasured.pass, false, bgm.checks.bgmAbsentMeasured.detail);
    assert.equal(bgm.checks.bgmAbsentMeasured.silenceCount, 0);
    assert.ok(bgm.issues.includes("explainer-display-bgm-present"));
  } finally {
    await rm(kanji.base, { recursive: true, force: true });
    await rm(withBgm.base, { recursive: true, force: true });
  }
});

test("計画（plan-only）: 取り込みは何も起動せず再利用だけを並べ、produce は3つのパスを明示した起動を並べる", needsFfmpeg, async () => {
  const fixture = await createFixture();
  try {
    const pack = validateExplainerChannelPack(packPayload(fixture));
    const imported = await planExplainerVideo({ pack, scriptPath: fixture.scriptPath, options: {} });
    assert.equal(imported.mode, "import-delivery");
    assert.deepEqual(imported.wouldRun, []);
    assert.ok(imported.reuse.every((row) => row.matches), JSON.stringify(imported.reuse));
    assert.equal(imported.script.boundToDelivery, true);
    assert.equal(imported.paidCallsAttempted, false);
    assert.equal(imported.modelCallsAttempted, false);
    assert.equal(imported.productionScriptsRun, false);
    assert.ok(imported.blockers.includes("script-quality-required:script-quality-loop-not-started"), imported.blockers.join(", "));
    assert.ok(imported.blockers.includes("asset-quality-required:thumbnail:thumbnail:loop-not-started"));
    await assert.rejects(access(path.join(fixture.videoRoot, "producer-ran.json")), "制作のスクリプトを起動していない");

    const produced = await planExplainerVideo({ pack, scriptPath: fixture.scriptPath, options: { explainerMode: "produce" } }, passingGates);
    assert.equal(produced.wouldRun.length, 1);
    assert.deepEqual(produced.wouldRun[0].args.slice(1), [
      "--production-dir", path.join(fixture.videoRoot, "production"),
      "--visuals-dir", path.join(fixture.videoRoot, "visuals"),
      "--output-dir", path.join(fixture.videoRoot, "out"),
    ]);
    assert.deepEqual(produced.blockers, []);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("runner は上位の Job の束縛が無ければ何もしない", async () => {
  await assert.rejects(runExplainerVideo({ scriptPath: "/nowhere/script.md", jobId: "video-explainer-video-0000000000000000" }), (error) => error.code === "explainer-outer-job-required");
  await assert.rejects(runExplainerVideo({ upstreamJobPath: "/nowhere/job.json", jobId: "x" }), /全部そろえて/u);
});

test("doctor: 使わないと宣言した有料の adapter と音声品質ゲートを必須にしない", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "explainer-doctor-home-"));
  try {
    const report = await runHarnessDoctor({
      projectDir: homeDir,
      harnessId: "explainer-video",
      runtime: {
        env: {},
        homeDir,
        ffmpegToolchain: { ok: true, ffmpeg: { ok: true, command: "ffmpeg", args: [], version: "7" }, ffprobe: { ok: true, command: "ffprobe", args: [], version: "7" } },
        runCommand: async () => ({ stdout: "", stderr: "" }),
        diskFreeBytes: async () => 64 * 1024 ** 3,
        svgRasterizerProbe: async () => ({ ok: true, backend: "chrome", detail: "fixture", fix: "" }),
        reviewerTrustProbe: async () => ({ ok: true, activeReviewers: 1 }),
        pythonRuntime: { ok: false, detail: "使わないので呼ばれない" },
      },
    });
    for (const id of ["voice-quality-python", "tts-key", "image-key"]) {
      const row = report.checks.find((entry) => entry.id === id);
      assert.equal(row.required, false, id);
      assert.equal(row.status, "not-used", id);
    }
    assert.equal(report.checks.find((entry) => entry.id === "harness-production-route").required, true);
    assert.ok(!report.checks.some((entry) => entry.id === "music-key"));
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("チャンネルの台帳: 解説動画のハーネスと explainer の台本のジャンルで登録できる", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "explainer-registry-"));
  try {
    const channels = validateChannelRegistry({
      channels: [{
        id: CHANNEL,
        projectDir: path.join(base, "project"),
        channelPack: path.join(base, "pack"),
        production: { kind: "harness", harnessId: "explainer-video" },
        strategy: { workDir: path.join(base, "project", "strategy"), requireBrief: false },
        scriptQuality: { genre: "explainer" },
      }],
    }, { repoRoot: root, harnessIds: loadHarnesses().map((harness) => harness.id), genres: ["narrated-story", "manga", "explainer"], learningState: null });
    assert.equal(channels[0].production.harnessId, "explainer-video");
    assert.deepEqual(channels[0].learning, [], "解説動画には学習の宛先がまだ無いので、推測で別の台帳へ積まない");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("adapter: 取り込みの実行で関所が呼び出しを止めていたら、子の報告に関わらず failed にする", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "explainer-adapter-"));
  try {
    const job = {
      id: "video-explainer-video-0123456789abcdef",
      revision: 3,
      runDir: path.join(base, "run"),
      projectDir: base,
      options: {},
      script: { path: path.join(base, "script.md"), sha256: "a".repeat(64) },
      harness: { id: "explainer-video" },
      deployment: { root, entrypoint: "node scripts/explainer-video.mjs" },
      stages: [{ id: "doctor", status: "pass", evidence: { ready: true } }],
    };
    let seenGuard = "";
    const outcome = await adapterTesting.runExplainer(job, {
      prepareResult: { payloadDir: path.join(base, "pack", "payload") },
      runChild: async (command, args, { env }) => {
        seenGuard = env.BUZZASSIST_PAID_CALL_GUARD;
        await mkdir(path.dirname(seenGuard), { recursive: true });
        await writeFile(seenGuard, `${JSON.stringify({ route: "paid-media-broker", kind: "speech" })}\n`);
        return { code: 3, signal: null, stdout: JSON.stringify({ status: "awaiting-human-review", knownRemainingIssues: ["x"] }), stderr: "" };
      },
    });
    assert.equal(seenGuard, path.join(base, "run", "explainer", "paid-call-guard-r3.jsonl"));
    assert.equal(outcome.status, "failed");
    assert.deepEqual(outcome.blockers, ["explainer-paid-call-refused"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// 運営者の配置表（追跡しない config/harness-deployments.json）は端末ごとに違い、explainer-video の行が無い
// 端末もある。試験は同梱の例の配置表を明示して使い、運営者の設定に頼らない。
const EXAMPLE_DEPLOYMENTS = fileURLToPath(new URL("../config/harness-deployments.example.json", import.meta.url));

async function runJob({ fixture, bundleDir, publicKeyPem, projectDir, options = {} }) {
  const created = await createVideoHarnessJob({
    projectDir,
    scriptPath: fixture.scriptPath,
    harnessId: "explainer-video",
    channelPackPath: bundleDir,
    options,
    deploymentPath: EXAMPLE_DEPLOYMENTS,
  });
  const run = () => runVideoHarnessJob({
    projectDir,
    jobId: created.job.id,
    doctor: async () => ({ ready: true, blocking: [], checks: [] }),
    prepare: ({ job }) => prepareVideoHarnessJob({ job, trustedKey: { trustedPublicKeyPem: publicKeyPem }, env: {} }),
    adapter: executeVideoHarnessAdapter,
    projectCanvas: async () => {},
  });
  return { created, run };
}

test("Job: 取り込みは制作を起動せず、関所の中で監査して Job と RunReceipt に残し、人の評価で止まる。resume で同じ Job に付く", needsFfmpeg, async () => {
  const fixture = await createFixture();
  const projectDir = path.join(fixture.base, "project");
  await mkdir(projectDir, { recursive: true });
  try {
    await acceptScriptForTests(fixture.scriptPath, { workDir: path.join(fixture.videoRoot, "production") });
    const { bundleDir, publicKeyPem } = await signPack(fixture, packPayload(fixture));
    const { created, run } = await runJob({ fixture, bundleDir, publicKeyPem, projectDir });
    const job = await run();
    assert.equal(job.status, "awaiting-human-review", JSON.stringify(job.knownRemainingIssues));
    assert.ok(job.knownRemainingIssues.some((issue) => issue.startsWith(EXPLAINER_HUMAN_REVIEW_ISSUE)));
    assert.ok(job.knownRemainingIssues.includes("asset-quality-required:thumbnail:thumbnail:loop-not-started"), job.knownRemainingIssues.join(" / "));
    assert.ok(!job.knownRemainingIssues.some((issue) => issue.startsWith("script-quality-required")), "人がそのまま使うと認めた台本は通る");
    for (const id of ["deliveryManifestBound", "scriptBoundToDelivery", "deliveryArtifactsBound", "finalVideoFullDecode", "durationMatchesDelivery", "captionsTimingInRange", "thumbnailPresent", "scriptQualityAccepted", "displayNumeralsArabic", "bgmAbsentMeasured", "noBuzzAssistPaidCalls"]) {
      assert.equal(job.auditChecks[id]?.pass, true, `${id}: ${job.auditChecks[id]?.detail}`);
    }
    assert.equal(job.auditChecks.assetQualityLoopsPassed.pass, false);
    assert.deepEqual(job.artifacts.map((row) => row.kind).sort(), ["audit-report", "genre-run-receipt"], "完成版のファイルは Job の成果物に写さない（Canvas に複製を作らない）");
    await assert.rejects(access(path.join(fixture.videoRoot, "producer-ran.json")), "取り込みは制作のスクリプトを起動しない");
    const { readdir } = await import("node:fs/promises");
    const guards = (await readdir(path.join(job.runDir, "explainer"))).filter((name) => name.startsWith("paid-call-guard-"));
    for (const name of guards) {
      assert.equal((await readFile(path.join(job.runDir, "explainer", name), "utf8")).trim(), "", "関所の台帳に止めた呼び出しが無い");
    }

    const receipt = JSON.parse(await readFile(job.adapterRunReceiptPath, "utf8"));
    assert.equal(receipt.version, "harness-run-receipt-v1");
    assert.equal(receipt.finalized, true);
    assert.equal(receipt.outcome, "fail", "人の評価と品質ループが残る間は pass にしない");
    assert.equal(receipt.gates["delivery-bound"].verdict, "pass");
    assert.equal(receipt.gates["final-video-decodes"].verdict, "pass");
    assert.equal(receipt.gates["asset-quality-loop"].verdict, "fail");
    assert.equal(receipt.mediaJobs.length, 0);
    assert.ok(receipt.knownRemainingIssues.some((issue) => issue.startsWith(EXPLAINER_HUMAN_REVIEW_ISSUE)));
    const report = JSON.parse(await readFile(path.join(job.runDir, "explainer", "audit-report.json"), "utf8"));
    assert.equal(report.paidCallsAttempted, 0);
    assert.equal(report.modelCallsAttempted, 0);
    assert.equal(report.productionScriptsRun, false);
    assert.ok(!JSON.stringify(receipt).includes("合成の台本の一文目"), "RunReceipt に台本の本文を残さない");

    const again = await createVideoHarnessJob({ projectDir, scriptPath: fixture.scriptPath, harnessId: "explainer-video", channelPackPath: bundleDir, options: {}, deploymentPath: EXAMPLE_DEPLOYMENTS });
    assert.equal(again.attached, true);
    assert.equal(again.job.id, created.job.id);
    const resumed = await run();
    assert.equal(resumed.id, created.job.id);
    assert.equal(resumed.status, "awaiting-human-review");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("Job: produce は Pack の制作のコマンドを3つのパスを明示して起動し、できた納品を同じ監査にかける", needsFfmpeg, async () => {
  const fixture = await createFixture();
  const projectDir = path.join(fixture.base, "project");
  await mkdir(projectDir, { recursive: true });
  try {
    await acceptScriptForTests(fixture.scriptPath, { workDir: path.join(fixture.videoRoot, "production") });
    const { bundleDir, publicKeyPem } = await signPack(fixture, packPayload(fixture));
    const { run } = await runJob({ fixture, bundleDir, publicKeyPem, projectDir, options: { explainerMode: "produce" } });
    const job = await run();
    assert.equal(job.status, "awaiting-human-review", JSON.stringify(job.knownRemainingIssues));
    const ran = JSON.parse(await readFile(path.join(fixture.videoRoot, "producer-ran.json"), "utf8"));
    assert.deepEqual(ran.args, [
      "--production-dir", path.join(fixture.videoRoot, "production"),
      "--visuals-dir", path.join(fixture.videoRoot, "visuals"),
      "--output-dir", path.join(fixture.videoRoot, "out"),
    ]);
    assert.equal(job.auditChecks.deliveryArtifactsBound.pass, true);
    const report = JSON.parse(await readFile(path.join(job.runDir, "explainer", "audit-report.json"), "utf8"));
    assert.equal(report.productionScriptsRun, true);
    assert.deepEqual(report.production.steps.map((step) => [step.id, step.exitCode]), [["produce", 0]]);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("Job: Pack が制作のコマンドを宣言していなければ、produce は何も起動せずに人待ちで止まる", needsFfmpeg, async () => {
  const fixture = await createFixture();
  const projectDir = path.join(fixture.base, "project");
  await mkdir(projectDir, { recursive: true });
  try {
    const { bundleDir, publicKeyPem } = await signPack(fixture, packPayload(fixture, { production: { status: "not-declared", reason: "合成の理由" } }));
    const { run } = await runJob({ fixture, bundleDir, publicKeyPem, projectDir, options: { explainerMode: "produce" } });
    const job = await run();
    assert.equal(job.status, "awaiting-human-review");
    assert.ok(job.knownRemainingIssues[0].startsWith("explainer-production-not-declared"), job.knownRemainingIssues.join(" / "));
    await assert.rejects(access(path.join(fixture.videoRoot, "producer-ran.json")));
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});
