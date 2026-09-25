// 運営者の端末から提供元へ学習を届ける流れ（同意・決着時の自動 bundle・送信待ち・送信・削除）の試験。
//
// 人名・チャンネルの語・提案・Job・鍵はすべて合成。学習の置き場は一時ディレクトリ（BUZZASSIST_LEARNING_DIR）、
// 配る側の写し（ハーネス宣言・公開 catalog・検査語彙）も一時ディレクトリに作る。本物の HOME・リポジトリの台帳には
// 書かず、送信先は localhost の偽サーバーだけ（外部のネットワークへは出ない）。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { publicKeyId } from "../lib/channelPackEnvelope.mjs";
import {
  assertFeedbackPayloadPrivacy,
  autoFeedbackBundleDigest,
  generalizeProposalText,
  loadFeedbackPrivacyContext,
  normalizeAutoFeedbackPayload,
  signProviderIngestReceipt,
  validateAutoFeedbackBundleForTransport,
  verifyAutoFeedbackBundle,
  verifyProviderIngestReceipt,
} from "../lib/harnessFeedbackAutoBundle.mjs";
import {
  feedbackOutboxPaths,
  flushFeedbackOutbox,
  listFeedbackOutbox,
  promptFeedbackConsent,
  purgeFeedbackOutbox,
  queueJobSettlementFeedback,
  readFeedbackDestination,
  recordFeedbackConsent,
  writeFeedbackDestination,
} from "../lib/harnessFeedbackOutbox.mjs";
import { childAgentEnvironment } from "../lib/harnessLearningGuard.mjs";
import { readFeedbackConsent, resolveLearningState, sharedLedgerPath } from "../lib/harnessLearningState.mjs";
import { captureSettledJobLearning } from "../lib/harnessReceiptLearning.mjs";
import { buildSensitiveVocabularyDigest, SENSITIVE_VOCABULARY_KEY_ENV } from "../lib/packageTarballAudit.mjs";
import { proposalId } from "../scripts/harness-learn.mjs";
import { finalizedReceipt, hostCall, invocationRecord } from "./fixtures/hostInvocationFixtures.mjs";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = "narrated-story-video";
const TEST_VOCABULARY_KEY = "6e".repeat(32);
// 合成の語。検査語彙（鍵つき digest）と Channel Pack の語の両方の経路を試す。
const PRIVATE_TERM = "fictional-client-zz";
const PRIVATE_NAME = "架空花子";
const CHANNEL_TERM = "架空町商店街";
const CAST_ID = "cast-zeta-01";
const PACK_SENTENCE = "架空の番組では毎回かならず冒頭で鐘を三回鳴らす";
const SIGNALS = { terms: [CHANNEL_TERM], castIds: [CAST_ID], sentences: [PACK_SENTENCE] };
const GENERAL_TEXT = "長い工程を始める前に空き容量を確かめ、足りなければ先に片付けてから始める。";
const NOW = "2026-09-25T01:00:00.000Z";

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function row({ kind = "preference", target = `genre:${HARNESS}`, text, session, evidence = `運営者の発言そのまま ${PRIVATE_NAME}`, ...rest }) {
  const entry = { kind, target, text, evidence, session, capturedAt: "2026-09-25T00:00:00.000Z", ...rest };
  return { ...entry, id: proposalId(entry) };
}

