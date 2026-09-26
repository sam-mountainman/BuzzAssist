import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

import { assetQualityHarness, normalizeAssetChannelConfig, ASSET_QUALITY_CHANNEL_CONFIG_VERSION, ASSET_QUALITY_HARNESSES } from "../lib/assetQualityLoop.mjs";
import { HARNESS_LEARNING_ROUTES } from "../lib/harnessLearningTargets.mjs";
import {
  HUMAN_CHOICE_CANDIDATES_VERSION,
  HUMAN_CHOICE_HUMAN_VERIFIED,
  HUMAN_CHOICE_STAGES,
  HUMAN_CHOICE_STAGE_IDS,
  HUMAN_DECISION_ROUTES,
  HUMAN_DECISION_TABLE,
  createHumanChoiceSet,
  humanChoiceDefaultRubric,
  humanChoiceRubricProposal,
  humanChoiceStatus,
  humanDecisionFor,
  listHumanChoiceSets,
  recordHumanChoice,
  routeHumanDecision,
} from "../lib/humanChoice.mjs";
import {
  HUMAN_CHOICE_EVIDENCE_TAG,
  captureHumanChoiceLearning,
  humanChoiceLearningCandidates,
} from "../lib/humanChoiceLearning.mjs";
import { childAgentEnvironment } from "../lib/harnessLearningGuard.mjs";
import { HUMAN_VERIFIED, captureLearningProposal } from "../scripts/harness-learn.mjs";
import { runHumanChoiceCli } from "../scripts/human-choice.mjs";

// 候補・組の id・人の名前・一言はすべて合成の値（実在のチャンネル名・人物名を書かない）。
const REVIEWER = "synthetic-reviewer";

let clock = Date.parse("2026-09-27T00:00:00.000Z");
const now = () => {
  clock += 60_000;
  return new Date(clock).toISOString();
};

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "human-choice-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "work", "thumbs"), { recursive: true });
  for (const name of ["a", "b", "c", "d"]) await writeFile(join(root, "work", "thumbs", `${name}.png`), `synthetic-${name}`);
  return { root, work: join(root, "work") };
}

function candidatesInput(overrides = {}) {
  return {
    version: HUMAN_CHOICE_CANDIDATES_VERSION,
    candidates: [
      { path: "thumbs/a.png", axis: "寄りの顔で感情を見せる", summary: "合成の要約 A" },
      { path: "thumbs/b.png", axis: "引きで対立を見せる" },
      { path: "thumbs/c.png", axis: "文字を主役にする" },
      { path: "thumbs/d.png", axis: "色で一覧から浮かせる" },
    ],
    recommended: { index: 2, reason: "状況が一目で分かる" },
    ...overrides,
  };
}

async function createSet(work, overrides = {}) {
  return createHumanChoiceSet({
    workDir: work,
    harnessId: "narrated-story-video",
    stage: "thumbnail",
    setId: "synthetic-round-1",
    question: "どのサムネ案で進めますか",
    input: candidatesInput(),
    now,
    ...overrides,
  });
}

const allowHuman = () => ({ ok: true, attestation: { reviewer: REVIEWER, attestedBy: HUMAN_CHOICE_HUMAN_VERIFIED } });

function captureHarness() {
  const rows = [];
  return {
    rows,
    options: {
      signals: { terms: [], castIds: [] },
      privateVocabulary: null,
      homeRoot: "",
      env: {},
      ledgerPathResolver: (target, kind) => (String(target).startsWith("channel-pack:")
        ? join(tmpdir(), "synthetic-private-channel", `${kind}.jsonl`)
        : join(tmpdir(), "synthetic-public-core", "docs", "learning", `${kind}.jsonl`)),
      append: (_file, entry) => rows.push(entry),
      read: () => rows,
      lock: (_file, action) => action(),
      refreshCatalog: () => ({ written: false }),
    },
  };
}

const noChannel = async () => ({ channelId: "", selectedBy: null });

