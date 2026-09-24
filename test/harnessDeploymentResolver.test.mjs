import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadHarnessDeployments,
  parseDeploymentEntrypoint,
  resolveHarnessDeployment,
  resolveHarnessDeploymentCommand,
} from "../lib/harnessDeploymentResolver.mjs";

test("packaged deployment map resolves the generic narrated runner without an operator-local map", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-deployment-fallback-"));
  try {
    await mkdir(join(root, "config"), { recursive: true });
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "scripts", "narrated-story-video.mjs"), "// fixture\n");
    await writeFile(join(root, "config", "harness-deployments.example.json"), `${JSON.stringify({
      deployments: [{ harnessId: "narrated-story-video", root: ".", entrypoint: "node scripts/narrated-story-video.mjs" }],
    })}\n`);
    const deployment = resolveHarnessDeployment("narrated-story-video", { repoRoot: root });
    const route = resolveHarnessDeploymentCommand(deployment, { additionalArgs: ["help"] });
    assert.equal(route.command, process.execPath);
    assert.deepEqual(route.args, [join(root, "scripts", "narrated-story-video.mjs"), "help"]);
    assert.equal(deployment.sourcePath, join(root, "config", "harness-deployments.example.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operator map wins, while shell syntax and root escapes fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-deployment-operator-"));
  try {
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "harness-deployments.example.json"), `${JSON.stringify({
      deployments: [{ harnessId: "fixture", root: ".", entrypoint: "node scripts/fallback.mjs" }],
    })}\n`);
    await writeFile(join(root, "config", "harness-deployments.json"), `${JSON.stringify({
      deployments: [{ harnessId: "fixture", root: ".", entrypoint: "node scripts/operator.mjs" }],
    })}\n`);
    const deployment = loadHarnessDeployments({ repoRoot: root }).get("fixture");
    assert.equal(deployment.entrypoint, "node scripts/operator.mjs");
    assert.throws(() => parseDeploymentEntrypoint("node script.mjs && paid-command"), /shell syntax/u);
    assert.throws(
      () => resolveHarnessDeploymentCommand({ root, entrypoint: "node ../outside.mjs" }),
      /outside its declared root/u,
    );
    assert.throws(
      () => loadHarnessDeployments({ repoRoot: root, deploymentPath: join(root, "missing.json") }),
      /配置マップを読めない/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("setup creates the operator deployment map from the example once and never overwrites it", async () => {
  const { ensureOperatorDeploymentMap } = await import("../lib/harnessDeploymentResolver.mjs");
  const { readFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "harness-deployment-ensure-"));
  try {
    assert.equal(ensureOperatorDeploymentMap({ repoRoot: root }).reason, "example-missing");
    await mkdir(join(root, "config"), { recursive: true });
    const example = `${JSON.stringify({ deployments: [{ harnessId: "narrated-story-video", root: ".", entrypoint: "node scripts/narrated-story-video.mjs" }] })}\n`;
    await writeFile(join(root, "config", "harness-deployments.example.json"), example);
    assert.equal(ensureOperatorDeploymentMap({ repoRoot: root, dryRun: true }).reason, "dry-run");
    const created = ensureOperatorDeploymentMap({ repoRoot: root });
    assert.equal(created.created, true);
    assert.equal(await readFile(join(root, "config", "harness-deployments.json"), "utf8"), example);
    const operator = `${JSON.stringify({ deployments: [{ harnessId: "narrated-story-video", root: "/srv/elsewhere", entrypoint: "node run.mjs" }] })}\n`;
    await writeFile(join(root, "config", "harness-deployments.json"), operator);
    const again = ensureOperatorDeploymentMap({ repoRoot: root });
    assert.equal(again.created, false);
    assert.equal(again.reason, "exists");
    assert.equal(await readFile(join(root, "config", "harness-deployments.json"), "utf8"), operator, "operator map must not be overwritten");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