/** 配る側の写し（合成）と、学習の置き場（合成）を作る。 */
function fixture(t, { vocabulary = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "feedback-outbox-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codeRoot = path.join(root, "code");
  const homeDir = path.join(root, "home");
  write(path.join(codeRoot, "package.json"), JSON.stringify({ name: "synthetic-core", version: "9.9.9" }));
  const declaration = `${HARNESS}.harness.json`;
  write(path.join(codeRoot, "config", "harnesses", declaration), fs.readFileSync(path.join(SOURCE_ROOT, "config", "harnesses", declaration), "utf8"));
  if (vocabulary) {
    write(
      path.join(codeRoot, "docs", "learning", "sensitive-vocabulary.digest.json"),
      JSON.stringify(buildSensitiveVocabularyDigest([PRIVATE_TERM, PRIVATE_NAME], { key: TEST_VOCABULARY_KEY, generatedAt: NOW })),
    );
  }
  const known = row({ kind: "fact", target: "platform:platform-craft", text: "合成の既知の提案: 再送は上限つきの指数バックオフにする", session: "session-synthetic-known" });
  write(path.join(codeRoot, "docs", "learning", "proposals.public.jsonl"), `${JSON.stringify({ id: known.id, kind: known.kind, target: known.target })}\n`);
  const learningDir = path.join(root, "learning");
  const env = { BUZZASSIST_LEARNING_DIR: learningDir, [SENSITIVE_VOCABULARY_KEY_ENV]: TEST_VOCABULARY_KEY };
  const state = resolveLearningState({ codeRoot, env, homeDir, developmentCheckout: false });
  return { root, codeRoot, homeDir, learningDir, env, state, known, paths: feedbackOutboxPaths(state) };
}

function privacy(fx) {
  return loadFeedbackPrivacyContext({ codeRoot: fx.codeRoot, operatorDir: fx.learningDir, env: fx.env, homeDir: fx.homeDir, signals: SIGNALS });
}

function writeLedger(fx, rows) {
  write(sharedLedgerPath(fx.state, "proposals"), rows.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
}

/** 提供元が知らない提案（一般化できるもの1件と、端末に残すべきもの）。 */
function heldRows() {
  return {
    privateTerm: row({ text: `${PRIVATE_TERM} の案件では最終確認を二回に分けて行う`, session: "session-synthetic-b" }),
    privateName: row({ text: `${PRIVATE_NAME}さんの指摘どおり冒頭の説明を短くまとめる`, session: "session-synthetic-c" }),
    channelTerm: row({ text: `${CHANNEL_TERM}の場面では照明を一段落としてから撮る`, session: "session-synthetic-d" }),
    castId: row({ text: `${CAST_ID} の声は低めに合わせる調整を先に行う`, session: "session-synthetic-e" }),
    packSentence: row({ text: `前置き: ${PACK_SENTENCE}`, session: "session-synthetic-f" }),
    machinePath: row({ text: "作業の一時ファイルは ~/synthetic-cache/work に残さず片付けてから終える", session: "session-synthetic-g" }),
    windowsPath: row({ text: "作業の一時ファイルは C:\\Users\\example\\work に残さず片付ける", session: "session-synthetic-h" }),
    quote: row({ text: "冒頭は「これは台本の一文をそのまま引用した長い文章の例です」の形にしない", session: "session-synthetic-i" }),
    url: row({ text: "参考は https://example.invalid/page を見てから決めること", session: "session-synthetic-j" }),
    short: row({ text: "短すぎる指摘", session: "session-synthetic-k" }),
    blocked: row({ text: "合成: 書き込み前の検査に当たった提案の文", session: "session-synthetic-l", blocked: { version: "buzzassist-learning-inspection-v1", reasons: ["absolute-path"] } }),
    channelTarget: row({ target: "channel-pack:narrated-story", text: "合成: 運営者専用の台帳へ向けた提案の文", session: "session-synthetic-m" }),
  };
}

const EXPECTED_HOLD = {
  privateTerm: "private-term",
  privateName: "private-term",
  channelTerm: "channel-term",
  castId: "channel-term",
  packSentence: "channel-term",
  machinePath: "machine-path",
  windowsPath: "machine-path",
  quote: "verbatim-quote",
  url: "url",
  short: "too-short",
  blocked: "blocked",
  channelTarget: "channel-target",
};

function standardLedger(fx) {
  const general = row({ text: GENERAL_TEXT, session: "session-synthetic-a1" });
  const generalAgain = row({ text: GENERAL_TEXT, session: "session-synthetic-a2" });
  const held = heldRows();
  writeLedger(fx, [fx.known, general, generalAgain, ...Object.values(held)]);
  return { general, held };
}

function settledJob(fx, { id = "video-synthetic-fb-0001", failing = ["audio-loudness"] } = {}) {
  const receipt = finalizedReceipt(invocationRecord(hostCall()), { failing });
  const receiptPath = path.join(fx.root, "runs", id, "run-receipt.json");
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  write(receiptPath, bytes);
  return {
    id,
    status: "failed",
    revision: 3,
    updatedAt: NOW,
    harness: { id: HARNESS, declarationVersion: "1.7.0" },
    stages: [{ id: "render", status: "failed" }],
    knownRemainingIssues: [],
    blockers: [`render-timeout: ${PRIVATE_NAME} の台本の途中で止まった`, `${PRIVATE_TERM}-missing: 合成の失敗`],
    metadata: { invocation: invocationRecord(hostCall()) },
    artifacts: [{ kind: "run-receipt", path: receiptPath, sha256: sha256(bytes) }],
  };
}

function queue(fx, job, extra = {}) {
  return queueJobSettlementFeedback({
    job,
    env: fx.env,
    codeRoot: fx.codeRoot,
    homeDir: fx.homeDir,
    state: fx.state,
    privacy: privacy(fx),
    now: () => NOW,
    ...extra,
  });
}

function outboxFiles(fx) {
  try { return fs.readdirSync(fx.paths.outboxDir).filter((name) => name.endsWith(".json")); } catch { return []; }
}

function readOutboxBundle(fx, digest) {
  return JSON.parse(fs.readFileSync(path.join(fx.paths.outboxDir, `${digest}.json`), "utf8"));
}

/**
 * 受け取る側の偽サーバー（localhost）。送り手の署名を検証し、digest で冪等に受け、提供元の鍵で
 * 署名した受領証を返す。plan は1回ごとの応答（数値は HTTP の失敗、"accept"、"wrong-key"）。
 */
async function fakeProvider(t, fx, { plan = [], tls = null } = {}) {
  const provider = generateKeyPairSync("ed25519");
  const impostor = generateKeyPairSync("ed25519");
  const pem = (pair) => pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const accepted = new Map();
  const requests = [];
  const handler = async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    requests.push({ method: request.method, url: request.url, header: request.headers["x-buzzassist-feedback-bundle-sha256"] });
    const step = plan.length > 0 ? plan.shift() : "accept";
    if (typeof step === "number") {
      response.writeHead(step, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, code: step === 422 ? "FEEDBACK_PROPOSAL_NOT_REGISTERED" : "SYNTHETIC_UNAVAILABLE" }));
      return;
    }
    const bundle = JSON.parse(body.toString("utf8"));
    verifyAutoFeedbackBundle({ bundle, trustedPublicKeyPem: fs.readFileSync(fx.paths.publicKey, "utf8") });
    const digest = autoFeedbackBundleDigest(bundle);
    const duplicate = accepted.has(digest);
    if (!duplicate) accepted.set(digest, bundle);
    const receipt = signProviderIngestReceipt({
      bundleDigest: digest,
      duplicate,
      receivedAt: "2026-09-25T02:00:00.000Z",
      privateKeyPem: step === "wrong-key" ? pem(impostor) : pem(provider),
    });
    response.writeHead(duplicate ? 200 : 202, { "content-type": "application/json" });
    response.end(JSON.stringify(receipt));
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  const host = tls ? "localhost" : "127.0.0.1";
  return {
    endpoint: `${tls ? "https" : "http"}://${host}:${server.address().port}/v2/feedback/bundles`,
    fingerprint: publicKeyId(provider.publicKey),
    impostorFingerprint: publicKeyId(impostor.publicKey),
    accepted,
    requests,
    plan,
  };
}

