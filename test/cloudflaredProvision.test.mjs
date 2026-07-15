import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MANAGED_CLOUDFLARED_VERSION,
  ensureManagedCloudflared,
  resolveCloudflaredReleaseAsset,
  resolveManagedCloudflaredPaths,
} from "../lib/cloudflaredProvision.mjs";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("cloudflared release assets resolve for supported desktop platforms", () => {
  assert.equal(resolveCloudflaredReleaseAsset({ platform: "darwin", arch: "arm64" }).name, "cloudflared-darwin-arm64.tgz");
  assert.equal(resolveCloudflaredReleaseAsset({ platform: "win32", arch: "x64" }).name, "cloudflared-windows-amd64.exe");
  assert.equal(resolveCloudflaredReleaseAsset({ platform: "win32", arch: "arm64" }).name, "cloudflared-windows-amd64.exe");
  assert.throws(
    () => resolveCloudflaredReleaseAsset({ platform: "freebsd", arch: "x64" }),
    /cannot auto-download cloudflared/i,
  );
});

test("managed cloudflared downloads once, verifies its checksum, and reuses the cache", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "buzzassist-cloudflared-test-"));
  const bytes = Buffer.from("verified cloudflared test binary\n");
  const asset = {
    name: "cloudflared-test-binary",
    sha256: digest(bytes),
    url: "https://example.invalid/cloudflared-test-binary",
  };
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    return {
      ok: true,
      headers: { get: () => String(bytes.length) },
      arrayBuffer: async () => bytes,
    };
  };
  const verifyExecutable = async (path) => (await readFile(path)).equals(bytes);

  const first = await ensureManagedCloudflared({
    platform: "win32",
    arch: "x64",
    homeDir,
    asset,
    fetchImpl,
    verifyExecutable,
  });
  assert.equal(first.downloaded, true);
  assert.equal(first.source, "managed-download");
  assert.equal(fetchCount, 1);
  assert.equal(await readFile(first.executablePath, "utf8"), bytes.toString());
  assert.equal((await stat(first.executablePath)).isFile(), true);
  const metadata = JSON.parse(await readFile(first.metadataPath, "utf8"));
  assert.equal(metadata.version, MANAGED_CLOUDFLARED_VERSION);
  assert.equal(metadata.assetSha256, asset.sha256);

  const cached = await ensureManagedCloudflared({
    platform: "win32",
    arch: "x64",
    homeDir,
    asset,
    fetchImpl: async () => { throw new Error("cache should avoid a download"); },
    verifyExecutable,
  });
  assert.equal(cached.downloaded, false);
  assert.equal(cached.source, "managed-cache");
  assert.equal(fetchCount, 1);
});

test("managed cloudflared rejects a tampered download and removes the partial install", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "buzzassist-cloudflared-test-"));
  const asset = {
    name: "cloudflared-tampered-binary",
    sha256: digest(Buffer.from("expected")),
    url: "https://example.invalid/cloudflared-tampered-binary",
  };
  await assert.rejects(
    () => ensureManagedCloudflared({
      platform: "darwin",
      arch: "arm64",
      homeDir,
      asset,
      fetchImpl: async () => ({
        ok: true,
        headers: { get: () => "8" },
        arrayBuffer: async () => Buffer.from("tampered"),
      }),
      verifyExecutable: async () => true,
    }),
    /SHA-256 mismatch/,
  );
  const paths = resolveManagedCloudflaredPaths({ platform: "darwin", arch: "arm64", homeDir });
  await assert.rejects(() => stat(paths.installDir), { code: "ENOENT" });
});
