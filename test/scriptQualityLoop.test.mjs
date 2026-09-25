import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createChannelPackEnvelope } from "../lib/channelPackEnvelope.mjs";
import { recordExternalCall } from "../lib/externalModelCallLedger.mjs";
import {
  SCRIPT_QUALITY_CHANNEL_CONFIG_FILE,
  SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION,
  SCRIPT_QUALITY_LIMIT_DEFAULTS,
  createScriptQualityContract,
  normalizeScriptChannelConfig,
  recordScriptQualityRound,
  scriptQualityPaths,
  scriptQualityReviewTemplate,
  scriptQualityStatus,
  startScriptQualityLoop,
} from "../lib/scriptQualityLoop.mjs";
import { runScriptQualityCli } from "../scripts/script-quality-loop.mjs";

// 台本の文・会話 id・モデル id はすべて合成の値。
const sha = (value) => createHash("sha256").update(value).digest("hex");
const DRAFT = "「合成の冒頭の台詞」\n合成の地の文。\n「合成の台詞で、間を取る」\n";
const REWRITE = "「合成の冒頭の台詞」\n合成の地の文を整えた。\n「合成の台詞で間を取る」\n";
const CHECKED = "「合成の冒頭の台詞」\n合成の地の文を整えた。\n「合成の台詞で、間を取る」\n";
const WRITER = "ctx-writer-1";
const { contract: DEFAULT_CONTRACT } = createScriptQualityContract();
// 差し替え印の項目は下限 100（1文でも印が欠ければ不合格）なので、既定の採点では満点を付ける。
const scores = (overrides = {}, contract = DEFAULT_CONTRACT) => Object.fromEntries(contract.rubric.map((row) => [
  row.id,
  overrides[row.id] ?? (row.id === "review-first-person-marker" ? 100 : 96),
]));

let clock = Date.parse("2026-09-25T00:00:00.000Z");
const now = () => {
  clock += 60_000;
  return new Date(clock).toISOString();
};

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "script-quality-loop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "drafts"), { recursive: true });
  await mkdir(join(root, "quality", "reviews"), { recursive: true });
  return root;
}

async function writeReview(root, name, body) {
  const rel = `quality/reviews/${name}.json`;
  await writeFile(join(root, rel), `${JSON.stringify(body, null, 2)}\n`);
  return rel;
}

function review({ context, script, base = undefined, rubricScores = scores(), evaluatorId = "evaluator" }) {
  return {
    evaluatorId,
    evaluatorContextId: context,
    evaluatorHost: "codex",
    scriptSha256: sha(script),
    ...(base === undefined ? {} : { baseScriptSha256: sha(base) }),
    rubricScores,
    notes: "全行を読み、前の版と1行ずつ比べた所見",
    findings: [],
  };
}

async function start(root, extra = {}) {
  return startScriptQualityLoop({ workDir: root, generatorContextId: WRITER, generatorHost: "claude-code", now, ...extra });
}

async function record(root, extra) {
  return recordScriptQualityRound({ workDir: root, now, ...extra });
}