const noSleep = async () => {};

test("同意が無ければ bundle を作らず、置き場も作らず、送らない。取り消しと子エージェントでも作らない", async (t) => {
  const fx = fixture(t);
  standardLedger(fx);
  const job = settledJob(fx);
  const none = await queue(fx, job);
  assert.deepEqual(none, { status: "skipped", reason: "no-consent" });
  assert.equal(fs.existsSync(fx.state.feedbackDir), false, "同意が無いのに置き場を作った");
  assert.deepEqual(await flushFeedbackOutbox({ state: fx.state, env: fx.env, codeRoot: fx.codeRoot }), { status: "skipped", reason: "no-consent" });

  recordFeedbackConsent({ state: fx.state, enabled: false, now: NOW });
  assert.equal(readFeedbackConsent(fx.state).recorded, true);
  assert.deepEqual(await queue(fx, job), { status: "skipped", reason: "consent-disabled" });
  assert.deepEqual(outboxFiles(fx), []);

  recordFeedbackConsent({ state: fx.state, enabled: true, scopes: ["settlements", "proposals", "new-candidates"], now: NOW });
  assert.deepEqual(await queue(fx, job, { env: childAgentEnvironment(fx.env) }), { status: "skipped", reason: "child-agent" });
  assert.deepEqual(outboxFiles(fx), []);

  // 壊れた同意の記録は「同意なし」。
  write(path.join(fx.state.feedbackDir, "consent.json"), "{\"version\":\"buzzassist-feedback-consent-v1\",\"enabled\":\"yes\"}");
  assert.equal(readFeedbackConsent(fx.state).enabled, false);
  assert.deepEqual(await queue(fx, job), { status: "skipped", reason: "consent-invalid" });
  assert.equal(fs.existsSync(fx.homeDir), false, "本物の HOME 相当の場所に書いた");
});

test("同意すると署名鍵ができ、決着時に本文・パス・人名・チャンネルの語を含まない署名つき bundle が積まれる", async (t) => {
  const fx = fixture(t);
  const { general, held } = standardLedger(fx);
  const recorded = recordFeedbackConsent({ state: fx.state, enabled: true, scopes: ["settlements", "proposals", "new-candidates"], now: NOW });
  assert.match(recorded.signer.keyId, /^ed25519:[a-f0-9]{24}$/u);
  assert.equal(recorded.signer.created, true);
  if (process.platform !== "win32") assert.equal(fs.statSync(fx.paths.privateKey).mode & 0o777, 0o600);

  const job = settledJob(fx);
  const result = await queue(fx, job);
  assert.equal(result.status, "queued", JSON.stringify(result));
  assert.deepEqual(result.sections, { settlement: true, proposals: 1, newCandidates: 1 });
  assert.equal(result.held.newCandidates, Object.keys(held).length);
  assert.equal(result.send.status, "skipped");
  assert.equal(result.send.reason, "destination-unset");

  const bundle = readOutboxBundle(fx, result.bundleSha256);
  assert.equal(autoFeedbackBundleDigest(bundle), result.bundleSha256);
  verifyAutoFeedbackBundle({ bundle, trustedPublicKeyPem: fs.readFileSync(fx.paths.publicKey, "utf8") });
  assert.equal(bundle.signer.keyId, recorded.signer.keyId);
  // 宣言の版は Receipt が今の宣言から写す。宣言を上げるたびに試験が落ちないよう、宣言そのものから読む。
  const declaredVersion = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, "config", "harnesses", `${HARNESS}.harness.json`), "utf8")).version;
  assert.deepEqual(bundle.build, {
    coreVersion: "9.9.9",
    harnessId: HARNESS,
    harnessVersion: declaredVersion,
    declarationDigest: bundle.build.declarationDigest,
  });
  // 決着の要約: ゲート id と判定・件数・ホスト（invocation）だけ。
  const settlement = bundle.settlement;
  assert.deepEqual(settlement.gates.find((gate) => gate.gateId === "audio-loudness"), { gateId: "audio-loudness", verdict: "fail" });
  assert.equal(settlement.gateCounts.fail, 1);
  assert.equal(settlement.gateCounts.declared, settlement.gates.length);
  assert.equal(settlement.outcome, "fail");
  assert.deepEqual(settlement.failedStages, ["render"]);
  assert.equal(settlement.host.hostKey, "claude-code");
  assert.deepEqual(settlement.host.models, ["synthetic-model-a"]);
  assert.deepEqual(settlement.host.hostVersions, ["claude-code@9.9.1"]);
  // 自由文から作る issue のコードは、照合に当たれば unclassified へ丸める。
  assert.deepEqual(settlement.issueCodes, [{ code: "render-timeout", count: 1 }, { code: "unclassified", count: 1 }]);
  // 提案の要約: 既知の id と回数だけ。
  assert.deepEqual(bundle.proposals.map((entry) => [entry.id, entry.kind, entry.target, entry.occurrences]), [[fx.known.id, "fact", "platform:platform-craft", 1]]);
  // 未知の提案: 一般化できた1件だけ。根拠は種類だけ。
  assert.deepEqual(bundle.newCandidates.map((entry) => ({ ...entry, occurrenceDigests: entry.occurrenceDigests.length })), [{
    candidateId: general.id,
    kind: "preference",
    target: `genre:${HARNESS}`,
    generalizedText: GENERAL_TEXT,
    evidenceKinds: ["operator-preference"],
    occurrences: 2,
    occurrenceDigests: 2,
  }]);
  const raw = fs.readFileSync(path.join(fx.paths.outboxDir, `${result.bundleSha256}.json`), "utf8");
  for (const forbidden of [PRIVATE_TERM, PRIVATE_NAME, CHANNEL_TERM, CAST_ID, PACK_SENTENCE, "運営者の発言", "session-synthetic", "合成の既知の提案", fx.root, "~/", "run-receipt.json"]) {
    assert.equal(raw.includes(forbidden), false, `bundle に入れてはいけない文字列が入った: ${forbidden.slice(0, 12)}`);
  }
  // 送らずに端末へ残したものは id と理由のコードだけ。
  const heldFile = JSON.parse(fs.readFileSync(fx.paths.held, "utf8"));
  const reasonsById = new Map(heldFile.entries.map((entry) => [entry.id, entry.reasons]));
  for (const [name, reason] of Object.entries(EXPECTED_HOLD)) {
    assert.ok(reasonsById.get(held[name].id)?.includes(reason), `${name} は ${reason} で残すこと: ${JSON.stringify(reasonsById.get(held[name].id))}`);
  }
  assert.equal(JSON.stringify(heldFile).includes(PRIVATE_NAME), false);

  // 同じ決着はもう一度積まない。新しい出来事（別の session の再発）だけが次の bundle に入る。
  const again = await queue(fx, job);
  assert.equal(again.status, "skipped");
  assert.equal(again.reason, "settlement-already-queued");
  assert.equal(outboxFiles(fx).length, 1);
  writeLedger(fx, [fx.known, general, row({ text: GENERAL_TEXT, session: "session-synthetic-a2" }), row({ text: GENERAL_TEXT, session: "session-synthetic-a3" })]);
  const next = await queue(fx, settledJob(fx, { id: "video-synthetic-fb-0002", failing: [] }));
  assert.equal(next.status, "queued");
  const nextBundle = readOutboxBundle(fx, next.bundleSha256);
  assert.equal(nextBundle.proposals.length, 0, "送った出来事をもう一度数えた");
  assert.deepEqual(nextBundle.newCandidates.map((entry) => entry.occurrences), [1]);
  assert.equal(nextBundle.settlement.outcome, "pass");
  const events = readJsonl(fx.paths.events);
  assert.deepEqual(events.map((entry) => entry.status), ["queued", "skipped", "queued"]);
  assert.equal(JSON.stringify(events).includes(fx.root), false, "記録に端末のパスを残した");
  assert.equal(fs.existsSync(fx.homeDir), false);
});

