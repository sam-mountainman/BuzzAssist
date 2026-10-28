import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { findHarnessDeclaration, listHarnessDeclarations, resolveHarnessDeclarationDirs } from "../lib/harnessDeclarationDirs.mjs";
import { loadHarnesses, validateHarness } from "../scripts/harness-registry.mjs";
import { capabilityCardPath } from "../lib/harnessCapabilities.mjs";
import { loadHarnessDeclaration } from "../lib/harnessReceiptLearning.mjs";
import { loadHarnessGateRegistry } from "../lib/harnessFeedbackAutoBundle.mjs";
import { evaluateHarnessConformance, harnessConformanceReport, loadCoreSupport } from "../lib/harnessConformance.mjs";
import { resolveHarnessDeployment } from "../lib/harnessDeploymentResolver.mjs";

const root = new URL("../", import.meta.url);
const declaration = (id, extra = {}) => ({ id, version: "1.0.0", displayName: "合成", status: "in-production",
  produces: { kind: "video" }, requiresFromOperator: [{ id: "signed-channel-pack" }],
  guarantees: [{ id: "synthetic-quality", evidenceAuditIds: ["syntheticCheck"] }], ...extra });

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "harness-declaration-dirs-")));
  const repoRoot = join(base, "repo");
  const publicDir = join(repoRoot, "config", "harnesses");
  const privateDir = join(base, "external");
  mkdirSync(publicDir, { recursive: true });
  mkdirSync(privateDir);
  const env = { BUZZASSIST_PRIVATE_HARNESS_DIRS: privateDir };
  return { base, repoRoot, publicDir, privateDir, env };
}
function put(dir, id, extra = {}) {
  writeFileSync(join(dir, `${id}.harness.json`), JSON.stringify(declaration(id, extra)));
}

test("環境変数なしの一覧は従来の公開宣言だけ", () => {
  const expected = readdirSync(new URL("config/harnesses/", root))
    .filter((name) => name.endsWith(".harness.json"))
    .map((name) => name.slice(0, -".harness.json".length)).sort();
  const rows = loadHarnesses({ env: {} });
  assert.deepEqual(rows.map((row) => row.id), expected);
  for (const row of rows) {
    const original = JSON.parse(readFileSync(new URL(`config/harnesses/${row.id}.harness.json`, root)));
    assert.deepEqual(row, { ...original, file: `config/harnesses/${row.id}.harness.json` });
  }
});

test("子の宣言は同じ subject と、台本品質を要求するときの genre を必要とする", () => {
  const base = declaration("synthetic-child", { childProtocol: "buzzassist-child-v1", reviewAttestation: { subject: "synthetic-child" } });
  assert.deepEqual(validateHarness(base), []);
  assert.ok(validateHarness({ ...base, childProtocol: "unknown" }).some((error) => error.includes("childProtocol")));
  assert.ok(validateHarness({ ...base, reviewAttestation: { subject: "narrated-story-video" } }).some((error) => error.includes("subject")));
  assert.ok(validateHarness({ ...base, requiresFromOperator: [{ id: "script-quality-acceptance" }] }).some((error) => error.includes("scriptQualityGenre")));
  assert.ok(validateHarness({ ...base, requiresFromOperator: {} }).some((error) => error.includes("requiresFromOperator")));
});

test("外の宣言と隣の能力カードを、一覧・学習・feedback・conformance が同じ場所から読む", async (t) => {
  const f = fixture();
  put(f.publicDir, "synthetic-public");
  put(f.privateDir, "synthetic-child", { layer: "private", childProtocol: "buzzassist-child-v1", reviewAttestation: { subject: "synthetic-child" } });
  assert.deepEqual(loadHarnesses(f).map((row) => row.id), ["synthetic-child", "synthetic-public"]);
  const previous = process.env.BUZZASSIST_PRIVATE_HARNESS_DIRS;
  process.env.BUZZASSIST_PRIVATE_HARNESS_DIRS = f.privateDir;
  t.after(() => { if (previous === undefined) delete process.env.BUZZASSIST_PRIVATE_HARNESS_DIRS; else process.env.BUZZASSIST_PRIVATE_HARNESS_DIRS = previous; });
  assert.equal(capabilityCardPath("synthetic-child"), join(f.privateDir, "synthetic-child.capabilities.json"));
  assert.equal(loadHarnessDeclaration("synthetic-child", f).layer, "private");
  assert.ok(loadHarnessGateRegistry(f.repoRoot).get("synthetic-child").gateIds.has("synthetic-quality"));
  const row = (await harnessConformanceReport({ repoRoot: f.repoRoot })).rows.find((entry) => entry.harnessId === "synthetic-child");
  for (const id of ["upper-adapter", "signed-channel-pack", "separate-signoff"]) assert.equal(row.results[id].status, "ok", id);
  put(f.privateDir, "synthetic-child", { layer: "private", childProtocol: "buzzassist-child-v1", entrypoint: "node child.mjs", reviewAttestation: { subject: "synthetic-child" } });
  const route = resolveHarnessDeployment("synthetic-child", { repoRoot: f.repoRoot });
  assert.equal(route.root, f.privateDir, "配置表が無くても宣言だけで子の配置を決める");
  assert.equal(route.entrypoint, "node child.mjs");
  const wrongSubject = evaluateHarnessConformance({ harnessId: "synthetic-child", declaration: declaration("synthetic-child", {
    childProtocol: "buzzassist-child-v1", reviewAttestation: { subject: "narrated-story-video" } }), support: await loadCoreSupport() });
  assert.equal(wrongSubject.results["separate-signoff"].status, "partial");
});

