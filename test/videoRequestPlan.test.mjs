import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { createChannelPackEnvelope } from "../lib/channelPackEnvelope.mjs";
import { SKILL_EVAL_RECORD_SCHEMA } from "../lib/skillEvals.mjs";
import { KOYA_REQUIRED_JOB_OPTIONS } from "../lib/videoHarnessAdapters.mjs";
import { selectVideoHarness } from "../lib/videoHarnessJob.mjs";
import { TOOL_PLAN_VIDEO_REQUEST } from "../lib/videoHarnessMcp.mjs";
import { planVideoRequest, VIDEO_REQUEST_MISSING_CODE } from "../lib/videoRequestPlan.mjs";
import { loadHarnesses } from "../scripts/harness-registry.mjs";

// plan-request: 依頼文からハーネスの候補・理由・1問を返す。判断はホストの LLM がする。
// モデルも有料 API も呼ばず、Job も作らない。start の選択と同じ判定を使う。

const execFile = promisify(execFileCallback);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const harnesses = loadHarnesses();
const versionOf = (id) => harnesses.find((harness) => harness.id === id).version;
const KOYA_OPTIONS = Object.freeze(Object.fromEntries(KOYA_REQUIRED_JOB_OPTIONS.map((entry) => [entry.key, `fixture-${entry.key}`])));
// 試験の台本・Pack の中身は合成。出力に写っていないことを確かめるための目印を入れる。
const SCRIPT_MARKER = "合成台本マーカー七三一";
const PACK_ID = "synthetic-pack-marker";
const PACK_FILE = "synthetic-payload-marker.json";