test("bundle の照合と形の検査は、本文・パス・人名・チャンネルの語を入れた改変で落ちる", async (t) => {
  const fx = fixture(t);
  standardLedger(fx);
  recordFeedbackConsent({ state: fx.state, enabled: true, scopes: ["settlements", "proposals", "new-candidates"], now: NOW });
  const result = await queue(fx, settledJob(fx));
  const bundle = readOutboxBundle(fx, result.bundleSha256);
  const { signer: _signer, signature: _signature, ...payload } = bundle;
  const context = privacy(fx);
  assert.equal(assertFeedbackPayloadPrivacy(normalizeAutoFeedbackPayload(payload), context), true);

  const withText = (text) => {
    const copy = structuredClone(payload);
    copy.newCandidates[0].generalizedText = text;
    return copy;
  };
  const privacyCode = (value) => {
    try { assertFeedbackPayloadPrivacy(normalizeAutoFeedbackPayload(value), context); return "passed"; }
    catch (error) { return error.code || error.message; }
  };
  assert.equal(privacyCode(withText(`${GENERAL_TEXT}${PRIVATE_NAME}`)), "bundle-private-term");
  assert.equal(privacyCode(withText(`${GENERAL_TEXT}${PRIVATE_TERM}`)), "bundle-private-term");
  assert.equal(privacyCode(withText(`${GENERAL_TEXT}${CHANNEL_TERM}`)), "bundle-channel-term");
  assert.equal(privacyCode(withText(`${GENERAL_TEXT}${CAST_ID}`)), "bundle-channel-term");
  // 形の検査（語彙に依らない）は、正規化の時点で落ちる。
  for (const bad of [
    `${GENERAL_TEXT} ~/projects/demo`,
    `${GENERAL_TEXT} C:\\Users\\example\\demo`,
    `${GENERAL_TEXT} sk-proj-${"a".repeat(24)}`,
    `${GENERAL_TEXT} 「これは台本の一文をそのまま引用した長い文章の例です」`,
    `${GENERAL_TEXT}\n改行で項目の外へ出る`,
  ]) {
    assert.throws(() => normalizeAutoFeedbackPayload(withText(bad)), /送れない形|1行/u);
  }
  // 入れられる field を持たせない。
  const extraCandidateField = structuredClone(payload);
  extraCandidateField.newCandidates[0].evidence = "運営者の発言そのまま";
  assert.throws(() => normalizeAutoFeedbackPayload(extraCandidateField), /未許可field/u);
  const extraTopField = { ...structuredClone(payload), script: "台本の本文" };
  assert.throws(() => normalizeAutoFeedbackPayload(extraTopField), /未許可field/u);
  const extraSettlementField = structuredClone(payload);
  extraSettlementField.settlement.localPath = fx.root;
  assert.throws(() => normalizeAutoFeedbackPayload(extraSettlementField), /未許可field/u);
  const unknownGate = structuredClone(payload);
  unknownGate.settlement.gates.push({ gateId: "synthetic-undeclared-gate", verdict: "pass" });
  assert.throws(() => normalizeAutoFeedbackPayload(unknownGate), /既知gate/u);
  // 同意の範囲に無いものは入れられない。
  const outOfScope = { ...structuredClone(payload), consent: { ...payload.consent, scopes: ["proposals"] } };
  assert.throws(() => normalizeAutoFeedbackPayload(outOfScope), /同意の範囲/u);
  // 語彙を照合できない文脈では作らない。
  assert.throws(() => assertFeedbackPayloadPrivacy(normalizeAutoFeedbackPayload(payload), { ...context, available: false, vocabulary: null, reason: "vocabulary-missing-key" }), (error) => error.code === "vocabulary-missing-key");
  // 積んだあとに書き換えた bundle は署名で落ちる。
  const tampered = structuredClone(bundle);
  tampered.newCandidates[0].generalizedText = `${GENERAL_TEXT}（改変）`;
  assert.throws(() => verifyAutoFeedbackBundle({ bundle: tampered, trustedPublicKeyPem: fs.readFileSync(fx.paths.publicKey, "utf8") }), /署名/u);
  assert.equal(validateAutoFeedbackBundleForTransport(bundle).digest, result.bundleSha256);

  assert.deepEqual(generalizeProposalText("連絡は synthetic.person@example.invalid へ送ってから進める", context).reasons, ["contact-address"]);
  assert.deepEqual(generalizeProposalText(GENERAL_TEXT, context), { ok: true, text: GENERAL_TEXT, reasons: [] });
});