test("作業木内・作業木へのsymlink・外の宣言から作業木へのsymlinkを拒む", () => {
  const f = fixture();
  for (const dir of [f.repoRoot, f.publicDir]) {
    assert.throws(() => resolveHarnessDeclarationDirs({ ...f, env: { BUZZASSIST_PRIVATE_HARNESS_DIRS: dir } }), /作業木/u);
  }
  const link = join(f.base, "link");
  symlinkSync(f.publicDir, link, "junction");
  assert.throws(() => listHarnessDeclarations({ ...f, env: { BUZZASSIST_PRIVATE_HARNESS_DIRS: link } }), /作業木/u);
  const outward = join(f.repoRoot, "outward-link");
  symlinkSync(f.privateDir, outward, "junction");
  assert.throws(() => listHarnessDeclarations({ ...f, env: { BUZZASSIST_PRIVATE_HARNESS_DIRS: outward } }), /作業木/u);
  put(f.publicDir, "synthetic-symlink");
  symlinkSync(join(f.publicDir, "synthetic-symlink.harness.json"), join(f.privateDir, "synthetic-symlink.harness.json"));
  assert.throws(() => listHarnessDeclarations(f), /作業木/u);
});

test("linked worktree から main の作業木を外の層として指定できない", () => {
  const f = fixture();
  const main = join(f.base, "main");
  const gitdir = join(main, ".git", "worktrees", "linked");
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(f.repoRoot, ".git"), `gitdir: ${gitdir}\n`);
  writeFileSync(join(gitdir, "commondir"), "../..\n");
  writeFileSync(join(gitdir, "gitdir"), `${join(f.repoRoot, ".git")}\n`);
  assert.throws(() => listHarnessDeclarations({ ...f, env: { BUZZASSIST_PRIVATE_HARNESS_DIRS: main } }), /作業木/u);
});

test("外は private 必須・公開は layer 禁止・公開と外の同じ id は拒否", () => {
  const f = fixture();
  put(f.privateDir, "synthetic-layer");
  assert.throws(() => listHarnessDeclarations(f), /layer: private/u);
  put(f.privateDir, "synthetic-layer", { layer: "private" });
  put(f.publicDir, "synthetic-layer");
  assert.throws(() => listHarnessDeclarations(f), /重複/u);
  put(f.publicDir, "synthetic-layer", { layer: "private" });
  assert.throws(() => listHarnessDeclarations(f), /公開の宣言/u);
});

test("複数の外のフォルダも読む。同一 id の競合やファイル名の偽装は拒否", () => {
  const f = fixture();
  const second = join(f.base, "second");
  mkdirSync(second);
  put(f.privateDir, "synthetic-one", { layer: "private" });
  put(second, "synthetic-two", { layer: "private" });
  const options = { ...f, env: { BUZZASSIST_PRIVATE_HARNESS_DIRS: [f.privateDir, second].join(delimiter) } };
  assert.equal(listHarnessDeclarations(options).length, 2);
  assert.equal(findHarnessDeclaration("../escape", options), null);
  put(second, "synthetic-one", { layer: "private" });
  assert.throws(() => listHarnessDeclarations(options), /重複/u);
  put(second, "synthetic-one", { id: "synthetic-alias", layer: "private" });
  assert.throws(() => listHarnessDeclarations(options), /ファイル名/u);
});
