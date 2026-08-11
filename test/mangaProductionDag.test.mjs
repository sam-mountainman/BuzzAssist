import test from "node:test";
import assert from "node:assert/strict";

import { createMangaProductionDag, executeMangaProductionDag, validateMangaProductionDag } from "../lib/mangaProductionDag.mjs";

function manifest() {
  return {
    id: "episode-1",
    scriptText: "test",
    speech: { pronunciations: [] },
    cuts: [{ id: "cut-01", description: "dialogue", utteranceIds: ["u1", "u2"] }],
    utterances: [
      { id: "u1", cutId: "cut-01", text: "こんにちは", speakerId: "a", speakerName: "A", voiceId: "voice-a", model: "eleven_v3" },
      { id: "u2", cutId: "cut-01", text: "どうも", speakerId: "b", speakerName: "B", voiceId: "voice-b", model: "eleven_v3" },
    ],
  };
}

test("production DAG exposes a ten-wide image pool and semantic camera assets independent of preview", () => {
  const dag = createMangaProductionDag({ manifest: manifest() });
  assert.equal(validateMangaProductionDag(dag), true);
  assert.equal(dag.pools.image, 10);
  assert.ok(dag.pools.tts >= 4 && dag.pools.tts <= 8);
  assert.ok(dag.pools.render >= 2 && dag.pools.render <= 4);
  assert.equal(dag.nodes.filter((node) => node.kind === "character-candidate").length, 6);
  assert.equal(dag.nodes.filter((node) => node.kind === "camera-asset").length, 2);
  assert.deepEqual(
    dag.nodes.find((node) => node.id === "voice-library-approval").dependencies,
    ["voice-library-discovery"],
  );
  assert.ok(dag.nodes
    .filter((node) => node.kind === "voice-profile")
    .every((node) => node.dependencies.includes("voice-library-approval")));
  assert.equal(dag.preflightReport.pass, true);
  assert.match(dag.qualityContract.digest, /^[a-f0-9]{64}$/u);
  assert.equal(dag.nodes.find((node) => node.id === "preflight-hard-gates").metadata.pass, true);
  assert.equal(dag.nodes.find((node) => node.id === "quality-decision").metadata.qualityContractDigest, dag.qualityContract.digest);
  assert.equal(dag.paths.final.terminalNodeId, "quality-decision");
  assert.equal(dag.compositionPlan.diagnostics.consecutiveTooSimilarCount, 0);
  assert.ok(dag.nodes.filter((node) => node.kind === "camera-asset").every((node) => node.inputHash && node.metadata));
  assert.match(dag.nodes.find((node) => node.id === "camera-asset:u1").inputHash, /^[a-f0-9]+$/);
  const preview = dag.nodes.find((node) => node.id === "fast-preview");
  assert.equal(preview.dependencies.some((id) => id.startsWith("camera-asset:")), false);
  assert.equal(dag.paths.preview.waitsForCameraAssets, false);
});

test("DAG executor runs independent pools, retries a failed job, and reuses matching completions", async () => {
  const dag = {
    version: 1,
    episodeId: "small",
    pools: { planning: 2 },
    nodes: [
      { id: "a", kind: "work", dependencies: [], pool: "planning", inputHash: "a1" },
      { id: "b", kind: "work", dependencies: [], pool: "planning", inputHash: "b1" },
      { id: "c", kind: "finish", dependencies: ["a", "b"], pool: "planning", inputHash: "c1" },
    ],
  };
  let active = 0;
  let maximumActive = 0;
  let bAttempts = 0;
  const first = await executeMangaProductionDag({
    dag,
    handlers: {
      work: async ({ node }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        if (node.id === "b" && bAttempts++ === 0) throw new Error("temporary");
        return { value: node.id, cost: 1 };
      },
      finish: async () => ({ value: "done" }),
    },
  });
  assert.equal(maximumActive, 2);
  assert.equal(first.jobs.b.status, "complete");
  assert.equal(first.jobs.b.retryCount, 1);
  assert.equal(first.jobs.c.status, "complete");
  const second = await executeMangaProductionDag({ dag, state: first, handlers: {} });
  assert.equal(second.summary.complete, 3);
  assert.equal(second.jobs.a.reused, true);
});

test("a deterministic preflight failure blocks paid generation without retrying it", async () => {
  const invalid = manifest();
  invalid.utterances[0].voiceId = "";
  const dag = createMangaProductionDag({ manifest: invalid });
  let generated = 0;
  const state = await executeMangaProductionDag({
    dag,
    handlers: {
      "script-analysis": async () => ({ value: "parsed" }),
      "character-candidate": async () => {
        generated += 1;
        return { value: "should-not-run" };
      },
    },
  });
  assert.equal(dag.preflightReport.pass, false);
  assert.equal(state.jobs["preflight-hard-gates"].status, "failed");
  assert.equal(state.jobs["preflight-hard-gates"].attempts, 1);
  assert.equal(generated, 0);
  assert.ok(state.summary.blocked.some((id) => id.startsWith("character-candidate:")));
});