test("ナレーション物語の台本の既定の評価項目と下限を持ち、Pack は項目を足し下限を上げることだけできる", () => {
  const ids = DEFAULT_CONTRACT.rubric.map((row) => row.id);
  assert.deepEqual(ids, ["beat-structure", "meaning-preservation", "narration-voice", "duration-fit", "review-first-person-marker", "reading-clarity"]);
  const floor = (contract, id) => contract.rubric.find((row) => row.id === id).minimumScore;
  assert.equal(floor(DEFAULT_CONTRACT, "meaning-preservation"), 90);
  assert.equal(floor(DEFAULT_CONTRACT, "review-first-person-marker"), 100);
  assert.equal(DEFAULT_CONTRACT.limits.targetScore, SCRIPT_QUALITY_LIMIT_DEFAULTS.targetScore);
  assert.equal(Math.round(DEFAULT_CONTRACT.rubric.reduce((sum, row) => sum + row.weight, 0)), 100);

  const channelConfig = {
    version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION,
    genre: "narrated-story",
    criteria: [{ id: "opening-quote-echo", label: "冒頭の台詞の回収", weight: 10, minimumScore: 80, description: "冒頭の台詞が本編で一字違わず再演される" }],
    floors: { "meaning-preservation": 95 },
    weights: { "beat-structure": 30 },
    limits: { targetScore: 92, maximumReviewRounds: 6 },
  };
  const { contract, blockers } = createScriptQualityContract({ channelConfig, channelSource: { kind: "unsigned-file", configSha256: sha("x") } });
  assert.deepEqual(blockers, []);
  assert.equal(floor(contract, "meaning-preservation"), 95);
  assert.equal(contract.rubric.find((row) => row.id === "opening-quote-echo").origin, "channel");
  assert.equal(contract.limits.targetScore, 92);
  assert.equal(contract.limits.maximumReviewRounds, 6);
  assert.notEqual(contract.digest, DEFAULT_CONTRACT.digest);
  assert.equal(contract.channelSource.kind, "unsigned-file");

  const blocked = (config) => normalizeScriptChannelConfig({ version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION, ...config }).blockers;
  assert.deepEqual(blocked({ floors: { "meaning-preservation": 50 } }), ["script-quality.floors.meaning-preservation-cannot-lower"]);
  assert.deepEqual(blocked({ floors: { "no-such": 90 } }), ["script-quality.floors.no-such-unknown"]);
  assert.deepEqual(blocked({ rubric: [] }), ["script-quality.rubric-not-replaceable"]);
  assert.deepEqual(blocked({ genre: "manga" }), ["script-quality.genre-mismatch"]);
  assert.deepEqual(blocked({ limits: { targetScore: 70 } }), ["script-quality.limits.targetScore"]);
  assert.deepEqual(blocked({ limits: { maximumReviewRounds: 2.5 } }), ["script-quality.limits.maximumReviewRounds"]);
  assert.deepEqual(blocked({ criteria: [{ id: "narration-voice", label: "x", weight: 1, minimumScore: 1, description: "説明文です" }] }), ["script-quality.criteria.narration-voice-collides-with-genre"]);
  assert.deepEqual(normalizeScriptChannelConfig({ floors: {} }).blockers, ["script-quality.version"]);
  assert.equal(createScriptQualityContract({ channelConfig: { version: "old" } }).contract, null);
});