test("語彙を照合できない端末では作らず、理由だけを残す。運営者が置いた語彙があれば照合して作る", async (t) => {
  const fx = fixture(t, { vocabulary: false });
  standardLedger(fx);
  recordFeedbackConsent({ state: fx.state, enabled: true, now: NOW });
  const context = privacy(fx);
  assert.equal(context.available, false);
  assert.equal(context.reason, "vocabulary-missing-file");
  const result = await queue(fx, settledJob(fx));
  assert.deepEqual(result, { status: "skipped", reason: "vocabulary-missing-file" });
  assert.deepEqual(outboxFiles(fx), []);
  const events = readJsonl(fx.paths.events);
  assert.equal(events.at(-1).reason, "vocabulary-missing-file");
  assert.equal(JSON.stringify(events).includes(fx.root), false);

  // 配布物に語彙は入らないので、運営者は学習の置き場の直下に自分の語彙を置ける。
  write(
    path.join(fx.learningDir, "sensitive-vocabulary.digest.json"),
    JSON.stringify(buildSensitiveVocabularyDigest([PRIVATE_TERM, PRIVATE_NAME], { key: TEST_VOCABULARY_KEY, generatedAt: NOW })),
  );
  const operatorContext = privacy(fx);
  assert.equal(operatorContext.available, true);
  assert.equal(operatorContext.vocabularySource, "operator-state");
  const queued = await queue(fx, settledJob(fx, { id: "video-synthetic-fb-0003" }));
  assert.equal(queued.status, "queued");
});

test("送り先が未設定なら貯めるだけで、outbox に件数と理由が見える。同意の範囲を狭めたら広い範囲の bundle は送らない", async (t) => {
  const fx = fixture(t);
  standardLedger(fx);
  recordFeedbackConsent({ state: fx.state, enabled: true, scopes: ["settlements", "proposals", "new-candidates"], now: NOW });
  const first = await queue(fx, settledJob(fx));
  const second = await queue(fx, settledJob(fx, { id: "video-synthetic-fb-0004", failing: [] }));
  assert.equal(first.send.reason, "destination-unset");
  assert.equal(second.send.reason, "destination-unset");
  const listed = await listFeedbackOutbox({ state: fx.state, codeRoot: fx.codeRoot, env: fx.env, homeDir: fx.homeDir, privacy: privacy(fx) });
  assert.equal(listed.consent.enabled, true);
  assert.equal(listed.destination.configured, false);
  assert.equal(listed.vocabulary.available, true);
  assert.equal(listed.pending.length, 2);
  assert.deepEqual(listed.pending.map((entry) => entry.status), ["pending", "pending"]);
  assert.equal(listed.sent.count, 0);
  assert.equal(listed.held.byReason["channel-term"], 3);
  assert.match(listed.signer.keyId, /^ed25519:[a-f0-9]{24}$/u);
  assert.equal(JSON.stringify(listed).includes(PRIVATE_NAME), false);

  const provider = await fakeProvider(t, fx);
  writeFeedbackDestination({ state: fx.state, endpoint: provider.endpoint, providerKeyFingerprint: provider.fingerprint, now: NOW });
  recordFeedbackConsent({ state: fx.state, enabled: true, scopes: ["settlements"], now: NOW });
  const narrowed = await flushFeedbackOutbox({ state: fx.state, env: fx.env, codeRoot: fx.codeRoot, sleep: noSleep });
  assert.equal(narrowed.status, "flushed");
  assert.equal(narrowed.held, 1, JSON.stringify(narrowed.results));
  assert.equal(provider.accepted.size, 1, "未知の提案の文を、同意を狭めたあとに送った");
  assert.equal(narrowed.results.find((entry) => entry.status === "held").code, "consent-narrowed");
});

