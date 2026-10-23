// 本番と予備の構成の記録（採用の記録）——10カット試験のあと、運営者が決めた2案を残す。
//
// 決めるのは運営者。ここは「どの候補を本番に、どれを予備にしたか」と、その根拠（試験の数字・
// 構成表の版・権利の判定）を、人の確認の印つきで1つのファイルに積むだけ。
//
// 守ること:
//   - 人の確認として数えるのは、決めた人が自分の対話端末から --human-verified を付けた記録だけ
//     （判定は scripts/harness-learn.mjs の attestationFor。人の選択・台本の受け入れと同じ一つの実装）。
//     機械が代わりに書くなら --agent-attested（提案として残るが、制作の入口は使わない）
//   - 10カットがそろっていない候補、権利の関門で止まるモデル、構成表に無いモデルは採用できない
//   - 記録の中身は canonical JSON の SHA-256（recordSha256）に結ぶ。読むたびに照らし、違えば止める
//   - 署名の鍵を渡せば Channel Pack と同じ Ed25519 で署名する（鍵は信頼済みの別経路で渡す。記録の中の鍵は信じない）
//   - 置き場所は、チャンネルの作業フォルダの .buzzassist/optimal-config-adoption.json
//     （channel-pack-acceptance.json の隣。署名済みの Channel Pack は書き換えない）。
//     Pack の作者が配りたいときは、Pack の元フォルダの config/optimal-config-adoption.json に写して署名し直す
//   - 決定は追記だけ（decisions）。今効いているのは、最後の human-verified の決定

import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { readJsonIfExists, writeJsonAtomic } from "../atomicJsonFile.mjs";
import { withCanvasFileLock } from "../canvasFileLock.mjs";
import { canonicalJson, publicKeyId } from "../channelPackEnvelope.mjs";
import { resolveChannelPackSource } from "../channelPackResolver.mjs";
import { findModel, loadOptimalConfigCatalog } from "./catalog.mjs";
import { assertChannelTraits } from "./channelTraits.mjs";
import { evaluateModelRights, rightsContextFromTraits } from "./rightsGate.mjs";
import { computeTrialMetrics, recommendFromTrial, TRIAL_RECORD_VERSION } from "./trialRecord.mjs";

export const OPTIMAL_CONFIG_ADOPTION_VERSION = "optimal-config-adoption-v1";
export const OPTIMAL_CONFIG_ADOPTION_DECISION_VERSION = "optimal-config-adoption-decision-v1";
export const ADOPTION_PROJECT_PATH = path.join(".buzzassist", "optimal-config-adoption.json");
export const ADOPTION_PACK_PATH = "config/optimal-config-adoption.json";
export const ADOPTION_HUMAN_VERIFIED = "human-verified";

const NOTE_MAX_CHARS = 300;

export class OptimalConfigAdoptionError extends Error {
  constructor(code, message, extra = {}) {
    super(`${code}: ${message}`);
    this.name = "OptimalConfigAdoptionError";
    this.code = code;
    Object.assign(this, extra);
  }
}

