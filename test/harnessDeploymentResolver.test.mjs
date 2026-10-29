import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, realpath, symlink, writeFile } from "node:fs/promises";
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
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "scripts", "operator.mjs"), "// fixture\n");
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

test("#6 entrypoint の symlink と中間フォルダの symlink escape を拒否する", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "deployment-symlink-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deploymentRoot = join(root, "deployment"); const outside = join(root, "outside");
  await mkdir(deploymentRoot); await mkdir(outside);
  await writeFile(join(outside, "runner.mjs"), "// outside\n");
  await writeFile(join(deploymentRoot, "real.mjs"), "// inside\n");
  await symlink(join(deploymentRoot, "real.mjs"), join(deploymentRoot, "inside.mjs"));
  await symlink(join(outside, "runner.mjs"), join(deploymentRoot, "outside.mjs"));
  await symlink(outside, join(deploymentRoot, "linked"), "junction");
  for (const name of ["inside.mjs", "outside.mjs", "linked/runner.mjs"]) {
    assert.throws(() => resolveHarnessDeploymentCommand({ root: deploymentRoot, entrypoint: `node ${name}` }), /symlink|outside its declared root/u, name);
  }
});

test("#6 private 子は作業木内を指す配置表より外の宣言の配置を使う", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "deployment-private-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoRoot = join(root, "repo"); const external = join(root, "external");
  await mkdir(join(repoRoot, "scripts"), { recursive: true }); await mkdir(external);
  await writeFile(join(repoRoot, "scripts", "private.mjs"), "// must not deploy\n");
  await writeFile(join(external, "child.mjs"), "// external\n");
  await writeFile(join(external, "synthetic-private.harness.json"), JSON.stringify({ id: "synthetic-private", layer: "private", childProtocol: "buzzassist-child-v1", entrypoint: "node child.mjs" }));
  const previous = process.env.BUZZASSIST_PRIVATE_HARNESS_DIRS;
  process.env.BUZZASSIST_PRIVATE_HARNESS_DIRS = external;
  t.after(() => { if (previous === undefined) delete process.env.BUZZASSIST_PRIVATE_HARNESS_DIRS; else process.env.BUZZASSIST_PRIVATE_HARNESS_DIRS = previous; });
  const route = resolveHarnessDeployment("synthetic-private", { repoRoot, deployments: new Map([["synthetic-private", { root: repoRoot, entrypoint: "node scripts/private.mjs" }]]) });
  assert.equal(route.root, await realpath(external));
  assert.equal(route.entrypoint, "node child.mjs");
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