test("初稿 → 外部モデルの手直し → 意味照合を、それぞれ別の評価文脈の採点で1回ずつ記録し、最後の版で合格する", async (t) => {
  const root = await workspace(t);
  const started = await start(root);
  assert.equal(started.started, true);

  await writeFile(join(root, "drafts/draft.md"), DRAFT);
  const round1 = await record(root, {
    scriptPath: "drafts/draft.md",
    versionLabel: "v1-draft",
    stage: "draft",
    reviewPath: await writeReview(root, "r1", review({ context: "ctx-eval-1", script: DRAFT, rubricScores: scores({ "narration-voice": 55 }) })),
  });
  assert.equal(round1.recorded, true);
  assert.equal(round1.state.status, "active");
  assert.deepEqual(round1.round.floorFailures, ["narration-voice"]);
  assert.ok(round1.round.failureFingerprint.startsWith("quality-failure:"));

  // 外部モデルの手直し。呼んだのは初稿を書いた文脈（ctx-writer-1）。
  await writeFile(join(root, "drafts/rewrite-input.md"), DRAFT);
  await writeFile(join(root, "drafts/rewrite.md"), REWRITE);
  const call = await recordExternalCall({
    ledgerPath: scriptQualityPaths(root).externalCallLedgerPath,
    host: "antigravity",
    model: "synthetic-model-high",
    purpose: "台本の語り口の手直し",
    inputPath: join(root, "drafts/rewrite-input.md"),
    outputPath: join(root, "drafts/rewrite.md"),
    callerHost: "claude-code",
    callerSession: WRITER,
    now,
  });
  const round2 = await record(root, {
    scriptPath: "drafts/rewrite.md",
    versionLabel: "v2-rewrite",
    stage: "external-rewrite",
    externalCallIds: [call.id],
    revisionDelta: "語り口を外部モデルで整えた",
    reviewPath: await writeReview(root, "r2", review({ context: "ctx-eval-2", script: REWRITE, base: DRAFT, rubricScores: scores({ "meaning-preservation": 80 }) })),
  });
  assert.equal(round2.recorded, true);
  assert.deepEqual(round2.round.floorFailures, ["meaning-preservation"]);
  assert.deepEqual(round2.round.failedGateIds, []);
  assert.equal(round2.version.baseVersion, "v1-draft");
  assert.equal(round2.version.externalCalls[0].status, "complete");
  assert.equal(round2.round.previousFailureFingerprint, round1.round.failureFingerprint);

  // 意味照合の修正は、ファイルに書いた修正内容でもよい。
  await writeFile(join(root, "script.md"), CHECKED);
  await writeFile(scriptQualityPaths(root).revisionDeltaPath, JSON.stringify({
    previousFailureFingerprint: round2.round.failureFingerprint,
    revisionDelta: "鉤括弧の中で落ちた読点を初稿どおりに戻した",
  }));
  const round3 = await record(root, {
    scriptPath: "script.md",
    versionLabel: "v3-checked",
    stage: "meaning-check",
    reviewPath: await writeReview(root, "r3", review({ context: "ctx-eval-3", script: CHECKED, base: REWRITE })),
  });
  assert.equal(round3.recorded, true);
  assert.equal(round3.state.status, "passed");
  assert.equal(round3.check.pass, true);
  assert.deepEqual(round3.issues, []);

  const status = await scriptQualityStatus({ workDir: root });
  assert.equal(status.deliverable, true);
  assert.equal(status.rounds.length, 3);
  // 合格した版の後で台本を変えたら、その合格は今の台本を保証しない。
  await writeFile(join(root, "script.md"), `${CHECKED}足した行。\n`);
  const changed = await scriptQualityStatus({ workDir: root });
  assert.equal(changed.deliverable, false);
  assert.ok(changed.issues.includes("script-quality-script-changed-after-review"));
  // 状態は作業フォルダの中に、本文を持たずに書かれている。
  const stateText = await readFile(scriptQualityPaths(root).statePath, "utf8");
  assert.equal(stateText.includes("合成の地の文"), false);
});