function fail(code, message, extra) {
  throw new OptimalConfigAdoptionError(code, message, extra);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** 作業フォルダの中の採用の記録の場所（チャンネルの作業フォルダ＝Channel Pack の隣）。 */
export function resolveAdoptionPath(projectDir) {
  return path.join(path.resolve(projectDir), ADOPTION_PROJECT_PATH);
}

/** Pack の元フォルダ（署名する前）の中の場所。Pack が置かれていなければ null。 */
export function resolvePackAdoptionPath(projectDir, packId = "") {
  const located = resolveChannelPackSource(projectDir, ADOPTION_PACK_PATH, packId, { includeFixture: false });
  if (located.kind === "legacy") return null;
  return located.path;
}

function decisionBody(decision) {
  const body = structuredClone(decision);
  // index は記録に積んだ順番（積むときに付く）。中身の指紋には入れない。
  delete body.index;
  delete body.recordSha256;
  delete body.signature;
  return body;
}

/** 決定1件の中身の SHA-256（recordSha256 と signature を除いた canonical JSON）。 */
export function adoptionDecisionSha256(decision) {
  return sha256(canonicalJson(decisionBody(decision)));
}

function candidateFromTrial(trial, candidateId, role) {
  const id = nonEmpty(candidateId).toUpperCase();
  if (!id) fail("adoption-candidate-missing", `${role === "production" ? "本番（--production）" : "予備（--backup）"}の候補 ID が要る。`);
  const candidate = (trial.candidates || []).find((row) => String(row.candidateId).toUpperCase() === id);
  if (!candidate) {
    fail("adoption-candidate-not-in-trial", `候補 ${id} は試験の記録に無い（${(trial.candidates || []).map((row) => row.candidateId).join(" / ") || "候補なし"}）。`);
  }
  return candidate;
}

function modelsOf(candidate) {
  return Object.entries(candidate.models || {})
    .filter(([, value]) => value && typeof value === "object" && nonEmpty(value.modelId))
    .map(([slot, value]) => ({ slot, modelId: value.modelId, place: nonEmpty(value.place), role: nonEmpty(value.role) }));
}

/** 採用する候補のモデルを、構成表と権利の関門に今もう一度通す。止まれば理由を返す。 */
export function checkCandidateRights(candidate, traits, { catalog }) {
  const problems = [];
  const verdicts = [];
  for (const row of modelsOf(candidate)) {
    const model = findModel(catalog, row.modelId);
    if (!model) {
      problems.push({ code: "adoption-model-not-in-catalog", modelId: row.modelId, message: `${row.modelId} は今の構成表（${catalog.as_of}）に無い。構成表を確かめてから選び直す。` });
      continue;
    }
    if (!row.place || !model.runtime.places.includes(row.place)) {
      problems.push({ code: "adoption-model-place-invalid", modelId: row.modelId, message: `${model.name} の実行場所 ${row.place || "（なし）"} は構成表のこのモデルの実行場所ではない。` });
      continue;
    }
    const verdict = evaluateModelRights(model, rightsContextFromTraits(traits, row.place), { catalog });
    verdicts.push({ slot: row.slot, modelId: row.modelId, place: row.place, allowed: verdict.allowed, blocks: verdict.blocks.map((item) => item.code), warnings: verdict.warnings.map((item) => item.code) });
    if (!verdict.allowed) {
      problems.push({ code: "adoption-model-rights-blocked", modelId: row.modelId, message: verdict.blocks.map((item) => item.message).join(" ") });
    }
  }
  return { ok: problems.length === 0, problems, verdicts };
}

function summarizeCandidate(candidate, metrics) {
  return {
    candidateId: candidate.candidateId,
    label: candidate.label || "",
    videoConfigs: candidate.videoConfigs ?? null,
    imageWorkflows: Array.isArray(candidate.imageWorkflows) ? [...candidate.imageWorkflows] : [],
    models: candidate.models ? structuredClone(candidate.models) : null,
    runtimePlaces: Array.isArray(candidate.runtimePlaces) ? [...candidate.runtimePlaces] : [],
    metrics: metrics ? { ...metrics } : null,
  };
}

/** 人が打つ（--human-verified）ときのコマンドを、見える変数で埋めて作る（`<名前>` を残さない）。 */
export function humanAdoptCommand({ traitsPath, trialPath, production, backup, projectDir = "", note = "" }) {
  const quote = (value) => `'${String(value).replace(/'/gu, "'\\''")}'`;
  const parts = [
    "node scripts/optimal-config.mjs adopt",
    `--traits ${quote(traitsPath)}`,
    `--trial ${quote(trialPath)}`,
    `--production ${production}`,
    `--backup ${backup}`,
    ...(projectDir ? [`--project-dir ${quote(projectDir)}`] : []),
    ...(note ? [`--note ${quote(note)}`] : []),
    '--reviewer "$REVIEWER"',
    "--human-verified",
  ];
  return `REVIEWER="$(id -un)"; ${parts.join(" ")}`;
}

/**
 * 採用の決定を1件作る（書かない）。検査を通らなければ日本語の理由で止める。
 * attestation は scripts/harness-learn.mjs の attestationFor の結果（{ reviewer, attestedBy, claimedReviewer? }）。
 */
export function buildAdoptionDecision({
  traits: rawTraits,
  trial,
  trialSha256,
  production,
  backup,
  attestation,
  note = "",
  catalog = loadOptimalConfigCatalog(),
  now = () => new Date().toISOString(),
} = {}) {
  const traits = assertChannelTraits(rawTraits);
  if (trial?.version !== TRIAL_RECORD_VERSION) fail("adoption-trial-invalid", `試験の記録の版が違う（${TRIAL_RECORD_VERSION} を期待）。`);
  if (trial.channelId !== traits.channelId) {
    fail("adoption-channel-mismatch", `試験の記録のチャンネル（${trial.channelId}）と traits のチャンネル（${traits.channelId}）が違う。`);
  }
  if (!/^[a-f0-9]{64}$/u.test(String(trialSha256 || ""))) fail("adoption-trial-invalid", "試験の記録の SHA-256 が要る。");
  const productionCandidate = candidateFromTrial(trial, production, "production");
  const backupCandidate = candidateFromTrial(trial, backup, "backup");
  if (productionCandidate.candidateId === backupCandidate.candidateId) {
    fail("adoption-same-candidate", "本番と予備に同じ候補は選べない（予備は本番が使えないときの別の経路）。");
  }
  const metrics = computeTrialMetrics(trial);
  const metricOf = (candidate) => metrics.find((row) => row.candidateId === candidate.candidateId) || null;
  for (const [role, candidate] of [["本番", productionCandidate], ["予備", backupCandidate]]) {
    const row = metricOf(candidate);
    if (!row?.complete) {
      fail("adoption-trial-incomplete", `${role}の候補 ${candidate.candidateId} は10カットがそろっていない（${row?.cutsRecorded ?? 0}/10）。試験を終えてから決める。`);
    }
  }
  const rights = {};
  for (const [role, candidate] of [["production", productionCandidate], ["backup", backupCandidate]]) {
    const checked = checkCandidateRights(candidate, traits, { catalog });
    if (!checked.ok) {
      fail(checked.problems[0].code, `${role === "production" ? "本番" : "予備"}の候補 ${candidate.candidateId}: ${checked.problems.map((item) => item.message).join(" ")}`, { problems: checked.problems });
    }
    rights[role] = checked.verdicts;
  }
  if (!attestation || !nonEmpty(attestation.reviewer) || !nonEmpty(attestation.attestedBy)) {
    fail("adoption-reviewer-required", "決めた人（--reviewer）と確認の印（--human-verified か --agent-attested）が要る。");
  }
  const text = nonEmpty(note).slice(0, NOTE_MAX_CHARS);
  const recommendation = recommendFromTrial(trial);
  const decidedAt = new Date(now()).toISOString();
  const decision = {
    version: OPTIMAL_CONFIG_ADOPTION_DECISION_VERSION,
    channelId: traits.channelId,
    decidedAt,
    traitsSha256: sha256(canonicalJson(rawTraits)),
    traitsSummary: {
      artStyle: traits.artStyle,
      identityLock: traits.identityLock,
      motion: traits.motion,
      budgetMonthlyJpy: traits.budgetMonthlyJpy,
      confidentialAssets: traits.confidentialAssets,
      publishScope: traits.publishScope,
      annualRevenueUsd: traits.annualRevenueUsd,
      contracts: [...traits.hardware.contracts],
    },
    catalog: { version: catalog.version, asOf: catalog.as_of, reproduced: catalog.reproduced === true },
    trial: {
      version: trial.version,
      sha256: trialSha256,
      createdAt: String(trial.createdAt || ""),
      cutCount: Array.isArray(trial.cuts) ? trial.cuts.length : 0,
      metrics,
      recommendation,
    },
    production: summarizeCandidate(productionCandidate, metricOf(productionCandidate)),
    backup: summarizeCandidate(backupCandidate, metricOf(backupCandidate)),
    followedRecommendation: recommendation.production === productionCandidate.candidateId && recommendation.fallback === backupCandidate.candidateId,
    rightsAtAdoption: rights,
    approval: {
      reviewer: attestation.reviewer,
      attestedBy: attestation.attestedBy,
      ...(attestation.claimedReviewer ? { claimedReviewer: attestation.claimedReviewer } : {}),
      ...(text ? { note: text } : {}),
    },
    effective: attestation.attestedBy === ADOPTION_HUMAN_VERIFIED,
  };
  return { ...decision, recordSha256: adoptionDecisionSha256(decision) };
}

/** 決定に Ed25519 で署名する（Channel Pack と同じ canonical JSON。鍵は別経路で渡す）。 */
export async function signAdoptionDecision(decision, { privateKeyPem = "", privateKeyPath = "", keyId = "" } = {}) {
  const pem = nonEmpty(privateKeyPem) || (nonEmpty(privateKeyPath) ? await readFile(path.resolve(privateKeyPath), "utf8") : "");
  if (!pem) fail("adoption-signing-key-missing", "署名の秘密鍵が要る（--signing-key-path）。");
  const privateKey = createPrivateKey(pem);
  const publicKey = createPublicKey(privateKey);
  const body = decisionBody(decision);
  return {
    ...body,
    recordSha256: adoptionDecisionSha256(decision),
    signature: {
      algorithm: "Ed25519",
      keyId: nonEmpty(keyId) || publicKeyId(publicKey),
      value: cryptoSign(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64url"),
    },
  };
}

/**
 * 決定1件を照らす。recordSha256 が中身と合わなければ止める。署名があり信頼済みの公開鍵が渡されれば、
 * 署名も照らす（記録の中の鍵は信じない）。
 */
export function verifyAdoptionDecision(decision, { trustedPublicKeyPem = "" } = {}) {
  if (!decision || typeof decision !== "object" || decision.version !== OPTIMAL_CONFIG_ADOPTION_DECISION_VERSION) {
    fail("adopted-config-invalid", "採用の記録の形が違う（optimal-config-adoption-decision-v1 ではない）。");
  }
  if (decision.recordSha256 !== adoptionDecisionSha256(decision)) {
    fail("adopted-config-tampered", "採用の記録の中身が recordSha256 と合わない（記録した後に書き換えられた）。採用し直す。");
  }
  let signature = { present: Boolean(decision.signature), verified: false };
  if (decision.signature && nonEmpty(trustedPublicKeyPem)) {
    const publicKey = createPublicKey(trustedPublicKeyPem);
    if (String(decision.signature.keyId).startsWith("ed25519:") && decision.signature.keyId !== publicKeyId(publicKey)) {
      fail("adopted-config-signature-invalid", "採用の記録の署名の鍵 ID が信頼済みの公開鍵と違う。");
    }
    const ok = cryptoVerify(null, Buffer.from(canonicalJson(decisionBody(decision))), publicKey, Buffer.from(String(decision.signature.value || ""), "base64url"));
    if (!ok) fail("adopted-config-signature-invalid", "採用の記録の Ed25519 署名が合わない。");
    signature = { present: true, verified: true, keyId: decision.signature.keyId };
  }
  return { ok: true, recordSha256: decision.recordSha256, signature };
}

function emptyStore(channelId) {
  return { version: OPTIMAL_CONFIG_ADOPTION_VERSION, channelId, decisions: [] };
}

function validateStore(value, filePath) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== OPTIMAL_CONFIG_ADOPTION_VERSION || !Array.isArray(value.decisions)) {
    fail("adopted-config-invalid", `採用の記録 ${filePath} の形が違う（${OPTIMAL_CONFIG_ADOPTION_VERSION} ではない）。消さずに中身を確かめる。`);
  }
  return value;
}

