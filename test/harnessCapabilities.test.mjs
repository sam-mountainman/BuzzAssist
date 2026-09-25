import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  capabilityCardPath,
  checkHarnessInputs,
  detectScriptInputFormat,
  harnessCapabilityView,
  HARNESS_CAPABILITIES_SCHEMA,
  loadHarnessCapabilityCard,
  summarizePrerequisites,
  validateHarnessCapabilityCard,
} from "../lib/harnessCapabilities.mjs";
import { KOYA_REQUIRED_JOB_OPTIONS } from "../lib/videoHarnessAdapters.mjs";
import { runHarnessDoctor } from "../scripts/harness-doctor.mjs";
import { CLIENT_IDENTIFIERS, loadHarnesses } from "../scripts/harness-registry.mjs";

// 能力カード: ハーネスを選ぶ側が読む「何を受け取り、何を出し、何に向くか」。
// 宣言（*.harness.json）の SHA は Job の識別子と RunReceipt に入るので、カードは別ファイルに置く。
// 保証と素材は宣言から自動で作り、実績は記録から読む（カードに書かせない）。

const root = fileURLToPath(new URL("..", import.meta.url));
const harnesses = loadHarnesses();

function minimalCard(overrides = {}) {
  return {
    schema: HARNESS_CAPABILITIES_SCHEMA,
    harnessId: "fixture-video",
    inputs: {
      scriptFormats: [{ id: "raw-text", what: "生テキストの台本" }],
      startOptions: [],
    },
    outputs: [{ id: "video", what: "完成 MP4" }],
    suitedFor: ["試験用の依頼"],
    notSuitedFor: ["試験で扱わない依頼"],
    estimates: {
      cost: { status: "unknown", reason: "記録が無い" },
      duration: { status: "unknown", reason: "記録が無い" },
    },
    prerequisites: [{ doctorCheckId: "node", checkedAt: "before-job", what: "Node 20 以上" }],
    ...overrides,
  };
}

const fixtureHarness = {
  id: "fixture-video",
  version: "1.0.0",
  displayName: "試験用ハーネス",
  status: "in-production",
  produces: { kind: "fixture-video", description: "試験用" },
  requiresFromOperator: [{ id: "script", what: "台本", blocking: true }],
  guarantees: [{ id: "g1", what: "何かを保証する", evidenceAuditIds: ["a1"] }],
};

test("宣言されたハーネスには、全部に検査を通る能力カードがある", async () => {
  assert.ok(harnesses.length >= 2, "宣言が読めていること");
  for (const harness of harnesses) {
    const loaded = await loadHarnessCapabilityCard(harness);
    assert.equal(loaded.status, "ok", `${harness.id}: ${loaded.errors.join(" / ")}`);
    assert.equal(loaded.card.harnessId, harness.id);
    assert.equal(loaded.path, join("config", "harnesses", `${harness.id}.capabilities.json`));
  }
});

test("能力カードは宣言の外に置き、宣言の読み込みにも Job の識別子にも混ざらない", async () => {
  const dir = join(root, "config", "harnesses");
  const names = await readdir(dir);
  const declarations = names.filter((name) => name.endsWith(".harness.json"));
  const cards = names.filter((name) => name.endsWith(".capabilities.json"));
  assert.equal(harnesses.length, declarations.length, "カードをハーネス宣言として読まない");
  assert.equal(cards.length, declarations.length, "宣言1つにカード1枚");
  for (const file of declarations) {
    const declaration = JSON.parse(await readFile(join(dir, file), "utf8"));
    for (const key of ["capabilities", "suitedFor", "notSuitedFor", "estimates", "prerequisites"]) {
      assert.equal(declaration[key], undefined, `${file}: ${key} は宣言ではなく能力カードに書く（宣言の SHA は Job の識別子に入る）`);
    }
  }
  assert.equal(capabilityCardPath("x", "/cards"), join("/cards", "x.capabilities.json"));
});

