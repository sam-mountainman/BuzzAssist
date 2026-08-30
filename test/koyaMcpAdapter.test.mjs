import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requireArtifacts, requireChannelPack } from "./helpers/requirePrerequisites.mjs";

import {
  KOYA_MCP_ACTIONS,
  doctorKoyaMcp,
  readKoyaMcpJob,
  runKoyaMcpAction,
  startKoyaMcpJob,
} from "../lib/koyaMcpAdapter.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);

test("Koya MCP doctor and read-only actions use the canonical CLI", async (t) => {
  if (!requireChannelPack(t, "doctor の正本チェック")) return;
  const doctor = await doctorKoyaMcp({ projectDir: root });
  assert.equal(doctor.ok, true, JSON.stringify(doctor));
  assert.equal(doctor.contract.validation.pass, true);
  assert.equal(doctor.channelAuthority.validation.show.pass, true);
  assert.equal(doctor.channelAuthority.validation.locations.pass, true);
  assert.equal(doctor.channelAuthority.validation.thumbnail.pass, true);
  assert.equal(doctor.channelAuthority.validation.styling.pass, true);
  assert.equal(doctor.productionEntrypoint, "node scripts/koya-manga-video.mjs");
  assert.ok(doctor.checks.filter((check) => check.path.endsWith(".json")).every((check) => check.ok && check.version));
  assert.ok(KOYA_MCP_ACTIONS.includes("character-style-generate"));
  assert.ok(KOYA_MCP_ACTIONS.includes("character-style-import"));
  assert.ok(KOYA_MCP_ACTIONS.includes("character-identity-refresh"));
  assert.ok(KOYA_MCP_ACTIONS.includes("character-style-record-failure"));
  assert.ok(KOYA_MCP_ACTIONS.includes("character-bootstrap-status"));
  assert.ok(KOYA_MCP_ACTIONS.includes("character-style-compose"));
  assert.ok(KOYA_MCP_ACTIONS.includes("character-style-select"));
  assert.ok(KOYA_MCP_ACTIONS.includes("handoff-export"));
  assert.ok(KOYA_MCP_ACTIONS.includes("handoff-verify"));
  assert.ok(KOYA_MCP_ACTIONS.includes("handoff-restore"));
  assert.ok(KOYA_MCP_ACTIONS.includes("story-audit"));
  assert.ok(KOYA_MCP_ACTIONS.includes("story-review-draft"));
  assert.ok(KOYA_MCP_ACTIONS.includes("cast-readiness"));
  assert.ok(KOYA_MCP_ACTIONS.includes("location-plan"));
  assert.ok(KOYA_MCP_ACTIONS.includes("location-generate"));
  assert.ok(KOYA_MCP_ACTIONS.includes("location-anchor-review-draft"));
  assert.ok(KOYA_MCP_ACTIONS.includes("location-anchor-audit"));
  assert.ok(KOYA_MCP_ACTIONS.includes("location-review-draft"));
  assert.ok(KOYA_MCP_ACTIONS.includes("location-register"));
  assert.ok(KOYA_MCP_ACTIONS.includes("thumbnail-plan-draft"));
  assert.ok(KOYA_MCP_ACTIONS.includes("thumbnail-audit"));
  const contract = await runKoyaMcpAction({ projectDir: root, action: "contract" });
  assert.equal(contract.ok, true);
  assert.equal(contract.result.validation.pass, true);
});

test("Koya MCP mutating actions require confirmation and checkpoint background failures", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-koya-mcp-"));
  try {
    await assert.rejects(
      () => startKoyaMcpJob({ projectDir, action: "character-review-refresh", options: {} }),
      /confirmed=true/u,
    );
    const started = await startKoyaMcpJob({
      projectDir,
      action: "character-review-refresh",
      confirmed: true,
      options: {
        workflowId: "missing-workflow",
        generatorHost: "legacy-migration",
        generatorContextId: "test-migration",
      },
    });
    let current = started;
    for (let attempt = 0; attempt < 100 && ["queued", "running"].includes(current.status); attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      current = await readKoyaMcpJob({ projectDir, jobId: started.id });
    }
    assert.equal(current.status, "failed", JSON.stringify(current));
    assert.notEqual(current.exitCode, 0);
    assert.match(current.stderrTail, /Unknown character workflow/u);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Koya MCP doctor can verify the installed runtime before an empty recipient project restores its handoff data", async (t) => {
  if (!requireChannelPack(t, "doctor の正本チェック")) return;
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-koya-empty-project-"));
  try {
    const doctor = await doctorKoyaMcp({ projectDir });
    assert.equal(doctor.ok, true, JSON.stringify(doctor));
    assert.equal(doctor.projectDataRestored, false);
    assert.equal(doctor.projectDataState, "plugin-default-awaiting-restore");
    assert.equal(doctor.authorityRoot, root);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