/** 決定を記録に追記する（決定は消さない）。 */
export async function appendAdoptionDecision({ filePath, decision } = {}) {
  verifyAdoptionDecision(decision);
  const target = path.resolve(filePath);
  return withCanvasFileLock(target, async () => {
    const existing = await readJsonIfExists(target, null);
    const store = existing === null ? emptyStore(decision.channelId) : validateStore(existing, target);
    if (store.channelId !== decision.channelId) {
      fail("adoption-channel-mismatch", `記録 ${target} は別のチャンネル（${store.channelId}）のもの。`);
    }
    const next = { ...store, updatedAt: decision.decidedAt, decisions: [...store.decisions, { index: store.decisions.length + 1, ...decision }] };
    await writeJsonAtomic(target, next);
    return { filePath: target, store: next, decision: next.decisions.at(-1) };
  });
}

/**
 * 記録を読んで、今効いている決定（最後の human-verified）を返す。
 * 返す status:
 *   none            記録が無い（今までどおり既定の経路で作る）
 *   adopted         人の確認つきの決定がある（effective）
 *   pending-human   機械が書いた提案だけがある（人の確認がまだ。制作の入口は止める）
 */
export async function readAdoptedConfig({ projectDir = process.cwd(), packId = "", filePath = "", trustedPublicKeyPem = "" } = {}) {
  const sources = [];
  if (filePath) sources.push({ kind: "file", path: path.resolve(filePath) });
  else {
    sources.push({ kind: "project", path: resolveAdoptionPath(projectDir) });
    let packPath = null;
    try { packPath = resolvePackAdoptionPath(projectDir, packId); } catch { packPath = null; }
    if (packPath) sources.push({ kind: "channel-pack", path: packPath });
  }
  const found = sources.filter((source) => existsSync(source.path));
  if (found.length === 0) return { status: "none", sources: sources.map((source) => source.path) };
  const reads = [];
  for (const source of found) {
    let store;
    try {
      store = validateStore(JSON.parse(await readFile(source.path, "utf8")), source.path);
    } catch (error) {
      if (error instanceof OptimalConfigAdoptionError) throw error;
      fail("adopted-config-invalid", `採用の記録 ${source.path} が JSON として読めない。`);
    }
    for (const decision of store.decisions) verifyAdoptionDecision(decision, { trustedPublicKeyPem });
    reads.push({ source, store });
  }
  const effectiveOf = (store) => [...store.decisions].reverse().find((decision) => decision.approval?.attestedBy === ADOPTION_HUMAN_VERIFIED) || null;
  const effective = reads.map((read) => ({ read, decision: effectiveOf(read.store) })).filter((row) => row.decision);
  if (effective.length > 1 && effective[0].decision.recordSha256 !== effective[1].decision.recordSha256) {
    fail("adopted-config-conflict", `作業フォルダ（${effective[0].read.source.path}）と Channel Pack（${effective[1].read.source.path}）の採用の記録が違う。どちらを正にするか運営者が決め、片方を直す。`);
  }
  const latest = reads[0].store.decisions.at(-1) || null;
  if (effective.length === 0) {
    return { status: "pending-human", source: reads[0].source, channelId: reads[0].store.channelId, latest };
  }
  const { read, decision } = effective[0];
  const newerUnverified = read.store.decisions.filter((row) => row.index > decision.index && row.approval?.attestedBy !== ADOPTION_HUMAN_VERIFIED);
  return {
    status: "adopted",
    source: read.source,
    channelId: read.store.channelId,
    decision,
    ...(newerUnverified.length > 0 ? { newerUnverifiedCount: newerUnverified.length } : {}),
  };
}
