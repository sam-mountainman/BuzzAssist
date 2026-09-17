import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acceptChannelPackVersion,
  compareChannelPackVersions,
  resolveChannelPackAcceptancePath,
} from "../lib/channelPackAcceptance.mjs";
import {
  createChannelPackRollbackAuthorization,
  publicKeyId,
  verifyChannelPackRollbackAuthorization,
} from "../lib/channelPackEnvelope.mjs";

const digest = (character) => character.repeat(64);

function keys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }),
  };
}

function evidence(version, payloadSha256, trustedPublicKeyId = "ed25519:fixture") {
  return {
    trustedPublicKeyId,
    harnessId: "narrated-story-video",
    id: "operator-pack",
    version,
    payloadSha256,
  };
}

test("Channel Pack semver comparison includes prerelease ordering", () => {
  assert.equal(compareChannelPackVersions("1.0.0-beta.2", "1.0.0-beta.11"), -1);
  assert.equal(compareChannelPackVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareChannelPackVersions("2.0.0+build.1", "2.0.0+build.9"), 0);
});

test("a signed older pack and same-version equivocation fail closed", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "channel-pack-acceptance-"));
  try {
    await acceptChannelPackVersion({ projectDir, evidence: evidence("2.0.0", digest("a")) });
    await assert.rejects(
      acceptChannelPackVersion({ projectDir, evidence: evidence("1.0.0", digest("b")) }),
      (error) => error.code === "CHANNEL_PACK_ROLLBACK_REJECTED",
    );
    await assert.rejects(
      acceptChannelPackVersion({ projectDir, evidence: evidence("2.0.0", digest("c")) }),
      (error) => error.code === "CHANNEL_PACK_VERSION_EQUIVOCATION",
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("concurrent same-version divergent packs allow exactly one payload", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "channel-pack-acceptance-race-"));
  try {
    const outcomes = await Promise.allSettled([
      acceptChannelPackVersion({ projectDir, evidence: evidence("3.0.0", digest("d")) }),
      acceptChannelPackVersion({ projectDir, evidence: evidence("3.0.0", digest("e")) }),
    ]);
    assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 1);
    const rejected = outcomes.find((entry) => entry.status === "rejected");
    assert.equal(rejected.reason.code, "CHANNEL_PACK_VERSION_EQUIVOCATION");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("an exact separately signed rollback is one-use and the ledger stores only its digest", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "channel-pack-rollback-"));
  try {
    const key = keys();
    const trustedPublicKeyId = publicKeyId(key.publicKeyPem);
    const from = evidence("2.0.0", digest("a"), trustedPublicKeyId);
    const to = evidence("1.5.0", digest("b"), trustedPublicKeyId);
    await acceptChannelPackVersion({ projectDir, evidence: from });
    const authorization = await createChannelPackRollbackAuthorization({
      trustedPublicKeyId,
      harnessId: from.harnessId,
      packId: from.id,
      fromVersion: from.version,
      fromPayloadSha256: from.payloadSha256,
      toVersion: to.version,
      toPayloadSha256: to.payloadSha256,
      reason: "fixture-only emergency rollback",
      privateKeyPem: key.privateKeyPem,
      authorizedAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-09-02T00:00:00.000Z",
    });
    const verifyRollbackAuthorization = ({ authorization: candidate, expected }) => (
      verifyChannelPackRollbackAuthorization({
        authorization: candidate,
        expected,
        trustedPublicKeyPem: key.publicKeyPem,
        now: () => new Date("2026-09-01T12:00:00.000Z"),
      })
    );
    const accepted = await acceptChannelPackVersion({
      projectDir,
      evidence: to,
      rollbackAuthorization: authorization,
      verifyRollbackAuthorization,
      now: () => "2026-09-01T12:00:00.000Z",
    });
    assert.equal(accepted.rollbackAuthorized, true);
    assert.equal(accepted.highestVersion, "2.0.0");
    assert.equal(accepted.currentVersion, "1.5.0");
    const reattached = await acceptChannelPackVersion({
      projectDir,
      evidence: to,
      rollbackAuthorization: authorization,
      verifyRollbackAuthorization,
    });
    assert.equal(reattached.reattached, true);
    assert.equal(reattached.rollbackAuthorized, false);
    await assert.rejects(
      acceptChannelPackVersion({ projectDir, evidence: evidence("1.5.0", digest("c"), trustedPublicKeyId) }),
      (error) => error.code === "CHANNEL_PACK_VERSION_EQUIVOCATION",
    );
    await assert.rejects(
      acceptChannelPackVersion({
        projectDir,
        evidence: evidence("1.0.0", digest("d"), trustedPublicKeyId),
        rollbackAuthorization: authorization,
        verifyRollbackAuthorization,
      }),
      /一致しない|rollback/u,
    );
    await acceptChannelPackVersion({ projectDir, evidence: from });
    await assert.rejects(
      acceptChannelPackVersion({
        projectDir,
        evidence: to,
        rollbackAuthorization: authorization,
        verifyRollbackAuthorization,
      }),
      (error) => error.code === "CHANNEL_PACK_ROLLBACK_AUTHORIZATION_REPLAY",
    );
    const ledger = await readFile(resolveChannelPackAcceptancePath(projectDir), "utf8");
    assert.equal(ledger.includes("fixture-only emergency rollback"), false);
    assert.equal(ledger.includes(authorization.signature), false);
    assert.equal(ledger.includes(accepted.rollbackAuthorizationSha256), true);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