test("その版を作った文脈・前の回の文脈・作る係の名乗りでは採点できない（例外ではなく人待ち）", async (t) => {
  const root = await workspace(t);
  await start(root);
  await writeFile(join(root, "drafts/draft.md"), DRAFT);
  const attempt = async (name, body, extra = {}) => record(root, {
    scriptPath: "drafts/draft.md", versionLabel: "v1", stage: "draft", reviewPath: await writeReview(root, name, body), ...extra,
  });
  const sameAsWriter = await attempt("a", review({ context: WRITER, script: DRAFT }));
  assert.equal(sameAsWriter.recorded, false);
  assert.deepEqual(sameAsWriter.issues, ["script-quality-evaluator-not-independent"]);
  const producer = await attempt("b", review({ context: "ctx-helper", script: DRAFT }), { producerContexts: ["ctx-helper"] });
  assert.deepEqual(producer.issues, ["script-quality-evaluator-not-independent"]);
  const roleName = await attempt("c", review({ context: "ctx-eval-x", script: DRAFT, evaluatorId: "script-writer" }));
  assert.deepEqual(roleName.issues, ["script-quality-evaluator-not-independent"]);
  const ok = await attempt("d", review({ context: "ctx-eval-1", script: DRAFT, rubricScores: scores({ "reading-clarity": 50 }) }));
  assert.equal(ok.recorded, true);

  // 外部モデルを呼んだ文脈も「作った文脈」に数える。
  await writeFile(join(root, "drafts/in.md"), DRAFT);
  await writeFile(join(root, "drafts/rewrite.md"), REWRITE);
  const call = await recordExternalCall({
    ledgerPath: scriptQualityPaths(root).externalCallLedgerPath, host: "antigravity", model: "synthetic-model-high",
    purpose: "台本の語り口の手直し", inputPath: join(root, "drafts/in.md"), outputPath: join(root, "drafts/rewrite.md"),
    callerHost: "codex", callerSession: "ctx-caller", now,
  });
  const second = (name, context) => writeReview(root, name, review({ context, script: REWRITE, base: DRAFT }));
  const base = { scriptPath: "drafts/rewrite.md", versionLabel: "v2", stage: "external-rewrite", externalCallIds: [call.id], revisionDelta: "読みの割れる語を言い換えた" };
  assert.deepEqual((await record(root, { ...base, reviewPath: await second("e", "ctx-caller") })).issues, ["script-quality-evaluator-not-independent"]);
  assert.deepEqual((await record(root, { ...base, reviewPath: await second("f", "ctx-eval-1") })).issues, ["script-quality-fresh-review-required"]);
  const state = JSON.parse(await readFile(scriptQualityPaths(root).statePath, "utf8"));
  assert.equal(state.rounds.length, 1, "人待ちの試みは回として数えない");
});

test("採点は台本の SHA と前の版に縛られ、2回目以降は修正内容が無ければ人待ちで止まる", async (t) => {
  const root = await workspace(t);
  await start(root);
  await writeFile(join(root, "drafts/draft.md"), DRAFT);
  const mismatch = await record(root, {
    scriptPath: "drafts/draft.md", versionLabel: "v1", stage: "draft",
    reviewPath: await writeReview(root, "m", review({ context: "ctx-eval-1", script: "別の台本" })),
  });
  assert.deepEqual(mismatch.issues, ["script-quality-review-script-mismatch"]);
  const first = await record(root, {
    scriptPath: "drafts/draft.md", versionLabel: "v1", stage: "draft",
    reviewPath: await writeReview(root, "r1", review({ context: "ctx-eval-1", script: DRAFT, rubricScores: scores({ "beat-structure": 40 }) })),
  });
  assert.equal(first.recorded, true);
  // 同じ採点での再実行は記録し直さない。
  const again = await record(root, {
    scriptPath: "drafts/draft.md", versionLabel: "v1", stage: "draft", reviewPath: "quality/reviews/r1.json",
  });
  assert.equal(again.alreadyRecorded, true);

  await writeFile(join(root, "script.md"), CHECKED);
  const noBase = await record(root, {
    scriptPath: "script.md", versionLabel: "v2", stage: "revision", revisionDelta: "拍の順番を入れ替えた",
    reviewPath: await writeReview(root, "nb", review({ context: "ctx-eval-2", script: CHECKED })),
  });
  assert.deepEqual(noBase.issues, ["script-quality-review-base-missing"]);
  const wrongBase = await record(root, {
    scriptPath: "script.md", versionLabel: "v2", stage: "revision", revisionDelta: "拍の順番を入れ替えた",
    reviewPath: await writeReview(root, "wb", review({ context: "ctx-eval-2", script: CHECKED, base: REWRITE })),
  });
  assert.deepEqual(wrongBase.issues, ["script-quality-review-base-mismatch"]);
  const noDelta = await record(root, {
    scriptPath: "script.md", versionLabel: "v2", stage: "revision",
    reviewPath: await writeReview(root, "nd", review({ context: "ctx-eval-2", script: CHECKED, base: DRAFT })),
  });
  assert.deepEqual(noDelta.issues, [`script-quality-revision-delta-required:${first.round.failureFingerprint}`]);
  // 直していない（同じバイト列の）版は、別の評価者に採点し直させない。
  const unchanged = await record(root, {
    scriptPath: "drafts/draft.md", versionLabel: "v1b", stage: "revision", revisionDelta: "何も変えていない",
    reviewPath: await writeReview(root, "u", review({ context: "ctx-eval-9", script: DRAFT, base: DRAFT })),
  });
  assert.deepEqual(unchanged.issues, ["script-quality-script-unchanged:v1"]);
  const reused = await record(root, {
    scriptPath: "script.md", versionLabel: "v1", stage: "revision", revisionDelta: "拍の順番を入れ替えた",
    reviewPath: await writeReview(root, "rl", review({ context: "ctx-eval-2", script: CHECKED, base: DRAFT })),
  });
  assert.deepEqual(reused.issues, ["script-quality-version-label-reused:v1"]);
  const incomplete = await record(root, {
    scriptPath: "script.md", versionLabel: "v2", stage: "revision", revisionDelta: "拍の順番を入れ替えた",
    reviewPath: await writeReview(root, "ic", { ...review({ context: "ctx-eval-2", script: CHECKED, base: DRAFT }), rubricScores: { "beat-structure": 90 } }),
  });
  assert.ok(incomplete.issues.includes("script-quality-review-score-invalid:meaning-preservation"));
  await assert.rejects(record(root, { scriptPath: "../outside.md", versionLabel: "v9", stage: "draft", reviewPath: "quality/reviews/r1.json" }), /作業フォルダの中/u);
});

