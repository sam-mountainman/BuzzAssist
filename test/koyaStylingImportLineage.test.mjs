import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { validateKoyaStylingImportSourceProvenance } from "../lib/koyaMangaProduction.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("styling import provenance accepts direct identity bytes and a complete derivative edit chain", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-styling-lineage-"));
  const canvasDir = path.join(projectDir, "canvas");
  await mkdir(canvasDir, { recursive: true });
  const basePath = path.join(canvasDir, "base.png");
  const intermediatePath = path.join(canvasDir, "intermediate.png");
  const immediateSourcePath = path.join(canvasDir, "immediate-source.png");
  const baseBytes = Buffer.from("selected-identity");
  const intermediateBytes = Buffer.from("first-edit");
  const immediateSourceBytes = Buffer.from("second-edit");
  await writeFile(basePath, baseBytes);
  await writeFile(intermediatePath, intermediateBytes);
  await writeFile(immediateSourcePath, immediateSourceBytes);
  const baseSha256 = sha256(baseBytes);
  try {
    assert.deepEqual(await validateKoyaStylingImportSourceProvenance({
      canvasDir,
      baseAssetSha256: baseSha256,
      source: { sourceSha256: baseSha256 },
    }), { sourceSha256: baseSha256, rootIdentitySha256: baseSha256, sourceLineage: [] });

    const derivative = await validateKoyaStylingImportSourceProvenance({
      canvasDir,
      baseAssetSha256: baseSha256,
      source: {
        sourceSha256: sha256(immediateSourceBytes),
        rootIdentitySha256: baseSha256,
        sourceLineage: [
          { path: basePath, sha256: baseSha256 },
          { path: intermediatePath, sha256: sha256(intermediateBytes) },
          { path: immediateSourcePath, sha256: sha256(immediateSourceBytes) },
        ],
      },
    });
    assert.equal(derivative.sourceLineage.length, 3);
    assert.equal(derivative.sourceLineage.at(-1).path, immediateSourcePath);

    await writeFile(intermediatePath, Buffer.from("tampered"));
    await assert.rejects(
      () => validateKoyaStylingImportSourceProvenance({
        canvasDir,
        baseAssetSha256: baseSha256,
        source: {
          sourceSha256: sha256(immediateSourceBytes),
          rootIdentitySha256: baseSha256,
          sourceLineage: [
            { path: basePath, sha256: baseSha256 },
            { path: intermediatePath, sha256: sha256(intermediateBytes) },
            { path: immediateSourcePath, sha256: sha256(immediateSourceBytes) },
          ],
        },
      }),
      /path\/SHA-256 does not match disk/u,
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("styling import provenance rejects derivatives without an ordered SHA-bound lineage", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-styling-lineage-missing-"));
  const canvasDir = path.join(projectDir, "canvas");
  await mkdir(canvasDir, { recursive: true });
  try {
    await assert.rejects(
      () => validateKoyaStylingImportSourceProvenance({
        canvasDir,
        baseAssetSha256: "a".repeat(64),
        source: {
          sourceSha256: "b".repeat(64),
          rootIdentitySha256: "a".repeat(64),
        },
      }),
      /derivative imports require an ordered SHA-bound sourceLineage/u,
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
