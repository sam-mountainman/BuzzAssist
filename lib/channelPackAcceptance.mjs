// Per-project monotonic Channel Pack acceptance state.
// A valid signature proves authorship, not freshness. Keep the highest accepted
// release per signer/harness/pack and require a separately signed, exact-target
// authorization before intentionally running an older release.

import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { withCanvasFileLock } from "./canvasFileLock.mjs";
import { readJsonIfExists, writeJsonAtomic } from "./canvasScene.mjs";

export const CHANNEL_PACK_ACCEPTANCE_VERSION = "buzzassist-channel-pack-acceptance-v1";
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_USED_AUTHORIZATIONS = 1_000;

export class ChannelPackAcceptanceError extends Error {
  constructor(message, code = "CHANNEL_PACK_ACCEPTANCE_INVALID") {
    super(message);
    this.name = "ChannelPackAcceptanceError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new ChannelPackAcceptanceError(message, code);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseSemver(value) {
  const normalized = nonEmpty(value);
  const match = normalized.match(SEMVER);
  if (!match) fail(`Channel Pack versionがsemverではない: ${normalized || "(空)"}`, "CHANNEL_PACK_VERSION_INVALID");
  return {
    raw: normalized,
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifier(left, right) {
  const leftNumeric = /^(?:0|[1-9][0-9]*)$/u.test(left);
  const rightNumeric = /^(?:0|[1-9][0-9]*)$/u.test(right);
  if (leftNumeric && rightNumeric) return Number(left) === Number(right) ? 0 : (Number(left) < Number(right) ? -1 : 1);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left === right ? 0 : (left < right ? -1 : 1);
}

export function compareChannelPackVersions(leftValue, rightValue) {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : (left.prerelease.length === 0 ? 1 : -1);
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const compared = compareIdentifier(left.prerelease[index], right.prerelease[index]);
    if (compared) return compared;
  }
  return 0;
}

function normalizedEvidence(evidence) {
  const value = {
    trustedPublicKeyId: nonEmpty(evidence?.trustedPublicKeyId),
    harnessId: nonEmpty(evidence?.harnessId),
    packId: nonEmpty(evidence?.id),
    packVersion: nonEmpty(evidence?.version || evidence?.packVersion),
    payloadSha256: nonEmpty(evidence?.payloadSha256).toLowerCase(),
  };
  if (!value.trustedPublicKeyId || !value.harnessId || !value.packId || !SHA256.test(value.payloadSha256)) {
    fail("Channel Pack acceptance identityが不完全。", "CHANNEL_PACK_ACCEPTANCE_IDENTITY_INVALID");
  }
  parseSemver(value.packVersion);
  return value;
}

function stateKey(identity) {
  return sha256(`${identity.trustedPublicKeyId}\u001f${identity.harnessId}\u001f${identity.packId}`);
}

function emptyState() {
  return { version: CHANNEL_PACK_ACCEPTANCE_VERSION, packs: {} };
}

function validateState(value) {
  if (value === null) return emptyState();
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.version !== CHANNEL_PACK_ACCEPTANCE_VERSION
    || !value.packs || typeof value.packs !== "object" || Array.isArray(value.packs)) {
    fail("Channel Pack acceptance台帳が壊れている。削除せず監査すること。", "CHANNEL_PACK_ACCEPTANCE_STATE_INVALID");
  }
  return value;
}

export function resolveChannelPackAcceptancePath(projectDir) {
  return join(resolve(projectDir), ".buzzassist", "channel-pack-acceptance.json");
}

export async function acceptChannelPackVersion({
  projectDir,
  evidence,
  rollbackAuthorization = null,
  verifyRollbackAuthorization = null,
  now = () => new Date().toISOString(),
} = {}) {
  const identity = normalizedEvidence(evidence);
  const filePath = resolveChannelPackAcceptancePath(projectDir);
  const key = stateKey(identity);
  return withCanvasFileLock(filePath, async () => {
    const state = validateState(await readJsonIfExists(filePath, null));
    const prior = state.packs[key] || null;
    const incoming = { version: identity.packVersion, payloadSha256: identity.payloadSha256 };
    let rollback = null;
    let updateHighest = !prior;

    if (prior) {
      const currentCompared = compareChannelPackVersions(incoming.version, prior.current.version);
      if (currentCompared === 0 && incoming.payloadSha256 !== prior.current.payloadSha256) {
        fail("現在のChannel Pack versionへ異なるpayloadが署名されている。", "CHANNEL_PACK_VERSION_EQUIVOCATION");
      }
      if (currentCompared === 0 && incoming.payloadSha256 === prior.current.payloadSha256) {
        return {
          ok: true,
          key,
          highestVersion: prior.highest.version,
          currentVersion: prior.current.version,
          rollbackAuthorized: false,
          rollbackAuthorizationSha256: "",
          reattached: true,
        };
      }
      const compared = compareChannelPackVersions(incoming.version, prior.highest.version);
      if (compared === 0 && incoming.payloadSha256 !== prior.highest.payloadSha256) {
        fail("同じChannel Pack versionへ異なるpayloadが署名されている。", "CHANNEL_PACK_VERSION_EQUIVOCATION");
      }
      if (compared < 0) {
        if (!rollbackAuthorization || typeof verifyRollbackAuthorization !== "function") {
          fail(
            `Channel Pack ${identity.packId} ${incoming.version} は受領済み ${prior.highest.version} より古い。別署名のrollback承認が要る。`,
            "CHANNEL_PACK_ROLLBACK_REJECTED",
          );
        }
        rollback = await verifyRollbackAuthorization({
          authorization: rollbackAuthorization,
          expected: {
            ...identity,
            fromVersion: prior.current.version,
            fromPayloadSha256: prior.current.payloadSha256,
            toVersion: incoming.version,
            toPayloadSha256: incoming.payloadSha256,
          },
        });
        const authorizationSha256 = nonEmpty(rollback?.authorizationSha256).toLowerCase();
        if (rollback?.ok !== true || !SHA256.test(authorizationSha256)) {
          fail("Channel Pack rollback承認の検証結果が不正。", "CHANNEL_PACK_ROLLBACK_AUTHORIZATION_INVALID");
        }
        if ((prior.usedRollbackAuthorizations || []).includes(authorizationSha256)) {
          fail("Channel Pack rollback承認は既に使用済み。", "CHANNEL_PACK_ROLLBACK_AUTHORIZATION_REPLAY");
        }
        rollback = { ...rollback, authorizationSha256 };
      } else if (compared > 0) {
        updateHighest = true;
      }
    }

    const acceptedAt = now();
    const highest = updateHighest ? { ...incoming, acceptedAt } : prior.highest;
    const used = rollback
      ? [...(prior?.usedRollbackAuthorizations || []), rollback.authorizationSha256].slice(-MAX_USED_AUTHORIZATIONS)
      : [...(prior?.usedRollbackAuthorizations || [])].slice(-MAX_USED_AUTHORIZATIONS);
    const nextEntry = {
      trustedPublicKeyId: identity.trustedPublicKeyId,
      harnessId: identity.harnessId,
      packId: identity.packId,
      highest,
      current: { ...incoming, acceptedAt },
      usedRollbackAuthorizations: used,
      ...(rollback ? { lastRollbackAuthorizationSha256: rollback.authorizationSha256 } : {}),
    };
    const next = {
      ...state,
      version: CHANNEL_PACK_ACCEPTANCE_VERSION,
      updatedAt: acceptedAt,
      packs: { ...state.packs, [key]: nextEntry },
    };
    await writeJsonAtomic(filePath, next);
    return {
      ok: true,
      key,
      highestVersion: highest.version,
      currentVersion: incoming.version,
      rollbackAuthorized: Boolean(rollback),
      rollbackAuthorizationSha256: rollback?.authorizationSha256 || "",
    };
  });
}