test("外部モデルの手直しの版は、呼び出しの記録が無いか未完なら機械ゲートで落ちる（満点でも合格しない）", async (t) => {
  const root = await workspace(t);
  await start(root);
  await writeFile(join(root, "drafts/rewrite.md"), REWRITE);
  const noCall = await record(root, {
    scriptPath: "drafts/rewrite.md", versionLabel: "v1", stage: "external-rewrite",
    reviewPath: await writeReview(root, "r1", review({ context: "ctx-eval-1", script: REWRITE, rubricScores: scores({}, DEFAULT_CONTRACT) })),
  });
  assert.equal(noCall.recorded, true);
  assert.equal(noCall.state.status, "active");
  assert.deepEqual(noCall.round.failedGateIds, ["external-call-recorded"]);

  await writeFile(join(root, "drafts/in.md"), DRAFT);
  await writeFile(join(root, "drafts/empty.md"), "");
  const empty = await recordExternalCall({
    ledgerPath: scriptQualityPaths(root).externalCallLedgerPath, host: "antigravity", model: "synthetic-model-high",
    purpose: "台本の語り口の手直し", inputPath: join(root, "drafts/in.md"), outputPath: join(root, "drafts/empty.md"),
    callerHost: "claude-code", callerSession: WRITER, now,
  });
  assert.equal(empty.record.status, "empty");
  await writeFile(join(root, "drafts/rewrite2.md"), `${REWRITE}追記。\n`);
  const emptyCall = await record(root, {
    scriptPath: "drafts/rewrite2.md", versionLabel: "v2", stage: "external-rewrite", externalCallIds: [empty.id],
    revisionDelta: "呼び出しを記録してやり直した",
    reviewPath: await writeReview(root, "r2", review({ context: "ctx-eval-2", script: `${REWRITE}追記。\n`, base: REWRITE })),
  });
  assert.deepEqual(emptyCall.round.failedGateIds, ["external-calls-complete"]);
  assert.equal(emptyCall.version.externalCalls[0].status, "empty");
  assert.notEqual(emptyCall.state.status, "passed");
});

