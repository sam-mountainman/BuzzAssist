import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createReviewerTrustEntry, generateReviewerKeyPair } from "../lib/koyaReviewAttestation.mjs";
import { runHarnessDoctor } from "../scripts/harness-doctor.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function deterministicDoctorRuntime(overrides = {}) {
  const binary = (command) => ({ ok: true, command, args: [], version: "7.1.1" });
  return {
    ffmpegToolchain: { ok: true, ffmpeg: binary("ffmpeg"), ffprobe: binary("ffprobe") },
    runCommand: async (_command, args = []) => {
      if (args.includes("-encoders")) return { stdout: "libx264 aac pcm_s24le", stderr: "" };
      if (args.includes("-filters")) return { stdout: "scale crop overlay fps loudnorm aresample", stderr: "" };
      if (args.includes("-show_streams")) {
        return { stdout: JSON.stringify({ streams: [{ codec_type: "video" }, { codec_type: "audio" }] }), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    pythonRuntime: { ok: true, command: "python", args: [], version: "3.12.2" },
    voiceQualityProbe: async () => true,
    // 実機の空きに左右されないよう、機械を差し替えるテストはディスクも差し替える。
    diskFreeBytes: async () => 64 * 1024 ** 3,
    ttsProbe: async () => ({ ok: true, detail: "設定あり", fix: "" }),
    imageModel: "gpt-image-2-codex",
    imageHostProbe: async (model) => ({ ok: true, host: "codex", model, detail: `Codex / ${model}` }),
    // ブラウザーの起動（1回5秒前後）を機械の差し替えで省く。実物の描画は test/svgRasterizer.test.mjs が見る。
    svgRasterizerProbe: async () => ({ ok: true, backend: "chrome", detail: "縦書き 3 字の SVG を PNG にして読み返した（fixture）", fix: "" }),
    ...overrides,
  };
}

function narratedRuntimeMetadata(payloadSha256 = "a".repeat(64)) {
  return {
    version: "buzzassist-channel-pack-runtime-v1",
    harnessId: "narrated-story-video",
    payloadSha256,
    configSha256: "b".repeat(64),
    imageModel: "image-model-v1",
    ttsProvider: "fish-audio",
    imageProvider: "buzzassist",
    imageAdapterVersion: "image-adapter-v1",
    ttsModel: "s2-pro",
    ttsAdapterVersion: "fish-audio-tts-server-v1",
    musicProvider: "elevenlabs",
    musicModel: "music_v1",
    musicAdapterVersion: "elevenlabs-music-server-v1",
  };
}

test("前提チェックは、在ることではなく動くことを見る", async () => {
  // PATH に名前があるだけで通すと、壊れた ffmpeg を「揃っている」と言う。
  const report = await runHarnessDoctor();
  const ffmpeg = report.checks.find((check) => check.id === "ffmpeg");
  assert.ok(ffmpeg, "ffmpeg のチェックがあること");
  if (ffmpeg.ok) {
    // 起動して版を答えさせた結果が入っていること（存在フラグだけではない）。
    assert.match(ffmpeg.detail, /ffmpeg \d+\.\d+/u, "実際に起動して版を取っていること");
  }
});

test("必須と任意を混ぜない", async () => {
  // 任意の欠落で止めると、canvas だけ使いたい人がセットアップできなくなる。
  const report = await runHarnessDoctor();
  const required = report.checks.filter((check) => check.required).map((check) => check.id);
  const optional = report.checks.filter((check) => !check.required).map((check) => check.id);

  // 音声品質ゲートは必須。正規入口が既定で有効にしていて、環境が無いと
  // 有償生成の手前で止まる——ready と言った直後に止まるなら ready ではない。
  for (const id of ["node", "ffmpeg", "ffprobe", "voice-quality-python", "tts-key", "image-key"]) {
    assert.ok(required.includes(id), `${id} は必須であること`);
  }
  // Channel Pack だけが任意。無くてもジャンル共通の工程は動く。
  for (const id of ["channel-pack"]) {
    assert.ok(optional.includes(id), `${id} は任意であること（無くても回せる工程がある）`);
  }
  // ready は必須だけで決まる。
  assert.equal(report.ready, report.blocking.length === 0);
  assert.deepEqual(
    report.blocking,
    report.checks.filter((check) => check.required && !check.ok).map((check) => check.id),
  );
});

test("Channel PackはHarness別に判定し、未選択時にKoya正本を強制しない", async () => {
  const emptyProject = await mkdtemp(join(tmpdir(), "harness-doctor-generic-"));
  try {
    const generic = await runHarnessDoctor({
      projectDir: emptyProject,
      runtime: deterministicDoctorRuntime(),
    });
    const genericPack = generic.checks.find((check) => check.id === "channel-pack");
    assert.equal(genericPack.required, false);
    assert.equal(genericPack.ok, true);
    assert.match(genericPack.detail, /Harness未選択/u);
  } finally {
    await rm(emptyProject, { recursive: true, force: true });
  }

  const evidence = {
    envelopeVersion: "buzzassist-channel-pack-envelope-v1",
    id: "narrated-fixture",
    version: "1.2.3",
    harnessId: "narrated-story-video",
    payloadSha256: "a".repeat(64),
    fileCount: 3,
    signerKeyId: "operator-key",
    trustedPublicKeyId: "ed25519:trusted",
  };
  const probed = [];
  const narrated = await runHarnessDoctor({
    harnessId: "narrated-story-video",
    job: {
      channelPackVerification: evidence,
      deployment: { root: "/fixture/deployment", entrypoint: "node production/internal.mjs" },
    },
    runtime: deterministicDoctorRuntime({
      channelPackRuntime: narratedRuntimeMetadata(evidence.payloadSha256),
      mediaAdapterProbe: async (spec) => {
        probed.push(spec);
        return { ok: true, status: "ready", ...spec, serverVersion: "fixture-server-v1" };
      },
      resolveProductionRoute: async () => ({
        command: "fixture-node",
        args: ["internal.mjs", "help"],
        cwd: "/fixture/deployment",
        label: "production/internal.mjs",
        mcpTool: "run_video_harness",
      }),
    }),
  });
  const narratedPack = narrated.checks.find((check) => check.id === "channel-pack");
  assert.equal(narratedPack.required, true);
  assert.equal(narratedPack.ok, true, narratedPack.detail);
  assert.match(narratedPack.detail, /署名検証/u);
  const narratedRoute = narrated.checks.find((check) => check.id === "harness-production-route");
  assert.equal(narratedRoute.ok, true, narratedRoute.detail);
  assert.match(narratedRoute.detail, /production\/internal\.mjs/u);
  assert.deepEqual(probed, [
    { kind: "image.generation", provider: "buzzassist", model: "image-model-v1", adapterVersion: "image-adapter-v1" },
    { kind: "voice.synthesis", provider: "fish-audio", model: "s2-pro", adapterVersion: "fish-audio-tts-server-v1" },
    { kind: "music.generation", provider: "elevenlabs", model: "music_v1", adapterVersion: "elevenlabs-music-server-v1" },
  ]);
  assert.equal(narrated.checks.find((check) => check.id === "image-key")?.provider, "buzzassist");
  assert.equal(narrated.checks.find((check) => check.id === "tts-key")?.provider, "fish-audio");
  assert.equal(narrated.checks.find((check) => check.id === "music-key")?.provider, "elevenlabs");

  const mismatched = await runHarnessDoctor({
    harnessId: "narrated-story-video",
    job: { channelPackVerification: { ...evidence, harnessId: "koya-manga-video" } },
    runtime: deterministicDoctorRuntime({
      channelPackRuntime: narratedRuntimeMetadata(evidence.payloadSha256),
      mediaAdapterProbe: async (spec) => ({ ok: true, status: "ready", ...spec }),
      resolveProductionRoute: async () => ({
        command: "fixture-node",
        args: ["internal.mjs", "help"],
        cwd: "/fixture/deployment",
        label: "production/internal.mjs",
        mcpTool: "run_video_harness",
      }),
    }),
  });
  const mismatchedPack = mismatched.checks.find((check) => check.id === "channel-pack");
  assert.equal(mismatchedPack.ok, false);
  assert.match(mismatchedPack.detail, /対象Harness/u);
});

test("narrated doctor fails closed before paid generation when the exact Media Job adapter is disconnected", async () => {
  const evidence = {
    envelopeVersion: "buzzassist-channel-pack-envelope-v1",
    harnessId: "narrated-story-video",
    payloadSha256: "e".repeat(64),
    fileCount: 1,
    signerKeyId: "operator-key",
    trustedPublicKeyId: "trusted-key",
  };
  let calls = 0;
  const report = await runHarnessDoctor({
    harnessId: "narrated-story-video",
    job: { channelPackVerification: evidence },
    runtime: deterministicDoctorRuntime({
      channelPackRuntime: narratedRuntimeMetadata(evidence.payloadSha256),
      mediaAdapterProbe: async (spec) => {
        calls += 1;
        return { ok: false, status: "unreachable", ...spec, detail: "fixture broker disconnected" };
      },
      resolveProductionRoute: async () => ({
        command: "fixture-node",
        args: ["internal.mjs", "help"],
        cwd: "/fixture/deployment",
        label: "production/internal.mjs",
        mcpTool: "run_video_harness",
      }),
    }),
  });
  assert.equal(calls, 3, "read-only capabilities probe must check all signed adapter identities");
  assert.equal(report.ready, false);
  assert.ok(report.blocking.includes("tts-key"));
  assert.ok(report.blocking.includes("image-key"));
  assert.ok(report.blocking.includes("music-key"));
  assert.equal(report.checks.find((check) => check.id === "tts-key")?.status, "unreachable");
  assert.equal(report.checks.find((check) => check.id === "image-key")?.status, "unreachable");
  assert.equal(report.checks.find((check) => check.id === "music-key")?.status, "unreachable");
});

test("Koya doctor requires the exact server-side dialogue adapter and never falls back to a raw ElevenLabs key", async () => {
  const route = async () => ({
    command: "fixture-node",
    args: ["koya-manga-video.mjs", "help"],
    cwd: root,
    label: "scripts/koya-manga-video.mjs",
    mcpTool: "run_video_harness",
  });
  let rawKeyProbeCalls = 0;
  const rawOnly = await runHarnessDoctor({
    projectDir: root,
    harnessId: "koya-manga-video",
    runtime: deterministicDoctorRuntime({
      env: {
        ELEVENLABS_API_KEY: "raw-key-that-must-not-count",
        BUZZASSIST_MEDIA_JOB_API_BASE: "",
      },
      ttsProbe: async () => {
        rawKeyProbeCalls += 1;
        return { ok: true, detail: "raw key exists" };
      },
      resolveProductionRoute: route,
    }),
  });
  const rawOnlyTts = rawOnly.checks.find((check) => check.id === "tts-key");
  assert.equal(rawKeyProbeCalls, 0, "Koya must not consult the legacy raw-key probe");
  assert.equal(rawOnlyTts.ok, false);
  assert.equal(rawOnlyTts.status, "route-missing");
  assert.ok(rawOnly.blocking.includes("tts-key"));
  assert.match(rawOnlyTts.fix, /voice\.dialogue/u);

  const exactSpec = {
    kind: "voice.dialogue",
    provider: "elevenlabs",
    model: "eleven_v3",
    adapterVersion: "elevenlabs-dialogue-server-v1",
  };
  const probes = [];
  const exact = await runHarnessDoctor({
    projectDir: root,
    harnessId: "koya-manga-video",
    runtime: deterministicDoctorRuntime({
      resolveProductionRoute: route,
      mediaAdapterProbe: async (spec) => {
        probes.push(spec);
        return { ok: true, status: "ready", ...spec, serverVersion: "fixture-v1" };
      },
    }),
  });
  assert.deepEqual(probes, [exactSpec]);
  const exactTts = exact.checks.find((check) => check.id === "tts-key");
  assert.equal(exactTts.ok, true, exactTts.detail);
  assert.equal(exactTts.status, "ready");
  assert.deepEqual(
    Object.fromEntries(Object.keys(exactSpec).map((key) => [key, exactTts[key]])),
    exactSpec,
  );

  const mismatched = await runHarnessDoctor({
    projectDir: root,
    harnessId: "koya-manga-video",
    runtime: deterministicDoctorRuntime({
      resolveProductionRoute: route,
      mediaAdapterProbe: async (spec) => ({ ...spec, model: "wrong-model", ok: true, status: "ready" }),
    }),
  });
  const mismatchedTts = mismatched.checks.find((check) => check.id === "tts-key");
  assert.equal(mismatchedTts.ok, false);
  assert.equal(mismatchedTts.status, "identity-mismatch");
  assert.ok(mismatched.blocking.includes("tts-key"));
});

test("narrated doctor never reports ready when only the required BGM adapter is unavailable", async () => {
  const evidence = {
    envelopeVersion: "buzzassist-channel-pack-envelope-v1",
    harnessId: "narrated-story-video",
    payloadSha256: "f".repeat(64),
    fileCount: 1,
    signerKeyId: "operator-key",
    trustedPublicKeyId: "trusted-key",
  };
  const probedKinds = [];
  const report = await runHarnessDoctor({
    harnessId: "narrated-story-video",
    job: { channelPackVerification: evidence },
    runtime: deterministicDoctorRuntime({
      channelPackRuntime: narratedRuntimeMetadata(evidence.payloadSha256),
      mediaAdapterProbe: async (spec) => {
        probedKinds.push(spec.kind);
        return spec.kind === "music.generation"
          ? { ok: false, status: "unavailable", ...spec, detail: "fixture music adapter unavailable" }
          : { ok: true, status: "ready", ...spec };
      },
      resolveProductionRoute: async () => ({
        command: "fixture-node",
        args: ["internal.mjs", "help"],
        cwd: "/fixture/deployment",
        label: "production/internal.mjs",
        mcpTool: "run_video_harness",
      }),
    }),
  });
  assert.deepEqual(probedKinds, ["image.generation", "voice.synthesis", "music.generation"]);
  assert.equal(report.checks.find((check) => check.id === "image-key")?.ok, true);
  assert.equal(report.checks.find((check) => check.id === "tts-key")?.ok, true);
  assert.equal(report.checks.find((check) => check.id === "music-key")?.ok, false);
  assert.deepEqual(report.blocking.filter((id) => ["image-key", "tts-key", "music-key"].includes(id)), ["music-key"]);
  assert.equal(report.ready, false);
});

test("足りないものには必ず直し方が付く（全部欠けた環境で確かめる）", async (t) => {
  // 「ffmpeg がありません」だけでは、非エンジニアの運営者は次に何を
  // すればいいのか分からない。分からない指摘は無いのと同じ。
  //
  // 揃っている機械で「落ちた項目だけ」を見る形にすると、その機械では
  // 何も検証しないテストになる——このセッションで繰り返し見つけた型
  // そのものなので、前提を全部外した子プロセスで実際に落として見る。
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  // HOME を実在しないパスにしていたので、子プロセスの中には
  // **リポジトリ直下からの相対として解決して生成物を落とすもの**があった
  // （nonexistent-home-for-doctor-test/Library/Caches/... が実際に出来ていた）。
  // .gitignore にも入っていないので、`git add -A` が拾いうる。
  // 検査のために作業ツリーを汚さない。
  const throwawayHome = await mkdtemp(joinPath(tmpdir(), "doctor-empty-home-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(throwawayHome, { recursive: true, force: true });
  });

  const stripped = {
    // PATH を空にすれば ffmpeg も python3 も見つからない。
    PATH: "",
    HOME: throwawayHome,
    ELEVENLABS_API_KEY: "",
    XI_API_KEY: "",
    LOVART_ACCESS_KEY: "",
    LOVART_SECRET_KEY: "",
    // Windows のホームは HOME ではなく USERPROFILE。SystemRoot が無いと
    // 子の Node が OS の機能を初期化できないことがあるので、それだけは渡す。
    ...(process.platform === "win32"
      ? { USERPROFILE: throwawayHome, SystemRoot: process.env.SystemRoot || "C:\\Windows" }
      : {}),
  };
  let stdout = "";
  try {
    ({ stdout } = await run(process.execPath, ["scripts/harness-doctor.mjs", "--json"], {
      cwd: root,
      env: stripped,
      timeout: 60_000,
    }));
  } catch (error) {
    // 必須が欠けていれば終了コードは2。出力は読める。
    stdout = String(error?.stdout || "");
    assert.equal(error.code, 2, "必須が欠けたら非0で終わること");
  }
  const report = JSON.parse(stdout);
  assert.equal(report.ready, false, "何も無い環境で ready になってはいけない");

  const failed = report.checks.filter((check) => !check.ok);
  assert.ok(failed.length >= 4, `前提を全部外したのに落ちたのが ${failed.length} 件しかない`);
  for (const check of failed) {
    assert.ok(check.fix && check.fix.length > 10, `${check.id}: 直し方が書かれていない`);
  }
  // 必須の全項目が、この環境では落ちていること。
  for (const id of ["ffmpeg", "ffprobe", "voice-quality-python", "tts-key", "image-key"]) {
    const check = report.checks.find((entry) => entry.id === id);
    assert.equal(check.ok, false, `${id} は前提の無い環境で落ちること`);
    assert.ok(check.fix.length > 10, `${id} の直し方`);
  }
});

test("秘密の値は報告に一切出ない", async () => {
  const report = await runHarnessDoctor();
  const serialized = JSON.stringify(report);
  for (const name of ["ELEVENLABS_API_KEY", "XI_API_KEY", "LOVART_ACCESS_KEY", "LOVART_SECRET_KEY"]) {
    const value = String(process.env[name] || "").trim();
    if (value.length >= 8) {
      assert.equal(serialized.includes(value), false, `${name} の値が報告に混ざっている`);
    }
  }
  // 「あるか無いか」だけが出ること。
  const tts = report.checks.find((check) => check.id === "tts-key");
  assert.match(tts.detail, /^(設定あり|未設定)/u);
});

test("TTSの秘密判定と本番画像ホストは実際の実行経路を見る", async () => {
  // doctor が独自に環境変数だけを見る形にすると、設定ファイルに保存した人へ
  // 「未設定」と言うことになる。狼少年になった検査は読まれなくなり、
  // 本当の欠落も見逃される。
  const { requireElevenLabsApiKey } = await import("../lib/speechGeneration.mjs");
  const report = await runHarnessDoctor();

  const ttsResolves = await requireElevenLabsApiKey({}).then(() => true, () => false);

  assert.equal(report.checks.find((c) => c.id === "tts-key").ok, ttsResolves, "本体の判定と一致すること");
  const image = report.checks.find((c) => c.id === "image-key");
  assert.equal(image.host, "codex", "本番モデルを実行する Codex ホストを見ること");
  assert.equal(image.model, "gpt-image-2-codex", "契約で選ばれた実モデルを報告すること");
  assert.match(image.detail, /Codex|codex/u, "無関係なプロバイダの鍵で代用しないこと");
});

test("音声QAの判定が、別の interpreter の結果を流用しない", async (t) => {
  // キャッシュが単一のブール値だったので、最初に聞いた interpreter の答えを
  // 以降の全 interpreter に返していた。動く python を1度調べた後は、
  // 存在しない python も「利用可能」になり、doctor がゲートを走らせられない
  // 環境を ready と報告した。
  //
  // 「存在しない2つ」を比べても、単一キャッシュでも答えが揃うので何も
  // 検証しない——最初に書いた版がそれで、変異を捕まえられなかった。
  // 結果の違う2つを、その順で聞く必要がある。
  const { voiceQualityAvailable, resetVoiceQualityAvailabilityCache, DEFAULT_VOICE_QA_PYTHON } =
    await import("../lib/voiceQualityGate.mjs");
  resetVoiceQualityAvailabilityCache();

  const working = await voiceQualityAvailable(DEFAULT_VOICE_QA_PYTHON);
  if (!working) {
    // 動く interpreter が無い環境では、この順序依存は再現できない。
    // 飛ばしたことを述べる——「検証した」ことにしない。
    t.skip(`音声QA環境が無いので順序依存を再現できない（${DEFAULT_VOICE_QA_PYTHON}）`);
    return;
  }
  const missing = await voiceQualityAvailable("/nonexistent/python-for-doctor-test");
  assert.equal(missing, false, "動く interpreter の答えを、存在しない interpreter に流用しないこと");
  assert.equal(
    await voiceQualityAvailable(DEFAULT_VOICE_QA_PYTHON), true,
    "逆向きにも流用しないこと",
  );
});

test("ffmpeg は版を答えるだけでなく、実際に1本作って読み返せること", async () => {
  // -version が答えるだけでは足りない。終了0で版を出すだけの stub も、
  // libx264 を欠いた最小ビルドも通ってしまう。ready と言った直後に
  // レンダーが落ちるなら、それは ready ではない。
  const report = await runHarnessDoctor();
  const capability = report.checks.find((check) => check.id === "ffmpeg-capability");
  assert.ok(capability, "機能確認のチェックがあること");
  assert.equal(capability.required, true, "本編が作れない状態を任意にしないこと");
  if (capability.ok) {
    assert.match(capability.detail, /全デコードが通った/u, "一覧の確認だけで合格にしていないこと");
  } else {
    assert.ok(capability.missing === undefined || Array.isArray(capability.missing));
    assert.ok(capability.fix.length > 10);
  }
});

test("正規入口は、宣言に書いてあるだけでなく実際に起動すること", async () => {
  // 表の値だけを根拠に「正規入口」と報告するのは、観測していない事実を
  // 合格理由にすること。存在しないコマンドへ書き換えても通っていた。
  const manga = await runHarnessDoctor({ harnessId: "koya-manga-video" });
  const route = manga.checks.find((check) => check.id === "harness-production-route");
  assert.ok(route, "配布路のチェックがあること");
  assert.equal(route.ok, true);
  assert.match(route.detail, /起動した/u, "起動を確かめたことが detail に出ること");

  // 宣言そのものが無いHarnessは通さない。
  const unregistered = await runHarnessDoctor({ harnessId: "unregistered-video" });
  const blocked = unregistered.checks.find((check) => check.id === "harness-production-route");
  assert.equal(blocked.ok, false, "正規ルーティングに載っていないハーネスを ready にしないこと");
  assert.equal(unregistered.ready, false);
});

test("自己改善が正本を書き換えたあと、配布コピーのずれを検出する", async () => {
  // harness-learn sync は正本の references/learned-auto.md を書き換えるが、
  // 配布コピーは setup を再実行するまで古いまま。すると運営者のエージェントは
  // 古い指示を読み、記録には新しい指紋が残る——記録が、実際に使われたものと
  // 別のものを指す。
  const report = await runHarnessDoctor();
  const drift = report.checks.find((check) => check.id === "shipped-skill-drift");
  assert.ok(drift, "ずれの検査があること");
  assert.equal(drift.required, false, "canvas だけ使う人を止めないこと");
  if (!drift.ok) {
    assert.match(drift.fix, /setup-agents/u, "配布し直しの手順を示すこと");
  }
});

test("任意項目の未充足を、実害と違う言い方で報告しない", async () => {
  // 「ゲートが skip になる」と一括で書くと、実際には起きないことを述べる
  // ことになる（配布コピーのずれはゲートを skip させない）。
  const report = await runHarnessDoctor();
  for (const id of report.advisory) {
    const check = report.checks.find((entry) => entry.id === id);
    assert.ok(check, `${id} の詳細があること`);
    assert.ok(check.detail && check.detail.length > 0, `${id}: 何が未充足なのかを述べること`);
  }
});

test("R6-1: doctor reports the reviewer trust anchor as a required item for a named harness and an advisory one for setup", async () => {
  const pair = generateReviewerKeyPair();
  const active = JSON.stringify({ version: "koya-reviewer-trust-v1", reviewers: [createReviewerTrustEntry({ publicKeyPem: pair.publicKeyPem, label: "doctor-fixture" })] });
  const revokedOnly = JSON.stringify({
    version: "koya-reviewer-trust-v1",
    reviewers: [{ ...createReviewerTrustEntry({ publicKeyPem: pair.publicKeyPem, label: "retired" }), status: "revoked", revokedAt: "2026-09-01T00:00:00.000Z", reason: "fixture" }],
  });
  const route = async () => ({ command: "fixture-node", args: ["koya-manga-video.mjs", "help"], cwd: root, label: "scripts/koya-manga-video.mjs", mcpTool: "run_video_harness" });
  const run = (env, harnessId = "koya-manga-video") => runHarnessDoctor({
    projectDir: root,
    harnessId,
    runtime: deterministicDoctorRuntime({ env, resolveProductionRoute: route, mediaAdapterProbe: async (spec) => ({ ok: true, status: "ready", ...spec }) }),
  });

  const missing = await run({ BUZZASSIST_MEDIA_JOB_API_BASE: "" });
  const missingCheck = missing.checks.find((check) => check.id === "reviewer-trust");
  assert.ok(missingCheck, "reviewer-trust が項目として出る");
  assert.equal(missingCheck.required, true);
  assert.equal(missingCheck.ok, false);
  assert.equal(missingCheck.code, "reviewer-trust-unconfigured");
  assert.ok(missingCheck.fix.length > 10, "直し方が付く");
  assert.match(missingCheck.fix, /BUZZASSIST_REVIEWER_TRUST/u);
  assert.ok(missing.blocking.includes("reviewer-trust"), "ハーネス指定では必須なので blocking に入る");
  assert.equal(missing.ready, false);

  const ambiguous = await run({ BUZZASSIST_REVIEWER_TRUST_JSON: active, BUZZASSIST_KOYA_REVIEWER_TRUST_JSON: revokedOnly });
  assert.equal(ambiguous.checks.find((check) => check.id === "reviewer-trust").code, "reviewer-trust-invalid:env-ambiguous:json");

  const revoked = await run({ BUZZASSIST_REVIEWER_TRUST_JSON: revokedOnly });
  const revokedCheck = revoked.checks.find((check) => check.id === "reviewer-trust");
  assert.equal(revokedCheck.ok, false);
  assert.equal(revokedCheck.code, "reviewer-trust-invalid:no-active-reviewers");
  assert.equal(revokedCheck.activeReviewers, 0);

  const configured = await run({ BUZZASSIST_REVIEWER_TRUST_JSON: active });
  const okCheck = configured.checks.find((check) => check.id === "reviewer-trust");
  assert.equal(okCheck.ok, true, okCheck.detail);
  assert.equal(okCheck.activeReviewers, 1);
  assert.match(okCheck.detail, /inline JSON/u);
  assert.doesNotMatch(JSON.stringify(okCheck), /BEGIN PUBLIC KEY/u, "鍵の中身を出さない");
  assert.ok(!configured.blocking.includes("reviewer-trust"));

  // Harness 未選択の setup: 項目は出るが任意（canvas だけ使う人を止めない）。
  const setup = await run({ BUZZASSIST_MEDIA_JOB_API_BASE: "" }, "");
  const setupCheck = setup.checks.find((check) => check.id === "reviewer-trust");
  assert.equal(setupCheck.required, false);
  assert.equal(setupCheck.ok, false);
  assert.ok(setup.advisory.includes("reviewer-trust"));
  assert.ok(!setup.blocking.includes("reviewer-trust"));
});

test("Channel Pack が複数あって指定が無いときは、doctor ごと落ちずに channel-pack の項目で知らせる", async () => {
  // 同じ端末で2つ目のチャンネルの pack を置いた日（2026-09-24）、setup の doctor が
  // 例外で止まり、空き容量も鍵も何ひとつ報告できなくなった。
  const project = await mkdtemp(join(tmpdir(), "harness-doctor-two-packs-"));
  const savedPackId = process.env.BUZZASSIST_CHANNEL_PACK_ID;
  delete process.env.BUZZASSIST_CHANNEL_PACK_ID;
  try {
    await mkdir(join(project, "channel-packs", "alpha"), { recursive: true });
    await mkdir(join(project, "channel-packs", "beta"), { recursive: true });
    for (const harnessId of ["", "koya-manga-video"]) {
      const report = await runHarnessDoctor({
        projectDir: project,
        harnessId,
        runtime: deterministicDoctorRuntime({ diskFreeBytes: async () => 40 * 1024 ** 3 }),
      });
      const pack = report.checks.find((check) => check.id === "channel-pack");
      assert.equal(pack.ok, false, `${harnessId || "setup"}: 決められないものを通さない`);
      assert.match(pack.detail, /2 個ある（alpha, beta）/u);
      assert.match(pack.fix, /BUZZASSIST_CHANNEL_PACK_ID/u);
      assert.ok(report.checks.some((check) => check.id === "disk-space"), "ほかの項目も報告される");
    }
  } finally {
    if (savedPackId === undefined) delete process.env.BUZZASSIST_CHANNEL_PACK_ID;
    else process.env.BUZZASSIST_CHANNEL_PACK_ID = savedPackId;
    await rm(project, { recursive: true, force: true });
  }
});

test("空き容量: ハーネス指定では必須、setup では任意（R6-1 と同じ扱い）", async () => {
  // 画像を200〜250枚（課金済み）作り終えたあとで書き込みに失敗すると、
  // 払った分は戻らず、Job は failed で終端になるので全額の作り直しになる。
  // 「揃っている」と言った直後に金が飛ぶなら、それは揃っていない。
  // 一方、setup を空き容量で止めると、空きを作るために要る配り直しそのものが
  // できなくなるので、Harness 未選択では任意にする。
  const route = async () => ({ command: "fixture-node", args: ["koya-manga-video.mjs", "help"], cwd: root, label: "scripts/koya-manga-video.mjs", mcpTool: "run_video_harness" });
  const run = (freeBytes, harnessId) => runHarnessDoctor({
    projectDir: root,
    harnessId,
    runtime: deterministicDoctorRuntime({
      diskFreeBytes: async () => freeBytes,
      resolveProductionRoute: route,
      mediaAdapterProbe: async (spec) => ({ ok: true, status: "ready", ...spec }),
    }),
  });

  const named = await run(3 * 1024 ** 3, "koya-manga-video");
  const namedCheck = named.checks.find((check) => check.id === "disk-space");
  assert.ok(namedCheck, "disk-space が項目として出る");
  assert.equal(namedCheck.required, true, "ハーネス指定では必須");
  assert.equal(namedCheck.ok, false, "足りないので通さない");
  assert.ok(named.blocking.includes("disk-space"), "止める側に入る");
  assert.match(namedCheck.detail, /3\.0GiB/u, "測った値をそのまま出す");
  assert.ok(namedCheck.fix.length > 10, "直し方が付く");

  const setup = await run(3 * 1024 ** 3, "");
  const setupCheck = setup.checks.find((check) => check.id === "disk-space");
  assert.equal(setupCheck.required, false, "Harness 未選択では任意");
  assert.ok(!setup.blocking.includes("disk-space"), "setup を止めない");
});

test("空き容量が足りていれば通し、測った値を報告する", async () => {
  const report = await runHarnessDoctor({
    runtime: deterministicDoctorRuntime({ diskFreeBytes: async () => 40 * 1024 ** 3 }),
  });
  const disk = report.checks.find((check) => check.id === "disk-space");
  assert.equal(disk.ok, true);
  assert.equal(disk.measured, true, "測ったことを記録すること");
  assert.match(disk.detail, /40\.0GiB/u);
  assert.ok(!report.blocking.includes("disk-space"));
});

test("空き容量を測れなかったときは、測れなかったと言う（確かめたとは言わない）", async () => {
  // 測れないことは運営者の落ち度ではないので止めない。
  // ただし「空きは足りている」と言ってしまうと、doctor が確かめていないことを
  // 確かめたと報告することになる——このリポジトリで繰り返し見つけた形。
  const report = await runHarnessDoctor({
    runtime: deterministicDoctorRuntime({
      diskFreeBytes: async () => { throw new Error("statfs unsupported"); },
    }),
  });
  const disk = report.checks.find((check) => check.id === "disk-space");
  assert.equal(disk.ok, true, "測れないだけで止めないこと");
  assert.equal(disk.measured, false, "測っていないと記録すること");
  assert.match(disk.detail, /測れなかった/u);
  assert.ok(!/空き \d/u.test(disk.detail), "測っていない値を空きとして書かないこと");
});

test("吹き出しの描画器: 漫画ハーネスでは必須で有料生成の前に止め、setup と他ジャンルでは任意", async () => {
  // 探索先が macOS だけだった頃、Windows / Linux では有料の画像と音声を作り終えたあとの
  // 吹き出し合成で止まっていた。ready と言った直後に止まるなら、それは ready ではない。
  const route = async () => ({ command: "fixture-node", args: ["koya-manga-video.mjs", "help"], cwd: root, label: "scripts/koya-manga-video.mjs", mcpTool: "run_video_harness" });
  const missing = async () => ({
    ok: false,
    code: "browser-missing",
    detail: "SVG を PNG にする描画器が無い（fixture）",
    fix: "Chromium か Google Chrome を入れる（fixture）",
  });
  const run = (harnessId, svgRasterizerProbe) => runHarnessDoctor({
    projectDir: root,
    harnessId,
    runtime: deterministicDoctorRuntime({
      svgRasterizerProbe,
      resolveProductionRoute: route,
      mediaAdapterProbe: async (spec) => ({ ok: true, status: "ready", ...spec }),
    }),
  });

  const manga = await run("koya-manga-video", missing);
  const mangaCheck = manga.checks.find((check) => check.id === "svg-rasterizer");
  assert.ok(mangaCheck, "svg-rasterizer が項目として出る");
  assert.equal(mangaCheck.required, true, "漫画ハーネスでは必須");
  assert.equal(mangaCheck.ok, false);
  assert.equal(mangaCheck.code, "browser-missing");
  assert.ok(manga.blocking.includes("svg-rasterizer"), "有料生成の前に止める側に入る");
  assert.equal(manga.ready, false);
  assert.match(mangaCheck.fix, /Chromium/u, "直し方が付く");

  const passing = await run("koya-manga-video", async () => ({ ok: true, backend: "chrome", detail: "fixture", fix: "" }));
  assert.ok(!passing.blocking.includes("svg-rasterizer"));
  assert.equal(passing.checks.find((check) => check.id === "svg-rasterizer").backend, "chrome", "どの描画器で確かめたかを残す");

  const setup = await run("", missing);
  const setupCheck = setup.checks.find((check) => check.id === "svg-rasterizer");
  assert.equal(setupCheck.required, false, "Harness 未選択の setup では任意（canvas だけ使う人を止めない）");
  assert.ok(setup.advisory.includes("svg-rasterizer"), "足りないことは知らせる");

  const narrated = await runHarnessDoctor({
    harnessId: "narrated-story-video",
    runtime: deterministicDoctorRuntime({ svgRasterizerProbe: missing }),
  });
  assert.equal(narrated.checks.find((check) => check.id === "svg-rasterizer").required, false, "吹き出しを使わないジャンルは止めない");
});

test("Windows の作業フォルダの長さ: ハーネス指定では必須。ナレーション物語は Job の run のフォルダの中まで、漫画はプロジェクトのフォルダで測る", async () => {
  // Windows では子プロセスを起動する作業フォルダが MAX_PATH を越えると spawn が ENOENT で落ちる。
  // 有料の処理を始めてから奥で落ちないよう、doctor で止める。OS は差し込む（実際の Windows は CI が見る）。
  const base = resolve(tmpdir());
  // 全体でちょうど 200 字のプロジェクトのフォルダ（作らない。長さだけを測る）。
  const projectDir = join(base, "w".repeat(200 - base.length - 1));
  const route = async () => ({ command: "fixture-node", args: ["help"], cwd: root, label: "fixture", mcpTool: "run_video_harness" });
  const run = (harnessId, platform, job = null) => runHarnessDoctor({
    projectDir,
    harnessId,
    job,
    runtime: deterministicDoctorRuntime({
      platform,
      resolveProductionRoute: route,
      mediaAdapterProbe: async (spec) => ({ ok: true, status: "ready", ...spec }),
    }),
  });
  const workPath = (report) => report.checks.find((check) => check.id === "windows-work-path");

  // ナレーション物語: プロジェクトのフォルダ（200 字）は収まっても、字幕の頁の作業フォルダは 289 字。
  const narrated = await run("narrated-story-video", "win32", { id: "video-narrated-story-video-0123456789abcdef", projectDir });
  assert.equal(workPath(narrated).required, true);
  assert.equal(workPath(narrated).ok, false);
  assert.equal(workPath(narrated).code, "windows-work-path-too-long");
  assert.ok(narrated.blocking.includes("windows-work-path"), "有料の処理の前に止める側に入る");
  assert.match(workPath(narrated).detail, /字幕の頁の作業フォルダが 289 字/u);
  assert.match(workPath(narrated).fix, /短い場所/u, "直し方が付く");
  assert.ok(!workPath(narrated).detail.includes(projectDir) && !workPath(narrated).fix.includes(projectDir), "path は出さない");
  // Job がまだ無い（setup・plan-request）ときも、同じ長さの仮の Job の id で見積もる。
  assert.equal(workPath(await run("narrated-story-video", "win32")).ok, false);

  // 漫画: 子はプロジェクトのフォルダで起動するので、200 字なら収まる。
  const manga = await run("koya-manga-video", "win32");
  assert.equal(workPath(manga).required, true);
  assert.equal(workPath(manga).ok, true, workPath(manga).detail);
  assert.ok(!manga.blocking.includes("windows-work-path"));

  // Windows 以外は見ない。Harness 未選択の setup では任意。
  const posix = await run("narrated-story-video", "linux", { id: "video-narrated-story-video-0123456789abcdef", projectDir });
  assert.equal(workPath(posix).ok, true);
  assert.ok(!posix.blocking.includes("windows-work-path"));
  const setup = await run("", "win32");
  assert.equal(workPath(setup).required, false);
});