function keyPair() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }),
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "video-request-plan-"));
  const projectDir = join(root, "project");
  const receiptsDir = join(root, "receipts");
  const evalsDir = join(root, "evals");
  await mkdir(projectDir, { recursive: true });
  await mkdir(receiptsDir, { recursive: true });
  await mkdir(evalsDir, { recursive: true });
  const key = keyPair();
  const packs = {};
  for (const harnessId of ["narrated-story-video", "koya-manga-video"]) {
    const source = join(root, `pack-source-${harnessId}`);
    await mkdir(source, { recursive: true });
    await writeFile(join(source, PACK_FILE), `${JSON.stringify({ fixture: true })}\n`);
    packs[harnessId] = join(root, `pack-${harnessId}`);
    await createChannelPackEnvelope({
      sourceDir: source,
      outputDir: packs[harnessId],
      id: PACK_ID,
      version: "1.0.0",
      harnessId,
      privateKeyPem: key.privateKeyPem,
      publicKeyPem: key.publicKeyPem,
      createdAt: "2026-09-25T00:00:00.000Z",
    });
  }
  const scripts = {
    raw: join(root, "story.txt"),
    markdown: join(root, "script.md"),
    manga: join(root, "manga.txt"),
    narratedPackage: join(root, "script-package.json"),
    unknownPackage: join(root, "other-package.json"),
    empty: join(root, "empty.txt"),
  };
  await writeFile(scripts.raw, `${SCRIPT_MARKER}。ある日、合成の人物が歩いていた。\n`);
  await writeFile(scripts.markdown, `# 本編\n${SCRIPT_MARKER}。\n`);
  await writeFile(scripts.manga, `【カット 1：導入】\n合成A：${SCRIPT_MARKER}！\n`);
  await writeFile(scripts.narratedPackage, JSON.stringify({ format: "buzzassist-narrated-script-package-v1", story: [{ id: "s1", text: SCRIPT_MARKER }] }));
  await writeFile(scripts.unknownPackage, JSON.stringify({ format: "someone-elses-package-v9" }));
  await writeFile(scripts.empty, "");
  const env = { BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY_PEM: key.publicKeyPem };
  return {
    root,
    projectDir,
    receiptsDir,
    evalsDir,
    packs,
    scripts,
    env,
    base: { projectDir, env, receiptsDir, skillEvalsDir: evalsDir },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

let fixture;
test.before(async () => { fixture = await createFixture(); });
test.after(async () => { await fixture?.cleanup(); });

function plan(overrides = {}) {
  return planVideoRequest({ ...fixture.base, ...overrides });
}

function candidate(result, harnessId) {
  return result.candidates.find((entry) => entry.harnessId === harnessId);
}

test("ナレーション物語の典型の依頼: 決まり、台本・Pack が揃えば始められる", async () => {
  const result = await plan({
    request: "感動する実話の朗読動画を作りたい",
    scriptPath: fixture.scripts.markdown,
    channelPackPath: fixture.packs["narrated-story-video"],
  });
  assert.equal(result.decision.status, "selected");
  assert.equal(result.decision.harnessId, "narrated-story-video");
  assert.equal(result.decision.startable, true, JSON.stringify(result.decision.blockers));
  assert.equal(result.question, null);
  const chosen = candidate(result, "narrated-story-video");
  assert.equal(chosen.rank, 1);
  assert.deepEqual(chosen.matchedTerms, ["朗読", "実話", "感動"]);
  assert.equal(chosen.inputs.script.status, "ok");
  assert.equal(chosen.inputs.channelPack.status, "ok");
  assert.equal(chosen.channelPackTarget, true);
  assert.ok(chosen.reasons.some((line) => /この Channel Pack は narrated-story-video 向け（署名確認済み）/u.test(line)), chosen.reasons.join("\n"));
  assert.ok(chosen.capability.suitedFor.length > 0 && chosen.capability.notSuitedFor.length > 0);
  assert.equal(chosen.capability.estimates.cost.status, "unknown");
  assert.equal(result.nextStep.action, "start-plan-only");
  assert.match(result.nextStep.cli, /run-video-harness\.mjs start --harness narrated-story-video --script-path /u);
  assert.equal(result.nextStep.mcp.tool, "run_video_harness");
  assert.equal(result.nextStep.mcp.arguments.harnessId, "narrated-story-video");
  assert.equal(result.input.script.format, "markdown");
  assert.equal(result.input.channelPack.signature, "verified");
});

test("漫画の典型の依頼: 決まり、start で要る引数が揃うまでは始められないと言う", async () => {
  const request = "スカッとする漫画を作る";
  const withoutOptions = await plan({ request, scriptPath: fixture.scripts.manga, channelPackPath: fixture.packs["koya-manga-video"] });
  assert.equal(withoutOptions.decision.status, "selected");
  assert.equal(withoutOptions.decision.harnessId, "koya-manga-video");
  assert.equal(withoutOptions.decision.startable, false);
  const blocker = withoutOptions.decision.blockers.find((entry) => entry.code === "start-options-missing");
  assert.ok(blocker, JSON.stringify(withoutOptions.decision.blockers));
  assert.deepEqual(blocker.missing.map((entry) => entry.key), KOYA_REQUIRED_JOB_OPTIONS.map((entry) => entry.key));
  assert.equal(withoutOptions.nextStep.action, "resolve-blockers");
  assert.match(withoutOptions.nextStep.cli, /--episode-id </u);

  const withOptions = await plan({ request, scriptPath: fixture.scripts.manga, channelPackPath: fixture.packs["koya-manga-video"], options: KOYA_OPTIONS });
  assert.equal(withOptions.decision.startable, true, JSON.stringify(withOptions.decision.blockers));
  assert.deepEqual(candidate(withOptions, "koya-manga-video").matchedTerms, ["漫画", "スカッと"]);
  assert.equal(withOptions.nextStep.mcp.arguments.options.episodeId, KOYA_OPTIONS.episodeId);
});

test("否定の節の語は減点し、否定しか残らない依頼は1問にする", async () => {
  const result = await plan({ request: "漫画、固定キャスト、吹き出しは使わず、朗読動画にしたい" });
  assert.equal(result.decision.status, "choice-required");
  assert.equal(result.decision.harnessId, null);
  assert.equal(result.question.id, "harness-choice");
  assert.deepEqual(result.question.options.map((option) => option.value).sort(), ["koya-manga-video", "narrated-story-video"]);
  assert.ok(result.question.options.length >= 2 && result.question.options.length <= 3, "選択肢は2〜3個");
  assert.ok(result.question.options.every((option) => !/その他|Other/u.test(option.label)), "その他は足さない（ホストの UI が持つ）");
  assert.deepEqual(candidate(result, "koya-manga-video").negatedTerms, ["吹き出し"]);
  assert.equal(result.nextStep.action, "ask");
});

test("対比（〜ではなく、not / without）の前の語で選ばず、減点した候補も理由つきで並べる", async () => {
  for (const request of ["漫画ではなく朗読の動画にしたい", "Not manga. 朗読の動画にしたい", "朗読の動画、without manga"]) {
    const result = await plan({ request });
    assert.equal(result.decision.harnessId, "narrated-story-video", request);
    const manga = candidate(result, "koya-manga-video");
    assert.ok(manga, `${request}: 減点した候補も並べる`);
    assert.equal(manga.rank, 2);
    assert.ok(manga.negatedTerms.length > 0);
    assert.ok(manga.reasons.some((line) => /否定の節で減点した語/u.test(line)));
  }
  const reversed = await plan({ request: "朗読ではなく、漫画で作りたい" });
  assert.equal(reversed.decision.harnessId, "koya-manga-video");
});

test("両方に言及して差が小さいときは決めず、差が大きければ決める", async () => {
  for (const request of ["漫画の朗読動画にしたい", "漫画と朗読の両方の良さを持つ動画にしたい"]) {
    const result = await plan({ request });
    assert.equal(result.decision.status, "choice-required", request);
    assert.equal(result.question.options.length, 2);
    assert.ok(result.question.options.every((option) => option.recommended === false), "根拠が無いのに推奨を付けない");
  }
  const decisive = await plan({ request: "漫画のキャラと吹き出しで、ナレーションも入れたい" });
  assert.equal(decisive.decision.harnessId, "koya-manga-video");
  assert.deepEqual(decisive.candidates.map((entry) => entry.harnessId), ["koya-manga-video", "narrated-story-video"]);
});

test("plan-request の判定は start の選択（selectVideoHarness）と食い違わない", async () => {
  for (const request of [
    "漫画の動画が作りたい",
    "ナレーション付きの物語動画",
    "昔ばなしの朗読",
    "漫画は使わない",
    "料理のレシピを書いて",
    "漫画の朗読動画にしたい",
    "吹き出しなしで朗読の動画を作りたい",
  ]) {
    const result = await plan({ request });
    let selected = null;
    try {
      selected = selectVideoHarness({ harnesses, want: request }).harness.id;
    } catch {
      selected = null;
    }
    assert.equal(result.decision.harnessId, selected, request);
    assert.equal(result.decision.status === "selected", selected !== null, request);
  }
});

test("入力要件を満たさない依頼: 台本が無い・空・受け取れない形式", async () => {
  const noScript = await plan({ request: "感動する実話の朗読動画", channelPackPath: fixture.packs["narrated-story-video"] });
  assert.equal(noScript.decision.harnessId, "narrated-story-video");
  assert.equal(noScript.decision.startable, false);
  assert.deepEqual(noScript.decision.blockers.map((entry) => entry.code), ["script-missing"]);
  assert.equal(noScript.input.script.provided, false);
  assert.match(noScript.nextStep.cli, /--script-path <台本のファイル>/u);

  const empty = await plan({ request: "感動する実話の朗読動画", scriptPath: fixture.scripts.empty, channelPackPath: fixture.packs["narrated-story-video"] });
  assert.deepEqual(empty.decision.blockers.map((entry) => entry.code), ["script-unreadable"]);
  assert.equal(empty.input.script.status, "empty");

  const missingFile = await plan({ request: "感動する実話の朗読動画", scriptPath: join(fixture.root, "nope.txt"), channelPackPath: fixture.packs["narrated-story-video"] });
  assert.deepEqual(missingFile.decision.blockers.map((entry) => entry.code), ["script-unreadable"]);

  // 漫画ハーネスは台本パッケージを受け取ると宣言していない。
  const packageForManga = await plan({
    request: "スカッとする漫画を作る",
    scriptPath: fixture.scripts.narratedPackage,
    channelPackPath: fixture.packs["koya-manga-video"],
    options: KOYA_OPTIONS,
  });
  assert.deepEqual(packageForManga.decision.blockers.map((entry) => entry.code), ["script-format-not-accepted"]);
  assert.match(candidate(packageForManga, "koya-manga-video").inputs.script.detail, /受け取れる形式: 生テキスト・Markdown/u);

  // ナレーション物語は自分の台本パッケージだけを受け取る。
  const narratedPackage = await plan({ request: "朗読の動画", scriptPath: fixture.scripts.narratedPackage, channelPackPath: fixture.packs["narrated-story-video"] });
  assert.equal(narratedPackage.decision.startable, true, JSON.stringify(narratedPackage.decision.blockers));
  const otherPackage = await plan({ request: "朗読の動画", scriptPath: fixture.scripts.unknownPackage, channelPackPath: fixture.packs["narrated-story-video"] });
  assert.deepEqual(otherPackage.decision.blockers.map((entry) => entry.code), ["script-format-not-accepted"]);
});

async function writeReceipt(dir, name, { harnessId, version, outcome, gates }) {
  await writeFile(join(dir, name), JSON.stringify({
    finalized: true,
    harnessBuild: { harness: { id: harnessId, version, declarationDigest: "a".repeat(64) } },
    outcome,
    outcomeOverridden: false,
    gates,
  }));
}

test("実績は記録から読む: 無ければ「実績なし」、あれば pass 率と落ちやすいゲート、skill evals の合格率", async () => {
  const empty = await plan({ request: "朗読の動画" });
  const before = candidate(empty, "narrated-story-video").trackRecord;
  assert.equal(before.runReceipts.status, "none");
  assert.match(before.runReceipts.summary, /実績なし/u);
  assert.equal(before.skillEvals.status, "none");
  assert.ok(candidate(empty, "narrated-story-video").reasons.some((line) => /実績: 実績なし/u.test(line)));

  const receiptsDir = await mkdtemp(join(tmpdir(), "video-request-plan-receipts-"));
  const evalsDir = await mkdtemp(join(tmpdir(), "video-request-plan-evals-"));
  try {
    const version = versionOf("narrated-story-video");
    await writeReceipt(receiptsDir, "r1.json", { harnessId: "narrated-story-video", version, outcome: "pass", gates: { "audio-loudness": { verdict: "pass" }, "quality-loop": { verdict: "pass" } } });
    await writeReceipt(receiptsDir, "r2.json", { harnessId: "narrated-story-video", version, outcome: "fail", gates: { "audio-loudness": { verdict: "pass" }, "quality-loop": { verdict: "fail" } } });
    await writeReceipt(receiptsDir, "r3.json", { harnessId: "narrated-story-video", version: "0.0.1", outcome: "fail", gates: { "duration-conformance": { verdict: "fail" } } });
    // 確定していない記録は数えない。
    await writeFile(join(receiptsDir, "draft.json"), JSON.stringify({ finalized: false, harnessBuild: { harness: { id: "narrated-story-video", version, declarationDigest: "b".repeat(64) } }, outcome: "pass", gates: {} }));

    const inventory = JSON.parse(await readFile(join(repoRoot, ".agents", "skills", "inventory.manifest.json"), "utf8"));
    const skill = inventory.skills.find((entry) => entry.canonicalPath === ".agents/skills/narrated-story-video/SKILL.md");
    const record = (host, evalId, allPassed) => JSON.stringify({
      schema: SKILL_EVAL_RECORD_SCHEMA,
      skillId: skill.id,
      skillName: skill.name,
      skillVersion: skill.version,
      contentSha256: skill.contentSha256,
      host,
      evalId,
      status: "graded",
      allPassed,
      passed: allPassed ? 2 : 1,
      total: 2,
      recordedAt: "2026-09-25T00:00:00.000Z",
    });
    await writeFile(join(evalsDir, "run-1.jsonl"), `${[record("claude", "1", true), record("claude", "2", true), record("codex", "1", true), record("codex", "2", false)].join("\n")}\n`);

    const result = await plan({ request: "朗読の動画", receiptsDir, skillEvalsDir: evalsDir });
    const track = candidate(result, "narrated-story-video").trackRecord;
    assert.equal(track.runReceipts.status, "available");
    assert.equal(track.runReceipts.runs, 3);
    assert.equal(track.runReceipts.passed, 1);
    assert.equal(track.runReceipts.currentVersion.runs, 2, "今の版の記録を分けて出す");
    assert.equal(track.runReceipts.currentVersion.passRate, 0.5);
    assert.deepEqual(track.runReceipts.worstGates.map((gate) => gate.id), ["quality-loop"], "落ちやすいゲートは今の版で数える");
    assert.equal(track.runReceipts.worstGatesScope, "current-version");
    assert.match(track.runReceipts.summary, /RunReceipt 3 件中 1 件 pass/u);

    assert.equal(track.skillEvals.status, "available");
    const narratedSkill = track.skillEvals.skills.find((entry) => entry.skill === "narrated-story-video");
    assert.deepEqual(narratedSkill.hosts.map(({ host, evals, evalsAllPassed }) => ({ host, evals, evalsAllPassed })), [
      { host: "claude", evals: 2, evalsAllPassed: 2 },
      { host: "codex", evals: 2, evalsAllPassed: 1 },
    ]);
    assert.match(track.skillEvals.summary, /narrated-story-video .*claude 2\/2、codex 1\/2/u);
    // 別のハーネスの記録を混ぜない。
    const koya = await plan({ request: "漫画の動画", receiptsDir, skillEvalsDir: evalsDir });
    assert.equal(candidate(koya, "koya-manga-video").trackRecord.runReceipts.status, "none");
  } finally {
    await rm(receiptsDir, { recursive: true, force: true });
    await rm(evalsDir, { recursive: true, force: true });
  }
});

test("前提の欠け: 既定では doctor を走らせず、頼まれたら Job 前に確かめられる欠けだけを blockers にする", async () => {
  const calls = [];
  const doctor = async ({ harnessId, projectDir }) => {
    calls.push({ harnessId, projectDir });
    return {
      blocking: ["ffmpeg", "tts-key", "channel-pack"],
      checks: [
        { id: "ffmpeg", required: true, ok: false, detail: "起動できない", fix: "ffmpeg を入れる" },
        { id: "tts-key", required: true, ok: false, detail: "未確認", fix: "" },
        { id: "channel-pack", required: true, ok: false, detail: "evidence なし", fix: "" },
      ],
    };
  };
  const request = "感動する実話の朗読動画";
  const inputs = { scriptPath: fixture.scripts.raw, channelPackPath: fixture.packs["narrated-story-video"] };
  const unchecked = await plan({ request, ...inputs, doctor });
  assert.equal(calls.length, 0, "checkPrerequisites が無ければ doctor を呼ばない");
  assert.equal(candidate(unchecked, "narrated-story-video").prerequisites.status, "not-checked");
  assert.equal(unchecked.decision.startable, true);

  const checked = await plan({ request, ...inputs, doctor, checkPrerequisites: true });
  assert.deepEqual(calls, [{ harnessId: "narrated-story-video", projectDir: fixture.projectDir }], "決まったハーネスだけを確かめる");
  const prerequisites = candidate(checked, "narrated-story-video").prerequisites;
  assert.equal(prerequisites.status, "missing");
  assert.deepEqual(prerequisites.missing.map((entry) => entry.id), ["ffmpeg"]);
  assert.deepEqual(prerequisites.checkedAtJobPrepare, ["tts-key", "channel-pack"], "Pack から決まる項目は prepare で確かめる");
  assert.deepEqual(checked.decision.blockers.map((entry) => entry.code), ["prerequisite-missing:ffmpeg"]);
  assert.equal(checked.decision.startable, false);
  assert.equal(checked.records.prerequisites, "checked");

  // 漫画ハーネスでは声の adapter は Job の前に確かめられる項目。
  calls.length = 0;
  const manga = await plan({ request: "スカッとする漫画", scriptPath: fixture.scripts.manga, channelPackPath: fixture.packs["koya-manga-video"], options: KOYA_OPTIONS, doctor, checkPrerequisites: true });
  assert.deepEqual(candidate(manga, "koya-manga-video").prerequisites.missing.map((entry) => entry.id), ["ffmpeg", "tts-key"]);

  // 決めきれないときは、質問の選択肢に出すハーネスを確かめる。
  calls.length = 0;
  await plan({ request: "漫画の朗読動画にしたい", doctor, checkPrerequisites: true });
  assert.deepEqual(calls.map((call) => call.harnessId).sort(), ["koya-manga-video", "narrated-story-video"]);
});

test("未知のジャンルの依頼: 候補なし＋1問（Pack があればその向き先を推奨にする）", async () => {
  const result = await plan({ request: "料理のレシピ動画を作って" });
  assert.equal(result.decision.status, "no-match");
  assert.deepEqual(result.candidates, []);
  assert.ok(result.question, "1問を返す");
  assert.deepEqual(result.question.options.map((option) => option.value).sort(), harnesses.map((harness) => harness.id).sort());
  assert.ok(result.question.options.length <= 3);
  assert.match(result.question.note, /新しいハーネスが要る/u);
  assert.ok(result.summaryLines.includes("候補なし"));

  const withPack = await plan({ request: "料理のレシピ動画を作って", channelPackPath: fixture.packs["koya-manga-video"] });
  assert.deepEqual(withPack.candidates.map((entry) => entry.harnessId), ["koya-manga-video"]);
  assert.equal(withPack.candidates[0].channelPackTarget, true);
  assert.match(withPack.candidates[0].reasons.join("\n"), /依頼文に手掛かりの語は無い/u);
  assert.equal(withPack.question.options[0].value, "koya-manga-video");
  assert.match(withPack.question.options[0].label, /（推奨）$/u);
});

test("Channel Pack: 向き先が依頼と違えば1問にし、署名が合わない Pack は手掛かりに使わない", async () => {
  const mismatch = await plan({ request: "感動する実話の朗読動画", scriptPath: fixture.scripts.raw, channelPackPath: fixture.packs["koya-manga-video"] });
  assert.equal(mismatch.decision.status, "choice-required");
  assert.equal(mismatch.decision.reasonCode, "channel-pack-mismatch");
  assert.equal(mismatch.question.options[0].value, "koya-manga-video", "Pack の向き先を推奨として先頭に置く");
  assert.equal(mismatch.question.options[0].recommended, true);
  assert.ok(candidate(mismatch, "narrated-story-video").inputs.blockers.some((entry) => entry.code === "channel-pack-other-harness"));

  const unverified = await plan({ request: "感動する実話の朗読動画", scriptPath: fixture.scripts.raw, channelPackPath: fixture.packs["narrated-story-video"], env: {} });
  assert.equal(unverified.input.channelPack.signature, "unverified");
  assert.match(candidate(unverified, "narrated-story-video").inputs.channelPack.detail, /署名は未確認/u);

  const tamperedRoot = await mkdtemp(join(tmpdir(), "video-request-plan-tampered-"));
  try {
    const { cp } = await import("node:fs/promises");
    const tampered = join(tamperedRoot, "pack");
    await cp(fixture.packs["koya-manga-video"], tampered, { recursive: true });
    await writeFile(join(tampered, "payload", PACK_FILE), "{\"tampered\":true}\n");
    const result = await plan({ request: "感動する実話の朗読動画", scriptPath: fixture.scripts.raw, channelPackPath: tampered });
    assert.equal(result.input.channelPack.signature, "invalid");
    assert.equal(result.decision.status, "selected", "照合に失敗した Pack の向き先で決定を覆さない");
    assert.deepEqual(result.decision.blockers.map((entry) => entry.code), ["channel-pack-signature-invalid"]);
  } finally {
    await rm(tamperedRoot, { recursive: true, force: true });
  }

  const notEnvelope = await plan({ request: "朗読の動画", scriptPath: fixture.scripts.raw, channelPackPath: fixture.scripts.raw });
  assert.equal(notEnvelope.input.channelPack.status, "not-an-envelope");
});

test("plan-only: モデルもネットワークも呼ばず、Job も作らず、依頼文・台本・Pack の中身を写さない", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error("plan-request must not call the network"); };
  const before = await readdir(fixture.projectDir);
  const request = "感動する実話の朗読動画を作りたい、ユニーク依頼マーカー九九";
  let result;
  try {
    result = await plan({ request, scriptPath: fixture.scripts.raw, channelPackPath: fixture.packs["narrated-story-video"] });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
  assert.equal(result.planOnly, true);
  assert.equal(result.paidCallsAttempted, false);
  assert.equal(result.modelCallsAttempted, false);
  assert.equal(result.jobCreated, false);
  assert.deepEqual(await readdir(fixture.projectDir), before, "project に何も書かない");
  const text = JSON.stringify(result);
  for (const marker of ["ユニーク依頼マーカー九九", SCRIPT_MARKER, PACK_ID, PACK_FILE, "BEGIN PUBLIC KEY"]) {
    assert.equal(text.includes(marker), false, `${marker} を出力に写さない`);
  }
});