test("上限の回数に届くと人待ちで止まり、止まったループには回を足せない", async (t) => {
  const root = await workspace(t);
  const configPath = join(root, "script-quality.json");
  await writeFile(configPath, JSON.stringify({ version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION, limits: { maximumReviewRounds: 2 } }));
  await start(root, { channelConfig: configPath });
  const texts = [DRAFT, REWRITE, CHECKED];
  let previous = null;
  for (const [index, text] of texts.entries()) {
    const file = `drafts/v${index + 1}.md`;
    await writeFile(join(root, file), text);
    const result = await record(root, {
      scriptPath: file, versionLabel: `v${index + 1}`, stage: index === 0 ? "draft" : "revision",
      ...(index > 0 ? { revisionDelta: "拍の位置を直した" } : {}),
      reviewPath: await writeReview(root, `r${index + 1}`, review({
        context: `ctx-eval-${index + 1}`, script: text, ...(previous ? { base: previous } : {}), rubricScores: scores({ "duration-fit": 30 }),
      })),
    });
    if (index < 2) assert.equal(result.recorded, true);
    else {
      assert.equal(result.recorded, false);
      assert.ok(result.issues.includes("script-quality-stopped:needs-human-approval:round-limit"));
    }
    previous = text;
  }
  // 止まったループは、続いているループと違って始め直せる（理由が要り、前の状態は残る）。
  await assert.rejects(start(root, { channelConfig: configPath, restart: true }), /--reason/u);
  const restarted = await start(root, { channelConfig: configPath, restart: true, restartReason: "拍の表を作り直した" });
  assert.equal(restarted.started, true);
  assert.equal(restarted.state.script.history.length, 1);
  assert.equal(restarted.state.script.history[0].status, "needs-human-approval");
  assert.equal(restarted.state.rounds.length, 0);
});

test("続いているループは始め直せず、Pack の設定が変わったら同じループとして続けない", async (t) => {
  const root = await workspace(t);
  const configPath = join(root, "script-quality.json");
  await writeFile(configPath, JSON.stringify({ version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION, floors: { "narration-voice": 70 } }));
  await start(root, { channelConfig: configPath });
  const again = await start(root, { channelConfig: configPath });
  assert.deepEqual(again.issues, ["script-quality-loop-already-started"]);
  const restart = await start(root, { channelConfig: configPath, restart: true, restartReason: "理由を書いても不可" });
  assert.deepEqual(restart.issues, ["script-quality-loop-active-cannot-restart"]);
  await writeFile(configPath, JSON.stringify({ version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION, floors: { "narration-voice": 90 } }));
  await writeFile(join(root, "drafts/draft.md"), DRAFT);
  const changed = await record(root, {
    scriptPath: "drafts/draft.md", versionLabel: "v1", stage: "draft",
    reviewPath: await writeReview(root, "r1", review({ context: "ctx-eval-1", script: DRAFT })),
  });
  assert.deepEqual(changed.issues, ["script-quality-contract-changed"]);
  const invalid = await startScriptQualityLoop({
    workDir: await workspace(t), generatorContextId: WRITER, now,
    loadChannel: async () => ({ config: { version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION, floors: { "meaning-preservation": 10 } }, source: { kind: "unsigned-file", configSha256: sha("c") }, spec: { kind: "none" } }),
  });
  assert.equal(invalid.started, false);
  assert.deepEqual(invalid.issues, ["script-quality-channel-config-invalid:script-quality.floors.meaning-preservation-cannot-lower"]);
});