test("能力カードの形が違えば読み込まない", () => {
  assert.deepEqual(validateHarnessCapabilityCard(minimalCard(), fixtureHarness), []);
  const cases = [
    [{ schema: "other" }, /schema/u],
    [{ harnessId: "another-video" }, /宣言と違う/u],
    [{ guarantees: [{ id: "g1" }] }, /guarantees から自動で作る/u],
    [{ requiresFromOperator: [] }, /requiresFromOperator から自動で作る/u],
    [{ keywords: ["漫画"] }, /宣言に置く/u],
    [{ unknownField: 1 }, /知らない項目 unknownField/u],
    [{ inputs: { scriptFormats: [], startOptions: [] } }, /scriptFormats が要る/u],
    [{ inputs: { scriptFormats: [{ id: "docx", what: "x" }], startOptions: [] } }, /raw-text \/ markdown \/ script-package/u],
    [{ inputs: { scriptFormats: [{ id: "script-package", what: "x" }], startOptions: [] } }, /packageFormat が要る/u],
    [{ inputs: { scriptFormats: [{ id: "raw-text", what: "x" }], startOptions: [{ key: "Bad Key", cliFlag: "episode", what: "x" }] } }, /camelCase/u],
    [{ suitedFor: [] }, /suitedFor は 1〜8 件/u],
    [{ notSuitedFor: ["あ".repeat(81)] }, /長すぎる/u],
    [{ estimates: { cost: { status: "unknown" }, duration: { status: "unknown", reason: "x" } } }, /estimates\.cost\.reason/u],
    [{ estimates: { cost: { status: "estimate", value: "1000円" }, duration: { status: "unknown", reason: "x" } } }, /basis が要る/u],
    [{ estimates: undefined }, /estimates が要る/u],
    [{ prerequisites: [{ doctorCheckId: "node", checkedAt: "someday", what: "x" }] }, /before-job \/ job-prepare/u],
    [{ prerequisites: [] }, /prerequisites が要る/u],
  ];
  for (const [override, pattern] of cases) {
    const errors = validateHarnessCapabilityCard(minimalCard(override), fixtureHarness);
    assert.ok(errors.some((error) => pattern.test(error)), `${JSON.stringify(override)} → ${errors.join(" / ")}`);
  }
});

test("実績はカードに書かせない（どの深さでも拒否する）", () => {
  for (const override of [
    { passRate: 0.9 },
    { trackRecord: { runs: 3 } },
    { outputs: [{ id: "video", what: "MP4", worstGates: ["final-audit"] }] },
    { estimates: { cost: { status: "unknown", reason: "x", runs: 2 }, duration: { status: "unknown", reason: "x" } } },
  ]) {
    const errors = validateHarnessCapabilityCard(minimalCard(override), fixtureHarness);
    assert.ok(errors.some((error) => /実績はカードに書かない/u.test(error)), `${JSON.stringify(override)} → ${errors.join(" / ")}`);
  }
});

test("能力カードにクライアントを特定できる語を入れられない", () => {
  for (const banned of CLIENT_IDENTIFIERS) {
    const errors = validateHarnessCapabilityCard(minimalCard({ suitedFor: [`${banned}の依頼`] }), fixtureHarness);
    assert.ok(errors.some((error) => /クライアントを特定/u.test(error)), `${banned} が素通りした`);
  }
});

test("保証と運営者の素材は宣言から自動で作る（カードに二重に書かない）", async () => {
  for (const harness of harnesses) {
    const view = harnessCapabilityView(harness, await loadHarnessCapabilityCard(harness));
    assert.deepEqual(view.guarantees.map((entry) => entry.id), harness.guarantees.map((entry) => entry.id));
    for (const guarantee of harness.guarantees) {
      const shown = view.guarantees.find((entry) => entry.id === guarantee.id);
      assert.equal(shown.what, guarantee.what);
      assert.equal(shown.inForceSince, guarantee.inForceSince, `${harness.id}/${guarantee.id}: inForceSince を落とさない`);
    }
    assert.deepEqual(view.inputs.materials.map((entry) => entry.id), harness.requiresFromOperator.map((entry) => entry.id));
    assert.equal(view.entrypoint.cli, `node scripts/run-video-harness.mjs start --harness ${harness.id}`);
    assert.equal(view.entrypoint.mcpTool, "run_video_harness");
    assert.equal(view.card.status, "ok");
  }
  const noCard = harnessCapabilityView(fixtureHarness);
  assert.equal(noCard.card.status, "missing");
  assert.equal(noCard.estimates.cost.status, "unknown", "カードが無くても費用を推測しない");
  assert.deepEqual(noCard.guarantees.map((entry) => entry.id), ["g1"], "宣言から作れる部分は返す");
});

