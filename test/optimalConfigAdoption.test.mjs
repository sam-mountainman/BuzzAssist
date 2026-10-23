import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  appendAdoptionDecision,
  buildAdoptionDecision,
  readAdoptedConfig,
  resolveAdoptionPath,
  signAdoptionDecision,
  verifyAdoptionDecision,
} from "../lib/optimalConfig/adoption.mjs";
import { loadOptimalConfigCatalog } from "../lib/optimalConfig/catalog.mjs";
import { runOptimalConfigCommand } from "../scripts/optimal-config.mjs";
import { completedTrial, exampleTraits } from "./helpers/optimalConfigTrialFixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const catalog = loadOptimalConfigCatalog();
const human = { reviewer: "operator", attestedBy: "human-verified" };
const agent = { reviewer: "agent", attestedBy: "agent-self-attested", claimedReviewer: "operator" };
const fixedNow = () => "2026-10-23T00:00:00.000Z";

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "optimal-adopt-"));
  const traitsPath = join(dir, "traits.json");
  const trialPath = join(dir, "trial.json");
  writeFileSync(traitsPath, JSON.stringify(exampleTraits()));
  writeFileSync(trialPath, JSON.stringify(completedTrial()));
  return { dir, traitsPath, trialPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const build = (overrides = {}) => buildAdoptionDecision({
  traits: exampleTraits(),
  trial: completedTrial(),
  trialSha256: "a".repeat(64),
  production: "A",
  backup: "B",
  attestation: human,
  catalog,
  now: fixedNow,
  ...overrides,
});

test("採用の決定は試験の数字・構成表の版・権利の判定・人の確認を持つ", () => {
  const decision = build();
  assert.equal(decision.channelId, "fixed-cast-manga");
  assert.equal(decision.catalog.asOf, catalog.as_of);
  assert.equal(decision.catalog.reproduced, false);
  assert.equal(decision.trial.cutCount, 10);
  assert.equal(decision.production.candidateId, "A");
  assert.equal(decision.production.models.imagePrimary.modelId, "gpt-image");
  assert.equal(decision.production.metrics.complete, true);
  assert.equal(decision.backup.candidateId, "B");
  assert.equal(decision.followedRecommendation, true);
  assert.equal(decision.approval.reviewer, "operator");
  assert.equal(decision.effective, true);
  assert.ok(decision.rightsAtAdoption.production.every((row) => row.allowed));
  assert.match(decision.recordSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(verifyAdoptionDecision(decision).ok, true);
});

test("10カットがそろわない候補・同じ候補・試験に無い候補・権利で止まるモデルは採用しない", () => {
  assert.throws(() => build({ trial: completedTrial(exampleTraits(), { completeCandidates: ["A"] }) }), /adoption-trial-incomplete/u);
  assert.throws(() => build({ backup: "A" }), /adoption-same-candidate/u);
  assert.throws(() => build({ backup: "C" }), /adoption-candidate-not-in-trial/u);
  const trial = completedTrial();
  trial.candidates[1].models.imagePrimary = { ...trial.candidates[1].models.imagePrimary, modelId: "flux-dev", place: "operator-rented-gpu" };
  assert.throws(() => build({ trial }), /adoption-model-rights-blocked/u);
  const unknown = completedTrial();
  unknown.candidates[0].models.imagePrimary = { ...unknown.candidates[0].models.imagePrimary, modelId: "no-such-model" };
  assert.throws(() => build({ trial: unknown }), /adoption-model-not-in-catalog/u);
  assert.throws(() => build({ attestation: null }), /adoption-reviewer-required/u);
});

test("記録は追記で、効くのは最後の human-verified。機械の提案だけなら pending-human", async () => {
  const { dir, cleanup } = workspace();
  try {
    assert.equal((await readAdoptedConfig({ projectDir: dir })).status, "none");
    await appendAdoptionDecision({ filePath: resolveAdoptionPath(dir), decision: build({ attestation: agent }) });
    const pending = await readAdoptedConfig({ projectDir: dir });
    assert.equal(pending.status, "pending-human");
    await appendAdoptionDecision({ filePath: resolveAdoptionPath(dir), decision: build() });
    await appendAdoptionDecision({ filePath: resolveAdoptionPath(dir), decision: build({ attestation: agent, production: "B", backup: "A" }) });
    const adopted = await readAdoptedConfig({ projectDir: dir });
    assert.equal(adopted.status, "adopted");
    assert.equal(adopted.decision.production.candidateId, "A");
    assert.equal(adopted.decision.index, 2);
    assert.equal(adopted.newerUnverifiedCount, 1);
  } finally { cleanup(); }
});

test("書き換えられた記録は止める。署名は信頼済みの公開鍵で照らす", async () => {
  const { dir, cleanup } = workspace();
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signed = await signAdoptionDecision(build(), { privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) });
    const publicPem = publicKey.export({ type: "spki", format: "pem" });
    assert.equal(verifyAdoptionDecision(signed, { trustedPublicKeyPem: publicPem }).signature.verified, true);
    const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
    assert.throws(() => verifyAdoptionDecision(signed, { trustedPublicKeyPem: other }), /adopted-config-signature-invalid/u);

    const filePath = resolveAdoptionPath(dir);
    await appendAdoptionDecision({ filePath, decision: signed });
    const store = JSON.parse(readFileSync(filePath, "utf8"));
    store.decisions[0].production.candidateId = "B";
    writeFileSync(filePath, JSON.stringify(store));
    await assert.rejects(readAdoptedConfig({ projectDir: dir }), /adopted-config-tampered/u);
  } finally { cleanup(); }
});