test("署名済み Channel Pack の script-quality.json を、信頼した公開鍵で検証してから読む", async (t) => {
  const root = await workspace(t);
  const source = join(root, "pack-source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, SCRIPT_QUALITY_CHANNEL_CONFIG_FILE), JSON.stringify({
    version: SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION,
    criteria: [{ id: "closing-line", label: "締めの一言", weight: 10, minimumScore: 75, description: "締めの一言が決めた字数と型に収まる" }],
  }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicPem = publicKey.export({ type: "spki", format: "pem" });
  const bundle = join(root, "signed-pack");
  await createChannelPackEnvelope({
    sourceDir: source, outputDir: bundle, id: "synthetic-channel", version: "1.0.0", harnessId: "narrated-story-video", privateKeyPem: privatePem,
  });
  await assert.rejects(start(root, { channelPack: bundle, env: {} }), /公開鍵が未設定/u);
  const env = { BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY_PEM: publicPem };
  const started = await start(root, { channelPack: bundle, env });
  assert.equal(started.started, true);
  const contract = started.state.script.contract;
  assert.ok(contract.rubric.some((row) => row.id === "closing-line" && row.origin === "channel"));
  assert.equal(contract.channelSource.kind, "signed-channel-pack");
  assert.equal(contract.channelSource.packId, "synthetic-channel");
  // 採点ファイルの雛形は、Pack が足した項目も含む。
  await writeFile(join(root, "drafts/draft.md"), DRAFT);
  const { template } = await scriptQualityReviewTemplate({ workDir: root, scriptPath: "drafts/draft.md" });
  assert.equal(template.scriptSha256, sha(DRAFT));
  assert.ok(Object.hasOwn(template.rubricScores, "closing-line"));
  const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  const wrongKey = await record(root, {
    scriptPath: "drafts/draft.md", versionLabel: "v1", stage: "draft", env: { BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY_PEM: other },
    reviewPath: await writeReview(root, "r1", review({ context: "ctx-eval-1", script: DRAFT, rubricScores: scores({}, contract) })),
  });
  assert.deepEqual(wrongKey.issues, ["script-quality-channel-config-unavailable"]);
  const recorded = await record(root, { scriptPath: "drafts/draft.md", versionLabel: "v1", stage: "draft", env, reviewPath: "quality/reviews/r1.json" });
  assert.equal(recorded.recorded, true);
  assert.equal(recorded.state.status, "passed");
});

test("CLI は人待ちを終了コード 3、未合格の --require-pass を 4 で返し、--help では何も書かない", async (t) => {
  const root = await workspace(t);
  const out = [];
  const stdout = { write: (text) => out.push(text) };
  assert.equal((await runScriptQualityCli(["start", "--help"], { stdout })).exitCode, 0);
  assert.equal((await scriptQualityStatus({ workDir: root })).started, false);
  assert.equal((await runScriptQualityCli(["start", "--work-dir", root, "--generator-context", WRITER], { stdout, now })).exitCode, 0);
  await writeFile(join(root, "drafts/draft.md"), DRAFT);
  const reviewPath = await writeReview(root, "r1", review({ context: WRITER, script: DRAFT }));
  const waitingRun = await runScriptQualityCli(["record", "--work-dir", root, "--script", "drafts/draft.md", "--version", "v1", "--stage", "draft", "--review", reviewPath], { stdout, now });
  assert.equal(waitingRun.exitCode, 3);
  const failing = await writeReview(root, "r2", review({ context: "ctx-eval-1", script: DRAFT, rubricScores: scores({ "narration-voice": 10 }) }));
  // 試験では本物の非公開台帳へ学習候補を積まない（自動捕捉は環境変数で止まる）。
  const recorded = await runScriptQualityCli(
    ["record", "--work-dir", root, "--script", "drafts/draft.md", "--version", "v1", "--stage", "draft", "--review", failing, "--json"],
    { stdout, now, env: { BUZZASSIST_LEARNING_AUTO_CAPTURE: "0" } },
  );
  assert.equal(recorded.exitCode, 0);
  assert.equal(recorded.result.learning.skippedReason, "disabled");
  assert.equal((await runScriptQualityCli(["status", "--work-dir", root, "--require-pass"], { stdout })).exitCode, 4);
  out.length = 0;
  assert.equal((await runScriptQualityCli(["contract"], { stdout })).exitCode, 0);
  assert.equal(JSON.parse(out.join("")).rubric.length, 6);
  await assert.rejects(runScriptQualityCli(["record", "--nope"], { stdout }), /不明なオプション/u);
});
