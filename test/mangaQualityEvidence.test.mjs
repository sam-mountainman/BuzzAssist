import assert from "node:assert/strict";
import test from "node:test";

test("名指しした証拠が読めなければ、空の Merkle 証拠を作らない", async () => {
  // 読めなかったファイルを一律で捨てていたので、必須の成果物が1つも
  // 無くても entryCount: 0 の manifest が合格していた。最終判断の
  // Merkle 証拠に、根拠となるファイルが1つも入っていない状態。
  const { createMangaEvidenceManifest, verifyMangaEvidenceManifest } =
    await import("../lib/mangaQualityEvidence.mjs");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = await mkdtemp(join(tmpdir(), "evidence-"));
  const missing = join(dir, "does-not-exist.json");

  await assert.rejects(
    () => createMangaEvidenceManifest({ episodeId: "e1", projectDir: dir, artifacts: [missing] }),
    /証拠に要るファイルを読めない/u,
    "名指しした成果物の欠落を黙って落とさないこと",
  );

  // 実在するものだけなら通り、証拠が入っていること。
  const real = join(dir, "audit.json");
  await writeFile(real, JSON.stringify({ pass: true }));
  const manifest = await createMangaEvidenceManifest({
    episodeId: "e1", projectDir: dir, artifacts: [real], generatedAt: "2026-08-29T00:00:00.000Z",
  });
  assert.ok(manifest.entryCount > 0, "証拠が空でないこと");
  assert.equal((await verifyMangaEvidenceManifest(manifest)).pass, true);

  await rm(dir, { recursive: true, force: true });
});