test("判断の振り分け: 機械が確かめられるなら聞かない・候補が2つ以上なら並べて選ぶ・1案なら赤を入れる。表は docs と一致する", async () => {
  assert.equal(routeHumanDecision({ machineCheckable: true, candidateCount: 4 }), "machine");
  assert.equal(routeHumanDecision({ candidateCount: 4 }), "pick");
  assert.equal(routeHumanDecision({ candidateCount: 1 }), "redline");
  assert.deepEqual(Object.keys(HUMAN_DECISION_ROUTES).sort(), ["machine", "pick", "redline"]);
  const doc = await readFile(new URL("../docs/human-choice-ja.md", import.meta.url), "utf8");
  for (const row of HUMAN_DECISION_TABLE) {
    assert.ok(HUMAN_DECISION_ROUTES[row.route], `${row.step} の振り分けが未知`);
    assert.ok(doc.includes(`\`${row.step}\``), `docs/human-choice-ja.md に ${row.step} の行が無い`);
  }
  // 並べて選ぶ工程は、表のどれかの行の入口から create される。
  for (const stage of HUMAN_CHOICE_STAGE_IDS) {
    assert.ok(HUMAN_DECISION_TABLE.some((row) => row.route === "pick" && row.entry.includes(`--stage ${stage}`)), `${stage} が表の pick の行に無い`);
  }
  assert.throws(() => humanDecisionFor("no-such-step"), /未知の工程/u);
  assert.equal(HUMAN_CHOICE_HUMAN_VERIFIED, HUMAN_VERIFIED, "人の選択の印は harness-learn と同じ値");
});

test("決め手の札は既定の評価項目か採点表に足す案で、案の形は Channel Pack の asset-quality.json がそのまま受ける", () => {
  for (const stage of HUMAN_CHOICE_STAGE_IDS) {
    const spec = HUMAN_CHOICE_STAGES[stage];
    const defaults = new Set(humanChoiceDefaultRubric(stage).map((row) => row.id));
    const ids = spec.chips.map((row) => row.id);
    assert.equal(new Set(ids).size, ids.length, `${stage} の札の id が重複`);
    for (const row of spec.chips) {
      assert.ok(Boolean(row.existing) !== Boolean(row.draft), `${stage}/${row.id} は existing か draft のどちらか1つ`);
      if (row.existing) assert.ok(defaults.has(row.existing), `${stage}/${row.id} の既定の評価項目 ${row.existing} が採点表に無い`);
      if (row.draft) assert.equal(defaults.has(row.draft.id), false, `${stage}/${row.id} の案 ${row.draft.id} が既定の評価項目とぶつかる`);
      const proposal = humanChoiceRubricProposal(stage, row.id);
      assert.equal(proposal.rubricHome, spec.rubricHome);
    }
    if (!spec.assetStage) continue;
    const drafts = spec.chips.filter((row) => row.draft).map((row) => ({ ...row.draft, weight: 10, minimumScore: 60 }));
    for (const harness of Object.values(ASSET_QUALITY_HARNESSES).filter((entry) => entry.stages.includes(spec.assetStage))) {
      const { blockers } = normalizeAssetChannelConfig({
        version: ASSET_QUALITY_CHANNEL_CONFIG_VERSION,
        stages: { [spec.assetStage]: { criteria: drafts } },
      }, { harnessId: assetQualityHarness(harness.id).id });
      assert.deepEqual(blockers, [], `${harness.id}/${spec.assetStage} の案が Pack の形に合わない`);
    }
  }
  assert.throws(() => humanChoiceRubricProposal("thumbnail", "no-such-chip"), /札に無い/u);
});