test("adopt: 対話端末の --human-verified だけが効く。機械の記録は提案として残し、埋めたコマンドを返す", async () => {
  const { dir, traitsPath, trialPath, cleanup } = workspace();
  try {
    const argv = ["adopt", "--traits", traitsPath, "--trial", trialPath, "--production", "a", "--backup", "b", "--project-dir", dir];
    const proposal = await runOptimalConfigCommand([...argv, "--reviewer", "operator", "--agent-attested"], { isInteractive: false, now: fixedNow });
    assert.equal(proposal.effective, false);
    assert.equal(proposal.decision.approval.attestedBy, "agent-self-attested");
    assert.match(proposal.next, /^REVIEWER="\$\(id -un\)"; node scripts\/optimal-config\.mjs adopt /u);
    assert.match(proposal.next, /--reviewer "\$REVIEWER" --human-verified$/u);
    assert.doesNotMatch(proposal.next, /<[^>]+>/u, "<名前> のような穴を残さない");

    await assert.rejects(
      runOptimalConfigCommand([...argv, "--reviewer", "operator", "--human-verified"], { isInteractive: false }),
      (error) => /対話端末/u.test(error.message) && /REVIEWER="\$\(id -un\)"/u.test(error.next),
    );
    await assert.rejects(runOptimalConfigCommand([...argv, "--human-verified"], { isInteractive: true }), /reviewer/u);

    const adopted = await runOptimalConfigCommand([...argv, "--reviewer", "operator", "--human-verified", "--note", "429 の間は B で下書き"], { isInteractive: true, now: fixedNow });
    assert.equal(adopted.effective, true);
    assert.equal(adopted.decision.production.candidateId, "A");
    assert.equal(adopted.filePath, resolveAdoptionPath(dir));
    const read = await runOptimalConfigCommand(["adopted", "--project-dir", dir]);
    assert.equal(read.status, "adopted");
    assert.equal(read.decision.approval.note, "429 の間は B で下書き");
  } finally { cleanup(); }
});

test("adopt を子プロセスで --human-verified 付きで打っても（対話端末でない）記録しない", () => {
  const { dir, traitsPath, trialPath, cleanup } = workspace();
  try {
    const child = spawnSync(process.execPath, ["scripts/optimal-config.mjs", "adopt", "--traits", traitsPath, "--trial", trialPath, "--production", "A", "--backup", "B", "--project-dir", dir, "--reviewer", "operator", "--human-verified"], { cwd: root, encoding: "utf8" });
    assert.equal(child.status, 1);
    const output = JSON.parse(child.stdout);
    assert.equal(output.code, "OPTIMAL_CONFIG_ADOPTION_ATTESTATION");
    assert.match(output.next, /--human-verified$/u);
    assert.doesNotMatch(output.next, /<[^>]+>/u);
  } finally { cleanup(); }
});
