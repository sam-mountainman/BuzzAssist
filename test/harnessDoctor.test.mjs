import assert from "node:assert/strict";
import test from "node:test";

import { runHarnessDoctor } from "../scripts/harness-doctor.mjs";

const root = new URL("..", import.meta.url).pathname;

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

test("足りないものには必ず直し方が付く（全部欠けた環境で確かめる）", async () => {
  // 「ffmpeg がありません」だけでは、非エンジニアの運営者は次に何を
  // すればいいのか分からない。分からない指摘は無いのと同じ。
  //
  // 揃っている機械で「落ちた項目だけ」を見る形にすると、その機械では
  // 何も検証しないテストになる——このセッションで繰り返し見つけた型
  // そのものなので、前提を全部外した子プロセスで実際に落として見る。
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  const stripped = {
    // PATH を空にすれば ffmpeg も python3 も見つからない。
    PATH: "",
    HOME: "/nonexistent-home-for-doctor-test",
    ELEVENLABS_API_KEY: "",
    XI_API_KEY: "",
    LOVART_ACCESS_KEY: "",
    LOVART_SECRET_KEY: "",
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

test("秘密の判定は本体と同じ解決関数に聞く", async () => {
  // doctor が独自に環境変数だけを見る形にすると、設定ファイルに保存した人へ
  // 「未設定」と言うことになる。狼少年になった検査は読まれなくなり、
  // 本当の欠落も見逃される。
  const { requireElevenLabsApiKey } = await import("../lib/speechGeneration.mjs");
  const { resolveLovartCredentials } = await import("../lib/lovartMediaGeneration.mjs");
  const report = await runHarnessDoctor();

  const ttsResolves = await requireElevenLabsApiKey({}).then(() => true, () => false);
  const imageResolves = await resolveLovartCredentials().then(() => true, () => false);

  assert.equal(report.checks.find((c) => c.id === "tts-key").ok, ttsResolves, "本体の判定と一致すること");
  assert.equal(report.checks.find((c) => c.id === "image-key").ok, imageResolves, "本体の判定と一致すること");
});
