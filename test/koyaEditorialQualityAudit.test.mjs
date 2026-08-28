import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { auditKoyaEditorialQuality } from "../lib/koyaEditorialQualityAudit.mjs";
import { resolveKoyaMangaProductionContract } from "../lib/koyaMangaProductionContract.mjs";
import { requireArtifacts, requireChannelPack } from "./helpers/requirePrerequisites.mjs";

async function benchmarkFixture() {
  const manifest = JSON.parse(await readFile("canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json", "utf8"));
  const resolved = await resolveKoyaMangaProductionContract({ projectDir: process.cwd(), episodeId: manifest.id });
  return { manifest, contract: resolved.contract };
}

test("editorial audit measures real image holds and passes the approved benchmark edit", async (t) => {
  if (!requireArtifacts(t, ["canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json"], "編集品質の実測監査")) return;
  const { manifest, contract } = await benchmarkFixture();
  const report = auditKoyaEditorialQuality(manifest, contract);
  assert.equal(report.pass, true);
  assert.equal(report.metrics.totalUtteranceCount, 29);
  assert.equal(report.metrics.assignedUtteranceCount, 29);
  assert.ok(report.metrics.multiUtteranceImageShare >= contract.editorial.minimumMultiUtteranceImageShare);
  assert.ok(report.metrics.medianImageHoldSeconds >= contract.editorial.minimumMedianImageHoldSeconds);
});

test("editorial audit rejects contextless inserts and unassigned dialogue", async (t) => {
  if (!requireArtifacts(t, ["canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json"], "編集品質の実測監査")) return;
  const { manifest, contract } = await benchmarkFixture();
  const broken = structuredClone(manifest);
  broken.cuts.find((cut) => cut.id === "cut-02").cameraSequence[0].utteranceIds = [];
  const report = auditKoyaEditorialQuality(broken, contract);
  assert.equal(report.pass, false);
  assert.ok(report.failures.some((failure) => failure.id === "unassigned-camera-shot"));
  assert.ok(report.failures.some((failure) => failure.id === "missing-utterance-image"));
});

test("editorial audit rejects conditional split-page lead-ins and image churn", async (t) => {
  if (!requireArtifacts(t, ["canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json"], "編集品質の実測監査")) return;
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

test("editorial audit does not treat a text-only solid plate as a short illustration hold", () => {
  const manifest = {
    id: "editorial-plate-pacing",
    utterances: [
      { id: "u1", cutId: "c1" },
      { id: "u2", cutId: "c1" },
      { id: "u3", cutId: "c2" },
    ],
    cuts: [
      {
        id: "c1",
        utteranceIds: ["u1", "u2"],
        timing: { durationSeconds: 11 },
        cameraSequence: [
          {
            id: "plate",
            utteranceIds: ["u1"],
            imagePath: "/plate.png",
            durationSeconds: 5,
            motion: "none",
            editorialPlate: { characterPolicy: "strictly-none", environmentPolicy: "none" },
          },
          { id: "story", utteranceIds: ["u2"], imagePath: "/story.png", durationSeconds: 6, cameraMode: "right-only" },
        ],
      },
      {
        id: "c2",
        utteranceIds: ["u3"],
        timing: { durationSeconds: 7 },
        cameraSequence: [
          { id: "story-2", utteranceIds: ["u3"], imagePath: "/story-2.png", durationSeconds: 7, cameraMode: "left-only" },
        ],
      },
    ],
  };
  const contract = {
    editorial: {
      minimumMultiUtteranceImageShare: 0,
      minimumMedianImageHoldSeconds: 6,
      maximumImageHoldSeconds: 60,
      forbidUnassignedCameraShots: true,
      requireEveryUtteranceAssignedToImage: true,
    },
  };
  const report = auditKoyaEditorialQuality(manifest, contract);
  assert.equal(report.pass, true);
  assert.equal(report.metrics.medianImageHoldSeconds, 7);
  assert.equal(report.segments.find((segment) => segment.imagePath === "/plate.png").source, "editorial-plate");
});
