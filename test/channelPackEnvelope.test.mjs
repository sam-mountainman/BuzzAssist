import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertCoreCompatibility,
  coreVersionSatisfies,
  createChannelPackEnvelope,
  verifyChannelPackEnvelope,
} from "../lib/channelPackEnvelope.mjs";

function keys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }),
  };
}

test("Channel Pack envelopeは全file SHAと受領側のEd25519公開鍵へ拘束される", async () => {
  const root = await mkdtemp(join(tmpdir(), "channel-pack-envelope-"));
  try {
    const source = join(root, "source");
    const output = join(root, "signed");
    await mkdir(join(source, "config"), { recursive: true });
    await writeFile(join(source, "config", "show.json"), `${JSON.stringify({ cast: ["fixture"] })}\n`);
    const key = keys();
    const created = await createChannelPackEnvelope({
      sourceDir: source,
      outputDir: output,
      id: "fixture-pack",
      version: "1.2.3",
      harnessId: "narrated-story-video",
      privateKeyPem: key.privateKeyPem,
      publicKeyPem: key.publicKeyPem,
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    assert.equal(created.ok, true);
    assert.equal(created.harnessId, "narrated-story-video");
    assert.equal(created.fileCount, 1);
    assert.equal((await readFile(join(output, "channel-pack.json"), "utf8")).includes("PRIVATE KEY"), false);
    const verified = await verifyChannelPackEnvelope({
      bundleDir: output,
      trustedPublicKeyPem: key.publicKeyPem,
      expectedHarnessId: "narrated-story-video",
    });
    assert.equal(verified.id, "fixture-pack");
    await writeFile(join(output, "payload", "config", "show.json"), "tampered\n");
    await assert.rejects(
      verifyChannelPackEnvelope({ bundleDir: output, trustedPublicKeyPem: key.publicKeyPem }),
      /byte数|SHA-256/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundle同梱鍵を信頼せず、別鍵・別Harness・秘密file・symlinkを拒否する", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "channel-pack-envelope-reject-"));
  try {
    const source = join(root, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "rules.json"), "{}\n");
    const key = keys();
    const other = keys();
    const output = join(root, "signed");
    await createChannelPackEnvelope({
      sourceDir: source,
      outputDir: output,
      id: "fixture-pack",
      version: "1.0.0",
      harnessId: "koya-manga-video",
      privateKeyPem: key.privateKeyPem,
    });
    await assert.rejects(
      verifyChannelPackEnvelope({ bundleDir: output }),
      /公開鍵/u,
    );
    await assert.rejects(
      verifyChannelPackEnvelope({ bundleDir: output, trustedPublicKeyPem: other.publicKeyPem }),
      /key ID|署名/u,
    );
    await assert.rejects(
      verifyChannelPackEnvelope({ bundleDir: output, trustedPublicKeyPem: key.publicKeyPem, expectedHarnessId: "narrated-story-video" }),
      /対象Harness/u,
    );

    const secretSource = join(root, "secret-source");
    await mkdir(secretSource);
    await writeFile(join(secretSource, ".env"), "FISH_AUDIO_API_KEY=must-not-ship\n");
    await assert.rejects(
      createChannelPackEnvelope({
        sourceDir: secretSource,
        outputDir: join(root, "secret-output"),
        id: "secret-pack",
        version: "1.0.0",
        harnessId: "narrated-story-video",
        privateKeyPem: key.privateKeyPem,
      }),
      /秘密/u,
    );

    if (process.platform === "win32") t.skip("Windowsの非管理者symlink fixtureは不安定");
    const symlinkSource = join(root, "symlink-source");
    await mkdir(symlinkSource);
    await writeFile(join(root, "outside.txt"), "outside");
    const { symlink } = await import("node:fs/promises");
    await symlink(join(root, "outside.txt"), join(symlinkSource, "linked.txt"));
    await assert.rejects(
      createChannelPackEnvelope({
        sourceDir: symlinkSource,
        outputDir: join(root, "symlink-output"),
        id: "symlink-pack",
        version: "1.0.0",
        harnessId: "koya-manga-video",
        privateKeyPem: key.privateKeyPem,
      }),
      /symlink/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("signed coreCompatibility is enforced against the running Core version", async () => {
  assert.equal(coreVersionSatisfies("1.4.2", "^1.2.0"), true);
  assert.equal(coreVersionSatisfies("2.0.0", "^1.2.0"), false);
  assert.equal(coreVersionSatisfies("0.2.4", "^0.2.3"), true);
  assert.equal(coreVersionSatisfies("0.3.0", "^0.2.3"), false);
  assert.equal(coreVersionSatisfies("1.4.2", ">=1.4.0 <1.5.0"), true);
  assert.throws(() => assertCoreCompatibility("2.0.0", "^1.2.0"), /互換でない/u);

  const root = await mkdtemp(join(tmpdir(), "channel-pack-core-range-"));
  try {
    const source = join(root, "source");
    const output = join(root, "signed");
    await mkdir(source);
    await writeFile(join(source, "rules.json"), "{}\n");
    const key = keys();
    await createChannelPackEnvelope({
      sourceDir: source,
      outputDir: output,
      id: "core-range-pack",
      version: "1.0.0",
      harnessId: "narrated-story-video",
      coreCompatibility: "^1.0.0",
      privateKeyPem: key.privateKeyPem,
    });
    await verifyChannelPackEnvelope({
      bundleDir: output,
      trustedPublicKeyPem: key.publicKeyPem,
      coreVersion: "1.9.9",
    });
    await assert.rejects(
      verifyChannelPackEnvelope({
        bundleDir: output,
        trustedPublicKeyPem: key.publicKeyPem,
        coreVersion: "2.0.0",
      }),
      /互換でない/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