test("偽の提供元へ送る: 5xx は再送して届き、届いたものは二度と送らない。受理後に切れても二重に数えない", async (t) => {
  const fx = fixture(t);
  standardLedger(fx);
  recordFeedbackConsent({ state: fx.state, enabled: true, scopes: ["settlements", "proposals", "new-candidates"], now: NOW });
  const provider = await fakeProvider(t, fx, { plan: [503] });
  writeFeedbackDestination({ state: fx.state, endpoint: provider.endpoint, providerKeyFingerprint: provider.fingerprint, now: NOW });

  const queued = await queue(fx, settledJob(fx), { sendOptions: { sleep: noSleep } });
  assert.equal(queued.status, "queued");
  assert.equal(queued.send.delivered, 1, JSON.stringify(queued.send));
  assert.equal(provider.requests.length, 2);
  assert.ok(provider.requests.every((request) => request.method === "POST" && request.url === "/v2/feedback/bundles" && request.header === queued.bundleSha256));
  const journal = JSON.parse(fs.readFileSync(path.join(fx.paths.journalDir, `${queued.bundleSha256}.json`), "utf8"));
  assert.deepEqual(journal.attempts.map((attempt) => [attempt.httpStatus, attempt.result]), [[503, "retryable"], [202, "delivered"]]);
  assert.equal(journal.status, "delivered");
  const sentRows = readJsonl(fx.paths.sentLog);
  assert.deepEqual(sentRows.map((entry) => [entry.bundleSha256, entry.providerKeyId, entry.duplicate]), [[queued.bundleSha256, provider.fingerprint, false]]);
  assert.ok(Number.isFinite(Date.parse(sentRows[0].sentAt)));
  assert.deepEqual(outboxFiles(fx), []);
  assert.equal(fs.existsSync(path.join(fx.paths.sentDir, `${queued.bundleSha256}.json`)), true);

  // 二重送信の防止: もう一度送っても、同じ bundle が送信待ちへ戻っても、送らない。
  const again = await flushFeedbackOutbox({ state: fx.state, env: fx.env, codeRoot: fx.codeRoot, sleep: noSleep });
  assert.equal(again.attempted, 0);
  fs.copyFileSync(path.join(fx.paths.sentDir, `${queued.bundleSha256}.json`), path.join(fx.paths.outboxDir, `${queued.bundleSha256}.json`));
  const reappeared = await flushFeedbackOutbox({ state: fx.state, env: fx.env, codeRoot: fx.codeRoot, sleep: noSleep });
  assert.equal(reappeared.alreadySent, 1);
  assert.equal(provider.requests.length, 2, "届いた bundle をもう一度送った");
  assert.deepEqual(outboxFiles(fx), []);

  // 受け取る側が受理したあとに接続が切れた: 再送は受け取る側で冪等（duplicate）になり、届いた記録は1行。
  let cut = false;
  const flaky = async (url, init) => {
    const response = await fetch(url, init);
    if (!cut) {
      cut = true;
      await response.text();
      throw new Error("synthetic connection reset after accept");
    }
    return response;
  };
  const second = await queue(fx, settledJob(fx, { id: "video-synthetic-fb-0005", failing: [] }), { sendOptions: { sleep: noSleep, fetchImpl: flaky } });
  assert.equal(second.send.delivered, 1, JSON.stringify(second.send));
  assert.equal(second.send.results[0].duplicate, true);
  assert.equal(provider.accepted.size, 2);
  const rows = readJsonl(fx.paths.sentLog);
  assert.equal(rows.filter((entry) => entry.bundleSha256 === second.bundleSha256).length, 1);
});

test("受領証が設定した提供元の鍵で署名されていなければ届いたと記録しない。4xx は恒久失敗、再送は上限で止まる", async (t) => {
  const fx = fixture(t);
  standardLedger(fx);
  recordFeedbackConsent({ state: fx.state, enabled: true, scopes: ["settlements", "proposals", "new-candidates"], now: NOW });
  const provider = await fakeProvider(t, fx, { plan: ["wrong-key"] });
  writeFeedbackDestination({ state: fx.state, endpoint: provider.endpoint, providerKeyFingerprint: provider.fingerprint, now: NOW });

  const untrusted = await queue(fx, settledJob(fx), { sendOptions: { sleep: noSleep } });
  assert.equal(untrusted.send.permanentFailure, 1);
  assert.equal(untrusted.send.results[0].code, "receipt-untrusted");
  assert.deepEqual(readJsonl(fx.paths.sentLog), []);
  assert.equal(outboxFiles(fx).length, 1);
  // 自動送信は恒久失敗を試し直さない。運営者の send は試し直し、正しい受領証で届く。
  const auto = await flushFeedbackOutbox({ state: fx.state, env: fx.env, codeRoot: fx.codeRoot, mode: "auto", sleep: noSleep });
  assert.equal(auto.attempted, 0);
  assert.equal(provider.requests.length, 1);
  const manual = await flushFeedbackOutbox({ state: fx.state, env: fx.env, codeRoot: fx.codeRoot, mode: "manual", sleep: noSleep });
  assert.equal(manual.delivered, 1);
  assert.equal(manual.results[0].duplicate, true, "受け取る側は同じ digest を冪等に受けた");

  // 指紋を別の鍵にしていれば、正しく署名された受領証でも届いたと記録しない。
  writeFeedbackDestination({ state: fx.state, endpoint: provider.endpoint, providerKeyFingerprint: provider.impostorFingerprint, now: NOW });
  const mismatch = await queue(fx, settledJob(fx, { id: "video-synthetic-fb-0006", failing: [] }), { sendOptions: { sleep: noSleep } });
  assert.equal(mismatch.send.results[0].code, "receipt-untrusted");
  writeFeedbackDestination({ state: fx.state, endpoint: provider.endpoint, providerKeyFingerprint: provider.fingerprint, now: NOW });

  provider.plan.push(422);
  const rejected = await flushFeedbackOutbox({ state: fx.state, env: fx.env, codeRoot: fx.codeRoot, mode: "manual", sleep: noSleep });
  assert.equal(rejected.results[0].status, "permanent-failure");
  assert.equal(rejected.results[0].code, "FEEDBACK_PROPOSAL_NOT_REGISTERED");

  // 上限: 何度でも 503 なら、試行の上限で止まり、自動送信はそれ以上試さない。
  provider.plan.push(...Array.from({ length: 20 }, () => 503));
  const before = provider.requests.length;
  const exhausted = await flushFeedbackOutbox({ state: fx.state, env: fx.env, codeRoot: fx.codeRoot, mode: "manual", maxAttempts: 3, maxTotalAttempts: 3, sleep: noSleep });
  assert.equal(exhausted.results[0].status, "exhausted");
  const afterManual = provider.requests.length;
  assert.equal(afterManual - before, 3);
  const autoAfter = await flushFeedbackOutbox({ state: fx.state, env: fx.env, codeRoot: fx.codeRoot, mode: "auto", maxTotalAttempts: 3, sleep: noSleep });
  assert.equal(autoAfter.attempted, 0);
  assert.equal(provider.requests.length, afterManual);
  assert.equal(readJsonl(fx.paths.sentLog).length, 1);
});