test("create は候補を 2〜5 案・軸を分けて・作業フォルダの中の実物で受け、生成の順でない順に A〜 を振って1枚の HTML を書く", async (t) => {
  const { root, work } = await workspace(t);
  const created = await createSet(work);
  assert.equal(created.created, true);
  const { state } = created;
  assert.deepEqual(state.candidates.map((row) => row.label), ["A", "B", "C", "D"]);
  assert.equal(state.candidates.every((row) => /^[a-f0-9]{64}$/u.test(row.sha256)), true);
  // 推奨は入力の 2 番目（b.png）。振った記号に付け替わる。
  assert.equal(state.candidates.find((row) => row.label === state.recommended.label).path, "thumbs/b.png");
  // 並べる順は組の id と中身で決まる（同じ組を作り直しても同じ順）。
  const again = await createSet(work);
  assert.deepEqual(again.state.candidates.map((row) => row.path), state.candidates.map((row) => row.path));
  const html = await readFile(created.pagePath, "utf8");
  assert.match(html, /Content-Security-Policy/u);
  assert.match(html, /<img src="\.\.\/\.\.\/thumbs\/a\.png"/u);
  assert.ok(html.includes(state.digest.slice(0, 16)), "ページが組の digest を持つ");
  assert.ok(!/https?:\/\//u.test(html), "ページは外部を読み込まない");

  const bad = (overrides) => createSet(work, { setId: "synthetic-bad", input: candidatesInput(overrides) });
  await assert.rejects(bad({ candidates: [{ path: "thumbs/a.png", axis: "軸1" }] }), /2〜5 案/u);
  await assert.rejects(bad({ candidates: [{ path: "thumbs/a.png", axis: "同じ軸" }, { path: "thumbs/b.png", axis: " 同じ軸 " }] }), /設計の軸を分ける/u);
  await assert.rejects(bad({ candidates: [{ path: "thumbs/a.png", axis: "軸1" }, { path: "thumbs/b.png" }] }), /axis/u);
  await writeFile(join(work, "thumbs", "dup.png"), "synthetic-a");
  await assert.rejects(bad({ candidates: [{ path: "thumbs/a.png", axis: "軸1" }, { path: "thumbs/dup.png", axis: "軸2" }] }), /中身が他の候補と同じ/u);
  await writeFile(join(root, "outside.png"), "synthetic-outside");
  await assert.rejects(bad({ candidates: [{ path: "../outside.png", axis: "軸1" }, { path: "thumbs/b.png", axis: "軸2" }] }), /作業フォルダの中/u);
  await assert.rejects(bad({ recommended: { index: 9, reason: "合成の推奨" } }), /recommended\.index/u);
  if (process.platform !== "win32") {
    await symlink(join(work, "thumbs", "a.png"), join(work, "thumbs", "link.png"));
    await assert.rejects(bad({ candidates: [{ path: "thumbs/link.png", axis: "軸1" }, { path: "thumbs/b.png", axis: "軸2" }] }), /シンボリックリンク/u);
  }
  // 漫画固有の工程・学習の宛先の無いハーネスは拒否する。
  await assert.rejects(createSet(work, { harnessId: "explainer-video", stage: "character", setId: "synthetic-x" }), /explainer-video では使えない/u);
  await assert.rejects(createSet(work, { harnessId: "no-such-harness", setId: "synthetic-x" }), /未知のハーネス/u);
  // 文の候補（タイトル）はファイル無しで受ける。
  const titles = await createHumanChoiceSet({
    workDir: work, harnessId: "explainer-video", stage: "title", setId: "synthetic-titles", question: "どのタイトルで出しますか", now,
    input: { version: HUMAN_CHOICE_CANDIDATES_VERSION, candidates: [{ text: "合成のタイトル案その一", axis: "数字で具体" }, { text: "合成のタイトル案その二", axis: "問いで引く" }] },
  });
  assert.equal(titles.state.candidates.every((row) => row.kind === "text" && row.text), true);
});

test("人の選択は対話端末＋--human-verified だけ数え、機械の記録は残すが数えず学習にも積まない", async (t) => {
  const { work } = await workspace(t);
  await createSet(work);
  const base = { workDir: work, stage: "thumbnail", setId: "synthetic-round-1", now };
  let captured = 0;
  const captureLearning = async () => {
    captured += 1;
    return { captured: 1, duplicates: 0, target: "channel-pack:narrated-story", proposalIds: ["aaaaaaaaaaaa"] };
  };
  await assert.rejects(recordHumanChoice({ ...base, pick: "A", note: "合成の一言です", reviewer: REVIEWER, humanVerified: true, isInteractive: false }), /対話端末/u);
  const agent = await recordHumanChoice({ ...base, pick: "A", reasons: ["strong-emotion"], reviewer: REVIEWER, agentAttested: true, captureLearning });
  assert.equal(agent.recorded, true);
  assert.equal(agent.counted, false);
  assert.equal(agent.decision.attestedBy, "agent-self-attested");
  assert.equal(captured, 0, "機械の記録からは学習に積まない");
  assert.equal((await humanChoiceStatus(base)).pass, false);

  await assert.rejects(recordHumanChoice({ ...base, pick: "A", reviewer: REVIEWER, humanVerified: true, isInteractive: true }), /理由が要ります/u);
  await assert.rejects(recordHumanChoice({ ...base, pick: "A", reasons: ["reads-instantly", "strong-emotion", "lettering", "not-too-busy"], reviewer: REVIEWER, humanVerified: true, isInteractive: true }), /3 つまで/u);
  await assert.rejects(recordHumanChoice({ ...base, pick: "A", reasons: ["no-such-chip"], reviewer: REVIEWER, humanVerified: true, isInteractive: true }), /札に無い/u);
  await assert.rejects(recordHumanChoice({ ...base, pick: "A", delegate: true, reasons: ["lettering"], reviewer: REVIEWER, humanVerified: true, isInteractive: true }), /同時に/u);

  const human = await recordHumanChoice({
    ...base, pick: "c", reasons: ["reads-instantly", "situation-at-glance"], note: "合成の一言: 表情が強い", reviewer: REVIEWER, humanVerified: true, isInteractive: true, captureLearning,
  });
  assert.equal(human.counted, true);
  assert.equal(human.decision.pick.label, "C");
  assert.deepEqual(human.decision.reasons.map((row) => [row.chip, row.kind, row.criterionId]), [
    ["reads-instantly", "existing", "readable-at-decided-size"],
    ["situation-at-glance", "draft", "situation-at-glance"],
  ]);
  assert.match(human.decision.guidance, /案 C/u);
  assert.equal(captured, 1);
  assert.deepEqual(human.decision.learning.proposalIds, ["aaaaaaaaaaaa"]);
  const status = await humanChoiceStatus(base);
  assert.equal(status.pass, true);
  assert.equal(status.choice.pick.label, "C");
  // 選んだ案のファイルが変わったら、選択は使えない（選び直すか出し直す）。
  await writeFile(join(work, status.choice.pick.path), "synthetic-changed");
  const changed = await humanChoiceStatus(base);
  assert.equal(changed.pass, false);
  assert.ok(changed.issues.includes(`human-choice-picked-candidate-changed:C`));
  // 変わった候補のある組には、新しい選択を記録しない。
  const refused = await recordHumanChoice({ ...base, pick: "A", reasons: ["lettering"], reviewer: REVIEWER, humanVerified: true, isInteractive: true, attest: allowHuman });
  assert.equal(refused.recorded, false);
  assert.ok(refused.issues.includes("human-choice-candidate-changed:C"));
});

test("古いページの答え・推奨の無い組のお任せは記録しない。お任せは記録するが学習に積まない。選択のある組は --restart でしか出し直さない", async (t) => {
  const { work } = await workspace(t);
  const first = await createSet(work);
  const base = { workDir: work, stage: "thumbnail", setId: "synthetic-round-1", now, reviewer: REVIEWER, humanVerified: true, isInteractive: true };
  await assert.rejects(recordHumanChoice({ ...base, pick: "A", note: "合成の一言です", pageDigest: "xyz" }), /page-digest/u);
  const outdated = await recordHumanChoice({ ...base, pick: "A", note: "合成の一言です", pageDigest: "0".repeat(16) });
  assert.equal(outdated.recorded, false);
  assert.deepEqual(outdated.issues, ["human-choice-page-outdated"]);
  const withPage = await recordHumanChoice({ ...base, pick: "A", note: "合成の一言です", pageDigest: first.state.digest.slice(0, 16) });
  assert.equal(withPage.counted, true);

  let captureInput = null;
  const delegated = await recordHumanChoice({
    ...base, delegate: true, captureLearning: (input) => {
      captureInput = input;
      return captureHumanChoiceLearning({ ...input, env: {}, resolveChannel: noChannel });
    },
  });
  assert.equal(delegated.counted, true);
  assert.equal(delegated.decision.delegated, true);
  assert.equal(delegated.decision.pick.label, first.state.recommended.label);
  assert.equal(captureInput.decision.delegated, true);
  assert.equal(delegated.learning.skippedReason, "delegated");

  const again = await createSet(work);
  assert.equal(again.created, false);
  assert.deepEqual(again.issues, ["human-choice-set-already-decided"]);
  await assert.rejects(createSet(work, { restart: true }), /--reason/u);
  const restarted = await createSet(work, { restart: true, restartReason: "合成の理由: 候補を出し直す" });
  assert.equal(restarted.created, true);
  assert.equal(restarted.state.decisions.length, 0);
  assert.equal(restarted.state.history.at(-1).decisions.length, 2);

  const noRecommendation = await createSet(work, { setId: "synthetic-round-2", input: candidatesInput({ recommended: undefined }) });
  const refused = await recordHumanChoice({ ...base, setId: "synthetic-round-2", delegate: true });
  assert.equal(noRecommendation.state.recommended, null);
  assert.deepEqual(refused.issues, ["human-choice-no-recommendation"]);
  const listed = await listHumanChoiceSets({ workDir: work });
  assert.deepEqual(listed.entries.map((row) => [row.setId, row.pass]), [["synthetic-round-1", false], ["synthetic-round-2", false]]);
});

test("理由は Channel Pack の非公開台帳の承認キューへ preference として積み、札の本文は定型で組をまたいで同じ提案として数える", async (t) => {
  const { work } = await workspace(t);
  const first = await createSet(work);
  const decide = (setId, reasons, note = "") => recordHumanChoice({
    workDir: work, stage: "thumbnail", setId, pick: "B", reasons, note, reviewer: REVIEWER, humanVerified: true, isInteractive: true, now,
  });
  const one = await decide("synthetic-round-1", ["strong-emotion", "reads-instantly"], "合成の一言: 表情が強い");
  const candidates = humanChoiceLearningCandidates({ state: one.state, decision: one.decision });
  assert.equal(candidates.length, 3);
  for (const candidate of candidates) {
    for (const forbidden of ["synthetic-round-1", "thumbs/", ".png", REVIEWER]) {
      assert.equal(candidate.text.includes(forbidden), false, `本文に ${forbidden} が運ばれた`);
    }
  }
  assert.match(candidates[0].text, /採点表に足す評価項目の候補: strong-emotion/u);
  assert.match(candidates[0].text, /asset-quality\.json の stages\.thumbnail の criteria/u);
  assert.match(candidates[1].text, /既定の評価項目 readable-at-decided-size/u);
  assert.match(candidates[2].text, /合成の一言: 表情が強い/u);

  const harness = captureHarness();
  const capture = (input) => captureHumanChoiceLearning({ ...input, env: {}, captureOptions: harness.options, resolveChannel: noChannel, now });
  const first1 = await capture({ state: one.state, decision: one.decision, workDir: work });
  assert.equal(first1.target, HARNESS_LEARNING_ROUTES["narrated-story-video"].channel);
  assert.equal(first1.captured, 3);
  assert.ok(harness.rows.every((row) => row.kind === "preference" && row.target === "channel-pack:narrated-story"));
  assert.ok(harness.rows.every((row) => String(row.evidence).startsWith(HUMAN_CHOICE_EVIDENCE_TAG)));
  assert.ok(harness.rows.every((row) => row.metadata === undefined && row.receiptDigest && row.harness?.id === "narrated-story-video"));
  // 同じ選択をもう一度積んでも増えない（冪等）。
  const repeat = await capture({ state: one.state, decision: one.decision, workDir: work });
  assert.equal(repeat.captured, 0);
  assert.equal(repeat.duplicates, 3);
  // 別の組で同じ札が選ばれると、同じ提案 id の別の session（再発として数える）。
  await createSet(work, { setId: "synthetic-round-2" });
  const two = await decide("synthetic-round-2", ["strong-emotion"]);
  const second = await capture({ state: two.state, decision: two.decision, workDir: work });
  assert.equal(second.captured, 1);
  const strong = harness.rows.filter((row) => row.text.includes("strong-emotion"));
  assert.equal(strong.length, 2);
  assert.equal(strong[0].id, strong[1].id);
  assert.notEqual(strong[0].session, strong[1].session);
  assert.equal(first.state.harnessId, "narrated-story-video");
  // 実物の captureLearningProposal が受ける形であること（上の harness は本物の関数に options を渡している）。
  assert.equal(typeof captureLearningProposal, "function");
});

test("学習の捕捉は子エージェント・自動捕捉の停止・チャンネルの決まらない作業フォルダでは積まず、チャンネルが決まればその保存先へ渡す", async (t) => {
  const { work } = await workspace(t);
  await createSet(work);
  const { state, decision } = await recordHumanChoice({
    workDir: work, stage: "thumbnail", setId: "synthetic-round-1", pick: "A", reasons: ["lettering"], reviewer: REVIEWER, humanVerified: true, isInteractive: true, now,
  });
  const spyRows = [];
  const spy = (input, options) => {
    spyRows.push({ input, options });
    return { appended: true, entry: { id: "bbbbbbbbbbbb" } };
  };
  assert.equal((await captureHumanChoiceLearning({ state, decision, env: childAgentEnvironment({}), capture: spy })).skippedReason, "child-agent");
  assert.equal((await captureHumanChoiceLearning({ state, decision, env: { BUZZASSIST_LEARNING_AUTO_CAPTURE: "0" }, capture: spy })).skippedReason, "disabled");
  const ambiguous = await captureHumanChoiceLearning({
    state, decision, env: {}, capture: spy, resolveChannel: async () => ({ channelId: "", selectedBy: null, skippedReason: "channel-learning-channel-ambiguous" }),
  });
  assert.equal(ambiguous.skippedReason, "channel-learning-channel-ambiguous");
  assert.equal(spyRows.length, 0);
  const channel = await captureHumanChoiceLearning({
    state, decision, env: {}, capture: spy, resolveChannel: async () => ({ channelId: "synthetic-channel", selectedBy: "explicit" }),
  });
  assert.equal(channel.channelId, "synthetic-channel");
  assert.equal(spyRows.length, 1);
  assert.equal(spyRows[0].options.channelId, "synthetic-channel");
  assert.equal(spyRows[0].input.kind, "preference");
  assert.equal((await captureHumanChoiceLearning({ state, decision: { ...decision, counted: false, attestedBy: "agent-self-attested" }, env: {}, capture: spy })).skippedReason, "not-human-verified");
});

test("ページのコマンドは選んだ案・札・一言・名前から、その端末でそのまま打てる形に組み立てる", async (t) => {
  const { work } = await workspace(t);
  const created = await createSet(work);
  const html = await readFile(created.pagePath, "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/u)[1];
  const inputs = {
    pick: { value: "B" },
    chips: [{ value: "reads-instantly" }, { value: "not-too-busy" }],
    note: "合成の 'ひとこと'\n改行",
    reviewer: "synthetic reviewer",
  };
  const nodes = { note: { value: inputs.note }, reviewer: { value: inputs.reviewer }, warn: { textContent: "" }, command: { textContent: "" }, copy: { addEventListener() {} } };
  const document = {
    querySelector: (selector) => (selector.includes("pick") ? inputs.pick : null),
    querySelectorAll: () => inputs.chips,
    getElementById: (id) => nodes[id],
    addEventListener() {},
  };
  const run = (userAgent) => {
    vm.runInNewContext(script, { document, navigator: { userAgent, clipboard: { writeText: async () => {} } } });
    return nodes.command.textContent;
  };
  const posix = run("Mozilla/5.0 (Macintosh)");
  assert.ok(posix.includes(`--set 'synthetic-round-1' --page-digest ${created.state.digest.slice(0, 16)}`), posix);
  assert.ok(posix.includes("--pick B --chip reads-instantly --chip not-too-busy"), posix);
  assert.ok(posix.includes(`--note '合成の '\\''ひとこと'\\'' 改行'`), posix);
  assert.ok(posix.endsWith("--reviewer 'synthetic reviewer' --human-verified"), posix);
  assert.equal(nodes.warn.textContent, "");
  const windows = run("Mozilla/5.0 (Windows NT 10.0)");
  assert.ok(windows.includes(`--note '合成の ''ひとこと'' 改行'`), windows);
  inputs.pick = { value: "delegate" };
  inputs.chips = [];
  assert.ok(run("Mozilla/5.0 (Macintosh)").includes("--delegate"));
});

test("CLI: 選ぶ人の端末では聞きながら答えられ、機械の記録は 3、人の選択が無い --require-choice は 4、--help では何も書かない", async (t) => {
  const { root, work } = await workspace(t);
  const out = [];
  const stdout = { write: (text) => out.push(text) };
  const env = { BUZZASSIST_LEARNING_AUTO_CAPTURE: "0" };
  const listPath = join(root, "candidates.json");
  await writeFile(listPath, JSON.stringify(candidatesInput()));
  const set = ["--work-dir", work, "--stage", "thumbnail", "--set", "synthetic-round-1"];
  assert.equal((await runHumanChoiceCli(["create", ...set, "--harness", "narrated-story-video", "--candidates", listPath, "--help"], { stdout })).exitCode, 0);
  await assert.rejects(stat(join(work, "quality")), /ENOENT/u, "--help で状態を書かない");
  assert.equal((await runHumanChoiceCli(["create", ...set, "--harness", "narrated-story-video", "--candidates", listPath, "--question", "どのサムネ案で進めますか"], { stdout, now })).exitCode, 0);
  assert.equal((await runHumanChoiceCli(["status", ...set, "--require-choice"], { stdout })).exitCode, 4);
  await assert.rejects(runHumanChoiceCli(["choose", ...set, "--reviewer", REVIEWER, "--agent-attested"], { stdout, env, isInteractive: false }), /--pick/u);
  assert.equal((await runHumanChoiceCli(["choose", ...set, "--pick", "A", "--chip", "lettering", "--reviewer", REVIEWER, "--agent-attested"], { stdout, env, now, isInteractive: false })).exitCode, 3);
  await assert.rejects(runHumanChoiceCli(["choose", ...set, "--reason", "x", "--pick", "A", "--reviewer", REVIEWER, "--agent-attested"], { stdout, env }), /create --restart/u);
  const answers = ["z", "D", "1 9", "1 6", "合成の一言です"];
  const asked = [];
  const interactive = await runHumanChoiceCli(["choose", ...set, "--reviewer", REVIEWER, "--human-verified", "--json"], {
    stdout, env, now, isInteractive: true, ask: async (question) => {
      asked.push(question);
      return answers.shift();
    },
  });
  assert.equal(interactive.exitCode, 0);
  assert.equal(interactive.result.decision.pick.label, "D");
  assert.deepEqual(interactive.result.decision.reasons.map((row) => row.chip), ["reads-instantly", "not-too-busy"]);
  assert.equal(interactive.result.decision.note, "合成の一言です");
  assert.equal(interactive.result.learning.skippedReason, "disabled");
  assert.equal(asked.length, 5, "候補の記号・札の番号の誤りは聞き直す");
  assert.equal((await runHumanChoiceCli(["status", ...set, "--require-choice"], { stdout })).exitCode, 0);
  assert.equal((await runHumanChoiceCli(["status", "--work-dir", work, "--require-choice"], { stdout })).exitCode, 0);
  // やめたら何も記録しない。
  const quit = await runHumanChoiceCli(["choose", ...set, "--reviewer", REVIEWER, "--human-verified"], { stdout, env, now, isInteractive: true, ask: async () => "q" });
  assert.equal(quit.exitCode, 3);
  out.length = 0;
  assert.equal((await runHumanChoiceCli(["routes", "--stage", "thumbnail", "--json"], { stdout })).exitCode, 0);
  assert.equal(JSON.parse(out.join("")).chips.length, HUMAN_CHOICE_STAGES.thumbnail.chips.length);
  await assert.rejects(runHumanChoiceCli(["choose", "--nope"], { stdout }), /不明なオプション/u);
});