test("Koya のカードの start 引数は、Job を作る前に止める表（KOYA_REQUIRED_JOB_OPTIONS）と同じ", async () => {
  const koya = harnesses.find((harness) => harness.id === "koya-manga-video");
  const { card } = await loadHarnessCapabilityCard(koya);
  assert.deepEqual(
    card.inputs.startOptions.map(({ key, cliFlag }) => ({ key, cliFlag })),
    KOYA_REQUIRED_JOB_OPTIONS.map(({ key, cliFlag }) => ({ key, cliFlag })),
  );
  // ナレーション物語の start 引数は Pack の宣言しだいで要るものだけ（条件つき）。CLI と同じ名前であること。
  const narrated = harnesses.find((harness) => harness.id === "narrated-story-video");
  const narratedOptions = (await loadHarnessCapabilityCard(narrated)).card.inputs.startOptions;
  assert.ok(narratedOptions.every((entry) => typeof entry.requiredWhen === "string" && entry.requiredWhen.length > 0));
  assert.deepEqual(narratedOptions.map(({ key, cliFlag }) => ({ key, cliFlag })), [
    { key: "operatorImageManifestPath", cliFlag: "--operator-image-manifest" },
    { key: "operatorVideoManifestPath", cliFlag: "--operator-video-manifest" },
  ]);
  const cli = await readFile(join(root, "scripts", "run-video-harness.mjs"), "utf8");
  for (const entry of [...card.inputs.startOptions, ...narratedOptions]) {
    assert.ok(cli.includes(entry.cliFlag.slice(2)), `${entry.cliFlag} が run-video-harness に無い`);
    assert.ok(cli.includes(`"${entry.key}"`), `${entry.key} が run-video-harness の options に無い`);
  }
});

test("条件つきの start 引数は、足りなくても blockers にせず条件として見せる", async () => {
  const narrated = harnesses.find((harness) => harness.id === "narrated-story-video");
  const view = harnessCapabilityView(narrated, await loadHarnessCapabilityCard(narrated));
  const pack = { provided: true, status: "readable", targetHarnessId: "narrated-story-video", knownHarness: true, signature: "verified" };
  const script = { provided: true, status: "readable", format: "raw-text" };
  const without = checkHarnessInputs(view, { script, channelPack: pack });
  assert.equal(without.status, "ok");
  assert.deepEqual(without.startOptions.required, []);
  assert.deepEqual(without.startOptions.conditional.map((entry) => [entry.key, entry.provided]), [
    ["operatorImageManifestPath", false],
    ["operatorVideoManifestPath", false],
  ]);
  const withManifest = checkHarnessInputs(view, { script, channelPack: pack, options: { operatorImageManifestPath: "/fixture/manifest.json" } });
  assert.equal(withManifest.startOptions.conditional[0].provided, true);
  const bad = minimalCard({ inputs: { scriptFormats: [{ id: "raw-text", what: "x" }], startOptions: [{ key: "x", cliFlag: "--x", what: "x", requiredWhen: " " }] } });
  assert.ok(validateHarnessCapabilityCard(bad, fixtureHarness).some((error) => /requiredWhen/u.test(error)));
});

function deterministicDoctorRuntime(homeDir) {
  const binary = (command) => ({ ok: true, command, args: [], version: "7.1.1" });
  return {
    env: {},
    homeDir,
    ffmpegToolchain: { ok: true, ffmpeg: binary("ffmpeg"), ffprobe: binary("ffprobe") },
    runCommand: async () => ({ stdout: "", stderr: "" }),
    pythonRuntime: { ok: true, command: "python", args: [], version: "3.12.2" },
    voiceQualityProbe: async () => true,
    diskFreeBytes: async () => 64 * 1024 ** 3,
    ttsProbe: async () => ({ ok: true, detail: "fixture", fix: "" }),
    imageModel: "gpt-image-2-codex",
    imageHostProbe: async (model) => ({ ok: true, host: "codex", model, detail: "fixture" }),
    svgRasterizerProbe: async () => ({ ok: true, backend: "chrome", detail: "fixture", fix: "" }),
    resolveProductionRoute: async () => ({ command: process.execPath, args: ["-e", ""], cwd: root, label: "fixture", mcpTool: "run_video_harness" }),
    mediaAdapterProbe: async (spec) => ({ ok: true, status: "ready", ...spec }),
    reviewerTrustProbe: async () => ({ ok: false, code: "reviewer-trust-unconfigured" }),
  };
}