test("HTTPS の偽サーバーへ、CLI の send で届く（本物の HOME には書かない）", async (t) => {
  const fx = fixture(t);
  const tlsDir = path.join(fx.root, "tls");
  fs.mkdirSync(tlsDir, { recursive: true });
  const generated = spawnSync("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", path.join(tlsDir, "key.pem"), "-out", path.join(tlsDir, "cert.pem"), "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { encoding: "utf8" });
  if (generated.error || generated.status !== 0) {
    t.skip("openssl が無いので HTTPS の偽サーバーを作れない");
    return;
  }
  standardLedger(fx);
  recordFeedbackConsent({ state: fx.state, enabled: true, scopes: ["settlements", "proposals", "new-candidates"], now: NOW });
  const queued = await queue(fx, settledJob(fx));
  assert.equal(queued.send.reason, "destination-unset");
  const provider = await fakeProvider(t, fx, {
    plan: [503],
    tls: { key: fs.readFileSync(path.join(tlsDir, "key.pem")), cert: fs.readFileSync(path.join(tlsDir, "cert.pem")) },
  });
  assert.match(provider.endpoint, /^https:\/\/localhost:\d+\/v2\/feedback\/bundles$/u);
  writeFeedbackDestination({ state: fx.state, endpoint: provider.endpoint, providerKeyFingerprint: provider.fingerprint, now: NOW });

  const env = { ...process.env, HOME: fx.homeDir, USERPROFILE: fx.homeDir, BUZZASSIST_LEARNING_DIR: fx.learningDir, NODE_EXTRA_CA_CERTS: path.join(tlsDir, "cert.pem") };
  delete env.BUZZASSIST_LEARNING_WRITE_FORBIDDEN;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SOURCE_ROOT, "scripts", "harness-feedback.mjs"), "send"], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`send exited ${code}: ${stderr}`))));
  });
  const result = JSON.parse(output);
  assert.equal(result.delivered, 1, output);
  assert.equal(provider.requests.length, 2);
  assert.equal(provider.accepted.has(queued.bundleSha256), true);
  assert.equal(readJsonl(fx.paths.sentLog)[0].bundleSha256, queued.bundleSha256);
  assert.equal(fs.existsSync(path.join(fx.homeDir, ".buzzassist")), false, "HOME の下に書いた");
});

test("送り先は HTTPS・credential と query 無し・決まった path・提供元の鍵の指紋だけを受ける。壊れた設定では送らない", (t) => {
  const fx = fixture(t);
  const fingerprint = `ed25519:${"a".repeat(24)}`;
  for (const endpoint of [
    "http://feedback.example.test/v2/feedback/bundles",
    "https://user:pass@feedback.example.test/v2/feedback/bundles",
    "https://feedback.example.test/v2/feedback/bundles?token=x",
    "https://feedback.example.test/v1/feedback/bundles",
    "not a url",
  ]) {
    assert.throws(() => writeFeedbackDestination({ state: fx.state, endpoint, providerKeyFingerprint: fingerprint }), /feedback upload/u, endpoint);
  }
  assert.throws(() => writeFeedbackDestination({ state: fx.state, endpoint: "https://feedback.example.test/", providerKeyFingerprint: "sha256:abc" }), /指紋/u);
  const stored = writeFeedbackDestination({ state: fx.state, endpoint: "https://feedback.example.test/", providerKeyFingerprint: fingerprint.toUpperCase().replace("ED25519", "ed25519") });
  assert.equal(stored.endpoint, "https://feedback.example.test/v2/feedback/bundles");
  assert.equal(stored.providerKeyFingerprint, fingerprint);
  assert.equal(readFeedbackDestination({ state: fx.state, codeRoot: fx.codeRoot }).configured, true);
  write(fx.paths.destination, JSON.stringify({ version: "buzzassist-feedback-destination-v1", endpoint: "http://feedback.example.test/", providerKeyFingerprint: fingerprint }));
  assert.deepEqual(readFeedbackDestination({ state: fx.state, codeRoot: fx.codeRoot }), { configured: false, invalid: true, source: "operator" });

  // 受領証の検査そのもの。
  const provider = generateKeyPairSync("ed25519");
  const privateKeyPem = provider.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const digest = "b".repeat(64);
  const receipt = signProviderIngestReceipt({ bundleDigest: digest, privateKeyPem, receivedAt: NOW });
  const providerKeyFingerprint = publicKeyId(provider.publicKey);
  assert.equal(verifyProviderIngestReceipt({ receipt, bundleDigest: digest, providerKeyFingerprint }).providerKeyId, providerKeyFingerprint);
  assert.throws(() => verifyProviderIngestReceipt({ receipt, bundleDigest: "c".repeat(64), providerKeyFingerprint }), /digest/u);
  assert.throws(() => verifyProviderIngestReceipt({ receipt: { ...receipt, duplicate: true }, bundleDigest: digest, providerKeyFingerprint }), /署名/u);
  assert.throws(() => verifyProviderIngestReceipt({ receipt, bundleDigest: digest, providerKeyFingerprint: fingerprint }), /指紋/u);
});

