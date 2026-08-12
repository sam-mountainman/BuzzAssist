import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { auditKoyaEditorialQuality } from "../lib/koyaEditorialQualityAudit.mjs";
import { resolveKoyaMangaProductionContract } from "../lib/koyaMangaProductionContract.mjs";

async function benchmarkFixture() {
  const manifest = JSON.parse(await readFile("canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json", "utf8"));
  const resolved = await resolveKoyaMangaProductionContract({ projectDir: process.cwd(), episodeId: manifest.id });
  return { manifest, contract: resolved.contract };
}

test("editorial audit measures real image holds and passes the approved benchmark edit", async () => {
  const { manifest, contract } = await benchmarkFixture();
  const report = auditKoyaEditorialQuality(manifest, contract);
  assert.equal(report.pass, true);
  assert.equal(report.metrics.totalUtteranceCount, 29);
  assert.equal(report.metrics.assignedUtteranceCount, 29);
  assert.ok(report.metrics.multiUtteranceImageShare >= contract.editorial.minimumMultiUtteranceImageShare);
  assert.ok(report.metrics.medianImageHoldSeconds >= contract.editorial.minimumMedianImageHoldSeconds);
});

test("editorial audit rejects contextless inserts and unassigned dialogue", async () => {
  const { manifest, contract } = await benchmarkFixture();
  const broken = structuredClone(manifest);
  broken.cuts.find((cut) => cut.id === "cut-02").cameraSequence[0].utteranceIds = [];
  const report = auditKoyaEditorialQuality(broken, contract);
  assert.equal(report.pass, false);
  assert.ok(report.failures.some((failure) => failure.id === "unassigned-camera-shot"));
  assert.ok(report.failures.some((failure) => failure.id === "missing-utterance-image"));
});

test("editorial audit rejects conditional split-page lead-ins and image churn", async () => {
  const { manifest, contract } = await benchmarkFixture();
  const conditional = structuredClone(manifest);
  const split = conditional.cuts.find((cut) => cut.panelLayout?.enabled);
  split.panelLayout.enableFromUtteranceId = split.utteranceIds[1];
  const conditionalReport = auditKoyaEditorialQuality(conditional, contract);
  assert.ok(conditionalReport.failures.some((failure) => failure.id === "conditional-split-page-lead-in"));

  const strictPacing = structuredClone(contract);
  strictPacing.editorial.minimumMultiUtteranceImageShare = 1;
  strictPacing.editorial.minimumMedianImageHoldSeconds = 60;
  const pacingReport = auditKoyaEditorialQuality(manifest, strictPacing);
  assert.ok(pacingReport.failures.some((failure) => failure.id === "multi-utterance-image-share"));
  assert.ok(pacingReport.failures.some((failure) => failure.id === "median-image-hold"));
});