test("カードの前提は、doctor がそのハーネスで必須にする項目と一致する（片方だけ直ると選ぶ側が誤る）", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "capabilities-doctor-home-"));
  const projectDir = await mkdtemp(join(tmpdir(), "capabilities-doctor-project-"));
  try {
    for (const harness of harnesses) {
      const { card } = await loadHarnessCapabilityCard(harness);
      const report = await runHarnessDoctor({ projectDir, harnessId: harness.id, runtime: deterministicDoctorRuntime(homeDir) });
      const doctorIds = new Set(report.checks.map((check) => check.id));
      const doctorRequired = report.checks.filter((check) => check.required && check.id !== "host-skill-sync").map((check) => check.id).sort();
      const cardRequired = card.prerequisites.filter((entry) => entry.conditional !== true).map((entry) => entry.doctorCheckId).sort();
      assert.deepEqual(cardRequired, doctorRequired, `${harness.id}: カードの前提と doctor の必須項目がずれた`);
      for (const entry of card.prerequisites) {
        assert.ok(doctorIds.has(entry.doctorCheckId), `${harness.id}: doctor に無い項目 ${entry.doctorCheckId}`);
      }
    }
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("doctor の結果の要約: Job の prepare で決まる項目は「足りない」と数えない", async () => {
  const narrated = harnesses.find((harness) => harness.id === "narrated-story-video");
  const view = harnessCapabilityView(narrated, await loadHarnessCapabilityCard(narrated));
  assert.equal(summarizePrerequisites(view).status, "not-checked");
  assert.ok(summarizePrerequisites(view).required.includes("voice-quality-python"));
  assert.deepEqual(summarizePrerequisites(view).conditional, ["host-skill-sync"]);
  const report = {
    blocking: ["ffmpeg", "tts-key", "channel-pack"],
    checks: [
      { id: "ffmpeg", required: true, ok: false, detail: "起動できない", fix: "ffmpeg を入れる" },
      { id: "tts-key", required: true, ok: false, detail: "Pack が無い", fix: "" },
      { id: "channel-pack", required: true, ok: false, detail: "evidence が無い", fix: "" },
    ],
  };
  const summary = summarizePrerequisites(view, report);
  assert.equal(summary.status, "missing");
  assert.deepEqual(summary.missing.map((entry) => entry.id), ["ffmpeg"]);
  assert.equal(summary.missing[0].fix, "ffmpeg を入れる");
  assert.deepEqual(summary.checkedAtJobPrepare, ["tts-key", "channel-pack"]);
  const ready = summarizePrerequisites(view, { blocking: ["channel-pack"], checks: [] });
  assert.equal(ready.status, "ready");
  assert.match(ready.detail, /prepare で確かめる/u);
});

test("台本の形式はジャンルに依らない形だけで見分ける", () => {
  assert.deepEqual(detectScriptInputFormat({ text: "昔あるところに。\n", filePath: "a.txt" }), { format: "raw-text", packageFormat: null });
  assert.deepEqual(detectScriptInputFormat({ text: "# 題\n本文", filePath: "a.txt" }), { format: "markdown", packageFormat: null });
  assert.deepEqual(detectScriptInputFormat({ text: "本文", filePath: "script.md" }), { format: "markdown", packageFormat: null });
  assert.deepEqual(
    detectScriptInputFormat({ text: JSON.stringify({ format: "fixture-package-v1" }), filePath: "script-package.json" }),
    { format: "script-package", packageFormat: "fixture-package-v1" },
  );
  assert.deepEqual(detectScriptInputFormat({ text: "{\"story\": []}", filePath: "x.json" }), { format: "json-unknown", packageFormat: null });
  assert.deepEqual(detectScriptInputFormat({ text: "{ 壊れた", filePath: "x.txt" }), { format: "json-unknown", packageFormat: null });
});

test("入力の照合: 台本の形式・start 引数・Channel Pack の向き先", async () => {
  const koya = harnesses.find((harness) => harness.id === "koya-manga-video");
  const view = harnessCapabilityView(koya, await loadHarnessCapabilityCard(koya));
  const pack = { provided: true, status: "readable", targetHarnessId: "koya-manga-video", knownHarness: true, signature: "verified" };
  const options = Object.fromEntries(KOYA_REQUIRED_JOB_OPTIONS.map((entry) => [entry.key, "fixture"]));
  const ok = checkHarnessInputs(view, { script: { provided: true, status: "readable", format: "raw-text" }, options, channelPack: pack });
  assert.equal(ok.status, "ok", JSON.stringify(ok.blockers));

  const packageScript = checkHarnessInputs(view, {
    script: { provided: true, status: "readable", format: "script-package", packageFormat: "buzzassist-narrated-script-package-v1" },
    options,
    channelPack: pack,
  });
  assert.deepEqual(packageScript.blockers.map((entry) => entry.code), ["script-format-not-accepted"]);

  const bare = checkHarnessInputs(view);
  assert.deepEqual(bare.blockers.map((entry) => entry.code), ["script-missing", "start-options-missing", "channel-pack-missing"]);
  assert.deepEqual(bare.startOptions.missing, KOYA_REQUIRED_JOB_OPTIONS.map((entry) => entry.key));

  const otherPack = checkHarnessInputs(view, {
    script: { provided: true, status: "readable", format: "raw-text" },
    options,
    channelPack: { ...pack, targetHarnessId: "narrated-story-video" },
  });
  assert.deepEqual(otherPack.blockers.map((entry) => entry.code), ["channel-pack-other-harness"]);
  assert.match(otherPack.channelPack.detail, /narrated-story-video 向け/u);
});