test("Windows のパスでも、同意と送信待ちの置き場を同じ規則で組み立てる", () => {
  const home = "C:\\Users\\example";
  const installed = resolveLearningState({ codeRoot: "C:\\buzzassist\\plugin", env: {}, homeDir: home, pathApi: path.win32, developmentCheckout: false });
  assert.equal(installed.feedbackDir, path.win32.join(home, ".buzzassist", "learning", "feedback"));
  const paths = feedbackOutboxPaths(installed, path.win32);
  assert.equal(paths.consent, path.win32.join(installed.feedbackDir, "consent.json"));
  assert.equal(paths.outboxDir, path.win32.join(installed.feedbackDir, "outbox"));
  assert.equal(paths.privateKey, path.win32.join(installed.feedbackDir, "keys", "operator-feedback-ed25519.pem"));
  const development = resolveLearningState({ codeRoot: "C:\\src\\buzzassist", env: {}, homeDir: home, pathApi: path.win32, developmentCheckout: true });
  assert.equal(development.feedbackDir, path.win32.join(home, ".buzzassist", "learning", "feedback"), "開発用チェックアウトでも同意はリポジトリの外に置く");
  const overridden = resolveLearningState({ codeRoot: "C:\\buzzassist\\plugin", env: { BUZZASSIST_LEARNING_DIR: "D:\\state\\learning" }, homeDir: home, pathApi: path.win32, developmentCheckout: false });
  assert.equal(overridden.feedbackDir, path.win32.join("D:\\state\\learning", "feedback"));
});

test("setup の質問は対話の端末でだけ聞き、対話でなければ未同意のまま。断ったら次は聞かない", async (t) => {
  const answer = async (state, answers) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const queue = [...answers];
    output.on("data", (chunk) => {
      if (String(chunk).includes("[y/N]") && queue.length > 0) setImmediate(() => input.write(`${queue.shift()}\n`));
    });
    return promptFeedbackConsent({ state, input, output, interactive: true, now: () => NOW });
  };
  const fx = fixture(t);
  const skipped = await promptFeedbackConsent({ state: fx.state, input: new PassThrough(), output: new PassThrough(), now: () => NOW });
  assert.deepEqual(skipped, { asked: false, status: "unset", reason: "non-interactive" });
  assert.equal(fs.existsSync(fx.state.feedbackDir), false);

  const declined = await answer(fx.state, ["n"]);
  assert.deepEqual(declined, { asked: true, status: "disabled", scopes: [] });
  assert.equal(readFeedbackConsent(fx.state).via, "setup");
  assert.deepEqual(await promptFeedbackConsent({ state: fx.state, interactive: true }), { asked: false, status: "disabled", scopes: [] });

  const other = fixture(t);
  const accepted = await answer(other.state, ["y", "n"]);
  assert.equal(accepted.status, "enabled");
  assert.deepEqual(accepted.scopes, ["settlements", "proposals"], "未知の提案の文は明示したときだけ");
  assert.match(accepted.signerKeyId, /^ed25519:/u);
  const all = fixture(t);
  assert.deepEqual((await answer(all.state, ["y", "y"])).scopes, ["settlements", "proposals", "new-candidates"]);
});

test("Job の決着（captureSettledJobLearning）から呼ばれ、失敗しても結果を返す。差し替えた呼び出しと子エージェントでは呼ばない", async (t) => {
  const fx = fixture(t);
  const indexPath = path.join(fx.root, "index.jsonl");
  const job = { ...settledJob(fx), artifacts: [] };
  const noCapture = () => ({ appended: false });
  const calls = [];
  const called = await captureSettledJobLearning({
    job, env: {}, capture: noCapture, receiptIndexPath: indexPath, locateReceipt: async () => null,
    queueFeedback: async (input) => { calls.push(input); return { status: "skipped", reason: "no-consent" }; },
  });
  assert.deepEqual(called.feedback, { status: "skipped", reason: "no-consent" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].job, job);
  assert.equal(calls[0].trigger, "job-settled");
  assert.equal(calls[0].codeRoot, SOURCE_ROOT);

  const failing = await captureSettledJobLearning({
    job, env: {}, capture: noCapture, receiptIndexPath: indexPath, locateReceipt: async () => null,
    queueFeedback: async () => { throw new Error("synthetic feedback failure"); },
  });
  assert.deepEqual(failing.feedback, { status: "failed", reason: "feedback-error" });

  const plain = await captureSettledJobLearning({ job, env: {}, capture: noCapture, receiptIndexPath: indexPath, locateReceipt: async () => null });
  assert.equal("feedback" in plain, false, "試験の差し替えで本物の置き場の同意を読みに行った");
  const child = await captureSettledJobLearning({ job, env: childAgentEnvironment({}), capture: noCapture, receiptIndexPath: indexPath, queueFeedback: async () => { throw new Error("呼ばれてはいけない"); } });
  assert.equal(child.feedback, undefined);
});

test("purge は --confirm が無ければ消さず、消しても届いた記録と入れ済みの指紋は残す", async (t) => {
  const fx = fixture(t);
  standardLedger(fx);
  recordFeedbackConsent({ state: fx.state, enabled: true, scopes: ["settlements", "proposals", "new-candidates"], now: NOW });
  const job = settledJob(fx);
  const queued = await queue(fx, job);
  assert.equal(queued.status, "queued");
  assert.deepEqual(await purgeFeedbackOutbox({ state: fx.state }), { dryRun: true, wouldRemove: { outbox: 1, sentCopies: 0 } });
  assert.equal(outboxFiles(fx).length, 1);
  const purged = await purgeFeedbackOutbox({ state: fx.state, confirm: true, now: () => NOW });
  assert.deepEqual(purged, { dryRun: false, removed: { outbox: 1, sentCopies: 0 } });
  assert.deepEqual(outboxFiles(fx), []);
  assert.equal(fs.existsSync(path.join(fx.paths.journalDir, `${queued.bundleSha256}.json`)), false);
  assert.equal(fs.existsSync(fx.paths.reported), true);
  // 消したものを同じ決着から作り直さない（運営者が捨てると決めたもの）。
  assert.equal((await queue(fx, job)).reason, "settlement-already-queued");
  assert.equal(readJsonl(fx.paths.events).at(-2).action, "purge");
});