test("依頼文もハーネスも無い呼び出しは理由コードつきで止める。明示したハーネスはそのまま評価する", async () => {
  await assert.rejects(plan({ request: "  " }), (error) => error.code === VIDEO_REQUEST_MISSING_CODE);
  const explicit = await plan({ request: "", harnessId: "narrated-story-video", scriptPath: fixture.scripts.raw, channelPackPath: fixture.packs["narrated-story-video"] });
  assert.equal(explicit.decision.status, "selected");
  assert.equal(explicit.decision.selectedBy, "explicit");
  assert.equal(explicit.candidates[0].explicit, true);
  const unknown = await plan({ request: "朗読", harnessId: "no-such-harness" });
  assert.equal(unknown.decision.status, "unknown-harness");
  assert.ok(unknown.question.options.length > 0);
});

function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of ["BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY", "BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY_PEM", "BUZZASSIST_LEARNING_DIR"]) delete env[name];
  return { ...env, ...extra };
}

test("MCP（plan_video_request）と CLI（plan-request）は同じ結果を返す", async () => {
  const env = childEnv({
    BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY_PEM: fixture.env.BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY_PEM,
    BUZZASSIST_LEARNING_DIR: join(fixture.root, "learning"),
  });
  const cases = [
    { request: "感動する実話の朗読動画を作りたい", scriptPath: fixture.scripts.markdown, channelPackPath: fixture.packs["narrated-story-video"] },
    { request: "漫画、固定キャスト、吹き出しは使わず、朗読動画にしたい" },
    { request: "料理のレシピ動画を作って" },
    { request: "スカッとする漫画を作る", scriptPath: fixture.scripts.manga, channelPackPath: fixture.packs["koya-manga-video"] },
  ];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repoRoot, "mcp", "server.mjs")],
    cwd: repoRoot,
    env: {
      ...env,
      CODEX: "1",
      EXCALIDRAW_NO_AUTO_OPEN: "1",
      EXCALIDRAW_PROJECT_DIR: fixture.projectDir,
      EXCALIDRAW_CANVAS_DIR: join(fixture.projectDir, "canvas"),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "video-request-plan-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const tool = tools.tools.find((entry) => entry.name === TOOL_PLAN_VIDEO_REQUEST);
    assert.ok(tool, "plan_video_request が登録されている");
    assert.equal(tool.annotations.readOnlyHint, true);
    for (const entry of cases) {
      const mcp = await client.callTool({ name: TOOL_PLAN_VIDEO_REQUEST, arguments: { ...entry, projectDir: fixture.projectDir } });
      assert.equal(mcp.isError, undefined, JSON.stringify(mcp));
      const argv = [join(repoRoot, "scripts", "run-video-harness.mjs"), "plan-request", "--request", entry.request, "--project-dir", fixture.projectDir];
      if (entry.scriptPath) argv.push("--script-path", entry.scriptPath);
      if (entry.channelPackPath) argv.push("--channel-pack", entry.channelPackPath);
      const { stdout } = await execFile(process.execPath, argv, { cwd: repoRoot, env, maxBuffer: 16 * 1024 * 1024 });
      assert.deepEqual(mcp.structuredContent, JSON.parse(stdout), entry.request);
      assert.equal(mcp.content[0].text, mcp.structuredContent.summaryLines.join("\n"));
    }
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
});
